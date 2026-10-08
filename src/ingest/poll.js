// Daily BDNS poll.
//
// Two audiences, two scopes (spec §1, revised):
//   - Grassroots directory  — ALL of Spain. Only convocatorias a village, association
//     or club can actually apply to, so national rows are screened (see screen()).
//   - Palencia/CyL pilot    — the alcalde product. Everything in scope is enriched,
//     including direct awards, because "who already got what" is the intelligence
//     we sell to the Diputación.
//
// Screening happens on the BDNS detail record, which is a plain HTTP call, before any
// LLM extraction. Roughly two thirds of BDNS is "Concesión directa" — money already
// assigned to a named beneficiary, with nothing for anyone to apply to — so screening
// first is the difference between enriching ~1.1k/month and ~3.4k/month.
import 'dotenv/config';
import { db, uuid } from '../db.js';
import { bdnsGet, ddmmyyyy, alert } from './bdns.js';
import { prepareEnrichment, enrichBatch, endDateFromDetail, saysClosed } from './enrich.js';

const LOOKBACK_DAYS = Number(process.env.POLL_LOOKBACK_DAYS || 7);
const PAGE_SIZE = 200;
const MAX_PAGES = Number(process.env.POLL_MAX_PAGES || 60);
// Politeness delay between BDNS detail calls; the API is known to block noisy clients.
const THROTTLE_MS = Number(process.env.POLL_THROTTLE_MS || 250);
// A pure enriched===0 check misses "40 of 50 failed" - a schema change, a malformed-PDF
// class, a partial API incident - which the old per-job queue surfaced for free (every
// failed job alerted individually). A flat batchFailed>0 would instead fire on the
// occasional single benign failure ("extract" already logs those) every normal day. This
// ratio is the middle ground: ignore noise, catch a batch that's actually broken.
const BATCH_FAILURE_ALERT_RATIO = Number(process.env.POLL_BATCH_FAILURE_RATIO || 0.3);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function levelFromNivel1(nivel1) {
  const n = (nivel1 || '').toUpperCase();
  if (n.includes('LOCAL')) return 'provincial';        // Diputación/ayuntamientos arrive as LOCAL
  if (n.includes('ESTADO') || n.includes('ESTATAL')) return 'estatal';
  return 'autonomico';
}

// Pilot territory: the alcalde product's scope. Matched on the organism path
// (nivel2/nivel3), which is where BDNS puts the CCAA and the granting body.
const PILOT_RE = /CASTILLA Y LE[ÓO]N|PALENCIA/i;
export const isPilotScope = (row) => PILOT_RE.test(`${row.nivel2 || ''} ${row.nivel3 || ''}`);

// Decide whether a national row earns an LLM extraction. Returns null to enrich,
// or a short reason string to skip. Pilot rows bypass this entirely.
//
// Beneficiary type is deliberately NOT screened. An earlier version dropped anything whose
// beneficiaries were only "PYME Y PERSONAS FÍSICAS QUE DESARROLLAN ACTIVIDAD ECONÓMICA",
// which silently excluded the LEADER calls the GALs publish here — rural micro-enterprise
// aid is the whole point of LEADER, and a village's autónomo is the same person the rest
// of the directory serves. The cost is that some purely urban business aid now gets
// enriched too; the territory filter, not the beneficiary type, is what keeps the
// directory rural.
// Some LEADER groups register their open call for projects as "Concesión directa" in BDNS
// (seen 2026-10: MACOVALL 865356, CEDER Tiétar 808337, Ceuta 840814, ARADUEY 913434), so
// the type alone would drop exactly the rural-business calls the Negocios page is for. Let a
// direct award through only when it reads as a call ("convocatoria") in a LEADER /
// local-development context and is not one of the usual named transfers (nominativa,
// convenio, running costs). The deadline check below and the operator gate still apply.
export const LEADER_TEXT = /\bLEADER\b|DESARROLLO LOCAL PARTICIPATIVO|\bEDLP?\b|GRUPOS? DE ACCI[OÓ]N LOCAL|\bGAL\b|\bGDR\b/i;
export function isMislabelledLeaderCall(detail) {
  const text = [detail.descripcion, detail.descripcionFinalidad, detail.organo?.nivel2, detail.organo?.nivel3].filter(Boolean).join(' ');
  return /\bCONV(OCATORIA)?\b/i.test(detail.descripcion || '')
    && LEADER_TEXT.test(text)
    && !/NOMINATIVA|CONVENIO|GASTOS DE FUNCIONAMIENTO|COFINAN/i.test(detail.descripcion || '');
}

