import { mkdir, readFile, writeFile, rename, appendFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { PauseError } from './core.mjs';

export async function createState(dataDir) {
  const dir = path.resolve(dataDir, 'state');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = name => path.join(dir, `${name}.json`);
  return {
    dir,
    async get(name) {
      try { return JSON.parse(await readFile(file(name), 'utf8')); }
      catch (error) {
        if (error.code === 'ENOENT') return null;
        throw new PauseError('state_invalid', `État ${name} illisible : contrôle manuel nécessaire.`);
      }
    },
    async put(name, value) {
      await writeFile(`${file(name)}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
      await rename(`${file(name)}.tmp`, file(name));
    },
    async remove(name) {
      try { await unlink(file(name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
    async log(event, details = {}) {
      const line = JSON.stringify({ at: new Date().toISOString(), event, ...details });
      console.log(line);
      await appendFile(path.join(dir, 'events.jsonl'), `${line}\n`, { mode: 0o600 });
    },
  };
}
