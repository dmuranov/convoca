// Hub pages (comunidad / provincia / sector / beneficiario) - Downloads/plazoabierto-seo-plan.md
// §1/§3/§4, ordered after seoRouter (src/routes/seo.js) so its bdns_ref-suffixed grant
// URLs are tried first; anything that isn't a grant slug falls through to here.
//
// No pre-generation step: every hub is computed live from grant_row on each request, so
// there is nothing to regenerate after ingest and a hub that drops below the minimum
// simply 404s again next time it's crawled - it never sits indexed empty (§1: "una página
// con cero resultados es una doorway page").
import { Router } from 'express';
import { BASE_URL, esc, grantPath, grantListItem, pageShell,
         CCAA_SLUGS, PROVINCE_CCAA, PROVINCE_SLUGS, CATEGORY_SLUGS, BENEFICIARIO_SLUGS } from '../seoUtils.js';
import { MIN_LIVE, grantsByCcaa, grantsByProvince, grantsByCategory,
         grantsByBeneficiario, grantsByBeneficiarioCcaa } from '../seoQueries.js';

export const seoHubsRouter = Router();

// ---- rendering ----

function renderHub({ path, title, intro, breadcrumbHtml, grants }) {
  const canonical = BASE_URL + path;
  const jsonLd = [{
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: grants.map((g, i) => ({
      '@type': 'ListItem', position: i + 1, name: g.plain_title || g.title, url: BASE_URL + grantPath(g),
    })),
  }];
  const body = `
    <h1>${esc(title)}</h1>
    <p class="muted">${esc(intro)}</p>
    <div class="grants-grid">${grants.map(grantListItem).join('')}</div>
  `;
  return pageShell({
    title: `${title} | Plazo Abierto`,
    description: intro,
    canonical, jsonLd, breadcrumbHtml, bodyHtml: body,
  });
}

const H = (grants) => `${grants.length} convocatoria${grants.length === 1 ? '' : 's'} abierta${grants.length === 1 ? '' : 's'}`;

// /subvenciones/<comunidad>/  or  /subvenciones/<sector>/  (single segment, tried after
// seoRouter's grant-detail match on the same path shape)
seoHubsRouter.get('/subvenciones/:seg', (req, res, next) => {
  const ccaaName = CCAA_SLUGS.get(req.params.seg);
  if (ccaaName) {
    const grants = grantsByCcaa(ccaaName);
    if (grants.length < MIN_LIVE) return next();
    const title = `Subvenciones en ${ccaaName} — ${grants.length} convocatorias abiertas`;
    return res.set('Content-Type', 'text/html; charset=utf-8').send(renderHub({
      path: `/subvenciones/${req.params.seg}/`,
      title,
      intro: `${H(grants)} para pueblos, asociaciones y entidades locales de ${ccaaName}, en castellano llano.`,
      breadcrumbHtml: `<a href="/">Inicio</a> › <span>${esc(ccaaName)}</span>`,
      grants,
    }));
  }

  const categoryName = CATEGORY_SLUGS.get(req.params.seg);
  if (categoryName) {
    const grants = grantsByCategory(categoryName);
    if (grants.length < MIN_LIVE) return next();
    const title = `Subvenciones de ${categoryName.toLowerCase()} — ${grants.length} convocatorias abiertas`;
    return res.set('Content-Type', 'text/html; charset=utf-8').send(renderHub({
      path: `/subvenciones/${req.params.seg}/`,
      title,
      intro: `${H(grants)} de ${categoryName.toLowerCase()} para pueblos, asociaciones y entidades locales.`,
      breadcrumbHtml: `<a href="/">Inicio</a> › <span>${esc(categoryName)}</span>`,
      grants,
    }));
  }

  next();
});

// /subvenciones/<comunidad>/<provincia>/
seoHubsRouter.get('/subvenciones/:ccaaSeg/:provSeg', (req, res, next) => {
  const ccaaName = CCAA_SLUGS.get(req.params.ccaaSeg);
  const provinceName = PROVINCE_SLUGS.get(req.params.provSeg);
  if (!ccaaName || !provinceName || PROVINCE_CCAA.get(provinceName) !== ccaaName) return next();

  const grants = grantsByProvince(ccaaName, provinceName);
  if (grants.length < MIN_LIVE) return next();
  const title = `Subvenciones en ${provinceName} — ${grants.length} convocatorias abiertas`;
  res.set('Content-Type', 'text/html; charset=utf-8').send(renderHub({
    path: `/subvenciones/${req.params.ccaaSeg}/${req.params.provSeg}/`,
    title,
    intro: `${H(grants)} para pueblos, asociaciones y entidades locales de la provincia de ${provinceName}.`,
    breadcrumbHtml: `<a href="/">Inicio</a> › <a href="/subvenciones/${esc(req.params.ccaaSeg)}/">${esc(ccaaName)}</a> › <span>${esc(provinceName)}</span>`,
    grants,
  }));
});

// /ayudas/<beneficiario>/
seoHubsRouter.get('/ayudas/:benSeg', (req, res, next) => {
  const ben = BENEFICIARIO_SLUGS.get(req.params.benSeg);
  if (!ben) return next();
  const grants = grantsByBeneficiario(ben.enumVal);
  if (grants.length < MIN_LIVE) return next();
  const title = `Ayudas para ${ben.label.toLowerCase()} — ${grants.length} convocatorias abiertas`;
  res.set('Content-Type', 'text/html; charset=utf-8').send(renderHub({
    path: `/ayudas/${req.params.benSeg}/`,
    title,
    intro: `${H(grants)} para ${ben.label.toLowerCase()}, en castellano llano.`,
    breadcrumbHtml: `<a href="/">Inicio</a> › <span>${esc(ben.label)}</span>`,
    grants,
  }));
});

// /ayudas/<beneficiario>/<comunidad>/ - the intersection pages the plan calls out as
// converting best; also the ones most likely to fall under MIN_LIVE, hence the gate.
seoHubsRouter.get('/ayudas/:benSeg/:ccaaSeg', (req, res, next) => {
  const ben = BENEFICIARIO_SLUGS.get(req.params.benSeg);
  const ccaaName = CCAA_SLUGS.get(req.params.ccaaSeg);
  if (!ben || !ccaaName) return next();
  const grants = grantsByBeneficiarioCcaa(ben.enumVal, ccaaName);
  if (grants.length < MIN_LIVE) return next();
  const title = `Ayudas para ${ben.label.toLowerCase()} en ${ccaaName} — ${grants.length} convocatorias abiertas`;
  res.set('Content-Type', 'text/html; charset=utf-8').send(renderHub({
    path: `/ayudas/${req.params.benSeg}/${req.params.ccaaSeg}/`,
    title,
    intro: `${H(grants)} para ${ben.label.toLowerCase()} en ${ccaaName}.`,
    breadcrumbHtml: `<a href="/">Inicio</a> › <a href="/ayudas/${esc(req.params.benSeg)}/">${esc(ben.label)}</a> › <span>${esc(ccaaName)}</span>`,
    grants,
  }));
});
