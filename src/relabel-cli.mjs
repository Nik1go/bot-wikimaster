import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { PauseError, resolveBrowserProfile } from './core.mjs';
import { createState } from './state.mjs';
import { acquireCollectionLock, readCollectionLock } from './collection-lock.mjs';
import { readRelabelConfig, restoreSaleLabels, nextRelabelStart } from './relabel-core.mjs';
import { RelabelSite } from './relabel-site.mjs';

export const RELABEL_COMMANDS = ['relabel-once', 'relabel-run', 'relabel-status', 'relabel-report', 'relabel-resume'];

export function relabelArguments(command, args, env) {
  if (!RELABEL_COMMANDS.includes(command)) throw new PauseError('invalid_command', `Commandes : ${RELABEL_COMMANDS.join(' | ')}`);
  const config = { ...readRelabelConfig(env) };
  let scheduled = false;
  for (const arg of args) {
    if (arg === '--apply') config.apply = true;
    else if (arg === '--dry-run') config.apply = false;
    else if (arg === '--scheduled' && command === 'relabel-once') scheduled = true;
    else throw new PauseError('invalid_arguments', `Argument inconnu ou incompatible : ${arg}.`);
  }
  if (env.RELABEL_BROWSER_CHANNEL && !['chrome', 'msedge'].includes(env.RELABEL_BROWSER_CHANNEL)) throw new PauseError('configuration_error', 'RELABEL_BROWSER_CHANNEL : chrome ou msedge, ou laisser vide pour Chromium.');
  return { config, scheduled };
}

// A worker owns the browser only during a daily pass. On Linux, flock is held
// across exec and released by the kernel even after a crash. No lock or browser
// is kept by the sleeping service. Collection maintenance uses the same guard.
export async function runRelabelWorker(env, config, signal) {
  const args = [fileURLToPath(new URL('./index.mjs', import.meta.url)), 'relabel-once', config.apply ? '--apply' : '--dry-run', '--scheduled'];
  const linux = process.platform === 'linux';
  const executable = linux ? 'flock' : process.execPath;
  const workerArgs = linux ? ['-n', '-E', '75', '-F', path.resolve(env.DATA_DIR || './data', 'collection.guard'), process.execPath, ...args] : args;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, workerArgs, {
      env: { ...env, COLLECTION_FLOCK_HELD: linux ? '1' : '0' }, stdio: 'inherit', windowsHide: true,
    });
    let timer;
    const stop = () => {
      child.kill('SIGTERM');
      timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      timer.unref();
    };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', code => { cleanup(); resolve(code ?? 1); });
  });
}

export async function runRelabelService(store, config, { runOnce, sleep, signal, now = Date.now }) {
  let announced = null;
  while (!signal.aborted) {
    if (await store.get('paused')) {
      if (announced !== 'paused') await store.log('relabel_idle', { message: 'Service en pause ; aucun navigateur ouvert. Corriger la cause puis utiliser relabel-resume.' });
      announced = 'paused';
      await sleep(15_000);
      continue;
    }
    const next = nextRelabelStart(await store.get('schedule'), config.intervalMs);
    if (next > now()) {
      if (announced !== next) await store.log('relabel_waiting', { nextRun: new Date(next).toISOString(), message: `Prochain passage à partir de ${new Date(next).toISOString()} ; navigateur fermé.` });
      announced = next;
      await sleep(Math.min(next - now(), 15_000));
      continue;
    }
    const result = await runOnce();
    signal.throwIfAborted();
    if (result === 75) {
      if (announced !== 'locked') await store.log('relabel_busy', { message: 'Profil occupé par le tri de collection ; nouveau contrôle dans une minute.' });
      announced = 'locked';
      await sleep(60_000);
    } else if (result !== 0 && !(await store.get('paused'))) {
      // A worker crash before its own error handler must not restart browsers
      // in a loop, even if no schedule could be saved.
      await store.put('paused', { at: new Date(now()).toISOString(), code: 'worker_failed', message: `Passage interrompu (code ${result}). Vérifier les journaux avant relabel-resume.` });
    }
  }
}

