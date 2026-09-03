// Step 5 of the build brief: small batch, read the cards before scaling. Runs
// enrichTerminationCard against 15 diverse Prijedor terminations (mix of reasons-populated,
// additional_information-populated, bare type-only records, and a same-procedure/
// multi-lot group) and prints input alongside output for manual review. No DB writes -
// this is a read-and-judge pass, not a pipeline.
import 'dotenv/config';
import { dbEjn } from '../src/dbEjn.js';
import { enrichTerminationCard } from '../src/ingest/enrichEjn.js';

const ids = [2993761, 2993764, 2993771, 2993777, 3032863, 3057208, 3127230, 3127983,
  3128833, 3130800, 2979115, 3128722, 3128726, 3149157, 3163995];

async function main() {
  for (const id of ids) {
    const t = dbEjn.prepare('SELECT * FROM ejn_termination WHERE id = ?').get(id);
    if (!t) { console.log(`--- ${id}: not found ---`); continue; }
    const card = await enrichTerminationCard(t);
    console.log(`\n=== ${id} (procedure ${t.procedure_id}, lot: ${t.lot_name ? t.lot_name.slice(0, 60) : 'n/a'}) ===`);
    console.log('type_name:', t.type_name);
    console.log('-- card --');
    console.log('plain_title:', card.plain_title);
    console.log('plain_reason:', card.plain_reason);
  }
}

main().catch(e => { console.error('testTerminationCards failed:', e.message); process.exitCode = 1; });
