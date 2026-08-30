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
import 'dotenv/config';
import { db } from '../src/db.js';
import { extractContext, enrichBatch } from '../src/ingest/enrichLicitacion.js';

const all = process.argv.includes('--all');
const rows = db.prepare(`SELECT * FROM licitacion_row ${all ? '' : 'WHERE resumen IS NULL'} ORDER BY created_at DESC`).all();
console.log(`re-enriching ${rows.length} licitación(es)${all ? ' (--all)' : ' missing resumen'}`);
if (!rows.length) process.exit(0);

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
console.log(`done: ${enriched} enriched, ${failed} failed`);
process.exit(failed && !enriched ? 1 : 0);
