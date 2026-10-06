import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaudeCodeLimits } from '../../lib/usage.js';
import { claudeStatusLineScript, withNuviaStatusLine } from '../../lib/claude-statusline.js';

const NOW = Date.parse('2026-10-06T10:00:00Z');
const payload = (fiveResets, weekResets) => ({ model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' }, rate_limits: { five_hour: { used_percentage: 23.4, resets_at: fiveResets }, seven_day: { used_percentage: 41, resets_at: weekResets } } });

test('Claude Code limits are read in seconds, milliseconds or ISO time', () => {
  const inAnHour = NOW + 3600000;
  for (const resets of [inAnHour / 1000, inAnHour, new Date(inAnHour).toISOString()]) {
    const value = readClaudeCodeLimits(JSON.stringify({ at: NOW - 60000, ...payload(resets, NOW / 1000 + 86400) }), NOW);
    assert.deepEqual(value.session, { percent: 23, resetsAt: inAnHour, stale: false });
    assert.equal(value.weekly.percent, 41);
    assert.equal(value.updatedAt, NOW - 60000);
    assert.equal(value.source, 'claude-code');
  }
});

test('a window that has reset since Claude Code last ran shows nothing used', () => {
  const value = readClaudeCodeLimits(JSON.stringify(payload(NOW / 1000 - 60, NOW / 1000 + 86400)), NOW);
  assert.deepEqual(value.session, { percent: 0, resetsAt: null, stale: true });
  assert.equal(value.weekly.stale, false);
});

test('missing or broken files give no limits', () => {
  assert.equal(readClaudeCodeLimits('not json', NOW), null);
  assert.equal(readClaudeCodeLimits('{}', NOW), null);
  assert.equal(readClaudeCodeLimits(JSON.stringify({ rate_limits: { five_hour: {} } }), NOW), null);
});

test('the status line script saves the limits and prints a short line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nuvia-statusline-'));
  const script = join(dir, 'claude-statusline.cjs');
  const limits = join(dir, 'claude-limits.json');
  writeFileSync(script, claudeStatusLineScript(limits));
  const run = spawnSync(process.execPath, [script], { input: JSON.stringify(payload(NOW / 1000 + 3600, NOW / 1000 + 86400)), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, 'Opus 5.5 · 5h 23% · 7d 41%');
  const saved = JSON.parse(readFileSync(limits, 'utf8'));
  assert.equal(saved.rate_limits.five_hour.used_percentage, 23.4);
  assert.equal(readClaudeCodeLimits(readFileSync(limits, 'utf8'), NOW).session.percent, 23);
  // Without limits in the payload (API key users) it still prints and keeps the old file.
  const plain = spawnSync(process.execPath, [script], { input: JSON.stringify({ model: { display_name: 'Opus 5.5' } }), encoding: 'utf8' });
  assert.equal(plain.stdout, 'Opus 5.5');
  assert.equal(JSON.parse(readFileSync(limits, 'utf8')).rate_limits.seven_day.used_percentage, 41);
});

test('Nuvia adds its status line but never replaces the user’s own', () => {
  const settings = { hooks: { Stop: [] }, model: 'opus' };
  const next = withNuviaStatusLine(settings, '/p/claude-statusline.cjs');
  assert.deepEqual(next, { hooks: { Stop: [] }, model: 'opus', statusLine: { type: 'command', command: 'node "/p/claude-statusline.cjs"', padding: 0 } });
  assert.deepEqual(withNuviaStatusLine(next, '/p/claude-statusline.cjs'), next, 'installing twice changes nothing');
  assert.equal(withNuviaStatusLine({ statusLine: { type: 'command', command: '~/my-line.sh' } }, '/p/claude-statusline.cjs'), null);
});

test('claude.ai usage: old fields, and windows listed only in `limits`', async () => {
  const { normalizeClaudeLimits } = await import('../../lib/usage.js');
  const later = new Date(NOW + 3600000).toISOString();
  const nextWeek = new Date(NOW + 5 * 86400000).toISOString();
  assert.deepEqual(normalizeClaudeLimits({ five_hour: { utilization: 42, resets_at: later }, seven_day: { utilization: 17, resets_at: nextWeek } }, NOW).weekly, { percent: 17, resetsAt: Date.parse(nextWeek), stale: false });
  // The shape seen in October 2026: seven_day is null, the session also sits in `limits`.
  const listed = normalizeClaudeLimits({
    five_hour: { utilization: 19, resets_at: later }, seven_day: null, seven_day_opus: null,
    limits: [
      { kind: 'session', group: 'session', percent: 19, resets_at: later, is_active: true },
      { kind: 'weekly_all', group: 'weekly', percent: 61, resets_at: nextWeek, is_active: true },
      { kind: 'weekly_opus', group: 'weekly', percent: 80, resets_at: nextWeek, is_active: false }
    ]
  }, NOW);
  assert.equal(listed.session.percent, 19);
  assert.equal(listed.weekly.percent, 61);
  assert.equal(listed.weeklyOpus, null, 'inactive limits are skipped');
});

test('Claude Code’s cached usage in ~/.claude.json is read, nothing else', async () => {
  const { readClaudeCodeCache } = await import('../../lib/usage.js');
  const later = new Date(NOW + 3600000).toISOString();
  const file = { oauthAccount: { emailAddress: 'x@y.z' }, projects: {}, cachedUsageUtilization: { fetchedAtMs: NOW - 8 * 60000, accountUuid: 'a', utilization: { five_hour: { utilization: 19, resets_at: later, limit_dollars: null }, seven_day: null, limits: [{ kind: 'session', group: 'session', percent: 19, resets_at: later, is_active: true }] } } };
  assert.deepEqual(readClaudeCodeCache(JSON.stringify(file), NOW), { session: { percent: 19, resetsAt: Date.parse(later), stale: false }, weekly: null, weeklyOpus: null, weeklySonnet: null, updatedAt: NOW - 8 * 60000, source: 'claude-code' });
  assert.equal(readClaudeCodeCache(JSON.stringify({ projects: {} }), NOW), null);
  assert.equal(readClaudeCodeCache('{', NOW), null);
});
