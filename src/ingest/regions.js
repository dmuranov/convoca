// Territory derivation for the Spain-wide directory.
//
// BDNS `organo.nivel2` is the granting body's name, not a territory: for local grants
// it is the municipality or mancomunidad ("VILLAQUILAMBRE", "MANCOMUNIDAD DE LA
// MERINDAD DE DURANGO"), which is useless as a filter. The `regiones` array on the
// detail record carries NUTS codes instead:
//
//   [{descripcion: "ES41 - CASTILLA Y LEON"}]   NUTS2 = comunidad autónoma
//   [{descripcion: "ES615 - Huelva"}]           NUTS3 = provincia
//
// A NUTS3 province rolls up to its comunidad by truncating to four characters
// (ES615 → ES61 Andalucía), so one table keyed on NUTS2 covers both.

export const CCAA = {
  ES11: 'Galicia',
  ES12: 'Asturias',
  ES13: 'Cantabria',
  ES21: 'País Vasco',
  ES22: 'Navarra',
  ES23: 'La Rioja',
  ES24: 'Aragón',
  ES30: 'Comunidad de Madrid',
  ES41: 'Castilla y León',
  ES42: 'Castilla-La Mancha',
  ES43: 'Extremadura',
  ES51: 'Cataluña',
  ES52: 'Comunitat Valenciana',
  ES53: 'Illes Balears',
  ES61: 'Andalucía',
  ES62: 'Región de Murcia',
  ES63: 'Ceuta',
  ES64: 'Melilla',
  ES70: 'Canarias',
};

export const NATIONWIDE = 'Toda España';

// INE province codes (CPRO) -> official name. Single source of truth: the municipality
// dictionary is built from this table too (scripts/build-municipios.js), so grants and
// municipalities always speak the same province vocabulary.
export const INE_PROVINCES = {
  '01': 'Araba/Álava', '02': 'Albacete', '03': 'Alicante/Alacant', '04': 'Almería',
  '05': 'Ávila', '06': 'Badajoz', '07': 'Balears, Illes', '08': 'Barcelona',
  '09': 'Burgos', '10': 'Cáceres', '11': 'Cádiz', '12': 'Castellón/Castelló',
  '13': 'Ciudad Real', '14': 'Córdoba', '15': 'Coruña, A', '16': 'Cuenca',
  '17': 'Girona', '18': 'Granada', '19': 'Guadalajara', '20': 'Gipuzkoa',
  '21': 'Huelva', '22': 'Huesca', '23': 'Jaén', '24': 'León', '25': 'Lleida',
  '26': 'Rioja, La', '27': 'Lugo', '28': 'Madrid', '29': 'Málaga', '30': 'Murcia',
  '31': 'Navarra', '32': 'Ourense', '33': 'Asturias', '34': 'Palencia',
  '35': 'Palmas, Las', '36': 'Pontevedra', '37': 'Salamanca',
  '38': 'Santa Cruz de Tenerife', '39': 'Cantabria', '40': 'Segovia', '41': 'Sevilla',
  '42': 'Soria', '43': 'Tarragona', '44': 'Teruel', '45': 'Toledo',
  '46': 'Valencia/València', '47': 'Valladolid', '48': 'Bizkaia', '49': 'Zamora',
  '50': 'Zaragoza', '51': 'Ceuta', '52': 'Melilla',
};

// INE comunidad codes (CODAUTO) -> name, matching CCAA above.
export const INE_CCAA = {
  '01': 'Andalucía', '02': 'Aragón', '03': 'Asturias', '04': 'Illes Balears',
  '05': 'Canarias', '06': 'Cantabria', '07': 'Castilla y León',
  '08': 'Castilla-La Mancha', '09': 'Cataluña', '10': 'Comunitat Valenciana',
  '11': 'Extremadura', '12': 'Galicia', '13': 'Comunidad de Madrid',
  '14': 'Región de Murcia', '15': 'Navarra', '16': 'País Vasco', '17': 'La Rioja',
  '18': 'Ceuta', '19': 'Melilla',
};

