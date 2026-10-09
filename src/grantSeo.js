// What a grant page tells Google: whether it should be indexed at all, and a title that says
// plainly what the page is.
//
// Why (search drop of 2026-10-03): pages ranked for searches they could not answer - "feria de
// la cebolla palenzuela 2026" landed on a page about a council subsidy to that fair, whose title
// read like the fair itself - and hundreds of indexed pages were direct awards or long-closed calls
// nobody could apply to. So: say it is a subsidy and who gives it, and keep out of the index what
// cannot help a searcher.
import { APPLICANT_LABELS } from './applicants.js';

const eur = (n) => `${Number(n).toLocaleString('es-ES')} €`;

// Days a closed call stays indexed after its deadline (people still search a call that just closed;
// the page says so with a banner).
export const CLOSED_INDEX_DAYS = 30;

// Index a grant page while it is open, and up to CLOSED_INDEX_DAYS after its deadline. A closed
// grant with no deadline is a direct award (nothing to apply to) or a call BDNS itself reports
// closed: never indexed. `today` is an ISO date.
export function isGrantIndexable(g, today = new Date().toISOString().slice(0, 10)) {
  if (g.status === 'OPEN') return true;
  if (!g.deadline_date) return false;
  const cutoff = new Date(Date.parse(today + 'T00:00:00Z') - CLOSED_INDEX_DAYS * 86400000).toISOString().slice(0, 10);
  return g.deadline_date >= cutoff;
}

// SQL twin of isGrantIndexable, for the sitemap (bind @cutoff = today - CLOSED_INDEX_DAYS).
export const INDEXABLE_SQL = `(status = 'OPEN' OR (deadline_date IS NOT NULL AND deadline_date >= @cutoff))`;
export const indexCutoff = (today = new Date().toISOString().slice(0, 10)) =>
  new Date(Date.parse(today + 'T00:00:00Z') - CLOSED_INDEX_DAYS * 86400000).toISOString().slice(0, 10);

