// One-off, targeted pull for a single municipality - NOT part of the ongoing incremental
// sync (pollEjn.js's syncCollection/ejn_sync_state, which walks every collection globally).
// Build brief step 4: "a much smaller pull than the full backfill... Prijedor's
// contracting authorities, their notices and contracts for one year." Reuses pollEjn.js's
// upsert/self-heal functions so this writes into the exact same schema the general sync
// will eventually populate - no separate code path to keep in sync with that one.
//
// CityId, not AdministrativeUnitId, is the join for "what happened in this town" - see
// docs/ejn-api-notes.md's "Aggregating what did this town spend" section. A town can have
// more than one AdministrativeUnits row (Prijedor has two - City and Municipality tiers),
// and AdministrativeUnitId tracks which government tier funds an authority, not where it
// physically sits: Republika Srpska schools/hospitals/courts are Entity-funded but
// headquartered in the town, and the build brief's own narrative wants them counted.
//
// Skip-based pagination here (not the compound-cursor approach syncCollection uses) is a
// deliberate, narrower choice: this is a single bounded historical pull that runs to
// completion in one sitting, not an ongoing cursor revisited across many separate
// invocations - the drift risk $skip has on a live, continuously-written collection
// doesn't apply the same way to one short run over a fixed one-year window.
//
// Usage: node scripts/pullMunicipality.js [CITY_NAME] [SINCE_ISO]
import 'dotenv/config';
import { dbEjn } from '../src/dbEjn.js';
import { PAGE_SIZE, THROTTLE_MS, sleep } from '../src/ingest/ejnClient.js';
import {
  upsertAuthority, upsertNoticeRow, upsertAwardRow, upsertTerminationRow,
  upsertLotContract, resolveLotContractFks, upsertTerminationType,
} from '../src/ingest/pollEjn.js';

const BASE_URL = 'https://open.ejn.gov.ba';
const CITY_NAME = process.argv[2] || 'PRIJEDOR';
const SINCE = process.argv[3] || new Date(Date.now() - 365 * 86_400_000).toISOString();

async function ejnGet(collection, filter, extra = {}) {
  const query = new URLSearchParams({ '$filter': filter, '$top': String(PAGE_SIZE), ...extra });
  const res = await fetch(`${BASE_URL}/${collection}?${query}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`e-JN ${collection}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return (await res.json()).value || [];
}

// $skip-based, not the compound cursor - see file header for why that's acceptable here.
// Advances $skip by the page's ACTUAL length, not the requested $top/PAGE_SIZE, and
// stops only on a truly empty page - confirmed live 2026-09-03 that
// AnnouncementProcedureNotices/Awards silently cap at 50 rows regardless of $top (even
// $top=1000). Advancing by PAGE_SIZE=1000 against a server that only ever returns 50
// would skip 950 unseen rows every single page on those collections - not a small
// undercount, effectively "sees almost nothing." See pollEjn.js's syncCollection for the
// same fix, and docs/ejn-api-notes.md for the full finding.
async function fetchAllPages(collection, filter, orderby) {
  const all = [];
  let skip = 0;
  for (;;) {
    const page = await ejnGet(collection, filter, { '$orderby': orderby, '$skip': String(skip) });
    if (!page.length) break;
    all.push(...page);
    skip += page.length;
    await sleep(THROTTLE_MS);
  }
  return all;
}

// CountryId=27 (Bosna i Hercegovina) - confirmed live 2026-09-03 that Name eq is
// case-insensitive on this API ("PRIJEDOR" matches "Prijedor") and, more importantly,
// that place names collide across borders: a Croatian city is also literally named
// "Prijedor" (CountryId=48). Without this filter that ambiguity throws below instead of
// silently picking the wrong country's city - FondBiH only ever means the BiH one.
async function main() {
  // Small, stable reference table (6 rows total) that ejn_termination.type_id has a real
  // FK to - never synced by this script otherwise, and any termination with a non-null
  // TypeId would fail that constraint. Cheap enough to just always pull in full.
  const terminationTypes = await ejnGet('TerminationTypes', 'Id gt 0');
  console.log(`TerminationTypes: ${terminationTypes.length} row(s)`);
  for (const t of terminationTypes) upsertTerminationType.run(t);

  console.log(`Resolving city "${CITY_NAME}"...`);
  const cities = await ejnGet('Cities', `Name eq '${CITY_NAME}' and CountryId eq 27`);
  if (cities.length !== 1) {
    throw new Error(`expected exactly one BiH Cities match for "${CITY_NAME}", got ${cities.length} - resolve ambiguity before proceeding (see docs/ejn-api-notes.md)`);
  }
  const cityId = cities[0].Id;
  console.log(`City: ${cities[0].Name} (id ${cityId})`);

  const authorities = await fetchAllPages('ContractingAuthorities', `CityId eq ${cityId}`, 'Id');
  console.log(`Contracting authorities in ${CITY_NAME}: ${authorities.length}`);
  const applyAuthorities = dbEjn.transaction((rows) => { for (const a of rows) upsertAuthority(a); });
  applyAuthorities(authorities);

  const ids = authorities.map(a => a.Id);
  const inList = `(${ids.join(',')})`;

  for (const [collection, dateField, upsertRow] of [
    ['AnnouncementProcedureNotices', 'Announced', upsertNoticeRow],
    ['Awards', 'ContractDate', upsertAwardRow],
    ['Terminations', 'DecisionDate', upsertTerminationRow],
  ]) {
    const filter = `ContractingAuthorityId in ${inList} and ${dateField} ge ${SINCE}`;
    const rows = await fetchAllPages(collection, filter, 'Id');
    console.log(`${collection}: ${rows.length} row(s)`);
    const apply = dbEjn.transaction((rows) => { for (const r of rows) upsertRow(r); });
    apply(rows);
  }

  // Lot contracts need their FKs resolved (async) before the synchronous insert - same
  // beforeInsert-then-transaction shape as syncCollection, reused directly.
  const lcFilter = `ContractingAuthorityId in ${inList} and ContractDate ge ${SINCE}`;
  const lotContracts = await fetchAllPages('LotContractsBase', lcFilter, 'Id');
  console.log(`LotContractsBase: ${lotContracts.length} row(s)`);
  await resolveLotContractFks(lotContracts);
  const applyContracts = dbEjn.transaction((rows) => { for (const c of rows) upsertLotContract.run(c); });
  applyContracts(lotContracts);

  console.log('Done.');
}

// process.exitCode, not process.exit() - an immediate process.exit() right after an
// in-flight fetch/AbortSignal.timeout handle crashed Node's libuv on Windows here
// (UV_HANDLE_CLOSING assertion) - setting the exit code and letting the event loop drain
// naturally avoids racing that handle's own cleanup.
main().catch(e => { console.error('pullMunicipality failed:', e.message); process.exitCode = 1; });
