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
      return send(`BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:${icsStamp(start)}\r\nDTEND:${icsStamp(end)}\r\nSUMMARY:Lunch with Anna\r\nLOCATION:Cafeteria\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:b\r\nDTSTART:${icsStamp(tomorrow)}\r\nSUMMARY:Project deadline\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`, 'text/calendar');
    }
    if (url.pathname.startsWith('/vt/autocompletaStazione/')) return send('PADOVA|S02581\nPADOVA CAMPO MARTE|S02650\n', 'text/plain');
    if (url.pathname.startsWith('/vt/partenze/S02581/')) return send([
      { compNumeroTreno: 'REG 3504', destinazione: 'VERONA PORTA NUOVA', compOrarioPartenza: '17:40', ritardo: 13, binarioProgrammatoPartenzaDescrizione: '3' },
      { compNumeroTreno: 'REG 17103', destinazione: 'FERRARA', compOrarioPartenza: '17:41', ritardo: 0 },
      { compNumeroTreno: 'RV 2214', destinazione: 'BRESCIA', compOrarioPartenza: '18:10', ritardo: 0, binarioProgrammatoPartenzaDescrizione: '4' }]);
    if (url.pathname === '/ritardometro.yaml') return send('current_station: PADOVA\ndestinations:\n  - BRESCIA\n  - VERONA PORTA NUOVA\nhours:\n  - "16"\n  - "17"\nminutes:\n  - "40"\nlead_time: 20\nmax_delay_minutes: 1\n', 'text/plain');
    if (url.pathname === '/site') return send('<!doctype html><title>Test site</title><h1>Test site</h1>', 'text/html');
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

