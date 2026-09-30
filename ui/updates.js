// Update banner and the "Updates" part of Settings. The main process does the work
// (lib/updater.js); this only shows where it is and offers "Restart now".
import { api, h, fill, icon, toast } from './core.js';

let current = null;
const listeners = new Set();
const banner = h('div.update-banner#update-banner', { hidden: true });

function describe(u) {
  if (!u) return '';
  switch (u.state) {
    case 'checking': return 'Checking for updates…';
    case 'current': return `Nuvia ${u.current} is up to date.`;
    case 'downloading': return `Downloading Nuvia ${u.version}… ${Math.round((u.progress || 0) * 100)}%`;
    case 'ready': return `Nuvia ${u.version} is ready. It installs when you restart.`;
    case 'available': return `Nuvia ${u.version} is available.`;
    case 'error': return u.error || 'The update check failed.';
    case 'installed': return 'Update installed, restarting…';
    default: return `Nuvia ${u.current}`;
  }
}

const restart = async () => { if (!(await api.restartToUpdate())) toast('Could not install the update. See Settings → About.'); };
const download = () => window.open(current?.page || 'https://github.com/mirovix/nuvia/releases/latest');

function drawBanner() {
  const u = current;
  const show = u && (u.state === 'ready' || (u.state === 'available' && !sessionStorage.getItem(`update-dismissed-${u.version}`)));
  banner.hidden = !show;
  if (!show) return;
  const dismiss = h('button.icon-btn', { type: 'button', title: 'Later', on: { click: () => { sessionStorage.setItem(`update-dismissed-${u.version}`, '1'); banner.hidden = true; } } }, icon('x'));
  fill(banner, icon('rotate-cw'), h('span', describe(u)),
    u.state === 'ready'
      ? h('button.btn.sm.accent#update-restart', { type: 'button', on: { click: restart } }, 'Restart now')
      : h('button.btn.sm.accent#update-download', { type: 'button', on: { click: download } }, 'Download'),
    dismiss);
}

function set(u) {
  current = u;
  drawBanner();
  for (const fn of listeners) fn(u);
}

export async function initUpdates() {
  // In the top bar: service pages are drawn above the rest of the window.
  const actions = document.querySelector('#topbar .top-actions');
  if (actions) actions.prepend(banner); else document.body.append(banner);
  api.onUpdate(set);
  set(await api.updateState());
}

/** Block for Settings → About: version, status, "Check now". */
export function updateSection() {
  const status = h('p.dim#update-status');
  const action = h('div.inline');
  const draw = u => {
    // The settings sheet was closed: stop updating it.
    if (!status.isConnected && status.dataset.drawn) { listeners.delete(draw); return; }
    status.dataset.drawn = '1';
    status.textContent = describe(u);
    fill(action,
      h('button.btn.sm#check-updates', { type: 'button', disabled: ['checking', 'downloading'].includes(u?.state), on: { click: () => api.checkForUpdates() } }, 'Check for updates'),
      u?.state === 'ready' ? h('button.btn.sm.accent', { type: 'button', on: { click: restart } }, 'Restart now') : null,
      u?.state === 'available' ? h('button.btn.sm.accent', { type: 'button', on: { click: download } }, 'Download') : null);
  };
  listeners.add(draw);
  draw(current);
  return h('div.field', h('span', 'Updates'), status, action,
    h('small', 'Nuvia checks GitHub for fixes every few hours, downloads them in the background and installs them when you restart. Turn it off in General.'));
}
