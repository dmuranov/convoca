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
import { prepareEnrichment } from './enrich.js';
import { enqueueJobs } from './queue.js';

const LOOKBACK_DAYS = Number(process.env.POLL_LOOKBACK_DAYS || 7);
const PAGE_SIZE = 200;
const MAX_PAGES = Number(process.env.POLL_MAX_PAGES || 60);
// Politeness delay between BDNS detail calls; the API is known to block noisy clients.
const THROTTLE_MS = Number(process.env.POLL_THROTTLE_MS || 250);

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

// Grants aimed exclusively at for-profit activity are not what this site is for.
const BUSINESS_ONLY = 'PYME Y PERSONAS FÍSICAS QUE DESARROLLAN ACTIVIDAD ECONÓMICA';

// Decide whether a national row earns an LLM extraction. Returns null to enrich,
// or a short reason string to skip. Pilot rows bypass this entirely.
export function screen(detail, today = new Date().toISOString().slice(0, 10)) {
  const tipo = detail.tipoConvocatoria || '';
  if (!/concurrencia competitiva/i.test(tipo)) {
    return `no competitiva (${tipo || 'tipo desconocido'})`;
  }
  const benef = (detail.tiposBeneficiarios || []).map(t => t.descripcion || '');
  if (benef.length && benef.every(b => b === BUSINESS_ONLY)) {
    return 'solo actividad económica';
  }
  // Nobody can apply to a closed call, so never pay to extract one. Barely matters on the
  // daily poll; on a long backfill it is the difference between enriching everything BDNS
  // published in a year and enriching only what is still live.
  const fin = detail.fechaFinSolicitud?.slice(0, 10);
  if (fin && fin < today && !detail.abierto) return `plazo cerrado (${fin})`;
  return null;
}

export async function pollOnce() {
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

  const exists = db.prepare('SELECT 1 FROM grant_row WHERE bdns_ref = ?');
  // `region` is deliberately left for enrichment: the search row's nivel2 is the granting
  // body's name (a municipality, a mancomunidad), not a territory. See ingest/regions.js.
  const ins = db.prepare(`INSERT INTO grant_row
    (id, bdns_ref, title, granting_body, granting_level, open_date, status, source_url)
    VALUES (?, ?, ?, ?, ?, ?, 'ANNOUNCED', ?)`);

  const fresh = [];
  for (const [ref, row] of seen) {
    if (exists.get(ref)) continue;
    const id = uuid();
    ins.run(id, ref, row.descripcion || '(sin título)',
      [row.nivel2, row.nivel3].filter(Boolean).join(' — '),
      levelFromNivel1(row.nivel1), row.fechaRecepcion || null,
      `https://www.infosubvenciones.es/bdnstrans/GE/es/convocatoria/${ref}`);
    fresh.push({ id, ref, row });
  }
  console.log(`poll: ${seen.size} in ${LOOKBACK_DAYS}-day window`
    + `${regions.length ? ` (regions ${regions.join(',')})` : ' (Spain)'}, ${fresh.length} new`);
  // A quiet day (fresh=0, everything already known) is normal. Zero results from BDNS
  // itself over a full 7-day nationwide window never legitimately happens - it means the
  // search API broke silently (auth, schema change, empty response) with no exception to
  // catch. Timeouts (llm.js) stop a hung *enrichment* call; this catches a poll that
  // "succeeds" having done nothing.
  if (seen.size === 0) {
    alert('poll', `zero convocatorias returned from BDNS across the ${LOOKBACK_DAYS}-day window`
      + `${regions.length ? ` (regions ${regions.join(',')})` : ' (Spain)'} - check BDNS reachability`);
  }

  // Rows we skip stay in grant_row unpublished, so they are never reconsidered:
  // the dedupe above means each reference costs at most one detail call, ever.
  //
  // The BDNS detail + bases-PDF fetches below stay sequential and throttled (that API
  // blocks noisy clients); the LLM call does not — prepareEnrichment() only does the
  // deterministic work (deadline, territory, PDF text) and every screened-in grant is
  // queued as a Postgres job row instead, drained by convoca-worker.timer (systemd) one
  // at a time via claude-cli under subscription auth. See src/ingest/queue.js and
  // scripts/worker.js.
  const toEnrich = [];
  let skipped = 0, prepFailed = 0;
  for (const g of fresh) {
    try {
      const detail = await bdnsGet('/convocatorias', { numConv: g.ref });
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

  const { queued } = await enqueueJobs(toEnrich);
  console.log(`poll done: ${queued} queued for enrichment (convoca-worker drains via claude-cli), ${skipped} skipped (not applicable), ${prepFailed} prep failed`);
  return queued;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  pollOnce()
    .then(n => { console.log(`poll done, ${n} queued`); process.exit(0); })
    .catch(e => { alert('poll', e.message); process.exit(1); });
}
