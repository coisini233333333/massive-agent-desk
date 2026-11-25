import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DispatchLedger } from './dispatch-ledger.mjs';

function directory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('请选择绝对路径的项目目录。');
  const resolved = fs.realpathSync(value);
  if (!fs.statSync(resolved).isDirectory()) throw new Error('项目路径不是目录。');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// Desktop-only host integration. confirm() is supplied by the main process,
// never by renderer IPC or a model. This is a local click, not biometric proof.
export class BridgeController extends EventEmitter {
  constructor({ databasePath, client, confirm, confirmRequest = async () => null, hasExclusiveOwnership }) {
    super();
    if (!hasExclusiveOwnership()) throw new Error('桌面桥接需要独占应用实例。');
    this.client = client;
    this.confirm = confirm;
    this.confirmRequest = confirmRequest;
    this.pendingRequests = new Map();
    this.runtimeItems = new Map();
    this.requestFlights = new Map();
    this.onRequest = request => {
      if (!this.pendingRequests.has(request.id)) this.pendingRequests.set(request.id, { ...request, status: 'pending' });
      this.changed();
    };
    this.onRuntimeEvent = event => {
      if (['item/started', 'item/completed'].includes(event.method) && event.params?.item?.id) {
        const { threadId, turnId, item } = event.params;
        if (threadId && turnId) this.runtimeItems.set(JSON.stringify([threadId, turnId, item.id]), item);
        if (this.runtimeItems.size > 500) this.runtimeItems.delete(this.runtimeItems.keys().next().value);
      }
      if (event.method === 'serverRequest/resolved') {
        this.pendingRequests.delete(event.params.requestId);
        this.changed();
      }
    };
    this.onExit = () => { this.pendingRequests.clear(); this.runtimeItems.clear(); this.changed(); };
    client.on?.('serverRequest', this.onRequest);
    client.on?.('event', this.onRuntimeEvent);
    client.on?.('exit', this.onExit);
    this.inFlight = new Map();
    this.targetSends = new Set();
    this.bindingReads = new Map();
    const capabilities = new WeakMap();
    this.issue = ticket => {
      const capability = Object.freeze({});
      capabilities.set(capability, ticket);
      return capability;
    };
    const owner = Object.freeze({});
    this.ledger = new DispatchLedger({
      databasePath,
      verifyExclusiveStartupOwner: capability => capability === owner && hasExclusiveOwnership(),
      verifyUserCapability: (capability, action) => {
        const ticket = capabilities.get(capability);
        if (!ticket || !['commandId', 'projectId', 'draftId', 'revision', 'targetThreadId', 'textHash']
          .every(key => ticket[key] === action[key])) return null;
        capabilities.delete(capability);
        return { subjectId: 'local-desktop-user', deviceId: 'local-desktop', proofId: randomUUID() };
      }
    });
    this.ledger.db.exec(`CREATE TABLE IF NOT EXISTS bridge_bindings (
      project_id TEXT PRIMARY KEY, cwd TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      thread_id TEXT NOT NULL, title TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS bridge_tickets (
      command_id TEXT PRIMARY KEY, draft_id TEXT NOT NULL, revision INTEGER NOT NULL,
      UNIQUE(draft_id, revision), FOREIGN KEY(draft_id, revision) REFERENCES draft_revisions(draft_id, revision)
    ) STRICT;`);
    this.ledger.recoverUncertainSendsAfterExclusiveStartup({ ownerCapability: owner });
  }

  close() {
    this.client.off?.('serverRequest', this.onRequest);
    this.client.off?.('event', this.onRuntimeEvent);
    this.client.off?.('exit', this.onExit);
    this.ledger.close();
  }
  changed() { this.emit('changed'); }

