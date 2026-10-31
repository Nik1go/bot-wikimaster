import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { stat } from 'node:fs/promises';
import path from 'node:path';

const clean = value => String(value ?? '').replace(/[\x00-\x1f\x7f|]/g, ' ').slice(0, 300);
export function renderMarketReport(events, timezone = 'Europe/Paris') {
  const rows = events.filter(e => !['api_ok', 'candidate_rejected'].includes(e.event));
  const lines = [
    '# Journal du marché', '',
    'Les montants simulés ne sont pas des achats. Les écarts à la moyenne ne sont pas des bénéfices garantis.', '',
    '| Heure | Événement | Carte / enchère | Montant WB | Explication |',
    '| --- | --- | --- | ---: | --- |',
  ];
  for (const event of rows) {
    const date = new Date(event.at);
    const time = Number.isFinite(date.getTime()) ? date.toLocaleString('fr-FR', { timeZone: timezone }) : '';
    const amount = event.amount ?? event.nextBid ?? event.purchasePrice ?? '';
    lines.push(`| ${clean(time)} | ${clean(event.mode)} / ${clean(event.event)} | ${clean(event.title || event.auctionId)} | ${clean(amount)} | ${clean(event.message)} |`);
    if (event.event === 'scan_finished' && event.reasons) {
      lines.push(`| | Motifs de rejet | | | ${clean(Object.entries(event.reasons).map(([key, n]) => `${key}: ${n}`).join(', '))} |`);
    }
  }
  if (!rows.length) lines.push('| | Aucun événement | | | Le marché n’a pas encore tourné. |');
  return `${lines.join('\n')}\n`;
}

export async function readMarketEvents(stateDir, limit = 500) {
  const file = path.join(stateDir, 'events.jsonl');
  try { await stat(file); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const events = [];
  const input = createReadStream(file, { encoding: 'utf8' });
  const reader = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      try { events.push(JSON.parse(line)); } catch { continue; }
      if (events.length > limit) events.shift();
    }
  } finally { reader.close(); input.destroy(); }
  return events;
}