// BDNS names islands at NUTS3 ("ES532 - Menorca") but Spain has no island provinces —
// they belong to Balears or one of the two Canary provinces. Without this a user from
// Menorca picking "Balears, Illes" would never match a Menorca-tagged grant.
const ISLAND_PROVINCE = {
  'mallorca': 'Balears, Illes',
  'menorca': 'Balears, Illes',
  'eivissa y formentera': 'Balears, Illes',
  'ibiza y formentera': 'Balears, Illes',
  'gran canaria': 'Palmas, Las',
  'lanzarote': 'Palmas, Las',
  'fuerteventura': 'Palmas, Las',
  'tenerife': 'Santa Cruz de Tenerife',
  'la palma': 'Santa Cruz de Tenerife',
  'la gomera': 'Santa Cruz de Tenerife',
  'el hierro': 'Santa Cruz de Tenerife',
};

// Fold a province name to a comparable key. Handles the two ways the same province is
// written: INE inverts the article ("Coruña, A") where BDNS does not ("A Coruña"), and
// BDNS pads bilingual slashes ("Valencia / València" vs "Valencia/València").
export function foldProvince(name) {
  let s = (name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  s = s.replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').trim();
  const inverted = /^(.+),\s*(a|as|o|os|el|la|las|los|les|illes|illa)$/.exec(s);
  if (inverted) s = `${inverted[2]} ${inverted[1]}`;
  return s;
}

const BY_FOLD = new Map(Object.values(INE_PROVINCES).map(p => [foldProvince(p), p]));

// Map any BDNS province spelling onto the canonical INE name, or null if unrecognised.
export function canonicalProvince(name) {
  const key = foldProvince(name);
  if (!key) return null;
  return BY_FOLD.get(key) || ISLAND_PROVINCE[key] || null;
}

// Parse `regiones` into { ccaa, province }.
//
// The province tier matters more than it looks: ~75% of what survives screening is
// provincial or municipal (Diputación de Palencia, Ayuntamiento de San Sadurniño), and
// collapsing those to a comunidad would offer a village in Burgos grants it cannot
// apply for. `descripcion` carries the province name already spelled out
// ("ES414 - Palencia"), so no external table is needed here.
//
// Returns province: null for comunidad-wide and nationwide calls.
export function territoryFromRegiones(regiones, nivel1) {
  const nuts2 = new Set();
  const provinces = new Set();
  for (const r of regiones || []) {
    const desc = (r?.descripcion || '').trim();
    const m = /^(ES\d{2,3})\s*-\s*(.+)$/.exec(desc);
    if (!m) continue;
    nuts2.add(m[1].slice(0, 4));                       // NUTS3 -> NUTS2
    if (m[1].length === 5) provinces.add(m[2].trim()); // NUTS3 only: a real province
  }
  const names = [...nuts2].map(c => CCAA[c]).filter(Boolean);

  let ccaa = null;
  if (names.length === 1) ccaa = names[0];
  else if (names.length > 1) ccaa = NATIONWIDE;        // spans several: relevant to everyone
  else if (/ESTATAL|ESTADO/i.test(nivel1 || '')) ccaa = NATIONWIDE;

  // Only a single, unambiguous province is useful for filtering. Several NUTS3 codes can
  // still canonicalise to one province (Mallorca + Menorca -> Balears), which is fine.
  const canon = new Set([...provinces].map(canonicalProvince).filter(Boolean));
  const province = canon.size === 1 && ccaa !== NATIONWIDE ? [...canon][0] : null;
  return { ccaa, province };
}

// Back-compat shim for callers that only want the comunidad.
export const ccaaFromRegiones = (regiones, nivel1) => territoryFromRegiones(regiones, nivel1).ccaa;
