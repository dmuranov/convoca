// Daily BDNS poll. Sweeps Palencia (33) + Castilla y León (29) scoped
// convocatorias for the recent window, dedupes on numeroConvocatoria, stores
// new ones as unpublished grant_row entries, then runs the enrichment chain
// (detail -> bases PDF -> LLM extract -> match suggestions).
// Spec funder scope V1: Diputación de Palencia primary, Junta CyL secondary.
import 'dotenv/config';
import { db, uuid } from '../db.js';
import { bdnsGet, ddmmyyyy, alert } from './bdns.js';
import { enrichGrant } from './enrich.js';

const REGIONS = ['33', '29'];
const LOOKBACK_DAYS = Number(process.env.POLL_LOOKBACK_DAYS || 7);

function levelFromNivel1(nivel1) {
  const n = (nivel1 || '').toUpperCase();
  if (n.includes('LOCAL')) return 'provincial';        // Diputación/ayuntamientos arrive as LOCAL
  if (n.includes('ESTADO')) return 'estatal';
  return 'autonomico';
}

export async function pollOnce() {
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
  const seen = new Map(); // numeroConvocatoria -> search row

  for (const region of REGIONS) {
    let page = 0, totalPages = 1;
    while (page < totalPages && page < 50) {
      const j = await bdnsGet('/convocatorias/busqueda', {
        page: String(page), pageSize: '200', regiones: region,
        fechaDesde: ddmmyyyy(from), fechaHasta: ddmmyyyy(today),
      });
      totalPages = j.totalPages ?? 1;
      for (const row of j.content || []) seen.set(row.numeroConvocatoria, row);
      page++;
    }
  }

  const exists = db.prepare('SELECT 1 FROM grant_row WHERE bdns_ref = ?');
  const ins = db.prepare(`INSERT INTO grant_row
    (id, bdns_ref, title, granting_body, granting_level, open_date, status, source_url)
    VALUES (?, ?, ?, ?, ?, ?, 'ANNOUNCED', ?)`);

  const fresh = [];
  for (const [ref, row] of seen) {
    if (exists.get(ref)) continue;
    const id = uuid();
    ins.run(id, ref, row.descripcion || '(sin título)',
      [row.nivel2, row.nivel3].filter(Boolean).join(' — '),
      levelFromNivel1(row.nivel1), row.fechaRecepcion || null,
      `https://www.infosubvenciones.es/bdnstrans/GE/es/convocatoria/${ref}`);
    fresh.push({ id, ref });
  }
  console.log(`poll: ${seen.size} in window, ${fresh.length} new`);

  for (const g of fresh) {
    try {
      await enrichGrant(g.id, g.ref);
    } catch (e) {
      alert('enrich', `convocatoria ${g.ref}: ${e.message}`);
    }
  }
  return fresh.length;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  pollOnce()
    .then(n => { console.log(`poll done, ${n} new`); process.exit(0); })
    .catch(e => { alert('poll', e.message); process.exit(1); });
}
