// Outbound email behind one tiny interface, so the provider can be swapped (Brevo today,
// SES later) without touching the alert code:
//
//   const mailer = getMailer();
//   await mailer.send({ to, subject, html, text, headers }) -> { id }
//
// DRY_RUN=1 logs instead of sending and writes each message to MAIL_OUTBOX_DIR (default: the
// OS temp dir) as .html, so confirmation links can be clicked while testing. Outside
// production, dry run is the default; production sends only when DRY_RUN is unset or 0.
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function isDryRun() {
  const v = process.env.DRY_RUN;
  if (v != null && v !== '') return v === '1' || v.toLowerCase() === 'true';
  return process.env.NODE_ENV !== 'production';
}

export const sender = () => ({
  email: process.env.MAIL_FROM_EMAIL || 'alertas@plazoabierto.es',
  name: process.env.MAIL_FROM_NAME || 'Plazo Abierto',
});

const OUTBOX = () => process.env.MAIL_OUTBOX_DIR || path.join(os.tmpdir(), 'convoca-outbox');

const dryRunMailer = {
  name: 'dry-run',
  async send({ to, subject, html, text, headers = {} }) {
    const id = `dry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      mkdirSync(OUTBOX(), { recursive: true });
      const file = path.join(OUTBOX(), `${id}.html`);
      const meta = `<!--\nTo: ${to}\nSubject: ${subject}\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n')}\n-->\n`;
      writeFileSync(file, meta + html);
      console.log(`[mail dry-run] to=${to} subject="${subject}" -> ${file}`);
    } catch (e) {
      console.log(`[mail dry-run] to=${to} subject="${subject}" (outbox write failed: ${e.message})\n${text}`);
    }
    return { id };
  },
};

// Brevo transactional API: https://developers.brevo.com/reference/sendtransacemail
const brevoMailer = {
  name: 'brevo',
  async send({ to, subject, html, text, headers = {} }) {
    const key = process.env.BREVO_API_KEY;
    if (!key) throw new Error('BREVO_API_KEY is not set');
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ sender: sender(), to: [{ email: to }], subject, htmlContent: html, textContent: text, headers }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Brevo HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j = await res.json().catch(() => ({}));
    return { id: j.messageId || null };
  },
};

const PROVIDERS = { brevo: brevoMailer };

export function getMailer() {
  if (isDryRun()) return dryRunMailer;
  const p = PROVIDERS[(process.env.MAIL_PROVIDER || 'brevo').toLowerCase()];
  if (!p) throw new Error(`unknown MAIL_PROVIDER ${process.env.MAIL_PROVIDER}`);
  return p;
}
