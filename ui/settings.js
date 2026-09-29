import { api, state, $, h, icon, fill, emit, on, sheet, openModal, toast, savePrefs, segmented, toggle, confirmDialog, hostOf } from './core.js';
import { favicon } from './services.js';

const ACCENTS = { coral: '#ff6a3d', lime: '#c6ee45', cobalt: '#5d7dff', mint: '#3ccf9f', lilac: '#b497ff', amber: '#ffb21f' };
const LEGACY_BACKGROUNDS = ['aurora', 'sonoma', 'ocean', 'midnight', 'peach'];

export function applyAppearance() {
  const prefs = state.prefs;
  const system = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = prefs.theme === 'system' ? system : (prefs.theme || 'dark');
  document.documentElement.dataset.accent = ACCENTS[prefs.accent] ? prefs.accent : 'coral';
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
  const accents = h('div.accent-row', Object.entries(ACCENTS).map(([name, color]) => h(`button${(prefs.accent || 'coral') === name ? '.on' : ''}`, { type: 'button', title: name, style: `--c:${color}`, dataset: { accent: name }, on: { click: event => { prefs.accent = name; savePrefs(); applyAppearance(); accents.querySelectorAll('button').forEach(button => button.classList.toggle('on', button === event.currentTarget)); } } })));
  const backgrounds = [['plain', 'Tinta unita'], ['grain', 'Grana'], ['glow', 'Alone'], ['photo', 'Foto']];
  const bgRow = h('div.bg-row', backgrounds.map(([value, label]) => h(`button.${value}${(document.body.dataset.bg === value) ? '.on' : ''}`, { type: 'button', dataset: { bg: value }, on: { click: async () => {
    if (value === 'photo') { const file = await api.chooseBackground(); if (!file) return; prefs.backgroundPhoto = file; }
    prefs.background = value; savePrefs(); applyAppearance();
    bgRow.querySelectorAll('button').forEach(button => button.classList.toggle('on', button.dataset.bg === value));
  } } }, h('i', value === 'photo' && prefs.backgroundPhoto ? { style: `background-image:url("${prefs.backgroundPhoto}")` } : {}), label)));
  return [
    h('div.field', h('span', 'Tema'), segmented([{ value: 'dark', label: 'Scuro', icon: 'moon' }, { value: 'light', label: 'Chiaro', icon: 'sun' }, { value: 'system', label: 'Sistema' }], prefs.theme || 'dark', value => { prefs.theme = value; savePrefs(); applyAppearance(); })),
    h('div.field', h('span', 'Colore d’accento'), accents),
    h('div.field', h('span', 'Sfondo'), bgRow),
    h('label.check', toggle(Boolean(prefs.sidebarCollapsed), value => { prefs.sidebarCollapsed = value; savePrefs(); applyAppearance(); }), 'Barra laterale compatta')
  ];
}

function generalTab() {
  const prefs = state.prefs;
  const name = h('input', { value: prefs.name || '', placeholder: 'Come ti chiamo?', on: { change: () => { prefs.name = name.value.trim(); savePrefs(); emit('hero'); } } });
  const city = h('input#city-input', { value: prefs.city || '', placeholder: 'Es. Padova' });
  const saveCity = h('button.btn.sm#save-city', { type: 'button', on: { click: () => { prefs.city = city.value.trim() || 'Roma'; savePrefs(); emit('refresh-weather'); toast(`Meteo su ${prefs.city}`); } } }, 'Salva');
  return [
    h('label.field', h('span', 'Nome'), name, h('small', 'Usato solo per il saluto nella panoramica.')),
    h('div.field', h('span', 'Città del meteo'), h('div.inline', city, saveCity)),
    h('label.check', toggle(prefs.systemNotifications !== false, value => { prefs.systemNotifications = value; savePrefs(); }), 'Mostra le notifiche anche sul desktop')
  ];
}

function integrationsTab() {
  const prefs = state.prefs;
  prefs.integrations ||= {};
  const folder = (key, label, hint) => {
    const input = h('input', { value: prefs.integrations[key] || '', placeholder: 'Nessuna cartella', spellcheck: false, on: { change: () => { prefs.integrations[key] = input.value.trim(); savePrefs(); } } });
    const browse = h('button.btn.sm', { type: 'button', on: { click: async () => { const dir = await api.chooseFolder(label); if (dir) { input.value = dir; prefs.integrations[key] = dir; savePrefs(); } } } }, 'Sfoglia…');
    return h('div.field', h('span', label), h('div.inline', input, browse), h('small', hint));
  };
  const python = h('input', { value: prefs.integrations.python || '', placeholder: api.platform === 'win32' ? 'python' : 'python3', on: { change: () => { prefs.integrations.python = python.value.trim(); savePrefs(); } } });
  return [
    h('p.dim', 'Integrazioni facoltative che usano programmi sul tuo computer. Le modifiche valgono dal prossimo aggiornamento del blocco.'),
    folder('iasProject', 'Progetto IAS Lab (log_ias_lab)', 'Credenziali DEI dalle variabili d’ambiente DEI_USER e DEI_PASSWORD.'),
    folder('ritardometroProject', 'Progetto Ritardometro', 'Cartella con config.yaml (stazione, destinazioni, ritardo massimo).'),
    h('label.field', h('span', 'Comando Python'), python, h('small', 'Usato dal bridge IAS.'))
  ];
}

