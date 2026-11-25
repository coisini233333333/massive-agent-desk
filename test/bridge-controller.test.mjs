import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { BridgeController } from '../src/main/bridge-controller.mjs';

function fixture({ confirm = async () => true, confirmRequest, databasePath, cwd } = {}) {
  cwd ||= mkdtempSync(path.join(os.tmpdir(), 'bridge-project-'));
  databasePath ||= path.join(cwd, 'bridge.sqlite');
  const sent = [];
  const client = Object.assign(new EventEmitter(), {
    connect: async () => {},
    readThread: async id => ({ thread: { id, cwd, name: id } }),
    listThreads: async () => ({ data: [{ id: 'idea', cwd }], nextCursor: null }),
    listThreadTurns: async id => ({ data: [{ id, items: [] }], nextCursor: null }),
    continueThread: async request => { sent.push(request); return { threadId: request.threadId, turnId: `turn-${sent.length}` }; }
  });
  const bridge = new BridgeController({ databasePath, client, confirm, confirmRequest, hasExclusiveOwnership: () => true });
  return { bridge, client, sent, cwd, databasePath };
}

test('desktop confirms the exact bound revision and repeat clicks send only once', async () => {
  const confirmations = [];
  const f = fixture({ confirm: async value => { confirmations.push(value); return true; } });
  try {
    const binding = await f.bridge.bind({ cwd: f.cwd, threadId: 'chosen-idea' });
    const draft = f.bridge.prepare({ projectId: binding.projectId, text: '  exact\n原文  ' });
    const [one, two] = await Promise.all([
      f.bridge.confirmAndSend({ commandId: draft.commandId }), f.bridge.confirmAndSend({ commandId: draft.commandId })
    ]);
    assert.equal(one.state, 'delivered');
    assert.deepEqual(one, two);
    assert.equal(confirmations.length, 1);
    assert.equal(confirmations[0].text, '  exact\n原文  ');
    assert.equal(confirmations[0].targetThreadId, 'chosen-idea');
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].prompt, draft.text);
    await f.bridge.confirmAndSend({ commandId: draft.commandId });
    assert.equal(f.sent.length, 1);
  } finally { f.bridge.close(); }
});

test('canceling native confirmation cannot queue or send', async () => {
  const f = fixture({ confirm: async () => false });
  try {
    const binding = await f.bridge.bind({ cwd: f.cwd, threadId: 'idea' });
    const draft = f.bridge.prepare({ projectId: binding.projectId, text: 'not approved' });
    assert.equal((await f.bridge.confirmAndSend({ commandId: draft.commandId })).cancelled, true);
    assert.equal(f.bridge.ledger.getCommand(draft.commandId), null);
    assert.equal(f.sent.length, 0);
  } finally { f.bridge.close(); }
});

test('editing while the native dialog is open invalidates that confirmation', async () => {
  let answer;
  const f = fixture({ confirm: () => new Promise(resolve => { answer = resolve; }) });
  try {
    const binding = await f.bridge.bind({ cwd: f.cwd, threadId: 'idea' });
    const old = f.bridge.prepare({ projectId: binding.projectId, text: 'old' });
    const pending = f.bridge.confirmAndSend({ commandId: old.commandId });
    f.bridge.prepare({ projectId: binding.projectId, draftId: old.draftId, text: 'new' });
    answer(true);
    await assert.rejects(pending, /当前版本/);
    assert.equal(f.sent.length, 0);
    assert.equal(f.bridge.bootstrap().tickets.find(t => t.commandId === old.commandId).state, 'superseded');
  } finally { f.bridge.close(); }
});

test('claiming a selected command never sends an older queued command instead', async () => {
  const f = fixture();
  try {
    const binding = await f.bridge.bind({ cwd: f.cwd, threadId: 'idea' });
    const older = f.bridge.prepare({ projectId: binding.projectId, text: 'older' });
    // Simulate a confirmed command whose network preflight failed.
    f.client.connect = async () => { throw new Error('offline before send'); };
    await assert.rejects(f.bridge.confirmAndSend({ commandId: older.commandId }), /offline/);
    const selected = f.bridge.prepare({ projectId: binding.projectId, text: 'selected' });
    f.client.connect = async () => {};
    await f.bridge.confirmAndSend({ commandId: selected.commandId });
    assert.equal(f.sent[0].prompt, 'selected');
    assert.equal(f.bridge.ledger.getCommand(older.commandId).state, 'queued');
  } finally { f.bridge.close(); }
});

