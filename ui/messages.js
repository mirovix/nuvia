import { api, state, $, h, icon, fill, emit, on, avatar, empty, skeleton, clock, dayLabel, sameDay, toast } from './core.js';
import { defineWidget } from './home.js';
import { enterService } from './router.js';
import { openAddService } from './services.js';

const KIND_LABEL = { whatsapp: 'WhatsApp', telegram: 'Telegram', mattermost: 'Mattermost', slack: 'Slack' };
const view = { source: 'all', unreadOnly: false, query: '', selected: null };
let busy = false;

export async function refreshMessages() {
  if (busy) return;
  busy = true;
  try { state.messages = await api.messages(); emit('messages'); } catch (error) { console.error(error); } finally { busy = false; }
}

export async function openConversation(item) {
  enterService(item.serviceId);
  await api.openMessage(item.serviceId, item);
}

function timeLabel(item) {
  if (!item.at) return item.time || '';
  return sameDay(item.at, Date.now()) ? clock(item.at) : (item.time || dayLabel(item.at));
}

function bubble(item, { selected = false, onSelect } = {}) {
  return h('div.bubble-row',
    avatar(item.chat, item.avatar),
    h(`button.bubble${item.unread ? '.unread' : ''}${selected ? '.selected' : ''}`, {
      type: 'button', title: 'Click to reply · double-click to open the chat',
      on: { click: () => onSelect?.(item), dblclick: () => openConversation(item) }
    },
    h('div.who', h('strong', item.chat), h(`span.tag.${item.kind}`, KIND_LABEL[item.kind] || item.service), h('time', timeLabel(item))),
    h('p', item.preview || 'No preview'),
    item.unread ? h('span.pill-count', String(item.unread)) : null));
}

// Oldest first, newest at the bottom — reads like a single conversation.
function timeline(items, { onSelect, selectedId } = {}) {
  const ordered = [...items].sort((a, b) => (a.at ?? -Infinity) - (b.at ?? -Infinity));
  const nodes = []; let lastDay = null;
  for (const item of ordered) {
    const day = item.at ? dayLabel(item.at, { long: true }) : 'Earlier';
    if (day !== lastDay) { nodes.push(h('div.day', day)); lastDay = day; }
    nodes.push(bubble(item, { selected: item.id === selectedId, onSelect }));
  }
  return nodes;
}

function filtered(items, { source = 'all', unreadOnly = false, query = '', exclude = [] } = {}) {
  const needle = query.trim().toLowerCase();
  return items.filter(item => (source === 'all' || item.serviceId === source) && !exclude.includes(item.serviceId)
    && (!unreadOnly || item.unread) && (!needle || `${item.chat} ${item.preview}`.toLowerCase().includes(needle)));
}

function noMessagingServices() {
  return empty('message-circle', 'No messaging apps', 'Add WhatsApp, Telegram or Mattermost to see all your conversations here in one place.',
    h('button.btn.sm', { on: { click: () => openAddService({ name: 'WhatsApp', url: 'https://web.whatsapp.com/' }) } }, icon('plus'), 'Add WhatsApp'));
}

function scrollToEnd(feed, force) {
  const nearEnd = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
  if (force || nearEnd) requestAnimationFrame(() => { feed.scrollTop = feed.scrollHeight; });
}

// ---------------------------------------------------------------------------
// Page

let pageBuilt = false;
function buildPage() {
  const page = $('#page-messages');
  page.classList.add('split');
  const search = h('input.search', { placeholder: 'Search chats', type: 'search', on: { input: event => { view.query = event.target.value; renderPage(); } } });
  const input = h('input#reply-input', { placeholder: 'Write a reply…', autocomplete: 'off', on: { keydown: event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); } } } });
  fill(page,
    h('aside.side-panel', h('div', h('h3', 'Sources'), h('div#message-sources')), h('div', h('h3', 'Filters'), h('label.check#unread-filter'))),
    h('div.chat-pane',
      h('div.chat-head', h('h2#chat-title', 'All chats'), search, h('button.icon-btn', { title: 'Refresh', on: { click: refreshMessages } }, icon('refresh-cw'))),
      h('div.feed#message-feed'),
      h('div.composer#composer', { hidden: true },
        h('span.target#reply-target'),
        input,
        h('button.icon-btn', { title: 'Open chat in the service', on: { click: () => view.selected && openConversation(view.selected) } }, icon('external-link')),
        h('button.btn.accent', { title: 'Send', on: { click: send } }, icon('send')))));
  const unreadToggle = h('input', { type: 'checkbox', on: { change: event => { view.unreadOnly = event.target.checked; renderPage(); } } });
  $('#unread-filter').append(unreadToggle, 'Unread only');
  pageBuilt = true;
}

