import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, writeProfile, project, sleep } from './helpers.js';

// Sites whose sign-in page is found by its path (/scripts/login.pl) or by its
// form, and that sign in from a "Log in" link instead of a button (PaperCept).
test('automatic sign-in on a PaperCept-style conference site', { timeout: 120000 }, async () => {
  const app = await launch({
    prepare: profile => {
      const fixtures = join(profile, 'fixtures');
      cpSync(join(project, 'test', 'fixtures'), fixtures, { recursive: true });
      process.env.NUVIA_FIXTURES = fixtures;
      writeProfile(profile, { 'services.json': [{ id: 'ras', name: 'RAS', url: 'https://papers.nuvia.test/conferences/scripts/login.pl' }], 'preferences.json': {} });
    }
  });
  let ui; let page;
  const rasPage = () => app.page(target => target.type === 'page' && target.url.startsWith('https://papers.nuvia.test'), 30000);
  const nuviaLog = () => { try { return readFileSync(join(app.profile, 'nuvia.log'), 'utf8'); } catch { return ''; } };
  try {
    ui = await app.ui();
    assert.equal((await ui.eval(`return window.nuvia.signInSet('ras', { username: '12345', password: 'Conf-pass-1' })`))?.saved ?? true, true);
    await ui.eval(`document.querySelector('.service[data-id="ras"]').click(); return true`);
    // 1. The login page (found by its path): filled, then the "Log in" link.
    page = await rasPage();
    await page.waitFor(`document.querySelector('h1')?.innerText || document.getElementById('err')?.textContent`, { timeout: 30000 });
    assert.match(await page.eval(`return document.querySelector('h1')?.innerText || 'not signed in: ' + document.getElementById('err')?.textContent + ' | ' + location.href`), /conference home/);
    page.close();
    // 2. The session expires: the form shows up on start.pl (found by the form).
    page = await rasPage();
    await page.eval(`localStorage.removeItem('session'); location.reload(); return true`).catch(() => {});
    page.close();
    await sleep(1500);
    page = await rasPage();
    assert.match(await page.waitFor(`document.querySelector('h1')?.innerText`, { timeout: 30000 }), /conference home/, 'signed back in on start.pl');
    const log = nuviaLog().split('\n').filter(line => / sign-in RAS /.test(line));
    assert.ok(log.some(line => /papers\.nuvia\.test password/.test(line)), log.join('\n'));
    assert.ok(!nuviaLog().includes('Conf-pass-1'), 'no password in the log');
  } catch (error) {
    throw new Error(`${error.message}\n--- Nuvia log ---\n${nuviaLog().slice(-2000)}\n--- Electron log ---\n${app.output().slice(-2500)}`);
  } finally {
    page?.close(); ui?.close(); await app.close();
  }
});
