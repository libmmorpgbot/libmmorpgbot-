'use strict';
// Client bundle build (concatenate, minify, hash, gzip) + index.html
// rewriting, moved out of server/index.js verbatim. Pure computation over
// the filesystem and BUNDLE_FILES — no app, no io, runs once at require time
// exactly as it used to run once at this point in index.js's own load.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const BUNDLE_FILES = require('./bundle-files').map(f => path.join(ROOT, f));

const jsBundleRaw = BUNDLE_FILES.map(f => fs.readFileSync(f, 'utf8')).join('\n;\n');

// ── Minification ────────────────────────────────────────────────────────────
// Run here, at startup, beside the concatenation and the gzip — this project
// deliberately has no build step to forget, and adding one to save 167 KB
// would have been a poor trade. Costs about two seconds of boot.
//
// toplevel is off for BOTH compress and mangle, and that is not a default to
// rely on quietly. The client is 24 files in one script scope and half its
// entry points are named from strings the minifier cannot see: onclick
// attributes in index.html, and onclick handlers built inside JS template
// literals. Rename a top-level function and every one of those breaks with no
// warning at all. Same reason compress must not drop a "unused" top-level
// binding: its only reader may be a string.
//
// Falls back to the readable bundle if terser is missing or throws. A server
// that will not boot because a size optimisation failed is a far worse outcome
// than a server that serves 167 KB more.
const MINIFY = process.env.MINIFY !== '0';
const _minified = (() => {
  if (!MINIFY) return null;
  try {
    const { minify_sync } = require('terser');
    const out = minify_sync(jsBundleRaw, {
      compress: { toplevel: false },
      mangle:   { toplevel: false },
      format:   { comments: false },
      sourceMap: { url: 'BUNDLE_MAP_URL' },   // patched below, once the hash is known
    });
    if (!out || !out.code) throw new Error('terser returned nothing');
    return out;
  } catch (err) {
    console.error('[bundle] minification skipped —', err.message);
    return null;
  }
})();

const jsBundle = _minified ? _minified.code : jsBundleRaw;
const jsBundleHash = crypto.createHash('sha1').update(jsBundle).digest('hex').slice(0, 12);
const jsBundleEtag = `"${jsBundleHash}"`;
// The hash goes in the URL, which is what lets the file be cached forever:
// /bundle.js could only ever be `no-cache`, because the name stayed the same
// while the content changed, so the browser had to ask on every single launch
// before it could run a line. A content-addressed name changes when the
// content does, so a stale copy is unreachable rather than merely unlikely.
const JS_BUNDLE_PATH = `/bundle.${jsBundleHash}.js`;
const JS_MAP_PATH = `${JS_BUNDLE_PATH}.map`;
// The source map is what keeps a production stack trace readable — without it
// every error reports one line and a five-digit column. Browsers fetch it only
// when devtools is open, so it costs a player nothing.
const jsBundleMap = _minified ? _minified.map : null;
const jsBundleCode = _minified
  ? jsBundle.replace('BUNDLE_MAP_URL', JS_MAP_PATH)
  : jsBundle;

// The stylesheet gets the same treatment for the same reason — it was the
// third round trip a launch had to make before anything could be drawn.
const cssBundle = fs.readFileSync(path.join(ROOT, 'css', 'style.css'));
const cssHash = crypto.createHash('sha1').update(cssBundle).digest('hex').slice(0, 12);
const CSS_PATH = `/css/style.${cssHash}.css`;

// index.html, rewritten once at startup to point at both hashed paths.
//
// Built here rather than substituted per request, and verified: a page that
// names a bundle nobody serves is a blank screen for everyone, so if either
// marker is missing this keeps the original markup — which still works,
// because the un-hashed routes are still answered — and says so loudly rather
// than shipping a broken page quietly.
const INDEX_HTML = (() => {
  const raw = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  let out = raw;
  const swaps = [['/bundle.js', JS_BUNDLE_PATH], ['css/style.css', CSS_PATH.slice(1)]];
  for (const [from, to] of swaps) {
    if (!out.includes(from)) {
      console.error(`[bundle] index.html has no "${from}" to rewrite — serving it unchanged, ` +
        'so the un-hashed routes stay in use and caching is not improved.');
      return raw;
    }
    out = out.split(from).join(to);
  }
  return out;
})();
// Compressed once, here, instead of by the compression() middleware on every
// request. The bundle is ~1.07MB of text (301KB gzipped) and never changes
// while the process lives, so re-deflating it per client was pure repeated
// work — ~30-50ms of CPU each, and after a redeploy every player online comes
// back for it at the same time.
const jsBundleGz = zlib.gzipSync(jsBundleCode, { level: 9 });

module.exports = {
  // The two intermediate forms are exported for dev/bundle-check.js, which
  // asks a JavaScript engine to parse both. A duplicate `let` across two of
  // the concatenated files is an early error that rejects the WHOLE script —
  // blank page, no HUD, no login — and nothing else in the project ever hands
  // this text to a parser.
  jsBundleRaw, jsBundle,
  jsBundleCode, jsBundleGz, jsBundleHash, jsBundleEtag,
  JS_BUNDLE_PATH, JS_MAP_PATH, jsBundleMap,
  cssBundle, cssHash, CSS_PATH,
  INDEX_HTML,
};
