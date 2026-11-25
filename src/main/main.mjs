import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BridgeController } from './bridge-controller.mjs';
import { showReviewWindow } from './review-window.mjs';
import { CodexAppServerClient } from './codex-app-server.mjs';
import { ConfigStore } from './config-store.mjs';
import { AGENT_PRESETS, FALLBACK_MODELS } from '../shared/agent-presets.mjs';
import { buildRunPlan } from '../shared/planner.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const smokeMode = process.argv.includes('--smoke');
const smokeFixture = smokeMode && process.argv.includes('--bridge-fixture');
if (smokeMode) app.setPath('userData', path.join(process.cwd(), '.massive-agent', 'ui-smoke-profile'));
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.exit(0);
let mainWindow;
let client;
let store;
let bridge;
let quitting = false;
const rendererFile = path.join(here, '..', 'renderer', 'index.html');
function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}
async function waitForSmokeRenderer(condition) {
  for (let attempt = 0; attempt < 800; attempt++) {
    if (await mainWindow.webContents.executeJavaScript(condition)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Renderer smoke condition was not satisfied: ${condition}`);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 390,
    minHeight: 620,
    show: !smokeMode,
    backgroundColor: '#f7f7ef',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(here, '..', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: !smokeMode
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  if (smokeMode) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
        const artifactDir = path.join(process.cwd(), 'artifacts');
        fs.mkdirSync(artifactDir, { recursive: true });
        const image = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(artifactDir, 'ui-smoke.png'), image.toPNG());
        const bootstrap = await mainWindow.webContents.executeJavaScript('window.massiveAgents.bridgeBootstrap()');
        if (!Array.isArray(bootstrap.bindings)) throw new Error('Bridge preload/IPC bootstrap failed');
        if (smokeFixture) {
          const uiReady = await mainWindow.webContents.executeJavaScript('!document.querySelector("#draftText").disabled && document.querySelectorAll("#timeline .message").length > 0');
          if (!uiReady) throw new Error('Fixture history or composer did not render');
          const binding = bootstrap.bindings[0];
          const threads = await mainWindow.webContents.executeJavaScript(`window.massiveAgents.bridgeListThreads(${JSON.stringify({ cwd: binding.cwd })})`);
          if (!threads.data.some(thread => thread.id === binding.threadId)) throw new Error('Workspace discovery did not return the bound fixture');
          // Exercise real UI error -> retry recovery without sending a prompt.
          await mainWindow.webContents.executeJavaScript(`document.querySelector('#bridgeWorkspace').value=${JSON.stringify(path.join(binding.cwd, 'does-not-exist-ui-smoke'))}; document.querySelector('#listThreads').click(); true`);
          await waitForSmokeRenderer("document.querySelector('#threadList').textContent.includes('无法读取会话')");
          await mainWindow.webContents.executeJavaScript(`document.querySelector('#bridgeWorkspace').value=${JSON.stringify(binding.cwd)}; document.querySelector('#listThreads').click(); true`);
          await waitForSmokeRenderer(`Array.from(document.querySelectorAll('#threadList code')).some(node => node.textContent === ${JSON.stringify(binding.threadId)})`);
        }
        mainWindow.setContentSize(390, 844);
        // Reload at the narrow width so initial mobile disclosure state is
        // exercised, rather than inheriting the desktop's expanded sidebar.
        const reloaded = new Promise(resolve => mainWindow.webContents.once('did-finish-load', resolve));
        mainWindow.webContents.reload();
        await reloaded;
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (smokeFixture) await waitForSmokeRenderer("!document.querySelector('#draftText').disabled && document.querySelectorAll('#timeline .message').length > 0");
        await mainWindow.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        const mobile = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(artifactDir, 'ui-smoke-mobile.png'), mobile.toPNG());
        const fits = await mainWindow.webContents.executeJavaScript('document.documentElement.scrollWidth <= window.innerWidth');
        if (!fits) throw new Error('Mobile layout overflows horizontally');
        console.log('Electron bridge IPC and desktop/mobile capture passed.');
        client.close(); bridge.close(); bridge = null;
        app.exit(0);
        } catch (error) {
          console.error(`UI smoke failed: ${error.message}`);
          client?.close();
          app.exit(1);
        }
      }, 1_500);
    });
  }
  mainWindow.loadFile(rendererFile);
}

app.whenReady().then(async () => {
  store = new ConfigStore(app.getPath('userData'));
  client = new CodexAppServerClient();
  bridge = new BridgeController({
    databasePath: path.join(app.getPath('userData'), 'bridge.sqlite'), client,
    hasExclusiveOwnership: () => app.hasSingleInstanceLock(),
    confirmRequest: async request => {
      const missingFileDetails = request.method === 'item/fileChange/requestApproval' && request.item?.type !== 'fileChange';
      const decision = await showReviewWindow(mainWindow, {
        title: 'Codex 正在等待本人审批',
        context: { '会话 ID': request.params.threadId || '', '请求类型': request.method,
          '操作范围': missingFileDetails ? '原始修改详情未取得，暂不能批准' : '仅处理本次请求，不扩大未来权限' },
        text: JSON.stringify({ request: request.params, item: request.item }, null, 2),
        choices: [{ value: 'later', label: '稍后处理' },
          ...(!missingFileDetails ? [{ value: 'accept', label: '仅允许本次' }] : []),
          { value: 'decline', label: '拒绝本次' }, { value: 'cancel', label: '拒绝并终止回合' }],
        cancelValue: 'later'
      });
      return decision === 'later' ? null : decision;
    },
    confirm: async ticket => {
      const binding = bridge.binding(ticket.projectId);
      const decision = await showReviewWindow(mainWindow, {
        title: '确认发送这一版草案',
        context: { '项目': binding.name, '已有会话': binding.title, '会话 ID': ticket.targetThreadId,
          '草案版本': String(ticket.revision), '原文 SHA-256': ticket.textHash },
        text: ticket.text,
        choices: [{ value: 'later', label: '返回检查' }, { value: 'send', label: '确认发送此版本' }], cancelValue: 'later'
      });
      return decision === 'send';
    }
  });
  bridge.on('changed', () => sendToRenderer('bridge:changed'));
  client.on('event', event => sendToRenderer('codex:event', event));
  client.on('diagnostic', text => sendToRenderer('codex:diagnostic', text));
  client.on('exit', code => sendToRenderer('codex:exit', code));
  if (smokeFixture) {
    const prior = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'artifacts', 'p0-codex-resume.json'), 'utf8'));
    if (path.resolve(prior.cwd) !== path.resolve('.massive-agent/p0-test-project')) throw new Error('Only the dedicated test fixture may be displayed');
    const binding = await bridge.bind({ cwd: prior.cwd, threadId: prior.threadId });
    if (!bridge.bootstrap().tickets.some(ticket => ticket.projectId === binding.projectId)) {
      bridge.prepare({ projectId: binding.projectId, text: '界面验收草案（未发送）：请核对绑定会话与原文。' });
    }
  }
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch(error => { console.error(`Bridge startup failed: ${error.message}`); app.exit(1); });

app.on('second-instance', () => { mainWindow?.show(); mainWindow?.focus(); });
app.on('before-quit', () => {
  if (quitting) return;
  quitting = true;
  client?.close(); bridge?.close();
});

app.on('window-all-closed', () => {
  client?.close();
  if (process.platform !== 'darwin' && !quitting) app.quit();
});

ipcMain.handle('app:bootstrap', async () => ({
  presets: AGENT_PRESETS,
  fallbackModels: FALLBACK_MODELS,
  saved: await store.read(),
  smokeMode,
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

function handleBridge(channel, callback) {
  ipcMain.handle(channel, (event, params) => {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame
      || event.senderFrame.url.split('#')[0] !== pathToFileURL(rendererFile).href) throw new Error('桥接操作仅允许本机应用主界面调用。');
    return callback(params);
  });
}
handleBridge('bridge:bootstrap', () => bridge.bootstrap());
handleBridge('bridge:threads', params => bridge.listThreads(params));
handleBridge('bridge:bind', params => bridge.bind(params));
handleBridge('bridge:history', params => bridge.history(params));
handleBridge('bridge:prepare', params => bridge.prepare(params));
handleBridge('bridge:confirm', params => bridge.confirmAndSend(params));
handleBridge('bridge:resolve-request', params => bridge.resolveRequest(params));
