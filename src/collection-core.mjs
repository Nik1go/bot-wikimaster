import { createHash } from 'node:crypto';
import { PauseError } from './core.mjs';
import { collectionCursor, locateCollectionCursor } from './collection-cursor.mjs';

export const RARITIES = Object.freeze({ C: 'Commun', PC: 'Peu commun', R: 'Rare', SR: 'Super Rare', UR: 'Ultra Rare', L: 'Légendaire' });
export const DEFAULT_RARITIES = Object.freeze(['C','PC','R']);
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
  const rarities = (env.COLLECTION_RARITIES ?? DEFAULT_RARITIES.join(',')).split(',').map(value => value.trim().toUpperCase());
  if (rarities.some(code => !Object.hasOwn(RARITIES, code)) || new Set(rarities).size !== rarities.length) {
    throw new Error('COLLECTION_RARITIES : codes distincts séparés par des virgules parmi C,PC,R,SR,UR,L (exemple : C,PC,R).');
  }
  return Object.freeze({
    apply: env.COLLECTION_APPLY === 'true', label: 'à vendre',
    rarities: Object.freeze(rarities.toSorted()),
    minAverage: number('COLLECTION_MIN_AVERAGE', 50, 0, 1e9),
    minSales: number('COLLECTION_MIN_SALES', 80, 0, 1e6, true),
    delayMs: number('COLLECTION_DELAY_SECONDS', 3, 1, 300) * 1000,
    timeoutMs: number('COLLECTION_TIMEOUT_SECONDS', 30, 5, 180) * 1000,
  });
}
export function decision(card, market, config) {
  if (!config.rarities.includes(card.rarity)) throw new PauseError('rarity_out_of_scope', `La rareté ${card.rarity} ne fait pas partie du ciblage ${config.rarities.join(',')}.`);
  if (market.rarity !== card.rarity) throw new PauseError('market_rarity_mismatch', `Carte ${card.rarity}, marché ${market.rarity ?? 'inconnu'} : aucun étiquetage sur cette carte.`);
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
  return JSON.stringify({ version: 1, sort: 'added_desc', apply: config.apply, label: config.label, minAverage: config.minAverage, minSales: config.minSales, rarities: config.rarities.toSorted() });
}

// Card-local problems can be skipped after restoring the collection view.
// Authentication, HTTP refusals, broken filters, storage and browser failures
// deliberately remain global errors rather than being swallowed here.
const CARD_ERRORS = new Set([
  'market_loading_timeout','market_rarity_unknown','market_rarity_missing',
  'market_rarity_unconfirmed','market_rarity_mismatch','market_stats_invalid','market_number_invalid',
  'card_open_timeout','card_identity_mismatch','card_rarity_mismatch',
  'label_unconfirmed','label_option_missing','collection_changed',
]);
export const isCollectionCardError = error => error instanceof PauseError ? CARD_ERRORS.has(error.code) : error?.name === 'TimeoutError';

