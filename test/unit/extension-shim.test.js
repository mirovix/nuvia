import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { prepareExtension, SHIM_FILE, SHIM_SOURCE, WRAPPER_FILE } from '../../lib/extension-shim.js';

function extension(manifest, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nuvia-ext-'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

test('the service worker is wrapped so the shim runs first, once', () => {
  const dir = extension({ manifest_version: 3, name: 'X', version: '1', background: { service_worker: 'bg.js' }, content_scripts: [{ matches: ['https://mail.google.com/*'], js: ['c.js'] }] }, { 'bg.js': '', 'blank.html': '<html><head></head></html>' });
  assert.equal(prepareExtension(dir), true);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.background.service_worker, WRAPPER_FILE);
  assert.equal(readFileSync(join(dir, WRAPPER_FILE), 'utf8'), `importScripts('${SHIM_FILE}', "bg.js");\n`);
  assert.deepEqual(manifest.content_scripts[0].js, ['c.js'], 'content scripts are left alone');
  assert.equal(readFileSync(join(dir, 'blank.html'), 'utf8'), '<html><head></head></html>', 'extension pages are left alone');
  assert.equal(JSON.parse(readFileSync(join(dir, 'manifest.nuvia-original.json'), 'utf8')).background.service_worker, 'bg.js');
  // A second load changes nothing on disk (Chromium may be reading these files).
  const before = statSync(join(dir, 'manifest.json')).mtimeMs;
  prepareExtension(dir);
  assert.equal(statSync(join(dir, 'manifest.json')).mtimeMs, before);
  assert.equal(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).background.service_worker, WRAPPER_FILE);
});

test('module workers are imported, and extensions without a worker are untouched', () => {
  const module = extension({ manifest_version: 3, background: { service_worker: './sw.js', type: 'module' } });
  prepareExtension(module);
  assert.equal(readFileSync(join(module, WRAPPER_FILE), 'utf8'), `import './${SHIM_FILE}';\nimport './sw.js';\n`);
  const plain = extension({ manifest_version: 3, content_scripts: [] });
  assert.equal(prepareExtension(plain), false);
});

test('the shim fills only what Electron lacks and its APIs work', async () => {
  const realPermissions = { contains: () => 'real' };
  const chrome = { runtime: { id: 'abc', getManifest: () => ({ name: 'Streak', version: '7', permissions: ['storage'], host_permissions: ['*://*.streak.com/'] }) }, permissions: realPermissions, storage: { local: {} } };
  const context = vm.createContext({ chrome, setTimeout, clearTimeout, setInterval, clearInterval, console, Promise, Date });
  context.globalThis = context;
  vm.runInContext(SHIM_SOURCE, context);
  assert.equal(chrome.permissions.contains(), 'real', 'an API Electron has is not replaced');
  assert.equal(typeof chrome.permissions.onAdded.addListener, 'function', 'a missing event is added');
  assert.equal(JSON.stringify(await chrome.permissions.getAll()), JSON.stringify({ permissions: ['storage'], origins: ['*://*.streak.com/'] }));
  for (const name of ['webNavigation', 'webRequest', 'contextMenus', 'idle', 'notifications', 'windows', 'offscreen', 'cookies']) assert.ok(chrome[name], name);
  assert.equal(typeof chrome.webNavigation.onCommitted.addListener, 'function');
  assert.equal(await chrome.idle.queryState(60), 'active');
  // alarms really fire
  const fired = new Promise(resolve => chrome.alarms.onAlarm.addListener(resolve));
  chrome.alarms.create('tick', { when: Date.now() + 20 });
  assert.equal((await fired).name, 'tick');
  // callbacks work as well as promises
  assert.equal(await new Promise(resolve => chrome.windows.getCurrent(resolve)).then(w => w.id), 1);
});
