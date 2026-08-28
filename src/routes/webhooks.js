// Inbound WhatsApp replies (Infobip). No session auth here - Infobip posts
// directly to this route, so a secret path segment stands in for it. Point
// Infobip's inbound webhook at:
//   https://plazoabierto.es/webhooks/whatsapp/<WHATSAPP_WEBHOOK_SECRET>
//
// POC scope: mark the matching notification's response so it's visible in
// the operator console. No forwarding to a municipality's own secretary yet
// - that's a deliberate v2, once there's a real contact channel for them.
import { Router } from 'express';
import { db } from '../db.js';
import { normalizePhoneE164 } from '../whatsapp.js';
import { alert } from '../ingest/bdns.js';

export const webhooksRouter = Router();

const YES_WORDS = ['si', 'sii', 'siii', 'vale', 'interesa', 'meinteresa', 'ok', 'claro'];
const NO_WORDS = ['no', 'nogracias', 'nolo', 'nointeresa'];

function classifyReply(text) {
  const norm = String(text || '').trim().toLowerCase()
    .replace(/\u00ed/gi, 'i') // accented i (\u00ed = i-acute) -> plain i, so s\u00ed matches si
    .replace(/[^a-z0-9]/g, '');
  if (!norm) return null;
  if (YES_WORDS.some((w) => norm === w || norm.startsWith(w))) return 'interesado';
  if (NO_WORDS.some((w) => norm === w || norm.startsWith(w))) return 'no';
  return null;
}

function handleInbound(r) {
  const fromRaw = r?.from;
  const text = r?.message?.text ?? '';
  if (!fromRaw) return;
  const fromE164 = normalizePhoneE164(fromRaw);
  if (!fromE164) return;
  const fromDigits = fromE164.replace(/\D/g, '');

  // entity.contact_phone isn't guaranteed to be stored in one format, so
  // normalize both sides rather than matching in SQL.
  const entities = db.prepare(`SELECT id, contact_phone FROM entity
    WHERE contact_channel = 'whatsapp' AND contact_phone IS NOT NULL AND active = 1`).all();
  const entity = entities.find((e) => normalizePhoneE164(e.contact_phone)?.replace(/\D/g, '') === fromDigits);
  if (!entity) {
    alert('whatsapp_inbound', `reply from unmatched number ${fromE164}: "${String(text).slice(0, 200)}"`);
    return;
  }

  const pending = db.prepare(`SELECT id FROM notification
    WHERE entity_id = ? AND channel = 'whatsapp' AND response = 'none'
    ORDER BY sent_at DESC LIMIT 1`).get(entity.id);
  if (!pending) {
    alert('whatsapp_inbound', `reply from ${fromE164} with no pending notification: "${String(text).slice(0, 200)}"`);
    return;
  }

  const verdict = classifyReply(text);
  if (!verdict) {
    alert('whatsapp_inbound', `unrecognized reply from ${fromE164}, needs a human look: "${String(text).slice(0, 200)}"`);
    return;
  }

  db.prepare(`UPDATE notification SET response = ?, responded_at = datetime('now') WHERE id = ?`)
    .run(verdict, pending.id);
}

webhooksRouter.post('/webhooks/whatsapp/:secret', (req, res) => {
  // Always 200 fast - Infobip retries on non-2xx, and inbound traffic must
  // never back up because our own matching logic threw.
  res.json({ ok: true });

  const expected = process.env.WHATSAPP_WEBHOOK_SECRET;
  if (!expected || req.params.secret !== expected) return;

  const results = req.body?.results;
  if (!Array.isArray(results)) return;
  for (const r of results) {
    try { handleInbound(r); }
    catch (e) { alert('whatsapp_inbound', `failed to process inbound message: ${e.message}`); }
  }
});
