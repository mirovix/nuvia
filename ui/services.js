import { api, state, $, $$, h, icon, fill, emit, on, sheet, openModal, toast, confirmDialog, hostOf } from './core.js';
import { serviceKind, serviceGroup, PRESETS } from '../lib/kinds.js';
import { go, openService, renderTopbar, PAGES } from './router.js';

// Icons already loaded once are shown straight away: rebuilding a row must not
// flash the letter placeholder before the image comes back from cache.
const loadedIcons = new Set();
export function favicon(service, size = '') {
  const live = state.live.get(service.id);
  const src = live?.favicon || service.favicon;
  const known = src && loadedIcons.has(src);
  const el = h(`span.favicon${size ? `.${size}` : ''}`, known ? null : (service.name.trim()[0] || '·').toUpperCase());
  if (src) {
    const img = h('img', { src, alt: '', decoding: 'sync' });
    img.onload = () => { loadedIcons.add(src); if (el.firstChild?.nodeType === 3) el.firstChild.remove(); };
    img.onerror = () => { loadedIcons.delete(src); img.remove(); if (!el.textContent) el.textContent = (service.name.trim()[0] || '·').toUpperCase(); };
    el.append(img);
  }
  return el;
}

export async function loadServices() {
  const list = await api.listServices();
  state.services = list.map(service => ({ ...service, kind: serviceKind(service), group: serviceGroup(service) }));
  renderSidebar();
  emit('services');
}

async function persist() {
  await api.saveServices(state.services.map(({ kind, group, ...service }) => service));
  renderSidebar(); emit('services');
}

let dragged = null;
let sidebarSignature = '';
export function renderSidebar() {
  const list = $('#service-list');
  // State updates arrive many times per second (titles, loading, favicons):
  // only rebuild when something visible in the sidebar actually changed.
  const signature = JSON.stringify([state.route, state.serviceId, state.services.map(service => {
    const live = state.live.get(service.id) || {};
    return [service.id, service.name, live.favicon, live.unread, Boolean(live.loading), Boolean(live.crashed), Boolean(live.audible)];
  })]);
  if (signature === sidebarSignature && list.childElementCount === state.services.length) return;
  sidebarSignature = signature;
  fill(list, state.services.map((service, index) => {
    const live = state.live.get(service.id) || {};
    const row = h(`button.service${state.route === 'service' && state.serviceId === service.id ? '.active' : ''}${live.loading ? '.loading' : ''}${live.crashed ? '.crashed' : ''}${live.audible ? '.audible' : ''}`, {
      draggable: true, title: `${service.name}${index < 9 ? ` · Ctrl+${index + 1}` : ''}`, dataset: { id: service.id },
      on: {
        click: () => openService(service.id),
        contextmenu: event => { event.preventDefault(); api.serviceMenu(service.id); },
        dragstart: event => { dragged = service.id; row.classList.add('dragging'); event.dataTransfer.effectAllowed = 'move'; },
        dragend: () => { dragged = null; row.classList.remove('dragging'); $$('.service.drop-before').forEach(item => item.classList.remove('drop-before')); },
        dragover: event => { if (!dragged || dragged === service.id) return; event.preventDefault(); $$('.service.drop-before').forEach(item => item.classList.remove('drop-before')); row.classList.add('drop-before'); },
        drop: event => {
          event.preventDefault();
          const from = state.services.findIndex(item => item.id === dragged);
          if (from < 0) return;
          const [moved] = state.services.splice(from, 1);
          state.services.splice(state.services.findIndex(item => item.id === service.id), 0, moved);
          persist();
        }
      }
    }, favicon(service), h('span.label', service.name), live.unread ? h('b.count.badge', String(live.unread > 99 ? '99+' : live.unread)) : null, h('i.status'));
    return row;
  }));
  const messageUnread = state.services.filter(service => service.group === 'message').reduce((total, service) => total + (state.live.get(service.id)?.unread || 0), 0);
  const badge = $('[data-route="messages"] .count');
  badge.hidden = !messageUnread; badge.textContent = messageUnread;
}

export function applyLiveState(value) {
  state.live = new Map(value.map(item => [item.id, item]));
  renderSidebar(); renderTopbar();
  emit('live');
}

function serviceForm(initial = {}) {
  const name = h('input', { placeholder: 'e.g. Work Gmail', value: initial.name || '', required: true, autocomplete: 'off' });
  const url = h('input', { placeholder: 'https://', value: initial.url || '', type: 'url', required: true, autocomplete: 'off', spellcheck: false });
  return { name, url, fields: [h('label.field', h('span', 'Name'), name), h('label.field', h('span', 'Address'), url, h('small', 'Your sign-in is kept in a separate profile just for this service.'))] };
}

