#!/usr/bin/env node
'use strict';
// ── LEGACY: this checks the RETIRED Mongo build ─────────────────────────────
//
//   CHECK_LEGACY=1 node dev/xp-ledger-check.js
//
// It lifts its subject out of server/index.js and server/handlers/ — the old
// build, kept in the tree as a reference while the PostgreSQL one is finished.
// systemd runs server/app.js, and a reachability walk of the require graph
// from there loads 57 files and NONE of these: the old build is present, and
// it is not what runs.
//
// So its failures describe code nobody executes, and reading them as live
// defects is exactly the confusion the two builds sitting side by side
// creates. The equivalents for the running build are dev/items-check.js,
// dev/market-check.js, dev/money-check.js and dev/play-check.js.
//
// It refuses to run rather than reporting green, because a suite that passes
// without checking anything is worse than one that is switched off.
if (!process.env.CHECK_LEGACY) {
  console.log(`
  xp-ledger-check.js — SKIPPED (retired Mongo build; CHECK_LEGACY=1 to run)
`);
  process.exit(0);
}
// Regression check for the XP/level entitlement ledger.
//
//   node dev/xp-ledger-check.js        (no server, no database)
//
// Level is what every permanent combat stat is derived from (see
// _sanitizeSavedStats, which recomputes baseAtk/baseDef/baseMaxHp from it) and
// what sets the upgrade-point budget, and it used to arrive from the client
// bounded by nothing but a ceiling of 1000 — against content that stops at
// MAX_MONSTER_LEVEL 78.
//
// The server computes every point of XP it hands out, so instead of guessing a
// rate (as the gold cap has to) it counts, banking each grant at the most
// generous multiplier a client could legitimately apply. This checks the two
// halves that have to hold: an honest player is never touched, and a forged
// level cannot survive.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { xpToNext, xpTotalAt, xpAtLevel } = require(path.join(ROOT, 'shared', 'definitions.js'));
const SRC = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');

const num = name => {
  const m = SRC.match(new RegExp(`^const ${name}\\s*=\\s*([0-9.]+)`, 'm'));
  if (!m) throw new Error(`xp-ledger-check: ${name} not found in server/index.js`);
  return Number(m[1]);
};
const XP_CLAN_MAX_PCT     = num('XP_CLAN_MAX_PCT');
const XP_POTION_MULT      = num('XP_POTION_MULT');
const XP_JOIN_SLACK_KILLS = num('XP_JOIN_SLACK_KILLS');
// Mirrors _xpCeilingFor: the client's own order and rounding, not a flat 2.4×.
const ceilingFor = n => Math.round(n * (1 + XP_CLAN_MAX_PCT / 100)) * XP_POTION_MULT;

const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

// ── The curve both sides now share ──────────────────────────────────────────
// The server derives xpNext instead of accepting it; that is only safe while
// its curve is the one the client actually climbs.
{
  let lvl = 1, xpNext = 100, mismatch = null;
  for (let i = 0; i < 80 && !mismatch; i++) {
    if (xpToNext(lvl) !== xpNext) mismatch = `lvl ${lvl}: client ${xpNext}, shared ${xpToNext(lvl)}`;
    lvl++;
    let m = lvl > 5 ? 3 : 1;
    if (lvl > 20) m *= 1.6;
    xpNext = Math.floor(Math.floor(100 * Math.pow(1.38, lvl - 1)) * m);
  }
  check('shared xpToNext matches the client level-up loop for lvl 1..80',
    !mismatch, mismatch || '');

  check('server derives xpNext instead of trusting the save',
    /s\.xpNext = xpToNext\(s\.lvl\)/.test(SRC),
    'a save claiming xpNext:1 levels up on every point of XP');

  const clientSrc = fs.readFileSync(path.join(ROOT, 'js', 'player.js'), 'utf8');
  check('client no longer restores xpNext from the save blob',
    !/player\.xpNext\s*=\s*data\.xpNext/.test(clientSrc)
      && /player\.xpNext\s*=\s*xpToNext\(player\.lvl\)/.test(clientSrc),
    'js/player.js restoreFromSave');
}

// ── Honest play is never clamped ────────────────────────────────────────────
// Replay a real session: the server grants xpAtLevel(monster) per kill and
// banks it at the ceiling multiplier; the client applies the real multipliers
// (max clan bonus + XP potion) and levels up on its own curve. The client's
// claim must stay inside the entitlement at every single save.
function simulate({ startLvl, kills, monsterLvl, clanXpPct, potion }) {
  let allowed = xpTotalAt(startLvl, 0) + ceilingFor(XP_JOIN_SLACK_KILLS * xpAtLevel(startLvl));
  let lvl = startLvl, xp = 0, worst = Infinity;
  for (let i = 0; i < kills; i++) {
    const granted = xpAtLevel(monsterLvl);
    allowed += ceilingFor(granted);                         // what the server banks
    let got = Math.round(granted * (1 + clanXpPct / 100));  // what the client applies
    if (potion) got *= 2;
    xp = Math.round(xp + got);
    while (xp >= xpToNext(lvl)) { xp -= xpToNext(lvl); lvl++; }
    worst = Math.min(worst, allowed - xpTotalAt(lvl, xp));
  }
  return { lvl, xp, headroom: worst };
}

