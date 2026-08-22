import Anthropic from '@anthropic-ai/sdk';

export const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY from env

// Ingest extraction: reads legal PDFs, writes the summaries that ARE the product.
export const MODEL = process.env.CONVOCA_MODEL || 'claude-opus-5';

// Public chat: repeats stored text against a pre-filtered list — a much easier job, and
// the one exposed to unbounded traffic. Separate knob so it can be priced independently.
// NOTE: the cached system prefix is ~580 tokens, which clears Opus 5's 512-token cache
// minimum but NOT Sonnet 5's 1024 or Haiku 4.5's 4096 — on those the cache_control marker
// is silently ignored (no error, just no cache hits).
export const CHAT_MODEL = process.env.CONVOCA_CHAT_MODEL || 'claude-opus-5';
