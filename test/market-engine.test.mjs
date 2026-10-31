import test from 'node:test';
import assert from 'node:assert/strict';
import { readMarketConfig } from '../src/market-config.mjs';
import { MarketEngine } from '../src/market-engine.mjs';
import { MarketApiError } from '../src/market-api.mjs';

const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const SALE = '00000000-0000-4000-8000-000000000003';
async function fixture(env = {}, overrides = {}) {
  let clock = Date.parse('2026-10-31T12:00:00Z');
  let balance = 5000;
  const config = readMarketConfig(env);
  const values = new Map();
  const events = [];
  const calls = [];
  const auctions = new Map();
  const make = (auctionId, base, title) => ({ id: auctionId, card_id: `card-${auctionId}`, status: 'active', seller_id: 'seller', current_bid: null, current_bidder_id: null, base_amount: base, end_at: new Date(clock + 90_000).toISOString(), snapshot_rarity: 'L', card: { rarity: 'L', image_url: 'https://example.invalid/card.png', wikipedia_title: title } });
  auctions.set(A, make(A, 300, 'Carte A'));
  auctions.set(B, make(B, 2800, 'Carte B'));
  const store = {
    get: async key => structuredClone(values.get(key) ?? null),
    put: async (key, value) => { values.set(key, structuredClone(value)); },
    log: async (event, details = {}) => { events.push({ at: new Date(clock).toISOString(), event, ...details }); },
  };
  const api = {
    list: async page => { calls.push(['list', page]); return { auctions: [...auctions.values()].filter(a => a.id !== SALE), hasMore: false }; },
    account: async () => { calls.push(['account']); return { userId: 'buyer', balance, leadingAuctionIds: [] }; },
    wallet: async () => { calls.push(['wallet']); return balance; },
    auction: async auctionId => { calls.push(['auction', auctionId]); return structuredClone(auctions.get(auctionId)); },
    sales: async cardId => { calls.push(['sales', cardId]); return [1, 2, 3].map(n => ({ id: `sale-${cardId}-${n}`, card_id: cardId, rarity: 'L', is_shiny: false, final_price: cardId === `card-${A}` ? 1000 : 7000, settled_at: new Date(clock - n * 86_400_000).toISOString() })); },
    bid: async (auctionId, amount) => {
      calls.push(['bid', auctionId, amount]);
      assert.equal((await store.get('book')).pending.amount, amount, 'intention durable avant tout POST');
      const target = auctions.get(auctionId);
      target.current_bid = amount;
      target.current_bidder_id = 'buyer';
      balance -= amount;
      return { current_bid: amount, bidder_balance: balance };
    },
    ...overrides,
  };
  const engine = await new MarketEngine(api, config, store, { now: () => clock }).init();
  return { engine, config, store, api, events, calls, auctions, values,
    now: () => clock, advance: ms => { clock += ms; }, setBalance: n => { balance = n; },
  };
}

test('simulation : meilleur écart, un seul choix, justification et aucun POST', async () => {
  const f = await fixture();
  await f.engine.tick();
  assert.equal(f.engine.openPositions().length, 1);
  assert.equal(f.engine.openPositions()[0].auctionId, B);
  assert.equal(f.engine.openPositions()[0].ceiling, 3500);
  assert.equal(f.calls.filter(c => c[0] === 'bid').length, 0);
  const selected = f.events.find(e => e.event === 'candidate_selected');
  assert.equal(selected.saving, 4200);
  assert.equal(selected.compared.length, 2);
  assert.ok(f.events.some(e => e.event === 'would_bid'));
});

test('live simulé : pas de surenchère sur soi-même, contre-mise bornée puis suivi du résultat', async () => {
  const f = await fixture({ MARKET_MODE: 'live', MARKET_LIVE_ENABLED: 'true' });
  await f.engine.tick();
  await f.engine.tick();
  assert.equal(f.calls.filter(c => c[0] === 'bid').length, 1);
  const b = f.auctions.get(B);
  f.setBalance(5000); // Remboursement par le serveur après surenchère adverse.
  b.current_bid = 2900; b.current_bidder_id = 'other';
  b.end_at = new Date(Date.parse(b.end_at) + 60_000).toISOString();
  f.advance(15_000);
  await f.engine.tick();
  assert.equal(f.calls.filter(c => c[0] === 'bid').length, 2);
  assert.ok(f.calls.filter(c => c[0] === 'bid').every(c => c[2] <= 3500));
  f.setBalance(5000); b.current_bid = 3200; b.current_bidder_id = 'other';
  f.advance(15_000);
  await f.engine.tick();
  assert.equal(f.engine.openPositions()[0].abandonReason, 'ceiling_reached');
  b.status = 'settled_sold'; b.final_price = 3600; b.winner_id = 'other';
  await f.engine.tick();
  assert.equal(f.engine.openPositions().length, 0);
  assert.ok(f.events.some(e => e.event === 'end_changed'));
  assert.ok(f.events.some(e => e.event === 'ceiling_reached'));
  assert.ok(f.events.some(e => e.event === 'auction_lost' && e.finalPrice === 3600));
  const scans = f.calls.filter(c => c[0] === 'list').length;
  await f.engine.tick();
  assert.equal(f.calls.filter(c => c[0] === 'list').length, scans, 'pas de nouvelle recherche avant une heure');
});

