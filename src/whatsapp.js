// Outbound WhatsApp template sends (Infobip) + phone normalization shared
// with the inbound webhook (src/routes/webhooks.js). Inert - logs and
// returns ok:false - until INFOBIP_API_KEY/BASE_URL/FROM are all set, same
// "log and skip" pattern src/notify.js uses for its own not-yet-live path.

function hasCredentials() {
  return Boolean(process.env.INFOBIP_API_KEY && process.env.INFOBIP_BASE_URL && process.env.INFOBIP_FROM);
}

// Spanish mobile (9 digits, starting 6/7/8/9) -> +34. Otherwise expect
// something already close to E.164.
export function normalizePhoneE164(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^\+\d{8,15}$/.test(s)) return s;
  const digits = s.replace(/\D/g, '');
  if (digits.length === 9 && /^[6789]/.test(digits)) return '+34' + digits;
  if (digits.length >= 10 && digits.length <= 15) return '+' + digits;
  return null;
}

export async function sendWhatsAppTemplate({ toPhone, templateName, placeholders, language = 'es' }) {
  if (!hasCredentials()) {
    console.log('whatsapp: skipped - INFOBIP_API_KEY/BASE_URL/INFOBIP_FROM not all set');
    return { ok: false, error: 'infobip-env-not-configured' };
  }
  const phone = normalizePhoneE164(toPhone);
  if (!phone) return { ok: false, error: `invalid-phone:${toPhone}` };

  const rawBase = process.env.INFOBIP_BASE_URL.replace(/\/$/, '');
  const base = rawBase.startsWith('http') ? rawBase : `https://${rawBase}`;
  const payload = {
    messages: [{
      from: process.env.INFOBIP_FROM,
      to: phone.replace(/\D/g, ''),
      content: {
        templateName,
        templateData: { body: { placeholders } },
        language,
      },
    }],
  };
  try {
    const res = await fetch(`${base}/whatsapp/1/message/template`, {
      method: 'POST',
      headers: {
        Authorization: `App ${process.env.INFOBIP_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const txt = await res.text();
      return { ok: false, status: res.status, error: txt.slice(0, 400) };
    }
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
