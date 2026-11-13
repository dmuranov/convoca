// Sitemaps - plan §6. No pre-generation step, same as the hub pages themselves: every
// sitemap is built live from grant_row on each request, so it's always current after an
// ingest without a separate "regenerate" job, and sitemap-hubs.xml can never list a hub
// that would actually 404 - it re-checks the exact same MIN_LIVE-gated queries the hub
// routes use (src/seoQueries.js), not a cached/stale count.
import { Router } from 'express';
import { isGrantIndexable } from '../grantSeo.js';
import { db } from '../db.js';
import { BASE_URL, esc, grantPath, licitacionPath, slugify, CCAA_SLUGS, PROVINCE_CCAA, CATEGORY_SLUGS, BENEFICIARIO_SLUGS } from '../seoUtils.js';
import { ccaaHub, provinceHub, categoryHub, estatalesHub, beneficiarioHub, beneficiarioCcaaHub } from '../seoQueries.js';

export const sitemapRouter = Router();

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n';
const urlset = (entries) => XML_HEADER +
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('')}</urlset>`;
const urlTag = (loc, lastmod, priority) =>
  `<url><loc>${esc(BASE_URL + loc)}</loc>${lastmod ? `<lastmod>${esc(lastmod)}</lastmod>` : ''}${priority != null ? `<priority>${priority}</priority>` : ''}</url>\n`;

// §6: "máximo 50.000 URLs cada uno" - nowhere near that yet (a few thousand grants, a few
// hundred hub combinations), but the cap is enforced from day one so nothing has to change
// shape later.
const MAX_PER_SITEMAP = 50_000;

sitemapRouter.get('/sitemap_index.xml', (req, res) => {
  const now = new Date().toISOString();
  const body = XML_HEADER +
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    `<sitemap><loc>${esc(BASE_URL)}/sitemap-hubs.xml</loc><lastmod>${now}</lastmod></sitemap>\n` +
    `<sitemap><loc>${esc(BASE_URL)}/sitemap-grants.xml</loc><lastmod>${now}</lastmod></sitemap>\n` +
    `<sitemap><loc>${esc(BASE_URL)}/sitemap-licitaciones.xml</loc><lastmod>${now}</lastmod></sitemap>\n` +
    `</sitemapindex>`;
  res.set('Content-Type', 'application/xml; charset=utf-8').send(body);
});

// Every indexable published grant (isGrantIndexable, src/grantSeo.js - the same test the page
// uses, so the sitemap never lists a noindex or a 410 page): open calls, and calls closed in
// the last few weeks, with our plain-language explanation. Direct awards, long-closed calls
// and unpublished grants are not here.
// Prioritised per §6 - "small crawl budget on a new domain, prioritise what closes
// soon" - open-and-closing-soonest first, closed ones last since they're least likely to
// earn a fresh crawl and least urgent if they don't get one immediately.
sitemapRouter.get('/sitemap-grants.xml', (req, res) => {
  const rows = db.prepare(`
    SELECT bdns_ref, plain_title, title, status, deadline_date, created_at, closed_at, plain_explainer
    FROM grant_row WHERE published = 1 AND plain_explainer IS NOT NULL
    ORDER BY status = 'CLOSED', deadline_date IS NULL, CASE WHEN status = 'CLOSED' THEN closed_at END DESC, deadline_date
    LIMIT ?`).all(MAX_PER_SITEMAP);

  const entries = rows.filter(g => isGrantIndexable(g)).map(g => {
    const priority = g.status === 'CLOSED' ? 0.3 : 0.7;
    // A closed page changed when it closed (banner, open grants linked): say so.
    const lastmod = (g.status === 'CLOSED' && g.closed_at ? g.closed_at : g.created_at || '').slice(0, 10) || null;
    return urlTag(grantPath(g), lastmod, priority);
  });
  res.set('Content-Type', 'application/xml; charset=utf-8').send(urlset(entries));
});

// Every published licitación (same §5 reasoning as grants: non-active estados stay
// indexable with a status banner, so no estado filter here either). Active ('licitacion')
// first, ordered by closest deadline; everything else last and lower-priority.
sitemapRouter.get('/sitemap-licitaciones.xml', (req, res) => {
  const rows = db.prepare(`
    SELECT id, titulo, expediente, estado, fecha_limite, created_at
    FROM licitacion_row WHERE published = 1
    ORDER BY estado != 'licitacion', fecha_limite IS NULL, fecha_limite
    LIMIT ?`).all(MAX_PER_SITEMAP);

  const entries = rows.map(l => {
    const priority = l.estado === 'licitacion' ? 0.7 : 0.3;
    return urlTag(licitacionPath(l), (l.created_at || '').slice(0, 10) || null, priority);
  });
  res.set('Content-Type', 'application/xml; charset=utf-8').send(urlset(entries));
});

// One entry per hub that currently exists - computed with the exact same hub functions
// (src/seoQueries.js) the hub routes themselves gate on, so this list and what actually 200s can
// never drift apart.
sitemapRouter.get('/sitemap-hubs.xml', (req, res) => {
  const entries = [];
  const add = (path, hub, priority) => {
    if (!hub.ok) return;
    const lastmod = hub.all.reduce((m, g) => (g.created_at > m ? g.created_at : m), '').slice(0, 10) || null;
    entries.push(urlTag(path, lastmod, priority));
  };

  add('/subvenciones/estatales/', estatalesHub(), 0.6);
  for (const [slug, name] of CCAA_SLUGS) add(`/subvenciones/${slug}/`, ccaaHub(name), 0.6);
  for (const [slug, name] of CATEGORY_SLUGS) add(`/subvenciones/${slug}/`, categoryHub(name), 0.6);
  for (const [benSlug, ben] of BENEFICIARIO_SLUGS) add(`/ayudas/${benSlug}/`, beneficiarioHub(ben.enumVal), 0.6);

  for (const [province, ccaaName] of PROVINCE_CCAA) {
    if (!ccaaName) continue;
    const ccaaSlug = slugify(ccaaName);
    add(`/subvenciones/${ccaaSlug}/${slugify(province)}/`, provinceHub(ccaaName, province), 0.5);
  }
  for (const [benSlug, ben] of BENEFICIARIO_SLUGS) {
    for (const [ccaaSlug, ccaaName] of CCAA_SLUGS) {
      // §1: the intersection pages ("las que más convierten") - also the ones most likely
      // to fall under MIN_LIVE, which `add()` already gates on.
      add(`/ayudas/${benSlug}/${ccaaSlug}/`, beneficiarioCcaaHub(ben.enumVal, ccaaName), 0.8);
    }
  }

  res.set('Content-Type', 'application/xml; charset=utf-8').send(urlset(entries.slice(0, MAX_PER_SITEMAP)));
});
