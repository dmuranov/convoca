// Build data/gal.json: which LEADER Grupo de Acción Local covers each municipality.
//
// BDNS only says a GAL exists and which province it sits in; it never says which villages
// it serves, and a comarca's boundaries do not follow provinces. So the answer to "which GAL
// do I ask?" has to come from the regional government. Castilla y León publishes it as an
// interactive lookup (municipality -> GAL) at consultas.ayg.jcyl.es, with no bulk download
// (its open-data set has contact details only), so this walks that lookup once per
// municipality and stores the result keyed by INE code.
//
// Coverage is Castilla y León only. Other comunidades publish their own lists in their own
// formats; add a fetcher per region below and merge into the same file. Until then the chat
// is told which territories have data and must not guess for the rest.
//
// Re-run when the programme period changes (GALs are re-selected per period):
//   node scripts/build-gal.js
//   node scripts/build-gal.js 34        # one province (INE code) - for testing
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUNICIPIOS } from '../src/municipios.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'https://consultas.ayg.jcyl.es/adsu';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';
const THROTTLE_MS = Number(process.env.GAL_THROTTLE_MS || 150);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const jar = new Map();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
function keepCookies(res) {
  for (const c of res.headers.getSetCookie?.() || []) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    jar.set(kv.slice(0, i).trim(), kv.slice(i + 1));
  }
}

