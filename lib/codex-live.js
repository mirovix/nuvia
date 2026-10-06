// Live Codex limits, one entry per account.
//
// The session logs only hold the limits Codex saw during its last run, so they
// go stale as soon as Codex is idle. `codex app-server` asks OpenAI for the
// current numbers (account/rateLimits/read) and who is signed in (account/read).
//
// Codex keeps one login per CODEX_HOME folder. A second account lives in its own
// folder, set up once with `CODEX_HOME=~/.codex-work codex login`: every
// ~/.codex-* folder holding a login is picked up on its own.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

/** The Codex folders that hold a login: the default one first, then ~/.codex-*. */
export function codexHomes({ home, primary = join(home, '.codex'), extra = [] } = {}) {
  const found = [primary];
  let names = [];
  try { names = readdirSync(home); } catch {}
  for (const name of names.sort()) {
    if (!/^\.codex[-_.].+/.test(name)) continue;
    found.push(join(home, name));
  }
  found.push(...extra);
  const unique = [...new Set(found)];
  return unique.filter(dir => existsSync(join(dir, 'auth.json')));
}

/**
 * How to start Codex: { command, args }. Apps started from the desktop often lack
 * nvm's bin dir in PATH, and an old global install may be found first: its
 * `#!/usr/bin/env node` then picks the system node, which can be too old to run
 * it. A Codex installed next to its own node (nvm) is preferred and started with
 * that node directly, so the PATH does not matter.
 */
export function findCodex({ env = process.env, home } = {}) {
  const windows = process.platform === 'win32';
  const names = windows ? ['codex.cmd', 'codex.exe', 'codex'] : ['codex'];
  const dirs = [];
  try {
    const nvm = join(home, '.nvm', 'versions', 'node');
    const byVersion = (a, b) => b.replace(/^v/, '').split('.').map(Number).reduce((d, n, i) => d || n - (a.replace(/^v/, '').split('.').map(Number)[i] || 0), 0);
    for (const version of readdirSync(nvm).sort(byVersion)) dirs.push(join(nvm, version, 'bin'));
  } catch {}
  dirs.push(...String(env.PATH || '').split(delimiter).filter(Boolean), join(home || '', '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin');
  const found = [];
  for (const dir of [...new Set(dirs)]) for (const name of names) if (existsSync(join(dir, name))) found.push(join(dir, name));
  if (!found.length) return null;
  const node = file => join(dirname(file), windows ? 'node.exe' : 'node');
  const withNode = found.find(file => !windows && existsSync(node(file)));
  if (withNode) return { command: node(withNode), args: [realpathSync(withNode)] };
  return { command: found[0], args: [] };
}

function limitWindow(raw) {
  if (!raw || typeof raw.usedPercent !== 'number') return null;
  return { percent: raw.usedPercent, windowMinutes: raw.windowDurationMins || null, resetsAt: raw.resetsAt ? raw.resetsAt * 1000 : null, stale: false };
}

/** Turns app-server answers into what the UI shows. */
export function normalizeCodexLive(account, limits, { home, now = Date.now() } = {}) {
  const rate = limits?.rateLimits || limits?.rateLimitsByLimitId?.codex || null;
  return {
    home,
    email: account?.account?.email || null,
    plan: rate?.planType || account?.account?.planType || null,
    session: limitWindow(rate?.primary),
    weekly: limitWindow(rate?.secondary),
    limitReached: Boolean(rate?.rateLimitReachedType),
    updatedAt: now,
    live: true
  };
}

/**
 * Asks `codex app-server` (CODEX_HOME = home) for the account and its limits.
 * Never throws: on failure returns { home, error }.
 */
export function readCodexLive({ home, command, args = ['app-server'], env = process.env, timeoutMs = 20000, now = () => Date.now() } = {}) {
  // `command` is a path, or what findCodex() returns ({ command, args }).
  if (command && typeof command === 'object') { args = [...command.args, ...args]; command = command.command; }
  return new Promise(resolve => {
    if (!command) return resolve({ home, error: 'Codex CLI not found' });
    let child;
    try { child = spawn(command, args, { env: { ...env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }); } catch (error) { return resolve({ home, error: error.message }); }
    let buffer = ''; let next = 0; let finished = false;
    const waiting = new Map();
    const finish = value => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      for (const done of waiting.values()) done(null);
      try { child.stdin.end(); child.kill(); } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish({ home, error: 'Codex did not answer in time' }), timeoutMs);
    child.on('error', error => finish({ home, error: error.message }));
    child.on('exit', () => finish({ home, error: 'Codex stopped before answering' }));
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (message.id != null && waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); }
      }
    });
    const send = message => { try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch {} };
    const call = (method, params = {}) => new Promise(done => { const id = ++next; waiting.set(id, done); send({ jsonrpc: '2.0', id, method, params }); });
    (async () => {
      const init = await call('initialize', { clientInfo: { name: 'nuvia', version: '1' } });
      if (!init || init.error) return finish({ home, error: init?.error?.message || 'Codex did not start' });
      send({ jsonrpc: '2.0', method: 'initialized' });
      const [account, limits] = await Promise.all([call('account/read'), call('account/rateLimits/read')]);
      if (!limits || limits.error) return finish({ home, error: limits?.error?.message || 'No limits from Codex', email: account?.result?.account?.email || null });
      finish(normalizeCodexLive(account?.result, limits.result, { home, now: now() }));
    })();
  });
}
