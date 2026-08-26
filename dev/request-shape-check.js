#!/usr/bin/env node
'use strict';
// ── Does the client SEND what the server READS? ─────────────────────────────
//
//   node dev/request-shape-check.js
//
// The mirror of dev/reply-shape-check.js, and the half that was missing.
//
// reply-shape-check walks server → client: the server emits an event and the
// client destructures fields out of it. It found `authOk` arriving with six
// fields fewer than the client read, which showed up as "VIP resets on every
// reload", "rewards can't be claimed" and an empty clan panel — one bug that
// looked like four.
//
// Nothing walked the other direction. A handler destructuring a field the
// client has never sent gets `undefined`, and `undefined` does not throw: it
// falls through a `||` default, or resolves to "whichever row matches", or
// simply makes the branch not fire. The button works, does something slightly
// different from what was asked, and nobody can see why.
//
// That is exactly where the enhancement bug lived. The handler read
//
//     safeOn('enhanceItem', ({ id, enhance, stoneType, slot, rowId }) => ...)
//
// and the client sent everything but `rowId`, because _rebuildFromCatalog
// dropped it. With no row id the server took whichever row matched (id,
// enhance) — so enhancing one item walked every identical copy up alongside
// it, one click apart.
//
// Two questions, both worth answering:
//
//   MISSING  the server destructures a field no emit of that event carries.
//            Silent wrong behaviour.
//   UNREAD   the client sends a field no handler for that event reads. Either
//            a rename that only landed on one side, or dead weight on the
//            wire — and the first is a bug hiding as the second.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const GRN = '\x1b[32m', RED = '\x1b[31m', YEL = '\x1b[33m', DIM = '\x1b[2m', OFF = '\x1b[0m';

// Comments are prose about the wire format, written right next to the code
// that implements it. Reading them as code reports events deleted years ago.
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

// The retired Mongo build. reachable-check proves none of it is loaded.
const RETIRED = /[\\/](handlers|models)[\\/]|[\\/]index\.js$/;

// Keys of one object literal, one level deep. Nested objects are skipped
// rather than guessed at: `{ a, b: { c } }` yields a and b.
// `optional` collects the keys written with a DEFAULT — `{ qty = 1 }`. That is
// the author saying in the code itself that the field may be absent, and it is
// a different contract from `{ qty }`, which says it must be there. The first
// run of this reported three such fields as missing; treating them as bugs is
// how a checker earns its way into being ignored.
function keysOf(objSrc, optional) {
  const keys = [];
  let depth = 0, i = 0;
  let token = '';
  const flush = () => {
    const m = /^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(token);
    if (m && depth === 0) {
      keys.push(m[1]);
      if (optional && /=/.test(token.slice(m[0].length))) optional.add(m[1]);
    }
    token = '';
  };
  for (; i < objSrc.length; i++) {
    const ch = objSrc[i];
    if (ch === '{' || ch === '[' || ch === '(') { depth++; token += ch; continue; }
    if (ch === '}' || ch === ']' || ch === ')') { depth--; token += ch; continue; }
    if (ch === ',' && depth === 0) { flush(); continue; }
    if (ch === ':' && depth === 0) {
      // `name: value` — the KEY is what travels. Take it and skip the value.
      flush();
      let d2 = 0;
      for (i++; i < objSrc.length; i++) {
        const c2 = objSrc[i];
        if (c2 === '{' || c2 === '[' || c2 === '(') d2++;
        else if (c2 === '}' || c2 === ']' || c2 === ')') d2--;
        else if (c2 === ',' && d2 === 0) break;
      }
      continue;
    }
    token += ch;
  }
  flush();
  return keys;
}

// The text of a balanced {...} starting at `from`.
function braceBlock(src, from) {
  if (src[from] !== '{') return null;
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) return src.slice(from + 1, i); }
  }
  return null;
}

