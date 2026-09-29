// Smaller dashboard blocks: trains, IAS lab, weather, services, Notion.
import { api, state, $, h, icon, fill, emit, on, empty, skeleton, savePrefs, toast, clock } from './core.js';
import { defineWidget, renderHero } from './home.js';
import { openService } from './router.js';
import { openAddService, favicon } from './services.js';

// ---------------------------------------------------------------------------
// Trains (Ritardometro / ViaggiaTreno)

const trains = { config: null, result: null, error: '', loading: false };

async function checkTrain(number, ctx) {
  trains.loading = true; trains.error = ''; ctx?.render();
  try {
    trains.result = await api.trainStatus(number);
    await api.addNotification({ title: `Treno ${trains.result.number}`, body: trains.result.delay > 0 ? `${trains.result.delay} min di ritardo verso ${trains.result.destination}` : `In orario verso ${trains.result.destination}`, type: 'train' });
  } catch {
    trains.result = null; trains.error = 'Treno non trovato oggi. Controlla il numero.';
  }
  trains.loading = false; ctx?.render();
}

export async function watchFavoriteTrains() {
  for (const number of state.prefs.favoriteTrains || []) {
    try {
      const train = await api.trainStatus(number);
      const key = `${new Date().toDateString()}:${train.delay}`;
      const threshold = trains.config?.maxDelay || 0;
      if (train.delay > threshold && state.prefs.lastTrainNotification?.[number] !== key) {
        state.prefs.lastTrainNotification = { ...(state.prefs.lastTrainNotification || {}), [number]: key }; savePrefs();
        await api.addNotification({ title: `Treno ${number}`, body: `${train.delay} min di ritardo verso ${train.destination}`, type: 'train' });
      }
    } catch {}
  }
}

defineWidget({
  id: 'train', title: 'Treni', icon: 'train-front', size: 's',
  async mount(ctx) { trains.config = await api.ritardometroConfig(); ctx.render(); },
  render(ctx) {
    const favorites = state.prefs.favoriteTrains || [];
    const input = h('input', { inputmode: 'numeric', placeholder: 'Numero treno', value: trains.result?.number?.replace(/\D/g, '') || '' });
    const star = h('button.icon-btn', { type: 'button', title: 'Salva tra i preferiti', on: { click: () => {
      const number = input.value.replace(/\D/g, ''); if (!number) return toast('Scrivi prima il numero del treno');
      state.prefs.favoriteTrains = [...new Set([...favorites, number])]; savePrefs(); ctx.render(); toast(`Treno ${number} tra i preferiti: ti avviso se è in ritardo`);
    } } }, icon('heart'));
    const form = h('form.inline', { id: 'train-form', on: { submit: event => { event.preventDefault(); if (input.value.trim()) checkTrain(input.value, ctx); } } }, input, star, h('button.btn.sm', { type: 'submit' }, 'Controlla'));
    const chips = favorites.length ? h('div.account-strip', { style: 'margin:10px 0 0' }, favorites.map(number => h('button.chip', { title: 'Tasto destro per rimuovere', on: { click: () => checkTrain(number, ctx), contextmenu: event => { event.preventDefault(); state.prefs.favoriteTrains = favorites.filter(item => item !== number); savePrefs(); ctx.render(); } } }, icon('train-front'), number))) : null;
    let result;
    if (trains.loading) result = skeleton(2);
    else if (trains.error) result = h('p.dim', trains.error);
    else if (trains.result) {
      const train = trains.result;
      const current = train.stops.findLastIndex(stop => stop.passed);
      const window = train.stops.slice(Math.max(0, current - 1), current + 3);
      result = h('div', { style: 'margin-top:14px' },
        h('div', { style: 'display:flex;align-items:baseline;gap:10px' }, h('div.big-stat', train.delay > 0 ? `+${train.delay}` : '0', h('small', 'min')), h(`span.state.${train.delay > 10 ? 'bad' : train.delay > 0 ? 'warn' : 'ok'}`, train.delay > 0 ? 'in ritardo' : 'in orario')),
        h('div.status-line', `${train.number} → ${train.destination}`),
        window.length ? h('div.stops', window.map(stop => h(`div.stop${stop.passed ? '.passed' : ''}${train.stops.indexOf(stop) === current ? '.current' : ''}`, h('i'), h('span', stop.station), h('time', stop.actual ? clock(stop.actual) : stop.planned ? clock(stop.planned) : '')))) : null);
    } else {
      const config = trains.config;
      result = h('p.muted', { style: 'margin-top:12px;font-size:12.5px' }, config?.ok ? `${config.station} → ${config.destinations.join(', ')} · avviso oltre ${config.maxDelay} min` : 'Stato in tempo reale da ViaggiaTreno.');
    }
    ctx.setMeta(favorites.length ? `${favorites.length} preferit${favorites.length === 1 ? 'o' : 'i'}` : 'ViaggiaTreno');
    fill(ctx.body, form, chips, result);
  }
});

