// One switch for every external send (email, Telegram, Bluesky): DRY_RUN=1 logs instead of
// sending. Unset, it is on everywhere except NODE_ENV=production.
import os from 'node:os';
import path from 'node:path';

export function isDryRun() {
  const v = process.env.DRY_RUN;
  if (v != null && v !== '') return v === '1' || v.toLowerCase() === 'true';
  return process.env.NODE_ENV !== 'production';
}

// Where dry-run output is written, so it can be inspected (MAIL_OUTBOX_DIR kept for email).
export const outboxDir = (kind = 'mail') =>
  (kind === 'mail' ? process.env.MAIL_OUTBOX_DIR : process.env.SOCIAL_OUTBOX_DIR)
  || path.join(os.tmpdir(), kind === 'mail' ? 'convoca-outbox' : 'convoca-social-outbox');
