import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { DispatchLedger } from '../src/main/dispatch-ledger.mjs';

function harness() {
  const databasePath = path.join(mkdtempSync(path.join(os.tmpdir(), 'mad-ledger-')), 'ledger.sqlite');
  const issued = new WeakMap();
  const owners = new WeakSet();
  const issue = scope => { const capability = Object.freeze({}); issued.set(capability, scope); return capability; };
  const verifiedActions = [];
  const open = () => new DispatchLedger({ databasePath, verifyUserCapability: (capability, requested) => {
    verifiedActions.push(requested);
    const scope = issued.get(capability);
    if (!scope || scope.draftId !== requested.draftId || scope.revision !== requested.revision || scope.textHash !== requested.textHash
      || scope.commandId !== requested.commandId || scope.digest !== requested.digest) return null;
    return { subjectId: 'user-1', deviceId: 'paired-phone-1', proofId: scope.proofId ?? `proof-${requested.digest}` };
  }, verifyExclusiveStartupOwner: capability => owners.has(capability) });
  const issueOwner = () => { const capability = Object.freeze({}); owners.add(capability); return capability; };
  return { open, issue, issueOwner, verifiedActions };
}

function draft(ledger, text = '请实现并验证 P0') {
  return ledger.saveDraft({ projectId: 'project-a', draftId: 'draft-a', targetThreadId: 'idea-thread', text });
}

function actionDigest(commandId, saved) {
  return createHash('sha256').update(JSON.stringify([
    'dispatch-confirmation', commandId, saved.projectId, saved.draftId, saved.revision,
    saved.targetThreadId, saved.textHash
  ]), 'utf8').digest('hex');
}

function capability(h, saved, commandId, proofId) {
  return h.issue({ draftId: saved.draftId, revision: saved.revision, textHash: saved.textHash, commandId,
    digest: actionDigest(commandId, saved), proofId });
}

test('confirmation and outbox are idempotent for an immutable revision', () => {
  const h = harness(); const ledger = h.open(); const saved = draft(ledger);
  const first = ledger.confirmAndQueue({ commandId: 'cmd-a', draftId: saved.draftId, revision: saved.revision, capability: capability(h, saved, 'cmd-a') });
  const again = ledger.confirmAndQueue({ commandId: 'cmd-a', draftId: saved.draftId, revision: saved.revision, capability: capability(h, saved, 'cmd-a') });
  assert.equal(first.state, 'queued'); assert.equal(again.idempotent, true); assert.equal(first.outboxId, again.outboxId);
  assert.deepEqual(ledger.claimNextForSend(), {
    outboxId: first.outboxId, commandId: 'cmd-a', draftId: 'draft-a', revision: 1,
    projectId: 'project-a', targetThreadId: 'idea-thread', text: '请实现并验证 P0', textHash: saved.textHash
  });
  assert.equal(ledger.claimNextForSend(), null); ledger.close();
});

test('revision changes require a new confirmation and old confirmation cannot be reused', () => {
  const h = harness(); const ledger = h.open(); const r1 = draft(ledger, '原文');
  const oldCapability = capability(h, r1, 'cmd-r1');
  ledger.confirmAndQueue({ commandId: 'cmd-r1', draftId: 'draft-a', revision: r1.revision, capability: oldCapability });
  const r2 = draft(ledger, '修改后的原文');
  assert.equal(r2.revision, 2);
  assert.throws(() => ledger.confirmAndQueue({ commandId: 'cmd-r2', draftId: 'draft-a', revision: r2.revision, capability: oldCapability }), /可信宿主/);
  const next = ledger.confirmAndQueue({ commandId: 'cmd-r2', draftId: 'draft-a', revision: r2.revision, capability: capability(h, r2, 'cmd-r2') });
  assert.equal(next.revision, 2); ledger.close();
});

test('a different command cannot duplicate an already queued draft revision', () => {
  const h = harness(); const ledger = h.open(); const r = draft(ledger);
  ledger.confirmAndQueue({ commandId: 'cmd-a', draftId: 'draft-a', revision: r.revision, capability: capability(h, r, 'cmd-a') });
  assert.throws(() => ledger.confirmAndQueue({ commandId: 'cmd-b', draftId: 'draft-a', revision: r.revision, capability: capability(h, r, 'cmd-b') }), /已经绑定/);
  assert.throws(() => ledger.confirmAndQueue({ commandId: 'cmd-a', draftId: 'draft-a', revision: 99, capability: capability(h, r, 'cmd-a') }), /不存在|不同/);
  ledger.close();
});

test('an apparent model claim is not a user confirmation capability', () => {
  const h = harness(); const ledger = h.open(); const r = draft(ledger);
  assert.throws(() => ledger.confirmAndQueue({ commandId: 'cmd-a', draftId: 'draft-a', revision: r.revision, capability: { actor: 'human', modelSays: 'confirmed' } }), /可信宿主/);
  ledger.close();
});

