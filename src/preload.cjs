const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('massiveAgents', {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  pickWorkspace: () => ipcRenderer.invoke('app:pick-workspace'),
  connect: () => ipcRenderer.invoke('codex:connect'),
  launchRun: config => ipcRenderer.invoke('run:launch', config),
  interrupt: runId => ipcRenderer.invoke('run:interrupt', runId),
  bridgeBootstrap: () => ipcRenderer.invoke('bridge:bootstrap'),
  bridgeListThreads: params => ipcRenderer.invoke('bridge:threads', params),
  bridgeBind: params => ipcRenderer.invoke('bridge:bind', params),
  bridgeHistory: params => ipcRenderer.invoke('bridge:history', params),
  bridgePrepare: params => ipcRenderer.invoke('bridge:prepare', params),
  bridgeConfirm: params => ipcRenderer.invoke('bridge:confirm', params),
  bridgeResolveRequest: params => ipcRenderer.invoke('bridge:resolve-request', params),
  onBridge: callback => {
    const handler = () => callback();
    ipcRenderer.on('bridge:changed', handler);
    return () => ipcRenderer.removeListener('bridge:changed', handler);
  },
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
