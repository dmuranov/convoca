// Enrichment chain for one licitación: feed entry (already fetched by pollLicitaciones) ->
// pliegos (PCAP/PPT) PDF text -> LLM summary, aimed at the bidder (licitador) reading the
// public directory, never the contracting body.
//
// Deviates from the original product spec in two ways, both to stay consistent with how
// grant_row/enrich.js already treats numbers and dates:
//   - importe, plazo_presentacion, duracion_contrato, lugar, organo and procedimiento are
//     NOT LLM output fields. The feed gives every one of them deterministically
//     (placsp.js's parseEntry), so asking the model to transcribe them back out only risks
//     drift (a moved decimal, a reworded date) for zero benefit. They're still fed into
//     the model's *input* context so resumen/que_hay_que_hacer can reference them in prose.
//   - resumen/titulo/quien_puede_interesarle are typed string|null (not string), matching
//     the "objeto vacío -> resumen: null" edge case the spec itself calls for - the
//     original schema draft left them non-nullable, which a strict json_schema would have
//     rejected the moment that edge case actually fired.
import { createRequire } from 'node:module';
import { db, uuid } from '../db.js';
import { alert } from './bdns.js';
import { anthropic, MODEL } from '../llm.js';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

const ESTADO_LABEL = {
  anuncio_previo: 'Anuncio previo (todavía no se puede presentar oferta)',
  licitacion: 'En plazo (aceptando ofertas)',
  pendiente_adjudicacion: 'Plazo de presentación cerrado, pendiente de adjudicación',
  adjudicada: 'Adjudicada',
  resuelta: 'Resuelta y formalizada',
  anulada: 'Anulada',
};

export const EXTRACT_SYSTEM = `Eres un asistente que resume licitaciones públicas españolas para pequeñas empresas,
autónomos y asociaciones que podrían presentarse a ellas. Tus lectores no son juristas ni
técnicos de contratación: son un carpintero, una empresa de jardinería de tres personas,
una asociación cultural. Escriben y leen en español llano.

Tu única tarea es convertir un registro de la Plataforma de Contratación del Sector
Público en un resumen claro. Los datos duros (importe, plazo, órgano, procedimiento,
lugar) ya están resueltos fuera de ti y se muestran aparte; tu trabajo es la parte en
prosa: título, resumen, a quién le interesa, qué hay que hacer y qué pide.

REGLAS ABSOLUTAS

1. No inventes nada. Si el objeto o los pliegos no dan para escribir un resumen fiable,
   devuelve resumen y titulo como null y anótalo en campos_ausentes. Nunca rellenes con
   generalidades para no dejar un campo vacío.
2. No copies literalmente el objeto del contrato. Reescríbelo en palabras normales.
   "Servicio de mantenimiento de zonas verdes" se dice como "cortar el césped y mantener
   los jardines del municipio".
3. Puedes mencionar cifras, fechas o duración en el resumen o las tareas si ayudan a
   entender el encargo (ya vienen en la entrada), pero repítelas EXACTAMENTE como
   aparecen. No las calcules, no las conviertas, no las redondees, no las reproduzcas
   como campo aparte - eso ya está resuelto fuera de ti.
4. No des asesoramiento jurídico. No digas si alguien puede o no presentarse, si es buena
   idea, ni cómo interpretar un pliego. Describe lo que pide el anuncio.
5. No adviertas sobre plazos vencidos ni cuentes días.
6. El estado del expediente viene dado en la entrada. No lo infieras del texto ni de los
   nombres de los documentos adjuntos (p.ej. una "Resolución de rectificación" no
   significa que el expediente haya cambiado de estado).
7. Devuelve únicamente el objeto JSON pedido.

TONO

Español neutro y directo. Frases cortas. Nada de "el presente procedimiento tiene por
objeto". Traduce la jerga: "solvencia técnica" es "experiencia que tienes que demostrar";
"garantía definitiva" es "dinero que hay que depositar si te lo adjudican". Si un término
administrativo no tiene traducción sencilla, úsalo y explícalo entre paréntesis la
primera vez.

ESTADO Y TIEMPO VERBAL

- "En plazo": resumen y tareas en presente/futuro, orientado a quien todavía puede
  presentarse.
- "Plazo de presentación cerrado, pendiente de adjudicación" o "Anulada": el plazo ya no
  importa y nadie puede presentarse ya. Resume qué se pedía, sin invitar a presentarse.
- "Adjudicada" o "Resuelta y formalizada": resume en pasado - qué se contrató y, si
  consta en la entrada, a quién.
- "Anuncio previo": dilo explícitamente en el resumen - todavía no es una licitación
  abierta, es un aviso de que se va a convocar.

CASOS LÍMITE

- Contrato dividido en varios lotes: resume el conjunto y menciona el número de lotes en
  el resumen. No inventes un resumen por lote.
- Texto en catalán, gallego o euskera: resume en castellano. No traduzcas nombres propios
  ni el nombre del órgano.
- Es una modificación de un expediente ya visto: resume el estado actual tal cual llega,
  sin comparar con ninguna versión anterior ni mencionar que ha cambiado.

COMPLEJIDAD

La única valoración que emites, anclada al procedimiento y las condiciones tal como
llegan en la entrada, no a intuición:
- "baja": Contrato menor, o procedimiento simplificado sin más condiciones señaladas.
- "media": Abierto simplificado, o un procedimiento con solvencia técnica/económica
  exigida pero sin clasificación empresarial ni varios lotes.
- "alta": clasificación empresarial exigida, varios lotes, un procedimiento con
  negociación o diálogo competitivo, o una duración superior a un año.
Si la entrada no da para situarlo con estos criterios, usa "media" y dilo en
complejidad_motivo.

campos_ausentes es control de calidad: si un mismo campo aparece ausente en muchos
registros, el problema está en el análisis del feed, no en ti.`;

