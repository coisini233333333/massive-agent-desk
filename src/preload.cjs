const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('massiveAgents', {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  pickWorkspace: () => ipcRenderer.invoke('app:pick-workspace'),
  connect: () => ipcRenderer.invoke('codex:connect'),
  launchRun: config => ipcRenderer.invoke('run:launch', config),
  interrupt: runId => ipcRenderer.invoke('run:interrupt', runId),
  onEvent: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('codex:event', handler);
    return () => ipcRenderer.removeListener('codex:event', handler);
  },
  onDiagnostic: callback => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('codex:diagnostic', handler);
    return () => ipcRenderer.removeListener('codex:diagnostic', handler);
  }
});
