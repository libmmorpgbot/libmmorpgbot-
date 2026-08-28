'use strict';
const fs = require('fs');
const path = require('path');
const espree = require('espree');
const js = require('@eslint/js');
const globals = require('globals');

const ROOT = __dirname;
const BUNDLE_FILES = require('./server/bundle-files');

// The rule this config exists for: no-undef and no-unused-vars, the exact
// class of bug that shipped twice in one day (MARKET_FEE_PCT exported from
// inventory.js but never imported into index.js; a dead `if (!_xpCorrected)`
// branch nobody could reach). Both are ReferenceError/silent-NaN bugs a
// linter catches before a push, not after a bug report.
//
// Two file groups need different treatment, because they run in genuinely
// different scopes:
//
//   - server/**, dev/**, shared/** — real CommonJS modules, each with its
//     own require()'d scope. no-undef here means what it always means.
//
//   - js/** (the client) — NOT modules. server/index.js concatenates
//     BUNDLE_FILES into one <script> and serves it as a single file (see the
//     comment by MINIFY there: "The client is 24 files in one script
//     scope"). A name declared in js/player.js and used in js/game.js is
//     completely normal, so per-file no-undef would be wrong here unless it
//     knows the whole shared scope. bundleGlobals() below builds exactly
//     that scope by parsing every BUNDLE_FILES file and collecting its
//     top-level declarations, the same set the browser actually sees at
//     runtime.
//
// Real parsing (espree, eslint's own parser — already a dependency, not a
// new one), not a regex over lines: a first attempt used a line regex and it
// missed `let player = null, dungeon = null;` (js/state.js) — comma-
// separated declarators on one line — which then made `dungeon` read as
// no-undef everywhere it's used. A regex can always be missing the next
// shape; an AST walk of VariableDeclaration/FunctionDeclaration/
// ClassDeclaration can't miss a declarator, however it's written.

function collectPatternNames(node, out) {
  if (!node) return;
  switch (node.type) {
    case 'Identifier': out.push(node.name); break;
    case 'ObjectPattern':
      for (const prop of node.properties) {
        collectPatternNames(prop.type === 'RestElement' ? prop.argument : prop.value, out);
      }
      break;
    case 'ArrayPattern':
      for (const el of node.elements) collectPatternNames(el, out);
      break;
    case 'AssignmentPattern': collectPatternNames(node.left, out); break;
    case 'RestElement': collectPatternNames(node.argument, out); break;
  }
}

function topLevelNames(text, out) {
  const ast = espree.parse(text, { ecmaVersion: 'latest', sourceType: 'script' });
  for (const stmt of ast.body) {
    if (stmt.type === 'FunctionDeclaration' && stmt.id) out[stmt.id.name] = 'writable';
    else if (stmt.type === 'ClassDeclaration' && stmt.id) out[stmt.id.name] = 'writable';
    else if (stmt.type === 'VariableDeclaration') {
      for (const decl of stmt.declarations) {
        const names = [];
        collectPatternNames(decl.id, names);
        for (const n of names) out[n] = 'writable';
      }
    }
  }
}

// index.html carries two more inline <script> blocks (no `src`) after
// bundle.js — chat DM state (_chatTab, _renderDmConvoList, ...) and the
// context-menu guard IIFE — that run in the exact same page scope as
// everything in BUNDLE_FILES. A name declared there and used from js/ (e.g.
// network.js calling _renderDmConvoList) is exactly as normal as a
// cross-file call within the bundle itself, so it needs to be in the same
// global set or every one of those reads as no-undef.
function htmlInlineScriptNames(out) {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) topLevelNames(m[1], out);
}

function bundleGlobals() {
  const out = {};
  for (const rel of BUNDLE_FILES) {
    topLevelNames(fs.readFileSync(path.join(ROOT, rel), 'utf8'), out);
  }
  htmlInlineScriptNames(out);
  return out;
}

// Third-party globals the page loads as plain <script src> tags rather than
// through BUNDLE_FILES — real globals at runtime, just not ones any of our
// own files declare. socket.io.js -> io, pixi.min.js -> PIXI,
// vendor/tonconnect-ui.min.js -> TON_CONNECT_UI (fetched on demand by
// js/tonconnect.js's _tcLoadScript, see the comment there).
const VENDOR_GLOBALS = { io: 'readonly', PIXI: 'readonly', TON_CONNECT_UI: 'readonly' };

