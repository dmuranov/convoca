// Build brief step 4: "Build the page, then read it yourself against ejn.gov.ba before
// generalizing." Generates a static HTML file from real, already-pulled data (via
// pullMunicipality.js) - no server wired up for FondBiH yet, so this is the fastest path
// to something a human can actually read and cross-check.
//
// Confirmed live 2026-09-03 (docs/ejn-api-notes.md has the full trace): ejn_award and
// ejn_lot_contract are NOT the same population at two lifecycle stages - ejn_lot_contract
// is exclusively master-agreement call-offs (every row confirmed IsMasterAgreement=true),
// and a master-agreement award's own `value` is the framework's ceiling at time of award,
// not a same-year spend figure. Summing both totals naively double-counts that ceiling
// against its own real drawdown. So the page deliberately splits spend into two additive,
// non-overlapping buckets - one-off awards (is_master_agreement=0) and realized
// framework-agreement drawdowns (ejn_lot_contract) - and states the split explicitly on
// the page, rather than showing one blended total next to a supplier table that only
// covers a fraction of it. Supplier identity is ALSO structurally only available for the
// framework-agreement bucket: the main Award record carries no supplier field at all in
// this API (checked exhaustively - Lots, AwardNotices, and the ProcedureContractSummaries
// collection that looked like the missing link are all empty of that data). That's why
// "Najveći dobavljač" is scoped to, and labeled as, the framework-agreement slice only.
//
// Usage: node scripts/buildMunicipalityPage.js [CITY_NAME] [output path]
import { dbEjn } from '../src/dbEjn.js';
import { writeFileSync } from 'node:fs';

const CITY_NAME = process.argv[2] || 'PRIJEDOR';
const OUT_PATH = process.argv[3] || `scratch-${CITY_NAME.toLowerCase()}.html`;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = (n) => n == null ? '—' : Math.round(n).toLocaleString('bs-BA') + ' KM';

const city = dbEjn.prepare(`SELECT id, name FROM ejn_city WHERE name = ?`).get(CITY_NAME);
if (!city) throw new Error(`no ejn_city row for "${CITY_NAME}" - run pullMunicipality.js first`);

const authorityIds = dbEjn.prepare(`SELECT id FROM ejn_contracting_authority WHERE city_id = ?`).all(city.id).map(r => r.id);
const idList = authorityIds.length ? authorityIds.join(',') : '-1';

// Excludes master-agreement awards (their `value` is a ceiling, not spend - see file
// header). Framework-agreement spend is counted once, via ejn_lot_contract, below.
const totals = dbEjn.prepare(`
  SELECT COUNT(*) n, SUM(value) total, SUM(eu_funds_used) eu
  FROM ejn_award WHERE contracting_authority_id IN (${idList}) AND is_master_agreement = 0
`).get();

const categories = dbEjn.prepare(`
  SELECT contract_category_name, COUNT(*) n, SUM(value) total
  FROM ejn_award
  WHERE contracting_authority_id IN (${idList}) AND is_master_agreement = 0
    AND contract_category_name IS NOT NULL
  GROUP BY contract_category_name ORDER BY total DESC LIMIT 5
`).all();

const terminations = dbEjn.prepare(`
  SELECT procedure_name, type_name, decision_date, additional_information
  FROM ejn_termination
  WHERE contracting_authority_id IN (${idList})
  ORDER BY decision_date DESC
`).all();

const suppliers = dbEjn.prepare(`
  SELECT name, COUNT(*) n, SUM(value) total FROM (
    SELECT s.name, lc.value FROM ejn_lot_contract lc
    JOIN ejn_supplier_group_supplier_link l ON l.supplier_group_id = lc.supplier_group_id
    JOIN ejn_supplier s ON s.id = l.supplier_id
    WHERE lc.contracting_authority_id IN (${idList})
    UNION ALL
    SELECT u.name, lc.value FROM ejn_lot_contract lc
    JOIN ejn_supplier_group_unregistered_link l ON l.supplier_group_id = lc.supplier_group_id
    JOIN ejn_unregistered_supplier u ON u.id = l.unregistered_supplier_id
    WHERE lc.contracting_authority_id IN (${idList})
  ) GROUP BY name ORDER BY total DESC LIMIT 5
`).all();

