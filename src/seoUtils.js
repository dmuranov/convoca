// Shared helpers between src/routes/seo.js (grant fichas) and src/routes/seoHubs.js
// (comunidad/provincia/sector/beneficiario hubs) - kept out of routes/ since this has no
// router of its own.
import { MUNICIPIOS } from './municipios.js';
import { CCAA } from './ingest/regions.js';

export const BASE_URL = process.env.BASE_URL || 'https://plazoabierto.es';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const eur = (n) => n == null ? null : Number(n).toLocaleString('es-ES') + ' €';

export const BENEFICIARIO_TYPES = { Ayuntamiento: 'Ayuntamientos', Junta_Vecinal: 'Juntas vecinales', Asociacion: 'Asociaciones', Club_Deportivo: 'Clubes deportivos', AMPA: 'AMPAs', Otro: 'Otras entidades' };

// bdns_ref is a plain BDNS numConv (always digits - see poll.js), so it survives in the
// URL untouched; the slug is cosmetic and never trusted for lookup (a stale/wrong slug in
// an old link or bookmark still resolves the right grant - see seo.js's route handler).
export function slugify(s) {
  return (s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'convocatoria';
}

export function grantPath(g) {
  return `/subvenciones/${slugify(g.plain_title || g.title)}-${g.bdns_ref}/`;
}

// licitacion_row has no bdns_ref-shaped clean identifier - PLACSP expedientes routinely
// contain slashes and spaces ("CMA 01/2026") that break a URL path segment, which is
// exactly why enrichBatch's custom_id already had to use the row's own uuid instead of the
// expediente (see enrichLicitacion.js). Reuse that same id here, for the same reason.
export function licitacionPath(l) {
  return `/licitaciones/${slugify(l.titulo || l.expediente)}-${l.id}/`;
}

// ---- hub taxonomies (fixed, not discovered from the DB - freeze the URL shape once) ----

export const CCAA_SLUGS = new Map(Object.values(CCAA).map(name => [slugify(name), name]));

export const PROVINCE_CCAA = new Map(MUNICIPIOS.map(m => [m.province, m.ccaa]).filter(([p]) => p));
export const PROVINCE_SLUGS = new Map([...PROVINCE_CCAA.keys()].map(name => [slugify(name), name]));

// The vocabulary the extraction prompt itself suggests (enrich.js's ELIGIBILITY_SCHEMA
// `category` description) - matched case-insensitively against grant_row.category, so a
// grant only links to a category hub whose taxonomy we actually recognise.
export const CATEGORIES = ['Cultura', 'Deporte', 'Empleo', 'Infraestructura', 'Medio ambiente', 'Social', 'Otros'];
export const CATEGORY_SLUGS = new Map(CATEGORIES.map(name => [slugify(name), name]));

export const BENEFICIARIO_SLUGS = new Map(
  Object.entries(BENEFICIARIO_TYPES).map(([enumVal, label]) => [slugify(label), { enumVal, label }])
);

// Calendar days until the deadline, by the date in Spain: 0 on the deadline day itself, 1 the
// day before. It used to round up the hours left until 23:59, so the last day read "quedan 1
// días" and "último día" never showed.
const MADRID_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' });
// Today's date in Spain, YYYY-MM-DD.
export const todayInSpain = (now = new Date()) => MADRID_DAY.format(now);

// Still open for applications today: no deadline given, a rolling call, or the deadline is
// today or later (in Spain). Every public list (the three tabs, hubs, related grants, the
// assistant's search) uses these: an item whose deadline has passed is never listed.
// The date is our own YYYY-MM-DD, so it is safe inline in the SQL.
export const grantStillOpenSql = (a = 'g.') =>
  `(${a}deadline_date IS NULL OR ${a}is_rolling = 1 OR substr(${a}deadline_date, 1, 10) >= '${todayInSpain()}')`;
export const tenderStillOpenSql = (a = '') =>
  `(${a}fecha_limite IS NULL OR substr(${a}fecha_limite, 1, 10) >= '${todayInSpain()}')`;
export function daysLeft(deadline, now = new Date()) {
  if (!deadline) return null;
  return Math.round((Date.parse(String(deadline).slice(0, 10)) - Date.parse(MADRID_DAY.format(now))) / 86400000);
}
// "plazo terminado" (deadline passed) / "último día" / "queda 1 día" / "quedan 12 días".
export const daysLabel = (d) => d < 0 ? 'plazo terminado' : d === 0 ? 'último día' : d === 1 ? 'queda 1 día' : `quedan ${d} días`;

// The "Avísame de nuevas convocatorias como esta" box (web/alertas.js fills it in; it stays
// empty and invisible while alerts are switched off). Filters are pre-filled from the page.
export function alertBox(section, filters = {}) {
  const f = Object.fromEntries(Object.entries(filters).filter(([, v]) => v != null && v !== ''));
  return `<div class="alerta-box" data-alerta data-section="${esc(section)}" data-filters="${esc(JSON.stringify(f))}" hidden></div>`;
}
export const ALERT_ASSETS = '<link rel="stylesheet" href="/alertas.css"><script src="/alertas.js" defer></script>';
