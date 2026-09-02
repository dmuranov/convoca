// Daily PLACSP poll.
//
// Unlike BDNS (bounded by a date-range query), the PLACSP feed has no query API - just
// pages of newest-updated-first entries. There is no way to ask "only give me what
// changed since yesterday", so a run walks pages until it hits one where every entry is
// already stored with the same updated_at (nothing left to do), capped by MAX_PAGES as a
// hard stop in case that newest-first assumption ever breaks.
//
// IndexNow pings for a published row's estado change happen after enrichBatch() actually
// completes - not at prepareEnrichment time (deterministic phase only), which would tell
// IndexNow to recrawl before the fresh AI content (titulo/resumen/requisitos, likely stale
// or thin from before this transition) is actually written, wasting the fast-crawl window
// on stale content. (Used to live in scripts/worker.js's per-job dispatch, back when this
// went through the claude-cli queue - see convoca-claude-cli-prod-risk memory for why
// that's no longer the live path; moved here so re-enrichment keeps pinging regardless of
// which enrichment path is current.)
import 'dotenv/config';
import { db } from '../db.js';
import { alert } from './bdns.js';
import { walkFeed } from './placsp.js';
import { prepareEnrichment, contextFromRow, enrichBatch } from './enrichLicitacion.js';
import { pingIndexNow } from '../indexnow.js';
import { BASE_URL, licitacionPath } from '../seoUtils.js';

function pingPublishedAmong(prepared) {
  if (!prepared.length) return;
  const ids = prepared.map(p => p.id);
  const rows = db.prepare(
    `SELECT id, titulo, expediente FROM licitacion_row
     WHERE published = 1 AND id IN (${ids.map(() => '?').join(',')})`
  ).all(...ids);
  if (rows.length) pingIndexNow(rows.map(r => BASE_URL + licitacionPath(r)));
}

const MAX_PAGES = Number(process.env.PLACSP_MAX_PAGES || 15);
// Caps how many stranded rows (see isCurrent below) get re-submitted per call - kept as a
// pacing limit even on the Batch API path (no per-job rate-limit contention to avoid here
// any more, see convoca-claude-cli-prod-risk memory, but still no reason to put an
// incident-sized backlog through in one Anthropic bill). Deliberately small.
const BACKLOG_DRAIN_CAP = Number(process.env.LICITACION_BACKLOG_CAP || 50);

// Guards against a second concurrent walk (cron firing while a manual "Sondear PLACSP"
// trigger is still running, or an impatient double-click) - two walkFeed runs against the
// same feed would both prepare and enqueue the same entries, doubling pliego fetches and
// queue volume against the same subscription rate limit. Single Node process
// (pm2 instances:1), so a plain module-level flag is safe with no interleaving between
// the check and the set.
let running = false;
export function pollStatus() { return running; }

async function runPoll() {
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

  const { enriched, failed: batchFailed } = await enrichBatch(toEnrich);
  pingPublishedAmong(toEnrich);
  console.log(`placsp poll done: ${enriched} enriched (awaiting publish), ${unchanged} unchanged, `
    + `${prepFailed + batchFailed} failed (of ${entries.length} entries seen)`);
  // See poll.js: a whole batch failing outright is the fast, threshold-free "is ingest
  // currently failing" signal - not a substitute for the volume tripwire, a replacement
  // for the thing it can't do.
  if (toEnrich.length > 0 && enriched === 0) {
    alert('poll_batch_failed', `all ${toEnrich.length} licitación(es) submitted for `
      + `enrichment failed - check Anthropic API status/credentials before assuming a content problem`);
  }
  // Same reasoning as poll.js: a run where everything was already `unchanged` is a normal
  // quiet day, but PLACSP returning zero entries at all across a fresh page walk means the
  // feed itself broke silently, not that nothing happened.
  if (entries.length === 0) {
    alert('placsp_poll', 'zero entries returned from the PLACSP feed - check reachability');
  }
  return enriched;
}

export async function pollLicitacionesOnce() {
  if (running) { console.log('placsp poll: already running, skipping this trigger'); return 0; }
  running = true;
  try { return await runPoll(); }
  finally { running = false; }
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
  if (!rows.length) return { enriched: 0 };
  const prepared = rows.map(row => ({ id: row.id, expediente: row.expediente, context: contextFromRow(row) }));
  const { enriched, failed } = await enrichBatch(prepared);
  pingPublishedAmong(prepared);
  console.log(`backlog drain: ${enriched} stranded licitación(es) enriched, ${failed} failed`);
  if (prepared.length > 0 && enriched === 0) {
    alert('poll_batch_failed', `all ${prepared.length} backlog licitación(es) submitted `
      + `for enrichment failed - check Anthropic API status/credentials`);
  }
  return { enriched };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  pollLicitacionesOnce()
    .then(n => { console.log(`poll done, ${n} enriched`); process.exit(0); })
    .catch(e => { alert('placsp_poll', e.message); process.exit(1); });
}
