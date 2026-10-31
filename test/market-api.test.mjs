import test from 'node:test';
import assert from 'node:assert/strict';
import { MarketApi } from '../src/market-api.mjs';
import { readMarketConfig } from '../src/market-config.mjs';

const ID = '00000000-0000-4000-8000-000000000001';
function fixture(replies, env = {}) {
  const calls = [];
  const events = [];
  let clock = 1000;
  const request = { fetch: async (url, options) => {
    calls.push({ url, options, at: clock });
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return {
      status: () => reply.status ?? 200,
      json: async () => { if (reply.invalidJson) throw new Error('html'); return reply.body; },
      dispose: async () => {},
    };
  } };
  const api = new MarketApi(request, readMarketConfig(env), {
    now: () => clock, sleep: async ms => { clock += ms; },
    log: async (event, details) => { events.push({ event, ...details }); },
  });
  return { api, calls, events };
}

test('simulation : aucun POST, même en appelant directement bid', async () => {
  const { api, calls } = fixture([]);
  await assert.rejects(api.bid(ID, 100), error => error.code === 'live_disabled');
  assert.equal(calls.length, 0);
});

test('requêtes espacées, redirections et retries désactivés, endpoint de portefeuille connu', async () => {
  const { api, calls } = fixture([{ body: { balance: 500 } }, { body: { balance: 400 } }]);
  assert.equal(await api.wallet(), 500);
  assert.equal(await api.wallet(), 400);
  assert.equal(calls[1].at - calls[0].at, 2000);
  assert.equal(calls[0].url, 'https://www.wiki-masters.com/api/wikibidous');
  assert.equal(calls[0].options.maxRetries, 0);
  assert.equal(calls[0].options.maxRedirects, 0);
});

test('automation_limit, vérification, refus et quota bloquent tous les appels suivants', async () => {
  for (const [status, code] of [[429, 'automation_limit'], [403, 'human_verification_required'], [403, undefined], [401, undefined], [429, undefined], [403, 'pro_required']]) {
    const { api, calls, events } = fixture([{ status, body: { code, error: 'NE_PAS_JOURNALISER_CE_CONTENU' } }]);
    await assert.rejects(api.wallet());
    await assert.rejects(api.wallet(), error => error.code === 'api_paused');
    assert.equal(calls.length, 1);
    assert.ok(!JSON.stringify(events).includes('NE_PAS_JOURNALISER_CE_CONTENU'));
  }
});

test('timeout POST et HTML de challenge gardent le résultat incertain, sans renvoi', async () => {
  for (const reply of [new Error('timeout'), { status: 403, invalidJson: true }]) {
    const { api, calls } = fixture([reply], { MARKET_MODE: 'live', MARKET_LIVE_ENABLED: 'true' });
    await assert.rejects(api.bid(ID, 100), error => error.uncertain === true);
    await assert.rejects(api.bid(ID, 100), error => error.code === 'api_paused');
    assert.equal(calls.length, 1);
  }
});

test('mise serveur trop basse est explicite et ne déclenche aucun retry', async () => {
  const { api, calls } = fixture([{ status: 409, body: { code: 'bid_too_low', error: 'minimum changed', min: 300 } }], { MARKET_MODE: 'live', MARKET_LIVE_ENABLED: 'true' });
  await assert.rejects(api.bid(ID, 200), error => error.code === 'bid_too_low' && error.minimum === 300 && error.uncertain === false);
  assert.equal(calls.length, 1);
});

test('valeurs invalides et chemins étrangers sont refusés localement', async () => {
  const { api, calls } = fixture([], { MARKET_MODE: 'live', MARKET_LIVE_ENABLED: 'true' });
  await assert.rejects(api.bid(ID, 3501));
  await assert.rejects(api.auction('../../packs/open'));
  await assert.rejects(api.call('https://other.example/api/marketplace'));
  assert.equal(calls.length, 0);
});
