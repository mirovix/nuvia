import { api, state, $, h, icon, fill, emit, on, empty, skeleton, pad, toast } from './core.js';
import { defineWidget } from './home.js';
import { openService } from './router.js';
import { openAddService } from './services.js';

const view = { tab: 'library', library: null, results: null, query: '', searching: false, tint: '' };
let busy = false;

export async function refreshMusic() {
  if (busy) return;
  busy = true;
  try {
    const next = await api.musicState();
    const changed = JSON.stringify(next) !== JSON.stringify(state.music);
    state.music = next;
    if (changed) emit('music');
  } catch (error) { console.error(error); } finally { busy = false; }
  const playing = state.music?.title && !state.music.paused;
  $('[data-route="music"] .eq').hidden = !playing;
}

// Artwork that fails to load falls back to the placeholder icon behind it.
function art(src) {
  if (!src || !/^(https:|data:image)/.test(src)) return null;
  const img = h('img', { src, alt: '', referrerpolicy: 'no-referrer' });
  img.onerror = () => img.remove();
  return img;
}

const time = seconds => (Number.isFinite(seconds) && seconds > 0 ? `${Math.floor(seconds / 60)}:${pad(Math.floor(seconds % 60))}` : '0:00');

async function control(action, value) {
  const ok = await api.musicControl(action, value);
  if (!ok && ['play', 'next', 'previous'].includes(action)) toast('The player isn’t ready yet. Pick something from your library first.', { action: { label: 'Library', run: () => emit('go', 'music') } });
  setTimeout(refreshMusic, 350);
  setTimeout(refreshMusic, 1200);
}

function cover(music, size = '') {
  return h(`div.cover${size}`, icon('disc-3'), art(music?.artwork));
}

function progress(music) {
  const bar = h('div.progress', { title: 'Seek', on: { click: event => { const rect = bar.getBoundingClientRect(); control('seek', (event.clientX - rect.left) / rect.width); } } }, h('i', { style: `width:${Math.min(100, (music.progress || 0) * 100)}%` }));
  return h('div', bar, h('div.times', h('span', time(music.position)), h('span', time(music.duration))));
}

function transport(music, big = false) {
  const btn = (name, action, title, extra = '') => h(`button.icon-btn${extra}`, { title, on: { click: () => control(action) } }, icon(name));
  return h('div.transport',
    big ? btn('shuffle', 'shuffle', 'Shuffle', music.shuffle ? '.on' : '') : null,
    btn('skip-back', 'previous', 'Previous'),
    h('button.play', { title: music.paused ? 'Play' : 'Pause', on: { click: () => control('play') } }, icon(music.paused ? 'play' : 'pause')),
    btn('skip-forward', 'next', 'Next'),
    big ? btn(music.repeat === 'mixed' ? 'repeat-1' : 'repeat', 'repeat', 'Repeat', music.repeat !== 'false' ? '.on' : '') : null);
}

function notReady(music) {
  if (!music || music.loading) return { icon: 'music', title: 'Starting the player…', text: 'Spotify is loading in the background.' };
  if (music.missing) return { icon: 'music', title: 'Spotify isn’t connected', text: 'Add it once and music plays inside Nuvia, no other app needed.', action: h('button.btn.sm', { on: { click: () => openAddService({ name: 'Spotify', url: 'https://open.spotify.com/' }) } }, icon('plus'), 'Connect Spotify') };
  if (!music.connected) return { icon: 'log-in', title: 'Sign in to Spotify', text: 'Sign in once and the player stays connected.', action: h('button.btn.sm', { on: { click: () => openSpotify() } }, 'Sign in') };
  return null;
}

function openSpotify() {
  const service = state.services.find(item => item.kind === 'spotify');
  if (service) openService(service.id);
}

// Average colour of the artwork, for the page backdrop.
function tintFrom(src) {
  if (!src || src === view.tintSrc) return;
  view.tintSrc = src;
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.onload = () => {
    try {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 12;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, 12, 12);
      const data = context.getImageData(0, 0, 12, 12).data; let r = 0; let g = 0; let b = 0;
      for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
      const n = data.length / 4;
      view.tint = `rgb(${Math.round(r / n)} ${Math.round(g / n)} ${Math.round(b / n)})`;
      $('.music-hero')?.style.setProperty('--tint', view.tint);
    } catch {}
  };
  image.src = src;
}

// ---------------------------------------------------------------------------
// Widget

defineWidget({
  id: 'music', title: 'Music', icon: 'music', size: 's', topics: ['music', 'services'],
  actions: () => [h('button.link', { on: { click: () => emit('go', 'music') } }, 'Player', icon('arrow-right'))],
  render(ctx) {
    const music = state.music;
    const blocked = notReady(music);
    if (blocked) { ctx.setMeta(''); return fill(ctx.body, empty(blocked.icon, blocked.title, blocked.text, blocked.action)); }
    ctx.setMeta(music.paused ? 'paused' : 'playing');
    if (!music.title) return fill(ctx.body, empty('disc-3', 'Nothing playing', 'Pick a playlist from the player.', h('button.btn.sm', { on: { click: () => emit('go', 'music') } }, icon('library'), 'Library')));
    fill(ctx.body, h('div.music-widget',
      // The artist only while it plays: a paused track shows just what it is.
      h('div.player', cover(music), h('div.track', h('strong', music.title), !music.paused && music.artist ? h('span.artist', music.artist) : null, music.album ? h('span.muted', music.album) : null)),
      progress(music), transport(music)));
  }
});

