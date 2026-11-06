'use strict';

// Shared by the recorder (which writes recordings, their metadata and thumbnails)
// and the dashboard (which reads them).
//
// Layout of the recordings folder:
//   <name>.mp4              the recording
//   <name>.json             its metadata ("sidecar"), written by the recorder
//   <name>.recording.webm   raw data while a recording is in progress
//   thumbnails/<sha256>.jpg one file per distinct image
//   thumbnails/index.json   which image to use for a given thumbnail URL + title

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const THUMB_DIR = 'thumbnails';
const MAX_THUMB_BYTES = 20 * 1024 * 1024;
const CONFIG_PATH = path.join(__dirname, 'config.json');
const STATUS_PATH = path.join(__dirname, 'status.json');
const DEFAULT_LOG = path.join(os.homedir(), 'Desktop', 'log_example.json');
// Where the background services write their output. Not inside ~/Desktop:
// macOS restricts what background jobs may write there.
const LOG_DIR = path.join(os.homedir(), 'Library', 'Logs', 'Recording');

// Settings shared by both programs. The dashboard can change which log file is
// watched; the recorder re-reads this on every check and switches over.
function loadConfig() {
  const saved = readJson(CONFIG_PATH) ?? {};
  return { log: typeof saved.log === 'string' && saved.log ? saved.log : DEFAULT_LOG };
}

function saveConfig(changes) {
  writeJson(CONFIG_PATH, { ...loadConfig(), ...changes });
}

function expandPath(value) {
  return path.resolve(String(value).trim().replace(/^~(?=$|\/)/, os.homedir()));
}

// The recorder writes a heartbeat to status.json while it runs.
function writeStatus(status) {
  writeJson(STATUS_PATH, { pid: process.pid, heartbeat: new Date().toISOString(), ...status });
}

function clearStatus() {
  fs.rmSync(STATUS_PATH, { force: true });
}

function recorderStatus() {
  const status = readJson(STATUS_PATH);
  if (!status?.pid) return { running: false };
  let alive;
  try {
    process.kill(status.pid, 0);
    alive = true;
  } catch (err) {
    alive = err.code === 'EPERM';
  }
  const fresh = Date.now() - Date.parse(status.heartbeat) < 20_000;
  return { ...status, running: alive && fresh };
}

// The page that gets recorded: the entry's room.
function recordUrlOf(entry) {
  return entry.room_link;
}

// What a log says is going on now: per room link, the play that started and
// hasn't stopped (its start entry and where it is in the log), and the pause
// entry if it's paused. Playing again after a pause (a resume, or a new start
// of the same thing) is the same play; a resume with no play before it starts one.
function openPlays(entries) {
  const open = new Map();
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const action = String(entry.action ?? '').trim().toLowerCase();
    const url = recordUrlOf(entry);
    const play = open.get(url);
    const resuming = action.startsWith('resume');
    if (action === 'stop' || action === 'end') open.delete(url); // end: ended early from the VCR
    else if (action === 'pause') {
      if (play) play.pause = entry;
    } else if (action.startsWith('start') || resuming) {
      if (play?.pause && (resuming || samePlay(play.entry, entry))) play.pause = null;
      else if (!(play && resuming)) open.set(url, { entry, index, pause: null });
    }
  });
  return open;
}

// Which episode (or movie) a recording is, so copies of it can be told apart
// from other recordings; null when that can't be said (no season and episode).
function episodeKey({ title, kind, season, episode }) {
  if (!title) return null;
  if (kind === 'movie') return `movie|${title}`;
  if (kind === 'tv' && season != null && episode != null) return `tv|${title}|${season}|${episode}`;
  return null;
}

function samePlay(a, b) {
  return a.content === b.content && (a.season ?? null) === (b.season ?? null) && (a.episode ?? null) === (b.episode ?? null);
}

// Thumbnails are remembered per (thumbnail URL, title): the same URL can serve a
// different picture for a different show, but for the same show it's downloaded
// once and reused after that. Images are stored under a hash of their bytes, so
// two URLs that return the same picture still only take up one file.
class ThumbnailCache {
  constructor(dir, log = () => {}) {
    this.dir = dir;
    this.log = log;
    this.indexPath = path.join(dir, 'index.json');
    this.index = readJson(this.indexPath) ?? {};
    this.pending = new Map();
  }

  get(url, title) {
    if (!isHttpUrl(url)) return Promise.resolve(null);
    const known = this.index[url]?.[title];
    if (known && fs.existsSync(path.join(this.dir, known))) {
      this.log(`  Thumbnail for "${title}": reusing ${known}`);
      return Promise.resolve(known);
    }
    const key = `${url}\n${title}`;
    if (!this.pending.has(key)) {
      this.pending.set(key, this._download(url, title).finally(() => this.pending.delete(key)));
    }
    return this.pending.get(key);
  }

