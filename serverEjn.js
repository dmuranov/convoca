// FondBiH server - second deployment of this repo (build brief §0: "a second deployment
// of the same repo... separate DB, separate domain, separate Caddy site block on the
// shared VM"). Deliberately its own entry point, not a branch inside server.js - convoca
// (Spanish grants) and FondBiH (BiH procurement transparency) are different products in
// different languages sharing only infrastructure code (src/llm.js, the deploy/health
// pattern), and entangling their route trees would make either one harder to change
// without touching the other.
import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import cron from 'node-cron';
import { dbEjn, alertEjn as alert } from './src/dbEjn.js';
import { pollEjnOnce } from './src/ingest/pollEjn.js';
import { enrichPendingTerminations } from './src/ingest/enrichEjn.js';
import { renderMunicipalityPage, listAvailableMunicipalities } from './src/pages/municipalityPage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // behind Caddy

// Non-negotiable #8 (deploy by SHA and verify) / #9 (log the mechanism, not the
// inference) - same pattern as convoca's src/routes/public.js: deploy-ejn.ps1 writes
// DEPLOYED_SHA next to this file, /health reports it back so a deploy script can assert
// the running process actually is the commit it just pushed.
let deployedSha = 'unknown';
try { deployedSha = readFileSync(path.join(__dirname, 'DEPLOYED_SHA'), 'utf8').trim(); } catch {}

app.get('/health', (req, res) => {
  const authorities = dbEjn.prepare('SELECT COUNT(*) c FROM ejn_contracting_authority').get().c;
  const terminations = dbEjn.prepare('SELECT COUNT(*) c FROM ejn_termination').get().c;
  const enriched = dbEjn.prepare('SELECT COUNT(*) c FROM ejn_termination WHERE plain_reason IS NOT NULL').get().c;
  res.json({ ok: true, sha: deployedSha, authorities, terminations, enriched });
});

app.get('/', (req, res) => {
  const municipalities = listAvailableMunicipalities();
  res.type('html').send(`<!doctype html>
<html lang="bs"><head><meta charset="utf-8"><title>FondBiH</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem}
li{margin:.3rem 0}</style></head><body>
<h1>FondBiH</h1>
<p>Transparentnost javnih nabavki po opštinama - podaci sa Portala javnih nabavki BiH.</p>
<ul>${municipalities.map(m => `<li><a href="/opstina/${encodeURIComponent(m.name)}">${m.name}</a> (${m.authorities} ugovornih organa)</li>`).join('')}</ul>
</body></html>`);
});

app.get('/opstina/:name', (req, res) => {
  const html = renderMunicipalityPage(req.params.name);
  if (!html) return res.status(404).type('html').send('<p>Opština nije pronađena ili još nema podataka.</p>');
  res.type('html').send(html);
});

// ---- background jobs (production only) ----
// Non-negotiable #7 (fire-and-forget endpoints need a run guard) generalized to cron: a
// module-level flag stops an overlapping second firing if one run ever takes longer than
// the interval between them, same shape as convoca's own PLACSP walk-button fix.
if (process.env.NODE_ENV === 'production') {
  let syncing = false;
  cron.schedule('0 */6 * * *', async () => {
    if (syncing) return;
    syncing = true;
    try { await pollEjnOnce(); }
    catch (e) { alert('ejn_sync', e.message); }
    finally { syncing = false; }
  });

  let enriching = false;
  // Staggered 20min after the sync window, same reasoning as convoca's own poll/enrich
  // stagger - no reason to have both contend for the same Anthropic rate-limit window
  // when enrichment only needs whatever the sync run just wrote.
  cron.schedule('20 */6 * * *', async () => {
    if (enriching) return;
    enriching = true;
    try { await enrichPendingTerminations(); }
    catch (e) { alert('ejn_enrich', e.message); }
    finally { enriching = false; }
  });
}

const PORT = process.env.PORT || 3005;
app.listen(PORT, () => console.log(`fondbih listening on :${PORT}`));
