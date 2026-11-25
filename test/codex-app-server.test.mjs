import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CodexAppServerClient } from '../src/main/codex-app-server.mjs';

function fixture(replies = {}) {
  const messages = [];
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = { writable: true, write(line) {
    const message = JSON.parse(line);
    messages.push(message);
    if (message.id === undefined) return;
    const result = replies[message.method]?.(message, child) ?? {};
    if (result !== 'pending') child.stdout.write(JSON.stringify({ id: message.id, result }) + '\n');
  } };
  child.kill = () => child.emit('exit', 0);
  const client = new CodexAppServerClient({ spawnImpl: () => child, timeoutMs: 100 });
  return { client, child, messages };
}

test('existing thread retains ID and configuration without creating another thread', async () => {
  const { client, child, messages } = fixture({
    'thread/resume': () => ({ thread: { id: 'existing' }, model: 'original-model', reasoningEffort: 'high' }),
    'turn/start': () => ({ turn: { id: 'turn-1' } })
  });
  try {
    const result = await client.continueThread({ threadId: 'existing', runId: 'run-1', prompt: '确切原文' });
    assert.equal(result.model, 'original-model');
    assert.equal(messages.some(m => m.method === 'thread/start'), false);
    assert.deepEqual(messages.find(m => m.method === 'thread/resume').params, { threadId: 'existing' });
    assert.deepEqual(messages.find(m => m.method === 'turn/start').params, {
      threadId: 'existing', input: [{ type: 'text', text: '确切原文' }]
    });
    await assert.rejects(client.continueThread({ threadId: 'existing', runId: 'run-2', prompt: 'duplicate' }), /活动回合/);
    child.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: 'existing' } }) + '\n');
    assert.equal(client.activeTurns.size, 0);
    assert.equal(client.threadToRun.size, 0);
  } finally { client.close(); }
});

test('active or mismatched thread never receives turn/start', async () => {
  for (const thread of [{ id: 'existing', status: { type: 'active' } }, { id: 'other' }]) {
    const { client, messages } = fixture({ 'thread/resume': () => ({ thread }) });
    try {
      await assert.rejects(client.continueThread({ threadId: 'existing', runId: 'r', prompt: 'text' }));
      assert.equal(messages.some(m => m.method === 'turn/start'), false);
    } finally { client.close(); }
  }
});

test('server approval sharing an outbound RPC ID is emitted, never auto-answered or consumed', async () => {
  const { client, child, messages } = fixture({ 'model/list': () => 'pending' });
  try {
    await client.connect();
    const seen = [];
    client.on('serverRequest', event => seen.push(event));
    const request = client.listModels();
    await new Promise(resolve => setImmediate(resolve));
    const id = messages.find(m => m.method === 'model/list').id;
    const approval = { id, method: 'item/commandExecution/requestApproval', params: { command: 'example' } };
    child.stdout.write(JSON.stringify(approval) + '\n');
    assert.deepEqual(seen, [approval]);
    assert.equal(client.pending.has(id), true);
    child.stdout.write(JSON.stringify({ id, result: { data: [{ model: 'test' }] } }) + '\n');
    assert.deepEqual(await request, [{ model: 'test' }]);
    assert.equal(messages.some(m => m.result), false);
  } finally { client.close(); }
});

test('early completion cannot resurrect a finished turn', async () => {
  const { client } = fixture({
    'thread/resume': () => ({ thread: { id: 'existing' } }),
    'turn/start': (_message, child) => {
      child.stdout.write(JSON.stringify({ method: 'turn/completed', params: { threadId: 'existing' } }) + '\n');
      return { turn: { id: 'done' } };
    }
  });
  try {
    await client.continueThread({ threadId: 'existing', runId: 'r', prompt: 'text' });
    assert.equal(client.activeTurns.size, 0);
  } finally { client.close(); }
});

test('lost turn/start receipt reserves the thread and prevents blind resend', async () => {
  const { client, messages } = fixture({
    'thread/resume': () => ({ thread: { id: 'existing' } }),
    'turn/start': () => 'pending'
  });
  try {
    await assert.rejects(client.continueThread({ threadId: 'existing', runId: 'r', prompt: 'text' }),
      error => error.deliveryStatus === 'unknown');
    await assert.rejects(client.continueThread({ threadId: 'existing', runId: 'retry', prompt: 'text' }), /活动回合/);
    assert.equal(messages.filter(m => m.method === 'turn/start').length, 1);
    assert.equal(client.activeTurns.get('r').outcomeUnknown, true);
  } finally { client.close(); }
});
