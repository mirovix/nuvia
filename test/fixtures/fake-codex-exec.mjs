#!/usr/bin/env node
// Stands in for `codex exec --json … -` in tests: reads the prompt on stdin and
// answers with Codex's JSON events. FAKE_CODEX_LOG gets { home, argv, prompt };
// accounts listed in FAKE_CODEX_LIMITED (folder names) are at their usage limit.
import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';

const home = basename(process.env.CODEX_HOME || '');
const out = value => process.stdout.write(`${JSON.stringify(value)}\n`);
let prompt = '';
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  if (process.env.FAKE_CODEX_LOG) appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify({ home, argv: process.argv.slice(2), prompt })}\n`);
  out({ type: 'thread.started', thread_id: 'fake' });
  out({ type: 'turn.started' });
  if (String(process.env.FAKE_CODEX_LIMITED || '').split(',').includes(home)) {
    const message = 'You’ve hit your usage limit. Try again at 3:57 PM.';
    out({ type: 'error', message });
    out({ type: 'turn.failed', error: { message } });
    process.exit(1);
  }
  const text = /What is this\?/.test(prompt) ? `**Fotosintesi** (ChatGPT, ${home})` : `Risposta ${prompt.split('[User]').length - 1} da ${home}`;
  out({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } });
  out({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
});