async function send() {
  const input = $('#reply-input');
  const text = input.value.trim();
  const target = view.selected;
  if (!text || !target) return;
  input.disabled = true;
  const result = await api.sendMessage(target.serviceId, target, text).catch(error => ({ ok: false, message: error.message }));
  input.disabled = false;
  if (result?.ok) { input.value = ''; toast(`Sent to ${target.chat}`); setTimeout(refreshMessages, 1500); }
  else toast(result?.message || 'Couldn’t send message', { action: { label: 'Open chat', run: () => openConversation(target) } });
  input.focus();
}

function select(item) {
  view.selected = item;
  $('#composer').hidden = false;
  fill($('#reply-target'), icon('corner-up-left'), `${item.chat} · ${KIND_LABEL[item.kind] || item.service}`);
  renderPage({ keepScroll: true });
  $('#reply-input').focus();
}

export function renderPage({ keepScroll = false } = {}) {
  if (!pageBuilt) buildPage();
  const data = state.messages;
  const messaging = state.services.filter(service => service.group === 'message');
  const sources = $('#message-sources');
  const sourceButton = (id, label, count, dot = '') => h(`button.source${view.source === id ? '.on' : ''}`, { on: { click: () => { view.source = id; renderPage(); } } }, h(`i.state-dot${dot ? `.${dot}` : ''}`), h('span', label), count ? h('small', String(count)) : null);
  fill(sources, sourceButton('all', 'All', (data?.items || []).reduce((t, i) => t + (i.unread || 0), 0)),
    messaging.map(service => {
      const source = data?.sources.find(item => item.serviceId === service.id);
      const count = (data?.items || []).filter(item => item.serviceId === service.id).reduce((t, i) => t + (i.unread || 0), 0);
      return sourceButton(service.id, service.name, count, !source ? 'warn' : source.loggedOut ? 'off' : source.ok ? '' : 'warn');
    }));
  const feed = $('#message-feed');
  const title = view.source === 'all' ? 'All chats' : messaging.find(service => service.id === view.source)?.name || 'Chat';
  $('#chat-title').textContent = title;
  if (!messaging.length) return fill(feed, noMessagingServices());
  if (!data) return fill(feed, skeleton(6));
  const items = filtered(data.items, view);
  const loggedOut = data.sources.filter(source => source.loggedOut && (view.source === 'all' || view.source === source.serviceId));
  const previousBottom = feed.scrollHeight - feed.scrollTop;
  fill(feed,
    loggedOut.map(source => h('button.chip', { style: 'align-self:center', on: { click: () => { enterService(source.serviceId); api.activate(source.serviceId); } } }, icon('log-in'), `Sign in to ${source.service} to see its chats`)),
    items.length ? timeline(items, { onSelect: select, selectedId: view.selected?.id }) : empty('message-circle', view.query ? 'No results' : 'No conversations', view.query ? '' : 'Chats will appear once your services finish loading.'));
  if (keepScroll) feed.scrollTop = feed.scrollHeight - previousBottom;
  else scrollToEnd(feed, true);
}

// ---------------------------------------------------------------------------
// Widget

defineWidget({
  id: 'messages', title: 'Messages', icon: 'message-circle', size: 'm', topics: ['messages', 'services'],
  options: [
    { key: 'max', type: 'number', label: 'Chats to show', default: 12, min: 3, max: 40 },
    { key: 'unreadOnly', type: 'toggle', label: 'Unread only', default: false },
    { key: 'exclude', type: 'services', label: 'Included apps', default: [], filter: service => service.group === 'message' }
  ],
  actions: () => [h('button.link', { on: { click: () => emit('go', 'messages') } }, 'All', icon('arrow-right'))],
  render(ctx) {
    const { max, unreadOnly, exclude } = ctx.options;
    const messaging = state.services.filter(service => service.group === 'message' && !exclude.includes(service.id));
    if (!messaging.length) { ctx.setMeta(''); return fill(ctx.body, noMessagingServices()); }
    if (!state.messages) { ctx.setMeta('loading…'); return fill(ctx.body, skeleton(4)); }
    const items = filtered(state.messages.items, { unreadOnly, exclude }).slice(0, max);
    const unread = items.reduce((t, i) => t + (i.unread || 0), 0);
    ctx.setMeta(`${unread ? `${unread} unread` : 'none unread'} · ${messaging.map(service => service.name).join(', ')}`);
    fill(ctx.body, items.length ? h('div.feed-compact', timeline(items, { onSelect: item => { emit('go', 'messages'); setTimeout(() => select(item), 50); } })) : empty('message-circle', 'No conversations', 'Open each service once to sync it.'));
    scrollToEnd(ctx.body, true);
  }
});

export function initMessages() {
  on('messages', () => { if (state.route === 'messages') renderPage({ keepScroll: true }); });
  on('route', route => { if (route === 'messages') { renderPage(); refreshMessages(); } });
}