  async _download(url, title) {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (Number(res.headers.get('content-length')) > MAX_THUMB_BYTES) throw new Error('image is too large');
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_THUMB_BYTES) throw new Error('image is too large');

    const { file, isNew } = this.store(bytes);
    (this.index[url] ??= {})[title] = file;
    writeJson(this.indexPath, this.index);
    this.log(`  Thumbnail for "${title}": ${isNew ? 'downloaded' : 'identical to a saved image, reusing'} ${file}`);
    return file;
  }

  // Saves image bytes under a name derived from their content; identical images are stored once.
  store(bytes) {
    const ext = imageExtension(bytes);
    if (!ext) throw new Error('not an image');
    const file = `${crypto.createHash('sha256').update(bytes).digest('hex')}.${ext}`;
    const target = path.join(this.dir, file);
    const isNew = !fs.existsSync(target);
    if (isNew) {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(target, bytes);
    }
    return { file, isNew };
  }

  // A frame from the recording itself, for entries without a usable thumbnail.
  // By default a moment near the start; `at` (seconds) picks another spot.
  async fromVideo(videoPath, duration, at = duration ? Math.min(duration * 0.1, 60) : 1) {
    const tmp = path.join(os.tmpdir(), `log-recorder-${process.pid}-${Date.now()}.jpg`);
    try {
      const { code } = await run('ffmpeg', [
        '-nostdin', '-y', '-v', 'error', '-ss', String(at), '-i', videoPath,
        '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '3', tmp,
      ]);
      return code === 0 && fs.existsSync(tmp) ? this.store(fs.readFileSync(tmp)).file : null;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
}

function imageExtension(bytes) {
  const ascii = (start, end) => bytes.subarray(start, end).toString('latin1');
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (ascii(0, 8) === '\x89PNG\r\n\x1a\n') return 'png';
  if (ascii(0, 4) === 'GIF8') return 'gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(4, 8) === 'ftyp' && /^avi[fs]$/.test(ascii(8, 12))) return 'avif';
  return null;
}

// How much of the start to cut: everything before the first sound. That's the
// room still connecting (its waiting screen with the room code, then black),
// whatever the picture shows; silences later in the show are left alone. Under a
// second isn't worth cutting. A recording with no sound at all in its first five
// minutes is left alone too: its sound was probably off at the source, so the
// silence is the show, not the room connecting.
async function leadIn(file) {
  const { stderr } = await run('ffmpeg', ['-nostdin', '-v', 'info', '-t', '300', '-i', file,
    '-vn', '-af', 'silencedetect=n=-60dB:d=0.5', '-f', 'null', '-']);
  const first = (what) => Number(new RegExp(`${what}: ?(-?[\\d.]+)`).exec(stderr)?.[1]);
  const quietFrom = first('silence_start');
  const quietTo = first('silence_end');
  // How far it got (it reports the silence as ending there when it never did).
  const read = [...stderr.matchAll(/time=(\d+):(\d+):([\d.]+)/g)].map(([, h, m, sec]) => h * 3600 + m * 60 + Number(sec)).pop() ?? 0;
  if (!(quietFrom <= 0.5) || !(quietTo > 0) || quietTo >= read - 0.5) return 0;
  return quietTo >= 1 ? Math.round(quietTo * 100) / 100 : 0;
}

async function probeVideo(file) {
  const { code, stdout } = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'format=duration:stream=width,height',
    '-of', 'json', file,
  ]);
  if (code !== 0) return {};
  try {
    const info = JSON.parse(stdout);
    const stream = info.streams?.[0] ?? {};
    const duration = Number(info.format?.duration);
    return {
      duration: Number.isFinite(duration) ? Math.round(duration * 10) / 10 : null,
      width: stream.width ?? null,
      height: stream.height ?? null,
    };
  } catch {
    return {};
  }
}

