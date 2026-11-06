#!/usr/bin/env node
'use strict';

// Web dashboard for the recordings: browse, search and play them, copy a link
// to any one, choose which log file the recorder watches, and copy diagnostics.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const {
  THUMB_DIR, LOG_DIR, readLibrary, readJson, loadConfig, saveConfig, expandPath, recorderStatus,
  recordUrlOf, isHttpUrl, run, openPlays, episodeKey, leadIn, trashCardCopy, probeVideo, ThumbnailCache, writeJson,
} = require('./library');
const { pipeline } = require('stream/promises');

const HELP = `
Usage: node dashboard.js [options]

  --dir <dir>     Recordings folder (default: ./recordings)
  --port <port>   Port to serve on (default: 7777)
  --lan           Also allow other devices on your network to open it
  -h, --help      Show this help
`;

const opts = parseArgs(process.argv.slice(2));
const PUBLIC = path.join(__dirname, 'public');
const EXAMPLE = path.join(__dirname, 'example');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const server = http.createServer((req, res) => {
  Promise.resolve()
    .then(() => handle(req, res))
    .catch((err) => {
      console.error(err);
      if (!res.headersSent) send(res, 500, 'Something went wrong');
      else res.destroy();
    });
});

// The public link (Tailscale Funnel) comes in on its own port: the passcode first
// (remembered on that device), then everything the page does, the same as at home.
const GUEST_PORT = 7778;
const GUEST_FILE = path.join(__dirname, 'guest.json'); // { code, secret }
const GUEST_COOKIE = 'rec_guest';
const guestMisses = { count: 0, since: 0 };

function guestConfig() {
  let saved = readJson(GUEST_FILE);
  if (!saved?.secret) {
    saved = { code: saved?.code ?? '1234', secret: crypto.randomBytes(32).toString('hex') };
    fs.writeFileSync(GUEST_FILE, JSON.stringify(saved, null, 2), { mode: 0o600 });
  }
  return saved;
}
const guestToken = ({ code, secret }) => crypto.createHmac('sha256', secret).update(`guest:${code}`).digest('hex');
function guestIn(req) {
  const cookie = (req.headers.cookie ?? '').split(/;\s*/).find((c) => c.startsWith(`${GUEST_COOKIE}=`))?.slice(GUEST_COOKIE.length + 1) ?? '';
  const want = guestToken(guestConfig());
  return cookie.length === want.length && crypto.timingSafeEqual(Buffer.from(cookie), Buffer.from(want));
}

