// What the AI reads from a tender's pliegos: the parts a summary uses, not all of them.
//
// Why (2026-11-23): sending the whole stored pliego text (up to 150,000 chars, ~48,000 tokens)
// made every tender ~20x the cost it had in September, for summaries that use a few pages of it.
// Tested on 20 live tenders before switching: input fell from 963,647 to 250,877 tokens (-74%);
// titles and summaries were as good in all 20, the key requirements as good or better in 15,
// and 5 lost one detail buried deep in the technical document (e.g. a required brand).
//
// What is kept, within KEY_BUDGET:
//   - the start of each document (objeto, cuadro resumen / carátula), administrative docs more;
//   - windows around the words that carry requirements: solvency, turnover, classification,
//     guarantees, insurance, certifications, registrations, staff and equipment, brands,
//     award criteria, duration, lots, site visits, subcontracting;
//   - the administrative documents (PCAP) get 65% of the budget and the technical ones (PPT)
//     35%, because some requirements (insurance, registrations, brands) are only in the PPT.
// Skipped: tables of contents (a hit there would show the AI "Solvencia ...... pág. 12" and
// nothing else) and the e-signature header repeated on every page.
// raw_text itself is stored in full as before; only what is sent changes.
export const KEY_BUDGET = Number(process.env.PLIEGO_KEY_BUDGET || 36_000);
const SHARE = { admin: 0.65, tech: 0.35 };
const HEAD = { admin: 5_000, tech: 2_500 };
const WINDOW_BEFORE = 150, WINDOW_AFTER = 1_300;
const HITS_PER_KEYWORD = 3;

const KEYWORDS = [
  /cuadro\s+(resumen|de\s+caracter[íi]sticas)|car[áa]tula/i,
  /objeto\s+del\s+contrato/i,
  /solvencia\s+(econ[óo]mica|financiera|t[ée]cnica|profesional)/i,
  /volumen\s+(anual\s+)?de\s+negocios/i,
  /clasificaci[óo]n\s+(empresarial|del\s+contratista|exigida)|\bgrupo\s+[A-Z]\b.{0,40}subgrupo/i,
  /criterios\s+de\s+(adjudicaci[óo]n|valoraci[óo]n)/i,
  /garant[íi]a\s+(definitiva|provisional)|fianza/i,
  /seguro\s+(de\s+responsabilidad|a\s+todo\s+riesgo)|p[óo]liza/i,
  /(plazo|duraci[óo]n)\s+(de\s+ejecuci[óo]n|del\s+contrato)|pr[óo]rroga/i,
  /presentaci[óo]n\s+de\s+(ofertas|proposiciones)/i,
  /condiciones\s+especiales\s+de\s+ejecuci[óo]n/i,
  /habilitaci[óo]n|autorizaci[óo]n\s+(sanitaria|administrativa)|registrad[oa]\s+como|inscri(to|ta|pci[óo]n)\s+en\s+el\s+registro/i,
  /certificad[oa]\s+(de\s+calidad|ISO|UNE)|\bISO\s*\d{4,5}|\bUNE[-\s]EN/i,
  /adscripci[óo]n\s+de\s+medios|medios\s+(personales|materiales|humanos)|equipo\s+m[íi]nimo|titulaci[óo]n/i,
  /\bmarca\b|equivalente/i,
  /visita\s+(previa|obligatoria|a\s+las\s+instalaciones)|subcontrataci[óo]n/i,
];
const ADMIN_DOC = /pcap|administrativ|condiciones\s+particulares|cuadro|car[áa]tula|cl[áa]usulas|pliego\s+de\s+condiciones|anexo\s*i\b|pca\b/i;

// [pattern, replacement]: page furniture from e-signed PDFs, repeated on every page.
const NOISE = [
  [/^.*(Documento firmado electr[óo]nicamente|C[óo]digo Seguro de Verificaci[óo]n|Direcci[óo]n de validaci[óo]n|validaci[óo]n del CSV|Pu[ée]de verificar|Firmado por|Fecha de firma).*$/gim, ''],
  [/^\s*P[áa]gina\s+\d+\s+de\s+\d+\s*$/gim, ''],
  [/^\s*\d+\s*\/\s*\d+\s*$/gm, ''],
  [/[ \t]{2,}/g, ' '],
  [/\n{3,}/g, '\n\n'],
];
const clean = (s) => NOISE.reduce((t, [re, to]) => t.replace(re, to), s);

// A table of contents is many short numbered heading lines in a row; body text is not.
const HEADING_LINE = /^\s*(\d+(\.\d+)*\.?-?|[IVX]+\.|ANEXO|CL[ÁA]USULA)\s*\S.{0,110}$/gim;
function inToc(text, i) {
  const around = text.slice(Math.max(0, i - 300), i + 500);
  const lines = around.split('\n').filter(l => l.trim());
  const heads = (around.match(HEADING_LINE) || []).length;
  return lines.length >= 6 && heads / lines.length > 0.6;
}

// raw_text is "[document name]\n<text>\n\n[document name]\n<text>..." (fetchPliegosText).
function splitDocs(raw) {
  const docs = [];
  const re = /^\[([^\]\n]{1,200})\]\n/gm;
  let m, last = null;
  while ((m = re.exec(raw))) {
    if (last) last.text = raw.slice(last.start, m.index);
    last = { name: m[1], start: m.index + m[0].length };
    docs.push(last);
  }
  if (last) last.text = raw.slice(last.start);
  if (!docs.length) docs.push({ name: 'documento', text: raw });
  return docs.map(d => ({ name: d.name, text: clean(d.text), kind: ADMIN_DOC.test(d.name) ? 'admin' : 'tech' }));
}

function pickFromDoc(d, budget) {
  if (d.text.length <= budget) return d.text;
  const head = Math.min(HEAD[d.kind], budget);
  const ranges = [[0, head]];
  for (const k of KEYWORDS) {
    const g = new RegExp(k.source, 'gi');
    let m, hits = 0;
    while ((m = g.exec(d.text)) && hits < HITS_PER_KEYWORD) {
      if (m.index < head || inToc(d.text, m.index)) continue;
      ranges.push([Math.max(0, m.index - WINDOW_BEFORE), Math.min(d.text.length, m.index + WINDOW_AFTER)]);
      hits++;
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const prev = merged[merged.length - 1];
    if (prev && r[0] <= prev[1] + 100) prev[1] = Math.max(prev[1], r[1]); else merged.push([...r]);
  }
  let out = '', used = 0;
  for (const [s, e] of merged) {
    const piece = d.text.slice(s, e);
    const sep = s ? '\n[…]\n' : '';
    if (used + piece.length > budget) { out += sep + piece.slice(0, budget - used); break; }
    out += sep + piece;
    used += piece.length;
  }
  return out;
}

export function keySections(raw, budget = KEY_BUDGET) {
  if (!raw) return raw;
  const docs = splitDocs(raw);
  const total = docs.reduce((s, d) => s + d.text.length, 0);
  if (total <= budget) return docs.map(d => `[${d.name}]\n${d.text}`).join('\n\n');
  const kinds = { admin: docs.filter(d => d.kind === 'admin'), tech: docs.filter(d => d.kind === 'tech') };
  const parts = [];
  for (const kind of ['admin', 'tech']) {
    const list = kinds[kind];
    if (!list.length) continue;
    const other = kind === 'admin' ? kinds.tech : kinds.admin;
    const share = other.length ? budget * SHARE[kind] : budget;
    for (const d of list) parts.push(`[${d.name}]\n${pickFromDoc(d, Math.floor(share / list.length))}`);
  }
  return parts.join('\n\n');
}
