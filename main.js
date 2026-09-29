import { app, BrowserWindow, WebContentsView, ipcMain, dialog, session, net, shell, Notification, Menu, screen, components } from 'electron';
import { join, extname, resolve, sep, dirname } from 'node:path';
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync, createWriteStream, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { homedir, userInfo } from 'node:os';
import { Worker } from 'node:worker_threads';
import yauzl from 'yauzl';
import { geocode } from './lib/geocode.js';
import { routeUrl, summarizeRoute, MODES } from './lib/route.js';
import { parseICS, expandEvents } from './lib/ics.js';
import { parseChatRow, parseMailLines, parseAgendaText, sortFeed, unreadFromTitle, chatTimeToDate } from './lib/feed.js';
import { normalizeClaudeLimits, codexUsage, claudeUsage } from './lib/usage.js';
import { readInfo, defaultRules } from './lib/extensions.js';
import { serviceKind, serviceGroup } from './lib/kinds.js';
import * as pageScripts from './lib/scripts.js';

const { script } = pageScripts;
const TEST = process.env.NUVIA_TEST === '1';
const NOMINATIM = process.env.NUVIA_NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
const ROUTING = process.env.NUVIA_ROUTING_URL || 'https://routing.openstreetmap.de';
const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex');
const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const IS_MAC = process.platform === 'darwin';
const IS_WINDOWS = process.platform === 'win32';
// Optional local integrations, configured in Settings → Integrations (or via env).
function integrations() {
  const saved = readJson(paths.preferences(), {}).integrations || {};
  return {
    iasProject: saved.iasProject || process.env.NUVIA_IAS_PROJECT || '',
    ritardometroProject: saved.ritardometroProject || process.env.NUVIA_RITARDOMETRO || '',
    python: saved.python || process.env.NUVIA_PYTHON || (IS_WINDOWS ? 'python' : 'python3')
  };
}

const fileInProfile = name => join(app.getPath('userData'), name);
const paths = {
  services: () => fileInProfile('services.json'),
  extensions: () => fileInProfile('extensions.json'),
  preferences: () => fileInProfile('preferences.json'),
  extensionRoot: () => fileInProfile('marketplace-extensions'),
  rules: () => fileInProfile('extension-rules.json'),
  guard: () => fileInProfile('extension-guard.json'),
  notifications: () => fileInProfile('notifications.json'),
  log: () => fileInProfile('nuvia.log')
};

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Linux only: ECS's bundled SUID sandbox cannot be root-owned on many distros.
// (--no-zygote must come from the command line: see scripts/start.mjs and scripts/after-pack.cjs.)
if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
if (IS_WINDOWS) app.setAppUserModelId('it.nuvia.desktop');

function log(...parts) {
  try { appendFileSync(paths.log(), `${new Date().toISOString()} ${parts.join(' ')}\n`); } catch {}
}
process.on('uncaughtException', error => log('uncaught', error.stack || error.message));
process.on('unhandledRejection', error => log('unhandled', error?.stack || String(error)));

function readJson(file, fallback) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, data) { writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 }); }
const services = () => readJson(paths.services(), []);
const saveServices = items => writeJson(paths.services(), items);
const serviceById = id => services().find(service => service.id === id);
const partitionFor = id => `persist:nuvia-${String(id).replace(/[^a-z0-9_-]/gi, '')}`;
const userAgent = () => `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const withTimeout = (promise, ms, fallback) => Promise.race([promise, sleep(ms).then(() => fallback)]);

const defaultName = () => { const name = userInfo().username || ''; return name ? name[0].toUpperCase() + name.slice(1) : ''; };
function preferences() { return { theme: 'dark', accent: 'coral', background: 'plain', city: 'Roma', name: defaultName(), ...readJson(paths.preferences(), {}) }; }
function savePreferences(value) { writeJson(paths.preferences(), value); return value; }

let mainWindow;
let activeKey = null;
let overlayDepth = 0;
let hostBounds = { x: 248, y: 60, width: 1180, height: 848 };
const views = new Map();
const serviceState = new Map();

// ---------------------------------------------------------------------------
// Service views

function notifyRenderer(channel, value) { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, value); }
function notifyState() { notifyRenderer('services:state', [...serviceState.values()]); }
const attached = view => mainWindow.contentView.children.includes(view);

function detach(view) { if (view && attached(view)) mainWindow.contentView.removeChildView(view); }
function showActive() {
  const view = views.get(activeKey);
  if (!view || overlayDepth > 0) return;
  if (!attached(view)) mainWindow.contentView.addChildView(view);
  view.setBounds(hostBounds);
}
function showDashboard() { detach(views.get(activeKey)); activeKey = null; }

const sessionsPrepared = new Set();
function prepareSession(serviceId) {
  const serviceSession = session.fromPartition(partitionFor(serviceId));
  if (sessionsPrepared.has(serviceId)) return serviceSession;
  sessionsPrepared.add(serviceId);
  serviceSession.setUserAgent(userAgent());
  const allowed = new Set(['notifications', 'media', 'fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'speaker-selection', 'storage-access', 'top-level-storage-access']);
  // 'openExternal' is refused on purpose: open.spotify.com would otherwise launch the Spotify desktop app.
  serviceSession.setPermissionRequestHandler((_, permission, callback) => callback(allowed.has(permission)));
  serviceSession.setPermissionCheckHandler((_, permission) => allowed.has(permission));
  if (TEST && process.env.NUVIA_FIXTURES) serveFixtures(serviceSession);
  return serviceSession;
}

// Tests only: answer https requests of known hosts with local fixture pages.
function serveFixtures(serviceSession) {
  const root = process.env.NUVIA_FIXTURES;
  serviceSession.protocol.handle('https', request => {
    const url = new URL(request.url);
    const json = join(root, `${url.hostname}${url.pathname.replace(/\//g, '_')}.json`);
    if (existsSync(json)) return new Response(readFileSync(json), { headers: { 'content-type': 'application/json' } });
    const html = join(root, `${url.hostname}.html`);
    if (existsSync(html)) return new Response(readFileSync(html), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    return net.fetch(request, { bypassCustomProtocolHandlers: true });
  });
}

const AUTH_HOSTS =/(^|\.)(accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|appleid\.apple\.com|accounts\.spotify\.com|github\.com|slack\.com|notion\.so|claude\.ai|auth\.openai\.com|chatgpt\.com)$/;
function sameSite(a, b) {
  try { const root = host => new URL(host).hostname.split('.').slice(-2).join('.'); return root(a) === root(b); } catch { return false; }
}

function wireContents(contents, service, key) {
  contents.setWindowOpenHandler(({ url }) => {
    if (!/^https?:|^about:blank/i.test(url)) return { action: 'deny' };
    let host = ''; try { host = new URL(url).hostname; } catch {}
    if (url.startsWith('about:blank') || AUTH_HOSTS.test(host) || sameSite(url, service.url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 560, height: 760, autoHideMenuBar: true, backgroundColor: '#ffffff', webPreferences: { partition: partitionFor(service.id), sandbox: true, contextIsolation: true } } };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => { if (!/^https?:/i.test(url)) event.preventDefault(); });
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta)) return;
    if (/^[0-9]$/.test(input.key) || ['r', 'w', 'k', ','].includes(input.key.toLowerCase()) || input.key === 'F5') {
      event.preventDefault();
      notifyRenderer('shortcut', { key: input.key.toLowerCase(), shift: input.shift, from: key });
    }
  });
}

