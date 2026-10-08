// One-off: fill grant_row.beneficiarios_bdns for grants ingested before the column existed.
// Only published, open grants (what the public pages show). BDNS detail API only — no LLM.
// Throttled like the daily poll; safe to re-run (skips rows already filled).
//
//   node scripts/backfill-beneficiarios.js
import 'dotenv/config';
import { db } from '../src/db.js';
import { bdnsGet } from '../src/ingest/bdns.js';

const THROTTLE_MS = Number(process.env.BDNS_THROTTLE_MS || 400);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const rows = db.prepare(`SELECT id, bdns_ref FROM grant_row
  WHERE published = 1 AND status = 'OPEN' AND beneficiarios_bdns IS NULL`).all();
console.log(`${rows.length} open published grants without beneficiary types`);
const upd = db.prepare('UPDATE grant_row SET beneficiarios_bdns = ? WHERE id = ?');
let done = 0, failed = 0;
for (const r of rows) {
  try {
    const detail = await bdnsGet('/convocatorias', { numConv: r.bdns_ref });
    upd.run(JSON.stringify((detail.tiposBeneficiarios || []).map(t => t.descripcion).filter(Boolean)), r.id);
    done++;
  } catch (e) {
    failed++;
    console.warn(`  ${r.bdns_ref}: ${e.message}`);
  }
  if ((done + failed) % 100 === 0) console.log(`  ${done + failed}/${rows.length}`);
  await sleep(THROTTLE_MS);
}
console.log(`done: ${done} filled, ${failed} failed`);
