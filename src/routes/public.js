// Public endpoints: health + the grassroots funding chat.
// Chat guardrails: per-IP daily cap, input length cap, grounded strictly on
// PUBLISHED grants with confirmed deadlines; the model must never invent
// deadlines or grants.
import { Router } from 'express';
import { db } from '../db.js';
import { anthropic, MODEL } from '../llm.js';

export const publicRouter = Router();

const DAILY_CAP = Number(process.env.CHAT_DAILY_CAP || 10);
const MAX_INPUT = 1000;
const MAX_HISTORY = 10;

publicRouter.get('/health', (req, res) => {
  const grants = db.prepare('SELECT COUNT(*) c FROM grant_row').get().c;
  res.json({ ok: true, grants });
});

// Public directory: only published OPEN grants; deadline only when trustworthy
// (api-sourced or operator-confirmed) — same visibility rules as the chat.
publicRouter.get('/api/grants', (req, res) => {
  const rows = db.prepare(`
    SELECT g.bdns_ref, g.title, g.granting_body, g.granting_level, g.category,
           g.ai_summary, g.amount_max, g.budget_total, g.source_url, g.application_url, g.is_rolling,
           CASE WHEN g.deadline_source = 'api' OR g.deadline_confirmed = 1
                THEN g.deadline_date ELSE NULL END AS deadline,
           e.entity_types, e.funds_what, e.territory_scope
    FROM grant_row g LEFT JOIN grant_eligibility e ON e.grant_id = g.id
    WHERE g.published = 1 AND g.status = 'OPEN'
    ORDER BY g.deadline_date IS NULL, g.deadline_date
    LIMIT 200`).all();
  const last = db.prepare('SELECT MAX(created_at) m FROM grant_row').get().m;
  res.json({ grants: rows, stats: { open: rows.length, updated: last ? last.slice(0, 10) : null } });
});

function chatContext() {
  // Only published grants; deadline shown only when api-sourced or operator-confirmed.
  const rows = db.prepare(`
    SELECT g.title, g.granting_body, g.category, g.ai_summary, g.amount_max, g.budget_total,
           g.source_url, g.is_rolling,
           CASE WHEN g.deadline_source = 'api' OR g.deadline_confirmed = 1
                THEN g.deadline_date ELSE NULL END AS deadline,
           e.entity_types, e.funds_what, e.territory_scope
    FROM grant_row g LEFT JOIN grant_eligibility e ON e.grant_id = g.id
    WHERE g.published = 1 AND g.status = 'OPEN'
    ORDER BY g.deadline_date IS NULL, g.deadline_date
    LIMIT 40`).all();
  return rows.map((g, i) =>
    `[${i + 1}] ${g.title}\n  Órgano: ${g.granting_body || 'n/d'}\n  Resumen: ${g.ai_summary || 'n/d'}\n` +
    `  Beneficiarios: ${g.entity_types || '[]'} | Financia: ${g.funds_what || '[]'} | Ámbito: ${g.territory_scope || 'n/d'}\n` +
    `  Plazo: ${g.deadline ? `hasta ${g.deadline}` : (g.is_rolling ? 'abierto de forma continuada' : 'pendiente de confirmar — consúltanos')}\n` +
    `  Más info: ${g.source_url || 'n/d'}`).join('\n\n');
}

const CHAT_SYSTEM = `Eres el asistente público de Convoca (plazoabierto.es), un servicio que ayuda a pueblos pequeños y a sus entidades locales (ayuntamientos, juntas vecinales, asociaciones, clubes, AMPAs) a no perder subvenciones.

Reglas estrictas:
- Responde SOLO sobre financiación/subvenciones para entidades locales rurales y sobre cómo funciona Convoca. Cualquier otro tema: redirige amablemente.
- Solo puedes citar las convocatorias del listado CONVOCATORIAS ABIERTAS que se te proporciona. Si ninguna encaja, dilo claramente y sugiere dejar el contacto — jamás inventes una convocatoria.
- PROHIBIDO calcular, estimar o deducir plazos o fechas. Solo puedes repetir literalmente el campo "Plazo" del listado. Si dice "pendiente de confirmar", di exactamente eso.
- Sé breve (2-6 frases), castellano llano, tono cercano de bar de pueblo pero profesional. Sin listas largas: la mejor opción u opciones (máx. 3).
- No pidas ni almacenes datos personales. Para seguimiento, remite al correo hola@plazoabierto.es.`;

publicRouter.post('/api/chat', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '?';
  const day = new Date().toISOString().slice(0, 10);
  db.prepare(`INSERT INTO chat_usage (ip, day, count) VALUES (?, ?, 1)
    ON CONFLICT(ip, day) DO UPDATE SET count = count + 1`).run(ip, day);
  const used = db.prepare('SELECT count FROM chat_usage WHERE ip = ? AND day = ?').get(ip, day).count;
  if (used > DAILY_CAP) {
    return res.status(429).json({ error: 'Has llegado al límite diario del asistente. Escríbenos y te contestamos en persona.' });
  }

  const { message, history } = req.body || {};
  if (typeof message !== 'string' || !message.trim() || message.length > MAX_INPUT) {
    return res.status(400).json({ error: 'mensaje inválido' });
  }
  const past = Array.isArray(history) ? history.slice(-MAX_HISTORY)
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_INPUT) })) : [];

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: [
        { type: 'text', text: CHAT_SYSTEM },
        { type: 'text', text: `CONVOCATORIAS ABIERTAS:\n\n${chatContext() || '(ninguna publicada ahora mismo)'}` },
      ],
      messages: [...past, { role: 'user', content: message }],
    });
    if (response.stop_reason === 'refusal') {
      return res.json({ reply: 'No puedo ayudarte con eso. ¿Tienes alguna duda sobre subvenciones para tu pueblo o tu asociación?' });
    }
    const reply = response.content.find(b => b.type === 'text')?.text
      || 'Perdona, no he podido responder. Inténtalo de nuevo.';
    res.json({ reply, remaining: Math.max(0, DAILY_CAP - used) });
  } catch (e) {
    console.error('chat error:', e.message);
    res.status(500).json({ error: 'El asistente no está disponible ahora mismo. Inténtalo más tarde.' });
  }
});
