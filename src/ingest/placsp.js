// PLACSP (Plataforma de Contratación del Sector Público) client.
//
// Unlike BDNS, PLACSP has no query API - it publishes a public ATOM feed of CODICE
// (the Spanish CEN/BII procurement XML profile) entries, newest page first, paginated via
// an ATOM <link rel="next"> to a timestamped URL. There is no per-record detail call: the
// feed entry already carries everything except the pliegos (PCAP/PPT) PDF text, which is
// fetched separately - see enrichLicitacion.js.
//
// Unlike a BDNS convocatoria, a licitación is NOT immutable: the same expediente
// re-appears in the feed as its estado moves PUB -> EV -> ADJ -> RES (or ANUL), each time
// with a newer <updated>. pollLicitaciones.js upserts on expediente and only re-queues for
// AI re-summarisation when `updated` actually advances past what is stored - see the
// header note there.
import { XMLParser } from 'fast-xml-parser';
import { alert } from './bdns.js';
import { CCAA } from './regions.js';

export const FEED_URL = 'https://contrataciondelestado.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3.atom';
const HEADERS = { 'User-Agent': 'convoca/1.0 (plazoabierto.es)' };

// Code -> label maps below are copied verbatim from the official DGPE genericode files
// linked in the feed's own listURI attributes (fetched 2026-08-30, versions noted below).
// Not guessed - the same field can be numbered differently between codelists (ContractCode
// 2=Servicios but SyndicationTenderingProcessCode 2=Restringido), so do not assume order.
// Re-fetch the listURI if PLACSP ever adds a code these maps don't cover.

// SyndicationContractFolderStatusCode-2.04.gc. Six real states, not the four the product
// spec first assumed (PRE/PUB/EV/ADJ/RES/ANUL) - EV ("pendiente de adjudicación", between
// submission close and award) and ANUL (annulled) both need their own handling.
export const ESTADO = {
  PRE: 'anuncio_previo',
  PUB: 'licitacion',
  EV: 'pendiente_adjudicacion',
  ADJ: 'adjudicada',
  RES: 'resuelta',
  ANUL: 'anulada',
};

// ContractCode-2.08.gc. Note the numbering does NOT match the intuitive Obras/Servicios/
// Suministros = 1/2/3 order - verified against the live codelist, not assumed.
export const TIPO_CONTRATO = {
  1: 'Suministros',
  2: 'Servicios',
  3: 'Obras',
  7: 'Administrativo especial',
  8: 'Privado',
  21: 'Gestión de Servicios Públicos',
  22: 'Concesión de Servicios',
  31: 'Concesión de Obras Públicas',
  32: 'Concesión de Obras',
  40: 'Colaboración entre el sector público y sector privado',
  50: 'Patrimonial',
};

// SyndicationTenderingProcessCode-2.07.gc.
export const PROCEDIMIENTO = {
  1: 'Abierto',
  2: 'Restringido',
  3: 'Negociado sin publicidad',
  4: 'Negociado con publicidad',
  5: 'Diálogo competitivo',
  6: 'Contrato menor',
  7: 'Derivado de acuerdo marco',
  8: 'Concurso de proyectos',
  9: 'Abierto simplificado',
  10: 'Asociación para la innovación',
  11: 'Derivado de asociación para la innovación',
  12: 'Basado en un sistema dinámico de adquisición',
  13: 'Licitación con negociación',
  100: 'Normas internas',
  999: 'Otros',
};

// Elements that can legitimately repeat but collapse to a bare object (not an array) in
// fast-xml-parser when only one is present - force them to always parse as arrays so
// downstream code never has to branch on shape.
const ALWAYS_ARRAY = new Set([
  'entry', 'ProcurementProjectLot', 'LegalDocumentReference', 'TechnicalDocumentReference',
  'AdditionalDocumentReference', 'RequiredCommodityClassification', 'ActivityCode',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,   // addresses elements by local name (cac:Party -> Party) - the
                          // feed's prefixes (cac/cbc/cac-place-ext) aren't consistent about
                          // which one a given field lands under across CODICE versions.
  isArray: (name) => ALWAYS_ARRAY.has(name),
  parseTagValue: false,   // keep amounts/dates as strings - we parse them ourselves so a
                          // stray thousands separator doesn't silently become a wrong number
});

const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const text = (v) => (v && typeof v === 'object' ? v['#text'] : v) ?? null;

