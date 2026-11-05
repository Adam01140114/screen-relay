'use strict';

// Recordings dashboard: library (search, filter, sort), watch page (player,
// shareable link, up next) and recorder settings. Data comes from /api/*.

const $ = (selector) => document.querySelector(selector);

const ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z"/></svg>',
  link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>',
  film: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
};

const state = {
  items: [],
  loaded: false,
  signature: '',
  kind: 'tv', // the page always opens on TV
  sort: 'newest', // always newest first
  settings: null,
  // Everything starts collapsed on every visit; only what's opened by hand is open.
  open: new Set(), // shows whose seasons are showing
  openSeasons: new Set(), // "show|season" whose episodes are showing
  search: { query: '', shows: new Set(), seasons: new Set() }, // what's open in the current search's results
  catalog: {}, // show title -> every season and episode it has (from the site), for the ones not recorded
};

const video = $('#video');
let currentId = null;
let endTimer = null;
let libraryUrl = '/'; // where "All recordings" goes back to (keeps your search)

// ---------------------------------------------------------------------------
// Formatting

const pad = (n) => String(n).padStart(2, '0');
const dateFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

function longDuration(seconds) {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h} hr ${m} min`;
  return m ? `${m} min` : `${s} sec`;
}

function fileSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

function relative(date) {
  const minutes = Math.round((Date.now() - date) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return dateFmt.format(date);
}

function episodeCode(item) {
  return item.season != null && item.episode != null ? `S${pad(item.season)}E${pad(item.episode)}` : '';
}

function subtitleOf(item) {
  const bits = [episodeCode(item), item.episodeName];
  if (item.kind === 'movie' && !item.episodeName) bits.push('Movie');
  if (item.part > 1) bits.push(`Part ${item.part}`);
  return bits.filter(Boolean).join(' · ');
}

// When it was played according to the log, falling back to when it was recorded.
function whenOf(item) {
  if (item.date) {
    const date = new Date(`${item.date}T${item.time || '00:00:00'}`);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return item.startedAt ? new Date(item.startedAt) : null;
}

function dateLabel(item) {
  const when = whenOf(item);
  return when ? `${dateFmt.format(when)} · ${timeFmt.format(when)}` : '';
}

function hue(text) {
  let h = 0;
  for (const ch of String(text)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

// ---------------------------------------------------------------------------
// Per-viewer storage (progress, filters). Optional: everything works without it.

function stored(key) {
  try { return localStorage.getItem(`recordings:${key}`); } catch { return null; }
}
function store(key, value) {
  try { localStorage.setItem(`recordings:${key}`, value); } catch {}
}
function storedList(key) {
  try {
    const list = JSON.parse(stored(key));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

const progress = {
  get(id) {
    try { return JSON.parse(stored(`progress:${id}`)); } catch { return null; }
  },
  // While it's still recording only the spot is kept: its length isn't known
  // yet, so it can't count as half watched (or watched).
  set(id, time, duration, live = false) {
    if (!duration || !Number.isFinite(duration)) return;
    store(`progress:${id}`, JSON.stringify({ time, duration: live ? null : duration, at: Date.now() }));
  },
  fraction(id) {
    const p = this.get(id);
    return p?.duration ? Math.min(1, p.time / p.duration) : 0;
  },
};

// ---------------------------------------------------------------------------
// Search, filter, sort

const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function haystack(item) {
  const when = whenOf(item);
  return fold([
    item.title,
    item.episodeName,
    episodeCode(item),
    item.season != null ? `s${item.season}e${item.episode} season ${item.season} episode ${item.episode}` : '',
    item.kind === 'movie' ? 'movie film' : item.kind === 'tv' ? 'tv show episode' : '',
    item.date,
    when && dateFmt.format(when),
    when && when.toLocaleDateString(undefined, { month: 'long', weekday: 'long' }),
    item.room,
    item.status === 'log' ? 'in progress playing now not recording' : item.status !== 'saved' ? 'live recording now' : '',
  ].filter(Boolean).join(' '));
}

function matches(item, query) {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const text = haystack(item);
  return terms.every((term) => text.includes(term));
}

function episodeOrder(a, b) {
  return (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0)
    || (whenOf(a) ?? 0) - (whenOf(b) ?? 0) || a.part - b.part;
}

function sortItems(items, sort = state.sort) {
  const time = (item) => whenOf(item)?.getTime() ?? 0;
  const sorted = [...items];
  if (sort === 'title') sorted.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }) || episodeOrder(a, b));
  else if (sort === 'oldest') sorted.sort((a, b) => time(a) - time(b) || a.part - b.part);
  else sorted.sort((a, b) => time(b) - time(a) || a.part - b.part);
  return sorted;
}

const playable = (item) => item.status === 'saved' && item.media;
// Finished, or still recording (or paused) with something recorded so far.
const watchable = (item) => Boolean(item.media);
const isRecording = (item) => item.status === 'recording' || item.status === 'paused';

// The episode (or part) after this one, if it has been recorded.
function nextAfter(item) {
  const series = state.items.filter((it) => it.title === item.title && playable(it)).sort(episodeOrder);
  const index = series.findIndex((it) => it.id === item.id);
  return index >= 0 ? series[index + 1] ?? null : null;
}

// ---------------------------------------------------------------------------
// Rendering pieces

// An episode's own picture is a frame from halfway through it (once it's
// saved); shows, seasons and movies use the title's thumbnail from the log.
function pictureOf(item, { title = false } = {}) {
  return (!title && item.kind === 'tv' && item.frame) || item.thumb;
}

function artwork(item, options) {
  const initials = item.title.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0]).join('').toUpperCase();
  const poster = `<div class="poster" style="--h:${hue(item.title)}"><span>${esc(initials)}</span></div>`;
  const picture = pictureOf(item, options);
  // A picture that doesn't load (e.g. a dead link in the log) leaves the initials showing.
  if (picture) return `${poster}<img src="${esc(picture)}" alt="" loading="lazy" decoding="async" onerror="this.remove()">`;
  return poster;
}

// "REC 12:34" (or "PAUSED 12:34", frozen) for a recording in progress. The time
// is how much has been recorded: pauses don't count.
function liveBadge(item) {
  const paused = item.status === 'paused';
  return `<span class="badge rec${paused ? ' paused' : ''}"><i></i>${paused ? 'PAUSED' : 'REC'} <time data-since="${esc(item.startedAt)}"
    data-off="${item.pausedSeconds || 0}" data-until="${esc(item.pausedAt ?? '')}"></time></span>`;
}

function card(item, { upNext = false } = {}) {
  const frac = playable(item) ? progress.fraction(item.id) : 0;
  let badges = '';
  if (item.status === 'recording' || item.status === 'paused') badges += liveBadge(item);
  else if (item.status === 'log') badges += `<span class="badge rec ${item.playing}"><i></i>${item.playing === 'paused' ? 'PAUSED' : 'PLAYING'}</span>`;
  else if (item.status === 'saving') badges += '<span class="badge saving"><i></i>Saving</span>';
  else if (upNext) badges += '<span class="badge next">Up next</span>';
  if (item.duration) badges += `<span class="badge time">${clock(item.duration)}</span>`;
  if (frac >= 0.95) badges += `<span class="badge watched" title="Watched">${ICONS.check}</span>`;
  else if (frac > 0.02) badges += `<span class="progress"><i style="width:${(frac * 100).toFixed(1)}%"></i></span>`;

  const text = `
    <div class="card-text">
      <h3 title="${esc(item.title)}">${esc(item.title)}</h3>
      <p>${esc(subtitleOf(item)) || '&nbsp;'}</p>
      ${item.status === 'log' ? `<p class="why">${esc(item.why)}</p>` : ''}
      <p class="muted">${esc(dateLabel(item)) || '&nbsp;'}</p>
    </div>`;

  if (!watchable(item)) {
    const note = item.status === 'recording' ? 'Recording now. It can be played once it stops.'
      : item.status === 'paused' ? 'Paused. Recording picks up in the same file when it plays again.'
      : item.status === 'log' ? `In progress in the log. ${item.note}`
      : 'Finishing up. It can be played in a moment.';
    return `<article class="card is-live${item.status === 'log' ? ' is-log' : ''}" title="${esc(note)}"><div class="thumb">${artwork(item)}${badges}</div>${text}</article>`;
  }
  return `
    <article class="card">
      <a class="card-link" href="/watch/${item.id}" data-nav aria-label="Play ${esc(item.title)} ${esc(subtitleOf(item))}">
        <div class="thumb">${artwork(item)}${badges}<span class="play">${ICONS.play}</span></div>
        ${text}
      </a>
      <button class="copy-mini" type="button" data-copy="${item.id}" title="Copy link" aria-label="Copy link to ${esc(item.title)}">${ICONS.link}</button>
      ${playable(item) ? `<button class="copy-mini delete-mini" type="button" data-delete="${item.id}" title="Delete" aria-label="Delete ${esc(item.title)} ${esc(subtitleOf(item))}">${ICONS.trash}</button>` : ''}
    </article>`;
}

// Each TV show is one card, collapsed until it's clicked. Open, it shows a card
// per season, and an open season shows its episodes (and their parts) in
// order; movies and anything else stay single cards. A show sits where its
// first episode falls in the chosen sort. Currently Recording lists every
// recording on its own, nothing grouped.
function libraryGrid(items) {
  if (state.kind === 'recording') return items.map((it) => card(it)).join('');
  const opened = openSets();
  const shows = new Map(); // title -> its episodes
  const order = []; // items and show titles, in display order
  for (const item of items) {
    if (item.kind !== 'tv') {
      order.push(item);
      continue;
    }
    if (!shows.has(item.title)) {
      shows.set(item.title, []);
      order.push(item.title);
    }
    shows.get(item.title).push(item);
  }
  return order.map((it) => (typeof it === 'string' ? showCard(it, shows.get(it), opened) : card(it))).join('');
}

// Which shows and seasons are open: the library's (this visit only), or, while
// searching, the search's own, which start out closed for every new search.
function openSets() {
  const query = $('#search').value.trim();
  if (!query) return { shows: state.open, seasons: state.openSeasons };
  if (state.search.query !== query) state.search = { query, shows: new Set(), seasons: new Set() };
  return state.search;
}

function showCard(title, episodes, opened) {
  const open = opened.shows.has(title);
  const inOrder = [...episodes].sort(episodeOrder);
  const seasons = new Map(); // season -> its episodes, in order
  for (const it of inOrder) {
    if (!seasons.has(it.season)) seasons.set(it.season, []);
    seasons.get(it.season).push(it);
  }
  const count = episodeCount(episodes);
  const first = episodeCode(inOrder[0]);
  const last = episodeCode(inOrder.at(-1));
  const sub = count === 1 ? subtitleOf(inOrder[0])
    : `${count} episodes${first && last ? ` · ${first} – ${last}` : ''}`;
  // Every season the show has (from the site, as the phone page last saw it), recorded or not.
  const known = state.catalog[title];
  for (const season of known?.seasons ?? []) if (!seasons.has(season)) seasons.set(season, []);
  const allSeasons = [...seasons].sort(([a], [b]) => (a ?? 1e9) - (b ?? 1e9));
  const panel = allSeasons.map(([season, eps]) => seasonCard(title, season, eps, opened)).join('');
  const recordedSeasons = [...seasons.values()].filter((eps) => eps.length).length;
  return groupCard({
    kind: 'show', key: title, open, lead: episodes[0], name: title, sub, // episodes[0]: first in the chosen sort
    badge: known ? `${recordedSeasons} of ${plural(seasons.size, 'season')}` : plural(seasons.size, 'season'), live: episodes,
    panel: open && `<div class="episodes" role="group" aria-label="${esc(title)} seasons">${panel}</div>`,
  });
}

function seasonCard(title, season, episodes, opened) {
  const key = `${title}|${season ?? ''}`;
  const open = opened.seasons.has(key);
  // Every episode the season has, recorded or not (from the site's list).
  const known = (state.catalog[title]?.episodes ?? {})[season] ?? [];
  const have = new Set(episodes.map((it) => it.episode));
  const missing = known.filter(([n]) => !have.has(n));
  const total = new Set([...have, ...known.map(([n]) => n)]).size;
  if (!episodes.length) return emptySeasonCard(title, season, key, open, missing);
  const inSeason = [...episodes.map((it) => [it.episode ?? 0, card(it)]), ...missing.map(([n, name]) => [n, missingCard(title, season, n, name)])]
    .sort(([a], [b]) => a - b).map(([, html]) => html).join('');
  const count = episodeCount(episodes);
  const ep = (it) => (it.episode != null ? `E${String(it.episode).padStart(2, '0')}` : '');
  const sub = count === 1 ? subtitleOf(episodes[0]) : `${ep(episodes[0])} – ${ep(episodes.at(-1))}`;
  const newest = [...episodes].sort((a, b) => (whenOf(b) ?? 0) - (whenOf(a) ?? 0))[0];
  return groupCard({
    kind: 'season', key, open, lead: newest, name: season != null ? `Season ${season}` : 'Other episodes', sub,
    badge: known.length ? `${count} of ${plural(total, 'episode')}` : plural(count, 'episode'), live: episodes, picture: false, // only shows and episodes have pictures
    panel: open && `<div class="season-episodes" role="group" aria-label="${esc(title)} season ${esc(season ?? '')} episodes">
      ${inSeason}</div>`,
  });
}

// A season with nothing recorded yet: its name and how many episodes it has; open, its episodes.
function emptySeasonCard(title, season, key, open, missing) {
  return `
    <article class="card show season no-picture not-recorded${open ? ' open' : ''}">
      <button class="card-link" type="button" data-season="${esc(key)}" aria-expanded="${open}"
        aria-label="Season ${esc(season)}, not recorded. ${open ? 'Hide' : 'Show'} episodes">
        <div class="card-text">
          <h3><span class="name">Season ${esc(season)}</span><span class="chevron">${ICONS.chevron}</span></h3>
          ${missing.length ? `<p class="badges"><span class="badge time">${plural(missing.length, 'episode')}</span></p>` : ''}
          <p>Not recorded</p>
          <p class="muted">&nbsp;</p>
        </div>
      </button>
    </article>
    ${open ? `<div class="season-episodes" role="group" aria-label="${esc(title)} season ${esc(season)} episodes">
      ${missing.length ? missing.map(([n, name]) => missingCard(title, season, n, name)).join('')
        : `<p class="hint season-unknown">${state.catalog[title]?.lookupFailed
          ? 'Couldn\'t reach the site for its episodes just now. Trying again in a few minutes…'
          : 'Looking up its episodes on the site…'}</p>`}</div>` : ''}`;
}

// An episode not recorded: the generic picture, and Request (sends it to the VCR).
function missingCard(title, season, episode, name) {
  const code = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
  const ask = esc(JSON.stringify({ title, season, episode, name }));
  return `
    <article class="card missing">
      <div class="card-link">
        <div class="thumb">${artwork({ title, kind: 'tv', thumb: state.catalog[title]?.poster })}</div>
        <div class="card-text">
          <h3 title="${esc(title)}">${esc(title)}</h3>
          <p>${esc([code, name].filter(Boolean).join(' · '))}</p>
          <p class="muted">Not recorded</p>
        </div>
      </div>
      <button class="btn request-btn" type="button" data-request="${ask}">Request</button>
    </article>`;
}

// A card that opens and closes (a show or a season), followed by what it holds
// when open. Without a picture (seasons), its badges go with the text.
function groupCard({ kind, key, open, lead, name, sub, badge, live, panel, picture = true }) {
  const now = live.find(isRecording) ?? live.find((it) => it.status === 'log');
  let badges = '';
  if (now?.status === 'log') badges += `<span class="badge rec ${now.playing}"><i></i>${now.playing === 'paused' ? 'PAUSED' : 'PLAYING'}</span>`;
  else if (now) badges += liveBadge(now);
  badges += `<span class="badge time">${badge}</span>`;
  return `
    <article class="card show ${kind}${open ? ' open' : ''}${picture ? '' : ' no-picture'}">
      <button class="card-link" type="button" data-${kind}="${esc(key)}" aria-expanded="${open}"
        aria-label="${esc(name)}, ${esc(badge)}. ${open ? 'Hide' : 'Show'} ${kind === 'show' ? 'seasons' : 'episodes'}">
        ${picture ? `<div class="thumb">${artwork(lead, { title: true })}${badges}</div>` : ''}
        <div class="card-text">
          <h3 title="${esc(name)}"><span class="name">${esc(name)}</span><span class="chevron">${ICONS.chevron}</span></h3>
          ${picture ? '' : `<p class="badges">${badges}</p>`}
          <p>${esc(sub) || '&nbsp;'}</p>
          <p class="muted">${esc(dateLabel(lead)) || '&nbsp;'}</p>
        </div>
      </button>
    </article>
    ${panel || ''}`;
}

const episodeCount = (items) => new Set(items.map((it) => `${it.season} ${it.episode} ${it.episodeName}`)).size; // parts count once
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function emptyState(title, body, extra = '') {
  return `<div class="icon">${ICONS.film}</div><h2>${esc(title)}</h2><p>${body}</p>${extra}`;
}

// Why an empty library is empty even though the watched log has entries.
function emptyLogNote() {
  const s = state.settings;
  const count = s?.logInfo?.entries;
  if (!count) return 'New recordings appear here on their own as soon as the recorder sees a <code>start play</code> entry.';
  return `<code>${esc(basename(s.log))}</code> has ${count} ${count === 1 ? 'entry' : 'entries'}, but nothing in it is playing
    right now: every start already has its stop, and those finished before the recorder was watching. New
    <code>start play</code> entries are recorded and show up here right away.`;
}

// ---------------------------------------------------------------------------
// Library view

function renderLibrary() {
  document.title = 'Recordings';
  const query = $('#search').value.trim();
  // The chips filter (Currently Recording, TV, Movies); with none pressed, everything shows.
  // TV and Movies are what's been recorded: anything still recording (or only playing) is under Currently Recording.
  const ofKind = (kind) => (it) => kind === 'all' || (kind === 'recording' ? isRecording(it)
    : it.kind === kind && !isRecording(it) && it.status !== 'log');
  const byKind = state.items.filter(ofKind(state.kind));
  const results = sortItems(byKind.filter((it) => matches(it, query)));

  for (const chip of document.querySelectorAll('.chip')) {
    const kind = chip.dataset.kind;
    chip.setAttribute('aria-pressed', String(kind === state.kind));
    const matching = state.items.filter(ofKind(kind));
    // TV counts shows (each is one card), not episodes.
    chip.querySelector('span').textContent = kind === 'tv' ? new Set(matching.map((it) => it.title)).size : matching.length;
  }

  // Continue watching: started but not finished, most recently watched first.
  const resume = query ? [] : byKind
    .filter((it) => playable(it) && progress.fraction(it.id) > 0.02 && progress.fraction(it.id) < 0.95)
    .sort((a, b) => (progress.get(b.id)?.at ?? 0) - (progress.get(a.id)?.at ?? 0))
    .slice(0, 4);
  $('#continue').hidden = !resume.length;
  setHtml($('#continue-grid'), resume.map((it) => card(it)).join(''));

  const kindName = { all: 'All recordings', recording: 'Currently recording', tv: 'TV', movie: 'Movies' }[state.kind] ?? 'All recordings';
  // A heading only for a search (how many it found); the list itself needs none.
  $('#grid-title').hidden = !query;
  $('#grid-title').textContent = query ? `${results.length} ${results.length === 1 ? 'result' : 'results'} for “${query}”` : '';
  setHtml($('#grid'), libraryGrid(results));

  const empty = $('#empty');
  empty.hidden = results.length > 0 || !state.loaded;
  if (!empty.hidden) {
    empty.innerHTML = query
      ? emptyState('No matches', `Nothing matches “${esc(query)}”. Try a show name, an episode like <code>s1e2</code>, or a date.`,
        `<div class="empty-actions"><button class="btn primary" type="button" id="add-content">${ICONS.plus} Add Content</button>
          <button class="btn" type="button" id="clear-search">Clear search</button></div>`)
      : state.kind === 'recording'
        ? emptyState('Nothing is recording right now', 'Anything the log says is playing shows up here while it records.')
      : state.items.length
        ? emptyState(`No ${kindName.toLowerCase()} yet`, 'Recordings of this type will show up here.')
        : emptyState('No recordings yet', emptyLogNote());
  }
  tick();
}

// ---------------------------------------------------------------------------
// Watch view

function renderWatch(id) {
  const item = state.items.find((it) => it.id === id);
  $('#w-missing').hidden = Boolean(item) || !state.loaded;
  $('#w-main').hidden = !item;
  if (!item) {
    stopVideo();
    document.title = 'Recordings';
    return;
  }

  const code = episodeCode(item);
  document.title = `${item.title}${code ? ` ${code}` : ''} · Recordings`;
  $('#ambient').style.backgroundImage = item.thumb ? `url('${item.thumb}')` : '';

  // Player: only touch the video when the recording itself changes.
  const note = $('#player-note');
  if (watchable(item)) {
    note.hidden = true;
    if (currentId !== item.id) {
      currentId = item.id;
      hideEndcard();
      if (pictureOf(item)) video.poster = pictureOf(item);
      else video.removeAttribute('poster');
      loadMedia(item);
    } else if (video.dataset.live && !item.live) {
      // It finished while you were watching: carry on in the saved file, same spot (the
      // WebM copy still has the room-connecting start that the saved file doesn't).
      const offset = video.dataset.hls ? 0 : liveLeadIn;
      loadMedia(item, { at: Math.max(0, video.currentTime - offset), play: !video.paused || video.ended });
    }
    if (item.live) liveLeadIn = item.leadIn || 0;
    renderLiveBar(item);
  } else {
    stopVideo();
    $('#live-bar').hidden = true;
    note.hidden = false;
    note.innerHTML = item.status === 'recording'
      ? `${liveBadge(item)}<h2>Recording in progress</h2><p>This page will start playing once the recording stops and is saved.</p>`
      : item.status === 'paused'
      ? `${liveBadge(item)}<h2>Paused</h2><p>The show is paused, so the recording is too. It picks up in the same file when the show plays again, and the pause is left out.</p>`
      : item.status === 'log'
      ? `<h2>${esc(item.why)}</h2><p>This is in progress in the log, but there's no recording of it. ${esc(item.note)}</p>`
      : '<span class="badge saving"><i></i>Saving</span><h2>Almost ready</h2><p>The recording is being converted. It will appear here in a moment.</p>';
  }

  $('#w-eyebrow').textContent = item.kind === 'movie' ? 'Movie'
    : item.kind === 'tv' ? ['TV', item.season != null && `Season ${item.season}`, item.episode != null && `Episode ${item.episode}`].filter(Boolean).join(' · ')
    : 'Recording';
  $('#w-title').textContent = item.title;
  const subtitle = [item.episodeName, item.part > 1 && `Part ${item.part}`].filter(Boolean).join(' · ');
  $('#w-subtitle').textContent = subtitle;
  $('#w-subtitle').hidden = !subtitle;

  const when = whenOf(item);
  const facts = [
    when && dateFmt.format(when),
    when && timeFmt.format(when),
    item.duration && longDuration(item.duration),
    item.height && `${item.height}p`,
    item.size && fileSize(item.size),
    item.room && `Room: ${item.room}`,
  ].filter(Boolean);
  $('#w-facts').innerHTML = facts.map((f) => `<li>${esc(f)}</li>`).join('');

  const link = `${location.origin}/watch/${item.id}`;
  $('#w-link').value = link;
  $('#w-copy').dataset.copy = item.id;
  $('#w-copy').disabled = false;
  const download = $('#w-download');
  download.hidden = !playable(item);
  download.href = playable(item) ? `${item.media}?download` : '';
  $('#w-delete').hidden = !playable(item);
  $('#w-delete').dataset.delete = item.id;
  $('#w-replay').hidden = !playable(item);
  // Still recording: watch its room live, or start it over on the VCR.
  const going = isRecording(item) && Boolean(item.room);
  $('#w-room').hidden = !going;
  $('#w-restart').hidden = !going;
  $('#w-restart').dataset.restart = item.id;
  if (going) $('#w-room').href = roomWatchLink(item.room, item.url);
  $('#w-replay').dataset.replay = item.id;

  // More from the same show (in episode order), otherwise other recent recordings.
  const next = nextAfter(item);
  let more = state.items.filter((it) => it.id !== item.id && it.title === item.title).sort(episodeOrder);
  let heading = `More from ${item.title}`;
  if (!more.length) {
    more = sortItems(state.items.filter((it) => it.id !== item.id), 'newest').slice(0, 8);
    heading = 'More recordings';
  } else if (next) {
    more = [next, ...more.filter((it) => it.id !== next.id)];
  }
  $('#w-more').hidden = !more.length;
  $('#w-more-title').textContent = heading;
  setHtml($('#w-more-grid'), more.map((it) => card(it, { upNext: it === next })).join(''));
  tick();
}

