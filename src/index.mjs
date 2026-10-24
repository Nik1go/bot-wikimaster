import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { readConfig, runBatch, nextAllowedStart, resolveBrowserProfile, PauseError } from './core.mjs';
import { createState } from './state.mjs';
import { WikiMastersSite } from './site.mjs';

process.umask(0o077);
const mode = process.argv[2] || 'run';
if (!['login', 'check', 'once', 'run', 'resume', 'status', 'smoke', 'manual', 'manual-smoke', 'use-manual-session'].includes(mode)) {
  console.error('Commande : login | check | once | run | resume | status | smoke | manual | manual-smoke | use-manual-session');
  process.exit(2);
}
const config = readConfig();
const state = await createState(config.dataDir);
if (mode === 'resume') {
  await state.remove('paused');
  await state.log('resumed', { message: 'Pause levée. Le délai horaire reste respecté.' });
  process.exit(0);
}
if (mode === 'status') {
  console.log(JSON.stringify({ browserProfile: resolveBrowserProfile(await state.get('browser-profile')), paused: await state.get('paused'), schedule: await state.get('schedule'), lastRun: await state.get('last-run') }, null, 2));
  process.exit(0);
}
if (mode === 'use-manual-session') {
  const name = 'manual-chromium';
  let exists = false;
  try { exists = (await stat(path.resolve(config.dataDir, name, 'Default'))).isDirectory(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!exists) {
    await state.log('manual_profile_missing', { message: 'Ouvre le mode manual et connecte-toi avant de sélectionner sa session.' });
    process.exit(1);
  }
  // Store only a profile name. Authentication remains inside the private volume;
  // no cookie, token or password is exported, copied or logged.
  await state.put('browser-profile', { name });
  await state.log('browser_profile_selected', { name, message: 'Profil manuel sélectionné pour le bot. Arrête le navigateur manuel avant check/once/run.' });
  process.exit(0);
}

const { chromium } = await import('playwright');
if (mode === 'manual' || mode === 'manual-smoke') {
  // Only obtain the installed executable path. No Playwright browser or page
  // is created or attached to this manually operated process.
  const { runManualBrowser } = await import('./manual.mjs');
  process.exit(await runManualBrowser(chromium.executablePath(), config, state.log, mode === 'manual-smoke'));
}
const selectedProfile = resolveBrowserProfile(await state.get('browser-profile'));
const profile = path.resolve(config.dataDir, selectedProfile);
await mkdir(profile, { recursive: true, mode: 0o700 });
const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  chromiumSandbox: true,
  locale: 'fr-FR',
  timezoneId: config.timezone,
  viewport: { width: 1280, height: 820 },
  acceptDownloads: false,
});
const page = context.pages()[0] || await context.newPage();
const site = new WikiMastersSite(page, config);
const abort = new AbortController();
let stopping = false;
function stop() {
  stopping = true;
  abort.abort();
  context.close().catch(() => {});
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
context.once('close', () => { stopping = true; abort.abort(); });
async function wait(ms) {
  try { await sleep(ms, undefined, { signal: abort.signal }); }
  catch (error) { if (error.name !== 'AbortError') throw error; }
}
async function pause(error) {
  const reason = error instanceof PauseError
    ? { code: error.code, message: error.message }
    : { code: 'technical_error', message: 'Erreur technique ; consulter le navigateur avant de reprendre.' };
  await state.put('paused', { at: new Date().toISOString(), ...reason });
  await state.log('paused', reason);
  await page.screenshot({ path: path.join(state.dir, 'pause.png'), fullPage: true }).catch(() => {});
}

try {
  if (mode === 'smoke') {
    await page.goto('about:blank');
    await state.log('browser_smoke_ok', { message: 'Chromium avec interface et bac à sable opérationnels. Aucun accès au jeu.' });
  } else if (mode === 'login') {
    await page.goto(`${config.baseUrl}/pulls`, { waitUntil: 'domcontentloaded' });
    await state.log('manual_login', { message: 'Connecte-toi dans noVNC. Aucune ouverture dans ce mode. Arrête ensuite le conteneur.' });
    while (!stopping) await wait(10_000);
  } else if (mode === 'check') {
    const inventory = await site.prepare();
    await state.log('check_ok', inventory);
    await page.screenshot({ path: path.join(state.dir, 'last.png'), fullPage: true });
  } else {
    while (!stopping) {
      if (await state.get('paused')) {
        if (mode === 'once') throw new PauseError('paused', 'Pause active. Vérifie la session puis utilise resume.');
        await wait(15_000);
        continue;
      }
      const schedule = await state.get('schedule');
      const next = nextAllowedStart(schedule?.lastStartedAt, config.intervalMs);
      const remaining = next - Date.now();
      if (remaining > 0) {
        if (mode === 'once') {
          await state.log('hourly_limit', { nextRun: new Date(next).toISOString() });
          break;
        }
        await wait(Math.min(remaining, 15_000));
        continue;
      }
      // Persist before clicking: container restarts cannot retry a batch early.
      await state.put('schedule', { lastStartedAt: new Date().toISOString() });
      try {
        const result = await runBatch(site, config, { sleep: wait, log: state.log });
        await state.put('last-run', { at: new Date().toISOString(), ...result });
        await page.screenshot({ path: path.join(state.dir, 'last.png'), fullPage: true });
      } catch (error) {
        if (stopping) break;
        await pause(error);
        if (mode === 'once') process.exitCode = 1;
      }
      if (mode === 'once') break;
    }
  }
} catch (error) {
  if (!stopping) { await pause(error); process.exitCode = 1; }
} finally {
  await context.close().catch(() => {});
}
