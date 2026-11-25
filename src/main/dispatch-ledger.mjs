import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function hash(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} 必须是非空文本。`);
}

function samePayload(row, payload) {
  return row.draft_id === payload.draftId
    && row.revision === payload.revision
    && row.payload_hash === payload.payloadHash;
}

/**
 * Durable, local-only journal for a human-confirmed dispatch.
 *
 * It deliberately has no network, IPC, Antigravity, or Codex dependency. A
 * caller must inject a capability verifier from the trusted desktop/mobile
 * host. A model message such as { actor: 'human' } is not a capability and is
 * rejected. The verifier receives an exact action digest and must return
 * claims with a subjectId and proofId. The verifier is the future integration
 * point for an OS-backed user verification or paired-device proof.
 */
export class DispatchLedger {
  constructor({ databasePath, verifyUserCapability, verifyExclusiveStartupOwner = () => false }) {
    assertText(databasePath, 'databasePath');
    if (typeof verifyUserCapability !== 'function') {
      throw new TypeError('DispatchLedger 需要可信宿主提供 verifyUserCapability。');
    }
    mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.verifyUserCapability = verifyUserCapability;
    this.verifyExclusiveStartupOwner = verifyExclusiveStartupOwner;
    this.#migrate();
  }

  close() { this.db.close(); }

  saveDraft({ projectId, draftId = randomUUID(), targetThreadId, text }, { onPersist = () => {} } = {}) {
    assertText(projectId, 'projectId');
    assertText(draftId, 'draftId');
    assertText(targetThreadId, 'targetThreadId');
    assertText(text, 'text');
    const now = new Date().toISOString();
    const textHash = hash(text);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.db.prepare('SELECT project_id, revision FROM drafts WHERE draft_id = ?').get(draftId);
      if (current && current.project_id !== projectId) throw new Error('草案不能转移到另一项目。');
      if (current) {
        const inFlight = this.db.prepare(`SELECT state FROM outbox WHERE draft_id = ?
          AND state IN ('sending', 'unknown') LIMIT 1`).get(draftId);
        if (inFlight) throw new Error(`草案存在 ${inFlight.state} 的派工，须先人工核对结果后再编辑。`);
        // An unsent prior revision must never remain eligible after editing.
        this.db.prepare("UPDATE outbox SET state = 'superseded', updated_at = ? WHERE draft_id = ? AND state = 'queued'").run(now, draftId);
        this.db.prepare("UPDATE dispatch_commands SET state = 'superseded' WHERE draft_id = ? AND state = 'queued'").run(draftId);
      }
      const revision = (current?.revision ?? 0) + 1;
      this.db.prepare(`INSERT INTO drafts(draft_id, project_id, revision, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(draft_id) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at`).run(
        draftId, projectId, revision, now
      );
      this.db.prepare(`INSERT INTO draft_revisions(draft_id, revision, project_id, target_thread_id, text, text_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(draftId, revision, projectId, targetThreadId, text, textHash, now);
      const draft = { draftId, projectId, targetThreadId, revision, textHash, text };
      // Trusted host hook: write companion records on this same connection
      // before COMMIT. It must not perform network or other external effects.
      onPersist(draft);
      this.db.exec('COMMIT');
      return draft;
    } catch (error) {
      this.#rollback();
      throw error;
    }
  }

  getDraftRevision(draftId, revision) {
    return this.db.prepare(`SELECT draft_id AS draftId, revision, project_id AS projectId,
      target_thread_id AS targetThreadId, text, text_hash AS textHash, created_at AS createdAt
      FROM draft_revisions WHERE draft_id = ? AND revision = ?`).get(draftId, revision) ?? null;
  }

  /**
   * Atomically records a user decision and creates exactly one local outbox
   * record for this immutable draft revision. It does not send anything.
   */
  confirmAndQueue({ commandId, draftId, revision, capability }) {
    assertText(commandId, 'commandId');
    assertText(draftId, 'draftId');
    if (!Number.isSafeInteger(revision) || revision < 1) throw new TypeError('revision 必须是正整数。');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const draft = this.getDraftRevision(draftId, revision);
      if (!draft) throw new Error('待确认的草案版本不存在。');
      const action = Object.freeze({
        kind: 'dispatch-confirmation', commandId, projectId: draft.projectId, draftId, revision,
        targetThreadId: draft.targetThreadId, textHash: draft.textHash,
        // JSON array encoding preserves field boundaries even if an ID itself
        // contains an unusual delimiter character.
        digest: hash(JSON.stringify([
          'dispatch-confirmation', commandId, draft.projectId, draftId, revision,
          draft.targetThreadId, draft.textHash
        ]))
      });
      const payload = { draftId, revision, payloadHash: action.digest };
      const known = this.db.prepare(`SELECT command_id, draft_id, revision, payload_hash, state, outbox_id
        FROM dispatch_commands WHERE command_id = ?`).get(commandId);
      // This is an observation-only idempotent replay. It does not enqueue or
      // reactivate a superseded record, so it needs no fresh user decision.
      if (known) {
        if (!samePayload(known, payload)) throw new Error('commandId 已绑定到不同的草案内容。');
        this.db.exec('COMMIT');
        return this.#receipt(known, true);
      }
      const current = this.db.prepare('SELECT revision FROM drafts WHERE draft_id = ?').get(draftId);
      if (!current || current.revision !== revision) throw new Error('草案已编辑；只能确认当前版本。');
      // Do not accept an actor name, a model assertion, or ambient state. The
      // trusted host must verify a capability scoped to this exact immutable
      // revision; this module cannot establish real-world human identity.
      const claims = this.verifyUserCapability(capability, action);
      if (!claims || typeof claims.subjectId !== 'string' || !claims.subjectId || typeof claims.proofId !== 'string' || !claims.proofId) {
        throw new Error('缺少可信宿主签发的、与该版本绑定的用户确认能力。');
      }
      const existing = this.db.prepare(`SELECT command_id FROM dispatch_commands WHERE draft_id = ? AND revision = ?`).get(draftId, revision);
      if (existing) throw new Error('该草案版本已经绑定另一条派工命令。');

      const now = new Date().toISOString();
      const outboxId = randomUUID();
      this.db.prepare(`INSERT INTO outbox(outbox_id, command_id, draft_id, revision, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'queued', ?, ?)`).run(outboxId, commandId, draftId, revision, now, now);
      this.db.prepare(`INSERT INTO dispatch_commands(command_id, draft_id, revision, payload_hash, state, outbox_id, confirmed_at,
        confirmation_subject_hash, confirmation_device_hash, confirmation_proof_hash)
        VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`).run(
        commandId, draftId, revision, payload.payloadHash, outboxId, now,
        hash(claims.subjectId), claims.deviceId ? hash(String(claims.deviceId)) : null, hash(claims.proofId)
      );
      this.db.exec('COMMIT');
      return { commandId, outboxId, draftId, revision, state: 'queued', idempotent: false };
    } catch (error) {
      this.#rollback();
      throw error;
    }
  }

  /** Claims one queued record. The caller must persist delivery evidence with
   * markDelivered or markUnknown; a process restart converts sending to unknown. */
  claimNextForSend({ commandId = null } = {}) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const outbox = this.db.prepare(`SELECT o.outbox_id, o.command_id, o.draft_id, o.revision,
        d.project_id, d.target_thread_id, d.text, d.text_hash
        FROM outbox o JOIN draft_revisions d ON d.draft_id = o.draft_id AND d.revision = o.revision
        WHERE o.state = 'queued' AND (? IS NULL OR o.command_id = ?)
        ORDER BY o.created_at, o.outbox_id LIMIT 1`).get(commandId, commandId);
      if (!outbox) { this.db.exec('COMMIT'); return null; }
      const now = new Date().toISOString();
      this.db.prepare("UPDATE outbox SET state = 'sending', updated_at = ? WHERE outbox_id = ? AND state = 'queued'").run(now, outbox.outbox_id);
      this.db.prepare("UPDATE dispatch_commands SET state = 'sending' WHERE command_id = ?").run(outbox.command_id);
      this.db.exec('COMMIT');
      return {
        outboxId: outbox.outbox_id, commandId: outbox.command_id, draftId: outbox.draft_id,
        revision: outbox.revision, projectId: outbox.project_id, targetThreadId: outbox.target_thread_id,
        text: outbox.text, textHash: outbox.text_hash
      };
    } catch (error) {
      this.#rollback();
      throw error;
    }
  }

  markDelivered(commandId, deliveryReceipt) {
    assertText(commandId, 'commandId');
    assertText(deliveryReceipt, 'deliveryReceipt');
    return this.#setOutcome(commandId, 'delivered', deliveryReceipt);
  }

  markUnknown(commandId, detail = 'delivery outcome unknown') {
    assertText(commandId, 'commandId');
    assertText(detail, 'detail');
    return this.#setOutcome(commandId, 'unknown', detail);
  }

  // Internal host operation only for a transport's proven pre-send rejection;
  // never accepts unknown or delivered commands and is not exposed over IPC.
  requeueUnsent(commandId) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const command = this.getCommand(commandId);
      if (command?.state !== 'sending') throw new Error('只有确定未发送的 sending 命令可以退回队列。');
      this.db.prepare("UPDATE outbox SET state='queued', outcome_detail=NULL, updated_at=? WHERE command_id=?").run(new Date().toISOString(), commandId);
      this.db.prepare("UPDATE dispatch_commands SET state='queued' WHERE command_id=?").run(commandId);
      this.db.exec('COMMIT');
      return this.getCommand(commandId);
    } catch (error) { this.#rollback(); throw error; }
  }

  /**
   * Call only after the desktop host has established exclusive ownership of
   * this database. Opening a second live connection never calls this method.
   */
  recoverUncertainSendsAfterExclusiveStartup({ ownerCapability }) {
    if (this.verifyExclusiveStartupOwner(ownerCapability) !== true) {
      throw new Error('恢复 sending 记录需要可信宿主的独占启动所有者能力。');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const now = new Date().toISOString();
      const result = this.db.prepare("UPDATE outbox SET state = 'unknown', updated_at = ?, outcome_detail = 'recovered after process stop' WHERE state = 'sending'").run(now);
      this.db.prepare("UPDATE dispatch_commands SET state = 'unknown' WHERE command_id IN (SELECT command_id FROM outbox WHERE state = 'unknown')").run();
      this.db.exec('COMMIT');
      return Number(result.changes ?? 0);
    } catch (error) {
      this.#rollback();
      throw error;
    }
  }

  listReconciliationNeeded() {
    return this.db.prepare(`SELECT o.command_id AS commandId, o.outbox_id AS outboxId, o.draft_id AS draftId,
      o.revision, o.state, o.outcome_detail AS outcomeDetail, d.target_thread_id AS targetThreadId, d.text_hash AS textHash
      FROM outbox o JOIN draft_revisions d ON d.draft_id = o.draft_id AND d.revision = o.revision
      WHERE o.state = 'unknown' ORDER BY o.updated_at`).all();
  }

  getCommand(commandId) {
    return this.db.prepare(`SELECT c.command_id AS commandId, c.draft_id AS draftId, c.revision, c.state,
      c.outbox_id AS outboxId, o.outcome_detail AS outcomeDetail
      FROM dispatch_commands c JOIN outbox o ON o.outbox_id = c.outbox_id WHERE c.command_id = ?`).get(commandId) ?? null;
  }

  #setOutcome(commandId, state, detail) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const command = this.db.prepare('SELECT outbox_id, state FROM dispatch_commands WHERE command_id = ?').get(commandId);
      if (!command) throw new Error('派工命令不存在。');
      if (command.state === state) {
        const existing = this.db.prepare('SELECT outcome_detail FROM outbox WHERE outbox_id = ?').get(command.outbox_id);
        if (existing?.outcome_detail === detail) { this.db.exec('COMMIT'); return this.getCommand(commandId); }
        throw new Error(`派工命令已经是 ${state}，但回执内容不一致。`);
      }
      if (command.state !== 'sending') throw new Error(`派工命令当前为 ${command.state}，不能写入 ${state}。`);
      const now = new Date().toISOString();
      this.db.prepare('UPDATE outbox SET state = ?, updated_at = ?, outcome_detail = ? WHERE outbox_id = ?').run(state, now, detail, command.outbox_id);
      this.db.prepare('UPDATE dispatch_commands SET state = ? WHERE command_id = ?').run(state, commandId);
      this.db.exec('COMMIT');
      return this.getCommand(commandId);
    } catch (error) {
      this.#rollback();
      throw error;
    }
  }

  #receipt(row, idempotent) {
    return { commandId: row.command_id, outboxId: row.outbox_id, draftId: row.draft_id, revision: row.revision, state: row.state, idempotent };
  }

  #rollback() { try { this.db.exec('ROLLBACK'); } catch { /* no active transaction */ } }

  #migrate() {
    this.db.exec(`PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS drafts (
        draft_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS draft_revisions (
        draft_id TEXT NOT NULL, revision INTEGER NOT NULL, project_id TEXT NOT NULL,
        target_thread_id TEXT NOT NULL, text TEXT NOT NULL, text_hash TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(draft_id, revision), FOREIGN KEY(draft_id) REFERENCES drafts(draft_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS outbox (
        outbox_id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE, draft_id TEXT NOT NULL, revision INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued', 'sending', 'delivered', 'unknown', 'superseded')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, outcome_detail TEXT,
        UNIQUE(draft_id, revision), FOREIGN KEY(draft_id, revision) REFERENCES draft_revisions(draft_id, revision)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS dispatch_commands (
        command_id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, revision INTEGER NOT NULL, payload_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued', 'sending', 'delivered', 'unknown', 'superseded')),
        outbox_id TEXT NOT NULL UNIQUE, confirmed_at TEXT NOT NULL,
        confirmation_subject_hash TEXT NOT NULL, confirmation_device_hash TEXT, confirmation_proof_hash TEXT NOT NULL UNIQUE,
        UNIQUE(draft_id, revision), FOREIGN KEY(outbox_id) REFERENCES outbox(outbox_id)
      ) STRICT;`);
  }
}
