import { PauseError } from './core.mjs';
import { inferAccountId, money } from './market-selection.mjs';

const ORIGIN = 'https://www.wiki-masters.com';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function id(value) {
  if (!UUID.test(value)) throw new PauseError('invalid_id', 'Identifiant d’enchère ou de carte invalide.');
  return value;
}

export class MarketApiError extends PauseError {
  constructor(code, message, details) {
    super(code, message);
    Object.assign(this, details);
  }
}

export class MarketApi {
  constructor(request, config, { log, sleep, now = Date.now, monotonicNow = () => performance.now() }) {
    this.request = request;
    this.config = config;
    this.log = log;
    this.sleep = sleep;
    this.now = now;
    this.monotonicNow = monotonicNow;
    this.bidRoundTrips = [];
    this.nextRequestAt = 0;
    this.blocked = false;
  }

  async call(path, method = 'GET', data) {
    if (this.blocked) throw new PauseError('api_paused', 'API en pause : aucun nouvel appel envoyé.');
    if (method === 'POST' && (this.config.mode !== 'live' || !this.config.liveEnabled)) {
      throw new PauseError('live_disabled', 'Simulation active : envoi d’enchères désactivé.');
    }
    if (!/^\/api\/(wikibidous$|marketplace(?:\?|\/))/.test(path) || path.includes('://')) {
      throw new PauseError('invalid_endpoint', 'Appel hors du périmètre du marché refusé.');
    }
    const wait = this.nextRequestAt - this.now();
    if (wait > 0) await this.sleep(wait);
    const started = this.now();
    const monotonicStarted = this.monotonicNow();
    let timing = null;
    this.lastTiming = null;
    let response;
    let body;
    let status;
    try {
      response = await this.request.fetch(`${ORIGIN}${path}`, {
        method,
        ...(data == null ? {} : { data }),
        headers: { Accept: 'application/json' },
        timeout: this.config.timeoutMs,
        maxRedirects: 0,
        maxRetries: 0,
        failOnStatusCode: false,
      });
      timing = {
        measurement: 'client_round_trip',
        requestStartedAt: new Date(started).toISOString(),
        responseReceivedAt: new Date(this.now()).toISOString(),
        roundTripMs: Math.round(Math.max(0, this.monotonicNow() - monotonicStarted) * 100) / 100,
      };
      status = response.status();
      try { body = await response.json(); }
      catch {
        throw new MarketApiError('invalid_api_response', 'Réponse non JSON : blocage ou interface modifiée ; arrêt.', { status, method, path, uncertain: method === 'POST' });
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new MarketApiError('invalid_api_response', 'Format de réponse API inattendu ; arrêt.', { status, method, path, uncertain: method === 'POST' });
      }
      if (status < 200 || status >= 300 || body.error || body.code === 'automation_limit' || body.human_verification_required) {
        const knownCodes = ['automation_limit', 'human_verification_required', 'pro_required', 'insufficient_balance', 'bid_too_low', 'auction_ended'];
        const serverCode = body.human_verification_required === true ? 'human_verification_required' : knownCodes.includes(body.code) ? body.code : null;
        const code = serverCode || (status === 401 ? 'login_required' : status === 429 ? 'rate_limited' : status === 403 ? 'access_denied' : status >= 500 ? 'server_error' : 'api_refused');
        const messages = {
          automation_limit: 'Le site refuse l’automatisation. Mise en pause sans nouvel essai.',
          human_verification_required: 'Vérification humaine demandée. Intervention manuelle nécessaire.',
          pro_required: 'Historique réservé au compte Pro : référence de prix indisponible.',
          insufficient_balance: 'Solde serveur insuffisant : enchère refusée.',
          bid_too_low: 'Une autre mise a changé le minimum requis.',
          auction_ended: 'L’enchère est déjà terminée.',
          login_required: 'Session expirée : connexion manuelle nécessaire.',
          rate_limited: 'Limite de requêtes atteinte. Mise en pause sans nouvel essai.',
          access_denied: 'Accès refusé par le site. Mise en pause.',
          server_error: 'Erreur serveur : résultat à vérifier avant de reprendre.',
          api_refused: 'Requête refusée par le serveur.',
        };
        throw new MarketApiError(code, messages[code], {
          status, method, path,
          uncertain: method === 'POST' && (status >= 500 || (status >= 200 && status < 300 && !serverCode)),
          minimum: money(body.min) ? body.min : null,
        });
      }
      this.lastTiming = timing;
      await this.log('api_ok', { message: `${method} ${path.split('?')[0]} : HTTP ${status}, aller-retour ${timing.roundTripMs} ms.`, method, path: path.split('?')[0], status, durationMs: timing.roundTripMs, timing });
      return body;
    } catch (error) {
      const failure = error instanceof MarketApiError ? error : new MarketApiError('network_error', 'Erreur réseau ou délai dépassé. Aucun nouvel essai automatique.', {
        status: status ?? null, method, path: path.split('?')[0], uncertain: method === 'POST',
      });
      // A moving bid minimum is an ordinary race. Every other refusal stops
      // the adapter, including when callers accidentally try another read.
      if (!['bid_too_low', 'auction_ended'].includes(failure.code)) this.blocked = true;
      await this.log('api_error', { message: failure.message, code: failure.code, method, path: path.split('?')[0], status: failure.status, uncertain: failure.uncertain, timing });
      throw failure;
    } finally {
      this.nextRequestAt = this.now() + this.config.requestGapMs;
      await response?.dispose().catch(() => {});
    }
  }