const GUEST_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#141414">
<title>Recordings</title><link rel="icon" href="/static/icon.svg" type="image/svg+xml">
<style>
*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:#141414;color:#fff;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:24px 16px calc(24px + env(safe-area-inset-bottom))}
form{width:min(100%,360px);display:grid;grid-template-columns:minmax(0,1fr);gap:14px;text-align:center}
.mark{width:56px;height:56px;margin:0 auto 6px;border-radius:14px;background:#e50914;display:grid;place-items:center}
.mark svg{width:26px;height:26px;fill:#fff}
h1{margin:0;font-size:26px;font-weight:800;letter-spacing:-.02em}p{margin:0;color:#b3b3b3}
input{width:100%;min-width:0;height:56px;padding:0 16px;font:600 24px/1 ui-monospace,Menlo,monospace;letter-spacing:.4em;text-align:center;color:#fff;background:#000;border:1px solid rgba(255,255,255,.3);border-radius:6px;outline:none}
input:focus{border-color:#fff}
button{width:100%;height:52px;font:700 17px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#000;background:#fff;border:0;border-radius:6px;cursor:pointer}
button:disabled{opacity:.6}.err{min-height:24px;color:#ff5a63;font-size:14px}
</style></head><body><main><form id="f">
<div class="mark"><svg viewBox="0 0 24 24"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z"/></svg></div>
<h1>Recordings</h1><p>Enter the passcode to watch.</p>
<input id="code" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="one-time-code" maxlength="12" size="6" aria-label="Passcode" autofocus>
<button id="go">Watch</button><div class="err" id="err" role="alert"></div>
</form></main><script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const go = document.getElementById('go'), err = document.getElementById('err');
  go.disabled = true; err.textContent = '';
  try {
    const r = await fetch('/api/guest-login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: document.getElementById('code').value.trim() }) });
    const d = await r.json().catch(() => ({}));
    if (r.ok) return location.reload();
    err.textContent = d.error || 'That passcode isn\u2019t right.';
  } catch { err.textContent = 'Couldn\u2019t reach the Mac.'; }
  go.disabled = false;
});
</script></body></html>`;

async function handleGuest(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/api/guest-login' && req.method === 'POST') {
    if (guestMisses.count >= 10 && Date.now() - guestMisses.since < 10 * 60_000) {
      return sendJson(res, { error: 'Too many wrong tries. Wait ten minutes and try again.' }, 429);
    }
    let code = '';
    try {
      code = String((await readBody(req)).code ?? '');
    } catch {}
    const config = guestConfig();
    if (code !== String(config.code)) {
      if (Date.now() - guestMisses.since > 10 * 60_000) Object.assign(guestMisses, { count: 0, since: Date.now() });
      guestMisses.count++;
      return sendJson(res, { error: 'That passcode isn\'t right.' }, 401);
    }
    res.setHeader('Set-Cookie', `${GUEST_COOKIE}=${guestToken(config)}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`);
    return sendJson(res, { ok: true });
  }
  if (pathname === '/api/guest-logout' && req.method === 'POST') {
    res.setHeader('Set-Cookie', `${GUEST_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
    return sendJson(res, { ok: true });
  }
  if (pathname === '/static/icon.svg') return handle(req, res, { guest: true });
  if (!guestIn(req)) {
    if (req.method === 'GET' && (pathname === '/' || pathname.startsWith('/watch/'))) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(GUEST_PAGE);
    }
    return send(res, 401, 'Passcode needed');
  }
  return handle(req, res, { guest: true });
}

async function handle(req, res, { guest = false } = {}) {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');
  if (pathname === '/api/settings' && req.method === 'POST') return updateSettings(req, res);
  if (pathname === '/api/delete' && req.method === 'POST') return deleteRecording(req, res);
  if (pathname === '/api/replay' && req.method === 'POST') return replayRecording(req, res);
  if (pathname === '/api/end' && req.method === 'POST') return endRecording(req, res);
  if (pathname === '/api/restart' && req.method === 'POST') return restartRecording(req, res);
  if (pathname === '/api/storage') return sendJson(res, storageBreakdown());
  if (pathname === '/api/catalog') return sendJson(res, showCatalog());
  if (pathname === '/api/vcr/episode' && req.method === 'POST') return requestEpisode(req, res);
  if (pathname === '/api/whole-show' && req.method === 'POST') return wholeShowRequest(req, res);
  if (pathname === '/api/storage/compress' && req.method === 'POST') return compressRequest(req, res);
  if (pathname === '/api/storage/empty-trash' && req.method === 'POST') return emptyCardTrash(req, res);
  if (pathname === '/api/storage/empty-mac-trash' && req.method === 'POST') return emptyMacTrash(req, res);
  if (pathname === '/api/vcr/request' && req.method === 'POST') return vcrRequest(req, res);
  if (pathname === '/api/vcr/choose' && req.method === 'POST') return vcrChoose(req, res);
  if (pathname === '/api/vcr/choices' || pathname === '/api/vcr/rooms') return vcrRead(req, res, pathname, searchParams);
  if (pathname === '/api/vcr/preview') return vcrPreview(req, res, searchParams);
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  let match;

  if (pathname === '/' || /^\/watch\/[a-f0-9]{12}$/.test(pathname)) {
    if (guest) {
      const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8').replace('<html lang="en">', '<html lang="en" data-guest>');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    return sendFile(req, res, path.join(PUBLIC, 'index.html'), { 'Cache-Control': 'no-cache' });
  }
  if ((match = /^\/static\/([\w-]+\.(?:css|js|svg))$/.exec(pathname))) {
    return sendFile(req, res, path.join(PUBLIC, match[1]), { 'Cache-Control': 'no-cache' });
  }
  if (pathname === '/api/library') {
    const recordings = readLibrary(opts.dir);
    const shown = onePerEpisode(stillInLog(recordings));
    const posterOf = showPosters(recordings);
    const items = shown.map(({ file, raw, log, ...item }) => ({
      ...item,
      // Never without a picture when one exists: its own, else its show's (another recording
      // of it, or the poster the phone page's search found).
      thumb: item.thumb ? `/thumbs/${item.thumb}` : posterOf(item.title),
      poster: posterOf(item.title), // the show's or movie's own, for its card
      frame: item.frame && `/thumbs/${item.frame}`,
      media: (file || raw) && `/media/${item.id}`,
      live: !file && Boolean(raw), // media is what's been recorded so far
      leadIn: !file && raw ? silentStarts.get(item.id) ?? 0 : 0, // its copy's room-connecting start, skipped when played
      format: file ? path.extname(file).slice(1) : raw && 'webm',
    }));
    dropOldPreviews(new Set(items.filter((it) => it.live).map((it) => it.id)));
    // A playing entry gets its own card only when there's no recording of that episode.
    const episodes = new Set(shown.map(episodeKey).filter(Boolean));
    const playing = unfinishedInLog(recordings).filter((it) => !episodes.has(episodeKey(it)));
    return sendJson(res, { items: [...items, ...playing] });
  }
  if (pathname === '/api/settings') return sendJson(res, settings());
  if (pathname === '/api/log') return sendJson(res, logPreview());
  if (pathname === '/api/diagnostics') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(diagnostics());
  }
  if ((match = /^\/media\/([a-f0-9]{12})$/.exec(pathname))) {
    const item = readLibrary(opts.dir).find((it) => it.id === match[1] && (it.file || it.raw));
    if (!item) return send(res, 404, 'Recording not found');
    if (!item.file) {
      // Still recording (or paused): a playable copy of what's there so far.
      const raw = path.join(opts.dir, item.raw);
      const file = await livePreview(item.id, raw, searchParams.get('at')).catch(() => raw);
      return sendFile(req, res, file, { 'Cache-Control': 'no-store' });
    }
    const download = searchParams.has('download') ? item.file : null;
    return sendFile(req, res, path.join(opts.dir, item.file), { 'Cache-Control': 'no-cache' }, download);
  }
  if ((match = /^\/hls\/([a-f0-9]{12})\/(index\.m3u8|s\d{5}\.ts)$/.exec(pathname))) {
    return sendStream(req, res, match[1], match[2]);
  }
  if ((match = /^\/thumbs\/([a-f0-9]{64}\.(?:jpg|png|gif|webp|avif))$/.exec(pathname))) {
    // Named after their content, so they never change and can be cached forever.
    return sendFile(req, res, path.join(opts.dir, THUMB_DIR, match[1]), {
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
  }
  if ((match = /^\/example\/([\w-]+\.(?:html|jpg))$/.exec(pathname))) {
    // The test room and art that the entries in example/log.json link to.
    return sendFile(req, res, path.join(EXAMPLE, match[1]), { 'Cache-Control': 'no-cache' });
  }
  return send(res, 404, 'Not found');
}

// How much room is left where recordings go: the SD card (where they end up) and this Mac
// (where each is written while it records). Bytes free and in all, or the card's not in.
function spaceLeft() {
  const of = (label, dir, note) => {
    try {
      const s = fs.statfsSync(dir);
      return { label, note, free: s.bavail * s.bsize, total: s.blocks * s.bsize };
    } catch {
      return { label, note, missing: true };
    }
  };
  return [
    of('SD card', CARD_DIR, 'where recordings are kept'),
    { ...of('This Mac', opts.dir, 'while something records'), trash: macTrashSize() },
  ];
}

// Which log the recorder watches, whether that file looks right, and whether
// the recorder is running.
function settings() {
  const { log } = loadConfig();
  let logInfo;
  try {
    const stat = fs.statSync(log);
    const data = readJson(log);
    logInfo = { exists: true, modified: stat.mtime.toISOString(), entries: Array.isArray(data) ? data.length : null };
  } catch {
    logInfo = { exists: false };
  }
  const status = recorderStatus();
  return {
    log,
    logInfo,
    recorder: {
      running: status.running,
      watching: status.running ? status.watching : null,
      startedAt: status.running ? status.started_at : null,
      recording: status.running ? status.recording ?? [] : [],
      paused: status.running ? status.paused ?? [] : [],
    },
    suggestions: jsonFilesNear(log),
    space: spaceLeft(),
  };
}

// A recording in progress is a raw WebM that's still being written, with no
// length or index, so players can't seek in it. To watch it so far, it's
// copied as it stands into a proper WebM (no re-encoding, so it takes seconds).
// The player asks for the file many times while playing, all with the same
// `at`; a new `at` (opening it, or Catch up) makes a fresh copy if more has
// been recorded since. Older copies are kept a while for players still reading them.
const PREVIEW_DIR = path.join(os.tmpdir(), 'recording-dashboard-previews');
const previews = new Map(); // recording id -> { at, size, ready: Promise<file> }
const silentStarts = new Map(); // recording id -> seconds before its first sound, skipped in its copies
fs.rmSync(PREVIEW_DIR, { recursive: true, force: true });

function livePreview(id, raw, at) {
  const size = fs.statSync(raw).size;
  const known = previews.get(id);
  if (known && (known.at === at || known.size === size)) return known.ready;
  fs.mkdirSync(PREVIEW_DIR, { recursive: true });
  const file = path.join(PREVIEW_DIR, `${id}-${Date.now()}.webm`);
  const ready = (async () => {
    // The whole file: the browser's recorder only writes a full picture at the very
    // start, so a copy can't be cut cleanly later on. The page skips the room-connecting
    // start (where the sound starts, like the saved recording; see leadIn) instead.
    if (!silentStarts.has(id)) {
      const cut = await leadIn(raw);
      if (cut) silentStarts.set(id, cut);
    }
    await run('ffmpeg', ['-nostdin', '-y', '-v', 'error', '-i', raw, '-c', 'copy', '-f', 'webm', file]);
    if (!(fs.statSync(file, { throwIfNoEntry: false })?.size > 0)) throw new Error('nothing to play yet');
    return file;
  })();
  ready.catch(() => previews.delete(id));
  previews.set(id, { at, size, ready });
  if (known) known.ready.then((old) => setTimeout(() => fs.rmSync(old, { force: true }), 120_000)).catch(() => {});
  return ready;
}

// iPhones (Safari) can't play the in-progress WebM (VP9 and Opus), so each
// recording in progress is also turned into a live HLS stream as it's recorded:
// H.264 and AAC from the Mac's hardware encoder, following the file as it grows
// (about seven times faster than real time until it has caught up). Safari plays
// HLS natively and keeps going as segments are added, so an iPhone watching it
// carries on into whatever has been recorded since by itself. It starts once the
// show's sound has (the same cut as the saved file, so times match when the
// saved file takes over), or after five minutes with no sound at all.
const HLS_DIR = path.join(os.tmpdir(), 'recording-dashboard-hls');
const streams = new Map(); // recording id -> { proc, dir, ended }
const starting = new Set();
try {
  // Leftovers from the last run (its encoders may still be writing a last segment or two).
  fs.rmSync(HLS_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch (err) {
  console.error(`Couldn't clear old live copies: ${err.message}`);
}

async function ensureStream(item) {
  const known = streams.get(item.id);
  if ((known && !known.ended) || starting.has(item.id) || !item.raw) return known;
  starting.add(item.id);
  try {
    const raw = path.join(opts.dir, item.raw);
    if (!silentStarts.has(item.id)) {
      const cut = await leadIn(raw);
      if (cut) silentStarts.set(item.id, cut);
      else if (Date.now() - Date.parse(item.startedAt) < 5 * 60_000) return null; // no sound yet
      else silentStarts.set(item.id, 0);
    }
    const cut = silentStarts.get(item.id);
    const dir = path.join(HLS_DIR, `${item.id}-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    const proc = spawn('ffmpeg', ['-nostdin', '-v', 'error',
      '-follow', '1', '-rw_timeout', String(30 * 60 * 1e6), '-i', `file:${raw}`, ...(cut ? ['-ss', String(cut)] : []),
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c:v', 'h264_videotoolbox', '-b:v', '5M', '-realtime', '0', '-force_key_frames', 'expr:gte(t,n_forced*2)',
      '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
      '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'event', '-hls_flags', 'independent_segments+temp_file',
      '-hls_segment_filename', path.join(dir, 's%05d.ts'), path.join(dir, 'index.m3u8')], { stdio: 'ignore' });
    const stream = { proc, dir, ended: false };
    proc.on('exit', () => { stream.ended = true; });
    if (known) setTimeout(() => fs.rmSync(known.dir, { recursive: true, force: true }), 120_000);
    streams.set(item.id, stream);
    return stream;
  } finally {
    starting.delete(item.id);
  }
}

// Every recording in progress gets its stream (ready before anyone opens it);
// a finished one's stream is stopped, its files kept a little for players still on it.
async function keepStreams() {
  const live = new Map(readLibrary(opts.dir).filter((it) => it.raw && (it.status === 'recording' || it.status === 'paused')).map((it) => [it.id, it]));
  for (const item of live.values()) await ensureStream(item).catch(() => {});
  for (const [id, stream] of streams) {
    if (live.has(id)) continue;
    streams.delete(id);
    if (!stream.ended) stream.proc.kill('SIGTERM');
    setTimeout(() => fs.rmSync(stream.dir, { recursive: true, force: true }), 120_000);
  }
}
setInterval(() => keepStreams().catch(() => {}), 10_000).unref?.();
keepStreams().catch(() => {});

async function sendStream(req, res, id, name) {
  let stream = streams.get(id);
  if (!stream) {
    const item = readLibrary(opts.dir).find((it) => it.id === id && it.raw);
    if (!item) return send(res, 404, 'Not recording');
    stream = await ensureStream(item);
  }
  // The playlist once it has a couple of segments (a few seconds after it starts).
  if (name === 'index.m3u8') {
    for (let i = 0; i < 40 && stream; i++) {
      let text = '';
      try {
        text = fs.readFileSync(path.join(stream.dir, name), 'utf8');
      } catch {}
      if ((text.match(/#EXTINF/g) ?? []).length >= 2) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!stream) return send(res, 503, 'Not ready yet');
  const file = path.join(stream.dir, name);
  if (!fs.existsSync(file)) return send(res, name === 'index.m3u8' ? 503 : 404, 'Not ready yet');
  if (name === 'index.m3u8') {
    // Served as a finished video of what's there so far, so every player can seek
    // all through it (a growing "live" playlist can't be seeked back in some). At
    // its end the page loads it again, with whatever has been added since.
    const text = fs.readFileSync(file, 'utf8').replace('#EXT-X-PLAYLIST-TYPE:EVENT', '#EXT-X-PLAYLIST-TYPE:VOD');
    const body = text.includes('#EXT-X-ENDLIST') ? text : `${text.trimEnd()}\n#EXT-X-ENDLIST\n`;
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }
  return sendFile(req, res, file, {
    'Content-Type': name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
    'Cache-Control': name.endsWith('.m3u8') ? 'no-store' : 'max-age=3600',
  });
}

// Recordings that have finished don't need their copies any more.
function dropOldPreviews(liveIds) {
  for (const [id, { ready }] of previews) {
    if (liveIds.has(id)) continue;
    previews.delete(id);
    silentStarts.delete(id);
    ready.then((file) => setTimeout(() => fs.rmSync(file, { force: true }), 120_000)).catch(() => {});
  }
}

// The watched log's text as it is right now, for the live preview (its end, if
// it's very long).
function logPreview() {
  const { log } = loadConfig();
  let stat;
  try {
    stat = fs.statSync(log);
  } catch {
    return { log, exists: false };
  }
  const max = 256 * 1024;
  return { log, exists: true, size: stat.size, modified: stat.mtime.toISOString(), truncated: stat.size > max, text: readTail(log, max) ?? '' };
}

// One card per episode (or movie): the recording still going (or saving) if
// there is one, otherwise the longest. The recorder deletes the shorter copies
// once nothing of that episode is still recording.
function onePerEpisode(recordings) {
  const best = new Map();
  const others = [];
  const better = (a, b) => (a.status !== 'saved') !== (b.status !== 'saved') ? a.status !== 'saved'
    : (a.duration ?? 0) > (b.duration ?? 0);
  for (const it of recordings) {
    const key = episodeKey(it);
    if (!key) others.push(it);
    else if (!best.has(key) || better(it, best.get(key))) best.set(key, it);
  }
  return [...others, ...best.values()];
}

// Recordings show only while their entry is still in the log they came from:
// one taken out of the log (e.g. with the VCR's Delete) disappears from the
// page, though its files stay. Recordings from before logs were noted are
// checked against the watched log. A log that can't be read hides nothing.
function stillInLog(recordings) {
  const watched = loadConfig().log;
  const logs = new Map(); // log file -> Set of "date time room_link", or null if it can't be read
  const entriesOf = (file) => {
    if (!logs.has(file)) {
      const entries = readJson(file);
      logs.set(file, Array.isArray(entries)
        ? new Set(entries.filter((e) => e && typeof e === 'object').map((e) => `${e.date} ${e.time} ${recordUrlOf(e)}`))
        : null);
    }
    return logs.get(file);
  };
  return recordings.filter((it) => {
    if (!it.date || !it.time || !it.url) return true; // not from a log entry
    const keys = entriesOf(it.log ?? watched);
    return !keys || keys.has(`${it.date} ${it.time} ${it.url}`);
  });
}

// Entries in the watched log that have started but not stopped, and that no
// recording covers: shown as in-progress cards, with why they aren't recording.
function unfinishedInLog(recordings) {
  const { log } = loadConfig();
  const entries = readJson(log);
  if (!Array.isArray(entries)) return [];

  const status = recorderStatus();
  const covered = new Set(recordings.filter((it) => it.status === 'recording' || it.status === 'paused').map((it) => it.url));
  const thumbIndex = readJson(path.join(opts.dir, THUMB_DIR, 'index.json')) ?? {};
  const items = [];
  for (const [url, { entry, pause }] of openPlays(entries)) {
    if (covered.has(url)) continue;
    const pausedAt = pause ? when(pause) : null;
    const [why, note] = !status.running ? ['Not recording: recorder is off', 'The recorder isn\'t running.']
      : status.watching !== log ? ['Not recording yet', 'The recorder is switching to this log.']
      : !isHttpUrl(url) ? ['Can\'t record it', 'The entry has no room_link to open.']
      : status.problems?.[url] ? ['Couldn\'t record it: trying every minute',
        `The recorder couldn't open the room: ${status.problems[url]}. It tries again every minute while the log says it's playing.`]
      : pausedAt ? ['Paused: records when it plays again', 'Nothing is playing right now. Recording starts when it plays again.']
      : ['Starting to record…', 'The recorder is opening the room.'];
    const title = String(entry.content || url || 'Untitled');
    const cached = thumbIndex[entry.thumbnail]?.[title];
    const thumb = cached && fs.existsSync(path.join(opts.dir, THUMB_DIR, cached)) ? `/thumbs/${cached}`
      : savedPoster(title) ? `/thumbs/${savedPoster(title).file}` : isHttpUrl(entry.thumbnail) ? entry.thumbnail : null;
    items.push({
      id: crypto.createHash('sha1').update(`log\n${url}\n${entry.date}\n${entry.time}`).digest('hex').slice(0, 12),
      status: 'log',
      playing: pausedAt ? 'paused' : 'playing',
      why,
      note,
      title,
      kind: entry.kind ?? null,
      season: entry.season ?? null,
      episode: entry.episode ?? null,
      episodeName: entry.episode_name || null,
      part: 1,
      date: entry.date ?? null,
      time: entry.time ?? null,
      startedAt: when(entry),
      endedAt: null, duration: null, width: null, height: null, size: null,
      url,
      room: entry.room ?? null,
      thumb,
      media: null,
      format: null,
      pauses: 0, pausedSeconds: 0, pausedAt,
    });
  }
  return items;
}

function when(entry) {
  const date = new Date(`${entry.date}T${entry.time || '00:00:00'}`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// Everything useful for working out what went wrong, as plain text to paste
// into a message: versions, the recorder's state, the watched log, the
// recordings folder and the latest lines of each program's log.
function diagnostics() {
  const now = new Date();
  const out = [];
  const section = (title) => out.push('', `## ${title}`);
  const ago = (iso) => {
    const ms = now - Date.parse(iso);
    return Number.isFinite(ms) ? `${age(ms / 1000)} ago` : '?';
  };

  const pkg = readJson(path.join(__dirname, 'package.json')) ?? {};
  out.push(`Recording diagnostics, ${now.toLocaleString('en-GB')} (${now.toISOString()})`);
  out.push(`App: ${pkg.name} ${pkg.version} · Node ${process.version} · macOS ${command('sw_vers', ['-productVersion']) || '?'} (${os.arch()})`);
  out.push(`Dashboard: http://localhost:${opts.port}${opts.lan ? ', also on the network' : ''} · process ${process.pid} · up ${age(process.uptime())}`);
  const ffmpeg = command('ffmpeg', ['-version']).split(' ')[2];
  const chrome = command('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '/Applications/Google Chrome.app/Contents/Info.plist']);
  out.push(`Tools: ffmpeg ${ffmpeg || 'NOT FOUND'} · ffprobe ${command('ffprobe', ['-version']) ? 'ok' : 'NOT FOUND'} · Chrome ${chrome || 'NOT FOUND in /Applications'}`);
  try {
    const disk = fs.statfsSync(opts.dir);
    out.push(`Disk: ${bytes(disk.bavail * disk.bsize)} free where recordings are saved`);
  } catch {}

  section('Recorder');
  const status = recorderStatus();
  if (status.running) {
    out.push(`Running: yes · process ${status.pid} · started ${ago(status.started_at)} · last heartbeat ${ago(status.heartbeat)}`);
    out.push(`Watching: ${status.watching}`);
    out.push(`Recording: ${status.recording?.length ? status.recording.join(' | ') : 'nothing'}`);
    if (status.paused?.length) out.push(`Paused: ${status.paused.join(' | ')}`);
  } else {
    out.push(`Running: NO${status.heartbeat ? ` (last heartbeat ${ago(status.heartbeat)}, process ${status.pid})` : ''}`);
  }
  out.push(`config.json: ${JSON.stringify(readJson(path.join(__dirname, 'config.json')))}`);
  for (const label of ['com.recording.recorder', 'com.recording.dashboard']) {
    const info = command('launchctl', ['print', `gui/${process.getuid()}/${label}`]);
    const pid = /^\s*pid = (\d+)/m.exec(info)?.[1];
    const lastExit = /last exit code = (.+)/.exec(info)?.[1];
    out.push(`Background ${label.split('.').pop()}: ${!info ? 'not set up (npm run autostart:on)' : pid ? `running (process ${pid})` : 'NOT running'}${lastExit ? ` · last exit: ${lastExit}` : ''}`);
  }

  const { log } = loadConfig();
  section(`Watched log: ${log}`);
  try {
    const stat = fs.statSync(log);
    const data = readJson(log);
    out.push(`${Array.isArray(data) ? `${data.length} entries` : 'NOT a JSON list right now'} · ${bytes(stat.size)} · changed ${ago(stat.mtime.toISOString())}`);
    if (Array.isArray(data)) {
      if (data.length > 12) out.push(`(last 12 of ${data.length})`);
      for (const entry of data.slice(-12)) out.push(JSON.stringify(entry));
    }
  } catch (err) {
    out.push(`Can't read it: ${err.code === 'ENOENT' ? 'the file does not exist' : err.message}`);
  }

  section(`Recordings: ${opts.dir}`);
  const items = readLibrary(opts.dir);
  const count = (status) => items.filter((it) => it.status === status).length;
  let names = [];
  try {
    names = fs.readdirSync(opts.dir);
  } catch {}
  let thumbs = [];
  try {
    thumbs = fs.readdirSync(path.join(opts.dir, THUMB_DIR)).filter((n) => n !== 'index.json');
  } catch {}
  out.push(`${count('saved')} saved · ${count('recording')} recording · ${count('paused')} paused · ${count('saving')} saving · ${thumbs.length} thumbnail images`);
  for (const name of names.filter((n) => n.endsWith('.recording.webm'))) {
    const stat = fs.statSync(path.join(opts.dir, name));
    out.push(`In-progress data: ${name} · ${bytes(stat.size)} · last written ${ago(stat.mtime.toISOString())}`);
  }
  const newest = items.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, 15);
  if (newest.length) out.push(`Newest ${newest.length}:`);
  for (const it of newest) {
    const code = it.season != null && it.episode != null ? ` S${it.season}E${it.episode}` : '';
    out.push([
      `  ${it.status}: ${it.title}${code}${it.episodeName ? ` - ${it.episodeName}` : ''}${it.part > 1 ? ` (part ${it.part})` : ''}`,
      it.duration != null ? `${Math.round(it.duration)}s` : null,
      it.size != null ? bytes(it.size) : null,
      it.thumb ? 'thumbnail ok' : 'no thumbnail',
      it.pauses ? `${it.pauses} pause(s), ${it.pausedSeconds}s left out` : null,
      it.startedAt ? `started ${it.startedAt}` : null,
    ].filter(Boolean).join(' · '));
  }

  for (const [file, lines] of [['recorder.out.log', 120], ['recorder.err.log', 40], ['dashboard.out.log', 30], ['dashboard.err.log', 30]]) {
    const full = path.join(LOG_DIR, file);
    section(`${file} (last ${lines} lines) ${full}`);
    out.push(...(tailLines(full, lines) ?? ['(no such file; only written when running in the background)']));
  }
  return `${out.join('\n')}\n`;
}

// A command's output, or '' if it couldn't run.
function command(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', timeout: 3000 });
  return result.status === 0 ? String(result.stdout).trim() : '';
}

function tailLines(file, count) {
  return readTail(file, 256 * 1024)?.trimEnd().split('\n').slice(-count) ?? null;
}

// The last `max` bytes of a file as text (all of it if it's smaller), or null.
function readTail(file, max) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, max);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    return buf.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function age(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor(s / 3600) % 24}h`;
}

function bytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i && n < 10 ? 1 : 0)} ${units[i]}`;
}

// .json files on the Desktop and next to the current log, newest first.
function jsonFilesNear(current) {
  const dirs = new Set([path.join(os.homedir(), 'Desktop'), path.dirname(current)]);
  const found = new Map();
  for (const dir of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.json')) continue;
      const file = path.join(dir, name);
      try {
        const stat = fs.statSync(file);
        if (stat.isFile()) found.set(file, stat.mtimeMs);
      } catch {}
    }
  }
  return [...found].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([file]) => file);
}

// Only this computer may change things, and only via the page's JSON request
// (other websites can't send that to localhost without CORS). This Mac's own
// network addresses count too (opening it as http://10.0.0.122:7777 here), and
// so does Tailscale, which arrives from this Mac.
function fromThisComputer(req) {
  const own = Object.values(os.networkInterfaces()).flat().flatMap((a) => (a ? [a.address, `::ffff:${a.address}`] : []));
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1', ...own].includes(req.socket.remoteAddress);
  const origin = req.headers.origin;
  let sameOrigin = !origin;
  try {
    sameOrigin ||= new URL(origin).host === req.headers.host;
  } catch {}
  return local && sameOrigin;
}

// Delete and the + (play something on the VCR): this computer, or a device on the
// home Wi-Fi or the tailnet (the page is open to those already), from this page.
function fromHomeDevice(req) {
  const ip = String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  const home = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|127\.)/.test(ip)
    || ip === '::1' || /^fd7a:115c:a1e0:/i.test(ip);
  const origin = req.headers.origin;
  let sameOrigin = !origin;
  try {
    sameOrigin ||= new URL(origin).host === req.headers.host;
  } catch {}
  return home && sameOrigin && /^application\/json\b/.test(req.headers['content-type'] ?? '');
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 10_000) throw new Error('too large');
  }
  return JSON.parse(body);
}

async function updateSettings(req, res) {
  if (!fromThisComputer(req)) return sendJson(res, { error: 'Settings can only be changed on this computer.' }, 403);
  if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) return sendJson(res, { error: 'Expected JSON.' }, 415);

  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 10_000) return sendJson(res, { error: 'Request too large.' }, 413);
  }
  let log;
  try {
    log = JSON.parse(body).log;
  } catch {
    return sendJson(res, { error: 'Expected JSON.' }, 400);
  }
  if (typeof log !== 'string' || !log.trim()) return sendJson(res, { error: 'Enter the path of a .json file.' }, 400);

  const file = expandPath(log);
  if (!file.toLowerCase().endsWith('.json')) return sendJson(res, { error: 'Pick a .json file.' }, 400);
  if (fs.existsSync(file) && !fs.statSync(file).isFile()) return sendJson(res, { error: 'That path is a folder, not a file.' }, 400);

  saveConfig({ log: file });
  console.log(`Watched log changed to ${file}`);
  return sendJson(res, settings());
}

// Serves a file, with Range support so videos can be seeked.
function sendFile(req, res, file, headers = {}, downloadName = null) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return send(res, 404, 'Not found');
  }
  if (!stat.isFile()) return send(res, 404, 'Not found');

  const head = {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Last-Modified': stat.mtime.toUTCString(),
    ...headers,
  };
  if (downloadName) head['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`;

  let start = 0;
  let end = stat.size - 1;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), stat.size - 1);
    } else {
      start = Math.max(0, stat.size - Number(range[2])); // "bytes=-500": the last 500 bytes
    }
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
  } else {
    res.writeHead(200, { ...head, 'Content-Length': stat.size });
  }

  if (req.method === 'HEAD' || stat.size === 0) return res.end();
  fs.createReadStream(file, { start, end })
    .on('error', () => res.destroy())
    .pipe(res);
}

