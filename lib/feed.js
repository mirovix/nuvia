// Parsers for text scraped from web apps (chat lists, inboxes, agendas, titles).

const DAY_NAMES = { dom: 0, domenica: 0, sun: 0, sunday: 0, lun: 1, lunedi: 1, mon: 1, monday: 1, mar: 2, martedi: 2, tue: 2, tuesday: 2, mer: 3, mercoledi: 3, wed: 3, wednesday: 3, gio: 4, giovedi: 4, thu: 4, thursday: 4, ven: 5, venerdi: 5, fri: 5, friday: 5, sab: 6, sabato: 6, sat: 6, saturday: 6 };
const MONTHS = { gen: 0, gennaio: 0, jan: 0, january: 0, feb: 1, febbraio: 1, february: 1, mar: 2, marzo: 2, march: 2, apr: 3, aprile: 3, april: 3, mag: 4, maggio: 4, may: 4, giu: 5, giugno: 5, jun: 5, june: 5, lug: 6, luglio: 6, jul: 6, july: 6, ago: 7, agosto: 7, aug: 7, august: 7, set: 8, sett: 8, settembre: 8, sep: 8, sept: 8, september: 8, ott: 9, ottobre: 9, oct: 9, october: 9, nov: 10, novembre: 10, november: 10, dic: 11, dicembre: 11, dec: 11, december: 11 };

const plain = value => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export function unreadFromTitle(title = '') {
  const match = title.match(/\((\d+)\+?\)/) || title.match(/(\d+)\+?\s+(?:unread|non lett|nuov)/i);
  return match ? Number.parseInt(match[1], 10) : 0;
}

const CLOCK = /^(\d{1,2})[:.](\d{2})(?:\s?([ap])\.?m\.?)?$/i;
const NUMERIC_DATE = /^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?$/;
const WORD_DATE = /^(\d{1,2})\s+([a-zà-ù]{3,})\.?(?:\s+(\d{4}))?$/i;

export function isTimeLabel(value) {
  const text = plain(value).replace(/\.$/, '');
  if (!text || text.length > 20) return false;
  return CLOCK.test(text) || NUMERIC_DATE.test(text) || text in DAY_NAMES || ['ieri', 'yesterday', 'oggi', 'today', 'adesso', 'now', 'ora'].includes(text)
    || (WORD_DATE.test(text) && plain(text.match(WORD_DATE)[2]) in MONTHS);
}

export function chatTimeToDate(label, now = new Date()) {
  const text = plain(label).replace(/\.$/, '');
  if (!text) return null;
  const clock = text.match(CLOCK);
  if (clock) {
    let hour = Number(clock[1]);
    if (clock[3] === 'p' && hour < 12) hour += 12;
    if (clock[3] === 'a' && hour === 12) hour = 0;
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, Number(clock[2]));
  }
  if (['adesso', 'now', 'ora', 'oggi', 'today'].includes(text)) return new Date(now);
  if (['ieri', 'yesterday'].includes(text)) return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12);
  if (text in DAY_NAMES) {
    const back = ((now.getDay() - DAY_NAMES[text] + 7) % 7) || 7;
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, 12);
  }
  const numeric = text.match(NUMERIC_DATE);
  if (numeric) {
    const year = numeric[3] ? (numeric[3].length === 2 ? 2000 + Number(numeric[3]) : Number(numeric[3])) : now.getFullYear();
    return new Date(year, Number(numeric[2]) - 1, Number(numeric[1]), 12);
  }
  const word = text.match(WORD_DATE);
  if (word && plain(word[2]) in MONTHS) {
    let date = new Date(word[3] ? Number(word[3]) : now.getFullYear(), MONTHS[plain(word[2])], Number(word[1]), 12);
    if (!word[3] && date > now) date = new Date(date.getFullYear() - 1, date.getMonth(), date.getDate(), 12);
    return date;
  }
  return null;
}

