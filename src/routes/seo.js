// Server-rendered public grant pages, aimed at search engines rather than the app's own
// visitors (who use the client-rendered / + chat). See ../../Convoca_V5_Spec.md and
// Downloads/plazoabierto-seo-plan.md for the full plan; this file implements §1/§2/§3/§7
// for grant_row ("ficha de convocatoria"). Hub pages (comunidad/provincia/sector/
// beneficiario) are ../routes/seoHubs.js, mounted after this router.
import { Router } from 'express';
import { db } from '../db.js';
import { BASE_URL, BENEFICIARIO_TYPES as TYPES, esc, slugify, grantPath, daysLeft, daysLabel,
         CCAA_SLUGS, PROVINCE_CCAA, CATEGORY_SLUGS } from '../seoUtils.js';
import { NATIONWIDE } from '../ingest/regions.js';
import { alertBox, ALERT_ASSETS } from '../seoUtils.js';
import { isBusinessGrant } from '../negocios.js';
import { grantSeoTitle, grantSeoDescription, isGrantIndexable, isGrantLive, whoCanApplyShort, amountLabel, realAmount } from '../grantSeo.js';
import { relatedOpenGrants } from '../seoQueries.js';
import { organismFor } from '../organismos.js';
import { siteHeader, siteFooter, liveHubs, pageShell, hubNav, ESTATALES_PATH } from '../siteChrome.js';

export const seoRouter = Router();

function deadlineLabel(g) {
  if (g.status === 'CLOSED') return 'Plazo cerrado';
  if (g.is_rolling) return 'Plazo continuo (sin fecha límite)';
  if (!g.deadline_date) return 'Plazo por confirmar';
  const d = daysLeft(g.deadline_date);
  const est = g.deadline_source === 'computed' && !g.deadline_confirmed ? ' (fecha estimada)' : '';
  const label = daysLabel(d);
  return label.charAt(0).toUpperCase() + label.slice(1) + est;
}

// Open grants offered on the 410 page of an expired call: same town first, then province,
// subject, comunidad (relatedOpenGrants, src/seoQueries.js).
const relatedOpenList = (related) => related.length ? `
  <div class="card related-open">
    <h2>Convocatorias abiertas parecidas</h2>
    <ul>${related.map(r => {
      const d = daysLeft(r.deadline_date);
      const when = d != null ? daysLabel(d) : r.is_rolling ? 'plazo continuo' : 'plazo por confirmar';
      return `<li><a href="${esc(grantPath(r))}">${esc(r.plain_title || r.title)}</a>
        <span class="muted">— ${esc([r.municipality || r.province || r.region, when].filter(Boolean).join(' · '))}</span></li>`;
    }).join('')}</ul>
  </div>` : '';