test('restart recovers sending as unknown and never resends automatically', async () => {
  const f = fixture();
  const binding = await f.bridge.bind({ cwd: f.cwd, threadId: 'idea' });
  const draft = f.bridge.prepare({ projectId: binding.projectId, text: 'send uncertain' });
  f.client.connect = async () => { throw new Error('offline'); };
  await assert.rejects(f.bridge.confirmAndSend({ commandId: draft.commandId }));
  f.bridge.ledger.claimNextForSend({ commandId: draft.commandId });
  f.bridge.close();
  const restarted = fixture({ cwd: f.cwd, databasePath: f.databasePath });
  try {
    assert.equal(restarted.bridge.bootstrap().bindings[0].threadId, 'idea');
    assert.equal(restarted.bridge.ledger.getCommand(draft.commandId).state, 'unknown');
    await assert.rejects(restarted.bridge.confirmAndSend({ commandId: draft.commandId }), /禁止重新发送/);
    assert.equal(restarted.sent.length, 0);
  } finally { restarted.bridge.close(); }
});

test('a thread from another project cannot be bound', async () => {
  const f = fixture();
  try {
    const other = mkdtempSync(path.join(os.tmpdir(), 'other-project-'));
    f.client.readThread = async id => ({ thread: { id, cwd: other } });
    await assert.rejects(f.bridge.bind({ cwd: f.cwd, threadId: 'other' }), /不属于/);
    assert.equal(f.bridge.bootstrap().bindings.length, 0);
  } finally { f.bridge.close(); }
});

test('server approvals require native host decision and preserve the original request id', async () => {
  const f = fixture({ confirmRequest: async request => { assert.equal(request.params.command, 'original command'); return 'accept'; } });
  const replies = [];
  f.client.replyServerRequest = (id, result) => replies.push({ id, result });
  try {
    f.client.emit('serverRequest', { id: 'original-id', method: 'item/commandExecution/requestApproval', params: { command: 'original command' } });
    assert.equal(replies.length, 0);
    await f.bridge.resolveRequest({ requestId: 'original-id' });
    assert.deepEqual(replies, [{ id: 'original-id', result: { decision: 'accept' } }]);
    await assert.rejects(f.bridge.resolveRequest({ requestId: 'original-id' }), /已回答/);
    f.client.emit('event', { method: 'serverRequest/resolved', params: { requestId: 'original-id' } });
    assert.equal(f.bridge.bootstrap().pendingRequests.length, 0);
  } finally { f.bridge.close(); }
});

test('approval already resolved elsewhere cannot be answered by a stale native dialog', async () => {
  let answer;
  const f = fixture({ confirmRequest: () => new Promise(resolve => { answer = resolve; }) });
  let sent = false;
  f.client.replyServerRequest = () => { sent = true; };
  try {
    f.client.emit('serverRequest', { id: 7, method: 'item/commandExecution/requestApproval', params: {} });
    const pending = f.bridge.resolveRequest({ requestId: 7 });
    f.client.emit('event', { method: 'serverRequest/resolved', params: { requestId: 7 } });
    answer('accept');
    await assert.rejects(pending, /另一端处理/);
    assert.equal(sent, false);
  } finally { f.bridge.close(); }
});

test('different commands on the same busy target remain queued without false unknown', async () => {
  const f = fixture();
  let finish;
  try {
    const binding = await f.bridge.bind({ cwd: f.cwd, threadId: 'idea' });
    const first = f.bridge.prepare({ projectId: binding.projectId, text: 'first' });
    const next = f.bridge.prepare({ projectId: binding.projectId, text: 'next' });
    f.client.continueThread = () => new Promise(resolve => { finish = resolve; });
    const sending = f.bridge.confirmAndSend({ commandId: first.commandId });
    await new Promise(resolve => setImmediate(resolve));
    const waiting = await f.bridge.confirmAndSend({ commandId: next.commandId });
    assert.equal(waiting.state, 'queued');
    assert.match(waiting.waitReason, /未发送/);
    finish({ threadId: 'idea', turnId: 'first-turn' });
    assert.equal((await sending).state, 'delivered');
  } finally { f.bridge.close(); }
});

