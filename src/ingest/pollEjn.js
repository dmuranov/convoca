// e-JN (open.ejn.gov.ba) ingest - FondBiH build brief step 2. See docs/ejn-api-notes.md
// for the API research this is built on; nothing here reaches for an endpoint or field
// that wasn't confirmed live first.
//
// Sync order is a dependency graph, not a list (build brief, 2026-09-03 review):
//   1. reference data (AdministrativeUnits, Cities, CpvCodes, TerminationTypes) - small,
//      changes rarely, nothing depends on anything else existing first.
//   2. contracting authorities - referenced by every notice/award/termination/contract.
//   3. notices, awards, terminations - all carry the *full* denormalized authority block
//      inline, so they self-heal contracting_authority_id from their own row if step 2
//      somehow hasn't seen it yet (see upsertAuthorityStub) - no queue needed for these.
//   4. suppliers, unregistered suppliers - referenced by the group-link tables.
//   5. supplier groups, then their supplier/unregistered-supplier links.
//   6. lot contracts - reference both an authority and a supplier group, but (unlike
//      notices/awards/terminations) carry no denormalized text for either, so a genuinely
//      missing one of either gets a single on-demand fetch instead - see
//      resolveAuthorityFk/resolveSupplierGroupFk.
//
// "A contract arriving before its authority exists should queue, not fail" - satisfied
// two different ways depending on whether the row itself carries enough to self-heal:
// steps 3-5 self-heal for free (the data's already on the row, including city and
// administrative-unit stubs off a full authority/supplier record - see upsertAuthority);
// step 6's two FKs, which aren't self-healable from the contract row alone, get a bounded
// one-off fetch instead of a persistent retry queue - simpler, and sufficient because
// steps 2 and 5 already run immediately before step 6 in the same invocation, so a
// genuine gap here should be rare (a race against e-JN's own live writes, not the normal
// case - confirmed live 2026-09-03 that the normal case truly is self-healing: a first
// real run hit exactly this gap on ContractingAuthorities' own city/administrative-unit
// FKs before that self-heal existed).
//
// Every collection's cursor is (lastUpdatedWm, lastIdWm), persisted after every page (not
// just at the end of a run) in ejn_sync_state - a crash mid-backfill resumes from the
// last completed page. The very first run for a collection starts at the table's default
// ('1900-01-01T00:00:00Z', 0), which makes backfill and steady-state incremental sync the
// same code path - there's no separate "initial load" mode to keep in sync with this one.
import { dbEjn, alertEjn as alert } from '../dbEjn.js';
import { fetchPage, fetchById, fetchByField, hasAnyRows, THROTTLE_MS, sleep } from './ejnClient.js';

// Cap on pages (1000 rows/page) pulled per collection per invocation. Deliberately small
// for the first real runs - drain a bounded sample, read the actual rows, then raise this
// once that's done, same pacing lesson as convoca's OPEN_TENDER_DRAIN_CAP. 619,802 total
// AnnouncementProcedureNotices alone means the full backfill will always span many runs
// regardless of this number; it only bounds how much happens in one invocation.
const PAGE_CAP = Number(process.env.EJN_PAGE_CAP || 5);

function getSyncState(collection) {
  const row = dbEjn.prepare('SELECT last_updated_wm, last_id_wm FROM ejn_sync_state WHERE collection = ?').get(collection);
  if (row) return row;
  dbEjn.prepare('INSERT INTO ejn_sync_state (collection) VALUES (?)').run(collection);
  return { last_updated_wm: '1900-01-01T00:00:00Z', last_id_wm: 0 };
}

const saveSyncState = dbEjn.prepare(`
  UPDATE ejn_sync_state SET last_updated_wm = ?, last_id_wm = ?,
    rows_synced = rows_synced + ?, updated_at = datetime('now')
  WHERE collection = ?
`);

