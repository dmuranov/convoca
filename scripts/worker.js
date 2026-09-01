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
// Tripwire, not a documented Anthropic limit - a gradual climb in daily job volume is
// invisible without this; a threshold crossing in the log is not. 300/day is ~2-3x current
// combined grants+licitaciones volume. Fires again at every multiple (600, 900, ...) so
// growth past the first crossing keeps escalating instead of going quiet again.
const DAILY_ALERT_THRESHOLD = Number(process.env.WORKER_DAILY_ALERT_THRESHOLD || 300);

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

// Counts every job row created today, not just this one - approximates claude-cli
// invocations/day closely enough for a tripwire (a job only isn't an invocation yet if
// it's still pending/processing, which is transient given the 20s worker cadence).
//
// Crossing detection is a persisted high-water mark, not `n % THRESHOLD === 0`: the
// producer side (queue.js) inserts jobs in bulk per poll run, so `n` can jump past a
// multiple of THRESHOLD in one step and a modulo check would silently never land on it -
// skipping the alert entirely, not just re-firing it. worker_alert_state.last_alerted_multiple
// is the highest multiple already alerted today; the UPSERT only advances (and returns a
// row, triggering the alert) when the new multiple is strictly greater, so this fires
// exactly once per threshold regardless of how `n` jumps between checks.
async function logDailyVolume(pool) {
  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM job WHERE created_at >= date_trunc('day', now())`,
  );
  const n = countRows[0].n;
  console.log(`worker: ${n} job(s) today`);

  const multiple = DAILY_ALERT_THRESHOLD > 0 ? Math.floor(n / DAILY_ALERT_THRESHOLD) : 0;
  if (multiple > 0) {
    const { rows: advanced } = await pool.query(
      `INSERT INTO worker_alert_state (day, last_alerted_multiple) VALUES (CURRENT_DATE, $1)
       ON CONFLICT (day) DO UPDATE SET last_alerted_multiple = $1
       WHERE worker_alert_state.last_alerted_multiple < $1
       RETURNING last_alerted_multiple`,
      [multiple],
    );
    if (advanced.length) {
      alert('worker_volume', `claude-cli subscription ingest: ${n} jobs today, crossed `
        + `${multiple * DAILY_ALERT_THRESHOLD} - check Claude Pro usage before this grows further. `
        + `Note: subscription limits are rolling-window, not calendar-day - a burst can hit a wall `
        + `well under this count, so "under threshold" is not "safe from rate limits."`);
    }
  }
}

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
      await logDailyVolume(pool);
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
    await logDailyVolume(pool);
  } finally {
    await pool.end();
  }
}

main().catch(e => { console.error('worker: fatal', e); process.exit(1); });
