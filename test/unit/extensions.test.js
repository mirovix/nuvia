import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readInfo, patternMatches, defaultRules, matchPatterns } from '../../lib/extensions.js';
import { serviceKind, serviceGroup } from '../../lib/kinds.js';

const services = [{ id: 'gmail', url: 'https://mail.google.com/mail/u/2/#inbox' }, { id: 'wa', url: 'https://web.whatsapp.com/' }, { id: 'notion', url: 'https://www.notion.so/' }];

test("patternMatches follows Chrome's rules", () => {
  assert.ok(patternMatches('https://mail.google.com/*', 'https://mail.google.com/mail/u/0/'));
  assert.ok(patternMatches('*://*.google.com/*', 'https://mail.google.com/x'));
  assert.ok(patternMatches('*://mail.google.com/', 'https://mail.google.com/mail/u/2/#inbox'));
  assert.ok(patternMatches('<all_urls>', 'https://web.whatsapp.com/'));
  assert.ok(!patternMatches('https://mail.google.com/*', 'https://web.whatsapp.com/'));
  assert.ok(!patternMatches('*://*.google.com/*', 'https://notgoogle.com/'));
});

test('Streak is enabled only on Gmail, Dark Reader everywhere', () => {
  const streak = { matches: matchPatterns({ content_scripts: [{ matches: ['https://mail.google.com/*'] }, { matches: ['*://*.google.com/*'] }], host_permissions: ['*://mail.google.com/', '*://*.streak.com/'] }) };
  assert.deepEqual(defaultRules(streak, services), { gmail: true, wa: false, notion: false });
  const darkReader = { matches: ['<all_urls>'] };
  assert.deepEqual(defaultRules(darkReader, services), { gmail: true, wa: true, notion: true });
});

test('readInfo resolves localized names and icons', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ext-'));
  mkdirSync(join(dir, '_locales', 'en'), { recursive: true });
  writeFileSync(join(dir, '_locales', 'en', 'messages.json'), JSON.stringify({ appName: { message: 'Streak CRM for Gmail' } }));
  writeFileSync(join(dir, 'icon128.png'), '');
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: '__MSG_appName__', default_locale: 'en', version: '7.1', icons: { 16: 'missing.png', 128: 'icon128.png' }, action: { default_popup: 'popup.html' }, content_scripts: [{ matches: ['https://mail.google.com/*'] }] }));
  const info = readInfo(dir);
  assert.equal(info.name, 'Streak CRM for Gmail');
  assert.equal(info.popup, 'popup.html');
  assert.match(info.icon, /icon128\.png$/);
  assert.equal(readInfo(join(dir, 'nope')), null);
  rmSync(dir, { recursive: true, force: true });
});

test('serviceKind and serviceGroup', () => {
  assert.equal(serviceKind({ url: 'https://mail.google.com/mail/u/2/' }), 'gmail');
  assert.equal(serviceKind({ url: 'https://outlook.office.com/mail/?login_hint=x' }), 'outlook');
  assert.equal(serviceKind({ url: 'https://mattermost.dei.unipd.it/iaslab' }), 'mattermost');
  assert.equal(serviceKind({ url: 'https://chatgpt.com/codex' }), 'codex');
  assert.equal(serviceKind({ url: 'https://claude.ai/new' }), 'claude');
  assert.equal(serviceGroup({ url: 'https://web.telegram.org/k/' }), 'message');
  assert.equal(serviceGroup({ url: 'https://outlook.live.com/mail/0/' }), 'mail');
  assert.equal(serviceGroup({ url: 'https://example.com' }), 'web');
});

test('chromeUserAgent matches the real OS and Chrome reduced version', async () => {
  const { chromeUserAgent } = await import('../../lib/useragent.js');
  assert.equal(chromeUserAgent('win32', '138.0.7204.251'), 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36');
  assert.match(chromeUserAgent('darwin', '138.0.7204.251'), /\(Macintosh; Intel Mac OS X 10_15_7\).*Chrome\/138\.0\.0\.0/);
  assert.match(chromeUserAgent('linux', '138.0.7204.251'), /\(X11; Linux x86_64\).*Chrome\/138\.0\.0\.0/);
  assert.doesNotMatch(chromeUserAgent(), /Electron|Nuvia/);
});

test('Google sign-in uses a Firefox identity only on accounts.google.com', async () => {
  const { firefoxUserAgent, isGoogleSignIn } = await import('../../lib/useragent.js');
  assert.match(firefoxUserAgent('win32'), /^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64; rv:\d+\.0\) Gecko\/20100101 Firefox\/\d+\.0$/);
  assert.match(firefoxUserAgent('darwin'), /Macintosh; Intel Mac OS X 10\.15; rv:/);
  assert.ok(isGoogleSignIn('https://accounts.google.com/v3/signin/identifier?x=1'));
  assert.ok(isGoogleSignIn('https://accounts.google.com/ServiceLogin?service=mail'));
  assert.ok(isGoogleSignIn('https://accounts.google.com'));
  assert.ok(!isGoogleSignIn('https://mail.google.com/mail/u/0/'));
  assert.ok(!isGoogleSignIn('https://accounts.google.com.evil.example/'));
});
