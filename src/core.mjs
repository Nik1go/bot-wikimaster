export class PauseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PauseError';
    this.code = code;
  }
}

function integer(env, name, fallback, min, max) {
  const raw = env[name] ?? String(fallback);
  if (!/^\d+$/.test(raw)) throw new Error(`${name}: entier requis`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name}: valeur entre ${min} et ${max} requise`);
  }
  return value;
}

export function readConfig(env = process.env) {
  return Object.freeze({
    baseUrl: 'https://www.wiki-masters.com',
    dataDir: env.DATA_DIR || './data',
    timezone: env.TZ || 'Europe/Paris',
    intervalMs: integer(env, 'INTERVAL_MINUTES', 60, 60, 1440) * 60_000,
    maxPacks: integer(env, 'MAX_PACKS_PER_SESSION', 10, 1, 10),
    packDelayMs: integer(env, 'BETWEEN_PACKS_SECONDS', 15, 3, 300) * 1000,
    cardDelayMs: integer(env, 'BETWEEN_CARDS_SECONDS', 2, 1, 30) * 1000,
    verificationTimeoutMs: integer(env, 'VERIFICATION_TIMEOUT_SECONDS', 120, 15, 180) * 1000,
  });
}

export function parseInventory(text) {
  const match = text.match(/(\d+)\s*\/\s*(\d+)\s*paquets disponibles/i);
  if (!match) throw new PauseError('interface_changed', 'Compteur de paquets introuvable.');
  const available = Number(match[1]);
  const capacity = Number(match[2]);
  if (capacity < 1 || capacity > 100 || available > capacity) {
    throw new PauseError('interface_changed', 'Compteur de paquets incohérent.');
  }
  return { available, capacity };
}

export function nextAllowedStart(lastStartedAt, intervalMs, now = Date.now()) {
  if (lastStartedAt == null) return now;
  const previous = Date.parse(lastStartedAt);
  if (!Number.isFinite(previous)) {
    throw new PauseError('schedule_invalid', 'Historique horaire illisible.');
  }
  return Math.max(now, previous + intervalMs);
}

// The initial stock fixes the session quota: regeneration never extends a batch.
export async function runBatch(site, config, { sleep, log }) {
  const inventory = await site.prepare();
  const quota = Math.min(inventory.available, config.maxPacks);
  const result = { initialStock: inventory.available, opened: 0, cards: [] };
  await log('session_started', { available: inventory.available, quota });
  for (let index = 0; index < quota; index++) {
    if (index > 0) await sleep(config.packDelayMs);
    const pack = await site.openOne();
    result.opened++;
    result.cards.push(...pack.cards);
    await log('pack_opened', { number: result.opened, cards: pack.cards, remaining: pack.remaining });
    if (pack.remaining === 0) break;
  }
  await log('session_finished', { opened: result.opened });
  return result;
}