function stopVideo() {
  if (!currentId) return;
  saveProgress();
  currentId = null;
  clearTimeout(catchUpTimer);
  nextCopy = null;
  video.dataset.live = '';
  hideEndcard();
  video.pause();
  video.removeAttribute('src');
  video.removeAttribute('poster');
  video.load();
}

function saveProgress() {
  if (currentId && video.duration) progress.set(currentId, video.currentTime, video.duration, Boolean(video.dataset.live));
}

// A recording in progress plays a copy of what was there when it loaded
// (`at` asks the server for a fresh one); `at` here is where to continue.
let resumeAt = null;
let catchUpTimer;
let liveLeadIn = 0; // the room-connecting start of the recording in progress being watched
let nextCopy = null; // the `at` of a fresh copy already asked for ahead of the end (see below)
let lastCatchUp = 0;
// iPhones and iPads can't play the WebM a recording in progress is written as, so
// they get its live stream (HLS) instead, which keeps growing as it records.
const LIVE_HLS = Boolean(video.canPlayType('application/vnd.apple.mpegurl'));
function loadMedia(item, { at = null, play = true } = {}) {
  clearTimeout(catchUpTimer);
  video.dataset.live = item.live ? '1' : '';
  video.dataset.hls = item.live && LIVE_HLS ? '1' : '';
  resumeAt = at;
  const stamp = nextCopy ?? Date.now();
  nextCopy = null;
  video.src = !item.live ? item.media : LIVE_HLS ? `/hls/${item.id}/index.m3u8?at=${stamp}` : `${item.media}?at=${stamp}`;
  if (play) video.play().catch(() => {});
}

