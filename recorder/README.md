# Recording

Two programs that work together:

- **The recorder** watches a JSON playback log. When a `"start play"` entry is added, it
  opens that entry's `room_link` in Chrome and records the tab (video + audio). When a
  `"stop"` entry with the same `room_link` arrives, it stops and saves an MP4.
- **The dashboard** (http://localhost:7777) lets you browse, search and play the
  recordings, copy a link to any of them, choose which JSON log the recorder watches, and
  copy diagnostics when something goes wrong.

## Pauses

A `"pause"` entry pauses the recording of that `room_link`, and `"resume play"` picks it up
again in the same file, so you get one recording with the paused time left out, however
long the pause was. (A new `"start play"` of the same episode or movie during a pause also
counts as playing again.) The recorder's log notes each pause and its length, and the
recording's `.json` lists them under `pauses`. If a `resume play` arrives with nothing
paused for that room, it starts a new recording from there.

## Running in the background (set up)

Both run in the background: they start when you log in and restart if they crash. There
is no window to keep open. Chrome runs hidden, and recordings still include sound. The
dashboard is at http://localhost:7777 on this Mac and at http://10.0.0.122:7777 (this Mac's
address) from other devices on your network. Anyone on your Wi-Fi can open it and watch the
recordings; only this Mac can change which log is watched.

```bash
cd ~/Desktop/Recording
npm run autostart:status    # running? what is it watching or recording? latest log lines
npm run autostart:restart   # restart both, e.g. after changing the code
npm run autostart:off       # stop both and stop starting them at login
npm run autostart:on        # turn it back on
```

Logs are in `~/Library/Logs/Recording/` (also viewable in the Console app). The login
items themselves are `~/Library/LaunchAgents/com.recording.recorder.plist` and
`com.recording.dashboard.plist`.

