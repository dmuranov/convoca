// Posts the social campaigns to every configured channel.
//
// Channels ("targets") come from config only:
//   Telegram  SOCIAL_TELEGRAM_ENABLED=1, TELEGRAM_BOT_TOKEN, TELEGRAM_CHANNEL_ID (national), and
//             optionally TELEGRAM_CHANNELS='[{"chat":"@plazoabierto_aragon","ccaa":"Aragón"}]' for
//             per-comunidad channels - a regional channel only gets its comunidad's items.
//   Bluesky   SOCIAL_BLUESKY_ENABLED=1, BLUESKY_HANDLE, BLUESKY_APP_PASSWORD (national).
// Each channel runs on its own: one failing never blocks the others. Items are recorded in
// social_post the moment their message is accepted, so a rerun never posts them again.
// DRY_RUN (src/dryRun.js) writes what would be posted to SOCIAL_OUTBOX_DIR instead.
import { mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { db, uuid } from '../db.js';
import { isDryRun, outboxDir } from '../dryRun.js';
import { alert } from '../ingest/bdns.js';
import { SECTIONS, candidates, selectFor, telegramMessage, blueskyThread } from './content.js';
import { telegramClient, blueskyClient, withRetry } from './clients.js';

const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));
const GAP_MS = { telegram: 1500, bluesky: 1000 };   // between messages: well under both rate limits

export function buildTargets(env = process.env) {
  const targets = [];
  if (env.SOCIAL_TELEGRAM_ENABLED === '1') {
    const chats = [];
    if (env.TELEGRAM_CHANNEL_ID) chats.push({ chat: env.TELEGRAM_CHANNEL_ID, ccaa: null });
    try { for (const c of JSON.parse(env.TELEGRAM_CHANNELS || '[]')) if (c?.chat) chats.push({ chat: String(c.chat), ccaa: c.ccaa || null }); }
    catch { console.error('social: TELEGRAM_CHANNELS is not valid JSON - ignored'); }
    for (const c of chats) targets.push({ platform: 'telegram', key: `telegram:${c.chat}`, chat: c.chat, ccaa: c.ccaa });
  }
  if (env.SOCIAL_BLUESKY_ENABLED === '1' && env.BLUESKY_HANDLE) {
    targets.push({ platform: 'bluesky', key: `bluesky:${env.BLUESKY_HANDLE}`, ccaa: null });
  }
  return targets;
}

// The sender for one target: real API clients, or the dry-run writer.
export function makeSender(target, { env = process.env, dryRun = isDryRun(), sleep = sleepMs } = {}) {
  if (dryRun) {
    return async (campaign, section, sel, onItem) => {
      const body = target.platform === 'telegram' ? telegramMessage(campaign, section, sel)
        : blueskyThread(campaign, section, sel).map((p, i) => `${i ? '  ↳ ' : ''}${p.text}`).join('\n\n');
      try {
        mkdirSync(outboxDir('social'), { recursive: true });
        appendFileSync(path.join(outboxDir('social'), `${new Date().toISOString().slice(0, 10)}-${campaign}.txt`),
          `===== ${target.key} · ${section} =====\n${body}\n\n`);
      } catch { /* the log line below is enough */ }
      console.log(`[social dry-run] ${target.key} ${campaign}/${section}: ${sel.items.length} item(s)`);
      sel.items.forEach((_, i) => onItem(i));
    };
  }
  if (target.platform === 'telegram') {
    const tg = telegramClient(env.TELEGRAM_BOT_TOKEN);
    return async (campaign, section, sel, onItem) => {
      await withRetry(() => tg.sendMessage(target.chat, telegramMessage(campaign, section, sel)), { sleep, label: target.key });
      sel.items.forEach((_, i) => onItem(i));
    };
  }
  const bs = blueskyClient({ identifier: env.BLUESKY_HANDLE, password: env.BLUESKY_APP_PASSWORD });
  return async (campaign, section, sel, onItem) => {
    await bs.postThread(blueskyThread(campaign, section, sel), { sleep, gapMs: GAP_MS.bluesky, onPosted: (i) => onItem(i - 1) });
  };
}

const postedFor = (target, campaign) => new Set(db.prepare(
  'SELECT item_kind, item_id FROM social_post WHERE target = ? AND campaign = ?').all(target, campaign)
  .map(r => `${r.item_kind}:${r.item_id}`));
const markPosted = db.prepare('INSERT OR IGNORE INTO social_post (target, campaign, item_kind, item_id) VALUES (?, ?, ?, ?)');
const logRun = db.prepare(`INSERT INTO social_run (id, target, campaign, posted, messages, dry_run, error)
  VALUES (?, ?, ?, ?, ?, ?, ?)`);

async function runTarget(target, campaign, cands, send, sleep, dryRun) {
  const sel = selectFor(target, campaign, cands, postedFor(target.key, campaign));
  let posted = 0, messages = 0;
  const errors = [];
  for (const section of SECTIONS) {
    const s = sel[section];
    if (!s.items.length) continue;
    try {
      if (messages) await sleep(GAP_MS[target.platform] || 1000);
      await send(campaign, section, s, (i) => {
        const item = s.items[i];
        if (!item) return;
        // A dry run never touches the posted log, or the real run would skip those items.
        if (dryRun || markPosted.run(target.key, campaign, item.kind, item.id).changes) posted++;
      });
      messages++;
    } catch (e) {
      errors.push(`${section}: ${e.message}`);   // keep going with the other sections
    }
  }
  return { posted, messages, error: errors.join(' | ') || null };
}

// campaign: 'new' | 'closing'. Returns one result per target.
export async function runSocial(campaign, { targets = buildTargets(), now = new Date(), senderFor, sleep = sleepMs, dryRun = isDryRun() } = {}) {
  if (!targets.length) { console.log(`social: ${campaign} - no channel enabled`); return []; }
  const cands = candidates(campaign, now);
  const results = await Promise.all(targets.map(async (t) => {
    try {
      const send = senderFor ? senderFor(t) : makeSender(t, { dryRun, sleep });
      return { target: t.key, ...(await runTarget(t, campaign, cands, send, sleep, dryRun)) };
    } catch (e) {
      return { target: t.key, posted: 0, messages: 0, error: e.message };
    }
  }));
  for (const r of results) {
    logRun.run(uuid(), r.target, campaign, r.posted, r.messages, dryRun ? 1 : 0, r.error);
    if (r.error) alert('social', `${r.target} ${campaign}: ${r.error}`);
  }
  console.log(`social: ${campaign} ${JSON.stringify(results)}`);
  return results;
}