function trackState(view, service) {
  const contents = view.webContents;
  const update = extra => {
    const previous = serviceState.get(service.id) || {};
    const title = contents.isDestroyed() ? previous.title : (contents.getTitle() || service.name);
    serviceState.set(service.id, {
      ...previous, id: service.id, name: service.name, kind: serviceKind(service),
      url: contents.isDestroyed() ? previous.url : (contents.getURL() || service.url), title,
      loading: !contents.isDestroyed() && contents.isLoading(),
      canGoBack: !contents.isDestroyed() && contents.navigationHistory.canGoBack(),
      canGoForward: !contents.isDestroyed() && contents.navigationHistory.canGoForward(),
      unread: previous.domUnread ?? unreadFromTitle(title), ...extra
    });
    notifyState();
  };
  contents.on('page-title-updated', () => update());
  contents.on('did-start-loading', () => update({ crashed: false }));
  contents.on('did-stop-loading', () => update());
  contents.on('did-navigate-in-page', () => update());
  contents.on('page-favicon-updated', (_, favicons) => update({ favicon: favicons.find(icon => /^https:|^data:/.test(icon)) || '' }));
  contents.on('media-started-playing', () => update({ audible: true }));
  contents.on('media-paused', () => update({ audible: false }));
  contents.on('render-process-gone', (_, details) => {
    log('render-process-gone', service.name, details.reason);
    if (details.reason === 'clean-exit') return;
    update({ crashed: true, loading: false });
    if (views.get(activeKey) === view) detach(view);
    extensionCrashed(service);
  });
  update();
}

async function createServiceView(service, key = service.id, url = service.url) {
  if (views.has(key) && !views.get(key).webContents.isDestroyed()) return views.get(key);
  const serviceSession = prepareSession(service.id);
  await loadExtensionsFor(serviceSession, service);
  const view = new WebContentsView({ webPreferences: { partition: partitionFor(service.id), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: serviceKind(service) !== 'spotify' } });
  view.setBackgroundColor('#ffffff');
  // Background views still need a real viewport: at 0x0 lazy lists (agenda, chats) render nothing.
  view.setBounds(hostBounds);
  view.webContents.setUserAgent(userAgent());
  wireContents(view.webContents, service, key);
  if (key === service.id) trackState(view, service);
  view.webContents.once('did-finish-load', () => releaseGuard(service.id));
  view.webContents.loadURL(url, { userAgent: userAgent() }).catch(error => log('load', service.name, error.message));
  views.set(key, view);
  return view;
}

async function activate(service, { key = service.id, url } = {}) {
  const previous = views.get(activeKey);
  const view = await createServiceView(service, key, url || service.url);
  if (url && views.get(key) === view && view.webContents.getURL() && view.webContents.getURL() !== url) await view.webContents.loadURL(url).catch(() => {});
  if (previous && previous !== view) detach(previous);
  activeKey = key;
  showActive();
  if (overlayDepth === 0) view.webContents.focus();
  return true;
}

function destroyView(key) {
  const view = views.get(key);
  if (!view) return;
  detach(view);
  if (activeKey === key) activeKey = null;
  try { view.webContents.close(); } catch {}
  views.delete(key);
}

function activeContents() { return views.get(activeKey)?.webContents; }

