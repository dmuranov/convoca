// Organism pages (/organismos/<slug>/): one page per body that calls grants or tenders -
// "Subvenciones y licitaciones del Ayuntamiento de Gijón".
//
// Why (2026-11-24): grant and tender pages live two to four weeks and then answer 410, so
// Google never builds trust in them, and people search by who gives the money ("subvenciones
// ayuntamiento de gijón", "licitaciones diputación de palencia"). An organism page stays: it
// lists what is open today and, when nothing is, the calls it already made, which tells a
// visitor what it usually funds and when.
//
// One page joins a body's BDNS grants (grant_row.granting_body, named by organismName) and
// its PLACSP tenders (licitacion_row.organo). Tenders are matched only for local bodies whose
// organ names the body itself ("Junta de Gobierno del Ayuntamiento de Marbella"); ministries,
// public companies and regional departments are grant-only for now.
import { db } from './db.js';
import { organismName, articleFor, realAmount } from './grantSeo.js';
import { slugify, PROVINCE_CCAA, CCAA_SLUGS, grantStillOpenSql, tenderStillOpenSql } from './seoUtils.js';
import { NATIONWIDE } from './ingest/regions.js';
import { grantsByBodies, dedupeGrants } from './seoQueries.js';

// Offered to search engines (index + sitemap) from this many grants and tenders, open or
// past; thinner pages still open for visitors, as noindex.
export const ORG_MIN_INDEX = Number(process.env.ORG_MIN_INDEX || 5);

// The URL key. The same body is "Diputación de Huesca" in BDNS and "Diputación Provincial de
// Huesca" in PLACSP: drop the qualifier so both land on one page.
export const orgKey = (name) => slugify(name)
  .replace(/^(diputacion|cabildo|consell)-(provincial|insular)-/, '$1-');