// Delete: a saved recording (every part of that play) goes to the Trash, and the
// play comes out of the VCR's History too (the site-search helper takes it out
// of the watch log, which also keeps the Desktop copies this app reads in step).
const VCR = 'http://127.0.0.1:8766';
async function deleteRecording(req, res) {
  if (!fromHomeDevice(req)) return sendJson(res, { error: 'Recordings can only be deleted from this page.' }, 403);
  let id;
  try {
    id = String((await readBody(req)).id);
  } catch {
    return sendJson(res, { error: 'Expected JSON.' }, 400);
  }
  const item = readLibrary(opts.dir).find((it) => it.id === id);
  if (!item) return sendJson(res, { error: 'That recording isn\'t here any more.' }, 404);
  if (item.status !== 'saved') return sendJson(res, { error: 'It\'s still recording. It can be deleted once it\'s saved.' }, 409);
  return sendJson(res, { ok: true, ...(await removeRecording(item)) });
}

// Replay: the recording (and its play in the VCR's History) is deleted as above,
// then the VCR plays that same episode (or movie) again from the start, in a room
// of its own, so it's recorded afresh.
async function replayRecording(req, res) {
  if (!fromHomeDevice(req)) return sendJson(res, { error: 'Replay only works from this page.' }, 403);
  let id;
  try {
    id = String((await readBody(req)).id);
  } catch {
    return sendJson(res, { error: 'Expected JSON.' }, 400);
  }
  const item = readLibrary(opts.dir).find((it) => it.id === id);
  if (!item) return sendJson(res, { error: 'That recording isn\'t here any more.' }, 404);
  if (item.status !== 'saved') return sendJson(res, { error: 'It\'s still recording. It can be replayed once it\'s saved.' }, 409);
  try {
    const room = await freeVcrRoom();
    if (!room) return sendJson(res, { error: 'Couldn\'t find a free room.' }, 503);
    const removed = await removeRecording(item);
    const run = await vcr('/replay', { title: item.title, room, season: item.season, episode: item.episode });
    if (run.status !== 200) return sendJson(res, { error: `Deleted, but the VCR couldn't play it again: ${run.body.error ?? 'it refused'}`, removed }, 502);
    return sendJson(res, { ok: true, pid: run.body.pid, room, removed });
  } catch {
    return sendJson(res, { error: 'Can\'t reach the VCR on the Mac.' }, 502);
  }
}