function catchUp() {
  const item = state.items.find((it) => it.id === currentId);
  lastCatchUp = Date.now();
  if (item?.live) loadMedia(item, { at: video.currentTime, play: !video.paused || video.ended });
}

// Watching a recording that's still going: 20 seconds before the end of what's loaded, the
// server is asked for a fresh copy (with everything recorded since), so it's ready by the end
// and playing carries straight on into the rest, all the way to where the recording is now.
video.addEventListener('timeupdate', () => {
  if (!video.dataset.live || video.dataset.hls || nextCopy || !(video.duration - video.currentTime < 20)) return;
  const item = state.items.find((it) => it.id === currentId);
  if (item?.status !== 'recording') return;
  nextCopy = Date.now();
  fetch(`${item.media}?at=${nextCopy}`, { headers: { Range: 'bytes=0-0' } }).catch(() => {});
});

function renderLiveBar(item) {
  const bar = $('#live-bar');
  bar.hidden = !item.live;
  if (!item.live) return;
  const so = Number.isFinite(video.duration) && video.duration > 0 ? ` (${clock(video.duration)} so far)` : '';
  setHtml($('#live-badge'), item.status === 'saving' ? '<span class="badge saving"><i></i>Saving</span>' : liveBadge(item));
  $('#live-text').textContent = item.status === 'paused'
    ? `The show is paused. You're watching everything recorded before the pause${so}; it continues in this same recording when the show plays again.`
    : item.status === 'saving'
    ? `It's finished and being saved. You're watching it as it was${so}; the saved file takes over in a moment.`
    : `Still recording${so}. When you reach the end, what's been recorded since loads and keeps playing.`;
  $('#live-catchup').hidden = item.status === 'saving';
  $('#live-end').hidden = item.status === 'saving' || !item.room;
}
$('#live-catchup').addEventListener('click', catchUp);

