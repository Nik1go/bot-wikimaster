import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';

// A manual compatibility test on the same VPS/network. No automation protocol
// is attached here. Later bot reuse requires the explicit use-manual-session command.
export async function runManualBrowser(executable, config, log, smoke = false) {
  const profile = path.resolve(config.dataDir, smoke ? 'manual-smoke' : 'manual-chromium');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  const child = spawn(executable, [
    `--user-data-dir=${profile}`,
    '--no-first-run',
    smoke ? 'about:blank' : `${config.baseUrl}/login`,
  ], { stdio: 'inherit' });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  let stopping = false;
  const stop = () => { stopping = true; child.kill('SIGTERM'); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    if (smoke) {
      const earlyExit = await Promise.race([
        exited.then(result => ({ result })),
        sleep(4000).then(() => null),
      ]);
      if (earlyExit) throw new Error(`manual_browser_exited_early: ${earlyExit.result.code ?? earlyExit.result.signal}`);
      stop();
      await exited;
      await log('manual_browser_smoke_ok', { message: 'Chromium lancé directement sur une page vide, sans pilotage Playwright.' });
      return 0;
    }
    await log('manual_browser_started', {
      message: 'Navigateur manuel : utilise noVNC pour te connecter. Aucun clic automatique. Le bot reste sur son profil habituel tant que use-manual-session n’a pas été exécuté.',
    });
    const result = await exited;
    return stopping ? 0 : result.code ?? 1;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
}
