import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

export function resolveCodexCommand() {
  if (process.env.CODEX_CLI_PATH) return process.env.CODEX_CLI_PATH;
  if (process.platform === 'win32') {
    const binRoot = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
    try {
      const candidates = fs.readdirSync(binRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => path.join(binRoot, entry.name, 'codex.exe'))
        .filter(candidate => fs.existsSync(candidate))
        .map(candidate => ({ candidate, modified: fs.statSync(candidate).mtimeMs }))
        .sort((a, b) => b.modified - a.modified);
      if (candidates[0]) return candidates[0].candidate;
    } catch {
      // Fall through to PATH resolution.
    }
  }
  return 'codex';
}

export class CodexAppServerClient extends EventEmitter {
  constructor({ command = resolveCodexCommand(), spawnImpl = spawn, timeoutMs = 30_000 } = {}) {
    super();
    this.command = command;
    this.spawnImpl = spawnImpl;
    this.timeoutMs = timeoutMs;
    this.process = null;
    this.pending = new Map();
    this.nextId = 1;
    this.ready = false;
    this.connecting = null;
    this.threadToRun = new Map();
    this.activeTurns = new Map();
  }

  connect() {
    if (this.ready) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = this.#connect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async #connect() {
    if (this.process) throw new Error('Codex app-server 正在启动。');

    const child = this.spawnImpl(this.command, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env
    });
    this.process = child;

    const lines = readline.createInterface({ input: this.process.stdout });
    lines.on('line', line => this.#handleLine(line));
    this.process.stderr.on('data', chunk => this.emit('diagnostic', chunk.toString()));
    child.on('error', error => {
      if (this.process !== child) return;
      this.ready = false;
      this.process = null;
      this.#failAll(error);
      this.emit('exit', null);
    });
    child.on('exit', code => {
      if (this.process !== child) return;
      this.ready = false;
      this.#failAll(new Error(`Codex app-server 已退出（code ${code ?? 'unknown'}）。`));
      this.process = null;
      this.emit('exit', code);
    });

    try {
      await this.request('initialize', {
        clientInfo: {
          name: 'massive_agent_desk',
          title: 'Massive Agent Desk',
          version: '0.1.0'
        }
      });
      this.notify('initialized', {});
      this.ready = true;
    } catch (error) {
      if (this.process === child) {
        this.process = null;
        this.ready = false;
        this.#failAll(error);
        child.kill();
        this.emit('exit', null);
      }
      throw error;
    }
  }

  request(method, params = {}) {
    if (!this.process?.stdin?.writable) return Promise.reject(new Error('Codex app-server 未连接。'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 请求超时。`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.#send({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this.#send({ method, params });
  }

  async listModels() {
    await this.connect();
    const result = await this.request('model/list', { limit: 50, includeHidden: false });
    return result.data || [];
  }

  async listThreads({ cwd, cursor, limit = 30 } = {}) {
    await this.connect();
    return this.request('thread/list', { cwd, cursor, limit, sortKey: 'updated_at' });
  }

  async readThread(threadId) {
    await this.connect();
    return this.request('thread/read', { threadId, includeTurns: false });
  }

  async listThreadTurns(threadId, { cursor, limit = 20 } = {}) {
    await this.connect();
    return this.request('thread/turns/list', {
      threadId, cursor, limit, sortDirection: 'desc', itemsView: 'full'
    });
  }

  // This is a transport primitive, not a dispatch approval. The bridge must
  // validate the human-confirmed draft before calling it.
  async continueThread({ threadId, runId, prompt }) {
    if (!threadId || !runId || typeof prompt !== 'string' || !prompt.trim()) {
      throw new Error('续接需要明确的 threadId、runId 和消息原文。');
    }
    if (this.threadToRun.has(threadId) || this.activeTurns.has(runId)) {
      throw new Error('该会话或运行已有本客户端的活动回合。');
    }
    // Reserve before awaiting I/O so concurrent callers cannot dispatch twice.
    this.threadToRun.set(threadId, runId);
    this.activeTurns.set(runId, { threadId });
    let turnAttempted = false;
    try {
      await this.connect();
      const resumed = await this.request('thread/resume', { threadId });
      if (resumed.thread?.id !== threadId) throw new Error('续接返回了不同的会话标识。');
      if (resumed.thread.status?.type === 'active') throw new Error('原会话正在执行，请等待完成。');
      // No model, effort, cwd, sandbox or approval overrides: retain the
      // effective configuration returned by the original thread.
      turnAttempted = true;
      const result = await this.request('turn/start', {
        threadId, input: [{ type: 'text', text: prompt }]
      });
      if (!result.turn?.id) throw new Error('Codex 未返回 turn id；发送结果需核对，不能自动重试。');
      const turnId = result.turn.id;
      // Completion may arrive before the turn/start response.
      if (this.activeTurns.has(runId)) this.activeTurns.set(runId, { threadId, turnId });
      return { threadId, runId, turnId, model: resumed.model, effort: resumed.reasoningEffort };
    } catch (error) {
      if (turnAttempted && !error.rpcError) {
        // A lost response is not proof of non-delivery. Keep the reservation
        // until completion/reconciliation instead of allowing a blind resend.
        if (this.activeTurns.has(runId)) this.activeTurns.set(runId, { threadId, outcomeUnknown: true });
        error.deliveryStatus = 'unknown';
      } else {
        this.threadToRun.delete(threadId);
        this.activeTurns.delete(runId);
      }
      throw error;
    }
  }

  async startAgent(run) {
    await this.connect();
    const threadResult = await this.request('thread/start', {
      model: run.model,
      cwd: run.cwd,
      serviceName: 'massive_agent_desk'
    });
    const threadId = threadResult.thread?.id;
    if (!threadId) throw new Error('Codex 未返回 thread id。');
    this.threadToRun.set(threadId, run.runId);

    const turnResult = await this.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: run.prompt }],
      cwd: run.cwd,
      model: run.model,
      effort: run.effort
    });
    const turnId = turnResult.turn?.id;
    this.activeTurns.set(run.runId, { threadId, turnId });
    return { runId: run.runId, threadId, turnId };
  }

  async interrupt(runId) {
    const active = this.activeTurns.get(runId);
    if (!active?.threadId || !active?.turnId) return;
    await this.request('turn/interrupt', active);
  }

  close() {
    if (this.process && !this.process.killed) this.process.kill();
  }

  #send(message) {
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit('diagnostic', `无法解析 app-server 消息：${line}`);
      return;
    }

    if (message.id !== undefined && message.method) {
      // Server-originated approvals/tool-input requests are not RPC replies.
      // Never synthesize a user's decision here.
      this.emit('serverRequest', message);
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message || JSON.stringify(message.error));
        error.rpcError = true;
        error.code = message.error.code;
        pending.reject(error);
      }
      else pending.resolve(message.result || {});
      return;
    }

    const threadId = message.params?.threadId || message.params?.thread?.id || message.params?.turn?.threadId;
    const runId = threadId ? this.threadToRun.get(threadId) : undefined;
    if (runId && message.method === 'turn/completed') {
      this.activeTurns.delete(runId);
      this.threadToRun.delete(threadId);
    }
    this.emit('event', { ...message, runId, threadId });
  }

  #failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