// End: stops what's being recorded on the VCR (its room) and takes it out of the VCR's
// History; with its play gone from the log, the recorder drops the recording too.
$('#live-end').addEventListener('click', async () => {
  const item = state.items.find((it) => it.id === currentId);
  if (!item) return;
  const name = [item.title, episodeCode(item), item.episodeName].filter(Boolean).join(' ');
  if (!confirm(`End ${name}?\n\nIt stops playing on the VCR${item.room ? ` (room ${item.room})` : ''} on every screen, and it's taken out of History and Recordings.`)) return;
  $('#live-end').disabled = true;
  try {
    const res = await fetch('/api/end', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return toast(data.error ?? 'Couldn\'t end it.');
    stopVideo();
    navigate('/', { replace: true });
    toast('Ended, and taken out of History and Recordings');
    refresh();
  } catch {
    toast('Couldn\'t reach the dashboard server.');
  } finally {
    $('#live-end').disabled = false;
  }
});

let lastSave = 0;
video.addEventListener('timeupdate', () => {
  if (Date.now() - lastSave > 3000) {
    lastSave = Date.now();
    saveProgress();
  }
});
video.addEventListener('pause', saveProgress);
// A live stream that isn't ready yet (the show's sound hasn't started): try again shortly.
video.addEventListener('error', () => {
  const item = state.items.find((it) => it.id === currentId);
  if (!video.dataset.hls || !item?.live) return;
  toast('Getting the live recording ready…');
  clearTimeout(catchUpTimer);
  catchUpTimer = setTimeout(() => loadMedia(item, { at: resumeAt ?? video.currentTime }), 5000);
});
video.addEventListener('loadedmetadata', () => {
  const item = state.items.find((it) => it.id === currentId);
  if (item?.live) renderLiveBar(item); // shows how much is there so far
  if (resumeAt != null) {
    // A fresh copy with nothing new yet (you're right behind the recording): try again shortly.
    if (video.dataset.live && item?.status === 'recording' && resumeAt >= video.duration - 1.5) {
      catchUpTimer = setTimeout(catchUp, 10_000);
    }
    video.currentTime = Math.min(resumeAt, video.duration || resumeAt);
    resumeAt = null;
    return;
  }
  const saved = progress.get(currentId);
  // A recording in progress played from its WebM copy starts at the room connecting:
  // skip to where the show's sound starts (the saved file is cut there).
  if (item?.live && !video.dataset.hls && item.leadIn && !(saved?.time > 10)) {
    video.currentTime = item.leadIn;
    return;
  }
  if (saved && saved.time > 10 && saved.time < video.duration * 0.95) {
    video.currentTime = saved.time;
    toast(`Resumed at ${clock(saved.time)}`, { label: 'Start over', run: () => { video.currentTime = 0; video.play().catch(() => {}); } });
  }
});
video.addEventListener('ended', () => {
  const item = state.items.find((it) => it.id === currentId);
  if (video.dataset.live) {
    // The end of what's recorded so far, not of the show.
    saveProgress();
    if (item?.status === 'recording') {
      // Straight on into what's been recorded since; if that was just tried, it's still
      // right behind the recording, so wait a little for more.
      clearTimeout(catchUpTimer);
      if (Date.now() - lastCatchUp > 8000) catchUp();
      else {
        toast('You\'ve caught up with the recording. More will play as it\'s recorded.');
        catchUpTimer = setTimeout(catchUp, 10_000);
      }
    } else {
      toast('You\'ve watched everything recorded so far.');
    }
    return;
  }
  if (currentId) progress.set(currentId, video.duration, video.duration);
  const next = item && nextAfter(item);
  if (next) showEndcard(next);
});

function showEndcard(next) {
  const endcard = $('#endcard');
  let remaining = 8;
  endcard.hidden = false;
  endcard.innerHTML = `
    <p class="eyebrow">Up next</p>
    <div class="endcard-art">${artwork(next)}</div>
    <h2>${esc(next.title)}</h2>
    <p>${esc(subtitleOf(next))}</p>
    <p class="muted">Playing in <span id="countdown">${remaining}</span>s</p>
    <div class="actions">
      <a class="btn primary" href="/watch/${next.id}" data-nav>${ICONS.play.replace('<svg', '<svg class="fill"')} Play now</a>
      <button class="btn" type="button" id="cancel-next">Cancel</button>
    </div>`;
  $('#cancel-next').addEventListener('click', hideEndcard);
  endTimer = setInterval(() => {
    remaining -= 1;
    const counter = $('#countdown');
    if (counter) counter.textContent = remaining;
    if (remaining <= 0) navigate(`/watch/${next.id}`);
  }, 1000);
}

function hideEndcard() {
  clearInterval(endTimer);
  endTimer = null;
  $('#endcard').hidden = true;
}

// ---------------------------------------------------------------------------
// Routing: /            library (with ?q= for searches)
//          /watch/<id>  one recording; this URL is the shareable link

function route() {
  const match = location.pathname.match(/^\/watch\/([a-f0-9]{12})$/);
  return match ? { view: 'watch', id: match[1] } : { view: 'library' };
}

function render() {
  const { view, id } = route();
  const query = new URLSearchParams(location.search).get('q') ?? '';
  const search = $('#search');
  if (view === 'library' && search.value !== query) search.value = query;

  $('#library-view').hidden = view !== 'library';
  $('#watch-view').hidden = view !== 'watch';
  if (view === 'watch') {
    $('.back').setAttribute('href', libraryUrl);
    renderWatch(id);
  } else {
    libraryUrl = location.pathname + location.search;
    stopVideo();
    renderLibrary();
  }
}

function navigate(url, { replace = false } = {}) {
  hideEndcard();
  if (url !== location.pathname + location.search) history[replace ? 'replaceState' : 'pushState'](null, '', url);
  render();
  if (!replace) window.scrollTo({ top: 0 });
}

window.addEventListener('popstate', render);
window.addEventListener('pagehide', saveProgress);

document.addEventListener('click', async (event) => {
  const group = event.target.closest('[data-show], [data-season]');
  if (group) {
    const opened = openSets();
    const [attr, set, key] = group.dataset.show != null
      ? ['data-show', opened.shows, group.dataset.show]
      : ['data-season', opened.seasons, group.dataset.season];
    if (!set.delete(key)) set.add(key);
    if (attr === 'data-show') {
      // A show opens with all its seasons closed (closing it forgets which were open).
      for (const season of [...opened.seasons]) if (season.startsWith(`${key}|`)) opened.seasons.delete(season);
    }
    renderLibrary();
    document.querySelector(`[${attr}="${CSS.escape(key)}"]`)?.focus(); // the grid was redrawn
    return;
  }
  const del = event.target.closest('[data-delete]');
  if (del) {
    event.preventDefault();
    deleteRecording(del.dataset.delete);
    return;
  }
  const copy = event.target.closest('[data-copy]');
  if (copy) {
    event.preventDefault();
    const link = `${location.origin}/watch/${copy.dataset.copy}`;
    toast((await copyText(link)) ? 'Link copied' : link);
    return;
  }
  if (event.target.closest('#add-content')) {
    // Same as tapping + and searching the VCR for what was typed here.
    addContent($('#search').value.trim());
    return;
  }
  if (event.target.closest('#clear-search')) {
    navigate('/', { replace: true });
    $('#search').focus();
    return;
  }
  const link = event.target.closest('a[data-nav]');
  if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(link.getAttribute('href'));
});

$('#search').addEventListener('input', (event) => {
  const query = event.target.value;
  const url = query.trim() ? `/?q=${encodeURIComponent(query)}` : '/';
  // Typing on the watch page takes you back to the library with the results.
  navigate(url, { replace: route().view === 'library' });
});

for (const chip of document.querySelectorAll('.chip')) {
  chip.addEventListener('click', () => {
    state.kind = state.kind === chip.dataset.kind ? 'all' : chip.dataset.kind; // pressing it again shows everything
    renderLibrary();
  });
}


$('#w-link').addEventListener('focus', (event) => event.target.select());

// Keyboard: "/" search, Esc back, and the usual player keys on the watch page.
document.addEventListener('keydown', (event) => {
  const typing = event.target.closest('input, textarea, select, [contenteditable]');
  if ($('#settings').open) return;
  if (event.key === '/' && !typing) {
    event.preventDefault();
    $('#search').focus();
    $('#search').select();
    return;
  }
  if (event.key === 'Escape' && event.target === $('#search')) {
    if ($('#search').value) navigate('/', { replace: true });
    $('#search').blur();
    return;
  }
  if (typing || event.metaKey || event.ctrlKey || event.altKey || route().view !== 'watch' || !video.src) return;
  const onButton = event.target.closest('button, a');
  const actions = {
    ' ': () => !onButton && (video.paused ? video.play() : video.pause()),
    k: () => (video.paused ? video.play() : video.pause()),
    j: () => { video.currentTime -= 10; },
    l: () => { video.currentTime += 10; },
    ArrowLeft: () => { video.currentTime -= 5; },
    ArrowRight: () => { video.currentTime += 5; },
    m: () => { video.muted = !video.muted; },
    f: () => (document.fullscreenElement ? document.exitFullscreen() : video.requestFullscreen()),
    Escape: () => !document.fullscreenElement && navigate(libraryUrl),
  };
  const action = actions[event.key];
  if (action && event.target !== video) {
    if (event.key === ' ' && onButton) return;
    event.preventDefault();
    Promise.resolve(action()).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Recorder settings

const dialog = $('#settings');

$('#status-pill').addEventListener('click', () => {
  renderSettings({ fillInput: true });
  dialog.showModal();
  $('#s-log').focus();
  loadPreview({ jump: true });
  previewTimer = setInterval(loadPreview, 1500);
});
dialog.addEventListener('close', () => clearInterval(previewTimer));
$('#s-close').addEventListener('click', () => dialog.close());
$('#s-diagnostics').addEventListener('click', copyDiagnostics);
dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
$('#s-save').addEventListener('click', saveSettings);
$('#s-log').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    saveSettings();
  }
});
$('#s-suggestions').addEventListener('click', (event) => {
  const button = event.target.closest('[data-file]');
  if (!button) return;
  $('#s-log').value = button.dataset.file;
  saveSettings();
});

// Opened through the public link: the Mac's other pages go through their public links too
// (the VCR on port 10000, the rooms' screens under /tv/).
const GUEST = document.documentElement.hasAttribute('data-guest');
// Log out (the public link only; home links never ask for the code): forgets the passcode
// on this device and reloads, so the page asks for it again.
$('#s-logout').hidden = !GUEST;
$('#s-logout').addEventListener('click', async () => {
  try {
    await fetch('/api/guest-logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  } catch {}
  location.reload();
});

async function loadSettings() {
  try {
    const res = await fetch('/api/settings', { cache: 'no-store' });
    state.settings = await res.json();
    renderSettings();
  } catch {}
}

async function saveSettings() {
  const info = $('#s-file-info');
  const button = $('#s-save');
  button.disabled = true;
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ log: $('#s-log').value }),
    });
    const data = await res.json();
    if (!res.ok) {
      info.className = 'hint error';
      info.textContent = data.error ?? 'Could not save.';
      return;
    }
    state.settings = data;
    renderSettings({ fillInput: true });
    loadPreview({ jump: true });
    toast(`Now watching ${basename(data.log)}`);
  } catch {
    info.className = 'hint error';
    info.textContent = 'Could not reach the dashboard server.';
  } finally {
    button.disabled = false;
  }
}

