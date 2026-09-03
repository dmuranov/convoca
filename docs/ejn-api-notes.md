# e-JN (open.ejn.gov.ba) API notes — verified 2026-09-03

Written before any adapter code, per the FondBiH build brief's rule: no adapter gets
written against a URL nobody has fetched. Everything below was confirmed by actually
calling the API, not by reading the spec alone — the spec omits the base URL entirely,
one endpoint the brief expected (`/FundingSources` as an EU-funding flag) turned out to
mean something else once queried, and a "confirmed gap" in this doc's first draft (no
supplier link on any award) turned out to be a wrong DTO choice, not a missing feature -
see the supplier-chain section below.

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

## Supplier chain — RESOLVED, not a gap (corrected from an earlier draft of this doc)

First pass (checking `/Awards`, `/AwardNotices`, `/LotContracts` and their full schemas)
found no supplier field and concluded this blocked the "biggest supplier" narrative. That
was wrong, caught on review: a BiH winning bid is frequently a **grupa ponuđača**
(consortium), so the winner is a *supplier group*, not a single supplier - which is
exactly why `/SupplierGroups`, `/SupplierGroupSupplierLinks`, and
`/SupplierGroupUnregisteredSupplierLinks` exist. The award-shaped entities never needed a
supplier field; they need a supplier-*group* field, and that field is real, just not on
the DTO variant checked first.

**The chain, confirmed live end to end with real, current-day data:**

```
LotContractsBase.SupplierGroupId
  -> SupplierGroups (Id, IsAwarded, LotId)
    -> SupplierGroupSupplierLinks (SupplierGroupId, SupplierId, IsLead)
         -> Suppliers (Name, TaxNumber, City, ...)               [registered path]
    -> SupplierGroupUnregisteredSupplierLinks (SupplierGroupId, UnregisteredSupplierId, IsLead)
         -> UnregisteredSuppliers (Name, TaxNumber, City, ...)   [unregistered path]
```

Verified against two real contracts:
- `LotContractsBase` id 291904 (2015) -> `SupplierGroupId` 1451385 -> `SupplierGroups`
  (`IsAwarded: true`) -> empty on `SupplierGroupSupplierLinks`, but
  `SupplierGroupUnregisteredSupplierLinks` resolves to `UnregisteredSuppliers` id 44292 =
  **"ASA PVA d.o.o. Sarajevo"** (a normal domestic company, `IsForeign: false`).
- `LotContractsBase` id 1014641, contract dated **2026-09-01** (yesterday relative to this
  research) -> `SupplierGroupId` 2454845 -> `SupplierGroups` (`IsAwarded: true`) ->
  `SupplierGroupSupplierLinks` resolves to `Suppliers` id 50542 = **"MUSIC COMPANY"**
  (Hadžići, active status, full contact/address record).

**The critical gotcha for the adapter: `/LotContracts` (the "Extended" DTO) drops
`SupplierGroupId`; `/LotContractsBase` (the plain "List" DTO) keeps it.** This inverts the
usual assumption that "Base" means "fewer fields, safe to ignore for anything but a quick
list sync" - here, Base carries a foreign key that Extended trades away in favor of
denormalized display text. **Always sync `/LotContractsBase`, not `/LotContracts`, for
anything that needs the supplier chain.** Whether the same asymmetry holds for other
Base/Extended pairs (`Awards`/`AwardsBase`, etc.) is not yet checked - don't assume Base
is strictly a subset of Extended's fields anywhere in this API without verifying per pair.

**Correction to a second guess, also caught on review:** `UnregisteredSuppliers` does not
mean "foreign or shell" - the example above is a normal Bosnian d.o.o. with a valid tax
number, explicitly `IsForeign: false`. "Unregistered" more likely means "no e-JN portal
user account" (e.g. a bid submitted on paper rather than through the electronic system),
not a shell-company signal. Don't build any "flag foreign/opaque suppliers" logic on top
of the registered/unregistered split without independently confirming what it actually
denotes.

**Not yet checked:** whether `SupplierGroupSupplierLinks` and
`SupplierGroupUnregisteredSupplierLinks` are ever both populated for the same
`SupplierGroupId` (a mixed consortium of registered + unregistered members) - the
aggregation code should query both and union the results rather than assuming a group is
entirely one or the other. `/AuctionParticipations` and `/BiddingInvitations` (the
"who bid," not just "who won" fallback the reviewer suggested) weren't needed once this
chain resolved, so they remain unprobed - fine to leave that way unless the primary chain
turns out to have coverage gaps once run at volume.

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

## Aggregating "what did this town spend" - use CityId, not AdministrativeUnitId

Found while scoping the Prijedor page (2026-09-03), and it generalizes to every
municipality: **a town can have more than one `AdministrativeUnits` row**, and
`AdministrativeUnitId` answers a different question than "is this authority in this town."

Confirmed live: Prijedor has *two* AdministrativeUnits records - `Id=17` (`Type: "City"`)
and `Id=54` (`Type: "Municipality"`, `HigherUnitId: 17` - nested *under* the City record).
`ContractingAuthorities` filtered by `AdministrativeUnitId eq 17` returns 29 authorities;
`eq 54` returns 3 more (32 total). Filtered by `CityId eq 13` (Cities' one, unambiguous
Prijedor row) returns **55**. The missing 23 aren't a data gap - they're authorities whose
`AdministrativeUnitId` points to `Republika Srpska` (the Entity) directly, because in RS
schools/hospitals/courts are Entity-funded, not municipal, even though physically
headquartered in the town. `AdministrativeUnitId` reflects *whose budget governs this
authority*, not *where it sits* - a different, real distinction, not a bug.