// Hidden, sized window for pages we only read (calendar agenda, usage pages).
async function withHiddenPage(serviceId, url, task, { settle = 2500, timeout = 25000 } = {}) {
  prepareSession(serviceId);
  const window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { partition: partitionFor(serviceId), sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  window.webContents.setAudioMuted(true);
  window.webContents.setUserAgent(userAgent());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try {
    await withTimeout(window.loadURL(url).catch(() => {}), timeout);
    await sleep(settle);
    return await task(window.webContents);
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

async function run(contents, code, ms = 8000, fallback = null) {
  if (!contents || contents.isDestroyed() || contents.isCrashed()) return fallback;
  try { return await withTimeout(contents.executeJavaScript(code, true), ms, fallback); } catch (error) { log('script', error.message); return fallback; }
}

function waitForLoad(contents, ms = 12000) {
  if (!contents.isLoading()) return Promise.resolve();
  return withTimeout(new Promise(resolveWait => contents.once('did-stop-loading', resolveWait)), ms);
}

// ---------------------------------------------------------------------------
// Extensions: never loaded into Nuvia's own UI session, enabled per service,
// and quarantined automatically when a service crashes while they are active.

const extensionDirs = () => readJson(paths.extensions(), []).filter(dir => existsSync(join(dir, 'manifest.json')));
const extensionIdOf = dir => dir.split(/[\\/]/).at(-1);

function rulesFor(dir) {
  const rules = readJson(paths.rules(), {});
  const id = extensionIdOf(dir);
  const info = readInfo(dir);
  const base = info ? defaultRules(info, services()) : {};
  return { ...base, ...(rules[id] || {}) };
}

// guard file: { running, crashes, pending: {serviceId: [ids]}, loaded: {serviceId: [ids]} }
// - pending: extensions being loaded right now; a crash before the page settles
//   points straight at them.
// - loaded: extensions active in this run; two unclean exits in a row disable them.
function updateGuard(change) { const guard = readJson(paths.guard(), {}); change(guard); writeJson(paths.guard(), guard); }
function setGuard(serviceId, ids) {
  updateGuard(guard => {
    guard.pending ||= {}; guard.loaded ||= {};
    if (ids.length) { guard.pending[serviceId] = ids; guard.loaded[serviceId] = [...new Set([...(guard.loaded[serviceId] || []), ...ids])]; }
    else delete guard.pending[serviceId];
  });
}
const guardTimers = new Map();
function releaseGuard(serviceId) {
  clearTimeout(guardTimers.get(serviceId));
  guardTimers.set(serviceId, setTimeout(() => setGuard(serviceId, []), 20000));
}

function quarantine(serviceId, ids, reason) {
  if (!ids.length) return;
  const rules = readJson(paths.rules(), {});
  const service = serviceById(serviceId);
  for (const id of ids) { rules[id] ||= {}; rules[id][serviceId] = false; }
  writeJson(paths.rules(), rules);
  const names = ids.map(id => readInfo(extensionDirs().find(dir => extensionIdOf(dir) === id) || '')?.name || id).join(', ');
  addNotification({ title: 'Estensione disattivata', body: `${names} ${reason} su ${service?.name || 'un servizio'}. La puoi riattivare da Estensioni.`, type: 'warning' });
}

function recoverFromCrash() {
  const guard = readJson(paths.guard(), {});
  let crashes = 0;
  if (guard.running) {
    crashes = (guard.crashes || 0) + 1;
    const pending = Object.entries(guard.pending || {}).filter(([, ids]) => ids.length);
    for (const [serviceId, ids] of pending) quarantine(serviceId, ids, 'ha interrotto Nuvia durante il caricamento');
    if (!pending.length && crashes >= 2) {
      for (const [serviceId, ids] of Object.entries(guard.loaded || {})) quarantine(serviceId, ids, 'era attiva durante due chiusure improvvise');
      crashes = 0;
    }
    if (pending.length) crashes = 0;
  }
  writeJson(paths.guard(), { running: true, crashes, pending: {}, loaded: {} });
}

const crashLog = new Map();
function extensionCrashed(service) {
  const serviceSession = session.fromPartition(partitionFor(service.id));
  const loaded = serviceSession.extensions.getAllExtensions().map(extension => extensionIdOf(extension.path));
  if (!loaded.length) return;
  const recent = (crashLog.get(service.id) || []).filter(at => Date.now() - at < 120000);
  recent.push(Date.now()); crashLog.set(service.id, recent);
  if (recent.length < 2) return;
  quarantine(service.id, loaded, 'ha fatto chiudere la pagina più volte');
  for (const extension of serviceSession.extensions.getAllExtensions()) serviceSession.extensions.removeExtension(extension.id);
  crashLog.delete(service.id);
}

// Electron can crash when extensions load into several sessions at once
// (e.g. Gmail and Spotify starting together): load strictly one at a time.
let extensionQueue = Promise.resolve();
function queued(task) {
  const run = extensionQueue.then(task);
  extensionQueue = run.catch(() => {});
  return run;
}
const loadExtensionsFor = (serviceSession, service) => queued(() => loadExtensionsNow(serviceSession, service));

async function loadExtensionsNow(serviceSession, service) {
  const wanted = extensionDirs().filter(dir => rulesFor(dir)[service.id] !== false);
  const loaded = new Set(serviceSession.extensions.getAllExtensions().map(extension => extension.path));
  const pending = wanted.filter(dir => !loaded.has(dir));
  if (!pending.length) return;
  setGuard(service.id, pending.map(extensionIdOf));
  for (const dir of pending) {
    try { await serviceSession.extensions.loadExtension(dir, { allowFileAccess: true }); }
    catch (error) { log('extension', dir, error.message); }
  }
}

function extensionList() {
  return extensionDirs().map(dir => {
    const info = readInfo(dir) || { name: extensionIdOf(dir), version: '?' };
    return { id: extensionIdOf(dir), marketplaceId: extensionIdOf(dir), name: info.name, version: info.version, description: info.description, icon: info.icon ? pathToFileURL(info.icon).href : '', popup: Boolean(info.popup), rules: rulesFor(dir) };
  });
}

function decodeHtml(text = '') { return text.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>'); }
async function searchMarketplace(query) {
  // Node's fetch on purpose: Chromium's stack gets Google's EU consent page instead of results.
  const response = await fetch(`https://chromewebstore.google.com/search/${encodeURIComponent(query)}`, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`Chrome Web Store non disponibile (${response.status})`);
  const html = await response.text();
  const starts = [...html.matchAll(/data-item-id="([a-p]{32})"/g)];
  return starts.slice(0, 16).map((match, index) => {
    const block = html.slice(match.index, starts[index + 1]?.index ?? match.index + 7000);
    const name = block.match(/<h2[^>]*>([^<]+)<\/h2>/)?.[1] || 'Estensione Chrome';
    const image = block.match(/<img[^>]+src="([^"]+)"/)?.[1] || '';
    const href = block.match(/href="\.\/detail\/([^"]+)"/)?.[1] || match[1];
    return { id: match[1], name: decodeHtml(name), image: decodeHtml(image), url: `https://chromewebstore.google.com/detail/${href}`, installed: extensionDirs().some(dir => extensionIdOf(dir) === match[1]) };
  });
}
async function fetchWithRetry(url, options = {}, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await net.fetch(url, { ...options, redirect: 'follow' });
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) { lastError = error; }
    await sleep(400 * (attempt + 1));
  }
  throw new Error(`Connessione al Chrome Web Store non riuscita: ${lastError?.message || 'rete non disponibile'}`);
}
function extractZipSafely(zipPath, destination) {
  return new Promise((resolveDone, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openError, zip) => {
      if (openError) return reject(openError);
      const root = `${resolve(destination)}${sep}`;
      const fail = error => { try { zip.close(); } catch {} reject(error); };
      zip.readEntry();
      zip.on('entry', entry => {
        const target = resolve(destination, entry.fileName);
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (!`${target}${entry.fileName.endsWith('/') ? sep : ''}`.startsWith(root) || mode === 0o120000) return fail(new Error('Archivio estensione non sicuro'));
        if (entry.fileName.endsWith('/')) { mkdirSync(target, { recursive: true }); zip.readEntry(); return; }
        mkdirSync(dirname(target), { recursive: true });
        zip.openReadStream(entry, (streamError, input) => {
          if (streamError) return fail(streamError);
          const output = createWriteStream(target, { mode: 0o600 });
          input.on('error', fail); output.on('error', fail); output.on('finish', () => zip.readEntry()); input.pipe(output);
        });
      });
      zip.on('end', resolveDone); zip.on('error', fail);
    });
  });
}
async function installMarketplaceExtension(id) {
  if (!/^[a-p]{32}$/.test(id)) throw new Error('ID estensione non valido');
  const url = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${process.versions.chrome.split('.')[0]}.0&acceptformat=crx2,crx3&x=id%3D${id}%26installsource%3Dondemand%26uc`;
  const crx = Buffer.from(await (await fetchWithRetry(url, { headers: { 'user-agent': userAgent() } })).arrayBuffer());
  if (crx.subarray(0, 4).toString() !== 'Cr24') throw new Error('Il Web Store non ha restituito un pacchetto CRX');
  const version = crx.readUInt32LE(4);
  let offset;
  if (version === 3) offset = 12 + crx.readUInt32LE(8);
  else if (version === 2) offset = 16 + crx.readUInt32LE(8) + crx.readUInt32LE(12);
  else throw new Error(`Formato CRX ${version} non supportato`);
  const root = paths.extensionRoot(); const dir = join(root, id); const zip = join(root, `${id}.zip`);
  mkdirSync(root, { recursive: true });
  // Unload the old copy everywhere before replacing its files.
  for (const service of services()) {
    const current = session.fromPartition(partitionFor(service.id)).extensions.getAllExtensions().find(extension => extension.path === dir);
    if (current) session.fromPartition(partitionFor(service.id)).extensions.removeExtension(current.id);
  }
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  writeFileSync(zip, crx.subarray(offset));
  try { await extractZipSafely(zip, dir); } finally { rmSync(zip, { force: true }); }
  const info = readInfo(dir);
  if (!info) { rmSync(dir, { recursive: true, force: true }); throw new Error('Pacchetto senza manifest valido'); }
  writeJson(paths.extensions(), [...new Set([...readJson(paths.extensions(), []), dir])]);
  const rules = readJson(paths.rules(), {});
  rules[id] = { ...defaultRules(info, services()), ...(rules[id] || {}) };
  writeJson(paths.rules(), rules);
  // Load only into services that are already open; the rest pick it up when opened.
  for (const service of services()) {
    if (rules[id][service.id] === false || !sessionsPrepared.has(service.id)) continue;
    setGuard(service.id, [id]);
    try { await queued(() => session.fromPartition(partitionFor(service.id)).extensions.loadExtension(dir, { allowFileAccess: true })); } catch (error) { log('extension', id, error.message); }
    releaseGuard(service.id);
  }
  const enabledOn = services().filter(service => rules[id][service.id] !== false).map(service => service.name);
  return { id, name: info.name, version: info.version, enabledOn };
}

// ---------------------------------------------------------------------------
// Notifications

function addNotification(item) {
  const notifications = readJson(paths.notifications(), []);
  const entry = { id: crypto.randomUUID(), time: new Date().toISOString(), read: false, ...item };
  writeJson(paths.notifications(), [entry, ...notifications].slice(0, 150));
  if (!TEST && Notification.isSupported() && preferences().systemNotifications !== false) {
    const native = new Notification({ title: entry.title || 'Nuvia', body: entry.body || '', silent: true });
    native.on('click', () => { mainWindow?.show(); mainWindow?.focus(); if (entry.serviceId) notifyRenderer('open-service', entry.serviceId); });
    native.show();
  }
  notifyRenderer('notifications:changed');
  return entry;
}

// ---------------------------------------------------------------------------
// Window

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480, height: 940, minWidth: 1024, minHeight: 680, backgroundColor: '#0f1012',
    icon: join(import.meta.dirname, 'assets', 'icon.png'), show: false,
    // macOS keeps its native traffic lights; elsewhere Nuvia draws its own controls.
    ...(IS_MAC ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 20 } } : { frame: false }),
    webPreferences: { preload: join(import.meta.dirname, 'preload.cjs'), contextIsolation: true, sandbox: true }
  });
  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', () => mainWindow.show());
  if (TEST) mainWindow.show();
  mainWindow.on('maximize', () => notifyRenderer('window:state', { maximized: true }));
  mainWindow.on('unmaximize', () => notifyRenderer('window:state', { maximized: false }));
  mainWindow.webContents.session.setPermissionRequestHandler((_, permission, callback) => callback(permission === 'geolocation'));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { if (/^https:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}

function migrate() {
  const prefs = readJson(paths.preferences(), {});
  const done = new Set(prefs.migrations || []);
  if (!done.has('ai-services-1')) {
    const list = services();
    if (!list.some(service => serviceKind(service) === 'claude')) list.push({ id: crypto.randomUUID(), name: 'Claude', url: 'https://claude.ai/new' });
    if (!list.some(service => serviceKind(service) === 'codex')) list.push({ id: crypto.randomUUID(), name: 'Codex', url: 'https://chatgpt.com/codex' });
    if (existsSync(paths.services()) || list.length) saveServices(list);
    done.add('ai-services-1');
  }
  writeJson(paths.preferences(), { ...prefs, migrations: [...done] });
}

if (!TEST && !app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });

app.whenReady().then(async () => {
  try { await components.whenReady(); } catch {}
  migrate();
  recoverFromCrash();
  createWindow();
  // Mail and chat views run in the background so counters and previews stay live.
  let delay = 0;
  for (const service of services().filter(item => ['mail', 'message'].includes(serviceGroup(item)))) {
    setTimeout(() => createServiceView(service).catch(error => log('startup', service.name, error.message)), delay);
    delay += 700;
  }
});
app.on('before-quit', () => writeJson(paths.guard(), { running: false, crashes: 0, pending: {}, loaded: {} }));
app.on('window-all-closed', () => { if (!IS_MAC) app.quit(); });
app.on('activate', () => { if (!mainWindow || mainWindow.isDestroyed()) createWindow(); });

// ---------------------------------------------------------------------------
// IPC: shell, services, overlay

const handle = (channel, fn) => ipcMain.handle(channel, async (_, ...args) => fn(...args));

handle('window:minimize', () => mainWindow.minimize());
handle('window:maximize', () => (mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()));
handle('window:close', () => mainWindow.close());
handle('window:state', () => ({ maximized: mainWindow.isMaximized() }));

handle('view:bounds', rect => {
  const next = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.max(0, Math.round(rect.width)), height: Math.max(0, Math.round(rect.height)) };
  if (!next.width || !next.height) return;
  hostBounds = next;
  const active = views.get(activeKey);
  if (active && attached(active)) active.setBounds(hostBounds);
});

// Dialogs live in the HTML layer, which native views always cover: while one is
// open we take the view out and show a screenshot of it underneath the dialog.
handle('overlay:set', async open => {
  const view = views.get(activeKey);
  if (open) {
    overlayDepth += 1;
    if (overlayDepth > 1 || !view || !attached(view)) return null;
    let image = null;
    try { image = (await withTimeout(view.webContents.capturePage(), 700, null))?.toDataURL() || null; } catch {}
    detach(view);
    return image;
  }
  overlayDepth = Math.max(0, overlayDepth - 1);
  if (overlayDepth === 0) showActive();
  return null;
});

handle('services:list', () => services());
handle('services:state', () => [...serviceState.values()]);
handle('services:save', items => { saveServices(items); return items; });
handle('services:activate', async id => { const service = serviceById(id); if (!service) return false; return activate(service); });
handle('services:activate-url', async (id, url) => {
  const service = serviceById(id);
  if (!service || !/^https:\/\//.test(url)) return false;
  const calendar = /calendar\.google\.com|outlook\.[a-z.]+\/calendar/.test(url);
  return activate(service, { key: calendar ? `${id}#calendar` : id, url });
});
handle('services:home', () => showDashboard());
handle('services:reload', async id => {
  const key = id && activeKey?.startsWith(`${id}#`) ? activeKey : (id || activeKey);
  const contents = key && views.get(key)?.webContents;
  if (!contents) return false;
  if (contents.isCrashed() || serviceState.get(key)?.crashed) {
    const service = serviceById(key.split('#')[0]); const wasActive = activeKey === key;
    destroyView(key);
    if (service && wasActive) return activate(service);
    return true;
  }
  contents.reload();
  return true;
});
handle('services:back', () => { const contents = activeContents(); if (contents?.navigationHistory.canGoBack()) contents.navigationHistory.goBack(); });
handle('services:forward', () => { const contents = activeContents(); if (contents?.navigationHistory.canGoForward()) contents.navigationHistory.goForward(); });
handle('services:remove-view', id => { for (const key of [...views.keys()]) if (key === id || key.startsWith(`${id}#`)) destroyView(key); serviceState.delete(id); notifyState(); });
handle('services:context-menu', id => {
  const service = serviceById(id); if (!service) return;
  const contents = views.get(id)?.webContents;
  Menu.buildFromTemplate([
    { label: 'Apri', click: () => notifyRenderer('open-service', id) },
    { label: 'Ricarica', enabled: Boolean(contents), click: () => contents?.reload() },
    { label: contents?.isAudioMuted() ? 'Riattiva audio' : 'Silenzia', enabled: Boolean(contents), click: () => contents?.setAudioMuted(!contents.isAudioMuted()) },
    { label: 'Apri nel browser', click: () => shell.openExternal(contents?.getURL() || service.url) },
    { type: 'separator' },
    { label: 'Modifica…', click: () => notifyRenderer('service:edit', id) },
    { label: 'Rimuovi', click: () => notifyRenderer('service:remove', id) }
  ]).popup({ window: mainWindow });
});