export function extractContext(lic) {
  const budget = [
    lic.presupuestoBase != null
      ? `Presupuesto base: ${lic.presupuestoBase} EUR (${lic.iva === 'incluido' ? 'IVA incluido' : lic.iva === 'excluido' ? 'IVA excluido' : 'no consta si incluye IVA'})`
      : null,
    lic.valorEstimado != null ? `Valor estimado del contrato (incluye posibles prórrogas/modificaciones): ${lic.valorEstimado} EUR` : null,
  ].filter(Boolean).join('\n');

  return [
    `Expediente: ${lic.expediente}`,
    `Estado: ${ESTADO_LABEL[lic.estado] || lic.estado}`,
    `Órgano de contratación: ${lic.organo || 'no consta'}`,
    `Tipo de contrato: ${lic.tipoContrato || 'no consta'}`,
    `Procedimiento: ${lic.procedimiento || 'no consta'}`,
    `CPV: ${lic.cpv.join(', ') || 'no consta'}`,
    budget,
    `Plazo de presentación: ${lic.fechaLimite || 'no consta'}`,
    `Lugar de ejecución: ${lic.lugar || 'no consta'}`,
    `Duración: ${lic.duracion || 'no consta'}`,
    `Número de lotes: ${lic.numLotes}`,
    `Objeto: ${lic.titulo || 'no consta'}`,
    lic.rawText ? `\n--- TEXTO DE LOS PLIEGOS (extracto) ---\n${lic.rawText.slice(0, 60000)}` : '',
  ].filter(Boolean).join('\n');
}

export const LICITACION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['titulo', 'resumen', 'quien_puede_interesarle', 'que_hay_que_hacer', 'requisitos_clave', 'complejidad', 'complejidad_motivo', 'campos_ausentes'],
  properties: {
    titulo: { type: ['string', 'null'], description: 'Máx. 70 caracteres, lo que se contrata en lenguaje normal. Ejemplo: "Vigilar a los niños en el comedor de varios colegios". Null si el objeto no da para un título fiable.' },
    resumen: { type: ['string', 'null'], description: '2-3 frases: qué hay que hacer, para quién y dónde. Tiempo verbal según el estado (ver reglas). Null si el objeto viene vacío o es solo un código.' },
    quien_puede_interesarle: { type: ['string', 'null'], description: 'Una frase describiendo el tipo de empresa o profesional que hace este trabajo. Nunca nombres concretos.' },
    // minItems/maxItems are NOT supported on 'array' in Anthropic's structured-output
    // schema (confirmed against the live API - a real request errored on this exact
    // field), same reason ELIGIBILITY_SCHEMA's arrays don't use them either. The 3-5 /
    // 0-4 bounds live in the description text instead.
    que_hay_que_hacer: { type: 'array', items: { type: 'string' }, description: '3 a 5 tareas concretas extraídas del objeto y los pliegos. Vacío si no hay base para extraerlas.' },
    requisitos_clave: { type: 'array', items: { type: 'string' }, description: '0 a 4 requisitos en llano, solo si son específicos de esta licitación. "Estar dado de alta como empresa" no es un requisito clave; es ruido - mejor vacío que relleno.' },
    complejidad: { type: 'string', enum: ['baja', 'media', 'alta'] },
    complejidad_motivo: { type: 'string', description: 'Una frase justificando la etiqueta anterior con los criterios dados (procedimiento, lotes, duración).' },
    campos_ausentes: { type: 'array', items: { type: 'string' }, description: 'Nombres de los campos que faltaban en la entrada o los pliegos (p.ej. "objeto", "pliegos", "requisitos").' },
  },
};

