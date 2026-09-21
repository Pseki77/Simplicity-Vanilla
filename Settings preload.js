const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsApi', {
  get: () => ipcRenderer.invoke('settings:get'),
  update: (change) => ipcRenderer.invoke('settings:update', change),
  restart: () => ipcRenderer.invoke('settings:restart'),
});