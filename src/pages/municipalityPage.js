// Shared render logic for a municipality's spending-transparency page - used by both
// scripts/buildMunicipalityPage.js (local generate-to-file, for the "read it yourself"
// step) and serverEjn.js (live route). One implementation so the two never drift.
//
// Confirmed live 2026-09-03 (docs/ejn-api-notes.md has the full trace): ejn_award and
// ejn_lot_contract are NOT the same population at two lifecycle stages - ejn_lot_contract
// is exclusively master-agreement call-offs (every row confirmed IsMasterAgreement=true),
// and a master-agreement award's own `value` is the framework's ceiling at time of award,
// not a same-year spend figure. Summing both totals naively double-counts that ceiling
// against its own real drawdown. So the page deliberately splits spend into two additive,
// non-overlapping buckets - one-off awards (is_master_agreement=0) and realized
// framework-agreement drawdowns (ejn_lot_contract) - and states the split explicitly.
//
// Supplier identity is ALSO structurally only available for the framework-agreement
// bucket: the main Award record carries no supplier field at all in this API (checked
// exhaustively - Lots, AwardNotices, and the ProcedureContractSummaries collection that
// looked like the missing link are all empty of that data). Confirmed on two towns in
// different entities (Prijedor, Zenica) that this bucket is a stable ~17-18% of total
// spend - a real, permanent ceiling on "Najveći dobavljač" coverage, not a data-volume
// problem that improves later. So the page is built around what has complete coverage -
// total spend, category breakdown, and cancellations - and the supplier table is placed
// as a clearly-labeled, visually secondary aside, not a headline feature next to numbers
// it can only ever partially explain.
import { dbEjn } from '../dbEjn.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = (n) => n == null ? '—' : Math.round(n).toLocaleString('bs-BA') + ' KM';

// Returns null if the city has never been pulled (see pullMunicipality.js / pollEjn.js) -
// callers render a 404, not an empty/misleading page.
export function renderMunicipalityPage(cityName) {
  const city = dbEjn.prepare(`SELECT id, name FROM ejn_city WHERE name = ? COLLATE NOCASE`).get(cityName);
  if (!city) return null;

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
    SELECT procedure_name, type_name, decision_date, additional_information, plain_title, plain_reason
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

  return `<!doctype html>
<html lang="bs">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(city.name)} — potrošnja i javne nabavke</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; color: #1a2634; }
  h1 { font-size: 1.6rem; }
  .card { border: 1px solid #ddd; border-radius: 8px; padding: 1rem 1.2rem; margin: 1rem 0; }
  .muted { color: #667; font-size: .9rem; }
  table { width: 100%; border-collapse: collapse; }
  td, th { text-align: left; padding: .3rem .5rem; border-bottom: 1px solid #eee; }
  .termination { background: #fdf3ee; }
  .aside { border: 1px dashed #ccc; border-radius: 8px; padding: .8rem 1.2rem; margin: 1.5rem 0; background: #fafafa; }
  .aside h4 { margin: 0 0 .3rem; font-size: .95rem; color: #445; }
  .aside table { font-size: .9rem; }
  .method-note { font-size: .85rem; color: #667; border-top: 1px solid #ddd; margin-top: 2rem; padding-top: 1rem; }
</style>
</head>
<body>
<h1>${esc(city.name)}</h1>
<p class="muted">Podaci iz e-JN (Agencija za javne nabavke BiH), zadnjih 365 dana. ${authorityIds.length} ugovornih organa sa sjedištem u gradu.</p>

<div class="card">
  <p><strong>${esc(city.name)} je u posljednjih godinu dana potrošio ${eur(totals.total + (lotContractTotal.total || 0))} na ${totals.n + lotContractTotal.n} nabavki</strong>${totals.eu ? ` (${totals.eu} finansirano EU sredstvima)` : ''}.</p>
  <p class="muted">Od toga ${eur(totals.total)} kroz ${totals.n} pojedinačnih postupaka javne nabavke, i ${eur(lotContractTotal.total)} kroz ${lotContractTotal.n} realizovanih narudžbi po okvirnim sporazumima.</p>
  <p>Najviše na: ${categories.map(c => `${esc(c.contract_category_name)} (${eur(c.total)}, ${c.n})`).join(', ')}.</p>
</div>

<div class="card termination">
  <h3>Poništeni postupci (${terminations.length})</h3>
  ${terminations.slice(0, 5).map(t => `
    <p><strong>${esc(t.plain_title || t.procedure_name || '(bez naziva)')}</strong> - ${esc(t.plain_reason || t.type_name || 'razlog nije naveden')}
    ${t.decision_date ? `<br><span class="muted">${t.decision_date.slice(0, 10)}</span>` : ''}</p>
  `).join('')}
</div>

<div class="aside">
  <h4>Dobavljači po okvirnim sporazumima (djelimičan podatak)</h4>
  <p class="muted">Identitet dobavljača je dostupan samo za narudžbe po okvirnim sporazumima
  (${lotContractTotal.n} narudžbi, ${eur(lotContractTotal.total)} - obično oko petine ukupne
  potrošnje). Izvor ne objavljuje dobavljača za pojedinačne postupke
  (${eur(totals.total)} iznad) odvojeno od ovog mehanizma, pa ova lista ne predstavlja
  najveće dobavljače grada u cjelini.</p>
  <table>${suppliers.map(s => `<tr><td>${esc(s.name)}</td><td>${s.n} ugovora</td><td>${eur(s.total)}</td></tr>`).join('')}</table>
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
}

// Municipalities with at least one contracting authority pulled - drives the homepage
// list and lets a route 404 cleanly instead of rendering a page with zero data.
export function listAvailableMunicipalities() {
  return dbEjn.prepare(`
    SELECT c.name, COUNT(a.id) authorities
    FROM ejn_city c JOIN ejn_contracting_authority a ON a.city_id = c.id
    GROUP BY c.id HAVING authorities > 0
    ORDER BY c.name
  `).all();
}
