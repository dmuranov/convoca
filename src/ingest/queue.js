// Postgres-backed job queue for the claude-cli enrichment worker (scripts/worker.js).
// Producer side only: one row per prepared grant/licitación. The playbook is just the
// extraction context — system prompt and json-schema are fixed per job_type and live in
// enrich.js / enrichLicitacion.js, applied by the worker via --system-prompt/--json-schema
// rather than baked into the stored prompt text.
import pg from 'pg';

const { Pool } = pg;

let pool;
function getPool() {
  if (!pool) {
    if (!process.env.CONVOCA_JOBS_DB_URL) throw new Error('CONVOCA_JOBS_DB_URL not set');
    pool = new pg.Pool({ connectionString: process.env.CONVOCA_JOBS_DB_URL });
  }
  return pool;
}

async function insertJobs(jobType, rows) {
  if (!rows.length) return { queued: 0 };
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    for (const r of rows) {
      await client.query(
        `INSERT INTO job (job_type, ref_id, playbook) VALUES ($1, $2, $3)`,
        [jobType, r.refId, r.context],
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  console.log(`queued ${rows.length} ${jobType} job(s)`);
  return { queued: rows.length };
}

// prepared: [{grantId, bdnsRef, context}] from enrich.js's prepareEnrichment().
export function enqueueJobs(prepared) {
  return insertJobs('enrich_grant', prepared.map(p => ({ refId: p.grantId, context: p.context })));
}

// prepared: [{id, expediente, context}] from enrichLicitacion.js's prepareEnrichment().
export function enqueueLicitacionJobs(prepared) {
  return insertJobs('enrich_licitacion', prepared.map(p => ({ refId: p.id, context: p.context })));
}
