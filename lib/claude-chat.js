// Conversations with Claude through the Claude Code CLI, for "Ask Claude" on a
// selection and "Reply with Claude" on an email.
//
// One `claude -p` process per conversation, kept open: each message is a line
// of stream-json on stdin, and the answer streams back on stdout. It runs with
// no MCP servers and none of the user's settings or hooks, and no tools but web
// search and fetch for "Ask" (`web`): it cannot run commands or read files. It
// uses the account Claude Code is signed in with.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { delimiter, join } from 'node:path';

/** The Claude Code CLI, or null. Apps started from the desktop often lack ~/.local/bin in PATH. */
export function findClaude({ env = process.env, home } = {}) {
  const windows = process.platform === 'win32';
  const names = windows ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'];
  const dirs = [...String(env.PATH || '').split(delimiter).filter(Boolean)];
  if (home) {
    dirs.push(join(home, '.local', 'bin'), join(home, '.claude', 'local'), join(home, '.npm-global', 'bin'));
    try { for (const version of readdirSync(join(home, '.nvm', 'versions', 'node'))) dirs.push(join(home, '.nvm', 'versions', 'node', version, 'bin')); } catch {}
    if (windows) dirs.push(join(home, 'AppData', 'Roaming', 'npm'));
  }
  dirs.push('/usr/local/bin', '/opt/homebrew/bin');
  for (const dir of [...new Set(dirs)]) for (const name of names) if (existsSync(join(dir, name))) return join(dir, name);
  return null;
}

// The instructions go in a file: long and on several lines, they would not
// survive Windows' command line (claude.cmd from npm runs through cmd.exe).
export const WEB_TOOLS = 'WebSearch,WebFetch';
export function claudeArgs({ systemFile, model = 'sonnet', web = false }) {
  return ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--no-session-persistence', '--tools', web ? WEB_TOOLS : '', ...(web ? ['--allowedTools', WEB_TOOLS] : []),
    '--setting-sources', '', '--strict-mcp-config', '--model', model, '--system-prompt-file', systemFile];
}
// What the chat shows while a tool runs.
const toolStatus = name => (/fetch|open|page/i.test(name) ? 'Reading a page…' : 'Searching the web…');
// cmd.exe drops empty arguments and splits on spaces: quote every one.
const forCmd = arg => `"${String(arg).replace(/"/g, '""')}"`;

/**
 * Starts a conversation. onEvent gets { type: 'delta', text } while Claude
 * writes, { type: 'status', text, clear } while it searches the web (what it
 * wrote before is a preamble: `clear` drops it), { type: 'done', text } at the
 * end of each answer, and { type: 'error', message } if Claude Code fails or stops.
 */
