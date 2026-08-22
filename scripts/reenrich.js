// Re-run the enrichment chain over grants already in the DB.
// Used when the extraction schema changes (new plain_title / plain_explainer fields)
// and existing rows need backfilling. Safe to re-run: enrichGrant only overwrites
// what it can re-derive, and deadlines still go through the deterministic engine.
//
//   node scripts/reenrich.js            # only rows missing the plain-language fields
//   node scripts/reenrich.js --all      # every row
import 'dotenv/config';
import { db } from '../src/db.js';
import { enrichGrant } from '../src/ingest/enrich.js';
import { alert } from '../src/ingest/bdns.js';

const all = process.argv.includes('--all');
const rows = db.prepare(`SELECT id, bdns_ref FROM grant_row
  ${all ? '' : 'WHERE plain_title IS NULL OR plain_explainer IS NULL'}
  ORDER BY created_at DESC`).all();

console.log(`re-enriching ${rows.length} convocatoria(s)${all ? ' (--all)' : ' missing plain-language fields'}`);

let ok = 0, failed = 0;
for (const g of rows) {
  try {
    await enrichGrant(g.id, g.bdns_ref);
    ok++;
  } catch (e) {
    failed++;
    alert('reenrich', `convocatoria ${g.bdns_ref}: ${e.message}`);
  }
  await new Promise(r => setTimeout(r, 500));   // be gentle with BDNS
}
console.log(`done: ${ok} ok, ${failed} failed`);
process.exit(failed && !ok ? 1 : 0);
