import { randomUUID } from 'node:crypto';
import { PauseError } from './core.mjs';
import { prefilter, buildReference, evaluateCandidate, rankCandidates, nextMinimumBid, money, REASONS } from './market-selection.mjs';

const CLOSED = new Set(['lost', 'stopped', 'closed', 'simulation_finished']);
const TERMINAL = new Set(['settled_sold', 'settled_unsold', 'cancelled']);
const POSITION_STATUSES = new Set([...CLOSED, 'selected', 'observing', 'leading', 'outbid', 'awaiting_settlement', 'watching_only', 'won', 'listed']);
const iso = now => new Date(now).toISOString();

export class MarketEngine {
  constructor(api, config, store, { now = Date.now } = {}) {
    this.api = api;
    this.config = config;
    this.store = store;
    this.now = now;
  }

  async init() {
    this.book = await this.store.get('book') ?? { version: 1, mode: this.config.mode, accountId: null, lastScanAt: null, positions: [], pending: null };
    if (this.book.version !== 1 || this.book.mode !== this.config.mode || !Array.isArray(this.book.positions)
      || this.book.positions.some(p => !p.auctionId || !p.cardId || !money(p.ceiling) || p.ceiling > 3500 || !money(p.lastBid)
        || !money(p.reference?.mean) || p.reference.mean < 1 || !POSITION_STATUSES.has(p.status)
        || !Number.isFinite(Date.parse(p.selectedAt)) || !Number.isFinite(Date.parse(p.endAt)))
      || this.openPositions().length > 1 || (this.book.pending && !this.book.positions.some(p => p.auctionId === this.book.pending.auctionId))) {
      throw new PauseError('market_state_invalid', 'État du marché incohérent. Contrôle manuel nécessaire.');
    }
    if ((this.openPositions().length && !this.book.accountId) || (this.book.pending && (!money(this.book.pending.amount) || this.book.pending.amount < 1 || this.book.pending.amount > 3500))) {
      throw new PauseError('market_state_invalid', 'Compte ou mise en attente incohérent.');
    }
    this.cache = await this.store.get('references') ?? {};
    if (typeof this.cache !== 'object' || Array.isArray(this.cache)) throw new PauseError('market_state_invalid', 'Cache des références incohérent.');
    return this;
  }

  openPositions() { return this.book.positions.filter(p => !CLOSED.has(p.status)); }
  async save() { await this.store.put('book', this.book); }
  async log(event, details = {}) { await this.store.log(event, { mode: this.config.mode, ...details }); }

  async pause(error) {
    const safe = error instanceof PauseError ? error : new PauseError('technical_error', 'Erreur technique ; arrêt avant toute nouvelle action.');
    const details = { at: iso(this.now()), code: safe.code, message: safe.message, status: safe.status ?? null, pendingBid: Boolean(this.book.pending) };
    await this.store.put('paused', details);
    await this.log('market_paused', details);
  }

  async tick() {
    if (await this.store.get('paused')) return { state: 'paused', delayMs: 15_000 };
    if (this.config.mode === 'live' && !this.config.liveEnabled) {
      throw new PauseError('live_disabled', 'Achats réels désactivés. MARKET_LIVE_ENABLED doit être activé explicitement.');
    }
    if (this.book.pending) throw new PauseError('bid_confirmation_pending', 'Une mise précédente doit être réconciliée en lecture seule avant de reprendre.');
    const [position] = this.openPositions();
    if (position) {
      if (!this.verifiedAccountId) {
        const mine = await this.api.list(1, true);
        const account = await this.api.account(mine);
        if (account.userId !== this.book.accountId) throw new PauseError('account_mismatch', 'Le profil connecté a changé : suivi arrêté avant toute nouvelle mise.');
        this.verifiedAccountId = account.userId;
      }
      return this.follow(position);
    }
    const previous = this.book.lastScanAt == null ? null : Date.parse(this.book.lastScanAt);
    if (previous != null && !Number.isFinite(previous)) throw new PauseError('market_state_invalid', 'Date du dernier repérage illisible.');
    const due = previous == null ? this.now() : previous + this.config.scanIntervalMs;
    if (this.now() < due) return { state: 'waiting_scan', delayMs: Math.min(due - this.now(), 15_000) };
    return this.scan();
  }