// The Junta's server drops connections now and then (ECONNRESET / "terminated" mid-walk,
// seen 2026-09-24 and 2026-10-07): one reset used to kill a 15-minute build with nothing
// written. Retry with growing pauses; the caller reopens the session if it went stale.
async function withRetry(label, fn, tries = 5) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (i >= tries) throw e;
      const wait = 2000 * 2 ** (i - 1);
      console.warn(`  ${label}: ${e.cause?.code || e.message} — retry ${i}/${tries - 1} in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
}

async function post(url, fields) {
  return withRetry('post', () => postOnce(url, fields));
}

async function postOnce(url, fields) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader() },
    body: new URLSearchParams(fields).toString(),
    signal: AbortSignal.timeout(60000),
  });
  keepCookies(res);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.arrayBuffer();
}

// The JSP pages are windows-1252; the ajax endpoint answers in UTF-8.
const latin1 = (buf) => new TextDecoder('windows-1252').decode(buf);
const utf8 = (buf) => new TextDecoder('utf-8').decode(buf);

const decodeEntities = (s) => s
  .replace(/&aacute;/gi, 'á').replace(/&eacute;/gi, 'é').replace(/&iacute;/gi, 'í')
  .replace(/&oacute;/gi, 'ó').replace(/&uacute;/gi, 'ú').replace(/&ntilde;/gi, 'ñ')
  .replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');

// The lookup page issues a per-session token for its ajax municipality loader.
async function openSession() {
  const res = await fetch(`${BASE}/adsugalweb00c.jsp`, {
    headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
  keepCookies(res);
  if (!res.ok) throw new Error(`lookup page: HTTP ${res.status}`);
  const html = latin1(await res.arrayBuffer());
  const cons = /recargarPorAjax\(new Array\('c_municipio'\),\s*'([0-9a-f]{64})'/.exec(html)?.[1];
  if (!cons) throw new Error('could not find the municipality loader token; the page changed');
  const token = /id="cag_antibreach_token"[^>]*value="([^"]*)"/.exec(html)?.[1] || '';
  return { cons, token };
}

// -> [{ code: '236', name: 'VILLATURDE' }]; the Junta's code is the INE CMUN.
async function listMunicipios(session, cpro) {
  const raw = utf8(await post(`${BASE}/ConsultaAjax`,
    { cons: session.cons, param0: `CPROVINCIA=${Number(cpro)}` }));
  return (JSON.parse(raw).val1 || []).map(s => {
    const m = /^(\d+)-(.+)$/.exec(s);
    return m ? { code: m[1], name: m[2].trim() } : null;
  }).filter(Boolean);
}

// One lookup can name several GALs when a municipality is split between groups.
function parseGals(html) {
  const out = [];
  const tbody = /<tbody>([\s\S]*?)<\/tbody>/.exec(html)?.[1] || '';
  for (const row of tbody.split(/<tr id="p0_f\d+"/).slice(1)) {
    const nameHtml = /class='enlace'[^>]*>([^<]+)<\/a>/.exec(row)?.[1];
    if (!nameHtml) continue;
    const after = row.slice(row.indexOf('</a>') + 4);
    const [addr, contact = ''] = after.split(/<br\s*\/?>/i).map(p => p.trim()).filter(Boolean);
    out.push({
      name: decodeEntities(nameHtml).replace(/\s+/g, ' ').trim(),
      web: /<a href='([^']*)'[^>]*class='enlace'/.exec(row)?.[1] || null,
      address: addr ? decodeEntities(addr.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim() : null,
      phone: /(\d[\d\s.-]{7,})/.exec(contact.replace(/<[^>]*>/g, ' '))?.[1]?.replace(/\D/g, '') || null,
      email: /mailto:([^"']+)/.exec(row)?.[1] || null,
    });
  }
  return out;
}

async function galFor(session, cpro, code) {
  const html = latin1(await post(`${BASE}/adsugalweb00c.jsp`, {
    c_provincia: String(Number(cpro)), c_prov_hidden: String(Number(cpro)),
    c_municipio: code, c_muni_hidden: code,
    d_nombre_grupo: '', d_nombre_grupo_busq: '',
    cag_antibreach_token: session.token,
  }));
  return parseGals(html);
}

const CYL_PROVINCES = ['05', '09', '24', '34', '37', '40', '42', '47', '49'];
const only = process.argv[2];
const provinces = only ? [only.padStart(2, '0')] : CYL_PROVINCES;

let session = await withRetry('session', openSession);
const gals = new Map();          // galId -> record
const byIne = {};                // ine -> [galId]
const unmatched = [];
const known = new Set(MUNICIPIOS.map(m => m.ine));
let looked = 0, empty = 0;

for (const cpro of provinces) {
  const munis = await listMunicipios(session, cpro);
  console.log(`province ${cpro}: ${munis.length} municipalities`);
  for (const m of munis) {
    const ine = cpro + m.code.padStart(3, '0');
    if (!known.has(ine)) { unmatched.push(`${ine} ${m.name}`); continue; }
    let found;
    try { found = await galFor(session, cpro, m.code); }
    catch (e) {
      // Retries exhausted: the session token may have expired. Reopen once and try again.
      console.warn(`  ${ine} ${m.name}: ${e.message} — reopening the session`);
      session = await withRetry('session', openSession);
      found = await galFor(session, cpro, m.code);
    }
    looked++;
    if (!found.length) { empty++; }
    byIne[ine] = found.map(g => {
      const id = (g.email || g.name).toLowerCase();
      if (!gals.has(id)) gals.set(id, { id, ...g });
      return id;
    });
    if (looked % 200 === 0) console.log(`  ${looked} looked up...`);
    await sleep(THROTTLE_MS);
  }
}

const out = {
  source: 'Junta de Castilla y León - Buscador de Grupos de Acción Local (consultas.ayg.jcyl.es)',
  period: '2023-2027',
  built: new Date().toISOString().slice(0, 10),
  ccaa: ['Castilla y León'],
  gals: Object.fromEntries(gals),
  municipios: byIne,
};

const dest = path.join(__dirname, '..', 'data', 'gal.json');
writeFileSync(dest, JSON.stringify(out));
console.log(`\nwrote ${gals.size} GALs covering ${looked - empty} of ${looked} municipalities to ${dest}`);
if (unmatched.length) console.warn(`WARNING: ${unmatched.length} Junta municipalities not in INE dictionary, e.g.`, unmatched.slice(0, 5));
for (const probe of ['Villaturde', 'Villada', 'Carrión de los Condes']) {
  const mun = MUNICIPIOS.find(m => m.name.toLowerCase() === probe.toLowerCase());
  const ids = mun && byIne[mun.ine];
  console.log(`  ${probe}:`, ids?.length ? ids.map(i => gals.get(i).name).join(' + ') : 'none');
}
