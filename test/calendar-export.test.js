import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, writeFileSync } from 'node:fs';
import { crc32 } from 'node:zlib';
import { join } from 'node:path';
import { launch, writeProfile, project } from './helpers.js';

// Google's calendar export fails (net::ERR_FAILED) from Nuvia's main process for
// some accounts, and works from a calendar.google.com page. Nuvia must then
// download it from the page, not read the agenda's text, which has no dates on
// the events and put the whole week on today.
function storedZip(name, text) {
  const data = Buffer.from(text); const file = Buffer.from(name);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(file.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(file.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + file.length, 12); end.writeUInt32LE(30 + file.length + data.length, 16);
  return Buffer.concat([local, file, data, central, file, end]);
}
const stamp = date => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

test('Google Calendar: exported from the page when the direct download fails', { timeout: 90000 }, async () => {
  const at = (days, hour) => { const date = new Date(); date.setDate(date.getDate() + days); date.setHours(hour, 0, 0, 0); return date; };
  const event = (uid, title, days, from, to) => `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART:${stamp(at(days, from))}\r\nDTEND:${stamp(at(days, to))}\r\nSUMMARY:${title}\r\nEND:VEVENT\r\n`;
  const app = await launch({
    prepare: profile => {
      const fixtures = join(profile, 'fixtures');
      cpSync(join(project, 'test', 'fixtures'), fixtures, { recursive: true });
      process.env.NUVIA_FIXTURES = fixtures;
      writeFileSync(join(fixtures, 'calendar.google.com_calendar_u_0_exporticalzip.zip'), storedZip('Arsenal FC_abc@group.calendar.google.com.ics',
        `BEGIN:VCALENDAR\r\n${event('a', 'Arsenal vs Hull', 2, 15, 17)}${event('b', 'Arsenal vs Fleetwood', 4, 20, 22)}${event('c', 'Team meeting', 0, 22, 23)}END:VCALENDAR\r\n`));
      writeProfile(profile, { 'services.json': [{ id: 'gmail', name: 'Gmail Personal', url: 'https://mail.google.com/' }], 'preferences.json': {} });
    }
  });
  let ui;
  try {
    ui = await app.ui();
    const calendar = JSON.parse(await ui.eval(`return JSON.stringify(await window.nuvia.calendarEvents({ days: 21, force: true }))`));
    const source = calendar.sources.find(item => item.name === 'Gmail Personal');
    assert.equal(source.method, 'export', JSON.stringify(source));
    const day = event => Math.round((new Date(event.start).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
    assert.deepEqual(calendar.events.map(item => [item.title, day(item)]), [['Team meeting', 0], ['Arsenal vs Hull', 2], ['Arsenal vs Fleetwood', 4]], 'each event on its own day');
    assert.ok(!calendar.events.some(item => /Thesis review|Robotics lecture/.test(item.title)), 'not the agenda page text');
  } catch (error) {
    throw new Error(`${error.message}\n--- Electron log ---\n${app.output().slice(-2000)}`);
  } finally {
    ui?.close(); await app.close();
  }
});