  async scan() {
    this.cycleId = randomUUID();
    this.book.lastScanAt = iso(this.now());
    await this.save();
    await this.log('scan_started', { cycleId: this.cycleId, message: 'Repérage horaire : légendaires avec image, fin entre 30 et 120 secondes par défaut.', minSeconds: this.config.minSeconds, maxSeconds: this.config.maxSeconds, rankBy: this.config.rankBy, maxPerCard: this.config.maxPerCard });
    const first = await this.api.list(1, true);
    const account = await this.api.account(first);
    if (this.book.accountId && this.book.accountId !== account.userId) throw new PauseError('account_mismatch', 'Le compte connecté a changé depuis la dernière session.');
    this.book.accountId = account.userId;
    this.verifiedAccountId = account.userId;
    await this.save();
    await this.log('wallet_checked', { cycleId: this.cycleId, message: `Solde disponible : ${account.balance} WB ; réserve : ${this.config.walletReserve} WB.`, balance: account.balance, reserve: this.config.walletReserve });
    if ((account.leadingAuctionIds ?? []).length) {
      await this.log('no_free_slot', { message: 'Vous menez déjà une autre enchère : aucune nouvelle carte sélectionnée.', count: account.leadingAuctionIds.length });
      return { state: 'waiting_scan', delayMs: 15_000 };
    }
    const auctions = new Map();
    let data = first;
    let pages = 0;
    let truncated = false;
    for (let page = 1; page <= this.config.maxPages; page++) {
      if (page > 1) data = await this.api.list(page);
      pages++;
      for (const auction of data.auctions) if (!auctions.has(auction.id)) auctions.set(auction.id, auction);
      const beyondWindow = data.auctions.some(a => Date.parse(a.end_at) > this.now() + this.config.maxSeconds * 1000);
      if (!data.hasMore || beyondWindow || data.auctions.length === 0) break;
      if (page === this.config.maxPages) truncated = true;
    }
    const candidates = [];
    const reasons = {};
    let histories = 0;
    let unevaluated = 0;
    const rejected = async (auction, result) => {
      reasons[result.reason] = (reasons[result.reason] ?? 0) + 1;
      await this.log('candidate_rejected', { cycleId: this.cycleId, auctionId: auction.id, title: auction.card?.wikipedia_title, reason: result.reason, message: result.message || REASONS[result.reason], nextBid: result.nextBid, ceiling: result.ceiling });
    };
    for (const auction of auctions.values()) {
      const initial = prefilter(auction, account, this.config, this.now());
      if (!initial.eligible) { await rejected(auction, initial); continue; }
      let cached = this.cache[auction.card_id];
      if (!cached || !Array.isArray(cached.sales) || this.now() - Date.parse(cached.at) > this.config.cacheMs || Date.parse(cached.at) > this.now() || !Number.isFinite(Date.parse(cached.at))) {
        if (histories >= this.config.maxHistories) {
          unevaluated++;
          await this.log('candidate_deferred', { auctionId: auction.id, title: auction.card?.wikipedia_title, reason: 'history_request_limit', message: 'Carte non évaluée : plafond de lectures d’historique atteint pour ce repérage.' });
          continue;
        }
        histories++;
        const raw = await this.api.sales(auction.card_id);
        cached = { at: iso(this.now()), sales: raw.map(s => ({ id: s.id, card_id: s.card_id, rarity: s.rarity, is_shiny: s.is_shiny, status: s.status, final_price: s.final_price, settled_at: s.settled_at })) };
        this.cache[auction.card_id] = cached;
        await this.store.put('references', this.cache);
      }
      const reference = buildReference(cached.sales, auction, this.config, this.now());
      const evaluated = evaluateCandidate(auction, reference, account, this.config, this.now());
      if (!evaluated.eligible) { await rejected(auction, evaluated); continue; }
      candidates.push(evaluated);
      await this.log('candidate_eligible', { cycleId: this.cycleId, ...evaluated, message: `Admissible : prochaine mise ${evaluated.nextBid} WB, moyenne ${reference.mean} WB sur ${reference.sampleCount} ventes ; écart ${evaluated.saving} WB.` });
    }
    const ranked = rankCandidates(candidates, this.config);
    await this.log('scan_finished', { cycleId: this.cycleId, message: `${auctions.size} annonces vues, ${ranked.length} occasions évaluées admissibles.`, pages, seen: auctions.size, eligible: ranked.length, reasons, truncated, unevaluated, historiesFetched: histories });
    if (truncated || unevaluated) await this.log('scan_limited', { message: 'Recherche bornée : le choix compare uniquement les occasions évaluées, pas tout le marché.', truncated, unevaluated });
    let ready = [...ranked];
    let preflights = 0;
    while (ready.length && preflights < ranked.length * 2) {
      const candidate = ready.shift();
      preflights++;
      const fresh = await this.api.auction(candidate.auctionId);
      const balance = await this.api.wallet();
      const final = evaluateCandidate(fresh, candidate.reference, { ...account, balance }, this.config, this.now());
      if (!final.eligible) { await rejected(fresh, final); continue; }
      const compared = rankCandidates([...ready, final], this.config);
      if (compared[0].auctionId !== final.auctionId) {
        ready = compared;
        await this.log('candidate_reordered', { auctionId: final.auctionId, title: final.title, saving: final.saving, message: 'Le prix relu change le classement. Vérification de la meilleure occasion restante.' });
        continue;
      }
      const position = {
        auctionId: final.auctionId, cardId: final.cardId, title: final.title,
        status: 'selected', selectedAt: iso(this.now()), endAt: fresh.end_at,
        ceiling: final.ceiling, reference: final.reference,
        lastBid: 0, lastObservedBid: fresh.current_bid ?? 0,
        cycleId: this.cycleId,
      };
      this.book.positions.push(position);
      // Keep completed records bounded; the append-only event log is the audit.
      this.book.positions = [...this.book.positions.filter(p => CLOSED.has(p.status)).slice(-999), ...this.openPositions()];
      await this.save();
      await this.log('candidate_selected', { cycleId: this.cycleId, ...final, rankBy: this.config.rankBy, message: `Choix : ${final.title}. Écart estimé ${final.saving} WB ; plafond figé ${final.ceiling} WB.`, compared: compared.map(c => ({ auctionId: c.auctionId, nextBid: c.nextBid, saving: c.saving, discountPercent: c.discountPercent })) });
      if (this.config.mode === 'simulation') {
        position.lastBid = final.nextBid;
        position.status = 'observing';
        await this.save();
        await this.log('would_bid', { auctionId: position.auctionId, title: position.title, amount: final.nextBid, ceiling: position.ceiling, message: `SIMULATION : mise proposée ${final.nextBid} WB. Aucun achat envoyé.` });
      } else {
        await this.place(position, final.nextBid);
      }
      return { state: 'following', delayMs: this.config.pollMs };
    }
    if (ready.length) await this.log('preflight_limited', { message: 'Les prix changent trop pendant la vérification. Aucun achat lancé ; recherche terminée pour cette heure.' });
    return { state: 'waiting_scan', delayMs: 15_000 };
  }

