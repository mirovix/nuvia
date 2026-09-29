// End-to-end UI test: every page, widget and button, against local fixture services.
// Services are served by fixtures (test/fixtures) through a test-only https handler,
// geocoding/routing/iCal by a local mock server: no account and no network needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, writeProfile, sleep, project } from './helpers.js';

const pad = n => String(n).padStart(2, '0');
const icsStamp = date => `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}00`;

function place(id, road, number, city, lat, lon, importance = 0.2) {
  return { osm_type: 'way', osm_id: id, lat: String(lat), lon: String(lon), importance, display_name: `${number ? `${number}, ` : ''}${road}, ${city}, Veneto, Italia`, address: { road, house_number: number, city, postcode: '35100' } };
}

function mockServer() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://mock');
    const send = (body, type = 'application/json') => { response.writeHead(200, { 'content-type': type, 'access-control-allow-origin': '*' }); response.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    if (url.pathname === '/search') {
      const text = `${url.searchParams.get('q') || ''} ${url.searchParams.get('street') || ''} ${url.searchParams.get('city') || ''}`.toLowerCase();
      if (text.includes('tiepolo')) return send([place(1, 'Via Tiepolo', '', 'Camposampiero', 45.56, 11.93, 0.3), place(2, 'Via Giovanni Battista Tiepolo', '', 'Padova', 45.405, 11.895, 0.1)]);
      if (text.includes('palladio')) return send([place(3, 'Corso Andrea Palladio', '98', 'Vicenza', 45.535, 11.56), place(4, 'Corso Palladio', '98', 'Verona', 45.43, 10.99, 0.3)]);
      return send([]);
    }
    if (url.pathname.includes('/route/v1/')) {
      return send({ routes: [{ duration: 2100, distance: 37800, geometry: { coordinates: [[11.895, 45.405], [11.7, 45.47], [11.56, 45.535]] }, legs: [{ steps: [
        { distance: 160, name: 'Via Giovanni Battista Tiepolo', maneuver: { type: 'depart' } },
        { distance: 900, name: 'Via San Massimo', maneuver: { type: 'turn', modifier: 'right' } },
        { distance: 30000, name: 'A4', maneuver: { type: 'on ramp', modifier: 'slight left' } },
        { distance: 0, name: '', maneuver: { type: 'arrive' } }] }] }] });
    }
    if (url.pathname === '/cal.ics') {
      const start = new Date(); start.setHours(12, 0, 0, 0);
      const end = new Date(start); end.setHours(13);
      const tomorrow = new Date(start); tomorrow.setDate(tomorrow.getDate() + 1);
      return send(`BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:${icsStamp(start)}\r\nDTEND:${icsStamp(end)}\r\nSUMMARY:Pranzo con Anna\r\nLOCATION:Mensa\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:b\r\nDTSTART:${icsStamp(tomorrow)}\r\nSUMMARY:Consegna progetto\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`, 'text/calendar');
    }
    if (url.pathname === '/site') return send('<!doctype html><title>Sito di prova</title><h1>Sito di prova</h1>', 'text/html');
    response.writeHead(404); response.end();
  });
  return new Promise(resolveServer => server.listen(0, '127.0.0.1', () => resolveServer(server)));
}

function extension(root, id, manifest, files = {}) {
  const dir = join(root, 'marketplace-extensions', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ manifest_version: 3, version: '1.0.0', ...manifest }));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

