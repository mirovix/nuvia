import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { askPrompt, askSystem, claudeArgs, extractReply, findClaude, mailPrompt, mailSystem, startChat, startCodexChat, forgetCodexLimits } from '../../lib/claude-chat.js';

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

// ChatGPT through the Codex CLI.
const fakeCodex = resolve(import.meta.dirname, '..', 'fixtures', 'fake-codex-exec.mjs');
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

test('ChatGPT: each message carries the conversation so far, read-only and saving nothing', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'codex-chat-'));
  const log = join(tmp, 'log');
  const events = await codexConverse({ FAKE_CODEX_LOG: log }, [join(tmp, '.codex')], ['first question', 'second question']);
  assert.deepEqual(events.filter(event => event.type === 'done').map(event => event.text), ['Risposta 1 da .codex', 'Risposta 2 da .codex']);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.match(calls[0].prompt, /Instructions:\nBe brief\./);
  assert.match(calls[1].prompt, /\[User\]\nfirst question\n\n\[You\]\nRisposta 1 da \.codex\n\n\[User\]\nsecond question/);
  for (const flag of ['--ephemeral', '--ignore-user-config', 'read-only']) assert.ok(calls[0].argv.includes(flag), flag);
});

test('ChatGPT: an account at its usage limit hands over to the next one', async () => {
  forgetCodexLimits();
  const tmp = mkdtempSync(join(tmpdir(), 'codex-chat-'));
  const homes = ['.codex', '.codex-account1', '.codex-account2'].map(name => join(tmp, name));
  let events = await codexConverse({ FAKE_CODEX_LIMITED: '.codex,.codex-account1' }, homes, ['hello', 'again']);
  assert.deepEqual(events.filter(event => event.type === 'done').map(event => event.text), ['Risposta 1 da .codex-account2', 'Risposta 2 da .codex-account2'], 'and stays on it');
  // The next conversation starts on the account that answered: no time lost on the limited ones.
  const log = join(tmp, 'log');
  events = await codexConverse({ FAKE_CODEX_LIMITED: '.codex,.codex-account1', FAKE_CODEX_LOG: log }, homes, ['hello']);
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line).home), ['.codex-account2']);
  forgetCodexLimits();
  events = await codexConverse({ FAKE_CODEX_LIMITED: '.codex,.codex-account1,.codex-account2' }, homes, ['hello']);
  assert.equal(events.at(-1).type, 'error');
  assert.match(events.at(-1).message, /usage limit/);
});
