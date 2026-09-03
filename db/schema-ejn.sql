-- FondBiH / e-JN schema - SQLite, separate database from convoca.sqlite (see build
-- brief §0: "second deployment of the same repo... separate DB"). Mirrors
-- open.ejn.gov.ba's own integer IDs directly - no UUID translation layer, so a row's id
-- here is always the same id you'd see querying the API directly, which makes debugging
-- and idempotent upserts (INSERT ... ON CONFLICT) straightforward. See
-- docs/ejn-api-notes.md for the source API's shape, gotchas, and verified findings -
-- every FK relationship (and the two deliberate non-relationships) below traces back to
-- something confirmed live there, not assumed from the OpenAPI spec.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Own alert table, deliberately not convoca's ingest_alert - this is a separate
-- deployment with a separate DB (see above); an alert() that wrote into convoca.sqlite
-- would either target a database this deployment doesn't have, or silently mix FondBiH's
-- operational alerts into the Spain operator console. Same shape as convoca's for the
-- pattern to stay familiar, not because the tables should ever be the same one.
CREATE TABLE IF NOT EXISTS ingest_alert (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  source      TEXT NOT NULL,
  message     TEXT NOT NULL,
  resolved    INTEGER NOT NULL DEFAULT 0
);

-- ---- reference / lookup tables: small, synced first, change rarely ----

CREATE TABLE IF NOT EXISTS ejn_administrative_unit (
  id                INTEGER PRIMARY KEY,
  name              TEXT NOT NULL,
  higher_unit_id    INTEGER REFERENCES ejn_administrative_unit(id),
  type              TEXT NOT NULL CHECK (type IN
                      ('Country','Entity','District','Canton','City','Municipality')),
  last_updated      TEXT NOT NULL
);

-- Deliberately NOT the same key space as ejn_administrative_unit, and never joined to it -
-- confirmed live (docs/ejn-api-notes.md): CityId=71 is Cazin here, AdministrativeUnits
-- id=71 is a different municipality (Šipovo). Two independent integer sequences that
-- happen to overlap in range.
CREATE TABLE IF NOT EXISTS ejn_city (
  id                INTEGER PRIMARY KEY,
  name              TEXT NOT NULL,
  last_updated      TEXT NOT NULL
);

