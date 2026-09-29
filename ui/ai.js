// Claude & Codex: plan limits, reset times and token usage.
import { api, state, $, h, icon, fill, emit, on, empty, skeleton, countdown, tokens, clock, relativeTime, dayLabel } from './core.js';
import { defineWidget } from './home.js';
import { openService } from './router.js';
import { openAddService } from './services.js';

let busy = false;
export async function refreshUsage(force = false) {
  if (busy) return;
  busy = true;
  try { state.usage = await api.aiUsage({ force }); emit('usage'); } catch (error) { console.error(error); } finally { busy = false; }
}

function resetText(at) {
  if (!at) return '';
  const when = new Date(at);
  const day = dayLabel(at);
  return `resets in ${countdown(at - Date.now())} · ${day === 'Today' ? '' : `${day === 'Tomorrow' ? 'tomorrow' : day} `}at ${clock(when)}`;
}

function meter(label, percent, sub) {
  const value = Math.max(0, Math.min(100, Math.round(percent ?? 0)));
  return h('div.meter',
    h('div.meter-top', h('strong', label), h('span.pct', `${value}%`)),
    h('div.meter-bar', h(`i${value >= 90 ? '.bad' : value >= 70 ? '.warn' : ''}`, { style: `width:${value}%` })),
    sub ? h('small', sub) : null);
}

function stat(label, value) { return h('div.stat', h('small', label), h('b', value)); }

function claudeMeters(claude) {
  const web = claude.web || {};
  const rows = [];
  if (web.session) rows.push(meter('Session · 5 hours', web.session.percent, resetText(web.session.resetsAt)));
  if (web.weekly) rows.push(meter('Week · all models', web.weekly.percent, resetText(web.weekly.resetsAt)));
  if (web.weeklyOpus) rows.push(meter('Week · Opus', web.weeklyOpus.percent, resetText(web.weeklyOpus.resetsAt)));
  if (web.weeklySonnet) rows.push(meter('Week · Sonnet', web.weeklySonnet.percent, resetText(web.weeklySonnet.resetsAt)));
  if (!rows.length && claude.block) {
    rows.push(h('div.meter', h('div.meter-top', h('strong', '5-hour window'), h('span.pct', tokens(claude.block.tokens))),
      h('small', `started at ${clock(claude.block.start)} · ${resetText(claude.block.resetsAt)}`)));
  }
  return rows;
}

function claudeNote(claude) {
  const web = claude.web || {};
  if (web.session || web.weekly) return `Limits read from claude.ai ${relativeTime(web.updatedAt)}.`;
  if (web.missing) return 'Add Claude as a service (claude.ai) to see plan percentages.';
  if (web.loggedOut) return 'Sign in to claude.ai in the Claude service to see plan percentages.';
  return 'Plan percentages aren’t available right now. Token counts come from local Claude Code logs.';
}

function codexMeters(codex) {
  const rows = [];
  if (codex.session) rows.push(meter(`Session · ${Math.round((codex.session.windowMinutes || 300) / 60)} hours`, codex.session.percent, codex.session.resetsAt ? resetText(codex.session.resetsAt) : 'window expired, limit reset'));
  if (codex.weekly) rows.push(meter('Week', codex.weekly.percent, codex.weekly.resetsAt ? resetText(codex.weekly.resetsAt) : 'reset'));
  return rows;
}

function planOf(kind, data) { return String((kind === 'claude' ? data?.web?.plan : data?.plan) || '').replace(/^default_/, '').replace(/_/g, ' '); }

