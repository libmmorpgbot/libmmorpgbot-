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
  ENHANCE_MAX, ENHANCEABLE_SLOTS, MERCHANT_SHOP, ITEM_DEF, BOX_DEF, CRAFT_MATS,
  GEAR_CRAFT_RECIPES, PET_CRAFT_RECIPES, GEAR_TIER_CRAFT_RECIPES,
  MAT_UPGRADE_RECIPES, CLASS_GEAR_SALVAGE_RECIPES, UNIQUE_CRAFT_RECIPES,
  ADV_SKILL_BOOK_CRAFT, craftResultEnhance,
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

// Choosing WHICH legendary a salvage or a recycle produces is worth as much
// as rolling whether it produces one, so it comes from the same source.
function pickOne(list) { return list[crypto.randomInt(list.length)]; }

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
  // BEFORE the stone. A normal stone can burn this row, and if the burn is
  // going to be refused by a foreign key the whole transaction rolls back —
  // refunding the stone and leaving the item intact. That is a free attempt,
  // repeatable to +15. Checked here, nothing is spent and nothing rolls back.
  if (stoneType !== 'bless') await items.assertDestroyable(db, rowId);

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
    return { outcome: 'success', rowId, itemId: it.item_id, from: it.enhance, to: it.enhance + 1, rate };
  }
  if (stoneType === 'bless') {
    return { outcome: 'fail', rowId, itemId: it.item_id, from: it.enhance, to: it.enhance, rate };
  }
  // Burned. The row is deleted, which is what makes the loss real rather than
  // a flag some later read has to remember to honour.
  await query(db, 'DELETE FROM player_items WHERE id = $1 AND player_id = $2', [rowId, playerId]);
  return { outcome: 'burned', rowId, itemId: it.item_id, from: it.enhance, to: null, rate };
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
    // minEnhance, not enhance. _haveMats counts copies at OR ABOVE the required
    // enhancement, so the take has to mean the same thing — the earlier version
    // passed no filter at all, which let a player pass the check on two +8 and
    // pay with two +0, keeping the enhanced pair. Same word, same meaning, both
    // ends of the operation.
    if (!await items.removeQty(db, playerId, m.id, m.n || 1,
        { minEnhance: m.minEnhance || null })) {
      // Unreachable after _haveMats inside the same transaction, and a throw
      // rather than a return because reaching it means the two disagree.
      err('no_mats', `Не хватает материалов: ${m.id}`);
    }
  }

  const chance = rec.chance == null ? 1 : Number(rec.chance);
  const success = chance >= 1 || rand() < chance;
  if (!success) return { outcome: 'fail', family, index, chance };

  // craftResultEnhance, not `rec.enhance` — no recipe has ever had that field,
  // so this granted +0 for every craft while the crafting window showed the
  // player a +6 item. See the function in shared/definitions.js.
  const rowId = await items.add(db, playerId, rec.itemId,
    { qty: rec.qty || 1, enhance: craftResultEnhance(rec) });
  if (rowId === null) err('no_room', 'Инвентарь полон');
  return { outcome: 'success', family, index, chance, itemId: rec.itemId, rowId };
}

// The advanced-book recycle: ten regular skill books of ANY class and slot,
// mixed freely, for one random advanced book at 30%.
//
// The first version of this function was wrong in a way worth recording,
// because the shape of the mistake will recur. It assumed ADV_SKILL_BOOK_CRAFT
// looked like the other recipes — `{ mats, itemId }` — and it does not; it is
// `{ count, chance }`, and the pool and the result are both computed rather
// than listed. So `_haveMats(undefined)` found nothing missing, `rec.itemId`
// was undefined, and the handler answered "Неизвестная книга" every single
// time. It never crafted anything, and the suite never called it.
//
// The general lesson: a table of recipes is not a schema. Three of the six
// families here carry a different shape, and treating the odd ones as if they
// were `gear` produces functions that fail silently rather than loudly.
async function craftAdvSkillBook(db, playerId) {
  await items.lockPlayer(db, playerId);
  const need = ADV_SKILL_BOOK_CRAFT.count;

  const sourceIds = CRAFT_MATS.filter(m => m.skillKey).map(m => m.id);
  const advBooks  = CRAFT_MATS.filter(m => m.advSkillKey);
  if (!sourceIds.length || !advBooks.length) err('bad_recipe', 'Рецепт не найден');

  const have = await items.countMatching(db, playerId, { itemIds: sourceIds });
  if (have < need) err('no_mats', `Нужно ${need} книг навыков (есть ${have})`);

  // The result is picked BEFORE the books are taken, so the room check below
  // is asked about the item that will actually arrive.
  const out = pickOne(advBooks);
  if (!await items.hasRoomFor(db, playerId, out.id)) err('no_room', 'Инвентарь полон');

  const { ok } = await items.consumeMatching(db, playerId, need, { itemIds: sourceIds });
  if (!ok) err('no_mats', `Нужно ${need} книг навыков`);

  // The books are spent either way. That is the recipe, not an accident, and
  // it is why the answer carries `chance` — a player who loses ten books to a
  // 30% roll deserves to see the number they were playing against.
  if (rand() >= ADV_SKILL_BOOK_CRAFT.chance) {
    return { outcome: 'fail', chance: ADV_SKILL_BOOK_CRAFT.chance, spent: need };
  }
  const rowId = await items.add(db, playerId, out.id);
  if (rowId === null) err('no_room', 'Инвентарь полон');
  return { outcome: 'success', chance: ADV_SKILL_BOOK_CRAFT.chance, itemId: out.id, rowId };
}