// Live view of the watched log, refreshed while the sheet is open. It stays
// scrolled to the newest entries unless you've scrolled up to read.
let previewTimer;
let previewText = null;
// Opened: fill it straight away (it isn't fetched while collapsed).
$('#s-preview-box').addEventListener('toggle', () => { if ($('#s-preview-box').open) loadPreview({ jump: true }); });

async function loadPreview({ jump = false } = {}) {
  if (!$('#s-preview-box').open) return; // collapsed: nothing to show
  const box = $('#s-preview');
  try {
    const res = await fetch('/api/log', { cache: 'no-store' });
    const data = await res.json();
    const text = data.text ?? '';
    $('#s-preview-info').textContent = !data.exists ? 'file not found'
      : `${data.truncated ? `last ${size(text.length)} of ` : ''}${size(data.size)} · live`;
    box.placeholder = data.exists ? '(the file is empty)' : 'This file doesn\'t exist yet.';
    if (text === previewText && !jump) return;
    const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 12;
    previewText = text;
    box.value = text;
    if (jump || atEnd) box.scrollTop = box.scrollHeight;
  } catch {
    $('#s-preview-info').textContent = 'can\'t reach the dashboard server';
  }
}

function size(n) {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function copyDiagnostics() {
  const button = $('#s-diagnostics');
  button.disabled = true;
  const text = fetch('/api/diagnostics', { cache: 'no-store' })
    .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .catch((err) => `Couldn't get diagnostics from the dashboard server: ${err.message}\n`)
    .then((report) => `${report}\n## This browser\n${navigator.userAgent}\nPage: ${location.href}\n`);
  let ok = false;
  try {
    // Handing over the text while it's still loading keeps Safari treating the
    // copy as part of the click.
    await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text.then((t) => new Blob([t], { type: 'text/plain' })) })]);
    ok = true;
  } catch {
    ok = await copyText(await text);
  }
  button.disabled = false;
  toast(ok ? 'Diagnostics copied. Paste them into a message.' : 'Couldn\'t copy. Open /api/diagnostics and copy from there.');
}

const basename = (file) => String(file).split('/').pop();
const tilde = (file) => String(file).replace(/^\/Users\/[^/]+/, '~');

