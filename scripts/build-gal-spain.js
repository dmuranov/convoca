// Build data/gal.json for the whole of Spain: which LEADER Grupo de Acción Local covers
// each municipality, with its contact details.
//
// Two sources, best first:
//   1. Official 2023-2027 lists published by a comunidad, one fetcher each. Today only
//      Castilla y León (scripts/build-gal.js, the Junta's lookup) — its output is kept
//      as-is when this script runs.
//   2. Everywhere else: the national GAL layer behind Red PAC's map
//      (redpac.es/visores_redpac/gal → geoserver RRN:GAL). It lists all 254 groups with
//      their municipalities and contacts, but it was last updated in 2018 (programme
//      2014-2020). Most groups carried on into 2023-2027; some were renamed, merged or
//      changed contacts. Entries from it are marked so the chat says so.
//
// Usage:  node scripts/build-gal.js        (only when the CyL list needs refreshing; writes data/gal-cyl.json)
//         node scripts/build-gal-spain.js  (merges CyL + the national layer for the rest)
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUNICIPIOS, fold } from '../src/municipios.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEST = path.join(__dirname, '..', 'data', 'gal.json');
// The official Castilla y León list (written by scripts/build-gal.js). Kept separate so
// re-running this script never mistakes its own output for an official source.
const OFFICIAL_CYL = path.join(__dirname, '..', 'data', 'gal-cyl.json');
const RRN_URL = 'https://redpac.es/geoserver/ows?service=WFS&version=1.3.0&request=GetFeature'
  + '&typeName=RRN%3AGAL&outputFormat=application%2Fjson'
  + '&propertyName=id_gal,region,nombregal,nom_completo_siglas,provincia,municipio,direccion,codigopost,telefono,email,paginaweb,nom_municipios_englob_gal,marca_temporal';

// The national layer's region names → ours (src/municipios.js).
const REGION = {
  'Castilla - La Mancha': 'Castilla-La Mancha',
  'Principado de Asturias': 'Asturias',
  'Comunidad Foral de Navarra': 'Navarra',
  'País Vasco/Euskadi': 'País Vasco',
};
const ccaaOf = (r) => REGION[r] || r;

// Comunidades with an official 2023-2027 list of their own: the national layer is not used there.
const OFFICIAL = new Set(['Castilla y León']);

// ---- municipality name matching -------------------------------------------------------
// Our dictionary writes INE style ("Ercina, La", "Alacant/Alicante", "Coruña, A"); the
// national layer writes it as people do ("La Ercina", "Alicante", "A Coruña"). Index every
// reasonable spelling of each municipality, per comunidad.
function variants(name) {
  const out = new Set();
  const add = (s) => { const f = fold(s).replace(/[^a-z0-9ñ ]/g, ' ').replace(/\s+/g, ' ').trim(); if (f) out.add(f); };
  for (const part of String(name).split('/')) {
    const p = part.trim();
    add(p);
    const m = /^(.*),\s*(el|la|los|las|l'|lo|els|les|a|o|as|os|es|sa|ses|s')$/i.exec(p);
    if (m) { add(`${m[2]} ${m[1]}`); add(m[1]); }
  }
  add(name);
  return [...out];
}
const index = new Map();   // ccaa → Map(variant → [municipio])
for (const m of MUNICIPIOS) {
  if (!index.has(m.ccaa)) index.set(m.ccaa, new Map());
  const idx = index.get(m.ccaa);
  for (const v of variants(m.name)) {
    if (!idx.has(v)) idx.set(v, []);
    idx.get(v).push(m);
  }
}
function resolve(ccaa, rawName, provinceHint) {
  const idx = index.get(ccaa);
  if (!idx) return [];
  for (const v of variants(rawName)) {
    const hits = idx.get(v);
    if (!hits) continue;
    if (hits.length === 1) return hits;
    // Same name in two provinces of one comunidad: the group's own province decides.
    const inProv = hits.filter(h => fold(h.province).includes(fold(provinceHint || '')) || fold(provinceHint || '').includes(fold(h.province)));
    return inProv.length ? inProv : [];   // ambiguous and no hint: better no answer than a wrong one
  }
  return [];
}

