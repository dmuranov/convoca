// Alcalde-facing API. Everything is scoped to req.user.municipality_id.
import { Router } from 'express';
import { db, uuid } from '../db.js';
import { requireAuth } from '../auth.js';

export const panelRouter = Router();
panelRouter.use('/api/panel', requireAuth('alcalde'));

// Grants surfaced to this municipality = notifications created by the operator.
panelRouter.get('/api/panel/grants', (req, res) => {
  const rows = db.prepare(`
    SELECT n.id AS notification_id, n.response, n.sent_at,
           g.title, g.ai_summary, g.amount_max, g.budget_total, g.source_url, g.application_url,
           CASE WHEN g.deadline_source = 'api' OR g.deadline_confirmed = 1
                THEN g.deadline_date ELSE NULL END AS deadline,
           g.is_rolling, e.name AS entity_name
    FROM notification n
    JOIN grant_row g ON g.id = n.grant_id
    JOIN entity e ON e.id = n.entity_id
    WHERE e.municipality_id = ? AND g.published = 1
    ORDER BY n.sent_at DESC`).all(req.user.municipality_id);
  res.json(rows);
});

panelRouter.post('/api/panel/grants/:notificationId/respond', (req, res) => {
  const { response } = req.body || {};
  if (!['interesado', 'no'].includes(response)) return res.status(400).json({ error: 'respuesta inválida' });
  const r = db.prepare(`
    UPDATE notification SET response = ?, responded_at = datetime('now')
    WHERE id = ? AND entity_id IN (SELECT id FROM entity WHERE municipality_id = ?)`)
    .run(response, req.params.notificationId, req.user.municipality_id);
  if (!r.changes) return res.status(404).json({ error: 'no encontrado' });
  res.json({ ok: true });
});

// The demand signal: "necesito..." — verbatim, timestamped by the DB, never edited.
panelRouter.post('/api/panel/requests', (req, res) => {
  const { text, consent } = req.body || {};
  if (typeof text !== 'string' || !text.trim() || text.length > 4000) {
    return res.status(400).json({ error: 'texto inválido' });
  }
  const entity = req.user.entity_id
    || db.prepare(`SELECT id FROM entity WHERE municipality_id = ? AND type = 'Ayuntamiento'`)
      .get(req.user.municipality_id)?.id || null;
  const id = uuid();
  db.prepare(`INSERT INTO request (id, entity_id, municipality_id, channel, raw_text, consent_upstream)
    VALUES (?, ?, ?, 'web', ?, ?)`)
    .run(id, entity, req.user.municipality_id, text.trim(), consent ? 1 : 0);
  res.json({ ok: true, id });
});

panelRouter.get('/api/panel/requests', (req, res) => {
  const rows = db.prepare(`
    SELECT id, received_at, raw_text, category, status
    FROM request WHERE municipality_id = ? ORDER BY received_at DESC`)
    .all(req.user.municipality_id);
  res.json(rows);
});

panelRouter.get('/api/panel/me', (req, res) => {
  const muni = db.prepare('SELECT name FROM municipality WHERE id = ?').get(req.user.municipality_id);
  res.json({ name: req.user.name, email: req.user.email, municipality: muni?.name || null });
});
