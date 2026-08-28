'use strict';
// Kill-loot rolling, moved out of server/index.js verbatim.
//
// Pure functions over an inventory array and the shared catalog: no models, no
// sockets, no session state — same shape as server/inventory.js, just for the
// "what drops" half instead of the "how items move" half.
const {
  ENEMY_DEF, ITEM_DEF, CRAFT_MATS, BOX_DEF, UNIQUE_SHARDS,
  armIndexForLevel, armLocalLevel, roomDropMult, roomKeyChance, roomEnchantStoneChance,
  EARLY_ZONE_ARMS, EARLY_ZONE_DROP_MULT,
  itemDropChanceAtLevel, itemRarityForLevel, dropLevelGapDivisor, BOSS_ITEM_DROP_MULT,
  UNIQUE_SHARD_MIN_LEVEL, UNIQUE_SHARD_CHANCE, UNIQUE_SHARD_MAX_QTY,
  levelSkillBookPool, levelClassPassivePool, levelUniversalPassivePool,
  FARM_SPECIES_SHARDS, FARM_SHARD_CHANCE, FARM_ADV_SKILL_BOOK_CHANCE, FARM_SPECIES_BOOKS,
  FARM_NORM_STONE_CHANCE, FARM_BLESS_STONE_CHANCE,
  FARM_EPIC_RECIPE_CHANCE, FARM_LEGENDARY_RECIPE_CHANCE,
  FARM2_BOX_RARE_CHANCE, FARM2_BOX_UNCOMMON_CHANCE,
  FARM2_NORM_STONE_CHANCE, FARM2_BLESS_STONE_CHANCE,
  FARM2_EPIC_RECIPE_CHANCE, FARM2_LEGENDARY_RECIPE_CHANCE, FARM2_ADV_SKILL_BOOK_CHANCE,
  FARM2_UNIQUE_WEAPON_CHANCE,
} = require('../../shared/definitions');
const { _invAdd } = require('../inventory');