// "Junta de Gobierno del Ayuntamiento de Marbella" -> "Ayuntamiento de Marbella".
const LOCAL_ORGAN = /\b(Ayuntamiento|Concello|Ajuntament|Diputaci[óo]n Provincial|Diputaci[óo]n Foral|Diputaci[óo]n|Cabildo Insular|Cabildo|Consell Insular|Consell Comarcal|Comarca|Mancomunidad)\s+(d(?:e|el|')\s*.+?)[\s.]*$/i;
export function organFromTender(organo) {
  const m = LOCAL_ORGAN.exec(String(organo || ''));
  if (!m) return null;
  const kind = /^(concello|ajuntament)$/i.test(m[1]) ? 'Ayuntamiento' : m[1].charAt(0).toUpperCase() + m[1].slice(1);
  const name = `${kind} ${m[2]}`.replace(/\s+/g, ' ').trim();
  return name.length > 80 ? null : name;
}

const top = (counts) => [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
const bump = (m, k, n = 1) => { if (k) m.set(k, (m.get(k) || 0) + n); };

let cache = null;
// All organism pages that exist right now, rebuilt every 30 minutes (two GROUP BY queries).
// Returns { byKey, byBody, byOrgano }.
export function organisms() {
  if (cache && Date.now() - cache.at < 30 * 60_000) return cache;

  const grantRows = db.prepare(`SELECT granting_body b, region, province, COUNT(*) n,
      SUM(published = 1 AND status = 'OPEN' AND ${grantStillOpenSql('')}) open
    FROM grant_row WHERE plain_title IS NOT NULL AND granting_body IS NOT NULL GROUP BY 1, 2, 3`).all();

  // Per body first: its name, where it is, how many calls.
  const bodies = new Map();
  for (const r of grantRows) {
    let b = bodies.get(r.b);
    if (!b) {
      const on = organismName(r.b);
      if (!on) continue;
      b = { body: r.b, ...on, n: 0, open: 0, regions: new Map(), provinces: new Map() };
      bodies.set(r.b, b);
    }
    b.n += r.n; b.open += r.open || 0;
    bump(b.regions, r.region, r.n); bump(b.provinces, r.province, r.n);
  }

  // Then per page. Two towns with the same name in different provinces get the province in
  // their address instead of sharing one page.
  const byBaseKey = new Map();
  for (const b of bodies.values()) {
    b.region = top(b.regions); b.province = top(b.provinces);
    const k = orgKey(b.place ? `${b.name} ${b.place}` : b.name);
    (byBaseKey.get(k) || byBaseKey.set(k, []).get(k)).push(b);
  }
  const byKey = new Map(), byBody = new Map(), ambiguous = new Set();
  const newOrg = (key, name, de, place) => ({ key, name, de, place, bodies: [], organos: [], grants: 0, openGrants: 0,
    tenders: 0, openTenders: 0, regions: new Map(), provinces: new Map() });
  for (const [k, list] of byBaseKey) {
    const provs = new Set(list.map(b => b.province).filter(Boolean));
    const split = provs.size > 1;
    if (split) ambiguous.add(k);
    for (const b of list) {
      const key = split && b.province ? `${k}-${slugify(b.province)}` : k;
      let o = byKey.get(key);
      if (!o) byKey.set(key, o = newOrg(key, b.name, b.de, b.place));
      o.bodies.push(b.body); o.grants += b.n; o.openGrants += b.open;
      for (const [r, n] of b.regions) bump(o.regions, r, n);
      for (const [p, n] of b.provinces) bump(o.provinces, p, n);
      byBody.set(b.body, key);
    }
  }

  const tenderRows = db.prepare(`SELECT organo, lugar, COUNT(*) n,
      SUM(estado = 'licitacion' AND ${tenderStillOpenSql()}) open
    FROM licitacion_row WHERE published = 1 AND titulo IS NOT NULL AND organo IS NOT NULL GROUP BY 1, 2`).all();
  const byOrgano = new Map();
  for (const r of tenderRows) {
    const name = organFromTender(r.organo);
    if (!name) continue;
    let key = orgKey(name);
    if (ambiguous.has(key)) {
      if (!PROVINCE_CCAA.has(r.lugar)) continue;      // can't tell which town it is
      key = `${key}-${slugify(r.lugar)}`;
    }
    let o = byKey.get(key);
    if (!o) byKey.set(key, o = newOrg(key, name, articleFor(name), null));
    if (!o.organos.includes(r.organo)) o.organos.push(r.organo);
    o.tenders += r.n; o.openTenders += r.open || 0;
    if (PROVINCE_CCAA.has(r.lugar)) { bump(o.provinces, r.lugar, r.n); bump(o.regions, PROVINCE_CCAA.get(r.lugar), r.n); }
    else if (CCAA_SLUGS.has(slugify(r.lugar))) bump(o.regions, CCAA_SLUGS.get(slugify(r.lugar)), r.n);
    byOrgano.set(r.organo, key);
  }

  for (const o of byKey.values()) {
    o.region = top([...o.regions].filter(([r]) => r && r !== NATIONWIDE)) || (o.regions.has(NATIONWIDE) ? NATIONWIDE : null);
    o.province = top(o.provinces);
    o.total = o.grants + o.tenders;
    o.open = o.openGrants + o.openTenders;
    o.indexable = o.total >= ORG_MIN_INDEX;
    o.path = `/organismos/${o.key}/`;
    delete o.regions; delete o.provinces;
  }
  cache = { at: Date.now(), byKey, byBody, byOrgano };
  return cache;
}
export const resetOrganisms = () => { cache = null; };

// The organism page a grant or tender links to, when that page is worth sending people to.
export function organismFor({ granting_body, organo }) {
  const { byKey, byBody, byOrgano } = organisms();
  const key = granting_body ? byBody.get(granting_body) : byOrgano.get(organo);
  const o = key && byKey.get(key);
  return o && o.indexable ? o : null;
}

// Everything one organism page shows.
export function organismContent(o) {
  const ph = (xs) => xs.map(() => '?').join(',');
  const openGrants = grantsByBodies(o.bodies);
  const pastGrants = o.bodies.length ? dedupeGrants(db.prepare(`
    SELECT bdns_ref, title, plain_title, granting_body, open_date, deadline_date, created_at, budget_total, amount_max, category, is_rolling
    FROM grant_row g WHERE g.granting_body IN (${ph(o.bodies)}) AND g.plain_title IS NOT NULL
      AND NOT (g.published = 1 AND g.status = 'OPEN' AND ${grantStillOpenSql()})
    ORDER BY COALESCE(g.open_date, g.created_at) DESC LIMIT 60`).all(...o.bodies)) : [];
  const tenderCols = 'id, titulo, expediente, estado, fecha_limite, valor_estimado, presupuesto_base, tipo_contrato, created_at';
  const openTenders = o.organos.length ? db.prepare(`SELECT ${tenderCols} FROM licitacion_row
    WHERE published = 1 AND titulo IS NOT NULL AND estado = 'licitacion' AND ${tenderStillOpenSql()}
      AND organo IN (${ph(o.organos)}) ORDER BY fecha_limite IS NULL, fecha_limite LIMIT 100`).all(...o.organos) : [];
  const pastTenders = o.organos.length ? db.prepare(`SELECT ${tenderCols} FROM licitacion_row
    WHERE published = 1 AND titulo IS NOT NULL AND NOT (estado = 'licitacion' AND ${tenderStillOpenSql()})
      AND organo IN (${ph(o.organos)}) ORDER BY COALESCE(fecha_limite, created_at) DESC LIMIT 30`).all(...o.organos) : [];
  return { openGrants, pastGrants, openTenders, pastTenders };
}

// ---- the paragraph that opens the page: every figure from this body's own calls ----

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
export const monthYear = (d) => { const m = /^(\d{4})-(\d{2})/.exec(String(d || '')); return m ? `${MONTHS[Number(m[2]) - 1]} de ${m[1]}` : null; };
const eur = (n) => `${Math.round(n).toLocaleString('es-ES')} €`;
const list = (xs) => xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} y ${xs.at(-1)}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const ranked = (values, n = 3) => {
  const c = new Map(); for (const v of values) bump(c, v);
  return [...c].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), 'es')).slice(0, n);
};
// "del Ayuntamiento" -> "El Ayuntamiento", "de la Diputación" -> "La Diputación", "de X" -> "X".
export const subjectOf = (o) => ({ del: 'El ', 'de la': 'La ' }[o.de] || '') + o.name;
export const ofOrg = (o) => `${o.de} ${o.name}`;

