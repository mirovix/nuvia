// Checks the Windows installer on a real Windows machine (GitHub Actions'
// windows-latest, .github/workflows/windows-check.yml):
//
//   node test/windows/check.mjs dist/Nuvia-Setup-<version>.exe
//
// 1. Chrome and Edge get a session (a cookie from a local site) in their own
//    default profile, and their cookie stores are fingerprinted.
// 2. Nuvia is installed, started with Gmail, Outlook, Teams, WhatsApp and
//    Claude, left to load them for a while, then closed.
// 3. The browsers' cookie stores must be untouched, the session still there,
//    and no browser may have been opened by Nuvia.
// 4. Nuvia's data must be in %APPDATA%; an update (the installer run again, as
//    Nuvia's updater does) keeps it; uninstalling deletes it.
// The results go to the job summary; any failure exits with 1.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const setup = resolve(process.argv[2] || '');
if (!existsSync(setup)) { console.error(`Installer not found: ${setup}`); process.exit(2); }
const { APPDATA, LOCALAPPDATA } = process.env;
const sleep = ms => new Promise(done => setTimeout(done, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const note = (name, detail) => { results.push({ name, ok: null, detail }); console.log(`NOTE ${name} — ${detail}`); };

// --- A local site that sets a long-lived cookie and echoes it back.
const token = randomUUID().slice(0, 8);
const server = createServer((request, response) => {
  if (request.url.startsWith('/set')) response.setHeader('Set-Cookie', `nuvia_check=${token}; Max-Age=86400; Path=/; SameSite=Lax`);
  response.setHeader('Content-Type', 'text/html');
  response.end(`<!doctype html><p id="cookie">${request.url.startsWith('/set') ? 'set' : (request.headers.cookie || 'none')}</p>`);
});
await new Promise(done => server.listen(8123, '127.0.0.1', done));

const browsers = [
  { name: 'Chrome', exe: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', data: join(LOCALAPPDATA, 'Google', 'Chrome', 'User Data') },
  { name: 'Edge', exe: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', data: join(LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data') }
].filter(browser => existsSync(browser.exe) || (note(`${browser.name} not installed`, browser.exe), false));
const BROWSER_PROCESSES = ['chrome.exe', 'msedge.exe', 'firefox.exe', 'iexplore.exe', 'brave.exe', 'opera.exe'];

function visit(browser, path) {
  // The browser's real default profile, so the session is the one a user has.
  const run = spawnSync(browser.exe, ['--headless=new', `--user-data-dir=${browser.data}`, '--profile-directory=Default', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--dump-dom', `http://127.0.0.1:8123${path}`], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  return (run.stdout.match(/<p id="cookie">([^<]*)<\/p>/) || [])[1] || `(no page: ${String(run.stderr || run.error || '').slice(0, 200)})`;
}
const hash = file => (existsSync(file) ? createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16) : 'missing');
const fingerprint = browser => ({ cookies: hash(join(browser.data, 'Default', 'Network', 'Cookies')), localState: hash(join(browser.data, 'Local State')), loginData: hash(join(browser.data, 'Default', 'Login Data')) });
const running = () => {
  const out = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8' }).stdout || '';
  return out.split('\n').map(line => line.split('","')[0]?.replace(/^"/, '').toLowerCase()).filter(Boolean);
};
const killBrowsers = () => { for (const name of BROWSER_PROCESSES) spawnSync('taskkill', ['/F', '/T', '/IM', name], { stdio: 'ignore' }); };
const quitNuvia = async () => {
  spawnSync('taskkill', ['/T', '/IM', 'Nuvia.exe'], { stdio: 'ignore' });
  for (let i = 0; i < 20 && running().includes('nuvia.exe'); i++) await sleep(500);
  spawnSync('taskkill', ['/F', '/T', '/IM', 'Nuvia.exe'], { stdio: 'ignore' });
  await sleep(1500);
};
const findFile = (dir, name, depth = 3) => {
  if (!existsSync(dir) || depth < 0) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return path;
    if (entry.isDirectory()) { const found = findFile(path, name, depth - 1); if (found) return found; }
  }
  return null;
};

// --- 1. Browser sessions before Nuvia.
killBrowsers();
const before = {};
for (const browser of browsers) {
  visit(browser, '/set');
  await sleep(1000);
  const seen = visit(browser, '/echo');
  check(`${browser.name}: has a session before Nuvia`, seen.includes(`nuvia_check=${token}`), seen);
  before[browser.name] = fingerprint(browser);
}
killBrowsers();
await sleep(2000);

// --- 2. Install and run Nuvia.
const install = spawnSync(setup, ['/S'], { timeout: 300000 });
check('installer finishes', install.status === 0, `exit ${install.status}`);
const exe = findFile(join(LOCALAPPDATA, 'Programs'), 'Nuvia.exe');
check('Nuvia is installed for the user', exe, exe || 'Nuvia.exe not found under %LOCALAPPDATA%\\Programs');
const dataDirs = ['nuvia-desktop', 'Nuvia'].map(name => join(APPDATA, name));
const dataDir = dataDirs[0];
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, 'services.json'), JSON.stringify([
  { id: 'gmail', name: 'Gmail', url: 'https://mail.google.com/' },
  { id: 'outlook', name: 'Outlook', url: 'https://outlook.live.com/mail/0/' },
  { id: 'teams', name: 'Teams', url: 'https://teams.microsoft.com/v2/' },
  { id: 'whatsapp', name: 'WhatsApp', url: 'https://web.whatsapp.com/' },
  { id: 'claude', name: 'Claude', url: 'https://claude.ai/new' }
]));
const browsersBefore = running().filter(name => BROWSER_PROCESSES.includes(name));
const opened = new Set();
if (exe) {
  spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
  // Every service is opened at startup; give them time to load and sign-in pages to redirect.
  for (let waited = 0; waited < 75000; waited += 2500) {
    await sleep(2500);
    for (const name of running()) if (BROWSER_PROCESSES.includes(name) && !browsersBefore.includes(name)) opened.add(name);
  }
  check('Nuvia ran', existsSync(join(dataDir, 'Preferences')) || existsSync(join(dataDir, 'Partitions')), `data folder: ${existsSync(dataDir) ? readdirSync(dataDir).join(', ') : 'missing'}`);
  await quitNuvia();
}
check('Nuvia opened no browser', opened.size === 0, opened.size ? [...opened].join(', ') : 'no browser process started while it ran');

// --- 3. The browsers after Nuvia.
for (const browser of browsers) {
  const after = fingerprint(browser);
  check(`${browser.name}: cookie store and keys untouched by Nuvia`, JSON.stringify(after) === JSON.stringify(before[browser.name]), JSON.stringify({ before: before[browser.name], after }));
}
const partitions = join(dataDir, 'Partitions');
const profiles = existsSync(partitions) ? readdirSync(partitions) : [];
check('Nuvia keeps its sessions in its own folder', profiles.some(name => name.startsWith('nuvia-')), `${dataDir}\\Partitions: ${profiles.join(', ') || 'none'}`);
check('no Nuvia data elsewhere in %APPDATA%', !existsSync(dataDirs[1]), existsSync(dataDirs[1]) ? `${dataDirs[1]} exists` : 'only %APPDATA%\\nuvia-desktop');

// --- 4. Update keeps the data; uninstall deletes it.
const update = spawnSync(setup, ['/S', '--force-run'], { timeout: 300000 });
await sleep(8000);
await quitNuvia();
check('update (installer run again, as the updater does) keeps the data', update.status === 0 && existsSync(join(dataDir, 'services.json')) && existsSync(partitions), `exit ${update.status}; services.json ${existsSync(join(dataDir, 'services.json')) ? 'kept' : 'gone'}`);
const installDir = exe ? resolve(exe, '..') : null;
const uninstaller = installDir ? readdirSync(installDir).find(name => /^Uninstall .*\.exe$/i.test(name)) : null;
check('an uninstaller is installed', uninstaller, uninstaller || 'none');
if (uninstaller) {
  spawnSync(join(installDir, uninstaller), ['/S'], { timeout: 300000 });
  // The uninstaller copies itself to a temporary folder and returns at once.
  for (let i = 0; i < 60 && (existsSync(dataDir) || existsSync(exe)); i++) await sleep(1000);
  check('uninstall removes the program', !existsSync(exe), installDir);
  check('uninstall deletes Nuvia\'s data and sign-ins', !existsSync(dataDir), existsSync(dataDir) ? `left: ${readdirSync(dataDir).slice(0, 12).join(', ')}` : `${dataDir} deleted`);
}
for (const browser of browsers) {
  const seen = visit(browser, '/echo');
  check(`${browser.name}: session still there after install, use, update and uninstall`, seen.includes(`nuvia_check=${token}`), seen);
}
killBrowsers();
server.close();

const icon = ok => (ok === null ? 'ℹ️' : ok ? '✅' : '❌');
const summary = [`## Nuvia on Windows (${execFileSync('cmd', ['/c', 'ver'], { encoding: 'utf8' }).trim()})`, '', `Installer: \`${setup.split('\\').at(-1)}\` (${(statSync(setup).size / 1048576).toFixed(0)} MB)`, '', '| | Check | Detail |', '|---|---|---|',
  ...results.map(item => `| ${icon(item.ok)} | ${item.name} | ${String(item.detail).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`)].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
writeFileSync('windows-check.md', `${summary}\n`);
process.exit(results.some(item => item.ok === false) ? 1 : 0);
