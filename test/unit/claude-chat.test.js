import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { askPrompt, askSystem, claudeArgs, extractReply, findClaude, mailPrompt, mailSystem, messagePrompt, messageSystem, startChat, startCodexChat, forgetCodexLimits, codexLockdownArgs } from '../../lib/claude-chat.js';

const fake = resolve(import.meta.dirname, '..', 'fixtures', 'fake-claude.mjs');

function converse(env, messages, cwd = tmpdir()) {
  return new Promise(done => {
    const events = []; let left = messages.length;
    // Through node: Windows cannot run a .mjs file as a program.
    const chat = startChat({ command: process.execPath, args: [fake], system: 'test', cwd, env: { ...process.env, ...env }, onEvent: event => {
      events.push(event);
      if (event.type === 'error' || (event.type === 'done' && --left === 0)) { chat.stop(); done(events); }
    } });
    for (const message of messages) chat.send(message);
  });
}

test('a conversation streams each answer and keeps going', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'claude-chat-'));
  const log = join(tmp, 'log');
  const events = await converse({ FAKE_CLAUDE_LOG: log }, ['Help me reply to this email.', 'Giovedì va bene.'], tmp);
  const done = events.filter(event => event.type === 'done');
  assert.equal(done.length, 2);
  assert.match(done[0].text, /Giovedì alle 10/);
  assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join('').length, done[0].text.length + done[1].text.length);
  assert.equal(extractReply(done[1].text), 'Ciao Anna,\n\ngrazie per le note: giovedì alle 10 va benissimo.\n\nMiro');
  const lines = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(lines.filter(line => line.user).map(line => line.user), ['Help me reply to this email.', 'Giovedì va bene.'], 'the second message waits for the first answer');
  assert.equal(lines.find(line => line.argv).system, 'test', 'the instructions reach Claude through their file');
  assert.deepEqual(readdirSync(tmp).filter(name => name.startsWith('instructions-')), [], 'and the file is gone afterwards');
});

test('Claude Code failing reaches the window as an error', async () => {
  const events = await converse({ FAKE_CLAUDE_FAIL: 'auth' }, ['hello']);
  assert.equal(events.at(-1).type, 'error');
  assert.match(events.at(-1).message, /Not logged in/);
});

test('a missing command is an error, not a crash', async () => {
  const event = await new Promise(done => startChat({ command: '/nonexistent/claude', system: 'x', cwd: tmpdir(), onEvent: done }));
  assert.equal(event.type, 'error');
});

test('Claude runs with no tools, MCP servers or user settings', () => {
  const args = claudeArgs({ systemFile: '/tmp/s.txt', model: 'sonnet' });
  const after = flag => args[args.indexOf(flag) + 1];
  assert.equal(after('--tools'), '');
  assert.equal(after('--setting-sources'), '');
  assert.ok(args.includes('--strict-mcp-config') && args.includes('--no-session-persistence'));
  assert.equal(after('--system-prompt-file'), '/tmp/s.txt');
  assert.ok(!args.includes('--allowedTools'));
  // Ask: web search and fetch, nothing else.
  const web = claudeArgs({ systemFile: '/tmp/s.txt', web: true });
  assert.equal(web[web.indexOf('--tools') + 1], 'WebSearch,WebFetch');
  assert.equal(web[web.indexOf('--allowedTools') + 1], 'WebSearch,WebFetch');
  assert.equal(web[web.indexOf('--setting-sources') + 1], '');
});

test('a web search drops what Claude wrote before it, and says it is searching', async () => {
  const events = await new Promise(done => {
    const seen = [];
    const chat = startChat({ command: process.execPath, args: [fake], system: 'test', web: true, cwd: tmpdir(), onEvent: event => { seen.push(event); if (event.type === 'done') { chat.stop(); done(seen); } } });
    chat.send('Selected text: x\n\nWhat is this?');
  });
  assert.deepEqual(events.find(event => event.type === 'status'), { type: 'status', text: 'Searching the web…', clear: true });
  assert.match(events.at(-1).text, /^La \*\*fotosintesi\*\*/);
});

