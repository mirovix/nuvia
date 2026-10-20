// Electron implements only part of Chrome's extension APIs. A background service
// worker that touches a missing one (Streak: chrome.permissions.onAdded; AdBlock:
// chrome.webNavigation, chrome.alarms) throws while starting, Chrome's "Service
// worker registration failed", and the extension never works.
//
// prepareExtension() puts a small file in front of the extension's service worker
// that fills in the missing APIs: alarms run on timers, permissions report what
// the manifest grants, contextMenus/notifications/idle/windows answer sensibly,
// and the events exist (they simply never fire). The real APIs Electron has
// (scripting, declarativeNetRequest, storage, tabs…) are left untouched.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SHIM_FILE = 'nuvia-shim.js';
export const WRAPPER_FILE = 'nuvia-background.js';
export const CONTENT_FILE = 'nuvia-content.js';

// Runs first in the extension's content scripts. Chrome gives them
// chrome.extension (getURL, inIncognitoContext); Electron does not. Streak only
// creates the bridge to its storage when chrome.extension exists: without it,
// the sign-in token it saves after you connect never reaches chrome.storage, so
// every reload asked to sign in again. Only this is added, and only if missing.
export const CONTENT_SOURCE = `// Added by Nuvia: chrome.extension, which Chrome gives content scripts and Electron does not.
(() => {
  if (typeof chrome === 'undefined' || !chrome.runtime || chrome.extension) return;
  chrome.extension = {
    getURL: path => chrome.runtime.getURL(path),
    inIncognitoContext: false,
    get lastError() { return chrome.runtime.lastError; }
  };
})();
`;

// Runs inside the extension's service worker, before its own code.
export const SHIM_SOURCE = `// Added by Nuvia: Chrome extension APIs that Electron does not provide.
(() => {
  const root = globalThis.chrome || (globalThis.chrome = {});
  const manifest = root.runtime && root.runtime.getManifest ? root.runtime.getManifest() : {};
  const event = () => {
    const listeners = new Set();
    return {
      addListener: fn => { listeners.add(fn); }, removeListener: fn => { listeners.delete(fn); },
      hasListener: fn => listeners.has(fn), hasListeners: () => listeners.size > 0,
      dispatch: (...args) => { for (const fn of [...listeners]) { try { fn(...args); } catch (error) { console.error(error); } } }
    };
  };
  // Chrome APIs take a callback or return a promise: support both.
  const api = fn => (...args) => {
    const callback = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    const result = Promise.resolve().then(() => fn(...args));
    if (callback) { result.then(value => callback(value), () => callback()); return undefined; }
    return result;
  };
  const fill = (name, value) => { if (!root[name]) root[name] = value; else for (const key of Object.keys(value)) if (!(key in root[name])) root[name][key] = value[key]; };

  const granted = { permissions: [...(manifest.permissions || [])], origins: [...(manifest.host_permissions || [])] };
  fill('permissions', {
    contains: api(() => true), getAll: api(() => granted), request: api(() => true), remove: api(() => false),
    onAdded: event(), onRemoved: event()
  });

  const alarms = new Map(); const onAlarm = event();
  const clearAlarm = name => { const alarm = alarms.get(name); if (!alarm) return false; clearTimeout(alarm.timer); clearInterval(alarm.timer); alarms.delete(name); return true; };
  fill('alarms', {
    create: (nameOrInfo, maybeInfo) => {
      const name = typeof nameOrInfo === 'string' ? nameOrInfo : '';
      const info = (typeof nameOrInfo === 'string' ? maybeInfo : nameOrInfo) || {};
      clearAlarm(name);
      const delay = info.when ? Math.max(0, info.when - Date.now()) : (info.delayInMinutes ?? info.periodInMinutes ?? 1) * 60000;
      const period = info.periodInMinutes ? info.periodInMinutes * 60000 : 0;
      const alarm = { name, scheduledTime: Date.now() + delay, periodInMinutes: info.periodInMinutes };
      const fire = () => { alarm.scheduledTime = Date.now() + period; onAlarm.dispatch({ name, scheduledTime: Date.now(), periodInMinutes: info.periodInMinutes }); if (!period) alarms.delete(name); };
      alarm.timer = setTimeout(() => { fire(); if (period) alarm.timer = setInterval(fire, period); }, delay);
      alarms.set(name, alarm);
      return Promise.resolve();
    },
    get: api(name => { const a = alarms.get(name || ''); return a ? { name: a.name, scheduledTime: a.scheduledTime, periodInMinutes: a.periodInMinutes } : undefined; }),
    getAll: api(() => [...alarms.values()].map(a => ({ name: a.name, scheduledTime: a.scheduledTime, periodInMinutes: a.periodInMinutes }))),
    clear: api(name => clearAlarm(name || '')), clearAll: api(() => { for (const name of [...alarms.keys()]) clearAlarm(name); return true; }),
    onAlarm
  });

  const navigationEvents = ['onBeforeNavigate', 'onCommitted', 'onDOMContentLoaded', 'onCompleted', 'onErrorOccurred', 'onCreatedNavigationTarget', 'onReferenceFragmentUpdated', 'onTabReplaced', 'onHistoryStateUpdated'];
  fill('webNavigation', Object.assign(Object.fromEntries(navigationEvents.map(name => [name, event()])), { getFrame: api(() => null), getAllFrames: api(() => []) }));
  const requestEvents = ['onBeforeRequest', 'onBeforeSendHeaders', 'onSendHeaders', 'onHeadersReceived', 'onAuthRequired', 'onResponseStarted', 'onBeforeRedirect', 'onCompleted', 'onErrorOccurred', 'onActionIgnored'];
  fill('webRequest', Object.assign(Object.fromEntries(requestEvents.map(name => [name, event()])), { handlerBehaviorChanged: api(() => undefined), MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES: 20 }));

  let menuId = 0;
  fill('contextMenus', { create: (props = {}, callback) => { const id = props.id ?? ++menuId; if (callback) setTimeout(callback); return id; }, update: api(() => undefined), remove: api(() => undefined), removeAll: api(() => undefined), onClicked: event() });
  fill('idle', { queryState: api(() => 'active'), setDetectionInterval: () => undefined, getAutoLockDelay: api(() => 0), onStateChanged: event() });
  fill('notifications', { create: api(id => (typeof id === 'string' ? id : String(Date.now()))), update: api(() => true), clear: api(() => true), getAll: api(() => ({})), getPermissionLevel: api(() => 'granted'), onClicked: event(), onClosed: event(), onButtonClicked: event(), onShowSettings: event() });
  const windowInfo = { id: 1, focused: true, top: 0, left: 0, width: 1280, height: 900, incognito: false, type: 'normal', state: 'normal', alwaysOnTop: false };
  fill('windows', { WINDOW_ID_NONE: -1, WINDOW_ID_CURRENT: -2, get: api(() => windowInfo), getCurrent: api(() => windowInfo), getLastFocused: api(() => windowInfo), getAll: api(() => [windowInfo]), create: api(() => windowInfo), update: api(() => windowInfo), remove: api(() => undefined), onCreated: event(), onRemoved: event(), onFocusChanged: event(), onBoundsChanged: event() });
  fill('offscreen', { createDocument: api(() => undefined), closeDocument: api(() => undefined), hasDocument: api(() => false), Reason: {} });
  fill('cookies', { get: api(() => null), getAll: api(() => []), set: api(() => null), remove: api(() => null), getAllCookieStores: api(() => [{ id: '0', tabIds: [] }]), onChanged: event() });
  const self = { id: root.runtime && root.runtime.id, name: manifest.name, version: manifest.version, enabled: true, type: 'extension', installType: 'normal', mayDisable: true, permissions: granted.permissions, hostPermissions: granted.origins };
  fill('management', { getAll: api(() => [self]), get: api(() => self), setEnabled: api(() => undefined), onInstalled: event(), onUninstalled: event(), onEnabled: event(), onDisabled: event() });
})();
`;

