import { state, $, $$, h, icon, fill, on, emit, savePrefs, popover, sheet, openModal, segmented, toggle, clock, pad } from './core.js';

const registry = new Map();
const mounted = new Map();

export const DEFAULT_LAYOUT = [
  { id: 'mail', size: 'm' }, { id: 'calendar', size: 'm' },
  { id: 'messages', size: 'm' }, { id: 'music', size: 's' }, { id: 'weather', size: 's' },
  { id: 'ai', size: 'm' }, { id: 'train', size: 's' }, { id: 'notifications', size: 's' },
  { id: 'commute', size: 'l' },
  { id: 'services', size: 'm' }, { id: 'ias', size: 's' }, { id: 'notion', size: 's' }
];
const SIZES = [{ value: 's', label: 'S', title: 'Piccolo' }, { value: 'm', label: 'M', title: 'Medio' }, { value: 'l', label: 'L', title: 'Tutta la riga' }];
const HEIGHTS = [{ value: 'compact', label: 'Bassa' }, { value: 'normal', label: 'Normale' }, { value: 'tall', label: 'Alta' }];

export function defineWidget(def) { registry.set(def.id, def); }

// Older versions stored { id, wide, hidden }.
export function layout() {
  const saved = Array.isArray(state.prefs.widgets) ? state.prefs.widgets : [];
  const known = saved.filter(item => registry.has(item.id)).map(item => ({
    id: item.id,
    size: item.size || (item.wide ? (item.id === 'commute' ? 'l' : 'm') : (DEFAULT_LAYOUT.find(entry => entry.id === item.id)?.size || 's')),
    height: item.height || registry.get(item.id).height || 'normal', hidden: Boolean(item.hidden), options: item.options || {}
  }));
  for (const entry of DEFAULT_LAYOUT) if (registry.has(entry.id) && !known.some(item => item.id === entry.id)) known.push({ height: registry.get(entry.id).height || 'normal', hidden: false, options: {}, ...entry });
  for (const id of registry.keys()) if (!known.some(item => item.id === id)) known.push({ id, size: registry.get(id).size || 's', height: 'normal', hidden: false, options: {} });
  return known;
}
function saveLayout(next) { state.prefs.widgets = next; savePrefs(); }
function entryOf(id) { return layout().find(item => item.id === id); }
export function updateEntry(id, change) {
  const next = layout().map(item => (item.id === id ? { ...item, ...change, options: { ...item.options, ...(change.options || {}) } } : item));
  saveLayout(next);
  return next.find(item => item.id === id);
}
export function widgetOptions(id) {
  const def = registry.get(id);
  const defaults = Object.fromEntries((def?.options || []).map(option => [option.key, option.default]));
  return { ...defaults, ...(entryOf(id)?.options || {}) };
}

function columns() {
  const pref = Number(state.prefs.columns) || 0;
  if (pref) return pref;
  const width = $('#widget-grid').clientWidth;
  return width >= 1380 ? 4 : width >= 980 ? 3 : 2;
}

export function renderGrid() {
  const grid = $('#widget-grid');
  for (const { cleanup } of mounted.values()) cleanup.forEach(fn => fn());
  mounted.clear();
  grid.replaceChildren();
  for (const entry of layout()) {
    if (entry.hidden) continue;
    const def = registry.get(entry.id);
    grid.append(mountWidget(def, entry));
  }
  grid.style.setProperty('--cols', columns());
}

function mountWidget(def, entry) {
  const meta = h('span.w-meta');
  const body = h(`div.w-body${def.flush ? '.flush' : ''}`);
  const actions = h('div.w-actions');
  const el = h('article.widget', { dataset: { widget: def.id, size: entry.size, height: entry.height } },
    h('header.w-head', h('span.w-icon', icon(def.icon)), h('div.w-title', h('h2', def.title), meta), actions),
    body);
  const ctx = {
    id: def.id, el, body,
    get options() { return widgetOptions(def.id); },
    get size() { return el.dataset.size; },
    setMeta: text => { meta.textContent = text || ''; },
    render: () => { try { def.render(ctx); } catch (error) { console.error(def.id, error); } }
  };
  for (const action of def.actions?.(ctx) || []) actions.append(action);
  actions.append(
    h('button.icon-btn.small.w-tool', { title: 'Opzioni blocco', dataset: { act: 'settings' }, on: { click: event => openWidgetSettings(def, event.currentTarget) } }, icon('sliders-horizontal')),
    h('button.icon-btn.small.w-tool.w-grip', { title: 'Trascina per spostare', dataset: { act: 'drag' } }, icon('grip-vertical')));
  wireDrag(el, $('.w-grip', el));
  const cleanup = (def.topics || []).map(topic => on(topic, () => { if (el.isConnected) ctx.render(); }));
  mounted.set(def.id, { el, ctx, cleanup });
  ctx.render();
  def.mount?.(ctx);
  return el;
}

