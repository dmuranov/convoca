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
  cinco: 5, siete: 7, diez: 10, quince: 15, veinte: 20, veinticinco: 25,
  treinta: 30, cuarenta: 40, 'cuarenta y cinco': 45, sesenta: 60, noventa: 90,
  un: 1, uno: 1, dos: 2, tres: 3, seis: 6,
};

// Deterministic parse of a relative plazo out of BDNS textFin / bases text.
export function parsePlazoTerm(text) {
  if (!text) return null;
  const t = text.toLowerCase().replace(/\s+/g, ' ');
  const m = t.match(/(\d{1,3}|[a-záéíóúñ]+(?: y [a-záéíóúñ]+)?) *(?:d[ií]as) *(h[áa]biles|naturales)?|(\d{1,2}|[a-záéíóúñ]+) *(mes(?:es)?)/);
  if (!m) return null;
  if (m[4]) {
    const count = /^\d+$/.test(m[3]) ? Number(m[3]) : NUM_WORDS[m[3]];
    return count ? { count, unit: 'meses', raw: m[0] } : null;
  }
  const count = /^\d+$/.test(m[1]) ? Number(m[1]) : NUM_WORDS[m[1]];
  if (!count) return null;
  const unit = m[2] && m[2].startsWith('h') ? 'habiles' : 'naturales';
  return { count, unit, raw: m[0] };
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

async function llmExtract(grant, detail, basesText) {
  const context = extractContext(grant, detail, basesText);

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: EXTRACT_SYSTEM,
    output_config: { format: { type: 'json_schema', schema: ELIGIBILITY_SCHEMA } },
    messages: [{ role: 'user', content: context }],
  });
  const text = response.content.find(b => b.type === 'text')?.text || '{}';
  return JSON.parse(text);
}

// `detail` may be supplied by the caller: the poller already fetches it to screen
// convocatorias before paying for extraction, and re-fetching would double the
// request count against an API that is known to block noisy clients.
export async function enrichGrant(grantId, bdnsRef, { detail: pre } = {}) {
  const grant = db.prepare('SELECT * FROM grant_row WHERE id = ?').get(grantId);
  const detail = pre || await bdnsGet('/convocatorias', { numConv: bdnsRef });

  // -- deadline (deterministic only) --
  let deadline = null, source = null, confirmed = 0;
  if (detail.fechaFinSolicitud) {
    deadline = detail.fechaFinSolicitud.slice(0, 10);
    source = 'api'; confirmed = 1;
  } else {
    const base = (detail.fechaInicioSolicitud || detail.fechaRecepcion || grant.open_date || '').slice(0, 10);
    const term = parsePlazoTerm(detail.textFin);
    if (term && base) {
      deadline = computeDeadline(base, term);   // no local fiestas at compute time; operator reviews
      source = 'computed'; confirmed = 0;
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  const status = detail.abierto || (deadline && deadline >= today) ? 'OPEN'
    : (deadline && deadline < today) ? 'CLOSED' : 'ANNOUNCED';
  // A grant can arrive already past its deadline (late discovery) - stamp closed_at now
  // so the archive sweep in server.js still picks it up 24h later instead of never.
  const closedAt = status === 'CLOSED' ? new Date().toISOString() : null;

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

  // -- LLM summary + eligibility (never dates) --
  let ai = null;
  try {
    ai = await llmExtract(grant, detail, basesText);
  } catch (e) {
    alert('extract', `convocatoria ${bdnsRef}: ${e.message}`);
  }

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
      sede_url = COALESCE(?, sede_url),
      raw_text = ?, ai_summary = ?, plain_title = COALESCE(?, plain_title),
      plain_explainer = COALESCE(?, plain_explainer),
      plain_checklist = COALESCE(?, plain_checklist),
      region = COALESCE(?, region), province = COALESCE(?, province),
      municipality = COALESCE(?, municipality),
      category = COALESCE(?, category), is_rolling = ?
    WHERE id = ?`)
    .run(deadline, source, confirmed, status, closedAt,
      detail.presupuestoTotal ?? null,
      cleanUrl(detail.urlBasesReguladoras), cleanUrl(detail.sedeElectronica),
      basesText ? basesText.slice(0, 200000) : null, ai?.resumen || null,
      ai?.titulo_claro?.trim() || null,
      ai?.explicacion ? JSON.stringify(ai.explicacion) : null,
      ai?.documentos_necesarios ? JSON.stringify(ai.documentos_necesarios) : null,
      territory.ccaa, territory.province, muni?.name || null,
      ai?.category || null,
      detail.plazoIndefinido ? 1 : 0, grantId);

  if (ai) {
    // One eligibility row per grant. Enrichment is re-runnable (schema changes, retries),
    // and a plain INSERT would leave a second row that duplicates the grant in every
    // LEFT JOIN behind the public list and the panel.
    db.prepare('DELETE FROM grant_eligibility WHERE grant_id = ?').run(grantId);
    db.prepare(`INSERT INTO grant_eligibility (id, grant_id, entity_types, pop_min, pop_max, territory_scope, funds_what, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(uuid(), grantId, JSON.stringify(ai.entity_types || []), ai.pop_min ?? null, ai.pop_max ?? null,
        ai.territory_scope || null, JSON.stringify(ai.funds_what || []), null);
    suggestMatches(grantId);
  }
  console.log(`enriched ${bdnsRef}: deadline=${deadline ?? '—'} (${source ?? 'none'}), status=${status}, ai=${ai ? 'ok' : 'FAILED'}`);
}
