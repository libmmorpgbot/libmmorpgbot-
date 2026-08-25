#!/usr/bin/env node
'use strict';
// ── The client bundle has to PARSE ──────────────────────────────────────────
//
//   node dev/bundle-check.js
//
// The client is 24 files concatenated into ONE <script> (server/assets.js), so
// they share a single script scope. That is what makes a name declared in
// player.js usable from game.js — and it is also what makes two files
// declaring the same `let` a fatal error:
//
//   Uncaught SyntaxError: Identifier '_lastRenderTs' has already been declared
//
// A duplicate lexical declaration is an EARLY error. The browser rejects the
// whole script before executing a single line, so the entire client is dead:
// no game, no HUD, no login — a blank page. One name in one file.
//
// Nothing caught it. eslint lints each file separately with the others' names
// supplied as globals, and redeclaring a global is not an error. boot-check
// starts the server, which concatenates and minifies the bundle without ever
// asking a JavaScript engine to parse it. So the first thing to find out was
// the browser, in production.
//
// vm.Script compiles exactly the way the browser does and raises exactly the
// same early errors, without running anything. It costs about a second.
//
// It checks the minified output too: terser rewrites the whole file, and a
// minifier that produces something unparseable is the same blank page.

const vm = require('vm');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}

function main() {
  console.log('\nbundle-check\n');

  // assets.js builds and minifies at require time, exactly as the server does
  // at boot — so what is checked here is the bytes that get served.
  const assets = require(path.join(__dirname, '..', 'server', 'assets.js'));

  const raw = assets.jsBundleRaw || assets.jsBundle;
  const min = assets.jsBundle;

  console.log('  ── исходный бандл ──');
  try {
    new vm.Script(raw, { filename: 'bundle.js' });
    ok(true, `бандл разбирается движком (${Math.round(raw.length / 1024)} КБ)`);
  } catch (err) {
    // The message names the offending identifier, which is the whole answer.
    ok(false, 'бандл разбирается движком', err.message);
  }

  console.log('\n  ── минифицированный ──');
  try {
    new vm.Script(min, { filename: 'bundle.min.js' });
    ok(true, `минифицированный тоже (${Math.round(min.length / 1024)} КБ)`);
  } catch (err) {
    ok(false, 'минифицированный тоже', err.message);
  }

  // The specific shape that got through: the same lexical name declared at the
  // top level of two different files. vm.Script above catches it, but naming
  // every collision at once is more useful than stopping at the first — a
  // rename usually comes in pairs.
  console.log('\n  ── повторные объявления между файлами ──');
  const fs = require('fs');
  const ROOT = path.join(__dirname, '..');
  const files = require(path.join(ROOT, 'server', 'bundle-files'));
  const espree = require('espree');
  const owner = new Map();       // name → first file that declared it
  const clashes = [];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    let ast;
    try {
      ast = espree.parse(src, { ecmaVersion: 2022, sourceType: 'script', loc: true });
    } catch (err) {
      ok(false, `${rel} разбирается`, err.message);
      continue;
    }
    for (const node of ast.body) {
      // Only lexical declarations collide. `var` and `function` may legally be
      // redeclared in the same scope, and the client does that on purpose in
      // places.
      if (node.type !== 'VariableDeclaration') continue;
      if (node.kind !== 'let' && node.kind !== 'const') continue;
      for (const d of node.declarations) {
        if (d.id.type !== 'Identifier') continue;
        const prev = owner.get(d.id.name);
        if (prev && prev.file !== rel) {
          clashes.push(`${d.id.name}: ${prev.file}:${prev.line} и ${rel}:${d.loc.start.line}`);
        } else if (!prev) {
          owner.set(d.id.name, { file: rel, line: d.loc.start.line });
        }
      }
    }
  }
  ok(clashes.length === 0,
    `ни одного имени не объявлено дважды (проверено ${owner.size} в ${files.length} файлах)`,
    clashes.join('; '));

  console.log(`\n  ${pass} пройшло, ${fail} впало`);
  if (failures.length) console.log(`  впали: ${failures.join(', ')}`);
  process.exitCode = fail ? 1 : 0;
}

main();