function renderPage(g) {
  const path = grantPath(g);
  const canonical = BASE_URL + path;
  const head = g.plain_title || g.title;
  // Says it is a subsidy and who gives it (src/grantSeo.js): titles that read like the event
  // itself drew searches the page cannot answer.
  const title = grantSeoTitle(g);
  const indexable = isGrantIndexable(g);
  const amount = amountLabel(g);
  const description = grantSeoDescription(g);

  // BDNS's own beneficiary types first: the AI entity list cannot say 'pymes' or 'particulares'.
  const quienPuede = whoCanApplyShort(g, TYPES) || g.territory_scope || 'Consulta las bases oficiales';

  let explainer = null;
  try { explainer = g.plain_explainer ? JSON.parse(g.plain_explainer) : null; } catch { explainer = null; }
  let checklist = null;
  try { checklist = g.plain_checklist ? JSON.parse(g.plain_checklist) : null; } catch { checklist = null; }

  const explainerBlock = explainer ? `
    <div class="card" id="explicacion">
      <h2>Explicación fácil</h2>
      ${[['¿Para qué es?', explainer.para_que], ['¿Cuánto dan?', amount === 'según bases' ? null : amount.charAt(0).toUpperCase() + amount.slice(1) + '.'],
         ['¿Quién puede pedirla?', explainer.quien_puede],
         ['¿Qué cubre?', explainer.que_cubre], ['¿Qué no cubre?', explainer.que_no_cubre],
         ['¿Cómo se pide?', explainer.como_se_pide]]
        .filter(([, v]) => v && v.trim())
        .map(([k, v]) => `<p><strong>${esc(k)}</strong><br>${esc(v)}</p>`).join('')}
    </div>` : '';

  const checklistBlock = checklist && checklist.length ? `
    <div class="card" id="papeles">
      <h2>¿Qué papeles necesito?</h2>
      ${checklist.map(d => `<p><strong>${esc(d.documento)}</strong><br>${esc(d.para_que_sirve)}<br>
        <em>Dónde: ${esc(d.donde_conseguirlo)}</em></p>`).join('')}
    </div>` : '';

  const extras = [
    g.sede_url ? `<a href="${esc(g.sede_url)}" target="_blank" rel="noopener">Sede electrónica</a>` : '',
    g.application_url ? `<a href="${esc(g.application_url)}" target="_blank" rel="noopener">Bases reguladoras</a>` : '',
  ].filter(Boolean).join(' · ');

  // §7 internal linking: every ficha links out to its comunidad/provincia/sector/
  // beneficiario hubs (when they exist in our fixed taxonomy) - this is how Google (and a
  // visitor) discovers those hub pages. Only hubs that answer right now are linked
  // (liveHubs, src/siteChrome.js - cached ten minutes), so a ficha never links to a 404.
  const hubs = liveHubs();
  const ccaaSlug = g.region && g.region !== NATIONWIDE && hubs.ccaa.includes(g.region) ? slugify(g.region) : null;
  const estatal = g.region === NATIONWIDE && hubs.estatales;
  const provinceSlug = g.province && ccaaSlug && PROVINCE_CCAA.get(g.province) === g.region && hubs.provinces.includes(g.province) ? slugify(g.province) : null;
  const categorySlug = g.category && hubs.categories.includes(CATEGORY_SLUGS.get(slugify(g.category))) ? slugify(g.category) : null;
  const beneficiarioLinks = JSON.parse(g.entity_types || '[]')
    .map(t => TYPES[t] ? { label: TYPES[t], slug: slugify(TYPES[t]) } : null)
    .filter(Boolean);

  const org = organismFor({ granting_body: g.granting_body });
  const relatedLinks = [
    org ? `<a href="${esc(org.path)}">Todas las convocatorias ${esc(`${org.de} ${org.name}`)}</a>` : '',
    estatal ? `<a href="${ESTATALES_PATH}">Más subvenciones estatales</a>` : '',
    ccaaSlug ? `<a href="/subvenciones/${ccaaSlug}/">Más subvenciones en ${esc(g.region)}</a>` : '',
    provinceSlug ? `<a href="/subvenciones/${ccaaSlug}/${provinceSlug}/">Más subvenciones en ${esc(g.province)}</a>` : '',
    categorySlug ? `<a href="/subvenciones/${categorySlug}/">Más subvenciones de ${esc(g.category.toLowerCase())}</a>` : '',
    ...beneficiarioLinks.map(b => `<a href="/ayudas/${b.slug}/${ccaaSlug ? ccaaSlug + '/' : ''}">Más ayudas para ${esc(b.label.toLowerCase())}${ccaaSlug ? ` en ${esc(g.region)}` : ''}</a>`),
  ].filter(Boolean);
  const relatedBlock = relatedLinks.length ? `
    <div class="card">
      <h2>Ver más</h2>
      <p>${relatedLinks.join('<br>')}</p>
    </div>` : '';

  // JSON-LD: MonetaryGrant (§3). BreadcrumbList extends through comunidad/sector when
  // those hubs exist for this grant.
  const breadcrumbItems = [
    { '@type': 'ListItem', position: 1, name: 'Inicio', item: BASE_URL + '/' },
  ];
  if (estatal) breadcrumbItems.push({ '@type': 'ListItem', position: 2, name: 'Subvenciones estatales', item: BASE_URL + ESTATALES_PATH });
  if (ccaaSlug) breadcrumbItems.push({ '@type': 'ListItem', position: breadcrumbItems.length + 1, name: g.region, item: `${BASE_URL}/subvenciones/${ccaaSlug}/` });
  if (categorySlug) breadcrumbItems.push({ '@type': 'ListItem', position: breadcrumbItems.length + 1, name: g.category, item: `${BASE_URL}/subvenciones/${categorySlug}/` });
  breadcrumbItems.push({ '@type': 'ListItem', position: breadcrumbItems.length + 1, name: head, item: canonical });

  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'MonetaryGrant',
      name: head,
      description: g.ai_summary || description,
      url: canonical,
      ...(g.granting_body ? { funder: { '@type': 'Organization', name: g.granting_body } } : {}),
      ...(realAmount(g.amount_max) ? { amount: { '@type': 'MonetaryAmount', currency: 'EUR', value: g.amount_max } } : {}),
      ...(g.deadline_date && g.status !== 'CLOSED' ? { applicationDeadline: g.deadline_date } : {}),
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: breadcrumbItems,
    },
  ];

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description.slice(0, 160))}">
<link rel="canonical" href="${esc(canonical)}">
<meta name="robots" content="${indexable ? 'index, follow' : 'noindex, follow'}">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="stylesheet" href="/styles.css">
${ALERT_ASSETS}
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head>
<body>
${siteHeader()}

