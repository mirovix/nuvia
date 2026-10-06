const { contextBridge, ipcRenderer } = require('electron');

const invoke = channel => (...args) => ipcRenderer.invoke(channel, ...args);
const listen = channel => callback => {
  const handler = (_, value) => callback(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('nuvia', {
  platform: process.platform,
  appInfo: invoke('app:info'),
  minimize: invoke('window:minimize'),
  maximize: invoke('window:maximize'),
  close: invoke('window:close'),
  windowState: invoke('window:state'),
  onWindowState: listen('window:state'),
  setViewBounds: invoke('view:bounds'),
  setOverlay: invoke('overlay:set'),

  listServices: invoke('services:list'),
  saveServices: invoke('services:save'),
  serviceState: invoke('services:state'),
  onServiceState: listen('services:state'),
  activate: invoke('services:activate'),
  activateUrl: invoke('services:activate-url'),
  home: invoke('services:home'),
  reload: invoke('services:reload'),
  back: invoke('services:back'),
  forward: invoke('services:forward'),
  removeView: invoke('services:remove-view'),
  serviceMenu: invoke('services:context-menu'),
  signInGet: invoke('services:signin-get'),
  signInSet: invoke('services:signin-set'),
  signInClear: invoke('services:signin-clear'),
  onOpenService: listen('open-service'),
  onEditService: listen('service:edit'),
  onRemoveService: listen('service:remove'),
  onShortcut: listen('shortcut'),

  getPreferences: invoke('preferences:get'),
  savePreferences: invoke('preferences:save'),
  chooseBackground: invoke('preferences:background-file'),

  listExtensions: invoke('extensions:list'),
  searchExtensions: invoke('extensions:search'),
  installExtension: invoke('extensions:install'),
  toggleExtension: invoke('extensions:toggle'),
  removeExtension: invoke('extensions:remove'),
  extensionPopup: invoke('extensions:popup'),

  mail: invoke('mail:list'),
  openMail: invoke('mail:open'),
  messages: invoke('messages:list'),
  openMessage: invoke('messages:open'),
  sendMessage: invoke('messages:send'),
  calendarEvents: invoke('calendar:events'),

  musicState: invoke('music:state'),
  musicControl: invoke('music:control'),
  musicLibrary: invoke('music:library'),
  musicSearch: invoke('music:search'),
  musicPlayTrack: invoke('music:play-track'),
  musicPlayUri: invoke('music:play-uri'),
  openSpotify: invoke('music:open'),

  suggestPlaces: invoke('places:suggest'),
  route: invoke('commute:route'),
  trainStatus: invoke('trains:status'),
  trainBoard: invoke('trains:board'),
  trainImport: invoke('trains:import'),
  iasState: invoke('ias:state'),
  iasSignIn: invoke('ias:login'),
  iasSignOut: invoke('ias:logout'),
  iasEnter: invoke('ias:enter'),
  iasExit: invoke('ias:exit'),

  listNotifications: invoke('notifications:list'),
  addNotification: invoke('notifications:add'),
  removeNotification: invoke('notifications:remove'),
  readAllNotifications: invoke('notifications:read-all'),
  onNotificationsChanged: listen('notifications:changed'),

  aiUsage: invoke('ai:usage'),
  installClaudeStatusLine: invoke('ai:install-claude-statusline'),
  updateState: invoke('update:get'),
  checkForUpdates: invoke('update:check'),
  restartToUpdate: invoke('update:restart'),
  onUpdate: listen('update:state'),
  debugState: invoke('debug:state'),
  debugGuard: invoke('debug:crash-guard'),
  debugCrash: invoke('debug:crash-view'),
  debugCookies: invoke('debug:cookie-roundtrip'),
  debugRemoveInstallTree: invoke('debug:remove-install-tree')
});
