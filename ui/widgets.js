// Smaller dashboard widgets: trains, IAS lab, weather, services, Notion.
import { api, state, $, h, icon, fill, emit, on, empty, skeleton, savePrefs, toast, clock, sheet, openModal } from './core.js';
import { defineWidget, renderHero } from './home.js';
import { openService } from './router.js';
import { openAddService, favicon } from './services.js';

const cleanError = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// ---------------------------------------------------------------------------
// Trains: the Ritardometro built in (departures board + scheduled alerts)

const trains = { board: null, boardError: '', result: null, error: '', loading: false, at: 0 };

// First run: import the Ritardometro configuration (station, destinations, times).
export async function ensureTrainConfig() {
  if (state.prefs.trains?.station) return state.prefs.trains;
  try {
    const imported = await api.trainImport();
    state.prefs.trains = { station: imported.station, destinations: imported.destinations, times: imported.times, leadTime: imported.leadTime, maxDelay: imported.maxDelay, enabled: true };
    savePrefs();
  } catch { state.prefs.trains = { station: '', destinations: [], times: [], leadTime: 20, maxDelay: 0, enabled: true }; }
  return state.prefs.trains;
}

export async function refreshBoard() {
  const config = await ensureTrainConfig();
  if (!config.station) { trains.board = []; emit('trains'); return; }
  try { trains.board = await api.trainBoard({ station: config.station, destinations: config.destinations }); trains.boardError = ''; }
  catch (error) { trains.boardError = cleanError(error); trains.board = trains.board || []; }
  trains.at = Date.now();
  emit('trains');
}

async function checkTrain(number, ctx) {
  trains.loading = true; trains.error = ''; ctx?.render();
  try { trains.result = await api.trainStatus(number); } catch { trains.result = null; trains.error = 'Train not found today. Check the number.'; }
  trains.loading = false; ctx?.render();
}

export async function watchFavoriteTrains() {
  for (const number of state.prefs.favoriteTrains || []) {
    try {
      const train = await api.trainStatus(number);
      const key = `${new Date().toDateString()}:${train.delay}`;
      if (train.delay > (state.prefs.trains?.maxDelay ?? 0) && state.prefs.lastTrainNotification?.[number] !== key) {
        state.prefs.lastTrainNotification = { ...(state.prefs.lastTrainNotification || {}), [number]: key }; savePrefs();
        await api.addNotification({ title: `Train ${number}`, body: `${train.delay} min late to ${train.destination}`, type: 'train' });
      }
    } catch {}
  }
}

function delayState(train) {
  if (train.cancelled) return h('span.state.bad', 'cancelled');
  if (train.delay > 10) return h('span.state.bad', `+${train.delay}`);
  if (train.delay > 0) return h('span.state.warn', `+${train.delay}`);
  return h('span.state.ok', 'on time');
}

function numberCheck(ctx) {
  const favorites = state.prefs.favoriteTrains || [];
  const input = h('input', { inputmode: 'numeric', placeholder: 'Train number', value: trains.result?.number?.replace(/\D/g, '') || '' });
  const star = h('button.icon-btn', { type: 'button', title: 'Save to favourites', on: { click: () => {
    const number = input.value.replace(/\D/g, ''); if (!number) return toast('Enter a train number first');
    state.prefs.favoriteTrains = [...new Set([...favorites, number])]; savePrefs(); ctx.render(); toast(`Train ${number} saved to favourites. You’ll get an alert if it’s late.`);
  } } }, icon('heart'));
  const form = h('form.inline', { id: 'train-form', on: { submit: event => { event.preventDefault(); if (input.value.trim()) checkTrain(input.value, ctx); } } }, input, star, h('button.btn.sm', { type: 'submit' }, 'Check'));
  const chips = favorites.length ? h('div.account-strip', { style: 'margin:10px 0 0' }, favorites.map(number => h('button.chip', { title: 'Right-click to remove', on: { click: () => checkTrain(number, ctx), contextmenu: event => { event.preventDefault(); state.prefs.favoriteTrains = favorites.filter(item => item !== number); savePrefs(); ctx.render(); } } }, icon('train-front'), number))) : null;
  let result = null;
  if (trains.loading) result = skeleton(1);
  else if (trains.error) result = h('p.dim', trains.error);
  else if (trains.result) {
    const train = trains.result;
    const current = train.stops.findLastIndex(stop => stop.passed);
    const window = train.stops.slice(Math.max(0, current - 1), current + 3);
    result = h('div', { style: 'margin-top:12px' },
      h('div', { style: 'display:flex;align-items:baseline;gap:10px' }, h('div.big-stat', train.delay > 0 ? `+${train.delay}` : '0', h('small', 'min')), h(`span.state.${train.delay > 10 ? 'bad' : train.delay > 0 ? 'warn' : 'ok'}`, train.delay > 0 ? 'delayed' : 'on time')),
      h('div.status-line', `${train.number} → ${train.destination}`),
      window.length ? h('div.stops', window.map(stop => h(`div.stop${stop.passed ? '.passed' : ''}${train.stops.indexOf(stop) === current ? '.current' : ''}`, h('i'), h('span', stop.station), h('time', stop.actual ? clock(stop.actual) : stop.planned ? clock(stop.planned) : '')))) : null);
  }
  return [form, chips, result];
}

