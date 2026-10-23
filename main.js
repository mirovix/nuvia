import { app, BrowserWindow, WebContentsView, ipcMain, dialog, session, net, shell, Notification, Menu, screen, components, safeStorage, protocol, clipboard, nativeTheme } from 'electron';
import { join, extname, resolve, sep, dirname, delimiter, basename } from 'node:path';
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync, createWriteStream, appendFileSync, accessSync, realpathSync, constants as fsConstants } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { homedir, userInfo } from 'node:os';
import { Worker } from 'node:worker_threads';
import yauzl from 'yauzl';
import { geocode } from './lib/geocode.js';
import { routeUrl, summarizeRoute, MODES } from './lib/route.js';
import { parseICS, expandEvents, mergeConsecutive } from './lib/ics.js';
import { parseChatRow, parseMailLines, parseAgendaText, sortFeed, unreadFromTitle, chatTimeToDate } from './lib/feed.js';
import { normalizeClaudeLimits, codexUsage, claudeUsage, readClaudeCodeLimits, readClaudeCodeCache } from './lib/usage.js';
import { claudeStatusLineScript, withNuviaStatusLine } from './lib/claude-statusline.js';
import { codexHomes, findCodex, readCodexLive } from './lib/codex-live.js';
import { readInfo, defaultRules, extensionHosts, hostAllowed, contentScriptsRunOn } from './lib/extensions.js';
import { prepareExtension } from './lib/extension-shim.js';
import { askPrompt, askSystem, findClaude, mailPrompt, mailSystem, messagePrompt, messageSystem, startChat, startCodexChat } from './lib/claude-chat.js';
import { serviceKind, serviceGroup } from './lib/kinds.js';
import { chromeUserAgent, firefoxUserAgent, isGoogleSignIn } from './lib/useragent.js';
import * as pageScripts from './lib/scripts.js';
import { fillSignIn, fullUsername, isSignInUrl, looksLikeSignInForm } from './lib/autologin.js';
import { createTileSource, parseTileUrl } from './lib/tiles.js';
import { createTrafficSource, trafficLevel } from './lib/traffic.js';
import { CHECK_EVERY_MS, checkRelease, installKind, installPaths, isNewer, parseSums } from './lib/updater.js';
import { apply as applyStaged, download, prepare as prepareUpdate, removeTree } from './lib/update-install.js';

const { script } = pageScripts;
const TEST = process.env.NUVIA_TEST === '1';
const NOMINATIM = process.env.NUVIA_NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
const ROUTING = process.env.NUVIA_ROUTING_URL || 'https://routing.openstreetmap.de';
const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), '.codex');
const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const IS_MAC = process.platform === 'darwin';
const IS_WINDOWS = process.platform === 'win32';
// Optional local sources for the built-in integrations.
function integrations() {
  const saved = readJson(paths.preferences(), {}).integrations || {};
  return {
    // Legacy: a local checkout of the Ritardometro, used only to import its config.
    ritardometroProject: saved.ritardometroProject || process.env.NUVIA_RITARDOMETRO || ''
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
// Keep sign-ins alive. Chromium's DIPS ("Bounce Tracking Mitigation") deletes the
// storage of any site that writes cookies but never gets a click of its own. A
// single-sign-on domain is exactly that: login.microsoftonline.com and
// office365.com store the session while the user only ever clicks the mailbox,
// so Chromium wiped them about once a day and Outlook/Teams asked to sign in
// again. Each service already lives in its own partition, so the tracking these
// mitigations exist to stop cannot cross between services anyway.
app.commandLine.appendSwitch('disable-features', 'DIPS');
// Linux only: ECS's bundled SUID sandbox cannot be root-owned on many distros.
// (--no-zygote must come from the command line: see scripts/start.mjs and scripts/after-pack.cjs.)
if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
// Tests run without a desktop keyring: use Chromium's basic store so encryption is available.
if (TEST) app.commandLine.appendSwitch('password-store', 'basic');
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
const userAgent = () => chromeUserAgent();
// Set as the app-wide default instead of per page: a per-page override makes
// Chromium drop navigator.userAgentData and the Sec-CH-UA client hints, which
// Google treats as an embedded, "not secure" browser and refuses sign-in.
app.userAgentFallback = userAgent();
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
const withTimeout = (promise, ms, fallback) => Promise.race([promise, sleep(ms).then(() => fallback)]);

const defaultName = () => { const name = userInfo().username || ''; return name ? name[0].toUpperCase() + name.slice(1) : ''; };
function preferences() { return { theme: 'dark', accent: 'blue', background: 'plain', city: 'Roma', name: defaultName(), ...readJson(paths.preferences(), {}) }; }
function savePreferences(value) { writeJson(paths.preferences(), value); applyTimeZone(); return value; }

// Time zone picked in Settings → General (empty = the system's). The UI gets it through
// the DevTools timezone override, so every clock and date follows it at once, no restart.
const SYSTEM_TZ = process.env.TZ;
let appliedZone = null;
function validTimeZone(zone) {
  if (typeof zone !== 'string' || !zone) return '';
  try { new Intl.DateTimeFormat('en-GB', { timeZone: zone }); return zone; } catch { return ''; }
}
function applyTimeZone() {
  const zone = validTimeZone(readJson(paths.preferences(), {}).timeZone);
  if (!mainWindow || mainWindow.isDestroyed() || zone === appliedZone) return;
  appliedZone = zone;
  // The main process formats times too (notifications, train alerts).
  if (zone) process.env.TZ = zone; else if (SYSTEM_TZ === undefined) delete process.env.TZ; else process.env.TZ = SYSTEM_TZ;
  const tools = mainWindow.webContents.debugger;
  try {
    if (!tools.isAttached()) tools.attach('1.3');
    tools.sendCommand('Emulation.setTimezoneOverride', { timezoneId: zone }).catch(error => log('timezone', error.message));
  } catch (error) { log('timezone', error.message); }
}

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
// Only service pages are ever added to the window: whatever else is attached
// goes, so a page can never stay on top of the overview or another service.
function detachOthers(keep) { for (const child of [...mainWindow.contentView.children]) if (child !== keep) mainWindow.contentView.removeChildView(child); }
function showActive() {
  const view = views.get(activeKey);
  if (!view || overlayDepth > 0) return;
  detachOthers(view);
  if (!attached(view)) mainWindow.contentView.addChildView(view);
  view.setBounds(hostBounds);
}
let activation = 0; // the latest service asked for: an older one still opening is not shown
function showDashboard() { activation++; detachOthers(null); activeKey = null; }

const sessionsPrepared = new Set();
function prepareSession(serviceId) {
  const serviceSession = session.fromPartition(partitionFor(serviceId));
  if (sessionsPrepared.has(serviceId)) return serviceSession;
  sessionsPrepared.add(serviceId);
  const allowed = new Set(['notifications', 'media', 'display-capture', 'fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'speaker-selection', 'storage-access', 'top-level-storage-access']);
  // 'openExternal' is refused on purpose: open.spotify.com would otherwise launch the Spotify desktop app.
  serviceSession.setPermissionRequestHandler((_, permission, callback) => callback(allowed.has(permission)));
  serviceSession.setPermissionCheckHandler((_, permission) => allowed.has(permission));
  googleSignInHeaders(serviceSession);
  if (TEST && process.env.NUVIA_FIXTURES) serveFixtures(serviceSession);
  return serviceSession;
}

// Google sign-in compatibility. Google refuses sign-in from embedded Chromium
// but accepts Firefox, so a tab navigating Google's account pages presents
// itself as Firefox for the whole flow (page UA and the tab's own requests,
// client hints removed). Requests that other pages make to accounts.google.com
// in the background (Gmail rotating its cookies) keep the Chrome identity:
// Google signs out a session whose cookies appear from two browsers.
// Can be turned off in Settings.
const googleCompat = () => readJson(paths.preferences(), {}).googleSignInCompat !== false;

function googleSignInHeaders(serviceSession) {
  serviceSession.webRequest.onBeforeSendHeaders({ urls: ['https://accounts.google.com/*'] }, (details, callback) => {
    const contents = details.webContents;
    const firefoxTab = contents && !contents.isDestroyed() && contents.getUserAgent() === firefoxUserAgent();
    if (!googleCompat() || !firefoxTab) return callback({});
    const headers = { ...details.requestHeaders, 'User-Agent': firefoxUserAgent() };
    for (const name of Object.keys(headers)) if (/^sec-ch-ua/i.test(name)) delete headers[name];
    callback({ requestHeaders: headers });
  });
}

function followGoogleSignIn(contents) {
  const wanted = url => (googleCompat() && isGoogleSignIn(url) ? firefoxUserAgent() : userAgent());
  const needsSwitch = url => {
    const current = contents.getUserAgent();
    const want = wanted(url);
    return (want === firefoxUserAgent()) !== (current === firefoxUserAgent()) ? want : null;
  };
  // Switch when a navigation starts (before its request is sent)…
  contents.on('did-start-navigation', (event, url, isInPlace, isMainFrame) => {
    const target = event?.url ?? url;
    if (!(event?.isMainFrame ?? isMainFrame) || (event?.isSameDocument ?? isInPlace) || contents.isDestroyed()) return;
    const want = needsSwitch(target);
    if (want) contents.setUserAgent(want);
  });
  // …but never in the middle of a redirect chain (Chromium stalls on a blank
  // page): cancel that redirect and start a fresh navigation with the right identity.
  contents.on('will-redirect', (event, url, isInPlace, isMainFrame) => {
    const target = event?.url ?? url;
    if ((event?.isMainFrame ?? isMainFrame) === false || contents.isDestroyed()) return;
    const want = needsSwitch(target);
    if (!want) return;
    event.preventDefault();
    contents.setUserAgent(want);
    setImmediate(() => { if (!contents.isDestroyed()) contents.loadURL(target).catch(() => {}); });
  });
  contents.on('did-create-window', child => followGoogleSignIn(child.webContents));
}

// Tests only: answer https requests of known hosts with local fixture pages.
let fixtureFailures = 0;
function serveFixtures(serviceSession) {
  const root = process.env.NUVIA_FIXTURES;
  serviceSession.protocol.handle('https', request => {
    const url = new URL(request.url);
    // A network that is not up yet: the first two loads of this host fail.
    if (url.hostname === 'flaky.nuvia.test' && fixtureFailures++ < 2) return Response.error();
    // A frame that never finishes loading (an extension's, say).
    if (url.hostname === 'hang.nuvia.test' && url.pathname === '/stream') return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('<!doctype html><p>')); } }), { headers: { 'content-type': 'text/html' } });
    if (url.hostname === 'hang.nuvia.test') return new Promise(() => {});
    // Like Google's calendar export for some accounts: it works from a page of
    // the site, and fails as net::ERR_FAILED from Nuvia's main process.
    const zip = join(root, `${url.hostname}${url.pathname.replace(/\//g, '_')}.zip`);
    if (existsSync(zip)) return request.referrer ? new Response(readFileSync(zip), { headers: { 'content-type': 'application/zip' } }) : Response.error();
    const json = join(root, `${url.hostname}${url.pathname.replace(/\//g, '_')}.json`);
    if (existsSync(json)) return new Response(readFileSync(json), { headers: { 'content-type': 'application/json' } });
    const html = join(root, `${url.hostname}.html`);
    if (existsSync(html)) return new Response(readFileSync(html), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    return net.fetch(request, { bypassCustomProtocolHandlers: true });
  });
}

const AUTH_HOSTS =/(^|\.)(accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|login\.microsoft\.com|account\.microsoft\.com|office\.com|officeapps\.live\.com|microsoft365\.com|teams\.microsoft\.com|teams\.live\.com|teams\.cloud\.microsoft|teams\.microsoft365\.com|teams\.office\.com|teams\.skype\.com|skypeforbusiness\.com|sfbassets\.com|appleid\.apple\.com|accounts\.spotify\.com|github\.com|slack\.com|notion\.so|claude\.ai|auth\.openai\.com|chatgpt\.com)$/;
const MICROSOFT_SERVICE = /(^|\.)(microsoft\.com|microsoftonline\.com|microsoft365\.com|office\.com|officeapps\.live\.com|live\.com|cloud\.microsoft|teams\.skype\.com|skypeforbusiness\.com|sfbassets\.com)$/;
function sameSite(a, b) {
  try { const root = host => new URL(host).hostname.split('.').slice(-2).join('.'); return root(a) === root(b); } catch { return false; }
}
function sameServiceFamily(target, source) {
  try {
    const targetHost = new URL(target).hostname; const sourceHost = new URL(source).hostname;
    return MICROSOFT_SERVICE.test(targetHost) && MICROSOFT_SERVICE.test(sourceHost);
  } catch { return false; }
}

const realpathOr = path => { try { return realpathSync(path); } catch { return path; } };

// Links that leave the service go to the system browser (tests only log them).
const openOutside = url => (TEST ? log('external', url) : shell.openExternal(url));

