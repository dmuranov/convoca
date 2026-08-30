// Daily PLACSP poll.
//
// Unlike BDNS (bounded by a date-range query), the PLACSP feed has no query API - just
// pages of newest-updated-first entries. There is no way to ask "only give me what
// changed since yesterday", so a run walks pages until it hits one where every entry is
// already stored with the same updated_at (nothing left to do), capped by MAX_PAGES as a
// hard stop in case that newest-first assumption ever breaks.
import 'dotenv/config';
import { db } from '../db.js';
import { alert } from './bdns.js';
import { walkFeed } from './placsp.js';
import { prepareEnrichment, enrichBatch } from './enrichLicitacion.js';

const MAX_PAGES = Number(process.env.PLACSP_MAX_PAGES || 15);

export async function pollLicitacionesOnce() {
  const known = new Map(
    db.prepare('SELECT expediente, updated_at FROM licitacion_row').all()
      .map(r => [r.expediente, r.updated_at])
  );
  const isCurrent = (e) => known.get(e.expediente) === e.updated;

  const entries = await walkFeed(
    (pageEntries) => pageEntries.length > 0 && pageEntries.every(isCurrent),
    MAX_PAGES,
  );

  const toEnrich = [];
  let unchanged = 0, prepFailed = 0;
  for (const e of entries) {
    if (isCurrent(e)) { unchanged++; continue; }
    try {
      toEnrich.push(await prepareEnrichment(e));
    } catch (err) {
      prepFailed++;
      alert('placsp_enrich', `expediente ${e.expediente}: ${err.message}`);
    }
  }

  const { enriched, failed: batchFailed } = await enrichBatch(toEnrich);
  const failed = prepFailed + batchFailed;
  console.log(`placsp poll done: ${enriched} enriched (awaiting publish), ${unchanged} unchanged, `
    + `${failed} failed (of ${entries.length} entries seen)`);
  return enriched;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  pollLicitacionesOnce()
    .then(n => { console.log(`poll done, ${n} enriched`); process.exit(0); })
    .catch(e => { alert('placsp_poll', e.message); process.exit(1); });
}
