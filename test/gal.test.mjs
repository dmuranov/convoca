import test from 'node:test';
import assert from 'node:assert/strict';
import { galContext } from '../src/gal.js';

const data = {
  period: '2023-2027',
  ccaa: ['Castilla y León'],
  gals: {
    'adri@paramosyvalles.com': { id: 'adri@paramosyvalles.com', name: 'ADRI PÁRAMOS Y VALLES', phone: '979890532',
      email: 'adri@paramosyvalles.com', web: 'http://www.paramosyvalles.com', address: 'SALDAÑA' },
  },
  // 34236 = Villaturde, 34120 = Palencia (capital, in no GAL)
  municipios: { 34236: ['adri@paramosyvalles.com'], 34120: [] },
};

test('a pedanía resolves through its parent municipality to that comarca\'s GAL', () => {
  // Villotilla arrives from the place search as name = parent municipality.
  const ctx = galContext({ ccaa: 'Castilla y León', province: 'Palencia', name: 'Villaturde' }, data);
  assert.match(ctx, /ADRI PÁRAMOS Y VALLES/);
  assert.match(ctx, /979890532/);
  assert.match(ctx, /paramosyvalles\.com/);
});

test('a municipality inside no GAL is told LEADER does not apply, never given a neighbour', () => {
  const ctx = galContext({ ccaa: 'Castilla y León', province: 'Palencia', name: 'Palencia' }, data);
  assert.match(ctx, /no está dentro de ningún/);
  assert.doesNotMatch(ctx, /ADRI/);
});

test('a comunidad we have no source for must not get a GAL guess', () => {
  const ctx = galContext({ ccaa: 'Andalucía', province: 'Huelva', name: 'Almonte' }, data);
  assert.match(ctx, /no tenemos ese dato/);
  assert.doesNotMatch(ctx, /ADRI/);
});

test('province-only visitors are asked for their village, not handed a province-wide guess', () => {
  const ctx = galContext({ ccaa: 'Castilla y León', province: 'Palencia', name: null }, data);
  assert.match(ctx, /Pregúntale de qué pueblo/);
  assert.doesNotMatch(ctx, /ADRI/);
});

test('an unlocated visitor gets the no-data answer rather than nothing', () => {
  assert.match(galContext(null, data), /no tenemos ese dato/);
});

test('no GAL file built yet: the chat gets no GAL block at all', () => {
  assert.equal(galContext({ ccaa: 'Castilla y León', province: 'Palencia', name: 'Villaturde' }, null), '');
});