function validUrl(value) {
  const text = String(value || '').trim();
  const candidate = /^[a-z]+:\/\//i.test(text) ? text : `https://${text}`;
  try { const parsed = new URL(candidate); return /^https?:$/.test(parsed.protocol) && parsed.hostname.includes('.') ? parsed.href : null; } catch { return null; }
}

export function openAddService(preset = null) {
  const form = serviceForm(preset || {});
  const presets = h('div.preset-grid', PRESETS.map(item => h('button.preset', {
    type: 'button',
    on: { click: event => { form.name.value = item.name; form.url.value = item.url; $$('.preset', presets).forEach(button => button.classList.toggle('on', button === event.currentTarget)); form.name.focus(); } }
  }, h('span.favicon', item.name[0]), h('span', item.name))));
  const submit = h('button.btn.accent', { type: 'submit', id: 'save-service' }, 'Add');
  const dialog = sheet({
    title: 'New service', subtitle: 'Pick a preset or paste any address.',
    body: [presets, ...form.fields],
    foot: [h('button.btn.ghost', { type: 'button', on: { click: () => dialog.close() } }, 'Cancel'), submit]
  });
  dialog.id = 'service-dialog';
  const formEl = h('form.sheet-inner', { method: 'dialog', on: { submit: async event => {
    event.preventDefault();
    const href = validUrl(form.url.value);
    if (!form.name.value.trim()) { form.name.focus(); return; }
    if (!href) { form.url.setCustomValidity('Enter a valid web address'); form.url.reportValidity(); return; }
    const service = { id: crypto.randomUUID(), name: form.name.value.trim(), url: href };
    state.services.push({ ...service, kind: serviceKind(service), group: serviceGroup(service) });
    await persist();
    dialog.close();
    await openService(service.id);
    toast(`${service.name} added`, { action: { label: 'Add another', run: () => openAddService() } });
  } } });
  form.url.addEventListener('input', () => form.url.setCustomValidity(''));
  formEl.append(...dialog.firstChild.childNodes);
  dialog.replaceChildren(formEl);
  openModal(dialog).then(() => form.name.focus());
  return dialog;
}

