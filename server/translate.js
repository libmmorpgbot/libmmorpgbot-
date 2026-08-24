'use strict';
// ── Chat translation ────────────────────────────────────────────────────────
// The "translate" button under a chat bubble. Lifted out of server/index.js
// unchanged — it never touched the database, and the rewrite simply left it
// behind, so the button marked a bubble as translating and nothing ever came
// back to clear it.
//
const _TRANSLATE_TIMEOUT_MS = 5000;
// Chat repeats itself — greetings, "gg", the same question asked all evening
// — and each hit here is one request that never reaches Google, which is the
// cheapest way to stay under the rate limit. Keyed by target language + the
// exact (already length-capped) text; oldest entry evicted at the cap.
const _TRANSLATE_CACHE_MAX = 500;
const _translateCache = new Map();
// Tried in order until one answers with a non-empty translation. Different
// hosts and client ids, deliberately: when the throttle hits one of them the
// other is usually still answering.
const _TRANSLATE_SOURCES = [
  {
    name: 'gtx',
    url: (text, lang) => 'https://translate.googleapis.com/translate_a/single'
      + '?client=gtx&sl=auto&tl=' + encodeURIComponent(lang) + '&dt=t&q=' + encodeURIComponent(text),
    // [[[translatedChunk, originalChunk, ...], ...], null, sourceLang]
    parse: data => (Array.isArray(data) && Array.isArray(data[0]) ? data[0] : [])
      .map(c => (Array.isArray(c) ? c[0] : null))
      .filter(v => typeof v === 'string').join(''),
  },
  {
    name: 'dict-chrome-ex',
    url: (text, lang) => 'https://clients5.google.com/translate_a/t'
      + '?client=dict-chrome-ex&sl=auto&tl=' + encodeURIComponent(lang) + '&q=' + encodeURIComponent(text),
    // [[translated, sourceLang], ...] — a different shape from the one above,
    // which is exactly why each source parses its own response.
    parse: data => (Array.isArray(data) ? data : [])
      .map(c => (Array.isArray(c) ? c[0] : c))
      .filter(v => typeof v === 'string').join(''),
  },
];
// Worth asking the same endpoint again: a throttle or a hiccup, not a refusal.
const _TRANSLATE_RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

async function _translateOnce(src, text, targetLang) {
  // Without a deadline a hung request never settles, and the chat bubble that
  // asked sits on "…" for the rest of the session.
  const res = await fetch(src.url(text, targetLang), { signal: AbortSignal.timeout(_TRANSLATE_TIMEOUT_MS) });
  if (!res.ok) {
    // The body is what distinguishes "too many requests from this IP" from a
    // consent/captcha page, and it is the one thing the old error dropped.
    const body = await res.text().catch(() => '');
    const err = new Error(`${src.name} http ${res.status}: ${body.slice(0, 120).replace(/\s+/g, ' ')}`);
    err.status = res.status;
    throw err;
  }
  return src.parse(await res.json());
}

async function _translateText(text, targetLang) {
  const key = targetLang + '\n' + text;
  if (_translateCache.has(key)) {
    // Re-insert so the most recently used entry is the last one out.
    const hit = _translateCache.get(key);
    _translateCache.delete(key);
    _translateCache.set(key, hit);
    return hit;
  }
  let lastErr = null;
  for (const src of _TRANSLATE_SOURCES) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const out = await _translateOnce(src, text, targetLang);
        // An empty string is a failure dressed as success — it used to reach
        // the player as a blank translation line under their message.
        if (out) {
          _translateCache.set(key, out);
          if (_translateCache.size > _TRANSLATE_CACHE_MAX) {
            _translateCache.delete(_translateCache.keys().next().value);
          }
          return out;
        }
        lastErr = new Error(src.name + ': empty translation');
        break;
      } catch (err) {
        lastErr = err;
        // Only a throttle/hiccup is worth a second try at the same endpoint;
        // anything else goes straight to the next source.
        if (attempt === 0 && _TRANSLATE_RETRY_STATUS.has(err.status)) {
          await new Promise(r => setTimeout(r, 400));
          continue;
        }
        break;
      }
    }
  }
  throw lastErr || new Error('translate failed');
}

module.exports = { translateText: _translateText };
