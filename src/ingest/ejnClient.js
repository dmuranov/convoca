// Thin client for open.ejn.gov.ba - see docs/ejn-api-notes.md for everything here being
// independently verified (the spec alone doesn't even give the base URL). No auth: none
// is required, confirmed live. Full OData v4: $filter/$orderby/$skip/$top/$count; server
// caps $top at 1000 (a request above that is HTTP 400, not silently truncated).
const BASE_URL = 'https://open.ejn.gov.ba';
// "Probe gently" (build brief §2.1) - the actual rate limit isn't characterized (see
// docs/ejn-api-notes.md's open questions), so this is a courtesy delay, not a measured
// safe rate.
const THROTTLE_MS = Number(process.env.EJN_THROTTLE_MS || 300);
const PAGE_SIZE = 1000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function ejnGet(collection, query) {
  const url = `${BASE_URL}/${collection}?${query}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`e-JN ${collection}: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  return res.json();
}

// Compound cursor (lastUpdated, lastId), not lastUpdated alone - see schema-ejn.sql's
// comment on ejn_sync_state for why a tie at the same timestamp would otherwise risk
// silently skipping a row at a page boundary. Ordering by (LastUpdated, Id) makes the
// pagination deterministic even while new rows are being written concurrently upstream -
// unlike $skip-based paging, which can skip or duplicate rows if the underlying data
// shifts between page fetches.
export async function fetchPage(collection, { lastUpdatedWm, lastIdWm }) {
  const filter = `LastUpdated gt ${lastUpdatedWm} or (LastUpdated eq ${lastUpdatedWm} and Id gt ${lastIdWm})`;
  const query = new URLSearchParams({
    '$filter': filter,
    '$orderby': 'LastUpdated,Id',
    '$top': String(PAGE_SIZE),
  });
  const json = await ejnGet(collection, query.toString());
  return json.value || [];
}

// Targeted single-record lookup, e.g. for the on-demand FK resolve in pollEjn.js. Not
// fetchPage() with a synthetic cursor: fetchPage orders by (LastUpdated, Id) for
// deterministic incremental walking, so seeding it with an arbitrary Id as the cursor
// would not return rows *near* that Id at all - a $filter=Id eq X is the actual lookup.
export async function fetchById(collection, id) {
  const query = new URLSearchParams({ '$filter': `Id eq ${id}` });
  const json = await ejnGet(collection, query.toString());
  return (json.value || [])[0] ?? null;
}

// Targeted lookup by an arbitrary field, e.g. "all links for this one supplier group" -
// for the cascading on-demand resolve in pollEjn.js (resolveSupplierGroupFk). Bounded to
// $top=1000 like everything else; a single supplier group realistically never has
// anywhere near that many consortium members, so no pagination loop is needed here.
export async function fetchByField(collection, field, value) {
  const query = new URLSearchParams({ '$filter': `${field} eq ${value}`, '$top': String(PAGE_SIZE) });
  const json = await ejnGet(collection, query.toString());
  return json.value || [];
}

export { THROTTLE_MS, PAGE_SIZE, sleep };
