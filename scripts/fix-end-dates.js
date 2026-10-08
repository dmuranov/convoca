// One-off repair: re-derive end date and status for open/announced grants that have no end
// date, with the same rule the ingest now uses (deadlineFor in src/ingest/enrich.js):
//   - literal end dates in BDNS's textFin ("Hasta el 31 de diciembre de 2027", "07/05/2026")
//   - relative periods it used to miss ("16º día hábil...", "20 dies naturals"), estimated
//   - the plazo sentence in the stored bases text when BDNS only says "según bases"
//   - direct awards (nothing to apply to) and "cerrado" wording -> CLOSED
// Before 2026-10-08 these rows had no deadline and stayed OPEN indefinitely.
//
// A published row is never downgraded to ANNOUNCED: the operator published it, and "no date,
// not flagged open" is not evidence that it closed. Rows only gain a date or become CLOSED.
//
//   node scripts/fix-end-dates.js --dry-run
//   node scripts/fix-end-dates.js
import 'dotenv/config';
import { db } from '../src/db.js';
import { bdnsGet } from '../src/ingest/bdns.js';
import { deadlineFor } from '../src/ingest/enrich.js';
import { pingIndexNow } from '../src/indexnow.js';
import { grantPath, BASE_URL } from '../src/seoUtils.js';

const DRY = process.argv.includes('--dry-run');
const today = new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const rows = db.prepare(`SELECT id, bdns_ref, status, published, plain_title, title, open_date, raw_text
  FROM grant_row WHERE status IN ('OPEN','ANNOUNCED') AND deadline_date IS NULL AND skip_reason IS NULL`).all();
console.log(`${rows.length} open/announced grants without an end date`);

const update = db.prepare(`UPDATE grant_row SET deadline_date = ?, deadline_source = ?, deadline_confirmed = ?,
  status = ?, closed_at = CASE WHEN ? = 'CLOSED' THEN ? ELSE closed_at END WHERE id = ?`);
const tally = {};
let failed = 0;
const ping = [];
for (const r of rows) {
  try {
    const detail = await bdnsGet('/convocatorias', { numConv: r.bdns_ref });
    const d = deadlineFor(detail, { openDate: r.open_date, basesText: r.raw_text, today });
    let status = d.status;
    if (status === 'ANNOUNCED' && r.status === 'OPEN') status = 'OPEN';   // see header
    const why = d.deadline ? `${d.deadline} (${d.source === 'api' ? 'firm' : 'estimated'})`
      : /directa/i.test(detail.tipoConvocatoria || '') && status === 'CLOSED' ? 'direct award'
      : status === 'CLOSED' ? 'BDNS says closed' : 'still no date';
    const key = `${status}: ${why.replace(/^\d{4}-\d\d-\d\d /, 'date ')}`;
    tally[key] = (tally[key] || 0) + 1;
    if (!d.deadline && status === r.status) continue;            // nothing learned
    console.log(`  ${r.bdns_ref} ${r.status}->${status} ${why}${r.published ? ' (published)' : ''}`);
    if (!DRY) update.run(d.deadline, d.deadline ? d.source : null, d.deadline ? d.confirmed : 0,
      status, status, new Date().toISOString(), r.id);
    if (status === 'CLOSED' && r.published) ping.push(BASE_URL + grantPath(r));
  } catch (e) { failed++; console.warn(`  ${r.bdns_ref}: ${e.message}`); }
  await sleep(250);
}
if (!DRY && ping.length) await pingIndexNow(ping);
console.log(`${DRY ? '[dry run] ' : ''}done: ${JSON.stringify(tally)}; ${ping.length} published grants closed; ${failed} failed`);
process.exit(0);
