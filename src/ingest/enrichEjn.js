// FondBiH enrichment, step 5 of the build brief's order: "Enrichment prompt; small batch;
// read fifteen cards before scaling." Scoped to termination ("poništen postupak") cards -
// see docs/ejn-api-notes.md and the Prijedor page: these are the raw text hardest for a
// citizen to read (dense legal/bureaucratic Bosnian, sometimes Cyrillic, citing appeals-
// office decision numbers) and the brief's own target narrative calls them out by name
// ("Tri postupka su poništena — među njima..."). Mirrors convoca's src/ingest/enrich.js
// shape (deterministic fields already durable from pullMunicipality.js/pollEjn.js; this is
// the LLM phase only) but does not reuse its code - different schema, different language,
// different domain, same account/API key (src/llm.js's `anthropic`/`MODEL`).
//
// Brief's "what v1 must NOT claim" guardrail, generalized to this domain: a termination
// record never carries a monetary value anywhere in this API (checked - no Notice, Award,
// or Termination DTO has an estimated/pre-award value field), so the schema has no value
// field and the prompt is explicitly told not to invent one. Non-negotiable #9 ("log the
// mechanism, not the inference") applies directly: restate what the record says, never
// speculate about motive beyond it.
//
// Reading the first 15 real cards (2026-09-03) found a real bug: the context built for the
// LLM only included `procedure_name`, never `lot_name`. A procedure with multiple lots
// (e.g. one license-purchase procedure split into an AutoCAD lot, a TeamViewer lot, an
// Office lot) shares one procedure_name across every termination row, so every lot's title
// came back nearly identical and non-distinguishing. Fixed by including lot_name.
//
// A second attempt tried to remove the LLM from title generation entirely (deterministic
// truncation of lot_name/procedure_name) to cut cost and dedupe near-identical reason
// text across sibling lots. That was an overcorrection: raw lot_name/procedure_name is
// often long, in Cyrillic, sometimes truncated mid-word by a length cap, and occasionally
// carries the *whole* multi-lot procedure listing instead of a clean single-lot label
// (confirmed live - two of fifteen test rows had this). The LLM's paraphrase into a short,
// consistently Latin-script, plain-language title was real, load-bearing quality, not
// something a deterministic slice could replace. Reverted to one combined LLM call per
// row (title + reason together) with the lot_name fix applied - the actual bug - rather
// than also chasing the reason-deduplication optimization, which added complexity for a
// consistency nicety (identical wording across sibling lots), not a correctness fix, and
// is better revisited later against the Batch API where per-call cost matters much less.
import { anthropic, MODEL } from '../llm.js';
import { dbEjn, alertEjn as alert } from '../dbEjn.js';

export const TERMINATION_CARD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['plain_title', 'plain_reason'],
  properties: {
    plain_title: {
      type: 'string',
      description: 'Kratak, jasan opis ŠTA se nabavljalo, na bosanskom (latinica), kao da objašnjavaš komšiji - iz naziva lota (ako postoji) ili postupka i kategorije. Bez žargona, bez broja postupka ili lota. Do 100 znakova. Primjer: "Nabavka ogrjevnog drveta za škole" umjesto punog administrativnog naziva. Ako postupak ima više lotova, naslov mora opisivati KONKRETNO ovaj lot, ne cijeli postupak.',
    },
    plain_reason: {
      type: 'string',
      description: [
        '1-3 rečenice na bosanskom: ZAŠTO je postupak poništen. Zasnovano ISKLJUČIVO na',
        'datom tekstu (vrsta razloga i, ako postoji, dodatno obrazloženje) - ne dodavaj',
        'razloge, motive ili posljedice koje tekst ne navodi. Ako dodatnog obrazloženja',
        'nema i "Vrsta razloga" je već jasna i ispravna bosanska rečenica (npr. "Nijedna',
        'ponuda nije dostavljena u određenom krajnjem roku"), prenesi je skoro doslovno -',
        'nemoj je nepotrebno prepisivati novim riječima ako već zvuči prirodno, jer',
        'prepisivanje bez potrebe povećava rizik od gramatičke greške. Ako obrazloženje',
        'pominje konkretnu odluku, žalbu ili broj predmeta, zadrži tu činjenicu (ne briši je',
        'radi "jednostavnosti") ali je ispričaj običnim jezikom. Pazi čija je okolnost u',
        'pitanju prema zvaničnoj kategoriji (ugovornog organa ili ponuđača/dobavljača) -',
        'ne zamjenjuj jedno drugim. Ako tekst navodi konkretan iznos ponude naspram',
        'procijenjene vrijednosti, možeš ga prenijeti tačno onako kako piše - ali nikad ne',
        'izračunavaj, procjenjuj ili nagađaj iznos koji tekst sam ne navodi.',
      ].join(' '),
    },
  },
};

