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
const runtimeErrors = [];
let threadId;
let firstTurnId;
let ownedTurnPending = false;
let attemptedPrompt;
client.on('event', event => {
  if (event.method === 'turn/completed') {
    completed.set(event.params.turn.id, event.params.turn);
    if (event.threadId === threadId) ownedTurnPending = false;
  }
  if (event.method === 'error' && event.threadId === threadId) {
    const observation = {
      turnId: event.params.turnId, willRetry: event.params.willRetry,
      code: event.params.error?.codexErrorInfo ?? 'unspecified'
    };
    runtimeErrors.push(observation);
    console.log('Runtime error:', JSON.stringify(observation));
  }
});
let serverExited = false;
client.on('exit', () => { serverExited = true; });
async function waitForTurn(turnId) {
  let lastNotice = Date.now();
  // Observation timeout is not execution failure. Keep the original process
  // and request alive through provider retries; never send a replacement turn.
  while (!completed.has(turnId)) {
    if (serverExited) throw new Error('Owning app-server exited before a terminal turn event; reconcile history before retrying.');
    await new Promise(resolve => setTimeout(resolve, 3000));
    if (completed.has(turnId)) break;
    if (Date.now() - lastNotice >= 30_000) {
      lastNotice = Date.now();
      console.log(`Still observing original turn ${turnId}; no resend.`);
      try {
        // Reconcile through this same owner if a completion notification was
        // lost. A separate server's disk view is not live execution evidence.
        const metadata = await client.readThread(threadId);
        const page = await client.listThreadTurns(threadId);
        const stored = page.data.find(turn => turn.id === turnId);
        if (metadata.thread.status.type !== 'active' && stored
          && ['completed', 'failed', 'interrupted'].includes(stored.status)) {
          completed.set(turnId, stored);
          ownedTurnPending = false;
        }
      } catch {
        console.log('Owner observation temporarily unavailable; retaining original request.');
      }
    }
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
  attemptedPrompt = `Isolated bridge transport test. Do not use tools. Reply exactly: ${marker}`;
  ownedTurnPending = true;
  const first = await client.request('turn/start', {
    threadId, input: [{ type: 'text', text: attemptedPrompt }]
  });
  firstTurnId = first.turn.id;
  console.log(`Waiting for first turn: ${firstTurnId}`);
  await waitForTurn(first.turn.id);
  attemptedPrompt = `Transport continuation test. Do not use tools. Reply exactly: ${marker}-RESUMED`;
  ownedTurnPending = true;
  const resumed = await client.continueThread({
    threadId, runId: 'p0-resume',
    prompt: attemptedPrompt
  }).catch(error => {
    if (error.deliveryStatus !== 'unknown') ownedTurnPending = false;
    throw error;
  });
  console.log(`Waiting for resumed turn: ${resumed.turnId}`);
  await waitForTurn(resumed.turnId);
  assert.equal(resumed.model, created.model, 'resume changed the effective model');
  assert.equal(resumed.effort, created.reasoningEffort, 'resume changed the effective reasoning effort');
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
    runtimeErrors,
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
    result: ownedTurnPending ? 'delivery-unknown' : 'failed', error: error.message, runtimeErrors,
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
  // Even a missing turn/start receipt is not proof of non-delivery. Preserve
  // the original owner until a terminal event or its confirmed process exit.
  // A pre-send RPC rejection, unlike an observation error, is definitive.
  if (error.rpcError) ownedTurnPending = false;
  while (ownedTurnPending && !serverExited) {
    console.log(`Delivery requires reconciliation for ${threadId}; retaining original owner, no resend.`);
    await new Promise(resolve => setTimeout(resolve, 30_000));
    try {
      const metadata = await client.readThread(threadId);
      const page = await client.listThreadTurns(threadId);
      const matches = page.data.filter(turn => turn.items.some(item => item.type === 'userMessage'
        && item.content.some(content => content.type === 'text' && content.text === attemptedPrompt)));
      if (metadata.thread.status.type !== 'active' && matches.length === 1
        && ['completed', 'failed', 'interrupted'].includes(matches[0].status)) {
        ownedTurnPending = false;
        evidence.reconciledTurn = { id: matches[0].id, status: matches[0].status };
        evidence.result = 'check-failed-after-reconciliation';
        await fs.writeFile('artifacts/p0-codex-resume.json', JSON.stringify(evidence, null, 2) + '\n');
      }
    } catch { /* Keep the same owner through transient observation failure. */ }
  }
  throw error;
} finally { client.close(); }