  async place(position, amount) {
    const ceiling = Math.min(position.ceiling, this.config.maxPerCard, Math.floor(position.reference.mean * this.config.maxReferencePercent / 100));
    if (amount > ceiling || !money(amount) || amount < 1) throw new PauseError('bid_over_ceiling', 'Mise refusée localement : plafond dépassé.');
    if (this.config.mode !== 'live' || !this.config.liveEnabled) throw new PauseError('live_disabled', 'Aucune mise réelle autorisée en simulation.');
    if (this.book.pending) throw new PauseError('bid_confirmation_pending', 'Une mise précédente reste à vérifier.');
    // Persist intent before POST. Any crash/timeout prevents automatic resending.
    this.book.pending = { auctionId: position.auctionId, amount, at: iso(this.now()) };
    await this.save();
    await this.log('bid_submitting', { auctionId: position.auctionId, title: position.title, amount, ceiling, message: `Envoi d’une mise de ${amount} WB, plafond ${ceiling} WB.` });
    let result;
    try { result = await this.api.bid(position.auctionId, amount); }
    catch (error) {
      if (error.uncertain === false) {
        this.book.pending = null;
        await this.save();
        if (error.code === 'bid_too_low') {
          if (money(error.minimum) && error.minimum > 0) {
            position.serverMinimum = error.minimum;
            await this.save();
          }
          await this.log('bid_race', { auctionId: position.auctionId, message: 'Mise refusée car le minimum a changé. Réévaluation au prochain suivi ; aucun renvoi immédiat.', minimum: error.minimum });
          return;
        }
        if (error.code === 'auction_ended') return;
      }
      throw error;
    }
    if (!money(result.current_bid) || result.current_bid < amount || result.current_bid > ceiling || !money(result.bidder_balance)) {
      throw new PauseError('bid_confirmation_pending', 'Réponse de mise incomplète : résultat à vérifier, sans nouvel envoi.');
    }
    position.lastBid = result.current_bid;
    const timing = result.clientTiming && Number.isFinite(result.clientTiming.roundTripMs) ? result.clientTiming : null;
    if (timing) {
      position.firstBidTiming ??= timing;
      position.lastBidTiming = timing;
    }
    delete position.serverMinimum;
    position.status = 'leading';
    this.book.pending = null;
    await this.save();
    await this.log('bid_confirmed', {
      auctionId: position.auctionId, title: position.title, amount: result.current_bid, balance: result.bidder_balance,
      timing,
      deltaFromFirstRoundTripMs: timing && Number.isFinite(position.firstBidTiming?.roundTripMs)
        ? Math.round((timing.roundTripMs - position.firstBidTiming.roundTripMs) * 100) / 100 : null,
      message: `Mise acceptée : ${result.current_bid} WB ; solde ${result.bidder_balance} WB.` + (timing ? ` Aller-retour côté bot : ${timing.roundTripMs} ms.` : ''),
    });
  }

