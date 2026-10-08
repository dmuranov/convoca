import test from 'node:test';
import assert from 'node:assert/strict';
import { screen } from '../src/ingest/poll.js';

const TODAY = '2026-10-08';
const direct = (descripcion, nivel2 = '', extra = {}) => ({
  tipoConvocatoria: 'Concesión directa - canónica', descripcion, organo: { nivel2 }, fechaFinSolicitud: '2027-12-31', ...extra,
});

test('LEADER calls for projects registered as direct awards are kept', () => {
  assert.equal(screen(direct('CONVOCATORIA DE SUBVENCIONES PARA LA FINANCIACIÓN DE PROYECTOS NO PRODUCTIVOS EN EL MARCO DE LA EDL LEADER',
    'MACOVALL - ASOCIACIÓN PARA EL DESARROLLO INTEGRAL'), TODAY), null);
  assert.equal(screen(direct('conv y bases regul de ayudas la Estrategia de Desarrollo Local Participativo', 'CIUDAD AUTÓNOMA DE CEUTA'), TODAY), null);
});

test('named transfers to LEADER groups are still skipped', () => {
  for (const d of ['SUBVENCION NOMINATIVA GRUPO DE ACCION LOCAL LIEBANA',
    'Convenio entre el Ayuntamiento de Altea y el Grupo de Acción Local',
    'AYUDAS PÚBLICAS PARA EXPEDIENTES DE LA MEDIDA 7119.4 LEADER DE PEPAC',
    'Convocatòria de subvenció. Cofinançament LIFE. LEADER'])
    assert.match(screen(direct(d), TODAY), /no competitiva/, d);
});

test('a direct award with no LEADER context is still skipped', () => {
  assert.match(screen(direct('Convocatoria de subvenciones a clubes deportivos', 'AYUNTAMIENTO DE X'), TODAY), /no competitiva/);
});

test('a closed LEADER call is skipped for its deadline', () => {
  assert.match(screen(direct('Convocatoria LEADER de ayudas a proyectos', '', { fechaFinSolicitud: '2026-01-31' }), TODAY), /plazo cerrado/);
});

test('a call BDNS describes as closed in words is skipped', () => {
  const d = { tipoConvocatoria: 'Concurrencia competitiva - canónica', abierto: false, textFin: 'Periodo de de entrega de solicitudes cerrado el dia .' };
  assert.match(screen(d, TODAY), /plazo cerrado/);
  assert.equal(screen({ ...d, abierto: true, textFin: '' }, TODAY), null);
});
