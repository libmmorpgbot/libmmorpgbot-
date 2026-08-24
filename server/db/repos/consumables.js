'use strict';
// ── Potions, buffs, teleport stones, world drops ────────────────────────────
// The last four paths by which an item or a stat changes hands. Each one was a
// place the client could be trusted a little, and "a little" is what the whole
// migration exists to remove.
//
// The pattern repeats from the other repositories and is worth naming once
// more: the client says WHICH thing to use, never WHAT USING IT DOES. It sends
// a row id or a potion id; the effect — how much HP, how long the buff, what
// the drop contains — is read from the catalog on this side.

const crypto = require('crypto');
const { query } = require('../index');
const items = require('./items');
const money = require('./money');
const {
  ITEM_DEF, POTION_CAP, TELEPORT_CAST_MS, TELEPORT_STONE_PRICE, MERCHANT_SHOP,
  CODEX_SETS, codexSetById, codexItemMeetsReq, codexTotalBonus,
} = require('../../../shared/definitions');

class UseError extends Error {
  constructor(code, msg) { super(msg); this.code = code; this.userMessage = msg; }
}
const err = (code, msg) => { throw new UseError(code, msg); };

const HP_POTIONS = new Map(ITEM_DEF.filter(d => d.slot === 'use').map(d => [d.id, d]));
const BUFF_POTIONS = new Map(ITEM_DEF.filter(d => d.slot === 'buff_potion').map(d => [d.id, d]));

// ── HP potions ──────────────────────────────────────────────────────────────
// The heal amount comes from the catalog, not the request. The old handler
// took an `amount` from the client and a non-numeric one produced hp = NaN —
// which compares false against every threshold, so the player became
// effectively immortal (C2 in AUDIT.md). There is no amount to send here.
//
// maxHp is read through the stats repository so the cap is the same number
// combat uses; taking it from anywhere else is how a heal ends up able to
// exceed the health bar it is drawn against.
// ── the potion bag ──────────────────────────────────────────────────────────
// Healing potions are NOT inventory rows. They live in player_progress.
// potion_bag, a jsonb map of id -> count, and that is not a leftover from the
// old save blob — it is load-bearing. POTION_CAP is 999 and pt1 is not
// stackable, so as rows a full bag would be 999 of the player's 150 inventory
// slots. The HUD, the shop's cap and the quick-use key all read the bag.
//
// The first version of this file spent potions with items.removeQty, against
// the inventory. Nothing there ever held one: the ETL carries potion_bag
// across as potion_bag, and the merchant fills the same map. So every migrated
// player would have opened the game with a visibly full potion bag and a heal
// key that answered "Нет такого зелья" — the potions were never lost, they
// were just being looked for in the wrong place.
//
// Both statements below are single UPDATEs with the arithmetic in SQL. Reading
// the map, changing it in JavaScript and writing it back would lose a
// concurrent purchase to the last writer.
async function potionBagOf(db, playerId) {
  const { rows } = await query(db,
    'SELECT potion_bag FROM player_progress WHERE player_id = $1', [playerId]);
  return rows.length ? (rows[0].potion_bag || {}) : {};
}

async function usePotion(db, playerId, potionId) {
  const def = HP_POTIONS.get(potionId);
  if (!def) err('bad_potion', 'Неизвестное зелье');

  // The decrement and the "do you have one" check are the same statement, so
  // two heal keys pressed together cannot both spend the last potion.
  const { rows } = await query(db, `
    UPDATE player_progress
       SET potion_bag = jsonb_set(potion_bag, ARRAY[$2::text],
             to_jsonb(COALESCE((potion_bag->>$2)::int, 0) - 1))
     WHERE player_id = $1 AND COALESCE((potion_bag->>$2)::int, 0) >= 1
    RETURNING COALESCE((potion_bag->>$2)::int, 0) AS left`, [playerId, potionId]);
  if (!rows.length) err('no_potion', 'Нет такого зелья');

  const stats = require('./stats');
  const st = await stats.of(db, playerId);
  if (!st) err('no_player', 'Игрок не найден');

  const healed = Math.min(st.maxHp, st.hp + (def.hp || 0));
  await query(db, 'UPDATE player_progress SET hp = $2 WHERE player_id = $1', [playerId, healed]);
  return {
    potionId, healed: healed - st.hp, hp: healed, maxHp: st.maxHp,
    left: Number(rows[0].left),
  };
}

