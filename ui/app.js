import { api, state, $, $$, on, emit, hydrateIcons, icon } from './core.js';
import { go, openService } from './router.js';
import { initServices, loadServices, applyLiveState, openEditService, removeService } from './services.js';
import { initHome, renderHero } from './home.js';
import { refreshMail } from './mail.js';
import { initMessages, refreshMessages } from './messages.js';
import { initCalendar, refreshCalendar } from './calendar.js';
import { initMusic, refreshMusic } from './music.js';
import './commute.js';
import { initWidgets, refreshWeather, watchFavoriteTrains, refreshBoard, refreshIas, openIasLogin } from './widgets.js';
import { initNotifications, refreshNotifications } from './notifications.js';
import { initAi, refreshUsage } from './ai.js';
import { initSettings, applyAppearance, loadExtensions } from './settings.js';

const every = (ms, fn) => setInterval(() => { if (!document.hidden) fn(); }, ms);

function debounce(fn, ms) { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); }; }

// Turn rising unread counters into notifications (after the first sync settles).
const unreadBaseline = new Map();
let watchUnread = false;
const refreshFromCounters = { mail: debounce(refreshMail, 1500), message: debounce(refreshMessages, 1500) };
function trackUnread() {
  for (const service of state.services.filter(item => item.group === 'mail' || item.group === 'message')) {
    const current = state.live.get(service.id)?.unread || 0;
    const previous = unreadBaseline.get(service.id);
    if (previous !== undefined && current !== previous) refreshFromCounters[service.group]();
    if (watchUnread && previous !== undefined && current > previous) {
      api.addNotification({ title: service.name, body: service.group === 'mail' ? `${current - previous} ${current - previous === 1 ? 'new email' : 'new emails'}` : `${current - previous} ${current - previous === 1 ? 'new message' : 'new messages'}`, type: service.group, serviceId: service.id });
    }
    unreadBaseline.set(service.id, current);
  }
}

function wireWindow() {
  $('#window-min').addEventListener('click', () => api.minimize());
  $('#window-max').addEventListener('click', () => api.maximize());
  $('#window-close').addEventListener('click', () => api.close());
  const setMax = ({ maximized }) => { const button = $('#window-max'); button.replaceChildren(icon(maximized ? 'copy' : 'square')); button.title = maximized ? 'Restore' : 'Maximize'; };
  api.onWindowState(setMax);
  api.windowState().then(setMax);
  $('#topbar').addEventListener('dblclick', event => { if (!event.target.closest('button, input')) api.maximize(); });
  // Native service views are positioned over this box.
  const host = $('#view-host');
  const report = () => { const rect = host.getBoundingClientRect(); if (rect.width && rect.height) api.setViewBounds({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }); };
  new ResizeObserver(report).observe(host);
  addEventListener('resize', report);
}

async function init() {
  hydrateIcons();
  state.prefs = await api.getPreferences();
  applyAppearance();
  initServices();
  await loadServices();
  applyLiveState(await api.serviceState());
  initSettings();
  initHome();
  initWidgets();
  initMessages();
  initCalendar();
  initMusic();
  initAi();
  initNotifications();
  wireWindow();
  $$('#nav .nav-item').forEach(item => item.addEventListener('click', () => go(item.dataset.route)));
  on('go', route => go(route));
  on('open-service', id => openService(id));
  on('refresh-weather', refreshWeather);
  on('trains-config', refreshBoard);
  on('ias-refresh', refreshIas);
  on('ias-login', openIasLogin);
  on('hero', renderHero);
  on('live', trackUnread);
  on('services', loadExtensions);
  await go('home');
  document.body.classList.add('ready');

  refreshNotifications();
  loadExtensions();
  refreshWeather();
  refreshUsage();
  refreshMusic();
  refreshCalendar();
  // Mail and chat views load in the background after start-up; give them a moment.
  setTimeout(refreshMail, 2500);
  setTimeout(refreshMessages, 4000);
  setTimeout(() => { trackUnread(); watchUnread = true; }, 15000);
  watchFavoriteTrains();

  every(60000, refreshMail);
  every(45000, refreshMessages);
  every(15 * 60000, refreshCalendar);
  every(20 * 60000, refreshWeather);
  every(60000, refreshUsage);
  every(5 * 60000, watchFavoriteTrains);
  every(2 * 60000, refreshBoard);
  let musicTick = 0;
  every(1500, () => {
    musicTick += 1;
    const visible = state.route === 'music' || (state.route === 'home' && $('.widget[data-widget="music"]'));
    if (visible || musicTick % 4 === 0) refreshMusic();
  });
  // Entry points normally reached from native context menus (used by the UI tests).
  window.__nuviaDebug = { openEditService, removeService, state };
  window.__nuviaReady = true;
}

init().catch(error => {
  console.error(error);
  document.body.append(Object.assign(document.createElement('pre'), { textContent: `Nuvia failed to start:\n${error.stack || error}`, style: 'position:fixed;inset:20px;z-index:9999;padding:20px;background:#200;color:#fdd;white-space:pre-wrap' }));
});