// ---- build ----------------------------------------------------------------------------
const existing = JSON.parse(readFileSync(OFFICIAL_CYL, 'utf-8'));
const out = {
  built: new Date().toISOString().slice(0, 10),
  sources: [
    { ccaa: [...OFFICIAL], name: existing.source, period: existing.period || '2023-2027' },
    { ccaa: 'resto de España', name: 'Red PAC - mapa de Grupos de Acción Local (capa RRN:GAL)', period: '2014-2020', updated: '2018' },
  ],
  ccaa: [],
  gals: {},
  municipios: {},
};

// 1. Official lists, kept as they are.
for (const [id, g] of Object.entries(existing.gals || {})) {
  out.gals[id] = { ...g, period: g.period || existing.period || '2023-2027', official: true };
}
for (const [ine, ids] of Object.entries(existing.municipios || {})) out.municipios[ine] = [...ids];

// 2. The national layer for everything else.
const res = await fetch(RRN_URL, { headers: { 'User-Agent': 'Mozilla/5.0 (convoca build-gal-spain)' }, signal: AbortSignal.timeout(180000) });
if (!res.ok) throw new Error(`Red PAC layer: HTTP ${res.status}`);
const layer = await res.json();
const unmatched = {};
let groups = 0, linked = 0;
for (const f of layer.features) {
  const p = f.properties;
  const ccaa = ccaaOf(p.region);
  if (OFFICIAL.has(ccaa)) continue;
  groups++;
  const id = `rrn:${p.id_gal}`;
  const phone = String(p.telefono || '').replace(/\D/g, '').slice(0, 9) || null;
  out.gals[id] = {
    id,
    name: String(p.nom_completo_siglas || p.nombregal || '').replace(/\s+/g, ' ').trim(),
    phone,
    email: p.email ? String(p.email).trim().split(/[;,\s]/)[0] : null,
    web: p.paginaweb ? String(p.paginaweb).trim() : null,
    address: [p.direccion, p.codigopost, p.municipio, p.provincia].filter(Boolean).join(', ') || null,
    ccaa,
    province: p.provincia || null,   // where the group is based: lets the chat list a province's groups when the village is unknown
    period: '2014-2020',
    official: false,
  };
  for (const raw of String(p.nom_municipios_englob_gal || '').split(/;|\n/)) {
    const name = raw.replace(/\(.*?\)/g, '').trim();
    if (!name) continue;
    const hits = resolve(ccaa, name, p.provincia);
    if (!hits.length) { (unmatched[ccaa] ||= []).push(name); continue; }
    for (const m of hits) {
      const list = (out.municipios[m.ine] ||= []);
      if (!list.includes(id)) list.push(id);
      linked++;
    }
  }
}
out.ccaa = [...new Set([...OFFICIAL, ...layer.features.map(f => ccaaOf(f.properties.region))])].sort((a, b) => a.localeCompare(b, 'es'));

// Municipalities of a covered comunidad that no group lists are recorded as "in no GAL" only
// for the official lists (which enumerate every municipality); for the national layer an
// absent municipality may simply be a spelling we could not match, so it stays unknown.
writeFileSync(DEST, JSON.stringify(out));

const perCcaa = {};
for (const [ine, ids] of Object.entries(out.municipios)) {
  if (!ids.length) continue;
  const m = MUNICIPIOS.find(x => x.ine === ine);
  if (m) perCcaa[m.ccaa] = (perCcaa[m.ccaa] || 0) + 1;
}
console.log(`wrote ${Object.keys(out.gals).length} GALs (${groups} from the national layer), ${linked} municipality links`);
console.log('municipalities with a GAL, by comunidad:', perCcaa);
const um = Object.entries(unmatched).map(([c, l]) => `${c}: ${l.length}`).join(', ');
if (um) console.warn('names not matched (left unknown, never guessed):', um);
for (const [c, l] of Object.entries(unmatched)) console.warn(`  ${c} e.g.`, l.slice(0, 6).join(' | '));