function renderSettings({ fillInput = false } = {}) {
  const s = state.settings;
  if (!s) return;
  // Space left: a bar for the SD card (where recordings end up) and one for this Mac.
  const gb = (b) => `${(b / 1e9).toFixed(b < 10e9 ? 1 : 0)} GB`;
  // Collapsed, its row still says how much is free on each.
  $('#s-space-info').textContent = (s.space ?? []).map((d) => `${d.label === 'This Mac' ? 'Mac' : d.label}: ${d.missing ? 'not in' : `${gb(d.free)} free`}`).join(' · ');
  setHtml($('#s-space'), (s.space ?? []).map((d) => d.missing
    ? `<div class="space-row"><div class="space-top"><b>${esc(d.label)}</b><span class="hint warn">not plugged in</span></div></div>`
    : `<div class="space-row${d.free / d.total < 0.1 ? ' low' : ''}">
        <div class="space-top"><b>${esc(d.label)}</b><span><strong>${gb(d.free)}</strong> free of ${gb(d.total)}</span></div>
        <div class="space-bar"><i style="width:${(100 * (1 - d.free / d.total)).toFixed(1)}%"></i></div>
        ${d.label === 'SD card' ? `<button class="space-more" type="button" data-storage>${esc(d.note)} · see what's using it ›</button>`
          : d.label === 'This Mac' ? `<button class="space-more" type="button" data-mac-trash aria-expanded="${macTrashOpen}">${esc(d.note)} · Trash ${macTrashOpen ? '▾' : '›'}</button>
            ${macTrashOpen ? `<div class="mac-trash"><span>${d.trash == null ? 'The Trash on this Mac' : d.trash ? `<b>${sizeText(d.trash)}</b> in this Mac's Trash` : 'This Mac\'s Trash is empty'}</span>
              ${d.trash === 0 ? '' : '<button class="btn danger" type="button" data-empty-mac-trash>Empty trash</button>'}</div>` : ''}`
          : `<p class="hint">${esc(d.note)}</p>`}
      </div>`).join(''));
  const { recorder, logInfo } = s;
  const recording = recorder.recording.length;
  const allPaused = recording > 0 && (recorder.paused ?? []).length === recording;

  // Top bar pill
  $('#status-pill .dot').className = `dot ${allPaused ? 'paused' : recording ? 'rec' : recorder.running ? 'on' : ''}`;
  // The button just says Settings; its dot (and tooltip) says what the recorder is doing.
  $('#status-text').textContent = 'Settings';
  const doing = !recorder.running ? 'Recorder off'
    : recording ? `${allPaused ? 'Paused' : 'Recording'} ${recording === 1 ? recorder.recording[0] : `${recording} shows`}`
    : `Watching ${basename(s.log)}`;
  $('#status-pill').title = `${doing}. Click to change which JSON log it watches, or to copy diagnostics.`;

  if (!dialog.open && !fillInput) return;
  if (fillInput) $('#s-log').value = tilde(s.log);

  const status = $('#s-status');
  if (!recorder.running) {
    status.innerHTML = '<i class="dot"></i><span>Recorder isn\'t running. Start it with <code>npm run autostart:on</code> in ~/Desktop/Recording.</span>';
  } else if (recorder.watching !== s.log) {
    status.innerHTML = '<i class="dot on"></i><span>Running · switching to the new file…</span>';
  } else {
    const since = recorder.startedAt ? ` since ${timeFmt.format(new Date(recorder.startedAt))}` : '';
    const paused = new Set(recorder.paused ?? []);
    const names = recorder.recording.map((name) => (paused.has(name) ? `${name} (paused)` : name));
    const now = recording ? ` · recording ${esc(names.join(', '))}` : ' · waiting for a start entry';
    status.innerHTML = `<i class="dot ${allPaused ? 'paused' : recording ? 'rec' : 'on'}"></i><span>Running${since}${now}</span>`;
  }

  const info = $('#s-file-info');
  if (!logInfo.exists) {
    info.className = 'hint warn';
    info.textContent = 'This file doesn\'t exist yet. The recorder will wait for it to appear.';
  } else if (logInfo.entries == null) {
    info.className = 'hint warn';
    info.textContent = `Found, but it isn't a JSON list of entries right now (updated ${relative(new Date(logInfo.modified))}).`;
  } else {
    info.className = 'hint ok';
    info.textContent = `✓ Found · ${logInfo.entries} ${logInfo.entries === 1 ? 'entry' : 'entries'} · updated ${relative(new Date(logInfo.modified))}`;
  }

  $('#s-suggest-wrap').hidden = !s.suggestions.length;
  $('#s-suggest-info').textContent = `${s.suggestions.length} found`;
  setHtml($('#s-suggestions'), s.suggestions.map((file) => `
    <button class="suggestion ${file === s.log ? 'current' : ''}" type="button" data-file="${esc(file)}" title="${esc(file)}">
      <span><b>${esc(basename(file))}</b><em>${esc(tilde(file.slice(0, -basename(file).length - 1)))}</em></span>
      <small>${file === s.log ? 'Watching' : 'Use this'}</small>
    </button>`).join(''));
}

// Replaces an element's content only when it changed, so periodic refreshes
// don't rebuild what you're about to click (or reload its images).
function setHtml(el, html) {
  if (el.dataset.html === html) return;
  el.dataset.html = html;
  el.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Utilities

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Not available over plain http on another device; fall back to a selection copy.
    const area = Object.assign(document.createElement('textarea'), { value: text });
    area.style.cssText = 'position:fixed;opacity:0';
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    area.remove();
    return ok;
  }
}

let toastTimer;
function toast(message, action) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(message)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  if (action) el.querySelector('button').addEventListener('click', () => { action.run(); el.classList.remove('show'); });
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? 6000 : 2600);
}

// Live "REC 12:34" counters: time since it started, minus finished pauses
// (data-off, seconds), standing still during a pause (data-until).
function tick() {
  for (const el of document.querySelectorAll('time[data-since]')) {
    const since = Date.parse(el.dataset.since);
    const until = el.dataset.until ? Date.parse(el.dataset.until) : Date.now();
    el.textContent = Number.isNaN(since) ? '' : clock(Math.max(0, (until - since) / 1000 - Number(el.dataset.off || 0)));
  }
}

// A room's screen, on the network this page was opened on: the public link (/tv/), Tailscale,
// or the home Wi-Fi.
function roomWatchLink(room, lanLink) {
  const host = location.hostname, code = encodeURIComponent(room);
  if (GUEST) return `https://${host}/tv/#tv=${code}`;
  if (/\.ts\.net$/i.test(host) || /^100\./.test(host)) return `http://${host}:8765/#tv=${code}`;
  return lanLink || `http://${host}:8765/#tv=${code}`;
}

// The + sheet following a run the VCR was just asked for, until it's playing.
function vaFollow(pid, room, text) {
  vaReset();
  Object.assign(va, { pid, room, picked: true });
  $('#va-form').hidden = true;
  $('#va-open-vcr').hidden = true;
  vaStatus(text);
  vaWait('Opening it on the Mac…');
  vaDialog.showModal();
  vaPoll(va.run);
}

