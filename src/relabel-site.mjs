import { PauseError } from './core.mjs';
import { CollectionSite } from './collection-site.mjs';
import { normalize, pageSignature } from './collection-core.mjs';
import { relabelIdentity } from './relabel-core.mjs';

export const HISTORY_CARD_SELECTOR = 'main a.card-frame[href^="/marketplace/"]:has(h3)';

export class RelabelSite extends CollectionSite {
  async readHistory() {
    this.searchCard = null;
    const response = await this.page.goto(`${this.baseUrl}/marketplace`, { waitUntil: 'domcontentloaded' });
    if (response && !response.ok()) throw new PauseError('history_unavailable', `Historique refusé : HTTP ${response.status()}.`);
    const tab = this.page.getByRole('button', { name: /^Historique\s*\(\d+\)$/ });
    await this.until(() => tab.isVisible(), 'history_unavailable', 'Onglet Historique introuvable.');
    const expected = Number((await tab.innerText()).match(/\((\d+)\)/)[1]);
    await tab.click();
    let entries = [];
    for (;;) {
      entries = await this.until(async () => {
        if (await this.page.getByText(/^(Chargement…|Chargement\.\.\.)$/).first().isVisible()) return null;
        const cards = await this.page.locator(HISTORY_CARD_SELECTOR).evaluateAll(elements => elements.map(e => {
          const frame = e.querySelector('img[src*="/rarity/"]')?.parentElement;
          const texts = [...e.querySelectorAll('span')].map(n => n.textContent.trim());
          return {
            href: e.getAttribute('href'), title: e.querySelector('h3')?.textContent.trim(),
            rarity: frame ? [...frame.children].map(n => n.textContent.trim()).find(t => /^(C|PC|R|SR|UR|L)$/.test(t)) : null,
            stats: [...e.querySelectorAll('span.font-bold')].map(n => n.textContent.trim()),
            owned: !!e.querySelector('[title="Dans ta collection"]'),
            status: texts.includes('Non vendue') ? 'unsold' : texts.includes('Vendue pour') ? 'sold' : null,
          };
        }));
        if (!cards.length && expected > 0) return null;
        if (!cards.length && !/aucun|historique.*vide/i.test(await this.page.locator('main').innerText())) return null;
        if (cards.some(c => !c.status)) return null;
        return cards;
      }, 'history_loading_timeout', 'Historique incomplet ou structure de vente inattendue ; aucune étiquette ajoutée.');
      // Validate every identity even if it does not qualify for relabelling.
      entries.forEach(relabelIdentity);
      const more = this.page.getByRole('button', { name: 'Charger la suite', exact: true });
      if (!(await more.isVisible())) break;
      if (entries.length >= 10_000) throw new PauseError('history_too_large', 'Historique trop long : vérifier la pagination avant de continuer.');
      const previous = entries.length;
      await this.sleep(this.config.delayMs);
      await more.click();
      await this.until(async () => await this.page.locator(HISTORY_CARD_SELECTOR).count() > previous, 'history_pagination_blocked', 'La suite de l’historique ne charge pas.');
    }
    if (entries.length < expected) throw new PauseError('history_incomplete', `Historique incomplet : ${entries.length}/${expected} ventes ; aucune étiquette ajoutée.`);
    await this.healthy();
    return entries;
  }

  // Keep the title search when CollectionSite.ensureLabel reloads the page to
  // verify persistence. All rarities are included, independently of the sorter.
  async prepare() {
    const response = await this.page.goto(`${this.baseUrl}/collection`, { waitUntil: 'domcontentloaded' });
    if (response && !response.ok()) throw new PauseError('collection_unavailable', `Collection refusée : HTTP ${response.status()}.`);
    const filter = this.page.getByRole('button', { name: 'Filtrer par étiquette', exact: true });
    await this.until(() => filter.isVisible(), 'collection_unavailable', 'La collection ne charge pas.');
    if (normalize(await filter.innerText()) !== 'toutes les étiquettes') {
      await filter.click();
      await this.page.getByRole('option', { name: 'Toutes les étiquettes', exact: true }).click();
    }
    const reset = this.page.getByRole('button', { name: 'Réinitialiser rareté', exact: true });
    if (await reset.isVisible()) await reset.click();
    const selected = await this.page.getByRole('button').evaluateAll(elements => elements.filter(e => /^(L|UR|SR|R|PC|C)$/.test(e.textContent.trim()) && e.classList.contains('ring-2')).length);
    if (selected || normalize(await filter.innerText()) !== 'toutes les étiquettes') throw new PauseError('collection_filtered', 'Les filtres de collection ne sont pas réinitialisés.');
    const query = this.searchCard?.title ?? '';
    await this.page.getByRole('textbox').fill(query);
    // The search is debounced. A quiet interval is necessary before accepting
    // an empty result; readPage alone could return the previous search results.
    await this.sleep(1000);
    await this.readPage();
  }

  async findCandidate(card) {
    const matches = [];
    let current = await this.readPage();
    if (current.number !== 1) throw new PauseError('pagination_mismatch', 'La recherche doit commencer à la page 1.');
    for (;;) {
      for (const [index, found] of current.cards.entries()) {
        if (relabelIdentity(found) === relabelIdentity(card)) matches.push({ page: current.number, index });
      }
      if (current.number >= current.totalPages) break;
      await this.nextPage(current.number + 1);
      current = await this.readPage();
    }
    return matches;
  }

  async openCandidate(card) {
    this.searchCard = card;
    await this.prepare();
    const matches = await this.findCandidate(card);
    if (!matches.length) return 'missing';
    // Identical physical duplicates cannot be distinguished in this UI. Leave
    // them untouched instead of assigning a sale label to an arbitrary copy.
    if (matches.length !== 1) return 'ambiguous';
    await this.goToPage(matches[0].page);
    const current = await this.readPage();
    if (!current.cards[matches[0].index] || relabelIdentity(current.cards[matches[0].index]) !== relabelIdentity(card)) throw new PauseError('collection_changed', 'La carte recherchée a changé de place.');
    await this.openCard(matches[0].index, card, pageSignature(current.cards));
    return 'open';
  }

  async assertCard(card) {
    await super.assertCard(card);
    const stats = await this.modal().locator('span.font-bold').evaluateAll(elements => elements.map(e => e.textContent.trim()).filter(t => /^[\d\s\u00a0\u202f]+$/.test(t)));
    if (stats.length !== 2 || relabelIdentity({ ...card, stats }) !== relabelIdentity(card)) throw new PauseError('card_identity_mismatch', 'Les statistiques du détail ne correspondent pas à la carte invendue.');
  }

  async hasSaleLabel(card) {
    await this.assertCard(card);
    await this.modal().getByRole('tab', { name: 'Détails', exact: true }).click();
    return this.modal().getByRole('button', { name: `Retirer l'étiquette ${this.config.label}`, exact: true }).isVisible();
  }

  async openCard(index, card, signature) {
    const current = await this.readPage();
    if (current.cards.filter(c => relabelIdentity(c) === relabelIdentity(card)).length !== 1) throw new PauseError('collection_changed', 'Plusieurs exemplaires identiques : étiquetage non confirmé.');
    await super.openCard(index, card, signature);
  }

  async recoverCandidate() {
    await this.healthy();
    await this.prepare();
  }
}
