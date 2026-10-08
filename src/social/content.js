// What the social channels post, and how it reads on each platform.
//
// Two campaigns:
//   new      daily "Nuevas hoy": items that went public in the last 26 h (published_at), max 5 per
//            section, highest amount first. 26 h absorbs scheduling drift without letting the
//            day's leftovers come back tomorrow as "hoy"; the posted log stops any repeat.
//   closing  Monday "Cierran en los próximos 7 días": open items whose deadline falls in the next
//            7 days, soonest first.
// Sections: subvenciones (grants not aimed at businesses), negocios (business / LEADER grants -
// src/negocios.js) and licitaciones. Each grant lives in exactly one of the first two.
import { db } from '../db.js';
import { BASE_URL, grantPath, licitacionPath } from '../seoUtils.js';
import { isBusinessGrant } from '../negocios.js';

export const SECTIONS = ['subvenciones', 'negocios', 'licitaciones'];
export const SECTION_TITLE = { subvenciones: 'Subvenciones', negocios: 'Ayudas para negocios', licitaciones: 'Licitaciones' };
const SECTION_PATH = { subvenciones: '/', negocios: '/negocios', licitaciones: '/licitaciones' };
export const PER_SECTION = 5;
export const NEW_WINDOW_HOURS = 26;
export const CLOSING_DAYS = 7;
const NATIONWIDE = 'Toda España';

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
export const shortDate = (iso) => {
  const [, m, d] = String(iso || '').slice(0, 10).split('-').map(Number);
  return m && d ? `${d} ${MESES[m - 1]}` : null;
};
const eur = (n) => `${Math.round(Number(n)).toLocaleString('es-ES')} €`;
const isoDay = (d) => d.toISOString().slice(0, 10);
const sqlTime = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

// One shape for both kinds of item.
function fromGrant(g) {
  return {
    kind: 'grant', id: g.id, section: isBusinessGrant(g) ? 'negocios' : 'subvenciones',
    title: g.plain_title || g.title, path: grantPath(g), org: g.granting_body || '',
    amount: g.amount_max ?? g.budget_total ?? null,
    amountText: g.amount_max ? `Hasta ${eur(g.amount_max)}` : g.budget_total ? `${eur(g.budget_total)} en total` : null,
    deadline: g.is_rolling ? null : g.deadline_date,
    estimated: g.deadline_source === 'computed' && !g.deadline_confirmed,
    ccaa: g.region, nationwide: g.region === NATIONWIDE,
  };
}
function fromLicitacion(l) {
  return {
    kind: 'licitacion', id: l.id, section: 'licitaciones',
    title: l.titulo || l.expediente, path: licitacionPath(l), org: l.organo || '',
    amount: l.presupuesto_base ?? null,
    amountText: l.presupuesto_base ? `Presupuesto ${eur(l.presupuesto_base)}` : null,
    deadline: l.fecha_limite, estimated: false, ccaa: l.ccaa, nationwide: false,
  };
}

const GRANT_COLS = `g.id, g.bdns_ref, g.title, g.plain_title, g.granting_body, g.region, g.amount_max,
  g.budget_total, g.deadline_date, g.deadline_source, g.deadline_confirmed, g.is_rolling, g.beneficiarios_bdns`;

// Everything that could go out in a campaign right now, by section (before per-channel filters).
export function candidates(campaign, now = new Date()) {
  const today = isoDay(now);
  let grants, tenders;
  if (campaign === 'new') {
    const since = sqlTime(new Date(now.getTime() - NEW_WINDOW_HOURS * 3600000));
    grants = db.prepare(`SELECT ${GRANT_COLS} FROM grant_row g WHERE g.published = 1 AND g.status = 'OPEN'
      AND g.published_at >= ? AND (g.deadline_date IS NULL OR g.deadline_date >= ? OR g.is_rolling = 1)`).all(since, today);
    tenders = db.prepare(`SELECT id, expediente, titulo, organo, presupuesto_base, fecha_limite, ccaa FROM licitacion_row
      WHERE published = 1 AND estado = 'licitacion' AND published_at >= ?
        AND (fecha_limite IS NULL OR fecha_limite >= ?)`).all(since, today);
  } else {
    const until = isoDay(new Date(now.getTime() + CLOSING_DAYS * 86400000));
    grants = db.prepare(`SELECT ${GRANT_COLS} FROM grant_row g WHERE g.published = 1 AND g.status = 'OPEN'
      AND g.is_rolling = 0 AND g.deadline_date BETWEEN ? AND ?`).all(today, until);
    tenders = db.prepare(`SELECT id, expediente, titulo, organo, presupuesto_base, fecha_limite, ccaa FROM licitacion_row
      WHERE published = 1 AND estado = 'licitacion' AND fecha_limite BETWEEN ? AND ?`).all(today, until);
  }
  const out = Object.fromEntries(SECTIONS.map(s => [s, []]));
  for (const g of grants) { const i = fromGrant(g); out[i.section].push(i); }
  for (const l of tenders) out.licitaciones.push(fromLicitacion(l));
  return out;
}

const byAmountDesc = (a, b) => (b.amount ?? -1) - (a.amount ?? -1) || String(a.deadline || '9').localeCompare(String(b.deadline || '9'));
const bySoonest = (a, b) => String(a.deadline || '9').localeCompare(String(b.deadline || '9')) || (b.amount ?? -1) - (a.amount ?? -1);

