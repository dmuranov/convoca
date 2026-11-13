import test from 'node:test';
import assert from 'node:assert/strict';
import { grantGiver, grantSeoTitle, grantSeoDescription, isGrantIndexable, isGrantLive, indexCutoff, amountLabel, cardHook, HOOK_MAX } from '../src/grantSeo.js';
import { daysLabel, daysLeft } from '../src/seoUtils.js';
import { grantListItem } from '../src/siteChrome.js';
import { dedupeGrants } from '../src/seoQueries.js';
import { hubIntro, wordCount, CCAA_BODIES } from '../src/hubIntro.js';
import { CCAA } from '../src/ingest/regions.js';

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

const EX = JSON.stringify({ para_que: 'Para arreglar el local.', quien_puede: 'Asociaciones.' });

test('shown: open calls, and calls closed in the last 30 days; never a direct award or a long-closed call', () => {
  const today = '2026-10-08';
  assert.equal(indexCutoff(today), '2026-09-08');
  assert.ok(isGrantLive({ status: 'OPEN' }, today));
  assert.ok(isGrantLive({ status: 'OPEN', deadline_date: null }, today));
  assert.ok(isGrantLive({ status: 'CLOSED', deadline_date: '2026-09-20' }, today), 'just closed');
  assert.ok(!isGrantLive({ status: 'CLOSED', deadline_date: '2026-07-12' }, today), 'long closed');
  assert.ok(!isGrantLive({ status: 'CLOSED', deadline_date: null }, today), 'direct award / closed by BDNS');
});

test('index: shown and with our explanation; never a raw BDNS record', () => {
  const today = '2026-10-08';
  assert.ok(isGrantIndexable({ status: 'OPEN', plain_explainer: EX }, today));
  assert.ok(isGrantIndexable({ status: 'CLOSED', deadline_date: '2026-09-20', plain_explainer: EX }, today));
  assert.ok(!isGrantIndexable({ status: 'CLOSED', deadline_date: '2026-07-12', plain_explainer: EX }, today), 'long closed');
  assert.ok(!isGrantIndexable({ status: 'CLOSED', deadline_date: null, plain_explainer: EX }, today), 'direct award');
  assert.ok(!isGrantIndexable({ status: 'OPEN', plain_explainer: null }, today), 'no explanation yet');
  assert.ok(!isGrantIndexable({ status: 'OPEN', plain_explainer: '{"para_que":" "}' }, today), 'empty explanation');
  assert.ok(!isGrantIndexable({ status: 'OPEN', plain_explainer: 'not json' }, today));
});

test('days left: último día, queda 1 día, quedan n días', () => {
  assert.equal(daysLabel(0), 'último día');
  assert.equal(daysLabel(-1), 'último día');
  assert.equal(daysLabel(1), 'queda 1 día');
  assert.equal(daysLabel(2), 'quedan 2 días');
});

test('amount: the BDNS 0.01 placeholder is an honorary prize, never "0,01 €"', () => {
  assert.equal(amountLabel({ amount_max: 60000 }), 'hasta 60.000 €');
  assert.equal(amountLabel({ budget_total: 40000 }), 'bolsa de 40.000 €');
  assert.equal(amountLabel({ budget_total: 0.01 }), 'Premio honorífico / sin dotación económica');
  assert.equal(amountLabel({ amount_max: 0.01, budget_total: 0.01 }), 'Premio honorífico / sin dotación económica');
  assert.equal(amountLabel({ amount_max: 0.01, budget_total: 30000 }), 'bolsa de 30.000 €');
  assert.equal(amountLabel({ amount_max: null, budget_total: 0 }), 'según bases');
  assert.equal(amountLabel({}), 'según bases');
  const t = grantSeoTitle({ plain_title: 'Premio de poesía 2026', granting_body: 'MADRID — DISTRITO DE TETUÁN', amount_max: 0.01 });
  assert.ok(!/0,01/.test(t), t);
  assert.ok(!/0,01/.test(grantSeoDescription({ plain_title: 'Premio de poesía', budget_total: 0.01, status: 'OPEN' })));
});

test('a card in a list carries one line, not the whole summary', () => {
  const long = 'Ayuda para que las asociaciones de vecinos de la comarca arreglen su local social y compren mobiliario, equipos informáticos y material para sus actividades durante todo el año. La segunda frase no sale.';
  const hook = cardHook({ ai_summary: long });
  assert.ok(hook.length <= HOOK_MAX, String(hook.length));
  assert.ok(hook.endsWith('…'));
  assert.ok(!hook.includes('segunda'));
  assert.equal(cardHook({ ai_summary: 'Ayuda para arreglar el local social de la asociación. Otra frase.' }), 'Ayuda para arreglar el local social de la asociación.');
  assert.equal(cardHook({ ai_summary: null }), '');
  const html = grantListItem({ bdns_ref: '1', title: 'T', ai_summary: long, budget_total: 0.01, deadline_date: null });
  assert.ok(!html.includes('segunda') && !html.includes('0,01') && html.includes('Premio honorífico'));
});