// Everything the dashboard shows: one item per recording (finished or in progress).
function readLibrary(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const present = new Set(names);
  const thumbsDir = path.join(dir, THUMB_DIR);
  const items = [];
  const claimed = new Set();
  let recorderRunning; // looked up only if something is paused

  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const base = name.slice(0, -'.json'.length);
    const meta = readJson(path.join(dir, name));
    if (meta?.version !== 1) continue;

    let size = null;
    if (meta.status === 'saved') {
      if (!meta.file || !present.has(meta.file)) continue;
      claimed.add(meta.file);
      size = fileStat(path.join(dir, meta.file))?.size ?? null;
    } else if (meta.status === 'recording' || meta.status === 'saving') {
      // A recorder that was killed leaves a stale sidecar behind; only trust recent activity.
      const raw = fileStat(path.join(dir, `${base}.recording.webm`));
      const maxIdle = meta.status === 'recording' ? 60_000 : 6 * 3600_000;
      if (!raw || Date.now() - raw.mtimeMs > maxIdle) continue;
    } else if (meta.status === 'paused') {
      // Nothing is written while paused, however long that is; trust it while the recorder runs.
      recorderRunning ??= recorderStatus().running;
      if (!recorderRunning || !present.has(`${base}.recording.webm`)) continue;
    } else {
      continue;
    }

    const pauses = Array.isArray(meta.pauses) ? meta.pauses : [];
    const openPause = pauses.find((p) => !p.to);
    const thumb = meta.thumbnail && fs.existsSync(path.join(thumbsDir, meta.thumbnail)) ? meta.thumbnail : null;
    // What's been recorded so far, watchable before it's finished.
    const raw = meta.status !== 'saved' && present.has(`${base}.recording.webm`) ? `${base}.recording.webm` : null;
    items.push({
      id: idFor(base),
      status: meta.status,
      title: meta.title ?? base,
      kind: meta.kind ?? null,
      season: meta.season ?? null,
      episode: meta.episode ?? null,
      episodeName: meta.episode_name || null,
      part: meta.part ?? 1,
      date: meta.date ?? null,
      time: meta.time ?? null,
      startedAt: meta.started_at ?? null,
      endedAt: meta.ended_at ?? null,
      duration: meta.duration ?? null,
      width: meta.width ?? null,
      height: meta.height ?? null,
      size,
      url: meta.url ?? meta.room_link ?? null,
      room: meta.room ?? null,
      thumb,
      frame: meta.frame && fs.existsSync(path.join(thumbsDir, meta.frame)) ? meta.frame : null, // a frame from halfway through
      file: meta.status === 'saved' ? meta.file : null,
      compressed: Boolean(meta.compressed), // re-encoded smaller from the Storage window
      incomplete: Boolean(meta.incomplete), // the episode broke off partway (black after), so it's recorded again
      log: meta.log ?? null,
      raw,
      pauses: pauses.length,
      pausedSeconds: Math.round(pauses.reduce((sum, p) => sum + (p.to ? Date.parse(p.to) - Date.parse(p.from) : 0), 0) / 1000),
      pausedAt: openPause?.from ?? null, // paused right now, since then
    });
  }

  // Videos without metadata (e.g. made before metadata existed) still show up.
  for (const name of names) {
    if (!/\.(mp4|webm)$/.test(name) || name.endsWith('.recording.webm') || claimed.has(name)) continue;
    const stat = fileStat(path.join(dir, name));
    if (!stat?.isFile()) continue;
    const base = name.replace(/\.(mp4|webm)$/, '');
    // A recording still being saved: its finished file is being written next to its details,
    // and isn't a recording of its own (it shows once saved, under its details).
    if (present.has(`${base}.json`) || present.has(`${base}.recording.webm`)) continue;
    items.push({
      id: idFor(base), status: 'saved', title: base, kind: null, season: null, episode: null,
      episodeName: null, part: 1, date: null, time: null, startedAt: stat.mtime.toISOString(),
      endedAt: null, duration: null, width: null, height: null, size: stat.size, url: null,
      room: null, thumb: null, frame: null, file: name, raw: null, log: null, pauses: 0, pausedSeconds: 0, pausedAt: null,
    });
  }
  return items;
}

function idFor(base) {
  return crypto.createHash('sha1').update(base).digest('hex').slice(0, 12);
}

function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function fileStat(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function isHttpUrl(value) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

// Runs a command in its own process group, so Ctrl+C in the terminal doesn't kill it midway.
function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// A recording whose video was moved to the SD card is a link here: its copy on the card goes to
// that card's own Trash (where Finder puts what's deleted from it), and the link is removed.
// Returns whether the file was such a link.
function trashCardCopy(file) {
  let target;
  try {
    if (!fs.lstatSync(file).isSymbolicLink()) return false;
    target = fs.readlinkSync(file);
  } catch {
    return false;
  }
  const volume = /^\/Volumes\/[^/]+/.exec(target)?.[0];
  if (volume && fs.existsSync(target)) {
    try {
      const trash = path.join(volume, '.Trashes', String(process.getuid()));
      fs.mkdirSync(trash, { recursive: true });
      const { name, ext } = path.parse(target);
      let to = path.join(trash, `${name}${ext}`);
      for (let i = 2; fs.existsSync(to); i++) to = path.join(trash, `${name} ${i}${ext}`);
      fs.renameSync(target, to);
    } catch {} // left on the card rather than lost
  }
  fs.rmSync(file, { force: true });
  return true;
}

module.exports = {
  trashCardCopy,
  THUMB_DIR, LOG_DIR, ThumbnailCache, probeVideo, readLibrary, writeJson, readJson, isHttpUrl, run,
  loadConfig, saveConfig, expandPath, writeStatus, clearStatus, recorderStatus, recordUrlOf, openPlays, samePlay, episodeKey, leadIn,
};
