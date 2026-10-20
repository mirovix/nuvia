import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { askPrompt, askSystem, claudeArgs, extractReply, findClaude, mailPrompt, mailSystem, startChat } from '../../lib/claude-chat.js';

const fake = resolve(import.meta.dirname, '..', 'fixtures', 'fake-claude.mjs');

function converse(env, messages) {
  return new Promise(done => {
    const events = []; let left = messages.length;
    const chat = startChat({ command: fake, system: 'test', cwd: tmpdir(), env: { ...process.env, ...env }, onEvent: event => {
      events.push(event);
      if (event.type === 'done' || event.type === 'error') { if (--left === 0) { chat.stop(); done(events); } }
    } });
    for (const message of messages) chat.send(message);
  });
}

test('a conversation streams each answer and keeps going', async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'claude-chat-')), 'log');
  const events = await converse({ FAKE_CLAUDE_LOG: log }, ['Help me reply to this email.', 'Giovedì va bene.']);
  const done = events.filter(event => event.type === 'done');
  assert.equal(done.length, 2);
  assert.match(done[0].text, /Giovedì alle 10/);
  assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join('').length, done[0].text.length + done[1].text.length);
  assert.equal(extractReply(done[1].text), 'Ciao Anna,\n\ngrazie per le note: giovedì alle 10 va benissimo.\n\nMiro');
  const lines = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(lines.filter(line => line.user).map(line => line.user), ['Help me reply to this email.', 'Giovedì va bene.'], 'the second message waits for the first answer');
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
  const args = claudeArgs({ system: 'S', model: 'sonnet' });
  const after = flag => args[args.indexOf(flag) + 1];
  assert.equal(after('--tools'), '');
  assert.equal(after('--setting-sources'), '');
  assert.ok(args.includes('--strict-mcp-config') && args.includes('--no-session-persistence'));
  assert.equal(after('--system-prompt'), 'S');
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
