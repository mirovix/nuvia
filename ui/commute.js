import { api, state, $, h, icon, fill, on, savePrefs, segmented, clock, empty } from './core.js';
import { defineWidget } from './home.js';

const MODES = [{ value: 'car', icon: 'car', title: 'Auto' }, { value: 'bike', icon: 'bike', title: 'Bici' }, { value: 'foot', icon: 'footprints', title: 'A piedi' }];
const TURN_ICON = { left: 'corner-up-left', right: 'corner-up-right', 'sharp left': 'corner-up-left', 'sharp right': 'corner-up-right', 'slight left': 'arrow-up-left', 'slight right': 'arrow-up-right', straight: 'arrow-up', uturn: 'undo-2' };
const ui = { map: null, layer: null, tiles: null, route: null, error: '', loading: false, timer: null };

function stepIcon(step) {
  if (step.type === 'depart') return 'navigation';
  if (step.type === 'arrive') return 'flag';
  if (/roundabout|rotary/.test(step.type)) return 'rotate-ccw';
  if (step.type === 'fork') return 'split';
  if (step.type === 'merge' || step.type === 'on ramp') return 'git-merge';
  return TURN_ICON[step.modifier] || 'arrow-up';
}

const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

function pin(letter) {
  return L.divIcon({ className: '', html: `<div class="map-pin${letter === 'B' ? ' b' : ''}"><b>${letter}</b></div>`, iconSize: [28, 28], iconAnchor: [4, 28] });
}

