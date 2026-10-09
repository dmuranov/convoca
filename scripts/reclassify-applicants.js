// One-off: re-classify "who can apply" (grant_eligibility.entity_types) for published grants with
// the full category list (src/applicants.js). The original list was for village bodies only, so
// business and personal grants were labelled "Asociaciones" or "Otras entidades". Only
// entity_types and applicant_v change: titles, summaries and everything else stay as they are.
//
//   node scripts/reclassify-applicants.js --dry-run --limit 15   # show old -> new, write nothing
//   node scripts/reclassify-applicants.js                        # every published grant not yet done
import 'dotenv/config';
import { db, uuid } from '../src/db.js';
import { anthropic, MODEL } from '../src/llm.js';
import { APPLICANT_TYPES, APPLICANT_DESCRIPTION, APPLICANT_LABELS } from '../src/applicants.js';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const LIMIT = Number(argv[argv.indexOf('--limit') + 1]) || null;
const CONCURRENCY = 4;

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['entity_types'],
  properties: { entity_types: { type: 'array', description: APPLICANT_DESCRIPTION, items: { type: 'string', enum: APPLICANT_TYPES } } },
};
const SYSTEM = `Clasificas quién puede pedir una subvención española según sus bases. Devuelve solo las categorías que las bases admiten de verdad como solicitantes, lo más concretas posible (Estudiante mejor que Particular si es para estudiantes; Pyme y Autonomo si son empresas pequeñas y autónomos). Otro solo si ninguna encaja.`;

const rows = db.prepare(`SELECT g.id, g.title, g.plain_title, g.ai_summary, g.plain_explainer, g.beneficiarios_bdns,
    substr(g.raw_text, 1, 6000) AS bases, e.entity_types AS old
  FROM grant_row g LEFT JOIN grant_eligibility e ON e.grant_id = g.id
  WHERE g.published = 1 AND (e.applicant_v IS NULL OR e.applicant_v < 2)
  ORDER BY g.status = 'OPEN' DESC, g.published_at DESC ${LIMIT ? `LIMIT ${LIMIT}` : ''}`).all();
console.log(`${rows.length} published grant(s) to re-classify${DRY ? ' (dry run)' : ''}`);

const update = db.prepare('UPDATE grant_eligibility SET entity_types = ?, applicant_v = 2 WHERE grant_id = ?');
const insert = db.prepare(`INSERT INTO grant_eligibility (id, grant_id, entity_types, funds_what, applicant_v) VALUES (?, ?, ?, '[]', 2)`);
const label = (json) => { try { return JSON.parse(json || '[]').map(t => APPLICANT_LABELS[t] || t).join(', ') || '—'; } catch { return '—'; } };

async function classify(r) {
  let who = '';
  try { who = JSON.parse(r.plain_explainer || '{}').quien_puede || ''; } catch { /* none */ }
  const content = [
    `Título: ${r.plain_title || ''} (oficial: ${r.title || ''})`,
    `Resumen: ${r.ai_summary || ''}`,
    `Quién puede pedirla (resumen): ${who}`,
    `Tipos de beneficiario en BDNS: ${r.beneficiarios_bdns || 'n/d'}`,
    `Inicio de las bases:\n${r.bases || '(no disponibles)'}`,
  ].join('\n');
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await anthropic.messages.create({
        model: MODEL, max_tokens: 200, temperature: 0, system: SYSTEM,
        output_config: { format: { type: 'json_schema', schema: SCHEMA } },
        messages: [{ role: 'user', content }],
      });
      const out = JSON.parse(res.content.find(b => b.type === 'text')?.text || '{}');
      return [...new Set((out.entity_types || []).filter(t => APPLICANT_TYPES.includes(t)))];
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
}

let done = 0, failed = 0;
const queue = [...rows];
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  for (let r = queue.shift(); r; r = queue.shift()) {
    try {
      const types = await classify(r);
      const json = JSON.stringify(types);
      if (DRY) console.log(`  ${(r.plain_title || r.title).slice(0, 60).padEnd(60)} | ${label(r.old)}  ->  ${label(json)}`);
      else if (!update.run(json, r.id).changes) insert.run(uuid(), r.id, json);
      done++;
    } catch (e) {
      failed++;
      console.warn(`  ${r.id}: ${e.message}`);
    }
    if (!DRY && (done + failed) % 100 === 0) console.log(`  ${done + failed}/${rows.length}`);
  }
}));
console.log(`done: ${done} classified, ${failed} failed`);
process.exit(0);