// End (on a recording in progress): the VCR stops its room and forgets the play, which
// takes it out of History; the recorder then stops and drops the recording, since its
// entry is gone from the log (and this page stops listing it right away).
async function endRecording(req, res) {
  if (!fromHomeDevice(req)) return sendJson(res, { error: 'End only works from this page.' }, 403);
  let id;
  try {
    id = String((await readBody(req)).id);
  } catch {
    return sendJson(res, { error: 'Expected JSON.' }, 400);
  }
  const item = readLibrary(opts.dir).find((it) => it.id === id);
  if (!item) return sendJson(res, { error: 'That recording isn\'t here any more.' }, 404);
  if (!item.room) return sendJson(res, { error: 'This recording doesn\'t say which room it\'s from.' }, 409);
  try {
    const r = await vcr('/stop', { room: item.room, forget: true });
    if (r.status !== 200) return sendJson(res, { error: r.body.error ?? 'The VCR refused it.' }, 502);
    console.log(`Ended room ${item.room} (${item.title} ${item.date} ${item.time}) from Recordings`);
    return sendJson(res, { ok: true, room: item.room });
  } catch {
    return sendJson(res, { error: 'Can\'t reach the VCR on the Mac.' }, 502);
  }
}

// Finished recordings go to the SD card: the recorder writes each one on this Mac (fast, and
// safe if the card is out), and once it's saved its video is moved to the card, one at a time,
// leaving a link in its place, so everything here works the same. Copied in 8 MB pieces (the
// system's fast copy hangs on the card's ExFAT), its size checked, then removed from the Mac.
// With the card out, recordings stay on the Mac and move once it's back.
const CARD_DIR = '/Volumes/Untitled/Recordings';
let movingToCard = false;
async function moveToCard() {
  if (movingToCard || !fs.existsSync(CARD_DIR)) return;
  movingToCard = true;
  try {
    for (const it of readLibrary(opts.dir)) {
      if (it.status !== 'saved' || !it.file) continue;
      const src = path.join(opts.dir, it.file);
      const stat = fs.lstatSync(src, { throwIfNoEntry: false });
      if (!stat?.isFile()) continue; // already a link to the card
      const dst = path.join(CARD_DIR, it.file);
      try {
        await pipeline(fs.createReadStream(src, { highWaterMark: 8 << 20 }), fs.createWriteStream(`${dst}.part`));
        if (fs.statSync(`${dst}.part`).size !== stat.size) throw new Error('sizes differ');
        fs.renameSync(`${dst}.part`, dst);
        fs.unlinkSync(src);
        fs.symlinkSync(dst, src);
        console.log(`Moved ${it.file} to the SD card (${(stat.size / 1e9).toFixed(2)} GB)`);
      } catch (err) {
        fs.rmSync(`${dst}.part`, { force: true });
        console.log(`Couldn't move ${it.file} to the SD card (${err.message}); it stays on the Mac for now`);
        return;
      }
    }
  } finally {
    movingToCard = false;
  }
}
setInterval(() => moveToCard().catch(() => {}), 2 * 60_000).unref?.();

