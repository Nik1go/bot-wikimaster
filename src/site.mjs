import { PauseError, parseInventory } from './core.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

const NEXT_ARROW = 'button:has(svg polyline[points="9 18 15 12 9 6"])';

export class WikiMastersSite {
  constructor(page, config) {
    this.page = page;
    this.config = config;
    this.page.setDefaultTimeout(12_000);
  }

  async text() {
    return this.page.locator('body').innerText();
  }

  assertOrigin() {
    if (new URL(this.page.url()).origin !== this.config.baseUrl) {
      throw new PauseError('unexpected_navigation', 'La page a quitté WikiMasters.');
    }
  }

  async checkLogin() {
    this.assertOrigin();
    if (/\/(login|signup|forgot-password)(\/|$)/.test(new URL(this.page.url()).pathname)) {
      throw new PauseError('login_required', 'Connexion manuelle nécessaire dans le navigateur du VPS.');
    }
  }

  async prepare() {
    const response = await this.page.goto(`${this.config.baseUrl}/pulls`, { waitUntil: 'domcontentloaded' });
    if (response && !response.ok()) {
      throw new PauseError('page_refused', `Page refusée par le serveur (HTTP ${response.status()}).`);
    }
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      await this.checkLogin();
      const body = await this.text();
      if (/paquets disponibles/i.test(body)) return parseInventory(body);
      if (/Carte\s+\d+\s*\/\s*5/.test(body)) {
        throw new PauseError('unfinished_pack', 'Un paquet est déjà en cours : termine sa révélation manuellement.');
      }
      await sleep(500);
    }
    throw new PauseError('interface_changed', 'La page des paquets ne devient pas prête.');
  }

  async openOne() {
    await this.checkLogin();
    const before = parseInventory(await this.text());
    if (before.available === 0) {
      throw new PauseError('stock_changed', 'Le stock a changé pendant la session.');
    }
    const open = this.page.getByRole('button', { name: /^Ouvrir un paquet\b/i });
    if (!(await open.isVisible()) || !(await open.isEnabled())) {
      throw new PauseError('opening_unavailable', 'Le bouton du paquet gratuit est indisponible.');
    }

    let confirmed = null;
    let failure = null;
    const reads = new Set();
    const observe = response => {
      const url = new URL(response.url());
      if (url.origin !== this.config.baseUrl || url.pathname !== '/api/packs/open' || response.request().method() !== 'POST') return;
      const read = (async () => {
        let body;
        try { body = await response.json(); }
        catch {
          failure = new PauseError('uncertain_result', 'Réponse d’ouverture illisible ; aucun nouvel essai automatique.');
          return;
        }
        if (response.ok()) {
          confirmed = { remaining: body.packs_remaining };
        } else if (response.status() === 429 || !body.human_verification_required) {
          failure = new PauseError('opening_refused', `Ouverture refusée (HTTP ${response.status()}) ; session arrêtée.`);
        }
      })().catch(() => {
        failure = new PauseError('uncertain_result', 'Résultat de l’ouverture incertain ; contrôle manuel nécessaire.');
      });
      reads.add(read);
      read.finally(() => reads.delete(read));
    };
    this.page.on('response', observe);
    try {
      // Only this normal UI click starts an opening. No direct API request or challenge interaction.
      await open.click();
      const deadline = Date.now() + this.config.verificationTimeoutMs;
      while (!confirmed && Date.now() < deadline) {
        await this.checkLogin();
        if (failure) throw failure;
        await sleep(400);
      }
      if (!confirmed) {
        throw new PauseError('verification_or_timeout', 'Vérification ou ouverture toujours bloquée : intervention manuelle nécessaire.');
      }
      if (!Number.isInteger(confirmed.remaining) || confirmed.remaining < 0 || confirmed.remaining > before.capacity) {
        throw new PauseError('uncertain_result', 'Paquet ouvert mais compteur serveur inattendu ; vérifier avant de reprendre.');
      }
      const cards = await this.revealCards();
      return { remaining: confirmed.remaining, cards };
    } catch (error) {
      if (error instanceof PauseError) throw error;
      throw new PauseError('uncertain_result', 'Une étape de l’ouverture a échoué ; aucun nouvel essai automatique.');
    } finally {
      this.page.off('response', observe);
      await Promise.allSettled([...reads]);
    }
  }

  async revealCards() {
    const cards = [];
    for (let index = 1; index <= 5; index++) {
      const expected = new RegExp(`Carte\\s+${index}\\s*\\/\\s*5`);
      const deadline = Date.now() + 15_000;
      while (!(expected.test(await this.text())) && Date.now() < deadline) await sleep(200);
      if (!expected.test(await this.text())) {
        throw new PauseError('interface_changed', 'La révélation des cartes a changé.');
      }
      const heading = this.page.getByRole('heading', { level: 3 }).last();
      await heading.waitFor({ state: 'visible' });
      cards.push((await heading.innerText()).trim());
      await sleep(this.config.cardDelayMs);
      if (index < 5) {
        await this.page.locator(NEXT_ARROW).last().click();
      } else {
        await this.page.getByRole('button', { name: 'Continuer', exact: true }).click();
      }
    }
    const deadline = Date.now() + 15_000;
    while (!/paquets disponibles/i.test(await this.text()) && Date.now() < deadline) await sleep(200);
    parseInventory(await this.text());
    return cards;
  }
}
