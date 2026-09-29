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

test('Nuvia con i servizi reali', { timeout: 600000 }, async t => {
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

    await t.test('indirizzi: Via Tiepolo resta a Padova, Corso Palladio a Vicenza', async () => {
      const origin = await ui.eval(`return window.nuvia.suggestPlaces('Via tiepolo padova', '')`);
      assert.match(origin[0].label, /Tiepolo, Padova$/, JSON.stringify(origin.slice(0, 3)));
      const route = await ui.eval(`return window.nuvia.route({ origin: 'Via tiepolo padova', destination: 'Corso Palladio 98', city: 'Vicenza', mode: 'car' })`);
      assert.match(route.origin.label, /Padova/);
      assert.match(route.destination.label, /Palladio 98, Vicenza/);
      assert.ok(route.minutes > 20 && route.minutes < 120, `${route.minutes} min`);
      assert.ok(route.kilometers > 25 && route.kilometers < 60, `${route.kilometers} km`);
      assert.ok(route.steps.length > 3 && route.geometry.length > 10);
      assert.match(route.steps[0].text, /^Parti/);
      const bike = await ui.eval(`return window.nuvia.route({ originPlace: ${JSON.stringify(route.origin)}, destinationPlace: ${JSON.stringify(route.destination)}, mode: 'bike' })`);
      assert.ok(bike.minutes > route.minutes, 'in bici si impiega di più');
      const station = await ui.eval(`return window.nuvia.route({ origin: 'Stazione di Padova', destination: 'Piazza Garibaldi', city: 'Padova' })`);
      assert.ok(station.kilometers < 5);
    });

    await t.test('verso casa dalla panoramica: mappa con A e B', async () => {
      await ui.eval(`
        const [a, b] = document.querySelectorAll('.route-form .suggest input');
        a.value = 'Via tiepolo padova'; a.dispatchEvent(new Event('input', { bubbles: true }));
        b.value = 'Corso Palladio 98'; b.dispatchEvent(new Event('input', { bubbles: true }));
        const city = document.querySelector('.route-form > input'); city.value = 'Vicenza'; city.dispatchEvent(new Event('change'));
        document.querySelector('.route-form .btn.accent').click();`);
      await ui.waitFor(`document.querySelectorAll('.widget[data-widget="commute"] .leaflet-marker-icon').length === 2`, { timeout: 60000 });
      assert.match(await ui.eval(`return document.querySelector('.route-ends').innerText`), /Vicenza/);
    });

    await t.test('ViaggiaTreno e Ritardometro', async () => {
      let train = null;
      for (const number of ['9626', '9624', '2090', '16079', '9412']) {
        try { train = await ui.eval(`return window.nuvia.trainStatus('${number}')`); break; } catch {}
      }
      if (!train) return t.skip('nessuno dei treni di prova circola oggi');
      assert.equal(typeof train.delay, 'number');
      assert.ok(train.destination);
      assert.ok(Array.isArray(train.stops));
      const config = await ui.eval('return window.nuvia.ritardometroConfig()');
      if (process.env.NUVIA_RITARDOMETRO) assert.equal(config.ok, true);
    });

    await t.test('meteo', async () => {
      await ui.waitFor(`window.__nuviaDebug.state.weather && !window.__nuviaDebug.state.weather.error`, { timeout: 30000 });
      assert.match(await ui.eval(`return document.querySelector('#weather-card').innerText`), /Padova/);
    });

    await t.test('Streak dal Chrome Web Store: solo su Gmail e Nuvia non si chiude', async () => {
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
      assert.equal(state.uiExtensions, 0, 'le estensioni non devono entrare nella UI di Nuvia');
      const live = await ui.eval('return window.nuvia.serviceState()');
      assert.notEqual(live.find(item => item.id === 'gmail')?.crashed, true);
      assert.equal(await ui.eval('return 1 + 1'), 2, 'la UI risponde');
      await ui.eval(`document.querySelector('[data-route="home"]').click()`);
    });

    await t.test('Spotify: player web con Widevine e senza user agent Electron', async () => {
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
      assert.equal((await ui.eval('return window.nuvia.debugState()')).attached, false, 'Spotify gira in background');
      assert.equal(typeof (await ui.eval('return window.nuvia.musicState()')).connected, 'boolean');
    });

    await t.test('WhatsApp Web accetta il browser', async () => {
      const whatsapp = await app.page(target => target.type === 'page' && /web\.whatsapp\.com/.test(target.url), 40000);
      await whatsapp.waitFor('document.body?.innerText?.length > 20', { timeout: 40000 });
      const page = await whatsapp.eval(`return { userAgent: navigator.userAgent, text: document.body.innerText.slice(0, 1500) }`);
      whatsapp.close();
      assert.doesNotMatch(page.userAgent, /Electron/i);
      assert.doesNotMatch(page.text, /aggiorna.*(?:Chrome|Google)|update.*chrome/i);
      const feed = await ui.eval('return window.nuvia.messages()');
      assert.ok(Array.isArray(feed.items) && feed.sources.some(source => source.serviceId === 'wa'));
    });

    await t.test('Claude & Codex dai log locali', async () => {
      if (!existsSync(join(homedir(), '.codex')) && !existsSync(join(homedir(), '.claude'))) return t.skip('nessun log locale');
      const usage = await ui.eval('return window.nuvia.aiUsage({})', { timeout: 60000 });
      if (existsSync(join(homedir(), '.codex', 'sessions'))) assert.equal(typeof usage.codex.tokens.week, 'number');
      if (existsSync(join(homedir(), '.claude', 'projects'))) assert.equal(typeof usage.claude.tokens.week, 'number');
      assert.equal(usage.error, null);
    });

    await t.test('laboratorio IAS', async () => {
      const status = await ui.eval('return window.nuvia.iasStatus()');
      if (!status.configured) return t.skip('DEI_USER/DEI_PASSWORD non impostate');
      let labs = await ui.eval('return window.nuvia.iasLabs()', { timeout: 120000 });
      if (!labs.labs?.length && !labs.alreadyInside) labs = await ui.eval('return window.nuvia.iasLabs()', { timeout: 120000 });
      assert.ok(labs.alreadyInside || labs.labs.length > 0, JSON.stringify(labs));
    });

    await t.test('dopo tutto questo la UI è ancora sana', async () => {
      const errors = ui.logs.filter(entry => entry.type === 'exception');
      assert.deepEqual(errors, []);
      await ui.eval(`document.querySelector('[data-route="messages"]').click()`);
      await ui.waitFor(`!document.querySelector('#page-messages').hidden`);
    });
  } catch (error) {
    throw new Error(`${error.message}\n--- log Electron ---\n${app.output().slice(-4000)}`);
  } finally {
    ui?.close();
    await app.close();
  }
});