// ── Mob kill loot roll ──────────────────────────────────────────────────────
// Mirrors applyLootToInventory (js/combat.js) exactly — recipe/equipment/
// room-key/enchant-stone/skill-book/passive-book drops on a regular kill.
// This used to be entirely client-rolled and only ever reached the server via
// the next saveProgress blob (which _canonSavedItem trusts for any valid id+
// enhance+qty) — the single biggest "items appearing out of nowhere" vector,
// since it fires on every kill in the game. Mutates `inv` in place via
// _invAdd; the caller ('attack'/'skillAttack' below) decides who this runs
// for (loot-winner arbitration among a party) and reports the result back.
function _rollMobLoot(inv, eid, rlvl, plvl) {
  const eDef = ENEMY_DEF.find(e => e.eid === eid);
  const eType = eDef ? eDef.eType : null;
  const granted = [];

  function addMat(id, qty) {
    const mat = CRAFT_MATS.find(m => m.id === id);
    if (mat && _invAdd(inv, { ...mat, qty })) granted.push({ id: mat.id, name: mat.name, rarity: mat.rarity, qty });
  }

  // Same drop multiplier as the client used: corridor arm × room-level growth.
  const _armIdx = armIndexForLevel(rlvl);
  const _localLvl = armLocalLevel(rlvl);
  const _dropMult = _armIdx * roomDropMult(_localLvl);
  const _zoneMult = EARLY_ZONE_ARMS.has(_armIdx) ? EARLY_ZONE_DROP_MULT : 1;

  // Recipe drop (all non-boss enemies)
  if (eType && eType !== 'boss') {
    const r = Math.random();
    if      (r < 0.00001 * _dropMult * _zoneMult) addMat('recl', 1);
    else if (r < 0.00021 * _dropMult * _zoneMult) addMat('rece', 1);
    else if (r < 0.00071 * _dropMult * _zoneMult) addMat('recr', 1);
    else if (r < 0.00171 * _dropMult * _zoneMult) addMat('recu', 1);
  }

  // Equipment drop — no cloak/artifact (craft-only), weapons unrestricted by
  // class (same as js/combat.js: any class's weapon can drop for anyone).
  const _itemChance = Math.min(100, itemDropChanceAtLevel(rlvl) * (eType === 'boss' ? BOSS_ITEM_DROP_MULT : 1))
    / dropLevelGapDivisor(plvl, rlvl) * _zoneMult;
  if (Math.random() * 100 < _itemChance) {
    const rarity = itemRarityForLevel(rlvl);
    const _gearSlots = ['weapon', 'helmet', 'body', 'gloves', 'boots', 'ring', 'belt'];
    // !d.noDrop excludes the unique weapons: they are epic/legendary `weapon`
    // entries like any other, so without it they would simply start dropping.
    const candidates = ITEM_DEF.filter(d => d.rarity === rarity && !d.noDrop && _gearSlots.includes(d.slot));
    if (candidates.length) {
      const it = candidates[Math.floor(Math.random() * candidates.length)];
      if (_invAdd(inv, { ...it })) granted.push({ id: it.id, name: it.name, rarity: it.rarity, qty: 1 });
    }
  }

  // Room-level key drops (forge box-crafting)
  if (Math.random() < roomKeyChance(_localLvl, 'uncommon') * _zoneMult) addMat('key_uncommon', 1);
  if (Math.random() < roomKeyChance(_localLvl, 'rare') * _zoneMult)     addMat('key_rare', 1);

  // Room-level enchant-stone drop
  if (Math.random() < roomEnchantStoneChance(_localLvl) * _zoneMult) addMat('norm_stone', 1);

  // Осколки для уникального оружия. Every kind rolls on its own, so one kill
  // can yield several different shards but never more than
  // UNIQUE_SHARD_MAX_QTY of the same one. Deliberately flat otherwise: no
  // arm/room multiplier and no boss bonus beyond the zone cut above — the
  // only other gate is the monster's level, so the drop reads the same
  // everywhere past it (outside arms 1-2) and cannot be farmed faster by
  // finding a favourable room.
  //
  // Math.random() has ~2^-53 granularity, so a chance this small is still
  // rolled honestly rather than collapsing to never/always.
  if (rlvl >= UNIQUE_SHARD_MIN_LEVEL) {
    for (const sh of UNIQUE_SHARDS) {
      if (Math.random() < UNIQUE_SHARD_CHANCE * _zoneMult) {
        addMat(sh.id, 1 + Math.floor(Math.random() * UNIQUE_SHARD_MAX_QTY));
      }
    }
  }

  // Skill books — restricted to a 5-book pool (one per class) that rotates
  // with this monster's own level; see levelSkillBookPool (shared/
  // definitions.js). BASE books only: the advanced ("2 профессия") ones are
  // farm-zone/forge-only and never roll here, at any level.
  const _skillBookPool = levelSkillBookPool(rlvl);
  if (_skillBookPool.length) {
    if (eType === 'boss') {
      if (Math.random() < 0.001 * _zoneMult) addMat(_skillBookPool[Math.floor(Math.random() * _skillBookPool.length)].id, 2);
    } else if (Math.random() < 0.00002 * Math.min(_dropMult, 3) * _zoneMult) {
      addMat(_skillBookPool[Math.floor(Math.random() * _skillBookPool.length)].id, 1);
    }
  }

  // Passive skill books — own independent roll/pool, same odds as above.
  // The class-exclusive half alternates offense/defense by level, the 6
  // universal ones rotate one-per-level, same as the skill books above.
  const _allPassiveBooks = levelClassPassivePool(rlvl).concat(levelUniversalPassivePool(rlvl));
  if (_allPassiveBooks.length) {
    if (eType === 'boss') {
      if (Math.random() < 0.001 * _zoneMult) addMat(_allPassiveBooks[Math.floor(Math.random() * _allPassiveBooks.length)].id, 2);
    } else if (Math.random() < 0.00002 * Math.min(_dropMult, 3) * _zoneMult) {
      addMat(_allPassiveBooks[Math.floor(Math.random() * _allPassiveBooks.length)].id, 1);
    }
  }

  return granted;
}

