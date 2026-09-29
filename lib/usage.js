// Token usage and rate limits read from local session logs.
// Codex writes rate limits into ~/.codex/sessions/**/rollout-*.jsonl.
// Claude Code writes per-message usage into ~/.claude/projects/**/*.jsonl; the
// 5-hour window is reconstructed the same way the Claude plans count it.

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const HOUR = 3600000;
const DAY = 24 * HOUR;

function walk(dir, predicate, since, out = []) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, predicate, since, out);
    else if (predicate(entry.name)) {
      try { if (statSync(path).mtimeMs >= since) out.push(path); } catch {}
    }
  }
  return out;
}

const parsedFiles = new Map();

// Re-parse a log only when it changed since the last scan.
function cachedParse(file, parse) {
  let stat; try { stat = statSync(file); } catch { return []; }
  const cached = parsedFiles.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && cached.parse === parse) return cached.value;
  let text = ''; try { text = readFileSync(file, 'utf8'); } catch {}
  const value = parse(text.split('\n'));
  parsedFiles.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, parse, value });
  return value;
}

function windowTotals(entries, now) {
  const sum = from => entries.filter(entry => entry.at >= from && entry.at <= now).reduce((total, entry) => total + entry.tokens, 0);
  const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
  return { fiveHours: sum(now - 5 * HOUR), today: sum(startOfDay.getTime()), week: sum(now - 7 * DAY) };
}

function parseCodexLines(rows) {
  const result = { entries: [], limits: null, limitsAt: 0, plan: null, model: null, modelAt: 0 };
  for (const line of rows) {
    if (!line.includes('"token_count"') && !line.includes('"turn_context"')) continue;
    let record; try { record = JSON.parse(line); } catch { continue; }
    const at = Date.parse(record.timestamp);
    if (record.type === 'turn_context' && record.payload?.model) { if (at >= result.modelAt) { result.model = record.payload.model; result.modelAt = at; } continue; }
    const payload = record.payload;
    if (payload?.type !== 'token_count') continue;
    const last = payload.info?.last_token_usage;
    if (last && Number.isFinite(at)) result.entries.push({ at, tokens: Number(last.total_tokens || 0), input: Number(last.input_tokens || 0), cached: Number(last.cached_input_tokens || 0), output: Number(last.output_tokens || 0) });
    const rate = payload.rate_limits;
    if (rate?.plan_type) result.plan = rate.plan_type;
    if ((rate?.primary || rate?.secondary) && at >= result.limitsAt) { result.limits = rate; result.limitsAt = at; }
  }
  return result;
}

export function codexUsage({ root, now = Date.now() } = {}) {
  const files = walk(join(root, 'sessions'), name => name.startsWith('rollout-') && name.endsWith('.jsonl'), now - 8 * DAY);
  const entries = []; let limits = null; let limitsAt = 0; let plan = null; let model = null; let modelAt = 0;
  for (const file of files) {
    const parsed = cachedParse(file, parseCodexLines);
    entries.push(...parsed.entries);
    if (parsed.plan) plan = parsed.plan;
    if (parsed.model && parsed.modelAt >= modelAt) { model = parsed.model; modelAt = parsed.modelAt; }
    if (parsed.limits && parsed.limitsAt >= limitsAt) { limits = parsed.limits; limitsAt = parsed.limitsAt; }
  }
  const describe = (window, fallbackMinutes) => {
    if (!window) return null;
    const resetsAt = window.resets_at ? window.resets_at * 1000 : (window.resets_in_seconds ? limitsAt + window.resets_in_seconds * 1000 : null);
    const expired = resetsAt && resetsAt <= now;
    return { percent: expired ? 0 : Number(window.used_percent || 0), windowMinutes: window.window_minutes || fallbackMinutes, resetsAt: expired ? null : resetsAt, stale: Boolean(expired) };
  };
  const totals = windowTotals(entries, now);
  const recent = entries.filter(entry => entry.at >= now - 7 * DAY);
  return {
    available: files.length > 0,
    plan,
    model,
    updatedAt: limitsAt || null,
    session: describe(limits?.primary, 300),
    weekly: describe(limits?.secondary, 10080),
    tokens: { ...totals, input: recent.reduce((t, e) => t + e.input, 0), cached: recent.reduce((t, e) => t + e.cached, 0), output: recent.reduce((t, e) => t + e.output, 0) }
  };
}

