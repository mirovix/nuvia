import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync } from 'node:fs';
import { join } from 'node:path';
import { launch, writeProfile, project } from './helpers.js';

test('Teams can be added and keeps Microsoft sign-in inside Nuvia', { timeout: 90000 }, async () => {
  const app = await launch({
    prepare: profile => {
      const fixtures = join(profile, 'fixtures');
      cpSync(join(project, 'test', 'fixtures'), fixtures, { recursive: true });
      process.env.NUVIA_FIXTURES = fixtures;
      writeProfile(profile, { 'services.json': [], 'preferences.json': {} });
    }
  });
  let ui; let teams; let login;
  try {
    ui = await app.ui();
    await ui.eval(`document.querySelector('#add-service').click(); return true`);
    await ui.waitFor(`document.querySelector('#service-dialog[open]')`);
    const preset = await ui.eval(`
      const button = [...document.querySelectorAll('#service-dialog .preset')].find(item => item.innerText.includes('Microsoft Teams'));
      button.click();
      const [name, url] = document.querySelectorAll('#service-dialog input');
      const values = [name.value, url.value];
      document.querySelector('#save-service').click();
      return values;`);
    assert.deepEqual(preset, ['Microsoft Teams', 'https://teams.microsoft.com/v2/']);
    await ui.waitFor(`document.querySelector('#page-title').textContent === 'Microsoft Teams'`);
    const saved = await ui.eval(`const service = (await window.nuvia.listServices()).find(item => item.name === 'Microsoft Teams'); return { service, state: window.__nuviaDebug.state.services.find(item => item.name === 'Microsoft Teams') }`);
    assert.equal(saved.service.url, 'https://teams.microsoft.com/v2/');
    assert.equal(saved.state.kind, 'teams');
    assert.equal(saved.state.group, 'message');
    teams = await app.page(target => target.type === 'page' && target.url.startsWith('https://teams.microsoft.com/'));
    assert.match(await teams.waitFor('document.body.innerText'), /Teams is ready/);
    await teams.eval(`window.open('https://login.microsoftonline.com/'); return true`);
    login = await app.page(target => target.type === 'page' && target.url.startsWith('https://login.microsoftonline.com/'));
    assert.match(await login.waitFor('document.body.innerText'), /Next/);
    // Sign-in pages get no passkeys, so Microsoft asks for the password Nuvia can fill.
    assert.deepEqual(await login.eval(`
      const refused = await navigator.credentials.get({ publicKey: { challenge: new Uint8Array(8) } }).then(() => null, error => error.name);
      return { passkeyApi: typeof window.PublicKeyCredential, refused };`), { passkeyApi: 'undefined', refused: 'NotAllowedError' });
    assert.notEqual(await teams.eval('return typeof window.PublicKeyCredential'), 'undefined', 'the app pages themselves are untouched');

    // Teams joins the unified inbox: its chats are read, opened and replied to.
    await ui.eval(`document.querySelector('[data-route="messages"]').click(); return true`);
    await ui.waitFor(`[...document.querySelectorAll('#message-feed .bubble strong')].some(el => el.textContent === 'Team Nuvia')`, { timeout: 30000 });
    const chats = await ui.eval(`return [...document.querySelectorAll('#message-feed .bubble')].map(b => b.innerText.replace(/\\s+/g, ' '))`);
    assert.match(chats.join('|'), /Team Nuvia.*standup in 10 minutes/);
    assert.match(chats.join('|'), /Prof\. Bianchi.*read the draft today/);
    assert.ok(!chats.some(text => /Activity|Calendar/.test(text)), 'the Teams app rail is not mistaken for chats');
    assert.match(await ui.eval(`return [...document.querySelectorAll('#page-messages .source')].find(b => b.innerText.includes('Microsoft Teams'))?.innerText || ''`), /3/, 'the unread badge is counted');

    await ui.eval(`[...document.querySelectorAll('#message-feed .bubble')].find(b => b.innerText.includes('Team Nuvia')).click(); return true`);
    await ui.waitFor(`!document.querySelector('#composer').hidden && document.querySelector('#reply-target').innerText.includes('Team Nuvia')`);
    await ui.eval(`const input = document.querySelector('#reply-input'); input.value = 'On my way'; document.querySelector('#composer .btn.accent').click(); return true`);
    assert.deepEqual(await teams.waitFor('window.sent.length ? window.sent[0] : null', { timeout: 20000 }), { chat: 'Team Nuvia', text: 'On my way' });
  } catch (error) {
    throw new Error(`${error.message}\n--- Electron log ---\n${app.output().slice(-4000)}`);
  } finally {
    login?.close(); teams?.close(); ui?.close(); await app.close();
  }
});