// The merchant sells potions and nothing else — MERCHANT_SHOP is pt1 and pt2.
// Gold out, bag up, one transaction, capped in the same statement that does
// the adding so a burst of clicks cannot walk past the ceiling.
async function buyPotions(db, playerId, itemId, qty = 1) {
  const entry = MERCHANT_SHOP.find(e => e.itemId === itemId);
  if (!entry) err('not_sold', 'Торговец этого не продаёт');
  const n = Math.max(1, Math.min(POTION_CAP, Math.floor(Number(qty) || 1)));

  const bag = await potionBagOf(db, playerId);
  const have = Math.max(0, Math.floor(Number(bag[itemId]) || 0));
  if (have + n > POTION_CAP) err('potion_cap', `Максимум ${POTION_CAP} зелий!`);

  const paid = await money.spend(db, playerId, 'gold', entry.price * n, {
    reason: 'merchant_buy', refType: 'potion', refId: itemId,
    idemKey: `merchant:${playerId}:${itemId}:${crypto.randomUUID()}`,
  });
  if (!paid) err('no_gold', 'Мало золота!');

  const { rows } = await query(db, `
    UPDATE player_progress
       SET potion_bag = jsonb_set(potion_bag, ARRAY[$2::text],
             to_jsonb(LEAST($4::int, COALESCE((potion_bag->>$2)::int, 0) + $3::int)))
     WHERE player_id = $1
    RETURNING potion_bag`, [playerId, itemId, n, POTION_CAP]);
  if (!rows.length) err('no_player', 'Игрок не найден');

  return { itemId, qty: n, cost: entry.price * n, goldLeft: paid.balance, potionBag: rows[0].potion_bag };
}

async function useBuffPotion(db, playerId, potionId) {
  const def = BUFF_POTIONS.get(potionId);
  if (!def || !def.buffType) err('bad_potion', 'Неизвестное зелье');

  await items.lockPlayer(db, playerId);
  if (!await items.removeQty(db, playerId, potionId, 1)) err('no_potion', 'Нет такого зелья');

  const dur = Math.max(1, Math.floor(Number(def.buffDur) || 600));
  // Re-drinking EXTENDS rather than replaces, and is capped — otherwise a
  // player with a stack of two hundred can hold a permanent buff, which is a
  // different game from the one the durations were balanced for.
  const { rows } = await query(db, `
    UPDATE player_progress
       SET buffs = jsonb_set(buffs, ARRAY[$2],
             to_jsonb(LEAST(
               GREATEST(COALESCE((buffs ->> $2)::int, 0), 0) + $3::int,
               $4::int)), true),
           updated_at = now()
     WHERE player_id = $1
    RETURNING buffs`, [playerId, def.buffType, dur, dur * 4]);
  if (!rows.length) err('no_player', 'Игрок не найден');
  return { potionId, buffType: def.buffType, seconds: rows[0].buffs[def.buffType], buffs: rows[0].buffs };
}

// Expires whatever has run out. Called on a timer and on login, so a buff that
// ended while the player was offline is gone when they come back rather than
// resuming.
async function expireBuffs(db, playerId, elapsedSeconds) {
  const el = Math.max(0, Math.floor(Number(elapsedSeconds) || 0));
  if (!el) return null;
  const { rows } = await query(db, `
    UPDATE player_progress
       SET buffs = COALESCE((
             SELECT jsonb_object_agg(k, to_jsonb(v - $2))
               FROM jsonb_each_text(buffs) AS e(k, val),
                    LATERAL (SELECT val::int AS v) AS c
              WHERE v - $2 > 0), '{}'::jsonb)
     WHERE player_id = $1
    RETURNING buffs`, [playerId, el]);
  return rows.length ? rows[0].buffs : null;
}