handle('preferences:get', () => preferences());
handle('preferences:save', value => savePreferences(value));
handle('preferences:background-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { title: 'Scegli uno sfondo', properties: ['openFile'], filters: [{ name: 'Immagini', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
  if (result.canceled) return null;
  const destination = fileInProfile(`background-${Date.now()}${extname(result.filePaths[0]).toLowerCase() || '.jpg'}`);
  copyFileSync(result.filePaths[0], destination);
  return pathToFileURL(destination).href;
});

// ---------------------------------------------------------------------------
// IPC: extensions

handle('extensions:list', () => extensionList());
handle('extensions:search', query => searchMarketplace(String(query).trim()));
handle('extensions:install', id => installMarketplaceExtension(String(id)));
handle('extensions:toggle', async (marketplaceId, serviceId, enabled) => {
  const rules = readJson(paths.rules(), {}); rules[marketplaceId] ||= {}; rules[marketplaceId][serviceId] = Boolean(enabled); writeJson(paths.rules(), rules);
  const dir = extensionDirs().find(path => extensionIdOf(path) === marketplaceId);
  if (!dir) throw new Error('Estensione non trovata');
  if (!sessionsPrepared.has(serviceId)) return rulesFor(dir);
  const target = session.fromPartition(partitionFor(serviceId));
  const loaded = target.extensions.getAllExtensions().find(extension => extension.path === dir);
  if (enabled && !loaded) { setGuard(serviceId, [marketplaceId]); try { await queued(() => target.extensions.loadExtension(dir, { allowFileAccess: true })); } finally { releaseGuard(serviceId); } views.get(serviceId)?.webContents.reload(); }
  if (!enabled && loaded) { target.extensions.removeExtension(loaded.id); views.get(serviceId)?.webContents.reload(); }
  return rulesFor(dir);
});
handle('extensions:remove', async id => {
  const dir = extensionDirs().find(path => extensionIdOf(path) === id);
  for (const service of services()) {
    const current = session.fromPartition(partitionFor(service.id));
    const loaded = current.extensions.getAllExtensions().find(extension => extension.path === dir || extension.id === id);
    if (loaded) current.extensions.removeExtension(loaded.id);
  }
  writeJson(paths.extensions(), readJson(paths.extensions(), []).filter(path => path !== dir));
  const rules = readJson(paths.rules(), {}); delete rules[id]; writeJson(paths.rules(), rules);
  if (dir?.startsWith(paths.extensionRoot())) rmSync(dir, { recursive: true, force: true });
  return extensionList();
});
handle('extensions:popup', async marketplaceId => {
  const serviceId = activeKey?.split('#')[0];
  const dir = extensionDirs().find(path => extensionIdOf(path) === marketplaceId);
  const info = dir && readInfo(dir);
  if (!serviceId || !info?.popup) return false;
  const loaded = session.fromPartition(partitionFor(serviceId)).extensions.getAllExtensions().find(extension => extension.path === dir);
  if (!loaded) return false;
  const cursor = screen.getCursorScreenPoint();
  const popup = new BrowserWindow({ width: 380, height: 560, x: cursor.x - 360, y: cursor.y + 16, parent: mainWindow, autoHideMenuBar: true, title: info.name, webPreferences: { partition: partitionFor(serviceId), sandbox: true, contextIsolation: true } });
  popup.on('blur', () => { if (!popup.isDestroyed()) popup.close(); });
  popup.loadURL(`chrome-extension://${loaded.id}/${info.popup}`);
  return true;
});

