// BDNS API client with mirror-host fallback. Public API, no auth.
// Param names verified live during Phase 0 (see grants/BASELINE_FINDINGS.md):
// fechaDesde/fechaHasta dd/mm/yyyy, page/pageSize, vpd=GE, regiones (Palencia=33),
// organos (Diputación Palencia=6427). Portal caps queries at ~10k rows.
import { db, uuid } from '../db.js';

const HOSTS = [
  'https://www.infosubvenciones.es/bdnstrans/api',
  'https://www.pap.hacienda.gob.es/bdnstrans/api',
  'https://www.subvenciones.gob.es/bdnstrans/api',
];

const HEADERS = { Accept: 'application/json', 'User-Agent': 'convoca/1.0 (plazoabierto.es)' };

export function alert(source, message) {
  db.prepare('INSERT INTO ingest_alert (id, source, message) VALUES (?, ?, ?)')
    .run(uuid(), source, String(message).slice(0, 2000));
  console.error(`[ALERT:${source}] ${message}`);
}

// GET with mirror fallback. Throws only after every host fails (caller alerts).
export async function bdnsGet(pathName, params = {}, { binary = false } = {}) {
  const qs = new URLSearchParams({ vpd: 'GE', ...params }).toString();
  let lastErr;
  for (const host of HOSTS) {
    try {
      const res = await fetch(`${host}${pathName}?${qs}`, { headers: HEADERS, signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${host}${pathName}`);
      return binary ? Buffer.from(await res.arrayBuffer()) : await res.json();
    } catch (e) {
      lastErr = e;
      console.warn(`bdns: ${host} failed (${e.message}), trying next mirror`);
    }
  }
  throw lastErr;
}

export const ddmmyyyy = (isoDate) => {
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
};
