import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';
import { db } from './src/db.js';
import { publicRouter, CONTACT_RETENTION_DAYS } from './src/routes/public.js';
import { panelRouter } from './src/routes/panel.js';
import { operatorRouter } from './src/routes/operator.js';
import { webhooksRouter } from './src/routes/webhooks.js';
import { seoRouter } from './src/routes/seo.js';
import { seoHubsRouter } from './src/routes/seoHubs.js';
import { seoLicitacionesRouter } from './src/routes/seoLicitaciones.js';
import { sitemapRouter } from './src/routes/sitemap.js';
import { pingIndexNow } from './src/indexnow.js';
import { grantPath, BASE_URL } from './src/seoUtils.js';
import { login, logout, loginThrottled, redeemInvite, sessionUser,
         setSessionCookie, clearSessionCookie, seedOperator } from './src/auth.js';
import { pollOnce } from './src/ingest/poll.js';
import { ESTIMATE_GRACE_DAYS } from './src/ingest/enrich.js';
import { pollLicitacionesOnce, drainStrandedLicitaciones } from './src/ingest/pollLicitaciones.js';
import { alert } from './src/ingest/bdns.js';
import { alertsRouter, alertsEnabled, pruneAlertData } from './src/routes/alerts.js';
import { runDigests } from './src/alerts/digest.js';
import { runSocial } from './src/social/run.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // behind Caddy

// One public address: www.plazoabierto.es answered with the whole site (Caddy serves both
// names), so every page existed twice for Google. Send www to the bare domain, keeping the
// path and query, with a permanent redirect.
app.use((req, res, next) => {
  const host = String(req.headers.host || '').toLowerCase();
  if (host.startsWith('www.')) return res.redirect(301, `https://${host.slice(4)}${req.originalUrl}`);
  next();
});
app.use(express.json({ limit: '64kb' }));

seedOperator();

// ---- auth endpoints ----
app.post('/api/login', (req, res) => {
  const ip = req.ip || '?';
  if (loginThrottled(ip)) return res.status(429).json({ error: 'demasiados intentos, espera una hora' });
  const { email, password } = req.body || {};
  const result = login(email, password);
  if (!result) return res.status(401).json({ error: 'credenciales incorrectas' });
  setSessionCookie(res, result.token);
  res.json({ ok: true, role: result.user.role });
});

