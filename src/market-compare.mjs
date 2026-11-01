import { readFile, stat } from 'node:fs/promises';
import { PauseError } from './core.mjs';
import { readMarketConfig } from './market-config.mjs';
import { money, prefilter, buildReference, evaluateCandidate, rankCandidates } from './market-selection.mjs';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const invalid = message => new PauseError('comparison_input_invalid', message);

function validateSnapshot(snapshot) {
  if (snapshot?.schemaVersion !== 1 || !['fictional', 'saved_snapshot'].includes(snapshot.source)) {
    throw invalid('Format requis : schemaVersion=1, source=fictional ou saved_snapshot.');
  }
  if (typeof snapshot.observedAt !== 'string' || !/^\d{4}-\d\d-\d\dT.+(?:Z|[+-]\d\d:\d\d)$/.test(snapshot.observedAt) || !Number.isFinite(Date.parse(snapshot.observedAt))) {
    throw invalid('observedAt doit être une date ISO avec fuseau.');
  }
  const account = snapshot.account;
  if (typeof account?.userId !== 'string' || !account.userId.trim() || !money(account.balance) || typeof account.positionOccupied !== 'boolean' || !money(account.reserveWB ?? 0)) {
    throw invalid('account doit fournir userId, balance, positionOccupied et une réserve WB valide si renseignée.');
  }
  if (!Array.isArray(snapshot.auctions) || snapshot.auctions.length > 1000 || !snapshot.salesByCard || typeof snapshot.salesByCard !== 'object' || Array.isArray(snapshot.salesByCard)) {
    throw invalid('Au plus 1 000 annonces et un objet salesByCard sont requis.');
  }
  const ids = new Set();
  for (const auction of snapshot.auctions) {
    if (typeof auction?.id !== 'string' || !auction.id || ids.has(auction.id)) throw invalid('Chaque annonce doit avoir un identifiant unique.');
    ids.add(auction.id);
  }
  for (const sales of Object.values(snapshot.salesByCard)) {
    if (!Array.isArray(sales) || sales.length > 10_000) throw invalid('Chaque historique doit être un tableau de 10 000 ventes au plus.');
  }
}

export function compareStrategies(snapshot) {
  validateSnapshot(snapshot);
  // Ignore process.env: this is an offline comparison, independent of live mode.
  const config = { ...readMarketConfig({}), minSales: 5, walletReserve: snapshot.account.reserveWB ?? 0 };
  const now = Date.parse(snapshot.observedAt);
  const account = { userId: snapshot.account.userId, balance: snapshot.account.balance };
  const occupied = snapshot.account.positionOccupied || snapshot.auctions.some(a => a.status === 'active' && a.current_bidder_id === account.userId);
  const references = new Map();
  for (const auction of snapshot.auctions) {
    if (!prefilter(auction, account, config, now).eligible) continue;
    const sales = Object.hasOwn(snapshot.salesByCard, auction.card_id) ? snapshot.salesByCard[auction.card_id] : [];
    references.set(auction.id, buildReference(sales, auction, config, now));
  }
  const strategies = [20, 30].map(minDiscountPercent => {
    const scenario = { ...config, maxReferencePercent: 100 - minDiscountPercent };
    const candidates = snapshot.auctions.map(auction => {
      const reference = references.get(auction.id) ?? null;
      // Reuse the price/budget checks with P25 as their price basis. Keep the
      // actual historical mean in the exported reference rather than relabel it.
      const evaluation = evaluateCandidate(auction, reference?.usable ? { ...reference, mean: reference.lowerQuartile } : reference, account, scenario, now);
      const row = {
        ...evaluation,
        auctionId: auction.id,
        cardId: auction.card_id ?? null,
        title: typeof auction.card?.wikipedia_title === 'string' ? auction.card.wikipedia_title : 'Carte sans titre',
        reference,
        priceReference: reference?.usable ? reference.lowerQuartile : null,
        referenceMethod: 'lower_quartile_nearest_rank',
      };
      if (row.reason === 'above_reference_limit') row.message = `La prochaine mise dépasse le plafond conservant ${minDiscountPercent} % de décote.`;
      if (occupied) return { ...row, eligible: false, reason: 'position_occupied', message: 'Une position occupe déjà la place disponible.' };
      return row;
    });
    const ranked = rankCandidates(candidates, scenario);
    const ranks = new Map(ranked.map((candidate, index) => [candidate.auctionId, index + 1]));
    return {
      minDiscountPercent,
      eligibleCount: ranked.length,
      selectedAuctionId: ranked[0]?.auctionId ?? null,
      candidates: candidates.map(candidate => ({
        ...candidate,
        rank: ranks.get(candidate.auctionId) ?? null,
        selected: candidate.auctionId === ranked[0]?.auctionId,
        message: candidate.eligible ? (candidate.auctionId === ranked[0]?.auctionId ? 'Retenue : première au classement par écart en WB, puis décote et échéance.' : 'Admissible ; une autre carte est classée avant elle.') : candidate.message,
      })),
    };
  });
  return {
    source: snapshot.source,
    observedAt: snapshot.observedAt,
    limits: { maxPositions: 1, maxPerCard: config.maxPerCard, walletBalance: account.balance, walletReserve: config.walletReserve, positionOccupied: occupied },
    referencePolicy: { method: 'lower_quartile_nearest_rank', minSales: config.minSales, maxSales: config.maxSales, historyDays: config.historyAgeMs / 86_400_000, scope: 'same_card_and_rarity' },
    strategies,
  };
}