// ---------------------------------------------------------------------------
// IPC: mail

async function scrapeMail(service) {
  const kind = serviceKind(service);
  const view = await createServiceView(service);
  const code = script(kind === 'gmail' ? pageScripts.gmailInbox : pageScripts.outlookInbox);
  const data = await run(view.webContents, code, 6000, null);
  const state = serviceState.get(service.id) || {};
  if (!data) return { serviceId: service.id, name: service.name, kind, unread: state.unread || 0, items: [], loading: true };
  let items = data.items;
  if (kind === 'outlook') items = items.map(item => ({ id: item.id, unread: item.unread, ...parseMailLines(item.lines) })).filter(item => item.from || item.subject);
  const unread = kind === 'outlook' ? (data.unread || items.filter(item => item.unread).length) : unreadFromTitle(state.title || '');
  if (kind === 'outlook' && state.domUnread !== unread) { serviceState.set(service.id, { ...state, domUnread: unread, unread }); notifyState(); }
  const now = new Date();
  return { serviceId: service.id, name: service.name, kind, account: data.account, unread, loggedOut: data.loggedOut, items: items.map(item => ({ ...item, at: chatTimeToDate(item.time, now)?.getTime() || null })) };
}

handle('mail:list', async () => {
  const mail = services().filter(service => serviceGroup(service) === 'mail');
  return { accounts: await Promise.all(mail.map(service => scrapeMail(service).catch(() => ({ serviceId: service.id, name: service.name, kind: serviceKind(service), unread: 0, items: [], error: true })))) };
});
handle('mail:open', async (serviceId, item) => {
  const service = serviceById(serviceId); if (!service) return false;
  const view = await createServiceView(service);
  if (serviceKind(service) === 'gmail') {
    const account = view.webContents.getURL().match(/\/mail\/u\/(\d+)/)?.[1] || service.url.match(/\/u\/(\d+)/)?.[1] || '0';
    if (/^[0-9a-f]{10,}$/i.test(item.id || '')) view.webContents.loadURL(`https://mail.google.com/mail/u/${account}/#inbox/${item.id}`);
    else await run(view.webContents, script(pageScripts.openGmailRow, item.rowId || ''));
  } else await run(view.webContents, script(pageScripts.openOutlookItem, item.id || ''));
  await activate(service);
  return true;
});

// ---------------------------------------------------------------------------
// IPC: unified messages

async function scrapeMessages(service) {
  const kind = serviceKind(service);
  const view = await createServiceView(service);
  await waitForLoad(view.webContents, 8000);
  const base = { serviceId: service.id, service: service.name, kind };
  if (kind === 'mattermost') {
    const data = await run(view.webContents, script(pageScripts.mattermostFeed), 15000, null);
    if (!data) return { source: { ...base, ok: false, message: 'In caricamento' }, items: [] };
    return { source: { ...base, ok: !data.loggedOut, loggedOut: data.loggedOut }, items: data.items.map(item => ({ ...base, ...item, id: `${service.id}:${item.channelId}`, time: '' })) };
  }
  const data = await run(view.webContents, script(pageScripts.chatList, kind), 6000, null);
  if (!data) return { source: { ...base, ok: false, message: 'In caricamento' }, items: [] };
  const items = data.items.map(row => ({ ...parseChatRow(row.lines), avatar: row.avatar, domUnread: row.unread })).filter(item => item.chat)
    .map(item => ({ ...base, id: `${service.id}:${item.chat}`, chat: item.chat, preview: item.preview, time: item.time, unread: item.domUnread || item.unread, avatar: item.avatar }));
  return { source: { ...base, ok: !data.loggedOut, loggedOut: data.loggedOut }, items };
}