const lotContractTotal = dbEjn.prepare(`SELECT COUNT(*) n, SUM(value) total FROM ejn_lot_contract WHERE contracting_authority_id IN (${idList})`).get();

const html = `<!doctype html>
<html lang="bs">
<head>
<meta charset="utf-8">
<title>${esc(city.name)} — potrošnja i javne nabavke</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; color: #1a2634; }
  h1 { font-size: 1.6rem; }
  .card { border: 1px solid #ddd; border-radius: 8px; padding: 1rem 1.2rem; margin: 1rem 0; }
  .muted { color: #667; font-size: .9rem; }
  table { width: 100%; border-collapse: collapse; }
  td, th { text-align: left; padding: .3rem .5rem; border-bottom: 1px solid #eee; }
  .termination { background: #fdf3ee; }
  .method-note { font-size: .85rem; color: #667; border-top: 1px solid #ddd; margin-top: 2rem; padding-top: 1rem; }
</style>
</head>
<body>
<h1>${esc(city.name)}</h1>
<p class="muted">Podaci iz e-JN (Agencija za javne nabavke BiH), zadnjih 365 dana. ${authorityIds.length} ugovornih organa sa sjedištem u gradu.</p>

<div class="card">
  <p><strong>${esc(city.name)} je u posljednjih godinu dana potrošio ${eur(totals.total + (lotContractTotal.total || 0))} na ${totals.n + lotContractTotal.n} nabavki</strong>${totals.eu ? ` (${totals.eu} finansirano EU sredstvima)` : ''}.</p>
  <p class="muted">Od toga ${eur(totals.total)} kroz ${totals.n} pojedinačnih postupaka javne nabavke, i ${eur(lotContractTotal.total)} kroz ${lotContractTotal.n} realizovanih narudžbi po okvirnim sporazumima (vidi ispod).</p>
  <p>Najviše na (pojedinačni postupci): ${categories.map(c => `${esc(c.contract_category_name)} (${eur(c.total)}, ${c.n})`).join(', ')}.</p>
</div>

<div class="card">
  <h3>Najveći dobavljači po okvirnim sporazumima</h3>
  <p class="muted">Identitet dobavljača je dostupan samo za narudžbe po okvirnim sporazumima (${lotContractTotal.n} narudžbi, ${eur(lotContractTotal.total)}) - izvor javnih nabavki ne objavljuje dobavljača za pojedinačne postupke odvojeno od ovog mehanizma, pa ova lista ne pokriva ${eur(totals.total)} potrošeno kroz pojedinačne postupke iznad.</p>
  <table>${suppliers.map(s => `<tr><td>${esc(s.name)}</td><td>${s.n} ugovora</td><td>${eur(s.total)}</td></tr>`).join('')}</table>
</div>

<div class="card termination">
  <h3>Poništeni postupci (${terminations.length})</h3>
  ${terminations.slice(0, 5).map(t => `
    <p><strong>${esc(t.procedure_name || '(bez naziva)')}</strong> - ${esc(t.type_name || 'razlog nije naveden')}
    ${t.decision_date ? `<br><span class="muted">${t.decision_date.slice(0, 10)}</span>` : ''}
    ${t.additional_information ? `<br>${esc(t.additional_information.trim().slice(0, 300))}` : ''}</p>
  `).join('')}
</div>

<p class="method-note">
  Izvor: open.ejn.gov.ba (Agencija za javne nabavke BiH). Ukupan iznos zbraja dvije
  odvojene, nepreklapajuće kategorije: pojedinačne postupke javne nabavke (${totals.n}
  zapisa, po iznosu dodjele) i stvarno realizovane narudžbe po okvirnim sporazumima
  (${lotContractTotal.n} zapisa, po iznosu narudžbe - ne po procijenjenoj vrijednosti
  samog okvirnog sporazuma, koja može pokrivati više godina). Sve brojke su automatski
  izračunate; provjerite izvor prije oslanjanja na tačan iznos.
</p>
</body>
</html>`;

writeFileSync(OUT_PATH, html, 'utf8');
console.log(`Wrote ${OUT_PATH}`);
console.log('Authorities:', authorityIds.length, '| Awards:', totals.n, eur(totals.total), '| LotContracts:', lotContractTotal.n, '| Terminations:', terminations.length);
