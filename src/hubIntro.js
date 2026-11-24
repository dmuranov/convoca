// The paragraph that opens a hub page, written from the grants on it: who is calling them,
// how much money is published, how many close soon, which subjects lead. 120-180 words.
//
// Why: hubs went from the heading straight to the cards, so a comunidad's page had no text of
// its own and Google read the hubs as copies of each other. Every figure here comes from that
// hub's own list, so no two hubs carry the same paragraph.
import { daysLeft } from './seoUtils.js';
import { grantGiver, realAmount } from './grantSeo.js';

const eur = (n) => `${Math.round(n).toLocaleString('es-ES')} €`;
const list = (items) => items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} y ${items.at(-1)}`;
export const wordCount = (s) => s.split(/\s+/).filter(Boolean).length;

// The regional government and the local bodies that call grants in each comunidad.
export const CCAA_BODIES = {
  'Andalucía': ['la Junta de Andalucía', 'las ocho diputaciones provinciales y los ayuntamientos'],
  'Aragón': ['el Gobierno de Aragón', 'las diputaciones de Huesca, Teruel y Zaragoza, las comarcas y los ayuntamientos'],
  'Asturias': ['el Gobierno del Principado de Asturias', 'los ayuntamientos asturianos'],
  'Illes Balears': ['el Govern de les Illes Balears', 'los consells insulares y los ayuntamientos'],
  'Canarias': ['el Gobierno de Canarias', 'los cabildos insulares y los ayuntamientos'],
  'Cantabria': ['el Gobierno de Cantabria', 'los ayuntamientos cántabros'],
  'Castilla y León': ['la Junta de Castilla y León', 'las nueve diputaciones provinciales y los ayuntamientos'],
  'Castilla-La Mancha': ['la Junta de Comunidades de Castilla-La Mancha', 'las cinco diputaciones provinciales y los ayuntamientos'],
  'Cataluña': ['la Generalitat de Catalunya (Gencat)', 'las diputaciones de Barcelona, Girona, Lleida y Tarragona, los consells comarcals y los ayuntamientos'],
  'Comunitat Valenciana': ['la Generalitat Valenciana', 'las diputaciones de Alicante, Castellón y Valencia y los ayuntamientos'],
  'Extremadura': ['la Junta de Extremadura', 'las diputaciones de Badajoz y Cáceres y los ayuntamientos'],
  'Galicia': ['la Xunta de Galicia', 'las cuatro diputaciones provinciales y los concellos'],
  'Comunidad de Madrid': ['el Gobierno de la Comunidad de Madrid', 'los ayuntamientos madrileños'],
  'Región de Murcia': ['el Gobierno de la Región de Murcia', 'los ayuntamientos murcianos'],
  'Navarra': ['el Gobierno de Navarra', 'los ayuntamientos navarros'],
  'País Vasco': ['el Gobierno Vasco', 'las diputaciones forales de Álava, Bizkaia y Gipuzkoa y los ayuntamientos'],
  'La Rioja': ['el Gobierno de La Rioja', 'los ayuntamientos riojanos'],
  'Ceuta': ['la Ciudad Autónoma de Ceuta', null],
  'Melilla': ['la Ciudad Autónoma de Melilla', null],
};

const top = (values, n = 3) => {
  const count = new Map();
  for (const v of values) if (v) count.set(v, (count.get(v) || 0) + 1);
  return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es')).slice(0, n);
};

// kind: 'ccaa' | 'province' | 'category' | 'estatales' | 'beneficiario'
// `total` is everything listed on the page (own + the wider tiers below); the title counts it,
// so the text says it too - a page titled "19" opening with "hay 15" reads as an error.
export function hubIntro({ kind, grants, total, ccaaName, provinceName, categoryName, beneficiarioLabel, alerts = false }) {
  const n = grants.length;
  const N = `${n} convocatoria${n === 1 ? '' : 's'} de subvenciones`;
  const place = provinceName ? `la provincia de ${provinceName}` : ccaaName;
  const [gov, locals] = CCAA_BODIES[ccaaName] || [];

  const lead = {
    ccaa: `En ${ccaaName} hay ahora mismo ${N} con el plazo abierto. Las convocan organismos de la propia comunidad: ${gov || 'el gobierno autonómico'}${locals ? `, ${locals}` : ''}.`,
    province: `En la provincia de ${provinceName} hay ahora mismo ${N} con el plazo abierto, convocadas para este territorio por sus ayuntamientos y entidades comarcales y, donde existe, por la diputación, el cabildo o el consell.`,
    category: `Hay ahora mismo ${N} de ${String(categoryName).toLowerCase()} con el plazo abierto en toda España, convocadas por ministerios, comunidades autónomas, diputaciones y ayuntamientos.`,
    estatales: `Hay ahora mismo ${N} de ámbito estatal con el plazo abierto. Las convocan los ministerios y sus organismos, o se pueden pedir desde varias comunidades a la vez, así que el lugar donde vives no te deja fuera.`,
    beneficiario: `Hay ahora mismo ${N} con el plazo abierto que pueden pedir ${String(beneficiarioLabel).toLowerCase()}${ccaaName ? ` en ${ccaaName}` : ''}, según las bases de cada una.`,
  }[kind];

  // grantGiver names a regional department after its comunidad ("Cataluña"): here, its government.
  const govName = (name) => CCAA_BODIES[name] ? CCAA_BODIES[name][0].replace(/^(la|el) /, '').replace(/ \(.*\)$/, '') : name;
  const bodies = top(grants.map(g => { const name = grantGiver(g.granting_body)?.name; return name && govName(name); }));
  const who = bodies.length > 1
    ? `Los organismos con más ayudas abiertas hoy son ${list(bodies.map(([name, c]) => `${name} (${c})`))}.`
    : bodies.length ? `Hoy todas las convoca un mismo organismo: ${bodies[0][0]}.` : '';

  const budgets = grants.map(g => realAmount(g.budget_total)).filter(Boolean);
  const money = budgets.length
    ? `${budgets.length === 1 ? 'La única que publica' : `Las ${budgets.length} que publican`} su presupuesto ${budgets.length === 1 ? 'reparte' : 'suman'} ${eur(budgets.reduce((a, b) => a + b, 0))}; en el resto, la cuantía depende de las bases.`
    : 'Ninguna publica un presupuesto total: la cuantía de cada ayuda está en su ficha.';

  const soon = grants.filter(g => { const d = daysLeft(g.deadline_date); return d != null && d >= 0 && d <= 15; }).length;
  const dates = soon
    ? `${soon === 1 ? 'Una de ellas cierra' : `De ellas, ${soon} cierran`} en los próximos quince días, así que conviene mirar primero las fechas.`
    : 'Ninguna cierra en los próximos quince días, pero los plazos no se amplían: apunta la fecha.';

  const groups = kind === 'category' ? top(grants.map(g => g.region)) : top(grants.map(g => g.category && String(g.category).toLowerCase()));
  const breakdown = groups.length > 1
    ? kind === 'category'
      ? `Por territorio, las más numerosas son las de ${list(groups.map(([name, c]) => `${name} (${c})`))}.`
      : `Por temas, las más numerosas son las de ${list(groups.map(([name, c]) => `${name} (${c})`))}.`
    : '';

  const scope = {
    ccaa: `Primero van las de organismos de ${ccaaName}; debajo, las estatales, que puedes pedir igualmente desde aquí.`,
    province: `Primero van las propias de la provincia; debajo, las de toda ${ccaaName} y las estatales, que puedes pedir igualmente desde aquí.`,
    category: 'Cada tarjeta dice qué organismo la convoca, porque casi todas son solo para vecinos o entidades de su territorio.',
    estatales: 'Las ayudas autonómicas, provinciales y municipales no están aquí: búscalas en la página de tu comunidad.',
    beneficiario: 'Cada tarjeta dice qué organismo la convoca, porque casi todas son solo para su territorio.',
  }[kind];

  const fichas = 'Cada ficha explica en castellano llano para qué es la ayuda, quién puede pedirla y cómo se solicita, con el enlace a la convocatoria oficial.';
  const narrow = kind === 'ccaa' ? 'por provincia o por tema' : kind === 'category' ? 'por comunidad' : 'por tema o por territorio';
  const how = alerts
    ? `Acota la lista con los enlaces ${narrow}, o deja tu correo al final de la página y te avisamos cuando salga una convocatoria nueva${place ? ` en ${place}` : ''}.`
    : `Acota la lista con los enlaces ${narrow} y vuelve cuando quieras: la lista se actualiza cada mañana con las novedades de la BDNS.`;

  // Keep within 120-180 words: the breakdown is the first to go, the reminder the first to come.
  const sum = total > n
    ? `Con ${total - n === 1 ? 'la que' : `las ${total - n} que`} también se ${total - n === 1 ? 'puede' : 'pueden'} pedir desde aquí, son ${total} en total.`
    : '';
  let parts = [lead, sum, who, money, dates, breakdown, scope, fichas, how].filter(Boolean);
  if (wordCount(parts.join(' ')) > 180) parts = parts.filter(p => p !== breakdown);
  if (wordCount(parts.join(' ')) > 180) parts = parts.filter(p => p !== who);
  if (wordCount(parts.join(' ')) < 120) {
    parts.splice(parts.length - 2, 0, 'Antes de solicitar nada, comprueba en las bases que cumples los requisitos y reúne los papeles con tiempo: una solicitud incompleta o presentada fuera de plazo se queda sin ayuda.');
  }
  return parts.join(' ');
}
