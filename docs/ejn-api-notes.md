# e-JN (open.ejn.gov.ba) API notes — verified 2026-09-03

Written before any adapter code, per the FondBiH build brief's rule: no adapter gets
written against a URL nobody has fetched. Everything below was confirmed by actually
calling the API, not by reading the spec alone — the spec omits the base URL entirely,
and one endpoint the brief expected (`/FundingSources` as an EU-funding flag) turned out
to mean something else once queried.

## Base URL — not in the spec, had to be found empirically

`https://open.ejn.gov.ba/docs/v1/swagger.json` is an OpenAPI 3.0.4 doc with **no `servers`
array**. The docs page (`/docs/index.html`) is a stock, unconfigured Swagger UI (its
`swagger-initializer.js` still points at `petstore.swagger.io` — cosmetic only, ignore it).

The real base is the bare domain root, no path prefix at all:

```
https://open.ejn.gov.ba/<CollectionName>
```

Confirmed by probing candidates directly: `/api/...`, `/api/v1/...`, `/docs/v1/...`,
`/odata/...`, `/v1/...` are all 404. `https://open.ejn.gov.ba/AnnouncementProcedureNotices`
is 200. (The brief's own dead-source table already flagged `/api/v1/...` as a 404 -
confirmed why: there's no `/api` segment at all, not a version mismatch.)

## Auth

None. No `securitySchemes` anywhere in the spec, no `security` requirement on any
operation, confirmed live - every probe above succeeded with a bare `curl`, no key or
token sent.

## Pagination & filtering — full OData v4, verified working

Every collection takes standard OData query params: `$filter`, `$select`, `$orderby`,
`$skip`, `$top`, `$count`.

- Default page size (no `$top`): **50**.
- Max `$top`: **1000** - a request above that returns HTTP 400 with a clear message
  (`"The limit of '1000' for Top query has been exceeded"`). Page in chunks of 1000, not
  arbitrary numbers.
- `$count=true` works and adds `@odata.count` to the response - `AnnouncementProcedureNotices`
  alone is **619,802** rows total, confirming this must be incremental, never a full sync.
- `$filter=Announced ge 2026-09-01T00:00:00Z` (ISO 8601, URL-encoded) works and returns
  live, current-day data - confirmed against real rows from 2026-09-02/03.
- `$orderby=Announced desc` works.
- Every collection carries a `LastUpdated` field (server-side revision timestamp,
  independent of `Announced`) - **this is the field to use as the incremental high-water
  mark**, not `Announced`, mirroring why `pollLicitaciones.js` uses PLACSP's `updated_at`
  rather than a creation date: a record can be revised after its original announcement,
  and only `LastUpdated` reflects that.
- `$expand` is rejected outright (HTTP 400, `ODataQueryValidator` error) - no navigation
  properties are exposed this way. Don't attempt `$expand` in the adapter; join by ID
  lookups against the reference collections instead (see below).

## Locale

Every list endpoint's first query param is `ietfTag` (default `"bs-latn-ba"`). Untested
what other values do (`bs-cyrl-ba`? `hr-ba`? `sr-ba`?) - worth a quick probe before
deciding whether FondBiH needs to request a specific locale or can rely on the default.

## Endpoint confirmation (against the brief's table)

All endpoints in the brief's table exist, confirmed by path match against the spec's 127
paths. Every collection also has a `...Base` twin (lighter projection - not yet compared
field-by-field; assume it drops the deeply-optional fields seen below and prefer it for
list syncs once confirmed).

## The full record shape, and what it means for the data model

Every procurement-related entity (`AnnouncementProcedureNotices`, `Procedures`, `Awards`,
`AwardNotices`, `LotContracts`, `Lots`, `BiddingInvitations`, `NpsProcurementAwards`, ...)
carries the **same denormalized contracting-authority block** inline:

```
ContractingAuthorityId, ContractingAuthorityName, ContractingAuthorityTaxNumber,
ContractingAuthorityCityName, ContractingAuthorityType,
ContractingAuthorityActivityTypeName, ContractingAuthorityAdministrativeUnitType,
ContractingAuthorityAdministrativeUnitName
```

This means territory attribution for most rows **does not require a join at all** - the
administrative unit name/type is already on the row. The brief's plan to derive territory
from `/AdministrativeUnits` is still right for the *canonical, ID-based* version (names
can collide - see the ID-space gotcha below), but the denormalized fields are there for
display/filtering without waiting on a join, same spirit as how `licitacion_row` already
stores both the feed's raw `lugar` text and a derived `ccaa`.

`ContractingAuthorities` itself additionally carries `CityId`/`CityName` and
`AdministrativeUnitId`/`AdministrativeUnitName`/`AdministrativeUnitType` as real foreign
keys (not just denormalized text) - this is the actual join anchor into the reference
collections.

## Territory hierarchy - two collections, two independent ID spaces, same names

`/AdministrativeUnits` is a self-referencing tree: `Id`, `Name`, `HigherUnitId`,
`HigherUnitName`, `Type`. Confirmed `Type` values (sampled): `Country`, `Entity`,
`District` (Brčko), `Canton`, `City`, `Municipality`. Hierarchy depth varies by entity -
a Republika Srpska municipality's `HigherUnitId` points straight at the Entity (2 levels:
entitet → opština); a Federacija BiH municipality should point at a Canton first (3
levels: entitet → kanton → općina/grad) - **not yet confirmed with a live FBiH example,
worth checking before building the hierarchy sync.**

