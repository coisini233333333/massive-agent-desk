import fs from 'node:fs/promises';
import path from 'node:path';

export class ConfigStore {
  constructor(root) {
    this.file = path.join(root, 'orchestrator.json');
  }

  async read() {
    try {
      return JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async write(value) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }
}
