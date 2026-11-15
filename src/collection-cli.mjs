import { mkdir, readFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { PauseError, resolveBrowserProfile } from './core.mjs';
import { createState } from './state.mjs';
import { readCollectionConfig, scanCollection } from './collection-core.mjs';
import { CollectionSite } from './collection-site.mjs';
import { acquireCollectionLock, clearCollectionLock, readCollectionLock } from './collection-lock.mjs';

export const COLLECTION_COMMANDS = ['collection-login','collection-scan','collection-run','collection-status','collection-report','collection-resume','collection-unlock'];
export function collectionArguments(command, args, env) {
  const config = { ...readCollectionConfig(env) };
  let limit = Infinity, fresh = false, stopped = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply' && ['collection-scan','collection-run'].includes(command)) config.apply = true;
    else if (args[i] === '--dry-run' && ['collection-scan','collection-run'].includes(command)) config.apply = false;
    else if (args[i] === '--fresh' && ['collection-scan','collection-run'].includes(command)) fresh = true;
    else if (args[i] === '--stopped' && command === 'collection-unlock') stopped = true;
    else if (args[i] === '--limit' && command === 'collection-scan') {
      const raw = args[++i];
      if (!/^\d+$/.test(raw ?? '') || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1) throw new PauseError('invalid_arguments', '--limit exige un entier positif.');
      limit = Number(raw);
    } else throw new PauseError('invalid_arguments', `Argument inconnu ou incompatible : ${args[i]}.`);
  }
  return { config, limit, fresh, stopped };
}