const SMALL = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y', 'e', 'a', 'en', 'para', 'por', 'd', 'l']);
function titleCase(s) {
  return s.toLowerCase().split(/(\s+|-|\/)/).map((w, i) => {
    if (!w.trim() || w === '-' || w === '/') return w;
    if (i > 0 && SMALL.has(w)) return w;
    // d'Eivissa, l'Hospitalet
    const m = /^([dl])['’](.+)$/.exec(w);
    if (m) return `${m[1]}'${m[2].charAt(0).toUpperCase()}${m[2].slice(1)}`;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join('');
}
// INE style "Rozas de Madrid, Las" -> "Las Rozas de Madrid".
const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
const unInvert = (s) => s.replace(/^(.*?\b(?:de|del)\s+)(.+?),\s*(La|Las|El|Los|Les|Els|O|A|Os|As)$/i, (_, a, b, c) => `${a}${cap(c)} ${b}`)
  .replace(/^(.+?),\s*(La|Las|El|Los|Les|Els|O|A|Os|As)$/i, (_, a, c) => `${cap(c)} ${a}`);

// Departments of a comunidad are named after the comunidad: "Castilla y León", not
// "Consejería de Industria, Universidades, Empleo y Comercio".
const REGIONAL_DEPT = /^(CONSEJER|CONSELLER|CONSELLERIA|DEPARTAMENT|DIRECCI|INSTITUT|AGENCIA|SERVICIO|SERVEI|FONDO|SOCIEDAD|ENTIDAD|ORGANISMO|VICEPRESIDENCIA|PRESIDENCIA|SECRETAR|OFICINA|EMPRESA|CONSORCIO|ENTE)/i;

// "HUESCA — DIPUTACIÓN" style BDNS body -> { name: 'Diputación de Huesca', de: 'de la' }.
export function grantGiver(body) {
  const raw = String(body || '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const [first, second] = raw.split(/\s+—\s+/);
  let name;
  if (!second) name = first;
  else if (REGIONAL_DEPT.test(second)) name = first;
  else if (/^(DIPUTACI[OÓ]N|CABILDO|CONSELL|AYUNTAMIENTO|COMARCA)$/i.test(second)) name = `${second} de ${first}`;
  else name = second;
  // Local action groups: "ADRI PÁRAMOS Y VALLES - ASOCIACIÓN PARA EL DESARROLLO..." -> the short name.
  const [short, long] = name.split(/\s-\s/);
  if (long && /ASOCIACI|AGRUPACI|GRUPO|CENTRO|COLECTIVO/i.test(long)) name = short;
  name = unInvert(titleCase(name.replace(/,?\s*S\.?A\.?$/i, '').trim()));
  // After "Ayuntamiento de" comes a place, whose article is part of its name: "de Las Palmas".
  name = name.replace(/^((?:Ayuntamiento|Diputación(?: Provincial)?|Cabildo(?: Insular)?|Consell(?: Insular)?|Comarca) de) (la|las|el|los)\b/,
    (_, a, art) => `${a} ${cap(art)}`);
  if (name.length > 55) name = name.slice(0, 54).replace(/\s+\S*$/, '') + '…';
  const w = name.split(/\s/)[0].toLowerCase();
  const de = ['ayuntamiento', 'consell', 'cabildo', 'consorcio', 'instituto', 'servicio', 'fondo', 'ente', 'distrito', 'área', 'area', 'patronato', 'organismo', 'gobierno', 'departamento', 'grupo', 'centro', 'colegio', 'museo', 'consejo'].includes(w) ? 'del'
    : ['diputación', 'universidad', 'universitat', 'comarca', 'mancomunidad', 'junta', 'generalitat', 'fundación', 'asociación', 'agrupación', 'entidad', 'sociedad', 'agencia', 'cámara', 'confederación', 'federación'].includes(w) ? 'de la'
    : 'de';
  return { name, de };
}

// "Ayudas para la feria de la cebolla de Palenzuela 2026 — subvención de la Diputación Provincial
// de Palencia, hasta 6.000 € | Plazo Abierto". The year stays (most clicks came from queries with
// one); "subvención" / "convocatoria" and who gives it make clear what the page is.
export function grantSeoTitle(g) {
  const head = g.plain_title || g.title || 'Convocatoria';
  const year = (g.deadline_date || g.open_date || new Date().toISOString()).slice(0, 4);
  const withYear = /\b20\d\d\b/.test(head) ? head : `${head} ${year}`;
  const kind = /^(premio|premios|concurso|certamen|beca|becas)\b/i.test(head) ? 'convocatoria' : 'subvención';
  const giver = grantGiver(g.granting_body);
  const amount = g.amount_max ? `, hasta ${eur(g.amount_max)}` : '';
  return `${withYear} — ${kind}${giver ? ` ${giver.de} ${giver.name}` : ''}${amount} | Plazo Abierto`;
}

export function grantSeoDescription(g) {
  const head = g.plain_title || g.title || 'Convocatoria';
  const giver = grantGiver(g.granting_body);
  const kind = /^(premio|premios|concurso|certamen|beca|becas)\b/i.test(head) ? 'Convocatoria' : 'Subvención';
  const amount = g.amount_max ? `Hasta ${eur(g.amount_max)}.` : g.budget_total ? `${eur(g.budget_total)} en total.` : '';
  const when = g.status !== 'OPEN' ? 'Plazo cerrado.' : g.deadline_date ? `Plazo hasta el ${g.deadline_date}.` : '';
  return `${kind}${giver ? ` ${giver.de} ${giver.name}` : ''}: ${head}. ${amount} ${when} Quién puede pedirla y cómo, en castellano llano.`
    .replace(/\s+/g, ' ').trim();
}

// Who can apply, in plain words. The AI summary's entity list was built for village bodies
// (ayuntamientos, asociaciones, clubes, AMPAs...) and has no option for businesses, the
// self-employed or private people, so a LEADER grant for pymes read "Asociaciones". BDNS's own
// beneficiary types come first; the plain-language sentence from the bases next.
const BDNS_WHO = {
  'PYME Y PERSONAS FÍSICAS QUE DESARROLLAN ACTIVIDAD ECONÓMICA': 'Pymes y autónomos',
  'GRAN EMPRESA': 'Grandes empresas',
  'PERSONAS FÍSICAS QUE NO DESARROLLAN ACTIVIDAD ECONÓMICA': 'Particulares',
  'PERSONAS JURÍDICAS QUE NO DESARROLLAN ACTIVIDAD ECONÓMICA': 'Asociaciones, fundaciones y otras entidades sin actividad económica',
};
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

// Short label for the page's summary box. Categories from the full list (applicant_v = 2,
// src/applicants.js) are the most precise - "Estudiantes", "Agricultores y ganaderos"; then
// BDNS's own types; then the plain-language sentence; the old village-only list last.
export function whoCanApplyShort(g, entityLabels = {}) {
  const v2 = Number(g.applicant_v) === 2 ? parse(g.entity_types, []).filter(t => t !== 'Otro') : [];
  if (v2.length) return [...new Set(v2.map(t => APPLICANT_LABELS[t] || t))].join(' · ');
  const bdns = parse(g.beneficiarios_bdns, []).map(t => BDNS_WHO[t] || null).filter(Boolean);
  if (bdns.length) return [...new Set(bdns)].join(' · ');
  const sentence = parse(g.plain_explainer, null)?.quien_puede?.trim();
  if (sentence && !/^no se especifica/i.test(sentence)) return sentence.split(/(?<=\.)\s/)[0];
  const types = parse(g.entity_types, []).map(t => entityLabels[t] || t);
  return types.length ? types.join(', ') : null;
}

// Fuller text for the assistant: who can apply and what is excluded, from the bases.
export function eligibilityForChat(g) {
  const ex = parse(g.plain_explainer, null) || {};
  const short = whoCanApplyShort(g);
  const who = [short, ex.quien_puede && ex.quien_puede !== short ? ex.quien_puede : null].filter(Boolean).join(' — ');
  const notCovered = ex.que_no_cubre && !/^no se especifica/i.test(ex.que_no_cubre) ? ex.que_no_cubre : null;
  return { who: who || 'n/d', notCovered };
}
