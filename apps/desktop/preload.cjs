// The only bridge between the page and the app: three calls, no Node access.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sessionLens', {
  api: (path, query, body) => ipcRenderer.invoke('lens:api', path, query, body),
  onChange: (cb) => {
    ipcRenderer.on('lens:change', () => cb());
  },
  save: (name, content) => ipcRenderer.send('lens:save', name, content),
});