// A chat list row as innerText lines, e.g. ["Mamma", "14:02", "Ok a dopo", "2"].
export function parseChatRow(lines) {
  const clean = lines.map(line => String(line).replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!clean.length) return null;
  const chat = clean[0];
  let time = ''; let unread = 0; const rest = [];
  for (const line of clean.slice(1)) {
    if (!time && isTimeLabel(line)) time = line;
    else if (/^\d{1,4}$/.test(line) && !unread) unread = Number(line);
    else if (!/^(?:non letti?|unread|messaggi? non lett[oi])$/i.test(line)) rest.push(line);
  }
  const preview = rest.filter(line => line !== chat).join(' · ').replace(/^(?:·\s*)+/, '');
  return { chat, time, unread, preview };
}

export function sortFeed(items, now = new Date()) {
  return items
    .map((item, order) => ({ ...item, at: item.at ?? chatTimeToDate(item.time, now)?.getTime() ?? null, order }))
    .sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity) || a.order - b.order)
    .map(({ order, ...item }) => item);
}

// Outlook message rows: ["Mario Rossi", "Riunione", "10:24", "Ciao, ti giro..."].
export function parseMailLines(lines) {
  const clean = lines.map(line => String(line).replace(/\s+/g, ' ').trim()).filter(line => line && !/^(?:non letto|unread|contrassegnato|flagged|con allegati?|has attachments?)$/i.test(line));
  if (!clean.length) return null;
  const timeIndex = clean.findIndex((line, index) => index > 0 && isTimeLabel(line));
  const time = timeIndex > 0 ? clean[timeIndex] : '';
  const others = clean.filter((_, index) => index !== timeIndex);
  return { from: others[0] || '', subject: others[1] || '', snippet: others.slice(2).join(' '), time };
}

// "10:00 – 11:30, Lezione di Robotica, Aula Magna, 30 settembre 2026"
export function parseAgendaText(text, now = new Date()) {
  const source = String(text).replace(/\s+/g, ' ').trim();
  const times = [...source.matchAll(/\b(\d{1,2})[:.](\d{2})\b/g)];
  const dateMatch = source.match(/\b(\d{1,2})\s+([a-zà-ù]{3,})\.?\s+(\d{4})\b/i) || source.match(/\b(\d{1,2})\s+([a-zà-ù]{3,})\b/i);
  let day = null;
  if (dateMatch && plain(dateMatch[2]) in MONTHS) day = new Date(dateMatch[3] ? Number(dateMatch[3]) : now.getFullYear(), MONTHS[plain(dateMatch[2])], Number(dateMatch[1]));
  else if (/\b(?:oggi|today)\b/i.test(source)) day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  else if (/\b(?:domani|tomorrow)\b/i.test(source)) day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const allDay = !times.length || /tutto il giorno|all day/i.test(source);
  const at = (base, match) => new Date(base.getFullYear(), base.getMonth(), base.getDate(), Number(match[1]), Number(match[2]));
  const base = day || new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = allDay ? base : at(base, times[0]);
  const end = !allDay && times[1] ? at(base, times[1]) : new Date(start.getTime() + (allDay ? 86400000 : 3600000));
  const segments = source.split(/,\s*/).map(part => part.trim()).filter(Boolean);
  const title = segments.find(part => !/\d{1,2}[:.]\d{2}/.test(part) && !(dateMatch && part.includes(dateMatch[0])) && !/^(?:accettat|accepted|in attesa|needs|organizzat|tutto il giorno|all day|evento|event|\d+ (?:minuti|min))/i.test(part)) || source.slice(0, 80);
  return { title, start, end, allDay, dated: Boolean(day), raw: source };
}

// Text of claude.ai/settings/usage: "Current session  Resets in 2 hr 14 min  38% used".
export function parseUsageText(text) {
  const lines = String(text).split(/\n+/).map(line => line.trim()).filter(Boolean);
  const rows = [];
  for (let index = 0; index < lines.length; index += 1) {
    const percent = lines[index].match(/(\d{1,3})\s*%\s*(?:used|utilizzat[oa])?/i);
    if (!percent) continue;
    const window = lines.slice(Math.max(0, index - 4), index);
    const label = [...window].reverse().find(line => /session|sessione|weekly|settiman|all models|tutti i modelli|opus|sonnet|limit/i.test(line) && !/reset|ripristin/i.test(line)) || window[0] || 'Limite';
    const reset = [...window, lines[index + 1] || ''].find(line => /reset|ripristin/i.test(line)) || '';
    rows.push({ label, percent: Math.min(100, Number(percent[1])), reset });
  }
  return rows;
}
