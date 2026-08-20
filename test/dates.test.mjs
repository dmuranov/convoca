// Date-engine tests — every expected value was computed by hand against a 2026
// calendar. Spec: "one wrong deadline ends the reference."
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDeadline, isHabil, holidaySet } from '../src/ingest/dates.js';

test('Saturdays are inhábiles (Ley 39/2015), Fridays are not', () => {
  const hs = holidaySet();
  assert.equal(isHabil('2026-08-22', hs), false); // Saturday
  assert.equal(isHabil('2026-08-23', hs), false); // Sunday
  assert.equal(isHabil('2026-08-21', hs), true);  // Friday
});

test('días hábiles across a plain weekend', () => {
  // 5 hábiles desde Mon 2026-08-24 → Tue..Fri (4) + Mon 31st (5)
  assert.equal(computeDeadline('2026-08-24', { count: 5, unit: 'habiles' }), '2026-08-31');
});

test('días hábiles skipping a national holiday (12 Oct)', () => {
  // 10 hábiles desde Wed 2026-09-30; Mon 12 Oct is Fiesta Nacional
  assert.equal(computeDeadline('2026-09-30', { count: 10, unit: 'habiles' }), '2026-10-15');
});

test('días hábiles across Semana Santa (CyL Jueves Santo + national Viernes Santo)', () => {
  // 3 hábiles desde Tue 2026-03-31: Wed 1 Apr (1), Thu 2 + Fri 3 holidays, weekend, Mon 6 (2), Tue 7 (3)
  assert.equal(computeDeadline('2026-03-31', { count: 3, unit: 'habiles' }), '2026-04-07');
});

test('días hábiles skipping a local fiesta (fixed date)', () => {
  // 2 hábiles desde Wed 2026-06-10 with local fiesta Thu 11 Jun: Fri 12 (1), Mon 15 (2)
  assert.equal(computeDeadline('2026-06-10', { count: 2, unit: 'habiles' }, ['2026-06-11']), '2026-06-15');
});

test('días hábiles skipping a recurring local fiesta (MM-DD)', () => {
  assert.equal(computeDeadline('2026-06-10', { count: 2, unit: 'habiles' }, ['06-11']), '2026-06-15');
});

test('días naturales landing on inhábil extend to first hábil (art. 30.5)', () => {
  // 15 naturales desde Fri 2026-08-14 → Sat 29 Aug → Mon 31 Aug
  assert.equal(computeDeadline('2026-08-14', { count: 15, unit: 'naturales' }), '2026-08-31');
});

test('meses fecha a fecha with short month + inhábil extension (art. 30.4/30.5)', () => {
  // 1 mes desde 2026-01-31 → no 31 Feb → 28 Feb (Sat) → Mon 2 Mar
  assert.equal(computeDeadline('2026-01-31', { count: 1, unit: 'meses' }), '2026-03-02');
});

test('rejects garbage input instead of guessing', () => {
  assert.throws(() => computeDeadline('2026-08-24', { count: 0, unit: 'habiles' }));
  assert.throws(() => computeDeadline('2026-08-24', { count: 10, unit: 'weeks' }));
  assert.throws(() => computeDeadline('not-a-date', { count: 10, unit: 'habiles' }));
});
