import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeController } from '../src/main/bridge-controller.mjs';
import { CodexAppServerClient } from '../src/main/codex-app-server.mjs';

// Dedicated test data only. This callback deliberately does not claim that a
// human clicked Electron's native confirmation dialog.
const prior = JSON.parse(fs.readFileSync('artifacts/p0-codex-resume.json', 'utf8'));
const expectedCwd = path.resolve('.massive-agent/p0-test-project');
assert.equal(path.resolve(prior.cwd), expectedCwd, 'prior fixture must be the dedicated test project');
const root = path.resolve('.massive-agent/host-smoke');
fs.mkdirSync(root, { recursive: true });
const lockPath = path.join(root, 'owner.lock');
const lock = fs.openSync(lockPath, 'wx');
let owns = true;
const client = new CodexAppServerClient({ timeoutMs: 45_000 });
const terminal = new Map();
client.on('event', event => {
  if (event.method === 'turn/completed') terminal.set(event.params.turn.id, event.params.turn);
});
let bridge;
let submittedPrompt;
let awaitingTerminal = false;
let commandId;
let ownerExited = false;
client.on('exit', () => { ownerExited = true; });
try {
  bridge = new BridgeController({
    databasePath: path.join(root, `${randomUUID()}.sqlite`), client,
    hasExclusiveOwnership: () => owns,
    confirm: async ticket => { console.log(`Test callback approved revision ${ticket.revision}; no human proof claimed.`); return true; }
  });
  const binding = await bridge.bind({ cwd: expectedCwd, threadId: prior.threadId });
  const marker = `HOST-${randomUUID()}`;
  submittedPrompt = `Dedicated transport test, no tools. Reply exactly ${marker}`;
  const draft = bridge.prepare({ projectId: binding.projectId, text: submittedPrompt });
  commandId = draft.commandId;
  awaitingTerminal = true;
  const receipt = await bridge.confirmAndSend({ commandId: draft.commandId });
  assert.equal(receipt.state, 'delivered');
  const delivered = JSON.parse(receipt.outcomeDetail);
  console.log(`Codex received command ${draft.commandId}, turn ${delivered.turnId}`);
  // Keep observing the original owner through stream retries.
  let lastNotice = Date.now();
  while (!terminal.has(delivered.turnId)) {
    if (ownerExited) throw new Error('Owning server exited; reconcile before any retry.');
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (Date.now() - lastNotice > 30_000) {
      console.log('Still observing the same command; no resend.');
      lastNotice = Date.now();
      try {
        const metadata = await client.readThread(prior.threadId);
        const page = await client.listThreadTurns(prior.threadId);
        const stored = page.data.find(turn => turn.id === delivered.turnId);
        if (metadata.thread.status.type !== 'active' && stored && ['completed', 'failed', 'interrupted'].includes(stored.status)) terminal.set(stored.id, stored);
      } catch { console.log('Observation temporarily unavailable; retain the original command.'); }
    }
  }
  awaitingTerminal = false;
  assert.equal(terminal.get(delivered.turnId).status, 'completed');
  const history = await bridge.history({ projectId: binding.projectId });
  const turn = history.data.find(value => value.id === delivered.turnId);
  assert.ok(turn.items.some(item => item.type === 'agentMessage' && item.text.trim() === marker));
  const duplicate = await bridge.confirmAndSend({ commandId: draft.commandId });
  assert.equal(duplicate.outcomeDetail, receipt.outcomeDetail);
  const evidence = { threadId: prior.threadId, commandId: draft.commandId, turnId: delivered.turnId,
    result: 'passed', checks: ['durable exact draft', 'desktop controller to real Codex', 'exact assistant reply', 'duplicate returns original receipt'],
    notVerified: ['human native-dialog interaction (test callback only)', 'Antigravity', 'APK'] };
  fs.writeFileSync('artifacts/p0-host-smoke.json', JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  if (!commandId || ['ready', 'queued', 'superseded'].includes(bridge?.ledger.getCommand(commandId)?.state)) awaitingTerminal = false;
  // Lost acknowledgement is not non-delivery. Retain this owner and reconcile
  // the unique exact message instead of killing it or submitting a replacement.
  while (awaitingTerminal && !ownerExited) {
    try {
      const metadata = await client.readThread(prior.threadId);
      const page = await client.listThreadTurns(prior.threadId);
      const matches = page.data.filter(turn => turn.items.some(item => item.type === 'userMessage'
        && item.content.some(content => content.type === 'text' && content.text === submittedPrompt)));
      if (metadata.thread.status.type !== 'active' && matches.length === 1
        && ['completed', 'failed', 'interrupted'].includes(matches[0].status)) awaitingTerminal = false;
    } catch { /* transient observation failure */ }
    if (awaitingTerminal) {
      console.log('Awaiting authoritative reconciliation; no resend.');
      await new Promise(resolve => setTimeout(resolve, 30_000));
    }
  }
  throw error;
} finally {
  client.close(); bridge?.close(); owns = false;
  fs.closeSync(lock); fs.unlinkSync(lockPath);
}