export function screen(detail, today = new Date().toISOString().slice(0, 10)) {
  const tipo = detail.tipoConvocatoria || '';
  if (!/concurrencia competitiva/i.test(tipo) && !isMislabelledLeaderCall(detail)) {
    return `no competitiva (${tipo || 'tipo desconocido'})`;
  }
  // Nobody can apply to a closed call, so never pay to extract one. Barely matters on the
  // daily poll; on a long backfill it is the difference between enriching everything BDNS
  // published in a year and enriching only what is still live.
  // A known end date wins over BDNS's `abierto` flag, which goes stale (see parseEndDate).
  const fin = endDateFromDetail(detail);
  if (fin && fin < today) return `plazo cerrado (${fin})`;
  if (!fin && saysClosed(detail)) return 'plazo cerrado (según BDNS)';
  return null;
}

// Guards against a second concurrent walk (cron firing while a manual "Sondear BDNS"
// trigger is still running, or an impatient double-click) - two runs against the same
// window would both prepare and enqueue the same fresh rows, doubling BDNS/PDF fetches
// and job-queue volume for nothing. Single Node process (pm2 instances:1), so a plain
// module-level flag is safe with no interleaving between the check and the set.
let running = false;
export function pollStatus() { return running; }

async function runPoll() {
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
  const seen = new Map(); // numeroConvocatoria -> search row

  // POLL_REGIONS restricts the sweep to specific BDNS region codes (e.g. "33" for
  // Palencia). Unset means all of Spain, which is the daily behaviour; it exists so a
  // catch-up run over a long window can be done one province at a time.
  const regions = (process.env.POLL_REGIONS || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const region of regions.length ? regions : [null]) {
    let page = 0, totalPages = 1;
    while (page < totalPages && page < MAX_PAGES) {
      const j = await bdnsGet('/convocatorias/busqueda', {
        page: String(page), pageSize: String(PAGE_SIZE),
        fechaDesde: ddmmyyyy(from), fechaHasta: ddmmyyyy(today),
        ...(region ? { regiones: region } : {}),
      });
      totalPages = j.totalPages ?? 1;
      for (const row of j.content || []) seen.set(row.numeroConvocatoria, row);
      page++;
    }
    if (page >= MAX_PAGES && page < totalPages) {
      alert('poll', `hit MAX_PAGES=${MAX_PAGES} with ${totalPages} pages available`
        + `${region ? ` for region ${region}` : ''} — window may be truncated`);
    }
  }

  // A row is only "done" if it was screened out or successfully enriched, not merely
  // "exists" - the same class of bug pollLicitaciones.js had (2026-09-01): a crash
  // mid-loop below leaves a row inserted with neither skip_reason nor plain_title set,
  // and treating existence alone as "already handled" would strand it forever, since
  // BDNS gives no per-row signal that would ever make it look "changed" again.
  console.log(`poll: ${seen.size} in ${LOOKBACK_DAYS}-day window`
    + `${regions.length ? ` (regions ${regions.join(',')})` : ' (Spain)'}`);
  // A quiet day (fresh=0, everything already known) is normal. Zero results from BDNS
  // itself over a full 7-day nationwide window never legitimately happens - it means the
  // search API broke silently (auth, schema change, empty response) with no exception to
  // catch. Timeouts (llm.js) stop a hung *enrichment* call; this catches a poll that
  // "succeeds" having done nothing.
  if (seen.size === 0) {
    alert('poll', `zero convocatorias returned from BDNS across the ${LOOKBACK_DAYS}-day window`
      + `${regions.length ? ` (regions ${regions.join(',')})` : ' (Spain)'} - check BDNS reachability`);
  }

  return ingestRows(seen);
}

