// Email-alert filters: what a subscription can ask for, per section, and whether an item
// matches. Pure functions (no DB), so the matching rules are unit-tested on their own.
//
// A visitor never types a filter: the page they sign up on pre-fills them (a grant's comunidad
// and category, a tender's comunidad, contract type and CPV division) and they can only remove
// chips. So every filter is an exact value the site itself produced, never free text.
import { BENEFICIARIO_TYPES } from '../seoUtils.js';
import { isBusinessGrant, isLeaderGrant } from '../negocios.js';

export const SECTIONS = ['subvenciones', 'licitaciones', 'negocios'];
export const NATIONWIDE = 'Toda España';   // mirrors src/ingest/regions.js

export const FILTER_KEYS = {
  subvenciones: ['ccaa', 'province', 'municipality', 'category', 'beneficiario'],
  negocios: ['ccaa', 'province', 'municipality', 'category', 'leader'],
  licitaciones: ['ccaa', 'tipo_contrato', 'cpv', 'organo'],
};

const fold = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

// Keep only the keys this section knows, in a fixed shape. Anything unexpected is dropped,
// never stored. Returns a plain object.
export function cleanFilters(section, raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || !FILTER_KEYS[section]) return out;
  for (const key of FILTER_KEYS[section]) {
    const v = raw[key];
    if (v == null || v === '' || v === false) continue;
    if (key === 'leader') { if (v === true || v === 'true' || v === 1) out.leader = true; continue; }
    if (key === 'cpv') { const c = String(v).replace(/\D/g, '').slice(0, 2); if (c.length === 2) out.cpv = c; continue; }
    if (key === 'beneficiario') { if (Object.hasOwn(BENEFICIARIO_TYPES, v)) out.beneficiario = v; continue; }
    if (key === 'ccaa' && v === NATIONWIDE) continue;   // "toda España" is no filter at all
    const s = String(v).trim().slice(0, 120);
    if (s) out[key] = s;
  }
  // A municipality or province only means something inside its comunidad.
  if ((out.province || out.municipality) && !out.ccaa) { delete out.province; delete out.municipality; }
  return out;
}

// Stable JSON (sorted keys) so the same filters always compare equal.
export const canonicalFilters = (f) =>
  JSON.stringify(Object.fromEntries(Object.entries(f || {}).sort(([a], [b]) => a.localeCompare(b))));

// Same four-tier place rule as the listing page (web/index.html render()): nationwide money,
// the comunidad's, the province's, and the town's own. A call from another province - or
// another town's ayuntamiento - is out.
function placeMatches(item, f) {
  if (!f.ccaa) return true;
  if (item.region === NATIONWIDE) return true;
  if (item.region !== f.ccaa) return false;
  if (f.province && item.province && item.province !== f.province) return false;
  if (item.municipality) return !!f.municipality && item.municipality === f.municipality;
  return true;
}

// item: a grant_row joined with grant_eligibility.entity_types.
export function grantMatches(item, f = {}) {
  if (!placeMatches(item, f)) return false;
  if (f.category && fold(item.category || 'otros') !== fold(f.category)) return false;
  if (f.beneficiario) {
    let types = [];
    try { types = JSON.parse(item.entity_types || '[]'); } catch { /* none */ }
    if (!types.includes(f.beneficiario)) return false;
  }
  return true;
}

export function negocioMatches(item, f = {}) {
  if (!isBusinessGrant(item)) return false;
  if (f.leader && !isLeaderGrant(item)) return false;
  return grantMatches(item, { ...f, beneficiario: undefined });
}

// item: a licitacion_row.
export function licitacionMatches(item, f = {}) {
  if (f.ccaa && item.ccaa !== f.ccaa) return false;
  if (f.tipo_contrato && fold(item.tipo_contrato) !== fold(f.tipo_contrato)) return false;
  if (f.organo && fold(item.organo) !== fold(f.organo)) return false;
  if (f.cpv) {
    let codes = [];
    try { codes = JSON.parse(item.cpv || '[]'); } catch { /* none */ }
    if (!codes.some(c => String(c).startsWith(f.cpv))) return false;
  }
  return true;
}

export const matcherFor = (section) =>
  section === 'licitaciones' ? licitacionMatches : section === 'negocios' ? negocioMatches : grantMatches;

// Chip / email wording for one filter, in plain Spanish.
export function filterLabel(key, value) {
  switch (key) {
    case 'ccaa': return value;
    case 'province': return `Provincia de ${value}`;
    case 'municipality': return value;
    case 'category': return value.charAt(0).toUpperCase() + value.slice(1);
    case 'beneficiario': return `Para ${(BENEFICIARIO_TYPES[value] || value).toLowerCase()}`;
    case 'leader': return 'Solo LEADER';
    case 'tipo_contrato': return value;
    case 'cpv': return `Sector CPV ${value}`;
    case 'organo': return value;
    default: return String(value);
  }
}

export const SECTION_LABEL = { subvenciones: 'Subvenciones', licitaciones: 'Licitaciones', negocios: 'Ayudas para negocios' };

export function describeSubscription(section, filters) {
  // In the natural order (place, then topic), not the stored alphabetical one.
  const f = filters || {};
  const parts = (FILTER_KEYS[section] || Object.keys(f)).filter(k => f[k] != null).map(k => filterLabel(k, f[k]));
  return `${SECTION_LABEL[section] || section}${parts.length ? ': ' + parts.join(' · ') : ' en toda España'}`;
}
