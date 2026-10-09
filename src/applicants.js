// Who can apply for a grant: the categories the AI extraction chooses from (grant_eligibility.
// entity_types) and how they read on the site.
//
// The first six were built for the original audience - village bodies - and are also the
// /ayudas/<tipo>/ hub pages (BENEFICIARIO_TYPES in src/seoUtils.js). They had no way to say
// "businesses" or "private individuals", so a LEADER grant for pymes was labelled
// "Asociaciones". The rest cover people and businesses; they are labels only (no hub pages).
import { BENEFICIARIO_TYPES } from './seoUtils.js';

export const APPLICANT_LABELS = {
  ...BENEFICIARIO_TYPES,
  Particular: 'Particulares',
  Familia: 'Familias',
  Estudiante: 'Estudiantes',
  Joven: 'Jóvenes',
  Persona_Mayor: 'Personas mayores',
  Persona_Discapacidad: 'Personas con discapacidad',
  Desempleado: 'Personas desempleadas',
  Autonomo: 'Autónomos',
  Pyme: 'Pymes',
  Gran_Empresa: 'Grandes empresas',
  Agricultor: 'Agricultores y ganaderos',
  Cooperativa: 'Cooperativas',
  Entidad_Sin_Animo_Lucro: 'Fundaciones y entidades sin ánimo de lucro',
  Investigador: 'Investigadores',
  Universidad: 'Universidades y centros de investigación',
  Centro_Educativo: 'Colegios e institutos',
};
export const APPLICANT_TYPES = Object.keys(APPLICANT_LABELS);

export const APPLICANT_DESCRIPTION = 'Quién puede pedirla, lo más concreto posible: '
  + 'Particular (cualquier persona), Familia, Estudiante, Joven, Persona_Mayor, Persona_Discapacidad, Desempleado, '
  + 'Autonomo, Pyme, Gran_Empresa, Agricultor (explotaciones agrarias y ganaderas), Cooperativa, '
  + 'Asociacion (asociaciones vecinales, culturales...), Club_Deportivo, AMPA, Entidad_Sin_Animo_Lucro (fundaciones, ONG, federaciones), '
  + 'Ayuntamiento, Junta_Vecinal, Investigador, Universidad, Centro_Educativo; Otro solo si no encaja ninguna. '
  + 'Solo los que las bases admiten de verdad.';