test('solde et délai revérifiés juste avant le premier achat', async () => {
  const f = await fixture({ MARKET_MODE: 'live', MARKET_LIVE_ENABLED: 'true' }, { wallet: async () => 0 });
  await f.engine.tick();
  assert.equal(f.calls.filter(c => c[0] === 'bid').length, 0);
  assert.equal(f.engine.openPositions().length, 0);
  assert.ok(f.events.some(e => e.reason === 'insufficient_wallet'));
});

test('position gagnée immobilisée jusqu’à une revente valide et confirmée', async () => {
  const f = await fixture({ MARKET_MODE: 'live', MARKET_LIVE_ENABLED: 'true' });
  await f.engine.tick();
  const b = f.auctions.get(B);
  b.status = 'settled_sold'; b.winner_id = 'buyer'; b.final_price = 2800; b.settled_at = new Date(f.now()).toISOString();
  await f.engine.tick();
  const reads = f.calls.length;
  f.advance(3_600_000);
  assert.equal((await f.engine.tick()).state, 'awaiting_resale');
  assert.equal(f.calls.length, reads);
  f.auctions.set(SALE, { ...b, id: SALE, seller_id: 'someone-else', created_at: new Date(f.now()).toISOString(), status: 'active' });
  await assert.rejects(f.engine.linkResale(B, SALE), e => e.code === 'invalid_resale');
  f.auctions.get(SALE).seller_id = 'buyer';
  await f.engine.linkResale(B, SALE);
  f.auctions.get(SALE).status = 'settled_sold';
  f.auctions.get(SALE).final_price = 6000;
  await f.engine.tick();
  assert.equal(f.engine.openPositions().length, 0);
  assert.ok(f.events.some(e => e.event === 'position_closed' && e.grossSpread === 3200));
});

test('blocage API persisté : aucun appel supplémentaire, y compris après redémarrage', async () => {
  const blocked = new MarketApiError('automation_limit', 'Refus automatique', { status: 429 });
  const f = await fixture({}, { sales: async () => { throw blocked; } });
  await assert.rejects(f.engine.tick(), blocked);
  await f.engine.pause(blocked);
  const reads = f.calls.length;
  const restarted = await new MarketEngine(f.api, f.config, f.store, { now: f.now }).init();
  assert.equal((await restarted.tick()).state, 'paused');
  assert.equal(f.calls.length, reads);
  assert.equal((await f.store.get('paused')).code, 'automation_limit');
});

test('timeout de mise : intention conservée et aucune répétition avant réconciliation', async () => {
  let bids = 0;
  const failure = new MarketApiError('network_error', 'Délai dépassé', { uncertain: true });
  const f = await fixture({ MARKET_MODE: 'live', MARKET_LIVE_ENABLED: 'true' }, { bid: async () => { bids++; throw failure; } });
  await assert.rejects(f.engine.tick(), failure);
  await f.engine.pause(failure);
  assert.equal((await f.store.get('book')).pending.amount, 2800);
  const restarted = await new MarketEngine(f.api, f.config, f.store, { now: f.now }).init();
  await restarted.tick();
  assert.equal(bids, 1);
  assert.equal((await restarted.reconcilePending()).resolved, false);
  f.auctions.get(B).current_bid = 2800;
  f.auctions.get(B).current_bidder_id = 'buyer';
  assert.equal((await restarted.reconcilePending()).resolved, true);
  assert.equal((await f.store.get('book')).pending, null);
  assert.equal(bids, 1);
});

test('reprise du suivi d’une mise confirmée sans nouvelle sélection ou nouveau POST', async () => {
  const f = await fixture({ MARKET_MODE: 'live', MARKET_LIVE_ENABLED: 'true' });
  await f.engine.tick();
  const scans = f.calls.filter(c => c[0] === 'list').length;
  const restarted = await new MarketEngine(f.api, f.config, f.store, { now: f.now }).init();
  await restarted.tick();
  assert.equal(f.calls.filter(c => c[0] === 'bid').length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'list').length, scans + 1, 'identité revérifiée après redémarrage');
});