// Address input with suggestions from the same geocoder used for routing.
function suggestInput({ letter, placeholder, value, city, onPick, onType }) {
  const input = h('input', { placeholder, value: value || '', autocomplete: 'off', spellcheck: false });
  const list = h('div.suggestions', { hidden: true });
  const box = h('div.suggest', h(`span.pin${letter === 'B' ? '.b' : ''}`, letter), input, list);
  let timer; let items = []; let active = -1; let request = 0;
  const close = () => { list.hidden = true; active = -1; };
  const choose = item => { input.value = item.label; close(); onPick(item); };
  const draw = () => fill(list, items.map((item, index) => h(`button${index === active ? '.on' : ''}`, { type: 'button', on: { mousedown: event => { event.preventDefault(); choose(item); } } }, h('b', item.label), h('small', item.full))));
  input.addEventListener('input', () => {
    onType(input.value);
    clearTimeout(timer);
    const text = input.value.trim();
    if (text.length < 4) return close();
    timer = setTimeout(async () => {
      const id = ++request;
      const found = await api.suggestPlaces(text, city?.() || '').catch(() => []);
      if (id !== request || document.activeElement !== input) return;
      items = found; active = -1;
      list.hidden = !items.length; draw();
    }, 650);
  });
  input.addEventListener('keydown', event => {
    if (list.hidden) return;
    if (event.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); draw(); event.preventDefault(); }
    else if (event.key === 'ArrowUp') { active = Math.max(0, active - 1); draw(); event.preventDefault(); }
    else if (event.key === 'Enter' && active >= 0) { event.preventDefault(); choose(items[active]); }
    else if (event.key === 'Escape') close();
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
  return { box, input };
}

async function compute(ctx, overrides = {}) {
  const prefs = state.prefs;
  if (!prefs.homeDestination && !prefs.homeDestinationPlace) return;
  ui.loading = true; ui.error = ''; renderResult(ctx);
  let coordinates = null;
  if (!prefs.homeOrigin && !prefs.homeOriginPlace) coordinates = await currentPosition();
  try {
    ui.route = await api.route({
      origin: prefs.homeOrigin || '', destination: prefs.homeDestination || '', city: prefs.homeCity || '', mode: prefs.commuteMode || 'car', coordinates,
      originPlace: prefs.homeOriginPlace || null, destinationPlace: prefs.homeDestinationPlace || null, ...overrides
    });
  } catch (error) {
    ui.route = null; ui.error = String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
  ui.loading = false;
  renderResult(ctx);
}

function currentPosition() {
  return new Promise(resolvePosition => {
    if (!navigator.geolocation) return resolvePosition(null);
    navigator.geolocation.getCurrentPosition(position => resolvePosition({ latitude: position.coords.latitude, longitude: position.coords.longitude }), () => resolvePosition(null), { timeout: 6000, maximumAge: 300000 });
  });
}

function ensureMap(container) {
  if (typeof L === 'undefined') return null;
  if (ui.map && ui.map.getContainer() === container) return ui.map;
  if (ui.map) { ui.map.remove(); ui.map = null; }
  ui.map = L.map(container, { zoomControl: false, attributionControl: true, scrollWheelZoom: 'center' }).setView([45.44, 11.9], 10);
  L.control.zoom({ position: 'topright' }).addTo(ui.map);
  ui.tiles = L.tileLayer(TILES, { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(ui.map);
  new ResizeObserver(() => ui.map?.invalidateSize()).observe(container);
  return ui.map;
}

function drawRoute(route) {
  if (!ui.map) return;
  ui.layer?.remove();
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ff6a3d';
  const start = [route.origin.latitude, route.origin.longitude]; const end = [route.destination.latitude, route.destination.longitude];
  ui.layer = L.featureGroup([
    L.polyline(route.geometry, { color: '#000', weight: 9, opacity: 0.25 }),
    L.polyline(route.geometry, { color: accent, weight: 5, opacity: 0.95, lineJoin: 'round' }),
    L.marker(start, { icon: pin('A'), title: route.origin.label }),
    L.marker(end, { icon: pin('B'), title: route.destination.label })
  ]).addTo(ui.map);
  ui.map.fitBounds(ui.layer.getBounds(), { padding: [40, 40] });
}

function renderResult(ctx) {
  const result = ctx.body.querySelector('.route-result');
  if (!result) return;
  const route = ui.route;
  const summary = ctx.body.querySelector('.route-summary');
  const steps = ctx.body.querySelector('.route-steps');
  const alternatives = ctx.body.querySelector('.alternatives');
  const mapBox = ctx.body.querySelector('.map');
  if (!state.prefs.homeDestination && !state.prefs.homeDestinationPlace) {
    fill(summary, h('div.sub', 'Scrivi dove vuoi andare: il percorso compare qui, senza aprire Maps.'));
    fill(steps, empty('map-pin', 'Nessun percorso', 'Imposta partenza e arrivo.'));
    return;
  }
  if (ui.loading) { fill(summary, h('div.big', '…'), h('div.sub', 'Calcolo del percorso')); return; }
  if (ui.error) { fill(summary, h('div.sub', { style: 'color:var(--danger)' }, ui.error)); fill(steps, empty('triangle-alert', 'Percorso non disponibile', ui.error)); fill(alternatives); return; }
  if (!route) return;
  const modeLabel = MODES.find(mode => mode.value === route.mode)?.title || '';
  ctx.setMeta(`${route.minutes} min · ${route.kilometers.toLocaleString('it-IT')} km · ${modeLabel.toLowerCase()}`);
  fill(summary, h('div.big', String(route.minutes), h('small', 'min')), h('div.sub', `${route.kilometers.toLocaleString('it-IT')} km · arrivo alle ${clock(route.arrival)} · senza traffico in tempo reale`));
  fill(steps,
    h('div.route-ends', h('div', h('b', 'A'), h('span', { title: route.origin.full || route.origin.label }, route.origin.label)), h('div', h('b', 'B'), h('span', { title: route.destination.full || route.destination.label }, route.destination.label))),
    route.steps.map(step => h('div.step', h('span.turn', icon(stepIcon(step))), h('span', step.text), h('small', step.type === 'arrive' ? '' : step.distance))));
  // Offer the other candidates when the address was ambiguous.
  const choices = (route.destinationChoices || []).slice(1).filter(choice => choice.score > (route.destinationChoices[0].score - 6));
  const originChoices = (route.originChoices || []).slice(1).filter(choice => choice.score > (route.originChoices[0].score - 6));
  fill(alternatives, [...originChoices.map(choice => ({ choice, key: 'originPlace', letter: 'A' })), ...choices.map(choice => ({ choice, key: 'destinationPlace', letter: 'B' }))].length
    ? [h('span', 'Intendevi:'), ...originChoices.map(choice => h('button.chip', { on: { click: () => pick(ctx, 'homeOriginPlace', 'homeOrigin', choice) } }, h('b.mono', 'A'), choice.label)),
      ...choices.map(choice => h('button.chip', { on: { click: () => pick(ctx, 'homeDestinationPlace', 'homeDestination', choice) } }, h('b.mono', 'B'), choice.label))] : []);
  if (ensureMap(mapBox)) drawRoute(route);
}

function pick(ctx, placeKey, textKey, choice) {
  state.prefs[placeKey] = choice; state.prefs[textKey] = choice.label; savePrefs();
  ctx.render(true); compute(ctx);
}

defineWidget({
  id: 'commute', title: 'Verso casa', icon: 'navigation', size: 'l', height: 'tall', topics: [],
  actions: ctx => [h('button.icon-btn.small', { title: 'Ricalcola', on: { click: () => compute(ctx) } }, icon('refresh-cw'))],
  render(ctx, rebuild = false) {
    if (ctx.body.querySelector('.route-result') && !rebuild) {
      ctx.body.querySelector('.route-form')?.replaceWith(form(ctx));
      if (ui.map && ui.map.getContainer().isConnected) ui.map.invalidateSize();
      return renderResult(ctx);
    }
    ui.map?.remove(); ui.map = null;
    fill(ctx.body,
      form(ctx),
      h('div.alternatives'),
      h('div.route-result.route-view',
        h('div.map', h('div.route-summary')),
        h('div.route-steps')));
    renderResult(ctx);
  },
  mount(ctx) {
    ctx.render = rebuild => { try { this.render(ctx, rebuild); } catch (error) { console.error(error); } };
    if (!ui.route && (state.prefs.homeDestination || state.prefs.homeDestinationPlace)) compute(ctx);
    clearInterval(ui.timer);
    ui.timer = setInterval(() => { if (ctx.el.isConnected && state.route === 'home') compute(ctx); }, 10 * 60000);
  }
});

function form(ctx) {
  const prefs = state.prefs;
  const city = h('input', { placeholder: 'Città di arrivo', value: prefs.homeCity || '', autocomplete: 'off', on: { change: () => { prefs.homeCity = city.value.trim(); prefs.homeDestinationPlace = null; savePrefs(); } } });
  const origin = suggestInput({
    letter: 'A', placeholder: 'Partenza (vuoto = posizione attuale)', value: prefs.homeOriginPlace?.label || prefs.homeOrigin,
    onType: text => { prefs.homeOrigin = text.trim(); prefs.homeOriginPlace = null; savePrefs(); },
    onPick: place => { prefs.homeOrigin = place.label; prefs.homeOriginPlace = place; savePrefs(); }
  });
  const destination = suggestInput({
    letter: 'B', placeholder: 'Arrivo: via e numero civico', value: prefs.homeDestinationPlace?.label || prefs.homeDestination, city: () => city.value.trim(),
    onType: text => { prefs.homeDestination = text.trim(); prefs.homeDestinationPlace = null; savePrefs(); },
    onPick: place => { prefs.homeDestination = place.label; prefs.homeDestinationPlace = place; savePrefs(); compute(ctx); }
  });
  const mode = segmented(MODES, prefs.commuteMode || 'car', value => { prefs.commuteMode = value; savePrefs(); compute(ctx); });
  const submit = h('button.btn.accent', { type: 'submit' }, 'Calcola');
  return h('form.route-form', { on: { submit: event => { event.preventDefault(); prefs.homeCity = city.value.trim(); savePrefs(); compute(ctx); } } }, origin.box, destination.box, city, mode, submit);
}
