// Backfill grant_row.region from the BDNS `regiones` NUTS codes.
//
// Needed for rows written before regions.js existed, when `region` was filled from the
// search row's nivel2 (the granting body's name — "VILLAQUILAMBRE" — rather than a
// territory). Fetches the detail record only: no PDF, no LLM, so it is cheap to re-run.
//
// Only rows that were actually extracted matter; screened-out rows are never displayed.
import 'dotenv/config';
import { db } from '../src/db.js';
import { bdnsGet, alert } from '../src/ingest/bdns.js';
import { territoryFromRegiones, canonicalProvince, CCAA, INE_PROVINCES, NATIONWIDE }
  from '../src/ingest/regions.js';
import { municipioFromBody } from '../src/municipios.js';

const VALID = new Set([...Object.values(CCAA), NATIONWIDE]);
const VALID_PROV = new Set(Object.values(INE_PROVINCES));

// Pin ayuntamiento-level calls to their town, and use the town to fill any province the
// NUTS codes left blank. Derived from data already stored — no API calls needed.
{
  const rows = db.prepare(`SELECT id, granting_body, province, region FROM grant_row
    WHERE ai_summary IS NOT NULL AND municipality IS NULL`).all();
  const upd = db.prepare(`UPDATE grant_row
    SET municipality = ?, province = COALESCE(province, ?), region = COALESCE(region, ?)
    WHERE id = ?`);
  let pinned = 0;
  for (const r of rows) {
    const m = municipioFromBody(r.granting_body);
    if (!m) continue;
    upd.run(m.name, m.province, m.ccaa, r.id);
    pinned++;
  }
  console.log(`pinned ${pinned} municipal call(s) to their town`);
}

// Rewrite province values stored before canonicalisation existed ("A Coruña" ->
// "Coruña, A", "Menorca" -> "Balears, Illes"), so they match the municipality dictionary.
{
  const rows = db.prepare('SELECT id, province FROM grant_row WHERE province IS NOT NULL').all();
  const upd = db.prepare('UPDATE grant_row SET province = ? WHERE id = ?');
  let fixed = 0, dropped = 0;
  for (const r of rows) {
    if (VALID_PROV.has(r.province)) continue;
    const canon = canonicalProvince(r.province);
    upd.run(canon, r.id);
    canon ? fixed++ : dropped++;
    if (!canon) console.warn(`  unrecognised province dropped: ${r.province}`);
  }
  if (fixed || dropped) console.log(`canonicalised ${fixed} province value(s), dropped ${dropped}`);
}

// Rows needing work: no valid comunidad, or no province yet on a sub-comunidad grant.
const rows = db.prepare(`SELECT id, bdns_ref, region, province, granting_level
  FROM grant_row WHERE ai_summary IS NOT NULL`).all()
  .filter(r => !r.region || !VALID.has(r.region)
            || (!r.province && r.granting_level === 'provincial'));

console.log(`backfilling territory for ${rows.length} extracted convocatoria(s)`);

const upd = db.prepare('UPDATE grant_row SET region = COALESCE(?, region), province = ? WHERE id = ?');
let ok = 0, unknown = 0, failed = 0;
for (const r of rows) {
  try {
    const detail = await bdnsGet('/convocatorias', { numConv: r.bdns_ref });
    const { ccaa, province } = territoryFromRegiones(detail.regiones, detail.organo?.nivel1);
    if (ccaa || province) { upd.run(ccaa, province, r.id); ok++; } else { unknown++; }
  } catch (e) {
    failed++;
    alert('backfill_regions', `convocatoria ${r.bdns_ref}: ${e.message}`);
  }
  await new Promise(x => setTimeout(x, 250));
}
console.log(`done: ${ok} set, ${unknown} undeterminable, ${failed} failed`);

// Anything still holding a non-comunidad value is a leftover nivel2 body name
// ("ZARAGOZA", "MIERES"). Null it rather than let it become a bogus filter option:
// a grant with no territory simply doesn't appear once a visitor picks one.
const placeholders = [...VALID].map(() => '?').join(',');
const cleared = db.prepare(
  `UPDATE grant_row SET region = NULL WHERE region IS NOT NULL AND region NOT IN (${placeholders})`
).run(...VALID).changes;
if (cleared) console.log(`cleared ${cleared} non-comunidad region value(s)`);

for (const r of db.prepare(`SELECT region, COUNT(*) n FROM grant_row
  WHERE ai_summary IS NOT NULL GROUP BY 1 ORDER BY n DESC`).all()) {
  console.log(`  ${String(r.n).padStart(4)}  ${r.region ?? '(sin territorio)'}`);
}
process.exit(0);
