#!/usr/bin/env node
// Stands in for the Claude Code CLI in tests: speaks the stream-json protocol of
// `claude -p --input-format stream-json --output-format stream-json`.
// FAKE_CLAUDE_LOG: file that gets the arguments and every message received.
// FAKE_CLAUDE_FAIL=auth: every answer fails as when Claude Code is signed out.
// With the web tools on, "What is this?" first says it searches, then searches.
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const record = value => { if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify(value)}\n`); };
const out = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const argv = process.argv.slice(2);
const file = argv[argv.indexOf('--system-prompt-file') + 1];
record({ argv, cwd: process.cwd(), system: argv.includes('--system-prompt-file') ? readFileSync(file, 'utf8') : null });
out({ type: 'system', subtype: 'init', session_id: 'fake' });

function answer(text) {
  if (/What is this\?/.test(text)) return 'La **fotosintesi** è il processo con cui le piante trasformano la luce in energia.';
  if (/Help me reply to this chat/.test(text)) return 'Ecco una risposta:\n<reply>Sì, vengo a cena e porto il pane!</reply>';
  if (/Help me reply/.test(text)) return 'Anna chiede di confermare la riunione.\n\n1. Giovedì alle 10 ti va bene?\n2. Vuoi aggiungere qualcosa alle note?';
  return 'Ecco la risposta:\n<reply>Ciao Anna,\n\ngrazie per le note: giovedì alle 10 va benissimo.\n\nMiro</reply>\nPosso accorciarla se vuoi.';
}

createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  const text = message.message.content.map(part => part.text).join('');
  record({ user: text });
  if (process.env.FAKE_CLAUDE_FAIL === 'auth') return out({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' });
  const reply = answer(text);
  if (/What is this\?/.test(text) && argv[argv.indexOf('--tools') + 1] === 'WebSearch,WebFetch') {
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Cerco sul web.' } } });
    out({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', name: 'WebSearch', input: {} } } });
  }
  for (const piece of reply.match(/[\s\S]{1,12}/g)) out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } } });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: reply });
});
