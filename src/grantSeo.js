// What a grant page tells Google: whether it should be indexed at all, and a title that says
// plainly what the page is.
//
// Why (search drop of 2026-10-03): pages ranked for searches they could not answer - "feria de
// la cebolla palenzuela 2026" landed on a page about a council subsidy to that fair, whose title
// read like the fair itself - and hundreds of indexed pages were direct awards or long-closed calls
// nobody could apply to. So: say it is a subsidy and who gives it, and keep out of the index what
// cannot help a searcher.
import { APPLICANT_LABELS } from './applicants.js';
import { todayInSpain } from './seoUtils.js';

const eur = (n) => `${Number(n).toLocaleString('es-ES')} €`;

// Has our plain-language explanation ("castellano llano"). A record without it is the raw BDNS
// data and nothing of ours: its page is served but kept out of the index and the sitemap.
export function isEnriched(g) {
  if (!g.plain_explainer) return false;
  try {
    const ex = JSON.parse(g.plain_explainer);
    return !!ex && typeof ex === 'object' && Object.values(ex).some(v => typeof v === 'string' && v.trim());
  } catch { return false; }
}

// A grant is on the site only while someone can still apply: not closed, and no deadline, a
// rolling call, or the deadline today or later (in Spain) - the same rule as every list
// (grantStillOpenSql, src/seoUtils.js). From the day after the deadline its page answers
// 410 Gone, so search engines drop it, and it is in no list and no sitemap. The row stays in
// the database: deleting it would make the daily poll take the call for a new one and enrich
// it again.
export const isGrantLive = (g, today = todayInSpain()) => g.status !== 'CLOSED'
  && (!g.deadline_date || !!g.is_rolling || String(g.deadline_date).slice(0, 10) >= today);
// Indexed and in the sitemap: shown, and with our explanation.
export const isGrantIndexable = (g, today) => isGrantLive(g, today) && isEnriched(g);

// BDNS writes 0.01 where a call has no money (honorary prizes): never a real amount.
export const realAmount = (n) => (Number(n) > 0.01 ? Number(n) : null);
export const isHonorary = (g) => !realAmount(g.amount_max) && !realAmount(g.budget_total)
  && [g.amount_max, g.budget_total].some(n => n != null && Number(n) > 0 && Number(n) <= 0.01);
export const HONORARY_LABEL = 'Premio honorífico / sin dotación económica';
// "hasta 6.000 €" / "bolsa de 40.000 €" / the honorary label / "según bases".
export function amountLabel(g) {
  if (realAmount(g.amount_max)) return `hasta ${eur(g.amount_max)}`;
  if (realAmount(g.budget_total)) return `bolsa de ${eur(g.budget_total)}`;
  return isHonorary(g) ? HONORARY_LABEL : 'según bases';
}

// One line for a card in a list (hub pages): the first sentence of the summary, cut at a word
// to 140 characters. The full explanation is only on the grant's own page, so a hub does not
// repeat the text of every page it links to.
export const HOOK_MAX = 140;
export function cardHook(g) {
  const text = String(g.ai_summary || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  // First sentence; at least 40 characters, so "Art. 5 ..." is not taken for one.
  const first = (/^.{39,}?[.!?](?=\s|$)/.exec(text)?.[0] || text).trim();
  if (first.length <= HOOK_MAX) return first;
  return first.slice(0, HOOK_MAX - 1).replace(/\s+\S*$/, '').replace(/[,;:]$/, '') + '…';
}

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
  return { name, de: articleFor(name) };
}

// "del Ayuntamiento", "de la Diputación", "de Cáritas": the article before a body's name.
export function articleFor(name) {
  const w = String(name || '').split(/\s/)[0].toLowerCase();
  return ['ayuntamiento', 'consell', 'cabildo', 'consorcio', 'instituto', 'servicio', 'fondo', 'ente', 'distrito', 'área', 'area', 'patronato', 'organismo', 'gobierno', 'departamento', 'departament', 'grupo', 'centro', 'colegio', 'museo', 'consejo', 'ministerio'].includes(w) ? 'del'
    : ['diputación', 'universidad', 'universitat', 'comarca', 'mancomunidad', 'junta', 'generalitat', 'fundación', 'asociación', 'agrupación', 'entidad', 'sociedad', 'agencia', 'cámara', 'confederación', 'federación',
       'consejería', 'conselleria', 'consellería', 'dirección', 'secretaría', 'presidencia', 'vicepresidencia', 'viceconsejería', 'oficina', 'empresa', 'corporación', 'autoridad', 'delegación'].includes(w) ? 'de la'
    : 'de';
}