export const TERMINATION_SYSTEM = [
  'Ti si analitičar javnih nabavki u Bosni i Hercegovini. Objašnjavaš građanima zašto je',
  'jedan postupak javne nabavke poništen, na osnovu zvaničnog razloga i teksta objavljenog',
  'na Portalu javnih nabavki. Odgovaraš ISKLJUČIVO traženim JSON-om, na latinici. Zabranjeno',
  'je izmišljati, procjenjivati ili nagađati novčani iznos, motiv ili posljedicu koja nije',
  'eksplicitno navedena u datom tekstu.',
].join(' ');

function terminationContext(t) {
  return [
    t.lot_name ? `Naziv lota: ${t.lot_name}` : '',
    `Naziv postupka: ${t.procedure_name || '(bez naziva)'}`,
    `Kategorija: ${t.contract_category_name || 'n/d'}`,
    `Vrsta razloga (zvanična kategorija): ${t.type_name || 'n/d'}`,
    // Confirmed live 2026-09-03 (docs/ejn-api-notes.md): these two fields are populated
    // on an either/or basis, not always both - include both or the real explanation is
    // silently dropped on whichever rows use the one this omits.
    t.reasons ? `Dodatno obrazloženje (Reasons): ${t.reasons}` : '',
    t.additional_information ? `Dodatna informacija (AdditionalInformation): ${t.additional_information}` : '',
  ].filter(Boolean).join('\n');
}

// Direct (non-batch) call - for the small-batch read-and-iterate pass this step calls for.
// Batch API wiring (matching convoca's enrichBatch) is deliberately not built yet; premature
// before the prompt itself is verified against real cards, per non-negotiable #1.
export async function enrichTerminationCard(t) {
  const response = await anthropic.messages.create({
    model: MODEL,
    // 1024 wasn't enough - confirmed live 2026-09-03: two separate runs on the same
    // 15-card test each produced one plain_reason cut off mid-sentence (once mid-quote,
    // once mixing in a stray untranslated Cyrillic fragment right at the cutoff point).
    // Same root cause convoca's own enrich.js already hit and fixed (see its comment:
    // "20 Unterminated string truncation failures... from verbose grants running past
    // 2048 mid-JSON", fixed by raising 2048->4096) - a schema-constrained JSON response
    // that runs out of token budget mid-string doesn't get a graceful early stop, it gets
    // cut exactly wherever the budget ran out.
    max_tokens: 2048,
    system: TERMINATION_SYSTEM,
    output_config: { format: { type: 'json_schema', schema: TERMINATION_CARD_SCHEMA } },
    messages: [{ role: 'user', content: terminationContext(t) }],
  });
  // Belt and suspenders alongside the token bump above: a caller-visible signal for
  // exactly this failure mode, so a production wiring (not built yet - see file header)
  // can retry instead of silently persisting a card that stops mid-sentence.
  if (response.stop_reason === 'max_tokens') {
    throw new Error(`termination ${t.id}: response hit max_tokens (likely truncated mid-JSON)`);
  }
  const text = response.content.find(b => b.type === 'text')?.text || '{}';
  return JSON.parse(text);
}

