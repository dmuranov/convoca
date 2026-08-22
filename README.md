# Convoca — plazoabierto.es

Rural municipal funding take-up. Watches BDNS daily, translates convocatorias into
plain Spanish, matches them to villages and their entities, and records take-up +
demand signals. Spec: `../Convoca_V5_Spec.md`.

## Layout

- `server.js` — Express app: public landing + chat, invite-only auth, alcalde panel, operator console. Port 3003.
- `src/ingest/` — daily BDNS poll (07:00 Madrid, prod only) → screen → detail → bases PDF → LLM extract → deterministic date engine (`dates.js`, Ley 39/2015) → match suggestions.
- `db/schema.sql` — SQLite. `request.received_at`/`raw_text` immutable by trigger. Computed deadlines quarantined until operator confirmation (`deadline_confirmed`).
- `web/` — static frontends (landing `index.html`, `login.html`, `registro.html`, `panel/`, `operator/`).
- `scripts/seed.js` — pilot municipalities/entities + Phase 0 baseline archive import.
- `scripts/reenrich.js` — re-runs enrichment over rows already stored; use after changing the
  extraction schema. Default: only rows missing the plain-language fields. `--all` for every row.
- `scripts/backfill-regions.js` — re-derives `region`/`province`/`municipality`. Detail calls
  only, no LLM, safe to re-run. Also canonicalises province names and clears leftovers.
- `scripts/build-municipios.js` / `scripts/build-pedanias.js` — rebuild the place dictionaries
  from INE and the Registro de Entidades Locales. Re-run yearly; both write into `data/`.

## Scope — two audiences

The poll sweeps **all of Spain**, then splits by audience:

- **Grassroots directory (national).** Only what a village, association or club can
  actually apply to. `screen()` in `poll.js` drops anything that is not
  *Concurrencia competitiva* and anything aimed solely at for-profit activity.
- **Palencia / Castilla y León (pilot).** Bypasses the screen entirely — direct awards
  and convenios included, because "who already got what" is the intelligence the
  Diputación is buying.

Screening runs on the BDNS **detail** record (plain HTTP) *before* any LLM call, and the
detail is then handed to `enrichGrant` so it is fetched once. This matters: ~66% of BDNS
is *Concesión directa* — money already assigned to a named beneficiary, with nothing to
apply for. Measured on a live 50-row sample: **808/week in the window → ~210/week
enriched**, i.e. ~910/month rather than ~3,400.

Skipped rows are stored with a `skip_reason` and never reconsidered — dedupe on
`bdns_ref` means each reference costs at most one detail call, ever.

Extraction model is `CONVOCA_MODEL` (default `claude-opus-5`). At ~910/month that is
roughly $110/month; `claude-haiku-4-5` is about a fifth of that.

## Plain-language layer

BDNS titles are legal boilerplate ("Orden de 14 de agosto de 2026, de la Consejería de…"), so the
LLM extract also writes, per convocatoria:

- `plain_title` — a <80-char headline in plain Spanish; the card leads with it and keeps the
  official wording as small print. `title` always retains the untouched BDNS text.
- `plain_explainer` — JSON `{para_que, quien_puede, que_cubre, que_no_cubre, como_se_pide}`,
  rendered behind the card's *"Explícamelo en cristiano"* toggle.

Both are subject to the deadline rule below: the extraction prompt forbids dates in every field.

## Territory & the "¿de dónde eres?" search

`organo.nivel2` is the granting **body's** name, not a territory — local calls arrive as
"VILLAQUILAMBRE" or "MANCOMUNIDAD DE LA MERINDAD DE DURANGO". The territory comes from the
detail record's `regiones` NUTS codes, mapped in `ingest/regions.js`.

`data/municipios.json` is the INE municipality dictionary (8,132 rows), built by
`scripts/build-municipios.js` straight from INE's published `diccionario<YY>.xlsx`. Rebuild
it when INE publishes a new year — municipalities merge and get renamed. `ingest/regions.js`
owns the province/comunidad vocabulary for both sides, so grants and municipalities cannot
drift apart.

