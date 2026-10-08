// Email alerts: signup, double opt-in confirmation, one-click unsubscribe, and the privacy page.
//
// Off unless ALERTS_ENABLED=1 AND the privacy page has a data controller to name
// (PRIVACY_CONTROLLER_NAME, PRIVACY_CONTACT_EMAIL): collecting emails without saying who is
// responsible for them is not allowed under RGPD, so the box never shows without both.
//
// Confirm and unsubscribe links land on a page that submits a POST itself. Mail scanners
// prefetch GET links, and a GET that changed state would confirm (or cancel) on their behalf.
import { Router } from 'express';
import express from 'express';
import crypto from 'node:crypto';
import { db, uuid } from '../db.js';
import { BASE_URL, esc, pageShell } from '../seoUtils.js';
import { SECTIONS, cleanFilters, canonicalFilters, describeSubscription } from '../alerts/filters.js';
import { confirmationEmail } from '../alerts/emails.js';
import { getMailer } from '../alerts/mailer.js';

export const alertsRouter = Router();

export const CONSENT_VERSION = 'v1-2026-10';
export const CONSENT_TEXT = 'Te enviaremos solo estos avisos. Puedes darte de baja con un clic en cualquier correo.';
const SIGNUPS_PER_IP_PER_HOUR = Number(process.env.ALERT_SIGNUPS_PER_HOUR || 5);
const RESEND_CONFIRM_AFTER_MIN = 10;

export const alertsEnabled = () => process.env.ALERTS_ENABLED === '1'
  && !!process.env.PRIVACY_CONTROLLER_NAME && !!process.env.PRIVACY_CONTACT_EMAIL;

const token = () => crypto.randomBytes(24).toString('base64url');
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i;

// Which kind of page a signup came from (for the admin "signups by source" chart).
export function sourceType(p) {
  if (!p) return 'otra';
  const path = String(p).split('?')[0];
  if (path === '/' || path === '') return 'listado-subvenciones';
  if (/^\/licitaciones\/?$/.test(path)) return 'listado-licitaciones';
  if (/^\/negocios\/?$/.test(path)) return 'listado-negocios';
  if (/^\/subvenciones\/[^/]+-\d+\/?$/.test(path)) return 'detalle-subvencion';
  if (/^\/licitaciones\/[^/]+\/?$/.test(path)) return 'detalle-licitacion';
  if (/^\/(subvenciones|ayudas)\//.test(path)) return 'hub';
  return 'otra';
}

function overLimit(ip) {
  const hour = new Date().toISOString().slice(0, 13);
  db.prepare(`INSERT INTO alert_signup_attempt (ip, hour, count) VALUES (?, ?, 1)
              ON CONFLICT(ip, hour) DO UPDATE SET count = count + 1`).run(ip, hour);
  return db.prepare('SELECT count FROM alert_signup_attempt WHERE ip = ? AND hour = ?').get(ip, hour).count
    > SIGNUPS_PER_IP_PER_HOUR;
}

alertsRouter.get('/api/alertas/estado', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300').json({ enabled: alertsEnabled(), consent: CONSENT_TEXT });
});

// Same answer whatever happened (new, already subscribed, honeypot, resend): it must not tell a
// stranger whether an address is subscribed.
const OK = { ok: true, message: 'Te hemos enviado un correo. Pulsa el enlace para confirmar el aviso.' };