// ---- batch path for production wiring (serverEjn.js's cron) ----
// Mirrors convoca's src/ingest/enrich.js enrichBatch shape directly: one Batch API call
// for everything currently pending, half price and nothing waiting synchronously on the
// response, then poll for completion and write back each result as it lands. Queue
// membership is `plain_reason IS NULL`, same "missing plain-language field" pattern
// convoca's own backfill sweep already uses - a row a previous run failed to write is
// automatically picked up again next time, no separate retry bookkeeping needed.
const BATCH_POLL_MS = Number(process.env.EJN_ENRICH_BATCH_POLL_MS || 60_000);
const BATCH_TIMEOUT_MS = Number(process.env.EJN_ENRICH_BATCH_TIMEOUT_MS || 2 * 60 * 60_000);
const ENRICH_PAGE_CAP = Number(process.env.EJN_ENRICH_PAGE_CAP || 200);

// Non-negotiable #4 (strip NUL bytes before batch submission) - reasons/additional_information
// is free text off a government portal, same untrusted-text category as convoca's bases PDFs.
const NUL = String.fromCharCode(0);
const stripNul = (s) => s.split(NUL).join('');

const applyCard = dbEjn.prepare(`
  UPDATE ejn_termination SET plain_title = ?, plain_reason = ?, enriched_at = datetime('now')
  WHERE id = ?
`);

export async function enrichPendingTerminations() {
  const pending = dbEjn.prepare(`
    SELECT * FROM ejn_termination WHERE plain_reason IS NULL LIMIT ?
  `).all(ENRICH_PAGE_CAP);
  if (!pending.length) return { enriched: 0, failed: 0 };

  const batch = await anthropic.messages.batches.create({
    requests: pending.map(t => ({
      custom_id: String(t.id),
      params: {
        model: MODEL,
        max_tokens: 2048,
        system: TERMINATION_SYSTEM,
        output_config: { format: { type: 'json_schema', schema: TERMINATION_CARD_SCHEMA } },
        messages: [{ role: 'user', content: stripNul(terminationContext(t)) }],
      },
    })),
  });
  console.log(`ejn enrich batch ${batch.id}: ${pending.length} termination(s) submitted`);

  const giveUpAt = Date.now() + BATCH_TIMEOUT_MS;
  let b;
  for (;;) {
    b = await anthropic.messages.batches.retrieve(batch.id);
    if (b.processing_status === 'ended') break;
    if (Date.now() > giveUpAt) {
      alert('ejn_enrich', `batch ${batch.id} still ${b.processing_status} after `
        + `${Math.round(BATCH_TIMEOUT_MS / 60_000)}min - leaving ${pending.length} termination(s) `
        + `for the next enrichPendingTerminations() sweep`);
      return { enriched: 0, failed: pending.length };
    }
    await new Promise(r => setTimeout(r, BATCH_POLL_MS));
  }

  let enriched = 0, failed = 0;
  for await (const r of await anthropic.messages.batches.results(batch.id)) {
    const id = Number(r.custom_id);
    if (r.result.type !== 'succeeded') {
      failed++;
      alert('ejn_enrich', `termination ${id}: batch ${r.result.type} ${r.result.error?.type || ''}`);
      continue;
    }
    // Same guard as the direct path - see enrichTerminationCard's comment on why a
    // schema-constrained response can still be cut mid-string on max_tokens.
    if (r.result.message.stop_reason === 'max_tokens') {
      failed++;
      alert('ejn_enrich', `termination ${id}: batch response hit max_tokens (likely truncated mid-JSON)`);
      continue;
    }
    const text = r.result.message.content.find(c => c.type === 'text')?.text;
    try {
      const card = JSON.parse(text || '{}');
      applyCard.run(card.plain_title || null, card.plain_reason || null, id);
      enriched++;
    } catch (e) {
      failed++;
      alert('ejn_enrich', `termination ${id}: unparseable card (${e.message})`);
    }
  }
  return { enriched, failed };
}