defineWidget({
  id: 'train', title: 'Trains', icon: 'train-front', size: 's', topics: ['trains'],
  actions: () => [h('button.icon-btn.small', { title: 'Refresh', on: { click: refreshBoard } }, icon('refresh-cw')), h('button.icon-btn.small', { title: 'Station and alerts', on: { click: () => emit('open-settings', 'integrations') } }, icon('settings'))],
  mount() { if (!trains.board) refreshBoard(); },
  render(ctx) {
    const config = state.prefs.trains;
    const watched = new Set(config?.times || []);
    ctx.setMeta(config?.station ? `${config.station}${config.destinations?.length ? ` → ${config.destinations.join(', ')}` : ''}` : 'ViaggiaTreno');
    let board;
    if (!trains.board) board = skeleton(3);
    else if (!config?.station) board = empty('train-front', 'No station', 'Choose a station and destinations for the board and alerts.', h('button.btn.sm', { on: { click: () => emit('open-settings', 'integrations') } }, icon('settings'), 'Set up'));
    else if (trains.boardError) board = h('p.dim', trains.boardError);
    else if (!trains.board.length) board = h('p.muted', { style: 'font-size:12.5px' }, 'No departures to your destinations in the next few hours.');
    else board = h('div.rows.train-board', trains.board.slice(0, 8).map(train => h(`div.row${watched.has(train.time) ? '.watched' : ''}`,
      h('time.mono', train.time), h('div.main', h('div.line1', h('strong', train.destination)), h('div.line3', `${train.number}${train.platform ? ` · plat. ${train.platform}` : ''}`)), h('div.side', delayState(train)))));
    fill(ctx.body, board,
      config?.times?.length && config.enabled !== false ? h('p.note', { style: 'margin:10px 0 12px' }, `Alerts at ${config.times.join(', ')} (${config.leadTime} min before) if the delay exceeds ${config.maxDelay} min.`) : null,
      numberCheck(ctx));
  }
});

// ---------------------------------------------------------------------------
// DEI Labs (IAS): login once, then enter/exit a lab with one click

const ias = { state: null, busy: false, message: '' };

export async function refreshIas() {
  try { ias.state = await api.iasState(); } catch (error) { ias.state = { error: cleanError(error), labs: [] }; }
  emit('ias');
}

export function openIasLogin() {
  const email = h('input', { type: 'email', placeholder: 'name.surname@unipd.it', autocomplete: 'username', value: ias.state?.account || '' });
  const password = h('input', { type: 'password', placeholder: 'DEI password', autocomplete: 'current-password' });
  const status = h('p.dim', { style: 'min-height:20px;margin:0' });
  const submit = h('button.btn.accent', { type: 'submit' }, 'Sign in and save');
  const dialog = sheet({
    title: 'Sign in to DEI Labs', subtitle: 'Just once. Nuvia keeps the session and stores your password encrypted in the system keychain.',
    body: [h('label.field', h('span', 'Email'), email), h('label.field', h('span', 'Password'), password), status],
    foot: [h('button.btn.ghost', { type: 'button', on: { click: () => dialog.close() } }, 'Cancel'), submit]
  });
  dialog.id = 'ias-login-dialog';
  const form = h('form.sheet-inner', { on: { submit: async event => {
    event.preventDefault();
    submit.disabled = true; status.textContent = 'Signing in to deilabs.dei.unipd.it…';
    const result = await api.iasSignIn({ email: email.value.trim(), password: password.value }).catch(error => ({ ok: false, message: cleanError(error) }));
    submit.disabled = false; status.textContent = result.message || '';
    if (result.ok) { ias.state = result; emit('ias'); toast(result.message); dialog.close(); }
  } } });
  form.append(...dialog.firstChild.childNodes);
  dialog.replaceChildren(form);
  openModal(dialog).then(() => (email.value ? password : email).focus());
}

async function iasAction(action) {
  ias.busy = true; emit('ias');
  const lab = $('#ias-lab')?.value || state.prefs.iasLab;
  const result = action === 'enter' ? await api.iasEnter(lab) : await api.iasExit();
  ias.busy = false; ias.state = result; ias.message = result.message;
  emit('ias');
  api.addNotification({ title: 'IAS Lab', body: result.message, type: result.ok ? 'success' : 'error' });
}

