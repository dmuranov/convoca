// Email alerts: filter cleaning, matching per section, digest ordering and the never-twice rule.
// Runs against a scratch SQLite file (DB_PATH is read when src/db.js loads).
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `convoca-alerts-test-${process.pid}.sqlite`);
process.env.DB_PATH = DB;
process.env.DRY_RUN = '1';
process.on('exit', () => { try { db.close(); } catch {} for (const f of [DB, DB + '-wal', DB + '-shm']) fs.rmSync(f, { force: true }); });

const { db } = await import('../src/db.js');
const F = await import('../src/alerts/filters.js');
const { runDigests, itemsFor, byClosingSoonest } = await import('../src/alerts/digest.js');
const { digestEmail } = await import('../src/alerts/emails.js');
const { sourceType } = await import('../src/routes/alerts.js');

// ---- filters -------------------------------------------------------------------------------

test('cleanFilters keeps only known keys for the section', () => {
  assert.deepEqual(F.cleanFilters('subvenciones', { ccaa: 'Aragón', category: 'cultura', cpv: '45', evil: 'x' }),
    { ccaa: 'Aragón', category: 'cultura' });
  assert.deepEqual(F.cleanFilters('licitaciones', { cpv: '45233000-9', tipo_contrato: 'Obras', category: 'x' }),
    { cpv: '45', tipo_contrato: 'Obras' });
  assert.deepEqual(F.cleanFilters('subvenciones', { ccaa: 'Toda España' }), {});
  assert.deepEqual(F.cleanFilters('subvenciones', { province: 'Huesca' }), {}, 'a province needs its comunidad');
  assert.deepEqual(F.cleanFilters('subvenciones', { beneficiario: 'Hackers' }), {});
  assert.deepEqual(F.cleanFilters('negocios', { leader: 'true' }), { leader: true });
});

test('canonicalFilters is order-independent', () => {
  assert.equal(F.canonicalFilters({ b: 1, a: 2 }), F.canonicalFilters({ a: 2, b: 1 }));
});

const grant = (o = {}) => ({ region: 'Aragón', province: null, municipality: null, category: 'cultura',
  entity_types: '["Asociacion"]', granting_body: 'ARAGÓN — CONSEJERÍA', title: 'Ayudas', beneficiarios_bdns: '[]', ...o });

test('grant place rule: nationwide, comunidad, province, own town', () => {
  const f = { ccaa: 'Aragón', province: 'Huesca', municipality: 'Jaca' };
  assert.ok(F.grantMatches(grant({ region: 'Toda España' }), f));
  assert.ok(F.grantMatches(grant(), f));
  assert.ok(F.grantMatches(grant({ province: 'Huesca' }), f));
  assert.ok(!F.grantMatches(grant({ province: 'Teruel' }), f));
  assert.ok(F.grantMatches(grant({ province: 'Huesca', municipality: 'Jaca' }), f));
  assert.ok(!F.grantMatches(grant({ province: 'Huesca', municipality: 'Sabiñánigo' }), f));
  assert.ok(!F.grantMatches(grant({ region: 'Navarra' }), f));
  assert.ok(!F.grantMatches(grant({ municipality: 'Jaca' }), { ccaa: 'Aragón' }), 'town-only money needs the town');
});

test('grant category ignores accents; beneficiary must be listed', () => {
  assert.ok(F.grantMatches(grant({ category: 'educacion' }), { category: 'educación' }));
  assert.ok(!F.grantMatches(grant(), { category: 'deporte' }));
  assert.ok(F.grantMatches(grant(), { beneficiario: 'Asociacion' }));
  assert.ok(!F.grantMatches(grant(), { beneficiario: 'AMPA' }));
});

test('negocios only matches business or LEADER grants', () => {
  const biz = grant({ beneficiarios_bdns: '["PYME Y PERSONAS FÍSICAS QUE DESARROLLAN ACTIVIDAD ECONÓMICA"]' });
  const notBiz = grant({ beneficiarios_bdns: '["PERSONAS JURÍDICAS QUE NO DESARROLLAN ACTIVIDAD ECONÓMICA"]' });
  const leader = grant({ granting_body: 'ADRI PÁRAMOS Y VALLES - ASOCIACIÓN PARA EL DESARROLLO RURAL' });
  assert.ok(F.negocioMatches(biz, {}));
  assert.ok(!F.negocioMatches(notBiz, {}));
  assert.ok(F.negocioMatches(leader, { leader: true }));
  assert.ok(!F.negocioMatches(biz, { leader: true }));
});

test('licitaciones: comunidad, contract type, CPV division, órgano', () => {
  const l = { ccaa: 'Galicia', tipo_contrato: 'Obras', cpv: '["45233000","71000000"]', organo: 'Concello de Noia' };
  assert.ok(F.licitacionMatches(l, { ccaa: 'Galicia', tipo_contrato: 'obras', cpv: '45' }));
  assert.ok(F.licitacionMatches(l, { cpv: '71' }));
  assert.ok(!F.licitacionMatches(l, { cpv: '30' }));
  assert.ok(!F.licitacionMatches(l, { ccaa: 'Asturias' }));
  assert.ok(F.licitacionMatches(l, { organo: 'CONCELLO DE NOIA' }));
});

test('signup source page types', () => {
  assert.equal(sourceType('/'), 'listado-subvenciones');
  assert.equal(sourceType('/negocios'), 'listado-negocios');
  assert.equal(sourceType('/subvenciones/ayudas-para-algo-912345/'), 'detalle-subvencion');
  assert.equal(sourceType('/subvenciones/aragon/'), 'hub');
  assert.equal(sourceType('/licitaciones/obra-x-3f2a/'), 'detalle-licitacion');
});

