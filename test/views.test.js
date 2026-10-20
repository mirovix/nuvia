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
      writeProfile(profile, { 'services.json': [{ id: 'claude', name: 'Claude', url: 'https://claude.ai/new' }, { id: 'gmail', name: 'Gmail', url: 'https://mail.google.com/mail/u/0/#inbox' }], 'preferences.json': { migrations: ['ai-services-1'] } });
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
  } finally {
    ui?.close(); await app.close();
  }
});
