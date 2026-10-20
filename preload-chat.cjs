// Preload for the Claude chat windows (chat.html): "Ask Claude" and "Reply with Claude".
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nuviaChat', {
  start: () => ipcRenderer.invoke('chat:start'),
  send: text => ipcRenderer.invoke('chat:send', text),
  insert: text => ipcRenderer.invoke('chat:insert', text),
  copy: text => ipcRenderer.invoke('chat:copy', text),
  openInClaude: () => ipcRenderer.invoke('chat:open-claude'),
  close: () => ipcRenderer.invoke('chat:close'),
  onEvent: callback => ipcRenderer.on('chat:event', (_, value) => callback(value))
});