export function organismIntro(o, { openGrants, pastGrants, openTenders, pastTenders }) {
  const S = subjectOf(o);
  const parts = [];
  const now = [
    openGrants.length ? plural(openGrants.length, 'convocatoria de subvenciones abierta', 'convocatorias de subvenciones abiertas') : '',
    openTenders.length ? plural(openTenders.length, 'licitación en plazo', 'licitaciones en plazo') : '',
  ].filter(Boolean);
  parts.push(now.length
    ? `${S} tiene ahora ${list(now)}.`
    : `${S} no tiene ahora ninguna convocatoria abierta. Abajo están las que ya ha publicado, que sirven para saber qué suele convocar y cuándo.`);

  const grants = [...openGrants, ...pastGrants];
  if (grants.length) {
    const since = grants.map(g => g.open_date || g.created_at).filter(Boolean).sort()[0];
    const cats = ranked(grants.map(g => g.category && String(g.category).toLowerCase()).filter(Boolean));
    parts.push(`${since ? `Desde ${monthYear(since)} hemos` : 'Hemos'} recogido ${plural(grants.length, 'convocatoria suya', 'convocatorias suyas')} en la Base de Datos Nacional de Subvenciones (BDNS)`
      + (cats.length > 1 ? `, sobre todo de ${list(cats.map(([c, n]) => `${c} (${n})`))}.` : cats.length ? `, de ${cats[0][0]}.` : '.'));
    const months = ranked(grants.map(g => (g.open_date || g.created_at || '').slice(5, 7)).filter(Boolean), 2).filter(([, n]) => n >= 2);
    if (grants.length >= 4 && months.length) {
      parts.push(`Las ha publicado sobre todo en ${list(months.map(([m, n]) => `${MONTHS[Number(m) - 1]} (${n})`))}.`);
    }
  }
  const budgets = openGrants.map(g => realAmount(g.budget_total)).filter(Boolean);
  if (budgets.length) parts.push(`Las subvenciones abiertas reparten en total ${eur(budgets.reduce((a, b) => a + b, 0))}.`);

  if (openTenders.length) {
    const value = openTenders.map(l => Number(l.valor_estimado || l.presupuesto_base) || 0).reduce((a, b) => a + b, 0);
    const kinds = ranked(openTenders.map(l => l.tipo_contrato && String(l.tipo_contrato).toLowerCase()).filter(Boolean), 2);
    parts.push(`${openTenders.length === 1 ? 'Su licitación abierta tiene' : 'Sus licitaciones abiertas suman'} ${value ? `${eur(value)} de valor estimado` : 'un importe que dan los pliegos'}`
      + (kinds.length ? `, de ${list(kinds.map(([k]) => k))}.` : '.'));
  }
  if (pastTenders.length) parts.push(`En los últimos meses ha sacado ${plural(pastTenders.length, 'licitación más que ya ha cerrado', 'licitaciones más que ya han cerrado')}.`);

  const fichas = [
    openGrants.length ? 'cada subvención tiene su ficha con la explicación en castellano llano, quién puede pedirla y el enlace a la convocatoria oficial' : '',
    openTenders.length ? 'cada licitación, un resumen de qué se contrata y qué piden a las empresas' : '',
  ].filter(Boolean);
  if (fichas.length) { const t = fichas.join('; '); parts.push(t.charAt(0).toUpperCase() + t.slice(1) + '.'); }
  const tenders = openTenders.length + pastTenders.length;
  parts.push(`La página se actualiza cada mañana con lo que ${grants.length && tenders ? 'publican la BDNS y la Plataforma de Contratación del Sector Público'
    : tenders ? 'publica la Plataforma de Contratación del Sector Público' : 'publica la BDNS'}.`);
  return parts.join(' ');
}