// These files drive a real Chromium via Playwright and pass callbacks to
// page.evaluate(fn) — fn's BODY runs inside the browser page, not in this
// Node process, and references the client bundle's own globals (player,
// state, socket, dungeon, window, ...). ESLint has no way to scope just that
// callback differently from the surrounding Node code in the same file, so
// they get the union of both worlds rather than losing no-undef entirely for
// a whole file over a few page.evaluate() bodies.
const browserEvalFiles = ['dev/harness.js', 'dev/smoke.js', 'dev/remote-motion-check.js', 'dev/egress.js',
  // Обрезает и сжимает HUD-ассеты, и делает это canvas'ом в настоящем
  // браузере: своего декодера PNG с альфой у Node здесь нет, а тянуть его
  // ради разового конвейера — лишняя зависимость в проде.
  'dev/hud-assets.js'];
const nodeFiles = ['server/**/*.js', 'dev/**/*.js', 'shared/**/*.js', 'eslint.config.js'];
const clientFiles = BUNDLE_FILES.map(f => f.replace(/\\/g, '/'));

// `catch (_) {}` / `catch {}` swallowing a localStorage/best-effort-cleanup
// throw is a deliberate, repeated convention across the whole codebase (both
// client and server), not an oversight — allow it everywhere rather than
// annotate dozens of call sites.
const commonRules = { 'no-empty': ['error', { allowEmptyCatch: true }] };

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'js/pixi.min.js',   // vendored, minified — not ours to lint
      'js/vendor/**',     // vendored third-party
      '.dev-mongo/**',
      'prof/**',
    ],
  },

  // server/, dev/, shared/ — real CommonJS modules.
  {
    files: nodeFiles,
    ignores: browserEvalFiles,
    languageOptions: {
      sourceType: 'commonjs',
      ecmaVersion: 'latest',
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      ...commonRules,
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },

  // The three files above: Node + embedded browser-page callbacks, so both
  // globals sets apply. Loses a little precision (a typo'd Node-only name
  // used to be caught as no-undef against just Node globals; now it might
  // coincidentally match a client/vendor global) — an acceptable trade for
  // three dev-only test scripts, not something to accept in app code.
  {
    files: browserEvalFiles,
    languageOptions: {
      sourceType: 'commonjs',
      ecmaVersion: 'latest',
      globals: { ...globals.node, ...globals.browser, ...VENDOR_GLOBALS, ...bundleGlobals() },
    },
    rules: {
      ...js.configs.recommended.rules,
      ...commonRules,
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },

  // The client bundle — one shared, non-module script scope in the browser.
  {
    files: clientFiles,
    languageOptions: {
      sourceType: 'script',
      ecmaVersion: 'latest',
      globals: { ...globals.browser, ...VENDOR_GLOBALS, ...bundleGlobals() },
    },
    rules: {
      ...js.configs.recommended.rules,
      ...commonRules,
      // Off, not tuned: a name only referenced from an onclick="..." string
      // in index.html, or built inside a template literal (js/ui.js does
      // this constantly), is invisible to any static tool and would read as
      // "unused" on every real entry point. Same reason terser's minify call
      // (server/index.js) runs with `mangle: { toplevel: false }` instead of
      // trying to special-case it — see the comment there.
      'no-unused-vars': 'off',
      // Every name bundleGlobals() finds came FROM these same files' own
      // top-level declarations, so every one of them is, by construction,
      // "already declared" as far as this rule is concerned — it would flag
      // the legitimate declaration in every single client file. The thing
      // this rule actually catches (two DIFFERENT top-level declarations of
      // the same name across the bundle) is exactly what a naming collision
      // in one shared script scope would be, which is worth having — see the
      // duplicate-const regression a past commit fixed — but that check
      // belongs in dev/harness.js's "bundle" scenario (parses the real
      // concatenated bundle and asserts no name is declared twice), not
      // here, where it can't be told apart from the constant false positive.
      'no-redeclare': 'off',
    },
  },
];
