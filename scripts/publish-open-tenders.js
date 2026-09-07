// Publishes every enriched, still-open licitación (estado='licitacion') not already
// published. Same rule routes/operator.js's publish-batch endpoint enforces - see the
// comment there before touching this filter: it's the actual index-composition gate, not
// enrichment pacing. Historical estados (resuelta/adjudicada/anulada) and
// pendiente_adjudicacion stay unpublished on purpose, pending the Tuesday GSC thin-content
// check - see convoca-claude-cli-prod-risk memory.
//
//   node scripts/publish-open-tenders.js
import 'dotenv/config';
import { db } from '../src/db.js';
import { pingIndexNow } from '../src/indexnow.js';
import { BASE_URL, licitacionPath } from '../src/seoUtils.js';

const toPublish = db.prepare(`SELECT id, expediente, titulo FROM licitacion_row
  WHERE resumen IS NOT NULL AND estado = 'licitacion' AND published = 0`).all();
console.log(`publishing ${toPublish.length} open tender(s)`);
if (!toPublish.length) process.exit(0);

const mark = db.prepare('UPDATE licitacion_row SET published = 1 WHERE id = ?');
const run = db.transaction((rows) => rows.forEach(r => mark.run(r.id)));
run(toPublish);

await pingIndexNow(toPublish.map(r => BASE_URL + licitacionPath(r)));
console.log(`done: ${toPublish.length} published, IndexNow pinged`);
