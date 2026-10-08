// Enrichment chain for one convocatoria: BDNS detail -> deadline handling ->
// bases PDF text -> LLM summary/eligibility -> match suggestions.
// HARD RULE (spec §3.2): the LLM never computes or outputs a deadline. Dates
// come from the API field (deadline_source='api') or from the deterministic
// engine over a regex-parsed relative term (deadline_source='computed',
// quarantined until operator confirmation).
import { createRequire } from 'node:module';
import { db, uuid } from '../db.js';
import { bdnsGet, alert } from './bdns.js';
import { computeDeadline } from './dates.js';
import { territoryFromRegiones } from './regions.js';
import { municipioFromBody } from '../municipios.js';
import { anthropic, MODEL } from '../llm.js';
import { suggestMatches } from './match.js';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

const NUM_WORDS = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cinco: 5, seis: 6, siete: 7, diez: 10, quince: 15,
  veinte: 20, veinticinco: 25, treinta: 30, cuarenta: 40, 'cuarenta y cinco': 45, sesenta: 60, noventa: 90,
  // Catalan / Galician, as written by Catalan, Valencian, Balearic and Galician bodies
  deu: 10, quinze: 15, vint: 20, 'vint-i-cinc': 25, trenta: 30, dez: 10, vinte: 20, trinta: 30,
  // ordinals: "el decimoquinto día"
  decimo: 10, decimoquinto: 15, vigesimo: 20, trigesimo: 30,
};

const MONTHS = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8,
  septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  gener: 1, febrer: 2, marc: 3, maig: 5, juny: 6, juliol: 7, agost: 8, setembre: 9, desembre: 12,
  xaneiro: 1, febreiro: 2, maio: 5, xuno: 6, xullo: 7, setembro: 9, outubro: 10, novembro: 11, decembro: 12,
};

