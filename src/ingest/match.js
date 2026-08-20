// Rule-based grant -> entity match suggestions for the operator queue.
// Never auto-sends: writes notification rows only when the operator acts.
// A "suggestion" here is materialized as nothing — the operator console derives
// candidates live from grant_eligibility vs entity/municipality. This module
// exposes the shared query both the console and the poller log use.
import { db } from '../db.js';

export function candidateEntities(grantId) {
  const elig = db.prepare('SELECT * FROM grant_eligibility WHERE grant_id = ?').get(grantId);
  if (!elig) return [];
  const types = JSON.parse(elig.entity_types || '[]');
  const rows = db.prepare(`
    SELECT e.*, m.name AS municipality_name, m.population, m.ine_code
    FROM entity e JOIN municipality m ON m.id = e.municipality_id
    WHERE e.active = 1`).all();
  return rows.filter(e => {
    if (types.length && !types.includes(e.type)) return false;
    if (elig.pop_min != null && e.population != null && e.population < elig.pop_min) return false;
    if (elig.pop_max != null && e.population != null && e.population > elig.pop_max) return false;
    return true;
  });
}

export function suggestMatches(grantId) {
  const c = candidateEntities(grantId);
  if (c.length) console.log(`match: grant ${grantId} -> ${c.length} candidate entities`);
  return c;
}