  async finish(position, auction) {
    if (this.config.mode === 'live' && auction.status === 'settled_sold'
      && (!auction.winner_id || !money(auction.final_price) || auction.final_price < 1)) {
      throw new PauseError('invalid_settlement', 'Vente réglée sans gagnant ou prix final valide : position conservée pour contrôle.');
    }
    if (this.config.mode === 'simulation') {
      position.status = 'simulation_finished';
      await this.log('simulation_finished', { auctionId: position.auctionId, title: position.title, actualStatus: auction.status, finalObservedPrice: auction.final_price ?? auction.current_bid, simulatedLastBid: position.lastBid, message: 'Suivi simulé terminé. Le gagnant réel ne permet pas de déduire le gagnant d’une enchère hypothétique.' });
    } else if (auction.status === 'settled_sold' && auction.winner_id === this.book.accountId) {
      if (!money(auction.final_price) || auction.final_price < 1) throw new PauseError('invalid_settlement', 'Gain annoncé sans prix final valide.');
      position.status = 'won';
      position.purchasePrice = auction.final_price;
      position.settledAt = auction.settled_at || iso(this.now());
      await this.log('auction_won', { auctionId: position.auctionId, title: position.title, amount: auction.final_price, ceiling: position.ceiling, message: `Carte gagnée pour ${auction.final_price} WB. Place occupée jusqu’à confirmation de sa revente.` });
    } else {
      position.status = 'lost';
      await this.log('auction_lost', { auctionId: position.auctionId, title: position.title, finalPrice: auction.final_price ?? null, finalStatus: auction.status, message: 'Enchère terminée sans achat par le bot. Place libérée.' });
    }
    position.finishedAt = iso(this.now());
    await this.save();
    if (position.status === 'won' && position.purchasePrice > position.ceiling) throw new PauseError('settlement_over_ceiling', 'Le prix final dépasse le plafond du bot. Position conservée ; vérifier une éventuelle intervention extérieure.');
    return { state: position.status, delayMs: 15_000 };
  }

