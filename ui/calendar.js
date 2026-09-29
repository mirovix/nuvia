import { api, state, $, h, icon, fill, emit, on, empty, skeleton, clock, dayLabel, sameDay, startOfDay, savePrefs, toggle, toast } from './core.js';
import { defineWidget } from './home.js';
import { openService } from './router.js';
import { openAddService } from './services.js';

const PALETTE = ['#ff6a3d', '#5d7dff', '#3ccf9f', '#b497ff', '#ffb21f', '#ff5c8a', '#4ec3e0'];
const view = { selected: startOfDay(Date.now()).getTime(), offset: 0 };
let busy = false;

export async function refreshCalendar(force = false) {
  if (busy) return;
  busy = true;
  try { state.calendar = await api.calendarEvents({ days: 21, force }); emit('calendar'); }
  catch (error) { console.error(error); }
  finally { busy = false; }
}

function colorOf(sourceId) {
  const custom = state.prefs.calendar?.colors?.[sourceId];
  if (custom) return custom;
  const index = (state.calendar?.sources || []).findIndex(source => source.id === sourceId);
  return PALETTE[Math.max(0, index) % PALETTE.length];
}

function webCalendarUrl(source, at) {
  const service = state.services.find(item => item.id === source?.id);
  if (!service) return null;
  const date = new Date(at || Date.now());
  if (service.kind === 'outlook') return /outlook\.office/.test(service.url) ? 'https://outlook.office.com/calendar/view/day' : 'https://outlook.live.com/calendar/0/view/day';
  const account = service.url.match(/\/u\/(\d+)/)?.[1] || '0';
  return `https://calendar.google.com/calendar/u/${account}/r/day/${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

function openEvent(event) {
  const source = state.calendar?.sources.find(item => item.id === event.sourceId);
  const url = webCalendarUrl(source, event.start);
  if (url) openService(source.id, { url });
}

function eventRow(event) {
  const now = Date.now();
  const past = event.end < now; const current = event.start <= now && event.end > now;
  return h(`button.event${past ? '.past' : ''}${current ? '.now' : ''}`, { type: 'button', style: `--c:${colorOf(event.sourceId)}`, title: event.source, on: { click: () => openEvent(event) } },
    h('span.when', event.allDay ? 'tutto il giorno' : clock(event.start), !event.allDay ? h('small', clock(event.end)) : null),
    h('span.bar'),
    h('span.what', h('strong', event.title), h('span', [event.location, event.source].filter(Boolean).join(' · '))));
}

function eventsOn(day) {
  const start = startOfDay(day).getTime(); const end = start + 86400000;
  return (state.calendar?.events || []).filter(event => event.start < end && event.end > start && (!event.allDay || event.start >= start || event.end > start + 1));
}

function weekStrip(onPick) {
  const today = startOfDay(Date.now()).getTime();
  return h('div.week', Array.from({ length: 7 }, (_, index) => {
    const day = today + index * 86400000;
    const date = new Date(day);
    const has = eventsOn(day).length > 0;
    return h(`button${day === view.selected ? '.on' : ''}${index === 0 ? '.today' : ''}${has ? '.has' : ''}`, { type: 'button', on: { click: () => onPick(day) } },
      h('small', date.toLocaleDateString('it-IT', { weekday: 'short' }).replace('.', '')), h('b', String(date.getDate())), h('i'));
  }));
}

function sourceProblems() {
  return (state.calendar?.sources || []).filter(source => source.enabled && !source.ok);
}

// ---------------------------------------------------------------------------
// Widget

defineWidget({
  id: 'calendar', title: 'Calendario', icon: 'calendar', size: 'm', topics: ['calendar', 'services'],
  actions: () => [h('button.icon-btn.small', { title: 'Aggiorna', on: { click: () => refreshCalendar(true) } }, icon('refresh-cw')), h('button.link', { on: { click: () => emit('go', 'calendar') } }, 'Agenda', icon('arrow-right'))],
  render(ctx) {
    const hasSources = state.services.some(service => service.group === 'mail') || (state.prefs.calendar?.feeds || []).length;
    if (!hasSources) { ctx.setMeta(''); return fill(ctx.body, empty('calendar', 'Nessun calendario', 'Collega Gmail o Outlook, oppure aggiungi un link iCal dall’agenda.', h('button.btn.sm', { on: { click: () => openAddService({ name: 'Gmail', url: 'https://mail.google.com/' }) } }, icon('plus'), 'Collega un account'))); }
    if (!state.calendar) { ctx.setMeta('sincronizzazione…'); return fill(ctx.body, skeleton(3)); }
    const selectedEvents = eventsOn(view.selected);
    const upcoming = state.calendar.events.filter(event => event.end > Date.now());
    ctx.setMeta(`${dayLabel(view.selected, { long: true })} · ${selectedEvents.length} ${selectedEvents.length === 1 ? 'impegno' : 'impegni'}`);
    const problems = sourceProblems();
    let list;
    if (selectedEvents.length) list = h('div.events', selectedEvents.map(eventRow));
    else {
      const next = upcoming.find(event => event.start >= view.selected + 86400000);
      list = h('div', empty('calendar-days', 'Niente in programma', next ? `Prossimo: ${next.title}, ${dayLabel(next.start).toLowerCase()} alle ${clock(next.start)}` : ''), next ? h('div.events', eventRow(next)) : null);
    }
    fill(ctx.body,
      weekStrip(day => { view.selected = day; ctx.render(); }),
      list,
      problems.length ? h('button.chip', { style: 'margin-top:10px', on: { click: () => emit('go', 'calendar') } }, icon('triangle-alert'), `${problems.map(source => source.name).join(', ')}: ${problems[0].loggedOut ? 'accesso richiesto' : 'non sincronizzato'}`) : null);
  }
});

// ---------------------------------------------------------------------------
// Page

function feedsForm() {
  const name = h('input', { placeholder: 'Nome (es. Università)' });
  const url = h('input', { placeholder: 'https://… .ics  oppure webcal://…', spellcheck: false });
  const add = h('button.btn.sm', { type: 'button', on: { click: () => {
    const href = url.value.trim();
    if (!/^(https?|webcal):\/\/.+/i.test(href)) { toast('Incolla un link iCal valido'); return; }
    state.prefs.calendar ||= {}; state.prefs.calendar.feeds ||= [];
    state.prefs.calendar.feeds.push({ id: `ics-${crypto.randomUUID().slice(0, 8)}`, name: name.value.trim() || 'Calendario iCal', url: href });
    savePrefs(); name.value = ''; url.value = '';
    setTimeout(() => refreshCalendar(true), 300);
  } } }, icon('plus'), 'Aggiungi');
  return h('div', h('div.field', name), h('div.field', url), add,
    h('p.note', 'Outlook: Impostazioni → Calendario → Calendari condivisi → Pubblica un calendario → copia il link ICS. Google: Impostazioni del calendario → Indirizzo segreto in formato iCal.'));
}

function renderSources() {
  const sources = state.calendar?.sources || [];
  const disabled = new Set(state.prefs.calendar?.disabled || []);
  return h('div.card', h('h3', 'Calendari'),
    sources.length ? sources.map(source => h('div.check', { style: 'align-items:flex-start' },
      toggle(!disabled.has(source.id), value => {
        state.prefs.calendar ||= {};
        const set = new Set(state.prefs.calendar.disabled || []);
        if (value) set.delete(source.id); else set.add(source.id);
        state.prefs.calendar.disabled = [...set]; savePrefs();
        setTimeout(() => refreshCalendar(), 250);
      }, source.name),
      h('div', { style: 'flex:1;min-width:0' },
        h('div', { style: 'display:flex;align-items:center;gap:8px' }, h('span.swatch', { style: `--c:${colorOf(source.id)}` }), h('strong', { style: 'font-weight:600' }, source.name)),
        h('small.muted', !source.enabled ? 'disattivato' : source.ok ? `${source.count} eventi · ${source.method === 'export' ? 'sincronizzato' : source.method === 'ics' ? 'iCal' : 'letto dalla pagina'}` : (source.message || 'non disponibile')),
        source.loggedOut ? h('button.link', { on: { click: () => openService(source.id, { url: webCalendarUrl(source) }) } }, 'Accedi', icon('arrow-right')) : null),
      source.type === 'ics' ? h('button.icon-btn.small', { title: 'Rimuovi', on: { click: () => { state.prefs.calendar.feeds = state.prefs.calendar.feeds.filter(feed => feed.id !== source.id); savePrefs(); setTimeout(() => refreshCalendar(), 250); } } }, icon('trash-2'))
        : h('button.icon-btn.small', { title: 'Apri il calendario web', on: { click: () => openService(source.id, { url: webCalendarUrl(source) }) } }, icon('external-link')))) : h('p.muted', 'Nessuna fonte.'),
    h('h3', { style: 'margin-top:18px' }, 'Aggiungi link iCal'), feedsForm());
}

export function renderPage() {
  const page = $('#page-calendar');
  const base = startOfDay(Date.now()).getTime() + view.offset * 7 * 86400000;
  const month = new Date(base).toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });
  const head = h('div.page-head', h('h2', month.replace(/^\w/, c => c.toUpperCase())),
    h('div.actions',
      h('button.icon-btn', { title: 'Settimana precedente', on: { click: () => { view.offset -= 1; renderPage(); } } }, icon('chevron-left')),
      h('button.btn.sm', { on: { click: () => { view.offset = 0; renderPage(); } } }, 'Oggi'),
      h('button.icon-btn', { title: 'Settimana successiva', on: { click: () => { view.offset += 1; renderPage(); } } }, icon('chevron-right')),
      h('button.btn.sm', { on: { click: () => refreshCalendar(true) } }, icon('refresh-cw'), 'Sincronizza')));
  let agenda;
  if (!state.calendar) agenda = skeleton(6);
  else {
    const days = Array.from({ length: 14 }, (_, index) => base + index * 86400000);
    const blocks = days.map(day => ({ day, events: eventsOn(day) })).filter(block => block.events.length || sameDay(block.day, Date.now()));
    agenda = blocks.length ? h('div.agenda', blocks.map(({ day, events }) => h(`div.agenda-day${sameDay(day, Date.now()) ? '.today' : ''}`,
      h('div.date', h('b', String(new Date(day).getDate())), h('span', dayLabel(day))),
      events.length ? h('div.events', events.map(eventRow)) : h('p.muted', { style: 'margin:10px 0' }, 'Niente in programma')))) : empty('calendar-days', 'Due settimane libere', 'Nessun evento nelle fonti attive.');
    if (state.calendar.events.length === 0 && sourceProblems().length) agenda = h('div', agenda, h('p.note', 'Alcune fonti non si sono sincronizzate: controlla l’elenco a destra.'));
  }
  fill(page, head, h('div.page-cols', agenda, renderSources()));
}

export function initCalendar() {
  on('calendar', () => { if (state.route === 'calendar') renderPage(); });
  on('route', route => { if (route === 'calendar') renderPage(); });
}
