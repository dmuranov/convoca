// IndexNow (plan §6): "Bing/Yandex indexan en horas" instead of waiting on a crawl. One
// POST to api.indexnow.org fans out to every participating engine (Bing, Yandex, Seznam,
// Naver, Yep) - no need to ping each separately.
//
// INDEXNOW_KEY must match the file served at /<key>.txt (see server.js) - that file is
// how the engines verify this domain actually controls the URLs being submitted. Generate
// once with `node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"`
// and never rotate it without also updating the served file in the same deploy.
//
// Best-effort like notify.js's webhook push: never throws, a ping failing must not fail
// the publish/close action that triggered it.
import { BASE_URL } from './seoUtils.js';

const KEY = process.env.INDEXNOW_KEY || null;
const ENDPOINT = 'https://api.indexnow.org/indexnow';

export async function pingIndexNow(urls) {
  const urlList = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  if (!KEY || !urlList.length) return;
  try {
    const host = new URL(BASE_URL).host;
    await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host, key: KEY, keyLocation: `${BASE_URL}/${KEY}.txt`, urlList }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    console.error(`indexnow: ping failed (${e.message})`);
  }
}
