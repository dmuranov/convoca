// Hub pages (comunidad / provincia / sector / beneficiario / estatales) -
// Downloads/plazoabierto-seo-plan.md §1/§3/§4, ordered after seoRouter (src/routes/seo.js) so
// its bdns_ref-suffixed grant URLs are tried first; anything that isn't a grant slug falls
// through to here.
//
// No pre-generation step: every hub is computed live from grant_row on each request, so
// there is nothing to regenerate after ingest and a hub that drops below the minimum
// simply 404s again next time it's crawled - it never sits indexed empty (§1: "una página
// con cero resultados es una doorway page").
//
// A hub for a place lists everything that can be applied for from it (src/seoQueries.js):
// its own calls as cards, then the wider tiers - whole comunidad, state-wide - as short lists.
// Each hub has its own text (src/hubIntro.js), one-line cards (grantListItem) and links to
// the hubs next to it (hubNav): a hub that was only a heading and a grid of full summaries
// read to Google as a copy of the other hubs and of the grant pages.
import { Router } from 'express';
import { BASE_URL, esc, slugify, grantPath, alertBox,
         CCAA_SLUGS, PROVINCE_CCAA, PROVINCE_SLUGS, CATEGORY_SLUGS, BENEFICIARIO_SLUGS } from '../seoUtils.js';
import { ccaaHub, provinceHub, categoryHub, estatalesHub, beneficiarioHub, beneficiarioCcaaHub } from '../seoQueries.js';
import { pageShell, hubNav, grantListItem, grantLine, ESTATALES_PATH } from '../siteChrome.js';
import { hubIntro } from '../hubIntro.js';
import { alertsEnabled } from './alerts.js';

export const seoHubsRouter = Router();

// ---- rendering ----

// `summary` is the one-line meta description; `intro` describes the hub for hubIntro/hubNav
// ({ kind, ccaaName, provinceName, categoryName, beneficiarioLabel }); `hub` is { own, also, all }.
function renderHub({ path, title, summary, breadcrumbHtml, hub, alert = {}, intro, ownTitle }) {
  const canonical = BASE_URL + path;
  const jsonLd = [{
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: hub.all.map((g, i) => ({
      '@type': 'ListItem', position: i + 1, name: g.plain_title || g.title, url: BASE_URL + grantPath(g),
    })),
  }];
  const more = { estatales: [ESTATALES_PATH, 'Ver las estatales con su resumen'],
                 ccaa: intro.ccaaName ? [`/subvenciones/${slugify(intro.ccaaName)}/`, `Ver todas las de ${intro.ccaaName} con su resumen`] : null };
  const also = hub.also.map(t => `
    <section class="hub-also">
      <h2>${esc(t.title)} (${t.grants.length})</h2>
      <ul>${t.grants.map(grantLine).join('')}</ul>
      ${more[t.key] ? `<p><a href="${esc(more[t.key][0])}">${esc(more[t.key][1])} →</a></p>` : ''}
    </section>`).join('');
  const body = `
    <h1>${esc(title)}</h1>
    <p class="hub-intro">${esc(hubIntro({ ...intro, grants: hub.own, total: hub.all.length, alerts: alertsEnabled() }))}</p>
    ${hubNav({ ...intro, estatales: intro.kind === 'estatales' })}
    ${hub.also.length ? `<h2>${esc(ownTitle)} (${hub.own.length})</h2>` : ''}
    <div class="grants-grid">${hub.own.map(grantListItem).join('')}</div>
    ${also}
    ${alertBox('subvenciones', alert)}
  `;
  return pageShell({
    title: `${title} | Plazo Abierto`,
    description: summary,
    canonical, jsonLd, breadcrumbHtml, bodyHtml: body,
    robots: hub.indexable ? undefined : 'noindex, follow',
  });
}

const H = (hub) => { const grants = hub.all; return `${grants.length} convocatoria${grants.length === 1 ? '' : 's'} abierta${grants.length === 1 ? '' : 's'}`; };
const send = (res, hub) => res.set('Content-Type', 'text/html; charset=utf-8').send(renderHub(hub));

