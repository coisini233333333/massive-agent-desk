import { CodexAppServerClient } from '../src/main/codex-app-server.mjs';

const client = new CodexAppServerClient({ timeoutMs: 45_000 });
try {
  const models = await client.listModels();
  if (!models.length) throw new Error('model/list returned no models');
  console.log(`Codex app-server ready: ${models.length} models; default=${models.find(item => item.isDefault)?.model || 'unknown'}`);
} finally {
  client.close();
}