test('prompts carry the selection and the email thread', () => {
  assert.match(askSystem({ language: 'Italian' }), /Answer in Italian/);
  const ask = askPrompt({ text: '  CRISPR  ', title: 'Nature', host: 'nature.com' });
  assert.match(ask, /Page: Nature \(nature\.com\)/);
  assert.match(ask, /"""\nCRISPR\n"""/);
  assert.match(mailSystem({ language: 'Italian', name: 'Miro' }), /Sign it as Miro/);
  const mail = mailPrompt({ subject: 'Riunione', messages: [{ from: 'Anna', email: 'anna@example.com', date: 'ieri', body: 'Ci vediamo giovedì?' }] });
  assert.match(mail, /Subject: Riunione/);
  assert.match(mail, /Message 1 from Anna <anna@example\.com>, ieri\nCi vediamo giovedì\?/);
  assert.match(mailPrompt({ subject: 'x', messages: [], text: 'whole pane' }), /whole pane/);
  assert.match(mailPrompt({ messages: [{ body: 'a'.repeat(50000) }] }), /cut, \d+ more characters/);
});

test('the reply is what Claude put between the tags, the last one if it wrote several', () => {
  assert.equal(extractReply('no draft'), null);
  assert.equal(extractReply('<reply>one</reply> then <reply> two </reply>'), 'two');
  assert.equal(extractReply('streaming <reply>half'), 'half');
});

test('the CLI is found outside PATH, in ~/.local/bin', () => {
  const home = mkdtempSync(join(tmpdir(), 'claude-home-'));
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(join(home, '.local', 'bin', 'claude'), '#!/bin/sh\n'); chmodSync(join(home, '.local', 'bin', 'claude'), 0o755);
  assert.equal(findClaude({ env: { PATH: '/nonexistent' }, home }), join(home, '.local', 'bin', 'claude'));
});

// ChatGPT through the Codex CLI's app server.
const fakeCodex = resolve(import.meta.dirname, '..', 'fixtures', 'fake-codex-chat.mjs');
function codexConverse(env, homes, messages) {
  return new Promise(done => {
    const events = []; let left = messages.length;
    const chat = startCodexChat({ command: { command: process.execPath, args: [fakeCodex] }, homes, system: 'Be brief.', cwd: tmpdir(), env: { ...process.env, ...env }, onEvent: event => {
      events.push(event);
      if (event.type === 'error' || (event.type === 'done' && --left === 0)) { chat.stop(); done(events); }
    } });
    for (const message of messages) chat.send(message);
  });
}
const calls = log => readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));

test('ChatGPT: one locked-down server per conversation, answers streaming', async () => {
  forgetCodexLimits();
  const tmp = mkdtempSync(join(tmpdir(), 'codex-chat-'));
  const log = join(tmp, 'log');
  const events = await codexConverse({ FAKE_CODEX_LOG: log }, [join(tmp, '.codex')], ['first question', 'second question']);
  assert.deepEqual(events.filter(event => event.type === 'done').map(event => event.text), ['Risposta 1 da .codex', 'Risposta 2 da .codex']);
  assert.ok(events.filter(event => event.type === 'delta').length > 2, 'the answer streams');
  const seen = calls(log);
  assert.equal(seen.filter(line => line.argv).length, 1, 'one server for the whole conversation');
  const argv = seen.find(line => line.argv).argv;
  for (const feature of ['shell_tool', 'browser_use', 'computer_use', 'apps', 'image_generation']) assert.ok(argv.join(' ').includes(`--disable ${feature}`), `${feature} off`);
  assert.ok(!argv.includes('sqlite') && !argv.includes('unified_exec'), 'harmless or already-off features are left alone');
  assert.ok(argv.includes('mcp_servers={}') && argv.includes('web_search="disabled"'));
  const thread = seen.find(line => line.thread).thread;
  assert.equal(thread.ephemeral, true);
  assert.equal(thread.sandbox, 'read-only');
  assert.equal(thread.approvalPolicy, 'never');
  assert.match(thread.developerInstructions, /^Be brief\.\nOnly talk/);
  assert.deepEqual(seen.filter(line => line.text).map(line => line.text), ['first question', 'second question'], 'the thread keeps the conversation');
});

