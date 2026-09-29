import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChatRow, chatTimeToDate, sortFeed, unreadFromTitle, parseMailLines, parseAgendaText, parseUsageText, isTimeLabel } from '../../lib/feed.js';

const now = new Date(2026, 8, 29, 16, 0); // martedì

test('parseChatRow riconosce chat, ora, anteprima e non letti', () => {
  assert.deepEqual(parseChatRow(['Mamma', '14:02', 'Ricordati il pane', '2']), { chat: 'Mamma', time: '14:02', unread: 2, preview: 'Ricordati il pane' });
  assert.deepEqual(parseChatRow(['Gruppo Lab', 'ieri', 'Marco:', 'domani alle 10']), { chat: 'Gruppo Lab', time: 'ieri', unread: 0, preview: 'Marco: · domani alle 10' });
  assert.equal(parseChatRow([]), null);
});

test('chatTimeToDate interpreta orari, ieri, giorni e date', () => {
  assert.equal(chatTimeToDate('14:02', now).getHours(), 14);
  assert.equal(chatTimeToDate('ieri', now).getDate(), 28);
  assert.equal(chatTimeToDate('sab', now).getDate(), 26);
  assert.equal(chatTimeToDate('lunedì', now).getDate(), 28);
  assert.equal(chatTimeToDate('12/09/2026', now).getMonth(), 8);
  assert.equal(chatTimeToDate('28 set', now).getDate(), 28);
  assert.equal(chatTimeToDate('3:15 PM', now).getHours(), 15);
  assert.equal(chatTimeToDate('boh', now), null);
  assert.ok(isTimeLabel('09:30') && isTimeLabel('Ieri') && !isTimeLabel('Ciao a tutti'));
});

test('sortFeed ordina dal più recente e mette in fondo quelli senza ora', () => {
  const sorted = sortFeed([{ chat: 'a', time: 'ieri' }, { chat: 'b', time: '15:00' }, { chat: 'c', time: '' }, { chat: 'd', at: now.getTime() }], now);
  assert.deepEqual(sorted.map(item => item.chat), ['d', 'b', 'a', 'c']);
});

test('unreadFromTitle', () => {
  assert.equal(unreadFromTitle('Posta in arrivo (12) - x@y.it - Gmail'), 12);
  assert.equal(unreadFromTitle('(3) WhatsApp'), 3);
  assert.equal(unreadFromTitle('Inbox - 4 unread'), 4);
  assert.equal(unreadFromTitle('Gmail'), 0);
});

test('parseMailLines (Outlook)', () => {
  assert.deepEqual(parseMailLines(['Non letto', 'Mario Rossi', 'Riunione', '10:24', 'Ciao, ti giro', 'il file']), { from: 'Mario Rossi', subject: 'Riunione', snippet: 'Ciao, ti giro il file', time: '10:24' });
});

test('parseAgendaText estrae titolo, orari e data', () => {
  const event = parseAgendaText('10:00 - 11:30, Lezione di Robotica, DEI, 30 settembre 2026', now);
  assert.equal(event.title, 'Lezione di Robotica');
  assert.equal(event.start.getDate(), 30);
  assert.equal(event.start.getHours(), 10);
  assert.equal(event.end.getMinutes(), 30);
  assert.equal(event.dated, true);
  const allDay = parseAgendaText('Tutto il giorno, Hackathon, 1 ottobre 2026', now);
  assert.equal(allDay.allDay, true);
  assert.equal(allDay.title, 'Hackathon');
});

test('parseUsageText legge la pagina di utilizzo di claude.ai', () => {
  const rows = parseUsageText('Plan usage limits\nCurrent session\nResets in 2 hr 14 min\n38% used\nWeekly limits\nAll models\nResets Thu 10:00 AM\n12% used');
  assert.deepEqual(rows.map(row => [row.label, row.percent]), [['Current session', 38], ['All models', 12]]);
  assert.match(rows[0].reset, /2 hr 14 min/);
});
