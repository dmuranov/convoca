// Email-alert digests. Daily subscribers get one at 08:00, weekly ones on Monday at 08:00
// (Europe/Madrid, scheduled in server.js).
//
// "New" means new on the site: an item is a candidate once it is published (published_at) after
// the subscription was confirmed, is still open, and has never been sent to that subscription
// (alert_sent). Matching runs here, at digest time, over everything published since - so there is
// no ingest hook to miss, and an item published mid-week still lands in Monday's digest.
// Nothing matched -> no email.
import { db } from '../db.js';
import { matcherFor } from './filters.js';
import { digestEmail, MAX_DIGEST_ITEMS } from './emails.js';
import { getMailer } from './mailer.js';

const GRANT_CANDIDATES = db.prepare(`
  SELECT 'grant' AS kind, g.id, g.bdns_ref, g.title, g.plain_title, g.granting_body, g.region, g.province,
         g.municipality, g.category, g.amount_max, g.budget_total, g.deadline_date, g.deadline_source,
         g.deadline_confirmed, g.is_rolling, g.beneficiarios_bdns, g.published_at, e.entity_types
  FROM grant_row g
  LEFT JOIN grant_eligibility e ON e.grant_id = g.id
  LEFT JOIN alert_sent s ON s.subscription_id = @sub AND s.item_kind = 'grant' AND s.item_id = g.id
  WHERE g.published = 1 AND g.status = 'OPEN' AND g.published_at >= @since
    AND (g.deadline_date IS NULL OR g.deadline_date >= @today OR g.is_rolling = 1)
    AND s.item_id IS NULL`);

const LICITACION_CANDIDATES = db.prepare(`
  SELECT 'licitacion' AS kind, l.id, l.expediente, l.titulo, l.organo, l.tipo_contrato, l.cpv, l.ccaa,
         l.presupuesto_base, l.fecha_limite, l.published_at
  FROM licitacion_row l
  LEFT JOIN alert_sent s ON s.subscription_id = @sub AND s.item_kind = 'licitacion' AND s.item_id = l.id
  WHERE l.published = 1 AND l.estado = 'licitacion' AND l.published_at >= @since
    AND (l.fecha_limite IS NULL OR l.fecha_limite >= @today)
    AND s.item_id IS NULL`);

const deadlineOf = (i) => (i.kind === 'licitacion' ? i.fecha_limite : i.deadline_date) || null;

// Closing soonest first; no deadline (rolling, unknown) last; then newest published first.
export function byClosingSoonest(a, b) {
  const da = deadlineOf(a), dbb = deadlineOf(b);
  if (da && dbb && da !== dbb) return da < dbb ? -1 : 1;
  if (da && !dbb) return -1;
  if (!da && dbb) return 1;
  return String(b.published_at || '').localeCompare(String(a.published_at || ''));
}

// The items one subscription would get right now (max MAX_DIGEST_ITEMS).
export function itemsFor(sub, today = new Date().toISOString().slice(0, 10)) {
  const filters = JSON.parse(sub.filters || '{}');
  const params = { sub: sub.id, since: sub.confirmed_at, today };
  const rows = sub.section === 'licitaciones' ? LICITACION_CANDIDATES.all(params) : GRANT_CANDIDATES.all(params);
  const match = matcherFor(sub.section);
  return rows.filter(r => match(r, filters)).sort(byClosingSoonest).slice(0, MAX_DIGEST_ITEMS);
}

const markSent = db.prepare(`INSERT OR IGNORE INTO alert_sent (subscription_id, item_kind, item_id) VALUES (?, ?, ?)`);
const touch = db.prepare(`UPDATE alert_subscription SET last_sent_at = datetime('now') WHERE id = ?`);
const recordSent = db.transaction((sub, items) => {
  for (const i of items) markSent.run(sub.id, i.kind, i.id);
  touch.run(sub.id);
});

// Send every digest due for `frequency` ('daily' | 'weekly'). One subscription failing never
// stops the rest; items are recorded as sent only after the provider accepted the message.
export async function runDigests(frequency, { mailer = getMailer(), today } = {}) {
  const subs = db.prepare(`SELECT * FROM alert_subscription WHERE status = 'confirmed' AND frequency = ?`).all(frequency);
  const stats = { frequency, subscriptions: subs.length, sent: 0, empty: 0, failed: 0, items: 0 };
  for (const sub of subs) {
    try {
      const items = itemsFor(sub, today);
      if (!items.length) { stats.empty++; continue; }
      const mail = digestEmail(sub, items);
      await mailer.send({ to: sub.email, ...mail });
      recordSent(sub, items);
      stats.sent++; stats.items += items.length;
    } catch (e) {
      stats.failed++;
      console.error(`alerts: digest for subscription ${sub.id} failed: ${e.message}`);
    }
  }
  console.log(`alerts: ${frequency} digests ${JSON.stringify(stats)}`);
  return stats;
}
