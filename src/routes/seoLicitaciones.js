// Server-rendered public licitación pages - the licitaciones counterpart to
// src/routes/seo.js's grant fichas ("mismo esquema, pestaña aparte" per the SEO plan).
// No hub pages for this tier yet (comunidad/sector/tipo_contrato) - only detail pages,
// same as grants got their fichas before their hubs.
import { Router } from 'express';
import { db } from '../db.js';
import { BASE_URL, esc, eur, slugify, licitacionPath, daysLeft } from '../seoUtils.js';
import { ESTADO_LABEL } from '../ingest/enrichLicitacion.js';

export const seoLicitacionesRouter = Router();

// licitacion_row.id is a plain uuid() (crypto.randomUUID()) - always this exact shape,
// unlike a PLACSP expediente which routinely contains slashes/spaces. Slug is cosmetic and
// never trusted for lookup, same resilience property as grantPath's bdns_ref.
const ID_RE = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function deadlineLabel(l) {
  if (l.estado !== 'licitacion') return ESTADO_LABEL[l.estado] || l.estado;
  if (!l.fecha_limite) return 'Plazo por confirmar';
  const d = daysLeft(l.fecha_limite);
  return d <= 0 ? 'Último día' : `Quedan ${d} días`;
}

function renderPage(l) {
  const path = licitacionPath(l);
  const canonical = BASE_URL + path;
  const head = l.titulo || `Licitación ${l.expediente}`;
  const year = (l.fecha_limite || l.updated_at || new Date().toISOString()).slice(0, 4);
  // Expediente belongs in <title> more than anywhere else on the page: it's the exact
  // string a contractor searches ("CMA 01/2026") to find a specific tender again, and
  // title is what that query actually matches against - the <h1> copy alone doesn't help.
  const title = `${head} — Exp. ${l.expediente} (${year}) | Plazo Abierto`;
  const amount = l.presupuesto_base
    ? `${eur(l.presupuesto_base)}${l.iva === 'incluido' ? ' (IVA incluido)' : l.iva === 'excluido' ? ' (sin IVA)' : ''}`
    : (l.valor_estimado ? `valor estimado ${eur(l.valor_estimado)}` : 'según pliegos');
  const description = `${head} (Expediente ${l.expediente}): ${amount}. ${l.fecha_limite ? `Plazo hasta ${l.fecha_limite}.` : ''} Licitación pública, requisitos y cómo presentarse.`.trim();

  let tareas = []; try { tareas = JSON.parse(l.que_hay_que_hacer || '[]'); } catch { tareas = []; }
  let requisitos = []; try { requisitos = JSON.parse(l.requisitos_clave || '[]'); } catch { requisitos = []; }
  let pliegos = []; try { pliegos = JSON.parse(l.pliegos || '[]'); } catch { pliegos = []; }
  let camposAusentes = []; try { camposAusentes = JSON.parse(l.campos_ausentes || '[]'); } catch { camposAusentes = []; }

  // Non-active states stay indexable (same §5 reasoning as grants' "Plazo cerrado" banner)
  // rather than disappearing - a resuelta/adjudicada licitación is still a real record of
  // who won what, useful to someone researching a contracting body's history.
  const statusBanner = l.estado !== 'licitacion' ? `
    <div class="closed-banner">
      <strong>${esc(ESTADO_LABEL[l.estado] || l.estado)}.</strong>
      ${l.estado === 'anuncio_previo' ? 'Todavía no se puede presentar oferta.' : 'Ya no se aceptan ofertas para esta licitación.'}
      Se mantiene publicada como registro de la convocatoria.
    </div>` : '';

  const explainerBlock = (l.quien_puede_interesarle || tareas.length) ? `
    <div class="card">
      <h2>Explicación fácil</h2>
      ${l.quien_puede_interesarle ? `<p><strong>¿A quién le interesa?</strong><br>${esc(l.quien_puede_interesarle)}</p>` : ''}
      ${tareas.length ? `<p><strong>¿Qué hay que hacer?</strong></p><ul>${tareas.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
    </div>` : '';

  const requisitosBlock = requisitos.length ? `
    <div class="card">
      <h2>Requisitos clave</h2>
      ${requisitos.map(r => `<p>${esc(r)}</p>`).join('')}
    </div>` : '';

  const pliegoLinks = pliegos.map(p => `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.nombre)}</a>`).join(' · ');
  const complejidad = l.complejidad
    ? `<p><strong>Complejidad</strong><br>${esc(l.complejidad)}${l.complejidad_motivo ? ` — ${esc(l.complejidad_motivo)}` : ''}</p>` : '';

  const jsonLd = [{
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Inicio', item: BASE_URL + '/' },
      { '@type': 'ListItem', position: 2, name: 'Licitaciones', item: BASE_URL + '/licitaciones' },
      { '@type': 'ListItem', position: 3, name: head, item: canonical },
    ],
  }];

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
        <a class="tab" href="/">Subvenciones</a>
        <a class="tab on" href="/licitaciones">Licitaciones</a>
      </div>
      <a class="btn ghost" href="/entrar">Entrar</a>
    </nav>
  </div>
</header>

<main class="wrap" style="max-width:720px;padding-top:1.5rem;padding-bottom:3rem">
  <nav class="muted" style="font-size:.82rem;margin-bottom:.6rem">
    <a href="/">Inicio</a> › <a href="/licitaciones">Licitaciones</a> › <span>${esc(head)}</span>
  </nav>

  ${statusBanner}

  <p class="org muted">${esc(l.organo || '')}</p>
  <h1>${esc(head)} <span class="muted" style="font-size:.55em;font-weight:400">— Expediente ${esc(l.expediente)}</span></h1>

  <div class="card">
    <p><strong>Quién puede presentarse</strong><br>${esc(l.quien_puede_interesarle || 'Consulta los pliegos oficiales')}</p>
    <p><strong>Presupuesto</strong><br>${esc(amount)}</p>
    <p><strong>Hasta cuándo</strong><br>${esc(deadlineLabel(l))}${l.fecha_limite ? ` (${esc(l.fecha_limite)})` : ''}</p>
    <p><strong>Tipo / procedimiento</strong><br>${esc([l.tipo_contrato, l.procedimiento].filter(Boolean).join(' · ') || 'Consulta los pliegos oficiales')}</p>
    ${l.lugar ? `<p><strong>Lugar de ejecución</strong><br>${esc(l.lugar)}</p>` : ''}
    ${complejidad}
    <p><strong>Fuente oficial</strong><br><a href="${esc(l.source_url)}" target="_blank" rel="noopener">Ver licitación en PLACSP →</a></p>
    ${pliegoLinks ? `<p><strong>Pliegos</strong><br>${pliegoLinks}</p>` : ''}
  </div>

  ${l.resumen ? `<p class="desc">${esc(l.resumen)}</p>` : ''}

  ${explainerBlock}
  ${requisitosBlock}

  <p class="official">Resumen generado automáticamente a partir del anuncio y los pliegos
  oficiales. Ante cualquier duda, prevalece siempre el texto de la licitación oficial
  enlazada arriba.${camposAusentes.length ? ` Sin especificar en los pliegos: ${esc(camposAusentes.join(', '))}.` : ''}
  Publicado: ${esc((l.created_at || '').slice(0, 10))}.</p>
</main>
</body>
</html>`;
}

seoLicitacionesRouter.get('/licitaciones/:slugId', (req, res, next) => {
  const m = ID_RE.exec(req.params.slugId);
  if (!m) return next();
  const l = db.prepare('SELECT * FROM licitacion_row WHERE id = ? AND published = 1').get(m[1]);
  if (!l) return next();
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(renderPage(l));
});
