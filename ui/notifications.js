import { api, state, $, h, icon, fill, emit, on, empty, relativeTime, popover } from './core.js';
import { defineWidget } from './home.js';
import { openService } from './router.js';

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

// Clicking a notification reads it: it opens what it is about and goes away.
async function openNotification(item) {
  await api.dismissNotifications({ ids: [item.id] });
  await refreshNotifications();
  if (item.serviceId) openService(item.serviceId);
}

function notificationRow(item, compact = false) {
  return h(`div.notif${item.read ? '' : '.unread'}${item.serviceId ? '.linked' : ''}`, { dataset: { id: item.id }, on: { click: event => { event.currentTarget.closest('dialog')?.close(); openNotification(item); } } },
    h('span.n-icon', icon(TYPE_ICON[item.type] || 'bell')),
    h('div', h('strong', item.title || 'Nuvia'), item.body ? h('p', item.body) : null, h('time', relativeTime(Date.parse(item.time)))),
    h('button.icon-btn.small.delete-notification', { title: 'Delete', on: { click: event => { event.stopPropagation(); remove(item.id); } } }, icon('x')));
}

function list(limit) {
  const items = state.notifications.slice(0, limit);
  return items.length ? items.map(item => notificationRow(item)) : [empty('bell-off', 'No notifications', 'Train delays, new emails and alerts show up here.')];
}

export async function openPanel(anchor) {
  const body = h('div.notif-list');
  const dialog = await popover(anchor, [
    h('div.pop-head', h('h3', 'Notifications'),
      h('button.btn.sm.ghost#clear-notifications', { on: { click: clearAll } }, icon('trash-2'), 'Clear all')),
    body], { cls: 'notif-panel', width: 380 });
  // Everything shown in the panel has been read: it goes once the panel closes.
  const seen = new Set();
  const render = () => { fill(body, list(80)); for (const item of state.notifications.slice(0, 80)) seen.add(item.id); };
  render();
  const off = on('notifications', render);
  dialog.addEventListener('close', async () => {
    off();
    if (seen.size) { await api.dismissNotifications({ ids: [...seen] }); refreshNotifications(); }
  }, { once: true });
}

defineWidget({
  id: 'notifications', title: 'Notifications', icon: 'bell', size: 's', topics: ['notifications'],
  options: [{ key: 'max', type: 'number', label: 'How many to show', default: 8, min: 3, max: 40 }],
  actions: () => [h('button.icon-btn.small', { title: 'Clear all', on: { click: clearAll } }, icon('trash-2'))],
  render(ctx) {
    const unread = state.notifications.filter(item => !item.read).length;
    ctx.setMeta(state.notifications.length ? `${unread} new · ${state.notifications.length} total` : 'all quiet');
    fill(ctx.body, h('div', list(ctx.options.max)));
  }
});

export function initNotifications() {
  $('#open-notifications').addEventListener('click', event => openPanel(event.currentTarget));
  api.onNotificationsChanged(refreshNotifications);
}
