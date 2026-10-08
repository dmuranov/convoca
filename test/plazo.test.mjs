import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlazoTerm } from '../src/ingest/enrich.js';

test('parses digit días hábiles', () => {
  assert.deepEqual(
    { count: 15, unit: 'habiles' },
    (({ count, unit }) => ({ count, unit }))(parsePlazoTerm('15 días hábiles desde la publicación del extracto')));
});

test('parses spelled-out quince días naturales', () => {
  const t = parsePlazoTerm('El plazo será de quince días naturales contados a partir del día siguiente');
  assert.equal(t.count, 15);
  assert.equal(t.unit, 'naturales');
});

test('días without qualifier defaults to naturales (Ley 39/2015 art. 30.2 says hábiles unless stated — but BDNS textFin overwhelmingly means naturales when unqualified; operator confirms anyway)', () => {
  const t = parsePlazoTerm('20 dias desde la publicacion');
  assert.equal(t.count, 20);
  assert.equal(t.unit, 'naturales');
});

test('parses un mes', () => {
  const t = parsePlazoTerm('el plazo de presentación será de un mes');
  assert.equal(t.count, 1);
  assert.equal(t.unit, 'meses');
});

test('returns null on prose without a term', () => {
  assert.equal(parsePlazoTerm('hasta agotamiento del crédito presupuestario'), null);
  assert.equal(parsePlazoTerm(null), null);
});

import { parseEndDate } from '../src/ingest/enrich.js';

test('end date written in textFin', () => {
  assert.equal(parseEndDate('Hasta el 31 de diciembre de 2027'), '2027-12-31');
  assert.equal(parseEndDate('HASTA EL DÍA 31/12/2027'), '2027-12-31');
  assert.equal(parseEndDate('07/05/2026'), '2026-05-07');
  assert.equal(parseEndDate('Desde el 16 de septiembre de 2024 | Hasta el 31 de diciembre de 2027'), '2027-12-31');
  assert.equal(parseEndDate('Cuando se agoten los bonos emitidos y, como máximo, el día 25 de noviembre de 2026'), '2026-11-25');
});

test('a date that a relative period counts from is not the end', () => {
  assert.equal(parseEndDate('Diez días hábiles desde la publicación del Real Decreto 565/2026, de 8 de julio de 2026'), null);
  assert.equal(parseEndDate('Un mes a partir del día siguiente a la publicación (BOC de 1 de agosto de 2024)'), null);
  assert.equal(parseEndDate('Un mes'), null);
  assert.equal(parseEndDate('Hasta agotar el crédito'), null);
});

import { deadlineFor } from '../src/ingest/enrich.js';

test('wordings BDNS uses for relative periods', () => {
  const p = (s) => { const r = parsePlazoTerm(s); return r && `${r.count} ${r.unit}`; };
  assert.equal(p('16º día hábil posterior a la publicación en BOP'), '16 habiles');
  assert.equal(p('20 DIES NATURALS DES DE LA PUBLICACIÓ AL BOPB'), '20 naturales');
  assert.equal(p('vint dies hàbils desde el dia seguent'), '20 habiles');
  assert.equal(p('15 hábiles contados desde el día siguiente'), '15 habiles');
  assert.equal(p('Veinte (20) días naturales'), '20 naturales');
  assert.equal(p('Dez días hábiles a partir do día seguinte'), '10 habiles');
  assert.equal(p('Décimo quinto día hábil siguiente al de publicación'), '15 habiles');
  assert.equal(p('Ultimo día del mes a contar desde la publicación'), '1 meses');
  assert.equal(p('10'), '10 habiles');
  assert.equal(p('Según bases reguladoras'), null);
});

test('more written end dates', () => {
  assert.equal(parseEndDate('16 OCTUBRE 2026'), '2026-10-16');
  assert.equal(parseEndDate('23 de juny de 2026'), '2026-06-23');
  assert.equal(parseEndDate('10/19/2026'), '2026-10-19');
  assert.equal(parseEndDate('FINS EL 9 D`OCTUBRE DE 2026, AMBDÓS INCLOSOS'), '2026-10-09');
  assert.equal(parseEndDate('Antes del 7 de octubre a las 23:59', '2026-08-24'), '2026-10-07');
  assert.equal(parseEndDate('hasta el 30/09 , o 10/10 si el nacimiento es en la 2ª quincena', '2026-05-13'), '2026-10-10');
});

test('direct awards are never open; a known end date beats the abierto flag', () => {
  const today = '2026-10-08';
  assert.equal(deadlineFor({ tipoConvocatoria: 'Concesión directa - instrumental', abierto: true, textFin: '' }, { today }).status, 'CLOSED');
  assert.equal(deadlineFor({ tipoConvocatoria: 'Concurrencia competitiva - canónica', abierto: true, textFin: 'Hasta el 31 de diciembre de 2024' }, { today }).status, 'CLOSED');
  assert.equal(deadlineFor({ tipoConvocatoria: 'Concurrencia competitiva - canónica', abierto: true, textFin: '' }, { today }).status, 'OPEN');
  const fromBases = deadlineFor({ tipoConvocatoria: 'Concurrencia competitiva - canónica', abierto: false, textFin: 'Ver artículo 8', fechaRecepcion: '2026-09-01' },
    { today, basesText: 'Artículo 8. El plazo de presentación de solicitudes será de quince días hábiles desde la publicación del extracto.' });
  assert.equal(fromBases.source, 'computed');
  assert.ok(fromBases.deadline > '2026-09-01');
});

test('an estimated deadline gets a grace week before it closes a call', () => {
  const d = { tipoConvocatoria: 'Concurrencia competitiva - canónica', abierto: false, textFin: '10 días naturales', fechaRecepcion: '2026-09-20' };
  const r = deadlineFor(d, { today: '2026-10-05' });            // estimate 2026-09-30, +7 = 10-07
  assert.equal(r.source, 'computed');
  assert.equal(r.status, 'OPEN');
  assert.equal(deadlineFor(d, { today: '2026-10-08' }).status, 'CLOSED');
});
