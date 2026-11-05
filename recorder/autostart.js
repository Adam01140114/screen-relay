#!/usr/bin/env node
'use strict';

// Runs the recorder and the dashboard in the background: started at login and
// restarted if they crash (macOS launchd agents).
//
//   npm run autostart:on        install and start both
//   npm run autostart:off       stop both and stop starting them at login
//   npm run autostart:restart   restart both (e.g. after changing the code)
//   npm run autostart:status    are they running? plus their latest log lines

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { recorderStatus, loadConfig, LOG_DIR } = require('./library');

const AGENTS_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
const DOMAIN = `gui/${process.getuid()}`;

const SERVICES = [
  {
    label: 'com.recording.recorder',
    name: 'Recorder',
    // No visible Chrome window popping up at login; recording still includes sound.
    args: [path.join(__dirname, 'recorder.js'), '--headless'],
    // Saving a long recording can take a few minutes after it's told to stop.
    exitTimeout: 600,
  },
  {
    label: 'com.recording.dashboard',
    name: 'Dashboard',
    // Reachable from other devices on the home network too (http://<this Mac's address>:7777).
    args: [path.join(__dirname, 'dashboard.js'), '--lan'],
    exitTimeout: 20,
  },
];

const plistPath = (service) => path.join(AGENTS_DIR, `${service.label}.plist`);
const logPath = (service, stream) => path.join(LOG_DIR, `${service.label.split('.').pop()}.${stream}.log`);

function nodeBinary() {
  // The Homebrew symlink keeps working after `brew upgrade node`; the Cellar path doesn't.
  const found = spawnSync('which', ['node'], { encoding: 'utf8' }).stdout.trim();
  return found || process.execPath;
}

function plist(service) {
  const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const node = nodeBinary();
  // Background jobs get a bare PATH; the recorder needs ffmpeg from Homebrew.
  const PATH = [...new Set([path.dirname(node), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(service.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
${service.args.map((arg) => `    <string>${xml(arg)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(PATH)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ExitTimeOut</key><integer>${service.exitTimeout}</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(logPath(service, 'out'))}</string>
  <key>StandardErrorPath</key><string>${xml(logPath(service, 'err'))}</string>
</dict>
</plist>
`;
}

function launchctl(...args) {
  const result = spawnSync('launchctl', args, { encoding: 'utf8' });
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}`.trim() };
}

function isLoaded(service) {
  return launchctl('print', `${DOMAIN}/${service.label}`).ok;
}

function on() {
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  for (const service of SERVICES) {
    if (isLoaded(service)) launchctl('bootout', `${DOMAIN}/${service.label}`);
    fs.writeFileSync(plistPath(service), plist(service));
    const result = launchctl('bootstrap', DOMAIN, plistPath(service));
    if (!result.ok) {
      console.error(`Couldn't start the ${service.name.toLowerCase()}: ${result.output}`);
      process.exitCode = 1;
      continue;
    }
    console.log(`✓ ${service.name} will start at login and is starting now`);
  }
  console.log(`\nDashboard: http://localhost:7777 (and on your network at this Mac's address, port 7777)`);
  console.log(`Logs:      ${LOG_DIR}`);
  console.log('Check on them any time with: npm run autostart:status');
}

function off() {
  for (const service of SERVICES) {
    if (isLoaded(service)) {
      console.log(`Stopping the ${service.name.toLowerCase()}${service.label.endsWith('recorder') ? ' (saving any recording in progress)' : ''}…`);
      launchctl('bootout', `${DOMAIN}/${service.label}`);
    }
    fs.rmSync(plistPath(service), { force: true });
    console.log(`✓ ${service.name} stopped and won't start at login`);
  }
}

function restart() {
  for (const service of SERVICES) {
    if (!isLoaded(service)) {
      console.log(`${service.name} isn't set to run in the background; turn it on with: npm run autostart:on`);
      continue;
    }
    const result = launchctl('kickstart', '-k', `${DOMAIN}/${service.label}`);
    console.log(result.ok ? `✓ Restarted the ${service.name.toLowerCase()}` : `Couldn't restart the ${service.name.toLowerCase()}: ${result.output}`);
  }
}

function status() {
  for (const service of SERVICES) {
    const info = launchctl('print', `${DOMAIN}/${service.label}`);
    if (!info.ok) {
      console.log(`${service.name}: not set to start at login (npm run autostart:on)`);
      continue;
    }
    const pid = /^\s*pid = (\d+)/m.exec(info.output)?.[1];
    const lastExit = /last exit code = (.+)/.exec(info.output)?.[1];
    console.log(`${service.name}: ${pid ? `running (process ${pid})` : `not running${lastExit ? ` (last exit: ${lastExit})` : ''}`}`);
    if (service.label.endsWith('recorder')) {
      const rec = recorderStatus();
      if (rec.running) {
        console.log(`  watching ${rec.watching ?? loadConfig().log}`);
        console.log(`  ${rec.recording?.length ? `recording: ${rec.recording.join(', ')}` : 'waiting for a start entry'}`);
      }
    }
    for (const stream of ['out', 'err']) {
      const lines = tail(logPath(service, stream), 4);
      if (lines.length) console.log(`  ${path.basename(logPath(service, stream))}:\n${lines.map((l) => `    ${l}`).join('\n')}`);
    }
  }
}

function tail(file, count) {
  try {
    return fs.readFileSync(file, 'utf8').trimEnd().split('\n').filter(Boolean).slice(-count);
  } catch {
    return [];
  }
}

if (process.platform !== 'darwin') {
  console.error('Autostart uses macOS launchd and only works on a Mac.');
  process.exit(1);
}

const commands = { on, off, restart, status };
const command = commands[process.argv[2]];
if (!command) {
  console.log('Usage: node autostart.js on|off|restart|status');
  process.exit(1);
}
command();