async function llmExtract(context) {
  const response = await anthropic.messages.create({
    model: MODEL,
    // Matches enrich.js's 4096 (bumped after production truncation failures on the
    // BDNS side with the same shape of schema) rather than risk the same failure mode
    // here before it's ever been observed.
    max_tokens: 4096,
    system: EXTRACT_SYSTEM,
    output_config: { format: { type: 'json_schema', schema: LICITACION_SCHEMA } },
    messages: [{ role: 'user', content: context }],
  });
  const text = response.content.find(b => b.type === 'text')?.text || '{}';
  return JSON.parse(text);
}

const PLIEGO_THROTTLE_MS = Number(process.env.PLACSP_PLIEGO_THROTTLE_MS || 500);
const PLIEGO_HEADERS = { 'User-Agent': 'convoca/1.0 (plazoabierto.es)' };

async function fetchPliegosText(pliegos, expediente) {
  const parts = [];
  for (const p of pliegos) {
    try {
      const res = await fetch(p.url, { headers: PLIEGO_HEADERS, signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const { text: t } = await pdfParse(buf);
      if (t) parts.push(`[${p.nombre}]\n${t}`);
    } catch (e) {
      alert('fetch_pliego', `expediente ${expediente} ${p.nombre}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, PLIEGO_THROTTLE_MS));
  }
  return parts.join('\n\n') || null;
}

// -- Deterministic phase: upserts every column except the AI-owned ones. `lic` is a
// parsed feed entry from placsp.js. Fetches and stores the pliegos PDF text here so it is
// durable before the batch call - same reasoning as prepareEnrichment in enrich.js.
export async function prepareEnrichment(lic) {
  const rawText = lic.pliegos.length ? await fetchPliegosText(lic.pliegos, lic.expediente) : null;

  const existing = db.prepare('SELECT id FROM licitacion_row WHERE expediente = ?').get(lic.expediente);
  const id = existing?.id || uuid();

  db.prepare(`INSERT INTO licitacion_row
      (id, expediente, source_url, updated_at, estado, organo, tipo_contrato, procedimiento,
       cpv, valor_estimado, presupuesto_base, iva, fecha_limite, lugar, duracion, num_lotes,
       pliegos, raw_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(expediente) DO UPDATE SET
      source_url = excluded.source_url, updated_at = excluded.updated_at,
      estado = excluded.estado, organo = excluded.organo,
      tipo_contrato = excluded.tipo_contrato, procedimiento = excluded.procedimiento,
      cpv = excluded.cpv, valor_estimado = excluded.valor_estimado,
      presupuesto_base = excluded.presupuesto_base, iva = excluded.iva,
      fecha_limite = excluded.fecha_limite, lugar = excluded.lugar,
      duracion = excluded.duracion, num_lotes = excluded.num_lotes,
      pliegos = excluded.pliegos, raw_text = excluded.raw_text`)
    .run(id, lic.expediente, lic.sourceUrl, lic.updated, lic.estado, lic.organo,
      lic.tipoContrato, lic.procedimiento, JSON.stringify(lic.cpv), lic.valorEstimado,
      lic.presupuestoBase, lic.iva, lic.fechaLimite, lic.lugar, lic.duracion, lic.numLotes,
      JSON.stringify(lic.pliegos), rawText);

  console.log(`prepared ${lic.expediente}: estado=${lic.estado}, pliegos=${lic.pliegos.length}, rawText=${rawText ? rawText.length + 'ch' : 'none'}`);
  return { id, expediente: lic.expediente, context: extractContext({ ...lic, rawText }) };
}

function applyAiResult(expediente, ai) {
  db.prepare(`UPDATE licitacion_row SET
      titulo = ?, resumen = ?, quien_puede_interesarle = ?, que_hay_que_hacer = ?,
      requisitos_clave = ?, complejidad = ?, complejidad_motivo = ?, campos_ausentes = ?
    WHERE expediente = ?`)
    .run(ai.titulo || null, ai.resumen || null, ai.quien_puede_interesarle || null,
      JSON.stringify(ai.que_hay_que_hacer || []), JSON.stringify(ai.requisitos_clave || []),
      ai.complejidad || null, ai.complejidad_motivo || null,
      JSON.stringify(ai.campos_ausentes || []), expediente);
  console.log(`enriched ${expediente}: complejidad=${ai.complejidad || '—'}`);
}

// Single-licitación path, for manual/backfill use outside the nightly batch.
export async function enrichLicitacion(lic) {
  const { expediente, context } = await prepareEnrichment(lic);
  try {
    applyAiResult(expediente, await llmExtract(context));
  } catch (e) {
    alert('extract', `expediente ${expediente}: ${e.message}`);
  }
}

// Batch path for the nightly poll - one Batch API call for everything new or updated in
// the feed since the last run. See src/ingest/enrich.js's enrichBatch for the reasoning
// (half price, nothing here is waiting synchronously); identical shape, different table.
const BATCH_POLL_MS = Number(process.env.INGEST_BATCH_POLL_MS || 60_000);
const BATCH_TIMEOUT_MS = Number(process.env.INGEST_BATCH_TIMEOUT_MS || 2 * 60 * 60_000);

export async function enrichBatch(prepared) {
  if (!prepared.length) return { enriched: 0, failed: 0 };

  // custom_id must match ^[a-zA-Z0-9_-]{1,64}$ - a real PLACSP expediente does not
  // ("713/2026", "CMA 01/2026" both fail on the slash/space), and the Batch API rejects
  // the WHOLE submission if even one request's custom_id is invalid. Use the row's own
  // uuid (already safe) instead, same as enrich.js does with grantId, and map back to
  // expediente when applying results below.
  const byId = new Map(prepared.map(p => [p.id, p.expediente]));
  const batch = await anthropic.messages.batches.create({
    requests: prepared.map(p => ({
      custom_id: p.id,
      params: {
        model: MODEL,
        // Matches enrich.js's 4096 (bumped after production truncation failures on the
        // BDNS side with the same shape of schema) rather than risk the same failure mode
        // here before it's ever been observed.
        max_tokens: 4096,
        system: EXTRACT_SYSTEM,
        output_config: { format: { type: 'json_schema', schema: LICITACION_SCHEMA } },
        messages: [{ role: 'user', content: p.context }],
      },
    })),
  });
  console.log(`licitacion batch ${batch.id}: ${prepared.length} request(s) submitted`);

  const giveUpAt = Date.now() + BATCH_TIMEOUT_MS;
  let b;
  for (;;) {
    b = await anthropic.messages.batches.retrieve(batch.id);
    if (b.processing_status === 'ended') break;
    if (Date.now() > giveUpAt) {
      alert('extract', `licitacion batch ${batch.id} still ${b.processing_status} after `
        + `${Math.round(BATCH_TIMEOUT_MS / 60_000)}min — ${prepared.length} expediente(s) left unsummarised this run`);
      return { enriched: 0, failed: prepared.length };
    }
    await new Promise(r => setTimeout(r, BATCH_POLL_MS));
  }

  let enriched = 0, failed = 0;
  for await (const r of await anthropic.messages.batches.results(batch.id)) {
    const expediente = byId.get(r.custom_id);
    if (!expediente) continue;
    if (r.result.type !== 'succeeded') {
      failed++;
      alert('extract', `expediente ${expediente}: batch ${r.result.type} ${r.result.error?.type || ''}`);
      continue;
    }
    const text = r.result.message.content.find(c => c.type === 'text')?.text;
    try {
      applyAiResult(expediente, JSON.parse(text || '{}'));
      enriched++;
    } catch (e) {
      failed++;
      alert('extract', `expediente ${expediente}: unparseable extract (${e.message})`);
    }
  }
  return { enriched, failed };
}