// ── what the client sends ───────────────────────────────────────────────────
// socket.emit('name', { … })  /  s.emit('name', { … })
function clientSends() {
  const out = new Map();          // event -> Set(keys)
  const where = new Map();        // event -> file:line
  for (const f of walk(path.join(ROOT, 'js'))) {
    const src = strip(fs.readFileSync(f, 'utf8'));
    const re = /\b(?:socket|s|sock)\??\.emit\(\s*'([^']+)'\s*,\s*\{/g;
    let m;
    while ((m = re.exec(src))) {
      const body = braceBlock(src, re.lastIndex - 1);
      if (body === null) continue;
      const set = out.get(m[1]) || new Set();
      keysOf(body).forEach(k => set.add(k));
      out.set(m[1], set);
      if (!where.has(m[1])) {
        where.set(m[1], `${path.relative(ROOT, f).replace(/\\/g, '/')}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
    // An emit with no object at all still names the event.
    const re2 = /\b(?:socket|s|sock)\??\.emit\(\s*'([^']+)'\s*\)/g;
    while ((m = re2.exec(src))) if (!out.has(m[1])) out.set(m[1], new Set());
  }
  return { out, where };
}

// ── what the server reads ───────────────────────────────────────────────────
// safeOn('name', ({ … }) => …)  — the destructure IS the contract.
function serverReads() {
  const out = new Map();          // event -> Set(keys)
  const opt = new Map();          // event -> Set(keys written with a default)
  const where = new Map();
  for (const f of walk(path.join(ROOT, 'server'))) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    if (RETIRED.test(rel.replace(/\//g, path.sep))) continue;
    const src = strip(fs.readFileSync(f, 'utf8'));
    const re = /\bsafeOn\(\s*'([^']+)'\s*,\s*(?:async\s*)?\(\s*\{/g;
    let m;
    while ((m = re.exec(src))) {
      const body = braceBlock(src, re.lastIndex - 1);
      if (body === null) continue;
      const set = out.get(m[1]) || new Set();
      const optSet = opt.get(m[1]) || new Set();
      keysOf(body, optSet).forEach(k => set.add(k));
      out.set(m[1], set);
      opt.set(m[1], optSet);
      where.set(m[1], `${rel}:${src.slice(0, m.index).split('\n').length}`);
    }
    // Handlers that take no payload, or take it whole.
    const re2 = /\bsafeOn\(\s*'([^']+)'\s*,\s*(?:async\s*)?\(?\s*(?:\)|[A-Za-z_$][\w$]*\s*[=)])/g;
    while ((m = re2.exec(src))) {
      if (!out.has(m[1])) { out.set(m[1], null); where.set(m[1], `${rel}`); }
    }
  }
  return { out, opt, where };
}

function main() {
  console.log('\nrequest-shape-check\n');
  const sends = clientSends();
  const reads = serverReads();

  // A SCAN THAT FOUND NOTHING MUST NOT REPORT SUCCESS. The exit code below is
  // `missing.length ? 1 : 0`, and `missing` is filled inside a loop over
  // `sends.out` — so an empty scan exits 0 with a clean-looking report, and
  // every way of emptying it is silent: the client moving off `socket.emit`,
  // server/handlers2 renamed, one character wrong in a regex. That is what
  // dev/api-check.js closed after walking sixty-two files, matching nothing
  // and printing a cheerful PASS.
  //
  // Failing here rather than after the loop, because with nothing scanned the
  // rest of the report is a description of an empty set.
  if (sends.out.size < 40 || reads.out.size < 40) {
    console.log(`${RED}сканування нічого не знайшло — зламана сама перевірка${OFF}`);
    console.log(`  клієнт шле ${sends.out.size} подій · сервер читає ${reads.out.size}\n`);
    process.exitCode = 1;
    return;
  }
  console.log(`  ${DIM}клієнт шле ${sends.out.size} подій · сервер читає ${reads.out.size}${OFF}\n`);

  let clean = 0;
  const missing = [];     // server reads it, client never sends it
  const unread = [];      // client sends it, server never reads it
  const noHandler = [];

  for (const [event, sentKeys] of sends.out) {
    if (!reads.out.has(event)) { noHandler.push(`${event}  ${DIM}(${sends.where.get(event)})${OFF}`); continue; }
    const readKeys = reads.out.get(event);
    if (readKeys === null) { clean++; continue; }    // takes the payload whole

    const optional = reads.opt.get(event) || new Set();
    const miss = [...readKeys].filter(k => !sentKeys.has(k) && !optional.has(k));
    const extra = [...sentKeys].filter(k => !readKeys.has(k));
    if (miss.length) missing.push(`${event}: ${miss.join(', ')}  ${DIM}${reads.where.get(event)}${OFF}`);
    if (extra.length) unread.push(`${event}: ${extra.join(', ')}  ${DIM}${sends.where.get(event)}${OFF}`);
    if (!miss.length && !extra.length) clean++;
  }

  if (missing.length) {
    console.log(`${RED}сервер читає поле, якого клієнт не шле${OFF} — тихо undefined:`);
    for (const l of missing) console.log(`  ${RED}✗${OFF} ${l}`);
    console.log('');
  }
  if (unread.length) {
    console.log(`${YEL}клієнт шле поле, якого сервер не читає${OFF} — або перейменування на одному кінці, або баласт:`);
    for (const l of unread) console.log(`  ${YEL}·${OFF} ${l}`);
    console.log('');
  }
  if (noHandler.length) {
    console.log(`${DIM}подія без обробника (можливо, обробляється не через safeOn):${OFF}`);
    for (const l of noHandler) console.log(`  ${DIM}?${OFF} ${l}`);
    console.log('');
  }

  console.log(`  ${GRN}${clean} збігається${OFF}`
    + ` · ${missing.length ? RED : DIM}${missing.length} без поля${OFF}`
    + ` · ${unread.length ? YEL : DIM}${unread.length} зайвих${OFF}`
    + ` · ${DIM}${noHandler.length} без обробника${OFF}\n`);

  // Only MISSING fails the run. An unread field is worth looking at and is not
  // by itself broken — a client may legitimately send more than one handler
  // version needs.
  process.exitCode = missing.length ? 1 : 0;
}

main();
