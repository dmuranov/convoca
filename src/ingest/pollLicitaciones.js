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
import { prepareEnrichment, contextFromRow } from './enrichLicitacion.js';
import { enqueueLicitacionJobs } from './queue.js';

const MAX_PAGES = Number(process.env.PLACSP_MAX_PAGES || 15);
// Caps how many stranded rows (see isCurrent below) get re-queued per call - a large
// backlog (e.g. after a crash-during-poll incident) must drain gradually, not compete
// with the day's fresh volume for the same 20s-per-job worker and the same subscription
// rate limit. Deliberately small; see convoca-claude-cli-prod-risk memory.
const BACKLOG_DRAIN_CAP = Number(process.env.LICITACION_BACKLOG_CAP || 50);

export async function pollLicitacionesOnce() {
  // titulo IS NOT NULL is part of "current", not just updated_at matching the feed - a row
  // whose deterministic fields got written by prepareEnrichment() but whose AI job never
  // got enqueued (a poll interrupted mid-run, e.g. a memory-restart) must still look
  // "changed" here, or it's stranded forever: PLACSP won't bump updated_at just because we
  // failed to finish with it, so nothing would ever revisit it otherwise.
  const known = new Map(
    db.prepare('SELECT expediente, updated_at, titulo FROM licitacion_row').all()
      .map(r => [r.expediente, r])
  );
  const isCurrent = (e) => {
    const row = known.get(e.expediente);
    return !!row && row.updated_at === e.updated && row.titulo !== null;
  };

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

// Re-enriches rows the poll already wrote deterministic fields for but never got an AI
// job enqueued (walkFeed may not even revisit them - see isCurrent above). Reads
// raw_text/pliegos straight from the row, no PLACSP/pliego re-fetch. Capped and ordered
// open-tenders-first so an incident-sized backlog can't crowd out the day's fresh jobs.
export async function drainStrandedLicitaciones(limit = BACKLOG_DRAIN_CAP) {
  const rows = db.prepare(
    `SELECT * FROM licitacion_row WHERE titulo IS NULL
     ORDER BY (estado = 'licitacion') DESC, created_at ASC LIMIT ?`
  ).all(limit);
  if (!rows.length) return { queued: 0 };
  const prepared = rows.map(row => ({ id: row.id, expediente: row.expediente, context: contextFromRow(row) }));
  const { queued } = await enqueueLicitacionJobs(prepared);
  console.log(`backlog drain: ${queued} stranded licitación(es) re-queued for enrichment`);
  return { queued };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  pollLicitacionesOnce()
    .then(n => { console.log(`poll done, ${n} queued`); process.exit(0); })
    .catch(e => { alert('placsp_poll', e.message); process.exit(1); });
}
