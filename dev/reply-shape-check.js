#!/usr/bin/env node
'use strict';
// ── Does the server SEND what the client READS? ─────────────────────────────
//
//   node dev/reply-shape-check.js
//
// dev/protocol-check.js compares event NAMES, and the keys of what the client
// SENDS. It cannot see the other half: a server that emits the right event
// with the wrong keys passes it. That gap is not theoretical — `authOk` was
// emitted under exactly the right name, arrived, and carried six fields fewer
// than the client destructures out of it. The player-visible result was "VIP
// resets on every reload", "rewards can't be claimed", "clan panel is empty"
// and a broken referral link, none of which look like one bug.
//
// So: for every `socket.on('name', ({ a, b, c }) => …)` in the client, find
// every `emit('name', { … })` in the server and diff the key sets.
//
// What this deliberately does NOT do is prove a key is USED correctly. It
// proves the field exists on the wire. That is the failure mode this class of
// bug has: the value is `undefined`, every `||` fallback fires, and the screen
// shows a consistent, plausible, wrong state.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CLIENT = ['js', 'shared'];
const SERVER = ['server'];

// ── reading source without executing it ─────────────────────────────────────
// Comments are stripped first. Both halves of this codebase document the wire
// format in prose right next to the code, and an earlier version of the
// name-checker read those comments as code and reported events that had been
// deleted years ago.
function strip(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); }
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// Balanced-brace scan from an opening `{`. Returns the literal's source.
function braceSpan(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) return src.slice(open, i + 1); }
    // Strings and template literals can hold braces; skip them wholesale.
    else if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
    }
  }
  return null;
}

// Top-level keys of an object literal — `{ a, b: 1, ...rest, [k]: v }` gives
// ['a','b'] plus the spread/computed flags, because those two mean "this tool
// cannot see the whole shape" and the answer has to say so rather than guess.
function literalKeys(lit) {
  const inner = lit.slice(1, -1);
  const keys = [];
  let spread = false, computed = false;
  let depth = 0, i = 0, tokenStart = 0;
  const flush = (end) => {
    const part = inner.slice(tokenStart, end).trim();
    tokenStart = end + 1;
    if (!part) return;
    if (part.startsWith('...')) { spread = true; return; }
    if (part.startsWith('[')) { computed = true; return; }
    const m = /^(?:async\s+)?(?:get\s+|set\s+)?['"]?([A-Za-z_$][\w$]*)['"]?\s*(?::|\(|$)/.exec(part);
    if (m) keys.push(m[1]);
  };
  for (; i < inner.length; i++) {
    const c = inner[i];
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < inner.length && inner[i] !== q) { if (inner[i] === '\\') i++; i++; }
    }
    else if (c === ',' && depth === 0) flush(i);
  }
  flush(inner.length);
  return { keys, spread, computed };
}

// ── what the client reads ───────────────────────────────────────────────────
// Only the destructured form is understood. `(data) => …` hands the whole
// object to a body this tool would have to interpret, so those are counted and
// reported as unchecked rather than silently passed.
// The parameter destructure of a top-level client function, by name. Used to
// follow a handler that hands its payload straight to one — see the comment at
// the delegation branch below.
const _clientSrc = [];
for (const dir of CLIENT) {
  for (const file of walk(path.join(ROOT, dir))) {
    _clientSrc.push(strip(fs.readFileSync(file, 'utf8')));
  }
}
// Found by scanning rather than by a built regex: `new RegExp('function\s+'
// + name)` is a string literal, so the backslash-s is just an `s` unless it is
// doubled, and the pattern quietly becomes `functions+onClanData`. Plain
// indexOf has no escaping to get wrong.
function destructureOf(fnName) {
  const needle = `function ${fnName}(`;
  for (const src of _clientSrc) {
    const at = src.indexOf(needle);
    if (at < 0) continue;
    // The parameter list must OPEN with a destructure for the shape to be
    // readable; `function f(data)` tells us nothing.
    const open = src.indexOf('{', at + needle.length - 1);
    if (open < 0 || src.slice(at + needle.length, open).trim() !== '') continue;
    const lit = braceSpan(src, open);
    if (!lit) continue;
    return new Set(literalKeys(lit).keys);
  }
  return null;
}

const clientReads = new Map();   // event -> { keys:Set, files:Set }
const clientOpaque = new Map();  // event -> Set(files)