const foldText = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[`´’]/g, "'")                  // "FINS EL 9 D`OCTUBRE" -> "d'octubre"
  .replace(/\bdecimo quinto\b/g, 'decimoquinto')
  .replace(/\(\s*\d+\s*\)/g, ' ')          // "Veinte (20) días" -> "veinte días"
  .replace(/(\d+)\s*[ºª°]/g, '$1')         // "16º día hábil" -> "16 dia habil"
  .replace(/\s+/g, ' ').trim();

const END_MARKER = /\b(hasta|antes|fins|como maximo|finaliza\w*|termina\w*)\b(.*)$/;
const iso = (y, mo, d) => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// Absolute end date written out in BDNS textFin ("Hasta el 31 de diciembre de 2027",
// "HASTA EL DÍA 31/12/2027", "16 OCTUBRE 2026", "23 de juny de 2026"). BDNS often leaves
// fechaFinSolicitud empty and puts the date here instead; without reading it such a call had
// no deadline and stayed OPEN for as long as BDNS's `abierto` flag said so - and that flag goes
// stale (2026-10-08: a Canarias call closed in Sep 2024 and a CODINSE call closed Dec 2024 were
// both still flagged open). textFin is the end-of-period field, so the latest date it names is
// the end. `ref` (the call's registration date) dates a day-and-month with no year ("Antes del
// 7 de octubre"); those count only after an end marker. Returns ISO or null.
export function parseEndDate(text, ref = null) {
  if (!text) return null;
  const t = foldText(text);
  // "Diez días hábiles desde la publicación del Real Decreto 565/2026, de 8 de julio de 2026":
  // with a relative period the dates name what it counts from, not the end. Then only a
  // date after an explicit end marker ("hasta", "antes", "como máximo", "finaliza") counts.
  const relative = /\b(\d{1,3}|[a-z]+) (dias|dies|mes|meses|mesos|habiles|habils)\b/.test(t);
  const tail = END_MARKER.exec(t)?.[2];
  const scope = relative ? (tail ?? '') : t;
  const found = [];
  for (const m of scope.matchAll(/\b(\d{1,2}) ?(?:de |d')?([a-z]+)(?: de| del|,)? (\d{4})\b/g)) {
    if (MONTHS[m[2]]) found.push([Number(m[3]), MONTHS[m[2]], Number(m[1])]);
  }
  for (const m of scope.matchAll(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/g)) {
    let [d, mo] = [Number(m[1]), Number(m[2])];
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];                 // "10/19/2026" (US order)
    found.push([Number(m[3]), mo, d]);
  }
  for (const m of scope.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) found.push([Number(m[1]), Number(m[2]), Number(m[3])]);
  if (!found.length && tail != null && ref) {
    const r = String(ref).slice(0, 10), y = Number(r.slice(0, 4));
    const noYear = [];
    for (const m of tail.matchAll(/\b(\d{1,2}) ?(?:de |d')?([a-z]+)\b(?! ?(?:de |del )?\d{4})/g)) if (MONTHS[m[2]]) noYear.push([MONTHS[m[2]], Number(m[1])]);
    for (const m of tail.matchAll(/\b(\d{1,2})\/(\d{1,2})\b(?!\/\d)/g)) noYear.push([Number(m[2]), Number(m[1])]);
    for (const [mo, d] of noYear) found.push([iso(y, mo, d) < r ? y + 1 : y, mo, d]);
  }
  const dates = found
    .filter(([y, mo, d]) => y >= 2000 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31)
    .map(([y, mo, d]) => iso(y, mo, d))
    .sort();
  return dates.at(-1) || null;
}

// BDNS sometimes says so in words instead of a date: "Periodo de entrega de solicitudes
// cerrado el dia ." with abierto=false. Without a date this is the only closed signal.
export const saysClosed = (detail) => !detail.abierto && /\bcerrad[oa]\b/i.test(detail.textFin || '');

// The call's end date from BDNS alone, without computing relative terms: the official
// field first, then a date written in textFin.
export const endDateFromDetail = (detail) =>
  detail.fechaFinSolicitud?.slice(0, 10) || parseEndDate(detail.textFin, detail.fechaRecepcion);

// Deterministic parse of a relative plazo out of BDNS textFin / bases text: "15 días
// hábiles", "un mes", "16º día hábil posterior...", "20 dies naturals", "15 hábiles
// siguientes", "Veinte (20) días naturales", "Último día del mes a contar desde...", and a
// bare "10" (the whole field), read as working days - the administrative default.
export function parsePlazoTerm(text) {
  if (!text) return null;
  const t = foldText(text);
  if (/^\d{1,2}$/.test(t)) return { count: Number(t), unit: 'habiles', raw: t };
  if (/\bultimo dia del mes\b/.test(t)) return { count: 1, unit: 'meses', raw: 'último día del mes' };
  const N = String.raw`(\d{1,3}|[a-z-]+(?: y [a-z]+)?)`;
  const re = new RegExp(String.raw`\b${N} ?(?:(?:dias?|dies) ?(habil(?:e?s)?|natural(?:e?s)?)?|(habil(?:e?s)?|natural(?:e?s)?)\b|(mes(?:es)?|mesos)\b)`, 'g');
  for (const m of t.matchAll(re)) {
    const count = /^\d+$/.test(m[1]) ? Number(m[1]) : NUM_WORDS[m[1]];
    if (!count) continue;
    if (m[4]) return { count, unit: 'meses', raw: m[0] };
    const unit = (m[2] || m[3] || '').startsWith('h') ? 'habiles' : 'naturales';
    return { count, unit, raw: m[0] };
  }
  return null;
}

// Some LEADER groups register their open call for projects as "Concesión directa" in BDNS
// (seen 2026-10: MACOVALL 865356, CEDER Tiétar 808337, Ceuta 840814, ARADUEY 913434). Treat a
// direct award as a real call only when it reads as one ("convocatoria") in a LEADER /
// local-development context and is not one of the usual named transfers.
export const LEADER_TEXT = /\bLEADER\b|DESARROLLO LOCAL PARTICIPATIVO|\bEDLP?\b|GRUPOS? DE ACCI[OÓ]N LOCAL|\bGAL\b|\bGDR\b/i;
export function isMislabelledLeaderCall(detail) {
  const text = [detail.descripcion, detail.descripcionFinalidad, detail.organo?.nivel2, detail.organo?.nivel3].filter(Boolean).join(' ');
  return /\bCONV(OCATORIA)?\b/i.test(detail.descripcion || '')
    && LEADER_TEXT.test(text)
    && !/NOMINATIVA|CONVENIO|GASTOS DE FUNCIONAMIENTO|COFINAN/i.test(detail.descripcion || '');
}
// Money already assigned to a named beneficiary: nobody can apply. The Palencia/CyL pilot
// still ingests these (who already got what), but they are never an open call.
export const isDirectAward = (detail) =>
  /concesi[oó]n directa/i.test(detail.tipoConvocatoria || '') && !isMislabelledLeaderCall(detail);

// The application window in the bases, for calls whose BDNS text only says "según bases",
// "ver artículo 8"...: the sentence that sets the plazo de presentación.
function plazoFromBases(basesText) {
  const t = String(basesText || '').replace(/\s+/g, ' ');
  const m = /plazo (?:de|para la) presentaci[oó]n de (?:las )?solicitudes[^.]{0,300}/i.exec(t)
    || /solicitudes (?:se|podr[aá]n) presentar[^.]{0,300}/i.exec(t);
  return m ? m[0] : null;
}

// Deadline and status for one BDNS call - the single rule used by ingest and by the
// one-off repairs (scripts/fix-end-dates.js), so they never disagree.
//   1. official end field or a literal end date in textFin          -> firm ('api')
//   2. a relative term in textFin, from the start/registration date -> estimated ('computed')
//   3. the same two, read from the bases' plazo sentence            -> estimated ('computed')
// A known end date decides the status; BDNS's `abierto` only counts when there is none,
// because it goes stale. Direct awards are never OPEN.
export function deadlineFor(detail, { openDate = null, basesText = null, today = new Date().toISOString().slice(0, 10) } = {}) {
  let deadline = null, source = null, confirmed = 0;
  const base = (detail.fechaInicioSolicitud || detail.fechaRecepcion || openDate || '').slice(0, 10);
  const literalEnd = endDateFromDetail(detail);
  if (literalEnd) {
    deadline = literalEnd; source = 'api'; confirmed = 1;
  } else {
    let term = parsePlazoTerm(detail.textFin);
    let fromBases = null;
    if (!term) {
      const sentence = plazoFromBases(basesText);
      fromBases = parseEndDate(sentence, detail.fechaRecepcion);
      if (!fromBases) term = parsePlazoTerm(sentence);
    }
    if (fromBases) { deadline = fromBases; source = 'computed'; confirmed = 0; }
    else if (term && base) {
      deadline = computeDeadline(base, term);   // no local fiestas at compute time; operator reviews
      source = 'computed'; confirmed = 0;
    }
  }
  const status = isDirectAward(detail) ? 'CLOSED'
    : deadline ? (deadline >= today ? 'OPEN' : 'CLOSED')
    : saysClosed(detail) ? 'CLOSED' : detail.abierto ? 'OPEN' : 'ANNOUNCED';
  return { deadline, source, confirmed, status };
}

export const ELIGIBILITY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['titulo_claro', 'resumen', 'explicacion', 'documentos_necesarios', 'entity_types', 'funds_what', 'territory_scope', 'pop_min', 'pop_max', 'category'],
  properties: {
    titulo_claro: { type: 'string', description: 'Titular en castellano llano de MENOS de 80 caracteres que diga para qué sirve la ayuda, como se lo explicarías a un vecino. Nada de "Orden de 14 de agosto de 2026, de la Consejería de...". Ejemplo: "Ayudas para inscribir ganado de razas autóctonas en el libro genealógico". Sin fechas.' },
    resumen: { type: 'string', description: 'Resumen en castellano llano, 2-4 frases: qué paga, para quién, cuánto. NUNCA menciones plazos ni fechas límite.' },
    explicacion: {
      type: 'object',
      additionalProperties: false,
      required: ['para_que', 'quien_puede', 'que_cubre', 'que_no_cubre', 'como_se_pide'],
      description: 'Explicación para alguien sin formación jurídica: un alcalde de pueblo o el presidente de una asociación. Nada de jerga administrativa. Prohibido mencionar plazos, fechas o cómputos de días.',
      properties: {
        para_que: { type: 'string', description: '2-3 frases: para qué sirve esta ayuda y qué problema resuelve, en lenguaje de calle.' },
        quien_puede: { type: 'string', description: '1-3 frases: quién puede pedirla, con ejemplos concretos (ayuntamientos pequeños, asociaciones culturales, clubes deportivos, ganaderos...). Si hay límite de población o requisitos raros, dilo claro.' },
        que_cubre: { type: 'string', description: '1-3 frases: qué gastos paga y cuánto dinero se puede recibir. Si hay que poner dinero propio (cofinanciación), dilo.' },
        que_no_cubre: { type: 'string', description: '1-2 frases: exclusiones o gastos que NO entran. Si las bases no lo dicen, escribe exactamente "No se especifica en las bases."' },
        como_se_pide: { type: 'string', description: '1-2 frases: cómo se solicita (sede electrónica, papel, qué documentación básica). Sin fechas. Si no consta, escribe exactamente "No se especifica en las bases."' },
      },
    },
    documentos_necesarios: {
      type: 'array',
      description: 'Checklist de "¿qué papeles necesito?" para pedirla: solo documentos que las bases mencionen explícitamente. Si las bases no detallan documentación, devuelve un array vacío - no inventes trámites genéricos. Prohibido mencionar plazos o fechas.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['documento', 'para_que_sirve', 'donde_conseguirlo'],
        properties: {
          documento: { type: 'string', description: 'Nombre del documento tal como lo entendería un vecino, p.ej. "Certificado de estar al corriente con Hacienda".' },
          para_que_sirve: { type: 'string', description: '1 frase: por qué lo piden.' },
          donde_conseguirlo: { type: 'string', description: '1 frase: dónde o cómo se consigue (p.ej. "Sede electrónica de la Agencia Tributaria", "Ayuntamiento", "Ya lo tiene la entidad si está al día"). Si no consta, escribe exactamente "No se especifica en las bases."' },
        },
      },
    },
    entity_types: { type: 'array', items: { type: 'string', enum: ['Ayuntamiento', 'Junta_Vecinal', 'Asociacion', 'Club_Deportivo', 'AMPA', 'Otro'] } },
    funds_what: { type: 'array', items: { type: 'string' }, description: 'p.ej. obra, mobiliario, actividad, equipamiento, contratación' },
    territory_scope: { type: 'string', description: 'provincia / comarca / CCAA / municipio concreto' },
    pop_min: { type: ['integer', 'null'] },
    pop_max: { type: ['integer', 'null'] },
    category: { type: 'string', description: 'una etiqueta corta: cultura, deporte, empleo, infraestructura, medio ambiente, social, otros' },
  },
};

export const EXTRACT_SYSTEM = 'Eres un analista de subvenciones públicas españolas. Extraes elegibilidad y resumen de convocatorias para entidades locales rurales (ayuntamientos pequeños, juntas vecinales, asociaciones). Responde SOLO con el JSON pedido. Prohibido calcular, estimar o mencionar plazos o fechas límite en cualquier campo.';

// Exported so model comparisons run the real prompt rather than a drifting copy.
export function extractContext(grant, detail, basesText) {
  return [
    `Título: ${grant.title}`,
    `Órgano: ${grant.granting_body || ''}`,
    `Finalidad BDNS: ${detail.descripcionFinalidad || ''}`,
    `Tipos de beneficiarios BDNS: ${JSON.stringify(detail.tiposBeneficiarios || [])}`,
    `Sectores BDNS: ${JSON.stringify(detail.sectores || [])}`,
    `Presupuesto total: ${detail.presupuestoTotal ?? 'n/d'}`,
    basesText ? `\n--- TEXTO DE LAS BASES (extracto) ---\n${basesText.slice(0, 60000)}` : '',
  ].join('\n');
}

async function llmExtract(context) {
  const response = await anthropic.messages.create({
    model: MODEL,
    // 4096, not 2048: production logged 20 "Unterminated string" truncation failures on
    // 2026-08-26 from verbose grants running past 2048 mid-JSON (ingest_alert, source
    // 'backfill'). The schema has five explicacion subfields plus a checklist array -
    // headroom here is cheap, a silently-dropped grant is not.
    max_tokens: 4096,
    system: EXTRACT_SYSTEM,
    output_config: { format: { type: 'json_schema', schema: ELIGIBILITY_SCHEMA } },
    messages: [{ role: 'user', content: context }],
  });
  const text = response.content.find(b => b.type === 'text')?.text || '{}';
  return JSON.parse(text);
}

// -- Deterministic phase: BDNS detail, deadline, bases PDF, territory. No LLM call, and it
// writes every column enrichment owns EXCEPT the LLM-derived ones (ai_summary, plain_*,
// category, grant_eligibility) - those land later via applyAiResult(), once the batch this
// feeds (enrichBatch, below) returns. Writing here means a grant is never left as a bare
// stub if that batch times out or the process restarts: deadline/status/territory/raw_text
// are already durable, and only the plain-language fields are missing - the same condition
// scripts/backfill-batch.js already sweeps up by default.
//
// `detail` may be supplied by the caller: the poller already fetches it to screen
// convocatorias before paying for extraction, and re-fetching would double the
// request count against an API that is known to block noisy clients.
export async function prepareEnrichment(grantId, bdnsRef, { detail: pre } = {}) {
  const grant = db.prepare('SELECT * FROM grant_row WHERE id = ?').get(grantId);
  const detail = pre || await bdnsGet('/convocatorias', { numConv: bdnsRef });

  // -- bases PDF text --
  let basesText = null;
  const doc = (detail.documentos || [])[0];
  if (doc) {
    try {
      const buf = await bdnsGet('/convocatorias/documentos', { idDocumento: String(doc.id) }, { binary: true });
      basesText = (await pdfParse(buf)).text;
    } catch (e) {
      alert('fetch_bases', `convocatoria ${bdnsRef} doc ${doc.id}: ${e.message}`);
    }
  }

  // -- deadline + status (deterministic only; see deadlineFor) --
  const today = new Date().toISOString().slice(0, 10);
  const { deadline, source, confirmed, status } = deadlineFor(detail, { openDate: grant.open_date, basesText, today });
  // A grant can arrive already past its deadline (late discovery) - stamp closed_at now
  // so the archive sweep in server.js still picks it up 24h later instead of never.
  const closedAt = status === 'CLOSED' ? new Date().toISOString() : null;

  // Links. BDNS gives no per-convocatoria application URL: `sedeElectronica` is the
  // organism's generic portal root and `urlBasesReguladoras` is the framework rules,
  // often years older than this call. Neither belongs on a "ver convocatoria" button,
  // so the canonical link stays the BDNS page (grant.source_url) and these are stored
  // separately, as secondary links, with their occasional malformed scheme repaired.
  // Territory. An ayuntamiento's call is open to that town alone, and BDNS names the town
  // in the organism path, so resolve it against the INE dictionary — that also supplies
  // the province in the cases where `regiones` only gave the comunidad.
  const territory = territoryFromRegiones(detail.regiones, detail.organo?.nivel1);
  const muni = municipioFromBody(grant.granting_body);
  if (muni) {
    territory.province ||= muni.province;
    territory.ccaa ||= muni.ccaa;
  }

  const cleanUrl = (u) => {
    if (typeof u !== 'string' || !u.trim()) return null;
    const fixed = u.trim().replace(/^(https?:)\/(?!\/)/, '$1//');
    return /^https?:\/\/[^/]+/.test(fixed) ? fixed : null;
  };

  db.prepare(`UPDATE grant_row SET
      deadline_date = ?, deadline_source = ?, deadline_confirmed = ?, status = ?,
      -- re-enrichment (scripts/reenrich.js) must not push closed_at forward each run
      closed_at = COALESCE(closed_at, ?),
      budget_total = ?, application_url = COALESCE(?, application_url),
      sede_url = COALESCE(?, sede_url), raw_text = ?,
      region = COALESCE(?, region), province = COALESCE(?, province),
      municipality = COALESCE(?, municipality), is_rolling = ?
    WHERE id = ?`)
    .run(deadline, source, confirmed, status, closedAt,
      detail.presupuestoTotal ?? null,
      cleanUrl(detail.urlBasesReguladoras), cleanUrl(detail.sedeElectronica),
      basesText ? basesText.slice(0, 200000) : null,
      territory.ccaa, territory.province, muni?.name || null,
      detail.plazoIndefinido ? 1 : 0, grantId);

  console.log(`prepared ${bdnsRef}: deadline=${deadline ?? '—'} (${source ?? 'none'}), status=${status}`);
  return { grantId, bdnsRef, context: extractContext(grant, detail, basesText) };
}

// -- LLM phase: writes only the fields the LLM owns. Same field set as
// scripts/backfill-batch.js's applyResult, deliberately — a batch that never comes back
// (timeout, crash) leaves rows exactly in the state that script's default selection
// already looks for ("missing plain-language fields"), so it doubles as the recovery path.
export function applyAiResult(grantId, bdnsRef, ai) {
  db.prepare(`UPDATE grant_row SET
      ai_summary = COALESCE(?, ai_summary), plain_title = COALESCE(?, plain_title),
      plain_explainer = COALESCE(?, plain_explainer), plain_checklist = COALESCE(?, plain_checklist),
      category = COALESCE(?, category)
    WHERE id = ?`)
    .run(ai.resumen || null, ai.titulo_claro?.trim() || null,
      ai.explicacion ? JSON.stringify(ai.explicacion) : null,
      ai.documentos_necesarios ? JSON.stringify(ai.documentos_necesarios) : null,
      ai.category || null, grantId);

  // One eligibility row per grant. Enrichment is re-runnable (schema changes, retries),
  // and a plain INSERT would leave a second row that duplicates the grant in every
  // LEFT JOIN behind the public list and the panel.
  db.prepare('DELETE FROM grant_eligibility WHERE grant_id = ?').run(grantId);
  db.prepare(`INSERT INTO grant_eligibility (id, grant_id, entity_types, pop_min, pop_max, territory_scope, funds_what, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(uuid(), grantId, JSON.stringify(ai.entity_types || []), ai.pop_min ?? null, ai.pop_max ?? null,
      ai.territory_scope || null, JSON.stringify(ai.funds_what || []), null);
  suggestMatches(grantId);
  console.log(`enriched ${bdnsRef}: ai=ok`);
}

// Single-grant path: scripts/reenrich.js and anywhere else that needs one grant enriched
// immediately, at list price, rather than queued into the nightly batch.
export async function enrichGrant(grantId, bdnsRef, opts = {}) {
  const { context } = await prepareEnrichment(grantId, bdnsRef, opts);
  try {
    applyAiResult(grantId, bdnsRef, await llmExtract(context));
  } catch (e) {
    alert('extract', `convocatoria ${bdnsRef}: ${e.message}`);
  }
}

// Batch path for the live nightly poll: `prepared` is a list of {grantId, bdnsRef, context}
// already produced by prepareEnrichment (deterministic fields already durable). One Batch
// API call for the whole night's arrivals — half price, and nothing here is waiting on the
// response — then poll for completion and write back each result as it lands.
const BATCH_POLL_MS = Number(process.env.INGEST_BATCH_POLL_MS || 60_000);
const BATCH_TIMEOUT_MS = Number(process.env.INGEST_BATCH_TIMEOUT_MS || 2 * 60 * 60_000);

// pdf-parse occasionally leaves a NUL byte in extracted bases text from a malformed PDF -
// same root cause that rolled back an entire Postgres job-insert transaction on
// 2026-09-01 (src/ingest/queue.js's stripNul). Untested whether the Batch API's JSONL
// upload tolerates a raw NUL byte any better than Postgres text columns did; stripping it here
// costs nothing and this context-building code is shared with the path that already
// proved it doesn't.
const NUL = String.fromCharCode(0);
const stripNul = (s) => s.split(NUL).join('');

export async function enrichBatch(prepared) {
  if (!prepared.length) return { enriched: 0, failed: 0 };

  const batch = await anthropic.messages.batches.create({
    requests: prepared.map(p => ({
      custom_id: p.grantId,
      params: {
        model: MODEL,
        // 4096, not 2048: production logged 20 "Unterminated string" truncation failures on
    // 2026-08-26 from verbose grants running past 2048 mid-JSON (ingest_alert, source
    // 'backfill'). The schema has five explicacion subfields plus a checklist array -
    // headroom here is cheap, a silently-dropped grant is not.
    max_tokens: 4096,
        system: EXTRACT_SYSTEM,
        output_config: { format: { type: 'json_schema', schema: ELIGIBILITY_SCHEMA } },
        messages: [{ role: 'user', content: stripNul(p.context) }],
      },
    })),
  });
  console.log(`enrich batch ${batch.id}: ${prepared.length} request(s) submitted`);

  const giveUpAt = Date.now() + BATCH_TIMEOUT_MS;
  let b;
  for (;;) {
    b = await anthropic.messages.batches.retrieve(batch.id);
    if (b.processing_status === 'ended') break;
    if (Date.now() > giveUpAt) {
      alert('extract', `batch ${batch.id} still ${b.processing_status} after `
        + `${Math.round(BATCH_TIMEOUT_MS / 60_000)}min — leaving ${prepared.length} grant(s) `
        + `for the next backfill-batch.js sweep`);
      return { enriched: 0, failed: prepared.length };
    }
    await new Promise(r => setTimeout(r, BATCH_POLL_MS));
  }

  const byId = new Map(prepared.map(p => [p.grantId, p]));
  let enriched = 0, failed = 0;
  for await (const r of await anthropic.messages.batches.results(batch.id)) {
    const p = byId.get(r.custom_id);
    if (!p) continue;
    if (r.result.type !== 'succeeded') {
      failed++;
      alert('extract', `convocatoria ${p.bdnsRef}: batch ${r.result.type} ${r.result.error?.type || ''}`);
      continue;
    }
    const text = r.result.message.content.find(c => c.type === 'text')?.text;
    try {
      applyAiResult(p.grantId, p.bdnsRef, JSON.parse(text || '{}'));
      enriched++;
    } catch (e) {
      failed++;
      alert('extract', `convocatoria ${p.bdnsRef}: unparseable extract (${e.message})`);
    }
  }
  return { enriched, failed };
}
