import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readRelabelConfig, buildRelabelPlan, relabelIdentity, restoreSaleLabels, nextRelabelStart } from '../src/relabel-core.mjs';
import { runRelabelCommand, relabelArguments, runRelabelService, runRelabelWorker } from '../src/relabel-cli.mjs';
import { PauseError } from '../src/core.mjs';
import { createState } from '../src/state.mjs';
import { acquireCollectionLock } from '../src/collection-lock.mjs';

const config = { ...readRelabelConfig({}), delayMs: 0 };
const entry = (title = 'Carte', options = {}) => ({ title, rarity: 'SR', stats: ['6 769', '4 579'], href: `/marketplace/${title.replace(/\s/g, '-')}`, status: 'unsold', owned: true, ...options });
const memory = () => {
  const data = new Map(), events = [];
  return { data, events, get: async k => structuredClone(data.get(k) ?? null), put: async (k, v) => data.set(k, structuredClone(v)), remove: async k => data.delete(k), log: async (event, details) => events.push({ event, ...details }) };
};
class Site {
  constructor(history, store) { this.history = history; this.store = store; this.labels = new Set(); this.writes = []; this.opens = []; }
  async readHistory() { return this.history; }
  async openCandidate(card) {
    assert.equal((await this.store.get('plan')).candidates.length, buildRelabelPlan(this.history).candidates.length, 'La liste complète doit être sauvegardée avant les cartes.');
    this.opens.push(card.title);
    return card.title === 'Absente' ? 'missing' : card.title === 'Doublon' ? 'ambiguous' : 'open';
  }
  async hasSaleLabel(card) { return this.labels.has(relabelIdentity(card)); }
  async ensureLabel(card) {
    this.writes.push(card.title);
    this.labels.add(relabelIdentity(card));
    if (this.error) { const error = this.error; this.error = null; throw error; }
    return 'tagged';
  }
  async closeCard() {}
  async recoverCandidate() { this.recovered = true; }
  dispose() { this.disposed = true; }
}
const options = { sleep: async () => {} };

test('historique : seulement les invendues possédées, dédoublonnées par titre, rareté et statistiques', () => {
  const result = buildRelabelPlan([
    entry('A'), entry('A', { href: '/marketplace/again', stats: ['6\u202f769', '4\u00a0579'] }),
    entry('B', { status: 'sold' }), entry('C', { owned: false }),
    entry('A', { rarity: 'UR', href: '/marketplace/ur' }), entry('A', { stats: ['6770', '4579'], href: '/marketplace/other' }),
  ]);
  assert.equal(result.historyCount, 6);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.candidates.length, 3);
  assert.deepEqual(result.candidates[0].listings, ['/marketplace/A', '/marketplace/again']);
  for (const bad of [{ rarity: '?' }, { stats: ['1'] }, { stats: ['—', '2'] }, { status: null }, { owned: 'true' }, { href: 'https://evil.test/' }]) assert.throws(() => buildRelabelPlan([entry('X', bad)]));
  assert.throws(() => buildRelabelPlan([entry(), entry()]), { code: 'history_invalid' });
});

test('simulation : liste entière sauvegardée, étiquette existante détectée, zéro écriture', async () => {
  const store = memory(), site = new Site([entry('A'), entry('B')], store);
  site.labels.add(relabelIdentity(entry('A')));
  const plan = await restoreSaleLabels(site, config, store, options);
  assert.deepEqual(plan.candidates.map(c => c.action), ['already_tagged', 'would_tag']);
  assert.equal(plan.complete, true);
  assert.deepEqual(site.writes, []);
});

test('application : doublons historiques ignorés, absentes et copies ambiguës laissées intactes, toutes raretés', async () => {
  const store = memory(), site = new Site([entry('A'), entry('A', { href: '/marketplace/again' }), entry('B', { rarity: 'L' }), entry('Absente'), entry('Doublon')], store);
  const apply = { ...config, apply: true };
  const first = await restoreSaleLabels(site, apply, store, options);
  assert.deepEqual(site.writes, ['A', 'B']);
  assert.equal(first.totals.missing, 1);
  assert.equal(first.totals.ambiguous, 1);
  const second = await restoreSaleLabels(site, apply, store, options);
  assert.equal(second.totals.alreadyTagged, 2);
  assert.deepEqual(site.writes, ['A', 'B']);
});

