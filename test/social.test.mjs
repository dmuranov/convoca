// Social channels: what gets picked, per-channel filtering, dedup, platform limits, retries and
// one channel failing without blocking the others. Scratch SQLite file, fake senders - no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const DB = path.join(os.tmpdir(), `convoca-social-test-${process.pid}.sqlite`);
process.env.DB_PATH = DB;
process.env.DRY_RUN = '0';
const { db } = await import('../src/db.js');
process.on('exit', () => { try { db.close(); } catch {} for (const f of [DB, DB + '-wal', DB + '-shm']) fs.rmSync(f, { force: true }); });

const C = await import('../src/social/content.js');
const { runSocial, buildTargets } = await import('../src/social/run.js');
const { withRetry } = await import('../src/social/clients.js');

const NOW = new Date('2026-10-08T17:00:00Z');
let n = 0;
function grant(o = {}) {
  const id = `g${++n}`;
  db.prepare(`INSERT INTO grant_row (id, bdns_ref, title, plain_title, granting_body, region, amount_max, deadline_date,
      deadline_source, deadline_confirmed, is_rolling, status, published, published_at, beneficiarios_bdns)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'api', 1, 0, 'OPEN', 1, ?, ?)`)
    .run(id, String(800000 + n), `Ayuda ${n}`, o.title ?? `Ayuda ${n}`, o.body ?? 'ARAGÓN — CONSEJERÍA', o.region ?? 'Aragón',
      o.amount ?? null, o.deadline ?? '2026-12-01', o.published_at ?? '2026-10-08 10:00:00', o.ben ?? '[]');
  return id;
}
function tender(o = {}) {
  const id = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  db.prepare(`INSERT INTO licitacion_row (id, expediente, updated_at, estado, organo, presupuesto_base, fecha_limite, ccaa,
      titulo, published, published_at) VALUES (?, ?, datetime('now'), 'licitacion', 'Concello', ?, ?, ?, ?, 1, ?)`)
    .run(id, `E-${n}`, o.amount ?? 1000, o.deadline ?? '2026-12-01', o.ccaa ?? 'Galicia', `Obra ${n}`, o.published_at ?? '2026-10-08 10:00:00');
  return id;
}
const BIZ = '["PYME Y PERSONAS FÍSICAS QUE DESARROLLAN ACTIVIDAD ECONÓMICA"]';

test('new: last 26 h only, split into subvenciones / negocios / licitaciones, max 5, highest amount first', () => {
  for (let i = 1; i <= 7; i++) grant({ amount: i * 1000 });
  grant({ amount: 999999, published_at: '2026-10-06 09:00:00' });     // too old for "nuevas hoy"
  grant({ amount: 50, ben: BIZ });
  tender({ amount: 5 });
  const sel = C.selectFor({}, 'new', C.candidates('new', NOW));
  assert.equal(sel.subvenciones.items.length, 5);
  assert.equal(sel.subvenciones.more, 2);
  assert.deepEqual(sel.subvenciones.items.map(i => i.amount), [7000, 6000, 5000, 4000, 3000]);
  assert.equal(sel.negocios.items.length, 1, 'business grants go to negocios, not subvenciones');
  assert.ok(sel.licitaciones.items.length >= 1);
});

test('variety: one item per granting body before repeating one', () => {
  const cands = { subvenciones: [
    ...[9, 8, 7, 6].map(a => ({ kind: 'grant', id: 'b' + a, org: 'BADAJOZ', amount: a * 1000 })),
    { kind: 'grant', id: 'x', org: 'CÁCERES', amount: 100 }, { kind: 'grant', id: 'y', org: 'SORIA', amount: 50 },
  ], negocios: [], licitaciones: [] };
  const ids = C.selectFor({}, 'new', cands).subvenciones.items.map(i => i.id);
  assert.deepEqual(ids, ['b9', 'b8', 'b7', 'x', 'y']);
});

test('a regional channel only gets its comunidad; posted items never come back', () => {
  const nav = grant({ region: 'Navarra', amount: 123456 });
  const cands = C.candidates('new', NOW);
  const navSel = C.selectFor({ ccaa: 'Navarra' }, 'new', cands);
  assert.deepEqual(navSel.subvenciones.items.map(i => i.id), [nav]);
  assert.equal(navSel.licitaciones.items.length, 0);
  const again = C.selectFor({ ccaa: 'Navarra' }, 'new', cands, new Set([`grant:${nav}`]));
  assert.equal(again.subvenciones.items.length, 0);
});

test('closing: next 7 days only, soonest first', () => {
  const a = grant({ deadline: '2026-10-12', published_at: '2026-09-01 10:00:00' });
  const b = grant({ deadline: '2026-10-09', published_at: '2026-09-01 10:00:00' });
  grant({ deadline: '2026-10-20', published_at: '2026-09-01 10:00:00' });
  const ids = C.selectFor({}, 'closing', C.candidates('closing', NOW)).subvenciones.items.map(i => i.id);
  assert.deepEqual(ids.slice(0, 2), [b, a]);
  assert.ok(!ids.some(id => db.prepare('SELECT deadline_date d FROM grant_row WHERE id = ?').get(id).d > '2026-10-15'));
});

