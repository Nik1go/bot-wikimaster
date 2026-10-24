import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readConfig, parseInventory, nextAllowedStart, runBatch, PauseError } from '../src/core.mjs';
import { createState } from '../src/state.mjs';

const config = readConfig({});
const quiet = { sleep: async () => {}, log: async () => {} };

test('stock normal et stock nul, avec espaces et sauts de ligne', () => {
  assert.deepEqual(parseInventory('4  / 10\npaquets disponibles'), { available: 4, capacity: 10 });
  assert.equal(parseInventory('0 / 10 paquets disponibles').available, 0);
});

test('une interface inconnue ou un compteur incohérent arrête la collecte', () => {
  assert.throws(() => parseInventory('Acheter des paquets'), PauseError);
  assert.throws(() => parseInventory('12 / 10 paquets disponibles'), PauseError);
});

test('configuration : fréquence minimale horaire et pauses strictement positives', () => {
  assert.equal(config.intervalMs, 3_600_000);
  assert.throws(() => readConfig({ INTERVAL_MINUTES: '5' }));
  assert.throws(() => readConfig({ BETWEEN_PACKS_SECONDS: '0' }));
  assert.throws(() => readConfig({ MAX_PACKS_PER_SESSION: '200' }));
  assert.throws(() => readConfig({ INTERVAL_MINUTES: '60junk' }));
});

test('redémarrer le conteneur ne permet pas de relancer une session avant une heure', () => {
  const start = Date.parse('2026-10-24T16:00:00Z');
  assert.equal(nextAllowedStart(new Date(start).toISOString(), config.intervalMs, start + 10_000), start + 3_600_000);
  assert.equal(nextAllowedStart(new Date(start).toISOString(), config.intervalMs, start + 7_200_000), start + 7_200_000);
  assert.throws(() => nextAllowedStart('cassé', config.intervalMs), PauseError);
});

test('aucun paquet disponible : aucun clic', async () => {
  let clicks = 0;
  const result = await runBatch({ prepare: async () => ({ available: 0 }), openOne: async () => { clicks++; } }, config, quiet);
  assert.equal(clicks, 0);
  assert.equal(result.opened, 0);
});

test('stock initial fixe le quota même si des paquets se régénèrent', async () => {
  let clicks = 0;
  const delays = [];
  const result = await runBatch({
    prepare: async () => ({ available: 3 }),
    openOne: async () => { clicks++; return { remaining: 3, cards: ['Carte'] }; },
  }, config, { ...quiet, sleep: async ms => delays.push(ms) });
  assert.equal(clicks, 3);
  assert.equal(result.cards.length, 3);
  assert.deepEqual(delays, [15_000, 15_000]);
});

test('le plafond de session et la disparition du stock arrêtent la boucle', async () => {
  let clicks = 0;
  const site = { prepare: async () => ({ available: 10 }), openOne: async () => { clicks++; return { remaining: 8, cards: [] }; } };
  await runBatch(site, { ...config, maxPacks: 2 }, quiet);
  assert.equal(clicks, 2);
  clicks = 0;
  site.openOne = async () => { clicks++; return { remaining: 0, cards: [] }; };
  await runBatch(site, config, quiet);
  assert.equal(clicks, 1);
});

test('échec ambigu : aucun deuxième essai ni ouverture suivante', async () => {
  let clicks = 0;
  const expected = new PauseError('uncertain_result', 'stop');
  await assert.rejects(runBatch({ prepare: async () => ({ available: 6 }), openOne: async () => { clicks++; throw expected; } }, config, quiet), expected);
  assert.equal(clicks, 1);
});

test('la pause et le planning persistent ; état corrompu refusé', async () => {
  const dir = await mkdtemp(path.join(process.env.TEST_TMPDIR || os.tmpdir(), 'wiki-hourly-'));
  try {
    const first = await createState(dir);
    await first.put('paused', { code: 'login_required' });
    await first.put('schedule', { lastStartedAt: '2026-10-24T16:00:00Z' });
    const second = await createState(dir);
    assert.equal((await second.get('paused')).code, 'login_required');
    assert.equal((await second.get('schedule')).lastStartedAt, '2026-10-24T16:00:00Z');
    await second.remove('paused');
    assert.equal(await first.get('paused'), null);
    await writeFile(path.join(dir, 'state', 'schedule.json'), '{');
    await assert.rejects(first.get('schedule'), PauseError);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