// Restart (still recording): the recording so far is dropped and the play taken out of
// History (its room ends), then the VCR plays the same episode again from the start.
$('#w-restart').addEventListener('click', async () => {
  const item = state.items.find((it) => it.id === $('#w-restart').dataset.restart);
  if (!item) return;
  const name = [item.title, episodeCode(item), item.episodeName].filter(Boolean).join(' ');
  if (!confirm(`Restart ${name}?\n\nThis recording is cancelled and room ${item.room} ends, then the VCR plays it again from the start in a new room and it's recorded fresh.`)) return;
  $('#w-restart').disabled = true;
  try {
    const res = await fetch('/api/restart', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return toast(data.error ?? 'Couldn\'t restart it.');
    stopVideo();
    navigate('/', { replace: true });
    vaFollow(data.pid, data.room, `Restarting ${name} in room ${data.room}…`);
    refresh();
  } catch {
    toast('Couldn\'t reach the dashboard server.');
  } finally {
    $('#w-restart').disabled = false;
  }
});

// Replay: delete this recording (and its play in the VCR's History), then have the VCR
// play the same episode again from the start in a new room, recorded afresh. The +
// sheet follows it until it's playing.
$('#w-replay').addEventListener('click', async () => {
  const item = state.items.find((it) => it.id === $('#w-replay').dataset.replay);
  if (!item) return;
  const name = [item.title, episodeCode(item), item.episodeName].filter(Boolean).join(' ');
  if (!confirm(`Replay ${name}?\n\nThis recording is deleted (to the Trash) and taken out of the VCR's History, then the VCR plays it again from the start in a new room and it's recorded fresh.`)) return;
  $('#w-replay').disabled = true;
  try {
    const res = await fetch('/api/replay', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return toast(data.error ?? 'Couldn\'t replay it.');
    stopVideo();
    navigate('/', { replace: true });
    vaReset();
    Object.assign(va, { pid: data.pid, room: data.room, picked: true });
    $('#va-form').hidden = true;
    $('#va-open-vcr').hidden = true;
    vaStatus(`Replaying ${name} in room ${data.room}…`);
    vaWait('Opening it on the Mac…');
    vaDialog.showModal();
    vaPoll(va.run);
    refresh();
  } catch {
    toast('Couldn\'t reach the dashboard server.');
  } finally {
    $('#w-replay').disabled = false;
  }
});

// Delete: the recording goes to this Mac's Trash and the play leaves the VCR's History too.
async function deleteRecording(id) {
  const item = state.items.find((it) => it.id === id);
  if (!item) return;
  const name = [item.title, episodeCode(item), item.episodeName].filter(Boolean).join(' ');
  if (!confirm(`Delete ${name}?\n\nThe recording goes to the Trash on the Mac, and this play is taken out of the VCR's History too.`)) return;
  try {
    const res = await fetch('/api/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return toast(data.error ?? 'Couldn\'t delete it.');
    if (route().view === 'watch' && route().id === id) {
      stopVideo();
      navigate('/', { replace: true });
    }
    toast(data.history === 'failed'
      ? 'Deleted. The VCR couldn\'t be reached, so it may still be in History.'
      : 'Deleted, and taken out of the VCR\'s History');
    refresh();
  } catch {
    toast('Couldn\'t reach the dashboard server.');
  }
}

// ---------------------------------------------------------------------------
// + : play something on the VCR. Its search runs on the Mac like a VCR request (a
// room of its own); the results, then the season and episode, are picked here.

const va = { pid: null, room: null, shownId: null, rev: 0, timer: null, picked: false, run: 0 };
const vaDialog = $('#vcr-add');

function vaStatus(text, tone = '') {
  $('#va-status').textContent = text;
  $('#va-status').className = `sheet-status ${tone}`;
}
function vaWait(text) {
  $('#va-results').hidden = false;
  setHtml($('#va-results'), `<div class="va-wait">${esc(text)}</div>`);
  vaPreview(true);
}

// While the Mac searches and opens it: a picture of the room's tab on the Mac, about
// once a second. Each new one is loaded off-screen first, so the picture never flashes.
let vaPreviewTimer = null;
function vaPreview(on) {
  const box = $('#va-preview');
  if (!on) {
    box.hidden = true;
    clearTimeout(vaPreviewTimer);
    vaPreviewTimer = null;
    return;
  }
  if (vaPreviewTimer || !va.room) return;
  const tick = () => {
    if (!va.room || !vaDialog.open) { vaPreviewTimer = null; return; }
    const next = new Image();
    next.onload = () => {
      box.querySelector('img').src = next.src;
      box.hidden = false;
      vaPreviewTimer = setTimeout(tick, 1000);
    };
    next.onerror = () => { vaPreviewTimer = setTimeout(tick, 2000); }; // no tab yet
    next.src = `/api/vcr/preview?room=${va.room}&t=${Date.now()}`;
  };
  vaPreviewTimer = setTimeout(tick, 0);
}
function vaReset() {
  clearTimeout(va.timer);
  vaPreview(false);
  Object.assign(va, { pid: null, room: null, shownId: null, rev: 0, picked: false, run: va.run + 1 });
  $('#va-form').hidden = false;
  $('#va-open-vcr').hidden = false;
  $('#va-results').hidden = true;
  $('#va-done').hidden = true;
  $('#va-go').disabled = false;
  vaStatus('Search for a show or movie. It plays in a new room, and gets recorded here.');
}

$('#add-btn').addEventListener('click', () => {
  if (!va.pid || !$('#va-done').hidden) vaReset(); // a search still going is kept (close and reopen)
  vaDialog.showModal();
  if (!va.pid) $('#va-input').focus();
});
$('#va-close').addEventListener('click', () => vaDialog.close());
vaDialog.addEventListener('close', () => vaPreview(false));
function addContent(title) {
  vaReset();
  $('#va-input').value = title;
  vaDialog.showModal();
  if (title) $('#va-form').requestSubmit();
  else $('#va-input').focus();
}
vaDialog.addEventListener('click', (event) => { if (event.target === vaDialog) vaDialog.close(); }); // the backdrop

$('#va-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const title = $('#va-input').value.trim();
  if (!title) return $('#va-input').focus();
  $('#va-go').disabled = true;
  vaStatus(`Finding a room for “${title}”…`);
  try {
    const res = await fetch('/api/vcr/request', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? 'The VCR refused it.');
    Object.assign(va, { pid: data.pid, room: data.room, shownId: null, rev: 0, picked: false });
    $('#va-form').hidden = true;
    $('#va-open-vcr').hidden = true;
    vaStatus(`Searching for “${title}” in room ${data.room}…`);
    vaWait('Searching the site…');
    vaPoll(va.run);
  } catch (err) {
    vaStatus(err.message === 'Failed to fetch' ? 'Couldn\'t reach the dashboard server.' : err.message, 'bad');
    $('#va-go').disabled = false;
  }
});

// Keeps asking while the run goes: it may ask several things in turn (which title, then
// which season, then which episode); after the last pick, it waits for the room to play.
async function vaPoll(run) {
  if (run !== va.run) return;
  let next = 1000;
  try {
    const data = await (await fetch(`/api/vcr/choices?pid=${va.pid}`, { cache: 'no-store' })).json();
    if (run !== va.run) return;
    if (data.id && (data.id !== va.shownId || (data.rev || 0) !== va.rev)) vaShow(data);
    else if (!data.id && va.picked) {
      const { rooms = [] } = await (await fetch('/api/vcr/rooms', { cache: 'no-store' })).json();
      const room = rooms.find((r) => r.room === va.room);
      if (room?.playback) return vaDone(room);
      const l = room?.loading;
      vaWait(l?.season ? `Opening Season ${l.season}${l.episode ? ` · Episode ${l.episode}` : ''}…` : 'Opening it on the Mac…');
      next = 2000;
    }
    if (data.alive === false && !data.id) {
      vaStatus(va.picked ? 'The run on the Mac stopped before it started playing. Try again.' : 'Nothing was found, or the search stopped. Try another title.', 'bad');
      $('#va-results').hidden = true;
      $('#va-form').hidden = false;
      $('#va-open-vcr').hidden = false;
      $('#va-go').disabled = false;
      va.pid = null;
      return;
    }
  } catch {}
  va.timer = setTimeout(() => vaPoll(run), next);
}

function vaShow(data) {
  vaPreview(false); // the list needs the room
  const same = data.id === va.shownId;
  const box = $('#va-results');
  const scroll = box.scrollTop;
  va.shownId = data.id;
  va.rev = data.rev || 0;
  const list = data.kind === 'season' || data.kind === 'episode';
  vaStatus(data.prompt || (list ? `Which ${data.kind}?` : 'Which one?'));
  const items = data.items.map((it, i) => [it, i]);
  const cardOf = ([it, i]) => `
    <button class="va-card" type="button" data-pick="${i}">
      <span class="va-poster">${it.poster ? `<img src="${esc(it.poster)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
        <span class="va-badge">${it.kind === 'tv' ? 'TV' : 'Movie'}</span>${it.watched ? '<span class="va-badge seen">✓ Watched</span>' : ''}</span>
      <span class="va-name">${esc(it.title)}</span>
    </button>`;
  box.hidden = false;
  setHtml(box, list
    ? `<div class="va-list">${items.map(([it, i]) => `
        <button class="va-row${it.watched ? ' seen' : ''}" type="button" data-pick="${i}"><b>${esc(it.title)}</b>${it.subtitle ? `<small>${esc(it.subtitle)}</small>` : ''}</button>`).join('')}</div>`
    : [['tv', 'TV Shows'], ['movie', 'Movies']].map(([kind, heading]) => {
      const mine = items.filter(([it]) => (it.kind === 'tv') === (kind === 'tv'));
      return mine.length ? `<h3 class="va-section">${heading} <span>${mine.length}</span></h3><div class="va-grid">${mine.map(cardOf).join('')}</div>` : '';
    }).join(''));
  box.scrollTop = same ? scroll : 0; // more were added: stay where you were
}

$('#va-results').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-pick]');
  if (!button) return;
  const buttons = $('#va-results').querySelectorAll('button');
  buttons.forEach((b) => { b.disabled = true; });
  vaStatus('Opening…');
  try {
    const res = await fetch('/api/vcr/choose', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid: va.pid, id: va.shownId, index: Number(button.dataset.pick) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? 'Couldn\'t pick that one.');
    va.picked = true;
    va.shownId = null; // whatever it asks next is new
    vaWait(`Opening ${data.item?.title ?? 'it'}…`);
  } catch (err) {
    vaStatus(err.message === 'Failed to fetch' ? 'Couldn\'t reach the dashboard server.' : err.message, 'bad');
    buttons.forEach((b) => { b.disabled = false; });
  }
});

function vaDone(room) {
  vaPreview(false);
  const ep = room.season ? ` · S${room.season}${room.episode ? ` E${room.episode}` : ''}` : '';
  vaStatus(`Playing ${room.title ?? ''}${ep} in room ${room.room}. It's being recorded here too.`, 'ok');
  $('#va-results').hidden = true;
  $('#va-done').hidden = false;
  // The room's link on the same network this page was opened on.
  // The room's link on the same network this page was opened on: Tailscale, the Wi-Fi, or else the public one.
  const host = location.hostname;
  const tailnet = /\.ts\.net$/i.test(host) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host);
  const home = /^(10\.|192\.168\.|localhost$|127\.)/.test(host);
  $('#va-watch').href = GUEST ? room.publicLink || room.lanLink
    : tailnet ? `http://${host}:8765/#tv=${encodeURIComponent(room.room)}`
    : home ? room.lanLink || room.publicLink : room.publicLink || room.lanLink;
  $('#va-vcr').href = VCR_URL;
  va.pid = null;
}

