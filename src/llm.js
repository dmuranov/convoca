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

// What a Batch API run of MODEL costs, so every ingest run logs real euros instead of a guess.
// USD per million tokens, Batch API (half the standard price); defaults are Haiku 4.5's.
const PRICE_IN = Number(process.env.BATCH_PRICE_IN_PER_M || 0.5);
const PRICE_OUT = Number(process.env.BATCH_PRICE_OUT_PER_M || 2.5);
export function usageMeter() {
  let input = 0, output = 0, n = 0;
  return {
    add(usage) {
      if (!usage) return;
      input += (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
      output += usage.output_tokens || 0;
      n++;
    },
    get usd() { return (input * PRICE_IN + output * PRICE_OUT) / 1e6; },
    line(label) {
      return `${label}: ${n} result(s), ${input} input + ${output} output tokens, cost $${this.usd.toFixed(3)}`
        + (n ? ` ($${(this.usd / n).toFixed(4)} each)` : '');
    },
  };
}

// Public chat: repeats stored text against a pre-filtered list — a much easier job, and
// the one exposed to unbounded traffic. Separate knob so it can be priced independently.
// NOTE: the cached system prefix is ~580 tokens, which clears Opus 5's 512-token cache
// minimum but NOT Sonnet 5's 1024 or Haiku 4.5's 4096 — on those the cache_control marker
// is silently ignored (no error, just no cache hits).
export const CHAT_MODEL = process.env.CONVOCA_CHAT_MODEL || 'claude-opus-5';
