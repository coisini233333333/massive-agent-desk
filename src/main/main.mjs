import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAppServerClient } from './codex-app-server.mjs';
import { ConfigStore } from './config-store.mjs';
import { AGENT_PRESETS, FALLBACK_MODELS } from '../shared/agent-presets.mjs';
import { buildRunPlan } from '../shared/planner.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const smokeMode = process.argv.includes('--smoke');
let mainWindow;
let client;
let store;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    show: !smokeMode,
    backgroundColor: '#101014',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(here, '..', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  if (smokeMode) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const artifactDir = path.join(process.cwd(), 'artifacts');
        fs.mkdirSync(artifactDir, { recursive: true });
        const image = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(artifactDir, 'ui-smoke.png'), image.toPNG());
        console.log('Electron renderer loaded and captured successfully.');
        app.quit();
      }, 1_500);
    });
  }
  mainWindow.loadFile(path.join(here, '..', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  store = new ConfigStore(app.getPath('userData'));
  client = new CodexAppServerClient();
  client.on('event', event => mainWindow?.webContents.send('codex:event', event));
  client.on('diagnostic', text => mainWindow?.webContents.send('codex:diagnostic', text));
  client.on('exit', code => mainWindow?.webContents.send('codex:exit', code));
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  client?.close();
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('app:bootstrap', async () => ({
  presets: AGENT_PRESETS,
  fallbackModels: FALLBACK_MODELS,
  saved: await store.read(),
  platform: process.platform
}));

ipcMain.handle('app:pick-workspace', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('codex:connect', async () => {
  const models = await client.listModels();
  return { models };
});

ipcMain.handle('run:launch', async (_event, config) => {
  const plan = buildRunPlan(config);
  await store.write(config);
  const settled = await Promise.allSettled(plan.map(run => client.startAgent(run)));
  return settled.map((result, index) => result.status === 'fulfilled'
    ? { ok: true, ...result.value }
    : { ok: false, runId: plan[index].runId, error: result.reason?.message || String(result.reason) });
});

ipcMain.handle('run:interrupt', (_event, runId) => client.interrupt(runId));