function column(kind, data, { compact = false, headless = false } = {}) {
  const isClaude = kind === 'claude';
  const title = isClaude ? 'Claude' : 'Codex';
  if (!data?.available && !(isClaude && (data?.web?.session || data?.web?.weekly))) {
    return h('div.ai-col', h('h4', icon(isClaude ? 'asterisk' : 'square-terminal'), title),
      empty(isClaude ? 'asterisk' : 'square-terminal', `No ${title} activity`, isClaude ? 'No recent logs in ~/.claude.' : 'No recent logs in ~/.codex.'));
  }
  const meters = isClaude ? claudeMeters(data) : codexMeters(data);
  const plan = planOf(kind, data);
  const children = [
    headless ? null : h('h4', icon(isClaude ? 'asterisk' : 'square-terminal'), title, plan ? h('span.tag', plan) : null),
    meters.length ? meters : h('p.muted', 'No recent limits recorded.'),
    h('div.stats', stat('5 hours', tokens(data.tokens?.fiveHours)), stat('Today', tokens(data.tokens?.today)), stat('7 days', tokens(data.tokens?.week)))
  ];
  if (!compact) {
    children.push(h('p.note', isClaude ? claudeNote(data) : `Limits updated ${relativeTime(data.updatedAt)} from the last Codex session${data.model ? ` · model ${data.model}` : ''}. Token counts include cached reads.`));
    if (isClaude && data.models?.length) children.push(h('div.model-list', h('h3', { style: 'margin:0 0 4px;font-size:12px;color:var(--text-3)' }, 'Tokens by model · 7 days'), data.models.slice(0, 5).map(model => h('div', h('span', model.name), h('b', tokens(model.tokens))))));
    if (!isClaude && data.tokens) children.push(h('div.model-list', h('div', h('span', 'Input (cached)'), h('b', `${tokens(data.tokens.input)} (${tokens(data.tokens.cached)})`)), h('div', h('span', 'Output'), h('b', tokens(data.tokens.output)))));
  }
  return h('div.ai-col', children);
}

function openAi(kind) {
  const serviceId = state.usage?.[kind]?.serviceId;
  if (serviceId) openService(serviceId);
  else openAddService(kind === 'claude' ? { name: 'Claude', url: 'https://claude.ai/new' } : { name: 'Codex', url: 'https://chatgpt.com/codex' });
}

defineWidget({
  id: 'ai', title: 'Claude & Codex', icon: 'gauge', size: 'm', topics: ['usage'],
  actions: () => [h('button.icon-btn.small', { title: 'Refresh', on: { click: () => refreshUsage(true) } }, icon('refresh-cw')), h('button.link', { on: { click: () => emit('go', 'ai') } }, 'Details', icon('arrow-right'))],
  render(ctx) {
    const usage = state.usage;
    if (!usage) { ctx.setMeta('reading logs…'); return fill(ctx.body, skeleton(3)); }
    const soonest = [usage.claude?.web?.session?.resetsAt, usage.claude?.block?.resetsAt, usage.codex?.session?.resetsAt].filter(Boolean).sort()[0];
    ctx.setMeta(soonest ? `next reset in ${countdown(soonest - Date.now())}` : 'limits and tokens');
    fill(ctx.body, h('div.ai-grid', column('claude', usage.claude, { compact: true }), column('codex', usage.codex, { compact: true })));
  }
});

export function renderPage() {
  const page = $('#page-ai');
  page.classList.add('ai-page');
  const usage = state.usage;
  const head = h('div.page-head', h('h2', 'Claude ', h('em', '&'), ' Codex'), h('div.actions', h('button.btn.sm', { on: { click: () => refreshUsage(true) } }, icon('refresh-cw'), 'Refresh')));
  if (!usage) return fill(page, head, skeleton(4));
  const card = kind => h('div.card',
    h('div.ai-head', h('span.w-icon', icon(kind === 'claude' ? 'asterisk' : 'square-terminal')), h('h3', kind === 'claude' ? 'Claude' : 'Codex'), planOf(kind, usage[kind]) ? h('span.tag', planOf(kind, usage[kind])) : null,
      h('div.actions', h('button.btn.sm', { on: { click: () => openAi(kind) } }, icon('external-link'), state.usage?.[kind]?.serviceId ? 'Open' : 'Add service'))),
    column(kind, usage[kind], { headless: true }));
  fill(page, head, h('div.ai-grid', card('claude'), card('codex')),
    h('p.note', `Updated at ${clock(usage.at)}. Your data stays on this computer. Nuvia reads local session logs and, if you add Claude as a service, your account’s usage page.`));
}

export function initAi() {
  on('usage', () => { if (state.route === 'ai') renderPage(); });
  on('route', route => { if (route === 'ai') { renderPage(); refreshUsage(); } });
}
