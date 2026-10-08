// Minimal Telegram Bot API and Bluesky (AT Protocol) clients, plus retry with backoff.
// No SDKs: two HTTP calls each.
const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));

// Retry transient failures (network, 429, 5xx) with exponential backoff; a 429 that says how long
// to wait (Telegram's retry_after) is honoured. Anything else (4xx: bad token, bad chat) fails fast.
export async function withRetry(fn, { tries = 4, baseMs = 2000, sleep = sleepMs, label = '' } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      const transient = e.retryAfter != null || e.status == null || e.status === 429 || e.status >= 500;
      if (!transient || attempt >= tries) throw e;
      const wait = e.retryAfter != null ? e.retryAfter * 1000 : baseMs * 2 ** (attempt - 1);
      console.warn(`social: ${label} attempt ${attempt} failed (${e.message}); retrying in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
  }
}

const httpError = (msg, status, retryAfter) => Object.assign(new Error(msg), { status, retryAfter });

export function telegramClient(token, { fetchImpl = fetch } = {}) {
  return {
    async sendMessage(chatId, html) {
      const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
        signal: AbortSignal.timeout(20000),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) throw httpError(`Telegram ${res.status}: ${j.description || 'error'}`, res.status, j.parameters?.retry_after);
      return j.result?.message_id;
    },
  };
}

export function blueskyClient({ identifier, password, service = 'https://bsky.social', fetchImpl = fetch } = {}) {
  let session = null;
  const call = async (nsid, body, auth = true) => {
    const res = await fetchImpl(`${service}/xrpc/${nsid}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${session.accessJwt}` } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw httpError(`Bluesky ${nsid} ${res.status}: ${j.message || j.error || 'error'}`, res.status,
      res.headers?.get?.('retry-after') ? Number(res.headers.get('retry-after')) : undefined);
    return j;
  };
  const login = async () => { if (!session) session = await call('com.atproto.server.createSession', { identifier, password }, false); };
  const createPost = async ({ text, facets }, reply) => call('com.atproto.repo.createRecord', {
    repo: session.did, collection: 'app.bsky.feed.post',
    record: { $type: 'app.bsky.feed.post', text, facets, langs: ['es'], createdAt: new Date().toISOString(), ...(reply ? { reply } : {}) },
  });
  return {
    // Root post, then each reply chained to the previous one.
    // Each post is retried on its own: retrying the whole thread would repeat the posts that
    // already went out.
    async postThread(posts, { gapMs = 1000, sleep = sleepMs, retry = {}, onPosted = () => {} } = {}) {
      const r = (fn, label) => withRetry(fn, { sleep, ...retry, label });
      await r(login, 'bluesky login');
      const root = await r(() => createPost(posts[0]), 'bluesky post');
      let parent = root;
      for (const p of posts.slice(1)) {
        await sleep(gapMs);
        const reply = { root: { uri: root.uri, cid: root.cid }, parent: { uri: parent.uri, cid: parent.cid } };
        parent = await r(() => createPost(p, reply), 'bluesky reply');
        onPosted(posts.indexOf(p));   // reply n carries item n-1: record it at once
      }
      return root.uri;
    },
  };
}
