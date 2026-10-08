// Which grants belong in the Negocios section. Shared by /api/negocios and the email alerts,
// so "a business grant" means the same thing on the page and in the inbox.
//
// A grant counts when BDNS's own beneficiary types include a business (autónomos and pymes are
// "personas físicas/jurídicas que desarrollan actividad económica"), or when a LEADER group
// (GAL/GDR) grants it - those are the rural-business aid most people miss.
// beneficiarios_bdns is filled by the daily poll (and scripts/backfill-beneficiarios.js).
import { LEADER_TEXT } from './ingest/enrich.js';

export const BUSINESS_TYPE = /(?<!NO )DESARROLLAN ACTIVIDAD ECON[OÓ]MICA|PYME|GRAN EMPRESA/i;
// Not plain "desarrollo rural": regional ministries ("Consejería de Desarrollo Rural") are not GALs.
export const LEADER_BODY = /GRUPO DE ACCI[OÓ]N LOCAL|GRUPO DE DESARROLLO RURAL|ASOCIACI[OÓ]N (PARA EL |DE )?DESARROLLO|\bLEADER\b|\bGAL\b|\bGDR\b/i;

// Group names vary (ARADUEY-Campos, PROYNERSO, CEDER...), so the title counts too.
export const isLeaderGrant = (g) =>
  LEADER_BODY.test(g.granting_body || '') || LEADER_TEXT.test(g.title || '');

export function isBusinessGrant(g) {
  if (isLeaderGrant(g)) return true;
  let types = [];
  try { types = JSON.parse(g.beneficiarios_bdns || '[]'); } catch { /* keep empty */ }
  return types.some(t => BUSINESS_TYPE.test(t));
}