  bootstrap() {
    return {
      connected: this.client.ready === true,
      bindings: this.ledger.db.prepare(`SELECT project_id AS projectId, cwd, name,
        thread_id AS threadId, title FROM bridge_bindings ORDER BY name`).all(),
      tickets: this.ledger.db.prepare(`SELECT t.command_id AS commandId, d.project_id AS projectId,
        d.draft_id AS draftId, d.revision, d.text, d.text_hash AS textHash,
        d.target_thread_id AS targetThreadId,
        COALESCE(c.state, CASE WHEN d.revision<>latest.revision OR d.target_thread_id<>b.thread_id
          THEN 'superseded' ELSE 'ready' END) AS state,
        o.outcome_detail AS receipt FROM bridge_tickets t JOIN draft_revisions d
        ON d.draft_id=t.draft_id AND d.revision=t.revision
        JOIN drafts latest ON latest.draft_id=d.draft_id
        JOIN bridge_bindings b ON b.project_id=d.project_id
        LEFT JOIN dispatch_commands c ON c.command_id=t.command_id
        LEFT JOIN outbox o ON o.command_id=t.command_id ORDER BY d.created_at DESC`).all(),
      pendingRequests: [...this.pendingRequests.values()]
    };
  }

  binding(projectId) {
    const binding = this.bootstrap().bindings.find(value => value.projectId === projectId);
    if (!binding) throw new Error('项目尚未绑定已有会话。');
    return binding;
  }

  async listThreads({ cwd, cursor } = {}) {
    return this.client.listThreads({ cwd: fs.realpathSync(directory(cwd)), cursor });
  }

  async bind({ cwd, threadId }) {
    const canonical = directory(cwd);
    const generation = (this.bindingReads.get(canonical) || 0) + 1;
    this.bindingReads.set(canonical, generation);
    const result = await this.client.readThread(threadId);
    if (this.bindingReads.get(canonical) !== generation) throw new Error('已有更新的会话选择，忽略过期绑定结果。');
    if (result.thread.id !== threadId) throw new Error('读取结果与所选会话标识不一致。');
    if (directory(result.thread.cwd) !== canonical) throw new Error('所选会话不属于这个项目目录。');
    const projectId = createHash('sha256').update(canonical).digest('hex');
    const current = this.bootstrap().bindings.find(value => value.projectId === projectId);
    if (current && current.threadId !== threadId) {
      const pending = this.ledger.db.prepare(`SELECT 1 FROM dispatch_commands c JOIN draft_revisions d
        ON c.draft_id=d.draft_id AND c.revision=d.revision
        WHERE d.project_id=? AND c.state IN ('queued','sending','unknown') LIMIT 1`).get(projectId);
      if (pending || [...this.inFlight.values()].some(value => value.projectId === projectId)) {
        throw new Error('此项目有待发送或结果待核对的派工，暂不能改绑。');
      }
    }
    const title = result.thread.name || result.thread.preview?.slice(0, 100) || threadId;
    this.ledger.db.prepare(`INSERT INTO bridge_bindings VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(project_id) DO UPDATE SET thread_id=excluded.thread_id, title=excluded.title`).run(
      projectId, canonical, path.basename(canonical), threadId, title
    );
    this.changed();
    return this.binding(projectId);
  }

  async history({ projectId, cursor }) {
    return this.client.listThreadTurns(this.binding(projectId).threadId, { cursor });
  }

  prepare({ projectId, text, draftId }) {
    const binding = this.binding(projectId);
    if (typeof text !== 'string' || !text.trim() || text.length > 50_000) throw new Error('草案需为 1–50000 字符。');
    const commandId = randomUUID();
    this.ledger.saveDraft({ projectId, targetThreadId: binding.threadId, text, ...(draftId ? { draftId } : {}) }, {
      onPersist: draft => this.ledger.db.prepare('INSERT INTO bridge_tickets VALUES (?, ?, ?)').run(commandId, draft.draftId, draft.revision)
    });
    this.changed();
    return this.ticket(commandId);
  }