test('Nuvia: ogni pagina, blocco e pulsante', { timeout: 420000 }, async t => {
  const server = await mockServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const now = Date.now();
  const app = await launch({
    env: { NUVIA_NOMINATIM_URL: base, NUVIA_ROUTING_URL: base },
    prepare: profile => {
      const fixtures = join(profile, 'fixtures');
      cpSync(join(project, 'test', 'fixtures'), fixtures, { recursive: true });
      writeFileSync(join(fixtures, 'claude.ai_api_organizations_org-test_usage.json'), JSON.stringify({ five_hour: { utilization: 42, resets_at: new Date(now + 2 * 3600000).toISOString() }, seven_day: { utilization: 17, resets_at: new Date(now + 3 * 86400000).toISOString() } }));
      process.env.NUVIA_FIXTURES = fixtures;
      const codex = join(profile, 'home', '.codex', 'sessions', '2026', '01', '01'); mkdirSync(codex, { recursive: true });
      writeFileSync(join(codex, 'rollout-test.jsonl'), JSON.stringify({ timestamp: new Date(now - 60000).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 1234567, input_tokens: 1200000, cached_input_tokens: 1000000, output_tokens: 34567 } }, rate_limits: { plan_type: 'plus', primary: { used_percent: 63, window_minutes: 300, resets_at: Math.floor((now + 5400000) / 1000) }, secondary: { used_percent: 21, window_minutes: 10080, resets_at: Math.floor((now + 4 * 86400000) / 1000) } } } }));
      const claude = join(profile, 'home', '.claude', 'projects', 'p'); mkdirSync(claude, { recursive: true });
      writeFileSync(join(claude, 's.jsonl'), JSON.stringify({ timestamp: new Date(now - 120000).toISOString(), requestId: 'r1', message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 5000, output_tokens: 700, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }));
      const helper = extension(profile, 'mailhelper', { name: 'Mail Helper', content_scripts: [{ matches: ['https://mail.google.com/*'], js: ['content.js'], run_at: 'document_end' }] }, { 'content.js': "document.documentElement.dataset.mailHelper = 'on';" });
      const crashy = extension(profile, 'crashyext', { name: 'Crashy', content_scripts: [{ matches: ['https://mail.google.com/*'], js: ['c.js'] }] }, { 'c.js': '' });
      writeProfile(profile, {
        'services.json': [
          { id: 'gmail', name: 'Gmail Test', url: 'https://mail.google.com/mail/u/0/#inbox' },
          { id: 'wa', name: 'WhatsApp', url: 'https://web.whatsapp.com/' },
          { id: 'spotify', name: 'Spotify', url: 'https://open.spotify.com/' },
          { id: 'claude', name: 'Claude', url: 'https://claude.ai/new' },
          { id: 'site', name: 'Sito', url: `${base}/site` }
        ],
        'preferences.json': { migrations: ['ai-services-1'], name: 'Tester', city: 'Padova', calendar: { feeds: [{ id: 'ics-test', name: 'Università', url: `${base}/cal.ics` }] } },
        'extensions.json': [helper, crashy],
        // Simulates a previous run that died while Crashy was loading into Gmail.
        'extension-guard.json': { running: true, crashes: 0, pending: { gmail: ['crashyext'] }, loaded: {} }
      });
    }
  });
  let ui;
  try {
    ui = await app.ui();
    const click = selector => ui.eval(`const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error('manca ' + ${JSON.stringify(selector)}); el.click(); return true;`);
    const text = selector => ui.eval(`return document.querySelector(${JSON.stringify(selector)})?.innerText || ''`);
    const debug = () => ui.eval('return window.nuvia.debugState()');

    await t.test('avvio: interfaccia pronta e nessuna estensione nella UI', async () => {
      const info = await ui.eval(`return { bridge: Object.keys(window.nuvia), title: document.querySelector('#page-title').textContent, theme: document.documentElement.dataset.theme, widgets: [...document.querySelectorAll('.widget')].map(w => w.dataset.widget) }`);
      for (const key of ['mail', 'messages', 'calendarEvents', 'musicState', 'route', 'aiUsage', 'setOverlay']) assert.ok(info.bridge.includes(key), key);
      assert.equal(info.title, 'Panoramica');
      assert.equal(info.theme, 'dark');
      assert.deepEqual(info.widgets.slice(0, 3), ['mail', 'calendar', 'messages']);
      assert.equal((await debug()).uiExtensions, 0);
    });

    await t.test('estensioni: quarantena dopo crash e attivazione solo dove serve', async () => {
      const list = await ui.eval('return window.nuvia.listExtensions()');
      const crashy = list.find(item => item.id === 'crashyext');
      const helper = list.find(item => item.id === 'mailhelper');
      assert.equal(crashy.rules.gmail, false, 'Crashy va disattivata su Gmail');
      assert.equal(helper.rules.gmail, true);
      assert.equal(helper.rules.wa, false, 'un content script per Gmail non va su WhatsApp');
      const notifications = await ui.eval('return window.nuvia.listNotifications()');
      assert.ok(notifications.some(item => /Crashy/.test(item.body) && item.title === 'Estensione disattivata'));
      const gmail = await app.page(target => target.url.startsWith('https://mail.google.com'));
      assert.equal(await gmail.waitFor("document.documentElement.dataset.mailHelper"), 'on');
      gmail.close();
      await click('#open-extensions');
      await ui.waitFor(`document.querySelectorAll('#extension-list .ext-row').length === 2`);
      await ui.eval(`[...document.querySelectorAll('#extension-list .ext-row')].find(row => row.innerText.includes('Mail Helper')).querySelectorAll('.ext-services .chip')[1].click()`);
      await ui.waitFor(`window.nuvia.listExtensions().then(list => list.find(item => item.id === 'mailhelper').rules.wa === true)`);
      await ui.eval(`document.querySelector('#extensions-dialog').close()`);
    });

    await t.test('navigazione: ogni voce apre la sua pagina', async () => {
      for (const [route, title] of [['messages', 'Messaggi'], ['calendar', 'Calendario'], ['music', 'Musica'], ['ai', 'Claude & Codex'], ['home', 'Panoramica']]) {
        await click(`[data-route="${route}"]`);
        await ui.waitFor(`!document.querySelector('#page-${route}').hidden && document.querySelector('#page-title').textContent === ${JSON.stringify(title)} && document.querySelector('[data-route="${route}"]').classList.contains('active')`);
      }
    });

    await t.test('posta: anteprima delle email nuove e apertura del thread', async () => {
      await ui.waitFor(`document.querySelectorAll('.widget[data-widget="mail"] .row').length === 2`, { timeout: 30000 });
      const rows = await ui.eval(`return [...document.querySelectorAll('.widget[data-widget="mail"] .row')].map(row => row.innerText.replace(/\\s+/g, ' '))`);
      assert.match(rows.join('|'), /Anna Rossi.*Verbale riunione.*Ti giro il verbale/);
      assert.match(await text('.widget[data-widget="mail"] .w-meta'), /2 da leggere/);
      await ui.eval(`[...document.querySelectorAll('.widget[data-widget="mail"] .row')].find(row => row.innerText.includes('Anna')).click()`);
      await ui.waitFor(`document.querySelector('#page-title').textContent === 'Gmail Test'`);
      const gmail = await app.page(target => target.url.startsWith('https://mail.google.com'));
      assert.equal(await gmail.waitFor('document.body.dataset.opened'), '#inbox/18f2a3b4c5d6e7f8');
      gmail.close();
      assert.equal((await debug()).attached, true);
      await click('[data-route="home"]');
    });

    await t.test('messaggi: inbox unificata come una chat e risposta rapida', async () => {
      await click('[data-route="messages"]');
      await ui.waitFor(`document.querySelectorAll('#message-feed .bubble').length === 3`, { timeout: 30000 });
      const order = await ui.eval(`return [...document.querySelectorAll('#message-feed .bubble strong')].map(el => el.textContent)`);
      assert.deepEqual(order, ['Gruppo Lab', 'Giulia', 'Mamma'], 'dal più vecchio al più recente, come una chat');
      assert.ok(await ui.eval(`return [...document.querySelectorAll('#message-feed .day')].map(el => el.textContent).includes('Oggi') || document.querySelectorAll('#message-feed .day').length >= 2`));
      await ui.eval(`document.querySelector('#unread-filter input').click()`);
      await ui.waitFor(`document.querySelectorAll('#message-feed .bubble').length === 2`);
      await ui.eval(`document.querySelector('#unread-filter input').click()`);
      await ui.eval(`const input = document.querySelector('.chat-head .search'); input.value = 'pane'; input.dispatchEvent(new Event('input'))`);
      await ui.waitFor(`document.querySelectorAll('#message-feed .bubble').length === 1`);
      await ui.eval(`const input = document.querySelector('.chat-head .search'); input.value = ''; input.dispatchEvent(new Event('input'))`);
      await ui.eval(`[...document.querySelectorAll('#message-feed .bubble')].find(b => b.innerText.includes('Mamma')).click()`);
      await ui.waitFor(`!document.querySelector('#composer').hidden && document.querySelector('#reply-target').innerText.includes('Mamma')`);
      await ui.eval(`const input = document.querySelector('#reply-input'); input.value = 'Ok, lo prendo io'; document.querySelector('#composer .btn.accent').click()`);
      const wa = await app.page(target => target.url.startsWith('https://web.whatsapp.com'));
      const sent = await wa.waitFor('window.sent.length && window.sent', { timeout: 15000 });
      assert.deepEqual(sent[0], { chat: 'Mamma', text: 'Ok, lo prendo io' });
      wa.close();
      await ui.eval(`[...document.querySelectorAll('#message-feed .bubble')].find(b => b.innerText.includes('Giulia')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
      await ui.waitFor(`document.querySelector('#page-title').textContent === 'WhatsApp'`);
      await click('[data-route="home"]');
      await ui.waitFor(`document.querySelectorAll('.widget[data-widget="messages"] .bubble').length === 3`);
    });

    await t.test('calendario: eventi da Google e iCal, fonti attivabili, scorrimento', async () => {
      await ui.waitFor(`document.querySelector('.widget[data-widget="calendar"] .events')`, { timeout: 40000 });
      const today = await text('.widget[data-widget="calendar"] .events');
      assert.match(today, /Pranzo con Anna/);
      assert.match(today, /Revisione tesi/);
      await ui.eval(`document.querySelectorAll('.widget[data-widget="calendar"] .week button')[1].click()`);
      await ui.waitFor(`/Lezione di Robotica/.test(document.querySelector('.widget[data-widget="calendar"] .w-body').innerText) && /Consegna progetto/.test(document.querySelector('.widget[data-widget="calendar"] .w-body').innerText)`);
      assert.equal(await ui.eval(`const w = document.querySelector('.widget[data-widget="calendar"]'); return w.draggable`), false, 'il blocco non deve essere trascinabile fuori dalla maniglia');
      await click('[data-route="calendar"]');
      await ui.waitFor(`document.querySelectorAll('#page-calendar .agenda-day').length >= 2`);
      const sources = await ui.eval(`return window.__nuviaDebug.state.calendar.sources.map(s => [s.name, s.ok, s.count])`);
      assert.ok(sources.some(([name, ok, count]) => name === 'Università' && ok && count >= 2));
      assert.ok(sources.some(([name, ok, count]) => name === 'Gmail Test' && ok && count >= 3));
      await ui.eval(`[...document.querySelectorAll('#page-calendar .card .check')].find(row => row.innerText.includes('Università')).querySelector('.toggle').click()`);
      await ui.waitFor(`!/Pranzo con Anna/.test(document.querySelector('#page-calendar').innerText)`, { timeout: 20000 });
      await ui.eval(`[...document.querySelectorAll('#page-calendar .card .check')].find(row => row.innerText.includes('Università')).querySelector('.toggle').click()`);
      await ui.waitFor(`/Pranzo con Anna/.test(document.querySelector('#page-calendar').innerText)`, { timeout: 20000 });
      await click('[data-route="home"]');
    });

    await t.test('musica: player interno con copertina, artista e comandi', async () => {
      const spotify = await app.page(target => target.url.startsWith('https://open.spotify.com'));
      await ui.waitFor(`/Nuvole/.test(document.querySelector('.widget[data-widget="music"] .track')?.innerText) && /Artista Uno/.test(document.querySelector('.widget[data-widget="music"] .track').innerText)`, { timeout: 30000 });
      await ui.eval(`document.querySelector('.widget[data-widget="music"] .play').click()`);
      await ui.waitFor(`window.__nuviaDebug.state.music.paused === false`);
      await ui.eval(`document.querySelector('.widget[data-widget="music"] [title="Successivo"]').click()`);
      await ui.waitFor(`/Sereno/.test(document.querySelector('.widget[data-widget="music"] .track').innerText)`);
      assert.equal((await debug()).attached, false, 'Spotify non deve aprirsi a schermo');
      await click('[data-route="music"]');
      await ui.waitFor(`document.querySelector('.music-hero h2')?.textContent === 'Sereno' && document.querySelector('.music-hero .artist').textContent === 'Artista Due' && document.querySelector('.music-hero .album').textContent === 'Album Test'`);
      for (const title of ['Casuale', 'Ripeti', 'Aggiungi ai preferiti', 'Precedente']) await ui.eval(`document.querySelector('.music-hero [title="${title}"]').click()`);
      await ui.eval(`const bar = document.querySelector('.music-hero .progress'); const r = bar.getBoundingClientRect(); bar.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + 2 }))`);
      await ui.eval(`const v = document.querySelector('.music-hero input[type=range]'); v.value = '80'; v.dispatchEvent(new Event('change'))`);
      const log = await spotify.waitFor(`window.log.includes('volume:0.8') && window.log`, { timeout: 10000 });
      for (const entry of ['play', 'next', 'shuffle', 'repeat', 'like', 'previous']) assert.ok(log.includes(entry), `${entry} in ${log}`);
      assert.ok(log.some(entry => entry.startsWith('seek:')), String(log));
      await ui.waitFor(`document.querySelectorAll('#page-music .library .tile').length === 2`, { timeout: 20000 });
      await ui.eval(`document.querySelector('#page-music .library .tile').click()`);
      // Playing a playlist navigates the hidden player, so its page (and log) is new.
      await spotify.waitFor(`window.log.includes('context:/playlist/37i9dQZF1DX0')`, { timeout: 20000 });
      await ui.eval(`document.querySelectorAll('#page-music .segmented button')[1].click()`);
      await ui.eval(`const input = document.querySelector('#page-music .actions input'); input.value = 'nuvole'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
      await ui.waitFor(`document.querySelectorAll('#page-music .tracks .row').length === 2`, { timeout: 20000 });
      await ui.eval(`document.querySelectorAll('#page-music .tracks .row')[1].click()`);
      await spotify.waitFor(`window.log.includes('track:1')`);
      spotify.close();
      await click('[data-route="home"]');
    });

    await t.test('Claude & Codex: limiti, reset e token', async () => {
      await ui.waitFor(`/63%/.test(document.querySelector('.widget[data-widget="ai"] .w-body')?.innerText) && /42%/.test(document.querySelector('.widget[data-widget="ai"] .w-body').innerText)`, { timeout: 40000 });
      await click('[data-route="ai"]');
      await ui.waitFor(`document.querySelectorAll('#page-ai .card').length === 2`);
      const page = await text('#page-ai');
      assert.match(page, /Sessione · 5 ore/);
      assert.match(page, /42%/);
      assert.match(page, /17%/);
      assert.match(page, /63%/);
      assert.match(page, /21%/);
      assert.match(page, /si azzera tra 1 h 30 min/);
      assert.match(page, /claude max 5x/i);
      assert.match(page, /1,2 mln/);
      await ui.eval(`[...document.querySelectorAll('#page-ai .card')][0].querySelector('.ai-head .btn').click()`);
      await ui.waitFor(`document.querySelector('#page-title').textContent === 'Claude'`);
      await click('[data-route="home"]');
    });

    await t.test('verso casa: indirizzi corretti, mappa A→B e indicazioni', async () => {
      await ui.eval(`document.querySelector('.widget[data-widget="commute"]').scrollIntoView()`);
      await ui.eval(`const [a, b] = document.querySelectorAll('.route-form .suggest input'); a.focus(); a.value = 'Via tiepolo padova'; a.dispatchEvent(new Event('input', { bubbles: true }))`);
      await ui.waitFor(`!document.querySelector('.route-form .suggest .suggestions').hidden`, { timeout: 15000 });
      assert.match(await text('.route-form .suggest .suggestions'), /Tiepolo, Padova/);
      await ui.eval(`document.querySelector('.route-form .suggest .suggestions button').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
      await ui.eval(`const b = document.querySelectorAll('.route-form .suggest input')[1]; b.value = 'Corso Palladio 98'; b.dispatchEvent(new Event('input', { bubbles: true })); const city = document.querySelector('.route-form > input'); city.value = 'Vicenza'; city.dispatchEvent(new Event('change')); document.querySelector('.route-form .btn.accent').click()`);
      await ui.waitFor(`document.querySelectorAll('.widget[data-widget="commute"] .leaflet-marker-icon').length === 2`, { timeout: 20000 });
      const result = await ui.eval(`return { summary: document.querySelector('.route-summary').innerText, ends: document.querySelector('.route-ends').innerText, steps: document.querySelectorAll('.route-steps .step').length, path: document.querySelectorAll('.widget[data-widget="commute"] path.leaflet-interactive').length }`);
      assert.match(result.summary, /35\s*min/);
      assert.match(result.summary, /37,8 km/);
      assert.match(result.ends, /A\s*Via Giovanni Battista Tiepolo, Padova/);
      assert.match(result.ends, /B\s*Corso Andrea Palladio 98, Vicenza/);
      assert.equal(result.steps, 4);
      assert.ok(result.path >= 2);
      assert.match(await text('.route-steps'), /Svolta a destra in Via San Massimo/);
      const prefs = await ui.eval('return window.nuvia.getPreferences()');
      assert.equal(prefs.homeOriginPlace.label, 'Via Giovanni Battista Tiepolo, Padova');
      await ui.eval(`document.querySelectorAll('.route-form .segmented button')[1].click()`);
      await ui.waitFor(`/bici/.test(document.querySelector('.widget[data-widget="commute"] .w-meta').innerText)`);
    });

    await t.test('notifiche: pannello, cancellazione singola e totale', async () => {
      await ui.eval(`await window.nuvia.addNotification({ title: 'Prova A', body: 'uno' }); await window.nuvia.addNotification({ title: 'Prova B', body: 'due' });`);
      await ui.waitFor(`!document.querySelector('#open-notifications .dot-badge').hidden`);
      await click('#open-notifications');
      await ui.waitFor(`document.querySelector('.notif-panel[open] .notif')`);
      const before = await ui.eval(`return document.querySelectorAll('.notif-panel .notif').length`);
      await ui.eval(`[...document.querySelectorAll('.notif-panel .notif')].find(n => n.innerText.includes('Prova A')).querySelector('.delete-notification').click()`);
      await ui.waitFor(`document.querySelectorAll('.notif-panel .notif').length === ${before - 1} && !document.querySelector('.notif-panel').innerText.includes('Prova A')`);
      await click('#clear-notifications');
      await ui.waitFor(`document.querySelectorAll('.notif-panel .notif').length === 0`);
      assert.equal((await ui.eval('return window.nuvia.listNotifications()')).length, 0);
      await ui.eval(`document.querySelector('.notif-panel').close()`);
      await ui.waitFor(`document.querySelector('#open-notifications .dot-badge').hidden && /Nessuna notifica/.test(document.querySelector('.widget[data-widget="notifications"]').innerText)`);
      await ui.eval(`await window.nuvia.addNotification({ title: 'Dal widget', body: 'x' })`);
      await ui.waitFor(`/Dal widget/.test(document.querySelector('.widget[data-widget="notifications"]').innerText)`);
      await ui.eval(`document.querySelector('.widget[data-widget="notifications"] .delete-notification').click()`);
      await ui.waitFor(`!/Dal widget/.test(document.querySelector('.widget[data-widget="notifications"]').innerText)`);
    });

    await t.test('blocchi: opzioni, dimensioni, nascondi, personalizza e trascina', async () => {
      await ui.eval(`document.querySelector('#page-home').scrollTop = 0; document.querySelector('.widget[data-widget="mail"] [data-act="settings"]').click()`);
      await ui.waitFor(`document.querySelector('dialog.popover[open]')`);
      await ui.eval(`[...document.querySelectorAll('dialog.popover .segmented')][0].querySelectorAll('button')[2].click()`);
      await ui.waitFor(`document.querySelector('.widget[data-widget="mail"]').dataset.size === 'l'`);
      await ui.eval(`[...document.querySelectorAll('dialog.popover .segmented')][1].querySelectorAll('button')[2].click()`);
      await ui.waitFor(`document.querySelector('.widget[data-widget="mail"]').dataset.height === 'tall'`);
      await ui.eval(`[...document.querySelectorAll('dialog.popover .check')].find(c => c.innerText.includes('Solo email da leggere')).querySelector('.toggle').click()`);
      await ui.waitFor(`document.querySelectorAll('.widget[data-widget="mail"] .row').length === 3`);
      await ui.eval(`[...document.querySelectorAll('dialog.popover button')].find(b => b.innerText.includes('Nascondi')).click()`);
      await ui.waitFor(`!document.querySelector('.widget[data-widget="mail"]')`);
      await click('#customize');
      await ui.waitFor(`document.querySelector('#customize-dialog[open]')`);
      await ui.eval(`[...document.querySelectorAll('#customize-dialog .layout-row')].find(r => r.innerText.includes('Posta')).querySelector('.toggle').click()`);
      await ui.waitFor(`document.querySelector('.widget[data-widget="mail"]')`);
      await ui.eval(`[...document.querySelectorAll('#customize-dialog .layout-row')].find(r => r.innerText.includes('Calendario')).querySelector('[title="Su"]').click()`);
      await ui.waitFor(`document.querySelector('.widget').dataset.widget === 'calendar'`);
      await ui.eval(`[...document.querySelectorAll('#customize-dialog .segmented')][0].querySelectorAll('button')[1].click()`);
      await ui.waitFor(`getComputedStyle(document.querySelector('#widget-grid')).getPropertyValue('--cols').trim() === '2'`);
      await ui.eval(`[...document.querySelectorAll('#customize-dialog button')].find(b => b.innerText.includes('Ripristina')).click()`);
      await ui.waitFor(`document.querySelector('.widget').dataset.widget === 'mail' && document.querySelector('.widget[data-widget="mail"]').dataset.size === 'm'`);
      await ui.eval(`document.querySelector('#customize-dialog').close()`);
      const order = await ui.eval(`
        const from = document.querySelector('.widget[data-widget="weather"]'); const to = document.querySelector('.widget[data-widget="mail"]');
        from.querySelector('.w-grip').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        const dt = new DataTransfer(); const r = to.getBoundingClientRect();
        from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
        to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 5, clientY: r.top + 5 }));
        from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
        await new Promise(r => setTimeout(r, 400));
        return { dom: [...document.querySelectorAll('.widget')].map(w => w.dataset.widget).slice(0, 2), saved: (await window.nuvia.getPreferences()).widgets.map(w => w.id).slice(0, 2), draggable: from.draggable };`);
      assert.deepEqual(order.dom, ['weather', 'mail']);
      assert.deepEqual(order.saved, ['weather', 'mail']);
      assert.equal(order.draggable, false);
      const scroll = await ui.eval(`const body = document.querySelector('.widget[data-widget="messages"] .w-body'); body.scrollTop = 0; body.scrollTop = 40; return { scrollable: body.scrollHeight > body.clientHeight, top: body.scrollTop }`);
      if (scroll.scrollable) assert.ok(scroll.top > 0, 'il contenuto dei blocchi deve scorrere');
    });

    await t.test('servizi: aggiungi sopra un servizio aperto, modifica, crash e ricarica', async () => {
      await click('.service[data-id="site"]');
      await ui.waitFor(`window.nuvia.debugState().then(s => s.activeKey === 'site' && s.attached)`);
      await click('#add-service');
      await ui.waitFor(`document.querySelector('#service-dialog[open]')`);
      const during = await debug();
      assert.equal(during.attached, false, 'la vista del servizio deve lasciare spazio al popup');
      assert.equal(during.overlayDepth, 1);
      assert.ok(await ui.eval(`return getComputedStyle(document.querySelector('#view-shot')).backgroundImage.startsWith('url(')`), 'screenshot del servizio sotto al popup');
      await ui.eval(`[...document.querySelectorAll('#service-dialog .preset')].find(p => p.innerText.includes('Notion')).click()`);
      assert.equal(await ui.eval(`return document.querySelector('#service-dialog input[type=url]').value`), 'https://www.notion.so/');
      await ui.eval(`const [name, url] = document.querySelectorAll('#service-dialog input'); name.value = 'Secondo sito'; url.value = '${base}/site?2'; document.querySelector('#save-service').click()`);
      await ui.waitFor(`document.querySelector('#page-title').textContent === 'Secondo sito' && !document.querySelector('#service-dialog')`);
      assert.match(await text('#toasts'), /Aggiungine un altro/);
      const after = await debug();
      assert.equal(after.overlayDepth, 0);
      assert.equal(after.attached, true);
      const services = await ui.eval('return window.nuvia.listServices()');
      const added = services.find(service => service.name === 'Secondo sito');
      assert.ok(added);
      await ui.eval(`window.__nuviaDebug.openEditService(${JSON.stringify(added.id)})`);
      await ui.waitFor(`document.querySelector('dialog.sheet[open] input')`);
      await ui.eval(`const name = document.querySelector('dialog.sheet[open] input'); name.value = 'Sito rinominato'; [...document.querySelectorAll('dialog.sheet[open] button')].find(b => b.innerText === 'Salva').click()`);
      await ui.waitFor(`[...document.querySelectorAll('.service .label')].some(el => el.textContent === 'Sito rinominato')`);
      await ui.eval(`window.__nuviaDebug.removeService(${JSON.stringify(added.id)})`);
      await ui.waitFor(`document.querySelector('dialog.sheet[open]')`);
      await ui.eval(`[...document.querySelectorAll('dialog.sheet[open] button')].find(b => b.innerText === 'Rimuovi').click()`);
      await ui.waitFor(`![...document.querySelectorAll('.service .label')].some(el => el.textContent === 'Sito rinominato') && document.querySelector('#page-title').textContent === 'Panoramica'`);
      // A service page that crashes shows a recovery screen instead of a blank view.
      await click('.service[data-id="site"]');
      await ui.waitFor(`window.nuvia.debugState().then(s => s.activeKey === 'site' && s.attached)`);
      const site = await app.page(target => target.url.startsWith(`${base}/site`) && !target.url.includes('?2'));
      site.send('Page.crash');
      await ui.waitFor(`/si è fermato/.test(document.querySelector('#view-state').innerText)`, { timeout: 15000 });
      assert.equal((await debug()).attached, false);
      await ui.eval(`document.querySelector('#view-state .btn').click()`);
      await ui.waitFor(`window.nuvia.debugState().then(s => s.activeKey === 'site' && s.attached)`, { timeout: 15000 });
      await ui.waitFor(`!document.querySelector('.service[data-id="site"]').classList.contains('crashed')`, { timeout: 15000 });
    });

    await t.test('scorciatoie e ricerca rapida', async () => {
      const key = (k, extra = '') => ui.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', ctrlKey: true, bubbles: true ${extra} }))`);
      await key('0');
      await ui.waitFor(`document.querySelector('#page-title').textContent === 'Panoramica'`);
      await key('2');
      await ui.waitFor(`document.querySelector('#page-title').textContent === 'WhatsApp'`);
      await key('k');
      await ui.waitFor(`document.querySelector('dialog.palette[open]')`);
      await ui.eval(`const input = document.querySelector('dialog.palette input'); input.value = 'spot'; input.dispatchEvent(new Event('input')); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))`);
      await ui.waitFor(`document.querySelector('#page-title').textContent === 'Spotify'`);
      await ui.waitFor(`window.nuvia.debugState().then(s => s.overlayDepth === 0 && s.attached && s.activeKey === 'spotify')`);
      await click('#nav-reload');
      await click('[data-route="home"]');
    });

    await t.test('impostazioni: tema, accento, sfondo, nome, città, barra compatta', async () => {
      await click('#open-settings');
      await ui.waitFor(`document.querySelector('#settings-dialog[open]')`);
      await ui.eval(`[...document.querySelectorAll('#settings-dialog .segmented button')].find(b => b.innerText.includes('Chiaro')).click()`);
      assert.equal(await ui.eval(`return document.documentElement.dataset.theme`), 'light');
      await ui.eval(`document.querySelector('#settings-dialog [data-accent="lime"]').click()`);
      assert.equal(await ui.eval(`return document.documentElement.dataset.accent`), 'lime');
      await ui.eval(`document.querySelector('#settings-dialog [data-bg="grain"]').click()`);
      assert.equal(await ui.eval(`return document.body.dataset.bg`), 'grain');
      await ui.eval(`document.querySelector('#settings-dialog .check .toggle').click()`);
      assert.equal(await ui.eval(`return document.body.classList.contains('sidebar-collapsed')`), true);
      await ui.eval(`document.querySelector('#settings-dialog .tabs [data-tab="general"]').click()`);
      await ui.eval(`const name = document.querySelector('#settings-dialog .field input'); name.value = 'Miro'; name.dispatchEvent(new Event('change')); document.querySelector('#city-input').value = 'Vicenza'; document.querySelector('#save-city').click()`);
      await ui.waitFor(`/Miro/.test(document.querySelector('#hello').innerText)`);
      await ui.eval(`document.querySelector('#settings-dialog .tabs [data-tab="about"]').click()`);
      assert.match(await text('#settings-dialog .sheet-body'), /Ctrl\+K/);
      await ui.eval(`document.querySelector('#settings-dialog').close()`);
      await sleep(400);
      const prefs = await ui.eval('return window.nuvia.getPreferences()');
      assert.deepEqual([prefs.theme, prefs.accent, prefs.background, prefs.sidebarCollapsed, prefs.name, prefs.city], ['light', 'lime', 'grain', true, 'Miro', 'Vicenza']);
      await click('#collapse-sidebar');
      assert.equal(await ui.eval(`return document.body.classList.contains('sidebar-collapsed')`), false);
    });

    await t.test('treni e finestra: preferiti e controlli', async () => {
      await ui.eval(`const input = document.querySelector('#train-form input'); input.value = '16079'; document.querySelector('#train-form [title="Salva tra i preferiti"]').click()`);
      await ui.waitFor(`/16079/.test(document.querySelector('.widget[data-widget="train"] .account-strip')?.innerText)`);
      await sleep(400);
      assert.deepEqual((await ui.eval('return window.nuvia.getPreferences()')).favoriteTrains, ['16079']);
      for (const id of ['window-min', 'window-max', 'window-close']) assert.ok(await ui.eval(`return Boolean(document.getElementById('${id}'))`));
      // Xvfb has no window manager, so only check that the control answers.
      await click('#window-max');
      assert.equal(typeof (await ui.eval('return window.nuvia.windowState()')).maximized, 'boolean');
    });

    await t.test('nessun errore JavaScript nella UI', async () => {
      const errors = ui.logs.filter(entry => entry.type !== 'warning' && !/Failed to load resource|tile\.openstreetmap|net::ERR/.test(entry.text));
      assert.deepEqual(errors, []);
    });
  } catch (error) {
    if (ui) await ui.screenshot(join(app.profile, '..', 'nuvia-ui-failure.png')).catch(() => {});
    throw new Error(`${error.message}\n--- log Electron ---\n${app.output().slice(-4000)}`);
  } finally {
    ui?.close();
    await app.close();
    server.close();
    delete process.env.NUVIA_FIXTURES;
  }
});