  async follow(position) {
    if (position.status === 'won') {
      return { state: 'awaiting_resale', delayMs: this.config.scanIntervalMs };
    }
    if (position.status === 'listed') return this.followResale(position);
    const auction = await this.api.auction(position.auctionId);
    if (auction.card_id !== position.cardId || !Number.isFinite(Date.parse(auction.end_at))) throw new PauseError('invalid_auction_response', 'La carte ou la date de fin de l’enchère a changé de manière incohérente.');
    if (auction.end_at !== position.endAt) {
      await this.log('end_changed', { auctionId: position.auctionId, previousEndAt: position.endAt, endAt: auction.end_at, message: 'Date de fin mise à jour par le serveur ; suivi adapté à la prolongation.' });
      position.endAt = auction.end_at;
      await this.save();
    }
    if (TERMINAL.has(auction.status)) return this.finish(position, auction);
    if (auction.status !== 'active') throw new PauseError('unknown_auction_status', 'Statut d’enchère inconnu.');
    if (this.now() - Date.parse(position.selectedAt) > this.config.maxWatchMs) throw new PauseError('watch_timeout', 'Durée maximale de suivi atteinte ; la position reste réservée pour contrôle manuel.');
    if (Date.parse(auction.end_at) <= this.now()) {
      if (position.status !== 'awaiting_settlement') {
        position.status = 'awaiting_settlement';
        await this.save();
        await this.log('awaiting_settlement', { auctionId: position.auctionId, message: 'Compteur terminé, mais vente pas encore réglée par le serveur. Aucun achat déclaré gagné.' });
      }
      return { state: 'awaiting_settlement', delayMs: this.config.pollMs };
    }
    if (position.abandonReason) return { state: 'watching_only', delayMs: this.config.pollMs };
    if (this.config.mode === 'live' && auction.current_bidder_id === this.book.accountId) {
      if (!money(auction.current_bid) || auction.current_bid > position.ceiling) throw new PauseError('external_bid_change', 'Mise du compte supérieure au plafond du bot ; contrôle manuel nécessaire.');
      if (position.status !== 'leading' || position.lastBid !== auction.current_bid) {
        position.status = 'leading';
        position.lastBid = auction.current_bid;
        await this.save();
        await this.log('leading', { auctionId: position.auctionId, amount: auction.current_bid, message: 'Vous menez déjà : aucune surenchère sur vous-même.' });
      }
      return { state: 'leading', delayMs: this.config.pollMs };
    }
    const current = auction.current_bid ?? 0;
    if (this.config.mode === 'simulation' && current < position.lastBid) return { state: 'observing', delayMs: this.config.pollMs };
    if (current !== position.lastObservedBid || position.status === 'leading') {
      await this.log(this.config.mode === 'simulation' ? 'simulated_outbid' : 'outbid', { auctionId: position.auctionId, title: position.title, previousBid: position.lastBid, currentBid: current, message: 'Une mise concurrente nécessite de recalculer la prochaine mise autorisée.' });
      position.lastObservedBid = current;
      position.status = this.config.mode === 'simulation' ? 'observing' : 'outbid';
      await this.save();
    }
    const next = Math.max(nextMinimumBid(auction), position.serverMinimum ?? 0);
    const ceiling = Math.min(position.ceiling, this.config.maxPerCard, Math.floor(position.reference.mean * this.config.maxReferencePercent / 100));
    if (next > ceiling) {
      position.status = 'watching_only';
      position.abandonReason = 'ceiling_reached';
      await this.save();
      await this.log('ceiling_reached', { auctionId: position.auctionId, title: position.title, nextBid: next, ceiling, message: `Abandon : prochaine mise ${next} WB supérieure au plafond ${ceiling} WB.` });
      return { state: 'watching_only', delayMs: this.config.pollMs };
    }
    const balance = await this.api.wallet();
    if (next > balance - this.config.walletReserve) {
      position.status = 'watching_only';
      position.abandonReason = 'wallet_insufficient';
      await this.save();
      await this.log('wallet_insufficient', { auctionId: position.auctionId, nextBid: next, balance, message: 'Abandon : solde réel insuffisant après remboursement éventuel de la mise précédente.' });
      return { state: 'watching_only', delayMs: this.config.pollMs };
    }
    // Initial selection requires >= minSeconds. Existing positions may be
    // counterbid later, but never deliberately in the final request margin.
    if (Date.parse(auction.end_at) - this.now() <= this.config.requestGapMs + 3000) {
      if (!position.lateBidLogged) {
        position.lateBidLogged = true;
        await this.save();
        await this.log('counterbid_too_late', { auctionId: position.auctionId, title: position.title, message: 'Délai trop court pour envoyer une contre-mise ; suivi de la clôture uniquement pour ce passage.' });
      }
      return { state: 'too_late_to_counterbid', delayMs: this.config.pollMs };
    }
    if (this.config.mode === 'simulation') {
      position.lastBid = next;
      await this.save();
      await this.log('would_bid', { auctionId: position.auctionId, title: position.title, amount: next, ceiling, message: `SIMULATION : contre-mise proposée ${next} WB. Aucun achat envoyé.` });
    } else await this.place(position, next);
    return { state: 'following', delayMs: this.config.pollMs };
  }