  async list(page, mine = false) {
    const query = new URLSearchParams({ page: String(page), limit: '50', sort: 'ending_soon', rarity: 'L' });
    if (mine) query.set('mine', '1');
    const data = await this.call(`/api/marketplace?${query}`);
    if (!Array.isArray(data.auctions) || typeof data.hasMore !== 'boolean') {
      throw new PauseError('invalid_market_response', 'Liste du marché incomplète.');
    }
    return data;
  }

  async wallet() {
    const data = await this.call('/api/wikibidous');
    if (!money(data.balance)) throw new PauseError('invalid_wallet', 'Solde du portefeuille illisible.');
    return data.balance;
  }

  async account(mine) {
    const userId = inferAccountId(mine, this.config.userId);
    const balance = await this.wallet();
    if (mine.bidding != null && !Array.isArray(mine.bidding)) throw new PauseError('account_unknown', 'Liste des enchères du compte illisible.');
    const leadingAuctionIds = (mine.bidding ?? []).filter(a => a.status === 'active' && a.current_bidder_id === userId).map(a => a.id);
    return { userId, balance, leadingAuctionIds };
  }

  async auction(auctionId) {
    const data = await this.call(`/api/marketplace/${id(auctionId)}`);
    if (data.auction?.id !== auctionId) throw new PauseError('invalid_auction_response', 'Détail d’enchère incohérent.');
    return data.auction;
  }

  async sales(cardId) {
    const data = await this.call(`/api/marketplace/cards/${id(cardId)}/sales`);
    if (!Array.isArray(data.sales)) throw new PauseError('invalid_sales_response', 'Historique des ventes incomplet.');
    return data.sales;
  }

  async bid(auctionId, amount) {
    if (!money(amount) || amount < 1 || amount > this.config.maxPerCard) throw new PauseError('invalid_bid', 'Mise hors plafond refusée avant envoi.');
    const result = await this.call(`/api/marketplace/${id(auctionId)}/bid`, 'POST', { amount });
    this.bidRoundTrips.push(this.lastTiming.roundTripMs);
    if (this.bidRoundTrips.length > 20) this.bidRoundTrips.shift();
    const sorted = this.bidRoundTrips.toSorted((a, b) => a - b);
    return {
      ...result,
      clientTiming: {
        ...this.lastTiming,
        sessionSampleCount: sorted.length,
        sessionMinMs: sorted[0],
        sessionMaxMs: sorted.at(-1),
        sessionMedianMs: (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2,
      },
    };
  }
}
