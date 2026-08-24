#!/usr/bin/env node
'use strict';
// ── LEGACY: this checks the RETIRED Mongo build ─────────────────────────────
//
//   CHECK_LEGACY=1 node dev/item-loss-check.js
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
  item-loss-check.js — SKIPPED (retired Mongo build; CHECK_LEGACY=1 to run)
`);
  process.exit(0);
}
// Regression check for the item-loss fixes (see BUG_AUDIT.md).
//
//   node dev/item-loss-check.js        (no server, no database)
//
// Every finding this covers had the same shape: a handler removed an item, or
// took payment for one, and then discovered it had nowhere to put it — by
// which point the listing was cancelled, the GRAM was spent or the stack was
// already spliced. The invariants below are what stop that, so they are worth
// holding onto:
//
//   • stack arithmetic must not depend on whether the caller happened to carry
//     a `slot` field (I1 — a bare { id, qty } deleted a whole 5000-shard stack
//     while handing 5 to the clan),
//   • "is there room?" must answer the same as _invAdd actually behaves,
//     including for a stackable with no existing stack (I2 — the case that
//     destroyed bought and cancelled market items),
//   • a save blob's untrusted fields must come out bounded (S1),
//   • a destructive request must name the item, not just a slot number, since
//     the two inventories are briefly renumbered differently (I9).
//
// server/index.js opens a listener on require and exports nothing, so — same
// approach as dev/xp-ledger-check.js — the functions under test are lifted out
// of its real source text and run against the real shared/definitions. This
// checks the shipped code rather than a restatement of it.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const defs = require(path.join(ROOT, 'shared', 'definitions.js'));
// Everything this check lifts used to live in server/index.js verbatim; a
// later split moved the item-inventory arithmetic to server/inventory.js and
// the save-blob sanitizing to server/anticheat.js (see those files' own
// headers). SRC stays index.js alone — every pattern check further down
// (handler bodies like craftPet's _itemOpBusy guard, usePotion's cooldown,
// ...) is still index.js-only text. SRC_FILES is only for lift/liftConst,
// searched inventory.js/anticheat.js first and index.js last, so a name that
// exists in both (e.g. _ITEM_ID_ALIASES — index.js's copy is an unused
// leftover from before the split) resolves to the copy the live handlers
// actually require, not the stale one.
const SRC = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
const SRC_FILES = [
  fs.readFileSync(path.join(ROOT, 'server', 'inventory.js'), 'utf8'),
  fs.readFileSync(path.join(ROOT, 'server', 'anticheat.js'), 'utf8'),
  SRC,
];

// `function NAME(...) { ... }`, matched by brace depth so nested blocks are
// included and the next function is not.
function lift(name) {
  for (const SRC of SRC_FILES) {
    const start = SRC.indexOf(`function ${name}(`);
    if (start < 0) continue;
    let i = SRC.indexOf('{', start), depth = 0;
    for (; i < SRC.length; i++) {
      if (SRC[i] === '{') depth++;
      else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
    }
    throw new Error(`item-loss-check: unbalanced braces in ${name}`);
  }
  throw new Error(`item-loss-check: function ${name} not found in server/{index,inventory,anticheat}.js`);
}
// `const NAME = ...` — either a one-liner or an object/array literal ending in
// a line that starts at column 0.
function liftConst(name) {
  for (const SRC of SRC_FILES) {
    const start = SRC.indexOf(`const ${name} =`);
    if (start < 0) continue;
    const objEnd = SRC.indexOf('\n};', start);
    if (objEnd > 0 && objEnd - start < 2000) return SRC.slice(start, objEnd + 3);
    return SRC.slice(start, SRC.indexOf('\n', start));
  }
  throw new Error(`item-loss-check: const ${name} not found in server/{index,inventory,anticheat}.js`);
}

const ctx = vm.createContext({ ...defs, console });
vm.runInContext([
  liftConst('SERVER_INV_MAX'),
  liftConst('_SANITIZE_MAX'),
  liftConst('_ITEM_ID_ALIASES'),
  liftConst('_KEY_MAP_MAX_KEYS'),
  liftConst('_KEY_MAP_MAX_KEY_LEN'),
  liftConst('_HP_POTION_IDS'),
  liftConst('_HP_POTION_HEAL'),
  liftConst('_BUFF_TYPES'),
  liftConst('_VALID_LANGS'),
  lift('_catalogBase'),
  lift('_itemSlotOf'),
  lift('_isStackable'),
  lift('_canonSavedItem'),
  lift('_invFindOwned'),
  lift('_invRemove'),
  lift('_invAdd'),
  lift('_invHasRoomFor'),
  lift('_unknownItemIds'),
  lift('_clampNum'),
  lift('_clampInt'),
  lift('_sanitizeKeyMap'),
  lift('_sanitizeSavedStats'),
  lift('_resolveInvIdx'),
].join('\n\n'), ctx);

const run = expr => vm.runInContext(expr, ctx);
const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail: detail || '' });
const sanitize = obj => { ctx._in = obj; return run('_sanitizeSavedStats(_in)'); };

// Fixtures taken from the live catalog rather than invented, so a renamed id
// fails loudly here instead of quietly making the test meaningless.
const SHARD = defs.UNIQUE_SHARDS[0].id;
const SHARD_SLOT = defs.CRAFT_MATS.find(m => m.id === SHARD).slot;
const GEAR = defs.ITEM_DEF.find(d => d.slot === 'weapon' && !d.noDrop).id;
const GEAR2 = defs.ITEM_DEF.filter(d => d.slot === 'weapon' && !d.noDrop)[1].id;
const HELM = defs.ITEM_DEF.find(d => d.slot === 'helmet').id;

// ── I1: stack arithmetic without a slot field ───────────────────────────────
// clanStorageDeposit's cross-session branch handed _applyGrant a bare
// { id, qty }. isStackableItem reads `it.slot`, which that object doesn't
// have, so the item read as non-stackable and _invRemove spliced the entire
// entry — 5 осколки to the clan, 4995 destroyed.
{
  ctx.inv = [{ id: SHARD, slot: SHARD_SLOT, qty: 5000 }];
  run(`_invRemove(inv, { id: ${JSON.stringify(SHARD)}, qty: 5 })`);
  check('slot-less removal takes qty units, not the whole stack',
    ctx.inv.length === 1 && ctx.inv[0].qty === 4995,
    `left ${JSON.stringify(ctx.inv)}`);

  ctx.inv = [{ id: SHARD, slot: SHARD_SLOT, qty: 5 }];
  run(`_invRemove(inv, { id: ${JSON.stringify(SHARD)}, qty: 5 })`);
  check('removing the exact quantity empties the slot', ctx.inv.length === 0);

  ctx.inv = [{ id: SHARD, slot: SHARD_SLOT, qty: 3 }];
  const refused = run(`_invRemove(inv, { id: ${JSON.stringify(SHARD)}, qty: 10 })`);
  check('removing more than is held is refused and changes nothing',
    refused === false && ctx.inv[0].qty === 3);

  ctx.inv = [{ id: SHARD, slot: SHARD_SLOT, qty: 2 }];
  run(`_invAdd(inv, { id: ${JSON.stringify(SHARD)}, qty: 3 })`);
  check('slot-less add merges into the existing stack',
    ctx.inv.length === 1 && ctx.inv[0].qty === 5, `got ${JSON.stringify(ctx.inv)}`);

  check('a material read through the catalog is stackable',
    run(`_isStackable({ id: ${JSON.stringify(SHARD)} })`) === true);
  check('a weapon read through the catalog is not stackable',
    run(`_isStackable({ id: ${JSON.stringify(GEAR)} })`) === false);
  check('an id the catalog does not know is not stackable',
    run(`_isStackable({ id: 'no_such_item' })`) === false);
}

// ── I2: room checks that agree with _invAdd ─────────────────────────────────
// marketBuy/marketCancel/_adminCancelListing tested "!stackable && full",
// which let a stackable with no existing stack through — and _invAdd then
// refused it, after the payment or the cancellation had already happened.
{
  const full = n => Array.from({ length: n }, (_, i) => ({ id: GEAR, slot: 'weapon', enhance: i % 3 }));
  const stackItem = { id: SHARD, slot: SHARD_SLOT, qty: 1 };
  const gearItem = { id: GEAR, slot: 'weapon' };

  const cases = [
    ['full inventory, stackable with no existing stack', full(150), stackItem, false],
    ['full inventory, stackable that merges into a stack',
      full(149).concat([{ id: SHARD, slot: SHARD_SLOT, qty: 1 }]), stackItem, true],
    ['full inventory, non-stackable', full(150), gearItem, false],
    ['one slot free, non-stackable', full(149), gearItem, true],
  ];
  for (const [label, inv, item, expected] of cases) {
    ctx.inv = inv;
    const predicted = run(`_invHasRoomFor(inv, ${JSON.stringify(item)})`);
    const actual = run(`_invAdd(inv, ${JSON.stringify(item)})`);
    check(`room check is correct — ${label}`, predicted === expected,
      `expected ${expected}, got ${predicted}`);
    check(`room check matches _invAdd — ${label}`, predicted === actual,
      `check said ${predicted}, _invAdd did ${actual}`);
  }
  check('an absent inventory reports no room rather than throwing',
    run(`_invHasRoomFor(null, ${JSON.stringify(gearItem)})`) === false);
}

// The three call sites that used to get this wrong. Checked as source text
// because the surrounding code is inside the connection closure and can't be
// lifted standalone — what matters is that none of them is still asking the
// old question.
{
  check('no room check still asks the old "!isStackableItem(...) && full" question',
    !/!isStackableItem\([^)]*\)\s*&&[^\n]*>= SERVER_INV_MAX/.test(SRC),
    'a stackable with no existing stack would slip past it again');
  check('marketBuy refunds and releases the lot when delivery fails',
    /market_buy_noroom/.test(SRC) && /Инвентарь полон — покупка отменена/.test(SRC));
  check('marketCancel puts the listing back when the item cannot be returned',
    /listingRestored: true/.test(SRC) && /Инвентарь полон — лот остался на маркете/.test(SRC));
}

// ── I3: the potion handler is no longer a free full-heal ────────────────────
{
  check('usePotion has a server-side cooldown', /const POTION_CD_MS = \d+/.test(SRC));
  check('usePotion spends from the server copy of potionBag',
    /bag\[potId\] -= 1/.test(SRC));
  check('the heal comes from the catalog, not from the packet',
    /_HP_POTION_HEAL\.get\(potId\)/.test(SRC));
}

// ── I4/I6/I7/I8: refuse-or-report instead of dropping the item ──────────────
{
  check('craftPet has a cross-session guard like the other crafts',
    /pet_craft_cross_session/.test(SRC));
  check('craftPet is wrapped in _itemOpBusy',
    /_itemOpBusy\+\+;\n(?:\s*let _ran;\n)?\s*try \{\n\s*\/\/ Serialized like the other spend handlers/.test(SRC));
  check('claimQuest refuses up front when the reward will not fit',
    /quest_reward_refused/.test(SRC));
  check('boss drops report only what _invAdd actually placed',
    /const _rollInto = \(chance, item\) => \(Math\.random\(\) < chance && _invAdd\(inv, item\)\) \? 1 : 0;/.test(SRC));
  check('pickupWorldDrop refuses before claiming the pile off the floor',
    /if \(!inv\) return socket\.emit\('worldDropError'/.test(SRC));
}

// ── I12/I14: partial failures give the goods back ───────────────────────────
{
  check('clanStorageClaim returns un-granted allocations to the clan',
    (SRC.match(/clan_storage_claim_partial/g) || []).length === 2,
    'both the same-session and the cross-session path need it');
  check('season burn awards the points before destroying the item',
    /Points FIRST/.test(SRC) && /Не удалось начислить очки/.test(SRC));
}

// ── I16: the $push fallbacks report an over-cap inventory ───────────────────
{
  check('the DB item fallbacks go through _dbPushInventory',
    !/\$push: \{ 'savedData\.inventory': (claimed|listing)\.item \}/.test(SRC));
  check('an inventory pushed past the cap is logged', /inv_over_cap/.test(SRC));
}

// ── S1: the save fields that used to pass through untouched ─────────────────
{
  let s = sanitize({ type: 'lev', potionBag: { pt1: 999999999, pt2: -5, junk: 7 } });
  check('potionBag keeps only real potion ids',
    Object.keys(s.potionBag).sort().join(',') === defs.ITEM_DEF.filter(d => d.slot === 'use').map(d => d.id).sort().join(','),
    JSON.stringify(s.potionBag));
  check('potionBag counts are clamped', s.potionBag.pt1 === 1e5, JSON.stringify(s.potionBag));
  check('a negative potion count becomes 0', s.potionBag.pt2 === 0);
  check('a non-object potionBag becomes an empty bag',
    sanitize({ type: 'lev', potionBag: 'nope' }).potionBag.pt1 === 0);
  check('a legacy `potions` integer migrates to pt1',
    sanitize({ type: 'lev', potions: 3 }).potionBag.pt1 === 3,
    'restoreFromSave does the same migration client-side');

  check('hudPotion falls back to a real potion id',
    sanitize({ type: 'lev', hudPotion: 'evil' }).hudPotion === 'pt1');
  check('a valid hudPotion is left alone',
    sanitize({ type: 'lev', hudPotion: 'pt2' }).hudPotion === 'pt2');

  check('an unknown class is dropped rather than forced',
    !('type' in sanitize({ type: 'wizard_of_oz' })),
    'dropping it leaves whatever the stored record has');
  check('a known class is kept', sanitize({ type: 'mage' }).type === 'mage');

  const bigMap = {};
  for (let i = 0; i < 500; i++) bigMap['k' + i] = i;
  bigMap['y'.repeat(200)] = 1;
  s = sanitize({ type: 'lev', skillLevels: bigMap });
  check('a progression map is capped at 64 keys', Object.keys(s.skillLevels).length === 64,
    `got ${Object.keys(s.skillLevels).length}`);
  check('over-long keys are rejected', !Object.keys(s.skillLevels).some(k => k.length > 40));
  check('progression values are clamped', Object.values(s.skillLevels).every(v => v >= 0 && v <= 99));
  check('an array where a map belongs becomes {}',
    Object.keys(sanitize({ type: 'lev', skillLevels: [1, 2, 3] }).skillLevels).length === 0);
  check('an absent progression map stays absent',
    sanitize({ type: 'lev' }).skillLevels === undefined,
    '_persistSavedFields skips undefined, so the stored value survives');

  s = sanitize({ type: 'lev', buffs: { hp: 600, nonsense: 99, exp: 1e9, gold: -5 } });
  check('unknown buff types are dropped', !('nonsense' in s.buffs), JSON.stringify(s.buffs));
  check('a real buff is kept', s.buffs.hp === 600);
  check('a buff duration is clamped', s.buffs.exp === 7200);
  check('a non-positive buff is dropped', !('gold' in s.buffs));
}

// The guarantees that were already there and must not have been broken.
{
  const s = sanitize({
    type: 'lev', gold: -100, lvl: 'abc', xp: Infinity,
    inventory: [{ id: 'no_such_item' }, { id: GEAR }],
  });
  check('negative gold still clamps to 0', s.gold === 0);
  check('a non-numeric level still becomes 1', s.lvl === 1);
  check('an infinite xp still becomes 0', s.xp === 0);
  check('an unknown item id is still dropped',
    s.inventory.length === 1 && s.inventory[0].id === GEAR);
  check('balances are still stripped from the blob',
    !('gramBalance' in sanitize({ type: 'lev', gramBalance: 999 })));
  check('vipPending is still stripped from the blob',
    !('vipPending' in sanitize({ type: 'lev', vipPending: [1, 2] })));
}

// ── I9: addressing a destructive action by identity ─────────────────────────
{
  ctx.inv = [
    { id: GEAR, slot: 'weapon', enhance: 0 },
    { id: GEAR2, slot: 'weapon', enhance: 3 },
    { id: HELM, slot: 'helmet', enhance: 0 },
  ];
  check('an index that matches is used as given',
    run(`_resolveInvIdx(inv, 1, ${JSON.stringify(GEAR2)}, 3)`) === 1);
  check('a stale index re-finds the item by identity',
    run(`_resolveInvIdx(inv, 0, ${JSON.stringify(HELM)}, 0)`) === 2,
    'this is the burn/sell case that destroyed the wrong item');
  check('the same id at a different enhance is a different item',
    run(`_resolveInvIdx(inv, 1, ${JSON.stringify(GEAR2)}, 9)`) === -1);
  check('an item the server does not hold is refused',
    run(`_resolveInvIdx(inv, 0, 'no_such_item', 0)`) === -1);
  check('an out-of-range index still re-finds by identity',
    run(`_resolveInvIdx(inv, 99, ${JSON.stringify(GEAR)}, 0)`) === 0);
  check('a client from before this change still works on the index alone',
    run(`_resolveInvIdx(inv, 2)`) === 2);
  check('...and a bad index from such a client is refused',
    run(`_resolveInvIdx(inv, 99)`) === -1);

  check('the client sends the item identity for a burn',
    /socket\.emit\('seasonBurn', \{ idx, id, enhance \}\)/.test(
      fs.readFileSync(path.join(ROOT, 'js', 'network.js'), 'utf8')));
  check('the client sends the item identity for a sale',
    /socket\.emit\('sellItem', \{ idx, id, enhance \}\)/.test(
      fs.readFileSync(path.join(ROOT, 'js', 'network.js'), 'utf8')));
}

// ── I10: a retired id no longer disappears silently ─────────────────────────
{
  ctx.blob = {
    inventory: [{ id: GEAR }, { id: 'retired_a' }],
    storage: [{ id: 'retired_b' }],
    equipment: { weapon: { id: GEAR } },
  };
  const gone = run('_unknownItemIds(blob)');
  check('unknown ids are named for the log',
    gone.length === 2 && gone.includes('retired_a') && gone.includes('retired_b'),
    JSON.stringify(gone));
  check('saveProgress logs them', /save_items_unknown_id/.test(SRC));

  run(`_ITEM_ID_ALIASES['retired_a'] = ${JSON.stringify(GEAR)}`);
  check('an aliased id resolves to its replacement',
    run(`!!_catalogBase('retired_a')`) === true,
    'this is what a future rename needs so copies survive it');
  check('an unaliased unknown id still resolves to null',
    run(`_catalogBase('still_unknown')`) === null);
}

// ── Report ──────────────────────────────────────────────────────────────────
let failed = 0;
for (const r of results) {
  if (r.pass) console.log(`  ok    ${r.name}`);
  else { failed++; console.log(`  FAIL  ${r.name}${r.detail ? `\n          ${r.detail}` : ''}`); }
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
