'use strict';
// ── Combat stats, computed by the server from the database ──────────────────
// This file is the single fix for an entire class of exploit, so it is worth
// being precise about what that class is.
//
// THE HOLE. The client computes its own stats in recompute() (js/player.js)
// and pushes the result:
//
//     socket.on('statsUpdate', ({ atk, def, maxHp, critChance, critPower }) =>
//       currentRoom.updatePlayerStats(socket.id, { ... }))
//
// The server does not accept it blindly — it recomputes a "true base" and
// clamps the client's number to a headroom multiplier above it (×1.5 ATK,
// ×2.85 DEF, ×1.15 HP) to leave room for temporary buffs it cannot see. So the
// attack is not "set ATK to a million". It is quieter: write any catalog item
// into player.equipment in the console (every id is in bundle.js), let
// recompute() produce a huge number, push it, and keep ×1.5 ATK permanently
// with no buff running and nothing to expire.
//
// THE SHAPE OF THE MISTAKE. The clamp is a guess standing in for knowledge, and
// it fails in BOTH directions at once:
//
//   too loose — a cheater gets the whole headroom for free, forever;
//   too tight — the codex bonus is not in the server's own computeStats
//               (Room.js) at all, so an honest player with a completed set has
//               part of a bonus they legitimately earned eaten by the clamp.
//
// That combination is the signature of a defence that does not know the answer.
//
// THE FIX. The server stops asking. Every permanent input — class, level,
// upgrades, equipment with its enhancement, passives, codex, clan — is already
// in the database, and so are the temporary ones (buffs live in
// player_progress.buffs, written by usePotion). So the whole number can be
// computed here, and 'statsUpdate' can be DELETED rather than validated.
//
// A rule for anyone changing this: it must stay step-for-step identical to
// recompute() (js/player.js), including the ORDER of the multiplications.
// Floor() after each one means the order is not commutative — moving the clan
// bonus above the passives changes the result by a point or two, and the client
// and server disagreeing about a damage number is immediately visible in play.

const { query } = require('../index');
const {
  CHAR_DEF, enhanceBonus, passiveBonusTotal, codexTotalBonus,
  clanAtkBonusPct, xpToNext,
} = require('../../../shared/definitions');

// Everything the computation needs, in ONE round trip. Three queries would be
// three chances for the level to change between reading it and reading the
// items it scales against.
const LOAD_SQL = `
  SELECT
    pr.char_class, pr.lvl, pr.xp, pr.hp, pr.codex, pr.buffs,
    pr.upg_atk, pr.upg_def, pr.upg_hp, pr.upg_atk_speed,
    pr.upg_crit_chance, pr.upg_crit_power, pr.upg_hp_regen,
    COALESCE((
      SELECT json_agg(json_build_object(
               'id', i.item_id, 'slot', i.slot, 'enhance', i.enhance))
        FROM player_items i
       WHERE i.player_id = pr.player_id AND i.container = 'equipment'
    ), '[]'::json) AS equipped,
    COALESCE((
      SELECT json_object_agg(s.key, s.level)
        FROM player_skills s
       WHERE s.player_id = pr.player_id AND s.kind = 'passive' AND s.level > 0
    ), '{}'::json) AS passives,
    -- The three the COMBAT path needs. Read here rather than separately so
    -- they travel with the stats to Room.setPlayerStats — see the note above
    -- _skillMultFor in server/game/Room.js for what happened when they did not
    -- travel at all.
    COALESCE((
      SELECT json_object_agg(s.key, s.level)
        FROM player_skills s
       WHERE s.player_id = pr.player_id AND s.kind = 'skill' AND s.level > 0
    ), '{}'::json) AS skill_levels,
    COALESCE((
      SELECT json_object_agg(s.key, true)
        FROM player_skills s
       WHERE s.player_id = pr.player_id AND s.kind = 'adv_learned' AND s.level > 0
    ), '{}'::json) AS adv_learned,
    COALESCE((
      SELECT json_object_agg(s.key, true)
        FROM player_skills s
       WHERE s.player_id = pr.player_id AND s.kind = 'adv_active' AND s.level > 0
    ), '{}'::json) AS adv_active,
    COALESCE((
      SELECT c.level FROM clan_members m JOIN clans c ON c.id = m.clan_id
       WHERE m.player_id = pr.player_id
    ), 0) AS clan_level
  FROM player_progress pr
 WHERE pr.player_id = $1`;