export function startChat({ command, args = [], system, model, web = false, cwd, env = process.env, onEvent }) {
  const childEnv = { ...env };
  // Started from a Claude Code terminal: do not look like a nested session.
  for (const name of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'ELECTRON_RUN_AS_NODE']) delete childEnv[name];
  let child; let stopped = false; let busy = false; let answer = ''; let errors = '';
  const queue = [];
  const systemFile = join(cwd, `instructions-${randomUUID()}.txt`);
  const cleanUp = () => rmSync(systemFile, { force: true });
  const fail = message => { if (!stopped) onEvent({ type: 'error', message }); stopped = true; cleanUp(); };
  try {
    writeFileSync(systemFile, system, { mode: 0o600 });
    const cmd = /\.cmd$/i.test(command);
    const all = [...args, ...claudeArgs({ systemFile, model, web })];
    child = spawn(cmd ? forCmd(command) : command, cmd ? all.map(forCmd) : all, { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: cmd });
  } catch (error) {
    queueMicrotask(() => fail(error.message));
    return { send() {}, stop() {} };
  }
  const write = text => {
    busy = true; answer = '';
    try { child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`); } catch (error) { fail(error.message); }
  };
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      if (message.type === 'stream_event' && message.event?.type === 'content_block_delta' && message.event.delta?.type === 'text_delta') {
        answer += message.event.delta.text;
        onEvent({ type: 'delta', text: message.event.delta.text });
      } else if (message.type === 'stream_event' && message.event?.type === 'content_block_start' && /tool_use/.test(message.event.content_block?.type)) {
        answer = '';
        onEvent({ type: 'status', text: toolStatus(message.event.content_block.name || ''), clear: true });
      } else if (message.type === 'result') {
        busy = false;
        if (message.is_error) onEvent({ type: 'error', message: String(message.result || message.subtype || 'Claude could not answer') });
        else onEvent({ type: 'done', text: answer || String(message.result || '') });
        if (queue.length) write(queue.shift());
      }
    }
  });
  child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2000); });
  child.on('error', error => fail(error.code === 'ENOENT' ? 'Claude Code is not installed' : error.message));
  child.on('exit', code => { if (!stopped && (busy || code)) fail(errors.trim().split('\n').at(-1) || `Claude Code stopped (code ${code})`); stopped = true; cleanUp(); });
  return {
    send(text) { if (stopped) return; if (busy) queue.push(text); else write(text); },
    stop() { stopped = true; cleanUp(); try { child.stdin.end(); child.kill(); } catch {} }
  };
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}\n[…cut, ${text.length - max} more characters]` : text);

export function askSystem({ language = 'Italian' } = {}) {
  return [
    'You are a quick explainer inside Nuvia, a desktop app. The user selected some text on a web page and asked what it is.',
    `Answer in ${language}, even though the selected text and these notes may be in English, unless the user writes to you in another language.`,
    'Be brief: two to five sentences, or a few bullets. No preamble, no restating the question. Plain Markdown.',
    'A word, name or acronym: say what it is. A sentence or paragraph: explain or summarize it. Code or an error: explain it.',
    'Use the page title only to disambiguate. If you are not sure, say so in a few words.',
    'You can search the web: do it for anything recent, specific or that you do not know well, and end with the source as a Markdown link. Nothing else: no commands, no files.'
  ].join('\n');
}

export function askPrompt({ text, title = '', host = '', language = '' }) {
  return `Page: ${title || host}${host && title ? ` (${host})` : ''}\n\nSelected text:\n"""\n${clip(String(text).trim(), 6000)}\n"""\n\nWhat is this?${language ? ` Answer in ${language}.` : ''}`;
}

export function mailSystem({ language = 'Italian', name = '' } = {}) {
  return [
    'You help the user reply to an email, inside Nuvia, a desktop app. The email (or thread) is in the first message.',
    `Talk to the user in ${language}.`,
    'First: in one line, say what the sender wants. Then ask the questions you need to write the reply: decisions, dates, facts only the user knows, and the tone if it is unclear. At most three, numbered, short. If the email needs nothing from the user (a thank-you, a simple confirmation), skip the questions and write the reply straight away.',
    'When the user answers, or asks you to just write it, write the reply.',
    'Put the reply between <reply> and </reply>: only the body, ready to send, without a subject line, as formal as the email is.' + (name ? ` Sign it as ${name} when a signature fits.` : ''),
    `Write the reply in the language the email is written in, even though you talk to the user in ${language}; use another language only when the user asks for it.`,
    'Outside the tags, at most one short line. When the user asks for changes, write the whole new reply between the tags again.',
    'Never invent facts the user did not give you: ask instead.'
  ].join('\n');
}

export function mailPrompt(mail) {
  const messages = (mail.messages || []).filter(item => item.body || item.from);
  const thread = messages.length
    ? messages.map((item, index) => `--- Message ${index + 1}${item.from ? ` from ${item.from}${item.email ? ` <${item.email}>` : ''}` : ''}${item.date ? `, ${item.date}` : ''}\n${String(item.body || '').trim()}`).join('\n\n')
    : String(mail.text || '').trim();
  return `Subject: ${mail.subject || '(none)'}\n\n${clip(thread, 40000)}\n\nHelp me reply to this email.`;
}

export function messageSystem({ language = 'Italian', name = '' } = {}) {
  return [
    'You help the user answer a chat (WhatsApp, Telegram, Teams and the like), inside Nuvia, a desktop app. The conversation is in the first message; lines from [me] are the user\'s own.',
    `Talk to the user in ${language}.`,
    'Write a reply to the last messages straight away, between <reply> and </reply>: only the message, ready to send, short, in the tone of the chat (casual if the chat is casual). No greeting formulas or signature unless the chat uses them.' + (name ? ` The user is ${name}.` : ''),
    `Write it in the language of the conversation, even though you talk to the user in ${language}; use another language only when the user asks for it.`,
    'If the reply depends on something only the user knows (a time, a yes or no), still write the most likely reply, then ask that one question in one short line after it.',
    'Outside the tags, at most one short line. When the user asks for changes, write the whole new reply between the tags again.',
    'Never invent facts the user did not give you.'
  ].join('\n');
}

export function messagePrompt(chat) {
  const messages = (chat.messages || []).filter(item => item.text);
  const thread = messages.length
    ? messages.map(item => `[${item.mine ? 'me' : item.from || 'them'}]${item.time ? ` ${item.time}` : ''}\n${String(item.text).trim()}`).join('\n\n')
    : String(chat.text || '').trim();
  return `Chat: ${chat.title || '(unnamed)'}${chat.app ? ` (${chat.app})` : ''}\n\n${clip(thread, 20000)}\n\nHelp me reply to this chat.`;
}

/** The reply Claude wrote between <reply> tags, or null. */
export function extractReply(text) {
  const found = [...String(text || '').matchAll(/<reply>([\s\S]*?)(?:<\/reply>|$)/g)];
  return found.length ? found.at(-1)[1].trim() : null;
}

// ChatGPT instead of Claude: the Codex CLI's app server, kept open for the
// conversation, so the answer streams in and later messages start at once.
// The thread is ephemeral (nothing saved), read-only and never asks for
// approval; every Codex feature that could act rather than talk is turned off:
// an email is untrusted text, and a "read-only" Codex with its tools still ran
// `ls ~` when asked to. A signed-in account at its usage limit hands over to the
// next one (~/.codex, ~/.codex-*), with the conversation so far.

// Feature names change between Codex versions, and an unknown one stops it from
// starting: the ones to turn off come from `codex features list`.
const RISKY_FEATURE = /shell|exec|browser|computer|plugin|^apps$|_apps|apps_|hook|image|tool|skill|mcp|worktree|workspace|code_mode|automation|agent|sleep|goal|search|realtime|dictation|in_app|memory|fanout/;
// With `web` ("Ask"), Codex searches and opens pages: its web tool runs in the
// code-mode host, a JavaScript runtime with no file system; the read-only
// sandbox still rejects writes.
const WEB_FEATURE = /^code_mode_host$/;
export function codexLockdownArgs(featuresList, { web = false } = {}) {
  const enabled = String(featuresList || '').split('\n').map(line => line.trim().split(/\s+/)).filter(parts => parts.length >= 3 && parts.at(-1) === 'true').map(parts => parts[0]);
  const off = enabled.filter(name => RISKY_FEATURE.test(name) && !(web && WEB_FEATURE.test(name)));
  return [...off.flatMap(name => ['--disable', name]), '-c', 'mcp_servers={}', '-c', `web_search="${web ? 'live' : 'disabled'}"`];
}

function codexFeatures(command, env) {
  return new Promise(resolve => {
    let out = '';
    let child;
    try { child = spawn(command.command, [...command.args, 'features', 'list'], { env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, shell: /\.cmd$/i.test(command.command) }); } catch { return resolve(null); }
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('error', () => resolve(null));
    child.on('close', code => resolve(code === 0 ? out : null));
  });
}

export function codexPrompt(system, history, text) {
  const turns = history.map(turn => `[${turn.role === 'user' ? 'User' : 'You'}]\n${turn.text}`).join('\n\n');
  return [system ? `Instructions:\n${system}\n` : '', turns ? `Conversation so far:\n${turns}\n` : '', `[User]\n${text}`].filter(Boolean).join('\n');
}

const limitReached = message => /usage limit|rate limit|quota|try again at/i.test(message);
// Accounts found at their limit are skipped for half an hour: trying them first
// added seconds to every message.
const limitedUntil = new Map(); // CODEX_HOME → when to try it again
export const forgetCodexLimits = () => limitedUntil.clear(); // tests

/** One Codex app server and thread, signed in with the account in `home`. */
async function openCodex({ command, home, system, web, cwd, env }) {
  const childEnv = { ...env };
  if (home) childEnv.CODEX_HOME = home;
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const features = await codexFeatures(command, childEnv);
  // Without the list it is not known what to turn off: no chat rather than an open one.
  if (features == null) throw new Error('Codex did not list its features, so Nuvia cannot turn its tools off');
  const child = spawn(command.command, [...command.args, 'app-server', ...codexLockdownArgs(features, { web })], { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: /\.cmd$/i.test(command.command) });
  let buffer = ''; let next = 0; let errors = ''; let onNotification = () => {}; let closed = null;
  const waiting = new Map();
  const send = message => { try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch {} };
  const fail = message => { closed = message; for (const done of waiting.values()) done({ error: { message } }); waiting.clear(); onNotification({ method: 'nuvia/closed', params: { message } }); };
  child.on('error', error => fail(error.code === 'ENOENT' ? 'Codex is not installed' : error.message));
  child.on('exit', code => fail(errors.trim().split('\n').at(-1) || `Codex stopped (code ${code})`));
  child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2000); });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      if (message.id != null && waiting.has(message.id) && !message.method) { waiting.get(message.id)(message); waiting.delete(message.id); }
      // Codex asking for something (an approval, input): always no.
      else if (message.id != null && message.method) send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Not available in Nuvia' } });
      else if (message.method) onNotification(message);
    }
  });
  const call = (method, params = {}) => new Promise(done => { if (closed) return done({ error: { message: closed } }); const id = ++next; waiting.set(id, done); send({ jsonrpc: '2.0', id, method, params }); });
  const init = await call('initialize', { clientInfo: { name: 'nuvia', version: '1' } });
  if (init.error) { child.kill(); throw new Error(init.error.message || 'Codex did not start'); }
  send({ jsonrpc: '2.0', method: 'initialized' });
  const thread = await call('thread/start', { ephemeral: true, cwd, sandbox: 'read-only', approvalPolicy: 'never', developerInstructions: `${system}\n${web ? 'You can search the web and open pages; never run commands or read files.' : 'Only talk: you have no tools; never run commands or read files.'}` });
  if (thread.error || !thread.result?.thread?.id) { child.kill(); throw new Error(thread.error?.message || 'Codex did not start a conversation'); }
  return {
    home,
    stop() { try { child.stdin.end(); child.kill(); } catch {} },
    // Sends a message; resolves { text } or { error }, calling onDelta as the
    // answer streams and onStatus while it searches. "I'll check…" before a
    // search is commentary, not the answer: kept only if nothing else comes.
    turn(text, onDelta, onStatus = () => {}) {
      return new Promise(async resolve => {
        let answer = ''; let commentary = '';
        const aside = new Set();
        onNotification = message => {
          const { item } = message.params || {};
          if (message.method === 'item/started' && item?.type === 'agentMessage' && item.phase === 'commentary') aside.add(item.id);
          else if (message.method === 'item/started' && item?.type === 'webSearch') onStatus(toolStatus(''));
          else if (message.method === 'item/agentMessage/delta' && aside.has(message.params.itemId)) commentary += message.params.delta;
          else if (message.method === 'item/agentMessage/delta') { answer += message.params.delta; onDelta(message.params.delta); }
          else if (message.method === 'turn/completed') {
            const turn = message.params.turn || {};
            if (!answer && commentary) { answer = commentary; onDelta(commentary); }
            resolve(turn.status === 'completed' ? { text: answer } : { error: turn.error?.message || `Codex stopped (${turn.status})` });
          } else if (message.method === 'nuvia/closed') resolve({ error: message.params.message });
        };
        const started = await call('turn/start', { threadId: thread.result.thread.id, input: [{ type: 'text', text }] });
        if (started.error) resolve({ error: started.error.message || 'Codex did not answer' });
      });
    }
  };
}