// One feed page -> { entries: normalized licitación objects, nextUrl: string|null }.
export async function fetchFeedPage(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const xml = await res.text();
  const doc = parser.parse(xml).feed;
  const nextLink = arr(doc.link).find(l => l['@_rel'] === 'next');
  const entries = arr(doc.entry).map(parseEntry).filter(Boolean);
  return { entries, nextUrl: nextLink?.['@_href'] || null };
}

function parseEntry(entry) {
  const cfs = entry.ContractFolderStatus;
  if (!cfs) return null;   // tombstone (deleted) entries carry no ContractFolderStatus

  const expediente = text(cfs.ContractFolderID);
  if (!expediente) return null;

  const estadoCode = text(cfs.ContractFolderStatusCode);
  const party = cfs.LocatedContractingParty?.Party;
  const organo = text(party?.PartyName?.Name) || null;

  const proj = cfs.ProcurementProject || {};
  const budget = proj.BudgetAmount || {};
  const cpv = arr(proj.RequiredCommodityClassification)
    .map(c => text(c.ItemClassificationCode)).filter(Boolean);
  const loc = proj.RealizedLocation || {};
  const duration = proj.PlannedPeriod?.DurationMeasure;

  const process = cfs.TenderingProcess || {};
  const deadline = process.TenderSubmissionDeadlinePeriod;

  const pliegos = [
    ...arr(cfs.LegalDocumentReference),
    ...arr(cfs.TechnicalDocumentReference),
  ].map(d => ({
    nombre: text(d.ID),
    url: text(d.Attachment?.ExternalReference?.URI),
  })).filter(d => d.url);

  const totalAmount = num(budget.TotalAmount);
  const taxExclusive = num(budget.TaxExclusiveAmount);

  return {
    expediente,
    updated: entry.updated,
    estadoCode,
    estado: ESTADO[estadoCode] || null,
    titulo: text(entry.title) || null,
    organo,
    tipoContrato: TIPO_CONTRATO[text(proj.TypeCode)] || null,
    procedimiento: PROCEDIMIENTO[text(process.ProcedureCode)] || null,
    cpv,
    valorEstimado: num(budget.EstimatedOverallContractAmount),
    presupuestoBase: totalAmount,
    // No explicit "incluye IVA" flag in CODICE - TotalAmount vs TaxExclusiveAmount is the
    // signal. Equal (or TaxExclusiveAmount absent) -> can't tell, so no_consta rather than
    // guessing which one the buyer actually meant.
    iva: taxExclusive == null ? 'no_consta'
      : totalAmount > taxExclusive ? 'incluido'
      : totalAmount === taxExclusive ? 'excluido' : 'no_consta',
    fechaLimite: deadline?.EndDate ? text(deadline.EndDate) : null,
    lugar: text(loc.CountrySubentity) || null,
    ccaa: ccaaFromNuts(text(loc.CountrySubentityCode)),
    duracion: duration ? `${text(duration)} ${DURATION_UNIT[duration['@_unitCode']] || duration['@_unitCode'] || ''}`.trim() : null,
    numLotes: arr(cfs.ProcurementProjectLot).length,
    pliegos,
    sourceUrl: text(entry.id),
  };
}

const DURATION_UNIT = { DAY: 'días', WEE: 'semanas', MON: 'meses', ANN: 'años' };

// NUTS3 (province, 5 chars, e.g. ES120) and NUTS2 (comunidad-only, 4 chars, e.g. ES30)
// both roll up to comunidad by truncating to 4 - same rule and the same CCAA table
// regions.js already uses for BDNS, so a licitación and a grant never disagree about
// what "Asturias" or "Andalucía" means. A NUTS1 code (3 chars, e.g. ES3 - a macro-region
// spanning several comunidades) or a missing code has no single comunidad to report.
function ccaaFromNuts(code) {
  if (!code || code.length < 4) return null;
  return CCAA[code.slice(0, 4)] || null;
}

function num(v) {
  const t = text(v);
  if (t == null || t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// Walk feed pages from the newest, stopping when `stop(entries)` returns true for a page
// (typically: every entry on this page is already stored with no newer `updated`). Pages
// are large (~100-200 entries) and the feed does not support a date-range query, so this
// is the only way to bound how far back a poll looks.
export async function walkFeed(stop, maxPages = 20) {
  const all = [];
  let url = FEED_URL;
  for (let page = 0; url && page < maxPages; page++) {
    let batch;
    try {
      batch = await fetchFeedPage(url);
    } catch (e) {
      alert('placsp', `feed page ${page} (${url}): ${e.message}`);
      break;
    }
    all.push(...batch.entries);
    if (stop(batch.entries)) break;
    url = batch.nextUrl;
  }
  return all;
}
