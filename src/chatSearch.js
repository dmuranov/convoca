// What the assistant searches before it answers.
//
// The assistant used to be handed the 12-15 grants closing soonest in the visitor's picked place,
// whatever they were about, and only nationwide ones when no place was picked. So "empresas en
// Huelva", "pymes en Segovia" or "audífonos" got "no encuentro nada" even when we had them. Now:
//   1. the place is read from the question itself when the place picker is empty
//      ("en Huelva", "vivo en Albacete", "Comunidad Valenciana");
//   2. every open, published grant in that territory is searched for the question's topic
//      (with a few synonyms), and business questions only get business grants;
//   3. the result - an exact count and the matching grants - goes to the assistant AND back to the
//      page, which filters its list to exactly those grants.
import { db } from './db.js';
import { MUNICIPIOS, findMunicipio } from './municipios.js';
import { CCAA, INE_PROVINCES, NATIONWIDE } from './ingest/regions.js';
import { isBusinessGrant } from './negocios.js';

const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const words = (s) => fold(s).replace(/[^a-z0-9ñ]+/g, ' ').trim().split(' ').filter(Boolean);

// ---- place --------------------------------------------------------------------------------
const PROVINCE_CCAA = new Map();
for (const m of MUNICIPIOS) if (m.province && !PROVINCE_CCAA.has(m.province)) PROVINCE_CCAA.set(m.province, m.ccaa);

// Every way people write a province: "Valencia/València", "A Coruña" / "La Coruña", old Castilian names.
const PROVINCE_ALIASES = new Map();
const addProv = (alias, province) => { const k = fold(alias).trim(); if (k && !PROVINCE_ALIASES.has(k)) PROVINCE_ALIASES.set(k, province); };
for (const p of new Set(Object.values(INE_PROVINCES))) {
  for (const part of p.split('/')) {
    const inv = /^(.*),\s*(A|La|Las|El|Los|Illes)$/.exec(part.trim());
    addProv(inv ? `${inv[2]} ${inv[1]}` : part, p);
    if (inv) addProv(inv[1], p);
  }
}
for (const [a, p] of Object.entries({ 'la coruña': 'Coruña, A', 'coruña': 'Coruña, A', vizcaya: 'Bizkaia', guipuzcoa: 'Gipuzkoa',
  alava: 'Araba/Álava', gerona: 'Girona', lerida: 'Lleida', orense: 'Ourense', baleares: 'Balears, Illes', 'islas baleares': 'Balears, Illes',
  mallorca: 'Balears, Illes', tenerife: 'Santa Cruz de Tenerife', 'gran canaria': 'Palmas, Las', castellon: 'Castellón/Castelló',
  alicante: 'Alicante/Alacant', 'la rioja': 'Rioja, La', rioja: 'Rioja, La' })) addProv(a, p);

const CCAA_ALIASES = new Map();
const addCcaa = (alias, ccaa) => CCAA_ALIASES.set(fold(alias), ccaa);
for (const c of Object.values(CCAA)) addCcaa(c, c);
for (const [a, c] of Object.entries({ 'comunidad valenciana': 'Comunitat Valenciana', 'pais valenciano': 'Comunitat Valenciana',
  euskadi: 'País Vasco', 'pais vasco': 'País Vasco', catalunya: 'Cataluña', cataluna: 'Cataluña', 'castilla la mancha': 'Castilla-La Mancha',
  'castilla y leon': 'Castilla y León', 'islas canarias': 'Canarias', 'comunidad de madrid': 'Comunidad de Madrid',
  'region de murcia': 'Región de Murcia', andalucia: 'Andalucía', aragon: 'Aragón', 'principado de asturias': 'Asturias' })) addCcaa(a, c);

const has = (text, phrase) => new RegExp(`(^|[^a-z0-9ñ])${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9ñ]|$)`).test(text);