A place resolves to four tiers, and a grant shows only if it matches one:

| tier | source | shown to |
|---|---|---|
| `Toda España` | state-level or multi-region | everyone |
| comunidad | NUTS2 in `regiones` | that comunidad |
| province | NUTS3 in `regiones` | that province |
| municipality | ayuntamiento named in `granting_body` | that town only |

Two traps this exists to avoid. BDNS spells provinces differently from INE — "A Coruña" vs
"Coruña, A", "Valencia / València" vs "Valencia/València" — and names islands at NUTS3
("Menorca") though Spain has no island provinces; `canonicalProvince()` maps all of them.
And ~60% of screened grants come from an ayuntamiento, open to that town alone; without
`municipality` a village in Palencia was offered Medina del Campo's money.

`data/pedanias.json` covers the rest of rural Spain: 3,674 *entidades locales menores* —
the pedanías and juntas vecinales that are **not** municipalities and so are absent from
INE's dictionary (Villotilla is a pedanía of Villaturde). Built by
`scripts/build-pedanias.js` from the Registro de Entidades Locales. A pedanía inherits its
municipality's tiers, including that ayuntamiento's own grants, which its residents can
genuinely apply for.

The REL export is a legacy OLE2/BIFF8 `.xls` — every other format the endpoint accepts
falls back to a 214-page PDF — so the script parses the compound file and BIFF records
itself rather than adding a spreadsheet dependency. The fiddly part, handled and worth not
breaking: a shared string can straddle a `CONTINUE` record boundary, and each continuation
restarts with its own "is this UTF-16" flag byte.

Typeahead matches return `label` (what the villager typed and recognises) and `name` (the
municipality it resolves to, used to match ayuntamiento grants). They differ for pedanías;
for a province `name` is null, so town-only money never leaks to someone who merely named
their province.

## Publishing

Nothing reaches the public directory without an operator. The poller only enriches; rows
land `published = 0`. At Spain-wide volume (~200/week past the screen) reviewing one card
at a time is not realistic, so the operator console has **"publicar todas las listadas"** →
`POST /api/op/grants/publish-batch` (max 500 ids per call, only rows that were actually
extracted and are not CLOSED). Publishing stays reversible per grant.

## Links

BDNS has **no per-convocatoria application URL**. `sedeElectronica` is the organism's generic
portal root and `urlBasesReguladoras` is the framework rules — often years older than the call
(a 2018 BOCYL, a 2014 ordenanza). Neither may be the "ver convocatoria" target. The card's
primary button therefore always points at the BDNS page for that reference (`source_url`), with
those two kept as secondary links labelled for what they actually are.

## Hard rules

- **No LLM ever computes a deadline.** API date, deterministic engine, or manual — nothing else. Engine-computed dates publish immediately but are marked estimated (*) with a disclaimer on every surface until the operator confirms them (then they show as firm).
- Public chat only cites **published OPEN** grants and only repeats stored deadlines verbatim (including the estimated marker + disclaimer when present).
- `data/holidays.json` must be re-verified against the BOE/BOCYL calendars each December.
- Enrichment is re-runnable: it replaces the grant's `grant_eligibility` row rather than inserting,
  otherwise every LEFT JOIN behind the public list duplicates the grant.
- Microsoft Clarity (`y5s3t0x5yi`) loads on `index.html` and `registro.html` only. Keep it off
  `login.html`, `panel/` and `operator/` — those session replays would capture municipal and
  personal data.

## Dev

```
npm install
npm run seed        # needs ../baseline_out/ (or BASELINE_JSON=...)
npm test            # date engine + plazo parser
OPERATOR_EMAIL=... OPERATOR_PASSWORD=... npm start
```

## Deploy

`./deploy.ps1` → shared Azure VM (testpilot:3001, mocount:3002, convoca:3003), PM2 app
`convoca`, Caddy block in `caddy/Caddyfile.example`. **Never** run box-wide pm2 commands.
`.env` on the VM holds `ANTHROPIC_API_KEY` etc — see `.env.example`.
