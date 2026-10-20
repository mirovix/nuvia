// The Claude chat window: "Ask Claude" on a selection, "Reply with Claude" on
// an email. Claude runs in the main process (lib/claude-chat.js); this page
// shows the conversation and, for an email, the reply Claude drafted.
import { $, h, icon, fill, hydrateIcons } from './core.js';

const chat = window.nuviaChat;
const log = $('#chat-log');
const text = $('#chat-text');
let meta = {};
let current = null; // the answer being written: { el, text }
let busy = false;

// Markdown, the little Claude uses in short answers: paragraphs, lists, **bold**, `code`, code blocks.
const escape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = value => escape(value).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
function markdown(source) {
  const out = []; let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const blocks = source.split(/```[a-z0-9]*\n?/i);
  blocks.forEach((block, index) => {
    if (index % 2) { close(); out.push(`<pre><code>${escape(block.replace(/\n$/, ''))}</code></pre>`); return; }
    for (const line of block.split('\n')) {
      const bullet = line.match(/^\s*[-*•]\s+(.*)/); const numbered = line.match(/^\s*\d+[.)]\s+(.*)/); const heading = line.match(/^#{1,4}\s+(.*)/);
      if (bullet || numbered) {
        const kind = bullet ? 'ul' : 'ol';
        if (list !== kind) { close(); out.push(`<${kind}>`); list = kind; }
        out.push(`<li>${inline((bullet || numbered)[1])}</li>`);
      } else if (!line.trim()) close();
      else { close(); out.push(heading ? `<p><strong>${inline(heading[1])}</strong></p>` : `<p>${inline(line)}</p>`); }
    }
  });
  close();
  return out.join('');
}

function draftCard(reply, done) {
  return h('div.chat-draft',
    h('div.chat-draft-head', icon('mail'), h('span', 'Reply draft')),
    h('div.chat-draft-text', reply),
    done ? h('div.chat-draft-actions',
      meta.canInsert ? h('button.btn.sm.accent', { type: 'button', on: { click: event => insert(reply, event.currentTarget) } }, icon('reply'), 'Insert into reply') : null,
      h('button.btn.sm', { type: 'button', on: { click: event => copy(reply, event.currentTarget) } }, icon('copy'), 'Copy')) : null);
}

// An answer: Markdown around the reply draft, which Claude puts between <reply> tags.
function renderAnswer(el, source, done) {
  const shown = done ? source : source.replace(/<\/?[a-z]*$/i, '');
  const parts = meta.mode === 'mail' ? shown.split(/(<reply>[\s\S]*?(?:<\/reply>|$))/) : [shown];
  fill(el, ...parts.filter(part => part.trim()).map(part => {
    const reply = part.match(/^<reply>([\s\S]*?)(<\/reply>)?$/);
    if (reply) return draftCard(reply[1].trim(), done || Boolean(reply[2]));
    const div = h('div.chat-md'); div.innerHTML = markdown(part.trim()); return div;
  }));
  if (!done && !source.trim()) fill(el, h('span.chat-typing', h('i'), h('i'), h('i')));
}

const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 40;
function addMessage(role, content) {
  const el = h(`div.chat-msg.${role}`);
  if (role === 'user') el.textContent = content; else renderAnswer(el, content || '', false);
  log.append(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

async function copy(value, button) {
  await chat.copy(value);
  flash(button, 'Copied');
}
async function insert(value, button) {
  const result = await chat.insert(value);
  if (result?.ok) flash(button, 'Inserted'); else addMessage('note', result?.reason || 'The reply box could not be filled: use Copy.');
}
function flash(button, label) {
  const before = [...button.childNodes];
  fill(button, icon('check'), label);
  setTimeout(() => fill(button, ...before), 1600);
}

function setBusy(value) {
  busy = value;
  $('#chat-send').disabled = value;
  for (const chip of document.querySelectorAll('.chat-chips button')) chip.disabled = value;
}

function send(value) {
  const message = value.trim();
  if (!message || busy) return;
  addMessage('user', message);
  current = { el: addMessage('assistant', ''), text: '' };
  setBusy(true);
  chat.send(message);
}

chat.onEvent(event => {
  if (event.type === 'delta') {
    if (!current) current = { el: addMessage('assistant', ''), text: '' };
    const follow = atBottom();
    current.text += event.text;
    renderAnswer(current.el, current.text, false);
    if (follow) log.scrollTop = log.scrollHeight;
  } else if (event.type === 'done') {
    if (!current) current = { el: addMessage('assistant', ''), text: event.text };
    renderAnswer(current.el, current.text || event.text, true);
    current = null; setBusy(false);
    text.focus();
  } else if (event.type === 'error') {
    current?.el.remove(); current = null; setBusy(false);
    const note = addMessage('note', event.message);
    if (event.fallback) note.append(h('button.btn.sm', { type: 'button', on: { click: () => chat.openInClaude() } }, icon('external-link'), 'Open in Claude'));
  }
});

$('#chat-form').addEventListener('submit', event => { event.preventDefault(); send(text.value); text.value = ''; text.style.height = ''; });
text.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#chat-form').requestSubmit(); }
});
text.addEventListener('input', () => { text.style.height = ''; text.style.height = `${Math.min(text.scrollHeight, 140)}px`; });
addEventListener('keydown', event => { if (event.key === 'Escape') chat.close(); });
$('#chat-close').addEventListener('click', () => chat.close());

hydrateIcons();
meta = await chat.start();
document.documentElement.dataset.theme = meta.theme || 'dark';
document.documentElement.dataset.accent = meta.accent || 'blue';
document.body.dataset.mode = meta.mode;
$('#chat-title').textContent = meta.title || 'Claude';
$('#chat-sub').textContent = meta.sub || '';
if (meta.quote) { const quote = $('#chat-context'); quote.textContent = meta.quote; quote.hidden = false; }
text.placeholder = meta.mode === 'mail' ? 'Answer Claude, or say what to change…' : 'Ask a follow-up…';
if (meta.mode === 'mail') {
  const chips = $('#chat-chips');
  fill(chips, ...['Write it now', 'Shorter', 'More formal', 'In English', 'In Italian'].map(label => h('button.chip', { type: 'button', on: { click: () => send(label === 'Write it now' ? 'Write the reply now with what you have.' : `${label}, please.`) } }, label)));
  chips.hidden = false;
}
if (meta.error) {
  const note = addMessage('note', meta.error);
  if (meta.fallback) note.append(h('button.btn.sm', { type: 'button', on: { click: () => chat.openInClaude() } }, icon('external-link'), 'Open in Claude'));
} else {
  // The first answer may already be streaming in.
  if (!current) current = { el: addMessage('assistant', ''), text: '' };
  setBusy(true);
}
window.__nuviaChatReady = true;
