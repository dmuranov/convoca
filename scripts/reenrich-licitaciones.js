// Recovery/backfill for licitacion_row rows whose deterministic fields are already
// durable (prepareEnrichment ran) but never got AI fields - either because a batch
// submission failed outright (the 2026-08-30 custom_id bug: real expedientes contain
// slashes/spaces, which the Batch API rejects wholesale, not per-request) or a batch
// timed out. Reconstructs the LLM context from stored columns rather than re-fetching
// pliegos PDFs - cheap and safe to re-run.
//
// One field is NOT recoverable this way: the feed's short "objeto" (title) text is only
// ever held in memory during prepareEnrichment and was never written to a column of its
// own (unlike grant_row.title). Its absence here just means the context's "Objeto" line
// reads "no consta" - raw_text (the pliegos PDF text) carries the real substance anyway,
// per src/ingest/enrichLicitacion.js's extractContext.
//
//   node scripts/reenrich-licitaciones.js            # rows missing resumen
//   node scripts/reenrich-licitaciones.js --all      # every row
//
// Chunked (CHUNK rows at a time, default 300): a full backlog run loading every row's
// raw_text (up to 150KB each) into memory at once OOM-killed the shared VM's 3.8GB
// (2026-09-07, ~6.6k-row backlog - see convoca-licitaciones-backlog memory) before a single
// Anthropic call was even made. Re-querying `WHERE resumen IS NULL` each iteration is what
// makes this safe to re-run after a crash/kill: already-enriched rows just drop out.
import 'dotenv/config';
import { db } from '../src/db.js';
import { extractContext, enrichBatch } from '../src/ingest/enrichLicitacion.js';

const all = process.argv.includes('--all');
const CHUNK = Number(process.env.REENRICH_CHUNK || 300);
const where = all ? '' : 'WHERE resumen IS NULL';
const total = db.prepare(`SELECT COUNT(*) c FROM licitacion_row ${where}`).get().c;
console.log(`re-enriching ${total} licitación(es)${all ? ' (--all)' : ' missing resumen'} in chunks of ${CHUNK}`);

// --all's WHERE-less query doesn't shrink as rows get enriched (unlike the default
// resumen-IS-NULL query, where already-done rows just drop out), so it needs an OFFSET or
// it would reprocess the same first CHUNK forever.
const select = db.prepare(`SELECT * FROM licitacion_row ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`);
let totalEnriched = 0, totalFailed = 0, done = 0;
for (;;) {
  const rows = select.all(CHUNK, all ? done : 0);
  if (!rows.length) break;
  const prepared = rows.map(r => ({
    id: r.id,
    expediente: r.expediente,
    context: extractContext({
      expediente: r.expediente, estado: r.estado, organo: r.organo,
      tipoContrato: r.tipo_contrato, procedimiento: r.procedimiento,
      cpv: JSON.parse(r.cpv || '[]'), presupuestoBase: r.presupuesto_base,
      valorEstimado: r.valor_estimado, iva: r.iva, fechaLimite: r.fecha_limite,
      lugar: r.lugar, duracion: r.duracion, numLotes: r.num_lotes,
      titulo: null, rawText: r.raw_text,
    }),
  }));
  const { enriched, failed } = await enrichBatch(prepared);
  totalEnriched += enriched; totalFailed += failed; done += rows.length;
  console.log(`chunk done: ${enriched} enriched, ${failed} failed (${done}/${total})`);
}
console.log(`total: ${totalEnriched} enriched, ${totalFailed} failed (of ${total})`);
process.exit(totalFailed && !totalEnriched ? 1 : 0);
