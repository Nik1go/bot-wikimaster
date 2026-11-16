// Integration with the actual browser adapter, against a local site only.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { readRelabelConfig, restoreSaleLabels } from '../src/relabel-core.mjs';
import { RelabelSite } from '../src/relabel-site.mjs';

const { chromium } = await import(process.env.RELABEL_TEST_PLAYWRIGHT || 'playwright');
const inventory = [
  { title: 'Edie Falco', rarity: 'SR', stats: ['6 769', '4 579'] },
  { title: 'Broad Peak', rarity: 'SR', stats: ['6 363', '6 039'] },
  { title: 'Stellantis', rarity: 'UR', stats: ['8 572', '8 098'] },
  { title: 'Doublon', rarity: 'R', stats: ['4 000', '3 000'] },
  { title: 'Doublon', rarity: 'R', stats: ['4 000', '3 000'] },
  { title: 'Même titre', rarity: 'PC', stats: ['3 001', '2 000'] },
  { title: 'Même titre', rarity: 'PC', stats: ['3 000', '2 000'] },
];
const history = [
  { ...inventory[0], owned: true, status: 'unsold' },
  { ...inventory[1], owned: true, status: 'unsold' },
  { ...inventory[0], owned: true, status: 'unsold' },
  { ...inventory[2], owned: true, status: 'unsold' },
  { ...inventory[3], owned: true, status: 'unsold' },
  { ...inventory[6], owned: true, status: 'unsold' },
  { title: 'Absente', rarity: 'L', stats: ['9000', '8000'], owned: true, status: 'unsold' },
  { title: 'Vendue', rarity: 'R', stats: ['4000', '3000'], owned: true, status: 'sold' },
  { title: 'Partie', rarity: 'C', stats: ['1000', '2000'], owned: false, status: 'unsold' },
];
let labels = new Set([0]), writes = [], refusal = false, persist = true, brokenHistory = false, expired = false;
const names = { C: 'Commun', PC: 'Peu commun', R: 'Rare', SR: 'Super Rare', UR: 'Ultra Rare', L: 'Légendaire' };
const template = await readFile(new URL('./fixtures/relabel.html', import.meta.url), 'utf8');
const server = createServer(async (req, res) => {
  if (req.method === 'POST') {
    let raw = ''; for await (const part of req) raw += part;
    const { id } = JSON.parse(raw);
    writes.push(id);
    if (!refusal && persist) labels.add(id);
    res.writeHead(refusal ? 429 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(refusal ? { error: 'rate limit' } : { ok: true }));
    return;
  }
  if (expired && req.url === '/marketplace') { res.writeHead(302, { location: '/login' }); res.end(); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(template.replace('__INVENTORY__', JSON.stringify(inventory)).replace('__HISTORY__', JSON.stringify(history))
    .replace('__NAMES__', JSON.stringify(names)).replace('__LABELS__', JSON.stringify([...labels])).replace('__BROKEN__', JSON.stringify(brokenHistory)));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ headless: true, chromiumSandbox: true,
  ...(process.env.RELABEL_TEST_CHANNEL ? { channel: process.env.RELABEL_TEST_CHANNEL } : {}),
  ...(process.env.RELABEL_TEST_EXECUTABLE ? { executablePath: process.env.RELABEL_TEST_EXECUTABLE } : {}),
});
const memory = () => { const data = new Map(); return { get: async k => structuredClone(data.get(k) ?? null), put: async (k, v) => data.set(k, structuredClone(v)), remove: async k => data.delete(k), log: async () => {} }; };
try {
  const page = await browser.newPage();
  page.on('pageerror', error => console.error(error));
  const config = { ...readRelabelConfig({}), delayMs: 0, timeoutMs: 2500 };
  const run = async apply => {
    const store = memory(), site = new RelabelSite(page, { ...config, apply }, { sleep, log: store.log, baseUrl: origin });
    try { return await restoreSaleLabels(site, { ...config, apply }, store, { sleep }); }
    finally { site.dispose(); }
  };
  const dry = await run(false);
  assert.equal(dry.historyCount, 9); assert.equal(dry.duplicateCount, 1);
  assert.equal(dry.totals.alreadyTagged, 1); assert.equal(dry.totals.wouldTag, 3);
  assert.equal(dry.totals.ambiguous, 1); assert.equal(dry.totals.missing, 1);
  assert.deepEqual(writes, []);
  const applied = await run(true);
  assert.equal(applied.totals.tagged, 3); assert.equal(applied.totals.errors, 0);
  assert.deepEqual(writes, [1, 2, 6], 'Le même titre avec des statistiques différentes ne doit pas être étiqueté.');
  const again = await run(true);
  assert.equal(again.totals.alreadyTagged, 4); assert.deepEqual(writes, [1, 2, 6]);
  console.log('OK : historique paginé, plan complet, filtres réinitialisés, toutes raretés, statistiques, doublons physiques, étiquettes déjà présentes et persistées.');
  labels = new Set([0]); writes = []; persist = false;
  const optimistic = await run(true);
  assert.equal(optimistic.totals.tagged, 0); assert.equal(optimistic.totals.errors, 3);
  assert.deepEqual(writes, [1, 2, 6], 'Un clic incertain ne doit pas être répété.');
  persist = true; writes = []; refusal = true;
  await assert.rejects(run(true), { code: 'rate_limited' });
  assert.deepEqual(writes, [1]);
  refusal = false; brokenHistory = true; writes = [];
  await assert.rejects(run(true), { code: 'history_incomplete' }); assert.deepEqual(writes, []);
  brokenHistory = false; expired = true;
  await assert.rejects(run(true), { code: 'login_required' }); assert.deepEqual(writes, []);
  console.log('OK : sauvegarde optimiste non persistée, refus HTTP 429 sans nouvel essai, historique incomplet et session expirée.');
} finally {
  await browser.close();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
