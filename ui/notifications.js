import { api, state, $, h, icon, fill, emit, on, empty, relativeTime, popover } from './core.js';
import { defineWidget } from './home.js';

const TYPE_ICON = { mail: 'mail', message: 'message-circle', train: 'train-front', success: 'circle-check', error: 'triangle-alert', warning: 'triangle-alert', info: 'bell' };

export async function refreshNotifications() {
  state.notifications = await api.listNotifications();
  const unread = state.notifications.filter(item => !item.read).length;
  const badge = $('#open-notifications .dot-badge');
  badge.hidden = !unread; badge.textContent = unread > 99 ? '99+' : String(unread);
  emit('notifications');
}

async function remove(id) { state.notifications = await api.removeNotification(id); await refreshNotifications(); }
async function clearAll() { await api.removeNotification(null); await refreshNotifications(); }

function notificationRow(item, compact = false) {
  return h(`div.notif${item.read ? '' : '.unread'}`, { dataset: { id: item.id } },
    h('span.n-icon', icon(TYPE_ICON[item.type] || 'bell')),
    h('div', h('strong', item.title || 'Nuvia'), item.body ? h('p', item.body) : null, h('time', relativeTime(Date.parse(item.time)))),
    h('button.icon-btn.small.delete-notification', { title: 'Elimina', on: { click: event => { event.stopPropagation(); remove(item.id); } } }, icon('x')));
}

function list(limit) {
  const items = state.notifications.slice(0, limit);
  return items.length ? items.map(item => notificationRow(item)) : [empty('bell-off', 'Nessuna notifica', 'Treni in ritardo, nuove email e avvisi arrivano qui.')];
}

export async function openPanel(anchor) {
  const body = h('div.notif-list');
  const render = () => fill(body, list(80));
  const dialog = await popover(anchor, [
    h('div.pop-head', h('h3', 'Notifiche'),
      h('button.icon-btn.small', { title: 'Segna tutte come lette', on: { click: async () => { await api.readAllNotifications(); await refreshNotifications(); } } }, icon('check-check')),
      h('button.btn.sm.ghost#clear-notifications', { on: { click: clearAll } }, icon('trash-2'), 'Cancella tutte')),
    body], { cls: 'notif-panel', width: 380 });
  render();
  const off = on('notifications', render);
  dialog.addEventListener('close', async () => { off(); if (state.notifications.some(item => !item.read)) { await api.readAllNotifications(); refreshNotifications(); } }, { once: true });
}

defineWidget({
  id: 'notifications', title: 'Notifiche', icon: 'bell', size: 's', topics: ['notifications'],
  options: [{ key: 'max', type: 'number', label: 'Quante mostrarne', default: 8, min: 3, max: 40 }],
  actions: () => [h('button.icon-btn.small', { title: 'Cancella tutte', on: { click: clearAll } }, icon('trash-2'))],
  render(ctx) {
    const unread = state.notifications.filter(item => !item.read).length;
    ctx.setMeta(state.notifications.length ? `${unread} nuove · ${state.notifications.length} totali` : 'tutto tranquillo');
    fill(ctx.body, h('div', list(ctx.options.max)));
  }
});

export function initNotifications() {
  $('#open-notifications').addEventListener('click', event => openPanel(event.currentTarget));
  api.onNotificationsChanged(refreshNotifications);
}