for (const dir of CLIENT) {
  for (const file of walk(path.join(ROOT, dir))) {
    const src = strip(fs.readFileSync(file, 'utf8'));
    const rel = path.relative(ROOT, file);
    const re = /\b(?:socket|s|sock|_s)\.on\(\s*(['"])([\w:.-]+)\1\s*,\s*(?:async\s*)?\(?\s*/g;
    let m;
    while ((m = re.exec(src))) {
      const event = m[2];
      const after = src.slice(re.lastIndex);
      if (after[0] === '{') {
        const lit = braceSpan(src, re.lastIndex);
        if (!lit) continue;
        const { keys } = literalKeys(lit);
        if (!clientReads.has(event)) clientReads.set(event, { keys: new Set(), files: new Set() });
        const rec = clientReads.get(event);
        keys.forEach(k => rec.keys.add(k));
        rec.files.add(rel);
      } else {
        // ── one hop further ─────────────────────────────────────────────────
        // `s.on('enhanceResult', (data) => onEnhanceResult(data))` destructures
        // nothing HERE, and this counted it as opaque and moved on. The
        // destructure is one line away, in the function it hands the payload
        // to — and that is where the contract actually lives.
        //
        // It cost a real bug. The server emitted `{ outcome, rowId, from, to,
        // rate }`; onEnhanceResult reads `{ id, slot, outcome, newEnhance }`.
        // So the enhancement toast said "+undefined" and the item card never
        // reopened — "все работает правильно, просто ui не меняется" — while
        // this file reported 134 clean and counted the event as unchecked.
        //
        // Only the simple shape is followed: a body that is exactly one call
        // passing the payload straight through. Anything else stays opaque,
        // because guessing is how a checker starts lying.
        // Written without a backreference: the payload name and the argument
        // are captured separately and compared in code. A backslash-1 inside a
        // regex literal is one transcription slip from silently matching nothing,
        // which is exactly how this branch did nothing on its first run.
        const call = /^\(?\s*(\w+)\s*\)?\s*=>\s*\{?\s*(?:if\s*\([^)]*\)\s*)?(\w+)\s*\(\s*(\w+)\s*\)/
          .exec(after);
        const fnKeys = (call && call[3] === call[1]) ? destructureOf(call[2]) : null;
        if (fnKeys && fnKeys.size) {
          if (!clientReads.has(event)) clientReads.set(event, { keys: new Set(), files: new Set() });
          const rec = clientReads.get(event);
          fnKeys.forEach(k => rec.keys.add(k));
          rec.files.add(rel);
        } else {
          if (!clientOpaque.has(event)) clientOpaque.set(event, new Set());
          clientOpaque.get(event).add(rel);
        }
      }
    }
  }
}

// ── what the server sends ───────────────────────────────────────────────────
const serverSends = new Map();   // event -> { keys:Set, spread:bool, nonLiteral:bool, files:Set }

for (const dir of SERVER) {
  for (const file of walk(path.join(ROOT, dir))) {
    const rel = path.relative(ROOT, file);
    // The Mongo-era handlers are still in the tree and are not what runs.
    if (/[\\/]handlers[\\/]/.test(rel) || /[\\/]models[\\/]/.test(rel)) continue;
    if (rel === path.join('server', 'index.js')) continue;
    const src = strip(fs.readFileSync(file, 'utf8'));

    // Every handler's error channel is `s.act(name, errEvent, fn)`, and act()
    // emits `{ msg, code }` under whatever name it was handed. The emit itself
    // is `emit(errEvent, …)` — a variable — so scanning for emits alone
    // reported all 30-odd of them as "never sent", which is exactly the kind of
    // noise that hides the three real ones.
    const act = /\.act\(\s*['"][\w.-]+['"]\s*,\s*(['"])([\w:.-]+)\1\s*,/g;
    let a;
    while ((a = act.exec(src))) {
      const event = a[2];
      if (!serverSends.has(event)) {
        serverSends.set(event, { keys: new Set(), spread: false, nonLiteral: false, files: new Set() });
      }
      const rec = serverSends.get(event);
      rec.keys.add('msg'); rec.keys.add('code');
      rec.files.add('session.act');
    }

    // `emitNearby(x, y, 'name', payload)` is an emit too — it is how every
    // skill visual reaches the dozen people who can see it, and reading only
    // `.emit(` reported all of those as never sent.
    const src2 = src.replace(
      /emitNearby\(\s*[^,]+,\s*[^,]+,\s*(['"])([\w:.-]+)\1\s*,/g,
      (_, q, name) => `.emit(${q}${name}${q}, `
    );

    const re = /\.emit\(\s*(['"])([\w:.-]+)\1\s*(,|\))/g;
    let m;
    while ((m = re.exec(src2))) {
      const event = m[2];
      if (!serverSends.has(event)) {
        serverSends.set(event, { keys: new Set(), spread: false, nonLiteral: false, files: new Set() });
      }
      const rec = serverSends.get(event);
      rec.files.add(rel);
      if (m[3] === ')') continue;                       // emitted with no payload
      const rest = src2.slice(re.lastIndex);
      const lead = rest.match(/^\s*/)[0].length;
      if (rest[lead] === '{') {
        const lit = braceSpan(src2, re.lastIndex + lead);
        if (!lit) { rec.nonLiteral = true; continue; }
        const { keys, spread, computed } = literalKeys(lit);
        keys.forEach(k => rec.keys.add(k));
        if (spread || computed) rec.spread = true;
      } else {
        rec.nonLiteral = true;                          // a variable, a call, an await
      }
    }
  }
}

// ── client handlers with no server counterpart, on purpose ──────────────────
// Each of these was checked against the OLD build too (server/index.js and
// server/handlers/, still in the tree): none of them was ever emitted there
// either. They are client code waiting for a feature that does not exist, and
// listing them here is what keeps a genuine new regression visible instead of
// buried in permanent ones. It was four; seasonQuestDone and stoneCrafted left
// when their client handlers did, which is the outcome this list is for — an
// exemption should end by the thing being deleted, not by living here forever.
const KNOWN_DEAD = new Set([
  'eventBossAnnounce',  // the countdown rides on gameStart's eventBoss.nextAt
  'spawnAoe',           // AoE now streams inside the world packet (queueAoe)
]);

// ── the diff ────────────────────────────────────────────────────────────────
let broken = 0, unsent = 0, unchecked = 0, clean = 0, dead = 0;
const RED = '\x1b[31m', YEL = '\x1b[33m', GRN = '\x1b[32m', DIM = '\x1b[2m', OFF = '\x1b[0m';

const names = [...clientReads.keys()].sort();
console.log(`\n${names.length} destructured client handlers, ${serverSends.size} server emits\n`);

// ── A SCAN THAT FOUND NOTHING MUST NOT REPORT SUCCESS ───────────────────────
// Both numbers were printed on the line above and neither was ever a condition
// for anything. This file's exit code is `broken || unsent`, and both are
// counted inside a loop over `names` — so an empty `names` exits 0, and every
// way of emptying it is a silent one: the `s.on(...)` regex ceasing to match
// after a rename, js/ moving, strip() eating a file. The same failure the
// enhanceResult bug rode in on, one level up — that one reported 134 clean
// while counting the broken event as unchecked.
//
// The floors are a third of the real figures, so ordinary churn never reaches
// them and only a scanner that has stopped working can.
let scanBroken = 0;
if (names.length < 40 || serverSends.size < 40) {
  scanBroken = 1;
  console.log(`${RED}SCAN BROKEN${OFF} nothing to compare — `
    + `${names.length} client handlers, ${serverSends.size} server emits. `
    + `The check itself is what is failing here, not the protocol.\n`);
}

for (const event of names) {
  const want = clientReads.get(event);
  const have = serverSends.get(event);
  if (!have) {
    if (KNOWN_DEAD.has(event)) { dead++; continue; }
    unsent++;
    console.log(`${YEL}NEVER SENT${OFF}  ${event}  ${DIM}(client reads ${[...want.keys].join(', ')})${OFF}`);
    continue;
  }
  if (have.nonLiteral || have.spread) {
    unchecked++;
    continue;                                            // reported in the tail
  }
  const missing = [...want.keys].filter(k => !have.keys.has(k));
  if (missing.length) {
    broken++;
    console.log(`${RED}MISSING${OFF}     ${event}`);
    console.log(`            client wants: ${[...want.keys].join(', ')}`);
    console.log(`            server sends: ${[...have.keys].join(', ') || '(nothing)'}`);
    console.log(`            ${RED}absent: ${missing.join(', ')}${OFF}`);
    console.log(`            ${DIM}${[...want.files].join(' ')} <- ${[...have.files].join(' ')}${OFF}`);
  } else clean++;
}

if (unchecked) {
  console.log(`\n${DIM}${unchecked} events emitted with a spread or a variable payload — shape not statically visible:${OFF}`);
  const list = names.filter(e => {
    const h = serverSends.get(e);
    return h && (h.nonLiteral || h.spread);
  });
  for (const e of list) {
    const h = serverSends.get(e);
    const w = clientReads.get(e);
    const missing = [...w.keys].filter(k => !h.keys.has(k));
    console.log(`  ${e}${missing.length ? `  ${YEL}not in the literal: ${missing.join(', ')}${OFF}` : ''}`);
  }
}

console.log(`\n${GRN}${clean} clean${OFF} · ${RED}${broken} missing fields${OFF} · ${YEL}${unsent} never sent${OFF} · ${DIM}${unchecked} unverifiable${OFF}`);
console.log(`${DIM}${clientOpaque.size} handlers take the payload whole and are not checked here.${OFF}\n`);
// A new gap in either column is a regression, and this is the gate for it —
// and so is a scan that had nothing to look at, which used to exit 0.
process.exit(broken || unsent || scanBroken ? 1 : 0);
