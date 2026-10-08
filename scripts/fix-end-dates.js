// One-off: grants with no end date that BDNS does give in its textFin text ("Hasta el 31
// de diciembre de 2027", "07/05/2026"). Before 2026-10-08 the ingest only read the official
// fechaFinSolicitud field, so these rows had no deadline and stayed OPEN as long as BDNS's
// stale `abierto` flag said so. Sets the date and closes the ones already past.
//
//   node scripts/fix-end-dates.js --dry-run
//   node scripts/fix-end-dates.js
import 'dotenv/config';
import { db } from '../src/db.js';
import { bdnsGet } from '../src/ingest/bdns.js';
import { endDateFromDetail } from '../src/ingest/enrich.js';
import { pingIndexNow } from '../src/indexnow.js';
import { grantPath, BASE_URL } from '../src/seoUtils.js';

const DRY = process.argv.includes('--dry-run');
const today = new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const rows = db.prepare(`SELECT id, bdns_ref, status, published, plain_title, title FROM grant_row
  WHERE status IN ('OPEN','ANNOUNCED') AND deadline_date IS NULL AND skip_reason IS NULL`).all();
console.log(`${rows.length} open/announced grants without an end date`);

const setDate = db.prepare(`UPDATE grant_row SET deadline_date = ?, deadline_source = 'api', deadline_confirmed = 1,
  status = ?, closed_at = CASE WHEN ? = 'CLOSED' THEN ? ELSE closed_at END WHERE id = ?`);
let dated = 0, closed = 0, failed = 0;
const ping = [];
for (const r of rows) {
  try {
    const end = endDateFromDetail(await bdnsGet('/convocatorias', { numConv: r.bdns_ref }));
    if (end) {
      const status = end >= today ? (r.status === 'ANNOUNCED' && !r.published ? 'ANNOUNCED' : 'OPEN') : 'CLOSED';
      dated++; if (status === 'CLOSED') closed++;
      console.log(`  ${r.bdns_ref} ${end} ${r.status}->${status}${r.published ? ' (published)' : ''}`);
      if (!DRY) setDate.run(end, status, status, new Date().toISOString(), r.id);
      if (status === 'CLOSED' && r.published) ping.push(BASE_URL + grantPath(r));
    }
  } catch (e) { failed++; console.warn(`  ${r.bdns_ref}: ${e.message}`); }
  await sleep(250);
}
if (!DRY && ping.length) await pingIndexNow(ping);
console.log(`${DRY ? '[dry run] ' : ''}done: ${dated} given an end date, ${closed} of them already closed (${ping.length} were published), ${failed} failed`);
process.exit(0);