test('étiquette incertaine : aucune répétition du clic, carte suivante traitée puis état réel relu au prochain passage', async () => {
  const store = memory(), site = new Site([entry('A'), entry('B')], store);
  site.error = new PauseError('label_unconfirmed', 'Enregistrement incertain.');
  const apply = { ...config, apply: true };
  const first = await restoreSaleLabels(site, apply, store, options);
  assert.equal(first.totals.errors, 1);
  assert.equal(first.totals.tagged, 1);
  assert.equal(site.recovered, true);
  const second = await restoreSaleLabels(site, apply, store, options);
  assert.equal(second.totals.alreadyTagged, 2);
  assert.deepEqual(site.writes, ['A', 'B']);
});

test('refus serveur ou session expirée : interruption globale avant la carte suivante', async () => {
  for (const code of ['rate_limited', 'login_required', 'access_denied', 'network_error', 'human_verification_required']) {
    const store = memory(), site = new Site([entry('A'), entry('B')], store);
    site.error = new PauseError(code, 'Intervention requise.');
    await assert.rejects(restoreSaleLabels(site, { ...config, apply: true }, store, options), { code });
    assert.deepEqual(site.writes, ['A']);
    assert.deepEqual(site.opens, ['A']);
    assert.equal((await store.get('plan')).complete, false);
  }
});

test('annulation après lecture : aucun étiquetage et historique invalide refusé avant toute ouverture', async () => {
  const store = memory(), site = new Site([entry()], store), abort = new AbortController();
  site.readHistory = async () => { abort.abort(); return site.history; };
  await assert.rejects(restoreSaleLabels(site, config, store, { ...options, signal: abort.signal }), { name: 'AbortError' });
  assert.equal(site.opens.length, 0);
  site.readHistory = async () => [entry('A'), entry('B', { status: null })];
  await assert.rejects(restoreSaleLabels(site, config, store, options), { code: 'history_invalid' });
  assert.equal(site.opens.length, 0);
});

test('configuration indépendante des seuils et raretés de collection ; arguments contrôlés', () => {
  const custom = readRelabelConfig({ COLLECTION_RARITIES: 'C', COLLECTION_APPLY: 'true' });
  assert.equal(custom.apply, false);
  assert.deepEqual(custom.rarities, ['C', 'PC', 'R', 'SR', 'UR', 'L']);
  assert.equal(custom.intervalMs, 86400_000);
  for (const env of [{ RELABEL_APPLY: 'yes' }, { RELABEL_DELAY_SECONDS: '0' }, { RELABEL_TIMEOUT_SECONDS: 'NaN' }]) assert.throws(() => readRelabelConfig(env));
  assert.equal(relabelArguments('relabel-once', ['--apply'], {}).config.apply, true);
  assert.throws(() => relabelArguments('relabel-nope', [], {}));
  assert.throws(() => relabelArguments('relabel-run', ['--scheduled'], {}));
  assert.throws(() => relabelArguments('relabel-once', ['--aply'], {}));
  assert.throws(() => relabelArguments('relabel-once', [], { RELABEL_BROWSER_CHANNEL: 'bad' }));
});

test('planning persistant : minimum 24 h, même après redémarrage ; date corrompue refusée', () => {
  const at = Date.parse('2026-11-16T03:00:00Z');
  assert.equal(nextRelabelStart(null, config.intervalMs), 0);
  assert.equal(nextRelabelStart({ lastStartedAt: new Date(at).toISOString() }, config.intervalMs), at + 86400_000);
  assert.throws(() => nextRelabelStart({ lastStartedAt: 'bad' }, config.intervalMs), { code: 'schedule_invalid' });
});

test('service : premier passage immédiat, attente sans navigateur, second passage après 24 h', async () => {
  const store = memory(), abort = new AbortController();
  let now = Date.parse('2026-11-16T03:00:00Z'), calls = 0, waits = 0;
  await runRelabelService(store, config, {
    signal: abort.signal, now: () => now,
    runOnce: async () => { calls++; await store.put('schedule', { lastStartedAt: new Date(now).toISOString() }); return 0; },
    sleep: async ms => { assert.equal(ms <= 15_000, true); waits++; now += ms; if (calls === 2) abort.abort(); },
  });
  assert.equal(calls, 2);
  assert.equal(waits > 1, true);
});