// ---- digests (DB) ----------------------------------------------------------------------------

let n = 0;
function addGrant(o = {}) {
  const id = `g${++n}`;
  db.prepare(`INSERT INTO grant_row (id, bdns_ref, title, plain_title, region, category, status, published,
      published_at, deadline_date, granting_body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, String(900000 + n), `Ayuda ${n}`, `Ayuda ${n}`, o.region ?? 'Aragón', o.category ?? 'cultura',
      o.status ?? 'OPEN', o.published ?? 1, o.published_at ?? '2026-10-06 10:00:00', o.deadline ?? null, 'ARAGÓN');
  return id;
}
function addSub(o = {}) {
  const id = `s${++n}`;
  db.prepare(`INSERT INTO alert_subscription (id, email, section, filters, frequency, status, confirm_token,
      unsubscribe_token, consent_at, consent_version, confirmed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 'v1', ?)`)
    .run(id, `${id}@example.com`, o.section ?? 'subvenciones', o.filters ?? '{"ccaa":"Aragón"}', o.frequency ?? 'weekly',
      o.status ?? 'confirmed', `c-${id}`, `u-${id}`, o.confirmed_at ?? '2026-10-01 00:00:00');
  return db.prepare('SELECT * FROM alert_subscription WHERE id = ?').get(id);
}
const fakeMailer = () => { const sent = []; return { sent, send: async (m) => { sent.push(m); return { id: 'x' }; } }; };
const TODAY = '2026-10-08';

test('digest: only new, open, matching, published-after-confirmation items; closing soonest first', async () => {
  addGrant({ deadline: '2026-11-30' });
  const soon = addGrant({ deadline: '2026-10-10' });
  addGrant({ deadline: null });
  addGrant({ region: 'Navarra' });                                // other comunidad
  addGrant({ published_at: '2026-09-20 10:00:00' });              // before confirmation
  addGrant({ status: 'CLOSED' });
  addGrant({ published: 0 });
  addGrant({ deadline: '2026-10-01' });                           // already past
  const sub = addSub();
  const items = itemsFor(sub, TODAY);
  assert.equal(items.length, 3);
  assert.equal(items[0].id, soon);
  assert.equal(items.at(-1).deadline_date, null, 'no deadline goes last');
});

test('digest: an item is never sent twice, and nothing is sent when nothing matches', async () => {
  const sub = addSub({ filters: '{"ccaa":"Aragón","category":"deporte"}', frequency: 'daily' });
  addGrant({ category: 'deporte', deadline: '2026-12-01' });
  const m1 = fakeMailer();
  await runDigests('daily', { mailer: m1, today: TODAY });
  assert.equal(m1.sent.filter(x => x.to === sub.email).length, 1);
  const m2 = fakeMailer();
  await runDigests('daily', { mailer: m2, today: TODAY });
  assert.equal(m2.sent.filter(x => x.to === sub.email).length, 0, 'same items are not sent again');
  addGrant({ category: 'deporte', deadline: '2026-12-02' });
  const m3 = fakeMailer();
  await runDigests('daily', { mailer: m3, today: TODAY });
  assert.equal(m3.sent.filter(x => x.to === sub.email).length, 1, 'a genuinely new one is');
});

test('digest: failed send records nothing, so the items go out next time', async () => {
  const sub = addSub({ filters: '{"ccaa":"Aragón","category":"pesca"}', frequency: 'daily' });
  addGrant({ category: 'pesca', deadline: '2026-12-01' });
  await runDigests('daily', { mailer: { send: async () => { throw new Error('provider down'); } }, today: TODAY });
  assert.equal(itemsFor(sub, TODAY).length, 1);
});

test('digest: capped at 20 items; unsubscribed and pending get nothing', async () => {
  const sub = addSub({ filters: '{"ccaa":"Aragón","category":"turismo"}' });
  for (let i = 0; i < 25; i++) addGrant({ category: 'turismo', deadline: `2026-12-${String(1 + i).padStart(2, '0')}` });
  assert.equal(itemsFor(sub, TODAY).length, 20);
  addSub({ filters: '{"ccaa":"Aragón","category":"turismo"}', status: 'unsubscribed' });
  addSub({ filters: '{"ccaa":"Aragón","category":"turismo"}', status: 'pending' });
  const m = fakeMailer();
  await runDigests('weekly', { mailer: m, today: TODAY });
  assert.ok(m.sent.every(x => !/unsub|pending/.test(x.to)));
  const mail = m.sent.find(x => x.to === sub.email);
  assert.match(mail.text, /utm_source=email&utm_medium=alert/);
  assert.equal(mail.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.match(mail.headers['List-Unsubscribe'], /\/alertas\/baja\?t=/);
});

test('byClosingSoonest puts dated items first, earliest first', () => {
  const xs = [{ deadline_date: null }, { deadline_date: '2026-12-01' }, { deadline_date: '2026-10-20' }];
  assert.deepEqual(xs.sort(byClosingSoonest).map(x => x.deadline_date), ['2026-10-20', '2026-12-01', null]);
});

test('digest email lists title, amount and deadline', () => {
  const sub = { section: 'subvenciones', filters: '{"ccaa":"Aragón"}', frequency: 'weekly', unsubscribe_token: 'u' };
  const m = digestEmail(sub, [{ kind: 'grant', id: 'a', bdns_ref: '1', title: 'T', plain_title: 'Ayuda X',
    amount_max: 50000, deadline_date: '2026-10-20', deadline_source: 'api', deadline_confirmed: 1 }]);
  assert.match(m.text, /Ayuda X/);
  assert.match(m.text, /Hasta 50\.000 €/);
  assert.match(m.text, /20 de octubre de 2026/);
});