// Generic runner: page through one collection via the compound cursor, applying
// `upsertRow` inside one transaction per page (a crash between pages loses at most one
// page of work, not the whole run - and the cursor only advances after the transaction
// commits, so a crash mid-page is retried, never skipped). `upsertRow` must be
// synchronous - better-sqlite3 transactions can't await. `beforeInsert(rows)`, if given,
// runs once per page *before* the transaction opens, for async work a row needs done
// first (e.g. lot contracts' on-demand supplier-group fetch) - keeps every DB write for
// the page inside one transaction while still allowing async prep ahead of it.
//
// "Caught up" is decided ONLY by an empty page, never by a short one - confirmed live
// 2026-09-03 that AnnouncementProcedureNotices and Awards silently cap at 50 rows
// regardless of $top (even $top=1000, the documented max), while SupplierGroups and
// LotContractsBase correctly return up to 1000. `rows.length < PAGE_SIZE` as a "no more
// data" signal was wrong for exactly the two highest-volume collections in this whole
// sync - every prior "(caught up)" log line for those two was false, silently pacing the
// backfill at ~50/run instead of up to 1000/page. This one-page-per-invocation floor was
// invisible until a targeted pull needed more than 50 rows and got the true count instead.
async function syncCollection(collection, upsertRow, { maxPages = PAGE_CAP, beforeInsert } = {}) {
  let { last_updated_wm: lastUpdatedWm, last_id_wm: lastIdWm } = getSyncState(collection);
  let pages = 0, totalSynced = 0, caughtUp = false;
  while (pages < maxPages) {
    const rows = await fetchPage(collection, { lastUpdatedWm, lastIdWm });
    if (!rows.length) { caughtUp = true; break; }
    if (beforeInsert) await beforeInsert(rows);
    const applyPage = dbEjn.transaction((rows) => { for (const row of rows) upsertRow(row); });
    applyPage(rows);
    const last = rows[rows.length - 1];
    lastUpdatedWm = last.LastUpdated;
    lastIdWm = last.Id;
    saveSyncState.run(lastUpdatedWm, lastIdWm, rows.length, collection);
    totalSynced += rows.length;
    pages++;
    await sleep(THROTTLE_MS);
  }
  console.log(`ejn sync ${collection}: ${totalSynced} row(s) over ${pages} page(s)${caughtUp ? ' (caught up)' : ' (page cap reached, more remain)'}`);
  return totalSynced;
}

// ---- reference data ----

// COALESCE, not a blind overwrite - both of these are also self-healed from other
// collections (a contracting authority's own CityId/AdministrativeUnitId, before the
// dedicated Cities/AdministrativeUnits sync has necessarily caught up to that specific
// row - see upsertAuthority below), same reasoning as upsertAuthorityFull. The dedicated
// sync's own values are always complete, so COALESCE costs it nothing; it only matters
// for a stub arriving before or after the real record.
const upsertAdministrativeUnit = dbEjn.prepare(`
  INSERT INTO ejn_administrative_unit (id, name, higher_unit_id, type, last_updated)
  VALUES (@Id, @Name, @HigherUnitId, @Type, @LastUpdated)
  ON CONFLICT(id) DO UPDATE SET
    name = COALESCE(excluded.name, ejn_administrative_unit.name),
    higher_unit_id = COALESCE(excluded.higher_unit_id, ejn_administrative_unit.higher_unit_id),
    type = COALESCE(excluded.type, ejn_administrative_unit.type),
    last_updated = excluded.last_updated
`);
function upsertAdministrativeUnitStub(id, name, type) {
  if (id == null) return;
  upsertAdministrativeUnit.run({ Id: id, Name: name, HigherUnitId: null, Type: type, LastUpdated: new Date().toISOString() });
}

const upsertCity = dbEjn.prepare(`
  INSERT INTO ejn_city (id, name, last_updated) VALUES (@Id, @Name, @LastUpdated)
  ON CONFLICT(id) DO UPDATE SET
    name = COALESCE(excluded.name, ejn_city.name),
    last_updated = excluded.last_updated
`);
function upsertCityStub(id, name) {
  if (id == null) return;
  upsertCity.run({ Id: id, Name: name, LastUpdated: new Date().toISOString() });
}
const upsertCpvCode = dbEjn.prepare(`
  INSERT INTO ejn_cpv_code (id, code, description, root_id, last_updated)
  VALUES (@Id, @Code, @Description, @RootId, @LastUpdated)
  ON CONFLICT(id) DO UPDATE SET code=excluded.code, description=excluded.description,
    root_id=excluded.root_id, last_updated=excluded.last_updated
`);
export const upsertTerminationType = dbEjn.prepare(`
  INSERT INTO ejn_termination_type (id, name, status, last_updated)
  VALUES (@Id, @Name, @Status, @LastUpdated)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name, status=excluded.status,
    last_updated=excluded.last_updated
`);