export async function runRelabelCommand(command, args = [], env = process.env, runtime = {}) {
  const { config, scheduled } = relabelArguments(command, args, env);
  const dataDir = path.resolve(env.DATA_DIR || './data');
  const store = await createState(path.join(dataDir, 'relabel', config.apply ? 'apply' : 'simulation'));
  const root = await createState(dataDir);
  if (command === 'relabel-status' || command === 'relabel-report') {
    const schedule = await store.get('schedule');
    console.log(JSON.stringify({ mode: config.apply ? 'apply' : 'simulation', stateDir: store.dir, schedule, nextRun: schedule ? new Date(nextRelabelStart(schedule, config.intervalMs)).toISOString() : null, paused: await store.get('paused'), current: await store.get('current'), plan: await store.get('plan'), lastRun: await store.get('last-run'), lock: await readCollectionLock(dataDir) }, null, 2));
    return 0;
  }
  const abort = new AbortController();
  const stop = () => { abort.abort(); context?.close().catch(() => {}); };
  const wait = runtime.sleep || (ms => sleep(ms, undefined, { signal: abort.signal }));
  let context, site, page, lock;
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    if (command === 'relabel-run') {
      await runRelabelService(store, config, { runOnce: runtime.runOnce || (() => runRelabelWorker(env, config, abort.signal)), sleep: wait, signal: abort.signal, now: runtime.now || Date.now });
      return 0;
    }
    try { lock = await acquireCollectionLock(dataDir, { command, flockHeld: env.COLLECTION_FLOCK_HELD === '1', log: store.log }); }
    catch (error) { if (error.code === 'collection_locked') { await store.log('relabel_busy', { message: error.message }); return 75; } throw error; }
    if (command === 'relabel-resume') {
      await store.remove('paused');
      await store.log('relabel_resumed', { message: 'Pause levée ; délai quotidien conservé. Un passage manuel peut être lancé avec relabel-once.' });
      return 0;
    }
    if (await store.get('paused')) { await store.log('relabel_paused', await store.get('paused')); return 1; }
    const now = runtime.now || Date.now;
    if (scheduled && nextRelabelStart(await store.get('schedule'), config.intervalMs) > now()) return 0;
    // Persist before launching Chromium so restarts cannot run early.
    await store.put('schedule', { lastStartedAt: new Date(now()).toISOString() });
    const profile = path.resolve(dataDir, resolveBrowserProfile(await root.get('browser-profile')));
    await mkdir(profile, { recursive: true, mode: 0o700 });
    const launch = runtime.launchContext || (async (profilePath, options) => {
      const { chromium } = await import('playwright');
      return chromium.launchPersistentContext(profilePath, options);
    });
    context = await launch(profile, {
      ...(env.RELABEL_BROWSER_CHANNEL ? { channel: env.RELABEL_BROWSER_CHANNEL } : {}),
      headless: false, chromiumSandbox: true, locale: 'fr-FR', timezoneId: env.TZ || 'Europe/Paris',
      viewport: { width: 1280, height: 820 }, acceptDownloads: false,
    });
    page = context.pages()[0] || await context.newPage();
    site = runtime.createSite ? runtime.createSite(page, config, { sleep: wait, log: store.log }) : new RelabelSite(page, config, { sleep: wait, log: store.log });
    await store.log('relabel_started', { mode: config.apply ? 'apply' : 'simulation', message: 'Lecture complète de l’historique, puis vérification des invendues possédées dans la collection.' });
    await restoreSaleLabels(site, config, store, { sleep: wait, signal: abort.signal });
    return 0;
  } catch (error) {
    if (abort.signal.aborted) { await store.log('relabel_stopped', { message: 'Arrêt demandé ; liste conservée. Les étiquettes seront revérifiées au prochain passage.' }); return 0; }
    const reason = { at: new Date().toISOString(), code: error instanceof PauseError ? error.code : 'technical_error', cause: error.code || error.name, message: error instanceof PauseError ? error.message : `Erreur technique (${error.code || error.name}) ; consulter les journaux et pause.png.`, current: await store.get('current') };
    await store.put('paused', reason);
    await page?.screenshot({ path: path.join(store.dir, 'pause.png'), fullPage: false }).catch(() => {});
    await store.log('relabel_paused', reason);
    return 1;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    try { site?.dispose(); if (context) await context.close(); }
    finally { await lock?.release(); }
  }
}
