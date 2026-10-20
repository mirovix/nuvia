import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, writeProfile, project, sleep } from './helpers.js';

// At startup a page can open before Chromium has registered an extension's
// scripts with it, and then runs without them (Streak missing from two Gmail
// accounts). Nuvia sees the mark the scripts leave is missing and reloads the
// page, once: never in a loop, and never a page that has them.
test('a page an extension’s scripts did not reach is reloaded, once', { timeout: 90000 }, async () => {
  const app = await launch({
    prepare: profile => {
      const fixtures = join(profile, 'fixtures');
      cpSync(join(project, 'test', 'fixtures'), fixtures, { recursive: true });
      process.env.NUVIA_FIXTURES = fixtures;
      const dir = join(profile, 'marketplace-extensions', 'scripthelper');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ manifest_version: 3, version: '1.0.0', name: 'Script Helper', content_scripts: [{ matches: ['https://strip.nuvia.test/*'], js: ['c.js'] }] }));
      writeFileSync(join(dir, 'c.js'), "document.documentElement.dataset.helper = 'on';");
      writeProfile(profile, { 'services.json': [{ id: 'strip', name: 'Strip', url: 'https://strip.nuvia.test/strip' }, { id: 'keep', name: 'Keep', url: 'https://strip.nuvia.test/keep' }], 'preferences.json': {}, 'extensions.json': [dir] });
    }
  });
  const nuviaLog = () => { try { return readFileSync(join(app.profile, 'nuvia.log'), 'utf8'); } catch { return ''; } };
  let ui; let strip; let keep;
  try {
    ui = await app.ui();
    await ui.eval(`await window.nuvia.activate('keep'); await window.nuvia.activate('strip'); return true`);
    strip = await app.page(target => target.type === 'page' && target.url.startsWith('https://strip.nuvia.test/strip'), 30000);
    keep = await app.page(target => target.type === 'page' && target.url.startsWith('https://strip.nuvia.test/keep'), 30000);
    assert.match(await keep.waitFor(`document.documentElement.getAttribute('data-nuvia-extensions')`), /^[a-p]{32}$/, 'the scripts mark the page with their extension id');
    await strip.waitFor(`document.getElementById('loads').textContent === '2'`, { timeout: 20000 }).catch(async () => { strip.close(); strip = await app.page(target => target.type === 'page' && target.url.startsWith('https://strip.nuvia.test/strip')); });
    await sleep(7000);
    assert.equal(await strip.eval(`return document.getElementById('loads').textContent`), '2', 'reloaded once, not in a loop');
    assert.equal(await keep.eval(`return document.getElementById('loads').textContent`), '1', 'a page that has the scripts is left alone');
    assert.equal(nuviaLog().match(/Script Helper did not reach the page: reloading it once/g)?.length, 1);
    assert.match(nuviaLog(), /Strip Script Helper still missing after a reload/);
  } catch (error) {
    throw new Error(`${error.message}\n--- Nuvia log ---\n${nuviaLog().slice(-1500)}\n--- Electron log ---\n${app.output().slice(-1500)}`);
  } finally {
    strip?.close(); keep?.close(); ui?.close(); await app.close();
  }
});