// ---- contracting authorities ----

// COALESCE against the existing row, not a blind overwrite: a stub upsert from a
// notice/award/termination's denormalized fields (see upsertAuthorityStub below) never
// carries city_id/administrative_unit_id - those numeric FKs only exist on the full
// /ContractingAuthorities record. Without COALESCE, a stub arriving after the real
// record would clobber good IDs with NULL.
const upsertAuthorityFull = dbEjn.prepare(`
  INSERT INTO ejn_contracting_authority
    (id, name, tax_number, city_id, city_name, type, activity_type_name,
     administrative_unit_id, administrative_unit_name, administrative_unit_type, last_updated)
  VALUES (@id, @name, @taxNumber, @cityId, @cityName, @type, @activityTypeName,
          @administrativeUnitId, @administrativeUnitName, @administrativeUnitType, @lastUpdated)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    tax_number = COALESCE(excluded.tax_number, ejn_contracting_authority.tax_number),
    city_id = COALESCE(excluded.city_id, ejn_contracting_authority.city_id),
    city_name = COALESCE(excluded.city_name, ejn_contracting_authority.city_name),
    type = COALESCE(excluded.type, ejn_contracting_authority.type),
    activity_type_name = COALESCE(excluded.activity_type_name, ejn_contracting_authority.activity_type_name),
    administrative_unit_id = COALESCE(excluded.administrative_unit_id, ejn_contracting_authority.administrative_unit_id),
    administrative_unit_name = COALESCE(excluded.administrative_unit_name, ejn_contracting_authority.administrative_unit_name),
    administrative_unit_type = COALESCE(excluded.administrative_unit_type, ejn_contracting_authority.administrative_unit_type),
    last_updated = excluded.last_updated
  WHERE excluded.last_updated > ejn_contracting_authority.last_updated
     OR ejn_contracting_authority.city_id IS NULL
`);

export function upsertAuthority(a) {
  // Self-heal city/administrative-unit from this record's own real numeric IDs, before
  // inserting the authority itself - the dedicated Cities/AdministrativeUnits syncs run
  // first in the overall order (step 1), but a specific city/unit id can still be missing
  // if that sync hasn't reached this particular row yet (its own incremental cursor is
  // independent of this one) - confirmed live 2026-09-03, this exact gap is what a first
  // real run's FOREIGN KEY constraint failed errors were.
  upsertCityStub(a.CityId, a.CityName);
  upsertAdministrativeUnitStub(a.AdministrativeUnitId, a.AdministrativeUnitName, a.AdministrativeUnitType);
  upsertAuthorityFull.run({
    id: a.Id, name: a.Name, taxNumber: a.TaxNumber ?? null,
    cityId: a.CityId ?? null, cityName: a.CityName ?? null,
    type: a.Type ?? null, activityTypeName: a.ActivityTypeName ?? null,
    administrativeUnitId: a.AdministrativeUnitId ?? null,
    administrativeUnitName: a.AdministrativeUnitName ?? null,
    administrativeUnitType: a.AdministrativeUnitType ?? null,
    lastUpdated: a.LastUpdated,
  });
}

// Self-heal from a notice/award/termination/etc.'s own denormalized ContractingAuthority*
// fields - no extra API call needed. city_id/administrative_unit_id are left null (this
// row never carries them); the COALESCE above means a later real /ContractingAuthorities
// sync fills them in without this stub ever regressing them once they exist.
function upsertAuthorityStub(row) {
  upsertAuthorityFull.run({
    id: row.ContractingAuthorityId, name: row.ContractingAuthorityName,
    taxNumber: row.ContractingAuthorityTaxNumber ?? null,
    cityId: null, cityName: row.ContractingAuthorityCityName ?? null,
    type: row.ContractingAuthorityType ?? null,
    activityTypeName: row.ContractingAuthorityActivityTypeName ?? null,
    administrativeUnitId: null,
    administrativeUnitName: row.ContractingAuthorityAdministrativeUnitName ?? null,
    administrativeUnitType: row.ContractingAuthorityAdministrativeUnitType ?? null,
    // Stub is a fallback, not a fresher fact than whatever's already stored - never regress
    // last_updated backwards, but still needs *a* value to satisfy the WHERE clause above
    // on a genuine first-insert (no existing row yet).
    lastUpdated: row.LastUpdated,
  });
}

