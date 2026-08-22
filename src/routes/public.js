// Public endpoints: health + the grassroots funding chat.
// Chat guardrails: per-IP daily cap, input length cap, grounded strictly on
// PUBLISHED grants; the model must never invent deadlines or grants.
// Computed (unconfirmed) deadlines ARE shown, marked estimated (*) with a
// disclaimer: the date can move with local holidays / día-hábil counting.
import { Router } from 'express';
import { db } from '../db.js';
import { anthropic, CHAT_MODEL } from '../llm.js';
import { MUNICIPIOS, PEDANIAS, findMunicipio, fold } from '../municipios.js';
import { NATIONWIDE, INE_PROVINCES, CCAA } from '../ingest/regions.js';

export const publicRouter = Router();

// Place dictionaries, loaded once at boot (see src/municipios.js).
const MUNI_INDEX = MUNICIPIOS.map(m => ({ ...m, key: fold(m.name) }));
const PROVINCES = [...new Set(MUNICIPIOS.map(m => m.province).filter(Boolean))]
  .map(p => ({ province: p, ccaa: MUNICIPIOS.find(m => m.province === p).ccaa, key: fold(p) }));

// A pedanía sits inside a municipality, so it inherits that municipality's tiers —
// including its ayuntamiento's own grants, which its residents genuinely can apply for.
const PEDANIA_INDEX = PEDANIAS.map(p => {
  const parent = findMunicipio(p.municipio);
  return parent ? { label: p.name, key: fold(p.name), parent } : null;
}).filter(Boolean);

const DAILY_CAP = Number(process.env.CHAT_DAILY_CAP || 10);
const MAX_INPUT = 1000;
const MAX_HISTORY = 10;
// With the territory filter applied in SQL, a placed visitor's whole eligible set is
// usually well under this. Unplaced visitors get a deliberately small national slice and
// the assistant asks where they are, rather than us shipping the country every message.
const CHAT_CONTEXT_PLACED = Number(process.env.CHAT_CONTEXT_PLACED || 15);
const CHAT_CONTEXT_UNPLACED = Number(process.env.CHAT_CONTEXT_UNPLACED || 12);

// Typeahead over provinces, municipalities and pedanías.
//
// `label` is what the villager typed and recognises; `name` is the municipality used to
// match ayuntamiento-level grants. For a pedanía those differ — Villotilla resolves to
// Villaturde — and for a province `name` is null, so town-only money never leaks to
// someone who merely named their province.
publicRouter.get('/api/municipios', (req, res) => {
  const q = fold(req.query.q);
  if (q.length < 2) return res.json({ matches: [] });

  const rank = (key) => key.startsWith(q) ? 0 : 1;          // prefix hits first
  const byRank = (a, b) => rank(a.key) - rank(b.key) || a.key.localeCompare(b.key, 'es');

  const provs = PROVINCES.filter(p => p.key.includes(q)).sort(byRank).slice(0, 3)
    .map(p => ({ type: 'provincia', label: p.province, name: null,
                 province: p.province, ccaa: p.ccaa, hint: 'provincia' }));

  const munis = MUNI_INDEX.filter(m => m.key.includes(q)).sort(byRank).slice(0, 6)
    .map(m => ({ type: 'municipio', label: m.name, name: m.name,
                 province: m.province, ccaa: m.ccaa, hint: m.province }));

  const peds = PEDANIA_INDEX.filter(p => p.key.includes(q)).sort(byRank).slice(0, 6)
    .map(p => ({ type: 'pedania', label: p.label, name: p.parent.name,
                 province: p.parent.province, ccaa: p.parent.ccaa,
                 hint: `pedanía de ${p.parent.name}` }));

  // Municipalities before pedanías: an exact town name is the commoner intent.
  res.json({ matches: [...provs, ...munis, ...peds].slice(0, 10) });
});

publicRouter.get('/health', (req, res) => {
  const grants = db.prepare('SELECT COUNT(*) c FROM grant_row').get().c;
  res.json({ ok: true, grants });
});

