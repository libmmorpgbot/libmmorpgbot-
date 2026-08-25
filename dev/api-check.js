#!/usr/bin/env node
'use strict';
// ── Every method called on a Room or on the mode runtime ────────────────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/api-check.js
//
// eslint's no-undef catches a NAME that does not exist. It cannot catch a
// PROPERTY that does not exist, and that is where this project's recurring bug
// lives — a half-converted call site reaching for a method the rewrite renamed,
// moved, or never put on the object at all:
//
//   modes._socketTid            never returned by any factory — it is a dep
//   modes._lockFarm2MinutesFor  passed INTO createFarm2, so it lives in that
//                               closure and not on `modes`
//
// Both were called behind `&&` guards, so neither threw. The farm-zone ticker
// incremented its minutes-charged counter and charged nothing; settlement
// subtracts that counter from the elapsed time, so it came out at zero, and the
// elite zone's daily allowance was never spent by anybody. Found by this file
// rather than by a player, which is the entire point of it.
//
// It asks the RUNTIME rather than reading the source: the mode object is
// assembled at boot out of six factories, so what ends up on it is not
// something a static reading can know. Boot, take the real Room and the real
// modes object, then check every call site's name against them. Nothing is
// executed — the question is only whether the name is there.

const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.API_PORT || 3153);
process.env.PORT = String(PORT);
process.env.OPS_LIVE = '0';
process.env.NODE_ENV = 'test';
process.env.TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || 'test:token';

const { close } = require('../server/db');
const app = require('../server/app');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? `\n        ${detail}` : ''}`); }
}

// The retired Mongo build (see dev/reachable-check.js) is on disk and is not
// what runs: server/handlers, server/models, server/index.js and the old
// server/routes/admin.js.
function skipped(rel) {
  return /\/(handlers|models|migrations)\//.test(rel)
    || rel === 'server/index.js'
    || rel === 'server/routes/admin.js';
}

function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(rel); continue; }
      if (!e.name.endsWith('.js')) continue;
      if (skipped(rel)) continue;
      out.push(rel);
    }
  };
  walk('server');
  return out;
}

// Everything callable on the object and everything it inherits. A method may
// live on the prototype (Room) or be assigned onto a plain object at
// construction (the mode runtime) — both count.
function methodsOf(obj) {
  const names = new Set();
  let cur = obj;
  while (cur && cur !== Object.prototype) {
    for (const k of Object.getOwnPropertyNames(cur)) names.add(k);
    cur = Object.getPrototypeOf(cur);
  }
  return names;
}

// Whole-line comments are prose ABOUT the code. This project's comments name
// old function names deliberately, to record what a thing used to be called, so
// reading them as call sites would report every past fix as a present bug.
//
// Only WHOLE-line comments are dropped. A trailing `//` cannot hide a call site
// anyway, and trying to strip one is how the first version of this file ended
// up matching nothing at all and reporting success.
const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

function main() {
  const world = require('../server/world');
  const modes = require('../server/modes').modes;
  const { FLOOR_IDS } = require('../server/game/floors');

  // A real Room from the live world, not the class: half of what a Room
  // answers is assigned in its constructor.
  const room = world.roomOf(FLOOR_IDS.hub);
  const roomNames = methodsOf(room);
  const modeNames = methodsOf(modes);

  console.log('\napi-check\n');
  console.log(`  Room: ${roomNames.size} назв · modes: ${modeNames.size} назв\n`);

  // Only receivers whose identity is UNAMBIGUOUS. `s.room`, `this.room` and
  // `mate.room` are a Room everywhere they appear; `modes`, `modesRuntime` and
  // `deps.modes` are the mode runtime.
  //
  // A bare `s.` is deliberately NOT checked, though `s` is the session in every
  // handler. It is also the parameter of half the callbacks in those same files
  // — `allSockets.forEach(s => s.emit(...))` rebinds it to a SOCKET — and a
  // plain string in tg-ops.js and security.js. An earlier run reported
  // seventeen such lines beside its two real findings, and a report that is
  // nine parts noise stops being read. What that gives up is a typo in a
  // Session method name, which throws on the first call and is caught by every
  // suite here; a mode-runtime name behind an `&&` guard is not.
  //
  // Longest prefix first, so `deps.modes.x` is not also counted as `modes.x`.
  const receivers = [
    ['s.room.', roomNames, 'Room'],
    ['this.room.', roomNames, 'Room'],
    ['mate.room.', roomNames, 'Room'],
    ['deps.modes.', modeNames, 'modes'],
    ['modesRuntime.', modeNames, 'modes'],
    ['modes.', modeNames, 'modes'],
  ];

  const missing = [];
  const seen = [];
  for (const rel of sourceFiles()) {
    const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (isComment(line)) return;
      const claimed = [];      // char ranges already attributed to a receiver
      for (const [prefix, have, kind] of receivers) {
        let from = 0;
        for (;;) {
          const at = line.indexOf(prefix, from);
          if (at < 0) break;
          from = at + prefix.length;
          if (claimed.some(([a, b]) => at >= a && at < b)) continue;
          // The receiver must start a name, not end one: `xmodes.foo(` is not
          // a call on `modes`.
          const before = at > 0 ? line[at - 1] : ' ';
          if (/[\w$.]/.test(before)) continue;
          // `modes.foo(` is a call. `modes.foo.bar` and `modes.foo =` are
          // property reads, which are not what this checks.
          const m = /^(\w+)\s*\(/.exec(line.slice(from));
          if (!m) continue;
          claimed.push([at, from + m[1].length]);
          seen.push(`${rel}:${i + 1} ${prefix}${m[1]}`);
          if (have.has(m[1])) continue;
          missing.push(`${rel}:${i + 1}  ${prefix}${m[1]}()  — немає на ${kind}`);
        }
      }
    });
  }

  // A CHECK THAT CHECKED NOTHING MUST NOT REPORT SUCCESS. The first version of
  // this file walked sixty-two files, matched zero call sites because of a
  // broken comment strip, and printed a cheerful green PASS. That is worse than
  // having no check at all — it is a check actively asserting that something it
  // never looked at is fine.
  ok(seen.length > 50,
    `є що перевіряти — знайдено ${seen.length} викликів`,
    seen.length <= 50 ? 'сканування нічого не знайшло — зламана сама перевірка' : '');

  ok(missing.length === 0,
    `усі ${seen.length} викликів існують на своєму об'єкті`,
    missing.join('\n        '));

  console.log(`\n  ${pass} пройшло, ${fail} впало`);
  if (failures.length) console.log(`  впали: ${failures.join(', ')}`);
  process.exitCode = fail ? 1 : 0;
}

app.boot()
  .then(() => { console.log(''); main(); })
  .catch(err => { console.error(err); process.exitCode = 1; })
  .finally(async () => {
    try { await app.shutdown('test', { exit: false }); } catch { /* already down */ }
    await close().catch(() => {});
    // Explicit: boot() arms the world loops, the mode schedulers and the socket
    // server, and anything still holding the event loop open would leave this
    // hanging with its result printed and no exit code delivered.
    process.exit(process.exitCode ? 1 : 0);
  });
