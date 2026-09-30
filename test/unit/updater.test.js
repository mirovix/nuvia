import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRelease, installKind, installPaths, isNewer, parseSums, pickAsset } from '../../lib/updater.js';

const ASSETS = ['Nuvia-0.7.0-amd64.deb', 'Nuvia-0.7.0-arm64.zip', 'Nuvia-0.7.0-mac-arm64.dmg', 'Nuvia-0.7.0-portable.exe', 'Nuvia-0.7.0-x64.tar.gz',
  'Nuvia-0.7.0-x64.zip', 'Nuvia-0.7.0-x86_64.AppImage', 'Nuvia-0.7.0-x86_64.rpm', 'Nuvia-Setup-0.7.0.exe', 'SHA256SUMS.txt']
  .map(name => ({ name, url: `https://example.test/${name}`, size: 1 }));

test('versions compare numerically', () => {
  assert.ok(isNewer('0.6.10', '0.6.9'));
  assert.ok(isNewer('v1.0.0', '0.9.9'));
  assert.ok(!isNewer('0.6.4', '0.6.4'));
  assert.ok(!isNewer('0.6.3', '0.6.4'));
  assert.ok(isNewer('0.7.0', '0.7.0-beta'));
  assert.ok(!isNewer('0.7.0-beta', '0.7.0'));
});

test('the kind of install is recognised on every system', () => {
  assert.equal(installKind({ platform: 'linux', env: { APPIMAGE: '/home/u/Nuvia.AppImage' }, execPath: '/tmp/.mount/nuvia-desktop.bin' }), 'appimage');
  assert.equal(installKind({ platform: 'linux', env: {}, execPath: '/home/u/.local/opt/Nuvia/nuvia-desktop.bin' }), 'folder');
  assert.equal(installKind({ platform: 'linux', env: {}, execPath: '/opt/Nuvia/nuvia-desktop.bin' }), 'package');
  assert.equal(installKind({ platform: 'win32', env: {} }), 'nsis');
  assert.equal(installKind({ platform: 'win32', env: { PORTABLE_EXECUTABLE_FILE: 'C:\\x\\Nuvia.exe' } }), 'portable');
  assert.equal(installKind({ platform: 'darwin', env: {} }), 'mac');
});

test('each install gets its own release file', () => {
  const pick = (kind, arch = 'x64') => pickAsset(ASSETS, kind, { arch })?.name ?? null;
  assert.equal(pick('appimage'), 'Nuvia-0.7.0-x86_64.AppImage');
  assert.equal(pick('folder'), 'Nuvia-0.7.0-x64.tar.gz');
  assert.equal(pick('nsis'), 'Nuvia-Setup-0.7.0.exe');
  assert.equal(pick('portable'), 'Nuvia-0.7.0-portable.exe');
  assert.equal(pick('mac', 'arm64'), 'Nuvia-0.7.0-arm64.zip');
  assert.equal(pick('mac', 'x64'), 'Nuvia-0.7.0-x64.zip');
  assert.equal(pick('package'), null);
  assert.equal(pick('folder', 'arm64'), null);
});

test('install paths follow the running executable', () => {
  assert.deepEqual(installPaths('folder', { execPath: '/home/u/.local/opt/Nuvia/nuvia-desktop.bin' }), { target: '/home/u/.local/opt/Nuvia', launcher: '/home/u/.local/opt/Nuvia/nuvia-desktop' });
  assert.deepEqual(installPaths('mac', { execPath: '/Applications/Nuvia.app/Contents/MacOS/Nuvia' }), { target: '/Applications/Nuvia.app', launcher: '/Applications/Nuvia.app' });
  assert.equal(installPaths('appimage', { env: { APPIMAGE: '/a/N.AppImage' } }).target, '/a/N.AppImage');
});

test('checksums are parsed from sha256sum output', () => {
  const sums = parseSums(`${'a'.repeat(64)}  Nuvia-0.7.0-x64.tar.gz\n${'B'.repeat(64)} *Nuvia-Setup-0.7.0.exe\ngarbage\n`);
  assert.deepEqual(sums, { 'Nuvia-0.7.0-x64.tar.gz': 'a'.repeat(64), 'Nuvia-Setup-0.7.0.exe': 'b'.repeat(64) });
});

test('checkRelease reports only newer, final releases', async () => {
  const release = (tag, extra = {}) => async () => ({ ok: true, json: async () => ({ tag_name: tag, html_url: 'https://github.com/x', body: 'Fixes', assets: ASSETS.map(a => ({ name: a.name, browser_download_url: a.url, size: 1 })), ...extra }) });
  const found = await checkRelease({ current: '0.6.4', kind: 'folder', arch: 'x64', fetchImpl: release('v0.7.0') });
  assert.equal(found.version, '0.7.0');
  assert.equal(found.asset.name, 'Nuvia-0.7.0-x64.tar.gz');
  assert.equal(found.sums.name, 'SHA256SUMS.txt');
  assert.equal(await checkRelease({ current: '0.7.0', kind: 'folder', arch: 'x64', fetchImpl: release('v0.7.0') }), null);
  assert.equal(await checkRelease({ current: '0.6.4', kind: 'folder', arch: 'x64', fetchImpl: release('v0.7.0', { prerelease: true }) }), null);
  await assert.rejects(checkRelease({ current: '0.6.4', kind: 'folder', fetchImpl: async () => ({ ok: false, status: 403 }) }), /403/);
});