export function claudeBlocks(entries, now = Date.now()) {
  const sorted = [...entries].sort((a, b) => a.at - b.at);
  const blocks = [];
  for (const entry of sorted) {
    const current = blocks.at(-1);
    if (!current || entry.at >= current.end) {
      const start = new Date(entry.at); start.setMinutes(0, 0, 0);
      blocks.push({ start: start.getTime(), end: start.getTime() + 5 * HOUR, tokens: 0, messages: 0 });
    }
    const block = blocks.at(-1);
    block.tokens += entry.tokens; block.messages += 1;
  }
  const active = blocks.find(block => block.start <= now && now < block.end) || null;
  return { blocks, active };
}

function parseClaudeLines(rows) {
  const entries = [];
  for (const line of rows) {
    if (!line.includes('"usage"')) continue;
    let record; try { record = JSON.parse(line); } catch { continue; }
    const usage = record.message?.usage; const at = Date.parse(record.timestamp);
    const model = record.message?.model || 'sconosciuto';
    if (!usage || !Number.isFinite(at) || model === '<synthetic>') continue;
    const tokens = Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0) + Number(usage.cache_creation_input_tokens || 0) + Number(usage.cache_read_input_tokens || 0);
    // Streaming writes the same message once per content block: key lets callers dedupe.
    entries.push({ at, tokens, output: Number(usage.output_tokens || 0), model, key: `${record.message.id || ''}:${record.requestId || ''}` });
  }
  return entries;
}

export function claudeUsage({ root, now = Date.now() } = {}) {
  const files = walk(join(root, 'projects'), name => name.endsWith('.jsonl'), now - 8 * DAY);
  const seen = new Set(); const entries = []; const models = new Map();
  for (const file of files) {
    for (const entry of cachedParse(file, parseClaudeLines)) {
      if (entry.at < now - 8 * DAY) continue;
      if (entry.key !== ':' && seen.has(entry.key)) continue;
      seen.add(entry.key);
      entries.push(entry);
      if (entry.at >= now - 7 * DAY) models.set(entry.model, (models.get(entry.model) || 0) + entry.tokens);
    }
  }
  const { active } = claudeBlocks(entries, now);
  const last = entries.reduce((latest, entry) => (entry.at > (latest?.at || 0) ? entry : latest), null);
  return {
    available: files.length > 0,
    model: last?.model || null,
    lastActivity: last?.at || null,
    block: active ? { start: active.start, resetsAt: active.end, tokens: active.tokens, messages: active.messages } : null,
    tokens: { ...windowTotals(entries, now), output: entries.filter(entry => entry.at >= now - 7 * DAY).reduce((t, e) => t + e.output, 0) },
    models: [...models.entries()].sort((a, b) => b[1] - a[1]).map(([name, tokens]) => ({ name, tokens }))
  };
}

// claude.ai /api/organizations/{id}/usage -> normalized windows.
export function normalizeClaudeLimits(json) {
  if (!json || typeof json !== 'object') return null;
  const read = value => value && typeof value.utilization === 'number' ? { percent: Math.round(value.utilization), resetsAt: value.resets_at ? Date.parse(value.resets_at) : null } : null;
  return {
    session: read(json.five_hour),
    weekly: read(json.seven_day),
    weeklyOpus: read(json.seven_day_opus),
    weeklySonnet: read(json.seven_day_sonnet)
  };
}