// The body an organism page (src/routes/organismos.js) is about. Same as grantGiver, except a
// comunidad's department keeps its own name ("Consejería de Cultura y Deporte", place
// "Andalucía") instead of becoming the comunidad: a page per consejería, not one per region,
// which the region hub already is.
export function organismName(body) {
  const raw = String(body || '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  if (!raw) return null;
  const [first, second] = raw.split(/\s+—\s+/);
  if (second && REGIONAL_DEPT.test(second)) {
    let name = titleCase(second.replace(/,?\s*S\.?A\.?$/i, '').trim());
    if (name.length > 70) name = name.slice(0, 69).replace(/\s+\S*$/, '') + '…';
    return { name, de: articleFor(name), place: unInvert(titleCase(first)) };
  }
  const g = grantGiver(body);
  return g && { ...g, place: null };
}

// The programme's own name, when people would search for it. "AYUDAS A LA EMANCIPACIÓN JOVEN
// 2026" is what Zaragoza calls it and what people type; the plain title ("Ayudas para jóvenes que
// quieren independizarse...") never says "emancipación", so the page ranked 77th for "ayuda
// emancipacion zaragoza". Used only when the official title is short, is not a legal heading
// ("CONVOCATORIA DE...", "Resolución de..."), and has a word the plain title lacks.
const LEGAL_START = /^(convocatoria|convocat[oò]ria|bases|extracto|resoluci|orden|decreto|acuerdo|convenio|anuncio|aprobaci|el objeto|subvenciones en r[eé]gimen|programa de subvenciones|l[ií]nea de)/i;
const LEGAL_ANY = /(por (la|el) que|por las que|concurrencia|r[eé]gimen de|de fecha|n[ºo°]\s*\d|bases reguladoras)/i;
const NAME_STOP = new Set(['ayuda', 'ayudas', 'subvencion', 'subvenciones', 'para', 'curso', 'academico', 'ejercicio', 'anualidad', 'convocatoria', 'programa', 'destinadas', 'dirigidas', 'personas', 'entidades', 'municipio', 'municipal']);
const ACRONYMS = new Set(['LEADER', 'UNED', 'GALP', 'GAL', 'PEPAC', 'FEDER', 'FSE', 'PYME', 'PYMES', 'TIC', 'IES', 'CEIP', 'AMPA', 'AMPAS', 'ONG', 'ONGD', 'I+D', 'I+D+I', 'UE', 'DANA', 'ERASMUS', 'COVID', 'IRPF']);
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function officialName(g) {
  const t = String(g.title || '').replace(/\s+/g, ' ').trim().replace(/[.;,]+$/, '');
  if (!t || !g.plain_title || t.length > 75 || LEGAL_START.test(t) || LEGAL_ANY.test(t)) return null;
  // Distinctive words: in the official name, missing from the plain title (5-letter stems, so
  // "joven" matches "jóvenes").
  const plain = fold(g.plain_title).split(/[^a-z0-9]+/).map(w => w.slice(0, 5));
  const fresh = fold(t).split(/[^a-z0-9]+/).filter(w => w.length >= 5 && !NAME_STOP.has(w) && !/^\d+$/.test(w))
    .filter(w => !plain.includes(w.slice(0, 5)));
  if (!fresh.length) return null;
  // ALL-CAPS official titles read as shouting: sentence case, acronyms kept.
  const letters = t.replace(/[^A-Za-zÀ-ÿ]/g, '');
  const name = letters && letters === letters.toUpperCase()
    ? t.split(' ').map(w => ACRONYMS.has(w.replace(/[^A-Z+ÁÉÍÓÚÑ]/g, '')) ? w : w.toLowerCase()).join(' ')
    : t;
  // Roman numerals stay numerals ("XVIII certamen", not "Xviii certamen").
  const fixed = name.replace(/\b[ivxlc]{2,}\b/gi, (r) => /^(?=[mdclxvi])m*(c[md]|d?c{0,3})(x[cl]|l?x{0,3})(i[xv]|v?i{0,3})$/i.test(r) ? r.toUpperCase() : r);
  return fixed.charAt(0).toUpperCase() + fixed.slice(1);
}

// "Ayudas para la feria de la cebolla de Palenzuela 2026 — subvención de la Diputación Provincial
// de Palencia, hasta 6.000 € | Plazo Abierto". The year stays (most clicks came from queries with
// one); "subvención" / "convocatoria" and who gives it make clear what the page is.
// With a programme name the title leads with it and the plain title follows: "Ayudas a la
// emancipación joven 2026 — Ayudas para jóvenes que quieren independizarse en alquiler en
// Zaragoza | Plazo Abierto". The page's own heading stays the plain title.
export function grantSeoTitle(g) {
  const year = (g.deadline_date || g.open_date || new Date().toISOString()).slice(0, 4);
  const addYear = (s) => /\b20\d\d\b/.test(s) ? s : `${s} ${year}`;
  const name = officialName(g);
  if (name) return `${addYear(name)} — ${g.plain_title} | Plazo Abierto`;
  const head = g.plain_title || g.title || 'Convocatoria';
  const withYear = addYear(head);
  const kind = /^(premio|premios|concurso|certamen|beca|becas)\b/i.test(head) ? 'convocatoria' : 'subvención';
  const giver = grantGiver(g.granting_body);
  const amount = realAmount(g.amount_max) ? `, hasta ${eur(g.amount_max)}` : '';
  return `${withYear} — ${kind}${giver ? ` ${giver.de} ${giver.name}` : ''}${amount} | Plazo Abierto`;
}

export function grantSeoDescription(g) {
  const head = g.plain_title || g.title || 'Convocatoria';
  const name = officialName(g);
  const giver = grantGiver(g.granting_body);
  const kind = /^(premio|premios|concurso|certamen|beca|becas)\b/i.test(head) ? 'Convocatoria' : 'Subvención';
  const amount = realAmount(g.amount_max) ? `Hasta ${eur(g.amount_max)}.` : realAmount(g.budget_total) ? `${eur(g.budget_total)} en total.` : '';
  const when = g.status !== 'OPEN' ? 'Plazo cerrado.' : g.deadline_date ? `Plazo hasta el ${g.deadline_date}.` : '';
  return `${kind}${giver ? ` ${giver.de} ${giver.name}` : ''}: ${head}.${name ? ` Nombre oficial: ${name}.` : ''} ${amount} ${when} Quién puede pedirla y cómo, en castellano llano.`
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