export async function runCollectionCommand(command, args = [], env = process.env) {
  const { config, limit, fresh, stopped } = collectionArguments(command, args, env);
  if (env.COLLECTION_BROWSER_CHANNEL && !['chrome','msedge'].includes(env.COLLECTION_BROWSER_CHANNEL)) throw new PauseError('configuration_error', 'COLLECTION_BROWSER_CHANNEL : chrome ou msedge, ou laisser vide pour Chromium.');
  const dataDir = path.resolve(env.DATA_DIR || './data');
  const store = await createState(path.join(dataDir, 'collection', config.apply ? 'apply' : 'simulation'));
  const root = await createState(dataDir);
  const log = async (event, details = {}) => {
    const entry = { mode: config.apply ? 'apply' : 'simulation', ...details };
    // A readable console plus machine-readable JSONL on disk.
    const line = { at: new Date().toISOString(), event, ...entry };
    await appendFile(path.join(store.dir, 'events.jsonl'), `${JSON.stringify(line)}\n`, { mode: 0o600 });
    console.log(`[${line.at}] ${event} | ${details.message ?? JSON.stringify(details)}`);
  };
  const state = { ...store, log };
  if (command === 'collection-status') {
    console.log(JSON.stringify({ ...config, stateDir: store.dir, lock: await readCollectionLock(dataDir), browserProfile: resolveBrowserProfile(await root.get('browser-profile')), paused: await store.get('paused'), current: await store.get('current'), progress: await store.get('progress') }, null, 2));
    return 0;
  }
  if (command === 'collection-report') {
    const progress = await store.get('progress');
    let events = '';
    try { events = await readFile(path.join(store.dir, 'events.jsonl'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const latest = new Map();
    for (const line of events.split('\n').filter(Boolean)) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.event === 'collection_result' && event.at >= (progress?.startedAt ?? '') && event.eligible) latest.set(`${event.page}:${event.index}`, event);
    }
    console.log(JSON.stringify({ mode: config.apply ? 'apply' : 'simulation', totals: progress?.totals ?? null, complete: progress?.complete ?? false, candidates: [...latest.values()] }, null, 2));
    return 0;
  }
  if (command === 'collection-unlock') {
    if (!stopped) throw new PauseError('confirmation_required', 'Arrêter toutes les commandes collection, puis utiliser collection-unlock --stopped.');
    const { removed, previous } = await clearCollectionLock(dataDir);
    await log('collection_unlocked', { removed, previous, message: removed ? `Verrou retiré : ${previous.path}. Connexion et progression conservées.` : `Aucun verrou présent dans ${previous.path}.` });
    return 0;
  }
  let lock;
  try { lock = await acquireCollectionLock(dataDir, { command, flockHeld: env.COLLECTION_FLOCK_HELD === '1', log }); }
  catch (error) {
    if (error.code === 'collection_locked' && command === 'collection-run') {
      await log('collection_locked', { message: `${error.message} Service en attente, sans nouvel essai ni navigateur.` });
      const waiting = new AbortController();
      const finish = () => waiting.abort();
      process.once('SIGINT', finish); process.once('SIGTERM', finish);
      try { while (!waiting.signal.aborted) await sleep(15_000, undefined, { signal: waiting.signal }); }
      catch (stopped) { if (stopped.name !== 'AbortError') throw stopped; }
      finally { process.off('SIGINT', finish); process.off('SIGTERM', finish); }
      return 0;
    }
    throw error;
  }
  let context, page, site, heartbeat;
  const abort = new AbortController();
  const stop = () => { abort.abort(); context?.close().catch(() => {}); };
  const wait = ms => sleep(ms, undefined, { signal: abort.signal });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let step = 'initialisation';
  try {
    if (command === 'collection-resume') {
      await store.remove('paused');
      await log('collection_resumed', { message: 'Pause levée. Relancer collection-scan ou redémarrer le service collection.' });
      return 0;
    }
    if (command !== 'collection-login' && await store.get('paused')) {
      const paused = await store.get('paused');
      await log('collection_paused', paused);
      if (command === 'collection-run') while (!abort.signal.aborted) await wait(15_000);
      return 1;
    }
    if (command !== 'collection-login' && !fresh && (await store.get('progress'))?.complete) {
      await log('collection_complete', { message: 'Parcours déjà terminé ; --fresh permet de recommencer.' });
      if (command === 'collection-run') while (!abort.signal.aborted) await wait(15_000);
      return 0;
    }
    const profile = path.resolve(dataDir, resolveBrowserProfile(await root.get('browser-profile')));
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await log('collection_browser', { message: 'Ouverture du navigateur avec le profil de connexion conservé.' });
    const { chromium } = await import('playwright');
    context = await chromium.launchPersistentContext(profile, {
      ...(env.COLLECTION_BROWSER_CHANNEL ? { channel: env.COLLECTION_BROWSER_CHANNEL } : {}),
      headless: false, chromiumSandbox: true, locale: 'fr-FR', timezoneId: env.TZ || 'Europe/Paris',
      viewport: { width: 1280, height: 820 }, acceptDownloads: false,
    });
    page = context.pages()[0] || await context.newPage();
    context.once('close', () => {
      if (command === 'collection-login') abort.abort();
      else if (site) site.fatal = new PauseError('browser_closed', 'Le navigateur a été fermé pendant le parcours. Progression conservée.');
    });
    if (command === 'collection-login') {
      await page.goto('https://www.wiki-masters.com/collection', { waitUntil: 'domcontentloaded' });
      await log('collection_login', { message: 'Connecte-toi dans le navigateur affiché (noVNC sur VPS), puis arrête cette commande avec Ctrl+C. La session sera conservée.' });
      while (!abort.signal.aborted) await wait(15_000);
      return 0;
    }
    site = new CollectionSite(page, config, { sleep: wait, log });
    step = 'scan';
    heartbeat = setInterval(() => {
      store.get('current').then(current => log('collection_heartbeat', { current, message: current ? `En cours : page ${current.page}, carte ${current.index}, ${current.title} [${current.rarity}], étape ${current.step}.` : 'Préparation du parcours en cours.' })).catch(() => {});
    }, 30_000);
    await log('collection_started', { message: `Analyse ${config.rarities.join('/')} en ${config.apply ? 'étiquetage réel' : 'simulation'} : moyenne > ${config.minAverage} WB et ventes > ${config.minSales}.`, rarities: config.rarities, minAverage: config.minAverage, minSales: config.minSales, limit: Number.isFinite(limit) ? limit : null });
    await scanCollection(site, config, state, { limit, fresh, sleep: wait, signal: abort.signal });
    clearInterval(heartbeat);
    site.dispose(); site = null;
    context.removeAllListeners('close');
    await context.close(); context = null;
    // A completed service stays idle; no automatic rescans or account actions.
    if (command === 'collection-run') {
      while (!abort.signal.aborted) await wait(15_000);
    }
    return 0;
  } catch (error) {
    clearInterval(heartbeat);
    if (abort.signal.aborted) {
      await log('collection_stopped', { message: 'Arrêt demandé ; progression conservée. La carte en cours sera revérifiée à la reprise.' });
      return 0;
    }
    const reason = {
      at: new Date().toISOString(), code: error instanceof PauseError ? error.code : error.name === 'TimeoutError' ? 'ui_timeout' : 'technical_error',
      message: error instanceof PauseError ? error.message : `Échec à l’étape ${step} (${error.name}). Voir current.json et pause.png. ${String(error.message).split('\n')[0].replace(/https?:\/\/\S+/g, '[URL]').slice(0,200)}`,
      current: await store.get('current'),
    };
    await store.put('paused', reason);
    await page?.screenshot({ path: path.join(store.dir, 'pause.png'), fullPage: false }).catch(() => {});
    await log('collection_paused', reason);
    // Keep a VPS service paused without a browser and without repeated requests.
    if (command === 'collection-run') {
      site?.dispose(); site = null;
      if (context) { context.removeAllListeners('close'); await context.close().catch(() => {}); context = null; }
      try { while (!abort.signal.aborted) await wait(15_000); } catch (e) { if (e.name !== 'AbortError') throw e; }
    }
    return 1;
  } finally {
    clearInterval(heartbeat);
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    site?.dispose();
    await context?.close().catch(() => {});
    await lock.release();
  }
}
