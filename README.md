# Screen Relay

Put a computer's screen, or one of its tabs, on a TV (or a phone) with a room code. Open the page
on the TV to get a code, type that code on the computer, and the picture and sound go straight
from the computer to the TV.

Live at **https://tvshare.onrender.com**. It's a static site: `index.html` is the whole app, and
`remote.html` is the phone builder for the Search Command Builder (see the end). Render deploys
`main` automatically.

---

## Contents

1. [How to use it](#1-how-to-use-it)
2. [How the connection works](#2-how-the-connection-works)
3. [Room codes and several screens per room](#3-room-codes-and-several-screens-per-room)
4. [Sharing: what the computer does](#4-sharing-what-the-computer-does)
5. [Watching: what the TV does](#5-watching-what-the-tv-does)
6. [Picture and sound quality](#6-picture-and-sound-quality)
7. [Sound on the TV](#7-sound-on-the-tv)
8. [The volume slider](#8-the-volume-slider)
9. [Staying connected](#9-staying-connected)
10. [remote.html](#10-remotehtml)
11. [Running it locally and deploying](#11-running-it-locally-and-deploying)

---

## 1. How to use it

- **On the TV**: open `https://tvshare.onrender.com` and choose "Use this device as the TV". It
  shows a random 5-character room code and a QR code. For a fixed code, open
  `https://tvshare.onrender.com/#tv=1234` instead; it always uses room 1234 (bookmark it).
- **On the computer**: open the same site, type the code and click **Share screen**, then choose a
  tab, window or the whole screen. For sound, share a Chrome tab with "Also share tab audio" on.
- **Opening the QR code** on a computer fills in the code (`…/#ABCDE`).

## 2. How the connection works

It uses **WebRTC** through **PeerJS** (`peerjs@1.5.4`) and its free public server.

- The PeerJS server only **introduces** the two devices. Each screen registers under a name made
  from the room code, and the computer asks the server to connect to that name.
- Once connected, **the video and sound go directly** between the devices (on the same Wi-Fi,
  straight over the home network). PeerJS's TURN relay is only used when a direct path can't be
  found, such as across strict networks.
- The computer opens two things to each screen: a **media call** (the picture and sound) and a
  **data connection** (small messages: "bye" when sharing stops, and the volume level).

## 3. Room codes and several screens per room

- Codes made up by the TV are 5 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no I, O, 0 or
  1, so they're easy to read). A fixed code (`#tv=1234`) can be any 4–6 letters or digits.
- **Up to 4 screens can watch one room** (`SLOTS = 4`), such as a TV and a few phones. Each screen
  takes the first free slot of the room's name: `screenrelay-tv-1234`, then `screenrelay-tv-1234-1`,
  `-2`, `-3`. If a slot is taken, the server says so and the screen tries the next one, going round
  again after a short wait if all are busy.
- A TV with a random code that finds its code taken waits and retries, then picks a new code. A
  fixed code is never swapped.
- The TV remembers its random code across reloads (in its own storage), so a bookmark keeps
  working.

## 4. Sharing: what the computer does

`startShare` in `index.html`:

1. Asks the browser to share (`getDisplayMedia`): video at 30 frames a second, ideally 1920×1080,
   and audio with the voice-call processing (echo cancellation, noise suppression, automatic
   gain) turned **off**, because that processing muffles music and films.
2. Shows the sharing panel with a preview, and says whether sound is included.
3. Registers with the PeerJS server under a random name and **calls every slot** of the room.
4. **Keeps calling the empty slots every 4 seconds**, for as long as it's sharing. If no screen is
   on the room yet, it shows "Waiting for a TV on code …" and keeps the share going, so a TV can
   open the room before, during or after sharing starts. A call that isn't answered within 15
   seconds is dropped and tried again later.
5. Shows "Live on TV", or "Live on N screens", while at least one screen is connected.
6. **Stop sharing** sends "bye" to every screen and ends the share.

## 5. Watching: what the TV does

`startTv` and `openTvPeer`:

- Registers under the room's first free slot and waits. The status line says "Ready. Waiting for a
  computer to share."
- When a call comes in, it answers and plays the stream full-bleed. A new call replaces the old
  one, so a new share (or the next episode) simply takes over.
- When sharing ends ("bye", or the call closes), it goes back to the waiting screen.
- It asks the browser to keep the screen awake (Wake Lock) where that's allowed, and hides the
  cursor and buttons after 3 seconds without movement.
- **Full screen** toggles fullscreen.

## 6. Picture and sound quality

A shared film should look and sound like one, not like a video call.

- **Bitrate**: once a screen is connected, the computer raises its sender's limit to **8 Mbps**
  for video at up to 30 frames a second (`VIDEO_MAX_BITRATE`), and 256 kbps for sound. The browser
  still lowers it if the connection can't carry that.
- **Keep the resolution**: the video track's content hint is `detail` and the sender prefers
  `maintain-resolution`. When bandwidth is short it drops frames rather than turning blurry.
  (A `motion` hint was tried and dropped: Chrome shrank the captured tab itself while a new
  connection's bandwidth estimate was still ramping up, and it could stay as small as 274×154
  for the rest of the show.)
- **Stereo sound**: WebRTC normally sends Opus audio in mono at around 32 kbps, like a phone call.
  `hiFiAudio` rewrites both sides' connection descriptions (SDP) to add `stereo=1`,
  `sprop-stereo=1` and `maxaveragebitrate=510000` to the Opus line. Both the computer (when
  calling) and the TV (when answering) apply it, which is what makes the computer send stereo.

## 7. Sound on the TV

Browsers only let a page play sound after someone has pressed something on that page, and then
for as long as it stays open. No page can get around that, so the TV page works with it:

- **Any press turns sound on**: a TV remote button (any key except Back), a click or a tap.
- **Asked up front**: the waiting screen says "Press OK on your remote once so everything plays
  with sound", and then "Sound is on". From then on, every show that arrives on that page plays
  with sound, as long as the page stays open.
- **When a show arrives**, it tries to play with sound. If the browser refuses, it plays muted and
  shows a large "Press OK for sound" until the next press.
- **A bug this fixed**: the picture and the sound arrive as two separate events, so the player was
  started twice and the second start interrupted the first. That interruption (an `AbortError`)
  used to be taken as "sound not allowed", which muted the TV even when sound was allowed. Now
  only a real refusal (`NotAllowedError`) mutes it.

Some TV browsers have an autoplay setting; allowing it for the site removes the one press.

## 8. The volume slider

The phone's builder page has a **TV volume** slider. The phone is in the room like the TV is, so
it opens a data connection to the room's other slots and sends `{type: "volume", value: 0–100}`.
The TV page sets its video's volume to that share of the TV's own volume (100% is as loud as the
TV is set), shows "Volume 60%" briefly, and remembers the level for the next show.

## 9. Staying connected

The PeerJS server drops idle connections now and then, and networks blip. Once two devices are
connected the video doesn't need the server, so losing it never stops a show:

- **The computer** reconnects to the server in the background and keeps sharing. New calls wait
  until it's back; screens already watching keep going.
- **A screen that's watching** keeps playing and reconnects in the background. Only a screen
  that's still waiting re-registers from scratch.

## 10. remote.html

`remote.html` is a copy of the Search Command Builder's phone page (`command-builder.html` in
`~/Desktop/site-search`), so it can be opened from anywhere. Served from here, it doesn't talk to
a server: it reads a key from its own link (`#k=…`, never sent to Render), asks for a passcode,
and connects over PeerJS to an agent running on the Mac, whose address is made from both. It
contains no key or passcode itself. See the Search Command Builder's README, section 15.

When the builder page changes, copy it over and push:

```bash
cp ~/Desktop/site-search/command-builder.html ~/Desktop/screenshare/remote.html
```

## 11. Running it locally and deploying

- **Locally**: `./serve.sh` serves this folder on port 8765 (`python3 -m http.server`). The Mac's
  helper starts the same server automatically, so the TV can use `http://<Mac's Wi-Fi
  address>:8765/#tv=1234` on the same Wi-Fi. Sharing needs `localhost` or `https` (browsers only
  allow screen sharing on secure pages); watching works over plain `http`.
- **Deploying**: push to `main` on GitHub; Render rebuilds `tvshare.onrender.com` within a minute
  or two. Render's free hosting can take up to about 30 seconds to wake up after it's been idle.
