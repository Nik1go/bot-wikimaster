import { readFile, writeFile, link, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { PauseError } from './core.mjs';

export async function readCollectionLock(dataDir) {
  const file = path.resolve(dataDir, 'collection.lock');
  let raw;
  try { raw = await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { path: file, exists: false }; throw error; }
  let owner;
  try { owner = JSON.parse(raw); } catch { return { path: file, exists: true, readable: false }; }
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)) return { path: file, exists: true, readable: false };
  return {
    path: file, exists: true, readable: true,
    backend: owner.backend === 'flock' ? 'flock' : 'file',
    ownerId: typeof owner.ownerId === 'string' ? owner.ownerId : null,
    pid: Number.isInteger(owner.pid) ? owner.pid : null,
    hostname: typeof owner.hostname === 'string' ? owner.hostname : null,
    command: typeof owner.command === 'string' ? owner.command : null,
    at: typeof owner.at === 'string' ? owner.at : null,
  };
}

export async function clearCollectionLock(dataDir) {
  const previous = await readCollectionLock(dataDir);
  let removed = false;
  try { await unlink(previous.path); removed = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { removed, previous };
}

export async function acquireCollectionLock(dataDir, { command, flockHeld = false, log = async () => {} }) {
  const file = path.resolve(dataDir, 'collection.lock');
  const owner = { backend: flockHeld ? 'flock' : 'file', ownerId: randomUUID(), pid: process.pid, hostname: hostname(), at: new Date().toISOString(), command };
  const temporary = `${file}.${owner.ownerId}.tmp`;
  // Publish complete metadata atomically. A kill cannot leave an empty lock
  // whose origin is impossible to distinguish from a legacy active process.
  await writeFile(temporary, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
  try {
    try { await link(temporary, file); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = await readCollectionLock(dataDir);
      if (!flockHeld || previous.backend !== 'flock') {
        const detail = `${previous.command || 'commande inconnue'}, ${previous.hostname || 'ancien conteneur'}, ${previous.at || 'date inconnue'}`;
        throw new PauseError('collection_locked', `Verrou présent dans ${file} (${detail}). Arrêter les parcours, puis collection-unlock --stopped avec le service wiki-collection.`);
      }
      // fd 9 owns the system lock. Rename without an absence window, keeping
      // older file-lock-only instances from acquiring the metadata path.
      await rename(temporary, file);
      await log('collection_lock_recovered', { previous, message: `Ancien arrêt interrompu détecté dans ${file} ; verrou Linux acquis, reprise autorisée.` });
    }
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  let released = false;
  return {
    owner,
    async release() {
      if (released) return;
      released = true;
      const current = await readCollectionLock(dataDir);
      if (current.ownerId === owner.ownerId) await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    },
  };
}