test('ChatGPT: an account at its usage limit hands over to the next, with the conversation', async () => {
  forgetCodexLimits();
  const tmp = mkdtempSync(join(tmpdir(), 'codex-chat-'));
  const homes = ['.codex', '.codex-account1', '.codex-account2'].map(name => join(tmp, name));
  const log = join(tmp, 'log');
  let events = await codexConverse({ FAKE_CODEX_LIMITED: '.codex,.codex-account1', FAKE_CODEX_LOG: log }, homes, ['hello', 'again']);
  assert.deepEqual(events.filter(event => event.type === 'done').map(event => event.text), ['Risposta 1 da .codex-account2', 'Risposta 2 da .codex-account2'], 'and stays on it');
  // The next conversation starts on the account that answered: no time lost on the limited ones.
  const log2 = join(tmp, 'log2');
  events = await codexConverse({ FAKE_CODEX_LIMITED: '.codex,.codex-account1', FAKE_CODEX_LOG: log2 }, homes, ['hello']);
  assert.deepEqual([...new Set(calls(log2).filter(line => line.argv).map(line => line.home))], ['.codex-account2']);
  forgetCodexLimits();
  events = await codexConverse({ FAKE_CODEX_LIMITED: '.codex,.codex-account1,.codex-account2' }, homes, ['hello']);
  assert.equal(events.at(-1).type, 'error');
  assert.match(events.at(-1).message, /usage limit/);
});

test('ChatGPT: switching accounts mid-conversation brings the conversation along', async () => {
  forgetCodexLimits();
  const tmp = mkdtempSync(join(tmpdir(), 'codex-chat-'));
  const homes = ['.codex', '.codex-account1'].map(name => join(tmp, name));
  const log = join(tmp, 'log');
  const events = await codexConverse({ FAKE_CODEX_LIMIT_AFTER: '1', FAKE_CODEX_LOG: log }, homes, ['first', 'second']);
  assert.deepEqual(events.filter(event => event.type === 'done').map(event => event.text), ['Risposta 1 da .codex', 'Risposta 1 da .codex-account1 (con la conversazione)']);
  const handover = calls(log).filter(line => line.text && line.home === '.codex-account1')[0].text;
  assert.match(handover, /Conversation so far:\n\[User\]\nfirst\n\n\[You\]\nRisposta 1 da \.codex/);
  assert.match(handover, /\[User\]\nsecond$/);
});

test('the lockdown follows the features this Codex has', () => {
  const args = codexLockdownArgs('shell_tool  stable  true\nnew_browser_thing  under development  true\nsqlite stable true\nview_image removed false\n');
  assert.deepEqual(args, ['--disable', 'shell_tool', '--disable', 'new_browser_thing', '-c', 'mcp_servers={}', '-c', 'web_search="disabled"']);
  // Ask: live search, whose tool runs in the code-mode host (no file system); the shell stays off.
  const features = 'shell_tool stable true\ncode_mode_host stable true\nskill_search stable true\n';
  assert.deepEqual(codexLockdownArgs(features), ['--disable', 'shell_tool', '--disable', 'code_mode_host', '--disable', 'skill_search', '-c', 'mcp_servers={}', '-c', 'web_search="disabled"']);
  assert.deepEqual(codexLockdownArgs(features, { web: true }), ['--disable', 'shell_tool', '--disable', 'skill_search', '-c', 'mcp_servers={}', '-c', 'web_search="live"']);
});

test('ChatGPT with the web: its "I will search" commentary is not the answer', async () => {
  forgetCodexLimits();
  const events = await new Promise(done => {
    const seen = [];
    const chat = startCodexChat({ command: { command: process.execPath, args: [fakeCodex] }, homes: [join(tmpdir(), '.codex-web')], system: 'Be brief.', web: true, cwd: tmpdir(), onEvent: event => { seen.push(event); if (event.type === 'done' || event.type === 'error') { chat.stop(); done(seen); } } });
    chat.send('Selected text: x\n\nWhat is this?');
  });
  assert.ok(events.some(event => event.type === 'status' && event.text === 'Searching the web…'));
  assert.equal(events.at(-1).type, 'done');
  assert.match(events.at(-1).text, /^\*\*Fotosintesi\*\*/);
  assert.doesNotMatch(events.filter(event => event.type === 'delta').map(event => event.text).join(''), /Cerco/);
});

test('a chat reply sees who wrote each message, the user\'s own marked [me]', () => {
  const prompt = messagePrompt({ title: 'Lab group', app: 'Telegram', messages: [{ from: 'Marco', time: '10:02', text: 'Meeting at 3?' }, { from: 'Miro', mine: true, text: 'ok' }, { from: '', text: 'And the slides?' }, { from: 'Anna', text: '' }] });
  assert.equal(prompt, 'Chat: Lab group (Telegram)\n\n[Marco] 10:02\nMeeting at 3?\n\n[me]\nok\n\n[them]\nAnd the slides?\n\nHelp me reply to this chat.');
  const system = messageSystem({ language: 'Italian', name: 'Miro' });
  assert.match(system, /<reply>/);
  assert.match(system, /language of the conversation/);
  assert.match(system, /The user is Miro/);
});
