// Public endpoints: health + the grassroots funding chat.
// Chat guardrails: per-IP daily cap, input length cap, grounded strictly on
// PUBLISHED grants; the model must never invent deadlines or grants.
// Computed (unconfirmed) deadlines ARE shown, marked estimated (*) with a
// disclaimer: the date can move with local holidays / día-hábil counting.
import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { db, uuid } from '../db.js';
import { anthropic, CHAT_MODEL } from '../llm.js';
import { MUNICIPIOS, PEDANIAS, findMunicipio, fold } from '../municipios.js';
import { NATIONWIDE, INE_PROVINCES, CCAA } from '../ingest/regions.js';
import { notifyOperator } from '../notify.js';
import { galContext, galLookup } from '../gal.js';
import { isBusinessGrant, isLeaderGrant } from '../negocios.js';
import { understandAndSearch } from '../chatAI.js';

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

// Contact form. The daily per-IP cap is the rate limit; the honeypot catches the rest.
const CONTACT_CAP = Number(process.env.CONTACT_DAILY_CAP || 3);
export const CONTACT_RETENTION_DAYS = Number(process.env.CONTACT_RETENTION_DAYS || 365);

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

// sha comes from deploy.ps1 writing DEPLOYED_SHA next to server.js - lets deploy.ps1
// assert the running process actually is the commit it just pushed, instead of a
// restart succeeding while still serving whatever was deployed last.
let deployedSha = 'unknown';
try { deployedSha = readFileSync(join(import.meta.dirname, '../../DEPLOYED_SHA'), 'utf8').trim(); } catch {}

publicRouter.get('/health', (req, res) => {
  const grants = db.prepare('SELECT COUNT(*) c FROM grant_row').get().c;
  res.json({ ok: true, grants, sha: deployedSha });
});

