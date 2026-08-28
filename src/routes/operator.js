// Operator console API — the only screen in V1 (spec §5.4).
import { Router } from 'express';
import { db, uuid } from '../db.js';
import { requireAuth, createInvite } from '../auth.js';
import { candidateEntities } from '../ingest/match.js';
import { pollOnce } from '../ingest/poll.js';
import { sendWhatsAppTemplate } from '../whatsapp.js';
import { alert } from '../ingest/bdns.js';

export const operatorRouter = Router();
operatorRouter.use('/api/op', requireAuth('operator'));

// ---- convocatoria queue ----
operatorRouter.get('/api/op/grants', (req, res) => {
  // Screened-out rows (skip_reason set) are never part of the review workflow: the poller
  // rejected them as not-applicable and they can never be published. Spain-wide they are
  // ~80% of the table, so leaving them in buried the real queue. `?q=skipped` can still
  // inspect them when auditing the gate.
  const where = req.query.q === 'skipped'
    ? 'WHERE g.skip_reason IS NOT NULL'
    : req.query.q === 'pending'
      ? 'WHERE g.skip_reason IS NULL AND g.published = 0'
      : 'WHERE g.skip_reason IS NULL';
  const rows = db.prepare(`
    SELECT g.*, e.entity_types, e.funds_what, e.territory_scope, e.pop_min, e.pop_max
    FROM grant_row g LEFT JOIN grant_eligibility e ON e.grant_id = g.id
    ${where} ORDER BY g.created_at DESC LIMIT 500`).all();
  res.json(rows);
});

operatorRouter.get('/api/op/grants/:id/candidates', (req, res) => {
  res.json(candidateEntities(req.params.id));
});

// Confirm/fix deadline. Manual date entry always allowed; confirming a computed one flips the flag.
operatorRouter.post('/api/op/grants/:id/deadline', (req, res) => {
  const { deadline_date, action } = req.body || {};
  if (action === 'confirm') {
    db.prepare(`UPDATE grant_row SET deadline_confirmed = 1 WHERE id = ?`).run(req.params.id);
  } else if (deadline_date && /^\d{4}-\d{2}-\d{2}$/.test(deadline_date)) {
    db.prepare(`UPDATE grant_row SET deadline_date = ?, deadline_source = 'manual', deadline_confirmed = 1 WHERE id = ?`)
      .run(deadline_date, req.params.id);
  } else return res.status(400).json({ error: 'fecha inválida' });
  res.json({ ok: true });
});

operatorRouter.post('/api/op/grants/:id/publish', (req, res) => {
  const g = db.prepare('SELECT deadline_date, deadline_source, deadline_confirmed, is_rolling FROM grant_row WHERE id = ?')
    .get(req.params.id);
  if (!g) return res.status(404).json({ error: 'no encontrado' });
  // Computed, unconfirmed deadlines no longer block publishing: they go out
  // marked estimated (*) with a disclaimer on every surface. Confirming in the
  // panel upgrades them to a firm date.
  const warning = g.deadline_date && g.deadline_source === 'computed' && !g.deadline_confirmed
    ? 'plazo calculado sin confirmar — se publicará como fecha estimada (*)' : null;
  db.prepare(`UPDATE grant_row SET published = ?, status = CASE WHEN ? = 1 AND status = 'ANNOUNCED' THEN 'OPEN' ELSE status END WHERE id = ?`)
    .run(req.body?.published ? 1 : 0, req.body?.published ? 1 : 0, req.params.id);
  res.json({ ok: true, warning });
});