// Show and movie posters, kept on this Mac: thumbnails/shows.json says which saved picture is
// which title's poster ({"<title, normalised>": {title, file, url}}), and the pictures are in
// thumbnails/ like the recordings' own. A title's poster is the one the VCR logged with its
// recordings (thumbnails/index.json), else the one the phone page's search found for it, which
// is downloaded here. Once a title has one it stays; pages never load a poster from the web.
const POSTER_FILE = path.join(opts.dir, THUMB_DIR, 'shows.json');
const posterCache = new ThumbnailCache(path.join(opts.dir, THUMB_DIR));
posterCache.indexPath = path.join(opts.dir, THUMB_DIR, 'poster-index.json'); // not the recorder's index
posterCache.index = readJson(posterCache.indexPath) ?? {};
let posters = readJson(POSTER_FILE) ?? {};
function savedPoster(title) {
  const known = posters[normTitle(title)];
  return known && fs.existsSync(path.join(opts.dir, THUMB_DIR, known.file)) ? known : null;
}
async function keepPoster(title, url) {
  if (!title || !isHttpUrl(url) || savedPoster(title)) return;
  try {
    const file = await posterCache.get(url, title);
    if (!file || savedPoster(title)) return;
    posters = { ...(readJson(POSTER_FILE) ?? {}), [normTitle(title)]: { title, file, url } };
    writeJson(POSTER_FILE, posters);
    console.log(`Saved the poster for ${title}`);
  } catch (err) {
    console.error(`Couldn't download the poster for ${title}: ${err.message}`);
  }
}
async function updatePosters() {
  const recordings = readLibrary(opts.dir);
  const titles = new Set(recordings.map((it) => normTitle(it.title)));
  // The VCR's posters for recorded titles, already downloaded by the recorder.
  const logged = readJson(path.join(opts.dir, THUMB_DIR, 'index.json')) ?? {};
  let changed = false;
  for (const [url, byTitle] of Object.entries(logged)) {
    for (const [title, file] of Object.entries(byTitle ?? {})) {
      if (!isHttpUrl(url) || /^https?:\/\/(localhost|127\.)/.test(url) || savedPoster(title)) continue;
      if (!fs.existsSync(path.join(opts.dir, THUMB_DIR, file))) continue;
      posters[normTitle(title)] = { title, file, url };
      changed = true;
    }
  }
  if (changed) writeJson(POSTER_FILE, posters);
  // Recorded titles still without one: the poster the phone page's search found.
  const catalog = readJson(CATALOG_FILE) ?? {};
  for (const results of Object.values(catalog.searches ?? {})) {
    for (const r of Array.isArray(results) ? results : []) {
      if (titles.has(normTitle(r?.title)) && !savedPoster(r.title)) await keepPoster(r.title, r.poster);
    }
  }
}
setTimeout(() => updatePosters().catch(() => {}), 5_000).unref?.();
setInterval(() => updatePosters().catch(() => {}), 5 * 60_000).unref?.();

// A show's (or movie's) picture by title: its saved poster, else a picture a recording of it
// has. Null when there's none anywhere.
function showPosters(recordings) {
  const byTitle = new Map();
  for (const it of recordings) if (it.thumb && !byTitle.has(normTitle(it.title))) byTitle.set(normTitle(it.title), `/thumbs/${it.thumb}`);
  return (title) => {
    const poster = savedPoster(title);
    return poster ? `/thumbs/${poster.file}` : byTitle.get(normTitle(title)) ?? null;
  };
}

// ---------------------------------------------------------------------------
// Whole shows: every season and episode a show has (as the phone page last found them on the
// site, in site-search's show-catalog.json), so the page can list the ones not recorded too.

const CATALOG_FILE = path.join(os.homedir(), 'Desktop', 'site-search', 'show-catalog.json');
const normTitle = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function showCatalog() {
  const catalog = readJson(CATALOG_FILE) ?? {};
  const shows = catalog.shows ?? {};
  // A show's title -> its page on the site, from the searches' results.
  const pages = new Map();
  for (const results of Object.values(catalog.searches ?? {})) {
    for (const r of Array.isArray(results) ? results : []) {
      if (r?.kind === 'tv' && r.href && shows[r.href] && !pages.has(normTitle(r.title))) pages.set(normTitle(r.title), r.href);
    }
  }
  const out = {};
  const needed = [];
  for (const title of new Set(readLibrary(opts.dir).filter((it) => it.kind === 'tv').map((it) => it.title))) {
    const url = pages.get(normTitle(title));
    const show = shows[url];
    if (!show) continue;
    const episodes = {};
    for (const [season, list] of Object.entries(show.episodes ?? {})) {
      // "Season 1 · Episode 3: Name" -> [3, "Name"]
      episodes[season] = (list ?? []).map(([n, label]) => [n, String(label ?? '').split(':').slice(1).join(':').trim()]);
    }
    const seasons = (show.seasons ?? []).map(([n]) => n).filter((n) => Number.isFinite(n));
    if (needsLookup(show)) needed.push(url);
    const lookup = lookups.state.get(url);
    out[title] = { url, seasons, episodes, poster: showPosters(readLibrary(opts.dir))(title),
      looking: needed.includes(url) && !lookup?.failed, lookupFailed: Boolean(lookup?.failed) };
    if (wholeShows[title]) {
      const p = wholeShowProgress(title, out);
      const want = wholeShows[title];
      out[title].whole = { recorded: p.recorded, total: p.total, left: p.missing.length, skipped: p.skipped.length,
        done: Boolean(want.done), waiting: want.waiting ?? null, room: want.room ?? null,
        next: p.missing.find(([s, e]) => !p.going.has(`${s}|${e}`)) ?? null, asked: want.asked ?? null,
        now: [...p.going.values()].filter((it) => it.room === want.room).map((it) => [it.season, it.episode])[0] ?? null };
    }
  }
  lookUpEpisodes(needed);
  return out;
}

// Episode lookups: a season whose episodes aren't all known (none saved yet, or a list saved
// while playing, which stops at the page's "Show more") is read from the site straight away by
// site-search's lookup_episodes.py, in the VCR's hidden Chrome, one show at a time. The latest
// season is read again once a day, for its new episodes. A show it couldn't read is tried again
// 10 minutes later.
const LOOKUP_SCRIPT = path.join(os.homedir(), 'Desktop', 'site-search', 'lookup_episodes.py');
const PYTHON = ['/Library/Frameworks/Python.framework/Versions/3.14/bin/python3', '/opt/homebrew/bin/python3']
  .find((p) => fs.existsSync(p)) ?? 'python3';
const lookups = { running: null, state: new Map() }; // show url -> {at, failed}
function needsLookup(show) {
  const seasons = (show.seasons ?? []).map(([n]) => n).filter((n) => Number.isFinite(n));
  if (!seasons.length) return true;
  // Read in full before ({at, count}) and its saved list still has every one of them.
  const whole = show.whole ?? {};
  const isWhole = (n) => typeof whole[n] === 'object' && (show.episodes?.[n]?.length ?? 0) >= whole[n].count;
  const latest = Math.max(...seasons);
  return seasons.some((n) => !isWhole(n)) || Date.now() / 1000 - (whole[latest]?.at ?? 0) > 24 * 3600;
}
function lookUpEpisodes(urls) {
  if (lookups.running || !fs.existsSync(LOOKUP_SCRIPT)) return;
  const url = urls.find((u) => {
    const last = lookups.state.get(u);
    return !last || Date.now() - last.at > 10 * 60_000;
  });
  if (!url) return;
  lookups.running = url;
  lookups.state.set(url, { at: Date.now(), failed: lookups.state.get(url)?.failed ?? false });
  console.log(`Looking up the episodes of ${url}`);
  const proc = spawn(PYTHON, [LOOKUP_SCRIPT, url], { cwd: path.dirname(LOOKUP_SCRIPT), stdio: ['ignore', 'pipe', 'pipe'] });
  let said = '';
  proc.stdout.on('data', (d) => { said += d; });
  proc.stderr.on('data', (d) => { said += d; });
  const timer = setTimeout(() => proc.kill(), 10 * 60_000);
  proc.on('close', (code) => {
    clearTimeout(timer);
    lookups.running = null;
    lookups.state.set(url, { at: Date.now(), failed: code !== 0 });
    console.log(`Episode lookup ${code === 0 ? 'done' : 'failed'} for ${url}: ${said.trim().split('\n').slice(-3).join(' / ')}`);
    showCatalog(); // the next show that needs it
  });
}
setInterval(() => { try { showCatalog(); } catch {} }, 5 * 60_000).unref?.();
setTimeout(() => { try { showCatalog(); } catch {} }, 15_000).unref?.();

// Request (an episode not recorded yet): the VCR plays it in a room of its own, recorded as usual.
async function requestEpisode(req, res) {
  if (!fromHomeDevice(req)) return sendJson(res, { error: 'Requests can only be made from this page.' }, 403);
  let ask;
  try {
    const body = await readBody(req);
    ask = { title: String(body.title ?? '').trim(), season: Number(body.season) || null, episode: Number(body.episode) || null };
  } catch {
    return sendJson(res, { error: 'Expected JSON.' }, 400);
  }
  if (!ask.title || !ask.season || !ask.episode) return sendJson(res, { error: 'Which episode?' }, 400);
  try {
    const room = await freeVcrRoom();
    if (!room) return sendJson(res, { error: 'Couldn\'t find a free room.' }, 503);
    const run = await vcr('/replay', { ...ask, room });
    if (run.status !== 200) return sendJson(res, { error: run.body.error ?? 'The VCR refused it.' }, 502);
    console.log(`Requested ${ask.title} S${ask.season}E${ask.episode} in room ${room}`);
    return sendJson(res, { ok: true, pid: run.body.pid, room });
  } catch {
    return sendJson(res, { error: 'Can\'t reach the VCR on the Mac.' }, 502);
  }
}