app.post('/api/logout', (req, res) => {
  const user = sessionUser(req);
  logout(user?.session_token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.post('/api/register', (req, res) => {
  const { token, password } = req.body || {};
  try {
    const user = redeemInvite(token, password);
    if (!user) return res.status(400).json({ error: 'invitación no válida o caducada' });
    const s = login(user.email, password);
    setSessionCookie(res, s.token);
    res.json({ ok: true, role: user.role });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/invite/:token', (req, res) => {
  const inv = db.prepare(`SELECT i.email, i.name, m.name AS municipality FROM invite i
    LEFT JOIN municipality m ON m.id = i.municipality_id
    WHERE i.token = ? AND i.used_at IS NULL AND i.expires_at > ?`)
    .get(req.params.token, new Date().toISOString());
  if (!inv) return res.status(404).json({ error: 'invitación no válida o caducada' });
  res.json(inv);
});

// ---- routers ----
app.use(publicRouter);
app.use(alertsRouter);
app.use(panelRouter);
app.use(operatorRouter);
app.use(webhooksRouter);
app.use(seoRouter);
app.use(seoHubsRouter);
app.use(seoLicitacionesRouter);
app.use(sitemapRouter);

// robots.txt (plan §0/§6) - low-SEO-value paths disallowed to conserve a new domain's
// small crawl budget; everything under /subvenciones/ and /ayudas/ (the pages worth
// crawling) stays allowed by the default-allow.
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send([
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    'Disallow: /panel',
    'Disallow: /entrar',
    'Disallow: /registro',
    'Disallow: /webhooks/',
    '',
    `Sitemap: ${process.env.BASE_URL || 'https://plazoabierto.es'}/sitemap_index.xml`,
    '',
  ].join('\n'));
});

// IndexNow key verification file (src/indexnow.js) - only registered when a key is
// actually configured, so a bare-env deploy doesn't serve a 200 for "undefined.txt".
if (process.env.INDEXNOW_KEY) {
  app.get(`/${process.env.INDEXNOW_KEY}.txt`, (req, res) => res.type('text/plain').send(process.env.INDEXNOW_KEY));
}

// ---- pages ----
const web = (f) => path.join(__dirname, 'web', f);
app.get('/', (req, res) => res.sendFile(web('index.html')));
app.get('/entrar', (req, res) => res.sendFile(web('login.html')));
app.get('/registro', (req, res) => res.sendFile(web('registro.html')));
app.get('/licitaciones', (req, res) => res.sendFile(web('licitaciones.html')));
app.get('/negocios', (req, res) => res.sendFile(web('negocios.html')));
app.get('/panel', (req, res) => {
  const u = sessionUser(req);
  if (!u) return res.redirect('/entrar');
  res.sendFile(web(u.role === 'operator' ? 'operator/index.html' : 'panel/index.html'));
});
app.use(express.static(path.join(__dirname, 'web')));

// ---- daily poll (07:00 Europe/Madrid) ----
if (process.env.NODE_ENV === 'production') {
  cron.schedule('0 7 * * *', async () => {
    try { await pollOnce(); }
    catch (e) { alert('poll', e.message); }
  }, { timezone: 'Europe/Madrid' });

  // Staggered 30min after the BDNS poll rather than run concurrently - both hit the
  // Anthropic Batch API and there's no reason to make them contend for the same window.
  cron.schedule('30 7 * * *', async () => {
    try { await pollLicitacionesOnce(); }
    catch (e) { alert('placsp_poll', e.message); }
    // Separate try/catch: a poll failure must not also skip the backlog drain, and vice
    // versa - see 2026-09-01's stranded-row incident (pollLicitaciones.js's isCurrent).
    try { await drainStrandedLicitaciones(); }
    catch (e) { alert('placsp_backlog', e.message); }
  }, { timezone: 'Europe/Madrid' });

  // ---- email-alert digests (src/alerts/digest.js) ----
  // Daily subscribers every morning at 08:00; weekly ones on Monday at 08:00. Both match on
  // items published since the subscription was confirmed, so the publish step decides "new".
  cron.schedule('0 8 * * *', async () => {
    if (!alertsEnabled()) return;
    try { await runDigests('daily'); } catch (e) { alert('alerts', `daily digests: ${e.message}`); }
  }, { timezone: 'Europe/Madrid' });
  cron.schedule('0 8 * * 1', async () => {
    if (!alertsEnabled()) return;
    try { await runDigests('weekly'); } catch (e) { alert('alerts', `weekly digests: ${e.message}`); }
  }, { timezone: 'Europe/Madrid' });

  // ---- social channels (src/social/run.js) ----
  // "Nuevas hoy" in the evening, after the day's publishing; "Cierran en los próximos 7 días"
  // on Monday morning. Each channel has its own on/off flag; with none on, these do nothing.
  cron.schedule('0 19 * * *', async () => {
    try { await runSocial('new'); } catch (e) { alert('social', `new: ${e.message}`); }
  }, { timezone: 'Europe/Madrid' });
  cron.schedule('0 9 * * 1', async () => {
    try { await runSocial('closing'); } catch (e) { alert('social', `closing: ${e.message}`); }
  }, { timezone: 'Europe/Madrid' });
}

// prune expired sessions daily, enforce the contact-form retention rule promised under
// the form itself, close grants whose deadline has passed, and archive grants that have
// sat CLOSED for >24h. Nothing here is deleted except sessions/contact_message per their
// own retention rules - closed/archived grants keep all their data, only status/timestamps
// change, since the public list already hides anything that isn't status='OPEN'.
cron.schedule('30 4 * * *', () => {
  db.prepare('DELETE FROM session WHERE expires_at < ?').run(new Date().toISOString());
  const cutoff = new Date(Date.now() - CONTACT_RETENTION_DAYS * 86400_000)
    .toISOString().slice(0, 19).replace('T', ' ');
  const { changes } = db.prepare('DELETE FROM contact_message WHERE received_at < ?').run(cutoff);
  if (changes) console.log(`pruned ${changes} contact message(s) older than ${CONTACT_RETENTION_DAYS} days`);
  // Alert emails nobody confirmed / that left, and every rate-limit IP (privacy page promises both).
  try { pruneAlertData(); } catch (e) { alert('alerts', `prune: ${e.message}`); }

  const today = new Date().toISOString().slice(0, 10);
  const nowIso = new Date().toISOString();
  // Read the about-to-close published grants first (only those have an indexable ficha
  // worth telling IndexNow about - see plan §6 "en cada cambio de estado").
  // Estimated deadlines (computed, unconfirmed) get ESTIMATE_GRACE_DAYS before closing: they
  // count from BDNS registration, but the period starts at bulletin publication (enrich.js).
  const graceCutoff = new Date(Date.now() - ESTIMATE_GRACE_DAYS * 86400000).toISOString().slice(0, 10);
  const pastDeadline = `status = 'OPEN' AND deadline_date IS NOT NULL AND (CASE
      WHEN deadline_source = 'computed' AND deadline_confirmed = 0 THEN deadline_date < @grace
      ELSE deadline_date < @today END)`;
  const closingSoon = db.prepare(`
    SELECT bdns_ref, plain_title, title FROM grant_row WHERE published = 1 AND ${pastDeadline}
  `).all({ today, grace: graceCutoff });
  const closed = db.prepare(`
    UPDATE grant_row SET status = 'CLOSED', closed_at = @now WHERE ${pastDeadline}
  `).run({ now: nowIso, today, grace: graceCutoff });
  if (closed.changes) console.log(`closed ${closed.changes} grant(s) past their deadline`);
  if (closingSoon.length) pingIndexNow(closingSoon.map(g => BASE_URL + grantPath(g)));

  const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
  const archived = db.prepare(`
    UPDATE grant_row SET archived_at = ?
    WHERE status = 'CLOSED' AND archived_at IS NULL AND closed_at IS NOT NULL AND closed_at < ?
  `).run(nowIso, dayAgo);
  if (archived.changes) console.log(`archived ${archived.changes} grant(s) closed >24h ago`);
});

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => console.log(`convoca listening on :${PORT}`));