// ---- suppliers ----

const upsertSupplier = dbEjn.prepare(`
  INSERT INTO ejn_supplier (id, name, tax_number, city_id, city_name, is_foreign, status, last_updated)
  VALUES (@Id, @Name, @TaxNumber, @CityId, @CityName, @IsForeign, @Status, @LastUpdated)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name, tax_number=excluded.tax_number,
    city_id=excluded.city_id, city_name=excluded.city_name, is_foreign=excluded.is_foreign,
    status=excluded.status, last_updated=excluded.last_updated
`);
function upsertSupplierRow(s) {
  upsertCityStub(s.CityId, s.CityName);
  upsertSupplier.run({ ...s, IsForeign: s.IsForeign ? 1 : 0 });
}

const upsertUnregisteredSupplier = dbEjn.prepare(`
  INSERT INTO ejn_unregistered_supplier (id, name, tax_number, city_id, city_name, is_foreign, last_updated)
  VALUES (@Id, @Name, @TaxNumber, @CityId, @CityName, @IsForeign, @LastUpdated)
  ON CONFLICT(id) DO UPDATE SET name=excluded.name, tax_number=excluded.tax_number,
    city_id=excluded.city_id, city_name=excluded.city_name, is_foreign=excluded.is_foreign,
    last_updated=excluded.last_updated
`);
function upsertUnregisteredSupplierRow(s) {
  upsertCityStub(s.CityId, s.CityName);
  upsertUnregisteredSupplier.run({
    Id: s.Id, Name: s.Name, TaxNumber: s.UniqueIdentificationNumber ?? null,
    CityId: s.CityId ?? null, CityName: s.CityName ?? null,
    IsForeign: s.IsForeign ? 1 : 0, LastUpdated: s.LastUpdated,
  });
}

// ---- supplier groups + links ----

const upsertSupplierGroup = dbEjn.prepare(`
  INSERT INTO ejn_supplier_group (id, is_awarded, lot_id, procedure_id, last_updated)
  VALUES (@Id, @IsAwarded, @LotId, @ProcedureId, @LastUpdated)
  ON CONFLICT(id) DO UPDATE SET is_awarded=excluded.is_awarded, lot_id=excluded.lot_id,
    procedure_id=excluded.procedure_id, last_updated=excluded.last_updated
`);
function upsertSupplierGroupRow(g) {
  upsertSupplierGroup.run({ ...g, IsAwarded: g.IsAwarded ? 1 : 0 });
}

const supplierGroupExists = dbEjn.prepare('SELECT 1 FROM ejn_supplier_group WHERE id = ?');

// Bounded fallback for the one FK that can't self-heal from the referencing row alone
// (lot contracts carry only the numeric SupplierGroupId, no denormalized group data -
// see docs/ejn-api-notes.md). Fetches the group by id (fetchById, not fetchPage - the
// cursor walk orders by (LastUpdated, Id), so seeding it with this id as a synthetic
// cursor would not return rows anywhere near it), THEN its own supplier/unregistered
// links directly (fetchByField) - confirmed live 2026-09-03 that skipping this second
// step leaves the group real but permanently supplier-less in practice: a group resolved
// only this far has no guarantee its own link row's (LastUpdated, Id) position will ever
// fall inside a normal SupplierGroupSupplierLinks page anytime soon, since that
// collection pages by its own watermark, independent of this one. A single group
// realistically has a handful of consortium members at most, so this is still one bounded
// lookup per resolve, not a cascade with unbounded depth - it terminates at suppliers,
// which have no further FK of their own to chase.
async function resolveSupplierGroupFk(id) {
  if (supplierGroupExists.get(id)) return;
  try {
    const match = await fetchById('SupplierGroups', id);
    if (!match) {
      alert('ejn_sync', `lot contract references SupplierGroup ${id}, not found on lookup - leaving FK unresolved this run`);
      return;
    }
    upsertSupplierGroupRow(match);
    const [regLinks, unregLinks] = await Promise.all([
      fetchByField('SupplierGroupSupplierLinks', 'SupplierGroupId', id),
      fetchByField('SupplierGroupUnregisteredSupplierLinks', 'SupplierGroupId', id),
    ]);
    for (const l of regLinks) {
      await resolveSupplierFk(l.SupplierId);
      upsertSupplierGroupSupplierLinkRow(l);
    }
    for (const l of unregLinks) {
      await resolveUnregisteredSupplierFk(l.UnregisteredSupplierId);
      upsertSupplierGroupUnregisteredLinkRow(l);
    }
  } catch (e) {
    alert('ejn_sync', `on-demand SupplierGroup ${id} fetch failed: ${e.message}`);
  }
}