// Public directory: only published OPEN grants. Computed deadlines are shown
// too, flagged deadline_estimated=1 so the UI renders them with * + disclaimer.
publicRouter.get('/api/grants', (req, res) => {
  const rows = db.prepare(`
    SELECT g.bdns_ref, g.title, g.plain_title, g.granting_body, g.granting_level,
           g.region, g.province, g.municipality, g.category,
           g.ai_summary, g.plain_explainer, g.plain_checklist, g.amount_max, g.budget_total,
           g.source_url, g.application_url, g.sede_url, g.is_rolling,
           g.deadline_date AS deadline,
           CASE WHEN g.deadline_source = 'computed' AND g.deadline_confirmed = 0
                THEN 1 ELSE 0 END AS deadline_estimated,
           e.entity_types, e.funds_what, e.territory_scope
    FROM grant_row g LEFT JOIN grant_eligibility e ON e.grant_id = g.id
    WHERE g.published = 1 AND g.status = 'OPEN'
    ORDER BY g.deadline_date IS NULL, g.deadline_date
    LIMIT 5000`).all();
  const last = db.prepare('SELECT MAX(created_at) m FROM grant_row').get().m;
  // Regions present in the current result set, so the UI only offers filters that match something.
  const regions = [...new Set(rows.map(r => r.region).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
  res.json({ grants: rows, regions, stats: { open: rows.length, updated: last ? last.slice(0, 10) : null } });
});

// Public licitaciones directory: only published, actively-open tenders — same "only what
// someone can act on right now" rule as /api/grants (published + status OPEN there).
// adjudicada/resuelta/anulada rows exist in the DB (see enrichLicitacion.js's estado
// handling) but aren't bidding opportunities any more, so they stay out of the public list.
publicRouter.get('/api/licitaciones', (req, res) => {
  const rows = db.prepare(`
    SELECT id, expediente, organo, tipo_contrato, procedimiento, cpv, valor_estimado,
           presupuesto_base, iva, fecha_limite, lugar, ccaa, duracion, num_lotes, pliegos,
           source_url, titulo, resumen, quien_puede_interesarle, que_hay_que_hacer,
           requisitos_clave, complejidad, complejidad_motivo
    FROM licitacion_row
    WHERE published = 1 AND estado = 'licitacion'
    ORDER BY fecha_limite IS NULL, fecha_limite
    LIMIT 5000`).all();
  const last = db.prepare('SELECT MAX(created_at) m FROM licitacion_row').get().m;
  const tipos = [...new Set(rows.map(r => r.tipo_contrato).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
  // Filter on `ccaa` (derived from the feed's NUTS code - see placsp.js's ccaaFromNuts),
  // not the raw `lugar` text: lugar mixes province and comunidad names depending on what
  // PLACSP happened to put there, which mixed granularities in an earlier version of this
  // filter. `lugar` is still returned for display on each card - it's the more specific,
  // more useful text there, just not a well-formed filter axis on its own.
  const ccaas = [...new Set(rows.map(r => r.ccaa).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
  res.json({ licitaciones: rows, tipos, ccaas, stats: { open: rows.length, updated: last ? last.slice(0, 10) : null } });
});

// Public "Negocios" directory: open published grants that businesses can apply for.
// A grant counts when BDNS's own beneficiary types include a business (autónomos and
// pymes are "personas físicas/jurídicas que desarrollan actividad económica"), or when a
// LEADER group (GAL/GDR) grants it - those are the rural-business aid most people miss.
// beneficiarios_bdns is filled by the daily poll (and scripts/backfill-beneficiarios.js).
publicRouter.get('/api/negocios', (req, res) => {
  const rows = db.prepare(`
    SELECT g.bdns_ref, g.title, g.plain_title, g.granting_body, g.granting_level,
           g.region, g.province, g.municipality, g.category,
           g.ai_summary, g.plain_explainer, g.amount_max, g.budget_total,
           g.source_url, g.application_url, g.sede_url, g.is_rolling,
           g.deadline_date AS deadline, g.beneficiarios_bdns,
           CASE WHEN g.deadline_source = 'computed' AND g.deadline_confirmed = 0
                THEN 1 ELSE 0 END AS deadline_estimated,
           e.funds_what
    FROM grant_row g LEFT JOIN grant_eligibility e ON e.grant_id = g.id
    WHERE g.published = 1 AND g.status = 'OPEN'
    ORDER BY g.deadline_date IS NULL, g.deadline_date
    LIMIT 5000`).all();
  const grants = [];
  for (const r of rows) {
    if (!isBusinessGrant(r)) continue;
    const leader = isLeaderGrant(r);
    delete r.beneficiarios_bdns;
    grants.push({ ...r, leader: leader ? 1 : 0 });
  }
  const last = db.prepare('SELECT MAX(created_at) m FROM grant_row').get().m;
  const regions = [...new Set(grants.map(r => r.region).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
  res.json({ grants, regions, stats: { open: grants.length, leader: grants.filter(g => g.leader).length, updated: last ? last.slice(0, 10) : null } });
});

// Public GAL finder: which LEADER group covers a municipality. Same data and the same
// honesty rules as the chat (src/gal.js): 2014-2020 entries are labelled as such, and an
// unknown village is never assigned a group.
publicRouter.get('/api/gal', (req, res) => {
  const place = { name: String(req.query.name || ''), province: String(req.query.province || ''), ccaa: String(req.query.ccaa || '') };
  const r = galLookup(place);
  const clean = (g) => ({ name: g.name, phone: g.phone || null, email: g.email || null, web: g.web || null, address: g.address || null });
  res.json({ ...r, gals: (r.gals || []).map(clean) });
});

const MESES_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
// String-split rather than `new Date()`: a deadline is a calendar date, not an instant, and
// parsing it as UTC-midnight then formatting in server-local time can shift it a day either
// way. This just relabels the same YYYY-MM-DD the model is forbidden from doing math on.
function formatFechaEs(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const [, y, mo, d] = m;
  return `${parseInt(d, 10)} de ${MESES_ES[parseInt(mo, 10) - 1]} de ${y}`;
}

const CHAT_SHOW = Number(process.env.CHAT_SHOW || 8);
function formatForChat(rows) {
  return rows.map((g, i) =>
    `[${i + 1}] ${g.plain_title || g.title}\n  Órgano: ${g.granting_body || 'n/d'}\n  Resumen: ${g.ai_summary || 'n/d'}\n` +
    `  Territorio: ${[g.region, g.province, g.municipality].filter(Boolean).join(' / ') || 'n/d'}\n` +
    `  Beneficiarios: ${g.entity_types || '[]'} | Financia: ${g.funds_what || '[]'} | Ámbito: ${g.territory_scope || 'n/d'}\n` +
    `  Importe: ${g.amount_max ? `hasta ${g.amount_max} €` : g.budget_total ? `${g.budget_total} € en total` : 'según bases'}\n` +
    `  Plazo: ${g.deadline
      ? (g.deadline_estimated
        ? `hasta ${formatFechaEs(g.deadline)}* (fecha estimada: puede variar según festivos locales y el cómputo de días hábiles; confírmala en las bases oficiales)`
        : `hasta ${formatFechaEs(g.deadline)}`)
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

const CHAT_SYSTEM = `Eres el asistente público de Plazo Abierto (plazoabierto.es), que ayuda a cualquiera a encontrar subvenciones y ayudas públicas abiertas en España: personas y familias, estudiantes, autónomos y empresas, asociaciones, clubes, AMPAs y ayuntamientos.

Cómo funciona: antes de que respondas, el sistema ya ha buscado en todas las convocatorias abiertas que tenemos publicadas para el territorio y el tema de la pregunta. Recibes el bloque BÚSQUEDA HECHA / RESULTADO con el número exacto de convocatorias encontradas y, debajo, las mejores. La lista de la página ya se ha filtrado sola para mostrar exactamente esas.

Reglas estrictas:
- Empieza diciendo cuántas has encontrado, con el número exacto del RESULTADO (por ejemplo: "He encontrado 3 ayudas abiertas para pymes en Segovia; te las he dejado en la lista de la página."). Si son más de las que ves, recomienda las mejores (máximo 3) y di que el resto está en la lista.
- Si el RESULTADO es 0, dilo claramente ("No he encontrado ninguna convocatoria abierta para eso en...") y no menciones la lista de la página: cuando no hay resultados no se filtra. Si no sabemos el territorio, pregunta de qué pueblo o provincia es: puede escribirlo en la pregunta o arriba en "¿De dónde eres?". Si sí lo sabemos, sugiere volver a mirar más adelante o escribir a hola@plazoabierto.es.
- Si el RESULTADO dice que ninguna es específica del tema, dilo así y presenta las de negocios de la zona como alternativa.
- Solo puedes citar las convocatorias del listado que recibes. Jamás inventes una convocatoria ni recomiendes ayudas de memoria.
- Si alguien pregunta por montar o ampliar un negocio en un pueblo, recuerda que la vía habitual son las ayudas LEADER del Grupo de Acción Local (GAL) de su comarca. Si tras el listado hay un bloque "GAL LEADER DE LA ZONA", úsalo: nombra ese GAL con sus datos de contacto tal cual vienen, y dile que conviene contactarles antes de gastar. Sigue exactamente lo que diga ese bloque: si dice que no tenemos el dato o que no hay GAL, no nombres ninguno. Nunca deduzcas de memoria qué GAL le corresponde a un pueblo.
- PROHIBIDO calcular, estimar o deducir plazos o fechas. Solo puedes repetir literalmente el campo "Plazo" del listado. Si dice "pendiente de confirmar", di exactamente eso. Si la fecha lleva asterisco (*), repite siempre también el aviso de fecha estimada que la acompaña.
- Sé breve (2-6 frases), castellano llano, tono cercano pero profesional.
- Texto plano, sin markdown: nada de asteriscos para negrita, guiones de lista ni encabezados. El asterisco pegado a una fecha estimada es la única excepción.
- Temas que no son ayudas públicas: redirige amablemente.
- No pidas ni almacenes datos personales. Para seguimiento, remite al correo hola@plazoabierto.es.`;

// ---- contact form ----
//
// Stored here rather than emailed: the domain has no MX record, so the mailto: link this
// replaces went nowhere. Three defences, in the order they cost anything:
//
//  1. Honeypot. `empresa` is hidden in CSS, so a human never fills it and a bot usually
//     does. A caught bot gets a normal 200 and nothing is stored -- telling it that it
//     failed is how it learns to stop falling for the field.
//  2. Per-IP daily cap, counted off the stored rows themselves, so it needs no new table
//     and no memory that a restart would lose.
//  3. Length caps on every field, enforced before anything touches the DB.
publicRouter.post('/api/contact', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '?';
  const { name, contact, message, empresa, place: rawPlace } = req.body || {};

  if (typeof empresa === 'string' && empresa.trim()) {
    console.warn(`contact: honeypot tripped from ${ip}`);
    return res.json({ ok: true });                       // deliberately indistinguishable
  }

  const clean = (v, max) => typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
  const n = clean(name, 120), c = clean(contact, 200), m = clean(message, 2000);
  if (!n || !c || !m) {
    return res.status(400).json({ error: 'Faltan datos: nombre, contacto y mensaje son obligatorios.' });
  }
  // An email or a Spanish phone number -- enough to catch a typo, not so strict it rejects
  // "620 11 22 33" or a village address. Anything else is still accepted with a nudge.
  if (!/@/.test(c) && !/\d{6,}/.test(c.replace(/[\s.-]/g, ''))) {
    return res.status(400).json({ error: 'Deja un correo o un teléfono para poder contestarte.' });
  }

  const since = new Date(Date.now() - 86400_000).toISOString().slice(0, 19).replace('T', ' ');
  const recent = db.prepare('SELECT COUNT(*) c FROM contact_message WHERE ip = ? AND received_at >= ?')
    .get(ip, since).c;
  if (recent >= CONTACT_CAP) {
    return res.status(429).json({ error: 'Ya nos has escrito hoy. Te contestamos en cuanto podamos.' });
  }

  const place = resolvePlace(rawPlace);
  db.prepare(`INSERT INTO contact_message
      (id, name, contact, place_label, municipality, province, ccaa, message, ip)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(uuid(), n, c, place?.label || null, place?.name || null,
      place?.province || null, place?.ccaa || null, m, ip);

  // Await it: the push is capped at 8s and never throws, and a fire-and-forget here would
  // lose the notification whenever the process restarts right after a submission.
  await notifyOperator(`Nuevo mensaje de ${n}${place?.label ? ` (${place.label})` : ''}`,
    `${c}

${m}`);

  res.json({ ok: true });
});

publicRouter.post('/api/chat', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '?';
  const day = new Date().toISOString().slice(0, 10);
  db.prepare(`INSERT INTO chat_usage (ip, day, count) VALUES (?, ?, 1)
    ON CONFLICT(ip, day) DO UPDATE SET count = count + 1`).run(ip, day);
  const used = db.prepare('SELECT count FROM chat_usage WHERE ip = ? AND day = ?').get(ip, day).count;
  if (used > DAILY_CAP) {
    return res.status(429).json({ error: 'Has llegado al límite diario del asistente. Escríbenos y te contestamos en persona.' });
  }

  const { message, history, place: rawPlace, section } = req.body || {};
  if (typeof message !== 'string' || !message.trim() || message.length > MAX_INPUT) {
    return res.status(400).json({ error: 'mensaje inválido' });
  }
  const past = Array.isArray(history) ? history.slice(-MAX_HISTORY)
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_INPUT) })) : [];

  // Where: the place picker, else the question itself ("empresas en Huelva"), else an earlier
  // message in this conversation. What: every open grant there that fits the question
  // (src/chatSearch.js). The count and the matches also go back to the page, which filters its
  // list to exactly those - so "he encontrado 3" and the list always agree.
  // The AI reads the question first (place, topic and related words, who is asking) and checks
  // the candidates after the search, keeping only real matches - src/chatAI.js.
  const found = await understandAndSearch(message, past, {
    place: resolvePlace(rawPlace), section: section === 'negocios' ? 'negocios' : null });
  const place = found.place;
  const shown = found.grants.slice(0, CHAT_SHOW);
  const listing = formatForChat(shown);
  const where = place ? `${place.label} (${[place.name, place.province, place.ccaa].filter(Boolean).join(', ')})` : 'SIN UBICACIÓN (solo vemos lo de toda España)';
  const header = [
    `BÚSQUEDA HECHA: territorio ${where}${found.terms.length ? `; tema: ${found.terms.join(', ')}` : ''}${found.applicant ? `; quien pregunta: ${found.applicant}` : ''}${found.business ? '; solo ayudas para empresas, autónomos y negocios' : ''}${found.checked ? `; se han revisado una a una las ${found.checked} candidatas más cercanas y solo cuentan las que encajan de verdad` : ''}.`,
    `RESULTADO: ${found.total} convocatoria${found.total === 1 ? '' : 's'} abierta${found.total === 1 ? '' : 's'}${found.fallback ? ' (ninguna es específica de ese tema: son todas las de negocios de la zona)' : ''}.`,
    found.total > shown.length ? `Abajo van las ${shown.length} mejores; la lista de la página ya muestra las ${found.total}.` : '',
  ].filter(Boolean).join('\n');

  try {
    const response = await anthropic.messages.create({
      model: CHAT_MODEL,
      max_tokens: 1024,
      system: [
        // Only the instructions are byte-identical across visitors, so only they are worth
        // caching. The listing below varies per territory and would never hit.
        { type: 'text', text: CHAT_SYSTEM, cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: [`${header}\n\n${listing || '(ninguna)'}`, galContext(place)].filter(Boolean).join('\n\n') },
      ],
      messages: [...past, { role: 'user', content: message }],
    });
    if (response.stop_reason === 'refusal') {
      return res.json({ reply: 'No puedo ayudarte con eso. ¿Tienes alguna duda sobre subvenciones para tu pueblo o tu asociación?' });
    }
    const reply = response.content.find(b => b.type === 'text')?.text
      || 'Perdona, no he podido responder. Inténtalo de nuevo.';
    res.json({ reply, remaining: Math.max(0, DAILY_CAP - used), total: found.total,
      matches: found.grants.slice(0, 200).map(g => g.bdns_ref), place: place ? { label: place.label, ccaa: place.ccaa, province: place.province, name: place.name } : null });
  } catch (e) {
    console.error('chat error:', e.message);
    res.status(500).json({ error: 'El asistente no está disponible ahora mismo. Inténtalo más tarde.' });
  }
});