// The catalog is the source of an item's stats — the row stores only id and
// enhancement, exactly like _canonSavedItem did, so a forged stat block has
// nowhere to live.
const { ITEM_DEF, CRAFT_MATS, BOX_DEF } = require('../../../shared/definitions');
const _byId = new Map([...ITEM_DEF, ...CRAFT_MATS, ...BOX_DEF].map(d => [d.id, d]));

async function load(db, playerId) {
  const { rows } = await query(db, LOAD_SQL, [playerId]);
  return rows.length ? rows[0] : null;
}

// Pure, given the loaded row — so it can be tested against recompute() without
// a database.
function compute(row) {
  // Object.hasOwn, not `CHAR_DEF[row.char_class] || CHAR_DEF.lev`. The `||`
  // reads like a safe fallback and is not one: CHAR_DEF is a plain object
  // literal (shared/definitions.js:36), so it inherits from Object.prototype
  // and 'constructor', '__proto__', 'toString', 'valueOf' and 'hasOwnProperty'
  // are all TRUTHY — the fallback is skipped for exactly the values that need
  // it. `Object.hasOwn(CHAR_DEF, 'constructor')` is false, which is the
  // question actually being asked. Same rule as PREF_FIELDS and UPG_COL in
  // players.js (:513, :617); UPG_COL's comment names 'constructor' too.
  //
  // What got through was not a crash. cd.baseHP on the Object constructor is
  // undefined, so baseAtk/baseDef/baseMaxHp below come out NaN and so does
  // every number derived from them — atk, def, maxHp. Those go to
  // Room.setPlayerStats, and NaN is absorbing: `Math.max(0, hp - dmg)` stays
  // NaN and `NaN <= 0` is FALSE, so the player never dies, while their NaN atk
  // writes NaN into the hp of the first enemy they hit and makes it unkillable
  // by everyone. One stored char_class of 'constructor' is a denial of the
  // world boss and the guild-war tower for the whole server.
  //
  // char_class reaching this function is a stored column, so this alone does
  // not stop a bad value being WRITTEN — the selectChar/setClass gates own
  // that. It stops a bad value that is already in the table from turning into
  // an immortal character, which is the part this file can answer for.
  //
  // The resolved KEY is kept, not just the definition it points at, because
  // it is needed a second time below (passiveBonusTotal takes a class name).
  // Handing that the raw column instead is the same bug wearing a different
  // hat: passivesForClass does `PASSIVE_CLASS_DEF[cls] || []` and spreads the
  // result, so 'constructor' gets it the Object constructor and throws
  // "is not iterable" out of a stats load — which is at least loud, but it is
  // still one packet taking a player's every stat refresh down.
  const known = Object.hasOwn(CHAR_DEF, row.char_class);
  const charClass = known ? row.char_class : 'lev';
  const cd = CHAR_DEF[charClass];
  // NULL is the ordinary case — char_class is "NULL until the player picks
  // one" (001_core.sql:75) and every fresh account loads stats before ever
  // choosing — so it is not worth a line. A non-null value that is not a class
  // is: char_class_t is a Postgres ENUM of the five real classes, so the
  // column cannot hold one, and if this ever fires it means the row did not
  // come from that column and the fallback is quietly changing somebody's
  // combat numbers. Logged rather than swallowed, so that shows up as
  // something an operator can read instead of as "персонаж сломался".
  if (!known && row.char_class != null) {
    console.warn(`[stats] unknown char_class ${JSON.stringify(row.char_class)} — using 'lev'`);
  }
  const level = row.lvl;
  const lvl = level - 1;                        // recompute() uses level-1 throughout

  // Derived, never stored: baseAtk/baseDef/baseMaxHp are a pure function of
  // class and level, and storing them is what let a crafted save hand itself
  // combat power with no relationship to the level that earned it.
  // The class's own figures plus level scaling, and NOTHING else — no
  // upgrades, no equipment, no codex. This is what the client calls baseAtk,
  // and its recompute() adds the upgrades and the gear on top. Handing it the
  // final number instead would have it count the sword twice.
  const baseAtk = cd.baseAtk + lvl;
  const baseDef = cd.baseDef + lvl;
  const baseMaxHp = cd.baseHP + lvl * 20;

  let a = baseAtk + row.upg_atk * 1;
  let d = baseDef + row.upg_def * 1;
  let h = baseMaxHp + row.upg_hp * 10;

  // Codex — flat, right after upgrades, exactly where recompute() puts it.
  // Absent from the server's old computeStats entirely, which is half of why
  // the clamp misbehaved.
  const cx = codexTotalBonus(row.codex || {});
  a += cx.atk || 0; d += cx.def || 0; h += cx.hp || 0;

  let extraCrit = 0, extraAS = 0, hpPct = 0, skillPct = 0;
  // ── три поля, которых раньше не было ──────────────────────────────────────
  // atkPct множит атаку (эпический питомец Вилорд: «Атака 30%»), speedPct —
  // скорость бега (крылья), critPowerAdd — силу крита (Грут). Складываются
  // как проценты и применяются ПОСЛЕ всех плоских прибавок, иначе порядок
  // слагаемых решал бы, сколько получится.
  let atkPct = 0, speedPct = 0, critPowerAdd = 0;
  // Не сила, а добыча: в атаку и защиту не идут, но считаются здесь — иначе
  // путь награды лез бы в инвентарь заново на каждое убийство.
  let xpPct = 0, dropPct = 0;
  for (const it of (row.equipped || [])) {
    const base = _byId.get(it.id);
    if (!base) continue;                        // retired id — contributes nothing
    const eb = enhanceBonus(base, it.enhance || 0);
    a += (base.atk || 0) + (eb.atk || 0);
    d += (base.def || 0) + (eb.def || 0);
    h += (base.hp  || 0) + (eb.hp  || 0);
    if (base.critChance) extraCrit += base.critChance;
    if (base.atkSpeed)   extraAS   += base.atkSpeed;
    if (base.hpPct)      hpPct     += base.hpPct;
    if (base.skillPct)   skillPct  += base.skillPct;
    if (base.atkPct)     atkPct    += base.atkPct;
    if (base.speedPct)   speedPct  += base.speedPct;
    if (base.critPower)  critPowerAdd += base.critPower;
    if (base.xpPct)      xpPct     += base.xpPct;
    if (base.dropPct)    dropPct   += base.dropPct;
  }
  // Проценты — после всех плоских прибавок и после кодекса.
  if (atkPct) a = Math.floor(a * (1 + atkPct));

  // The RESOLVED class, not the raw column — see the note at the top of this
  // function. passivesForClass spreads `PASSIVE_CLASS_DEF[cls] || []`, and a
  // prototype key makes that the Object constructor, which is truthy and not
  // iterable. Passing the same key the base stats above were taken from also
  // means the passives can never describe a different class from them.
  const pt = passiveBonusTotal(row.passives || {}, charClass);
  hpPct += pt.hpPct;
  h = Math.floor(h * (1 + hpPct));

  // Temporary buffs. The server owns these too (player_progress.buffs, written
  // by usePotion), which is what removes the last reason the clamp existed:
  // there is no longer anything about a player's power the server cannot see.
  // `> 0` was true for every buff ever drunk, because the column held seconds
  // remaining and nothing decremented them. It holds the millisecond a buff
  // ENDS now, so the question is whether that moment is still ahead.
  const buffs = row.buffs || {};
  const now = Date.now();
  const buffOn = t => Number(buffs[t] || 0) > now;
  if (buffOn('hp'))       h = Math.floor(h * 1.10);
  if (buffOn('atk'))      a = Math.floor(a * 1.20);
  if (buffOn('atkspeed')) extraAS += (cd.atkSpeed || 0) * 0.20;
  // Three of the six buff potions were written and never read: exp, gold and
  // regen. exp and gold are applied where a kill pays out (handlers2/world.js);
  // regen belongs here, with every other stat, and is the flat +2 HP/sec the
  // item's own text promises.
  const regenBuff = buffOn('regen') ? 2 : 0;

  a = Math.floor(a * (1 + pt.atkPct));
  d = Math.floor(d * (1 + pt.defPct));
  extraAS += (cd.atkSpeed || 0) * pt.atkSpeedPct;

  const clanPct = clanAtkBonusPct(row.clan_level || 0);
  if (clanPct > 0) a = Math.floor(a * (1 + clanPct / 100));

  return {
    level, xp: Number(row.xp), xpNext: xpToNext(level),
    charClass: row.char_class,
    baseAtk, baseDef, baseMaxHp,
    atk: a,
    def: d,
    maxHp: h,
    // Capped at 0.80 like recompute(): without it, enough crit gear makes every
    // hit a crit and the stat stops meaning anything.
    critChance: Math.min(0.80, 0.05 + lvl * 0.004 + row.upg_crit_chance * 0.01 + extraCrit),
    critPower:  1.5 + lvl * 0.015 + row.upg_crit_power * 0.03 + pt.critPowerFlat + critPowerAdd,
    atkSpeed:   (cd.atkSpeed || 0) * (1 + lvl * 0.015) + row.upg_atk_speed * 0.05 + extraAS,
    hpRegen:    lvl * 0.02 + row.upg_hp_regen * 0.1 + pt.hpRegenFlat + regenBuff,
    // Крылья — единственный слот, который двигает скорость бега. Считается
    // здесь, потому что от неё зависит, догонит ли игрока моб: это знание
    // комнаты, а не украшение в панели.
    moveSpeed:  (cd.speed || 0) * (1 + pt.moveSpeedPct + speedPct),
    skillPct,
    // Проценты добычи — в процентах, как VIP и клан рядом с ними в пути
    // награды: 0.20 здесь становится 20 там, и складывается с прочими.
    gearXpPct:   Math.round(xpPct * 100),
    gearDropPct: Math.round(dropPct * 100),
    // Not stats — but they ride with them, because everything that refreshes a
    // player's numbers is also the moment their skills should reach the Room.
    skillLevels: row.skill_levels || {},
    advSkillLearned: row.adv_learned || {},
    advSkillActive: row.adv_active || {},
    hp: Math.min(row.hp, h),
    clanAtkPct: clanPct,
  };
}

