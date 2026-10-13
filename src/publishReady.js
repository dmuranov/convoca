// Publishes everything that is ready, with no operator step. Grants: summarised, open (or
// announced), not skipped, deadline not passed. Tenders: summarised, still open for bids
// (estado 'licitacion'), deadline not passed. Same rules as the operator's bulk publish
// (routes/operator.js publish-batch) and scripts/publish-ready-grants.js /
// publish-open-tenders.js.
//
// Why automatic: publishing was a manual step, so from 2026-10-09 new grants and tenders were
// summarised but never reached the site. The site is only worth anything if it has all of them.
import { db } from './db.js';
import { pingIndexNow } from './indexnow.js';
import { BASE_URL, grantPath, licitacionPath } from './seoUtils.js';

const today = () => new Date().toISOString().slice(0, 10);
const ping = (urls) => { if (urls.length) Promise.resolve(pingIndexNow(urls)).catch(() => {}); };

export function publishReadyGrants() {
  const ready = db.prepare(`SELECT id, bdns_ref, title, plain_title FROM grant_row
    WHERE published = 0 AND skip_reason IS NULL AND ai_summary IS NOT NULL
      AND status IN ('OPEN','ANNOUNCED') AND (deadline_date IS NULL OR deadline_date >= ?)`).all(today());
  if (!ready.length) return 0;
  const publish = db.prepare(`UPDATE grant_row
      SET published = 1,
          published_at = CASE WHEN published = 0 AND published_at IS NULL THEN datetime('now') ELSE published_at END,
          status = CASE WHEN status = 'ANNOUNCED' THEN 'OPEN' ELSE status END
    WHERE id = ? AND published = 0`);
  const n = db.transaction((rows) => rows.reduce((k, r) => k + publish.run(r.id).changes, 0))(ready);
  ping(ready.map(g => BASE_URL + grantPath(g)));
  console.log(`[publish] ${n} grant(s) published`);
  return n;
}

export function publishOpenTenders() {
  const ready = db.prepare(`SELECT id, expediente, titulo FROM licitacion_row
    WHERE published = 0 AND resumen IS NOT NULL AND estado = 'licitacion'
      AND (fecha_limite IS NULL OR substr(fecha_limite, 1, 10) >= ?)`).all(today());
  if (!ready.length) return 0;
  const mark = db.prepare(`UPDATE licitacion_row SET published = 1,
      published_at = CASE WHEN published = 0 AND published_at IS NULL THEN datetime('now') ELSE published_at END
    WHERE id = ? AND published = 0`);
  const n = db.transaction((rows) => rows.reduce((k, r) => k + mark.run(r.id).changes, 0))(ready);
  ping(ready.map(r => BASE_URL + licitacionPath(r)));
  console.log(`[publish] ${n} tender(s) published`);
  return n;
}
