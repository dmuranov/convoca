// LEADER Grupos de Acción Local by municipality (built by scripts/build-gal.js).
//
// Optional data: it only covers the comunidades we have a source for, and the chat must say
// so rather than guess. GAL boundaries follow comarcas, not provinces, so a model asked
// "which GAL is Villotilla in?" from memory will confidently name the wrong one.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUNICIPIOS, fold } from './municipios.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let GAL = null;
try {
  GAL = JSON.parse(readFileSync(path.join(__dirname, '..', 'data', 'gal.json'), 'utf-8'));
} catch { /* not built yet: the chat simply never names a GAL */ }

// Plain municipality names repeat across provinces, so resolve on name + province.
const INE_BY_NAME_PROVINCE = new Map(
  MUNICIPIOS.map(m => [`${fold(m.name)}|${fold(m.province)}`, m.ine]));

const formatGal = (g) => [g.name, g.phone && `tel. ${g.phone}`, g.email, g.web,
  g.address && `sede: ${g.address}`].filter(Boolean).join(' · ');

// `data` is injectable so tests do not depend on the built file.
export function galContext(place, data = GAL) {
  if (!data) return '';
  if (!place?.ccaa || !data.ccaa.includes(place.ccaa)) {
    return 'GAL LEADER DE LA ZONA: no tenemos ese dato para esta ubicación. No digas ni insinúes cuál es su GAL; recomiéndale que lo consulte en la web de su comunidad autónoma o en el ayuntamiento.';
  }
  const ine = place.name && INE_BY_NAME_PROVINCE.get(`${fold(place.name)}|${fold(place.province)}`);
  if (!ine) {
    return `GAL LEADER DE LA ZONA: solo conocemos la provincia (${place.province || place.ccaa}), no el municipio, y cada municipio depende de un GAL distinto. Pregúntale de qué pueblo es antes de nombrar ninguno.`;
  }
  const ids = data.municipios[ine] || [];
  if (!ids.length) {
    return `GAL LEADER DE LA ZONA: ${place.name} no está dentro de ningún Grupo de Acción Local (LEADER no se aplica en municipios urbanos). No le recomiendes LEADER.`;
  }
  return `GAL LEADER DE LA ZONA (${data.period}), el que gestiona las ayudas LEADER de ${place.name}:\n`
    + ids.map(id => `- ${formatGal(data.gals[id])}`).join('\n')
    + '\nDa este nombre y estos datos de contacto tal cual, sin añadir ni cambiar nada.';
}
