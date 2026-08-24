'use strict';
// ── Crafting, enhancement, boxes, the merchant ──────────────────────────────
// This is where items are CREATED, so it is the last place a player could hand
// themselves something. Two changes from the old handlers matter more than the
// port itself.
//
// 1. AN ITEM IS NAMED BY ITS ROW, NOT BY (id, enhance).
//
//    enhanceItem took { id, enhance, slot } and searched the inventory for
//    something matching. With two identical items that is ambiguous, and the
//    old code carries a whole logging path (_enhNotFound, 'enhance_slot_
//    mismatch') built to investigate when the search found the wrong one or
//    nothing at all. A row id is unambiguous by construction: the WHERE clause
//    is `id = $1 AND player_id = $2`, so it either names an item this player
//    owns or it names nothing.
//
// 2. THE ROLLS USE crypto, NOT Math.random.
//
//    V8's Math.random is xorshift128+, whose internal state can be recovered
//    from a handful of consecutive outputs. Every roll here decides the value
//    of something convertible to GRAM and then to TON — an enhancement that
//    doubles an item's worth, a box that yields a legendary. That is a bad
//    place for a PRNG whose next output is predictable from its last few, and
//    crypto.randomInt costs nothing at these rates.
//
// Everything runs inside the caller's transaction, so a craft that fails
// halfway consumes nothing: the old code had to order its writes carefully so
// materials were taken only after the result was secured, and get that
// ordering right in eight separate handlers.

const crypto = require('crypto');
const { query } = require('../index');
const items = require('./items');
const money = require('./money');
const {
  ENHANCE_MAX, ENHANCEABLE_SLOTS, MERCHANT_SHOP, ITEM_DEF, BOX_DEF,
  GEAR_CRAFT_RECIPES, PET_CRAFT_RECIPES, GEAR_TIER_CRAFT_RECIPES,
  MAT_UPGRADE_RECIPES, CLASS_GEAR_SALVAGE_RECIPES, UNIQUE_CRAFT_RECIPES,
  ADV_SKILL_BOOK_CRAFT,
} = require('../../../shared/definitions');

class CraftError extends Error {
  constructor(code, msg) { super(msg); this.code = code; this.userMessage = msg; }
}
const err = (code, msg) => { throw new CraftError(code, msg); };

// A uniform random float in [0,1) from crypto. randomInt over a large range
// then divided, rather than reading bytes by hand — the modulo bias people get
// wrong is already handled inside randomInt.
const RAND_MAX = 2 ** 30;
function rand() { return crypto.randomInt(RAND_MAX) / RAND_MAX; }

// ── enhancement ─────────────────────────────────────────────────────────────
// Success rate is max(10, 80 - enhance*10) percent, exactly as the live build.
// A normal stone destroys the item on a miss; a blessed one does not.
function enhanceRate(current) {
  return Math.max(10, 80 - current * 10);
}

async function enhance(db, playerId, rowId, stoneType) {
  await items.lockPlayer(db, playerId);

  const stoneId = stoneType === 'bless' ? 'bless_stone' : 'norm_stone';

  // The target, named by row and scoped to this player. FOR UPDATE so a
  // concurrent equip cannot move it out from under the roll.
  const { rows } = await query(db, `
    SELECT i.id, i.item_id, i.enhance, i.container, i.slot, c.enhanceable
      FROM player_items i JOIN item_catalog c ON c.item_id = i.item_id
     WHERE i.id = $1 AND i.player_id = $2
     FOR UPDATE OF i`, [rowId, playerId]);
  if (!rows.length) err('not_found', 'Предмет не найден');
  const it = rows[0];

  if (!it.enhanceable || !ENHANCEABLE_SLOTS.has(it.slot || _slotOf(it.item_id))) {
    err('not_enhanceable', 'Этот предмет нельзя точить');
  }
  if (it.enhance >= ENHANCE_MAX) err('maxed', 'Уже максимальная заточка');

  // The stone is consumed whether the roll succeeds or not — that is the cost
  // of the attempt, and taking it first means a failed roll cannot leave the
  // player holding a stone they already spent.
  if (!await items.removeQty(db, playerId, stoneId, 1)) {
    err('no_stone', 'Нет камня заточки');
  }

  const rate = enhanceRate(it.enhance);
  const success = rand() * 100 < rate;

  if (success) {
    await query(db, 'UPDATE player_items SET enhance = enhance + 1 WHERE id = $1', [rowId]);
    return { outcome: 'success', rowId, from: it.enhance, to: it.enhance + 1, rate };
  }
  if (stoneType === 'bless') {
    return { outcome: 'fail', rowId, from: it.enhance, to: it.enhance, rate };
  }
  // Burned. The row is deleted, which is what makes the loss real rather than
  // a flag some later read has to remember to honour.
  await query(db, 'DELETE FROM player_items WHERE id = $1 AND player_id = $2', [rowId, playerId]);
  return { outcome: 'burned', rowId, from: it.enhance, to: null, rate };
}

