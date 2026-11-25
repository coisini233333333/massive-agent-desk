import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

// Capability discovery only: no session/new, session/load, prompt, approval or
// login request is sent. Default mode uses an isolated profile. --check-auth
// asks session/list using the normal profile and outputs no conversation data.
const command = process.env.ANTIGRAVITY_CLI_PATH || path.resolve('.massive-agent/tools/antigravity/agy.exe');
const checkAuth = process.argv.includes('--check-auth');
const profile = path.resolve('.massive-agent/antigravity-capability-probe');
await fs.mkdir(profile, { recursive: true });
const child = spawn(command, ['acp', '--disable-telemetry=true', ...(!checkAuth ? ['--gemini-dir', profile] : [])], {
  windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
});
let diagnosticChunks = 0;
child.stderr.on('data', () => { diagnosticChunks++; });
const lines = readline.createInterface({ input: child.stdout });
try {
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ACP initialize observation timed out; no agent session was created.')), 30_000);
    const finish = (error, value) => { clearTimeout(timer); error ? reject(error) : resolve(value); };
    child.on('error', error => finish(error));
    child.on('exit', code => finish(new Error(`ACP exited before initialize result (${code}).`)));
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== 1) return;
      if (message.error) finish(new Error(`ACP initialize returned protocol error ${message.error.code}.`));
      else finish(null, message.result);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: 1, clientInfo: { name: 'massive-agent-desk-capability-probe', version: '0.1.0' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
    } }) + '\n');
  });
  const evidence = {
    result: 'initialize-passed', protocolVersion: result.protocolVersion,
    agentInfo: result.agentInfo, agentCapabilities: result.agentCapabilities,
    authMethodIds: (result.authMethods || []).map(method => method.id), diagnosticChunks,
    scope: checkAuth ? 'normal profile; read-only session/list; conversation contents omitted' : 'isolated profile; capability discovery only',
    notVerified: ['logged-in account', 'load original Antigravity App conversation', 'user confirmation provenance', 'APK']
  };
  if (checkAuth) {
    evidence.sessionList = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('session/list observation timed out; no session was created.')), 30_000);
      const onLine = line => {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (message.id !== 2) return;
        clearTimeout(timer); lines.off('line', onLine);
        if (message.error) resolve({ result: 'rejected', code: message.error.code,
          reason: /authenticat(?:ion|e).*required|required.*authenticat/i.test(message.error.message || '') ? 'authentication-required' : 'error-details-omitted' });
        else resolve({ result: 'returned', count: message.result?.sessions?.length ?? null });
      };
      lines.on('line', onLine);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/list', params: {} }) + '\n');
    });
  }
  await fs.mkdir('artifacts', { recursive: true });
  await fs.writeFile(checkAuth ? 'artifacts/antigravity-auth-probe.json' : 'artifacts/antigravity-capabilities.json', JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  lines.close();
  child.kill(); // This process has never created or attached an agent session.
}
