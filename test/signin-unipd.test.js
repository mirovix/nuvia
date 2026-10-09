// Gmail of the University of Padova (Google Workspace + Shibboleth SSO) signing
// out every day: Google ends the Workspace session, sends the tab to
// accounts.google.com, which hands over to shibidp.cca.unipd.it. Nuvia must get
// through both pages by itself with the sign-in it remembered.
// The pages are fixtures (test/fixtures): accounts.google.com.html,
// shibidp.cca.unipd.it.html (UniPD's real form and scripts) and workspace.nuvia.test.html.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, writeProfile, sleep, project } from './helpers.js';

const STUDENT = 'mario.rossi@studenti.unipd.it';
const PASSWORD = 'Segreta-123';

test('UniPD Gmail stays signed in through Google and the UniPD SSO', { timeout: 300000 }, async t => {
  const app = await launch({
    prepare: profile => {
      const fixtures = join(profile, 'fixtures');
      cpSync(join(project, 'test', 'fixtures'), fixtures, { recursive: true });
      process.env.NUVIA_FIXTURES = fixtures;
      writeProfile(profile, {
        'services.json': [{ id: 'unipd', name: 'Gmail UniPD', url: 'https://workspace.nuvia.test/' }],
        'preferences.json': { migrations: ['ai-services-1'], name: 'Tester', city: 'Padova' }
      });
    }
  });
  const signInLog = () => readFileSync(join(app.profile, 'nuvia.log'), 'utf8').split('\n').filter(line => / sign-in Gmail UniPD /.test(line));
  const pageOn = host => app.page(target => target.type === 'page' && new URL(target.url).hostname === host, 30000);
  const inbox = async () => {
    const page = await pageOn('workspace.nuvia.test').catch(async error => { throw new Error(`${error.message}: ${(await app.targets()).map(target => target.url).join(' ')}`); });
    try { return await page.waitFor(`document.querySelector('h1')?.innerText === 'Inbox' && document.querySelector('#who').innerText`, { timeout: 40000 }); } finally { page.close(); }
  };
  // Google ends the Workspace session: the mailbox reloads into the sign-in flow.
  const expired = () => signInLog().filter(line => /session expired, sign-in page accounts\.google\.com/.test(line)).length;
  const expire = async () => {
    const before = expired();
    const page = await pageOn('workspace.nuvia.test');
    await page.eval(`localStorage.removeItem('session'); setTimeout(() => location.reload(), 50); return true`).catch(() => {});
    page.close();
    for (let waited = 0; expired() === before; waited += 200) {
      if (waited > 20000) throw new Error('the mailbox did not go to the sign-in page');
      await sleep(200);
    }
  };
  // What the IdP received: a refused sign-in stays on its page with the username in the URL.
  const idpRefused = async () => (await app.targets()).filter(target => target.type === 'page' && /^https:\/\/shibidp\.cca\.unipd\.it\/.*err=1/.test(target.url)).map(target => new URL(target.url).searchParams.get('as'));
  const idpPasswords = () => signInLog().filter(line => /shibidp\.cca\.unipd\.it password/.test(line)).length;
  let ui;
  try {
    ui = await app.ui();

    await t.test('the sign-in typed once on the UniPD page is remembered with its domain', async () => {
      await ui.eval(`document.querySelector('.service[data-id="unipd"]').click()`);
      const google = await pageOn('accounts.google.com');
      await google.waitFor(`document.querySelector('#identifierId')`);
      await google.eval(`document.querySelector('#identifierId').value = ${JSON.stringify(STUDENT)}; document.querySelector('#next').click(); return true`).catch(() => {});
      google.close();
      // Like a student: short username, "@studenti.unipd.it" picked, Enter in the password field.
      const idp = await pageOn('shibidp.cca.unipd.it');
      await idp.waitFor(`document.querySelector('#j_username_js').value === 'nome.cognome'`);
      await idp.eval(`
        const user = document.querySelector('#j_username_js'); user.focus(); user.value = 'mario.rossi';
        document.querySelector('#radio2').click();
        const password = document.querySelector('#password'); password.focus(); password.value = ${JSON.stringify(PASSWORD)};
        password.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        password.form.requestSubmit(); return true`).catch(() => {});
      idp.close();
      assert.equal(await inbox(), STUDENT);
      const saved = await ui.waitFor(`window.nuvia.signInGet('unipd').then(s => s.saved && s.username)`, { timeout: 15000 });
      assert.equal(saved, STUDENT, 'the username is the full address, so Google can be filled too');
    });

    await t.test('when the session expires, Nuvia signs back in through Google and UniPD by itself', async () => {
      await expire();
      // The mailbox shows the username the IdP received: the full address, never
      // the page's "nome.cognome" hint or the default @unipd.it domain.
      assert.equal(await inbox(), STUDENT);
      const lines = signInLog();
      assert.ok(lines.some(line => /accounts\.google\.com username/.test(line)), lines.join('\n'));
      assert.ok(lines.some(line => /shibidp\.cca\.unipd\.it password/.test(line)), lines.join('\n'));
      assert.ok(lines.some(line => /signed back in automatically/.test(line)), lines.join('\n'));
    });

    await t.test('it signs in again the next day too (repeated expiries)', async () => {
      for (let day = 0; day < 2; day++) { await expire(); assert.equal(await inbox(), STUDENT); }
    });

    await t.test('staff accounts on @unipd.it reach the IdP as @unipd.it, at most twice when refused', async () => {
      // The IdP fixture only accepts the student, so the staff sign-in is refused:
      // what matters is the address it received and that Nuvia then stops.
      await ui.eval(`await window.nuvia.signInSet('unipd', { username: 'mario.rossi@unipd.it', password: ${JSON.stringify(PASSWORD)} }); return true`);
      const before = idpPasswords();
      await expire();
      await sleep(15000);
      assert.deepEqual(await idpRefused(), ['mario.rossi@unipd.it']);
      const tries = idpPasswords() - before;
      assert.ok(tries >= 1 && tries <= 2, `${tries} attempts`);
    });

    await t.test('a wrong saved password is tried at most twice, then you are told', async () => {
      await ui.eval(`await window.nuvia.signInSet('unipd', { username: ${JSON.stringify(STUDENT)}, password: 'wrong' }); return true`);
      const before = idpPasswords();
      await sleep(20000);
      const tries = idpPasswords() - before;
      assert.ok(tries >= 1 && tries <= 2, `${tries} attempts`);
      assert.deepEqual(await idpRefused(), [STUDENT]);
      const notifications = await ui.eval(`return window.nuvia.listNotifications()`);
      assert.ok(notifications.some(item => /could not sign in automatically/i.test(item.body || '')), JSON.stringify(notifications.map(item => item.body)));
    });

    await t.test('after a wrong password, the right one typed by hand signs in and is remembered', async () => {
      const idp = await pageOn('shibidp.cca.unipd.it');
      await idp.waitFor(`document.querySelector('#j_username_js')`);
      await sleep(300);
      await idp.eval(`
        const user = document.querySelector('#j_username_js'); user.focus(); user.value = 'mario.rossi';
        document.querySelector('#radio2').click();
        const password = document.querySelector('#password'); password.focus(); password.value = ${JSON.stringify(PASSWORD)};
        document.querySelector('#login_button_js').click(); return true`).catch(() => {});
      idp.close();
      assert.equal(await inbox(), STUDENT);
      await ui.waitFor(`window.nuvia.signInGet('unipd').then(s => s.username === ${JSON.stringify(STUDENT)})`, { timeout: 15000 });
      await expire();
      assert.equal(await inbox(), STUDENT);
    });
  } finally {
    ui?.close();
    await app.close();
  }
});