// ── pet ─────────────────────────────────────────────────────────────────────
// Liberty in, a random pet of the chosen rarity out. No materials.
//
// Everything the old handler did around this — an economy lock, a busy
// counter, a re-read of the session after the await, a cross-session hand-off
// to another socket, and a manual refund when that hand-off failed — existed
// because the charge and the grant were separate writes with an await between
// them. They are one transaction here, so all of it is gone: if the grant
// cannot happen the charge never committed, and there is nothing to refund
// because nothing was taken.
async function craftPet(db, playerId, rarity) {
  await items.lockPlayer(db, playerId);
  const rec = PET_CRAFT_RECIPES.find(r => r.rarity === rarity);
  if (!rec) err('bad_recipe', 'Неизвестная редкость питомца');

  const candidates = ITEM_DEF.filter(d => d.slot === 'pet' && d.rarity === rarity);
  if (!candidates.length) err('bad_recipe', 'Питомцы этой редкости не найдены');

  const pet = pickOne(candidates);
  if (!await items.hasRoomFor(db, playerId, pet.id)) err('no_room', 'Инвентарь полон');

  if (rec.nexumCost > 0) {
    const paid = await money.spend(db, playerId, 'nexum', rec.nexumCost, {
      reason: 'craft_pet', refType: 'pet', refId: String(rarity),
      idemKey: `craft_pet:${playerId}:${rarity}:${crypto.randomUUID()}`,
    });
    if (!paid) err('no_nexum', 'Недостаточно Liberty');
  }

  const chance = rec.chance == null ? 1 : Number(rec.chance);
  if (chance < 1 && rand() >= chance) return { outcome: 'fail', rarity, chance, cost: rec.nexumCost };

  const rowId = await items.add(db, playerId, pet.id);
  if (rowId === null) err('no_room', 'Инвентарь полон');
  return { outcome: 'success', rarity, chance, cost: rec.nexumCost, itemId: pet.id, rowId };
}

// ── material upgrade ────────────────────────────────────────────────────────
// Twenty of one tier for one of the next, at 80%.
async function upgradeMat(db, playerId, from) {
  await items.lockPlayer(db, playerId);
  const rec = MAT_UPGRADE_RECIPES.find(r => r.from === from);
  if (!rec) err('bad_recipe', 'Неизвестный рецепт');

  const have = await items.countMatching(db, playerId, { itemIds: [rec.from] });
  if (have < rec.count) {
    const def = CRAFT_MATS.find(m => m.id === rec.from);
    err('no_mats', `Нужно ${rec.count} × ${def ? def.name : rec.from} (есть ${have})`);
  }
  if (!await items.hasRoomFor(db, playerId, rec.to)) err('no_room', 'Инвентарь полон');

  if (!await items.removeQty(db, playerId, rec.from, rec.count)) {
    err('no_mats', `Нужно ${rec.count} × ${rec.from}`);
  }
  if (rand() >= rec.chance) {
    return { outcome: 'fail', from: rec.from, to: rec.to, chance: rec.chance, spent: rec.count };
  }
  const rowId = await items.add(db, playerId, rec.to);
  if (rowId === null) err('no_room', 'Инвентарь полон');
  return { outcome: 'success', from: rec.from, to: rec.to, chance: rec.chance, itemId: rec.to, rowId };
}

