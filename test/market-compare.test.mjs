import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { compareStrategies, comparisonDemoSnapshot, renderComparison } from '../src/market-compare.mjs';
import { readMarketConfig } from '../src/market-config.mjs';

const execute = promisify(execFile);
const entry = fileURLToPath(new URL('../src/index.mjs', import.meta.url));
const row = (result, discount, id) => result.strategies.find(s => s.minDiscountPercent === discount).candidates.find(c => c.auctionId === id);

test('20 % et 30 % : choix indépendants sur les mêmes fonds, sans mutation des observations', () => {
  const snapshot = comparisonDemoSnapshot();
  const before = structuredClone(snapshot);
  const result = compareStrategies(snapshot);
  assert.deepEqual(snapshot, before);
  assert.deepEqual(result.strategies.map(s => [s.minDiscountPercent, s.eligibleCount, s.selectedAuctionId]), [[20, 2, 'auction-a'], [30, 1, 'auction-b']]);
  assert.equal(row(result, 20, 'auction-a').ceiling, 3200);
  assert.equal(row(result, 20, 'auction-a').saving, 900);
  assert.equal(row(result, 30, 'auction-a').reason, 'above_reference_limit');
  assert.ok(row(result, 30, 'auction-a').message.includes('30 %'));
  assert.equal(result.limits.walletBalance, 5000);
  assert.ok(result.strategies.every(s => s.candidates.filter(c => c.selected).length === 1));
  // The executable purchasing configuration still cannot be raised to 80 %.
  assert.equal(readMarketConfig({}).maxReferencePercent, 50);
  assert.throws(() => readMarketConfig({ MARKET_MAX_REFERENCE_PERCENT: '80' }));
});

test('une moyenne gonflée par une vente élevée ne gonfle pas le prix prudent', () => {
  const result = compareStrategies(comparisonDemoSnapshot());
  const c = row(result, 20, 'auction-c');
  assert.equal(c.reference.mean, 3600);
  assert.equal(c.reference.lowerQuartile, 2000);
  assert.equal(c.priceReference, 2000);
  assert.equal(c.ceiling, 1600);
  assert.equal(c.eligible, false);
});

test('prochaine mise avec incrément, budget, portefeuille et réserve restent contraignants', () => {
  const snapshot = comparisonDemoSnapshot();
  snapshot.auctions[0].current_bid = 3000;
  let result = compareStrategies(snapshot);
  assert.ok(row(result, 20, 'auction-a').nextBid >= 3300);
  assert.equal(row(result, 20, 'auction-a').eligible, false);
  assert.equal(row(result, 20, 'auction-d').reason, 'per_card_limit');
  snapshot.account.balance = 2000;
  result = compareStrategies(snapshot);
  assert.equal(row(result, 20, 'auction-a').reason, 'insufficient_wallet');
  assert.ok(result.strategies.every(s => s.selectedAuctionId === 'auction-b'));
  snapshot.account.reserveWB = 500;
  result = compareStrategies(snapshot);
  assert.ok(result.strategies.every(s => s.selectedAuctionId === null));
});

test('une position déclarée ou une enchère déjà menée empêche un nouveau choix', () => {
  const snapshot = comparisonDemoSnapshot();
  snapshot.account.positionOccupied = true;
  assert.ok(compareStrategies(snapshot).strategies.every(s => s.selectedAuctionId === null));
  snapshot.account.positionOccupied = false;
  snapshot.auctions[0].current_bidder_id = snapshot.account.userId;
  const result = compareStrategies(snapshot);
  assert.equal(result.limits.positionOccupied, true);
  assert.ok(result.strategies.every(s => s.candidates.every(c => c.reason === 'position_occupied' && !c.eligible)));
});

test('les ventes futures ne complètent pas artificiellement un échantillon trop petit', () => {
  const snapshot = comparisonDemoSnapshot();
  snapshot.salesByCard['card-b'][0].settled_at = '2026-11-02T12:00:00Z';
  const result = compareStrategies(snapshot);
  const b = row(result, 30, 'auction-b');
  assert.equal(b.reason, 'insufficient_sales');
  assert.equal(b.reference.sampleCount, 4);
  assert.equal(b.priceReference, null);
  assert.equal(result.strategies[1].selectedAuctionId, null);
});