<main class="wrap" style="max-width:720px;padding-top:1.5rem;padding-bottom:3rem">
  <nav class="muted" style="font-size:.82rem;margin-bottom:.6rem">
    <a href="/">Inicio</a>${estatal ? ` › <a href="${ESTATALES_PATH}">Subvenciones estatales</a>` : ''}${ccaaSlug ? ` › <a href="/subvenciones/${ccaaSlug}/">${esc(g.region)}</a>` : ''}${categorySlug ? ` › <a href="/subvenciones/${categorySlug}/">${esc(g.category)}</a>` : ''} › <span>${esc(head)}</span>
  </nav>

  <h1>${esc(head)}</h1>

  <!-- Our plain-language guide first; the official BDNS record after it. -->
  ${g.ai_summary ? `<p class="desc">${esc(g.ai_summary)}</p>` : ''}
  <p class="key-facts">
    <span class="chip"><span class="k">Cuánto</span><span class="v">${esc(amount)}</span></span>
    <span class="chip"><span class="k">Hasta cuándo</span><span class="v">${esc(deadlineLabel(g))}${g.deadline_date ? ` (${esc(g.deadline_date)})` : ''}</span></span>
  </p>

  ${explainerBlock}
  ${explainer ? '' : `<div class="card"><p><strong>Quién puede pedirla</strong><br>${esc(quienPuede)}</p></div>`}
  ${checklistBlock}

  <div class="card">
    <h2>Datos oficiales de la convocatoria</h2>
    ${g.granting_body ? `<p><strong>Organismo convocante</strong><br>${esc(g.granting_body)}</p>` : ''}
    ${g.plain_title && g.title !== g.plain_title ? `<p><strong>Título oficial</strong><br>${esc(g.title)}</p>` : ''}
    ${explainer ? `<p><strong>Quién puede pedirla</strong><br>${esc(quienPuede)}</p>` : ''}
    <p><strong>Cómo se solicita</strong><br>${extras || 'Consulta las bases oficiales.'}</p>
    <p><a class="btn" href="${esc(g.source_url)}" target="_blank" rel="noopener">Texto original de la convocatoria →</a><br>
      <span class="official">Base de Datos Nacional de Subvenciones, n.º ${esc(g.bdns_ref)}</span></p>
  </div>

  ${relatedBlock}

  ${alertBox(isBusinessGrant(g) ? 'negocios' : 'subvenciones', {
    ccaa: g.region !== NATIONWIDE ? g.region : null, province: g.province, category: g.category })}

  <p class="official">Resumen generado automáticamente a partir de las bases oficiales
  (BDNS). Ante cualquier duda, prevalece siempre el texto de la convocatoria oficial
  enlazada arriba. Publicado: ${esc((g.created_at || '').slice(0, 10))}.</p>
</main>
${siteFooter()}
</body>
</html>`;
}

seoRouter.get('/subvenciones/:slugId', (req, res, next) => {
  const m = /^(.*)-(\d+)$/.exec(req.params.slugId);
  if (!m) return next();
  const g = db.prepare(`
    SELECT gr.*, e.entity_types, e.applicant_v, e.territory_scope
    FROM grant_row gr LEFT JOIN grant_eligibility e ON e.grant_id = gr.id
    WHERE gr.bdns_ref = ? AND gr.published = 1`).get(m[2]);
  if (!g) return next();
  // Expired calls (and direct awards) are not on the site (isGrantLive, src/grantSeo.js):
  // 410 Gone, so search engines drop the address, with open grants like it for whoever
  // followed an old link.
  if (!isGrantLive(g)) {
    return res.status(410).set('Content-Type', 'text/html; charset=utf-8').send(pageShell({
      title: 'Convocatoria terminada | Plazo Abierto',
      description: 'El plazo de esta convocatoria ha terminado. Consulta las subvenciones con el plazo abierto.',
      canonical: BASE_URL + '/', robots: 'noindex, follow',
      breadcrumbHtml: '<a href="/">Inicio</a>',
      bodyHtml: `<h1>El plazo de esta convocatoria ha terminado</h1>
        <p>Solo mostramos convocatorias que todavía se pueden pedir. Mira las que tienen el plazo abierto:</p>
        ${relatedOpenList(relatedOpenGrants(g))}
        <p><a class="btn" href="/">Ver todas las subvenciones abiertas</a></p>
        ${hubNav()}`,
    }));
  }
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(renderPage(g));
});
