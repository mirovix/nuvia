#!/usr/bin/env node
// Stands in for `codex app-server` in test/unit/codex-live.test.js: answers the
// JSON-RPC calls Nuvia makes, with an account named after CODEX_HOME.
import { basename } from 'node:path';
const who = basename(process.env.CODEX_HOME || 'codex');
const mode = process.env.FAKE_CODEX_MODE || 'ok';
let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    const message = JSON.parse(line);
    if (message.id == null) continue;
    const reply = result => process.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
    if (mode === 'silent') continue;
    if (message.method === 'initialize') reply({ userAgent: 'fake' });
    else if (message.method === 'account/read') reply({ account: { type: 'chatgpt', email: `${who}@example.test`, planType: 'plus' } });
    else if (message.method === 'account/rateLimits/read') {
      if (mode === 'no-limits') process.stdout.write(`${JSON.stringify({ id: message.id, error: { code: -1, message: 'not signed in' } })}\n`);
      else reply({ rateLimits: { limitId: 'codex', primary: { usedPercent: who.endsWith('work') ? 71 : 12, windowDurationMins: 300, resetsAt: 2000000000 }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 2000500000 }, planType: who.endsWith('work') ? 'pro' : 'plus', rateLimitReachedType: null } });
    }
  }
});
