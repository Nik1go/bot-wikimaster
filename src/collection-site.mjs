import { PauseError } from './core.mjs';
import { RARITIES, rarityCode, normalize, frenchNumber, pageSignature } from './collection-core.mjs';

export const CARD_SELECTOR = 'main div.cursor-pointer:has(> img[src*="/rarity/"]):has(h3)';
const MODAL = 'div.card-frame:has(> button[aria-label="Fermer"])';

export class CollectionSite {
  constructor(page, config, { sleep, log, baseUrl = 'https://www.wiki-masters.com' }) {
    Object.assign(this, { page, config, sleep, log, baseUrl });
    this.fatal = null;
    this.writes = 0;
    this.reads = new Set();
    page.setDefaultTimeout(config.timeoutMs);
    this.onResponse = response => {
      const url = new URL(response.url());
      if (url.origin !== this.baseUrl || !url.pathname.startsWith('/api/')) return;
      const job = (async () => {
        const status = response.status();
        const mutation = ['POST','PATCH','PUT','DELETE'].includes(response.request().method());
        let body = null;
        if (mutation || !response.ok()) { try { body = await response.json(); } catch {} }
        const blocked = body?.human_verification_required || body?.code === 'automation_limit';
        if (!response.ok() || blocked || (mutation && body?.error)) {
          const code = blocked ? 'human_verification_required' : status === 401 ? 'login_required' : status === 429 ? 'rate_limited' : status === 403 ? 'access_denied' : 'site_request_failed';
          this.fatal = new PauseError(code, `${mutation ? 'Enregistrement' : 'Lecture'} refusé : HTTP ${status}, ${url.pathname}. Intervention nécessaire avant reprise.`);
        } else if (mutation) this.writes++;
      })().catch(() => { this.fatal = new PauseError('response_unreadable', 'Réponse serveur illisible. Contrôle manuel nécessaire.'); });
      this.reads.add(job);
      job.finally(() => this.reads.delete(job));
    };
    page.on('response', this.onResponse);
    this.onRequestFailed = request => {
      const url = new URL(request.url());
      const reason = request.failure()?.errorText || 'erreur réseau';
      if (url.origin === this.baseUrl && url.pathname.startsWith('/api/') && !/ABORTED|CANCELLED/i.test(reason)) {
        this.fatal = new PauseError('network_error', `Requête interrompue sur ${url.pathname} : ${reason}.`);
      }
    };
    page.on('requestfailed', this.onRequestFailed);
  }
  dispose() { this.page.off('response', this.onResponse); this.page.off('requestfailed', this.onRequestFailed); }
  modal() { return this.page.locator(MODAL); }
  async healthy() {
    await Promise.all([...this.reads]);
    if (this.fatal) throw this.fatal;
    const url = new URL(this.page.url());
    if (url.origin !== this.baseUrl) throw new PauseError('unexpected_navigation', 'Le navigateur a quitté WikiMasters.');
    if (/\/(login|signup|forgot-password)(\/|$)/.test(url.pathname)) throw new PauseError('login_required', 'Session absente ou expirée : se connecter avec collection-login.');
    const text = await this.page.locator('body').innerText();
    if (/vérification rapide|vérifiez que vous êtes humain|just a moment|checking your browser/i.test(text)) throw new PauseError('human_verification_required', 'Le site demande une vérification humaine. Ouvrir collection-login pour intervenir.');
  }
  async until(check, code, message) {
    const deadline = Date.now() + this.config.timeoutMs;
    do {
      await this.healthy();
      const result = await check();
      if (result) return result;
      await this.sleep(200);
    } while (Date.now() < deadline);
    throw new PauseError(code, message);
  }
  async prepare() {
    const response = await this.page.goto(`${this.baseUrl}/collection`, { waitUntil: 'domcontentloaded' });
    if (response && !response.ok()) throw new PauseError('collection_unavailable', `Collection refusée : HTTP ${response.status()}.`);
    await this.until(async () => await this.page.getByRole('button', { name: 'Trier la collection', exact: true }).isVisible(), 'collection_unavailable', 'Collection non chargée : connexion ou interface à vérifier.');
    await this.page.getByRole('textbox').fill('');
    const filter = this.page.getByRole('button', { name: 'Filtrer par étiquette', exact: true });
    if (normalize(await filter.innerText()) !== 'toutes les étiquettes') throw new PauseError('collection_filtered', 'Un filtre d’étiquette est actif. Choisir Toutes les étiquettes dans collection-login.');
    await this.page.getByRole('button', { name: 'Trier la collection', exact: true }).click();
    await this.page.getByRole('option', { name: 'Rareté', exact: true }).click();
    const reset = this.page.getByRole('button', { name: 'Réinitialiser rareté', exact: true });
    if (await reset.isVisible()) { await reset.click(); await this.readPage(false); }
    for (const code of ['R','PC','C']) {
      await this.page.getByRole('button', { name: code, exact: true }).click();
      await this.readPage(false);
    }
    const selected = await this.page.getByRole('button').evaluateAll(elements => elements.filter(e => /^(L|UR|SR|R|PC|C)$/.test(e.textContent.trim()) && e.classList.contains('ring-2')).map(e => e.textContent.trim()));
    if (selected.toSorted().join(',') !== 'C,PC,R') throw new PauseError('rarity_filter_invalid', 'Les filtres C, PC et R ne sont pas tous actifs.');
    // Reloading starts at page one on the observed site; refuse an unexpected
    // saved page rather than silently skipping the beginning of the collection.
    const first = await this.readPage();
    if (first.number !== 1) throw new PauseError('pagination_mismatch', 'Le parcours doit commencer à la page 1.');
  }
  async readPage(enforceRarity = true) {
    return this.until(async () => {
      if (await this.page.getByText('Chargement…', { exact: true }).first().isVisible()) return null;
      const pager = this.page.getByRole('button', { name: /^Page\s+\d+\s*\/\s*\d+$/ }).first();
      if (!(await pager.isVisible())) return null;
      const match = (await pager.innerText()).match(/^Page\s+(\d+)\s*\/\s*(\d+)$/);
      if (!match) return null;
      const cards = await this.page.locator(CARD_SELECTOR).evaluateAll(elements => elements.map(e => ({
        title: e.querySelector('h3')?.textContent.trim(),
        rarity: [...e.children].find(n => /^(C|PC|R|SR|UR|L)$/.test(n.textContent.trim()))?.textContent.trim(),
        stats: [...e.querySelectorAll('span.font-bold')].map(n => n.textContent.trim()),
      })));
      if (cards.some(c => !c.title || !c.rarity || c.stats.length !== 2)) return null;
      if (!cards.length) {
        const empty = /aucune carte/i.test(await this.page.locator('main').innerText());
        if (!empty) return null;
      }
      if (enforceRarity && cards.some(c => !RARITIES[c.rarity])) throw new PauseError('rarity_filter_invalid', 'Une carte hors C/PC/R est présente dans le parcours.');
      const number = Number(match[1]), totalPages = Number(match[2]);
      if (number < 1 || totalPages < number) throw new PauseError('pagination_invalid', 'Pagination incohérente.');
      return { number, totalPages, cards };
    }, 'collection_loading_timeout', 'Collection bloquée : chargement, pagination ou structure de carte inattendue.');
  }
  async openCard(index, card, signature) {
    if (pageSignature((await this.readPage()).cards) !== signature) throw new PauseError('collection_changed', 'L’ordre des cartes a changé pendant le parcours. Repartir avec --fresh.');
    this.active = { index, card, signature };
    await this.page.locator(CARD_SELECTOR).nth(index).getByRole('heading', { level: 3 }).click();
    await this.until(async () => await this.modal().isVisible(), 'card_open_timeout', 'Le détail de la carte ne s’ouvre pas.');
    await this.assertCard(card);
  }
  async assertCard(card) {
    await this.healthy();
    const heading = this.modal().getByRole('heading', { level: 2 });
    if (normalize(await heading.innerText()) !== normalize(card.title)) throw new PauseError('card_identity_mismatch', 'Le détail ouvert ne correspond pas au titre attendu.');
    const rarity = await heading.evaluate(e => e.parentElement.querySelector('span')?.textContent.trim());
    if (rarityCode(rarity) !== card.rarity) throw new PauseError('card_rarity_mismatch', `Rareté du détail ${rarity ?? 'absente'} différente de ${card.rarity}.`);
  }
  async readMarket(card) {
    await this.assertCard(card);
    const marketTab = this.modal().getByRole('tab', { name: 'Marché', exact: true });
    if (await marketTab.isVisible()) await marketTab.click();
    else await this.modal().getByRole('button', { name: 'Vue du marché', exact: true }).click();
    const modal = this.modal();
    await this.until(async () => (await modal.locator('button[aria-pressed]').count()) || /aucune vente pour l'instant/i.test(await modal.innerText()), 'market_loading_timeout', 'Le marché ne charge pas : accès Pro, réseau ou interface à vérifier.');
    const buttons = modal.locator('button[aria-pressed]');
    let choices = await buttons.evaluateAll(elements => elements.map(e => ({ name: e.textContent.trim(), selected: e.getAttribute('aria-pressed') === 'true' })));
    if (!choices.length) {
      // No rarity selector is rendered when there are no sales at all.
      if (/aucune vente pour l'instant/i.test(await modal.innerText())) return { rarity: card.rarity, sales: 0, average: null };
      throw new PauseError('market_rarity_unknown', 'Aucun choix de rareté dans le marché.');
    }
    const target = choices.find(c => rarityCode(c.name) === card.rarity);
    if (!target) throw new PauseError('market_rarity_missing', `Le marché ne propose pas la rareté ${card.rarity}.`);
    const targetButton = buttons.filter({ hasText: new RegExp(`^${target.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });
    if (!target.selected) await targetButton.click();
    // These controls are multi-select. A price combining R + PC must never
    // qualify a PC card. Select the target before removing other rarities.
    for (let index = 0; index < choices.length; index++) {
      if (choices[index].selected && rarityCode(choices[index].name) !== card.rarity) await buttons.nth(index).click();
    }
    await this.until(async () => {
      choices = await buttons.evaluateAll(elements => elements.map(e => ({ name: e.textContent.trim(), selected: e.getAttribute('aria-pressed') === 'true' })));
      const selected = choices.filter(c => c.selected);
      if (selected.length !== 1 || rarityCode(selected[0].name) !== card.rarity) return false;
      if (await modal.getByText('Chargement…', { exact: true }).first().isVisible()) return false;
      const text = await modal.innerText();
      // The last-sales heading independently proves which rarity the displayed
      // data belongs to, even while the selector updates before the response.
      return (await modal.getByRole('heading', { name: new RegExp(`10 dernières ventes\\s*·\\s*${target.name}$`, 'i') }).isVisible()) || /aucune vente pour l'instant/i.test(text);
    }, 'market_rarity_unconfirmed', 'Impossible de confirmer que les statistiques affichées appartiennent uniquement à la rareté de la carte.');
    const stats = await modal.locator('p').evaluateAll(elements => {
      const result = {};
      for (const e of elements) if (['Ventes','Moyenne'].includes(e.textContent.trim())) result[e.textContent.trim()] = e.parentElement.querySelector('p:nth-of-type(2)')?.textContent.trim();
      return result;
    });
    await this.healthy();
    if (stats.Ventes == null && /aucune vente pour l'instant/i.test(await modal.innerText())) return { rarity: card.rarity, sales: 0, average: null };
    if (stats.Ventes == null || stats.Moyenne == null) throw new PauseError('market_stats_invalid', 'Compteurs Ventes/Moyenne introuvables ; carte non étiquetée.');
    return { rarity: card.rarity, sales: frenchNumber(stats.Ventes), average: frenchNumber(stats.Moyenne) };
  }
  async ensureLabel(card, label) {
    if (this.config.apply !== true) throw new PauseError('apply_disabled', 'Simulation active : ajout d’étiquette désactivé.');
    await this.assertCard(card);
    const modal = this.modal();
    await modal.getByRole('tab', { name: 'Détails', exact: true }).click();
    const exists = () => modal.getByRole('button', { name: `Retirer l'étiquette ${label}`, exact: true }).isVisible();
    if (await exists()) return 'already_tagged';
    const input = modal.getByRole('combobox');
    await input.fill(label);
    const options = modal.getByRole('listbox');
    await options.waitFor({ state: 'visible' });
    const existing = options.getByRole('button', { name: label, exact: true });
    const create = options.getByRole('button', { name: `Créer ${label}`, exact: true });
    const before = this.writes;
    if (await existing.isVisible()) await existing.click();
    else if (await create.isVisible()) await create.click();
    else throw new PauseError('label_option_missing', 'L’étiquette ne peut pas être sélectionnée ou créée.');
    await this.until(async () => this.writes > before && await exists(), 'label_unconfirmed', 'Étiquette non confirmée par le serveur. Aucun nouveau clic automatique ; la reprise vérifiera sa présence.');
    // Re-open the same physical slot to verify the saved detail, without ever
    // clicking a toggle or removing existing labels.
    const active = this.active;
    await this.closeCard();
    await this.openCard(active.index, card, active.signature);
    if (!(await exists())) throw new PauseError('label_unconfirmed', 'L’étiquette n’est plus visible après réouverture du détail.');
    await this.healthy();
    return 'tagged';
  }
  async closeCard() {
    await this.modal().getByRole('button', { name: 'Fermer', exact: true }).click();
    await this.modal().waitFor({ state: 'hidden' });
  }
  async nextPage(expected) {
    await this.healthy();
    const next = this.page.getByRole('button', { name: 'Suivant →', exact: true }).first();
    if (!(await next.isEnabled())) throw new PauseError('pagination_blocked', 'Bouton Suivant désactivé avant la fin de la collection.');
    await next.click();
    await this.until(async () => (await this.readPage()).number === expected, 'pagination_timeout', `Impossible d’atteindre la page ${expected}.`);
  }
}