// /subvenciones/estatales/  /subvenciones/<comunidad>/  /subvenciones/<sector>/  (single
// segment, tried after seoRouter's grant-detail match on the same path shape)
seoHubsRouter.get('/subvenciones/:seg', (req, res, next) => {
  // State-wide calls (ministries, or open to several comunidades at once): their own hub, so
  // they are not repeated at the top of every comunidad's page.
  if (req.params.seg === 'estatales') {
    const hub = estatalesHub();
    if (!hub.ok) return next();
    return send(res, {
      path: '/subvenciones/estatales/',
      title: `Subvenciones estatales — ${H(hub)}`,
      summary: `${H(hub)} de ámbito estatal: ayudas de los ministerios y de toda España, en castellano llano.`,
      breadcrumbHtml: `<a href="/">Inicio</a> › <span>Subvenciones estatales</span>`,
      hub, intro: { kind: 'estatales' },
    });
  }

  const ccaaName = CCAA_SLUGS.get(req.params.seg);
  if (ccaaName) {
    const hub = ccaaHub(ccaaName);
    if (!hub.ok) return next();
    return send(res, {
      path: `/subvenciones/${req.params.seg}/`,
      title: `Subvenciones en ${ccaaName} — ${H(hub)}`,
      summary: `${H(hub)} que se pueden pedir desde ${ccaaName}: autonómicas, de diputaciones y ayuntamientos, y estatales, en castellano llano.`,
      breadcrumbHtml: `<a href="/">Inicio</a> › <span>${esc(ccaaName)}</span>`,
      hub, alert: { ccaa: ccaaName }, intro: { kind: 'ccaa', ccaaName }, ownTitle: `De organismos de ${ccaaName}`,
    });
  }

  const categoryName = CATEGORY_SLUGS.get(req.params.seg);
  if (categoryName) {
    const hub = categoryHub(categoryName);
    if (!hub.ok) return next();
    return send(res, {
      path: `/subvenciones/${req.params.seg}/`,
      title: `Subvenciones de ${categoryName.toLowerCase()} — ${H(hub)}`,
      summary: `${H(hub)} de ${categoryName.toLowerCase()} para pueblos, asociaciones y entidades locales.`,
      breadcrumbHtml: `<a href="/">Inicio</a> › <span>${esc(categoryName)}</span>`,
      hub, alert: { category: categoryName }, intro: { kind: 'category', categoryName },
    });
  }

  next();
});

// /subvenciones/<comunidad>/<provincia>/
seoHubsRouter.get('/subvenciones/:ccaaSeg/:provSeg', (req, res, next) => {
  const ccaaName = CCAA_SLUGS.get(req.params.ccaaSeg);
  const provinceName = PROVINCE_SLUGS.get(req.params.provSeg);
  if (!ccaaName || !provinceName || PROVINCE_CCAA.get(provinceName) !== ccaaName) return next();

  const hub = provinceHub(ccaaName, provinceName);
  if (!hub.ok) return next();
  send(res, {
    path: `/subvenciones/${req.params.ccaaSeg}/${req.params.provSeg}/`,
    title: `Subvenciones en ${provinceName} — ${H(hub)}`,
    summary: `${H(hub)} que se pueden pedir desde la provincia de ${provinceName}: locales, provinciales, autonómicas y estatales.`,
    breadcrumbHtml: `<a href="/">Inicio</a> › <a href="/subvenciones/${esc(req.params.ccaaSeg)}/">${esc(ccaaName)}</a> › <span>${esc(provinceName)}</span>`,
    hub, alert: { ccaa: ccaaName, province: provinceName }, intro: { kind: 'province', ccaaName, provinceName }, ownTitle: `De la provincia de ${provinceName}`,
  });
});

// /ayudas/<beneficiario>/
seoHubsRouter.get('/ayudas/:benSeg', (req, res, next) => {
  const ben = BENEFICIARIO_SLUGS.get(req.params.benSeg);
  if (!ben) return next();
  const hub = beneficiarioHub(ben.enumVal);
  if (!hub.ok) return next();
  send(res, {
    path: `/ayudas/${req.params.benSeg}/`,
    title: `Ayudas para ${ben.label.toLowerCase()} — ${H(hub)}`,
    summary: `${H(hub)} para ${ben.label.toLowerCase()}, en castellano llano.`,
    breadcrumbHtml: `<a href="/">Inicio</a> › <span>${esc(ben.label)}</span>`,
    hub, alert: { beneficiario: ben.enumVal }, intro: { kind: 'beneficiario', beneficiarioLabel: ben.label },
  });
});

// /ayudas/<beneficiario>/<comunidad>/ - the intersection pages the plan calls out as
// converting best; also the ones most likely to fall under MIN_LIVE, hence the gate.
seoHubsRouter.get('/ayudas/:benSeg/:ccaaSeg', (req, res, next) => {
  const ben = BENEFICIARIO_SLUGS.get(req.params.benSeg);
  const ccaaName = CCAA_SLUGS.get(req.params.ccaaSeg);
  if (!ben || !ccaaName) return next();
  const hub = beneficiarioCcaaHub(ben.enumVal, ccaaName);
  if (!hub.ok) return next();
  send(res, {
    path: `/ayudas/${req.params.benSeg}/${req.params.ccaaSeg}/`,
    title: `Ayudas para ${ben.label.toLowerCase()} en ${ccaaName} — ${H(hub)}`,
    summary: `${H(hub)} para ${ben.label.toLowerCase()} en ${ccaaName}.`,
    breadcrumbHtml: `<a href="/">Inicio</a> › <a href="/ayudas/${esc(req.params.benSeg)}/">${esc(ben.label)}</a> › <span>${esc(ccaaName)}</span>`,
    hub, alert: { beneficiario: ben.enumVal, ccaa: ccaaName }, intro: { kind: 'beneficiario', ccaaName, beneficiarioLabel: ben.label }, ownTitle: `De organismos de ${ccaaName}`,
  });
});