  async reconcilePending() {
    const pending = this.book.pending;
    if (!pending) return { resolved: true };
    const position = this.book.positions.find(p => p.auctionId === pending.auctionId);
    const auction = await this.api.auction(pending.auctionId);
    if (TERMINAL.has(auction.status)) {
      await this.finish(position, auction);
    } else if (auction.current_bidder_id === this.book.accountId && money(auction.current_bid) && auction.current_bid >= pending.amount) {
      position.lastBid = auction.current_bid;
      position.status = 'leading';
    } else {
      await this.log('reconciliation_pending', { auctionId: pending.auctionId, message: 'La lecture serveur ne suffit pas à confirmer l’ancienne mise. Aucun nouvel envoi ; attendre la clôture ou vérifier manuellement.' });
      return { resolved: false };
    }
    this.book.pending = null;
    await this.save();
    await this.log('bid_reconciled', { auctionId: pending.auctionId, message: 'Mise précédente réconciliée en lecture seule. La pause doit encore être levée explicitement.' });
    return { resolved: true };
  }

  async linkResale(purchaseId, saleId) {
    const position = this.openPositions().find(p => p.auctionId === purchaseId && p.status === 'won');
    if (!position) throw new PauseError('position_not_won', 'Aucun achat gagné en attente de revente avec cet identifiant.');
    const sale = await this.api.auction(saleId);
    const created = Date.parse(sale.created_at);
    const purchased = Date.parse(position.settledAt);
    if (sale.id === purchaseId || sale.seller_id !== this.book.accountId || sale.card_id !== position.cardId
      || (sale.snapshot_rarity ?? sale.card?.rarity) !== 'L' || sale.is_shiny === true
      || !Number.isFinite(created) || !Number.isFinite(purchased) || created < purchased) {
      throw new PauseError('invalid_resale', 'La revente ne correspond pas à ce compte, cette carte ou cette période.');
    }
    position.resaleId = sale.id;
    position.status = 'listed';
    await this.save();
    await this.log('resale_linked', { auctionId: purchaseId, resaleId: sale.id, title: position.title, message: 'Revente manuelle rattachée au suivi. Aucune annonce créée par cette version.' });
  }

  async followResale(position) {
    const sale = await this.api.auction(position.resaleId);
    if (sale.seller_id !== this.book.accountId || sale.card_id !== position.cardId) throw new PauseError('invalid_resale', 'Revente incohérente.');
    if (sale.status === 'settled_sold' && (!money(sale.final_price) || sale.final_price < 1)) throw new PauseError('invalid_settlement', 'Prix de revente réglée illisible ; place conservée.');
    if (sale.status === 'settled_sold' && money(sale.final_price) && sale.final_price > 0) {
      position.status = 'closed';
      position.resalePrice = sale.final_price;
      await this.save();
      await this.log('position_closed', { auctionId: position.auctionId, title: position.title, resaleId: position.resaleId, purchasePrice: position.purchasePrice, resalePrice: sale.final_price, grossSpread: sale.final_price - position.purchasePrice, message: 'Revente confirmée. Place libérée ; la prochaine recherche vérifiera à nouveau le solde.' });
    } else if (sale.status === 'settled_unsold' || sale.status === 'cancelled') {
      position.status = 'won';
      delete position.resaleId;
      await this.save();
      await this.log('resale_unsold', { auctionId: position.auctionId, title: position.title, message: 'Revente terminée sans acheteur. La place reste occupée.' });
    }
    return { state: position.status, delayMs: this.config.scanIntervalMs };
  }
}