test('trusted host receives a canonical action tied to the exact command and revision', () => {
  const h = harness(); const ledger = h.open(); const r = draft(ledger);
  ledger.confirmAndQueue({ commandId: 'cmd-bound', draftId: r.draftId, revision: r.revision, capability: capability(h, r, 'cmd-bound') });
  const action = h.verifiedActions.at(-1);
  assert.deepEqual(Object.keys(action).sort(), ['commandId', 'digest', 'draftId', 'kind', 'projectId', 'revision', 'targetThreadId', 'textHash']);
  assert.equal(action.commandId, 'cmd-bound');
  assert.equal(action.draftId, r.draftId);
  assert.equal(action.revision, r.revision);
  assert.match(action.digest, /^[0-9a-f]{64}$/);
  ledger.close();
});

test('two ledger connections contend safely and create one outbox entry', () => {
  const h = harness(); const one = h.open(); const two = h.open(); const r = draft(one);
  const first = one.confirmAndQueue({ commandId: 'cmd-a', draftId: 'draft-a', revision: r.revision, capability: capability(h, r, 'cmd-a') });
  assert.throws(() => two.confirmAndQueue({ commandId: 'cmd-b', draftId: 'draft-a', revision: r.revision, capability: capability(h, r, 'cmd-b') }), /已经绑定/);
  assert.equal(two.getCommand('cmd-a').outboxId, first.outboxId); one.close(); two.close();
});

test('crash recovery converts sending to unknown and never auto-retries it', () => {
  const h = harness(); const first = h.open(); const r = draft(first);
  first.confirmAndQueue({ commandId: 'cmd-a', draftId: 'draft-a', revision: r.revision, capability: capability(h, r, 'cmd-a') });
  assert.equal(first.claimNextForSend().commandId, 'cmd-a'); first.close();
  const recovered = h.open();
  // Merely opening another connection cannot invalidate a live sender.
  assert.equal(recovered.getCommand('cmd-a').state, 'sending');
  assert.throws(() => recovered.recoverUncertainSendsAfterExclusiveStartup({ ownerCapability: {} }), /独占/);
  recovered.recoverUncertainSendsAfterExclusiveStartup({ ownerCapability: h.issueOwner() });
  assert.equal(recovered.getCommand('cmd-a').state, 'unknown');
  assert.equal(recovered.claimNextForSend(), null);
  assert.deepEqual(recovered.listReconciliationNeeded().map(row => row.commandId), ['cmd-a']);
  recovered.close();
});

test('editing supersedes a queued revision and a stale unconfirmed revision is rejected', () => {
  const h = harness(); const ledger = h.open(); const r1 = draft(ledger, 'old text');
  const r2 = draft(ledger, 'new text');
  assert.throws(() => ledger.confirmAndQueue({ commandId: 'stale', draftId: 'draft-a', revision: r1.revision, capability: capability(h, r1) }), /只能确认当前版本/);
  ledger.confirmAndQueue({ commandId: 'current', draftId: 'draft-a', revision: r2.revision, capability: capability(h, r2, 'current') });
  const r3 = draft(ledger, 'newest text');
  assert.equal(r3.revision, 3);
  assert.equal(ledger.getCommand('current').state, 'superseded');
  assert.equal(ledger.claimNextForSend(), null);
  ledger.close();
});

test('editing a sending or unknown revision is blocked until manual reconciliation', () => {
  const h = harness(); const ledger = h.open(); const r = draft(ledger);
  ledger.confirmAndQueue({ commandId: 'cmd-a', draftId: 'draft-a', revision: r.revision, capability: capability(h, r, 'cmd-a') });
  ledger.claimNextForSend();
  assert.throws(() => draft(ledger, 'edited'), /sending/);
  ledger.markUnknown('cmd-a');
  assert.throws(() => draft(ledger, 'edited'), /unknown/);
  ledger.close();
});

test('delivery receipt is idempotent only when the receipt matches', () => {
  const h = harness(); const ledger = h.open(); const r = draft(ledger);
  ledger.confirmAndQueue({ commandId: 'cmd-a', draftId: 'draft-a', revision: r.revision, capability: capability(h, r, 'cmd-a') });
  ledger.claimNextForSend();
  assert.equal(ledger.markDelivered('cmd-a', 'external-turn-7').state, 'delivered');
  assert.equal(ledger.markDelivered('cmd-a', 'external-turn-7').state, 'delivered');
  assert.throws(() => ledger.markDelivered('cmd-a', 'external-turn-other'), /不一致/);
  ledger.close();
});

test('a proof cannot be replayed for a different dispatch action', () => {
  const h = harness(); const ledger = h.open(); const first = draft(ledger, 'first');
  ledger.confirmAndQueue({ commandId: 'cmd-1', draftId: first.draftId, revision: first.revision, capability: capability(h, first, 'cmd-1', 'same-proof') });
  const second = ledger.saveDraft({ projectId: 'project-a', draftId: 'draft-b', targetThreadId: 'idea-thread', text: 'second' });
  assert.throws(() => ledger.confirmAndQueue({ commandId: 'cmd-2', draftId: second.draftId, revision: second.revision, capability: capability(h, second, 'cmd-2', 'same-proof') }), /UNIQUE|unique/i);
  ledger.close();
});