test('minimum serveur concurrent réutilisé sans renvoi immédiat ni dépassement du plafond', async () => {
  let attempts = 0;
  const f = await fixture({ MARKET_MODE: 'live', MARKET_LIVE_ENABLED: 'true' });
  const bid = f.api.bid;
  f.api.bid = async (auctionId, amount) => {
    attempts++;
    if (attempts === 1) throw new MarketApiError('bid_too_low', 'minimum', { uncertain: false, minimum: 3000 });
    return bid(auctionId, amount);
  };
  await f.engine.tick();
  assert.equal(attempts, 1);
  await f.engine.tick();
  assert.equal(attempts, 2);
  assert.equal(f.engine.openPositions()[0].lastBid, 3000);
});

test('une enchère manuelle déjà menée empêche de financer une seconde carte', async () => {
  const f = await fixture({}, { account: async () => ({ userId: 'buyer', balance: 5000, leadingAuctionIds: ['manual-auction'] }) });
  await f.engine.tick();
  assert.equal(f.engine.openPositions().length, 0);
  assert.equal(f.calls.filter(c => c[0] === 'sales').length, 0);
  assert.ok(f.events.some(e => e.event === 'no_free_slot'));
});

test('simulation finit avec le résultat observé sans annoncer de gain fictif', async () => {
  const f = await fixture();
  await f.engine.tick();
  const b = f.auctions.get(B);
  b.status = 'settled_sold'; b.winner_id = 'other'; b.final_price = 2900;
  await f.engine.tick();
  assert.ok(f.events.some(e => e.event === 'simulation_finished'));
  assert.ok(!f.events.some(e => e.event === 'auction_won'));
  assert.equal(f.calls.filter(c => c[0] === 'bid').length, 0);
});

test('profil différent après redémarrage : aucun achat avec le mauvais compte', async () => {
  const f = await fixture({ MARKET_MODE: 'live', MARKET_LIVE_ENABLED: 'true' });
  await f.engine.tick();
  f.api.account = async () => ({ userId: 'another-buyer', balance: 9000, leadingAuctionIds: [] });
  const restarted = await new MarketEngine(f.api, f.config, f.store, { now: f.now }).init();
  await assert.rejects(restarted.tick(), error => error.code === 'account_mismatch');
  assert.equal(f.calls.filter(c => c[0] === 'bid').length, 1);
});

test('fin dépassée sans règlement : aucun gain déclaré et arrêt borné du suivi', async () => {
  const f = await fixture();
  await f.engine.tick();
  f.advance(100_000);
  assert.equal((await f.engine.tick()).state, 'awaiting_settlement');
  assert.ok(!f.events.some(e => e.event === 'auction_won'));
  f.advance(30 * 60_000);
  await assert.rejects(f.engine.tick(), error => error.code === 'watch_timeout');
  assert.equal(f.engine.openPositions().length, 1);
});

test('pagination dédoublonnée et plafond de lectures d’historique visibles', async () => {
  const f = await fixture({ MARKET_MAX_HISTORIES: '1' });
  const a = f.auctions.get(A), b = f.auctions.get(B);
  f.api.list = async page => {
    f.calls.push(['list', page]);
    return page === 1 ? { auctions: [a], hasMore: true } : { auctions: [a, b, { ...a, id: 'far-away', end_at: new Date(f.now() + 999_000).toISOString() }], hasMore: false };
  };
  await f.engine.tick();
  assert.equal(f.calls.filter(c => c[0] === 'sales').length, 1);
  assert.equal(f.events.find(e => e.event === 'scan_finished').seen, 3);
  assert.equal(f.events.find(e => e.event === 'scan_finished').unevaluated, 1);
  assert.ok(f.events.some(e => e.event === 'candidate_deferred'));
});

test('le classement est corrigé si le prix de la première carte augmente avant la mise', async () => {
  const f = await fixture();
  const sales = f.api.sales;
  f.api.sales = async cardId => (await sales(cardId)).map(s => ({ ...s, final_price: cardId === `card-${A}` ? 5000 : 7000 }));
  const detail = f.api.auction;
  f.api.auction = async auctionId => {
    if (auctionId === A) { f.auctions.get(A).current_bid = 1000; f.auctions.get(A).current_bidder_id = 'other'; }
    return detail(auctionId);
  };
  await f.engine.tick();
  assert.equal(f.engine.openPositions()[0].auctionId, B);
  assert.ok(f.events.some(e => e.event === 'candidate_reordered'));
});

test('gagnant manquant dans le règlement réel : place conservée, aucun nouvel achat', async () => {
  const f = await fixture({ MARKET_MODE: 'live', MARKET_LIVE_ENABLED: 'true' });
  await f.engine.tick();
  f.auctions.get(B).status = 'settled_sold';
  f.auctions.get(B).final_price = 2800;
  await assert.rejects(f.engine.tick(), error => error.code === 'invalid_settlement');
  assert.equal(f.engine.openPositions().length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'bid').length, 1);
});
