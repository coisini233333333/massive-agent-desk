import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodexAppServerClient } from '../src/main/codex-app-server.mjs';

// Creates only a dedicated test conversation; never resumes a user's idea/work.
const cwd = path.resolve('.massive-agent', 'p0-test-project');
await fs.mkdir(cwd, { recursive: true });
const marker = `P0-${randomUUID()}`;
const client = new CodexAppServerClient({ timeoutMs: 45_000 });
const completed = new Map();
let threadId;
let firstTurnId;
client.on('event', event => {
  if (event.method === 'turn/completed') completed.set(event.params.turn.id, event.params.turn);
});
async function waitForTurn(turnId) {
  const end = Date.now() + 90_000;
  while (!completed.has(turnId) && Date.now() < end) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    if (completed.has(turnId)) break;
    const history = await client.request('thread/read', { threadId, includeTurns: true });
    const stored = history.thread.turns.find(turn => turn.id === turnId);
    if (stored && ['completed', 'interrupted', 'failed'].includes(stored.status)) completed.set(turnId, stored);
  }
  const turn = completed.get(turnId);
  assert.equal(turn?.status, 'completed', `turn ${turnId} did not complete`);
}
try {
  await client.connect();
  const models = await client.listModels();
  const model = models.find(item => item.isDefault)?.model;
  assert.ok(model, 'model/list has no default model');
  const created = await client.request('thread/start', { cwd, sandbox: 'read-only', model });
  threadId = created.thread.id;
  console.log(`Dedicated test thread: ${threadId}; model: ${model}`);
  const first = await client.request('turn/start', {
    threadId, input: [{ type: 'text', text: `Isolated bridge transport test. Do not use tools. Reply exactly: ${marker}` }]
  });
  firstTurnId = first.turn.id;
  console.log(`Waiting for first turn: ${firstTurnId}`);
  await waitForTurn(first.turn.id);
  const resumed = await client.continueThread({
    threadId, runId: 'p0-resume',
    prompt: `Transport continuation test. Do not use tools. Reply exactly: ${marker}-RESUMED`
  });
  assert.equal(resumed.model, created.model, 'resume changed the effective model');
  assert.equal(resumed.effort, created.reasoningEffort, 'resume changed the effective reasoning effort');
  console.log(`Waiting for resumed turn: ${resumed.turnId}`);
  await waitForTurn(resumed.turnId);
  const read = await client.readThread(threadId);
  assert.equal(read.thread.id, threadId);
  const page = await client.listThreadTurns(threadId);
  const turnIds = page.data.map(turn => turn.id);
  assert.ok(turnIds.includes(first.turn.id));
  assert.ok(turnIds.includes(resumed.turnId));
  const resumedTurn = page.data.find(turn => turn.id === resumed.turnId);
  const replies = resumedTurn.items.filter(item => item.type === 'agentMessage').map(item => item.text.trim());
  assert.ok(replies.includes(`${marker}-RESUMED`), 'resumed turn has no matching assistant reply');
  const evidence = {
    verifiedAt: new Date().toISOString(), cwd, threadId,
    firstTurnId: first.turn.id, resumedTurnId: resumed.turnId,
    model: resumed.model, effort: resumed.effort,
    checks: ['same stable thread ID', 'both turns persisted and readable', 'no resume configuration overrides'],
    notVerified: ['Antigravity connection', 'human confirmation provenance', 'desktop UI open/continue', 'Android APK']
  };
  await fs.mkdir('artifacts', { recursive: true });
  await fs.writeFile('artifacts/p0-codex-resume.json', JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  await fs.mkdir('artifacts', { recursive: true });
  const evidence = {
    verifiedAt: new Date().toISOString(), threadId, firstTurnId,
    result: 'failed', error: error.message,
    notVerified: ['completed model response', 'Antigravity connection', 'human confirmation provenance', 'Android APK']
  };
  if (threadId) {
    try {
      const history = await client.request('thread/read', { threadId, includeTurns: true });
      evidence.observedTurns = history.thread.turns.map(turn => ({
        id: turn.id, status: turn.status, itemTypes: turn.items.map(item => item.type)
      }));
    } catch { evidence.historyRead = 'unavailable; delivery remains uncertain'; }
  }
  await fs.writeFile('artifacts/p0-codex-resume.json', JSON.stringify(evidence, null, 2) + '\n');
  throw error;
} finally { client.close(); }
