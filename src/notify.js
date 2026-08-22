// Operator notification for things that arrive while nobody is looking.
//
// There is no mail transport in this project and no MX record on the domain, so "email
// the operator" is not a thing that can be reused -- alert() only writes a row to
// ingest_alert and logs to stderr. This module keeps that as the durable record (the
// operator console already renders unresolved alerts at the top of the page) and adds an
// optional outbound push, so a message does not sit unseen for three weeks.
//
// NOTIFY_WEBHOOK_URL takes any endpoint that accepts a POST. The two that need no domain,
// no MX and no fee:
//
//   ntfy.sh    NOTIFY_WEBHOOK_URL=https://ntfy.sh/<a-secret-topic-you-invent>
//              NOTIFY_WEBHOOK_FORMAT=text        (install the phone app, subscribe to it)
//   Telegram   NOTIFY_WEBHOOK_URL=https://api.telegram.org/bot<token>/sendMessage?chat_id=<id>
//              NOTIFY_WEBHOOK_FORMAT=telegram
//
// Unset, notification degrades to the console alert alone -- never to a thrown error: a
// villager's message must be stored even if the push fails.
import { alert } from './ingest/bdns.js';

const URL_ = process.env.NOTIFY_WEBHOOK_URL || null;
const FORMAT = process.env.NOTIFY_WEBHOOK_FORMAT || 'text';

function body(title, text) {
  switch (FORMAT) {
    case 'telegram': return { json: { text: `${title}\n\n${text}` } };
    case 'slack':    return { json: { text: `*${title}*\n${text}` } };   // also Discord-compatible
    default:         return { text: `${title}\n\n${text}` };             // ntfy and friends
  }
}

export async function notifyOperator(title, text) {
  // Durable first: the console must show it whether or not the push works.
  alert('contact', `${title} — ${text.replace(/\s+/g, ' ').slice(0, 300)}`);
  if (!URL_) return;
  try {
    const b = body(title, text);
    await fetch(URL_, {
      method: 'POST',
      headers: b.json ? { 'Content-Type': 'application/json' } : { 'Content-Type': 'text/plain; charset=utf-8' },
      body: b.json ? JSON.stringify(b.json) : b.text,
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    // Never rethrow: the caller has already stored the message and owes the visitor a 200.
    console.error(`notify: push failed (${e.message})`);
  }
}