test('proven pre-send rejection remains queued but lost delivery acknowledgement becomes unknown', async () => {
  for (const status of ['not-sent', 'unknown']) {
    const f = fixture();
    try {
      const binding = await f.bridge.bind({ cwd: f.cwd, threadId: 'idea' });
      const draft = f.bridge.prepare({ projectId: binding.projectId, text: 'text' });
      f.client.continueThread = async () => { throw Object.assign(new Error('transport'), { deliveryStatus: status }); };
      const result = await f.bridge.confirmAndSend({ commandId: draft.commandId });
      assert.equal(result.state, status === 'not-sent' ? 'queued' : 'unknown');
    } finally { f.bridge.close(); }
  }
});

test('ticket insert failure rolls back new revision and preserves the older queued draft', async () => {
  const f = fixture();
  try {
    const binding = await f.bridge.bind({ cwd: f.cwd, threadId: 'idea' });
    const old = f.bridge.prepare({ projectId: binding.projectId, text: 'old' });
    f.client.connect = async () => { throw new Error('offline'); };
    await assert.rejects(f.bridge.confirmAndSend({ commandId: old.commandId }));
    f.bridge.ledger.db.exec("CREATE TRIGGER fail_ticket BEFORE INSERT ON bridge_tickets BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
    assert.throws(() => f.bridge.prepare({ projectId: binding.projectId, draftId: old.draftId, text: 'new' }), /injected failure/);
    assert.equal(f.bridge.bootstrap().tickets.length, 1);
    assert.equal(f.bridge.ledger.getCommand(old.commandId).state, 'queued');
    assert.equal(f.bridge.ledger.getDraftRevision(old.draftId, 2), null);
  } finally { f.bridge.close(); }
});

test('local approval write rejection leaves the original request pending', async () => {
  const f = fixture({ confirmRequest: async () => 'accept' });
  try {
    f.client.replyServerRequest = () => { throw new Error('stdin is closed'); };
    f.client.emit('serverRequest', { id: 'human', method: 'item/commandExecution/requestApproval', params: { kind: 'humanCommand' } });
    await assert.rejects(f.bridge.resolveRequest({ requestId: 'human' }), /stdin/);
    assert.equal(f.bridge.bootstrap().pendingRequests[0].status, 'pending');
  } finally { f.bridge.close(); }
});

test('file approval item evidence cannot cross thread or turn boundaries', async () => {
  let shown;
  const f = fixture({ confirmRequest: async request => { shown = request.item; return 'accept'; } });
  let replied = false;
  f.client.replyServerRequest = () => { replied = true; };
  try {
    f.client.emit('event', { method: 'item/started', params: { threadId: 'thread-a', turnId: 'turn-a', item: { id: 'same-item', type: 'fileChange', changes: ['private-a'] } } });
    f.client.emit('serverRequest', { id: 'file', method: 'item/fileChange/requestApproval', params: { threadId: 'thread-b', turnId: 'turn-b', itemId: 'same-item' } });
    await assert.rejects(f.bridge.resolveRequest({ requestId: 'file' }), /原始文件修改详情/);
    assert.equal(shown, undefined);
    assert.equal(replied, false);
  } finally { f.bridge.close(); }
});

test('late binding reads cannot overwrite the more recent explicit selection', async () => {
  const f = fixture();
  const reads = new Map();
  try {
    f.client.readThread = id => new Promise(resolve => reads.set(id, resolve));
    const old = f.bridge.bind({ cwd: f.cwd, threadId: 'old-choice' });
    const latest = f.bridge.bind({ cwd: f.cwd, threadId: 'latest-choice' });
    reads.get('latest-choice')({ thread: { id: 'latest-choice', cwd: f.cwd } });
    const bound = await latest;
    reads.get('old-choice')({ thread: { id: 'old-choice', cwd: f.cwd } });
    await assert.rejects(old, /过期绑定/);
    assert.equal(f.bridge.binding(bound.projectId).threadId, 'latest-choice');
  } finally { f.bridge.close(); }
});
