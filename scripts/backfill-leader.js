// One-off catch-up: import LEADER / local-development calls that are still open but were
// registered in BDNS before our grant history begins (the daily poll only looks back 7
// days, and LEADER calls often stay open for years). Diagnosed 2026-10-08: 35 open calls
// were missing, 30 of them from Illes Balears.
//
// Every candidate is screened on its BDNS detail first (open, applicable), so only those
// reach the paid enrichment step; enriched rows still need the operator's publish.
//
//   node scripts/backfill-leader.js --dry-run   # list what would be imported
//   node scripts/backfill-leader.js
import 'dotenv/config';
import { db } from '../src/db.js';
import { bdnsGet, ddmmyyyy } from '../src/ingest/bdns.js';
import { screen, ingestRows } from '../src/ingest/poll.js';

const DRY = process.argv.includes('--dry-run');
const FROM = process.env.LEADER_FROM || '2023-01-01';   // start of the 2023-2027 programme
const TERMS = ['LEADER', 'DESARROLLO LOCAL PARTICIPATIVO', 'GRUPO DE ACCION LOCAL'];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const today = new Date().toISOString().slice(0, 10);

const found = new Map();
for (const descripcion of TERMS) {
  for (let page = 0, total = 1; page < total; page++) {
    const j = await bdnsGet('/convocatorias/busqueda', {
      page: String(page), pageSize: '500', descripcion,
      fechaDesde: ddmmyyyy(new Date(FROM)), fechaHasta: ddmmyyyy(new Date()),
    });
    total = j.totalPages ?? 1;
    for (const row of j.content || []) found.set(row.numeroConvocatoria, row);
  }
}
console.log(`${found.size} LEADER-related calls in BDNS since ${FROM}`);

const known = db.prepare('SELECT skip_reason, plain_title FROM grant_row WHERE bdns_ref = ?');
const reopen = db.prepare('UPDATE grant_row SET skip_reason = NULL WHERE bdns_ref = ?');
const keep = new Map();
for (const [ref, row] of found) {
  const prior = known.get(ref);
  if (prior?.plain_title != null) continue;                  // already enriched
  const detail = await bdnsGet('/convocatorias', { numConv: ref });
  await sleep(250);
  if (screen(detail, today)) continue;                        // closed or nothing to apply to
  keep.set(ref, row);
  console.log(`  ${ref} ${row.fechaRecepcion} ${prior ? '(was skipped: ' + prior.skip_reason + ')' : '(new)'} | ${(row.nivel2 || '').slice(0, 40)} | ${(row.descripcion || '').slice(0, 70)}`);
}
console.log(`${keep.size} open, applicable and not yet in the index`);
if (DRY || !keep.size) process.exit(0);

// Rows skipped under the old rule are re-screened by ingestRows, which ignores rows that
// already carry a skip_reason.
for (const ref of keep.keys()) reopen.run(ref);
const n = await ingestRows(keep);
console.log(`done: ${n} enriched, awaiting publish in the operator screen`);
process.exit(0);