// Optional: credentials Nuvia fills in when the service's session expires
// (e.g. a university Google Workspace that signs you out every few hours).
function signInSection(id) {
  const box = h('div.signin-box#signin-box');
  const render = async () => {
    const current = await api.signInGet(id);
    if (!current.available) return fill(box, h('h3', 'Automatic sign-in'), h('p.muted', 'Unavailable: the system keychain is not accessible, so passwords can’t be stored safely.'));
    const username = h('input', { placeholder: 'Email or username', value: current.username, autocomplete: 'off', spellcheck: false });
    const password = h('input', { type: 'password', placeholder: current.saved ? 'Saved (type to replace)' : 'Password', autocomplete: 'new-password' });
    const save = h('button.btn.sm', { type: 'button', on: { click: async () => {
      try { await api.signInSet(id, { username: username.value, password: password.value }); toast('Automatic sign-in saved'); render(); }
      catch (error) { toast(String(error.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
    } } }, current.saved ? 'Update' : 'Turn on');
    const clear = current.saved ? h('button.btn.sm.ghost.danger', { type: 'button', on: { click: async () => { await api.signInClear(id); toast('Automatic sign-in turned off'); render(); } } }, 'Turn off') : null;
    fill(box,
      h('h3', 'Automatic sign-in', current.saved ? h('span.state.ok', { style: 'margin-left:8px' }, 'on') : null),
      h('p.muted', 'When this service signs you out, Nuvia fills in these details on the sign-in pages (Google, university SSO, Microsoft). They are stored encrypted in the system keychain and used only for this service. Two-step verification still needs you.'),
      h('div.field', username), h('div.field', password), h('div.inline', save, clear));
  };
  render();
  return box;
}

export function openEditService(id) {
  const service = state.services.find(item => item.id === id);
  if (!service) return;
  const form = serviceForm(service);
  const signIn = signInSection(id);
  const dialog = sheet({
    title: 'Edit service', subtitle: hostOf(service.url), body: [...form.fields, signIn],
    foot: [h('button.btn.ghost.danger.left', { type: 'button', on: { click: async () => { dialog.close(); removeService(id); } } }, icon('trash-2'), 'Remove'),
      h('button.btn.ghost', { type: 'button', on: { click: () => dialog.close() } }, 'Cancel'),
      h('button.btn.accent', { type: 'button', on: { click: async () => {
        const href = validUrl(form.url.value);
        if (!href || !form.name.value.trim()) { form.url.setCustomValidity(href ? '' : 'Invalid address'); form.url.reportValidity(); return; }
        const changedUrl = href !== service.url;
        Object.assign(service, { name: form.name.value.trim(), url: href, kind: serviceKind({ ...service, url: href }), group: serviceGroup({ ...service, url: href }) });
        await persist();
        if (changedUrl) { await api.removeView(id); if (state.serviceId === id) openService(id); }
        dialog.close();
        renderTopbar();
      } } }, 'Save')]
  });
  openModal(dialog);
}

export async function removeService(id) {
  const service = state.services.find(item => item.id === id);
  if (!service) return;
  if (!await confirmDialog(`Remove ${service.name}?`, 'It will disappear from the sidebar. Sign-in data stays on this computer until you clear it.', { confirm: 'Remove', danger: true })) return;
  state.services = state.services.filter(item => item.id !== id);
  await persist();
  await api.removeView(id);
  if (state.serviceId === id) go('home');
  toast(`${service.name} removed`);
}

// Ctrl+K: jump to any page or service.
export function openPalette() {
  if ($('dialog.palette[open]')) return;
  const input = h('input', { placeholder: 'Go to a service or section…', autocomplete: 'off', spellcheck: false });
  const results = h('div.results');
  const dialog = h('dialog.palette', { dataset: { transient: '1' } }, input, results);
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  const entries = [
    ...Object.entries(PAGES).map(([route, label]) => ({ label, hint: 'Section', icon: { home: 'house', messages: 'message-circle', calendar: 'calendar', music: 'music', ai: 'gauge' }[route], run: () => go(route) })),
    ...state.services.map((service, index) => ({ label: service.name, hint: index < 9 ? `Ctrl+${index + 1}` : hostOf(service.url), service, run: () => openService(service.id) })),
    { label: 'Add service', hint: 'Action', icon: 'plus', run: () => openAddService() }
  ];
  let selected = 0; let visible = entries;
  const render = () => {
    const query = input.value.trim().toLowerCase();
    visible = entries.filter(entry => !query || entry.label.toLowerCase().includes(query));
    selected = Math.min(selected, Math.max(0, visible.length - 1));
    fill(results, visible.map((entry, index) => h(`button${index === selected ? '.on' : ''}`, { type: 'button', on: { click: () => { dialog.close(); entry.run(); } } },
      entry.service ? favicon(entry.service) : h('span.favicon', icon(entry.icon)), h('span', entry.label), h('kbd', entry.hint))));
  };
  input.addEventListener('input', () => { selected = 0; render(); });
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { selected = Math.min(visible.length - 1, selected + 1); render(); event.preventDefault(); }
    if (event.key === 'ArrowUp') { selected = Math.max(0, selected - 1); render(); event.preventDefault(); }
    if (event.key === 'Enter' && visible[selected]) { dialog.close(); visible[selected].run(); }
  });
  render();
  openModal(dialog).then(() => input.focus());
}

export function handleShortcut({ key, shift }) {
  if (/^[1-9]$/.test(key)) { const service = state.services[Number(key) - 1]; if (service) openService(service.id); }
  else if (key === '0') go('home');
  else if (key === 'r' || key === 'f5') { if (state.route === 'service') api.reload(state.serviceId); }
  else if (key === 'k') openPalette();
  else if (key === ',') $('#open-settings').click();
}

export function initServices() {
  $('#sidebar-add').addEventListener('click', () => openAddService());
  $('#add-service').addEventListener('click', () => openAddService());
  $('#nav-back').addEventListener('click', () => api.back());
  $('#nav-forward').addEventListener('click', () => api.forward());
  $('#nav-reload').addEventListener('click', () => api.reload(state.serviceId));
  $('#open-palette').addEventListener('click', openPalette);
  api.onServiceState(applyLiveState);
  api.onOpenService(id => openService(id));
  api.onEditService(openEditService);
  api.onRemoveService(removeService);
  api.onShortcut(handleShortcut);
  document.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (/^[0-9]$/.test(key) || ['k', 'r', ','].includes(key)) { event.preventDefault(); handleShortcut({ key, shift: event.shiftKey }); }
  });
  on('route', renderSidebar);
}
