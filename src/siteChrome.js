// What every server-rendered page shares: the page shell, the site footer, and the links
// between hubs. Apart from src/seoUtils.js because these need to know which hubs exist right
// now (src/seoQueries.js): a link is only printed to a hub that answers, never to a 404.
import { esc, slugify, grantPath, daysLeft, daysLabel, ALERT_ASSETS, CCAA_SLUGS, PROVINCE_CCAA, CATEGORIES } from './seoUtils.js';
import { amountLabel, cardHook, isEnriched } from './grantSeo.js';
import { ccaaHub, provinceHub, categoryHub, estatalesHub } from './seoQueries.js';

export const ESTATALES_PATH = '/subvenciones/estatales/';

// Minimal reusable list-item markup for hub pages - deliberately lighter than the
// homepage's full grant-card (no explainer/checklist toggles, this page's job is to rank
// and hand the visitor off to the ficha, not repeat its whole content). The description is a
// one-line hook (cardHook, src/grantSeo.js), never the full summary: with the full text a hub
// of 160 cards repeated some 8,500 words that are also on the grant pages.
export function grantListItem(g) {
  const d = daysLeft(g.deadline_date);
  const badge = d != null
    ? `<span class="badge-days ${d <= 10 ? 'soon' : ''}">${daysLabel(d)}</span>`
    : (g.is_rolling ? '<span class="badge-days">plazo continuo</span>' : '<span class="badge-days soon">plazo por confirmar</span>');
  const head = g.plain_title || g.title;
  const hook = cardHook(g);
  // The same three buttons as a card on the home page. Here the first two go to that part
  // of the grant's own page instead of opening in place: the text stays on one page only.
  const page = grantPath(g);
  let papers = false;
  try { papers = JSON.parse(g.plain_checklist || '[]').length > 0; } catch { papers = false; }
  return `<article class="grant-card">
    <div class="org">${esc(g.granting_body || '')} ${badge}</div>
    <h4><a href="${esc(page)}">${esc(head)}</a></h4>
    ${hook ? `<p class="desc">${esc(hook)}</p>` : ''}
    <div class="facts"><span class="chip"><span class="k">Cuantía</span><span class="v">${esc(amountLabel(g))}</span></span></div>
    <div class="actions">
      ${isEnriched(g) ? `<a class="btn ghost block" href="${esc(page)}#explicacion">Explícamelo fácil</a>` : ''}
      ${papers ? `<a class="btn ghost block" href="${esc(page)}#papeles">¿Qué papeles necesito?</a>` : ''}
      ${g.source_url ? `<a class="btn block" target="_blank" rel="noopener" href="${esc(g.source_url)}">Texto original de la convocatoria →</a>` : ''}
    </div>
  </article>`;
}

// Hubs that clear MIN_LIVE. Kept for ten minutes: the footer is on every page and this is some
// eighty small queries.
let cache = null;
export function liveHubs() {
  if (cache && Date.now() - cache.at < 600_000) return cache;
  cache = {
    at: Date.now(),
    ccaa: [...CCAA_SLUGS.values()].filter(n => ccaaHub(n).ok).sort((a, b) => a.localeCompare(b, 'es')),
    provinces: [...PROVINCE_CCAA].filter(([p, c]) => c && provinceHub(c, p).ok).map(([p]) => p)
      .sort((a, b) => a.localeCompare(b, 'es')),
    categories: CATEGORIES.filter(n => categoryHub(n).ok),
    estatales: estatalesHub().ok,
  };
  return cache;
}
export const resetLiveHubs = () => { cache = null; };

// One line per grant, for the wider tiers under a hub's own cards (the whole comunidad, the
// whole country): title, who calls it, days left, amount. No description - those grants have
// the full card on their own hub.
export function grantLine(g) {
  const d = daysLeft(g.deadline_date);
  const when = d != null ? daysLabel(d) : g.is_rolling ? 'plazo continuo' : 'plazo por confirmar';
  return `<li><a href="${esc(grantPath(g))}">${esc(g.plain_title || g.title)}</a>
    <span class="muted">— ${esc([g.granting_body, when, amountLabel(g)].filter(Boolean).join(' · '))}</span></li>`;
}

const link = (href, text) => `<a href="${esc(href)}">${esc(text)}</a>`;
const ccaaLink = (name) => link(`/subvenciones/${slugify(name)}/`, name);
const provinceLink = (name) => link(`/subvenciones/${slugify(PROVINCE_CCAA.get(name))}/${slugify(name)}/`, name);
const categoryLink = (name) => link(`/subvenciones/${slugify(name)}/`, name);
const group = (label, links) => links.length
  ? `<div class="links-group"><strong>${esc(label)}</strong> ${links.join(' ')}</div>` : '';