const authorityExists = dbEjn.prepare('SELECT 1 FROM ejn_contracting_authority WHERE id = ?');

// Same treatment as resolveSupplierGroupFk, for the same reason - LotContractsBase
// carries neither denormalized authority text nor a supplier-group's worth of detail, so
// it's the one entity in this whole sync that can't self-heal either of its FKs from its
// own row. Reuses upsertAuthority, which also self-heals city/administrative-unit.
async function resolveAuthorityFk(id) {
  if (authorityExists.get(id)) return;
  try {
    const match = await fetchById('ContractingAuthorities', id);
    if (match) upsertAuthority(match);
    else alert('ejn_sync', `lot contract references ContractingAuthority ${id}, not found on lookup - leaving FK unresolved this run`);
  } catch (e) {
    alert('ejn_sync', `on-demand ContractingAuthority ${id} fetch failed: ${e.message}`);
  }
}

const supplierExists = dbEjn.prepare('SELECT 1 FROM ejn_supplier WHERE id = ?');
const unregisteredSupplierExists = dbEjn.prepare('SELECT 1 FROM ejn_unregistered_supplier WHERE id = ?');

// Same shape of gap as lot contracts, confirmed live 2026-09-03: the link tables carry
// only numeric ids, no denormalized name/text, and SupplierGroups/Suppliers/
// UnregisteredSuppliers each page independently by their own watermark - "runs right
// before it in this invocation" does NOT mean "covers the same rows," since a link's
// target can easily fall outside whichever page of the parent collection was pulled this
// time. Every FK on these two link tables gets the same on-demand, bounded resolve.
async function resolveSupplierFk(id) {
  if (supplierExists.get(id)) return;
  try {
    const match = await fetchById('Suppliers', id);
    if (match) upsertSupplierRow(match);
    else alert('ejn_sync', `supplier group link references Supplier ${id}, not found on lookup`);
  } catch (e) {
    alert('ejn_sync', `on-demand Supplier ${id} fetch failed: ${e.message}`);
  }
}
async function resolveUnregisteredSupplierFk(id) {
  if (unregisteredSupplierExists.get(id)) return;
  try {
    const match = await fetchById('UnregisteredSuppliers', id);
    if (match) upsertUnregisteredSupplierRow(match);
    else alert('ejn_sync', `supplier group link references UnregisteredSupplier ${id}, not found on lookup`);
  } catch (e) {
    alert('ejn_sync', `on-demand UnregisteredSupplier ${id} fetch failed: ${e.message}`);
  }
}
async function resolveSupplierLinkFks(rows) {
  for (const l of rows) {
    if (l.SupplierGroupId != null) await resolveSupplierGroupFk(l.SupplierGroupId);
    if (l.SupplierId != null) await resolveSupplierFk(l.SupplierId);
  }
}
async function resolveUnregisteredSupplierLinkFks(rows) {
  for (const l of rows) {
    if (l.SupplierGroupId != null) await resolveSupplierGroupFk(l.SupplierGroupId);
    if (l.UnregisteredSupplierId != null) await resolveUnregisteredSupplierFk(l.UnregisteredSupplierId);
  }
}

const upsertSupplierGroupSupplierLink = dbEjn.prepare(`
  INSERT INTO ejn_supplier_group_supplier_link (id, supplier_group_id, supplier_id, is_lead, last_updated)
  VALUES (@Id, @SupplierGroupId, @SupplierId, @IsLead, @LastUpdated)
  ON CONFLICT(id) DO UPDATE SET is_lead=excluded.is_lead, last_updated=excluded.last_updated
`);
function upsertSupplierGroupSupplierLinkRow(l) {
  upsertSupplierGroupSupplierLink.run({ ...l, IsLead: l.IsLead ? 1 : 0 });
}

