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
//   node scripts/reenrich-licitaciones.js --long     # already-enriched rows whose raw_text
//                                                     # exceeds 60000 chars - redoes anything
//                                                     # written before 2026-09-07's fix that
//                                                     # sliced the model's context to 60000
//                                                     # chars while raw_text ran up to 150000
//                                                     # (see enrichLicitacion.js's
//                                                     # extractContext for the full story)
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
const long = process.argv.includes('--long');
// --recovered: open licitaciones that already had a summary pass, then got their documents back
// (scripts/refetch-pliegos.js clears resumen on them) - not the never-enriched backlog.
const recovered = process.argv.includes('--recovered');
const CHUNK = Number(process.env.REENRICH_CHUNK || 300);
const where = all ? '' : long ? 'WHERE resumen IS NOT NULL AND LENGTH(raw_text) > 60000'
  : recovered ? "WHERE resumen IS NULL AND titulo IS NOT NULL AND LENGTH(raw_text) >= 200 AND estado IN ('licitacion','anuncio_previo') AND (fecha_limite IS NULL OR fecha_limite >= date('now'))"
  : 'WHERE resumen IS NULL';
const label = all ? ' (--all)' : long ? ' (--long, past the old 60000-char context cutoff)' : ' missing resumen';
const total = db.prepare(`SELECT COUNT(*) c FROM licitacion_row ${where}`).get().c;
console.log(`re-enriching ${total} licitación(es)${label} in chunks of ${CHUNK}`);

// --all and --long's WHERE doesn't shrink as rows get enriched (unlike the default
// resumen-IS-NULL query, where already-done rows just drop out), so both need an OFFSET or
// they'd reprocess the same first CHUNK forever. ORDER BY created_at alone isn't unique -
// rows written by the same poll/backfill run share a timestamp to the second - so OFFSET
// paging over it silently skipped 12/672 rows on the 2026-09-07 --long run (ties land on
// different sides of a page boundary depending on scan order, which isn't guaranteed
// stable across separate queries). id is the primary key and always unique, so it's a
// stable tiebreaker.
const paged = all || long;
const select = db.prepare(`SELECT * FROM licitacion_row ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`);
let totalEnriched = 0, totalFailed = 0, done = 0;
for (;;) {
  const rows = select.all(CHUNK, paged ? done : 0);
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
