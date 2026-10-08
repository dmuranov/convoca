// Publish every grant that is ready: summarised, open (or announced), not skipped, not past its
// deadline, not yet public. Same rules as the operator's bulk publish (routes/operator.js
// publish-batch): ANNOUNCED becomes OPEN, published_at is stamped the first time, and the new
// pages are pinged to IndexNow.
//
//   node scripts/publish-ready-grants.js --dry-run
//   node scripts/publish-ready-grants.js
import 'dotenv/config';
import { db } from '../src/db.js';
import { pingIndexNow } from '../src/indexnow.js';
import { grantPath, BASE_URL } from '../src/seoUtils.js';

const DRY = process.argv.includes('--dry-run');
const today = new Date().toISOString().slice(0, 10);

const ready = db.prepare(`SELECT id, bdns_ref, title, plain_title FROM grant_row
  WHERE published = 0 AND skip_reason IS NULL AND ai_summary IS NOT NULL
    AND status IN ('OPEN','ANNOUNCED') AND (deadline_date IS NULL OR deadline_date >= ?)`).all(today);
console.log(`${ready.length} grant(s) ready to publish`);
if (DRY || !ready.length) process.exit(0);

const publish = db.prepare(`UPDATE grant_row
    SET published = 1,
        published_at = CASE WHEN published = 0 AND published_at IS NULL THEN datetime('now') ELSE published_at END,
        status = CASE WHEN status = 'ANNOUNCED' THEN 'OPEN' ELSE status END
  WHERE id = ? AND published = 0`);
const n = db.transaction((rows) => rows.reduce((k, r) => k + publish.run(r.id).changes, 0))(ready);
console.log(`published ${n}`);
await pingIndexNow(ready.map(g => BASE_URL + grantPath(g)));
console.log(`IndexNow pinged ${ready.length}`);
process.exit(0);
