import Anthropic from '@anthropic-ai/sdk';

// timeout: without one, a stalled request (seen in production - the licitaciones
// enrichBatch call hung with no error and no log line, silently zeroing out every poll run
// since nothing ever threw for the cron handler's catch to alert on) blocks forever instead
// of failing loud. 60s is generous for a single API call; the batch *processing* wait has
// its own much longer poll loop (enrich.js/enrichLicitacion.js's BATCH_TIMEOUT_MS) that
// this doesn't touch - this only bounds each individual HTTP request within it.
export const anthropic = new Anthropic({ timeout: 60_000 }); // reads ANTHROPIC_API_KEY from env

// Ingest extraction: schema-constrained JSON out of BDNS fields + bases text, one grant
// ever (see poll.js's dedupe) - not a job that needs Opus. Haiku, and batched (enrich.js
// enrichBatch / scripts/backfill-batch.js) since nothing in the nightly poll is waiting
// on the response.
export const MODEL = process.env.CONVOCA_MODEL || 'claude-haiku-4-5';

// Public chat: repeats stored text against a pre-filtered list — a much easier job, and
// the one exposed to unbounded traffic. Separate knob so it can be priced independently.
// NOTE: the cached system prefix is ~580 tokens, which clears Opus 5's 512-token cache
// minimum but NOT Sonnet 5's 1024 or Haiku 4.5's 4096 — on those the cache_control marker
// is silently ignored (no error, just no cache hits).
export const CHAT_MODEL = process.env.CONVOCA_CHAT_MODEL || 'claude-opus-5';
