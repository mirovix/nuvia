import { api, state, $, $$, emit, fill, h, icon, hostOf } from './core.js';

export const PAGES = { home: 'Overview', messages: 'Messages', calendar: 'Calendar', music: 'Music', ai: 'Claude & Codex' };

function markNav() {
  $$('#nav .nav-item').forEach(item => item.classList.toggle('active', state.route === item.dataset.route));
  $$('#service-list .service').forEach(item => item.classList.toggle('active', state.route === 'service' && item.dataset.id === state.serviceId));
  $('#customize').hidden = state.route !== 'home';
}

export function renderTopbar() {
  const service = state.route === 'service' ? state.services.find(item => item.id === state.serviceId) : null;
  const live = service ? state.live.get(service.id) : null;
  $('#service-nav').hidden = !service;
  $('#page-title').textContent = service ? service.name : PAGES[state.route];
  $('#page-sub').textContent = service ? hostOf(live?.url || service.url) : '';
  $('#nav-back').disabled = !live?.canGoBack;
  $('#nav-forward').disabled = !live?.canGoForward;
  $('#load-bar').hidden = !live?.loading;
  renderViewState();
}

let viewStateKey = '';
export function renderViewState() {
  const box = $('#view-state');
  const key = `${state.route}|${state.serviceId}|${Boolean(state.live.get(state.serviceId)?.crashed)}`;
  if (key === viewStateKey && box.childElementCount) return;
  viewStateKey = key;
  const service = state.route === 'service' ? state.services.find(item => item.id === state.serviceId) : null;
  if (!service) return fill(box);
  const live = state.live.get(service.id);
  if (live?.crashed) {
    return fill(box, icon('triangle-alert'), h('h3', `${service.name} stopped`), h('span', 'The service page closed unexpectedly. If this keeps happening, try turning off extensions for this service.'),
      h('button.btn.accent', { on: { click: () => api.reload(service.id) } }, icon('rotate-cw'), 'Reload'));
  }
  fill(box, h('div.spinner'), h('span', `Opening ${service.name}…`));
}

export async function go(route) {
  if (!PAGES[route]) route = 'home';
  state.route = route; state.serviceId = null;
  $$('.page').forEach(page => { page.hidden = page.dataset.page !== route; });
  $('#view-host').hidden = true;
  await api.home();
  markNav(); renderTopbar();
  emit('route', route);
}

// Switch the UI chrome to a service; the caller decides how the view is activated.
export function enterService(id) {
  if (!state.services.some(item => item.id === id)) return false;
  state.route = 'service'; state.serviceId = id;
  $$('.page').forEach(page => { page.hidden = true; });
  $('#view-host').hidden = false;
  markNav(); renderTopbar();
  emit('route', 'service');
  return true;
}

export async function openService(id, { url } = {}) {
  if (!enterService(id)) return;
  if (url) await api.activateUrl(id, url); else await api.activate(id);
}

export function firstService(group) {
  return state.services.find(service => service.group === group || service.kind === group);
}
