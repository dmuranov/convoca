// One-shot playbook worker: claims exactly one pending job from Postgres, spawns a fresh
// claude-cli process (subscription auth, not ANTHROPIC_API_KEY) to run it, writes the
// result into convoca's SQLite, marks the job done, and exits. Invoked repeatedly by
// convoca-worker.timer (see deploy/convoca-worker.*) — no loop, no persistent session.
//
// Fallback path as of 2026-09-02, not the live one - poll.js/pollLicitaciones.js enqueue
// nothing anymore, so this and convoca-worker.timer sit dormant (disabled, not deleted).
// The subscription's rate-limit budget is shared with any interactive Claude Code session
// on the same account - including a session actively debugging this worker, which is
// exactly what turned a backlog recovery into a 26-minute total outage on 2026-09-02 with
// the daily volume tripwire never firing (~273 attempts, still under its 300 threshold).
// enrich.js/enrichLicitacion.js's enrichBatch() (Anthropic Batch API, ANTHROPIC_API_KEY)
// is the live path now; this is kept the way enrichBatch used to be - in place, unused,
// as the reverse fallback. See convoca-claude-cli-prod-risk memory for the full history.
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
import { pingIndexNow } from '../src/indexnow.js';
import { BASE_URL, grantPath, licitacionPath } from '../src/seoUtils.js';

const execFileAsync = promisify(execFile);
const JOB_TIMEOUT_MS = Number(process.env.WORKER_JOB_TIMEOUT_MS || 5 * 60_000);
// Tripwire, not a documented Anthropic limit - a gradual climb in daily job volume is
// invisible without this; a threshold crossing in the log is not. 300/day is ~2-3x current
// combined grants+licitaciones volume. Fires again at every multiple (600, 900, ...) so
// growth past the first crossing keeps escalating instead of going quiet again.
const DAILY_ALERT_THRESHOLD = Number(process.env.WORKER_DAILY_ALERT_THRESHOLD || 300);
// "Is the queue currently failing" needs no volume math and no threshold calibration -
// N in a row erroring catches a rate-limit wall, a PLACSP/BDNS outage, a bad deploy, or a
// wedged DB, in under N * 20s, regardless of whether that day's total ever looks unusual.
// The 2026-09-02 blackout was trivially this shape and would have tripped it within two
// minutes; the daily counter above answers a different question and stayed silent.
const CONSECUTIVE_FAILURE_THRESHOLD = Number(process.env.WORKER_CONSECUTIVE_FAILURE_THRESHOLD || 5);

// Persisted (not in-memory) because each tick is a fresh process - state must survive
// across invocations to mean anything. Self-creating table: this script has no separate
// migration step, and the table existing is an implementation detail of this one check.
async function trackConsecutiveFailures(pool, succeeded) {
  await pool.query(`CREATE TABLE IF NOT EXISTS worker_state (key TEXT PRIMARY KEY, value INT NOT NULL DEFAULT 0)`);
  if (succeeded) {
    await pool.query(`INSERT INTO worker_state (key, value) VALUES ('consecutive_failures', 0)
      ON CONFLICT (key) DO UPDATE SET value = 0`);
    return;
  }
  const { rows } = await pool.query(`
    INSERT INTO worker_state (key, value) VALUES ('consecutive_failures', 1)
    ON CONFLICT (key) DO UPDATE SET value = worker_state.value + 1
    RETURNING value`);
  const n = rows[0].value;
  // Fires at 5, 10, 15... - once at the threshold, then re-escalates rather than going
  // quiet for the rest of a long outage, same shape as the volume tripwire's multiples.
  if (n % CONSECUTIVE_FAILURE_THRESHOLD === 0) {
    alert('worker_consecutive_failures', `${n} job(s) in a row have failed - the queue `
      + `itself is likely broken (rate limit, outage, bad deploy), not the individual jobs`);
  }
}

