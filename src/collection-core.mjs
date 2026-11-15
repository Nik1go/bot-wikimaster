import { createHash } from 'node:crypto';
import { PauseError } from './core.mjs';

export const RARITIES = { C: 'Commun', PC: 'Peu commun', R: 'Rare' };
export function normalize(value) {
  return String(value).normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('fr');
}
export function rarityCode(value) {
  return Object.keys(RARITIES).find(code => normalize(code) === normalize(value) || normalize(RARITIES[code]) === normalize(value)) ?? null;
}
export function frenchNumber(raw) {
  const value = String(raw).trim().replace(/[\s\u00a0\u202f]/gu, '').replace(',', '.');
  if (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isFinite(Number(value))) {
    throw new PauseError('market_number_invalid', `Nombre du marché illisible : ${String(raw).slice(0,40)}.`);
  }
  return Number(value);
}
export function readCollectionConfig(env = process.env) {
  const number = (name, fallback, min, max, integer = false) => {
    const raw = env[name] ?? String(fallback);
    if (!/^\d+(?:\.\d+)?$/.test(raw)) throw new Error(`${name} : nombre positif requis.`);
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isSafeInteger(n))) throw new Error(`${name} : valeur invalide (${min} à ${max}).`);
    return n;
  };
  if (!['true','false'].includes(env.COLLECTION_APPLY ?? 'false')) throw new Error('COLLECTION_APPLY : true ou false requis.');
  return Object.freeze({
    apply: env.COLLECTION_APPLY === 'true', label: 'à vendre',
    minAverage: number('COLLECTION_MIN_AVERAGE', 50, 0, 1e9),
    minSales: number('COLLECTION_MIN_SALES', 80, 0, 1e6, true),
    delayMs: number('COLLECTION_DELAY_SECONDS', 3, 1, 300) * 1000,
    timeoutMs: number('COLLECTION_TIMEOUT_SECONDS', 30, 5, 180) * 1000,
  });
}
export function decision(card, market, config) {
  if (!RARITIES[card.rarity]) throw new PauseError('rarity_out_of_scope', 'Seules les cartes C, PC et R peuvent être étiquetées.');
  if (market.rarity !== card.rarity) throw new PauseError('market_rarity_mismatch', `Carte ${card.rarity}, marché ${market.rarity ?? 'inconnu'} : étiquetage arrêté.`);
  if (!Number.isSafeInteger(market.sales) || market.sales < 0 || (market.sales > 0 && (!Number.isFinite(market.average) || market.average < 0))) {
    throw new PauseError('market_stats_invalid', 'Statistiques du marché incomplètes.');
  }
  if (market.sales === 0) return { eligible: false, reason: 'no_sales' };
  if (market.average <= config.minAverage) return { eligible: false, reason: 'average_too_low' };
  if (market.sales <= config.minSales) return { eligible: false, reason: 'not_enough_sales' };
  return { eligible: true, reason: 'valuable_and_liquid' };
}
// Labels are deliberately excluded: adding a label must not change identity.
export function pageSignature(cards) {
  return createHash('sha256').update(JSON.stringify(cards.map(({title,rarity,stats}) => ({title,rarity,stats})))).digest('hex');
}
export function policySignature(config) {
  return JSON.stringify({ version: 1, apply: config.apply, label: config.label, minAverage: config.minAverage, minSales: config.minSales });
}