// ── teleport stones ─────────────────────────────────────────────────────────
// The stone is consumed when the cast STARTS, and the destination is validated
// by the caller against the same level gates a walk-in uses. Consuming up front
// is deliberate: a player who cancels mid-cast has still spent it, which is
// what stops a stone being used to peek at a gate and then refunded.
// Bought from the merchant for Liberty. The old handler needed an economy
// lock, a busy counter, a re-read of the session after the charge, a hand-off
// to whatever socket the account had reconnected on, and a manual refund when
// that hand-off failed — sixty lines to make a charge and a grant look like one
// operation. Here they are one, so what is left is the price and the cap.
async function buyTeleportStone(db, playerId, qty = 1) {
  const n = Math.max(1, Math.min(99, Math.floor(Number(qty)) || 1));
  await items.lockPlayer(db, playerId);
  if (!await items.hasRoomFor(db, playerId, 'teleport_stone')) err('no_room', 'Инвентарь полон');

  const cost = TELEPORT_STONE_PRICE * n;
  const paid = await money.spend(db, playerId, 'nexum', cost, {
    reason: 'buy_teleport_stone', refType: 'merchant', refId: 'teleport_stone',
    idemKey: `tp_buy:${playerId}:${crypto.randomUUID()}`,
  });
  if (!paid) err('no_nexum', `Нужно ${cost} Liberty`);

  const rowId = await items.add(db, playerId, 'teleport_stone', { qty: n });
  if (rowId === null) err('no_room', 'Инвентарь полон');
  return { qty: n, cost, rowId };
}

async function useTeleportStone(db, playerId) {
  await items.lockPlayer(db, playerId);
  if (!await items.removeQty(db, playerId, 'teleport_stone', 1)) {
    err('no_stone', 'Нет камня телепорта');
  }
  return { castMs: TELEPORT_CAST_MS };
}

// ── world drops ─────────────────────────────────────────────────────────────
// A drop on the floor is claimed by ROW ID from the room's own list, and the
// caller has already checked that this player may take it (distance, party
// rules, whether it is still there). This only performs the grant, so the
// inventory-full case is a refusal the caller can show rather than an item
// destroyed on the way in.
async function pickupDrop(db, playerId, itemId, qty = 1, enhance = 0) {
  await items.lockPlayer(db, playerId);
  if (!await items.hasRoomFor(db, playerId, itemId)) err('no_room', 'Инвентарь полон');
  const rowId = await items.add(db, playerId, itemId, { qty, enhance });
  if (rowId === null) err('no_room', 'Инвентарь полон');
  return { itemId, qty, enhance, rowId };
}

