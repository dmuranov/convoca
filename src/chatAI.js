// The assistant understands the question before it searches, and checks what it found.
//
//   1. understand: a small, fast model reads the question (and the conversation) and returns
//      the place, the topic as groups of related Spanish words, who is applying, and whether it
//      is about a business. "energía ourense" -> energía/energética/renovable/autoconsumo/solar...
//      in Ourense; "clubes deportivos galicia" -> a sports club applying, in Galicia.
//   2. search: src/chatSearch.js with those word groups, in that territory, closest first.
//   3. check: the same model reads the best candidates and keeps only those that really answer
//      the question - a shellfish-bed grant is not for sports clubs, a training course is not an
//      energy grant - so "he encontrado N" counts only real matches.
// Any AI step that fails falls back to the plain keyword search, so the chat never breaks.
import { anthropic, MODEL } from './llm.js';
import { searchGrants, placeFromText } from './chatSearch.js';

const CHECK_MAX = 40;   // candidates the check reads

const UNDERSTAND_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['municipality', 'province', 'region', 'topic_groups', 'applicant', 'business'],
  properties: {
    municipality: { type: 'string', description: 'Municipio que nombra o del que habla el usuario, tal como se escribe en español. Vacío si no hay.' },
    province: { type: 'string', description: 'Provincia, si la nombra o se deduce sin duda del municipio. Vacío si no hay.' },
    region: { type: 'string', description: 'Comunidad autónoma, si la nombra o se deduce sin duda. Vacío si no hay.' },
    topic_groups: {
      type: 'array',
      description: 'El tema de la pregunta: un grupo por cada concepto distinto que debe cumplir la convocatoria (una convocatoria que encaje cumple TODOS los grupos). Cada grupo: 3-10 palabras o raíces en español que aparecerían en su título o resumen: el concepto y sus sinónimos concretos. Vacío si solo pregunta por "subvenciones" en un sitio, sin tema.',
      items: { type: 'array', items: { type: 'string' } },
    },
    applicant: { type: 'string', description: 'Quién pide la ayuda si se sabe: persona, familia, estudiante, autonomo, empresa, asociacion, club deportivo, ampa, ayuntamiento, entidad sin animo de lucro... Vacío si no se sabe.' },
    business: { type: 'boolean', description: 'true si quien pregunta es o quiere montar una empresa, autónomo, comercio, bar, alojamiento, explotación...' },
  },
};

const UNDERSTAND_SYSTEM = `Lees la pregunta de alguien que busca subvenciones o ayudas públicas en España y la conviertes en una búsqueda.
Si la pregunta continúa la conversación ("¿y en Soria?", "¿y para empresas?"), usa la conversación previa para completar lo que falte.
Para el tema, piensa en cómo se titulan de verdad las convocatorias: "energía" -> energía, energética, eficiencia energética, renovable, autoconsumo, fotovoltaica, solar, placas, aislamiento, climatización; "clubes deportivos" -> deporte, deportivo, deportiva, club, federado, competición, equipaciones, instalaciones deportivas.
Un grupo por concepto, y cada grupo concreto: "ordenador para estudiantes" son DOS grupos, [ordenador, portatil, informatico, tablet, dispositivo, equipo informatico] y [estudiante, alumno, escolar, universitario]. Nunca metas palabras demasiado generales (educacion, formacion, social, cultura, ayuda, apoyo, programa) en el grupo de un concepto más concreto: harían que encaje cualquier cosa.
Los nombres propios de programas, entidades o patrocinadores son un grupo propio y se conservan siempre: "becas santander doctorado" -> [santander] y [doctorado, doctorando, predoctoral, tesis doctoral]; también Erasmus, LEADER, Next Generation, etc.
No pongas en el tema palabras del lugar ni palabras genéricas como ayuda, subvención, convocatoria, beca (salvo que sea lo que distingue), gobierno, junta o ayuntamiento.`;

const CHECK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['relevant'],
  properties: { relevant: { type: 'array', items: { type: 'integer' }, description: 'Números [n] de las convocatorias que responden de verdad a la pregunta.' } },
};
const CHECK_SYSTEM = `Recibes una pregunta y una lista numerada de convocatorias abiertas. Devuelve SOLO los números de las que tratan de verdad de lo que se pregunta.
- Juzga por el TEMA de la convocatoria (su título y resumen): tiene que ser aquello que se busca. Una convocatoria que solo menciona de pasada una palabra de la pregunta no cuenta.
- El territorio ya está filtrado: no descartes ninguna por el lugar.
- El campo "Quién puede pedirla" sale de una extracción automática y puede estar mal: si el tema no encaja, descártala aunque ese campo incluya a quien pregunta; si el tema encaja, inclúyela aunque no sepas si quien pregunta cumple todos los requisitos.
- Si la pregunta es de alguien con un negocio o que quiere montarlo, cuenta también toda convocatoria que le ayudaría a montarlo, ampliarlo o mantenerlo en ese territorio (locales, creación de empresas, LEADER, contratación, digitalización...), aunque no nombre su tipo de negocio.
- En caso de duda razonable sobre el tema, inclúyela; descarta solo lo que claramente trata de otra cosa.
- Si ninguna encaja, devuelve una lista vacía.`;