`/Cities` is a *separate*, flatter collection: `Id`, `Name`, `LocalizedName`, `CountryId`.
No `HigherUnitId`, no link back into `/AdministrativeUnits`.

**The gotcha, confirmed live and worth repeating because it fails silently:**
`ContractingAuthority.CityId` and `AdministrativeUnit.Id` are independent integer
sequences that happen to overlap in range. `CityId=71` resolves in `/Cities` to
**CAZIN**; the *same integer*, `Id=71` in `/AdministrativeUnits`, is **ŠIPOVO** - a
different municipality entirely. Confirmed:

```
GET /Cities?$filter=Id eq 71              -> {"Name":"CAZIN", ...}
GET /AdministrativeUnits?$filter=Id eq 71 -> {"Name":"ŠIPOVO", ...}
```

Never resolve a `CityId` against `/AdministrativeUnits`, or an `AdministrativeUnitId`
against `/Cities`, even though both collections contain a row for the same place under a
different `Id`. Keep them as two separate lookup tables with two separate foreign keys,
matching each field to the collection its name says it belongs to.

## Confirmed gap: no supplier/winning-bidder field anywhere in the award chain

The brief's example output ("Najveći dobavljač: [firma], N ugovora...") needs a link from
an award/contract to the winning supplier. **No such field exists** on any award-shaped
entity - checked the *full* schema (`components.schemas.AwardExtendedListDto`), not just
one sample's non-null fields, plus live samples of `/Awards`, `/AwardNotices`,
`/LotContracts`, `/NpsProcurementAwards`, `/BiddingInvitations`: none carry a
`SupplierId`/`SupplierName`-shaped property. `$expand=Supplier` is rejected outright.
`/ProcedureContractSummaries` (a plausible-sounding candidate) returns an empty set on an
unfiltered probe - untested whether it's populated for specific procedures, or dead.
`/Suppliers` and `/UnregisteredSuppliers` exist as reference collections but nothing
found points *into* them from an award row.

**This blocks the "biggest supplier" narrative as designed.** Before writing the
enrichment/aggregation code for that claim, one of:
1. Find the actual link (check `/ProcedureContractSummaries` with a real `ProcedureId`
   filter rather than unfiltered; check `/StandaloneExAnteNoticeAwards` and
   `/AnnualMasterAgreementAwardNotices`, not yet probed; check whether the *public*
   ejn.gov.ba web UI displays a winning supplier per contract - if the UI has it and the
   API doesn't, that's either a different endpoint not yet found or an HTML-only fact).
2. Drop the per-supplier aggregation from the v1 municipality-profile narrative and ship
   without it (spend/category/termination facts, all of which *are* confirmed available,
   stand fine on their own).
Do not build this feature by guessing a plausible-looking join.

## Correction to the brief: `/FundingSources` is not an EU-funding flag

The brief's endpoint table lists `/FundingSources` for "whether EU/IPA money is behind a
procedure." Live samples say otherwise - it's a **domestic budget line-item /
account-code classification**:

```
"613700 IZDACI ZA TEKUĆE ODRŽAVANJE"   (a BiH budget economic-classification code)
"Budžet Općine Novo Sarajevo za 2023. godinu"
"Vlastiti izvori"                       (own resources)
```

The actual EU-funding signal is a plain boolean already present on the award entities
themselves: **`EuFundsUsed`** (seen on `/Awards` and `/NpsProcurementAwards`). Use that
field directly; don't build a `/FundingSources` join for this purpose - it answers a
different question (how a purchase was budgeted domestically, not whether it was EU
money).

## Open questions for the next session, not yet resolved

- FBiH multi-level hierarchy (entitet → kanton → općina) not confirmed live - only an RS
  (2-level) example was sampled.
- `...Base` twins not compared field-by-field against their full counterparts.
- `ietfTag` locale values other than the default not probed.
- The supplier-link gap above - needs a decision before the enrichment/aggregation step
  in the build order (step 5), not before the ingest adapter (step 2) which doesn't need
  it.
- Rate-limit behavior not characterized (brief calls for "probe gently" - today's session
  made on the order of 20 light requests with no throttling observed, which is not the
  same as knowing the actual limit).
