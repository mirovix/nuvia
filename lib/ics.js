// Minimal iCalendar reader: VEVENT, TZID, all-day events, RRULE (daily, weekly,
// monthly, yearly with INTERVAL/COUNT/UNTIL/BYDAY/BYMONTHDAY), EXDATE and overrides.

const WINDOWS_ZONES = {
  'W. Europe Standard Time': 'Europe/Rome', 'Central Europe Standard Time': 'Europe/Budapest', 'Romance Standard Time': 'Europe/Paris',
  'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Atlantic/Reykjavik', 'UTC': 'UTC', 'Coordinated Universal Time': 'UTC',
  'Central European Standard Time': 'Europe/Warsaw', 'E. Europe Standard Time': 'Europe/Bucharest', 'Eastern Standard Time': 'America/New_York',
  'Pacific Standard Time': 'America/Los_Angeles', 'Central Standard Time': 'America/Chicago', 'Mountain Standard Time': 'America/Denver'
};
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

export function unfold(text) { return String(text).replace(/\r?\n[ \t]/g, ''); }

function unescapeText(value = '') {
  return value.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
}

function parseLine(line) {
  let quoted = false; let colon = -1;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '"') quoted = !quoted;
    else if (line[index] === ':' && !quoted) { colon = index; break; }
  }
  if (colon < 0) return null;
  const [name, ...rawParams] = line.slice(0, colon).split(';');
  const params = {};
  for (const param of rawParams) { const [key, ...value] = param.split('='); params[key.toUpperCase()] = value.join('=').replace(/^"|"$/g, ''); }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

function zoneOffset(timestamp, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second) - timestamp;
}

export function zonedTimeToUtc(year, month, day, hour, minute, second, timeZone) {
  const zone = WINDOWS_ZONES[timeZone] || timeZone;
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  try {
    const first = zoneOffset(guess, zone);
    let utc = guess - first;
    const second = zoneOffset(utc, zone);
    if (second !== first) utc = guess - second;
    return new Date(utc);
  } catch {
    return new Date(year, month - 1, day, hour, minute, second);
  }
}

export function parseDate(value, params = {}) {
  const match = String(value).match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = '0', utc] = match;
  if (params.VALUE === 'DATE' || hour === undefined) return { date: new Date(+year, +month - 1, +day), allDay: true };
  if (utc) return { date: new Date(Date.UTC(+year, +month - 1, +day, +hour, +minute, +second)), allDay: false };
  if (params.TZID) return { date: zonedTimeToUtc(+year, +month, +day, +hour, +minute, +second, params.TZID), allDay: false };
  return { date: new Date(+year, +month - 1, +day, +hour, +minute, +second), allDay: false };
}

function parseRule(value) {
  const rule = Object.fromEntries(value.split(';').map(part => part.split('=')).map(([key, val]) => [key.toUpperCase(), val]));
  return {
    freq: rule.FREQ, interval: Math.max(1, Number(rule.INTERVAL || 1)), count: rule.COUNT ? Number(rule.COUNT) : null,
    until: rule.UNTIL ? parseDate(rule.UNTIL)?.date : null,
    byDay: rule.BYDAY ? rule.BYDAY.split(',').map(item => ({ ordinal: Number(item.slice(0, -2)) || 0, day: WEEKDAYS.indexOf(item.slice(-2)) })) : [],
    byMonthDay: rule.BYMONTHDAY ? rule.BYMONTHDAY.split(',').map(Number) : []
  };
}

export function parseICS(text) {
  const events = [];
  let current = null; let depth = 0;
  for (const line of unfold(text).split(/\r?\n/)) {
    if (line === 'BEGIN:VEVENT') { current = { exdates: [] }; depth = 0; continue; }
    if (!current) continue;
    if (line.startsWith('BEGIN:')) { depth += 1; continue; }
    if (line.startsWith('END:') && depth > 0) { depth -= 1; continue; }
    if (line === 'END:VEVENT') {
      if (current.start) events.push({ ...current, end: current.end || new Date(current.start.getTime() + (current.allDay ? 86400000 : 3600000)) });
      current = null; continue;
    }
    if (depth > 0) continue;
    const parsed = parseLine(line); if (!parsed) continue;
    const { name, params, value } = parsed;
    if (name === 'UID') current.uid = value;
    else if (name === 'SUMMARY') current.title = unescapeText(value);
    else if (name === 'LOCATION') current.location = unescapeText(value);
    else if (name === 'STATUS') current.status = value.toUpperCase();
    else if (name === 'DTSTART') { const date = parseDate(value, params); if (date) { current.start = date.date; current.allDay = date.allDay; } }
    else if (name === 'DTEND') { const date = parseDate(value, params); if (date) current.end = date.date; }
    else if (name === 'DURATION' && current.start) {
      const match = value.match(/P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/);
      if (match) current.end = new Date(current.start.getTime() + (((+match[1] || 0) * 7 + (+match[2] || 0)) * 86400 + (+match[3] || 0) * 3600 + (+match[4] || 0) * 60 + (+match[5] || 0)) * 1000);
    }
    else if (name === 'RRULE') current.rrule = parseRule(value);
    else if (name === 'EXDATE') for (const item of value.split(',')) { const date = parseDate(item, params); if (date) current.exdates.push(date.date.getTime()); }
    else if (name === 'RECURRENCE-ID') current.recurrenceId = parseDate(value, params)?.date.getTime();
  }
  return events;
}

