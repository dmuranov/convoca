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

const ELIGIBILITY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['resumen', 'entity_types', 'funds_what', 'territory_scope', 'pop_min', 'pop_max', 'category'],
  properties: {
    resumen: { type: 'string', description: 'Resumen en castellano llano, 2-4 frases: qué paga, para quién, cuánto. NUNCA menciones plazos ni fechas límite.' },
    entity_types: { type: 'array', items: { type: 'string', enum: ['Ayuntamiento', 'Junta_Vecinal', 'Asociacion', 'Club_Deportivo', 'AMPA', 'Otro'] } },
    funds_what: { type: 'array', items: { type: 'string' }, description: 'p.ej. obra, mobiliario, actividad, equipamiento, contratación' },
    territory_scope: { type: 'string', description: 'provincia / comarca / CCAA / municipio concreto' },
    pop_min: { type: ['integer', 'null'] },
    pop_max: { type: ['integer', 'null'] },
    category: { type: 'string', description: 'una etiqueta corta: cultura, deporte, empleo, infraestructura, medio ambiente, social, otros' },
  },
};

async function llmExtract(grant, detail, basesText) {
  const context = [
    `Título: ${grant.title}`,
    `Órgano: ${grant.granting_body || ''}`,
    `Finalidad BDNS: ${detail.descripcionFinalidad || ''}`,
    `Tipos de beneficiarios BDNS: ${JSON.stringify(detail.tiposBeneficiarios || [])}`,
    `Sectores BDNS: ${JSON.stringify(detail.sectores || [])}`,
    `Presupuesto total: ${detail.presupuestoTotal ?? 'n/d'}`,
    basesText ? `\n--- TEXTO DE LAS BASES (extracto) ---\n${basesText.slice(0, 60000)}` : '',
  ].join('\n');

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: 'Eres un analista de subvenciones públicas españolas. Extraes elegibilidad y resumen de convocatorias para entidades locales rurales (ayuntamientos pequeños, juntas vecinales, asociaciones). Responde SOLO con el JSON pedido. Prohibido calcular, estimar o mencionar plazos o fechas límite en cualquier campo.',
    output_config: { format: { type: 'json_schema', schema: ELIGIBILITY_SCHEMA } },
    messages: [{ role: 'user', content: context }],
  });
  const text = response.content.find(b => b.type === 'text')?.text || '{}';
  return JSON.parse(text);
}

export async function enrichGrant(grantId, bdnsRef) {
  const grant = db.prepare('SELECT * FROM grant_row WHERE id = ?').get(grantId);
  const detail = await bdnsGet('/convocatorias', { numConv: bdnsRef });

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

  db.prepare(`UPDATE grant_row SET
      deadline_date = ?, deadline_source = ?, deadline_confirmed = ?, status = ?,
      budget_total = ?, application_url = COALESCE(?, application_url),
      raw_text = ?, ai_summary = ?, category = COALESCE(?, category),
      is_rolling = ?
    WHERE id = ?`)
    .run(deadline, source, confirmed, status,
      detail.presupuestoTotal ?? null, detail.sedeElectronica || detail.urlBasesReguladoras || null,
      basesText ? basesText.slice(0, 200000) : null, ai?.resumen || null, ai?.category || null,
      detail.plazoIndefinido ? 1 : 0, grantId);

  if (ai) {
    db.prepare(`INSERT INTO grant_eligibility (id, grant_id, entity_types, pop_min, pop_max, territory_scope, funds_what, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(uuid(), grantId, JSON.stringify(ai.entity_types || []), ai.pop_min ?? null, ai.pop_max ?? null,
        ai.territory_scope || null, JSON.stringify(ai.funds_what || []), null);
    suggestMatches(grantId);
  }
  console.log(`enriched ${bdnsRef}: deadline=${deadline ?? '—'} (${source ?? 'none'}), status=${status}, ai=${ai ? 'ok' : 'FAILED'}`);
}