const honest = [
  { label: 'solo, no clan, no potion',      clanXpPct: 0,  potion: false },
  { label: 'max clan bonus + XP potion',    clanXpPct: 20, potion: true  },
  { label: 'max clan bonus, no potion',     clanXpPct: 20, potion: false },
];
for (const h of honest) {
  const r = simulate({ startLvl: 12, kills: 4000, monsterLvl: 30, ...h });
  check(`honest player is never clamped — ${h.label}`,
    r.headroom >= 0,
    `reached lvl ${r.lvl}; entitlement fell short by ${Math.round(-r.headroom)} XP`);
}

// A fresh character farming from level 1 is the tightest case: the join slack
// is smallest there and the early curve is cheapest.
{
  const r = simulate({ startLvl: 1, kills: 1500, monsterLvl: 3, clanXpPct: 20, potion: true });
  check('honest player is never clamped — fresh character from level 1',
    r.headroom >= 0,
    `reached lvl ${r.lvl}; entitlement fell short by ${Math.round(-r.headroom)} XP`);
}

// ── Forgery cannot survive ──────────────────────────────────────────────────
// The correction walks the claim back down the real curve, so the result is a
// genuine position on it rather than a truncated XP bar.
function capTo(allowed) {
  let lvl = 1, left = Math.max(0, allowed);
  while (left >= xpToNext(lvl) && lvl < 1000) { left -= xpToNext(lvl); lvl++; }
  return { lvl, xp: Math.round(left) };
}
{
  const startLvl = 12;
  const allowed = xpTotalAt(startLvl, 0) + ceilingFor(XP_JOIN_SLACK_KILLS * xpAtLevel(startLvl));

  const forged = capTo(allowed);
  check('a save claiming level 1000 is walked back to the entitlement',
    forged.lvl <= startLvl + 1 && xpTotalAt(forged.lvl, forged.xp) <= allowed,
    `capped to lvl ${forged.lvl} xp ${forged.xp} from an entitlement of ${Math.round(allowed)}`);

  check('the capped pair is a real position on the curve',
    forged.xp < xpToNext(forged.lvl),
    `xp ${forged.xp} is not below xpToNext(${forged.lvl}) = ${xpToNext(forged.lvl)}`);

  // The curve is exponential, so a forged level has to total to something
  // astronomically above any real entitlement — never to a number that could
  // compare small (a wrap, a NaN, or a silently truncated sum).
  const absurd = xpTotalAt(1000, 0);
  check('an absurd level totals to something no entitlement can reach',
    Number.isFinite(absurd) ? absurd > 1e100 : absurd === Infinity,
    `got ${absurd}`);
}

// Reconnecting must not ratchet: the join slack is recomputed from the STORED
// record every time, so repeating it cannot walk the entitlement upward.
{
  const startLvl = 40;
  const slack = ceilingFor(XP_JOIN_SLACK_KILLS * xpAtLevel(startLvl));
  check('the join slack cannot be ratcheted into a level by reconnecting',
    slack < xpToNext(startLvl) / 100,
    `slack ${Math.round(slack)} vs ${xpToNext(startLvl)} for the level — needs to be a rounding error`);
  check('the join slack is derived from the stored record, not the last ceiling',
    /_joinSlack = _xpCeilingFor\(XP_JOIN_SLACK_KILLS \* xpAtLevel\(_dbLvl\)\)/.test(SRC),
    'server/index.js selectChar');
}

// ── Wiring ──────────────────────────────────────────────────────────────────
check('every XP the server hands out is banked',
  (SRC.match(/_allowXp\(/g) || []).length >= 7,
  `only ${(SRC.match(/_allowXp\(/g) || []).length} _allowXp call sites — kills (4), party members (2), quests (2)`);

check('party members are banked on their own socket',
  /memberIds\.forEach\(mid => io\.sockets\.sockets\.get\(mid\)\?\.data\?\._allowXp/.test(SRC),
  'a member\'s entitlement lives in their own socket closure');

check('selectChar pins level/XP to the stored record',
  /select_xp_forged/.test(SRC) && /effectiveSaved\.lvl = _dbLvl/.test(SRC),
  'otherwise a forged join launders the level into the baseline');

// A save can arrive before selectChar has established a baseline. Skipping the
// check there would have laundered any level: the forged figure becomes
// _lastStats, the debounce persists it, and the next login's baseline IS that
// record.
check('a save arriving before selectChar still seeds a baseline',
  /if \(_xpAllowed === null\) \{[\s\S]{0,400}?_sanitizeSavedStats\(authed\.savedData\)/.test(SRC),
  'server/index.js saveProgress — must fall back to the stored record, not skip');

check('the correction is pushed to the client',
  /socket\.emit\('xpSync'/.test(SRC)
    && /socket\.on\('xpSync'/.test(fs.readFileSync(path.join(ROOT, 'js', 'network.js'), 'utf8')),
  'without it the client resends the rejected level forever');

let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? '  ok  ' : ' FAIL '} ${r.name}${r.pass ? '' : `\n         ${r.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
