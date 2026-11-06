#!/usr/bin/env node
'use strict';

// Watches a playback log (a JSON array like ~/Desktop/log_example.json). When a
// "start play" entry is appended, it opens that entry's room_link in Chrome and
// records the tab (video + audio) until a "stop" entry for the same room_link.
// A "pause" entry pauses the recording and "resume play" picks it up again in
// the same file, so the paused time is left out.
// Which log is watched lives in config.json, so the dashboard can change it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { finished } = require('stream/promises');
const { spawnSync } = require('child_process');
const puppeteer = require('puppeteer-core');
const {
  THUMB_DIR, ThumbnailCache, probeVideo, writeJson, readJson, isHttpUrl, run,
  loadConfig, saveConfig, expandPath, writeStatus, clearStatus, recorderStatus, recordUrlOf, openPlays, samePlay, episodeKey, leadIn,
  trashCardCopy,
} = require('./library');

const HELP = `
Usage: node recorder.js [options]

  --log <file>        Log file to watch; saved as the setting the dashboard shows
                      (default: the dashboard's setting, else ~/Desktop/log_example.json)
  --out <dir>         Folder recordings are saved to (default: ./recordings)
  --format mp4|webm   Output format (default: mp4)
  --size <WxH>        Size of the recorded page area (default: 1280x720)
  --interval <ms>     How often to check the log for new entries (default: 1000)
  --headless          Run Chrome without a visible window
  --audible           Also play the sound through the speakers while recording
  --chrome <path>     Chrome executable (default: Google Chrome in /Applications)
  -h, --help          Show this help
`;

const opts = parseArgs(process.argv.slice(2));
const HAS_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0;

// ffmpeg settings tried in order when finalizing a recording.
const ENCODERS = {
  mp4: [
    ['-c:v', 'h264_videotoolbox', '-b:v', '6M'],
    ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'],
  ].map((video) => [
    ...video, '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
  ]),
  webm: [['-c', 'copy']],
};

const active = new Map();      // room_link -> Recording
const conversions = new Set(); // ffmpeg jobs still running
const usedNames = new Set();
const thumbs = new ThumbnailCache(path.join(opts.out, THUMB_DIR), log);
const entryQueue = serialQueue();
let browser = null;
let shuttingDown = false;
let watching = null; // the log file currently being watched
let skipped = 0; // entries already in that log when watching began
const problems = new Map(); // room_link -> why it couldn't be recorded, for the dashboard
const retryAt = new Map(); // room_link -> when to try a room that didn't open again
const waiting = new Map(); // room_link -> start entry of a paused play that isn't being recorded
const CHECK_MS = 15_000; // how often to make sure everything playing is being recorded
const RETRY_MS = 60_000; // how long to wait before trying a room that didn't open again
const GONE_MS = 60_000; // how long an entry has to stay out of its log before its recording is removed
const goneSince = new Map(); // recording -> when its entry was first missing from its log
const TRASH = process.env.RECORDING_TRASH || path.join(os.homedir(), '.Trash');
const startedAt = new Date().toISOString();

// ---------------------------------------------------------------------------
// Code that runs inside the room's page. Chrome is launched with
// --auto-accept-this-tab-capture, so capturing the current tab needs no prompt.

async function pageCapture(audible, width, height) {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error(`Chrome won't capture ${location.origin}: only secure pages (https, or localhost) can be recorded`);
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 30 },
    audio: true,
    preferCurrentTab: true,
    suppressLocalAudioPlayback: !audible,
  });
  // Ask for full pixel resolution; without this, headless Chrome caps the
  // capture at its fake 800x600 screen.
  const [track] = stream.getVideoTracks();
  const scale = Math.max(window.devicePixelRatio || 1, track.getSettings().screenPixelRatio || 1);
  await track.applyConstraints({
    frameRate: 30, width: { ideal: Math.round(width * scale) }, height: { ideal: Math.round(height * scale) },
  }).catch(() => {});

  // Sound that arrives over WebRTC (a remote stream playing in a <video>, like
  // Screen Relay's TV page) isn't in what Chrome captures from the tab, so it's
  // taken straight from those streams and mixed with the tab's own sound. A
  // stream that arrives later (the sharer reconnects) joins the mix too.
  const audio = new AudioContext();
  const mix = audio.createMediaStreamDestination();
  const join = (track) => audio.createMediaStreamSource(new MediaStream([track])).connect(mix);
  stream.getAudioTracks().forEach(join);
  const joined = new Set();
  const joinRemoteSound = () => {
    for (const el of document.querySelectorAll('video, audio')) {
      if (!(el.srcObject instanceof MediaStream)) continue;
      for (const remote of el.srcObject.getAudioTracks()) {
        if (joined.has(remote.id) || remote.readyState !== 'live') continue;
        joined.add(remote.id);
        join(remote);
      }
    }
  };
  joinRemoteSound();
  const timer = setInterval(joinRemoteSound, 1000);

  window.__logRecorderStream = new MediaStream([...stream.getVideoTracks(), ...mix.stream.getAudioTracks()]);
  window.__logRecorderCleanup = () => {
    clearInterval(timer);
    stream.getTracks().forEach((t) => t.stop());
    audio.close().catch(() => {});
  };
  return { video: stream.getVideoTracks().length, audio: stream.getAudioTracks().length + joined.size };
}

function pageStartRecorder() {
  const stream = window.__logRecorderStream;
  const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find((type) => MediaRecorder.isTypeSupported(type));
  const recorder = new MediaRecorder(stream, {
    mimeType, videoBitsPerSecond: 5_000_000, audioBitsPerSecond: 160_000,
  });

  // Chunks are handed to Node one at a time, in order.
  let sending = Promise.resolve();
  recorder.ondataavailable = (event) => {
    if (!event.data.size) return;
    sending = sending.then(async () => {
      const bytes = new Uint8Array(await event.data.arrayBuffer());
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      }
      await window.__logRecorderChunk(btoa(binary));
    }).catch(() => {});
  };
  const stopped = new Promise((resolve) => { recorder.onstop = resolve; });

  window.__logRecorder = {
    // While paused nothing is recorded, and the file's timeline continues
    // from where it paused, so the pause doesn't show up in the recording.
    pause() {
      if (recorder.state !== 'recording') return;
      recorder.pause();
      recorder.requestData(); // write out the last moments, so it can be watched up to the pause
    },
    resume() {
      if (recorder.state === 'paused') recorder.resume();
    },
    async stop() {
      if (recorder.state !== 'inactive') recorder.stop();
      await stopped;
      await sending;
      stream.getTracks().forEach((track) => track.stop());
      window.__logRecorderCleanup?.();
    },
  };
  recorder.start(1000);
  return mimeType;
}

