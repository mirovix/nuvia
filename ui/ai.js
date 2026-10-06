// Claude & Codex: plan limits, reset times and token usage.
import { api, state, $, h, icon, fill, emit, on, empty, skeleton, countdown, tokens, clock, relativeTime, dayLabel, toast } from './core.js';
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

// Codex counts what is left ("62% left"), so its bars do too: same number as in Codex.
function leftMeter(label, used, sub) {
  const left = Math.max(0, Math.min(100, 100 - Math.round(used ?? 0)));
  return h('div.meter.left',
    h('div.meter-top', h('strong', label), h('span.pct', `${left}% left`)),
    h('div.meter-bar', h(`i${left <= 10 ? '.bad' : left <= 30 ? '.warn' : ''}`, { style: `width:${left}%` })),
    sub ? h('small', sub) : null);
}

// 300 → "5 hours", 10080 → "Week", 43200 → "Month".
function windowName(minutes, fallback) {
  const m = Number(minutes) || fallback;
  if (m <= 24 * 60) return `${Math.round(m / 60)} hours`;
  if (Math.abs(m - 7 * 1440) < 1440) return 'Week';
  if (Math.abs(m - 30 * 1440) < 3 * 1440) return 'Month';
  return `${Math.round(m / 1440)} days`;
}

function stat(label, value) { return h('div.stat', h('small', label), h('b', value)); }

function claudeMeters(claude) {
  const web = claude.web || {};
  const rows = [];
  const when = window => (window.stale ? 'window has since reset' : resetText(window.resetsAt));
  if (web.session) rows.push(meter('Session · 5 hours', web.session.percent, when(web.session)));
  if (web.weekly) rows.push(meter('Week · all models', web.weekly.percent, when(web.weekly)));
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
  if (web.source === 'claude-code') return `Limits from Claude Code, ${relativeTime(web.updatedAt)}: they refresh while Claude Code runs (terminal or VS Code).${web.webError ? ' claude.ai didn’t return them.' : ''}`;
  if (web.session || web.weekly) return `Limits read from claude.ai ${relativeTime(web.updatedAt)}.`;
  if (web.missing) return 'Add Claude as a service (claude.ai), or let Claude Code report its limits, to see plan percentages.';
  if (web.loggedOut) return 'Sign in to claude.ai in the Claude service, or let Claude Code report its limits, to see plan percentages.';
  return `claude.ai didn’t return your limits${web.error ? ` (${web.error})` : ''}. Claude Code can report them instead.`;
}

async function installStatusLine(button) {
  button.disabled = true;
  const result = await api.installClaudeStatusLine();
  if (result?.error) { toast(result.error); button.disabled = false; return; }
  toast('Done. Claude Code’s limits appear here after its next reply.');
  refreshUsage(true);
}

// Offered when there are no plan percentages: Claude Code knows its limits and
// hands them to a status line command, which Nuvia can provide.
function claudeStatusLineOffer(claude) {
  const line = claude.statusLine;
  const web = claude.web || {};
  if (!line || line.installed || web.session || web.weekly) return null;
  if (line.otherStatusLine) return h('p.note', 'Claude Code already has a status line of its own, so Nuvia can’t read its limits from there.');
  const button = h('button.btn.sm.accent', { type: 'button', on: { click: () => installStatusLine(button) } }, icon('gauge'), 'Show limits from Claude Code');
  return h('div.ai-offer', h('p.note', `Adds a status line to Claude Code (${line.settingsFile}) that shows “5h 23% · 7d 41%” in your terminal and shares those numbers with Nuvia. A backup of the file is kept.`), button);
}

function codexWindowMeters(limits, measured) {
  const rows = [];
  const sub = text => [text, measured].filter(Boolean).join(' · ');
  for (const [window, fallback] of [[limits.session, 300], [limits.weekly, 10080]]) {
    if (!window) continue;
    const name = windowName(window.windowMinutes, fallback);
    const label = name.endsWith('hours') ? `Session · ${name}` : name;
    rows.push(window.stale ? leftMeter(label, 0, sub('window has since reset')) : leftMeter(label, window.percent, sub(window.resetsAt ? resetText(window.resetsAt) : 'reset')));
  }
  return rows;
}

function codexMeters(codex) {
  const accounts = (codex.accounts || []).filter(account => account.live);
  // One block of bars per signed-in account (each ~/.codex* folder), read live.
  if (accounts.length > 1) {
    return accounts.map(account => h('div.ai-account',
      h('div.ai-account-head', h('strong', account.email || account.home.split(/[\\/]/).pop()), account.plan ? h('span.tag', account.plan) : null),
      codexWindowMeters(account, '')));
  }
  if (accounts.length === 1) return codexWindowMeters(accounts[0], '');
  // No live answer: the logs only hold what Codex saw during its last run, so
  // say when that was instead of showing old numbers as current.
  return codexWindowMeters(codex, codex.updatedAt ? `measured ${relativeTime(codex.updatedAt)}` : '');
}

function codexNote(codex) {
  const model = codex.model ? ` · last model ${codex.model}` : '';
  const failed = (codex.accounts || []).find(account => account.error);
  const live = (codex.accounts || []).filter(account => account.live);
  if (live.length) return `Limits read live from your Codex account${live.length > 1 ? 's' : ''} ${relativeTime(Math.max(...live.map(account => account.updatedAt)))}${model}. Another account: sign in once with CODEX_HOME=~/.codex-work codex login.`;
  if (failed) return `Codex didn’t answer (${failed.error}), so these limits come from the last Codex session, ${relativeTime(codex.updatedAt)}${model}.`;
  return `Limits come from the last Codex session, ${relativeTime(codex.updatedAt)}${model}. Token counts include cached reads.`;
}

function planOf(kind, data) { return String((kind === 'claude' ? data?.web?.plan : data?.plan) || '').replace(/^default_/, '').replace(/_/g, ' '); }

function column(kind, data, { compact = false, headless = false } = {}) {
  const isClaude = kind === 'claude';
  const title = isClaude ? 'Claude' : 'Codex';
  const hasLive = isClaude ? Boolean(data?.web?.session || data?.web?.weekly) : (data?.accounts || []).some(account => account.live);
  if (!data?.available && !hasLive) {
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
    children.push(h('p.note', isClaude ? claudeNote(data) : codexNote(data)));
    if (isClaude) children.push(claudeStatusLineOffer(data));
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
    const soonest = [usage.claude?.web?.session?.resetsAt, usage.claude?.block?.resetsAt, usage.codex?.session?.resetsAt].filter(Boolean).sort((a, b) => a - b)[0];
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