test('Nuvia: every page, widget and button', { timeout: 420000 }, async t => {
  const server = await mockServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const now = Date.now();
  const app = await launch({
    env: { NUVIA_NOMINATIM_URL: base, NUVIA_ROUTING_URL: base, NUVIA_VIAGGIATRENO_URL: `${base}/vt`, NUVIA_RITARDOMETRO_CONFIG: `${base}/ritardometro.yaml`, DEI_USER: '', DEI_PASSWORD: '' },
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
          { id: 'site', name: 'Site', url: `${base}/site` },
          { id: 'portal', name: 'University Mail', url: 'https://portal.nuvia.test/' }
        ],
        'preferences.json': { migrations: ['ai-services-1'], name: 'Tester', city: 'Padova', calendar: { feeds: [{ id: 'ics-test', name: 'University', url: `${base}/cal.ics` }] } },
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

    await t.test('startup: UI ready and no extensions in the UI session', async () => {
      const info = await ui.eval(`return { bridge: Object.keys(window.nuvia), title: document.querySelector('#page-title').textContent, theme: document.documentElement.dataset.theme, widgets: [...document.querySelectorAll('.widget')].map(w => w.dataset.widget) }`);
      for (const key of ['mail', 'messages', 'calendarEvents', 'musicState', 'route', 'aiUsage', 'setOverlay']) assert.ok(info.bridge.includes(key), key);
      assert.equal(info.title, 'Overview');
      assert.equal(info.theme, 'dark');
      assert.deepEqual(info.widgets.slice(0, 3), ['mail', 'calendar', 'messages']);
      assert.equal((await debug()).uiExtensions, 0);
    });

    await t.test('extensions: quarantine after a crash, enabled only where relevant', async () => {
      const list = await ui.eval('return window.nuvia.listExtensions()');
      const crashy = list.find(item => item.id === 'crashyext');
      const helper = list.find(item => item.id === 'mailhelper');
      assert.equal(crashy.rules.gmail, false, 'Crashy must be disabled on Gmail');
      assert.equal(helper.rules.gmail, true);
      assert.equal(helper.rules.wa, false, 'a Gmail content script must not load on WhatsApp');
      const notifications = await ui.eval('return window.nuvia.listNotifications()');
      assert.ok(notifications.some(item => /Crashy/.test(item.body) && item.title === 'Extension disabled'));
      const gmail = await app.page(target => target.url.startsWith('https://mail.google.com'));
      assert.equal(await gmail.waitFor("document.documentElement.dataset.mailHelper"), 'on');
      gmail.close();
      await click('#open-extensions');
      await ui.waitFor(`document.querySelectorAll('#extension-list .ext-row').length === 2`);
      await ui.eval(`[...document.querySelectorAll('#extension-list .ext-row')].find(row => row.innerText.includes('Mail Helper')).querySelectorAll('.ext-services .chip')[1].click()`);
      await ui.waitFor(`window.nuvia.listExtensions().then(list => list.find(item => item.id === 'mailhelper').rules.wa === true)`);
      await ui.eval(`document.querySelector('#extensions-dialog').close()`);
    });

    await t.test('navigation: every item opens its page', async () => {
      for (const [route, title] of [['messages', 'Messages'], ['calendar', 'Calendar'], ['music', 'Music'], ['ai', 'Claude & Codex'], ['home', 'Overview']]) {
        await click(`[data-route="${route}"]`);
        await ui.waitFor(`!document.querySelector('#page-${route}').hidden && document.querySelector('#page-title').textContent === ${JSON.stringify(title)} && document.querySelector('[data-route="${route}"]').classList.contains('active')`);
      }
    });

    await t.test('mail: new email previews and opening the thread', async () => {
      await ui.waitFor(`document.querySelectorAll('.widget[data-widget="mail"] .row').length === 2`, { timeout: 30000 });
      const rows = await ui.eval(`return [...document.querySelectorAll('.widget[data-widget="mail"] .row')].map(row => row.innerText.replace(/\\s+/g, ' '))`);
      assert.match(rows.join('|'), /Anna Rossi.*Meeting notes.*Here are today's notes/);
      assert.match(await text('.widget[data-widget="mail"] .w-meta'), /2 unread/);
      await ui.eval(`[...document.querySelectorAll('.widget[data-widget="mail"] .row')].find(row => row.innerText.includes('Anna')).click()`);
      await ui.waitFor(`document.querySelector('#page-title').textContent === 'Gmail Test'`);
      const gmail = await app.page(target => target.url.startsWith('https://mail.google.com'));
      assert.equal(await gmail.waitFor('document.body.dataset.opened'), '#inbox/18f2a3b4c5d6e7f8');
      gmail.close();
      assert.equal((await debug()).attached, true);
      await click('[data-route="home"]');
    });

    await t.test('messages: unified inbox as one chat, quick reply', async () => {
      await click('[data-route="messages"]');
      await ui.waitFor(`document.querySelectorAll('#message-feed .bubble').length === 3`, { timeout: 30000 });
      const order = await ui.eval(`return [...document.querySelectorAll('#message-feed .bubble strong')].map(el => el.textContent)`);
      assert.deepEqual(order, ['Lab group', 'Giulia', 'Mum'], 'oldest to newest, like a chat');
      assert.ok(await ui.eval(`return [...document.querySelectorAll('#message-feed .day')].map(el => el.textContent).includes('Today') || document.querySelectorAll('#message-feed .day').length >= 2`));
      await ui.eval(`document.querySelector('#unread-filter input').click()`);
      await ui.waitFor(`document.querySelectorAll('#message-feed .bubble').length === 2`);
      await ui.eval(`document.querySelector('#unread-filter input').click()`);
      await ui.eval(`const input = document.querySelector('.chat-head .search'); input.value = 'bread'; input.dispatchEvent(new Event('input'))`);
      await ui.waitFor(`document.querySelectorAll('#message-feed .bubble').length === 1`);
      await ui.eval(`const input = document.querySelector('.chat-head .search'); input.value = ''; input.dispatchEvent(new Event('input'))`);
      await ui.eval(`[...document.querySelectorAll('#message-feed .bubble')].find(b => b.innerText.includes('Mum')).click()`);
      await ui.waitFor(`!document.querySelector('#composer').hidden && document.querySelector('#reply-target').innerText.includes('Mum')`);
      await ui.eval(`const input = document.querySelector('#reply-input'); input.value = 'Ok, lo prendo io'; document.querySelector('#composer .btn.accent').click()`);
      const wa = await app.page(target => target.url.startsWith('https://web.whatsapp.com'));
      const sent = await wa.waitFor('window.sent.length && window.sent', { timeout: 15000 });
      assert.deepEqual(sent[0], { chat: 'Mum', text: 'Ok, lo prendo io' });
      wa.close();
      await ui.eval(`[...document.querySelectorAll('#message-feed .bubble')].find(b => b.innerText.includes('Giulia')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
      await ui.waitFor(`document.querySelector('#page-title').textContent === 'WhatsApp'`);
      await click('[data-route="home"]');
      await ui.waitFor(`document.querySelectorAll('.widget[data-widget="messages"] .bubble').length === 3`);
    });

    await t.test('calendar: Google and iCal events, toggleable sources, scrolling', async () => {
      await ui.waitFor(`document.querySelector('.widget[data-widget="calendar"] .events')`, { timeout: 40000 });
      const today = await text('.widget[data-widget="calendar"] .events');
      assert.match(today, /Lunch with Anna/);
      assert.match(today, /Thesis review/);
      await ui.eval(`document.querySelectorAll('.widget[data-widget="calendar"] .week button')[1].click()`);
      await ui.waitFor(`/Robotics lecture/.test(document.querySelector('.widget[data-widget="calendar"] .w-body').innerText) && /Project deadline/.test(document.querySelector('.widget[data-widget="calendar"] .w-body').innerText)`);
      assert.equal(await ui.eval(`const w = document.querySelector('.widget[data-widget="calendar"]'); return w.draggable`), false, 'the widget must not be draggable outside its handle');
      await click('[data-route="calendar"]');
      await ui.waitFor(`document.querySelectorAll('#page-calendar .agenda-day').length >= 2`);
      const sources = await ui.eval(`return window.__nuviaDebug.state.calendar.sources.map(s => [s.name, s.ok, s.count])`);
      assert.ok(sources.some(([name, ok, count]) => name === 'University' && ok && count >= 2));
      assert.ok(sources.some(([name, ok, count]) => name === 'Gmail Test' && ok && count >= 3));
      await ui.eval(`[...document.querySelectorAll('#page-calendar .card .check')].find(row => row.innerText.includes('University')).querySelector('.toggle').click()`);
      await ui.waitFor(`!/Lunch with Anna/.test(document.querySelector('#page-calendar').innerText)`, { timeout: 20000 });
      await ui.eval(`[...document.querySelectorAll('#page-calendar .card .check')].find(row => row.innerText.includes('University')).querySelector('.toggle').click()`);
      await ui.waitFor(`/Lunch with Anna/.test(document.querySelector('#page-calendar').innerText)`, { timeout: 20000 });
      await click('[data-route="home"]');
    });

    await t.test('music: built-in player with artwork, artist and controls', async () => {
      const spotify = await app.page(target => target.url.startsWith('https://open.spotify.com'));
      await ui.waitFor(`/Clouds/.test(document.querySelector('.widget[data-widget="music"] .track')?.innerText) && /Artist One/.test(document.querySelector('.widget[data-widget="music"] .track').innerText)`, { timeout: 30000 });
      await ui.eval(`document.querySelector('.widget[data-widget="music"] .play').click()`);
      await ui.waitFor(`window.__nuviaDebug.state.music.paused === false`);
      await ui.eval(`document.querySelector('.widget[data-widget="music"] [title="Next"]').click()`);
      await ui.waitFor(`/Clear Skies/.test(document.querySelector('.widget[data-widget="music"] .track').innerText)`);
      assert.equal((await debug()).attached, false, 'Spotify must not open on screen');
      await click('[data-route="music"]');
      await ui.waitFor(`document.querySelector('.music-hero h2')?.textContent === 'Clear Skies' && document.querySelector('.music-hero .artist').textContent === 'Artist Two' && document.querySelector('.music-hero .album').textContent === 'Album Test'`);
      for (const title of ['Shuffle', 'Repeat', 'Add to Liked Songs', 'Previous']) await ui.eval(`document.querySelector('.music-hero [title="${title}"]').click()`);
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
      await ui.eval(`const input = document.querySelector('#page-music .actions input'); input.value = 'clouds'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
      await ui.waitFor(`document.querySelectorAll('#page-music .tracks .row').length === 2`, { timeout: 20000 });
      await ui.eval(`document.querySelectorAll('#page-music .tracks .row')[1].click()`);
      await spotify.waitFor(`window.log.includes('track:1')`);
      spotify.close();
      await click('[data-route="home"]');
    });

    await t.test('Claude & Codex: limits, resets and tokens', async () => {
      await ui.waitFor(`/63%/.test(document.querySelector('.widget[data-widget="ai"] .w-body')?.innerText) && /42%/.test(document.querySelector('.widget[data-widget="ai"] .w-body').innerText)`, { timeout: 40000 });
      await click('[data-route="ai"]');
      await ui.waitFor(`document.querySelectorAll('#page-ai .card').length === 2`);
      const page = await text('#page-ai');
      assert.match(page, /Session · 5 hours/);
      assert.match(page, /42%/);
      assert.match(page, /17%/);
      assert.match(page, /63%/);
      assert.match(page, /21%/);
      assert.match(page, /resets in 1 h 30 min/);
      assert.match(page, /claude max 5x/i);
      assert.match(page, /1\.2M/);
      await ui.eval(`[...document.querySelectorAll('#page-ai .card')][0].querySelector('.ai-head .btn').click()`);
      await ui.waitFor(`document.querySelector('#page-title').textContent === 'Claude'`);
      await click('[data-route="home"]');
    });

    await t.test('commute: correct addresses, A→B map and directions', async () => {
      await ui.eval(`document.querySelector('.widget[data-widget="commute"]').scrollIntoView()`);
      await ui.eval(`const [a, b] = document.querySelectorAll('.route-form .suggest input'); a.focus(); a.value = 'Via tiepolo padova'; a.dispatchEvent(new Event('input', { bubbles: true }))`);
      await ui.waitFor(`!document.querySelector('.route-form .suggest .suggestions').hidden`, { timeout: 15000 });
      assert.match(await text('.route-form .suggest .suggestions'), /Tiepolo, Padova/);
      await ui.eval(`document.querySelector('.route-form .suggest .suggestions button').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
      await ui.eval(`const b = document.querySelectorAll('.route-form .suggest input')[1]; b.value = 'Corso Palladio 98'; b.dispatchEvent(new Event('input', { bubbles: true })); const city = document.querySelector('.route-form > input'); city.value = 'Vicenza'; city.dispatchEvent(new Event('change')); document.querySelector('.route-form .btn.accent').click()`);
      await ui.waitFor(`document.querySelectorAll('.widget[data-widget="commute"] .leaflet-marker-icon').length === 2`, { timeout: 20000 });
      const result = await ui.eval(`return { summary: document.querySelector('.route-summary').innerText, ends: document.querySelector('.route-ends').innerText, steps: document.querySelectorAll('.route-steps .step').length, path: document.querySelectorAll('.widget[data-widget="commute"] path.leaflet-interactive').length }`);
      assert.match(result.summary, /35\s*min/);
      assert.match(result.summary, /37\.8 km/);
      assert.match(result.ends, /A\s*Via Giovanni Battista Tiepolo, Padova/);
      assert.match(result.ends, /B\s*Corso Andrea Palladio 98, Vicenza/);
      assert.equal(result.steps, 4);
      assert.ok(result.path >= 2);
      assert.match(await text('.route-steps'), /Turn right onto Via San Massimo/);
      const prefs = await ui.eval('return window.nuvia.getPreferences()');
      assert.equal(prefs.homeOriginPlace.label, 'Via Giovanni Battista Tiepolo, Padova');
      await ui.eval(`document.querySelectorAll('.route-form .segmented button')[1].click()`);
      await ui.waitFor(`/bike/.test(document.querySelector('.widget[data-widget="commute"] .w-meta').innerText)`);
    });

    await t.test('notifications: panel, delete one and clear all', async () => {
      await ui.eval(`await window.nuvia.addNotification({ title: 'Test A', body: 'one' }); await window.nuvia.addNotification({ title: 'Test B', body: 'two' });`);
      await ui.waitFor(`!document.querySelector('#open-notifications .dot-badge').hidden`);
      await click('#open-notifications');
      await ui.waitFor(`document.querySelector('.notif-panel[open] .notif')`);
      const before = await ui.eval(`return document.querySelectorAll('.notif-panel .notif').length`);
      await ui.eval(`[...document.querySelectorAll('.notif-panel .notif')].find(n => n.innerText.includes('Test A')).querySelector('.delete-notification').click()`);
      await ui.waitFor(`document.querySelectorAll('.notif-panel .notif').length === ${before - 1} && !document.querySelector('.notif-panel').innerText.includes('Test A')`);
      await click('#clear-notifications');
      await ui.waitFor(`document.querySelectorAll('.notif-panel .notif').length === 0`);
      assert.equal((await ui.eval('return window.nuvia.listNotifications()')).length, 0);
      await ui.eval(`document.querySelector('.notif-panel').close()`);
      await ui.waitFor(`document.querySelector('#open-notifications .dot-badge').hidden && /No notifications/.test(document.querySelector('.widget[data-widget="notifications"]').innerText)`);
      await ui.eval(`await window.nuvia.addNotification({ title: 'From the widget', body: 'x' })`);
      await ui.waitFor(`/From the widget/.test(document.querySelector('.widget[data-widget="notifications"]').innerText)`);
      await ui.eval(`document.querySelector('.widget[data-widget="notifications"] .delete-notification').click()`);
      await ui.waitFor(`!/From the widget/.test(document.querySelector('.widget[data-widget="notifications"]').innerText)`);
    });

    await t.test('widgets: options, sizes, hide, customize and drag', async () => {
      await ui.eval(`document.querySelector('#page-home').scrollTop = 0; document.querySelector('.widget[data-widget="mail"] [data-act="settings"]').click()`);
      await ui.waitFor(`document.querySelector('dialog.popover[open]')`);
      await ui.eval(`[...document.querySelectorAll('dialog.popover .segmented')][0].querySelectorAll('button')[2].click()`);
      await ui.waitFor(`document.querySelector('.widget[data-widget="mail"]').dataset.size === 'l'`);
      await ui.eval(`[...document.querySelectorAll('dialog.popover .segmented')][1].querySelectorAll('button')[2].click()`);
      await ui.waitFor(`document.querySelector('.widget[data-widget="mail"]').dataset.height === 'tall'`);
      await ui.eval(`[...document.querySelectorAll('dialog.popover .check')].find(c => c.innerText.includes('Unread only')).querySelector('.toggle').click()`);
      await ui.waitFor(`document.querySelectorAll('.widget[data-widget="mail"] .row').length === 3`);
      await ui.eval(`[...document.querySelectorAll('dialog.popover button')].find(b => b.innerText.includes('Hide')).click()`);
      await ui.waitFor(`!document.querySelector('.widget[data-widget="mail"]')`);
      await click('#customize');
      await ui.waitFor(`document.querySelector('#customize-dialog[open]')`);
      await ui.eval(`[...document.querySelectorAll('#customize-dialog .layout-row')].find(r => r.innerText.includes('Mail')).querySelector('.toggle').click()`);
      await ui.waitFor(`document.querySelector('.widget[data-widget="mail"]')`);
      await ui.eval(`[...document.querySelectorAll('#customize-dialog .layout-row')].find(r => r.innerText.includes('Calendar')).querySelector('[title="Up"]').click()`);
      await ui.waitFor(`document.querySelector('.widget').dataset.widget === 'calendar'`);
      await ui.eval(`[...document.querySelectorAll('#customize-dialog .segmented')][0].querySelectorAll('button')[1].click()`);
      await ui.waitFor(`getComputedStyle(document.querySelector('#widget-grid')).getPropertyValue('--cols').trim() === '2'`);
      await ui.eval(`[...document.querySelectorAll('#customize-dialog button')].find(b => b.innerText.includes('Reset')).click()`);
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
      if (scroll.scrollable) assert.ok(scroll.top > 0, 'widget content must scroll');
    });

    await t.test('services: add over an open service, edit, crash and reload', async () => {
      await click('.service[data-id="site"]');
      await ui.waitFor(`window.nuvia.debugState().then(s => s.activeKey === 'site' && s.attached)`);
      await click('#add-service');
      await ui.waitFor(`document.querySelector('#service-dialog[open]')`);
      const during = await debug();
      assert.equal(during.attached, false, 'the service view must make room for the dialog');
      assert.equal(during.overlayDepth, 1);
      assert.ok(await ui.eval(`return getComputedStyle(document.querySelector('#view-shot')).backgroundImage.startsWith('url(')`), 'service screenshot under the dialog');
      await ui.eval(`[...document.querySelectorAll('#service-dialog .preset')].find(p => p.innerText.includes('Notion')).click()`);
      assert.equal(await ui.eval(`return document.querySelector('#service-dialog input[type=url]').value`), 'https://www.notion.so/');
      await ui.eval(`const [name, url] = document.querySelectorAll('#service-dialog input'); name.value = 'Second site'; url.value = '${base}/site?2'; document.querySelector('#save-service').click()`);
      await ui.waitFor(`document.querySelector('#page-title').textContent === 'Second site' && !document.querySelector('#service-dialog')`);
      assert.match(await text('#toasts'), /Add another/);
      const after = await debug();
      assert.equal(after.overlayDepth, 0);
      assert.equal(after.attached, true);
      const services = await ui.eval('return window.nuvia.listServices()');
      const added = services.find(service => service.name === 'Second site');
      assert.ok(added);
      await ui.eval(`window.__nuviaDebug.openEditService(${JSON.stringify(added.id)})`);
      await ui.waitFor(`document.querySelector('dialog.sheet[open] input')`);
      await ui.eval(`const name = document.querySelector('dialog.sheet[open] input'); name.value = 'Renamed site'; [...document.querySelectorAll('dialog.sheet[open] button')].find(b => b.innerText === 'Save').click()`);
      await ui.waitFor(`[...document.querySelectorAll('.service .label')].some(el => el.textContent === 'Renamed site')`);
      await ui.eval(`window.__nuviaDebug.removeService(${JSON.stringify(added.id)})`);
      await ui.waitFor(`document.querySelector('dialog.sheet[open]')`);
      await ui.eval(`[...document.querySelectorAll('dialog.sheet[open] button')].find(b => b.innerText === 'Remove').click()`);
      await ui.waitFor(`![...document.querySelectorAll('.service .label')].some(el => el.textContent === 'Renamed site') && document.querySelector('#page-title').textContent === 'Overview'`);
      // A service page that crashes shows a recovery screen instead of a blank view.
      await click('.service[data-id="site"]');
      await ui.waitFor(`window.nuvia.debugState().then(s => s.activeKey === 'site' && s.attached)`);
      assert.equal(await ui.eval(`return window.nuvia.debugCrash('site')`), true);
      // GitHub's headless runners don't report renderer crashes the same way; this part runs locally.
      if (process.env.CI) return;
      await ui.waitFor(`/stopped/.test(document.querySelector('#view-state').innerText)`, { timeout: 15000 });
      assert.equal((await debug()).attached, false);
      await ui.eval(`document.querySelector('#view-state .btn').click()`);
      await ui.waitFor(`window.nuvia.debugState().then(s => s.activeKey === 'site' && s.attached)`, { timeout: 15000 });
      await ui.waitFor(`!document.querySelector('.service[data-id="site"]').classList.contains('crashed')`, { timeout: 15000 });
    });

    await t.test('staying signed in: automatic sign-in on expired sessions, session cookies kept', async () => {
      const portalPage = () => app.page(target => target.type === 'page' && target.url.startsWith('https://portal.nuvia.test'), 30000);
      await ui.eval(`document.querySelector('.service[data-id="portal"]').click()`);
      await app.page(target => target.type === 'page' && target.url.startsWith('https://sso.nuvia.test'), 30000);
      await ui.eval(`window.__nuviaDebug.openEditService('portal')`);
      await ui.waitFor(`document.querySelectorAll('#signin-box input').length === 2 && document.querySelector('#signin-box').closest('dialog').open`);
      await ui.eval(`const [u, p] = document.querySelectorAll('#signin-box input'); u.value = 'mario.rossi@studenti.example.edu'; p.value = 'Segreta-123'; [...document.querySelectorAll('#signin-box button')].find(b => /Turn on|Update/.test(b.innerText)).click()`);
      await ui.waitFor(`/on/.test(document.querySelector('#signin-box .state')?.innerText || '')`);
      await ui.eval(`document.querySelector('#signin-box').closest('dialog').close()`);
      await ui.waitFor(`window.nuvia.debugState().then(s => s.overlayDepth === 0)`);
      let portal = await portalPage();
      assert.match(await portal.waitFor(`document.querySelector('h1')?.innerText`, { timeout: 30000 }), /Inbox/);
      await ui.waitFor(`window.nuvia.listNotifications().then(list => list.some(n => /Signed back in automatically/.test(n.body)))`, { timeout: 15000 });
      const stored = await ui.eval(`return window.nuvia.signInGet('portal')`);
      assert.deepEqual([stored.saved, stored.username], [true, 'mario.rossi@studenti.example.edu']);
      assert.equal(stored.password, undefined, 'the password never goes back to the UI');
      // The session expires: the service lands on the SSO again and Nuvia signs back in.
      await portal.eval(`localStorage.removeItem('session'); location.reload(); return true`).catch(() => {});
      portal.close();
      await sleep(1500);
      portal = await portalPage();
      assert.match(await portal.waitFor(`document.querySelector('h1')?.innerText`, { timeout: 30000 }), /Inbox/);
      portal.close();
      const cookies = await ui.eval(`return window.nuvia.debugCookies('portal')`);
      assert.deepEqual(cookies, { value: 'kept', session: true, encrypted: true });
      await ui.eval(`await window.nuvia.signInClear('portal'); return true`);
      assert.equal((await ui.eval(`return window.nuvia.signInGet('portal')`)).saved, false);
      // Signing in by hand once is enough: Nuvia remembers it and reconnects by itself later.
      portal = await portalPage();
      await portal.eval(`localStorage.removeItem('session'); location.reload(); return true`).catch(() => {});
      portal.close();
      const sso = await app.page(target => target.type === 'page' && target.url.startsWith('https://sso.nuvia.test'), 30000);
      await sso.waitFor(`document.querySelector('input[name=username]')`);
      await sso.eval(`const u = document.querySelector('input[name=username]'); u.value = 'mario.rossi@studenti.example.edu'; document.querySelector('button').click(); return true`);
      await sso.waitFor(`document.querySelector('input[type=password]')`);
      await sso.eval(`document.querySelector('input[type=password]').value = 'Segreta-123'; document.querySelector('button').click(); return true`).catch(() => {});
      sso.close();
      await ui.waitFor(`window.nuvia.signInGet('portal').then(s => s.saved && s.username === 'mario.rossi@studenti.example.edu')`, { timeout: 15000 });
      await ui.waitFor(`window.nuvia.listNotifications().then(list => list.some(n => /Sign-in saved for mario/.test(n.body)))`);
      portal = await portalPage();
      assert.match(await portal.waitFor(`document.querySelector('h1')?.innerText`, { timeout: 30000 }), /Inbox/);
      await portal.eval(`localStorage.removeItem('session'); location.reload(); return true`).catch(() => {});
      portal.close();
      await sleep(1500);
      portal = await portalPage();
      assert.match(await portal.waitFor(`document.querySelector('h1')?.innerText`, { timeout: 30000 }), /Inbox/, 'reconnects with the remembered sign-in');
      portal.close();
      await click('[data-route="home"]');
    });

    await t.test('shortcuts and quick switcher', async () => {
      const key = (k, extra = '') => ui.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', ctrlKey: true, bubbles: true ${extra} }))`);
      await key('0');
      await ui.waitFor(`document.querySelector('#page-title').textContent === 'Overview'`);
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

    await t.test('settings: theme, accent, background, name, city, compact sidebar', async () => {
      await click('#open-settings');
      await ui.waitFor(`document.querySelector('#settings-dialog[open]')`);
      await ui.eval(`[...document.querySelectorAll('#settings-dialog .segmented button')].find(b => b.innerText.includes('Light')).click()`);
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

    await t.test('trains: built-in Ritardometro with board and imported config', async () => {
      await ui.waitFor(`document.querySelectorAll('.widget[data-widget="train"] .train-board .row').length === 2`, { timeout: 20000 });
      const board = await text('.widget[data-widget="train"] .train-board');
      assert.match(board, /VERONA PORTA NUOVA/);
      assert.match(board, /BRESCIA/);
      assert.doesNotMatch(board, /FERRARA/, 'only the chosen destinations');
      assert.match(board, /\+13/);
      assert.equal(await ui.eval(`return document.querySelector('.train-board .row.watched time')?.textContent`), '17:40');
      const prefs = await ui.eval('return window.nuvia.getPreferences()');
      assert.deepEqual(prefs.trains, { station: 'PADOVA', destinations: ['BRESCIA', 'VERONA PORTA NUOVA'], times: ['16:40', '17:40'], leadTime: 20, maxDelay: 1, enabled: true });
      await ui.eval(`document.querySelector('.widget[data-widget="train"] [title="Station and alerts"]').click()`);
      await ui.waitFor(`document.querySelector('#settings-dialog[open] #train-destinations')`);
      await ui.eval(`const d = document.querySelector('#train-destinations'); d.value = 'ferrara'; d.dispatchEvent(new Event('change'))`);
      await ui.waitFor(`/FERRARA/.test(document.querySelector('.widget[data-widget="train"] .train-board')?.innerText) && !/BRESCIA/.test(document.querySelector('.widget[data-widget="train"] .train-board').innerText)`, { timeout: 15000 });
      await ui.eval(`document.querySelector('#settings-dialog').close()`);
    });

    await t.test('IAS: sign in once, check in and out of a lab', async () => {
      await ui.waitFor(`/Sign in to DEI Labs/.test(document.querySelector('.widget[data-widget="ias"]')?.innerText)`, { timeout: 30000 });
      await ui.eval(`document.querySelector('.widget[data-widget="ias"] .btn.accent').click()`);
      await ui.waitFor(`document.querySelector('#ias-login-dialog[open]')`);
      await ui.eval(`const [e, p] = document.querySelectorAll('#ias-login-dialog input'); e.value = 'test@unipd.it'; p.value = 'sbagliata'; document.querySelector('#ias-login-dialog [type=submit]').click()`);
      await ui.waitFor(`/failed/i.test(document.querySelector('#ias-login-dialog')?.innerText)`, { timeout: 30000 });
      await ui.eval(`const p = document.querySelectorAll('#ias-login-dialog input')[1]; p.value = 'segreta'; document.querySelector('#ias-login-dialog [type=submit]').click()`);
      await ui.waitFor(`!document.querySelector('#ias-login-dialog') && document.querySelector('#ias-lab')`, { timeout: 30000 });
      assert.deepEqual(await ui.eval(`return [...document.querySelectorAll('#ias-lab option')].map(o => o.textContent)`), ['DEI/O | SSL Lab', 'DEI/O | Neurorobotics']);
      await ui.eval(`const s = document.querySelector('#ias-lab'); s.value = 'DEI/O | Neurorobotics'; s.dispatchEvent(new Event('change')); document.querySelector('.widget[data-widget="ias"] .btn.accent').click()`);
      await ui.waitFor(`/inside/.test(document.querySelector('.widget[data-widget="ias"]').innerText) && /Neurorobotics/.test(document.querySelector('.widget[data-widget="ias"]').innerText)`, { timeout: 30000 });
      // The session is remembered: a fresh read needs no new login.
      const again = await ui.eval('return window.nuvia.iasState()');
      assert.equal(again.configured, true);
      assert.equal(again.inside, true);
      assert.equal(again.account, 'test@unipd.it');
      await ui.eval(`[...document.querySelectorAll('.widget[data-widget="ias"] .btn')].find(b => b.innerText.includes('Leave')).click()`);
      await ui.waitFor(`document.querySelector('#ias-lab')`, { timeout: 30000 });
      const guardFree = await ui.eval(`return window.nuvia.debugState()`);
      assert.equal(guardFree.uiExtensions, 0);
    });

    await t.test('window: controls', async () => {
      for (const id of ['window-min', 'window-max', 'window-close']) assert.ok(await ui.eval(`return Boolean(document.getElementById('${id}'))`));
      // Xvfb has no window manager, so only check that the control answers.
      await click('#window-max');
      assert.equal(typeof (await ui.eval('return window.nuvia.windowState()')).maximized, 'boolean');
    });

    await t.test('favourite trains', async () => {
      await ui.eval(`document.querySelector('.widget[data-widget="train"]').scrollIntoView(); const input = document.querySelector('#train-form input'); input.value = '16079'; document.querySelector('#train-form [title="Save to favourites"]').click()`);
      await ui.waitFor(`/16079/.test(document.querySelector('.widget[data-widget="train"] .account-strip')?.innerText)`);
      await sleep(400);
      assert.deepEqual((await ui.eval('return window.nuvia.getPreferences()')).favoriteTrains, ['16079']);
    });

    await t.test('no JavaScript errors in the UI', async () => {
      const errors = ui.logs.filter(entry => entry.type !== 'warning' && !/Failed to load resource|tile\.openstreetmap|net::ERR/.test(entry.text));
      assert.deepEqual(errors, []);
    });
  } catch (error) {
    if (ui) await ui.screenshot(join(app.profile, '..', 'nuvia-ui-failure.png')).catch(() => {});
    throw new Error(`${error.message}\n--- Electron log ---\n${app.output().slice(-4000)}`);
  } finally {
    ui?.close();
    await app.close();
    server.close();
    delete process.env.NUVIA_FIXTURES;
  }
});