// ---------------------------------------------------------------------------

class Recording {
  constructor(entry, { quiet = false } = {}) {
    this.entry = entry;
    this.url = recordUrlOf(entry);
    this.quiet = quiet; // a retry: don't repeat what the first try already logged
    this.baseName = describe(entry);
    this.firstPart = nextPart(this.baseName);
    this.claimed = this.firstPart === 1 ? this.baseName : `${this.baseName} (part ${this.firstPart})`;
    this.parts = [];
    this.part = null;
    this.page = null;
    this.finished = false;
    this.queue = serialQueue(); // start, navigation handling, pauses and stop never overlap
    this.thumbFile = null;
    this.thumb = Promise.resolve();
    this.log = watching; // the log it came from: the dashboard shows it while its entry is still there
    this.paused = false;
    this.pausedSince = 0;
    this.pausedMs = 0; // finished pauses, left out of the recording
  }

  start() {
    // Fetched alongside the page load; the dashboard picks it up once it lands.
    const title = titleOf(this.entry);
    this.thumb = thumbs.get(this.entry.thumbnail, title)
      .then((file) => {
        this.thumbFile = file;
        for (const part of this.parts) if (!part.closed && part.status !== 'starting') writeSidecar(this, part);
      })
      .catch((err) => this.quiet || log(`  Thumbnail for "${title}" failed: ${err.message}`));
    return this.queue(() => this._start());
  }

  stop(reason) {
    return this.queue(() => this._finish(reason));
  }

  pause(position) {
    return this.queue(() => this._pause(position));
  }

  resume(position) {
    return this.queue(() => this._resume(position));
  }

  // How much has actually been recorded so far (pauses don't count).
  recordedMs() {
    const pausedNow = this.paused ? Date.now() - this.pausedSince : 0;
    return Date.now() - this.startedAt - this.pausedMs - pausedNow;
  }

  async _pause(position) {
    if (this.finished || this.paused) return;
    this.paused = true;
    this.pausedSince = Date.now();
    await this._pausePart();
    log(`❚❚ Paused "${this.baseName}"${position ? ` at ${position}` : ''} after ${formatDuration(this.recordedMs())}, waiting for it to play again`);
  }

  async _resume(position) {
    if (this.finished || !this.paused) return;
    const pause = Date.now() - this.pausedSince;
    this.paused = false;
    this.pausedMs += pause;
    const part = this.part;
    if (part && !part.closed) {
      await this.page.evaluate(() => window.__logRecorder && window.__logRecorder.resume()).catch(() => {});
      endPause(part);
      part.status = 'recording';
      writeSidecar(this, part);
    }
    log(`▶ Resumed "${this.baseName}"${position ? ` at ${position}` : ''}, after a ${formatDuration(pause)} pause (not recorded)`);
  }

  async _pausePart() {
    const part = this.part;
    if (!part || part.closed) return;
    await this.page.evaluate(() => window.__logRecorder && window.__logRecorder.pause()).catch(() => {});
    part.pauses.push({ from: new Date().toISOString(), to: null });
    part.status = 'paused';
    writeSidecar(this, part);
  }

