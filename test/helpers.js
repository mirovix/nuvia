// Launches Nuvia under Xvfb with a throw-away profile and drives it over CDP.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import net from 'node:net';

export const project = resolve(import.meta.dirname, '..');
export const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolvePort(port)); });
  });
}

export class Page {
  constructor(target) { this.target = target; this.id = 0; this.pending = new Map(); this.logs = []; }
  async connect() {
    this.ws = new WebSocket(this.target.webSocketDebuggerUrl);
    await new Promise((resolveOpen, reject) => { this.ws.onopen = resolveOpen; this.ws.onerror = reject; });
    this.ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) { this.pending.get(message.id)(message); this.pending.delete(message.id); return; }
      if (message.method === 'Runtime.exceptionThrown') this.logs.push({ type: 'exception', text: message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text });
      if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type)) this.logs.push({ type: message.params.type, text: message.params.args.map(arg => arg.value ?? arg.description ?? '').join(' ') });
      if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') this.logs.push({ type: 'log', text: `${message.params.entry.text} ${message.params.entry.url || ''}` });
    };
    await this.send('Runtime.enable'); await this.send('Log.enable'); await this.send('Page.enable');
    return this;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise(resolveSend => { this.pending.set(id, resolveSend); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expression, { timeout = 60000 } = {}) {
    const response = await Promise.race([this.send('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true, userGesture: true }), sleep(timeout).then(() => ({ timeout: true }))]);
    if (response.timeout) throw new Error(`Timeout valutando: ${expression.slice(0, 120)}`);
    if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.exception?.description || response.result.exceptionDetails.text);
    return response.result?.result?.value;
  }
  async waitFor(expression, { timeout = 20000, interval = 150 } = {}) {
    const end = Date.now() + timeout; let last;
    while (Date.now() < end) {
      try { last = await this.eval(`return (${expression});`, { timeout: 5000 }); if (last) return last; } catch (error) { last = error.message; }
      await sleep(interval);
    }
    throw new Error(`Condizione non soddisfatta: ${expression} (ultimo valore: ${JSON.stringify(last)})`);
  }
  async screenshot(file) {
    const { result } = await this.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(result.data, 'base64'));
  }
  close() { try { this.ws.close(); } catch {} }
}

export async function launch({ prepare, env: extraEnv = {}, width = 1480, height = 940 } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'nuvia-test-'));
  const home = join(profile, 'home');
  mkdirSync(home, { recursive: true });
  prepare?.(profile);
  const port = await freePort();
  const env = { ...process.env, NUVIA_TEST: '1', CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'), ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  const electron = process.env.NUVIA_ELECTRON_BIN || join(project, 'node_modules', '.bin', 'electron');
  const args = [...(process.env.NUVIA_ELECTRON_BIN ? [] : ['.']), `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-sandbox', '--in-process-gpu', '--no-zygote'];
  const child = spawn('xvfb-run', ['-a', '-s', `-screen 0 ${width + 40}x${height + 40}x24`, electron, ...args], { cwd: project, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const app = {
    profile, port, child,
    output: () => output.split('\n').filter(line => !/gpu_process_host|dbus|Fontconfig|libva|viz_main|DevTools listening|ALSA|pulseaudio|ContextResult|mesa|shared_image/i.test(line)).join('\n'),
    async targets() { return (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); },
    async page(predicate, timeout = 25000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        try { const target = (await app.targets()).find(predicate); if (target) return new Page(target).connect(); } catch {}
        await sleep(200);
      }
      throw new Error('Pagina non trovata');
    },
    async ui() {
      const page = await app.page(target => target.type === 'page' && /index\.html$/.test(target.url));
      await page.waitFor('window.__nuviaReady === true', { timeout: 30000 });
      return page;
    },
    async close() {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      await sleep(400);
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      rmSync(profile, { recursive: true, force: true });
    }
  };
  return app;
}

export function writeProfile(profile, files) {
  for (const [name, value] of Object.entries(files)) writeFileSync(join(profile, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}
