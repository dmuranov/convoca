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
