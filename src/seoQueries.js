// Live grant queries shared between src/routes/seoHubs.js (the hub pages themselves) and
// src/routes/sitemap.js (which must offer exactly the hubs that currently qualify - same
// functions, so the sitemap can never list a hub the route itself would 404).
import { db } from './db.js';
import { NATIONWIDE } from './ingest/regions.js';
import { isEnriched } from './grantSeo.js';
import { grantStillOpenSql, todayInSpain } from './seoUtils.js';

// A hub with fewer live results than this is a doorway page, not a hub - 404 instead of
// serving (or indexing) a near-empty page. Applies to every tier per plan §10 step 4.
export const MIN_LIVE = Number(process.env.SEO_HUB_MIN_LIVE || 3);
export const MIN_INDEX = Number(process.env.SEO_HUB_MIN_INDEX || 5);

// Open and with the deadline not yet passed (grantStillOpenSql, src/seoUtils.js). A function:
// the date in it changes at midnight.
const liveBase = () => `SELECT g.*, e.entity_types, e.territory_scope
  FROM grant_row g LEFT JOIN grant_eligibility e ON e.grant_id = g.id
  WHERE g.published = 1 AND g.status = 'OPEN' AND ${grantStillOpenSql()}`;
const LIVE_ORDER = ` ORDER BY g.deadline_date IS NULL, g.deadline_date LIMIT 200`;

// BDNS registers some calls twice - the extracto and the convocatoria, each with its own
// number - so the same municipal grant showed twice in a list. Same body, same closing date
// and the same title (official or plain) is one grant: keep the one with our explanation,
// then the lower BDNS number. The list keeps its order.
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/^(extracto|convocatoria|anuncio)\s+(de\s+)?(la\s+|el\s+|las\s+|los\s+)?(convocatoria\s+)?(de\s+)?/, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();
const better = (a, b) => (isEnriched(b) ? 1 : 0) - (isEnriched(a) ? 1 : 0) || Number(a.bdns_ref) - Number(b.bdns_ref);

export function dedupeGrants(grants) {
  const slotByKey = new Map();
  const out = [];
  for (const g of grants) {
    const base = `${norm(g.granting_body)}|${g.deadline_date || ''}|`;
    const keys = [...new Set([g.title, g.plain_title].map(norm).filter(Boolean))].map(t => base + t);
    const slot = keys.map(k => slotByKey.get(k)).find(i => i != null);
    if (slot == null) {
      out.push(g);
      for (const k of keys) slotByKey.set(k, out.length - 1);
    } else {
      if (better(g, out[slot]) < 0) out[slot] = g;
      for (const k of keys) if (!slotByKey.has(k)) slotByKey.set(k, slot);
    }
  }
  return out;
}

// Results are kept for a minute: one page, and above all the sitemap, asks for the same
// lists (the state-wide one for every hub) many times over.
const memo = new Map();
const live = (where, ...args) => {
  const key = todayInSpain() + '|' + where + '|' + args.join('|');
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.rows;
  const rows = dedupeGrants(db.prepare(`${liveBase()} AND ${where}${LIVE_ORDER}`).all(...args));
  memo.set(key, { at: Date.now(), rows });
  return rows;
};
export const resetLiveCache = () => memo.clear();

// A hub for a place lists everything that can be applied for from that place, the same rule
// as the place picker on the home page: its own calls, then the wider ones (the whole
// comunidad, the whole country). `own` is what only this hub has - shown first, as cards;
// `also` are the wider tiers, shown under it as short lists, because they are the same on
// every hub of the comunidad or the country and have their own hub with the full cards.
export const grantsByCcaa = (ccaaName) => live('g.region = ?', ccaaName);
export const grantsByProvince = (ccaaName, provinceName) => live('g.region = ? AND g.province = ?', ccaaName, provinceName);
export const grantsCcaaWide = (ccaaName) => live('g.region = ? AND g.province IS NULL', ccaaName);
export const grantsNationwide = () => live('g.region = ?', NATIONWIDE);
export const grantsByCategory = (categoryName) => live('LOWER(g.category) = LOWER(?)', categoryName);
export const grantsByBeneficiario = (enumVal) => live('e.entity_types LIKE ?', `%"${enumVal}"%`);
export const grantsByBeneficiarioCcaa = (enumVal, ccaaName) =>
  live('e.entity_types LIKE ? AND g.region = ?', `%"${enumVal}"%`, ccaaName);