test('the extracto and the convocatoria of one grant are one card', () => {
  const g = (o) => ({ granting_body: 'PALENZUELA — AYUNTAMIENTO DE PALENZUELA', deadline_date: '2026-12-01', ...o });
  const out = dedupeGrants([
    g({ bdns_ref: '900002', title: 'Extracto de la convocatoria de ayudas a la feria 2026', plain_title: 'Ayudas a la feria' }),
    g({ bdns_ref: '900001', title: 'Convocatoria de ayudas a la feria 2026', plain_title: 'Ayudas para la feria', plain_explainer: EX }),
    g({ bdns_ref: '900003', title: 'Ayudas al deporte 2026' }),
    g({ bdns_ref: '900004', title: 'Convocatoria de ayudas a la feria 2026', deadline_date: '2027-01-15' }),
    g({ bdns_ref: '900005', title: 'Convocatoria de ayudas a la feria 2026', granting_body: 'ASTUDILLO — AYUNTAMIENTO DE ASTUDILLO' }),
  ]);
  assert.deepEqual(out.map(x => x.bdns_ref), ['900001', '900003', '900004', '900005']);
});

test('hub intro: 120 to 180 words, for every kind of hub and any amount of data', () => {
  const soon = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const rich = Array.from({ length: 163 }, (_, i) => ({
    granting_body: ['CATALUÑA — DEPARTAMENTO DE CULTURA', 'BARCELONA — DIPUTACIÓN', 'GIRONA — AYUNTAMIENTO DE GIRONA', 'CONSELL COMARCAL DEL BAIX EMPORDÀ'][i % 4],
    category: ['Cultura', 'Social', 'Empleo', 'Deporte'][i % 4], region: ['Cataluña', 'Andalucía', 'Galicia'][i % 3],
    budget_total: i % 2 ? 50000 + i : null, deadline_date: i % 5 ? '2099-01-01' : soon }));
  const sparse = [{ granting_body: null }, { granting_body: null }, { granting_body: null }];
  const one = Array.from({ length: 3 }, () => ({ granting_body: 'TERUEL — DIPUTACIÓN', category: 'Otros', budget_total: 0.01 }));
  const kinds = [
    ...Object.values(CCAA).map(ccaaName => ({ kind: 'ccaa', ccaaName })),
    { kind: 'province', ccaaName: 'Cataluña', provinceName: 'Tarragona' },
    { kind: 'province', ccaaName: 'Comunitat Valenciana', provinceName: 'Castellón/Castelló' },
    { kind: 'category', categoryName: 'Medio ambiente' },
    { kind: 'estatales' },
    { kind: 'beneficiario', beneficiarioLabel: 'Clubes deportivos' },
    { kind: 'beneficiario', beneficiarioLabel: 'Juntas vecinales', ccaaName: 'Castilla y León' },
  ];
  for (const k of kinds) for (const grants of [rich, sparse, one]) for (const alerts of [true, false]) {
    const text = hubIntro({ ...k, grants, alerts });
    const w = wordCount(text);
    assert.ok(w >= 120 && w <= 180, `${JSON.stringify(k)} (${grants.length} grants, alerts ${alerts}): ${w} words\n${text}`);
    assert.ok(!/undefined|null|NaN|0,01/.test(text), text);
  }
  assert.deepEqual(Object.values(CCAA).filter(n => !CCAA_BODIES[n]), [], 'every comunidad has its bodies');
  const cat = hubIntro({ kind: 'ccaa', ccaaName: 'Cataluña', grants: rich, alerts: true });
  assert.match(cat, /Generalitat de Catalunya \(Gencat\)/);
  assert.match(cat, /Diputación de Barcelona/);
  assert.notEqual(cat, hubIntro({ kind: 'ccaa', ccaaName: 'Galicia', grants: rich, alerts: true }));
});

test('days left counts calendar days in Spain: 0 on the deadline day, 1 the day before', () => {
  const at = (iso) => new Date(iso);
  assert.equal(daysLeft('2026-11-20', at('2026-11-20T08:00:00+01:00')), 0);
  assert.equal(daysLeft('2026-11-20', at('2026-11-20T23:30:00+01:00')), 0);
  assert.equal(daysLeft('2026-11-20', at('2026-11-19T23:30:00+01:00')), 1, 'still the 19th in Spain, the 19th in UTC too');
  assert.equal(daysLeft('2026-11-20', at('2026-11-20T00:30:00+01:00')), 0, 'already the 20th in Spain, still the 19th in UTC');
  assert.equal(daysLeft('2026-11-20T14:00:00', at('2026-11-08T12:00:00+01:00')), 12, 'tender deadlines carry a time');
  assert.equal(daysLeft('2026-11-20', at('2026-11-21T09:00:00+01:00')), -1);
  assert.equal(daysLeft(null), null);
});

test('hub intro names the regional government in full, without the bracket', () => {
  const grants = [
    ...Array.from({ length: 3 }, () => ({ granting_body: 'CATALUÑA — DEPARTAMENTO DE CULTURA' })),
    ...Array.from({ length: 2 }, () => ({ granting_body: 'BARCELONA — DIPUTACIÓN' })),
  ];
  const text = hubIntro({ kind: 'ccaa', ccaaName: 'Cataluña', grants, alerts: false });
  assert.match(text, /hoy son Generalitat de Catalunya \(3\) y Diputación de Barcelona \(2\)\./, text);
});
