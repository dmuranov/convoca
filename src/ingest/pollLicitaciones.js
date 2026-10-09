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
// Two tiers, two caps, but only ONE reason enrichment itself is paced: blast radius on
// unsampled output. Enriching writes titulo/resumen to licitacion_row - nothing here ever
// touches the public site or the search index; publishing (operator console, manual) is
// the only step that does. This is NOT about index composition. (A prior version of this
// comment conflated the two - enriching the historical tier "slowly" was never protecting
// the index; only refusing to publish it does. See the estado gate on publish-batch in
// routes/operator.js for where that actually lives, and convoca-claude-cli-prod-risk memory
// for the full correction.)
// A sample of both tiers was reviewed 2026-09-07 (clean titulo/resumen, sensible
// campos_ausentes, no hallucination) and the backlog cleared in one shot via
// scripts/reenrich-licitaciones.js. These caps now just bound one day's worth of ordinary
// drift (a poll interrupted mid-run, a batch that timed out) rather than a whole unreviewed
// backlog - raised well past daily new-row volume (~150-180/day) so they never bind in
// practice, not left at the original review-pacing values.
const OPEN_TENDER_ESTADOS = ['licitacion', 'anuncio_previo', 'pendiente_adjudicacion'];
const OPEN_TENDER_DRAIN_CAP = Number(process.env.OPEN_TENDER_DRAIN_CAP || 1000);
const HISTORICAL_DRAIN_CAP = Number(process.env.LICITACION_BACKLOG_CAP || 1000);
// See poll.js for the reasoning: enriched===0 alone misses "40 of 50 failed", and a flat
// batchFailed>0 would fire on the occasional single benign failure every normal day.
const BATCH_FAILURE_ALERT_RATIO = Number(process.env.POLL_BATCH_FAILURE_RATIO || 0.3);
// entries.length===0 only catches the feed breaking outright (auth, schema, empty
// response - see below). It does NOT catch the feed responding normally with entries but
// none of them actually new: discovered 2026-09-07 when PLACSP's own base page sat frozen
// at the same <updated> timestamp for ~3.5 days straight (a real upstream stall, not a
// convoca bug - the poller kept running on schedule and correctly found 0 new each time,
// which is indistinguishable from a genuine quiet day without this check). entries[0] is
// the single newest item the feed offers (page 1, newest-first) after every walkFeed call.
const STALE_FEED_HOURS = Number(process.env.PLACSP_STALE_HOURS || 30);

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
  // A tender whose estado changes inside the walked window appears more than once; the feed
  // is newest-first, so the first copy is the current one.
  const seenExp = new Set();
  for (const e of entries) {
    if (seenExp.has(e.expediente)) continue;
    seenExp.add(e.expediente);
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
  // See poll.js: ratio, not enriched===0 - a batch where 40 of 50 fail is exactly the
  // failure this exists to catch, and enriched===0 alone would miss it.
  if (toEnrich.length > 0 && batchFailed / toEnrich.length > BATCH_FAILURE_ALERT_RATIO) {
    alert('poll_batch_failed', `${batchFailed} of ${toEnrich.length} licitación(es) `
      + `submitted for enrichment failed - check Anthropic API status/credentials before assuming a content problem`);
  }
  // Same reasoning as poll.js: a run where everything was already `unchanged` is a normal
  // quiet day, but PLACSP returning zero entries at all across a fresh page walk means the
  // feed itself broke silently, not that nothing happened.
  if (entries.length === 0) {
    alert('placsp_poll', 'zero entries returned from the PLACSP feed - check reachability');
  } else {
    const newestMs = Date.parse(entries[0].updated);
    const ageHours = (Date.now() - newestMs) / 3_600_000;
    if (Number.isFinite(ageHours) && ageHours > STALE_FEED_HOURS) {
      alert('placsp_stale', `PLACSP feed's newest entry is ${ageHours.toFixed(1)}h old `
        + `(> ${STALE_FEED_HOURS}h threshold, expediente ${entries[0].expediente}) - `
        + `feed responded normally but hasn't advanced; likely stalled upstream at PLACSP, not a poll failure`);
    }
  }
  return enriched;
}

export async function pollLicitacionesOnce() {
  if (running) { console.log('placsp poll: already running, skipping this trigger'); return 0; }
  running = true;
  try { return await runPoll(); }
  finally { running = false; }
}

// negate=false: estado IN (...OPEN_TENDER_ESTADOS) - the open/recent tier.
// negate=true: estado NOT IN (...OPEN_TENDER_ESTADOS) - everything else (historical).
async function drainTier(label, negate, limit) {
  const placeholders = OPEN_TENDER_ESTADOS.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT * FROM licitacion_row WHERE titulo IS NULL
     AND estado ${negate ? 'NOT IN' : 'IN'} (${placeholders})
     -- Open tier: what can still be bid on comes first, soonest deadline first (oldest-created
     -- first left the week's new, biddable tenders waiting behind August's).
     ORDER BY ${negate ? 'created_at ASC' : "(fecha_limite IS NOT NULL AND fecha_limite < date('now')), fecha_limite IS NULL, fecha_limite ASC, created_at ASC"} LIMIT ?`
  ).all(...OPEN_TENDER_ESTADOS, limit);
  if (!rows.length) return 0;
  const prepared = rows.map(row => ({ id: row.id, expediente: row.expediente, context: contextFromRow(row) }));
  const { enriched, failed } = await enrichBatch(prepared);
  pingPublishedAmong(prepared);
  console.log(`backlog drain (${label}): ${enriched} enriched, ${failed} failed`);
  if (failed / prepared.length > BATCH_FAILURE_ALERT_RATIO) {
    alert('poll_batch_failed', `${label} backlog: ${failed} of ${prepared.length} `
      + `licitación(es) submitted for enrichment failed - check Anthropic API status/credentials`);
  }
  return enriched;
}

// Re-enriches rows the poll already wrote deterministic fields for but never got an AI
// job enqueued (walkFeed may not even revisit them - see isCurrent above). Reads
// raw_text/pliegos straight from the row, no PLACSP/pliego re-fetch. Two separate tiers,
// two separate caps - see OPEN_TENDER_DRAIN_CAP/HISTORICAL_DRAIN_CAP above for why.
export async function drainStrandedLicitaciones() {
  const openEnriched = await drainTier('open/recent', false, OPEN_TENDER_DRAIN_CAP);
  const historicalEnriched = await drainTier('historical', true, HISTORICAL_DRAIN_CAP);
  return { enriched: openEnriched + historicalEnriched };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  pollLicitacionesOnce()
    .then(n => { console.log(`poll done, ${n} enriched`); process.exit(0); })
    .catch(e => { alert('placsp_poll', e.message); process.exit(1); });
}
