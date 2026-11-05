#!/usr/bin/env node
'use strict';

// Plays the example log (example/log.json) into the recorder, one entry at a
// time like a real log growing: each start, pause, resume and stop arrives a
// few seconds after the one before. The recorder is pointed at a scratch log
// (replay-log.json) while this runs and switched back to its log afterwards.
//
//   npm run example
//   npm run example -- --play 20 --pause 10

const fs = require('fs');
const path = require('path');
const { loadConfig, saveConfig, recorderStatus, writeJson } = require('./library');

const HELP = `
Usage: node replay-example.js [options]

  --play <seconds>    How long each title plays between entries (default: 8)
  --pause <seconds>   How long each pause lasts (default: 6)
  -h, --help          Show this help

Needs the recorder and the dashboard running. Takes about a minute.
`;

const SOURCE = path.join(__dirname, 'example', 'log.json');
const REPLAY_LOG = path.join(__dirname, 'replay-log.json');
const DASHBOARD = 'http://localhost:7777';
const opts = parseArgs(process.argv.slice(2));

let interrupted = false;
let wake = () => {};

async function main() {
  const entries = JSON.parse(fs.readFileSync(SOURCE, 'utf8'));
  const status = recorderStatus();
  if (!status.running) {
    fail('The recorder isn\'t running. Start it with: npm run autostart:on (or npm start in another window)');
  }
  if (status.recording?.length) {
    fail(`The recorder is busy recording ${status.recording.join(', ')}. Try again once it's done,\n`
      + 'so its stop entry isn\'t missed while the recorder watches the test log.');
  }
  const previous = loadConfig().log;
  if (previous === REPLAY_LOG) {
    fail('The recorder is still pointed at the test log from an earlier run.\n'
      + `Pick the log it should watch in the dashboard (${DASHBOARD}, the recorder pill), then run this again.`);
  }
  try {
    const res = await fetch(`${DASHBOARD}/example/room.html`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    fail(`The dashboard isn't answering at ${DASHBOARD} (${err.message}); the test rooms live there.\n`
      + 'Start it with: npm run autostart:on (or npm run dashboard in another window)');
  }

  const total = entries.reduce((sum, entry) => sum + holdFor(entry), 0);
  log(`Replaying ${entries.length} entries from example/log.json (about ${Math.round(total / 1000)} s).`);
  log(`Meanwhile the recorder watches the test log instead of ${path.basename(previous)};`);
  log('anything added to that file in the meantime won\'t be recorded. Press Ctrl+C to stop early.');

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      if (interrupted) {
        saveConfig({ log: previous });
        console.log(`\nQuit. The recorder is watching ${previous} again.`);
        process.exit(1);
      }
      interrupted = true;
      wake();
      console.log('\nStopping early (press Ctrl+C again to quit right away)…');
    });
  }

  writeJson(REPLAY_LOG, []);
  saveConfig({ log: REPLAY_LOG });
  if (!(await waitFor(() => recorderStatus().watching === REPLAY_LOG, 15_000))) {
    log('The recorder didn\'t switch to the test log within 15 s. Is it stuck? Check the dashboard\'s diagnostics.');
  }

  const written = [];
  const open = new Map(); // room_link -> its latest entry, until its stop
  const append = (entry) => {
    written.push(entry);
    writeJson(REPLAY_LOG, written);
    const action = entry.action.toLowerCase();
    if (action === 'stop') open.delete(entry.room_link);
    else open.set(entry.room_link, entry);
  };

  for (const entry of entries) {
    if (interrupted) break;
    append(entry);
    log(`${entry.action.padEnd(11)} ${describe(entry)}${entry.position ? ` at ${entry.position}` : ''}`);
    await sleep(holdFor(entry));
  }

  // Anything still playing (after Ctrl+C) gets its stop, so it's saved.
  for (const entry of open.values()) {
    append({ ...entry, action: 'stop', position: undefined });
    log(`stop        ${describe(entry)} (stopped early)`);
  }

  log('Waiting for the recorder to finish up…');
  await sleep(1500);
  await waitFor(() => !recorderStatus().recording?.length, 20_000);
  saveConfig({ log: previous });
  await waitFor(() => recorderStatus().watching === previous, 15_000);
  fs.rmSync(REPLAY_LOG, { force: true });
  log(`Done. The recorder is watching ${previous} again.`);
  log(`The recordings show up at ${DASHBOARD} once they're saved (a few seconds).`);
}

// How long to wait after an entry before the next one.
function holdFor(entry) {
  const action = String(entry.action).toLowerCase();
  if (action === 'pause') return opts.pause * 1000;
  if (action === 'stop') return 2000;
  return opts.play * 1000;
}

function describe(entry) {
  const code = entry.season != null && entry.episode != null
    ? ` S${String(entry.season).padStart(2, '0')}E${String(entry.episode).padStart(2, '0')}` : '';
  return `${entry.content}${code}${entry.episode_name ? ` "${entry.episode_name}"` : ''}`;
}

async function waitFor(check, timeout) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return check();
}

// A wait that Ctrl+C cuts short.
function sleep(ms) {
  if (interrupted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

function log(message) {
  console.log(`[${new Date().toLocaleTimeString('en-GB')}] ${message}`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const parsed = { play: 8, pause: 6 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const seconds = () => {
      const value = Number(argv[++i]);
      if (!(value > 0)) fail(`${arg} needs a number of seconds\n${HELP}`);
      return value;
    };
    switch (arg) {
      case '--play': parsed.play = seconds(); break;
      case '--pause': parsed.pause = seconds(); break;
      case '-h': case '--help': console.log(HELP); process.exit(0); break;
      default: fail(`Unknown option: ${arg}\n${HELP}`);
    }
  }
  return parsed;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
