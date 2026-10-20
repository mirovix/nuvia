import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, writeProfile, project, sleep } from './helpers.js';

// Streak connects through its own window (streak.com, mailfoogae.appspot.com).
// It used to open in the system browser, where the connection never reached
// Gmail in Nuvia. An extension's windows to its own hosts now stay in Nuvia.
test('an extension’s sign-in window opens inside the service, other links outside', { timeout: 90000 }, async () => {
  const app = await launch({
    prepare: profile => {
      const fixtures = join(profile, 'fixtures');
      cpSync(join(project, 'test', 'fixtures'), fixtures, { recursive: true });
      process.env.NUVIA_FIXTURES = fixtures;
      const dir = join(profile, 'marketplace-extensions', 'crmhelper');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ manifest_version: 3, version: '1.0.0', name: 'CRM Helper',
        host_permissions: ['*://mail.google.com/', '*://*.crm.nuvia.test/'], externally_connectable: { matches: ['https://*.crm.nuvia.test/*'] },
        content_scripts: [{ matches: ['https://mail.google.com/*'], js: ['c.js'] }] }));
      writeFileSync(join(dir, 'c.js'), "document.documentElement.dataset.crm = 'on';");
      writeProfile(profile, { 'services.json': [{ id: 'gmail', name: 'Gmail Test', url: 'https://mail.google.com/mail/u/0/#inbox' }], 'preferences.json': {}, 'extensions.json': [dir] });
    }
  });
  let ui; let gmail;
  const nuviaLog = () => { try { return readFileSync(join(app.profile, 'nuvia.log'), 'utf8'); } catch { return ''; } };
  try {
    ui = await app.ui();
    await ui.eval(`document.querySelector('.service[data-id="gmail"]').click(); return true`);
    gmail = await app.page(target => target.type === 'page' && target.url.startsWith('https://mail.google.com'), 30000);
    await gmail.waitFor(`document.documentElement.dataset.crm === 'on'`, { timeout: 30000 });
    await gmail.eval(`window.open('https://app.crm.nuvia.test/connect'); window.open('https://elsewhere.nuvia.test/page'); return true`);
    const popup = await app.page(target => target.type === 'page' && target.url.startsWith('https://app.crm.nuvia.test/'), 20000);
    assert.ok(popup, 'the extension’s window opened in Nuvia');
    popup.close();
    await sleep(800);
    assert.match(nuviaLog(), /external https:\/\/elsewhere\.nuvia\.test\/page/, 'unrelated links still go to the browser');
    assert.doesNotMatch(nuviaLog(), /external https:\/\/app\.crm\.nuvia\.test/);
  } catch (error) {
    throw new Error(`${error.message}\n--- Nuvia log ---\n${nuviaLog().slice(-1500)}\n--- Electron log ---\n${app.output().slice(-2500)}`);
  } finally {
    gmail?.close(); ui?.close(); await app.close();
  }
});