async function of(db, playerId) {
  const row = await load(db, playerId);
  return row ? compute(row) : null;
}

// Battle Power, from the same numbers. Kept here rather than in anticheat.js so
// the figure the leaderboard sorts by and the figure combat uses can never come
// from two different computations.
function battlePower(st, upgrades) {
  const u = upgrades || {};
  const extras = ((u.critChance || 0) + (u.critPower || 0) +
                  (u.hpRegen || 0) + (u.atkSpeed || 0)) * 8;
  return Math.round(st.level * 50 + st.atk * 5 + st.def * 3 + st.maxHp * 0.5 + extras);
}

// Recomputes and stores bm, so the leaderboard reads a column instead of
// deriving thirty numbers per row.
async function refreshBm(db, playerId) {
  const row = await load(db, playerId);
  if (!row) return null;
  // PERMANENT stats only. compute() applies whatever potion is running on top
  // (×1.20 ATK, ×1.10 HP — see the buff block above), and for COMBAT that is
  // exactly right: the buff is real while it lasts. For a RATING it is not.
  // The board would sort on who happened to be nine minutes into a potion, a
  // player's number would drop by itself when it wore off with nothing having
  // changed, and two identical characters would compare differently depending
  // on what was in their bag.
  //
  // It is also what the figure has always meant. Room.js's computeStats — the
  // other place this formula lives — documents itself as permanent-only, and
  // it is what the retired build's calcBM fed off.
  //
  // This became worth writing down when the number stopped being refreshed
  // only on a level-up: nine paths now write it, so a buffed value no longer
  // gets quietly corrected by the next kill.
  const st = compute({ ...row, buffs: {} });
  const bm = battlePower(st, {
    critChance: row.upg_crit_chance, critPower: row.upg_crit_power,
    hpRegen: row.upg_hp_regen, atkSpeed: row.upg_atk_speed,
  });
  await query(db, 'UPDATE players SET bm = $2, updated_at = now() WHERE id = $1', [playerId, bm]);
  return { bm, stats: st };
}

module.exports = { load, compute, of, battlePower, refreshBm };