handle('messages:list', async () => {
  const messaging = services().filter(service => serviceGroup(service) === 'message');
  const results = await Promise.all(messaging.map(service => scrapeMessages(service).catch(error => ({ source: { serviceId: service.id, service: service.name, kind: serviceKind(service), ok: false, message: error.message }, items: [] }))));
  return { sources: results.map(result => result.source), items: sortFeed(results.flatMap(result => result.items)).slice(0, 120) };
});
handle('messages:open', async (serviceId, item) => {
  const service = serviceById(serviceId); if (!service) return false;
  const view = await createServiceView(service);
  if (item.path) { const origin = new URL(view.webContents.getURL() || service.url).origin; await view.webContents.loadURL(`${origin}${item.path}`).catch(() => {}); }
  else await run(view.webContents, script(pageScripts.openChat, serviceKind(service), item.chat));
  await activate(service);
  return true;
});
handle('messages:send', async (serviceId, item, text) => {
  const service = serviceById(serviceId); const message = String(text || '').trim();
  if (!service || !message) return { ok: false, message: 'Messaggio vuoto' };
  const kind = serviceKind(service);
  const view = await createServiceView(service);
  if (kind === 'mattermost') return run(view.webContents, script(pageScripts.mattermostSend, item.channelId, message), 10000, { ok: false, message: 'Mattermost non risponde' });
  const opened = await run(view.webContents, script(pageScripts.openChat, kind, item.chat), 4000, false);
  if (!opened) return { ok: false, message: 'Chat non trovata nell’elenco' };
  await sleep(1200);
  return run(view.webContents, script(pageScripts.sendInOpenChat, kind, item.chat, message), 6000, { ok: false, message: 'Il servizio non risponde' });
});

// ---------------------------------------------------------------------------
// IPC: calendar

const calendarCache = new Map();

function googleAccountIndex(service) {
  const live = views.get(service.id)?.webContents.getURL() || '';
  return live.match(/\/u\/(\d+)/)?.[1] || service.url.match(/\/u\/(\d+)/)?.[1] || '0';
}

function readZipEntries(buffer) {
  return new Promise((resolveEntries, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const texts = [];
      zip.readEntry();
      zip.on('entry', entry => {
        if (!/\.ics$/i.test(entry.fileName)) return zip.readEntry();
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return reject(streamError);
          const chunks = []; stream.on('data', chunk => chunks.push(chunk)); stream.on('end', () => { texts.push({ name: entry.fileName, text: Buffer.concat(chunks).toString('utf8') }); zip.readEntry(); });
        });
      });
      zip.on('end', () => resolveEntries(texts));
      zip.on('error', reject);
    });
  });
}

async function googleCalendarEvents(service, from, to) {
  const account = googleAccountIndex(service);
  const serviceSession = prepareSession(service.id);
  // Google's own "export calendars" download, authenticated by the Gmail session.
  for (const url of [`https://calendar.google.com/calendar/u/${account}/exporticalzip`, `https://calendar.google.com/calendar/exporticalzip?authuser=${account}`]) {
    try {
      const response = await withTimeout(serviceSession.fetch(url, { headers: { 'user-agent': userAgent() } }), 20000, null);
      if (!response?.ok) continue;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.subarray(0, 2).toString() !== 'PK') continue;
      const files = await readZipEntries(buffer);
      const events = files.flatMap(file => expandEvents(parseICS(file.text), from, to).map(event => ({ ...event, calendar: file.name.replace(/\.ics$/i, '').replace(/_[^_]*$/, '') })));
      return { ok: true, events, method: 'export' };
    } catch (error) { log('calendar export', service.name, error.message); }
  }
  // Fallback: read the agenda page itself.
  const data = await withHiddenPage(service.id, `https://calendar.google.com/calendar/u/${account}/r/agenda`, contents => run(contents, script(pageScripts.agendaText), 8000, null), { settle: 3500 });
  if (!data) return { ok: false, events: [], message: 'Calendario non raggiungibile' };
  if (/accounts\.google\.com/.test(data.url)) return { ok: false, events: [], loggedOut: true, message: 'Accedi a Google Calendar' };
  return { ok: true, method: 'page', events: data.items.map(text => parseAgendaText(text)).filter(event => event.end > from && event.start < to) };
}

async function outlookCalendarEvents(service, from, to) {
  const base = /outlook\.office/.test(service.url) ? 'https://outlook.office.com/calendar/view/week' : 'https://outlook.live.com/calendar/0/view/week';
  const data = await withHiddenPage(service.id, base, contents => run(contents, script(pageScripts.agendaText), 8000, null), { settle: 5000 });
  if (!data) return { ok: false, events: [], message: 'Calendario non raggiungibile' };
  if (/login\./.test(data.url)) return { ok: false, events: [], loggedOut: true, message: 'Accedi a Outlook' };
  return { ok: true, method: 'page', events: data.items.map(text => parseAgendaText(text)).filter(event => event.dated && event.end > from && event.start < to) };
}

async function feedEvents(feed, from, to) {
  const response = await withTimeout(net.fetch(feed.url.replace(/^webcal:/i, 'https:')), 15000, null);
  if (!response?.ok) return { ok: false, events: [], message: response ? `HTTP ${response.status}` : 'Timeout' };
  return { ok: true, events: expandEvents(parseICS(await response.text()), from, to), method: 'ics' };
}

handle('calendar:events', async ({ days = 14, force = false } = {}) => {
  const prefs = preferences();
  const from = new Date(); from.setHours(0, 0, 0, 0); from.setDate(from.getDate() - 1);
  const to = new Date(from); to.setDate(to.getDate() + days + 1);
  const disabled = new Set(prefs.calendar?.disabled || []);
  const colors = prefs.calendar?.colors || {};
  const sources = [
    ...services().filter(service => serviceGroup(service) === 'mail').map(service => ({ id: service.id, name: service.name, type: serviceKind(service), service })),
    ...(prefs.calendar?.feeds || []).map(feed => ({ id: feed.id, name: feed.name, type: 'ics', feed }))
  ];
  const results = await Promise.all(sources.map(async source => {
    if (disabled.has(source.id)) return { ...source, enabled: false, ok: true, events: [] };
    const cached = calendarCache.get(source.id);
    if (!force && cached && Date.now() - cached.at < 15 * 60000) return { ...source, ...cached.result, enabled: true };
    let result;
    try {
      result = source.type === 'gmail' ? await googleCalendarEvents(source.service, from, to)
        : source.type === 'outlook' ? await outlookCalendarEvents(source.service, from, to)
          : await feedEvents(source.feed, from, to);
    } catch (error) { result = { ok: false, events: [], message: error.message }; }
    if (result.ok) calendarCache.set(source.id, { at: Date.now(), result });
    return { ...source, ...result, enabled: true };
  }));
  const events = results.flatMap(result => (result.events || []).map(event => ({ ...event, start: new Date(event.start).getTime(), end: new Date(event.end).getTime(), sourceId: result.id, source: result.name, color: colors[result.id] || null })))
    .sort((a, b) => a.start - b.start);
  return { events, sources: results.map(({ events: list, service, feed, ...rest }) => ({ ...rest, count: list?.length || 0 })) };
});