// ── class cloaks and artifacts ──────────────────────────────────────────────
// Salvage: N pieces of junk gear at a rarity, plus Liberty, for one random
// class-flavoured cloak or artifact of that rarity.
//
// "Junk gear" is now defined by the catalog — non-stackable, matching rarity —
// where the old handler asked the CLIENT'S copy of the inventory. That copy is
// whatever the client last sent, so an item could claim to be a non-stackable
// legendary and be counted as one. Rarity and stackability are columns here.
async function craftClassGear(db, playerId, slot, rarity) {
  await items.lockPlayer(db, playerId);
  const rec = CLASS_GEAR_SALVAGE_RECIPES.find(r => r.resultSlot === slot && r.resultRarity === rarity);
  if (!rec) err('bad_recipe', 'Неизвестный рецепт');

  const candidates = ITEM_DEF.filter(d =>
    d.classItem && d.slot === rec.resultSlot && d.rarity === rec.resultRarity);
  if (!candidates.length) err('bad_recipe', 'Предметы этой редкости не найдены');

  const filter = { rarity: rec.costRarity, stackable: false };
  const have = await items.countMatching(db, playerId, filter);
  if (have < rec.costCount) {
    err('no_mats', `Нужно ${rec.costCount} предметов редкости «${rec.costRarity}» (есть ${have})`);
  }

  const out = pickOne(candidates);
  if (!await items.hasRoomFor(db, playerId, out.id)) err('no_room', 'Инвентарь полон');

  if (rec.nexumCost > 0) {
    const paid = await money.spend(db, playerId, 'nexum', rec.nexumCost, {
      reason: 'craft_class_gear', refType: 'salvage', refId: `${slot}:${rarity}`,
      idemKey: `craft_class:${playerId}:${slot}:${rarity}:${crypto.randomUUID()}`,
    });
    if (!paid) err('no_nexum', `Нужно ${rec.nexumCost} Liberty`);
  }

  // Consumed AFTER the charge, and both inside the transaction — the ordering
  // no longer decides anything, which is the point. The old handler re-counted
  // the materials after its await and refunded by hand when the count had
  // moved; here a shortfall throws and the charge is not there to refund.
  const { ok } = await items.consumeMatching(db, playerId, rec.costCount, filter);
  if (!ok) err('no_mats', `Нужно ${rec.costCount} предметов редкости «${rec.costRarity}»`);

  const rowId = await items.add(db, playerId, out.id);
  if (rowId === null) err('no_room', 'Инвентарь полон');
  return { outcome: 'success', slot, rarity, cost: rec.nexumCost, itemId: out.id, rowId };
}

// ── naming a gear recipe by its result ──────────────────────────────────────
// The client asks for gear by the item it wants, not by a position in a list,
// and that is the better interface: an index is a promise never to reorder the
// table. Three lists can produce gear, searched in the order the old handler
// used so a duplicated id resolves the same way it always has.
function gearRecipeByItemId(itemId) {
  const lists = [['gear', GEAR_CRAFT_RECIPES], ['gearTier', GEAR_TIER_CRAFT_RECIPES],
                 ['unique', UNIQUE_CRAFT_RECIPES]];
  for (const [family, list] of lists) {
    const index = list.findIndex(r => r.itemId === itemId);
    if (index >= 0) return { family, index };
  }
  err('bad_recipe', 'Неизвестный рецепт');
}

// ── the box itself ──────────────────────────────────────────────────────────
// Keys into a box, at 100%. Distinct from openBox below, which spends the box
// AND a key to get what is inside — the client calls one `craftBox` and the
// other `openLootBox`, and confusing the two would quietly delete a player's
// key hoard.
async function craftBox(db, playerId, boxId) {
  await items.lockPlayer(db, playerId);
  const box = BOX_DEF.find(b => b.id === boxId);
  if (!box) err('bad_recipe', 'Неизвестный бокс');

  const have = await items.countMatching(db, playerId, { itemIds: [box.keyId] });
  if (have < box.keyCost) {
    const keyName = (CRAFT_MATS.find(m => m.id === box.keyId) || {}).name || box.keyId;
    err('no_mats', `Нужно ${box.keyCost} × ${keyName} (есть ${have})`);
  }
  if (!await items.hasRoomFor(db, playerId, box.id)) err('no_room', 'Инвентарь полон');

  if (!await items.removeQty(db, playerId, box.keyId, box.keyCost)) {
    err('no_mats', `Нужно ${box.keyCost} × ${box.keyId}`);
  }
  const rowId = await items.add(db, playerId, box.id);
  if (rowId === null) err('no_room', 'Инвентарь полон');
  return { outcome: 'success', boxId: box.id, spent: box.keyCost, rowId };
}


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

// The merchant moved to repos/consumables.js. It sells nothing but healing
// potions, and those live in player_progress.potion_bag rather than as
// inventory rows — see the comment there for why 999 potions cannot be 999
// rows. Leaving a second, item-shaped purchase path here would have been a
// second place for the same potion to exist.

async function sellItem(db, playerId, rowId, qty = 1) {
  await items.lockPlayer(db, playerId);

  const { rows } = await query(db, `
    SELECT i.id, i.item_id, i.qty, i.enhance
      FROM player_items i
     WHERE i.id = $1 AND i.player_id = $2 AND i.container = 'inventory'
     FOR UPDATE`, [rowId, playerId]);
  if (!rows.length) err('not_found', 'Предмет не найден');
  const it = rows[0];
  // Named before removeQty, which leaves such a row out of its pool entirely
  // and would answer "Предмет не найден" for an item sitting in plain sight.
  await items.assertDestroyable(db, rowId);

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
  craftPet, upgradeMat, craftClassGear, craftBox, gearRecipeByItemId,
  sellItem, recipeOf, rand, CraftError,
};
