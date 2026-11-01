import { open, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { readConfig, resolveBrowserProfile, PauseError } from './core.mjs';
import { createState } from './state.mjs';
import { readMarketConfig } from './market-config.mjs';
import { MarketApi } from './market-api.mjs';
import { MarketEngine } from './market-engine.mjs';
import { readMarketEvents, renderMarketReport } from './market-report.mjs';
import { marketDemo } from './market-demo.mjs';

export async function runMarketCommand(command, args = [], env = process.env) {
  if (command === 'market-compare') {
    const { runComparisonCommand } = await import('./market-compare.mjs');
    return runComparisonCommand(args);
  }
  if (command === 'market-demo') {
    console.log((await marketDemo()).report);
    return 0;
  }
  let config;
  try { config = readMarketConfig(env); }
  catch (error) { throw new PauseError('market_config_invalid', error.message); }
  const dataRoot = path.resolve(config.dataDir, 'market', config.mode);
  const store = await createState(dataRoot);
  if (command === 'market-report') {
    console.log(renderMarketReport(await readMarketEvents(store.dir), config.timezone));
    return 0;
  }
  if (command === 'market-status') {
    console.log(JSON.stringify({ mode: config.mode, liveEnabled: config.liveEnabled, maxPerCard: config.maxPerCard, maxPositions: 1, rankBy: config.rankBy, paused: await store.get('paused'), book: await store.get('book') }, null, 2));
    return 0;
  }
  const lockPath = path.join(dataRoot, 'run.lock');
  if (command === 'market-unlock') {
    // Explicit recovery only, after stopping every process using this volume.
    if (args[0] !== '--stopped') throw new PauseError('confirmation_required', 'Arrêter le service, puis utiliser market-unlock --stopped.');
    await unlink(lockPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await store.log('market_unlocked', { message: 'Verrou retiré explicitement après arrêt du service. Les mises en attente restent protégées.' });
    return 0;
  }
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new PauseError('market_locked', 'Un suivi est actif ou un ancien processus a été interrompu. Arrêter le service avant toute récupération.');
    throw error;
  }
  let context;
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const wait = ms => sleep(ms, undefined, { signal: abort.signal });
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString(), mode: config.mode }));
    if (command === 'market-resume') {
      if ((await store.get('book'))?.pending) throw new PauseError('bid_confirmation_pending', 'Utiliser market-reconcile avant resume : une mise précédente est incertaine.');
      await store.remove('paused');
      await store.log('market_resumed', { mode: config.mode, message: 'Pause du marché levée. Les plafonds et le délai horaire restent conservés.' });
      return 0;
    }
    if (command !== 'market-once' && command !== 'market-run' && command !== 'market-reconcile' && command !== 'market-link-sale') throw new PauseError('invalid_command', 'Commande de marché inconnue.');
    const loop = command === 'market-run';
    let engine;
    while (!abort.signal.aborted) {
      const paused = await store.get('paused');
      if (paused && !['market-reconcile', 'market-link-sale'].includes(command)) {
        if (!loop) { console.log(JSON.stringify({ event: 'market_paused', ...paused })); return 1; }
        // Persistent pause: no browser and no automatic reconnection/retry.
        if (context) { await context.close(); context = null; engine = null; }
        await wait(15_000);
        continue;
      }
      if (config.mode === 'live' && !config.liveEnabled && !['market-reconcile', 'market-link-sale'].includes(command)) {
        throw new PauseError('live_disabled', 'Les achats réels doivent être activés explicitement. La configuration livrée est en simulation.');
      }
      if (!context) {
        const base = readConfig(env);
        const shared = await createState(base.dataDir);
        const profile = path.resolve(base.dataDir, resolveBrowserProfile(await shared.get('browser-profile')));
        await mkdir(profile, { recursive: true, mode: 0o700 });
        const { chromium } = await import('playwright');
        context = await chromium.launchPersistentContext(profile, {
          headless: false, chromiumSandbox: true, locale: 'fr-FR', timezoneId: base.timezone,
          viewport: { width: 1280, height: 820 }, acceptDownloads: false,
        });
        // Use the normal cookie jar through Playwright's request API. No cookie
        // export, header spoofing or page scripts/background notification calls.
        const blank = await context.newPage();
        await blank.goto('about:blank');
        for (const page of context.pages()) if (page !== blank) await page.close();
        const api = new MarketApi(context.request, config, { log: (event, details) => store.log(event, { mode: config.mode, ...details }), sleep: wait });
        engine = await new MarketEngine(api, config, store).init();
        await engine.log('market_started', { message: `Marché démarré en ${config.mode}. Une carte maximum ; plafond ${config.maxPerCard} WB.`, maxPerCard: config.maxPerCard, rankBy: config.rankBy });
      }
      if (command === 'market-reconcile') return (await engine.reconcilePending()).resolved ? 0 : 1;
      if (command === 'market-link-sale') {
        if (args.length !== 2) throw new PauseError('invalid_arguments', 'market-link-sale ID_ACHAT ID_REVENTE');
        await engine.linkResale(args[0], args[1]);
        return 0;
      }
      try {
        const result = await engine.tick();
        if (!loop && !['following', 'leading', 'observing', 'awaiting_settlement', 'watching_only', 'too_late_to_counterbid'].includes(result.state)) return result.state === 'paused' ? 1 : 0;
        // Keep sleeps short enough for responsive shutdown. Decisions, reads
        // and counterbids still follow the configured (>= 10 s) interval.
        let remaining = result.delayMs;
        while (remaining > 0) { const step = Math.min(remaining, 15_000); await wait(step); remaining -= step; }
      } catch (error) {
        if (abort.signal.aborted) break;
        await engine.pause(error);
        await context.close(); context = null; engine = null;
        if (!loop) return 1;
      }
    }
    return 0;
  } catch (error) {
    if (abort.signal.aborted && error.name === 'AbortError') return 0;
    if (!['market-resume', 'market-link-sale', 'market-reconcile'].includes(command)) {
      await store.put('paused', { at: new Date().toISOString(), code: error instanceof PauseError ? error.code : 'technical_error', message: error instanceof PauseError ? error.message : 'Initialisation impossible ; aucun nouvel essai automatique.' });
    }
    throw error;
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    await context?.close().catch(() => {});
    await lock.close();
    await unlink(lockPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
