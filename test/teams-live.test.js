import test from 'node:test';
import assert from 'node:assert/strict';
import { launch, writeProfile } from './helpers.js';

test('live Teams accepts Nuvia browser and reaches Teams or Microsoft sign-in', { timeout: 120000 }, async () => {
  const app = await launch({ prepare: profile => writeProfile(profile, {
    'services.json': [{ id: 'teams-live', name: 'Microsoft Teams', url: 'https://teams.microsoft.com/v2/' }],
    'preferences.json': {}
  }) });
  let ui; let page;
  try {
    ui = await app.ui();
    await ui.eval(`document.querySelector('.service[data-id="teams-live"]').click(); return true`);
    page = await app.page(target => target.type === 'page' && /(?:teams\.(?:microsoft\.com|live\.com|cloud\.microsoft)|login\.(?:microsoftonline\.com|live\.com))/.test(target.url), 60000);
    await page.waitFor('document.body?.innerText?.length > 20', { timeout: 60000 });
    const result = await page.eval(`return { url: location.href, title: document.title, text: document.body.innerText.slice(0, 3000), userAgent: navigator.userAgent }`);
    assert.match(result.userAgent, /Chrome\/\d+/);
    assert.doesNotMatch(result.userAgent, /Electron/i);
    assert.doesNotMatch(result.text, /browser (?:is )?not supported|unsupported browser|update (?:your )?browser|aggiorna (?:il )?browser/i);
    assert.match(result.url, /teams|microsoft|live/i);
  } catch (error) {
    throw new Error(`${error.message}\n--- Electron log ---\n${app.output().slice(-5000)}`);
  } finally {
    page?.close(); ui?.close(); await app.close();
  }
});
