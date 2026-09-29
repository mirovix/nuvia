import { api, state, h, icon, fill, emit, avatar, empty, skeleton, relativeTime } from './core.js';
import { defineWidget } from './home.js';
import { enterService, openService } from './router.js';
import { openAddService, favicon } from './services.js';

let busy = false;
export async function refreshMail() {
  if (busy) return;
  busy = true;
  try { state.mail = await api.mail(); emit('mail'); } catch (error) { console.error(error); } finally { busy = false; }
}

async function openItem(account, item) {
  enterService(account.serviceId);
  await api.openMail(account.serviceId, item);
}

function mailRow(account, item) {
  return h(`button.row${item.unread ? '.unread' : ''}`, { type: 'button', title: item.fullTime || '', on: { click: () => openItem(account, item) } },
    avatar(item.from || item.email || '?'),
    h('div.main',
      h('div.line1', h('strong', item.from || item.email || 'Unknown sender'), h('span.tag', account.name)),
      h('div.line2', item.subject || '(no subject)'),
      item.snippet ? h('div.line3', item.snippet) : null),
    h('div.side', h('time', item.time || relativeTime(item.at))));
}

defineWidget({
  id: 'mail', title: 'Mail', icon: 'mail', size: 'm', topics: ['mail', 'services'],
  options: [
    { key: 'unreadOnly', type: 'toggle', label: 'Unread only', default: true },
    { key: 'max', type: 'number', label: 'Emails to show', default: 8, min: 3, max: 30 },
    { key: 'exclude', type: 'services', label: 'Included mailboxes', default: [], filter: service => service.group === 'mail' }
  ],
  actions: () => [h('button.icon-btn.small', { title: 'Refresh', on: { click: refreshMail } }, icon('refresh-cw'))],
  render(ctx) {
    const { unreadOnly, max, exclude } = ctx.options;
    const services = state.services.filter(service => service.group === 'mail' && !exclude.includes(service.id));
    if (!services.length) {
      ctx.setMeta('no mailboxes');
      return fill(ctx.body, empty('inbox', 'No mailbox connected', 'Add Gmail or Outlook and new email will show up here.', h('button.btn.sm', { on: { click: () => openAddService({ name: 'Gmail', url: 'https://mail.google.com/' }) } }, icon('plus'), 'Connect mail')));
    }
    if (!state.mail) { ctx.setMeta('loading…'); return fill(ctx.body, skeleton(4)); }
    const accounts = state.mail.accounts.filter(account => !exclude.includes(account.serviceId));
    const unread = accounts.reduce((total, account) => total + (account.unread || 0), 0);
    ctx.setMeta(`${unread ? `${unread} unread` : 'all read'} · ${accounts.length} ${accounts.length === 1 ? 'mailbox' : 'mailboxes'}`);
    const strip = h('div.account-strip', accounts.map(account => {
      const service = state.services.find(item => item.id === account.serviceId);
      return h('button.chip', { title: account.loggedOut ? 'Sign-in required' : '', on: { click: () => openService(account.serviceId) } },
        service ? favicon(service) : null, account.name, account.loggedOut ? icon('log-in') : (account.unread ? h('b', String(account.unread)) : null));
    }));
    const all = accounts.flatMap(account => account.items.map(item => ({ account, item })));
    const unreadItems = all.filter(({ item }) => item.unread);
    const shown = (unreadOnly ? unreadItems : all).sort((a, b) => (b.item.at || 0) - (a.item.at || 0)).slice(0, max);
    const loading = accounts.some(account => account.loading);
    let list;
    if (shown.length) list = h('div.rows', shown.map(({ account, item }) => mailRow(account, item)));
    else if (loading && !all.length) list = skeleton(3);
    else if (unreadOnly && all.length) list = h('div', empty('check-check', 'No unread email', 'Here are the latest ones.'), h('div.rows', all.slice(0, 3).map(({ account, item }) => mailRow(account, item))));
    else list = empty('inbox', 'No email to show', accounts.some(account => account.loggedOut) ? 'Some mailboxes need you to sign in again.' : 'Open a mailbox to sync it.');
    fill(ctx.body, strip, list);
  }
});
