import { api, state, $, h, icon, fill, emit, on, sheet, openModal, toast, savePrefs, flushPrefs, segmented, toggle, confirmDialog, hostOf } from './core.js';
import { favicon } from './services.js';
import { updateSection } from './updates.js';

const ACCENTS = { blue: '#3d6bff', coral: '#ff6a3d', lime: '#c6ee45', cobalt: '#5d7dff', mint: '#3ccf9f', lilac: '#b497ff', amber: '#ffb21f' };
const LEGACY_BACKGROUNDS = ['aurora', 'sonoma', 'ocean', 'midnight', 'peach'];

export function applyAppearance() {
  const prefs = state.prefs;
  const system = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = prefs.theme === 'system' ? system : (prefs.theme || 'dark');
  document.documentElement.dataset.accent = ACCENTS[prefs.accent] ? prefs.accent : 'blue';
  let background = prefs.background || 'plain';
  if (typeof background === 'string' && background.startsWith('file:')) { prefs.backgroundPhoto = background; background = 'photo'; prefs.background = 'photo'; }
  if (LEGACY_BACKGROUNDS.includes(background)) background = 'glow';
  document.body.dataset.bg = background === 'photo' && !prefs.backgroundPhoto ? 'plain' : background;
  document.body.style.setProperty('--photo', prefs.backgroundPhoto ? `url("${prefs.backgroundPhoto}")` : 'none');
  document.body.classList.toggle('sidebar-collapsed', Boolean(prefs.sidebarCollapsed));
  document.body.dataset.platform = api.platform;
  emit('theme');
}

function appearanceTab() {
  const prefs = state.prefs;
  const accents = h('div.accent-row', Object.entries(ACCENTS).map(([name, color]) => h(`button${(prefs.accent || 'blue') === name ? '.on' : ''}`, { type: 'button', title: name, style: `--c:${color}`, dataset: { accent: name }, on: { click: event => { prefs.accent = name; savePrefs(); applyAppearance(); accents.querySelectorAll('button').forEach(button => button.classList.toggle('on', button === event.currentTarget)); } } })));
  const backgrounds = [['plain', 'Plain'], ['grain', 'Grain'], ['glow', 'Glow'], ['photo', 'Photo']];
  const bgRow = h('div.bg-row', backgrounds.map(([value, label]) => h(`button.${value}${(document.body.dataset.bg === value) ? '.on' : ''}`, { type: 'button', dataset: { bg: value }, on: { click: async () => {
    if (value === 'photo') { const file = await api.chooseBackground(); if (!file) return; prefs.backgroundPhoto = file; }
    prefs.background = value; savePrefs(); applyAppearance();
    bgRow.querySelectorAll('button').forEach(button => button.classList.toggle('on', button.dataset.bg === value));
  } } }, h('i', value === 'photo' && prefs.backgroundPhoto ? { style: `background-image:url("${prefs.backgroundPhoto}")` } : {}), label)));
  return [
    h('div.field', h('span', 'Theme'), segmented([{ value: 'dark', label: 'Dark', icon: 'moon' }, { value: 'light', label: 'Light', icon: 'sun' }, { value: 'system', label: 'System' }], prefs.theme || 'dark', value => { prefs.theme = value; savePrefs(); applyAppearance(); })),
    h('div.field', h('span', 'Accent colour'), accents),
    h('div.field', h('span', 'Background'), bgRow),
    h('label.check', toggle(Boolean(prefs.sidebarCollapsed), value => { prefs.sidebarCollapsed = value; savePrefs(); applyAppearance(); }), 'Compact sidebar')
  ];
}