// Public directory: only published OPEN grants. Computed deadlines are shown
// too, flagged deadline_estimated=1 so the UI renders them with * + disclaimer.
publicRouter.get('/api/grants', (req, res) => {
  const rows = db.prepare(`
    SELECT g.bdns_ref, g.title, g.plain_title, g.granting_body, g.granting_level,
           g.region, g.province, g.municipality, g.category,
           g.ai_summary, g.plain_explainer, g.amount_max, g.budget_total,
           g.source_url, g.application_url, g.sede_url, g.is_rolling,
           g.deadline_date AS deadline,
           CASE WHEN g.deadline_source = 'computed' AND g.deadline_confirmed = 0
                THEN 1 ELSE 0 END AS deadline_estimated,
           e.entity_types, e.funds_what, e.territory_scope
    FROM grant_row g LEFT JOIN grant_eligibility e ON e.grant_id = g.id
    WHERE g.published = 1 AND g.status = 'OPEN'
    ORDER BY g.deadline_date IS NULL, g.deadline_date
    LIMIT 400`).all();
  const last = db.prepare('SELECT MAX(created_at) m FROM grant_row').get().m;
  // Regions present in the current result set, so the UI only offers filters that match something.
  const regions = [...new Set(rows.map(r => r.region).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
  res.json({ grants: rows, regions, stats: { open: rows.length, updated: last ? last.slice(0, 10) : null } });
});

function chatContext(place) {
  // Only published grants; computed deadlines carry the estimated marker.
  // Territory filtering happens in SQL, not in the model. Shipping the whole open set and
  // asking the model to ignore the irrelevant ones is paying Opus rates to run a WHERE
  // clause — and it answers worse, because it is hunting through Murcia to serve Palencia.
  const where = ["g.published = 1", "g.status = 'OPEN'"];
  const args = {};
  if (place) {
    where.push(`(g.region = @nationwide
                 OR (g.region = @ccaa
                     AND (g.province IS NULL OR g.province = @province)
                     AND (g.municipality IS NULL OR g.municipality = @municipality)))`);
    Object.assign(args, {
      nationwide: NATIONWIDE,
      ccaa: place.ccaa,
      province: place.province ?? null,
      // A visitor who named only a province must not be shown one town's money.
      municipality: place.name ?? null,
    });
  }
  const rows = db.prepare(`
    SELECT COALESCE(g.plain_title, g.title) AS title,
           g.granting_body, g.region, g.province, g.municipality, g.category, g.ai_summary,
           g.amount_max, g.budget_total, g.source_url, g.is_rolling,
           g.deadline_date AS deadline,
           CASE WHEN g.deadline_source = 'computed' AND g.deadline_confirmed = 0
                THEN 1 ELSE 0 END AS deadline_estimated,
           e.entity_types, e.funds_what, e.territory_scope
    FROM grant_row g LEFT JOIN grant_eligibility e ON e.grant_id = g.id
    WHERE ${where.join(' AND ')}
    -- Unplaced visitors see nationwide calls first: those are the only ones we can be
    -- sure apply to them before they tell us where they are.
    ORDER BY ${place ? '' : `(g.region = '${NATIONWIDE}') DESC,`}
             g.deadline_date IS NULL, g.deadline_date
    LIMIT @limit`).all({ ...args, limit: place ? CHAT_CONTEXT_PLACED : CHAT_CONTEXT_UNPLACED });
  return rows.map((g, i) =>
    `[${i + 1}] ${g.title}\n  Órgano: ${g.granting_body || 'n/d'}\n  Resumen: ${g.ai_summary || 'n/d'}\n` +
    `  Territorio: ${g.region || 'n/d'}\n` +
    `  Beneficiarios: ${g.entity_types || '[]'} | Financia: ${g.funds_what || '[]'} | Ámbito: ${g.territory_scope || 'n/d'}\n` +
    `  Plazo: ${g.deadline
      ? (g.deadline_estimated
        ? `hasta ${g.deadline}* (fecha estimada: puede variar según festivos locales y el cómputo de días hábiles; confírmala en las bases oficiales)`
        : `hasta ${g.deadline}`)
      : (g.is_rolling ? 'abierto de forma continuada' : 'pendiente de confirmar — consúltanos')}\n` +
    `  Más info: ${g.source_url || 'n/d'}`).join('\n\n');
}

// The client sends back whatever it stored; re-resolve it against our own dictionaries so
// the SQL filter only ever sees values we recognise.
const VALID_PROVINCES = new Set(Object.values(INE_PROVINCES));
const VALID_CCAA = new Set([...Object.values(CCAA), NATIONWIDE]);

function resolvePlace(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const ccaa = typeof raw.ccaa === 'string' ? raw.ccaa : null;
  if (!ccaa || !VALID_CCAA.has(ccaa)) return null;
  const province = typeof raw.province === 'string' && VALID_PROVINCES.has(raw.province)
    ? raw.province : null;
  // `name` must be a real municipality; a province-only pick sends null and so never
  // matches municipality-scoped grants.
  const muni = typeof raw.name === 'string' ? findMunicipio(raw.name) : null;
  return { ccaa, province: province ?? muni?.province ?? null, name: muni?.name ?? null,
           label: typeof raw.label === 'string' ? raw.label.slice(0, 80) : (muni?.name ?? province ?? ccaa) };
}

const CHAT_SYSTEM = `Eres el asistente público de Convoca (plazoabierto.es), un servicio que ayuda a pueblos pequeños y a sus entidades locales (ayuntamientos, juntas vecinales, asociaciones, clubes, AMPAs) a no perder subvenciones.

Reglas estrictas:
- Responde SOLO sobre financiación/subvenciones para entidades locales rurales y sobre cómo funciona Convoca. Cualquier otro tema: redirige amablemente.
- Solo puedes citar las convocatorias del listado CONVOCATORIAS ABIERTAS que se te proporciona. Si ninguna encaja, dilo claramente y sugiere dejar el contacto — jamás inventes una convocatoria.
- El listado que recibes YA está filtrado por el territorio del usuario cuando sabemos de dónde es: todo lo que aparece le sirve. Si el listado viene marcado como SIN UBICACIÓN, solo contiene ayudas de toda España — pregúntale de qué pueblo o provincia es antes de recomendarle nada territorial, y dile que puede escribirlo arriba en "¿De dónde eres?" para ver también lo de su comunidad, su diputación y su ayuntamiento.
- PROHIBIDO calcular, estimar o deducir plazos o fechas. Solo puedes repetir literalmente el campo "Plazo" del listado. Si dice "pendiente de confirmar", di exactamente eso. Si la fecha lleva asterisco (*), repite siempre también el aviso de fecha estimada que la acompaña.
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

  const { message, history, place: rawPlace } = req.body || {};
  if (typeof message !== 'string' || !message.trim() || message.length > MAX_INPUT) {
    return res.status(400).json({ error: 'mensaje inválido' });
  }
  const past = Array.isArray(history) ? history.slice(-MAX_HISTORY)
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_INPUT) })) : [];

  const place = resolvePlace(rawPlace);
  const listing = chatContext(place);
  const header = place
    ? `CONVOCATORIAS ABIERTAS para ${place.label} (${[place.name, place.province, place.ccaa].filter(Boolean).join(', ')}) — ya filtradas por territorio:`
    : 'CONVOCATORIAS ABIERTAS — SIN UBICACIÓN (solo ámbito estatal):';

  try {
    const response = await anthropic.messages.create({
      model: CHAT_MODEL,
      max_tokens: 1024,
      system: [
        // Only the instructions are byte-identical across visitors, so only they are worth
        // caching. The listing below varies per territory and would never hit.
        { type: 'text', text: CHAT_SYSTEM, cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: `${header}\n\n${listing || '(ninguna publicada ahora mismo)'}` },
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