// Bulk publish. Spain-wide the queue runs ~200/week, which is past what anyone
// reviews one card at a time; this publishes an explicit list of ids in one go.
// Still operator-initiated and still reversible — the poller never publishes.
operatorRouter.post('/api/op/grants/publish-batch', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(x => typeof x === 'string') : null;
  if (!ids?.length) return res.status(400).json({ error: 'faltan ids' });
  if (ids.length > 500) return res.status(400).json({ error: 'máximo 500 por lote' });

  const publish = db.prepare(`UPDATE grant_row
      SET published = 1, status = CASE WHEN status = 'ANNOUNCED' THEN 'OPEN' ELSE status END
    WHERE id = ? AND ai_summary IS NOT NULL AND status IN ('OPEN','ANNOUNCED')`);
  const run = db.transaction((list) => list.reduce((n, id) => n + publish.run(id).changes, 0));
  const published = run(ids);

  const estimated = db.prepare(`SELECT COUNT(*) c FROM grant_row
    WHERE published = 1 AND deadline_source = 'computed' AND deadline_confirmed = 0`).get().c;
  res.json({ ok: true, published, skipped: ids.length - published, estimated_deadlines: estimated });
});

// Builds the "papers needed" line from plain_checklist. Empty/missing checklist
// (bases didn't detail documentation) reads as "sin requisitos detallados en
// las bases" rather than an empty or misleading placeholder.
function checklistText(grant) {
  let items = [];
  try { items = JSON.parse(grant.plain_checklist || '[]'); } catch { /* leave empty */ }
  return Array.isArray(items) && items.length ? items.join(', ') : 'sin requisitos detallados en las bases';
}

function paraQue(grant) {
  try { return JSON.parse(grant.plain_explainer || '{}')?.para_que || grant.title; }
  catch { return grant.title; }
}

// Surface a grant to an entity => notification row, and either an actual
// WhatsApp send (once INFOBIP_FROM + a template name are configured) or the
// same manual copy-paste draft this shipped with in V1, as a fallback while
// that's still pending approval.
operatorRouter.post('/api/op/grants/:id/notify', async (req, res) => {
  const { entity_id, channel } = req.body || {};
  if (!['whatsapp', 'email', 'web'].includes(channel)) return res.status(400).json({ error: 'canal inválido' });
  const g = db.prepare(`SELECT g.*,
      CASE WHEN g.deadline_source='api' OR g.deadline_confirmed=1 THEN g.deadline_date END AS ok_deadline,
      CASE WHEN g.deadline_source='computed' AND g.deadline_confirmed=0 THEN g.deadline_date END AS est_deadline
    FROM grant_row g WHERE g.id = ?`).get(req.params.id);
  const e = db.prepare(`SELECT e.*, m.name AS muni FROM entity e JOIN municipality m ON m.id = e.municipality_id WHERE e.id = ?`).get(entity_id);
  if (!g || !e) return res.status(404).json({ error: 'no encontrado' });
  if (!g.published) return res.status(409).json({ error: 'publica la convocatoria antes de notificar' });
  db.prepare(`INSERT INTO notification (id, grant_id, entity_id, channel) VALUES (?, ?, ?, ?)`)
    .run(uuid(), req.params.id, entity_id, channel);
  const plazo = g.ok_deadline ? `hasta ${g.ok_deadline}`
    : g.est_deadline ? `hasta ${g.est_deadline} aprox. (fecha estimada, confírmala en las bases)`
    : 'plazo por confirmar';
  const cuantia = g.amount_max ? `hasta ${g.amount_max.toLocaleString('es-ES')}€` : (g.budget_total ? `bolsa de ${g.budget_total.toLocaleString('es-ES')}€` : 's/cuantía');
  const titulo = g.plain_title || g.title;
  const explicacion = paraQue(g);
  const checklist = checklistText(g);

  if (channel === 'whatsapp') {
    const template = process.env.INFOBIP_WHATSAPP_TEMPLATE_GRANT;
    if (template && e.contact_phone) {
      const result = await sendWhatsAppTemplate({
        toPhone: e.contact_phone,
        templateName: template,
        placeholders: [titulo, explicacion, checklist],
      });
      if (!result.ok) alert('whatsapp_send', `notify grant ${g.id} -> entity ${e.id} failed: ${result.error || result.status}`);
      return res.json({
        ok: true,
        whatsapp_sent: result.ok,
        whatsapp_error: result.ok ? null : (result.error || `HTTP ${result.status}`),
        whatsapp_draft: `${titulo}\n\n${explicacion}\n\nPapeles: ${checklist}\n\n¿Te interesa? Responde SÍ o NO.`,
      });
    }
    // Not configured yet (no template approved, or no phone on file) - same
    // manual-copy fallback as before, just built from the plain-language
    // fields instead of the raw AI summary.
    return res.json({
      ok: true,
      whatsapp_sent: false,
      whatsapp_draft: `${titulo}\n\n${explicacion}\n\nPapeles: ${checklist}\n\n¿Te interesa? Responde SÍ o NO.`,
    });
  }

  res.json({
    ok: true,
    email_subject: `${e.muni} · ${g.category || 'subvención'} · ${cuantia} · ${plazo}`,
    email_body: `${g.ai_summary || g.title}\n\nMás información: ${g.source_url || ''}\n\n¿Interesa presentarla? Respóndeme a este correo con sí o no.`,
  });
});

