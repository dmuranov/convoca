// Live grant queries shared between src/routes/seoHubs.js (the hub pages themselves) and
// src/routes/sitemap.js (which must offer exactly the hubs that currently qualify - same
// functions, so the sitemap can never list a hub the route itself would 404).
import { db } from './db.js';
import { NATIONWIDE } from './ingest/regions.js';

// A hub with fewer live results than this is a doorway page, not a hub - 404 instead of
// serving (or indexing) a near-empty page. Applies to every tier per plan §10 step 4.
export const MIN_LIVE = Number(process.env.SEO_HUB_MIN_LIVE || 3);

const LIVE_BASE = `SELECT g.*, e.entity_types, e.territory_scope
  FROM grant_row g LEFT JOIN grant_eligibility e ON e.grant_id = g.id
  WHERE g.published = 1 AND g.status = 'OPEN'`;
const LIVE_ORDER = ` ORDER BY g.deadline_date IS NULL, g.deadline_date LIMIT 200`;

export function grantsByCcaa(ccaaName) {
  return db.prepare(`${LIVE_BASE} AND (g.region = ? OR g.region = ?)${LIVE_ORDER}`)
    .all(ccaaName, NATIONWIDE);
}
export function grantsByProvince(ccaaName, provinceName) {
  return db.prepare(`${LIVE_BASE} AND ((g.region = ? AND (g.province IS NULL OR g.province = ?)) OR g.region = ?)${LIVE_ORDER}`)
    .all(ccaaName, provinceName, NATIONWIDE);
}
export function grantsByCategory(categoryName) {
  return db.prepare(`${LIVE_BASE} AND LOWER(g.category) = LOWER(?)${LIVE_ORDER}`).all(categoryName);
}
export function grantsByBeneficiario(enumVal) {
  return db.prepare(`${LIVE_BASE} AND e.entity_types LIKE ?${LIVE_ORDER}`).all(`%"${enumVal}"%`);
}
export function grantsByBeneficiarioCcaa(enumVal, ccaaName) {
  return db.prepare(`${LIVE_BASE} AND e.entity_types LIKE ? AND (g.region = ? OR g.region = ?)${LIVE_ORDER}`)
    .all(`%"${enumVal}"%`, ccaaName, NATIONWIDE);
}