// ---------------------------------------------------------------------------
// IAS lab (DEI)

const ias = { status: null, labs: null, message: '', busy: false };
defineWidget({
  id: 'ias', title: 'Laboratorio IAS', icon: 'flask-conical', size: 's', height: 'compact',
  async mount(ctx) {
    ias.status = await api.iasStatus(); ctx.render();
    if (!ias.status.configured) return;
    const result = await api.iasLabs().catch(error => ({ labs: [], message: error.message }));
    ias.labs = result.labs || []; ias.message = result.message || ''; ias.inside = result.alreadyInside; ctx.render();
  },
  render(ctx) {
    if (!ias.status) return fill(ctx.body, skeleton(2));
    if (!ias.status.project) { ctx.setMeta(''); return fill(ctx.body, empty('flask-conical', 'IAS Lab non configurato', 'Indica la cartella del progetto log_ias_lab.', h('button.btn.sm', { on: { click: () => emit('open-settings', 'integrations') } }, icon('settings'), 'Configura'))); }
    if (!ias.status.configured) { ctx.setMeta(''); return fill(ctx.body, empty('flask-conical', 'Credenziali DEI mancanti', 'Imposta DEI_USER e DEI_PASSWORD nell’ambiente e riavvia Nuvia.')); }
    if (!ias.labs) { ctx.setMeta('accesso a deilabs…'); return fill(ctx.body, skeleton(2)); }
    ctx.setMeta(ias.inside ? 'sei dentro' : `${ias.labs.length} laboratori`);
    const select = h('select#ias-lab', ias.labs.map(lab => h('option', { value: lab, selected: lab === state.prefs.iasLab }, lab)));
    select.addEventListener('change', () => { state.prefs.iasLab = select.value; savePrefs(); });
    const button = h('button.btn.accent', { disabled: ias.busy || ias.inside || !ias.labs.length, on: { click: async () => {
      ias.busy = true; ctx.render();
      const result = await api.iasLogin(select.value);
      ias.busy = false; ias.message = result.message; if (result.ok) ias.inside = true; ctx.render();
      api.addNotification({ title: 'Laboratorio IAS', body: result.message, type: result.ok ? 'success' : 'error' });
    } } }, ias.busy ? 'Registrazione…' : ias.inside ? 'Già registrato' : 'Entra in laboratorio');
    fill(ctx.body, h('div', { style: 'display:grid;gap:10px' }, ias.inside ? null : select, button, ias.message ? h('small.muted', ias.message) : null));
  }
});

// ---------------------------------------------------------------------------
// Weather (hero card + widget)

const WMO = code => code >= 95 ? ['cloud-lightning', 'Temporale'] : code >= 71 && code <= 86 ? ['cloud-snow', 'Neve'] : code >= 61 ? ['cloud-rain', 'Pioggia'] : code >= 51 ? ['cloud-drizzle', 'Pioviggine'] : code >= 45 ? ['cloud-fog', 'Nebbia'] : code >= 3 ? ['cloud', 'Coperto'] : code >= 1 ? ['cloud-sun', 'Poco nuvoloso'] : ['sun', 'Sereno'];

export async function refreshWeather() {
  const city = state.prefs.city || 'Roma';
  try {
    const geo = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=it&format=json`)).json();
    const place = geo.results?.[0]; if (!place) throw new Error('Città non trovata');
    const data = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,weather_code,is_day,apparent_temperature,wind_speed_10m&hourly=temperature_2m,weather_code,precipitation_probability&daily=temperature_2m_max,temperature_2m_min&forecast_hours=12&timezone=auto`)).json();
    state.weather = { city: place.name, ...data };
  } catch (error) { state.weather = { error: error.message, city }; }
  emit('weather');
}

function renderWeatherCard() {
  const card = $('#weather-card'); if (!card) return;
  const weather = state.weather;
  if (!weather) return fill(card, h('span.wx-icon', icon('cloud')), h('div.wx-meta', h('b', 'Meteo'), h('span', 'Caricamento…')));
  if (weather.error) return fill(card, h('span.wx-icon', icon('cloud')), h('div.wx-meta', h('b', weather.city), h('span', 'Meteo non disponibile')));
  const [name, label] = WMO(weather.current.weather_code);
  fill(card, h('span.wx-icon', icon(!weather.current.is_day && name === 'sun' ? 'moon' : name)), h('span.temp', `${Math.round(weather.current.temperature_2m)}°`),
    h('div.wx-meta', h('b', weather.city), h('span', label), h('span.mono', `${Math.round(weather.daily.temperature_2m_min[0])}° / ${Math.round(weather.daily.temperature_2m_max[0])}°`)));
}

