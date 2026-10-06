import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexHomes, normalizeCodexLive, readCodexLive } from '../../lib/codex-live.js';

const FAKE = join(import.meta.dirname, '..', 'fixtures', 'fake-codex-app-server.mjs');
const fake = (home, env = {}) => readCodexLive({ home, command: process.execPath, args: [FAKE], env: { ...process.env, ...env }, timeoutMs: 5000, now: () => 1234 });

function homeWith(...folders) {
  const home = mkdtempSync(join(tmpdir(), 'nuvia-codex-'));
  for (const [name, signedIn] of folders) {
    mkdirSync(join(home, name), { recursive: true });
    if (signedIn) writeFileSync(join(home, name, 'auth.json'), '{}');
  }
  return home;
}

test('every signed-in Codex folder is one account, the default first', () => {
  const home = homeWith(['.codex', true], ['.codex-work', true], ['.codex-old', false], ['.codexignored', true], ['.config', true]);
  assert.deepEqual(codexHomes({ home }), [join(home, '.codex'), join(home, '.codex-work')]);
  // Without a home to scan (tests), only the given folder counts.
  assert.deepEqual(codexHomes({ primary: join(home, '.codex') }), [join(home, '.codex')]);
  assert.deepEqual(codexHomes({ home: homeWith(['.codex', false]) }), []);
});

test('live limits are read for each account separately', async () => {
  const home = homeWith(['.codex', true], ['.codex-work', true]);
  const [personal, work] = await Promise.all(codexHomes({ home }).map(dir => fake(dir)));
  assert.deepEqual(personal, {
    home: join(home, '.codex'), email: '.codex@example.test', plan: 'plus',
    session: { percent: 12, windowMinutes: 300, resetsAt: 2000000000000, stale: false },
    weekly: { percent: 40, windowMinutes: 10080, resetsAt: 2000500000000, stale: false },
    limitReached: false, updatedAt: 1234, live: true
  });
  assert.equal(work.email, '.codex-work@example.test');
  assert.equal(work.plan, 'pro');
  assert.equal(work.session.percent, 71);
});

test('a Codex that fails or hangs never blocks the dashboard', async () => {
  const home = homeWith(['.codex', true]);
  const dir = join(home, '.codex');
  assert.deepEqual(await fake(dir, { FAKE_CODEX_MODE: 'no-limits' }), { home: dir, error: 'not signed in', email: '.codex@example.test' });
  const started = Date.now();
  const silent = await readCodexLive({ home: dir, command: process.execPath, args: [FAKE], env: { ...process.env, FAKE_CODEX_MODE: 'silent' }, timeoutMs: 800 });
  assert.equal(silent.error, 'Codex did not answer in time');
  assert.ok(Date.now() - started < 3000);
  assert.deepEqual(await readCodexLive({ home: dir, command: null }), { home: dir, error: 'Codex CLI not found' });
  assert.equal((await readCodexLive({ home: dir, command: join(home, 'missing-codex') })).error.length > 0, true);
});

test('app-server answers are normalised', () => {
  const value = normalizeCodexLive({ account: { email: 'a@b.c' } }, { rateLimitsByLimitId: { codex: { primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 10 }, rateLimitReachedType: 'primary' } } }, { home: '/h', now: 1 });
  assert.equal(value.session.percent, 5);
  assert.equal(value.session.resetsAt, 10000);
  assert.equal(value.weekly, null);
  assert.equal(value.limitReached, true);
});