alertsRouter.post('/api/alertas', async (req, res) => {
  if (!alertsEnabled()) return res.status(404).json({ error: 'no disponible' });
  const b = req.body || {};
  if (overLimit(req.ip)) return res.status(429).json({ error: 'Demasiados intentos. Prueba dentro de una hora.' });
  if (b.website) return res.json(OK);                       // honeypot: bots fill every field
  const email = String(b.email || '').trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Revisa el correo: no parece válido.' });
  if (!SECTIONS.includes(b.section)) return res.status(400).json({ error: 'sección no válida' });
  if (b.consent !== true) return res.status(400).json({ error: 'Falta aceptar el aviso.' });
  const frequency = b.frequency === 'daily' ? 'daily' : 'weekly';
  const filters = canonicalFilters(cleanFilters(b.section, b.filters));
  const sourceUrl = String(b.source_url || '').startsWith('/') ? String(b.source_url).slice(0, 300) : null;

  let sub = db.prepare(`SELECT * FROM alert_subscription WHERE email = ? AND section = ? AND filters = ?
    AND status != 'unsubscribed' ORDER BY created_at DESC LIMIT 1`).get(email, b.section, filters);
  if (sub?.status === 'confirmed') {
    // Already active: just honour a frequency change, nothing to confirm again.
    if (sub.frequency !== frequency) db.prepare('UPDATE alert_subscription SET frequency = ? WHERE id = ?').run(frequency, sub.id);
    return res.json(OK);
  }
  if (sub) {
    const last = sub.confirm_sent_at ? Date.parse(sub.confirm_sent_at + 'Z') : 0;
    if (Date.now() - last < RESEND_CONFIRM_AFTER_MIN * 60000) return res.json(OK);
    db.prepare('UPDATE alert_subscription SET frequency = ? WHERE id = ?').run(frequency, sub.id);
    sub = { ...sub, frequency };
  } else {
    sub = {
      id: uuid(), email, section: b.section, filters, frequency,
      confirm_token: token(), unsubscribe_token: token(),
      consent_version: CONSENT_VERSION, source_url: sourceUrl, source_type: sourceType(sourceUrl),
    };
    db.prepare(`INSERT INTO alert_subscription (id, email, section, filters, frequency, status, confirm_token,
        unsubscribe_token, consent_at, consent_version, source_url, source_type)
      VALUES (@id, @email, @section, @filters, @frequency, 'pending', @confirm_token, @unsubscribe_token,
        datetime('now'), @consent_version, @source_url, @source_type)`).run(sub);
  }
  try {
    await getMailer().send({ to: email, ...confirmationEmail(sub) });
    db.prepare(`UPDATE alert_subscription SET confirm_sent_at = datetime('now') WHERE id = ?`).run(sub.id);
  } catch (e) {
    console.error(`alerts: confirmation mail failed: ${e.message}`);
    return res.status(502).json({ error: 'No hemos podido enviar el correo ahora. Prueba más tarde.' });
  }
  res.json(OK);
});

// ---- confirm / unsubscribe pages ----
const form = express.urlencoded({ extended: false, limit: '4kb' });

const page = (title, inner) => pageShell({
  title: `${title} | Plazo Abierto`, description: title, canonical: BASE_URL + '/', robots: 'noindex, nofollow',
  breadcrumbHtml: '<a href="/">Inicio</a>', bodyHtml: `<div class="card" style="max-width:560px">${inner}</div>`,
});

// A page that POSTs the token by itself (people with JS) or with one button (without).
const autoPost = (action, t, title, button) => page(title, `
  <h1 style="font-size:1.4rem">${esc(title)}</h1>
  <form method="post" action="${esc(action)}" id="f">
    <input type="hidden" name="t" value="${esc(t)}">
    <button class="btn" type="submit">${esc(button)}</button>
  </form>
  <script>document.getElementById('f').submit()</script>`);

alertsRouter.get('/alertas/confirmar', (req, res) => {
  res.send(autoPost('/alertas/confirmar', String(req.query.t || ''), 'Confirmando tu aviso…', 'Confirmar aviso'));
});

alertsRouter.post('/alertas/confirmar', form, (req, res) => {
  const t = String(req.body?.t || req.query.t || '');
  const sub = t && db.prepare('SELECT * FROM alert_subscription WHERE confirm_token = ?').get(t);
  if (!sub || sub.status === 'unsubscribed') {
    return res.status(404).send(page('Enlace no válido', '<h1 style="font-size:1.4rem">Este enlace ya no es válido</h1><p>Puedes pedir el aviso de nuevo desde cualquier página de Plazo Abierto.</p>'));
  }
  if (sub.status === 'pending') {
    db.prepare(`UPDATE alert_subscription SET status = 'confirmed', confirmed_at = datetime('now') WHERE id = ?`).run(sub.id);
  }
  const freq = sub.frequency === 'daily' ? 'cada mañana' : 'cada lunes';
  res.send(page('Aviso confirmado', `
    <h1 style="font-size:1.4rem">Listo, aviso confirmado</h1>
    <p>Te escribiremos ${freq} con las nuevas convocatorias de <strong>${esc(describeSubscription(sub.section, JSON.parse(sub.filters)))}</strong>. Si no hay novedades, no te escribimos.</p>
    <p><a class="btn ghost" href="/">Volver a Plazo Abierto</a></p>`));
});

alertsRouter.get('/alertas/baja', (req, res) => {
  res.send(autoPost('/alertas/baja', String(req.query.t || ''), 'Dándote de baja…', 'Darme de baja'));
});

// Also the RFC 8058 one-click target: mail clients POST "List-Unsubscribe=One-Click" to the URL
// from the header, which carries the token in the query string.
alertsRouter.post('/alertas/baja', form, (req, res) => {
  const t = String(req.body?.t || req.query.t || '');
  const sub = t && db.prepare('SELECT * FROM alert_subscription WHERE unsubscribe_token = ?').get(t);
  if (sub && sub.status !== 'unsubscribed') {
    db.prepare(`UPDATE alert_subscription SET status = 'unsubscribed', unsubscribed_at = datetime('now') WHERE id = ?`).run(sub.id);
  }
  if (req.body && req.body['List-Unsubscribe'] === 'One-Click') return res.status(200).send('ok');
  res.send(page('Baja confirmada', `
    <h1 style="font-size:1.4rem">Te has dado de baja</h1>
    <p>No te enviaremos más este aviso.</p>
    <p><a class="btn ghost" href="/">Volver a Plazo Abierto</a></p>`));
});