const upsertSupplierGroupUnregisteredLink = dbEjn.prepare(`
  INSERT INTO ejn_supplier_group_unregistered_link (id, supplier_group_id, unregistered_supplier_id, is_lead, last_updated)
  VALUES (@Id, @SupplierGroupId, @UnregisteredSupplierId, @IsLead, @LastUpdated)
  ON CONFLICT(id) DO UPDATE SET is_lead=excluded.is_lead, last_updated=excluded.last_updated
`);
function upsertSupplierGroupUnregisteredLinkRow(l) {
  upsertSupplierGroupUnregisteredLink.run({ ...l, IsLead: l.IsLead ? 1 : 0 });
}

// ---- notices, awards, terminations ----

const upsertNotice = dbEjn.prepare(`
  INSERT INTO ejn_notice (id, number, contracting_authority_id, procedure_id, procedure_name,
    procedure_number, procedure_type, contract_type, contract_category_name,
    contract_subcategory_name, has_lots, award_criterion, announced, last_updated)
  VALUES (@Id, @Number, @ContractingAuthorityId, @ProcedureId, @ProcedureName,
    @ProcedureNumber, @ProcedureType, @ContractType, @ContractCategoryName,
    @ContractSubcategoryName, @HasLots, @AwardCriterion, @Announced, @LastUpdated)
  ON CONFLICT(id) DO UPDATE SET number=excluded.number, procedure_name=excluded.procedure_name,
    procedure_type=excluded.procedure_type, contract_type=excluded.contract_type,
    contract_category_name=excluded.contract_category_name, has_lots=excluded.has_lots,
    award_criterion=excluded.award_criterion, last_updated=excluded.last_updated
`);
export function upsertNoticeRow(n) {
  upsertAuthorityStub(n);
  upsertNotice.run({ ...n, HasLots: n.HasLots ? 1 : 0 });
}

const upsertAward = dbEjn.prepare(`
  INSERT INTO ejn_award (id, contracting_authority_id, procedure_id, procedure_name,
    lot_name, value, contract_date, contract_type, contract_category_name,
    eu_funds_used, is_contract_concluded, is_master_agreement, last_updated)
  VALUES (@Id, @ContractingAuthorityId, @ProcedureId, @ProcedureName, @LotName, @Value,
    @ContractDate, @ContractType, @ContractCategoryName, @EuFundsUsed,
    @IsContractConcluded, @IsMasterAgreement, @LastUpdated)
  ON CONFLICT(id) DO UPDATE SET value=excluded.value, contract_date=excluded.contract_date,
    eu_funds_used=excluded.eu_funds_used, is_contract_concluded=excluded.is_contract_concluded,
    is_master_agreement=excluded.is_master_agreement, last_updated=excluded.last_updated
`);
export function upsertAwardRow(a) {
  upsertAuthorityStub(a);
  upsertAward.run({
    ...a,
    EuFundsUsed: a.EuFundsUsed ? 1 : 0,
    IsContractConcluded: a.IsContractConcluded ? 1 : 0,
    IsMasterAgreement: a.IsMasterAgreement ? 1 : 0,
  });
}

const upsertTermination = dbEjn.prepare(`
  INSERT INTO ejn_termination (id, contracting_authority_id, procedure_id, procedure_name,
    lot_name, contract_type, contract_category_name, type_id, type_name, decision_date,
    additional_information, reasons, last_updated)
  VALUES (@Id, @ContractingAuthorityId, @ProcedureId, @ProcedureName, @LotName,
    @ContractType, @ContractCategoryName, @TypeId, @TypeName, @DecisionDate,
    @AdditionalInformation, @Reasons, @LastUpdated)
  ON CONFLICT(id) DO UPDATE SET type_id=excluded.type_id, type_name=excluded.type_name,
    additional_information=excluded.additional_information, reasons=excluded.reasons,
    last_updated=excluded.last_updated
`);
export function upsertTerminationRow(t) {
  upsertAuthorityStub(t);
  upsertTermination.run(t);
}

// ---- lot contracts (needs both an authority and a supplier group to exist) ----

export const upsertLotContract = dbEjn.prepare(`
  INSERT INTO ejn_lot_contract (id, contracting_authority_id, supplier_group_id, value, contract_date, last_updated)
  VALUES (@Id, @ContractingAuthorityId, @SupplierGroupId, @Value, @ContractDate, @LastUpdated)
  ON CONFLICT(id) DO UPDATE SET value=excluded.value, contract_date=excluded.contract_date,
    last_updated=excluded.last_updated
`);

