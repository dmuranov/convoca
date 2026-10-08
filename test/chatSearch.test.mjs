// The assistant's search: place read from the question, topic matching, business questions.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `convoca-chatsearch-test-${process.pid}.sqlite`);
process.env.DB_PATH = DB;
const { db } = await import('../src/db.js');
process.on('exit', () => { try { db.close(); } catch {} for (const f of [DB, DB + '-wal', DB + '-shm']) fs.rmSync(f, { force: true }); });
const { placeFromText, searchGrants, isBusinessQuestion } = await import('../src/chatSearch.js');

let n = 0;
function grant({ title, region, province = null, municipality = null, summary = '', ben = '[]' }) {
  n++;
  db.prepare(`INSERT INTO grant_row (id, bdns_ref, title, plain_title, region, province, municipality, ai_summary, status, published, beneficiarios_bdns)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', 1, ?)`).run(`g${n}`, String(700000 + n), title, title, region, province, municipality, summary, ben);
}
const BIZ = '["PYME Y PERSONAS FÍSICAS QUE DESARROLLAN ACTIVIDAD ECONÓMICA"]';
grant({ title: 'Ayudas para pymes que asistan a ferias', region: 'Castilla y León', province: 'Segovia', ben: BIZ });
grant({ title: 'Ayudas para el carné de conducir de jóvenes', region: 'Comunitat Valenciana', province: 'Valencia/València' });
grant({ title: 'Ayudas para comprar ordenadores a estudiantes', region: 'Galicia' });
grant({ title: 'Becas para estudiantes de máster', region: 'Galicia' });
grant({ title: 'Ayudas para barcos pesqueros', region: 'Galicia' });
grant({ title: 'Bono taxi para personas mayores', region: 'Castilla y León', province: 'Burgos', municipality: 'Burgos' });
grant({ title: 'Ayudas para negocios turísticos', region: 'Castilla y León', ben: BIZ });

test('the place is read from the question', () => {
  assert.equal(placeFromText('ayudas en la Comunidad Valenciana').ccaa, 'Comunitat Valenciana');
  assert.equal(placeFromText('Tengo una empresa en Huelva').province, 'Huelva');
  assert.equal(placeFromText('vivo en Medina de Pomar').name, 'Medina de Pomar');
  assert.equal(placeFromText('bono taxi burgos').name, 'Burgos', 'a province capital includes its own council');
  assert.equal(placeFromText('¿hay ayudas para audífonos?'), null);
});

test('business questions are recognised', () => {
  assert.ok(isBusinessQuestion('ayudas para pymes en Segovia'));
  assert.ok(isBusinessQuestion('quiero abrir un bar'));
  assert.ok(!isBusinessQuestion('becas para estudiantes'));
});

test('search: territory and topic, exact counts', () => {
  const pymes = searchGrants('ayudas para pymes en Segovia', { place: placeFromText('ayudas para pymes en Segovia') });
  assert.equal(pymes.total, 2, 'Segovia + Castilla y León business grants');
  const carnet = searchGrants('ayudas carnet de conducir Comunidad Valenciana', { place: placeFromText('Comunidad Valenciana') });
  assert.equal(carnet.total, 1);
  const pc = searchGrants('ayudas para comprar ordenador estudiantes');
  assert.deepEqual(pc.grants.map(g => g.plain_title), ['Ayudas para comprar ordenadores a estudiantes'], 'both words beat one');
  const taxi = searchGrants('bono taxi burgos', { place: placeFromText('bono taxi burgos') });
  assert.equal(taxi.total, 1);
});

test('a short word only matches at the start of a word', () => {
  const bar = searchGrants('ayudas para un bar', { section: null });
  assert.ok(!bar.grants.some(g => /barcos/.test(g.plain_title)));
});

test('a business question with no specific match falls back to the area\'s business grants', () => {
  const r = searchGrants('quiero abrir un bar en Palencia', { place: placeFromText('en Palencia') });
  assert.equal(r.fallback, 'business');
  assert.ok(r.total >= 1);
  assert.ok(r.grants.every(g => /pymes|negocios/.test(g.plain_title)));
});

test('nothing found is zero, not a guess', () => {
  const r = searchGrants('ayudas para protectoras de animales', { place: placeFromText('en Huelva') });
  assert.equal(r.total, 0);
});