// Screen, enrich and store a set of BDNS search rows (numeroConvocatoria -> row). Shared by
// the daily poll and one-off catch-ups such as scripts/backfill-leader.js.
export async function ingestRows(seen) {
  const existing = db.prepare('SELECT id, skip_reason, plain_title FROM grant_row WHERE bdns_ref = ?');
  // `region` is deliberately left for enrichment: the search row's nivel2 is the granting
  // body's name (a municipality, a mancomunidad), not a territory. See ingest/regions.js.
  const ins = db.prepare(`INSERT INTO grant_row
    (id, bdns_ref, title, granting_body, granting_level, open_date, status, source_url)
    VALUES (?, ?, ?, ?, ?, ?, 'ANNOUNCED', ?)`);

  const fresh = [];
  for (const [ref, row] of seen) {
    const prior = existing.get(ref);
    if (prior && (prior.skip_reason != null || prior.plain_title != null)) continue;
    const id = prior?.id || uuid();
    if (!prior) {
      ins.run(id, ref, row.descripcion || '(sin título)',
        [row.nivel2, row.nivel3].filter(Boolean).join(' — '),
        levelFromNivel1(row.nivel1), row.fechaRecepcion || null,
        `https://www.infosubvenciones.es/bdnstrans/GE/es/convocatoria/${ref}`);
    }
    fresh.push({ id, ref, row });
  }
  console.log(`ingest: ${seen.size} rows, ${fresh.length} new/stranded`);

  // Rows we skip stay in grant_row unpublished, so they are never reconsidered:
  // the dedupe above means each reference costs at most one detail call, ever.
  //
  // The BDNS detail + bases-PDF fetches below stay sequential and throttled (that API
  // blocks noisy clients); the LLM call does not — prepareEnrichment() only does the
  // deterministic work (deadline, territory, PDF text) and every screened-in grant is
  // queued into a single Batch API call afterward instead of paying list price one at a
  // time. See src/ingest/enrich.js.
  //
  // Back on the API-key path as of 2026-09-02 (was claude-cli/subscription for one day) -
  // that path shares its rate-limit budget with any interactive Claude Code session on the
  // same account, including whatever session is actively debugging convoca itself, which
  // made the two impossible to reason about independently. scripts/worker.js and the
  // Postgres job queue (src/ingest/queue.js) are kept as the reverse fallback, same as
  // enrichBatch() was kept as this one - see convoca-claude-cli-prod-risk memory.
  const toEnrich = [];
  let skipped = 0, prepFailed = 0;
  for (const g of fresh) {
    try {
      const detail = await bdnsGet('/convocatorias', { numConv: g.ref });
      // Who BDNS says can apply — kept for the businesses section (/api/negocios).
      db.prepare('UPDATE grant_row SET beneficiarios_bdns = ? WHERE id = ?')
        .run(JSON.stringify((detail.tiposBeneficiarios || []).map(t => t.descripcion).filter(Boolean)), g.id);
      const pilot = isPilotScope(g.row);
      const reason = pilot ? null : screen(detail);
      if (reason) {
        skipped++;
        db.prepare('UPDATE grant_row SET skip_reason = ? WHERE id = ?').run(reason, g.id);
      } else {
        toEnrich.push(await prepareEnrichment(g.id, g.ref, { detail }));
        // Note: enriched rows still land unpublished. Nothing reaches the public
        // directory without an operator publishing it (see routes/operator.js).
      }
    } catch (e) {
      prepFailed++;
      alert('enrich', `convocatoria ${g.ref}: ${e.message}`);
    }
    await sleep(THROTTLE_MS);
  }

  const { enriched, failed: batchFailed } = await enrichBatch(toEnrich);
  const failed = prepFailed + batchFailed;
  console.log(`poll done: ${enriched} enriched (awaiting publish), ${skipped} skipped (not applicable), ${failed} failed`);
  // "Is ingest currently failing" beats any volume/day threshold for catching this kind of
  // fault (2026-09-02's 26-minute rate-limit blackout would have tripped this immediately,
  // where the 300/day counter never fired at all). Ratio, not enriched===0: a batch where
  // 40 of 50 fail is exactly this same failure, and enriched===0 alone would miss it -
  // "failed" is not automatically a bad PDF once it's a third of the batch.
  if (toEnrich.length > 0 && batchFailed / toEnrich.length > BATCH_FAILURE_ALERT_RATIO) {
    alert('poll_batch_failed', `${batchFailed} of ${toEnrich.length} grant(s) submitted `
      + `for enrichment failed - check Anthropic API status/credentials before assuming a content problem`);
  }
  return enriched;
}

export async function pollOnce() {
  if (running) { console.log('poll: already running, skipping this trigger'); return 0; }
  running = true;
  try { return await runPoll(); }
  finally { running = false; }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  pollOnce()
    .then(n => { console.log(`poll done, ${n} enriched`); process.exit(0); })
    .catch(e => { alert('poll', e.message); process.exit(1); });
}