export function startCodexChat({ command, homes = [], system, web = false, cwd, env = process.env, onEvent }) {
  // `command` is what codex-live.js#findCodex returns: { command, args }.
  // The first account not known to be at its limit; all of them limited: try them all again.
  const usable = homes.filter(item => !(limitedUntil.get(item) > Date.now()));
  const order = usable.length ? [...usable, ...homes.filter(item => !usable.includes(item))] : [...homes];
  if (!order.length) order.push(null);
  const history = [];
  const queue = [];
  let busy = false; let stopped = false; let server = null; let home = 0;
  // The conversation is warm from the start: the server opens while the first message is written.
  let opening = openCodex({ command, home: order[0], system, web, cwd, env }).catch(error => ({ error }));
  async function answer(text) {
    for (;;) {
      if (!server) {
        const opened = await (opening || openCodex({ command, home: order[home], system, web, cwd, env }).catch(error => ({ error })));
        opening = null;
        if (opened.error) return { error: opened.error.message || String(opened.error) };
        if (stopped) { opened.stop(); return {}; }
        server = opened;
        server.fresh = history.length > 0;
      }
      // A new account's thread has not seen the conversation: it gets it with the message.
      const message = server.fresh ? codexPrompt('', history, text) : text;
      server.fresh = false;
      let streamed = false;
      const result = await server.turn(message, delta => { streamed = true; if (!stopped) onEvent({ type: 'delta', text: delta }); }, status => { if (!stopped) onEvent({ type: 'status', text: status }); });
      if (result.error && limitReached(result.error) && !streamed && home + 1 < order.length) {
        if (order[home]) limitedUntil.set(order[home], Date.now() + 30 * 60000);
        server.stop(); server = null; home++;
        continue;
      }
      if (result.error && limitReached(result.error) && order[home]) limitedUntil.set(order[home], Date.now() + 30 * 60000);
      return result;
    }
  }
  async function run(text) {
    busy = true;
    const result = await answer(text);
    busy = false;
    if (stopped) return;
    if (result.error) onEvent({ type: 'error', message: result.error });
    else {
      history.push({ role: 'user', text }, { role: 'assistant', text: result.text });
      onEvent({ type: 'done', text: result.text });
    }
    if (queue.length) run(queue.shift());
  }
  return {
    send(text) { if (stopped) return; if (busy) queue.push(text); else run(text); },
    stop() { stopped = true; server?.stop(); opening?.then(opened => opened.stop?.()); }
  };
}