defineWidget({
  id: 'ias', title: 'IAS Lab', icon: 'flask-conical', size: 's', height: 'compact', topics: ['ias'],
  mount() { if (!ias.state) refreshIas(); },
  render(ctx) {
    const current = ias.state;
    if (!current) { ctx.setMeta('connecting to DEI Labs…'); return fill(ctx.body, skeleton(2)); }
    if (current.error) { ctx.setMeta(''); return fill(ctx.body, empty('triangle-alert', 'Can’t reach DEI Labs', current.error, h('button.btn.sm', { on: { click: refreshIas } }, icon('refresh-cw'), 'Try again'))); }
    if (!current.configured) {
      ctx.setMeta('');
      return fill(ctx.body, empty('flask-conical', 'Sign in to DEI Labs', 'Enter your credentials once, then check in and out with one click.', h('button.btn.sm.accent', { on: { click: openIasLogin } }, icon('log-in'), 'Sign in')));
    }
    ctx.setMeta(current.inside ? 'you’re in the lab' : current.account);
    if (current.inside) {
      return fill(ctx.body, h('div', { style: 'display:grid;gap:10px' },
        h('div.status-line', h('span.state.ok', 'inside'), current.currentLab),
        h('button.btn', { disabled: ias.busy, on: { click: () => iasAction('exit') } }, icon('log-in'), ias.busy ? 'Registering…' : 'Leave lab'),
        ias.message ? h('small.muted', ias.message) : null));
    }
    const select = h('select#ias-lab', current.labs.map(lab => h('option', { value: lab, selected: lab === state.prefs.iasLab }, lab)));
    select.addEventListener('change', () => { state.prefs.iasLab = select.value; savePrefs(); });
    fill(ctx.body, h('div', { style: 'display:grid;gap:10px' }, select,
      h('button.btn.accent', { disabled: ias.busy || !current.labs.length, on: { click: () => iasAction('enter') } }, ias.busy ? 'Registering…' : 'Enter lab'),
      ias.message ? h('small.muted', ias.message) : null));
  }
});

// ---------------------------------------------------------------------------
// Weather (hero card + widget)

const WMO = code => code >= 95 ? ['cloud-lightning', 'Thunderstorm'] : code >= 71 && code <= 86 ? ['cloud-snow', 'Snow'] : code >= 61 ? ['cloud-rain', 'Rain'] : code >= 51 ? ['cloud-drizzle', 'Drizzle'] : code >= 45 ? ['cloud-fog', 'Fog'] : code >= 3 ? ['cloud', 'Overcast'] : code >= 1 ? ['cloud-sun', 'Partly cloudy'] : ['sun', 'Clear'];

export async function refreshWeather() {
  const city = state.prefs.city || 'Roma';
  try {
    const geo = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`)).json();
    const place = geo.results?.[0]; if (!place) throw new Error('City not found');
    const data = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,weather_code,is_day,apparent_temperature,wind_speed_10m&hourly=temperature_2m,weather_code,precipitation_probability&daily=temperature_2m_max,temperature_2m_min&forecast_hours=12&timezone=auto`)).json();
    state.weather = { city: place.name, ...data };
  } catch (error) { state.weather = { error: error.message, city }; }
  emit('weather');
}

function renderWeatherCard() {
  const card = $('#weather-card'); if (!card) return;
  const weather = state.weather;
  if (!weather) return fill(card, h('span.wx-icon', icon('cloud')), h('div.wx-meta', h('b', 'Weather'), h('span', 'Loading…')));
  if (weather.error) return fill(card, h('span.wx-icon', icon('cloud')), h('div.wx-meta', h('b', weather.city), h('span', 'Weather unavailable')));
  const [name, label] = WMO(weather.current.weather_code);
  fill(card, h('span.wx-icon', icon(!weather.current.is_day && name === 'sun' ? 'moon' : name)), h('span.temp', `${Math.round(weather.current.temperature_2m)}°`),
    h('div.wx-meta', h('b', weather.city), h('span', label), h('span.mono', `${Math.round(weather.daily.temperature_2m_min[0])}° / ${Math.round(weather.daily.temperature_2m_max[0])}°`)));
}

