// /organismos/ (index by comunidad), /organismos/<slug>/ (one body's grants and tenders) and
// /sitemap-organismos.xml. Data and the opening text: src/organismos.js.
import { Router } from 'express';
import { BASE_URL, esc, eur, slugify, licitacionPath, daysLeft, daysLabel, PROVINCE_CCAA } from '../seoUtils.js';
import { amountLabel } from '../grantSeo.js';
import { NATIONWIDE } from '../ingest/regions.js';
import { pageShell, grantListItem, liveHubs, ESTATALES_PATH } from '../siteChrome.js';
import { organisms, organismContent, organismIntro, monthYear, ofOrg } from '../organismos.js';

export const organismosRouter = Router();

const tenderAmount = (l) => l.presupuesto_base ? eur(l.presupuesto_base) : l.valor_estimado ? `valor estimado ${eur(l.valor_estimado)}` : null;
const tenderWhen = (l) => { const d = daysLeft(l.fecha_limite); return d != null ? daysLabel(d) : 'plazo por confirmar'; };
const openTenderLine = (l) => `<li><a href="${esc(licitacionPath(l))}">${esc(l.titulo)}</a>
  <span class="muted">— ${esc([tenderWhen(l), tenderAmount(l), l.tipo_contrato].filter(Boolean).join(' · '))}</span></li>`;
// Past calls have no page of their own any more (410): their name and date, as text.
const pastTenderLine = (l) => `<li>${esc(l.titulo)}
  <span class="muted">— ${esc([l.fecha_limite ? `plazo hasta ${monthYear(l.fecha_limite)}` : null, tenderAmount(l), l.tipo_contrato].filter(Boolean).join(' · '))}</span></li>`;
const pastGrantLine = (g) => `<li>${esc(g.plain_title || g.title)}
  <span class="muted">— ${esc([monthYear(g.open_date || g.created_at), amountLabel(g)].filter(Boolean).join(' · '))}</span></li>`;

function heading(o, c) {
  const g = c.openGrants.length + c.pastGrants.length, t = c.openTenders.length + c.pastTenders.length;
  const what = g && t ? 'Subvenciones y licitaciones' : t ? 'Licitaciones' : 'Subvenciones';
  return `${what} ${ofOrg(o)}`;
}

function renderOrganism(o) {
  const c = organismContent(o);
  const h1 = heading(o, c);
  const open = c.openGrants.length + c.openTenders.length;
  const where = o.place || o.province || (o.region !== NATIONWIDE ? o.region : null);
  const title = `${h1}${where && !h1.includes(where) ? ` (${where})` : ''} — ${open ? `${open} abierta${open === 1 ? '' : 's'} hoy` : 'convocatorias anteriores'}`;

  const hubs = liveHubs();
  const more = [
    o.region === NATIONWIDE && hubs.estatales ? `<a href="${ESTATALES_PATH}">Subvenciones estatales</a>` : '',
    o.region && hubs.ccaa.includes(o.region) ? `<a href="/subvenciones/${slugify(o.region)}/">Subvenciones en ${esc(o.region)}</a>` : '',
    o.province && o.region && PROVINCE_CCAA.get(o.province) === o.region && hubs.provinces.includes(o.province)
      ? `<a href="/subvenciones/${slugify(o.region)}/${slugify(o.province)}/">Subvenciones en ${esc(o.province)}</a>` : '',
    '<a href="/licitaciones">Todas las licitaciones abiertas</a>',
    '<a href="/organismos/">Otros organismos</a>',
  ].filter(Boolean);

  const body = `
    <h1>${esc(h1)}</h1>
    <p class="hub-intro">${esc(organismIntro(o, c))}</p>
    ${c.openGrants.length ? `<h2>Subvenciones abiertas (${c.openGrants.length})</h2>
      <div class="grants-grid">${c.openGrants.map(grantListItem).join('')}</div>` : ''}
    ${c.openTenders.length ? `<h2>Licitaciones abiertas (${c.openTenders.length})</h2>
      <ul>${c.openTenders.map(openTenderLine).join('')}</ul>` : ''}
    ${c.pastGrants.length ? `<section class="hub-also"><h2>Subvenciones que ya ha convocado (${c.pastGrants.length})</h2>
      <p class="muted">Ya cerradas. Muchas se repiten cada año por las mismas fechas.</p>
      <ul>${c.pastGrants.map(pastGrantLine).join('')}</ul></section>` : ''}
    ${c.pastTenders.length ? `<section class="hub-also"><h2>Licitaciones anteriores (${c.pastTenders.length})</h2>
      <ul>${c.pastTenders.map(pastTenderLine).join('')}</ul></section>` : ''}
    <div class="card"><h2>Ver más</h2><p>${more.join('<br>')}</p></div>
  `;
  return pageShell({
    title: `${title} | Plazo Abierto`,
    description: `${h1}: ${open ? `${open} abierta${open === 1 ? '' : 's'} hoy` : 'sin convocatorias abiertas hoy'}, y las que ya ha publicado. Explicadas en castellano llano.`,
    canonical: BASE_URL + o.path,
    jsonLd: [{ '@context': 'https://schema.org', '@type': 'GovernmentOrganization', name: o.name,
      ...(where ? { areaServed: where } : {}), url: BASE_URL + o.path }],
    breadcrumbHtml: `<a href="/">Inicio</a> › <a href="/organismos/">Organismos</a> › <span>${esc(o.name)}</span>`,
    bodyHtml: body,
    robots: o.indexable ? undefined : 'noindex, follow',
  });
}