// ---------------------------------------------------------------------------
// Page

async function loadLibrary(force = false) {
  if (view.library && !force) return;
  view.library = 'loading'; renderBody();
  view.library = await api.musicLibrary().catch(() => []);
  renderBody();
}

async function search(query) {
  view.query = query; view.searching = true; view.tab = 'search'; renderBody();
  view.results = await api.musicSearch(query).catch(() => []);
  view.searching = false; renderBody();
}

function libraryGrid() {
  if (view.library === 'loading' || view.library === null) return skeleton(3);
  if (!view.library.length) return empty('library', 'Library empty or not loaded yet', 'Open Spotify once to sync it.', h('button.btn.sm', { on: { click: () => loadLibrary(true) } }, icon('refresh-cw'), 'Try again'));
  return h('div.library', view.library.map(item => h('button.tile', { type: 'button', title: `Play ${item.name}`, on: { click: async () => { toast(`Playing ${item.name}…`); const ok = await api.musicPlayUri(item.uri); if (!ok) toast('Couldn’t start playback'); setTimeout(refreshMusic, 800); } } },
    h('div.art', { style: 'position:relative' }, icon('music'), art(item.image)), h('strong', item.name), h('span', item.subtitle || ''))));
}

function searchResults() {
  if (view.searching) return skeleton(5);
  if (!view.results) return empty('search', 'Search for a song or artist', '');
  if (!view.results.length) return empty('search', 'No results', `for “${view.query}”`);
  return h('div.rows.tracks', view.results.map(track => h('button.row', { type: 'button', on: { click: async () => { await api.musicPlayTrack(track.index); setTimeout(refreshMusic, 700); } } },
    h('span.avatar', { style: 'position:relative' }, icon('music'), art(track.image)),
    h('div.main', h('div.line1', h('strong', track.title)), h('div.line2', track.artist)),
    h('div.side', h('time', track.duration)))));
}

function heroSection(music) {
  tintFrom(music.artwork);
  const volume = music.volume !== null && music.volume !== undefined ? h('input', { type: 'range', min: '0', max: '100', value: String(Math.round(music.volume * 100)), title: 'Volume', on: { change: event => control('volume', Number(event.target.value) / 100) } }) : null;
  return h('section.music-hero', { style: view.tint ? `--tint:${view.tint}` : '' },
    h('div.tint'),
    cover(music),
    h('div',
      h('span.tag', music.paused ? 'Paused' : 'Playing'),
      h('h2', music.title || 'Nothing playing'),
      h('div.artist', music.artist || 'Pick something from your library below'),
      music.album ? h('div.album', music.album) : null,
      h('div.controls',
        music.title ? progress(music) : null,
        transport(music, true),
        h('div.row-tools',
          h(`button.icon-btn${music.liked ? '.on' : ''}`, { title: music.liked ? 'Remove from Liked Songs' : 'Add to Liked Songs', on: { click: () => control('like') } }, icon('heart')),
          volume ? h('span.dim', { style: 'display:inline-flex;gap:6px;align-items:center' }, icon('volume-2'), volume) : null,
          h('button.btn.sm.ghost', { on: { click: openSpotify } }, icon('external-link'), 'Show Spotify')))));
}

function bodySection() {
  const searchInput = h('input', { type: 'search', placeholder: 'Search Spotify', value: view.query, on: { input: event => { view.query = event.target.value; }, keydown: event => { if (event.key === 'Enter' && event.target.value.trim()) search(event.target.value.trim()); } } });
  return h('section.music-body',
    h('div.page-head', h('div.segmented', ['library', 'search'].map(tab => h(`button${view.tab === tab ? '.on' : ''}`, { on: { click: () => { view.tab = tab; renderBody(); if (tab === 'library') loadLibrary(); } } }, icon(tab === 'library' ? 'library' : 'search'), tab === 'library' ? 'Library' : 'Search'))),
      h('div.actions', searchInput)),
    view.tab === 'library' ? libraryGrid() : searchResults());
}

let pageMode = null;
function renderBody() { const body = $('#page-music .music-body'); if (body) body.replaceWith(bodySection()); else renderPage(); }

export function renderPage({ heroOnly = false } = {}) {
  const page = $('#page-music');
  page.classList.add('music-page');
  const music = state.music;
  const blocked = notReady(music);
  const mode = blocked ? `blocked:${blocked.title}` : 'player';
  if (blocked) { pageMode = mode; return fill(page, h('div', { style: 'padding:60px' }, empty(blocked.icon, blocked.title, blocked.text, blocked.action))); }
  if (heroOnly && pageMode === mode && $('.music-hero', page)) { $('.music-hero', page).replaceWith(heroSection(music)); return; }
  pageMode = mode;
  fill(page, heroSection(music), bodySection());
}

export function initMusic() {
  on('music', () => { if (state.route === 'music') renderPage({ heroOnly: true }); });
  on('route', route => { if (route === 'music') { renderPage(); refreshMusic(); loadLibrary(); } });
}
