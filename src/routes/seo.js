// Server-rendered public grant pages, aimed at search engines rather than the app's own
// visitors (who use the client-rendered / + chat). See ../../Convoca_V5_Spec.md and
// Downloads/plazoabierto-seo-plan.md for the full plan; this file implements §1/§2/§3/§7
// for grant_row ("ficha de convocatoria"). Hub pages (comunidad/provincia/sector/
// beneficiario) are ../routes/seoHubs.js, mounted after this router.
import { Router } from 'express';
import { db } from '../db.js';
import { BASE_URL, BENEFICIARIO_TYPES as TYPES, esc, eur, slugify, grantPath, daysLeft,
         CCAA_SLUGS, PROVINCE_CCAA, CATEGORY_SLUGS } from '../seoUtils.js';
import { NATIONWIDE } from '../ingest/regions.js';

export const seoRouter = Router();

function deadlineLabel(g) {
  if (g.status === 'CLOSED') return 'Plazo cerrado';
  if (g.is_rolling) return 'Plazo continuo (sin fecha límite)';
  if (!g.deadline_date) return 'Plazo por confirmar';
  const d = daysLeft(g.deadline_date);
  const est = g.deadline_source === 'computed' && !g.deadline_confirmed ? ' (fecha estimada)' : '';
  return (d <= 0 ? 'Último día' : `Quedan ${d} días`) + est;
}

function renderPage(g) {
  const path = grantPath(g);
  const canonical = BASE_URL + path;
  const head = g.plain_title || g.title;
  const year = (g.deadline_date || g.open_date || new Date().toISOString()).slice(0, 4);
  const title = `${head} ${year} — plazo, requisitos e importe | Plazo Abierto`;
  const amount = g.amount_max ? `hasta ${eur(g.amount_max)}` : (g.budget_total ? `bolsa de ${eur(g.budget_total)}` : 'según bases');
  const description = `${head}: ${amount}. ${g.deadline_date ? `Plazo hasta ${g.deadline_date}.` : ''} Resumen en castellano llano, requisitos y cómo pedirla.`.trim();

  const entityTypes = JSON.parse(g.entity_types || '[]').map(t => TYPES[t] || t).join(', ') || null;
  const quienPuede = entityTypes || g.territory_scope || 'Consulta las bases oficiales';

  let explainer = null;
  try { explainer = g.plain_explainer ? JSON.parse(g.plain_explainer) : null; } catch { explainer = null; }
  let checklist = null;
  try { checklist = g.plain_checklist ? JSON.parse(g.plain_checklist) : null; } catch { checklist = null; }

  const closedBanner = g.status === 'CLOSED' ? `
    <div class="closed-banner">
      <strong>Plazo cerrado.</strong> Esta convocatoria ya no acepta solicitudes.
      Se mantiene publicada porque suele repetirse cada año — vuelve a comprobarlo
      más adelante o consulta el organismo convocante para la próxima edición.
    </div>` : '';

  const explainerBlock = explainer ? `
    <div class="card">
      <h2>Explicación fácil</h2>
      ${[['¿Para qué es?', explainer.para_que], ['¿Quién puede pedirla?', explainer.quien_puede],
         ['¿Qué cubre?', explainer.que_cubre], ['¿Qué no cubre?', explainer.que_no_cubre],
         ['¿Cómo se pide?', explainer.como_se_pide]]
        .filter(([, v]) => v && v.trim())
        .map(([k, v]) => `<p><strong>${esc(k)}</strong><br>${esc(v)}</p>`).join('')}
    </div>` : '';

  const checklistBlock = checklist && checklist.length ? `
    <div class="card">
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
  // visitor) discovers those hub pages at all; there's no sitemap yet either. A hub link
  // can occasionally 404 if that hub has since dropped under MIN_LIVE - acceptable at
  // today's volume (2500+ grants), not worth a query per ficha render to pre-check.
  const ccaaSlug = g.region && g.region !== NATIONWIDE && [...CCAA_SLUGS.values()].includes(g.region) ? slugify(g.region) : null;
  const provinceSlug = g.province && ccaaSlug && PROVINCE_CCAA.get(g.province) === g.region ? slugify(g.province) : null;
  const categorySlug = g.category && CATEGORY_SLUGS.has(slugify(g.category)) ? slugify(g.category) : null;
  const beneficiarioLinks = JSON.parse(g.entity_types || '[]')
    .map(t => TYPES[t] ? { label: TYPES[t], slug: slugify(TYPES[t]) } : null)
    .filter(Boolean);

  const relatedLinks = [
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
      ...(g.amount_max ? { amount: { '@type': 'MonetaryAmount', currency: 'EUR', value: g.amount_max } } : {}),
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
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="stylesheet" href="/styles.css">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
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

<main class="wrap" style="max-width:720px;padding-top:1.5rem;padding-bottom:3rem">
  <nav class="muted" style="font-size:.82rem;margin-bottom:.6rem">
    <a href="/">Inicio</a>${ccaaSlug ? ` › <a href="/subvenciones/${ccaaSlug}/">${esc(g.region)}</a>` : ''}${categorySlug ? ` › <a href="/subvenciones/${categorySlug}/">${esc(g.category)}</a>` : ''} › <span>${esc(head)}</span>
  </nav>

  ${closedBanner}

  <p class="org muted">${esc(g.granting_body || '')}</p>
  <h1>${esc(head)}</h1>
  ${g.plain_title && g.title !== g.plain_title ? `<p class="official">Título oficial: ${esc(g.title)}</p>` : ''}

  <div class="card">
    <p><strong>Quién puede pedirla</strong><br>${esc(quienPuede)}</p>
    <p><strong>Cuánto</strong><br>${esc(amount)}</p>
    <p><strong>Hasta cuándo</strong><br>${esc(deadlineLabel(g))}${g.deadline_date ? ` (${esc(g.deadline_date)})` : ''}</p>
    <p><strong>Cómo se solicita</strong><br>${extras || 'Consulta las bases oficiales.'}</p>
    <p><strong>Fuente oficial</strong><br><a href="${esc(g.source_url)}" target="_blank" rel="noopener">Ver convocatoria en el BDNS →</a></p>
  </div>

  ${g.ai_summary ? `<p class="desc">${esc(g.ai_summary)}</p>` : ''}

  ${explainerBlock}
  ${checklistBlock}
  ${relatedBlock}

  <p class="official">Resumen generado automáticamente a partir de las bases oficiales
  (BDNS). Ante cualquier duda, prevalece siempre el texto de la convocatoria oficial
  enlazada arriba. Publicado: ${esc((g.created_at || '').slice(0, 10))}.</p>
</main>
</body>
</html>`;
}

seoRouter.get('/subvenciones/:slugId', (req, res, next) => {
  const m = /^(.*)-(\d+)$/.exec(req.params.slugId);
  if (!m) return next();
  const g = db.prepare(`
    SELECT gr.*, e.entity_types, e.territory_scope
    FROM grant_row gr LEFT JOIN grant_eligibility e ON e.grant_id = gr.id
    WHERE gr.bdns_ref = ? AND gr.published = 1`).get(m[2]);
  if (!g) return next();
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(renderPage(g));
});
