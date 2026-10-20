import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, writeProfile, project } from './helpers.js';

test('a service whose page failed to load tries again by itself (no blank page)', { timeout: 90000 }, async () => {
  const app = await launch({
    prepare: profile => {
      const fixtures = join(profile, 'fixtures');
      cpSync(join(project, 'test', 'fixtures'), fixtures, { recursive: true });
      process.env.NUVIA_FIXTURES = fixtures;
      writeProfile(profile, { 'services.json': [{ id: 'flaky', name: 'Flaky', url: 'https://flaky.nuvia.test/' }], 'preferences.json': {} });
    }
  });
  let ui; let page;
  try {
    ui = await app.ui();
    await ui.eval(`document.querySelector('.service[data-id="flaky"]').click(); return true`);
    // The first two loads fail like a network that is not up yet; the third works.
    page = await app.page(target => target.type === 'page' && target.url.startsWith('https://flaky.nuvia.test'), 40000);
    assert.match(await page.waitFor(`document.querySelector('h1')?.innerText`, { timeout: 30000 }), /network came back/);
    const log = readFileSync(join(app.profile, 'nuvia.log'), 'utf8');
    assert.match(log, /load Flaky .*trying again in 2 s/);
    assert.match(log, /load Flaky .*trying again in 5 s/);
  } catch (error) {
    let log = ''; try { log = readFileSync(join(app.profile, 'nuvia.log'), 'utf8'); } catch {}
    throw new Error(`${error.message}\n--- Nuvia log ---\n${log.slice(-2000)}\n--- Electron log ---\n${app.output().slice(-3000)}`);
  } finally {
    page?.close(); ui?.close(); await app.close();
  }
});
