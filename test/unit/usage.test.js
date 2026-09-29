import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexUsage, claudeUsage, claudeBlocks, normalizeClaudeLimits } from '../../lib/usage.js';

const now = Date.parse('2026-09-29T14:00:00Z');
const iso = offsetMinutes => new Date(now + offsetMinutes * 60000).toISOString();

test('codexUsage reads limits and tokens from rollouts', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-'));
  const dir = join(root, 'sessions', '2026', '09', '29'); mkdirSync(dir, { recursive: true });
  const line = (offset, total, rate) => JSON.stringify({ timestamp: iso(offset), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: total, input_tokens: total - 10, cached_input_tokens: 5, output_tokens: 10 } }, rate_limits: rate } });
  writeFileSync(join(dir, 'rollout-a.jsonl'), [
    JSON.stringify({ timestamp: iso(-30), type: 'turn_context', payload: { model: 'gpt-test' } }),
    line(-400, 1000, { plan_type: 'plus', primary: null, secondary: null }),
    line(-60, 500, { plan_type: 'plus', primary: { used_percent: 40, window_minutes: 300, resets_at: Math.floor((now + 3600000) / 1000) }, secondary: { used_percent: 10, window_minutes: 10080, resets_at: Math.floor((now + 86400000) / 1000) } }),
    line(-10, 250, { plan_type: 'plus', primary: null, secondary: null }),
    'not json'
  ].join('\n'));
  const usage = codexUsage({ root, now });
  assert.equal(usage.plan, 'plus');
  assert.equal(usage.model, 'gpt-test');
  assert.equal(usage.session.percent, 40);
  assert.equal(usage.session.resetsAt, now + 3600000);
  assert.equal(usage.weekly.percent, 10);
  assert.equal(usage.tokens.fiveHours, 750);
  assert.equal(usage.tokens.week, 1750);
  const later = codexUsage({ root, now: now + 2 * 3600000 });
  assert.equal(later.session.percent, 0);
  assert.equal(later.session.stale, true);
  rmSync(root, { recursive: true, force: true });
});

test('claudeUsage dedupes messages and rebuilds the 5-hour window', () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-'));
  const dir = join(root, 'projects', 'p'); mkdirSync(dir, { recursive: true });
  const message = (offset, id, tokens, model = 'claude-opus-5-5') => JSON.stringify({ timestamp: iso(offset), requestId: `r${id}`, message: { id: `m${id}`, model, usage: { input_tokens: tokens, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  writeFileSync(join(dir, 's.jsonl'), [message(-420, 1, 90), message(-100, 2, 90), message(-100, 2, 90), message(-50, 3, 190, 'claude-haiku-4-5'), JSON.stringify({ timestamp: iso(-5), message: { model: '<synthetic>', usage: { input_tokens: 1 } } })].join('\n'));
  const usage = claudeUsage({ root, now });
  assert.equal(usage.tokens.fiveHours, 300);
  assert.equal(usage.tokens.week, 400);
  assert.equal(usage.block.tokens, 300);
  assert.equal(usage.block.messages, 2);
  assert.equal(usage.block.start, Date.parse('2026-09-29T12:00:00Z'));
  assert.equal(usage.block.resetsAt, Date.parse('2026-09-29T17:00:00Z'));
  assert.equal(usage.models[0].name, 'claude-opus-5-5');
  rmSync(root, { recursive: true, force: true });
});

test('claudeBlocks starts a new block after 5 hours', () => {
  const { blocks, active } = claudeBlocks([{ at: now - 7 * 3600000, tokens: 1 }, { at: now - 6 * 3600000, tokens: 1 }, { at: now - 60000, tokens: 5 }], now);
  assert.equal(blocks.length, 2);
  assert.equal(active.tokens, 5);
});

test('normalizeClaudeLimits', () => {
  const limits = normalizeClaudeLimits({ five_hour: { utilization: 41.6, resets_at: '2026-09-29T17:00:00Z' }, seven_day: { utilization: 12, resets_at: null }, seven_day_opus: null });
  assert.deepEqual(limits.session, { percent: 42, resetsAt: Date.parse('2026-09-29T17:00:00Z') });
  assert.deepEqual(limits.weekly, { percent: 12, resetsAt: null });
  assert.equal(limits.weeklyOpus, null);
  assert.equal(normalizeClaudeLimits(null), null);
});

test('missing logs do not throw', () => {
  assert.equal(codexUsage({ root: '/percorso/inesistente', now }).available, false);
  assert.equal(claudeUsage({ root: '/percorso/inesistente', now }).available, false);
});
