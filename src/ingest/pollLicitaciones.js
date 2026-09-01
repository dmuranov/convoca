// Daily PLACSP poll.
//
// Unlike BDNS (bounded by a date-range query), the PLACSP feed has no query API - just
// pages of newest-updated-first entries. There is no way to ask "only give me what
// changed since yesterday", so a run walks pages until it hits one where every entry is
// already stored with the same updated_at (nothing left to do), capped by MAX_PAGES as a
// hard stop in case that newest-first assumption ever breaks.
//
// IndexNow pings for a published row's estado change happen in scripts/worker.js, after
// the queued re-enrichment actually completes - not here. Pinging at prepareEnrichment
// time (deterministic phase only) would tell IndexNow to recrawl before the fresh AI
// content (titulo/resumen/requisitos, likely stale or thin from before this transition)
// is actually written, wasting the fast-crawl window on stale content.
import 'dotenv/config';
import { db } from '../db.js';
import { alert } from './bdns.js';
import { walkFeed } from './placsp.js';
import { prepareEnrichment } from './enrichLicitacion.js';
import { enqueueLicitacionJobs } from './queue.js';

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

  const { queued } = await enqueueLicitacionJobs(toEnrich);
  console.log(`placsp poll done: ${queued} queued for enrichment, ${unchanged} unchanged, `
    + `${prepFailed} prep failed (of ${entries.length} entries seen)`);
  // Same reasoning as poll.js: a run where everything was already `unchanged` is a normal
  // quiet day, but PLACSP returning zero entries at all across a fresh page walk means the
  // feed itself broke silently, not that nothing happened.
  if (entries.length === 0) {
    alert('placsp_poll', 'zero entries returned from the PLACSP feed - check reachability');
  }
  return queued;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  pollLicitacionesOnce()
    .then(n => { console.log(`poll done, ${n} queued`); process.exit(0); })
    .catch(e => { alert('placsp_poll', e.message); process.exit(1); });
}