organismosRouter.get('/organismos/:slug', (req, res, next) => {
  const o = organisms().byKey.get(req.params.slug);
  if (!o) return next();
  if (!req.path.endsWith('/')) return res.redirect(301, o.path);
  res.set('Content-Type', 'text/html; charset=utf-8').send(renderOrganism(o));
});

// Every indexable organism, by comunidad; the ones with something open first.
organismosRouter.get('/organismos', (req, res) => {
  if (!req.path.endsWith('/')) return res.redirect(301, '/organismos/');
  const groups = new Map();
  for (const o of organisms().byKey.values()) {
    if (!o.indexable) continue;
    const g = o.region === NATIONWIDE ? 'Estatales' : o.region || 'Otros';
    (groups.get(g) || groups.set(g, []).get(g)).push(o);
  }
  const order = [...groups.keys()].sort((a, b) => (a === 'Estatales' ? -1 : b === 'Estatales' ? 1 : a === 'Otros' ? 1 : b === 'Otros' ? -1 : a.localeCompare(b, 'es')));
  const total = [...groups.values()].reduce((n, l) => n + l.length, 0);
  const sections = order.map(g => {
    const list = groups.get(g).sort((a, b) => (b.open > 0) - (a.open > 0) || a.name.localeCompare(b.name, 'es'));
    return `<section class="hub-also" id="${esc(slugify(g))}"><h2>${esc(g)} (${list.length})</h2><ul>${list.map(o =>
      `<li><a href="${esc(o.path)}">${esc(o.name)}${o.place ? ` (${esc(o.place)})` : ''}</a>${o.open ? ` <span class="muted">— ${o.open} abierta${o.open === 1 ? '' : 's'}</span>` : ''}</li>`).join('')}</ul></section>`;
  }).join('');
  const body = `
    <h1>Subvenciones y licitaciones por organismo</h1>
    <p class="hub-intro">Los ${total} ayuntamientos, diputaciones, consejerías, ministerios, universidades y demás organismos que han publicado subvenciones o licitaciones recogidas en Plazo Abierto. En la página de cada uno están las que tiene abiertas hoy y las que ya ha convocado, para saber qué suele financiar y cuándo.</p>
    <p>${order.map(g => `<a href="#${esc(slugify(g))}">${esc(g)}</a>`).join(' · ')}</p>
    ${sections}`;
  res.set('Content-Type', 'text/html; charset=utf-8').send(pageShell({
    title: 'Subvenciones y licitaciones por organismo | Plazo Abierto',
    description: `Ayuntamientos, diputaciones, consejerías y ministerios: qué subvenciones y licitaciones tienen abiertas hoy y cuáles han convocado antes.`,
    canonical: BASE_URL + '/organismos/', jsonLd: [],
    breadcrumbHtml: `<a href="/">Inicio</a> › <span>Organismos</span>`, bodyHtml: body,
  }));
});

organismosRouter.get('/sitemap-organismos.xml', (req, res) => {
  const urls = [...organisms().byKey.values()].filter(o => o.indexable)
    .sort((a, b) => b.open - a.open || b.total - a.total)
    .map(o => `<url><loc>${esc(BASE_URL + o.path)}</loc></url>\n`);
  res.set('Content-Type', 'application/xml; charset=utf-8').send('<?xml version="1.0" encoding="UTF-8"?>\n'
    + `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url><loc>${esc(BASE_URL)}/organismos/</loc></url>\n${urls.join('')}</urlset>`);
});