// A hub exists when there are MIN_LIVE calls to show and at least one is its own: with none
// of its own it would be a copy of the hub above it.
//
// `indexable`: offered to search engines (index + sitemap) only with MIN_INDEX calls of its
// own. Thinner hubs still open for visitors, as noindex. Why (2026-11-24): Google had crawled
// ~1,000 pages and indexed 223, rejecting even full hubs; a 1-own + 2-estatales page is
// mostly a copy of the estatales hub and pulls down how Google rates the whole site.
const hub = (own, also) => {
  const tiers = also.filter(t => t.grants.length);
  const all = [...own, ...tiers.flatMap(t => t.grants)];
  return { own, also: tiers, all, ok: own.length >= 1 && all.length >= MIN_LIVE, indexable: own.length >= MIN_INDEX };
};
const simple = (own) => ({ own, also: [], all: own, ok: own.length >= MIN_LIVE, indexable: own.length >= MIN_INDEX });
const ESTATALES = { key: 'estatales', title: 'Estatales: también puedes pedirlas' };

export const ccaaHub = (ccaaName) => hub(grantsByCcaa(ccaaName), [{ ...ESTATALES, grants: grantsNationwide() }]);
export const provinceHub = (ccaaName, provinceName) => hub(grantsByProvince(ccaaName, provinceName), [
  { key: 'ccaa', title: `De toda ${ccaaName}: también puedes pedirlas`, grants: grantsCcaaWide(ccaaName) },
  { ...ESTATALES, grants: grantsNationwide() }]);
export const beneficiarioCcaaHub = (enumVal, ccaaName) => hub(grantsByBeneficiarioCcaa(enumVal, ccaaName),
  [{ ...ESTATALES, grants: live('e.entity_types LIKE ? AND g.region = ?', `%"${enumVal}"%`, NATIONWIDE) }]);
export const estatalesHub = () => simple(grantsNationwide());
export const categoryHub = (categoryName) => simple(grantsByCategory(categoryName));
export const beneficiarioHub = (enumVal) => simple(grantsByBeneficiario(enumVal));

// Open grants to offer on a closed grant's page: the same town first, then the same province,
// then the same subject, then the rest of the comunidad. Another town's own grants are left out (only
// its residents can apply). Only pages with our explanation, so every link is an indexed page.
export function relatedOpenGrants(g, limit = 6) {
  const rows = db.prepare(`
    SELECT g.*,
      (CASE WHEN @muni IS NOT NULL AND g.municipality = @muni AND g.province IS @prov THEN 8 ELSE 0 END
     + CASE WHEN @prov IS NOT NULL AND g.province = @prov THEN 4 ELSE 0 END
     + CASE WHEN @cat IS NOT NULL AND LOWER(g.category) = LOWER(@cat) THEN 2 ELSE 0 END
     + CASE WHEN g.region = @region THEN 1 ELSE 0 END) AS score
    FROM grant_row g
    WHERE g.published = 1 AND g.status = 'OPEN' AND ${grantStillOpenSql()} AND g.id != @id AND g.plain_explainer IS NOT NULL
      AND (g.region = @region OR (@cat IS NOT NULL AND LOWER(g.category) = LOWER(@cat) AND g.region = @nationwide))
      AND (g.municipality IS NULL OR (g.municipality = @muni AND g.province IS @prov))
    ORDER BY score DESC, g.deadline_date IS NULL, g.deadline_date
    LIMIT 40`).all({ id: g.id, muni: g.municipality || null, prov: g.province || null,
      cat: g.category || null, region: g.region || null, nationwide: NATIONWIDE });
  return dedupeGrants(rows.filter(isEnriched)).slice(0, limit);
}
