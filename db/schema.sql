-- Convoca schema — SQLite. UUIDs stored as TEXT, arrays as JSON text.
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS municipality (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  ine_code      TEXT NOT NULL UNIQUE,
  province      TEXT NOT NULL,
  region        TEXT NOT NULL,
  population    INTEGER,
  agrupacion    TEXT,
  -- local fiestas as JSON array of "MM-DD" (recurring) or "YYYY-MM-DD" entries;
  -- feeds the deterministic date engine. Operator-maintained.
  local_holidays TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS entity (
  id                TEXT PRIMARY KEY,
  municipality_id   TEXT NOT NULL REFERENCES municipality(id),
  name              TEXT NOT NULL,
  type              TEXT NOT NULL CHECK (type IN
                      ('Ayuntamiento','Junta_Vecinal','Asociacion','Club_Deportivo','AMPA','Otro')),
  cif               TEXT,
  contact_name      TEXT,
  contact_phone     TEXT,
  contact_channel   TEXT CHECK (contact_channel IN ('whatsapp','email','via_alcalde')),
  active            INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS grant_row (
  id                 TEXT PRIMARY KEY,
  bdns_ref           TEXT NOT NULL UNIQUE,
  title              TEXT NOT NULL,
  granting_body      TEXT,
  granting_level     TEXT CHECK (granting_level IN ('estatal','autonomico','provincial','local')),
  -- comunidad autónoma (or 'Toda España'); drives the public territory filter
  region             TEXT,
  -- province, when the call is provincial/municipal rather than comunidad-wide.
  -- ~75% of screened grants are at this level (Diputaciones, ayuntamientos), so
  -- without it a village sees grants from the wrong province.
  province           TEXT,
  -- set only for ayuntamiento-level calls: those are open to that town alone, so they
  -- must not surface to the rest of the province. Diputación calls stay province-wide.
  municipality       TEXT,
  -- set when the poller screened the row out instead of enriching it (never published)
  skip_reason        TEXT,
  category           TEXT,
  amount_max         REAL,
  budget_total       REAL,
  open_date          TEXT,
  deadline_date      TEXT,
  deadline_source    TEXT CHECK (deadline_source IN ('api','computed','manual')),
  -- computed deadlines are quarantined until an operator confirms them
  deadline_confirmed INTEGER NOT NULL DEFAULT 0,
  is_rolling         INTEGER NOT NULL DEFAULT 0,
  ai_summary         TEXT,
  -- plain-Spanish headline written by the LLM; `title` keeps the official legal wording
  plain_title        TEXT,
  -- JSON: {para_que, quien_puede, que_cubre, que_no_cubre, como_se_pide} — never dates
  plain_explainer    TEXT,
  -- JSON: [{documento, para_que_sirve, donde_conseguirlo}] — "¿Qué papeles necesito?"
  -- panel on the public card. Same rule as plain_explainer: never dates.
  plain_checklist    TEXT,
  -- set when status transitions OPEN -> CLOSED (deadline sweep or ingest-time). Status
  -- alone can't tell you *when* it closed, which the archive sweep needs.
  closed_at          TEXT,
  -- set by the daily sweep once closed_at is >24h old. Archived rows stay CLOSED and
  -- keep their data (never deleted) - this is bookkeeping, not visibility: the public
  -- list already excludes anything that isn't status='OPEN'.
  archived_at        TEXT,
  raw_text           TEXT,
  source_url         TEXT,
  application_url    TEXT,
  -- generic tramitación portal (sedeElectronica); never a link to this convocatoria
  sede_url           TEXT,
  status             TEXT NOT NULL DEFAULT 'ANNOUNCED' CHECK (status IN ('ANNOUNCED','OPEN','CLOSED')),
  -- operator review gate: nothing is shown to alcaldes or the public chat until published
  published          INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS grant_eligibility (
  id                 TEXT PRIMARY KEY,
  grant_id           TEXT NOT NULL REFERENCES grant_row(id),
  entity_types       TEXT NOT NULL DEFAULT '[]',   -- JSON array of entity.type values
  pop_min            INTEGER,
  pop_max            INTEGER,
  territory_scope    TEXT,
  funds_what         TEXT NOT NULL DEFAULT '[]',   -- JSON array: mobiliario, obra, actividad...
  notes              TEXT
);

-- The demand signal. received_at is set once, by the DB, never updated.
CREATE TABLE IF NOT EXISTS request (
  id                 TEXT PRIMARY KEY,
  entity_id          TEXT REFERENCES entity(id),
  municipality_id    TEXT NOT NULL REFERENCES municipality(id),
  received_at        TEXT NOT NULL DEFAULT (datetime('now')),
  channel            TEXT NOT NULL CHECK (channel IN
                      ('whatsapp_voice','whatsapp_text','call','in_person','web')),
  raw_text           TEXT NOT NULL,               -- verbatim, never edited
  category           TEXT,
  subcategory        TEXT,
  asset_type         TEXT,
  est_amount         REAL,
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN
                      ('open','matched','applied','funded','no_fit')),
  matched_grant_id   TEXT REFERENCES grant_row(id),
  consent_upstream   INTEGER NOT NULL DEFAULT 0
);

CREATE TRIGGER IF NOT EXISTS request_immutable_core
BEFORE UPDATE OF received_at, raw_text ON request
BEGIN
  SELECT RAISE(ABORT, 'received_at and raw_text are immutable');
END;

CREATE TABLE IF NOT EXISTS notification (
  id            TEXT PRIMARY KEY,
  grant_id      TEXT NOT NULL REFERENCES grant_row(id),
  entity_id     TEXT NOT NULL REFERENCES entity(id),
  sent_at       TEXT NOT NULL DEFAULT (datetime('now')),
  channel       TEXT NOT NULL CHECK (channel IN ('whatsapp','email','web')),
  response      TEXT NOT NULL DEFAULT 'none' CHECK (response IN ('none','interesado','no')),
  responded_at  TEXT
);

CREATE TABLE IF NOT EXISTS application (
  id               TEXT PRIMARY KEY,
  grant_id         TEXT NOT NULL REFERENCES grant_row(id),
  entity_id        TEXT NOT NULL REFERENCES entity(id),
  submitted_at     TEXT NOT NULL DEFAULT (datetime('now')),
  outcome          TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending','awarded','rejected')),
  amount_awarded   REAL,
  attributable     INTEGER
);

-- Phase 0 archive, imported once from baseline_out JSON; feeds the baseline-delta metric.
CREATE TABLE IF NOT EXISTS baseline_concesion (
  id              INTEGER PRIMARY KEY,           -- BDNS concesion id
  cod_concesion   TEXT,
  fecha_concesion TEXT,
  beneficiario    TEXT,                          -- "CIF NAME" as BDNS returns it
  cif             TEXT,                          -- extracted first token
  importe         REAL,
  convocatoria    TEXT,
  num_convocatoria TEXT,
  nivel1          TEXT,
  nivel2          TEXT,
  nivel3          TEXT
);
CREATE INDEX IF NOT EXISTS idx_baseline_cif ON baseline_concesion(cif);
CREATE INDEX IF NOT EXISTS idx_baseline_fecha ON baseline_concesion(fecha_concesion);

-- Auth
CREATE TABLE IF NOT EXISTS user (
  id               TEXT PRIMARY KEY,
  email            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash    TEXT NOT NULL,
  name             TEXT,
  role             TEXT NOT NULL CHECK (role IN ('operator','alcalde')),
  municipality_id  TEXT REFERENCES municipality(id),
  entity_id        TEXT REFERENCES entity(id),
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invite (
  token            TEXT PRIMARY KEY,
  email            TEXT NOT NULL,
  name             TEXT,
  role             TEXT NOT NULL DEFAULT 'alcalde' CHECK (role IN ('operator','alcalde')),
  municipality_id  TEXT REFERENCES municipality(id),
  entity_id        TEXT REFERENCES entity(id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at       TEXT NOT NULL,
  used_at          TEXT
);

CREATE TABLE IF NOT EXISTS session (
  token       TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES user(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_session_expiry ON session(expires_at);

-- Public chat abuse control (per IP per UTC day)
CREATE TABLE IF NOT EXISTS chat_usage (
  ip     TEXT NOT NULL,
  day    TEXT NOT NULL,
  count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, day)
);

-- Login throttling (per IP per UTC hour)
CREATE TABLE IF NOT EXISTS login_attempt (
  ip     TEXT NOT NULL,
  hour   TEXT NOT NULL,
  count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, hour)
);

-- Ingestion alerts — spec: never fail silently
CREATE TABLE IF NOT EXISTS ingest_alert (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  source      TEXT NOT NULL,                     -- poll | fetch_bases | extract | dates
  message     TEXT NOT NULL,
  resolved    INTEGER NOT NULL DEFAULT 0
);

-- Public contact form. Deliberately NOT the `request` table: that one models a known
-- pilot village asking for something (municipality_id NOT NULL, immutable raw_text) and
-- an anonymous visitor has no municipality row. Retention is enforced by a nightly prune
-- in server.js and stated under the form -- see CONTACT_RETENTION_DAYS.
CREATE TABLE IF NOT EXISTS contact_message (
  id           TEXT PRIMARY KEY,
  received_at  TEXT NOT NULL DEFAULT (datetime('now')),
  name         TEXT NOT NULL,
  contact      TEXT NOT NULL,          -- email or phone, verbatim, as they wrote it
  place_label  TEXT,                   -- whatever they picked in "de donde eres"
  municipality TEXT,
  province     TEXT,
  ccaa         TEXT,
  message      TEXT NOT NULL,
  ip           TEXT,                   -- for rate limiting and abuse only; pruned with the row
  status       TEXT NOT NULL DEFAULT 'new'
                 CHECK (status IN ('new','read','replied','spam')),
  handled_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_contact_received ON contact_message(received_at);
CREATE INDEX IF NOT EXISTS idx_contact_status ON contact_message(status);
