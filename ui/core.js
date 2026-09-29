import { ICONS } from './icons.js';

export const api = window.nuvia;
export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const SVG = 'http://www.w3.org/2000/svg';
export function icon(name, extra = '') {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `i ${extra}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] || '';
  return svg;
}

// h('button.btn.accent', { on: { click } }, icon('plus'), 'Add')
export function h(spec, props = {}, ...children) {
  if (props instanceof Node || typeof props === 'string' || Array.isArray(props)) { children.unshift(props); props = {}; }
  const name = spec.match(/^[a-z][a-z0-9-]*/i)?.[0] || 'div';
  const id = spec.match(/#([\w-]+)/)?.[1];
  const classes = [...spec.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
  const el = document.createElement(name);
  if (id) el.id = id;
  if (classes.length) el.className = classes.join(' ');
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'on') for (const [event, handler] of Object.entries(value)) el.addEventListener(event, handler);
    else if (key === 'class') el.className = [el.className, value].filter(Boolean).join(' ');
    else if (key === 'text') el.textContent = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style') { if (typeof value === 'string') el.setAttribute('style', value); else Object.assign(el.style, value); }
    else if (key in el && !['list', 'form', 'type'].includes(key) && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}
export function fill(el, ...children) { el.replaceChildren(); append(el, children); return el; }

export function hydrateIcons(root = document) {
  for (const el of $$('[data-icon]', root)) {
    if (el.querySelector(':scope > svg.i')) continue;
    el.prepend(icon(el.dataset.icon));
  }
}

// ---------------------------------------------------------------------------
// State + tiny event bus

export const state = {
  services: [], live: new Map(), prefs: {}, route: 'home', serviceId: null,
  mail: null, messages: null, calendar: null, music: null, usage: null, notifications: [], extensions: []
};
const listeners = new Map();
export function on(topic, fn) { if (!listeners.has(topic)) listeners.set(topic, new Set()); listeners.get(topic).add(fn); return () => listeners.get(topic).delete(fn); }
export function emit(topic, data) { for (const fn of listeners.get(topic) || []) { try { fn(data); } catch (error) { console.error(topic, error); } } }

let saveTimer;
export function savePrefs() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api.savePreferences(state.prefs), 150);
}
export function flushPrefs() { clearTimeout(saveTimer); return api.savePreferences(state.prefs); }

// ---------------------------------------------------------------------------
// Formatting

export const pad = value => String(value).padStart(2, '0');
export const clock = at => { const date = new Date(at); return `${pad(date.getHours())}:${pad(date.getMinutes())}`; };
export function sameDay(a, b) { const x = new Date(a); const y = new Date(b); return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate(); }
export function startOfDay(at) { const date = new Date(at); date.setHours(0, 0, 0, 0); return date; }
export function dayLabel(at, { long = false } = {}) {
  const today = startOfDay(Date.now());
  const diff = Math.round((startOfDay(at) - today) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return new Date(at).toLocaleDateString('en-GB', long ? { weekday: 'long', day: 'numeric', month: 'long' } : { weekday: 'short', day: 'numeric', month: 'short' });
}
export function relativeTime(at) {
  if (!at) return '';
  const minutes = Math.round((Date.now() - at) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (sameDay(at, Date.now())) return clock(at);
  if (minutes < 2880 && sameDay(at, Date.now() - 86400000)) return 'yesterday';
  return new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
export function countdown(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const minutes = Math.round(ms / 60000);
  const days = Math.floor(minutes / 1440); const hours = Math.floor((minutes % 1440) / 60); const rest = minutes % 60;
  if (days) return `${days} d ${hours} h`;
  if (hours) return `${hours} h ${pad(rest)} min`;
  return `${rest} min`;
}
export function tokens(value) {
  const n = Number(value || 0);
  if (n >= 1e9) return `${(n / 1e9).toLocaleString('en-GB', { maximumFractionDigits: 2 })}B`;
  if (n >= 1e6) return `${(n / 1e6).toLocaleString('en-GB', { maximumFractionDigits: 1 })}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3).toLocaleString('en-GB')}k`;
  return String(n);
}
export function hue(text = '') { let value = 0; for (const char of text) value = (value * 31 + char.charCodeAt(0)) % 360; return value; }
export function initials(name = '') { return name.replace(/[^\p{L}\p{N} ]/gu, '').split(' ').filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || '·'; }
export function avatar(name, src, extra = '') {
  const el = h(`span.avatar${extra ? `.${extra}` : ''}`, { style: `--hue:${hue(name)}` }, initials(name));
  if (src) { const img = h('img', { src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }); img.onerror = () => img.remove(); el.append(img); }
  return el;
}
export function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } }

// ---------------------------------------------------------------------------
// Dialogs. Native service views sit above the HTML layer, so every modal asks
// the main process to lift the view out and paints its screenshot instead.

export async function openModal(dialog) {
  if (dialog.open) return dialog;
  if (!dialog.isConnected) document.body.append(dialog);
  const shot = await api.setOverlay(true);
  if (shot) $('#view-shot').style.backgroundImage = `url("${shot}")`;
  dialog.showModal();
  dialog.addEventListener('close', () => {
    api.setOverlay(false);
    if (!document.querySelector('dialog[open]')) $('#view-shot').style.backgroundImage = '';
    if (dialog.dataset.transient) dialog.remove();
  }, { once: true });
  return dialog;
}

export function sheet({ title, subtitle = '', body = [], foot = [], wide = false, transient = true, cls = '' }) {
  const dialog = h(`dialog.sheet${wide ? '.wide' : ''}${cls ? `.${cls}` : ''}`, { dataset: transient ? { transient: '1' } : {} });
  const closeButton = h('button.icon-btn', { type: 'button', title: 'Close', on: { click: () => dialog.close() } }, icon('x'));
  dialog.append(h('div.sheet-inner',
    h('div.sheet-head', h('div', h('h2', title), subtitle ? h('p', subtitle) : null), closeButton),
    h('div.sheet-body', body),
    foot.length ? h('div.sheet-foot', foot) : null));
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  return dialog;
}

export async function popover(anchor, content, { cls = '', width = 300 } = {}) {
  const dialog = h(`dialog.popover${cls ? `.${cls}` : ''}`, { dataset: { transient: '1' } }, content);
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  document.body.append(dialog);
  const rect = anchor.getBoundingClientRect();
  const left = Math.max(12, Math.min(rect.right - width, innerWidth - width - 12));
  dialog.style.left = `${left}px`;
  dialog.style.width = `${width}px`;
  dialog.style.top = `${Math.min(rect.bottom + 8, innerHeight - 120)}px`;
  await openModal(dialog);
  const height = dialog.getBoundingClientRect().height;
  if (rect.bottom + 8 + height > innerHeight - 12) dialog.style.top = `${Math.max(12, rect.top - height - 8)}px`;
  return dialog;
}

export function confirmDialog(title, message, { confirm = 'Confirm', danger = false } = {}) {
  return new Promise(resolveChoice => {
    let choice = false;
    const dialog = sheet({
      title, subtitle: message,
      foot: [h('button.btn.ghost', { type: 'button', on: { click: () => dialog.close() } }, 'Cancel'),
        h(`button.btn${danger ? '.danger' : '.accent'}`, { type: 'button', on: { click: () => { choice = true; dialog.close(); } } }, confirm)]
    });
    dialog.addEventListener('close', () => resolveChoice(choice), { once: true });
    openModal(dialog);
  });
}

export function toast(message, { action, timeout = 5000 } = {}) {
  const el = h('div.toast', h('span', message));
  if (action) el.append(h('button', { on: { click: () => { dismiss(); action.run(); } } }, action.label));
  const dismiss = () => { el.classList.add('leaving'); setTimeout(() => el.remove(), 200); };
  $('#toasts').append(el);
  setTimeout(dismiss, timeout);
  return el;
}

export function segmented(options, value, onChange) {
  const el = h('div.segmented');
  for (const option of options) {
    const button = h(`button${option.value === value ? '.on' : ''}`, { type: 'button', title: option.title || '', on: { click: () => { $$('button', el).forEach(item => item.classList.toggle('on', item === button)); onChange(option.value); } } }, option.icon ? icon(option.icon) : null, option.label || '');
    el.append(button);
  }
  return el;
}

export function toggle(value, onChange, label = '') {
  const el = h(`button.toggle${value ? '.on' : ''}`, { type: 'button', role: 'switch', 'aria-checked': String(Boolean(value)), 'aria-label': label });
  el.addEventListener('click', () => { const next = !el.classList.contains('on'); el.classList.toggle('on', next); el.setAttribute('aria-checked', String(next)); onChange(next); });
  return el;
}

export function empty(iconName, title, text = '', action = null) {
  return h('div.empty', icon(iconName), title ? h('strong', title) : null, text ? h('span', text) : null, action);
}
export function skeleton(rows = 3) { return h('div.skeleton', Array.from({ length: rows }, () => h('i'))); }
