import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';
import { db } from './src/db.js';
import { publicRouter, CONTACT_RETENTION_DAYS } from './src/routes/public.js';
import { panelRouter } from './src/routes/panel.js';
import { operatorRouter } from './src/routes/operator.js';
import { login, logout, loginThrottled, redeemInvite, sessionUser,
         setSessionCookie, clearSessionCookie, seedOperator } from './src/auth.js';
import { pollOnce } from './src/ingest/poll.js';
import { alert } from './src/ingest/bdns.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // behind Caddy
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
app.use(panelRouter);
app.use(operatorRouter);

// ---- pages ----
const web = (f) => path.join(__dirname, 'web', f);
app.get('/', (req, res) => res.sendFile(web('index.html')));
app.get('/entrar', (req, res) => res.sendFile(web('login.html')));
app.get('/registro', (req, res) => res.sendFile(web('registro.html')));
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

  const today = new Date().toISOString().slice(0, 10);
  const nowIso = new Date().toISOString();
  const closed = db.prepare(`
    UPDATE grant_row SET status = 'CLOSED', closed_at = ?
    WHERE status = 'OPEN' AND deadline_date IS NOT NULL AND deadline_date < ?
  `).run(nowIso, today);
  if (closed.changes) console.log(`closed ${closed.changes} grant(s) past their deadline`);

  const dayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
  const archived = db.prepare(`
    UPDATE grant_row SET archived_at = ?
    WHERE status = 'CLOSED' AND archived_at IS NULL AND closed_at IS NOT NULL AND closed_at < ?
  `).run(nowIso, dayAgo);
  if (archived.changes) console.log(`archived ${archived.changes} grant(s) closed >24h ago`);
});

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => console.log(`convoca listening on :${PORT}`));
