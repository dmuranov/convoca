// Recovery: open licitaciones that ended up with no pliego text (PLACSP's WAF refused the
// downloads, or a huge project file timed out) get their documents fetched again with the
// current rules (retries with waits, core documents first - src/ingest/enrichLicitacion.js).
// Rows that now have text and are not yet published get resumen cleared, so the existing
//   node scripts/reenrich-licitaciones.js
// rebuilds their summaries from the new text. Published rows are left for the operator.
//
//   node scripts/refetch-pliegos.js --dry-run
//   node scripts/refetch-pliegos.js
import 'dotenv/config';
import { db } from '../src/db.js';
import { fetchPliegosText } from '../src/ingest/enrichLicitacion.js';

const DRY = process.argv.includes('--dry-run');
const rows = db.prepare(`SELECT id, expediente, pliegos, published FROM licitacion_row
  WHERE estado IN ('licitacion','anuncio_previo') AND pliegos != '[]'
    AND (raw_text IS NULL OR LENGTH(raw_text) < 200)
    AND (fecha_limite IS NULL OR fecha_limite >= date('now'))
  ORDER BY fecha_limite IS NULL, fecha_limite`).all();
console.log(`${rows.length} open licitación(es) without document text`);
if (DRY) process.exit(0);

const save = db.prepare(`UPDATE licitacion_row SET raw_text = ?,
  resumen = CASE WHEN published = 0 THEN NULL ELSE resumen END WHERE id = ?`);
let recovered = 0, still = 0;
for (const r of rows) {
  let pliegos = [];
  try { pliegos = JSON.parse(r.pliegos); } catch { /* none */ }
  const text = await fetchPliegosText(pliegos, r.expediente);
  if (text && text.length >= 200) { save.run(text, r.id); recovered++; }
  else still++;
  if ((recovered + still) % 10 === 0) console.log(`  ${recovered + still}/${rows.length} (recovered ${recovered})`);
}
console.log(`done: ${recovered} recovered, ${still} still without text`);
if (recovered) console.log('next: node scripts/reenrich-licitaciones.js  (rebuilds their summaries)');
process.exit(0);