const cell = value => String(value ?? '—').replace(/[|\\`*_<>\[\]\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 180);

export function renderComparison(result) {
  const lines = [
    '# Comparaison hors ligne : décote de 20 % / 30 %', '',
    result.source === 'fictional' ? '**DONNÉES FICTIVES — vérification du fonctionnement uniquement.**' : '**Observation enregistrée — provenance et exhaustivité non vérifiées par cet outil.**', '',
    `Observation : ${cell(result.observedAt)}. Une position par scénario ; plafond ${result.limits.maxPerCard} WB ; solde ${result.limits.walletBalance} WB ; réserve ${result.limits.walletReserve} WB.`, '',
    'Référence : quartile inférieur empirique (rang ⌈n/4⌉), au moins 5 et au plus 10 ventes récentes sur 30 jours, filtrées à la date de l’observation.', '',
    '| Décote minimale | Admissibles | Carte retenue | Mise proposée WB | Référence WB | Écart brut WB | Plafond WB |',
    '| --- | ---: | --- | ---: | ---: | ---: | ---: |',
  ];
  for (const strategy of result.strategies) {
    const chosen = strategy.candidates.find(c => c.selected);
    lines.push(`| ${strategy.minDiscountPercent} % | ${strategy.eligibleCount} | ${cell(chosen?.title)} | ${cell(chosen?.nextBid)} | ${cell(chosen?.priceReference)} | ${cell(chosen?.saving)} | ${cell(chosen?.ceiling)} |`);
  }
  lines.push('', '| Carte | Ventes retenues / variante inconnue | Référence WB | Résultat à 20 % | Résultat à 30 % |', '| --- | ---: | ---: | --- | --- |');
  for (let i = 0; i < result.strategies[0].candidates.length; i++) {
    const a = result.strategies[0].candidates[i];
    const b = result.strategies[1].candidates[i];
    const status = c => `${c.selected ? 'RETENUE' : c.eligible ? 'ADMISSIBLE' : `REJET : ${c.reason}`} — ${c.message}`;
    lines.push(`| ${cell(a.title)} | ${a.reference ? `${a.reference.sampleCount} / ${a.reference.variantUnknownCount ?? '—'}` : '—'} | ${cell(a.priceReference)} | ${cell(status(a))} | ${cell(status(b))} |`);
  }
  lines.push('', 'Les scénarios sont indépendants : leurs mises ne sont ni envoyées ni cumulées. Le classement reste le plus grand écart en WB.', '',
    'Les écarts sont avant frais. La référence porte sur la même carte et la rareté L ; elle ne garantit pas des statistiques ou variantes identiques. Les variantes non renseignées sont signalées.', '',
    'La concurrence et le délai de revente ne sont pas modélisés. Aucun gagnant, vente ou bénéfice réalisé n’est déduit de cette comparaison.');
  return lines.join('\n');
}

export function comparisonDemoSnapshot() {
  const observedAt = '2026-11-01T12:00:00Z';
  const definitions = [
    ['a', 'Démo A : décote discrète', 3100, [4000, 4000, 4000, 4000, 4000]],
    ['b', 'Démo B : décote plus forte', 1600, [2400, 2400, 2400, 2400, 2400]],
    ['c', 'Démo C : moyenne gonflée', 2300, [2000, 2000, 2000, 2000, 10000]],
    ['d', 'Démo D : budget dépassé', 3600, [6000, 6000, 6000, 6000, 6000]],
  ];
  return {
    schemaVersion: 1, source: 'fictional', observedAt,
    account: { userId: 'demo-buyer', balance: 5000, positionOccupied: false, reserveWB: 0 },
    auctions: definitions.map(([id, title, amount]) => ({
      id: `auction-${id}`, card_id: `card-${id}`, seller_id: 'demo-seller', status: 'active',
      base_amount: amount, current_bid: null, current_bidder_id: null, snapshot_rarity: 'L', is_shiny: false,
      end_at: '2026-11-01T12:01:30Z',
      card: { rarity: 'L', wikipedia_title: title, image_url: 'https://example.invalid/demo.png', hide_image: false },
    })),
    salesByCard: Object.fromEntries(definitions.map(([id, , , prices]) => [`card-${id}`, prices.map((price, index) => ({
      id: `sale-${id}-${index}`, card_id: `card-${id}`, rarity: 'L', final_price: price, is_shiny: false,
      settled_at: new Date(Date.parse(observedAt) - (index + 1) * 86_400_000).toISOString(),
    }))])),
  };
}

export async function runComparisonCommand(args) {
  const positional = args.filter(arg => arg !== '--json');
  if (positional.length !== 1 || args.filter(arg => arg === '--json').length > 1 || (positional[0].startsWith('--') && positional[0] !== '--demo')) {
    throw new PauseError('invalid_arguments', 'market-compare --demo|FICHIER.json [--json]');
  }
  let snapshot;
  if (positional[0] === '--demo') snapshot = comparisonDemoSnapshot();
  else {
    let raw;
    try {
      const info = await stat(positional[0]);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) throw invalid('Fichier JSON régulier de 8 Mio au plus requis.');
      raw = await readFile(positional[0], 'utf8');
      if (Buffer.byteLength(raw, 'utf8') > MAX_FILE_BYTES) throw invalid('Fichier JSON de 8 Mio au plus requis.');
    } catch (error) {
      if (error instanceof PauseError) throw error;
      throw invalid('Impossible de lire le fichier JSON demandé.');
    }
    try { snapshot = JSON.parse(raw.replace(/^\uFEFF/, '')); }
    catch { throw invalid('Le fichier ne contient pas un JSON valide.'); }
  }
  const result = compareStrategies(snapshot);
  console.log(args.includes('--json') ? JSON.stringify(result, null, 2) : renderComparison(result));
  return 0;
}