function _slotOf(itemId) {
  const d = ITEM_DEF.find(x => x.id === itemId);
  return d ? d.slot : null;
}

// ── recipes ─────────────────────────────────────────────────────────────────
// Every recipe family shares one shape: consume `mats`, optionally spend Nexum,
// roll `chance`, produce `itemId`. Handling them through one function rather
// than eight near-identical handlers is what stops the families drifting apart
// — in the old code each had its own copy of "take the materials, then grant",
// and the ordering had to be right in all eight.
const FAMILIES = {
  gear:       GEAR_CRAFT_RECIPES,
  pet:        PET_CRAFT_RECIPES,
  gearTier:   GEAR_TIER_CRAFT_RECIPES,
  matUpgrade: MAT_UPGRADE_RECIPES,
  classGear:  CLASS_GEAR_SALVAGE_RECIPES,
  unique:     UNIQUE_CRAFT_RECIPES,
};

function recipeOf(family, index) {
  const list = FAMILIES[family];
  if (!Array.isArray(list)) err('bad_family', 'Неизвестный тип крафта');
  const rec = list[Math.floor(Number(index))];
  if (!rec) err('bad_recipe', 'Рецепт не найден');
  return rec;
}

// Checks the materials WITHOUT consuming them, so a craft that cannot proceed
// says so before anything is taken. Inside a transaction this is belt and
// braces — a throw would roll it back anyway — but a clear refusal is a better
// answer to the player than a rolled-back mystery.
async function _haveMats(db, playerId, mats) {
  for (const m of mats || []) {
    const { rows } = await query(db, `
      SELECT COALESCE(sum(qty), 0)::int n FROM player_items
       WHERE player_id = $1 AND container = 'inventory' AND item_id = $2
         AND enhance >= $3`, [playerId, m.id, m.minEnhance || 0]);
    if (rows[0].n < (m.n || 1)) return m;
  }
  return null;
}

async function craft(db, playerId, family, index) {
  await items.lockPlayer(db, playerId);
  const rec = recipeOf(family, index);

  const missing = await _haveMats(db, playerId, rec.mats);
  if (missing) {
    err('no_mats', `Не хватает материалов: ${missing.id}${missing.minEnhance ? ` +${missing.minEnhance}` : ''}`);
  }
  // Room BEFORE anything is consumed. A craft that produces an item with
  // nowhere to go would otherwise eat the materials and hand back nothing.
  if (!await items.hasRoomFor(db, playerId, rec.itemId)) {
    err('no_room', 'Инвентарь полон');
  }

  if (rec.nexumCost > 0) {
    const paid = await money.spend(db, playerId, 'nexum', rec.nexumCost, {
      reason: 'craft', refType: 'recipe', refId: `${family}:${index}`,
      // Not idempotent across attempts, deliberately: crafting the same recipe
      // twice is two legitimate crafts, so the key has to differ. A random
      // component makes each attempt its own event while still protecting
      // against a single attempt being applied twice inside one transaction.
      idemKey: `craft:${playerId}:${family}:${index}:${crypto.randomUUID()}`,
    });
    if (!paid) err('no_nexum', 'Недостаточно Liberty');
  }

  for (const m of rec.mats || []) {
    if (!await items.removeQty(db, playerId, m.id, m.n || 1,
        { enhance: m.minEnhance ? null : null })) {
      // Unreachable after _haveMats inside the same transaction, and a throw
      // rather than a return because reaching it means the two disagree.
      err('no_mats', `Не хватает материалов: ${m.id}`);
    }
  }

  const chance = rec.chance == null ? 1 : Number(rec.chance);
  const success = chance >= 1 || rand() < chance;
  if (!success) return { outcome: 'fail', family, index, chance };

  const rowId = await items.add(db, playerId, rec.itemId,
    { qty: rec.qty || 1, enhance: rec.enhance || 0 });
  if (rowId === null) err('no_room', 'Инвентарь полон');
  return { outcome: 'success', family, index, chance, itemId: rec.itemId, rowId };
}

