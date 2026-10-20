// Conversations with Claude through the Claude Code CLI, for "Ask Claude" on a
// selection and "Reply with Claude" on an email.
//
// One `claude -p` process per conversation, kept open: each message is a line
// of stream-json on stdin, and the answer streams back on stdout. It runs with
// no tools, no MCP servers and none of the user's settings or hooks, so it can
// only talk; it uses the account Claude Code is signed in with.
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
export function claudeArgs({ systemFile, model = 'sonnet' }) {
  return ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--no-session-persistence', '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--model', model, '--system-prompt-file', systemFile];
}
// cmd.exe drops empty arguments and splits on spaces: quote every one.
const forCmd = arg => `"${String(arg).replace(/"/g, '""')}"`;

/**
 * Starts a conversation. onEvent gets { type: 'delta', text } while Claude
 * writes, { type: 'done', text } at the end of each answer, and
 * { type: 'error', message } if Claude Code fails or stops.
 */
export function startChat({ command, args = [], system, model, cwd, env = process.env, onEvent }) {
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
    const all = [...args, ...claudeArgs({ systemFile, model })];
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
    `Answer in ${language}, unless the user writes to you in another language.`,
    'Be brief: two to five sentences, or a few bullets. No preamble, no restating the question. Plain Markdown.',
    'A word, name or acronym: say what it is. A sentence or paragraph: explain or summarize it. Code or an error: explain it.',
    'Use the page title only to disambiguate. If you are not sure, say so in a few words.'
  ].join('\n');
}

export function askPrompt({ text, title = '', host = '' }) {
  return `Page: ${title || host}${host && title ? ` (${host})` : ''}\n\nSelected text:\n"""\n${clip(String(text).trim(), 6000)}\n"""\n\nWhat is this?`;
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

/** The reply Claude wrote between <reply> tags, or null. */
export function extractReply(text) {
  const found = [...String(text || '').matchAll(/<reply>([\s\S]*?)(?:<\/reply>|$)/g)];
  return found.length ? found.at(-1)[1].trim() : null;
}

// ChatGPT instead of Claude: the Codex CLI, one `codex exec` per message.
// Started ephemeral (no session saved), read-only, in an empty folder and
// without the user's config or rules, so each message carries the whole
// conversation. A signed-in account at its usage limit hands over to the next
// one (~/.codex, ~/.codex-*), as Codex limits are per account.
export function codexArgs(cwd) {
  return ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '-s', 'read-only', '-C', cwd, '-'];
}

export function codexPrompt(system, history, text) {
  const turns = history.map(turn => `[${turn.role === 'user' ? 'User' : 'You'}]\n${turn.text}`).join('\n\n');
  return [
    'You are a chat assistant inside Nuvia, a desktop app. Only talk: do not run commands, read or write files.',
    '', 'Instructions:', system, '',
    turns ? `Conversation so far:\n${turns}\n` : '',
    `[User]\n${text}`, '', 'Answer the last user message.'
  ].join('\n');
}

const limitReached = message => /usage limit|rate limit|quota|try again at/i.test(message);
// Accounts found at their limit are skipped for half an hour: trying them first
// added seconds to every message.
const limitedUntil = new Map(); // CODEX_HOME → when to try it again
export const forgetCodexLimits = () => limitedUntil.clear(); // tests

export function startCodexChat({ command, homes = [], system, cwd, env = process.env, onEvent }) {
  // `command` is what codex-live.js#findCodex returns: { command, args }.
  const history = [];
  const queue = [];
  let busy = false; let stopped = false; let child = null;
  // The first account not known to be at its limit; all of them limited: try them all again.
  const usable = homes.filter(item => !(limitedUntil.get(item) > Date.now()));
  homes = usable.length ? [...usable, ...homes.filter(item => !usable.includes(item))] : homes;
  let home = 0;
  const once = (text, homeIndex) => new Promise(resolve => {
    const childEnv = { ...env };
    if (homes[homeIndex]) childEnv.CODEX_HOME = homes[homeIndex];
    delete childEnv.ELECTRON_RUN_AS_NODE;
    try {
      child = spawn(command.command, [...command.args, ...codexArgs(cwd)], { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: /\.cmd$/i.test(command.command) });
    } catch (error) { return resolve({ error: error.message }); }
    let buffer = ''; let answer = ''; let error = ''; let errors = '';
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (message.type === 'item.completed' && message.item?.type === 'agent_message') answer += (answer ? '\n\n' : '') + message.item.text;
        if (message.type === 'error' || message.type === 'turn.failed') error = message.message || message.error?.message || error;
      }
    });
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2000); });
    child.on('error', failure => resolve({ error: failure.code === 'ENOENT' ? 'Codex is not installed' : failure.message }));
    child.on('close', code => resolve(answer && !error ? { text: answer } : { error: error || errors.trim().split('\n').at(-1) || `Codex stopped (code ${code})` }));
    child.stdin.end(prompt(text));
  });
  const prompt = text => codexPrompt(system, history, text);
  async function run(text) {
    busy = true;
    let result = await once(text, home);
    // Out of messages on this account: the next signed-in one answers.
    while (!stopped && result.error && limitReached(result.error) && home + 1 < homes.length) { limitedUntil.set(homes[home], Date.now() + 30 * 60000); result = await once(text, ++home); }
    if (result.error && limitReached(result.error)) limitedUntil.set(homes[home], Date.now() + 30 * 60000);
    busy = false;
    if (stopped) return;
    if (result.error) onEvent({ type: 'error', message: result.error });
    else {
      history.push({ role: 'user', text }, { role: 'assistant', text: result.text });
      onEvent({ type: 'delta', text: result.text });
      onEvent({ type: 'done', text: result.text });
    }
    if (queue.length) run(queue.shift());
  }
  return {
    send(text) { if (stopped) return; if (busy) queue.push(text); else run(text); },
    stop() { stopped = true; try { child?.kill(); } catch {} }
  };
}
