// One-shot playbook worker: claims exactly one pending job from Postgres, spawns a fresh
// claude-cli process (subscription auth, not ANTHROPIC_API_KEY) to run it, writes the
// result into convoca's SQLite, marks the job done, and exits. Invoked repeatedly by
// convoca-worker.timer (see deploy/convoca-worker.*) — no loop, no persistent session.
//
// job_type dispatch: each entry supplies the fixed system prompt/schema for that
// extraction and how to resolve a human-readable label + write the result back, so this
// file stays a thin runner rather than duplicating enrich.js/enrichLicitacion.js's rules.
import 'dotenv/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { db } from '../src/db.js';
import { EXTRACT_SYSTEM as GRANT_SYSTEM, ELIGIBILITY_SCHEMA, applyAiResult as applyGrantResult } from '../src/ingest/enrich.js';
import { EXTRACT_SYSTEM as LICITACION_SYSTEM, LICITACION_SCHEMA, applyAiResult as applyLicitacionResult } from '../src/ingest/enrichLicitacion.js';
import { alert } from '../src/ingest/bdns.js';
import { MODEL } from '../src/llm.js';

const execFileAsync = promisify(execFile);
const JOB_TIMEOUT_MS = Number(process.env.WORKER_JOB_TIMEOUT_MS || 5 * 60_000);

const JOB_TYPES = {
  enrich_grant: {
    systemPrompt: GRANT_SYSTEM,
    schema: ELIGIBILITY_SCHEMA,
    label: (refId) => db.prepare('SELECT bdns_ref FROM grant_row WHERE id = ?').get(refId)?.bdns_ref || refId,
    apply: (refId, label, ai) => applyGrantResult(refId, label, ai),
  },
  enrich_licitacion: {
    systemPrompt: LICITACION_SYSTEM,
    schema: LICITACION_SCHEMA,
    label: (refId) => db.prepare('SELECT expediente FROM licitacion_row WHERE id = ?').get(refId)?.expediente || refId,
    apply: (refId, label, ai) => applyLicitacionResult(label, ai),
  },
};

async function claimJob(client) {
  await client.query('BEGIN');
  const { rows } = await client.query(
    `SELECT id, job_type, ref_id, playbook FROM job
     WHERE status = 'pending' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
  );
  if (!rows.length) {
    await client.query('COMMIT');
    return null;
  }
  const job = rows[0];
  await client.query(`UPDATE job SET status = 'processing', updated_at = now() WHERE id = $1`, [job.id]);
  await client.query('COMMIT');
  return job;
}

async function runPlaybook(job, cfg) {
  const { stdout } = await execFileAsync('claude', [
    '-p', job.playbook,
    '--model', MODEL,
    '--tools', '',
    '--system-prompt', cfg.systemPrompt,
    '--json-schema', JSON.stringify(cfg.schema),
    '--output-format', 'json',
    '--no-session-persistence',
  ], { timeout: JOB_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 });

  const res = JSON.parse(stdout);
  if (res.is_error || !res.structured_output) {
    throw new Error(`claude-cli: ${res.result || res.subtype || 'no structured_output'}`);
  }
  return res.structured_output;
}

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.CONVOCA_JOBS_DB_URL });
  try {
    const client = await pool.connect();
    let job;
    try {
      job = await claimJob(client);
    } finally {
      client.release();
    }
    if (!job) {
      console.log('worker: no pending jobs');
      return;
    }

    const cfg = JOB_TYPES[job.job_type];
    if (!cfg) {
      await pool.query(
        `UPDATE job SET status = 'error', error = $2, updated_at = now() WHERE id = $1`,
        [job.id, `unknown job_type ${job.job_type}`],
      );
      console.error(`worker: job ${job.id} unknown job_type ${job.job_type}`);
      return;
    }
    const label = cfg.label(job.ref_id);

    try {
      const ai = await runPlaybook(job, cfg);
      cfg.apply(job.ref_id, label, ai);
      await pool.query(
        `UPDATE job SET status = 'done', result = $2, updated_at = now() WHERE id = $1`,
        [job.id, JSON.stringify(ai)],
      );
      console.log(`worker: job ${job.id} (${label}) done`);
    } catch (e) {
      await pool.query(
        `UPDATE job SET status = 'error', error = $2, updated_at = now() WHERE id = $1`,
        [job.id, e.message],
      );
      alert('extract', `job ${job.id} ${label}: ${e.message}`);
      console.error(`worker: job ${job.id} (${label}) failed: ${e.message}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch(e => { console.error('worker: fatal', e); process.exit(1); });
