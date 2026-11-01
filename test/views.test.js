import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync } from 'node:fs';
import { join } from 'node:path';
import { launch, writeProfile, project, sleep } from './helpers.js';

// A service page left on top of the overview (Claude over Calendar, every
// section): opening a service takes a moment, and asking for it twice at once
// made two pages, one on screen and the other the one Nuvia knew about.
test('a service page never stays on top of the overview', { timeout: 90000 }, async () => {
  const app = await launch({
    prepare: profile => {
      const fixtures = join(profile, 'fixtures');
      cpSync(join(project, 'test', 'fixtures'), fixtures, { recursive: true });
      process.env.NUVIA_FIXTURES = fixtures;
      writeProfile(profile, { 'services.json': [{ id: 'claude', name: 'Claude', url: 'https://claude.ai/new' }, { id: 'gmail', name: 'Gmail', url: 'https://mail.google.com/mail/u/0/#inbox' }, { id: 'slow', name: 'Slow', url: 'https://slowframe.nuvia.test/' }], 'preferences.json': { migrations: ['ai-services-1'] } });
    }
  });
  let ui;
  try {
    ui = await app.ui();
    const state = () => ui.eval('return window.nuvia.debugState()');
    // Asked for twice at the same moment: one page.
    await ui.eval(`await Promise.all([window.nuvia.activate('claude'), window.nuvia.activate('claude')]); return true`);
    await sleep(1500);
    assert.equal((await state()).made.claude, 1, 'one Claude page');
    assert.equal((await state()).children, 1);
    await ui.eval('await window.nuvia.home(); return true');
    assert.equal((await state()).children, 0, 'the overview shows no service page');

    // Opened, and the overview chosen before it finished opening.
    await ui.eval(`window.nuvia.activate('gmail'); await window.nuvia.home(); return true`);
    await sleep(3000);
    let now = await state();
    assert.equal(now.children, 0, 'Gmail did not land on top of the overview');
    assert.equal(now.activeKey, null);

    // One service, then another before the first is ready: only the second shows.
    await ui.eval(`window.nuvia.activate('claude'); await window.nuvia.activate('gmail'); return true`);
    await sleep(1500);
    now = await state();
    assert.equal(now.activeKey, 'gmail');
    assert.equal(now.children, 1);

    // A loaded page with a frame that never finishes: not "loading" for ever.
    await ui.eval(`await window.nuvia.activate('slow'); return true`);
    const loading = await ui.waitFor(`window.nuvia.serviceState().then(list => { const slow = list.find(item => item.id === 'slow'); return slow && slow.title === 'Slow frame (1)' && slow.loading === false ? 'done' : null; })`, { timeout: 15000 }).catch(error => error.message);
    assert.equal(loading, 'done', `the bar stops once the page itself has loaded: ${await ui.eval("return window.nuvia.serviceState().then(list => JSON.stringify(list.find(item => item.id === 'slow')))")}`);

    // The UI zoomed out (Ctrl+-, remembered by Chromium): the service page must
    // still fit the window, its bottom (a chat's message box) on screen.
    await ui.eval(`document.querySelector('.service[data-id="slow"]').click(); return true`);
    await ui.waitFor(`!document.getElementById('view-host').hidden && document.getElementById('view-host').getBoundingClientRect().width > 0`);
    for (const factor of [0.9, 1.25, 1]) {
      await ui.eval(`await window.nuvia.debugUiZoom(${factor}); return true`);
      await sleep(800);
      now = await state();
      const host = await ui.eval(`const r = document.getElementById('view-host').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }`);
      for (const side of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(now.hostBounds[side] - host[side] * factor) <= 1, `at ${factor}: ${side} ${now.hostBounds[side]} is the page area in window pixels (${host[side] * factor})`);
      assert.ok(now.hostBounds.y + now.hostBounds.height <= now.content.height + 1, `at ${factor}: the page ends at ${now.hostBounds.y + now.hostBounds.height}, the window at ${now.content.height}`);
      assert.ok(now.hostBounds.x + now.hostBounds.width <= now.content.width + 1, `at ${factor}: the page fits the window's width`);
    }
  } finally {
    ui?.close(); await app.close();
  }
});
