// Integration test against the real services (network required).
// Covers what the fixture-based UI test cannot: real geocoding/routing, trains,
// weather, Chrome Web Store installs (Streak on a real Gmail page), DRM for
// Spotify, WhatsApp's browser check, local Claude/Codex logs and IAS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { launch, writeProfile, sleep } from './helpers.js';

const STREAK = 'pnnfemgpilpdaojpnkjdgfgbnnjojfik';

test('Nuvia with the real services', { timeout: 600000 }, async t => {
  const app = await launch({
    env: { CODEX_HOME: join(homedir(), '.codex'), CLAUDE_CONFIG_DIR: join(homedir(), '.claude') },
    prepare: profile => writeProfile(profile, {
      'services.json': [
        { id: 'gmail', name: 'Gmail', url: 'https://mail.google.com/' },
        { id: 'wa', name: 'WhatsApp', url: 'https://web.whatsapp.com/' },
        { id: 'spotify', name: 'Spotify', url: 'https://open.spotify.com/' }
      ],
      'preferences.json': { migrations: ['ai-services-1'], city: 'Padova' }
    })
  });
  let ui;
  try {
    ui = await app.ui();

    await t.test('addresses: Via Tiepolo stays in Padova, Corso Palladio in Vicenza', async () => {
      const origin = await ui.eval(`return window.nuvia.suggestPlaces('Via tiepolo padova', '')`);
      assert.match(origin[0].label, /Tiepolo, Padova$/, JSON.stringify(origin.slice(0, 3)));
      const route = await ui.eval(`return window.nuvia.route({ origin: 'Via tiepolo padova', destination: 'Corso Palladio 98', city: 'Vicenza', mode: 'car' })`);
      assert.match(route.origin.label, /Padova/);
      assert.match(route.destination.label, /Palladio 98, Vicenza/);
      assert.ok(route.minutes > 20 && route.minutes < 120, `${route.minutes} min`);
      assert.ok(route.kilometers > 25 && route.kilometers < 60, `${route.kilometers} km`);
      assert.ok(route.steps.length > 3 && route.geometry.length > 10);
      assert.match(route.steps[0].text, /^Head out/);
      const bike = await ui.eval(`return window.nuvia.route({ originPlace: ${JSON.stringify(route.origin)}, destinationPlace: ${JSON.stringify(route.destination)}, mode: 'bike' })`);
      assert.ok(bike.minutes > route.minutes, 'cycling takes longer');
      const station = await ui.eval(`return window.nuvia.route({ origin: 'Stazione di Padova', destination: 'Piazza Garibaldi', city: 'Padova' })`);
      assert.ok(station.kilometers < 5);
    });

    await t.test('commute from the overview: map with A and B', async () => {
      await ui.eval(`
        const [a, b] = document.querySelectorAll('.route-form .suggest input');
        a.value = 'Via tiepolo padova'; a.dispatchEvent(new Event('input', { bubbles: true }));
        b.value = 'Corso Palladio 98'; b.dispatchEvent(new Event('input', { bubbles: true }));
        const city = document.querySelector('.route-form > input'); city.value = 'Vicenza'; city.dispatchEvent(new Event('change'));
        document.querySelector('.route-form .btn.accent').click();`);
      await ui.waitFor(`document.querySelectorAll('.widget[data-widget="commute"] .leaflet-marker-icon').length === 2`, { timeout: 60000 });
      assert.match(await ui.eval(`return document.querySelector('.route-ends').innerText`), /Vicenza/);
    });

    await t.test('ViaggiaTreno and Ritardometro', async () => {
      let train = null;
      for (const number of ['9626', '9624', '2090', '16079', '9412']) {
        try { train = await ui.eval(`return window.nuvia.trainStatus('${number}')`); break; } catch {}
      }
      if (!train) return t.skip('none of the sample trains runs today');
      assert.equal(typeof train.delay, 'number');
      assert.ok(train.destination);
      assert.ok(Array.isArray(train.stops));
      const imported = await ui.eval('return window.nuvia.trainImport()');
      assert.ok(imported.station && imported.times.length, JSON.stringify(imported));
      const board = await ui.eval(`return window.nuvia.trainBoard({ station: ${JSON.stringify(imported.station)}, destinations: [] })`);
      assert.ok(Array.isArray(board) && board.length > 0, 'empty departures board');
      assert.match(board[0].time, /^\d{2}:\d{2}$/);
    });

    await t.test('weather', async () => {
      await ui.waitFor(`window.__nuviaDebug.state.weather && !window.__nuviaDebug.state.weather.error`, { timeout: 30000 });
      assert.match(await ui.eval(`return document.querySelector('#weather-card').innerText`), /Padova|Padua/);
    });

    await t.test('Streak from the Chrome Web Store: Gmail only and Nuvia stays up', async () => {
      const results = await ui.eval(`return window.nuvia.searchExtensions('streak crm for gmail')`);
      assert.ok(results.length > 0);
      const installed = await ui.eval(`return window.nuvia.installExtension('${STREAK}')`, { timeout: 180000 });
      assert.match(installed.name, /Streak/);
      assert.deepEqual(installed.enabledOn, ['Gmail']);
      const list = await ui.eval('return window.nuvia.listExtensions()');
      const streak = list.find(item => item.id === STREAK);
      assert.equal(streak.rules.gmail, true);
      assert.equal(streak.rules.wa, false);
      assert.equal(streak.rules.spotify, false);
      await ui.eval(`document.querySelector('.service[data-id="gmail"]').click()`);
      await ui.waitFor(`window.nuvia.debugState().then(s => s.activeKey === 'gmail' && s.attached)`, { timeout: 30000 });
      await sleep(15000);
      const state = await ui.eval('return window.nuvia.debugState()');
      assert.equal(state.uiExtensions, 0, "extensions must not enter Nuvia's UI");
      const live = await ui.eval('return window.nuvia.serviceState()');
      assert.notEqual(live.find(item => item.id === 'gmail')?.crashed, true);
      assert.equal(await ui.eval('return 1 + 1'), 2, 'the UI responds');
      await ui.eval(`document.querySelector('[data-route="home"]').click()`);
    });

    await t.test('Spotify: web player with Widevine and no Electron user agent', async () => {
      await ui.eval(`window.nuvia.musicState()`);
      const spotify = await app.page(target => target.type === 'page' && /open\.spotify\.com/.test(target.url), 40000);
      await spotify.waitFor('document.body?.innerText?.length > 20', { timeout: 30000 });
      const page = await spotify.eval(`
        let widevine = false;
        try { await navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{ initDataTypes: ['cenc'], audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"', robustness: 'SW_SECURE_CRYPTO' }] }]); widevine = true; } catch {}
        return { userAgent: navigator.userAgent, widevine };`);
      spotify.close();
      assert.match(page.userAgent, /Chrome\/\d+/);
      assert.doesNotMatch(page.userAgent, /Electron/i);
      assert.equal(page.widevine, true);
      assert.equal((await ui.eval('return window.nuvia.debugState()')).attached, false, 'Spotify runs in the background');
      assert.equal(typeof (await ui.eval('return window.nuvia.musicState()')).connected, 'boolean');
    });

    await t.test('WhatsApp Web accepts the browser', async () => {
      const whatsapp = await app.page(target => target.type === 'page' && /web\.whatsapp\.com/.test(target.url), 40000);
      await whatsapp.waitFor('document.body?.innerText?.length > 20', { timeout: 40000 });
      const page = await whatsapp.eval(`return { userAgent: navigator.userAgent, text: document.body.innerText.slice(0, 1500) }`);
      whatsapp.close();
      assert.doesNotMatch(page.userAgent, /Electron/i);
      assert.doesNotMatch(page.text, /aggiorna.*(?:Chrome|Google)|update.*chrome/i);
      const feed = await ui.eval('return window.nuvia.messages()');
      assert.ok(Array.isArray(feed.items) && feed.sources.some(source => source.serviceId === 'wa'));
    });

    await t.test('sign-ins survive: Chromium does not delete a login domain as a tracker', async () => {
      // Chromium's DIPS deletes the storage of a site that writes cookies but
      // never gets a click of its own. Single-sign-on domains work exactly that
      // way, which signed the user out of Outlook and Teams about once a day.
      const partition = await ui.eval(`return (await window.nuvia.listServices())[0]?.id || null`);
      assert.ok(partition, 'a service to test with');
      const before = await ui.eval(`return window.nuvia.debugCookies(${JSON.stringify(partition)})`);
      assert.equal(before.value, 'kept', 'the session cookie comes back after a restart');
      assert.ok(before.encrypted, 'and it is stored encrypted');
      // The feature must be off: with it on, the file below reappears and the
      // timer starts deleting storage again.
      const dips = join(app.profile, 'Partitions', `nuvia-${partition}`, 'DIPS');
      assert.ok(!existsSync(dips), `Chromium still runs its tracker cleanup (${dips})`);
    });

    await t.test('Claude & Codex from local logs', async () => {
      if (!existsSync(join(homedir(), '.codex')) && !existsSync(join(homedir(), '.claude'))) return t.skip('no local logs');
      const usage = await ui.eval('return window.nuvia.aiUsage({})', { timeout: 60000 });
      if (existsSync(join(homedir(), '.codex', 'sessions'))) assert.equal(typeof usage.codex.tokens.week, 'number');
      if (existsSync(join(homedir(), '.claude', 'projects'))) assert.equal(typeof usage.claude.tokens.week, 'number');
      assert.equal(usage.error, null);
    });

    await t.test('DEI Labs: native sign-in and lab list (no check-in recorded)', async () => {
      if (!process.env.DEI_USER || !process.env.DEI_PASSWORD) return t.skip('DEI_USER/DEI_PASSWORD not set');
      const state = await ui.eval('return window.nuvia.iasState()', { timeout: 90000 });
      assert.equal(state.configured, true, JSON.stringify(state));
      assert.ok(state.inside || state.labs.length > 0, JSON.stringify(state));
    });

    await t.test('after all this the UI is still healthy', async () => {
      const errors = ui.logs.filter(entry => entry.type === 'exception');
      assert.deepEqual(errors, []);
      await ui.eval(`document.querySelector('[data-route="messages"]').click()`);
      await ui.waitFor(`!document.querySelector('#page-messages').hidden`);
    });
  } catch (error) {
    throw new Error(`${error.message}\n--- Electron log ---\n${app.output().slice(-4000)}`);
  } finally {
    ui?.close();
    await app.close();
  }
});
