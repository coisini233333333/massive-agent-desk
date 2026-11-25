import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { showReviewWindow } from '../src/main/review-window.mjs';

app.setPath('userData', path.resolve('.massive-agent/review-smoke-profile'));
app.whenReady().then(async () => {
  const parent = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
  const text = ('界面验收原文 <img src=x onerror="window.injected=true">\n' + '甲乙丙丁\n'.repeat(10_000)).slice(0, 50_000);
  const promise = showReviewWindow(parent, {
    title: '长原文审阅验收（不会发送）', context: { '会话': '独立测试项目', '版本': '1', '用途': '验证全文显示与取消' }, text,
    choices: [{ value: 'later', label: '返回检查' }, { value: 'send', label: '确认此版本' }], cancelValue: 'later'
  }, { show: false });
  const review = BrowserWindow.getAllWindows().find(window => window !== parent);
  await new Promise(resolve => review.webContents.once('did-finish-load', resolve));
  const spec = await review.webContents.executeJavaScript('window.reviewWindow.load()');
  assert.equal(spec.text, text);
  for (let i = 0; i < 30; i++) {
    if (await review.webContents.executeJavaScript('document.querySelector("#exactText").textContent.length === 50000')) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(await review.webContents.executeJavaScript('document.querySelector("#exactText").textContent'), text);
  assert.equal(await review.webContents.executeJavaScript('document.querySelectorAll("#exactText img").length'), 0);
  const rejected = await review.webContents.executeJavaScript('window.reviewWindow.choose("unregistered").then(()=>false,()=>true)');
  assert.equal(rejected, true);
  fs.mkdirSync('artifacts', { recursive: true });
  fs.writeFileSync('artifacts/review-smoke.png', (await review.webContents.capturePage()).toPNG());
  review.setContentSize(390, 760);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(await review.webContents.executeJavaScript('document.documentElement.scrollWidth <= innerWidth'));
  fs.writeFileSync('artifacts/review-smoke-mobile.png', (await review.webContents.capturePage()).toPNG());
  // Closing a renderer can dispose the executeJavaScript return channel. The
  // main-process review promise is the authoritative cancellation receipt.
  review.webContents.executeJavaScript('window.reviewWindow.choose("later")').catch(() => {});
  assert.equal(await promise, 'later');
  fs.writeFileSync('artifacts/review-smoke.json', JSON.stringify({ result: 'passed', textLength: text.length,
    exactTextPreserved: true, htmlRenderedAsText: true, invalidDecisionRejected: true,
    mobileWidth: 390, chosen: 'later', notVerified: ['human identity', 'actual approval or dispatch'] }, null, 2) + '\n');
  console.log('Review IPC, 50000-char exact text, no HTML injection, mobile fit and cancel passed.');
  parent.destroy(); app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