// Whole shows: "Record every episode" keeps one room of its own playing the show's missing
// episodes, in order, until every episode the site lists has a recording. The room carries on
// to the next episode by itself; when that one's already recorded, it's sent to the next
// missing one instead. An episode that won't play after 3 tries is skipped (and shown as such).
// Two shows at a time; others wait their turn. New episodes stop starting while the SD card has
// less than 20 GB free. What's recorded this way is compressed once saved, so whole shows fit.
// State in recordings/whole-shows.json: {title: {room, since, tries: {"s|e": n}, skipped: ["s|e"], requestedAt, asked}}.
const WHOLE_FILE = path.join(opts.dir, 'whole-shows.json');
const WHOLE_AT_ONCE = 2;
const WHOLE_MIN_FREE = 20e9;
let wholeShows = readJson(WHOLE_FILE) ?? {};
const saveWhole = () => writeJson(WHOLE_FILE, wholeShows);

function wholeShowProgress(title, catalog = showCatalog(), recordings = readLibrary(opts.dir)) {
  const show = catalog[title];
  const want = wholeShows[title];
  const all = [];
  for (const season of [...(show?.seasons ?? [])].sort((a, b) => a - b)) {
    for (const [n] of [...(show.episodes?.[season] ?? [])].sort(([a], [b]) => a - b)) all.push([season, n]);
  }
  const saved = new Set(), going = new Map();
  for (const it of recordings) {
    if (it.title !== title || it.kind !== 'tv' || it.season == null || it.episode == null) continue;
    const key = `${it.season}|${it.episode}`;
    // Recorded: saved (or saving) and not just a few minutes of it (an episode cut short).
    if ((it.status === 'saved' && (it.duration ?? 0) >= 300 && !it.incomplete) || it.status === 'saving') saved.add(key);
    else if (it.status === 'recording' || it.status === 'paused') going.set(key, it);
  }
  const skipped = new Set(want?.skipped ?? []);
  const missing = all.filter(([s, e]) => !saved.has(`${s}|${e}`) && !skipped.has(`${s}|${e}`));
  return { total: all.length, recorded: all.filter(([s, e]) => saved.has(`${s}|${e}`)).length, missing, saved, going,
    skipped: [...skipped], known: all.length > 0 };
}

async function wholeShowRequest(req, res) {
  if (!fromHomeDevice(req)) return sendJson(res, { error: 'Requests can only be made from this page.' }, 403);
  let body;
  try {
    body = await readBody(req);
  } catch {
    return sendJson(res, { error: 'Expected JSON.' }, 400);
  }
  const title = String(body.title ?? '').trim();
  if (!title || !showCatalog()[title]) return sendJson(res, { error: 'That show isn\'t here.' }, 404);
  if (body.stop) {
    const want = wholeShows[title];
    delete wholeShows[title];
    saveWhole();
    // Its room stops too, unless it's partway through an episode (that one finishes and saves).
    if (want?.room && !readLibrary(opts.dir).some((it) => it.room === want.room && isRecordingStatus(it))) {
      vcr('/stop', { room: want.room }).catch(() => {});
    }
    console.log(`Stopped recording every episode of ${title}`);
    return sendJson(res, { ok: true });
  }
  wholeShows[title] ??= { since: new Date().toISOString(), tries: {}, skipped: [] };
  saveWhole();
  console.log(`Recording every episode of ${title}`);
  wholeShowTick().catch((err) => console.error(err));
  return sendJson(res, { ok: true });
}
const isRecordingStatus = (it) => it.status === 'recording' || it.status === 'paused';

let wholeTicking = false;
async function wholeShowTick() {
  if (wholeTicking || !Object.keys(wholeShows).length) return;
  wholeTicking = true;
  try {
    const catalog = showCatalog();
    const recordings = readLibrary(opts.dir);
    let free = Infinity;
    try {
      const st = fs.statfsSync(CARD_DIR);
      free = st.bavail * st.bsize;
    } catch {}
    let active = 0;
    for (const [title, want] of Object.entries(wholeShows)) {
      const p = wholeShowProgress(title, catalog, recordings);
      if (!p.known) continue; // its episodes are still being looked up
      // Compress what this has recorded, once saved (on the card or not).
      for (const it of recordings) {
        if (it.title === title && it.status === 'saved' && !it.compressed && !compressJobs.has(it.id)
            && Date.parse(it.startedAt ?? 0) >= Date.parse(want.since)) {
          compressJobs.set(it.id, { state: 'queued', progress: 0, auto: true });
          runCompressQueue().catch((err) => console.error(err));
        }
      }
      if (!p.missing.length) {
        if (!want.done) {
          want.done = new Date().toISOString();
          saveWhole();
          console.log(`Every episode of ${title} is recorded`);
        }
        continue;
      }
      want.done = null;
      const inRoom = want.room ? recordings.find((it) => it.room === want.room && isRecordingStatus(it)) : null;
      if (inRoom && inRoom.title === title && !p.saved.has(`${inRoom.season}|${inRoom.episode}`)) {
        // Recording one it needs. It counts as played once it's going.
        want.asked = null;
        active++;
        continue;
      }
      if (active >= WHOLE_AT_ONCE) continue; // waiting its turn
      if (free < WHOLE_MIN_FREE) {
        want.waiting = 'space';
        continue;
      }
      want.waiting = null;
      // Just asked for one and it hasn't started recording yet: give it 4 minutes.
      if (want.asked && Date.now() - Date.parse(want.requestedAt) < 4 * 60_000) {
        active++;
        continue;
      }
      // Asked before and it never started: that's a try used up.
      if (want.asked) {
        want.tries[want.asked] = (want.tries[want.asked] ?? 0) + 1;
        if (want.tries[want.asked] >= 3) {
          want.skipped = [...new Set([...(want.skipped ?? []), want.asked])];
          console.log(`${title} S${want.asked.replace('|', 'E')} wouldn't play after 3 tries; skipping it`);
        }
      }
      // Not one being recorded right now (here or in another room).
      const next = p.missing.find(([s, e]) => !p.going.has(`${s}|${e}`) && !want.skipped.includes(`${s}|${e}`));
      if (!next) continue;
      const [season, episode] = next;
      try {
        want.room ??= await freeVcrRoom(); // its own room; a new request there replaces what it was playing
        if (!want.room) continue;
        // Its page too, for a show that isn't (or is no longer) in the VCR's Recent Activity.
        const run = await vcr('/replay', { title, season, episode, room: want.room, url: catalog[title]?.url });
        if (run.status !== 200) throw new Error(run.body.error ?? `VCR said ${run.status}`);
        Object.assign(want, { asked: `${season}|${episode}`, requestedAt: new Date().toISOString() });
        console.log(`Whole show: ${title} S${season}E${episode} in room ${want.room}`);
        active++;
      } catch (err) {
        console.error(`Whole show ${title}: couldn't request S${season}E${episode}: ${err.message}`);
      }
    }
    saveWhole();
  } finally {
    wholeTicking = false;
  }
}
setInterval(() => wholeShowTick().catch((err) => console.error(err)), 30_000).unref?.();

// ---------------------------------------------------------------------------
// Storage: what's taking up the SD card, biggest first, with Compress and Delete.

