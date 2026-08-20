// Deterministic date engine — Ley 39/2015 art. 30. No LLM output ever enters
// this module; inputs are (baseDate, count, unit) parsed elsewhere and
// operator-confirmed before anything computed here is shown or sent.
//
// Rules implemented:
//  - días hábiles exclude Saturdays, Sundays, and listed holidays (art. 30.2)
//  - counting starts the day AFTER the triggering event (art. 30.3)
//  - plazos by months run fecha a fecha; if no equivalent day, last day of month (art. 30.4)
//  - a deadline landing on an inhábil day extends to the first hábil day (art. 30.5)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cal = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'data', 'holidays.json'), 'utf-8'));

// localHolidays: array of 'YYYY-MM-DD' or recurring 'MM-DD' (municipality.local_holidays)
export function holidaySet(localHolidays = []) {
  return { fixed: new Set([...cal.national, ...cal.castilla_y_leon, ...localHolidays.filter(h => h.length === 10)]),
           recurring: new Set(localHolidays.filter(h => h.length === 5)) };
}

const iso = (d) => d.toISOString().slice(0, 10);
const parse = (s) => {
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date: ${s}`);
  return d;
};

export function isHabil(dateStr, hs) {
  const d = parse(dateStr);
  const dow = d.getUTCDay();               // 0 Sun, 6 Sat
  if (dow === 0 || dow === 6) return false;
  if (hs.fixed.has(dateStr)) return false;
  if (hs.recurring.has(dateStr.slice(5))) return false;
  return true;
}

function nextDay(dateStr) {
  const d = parse(dateStr);
  d.setUTCDate(d.getUTCDate() + 1);
  return iso(d);
}

export function nextHabil(dateStr, hs) {
  let d = dateStr;
  while (!isHabil(d, hs)) d = nextDay(d);
  return d;
}

// "N días hábiles desde <baseDate>": count starts the day after baseDate;
// returns the date of the Nth hábil day (the last day of the plazo).
export function addHabiles(baseDate, n, hs) {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid día-hábil count: ${n}`);
  let d = baseDate, counted = 0;
  while (counted < n) {
    d = nextDay(d);
    if (isHabil(d, hs)) counted++;
  }
  return d;
}

// "N días naturales desde <baseDate>": count starts the day after baseDate;
// if the last day is inhábil the plazo extends to the first hábil day (art. 30.5).
export function addNaturales(baseDate, n, hs) {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid día-natural count: ${n}`);
  const d = parse(baseDate);
  d.setUTCDate(d.getUTCDate() + n);
  return nextHabil(iso(d), hs);
}

// "N meses desde <baseDate>": fecha a fecha (art. 30.4) — same day-of-month in the
// target month, or the last day of that month if it doesn't exist; extended to the
// first hábil day if it lands on an inhábil one.
export function addMeses(baseDate, n, hs) {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid month count: ${n}`);
  const d = parse(baseDate);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return nextHabil(iso(target), hs);
}

// Single entry point: term = {count, unit: 'habiles'|'naturales'|'meses'}
export function computeDeadline(baseDate, term, localHolidays = []) {
  const hs = holidaySet(localHolidays);
  switch (term.unit) {
    case 'habiles':   return addHabiles(baseDate, term.count, hs);
    case 'naturales': return addNaturales(baseDate, term.count, hs);
    case 'meses':     return addMeses(baseDate, term.count, hs);
    default: throw new Error(`unknown plazo unit: ${term.unit}`);
  }
}
