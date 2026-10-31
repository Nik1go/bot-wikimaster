import test from 'node:test';
import assert from 'node:assert/strict';
import { readMarketConfig } from '../src/market-config.mjs';
import { nextMinimumBid, prefilter, buildReference, evaluateCandidate, rankCandidates, inferAccountId } from '../src/market-selection.mjs';

const now = Date.parse('2026-10-31T12:00:00Z');
const config = readMarketConfig({});
const account = { userId: 'buyer', balance: 5000 };
const auction = (overrides = {}) => ({
  id: 'auction-a', card_id: 'card-a', seller_id: 'seller', status: 'active',
  end_at: new Date(now + 90_000).toISOString(), base_amount: 300, current_bid: null,
  snapshot_rarity: 'L', card: { rarity: 'L', wikipedia_title: 'Carte A', image_url: 'https://example.invalid/a.png' }, ...overrides,
});
const sales = (mean = 1000) => [1, 2, 3].map(n => ({ id: `sale-${n}`, card_id: 'card-a', rarity: 'L', final_price: mean, settled_at: new Date(now - n * 86_400_000).toISOString(), is_shiny: false }));

test('marché : simulation, une position, plafond 3500 et classement par écart par défaut', () => {
  assert.equal(config.mode, 'simulation');
  assert.equal(config.liveEnabled, false);
  assert.equal(config.maxPositions, 1);
  assert.equal(config.maxPerCard, 3500);
  assert.equal(config.rankBy, 'saving');
  for (const env of [{ MARKET_MAX_PER_CARD: '3501' }, { MARKET_MODE: 'real' }, { MARKET_LIVE_ENABLED: 'yes' }, { MARKET_MIN_SECONDS: '120', MARKET_MAX_SECONDS: '30' }, { MARKET_MIN_SALES: '11' }]) {
    assert.throws(() => readMarketConfig(env));
  }
});

test('minimum identique au client officiel et absence de mélange avec le prix de départ', () => {
  assert.equal(nextMinimumBid(auction()), 300);
  assert.equal(nextMinimumBid(auction({ current_bid: 100 })), 111);
  assert.equal(nextMinimumBid(auction({ current_bid: 1000 })), 1100);
  for (const current_bid of [-1, NaN, '100', Infinity]) assert.throws(() => nextMinimumBid(auction({ current_bid })));
});

test('filtre le temps restant, les images, sa propre vente et ses propres mises', () => {
  assert.equal(prefilter(auction(), account, config, now).eligible, true);
  for (const [changes, reason] of [
    [{ end_at: new Date(now - 1000).toISOString() }, 'expired'],
    [{ end_at: new Date(now + 29_000).toISOString() }, 'ending_too_soon'],
    [{ end_at: new Date(now + 121_000).toISOString() }, 'ending_too_late'],
    [{ card: { rarity: 'L', image_url: null } }, 'missing_image'],
    [{ card: { rarity: 'L', image_url: 'image', hide_image: true } }, 'missing_image'],
    [{ is_shiny: true }, 'shiny_unsupported'],
    [{ seller_id: 'buyer' }, 'own_listing'],
    [{ current_bidder_id: 'buyer' }, 'already_leading'],
    [{ current_bid: 3400 }, 'per_card_limit'],
  ]) assert.equal(prefilter(auction(changes), account, config, now).reason, reason);
  assert.equal(prefilter(auction({ base_amount: 700 }), { ...account, balance: 600 }, config, now).reason, 'insufficient_wallet');
});

test('référence issue de ventes conclues de la même carte/rareté et dédoublonnée', () => {
  const valid = sales();
  const polluted = [...valid, valid[0],
    { ...valid[0], id: 'wrong-rarity', rarity: 'UR', final_price: 99999 },
    { ...valid[0], id: 'wrong-card', card_id: 'another-card', final_price: 99999 },
    { ...valid[0], id: 'old', settled_at: new Date(now - 31 * 86_400_000).toISOString(), final_price: 99999 },
    { ...valid[0], id: 'future', settled_at: new Date(now + 1000).toISOString(), final_price: 99999 },
    { ...valid[0], id: 'shiny', is_shiny: true, final_price: 99999 },
    { ...valid[0], id: 'not-sold', status: 'settled_unsold', final_price: 99999 },
  ];
  const reference = buildReference(polluted, auction(), config, now);
  assert.equal(reference.mean, 1000);
  assert.equal(reference.sampleCount, 3);
  assert.equal(reference.variantUnknownCount, 0);
  assert.equal(buildReference(valid.slice(0, 2), auction(), config, now).usable, false);
});

test('seules les dix ventes récentes participent à la moyenne et les variantes inconnues sont visibles', () => {
  const rows = Array.from({ length: 12 }, (_, n) => ({ id: `sale-${n}`, rarity: 'L', final_price: n < 10 ? 1000 : 99999, settled_at: new Date(now - (n + 1) * 1000).toISOString() }));
  const reference = buildReference(rows, auction(), config, now);
  assert.equal(reference.mean, 1000);
  assert.equal(reference.sampleCount, 10);
  assert.equal(reference.variantUnknownCount, 10);
});

test('prochaine mise sous 50% de la référence, plafond personnel et solde disponible', () => {
  const reference = buildReference(sales(), auction(), config, now);
  const candidate = evaluateCandidate(auction({ base_amount: 500 }), reference, account, config, now);
  assert.equal(candidate.ceiling, 500);
  assert.equal(candidate.eligible, true);
  assert.equal(evaluateCandidate(auction({ current_bid: 490 }), reference, account, config, now).reason, 'above_reference_limit');
  assert.equal(evaluateCandidate(auction(), reference, { ...account, balance: 400 }, config, now).ceiling, 400);
});

test('classement absolu demandé : 2800 contre référence 6000 avant 300 contre référence 1000', () => {
  const a = evaluateCandidate(auction(), buildReference(sales(), auction(), config, now), account, config, now);
  const bAuction = auction({ id: 'auction-b', base_amount: 2800 });
  const b = evaluateCandidate(bAuction, buildReference(sales(6000), bAuction, config, now), account, config, now);
  assert.equal(rankCandidates([a, b], config)[0].auctionId, 'auction-b');
  assert.equal(rankCandidates([a, b], { ...config, rankBy: 'discount' })[0].auctionId, 'auction-a');
  assert.deepEqual(rankCandidates([b, { ...b, auctionId: 'auction-c' }], config).map(c => c.auctionId), ['auction-b', 'auction-c']);
});

test('identification du compte sans exporter de session et refus de profils incohérents', () => {
  assert.equal(inferAccountId({ selling: [{ seller_id: 'buyer' }], won: [{ winner_id: 'buyer' }] }), 'buyer');
  assert.equal(inferAccountId({}, 'buyer'), 'buyer');
  assert.throws(() => inferAccountId({}));
  assert.throws(() => inferAccountId({ selling: [{ seller_id: 'someone-else' }] }, 'buyer'));
});