export async function scanCollection(site, config, store, { limit = Infinity, fresh = false, sleep, signal } = {}) {
  const policy = policySignature(config);
  let progress = fresh ? null : await store.get('progress');
  if (progress && progress.policy !== policy) throw new PauseError('scan_policy_changed', 'Les seuils ou le mode ont changé. Relancer avec --fresh pour refaire le parcours.');
  if (progress?.complete) {
    await store.log('collection_complete', { message: 'Parcours déjà terminé. --fresh démarre une nouvelle analyse.', totals: progress.totals });
    return progress;
  }
  progress ??= { version: 1, policy, startedAt: new Date().toISOString(), pages: {}, totals: { checked: 0, eligible: 0, tagged: 0, alreadyTagged: 0 }, complete: false };
  await store.put('progress', progress);
  await site.prepare();
  let checkedThisRun = 0;
  for (let pageNumber = 1; ; pageNumber++) {
    signal?.throwIfAborted();
    const page = await site.readPage();
    if (page.number !== pageNumber) throw new PauseError('pagination_mismatch', 'La page affichée ne correspond pas à la progression attendue.');
    const signature = pageSignature(page.cards);
    let saved = progress.pages[pageNumber];
    if (saved && saved.signature !== signature) throw new PauseError('collection_changed', `La page ${pageNumber} a changé depuis le précédent passage. Relancer avec --fresh pour ne manquer aucune carte.`);
    saved ??= { signature, done: 0 };
    if (!Number.isSafeInteger(saved.done) || saved.done < 0 || saved.done > page.cards.length) throw new PauseError('progress_invalid', 'Progression de page incohérente.');
    progress.pages[pageNumber] = saved;
    await store.put('progress', progress);
    await store.log('collection_page', { message: `Page ${pageNumber}/${page.totalPages} : ${saved.done}/${page.cards.length} cartes déjà vérifiées.`, page: pageNumber, totalPages: page.totalPages });
    for (let index = saved.done; index < page.cards.length; index++) {
      signal?.throwIfAborted();
      if (checkedThisRun >= limit) {
        await store.log('collection_limit', { message: `Limite de ${limit} cartes atteinte ; progression conservée.`, totals: progress.totals });
        return progress;
      }
      const card = page.cards[index];
      const position = { page: pageNumber, index: index + 1, title: card.title, rarity: card.rarity };
      await store.put('current', { ...position, step: 'opening' });
      await store.log('collection_card', { ...position, message: `${card.title} [${card.rarity}] : ouverture du marché.` });
      await site.openCard(index, card, signature);
      await store.put('current', { ...position, step: 'market' });
      const market = await site.readMarket(card);
      const choice = decision(card, market, config);
      const result = { ...position, ...market, ...choice, action: 'skipped' };
      if (choice.eligible) {
        await store.put('current', { ...position, step: config.apply ? 'label' : 'simulation' });
        result.action = config.apply ? await site.ensureLabel(card, config.label) : 'would_tag';
      }
      await site.closeCard();
      // Only advance after the result is verified. An interruption during a
      // write rechecks this card and ensureLabel never toggles/removes a label.
      const actions = { skipped: 'non étiquetée', would_tag: 'à étiqueter (simulation)', tagged: 'étiquette ajoutée', already_tagged: 'déjà étiquetée' };
      const reasons = { no_sales: 'aucune vente', average_too_low: `moyenne ≤ ${config.minAverage} WB`, not_enough_sales: `ventes ≤ ${config.minSales}`, valuable_and_liquid: 'les deux seuils sont dépassés' };
      await store.log('collection_result', { ...result, message: `${card.title} [${card.rarity}] : moyenne ${market.average ?? '—'} WB, ${market.sales} ventes ; ${actions[result.action]} (${reasons[choice.reason]}).` });
      saved.done = index + 1;
      progress.totals.checked++;
      if (choice.eligible) progress.totals.eligible++;
      if (result.action === 'tagged') progress.totals.tagged++;
      if (result.action === 'already_tagged') progress.totals.alreadyTagged++;
      progress.updatedAt = new Date().toISOString();
      await store.put('progress', progress);
      checkedThisRun++;
      await sleep(config.delayMs);
    }
    if (pageNumber === page.totalPages) break;
    await site.nextPage(pageNumber + 1);
  }
  progress.complete = true;
  progress.finishedAt = new Date().toISOString();
  await store.put('progress', progress);
  await store.remove('current');
  await store.log('collection_complete', { message: 'Toutes les cartes C, PC et R ont été vérifiées.', totals: progress.totals });
  return progress;
}
