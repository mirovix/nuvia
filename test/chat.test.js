import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch, writeProfile, project } from './helpers.js';

// Right click in a service: the usual browser menu, "Ask Claude" on a selection
// (a small window that answers about it) and "Reply with Claude" in Gmail
// (Claude reads the email, asks, drafts; the draft goes into the reply box).
// Claude Code is replaced by test/fixtures/fake-claude.mjs.
test('right click menu, Ask Claude on a selection, Reply with Claude in Gmail', { timeout: 120000 }, async () => {
  const app = await launch({
    prepare: profile => {
      const fixtures = join(profile, 'fixtures');
      cpSync(join(project, 'test', 'fixtures'), fixtures, { recursive: true });
      process.env.NUVIA_FIXTURES = fixtures;
      process.env.FAKE_CLAUDE_LOG = join(profile, 'claude.log');
      writeProfile(profile, { 'services.json': [{ id: 'gmail', name: 'Gmail Test', url: 'https://mail.google.com/mail/u/0/#inbox' }], 'preferences.json': { chatLanguage: 'Italian', name: 'Miro' } });
    },
    env: { NUVIA_CLAUDE_BIN: join(project, 'test', 'fixtures', 'fake-claude.mjs') }
  });
  const nuviaLog = () => { try { return readFileSync(join(app.profile, 'nuvia.log'), 'utf8'); } catch { return ''; } };
  const claudeSaw = () => { try { return readFileSync(join(app.profile, 'claude.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line)); } catch { return []; } };
  let ui; let gmail; let ask; let reply;
  // A right click where the element is (or on the selection), as the mouse does it.
  const rightClick = async (page, selector) => {
    const rect = selector === 'selection' ? 'getSelection().getRangeAt(0).getBoundingClientRect()' : `document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect()`;
    const { x, y } = await page.eval(`const r = ${rect}; return { x: Math.round(r.left + Math.min(8, r.width / 2)), y: Math.round(r.top + r.height / 2) }`);
    for (let attempt = 0; attempt < 3; attempt++) {
      await ui.eval('await window.nuvia.debugMenuClear(); return true');
      await ui.eval(`return window.nuvia.debugRightClick({ key: 'gmail', x: ${x}, y: ${y} })`);
      const menu = await ui.waitFor('window.nuvia.debugMenu()', { timeout: 3000 }).catch(() => null);
      if (menu) return menu;
    }
    throw new Error(`No menu after a right click on ${selector}`);
  };
  const labels = menu => menu.map(item => item.label);
  try {
    ui = await app.ui();
    await ui.eval(`document.querySelector('.service[data-id="gmail"]').click(); return true`);
    gmail = await app.page(target => target.type === 'page' && target.url.startsWith('https://mail.google.com'), 30000);
    await gmail.waitFor(`document.querySelector('h2.hP')`);

    // The page itself: navigation, and Claude for the email.
    let menu = await rightClick(gmail, 'h2.hP');
    assert.ok(labels(menu).includes('Reply with Claude'), labels(menu).join(', '));
    for (const label of ['Back', 'Reload', 'Open page in browser']) assert.ok(labels(menu).includes(label), label);

    // A text field: editing.
    menu = await rightClick(gmail, '#search');
    for (const label of ['Cut', 'Copy', 'Paste', 'Select all']) assert.ok(labels(menu).includes(label), label);

    // A selection: copy, and ask Claude about it.
    await gmail.eval(`const node = document.getElementById('body').firstChild; const start = node.data.indexOf('photosynthesis'); const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + 'photosynthesis'.length); getSelection().removeAllRanges(); getSelection().addRange(range); return true`);
    menu = await rightClick(gmail, 'selection');
    assert.ok(labels(menu).includes('Ask Claude about “photosynthesis”'), labels(menu).join(', '));
    assert.ok(labels(menu).includes('Copy'));
    await ui.eval(`return window.nuvia.debugMenuClick('Ask Claude about “photosynthesis”')`);
    ask = await app.page(target => target.type === 'page' && target.url.endsWith('chat.html'), 15000);
    await ask.waitFor(`document.querySelector('.chat-msg.assistant')?.innerText.includes('fotosintesi')`, { timeout: 20000 });
    assert.equal(await ask.eval(`return document.querySelector('.chat-context').innerText`), 'photosynthesis');
    assert.equal(await ask.eval(`return document.querySelector('.chat-msg.assistant strong')?.textContent`), 'fotosintesi', 'Markdown is rendered');
    // A follow-up in the same conversation.
    await ask.eval(`const box = document.getElementById('chat-text'); box.value = 'E in inglese?'; document.getElementById('chat-form').requestSubmit(); return true`);
    await ask.waitFor(`document.querySelectorAll('.chat-msg.assistant').length === 2 && !document.getElementById('chat-send').disabled`, { timeout: 20000 });
    let saw = claudeSaw();
    assert.match(saw.find(line => line.user)?.user || '', /Selected text:\n"""\nphotosynthesis\n"""/);
    assert.ok(saw.some(line => line.user === 'E in inglese?'), 'the follow-up reached Claude');
    const argv = saw.find(line => line.argv).argv;
    assert.equal(argv[argv.indexOf('--tools') + 1], '', 'no tools');
    assert.match(saw.find(line => line.argv).system, /Answer in Italian/);
    await ask.eval('window.nuviaChat.close(); return true').catch(() => {});
    ask.close(); ask = null;

    // Reply with Claude, from the button in the top bar.
    assert.equal(await ui.eval(`return document.getElementById('reply-claude').hidden`), false, 'the button shows in Gmail');
    await ui.eval(`document.getElementById('reply-claude').click(); return true`);
    reply = await app.page(target => target.type === 'page' && target.url.endsWith('chat.html'), 15000);
    await reply.waitFor(`document.querySelector('.chat-msg.assistant')?.innerText.includes('Giovedì alle 10')`, { timeout: 20000 });
    assert.match(await reply.eval(`return document.querySelector('.chat-context').innerText`), /Anna Rossi — Meeting notes/);
    saw = claudeSaw();
    const first = saw.filter(line => line.user).at(-1).user;
    assert.match(first, /Subject: Meeting notes/);
    assert.match(first, /from Anna Rossi <anna@example\.com>, Tue 29 Sep 2026, 09:12\nHere are today's notes/);
    assert.match(saw.filter(line => line.argv).at(-1).system, /Sign it as Miro/);
    // "Write it now": the draft, then into Gmail's reply box.
    await reply.eval(`[...document.querySelectorAll('.chat-chips button')].find(b => b.textContent === 'Write it now').click(); return true`);
    await reply.waitFor(`document.querySelector('.chat-draft-actions .btn.accent')`, { timeout: 20000 });
    assert.equal(await reply.eval(`return document.querySelector('.chat-draft-text').textContent`), 'Ciao Anna,\n\ngrazie per le note: giovedì alle 10 va benissimo.\n\nMiro');
    assert.doesNotMatch(await reply.eval(`return document.querySelector('.chat-msg.assistant:last-child').innerText`), /<\/?reply>/);
    await reply.eval(`document.querySelector('.chat-draft-actions .btn.accent').click(); return true`);
    await reply.waitFor(`document.querySelector('.chat-draft-actions .btn.accent').textContent.includes('Inserted')`, { timeout: 15000 });
    assert.equal(await gmail.eval(`return document.getElementById('compose').hidden`), false, 'the reply box was opened');
    assert.match(await gmail.eval(`return document.getElementById('editor').innerText`), /Ciao Anna,\n+grazie per le note: giovedì alle 10 va benissimo\.\n+Miro/);
  } catch (error) {
    throw new Error(`${error.message}\n--- Nuvia log ---\n${nuviaLog().slice(-2000)}\n--- Electron log ---\n${app.output().slice(-2500)}`);
  } finally {
    ask?.close(); reply?.close(); gmail?.close(); ui?.close(); await app.close();
  }
});

// ChatGPT chosen in Settings: the same tools, answered by the Codex CLI
// (test/fixtures/fake-codex-chat.mjs), on the first account not at its limit.
test('with ChatGPT chosen, Ask and Reply are answered by Codex', { timeout: 120000 }, async () => {
  const app = await launch({
    prepare: profile => {
      const fixtures = join(profile, 'fixtures');
      cpSync(join(project, 'test', 'fixtures'), fixtures, { recursive: true });
      process.env.NUVIA_FIXTURES = fixtures;
      mkdirSync(join(profile, 'home', '.codex'), { recursive: true });
      writeFileSync(join(profile, 'home', '.codex', 'auth.json'), '{}');
      mkdirSync(join(profile, 'codex-work'), { recursive: true });
      writeFileSync(join(profile, 'codex-work', 'auth.json'), '{}');
      process.env.NUVIA_CODEX_HOMES = join(profile, 'codex-work');
      writeProfile(profile, { 'services.json': [{ id: 'gmail', name: 'Gmail Test', url: 'https://mail.google.com/mail/u/0/#inbox' }], 'preferences.json': { chatLanguage: 'Italian', chatProvider: 'codex' } });
    },
    env: { NUVIA_CODEX_CHAT_BIN: join(project, 'test', 'fixtures', 'fake-codex-chat.mjs'), FAKE_CODEX_LIMITED: '.codex' }
  });
  const nuviaLog = () => { try { return readFileSync(join(app.profile, 'nuvia.log'), 'utf8'); } catch { return ''; } };
  let ui; let gmail; let ask;
  try {
    ui = await app.ui();
    await ui.eval(`document.querySelector('.service[data-id="gmail"]').click(); return true`);
    gmail = await app.page(target => target.type === 'page' && target.url.startsWith('https://mail.google.com'), 30000);
    await gmail.waitFor(`document.querySelector('h2.hP')`);
    assert.equal(await ui.eval(`return document.querySelector('#reply-claude span').textContent`), 'Reply with ChatGPT');
    await gmail.eval(`const node = document.getElementById('body').firstChild; const start = node.data.indexOf('photosynthesis'); const range = document.createRange(); range.setStart(node, start); range.setEnd(node, start + 'photosynthesis'.length); getSelection().removeAllRanges(); getSelection().addRange(range); return true`);
    const { x, y } = await gmail.eval(`const r = getSelection().getRangeAt(0).getBoundingClientRect(); return { x: Math.round(r.left + 4), y: Math.round(r.top + r.height / 2) }`);
    let menu = null;
    for (let attempt = 0; attempt < 3 && !menu; attempt++) {
      await ui.eval('await window.nuvia.debugMenuClear(); return true');
      await ui.eval(`return window.nuvia.debugRightClick({ key: 'gmail', x: ${x}, y: ${y} })`);
      menu = await ui.waitFor('window.nuvia.debugMenu()', { timeout: 3000 }).catch(() => null);
    }
    const labels = (menu || []).map(item => item.label);
    assert.ok(labels.includes('Ask ChatGPT about “photosynthesis”'), labels.join(', '));
    assert.ok(labels.includes('Reply with ChatGPT'));
    await ui.eval(`return window.nuvia.debugMenuClick('Ask ChatGPT about “photosynthesis”')`);
    ask = await app.page(target => target.type === 'page' && target.url.endsWith('chat.html'), 15000);
    await ask.waitFor(`document.querySelector('.chat-msg.assistant')?.innerText.includes('ChatGPT')`, { timeout: 20000 });
    assert.equal(await ask.eval(`return document.getElementById('chat-title').textContent`), 'Ask ChatGPT');
    assert.match(await ask.eval(`return document.querySelector('.chat-msg.assistant').innerText`), /codex-work/, 'the account at its limit handed over');
  } catch (error) {
    throw new Error(`${error.message}\n--- Nuvia log ---\n${nuviaLog().slice(-2000)}\n--- Electron log ---\n${app.output().slice(-2000)}`);
  } finally {
    ask?.close(); gmail?.close(); ui?.close(); await app.close();
  }
});
