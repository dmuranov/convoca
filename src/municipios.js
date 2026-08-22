// Shared access to the INE municipality dictionary (built by scripts/build-municipios.js).
// Loaded once at boot: 8k rows is small and it only changes between deploys.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const MUNICIPIOS = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'data', 'municipios.json'), 'utf-8'));

// Entidades locales menores — the pedanías and juntas vecinales much of rural Spain lives
// in (scripts/build-pedanias.js). They are not municipalities, so without this a villager
// from Villotilla searching for their own village finds nothing.
export const PEDANIAS = JSON.parse(
  readFileSync(path.join(__dirname, '..', 'data', 'pedanias.json'), 'utf-8'));

// Villages type accents and articles inconsistently, and BDNS shouts its organism names
// in caps ("MEDINA DEL CAMPO"). Fold both sides before comparing.
export const fold = (s) => (s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();

const BY_NAME = new Map();
for (const m of MUNICIPIOS) {
  const key = fold(m.name);
  // A handful of names repeat across provinces; an ambiguous name resolves to nothing
  // rather than to the wrong province.
  BY_NAME.set(key, BY_NAME.has(key) ? null : m);
}

// Exact, unambiguous municipality lookup. Returns null for unknown or duplicated names.
export function findMunicipio(name) {
  const key = fold(name);
  if (!key) return null;
  const hit = BY_NAME.get(key);
  if (hit !== undefined) return hit;
  // INE inverts trailing articles ("Pobla de Segur, La"); BDNS usually does not.
  const inverted = /^(el|la|las|los|les|l'|a|as|o|os)\s+(.+)$/.exec(key);
  if (inverted) {
    const alt = BY_NAME.get(fold(`${inverted[2]}, ${inverted[1]}`));
    if (alt !== undefined) return alt;
  }
  return null;
}

// BDNS names a local organism as "<TOWN> — AYUNTAMIENTO DE <TOWN>", so nivel2 is the
// municipality. Only ayuntamientos are municipality-scoped: a diputación's grants are
// open to the whole province, so those must NOT be pinned to one town.
export function municipioFromBody(grantingBody) {
  const body = grantingBody || '';
  if (!/AYUNTAMIENTO|CONCELLO|AJUNTAMENT|UDALA/i.test(body)) return null;
  const nivel2 = body.split('—')[0].trim();
  return findMunicipio(nivel2);
}
