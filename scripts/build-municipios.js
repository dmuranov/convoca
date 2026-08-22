// Build data/municipios.json from INE's official municipality dictionary.
//
// Source: https://www.ine.es/daco/daco42/codmun/diccionario<YY>.xlsx — the "Relación de
// municipios y códigos por comunidades autónomas y provincias". Columns are
// CODAUTO | CPRO | CMUN | DC | NOMBRE; the INE code is CPRO+CMUN.
//
// Re-run when INE publishes a new year (municipalities merge and rename):
//   node scripts/build-municipios.js            # fetches the current year
//   node scripts/build-municipios.js 24         # a specific edition
//
// No new dependency: .xlsx is a ZIP of XML and zlib is built into Node.
import { writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Province/comunidad vocabularies live in the ingest layer so grants and municipalities
// can never drift apart.
import { INE_PROVINCES as PROVINCES, INE_CCAA as CCAA } from '../src/ingest/regions.js';

// --- minimal ZIP reader (stored + deflate), enough for the handful of xlsx parts we need
function unzip(buf) {
  const files = new Map();
  // Walk the end-of-central-directory to the central directory, then each local header.
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    // Local header carries its own (possibly different) extra-field length.
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    files.set(name, method === 0 ? raw : inflateRawSync(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const decode = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/&amp;/g, '&');

const year = (process.argv[2] || String(new Date().getFullYear() % 100)).padStart(2, '0');
const url = `https://www.ine.es/daco/daco42/codmun/diccionario${year}.xlsx`;
console.log(`fetching ${url}`);
const res = await fetch(url, { headers: { 'User-Agent': 'convoca/1.0 (plazoabierto.es)' } });
if (!res.ok) throw new Error(`INE returned HTTP ${res.status} — check the year argument`);
const parts = unzip(Buffer.from(await res.arrayBuffer()));

const ssXml = parts.get('xl/sharedStrings.xml').toString('utf8');
const strings = [...ssXml.matchAll(/<si>(.*?)<\/si>/gs)]
  .map(m => decode([...m[1].matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map(x => x[1]).join('')));

const sheet = parts.get('xl/worksheets/sheet1.xml').toString('utf8');
const cellsOf = (xml) => [...xml.matchAll(/<c\b([^>]*)>(?:<v>(.*?)<\/v>)?<\/c>|<c\b([^>]*)\/>/gs)]
  .map(m => {
    const attrs = m[1] ?? m[3] ?? '';
    if (m[2] === undefined) return '';
    return / t="s"/.test(attrs) ? strings[+m[2]] : decode(m[2]);
  });

const out = [];
const seen = new Set();
for (const row of sheet.matchAll(/<row[^>]*>(.*?)<\/row>/gs)) {
  const [codauto, cpro, cmun, , nombre] = cellsOf(row[1]);
  if (!/^\d{2}$/.test(cpro || '') || !/^\d{3}$/.test(cmun || '') || !nombre) continue;
  const ine = cpro + cmun;
  if (seen.has(ine)) continue;
  seen.add(ine);
  out.push({
    ine,
    name: nombre.trim(),
    province: PROVINCES[cpro] || null,
    ccaa: CCAA[codauto] || null,
  });
}

const missing = out.filter(m => !m.province || !m.ccaa);
if (missing.length) {
  console.warn(`WARNING: ${missing.length} municipalities without province/ccaa, e.g.`,
    missing.slice(0, 3));
}

const dest = path.join(__dirname, '..', 'data', 'municipios.json');
writeFileSync(dest, JSON.stringify(out));
console.log(`wrote ${out.length} municipalities to ${dest}`);
console.log('provinces:', new Set(out.map(m => m.province)).size,
            '| comunidades:', new Set(out.map(m => m.ccaa)).size);
for (const probe of ['Villotilla', 'Villaturde', 'Carrión de los Condes']) {
  const hit = out.find(m => m.name.toLowerCase() === probe.toLowerCase());
  console.log(`  ${probe}:`, hit ? `${hit.ine} · ${hit.province} · ${hit.ccaa}` : 'NOT FOUND');
}
