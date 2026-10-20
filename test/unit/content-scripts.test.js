import test from 'node:test';
import assert from 'node:assert/strict';
import { contentScriptsRunOn } from '../../lib/extensions.js';

// Which pages an extension's own content scripts run on (main.js#checkExtensionScripts).
test('content script match patterns', () => {
  const streak = { content_scripts: [
    { matches: ['https://mail.google.com/*'], js: ['main-world.js'], world: 'MAIN' },
    { matches: ['*://*.google.com/*marketplace/*'], js: ['app.js'] }
  ] };
  assert.equal(contentScriptsRunOn(streak, 'https://mail.google.com/mail/u/0/#inbox'), false, 'only the page-world script runs on Gmail');
  assert.equal(contentScriptsRunOn(streak, 'https://workspace.google.com/marketplace/app/streak'), true);
  const gmail = { content_scripts: [{ matches: ['*://*.google.com/*'], js: ['app.js'] }] };
  assert.equal(contentScriptsRunOn(gmail, 'https://mail.google.com/mail/u/0/'), true);
  assert.equal(contentScriptsRunOn(gmail, 'https://google.com/'), true);
  assert.equal(contentScriptsRunOn(gmail, 'https://example.com/'), false);
  assert.equal(contentScriptsRunOn({ content_scripts: [{ matches: ['<all_urls>'], js: ['a.js'] }] }, 'https://anything.test/x'), true);
  assert.equal(contentScriptsRunOn({ content_scripts: [{ matches: ['https://a.test/inbox*'], js: ['a.js'] }] }, 'http://a.test/inbox'), false, 'scheme');
  assert.equal(contentScriptsRunOn({ content_scripts: [{ matches: ['https://a.test/inbox*'], js: ['a.js'] }] }, 'https://a.test/other'), false, 'path');
  assert.equal(contentScriptsRunOn({ content_scripts: [{ matches: ['https://a.test/*'], css: ['a.css'] }] }, 'https://a.test/'), false, 'styles only');
  assert.equal(contentScriptsRunOn({}, 'https://a.test/'), false);
  assert.equal(contentScriptsRunOn(gmail, 'not a url'), false);
});