function withTimeOf(day, source) {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), source.getHours(), source.getMinutes(), source.getSeconds());
}

function nthWeekday(year, month, weekday, ordinal) {
  if (ordinal > 0) {
    const first = new Date(year, month, 1);
    const day = 1 + ((weekday - first.getDay() + 7) % 7) + (ordinal - 1) * 7;
    return day <= new Date(year, month + 1, 0).getDate() ? new Date(year, month, day) : null;
  }
  const last = new Date(year, month + 1, 0);
  const day = last.getDate() - ((last.getDay() - weekday + 7) % 7) + (ordinal + 1) * 7;
  return day >= 1 ? new Date(year, month, day) : null;
}

function* occurrences(event, to) {
  const { rrule, start } = event;
  if (!rrule) { yield start; return; }
  let emitted = 0; let guard = 0;
  const done = date => (rrule.until && date > rrule.until) || date > to || (rrule.count !== null && emitted >= rrule.count);
  if (rrule.freq === 'DAILY') {
    for (let date = new Date(start); guard < 20000; guard += 1, date = withTimeOf(new Date(date.getFullYear(), date.getMonth(), date.getDate() + rrule.interval), start)) {
      if (done(date)) return; emitted += 1; yield date;
    }
  } else if (rrule.freq === 'WEEKLY') {
    const days = rrule.byDay.length ? rrule.byDay.map(item => item.day).sort() : [start.getDay()];
    const weekStart = new Date(start.getFullYear(), start.getMonth(), start.getDate() - start.getDay());
    for (let week = 0; guard < 5000; week += rrule.interval, guard += 1) {
      for (const day of days) {
        const date = withTimeOf(new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + week * 7 + day), start);
        if (date < start) continue;
        if (done(date)) return; emitted += 1; yield date;
      }
    }
  } else if (rrule.freq === 'MONTHLY') {
    for (let step = 0; guard < 3000; step += rrule.interval, guard += 1) {
      const year = start.getFullYear(); const month = start.getMonth() + step;
      const candidates = rrule.byDay.length
        ? rrule.byDay.map(item => nthWeekday(new Date(year, month, 1).getFullYear(), new Date(year, month, 1).getMonth(), item.day, item.ordinal || 1)).filter(Boolean)
        : (rrule.byMonthDay.length ? rrule.byMonthDay : [start.getDate()]).map(day => { const date = new Date(year, month, day); return date.getMonth() === ((month % 12) + 12) % 12 ? date : null; }).filter(Boolean);
      for (const day of candidates.sort((a, b) => a - b)) {
        const date = withTimeOf(day, start);
        if (date < start) continue;
        if (done(date)) return; emitted += 1; yield date;
      }
    }
  } else if (rrule.freq === 'YEARLY') {
    for (let step = 0; guard < 500; step += rrule.interval, guard += 1) {
      const date = withTimeOf(new Date(start.getFullYear() + step, start.getMonth(), start.getDate()), start);
      if (done(date)) return; emitted += 1; yield date;
    }
  } else yield start;
}

export function expandEvents(events, from, to, limit = 1000) {
  const overrides = new Map();
  for (const event of events) if (event.recurrenceId) overrides.set(`${event.uid}|${event.recurrenceId}`, event);
  const result = [];
  for (const event of events) {
    if (event.recurrenceId || event.status === 'CANCELLED') continue;
    const duration = event.end - event.start;
    for (const date of occurrences(event, to)) {
      const override = overrides.get(`${event.uid}|${date.getTime()}`);
      if (event.exdates.includes(date.getTime())) continue;
      const item = override || event;
      if (item.status === 'CANCELLED') continue;
      const start = override ? override.start : date;
      const end = override ? override.end : new Date(date.getTime() + duration);
      if (end <= from || start > to) continue;
      result.push({ uid: event.uid, title: item.title || '(senza titolo)', location: item.location || '', start, end, allDay: Boolean(item.allDay) });
      if (result.length > limit * 4) break;
    }
  }
  return result.sort((a, b) => a.start - b.start).slice(0, limit);
}
