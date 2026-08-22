// Build data/pedanias.json from the Registro de Entidades Locales (REL).
//
// EATIMs — entidades de ámbito territorial inferior al municipio — are the pedanías and
// juntas vecinales that much of rural Spain actually lives in. They are NOT municipalities,
// so INE's municipality dictionary does not list them: someone from Villotilla (Palencia)
// searching plazoabierto.es finds nothing without this file.
//
// Source: https://registroentidadeslocales.mpt.es/ → EATIMES → "Exportar datos".
// The export is a legacy OLE2/BIFF8 .xls (the other formats all fall back to a PDF), so
// this parses it directly rather than adding a spreadsheet dependency.
//
//   node scripts/build-pedanias.js
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const URL_ALL = 'https://registroentidadeslocales.mpt.es/REL/frontend/export_data/file_export/export_excel/eatimes/all/all';

// ---------- OLE2 compound file: pull one named stream out ----------
function oleStream(buf, wanted) {
  if (buf.readUInt32LE(0) !== 0xe011cfd0) throw new Error('not an OLE2 file');
  const secSize = 1 << buf.readUInt16LE(30);
  const at = (sector) => 512 + sector * secSize;

  // DIFAT -> FAT sector list. The first 109 entries live in the header; the rest chain
  // through dedicated DIFAT sectors.
  const fatSectors = [];
  for (let i = 0; i < 109; i++) {
    const s = buf.readInt32LE(76 + i * 4);
    if (s >= 0) fatSectors.push(s);
  }
  let difat = buf.readInt32LE(68);
  const perSector = secSize / 4 - 1;
  while (difat >= 0 && difat < 0xfffffffa) {
    const base = at(difat);
    for (let i = 0; i < perSector; i++) {
      const s = buf.readInt32LE(base + i * 4);
      if (s >= 0) fatSectors.push(s);
    }
    difat = buf.readInt32LE(base + perSector * 4);
  }

  // Flatten the FAT so we can follow sector chains.
  const fat = [];
  for (const fs of fatSectors) {
    const base = at(fs);
    for (let i = 0; i < secSize / 4; i++) fat.push(buf.readInt32LE(base + i * 4));
  }

  const chain = (start, size) => {
    const parts = [];
    let s = start, left = size;
    while (s >= 0 && s < fat.length && left > 0) {
      const take = Math.min(secSize, left);
      parts.push(buf.subarray(at(s), at(s) + take));
      left -= take;
      s = fat[s];
    }
    return Buffer.concat(parts);
  };

  // Walk the directory for the requested stream.
  let dirSector = buf.readInt32LE(48);
  while (dirSector >= 0 && dirSector < fat.length) {
    const base = at(dirSector);
    for (let off = 0; off < secSize; off += 128) {
      const nameLen = buf.readUInt16LE(base + off + 64);
      if (nameLen < 2) continue;
      const name = buf.toString('utf16le', base + off, base + off + nameLen - 2);
      if (name === wanted) {
        return chain(buf.readInt32LE(base + off + 116), buf.readUInt32LE(base + off + 120));
      }
    }
    dirSector = fat[dirSector];
  }
  throw new Error(`stream "${wanted}" not found`);
}