Only one recorder runs at a time. If the background one is running, `npm start` says so
and exits. If a recording gets cut off (logout, restart, crash), it's saved the next time
the recorder starts, and if the show is still playing it carries on as **Part 2** (see
[If it's playing, it's recorded](#if-its-playing-its-recorded)).

## If it's playing, it's recorded

Whatever the log says is playing (a `start play` with no `stop` after it, and not paused) is
being recorded. The recorder checks this whenever the log changes and every 15 seconds, so:

- **Already playing when the recorder starts** (after a restart, a crash, logging in, or
  switching logs): recorded from then on. Entries already in the file aren't replayed; only
  what they say is going on now counts.
- **Paused:** recorded once it plays again (its `resume play`).
- **The room doesn't open:** tried again every minute for as long as it's playing. The
  recorder's log notes the failure once, and again only if the error changes or it works.
- **The recording ends early** (its tab or Chrome closed): started again as the next part.

A recording of the same play made before (one cut off by a restart, say) continues as its next
part: `Show S01E02 - Name (date time) (part 2).mp4`. Once none of a play's parts is still
recording or saving, the recorder joins them end to end into one recording under the first
part's name (copied without re-encoding when possible), checks its length, and moves the parts
to the Trash. If the log is rewritten shorter, it's treated as a new log in the same way.

Watch out: a room whose play never gets a `stop` keeps being recorded, even if nothing is on
it any more, until a `stop` or a new `start play` for that room arrives.

**If the room needs a login:** the hidden Chrome can't show a sign-in page. Run
`npm run autostart:off`, then `npm start` (a visible Chrome window opens) and sign in
there. Then press Ctrl+C and run `npm run autostart:on`. The login is remembered.

## From anywhere (Tailscale)

The dashboard is also at **https://platnms-mac-mini.tail7f705f.ts.net** from this Mac and from
any device signed into your Tailscale account (the Tailscale app on your phone or laptop),
wherever it is. It's private to your tailnet, not on the public internet. Tailscale proxies it
to the dashboard on this Mac, with a real HTTPS certificate.

- Tailscale runs on this Mac as a system service that starts at boot:
  `/Library/LaunchDaemons/com.tailscale.tailscaled.plist`, running Homebrew's `tailscaled`
  (so `brew upgrade` updates it). Its state is in `/Library/Tailscale/`, its log in
  `/var/log/tailscaled.log`. The link survives restarts.
- Check it with `tailscale status` or `tailscale serve status`; turn the link off with
  `tailscale serve --https=443 off`. Your user can run these without `sudo`.
- `~/Library/Application Support/tailscaled/` is the state from before the switch (when it
  ran in userspace mode). Nothing uses it now; it's safe to delete.
- Anyone using the link can change which log is watched (it arrives from this Mac, as far as
  the dashboard can tell), so only share your tailnet with people you trust.
- The **Open room** button points at the room on your home network, so it only works at home.
- **Delete** (the trash button on a recording, or on its watch page) moves the recording to the
  Mac's Trash and takes that play out of the VCR's History (the watch log and its Desktop copies).
  Recordings still in progress can't be deleted until they're saved.
- **View VCR** works through Tailscale too: it opens the VCR at
  `http://platnms-mac-mini.tail7f705f.ts.net:8766/` (plain http; Tailscale encrypts it anyway).
  Devices on your tailnet go straight in; no phone code is asked for.
- Tailscale asks this Mac to sign in again when its key expires (every 180 days by default).
  To avoid that, turn off key expiry for **platnms-mac-mini** in the Tailscale admin console.

## Running by hand instead

With autostart off, run each in its own Terminal window:

```bash
cd ~/Desktop/Recording && npm start
```

```bash
cd ~/Desktop/Recording && npm run dashboard
```

Press **Ctrl+C** to stop either one. The recorder saves any recording in progress first
(press Ctrl+C twice to quit immediately).

First time on a new machine: run `npm install` in this folder.

## The dashboard

- **Library:** the newest recording up top, then every recording as a card with its
  thumbnail and length. Each TV show is a single collapsed card ("2 seasons"). Click it to
  show a card per season, and click a season to show its episodes in order. Click again to
  close either; it remembers what you left open. Movies are single cards. Shows, seasons
  and movies use the thumbnail from the log; each saved episode's picture is a frame from
  halfway through it (one still recording uses the show's thumbnail until it's saved).
- **No duplicates:** there's one card per episode (or movie): the recording still going if
  there is one, otherwise the longest. Parts of one viewing are joined into a single
  recording (see above), so nothing of it is lost. Separate viewings of the same episode are
  real duplicates: once none of them is still recording, the recorder keeps the longest and
  moves the others to the Trash.
- **Filters:** **Currently Recording**, **TV** and **Movies**, each with a count. Click one
  to show only that, and click it again to show everything. Sort by date or title, and
  search as you type (titles, episode names, `s1e2`, dates like `nov 3`). Search results
  start collapsed too: open and close shows and seasons as you like. Each new search starts
  collapsed again, and doesn't change what you left open in the library. Press `/` to jump to
  search.
- **No silent start:** when a recording is saved, everything before its first sound is cut
  off, whatever the picture shows. That's the room still connecting: its waiting screen (room
  code and QR code), then black. Only the start is cut; silences later in the show stay.
  Under a second isn't cut, and a recording with no sound at all in its first five minutes
  isn't cut either (its sound was most likely off at the source, so the silence is the show).
  Each part is cut before parts are joined. Watching a recording that's still going skips
  its silent start too. Recordings saved before this was added are cut in the background,
  one at a time (the uncut original goes to the Trash). The `.json` notes the seconds cut as
  `start_trimmed`.
- **Only what's in the log:** a recording shows only while its entry is still in the log it
  came from. Take a play out of the log (e.g. with the VCR's Delete) and it disappears from
  the page at once. A minute later the recorder removes it: one still recording is stopped,
  and the video and its `.json` are **moved to the Trash** (deleted outright only if the Trash
  can't take them), so a mistake can be undone from the Trash. A log that can't be read
  removes nothing, and a recording whose `.json` doesn't say which log it came from (made
  before this was added) is only hidden, never deleted.
- **Watching:** click a card to play it. The page's address (`/watch/…`) is the link to
  that recording; it's also in the box under the player with a Copy button, and every
  card has a copy-link button on hover. You'll also find Download and Open room buttons
  there, plus the show's other episodes, with the next one marked **Up next** (it plays
  automatically when an episode ends).
- **Resume:** it remembers where you stopped in each recording and picks up from there;
  half-watched recordings show under **Continue watching**.
- **Live:** a recording in progress appears with a red **REC** timer. While the show is
  paused it says **PAUSED** and the timer stands still (it counts recorded time only).
- **Watch while it records:** click a REC or PAUSED card to watch what's been recorded so
  far, seeking included. The bar under the player says how much there is, and **Catch up**
  adds what's been recorded since, without losing your place. If you reach the end while
  it's still recording, it catches up again on its own every 15 seconds. When the
  recording finishes, the player switches to the saved file at the same spot. (It's a quick
  copy of the recording in progress, made in your computer's temp folder.)
- **In the log but not recording:** anything in the watched log that has started and not
  stopped, but that isn't being recorded, shows as a dimmed **PLAYING** (or **PAUSED**) card
  with the reason in orange: "paused: records when it plays again", or "couldn't record it:
  trying every minute" (the room didn't open). Hover over the card for the details.
- **Diagnostics:** if something goes wrong, click the recorder pill and then **Copy
  diagnostics**, and paste the result into a message. It has the recorder's status, the
  watched log's latest entries, the recordings folder, and the last lines of every log. It's
  also at http://localhost:7777/api/diagnostics.
- **Player keys:** space or `k` play/pause, `j`/`l` back/forward 10 s, arrows 5 s, `f`
  full screen, `m` mute, Esc back to the library.

### Choosing the JSON log

Click the recorder pill in the top-right corner. It shows whether the recorder is running
and lets you type a path or pick one of the JSON files found nearby. The recorder switches
to the new file within a second, without restarting. Entries already in that file aren't
replayed, but whatever it says is still playing is picked up (see above), and new
`start play` entries start recordings. Under the path, **What the
recorder is reading** shows the file's contents live, scrolled to the newest entries.

The setting is saved in `config.json` (default: `~/Desktop/log_example.json`). You can also
set it from the command line with `npm start -- --log ~/path/to/log.json`.

Only this computer can change the setting, even when the dashboard is shared on your
network.

## Thumbnails

Each entry's `thumbnail` URL is downloaded once and reused:

- The same thumbnail URL for the same title (e.g. every episode of a show) is never
  downloaded again.
- Images are stored under a hash of their content, so two URLs that return the same
  picture take up one file.
- If an entry has no thumbnail or it can't be downloaded, a frame from the recording is
  used instead.

They live in `recordings/thumbnails/`. Delete that folder to force fresh downloads.

## The example log

`example/log.json` holds working test entries for two made-up titles: the TV show
**Saltwater Station** (season 1, episodes 1–3, all in room `S4LT`) and the movie
**Halfway to Juniper** (room `J7NP`). Each one starts and stops; episode 2 and the movie
are also paused and resumed partway through. `~/Desktop/log_example.json` starts out as a
copy of it (site-search's `search.py` may overwrite that copy, so the replay uses this one).

To try them out, run:

```bash
cd ~/Desktop/Recording && npm run example
```

It points the recorder at a scratch log (`replay-log.json`), adds the entries a few seconds
apart (start, pause, resume, stop), then points the recorder back at the log it was
watching. It takes about a minute, and the four recordings show up in the dashboard. Episode 2
and the movie come out about 12 s long even though each was paused for a while, and the
timecode in the picture jumps where the pause was cut. Change the timing with
`npm run example -- --play 20 --pause 30`. It won't start while something real is
recording, and nothing added to your real log while it runs gets recorded.

Their links point at the dashboard, which serves the test pages from `example/`:

- `room_link`: `/example/room.html#tv=…&title=…&s=…&e=…&name=…`, a test room that plays
  the title's scene with a running timecode and a beep every second (a higher beep every
  10 s), so its recordings have moving video and real sound.
- `thumbnail`: the title's key art (`/example/saltwater-station.jpg`,
  `/example/halfway-to-juniper.jpg`). All three episodes share one image, like a real
  show, so it's downloaded once.

Entries don't have a `show_url` any more: only the room is recorded, so it isn't needed.

The dashboard has to be running for these links to work. Entries already in a file when the
recorder starts watching it aren't replayed, and a start and stop added together capture
nothing, which is why the replay spaces them out.

## Files

```
recordings/
  Show 1 S01E02 - Episode Name (2026-01-01 20-22-45).mp4    the recording
  Show 1 S01E02 - Episode Name (2026-01-01 20-22-45).json   its details (from the log entry)
  thumbnails/                                             shared thumbnail images
example/         the example log (log.json) and the test room and art it uses
replay-example.js  npm run example (replay-log.json exists only while it runs)
config.json      which log the recorder watches
status.json      recorder heartbeat (exists only while it runs)
chrome-profile/  the recorder's own Chrome profile (keeps site logins)
autostart.js     sets up / removes the background login items
```

While recording, data streams into a `.recording.webm` file, which is converted to MP4
after the stop and then deleted. If the page reloads mid-recording, recording continues in
a `(part 2)` file.

## The Chrome window

The recorder uses its own Chrome profile, separate from your normal Chrome. If the room
needs a login, sign in once in that window and it's remembered. You can minimize the window
or switch tabs while it records. Closing the tab being recorded ends that recording early
(it starts again as the next part if the log still says it's playing).
Sound is recorded but not played through your speakers unless you pass `--audible`.

Chrome only lets secure pages (https, or localhost) be recorded, so a room served over plain
http from this Mac's own address (Screen Relay's `http://10.0.0.122:8765/#tv=…`) is opened as
`http://localhost:8765/#tv=…`, the same page. A room on another computer has to be https.
Sound that reaches the room over WebRTC (as Screen Relay's does) isn't part of what Chrome
captures from a tab, so the recorder takes it straight from the incoming stream and mixes it
with the tab's own sound.

## Options

Recorder (`npm start -- <options>`):

| Option | Default | |
|---|---|---|
| `--log <file>` | dashboard setting | Log file to watch (also saves it as the setting) |
| `--out <dir>` | `./recordings` | Where recordings are saved |
| `--format mp4\|webm` | `mp4` | `webm` skips conversion (faster, but QuickTime can't play it) |
| `--size <WxH>` | `1280x720` | Size of the recorded page area (sharper on Retina screens) |
| `--interval <ms>` | `1000` | How often to check the log |
| `--headless` | off | No visible Chrome window |
| `--audible` | off | Also play the sound through the speakers |
| `--chrome <path>` | Google Chrome in /Applications | Chrome to use |

Dashboard (`npm run dashboard -- <options>`):

| Option | Default | |
|---|---|---|
| `--port <port>` | `7777` | Port to serve on |
| `--dir <dir>` | `./recordings` | Recordings folder |
| `--lan` | off (on for the background one) | Let other devices on your network open it (links then use your Mac's network address) |

## Requirements

Node.js 18+, Google Chrome, and ffmpeg (`brew install ffmpeg`). Without ffmpeg, recordings
are saved as `.webm` and entries without a thumbnail get a placeholder instead of a frame.