// Recent notifications with their reply status, for the "Respuestas" panel -
// the whole point of the inbound webhook (src/routes/webhooks.js): an
// alcalde's WhatsApp reply has to be visible somewhere.
operatorRouter.get('/api/op/notifications', (req, res) => {
  res.json(db.prepare(`
    SELECT n.id, n.channel, n.response, n.sent_at, n.responded_at,
           COALESCE(g.plain_title, g.title) AS grant_title,
           e.name AS entity_name, m.name AS municipality
    FROM notification n
    JOIN grant_row g ON g.id = n.grant_id
    JOIN entity e ON e.id = n.entity_id
    JOIN municipality m ON m.id = e.municipality_id
    ORDER BY n.sent_at DESC LIMIT 200`).all());
});

// ---- requests queue (demand signal) ----
operatorRouter.get('/api/op/requests', (req, res) => {
  res.json(db.prepare(`
    SELECT r.*, m.name AS municipality_name, e.name AS entity_name
    FROM request r JOIN municipality m ON m.id = r.municipality_id
    LEFT JOIN entity e ON e.id = r.entity_id
    ORDER BY r.received_at DESC`).all());
});

operatorRouter.post('/api/op/requests/:id/categorize', (req, res) => {
  const { category, subcategory, asset_type, est_amount, status, matched_grant_id } = req.body || {};
  if (status && !['open', 'matched', 'applied', 'funded', 'no_fit'].includes(status)) {
    return res.status(400).json({ error: 'estado inválido' });
  }
  const r = db.prepare(`UPDATE request SET
      category = COALESCE(?, category), subcategory = COALESCE(?, subcategory),
      asset_type = COALESCE(?, asset_type), est_amount = COALESCE(?, est_amount),
      status = COALESCE(?, status), matched_grant_id = COALESCE(?, matched_grant_id)
    WHERE id = ?`)
    .run(category ?? null, subcategory ?? null, asset_type ?? null, est_amount ?? null,
      status ?? null, matched_grant_id ?? null, req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'no encontrado' });
  res.json({ ok: true });
});

// ---- applications (outcome tracking) ----
operatorRouter.post('/api/op/applications', (req, res) => {
  const { grant_id, entity_id } = req.body || {};
  if (!grant_id || !entity_id) return res.status(400).json({ error: 'faltan campos' });
  const id = uuid();
  db.prepare(`INSERT INTO application (id, grant_id, entity_id) VALUES (?, ?, ?)`).run(id, grant_id, entity_id);
  res.json({ ok: true, id });
});

