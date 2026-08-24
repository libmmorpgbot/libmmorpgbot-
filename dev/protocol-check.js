#!/usr/bin/env node
'use strict';
// ── Does the server speak the language the shipped client speaks? ───────────
//
//   node dev/protocol-check.js
//
// No database, no server, no network: it reads the client's `socket.emit(...)`
// calls and the server's `safeOn(...)` registrations and compares the two.
//
// This exists because of a whole class of defect the repository suites cannot
// see. They call `craft.craft(db, pid, family, index)` directly and prove it is
// correct — and it is. What they never ask is whether anything ever CALLS it
// with what the client actually sends. The rewritten handlers were written
// against a tidier protocol than the one the shipped bundle speaks:
//
//   client                              server
//   equipItem  { idx }                  ({ id, slot })      → both undefined
//   openLootBox { id }                  ({ boxId })         → undefined
//   marketList { item, price }          ({ id, price })     → undefined
//   clanKick   { telegramId }           ({ playerId })      → undefined
//
// Each of those handlers returns silently on its guard clause. Nothing throws,
// nothing is logged, no test fails — the button simply does nothing, and it
// would have been found by players on launch day.
//
// A key the handler ignores is reported too, but only as a note: the client
// sending something the server has stopped trusting is usually the POINT (the
// `amount` on usePotion, the `savedStats` on selectChar). A key the handler
// reads and the client never sends is an error, because it can only be
// undefined.

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// Comments are stripped before anything is scanned. Room.js explains the old
// anti-cheat clamp by quoting `socket.emit('statsUpdate', { atk: 1e6 })` inside
// a comment, and a scanner that reads it reports the server as still emitting
// the event this whole rewrite exists to delete. A checker that cries wolf on
// its own headline finding is worse than one that misses it.
const stripComments = src => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*/g, '$1');
const read = f => stripComments(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const listJs = d => fs.readdirSync(path.join(ROOT, d))
  .filter(f => f.endsWith('.js') && !f.includes('.min.'))
  .map(f => `${d}/${f}`);

// ── what the client sends ───────────────────────────────────────────────────
// The payload is read with a brace counter rather than a regex, so a nested
// object does not truncate the key list — and the WHOLE argument list is
// scanned, because the client writes things like
//   emit('attack', splash ? { enemyId, splash: true } : { enemyId })
// and a parser that only looks for a `{` immediately after the comma reports
// that call as sending nothing. Reporting a mismatch that is not real is worse
// than reporting none: it teaches the reader to skim the output.
//
// `null` means "could not tell" — emit('spawnProj', proj) passes a variable —
// and the shape check skips those rather than guessing.
// Split on commas that are NOT inside brackets. `{ text: text.slice(0, 100) }`
// has one key, not two, and a naive split reports the payload as empty — which
// then reads as a mismatch on an event that is perfectly wired.
function splitTop(src) {
  const out = []; let depth = 0, cur = '';
  for (const ch of src) {
    if ('{[('.includes(ch)) depth++;
    else if ('}])'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function callArgs(src, from) {
  let depth = 1, j = from;
  for (; j < src.length && depth; j++) {
    if (src[j] === '(') depth++;
    else if (src[j] === ')') depth--;
  }
  return src.slice(from, j - 1);
}

function payloadKeys(src, from) {
  const args = callArgs(src, from);
  const keys = new Set();
  let found = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '{') continue;
    let depth = 0, j = i;
    for (; j < args.length; j++) {
      if (args[j] === '{') depth++;
      else if (args[j] === '}') { depth--; if (!depth) break; }
    }
    found = true;
    for (const part of splitTop(args.slice(i + 1, j))) {
      const m = part.match(/^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)\s*(?::|$)/);
      if (m) keys.add(m[1]);
    }
    i = j;
  }
  // An emit with no arguments at all sends an empty payload, which is a fact
  // worth checking. An emit whose argument is a variable is not.
  if (!found) return args.trim() === '' ? new Set() : null;
  return keys;
}

const clientEmits = new Map();   // event -> Set(keys) | null when never literal
for (const f of [...listJs('js'), 'index.html']) {
  const src = read(f);
  const re = /(?:socket|s)\s*\.\s*emit\(\s*'([A-Za-z0-9_]+)'/g;
  let m;
  while ((m = re.exec(src))) {
    const keys = payloadKeys(src, m.index + m[0].length);
    const prev = clientEmits.get(m[1]);
    // Once any call site is unreadable the event's shape is unknown, and it
    // stays unknown: a union with a partial key set would look authoritative.
    if (keys === null || prev === null) { clientEmits.set(m[1], null); continue; }
    clientEmits.set(m[1], prev ? new Set([...prev, ...keys]) : keys);
  }
}

// ── what the server listens for ─────────────────────────────────────────────
const serverOn = new Map();      // event -> Set(keys read from the payload)
for (const f of [...listJs('server/handlers2'), 'server/app.js']) {
  const src = read(f);
  const re = /(?:safeOn|socket\.on)\(\s*'([A-Za-z0-9_]+)'\s*,\s*(?:async\s*)?\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(src))) {
    const arg = m[2].trim();
    const keys = new Set();
    if (arg.startsWith('{')) {
      // The MATCHING brace, not the last one. Every handler is written
      // `({ boxId } = {})`, so lastIndexOf('}') lands on the default value and
      // the slice becomes "boxId } = {" — one blob containing an `=`, which the
      // optional-field rule below then swallowed whole. Every handler read as
      // "reads nothing", and the check went green while six real mismatches sat
      // in front of it. A checker that can pass wrongly is worse than none.
      let depth = 0, close = 0;
      for (let k = 0; k < arg.length; k++) {
        if (arg[k] === '{') depth++;
        else if (arg[k] === '}') { depth--; if (!depth) { close = k; break; } }
      }
      for (const part of splitTop(arg.slice(1, close))) {
        const k = part.match(/^\s*([A-Za-z_$][\w$]*)/);
        // `{ slot = null }` says the handler works without it. That is the
        // convention for an optional field, and it is checkable — unlike a
        // comment saying the same thing.
        if (k && !/=/.test(part)) keys.add(k[1]);
      }
    }
    serverOn.set(m[1], keys);
  }
}

console.log('\nprotocol-check\n');
console.log(`  клієнт шле ${clientEmits.size} подій · сервер слухає ${serverOn.size}\n`);

// Deliberately deleted, with the reason. These must NOT be reinstated: the
// client is what has to stop sending them.
const RETIRED = {
  statsUpdate: 'стати рахує сервер (repos/stats.js) — приймати їх від клієнта означає дозволити собі їх видати',
  saveProgress: 'клієнт більше не володіє станом — жоден блоб не пишеться в базу',
};

// ── every event the client sends has a handler ──────────────────────────────
console.log('  ── покриття ──');
const missing = [...clientEmits.keys()].filter(e => !serverOn.has(e) && !RETIRED[e]).sort();
ok(missing.length === 0, `усі ${clientEmits.size} подій клієнта мають обробник`,
  `без обробника (${missing.length}): ${missing.join(' ')}`);

for (const [e, why] of Object.entries(RETIRED)) {
  ok(!serverOn.has(e), `'${e}' НЕ повернувся на сервер — ${why}`);
}

// ── the handler does not read a key the client never sends ──────────────────
console.log('  ── форма payload ──');
const IGNORE_KEYS = new Set(['']);
let mismatched = 0;
for (const [event, keys] of serverOn) {
  const sent = clientEmits.get(event);
  if (!sent || !keys.size) continue;              // client-less or no payload read
  const unread = [...keys].filter(k => !sent.has(k) && !IGNORE_KEYS.has(k));
  if (unread.length) {
    mismatched++;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${event}: сервер читає {${unread.join(', ')}}, ` +
                `клієнт шле {${[...sent].join(', ')}}`);
  }
}
if (mismatched) { fail++; failures.push('форма payload'); }
else { pass++; console.log('  \x1b[32mPASS\x1b[0m  жоден обробник не читає ключ, якого клієнт не шле'); }

// ── the other direction ─────────────────────────────────────────────────────
// A handler can be perfectly wired and still leave the UI frozen, because the
// ANSWER goes to an event nobody listens for. getRating was exactly that: the
// payload matched, the query ran, and the server replied with 'rating' to a
// client that only ever listened for 'ratingData'. The panel spins forever.
//
// Same rule as above, mirrored: an event the server sends that the client does
// not handle is dead weight at best and a silent hang at worst.
console.log('  ── сервер → клієнт ──');
const clientOn = new Set();
for (const f of [...listJs('js'), 'index.html']) {
  const src = read(f);
  const re = /(?:socket|s)\s*\.\s*on\(\s*'([A-Za-z0-9_]+)'/g;
  let m;
  while ((m = re.exec(src))) clientOn.add(m[1]);
}

const serverEmits = new Map();   // event -> files that send it
for (const f of [...listJs('server/handlers2'), 'server/app.js', 'server/session.js',
                 'server/game/Room.js', 'server/world.js']) {
  const src = read(f);
  const re = /\.\s*emit\(\s*'([A-Za-z0-9_]+)'/g;
  let m;
  while ((m = re.exec(src))) {
    if (!serverEmits.has(m[1])) serverEmits.set(m[1], new Set());
    serverEmits.get(m[1]).add(f.split('/').pop());
  }
}

// socket.io's own signalling, and events the room addresses to a room name
// rather than to a client.
const WIRE = new Set(['connect', 'disconnect', 'connect_error', 'error', 'reconnect']);
// Emitted deliberately for a client that does not handle it YET. Each entry is
// a to-do with a name on it, not a place to file things away: the list is
// printed on every run and the intent is for it to reach zero.
const UNHANDLED_BY_DESIGN = {
  enterLocationDenied: 'клієнт гейтить портали сам (іконка замка) і поки не показує відмову сервера',
  prefsSync: 'підтвердження savePrefs — клієнт ще зберігає налаштування всередині старого блоба',
};

const unheard = [...serverEmits.keys()]
  .filter(e => !clientOn.has(e) && !WIRE.has(e) && !UNHANDLED_BY_DESIGN[e]).sort();
ok(unheard.length === 0, `усі ${serverEmits.size} подій сервера має хто слухати`,
  `нікому не адресовані (${unheard.length}): ` +
  unheard.map(e => `${e} [${[...serverEmits.get(e)].join(',')}]`).join(' · '));

for (const [e, why] of Object.entries(UNHANDLED_BY_DESIGN)) {
  if (serverEmits.has(e)) console.log(`  [33mTODO[0m  ${e} — ${why}`);
}

// ── keys the client sends and the server ignores ────────────────────────────
// A note, not a failure — dropping a client-supplied value is often the fix.
const notes = [];
for (const [event, sent] of clientEmits) {
  const keys = serverOn.get(event);
  if (!keys || !sent || !sent.size) continue;
  const dropped = [...sent].filter(k => !keys.has(k));
  if (dropped.length) notes.push(`${event}: ${dropped.join(', ')}`);
}
if (notes.length) {
  console.log(`\n  примітка — сервер свідомо ігнорує ${notes.length} полів клієнта:`);
  for (const n of notes.slice(0, 40)) console.log(`    · ${n}`);
}

console.log(`\n  ${pass} пройшло, ${fail} впало`);
if (failures.length) console.log('  впали: ' + failures.join(' · '));
process.exit(fail ? 1 : 0);
