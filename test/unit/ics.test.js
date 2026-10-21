import test from 'node:test';
import assert from 'node:assert/strict';
import { parseICS, expandEvents, zonedTimeToUtc, mergeConsecutive } from '../../lib/ics.js';

const ics = `BEGIN:VCALENDAR
BEGIN:VTIMEZONE
TZID:Europe/Rome
BEGIN:STANDARD
DTSTART:19701025T030000
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:single
DTSTART;TZID=Europe/Rome:20260930T100000
DTEND;TZID=Europe/Rome:20260930T113000
SUMMARY:Lezione di Robotica\\, aula 1
LOCATION:DEI
END:VEVENT
BEGIN:VEVENT
UID:weekly
DTSTART:20260928T070000Z
DTEND:20260928T080000Z
RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4
EXDATE:20260930T070000Z
SUMMARY:Stand-up
END:VEVENT
BEGIN:VEVENT
UID:weekly
RECURRENCE-ID:20261005T070000Z
DTSTART:20261005T090000Z
DTEND:20261005T100000Z
SUMMARY:Stand-up spostato
END:VEVENT
BEGIN:VEVENT
UID:allday
DTSTART;VALUE=DATE:20261001
DTEND;VALUE=DATE:20261002
SUMMARY:Hackathon
END:VEVENT
BEGIN:VEVENT
UID:cancelled
STATUS:CANCELLED
DTSTART:20261001T120000Z
SUMMARY:Annullato
END:VEVENT
END:VCALENDAR`.replace(/\n/g, '\r\n');

test('parseICS reads time zones, text and all-day events', () => {
  const events = parseICS(ics);
  const single = events.find(event => event.uid === 'single');
  assert.equal(single.title, 'Lezione di Robotica, aula 1');
  assert.equal(single.start.toISOString(), '2026-09-30T08:00:00.000Z');
  assert.equal(events.find(event => event.uid === 'allday').allDay, true);
});

test('expandEvents applies RRULE, EXDATE, overrides and cancellations', () => {
  const list = expandEvents(parseICS(ics), new Date('2026-09-27T00:00:00Z'), new Date('2026-10-20T00:00:00Z'));
  const standups = list.filter(event => event.uid === 'weekly');
  assert.deepEqual(standups.map(event => event.start.toISOString()), ['2026-09-28T07:00:00.000Z', '2026-10-05T09:00:00.000Z', '2026-10-07T07:00:00.000Z']);
  assert.equal(standups[1].title, 'Stand-up spostato');
  assert.ok(!list.some(event => event.title === 'Annullato'));
  assert.ok(list.some(event => event.title === 'Hackathon'));
  for (let i = 1; i < list.length; i += 1) assert.ok(list[i - 1].start <= list[i].start);
});

test('zonedTimeToUtc handles DST and Windows zone names', () => {
  assert.equal(zonedTimeToUtc(2026, 1, 15, 10, 0, 0, 'Europe/Rome').toISOString(), '2026-01-15T09:00:00.000Z');
  assert.equal(zonedTimeToUtc(2026, 7, 15, 10, 0, 0, 'W. Europe Standard Time').toISOString(), '2026-07-15T08:00:00.000Z');
});

test('daily and monthly recurrences with UNTIL', () => {
  const text = 'BEGIN:VEVENT\nUID:d\nDTSTART:20260101T090000Z\nRRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20260107T235959Z\nSUMMARY:D\nEND:VEVENT\nBEGIN:VEVENT\nUID:m\nDTSTART:20260115T090000Z\nRRULE:FREQ=MONTHLY;COUNT=3\nSUMMARY:M\nEND:VEVENT';
  const list = expandEvents(parseICS(text), new Date('2025-12-31'), new Date('2026-12-31'));
  assert.equal(list.filter(event => event.uid === 'd').length, 4);
  assert.equal(list.filter(event => event.uid === 'm').length, 3);
});

test('the same appointment in consecutive hours or days, or copied, becomes one event', () => {
  const h = hour => Date.UTC(2026, 9, 20) + hour * 3600000;
  const event = (title, start, end, extra = {}) => ({ title, start: h(start), end: h(end), sourceId: 'uni', location: 'DEI', allDay: false, ...extra });
  const merged = mergeConsecutive([
    event('Robotica', 10, 11), event('Robotica', 9, 10), event('Lunch', 9.5, 10.5, { location: '' }), event('robotica ', 11.25, 12),
    event('Robotica', 15, 16), event('Robotica', 16, 17, { location: 'Aula B' }), event('Robotica', 16, 17, { sourceId: 'gmail' }),
    event('Holiday', 0, 24, { allDay: true }), event('Holiday', 24, 48, { allDay: true }),
    ...Array.from({ length: 3 }, () => event('Invito accettato', 48, 72, { allDay: true, location: '' })), event('Robotica', 48, 72, { allDay: true })
  ]);
  assert.deepEqual(merged.map(item => [item.title, (item.start - h(0)) / 3600000, (item.end - h(0)) / 3600000, item.sourceId, item.location, item.copies || 1]), [
    ['Holiday', 0, 48, 'uni', 'DEI', 1],
    ['Robotica', 9, 12, 'uni', 'DEI', 1],
    ['Lunch', 9.5, 10.5, 'uni', '', 1],
    ['Robotica', 15, 16, 'uni', 'DEI', 1],
    ['Robotica', 16, 17, 'uni', 'Aula B', 1],
    ['Robotica', 16, 17, 'gmail', 'DEI', 1],
    ['Invito accettato', 48, 72, 'uni', '', 3],
    ['Robotica', 48, 72, 'uni', 'DEI', 1]
  ]);
});
