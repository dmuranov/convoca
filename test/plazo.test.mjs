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
