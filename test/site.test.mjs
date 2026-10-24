import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readConfig, PauseError } from '../src/core.mjs';
import { WikiMastersSite } from '../src/site.mjs';

const base = readConfig({});

// Simulated browser boundary: the real UI selectors are validated separately by
// observation. These tests exercise challenge, response and click coordination.
class FakePage extends EventEmitter {
  constructor(behaviour = 'success') {
    super();
    this.behaviour = behaviour;
    this.currentUrl = `${base.baseUrl}/pulls`;
    this.screen = 'inventory';
    this.card = 1;
    this.stock = 4;
    this.actions = [];
    this.successResponses = 0;
  }
  setDefaultTimeout() {}
  url() { return this.currentUrl; }
  async goto() {
    if (this.behaviour === 'logged-out') this.currentUrl = `${base.baseUrl}/login`;
    return { ok: () => true };
  }
  body() {
    if (this.screen === 'inventory') return `${this.stock} / 10 paquets disponibles`;
    if (this.screen === 'challenge') return 'Vérification rapide';
    return `Carte ${this.card} / 5\nCarte ${this.card}`;
  }
  response(status, body, pathname = '/api/packs/open') {
    this.emit('response', {
      url: () => `${base.baseUrl}${pathname}`,
      request: () => ({ method: () => 'POST' }),
      ok: () => status === 200,
      status: () => status,
      json: async () => {
        if (body === 'invalid-json') throw new Error('invalid-json');
        return body;
      },
    });
  }
  succeed() {
    this.stock--;
    this.screen = 'cards';
    this.successResponses++;
    this.response(200, { packs_remaining: this.stock });
  }
  getByRole(role, options) {
    if (role === 'heading') return {
      last: () => ({ waitFor: async () => {}, innerText: async () => `Carte ${this.card}` }),
    };
    if (options.name === 'Continuer') return { click: async () => {
      assert.equal(this.card, 5);
      this.actions.push('continue');
      this.screen = 'inventory';
    } };
    assert.ok(options.name instanceof RegExp);
    return {
      isVisible: async () => true,
      isEnabled: async () => true,
      click: async () => {
        this.actions.push('open');
        if (this.behaviour === 'success') this.succeed();
        if (this.behaviour === 'automatic-check') {
          this.screen = 'challenge';
          this.response(403, { human_verification_required: true });
          setTimeout(() => this.succeed(), 10);
        }
        if (this.behaviour === 'stuck-check') {
          this.screen = 'challenge';
          this.response(403, { human_verification_required: true });
        }
        if (this.behaviour === 'rate-limited') this.response(429, { human_verification_required: true });
        if (this.behaviour === 'bad-json') this.response(200, 'invalid-json');
      },
    };
  }
  locator(selector) {
    if (selector === 'body') return { innerText: async () => this.body() };
    assert.equal(selector, 'button:has(svg polyline[points="9 18 15 12 9 6"])');
    return { last: () => ({ click: async () => {
      assert.ok(this.card < 5);
      this.actions.push('next');
      this.card++;
    } }) };
  }
}

test('un clic gratuit puis cinq révélations et retour au stock', async () => {
  const page = new FakePage();
  const site = new WikiMastersSite(page, { ...base, cardDelayMs: 0 });
  const inventory = await site.prepare();
  const result = await site.openOne();
  assert.equal(inventory.available, 4);
  assert.equal(result.remaining, 3);
  assert.deepEqual(result.cards, ['Carte 1', 'Carte 2', 'Carte 3', 'Carte 4', 'Carte 5']);
  assert.deepEqual(page.actions, ['open', 'next', 'next', 'next', 'next', 'continue']);
});

test('validation automatique du site : aucun clic supplémentaire sur ouvrir ou Turnstile', async () => {
  const page = new FakePage('automatic-check');
  const result = await new WikiMastersSite(page, { ...base, cardDelayMs: 0 }).openOne();
  assert.equal(result.remaining, 3);
  assert.equal(page.actions.filter(a => a === 'open').length, 1);
  assert.equal(page.successResponses, 1);
});

test('vérification bloquée : pause après attente, sans deuxième clic', async () => {
  const page = new FakePage('stuck-check');
  const site = new WikiMastersSite(page, { ...base, verificationTimeoutMs: 5 });
  await assert.rejects(site.openOne(), error => error instanceof PauseError && error.code === 'verification_or_timeout');
  assert.deepEqual(page.actions, ['open']);
});

test('HTTP 429 arrête même si une vérification est aussi signalée', async () => {
  const page = new FakePage('rate-limited');
  await assert.rejects(new WikiMastersSite(page, base).openOne(), error => error.code === 'opening_refused');
  assert.deepEqual(page.actions, ['open']);
});

test('réponse illisible : résultat incertain et arrêt', async () => {
  const page = new FakePage('bad-json');
  await assert.rejects(new WikiMastersSite(page, base).openOne(), error => error.code === 'uncertain_result');
  assert.deepEqual(page.actions, ['open']);
});

test('session expirée ou navigation hors du site : arrêt avant tout clic', async () => {
  const page = new FakePage('logged-out');
  const site = new WikiMastersSite(page, base);
  await assert.rejects(site.prepare(), error => error.code === 'login_required');
  page.currentUrl = 'https://example.org/pulls';
  await assert.rejects(site.openOne(), error => error.code === 'unexpected_navigation');
  assert.deepEqual(page.actions, []);
});
