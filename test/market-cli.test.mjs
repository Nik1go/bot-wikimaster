import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createState } from '../src/state.mjs';
import { marketDemo } from '../src/market-demo.mjs';
import { readMarketEvents, renderMarketReport } from '../src/market-report.mjs';

const execute = promisify(execFile);
const entry = fileURLToPath(new URL('../src/index.mjs', import.meta.url));
async function fixture(t) {
  const dir = await mkdtemp(path.join(process.env.TEST_TMPDIR || os.tmpdir(), 'wiki-market-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, DATA_DIR: dir, MARKET_MODE: 'simulation', MARKET_LIVE_ENABLED: 'false' };
  const run = (...args) => execute(process.execPath, [entry, ...args], { env, windowsHide: true, timeout: 10_000 });
  const store = await createState(path.join(dir, 'market', 'simulation'));
  return { dir, env, run, store };
}

test('démo hors ligne : classement, suivi, arrêt au plafond et aucune transaction annoncée', async () => {
  const { events, report } = await marketDemo();
  assert.ok(events.some(e => e.event === 'candidate_selected' && e.title === 'Carte Démo B'));
  assert.ok(events.some(e => e.event === 'ceiling_reached'));
  assert.ok(events.some(e => e.event === 'simulation_finished'));
  assert.ok(!events.some(e => ['bid_confirmed', 'auction_won'].includes(e.event)));
  assert.ok(report.includes('13:00:00'));
});

test('commandes de rapport, état et reprise disponibles sans navigateur', async t => {
  const { dir, run } = await fixture(t);
  const status = JSON.parse((await run('market-status')).stdout);
  assert.equal(status.mode, 'simulation');
  assert.equal(status.maxPerCard, 3500);
  await run('market-resume');
  assert.ok((await run('market-report')).stdout.includes('market_resumed'));
  assert.deepEqual(await readdir(dir), ['market']);
});

test('pause persistante : market-once refuse avant toute initialisation de Chromium', async t => {
  const { dir, run, store } = await fixture(t);
  await store.put('paused', { code: 'automation_limit', message: 'Blocage du site.' });
  await assert.rejects(run('market-once'), error => error.code === 1 && error.stdout.includes('automation_limit'));
  assert.deepEqual(await readdir(dir), ['market']);
  assert.equal((await store.get('paused')).code, 'automation_limit');
});

test('resume ne supprime ni une mise incertaine ni sa pause', async t => {
  const { run, store } = await fixture(t);
  await store.put('book', { pending: { auctionId: 'pending', amount: 100 } });
  await store.put('paused', { code: 'network_error' });
  await assert.rejects(run('market-resume'), error => error.stderr.includes('bid_confirmation_pending'));
  assert.equal((await store.get('paused')).code, 'network_error');
  assert.equal((await store.get('book')).pending.amount, 100);
});

test('verrou concurrent : refus sans écrasement ; récupération explicitement après arrêt', async t => {
  const { dir, run } = await fixture(t);
  const lockPath = path.join(dir, 'market', 'simulation', 'run.lock');
  await writeFile(lockPath, 'active');
  await assert.rejects(run('market-resume'), error => error.stderr.includes('market_locked'));
  await assert.rejects(run('market-unlock'), error => error.stderr.includes('confirmation_required'));
  await run('market-unlock', '--stopped');
  await run('market-resume');
});

test('journal tronqué et titre non fiable : rapport lisible et sans injection de tableau', async t => {
  const { store } = await fixture(t);
  const rows = [{ at: '2026-10-31T12:00:00Z', event: 'candidate_selected', title: 'Carte | ligne\nsuivante', message: 'Choix.' }];
  await writeFile(path.join(store.dir, 'events.jsonl'), JSON.stringify(rows[0]) + '\n{"broken"');
  const events = await readMarketEvents(store.dir);
  assert.equal(events.length, 1);
  assert.ok(renderMarketReport(events).includes('Carte   ligne suivante'));
});
