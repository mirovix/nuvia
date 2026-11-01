// The hidden speech recognition page (whisper.html): jobs in, progress and text out.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('whisper', {
  onJob: callback => ipcRenderer.on('whisper:job', (_, job) => callback(job)),
  progress: (id, value) => ipcRenderer.send('whisper:progress', id, value),
  reply: (id, result) => ipcRenderer.send('whisper:result', id, result)
});
