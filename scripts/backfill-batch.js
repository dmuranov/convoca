// Backfill the plain-language + eligibility fields over rows already in the DB, using the
// Message Batches API (50% of standard price, async, up to 24h) on a cheap model.
//
//   node scripts/backfill-batch.js                 # rows missing the plain-language fields
//   node scripts/backfill-batch.js --all           # every row
//   node scripts/backfill-batch.js --model claude-opus-5
//   node scripts/backfill-batch.js --dry-run       # build + price the requests, submit nothing
//   node scripts/backfill-batch.js --resume        # re-attach to batches already submitted
//
// Why this exists next to reenrich.js: reenrich re-runs the WHOLE chain one row at a time at
// list price, and that chain recomputes deadlines — which resets deadline_confirmed to 0 and
// throws away the operator's confirmations. This script touches only the fields the LLM
// actually owns (plain_title, plain_explainer, ai_summary, category, grant_eligibility) and
// never writes deadline_date, deadline_source, deadline_confirmed or status. Use reenrich
// when the ingest chain itself changed; use this when only the extraction prompt/schema did.
//
// The bases PDF is NOT re-fetched: enrichGrant already stored its text in raw_text.
import 'dotenv/config';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, uuid } from '../src/db.js';
import { anthropic } from '../src/llm.js';
import { bdnsGet, alert } from '../src/ingest/bdns.js';
import { extractContext, EXTRACT_SYSTEM, ELIGIBILITY_SCHEMA } from '../src/ingest/enrich.js';
import { suggestMatches } from '../src/ingest/match.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(__dirname, '..', 'db', 'backfill-batch.state.json');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

// Haiku by default: this is a bulk re-run over text that has already been through the
// pipeline once. Keep the expensive model for the daily arrivals, where it is pennies.
const MODEL = val('--model', 'claude-haiku-4-5');
const CHUNK = Number(val('--chunk', 500));   // requests per batch; well under the 256MB cap
const DRY = has('--dry-run');

// List price per MTok; the Batches API bills half of it.
const PRICES = {
  'claude-haiku-4-5': [1.00, 5.00],
  'claude-sonnet-5': [3.00, 15.00],
  'claude-opus-5': [5.00, 25.00],
};

function selectRows() {
  const where = has('--all') ? '' : 'WHERE plain_title IS NULL OR plain_explainer IS NULL';
  return db.prepare(`SELECT id, bdns_ref, title, granting_body, raw_text
    FROM grant_row ${where} ORDER BY created_at DESC`).all();
}

// Phase 1 - build one request per row. Needs the BDNS detail record (the extraction context
// quotes finalidad / beneficiarios / sectores), so this stays sequential and gentle; the
// bases text comes from raw_text rather than a second PDF download.
async function buildRequests(rows) {
  const requests = [];
  for (const [i, g] of rows.entries()) {
    let detail;
    try {
      detail = await bdnsGet('/convocatorias', { numConv: g.bdns_ref });
    } catch (e) {
      alert('backfill', `detail ${g.bdns_ref}: ${e.message}`);
      continue;
    }
    requests.push({
      custom_id: g.id,
      params: {
        model: MODEL,
        max_tokens: 2048,
        system: EXTRACT_SYSTEM,
        output_config: { format: { type: 'json_schema', schema: ELIGIBILITY_SCHEMA } },
        messages: [{ role: 'user', content: extractContext(g, detail, g.raw_text) }],
      },
    });
    if ((i + 1) % 25 === 0) console.log(`  built ${i + 1}/${rows.length}`);
    await new Promise(r => setTimeout(r, 500));   // be gentle with BDNS
  }
  return requests;
}

async function estimate(requests) {
  if (!requests.length) return;
  const sample = requests[0].params;
  let input_tokens, exact = true;
  try {
    ({ input_tokens } = await anthropic.messages.countTokens({
      model: MODEL, system: sample.system, messages: sample.messages,
    }));
  } catch (e) {
    // count_tokens is itself a billed call, so it fails when credits run out - which is
    // precisely when you want to price a run before committing to it. Fall back to a
    // rough local count rather than refusing to answer.
    exact = false;
    input_tokens = Math.round((sample.system.length + sample.messages[0].content.length) / 3.5);
    console.log(`(count_tokens unavailable: ${e.message.split('\n')[0].slice(0, 80)})`);
  }
  const [inUsd, outUsd] = PRICES[MODEL] || [0, 0];
  // Upper bound: prices the first row's input across every request and assumes output
  // runs to max_tokens, then halves it for batch.
  const cost = requests.length * (input_tokens / 1e6 * inUsd + 2048 / 1e6 * outUsd) / 2;
  console.log(`~${input_tokens} input tokens on the first request${exact ? '' : ' (estimated)'}; ` +
    `${requests.length} requests on ${MODEL} costs at most about $${cost.toFixed(2)} batched.`);
}