// ---- privacy page ----
alertsRouter.get('/privacidad', (req, res) => {
  const name = process.env.PRIVACY_CONTROLLER_NAME;
  const contact = process.env.PRIVACY_CONTACT_EMAIL;
  const who = name
    ? `<p><strong>${esc(name)}</strong>${process.env.PRIVACY_CONTROLLER_ID ? ` (${esc(process.env.PRIVACY_CONTROLLER_ID)})` : ''}. Contacto: <a href="mailto:${esc(contact)}">${esc(contact)}</a>.</p>`
    : '<p>Pendiente de publicar.</p>';
  res.send(pageShell({
    title: 'Política de privacidad | Plazo Abierto',
    description: 'Qué datos guarda Plazo Abierto, para qué y cómo borrarlos.',
    canonical: BASE_URL + '/privacidad',
    breadcrumbHtml: '<a href="/">Inicio</a> › <span>Privacidad</span>',
    bodyHtml: `<div class="card" style="max-width:720px">
  <h1 style="font-size:1.6rem">Política de privacidad</h1>
  <h3>Quién es responsable</h3>
  ${who}
  <h3>Avisos por correo</h3>
  <p>Si pides un aviso, guardamos tu correo, lo que quieres que te avisemos (la sección y los filtros de la página), con qué frecuencia, la fecha y la versión del texto que aceptaste y la página desde la que te apuntaste. Lo usamos solo para enviarte esos avisos.</p>
  <p>La base legal es tu consentimiento, que das al confirmar el correo. Puedes retirarlo cuando quieras con el enlace de baja de cualquier aviso.</p>
  <p>Los correos se envían con Brevo (Sendinblue SAS, Francia), que trata los datos solo por cuenta nuestra.</p>
  <p>Si no confirmas el aviso en 30 días, o 30 días después de darte de baja, borramos tu correo. Solo guardamos el recuento, sin datos personales.</p>
  <h3>Formulario de contacto</h3>
  <p>Si nos escribes, guardamos tu nombre, tu contacto y tu mensaje para responderte, durante un máximo de ${Number(process.env.CONTACT_RETENTION_DAYS || 365)} días.</p>
  <h3>Asistente</h3>
  <p>Las preguntas al asistente se envían a Anthropic para generar la respuesta. No guardamos el texto de las preguntas.</p>
  <h3>Dirección IP y cookies</h3>
  <p>Usamos tu dirección IP solo para frenar abusos (límites de envíos por hora o por día) y la borramos a los dos días. Si usas el formulario de contacto, se guarda con tu mensaje y se borra con él. No usamos cookies de publicidad ni de analítica. Solo hay una cookie técnica si entras con usuario y contraseña.</p>
  <h3>Tus derechos</h3>
  <p>Puedes pedir acceso, rectificación, supresión, oposición, limitación o portabilidad de tus datos escribiendo a ${contact ? `<a href="mailto:${esc(contact)}">${esc(contact)}</a>` : 'nuestro contacto'}. Si crees que no los tratamos bien, puedes reclamar ante la Agencia Española de Protección de Datos (<a href="https://www.aepd.es" target="_blank" rel="noopener">aepd.es</a>).</p>
</div>`,
  }));
});

// Nightly RGPD housekeeping (server.js): drop emails nobody confirmed, or that left, after 30
// days, keeping the anonymous row for the signup / confirmation-rate stats; forget rate-limit IPs.
export function pruneAlertData() {
  const anon = db.prepare(`UPDATE alert_subscription SET email = 'borrado-' || id
    WHERE email NOT LIKE 'borrado-%' AND (
      (status = 'pending' AND created_at < datetime('now', '-30 days')) OR
      (status = 'unsubscribed' AND unsubscribed_at < datetime('now', '-30 days')))`).run().changes;
  // Every per-IP rate-limit table (alerts, chat, login): two days is enough to enforce the limits.
  const cutoff = new Date(Date.now() - 2 * 86400000).toISOString();
  const ips = db.prepare('DELETE FROM alert_signup_attempt WHERE hour < ?').run(cutoff.slice(0, 13)).changes
    + db.prepare('DELETE FROM chat_usage WHERE day < ?').run(cutoff.slice(0, 10)).changes
    + db.prepare('DELETE FROM login_attempt WHERE hour < ?').run(cutoff.slice(0, 13)).changes;
  if (anon || ips) console.log(`alerts: anonymised ${anon} subscription(s), dropped ${ips} rate-limit row(s)`);
}
