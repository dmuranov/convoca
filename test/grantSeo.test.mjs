import test from 'node:test';
import assert from 'node:assert/strict';
import { grantGiver, grantSeoTitle, grantSeoDescription, isGrantIndexable, indexCutoff } from '../src/grantSeo.js';

test('who gives the grant, in plain Spanish', () => {
  const g = (b) => { const x = grantGiver(b); return `${x.de} ${x.name}`; };
  assert.equal(g('CARTAGENA — AYUNTAMIENTO DE CARTAGENA'), 'del Ayuntamiento de Cartagena');
  assert.equal(g('DIPUTACIÓN PROV. DE PALENCIA — DIPUTACIÓN PROVINCIAL DE PALENCIA'), 'de la Diputación Provincial de Palencia');
  assert.equal(g('CASTILLA Y LEÓN — CONSEJERÍA DE CULTURA, TURISMO Y DEPORTE'), 'de Castilla y León');
  assert.equal(g('ROZAS DE MADRID, LAS — AYUNTAMIENTO DE ROZAS DE MADRID, LAS'), 'del Ayuntamiento de Las Rozas de Madrid');
  assert.equal(g('PALMAS DE GRAN CANARIA, LAS — AYUNTAMIENTO DE LAS PALMAS DE GRAN CANARIA'), 'del Ayuntamiento de Las Palmas de Gran Canaria');
  assert.equal(g('HUESCA — DIPUTACIÓN'), 'de la Diputación de Huesca');
  assert.equal(g('UNIVERSIDAD JAUME I DE CASTELLÓN'), 'de la Universidad Jaume I de Castellón');
  assert.equal(g('MADRID — DISTRITO DE TETUÁN'), 'del Distrito de Tetuán');
  assert.equal(g('ADRI PÁRAMOS Y VALLES - ASOCIACIÓN PARA EL DESARROLLO RURAL INTEGRAL'), 'de Adri Páramos y Valles');
  assert.equal(grantGiver(''), null);
});

test('titles say it is a subsidy and who gives it, keeping the year', () => {
  const t = grantSeoTitle({ plain_title: 'Ayuda para la feria de la cebolla de Palenzuela 2026', granting_body: 'PALENZUELA — AYUNTAMIENTO DE PALENZUELA', amount_max: 60000 });
  assert.equal(t, 'Ayuda para la feria de la cebolla de Palenzuela 2026 — subvención del Ayuntamiento de Palenzuela, hasta 60.000 € | Plazo Abierto');
  assert.match(grantSeoTitle({ plain_title: 'Premio de poesía', granting_body: 'MADRID — DISTRITO DE TETUÁN', deadline_date: '2026-10-20' }),
    /^Premio de poesía 2026 — convocatoria del Distrito de Tetuán \| Plazo Abierto$/);
  assert.match(grantSeoDescription({ plain_title: 'Bono taxi', granting_body: 'BURGOS — AYUNTAMIENTO DE BURGOS', status: 'CLOSED' }),
    /^Subvención del Ayuntamiento de Burgos: Bono taxi\. Plazo cerrado\./);
});

test('index: open, or closed less than 30 days ago; never a grant with nothing to apply to', () => {
  const today = '2026-10-08';
  assert.equal(indexCutoff(today), '2026-09-08');
  assert.ok(isGrantIndexable({ status: 'OPEN' }, today));
  assert.ok(isGrantIndexable({ status: 'OPEN', deadline_date: null }, today));
  assert.ok(isGrantIndexable({ status: 'CLOSED', deadline_date: '2026-09-20' }, today));
  assert.ok(!isGrantIndexable({ status: 'CLOSED', deadline_date: '2026-07-12' }, today), 'long closed');
  assert.ok(!isGrantIndexable({ status: 'CLOSED', deadline_date: null }, today), 'direct award / closed by BDNS');
});
