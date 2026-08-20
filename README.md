# Convoca — plazoabierto.es

Rural municipal funding take-up. Watches BDNS daily, translates convocatorias into
plain Spanish, matches them to villages and their entities, and records take-up +
demand signals. Spec: `../Convoca_V5_Spec.md`.

## Layout

- `server.js` — Express app: public landing + chat, invite-only auth, alcalde panel, operator console. Port 3003.
- `src/ingest/` — daily BDNS poll (07:00 Madrid, prod only) → detail → bases PDF → LLM extract → deterministic date engine (`dates.js`, Ley 39/2015) → match suggestions.
- `db/schema.sql` — SQLite. `request.received_at`/`raw_text` immutable by trigger. Computed deadlines quarantined until operator confirmation (`deadline_confirmed`).
- `web/` — static frontends (landing `index.html`, `login.html`, `registro.html`, `panel/`, `operator/`).
- `scripts/seed.js` — pilot municipalities/entities + Phase 0 baseline archive import.

## Hard rules

- **No LLM ever computes a deadline.** API date, deterministic engine, or manual — nothing else; computed ones need operator confirmation before publish.
- Public chat only cites **published OPEN** grants and only repeats stored deadlines verbatim.
- `data/holidays.json` must be re-verified against the BOE/BOCYL calendars each December.

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