// What one channel gets: its comunidad only (a regional channel), never anything it already
// posted in this campaign, at most `limit` per section. Returns { section: { items, more } }.
export function selectFor({ ccaa = null } = {}, campaign, cands, posted = new Set(), limit = PER_SECTION) {
  const res = {};
  for (const s of SECTIONS) {
    const pool = cands[s]
      .filter(i => !ccaa || i.ccaa === ccaa)
      .filter(i => !posted.has(`${i.kind}:${i.id}`))
      .sort(campaign === 'new' ? byAmountDesc : bySoonest);
    res[s] = { items: pool.slice(0, limit), more: Math.max(0, pool.length - limit) };
  }
  return res;
}

export function withUtm(pathOrUrl, source, campaign) {
  const u = new URL(pathOrUrl, BASE_URL);
  u.searchParams.set('utm_source', source);
  u.searchParams.set('utm_medium', 'social');
  u.searchParams.set('utm_campaign', campaign);
  return u.toString();
}

export const header = (campaign, section) =>
  `${campaign === 'new' ? 'Nuevas hoy' : `Cierran en los próximos ${CLOSING_DAYS} días`} · ${SECTION_TITLE[section]}`;

const detail = (i) => [i.amountText, i.deadline ? `cierra el ${shortDate(i.deadline)}${i.estimated ? '*' : ''}` : null]
  .filter(Boolean).join(' · ');

const htmlEsc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- Telegram: one HTML message per section ---------------------------------------------------
export function telegramMessage(campaign, section, { items, more }) {
  const lines = items.map(i => `• <a href="${htmlEsc(withUtm(i.path, 'telegram', campaign))}">${htmlEsc(i.title)}</a>`
    + (detail(i) ? `\n   ${htmlEsc(detail(i))}` : ''));
  const tail = more ? `\n\n<a href="${htmlEsc(withUtm(SECTION_PATH[section], 'telegram', campaign))}">Y ${more} más en Plazo Abierto</a>` : '';
  const note = items.some(i => i.estimated) ? '\n\n* fecha estimada: confírmala en las bases.' : '';
  return `<b>${htmlEsc(header(campaign, section))}</b>\n\n${lines.join('\n\n')}${tail}${note}`;
}

// ---- Bluesky: a thread per section (posts are capped at 300 characters) ------------------------
export const BLUESKY_MAX = 300;
const graphemes = (s) => [...new Intl.Segmenter('es', { granularity: 'grapheme' }).segment(s)].length;
const truncate = (s, max) => {
  const parts = [...new Intl.Segmenter('es', { granularity: 'grapheme' }).segment(s)].map(x => x.segment);
  return parts.length <= max ? s : parts.slice(0, max - 1).join('').trimEnd() + '…';
};

// A post whose last line is a link: the visible text stays short, the facet carries the full
// tagged URL (Bluesky counts only the visible text). Byte offsets are UTF-8, as the API requires.
function linkPost(body, linkText, url) {
  const room = BLUESKY_MAX - graphemes(linkText) - 1;
  const text = `${truncate(body, room)}\n${linkText}`;
  const start = Buffer.byteLength(text) - Buffer.byteLength(linkText);
  return { text, facets: [{ index: { byteStart: start, byteEnd: Buffer.byteLength(text) },
    features: [{ $type: 'app.bsky.richtext.facet#link', uri: url }] }] };
}

export function blueskyThread(campaign, section, { items, more }) {
  const root = linkPost(`${header(campaign, section)}${more ? ` (${items.length + more})` : ''} 🧵`,
    'Ver todas en Plazo Abierto', withUtm(SECTION_PATH[section], 'bluesky', campaign));
  const replies = items.map(i => linkPost(`${i.title}${detail(i) ? `\n${detail(i)}` : ''}`,
    'Ver en Plazo Abierto', withUtm(i.path, 'bluesky', campaign)));
  return [root, ...replies];
}

// ---- WhatsApp Channel: plain text the operator pastes by hand (admin panel) ---------------------
export const WHATSAPP_PER_SECTION = 10;
export function whatsappClosingText(now = new Date()) {
  const cands = candidates('closing', now);
  const sel = selectFor({}, 'closing', cands, new Set(), WHATSAPP_PER_SECTION);
  const until = new Date(now.getTime() + CLOSING_DAYS * 86400000);
  const blocks = SECTIONS.filter(s => sel[s].items.length).map(s =>
    `*${SECTION_TITLE[s]}*\n` + sel[s].items.map(i =>
      `• ${i.title}${detail(i) ? ` — ${detail(i)}` : ''}\n${withUtm(i.path, 'whatsapp', 'closing')}`).join('\n')
    + (sel[s].more ? `\nY ${sel[s].more} más: ${withUtm(SECTION_PATH[s], 'whatsapp', 'closing')}` : ''));
  if (!blocks.length) return '';
  return `*Cierran en los próximos ${CLOSING_DAYS} días* (${shortDate(isoDay(now))} – ${shortDate(isoDay(until))})\n\n`
    + blocks.join('\n\n')
    + (Object.values(sel).some(x => x.items.some(i => i.estimated)) ? '\n\n* fecha estimada: confírmala en las bases.' : '');
}