test('service : profil occupé sans lancement, pause persistante sans répétition, crash du worker mis en pause', async () => {
  for (const outcome of ['locked', 'paused', 'failed']) {
    const store = memory(), abort = new AbortController();
    let calls = 0;
    if (outcome === 'paused') await store.put('paused', { code: 'login_required' });
    await runRelabelService(store, config, {
      signal: abort.signal, runOnce: async () => { calls++; return outcome === 'locked' ? 75 : 1; },
      sleep: async ms => { if (outcome === 'locked') assert.equal(ms, 60_000); abort.abort(); },
    });
    assert.equal(calls, outcome === 'paused' ? 0 : 1);
    if (outcome === 'failed') assert.equal((await store.get('paused')).code, 'worker_failed');
  }
});

test('commande réelle : persistance du plan et du délai, fermeture du navigateur, libération du verrou partagé', async () => {
  const dir = await mkdtemp(path.join(process.env.TEST_TMPDIR || os.tmpdir(), 'wiki-relabel-'));
  const env = { DATA_DIR: dir }, state = await createState(path.join(dir, 'relabel', 'apply'));
  const site = new Site([entry()], state);
  let launched = 0, closed = 0;
  const runtime = {
    sleep: options.sleep,
    launchContext: async () => { launched++; return { pages: () => [{}], close: async () => { closed++; } }; },
    createSite: () => site,
  };
  assert.equal(await runRelabelCommand('relabel-once', ['--apply'], env, runtime), 0);
  assert.equal((await state.get('plan')).totals.tagged, 1);
  assert.equal(closed, 1);
  assert.equal(site.disposed, true);
  await assert.rejects(stat(path.join(dir, 'collection.lock')), { code: 'ENOENT' });
  assert.equal(await runRelabelCommand('relabel-once', ['--apply', '--scheduled'], env, runtime), 0);
  assert.equal(launched, 1, 'Un redémarrage quotidien ne doit pas relancer Chromium avant 24 h.');
  const lock = await acquireCollectionLock(dir, { command: 'collection-scan' });
  try { assert.equal(await runRelabelCommand('relabel-once', ['--apply'], env, runtime), 75); assert.equal(launched, 1); }
  finally { await lock.release(); }
});

test('commande réelle : panne et pause avant redémarrage ; resume garde la session et le planning', async () => {
  const dir = await mkdtemp(path.join(process.env.TEST_TMPDIR || os.tmpdir(), 'wiki-relabel-pause-'));
  const env = { DATA_DIR: dir }, state = await createState(path.join(dir, 'relabel', 'simulation'));
  let launched = 0, closed = 0;
  const runtime = {
    sleep: options.sleep,
    launchContext: async () => { launched++; return { pages: () => [{ screenshot: async () => {} }], close: async () => { closed++; } }; },
    createSite: () => ({ readHistory: async () => { throw new PauseError('login_required', 'Connexion nécessaire.'); }, dispose() {} }),
  };
  assert.equal(await runRelabelCommand('relabel-once', [], env, runtime), 1);
  assert.equal((await state.get('paused')).code, 'login_required');
  const schedule = await state.get('schedule');
  assert.equal(closed, 1);
  assert.equal(await runRelabelCommand('relabel-once', [], env, runtime), 1);
  assert.equal(launched, 1);
  assert.equal(await runRelabelCommand('relabel-resume', [], env, runtime), 0);
  assert.equal(await state.get('paused'), null);
  assert.deepEqual(await state.get('schedule'), schedule);
  assert.equal(launched, 1);
});

test('worker Linux : verrou système récupéré après crash sans ouvrir de navigateur en pause', { skip: process.platform !== 'linux' }, async () => {
  const dir = await mkdtemp(path.join(process.env.TEST_TMPDIR || os.tmpdir(), 'wiki-relabel-worker-'));
  const state = await createState(path.join(dir, 'relabel', 'simulation'));
  await state.put('paused', { code: 'login_required', message: 'Connexion nécessaire.' });
  await writeFile(path.join(dir, 'collection.lock'), JSON.stringify({ backend: 'flock', ownerId: 'previous', command: 'relabel-once' }));
  assert.equal(await runRelabelWorker({ ...process.env, DATA_DIR: dir }, config, new AbortController().signal), 1);
  await assert.rejects(stat(path.join(dir, 'collection.lock')), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(dir, 'chromium')), { code: 'ENOENT' });
});