// Links from one hub to the others. On a comunidad or province hub: its provinces first.
export function hubNav({ ccaaName = null, provinceName = null, categoryName = null, estatales = false } = {}) {
  const hubs = liveHubs();
  const provinces = ccaaName
    ? hubs.provinces.filter(p => PROVINCE_CCAA.get(p) === ccaaName && p !== provinceName) : [];
  const groups = [
    group(`Provincias de ${ccaaName}`, provinces.map(provinceLink)),
    provinceName ? group('Toda la comunidad', [ccaaLink(ccaaName)]) : '',
    group('Por tema', hubs.categories.filter(c => c !== categoryName).map(categoryLink)),
    ccaaName ? '' : group('Por comunidad', hubs.ccaa.map(ccaaLink)),
    hubs.estatales && !estatales ? group('Ámbito nacional', [link(ESTATALES_PATH, 'Subvenciones estatales')]) : '',
  ].filter(Boolean);
  return groups.length ? `<nav class="hub-nav" aria-label="Otras páginas de subvenciones">${groups.join('')}</nav>` : '';
}

// The link columns of the footer. The static pages (web/*.html) get these too: server.js puts
// them where each page has <!--footer-links-->.
export function footerLinks() {
  const hubs = liveHubs();
  const temas = hubs.categories.map(categoryLink);
  if (hubs.estatales) temas.push(link(ESTATALES_PATH, 'Estatales'));
  return `<nav class="footer-links" aria-label="Secciones del sitio">
    ${group('Subvenciones por comunidad', hubs.ccaa.map(ccaaLink))}
    ${group('Subvenciones por tema', temas)}
    ${group('Plazo Abierto', [link('/', 'Subvenciones'), link('/licitaciones', 'Licitaciones'), link('/organismos/', 'Por organismo'), link('/negocios', 'Negocios'), link('/privacidad', 'Privacidad')])}
  </nav>`;
}

// Cloudflare Web Analytics: no cookies and no personal data stored, so no consent banner.
// Only rendered when CF_BEACON_TOKEN is set, so local and test runs send nothing.
export const analyticsEnabled = () => /^[a-f0-9]{32}$/i.test(process.env.CF_BEACON_TOKEN || '');
export function analyticsTag() {
  if (!analyticsEnabled()) return '';
  return `<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "${process.env.CF_BEACON_TOKEN}"}'></script>`;
}

export function siteFooter() {
  return `${analyticsTag()}
<footer class="site">
  <div class="wrap">
    ${footerLinks()}
    <p>Los datos proceden de la <a href="https://www.infosubvenciones.es">Base de Datos Nacional de Subvenciones</a>
    y de la <a href="https://contrataciondelestado.es">Plataforma de Contratación del Sector Público</a>.
    Confirma siempre cuantías, plazos y requisitos en la convocatoria oficial.</p>
    <p>© ${new Date().getFullYear()} Plazo Abierto · <a href="mailto:hola@plazoabierto.es">hola@plazoabierto.es</a></p>
  </div>
</footer>`;
}

export function siteHeader(active = 'subvenciones') {
  const tab = (key, href, text) => `<a class="tab${active === key ? ' on' : ''}" href="${href}">${text}</a>`;
  return `<header class="site">
  <div class="wrap">
    <a class="logo" href="/">Plazo<span class="b">Abierto</span></a>
    <nav>
      <div class="tabs">
        ${tab('subvenciones', '/', 'Subvenciones')}
        ${tab('licitaciones', '/licitaciones', 'Licitaciones')}
        ${tab('negocios', '/negocios', 'Negocios')}
      </div>
      <a class="btn ghost" href="/entrar">Entrar</a>
    </nav>
  </div>
</header>`;
}

export function pageShell({ title, description, canonical, jsonLd, breadcrumbHtml, bodyHtml, robots, active = 'subvenciones' }) {
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
${robots ? `<meta name="robots" content="${esc(robots)}">` : ''}
${ALERT_ASSETS}
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : ''}
</head>
<body>
${siteHeader(active)}
<main class="wrap" style="padding-top:1.5rem;padding-bottom:3rem">
  <nav class="muted" style="font-size:.82rem;margin-bottom:.6rem">${breadcrumbHtml}</nav>
  ${bodyHtml}
</main>
${siteFooter()}
</body>
</html>`;
}