// Kill rewards, as one transaction: gold, xp and any dropped item together.
// The old code applied these through three different paths — gold via a
// pending-spend accumulator, xp via _grantXp, items via _commitServerItems —
// so a disconnect between them credited some and not others.
// `gold` and `nexum` in the answer are BALANCES, not amounts — the client
// displays them verbatim rather than adding anything itself.
//
// Returning zero when nothing was credited was the bug behind "золото то есть
// то нету". A monster that rolls no gold is ordinary and common; every one of
// them told the client its balance was now zero, and the number on screen
// vanished until the next monster that happened to pay. Kill a rat, see 6.
// Kill another, see 0. The database had 6 the whole time.
//
// So the balance is read whether or not anything moved. One extra query per
// kill on the path that already did a write, in exchange for a number that
// cannot lie.
async function grantKillReward(db, playerId, { gold = 0, xp = 0, nexum = 0, drops = [], idemKey }) {
  const out = { gold: 0, xp: null, nexum: 0, items: [] };

  if (gold > 0) {
    const r = await money.credit(db, playerId, 'gold', gold,
      { reason: 'mob_kill', idemKey: `${idemKey}:gold` });
    out.gold = r.balance;
  }
  if (nexum > 0) {
    const r = await money.credit(db, playerId, 'nexum', nexum,
      { reason: 'mob_drop', idemKey: `${idemKey}:nexum` });
    out.nexum = r.balance;
  }
  if (!(gold > 0) || !(nexum > 0)) {
    const bal = await money.balancesOf(db, playerId);
    if (!(gold > 0)) out.gold = bal.gold;
    if (!(nexum > 0)) out.nexum = bal.nexum;
  }
  if (xp > 0) {
    const players = require('./players');
    out.xp = await players.grantXp(db, playerId, xp);
  }
  for (const d of drops) {
    // A full inventory drops the item on the floor rather than failing the
    // kill — the reward for the kill is not owed anywhere else, and refusing
    // the whole transaction over a slot would also refuse the xp and gold.
    if (!await items.hasRoomFor(db, playerId, d.id)) { out.items.push({ ...d, dropped: true }); continue; }
    const rowId = await items.add(db, playerId, d.id, { qty: d.qty || 1, enhance: d.enhance || 0 });
    out.items.push(rowId === null ? { ...d, dropped: true } : { ...d, rowId });
  }
  return out;
}

// ── codex ───────────────────────────────────────────────────────────────────
// Registering CONSUMES an owned item into one slot of one set. The item is
// destroyed — that is the trade — so the checks have to happen before the
// removal, and both have to be in one transaction or a crash between them
// takes the item and gives nothing.
async function registerCodexItem(db, playerId, setId, slotIdx, rowId) {
  const set = codexSetById(setId);
  if (!set) err('no_set', 'Набор не найден');
  const idx = Math.floor(Number(slotIdx));
  const req = set.slots[idx];
  if (!req) err('bad_slot', 'Неверный слот набора');

  await items.lockPlayer(db, playerId);

  const { rows } = await query(db, `
    SELECT id, item_id, enhance FROM player_items
     WHERE id = $1 AND player_id = $2 AND container = 'inventory'
     FOR UPDATE`, [rowId, playerId]);
  if (!rows.length) err('not_found', 'Предмет не найден');
  const it = rows[0];

  // The same shared predicate the client uses to enable the button, so the two
  // cannot disagree about whether an item qualifies.
  if (!codexItemMeetsReq({ id: it.item_id, enhance: it.enhance }, req)) {
    err('wrong_item', `Нужен ${req.itemId}${req.minEnhance ? ` +${req.minEnhance}` : ''}`);
  }

  const { rows: prog } = await query(db,
    'SELECT codex FROM player_progress WHERE player_id = $1 FOR UPDATE', [playerId]);
  const codex = prog[0].codex || {};
  const filled = Array.isArray(codex[setId]) ? [...codex[setId]] : new Array(set.slots.length).fill(false);
  if (filled.length !== set.slots.length) filled.length = set.slots.length;
  if (filled[idx]) err('already', 'Этот слот уже заполнен');

  await query(db, 'DELETE FROM player_items WHERE id = $1 AND player_id = $2', [rowId, playerId]);
  filled[idx] = true;
  codex[setId] = filled.map(Boolean);

  await query(db, 'UPDATE player_progress SET codex = $2, updated_at = now() WHERE player_id = $1',
    [playerId, JSON.stringify(codex)]);

  const complete = codex[setId].every(Boolean);
  return { setId, slotIdx: idx, complete, codex, bonus: codexTotalBonus(codex) };
}

module.exports = {
  usePotion, buyPotions, potionBagOf, useBuffPotion, expireBuffs,
  useTeleportStone, buyTeleportStone, pickupDrop, grantKillReward,
  registerCodexItem,
  HP_POTIONS, BUFF_POTIONS, POTION_CAP, UseError,
};