// ---------------------------------------------------------------------------
// IPC: music (Spotify web player, kept in a background view)

const spotifyService = () => services().find(service => serviceKind(service) === 'spotify');
async function spotifyContents() {
  const service = spotifyService();
  if (!service) return null;
  const view = await createServiceView(service);
  return view.webContents;
}
function spotifyWebUrl(uri) {
  if (/^\//.test(uri)) return `https://open.spotify.com${uri}`;
  const parts = String(uri).split(':');
  if (parts[1] === 'collection' || parts.at(-1) === 'collection') return 'https://open.spotify.com/collection/tracks';
  if (parts[1] === 'user' && parts[3] === 'playlist') return `https://open.spotify.com/playlist/${parts[4]}`;
  return `https://open.spotify.com/${parts[1]}/${parts[2]}`;
}
async function poll(contents, code, ok, attempts = 20, gap = 400) {
  for (let attempt = 0; attempt < attempts; attempt += 1) { const value = await run(contents, code, 3000, null); if (ok(value)) return value; await sleep(gap); }
  return null;
}

handle('music:state', async () => {
  const contents = await spotifyContents();
  if (!contents) return { connected: false, missing: true };
  const state = await run(contents, script(pageScripts.spotifyState), 4000, null);
  return state || { connected: true, ready: false, loading: true };
});
handle('music:control', async (action, value) => {
  const contents = await spotifyContents(); if (!contents) return false;
  return run(contents, script(pageScripts.spotifyControl, action, value ?? null), 4000, false);
});
handle('music:library', async () => {
  const contents = await spotifyContents(); if (!contents) return [];
  return (await poll(contents, script(pageScripts.spotifyLibrary), value => value?.length, 12)) || [];
});
handle('music:search', async query => {
  const contents = await spotifyContents(); if (!contents || !String(query).trim()) return [];
  await contents.loadURL(`https://open.spotify.com/search/${encodeURIComponent(String(query).trim())}/tracks`).catch(() => {});
  return (await poll(contents, script(pageScripts.spotifyTracks), value => value?.length, 25)) || [];
});
handle('music:play-track', async index => {
  const contents = await spotifyContents(); if (!contents) return false;
  return run(contents, script(pageScripts.spotifyPlayTrack, Number(index)), 4000, false);
});
handle('music:play-uri', async uri => {
  const contents = await spotifyContents(); if (!contents) return false;
  await contents.loadURL(spotifyWebUrl(uri)).catch(() => {});
  return Boolean(await poll(contents, script(pageScripts.spotifyPlayContext), Boolean, 25));
});
handle('music:open', async () => { const service = spotifyService(); if (!service) return false; return activate(service); });

// ---------------------------------------------------------------------------
// IPC: places and routes

async function locateByIp() {
  for (const provider of ['https://ipwho.is/', 'https://ipapi.co/json/']) {
    try {
      const ip = await (await withTimeout(net.fetch(provider), 5000, null))?.json();
      if (Number.isFinite(Number(ip?.latitude))) return { latitude: Number(ip.latitude), longitude: Number(ip.longitude), label: `${ip.city || 'Posizione attuale'} (approssimativa)`, approximate: true };
    } catch {}
  }
  return null;
}
const geocodeOptions = { baseUrl: NOMINATIM, fetchImpl: (url, options) => net.fetch(url, options), userAgent: 'Nuvia/0.6 (desktop dashboard; https://github.com/)' };

handle('places:suggest', async (text, city) => (String(text || '').trim().length < 4 ? [] : geocode(text, { ...geocodeOptions, cityHint: city || '' })));
handle('commute:route', async ({ origin, destination, city, mode = 'car', coordinates, originPlace, destinationPlace } = {}) => {
  let start = originPlace || null;
  let originChoices = [];
  if (!start && origin) {
    originChoices = await geocode(origin, geocodeOptions);
    if (!originChoices.length) throw new Error(`Partenza non trovata: “${origin}”`);
    start = originChoices[0];
  }
  if (!start && Number.isFinite(Number(coordinates?.latitude))) start = { latitude: Number(coordinates.latitude), longitude: Number(coordinates.longitude), label: 'Posizione attuale' };
  if (!start) start = await locateByIp();
  if (!start) throw new Error('Posizione attuale non disponibile: scrivi da dove parti');
  let end = destinationPlace || null;
  let destinationChoices = [];
  if (!end) {
    if (!String(destination || '').trim()) throw new Error('Scrivi la destinazione');
    destinationChoices = await geocode(destination, { ...geocodeOptions, cityHint: city || '' });
    if (!destinationChoices.length) throw new Error(`Destinazione non trovata: “${[destination, city].filter(Boolean).join(', ')}”`);
    end = destinationChoices[0];
  }
  const profile = MODES[mode] ? mode : 'car';
  let summary = null;
  try { summary = summarizeRoute(await (await withTimeout(net.fetch(routeUrl(ROUTING, profile, start, end)), 15000, null))?.json()); } catch (error) { log('route', error.message); }
  if (!summary && profile === 'car') {
    try { summary = summarizeRoute(await (await net.fetch(`https://router.project-osrm.org/route/v1/driving/${start.longitude},${start.latitude};${end.longitude},${end.latitude}?overview=full&geometries=geojson&steps=true`)).json()); } catch {}
  }
  if (!summary) throw new Error('Percorso non disponibile in questo momento');
  return { ...summary, mode: profile, origin: start, destination: end, originChoices: originChoices.slice(0, 4), destinationChoices: destinationChoices.slice(0, 4), arrival: Date.now() + summary.minutes * 60000 };
});

// ---------------------------------------------------------------------------
// IPC: trains, IAS, notifications, usage

handle('trains:status', async number => {
  const clean = String(number).replace(/\D/g, '');
  if (!clean) throw new Error('Inserisci il numero del treno');
  const base = 'http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno';
  const auto = await (await net.fetch(`${base}/cercaNumeroTrenoTrenoAutocomplete/${clean}`)).text();
  const token = auto.split('\n').find(line => line.includes('|'))?.split('|')[1]?.trim();
  if (!token) throw new Error('Treno non trovato');
  const [, originCode, departureTime] = token.split('-');
  const data = await (await net.fetch(`${base}/andamentoTreno/${originCode}/${clean}/${departureTime}`)).json();
  const stops = (data.fermate || []).map(stop => ({ station: stop.stazione, planned: stop.programmata || stop.partenza_teorica || stop.arrivo_teorico || null, actual: stop.effettiva || stop.partenzaReale || stop.arrivoReale || null, delay: stop.ritardo ?? 0, passed: Boolean(stop.partenzaReale || stop.arrivoReale) }));
  return { number: (data.compNumeroTreno || clean).trim(), delay: data.ritardo ?? 0, station: data.stazioneUltimoRilevamento || data.origine, origin: data.origine, destination: data.destinazione, departed: data.partito ?? null, lastSeen: data.oraUltimoRilevamento || null, stops };
});
handle('ritardometro:config', () => {
  try {
    const { ritardometroProject } = integrations();
    if (!ritardometroProject) return { ok: false, configured: false, station: '', destinations: [], maxDelay: 0 };
    const source = readFileSync(join(ritardometroProject, 'config.yaml'), 'utf8');
    const station = source.match(/^current_station:\s*(.+)$/m)?.[1]?.trim() || '';
    const block = source.match(/destinations:\s*\n((?:\s+-\s+.*\n?)+)/)?.[1] || '';
    return { ok: true, station, destinations: [...block.matchAll(/-\s+(.+)/g)].map(match => match[1].trim()), maxDelay: Number(source.match(/^max_delay_minutes:\s*(\d+)/m)?.[1] || 0) };
  } catch { return { ok: false, station: '', destinations: [], maxDelay: 0 }; }
});

function runCommand(command, args, options = {}, timeout = 90000) {
  return new Promise(resolveCommand => {
    const child = spawn(command, args, { ...options, env: process.env }); let output = ''; let settled = false; let timer;
    const finish = result => { if (settled) return; settled = true; clearTimeout(timer); resolveCommand(result); };
    child.stdout?.on('data', chunk => { output += chunk; }); child.stderr?.on('data', chunk => { output += chunk; });
    child.on('error', error => finish({ code: -1, output: error.message })); child.on('close', code => finish({ code, output }));
    timer = setTimeout(() => { child.kill('SIGTERM'); finish({ code: -1, output: 'Timeout' }); }, timeout);
  });
}
async function runIas(action, laboratory = '') {
  const bridge = app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked', 'scripts', 'ias_bridge.py') : join(import.meta.dirname, 'scripts', 'ias_bridge.py');
  const { iasProject, python } = integrations();
  if (!iasProject || !existsSync(iasProject)) return { ok: false, labs: [], message: 'Cartella del progetto IAS non impostata' };
  const result = await runCommand(python, [bridge, action, laboratory, iasProject], { cwd: iasProject });
  const line = result.output.split('\n').findLast(value => value.startsWith('NUVIA_JSON:'));
  if (!line) return { ok: false, labs: [], message: result.output.trim().split('\n').at(-1) || 'Risposta IAS non valida' };
  return JSON.parse(line.slice('NUVIA_JSON:'.length));
}
handle('ias:status', () => {
  const { iasProject } = integrations();
  const project = Boolean(iasProject && existsSync(iasProject));
  const credentials = Boolean(process.env.DEI_USER && process.env.DEI_PASSWORD);
  return { configured: project && credentials, project, credentials };
});
handle('dialog:folder', async title => {
  const result = await dialog.showOpenDialog(mainWindow, { title: title || 'Scegli una cartella', properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});
handle('app:info', () => ({ platform: process.platform, version: app.getVersion(), userData: app.getPath('userData') }));
handle('ias:labs', () => runIas('list'));
handle('ias:login', laboratory => runIas('enter', String(laboratory || '')));

handle('notifications:list', () => readJson(paths.notifications(), []));
handle('notifications:add', item => addNotification(item));
handle('notifications:remove', id => {
  const current = readJson(paths.notifications(), []);
  const next = id ? current.filter(item => item.id !== id) : [];
  writeJson(paths.notifications(), next); return next;
});
handle('notifications:read-all', () => { const next = readJson(paths.notifications(), []).map(item => ({ ...item, read: true })); writeJson(paths.notifications(), next); return next; });

let usageWorker; let usageRequest = 0; const usageWaiting = new Map();
function scanUsage() {
  if (!usageWorker) {
    usageWorker = new Worker(new URL('./lib/usage-worker.js', import.meta.url));
    usageWorker.on('message', ({ id, result, error }) => { usageWaiting.get(id)?.(error ? { error } : result); usageWaiting.delete(id); });
    usageWorker.on('error', error => { log('usage worker', error.message); for (const done of usageWaiting.values()) done({ error: error.message }); usageWaiting.clear(); usageWorker = null; });
  }
  const id = ++usageRequest;
  return withTimeout(new Promise(resolveScan => { usageWaiting.set(id, resolveScan); usageWorker.postMessage({ id, codexRoot: CODEX_HOME, claudeRoot: CLAUDE_HOME }); }), 30000, { error: 'Timeout' });
}
let claudeWeb = { at: 0, value: null, pending: null };
function claudeWebLimits(force) {
  // One hidden claude.ai page at a time: two would fight over the same profile lock.
  claudeWeb.pending ||= readClaudeWebLimits(force).finally(() => { claudeWeb.pending = null; });
  return claudeWeb.pending;
}
async function readClaudeWebLimits(force) {
  const service = services().find(item => serviceKind(item) === 'claude');
  if (!service) return { missing: true };
  if (!force && claudeWeb.value && Date.now() - claudeWeb.at < 3 * 60000) return claudeWeb.value;
  const open = views.get(service.id);
  const read = contents => run(contents, script(pageScripts.claudeLimits), 12000, null);
  let data = open && /claude\.ai/.test(open.webContents.getURL()) ? await read(open.webContents) : null;
  if (!data?.usage) data = await withHiddenPage(service.id, 'https://claude.ai/settings/usage', read, { settle: 2000 });
  const limits = normalizeClaudeLimits(data?.usage);
  const value = limits && (limits.session || limits.weekly) ? { ...limits, plan: data.plan, updatedAt: Date.now() } : { loggedOut: Boolean(data?.loggedOut), error: data?.error || (data ? 'Limiti non disponibili' : 'claude.ai non raggiungibile') };
  Object.assign(claudeWeb, { at: Date.now(), value });
  return value;
}
async function localUsage() {
  const result = await scanUsage().catch(error => ({ error: error.message }));
  if (!result.error) return result;
  // Worker threads may be unavailable (e.g. inside some asar builds): scan inline.
  try { return { codex: codexUsage({ root: CODEX_HOME }), claude: claudeUsage({ root: CLAUDE_HOME }) }; } catch (error) { return { error: error.message }; }
}
handle('ai:usage', async ({ force = false } = {}) => {
  const [local, web] = await Promise.all([localUsage(), claudeWebLimits(force).catch(error => ({ error: error.message }))]);
  const claudeService = services().find(item => serviceKind(item) === 'claude');
  const codexService = services().find(item => serviceKind(item) === 'codex');
  return { codex: { ...(local.codex || {}), serviceId: codexService?.id || null }, claude: { ...(local.claude || {}), web, serviceId: claudeService?.id || null }, error: local.error || null, at: Date.now() };
});

if (TEST) {
  handle('debug:state', () => ({ activeKey, overlayDepth, attached: Boolean(views.get(activeKey) && attached(views.get(activeKey))), views: [...views.keys()], hostBounds, uiExtensions: session.defaultSession.extensions.getAllExtensions().length }));
  handle('debug:crash-guard', () => readJson(paths.guard(), {}));
}