function saveState(s) { writeFileSync(STATE, JSON.stringify(s, null, 2)); }
function loadState() { return existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : null; }

async function submit(requests) {
  const ids = [];
  for (let i = 0; i < requests.length; i += CHUNK) {
    const batch = await anthropic.messages.batches.create({ requests: requests.slice(i, i + CHUNK) });
    console.log(`submitted batch ${batch.id} (${Math.min(CHUNK, requests.length - i)} requests)`);
    ids.push(batch.id);
    // Written after every chunk, not at the end: a crash mid-submission must not orphan
    // batches that are already costing money.
    saveState({ model: MODEL, submitted_at: new Date().toISOString(), batches: ids });
  }
  return ids;
}

async function awaitBatch(id) {
  for (;;) {
    const b = await anthropic.messages.batches.retrieve(id);
    if (b.processing_status === 'ended') {
      console.log(`batch ${id} ended: ${b.request_counts.succeeded} ok, ${b.request_counts.errored} errored`);
      return;
    }
    console.log(`batch ${id}: ${b.processing_status}, ${b.request_counts.processing} processing`);
    await new Promise(r => setTimeout(r, 60_000));
  }
}

// Phase 3 - write back. Only the LLM-owned fields; deadlines and status are untouched on
// purpose (see the header note about deadline_confirmed).
function applyResult(grantId, ai) {
  db.prepare(`UPDATE grant_row SET
      ai_summary = COALESCE(?, ai_summary),
      plain_title = COALESCE(?, plain_title),
      plain_explainer = COALESCE(?, plain_explainer),
      category = COALESCE(?, category)
    WHERE id = ?`)
    .run(ai.resumen || null, ai.titulo_claro?.trim() || null,
      ai.explicacion ? JSON.stringify(ai.explicacion) : null,
      ai.category || null, grantId);

  // One eligibility row per grant - a plain INSERT would duplicate the grant in every
  // LEFT JOIN behind the public list.
  db.prepare('DELETE FROM grant_eligibility WHERE grant_id = ?').run(grantId);
  db.prepare(`INSERT INTO grant_eligibility (id, grant_id, entity_types, pop_min, pop_max, territory_scope, funds_what, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(uuid(), grantId, JSON.stringify(ai.entity_types || []), ai.pop_min ?? null, ai.pop_max ?? null,
      ai.territory_scope || null, JSON.stringify(ai.funds_what || []), null);
  suggestMatches(grantId);
}

async function collect(ids) {
  let ok = 0, failed = 0;
  for (const id of ids) {
    await awaitBatch(id);
    for await (const r of await anthropic.messages.batches.results(id)) {
      if (r.result.type !== 'succeeded') {
        failed++;
        alert('backfill', `grant ${r.custom_id}: ${r.result.type} ${r.result.error?.type || ''}`);
        continue;
      }
      const text = r.result.message.content.find(b => b.type === 'text')?.text;
      try {
        applyResult(r.custom_id, JSON.parse(text || '{}'));
        ok++;
      } catch (e) {
        failed++;
        alert('backfill', `grant ${r.custom_id}: unparseable extract (${e.message})`);
      }
    }
  }
  console.log(`done: ${ok} written, ${failed} failed`);
  return failed && !ok ? 1 : 0;
}

const prior = has('--resume') ? loadState() : null;
if (prior) {
  console.log(`resuming ${prior.batches.length} batch(es) from ${prior.submitted_at} (${prior.model})`);
  process.exit(await collect(prior.batches));
}

const rows = selectRows();
console.log(`${rows.length} convocatoria(s) to backfill on ${MODEL}` +
  `${has('--all') ? ' (--all)' : ' missing plain-language fields'}`);
if (!rows.length) process.exit(0);

const requests = await buildRequests(rows);
console.log(`built ${requests.length} request(s)`);
await estimate(requests);
if (DRY) { console.log('--dry-run: nothing submitted'); process.exit(0); }
if (!requests.length) process.exit(0);

process.exit(await collect(await submit(requests)));