const CARD_TRASH = path.join('/Volumes/Untitled', '.Trashes', String(process.getuid()));
function folderSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, throwIfNoEntry: false }) ?? []) {
    const file = path.join(dir, entry.name);
    try {
      total += entry.isDirectory() ? folderSize(file) : fs.lstatSync(file).size;
    } catch {}
  }
  return total;
}
function storageBreakdown() {
  let card = null;
  try {
    const s = fs.statfsSync(CARD_DIR);
    card = { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {}
  const items = readLibrary(opts.dir).filter((it) => it.status === 'saved' && it.file).map((it) => {
    const link = path.join(opts.dir, it.file);
    const onCard = fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() ?? false;
    return { id: it.id, title: it.title, kind: it.kind, season: it.season, episode: it.episode, episodeName: it.episodeName,
      date: it.date, size: it.size ?? 0, duration: it.duration, onCard, compressed: it.compressed,
      job: compressJobs.get(it.id) ?? null };
  }).sort((a, b) => b.size - a.size);
  const trash = card ? folderSize(CARD_TRASH) : 0;
  const recordings = items.filter((it) => it.onCard).reduce((sum, it) => sum + it.size, 0);
  const other = card ? Math.max(0, card.total - card.free - recordings - trash) : 0;
  return { card, trash, recordings, other, items };
}

// Compress: re-encoded with the Mac's hardware HEVC encoder (about a third of the size, still
// plays on iPhones and in Chrome), one at a time. The smaller copy is made on the Mac, checked
// (same length, actually smaller), then put in place of the original on the card; until then
// the original is untouched. Progress shows in the Storage window.
const compressJobs = new Map(); // recording id -> { state: queued|compressing|saving|done|failed, progress, error, saved }
let compressRunning = false;

async function compressRequest(req, res) {
  if (!fromHomeDevice(req)) return sendJson(res, { error: 'Compress only works from this page.' }, 403);
  let id;
  try {
    id = String((await readBody(req)).id);
  } catch {
    return sendJson(res, { error: 'Expected JSON.' }, 400);
  }
  const item = readLibrary(opts.dir).find((it) => it.id === id && it.status === 'saved');
  if (!item) return sendJson(res, { error: 'That recording isn\'t here any more.' }, 404);
  if (item.compressed) return sendJson(res, { error: 'It\'s already compressed.' }, 409);
  const job = compressJobs.get(id);
  if (job && ['queued', 'compressing', 'saving'].includes(job.state)) return sendJson(res, { ok: true, job });
  compressJobs.set(id, { state: 'queued', progress: 0 });
  runCompressQueue().catch((err) => console.error(err));
  return sendJson(res, { ok: true, job: compressJobs.get(id) });
}

async function runCompressQueue() {
  if (compressRunning) return;
  compressRunning = true;
  try {
    for (;;) {
      const next = [...compressJobs].find(([, job]) => job.state === 'queued');
      if (!next) break;
      const [id, job] = next;
      try {
        await compressOne(id, job);
      } catch (err) {
        Object.assign(job, { state: 'failed', error: err.message });
        console.log(`Couldn't compress ${id}: ${err.message}`);
      }
    }
  } finally {
    compressRunning = false;
  }
}

async function compressOne(id, job) {
  const item = readLibrary(opts.dir).find((it) => it.id === id && it.status === 'saved');
  if (!item) throw new Error('it isn\'t here any more');
  const original = fs.realpathSync(path.join(opts.dir, item.file)); // on the card, or still on the Mac
  const before = fs.statSync(original).size;
  const length = (await probeVideo(original)).duration || item.duration || 0;
  const tmp = path.join(os.tmpdir(), `recording-compress-${id}.mp4`);
  job.state = 'compressing';
  const code = await new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-progress', 'pipe:1', '-i', original,
      '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'hevc_videotoolbox', '-b:v', '1800k', '-tag:v', 'hvc1',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', tmp], { stdio: ['ignore', 'pipe', 'ignore'] });
    proc.stdout.on('data', (chunk) => {
      const us = /out_time_us=(\d+)/.exec(String(chunk))?.[1];
      if (us && length) job.progress = Math.min(0.99, Number(us) / 1e6 / length);
    });
    proc.on('exit', resolve);
    proc.on('error', () => resolve(-1));
  });
  try {
    if (code !== 0) throw new Error('the encoder stopped');
    const after = fs.statSync(tmp).size;
    const made = (await probeVideo(tmp)).duration || 0;
    if (length && Math.abs(made - length) > 3) throw new Error('the smaller copy came out the wrong length');
    if (after >= before) throw new Error('it didn\'t get any smaller');
    job.state = 'saving';
    // Into place: copied next to the original in pieces (the card's ExFAT), checked, then swapped in.
    await pipeline(fs.createReadStream(tmp, { highWaterMark: 8 << 20 }), fs.createWriteStream(`${original}.part`));
    if (fs.statSync(`${original}.part`).size !== after) throw new Error('copying it back didn\'t finish');
    fs.renameSync(`${original}.part`, original);
    const sidecar = path.join(opts.dir, `${item.file.replace(/\.[^.]+$/, '')}.json`);
    const meta = readJson(sidecar);
    if (meta) writeJsonFile(sidecar, { ...meta, compressed: true, compressed_at: new Date().toISOString(), size_before: before });
    Object.assign(job, { state: 'done', progress: 1, saved: before - after });
    console.log(`Compressed ${item.file}: ${(before / 1e9).toFixed(2)} GB -> ${(after / 1e9).toFixed(2)} GB`);
  } finally {
    fs.rmSync(tmp, { force: true });
    fs.rmSync(`${original}.part`, { force: true });
  }
}
function writeJsonFile(file, data) {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

// Empty the card's Trash (what Delete sent there): the space only comes back once it's emptied.
// Only on the press of its button, after the page has asked.
async function emptyCardTrash(req, res) {
  if (!fromHomeDevice(req)) return sendJson(res, { error: 'This only works from this page.' }, 403);
  const freed = folderSize(CARD_TRASH);
  for (const name of fs.readdirSync(CARD_TRASH, { throwIfNoEntry: false }) ?? []) {
    fs.rmSync(path.join(CARD_TRASH, name), { recursive: true, force: true });
  }
  console.log(`Emptied the SD card's Trash (${(freed / 1e9).toFixed(2)} GB)`);
  return sendJson(res, { ok: true, freed });
}

// This Mac's Trash: its size for Settings, and Empty trash (only on its button, after asking).
// Finder empties it, the same as choosing Empty Trash in Finder.
const MAC_TRASH = path.join(os.homedir(), '.Trash');
function macTrashSize() {
  try {
    fs.readdirSync(MAC_TRASH);
    return folderSize(MAC_TRASH);
  } catch {
    return null; // macOS doesn't let this app look in it
  }
}
async function emptyMacTrash(req, res) {
  if (!fromHomeDevice(req)) return sendJson(res, { error: 'This only works from this page.' }, 403);
  const before = macTrashSize();
  const { code, stderr } = await run('osascript', ['-e', 'tell application "Finder" to empty trash']);
  if (code !== 0) return sendJson(res, { error: `The Mac didn't empty it (${stderr.trim().split('\n').pop() || 'no permission'}).` }, 500);
  console.log(`Emptied this Mac's Trash${before != null ? ` (${(before / 1e9).toFixed(2)} GB)` : ''}`);
  return sendJson(res, { ok: true, freed: before });
}

// The card's Trash empties itself: what Delete sent there is deleted for good after a few
// days (a little time to take back a mistake, like Finder's own "after 30 days").
const CARD_TRASH_DAYS = 3;
function emptyOldCardTrash() {
  const cutoff = Date.now() - CARD_TRASH_DAYS * 86400_000;
  let freed = 0;
  for (const name of fs.readdirSync(CARD_TRASH, { throwIfNoEntry: false }) ?? []) {
    const file = path.join(CARD_TRASH, name);
    try {
      const stat = fs.lstatSync(file);
      if (Math.max(stat.mtimeMs, stat.ctimeMs) > cutoff) continue; // put there less than 3 days ago
      freed += stat.isDirectory() ? folderSize(file) : stat.size;
      fs.rmSync(file, { recursive: true, force: true });
    } catch {}
  }
  if (freed) console.log(`The SD card's Trash emptied itself of ${(freed / 1e9).toFixed(2)} GB (in it over ${CARD_TRASH_DAYS} days)`);
}
setInterval(emptyOldCardTrash, 60 * 60_000).unref?.();
setTimeout(emptyOldCardTrash, 60_000).unref?.();

// Restart (a recording in progress): its room ends and the play is forgotten (so the
// recorder drops what it has), then the VCR plays the same thing from the start in a
// new room, which is recorded fresh.
async function restartRecording(req, res) {
  if (!fromHomeDevice(req)) return sendJson(res, { error: 'Restart only works from this page.' }, 403);
  let id;
  try {
    id = String((await readBody(req)).id);
  } catch {
    return sendJson(res, { error: 'Expected JSON.' }, 400);
  }
  const item = readLibrary(opts.dir).find((it) => it.id === id);
  if (!item) return sendJson(res, { error: 'That recording isn\'t here any more.' }, 404);
  if (!item.room) return sendJson(res, { error: 'This recording doesn\'t say which room it\'s from.' }, 409);
  const done = await restartPlay(item);
  return done.error ? sendJson(res, { error: done.error }, done.status) : sendJson(res, { ok: true, ...done });
}

// Ends the play's room (forgetting it) and has the VCR play it again from the start in a new room.
async function restartPlay(item, why = 'Restart was pressed') {
  try {
    const stop = await vcr('/stop', { room: item.room, forget: true });
    if (stop.status !== 200) return { status: 502, error: stop.body.error ?? 'The VCR wouldn\'t end it.' };
    const room = await freeVcrRoom();
    if (!room) return { status: 503, error: 'Ended, but couldn\'t find a free room to play it again.' };
    const run = await vcr('/replay', { title: item.title, room, season: item.season, episode: item.episode });
    if (run.status !== 200) return { status: 502, error: `Ended, but the VCR couldn't play it again: ${run.body.error ?? 'it refused'}` };
    console.log(`Restarted ${item.title} ${item.season ?? ''}x${item.episode ?? ''} (${why}): room ${item.room} ended, now in ${room}`);
    return { pid: run.body.pid, room };
  } catch {
    return { status: 502, error: 'Can\'t reach the VCR on the Mac.' };
  }
}

// Safeguard: something recording far longer than it could run is stuck (a player that
// never ends, a room left on a menu), so it's restarted, as if Restart were pressed: an
// episode after 90 minutes of recording, a movie after 4 hours. Time paused doesn't count.
// Each play is restarted this way once at most, so one that keeps failing isn't looped.
const LIMITS = { tv: 90 * 60, movie: 4 * 3600 };
const autoRestarted = new Set(); // "title|date time|room" of plays already restarted
async function restartStuck() {
  const library = readLibrary(opts.dir);
  const plays = new Map();
  for (const it of library) {
    if (!it.date || !it.time || !it.room || !LIMITS[it.kind]) continue;
    const key = `${it.title}|${it.date} ${it.time}|${it.room}`;
    const play = plays.get(key) ?? { item: null, paused: 0, recording: false };
    play.paused += it.pausedSeconds || 0; // every part's pauses
    if (it.status === 'recording') Object.assign(play, { item: it, recording: true });
    plays.set(key, play);
  }
  for (const [key, play] of plays) {
    if (!play.recording || autoRestarted.has(key)) continue;
    const started = new Date(`${play.item.date}T${play.item.time}`).getTime(); // when the log says it started
    const recorded = (Date.now() - started) / 1000 - play.paused;
    if (!(recorded > LIMITS[play.item.kind])) continue;
    autoRestarted.add(key);
    const limit = play.item.kind === 'movie' ? '4 hours' : '90 minutes';
    const done = await restartPlay(play.item, `recording for over ${limit}`);
    if (done.error) console.log(`Couldn't restart ${key} after ${limit}: ${done.error}`);
  }
}
setInterval(() => restartStuck().catch((err) => console.error(err)), 60_000).unref?.();

// Every part of a saved recording to the Trash, and its play out of the VCR's History.
async function removeRecording(item) {
  const library = readLibrary(opts.dir);
  const samePlay = (it) => it.status === 'saved' && it.title === item.title && it.season === item.season
    && it.episode === item.episode && it.date === item.date && it.time === item.time && it.room === item.room;
  const parts = item.date && item.time ? library.filter(samePlay) : [item];

  // To the Trash rather than gone for good, in case it was the wrong one.
  const trash = path.join(os.homedir(), '.Trash');
  let moved = 0;
  for (const part of parts) {
    const base = part.file.replace(/\.[^.]+$/, '');
    for (const name of [part.file, `${base}.json`]) {
      const from = path.join(opts.dir, name);
      if (trashCardCopy(from)) { // its video is on the SD card
        moved++;
        continue;
      }
      if (!fs.existsSync(from)) continue;
      let to = path.join(trash, name);
      if (fs.existsSync(to)) to = path.join(trash, `${base} (deleted ${Date.now()})${path.extname(name)}`);
      try {
        fs.renameSync(from, to);
      } catch {
        fs.rmSync(from, { force: true }); // the Trash couldn't take it (another disk)
      }
      moved++;
    }
  }

  let history = 'none';
  if (item.date && item.time && item.room) {
    try {
      const r = await fetch(`${VCR}/history-delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: VCR },
        body: JSON.stringify({ ids: [`${item.date} ${item.time} ${item.room}`] }),
        signal: AbortSignal.timeout(8000),
      });
      const data = await r.json().catch(() => ({}));
      history = r.ok ? (data.removed ? 'removed' : 'none') : 'failed';
    } catch {
      history = 'failed';
    }
  }
  console.log(`Deleted ${parts.length} part(s) of ${item.title} ${item.date} ${item.time} (${moved} files to the Trash), VCR History: ${history}`);
  return { parts: parts.length, history };
}

// The + button: play something on the VCR. Like a VCR request: it gets a room no
// one is using, searches the site used last for the title, and asks (results with
// pictures, then season and episode) through the same questions the VCR shows.
async function vcr(pathAndQuery, body) {
  const r = await fetch(`${VCR}${pathAndQuery}`, body === undefined ? { signal: AbortSignal.timeout(8000) } : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: VCR },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
async function freeVcrRoom() {
  for (let i = 0; i < 8; i++) {
    const code = Array.from({ length: 4 }, () => ROOM_CHARS[crypto.randomInt(ROOM_CHARS.length)]).join('');
    if (!(await vcr(`/room-status?room=${code}`)).body.busy) return code;
  }
  return null;
}
async function vcrRequest(req, res) {
  if (!fromHomeDevice(req)) return sendJson(res, { error: 'Requests can only be made from this page.' }, 403);
  let title;
  try {
    title = String((await readBody(req)).title ?? '').trim().slice(0, 200);
  } catch {
    return sendJson(res, { error: 'Expected JSON.' }, 400);
  }
  if (!title) return sendJson(res, { error: 'Type what you want to watch.' }, 400);
  try {
    // The site: the one the last thing watched came from.
    const history = (await vcr('/history')).body.items ?? [];
    const site = history.find((h) => h.site)?.site;
    if (!site) return sendJson(res, { error: 'Play something from the VCR once first, so it knows which site to use.' }, 409);
    const room = await freeVcrRoom();
    if (!room) return sendJson(res, { error: 'Couldn\'t find a free room.' }, 503);
    const run = await vcr('/run', { args: [title, '--url', site, '--pick', '--share-room', room], remote: { title, site, room } });
    if (run.status !== 200) return sendJson(res, { error: run.body.error ?? 'The VCR refused it.' }, 502);
    return sendJson(res, { pid: run.body.pid, room });
  } catch {
    return sendJson(res, { error: 'Can\'t reach the VCR on the Mac.' }, 502);
  }
}

async function vcrChoose(req, res) {
  if (!fromHomeDevice(req)) return sendJson(res, { error: 'Picks can only be made from this page.' }, 403);
  let pick;
  try {
    const body = await readBody(req);
    pick = { pid: Number(body.pid), id: String(body.id), index: Number(body.index) };
  } catch {
    return sendJson(res, { error: 'Expected JSON.' }, 400);
  }
  try {
    const r = await vcr('/choose', pick);
    return sendJson(res, r.body, r.status);
  } catch {
    return sendJson(res, { error: 'Can\'t reach the VCR on the Mac.' }, 502);
  }
}

// A look at what the Mac is doing in a room while it opens (the site's pages, the
// player): a small picture of the room's show tab, taken from its Chrome (DevTools
// port 9333). The room's run notes its show tab in rooms.json as soon as it starts.
const ROOMS_FILE = path.join(os.homedir(), 'Desktop', 'site-search', 'rooms.json');
const CHROME = 'http://127.0.0.1:9333';
const shots = new Map(); // room -> { at, jpeg: Promise<Buffer> }

function screenshotOf(target) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const timer = setTimeout(() => { ws.close(); reject(new Error('timed out')); }, 8000);
    // The visible part of the page, whatever size its window is, about 768 pixels wide.
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Page.getLayoutMetrics' }));
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id === 1) {
        const v = msg.result?.cssVisualViewport ?? { pageX: 0, pageY: 0, clientWidth: 1280, clientHeight: 720 };
        ws.send(JSON.stringify({ id: 2, method: 'Page.captureScreenshot', params: { format: 'jpeg', quality: 60,
          clip: { x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight, scale: Math.min(1, 768 / v.clientWidth) } } }));
        return;
      }
      if (msg.id !== 2) return;
      clearTimeout(timer);
      ws.close();
      if (msg.result?.data) resolve(Buffer.from(msg.result.data, 'base64'));
      else reject(new Error(msg.error?.message ?? 'no picture'));
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('couldn\'t reach Chrome')); };
  });
}

async function vcrPreview(req, res, searchParams) {
  const ip = String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.|127\.)|^::1$|^fd7a:/i.test(ip)) return send(res, 403, 'Forbidden');
  const room = String(searchParams.get('room') ?? '').toUpperCase();
  if (!/^[A-Z0-9]{4,6}$/.test(room)) return send(res, 400, 'Bad room');
  let shot = shots.get(room);
  if (!shot || Date.now() - shot.at > 800) {
    shot = { at: Date.now(), jpeg: (async () => {
      const tab = (readJson(ROOMS_FILE) ?? {})[room]?.show;
      if (!tab) throw new Error('no tab yet');
      const targets = await (await fetch(`${CHROME}/json/list`, { signal: AbortSignal.timeout(4000) })).json();
      const target = targets.find((t) => t.id === tab);
      if (!target) throw new Error('tab gone');
      return screenshotOf(target);
    })() };
    shot.jpeg.catch(() => shots.delete(room));
    shots.set(room, shot);
  }
  try {
    const jpeg = await shot.jpeg;
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': jpeg.length, 'Cache-Control': 'no-store' });
    return res.end(jpeg);
  } catch {
    return send(res, 404, 'No picture yet');
  }
}

// What the run is asking (its results, seasons or episodes), and what's playing where.
async function vcrRead(req, res, pathname, searchParams) {
  try {
    if (pathname === '/api/vcr/rooms') return sendJson(res, (await vcr('/rooms')).body);
    const pid = String(searchParams.get('pid') ?? '');
    if (!/^\d+$/.test(pid)) return sendJson(res, { error: 'Bad request.' }, 400);
    // Search results' posters: the saved copy when there is one (each is downloaded the first
    // time it's seen), so the sheet doesn't load them from the web.
    const body = (await vcr(`/choices?pid=${pid}`)).body;
    for (const r of Array.isArray(body?.items) ? body.items : []) {
      if (!isHttpUrl(r?.poster) || !r.title) continue;
      const file = posterCache.index[r.poster]?.[r.title];
      if (file && fs.existsSync(path.join(opts.dir, THUMB_DIR, file))) r.poster = `/thumbs/${file}`;
      else keepPoster(r.title, r.poster);
    }
    return sendJson(res, body);
  } catch {
    return sendJson(res, { error: 'Can\'t reach the VCR on the Mac.' }, 502);
  }
}

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function send(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
}

function parseArgs(argv) {
  const parsed = { dir: path.join(__dirname, 'recordings'), port: 7777, lan: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) fail(`${arg} needs a value`);
      return argv[++i];
    };
    switch (arg) {
      case '--dir': parsed.dir = value().replace(/^~(?=$|\/)/, os.homedir()); break;
      case '--port': parsed.port = Number(value()); break;
      case '--lan': parsed.lan = true; break;
      case '-h': case '--help': console.log(HELP); process.exit(0); break;
      default: fail(`Unknown option: ${arg}`);
    }
  }
  if (!Number.isInteger(parsed.port) || parsed.port < 1 || parsed.port > 65535) fail('--port must be a number like 7777');
  return { ...parsed, dir: path.resolve(parsed.dir) };
}

function fail(message) {
  console.error(`${message}\n${HELP}`);
  process.exit(1);
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Port ${opts.port} is already in use. If the dashboard is already running, open http://localhost:${opts.port}`);
    console.log('(or pick another port with --port).');
    process.exit(0); // not an error, so launchd doesn't keep retrying
  }
  throw err;
});

// The guest entrance: only this Mac can reach it, and Tailscale Funnel passes the public link to it.
const guestServer = http.createServer((req, res) => {
  Promise.resolve()
    .then(() => handleGuest(req, res))
    .catch((err) => {
      console.error(err);
      if (!res.headersSent) send(res, 500, 'Something went wrong');
      else res.destroy();
    });
});
guestServer.listen(GUEST_PORT, '127.0.0.1', () => console.log(`Guest entrance (public link): http://127.0.0.1:${GUEST_PORT}`));

server.listen(opts.port, opts.lan ? '0.0.0.0' : '127.0.0.1', () => {
  console.log(`Recordings dashboard: http://localhost:${opts.port}`);
  if (opts.lan) {
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const addr of addrs ?? []) {
        if (addr.family === 'IPv4' && !addr.internal) console.log(`On your network:      http://${addr.address}:${opts.port}`);
      }
    }
  }
  console.log(`Serving ${opts.dir}`);
});