defineWidget({
  id: 'weather', title: 'Weather', icon: 'cloud-sun', size: 's', topics: ['weather'],
  render(ctx) {
    const weather = state.weather;
    if (!weather) return fill(ctx.body, skeleton(3));
    if (weather.error) return fill(ctx.body, empty('cloud', 'Weather unavailable', weather.error));
    const [name, label] = WMO(weather.current.weather_code);
    ctx.setMeta(`${weather.city} · feels like ${Math.round(weather.current.apparent_temperature)}°`);
    const hours = weather.hourly.time.map((time, index) => ({ time, temp: weather.hourly.temperature_2m[index], code: weather.hourly.weather_code[index], rain: weather.hourly.precipitation_probability?.[index] })).slice(0, 8);
    fill(ctx.body,
      h('div', { style: 'display:flex;align-items:center;gap:14px;margin-bottom:14px' }, h('span.w-icon', { style: 'width:46px;height:46px;border-radius:13px;color:var(--accent);background:var(--accent-soft)' }, icon(name)), h('div', h('div.big-stat', `${Math.round(weather.current.temperature_2m)}°`), h('span.dim', label))),
      h('div', { style: 'display:grid;grid-template-columns:repeat(4,1fr);gap:6px' }, hours.map(hour => h('div.stat', { style: 'padding:8px;text-align:center' }, h('small', hour.time.slice(11, 16)), icon(WMO(hour.code)[0]), h('div.mono', { style: 'font-size:12px;margin-top:2px' }, `${Math.round(hour.temp)}°${hour.rain ? ` · ${hour.rain}%` : ''}`)))));
  }
});

// ---------------------------------------------------------------------------
// Services and Notion

defineWidget({
  id: 'services', title: 'Services', icon: 'layout-grid', size: 'm', height: 'compact', topics: ['services', 'live'],
  actions: () => [h('button.icon-btn.small', { title: 'Add service', on: { click: () => openAddService() } }, icon('plus'))],
  render(ctx) {
    const signature = JSON.stringify(state.services.map(service => [service.id, service.name, state.live.get(service.id)?.favicon, state.live.get(service.id)?.unread]));
    if (ctx.body.dataset.signature === signature && ctx.body.childElementCount) return;
    ctx.body.dataset.signature = signature;
    ctx.setMeta(`${state.services.length} connected`);
    if (!state.services.length) return fill(ctx.body, empty('layout-grid', 'No services yet', 'Sign in once and the session stays saved.', h('button.btn.sm', { on: { click: () => openAddService() } }, icon('plus'), 'Add')));
    fill(ctx.body, h('div.tiles', state.services.map(service => {
      const live = state.live.get(service.id) || {};
      return h('button.svc-tile', { on: { click: () => openService(service.id), contextmenu: event => { event.preventDefault(); api.serviceMenu(service.id); } } }, favicon(service), h('span', service.name), live.unread ? h('span.pill-count', String(live.unread)) : null);
    })));
  }
});

defineWidget({
  id: 'notion', title: 'Notion', icon: 'notebook', size: 's', height: 'compact', topics: ['services'],
  render(ctx) {
    const notion = state.services.find(service => service.kind === 'notion');
    if (!notion) return fill(ctx.body, empty('notebook', 'Notion isn’t connected', 'Keep it one click away, always signed in.', h('button.btn.sm', { on: { click: () => openAddService({ name: 'Notion', url: 'https://www.notion.so/' }) } }, icon('plus'), 'Connect')));
    ctx.setMeta('workspace connected');
    const quick = (state.prefs.notionLinks || []);
    const input = h('input', { placeholder: 'Paste a Notion link to keep here' });
    fill(ctx.body,
      h('button.svc-tile', { style: 'width:100%;margin-bottom:10px', on: { click: () => openService(notion.id) } }, favicon(notion), h('span', 'Open workspace'), icon('arrow-right')),
      h('div.rows', quick.map(link => h('button.row', { on: { click: () => openService(notion.id, { url: link.url }), contextmenu: event => { event.preventDefault(); state.prefs.notionLinks = quick.filter(item => item.url !== link.url); savePrefs(); ctx.render(); } } }, h('span.w-icon', icon('link')), h('div.main', h('div.line1', h('strong', link.name))), h('span')))),
      h('form.inline', { style: 'margin-top:8px', on: { submit: event => {
        event.preventDefault();
        const url = input.value.trim();
        if (!/^https:\/\/(www\.)?notion\.(so|site)\//.test(url)) return toast('That needs to be a notion.so link');
        const name = decodeURIComponent(url.split('/').pop().split('?')[0]).replace(/-[0-9a-f]{32}$/, '').replace(/-/g, ' ') || 'Page';
        state.prefs.notionLinks = [...quick, { url, name }]; savePrefs(); ctx.render();
      } } }, input, h('button.btn.sm', { type: 'submit' }, icon('plus'))));
  }
});

export function initWidgets() {
  on('weather', renderWeatherCard);
  on('hero', renderWeatherCard);
  renderHero();
  renderWeatherCard();
}
