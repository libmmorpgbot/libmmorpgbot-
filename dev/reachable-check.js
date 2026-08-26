#!/usr/bin/env node
'use strict';
// ── Which files does the running server actually load? ──────────────────────
//
//   node dev/reachable-check.js
//
// This file was written while two builds shared the tree: the PostgreSQL one
// starting at server/app.js, and the retired Mongo one starting at
// server/index.js. Its job then was to prove that not one file of the old
// build was reachable from the new one — the worry having been raised in as
// many words, "можливо ти старий код з новим змішуєш". Reading the code cannot
// settle that; a require three files deep is not visible from the top.
//
// The Mongo build has since been deleted, which retires that question and
// would leave this file asserting something about a list of paths that no
// longer match anything — a check that passes because there is nothing left to
// catch. So it asserts the stronger thing instead:
//
//   EVERY .js file under server/ is loaded by server/app.js.
//
// While two builds shared the tree that could not be a rule, because "not
// loaded" was the normal state for half the files. Now it can be, and it is
// the rule that stops the situation recurring — because a second build does
// not arrive all at once. It arrives one file at a time, each one reachable
// from nothing, each one looking like work in progress, until there is enough
// of it that deleting it is a project.
//
// It fails, too, if the server ever requires mongoose again. That package is a
// devDependency now: dev/etl.js needs it for the single cutover run that moves
// the old data across, and nothing that serves a player has any business
// touching it.
//
// Nothing is executed here. The graph is read out of the source text, so this
// runs anywhere, needs no database and cannot have side effects.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENTRY = 'server/app.js';

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
//
// A FILE THAT CANNOT BE READ IS REPORTED, not skipped. `catch { continue }`
// swallowed it, and the first file in the queue is the entrypoint: rename
// server/app.js and the walk ends immediately with a set of one, every
// assertion below finds nothing to complain about, and this prints PASS over a
// graph it never opened. Nothing else can produce a read error here either —
// resolve() has already confirmed the file exists before anything is queued —
// so an unreadable file is a broken run and says so.
function reachableFrom(entry) {
  const seen = new Set();
  const unreadable = [];
  const queue = [entry];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    let src;
    try { src = fs.readFileSync(path.join(ROOT, f), 'utf8'); }
    catch (err) { unreadable.push(`${f} (${err.code || err.message})`); continue; }
    for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const r = resolve(f, m[1]);
      if (r) queue.push(r);
    }
  }
  return { seen, unreadable };
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

const { seen: live, unreadable } = reachableFrom(ENTRY);
console.log(`  ${ENTRY} loads ${live.size} files\n`);

// A SCAN THAT FOUND NOTHING MUST NOT REPORT SUCCESS. The count above was once
// printed and never asserted on, so a walk that collapsed to the entrypoint
// alone — a renamed server/app.js, a require() spelling this regex stops
// recognising — came out green, vacuously, about a graph of one file. The
// floor is far below the real figure (60), so ordinary growth and ordinary
// deletion never reach it.
ok(unreadable.length === 0,
  'кожен файл у графі прочитано',
  unreadable.join(', '));
ok(live.size > 30,
  `є що перевіряти — обійдено ${live.size} файлів від ${ENTRY}`,
  'сканування нічого не знайшло — зламана сама перевірка');

// ── the rule ───────────────────────────────────────────────────────────────
const dead = allUnder('server').filter(f => !live.has(f)).sort();
ok(dead.length === 0,
  'кожен файл у server/ завантажується сервером',
  dead.length
    ? `${dead.length}: ${dead.join(', ')} — або підключи, або видали; git пам'ятає`
    : '');

// mongoose left `dependencies` when the Mongo build was deleted. It stays in
// the tree for dev/etl.js and the one cutover run that moves the old data, and
// a require of it from anywhere in THIS graph would be the server depending on
// a database that is being switched off.
const mongoish = [...live].filter((f) => {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  return /require\(\s*['"](mongoose|mongodb)(\/|['"])/.test(src);
}).sort();
ok(mongoish.length === 0,
  'сервер не тягне mongoose/mongodb',
  mongoish.join(', '));

// The entrypoint the packaging claims, versus the one that runs. systemd runs
// `node server/app.js`; when package.json disagreed with that, `npm start`
// booted the retired build — which is the kind of trap that is only ever found
// by falling into it.
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const start = (pkg.scripts && pkg.scripts.start) || '';
ok(pkg.main === ENTRY && start.includes(ENTRY),
  `package.json вказує на ${ENTRY}`,
  `main=${pkg.main} start=${start}`);
ok(!Object.prototype.hasOwnProperty.call(pkg.dependencies || {}, 'mongoose'),
  'mongoose не в dependencies (лише dev, для dev/etl.js)',
  'він потрапить у прод при npm ci --omit=dev');

console.log(`\n  ${pass} пройшло, ${fail} впало`);
if (failures.length) console.log(`  впали: ${failures.join(', ')}`);
process.exit(fail ? 1 : 0);