  ticket(commandId) {
    const ticket = this.bootstrap().tickets.find(value => value.commandId === commandId);
    if (!ticket) throw new Error('草案不存在。');
    if (this.binding(ticket.projectId).threadId !== ticket.targetThreadId) throw new Error('草案目标已与当前绑定不同，请重新查看原会话。');
    return ticket;
  }

  async confirmAndSend({ commandId }) {
    if (this.inFlight.has(commandId)) return this.inFlight.get(commandId).promise;
    const ticket = this.ticket(commandId);
    const promise = this.#confirmAndSend(ticket).finally(() => this.inFlight.delete(commandId));
    this.inFlight.set(commandId, { projectId: ticket.projectId, promise });
    return promise;
  }

  async resolveRequest({ requestId }) {
    if (this.requestFlights.has(requestId)) return this.requestFlights.get(requestId);
    const request = this.pendingRequests.get(requestId);
    if (!request || request.status !== 'pending') throw new Error('此请求已回答或连接已变化。');
    if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(request.method)) {
      throw new Error('这类请求暂不支持在桥接端作答，请保留原文并在原会话处理。');
    }
    const promise = (async () => {
      const item = this.runtimeItems.get(JSON.stringify([request.params.threadId, request.params.turnId, request.params.itemId]));
      const decision = await this.confirmRequest({ ...request, item });
      if (decision === null) return { cancelled: true };
      if (!['accept', 'decline', 'cancel'].includes(decision)) throw new Error('无效审批决定。');
      if (decision === 'accept' && request.method === 'item/fileChange/requestApproval' && item?.type !== 'fileChange') {
        throw new Error('尚未取得原始文件修改详情，不能批准；请核对原会话。');
      }
      if (this.pendingRequests.get(requestId) !== request) throw new Error('请求已在另一端处理或连接已变化。');
      this.client.replyServerRequest(request.id, { decision });
      request.status = 'answer-sent';
      this.changed();
      return { state: 'answer-sent' };
    })().finally(() => this.requestFlights.delete(requestId));
    this.requestFlights.set(requestId, promise);
    return promise;
  }

  async #confirmAndSend(ticket) {
    const { commandId } = ticket;
    let known = this.ledger.getCommand(commandId);
    if (known?.state === 'delivered') return known;
    if (known && known.state !== 'queued') throw new Error(`当前状态 ${known.state}，禁止重新发送；请核对原会话。`);
    if (!known) {
      if (await this.confirm(Object.freeze({ ...ticket })) !== true) return { state: 'ready', cancelled: true };
      // Recheck after the asynchronous native dialog; a draft may have changed.
      this.ticket(commandId);
      known = this.ledger.confirmAndQueue({
        commandId, draftId: ticket.draftId, revision: ticket.revision, capability: this.issue(ticket)
      });
      this.changed();
    }
    // Failed preflight cannot send, so retain the confirmed queued record.
    await this.client.connect();
    if (this.targetSends.has(ticket.targetThreadId) || this.client.isThreadBusy?.(ticket.targetThreadId)) {
      return { ...this.ledger.getCommand(commandId), waitReason: '原会话仍在执行；此命令未发送，请完成后再操作。' };
    }
    const sending = this.ledger.claimNextForSend({ commandId });
    if (!sending) return this.ledger.getCommand(commandId);
    this.targetSends.add(ticket.targetThreadId);
    this.changed();
    try {
      const receipt = await this.client.continueThread({
        threadId: sending.targetThreadId, runId: commandId, prompt: sending.text
      });
      this.ledger.markDelivered(commandId, JSON.stringify({ threadId: receipt.threadId, turnId: receipt.turnId }));
    } catch (error) {
      if (error.deliveryStatus === 'not-sent') this.ledger.requeueUnsent(commandId);
      else this.ledger.markUnknown(commandId, '发送结果待核对；禁止自动重试。');
    } finally { this.targetSends.delete(ticket.targetThreadId); }
    this.changed();
    return this.ledger.getCommand(commandId);
  }
}