operatorRouter.post('/api/op/applications/:id/outcome', (req, res) => {
  const { outcome, amount_awarded, attributable } = req.body || {};
  if (!['pending', 'awarded', 'rejected'].includes(outcome)) return res.status(400).json({ error: 'outcome inválido' });
  db.prepare(`UPDATE application SET outcome = ?, amount_awarded = ?, attributable = ? WHERE id = ?`)
    .run(outcome, amount_awarded ?? null, attributable ? 1 : 0, req.params.id);
  res.json({ ok: true });
});

// ---- invites ----
operatorRouter.get('/api/op/municipalities', (req, res) => {
  res.json(db.prepare('SELECT id, name, ine_code, population FROM municipality ORDER BY name').all());
});

operatorRouter.post('/api/op/invites', (req, res) => {
  const { email, name, municipality_id } = req.body || {};
  if (!email || !municipality_id) return res.status(400).json({ error: 'faltan email o municipio' });
  const token = createInvite({ email, name, municipality_id });
  res.json({ ok: true, link: `${process.env.BASE_URL || ''}/registro?token=${token}` });
});

operatorRouter.get('/api/op/invites', (req, res) => {
  res.json(db.prepare(`SELECT i.token, i.email, i.name, i.expires_at, i.used_at, m.name AS municipality
    FROM invite i LEFT JOIN municipality m ON m.id = i.municipality_id ORDER BY i.created_at DESC`).all());
});

// ---- contact messages ----
// `new` first regardless of age: an unanswered message from last week outranks one read
// this morning. IP is not selected -- it exists for rate limiting, not for the operator.
operatorRouter.get('/api/op/contact', (req, res) => {
  res.json(db.prepare(`SELECT id, received_at, name, contact, place_label, municipality,
      province, ccaa, message, status, handled_at
    FROM contact_message
    WHERE status != 'spam'
    ORDER BY (status = 'new') DESC, received_at DESC LIMIT 200`).all());
});

operatorRouter.post('/api/op/contact/:id/status', (req, res) => {
  const { status } = req.body || {};
  if (!['new', 'read', 'replied', 'spam'].includes(status)) {
    return res.status(400).json({ error: 'estado inválido' });
  }
  db.prepare(`UPDATE contact_message
    SET status = ?, handled_at = CASE WHEN ? = 'new' THEN NULL ELSE datetime('now') END
    WHERE id = ?`).run(status, status, req.params.id);
  res.json({ ok: true });
});

// ---- alerts + manual poll ----
operatorRouter.get('/api/op/alerts', (req, res) => {
  res.json(db.prepare('SELECT * FROM ingest_alert WHERE resolved = 0 ORDER BY created_at DESC').all());
});
operatorRouter.post('/api/op/alerts/:id/resolve', (req, res) => {
  db.prepare('UPDATE ingest_alert SET resolved = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});
operatorRouter.post('/api/op/poll', async (req, res) => {
  try { res.json({ ok: true, new: await pollOnce() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- metrics (§7) ----
operatorRouter.get('/api/op/metrics', (req, res) => {
  const surfaced = db.prepare(`SELECT COUNT(*) c FROM notification`).get().c;
  const interested = db.prepare(`SELECT COUNT(*) c FROM notification WHERE response = 'interesado'`).get().c;
  const applied = db.prepare(`SELECT COUNT(*) c FROM application`).get().c;
  const awarded = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(amount_awarded),0) s FROM application WHERE outcome = 'awarded'`).get();
  const requests = db.prepare(`SELECT COALESCE(category,'(sin categorizar)') k, status, COUNT(*) c FROM request GROUP BY k, status`).all();
  const baseline = db.prepare(`
    SELECT e.name, e.cif, substr(b.fecha_concesion,1,4) yr, COUNT(*) c, ROUND(SUM(b.importe)) eur
    FROM entity e JOIN baseline_concesion b ON b.cif = e.cif
    GROUP BY e.cif, yr ORDER BY e.name, yr`).all();
  res.json({ surfaced, interested, applied, awarded: awarded.c, euros_awarded: awarded.s, requests, baseline });
});