export async function scanCollection(site, config, store, { limit = Infinity, fresh = false, sleep, signal } = {}) {
  const policy = policySignature(config);
  let progress = fresh ? null : await store.get('progress');
  if (progress && progress.policy !== policy) {
    let previous;
    try { previous = JSON.parse(progress.policy); } catch {}
    // Upgrade older C/PC/R checkpoints without resetting a paused VPS scan.
    const expected = JSON.parse(policy);
    if (previous && previous.rarities == null) previous.rarities = DEFAULT_RARITIES;
    const same = previous && Object.entries(expected).every(([key,value]) => JSON.stringify(key === 'rarities' && Array.isArray(previous[key]) ? previous[key].toSorted() : previous[key]) === JSON.stringify(value));
    if (!same) throw new PauseError('scan_policy_changed', 'Les seuils, les raretés, le mode ou le tri ont changé. Utiliser collection-resume --fresh pour préparer le nouveau parcours.');
    progress.policy = policy;
  }
  if (progress?.complete) {
    await store.log('collection_complete', { message: 'Parcours déjà terminé. --fresh démarre une nouvelle analyse.', totals: progress.totals });
    return progress;
  }
  progress ??= { version: 1, policy, startedAt: new Date().toISOString(), pages: {}, totals: { checked: 0, eligible: 0, tagged: 0, alreadyTagged: 0 }, complete: false };
  progress.totals.errors ??= 0;
  progress.totals.changes ??= 0;
  const changed = async (page, message) => {
    progress.approximate = true;
    progress.totals.changes++;
    await store.log('collection_changed', { page, message: `${message} Poursuite à partir du repère disponible ; certaines cartes peuvent être manquées ou revues.` });
  };
  await store.put('progress', progress);
  await site.prepare();
  let page = await site.readPage(), index=0, previous=[];
  const checkpoint = async () => {
    progress.cursor=collectionCursor(page,index,previous);
    progress.pages[page.number]={signature:pageSignature(page.cards),done:index};
    await store.put('progress',progress);
  };
  const locate = async cursor => {
    await store.put('current',{page:cursor.page,index:cursor.index+1,title:cursor.next[0]?.title ?? cursor.before.at(-1)?.title,step:'locating'});
    await store.log('collection_locating',{message:`Recherche de la carte de reprise : ${cursor.next[0]?.title ?? 'après '+(cursor.before.at(-1)?.title ?? 'le dernier repère')}.`});
    const found=await locateCollectionCursor(site,cursor,{signal,log:store.log});
    page=found.page; index=found.index; previous=found.previous ?? [];
    if(found.lost || found.approximate || found.skipped || page.number!==cursor.page || index!==cursor.index) {
      await changed(page.number, found.lost ? 'Les cartes repères ont disparu ; poursuite approximative.' : `Carte repérée page ${page.number}, position ${index+1}${found.skipped ? ` ; ${found.skipped} repères suivants absents ou déplacés` : ''}${found.approximate ? ' ; doublons ambigus' : ''}.`);
    }
    await store.log('collection_cursor_found',{page:page.number,index:index+1,lost:found.lost,approximate:found.approximate,message:`Reprise page ${page.number}, carte ${index+1} : ${page.cards[index]?.title ?? 'fin de page'}. ${found.lost || found.approximate ? 'Repère absent ou ambigu : reprise approximative.' : 'Les nouvelles cartes placées avant le repère sont ignorées.'}`});
    await checkpoint();
  };
  if(progress.cursor?.version===2) await locate(progress.cursor);
  else {
    const requested=progress.cursor?.page ?? Math.max(1,...Object.keys(progress.pages).map(Number));
    if(!Number.isSafeInteger(requested) || requested<1) throw new PauseError('progress_invalid','Page de reprise incohérente.');
    if(requested>1) { await site.goToPage(Math.min(requested,page.totalPages)); page=await site.readPage(); }
    index=Math.min(progress.pages[page.number]?.done ?? 0,page.cards.length);
    if(!Number.isSafeInteger(index) || index<0) throw new PauseError('progress_invalid','Position de reprise incohérente.');
    await checkpoint();
  }
  let checkedThisRun = 0;
  let announcedPage=null;
  for (;;) {
    signal?.throwIfAborted();
    const current=await site.readPage();
    if(current.number!==page.number || pageSignature(current.cards)!==pageSignature(page.cards)) {
      await changed(current.number,'La pile de cartes a changé ; recherche du repère sauvegardé.');
      await locate(progress.cursor);
    } else page=current;
    if(announcedPage!==page.number) {
      await store.log('collection_page',{page:page.number,totalPages:page.totalPages,message:`Page ${page.number}/${page.totalPages} : reprise à la position ${index+1}/${page.cards.length}.`});
      announcedPage=page.number;
    }
    if(index>=page.cards.length) {
      if(page.number>=page.totalPages) break;
      try { await site.nextPage(page.number+1); }
      catch(error) {
        signal?.throwIfAborted();
        if(!['pagination_blocked','pagination_timeout'].includes(error.code) && error.name!=='TimeoutError') throw error;
        await changed(page.number,'Passage à la page suivante interrompu ; rechargement de la collection.');
        await site.recoverCard(page.number+1);
      }
      // A page fetch can reveal buys/sales that were not visible on the old
      // page. Locate its saved tail even when the new page number looks right.
      await locate(progress.cursor);
      if(index>=page.cards.length && page.number>=page.totalPages) break;
      continue;
    }
    if (checkedThisRun >= limit) {
      await store.log('collection_limit', { message: `Limite de ${limit} cartes atteinte ; progression conservée.`, totals: progress.totals });
      return progress;
    }
    const card = page.cards[index];
    const position = { page: page.number, index: index + 1, title: card.title, rarity: card.rarity };
    await store.put('current', { ...position, step: 'opening' });
    await store.log('collection_card', { ...position, message: `${card.title} [${card.rarity}] : ouverture du marché.` });
    let choice, result;
    try {
      await site.openCard(index, card, pageSignature(page.cards));
      await store.put('current', { ...position, step: 'market' });
      const market = await site.readMarket(card);
      choice = decision(card, market, config);
      result = { ...position, ...market, ...choice, action: 'skipped' };
      if (choice.eligible) {
        await store.put('current', { ...position, step: config.apply ? 'label' : 'simulation' });
        result.action = config.apply ? await site.ensureLabel(card, config.label) : 'would_tag';
      }
      await site.closeCard();
      const actions = { skipped: 'non étiquetée', would_tag: 'à étiqueter (simulation)', tagged: 'étiquette ajoutée', already_tagged: 'déjà étiquetée' };
      const reasons = { no_sales: 'aucune vente', average_too_low: `moyenne ≤ ${config.minAverage} WB`, not_enough_sales: `ventes ≤ ${config.minSales}`, valuable_and_liquid: 'les deux seuils sont dépassés' };
      await store.log('collection_result', { ...result, message: `${card.title} [${card.rarity}] : moyenne ${market.average ?? '—'} WB, ${market.sales} ventes ; ${actions[result.action]} (${reasons[choice.reason]}).` });
    } catch (error) {
      signal?.throwIfAborted();
      if (!isCollectionCardError(error)) throw error;
      const code = error instanceof PauseError ? error.code : 'ui_timeout';
      const reason = error instanceof PauseError ? error.message : String(error.message).split('\n')[0].replace(/https?:\/\/\S+/g, '[URL]').slice(0,200);
      // Recover without retrying a write whose outcome may be uncertain.
      const step = (await store.get('current'))?.step;
      await store.put('current', { ...position, step: 'recovery', code, reason });
      await store.log('collection_recovering', { ...position, code, reason, message: `${card.title} [${card.rarity}] : ${reason} Rechargement de la collection pour continuer.` });
      await site.recoverCard(page.number);
      await store.log('collection_card_error', { ...position, code, reason, step, message: `${card.title} [${card.rarity}] : carte à revoir (${code}) — ${reason} Passage à la suivante, aucun nouveau clic d’étiquetage.` });
      progress.totals.errors++;
    }
    index++;
    progress.totals.checked++;
    if (choice?.eligible) progress.totals.eligible++;
    if (result?.action === 'tagged') progress.totals.tagged++;
    if (result?.action === 'already_tagged') progress.totals.alreadyTagged++;
    progress.updatedAt = new Date().toISOString();
    await checkpoint();
    checkedThisRun++;
    await sleep(config.delayMs);
  }
  progress.complete = true;
  progress.finishedAt = new Date().toISOString();
  await store.put('progress', progress);
  await store.remove('current');
  await store.log('collection_complete', { message: `Parcours ${config.rarities.join(',')} terminé : ${progress.totals.checked} cartes traitées, ${progress.totals.errors} erreurs à revoir, ${progress.totals.changes} changements de collection.`, totals: progress.totals, approximate: progress.approximate ?? false });
  return progress;
}
