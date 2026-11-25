const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('reviewWindow', {
  load: () => ipcRenderer.invoke('review-window:load'),
  choose: value => ipcRenderer.invoke('review-window:choose', value)
});
