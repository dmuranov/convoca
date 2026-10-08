// The two emails alerts send: the double opt-in confirmation and the digest. HTML + plain text,
// short Spanish copy, no images or tracking pixels. Every digest carries a one-click unsubscribe
// link plus the List-Unsubscribe / List-Unsubscribe-Post headers (RFC 8058).
import { BASE_URL, esc, grantPath, licitacionPath } from '../seoUtils.js';
import { describeSubscription } from './filters.js';

export const MAX_DIGEST_ITEMS = 20;

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
  'septiembre', 'octubre', 'noviembre', 'diciembre'];
const fecha = (iso) => {
  if (!iso) return null;
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return y && m && d ? `${d} de ${MESES[m - 1]} de ${y}` : null;
};
const eur = (n) => (n == null ? null : `${Math.round(Number(n)).toLocaleString('es-ES')} €`);

export const confirmUrl = (sub) => `${BASE_URL}/alertas/confirmar?t=${encodeURIComponent(sub.confirm_token)}`;
export const unsubscribeUrl = (sub) => `${BASE_URL}/alertas/baja?t=${encodeURIComponent(sub.unsubscribe_token)}`;

export const unsubscribeHeaders = (sub) => ({
  'List-Unsubscribe': `<${unsubscribeUrl(sub)}>`,
  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
});

const layout = (inner, footer) => `<!doctype html><html lang="es"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px;background:#f6f7f9;font-family:Arial,Helvetica,sans-serif;color:#1d2433">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;padding:24px">
<p style="margin:0 0 16px;font-weight:bold;font-size:18px">Plazo<span style="color:#1d5c9d">Abierto</span></p>
${inner}
<p style="margin-top:28px;font-size:12px;color:#6b7280">${footer}</p>
</div></body></html>`;

export function confirmationEmail(sub) {
  const what = describeSubscription(sub.section, JSON.parse(sub.filters || '{}'));
  const freq = sub.frequency === 'daily' ? 'cada día' : 'cada lunes';
  const subject = 'Confirma tu aviso de Plazo Abierto';
  const html = layout(`
<p>Hola:</p>
<p>Has pedido que te avisemos de nuevas convocatorias de <strong>${esc(what)}</strong>. Te escribiremos ${freq}, solo si hay novedades.</p>
<p style="margin:24px 0"><a href="${esc(confirmUrl(sub))}" style="background:#1d5c9d;color:#fff;padding:12px 18px;border-radius:6px;text-decoration:none;display:inline-block">Confirmar aviso</a></p>
<p>Si no lo has pedido tú, ignora este correo y no te escribiremos más.</p>`,
    `Recibes este correo porque alguien escribió esta dirección en plazoabierto.es. <a href="${esc(unsubscribeUrl(sub))}">No quiero recibir nada</a> · <a href="${esc(BASE_URL)}/privacidad">Privacidad</a>.`);
  const text = `Has pedido que te avisemos de nuevas convocatorias de ${what}. Te escribiremos ${freq}, solo si hay novedades.

Confirma aquí: ${confirmUrl(sub)}

Si no lo has pedido tú, ignora este correo y no te escribiremos más.
No quiero recibir nada: ${unsubscribeUrl(sub)}`;
  return { subject, html, text, headers: unsubscribeHeaders(sub) };
}

function utm(url, frequency) {
  const u = new URL(url, BASE_URL);
  u.searchParams.set('utm_source', 'email');
  u.searchParams.set('utm_medium', 'alert');
  u.searchParams.set('utm_campaign', frequency === 'daily' ? 'daily' : 'weekly');
  return u.toString();
}

// Normalised digest line for either kind of item.
export function digestLine(item) {
  if (item.kind === 'licitacion') {
    return {
      title: item.titulo || item.expediente,
      url: BASE_URL + licitacionPath(item),
      amount: item.presupuesto_base ? `Presupuesto: ${eur(item.presupuesto_base)}` : 'Importe: según pliegos',
      deadline: item.fecha_limite ? `Plazo: hasta el ${fecha(item.fecha_limite)}` : 'Plazo: por confirmar',
      org: item.organo || '',
    };
  }
  const estimated = item.deadline_source === 'computed' && !item.deadline_confirmed;
  return {
    title: item.plain_title || item.title,
    url: BASE_URL + grantPath(item),
    amount: item.amount_max ? `Hasta ${eur(item.amount_max)}` : item.budget_total ? `${eur(item.budget_total)} en total` : 'Importe: según bases',
    deadline: item.is_rolling ? 'Plazo: abierto de forma continua'
      : item.deadline_date ? `Plazo: hasta el ${fecha(item.deadline_date)}${estimated ? ' (fecha estimada)' : ''}` : 'Plazo: por confirmar',
    org: item.granting_body || '',
  };
}

export function digestEmail(sub, items) {
  const what = describeSubscription(sub.section, JSON.parse(sub.filters || '{}'));
  const n = items.length;
  const subject = `${n} ${n === 1 ? 'nueva convocatoria' : 'nuevas convocatorias'}: ${what}`.slice(0, 140);
  const lines = items.map(digestLine);
  const html = layout(`
<p>Novedades de <strong>${esc(what)}</strong>, de la que cierra antes a la que cierra después:</p>
${lines.map(l => `<div style="border-top:1px solid #e5e7eb;padding:12px 0">
<a href="${esc(utm(l.url, sub.frequency))}" style="color:#1d5c9d;font-weight:bold;text-decoration:none">${esc(l.title)}</a>
<div style="font-size:13px;color:#6b7280;margin-top:2px">${esc(l.org)}</div>
<div style="font-size:14px;margin-top:4px">${esc(l.amount)} · ${esc(l.deadline)}</div></div>`).join('\n')}
<p style="font-size:13px;color:#6b7280">Confirma siempre importes y plazos en la convocatoria oficial.</p>`,
    `Recibes este aviso porque te suscribiste en plazoabierto.es. <a href="${esc(unsubscribeUrl(sub))}">Darte de baja</a> con un clic · <a href="${esc(BASE_URL)}/privacidad">Privacidad</a>.`);
  const text = `Novedades de ${what}:

${lines.map(l => `- ${l.title}\n  ${l.amount} · ${l.deadline}\n  ${utm(l.url, sub.frequency)}`).join('\n\n')}

Confirma siempre importes y plazos en la convocatoria oficial.
Darte de baja: ${unsubscribeUrl(sub)}`;
  return { subject, html, text, headers: unsubscribeHeaders(sub) };
}