// The advanced skill book has its own single recipe rather than a list.
async function craftAdvSkillBook(db, playerId, key) {
  await items.lockPlayer(db, playerId);
  const rec = ADV_SKILL_BOOK_CRAFT;
  if (!rec) err('bad_recipe', 'Рецепт не найден');

  const missing = await _haveMats(db, playerId, rec.mats);
  if (missing) err('no_mats', `Не хватает материалов: ${missing.id}`);

  const itemId = typeof rec.itemIdFor === 'function' ? rec.itemIdFor(key) : rec.itemId;
  if (!itemId) err('bad_recipe', 'Неизвестная книга');
  if (!await items.hasRoomFor(db, playerId, itemId)) err('no_room', 'Инвентарь полон');

  for (const m of rec.mats || []) {
    if (!await items.removeQty(db, playerId, m.id, m.n || 1)) err('no_mats', `Не хватает: ${m.id}`);
  }
  const success = (rec.chance == null ? 1 : Number(rec.chance)) >= 1 || rand() < rec.chance;
  if (!success) return { outcome: 'fail', chance: rec.chance };

  const rowId = await items.add(db, playerId, itemId);
  if (rowId === null) err('no_room', 'Инвентарь полон');
  return { outcome: 'success', itemId, rowId };
}

// ── boxes ───────────────────────────────────────────────────────────────────
// A box plus its key produce one item from a rarity table. The roll is the
// whole value of the box, so it goes through crypto like the rest.
async function openBox(db, playerId, boxId) {
  await items.lockPlayer(db, playerId);

  const box = BOX_DEF.find(b => b.id === boxId);
  if (!box) err('no_box', 'Бокс не найден');

  if (!await items.removeQty(db, playerId, box.id, 1)) err('no_box', 'Бокса нет в инвентаре');
  if (box.keyId && !await items.removeQty(db, playerId, box.keyId, 1)) {
    err('no_key', 'Нет ключа от бокса');
  }

  // Rarity first, then a uniform pick inside it — the same two-step the live
  // build uses, so the odds a player sees advertised stay true.
  const roll = rand();
  let acc = 0, rarity = box.odds[box.odds.length - 1].rarity;
  for (const o of box.odds) {
    acc += o.chance;
    if (roll < acc) { rarity = o.rarity; break; }
  }

  const pool = ITEM_DEF.filter(d => d.rarity === rarity && d.slot && d.slot !== 'use' && d.slot !== 'box');
  if (!pool.length) err('empty_pool', 'Пустая таблица наград');
  const won = pool[crypto.randomInt(pool.length)];

  const rowId = await items.add(db, playerId, won.id);
  if (rowId === null) err('no_room', 'Инвентарь полон — освободите слот');
  return { boxId, rarity, itemId: won.id, rowId };
}

// ── merchant ────────────────────────────────────────────────────────────────

async function buyFromMerchant(db, playerId, itemId, qty = 1) {
  await items.lockPlayer(db, playerId);

  const entry = MERCHANT_SHOP.find(e => e.itemId === itemId);
  if (!entry) err('not_sold', 'Торговец этого не продаёт');
  const n = Math.max(1, Math.min(999, Math.floor(Number(qty) || 1)));
  const cost = entry.price * n;

  if (!await items.hasRoomFor(db, playerId, itemId)) err('no_room', 'Инвентарь полон');

  const paid = await money.spend(db, playerId, 'gold', cost, {
    reason: 'merchant_buy', refType: 'item', refId: itemId,
    idemKey: `merchant:${playerId}:${itemId}:${crypto.randomUUID()}`,
  });
  if (!paid) err('no_gold', 'Недостаточно золота');

  const rowId = await items.add(db, playerId, itemId, { qty: n });
  if (rowId === null) err('no_room', 'Инвентарь полон');
  return { itemId, qty: n, cost, goldLeft: paid.balance, rowId };
}

// Selling is the inverse and takes a row id for the same reason enhance does:
// "sell the sw3" is ambiguous when two of them differ by enhancement, and the
// player means the one they clicked.
async function sellItem(db, playerId, rowId, qty = 1) {
  await items.lockPlayer(db, playerId);

  const { rows } = await query(db, `
    SELECT i.id, i.item_id, i.qty, i.enhance
      FROM player_items i
     WHERE i.id = $1 AND i.player_id = $2 AND i.container = 'inventory'
     FOR UPDATE`, [rowId, playerId]);
  if (!rows.length) err('not_found', 'Предмет не найден');
  const it = rows[0];

  const def = ITEM_DEF.find(d => d.id === it.item_id);
  const unit = def && def.price ? Math.floor(def.price / 2) : 1;
  const n = Math.max(1, Math.min(it.qty, Math.floor(Number(qty) || 1)));

  if (!await items.removeQty(db, playerId, it.item_id, n, { enhance: it.enhance })) {
    err('not_found', 'Предмет не найден');
  }
  const got = await money.credit(db, playerId, 'gold', unit * n, {
    reason: 'merchant_sell', refType: 'item', refId: it.item_id,
    idemKey: `sell:${playerId}:${rowId}:${crypto.randomUUID()}`,
  });
  return { itemId: it.item_id, qty: n, gold: unit * n, goldTotal: got.balance };
}

module.exports = {
  enhance, enhanceRate, craft, craftAdvSkillBook, openBox,
  buyFromMerchant, sellItem, recipeOf, rand, CraftError,
};