async function askJson(system, content, schema, maxTokens = 800) {
  const r = await anthropic.messages.create({
    // temperature 0: the same question must get the same reading and the same answer.
    model: MODEL, max_tokens: maxTokens, system, temperature: 0,
    output_config: { format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content }],
  });
  return JSON.parse(r.content.find(b => b.type === 'text')?.text || '{}');
}

// The understood place, resolved against our own dictionaries (never trusted as free text).
function placeFromUnderstanding(u) {
  if (u.municipality) {
    const p = placeFromText(`en ${u.municipality}${u.province ? ` ${u.province}` : ''}`);
    if (p?.name) return p;
  }
  if (u.province) { const p = placeFromText(u.province); if (p) return p; }
  if (u.region) { const p = placeFromText(u.region); if (p) return p; }
  return null;
}

const summaryLine = (g) => [
  `${g.plain_title || g.title}`,
  `   Resumen: ${(g.ai_summary || '').slice(0, 260)}`,
  `   Quién puede pedirla: ${g.entity_types || 'n/d'} | Ámbito: ${[g.region, g.province, g.municipality].filter(Boolean).join(' / ') || 'n/d'}`,
].join('\n');

// -> same shape as searchGrants(): { place, business, fallback, terms, total, grants, ai }
export async function understandAndSearch(message, past = [], { place: pickedPlace = null, section = null } = {}) {
  let u = null;
  try {
    const convo = past.slice(-6).map(m => `${m.role === 'user' ? 'Usuario' : 'Asistente'}: ${m.content.slice(0, 400)}`).join('\n');
    u = await askJson(UNDERSTAND_SYSTEM, `${convo ? `Conversación previa:\n${convo}\n\n` : ''}Pregunta: ${message}`, UNDERSTAND_SCHEMA);
  } catch (e) {
    console.warn('chatAI: understand failed:', e.message);
  }
  const place = pickedPlace || (u && placeFromUnderstanding(u)) || placeFromText(message)
    || [...past].reverse().filter(m => m.role === 'user').map(m => placeFromText(m.content)).find(Boolean) || null;
  if (!u) return { ...searchGrants(message, { place, section }), ai: false };

  const groups = (u.topic_groups || []).filter(g => Array.isArray(g) && g.length);
  const business = !!u.business || section === 'negocios';
  const found = searchGrants(message, { place, section, groups, business });
  // No topic and not a business question ("subvenciones en Granada"): everything in the area is
  // the answer, closest first. A business question with no topic is still checked below.
  if (!groups.length && !business) return { ...found, applicant: u.applicant || null, ai: true };

  // Candidates: the topic matches, best first; for a business question also the area's other
  // business grants (a local-premises or rural-business grant helps a new bar without naming bars).
  let candidates = found.fallback ? [] : found.grants.slice(0, CHECK_MAX);
  if (business && candidates.length < CHECK_MAX) {
    const seen = new Set(candidates.map(g => g.id));
    const area = searchGrants(message, { place, section, groups: [], business: true }).grants.filter(g => !seen.has(g.id));
    candidates = [...candidates, ...area].slice(0, CHECK_MAX);
  }
  if (!candidates.length) return { ...found, total: 0, grants: [], applicant: u.applicant || null, ai: true };

  // Check the candidates; keep only the real matches.
  try {
    const list = candidates.map((g, i) => `[${i + 1}] ${summaryLine(g)}`).join('\n\n');
    const who = u.applicant ? ` (quien pregunta: ${u.applicant})` : '';
    const concepts = groups.map(g => g.slice(0, 4).join('/')).join(' + ') || 'cualquier ayuda útil para su negocio';
    const { relevant = [] } = await askJson(CHECK_SYSTEM,
      `Pregunta: ${message}${who}\nConceptos buscados: ${concepts}${business ? '\nQuien pregunta tiene o quiere montar un negocio.' : ''}\n\nConvocatorias:\n${list}`, CHECK_SCHEMA, 400);
    const keep = [...new Set(relevant)].filter(n => n >= 1 && n <= candidates.length).sort((a, b) => a - b);
    const grants = keep.map(n => candidates[n - 1]);
    return { ...found, grants, total: grants.length, fallback: null, checked: candidates.length, applicant: u.applicant || null, ai: true };
  } catch (e) {
    console.warn('chatAI: check failed:', e.message);
    return { ...found, applicant: u.applicant || null, ai: true };
  }
}