function generalTab() {
  const prefs = state.prefs;
  const name = h('input', { value: prefs.name || '', placeholder: 'What should we call you?', on: { change: () => { prefs.name = name.value.trim(); savePrefs(); emit('hero'); } } });
  const city = h('input#city-input', { value: prefs.city || '', placeholder: 'e.g. Padua' });
  const saveCity = h('button.btn.sm#save-city', { type: 'button', on: { click: () => { prefs.city = city.value.trim() || 'Roma'; savePrefs(); emit('refresh-weather'); toast(`Weather set to ${prefs.city}`); } } }, 'Save');
  const systemZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const zoneLabel = zone => { try { const offset = new Intl.DateTimeFormat('en-GB', { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(new Date()).find(part => part.type === 'timeZoneName')?.value || ''; return `${zone.replace(/_/g, ' ')} (${offset.replace('GMT', 'UTC')})`; } catch { return zone; } };
  const zone = h('select#timezone', { on: { change: async () => {
    prefs.timeZone = zone.value;
    await flushPrefs();
    emit('hero');
    toast(zone.value ? `Times now shown for ${zone.value.replace(/_/g, ' ')}` : 'Times follow the system time zone');
  } } },
    h('option', { value: '' }, `Automatic${prefs.timeZone ? '' : ` (${systemZone.replace(/_/g, ' ')})`}`),
    zones.map(item => h('option', { value: item }, zoneLabel(item))));
  zone.value = prefs.timeZone || '';
  return [
    h('label.field', h('span', 'Name'), name, h('small', 'Only used for the greeting on the Overview.')),
    h('label.field', h('span', 'Time zone'), zone, h('small', 'The clock, calendar, mail and message times all follow it. Automatic uses the computer’s time zone.')),
    h('div.field', h('span', 'Weather city'), h('div.inline', city, saveCity)),
    h('label.check', toggle(prefs.rememberSignIns !== false, value => { prefs.rememberSignIns = value; savePrefs(); }), 'Stay signed in automatically'),
    h('small.muted', { style: 'display:block;margin:-4px 0 8px 48px' }, 'When you sign in to a service, Nuvia keeps your details encrypted in the system keychain and signs you back in when the session expires (for example a university account). Remove them per service in Edit service.'),
    h('label.check', toggle(prefs.googleSignInCompat !== false, value => { prefs.googleSignInCompat = value; savePrefs(); }), 'Google sign-in compatibility'),
    h('small.muted', { style: 'display:block;margin:-4px 0 8px 48px' }, 'Lets you sign in to Google accounts when Google says the browser may not be secure. Turn it off if a Google account keeps signing you out.'),
    h('label.check', toggle(prefs.systemNotifications !== false, value => { prefs.systemNotifications = value; savePrefs(); }), 'Also show notifications on the desktop'),
    h('label.check', toggle(prefs.autoUpdate !== false, value => { prefs.autoUpdate = value; savePrefs(); }), 'Update automatically'),
    h('small.muted', { style: 'display:block;margin:-4px 0 8px 48px' }, 'When a fix is published, Nuvia downloads it in the background and installs it at the next restart.')
  ];
}

function integrationsTab() {
  const prefs = state.prefs;
  const trains = prefs.trains ||= { station: '', destinations: [], times: [], leadTime: 20, maxDelay: 0, enabled: true };
  const list = value => value.split(',').map(item => item.trim()).filter(Boolean);
  const save = () => { savePrefs(); emit('trains-config'); };
  const station = h('input#train-station', { value: trains.station, placeholder: 'e.g. PADOVA', on: { change: () => { trains.station = station.value.trim().toUpperCase(); save(); } } });
  const destinations = h('input#train-destinations', { value: trains.destinations.join(', '), placeholder: 'e.g. BRESCIA, VERONA PORTA NUOVA', on: { change: () => { trains.destinations = list(destinations.value.toUpperCase()); save(); } } });
  const times = h('input#train-times', { value: trains.times.join(', '), placeholder: 'e.g. 16:40, 17:40', on: { change: () => { trains.times = list(times.value).filter(time => /^\d{1,2}:\d{2}$/.test(time)).map(time => time.padStart(5, '0')); times.value = trains.times.join(', '); save(); } } });
  const number = (key, value) => { const input = h('input', { type: 'number', min: '0', max: '120', value: String(value ?? 0), on: { change: () => { trains[key] = Number(input.value) || 0; save(); } } }); return input; };
  const account = h('div');
  const renderAccount = async () => {
    fill(account, h('p.muted', 'Checking account…'));
    const current = await api.iasState().catch(() => null);
    if (!account.isConnected) return;
    fill(account, current?.configured
      ? h('div.inline', h('span', { style: 'flex:1' }, h('strong', current.account), current.fromEnv ? h('small.muted', ' · from DEI_USER/DEI_PASSWORD variables') : null),
        h('button.btn.sm.ghost', { type: 'button', on: { click: async () => { await api.iasSignOut(); emit('ias-refresh'); renderAccount(); } } }, 'Sign out'))
      : h('div.inline', h('span.muted', { style: 'flex:1' }, 'Not connected'), h('button.btn.sm.accent', { type: 'button', on: { click: () => emit('ias-login') } }, icon('log-in'), 'Sign in')));
  };
  renderAccount();
  return [
    h('h3', { style: 'margin:0 0 8px;font-size:13px' }, 'IAS Lab · DEI Labs'),
    h('p.dim', { style: 'margin-top:0' }, 'Nuvia records check-in and check-out directly on deilabs.dei.unipd.it. Your credentials stay encrypted in the system keychain.'),
    account,
    h('h3', { style: 'margin:22px 0 8px;font-size:13px' }, 'Trains · Ritardometro'),
    h('label.field', h('span', 'Departure station'), station),
    h('label.field', h('span', 'Destinations'), destinations, h('small', 'Comma-separated. Part of the name is enough.')),
    h('label.field', h('span', 'Times to check'), times),
    h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:12px' }, h('label.field', h('span', 'Check ahead (min)'), number('leadTime', trains.leadTime)), h('label.field', h('span', 'Alert above (min late)'), number('maxDelay', trains.maxDelay))),
    h('label.check', toggle(trains.enabled !== false, value => { trains.enabled = value; save(); }), 'Alerts on'),
    h('button.btn.sm', { type: 'button', on: { click: async () => {
      try { const imported = await api.trainImport(); Object.assign(trains, { station: imported.station, destinations: imported.destinations, times: imported.times, leadTime: imported.leadTime, maxDelay: imported.maxDelay }); save(); toast('Settings imported from Ritardometro'); emit('open-settings', 'integrations'); }
      catch (error) { toast(String(error.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
    } } }, icon('refresh-cw'), 'Import from Ritardometro')
  ];
}

function aboutTab() {
  return [
    updateSection(),
    h('p.dim', 'Each service has its own persistent Chromium profile, so cookies and logins stay on this computer. Nuvia never reads or copies your passwords.'),
    h('p.dim', 'Extensions are never loaded into Nuvia’s own interface, only into the services where you turn them on. If an extension crashes a service or the app, it’s turned off there and you get a notice.'),
    h('p.dim', 'Shortcuts: Ctrl+1…9 services · Ctrl+0 overview · Ctrl+K go to… · Ctrl+R reload · Ctrl+, settings.')
  ];
}

export function openSettings(tab = 'appearance') {
  const tabs = { appearance: ['Appearance', appearanceTab], general: ['General', generalTab], integrations: ['Integrations', integrationsTab], about: ['About', aboutTab] };
  const body = h('div');
  const bar = h('div.tabs', Object.entries(tabs).map(([key, [label]]) => h(`button${key === tab ? '.on' : ''}`, { type: 'button', dataset: { tab: key }, on: { click: () => show(key) } }, label)));
  const show = key => { bar.querySelectorAll('button').forEach(button => button.classList.toggle('on', button.dataset.tab === key)); fill(body, tabs[key][1]()); };
  const dialog = sheet({ title: 'Settings', body: [body], foot: [h('button.btn.accent', { type: 'button', on: { click: () => dialog.close() } }, 'Done')] });
  dialog.id = 'settings-dialog';
  dialog.querySelector('.sheet-head').after(bar);
  show(tab);
  openModal(dialog);
}

// ---------------------------------------------------------------------------
// Extensions

export async function loadExtensions() {
  state.extensions = await api.listExtensions().catch(() => []);
  renderExtensionToolbar();
}

export function renderExtensionToolbar() {
  const bar = $('#extension-toolbar');
  if (state.route !== 'service') return fill(bar);
  fill(bar, state.extensions.filter(extension => extension.rules?.[state.serviceId] !== false).map(extension => h('button.ext-pill', {
    title: extension.popup ? `${extension.name} — open` : extension.name,
    on: { click: async () => { if (!extension.popup || !await api.extensionPopup(extension.id)) openExtensions(); } }
  }, extension.icon ? h('img', { src: extension.icon, alt: '' }) : extension.name[0])));
}

function installedList(container) {
  const render = () => fill(container, state.extensions.length ? state.extensions.map(extension => h('div.ext-row',
    h('div.ext-top', extension.icon ? h('img', { src: extension.icon, alt: '' }) : h('span.favicon', extension.name[0]),
      h('div', h('strong', extension.name), h('small', `v${extension.version}${extension.description ? ` · ${extension.description.slice(0, 90)}` : ''}`)),
      h('button.btn.sm.ghost.danger', { type: 'button', on: { click: async () => {
        if (!await confirmDialog(`Remove ${extension.name}?`, 'It will be removed from all services.', { confirm: 'Remove', danger: true })) return;
        await api.removeExtension(extension.id); await loadExtensions(); render();
      } } }, icon('trash-2'), 'Remove')),
    h('div.ext-services', state.services.map(service => {
      const enabled = extension.rules?.[service.id] !== false;
      return h(`button.chip${enabled ? '.on' : ''}`, { type: 'button', title: enabled ? 'On: click to turn off' : 'Off: click to turn on', on: { click: async () => {
        await api.toggleExtension(extension.id, service.id, !enabled); await loadExtensions(); render();
      } } }, favicon(service), service.name);
    })))) : h('p.muted', 'No extensions installed.'));
  render();
  return render;
}

export function openExtensions() {
  const query = h('input#extension-query', { placeholder: 'Search the Chrome Web Store', type: 'search' });
  const status = h('div.muted#marketplace-status');
  const results = h('div.market#marketplace-results');
  const installed = h('div#extension-list');
  const refreshInstalled = installedList(installed);
  const search = async () => {
    const text = query.value.trim(); if (!text) return;
    status.textContent = 'Searching…'; fill(results);
    try {
      const found = await api.searchExtensions(text);
      status.textContent = found.length ? `${found.length} results` : 'No results';
      fill(results, found.map(item => {
        const button = h('button.btn.sm', { type: 'button', disabled: item.installed }, item.installed ? 'Installed' : 'Install');
        button.addEventListener('click', async () => {
          button.disabled = true; button.textContent = 'Installing…';
          try {
            const extension = await api.installExtension(item.id);
            button.textContent = 'Installed';
            toast(`${extension.name} is on for ${extension.enabledOn.length ? extension.enabledOn.join(', ') : 'no services (turn it on below)'}`);
            await loadExtensions(); refreshInstalled();
          } catch (error) { button.disabled = false; button.textContent = 'Try again'; toast(String(error.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
        });
        return h('div.market-item', h('img', { src: item.image, alt: '' }), h('strong', item.name), button);
      }));
    } catch (error) { status.textContent = String(error.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
  };
  query.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); search(); } });
  const dialog = sheet({
    title: 'Extensions', subtitle: 'From the Chrome Web Store. Each extension runs only in the services where you need it.', wide: true,
    body: [h('div.inline', query, h('button.btn.accent#search-extension', { type: 'button', on: { click: search } }, icon('search'), 'Search')), status, results,
      h('h3', { style: 'margin:8px 0 0;font-size:13px' }, 'Installed'), installed,
      h('p.note', 'Electron supports only part of the Chrome extension APIs, so some extensions install but don’t fully work. If one crashes a service, Nuvia turns it off there automatically.')]
  });
  dialog.id = 'extensions-dialog';
  openModal(dialog).then(() => query.focus());
}

export function initSettings() {
  $('#open-settings').addEventListener('click', () => openSettings());
  $('#open-extensions').addEventListener('click', openExtensions);
  $('#collapse-sidebar').addEventListener('click', () => { state.prefs.sidebarCollapsed = !state.prefs.sidebarCollapsed; savePrefs(); applyAppearance(); });
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (state.prefs.theme === 'system') applyAppearance(); });
  on('open-settings', tab => { document.querySelector('#settings-dialog')?.close(); openSettings(tab); });
  on('route', renderExtensionToolbar);
}
