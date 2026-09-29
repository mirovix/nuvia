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
      h('div.line1', h('strong', item.from || item.email || 'Mittente sconosciuto'), h('span.tag', account.name)),
      h('div.line2', item.subject || '(nessun oggetto)'),
      item.snippet ? h('div.line3', item.snippet) : null),
    h('div.side', h('time', item.time || relativeTime(item.at))));
}

defineWidget({
  id: 'mail', title: 'Posta', icon: 'mail', size: 'm', topics: ['mail', 'services'],
  options: [
    { key: 'unreadOnly', type: 'toggle', label: 'Solo email da leggere', default: true },
    { key: 'max', type: 'number', label: 'Quante email mostrare', default: 8, min: 3, max: 30 },
    { key: 'exclude', type: 'services', label: 'Caselle incluse', default: [], filter: service => service.group === 'mail' }
  ],
  actions: () => [h('button.icon-btn.small', { title: 'Aggiorna', on: { click: refreshMail } }, icon('refresh-cw'))],
  render(ctx) {
    const { unreadOnly, max, exclude } = ctx.options;
    const services = state.services.filter(service => service.group === 'mail' && !exclude.includes(service.id));
    if (!services.length) {
      ctx.setMeta('nessuna casella');
      return fill(ctx.body, empty('inbox', 'Nessuna casella collegata', 'Aggiungi Gmail o Outlook: le nuove email compariranno qui.', h('button.btn.sm', { on: { click: () => openAddService({ name: 'Gmail', url: 'https://mail.google.com/' }) } }, icon('plus'), 'Collega la posta')));
    }
    if (!state.mail) { ctx.setMeta('caricamento…'); return fill(ctx.body, skeleton(4)); }
    const accounts = state.mail.accounts.filter(account => !exclude.includes(account.serviceId));
    const unread = accounts.reduce((total, account) => total + (account.unread || 0), 0);
    ctx.setMeta(`${unread ? `${unread} da leggere` : 'tutto letto'} · ${accounts.length} ${accounts.length === 1 ? 'casella' : 'caselle'}`);
    const strip = h('div.account-strip', accounts.map(account => {
      const service = state.services.find(item => item.id === account.serviceId);
      return h('button.chip', { title: account.loggedOut ? 'Accesso richiesto' : '', on: { click: () => openService(account.serviceId) } },
        service ? favicon(service) : null, account.name, account.loggedOut ? icon('log-in') : (account.unread ? h('b', String(account.unread)) : null));
    }));
    const all = accounts.flatMap(account => account.items.map(item => ({ account, item })));
    const unreadItems = all.filter(({ item }) => item.unread);
    const shown = (unreadOnly ? unreadItems : all).sort((a, b) => (b.item.at || 0) - (a.item.at || 0)).slice(0, max);
    const loading = accounts.some(account => account.loading);
    let list;
    if (shown.length) list = h('div.rows', shown.map(({ account, item }) => mailRow(account, item)));
    else if (loading && !all.length) list = skeleton(3);
    else if (unreadOnly && all.length) list = h('div', empty('check-check', 'Nessuna email da leggere', 'Ecco le ultime arrivate.'), h('div.rows', all.slice(0, 3).map(({ account, item }) => mailRow(account, item))));
    else list = empty('inbox', 'Nessuna email visibile', accounts.some(account => account.loggedOut) ? 'Alcune caselle chiedono di accedere di nuovo.' : 'Apri una casella per sincronizzarla.');
    fill(ctx.body, strip, list);
  }
});
