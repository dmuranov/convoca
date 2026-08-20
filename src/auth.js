// Invite-only auth. Sessions are opaque random tokens in SQLite, httpOnly cookie.
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db, uuid } from './db.js';

const SESSION_DAYS = 30;
const INVITE_DAYS = 14;
const COOKIE = 'convoca_session';

const isoIn = (days) => new Date(Date.now() + days * 86400000).toISOString();

export function createInvite({ email, name, role = 'alcalde', municipality_id = null, entity_id = null }) {
  const token = randomBytes(24).toString('base64url');
  db.prepare(`INSERT INTO invite (token, email, name, role, municipality_id, entity_id, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(token, email, name || null, role, municipality_id, entity_id, isoIn(INVITE_DAYS));
  return token;
}

export function redeemInvite(token, password) {
  const inv = db.prepare(`SELECT * FROM invite WHERE token = ? AND used_at IS NULL AND expires_at > ?`)
    .get(token, new Date().toISOString());
  if (!inv) return null;
  if (!password || password.length < 8) throw new Error('password too short');
  const existing = db.prepare('SELECT id FROM user WHERE email = ?').get(inv.email);
  if (existing) throw new Error('user already exists');
  const id = uuid();
  db.prepare(`INSERT INTO user (id, email, password_hash, name, role, municipality_id, entity_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, inv.email, bcrypt.hashSync(password, 10), inv.name, inv.role, inv.municipality_id, inv.entity_id);
  db.prepare('UPDATE invite SET used_at = ? WHERE token = ?').run(new Date().toISOString(), token);
  return db.prepare('SELECT * FROM user WHERE id = ?').get(id);
}

// per-IP login throttle: 10 attempts per UTC hour
export function loginThrottled(ip) {
  const hour = new Date().toISOString().slice(0, 13);
  db.prepare(`INSERT INTO login_attempt (ip, hour, count) VALUES (?, ?, 1)
    ON CONFLICT(ip, hour) DO UPDATE SET count = count + 1`).run(ip, hour);
  return db.prepare('SELECT count FROM login_attempt WHERE ip = ? AND hour = ?').get(ip, hour).count > 10;
}

export function login(email, password) {
  const user = db.prepare('SELECT * FROM user WHERE email = ? AND active = 1').get(email || '');
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) return null;
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO session (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, user.id, isoIn(SESSION_DAYS));
  return { token, user };
}

export function logout(token) {
  if (token) db.prepare('DELETE FROM session WHERE token = ?').run(token);
}

export function sessionUser(req) {
  const token = (req.headers.cookie || '').split(';').map(s => s.trim())
    .find(s => s.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!token) return null;
  const row = db.prepare(`SELECT u.*, s.token AS session_token FROM session s
    JOIN user u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`)
    .get(token, new Date().toISOString());
  return row || null;
}

export function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

// middleware
export const requireAuth = (role) => (req, res, next) => {
  const user = sessionUser(req);
  if (!user) return res.status(401).json({ error: 'no autenticado' });
  if (role && user.role !== role) return res.status(403).json({ error: 'prohibido' });
  req.user = user;
  next();
};

// first-boot operator seeding: OPERATOR_EMAIL + OPERATOR_PASSWORD env vars
export function seedOperator() {
  const email = process.env.OPERATOR_EMAIL, pw = process.env.OPERATOR_PASSWORD;
  if (!email || !pw) return;
  if (db.prepare('SELECT 1 FROM user WHERE role = ?').get('operator')) return;
  db.prepare(`INSERT INTO user (id, email, password_hash, name, role) VALUES (?, ?, ?, 'Operador', 'operator')`)
    .run(uuid(), email, bcrypt.hashSync(pw, 10));
  console.log(`operator account created for ${email}`);
}