// The card becomes draggable only while its grip is held, so scrollbars and
// text selection inside the card keep working normally.
let draggedId = null;
function wireDrag(el, grip) {
  grip.addEventListener('pointerdown', () => { el.draggable = true; });
  grip.addEventListener('pointerup', () => { el.draggable = false; });
  el.addEventListener('dragstart', event => { if (!el.draggable) return event.preventDefault(); draggedId = el.dataset.widget; el.classList.add('dragging'); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', draggedId); });
  el.addEventListener('dragend', () => { el.draggable = false; draggedId = null; el.classList.remove('dragging'); $$('.widget.drop-target').forEach(item => item.classList.remove('drop-target')); });
  el.addEventListener('dragover', event => { if (!draggedId || draggedId === el.dataset.widget) return; event.preventDefault(); el.classList.add('drop-target'); });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', event => {
    event.preventDefault(); el.classList.remove('drop-target');
    if (!draggedId || draggedId === el.dataset.widget) return;
    const items = layout();
    const moving = items.splice(items.findIndex(item => item.id === draggedId), 1)[0];
    const bounds = el.getBoundingClientRect();
    const after = event.clientX > bounds.left + bounds.width / 2;
    items.splice(items.findIndex(item => item.id === el.dataset.widget) + (after ? 1 : 0), 0, moving);
    saveLayout(items);
    const draggedEl = $(`.widget[data-widget="${moving.id}"]`);
    el.parentNode.insertBefore(draggedEl, after ? el.nextSibling : el);
  });
}

function applyEntry(id) {
  const entry = entryOf(id);
  const item = mounted.get(id);
  if (!item) return renderGrid();
  item.el.dataset.size = entry.size; item.el.dataset.height = entry.height;
  item.ctx.render();
}

function optionControl(def, option, onChange) {
  const current = widgetOptions(def.id)[option.key];
  if (option.type === 'toggle') return h('label.check', toggle(current, value => onChange(value), option.label), option.label);
  if (option.type === 'choice') return h('div.opt', h('span', option.label), segmented(option.choices, current, onChange));
  if (option.type === 'number') {
    const input = h('input', { type: 'number', min: option.min ?? 1, max: option.max ?? 50, value: String(current) });
    input.addEventListener('change', () => onChange(Math.max(option.min ?? 1, Math.min(option.max ?? 50, Number(input.value) || option.default))));
    return h('label.opt', h('span', option.label), input);
  }
  if (option.type === 'services') {
    const list = state.services.filter(service => option.filter(service));
    const excluded = new Set(current || []);
    return h('div.opt', h('span', option.label), list.length ? list.map(service => h('label.check', toggle(!excluded.has(service.id), value => {
      if (value) excluded.delete(service.id); else excluded.add(service.id);
      onChange([...excluded]);
    }, service.name), service.name)) : h('small.muted', 'Nessun servizio di questo tipo.'));
  }
  return null;
}

export async function openWidgetSettings(def, anchor) {
  const entry = entryOf(def.id);
  let dialog;
  const content = h('div.pop-body',
    h('h3', def.title),
    h('div.opt', h('span', 'Larghezza'), segmented(SIZES, entry.size, size => { updateEntry(def.id, { size }); applyEntry(def.id); })),
    h('div.opt', h('span', 'Altezza'), segmented(HEIGHTS, entry.height, height => { updateEntry(def.id, { height }); applyEntry(def.id); })),
    (def.options || []).map(option => optionControl(def, option, value => { updateEntry(def.id, { options: { [option.key]: value } }); applyEntry(def.id); })),
    h('button.btn.sm.ghost', { type: 'button', on: { click: () => { updateEntry(def.id, { hidden: true }); dialog.close(); renderGrid(); } } }, icon('eye-off'), 'Nascondi blocco'));
  dialog = await popover(anchor, content, { width: 300 });
}

