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
  // `(data) => ...`, `data => ...` and `() => ...` are all handlers. Requiring
  // the parentheses missed every one written without them — _ping among them,
  // which then read as unhandled.
  const re = /(?:safeOn|socket\.on)\(\s*'([A-Za-z0-9_]+)'\s*,\s*(?:async\s*)?(\([^)]*\)|[A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(src))) {
    let arg = m[2].trim();
    if (arg.startsWith('(')) arg = arg.slice(1, -1).trim();
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
// A SCAN THAT FOUND NOTHING MUST NOT REPORT SUCCESS. Both sizes are printed
// three lines above and neither was asserted on, so a regex that stopped
// matching — the client moving from `socket.emit` to a wrapper, handlers2
// being renamed, safeOn gaining an argument — produced "усі 0 подій клієнта
// мають обробник" and a green run over a protocol nobody looked at. That is
// the hole dev/api-check.js closed after walking sixty-two files and matching
// nothing. The floors are far under the real figures (130 emits, 138 handlers).
ok(clientEmits.size > 50 && serverOn.size > 50,
  `є що перевіряти — ${clientEmits.size} подій клієнта, ${serverOn.size} обробників`,
  'сканування нічого не знайшло — зламана сама перевірка');
const missing = [...clientEmits.keys()].filter(e => !serverOn.has(e) && !RETIRED[e]).sort();
ok(missing.length === 0, `усі ${clientEmits.size} подій клієнта мають обробник`,
  `без обробника (${missing.length}): ${missing.join(' ')}`);

for (const [e, why] of Object.entries(RETIRED)) {
  ok(!serverOn.has(e), `'${e}' НЕ повернувся на сервер — ${why}`);
}

// ── the handler does not read a key the client never sends ──────────────────
console.log('  ── форма payload ──');
const IGNORE_KEYS = new Set(['']);
let mismatched = 0, compared = 0;
for (const [event, keys] of serverOn) {
  const sent = clientEmits.get(event);
  if (!sent || !keys.size) continue;              // client-less or no payload read
  compared++;
  const unread = [...keys].filter(k => !sent.has(k) && !IGNORE_KEYS.has(k));
  if (unread.length) {
    mismatched++;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${event}: сервер читає {${unread.join(', ')}}, ` +
                `клієнт шле {${[...sent].join(', ')}}`);
  }
}
// The `continue` above is what makes this loop able to compare nothing at all
// and still print PASS: a handler whose destructure the parser stops reading
// has `keys.size === 0` and is skipped, and if that happened to every one of
// them — the brace-matching slip described above did exactly that once, and
// six real mismatches sat in front of a green line — nothing is left to
// mismatch. So the number of pairs actually COMPARED is asserted, not just the
// number that disagreed. Sixty-eight pairs today; the floor is a third of it.
ok(compared > 20, `звірено ${compared} пар подія↔payload`,
  'сканування нічого не знайшло — зламана сама перевірка');
if (mismatched) { fail++; failures.push('форма payload'); }
else { pass++; console.log(`  \x1b[32mPASS\x1b[0m  жоден із ${compared} обробників не читає ключ, якого клієнт не шле`); }

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
  // `once` is listening too. worldMap is requested and awaited exactly once
  // per floor, with socket.once — reading only `.on` reported the server as
  // shouting into the void about the one event the client asks for by name.
  const re = /(?:socket|s)\s*\.\s*(?:on|once)\(\s*'([A-Za-z0-9_]+)'/g;
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
// enterLocationDenied left this list the way an exemption is supposed to: the
// client handles it now. It was never only cosmetic — _requestEnterLocation
// (js/game.js) raises the floor-loading overlay before the request goes out,
// and nothing but a gameStart takes it down, so a refused portal left the
// player on a full-screen "Ожидание сервера..." until they reloaded.
const UNHANDLED_BY_DESIGN = {
  prefsSync: 'підтвердження savePrefs — клієнт ще зберігає налаштування всередині старого блоба',
};

// Same guard, mirrored: an empty `serverEmits` has nothing that can be
// unheard, and an empty `clientOn` makes EVERY server event unheard — the
// second fails loudly, the first passes silently, and it is the silent one
// that needs the floor. (127 emits, 193 listeners today.)
ok(serverEmits.size > 50 && clientOn.size > 50,
  `є що перевіряти — ${serverEmits.size} подій сервера, ${clientOn.size} слухачів клієнта`,
  'сканування нічого не знайшло — зламана сама перевірка');
const unheard = [...serverEmits.keys()]
  .filter(e => !clientOn.has(e) && !WIRE.has(e) && !UNHANDLED_BY_DESIGN[e]).sort();
ok(unheard.length === 0, `усі ${serverEmits.size} подій сервера має хто слухати`,
  `нікому не адресовані (${unheard.length}): ` +
  unheard.map(e => `${e} [${[...serverEmits.get(e)].join(',')}]`).join(' · '));

for (const [e, why] of Object.entries(UNHANDLED_BY_DESIGN)) {
  if (serverEmits.has(e)) console.log(`  [33mTODO[0m  ${e} — ${why}`);
}

// ── the server's own wiring ─────────────────────────────────────────────────
// Two lists inside server/app.js name socket events, and a name in either one
// is a claim about a handler that exists. Both were quietly wrong, and neither
// could be wrong LOUDLY: a Set lookup that misses just returns false.
console.log('  ── власна проводка сервера ──');
{
  const appSrc = read('server/app.js');

  const heavyBlock = (appSrc.match(/const HEAVY = new Set\(\[([\s\S]*?)\]\);/) || [])[1] || '';
  const heavy = [...heavyBlock.matchAll(/'([A-Za-z0-9_]+)'/g)].map(m => m[1]);
  // A SCAN THAT FOUND NOTHING MUST NOT REPORT SUCCESS — same rule as the three
  // floors above. `[].filter(...)` is empty, so a regex that stopped matching
  // (HEAVY renamed, reformatted, moved out of app.js) would print a green line
  // about a list it never read. Seventy-odd names today.
  ok(heavy.length > 40, `є що перевіряти — ${heavy.length} імен у HEAVY`,
    'сканування нічого не знайшло — зламана сама перевірка');
  // 'balanceHistory' named nothing in either build, and 'craft' was split into
  // craftGear/craftClassGear/craftBox/craftPet/craftMatUpgrade long before this
  // list was copied across. So the forge and the pet crafter — which spend
  // Liberty and destroy materials — sat in the 1500-per-5s bucket while the
  // list read as though crafting were rate-limited.
  const heavyGhosts = heavy.filter(e => !serverOn.has(e)).sort();
  ok(heavyGhosts.length === 0,
    `усі ${heavy.length} імен у HEAVY мають зареєстрований обробник`,
    `нікого не обмежують (${heavyGhosts.length}): ${heavyGhosts.join(' ')}`);

  // RL_ERR_EVENT is where a THROWN-AWAY packet is answered, and it answers on
  // the panel's own channel so the button it disabled comes back. A channel
  // the client does not listen for turns that back into the bare `return` it
  // replaced — the refusal is on the wire and addressed to nobody.
  const rlBlock = (appSrc.match(/const RL_ERR_EVENT = new Map\(\);[\s\S]*?\}\)\)/) || [])[0] || '';
  const rlChannels = [...rlBlock.matchAll(/^\s{2}([A-Za-z0-9_]+):\s*\[/gm)].map(m => m[1]);
  ok(rlChannels.length > 10, `є що перевіряти — ${rlChannels.length} каналів у RL_ERR_EVENT`,
    'сканування нічого не знайшло — зламана сама перевірка');
  const rlDeaf = rlChannels.filter(c => !clientOn.has(c)).sort();
  ok(rlDeaf.length === 0,
    `усі ${rlChannels.length} каналів RL_ERR_EVENT має хто слухати`,
    `нікому не адресовані (${rlDeaf.length}): ${rlDeaf.join(' ')}`);

  // ── a tuning constant with no reader tunes nothing ────────────────────────
  // COOP_LIBERTY_CHANCE was declared inside server/game/coop.js, returned by
  // that factory, and read by nobody in the live build. That is NOT the same
  // as "the drop never happens", which is the easy conclusion and the wrong
  // one: the kill-reward ladder simply had no co-op branch, so a co-op kill
  // fell through to the corridor table and paid NEXUM_DROP_CHANCE[arm] —
  // 0.5% on stage one against the 10% the constant states. Twenty times too
  // little, off a number nothing was reading, in the mode's ONLY per-kill
  // reward (no gold, no GRAM — see calcGoldDrop's `arm === 'coop'` branch).
  const worldSrc = read('server/handlers2/world.js');
  const ladder = (worldSrc.match(/const libertyChance = [\s\S]*?;\n/) || [])[0] || '';
  ok(ladder.length > 0, 'є що перевіряти — знайдено драбину шансу Liberty',
    'сканування нічого не знайшло — зламана сама перевірка');
  ok(/coop/.test(ladder) && /COOP_LIBERTY_CHANCE/.test(ladder),
    'кожна зона з власним шансом Liberty має власну гілку (coop, farm2, коридори)',
    `кооператив падає в коридорну таблицю: ${ladder.replace(/\s+/g, ' ').slice(0, 170)}`);
  // And exactly one definition of it, in the catalog both halves already read.
  // A per-run factory is not somewhere a kill-reward handler can look.
  const coopDefs = ['server/game/coop.js', 'shared/definitions.js']
    .filter(f => /const COOP_LIBERTY_CHANCE\s*=/.test(read(f)));
  ok(coopDefs.length === 1 && coopDefs[0] === 'shared/definitions.js',
    'і константа лежить у каталозі, звідки обробник її й бере',
    `оголошена в: ${coopDefs.join(', ') || '(ніде)'}`);

  // ── a grace period must have a claim ──────────────────────────────────────
  // Страх holds a disconnected entrant's run for FEAR_RECONNECT_GRACE_MS. The
  // hold was ported; the CLAIM was not — so _fearDisconnectGrace was written
  // on disconnect, expired 45s later, and read by nothing in between. That is
  // a delayed deletion wearing the word "grace": a player who reconnected well
  // inside the window came back with no run at all — the wave never advanced
  // again (_fearTrackKill returns on `!run`), fearSync answered inRun:false,
  // and dying in the hall did not even end it, with the attempt already spent.
  //
  // The client has expected the claim to work since it was written: its
  // gameStart handler restores the wave HUD from the `fear` block and says so
  // in as many words (js/network.js). It was reading a field nothing filled.
  //
  // Checked as three links rather than one grep, because each can break alone.
  const fearSrc = read('server/game/fear.js');
  const h2 = listJs('server/handlers2').map(read).join('\n');
  ok(/function _fearClaimOnReconnect\s*\(/.test(fearSrc)
     && /_fearClaimOnReconnect,/.test(fearSrc),
    'Страх: утримання має чим забиратись назад (_fearClaimOnReconnect, експортована)',
    'без неї _fearDisconnectGrace лише пишеться і протухає');
  ok(/_fearClaimOnReconnect\(/.test(h2),
    'і хтось у handlers2 справді її кличе на вході в гру',
    'експортована, але не викликана — те саме, що її нема');
  ok(/_fearResumeRun\(/.test(h2) && /_fearStartWave\(/.test(h2),
    'і повертає забіг живому сокету (_fearResumeRun / _fearStartWave)',
    'забрати утримання і не покласти його назад — це та сама втрата, лише швидша');
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