// ── Фарм-зона kill loot ──────────────────────────────────────────────────
// No equipment/key/regular-skill-book drops at all — just an independent
// FARM_SHARD_CHANCE roll per shard kind (same per-kind-independent shape as
// the normal shard roll in _rollMobLoot above, just flat and much higher,
// since farming shards is this zone's whole point) — picked from the KILLED
// SPECIES' OWN subset (FARM_SPECIES_SHARDS) rather than the full 20-shard
// catalog, same species-split treatment the books below get — independent
// norm/bless enchant-stone rolls (FARM_NORM_STONE_CHANCE/FARM_BLESS_STONE_
// CHANCE — 5x/3x the book chance, see their own comment in shared/
// definitions.js), independent epic/legendary recipe-scroll rolls
// (FARM_EPIC_RECIPE_CHANCE/FARM_LEGENDARY_RECIPE_CHANCE — flat, not species-
// split: a recipe isn't tied to any class or unique weapon), and one flat
// roll for a random advanced-skill book, picked from the killed species' own
// pool (FARM_SPECIES_BOOKS) rather than the full 20-book catalog — different
// species now drop different shards and books instead of all sharing one
// pool. Together with Элитная фарм-зона (_rollFarm2Loot below) and the forge
// craft (craftAdvSkillBook, server/handlers/craft.js — 10 base books at
// ADV_SKILL_BOOK_CRAFT.chance), this is the only way to get an advanced-skill
// book: ordinary corridor monsters never drop one (_rollMobLoot above).
function _rollFarmZoneLoot(inv, eid) {
  const granted = [];
  function addMat(id, qty) {
    const mat = CRAFT_MATS.find(m => m.id === id);
    if (mat && _invAdd(inv, { ...mat, qty })) granted.push({ id: mat.id, name: mat.name, rarity: mat.rarity, qty });
  }
  // Falls back to the full catalog for a species FARM_SPECIES_SHARDS doesn't
  // recognize (shouldn't happen for a real farmZone kill, but an empty
  // subset must never silently drop every shard roll for that species).
  const shardPool = (FARM_SPECIES_SHARDS[eid] && FARM_SPECIES_SHARDS[eid].length)
    ? FARM_SPECIES_SHARDS[eid]
    : UNIQUE_SHARDS.map(s => s.id);
  for (const shId of shardPool) {
    if (Math.random() < FARM_SHARD_CHANCE) addMat(shId, 1);
  }
  if (Math.random() < FARM_NORM_STONE_CHANCE) addMat('norm_stone', 1);
  if (Math.random() < FARM_BLESS_STONE_CHANCE) addMat('bless_stone', 1);
  if (Math.random() < FARM_EPIC_RECIPE_CHANCE) addMat('rece', 1);
  if (Math.random() < FARM_LEGENDARY_RECIPE_CHANCE) addMat('recl', 1);
  if (Math.random() < FARM_ADV_SKILL_BOOK_CHANCE) {
    // Falls back to the full pool for a species FARM_SPECIES_BOOKS doesn't
    // recognize (shouldn't happen for a real farmZone kill, but an empty
    // pool must never make this roll silently grant nothing).
    const pool = (FARM_SPECIES_BOOKS[eid] && FARM_SPECIES_BOOKS[eid].length)
      ? FARM_SPECIES_BOOKS[eid]
      : CRAFT_MATS.filter(m => m.advSkillKey).map(m => m.id);
    if (pool.length) addMat(pool[Math.floor(Math.random() * pool.length)], 1);
  }
  return granted;
}

// ── Элитная фарм-зона kill loot ──────────────────────────────────────────
// Same shape as _rollFarmZoneLoot above (independent flat rolls, no
// equipment/key/regular-skill-book drops), but no per-species split: this
// zone only runs FARM2_SPECIES' own two archetypes, so there is no reason to
// carve the box/stone/recipe/book pool up further the way FARM_SPECIES_
// SHARDS/FARM_SPECIES_BOOKS do — one random book from the FULL 20-book pool
// on the one book roll that lands. Liberty is NOT rolled here — it's
// currency (nexum), rolled and granted by the attack/skillAttack handlers
// the same way COOP_LIBERTY_CHANCE is (see FARM2_LIBERTY_CHANCE there).
function _rollFarm2Loot(inv) {
  const granted = [];
  function addMat(id, qty) {
    const mat = CRAFT_MATS.find(m => m.id === id);
    if (mat && _invAdd(inv, { ...mat, qty })) granted.push({ id: mat.id, name: mat.name, rarity: mat.rarity, qty });
  }
  function addBox(id, qty) {
    const box = BOX_DEF.find(b => b.id === id);
    if (box && _invAdd(inv, { ...box, qty })) granted.push({ id: box.id, name: box.name, rarity: box.rarity, qty });
  }
  if (Math.random() < FARM2_BOX_RARE_CHANCE) addBox('box_rare', 1);
  if (Math.random() < FARM2_BOX_UNCOMMON_CHANCE) addBox('box_uncommon', 1);
  if (Math.random() < FARM2_NORM_STONE_CHANCE) addMat('norm_stone', 1);
  if (Math.random() < FARM2_BLESS_STONE_CHANCE) addMat('bless_stone', 1);
  if (Math.random() < FARM2_EPIC_RECIPE_CHANCE) addMat('rece', 1);
  if (Math.random() < FARM2_LEGENDARY_RECIPE_CHANCE) addMat('recl', 1);
  if (Math.random() < FARM2_ADV_SKILL_BOOK_CHANCE) {
    const pool = CRAFT_MATS.filter(m => m.advSkillKey).map(m => m.id);
    if (pool.length) addMat(pool[Math.floor(Math.random() * pool.length)], 1);
  }
  // One random EPIC-tier unique weapon — see FARM2_UNIQUE_WEAPON_CHANCE's
  // own comment on why this is the one deliberate exception to `noDrop`.
  if (Math.random() < FARM2_UNIQUE_WEAPON_CHANCE) {
    const pool = ITEM_DEF.filter(d => d.unique && d.rarity === 'epic');
    if (pool.length) {
      const w = pool[Math.floor(Math.random() * pool.length)];
      if (_invAdd(inv, { ...w, enhance: 0 })) granted.push({ id: w.id, name: w.name, rarity: w.rarity, qty: 1 });
    }
  }
  return granted;
}

module.exports = { _rollMobLoot, _rollFarmZoneLoot, _rollFarm2Loot };