-- root_id is deliberately NOT a FK, unlike everything else in this file: it's a
-- self-reference within a single collection's own sync, so a child code can land on the
-- same page as its root in either order (the API orders by LastUpdated/Id, not by
-- hierarchy) - enforcing it would mean sorting every page by dependency for a purely
-- cosmetic taxonomy tree with no real safety value. Confirmed live 2026-09-03: this
-- exact ordering issue is what a first real run hit before this comment existed.
CREATE TABLE IF NOT EXISTS ejn_cpv_code (
  id                INTEGER PRIMARY KEY,
  code              TEXT NOT NULL,
  description       TEXT,
  root_id           INTEGER,
  last_updated      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ejn_termination_type (
  id                INTEGER PRIMARY KEY,
  name              TEXT NOT NULL,
  status            TEXT,
  last_updated      TEXT NOT NULL
);

-- ---- contracting authorities ----

CREATE TABLE IF NOT EXISTS ejn_contracting_authority (
  id                          INTEGER PRIMARY KEY,
  name                        TEXT NOT NULL,
  tax_number                  TEXT,
  city_id                     INTEGER REFERENCES ejn_city(id),
  city_name                   TEXT,
  type                        TEXT,
  activity_type_name          TEXT,
  administrative_unit_id      INTEGER REFERENCES ejn_administrative_unit(id),
  administrative_unit_name    TEXT,
  administrative_unit_type    TEXT,
  last_updated                TEXT NOT NULL
);

-- ---- suppliers (two parallel tables - see docs/ejn-api-notes.md: "unregistered" means
-- no e-JN portal account, e.g. a paper bid, not foreign/shell - confirmed live against a
-- normal domestic d.o.o. with IsForeign=false) ----

CREATE TABLE IF NOT EXISTS ejn_supplier (
  id                INTEGER PRIMARY KEY,
  name              TEXT NOT NULL,
  tax_number        TEXT,
  city_id           INTEGER REFERENCES ejn_city(id),
  city_name         TEXT,
  is_foreign        INTEGER NOT NULL DEFAULT 0,
  status            TEXT,
  last_updated      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ejn_unregistered_supplier (
  id                INTEGER PRIMARY KEY,
  name              TEXT NOT NULL,
  tax_number        TEXT,
  city_id           INTEGER REFERENCES ejn_city(id),
  city_name         TEXT,
  is_foreign        INTEGER NOT NULL DEFAULT 0,
  last_updated      TEXT NOT NULL
);

-- ---- notices, awards, terminations - all carry the full denormalized authority block
-- from the API, so contracting_authority_id can always be self-healed from the same row
-- that references it (see pollEjn.js's upsertAuthorityStub) - no queue needed for these ----

CREATE TABLE IF NOT EXISTS ejn_notice (
  id                          INTEGER PRIMARY KEY,
  number                      TEXT,
  contracting_authority_id    INTEGER NOT NULL REFERENCES ejn_contracting_authority(id),
  procedure_id                INTEGER,
  procedure_name              TEXT,
  procedure_number            TEXT,
  procedure_type              TEXT,
  contract_type               TEXT,
  contract_category_name      TEXT,
  contract_subcategory_name   TEXT,
  has_lots                    INTEGER NOT NULL DEFAULT 0,
  award_criterion             TEXT,
  announced                   TEXT,
  last_updated                TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ejn_notice_authority ON ejn_notice(contracting_authority_id);

CREATE TABLE IF NOT EXISTS ejn_award (
  id                          INTEGER PRIMARY KEY,
  contracting_authority_id    INTEGER NOT NULL REFERENCES ejn_contracting_authority(id),
  procedure_id                INTEGER,
  procedure_name              TEXT,
  lot_name                    TEXT,
  value                       REAL,
  contract_date               TEXT,
  contract_type               TEXT,
  contract_category_name      TEXT,
  eu_funds_used                INTEGER NOT NULL DEFAULT 0,
  is_contract_concluded       INTEGER NOT NULL DEFAULT 0,
  last_updated                TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ejn_award_authority ON ejn_award(contracting_authority_id);

CREATE TABLE IF NOT EXISTS ejn_termination (
  id                          INTEGER PRIMARY KEY,
  contracting_authority_id    INTEGER NOT NULL REFERENCES ejn_contracting_authority(id),
  procedure_id                INTEGER,
  procedure_name              TEXT,
  lot_name                    TEXT,
  contract_type               TEXT,
  contract_category_name      TEXT,
  type_id                     INTEGER REFERENCES ejn_termination_type(id),
  type_name                   TEXT,
  decision_date                TEXT,
  additional_information      TEXT,
  last_updated                TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ejn_termination_authority ON ejn_termination(contracting_authority_id);

-- ---- the supplier-group chain (see docs/ejn-api-notes.md for the full verified trace):
-- LotContract.supplier_group_id -> SupplierGroup -> {supplier_link | unregistered_link}
-- -> {ejn_supplier | ejn_unregistered_supplier}. Neither LotContract nor SupplierGroup
-- carries denormalized authority/supplier text, so these two are the ones that actually
-- need the on-demand single-record fetch in pollEjn.js when a FK target is missing -
-- everything above this comment self-heals from its own row's denormalized fields. ----

CREATE TABLE IF NOT EXISTS ejn_supplier_group (
  id                INTEGER PRIMARY KEY,
  is_awarded        INTEGER NOT NULL DEFAULT 0,
  -- lot_id/procedure_id are not FKs here - /Lots and /Procedures aren't synced in this
  -- pass (step 2 scope is notices+awards+terminations+the supplier chain, not full lot
  -- detail). Plain integers, joinable later if/when Lots gets its own sync.
  lot_id            INTEGER,
  procedure_id      INTEGER,
  last_updated      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ejn_supplier_group_supplier_link (
  id                  INTEGER PRIMARY KEY,
  supplier_group_id   INTEGER NOT NULL REFERENCES ejn_supplier_group(id),
  supplier_id         INTEGER NOT NULL REFERENCES ejn_supplier(id),
  is_lead             INTEGER NOT NULL DEFAULT 0,
  last_updated        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ejn_sgsl_group ON ejn_supplier_group_supplier_link(supplier_group_id);

CREATE TABLE IF NOT EXISTS ejn_supplier_group_unregistered_link (
  id                          INTEGER PRIMARY KEY,
  supplier_group_id           INTEGER NOT NULL REFERENCES ejn_supplier_group(id),
  unregistered_supplier_id    INTEGER NOT NULL REFERENCES ejn_unregistered_supplier(id),
  is_lead                     INTEGER NOT NULL DEFAULT 0,
  last_updated                TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ejn_sgul_group ON ejn_supplier_group_unregistered_link(supplier_group_id);

CREATE TABLE IF NOT EXISTS ejn_lot_contract (
  id                          INTEGER PRIMARY KEY,
  contracting_authority_id    INTEGER NOT NULL REFERENCES ejn_contracting_authority(id),
  supplier_group_id           INTEGER REFERENCES ejn_supplier_group(id),
  value                       REAL,
  contract_date                TEXT,
  last_updated                TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ejn_lot_contract_authority ON ejn_lot_contract(contracting_authority_id);
CREATE INDEX IF NOT EXISTS idx_ejn_lot_contract_supplier_group ON ejn_lot_contract(supplier_group_id);

-- ---- sync bookkeeping ----

-- One row per synced collection. Compound cursor (last_updated_wm, last_id_wm), not
-- last_updated alone - a tie at the exact same LastUpdated timestamp at a page boundary
-- would otherwise risk silently skipping a row. e-JN's LastUpdated carries sub-millisecond
-- precision in practice, making an exact tie across different rows unlikely, but this
-- makes it definitionally impossible rather than merely improbable, at negligible cost.
-- Persisted after every page (not just at the end of a run), so a crash mid-backfill
-- resumes from the last completed page instead of restarting - see pollEjn.js.
CREATE TABLE IF NOT EXISTS ejn_sync_state (
  collection          TEXT PRIMARY KEY,
  last_updated_wm      TEXT NOT NULL DEFAULT '1900-01-01T00:00:00Z',
  last_id_wm          INTEGER NOT NULL DEFAULT 0,
  rows_synced         INTEGER NOT NULL DEFAULT 0,
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
