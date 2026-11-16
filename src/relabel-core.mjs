import { PauseError } from './core.mjs';
import { frenchNumber, normalize, RARITIES, isCollectionCardError } from './collection-core.mjs';

export function readRelabelConfig(env = process.env) {
  if (!['true', 'false'].includes(env.RELABEL_APPLY ?? 'false')) throw new Error('RELABEL_APPLY : true ou false requis.');
  const seconds = (name, fallback, min, max) => {
    const raw = env[name] ?? String(fallback);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < min || Number(raw) > max) throw new Error(`${name} : entier de ${min} à ${max} requis.`);
    return Number(raw) * 1000;
  };
  return Object.freeze({
    apply: env.RELABEL_APPLY === 'true', label: 'à vendre',
    rarities: Object.freeze(Object.keys(RARITIES)),
    intervalMs: 24 * 60 * 60 * 1000,
    delayMs: seconds('RELABEL_DELAY_SECONDS', 3, 1, 300),
    timeoutMs: seconds('RELABEL_TIMEOUT_SECONDS', 30, 5, 180),
  });
}

// No instance ID is exposed by the cards. Include both displayed statistics;
// never identify an inventory card by title alone.
export function relabelIdentity(card) {
  if (!card || typeof card.title !== 'string' || !card.title.trim() || !Object.hasOwn(RARITIES, card.rarity) || !Array.isArray(card.stats) || card.stats.length !== 2) {
    throw new PauseError('history_card_invalid', 'Identité de carte incomplète dans l’historique.');
  }
  return JSON.stringify([normalize(card.title), card.rarity, card.stats.map(frenchNumber)]);
}

export function buildRelabelPlan(history) {
  if (!Array.isArray(history)) throw new PauseError('history_invalid', 'Historique illisible.');
  const candidates = new Map();
  const listings = new Set();
  let eligible = 0;
  for (const entry of history) {
    const key = relabelIdentity(entry);
    if (typeof entry.owned !== 'boolean' || !['unsold', 'sold'].includes(entry.status) || typeof entry.href !== 'string' || !/^\/marketplace\/[a-zA-Z0-9-]+$/.test(entry.href) || listings.has(entry.href)) {
      throw new PauseError('history_invalid', 'Statut ou référence de vente incohérent dans l’historique.');
    }
    listings.add(entry.href);
    if (entry.status !== 'unsold' || !entry.owned) continue;
    eligible++;
    if (candidates.has(key)) candidates.get(key).listings.push(entry.href);
    else candidates.set(key, { key, title: entry.title, rarity: entry.rarity, stats: [...entry.stats], listings: [entry.href], action: 'pending' });
  }
  return {
    version: 1, startedAt: new Date().toISOString(), phase: 'apply', complete: false,
    historyCount: history.length, duplicateCount: eligible - candidates.size,
    candidates: [...candidates.values()],
    totals: { candidates: candidates.size, checked: 0, tagged: 0, alreadyTagged: 0, wouldTag: 0, missing: 0, ambiguous: 0, errors: 0 },
  };
}

export function nextRelabelStart(schedule, intervalMs) {
  if (!schedule) return 0;
  const at = Date.parse(schedule.lastStartedAt);
  if (!Number.isFinite(at)) throw new PauseError('schedule_invalid', 'Date du dernier passage illisible.');
  return at + intervalMs;
}

export async function restoreSaleLabels(site, config, store, { sleep, signal } = {}) {
  signal?.throwIfAborted();
  // The entire history is collected and the deduplicated plan saved BEFORE
  // opening any inventory card or performing any mutation.
  await store.put('current', { step: 'history' });
  const history = await site.readHistory();
  signal?.throwIfAborted();
  const plan = { ...buildRelabelPlan(history), apply: config.apply };
  await store.put('plan', plan);
  await store.log('relabel_plan', { historyCount: plan.historyCount, duplicateCount: plan.duplicateCount, totals: plan.totals, message: `${plan.historyCount} ventes lues ; ${plan.candidates.length} cartes à vérifier, ${plan.duplicateCount} répétitions écartées.` });
  for (const candidate of plan.candidates) {
    signal?.throwIfAborted();
    await store.put('current', { title: candidate.title, rarity: candidate.rarity, step: 'inventory' });
    try {
      const status = await site.openCandidate(candidate);
      if (status === 'missing' || status === 'ambiguous') candidate.action = status;
      else if (status !== 'open') throw new PauseError('inventory_invalid', 'Résultat de recherche de carte inconnu.');
      else {
        await store.put('current', { title: candidate.title, rarity: candidate.rarity, step: 'label' });
        if (await site.hasSaleLabel(candidate)) candidate.action = 'already_tagged';
        else candidate.action = config.apply ? await site.ensureLabel(candidate, config.label) : 'would_tag';
        if (!['tagged', 'already_tagged', 'would_tag'].includes(candidate.action)) throw new PauseError('label_unconfirmed', 'Résultat d’étiquetage inconnu.');
        await site.closeCard();
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (!isCollectionCardError(error)) throw error;
      // Never repeat an uncertain label click within a run. The next daily
      // scan reads the actual label again, including after a process crash.
      candidate.action = 'error';
      candidate.code = error.code || 'ui_timeout';
      await site.recoverCandidate();
    }
    const counter = { tagged: 'tagged', already_tagged: 'alreadyTagged', would_tag: 'wouldTag', missing: 'missing', ambiguous: 'ambiguous', error: 'errors' }[candidate.action];
    plan.totals[counter]++;
    plan.totals.checked++;
    plan.updatedAt = new Date().toISOString();
    await store.put('plan', plan);
    await store.log('relabel_result', { ...candidate, message: `${candidate.title} [${candidate.rarity}] : ${candidate.action}${candidate.code ? ` (${candidate.code})` : ''}.` });
    await sleep(config.delayMs);
  }
  plan.phase = 'complete';
  plan.complete = true;
  plan.finishedAt = new Date().toISOString();
  await store.put('plan', plan);
  await store.put('last-run', plan);
  await store.remove('current');
  await store.log('relabel_complete', { totals: plan.totals, message: `Passage terminé : ${plan.totals.tagged} étiquettes ajoutées, ${plan.totals.alreadyTagged} déjà présentes, ${plan.totals.errors} erreurs, ${plan.totals.ambiguous} cartes ambiguës.` });
  return plan;
}