const JOB_TYPES = {
  enrich_grant: {
    systemPrompt: GRANT_SYSTEM,
    schema: ELIGIBILITY_SCHEMA,
    label: (refId) => db.prepare('SELECT bdns_ref FROM grant_row WHERE id = ?').get(refId)?.bdns_ref || refId,
    apply: (refId, label, ai) => applyGrantResult(refId, label, ai),
    // Queried fresh, after apply() has written the new AI fields - not a snapshot from
    // before the job ran, so a ping never fires ahead of the content it's announcing.
    pingUrl: (refId) => {
      const row = db.prepare('SELECT bdns_ref, plain_title, title, published FROM grant_row WHERE id = ?').get(refId);
      return row?.published ? BASE_URL + grantPath(row) : null;
    },
  },
  enrich_licitacion: {
    systemPrompt: LICITACION_SYSTEM,
    schema: LICITACION_SCHEMA,
    label: (refId) => db.prepare('SELECT expediente FROM licitacion_row WHERE id = ?').get(refId)?.expediente || refId,
    apply: (refId, label, ai) => applyLicitacionResult(label, ai),
    pingUrl: (refId) => {
      const row = db.prepare('SELECT id, titulo, expediente, published FROM licitacion_row WHERE id = ?').get(refId);
      return row?.published ? BASE_URL + licitacionPath(row) : null;
    },
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

// .env carries ANTHROPIC_API_KEY too (the deliberate enrichBatch()/enrichLicitacion.js
// fallback path - see convoca-claude-cli-prod-risk memory), and `dotenv/config` above
// loads it into this process's own env. claude-cli treats a present ANTHROPIC_API_KEY as
// taking precedence over the Pro subscription login - confirmed live (2026-09-02): every
// job was silently billing the API key instead of using the subscription this whole
// system exists to use for free, and once that key's balance hit zero every job started
// failing with "Credit balance is too low" instead of falling back to the login. Strip it
// from the child's env explicitly so this can't happen again regardless of what else ever
// ends up in .env.
const CLAUDE_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => k !== 'ANTHROPIC_API_KEY')
);

// Auth mode is observed, never assumed - stripping ANTHROPIC_API_KEY above is only a
// guess about *why* claude-cli would pick subscription auth, not proof it did. The 2026-
// 09-02 incident was exactly this: "the worker drained jobs autonomously" stayed true the
// whole time; "therefore it's using the subscription" was the unverified assumption
// sitting under it, invisible until the (unrelated) API key ran out of credit. claude-cli
// prints this exact line to stderr whenever ANY auth source other than the subscription
// login takes precedence - regardless of whether that source is our own env leaking back
// in, a different env var name, or a stored credential neither of us thought to check.
const API_KEY_AUTH_MARKER = /ANTHROPIC_API_KEY|another auth source.*takes precedence/i;

async function runPlaybook(job, cfg) {
  const { stdout, stderr } = await execFileAsync('claude', [
    '-p', job.playbook,
    '--model', MODEL,
    '--tools', '',
    '--system-prompt', cfg.systemPrompt,
    '--json-schema', JSON.stringify(cfg.schema),
    '--output-format', 'json',
    '--no-session-persistence',
  ], { timeout: JOB_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, env: CLAUDE_ENV });

  // Asymmetric on purpose: the marker's presence is positive proof (claude-cli printed
  // its own precedence warning), but its absence only means we didn't see that warning -
  // not proof the subscription was used. Say exactly that; "auth=subscription" here would
  // be the same shape of unverified claim this whole check exists to stop making.
  const usedApiKey = API_KEY_AUTH_MARKER.test(stderr || '');
  console.log(`worker: job ${job.id} auth=${usedApiKey ? 'API_KEY (confirmed)' : 'no API-key warning seen'}`);
  if (usedApiKey) {
    // Refuse the result outright rather than accepting a job that succeeded but billed
    // unexpectedly - a stopped worker is the right failure mode for silent billing, a
    // quietly-completed job is not. main() recognizes .authLeak and exits(1) so this
    // surfaces as a systemd failure, not just another per-job error.
    const err = new Error(`claude-cli used non-subscription auth for job ${job.id} - stderr: ${(stderr || '').slice(0, 500)}`);
    err.authLeak = true;
    throw err;
  }

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
      await trackConsecutiveFailures(pool, true);
      // Ping only after the fresh content is actually committed (§6: "en cada alta o
      // cambio de estado") - pinging any earlier tells crawlers to arrive before there's
      // anything new to see, wasting IndexNow's fast-crawl window on stale content.
      const pingUrl = cfg.pingUrl(job.ref_id);
      if (pingUrl) pingIndexNow(pingUrl);
    } catch (e) {
      await pool.query(
        `UPDATE job SET status = 'error', error = $2, updated_at = now() WHERE id = $1`,
        [job.id, e.message],
      );
      await trackConsecutiveFailures(pool, false);
      if (e.authLeak) {
        // Distinct, impossible-to-miss alert - not folded into the generic 'extract'
        // channel, which is expected to have occasional benign entries (a bad PDF, a
        // thin object) that this must never blend into. Re-fires every 20s until fixed,
        // by design: the failure mode this replaces was silent, so noisy is correct here.
        alert('worker_auth_leak', `job ${job.id} ${label}: ${e.message}`);
        console.error(`worker: AUTH LEAK - job ${job.id} (${label}): ${e.message}`);
        await logDailyVolume(pool);
        await pool.end();
        process.exit(1);
      }
      alert('extract', `job ${job.id} ${label}: ${e.message}`);
      console.error(`worker: job ${job.id} (${label}) failed: ${e.message}`);
    }
    await logDailyVolume(pool);
  } finally {
    await pool.end();
  }
}

main().catch(e => { console.error('worker: fatal', e); process.exit(1); });
