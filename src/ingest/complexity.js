// The tender complexity label (baja / media / alta), decided in code from the feed's own fields.
//
// Why not the AI (2026-11-23): the label follows fixed rules - procedure, lots, duration,
// required classification - and the model applied them inconsistently: a 20-tender test gave a
// different label for 5 of them on identical facts, and live labels broke the rules (a 2-year
// contract labelled "media"). Only "is business classification required" needs the pliegos, so
// the AI answers just that yes/no (clasificacion_exigida) and this function does the rest.
//
//   alta:  business classification required, 2+ lots, a procedure with selection or
//          negotiation (restricted, negotiated, competitive dialogue, design contest),
//          or longer than 12 months (extensions not counted);
//   baja:  open simplified procedure, at most 12 months, none of the above;
//   media: everything else (open ordinary procedure, internal rules, framework-derived...).

const HARD_PROCEDURE = /restringido|negociad|negociaci[óo]n|di[áa]logo competitivo|concurso de proyectos|asociaci[óo]n para la innovaci[óo]n/i;

// "2 años", "18 meses", "90 días", "6 semanas" -> months; null when absent or unreadable.
export function durationMonths(duracion) {
  const m = String(duracion || '').match(/(\d+(?:[.,]\d+)?)\s*(a[ñn]o|mes|d[íi]a|semana)/i);
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  const unit = m[2].toLowerCase();
  if (unit.startsWith('a')) return n * 12;
  if (unit.startsWith('m')) return n;
  if (unit.startsWith('s')) return n / 4.345;
  return n / 30.44;
}

const durationText = (duracion) => String(duracion || '').replace(/\b1 años\b/, '1 año').replace(/\b1 meses\b/, '1 mes');

export function complejidadFor({ procedimiento, numLotes, duracion, clasificacionExigida }) {
  const months = durationMonths(duracion);
  const lots = Number(numLotes) || 0;
  const proc = String(procedimiento || '');
  const reasons = [];
  if (clasificacionExigida) reasons.push('exige clasificación empresarial');
  if (lots >= 2) reasons.push(`está dividida en ${lots} lotes`);
  if (HARD_PROCEDURE.test(proc)) reasons.push(`el procedimiento es ${proc.toLowerCase()}`);
  if (months != null && months > 12) reasons.push(`dura ${durationText(duracion)}`);
  if (reasons.length) {
    return { complejidad: 'alta', motivo: `Alta porque ${joinEs(reasons)}.` };
  }
  const plazo = months == null ? 'sin duración indicada' : `de ${durationText(duracion)}`;
  if (/simplificado/i.test(proc)) {
    return { complejidad: 'baja', motivo: `Procedimiento abierto simplificado ${plazo}, sin lotes ni clasificación empresarial.` };
  }
  return {
    complejidad: 'media',
    motivo: `Procedimiento ${proc ? proc.toLowerCase() : 'sin especificar'} ${plazo}, sin lotes ni clasificación empresarial.`,
  };
}

const joinEs = (xs) => xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} y ${xs[xs.length - 1]}`;