test('comparables invalides exclus et variantes inconnues explicitement signalées', () => {
  const snapshot = comparisonDemoSnapshot();
  const sales = snapshot.salesByCard['card-b'];
  delete sales[0].is_shiny;
  sales.push({ ...sales[0], id: 'future', final_price: 1, settled_at: '2026-11-02T12:00:00Z' });
  sales.push({ ...sales[0], id: 'another-card', card_id: 'card-other', final_price: 1 });
  sales.push({ ...sales[0], id: 'shiny', is_shiny: true, final_price: 1 });
  sales.push({ ...sales[0], id: 42, final_price: 1 });
  sales.push({ ...sales[0] });
  const b = row(compareStrategies(snapshot), 30, 'auction-b');
  assert.equal(b.reference.sampleCount, 5);
  assert.equal(b.reference.variantUnknownCount, 1);
  assert.equal(b.priceReference, 2400);
});

test('un format ambigu ou un portefeuille incohérent est refusé explicitement', () => {
  for (const change of [
    s => { s.observedAt = '2026-11-01T12:00:00'; },
    s => { s.account.balance = -1; },
    s => { delete s.account.positionOccupied; },
    s => { s.auctions.push(s.auctions[0]); },
    s => { s.salesByCard['card-a'] = {}; },
  ]) {
    const snapshot = comparisonDemoSnapshot();
    change(snapshot);
    assert.throws(() => compareStrategies(snapshot), { code: 'comparison_input_invalid' });
  }
});

test('rapport : provenance fictive visible, titres neutralisés et champs privés non recopiés', () => {
  const snapshot = comparisonDemoSnapshot();
  snapshot.account.privateToken = 'secret-not-for-report';
  snapshot.auctions[0].card.wikipedia_title = 'Carte |\n[piège](https://example.invalid)';
  const result = compareStrategies(snapshot);
  const report = renderComparison(result);
  assert.ok(report.includes('DONNÉES FICTIVES'));
  assert.ok(!report.includes('[piège]'));
  assert.ok(!report.includes('Carte |\n'));
  assert.ok(!JSON.stringify(result).includes('secret-not-for-report'));
});

test('CLI de comparaison : fichiers locaux uniquement, aucun état même avec environnement live', async t => {
  const dir = await mkdtemp(path.join(process.env.TEST_TMPDIR || os.tmpdir(), 'wiki-compare-'));
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(process.env.TEST_TMPDIR || os.tmpdir()));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, DATA_DIR: path.join(dir, 'no-state'), MARKET_MODE: 'live', MARKET_LIVE_ENABLED: 'true', MARKET_MAX_REFERENCE_PERCENT: '80', PACK_OPENING_ENABLED: 'true' };
  const run = (...args) => execute(process.execPath, [entry, 'market-compare', ...args], { env, windowsHide: true, timeout: 10_000 });
  const demo = JSON.parse((await run('--demo', '--json')).stdout);
  assert.equal(demo.source, 'fictional');
  assert.deepEqual(await readdir(dir), []);
  const filename = path.join(dir, 'snapshot.json');
  const snapshot = comparisonDemoSnapshot();
  snapshot.source = 'saved_snapshot';
  await writeFile(filename, '\uFEFF' + JSON.stringify(snapshot));
  const saved = JSON.parse((await run(filename, '--json')).stdout);
  assert.deepEqual(saved.strategies, demo.strategies);
  assert.deepEqual(await readdir(dir), ['snapshot.json']);
  await writeFile(filename, '{"privateToken":"secret-not-for-errors"');
  await assert.rejects(run(filename), error => error.stderr.includes('comparison_input_invalid') && !error.stderr.includes('secret-not-for-errors'));
  await assert.rejects(run('--demo', '--unexpected'), error => error.stderr.includes('invalid_arguments'));
});
