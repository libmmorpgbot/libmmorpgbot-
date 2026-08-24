#!/usr/bin/env node
'use strict';
// ── LEGACY: this checks the RETIRED Mongo build ─────────────────────────────
//
//   CHECK_LEGACY=1 node dev/storage-race-check.js
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
  storage-race-check.js — SKIPPED (retired Mongo build; CHECK_LEGACY=1 to run)
`);
  process.exit(0);
}
// Regression check for the inventory <-> storage rollback race.
//
//   node dev/storage-race-check.js
//
// Needs no database and no running server: it lifts the real census helpers
// and the real stale-invRev guard out of server/index.js by source slice and
// runs them in a vm against the real item catalog, so the check fails if the
// shipped code changes rather than passing against a paraphrase of it.
//
// The race it guards: inventory <-> storage is a CLIENT-side move (js/player.js
// moveToStorage/moveToInventory) that only reaches the server on the next
// saveProgress, while _invRev is bumped by every SERVER-side item grant (mob
// loot, purchases, quest rewards). When a grant lands inside that window the
// save arrives stale, and the guard replaces the client's items with the
// server's copy. Replacing only the inventory half of a move in flight left
// the blob describing two moments at once — which _itemCensus, counting
// inventory + equipment + storage together, then read as either a duplicate
// (deposit) or a vanished item (withdrawal).

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');

// ── Lift the real code out of server/index.js ───────────────────────────────
// Sliced by name rather than copied, so an edit to any of them is picked up
// here automatically and a rename fails loudly instead of silently testing a
// stale duplicate.
function slice(startRe, label) {
  const m = SRC.match(startRe);
  if (!m) throw new Error(`storage-race-check: could not find ${label} in server/index.js`);
  // Walk braces from the first { after the match to the matching close.
  const from = SRC.indexOf('{', m.index);
  let depth = 0;
  for (let i = from; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(m.index, i + 1); }
  }
  throw new Error(`storage-race-check: unbalanced braces reading ${label}`);
}

const sandbox = { console, Map, Set, Number, Math, Array, Object, JSON };
vm.createContext(sandbox);
// The catalog and isStackableItem/ENHANCE* the helpers close over.
vm.runInContext(fs.readFileSync(path.join(ROOT, 'shared', 'definitions.js'), 'utf8'), sandbox);
vm.runInContext([
  slice(/^const _SANITIZE_MAX = /m, '_SANITIZE_MAX'),
  slice(/^function _catalogBase\(/m, '_catalogBase'),
  slice(/^function _canonSavedItem\(/m, '_canonSavedItem'),
  slice(/^function _itemCensus\(/m, '_itemCensus'),
  slice(/^function _censusOverflow\(/m, '_censusOverflow'),
  slice(/^function _censusEqual\(/m, '_censusEqual'),
].join('\n'), sandbox);

// Function declarations land on the context's global object; `const`s live in
// its lexical scope instead and have to be read back by evaluating their name.
const { _itemCensus, _censusOverflow, _censusEqual } = sandbox;
const read = expr => vm.runInContext(expr, sandbox);

// The stale-invRev guard's item-rollback lines, read out of the real handler
// so this test tracks whatever it actually does today.
const GUARD = (() => {
  const start = SRC.indexOf('const _clientRev = Math.floor(Number(stats && stats.invRev)) || 0;');
  if (start < 0) throw new Error('storage-race-check: stale-invRev guard not found');
  const end = SRC.indexOf('// Anti-duplication.', start);
  const body = SRC.slice(start, end);
  return {
    revertsInventory: /clean\.inventory\s*=\s*_lastStats\.inventory/.test(body),
    revertsEquipment: /clean\.equipment\s*=\s*_lastStats\.equipment/.test(body),
    revertsStorage:   /clean\.storage\s*=\s*_lastStats\.storage/.test(body),
    syncsStorage:     /socket\.emit\('inventorySync',[\s\S]*storage:/.test(body),
  };
})();

// ── Fixtures ────────────────────────────────────────────────────────────────
// A real, non-stackable catalog item so the census keys it by id@enhance.
const ITEM = (() => {
  const d = read('ITEM_DEF.find(i => ENHANCEABLE_SLOTS.has(i.slot)) || null');
  if (!d) throw new Error('storage-race-check: no enhanceable item in the catalog');
  return { id: d.id, enhance: 0 };
})();
const KEY = `${ITEM.id}@0`;

const clone = o => JSON.parse(JSON.stringify(o));

// What the server holds: the item sits in the inventory, storage is empty.
const serverStats = { inventory: [clone(ITEM)], equipment: {}, storage: [] };

// Replays the real handler's item path for one save: the stale-invRev guard
// (as the shipped source writes it) followed by the anti-duplication census.
function applySave(clean, lastStats, { staleRev }) {
  const out = clone(clean);
  if (staleRev) {
    if (GUARD.revertsInventory) out.inventory = lastStats.inventory || [];
    if (GUARD.revertsEquipment) out.equipment = lastStats.equipment || {};
    if (GUARD.revertsStorage)   out.storage   = lastStats.storage   || [];
  }
  const grew = _censusOverflow(_itemCensus(out), _itemCensus(lastStats));
  if (grew) {
    out.inventory = lastStats.inventory || [];
    out.equipment = lastStats.equipment || {};
    out.storage   = lastStats.storage   || [];
  }
  return { saved: out, forged: grew };
}

const total = stats => (_itemCensus(stats).get(KEY) || 0);

// ── Cases ───────────────────────────────────────────────────────────────────
const results = [];
const check = (name, pass, detail) => { results.push({ name, pass, detail }); };

// 1. Deposit (inventory -> storage) racing a server-side grant.
{
  const clientSave = { inventory: [], equipment: {}, storage: [clone(ITEM)] };
  const { saved, forged } = applySave(clientSave, serverStats, { staleRev: true });
  check('deposit race: player is not flagged as forging items',
    !forged, forged ? `census overflow on ${forged.key}: had ${forged.had}, sent ${forged.sent}` : 'no overflow');
  check('deposit race: the item still exists exactly once',
    total(saved) === 1, `census count = ${total(saved)}`);
}

// 2. Withdrawal (storage -> inventory) racing a server-side grant. This is the
//    destructive half: the census only rejects GROWTH, so a blob that lost the
//    item on both sides used to be accepted verbatim.
{
  const heldInStorage = { inventory: [], equipment: {}, storage: [clone(ITEM)] };
  const clientSave = { inventory: [clone(ITEM)], equipment: {}, storage: [] };
  const { saved } = applySave(clientSave, heldInStorage, { staleRev: true });
  check('withdrawal race: the item is not destroyed',
    total(saved) === 1, `census count = ${total(saved)}`);
}

// 3. The guard must still do its original job — a stale save cannot keep an
//    inventory that predates a server grant.
{
  const granted = { inventory: [clone(ITEM), clone(ITEM)], equipment: {}, storage: [] };
  const preGrantSave = { inventory: [clone(ITEM)], equipment: {}, storage: [] };
  const { saved } = applySave(preGrantSave, granted, { staleRev: true });
  check('stale save does not roll back a server-side grant',
    total(saved) === 2, `census count = ${total(saved)}, expected 2`);
}

// 4. Minting is still rejected, stale rev or not.
{
  const forgedSave = { inventory: [clone(ITEM), clone(ITEM), clone(ITEM)], equipment: {}, storage: [] };
  const { forged } = applySave(forgedSave, serverStats, { staleRev: false });
  check('forged save with extra items is still rejected',
    !!forged, forged ? `rejected ${forged.key}` : 'NOT rejected');
}

// 5. The rollback has to reach the client too, or it keeps the storage half of
//    a set the server just replaced and resends it on every later save.
check('inventorySync carries storage when the guard reverts it',
  GUARD.syncsStorage, GUARD.syncsStorage ? 'storage field present' : 'storage field MISSING from the emit');

// ── Market listing racing a dropped connection ──────────────────────────────
// Listing an item splices it out of the local inventory optimistically; the
// server creates the lot and persists the removal BEFORE it answers. A drop in
// that round trip therefore says nothing about whether the listing exists —
// and the client used to assume it did not and put the item back. Whichever
// way the race actually went, the join that follows has to settle it, or the
// item lives in the inventory and as a live lot at the same time until the
// census reverts the player's whole set as forged.
{
  // The listing DID land: the server no longer holds the item, the client
  // reconnects still holding it.
  const serverAfterListing = { inventory: [], equipment: {}, storage: [] };
  const clientOnRejoin = { inventory: [clone(ITEM)], equipment: {}, storage: [] };
  check('market race: a rejoin whose items disagree gets a correction',
    !_censusEqual(_itemCensus(clientOnRejoin), _itemCensus(serverAfterListing)),
    'censuses compare equal, so no inventorySync would be sent');

  // The listing did NOT land: the server still holds the item, and the client
  // dropped it locally. Same answer — the server's copy is the truth and has
  // to go down, which is what restores the item.
  const serverNoListing = { inventory: [clone(ITEM)], equipment: {}, storage: [] };
  const clientMissing = { inventory: [], equipment: {}, storage: [] };
  check('market race: the other outcome is corrected too, not just one',
    !_censusEqual(_itemCensus(clientMissing), _itemCensus(serverNoListing)),
    'censuses compare equal, so the item would never come back');

  // An ordinary reconnect must stay silent — this runs on every mobile blip.
  const agreed = { inventory: [clone(ITEM)], equipment: {}, storage: [] };
  check('market race: an ordinary reconnect sends no extra payload',
    _censusEqual(_itemCensus(agreed), _itemCensus(clone(agreed))),
    'identical holdings compared unequal');

  // An inventory <-> storage move made just before the drop is agreement, not
  // a discrepancy: same items, different shelf. Correcting it would undo the
  // move for no reason.
  const movedToStorage = { inventory: [], equipment: {}, storage: [clone(ITEM)] };
  check('market race: a storage move before the drop is not treated as a mismatch',
    _censusEqual(_itemCensus(movedToStorage), _itemCensus(agreed)),
    'the same item on a different shelf compared unequal');
}

// The correction itself has to actually be wired into the join, and the client
// must stop conjuring the item back on a drop it cannot interpret.
const serverSrc = SRC.slice(SRC.indexOf("safeOn('selectChar'"));
check('selectChar pushes the authoritative items when they disagree',
  /_censusEqual\(_itemCensus\(sanitized\), _itemCensus\(_lastStats\)\)/.test(serverSrc)
    && /socket\.emit\('inventorySync'/.test(serverSrc.slice(0, serverSrc.indexOf("safeOn('mv'"))),
  'end of the selectChar handler in server/index.js');

const uiSrc = fs.readFileSync(path.join(ROOT, 'js', 'ui.js'), 'utf8');
check('a dropped connection no longer restores a possibly-listed item',
  /function onMarketConnectionLost\(\)\s*\{[\s\S]*?_clearPendingSell\(false\)/.test(uiSrc)
    && /function onMarketListError\([\s\S]*?_clearPendingSell\(true\)/.test(uiSrc),
  'js/ui.js onMarketConnectionLost / onMarketListError');

// ── Client-set combat flags ─────────────────────────────────────────────────
// Two events let a console one-liner grant itself something no skill grants.

// playerInvis took the client's word for it and made every monster in the room
// ignore the sender indefinitely. Nothing in the client ever turns invisibility
// ON — invisTimer is only decremented and zeroed — so any `invis: true` on the
// wire is forged by definition, and the handler must not honour it.
{
  const handler = SRC.slice(SRC.indexOf("safeOn('playerInvis'"));
  const body = handler.slice(0, handler.indexOf('});') + 3);
  check('playerInvis cannot be switched on from the client',
    !/_invis\s*=\s*!!/.test(body) && /_invis\s*=\s*false/.test(body),
    body.replace(/\s+/g, ' ').slice(0, 120));

  const stateSrc = fs.readFileSync(path.join(ROOT, 'js', 'state.js'), 'utf8')
    + fs.readFileSync(path.join(ROOT, 'js', 'player.js'), 'utf8')
    + fs.readFileSync(path.join(ROOT, 'js', 'game.js'), 'utf8')
    + fs.readFileSync(path.join(ROOT, 'js', 'network.js'), 'utf8');
  // The premise of the check above. If a skill ever does grant invisibility,
  // this fails and says so, rather than the grant silently never working.
  const grants = (stateSrc.match(/invisTimer\s*=\s*([^;]+);/g) || [])
    .filter(a => !/=\s*0\s*;/.test(a));
  check('no client code grants invisibility (premise of the handler fix)',
    grants.length === 0,
    `found: ${grants.join(' | ')} — invis is real now, so the server has to grant and expire it`);
}

// statsUpdate is clamped to the server's own computeStats times a headroom for
// buffs it cannot see. One blanket ×3 let a forged packet sit at triple ATK
// forever; the ceilings have to track what can actually stack in recompute().
{
  const roomSrc = fs.readFileSync(path.join(ROOT, 'server', 'game', 'Room.js'), 'utf8');
  const num = name => {
    const m = roomSrc.match(new RegExp(`^const ${name}\\s*=\\s*([0-9.]+)`, 'm'));
    return m ? Number(m[1]) : null;
  };
  const atk = num('ATK_BUFF_HEADROOM'), def = num('DEF_BUFF_HEADROOM'), hp = num('HP_BUFF_HEADROOM');
  // Real maxima from recompute() (js/player.js): ATK ×1.20 potion × ×1.20
  // battleCry; DEF ×1.80 guard × ×1.50 faithShield; HP ×1.10 potion.
  const bound = (label, got, real) =>
    check(`statsUpdate ${label} headroom covers the real buffs without room to forge`,
      got !== null && got >= real && got <= real * 1.12,
      `ceiling ${got}, real stack ${real} — must sit between ${real} and ${(real * 1.12).toFixed(2)}`);
  bound('ATK', atk, 1.44);
  bound('DEF', def, 2.70);
  bound('HP',  hp,  1.10);

  check('statsUpdate never takes crit from the client',
    /p\.critChance\s*=\s*trueBase\.critChance/.test(roomSrc)
      && /p\.critPower\s*=\s*trueBase\.critPower/.test(roomSrc),
    'Room.js updatePlayerStats');
}

const clientSrc = fs.readFileSync(path.join(ROOT, 'js', 'network.js'), 'utf8');
check('client inventorySync applies the storage it is sent',
  /socket\.on\('inventorySync',\s*\(\{[^}]*storage/.test(clientSrc)
    && /player\.storage\s*=\s*_migrateInventory\(storage\)/.test(clientSrc),
  'js/network.js inventorySync handler');

// ── Report ──────────────────────────────────────────────────────────────────
let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? '  ok  ' : ' FAIL '} ${r.name}${r.pass ? '' : `\n         ${r.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
