import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const entry = fileURLToPath(new URL('../src/index.mjs', import.meta.url));

async function fixture(t) {
  const dir = await mkdtemp(path.join(process.env.TEST_TMPDIR || os.tmpdir(), 'wiki-standby-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, DATA_DIR: dir };
  delete env.PACK_OPENING_ENABLED;
  return { dir, env };
}

test('once et resume restent sans navigateur quand les paquets sont en veille', async t => {
  const { dir, env } = await fixture(t);
  const result = await execute(process.execPath, [entry, 'once'], { env, windowsHide: true, timeout: 10_000 });
  assert.equal(JSON.parse(result.stdout).event, 'pack_opening_disabled');
  await execute(process.execPath, [entry, 'resume'], { env, windowsHide: true, timeout: 10_000 });
  const status = await execute(process.execPath, [entry, 'status'], { env, windowsHide: true, timeout: 10_000 });
  const data = JSON.parse(status.stdout);
  assert.equal(data.packOpeningEnabled, false);
  assert.equal(data.schedule, null);
  assert.equal(data.lastRun, null);
  assert.deepEqual(await readdir(dir), ['state']);
  assert.deepEqual(await readdir(path.join(dir, 'state')), ['events.jsonl']);
});

test('run reste en veille sans créer de profil ni programmer une ouverture', { timeout: 10_000 }, async t => {
  const { dir, env } = await fixture(t);
  const child = spawn(process.execPath, [entry, 'run'], {
    env: { ...env, PACK_OPENING_ENABLED: 'false' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
  });
  const [output] = await once(child.stdout, 'data');
  assert.equal(JSON.parse(output.toString()).event, 'pack_opening_disabled');
  assert.equal(child.exitCode, null);
  assert.deepEqual(await readdir(dir), ['state']);
  assert.ok((await readdir(path.join(dir, 'state'))).every(name => name === 'events.jsonl'));
});
