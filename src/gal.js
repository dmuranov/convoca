// LEADER Grupos de Acción Local by municipality (built by scripts/build-gal-spain.js).
//
// Two kinds of entry, and the chat must tell them apart:
//   - official: a comunidad's own 2023-2027 list (today Castilla y León). It enumerates
//     every municipality, so a municipality with no group really is outside LEADER.
//   - national (official: false): Red PAC's national layer, last updated 2018 (programme
//     2014-2020). Most groups carried on, but names, boundaries or contacts may have
//     changed, and some groups' municipality lists in that source are incomplete — so a
//     municipality missing from it is UNKNOWN, never "outside LEADER".
// GAL boundaries follow comarcas, not provinces, so a model asked "which GAL is
// Villotilla in?" from memory will confidently name the wrong one: it only ever repeats this.
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

// INE codes of the 52 provincial capitals (incl. Ceuta, Melilla): never in a LEADER area,
// so an unlisted capital is answered plainly instead of with a province's rural groups.
const PROVINCIAL_CAPITALS = new Set([
  '01059', '02003', '03014', '04013', '05019', '06015', '07040', '08019', '09059', '10037',
  '11012', '12040', '13034', '14021', '15030', '16078', '17079', '18087', '19130', '20069',
  '21041', '22125', '23050', '24089', '25120', '26089', '27028', '28079', '29067', '30030',
  '31201', '32054', '33044', '34120', '35016', '36038', '37274', '38038', '39075', '40194',
  '41091', '42173', '43148', '44216', '45168', '46250', '47186', '48020', '49275', '50297',
  '51001', '52001',
]);

const OLD_LIST_NOTE = 'Ojo: este dato viene del listado nacional de Grupos de Acción Local del periodo 2014-2020 (Red PAC, actualizado en 2018). Dilo así y recomiéndale confirmar con el propio grupo o con la web de su comunidad autónoma, porque el nombre o el contacto pueden haber cambiado en el periodo 2023-2027.';

// Structured answer for one place, shared by the chat (galContext) and the public GAL
// finder (/api/gal). kind:
//   no_data    – a comunidad we have no source for
//   need_town  – only the province is known
//   capital    – an unlisted provincial capital (never LEADER)
//   candidates – village not in our lists: groups based in its province, as candidates
//   unknown    – not listed and no candidates
//   no_gal     – an official list says it is in no group
//   found      – its group(s); official=false means the 2014-2020 national list
// `data` is injectable so tests do not depend on the built file.
export function galLookup(place, data = GAL) {
  if (!data) return { kind: 'no_data' };
  if (!place?.ccaa || !data.ccaa.includes(place.ccaa)) return { kind: 'no_data' };
  const ine = place.name && INE_BY_NAME_PROVINCE.get(`${fold(place.name)}|${fold(place.province)}`);
  if (!ine) return { kind: 'need_town' };
  const ids = data.municipios[ine];
  if (ids === undefined && PROVINCIAL_CAPITALS.has(ine)) return { kind: 'capital' };
  if (ids === undefined) {
    const gals = Object.values(data.gals)
      .filter(g => g.official === false && g.ccaa === place.ccaa && place.province && fold(g.province || '') === fold(place.province))
      .slice(0, 6);
    return gals.length ? { kind: 'candidates', gals, official: false } : { kind: 'unknown' };
  }
  if (!ids.length) return { kind: 'no_gal' };
  const gals = ids.map(id => data.gals[id]).filter(Boolean);
  const official = gals.every(g => g.official !== false);
  return { kind: 'found', gals, official, period: official ? (gals[0]?.period || data.period || '2023-2027') : '2014-2020' };
}

export function galContext(place, data = GAL) {
  if (!data) return '';
  const r = galLookup(place, data);
  const list = (gals) => gals.map(g => `- ${formatGal(g)}`).join('\n');
  switch (r.kind) {
    case 'no_data':
      return 'GAL LEADER DE LA ZONA: no tenemos ese dato para esta ubicación. No digas ni insinúes cuál es su GAL; recomiéndale que lo consulte en la web de su comunidad autónoma o en el ayuntamiento.';
    case 'need_town':
      return `GAL LEADER DE LA ZONA: solo conocemos la provincia (${place.province || place.ccaa}), no el municipio, y cada municipio depende de un GAL distinto. Pregúntale de qué pueblo es antes de nombrar ninguno.`;
    case 'capital':
      return `GAL LEADER DE LA ZONA: ${place.name} es capital de provincia y no está en ninguna zona LEADER (esas ayudas son para el medio rural). No le recomiendes LEADER ni nombres ningún GAL.`;
    case 'unknown':
      return `GAL LEADER DE LA ZONA: no sabemos qué Grupo de Acción Local cubre ${place.name}. No nombres ninguno; recomiéndale preguntar en su ayuntamiento o en la web de su comunidad autónoma.`;
    case 'candidates':
      return `GAL LEADER DE LA ZONA: no sabemos con seguridad qué grupo cubre ${place.name}. Estos son los Grupos de Acción Local con sede en la provincia de ${place.province}; dile que pregunte a cualquiera de ellos cuál le corresponde, sin afirmar que sea uno concreto:\n${list(r.gals)}\n${OLD_LIST_NOTE}`;
    case 'no_gal':
      return `GAL LEADER DE LA ZONA: ${place.name} no está dentro de ningún Grupo de Acción Local (LEADER no se aplica en municipios urbanos). No le recomiendes LEADER.`;
    default:
      return `GAL LEADER DE LA ZONA (${r.period}), el que gestiona las ayudas LEADER de ${place.name}:\n${list(r.gals)}\nDa este nombre y estos datos de contacto tal cual, sin añadir ni cambiar nada.`
        + (r.official ? '' : `\n${OLD_LIST_NOTE}`);
  }
}
