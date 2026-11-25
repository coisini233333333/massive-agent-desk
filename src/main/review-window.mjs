import { BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const reviewFile = path.join(here, '..', 'review', 'index.html');
const reviewUrl = pathToFileURL(reviewFile).href;
const sessions = new Map();
let handlersInstalled = false;

function text(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new TypeError(`${label} 必须是文本。`);
  return value;
}

/** Validate all renderer-visible data at the main-process boundary. */
export function normalizeReviewSpec({ title, context = {}, text: body, choices, cancelValue }) {
  text(title, 'title');
  text(body, 'text', { allowEmpty: true });
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw new TypeError('context 必须是对象。');
  if (!Array.isArray(choices) || choices.length < 1) throw new TypeError('choices 至少需要一个选项。');
  const normalizedChoices = choices.map((choice, index) => ({
    value: text(choice?.value, `choices[${index}].value`),
    label: text(choice?.label, `choices[${index}].label`)
  }));
  const values = new Set(normalizedChoices.map(choice => choice.value));
  if (values.size !== normalizedChoices.length) throw new Error('choices.value 必须唯一。');
  if (!values.has(cancelValue)) throw new Error('cancelValue 必须存在于 choices 中。');
  const normalizedContext = Object.entries(context).map(([label, value]) => {
    const rendered = typeof value === 'string' ? value : JSON.stringify(value);
    return [text(label, 'context key'), text(rendered, `context.${label}`, { allowEmpty: true })];
  });
  return Object.freeze({ title, context: normalizedContext, text: body, choices: normalizedChoices, cancelValue });
}

function sessionFor(event) {
  const session = sessions.get(event.sender.id);
  if (!session || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== reviewUrl) {
    throw new Error('此审阅窗口已失效或来源不受信任。');
  }
  return session;
}

function installHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  ipcMain.handle('review-window:load', event => sessionFor(event).spec);
  ipcMain.handle('review-window:choose', (event, value) => {
    const session = sessionFor(event);
    if (typeof value !== 'string' || !session.spec.choices.some(choice => choice.value === value)) {
      throw new Error('不能提交未注册的审阅决定。');
    }
    session.finish(value);
    return { accepted: true };
  });
}

/**
 * A trusted main-process modal for reviewing exact immutable text. The
 * renderer can only retrieve this registered session and select a declared
 * choice; it cannot send arbitrary context or manufacture a decision.
 */
export function showReviewWindow(parent, input, { show = true } = {}) {
  const spec = normalizeReviewSpec(input);
  installHandlers();
  return new Promise((resolve, reject) => {
    const window = new BrowserWindow({
      parent,
      modal: true,
      show: false,
      width: 760,
      height: 760,
      minWidth: 390,
      minHeight: 560,
      backgroundColor: '#f7f7ef',
      autoHideMenuBar: true,
      title: spec.title,
      webPreferences: {
        preload: path.join(here, '..', 'review-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    const webContentsId = window.webContents.id;
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      sessions.delete(webContentsId);
      resolve(value);
      if (!window.isDestroyed()) window.close();
    };
    const session = { spec, finish };
    sessions.set(webContentsId, session);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.once('closed', () => finish(spec.cancelValue));
    window.webContents.once('did-fail-load', (_event, _code, description) => {
      if (!settled) {
        sessions.delete(webContentsId);
        settled = true;
        reject(new Error(`审阅窗口加载失败：${description}`));
        if (!window.isDestroyed()) window.destroy();
      }
    });
    window.once('ready-to-show', () => { if (show) window.show(); });
    window.loadFile(reviewFile).catch(error => {
      if (!settled) {
        sessions.delete(webContentsId);
        settled = true;
        reject(error);
        if (!window.isDestroyed()) window.destroy();
      }
    });
  });
}
