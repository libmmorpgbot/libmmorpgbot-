#!/usr/bin/env node
'use strict';
// ── Which files does the running server actually load? ──────────────────────
//
//   node dev/reachable-check.js
//
// Two builds live in this tree. The PostgreSQL one starts at server/app.js —
// that is what systemd runs (ExecStart=/usr/bin/node server/app.js). The Mongo
// one starts at server/index.js and is kept only as a reference while the
// rewrite is finished; package.json's `main` and `start` still point at it,
// which is itself a good reason for this check to exist.
//
// The worry it answers was raised directly: "можливо ти старий код з новим
// змішуєш". Reading the code cannot settle that — a require three files deep
// is not visible from the top. Walking the graph can, and does: from
// server/app.js the answer is a fixed list, and not one file of the old build
// is on it.
//
// It fails if that ever stops being true. A single `require('../index')` added
// by accident would pull the whole Mongo build — models, mongoose, a second
// set of handlers — into a process that has no Mongo to talk to, and the
// symptom would be nothing at all until the first code path that used it.
//
// Nothing is executed here. The graph is read out of the source text, so this
// runs anywhere, needs no database and cannot have side effects.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENTRY = 'server/app.js';

// Anything under these must never be reachable from the running server.
const RETIRED = [
  /^server\/index\.js$/,
  /^server\/handlers\//,
  /^server\/models\//,
  /^server\/routes\/admin\.js$/,      // admin2.js is the live one
  /^server\/telegram-bot\.js$/,
  /^server\/player-log\.js$/,
];

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}

function resolve(from, spec) {
  if (!spec.startsWith('.')) return null;              // a package, not our code
  const p = path.join(path.dirname(from), spec).split(path.sep).join('/');
  for (const c of [p, `${p}.js`, `${p}/index.js`]) {
    const abs = path.join(ROOT, c);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return c;
  }
  return null;
}

// Breadth-first over `require('...')` occurrences. Dynamic requires inside a
// function body count — several modules require lazily to break a cycle, and
// a lazy require loads the file just as surely as a top-level one does.
function reachableFrom(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    let src;
    try { src = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const r = resolve(f, m[1]);
      if (r) queue.push(r);
    }
  }
  return seen;
}

function allUnder(dir) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) out.push(p);
    }
  })(dir);
  return out;
}

console.log('\nreachable-check\n');

const live = reachableFrom(ENTRY);
console.log(`  ${ENTRY} loads ${live.size} files\n`);

const leaked = [...live].filter(f => RETIRED.some(re => re.test(f))).sort();
ok(leaked.length === 0,
  'жоден файл старої (Mongo) збірки не завантажується сервером',
  leaked.join(', '));

// The reverse, as information rather than a rule: what is in the tree and not
// loaded. Everything here is either the retired build or genuinely unused, and
// both are worth seeing in one place at cutover.
const dead = allUnder('server').filter(f => !live.has(f)).sort();
const unexpected = dead.filter(f => !RETIRED.some(re => re.test(f)));
console.log(`\n  не завантажується ${dead.length} файлів:`);
for (const f of dead) {
  const retired = RETIRED.some(re => re.test(f));
  console.log(`    ${retired ? '\x1b[2mстара збірка\x1b[0m' : '\x1b[33mне використовується\x1b[0m'}  ${f}`);
}

// A file that is neither loaded nor part of the retired build is dead code —
// reported, not failed, because "written for something not finished yet" is a
// legitimate reason for it to be there.
ok(true, `поза старою збіркою не використовується ${unexpected.length} файлів`
  + (unexpected.length ? ` (${unexpected.join(', ')})` : ''));

// The entrypoint the packaging claims, versus the one that runs. Stated rather
// than enforced: `npm start` booting the retired build is a trap worth naming.
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const startsOld = /server\/index\.js/.test((pkg.scripts && pkg.scripts.start) || '');
console.log(startsOld
  ? `\n  \x1b[33mувага\x1b[0m  npm start → ${pkg.scripts.start} (стара збірка); systemd запускає ${ENTRY}`
  : `\n  npm start → ${pkg.scripts.start}`);

console.log(`\n  ${pass} пройшло, ${fail} впало`);
if (failures.length) console.log(`  впали: ${failures.join(', ')}`);
process.exit(fail ? 1 : 0);
