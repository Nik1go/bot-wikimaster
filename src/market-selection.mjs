import { PauseError } from './core.mjs';

export const REASONS = Object.freeze({
  invalid_auction: 'Annonce incomplète ou incohérente.',
  not_active: 'Enchère déjà clôturée ou annulée.',
  wrong_rarity: 'La carte n’est pas légendaire.',
  expired: 'Date de fin déjà dépassée.',
  ending_too_soon: 'Moins de temps disponible que le minimum demandé.',
  ending_too_late: 'Fin au-delà de la fenêtre de recherche.',
  missing_image: 'Image absente ou masquée.',
  shiny_unsupported: 'Variante shiny exclue tant que les historiques ne distinguent pas les variantes.',
  own_listing: 'Il s’agit de votre propre vente.',
  already_leading: 'Vous menez déjà cette enchère.',
  per_card_limit: 'La prochaine mise dépasse 3 500 WB ou le plafond configuré.',
  insufficient_wallet: 'Le solde disponible ne couvre pas la prochaine mise et la réserve.',
  insufficient_sales: 'Pas assez de ventes récentes pour estimer le prix.',
  above_reference_limit: 'La prochaine mise dépasse 50 % de la référence ou la limite configurée.',
  selected: 'Plus grand écart estimé parmi les occasions évaluées.',
});

export const money = value => Number.isSafeInteger(value) && value >= 0;

// Formula in the official auction detail client, observed on 2026-10-31.
// Keep its floating point rounding (including ceil(100 * 1.1) === 111).
export function nextMinimumBid(auction) {
  const current = auction?.current_bid;
  if (!money(auction?.base_amount) || auction.base_amount < 1 || (current != null && (!money(current) || current < 1))) {
    throw new PauseError('invalid_auction', REASONS.invalid_auction);
  }
  const amount = current == null ? auction.base_amount : Math.max(Math.ceil(current * 1.1), current + 1);
  if (!money(amount)) throw new PauseError('invalid_auction', REASONS.invalid_auction);
  return amount;
}

export function prefilter(auction, account, config, now = Date.now()) {
  const reject = reason => ({ eligible: false, reason, message: REASONS[reason] });
  const end = Date.parse(auction?.end_at);
  if (!auction?.id || !auction.card_id || !auction.card || !Number.isFinite(end)) return reject('invalid_auction');
  if (auction.status !== 'active') return reject('not_active');
  if ((auction.snapshot_rarity ?? auction.card.rarity) !== 'L') return reject('wrong_rarity');
  const remainingSeconds = (end - now) / 1000;
  if (remainingSeconds <= 0) return reject('expired');
  if (remainingSeconds < config.minSeconds) return reject('ending_too_soon');
  if (remainingSeconds > config.maxSeconds) return reject('ending_too_late');
  if (!auction.card.image_url || auction.card.hide_image === true) return reject('missing_image');
  if (auction.is_shiny === true || auction.card.is_shiny === true) return reject('shiny_unsupported');
  if (auction.seller_id === account.userId) return reject('own_listing');
  if (auction.current_bidder_id === account.userId) return reject('already_leading');
  let nextBid;
  try { nextBid = nextMinimumBid(auction); } catch { return reject('invalid_auction'); }
  if (nextBid > config.maxPerCard) return reject('per_card_limit');
  if (nextBid > account.balance - config.walletReserve) return reject('insufficient_wallet');
  return { eligible: true, nextBid, remainingSeconds };
}