// The place a question names, or null. Region phrases first ("Comunidad Valenciana" must not read
// as the province of Valencia), then a town after "en/de/desde" ("vivo en Medina de Pomar"), then
// a province. A province-only place never sees one town's money (same rule as the place picker).
export function placeFromText(message) {
  const text = fold(message).replace(/[^a-z0-9ñ' -]+/g, ' ');
  for (const [alias, ccaa] of [...CCAA_ALIASES].sort((a, b) => b[0].length - a[0].length)) {
    if (alias.includes(' ') && has(text, alias)) return { ccaa, province: null, name: null, label: ccaa };
  }
  const prov = [...PROVINCE_ALIASES].sort((a, b) => b[0].length - a[0].length).find(([alias]) => has(text, alias));
  // A town: the 1-4 words after a preposition that name a real municipality, longest first.
  for (const m of text.matchAll(/(?:^|\s)(?:en|de|desde|del)\s+((?:[a-zñ'-]+\s*){1,5})/g)) {
    const ws = m[1].trim().split(/\s+/);
    for (let n = Math.min(4, ws.length); n >= 1; n--) {
      const cand = ws.slice(0, n).join(' ');
      if (cand.length < 4 || PROVINCE_ALIASES.has(cand) || CCAA_ALIASES.has(cand)) continue;
      const muni = findMunicipio(cand);
      if (muni && (!prov || muni.province === prov[1])) return { ccaa: muni.ccaa, province: muni.province, name: muni.name, label: muni.name };
    }
  }
  // A town at the very end with no preposition: "tramitacion de subvenciones requena". Only at the
  // end (where people put the place) and only long names, so "becas santander doctorado" stays
  // about the bank, not the city.
  const tail = text.trim().split(/\s+/);
  for (let n = Math.min(3, tail.length); n >= 1; n--) {
    const cand = tail.slice(-n).join(' ');
    if (cand.length < 5 || NOT_PLACES.has(cand) || STOP.has(cand) || PROVINCE_ALIASES.has(cand) || CCAA_ALIASES.has(cand)) continue;
    const muni = findMunicipio(cand);
    if (muni && (!prov || muni.province === prov[1])) return { ccaa: muni.ccaa, province: muni.province, name: muni.name, label: muni.name };
  }
  if (prov) {
    // "Burgos", "Huelva", "Albacete": most people naming the capital live in it, so its own
    // council's grants count too (a village elsewhere in the province would name the village).
    const label = prov[1].split('/')[0];
    const capital = MUNICIPIOS.find(m => m.province === prov[1] && fold(m.name) === fold(label));
    return { ccaa: PROVINCE_CCAA.get(prov[1]), province: prov[1], name: capital ? capital.name : null, label, fromProvince: true };
  }
  for (const [alias, ccaa] of CCAA_ALIASES) if (has(text, alias)) return { ccaa, province: null, name: null, label: ccaa };
  return null;
}

// ---- topic --------------------------------------------------------------------------------
const STOP = new Set(('a al algo alguna alguno algun ante bajo como con contra cual cuales cuando de del desde donde e el ella ellos en ' +
  'entre era es esa ese eso esta este esto estoy hay haber he la las le les lo los mas me mi mis mucho muy nada ni no nos nosotros o os ' +
  'para pero poco por porque que quien se ser si sin sobre soy su sus tambien te tengo tenemos tiene tu tus un una uno unos unas y ya yo ' +
  'ayuda ayudas subvencion subvenciones convocatoria convocatorias beca becas dinero financiacion hola buenas buenos dias gracias ' +
  'busco buscando quiero queremos necesito necesitamos puedo podemos pedir solicitar solicitud existe existen hay disponibles ' +
  'abiertas abierta abierto abiertos plazo plazos informacion vivo somos estamos zona pueblo ciudad provincia comunidad region ' +
  'comprar compra pagar pago conseguir sacar sacarme tener hacer montar arreglar mejorar cambiar poner abrir ampliar estudiar ' +
  'empresa empresas pyme pymes autonomo autonoma autonomos negocio negocios emprender emprendedor emprendedora emprendedores ' +
  // Who gives it or how it is processed, not what it is for: "subvenciones gobierno de navarra",
  // "tramitacion de subvenciones requena", "beca ... ayuda economica".
  'gobierno junta xunta generalitat govern diputacion ayuntamiento concello ajuntament cabildo consell ministerio estado ' +
  'publica publicas publico publicos oficial oficiales tramitacion tramitar tramite tramites gestion gestionar presentar ' +
  'economica economicas economico economicos').split(' '));
// Names that are towns but almost always mean something else in a grants search.
const NOT_PLACES = new Set(['santander', 'erasmus', 'leader', 'europa']);
const BUSINESS = /\b(empresa|empresas|pyme|pymes|autonom[oa]s?|negocios?|emprend\w*|comercio|tienda|startup|sociedad limitada|bar|restaurante|hostel\w*|casa rural|alojamiento|abrir un|montar un)\b/;
// Different words for the same thing. Each topic word also matches its stem.
const SYNONYMS = {
  carnet: ['conducir', 'permiso de conduc', 'carne de conduc', 'carnet'], carne: ['conducir', 'carnet'], conducir: ['conducir', 'carnet', 'permiso de conduc'],
  audifono: ['audifono', 'auditiv', 'sordera', 'audicion', 'hipoacusia'], audifonos: ['audifono', 'auditiv', 'audicion'],
  protectora: ['protectora', 'proteccion animal', 'animales', 'bienestar animal'], protectoras: ['protectora', 'proteccion animal', 'animales'],
  mueble: ['mueble', 'mobiliario', 'equipamiento'], muebles: ['mueble', 'mobiliario', 'equipamiento'],
  construccion: ['construccion', 'obra', 'reforma', 'rehabilit'], reforma: ['reforma', 'obra', 'rehabilit'], reformas: ['reforma', 'obra', 'rehabilit'],
  obras: ['obra', 'reforma', 'rehabilit'], ordenador: ['ordenador', 'informatic', 'portatil', 'tablet'], alquiler: ['alquiler', 'vivienda'],
  emancipacion: ['emancipacion', 'emancipa', 'independiz', 'alquiler joven', 'bono alquiler'], toldo: ['toldo', 'sombra'], toldos: ['toldo', 'sombra'],
};
// A term must start a word: "bar" is not "barco", "club" not inside another word.
const atWordStart = (text, term) => {
  for (let i = text.indexOf(term); i !== -1; i = text.indexOf(term, i + 1)) {
    if (i === 0 || !/[a-z0-9ñ]/.test(text[i - 1])) return true;
  }
  return false;
};
const stem = (w) => (w.length > 5 && w.endsWith('es') ? w.slice(0, -2) : w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w);

export function topicTerms(message) {
  const ws = words(message).filter(w => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
  return [...new Set(ws)].map(w => ({ word: w, alts: [...new Set([stem(w), ...(SYNONYMS[w] || [])])] }));
}
export const isBusinessQuestion = (message) => BUSINESS.test(fold(message));

// Same four-tier territory rule as the listing page and the place picker.
function inTerritory(g, place) {
  if (!place) return true;
  if (g.region === NATIONWIDE) return true;
  if (g.region !== place.ccaa) return false;
  if (place.province && g.province && g.province !== place.province) return false;
  if (!g.municipality || g.municipality === place.name) return true;
  // One town's own grant. When the question names a region or a province (not a town), those
  // are real leads - "clubes deportivos galicia" has four, from Boiro, Malpica, Narón and Baiona -
  // so they count, ranked last and marked "solo para <town>". A named town never sees another's.
  return !place.name || !!place.fromProvince;
}
// The grant is for one municipality and we don't know the asker is from there.
export const onlyForOtherTown = (g, place) => !!g.municipality && (!place?.name || place.fromProvince) && g.municipality !== place?.name;

const OPEN = db.prepare(`
  SELECT g.id, g.bdns_ref, g.title, g.plain_title, g.granting_body, g.region, g.province, g.municipality, g.category,
         g.ai_summary, g.plain_explainer, g.amount_max, g.budget_total, g.source_url, g.is_rolling, g.beneficiarios_bdns,
         g.deadline_date AS deadline,
         CASE WHEN g.deadline_source = 'computed' AND g.deadline_confirmed = 0 THEN 1 ELSE 0 END AS deadline_estimated,
         e.entity_types, e.applicant_v, e.funds_what, e.territory_scope
  FROM grant_row g LEFT JOIN grant_eligibility e ON e.grant_id = g.id
  WHERE g.published = 1 AND g.status = 'OPEN'`);

// -> { place, business, terms, total, grants (all matches, best first) }
// `section: 'negocios'` (the Negocios page) always means business grants only.
// `groups` (from the AI reading of the question, src/chatAI.js): each group is one concept
// with its related words ("energía" -> energética, renovable, autoconsumo, fotovoltaica...);
// any of them counts, in title or summary. Without groups, the question's own words are used.
export function searchGrants(message, { place = null, section = null, groups = null, business: forceBusiness = null } = {}) {
  const business = section === 'negocios' || (forceBusiness ?? isBusinessQuestion(message));
  // The place's own words ("Huelva", "valenciana", "Medina de Pomar") are not the topic.
  const placeWords = new Set(place ? words([place.label, place.name, place.province, place.ccaa].join(' '))
    .flatMap(w => [w, w.replace(/a$/, 'o'), `${w}na`, `${w}no`]) : []);
  const aiGroups = Array.isArray(groups) ? groups
    .map(gr => [...new Set(gr.map(w => fold(w).trim()).filter(w => w.length > 2))])
    .filter(gr => gr.length) : null;
  const terms = aiGroups
    ? aiGroups.map(gr => ({ word: gr[0], alts: [...new Set(gr.map(stem))], ai: true }))
    : topicTerms(message).filter(t => !placeWords.has(t.word) && !placeWords.has(t.word.replace(/n[ao]$/, '')));
  const pool = OPEN.all().filter(g => inTerritory(g, place) && (!business || isBusinessGrant(g)));
  let scored;
  let fallback = null;
  if (!terms.length) {
    // "¿Qué ayudas hay para empresas en Huelva?" - no topic beyond who/where: everything that fits.
    scored = pool.map(g => ({ g, score: 1, hits: 0 }));
  } else {
    scored = pool.map(g => {
      const title = fold(`${g.plain_title || ''} ${g.title || ''}`);
      const body = fold(`${g.ai_summary || ''} ${g.category || ''} ${g.funds_what || ''} ${g.entity_types || ''} ${g.granting_body || ''}`);
      let score = 0, hits = 0;
      for (const t of terms) {
        // The visitor's own word may match title or summary; a synonym only counts in the title
        // (in a summary, "equipamiento" or "animales" matched doctorates and livestock shows).
        const own = stem(t.word);
        if (t.alts.some(a => atWordStart(title, a))) { score += 2; hits++; }
        else if (t.ai ? t.alts.some(a => atWordStart(body, a)) : atWordStart(body, own)) { score += 1; hits++; }
      }
      return { g, score, hits };
    }).filter(x => x.score > 0);
    // Grants that cover more of the question win outright: "ordenador estudiantes" means both,
    // not every grant for students.
    const maxHits = Math.max(0, ...scored.map(x => x.hits));
    if (maxHits > 1) scored = scored.filter(x => x.hits === maxHits);
    // Summary-only matches are a fallback: when anything matches in its title, drop the weak ones.
    // Several topic words with only weak single matches: nothing really fits.
    const best = Math.max(0, ...scored.map(x => x.score));
    if (best >= 2) scored = scored.filter(x => x.score >= 2);
    else if (terms.length > 1 && maxHits < 2) scored = [];
    // A business question whose topic matches nothing ("abrir un bar en Palencia"): the business
    // grants of the area are still the answer - the assistant says none is specific to that.
    if (!scored.length && business && pool.length) {
      scored = pool.map(g => ({ g, score: 0, hits: 0 }));
      fallback = 'business';
    }
  }
  // Closest first: the town's own grants, then its province's, then its region's, then nationwide.
  // ("subvenciones ourense" listed 29 nationwide training courses before anything from Ourense.)
  const tier = (g) => !place ? 0
    : onlyForOtherTown(g, place) ? -1
    : place.name && g.municipality === place.name ? 3
    : place.province && g.province === place.province ? 2
    : g.region === place.ccaa ? 1 : 0;
  scored.sort((a, b) => b.score - a.score || tier(b.g) - tier(a.g)
    || String(a.g.deadline || '9999').localeCompare(String(b.g.deadline || '9999')));
  for (const x of scored) x.g.only_town = onlyForOtherTown(x.g, place) ? x.g.municipality : null;
  return { place, business, fallback, terms: terms.map(t => t.word), total: scored.length, grants: scored.map(x => x.g) };
}
