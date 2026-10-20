import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, writeProfile, project } from './helpers.js';

// Streak keeps its sign-in only in memory: every Gmail reload shows "Accedi per
// usare Streak" again. Once connected, Nuvia signs it back in by itself in a
// hidden window: Google's account choice (drawn late, with no page load to wait
// for), then "Sign in to Streak · Continue". The window must stay hidden.
const STREAK = 'pnnfemgpilpdaojpnkjdgfgbnnjojfik';
// Like Streak: the sign-in token is kept through a bridge that exists only when
// chrome.extension does (Electron leaves it out of content scripts), and read
// back on the next load; without it the prompt comes back on every reload.
const CONTENT = `
const bridge = chrome.extension ? { get: key => chrome.storage.local.get(key).then(found => found[key]), set: (key, value) => chrome.storage.local.set({ [key]: value }) } : null;
const prompt = document.createElement('div');
prompt.id = 'streak-prompt';
prompt.innerHTML = '<span>Accedi per usare Streak</span> <button>Accedi con Google</button>';
prompt.querySelector('button').addEventListener('click', () => window.open('https://www.streak.com/login', 'streak', 'width=500,height=600'));
const connected = () => { prompt.remove(); document.documentElement.dataset.streak = 'connected'; };
addEventListener('message', event => { if (event.data === 'streak-connected') { bridge?.set('bearerToken', 'token'); connected(); } });
(async () => {
  const token = bridge && await bridge.get('bearerToken').catch(() => null);
  if (token) return connected();
  setTimeout(() => document.body.append(prompt), 1500);
})();
`;

test('Streak signs back in once, hidden, and then stays signed in across reloads', { timeout: 150000 }, async () => {
  const app = await launch({
    prepare: profile => {
      const fixtures = join(profile, 'fixtures');
      cpSync(join(project, 'test', 'fixtures'), fixtures, { recursive: true });
      process.env.NUVIA_FIXTURES = fixtures;
      const dir = join(profile, 'marketplace-extensions', STREAK);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ manifest_version: 3, version: '1.0.0', name: 'Streak', permissions: ['storage'],
        host_permissions: ['*://mail.google.com/', '*://*.streak.com/'], content_scripts: [{ matches: ['https://mail.google.com/*'], js: ['c.js'] }] }));
      writeFileSync(join(dir, 'c.js'), CONTENT);
      writeProfile(profile, {
        'services.json': [{ id: 'gmail', name: 'Gmail Unipd', url: 'https://mail.google.com/mail/u/0/#inbox' }], 'preferences.json': {}, 'extensions.json': [dir],
        // Connected once by hand, before.
        'extension-sessions.json': { gmail: { [STREAK]: Date.now() - 3600000 } }
      });
    }
  });
  let ui; let gmail;
  const nuviaLog = () => { try { return readFileSync(join(app.profile, 'nuvia.log'), 'utf8'); } catch { return ''; } };
  try {
    ui = await app.ui();
    await ui.eval(`await window.nuvia.signInSet('gmail', { username: 'mario.rossi@studenti.unipd.it', password: 'secret' }); return true`);
    await ui.eval(`document.querySelector('.service[data-id="gmail"]').click(); return true`);
    gmail = await app.page(target => target.type === 'page' && target.url.startsWith('https://mail.google.com'), 30000);
    // The first time after connecting it by hand: Nuvia signs Streak back in, hidden.
    const started = Date.now();
    await gmail.waitFor(`document.getElementById('streak-prompt')`, { timeout: 15000 });
    await gmail.waitFor(`document.documentElement.dataset.streak === 'connected' && !document.getElementById('streak-prompt')`, { timeout: 30000 });
    const seconds = (Date.now() - started) / 1000;
    assert.ok(seconds < 22, `connected in ${seconds}s`);
    // Reloads: Streak finds its saved sign-in, and never asks again.
    for (let reload = 0; reload < 2; reload++) {
      await gmail.eval('location.reload(); return true').catch(() => {});
      await new Promise(done => setTimeout(done, 1000));
      await gmail.waitFor(`document.documentElement.dataset.streak === 'connected'`, { timeout: 15000 });
      await new Promise(done => setTimeout(done, 2500));
      assert.equal(await gmail.eval(`return Boolean(document.getElementById('streak-prompt'))`), false, `no "Accedi per usare Streak" after reload ${reload + 1}`);
    }
    const log = nuviaLog();
    assert.equal(log.match(/Streak signing in again/g)?.length, 1, 'signed in again once, not at every reload');
    assert.match(log, /sign-in Gmail Unipd \(window\) accounts\.google\.com \/o\/oauth2\/v2\/auth account/, 'the late account choice was picked');
    assert.match(log, /sign-in Gmail Unipd \(window\) accounts\.google\.com \/signin\/oauth\/id continue/, '"Sign in to Streak" was confirmed');
    assert.match(log, /accounts\.google\.com \/signin\/oauth\/v3\/consent continue/, 'the consent page was confirmed');
    assert.doesNotMatch(log, /\/consent account/, 'the account chip on the consent page is never clicked');
    assert.doesNotMatch(log, /sign-in window shown/, 'the window stayed hidden');
    const notes = await ui.eval('return window.nuvia.listNotifications()');
    assert.ok(!notes.some(note => /needs you to finish/.test(note.body)), 'no "needs you" notification');
  } catch (error) {
    throw new Error(`${error.message}\n--- Nuvia log ---\n${nuviaLog().slice(-3000)}\n--- Electron log ---\n${app.output().slice(-2000)}`);
  } finally {
    gmail?.close(); ui?.close(); await app.close();
  }
});