  async _start() {
    try {
      this.page = await (await getBrowser()).newPage();
      await this.page.exposeFunction('__logRecorderChunk', (b64) => {
        if (this.part && !this.part.closed) this.part.stream.write(Buffer.from(b64, 'base64'));
      });
      this.page.on('domcontentloaded', () => {
        this.queue(() => this._afterNavigation()).catch((err) => log(`  ${this.baseName}: ${err.message}`));
      });
      this.page.on('close', () => this.stop('the tab was closed').catch(() => {}));

      await this.page.goto(capturableUrl(this.url), { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await this._startPart();
      this.startedAt = Date.now();
    } catch (err) {
      this.finished = true;
      if (active.get(this.url) === this) active.delete(this.url);
      usedNames.delete(this.claimed); // nothing was saved under it, so the next try can use it
      await this._closePart({ discard: true });
      if (this.page) await this.page.close().catch(() => {});
      throw err;
    }
  }

  async _startPart() {
    const n = this.firstPart + this.parts.length;
    const name = n === 1 ? this.baseName : `${this.baseName} (part ${n})`;
    const part = {
      n,
      name,
      rawPath: path.join(opts.out, `${name}.recording.webm`),
      sidecarPath: path.join(opts.out, `${name}.json`),
      status: 'starting',
      closed: false,
      pauses: [], // { from, to } times when the recording was paused
    };
    part.stream = fs.createWriteStream(part.rawPath);
    part.stream.on('error', (err) => log(`  Write error for ${part.rawPath}: ${err.message}`));
    this.parts.push(part);
    this.part = part;

    await this.page.bringToFront();
    const tracks = await this.page.evaluate(pageCapture, opts.audible, opts.width, opts.height);
    if (!tracks.audio) log(`  ${this.baseName}: no audio available, recording video only`);
    await fitContent(this.page, opts.width, opts.height);
    await this.page.evaluate(pageStartRecorder);
    part.startedAt = new Date();
    part.status = 'recording';
    // A page that reloads during a pause starts its new part paused too.
    if (this.paused) await this._pausePart();
    else writeSidecar(this, part);
  }

  // Ends the current part and saves it (or throws it away when the start failed).
  async _closePart({ discard = false } = {}) {
    const part = this.part;
    if (!part || part.closed) return;
    part.closed = true;
    part.stream.end();
    await finished(part.stream).catch(() => {});
    if (discard) {
      fs.rmSync(part.rawPath, { force: true });
      fs.rmSync(part.sidecarPath, { force: true });
      return;
    }
    part.endedAt = new Date();
    part.status = 'saving';
    endPause(part);
    writeSidecar(this, part);
    trackConversion(finalize(this, part));
  }

  // A full page load wipes out the in-page recorder; keep going in a new part.
  async _afterNavigation() {
    if (this.finished || !this.part) return;
    const alive = await this.page.evaluate(() => Boolean(window.__logRecorder)).catch(() => false);
    if (alive) return;
    log(`  ${this.baseName}: page reloaded, continuing in a new part`);
    await this._closePart();
    await this._startPart();
  }

  async _finish(reason) {
    if (this.finished) return;
    this.finished = true;
    if (active.get(this.url) === this) active.delete(this.url);

    if (this.page && !this.page.isClosed()) {
      await this.page.evaluate(() => window.__logRecorder && window.__logRecorder.stop()).catch(() => {});
      await this.page.close().catch(() => {});
    }
    const recorded = this.startedAt ? this.recordedMs() : 0;
    const paused = this.pausedMs + (this.paused ? Date.now() - this.pausedSince : 0);
    log(`■ Stopped "${this.baseName}" after ${formatDuration(recorded)}${paused ? ` of recording (plus ${formatDuration(paused)} paused, left out)` : ''} (${reason})`);
    await this._closePart();
  }
}

async function handleEntry(entry) {
  if (!entry || typeof entry !== 'object') return;
  const action = String(entry.action ?? '').trim().toLowerCase();
  const url = recordUrlOf(entry);
  const current = active.get(url);
  const resuming = action.startsWith('resume');

  if (action === 'pause') {
    if (current) await current.pause(entry.position);
    else log(`Pause entry for ${url} but nothing is recording it, ignored`);
  } else if (action.startsWith('start') || resuming) {
    // Playing again after a pause carries on in the same recording. A fresh
    // "start play" of the same episode or movie counts as playing again too.
    if (current?.paused && (resuming || samePlay(current.entry, entry))) {
      await current.resume(entry.position);
      return;
    }
    if (resuming && current) {
      log(`Resume entry for ${url} but it's already recording, ignored`);
      return;
    }
    if (!isHttpUrl(url)) {
      problems.set(url, 'it has no usable room_link');
      log(`Skipping "${entry.action}" entry: no usable room_link (${JSON.stringify(url)})`);
      return;
    }
    if (current) await current.stop('a new start arrived before its stop');
    if (resuming) log(`Resume entry for ${url} but nothing was paused there, recording from here`);

    // Playing again after a pause that was going on when watching began: named
    // after its start entry, so it joins any earlier recording as its next part.
    await startRecording(resuming ? waiting.get(url) ?? entry : entry);
  } else if (action === 'stop' || action === 'end') {
    // "end": ended early from the VCR (End), so it isn't counted as watched; recorded up to there.
    waiting.delete(url);
    problems.delete(url);
    retryAt.delete(url);
    if (current) await current.stop('stop entry');
    else log(`Stop entry for ${url} but nothing is recording it, ignored`);
  } else {
    log(`Ignoring entry with action "${entry.action}"`);
  }
}

// Opens the entry's room and records it. A room that doesn't open is tried
// again a minute later (by keepPlayingRecorded) for as long as the log says
// it's playing; those retries only write to the log when something changes.
async function startRecording(entry, { retry = false } = {}) {
  const url = recordUrlOf(entry);
  waiting.delete(url);
  const rec = new Recording(entry, { quiet: retry });
  active.set(url, rec);
  const what = `"${rec.baseName}"${rec.firstPart > 1 ? ` as part ${rec.firstPart}` : ''} from ${url}`;
  if (!retry) log(`● Recording ${what}`);
  try {
    await rec.start();
    if (retry) log(`● Recording ${what} (the room opened this time)`);
    problems.delete(url);
    retryAt.delete(url);
  } catch (err) {
    const message = err.message.split('\n')[0];
    if (problems.get(url) !== message) log(`✗ Couldn't record ${url}: ${message} (trying again every minute while it's playing)`);
    problems.set(url, message);
    retryAt.set(url, Date.now() + RETRY_MS);
  }
}

// A recording whose entry was taken out of its log (e.g. with the VCR's Delete)
// is removed: one still recording is stopped, and a saved one's video and
// .json go to the Trash. Only recordings that know their log are touched, a
// log that can't be read right now removes nothing, and the entry has to stay
// gone for GONE_MS first, so a log being rewritten doesn't cost anything.
async function removeDropped() {
  const logs = new Map(); // log file -> Set of "date time room_link", or null if it can't be read
  const gone = (logFile, date, time, url) => {
    if (!logFile || !date || !time || !url) return false;
    if (!logs.has(logFile)) {
      const entries = readJson(logFile);
      logs.set(logFile, Array.isArray(entries)
        ? new Set(entries.filter((e) => e && typeof e === 'object').map((e) => `${e.date} ${e.time} ${recordUrlOf(e)}`))
        : null);
    }
    const keys = logs.get(logFile);
    return Boolean(keys) && !keys.has(`${date} ${time} ${url}`);
  };
  const due = (key, isGone) => {
    if (!isGone) {
      goneSince.delete(key);
      return false;
    }
    if (!goneSince.has(key)) goneSince.set(key, Date.now());
    return Date.now() - goneSince.get(key) >= GONE_MS;
  };

  for (const rec of [...active.values()]) {
    if (due(`active ${rec.claimed}`, gone(rec.log, rec.entry.date, rec.entry.time, rec.url))) {
      goneSince.delete(`active ${rec.claimed}`);
      await rec.stop('its entry was taken out of the log'); // its files go once it's saved
    }
  }
  for (const name of fs.readdirSync(opts.out)) {
    if (!name.endsWith('.json')) continue;
    const meta = readJson(path.join(opts.out, name));
    if (meta?.version !== 1 || meta.status !== 'saved') continue;
    if (!due(name, gone(meta.log, meta.date, meta.time, meta.url ?? meta.room_link))) continue;
    goneSince.delete(name);
    const results = [meta.file, name].filter(Boolean).map((file) => discard(path.join(opts.out, file)));
    const how = results.includes('deleted') ? 'deleted (the Trash wasn\'t available)' : 'moved to the Trash';
    log(`🗑 Removed "${name.slice(0, -'.json'.length)}": its entry is no longer in ${path.basename(meta.log)} (${how})`);
  }
}

// The play a recording belongs to: its parts (cut by a restart, or the page
// reloading) share the first part's name, which comes from the play's log entry.
const playOf = (sidecarName) => sidecarName.slice(0, -'.json'.length).replace(/ \(part \d+\)$/, '');

// Only one recording of each episode (or movie) is kept. Parts of one play are
// joined first (joinParts); after that, once none of an episode's recordings is
// still going or saving, the longest viewing stays and the others go to the Trash.
function removeDuplicates() {
  const busy = new Set([...active.values()].map((rec) => episodeKey({ ...rec.entry, title: titleOf(rec.entry) })));
  const copies = new Map(); // episode -> its saved recordings
  for (const name of fs.readdirSync(opts.out)) {
    if (!name.endsWith('.json')) continue;
    const meta = readJson(path.join(opts.out, name));
    const key = meta?.version === 1 && episodeKey(meta);
    if (!key) continue;
    if (meta.status !== 'saved') busy.add(key);
    else copies.set(key, [...(copies.get(key) ?? []), { name, meta }]);
  }
  for (const [key, list] of copies) {
    if (list.length < 2 || busy.has(key)) continue;
    const plays = new Set(list.map(({ name }) => playOf(name)));
    if (plays.size < list.length) continue; // a play still in parts: joined first
    // A whole one over one marked incomplete (it broke off partway, e.g. black after), however long.
    const [keep, ...extra] = list.sort((a, b) => Boolean(a.meta.incomplete) - Boolean(b.meta.incomplete)
      || (b.meta.duration ?? 0) - (a.meta.duration ?? 0));
    for (const { name, meta } of extra) {
      const results = [meta.file, name].filter(Boolean).map((file) => discard(path.join(opts.out, file)));
      const how = results.includes('deleted') ? 'deleted (the Trash wasn\'t available)' : 'moved to the Trash';
      log(`🗑 Removed "${name.slice(0, -'.json'.length)}" (${formatDuration((meta.duration ?? 0) * 1000)}): `
        + `"${keep.name.slice(0, -'.json'.length)}" is a better recording of it (${how})`);
    }
  }
}

// A play cut into parts is joined back into one recording once none of its
// parts is still going or saving: the videos go end to end in a new file under
// the first part's name (copied as they are, or re-encoded if that doesn't
// work), and once its length checks out the parts go to the Trash. One play at
// a time, outside the entry queue, so a long join doesn't hold up recording.
let job = null; // a join or a trim running in the background (one at a time)
const joinFailed = new Set(); // plays that couldn't be joined (tried once per run)
function joinParts() {
  if (job || shuttingDown) return;
  const busy = new Set([...active.values()].map((rec) => rec.baseName));
  const plays = new Map(); // play -> its saved parts
  for (const name of fs.readdirSync(opts.out)) {
    if (!name.endsWith('.json')) continue;
    const meta = readJson(path.join(opts.out, name));
    if (meta?.version !== 1) continue;
    const play = playOf(name);
    if (meta.status !== 'saved') busy.add(play);
    else if (meta.file && fs.existsSync(path.join(opts.out, meta.file))) plays.set(play, [...(plays.get(play) ?? []), { name, meta }]);
  }
  const next = [...plays].find(([play, parts]) => parts.length > 1 && !busy.has(play) && !joinFailed.has(play));
  if (!next) return;
  const [play, parts] = next;
  job = joinPlay(play, parts.sort((a, b) => (a.meta.part ?? 1) - (b.meta.part ?? 1)))
    .catch((err) => {
      joinFailed.add(play);
      log(`  Couldn't join the parts of "${play}", left as they are: ${err.message}`);
    })
    .finally(() => { job = null; });
  trackConversion(job); // shutting down waits for it
}

// Encoders for joining parts that have to be re-encoded (the video comes out of a filter).
const JOIN_CODECS = {
  mp4: [['-c:v', 'h264_videotoolbox', '-b:v', '6M'], ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20']]
    .map((video) => [...video, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart']),
  webm: [['-c:v', 'libvpx-vp9', '-b:v', '4M', '-deadline', 'realtime', '-c:a', 'libopus']],
};

// Each part brought to the same size and frame rate, then all of them in a row.
function evenedOut(count, width, height) {
  const w = width - (width % 2);
  const h = height - (height % 2);
  const each = [...Array(count).keys()].map((i) => `[${i}:v]fps=30,scale=${w}:${h}:force_original_aspect_ratio=decrease,`
    + `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}];[${i}:a]aresample=48000[a${i}]`);
  return `${each.join(';')};${[...Array(count).keys()].map((i) => `[v${i}][a${i}]`).join('')}concat=n=${count}:v=1:a=1[v][a]`;
}

async function joinPlay(play, parts) {
  const ext = path.extname(parts[0].meta.file);
  const format = ext === '.webm' ? 'webm' : 'mp4';
  const expected = parts.reduce((sum, { meta }) => sum + (meta.duration ?? 0), 0);
  const list = path.join(os.tmpdir(), `recording-join-${process.pid}-${Date.now()}.txt`);
  const out = path.join(opts.out, `${play}.joining`); // not a video name, so the dashboard ignores it
  fs.writeFileSync(list, parts.map(({ meta }) => `file '${path.join(opts.out, meta.file).replace(/'/g, "'\\''")}'`).join('\n'));
  // First try putting the videos end to end as they are. Parts recorded
  // differently (one at a lower frame rate, say) don't line up that way, so
  // then they're decoded, evened out (same size, 30 frames a second) and re-encoded.
  const { width = 1280, height = 720 } = parts[0].meta;
  const attempts = [
    ['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', ...(format === 'mp4' ? ['-movflags', '+faststart'] : [])],
    ...JOIN_CODECS[format].map((codec) => [
      ...parts.flatMap(({ meta }) => ['-i', path.join(opts.out, meta.file)]),
      '-filter_complex', evenedOut(parts.length, width, height), '-map', '[v]', '-map', '[a]', ...codec,
    ]),
  ];
  let joined = null;
  try {
    for (const args of attempts) {
      const ok = await runFfmpeg(['-nostdin', '-y', '-v', 'error', ...args, '-f', format, out]);
      const probe = ok ? await probeVideo(out) : {};
      if (probe.duration && Math.abs(probe.duration - expected) <= Math.max(3, expected * 0.03)) {
        joined = probe;
        break;
      }
    }
  } finally {
    fs.rmSync(list, { force: true });
  }
  if (!joined) {
    fs.rmSync(out, { force: true });
    throw new Error(`the joined video didn't come out ${formatDuration(expected * 1000)} long`);
  }

  for (const { name, meta } of parts) {
    discard(path.join(opts.out, meta.file));
    discard(path.join(opts.out, name));
  }
  const target = path.join(opts.out, `${play}${ext}`);
  fs.renameSync(out, target);
  const first = parts[0].meta;
  const meta = {
    ...first,
    status: 'saved',
    file: path.basename(target),
    part: 1,
    ended_at: parts.at(-1).meta.ended_at,
    duration: joined.duration,
    width: joined.width ?? first.width,
    height: joined.height ?? first.height,
    pauses: parts.flatMap(({ meta: m }) => m.pauses ?? []),
    joined_parts: parts.length,
  };
  meta.frame = (await halfwayFrame(meta.kind, target, meta.duration)) ?? first.frame ?? null;
  writeJson(path.join(opts.out, `${play}.json`), meta);
  log(`🔗 Joined ${parts.length} parts of "${play}" into one recording (${formatDuration(joined.duration * 1000)}); the parts went to the Trash`);
}

// Moves a file to the Trash, or deletes it if the Trash can't take it.
function discard(file) {
  if (trashCardCopy(file)) return 'trash'; // moved to the SD card: its copy there goes to the card's Trash
  if (!fs.existsSync(file)) return 'gone';
  try {
    const { name, ext } = path.parse(file);
    let target = path.join(TRASH, `${name}${ext}`);
    for (let i = 2; fs.existsSync(target); i++) target = path.join(TRASH, `${name} ${i}${ext}`);
    fs.renameSync(file, target);
    return 'trash';
  } catch {
    fs.rmSync(file, { force: true });
    return 'deleted';
  }
}

// The rule: whatever the log says is playing (started, not stopped, not
// paused) is being recorded. Checked whenever the log changes and every
// CHECK_MS, which covers what was already playing when watching began (after
// a restart, say), a room that didn't open (tried again every minute) and a
// recording that ended early (its tab or Chrome closed), which carries on as
// its next part. Something paused is recorded once it plays again.
async function keepPlayingRecorded(entries) {
  for (const [url, { entry, pause }] of openPlays(entries)) {
    if (shuttingDown) return;
    if (active.has(url) || !isHttpUrl(url)) continue;
    if (pause) {
      if (!waiting.has(url)) log(`"${describe(entry)}" is paused; it's recorded once it plays again`);
      waiting.set(url, entry);
      continue;
    }
    const retry = problems.has(url);
    if (retry && Date.now() < (retryAt.get(url) ?? 0)) continue;
    if (!retry) log(`"${describe(entry)}" is playing in the log but wasn't being recorded`);
    await startRecording(entry, { retry });
  }
}

// Closes a part's pause that's still open (when it resumes, stops or is cut short).
function endPause(part) {
  const last = part.pauses.at(-1);
  if (last && !last.to) last.to = new Date().toISOString();
}

async function watchLog() {
  let seen = null; // how many entries of the current log have been handled
  let lastStamp = null;
  let lastError = null;
  let latest = null; // the log's entries as last read
  let checkedAt = 0;
  const check = async () => {
    await entryQueue(async () => {
      await keepPlayingRecorded(latest);
      await removeDropped();
      trimOldStarts(); // before joining, so each part's start is cut first
      joinParts();
      if (!job) removeDuplicates();
      await addMissingFrames();
    });
    checkedAt = Date.now();
    heartbeat();
  };

  while (!shuttingDown) {
    // The dashboard can point us at a different log at any time. Entries
    // already in the new file are skipped, like at startup.
    const wanted = loadConfig().log;
    if (wanted !== watching) {
      log(watching ? `Log file changed, now watching ${wanted}` : `Watching ${wanted}`);
      watching = wanted;
      seen = null;
      lastStamp = null;
      lastError = null;
      latest = null;
      skipped = 0;
      problems.clear();
      retryAt.clear();
      waiting.clear();
      heartbeat();
    }

    const stamp = fileStamp(watching);
    if (stamp !== lastStamp) {
      const { entries, error } = readEntries(watching);
      if (error) {
        // Usually the file is mid-write; try again next tick.
        if (error !== lastError) log(`Can't read ${watching} yet (${error}), retrying`);
        lastError = error;
      } else {
        lastStamp = stamp;
        lastError = null;
        // Entries already there when watching begins aren't replayed; the
        // check below records whatever they say is still playing.
        if (seen === null || (entries && entries.length < seen)) {
          if (seen !== null) log('Log file got shorter, treating it as a new log');
          seen = skipped = entries ? entries.length : 0;
          log(entries ? `${seen} existing entries, waiting for new ones`
                      : `${watching} is missing or empty, waiting for entries`);
          heartbeat();
        }
        // A missing or empty file (entries === null) is usually one being
        // rewritten, so keep our place rather than starting over.
        while (entries && seen < entries.length && !shuttingDown && loadConfig().log === watching) {
          const entry = entries[seen++];
          await entryQueue(() => handleEntry(entry));
          heartbeat();
        }
        if (entries) {
          latest = entries;
          if (!shuttingDown) await check();
        }
      }
    }
    if (latest && !shuttingDown && Date.now() - checkedAt >= CHECK_MS) await check();
    await sleep(opts.interval);
  }
}

// Lets the dashboard show that the recorder is running and what it's doing.
function heartbeat() {
  if (shuttingDown) return;
  writeStatus({
    started_at: startedAt,
    watching,
    recording: [...active.values()].map((rec) => rec.baseName),
    paused: [...active.values()].filter((rec) => rec.paused).map((rec) => rec.baseName),
    skipped, // the first this many entries of the log were there before watching began
    problems: Object.fromEntries(problems),
    waiting: [...waiting.keys()],
  });
}

function readEntries(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return err.code === 'ENOENT' ? { entries: null } : { error: err.message };
  }
  if (!text.trim()) return { entries: null };
  try {
    const data = JSON.parse(text);
    return Array.isArray(data) ? { entries: data } : { error: 'expected a JSON array' };
  } catch (err) {
    return { error: err.message };
  }
}

function fileStamp(file) {
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return '';
  }
}

async function getBrowser() {
  if (browser?.connected) return browser;
  log('Launching Chrome');
  const launched = await puppeteer.launch({
    executablePath: opts.chrome,
    headless: opts.headless,
    defaultViewport: null,
    userDataDir: path.join(__dirname, 'chrome-profile'), // keeps logins between runs
    ignoreDefaultArgs: ['--mute-audio'],                  // muted Chrome records silence
    handleSIGINT: false,                                  // shutdown() saves recordings first
    handleSIGTERM: false,
    args: [
      '--auto-accept-this-tab-capture',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      `--window-size=${opts.width},${opts.height + 150}`,
      // Plays into a fake output, so nothing comes out of the Mac's speakers; the room's
      // sound is still taken straight from its streams and recorded.
      ...(opts.audible ? [] : ['--disable-audio-output']),
    ],
  });
  launched.on('disconnected', () => {
    if (browser === launched) browser = null;
    for (const rec of active.values()) {
      if (rec.page?.browser() === launched) rec.stop('Chrome was closed').catch(() => {});
    }
  });
  browser = launched;
  return browser;
}

// Resize the window so the page area (what gets recorded) is width x height.
async function fitContent(page, width, height) {
  let session;
  try {
    session = await page.createCDPSession();
    const { windowId } = await session.send('Browser.getWindowForTarget');
    for (let i = 0; i < 3; i++) {
      const [innerW, innerH] = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
      if (innerW === width && innerH === height) break;
      const { bounds } = await session.send('Browser.getWindowBounds', { windowId });
      await session.send('Browser.setWindowBounds', {
        windowId,
        bounds: { width: bounds.width + width - innerW, height: bounds.height + height - innerH },
      });
      await sleep(250);
    }
  } catch {
    // Best effort: a maximized window or a small screen just keeps its size.
  } finally {
    await session?.detach().catch(() => {});
  }
}

async function finalize(rec, part) {
  const size = fs.existsSync(part.rawPath) ? fs.statSync(part.rawPath).size : 0;
  if (!size) {
    fs.rmSync(part.rawPath, { force: true });
    fs.rmSync(part.sidecarPath, { force: true });
    log(`  Nothing was captured for "${part.name}"`);
    return;
  }

  const cut = await leadIn(part.rawPath);
  const { saved, converted } = await convertRaw(part.rawPath, part.name, cut);
  if (converted && cut) log(`  Cut ${formatDuration(cut * 1000)} of the room connecting from the start of "${part.name}"`);
  Object.assign(part, await probeVideo(saved), { file: path.basename(saved), status: 'saved', startTrimmed: converted ? cut : null });
  await rec.thumb;
  if (!rec.thumbFile && HAS_FFMPEG) rec.thumbFile = await thumbs.fromVideo(saved, part.duration);
  part.frame = await halfwayFrame(rec.entry.kind, saved, part.duration);
  writeSidecar(rec, part);
  fs.rmSync(part.rawPath, { force: true });
  logSaved(saved, converted);
}

// Turns a raw .recording.webm into the final file (or keeps the WebM if that fails).
// `from` (seconds) skips that much of the start (see leadIn).
async function convertRaw(rawPath, name, from = 0) {
  if (HAS_FFMPEG) {
    const target = path.join(opts.out, `${name}.${opts.format}`);
    for (const args of ENCODERS[opts.format]) {
      if (await runFfmpeg(['-nostdin', '-y', '-v', 'error', '-i', rawPath, ...(from ? ['-ss', String(from)] : []), ...args, target])) {
        return { saved: target, converted: true };
      }
    }
    fs.rmSync(target, { force: true });
  }
  const saved = path.join(opts.out, `${name}.webm`);
  fs.renameSync(rawPath, saved);
  return { saved, converted: false };
}

// Recordings saved before starts were cut get theirs cut now, one at a time:
// re-encoded from the cut, checked for length, and swapped in, with the
// original going to the Trash. Runs outside the entry queue, like joins.
const trimFailed = new Set();
function trimOldStarts() {
  if (job || shuttingDown || !HAS_FFMPEG) return;
  for (const name of fs.readdirSync(opts.out)) {
    if (!name.endsWith('.json') || trimFailed.has(name)) continue;
    const meta = readJson(path.join(opts.out, name));
    if (meta?.version !== 1 || meta.status !== 'saved' || meta.start_trimmed != null || !meta.file) continue;
    const video = path.join(opts.out, meta.file);
    if (!fs.existsSync(video)) continue;
    job = trimStart(name, meta, video)
      .catch((err) => {
        trimFailed.add(name);
        log(`  Couldn't cut the start of "${name.slice(0, -'.json'.length)}", left as it is: ${err.message}`);
      })
      .finally(() => { job = null; });
    trackConversion(job);
    return;
  }
}

async function trimStart(name, meta, video) {
  const sidecar = path.join(opts.out, name);
  const duration = meta.duration ?? (await probeVideo(video)).duration ?? 0;
  const cut = Math.min(await leadIn(video), Math.max(0, duration - 1));
  if (cut < 1) {
    writeJson(sidecar, { ...(readJson(sidecar) ?? meta), start_trimmed: 0 });
    return;
  }
  const format = path.extname(video) === '.webm' ? 'webm' : 'mp4';
  const out = path.join(opts.out, `${name.slice(0, -'.json'.length)}.trimming`); // not a video name, so the dashboard ignores it
  let trimmed = null;
  for (const args of ENCODERS[format]) {
    if (!(await runFfmpeg(['-nostdin', '-y', '-v', 'error', '-i', video, '-ss', String(cut), ...args, '-f', format, out]))) continue;
    const probe = await probeVideo(out);
    if (probe.duration && Math.abs(probe.duration - (duration - cut)) <= Math.max(2, duration * 0.02)) {
      trimmed = probe;
      break;
    }
  }
  if (!trimmed) {
    fs.rmSync(out, { force: true });
    throw new Error('the cut video came out the wrong length');
  }
  discard(video);
  fs.renameSync(out, video);
  const updated = { ...(readJson(sidecar) ?? meta), duration: trimmed.duration, start_trimmed: cut };
  updated.frame = (await halfwayFrame(updated.kind, video, trimmed.duration)) ?? updated.frame ?? null;
  writeJson(sidecar, updated);
  log(`✂ Cut ${formatDuration(cut * 1000)} of the room connecting from the start of "${name.slice(0, -'.json'.length)}" (the original went to the Trash)`);
}

// A TV episode's picture on the dashboard: a frame from halfway through it.
async function halfwayFrame(kind, file, duration) {
  if (kind !== 'tv' || !HAS_FFMPEG || !(duration > 0)) return null;
  return thumbs.fromVideo(file, duration, duration / 2).catch(() => null);
}

// Episodes saved before frames were taken (or whose frame went missing) get
// one: a single episode per check, so a big library doesn't all go at once.
const noFrame = new Set(); // recordings ffmpeg couldn't take a frame from
async function addMissingFrames() {
  for (const name of fs.readdirSync(opts.out)) {
    if (!name.endsWith('.json') || noFrame.has(name)) continue;
    const sidecar = path.join(opts.out, name);
    const meta = readJson(sidecar);
    if (meta?.version !== 1 || meta.status !== 'saved' || meta.kind !== 'tv' || !meta.file) continue;
    if (meta.frame && fs.existsSync(path.join(opts.out, THUMB_DIR, meta.frame))) continue;
    const video = path.join(opts.out, meta.file);
    const frame = fs.existsSync(video)
      ? await halfwayFrame('tv', video, meta.duration ?? (await probeVideo(video)).duration)
      : null;
    if (!frame) {
      noFrame.add(name);
      continue;
    }
    writeJson(sidecar, { ...(readJson(sidecar) ?? meta), frame });
    return;
  }
}

function logSaved(saved, converted) {
  log(converted
    ? `✓ Saved ${saved}`
    : `✓ Saved ${saved} (${HAS_FFMPEG ? 'conversion failed' : 'ffmpeg not found'}, kept the raw WebM)`);
}

// A recording cut short by a crash, logout or restart is still on disk as a raw
// .recording.webm; save it properly on the next start.
function recoverLeftovers() {
  for (const name of fs.readdirSync(opts.out)) {
    // A join or trim cut short; the recordings it was working from are still there.
    if (name.endsWith('.joining') || name.endsWith('.trimming')) fs.rmSync(path.join(opts.out, name), { force: true });
    if (!name.endsWith('.recording.webm')) continue;
    const base = name.slice(0, -'.recording.webm'.length);
    log(`Saving "${base}", left unfinished by an earlier run`);
    trackConversion(saveLeftover(base, path.join(opts.out, name), path.join(opts.out, `${base}.json`)));
  }
}

async function saveLeftover(name, rawPath, sidecarPath) {
  const raw = fs.statSync(rawPath);
  if (!raw.size) {
    fs.rmSync(rawPath, { force: true });
    fs.rmSync(sidecarPath, { force: true });
    return;
  }
  const cut = await leadIn(rawPath);
  const { saved, converted } = await convertRaw(rawPath, name, cut);
  const meta = readJson(sidecarPath);
  if (meta) {
    Object.assign(meta, await probeVideo(saved), {
      start_trimmed: converted ? cut : null,
      status: 'saved',
      file: path.basename(saved),
      ended_at: meta.ended_at ?? raw.mtime.toISOString(), // last data written
    });
    for (const pause of meta.pauses ?? []) pause.to ??= meta.ended_at; // cut short while paused
    if (!meta.thumbnail && HAS_FFMPEG) meta.thumbnail = await thumbs.fromVideo(saved, meta.duration);
    meta.frame ??= await halfwayFrame(meta.kind, saved, meta.duration);
    writeJson(sidecarPath, meta);
  }
  fs.rmSync(rawPath, { force: true });
  logSaved(saved, converted);
}

// Metadata next to each recording, read by the dashboard.
function writeSidecar(rec, part) {
  const e = rec.entry;
  writeJson(part.sidecarPath, {
    version: 1,
    status: part.status,
    file: part.file ?? null,
    title: titleOf(e),
    kind: e.kind ?? null,
    season: e.season ?? null,
    episode: e.episode ?? null,
    episode_name: e.episode_name || null,
    part: part.n,
    date: e.date ?? null,
    time: e.time ?? null,
    started_at: part.startedAt?.toISOString() ?? null,
    ended_at: part.endedAt?.toISOString() ?? null,
    duration: part.duration ?? null,
    width: part.width ?? null,
    height: part.height ?? null,
    url: rec.url,
    room: e.room ?? null,
    room_link: e.room_link ?? null,
    thumbnail: rec.thumbFile,
    frame: part.frame ?? null, // a TV episode's own picture: a frame from halfway through
    start_trimmed: part.startTrimmed ?? null, // seconds of the room connecting cut from the start
    thumbnail_url: e.thumbnail ?? null,
    log: rec.log,
    pauses: part.pauses,
  });
}

async function runFfmpeg(args) {
  const { code, stderr } = await run('ffmpeg', args);
  if (code !== 0) log(`  ffmpeg failed: ${stderr.trim().split('\n').slice(-2).join(' | ')}`);
  return code === 0;
}

function trackConversion(promise) {
  const job = promise.catch((err) => log(`✗ Saving failed: ${err.message}`));
  conversions.add(job);
  job.finally(() => conversions.delete(job));
}

async function shutdown() {
  if (shuttingDown) {
    log('Forced quit; unfinished recordings are left as .recording.webm files');
    clearStatus();
    process.exit(1);
  }
  shuttingDown = true;
  clearStatus();
  log('Shutting down (press Ctrl+C again to force quit)');
  await entryQueue(() => Promise.all([...active.values()].map((rec) => rec.stop('program stopped'))));
  if (conversions.size) log(`Waiting for ${conversions.size} recording(s) to finish saving`);
  await Promise.allSettled([...conversions]);
  await browser?.close().catch(() => {});
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Helpers

// Chrome only lets secure pages (https, or localhost) be captured. A room served
// over plain http from this Mac's own network address (like Screen Relay's
// http://10.0.0.122:8765/#tv=…) is opened through localhost instead: the same page.
function capturableUrl(url) {
  const link = new URL(url);
  const ownAddresses = Object.values(os.networkInterfaces()).flat().map((a) => a?.address);
  if (link.protocol === 'http:' && ownAddresses.includes(link.hostname)) link.hostname = 'localhost';
  return link.toString();
}

function titleOf(entry) {
  return String(entry.content || new URL(recordUrlOf(entry)).host);
}

function describe(entry) {
  let name = titleOf(entry);
  if (entry.season != null && entry.episode != null) {
    name += ` S${String(entry.season).padStart(2, '0')}E${String(entry.episode).padStart(2, '0')}`;
  }
  if (entry.episode_name) name += ` - ${entry.episode_name}`;
  const when = entry.date && entry.time ? `${entry.date} ${entry.time}` : localStamp(new Date());
  return `${name} (${when})`
    .replace(/:/g, '-')
    .replace(/[/\\*?"<>|\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

// The part number a new recording of this playback starts at. The name comes
// from the log entry, so files already there are this same playback recorded
// earlier (e.g. cut off by a restart): it carries on as the next part.
function nextPart(name) {
  const taken = (candidate) => usedNames.has(candidate)
    || ['mp4', 'webm', 'recording.webm', 'json'].some((ext) => fs.existsSync(path.join(opts.out, `${candidate}.${ext}`)));
  let n = 1;
  if (taken(name)) {
    n = 2;
    while (taken(`${name} (part ${n})`)) n++;
  }
  usedNames.add(n === 1 ? name : `${name} (part ${n})`);
  return n;
}

function localStamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}h ${m}m ${s}s` : m ? `${m}m ${s}s` : `${s}s`;
}

function serialQueue() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message) {
  console.log(`[${new Date().toLocaleTimeString('en-GB')}] ${message}`);
}

function fail(message) {
  console.error(`${message}\n${HELP}`);
  process.exit(1);
}

function parseArgs(argv) {
  const expandHome = (p) => p.replace(/^~(?=$|\/)/, os.homedir());
  const parsed = {
    log: null,
    out: path.join(__dirname, 'recordings'),
    format: 'mp4',
    size: '1280x720',
    interval: 1000,
    headless: false,
    audible: false,
    chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) fail(`${arg} needs a value`);
      return argv[++i];
    };
    switch (arg) {
      case '--log': parsed.log = expandHome(value()); break;
      case '--out': parsed.out = expandHome(value()); break;
      case '--format': parsed.format = value().toLowerCase(); break;
      case '--size': parsed.size = value(); break;
      case '--interval': parsed.interval = Number(value()); break;
      case '--chrome': parsed.chrome = expandHome(value()); break;
      case '--headless': parsed.headless = true; break;
      case '--audible': parsed.audible = true; break;
      case '-h': case '--help': console.log(HELP); process.exit(0); break;
      default: fail(`Unknown option: ${arg}`);
    }
  }

  const size = /^(\d+)x(\d+)$/.exec(parsed.size);
  if (!size) fail(`--size must look like 1280x720, got "${parsed.size}"`);
  if (!['mp4', 'webm'].includes(parsed.format)) fail(`--format must be mp4 or webm, got "${parsed.format}"`);
  if (!(parsed.interval >= 100)) fail('--interval must be at least 100 (milliseconds)');
  if (!fs.existsSync(parsed.chrome)) fail(`Chrome not found at ${parsed.chrome} (use --chrome <path>)`);

  return {
    ...parsed,
    log: parsed.log && expandPath(parsed.log),
    out: path.resolve(parsed.out),
    width: Number(size[1]),
    height: Number(size[2]),
  };
}

// ---------------------------------------------------------------------------

async function main() {
  // Two recorders would fight over the same Chrome profile and log.
  const other = recorderStatus();
  if (other.running) {
    console.log(`The recorder is already running (process ${other.pid}, watching ${other.watching}).`);
    console.log('If it was started automatically at login, stop it with: npm run autostart:off');
    process.exit(0); // not an error, so launchd doesn't keep retrying
  }

  fs.mkdirSync(opts.out, { recursive: true });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', (err) => log(`Unexpected error: ${err?.message ?? err}`));
  process.on('exit', clearStatus);

  if (opts.log) saveConfig({ log: opts.log });
  log(`Saving recordings to ${opts.out} as .${opts.format}`);
  if (!HAS_FFMPEG && opts.format === 'mp4') log('ffmpeg not found, recordings will be kept as .webm');
  setInterval(heartbeat, 5000).unref();
  heartbeat();
  recoverLeftovers();
  await getBrowser(); // open Chrome right away, so you can sign in to the site if it needs it
  await watchLog();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
