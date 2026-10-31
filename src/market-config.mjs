function integer(env, name, fallback, min, max) {
  const raw = env[name] ?? String(fallback);
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name}: entier entre ${min} et ${max} requis`);
  }
  return value;
}

function boolean(env, name, fallback) {
  const value = env[name] ?? String(fallback);
  if (value !== 'true' && value !== 'false') throw new Error(`${name}: true ou false requis`);
  return value === 'true';
}

export function readMarketConfig(env = process.env) {
  const mode = env.MARKET_MODE ?? 'simulation';
  if (!['simulation', 'live'].includes(mode)) throw new Error('MARKET_MODE: simulation ou live requis');
  const rankBy = env.MARKET_RANK_BY ?? 'saving';
  if (!['saving', 'discount', 'price'].includes(rankBy)) throw new Error('MARKET_RANK_BY: saving, discount ou price requis');
  const minSeconds = integer(env, 'MARKET_MIN_SECONDS', 30, 15, 300);
  const maxSeconds = integer(env, 'MARKET_MAX_SECONDS', 120, minSeconds, 600);
  const minSales = integer(env, 'MARKET_MIN_SALES', 3, 1, 100);
  return Object.freeze({
    mode,
    liveEnabled: boolean(env, 'MARKET_LIVE_ENABLED', false),
    dataDir: env.DATA_DIR || './data',
    timezone: env.TZ || 'Europe/Paris',
    rankBy,
    maxPositions: 1,
    maxPerCard: integer(env, 'MARKET_MAX_PER_CARD', 3500, 1, 3500),
    maxReferencePercent: integer(env, 'MARKET_MAX_REFERENCE_PERCENT', 50, 1, 50),
    walletReserve: integer(env, 'MARKET_WALLET_RESERVE', 0, 0, 1_000_000),
    minSeconds,
    maxSeconds,
    minSales,
    maxSales: integer(env, 'MARKET_REFERENCE_SALES', 10, minSales, 100),
    historyAgeMs: integer(env, 'MARKET_HISTORY_DAYS', 30, 1, 90) * 86_400_000,
    cacheMs: integer(env, 'MARKET_REFERENCE_CACHE_MINUTES', 360, 1, 1440) * 60_000,
    scanIntervalMs: integer(env, 'MARKET_SCAN_INTERVAL_MINUTES', 60, 60, 1440) * 60_000,
    pollMs: integer(env, 'MARKET_POLL_SECONDS', 15, 10, 120) * 1000,
    requestGapMs: integer(env, 'MARKET_REQUEST_GAP_SECONDS', 2, 1, 60) * 1000,
    timeoutMs: integer(env, 'MARKET_REQUEST_TIMEOUT_SECONDS', 10, 3, 30) * 1000,
    maxPages: integer(env, 'MARKET_MAX_PAGES', 5, 1, 20),
    maxHistories: integer(env, 'MARKET_MAX_HISTORIES', 10, 1, 30),
    maxWatchMs: integer(env, 'MARKET_MAX_WATCH_MINUTES', 30, 5, 120) * 60_000,
    // Optional for an account without any past purchases/sales to identify it.
    userId: env.MARKET_USER_ID || null,
  });
}