// ---------- BIFF8: shared strings + cell labels ----------
// Records are type(2) len(2) payload. Long records spill into CONTINUE (0x003C), and the
// SST can split a single string across that boundary — each continuation restarts with its
// own "is this UTF-16" flag byte, which is the classic trap in this format.
function biffCells(wb) {
  const recs = [];
  for (let p = 0; p + 4 <= wb.length;) {
    const type = wb.readUInt16LE(p), len = wb.readUInt16LE(p + 2);
    recs.push({ type, data: wb.subarray(p + 4, p + 4 + len) });
    p += 4 + len;
  }

  // Stitch SST + its CONTINUEs, remembering where each continuation began.
  const sstIdx = recs.findIndex(r => r.type === 0x00fc);
  if (sstIdx < 0) throw new Error('no SST record');
  const blocks = [recs[sstIdx].data];
  for (let i = sstIdx + 1; i < recs.length && recs[i].type === 0x003c; i++) blocks.push(recs[i].data);
  const sst = Buffer.concat(blocks);
  const bounds = new Set();
  let acc = 0;
  for (const b of blocks) { acc += b.length; bounds.add(acc); }

  const strings = [];
  const unique = sst.readUInt32LE(4);
  let p = 8;
  for (let i = 0; i < unique && p < sst.length; i++) {
    const cch = sst.readUInt16LE(p); p += 2;
    let flags = sst[p]; p += 1;
    let rich = 0, far = 0;
    if (flags & 0x08) { rich = sst.readUInt16LE(p); p += 2; }
    if (flags & 0x04) { far = sst.readUInt32LE(p); p += 4; }

    let out = '', need = cch;
    while (need > 0) {
      const wide = flags & 0x01;
      // How many chars fit before the next CONTINUE boundary.
      let limit = Infinity;
      for (const b of bounds) if (b > p) { limit = Math.min(limit, b - p); }
      const avail = wide ? Math.floor(limit / 2) : limit;
      const take = Math.min(need, avail === Infinity ? need : avail);
      out += wide
        ? sst.toString('utf16le', p, p + take * 2)
        : Buffer.from(sst.subarray(p, p + take)).toString('latin1');
      p += wide ? take * 2 : take;
      need -= take;
      if (need > 0) { flags = sst[p]; p += 1; }   // continuation restarts with its flag byte
    }
    p += rich * 4 + far;
    strings.push(out);
  }

  // Collect labelled cells into rows.
  const rows = new Map();
  const put = (r, c, v) => {
    if (!rows.has(r)) rows.set(r, []);
    rows.get(r)[c] = v;
  };
  for (const rec of recs) {
    if (rec.type === 0x00fd && rec.data.length >= 10) {          // LABELSST
      put(rec.data.readUInt16LE(0), rec.data.readUInt16LE(2), strings[rec.data.readUInt32LE(6)] ?? '');
    } else if (rec.type === 0x0204 && rec.data.length >= 8) {    // LABEL (inline)
      const cch = rec.data.readUInt16LE(6);
      const wide = rec.data[8] & 0x01;
      put(rec.data.readUInt16LE(0), rec.data.readUInt16LE(2),
        wide ? rec.data.toString('utf16le', 9, 9 + cch * 2)
             : rec.data.subarray(9, 9 + cch).toString('latin1'));
    }
  }
  return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, cells]) => cells);
}

// ---------- build ----------
console.log(`fetching ${URL_ALL}`);
const res = await fetch(URL_ALL, {
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; convoca/1.0; +https://plazoabierto.es)' },
});
if (!res.ok) throw new Error(`REL returned HTTP ${res.status}`);
const xls = Buffer.from(await res.arrayBuffer());
console.log(`downloaded ${xls.length} bytes`);

const rows = biffCells(oleStream(xls, 'Workbook'));
console.log(`parsed ${rows.length} spreadsheet rows`);

// Columns: Comunidad | Provincia | Denominación | Nº Inscripción | Fecha | Capitalidad | Municipio
const header = rows.find(r => r.some(c => /denominaci/i.test(c || '')));
if (!header) throw new Error('header row not found — export layout changed');
const col = (re) => header.findIndex(c => re.test(c || ''));
const iProv = col(/provincia/i), iName = col(/denominaci/i), iMuni = col(/municipio/i);
if (iProv < 0 || iName < 0 || iMuni < 0) throw new Error('expected columns missing');

const out = [];
const seen = new Set();
for (const r of rows) {
  const name = (r[iName] || '').trim();
  const muni = (r[iMuni] || '').trim();
  const prov = (r[iProv] || '').trim();
  if (!name || !muni || /denominaci/i.test(name)) continue;
  const key = `${name}|${muni}`;
  if (seen.has(key)) continue;
  seen.add(key);
  out.push({ name, municipio: muni, provincia: prov });
}

const dest = path.join(__dirname, '..', 'data', 'pedanias.json');
writeFileSync(dest, JSON.stringify(out));
console.log(`wrote ${out.length} entidades locales menores to ${dest}`);
console.log('provinces covered:', new Set(out.map(p => p.provincia)).size);
for (const probe of ['Villotilla', 'Acera de la Vega', 'Arbejal']) {
  const hit = out.find(p => p.name.toLowerCase() === probe.toLowerCase());
  console.log(`  ${probe}:`, hit ? `${hit.municipio} (${hit.provincia})` : 'NOT FOUND');
}