function aboutTab() {
  return [
    h('p.dim', 'Ogni servizio ha un profilo Chromium separato e persistente: cookie e login restano su questo computer. Nuvia non legge né copia le password.'),
    h('p.dim', 'Le estensioni non vengono mai caricate nell’interfaccia di Nuvia, solo nei servizi dove le attivi. Se una estensione fa chiudere un servizio o l’app, viene disattivata lì e ricevi un avviso.'),
    h('p.dim', 'Scorciatoie: Ctrl+1…9 servizi · Ctrl+0 panoramica · Ctrl+K vai a… · Ctrl+R ricarica · Ctrl+, impostazioni.')
  ];
}

export function openSettings(tab = 'appearance') {
  const tabs = { appearance: ['Aspetto', appearanceTab], general: ['Generale', generalTab], integrations: ['Integrazioni', integrationsTab], about: ['Informazioni', aboutTab] };
  const body = h('div');
  const bar = h('div.tabs', Object.entries(tabs).map(([key, [label]]) => h(`button${key === tab ? '.on' : ''}`, { type: 'button', dataset: { tab: key }, on: { click: () => show(key) } }, label)));
  const show = key => { bar.querySelectorAll('button').forEach(button => button.classList.toggle('on', button.dataset.tab === key)); fill(body, tabs[key][1]()); };
  const dialog = sheet({ title: 'Impostazioni', body: [body], foot: [h('button.btn.accent', { type: 'button', on: { click: () => dialog.close() } }, 'Fatto')] });
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
    title: extension.popup ? `${extension.name} — apri` : extension.name,
    on: { click: async () => { if (!extension.popup || !await api.extensionPopup(extension.id)) openExtensions(); } }
  }, extension.icon ? h('img', { src: extension.icon, alt: '' }) : extension.name[0])));
}

function installedList(container) {
  const render = () => fill(container, state.extensions.length ? state.extensions.map(extension => h('div.ext-row',
    h('div.ext-top', extension.icon ? h('img', { src: extension.icon, alt: '' }) : h('span.favicon', extension.name[0]),
      h('div', h('strong', extension.name), h('small', `v${extension.version}${extension.description ? ` · ${extension.description.slice(0, 90)}` : ''}`)),
      h('button.btn.sm.ghost.danger', { type: 'button', on: { click: async () => {
        if (!await confirmDialog(`Rimuovere ${extension.name}?`, 'Verrà tolta da tutti i servizi.', { confirm: 'Rimuovi', danger: true })) return;
        await api.removeExtension(extension.id); await loadExtensions(); render();
      } } }, icon('trash-2'), 'Rimuovi')),
    h('div.ext-services', state.services.map(service => {
      const enabled = extension.rules?.[service.id] !== false;
      return h(`button.chip${enabled ? '.on' : ''}`, { type: 'button', title: enabled ? 'Attiva: clic per disattivare' : 'Disattivata: clic per attivare', on: { click: async () => {
        await api.toggleExtension(extension.id, service.id, !enabled); await loadExtensions(); render();
      } } }, favicon(service), service.name);
    })))) : h('p.muted', 'Nessuna estensione installata.'));
  render();
  return render;
}

export function openExtensions() {
  const query = h('input#extension-query', { placeholder: 'Cerca nel Chrome Web Store', type: 'search' });
  const status = h('div.muted#marketplace-status');
  const results = h('div.market#marketplace-results');
  const installed = h('div#extension-list');
  const refreshInstalled = installedList(installed);
  const search = async () => {
    const text = query.value.trim(); if (!text) return;
    status.textContent = 'Ricerca…'; fill(results);
    try {
      const found = await api.searchExtensions(text);
      status.textContent = found.length ? `${found.length} risultati` : 'Nessun risultato';
      fill(results, found.map(item => {
        const button = h('button.btn.sm', { type: 'button', disabled: item.installed }, item.installed ? 'Installata' : 'Installa');
        button.addEventListener('click', async () => {
          button.disabled = true; button.textContent = 'Installazione…';
          try {
            const extension = await api.installExtension(item.id);
            button.textContent = 'Installata';
            toast(`${extension.name} attiva su ${extension.enabledOn.length ? extension.enabledOn.join(', ') : 'nessun servizio (attivala qui sotto)'}`);
            await loadExtensions(); refreshInstalled();
          } catch (error) { button.disabled = false; button.textContent = 'Riprova'; toast(String(error.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')); }
        });
        return h('div.market-item', h('img', { src: item.image, alt: '' }), h('strong', item.name), button);
      }));
    } catch (error) { status.textContent = String(error.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
  };
  query.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); search(); } });
  const dialog = sheet({
    title: 'Estensioni', subtitle: 'Dal Chrome Web Store. Ogni estensione si attiva solo sui servizi dove serve.', wide: true,
    body: [h('div.inline', query, h('button.btn.accent#search-extension', { type: 'button', on: { click: search } }, icon('search'), 'Cerca')), status, results,
      h('h3', { style: 'margin:8px 0 0;font-size:13px' }, 'Installate'), installed,
      h('p.note', 'Electron supporta solo una parte delle API di Chrome: alcune estensioni si installano ma non funzionano del tutto. Se una fa chiudere un servizio, Nuvia la disattiva lì automaticamente.')]
  });
  dialog.id = 'extensions-dialog';
  openModal(dialog).then(() => query.focus());
}

export function initSettings() {
  $('#open-settings').addEventListener('click', () => openSettings());
  $('#open-extensions').addEventListener('click', openExtensions);
  $('#collapse-sidebar').addEventListener('click', () => { state.prefs.sidebarCollapsed = !state.prefs.sidebarCollapsed; savePrefs(); applyAppearance(); });
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (state.prefs.theme === 'system') applyAppearance(); });
  on('open-settings', tab => openSettings(tab));
  on('route', renderExtensionToolbar);
}
