// Shared helpers between src/routes/seo.js (grant fichas) and src/routes/seoHubs.js
// (comunidad/provincia/sector/beneficiario hubs) - kept out of routes/ since this has no
// router of its own.
import { MUNICIPIOS } from './municipios.js';
import { CCAA } from './ingest/regions.js';

export const BASE_URL = process.env.BASE_URL || 'https://plazoabierto.es';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const eur = (n) => n == null ? null : Number(n).toLocaleString('es-ES') + ' €';

export const BENEFICIARIO_TYPES = { Ayuntamiento: 'Ayuntamientos', Junta_Vecinal: 'Juntas vecinales', Asociacion: 'Asociaciones', Club_Deportivo: 'Clubes deportivos', AMPA: 'AMPAs', Otro: 'Otras entidades' };

// bdns_ref is a plain BDNS numConv (always digits - see poll.js), so it survives in the
// URL untouched; the slug is cosmetic and never trusted for lookup (a stale/wrong slug in
// an old link or bookmark still resolves the right grant - see seo.js's route handler).
export function slugify(s) {
  return (s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'convocatoria';
}

export function grantPath(g) {
  return `/subvenciones/${slugify(g.plain_title || g.title)}-${g.bdns_ref}/`;
}

// licitacion_row has no bdns_ref-shaped clean identifier - PLACSP expedientes routinely
// contain slashes and spaces ("CMA 01/2026") that break a URL path segment, which is
// exactly why enrichBatch's custom_id already had to use the row's own uuid instead of the
// expediente (see enrichLicitacion.js). Reuse that same id here, for the same reason.
export function licitacionPath(l) {
  return `/licitaciones/${slugify(l.titulo || l.expediente)}-${l.id}/`;
}

// ---- hub taxonomies (fixed, not discovered from the DB - freeze the URL shape once) ----

export const CCAA_SLUGS = new Map(Object.values(CCAA).map(name => [slugify(name), name]));

export const PROVINCE_CCAA = new Map(MUNICIPIOS.map(m => [m.province, m.ccaa]).filter(([p]) => p));
export const PROVINCE_SLUGS = new Map([...PROVINCE_CCAA.keys()].map(name => [slugify(name), name]));

// The vocabulary the extraction prompt itself suggests (enrich.js's ELIGIBILITY_SCHEMA
// `category` description) - matched case-insensitively against grant_row.category, so a
// grant only links to a category hub whose taxonomy we actually recognise.
export const CATEGORIES = ['Cultura', 'Deporte', 'Empleo', 'Infraestructura', 'Medio ambiente', 'Social', 'Otros'];
export const CATEGORY_SLUGS = new Map(CATEGORIES.map(name => [slugify(name), name]));

export const BENEFICIARIO_SLUGS = new Map(
  Object.entries(BENEFICIARIO_TYPES).map(([enumVal, label]) => [slugify(label), { enumVal, label }])
);

export function daysLeft(deadline) {
  if (!deadline) return null;
  return Math.ceil((new Date(deadline + 'T23:59:59') - Date.now()) / 86400000);
}

// Minimal reusable list-item markup for hub pages - deliberately lighter than the
// homepage's full grant-card (no explainer/checklist toggles, this page's job is to rank
// and hand the visitor off to the ficha, not repeat its whole content).
export function grantListItem(g) {
  const d = daysLeft(g.deadline_date);
  const badge = d != null
    ? `<span class="badge-days ${d <= 10 ? 'soon' : ''}">${d <= 0 ? 'último día' : `quedan ${d} días`}</span>`
    : (g.is_rolling ? '<span class="badge-days">plazo continuo</span>' : '<span class="badge-days soon">plazo por confirmar</span>');
  const amount = g.amount_max ? `hasta ${eur(g.amount_max)}` : (g.budget_total ? `bolsa de ${eur(g.budget_total)}` : 'según bases');
  const head = g.plain_title || g.title;
  return `<article class="grant-card">
    <div class="org">${esc(g.granting_body || '')} ${badge}</div>
    <h4><a href="${esc(grantPath(g))}">${esc(head)}</a></h4>
    <p class="desc">${esc(g.ai_summary || '')}</p>
    <div><span class="chip"><span class="k">Cuantía</span><span class="v">${esc(amount)}</span></span></div>
  </article>`;
}

export function pageShell({ title, description, canonical, jsonLd, breadcrumbHtml, bodyHtml }) {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description.slice(0, 160))}">
<link rel="canonical" href="${esc(canonical)}">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="stylesheet" href="/styles.css">
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : ''}
</head>
<body>
<header class="site">
  <div class="wrap">
    <a class="logo" href="/">Plazo<span class="b">Abierto</span></a>
    <nav>
      <div class="tabs">
        <a class="tab on" href="/">Subvenciones</a>
        <a class="tab" href="/licitaciones">Licitaciones</a>
      </div>
      <a class="btn ghost" href="/entrar">Entrar</a>
    </nav>
  </div>
</header>
<main class="wrap" style="padding-top:1.5rem;padding-bottom:3rem">
  <nav class="muted" style="font-size:.82rem;margin-bottom:.6rem">${breadcrumbHtml}</nav>
  ${bodyHtml}
</main>
</body>
</html>`;
}