test('links carry the UTM tags for each platform and campaign', () => {
  const u = new URL(C.withUtm('/subvenciones/x-1/', 'telegram', 'new'));
  assert.equal(u.searchParams.get('utm_source'), 'telegram');
  assert.equal(u.searchParams.get('utm_medium'), 'social');
  assert.equal(u.searchParams.get('utm_campaign'), 'new');
  const sel = { items: [{ title: 'A <b>', path: '/x/', amountText: 'Hasta 1.000 €', deadline: '2026-10-12' }], more: 3 };
  const msg = C.telegramMessage('closing', 'subvenciones', sel);
  assert.match(msg, /utm_source=telegram&amp;utm_medium=social&amp;utm_campaign=closing/);
  assert.match(msg, /A &lt;b&gt;/, 'titles are escaped');
  assert.match(msg, /Y 3 más/);
});

test('Bluesky posts stay within 300 characters and the link facet points at the right bytes', () => {
  const long = 'Ayudas para la rehabilitación de viviendas rurales en municipios de menos de mil habitantes ' .repeat(5);
  const posts = C.blueskyThread('new', 'subvenciones', { items: [{ title: long, path: '/subvenciones/ñandú-1/', amountText: 'Hasta 12.000 €', deadline: '2026-11-30' }], more: 0 });
  for (const p of posts) {
    assert.ok([...new Intl.Segmenter('es', { granularity: 'grapheme' }).segment(p.text)].length <= C.BLUESKY_MAX);
    const f = p.facets[0];
    const linked = Buffer.from(p.text).subarray(f.index.byteStart, f.index.byteEnd).toString();
    assert.match(linked, /^Ver (todas )?en Plazo Abierto$/);
    assert.match(f.features[0].uri, /utm_source=bluesky/);
  }
});

test('buildTargets reads channels from config only, each behind its own switch', () => {
  assert.deepEqual(buildTargets({}), []);
  const t = buildTargets({ SOCIAL_TELEGRAM_ENABLED: '1', TELEGRAM_CHANNEL_ID: '@pa',
    TELEGRAM_CHANNELS: '[{"chat":"@pa_aragon","ccaa":"Aragón"}]', SOCIAL_BLUESKY_ENABLED: '0', BLUESKY_HANDLE: 'x' });
  assert.deepEqual(t.map(x => [x.key, x.ccaa]), [['telegram:@pa', null], ['telegram:@pa_aragon', 'Aragón']]);
});

test('one failing channel does not block the others, and only accepted items are logged', async () => {
  const targets = [{ platform: 'telegram', key: 'telegram:@ok', ccaa: null }, { platform: 'bluesky', key: 'bluesky:broken', ccaa: null }];
  const sent = [];
  const senderFor = (t) => async (campaign, section, sel, onItem) => {
    if (t.key === 'bluesky:broken') throw new Error('Bluesky down');
    sel.items.forEach((it, i) => { sent.push(it.id); onItem(i); });
  };
  const res = await runSocial('new', { targets, now: NOW, senderFor, sleep: async () => {}, dryRun: false });
  const ok = res.find(r => r.target === 'telegram:@ok');
  const bad = res.find(r => r.target === 'bluesky:broken');
  assert.ok(ok.posted > 0 && !ok.error);
  assert.equal(bad.posted, 0);
  assert.match(bad.error, /Bluesky down/);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM social_post WHERE target = 'bluesky:broken'").get().c, 0);
  // Run until there is nothing left: the leftovers beyond the first 5 go out, nothing twice.
  for (let i = 0; i < 5; i++) await runSocial('new', { targets: [targets[0]], now: NOW, senderFor, sleep: async () => {}, dryRun: false });
  assert.equal(new Set(sent).size, sent.length, 'no item is posted twice');
  const last = await runSocial('new', { targets: [targets[0]], now: NOW, senderFor, sleep: async () => {}, dryRun: false });
  assert.equal(last[0].posted, 0);
});

test('a dry run posts nothing to the log', async () => {
  const id = grant({ amount: 777777 });
  const t = { platform: 'telegram', key: 'telegram:@dry', ccaa: null };
  process.env.SOCIAL_OUTBOX_DIR = path.join(os.tmpdir(), `convoca-social-out-${process.pid}`);
  const res = await runSocial('new', { targets: [t], now: NOW, sleep: async () => {}, dryRun: true });
  assert.ok(res[0].posted > 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM social_post WHERE target = 'telegram:@dry'").get().c, 0);
  fs.rmSync(process.env.SOCIAL_OUTBOX_DIR, { recursive: true, force: true });
  assert.ok(id);
});

test('withRetry: backs off on transient errors, honours retry_after, fails fast on 4xx', async () => {
  const waits = [];
  let calls = 0;
  const v = await withRetry(async () => { if (++calls < 3) throw Object.assign(new Error('x'), { status: 503 }); return 'ok'; },
    { sleep: async (ms) => waits.push(ms), baseMs: 100 });
  assert.equal(v, 'ok');
  assert.deepEqual(waits, [100, 200]);
  const w2 = [];
  let c2 = 0;
  await withRetry(async () => { if (++c2 < 2) throw Object.assign(new Error('slow down'), { status: 429, retryAfter: 7 }); return 1; },
    { sleep: async (ms) => w2.push(ms) });
  assert.deepEqual(w2, [7000]);
  let c3 = 0;
  await assert.rejects(withRetry(async () => { c3++; throw Object.assign(new Error('bad token'), { status: 401 }); }, { sleep: async () => {} }));
  assert.equal(c3, 1);
});

test('WhatsApp text lists what closes this week with whatsapp UTM tags', () => {
  const txt = C.whatsappClosingText(NOW);
  assert.match(txt, /^\*Cierran en los próximos 7 días\*/);
  assert.match(txt, /utm_source=whatsapp&utm_medium=social&utm_campaign=closing/);
});