export function openCustomize() {
  let items = layout();
  const list = h('div.layout-list');
  const renderList = () => fill(list, items.map((item, index) => {
    const def = registry.get(item.id);
    return h(`div.layout-row${item.hidden ? '.off' : ''}`,
      h('div.order', h('button.icon-btn', { type: 'button', title: 'Su', disabled: index === 0, on: { click: () => move(index, -1) } }, icon('chevron-up')), h('button.icon-btn', { type: 'button', title: 'Giù', disabled: index === items.length - 1, on: { click: () => move(index, 1) } }, icon('chevron-down'))),
      h('span.w-icon', icon(def.icon)), h('strong', def.title),
      segmented(SIZES, item.size, size => { item.size = size; commit(); }),
      toggle(!item.hidden, visible => { item.hidden = !visible; commit(); renderList(); }, `Mostra ${def.title}`));
  }));
  const move = (index, delta) => { const [moved] = items.splice(index, 1); items.splice(index + delta, 0, moved); commit(); renderList(); };
  const commit = () => { saveLayout(items); renderGrid(); };
  renderList();
  const columnsControl = segmented([{ value: 0, label: 'Auto' }, { value: 2, label: '2' }, { value: 3, label: '3' }, { value: 4, label: '4' }], Number(state.prefs.columns) || 0, value => { state.prefs.columns = value; savePrefs(); renderGrid(); });
  const dialog = sheet({
    title: 'Personalizza panoramica', subtitle: 'Mostra, ordina e ridimensiona i blocchi. Dentro ogni blocco trovi altre opzioni.',
    body: [h('div.field', h('span', 'Colonne'), columnsControl), list],
    foot: [h('button.btn.ghost.left', { type: 'button', on: { click: () => { items = DEFAULT_LAYOUT.map(entry => ({ height: registry.get(entry.id)?.height || 'normal', hidden: false, options: {}, ...entry })); commit(); renderList(); } } }, icon('rotate-ccw'), 'Ripristina'),
      h('button.btn.accent', { type: 'button', on: { click: () => dialog.close() } }, 'Fatto')]
  });
  dialog.id = 'customize-dialog';
  openModal(dialog);
}

// ---------------------------------------------------------------------------
// Hero

function greeting(hour) { return hour < 5 ? 'Buonanotte' : hour < 13 ? 'Buongiorno' : hour < 18 ? 'Buon pomeriggio' : 'Buonasera'; }

export function renderHero() {
  const now = new Date();
  const hero = $('#hero');
  if (!hero.firstChild) {
    hero.append(
      h('div', h('p.hello#hello'), h('h1.clock#clock'), h('div.hero-date#today'), h('div.glance#glance')),
      h('button.weather-card#weather-card', { type: 'button', title: 'Cambia città', on: { click: () => emit('open-settings', 'general') } }));
  }
  const name = state.prefs.name ? h('b', state.prefs.name) : null;
  fill($('#hello'), `${greeting(now.getHours())}${name ? ', ' : ''}`, name);
  fill($('#clock'), pad(now.getHours()), h('span.colon', ':'), pad(now.getMinutes()));
  $('#today').textContent = now.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
  renderGlance();
}

export function renderGlance() {
  const box = $('#glance'); if (!box) return;
  const chips = [];
  const mailUnread = (state.mail?.accounts || []).reduce((total, account) => total + (account.unread || 0), 0);
  if (state.mail?.accounts?.length) chips.push(h('button.chip', { on: { click: () => $('.widget[data-widget="mail"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' }) } }, icon('mail'), mailUnread ? `${mailUnread} email da leggere` : 'Posta in pari'));
  const chatUnread = (state.messages?.items || []).reduce((total, item) => total + (item.unread || 0), 0);
  if (state.messages?.items?.length) chips.push(h('button.chip', { on: { click: () => emit('go', 'messages') } }, icon('message-circle'), chatUnread ? `${chatUnread} messaggi non letti` : 'Nessuna chat in sospeso'));
  const next = (state.calendar?.events || []).find(event => event.end > Date.now() && !event.allDay);
  if (next) chips.push(h('button.chip', { on: { click: () => emit('go', 'calendar') } }, icon('calendar'), `${next.start <= Date.now() ? 'Ora' : clock(next.start)} · ${next.title}`));
  if (state.music?.title && !state.music.paused) chips.push(h('button.chip.on', { on: { click: () => emit('go', 'music') } }, icon('music'), `${state.music.title} — ${state.music.artist}`));
  fill(box, chips);
}

export function initHome() {
  renderHero();
  renderGrid();
  new ResizeObserver(() => $('#widget-grid').style.setProperty('--cols', columns())).observe($('#widget-grid'));
  $('#customize').addEventListener('click', openCustomize);
  setInterval(renderHero, 15000);
  for (const topic of ['mail', 'messages', 'calendar', 'music']) on(topic, renderGlance);
}