// ---------------------------------------------------------------------------
// Storage: what's using the SD card, biggest first, with Compress and Delete.

const storageDialog = $('#storage');
let macTrashOpen = false; // "while something records" opened, showing the Mac's Trash
let storageTimer = null;
const sizeText = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(b >= 10e9 ? 0 : 1)} GB` : `${Math.round(b / 1e6)} MB`);

async function loadStorage() {
  clearTimeout(storageTimer);
  if (!storageDialog.open) return;
  try {
    const data = await (await fetch('/api/storage', { cache: 'no-store' })).json();
    renderStorage(data);
    // Faster while something is compressing, so its progress moves.
    const busy = data.items.some((it) => ['queued', 'compressing', 'saving'].includes(it.job?.state));
    storageTimer = setTimeout(loadStorage, busy ? 1500 : 5000);
  } catch {
    storageTimer = setTimeout(loadStorage, 5000);
  }
}

function renderStorage(data) {
  const { card, trash, recordings, other } = data;
  if (!card) {
    setHtml($('#st-summary'), '<p class="hint warn">The SD card isn\'t plugged in.</p>');
  } else {
    const pct = (b) => `${((100 * b) / card.total).toFixed(2)}%`;
    setHtml($('#st-summary'), `
      <div class="st-bar" aria-hidden="true"><i class="rec" style="width:${pct(recordings)}"></i><i class="trash" style="width:${pct(trash)}"></i><i class="other" style="width:${pct(other)}"></i></div>
      <ul class="st-legend">
        <li><i class="rec"></i>Recordings <b>${sizeText(recordings)}</b></li>
        <li><i class="trash"></i>Card's Trash <b>${sizeText(trash)}</b></li>
        <li><i class="other"></i>Other files <b>${sizeText(other)}</b></li>
        <li><i class="free"></i>Free <b>${sizeText(card.free)}</b></li>
      </ul>`);
  }
  $('#st-trash').hidden = !trash;
  $('#st-trash-text').textContent = `${sizeText(trash)} in the card's Trash (deleted recordings). The space comes back once it's emptied.`;
  const biggest = Math.max(1, ...data.items.map((it) => it.size));
  setHtml($('#st-list'), data.items.map((it) => {
    const job = it.job;
    const working = job && ['queued', 'compressing', 'saving'].includes(job.state);
    const sub = [episodeCode(it), it.episodeName].filter(Boolean).join(' · ') || (it.kind === 'movie' ? 'Movie' : '');
    const state = working
      ? `<span class="st-job">${job.state === 'queued' ? 'Waiting to compress…' : job.state === 'saving' ? 'Saving the smaller copy…'
          : `Compressing ${Math.round((job.progress || 0) * 100)}%`}</span><span class="st-progress"><i style="width:${Math.round((job.progress || 0) * 100)}%"></i></span>`
      : job?.state === 'failed' ? `<span class="st-job bad">Couldn't compress: ${esc(job.error || 'it failed')}</span>`
      : job?.state === 'done' ? `<span class="st-job ok">Compressed, ${sizeText(job.saved || 0)} freed</span>`
      : '';
    return `<div class="st-item">
      <div class="st-text">
        <b>${esc(it.title)}</b>
        ${sub ? `<span>${esc(sub)}</span>` : ''}
        <span class="st-size"><strong>${sizeText(it.size)}</strong>${it.compressed ? ' · compressed' : ''}${it.onCard ? '' : ' · still on the Mac'}</span>
        <span class="st-sizebar"><i style="width:${((100 * it.size) / biggest).toFixed(1)}%"></i></span>
        ${state}
      </div>
      <div class="st-actions">
        ${it.compressed || working ? '' : `<button class="btn" type="button" data-compress="${it.id}">Compress</button>`}
        <button class="btn danger" type="button" data-st-delete="${it.id}">Delete</button>
      </div>
    </div>`;
  }).join('') || '<p class="hint">No saved recordings yet.</p>');
}

document.addEventListener('click', async (event) => {
  if (event.target.closest('[data-storage]')) {
    storageDialog.showModal();
    setHtml($('#st-list'), '<p class="hint">Adding it up…</p>');
    loadStorage();
    return;
  }
  const compress = event.target.closest('[data-compress]');
  if (compress) {
    compress.disabled = true;
    const res = await fetch('/api/storage/compress', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: compress.dataset.compress }),
    }).catch(() => null);
    const data = await res?.json().catch(() => ({}));
    if (!res?.ok) toast(data?.error ?? 'Couldn\'t start compressing it.');
    loadStorage();
    return;
  }
  const del = event.target.closest('[data-st-delete]');
  if (del) {
    await deleteRecording(del.dataset.stDelete);
    loadStorage();
  }
});
$('#st-close').addEventListener('click', () => storageDialog.close());
// This Mac's Trash, under "while something records" in Settings.
document.addEventListener('click', async (event) => {
  if (event.target.closest('[data-mac-trash]')) {
    macTrashOpen = !macTrashOpen;
    renderSettings();
    return;
  }
  const button = event.target.closest('[data-empty-mac-trash]');
  if (!button) return;
  if (!confirm('Empty the Trash on this Mac?\n\nEverything in it is deleted for good, not just recordings. This can\'t be undone.')) return;
  button.disabled = true;
  const res = await fetch('/api/storage/empty-mac-trash', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => null);
  const data = await res?.json().catch(() => ({}));
  toast(res?.ok ? `Emptied the Mac's Trash${data.freed ? `: ${sizeText(data.freed)} freed` : ''}` : data?.error ?? 'Couldn\'t empty it.');
  loadSettings();
});
storageDialog.addEventListener('close', () => clearTimeout(storageTimer));
$('#st-empty').addEventListener('click', async () => {
  if (!confirm('Empty the SD card\'s Trash?\n\nThe recordings in it are deleted for good. This can\'t be undone.')) return;
  const res = await fetch('/api/storage/empty-trash', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => null);
  const data = await res?.json().catch(() => ({}));
  toast(res?.ok ? `Emptied the card's Trash: ${sizeText(data.freed || 0)} freed` : data?.error ?? 'Couldn\'t empty it.');
  loadStorage();
});

// Every season and episode of the shows recorded (the phone page's saved lists); a minute at a time.
let catalogAt = 0;
async function loadCatalog() {
  // Every few seconds while a show's episodes are being looked up, so they show as they're found.
  const looking = Object.values(state.catalog).some((show) => show.looking);
  if (Date.now() - catalogAt < (looking ? 4_000 : 60_000)) return;
  catalogAt = Date.now();
  try {
    const catalog = await (await fetch('/api/catalog', { cache: 'no-store' })).json();
    if (JSON.stringify(catalog) !== JSON.stringify(state.catalog)) {
      state.catalog = catalog;
      render();
    }
  } catch {}
}

// Request: an episode not recorded yet goes to the VCR (a room of its own), and the + sheet follows it.
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-request]');
  if (!button) return;
  const ask = JSON.parse(button.dataset.request);
  const name = `${ask.title} S${String(ask.season).padStart(2, '0')}E${String(ask.episode).padStart(2, '0')}${ask.name ? ` · ${ask.name}` : ''}`;
  button.disabled = true;
  try {
    const res = await fetch('/api/vcr/episode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ask) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return toast(data.error ?? 'Couldn\'t request it.');
    vaFollow(data.pid, data.room, `Requesting ${name} in room ${data.room}…`);
  } catch {
    toast('Couldn\'t reach the dashboard server.');
  } finally {
    button.disabled = false;
  }
});

async function refresh() {
  loadCatalog();
  try {
    const res = await fetch('/api/library', { cache: 'no-store' });
    const { items } = await res.json();
    const signature = JSON.stringify(items);
    const first = !state.loaded;
    state.loaded = true;
    if (signature !== state.signature || first) {
      state.signature = signature;
      state.items = items;
      render();
    }
  } catch {
    // The server may be restarting; try again on the next tick.
  }
}

render();
// The VCR (site-search's helper, port 8766) on the same machine as this page,
// by whatever name this page was opened with (localhost, Wi-Fi or Tailscale).
const VCR_URL = GUEST ? `https://${location.hostname}:10000/command-builder.html#requests`
  : `http://${location.hostname || 'localhost'}:8766/command-builder.html#requests`;
$('#va-open-vcr').href = VCR_URL;

refresh();
loadSettings();
setInterval(refresh, 4000);

// The top bar is see-through over the top of the page, solid once it's scrolled.
const topbar = document.querySelector('.topbar');
const onScroll = () => topbar.classList.toggle('scrolled', window.scrollY > 8);
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();
setInterval(loadSettings, 5000);
setInterval(tick, 1000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    refresh();
    loadSettings();
  }
});