**For a municipality profile page ("what happened in my town"), CityId is the correct
join.** The build brief's own target narrative explicitly wants school heating counted as
part of a town's story - that's Entity-funded in RS, so joining on AdministrativeUnitId
would silently exclude it. AdministrativeUnitId is still the right key for a *different*
future feature (an entity/canton-level rollup page, where "which government tier" is
exactly the question) - the two join keys serve two different page types, not one
"correct" and one "wrong."

Also checked: only one `Cities` row exists for Prijedor (no Latin/Cyrillic duplicate on
that side) - script variation only shows up in individual authority *names* (e.g. "ЈУ
ОСНОВНА ШКОЛА" among Prijedor's own authorities), which is a rendering concern, not a
join-correctness one.

## $top is silently capped at 50 on most "Extended" collections - a real pagination bug this caused, now fixed

Found scoping the Prijedor pull (2026-09-03): requesting `$top=1000` on
`AnnouncementProcedureNotices`, `Awards`, `Terminations`, `ContractingAuthorities`,
`AdministrativeUnits`, `Cities`, `CpvCodes`, `Suppliers`, and `UnregisteredSuppliers` all
silently return **50 rows regardless of the requested `$top`** - not an error, just a
quiet ceiling. `LotContractsBase`, `SupplierGroups`, `SupplierGroupSupplierLinks`, and
`SupplierGroupUnregisteredSupplierLinks` correctly return up to the documented max of
1000. The pattern correlates with the Extended/Base split: every capped collection above
is the *default-named* ("Extended") variant; each has a `...Base` twin that does honor
`$top=1000`.

**This was a live bug in `pollEjn.js`, not just a research curiosity.** `syncCollection`'s
"caught up" check was `rows.length < PAGE_SIZE` (PAGE_SIZE=1000) - on every capped
collection this is *always* true (they never return more than 50), so every prior sync
run logged "(caught up)" and stopped after one page, regardless of how much more data
actually existed. `AnnouncementProcedureNotices` alone has 619,802 rows; every backfill
run to date fetched at most 50 of them per invocation and incorrectly believed it was
done. Not a data-loss bug (the watermark still advances correctly by whatever 50 it did
get, so the next run picks up where it left off) - a throughput/pacing bug: the effective
page size for these collections is 50, not 1000, so a given `EJN_PAGE_CAP` (a *count of
requests*) now does ~1/20th the work per invocation on capped collections that it does on
uncapped ones. **Fixed** in `syncCollection`: "caught up" is now decided only by a truly
*empty* page, never a short one - this is correct regardless of which cap (or none) the
server applies to a given collection, so no per-collection special-casing was needed.

**Why the fix isn't "just switch everything to the Base variant that honors $top"**:
checked every Base twin's actual field list against what the sync depends on, not just
whether $top works. `AwardsBase` has **no `contractingAuthorityId` field at all** -
confirmed live, not just from the schema - only `NoticeId`, and direct/negotiated awards
routinely have `NoticeId: null` (confirmed earlier in this same doc). Switching Awards to
its Base variant would silently break authority attribution for exactly that category of
award, with no recovery path. `AnnouncementProcedureNoticesBase` similarly drops every
denormalized `ContractingAuthority*` field the self-heal in `upsertAuthorityStub` depends
on. The Base/Extended split isn't "Base is always safe and faster" (as the LotContracts
case first suggested) - each pair needs checking on its own; some Base variants are a
safe, faster substitute (LotContracts, and likely ContractingAuthorities/
AdministrativeUnits/Cities/CpvCodes/Suppliers, not yet individually re-verified for field
completeness against what pollEjn.js reads), others would quietly remove the one field
a whole feature depends on.

## Open questions for the next session, not yet resolved

- FBiH multi-level hierarchy (entitet → kanton → općina) not confirmed live - only an RS
  (2-level) example was sampled.
- `...Base` twins now checked for `LotContracts` (Base wins - has the FK Extended drops)
  and `Awards`/`AnnouncementProcedureNotices` (Extended wins - Base drops
  contractingAuthorityId or the whole denormalized authority block; see the $top-cap
  section above). Still unchecked: `Terminations`, `ContractingAuthorities`,
  `AdministrativeUnits`, `Cities`, `CpvCodes`, `Suppliers`, `UnregisteredSuppliers` - all
  confirmed capped at 50 on the Extended side, but not yet verified whether their Base
  twin keeps every field pollEjn.js currently reads before switching any of them over.
- `ietfTag` locale values other than the default not probed.
- Whether `SupplierGroupSupplierLinks` and `SupplierGroupUnregisteredSupplierLinks` can
  both be populated for one `SupplierGroupId` (mixed consortium) - query both, don't
  assume either/or.
- Rate-limit behavior not characterized (brief calls for "probe gently" - today's session
  made on the order of 30 light requests across two sittings with no throttling observed,
  which is not the same as knowing the actual limit).
