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
    this.threadToRun = new Map();
    this.activeTurns = new Map();
  }

  async connect() {
    if (this.ready) return;
    if (this.process) throw new Error('Codex app-server 正在启动。');

    this.process = this.spawnImpl(this.command, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env
    });

    const lines = readline.createInterface({ input: this.process.stdout });
    lines.on('line', line => this.#handleLine(line));
    this.process.stderr.on('data', chunk => this.emit('diagnostic', chunk.toString()));
    this.process.on('error', error => this.#failAll(error));
    this.process.on('exit', code => {
      this.ready = false;
      this.#failAll(new Error(`Codex app-server 已退出（code ${code ?? 'unknown'}）。`));
      this.process = null;
      this.emit('exit', code);
    });

    await this.request('initialize', {
      clientInfo: {
        name: 'massive_agent_desk',
        title: 'Massive Agent Desk',
        version: '0.1.0'
      }
    });
    this.notify('initialized', {});
    this.ready = true;
  }

  request(method, params = {}) {
    if (!this.process?.stdin?.writable) return Promise.reject(new Error('Codex app-server 未连接。'));
    const id = this.nextId++;
    this.#send({ method, id, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 请求超时。`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
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

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result || {});
      return;
    }

    const threadId = message.params?.threadId || message.params?.thread?.id || message.params?.turn?.threadId;
    const runId = threadId ? this.threadToRun.get(threadId) : undefined;
    if (runId && message.method === 'turn/completed') this.activeTurns.delete(runId);
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
