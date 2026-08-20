// Seed: pilot municipalities + known entities (identity values verified in
// grants/BASELINE_FINDINGS.md — INE/CIF mismatches burned us once, do not "fix" them),
// then import the Phase 0 concesiones archive for the baseline-delta metric.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, uuid } from '../src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MUNICIPALITIES = [
  { name: 'Villaturde', ine_code: '34236', province: 'Palencia', region: 'Castilla y León', population: 300 },
  { name: 'Carrión de los Condes', ine_code: '34047', province: 'Palencia', region: 'Castilla y León', population: 2000 },
];

const ENTITIES = [
  { muni: '34236', name: 'Ayuntamiento de Villaturde', type: 'Ayuntamiento', cif: 'P3423700H' },
  { muni: '34236', name: 'Junta Vecinal de Villaturde', type: 'Junta_Vecinal', cif: 'P3400038J' },
  { muni: '34236', name: 'Junta Vecinal de Villotilla', type: 'Junta_Vecinal', cif: 'P3400039H' },
  { muni: '34236', name: 'Asociación de Agricultores y Ganaderos de Villaturde', type: 'Asociacion', cif: 'G34189332' },
  { muni: '34047', name: 'Ayuntamiento de Carrión de los Condes', type: 'Ayuntamiento', cif: 'P3404700A' },
];

const upsertMuni = db.prepare(`INSERT INTO municipality (id, name, ine_code, province, region, population)
  VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(ine_code) DO NOTHING`);
const findMuni = db.prepare('SELECT id FROM municipality WHERE ine_code = ?');
const findEntity = db.prepare('SELECT id FROM entity WHERE cif = ?');
const insertEntity = db.prepare(`INSERT INTO entity (id, municipality_id, name, type, cif, contact_channel)
  VALUES (?, ?, ?, ?, ?, 'via_alcalde')`);

for (const m of MUNICIPALITIES) upsertMuni.run(uuid(), m.name, m.ine_code, m.province, m.region, m.population);
for (const e of ENTITIES) {
  if (findEntity.get(e.cif)) continue;
  insertEntity.run(uuid(), findMuni.get(e.muni).id, e.name, e.type, e.cif);
}
console.log('municipalities + entities seeded');

// ---- baseline archive import (idempotent: INSERT OR IGNORE on BDNS id) ----
const BASELINE = process.env.BASELINE_JSON ||
  path.join(__dirname, '..', '..', 'baseline_out', 'concesiones_palencia_raw_3y.json');

if (!existsSync(BASELINE)) {
  console.log(`baseline JSON not found at ${BASELINE} — skipping archive import`);
} else {
  const rows = JSON.parse(readFileSync(BASELINE, 'utf-8'));
  const ins = db.prepare(`INSERT OR IGNORE INTO baseline_concesion
    (id, cod_concesion, fecha_concesion, beneficiario, cif, importe, convocatoria, num_convocatoria, nivel1, nivel2, nivel3)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const importAll = db.transaction((rows) => {
    let n = 0;
    for (const r of rows) {
      const cif = (r.beneficiario || '').split(' ')[0] || null;
      n += ins.run(r.id, r.codConcesion, r.fechaConcesion, r.beneficiario, cif,
        r.importe, r.convocatoria, r.numeroConvocatoria, r.nivel1, r.nivel2, r.nivel3).changes;
    }
    return n;
  });
  const n = importAll(rows);
  console.log(`baseline archive: ${n} new rows imported (${rows.length} in file)`);
}

// ---- per-CIF pulls (authoritative for pilot entities; the regiones=33 sweep
// misses CyL-scoped rows — see BASELINE_FINDINGS.md). Same BDNS ids, so
// INSERT OR IGNORE dedupes against the sweep import above. ----
function parseCsv(text) {
  const rows = []; let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [header, ...rest] = rows;
  return rest.map(r => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

const insCsv = db.prepare(`INSERT OR IGNORE INTO baseline_concesion
  (id, cod_concesion, fecha_concesion, beneficiario, cif, importe, convocatoria, num_convocatoria, nivel1, nivel2, nivel3)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const BASELINE_DIR = path.dirname(BASELINE);
for (const csvName of ['baseline_villaturde_3y.csv', 'baseline_carrion_de_los_condes_3y.csv']) {
  const p = path.join(BASELINE_DIR, csvName);
  if (!existsSync(p)) { console.log(`${csvName} not found — skipped`); continue; }
  const recs = parseCsv(readFileSync(p, 'utf-8'));
  let n = 0;
  for (const r of recs) {
    const cif = (r.beneficiario || '').split(' ')[0] || null;
    n += insCsv.run(Number(r.id), r.codConcesion, r.fechaConcesion, r.beneficiario, cif,
      Number(r.importe) || null, r.convocatoria, r.numeroConvocatoria, r.nivel1, r.nivel2, r.nivel3).changes;
  }
  console.log(`${csvName}: ${n} new rows (${recs.length} in file)`);
}

// sanity check against BASELINE_FINDINGS.md: Villaturde ayto 2025 = 12 concesiones / 66,716 EUR
const check = db.prepare(`SELECT COUNT(*) c, ROUND(SUM(importe)) s FROM baseline_concesion
  WHERE cif = 'P3423700H' AND fecha_concesion LIKE '2025%'`).get();
console.log(`sanity — Villaturde ayto 2025: ${check.c} concesiones, ${check.s} EUR (expect 12 / 66716)`);
