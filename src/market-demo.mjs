import { readMarketConfig } from './market-config.mjs';
import { MarketEngine } from './market-engine.mjs';
import { renderMarketReport } from './market-report.mjs';

export async function marketDemo() {
  // Entirely fictional input. No browser, API request, cookie or credential.
  const config = readMarketConfig({});
  let clock = Date.parse('2026-10-31T12:00:00Z');
  const card = (n, title, amount) => ({
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    card_id: `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    seller_id: 'demo-seller', status: 'active', base_amount: amount,
    current_bid: null, current_bidder_id: null, snapshot_rarity: 'L', is_shiny: false,
    end_at: new Date(clock + 90_000).toISOString(),
    card: { wikipedia_title: title, rarity: 'L', image_url: 'https://example.invalid/demo.png', hide_image: false },
  });
  const a = card(1, 'Carte Démo A', 300);
  const b = card(2, 'Carte Démo B', 2800);
  const missingImage = card(3, 'Carte Démo sans image', 100);
  missingImage.card.image_url = null;
  const events = [];
  const values = new Map();
  const store = {
    get: async key => structuredClone(values.get(key) ?? null),
    put: async (key, value) => { values.set(key, structuredClone(value)); },
    log: async (event, details) => { events.push({ at: new Date(clock).toISOString(), event, ...details }); },
  };
  const api = {
    list: async () => ({ auctions: [a, b, missingImage], hasMore: false }),
    account: async () => ({ userId: 'demo-buyer', balance: 5000, leadingAuctionIds: [] }),
    wallet: async () => 5000,
    auction: async auctionId => structuredClone(auctionId === a.id ? a : b),
    sales: async cardId => [1, 2, 3].map(n => ({
      id: `sale-${cardId}-${n}`, card_id: cardId, rarity: 'L', is_shiny: false,
      final_price: cardId === a.card_id ? 1000 : 7000,
      settled_at: new Date(clock - n * 86_400_000).toISOString(),
    })),
    bid: async () => { throw new Error('Le mode démo ne doit jamais envoyer de mise'); },
  };
  const engine = await new MarketEngine(api, config, store, { now: () => clock }).init();
  await engine.tick();
  clock += 15_000;
  b.current_bid = 2900;
  b.current_bidder_id = 'demo-competitor';
  b.end_at = new Date(Date.parse(b.end_at) + 60_000).toISOString();
  await engine.tick();
  clock += 15_000;
  b.current_bid = 3200;
  await engine.tick();
  clock = Date.parse(b.end_at) + 5000;
  b.status = 'settled_sold';
  b.final_price = 3600;
  b.winner_id = 'demo-competitor';
  await engine.tick();
  return { events, report: renderMarketReport(events, config.timezone) };
}