/**
 * Makes an unpacked MV3 extension start in Electron: its service worker is
 * wrapped so the shim runs first. Idempotent; the original manifest is kept in
 * manifest.nuvia-original.json. Returns true when it has a service worker or content scripts to prepare.
 */
// Writes only when the content changes: Chromium reads these files while it
// injects them into pages, and a rewrite at that moment could be read half-done.
function writeIfChanged(file, content) {
  try { if (readFileSync(file, 'utf8') === content) return; } catch {}
  writeFileSync(file, content);
}

export function prepareExtension(dir) {
  const manifestFile = join(dir, 'manifest.json');
  const originalFile = join(dir, 'manifest.nuvia-original.json');
  if (!existsSync(manifestFile)) return false;
  const original = JSON.parse(readFileSync(existsSync(originalFile) ? originalFile : manifestFile, 'utf8'));
  const worker = original.background?.service_worker;
  const scripts = (original.content_scripts || []).filter(entry => entry.js?.length);
  if (!worker && !scripts.length) return false;
  if (!existsSync(originalFile)) writeFileSync(originalFile, JSON.stringify(original, null, 2));
  if (worker) {
    writeIfChanged(join(dir, SHIM_FILE), SHIM_SOURCE);
    const module = original.background.type === 'module';
    writeIfChanged(join(dir, WRAPPER_FILE), module
      ? `import './${SHIM_FILE}';\nimport './${worker.replace(/^\.?\//, '')}';\n`
      : `importScripts('${SHIM_FILE}', ${JSON.stringify(worker.replace(/^\.?\//, ''))});\n`);
  }
  // The service worker gets the full shim. Content scripts get only
  // chrome.extension, before their own files; scripts that run in the page's own
  // world (MAIN) have no chrome APIs and are left alone. The full shim in pages
  // and content scripts broke Streak's sign-in hand-off once: it is never put there.
  if (scripts.length) writeIfChanged(join(dir, CONTENT_FILE), CONTENT_SOURCE);
  const content_scripts = original.content_scripts?.map(entry => (entry.js?.length && entry.world !== 'MAIN' ? { ...entry, js: [CONTENT_FILE, ...entry.js] } : entry));
  // declarativeNetRequestWithHostAccess only applies rules on sites the extension
  // has been granted, and Electron never grants them: AdBlock's EasyList rules
  // matched but blocked nothing. Chrome's plain declarativeNetRequest permission
  // applies block/allow rules everywhere, as an ad blocker expects.
  const permissions = [...(original.permissions || [])];
  if (permissions.includes('declarativeNetRequestWithHostAccess') && !permissions.includes('declarativeNetRequest')) permissions.push('declarativeNetRequest');
  const manifest = { ...original, permissions, ...(worker ? { background: { ...original.background, service_worker: WRAPPER_FILE } } : {}), ...(content_scripts ? { content_scripts } : {}) };
  writeIfChanged(manifestFile, JSON.stringify(manifest, null, 2));
  // Undo the page tags an earlier version added.
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.html')) continue;
    const file = join(dir, name);
    const html = readFileSync(file, 'utf8');
    const tag = `<script src="${SHIM_FILE}"></script>`;
    if (html.includes(tag)) writeFileSync(file, html.replace(tag, ''));
  }
  return true;
}