defineWidget({
  id: 'weather', title: 'Meteo', icon: 'cloud-sun', size: 's', topics: ['weather'],
  render(ctx) {
    const weather = state.weather;
    if (!weather) return fill(ctx.body, skeleton(3));
    if (weather.error) return fill(ctx.body, empty('cloud', 'Meteo non disponibile', weather.error));
    const [name, label] = WMO(weather.current.weather_code);
    ctx.setMeta(`${weather.city} · percepiti ${Math.round(weather.current.apparent_temperature)}°`);
    const hours = weather.hourly.time.map((time, index) => ({ time, temp: weather.hourly.temperature_2m[index], code: weather.hourly.weather_code[index], rain: weather.hourly.precipitation_probability?.[index] })).slice(0, 8);
    fill(ctx.body,
      h('div', { style: 'display:flex;align-items:center;gap:14px;margin-bottom:14px' }, h('span.w-icon', { style: 'width:46px;height:46px;border-radius:13px;color:var(--accent);background:var(--accent-soft)' }, icon(name)), h('div', h('div.big-stat', `${Math.round(weather.current.temperature_2m)}°`), h('span.dim', label))),
      h('div', { style: 'display:grid;grid-template-columns:repeat(4,1fr);gap:6px' }, hours.map(hour => h('div.stat', { style: 'padding:8px;text-align:center' }, h('small', hour.time.slice(11, 16)), icon(WMO(hour.code)[0]), h('div.mono', { style: 'font-size:12px;margin-top:2px' }, `${Math.round(hour.temp)}°${hour.rain ? ` · ${hour.rain}%` : ''}`)))));
  }
});

// ---------------------------------------------------------------------------
// Services and Notion

defineWidget({
  id: 'services', title: 'Servizi', icon: 'layout-grid', size: 'm', height: 'compact', topics: ['services', 'live'],
  actions: () => [h('button.icon-btn.small', { title: 'Aggiungi servizio', on: { click: () => openAddService() } }, icon('plus'))],
  render(ctx) {
    const signature = JSON.stringify(state.services.map(service => [service.id, service.name, state.live.get(service.id)?.favicon, state.live.get(service.id)?.unread]));
    if (ctx.body.dataset.signature === signature && ctx.body.childElementCount) return;
    ctx.body.dataset.signature = signature;
    ctx.setMeta(`${state.services.length} collegati`);
    if (!state.services.length) return fill(ctx.body, empty('layout-grid', 'Ancora nessun servizio', 'Accedi una volta: la sessione resta salvata.', h('button.btn.sm', { on: { click: () => openAddService() } }, icon('plus'), 'Aggiungi')));
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
    if (!notion) return fill(ctx.body, empty('notebook', 'Notion non collegato', 'Tienilo a un clic, con la sessione sempre attiva.', h('button.btn.sm', { on: { click: () => openAddService({ name: 'Notion', url: 'https://www.notion.so/' }) } }, icon('plus'), 'Collega')));
    ctx.setMeta('workspace connesso');
    const quick = (state.prefs.notionLinks || []);
    const input = h('input', { placeholder: 'Incolla un link Notion da tenere qui' });
    fill(ctx.body,
      h('button.svc-tile', { style: 'width:100%;margin-bottom:10px', on: { click: () => openService(notion.id) } }, favicon(notion), h('span', 'Apri il workspace'), icon('arrow-right')),
      h('div.rows', quick.map(link => h('button.row', { on: { click: () => openService(notion.id, { url: link.url }), contextmenu: event => { event.preventDefault(); state.prefs.notionLinks = quick.filter(item => item.url !== link.url); savePrefs(); ctx.render(); } } }, h('span.w-icon', icon('link')), h('div.main', h('div.line1', h('strong', link.name))), h('span')))),
      h('form.inline', { style: 'margin-top:8px', on: { submit: event => {
        event.preventDefault();
        const url = input.value.trim();
        if (!/^https:\/\/(www\.)?notion\.(so|site)\//.test(url)) return toast('Serve un link notion.so');
        const name = decodeURIComponent(url.split('/').pop().split('?')[0]).replace(/-[0-9a-f]{32}$/, '').replace(/-/g, ' ') || 'Pagina';
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