// LotContractsBase carries no denormalized authority/supplier text at all (unlike
// notices/awards/terminations) - it's just IDs, so it's the one entity in this whole sync
// that can't self-heal either FK from its own row. Both get the bounded on-demand
// resolve, run as this page's beforeInsert hook (async, so it must happen before the
// synchronous insert transaction - see syncCollection) rather than inside the per-row
// upsert itself. In practice the authority almost always already exists (contracting
// authorities sync runs first, step 2) and this is a no-op lookup; it's not skipped
// outright because "almost always" isn't "always" - see resolveAuthorityFk.
export async function resolveLotContractFks(rows) {
  for (const c of rows) {
    if (c.ContractingAuthorityId != null) await resolveAuthorityFk(c.ContractingAuthorityId);
    if (c.SupplierGroupId != null) await resolveSupplierGroupFk(c.SupplierGroupId);
  }
}

// ---- orchestration ----

export async function pollEjnOnce() {
  const results = {};
  const stage = async (name, fn) => {
    try { results[name] = await fn(); }
    catch (e) { alert('ejn_sync', `${name}: ${e.message}`); results[name] = 0; }
  };

  // 1. reference data
  await stage('AdministrativeUnits', () => syncCollection('AdministrativeUnits', (r) => upsertAdministrativeUnit.run(r)));
  await stage('Cities', () => syncCollection('Cities', (r) => upsertCity.run(r)));
  await stage('CpvCodes', () => syncCollection('CpvCodes', (r) => upsertCpvCode.run(r)));
  await stage('TerminationTypes', () => syncCollection('TerminationTypes', (r) => upsertTerminationType.run(r)));

  // 2. contracting authorities
  await stage('ContractingAuthorities', () => syncCollection('ContractingAuthorities', upsertAuthority));

  // 3. notices, awards, terminations - self-heal authority FK from their own row
  await stage('AnnouncementProcedureNotices', () => syncCollection('AnnouncementProcedureNotices', upsertNoticeRow));
  await stage('Awards', () => syncCollection('Awards', upsertAwardRow));
  await stage('Terminations', () => syncCollection('Terminations', upsertTerminationRow));

  // 4. suppliers
  await stage('Suppliers', () => syncCollection('Suppliers', upsertSupplierRow));
  await stage('UnregisteredSuppliers', () => syncCollection('UnregisteredSuppliers', upsertUnregisteredSupplierRow));

  // 5. supplier groups, then their links
  await stage('SupplierGroups', () => syncCollection('SupplierGroups', upsertSupplierGroupRow));
  await stage('SupplierGroupSupplierLinks', () => syncCollection('SupplierGroupSupplierLinks', upsertSupplierGroupSupplierLinkRow, {
    beforeInsert: resolveSupplierLinkFks,
  }));
  await stage('SupplierGroupUnregisteredSupplierLinks', () => syncCollection('SupplierGroupUnregisteredSupplierLinks', upsertSupplierGroupUnregisteredLinkRow, {
    beforeInsert: resolveUnregisteredSupplierLinkFks,
  }));

  // 6. lot contracts - neither FK self-heals from this row, both resolve on demand
  await stage('LotContractsBase', () => syncCollection('LotContractsBase', (r) => upsertLotContract.run(r), {
    beforeInsert: resolveLotContractFks,
  }));

  // Watch for the Agency ever populating /ProcedureContractSummaries - confirmed empty
  // API-wide 2026-09-03 (see docs/ejn-api-notes.md), but if it stops being empty, one-off
  // award supplier attribution becomes possible and the municipality page's whole
  // "supplier data only covers framework agreements" framing needs revisiting. One cheap
  // request per poll cycle costs nothing; finding out months late would not.
  try {
    if (await hasAnyRows('ProcedureContractSummaries')) {
      alert('ejn_sync', 'ProcedureContractSummaries now has data (was empty API-wide as of 2026-09-03) - re-check docs/ejn-api-notes.md and buildMunicipalityPage.js supplier attribution scope');
    }
  } catch (e) {
    alert('ejn_sync', `ProcedureContractSummaries watch check failed: ${e.message}`);
  }

  console.log('ejn poll done:', JSON.stringify(results));
  return results;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  pollEjnOnce()
    .then(() => process.exit(0))
    .catch(e => { alert('ejn_sync', e.message); process.exit(1); });
}
