import test from 'node:test';
import assert from 'node:assert/strict';
import { organFromTender, orgKey, organismIntro, subjectOf } from '../src/organismos.js';
import { organismName, grantGiver } from '../src/grantSeo.js';

test('a tender organ names the body the grants come from, so both land on one page', () => {
  assert.equal(organFromTender('Junta de Gobierno del Ayuntamiento de Marbella'), 'Ayuntamiento de Marbella');
  assert.equal(organFromTender('Concejalía Delegada de Hacienda del Ayuntamiento de Gijón'), 'Ayuntamiento de Gijón');
  assert.equal(organFromTender('Alcaldía del Ayuntamiento de la Pobla de Vallbona'), 'Ayuntamiento de la Pobla de Vallbona');
  assert.equal(organFromTender('Presidencia de la Diputación Provincial de Palencia'), 'Diputación Provincial de Palencia');
  assert.equal(organFromTender('ADIF - Presidencia'), null);
  assert.equal(organFromTender(null), null);

  const key = (body) => orgKey(grantGiver(body).name);
  assert.equal(key('GIJÓN — AYUNTAMIENTO DE GIJÓN'), orgKey(organFromTender('Alcaldía del Ayuntamiento de Gijón')));
  assert.equal(key('POBLA DE VALLBONA, LA — AYUNTAMIENTO DE POBLA DE VALLBONA, LA'),
    orgKey(organFromTender('Alcaldía del Ayuntamiento de la Pobla de Vallbona')));
  assert.equal(key('HUESCA — DIPUTACIÓN'), orgKey(organFromTender('Presidencia de la Diputación Provincial de Huesca')));
  assert.equal(key('DIPUTACIÓN PROV. DE PALENCIA — DIPUTACIÓN PROVINCIAL DE PALENCIA'), 'diputacion-de-palencia');
});

test('a regional department keeps its own name instead of becoming the comunidad', () => {
  const o = organismName('ANDALUCÍA — CONSEJERÍA DE CULTURA Y DEPORTE');
  assert.equal(o.name, 'Consejería de Cultura y Deporte');
  assert.equal(o.place, 'Andalucía');
  assert.equal(o.de, 'de la');
  assert.equal(organismName('GIJÓN — AYUNTAMIENTO DE GIJÓN').name, 'Ayuntamiento de Gijón');
  assert.equal(organismName('ESTADO — MINISTERIO DE CULTURA').de, 'del');
});

test('organism intro: counts from its own calls, right article, nothing invented', () => {
  const o = { name: 'Ayuntamiento de Palencia', de: 'del' };
  assert.equal(subjectOf(o), 'El Ayuntamiento de Palencia');
  const g = (open_date, category, budget_total) => ({ open_date, category, budget_total });
  const text = organismIntro(o, {
    openGrants: [g('2026-11-20', 'cultura', 1250), g('2026-11-20', 'comercio', 1850)],
    pastGrants: [g('2026-10-01', 'cultura'), g('2026-09-29', 'empleo'), g('2026-08-24', 'comercio')],
    openTenders: [{ valor_estimado: 100000, tipo_contrato: 'Servicios' }],
    pastTenders: [{}, {}],
  });
  assert.match(text, /^El Ayuntamiento de Palencia tiene ahora 2 convocatorias de subvenciones abiertas y 1 licitación en plazo\./);
  assert.match(text, /Desde agosto de 2026 hemos recogido 5 convocatorias suyas/);
  assert.match(text, /sobre todo de comercio \(2\), cultura \(2\) y empleo \(1\)/);
  assert.match(text, /reparten en total 3100 €/);             // es-ES does not group 4 digits
  assert.match(text, /Las ha publicado sobre todo en noviembre \(2\)\./);
  assert.match(text, /Su licitación abierta tiene 100\.000 € de valor estimado, de servicios\./);
  assert.match(text, /2 licitaciones más que ya han cerrado/);
  assert.doesNotMatch(text, /undefined|null|NaN/);

  const quiet = organismIntro({ name: 'Diputación de Huesca', de: 'de la' }, { openGrants: [], pastGrants: [g('2026-09-01', 'social')], openTenders: [], pastTenders: [] });
  assert.match(quiet, /^La Diputación de Huesca no tiene ahora ninguna convocatoria abierta\./);
  assert.match(quiet, /publica la BDNS\.$/);
});