export function buildReference(sales, auction, config, now = Date.now()) {
  if (!Array.isArray(sales)) throw new PauseError('invalid_sales_response', 'Historique des ventes illisible.');
  const unique = new Map();
  for (const sale of sales) {
    const at = Date.parse(sale?.settled_at);
    if (!sale?.id || unique.has(sale.id) || !money(sale.final_price) || sale.final_price < 1) continue;
    if (sale.rarity !== 'L' || (sale.card_id != null && sale.card_id !== auction.card_id)) continue;
    if (sale.status != null && sale.status !== 'settled_sold') continue;
    if (!Number.isFinite(at) || at > now || now - at > config.historyAgeMs) continue;
    if (sale.is_shiny === true || sale.id === auction.id) continue;
    unique.set(sale.id, sale);
  }
  const selected = [...unique.values()].sort((a, b) => Date.parse(b.settled_at) - Date.parse(a.settled_at) || a.id.localeCompare(b.id)).slice(0, config.maxSales);
  if (selected.length < config.minSales) {
    return { usable: false, reason: 'insufficient_sales', sampleCount: selected.length };
  }
  const total = selected.reduce((sum, sale) => sum + sale.final_price, 0);
  if (!money(total)) throw new PauseError('invalid_sales_response', 'Prix historiques incohérents.');
  const values = selected.map(s => s.final_price).sort((a, b) => a - b);
  return {
    usable: true,
    cardId: auction.card_id,
    rarity: 'L',
    mean: Math.round(total / selected.length),
    median: (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2,
    sampleCount: selected.length,
    saleIds: selected.map(s => s.id),
    oldestSaleAt: selected.at(-1).settled_at,
    newestSaleAt: selected[0].settled_at,
    calculatedAt: new Date(now).toISOString(),
    source: `/api/marketplace/cards/${auction.card_id}/sales`,
    variantUnknownCount: selected.filter(s => typeof s.is_shiny !== 'boolean').length,
    // The public chart uses card + rarity; exact instance stats may be absent.
    scope: 'same_card_and_rarity',
  };
}

export function evaluateCandidate(auction, reference, account, config, now = Date.now()) {
  const initial = prefilter(auction, account, config, now);
  if (!initial.eligible) return initial;
  if (!reference?.usable || reference.cardId !== auction.card_id || reference.rarity !== 'L' || !money(reference.mean) || reference.mean < 1) {
    return { eligible: false, reason: 'insufficient_sales', message: REASONS.insufficient_sales };
  }
  const ceiling = Math.min(config.maxPerCard, Math.floor(reference.mean * config.maxReferencePercent / 100), account.balance - config.walletReserve);
  if (initial.nextBid > ceiling) return { eligible: false, reason: 'above_reference_limit', message: REASONS.above_reference_limit, nextBid: initial.nextBid, ceiling };
  return {
    eligible: true,
    auctionId: auction.id,
    cardId: auction.card_id,
    title: auction.card.wikipedia_title || 'Carte sans titre',
    endAt: auction.end_at,
    nextBid: initial.nextBid,
    ceiling,
    reference,
    saving: reference.mean - initial.nextBid,
    discountPercent: Math.round((1 - initial.nextBid / reference.mean) * 10_000) / 100,
    remainingSeconds: Math.floor(initial.remainingSeconds),
  };
}

export function rankCandidates(candidates, config) {
  return candidates.filter(c => c.eligible).toSorted((a, b) => {
    const primary = config.rankBy === 'discount' ? b.discountPercent - a.discountPercent
      : config.rankBy === 'price' ? a.nextBid - b.nextBid : b.saving - a.saving;
    return primary || b.discountPercent - a.discountPercent || Date.parse(a.endAt) - Date.parse(b.endAt) || a.auctionId.localeCompare(b.auctionId);
  });
}

export function inferAccountId(mine, configuredId = null) {
  if ((mine.selling != null && !Array.isArray(mine.selling)) || (mine.won != null && !Array.isArray(mine.won))) {
    throw new PauseError('account_unknown', 'Liste des ventes ou achats du compte illisible.');
  }
  const ids = new Set([
    ...(mine.selling ?? []).map(a => a.seller_id),
    ...(mine.won ?? []).map(a => a.winner_id),
  ].filter(Boolean));
  if (configuredId && ids.size && (ids.size !== 1 || !ids.has(configuredId))) {
    throw new PauseError('account_mismatch', 'Le profil connecté ne correspond pas au compte configuré.');
  }
  if (ids.size > 1) throw new PauseError('account_unknown', 'Réponse du compte incohérente.');
  const id = configuredId || [...ids][0];
  if (!id) throw new PauseError('account_unknown', 'Compte impossible à identifier ; configurer MARKET_USER_ID ou disposer d’une vente/d’un achat passé.');
  return id;
}