// Extensions that sign in through a window and keep the session only in memory:
// after a restart they ask again. Streak does ("Accedi per usare Streak"). Once
// the user has connected it in a service, Nuvia clicks its sign-in button again
// after a restart, with the window hidden: it completes by itself (Google's
// account choice, the saved UniPD sign-in) and is shown only if it needs you.
const RECONNECT = [{
  id: 'pnnfemgpilpdaojpnkjdgfgbnnjojfik', name: 'Streak',
  prompt: /Accedi per usare Streak|Sign in to use Streak/i,
  button: /^(Accedi con Google|Sign in with Google)$/i,
  done: /(^|\.)streak\.com$/i
}];
const reconnectFile = () => fileInProfile('extension-sessions.json');
const quietWindows = new Map(); // service id → until when its sign-in window stays hidden
const windowProgress = new WeakMap(); // hidden sign-in window → when it last moved on
const revealWindow = new WeakMap(); // hidden sign-in window → shows it
const reconnectTries = new Map();
const reconnectClicked = new Map(); // service:extension → when its sign-in button was last clicked
function markConnected(service, host) {
  const entry = RECONNECT.find(item => item.done.test(host));
  if (!entry) return;
  const saved = readJson(reconnectFile(), {});
  (saved[service.id] ||= {})[entry.id] = Date.now();
  writeJson(reconnectFile(), saved);
}
function reconnectScript(prompt, button) {
  const all = [];
  const walk = root => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot); } };
  walk(document);
  const shown = el => { const box = el.getBoundingClientRect(); return box.width > 0 && box.height > 0; };
  if (!all.some(el => shown(el) && new RegExp(prompt, 'i').test(el.textContent || '') && (el.textContent || '').length < 400)) return 'connected';
  const target = all.filter(el => (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') && shown(el) && new RegExp(button, 'i').test((el.textContent || '').trim())).sort((a, b) => a.textContent.length - b.textContent.length)[0];
  if (!target) return 'no button';
  target.click();
  return 'clicked';
}
async function reconnectExtensions(service, contents, current = () => true) {
  const saved = readJson(reconnectFile(), {})[service.id] || {};
  for (const entry of RECONNECT) {
    if (!saved[entry.id] || contents.isDestroyed()) continue;
    const dir = extensionDirs().find(item => extensionIdOf(item) === entry.id);
    if (!dir || rulesFor(dir)[service.id] !== true) continue;
    // Never a loop: a sign-in that did not take (the prompt still there a minute
    // later) counts as failed; after 3 failures in 10 minutes Nuvia stops trying.
    const key = `${service.id}:${entry.id}`;
    const failed = (reconnectTries.get(key) || []).filter(at => Date.now() - at < 10 * 60000);
    reconnectTries.set(key, failed);
    if (failed.length >= 3) continue;
    // The extension draws its prompt a few seconds after the page.
    for (let attempt = 0; attempt < 8; attempt++) {
      await sleep(3000);
      // A newer page load (Gmail redirects a few times) has its own check: one at a time.
      if (contents.isDestroyed() || !current()) return;
      // One sign-in window at a time: two would race through Google.
      if (Date.now() - (reconnectClicked.get(key) || 0) < 45000) return;
      quietWindows.set(service.id, Date.now() + 20000);
      const result = await run(contents, `(${reconnectScript.toString()})(${JSON.stringify(entry.prompt.source)}, ${JSON.stringify(entry.button.source)})`, 4000, 'error');
      if (result === 'clicked') {
        reconnectClicked.set(key, Date.now());
        log('reconnect', service.name, entry.name, 'signing in again');
        setTimeout(async () => {
          if (contents.isDestroyed()) return;
          const after = await run(contents, `(${reconnectScript.toString()})(${JSON.stringify(entry.prompt.source)}, '^$')`, 4000, 'error');
          if (after !== 'connected') { failed.push(Date.now()); log('reconnect', service.name, entry.name, 'did not take'); }
        }, 60000);
        break;
      }
      if (result === 'connected' && attempt >= 3) { quietWindows.delete(service.id); break; }
    }
  }
}

// Every extension load goes through here: the shim must be in place first.
function loadExtensionInto(target, dir) {
  try { prepareExtension(dir); } catch (error) { log('extension shim', dir, error.message); }
  return target.extensions.loadExtension(dir, { allowFileAccess: true });
}

// An extension turned on for this service may open its own sign-in window
// (Streak: streak.com, mailfoogae.appspot.com): keep it in the service's profile.
function extensionWindowHost(service, host) {
  for (const dir of extensionDirs()) {
    if (rulesFor(dir)[service.id] !== true) continue;
    const manifest = readJson(join(dir, 'manifest.json'), {});
    if (hostAllowed(host, extensionHosts(manifest))) return true;
  }
  return false;
}

function wireContents(contents, service, key) {
  // Sign-in windows a service opens (Streak's Google sign-in going through the
  // UniPD SSO) get the automatic sign-in too, with their own state.
  contents.on('did-create-window', child => {
    const popup = child.webContents;
    const stateKey = `${service.id}#window`;
    // A sign-in that ends on the extension's own site: remember it is connected.
    popup.on('did-navigate', (_, url) => markConnected(service, hostOf(url)));
    // Opened hidden by an automatic reconnection: it stays hidden while the
    // sign-in moves on by itself, and shows only when it needs you (a second
    // factor, a refused password) or stops moving.
    if (!child.isVisible()) {
      quietWindows.delete(service.id);
      // Done (or closed): the next reload may reconnect again straight away.
      child.on('closed', () => { for (const entry of RECONNECT) reconnectClicked.delete(`${service.id}:${entry.id}`); });
      const opened = Date.now();
      windowProgress.set(popup, opened);
      const reveal = () => {
        if (child.isDestroyed() || child.isVisible()) return;
        clearInterval(timer);
        log('reconnect', service.name, 'sign-in window shown', hostOf(popup.getURL()), pathOf(popup.getURL()));
        child.show();
        addNotification({ title: service.name, body: 'Streak needs you to finish signing in: the window is open.', type: 'warning', serviceId: service.id });
      };
      revealWindow.set(popup, reveal);
      const timer = setInterval(() => {
        if (child.isDestroyed()) return clearInterval(timer);
        if (Date.now() - windowProgress.get(popup) > 25000 || Date.now() - opened > 120000) reveal();
      }, 2500);
      popup.on('did-navigate', () => windowProgress.set(popup, Date.now()));
      popup.on('did-navigate-in-page', () => windowProgress.set(popup, Date.now()));
    }
    popup.on('context-menu', (_, params) => contextMenu(popup, params, null));
    popup.on('did-stop-loading', () => watchSignIn(service, popup, stateKey));
    popup.on('did-navigate-in-page', (_, url, isMainFrame) => { if (isMainFrame !== false && isSignInUrl(url)) setTimeout(() => watchSignIn(service, popup, stateKey), 600); });
  });
  followGoogleSignIn(contents);
  contents.on('context-menu', (_, params) => contextMenu(contents, params, service));
  contents.setWindowOpenHandler(({ url }) => {
    if (!/^https?:|^about:blank/i.test(url)) return { action: 'deny' };
    let host = ''; try { host = new URL(url).hostname; } catch {}
    if (url.startsWith('about:blank') || AUTH_HOSTS.test(host) || sameSite(url, service.url) || sameServiceFamily(url, service.url) || extensionWindowHost(service, host)) {
      const quiet = (quietWindows.get(service.id) || 0) > Date.now();
      return { action: 'allow', overrideBrowserWindowOptions: { show: !quiet, width: 560, height: 760, autoHideMenuBar: true, backgroundColor: '#ffffff', webPreferences: { partition: partitionFor(service.id), preload: join(import.meta.dirname, 'preload-service.cjs'), sandbox: true, contextIsolation: true } } };
    }
    openOutside(url);
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

// Whether the page itself is loading. Electron's isLoading() and even
// isLoadingMainFrame() stay true while any frame in it loads, so it is followed
// here: a new page starts loading, and it is done when it has loaded (its load
// event), failed or stopped.
const mainLoading = new WeakMap();
const pageLoading = contents => mainLoading.get(contents) ?? contents.isLoading();
function trackPageLoading(contents, changed = () => {}) {
  const set = value => { if (mainLoading.get(contents) === value) return; mainLoading.set(contents, value); changed(); };
  contents.on('did-start-navigation', details => { if (details.isMainFrame && !details.isSameDocument) set(true); });
  contents.on('did-finish-load', () => set(false));
  contents.on('did-fail-load', (_, code, description, url, isMainFrame) => { if (isMainFrame && code !== -3) set(false); });
  contents.on('did-stop-loading', () => set(false));
}

// At startup every service opens at once, and a page can start before Chromium
// has registered an extension's scripts with it: it then runs without them until
// reloaded (Streak missing from two of three Gmail accounts). Each extension's
// scripts mark the page (lib/extension-shim.js); once the page has loaded, one
// whose mark is missing gets the page reloaded, once in ten minutes at most.
const scriptReloadAt = new WeakMap();
async function checkExtensionScripts(service, contents) {
  if (contents.isDestroyed()) return;
  const url = contents.getURL();
  const expected = session.fromPartition(partitionFor(service.id)).extensions.getAllExtensions().filter(extension => contentScriptsRunOn(extension.manifest, url));
  if (!expected.length) return;
  const present = String(await run(contents, `document.documentElement?.getAttribute('data-nuvia-extensions') || ''`, 3000, '') || '').split(' ');
  const missing = expected.filter(extension => !present.includes(extension.id));
  if (!missing.length || contents.isDestroyed()) return;
  const names = missing.map(extension => extension.name).join(', ');
  if (Date.now() - (scriptReloadAt.get(contents) || 0) < 10 * 60000) { log('extensions', service.name, `${names} still missing after a reload`); return; }
  scriptReloadAt.set(contents, Date.now());
  log('extensions', service.name, `${names} did not reach the page: reloading it once`);
  contents.reload();
}

function trackState(view, service) {
  const contents = view.webContents;
  const update = extra => {
    const previous = serviceState.get(service.id) || {};
    const title = contents.isDestroyed() ? previous.title : (contents.getTitle() || service.name);
    serviceState.set(service.id, {
      ...previous, id: service.id, name: service.name, kind: serviceKind(service),
      url: contents.isDestroyed() ? previous.url : (contents.getURL() || service.url), title,
      // The page itself, not every frame in it: an extension's hidden frame that
      // never finishes (Streak in Gmail) kept the bar running on a loaded page.
      loading: !contents.isDestroyed() && pageLoading(contents),
      canGoBack: !contents.isDestroyed() && contents.navigationHistory.canGoBack(),
      canGoForward: !contents.isDestroyed() && contents.navigationHistory.canGoForward(),
      unread: previous.domUnread ?? unreadFromTitle(title), ...extra
    });
    notifyState();
  };
  contents.on('page-title-updated', () => update());
  contents.on('did-start-loading', () => update({ crashed: false }));
  trackPageLoading(contents, update);
  contents.on('did-finish-load', () => setTimeout(() => checkExtensionScripts(service, contents).catch(error => log('extensions', service.name, error.message)), 2500));
  // Every page load (a reload too) checks once whether an extension asks to sign in again.
  let reconnectStarted = false; let reconnectRun = 0;
  contents.on('did-navigate', () => { reconnectStarted = false; reconnectRun++; });
  contents.on('did-stop-loading', () => {
    update(); watchSignIn(service, contents);
    if (!reconnectStarted && !isSignInUrl(contents.getURL())) { reconnectStarted = true; const run = reconnectRun; reconnectExtensions(service, contents, () => run === reconnectRun).catch(error => log('reconnect', service.name, error.message)); }
  });
  contents.on('did-navigate-in-page', (_, url, isMainFrame) => { if (isMainFrame !== false && isSignInUrl(url)) setTimeout(() => watchSignIn(service, contents), 600); });
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

// Opening a service and the overview reading its mail used to ask at the same
// moment: both found no page yet and each made one, so a second, hidden Gmail
// ran next to the one on screen (twice the memory, two Streak sign-ins racing).
const creatingViews = new Map(); // key → the page being made
const madeViews = []; // tests: every page made, by key
function createServiceView(service, key = service.id, url = service.url) {
  if (views.has(key) && !views.get(key).webContents.isDestroyed()) return Promise.resolve(views.get(key));
  if (!creatingViews.has(key)) creatingViews.set(key, makeServiceView(service, key, url).finally(() => creatingViews.delete(key)));
  return creatingViews.get(key);
}
async function makeServiceView(service, key, url) {
  madeViews.push(key);
  const serviceSession = prepareSession(service.id);
  await restoreSessionCookies(service.id);
  await loadExtensionsFor(serviceSession, service);
  const view = new WebContentsView({ webPreferences: { partition: partitionFor(service.id), preload: join(import.meta.dirname, 'preload-service.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: serviceKind(service) !== 'spotify' } });
  view.setBackgroundColor('#ffffff');
  // Background views still need a real viewport: at 0x0 lazy lists (agenda, chats) render nothing.
  view.setBounds(hostBounds);
  wireContents(view.webContents, service, key);
  if (key === service.id) trackState(view, service);
  view.webContents.once('did-finish-load', () => releaseGuard(service.id));
  retryFailedLoads(view, service, url);
  view.webContents.loadURL(url).catch(error => log('load', service.name, error.message));
  views.set(key, view);
  return view;
}

// A page that failed to load (no network yet at startup, Wi-Fi dropping) used to
// stay blank until reloaded by hand. Nuvia now tries again by itself: after 2 s,
// 5 s, 15 s, 30 s, then every minute, and at once when the service is opened.
const RETRY_DELAYS = [2000, 5000, 15000, 30000, 60000];
const failedLoads = new Map(); // webContents id → retry now
function retryFailedLoads(view, service, firstUrl) {
  const contents = view.webContents;
  let attempt = 0; let timer = null;
  contents.on('did-fail-load', (_, code, description, failedUrl, isMainFrame) => {
    // -3 is a navigation the page or the user cancelled, not a failure.
    if (!isMainFrame || code === -3 || contents.isDestroyed()) return;
    const target = failedUrl || contents.getURL() || firstUrl;
    const delay = RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)];
    attempt += 1;
    log('load', service.name, `${description} (${code}), trying again in ${delay / 1000} s`);
    clearTimeout(timer);
    const retry = () => { clearTimeout(timer); failedLoads.delete(contents.id); if (!contents.isDestroyed()) contents.loadURL(target).catch(() => {}); };
    failedLoads.set(contents.id, retry);
    timer = setTimeout(retry, delay);
  });
  // Not did-finish-load: Chromium also "finishes" loading its own error page.
  contents.on('did-navigate', (_, url, httpResponseCode) => {
    if (httpResponseCode > 0) { attempt = 0; clearTimeout(timer); failedLoads.delete(contents.id); }
  });
  contents.once('destroyed', () => { clearTimeout(timer); failedLoads.delete(contents.id); });
}

let lastServiceId = null; // the last service shown, for menus opened from elsewhere
async function activate(service, { key = service.id, url } = {}) {
  lastServiceId = service.id;
  const ticket = ++activation;
  const view = await createServiceView(service, key, url || service.url);
  failedLoads.get(view.webContents.id)?.(); // opened while its page had failed: try again now
  if (url && views.get(key) === view && view.webContents.getURL() && view.webContents.getURL() !== url) await view.webContents.loadURL(url).catch(() => {});
  // Opening takes a moment (cookies, extensions): if you went elsewhere meanwhile, stay there.
  if (ticket !== activation) return false;
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
  await restoreSessionCookies(serviceId);
  const window = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { partition: partitionFor(serviceId), sandbox: true, contextIsolation: true, backgroundThrottling: false } });
  window.webContents.setAudioMuted(true);
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
  // webContents.executeJavaScript first waits for isLoadingMainFrame() to turn
  // false, which never happens while any frame keeps loading (an extension's,
  // in Gmail): every read timed out. The page's own frame runs it at once.
  const frame = contents.getURL() ? contents.mainFrame : null;
  try { return await withTimeout(frame ? frame.executeJavaScript(code, true) : contents.executeJavaScript(code, true), ms, fallback); } catch (error) { log('script', error.message); return fallback; }
}

function waitForLoad(contents, ms = 12000) {
  // The page itself: a frame that never finishes must not hold every read for 12 s.
  if (!pageLoading(contents)) return Promise.resolve();
  // Whichever comes first: the page's load (a frame may never finish), or
  // loading stopping (a form answered without a new page fires no load).
  return withTimeout(new Promise(resolveWait => { contents.once('did-finish-load', resolveWait); contents.once('did-stop-loading', resolveWait); }), ms);
}

// ---------------------------------------------------------------------------
// Staying signed in
//
// 1. Session cookies (no expiry, e.g. a university SSO) are dropped by
//    Chromium on every restart. Like Chrome's "continue where you left off",
//    Nuvia keeps them across restarts, encrypted with the OS keychain.
// 2. Services can opt in to automatic sign-in: when the session expires and
//    the page lands on a sign-in step, Nuvia fills the saved credentials.

const cookieFile = id => fileInProfile(`session-cookies-${String(id).replace(/[^a-z0-9_-]/gi, '')}.bin`);
const signInFile = id => fileInProfile(`signin-${String(id).replace(/[^a-z0-9_-]/gi, '')}.bin`);
const cookiesRestored = new Set();

async function saveSessionCookies(serviceId) {
  if (!safeStorage.isEncryptionAvailable()) return;
  const cookies = (await session.fromPartition(partitionFor(serviceId)).cookies.get({})).filter(cookie => cookie.session);
  if (!cookies.length) return rmSync(cookieFile(serviceId), { force: true });
  writeFileSync(cookieFile(serviceId), safeStorage.encryptString(JSON.stringify(cookies.map(({ name, value, domain, hostOnly, path: cookiePath, secure, httpOnly, sameSite }) => ({ name, value, domain, hostOnly, path: cookiePath, secure, httpOnly, sameSite })))), { mode: 0o600 });
}
async function saveAllSessionCookies() {
  for (const id of sessionsPrepared) if (id !== 'ias') { try { await saveSessionCookies(id); } catch (error) { log('cookies save', error.message); } }
}
async function restoreSessionCookies(serviceId) {
  if (cookiesRestored.has(serviceId)) return;
  cookiesRestored.add(serviceId);
  if (!existsSync(cookieFile(serviceId)) || !safeStorage.isEncryptionAvailable()) return;
  let cookies = [];
  try { cookies = JSON.parse(safeStorage.decryptString(readFileSync(cookieFile(serviceId)))); } catch { return; }
  const jar = session.fromPartition(partitionFor(serviceId)).cookies;
  for (const cookie of cookies) {
    const host = String(cookie.domain || '').replace(/^\./, '');
    const details = { url: `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`, name: cookie.name, value: cookie.value, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly };
    if (!cookie.hostOnly) details.domain = cookie.domain;
    if (cookie.sameSite && cookie.sameSite !== 'unspecified') details.sameSite = cookie.sameSite;
    try { await jar.set(details); } catch {}
  }
}

function signInCredentials(serviceId) {
  try { return existsSync(signInFile(serviceId)) ? JSON.parse(safeStorage.decryptString(readFileSync(signInFile(serviceId)))) : null; } catch { return null; }
}

const signInState = new Map();
const hostOf = url => { try { return new URL(url).hostname; } catch { return ''; } };
// The page, without the query: enough to see which sign-in step it is (/signin/oauth/id).
const pathOf = url => { try { return new URL(url).pathname.slice(0, 60); } catch { return ''; } };
// A sign-in page by its address, or (for a service with a saved sign-in) by its form.
async function onSignInPage(service, contents) {
  if (contents.isDestroyed()) return false;
  if (isSignInUrl(contents.getURL())) return true;
  if (!signInCredentials(service.id)) return false;
  return Boolean(await run(contents, `(${looksLikeSignInForm.toString()})()`, 3000, false));
}

async function watchSignIn(service, contents, stateKey = service.id) {
  if (contents.isDestroyed()) return;
  const url = contents.getURL();
  const state = signInState.get(stateKey) || { attempts: [], passwords: [], inFlow: false, noticeAt: 0, mfaAt: 0, failedAt: 0, signedIn: false };
  signInState.set(stateKey, state);
  if (!(await onSignInPage(service, contents))) {
    if (state.inFlow) log('sign-in', service.name, state.auto ? 'signed back in automatically' : 'left the sign-in page', hostOf(url));
    if (state.inFlow && state.auto) addNotification({ title: service.name, body: 'Signed back in automatically.', type: 'success', serviceId: service.id });
    Object.assign(state, { inFlow: false, auto: false, signedIn: true, inFlowLogged: false, looks: 0, lastLogged: '' });
    state.passwords.splice(0);
    return;
  }
  state.inFlow = true;
  const credentials = signInCredentials(service.id);
  if (!state.inFlowLogged) { state.inFlowLogged = true; log('sign-in', service.name, 'session expired, sign-in page', hostOf(url), credentials ? 'credentials saved' : 'no credentials'); }
  if (!credentials) {
    // Only warn about services that were signed in before, at most every 2 hours.
    if (state.signedIn && Date.now() - state.noticeAt > 2 * 3600000) {
      state.noticeAt = Date.now();
      addNotification({ title: service.name, body: 'Your session expired. Open the service and sign in once: Nuvia will remember it and reconnect automatically next time.', type: 'warning', serviceId: service.id });
    }
    return;
  }
  state.attempts = state.attempts.filter(at => Date.now() - at < 5 * 60000);
  if (state.attempts.length >= 14) return; // never loop on a failing sign-in
  // A password that was not accepted twice is wrong (changed, expired): stop
  // before the university locks the account, and say so.
  if (state.passwords.length >= 2) {
    if (Date.now() - state.failedAt > 2 * 3600000) {
      state.failedAt = Date.now();
      log('sign-in', service.name, hostOf(url), 'saved password refused, stopped');
      revealWindow.get(contents)?.();
      addNotification({ title: service.name, body: `Nuvia could not sign in automatically: the saved password for ${credentials.username} was not accepted. Open the service and sign in once by hand to update it.`, type: 'warning', serviceId: service.id });
    }
    return;
  }
  // One fill at a time: the page finishing to load and the follow-up check can
  // both fire, and two fills would submit the password twice.
  if (state.busy) { state.again = true; return; }
  state.attempts.push(Date.now());
  state.busy = true;
  let action;
  try {
    await sleep(900);
    // A reconnection window may confirm "Continue" to an app already connected once (Streak).
    const options = { confirmApp: windowProgress.has(contents) };
    action = await run(contents, `(${fillSignIn.toString()})(${JSON.stringify(credentials.username)}, ${JSON.stringify(credentials.password)}, ${JSON.stringify(options)})`, 5000, 'none');
  } finally { state.busy = false; }
  if (state.again) { state.again = false; if (action === 'none') setTimeout(() => { if (!contents.isDestroyed()) watchSignIn(service, contents, stateKey); }, 600); }
  // Which site and which step, never what was typed: enough to see where a sign-in stops.
  const step = [hostOf(url), stateKey === service.id ? '' : pathOf(url), action].filter(Boolean).join(' ');
  if (action !== 'none' || step !== state.lastLogged) log('sign-in', service.name + (stateKey === service.id ? '' : ' (window)'), step);
  state.lastLogged = step;
  if (action !== 'none') { state.auto = true; windowProgress.has(contents) && windowProgress.set(contents, Date.now()); }
  if (action === 'none') {
    // Nothing to do yet is not an attempt. Google draws its account choice
    // after the page has loaded, with no event to wait for: a sign-in window
    // looks again every 1.5 s for a minute.
    state.attempts.pop();
    if (stateKey !== service.id && (state.looks = (state.looks || 0) + 1) <= 40) setTimeout(async () => { if (await onSignInPage(service, contents)) watchSignIn(service, contents, stateKey); }, 1500);
  }
  if (action === 'mfa') revealWindow.get(contents)?.();
  if (action === 'password') state.passwords.push(Date.now());
  // Multi-step pages (email, then password) change without a reload: look again.
  if (['account', 'username', 'password', 'continue'].includes(action)) setTimeout(async () => { if (await onSignInPage(service, contents)) watchSignIn(service, contents, stateKey); }, 2500);
  if (action === 'mfa' && Date.now() - state.mfaAt > 30 * 60000) {
    state.mfaAt = Date.now();
    addNotification({ title: service.name, body: 'Sign-in needs your second factor (code or approval). Open the service to finish.', type: 'warning', serviceId: service.id });
  }
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
  addNotification({ title: 'Extension disabled', body: `${names} ${reason} on ${service?.name || 'a service'}. You can turn it back on in Extensions.`, type: 'warning' });
}

function recoverFromCrash() {
  const guard = readJson(paths.guard(), {});
  let crashes = 0;
  if (guard.running) {
    crashes = (guard.crashes || 0) + 1;
    const pending = Object.entries(guard.pending || {}).filter(([, ids]) => ids.length);
    for (const [serviceId, ids] of pending) quarantine(serviceId, ids, 'crashed Nuvia while loading');
    if (!pending.length && crashes >= 2) {
      for (const [serviceId, ids] of Object.entries(guard.loaded || {})) quarantine(serviceId, ids, 'was active during two unexpected shutdowns');
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
  quarantine(service.id, loaded, 'made the page crash repeatedly');
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
    try { await loadExtensionInto(serviceSession, dir); }
    catch (error) { log('extension', dir, error.message); }
  }
  // loadExtension() resolves a moment before Chromium has registered the
  // extension's content scripts with the page processes: a page started right
  // away (the first service at startup) came up without them (Streak missing
  // in Gmail until a reload). Give the registration a moment.
  await sleep(600);
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
  if (!response.ok) throw new Error(`Chrome Web Store unavailable (${response.status})`);
  const html = await response.text();
  const starts = [...html.matchAll(/data-item-id="([a-p]{32})"/g)];
  return starts.slice(0, 16).map((match, index) => {
    const block = html.slice(match.index, starts[index + 1]?.index ?? match.index + 7000);
    const name = block.match(/<h2[^>]*>([^<]+)<\/h2>/)?.[1] || 'Chrome extension';
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
  throw new Error(`Could not connect to the Chrome Web Store: ${lastError?.message || 'network unavailable'}`);
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
        if (!`${target}${entry.fileName.endsWith('/') ? sep : ''}`.startsWith(root) || mode === 0o120000) return fail(new Error('Unsafe extension archive'));
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
  if (!/^[a-p]{32}$/.test(id)) throw new Error('Invalid extension ID');
  const url = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${process.versions.chrome.split('.')[0]}.0&acceptformat=crx2,crx3&x=id%3D${id}%26installsource%3Dondemand%26uc`;
  const crx = Buffer.from(await (await fetchWithRetry(url, { headers: { 'user-agent': userAgent() } })).arrayBuffer());
  if (crx.subarray(0, 4).toString() !== 'Cr24') throw new Error('The Web Store did not return a CRX package');
  const version = crx.readUInt32LE(4);
  let offset;
  if (version === 3) offset = 12 + crx.readUInt32LE(8);
  else if (version === 2) offset = 16 + crx.readUInt32LE(8) + crx.readUInt32LE(12);
  else throw new Error(`Unsupported CRX format ${version}`);
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
  if (!info) { rmSync(dir, { recursive: true, force: true }); throw new Error('Package has no valid manifest'); }
  writeJson(paths.extensions(), [...new Set([...readJson(paths.extensions(), []), dir])]);
  const rules = readJson(paths.rules(), {});
  rules[id] = { ...defaultRules(info, services()), ...(rules[id] || {}) };
  writeJson(paths.rules(), rules);
  // Load only into services that are already open; the rest pick it up when opened.
  for (const service of services()) {
    if (rules[id][service.id] === false || !sessionsPrepared.has(service.id)) continue;
    setGuard(service.id, [id]);
    try { await queued(() => loadExtensionInto(session.fromPartition(partitionFor(service.id)), dir)); } catch (error) { log('extension', id, error.message); }
    releaseGuard(service.id);
  }
  const enabledOn = services().filter(service => rules[id][service.id] !== false).map(service => service.name);
  return { id, name: info.name, version: info.version, enabledOn };
}

// ---------------------------------------------------------------------------
// Notifications

// The desktop pop-ups still on screen, so they go away with the notification.
const nativeNotifications = new Map();
// The overview card each kind of notification belongs to. A hidden card sends none.
const NOTIFICATION_WIDGET = { mail: 'mail', message: 'messages', train: 'train' };
function widgetShown(id) {
  const entry = (preferences().widgets || []).find(item => item.id === id);
  return !entry?.hidden;
}
function addNotification(item) {
  const widget = item.widget || NOTIFICATION_WIDGET[item.type];
  if (widget && !widgetShown(widget)) return null;
  const notifications = readJson(paths.notifications(), []);
  const entry = { id: crypto.randomUUID(), time: new Date().toISOString(), read: false, ...item };
  writeJson(paths.notifications(), [entry, ...notifications].slice(0, 150));
  if (!TEST && Notification.isSupported() && preferences().systemNotifications !== false) {
    const native = new Notification({ title: entry.title || 'Nuvia', body: entry.body || '', silent: true });
    native.on('click', () => {
      mainWindow?.show(); mainWindow?.focus();
      if (entry.serviceId) notifyRenderer('open-service', entry.serviceId);
      dismissNotifications({ ids: [entry.id] });
    });
    native.on('close', () => nativeNotifications.delete(entry.id));
    nativeNotifications.set(entry.id, native);
    native.show();
  }
  notifyRenderer('notifications:changed');
  return entry;
}

/**
 * Removes the notifications that have been read: by id, or every one about a
 * service (optionally only some types, e.g. new mail once the inbox is read).
 */
function dismissNotifications({ ids, serviceId, types } = {}) {
  const current = readJson(paths.notifications(), []);
  const wanted = new Set(ids || []);
  const gone = item => wanted.has(item.id) || (serviceId && item.serviceId === serviceId && (!types || types.includes(item.type)));
  const next = current.filter(item => !gone(item));
  if (next.length === current.length) return current;
  for (const item of current) if (gone(item)) { try { nativeNotifications.get(item.id)?.close(); } catch {} nativeNotifications.delete(item.id); }
  writeJson(paths.notifications(), next);
  notifyRenderer('notifications:changed');
  return next;
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
  applyTimeZone();
  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', () => mainWindow.show());
  if (TEST) mainWindow.show();
  mainWindow.on('maximize', () => notifyRenderer('window:state', { maximized: true }));
  mainWindow.on('unmaximize', () => notifyRenderer('window:state', { maximized: false }));
  mainWindow.webContents.session.setPermissionRequestHandler((_, permission, callback) => callback(permission === 'geolocation'));
  mainWindow.webContents.on('context-menu', (_, params) => contextMenu(mainWindow.webContents, params, null));
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

// Map tiles come through the main process (see lib/tiles.js).
protocol.registerSchemesAsPrivileged([{ scheme: 'nuvia-tile', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

function serveMapTiles() {
  // Node's fetch: Chromium's net.fetch refuses a Referer header set by hand.
  const tile = createTileSource({ cacheDir: fileInProfile('map-tiles'), userAgent: `Nuvia/${app.getVersion()} (+https://github.com/mirovix/nuvia)` });
  protocol.handle('nuvia-tile', async request => {
    const where = parseTileUrl(request.url);
    const bytes = where && await tile(where);
    return bytes ? new Response(bytes, { headers: { 'Content-Type': bytes[0] === 0xff ? 'image/jpeg' : 'image/png', 'Cache-Control': 'max-age=86400' } }) : new Response(null, { status: 404 });
  });
}

if (!TEST && !app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });

app.whenReady().then(async () => {
  if (TEST && process.platform === 'linux') safeStorage.setUsePlainTextEncryption?.(true);
  try { await components.whenReady(); } catch {}
  migrate();
  recoverFromCrash();
  serveMapTiles();
  createWindow();
  scheduleUpdateChecks();
  // Mail and chat views run in the background so counters and previews stay live.
  let delay = 0;
  for (const service of services().filter(item => ['mail', 'message'].includes(serviceGroup(item)))) {
    setTimeout(() => createServiceView(service).catch(error => log('startup', service.name, error.message)), delay);
    delay += 700;
  }
});
let cookiesSaved = false;
app.on('before-quit', event => {
  writeJson(paths.guard(), { running: false, crashes: 0, pending: {}, loaded: {} });
  if (cookiesSaved) return;
  // Save session cookies once, then quit for real.
  event.preventDefault();
  withTimeout(saveAllSessionCookies(), 3000).finally(() => { cookiesSaved = true; app.quit(); });
});
setInterval(() => saveAllSessionCookies(), 10 * 60000);
app.on('window-all-closed', () => { if (!IS_MAC) app.quit(); });
app.on('activate', () => { if (!mainWindow || mainWindow.isDestroyed()) createWindow(); });

// ---------------------------------------------------------------------------
// IPC: shell, services, overlay

const handle = (channel, fn) => ipcMain.handle(channel, async (_, ...args) => fn(...args));

// ---------------------------------------------------------------------------
// Automatic updates (lib/updater.js). When a fix is released on GitHub, every
// installed Nuvia downloads it in the background, checks its SHA-256 and installs
// it on the next restart (or right away with "Restart now").

const updater = { state: 'idle', version: null, page: null, progress: 0, error: null, kind: installKind(), staged: null };
const updaterApi = process.env.NUVIA_UPDATE_URL || undefined; // tests: a local release file
const publicUpdate = () => ({ state: updater.state, version: updater.version, page: updater.page, progress: updater.progress, error: updater.error, kind: updater.kind, current: app.getVersion(), auto: preferences().autoUpdate !== false });
const setUpdate = patch => { Object.assign(updater, patch); notifyRenderer('update:state', publicUpdate()); };
// Tests hand in file:// release descriptions; Node's fetch cannot read those.
const updateFetch = (url, options) => (String(url).startsWith('file:') ? Promise.resolve(new Response(readFileSync(new URL(url)))) : fetch(url, options));

function canReplace(target) {
  if (!target) return false;
  try { accessSync(dirname(target), fsConstants.W_OK); return true; } catch { return false; }
}

async function checkForUpdates({ manual = false } = {}) {
  if (['checking', 'downloading'].includes(updater.state)) return publicUpdate();
  // A version is already staged: keep it unless an even newer one has been released.
  const held = updater.state === 'ready' ? updater.version : null;
  if (held && !manual) return publicUpdate();
  setUpdate({ state: 'checking', error: null });
  try {
    const found = await checkRelease({ current: app.getVersion(), kind: updater.kind, arch: process.arch, fetchImpl: updateFetch, api: updaterApi });
    if (!found || (held && !isNewer(found.version, held))) {
      setUpdate(held ? { state: 'ready', version: held } : { state: 'current' });
      return publicUpdate();
    }
    if (held) discardStaged(); // superseded: the newer version replaces it
    const { target, launcher } = installPaths(updater.kind);
    setUpdate({ version: found.version, page: found.page });
    // Development builds, .deb/.rpm and read-only installs: offer the download instead.
    if (!app.isPackaged || !found.asset || !canReplace(target)) {
      setUpdate({ state: 'available' });
      if (!manual) addNotification({ title: `Nuvia ${found.version} is available`, body: 'Open Settings → About to download it.' });
      return publicUpdate();
    }
    setUpdate({ state: 'downloading', progress: 0 });
    const file = join(fileInProfile('updates'), found.asset.name);
    const hash = await download(found.asset.url, file, { fetchImpl: updateFetch, userAgent: `Nuvia/${app.getVersion()}`, onProgress: progress => { if (progress - updater.progress >= 0.05 || progress === 1) setUpdate({ progress }); } });
    if (found.sums) {
      const expected = parseSums(await (await updateFetch(found.sums.url)).text())[found.asset.name];
      if (expected && expected !== hash) { rmSync(file, { force: true }); throw new Error('The download is damaged (checksum mismatch). It will be retried later.'); }
    }
    const staged = prepareUpdate(updater.kind, { file, target });
    setUpdate({ state: 'ready', staged: { ...staged, target, launcher } });
    addNotification({ title: `Nuvia ${found.version} is ready`, body: 'It installs when you restart Nuvia. Restart now from the banner at the top.' });
  } catch (error) {
    log('update', error.message);
    // A version already staged survives a failed check: it is still installable.
    if (held && updater.staged) setUpdate({ state: 'ready', version: held, error: error.message });
    else setUpdate({ state: 'error', error: error.message });
  }
  return publicUpdate();
}

/** Throws away a staged version that a newer release has superseded. */
function discardStaged() {
  const { staged, cleanup } = updater.staged || {};
  for (const path of [staged, cleanup]) { if (path) { try { removeTree(path); } catch { /* best effort */ } } }
  updater.staged = null;
}

function installUpdate({ relaunch }) {
  if (updater.state !== 'ready' || !updater.staged) return false;
  try {
    const result = applyStaged(updater.kind, { ...updater.staged, relaunch });
    updater.state = 'installed';
    if (relaunch && result.relaunch) app.relaunch({ execPath: result.relaunch, args: process.argv.slice(1).filter(arg => !arg.startsWith('--updated')) });
    return true;
  } catch (error) {
    log('update', 'install failed', error.message);
    setUpdate({ state: 'error', error: `Could not install the update: ${error.message}` });
    return false;
  }
}

handle('update:get', () => publicUpdate());
handle('update:check', () => checkForUpdates({ manual: true }));
handle('update:restart', () => {
  if (!installUpdate({ relaunch: true })) return false;
  cookiesSaved = false;
  setTimeout(() => app.quit(), 50);
  return true;
});
// Quitting normally with an update downloaded: install it, the next start is the new version.
app.on('will-quit', () => { if (updater.state === 'ready' && preferences().autoUpdate !== false) installUpdate({ relaunch: false }); });
function scheduleUpdateChecks() {
  if (TEST && !updaterApi) return;
  const tick = () => { if (preferences().autoUpdate !== false) checkForUpdates(); };
  setTimeout(tick, TEST ? 1500 : 20000);
  setInterval(tick, CHECK_EVERY_MS).unref?.();
}


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
// Remember a sign-in you type on a service's sign-in page (Settings → General
// can turn this off). Google asks email and password on separate pages, so a
// username seen shortly before is paired with the password that follows.
const pendingUsernames = new Map();
ipcMain.on('nuvia:signin-capture', (event, data) => {
  if (readJson(paths.preferences(), {}).rememberSignIns === false || !safeStorage.isEncryptionAvailable()) return;
  const url = event.senderFrame?.url || event.sender.getURL();
  if (!isSignInUrl(url)) return;
  const key = [...views.entries()].find(([, view]) => view.webContents === event.sender)?.[0];
  const service = key && serviceById(key.split('#')[0]);
  if (!service) return;
  const pending = pendingUsernames.get(service.id);
  const recent = pending && Date.now() - pending.at < 10 * 60000 ? pending.username : '';
  const username = fullUsername(String(data?.username || '').slice(0, 320), { domain: String(data?.domain || ''), pending: recent });
  const password = String(data?.password || '').slice(0, 1024);
  if (username) pendingUsernames.set(service.id, { username, at: Date.now() });
  if (!password) return;
  const user = username || recent;
  if (!user) return;
  const saved = signInCredentials(service.id);
  if (saved?.username === user && saved?.password === password) return;
  writeFileSync(signInFile(service.id), safeStorage.encryptString(JSON.stringify({ username: user, password })), { mode: 0o600 });
  signInState.get(service.id)?.passwords.splice(0);
  addNotification({ title: service.name, body: `Sign-in saved for ${user}: Nuvia will reconnect automatically when the session expires. You can remove it in Edit service.`, type: 'success', serviceId: service.id });
});

handle('services:signin-get', id => { const credentials = signInCredentials(id); return { saved: Boolean(credentials), username: credentials?.username || '', available: safeStorage.isEncryptionAvailable() }; });
handle('services:signin-set', (id, { username, password } = {}) => {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('The system keychain is unavailable, so the password cannot be stored safely');
  if (!serviceById(id) || !String(username || '').trim() || !password) throw new Error('Enter username and password');
  writeFileSync(signInFile(id), safeStorage.encryptString(JSON.stringify({ username: String(username).trim(), password: String(password) })), { mode: 0o600 });
  signInState.get(id)?.passwords.splice(0);
  const contents = views.get(id)?.webContents;
  if (contents) onSignInPage(serviceById(id), contents).then(yes => { if (yes) watchSignIn(serviceById(id), contents); });
  return { saved: true, username: String(username).trim() };
});
handle('services:signin-clear', id => { rmSync(signInFile(id), { force: true }); return { saved: false }; });
handle('services:remove-view', id => { for (const key of [...views.keys()]) if (key === id || key.startsWith(`${id}#`)) destroyView(key); serviceState.delete(id); notifyState(); });
handle('services:context-menu', id => {
  const service = serviceById(id); if (!service) return;
  const contents = views.get(id)?.webContents;
  Menu.buildFromTemplate([
    { label: 'Open', click: () => notifyRenderer('open-service', id) },
    { label: 'Reload', enabled: Boolean(contents), click: () => contents?.reload() },
    { label: contents?.isAudioMuted() ? 'Unmute' : 'Mute', enabled: Boolean(contents), click: () => contents?.setAudioMuted(!contents.isAudioMuted()) },
    { label: 'Open in browser', click: () => shell.openExternal(contents?.getURL() || service.url) },
    { type: 'separator' },
    { label: 'Edit…', click: () => notifyRenderer('service:edit', id) },
    { label: 'Remove', click: () => notifyRenderer('service:remove', id) }
  ]).popup({ window: mainWindow });
});

handle('preferences:get', () => preferences());
handle('preferences:save', value => savePreferences(value));
handle('preferences:background-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { title: 'Choose a background', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
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
  if (!dir) throw new Error('Extension not found');
  if (!sessionsPrepared.has(serviceId)) return rulesFor(dir);
  const target = session.fromPartition(partitionFor(serviceId));
  const loaded = target.extensions.getAllExtensions().find(extension => extension.path === dir);
  if (enabled && !loaded) { setGuard(serviceId, [marketplaceId]); try { await queued(() => loadExtensionInto(target, dir)); } finally { releaseGuard(serviceId); } views.get(serviceId)?.webContents.reload(); }
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
handle('extensions:popup', async (marketplaceId, fromService) => {
  // The service the menu was opened from, else the one on screen.
  const serviceId = (fromService && serviceById(fromService) ? fromService : null) || activeKey?.split('#')[0] || lastServiceId;
  const dir = extensionDirs().find(path => extensionIdOf(path) === marketplaceId);
  const info = dir && readInfo(dir);
  const refuse = reason => { log('extension popup', marketplaceId, reason); return { opened: false, reason }; };
  if (!info?.popup) return refuse('this extension has no menu');
  if (!serviceId) return refuse('open a service first: the menu works on the page you have open');
  if (rulesFor(dir)[serviceId] === false) return refuse(`it is turned off for ${serviceById(serviceId)?.name || 'this service'}`);
  const extensionsHere = () => session.fromPartition(partitionFor(serviceId)).extensions.getAllExtensions();
  // Electron may report the folder resolved differently: compare the folder name too.
  const same = extension => extension.path === dir || basename(extension.path) === basename(dir) || realpathOr(extension.path) === realpathOr(dir);
  let loaded = extensionsHere().find(same);
  if (!loaded) { await loadExtensionsFor(session.fromPartition(partitionFor(serviceId)), serviceById(serviceId)); loaded = extensionsHere().find(same); }
  if (!loaded) return refuse('it is not loaded in this service yet: reload the page');
  const cursor = screen.getCursorScreenPoint();
  // Electron calls the focused page the "active tab". A menu that took the focus
  // would find itself when it asks which page it is for (AdBlock: "Nothing to
  // block here!"). It opens without the focus, so the service stays the active
  // tab while the menu reads it; clicking the menu then focuses it as usual.
  const page = views.get(serviceId)?.webContents;
  const popup = new BrowserWindow({ show: false, focusable: true, width: 380, height: 560, x: cursor.x - 360, y: cursor.y + 16, parent: mainWindow, autoHideMenuBar: true, title: info.name, webPreferences: { partition: partitionFor(serviceId), sandbox: true, contextIsolation: true } });
  let focusedOnce = false;
  popup.on('focus', () => { focusedOnce = true; });
  popup.on('blur', () => { if (focusedOnce && !popup.isDestroyed()) popup.close(); });
  if (page && !page.isDestroyed()) page.focus();
  popup.once('ready-to-show', () => { if (!popup.isDestroyed()) popup.showInactive(); });
  popup.loadURL(`chrome-extension://${loaded.id}/${info.popup}`);
  return { opened: true };
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
    if (!data) return { source: { ...base, ok: false, message: 'Loading' }, items: [] };
    return { source: { ...base, ok: !data.loggedOut, loggedOut: data.loggedOut }, items: data.items.map(item => ({ ...base, ...item, id: `${service.id}:${item.channelId}`, time: '' })) };
  }
  const data = await run(view.webContents, script(pageScripts.chatList, kind), 6000, null);
  if (!data) return { source: { ...base, ok: false, message: 'Loading' }, items: [] };
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
  if (!service || !message) return { ok: false, message: 'Empty message' };
  const kind = serviceKind(service);
  const view = await createServiceView(service);
  if (kind === 'mattermost') return run(view.webContents, script(pageScripts.mattermostSend, item.channelId, message), 10000, { ok: false, message: 'Mattermost is not responding' });
  const opened = await run(view.webContents, script(pageScripts.openChat, kind, item.chat), 4000, false);
  if (!opened) return { ok: false, message: 'Chat not found in the list' };
  await sleep(1200);
  return run(view.webContents, script(pageScripts.sendInOpenChat, kind, item.chat, message), 6000, { ok: false, message: 'The service is not responding' });
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

async function exportedEvents(buffer, from, to) {
  const files = await readZipEntries(buffer);
  return files.flatMap(file => expandEvents(parseICS(file.text), from, to).map(event => ({ ...event, calendar: file.name.replace(/\.ics$/i, '').replace(/_[^_]*$/, '') })));
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
      return { ok: true, events: await exportedEvents(buffer, from, to), method: 'export' };
    } catch (error) { log('calendar export', service.name, error.message); }
  }
  // The same download from inside a Calendar page, where it works when the
  // request above fails; then, last, the agenda page's own text.
  const data = await withHiddenPage(service.id, `https://calendar.google.com/calendar/u/${account}/r/agenda`, async contents => {
    const exported = /accounts\.google\.com/.test(contents.getURL()) ? null : await run(contents, script(pageScripts.calendarExport, account), 20000, null);
    if (exported?.ok) return { exported };
    if (exported) log('calendar export', service.name, 'in page', exported.status);
    return run(contents, script(pageScripts.agendaText), 8000, null);
  }, { settle: 3500 });
  if (data?.exported) {
    try { return { ok: true, events: await exportedEvents(Buffer.from(data.exported.zip, 'base64'), from, to), method: 'export' }; } catch (error) { log('calendar export', service.name, 'in page', error.message); }
  }
  if (!data?.items) return { ok: false, events: [], message: 'Calendar unreachable' };
  if (/accounts\.google\.com/.test(data.url)) return { ok: false, events: [], loggedOut: true, message: 'Sign in to Google Calendar' };
  // The agenda shows each day's date as a heading of its own: an event whose
  // text has no date would land on today, so it is left out.
  return { ok: true, method: 'page', events: data.items.map(text => parseAgendaText(text)).filter(event => event.dated && event.end > from && event.start < to) };
}

async function outlookCalendarEvents(service, from, to) {
  const base = /outlook\.office/.test(service.url) ? 'https://outlook.office.com/calendar/view/week' : 'https://outlook.live.com/calendar/0/view/week';
  const data = await withHiddenPage(service.id, base, contents => run(contents, script(pageScripts.agendaText), 8000, null), { settle: 5000 });
  if (!data) return { ok: false, events: [], message: 'Calendar unreachable' };
  if (/login\./.test(data.url)) return { ok: false, events: [], loggedOut: true, message: 'Sign in to Outlook' };
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
  const events = mergeConsecutive(results.flatMap(result => (result.events || []).map(event => ({ ...event, start: new Date(event.start).getTime(), end: new Date(event.end).getTime(), sourceId: result.id, source: result.name, color: colors[result.id] || null }))));
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
      if (Number.isFinite(Number(ip?.latitude))) return { latitude: Number(ip.latitude), longitude: Number(ip.longitude), label: `${ip.city || 'Current location'} (approximate)`, approximate: true };
    } catch {}
  }
  return null;
}
// Live traffic, only when a key is configured (see lib/traffic.js).
let lastTrafficError = '';
const liveTraffic = createTrafficSource({
  fetchImpl: (url, options) => net.fetch(url, options),
  baseUrl: process.env.NUVIA_TRAFFIC_URL || undefined,
  onError: error => { lastTrafficError = error.message; log('traffic', error.message); }
});

const geocodeOptions = { baseUrl: NOMINATIM, fetchImpl: (url, options) => net.fetch(url, options), userAgent: 'Nuvia/0.6 (desktop dashboard; https://github.com/)' };

handle('places:suggest', async (text, city) => (String(text || '').trim().length < 4 ? [] : geocode(text, { ...geocodeOptions, cityHint: city || '' })));
handle('commute:route', async ({ origin, destination, city, mode = 'car', coordinates, originPlace, destinationPlace } = {}) => {
  let start = originPlace || null;
  let originChoices = [];
  if (!start && origin) {
    originChoices = await geocode(origin, geocodeOptions);
    if (!originChoices.length) throw new Error(`Starting point not found: “${origin}”`);
    start = originChoices[0];
  }
  if (!start && Number.isFinite(Number(coordinates?.latitude))) start = { latitude: Number(coordinates.latitude), longitude: Number(coordinates.longitude), label: 'Current location' };
  if (!start) start = await locateByIp();
  if (!start) throw new Error('Current location unavailable: enter a starting point');
  let end = destinationPlace || null;
  let destinationChoices = [];
  if (!end) {
    if (!String(destination || '').trim()) throw new Error('Enter a destination');
    destinationChoices = await geocode(destination, { ...geocodeOptions, cityHint: city || '' });
    if (!destinationChoices.length) throw new Error(`Destination not found: “${[destination, city].filter(Boolean).join(', ')}”`);
    end = destinationChoices[0];
  }
  const profile = MODES[mode] ? mode : 'car';
  let summary = null;
  try { summary = summarizeRoute(await (await withTimeout(net.fetch(routeUrl(ROUTING, profile, start, end)), 15000, null))?.json()); } catch (error) { log('route', error.message); }
  if (!summary && profile === 'car') {
    try { summary = summarizeRoute(await (await net.fetch(`https://router.project-osrm.org/route/v1/driving/${start.longitude},${start.latitude};${end.longitude},${end.latitude}?overview=full&geometries=geojson&steps=true`)).json()); } catch {}
  }
  if (!summary) throw new Error('Route unavailable right now');
  // The map and the directions stay OSRM's; traffic only adds the live delay on top.
  const trafficKey = String(preferences().trafficKey || '').trim();
  lastTrafficError = '';
  const live = await liveTraffic(trafficKey, start, end, profile);
  const traffic = live ? { ...live, freeMinutes: summary.minutes, level: trafficLevel({ delayMinutes: live.delayMinutes, freeMinutes: summary.minutes }) } : null;
  const minutes = traffic ? summary.minutes + traffic.delayMinutes : summary.minutes;
  // Why a drive has no live traffic, so the card can say what to do about it.
  const trafficMissing = profile !== 'car' || traffic ? null : !trafficKey ? 'no-key' : (lastTrafficError || 'unavailable');
  return { ...summary, minutes, traffic, trafficMissing, mode: profile, origin: start, destination: end, originChoices: originChoices.slice(0, 4), destinationChoices: destinationChoices.slice(0, 4), arrival: Date.now() + minutes * 60000 };
});

// ---------------------------------------------------------------------------
// IPC: trains, IAS, notifications, usage

const VIAGGIATRENO = process.env.NUVIA_VIAGGIATRENO_URL || 'http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno';

handle('trains:status', async number => {
  const clean = String(number).replace(/\D/g, '');
  if (!clean) throw new Error('Enter the train number');
  const auto = await (await net.fetch(`${VIAGGIATRENO}/cercaNumeroTrenoTrenoAutocomplete/${clean}`)).text();
  const token = auto.split('\n').find(line => line.includes('|'))?.split('|')[1]?.trim();
  if (!token) throw new Error('Train not found');
  const [, originCode, departureTime] = token.split('-');
  const data = await (await net.fetch(`${VIAGGIATRENO}/andamentoTreno/${originCode}/${clean}/${departureTime}`)).json();
  const stops = (data.fermate || []).map(stop => ({ station: stop.stazione, planned: stop.programmata || stop.partenza_teorica || stop.arrivo_teorico || null, actual: stop.effettiva || stop.partenzaReale || stop.arrivoReale || null, delay: stop.ritardo ?? 0, passed: Boolean(stop.partenzaReale || stop.arrivoReale) }));
  return { number: (data.compNumeroTreno || clean).trim(), delay: data.ritardo ?? 0, station: data.stazioneUltimoRilevamento || data.origine, origin: data.origine, destination: data.destinazione, departed: data.partito ?? null, lastSeen: data.oraUltimoRilevamento || null, stops };
});

// Ritardometro, built in: departures board from ViaggiaTreno plus the same
// schedule as github.com/mirovix/ritardometro (times, lead time, max delay).
const stationCodes = new Map();
async function stationCode(name) {
  const key = String(name || '').trim().toUpperCase();
  if (!key) throw new Error('Station not set');
  if (stationCodes.has(key)) return stationCodes.get(key);
  const text = await (await net.fetch(`${VIAGGIATRENO}/autocompletaStazione/${encodeURIComponent(key)}`)).text();
  const rows = text.split('\n').map(line => line.trim().split('|')).filter(row => row.length === 2);
  const match = rows.find(([label]) => label.toUpperCase() === key) || rows[0];
  if (!match) throw new Error(`Station not found: ${name}`);
  stationCodes.set(key, match[1]);
  return match[1];
}
async function departures(station, destinations = []) {
  const code = await stationCode(station);
  const when = encodeURIComponent(new Date().toString().replace(/ \(.*\)$/, ''));
  const list = await (await net.fetch(`${VIAGGIATRENO}/partenze/${code}/${when}`)).json();
  const wanted = destinations.map(item => String(item).trim().toUpperCase()).filter(Boolean);
  return list.map(train => ({
    number: String(train.compNumeroTreno || train.numeroTreno || '').trim(),
    destination: String(train.destinazione || '').toUpperCase(),
    time: train.compOrarioPartenza || '',
    delay: Number(train.ritardo || 0),
    platform: train.binarioEffettivoPartenzaDescrizione || train.binarioProgrammatoPartenzaDescrizione || '',
    cancelled: Boolean(train.provvedimento === 1 || /soppress/i.test(train.subTitle || ''))
  })).filter(train => !wanted.length || wanted.some(destination => train.destination.includes(destination)));
}
function parseRitardometro(source) {
  const list = key => [...(source.match(new RegExp(`^${key}:\\s*\\n((?:\\s+-\\s+.*\\n?)+)`, 'm'))?.[1] || '').matchAll(/-\s+"?([^"\n]+)"?/g)].map(match => match[1].trim());
  const hours = list('hours'); const minutes = list('minutes');
  const times = hours.flatMap(hour => (minutes.length ? minutes : ['00']).map(minute => `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`));
  return {
    station: source.match(/^current_station:\s*(.+)$/m)?.[1]?.trim() || '',
    destinations: list('destinations'),
    times,
    leadTime: Number(source.match(/^lead_time:\s*(\d+)/m)?.[1] || 20),
    maxDelay: Number(source.match(/^max_delay_minutes:\s*(\d+)/m)?.[1] || 0)
  };
}
handle('trains:board', ({ station, destinations } = {}) => departures(station, destinations || []));
// First run: take the configuration from the Ritardometro repository.
handle('trains:import', async () => {
  const local = integrations().ritardometroProject;
  if (local && existsSync(join(local, 'config.yaml'))) return { ...parseRitardometro(readFileSync(join(local, 'config.yaml'), 'utf8')), source: local };
  const url = process.env.NUVIA_RITARDOMETRO_CONFIG || 'https://raw.githubusercontent.com/mirovix/ritardometro/main/config.yaml';
  const response = await net.fetch(url);
  if (!response.ok) throw new Error(`Ritardometro configuration unavailable (${response.status})`);
  return { ...parseRitardometro(await response.text()), source: url };
});
const trainChecks = new Set();
async function ritardometroTick() {
  const config = readJson(paths.preferences(), {}).trains;
  if (!config?.station || !config.times?.length || config.enabled === false) return;
  const now = new Date();
  for (const time of config.times) {
    const [hour, minute] = time.split(':').map(Number);
    const departure = new Date(now); departure.setHours(hour, minute, 0, 0);
    const activation = departure.getTime() - (config.leadTime ?? 20) * 60000;
    const key = `${now.toDateString()} ${time}`;
    if (trainChecks.has(key) || now < activation || now > departure) continue;
    trainChecks.add(key);
    try {
      const late = (await departures(config.station, config.destinations)).filter(train => train.time === time && (train.cancelled || train.delay > (config.maxDelay ?? 0)));
      for (const train of late) addNotification({ title: `${train.number} → ${train.destination}`, body: train.cancelled ? `The ${train.time} train is cancelled` : `Departs ${train.time} from ${config.station}: +${train.delay} min${train.platform ? ` · platform ${train.platform}` : ''}`, type: 'train' });
    } catch (error) { log('ritardometro', error.message); }
  }
}
setInterval(ritardometroTick, 60000);

// DEI Labs (IAS): the same steps as github.com/mirovix/log_ias_lab, done in a
// hidden page of a dedicated persistent session instead of Selenium. The
// session cookie is kept; credentials are asked once and stored encrypted
// with the OS keychain (safeStorage), used only to renew an expired session.
const IAS = { base: 'https://deilabs.dei.unipd.it', partition: 'persist:nuvia-ias', file: () => fileInProfile('ias-account.bin') };
function iasCredentials() {
  try {
    if (existsSync(IAS.file())) return JSON.parse(safeStorage.decryptString(readFileSync(IAS.file())));
  } catch (error) { log('ias credentials', error.message); }
  if (process.env.DEI_USER && process.env.DEI_PASSWORD) return { email: process.env.DEI_USER, password: process.env.DEI_PASSWORD, fromEnv: true };
  return null;
}
function iasSession() {
  const iasSessionObject = session.fromPartition(IAS.partition);
  if (!sessionsPrepared.has('ias')) {
    sessionsPrepared.add('ias');
    if (TEST && process.env.NUVIA_FIXTURES) serveFixtures(iasSessionObject);
  }
  return iasSessionObject;
}
function iasPageScript(action, value) {
  return `(() => {
    const action = ${JSON.stringify(action)}; const value = ${JSON.stringify(value ?? null)};
    const exit = document.querySelector("input[type='submit'][value^='Exit from']");
    const select = document.getElementById('laboratory_id');
    if (action === 'login') {
      const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
      const email = document.querySelector("input[name='email']"); const password = document.querySelector("input[name='password']");
      if (!email || !password) return { ok: false };
      set(email, value.email); set(password, value.password);
      const button = document.querySelector('button.btn.btn-primary') || document.querySelector("button[type='submit'], input[type='submit']");
      if (button) button.click(); else email.form?.submit();
      return { ok: true };
    }
    if (action === 'enter') {
      const option = [...(select?.options || [])].find(item => item.text.trim() === value);
      const enter = document.querySelector("input[type='submit'][value='Enter']");
      if (!option || !enter) return { ok: false };
      select.value = option.value; select.dispatchEvent(new Event('change', { bubbles: true })); enter.click();
      return { ok: true };
    }
    if (action === 'exit') { if (!exit) return { ok: false }; exit.click(); return { ok: true }; }
    return {
      url: location.href,
      login: Boolean(document.querySelector("input[name='password']")),
      inside: Boolean(exit),
      ready: Boolean(exit || select),
      currentLab: exit ? exit.value.replace(/^Exit from\\s*/, '').trim() : '',
      labs: [...(select?.options || [])].filter(item => item.value).map(item => item.text.trim())
    };
  })()`;
}
async function withIasPage(task) {
  iasSession();
  const window = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { partition: IAS.partition, sandbox: true, contextIsolation: true } });
  const contents = window.webContents;
  const load = async url => { await withTimeout(contents.loadURL(url).catch(() => {}), 20000); await waitForLoad(contents, 15000); };
  const read = () => run(contents, iasPageScript('read'), 8000, { login: false, labs: [] });
  const settle = async ms => { await sleep(300); await waitForLoad(contents, ms); await sleep(400); };
  try { return await task({ contents, load, read, settle }); } finally { if (!window.isDestroyed()) window.destroy(); }
}
// Opens the lab page, logging in first if the saved session has expired.
// Without a session deilabs shows a "Session expired" page (no redirect), so
// "logged in" means the page has the lab selector or the exit button.
async function iasOpen(page, credentials = iasCredentials()) {
  await page.load(`${IAS.base}/laboratory_in_outs`);
  let state = await page.read();
  if (state.ready) return state;
  if (!credentials) return { ...state, needsLogin: true };
  await page.load(`${IAS.base}/login`);
  const form = await page.read();
  if (!form.login) return { ...form, needsLogin: true, message: 'DEI login page not recognised' };
  await run(page.contents, iasPageScript('login', credentials), 8000);
  await page.settle(15000);
  await page.load(`${IAS.base}/laboratory_in_outs`);
  state = await page.read();
  return state.ready ? state : { ...state, needsLogin: true, badCredentials: true };
}
// A valid session counts as signed in even when the keychain is unavailable
// and the password could not be stored; the email is remembered separately.
const iasEmailFile = () => fileInProfile('ias-account.json');
function iasResult(state, extra = {}) {
  const credentials = iasCredentials();
  const email = credentials?.email || readJson(iasEmailFile(), {}).email || '';
  return { configured: !state.needsLogin && (Boolean(credentials) || Boolean(state.ready)), account: email, fromEnv: Boolean(credentials?.fromEnv), labs: state.labs || [], inside: Boolean(state.inside), currentLab: state.currentLab || '', needsLogin: Boolean(state.needsLogin), ...extra };
}
handle('ias:state', () => withIasPage(async page => iasResult(await iasOpen(page))));
handle('ias:login', async ({ email, password } = {}) => {
  if (!email || !password) return { ok: false, message: 'Enter email and password' };
  await iasSession().clearStorageData();
  return withIasPage(async page => {
    const state = await iasOpen(page, { email, password });
    if (state.needsLogin) return { ok: false, message: 'Sign-in failed: check email and password' };
    writeJson(iasEmailFile(), { email });
    if (!safeStorage.isEncryptionAvailable()) return { ok: true, ...iasResult(state), message: 'Signed in. The system keychain is unavailable: the password was not saved, only the session is kept.' };
    writeFileSync(IAS.file(), safeStorage.encryptString(JSON.stringify({ email, password })), { mode: 0o600 });
    return { ok: true, ...iasResult(state), message: 'Sign-in saved' };
  });
});
handle('ias:logout', async () => { rmSync(IAS.file(), { force: true }); rmSync(iasEmailFile(), { force: true }); await iasSession().clearStorageData(); return { ok: true }; });
handle('ias:enter', laboratory => withIasPage(async page => {
  const state = await iasOpen(page);
  if (state.needsLogin) return iasResult(state, { ok: false, message: 'Sign in to DEI Labs first' });
  if (state.inside) return iasResult(state, { ok: true, message: `You are already checked in to ${state.currentLab}` });
  const done = await run(page.contents, iasPageScript('enter', String(laboratory || '')), 8000, { ok: false });
  if (!done?.ok) return iasResult(state, { ok: false, message: `Lab unavailable: ${laboratory}` });
  await page.settle(15000);
  await page.load(`${IAS.base}/laboratory_in_outs`);
  const after = await page.read();
  return iasResult(after, { ok: after.inside, message: after.inside ? `Checked in to ${after.currentLab || laboratory}` : 'The site did not confirm the check-in' });
}));
handle('ias:exit', () => withIasPage(async page => {
  const state = await iasOpen(page);
  if (!state.inside) return iasResult(state, { ok: true, message: 'You are not checked in to any lab' });
  await run(page.contents, iasPageScript('exit'), 8000);
  await page.settle(15000);
  await page.load(`${IAS.base}/laboratory_in_outs`);
  const after = await page.read();
  return iasResult(after, { ok: !after.inside, message: after.inside ? 'The site did not confirm the check-out' : `Checked out of ${state.currentLab}` });
}));
handle('app:info', () => ({ platform: process.platform, version: app.getVersion(), userData: app.getPath('userData') }));
handle('app:open-data', () => (TEST ? log('open data folder', app.getPath('userData')) : shell.openPath(app.getPath('userData'))));


handle('notifications:list', () => readJson(paths.notifications(), []));
handle('notifications:add', item => addNotification(item));
handle('notifications:remove', id => {
  const current = readJson(paths.notifications(), []);
  const next = id ? current.filter(item => item.id !== id) : [];
  for (const item of current) if (!next.includes(item)) { try { nativeNotifications.get(item.id)?.close(); } catch {} nativeNotifications.delete(item.id); }
  writeJson(paths.notifications(), next); return next;
});
handle('notifications:read-all', () => { const next = readJson(paths.notifications(), []).map(item => ({ ...item, read: true })); writeJson(paths.notifications(), next); return next; });
handle('notifications:dismiss', query => dismissNotifications(query || {}));

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
  const value = limits && (limits.session || limits.weekly) ? { ...limits, plan: data.plan, updatedAt: Date.now() } : { loggedOut: Boolean(data?.loggedOut), error: data?.error || (data ? 'Limits unavailable' : 'claude.ai unreachable') };
  // Field names and HTTP codes only, never values: enough to see what changed.
  if (value.error) log('claude limits', value.loggedOut ? 'signed out of claude.ai' : value.error, data?.status ? `HTTP ${data.status}` : '', data?.tried ? JSON.stringify(data.tried) : '', data?.usage ? `keys ${Object.keys(data.usage).join(',')}` : '');
  Object.assign(claudeWeb, { at: Date.now(), value });
  return value;
}
async function localUsage() {
  const result = await scanUsage().catch(error => ({ error: error.message }));
  if (!result.error) return result;
  // Worker threads may be unavailable (e.g. inside some asar builds): scan inline.
  try { return { codex: codexUsage({ root: CODEX_HOME }), claude: claudeUsage({ root: CLAUDE_HOME }) }; } catch (error) { return { error: error.message }; }
}
// Live Codex limits, one per signed-in Codex folder (lib/codex-live.js). Cached
// for a minute: the widget refreshes every minute and each read starts Codex.
const codexLive = new Map();
async function codexAccounts(force) {
  // Tests only look at their own CODEX_HOME, never at the real ~/.codex-* folders.
  const extra = String(process.env.NUVIA_CODEX_HOMES || '').split(delimiter).filter(Boolean); // tests
  const homes = codexHomes({ home: TEST ? undefined : homedir(), primary: CODEX_HOME, extra });
  if (!homes.length) return [];
  const command = process.env.NUVIA_CODEX_BIN || findCodex({ home: homedir() });
  const read = await Promise.all(homes.map(async home => {
    const cached = codexLive.get(home);
    if (!force && cached && Date.now() - cached.at < 60000) return cached.value;
    if (cached?.pending) return cached.pending;
    const pending = readCodexLive({ home, command });
    codexLive.set(home, { ...cached, pending });
    const value = await pending;
    if (value.error) log('codex limits', home, value.error);
    codexLive.set(home, { at: Date.now(), value });
    return value;
  }));
  // A folder copied from another one (e.g. ~/.codex switched to ~/.codex-account3)
  // is the same account: show it once, under the first folder that has it.
  const seen = new Set();
  return read.filter(account => {
    if (!account.email) return true;
    if (seen.has(account.email)) return false;
    seen.add(account.email);
    return true;
  });
}
// Claude Code's own plan limits, saved by the status line script Nuvia can install
// (lib/claude-statusline.js). Used when claude.ai does not answer.
const claudeCodeFiles = { limits: () => fileInProfile('claude-limits.json'), script: () => fileInProfile('claude-statusline.cjs'), settings: () => join(CLAUDE_HOME, 'settings.json') };
// ~/.claude.json, or .claude.json inside CLAUDE_CONFIG_DIR when that is set.
let claudeLimitsLoggedAt = 0;
const claudeCodeState = () => (process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : join(homedir(), '.claude.json'));
function claudeCodeLimits() {
  // The newest of: Claude Code's own cached usage, and what its status line saved.
  const read = (file, parse) => { try { return parse(readFileSync(file, 'utf8')); } catch { return null; } };
  const found = [read(claudeCodeState(), readClaudeCodeCache), read(claudeCodeFiles.limits(), readClaudeCodeLimits)].filter(Boolean);
  return found.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;
}
function claudeStatusLineState() {
  const settings = readJson(claudeCodeFiles.settings(), {});
  const installed = Boolean(settings.statusLine?.command?.includes(claudeCodeFiles.script()));
  return { installed, otherStatusLine: Boolean(settings.statusLine) && !installed, settingsFile: claudeCodeFiles.settings() };
}
handle('ai:claude-statusline', () => claudeStatusLineState());
// Only ever run from the button in Claude & Codex: it changes ~/.claude/settings.json.
handle('ai:install-claude-statusline', () => {
  const file = claudeCodeFiles.settings();
  let settings = {};
  if (existsSync(file)) {
    try { settings = JSON.parse(readFileSync(file, 'utf8')); } catch { return { ...claudeStatusLineState(), error: 'Claude Code settings.json is not valid JSON, so Nuvia left it alone.' }; }
  }
  const next = withNuviaStatusLine(settings, claudeCodeFiles.script());
  if (!next) return { ...claudeStatusLineState(), error: 'Claude Code already has a status line of its own. Nuvia does not replace it.' };
  writeFileSync(claudeCodeFiles.script(), claudeStatusLineScript(claudeCodeFiles.limits()), { mode: 0o700 });
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) copyFileSync(file, `${file}.nuvia-backup`);
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return claudeStatusLineState();
});
handle('ai:usage', async ({ force = false } = {}) => {
  const [local, web, accounts] = await Promise.all([
    localUsage(),
    claudeWebLimits(force).catch(error => ({ error: error.message })),
    codexAccounts(force).catch(error => { log('codex limits', error.message); return []; })
  ]);
  const claudeService = services().find(item => serviceKind(item) === 'claude');
  const codexService = services().find(item => serviceKind(item) === 'codex');
  const codex = { ...(local.codex || {}), accounts, serviceId: codexService?.id || null };
  // The default account's live numbers replace the ones remembered in the logs.
  const main = accounts.find(account => account.home === CODEX_HOME && account.live);
  if (main) Object.assign(codex, { session: main.session, weekly: main.weekly, plan: main.plan || codex.plan, updatedAt: main.updatedAt, live: true });
  // claude.ai first; Claude Code's status line when claude.ai has nothing.
  const fromCode = claudeCodeLimits();
  const webHasLimits = Boolean(web?.session || web?.weekly);
  const claudeLimits = webHasLimits ? web : fromCode ? { ...fromCode, webError: web?.error || null, loggedOut: web?.loggedOut, missing: web?.missing } : web;
  if (!claudeLimits?.session && !claudeLimits?.weekly && Date.now() - claudeLimitsLoggedAt > 30 * 60000) {
    claudeLimitsLoggedAt = Date.now();
    log('claude limits', 'no source has them', `claude.ai: ${web?.missing ? 'no service' : web?.error || 'nothing'}`, `${claudeCodeState()}: ${existsSync(claudeCodeState()) ? 'no usage entry' : 'missing'}`);
  }
  return { codex, claude: { ...(local.claude || {}), web: claudeLimits, statusLine: claudeStatusLineState(), serviceId: claudeService?.id || null }, error: local.error || null, at: Date.now() };
});

// ---------------------------------------------------------------------------
// Right click: what a browser offers (copy, paste, links, images), plus
// "Ask Claude" on a selection and "Reply with Claude" in Gmail and Outlook.

let lastMenu = null; // tests: the last menu built, clicked through debug:menu-click
// Who answers "Ask …" and "Reply with …": Claude (Claude Code) or ChatGPT (Codex), in Settings → General.
const chatProvider = () => (preferences().chatProvider === 'codex' ? 'codex' : 'claude');
const providerName = () => (chatProvider() === 'codex' ? 'ChatGPT' : 'Claude');
const shortText = (text, max = 28) => { const line = text.replace(/\s+/g, ' ').trim(); return line.length > max ? `${line.slice(0, max - 1)}…` : line; };
function contextMenu(contents, params, service, { ask = true } = {}) {
  const { editFlags = {}, selectionText = '', linkURL = '', srcURL = '', mediaType, isEditable, misspelledWord, dictionarySuggestions = [] } = params;
  const selection = selectionText.trim();
  const items = [];
  const section = list => { const real = list.filter(Boolean); if (!real.length) return; if (items.length) items.push({ type: 'separator' }); items.push(...real); };
  if (isEditable && misspelledWord) section([
    ...dictionarySuggestions.slice(0, 5).map(word => ({ label: word, click: () => contents.replaceMisspelling(word) })),
    dictionarySuggestions.length ? null : { label: 'No suggestions', enabled: false },
    { label: 'Add to dictionary', click: () => contents.session.addWordToSpellCheckerDictionary(misspelledWord) }
  ]);
  if (selection && ask) section([{ label: `Ask ${providerName()} about “${shortText(selection)}”`, click: () => openAskChat(contents, selection) }]);
  if (service && ['mail', 'message'].includes(serviceGroup(service)) && !isEditable) section([{ label: `Reply with ${providerName()}`, click: () => openReplyChat(service.id).then(result => { if (!result.opened) notifyRenderer('toast', result.reason); }) }]);
  if (/^https?:/i.test(linkURL)) section([
    { label: 'Open link in browser', click: () => openOutside(linkURL) },
    { label: 'Copy link address', click: () => clipboard.writeText(linkURL) }
  ]);
  else if (/^mailto:/i.test(linkURL)) section([{ label: 'Copy email address', click: () => clipboard.writeText(decodeURIComponent(linkURL.slice(7).split('?')[0])) }]);
  if (mediaType === 'image' && srcURL) section([
    { label: 'Copy image', click: () => contents.copyImageAt(params.x, params.y) },
    /^https?:/i.test(srcURL) ? { label: 'Copy image address', click: () => clipboard.writeText(srcURL) } : null
  ]);
  if (isEditable) section([
    { label: 'Undo', enabled: editFlags.canUndo, click: () => contents.undo() },
    { label: 'Redo', enabled: editFlags.canRedo, click: () => contents.redo() },
    { type: 'separator' },
    { label: 'Cut', enabled: editFlags.canCut, click: () => contents.cut() },
    { label: 'Copy', enabled: editFlags.canCopy, click: () => contents.copy() },
    { label: 'Paste', enabled: editFlags.canPaste, click: () => contents.paste() },
    { label: 'Paste as plain text', enabled: editFlags.canPaste, click: () => contents.pasteAndMatchStyle() },
    { label: 'Select all', enabled: editFlags.canSelectAll, click: () => contents.selectAll() }
  ]);
  else if (selection) section([{ label: 'Copy', click: () => contents.copy() }]);
  if (service && !selection && !linkURL && !isEditable && mediaType !== 'image') section([
    { label: 'Back', enabled: contents.navigationHistory.canGoBack(), click: () => contents.navigationHistory.goBack() },
    { label: 'Forward', enabled: contents.navigationHistory.canGoForward(), click: () => contents.navigationHistory.goForward() },
    { label: 'Reload', click: () => contents.reload() },
    { type: 'separator' },
    { label: 'Open page in browser', click: () => openOutside(contents.getURL()) },
    { label: 'Copy page address', click: () => clipboard.writeText(contents.getURL()) }
  ]);
  if (!items.length) return;
  const menu = Menu.buildFromTemplate(items);
  if (TEST) { lastMenu = menu; log('context-menu', items.filter(item => item.label).map(item => item.label).join(' | ')); return; }
  menu.popup({ window: BrowserWindow.fromWebContents(contents) || mainWindow });
}

// Claude chats (lib/claude-chat.js), each in its own small window (chat.html).
const chats = new Map(); // chat page webContents id → chat
const LANGUAGES = { it: 'Italian', en: 'English', fr: 'French', de: 'German', es: 'Spanish', pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', ro: 'Romanian', sr: 'Serbian', hr: 'Croatian' };
// The language Claude talks in: the setting, else the first non-English one the
// system names (an English desktop with Italian dates and units talks Italian).
function chatLanguage() {
  const chosen = preferences().chatLanguage;
  if (chosen && chosen !== 'auto') return chosen;
  const codes = [app.getSystemLocale?.(), process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANGUAGE, process.env.LANG, process.env.LC_TIME, ...app.getPreferredSystemLanguages(), app.getLocale()]
    .filter(Boolean).map(code => String(code).slice(0, 2).toLowerCase());
  const code = codes.find(item => item !== 'en' && item !== 'c' && LANGUAGES[item]) || 'en';
  return LANGUAGES[code];
}
function chatTheme() {
  const { theme = 'dark', accent = 'blue' } = preferences();
  return { theme: theme === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : theme, accent };
}
const clamp = (value, low, high) => Math.max(low, Math.min(value, high));
function openChat(options) {
  // One question window and one reply window per mailbox: a new one replaces the old.
  for (const chat of chats.values()) if (chat.mode === options.mode && chat.serviceId === options.serviceId && !chat.window.isDestroyed()) chat.window.close();
  const cursor = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(cursor).workArea;
  let bounds;
  if (options.mode === 'ask') {
    const width = 420; const height = 400;
    const below = cursor.y + 14 + height <= area.y + area.height;
    bounds = { width, height, x: clamp(cursor.x - 40, area.x, area.x + area.width - width), y: clamp(below ? cursor.y + 14 : cursor.y - height - 10, area.y, area.y + area.height - height) };
  } else {
    const main = mainWindow.getBounds();
    const width = 470; const height = clamp(main.height - 90, 420, 760);
    bounds = { width, height, x: clamp(main.x + main.width - width - 20, area.x, area.x + area.width - width), y: clamp(main.y + 70, area.y, area.y + area.height - height) };
  }
  const { theme } = chatTheme();
  const window = new BrowserWindow({ ...bounds, show: false, frame: false, resizable: true, minWidth: 320, minHeight: 260, parent: mainWindow, skipTaskbar: true, title: options.title, backgroundColor: theme === 'light' ? '#fffefa' : '#16171a', webPreferences: { preload: join(import.meta.dirname, 'preload-chat.cjs'), contextIsolation: true, sandbox: true } });
  const id = window.webContents.id;
  const chat = { ...options, provider: chatProvider(), window, conversation: null };
  chats.set(id, chat);
  window.on('closed', () => { chat.conversation?.stop(); chats.delete(id); });
  // A question closes when you click elsewhere, like a menu; a reply stays while you read the email.
  if (options.mode === 'ask') {
    let focused = false;
    window.on('focus', () => { focused = true; });
    window.on('blur', () => { if (focused && !window.isDestroyed()) window.close(); });
  }
  window.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) openOutside(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('context-menu', (_, params) => contextMenu(window.webContents, params, null, { ask: false }));
  window.once('ready-to-show', () => window.show());
  window.loadFile('chat.html');
  return window;
}
function openAskChat(contents, selection) {
  const host = hostOf(contents.getURL());
  openChat({ mode: 'ask', serviceId: null, title: `Ask ${providerName()}`, sub: host ? `From ${host}` : 'From Nuvia', quote: selection.slice(0, 400),
    system: askSystem({ language: chatLanguage() }), prompt: askPrompt({ text: selection, title: contents.getTitle(), host, language: chatLanguage() }) });
}
async function openMailChat(serviceId) {
  const service = serviceById(serviceId);
  const contents = views.get(serviceId)?.webContents;
  if (!service || serviceGroup(service) !== 'mail') return { opened: false, reason: `Reply with ${providerName()} works in Gmail, Outlook and chat apps.` };
  if (!contents || contents.isDestroyed()) return { opened: false, reason: `Open ${service.name} and an email first.` };
  const mail = await run(contents, script(pageScripts.mailThread, serviceKind(service)), 6000, null);
  if (!mail?.ok) {
    log('reply with claude', service.name, 'could not read the email', mail?.reason || 'the page did not answer');
    return { opened: false, reason: mail?.reason || 'Nuvia could not read the email: open it and try again.' };
  }
  const last = mail.messages.at(-1);
  openChat({ mode: 'mail', serviceId, title: `Reply with ${providerName()}`, sub: mail.subject || service.name,
    quote: last?.from ? `${last.from}${mail.messages.length > 1 ? ` · ${mail.messages.length} messages` : ''}${mail.subject ? ` — ${mail.subject}` : ''}` : mail.subject,
    system: mailSystem({ language: chatLanguage(), name: preferences().name }), prompt: mailPrompt(mail) });
  return { opened: true };
}
const CHAT_APPS = { whatsapp: 'WhatsApp', telegram: 'Telegram', teams: 'Microsoft Teams', mattermost: 'Mattermost', slack: 'Slack' };
async function openMessageChat(serviceId) {
  const service = serviceById(serviceId);
  const contents = views.get(serviceId)?.webContents;
  if (!contents || contents.isDestroyed()) return { opened: false, reason: `Open ${service.name} and a chat first.` };
  const thread = await run(contents, script(pageScripts.chatThread, serviceKind(service)), 6000, null);
  if (!thread?.ok) {
    log('reply with claude', service.name, 'could not read the chat', thread?.reason || 'the page did not answer');
    return { opened: false, reason: thread?.reason || 'Nuvia could not read the chat: open it and try again.' };
  }
  const last = thread.messages.filter(item => !item.mine).at(-1);
  openChat({ mode: 'message', serviceId, title: `Reply with ${providerName()}`, sub: thread.title || service.name,
    quote: `${thread.title || service.name}${last?.text ? ` — ${last.text.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`,
    system: messageSystem({ language: chatLanguage(), name: preferences().name }), prompt: messagePrompt({ ...thread, app: CHAT_APPS[serviceKind(service)] || service.name }) });
  return { opened: true };
}
// "Reply with …": an email in Gmail or Outlook, or a chat in WhatsApp, Telegram, Teams, Mattermost or Slack.
function openReplyChat(serviceId) {
  const service = serviceById(serviceId);
  if (service && serviceGroup(service) === 'message') return openMessageChat(serviceId);
  return openMailChat(serviceId);
}
handle('chat:mail-reply', serviceId => openReplyChat(serviceId || activeKey?.split('#')[0] || lastServiceId));

const chatFor = event => chats.get(event.sender.id);
// What Claude Code or Codex says when it fails, in words that say what to do.
function chatError(message, provider = 'claude') {
  if (provider === 'codex') {
    if (/not installed|ENOENT/i.test(message)) return 'ChatGPT answers through the Codex CLI, which is not installed on this computer. Install it (npm install -g @openai/codex) and sign in once with `codex login`, or choose Claude in Settings → General.';
    if (/not logged|log ?in|authenticat|401|unauthorized/i.test(message)) return 'Codex is not signed in: run `codex login` in a terminal once, then try again.';
    if (/usage limit|rate limit|quota|try again at/i.test(message)) return `Every ChatGPT account signed in to Codex has reached its limit. ${message}`;
    if (/did not list its features/i.test(message)) return 'This version of Codex did not say which tools it has, so Nuvia cannot turn them off and will not open the chat. Update Codex (npm install -g @openai/codex), or choose Claude in Settings → General.';
    return `ChatGPT could not answer: ${message}`;
  }
  if (/not installed|ENOENT/i.test(message)) return 'Claude Code is not installed on this computer. Install it from claude.com/claude-code and sign in once by running `claude` in a terminal.';
  if (/log ?in|logged|authenticat|credential|401|api key/i.test(message)) return 'Claude Code is not signed in: run `claude` in a terminal once and sign in, then try again.';
  if (/rate.?limit|usage limit|limit reached|429/i.test(message)) return `Your Claude plan limit is reached for now. ${message}`;
  return `Claude could not answer: ${message}`;
}
ipcMain.handle('chat:start', event => {
  const chat = chatFor(event);
  if (!chat) return { error: 'This chat has ended.' };
  const provider = chat.provider;
  const meta = { mode: chat.mode, title: chat.title, sub: chat.sub, quote: chat.quote, canInsert: chat.mode === 'mail' || chat.mode === 'message', provider: provider === 'codex' ? 'ChatGPT' : 'Claude', ...chatTheme() };
  if (chat.conversation) return meta;
  const folder = fileInProfile('claude-chat');
  mkdirSync(folder, { recursive: true });
  const send = value => { if (!chat.window.isDestroyed()) chat.window.webContents.send('chat:event', value); };
  const onEvent = value => {
    if (value.type === 'error') { log(`${provider} chat`, chat.mode, value.message); value = { ...value, message: chatError(value.message, provider), fallback: true }; }
    send(value);
  };
  // "Ask" may search the web; "Reply" works on an email only and stays offline.
  const web = chat.mode === 'ask';
  if (provider === 'codex') {
    const command = process.env.NUVIA_CODEX_CHAT_BIN ? { command: process.env.NUVIA_CODEX_CHAT_BIN, args: [] } : findCodex({ home: homedir() });
    if (!command) return { ...meta, error: chatError('not installed', 'codex'), fallback: true };
    const extra = String(process.env.NUVIA_CODEX_HOMES || '').split(delimiter).filter(Boolean); // tests
    // Accounts the Claude & Codex page already knows are at their limit go last.
    const full = home => { const live = codexLive.get(home)?.value; return Boolean(live?.limitReached || live?.session?.percent >= 100 || live?.weekly?.percent >= 100); };
    const homes = codexHomes({ home: TEST ? undefined : homedir(), primary: CODEX_HOME, extra }).sort((a, b) => full(a) - full(b));
    chat.conversation = startCodexChat({ command, homes, system: chat.system, web, cwd: folder, onEvent });
  } else {
    const command = process.env.NUVIA_CLAUDE_BIN || findClaude({ home: homedir() });
    if (!command) return { ...meta, error: chatError('not installed'), fallback: true };
    chat.conversation = startChat({ command, system: chat.system, model: preferences().chatModel || 'sonnet', web, cwd: folder, onEvent });
  }
  chat.conversation.send(chat.prompt);
  return meta;
});
ipcMain.handle('chat:send', (event, text) => { chatFor(event)?.conversation?.send(String(text || '').slice(0, 20000)); });
ipcMain.handle('chat:copy', (_, text) => { clipboard.writeText(String(text || '')); return true; });
ipcMain.handle('chat:close', event => { chatFor(event)?.window.close(); });
ipcMain.handle('chat:insert', async (event, text) => {
  const chat = chatFor(event);
  const service = chat && serviceById(chat.serviceId);
  const contents = chat && views.get(chat.serviceId)?.webContents;
  const message = chat?.mode === 'message';
  if (!service || !contents || contents.isDestroyed()) return { ok: false, reason: `The ${message ? 'chat' : 'mailbox'} is closed: use Copy.` };
  // Typing needs the page focused, not the chat window.
  mainWindow.focus(); contents.focus();
  const result = await run(contents, script(message ? pageScripts.insertChatReply : pageScripts.insertMailReply, serviceKind(service), String(text || '')), 12000, null);
  if (!result?.ok) log('reply with claude', service.name, 'insert failed', result?.reason || 'the page did not answer');
  return result?.ok ? result : { ok: false, reason: result?.reason || 'The reply box could not be filled: use Copy and paste it.' };
});
// Without the CLI: the question goes to Claude (or ChatGPT) in Nuvia, ready to paste.
ipcMain.handle('chat:open-claude', event => {
  const chat = chatFor(event);
  const codex = chat?.provider === 'codex';
  clipboard.writeText(`${chat?.system || ''}\n\n${chat?.prompt || ''}`.trim());
  const target = services().find(item => serviceKind(item) === (codex ? 'codex' : 'claude'));
  if (target) { notifyRenderer('open-service', target.id); mainWindow.focus(); } else openOutside(codex ? 'https://chatgpt.com/' : 'https://claude.ai/new');
  notifyRenderer('toast', `The question is copied: paste it into ${codex ? 'ChatGPT' : 'Claude'}.`);
  chat?.window.close();
});

if (TEST) {
  handle('debug:state', () => ({ activeKey, overlayDepth, children: mainWindow.contentView.children.length, made: Object.fromEntries([...new Set(madeViews)].map(key => [key, madeViews.filter(item => item === key).length])), attached: Boolean(views.get(activeKey) && attached(views.get(activeKey))), views: [...views.keys()], hostBounds, uiExtensions: session.defaultSession.extensions.getAllExtensions().length }));
  handle('debug:menu', () => (lastMenu ? lastMenu.items.filter(item => item.label).map(item => ({ label: item.label, enabled: item.enabled })) : null));
  handle('debug:menu-click', label => { const item = lastMenu?.items.find(entry => entry.label === label); if (!item) return false; item.click(); return true; });
  handle('debug:menu-clear', () => { lastMenu = null; });
  // A right click through Chromium's own input path, as the mouse does it.
  handle('debug:right-click', ({ key, x, y }) => {
    const contents = views.get(key)?.webContents; if (!contents) return false;
    contents.sendInputEvent({ type: 'mouseMove', x, y });
    contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'right', clickCount: 1 });
    contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'right', clickCount: 1 });
    return true;
  });
  handle('debug:crash-guard', () => readJson(paths.guard(), {}));
  handle('debug:cookie-roundtrip', async id => {
    const jar = session.fromPartition(partitionFor(id)).cookies;
    await jar.set({ url: 'https://portal.nuvia.test/', name: 'sso_session', value: 'kept' });
    await saveSessionCookies(id);
    await jar.remove('https://portal.nuvia.test/', 'sso_session');
    cookiesRestored.delete(id);
    await restoreSessionCookies(id);
    const cookie = (await jar.get({ name: 'sso_session' }))[0];
    return { value: cookie?.value || null, session: cookie?.session ?? null, encrypted: existsSync(cookieFile(id)) && !readFileSync(cookieFile(id)).toString('latin1').includes('kept') };
  });
  handle('debug:crash-view', key => { views.get(key)?.webContents.forcefullyCrashRenderer(); return Boolean(views.get(key)); });
  // An install folder holds resources/app.asar, which Electron's fs shows as a
  // directory: removing it needs lib/update-install.js#removeTree.
  handle('debug:remove-install-tree', ({ folder, safe = true }) => {
    try {
      if (safe) removeTree(folder); else rmSync(folder, { recursive: true, force: true });
      return { removed: !existsSync(folder), error: null };
    } catch (error) {
      return { removed: !existsSync(folder), error: error.message };
    }
  });
}
