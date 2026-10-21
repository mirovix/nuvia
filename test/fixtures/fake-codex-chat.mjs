#!/usr/bin/env node
// Stands in for the Codex CLI in chat tests: `codex features list`, and
// `codex app-server` with a thread whose answers stream as agentMessage deltas.
// FAKE_CODEX_LOG gets { home, argv } per start and { home, thread } / { home, text } per call;
// accounts listed in FAKE_CODEX_LIMITED (folder names) are at their usage limit;
// FAKE_CODEX_LIMIT_AFTER=N puts .codex at its limit after N answers.
// With live web search, "What is this?" says it searches (commentary), then searches.
import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';

const home = basename(process.env.CODEX_HOME || '');
const record = value => { if (process.env.FAKE_CODEX_LOG) appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify({ home, ...value })}\n`); };
const argv = process.argv.slice(2);
if (argv[0] === 'features') {
  process.stdout.write(['apps                     stable  true', 'shell_tool               stable  true', 'browser_use              stable  true', 'computer_use             stable  true', 'sqlite                   stable  true', 'code_mode_host           stable  true', 'image_generation         stable  true', 'unified_exec             stable  false'].join('\n') + '\n');
  process.exit(0);
}
record({ argv });
const out = value => process.stdout.write(`${JSON.stringify(value)}\n`);
let buffer = ''; let turns = 0;
process.stdin.on('data', chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    if (message.id == null) continue;
    if (message.method === 'initialize') out({ id: message.id, result: { userAgent: 'fake' } });
    else if (message.method === 'thread/start') { record({ thread: message.params }); out({ id: message.id, result: { thread: { id: 'thread-1' }, model: 'fake', sandbox: message.params.sandbox } }); }
    else if (message.method === 'turn/start') {
      const text = message.params.input.map(part => part.text).join('');
      record({ text });
      out({ id: message.id, result: { turn: { id: `turn-${++turns}`, status: 'inProgress' } } });
      const after = process.env.FAKE_CODEX_LIMIT_AFTER;
      if (String(process.env.FAKE_CODEX_LIMITED || '').split(',').includes(home) || (after && home === '.codex' && turns > Number(after))) {
        out({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: `turn-${turns}`, status: 'failed', error: { message: 'You’ve hit your usage limit. Try again at 3:57 PM.' } } } });
        continue;
      }
      const reply = /What is this\?/.test(text) ? `**Fotosintesi** (ChatGPT, ${home})` : `Risposta ${turns} da ${home}${/Conversation so far/.test(text) ? ' (con la conversazione)' : ''}`;
      if (/What is this\?/.test(text) && argv.includes('web_search="live"')) {
        out({ method: 'item/started', params: { item: { type: 'agentMessage', id: 'c', text: '', phase: 'commentary' } } });
        out({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: `turn-${turns}`, itemId: 'c', delta: 'Cerco sul web.' } });
        out({ method: 'item/started', params: { item: { type: 'webSearch', id: 'w', query: '' } } });
      }
      out({ method: 'item/started', params: { item: { type: 'agentMessage', id: 'i', text: '', phase: 'final_answer' } } });
      for (const piece of reply.match(/[\s\S]{1,8}/g)) out({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: `turn-${turns}`, itemId: 'i', delta: piece } });
      out({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: `turn-${turns}`, status: 'completed' } } });
    }
  }
});
