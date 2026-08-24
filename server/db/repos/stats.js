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
  const cd = CHAR_DEF[row.char_class] || CHAR_DEF.lev;
  const level = row.lvl;
  const lvl = level - 1;                        // recompute() uses level-1 throughout

  // Derived, never stored: baseAtk/baseDef/baseMaxHp are a pure function of
  // class and level, and storing them is what let a crafted save hand itself
  // combat power with no relationship to the level that earned it.
  let a = (cd.baseAtk + lvl) + row.upg_atk * 1;
  let d = (cd.baseDef + lvl) + row.upg_def * 1;
  let h = (cd.baseHP + lvl * 20) + row.upg_hp * 10;

  // Codex — flat, right after upgrades, exactly where recompute() puts it.
  // Absent from the server's old computeStats entirely, which is half of why
  // the clamp misbehaved.
  const cx = codexTotalBonus(row.codex || {});
  a += cx.atk || 0; d += cx.def || 0; h += cx.hp || 0;

  let extraCrit = 0, extraAS = 0, hpPct = 0, skillPct = 0;
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
  }

  const pt = passiveBonusTotal(row.passives || {}, row.char_class);
  hpPct += pt.hpPct;
  h = Math.floor(h * (1 + hpPct));

  // Temporary buffs. The server owns these too (player_progress.buffs, written
  // by usePotion), which is what removes the last reason the clamp existed:
  // there is no longer anything about a player's power the server cannot see.
  const buffs = row.buffs || {};
  if (buffs.hp       > 0) h = Math.floor(h * 1.10);
  if (buffs.atk      > 0) a = Math.floor(a * 1.20);
  if (buffs.atkspeed > 0) extraAS += (cd.atkSpeed || 0) * 0.20;

  a = Math.floor(a * (1 + pt.atkPct));
  d = Math.floor(d * (1 + pt.defPct));
  extraAS += (cd.atkSpeed || 0) * pt.atkSpeedPct;

  const clanPct = clanAtkBonusPct(row.clan_level || 0);
  if (clanPct > 0) a = Math.floor(a * (1 + clanPct / 100));

  return {
    level, xp: Number(row.xp), xpNext: xpToNext(level),
    charClass: row.char_class,
    atk: a,
    def: d,
    maxHp: h,
    // Capped at 0.80 like recompute(): without it, enough crit gear makes every
    // hit a crit and the stat stops meaning anything.
    critChance: Math.min(0.80, 0.05 + lvl * 0.004 + row.upg_crit_chance * 0.01 + extraCrit),
    critPower:  1.5 + lvl * 0.015 + row.upg_crit_power * 0.03 + pt.critPowerFlat,
    atkSpeed:   (cd.atkSpeed || 0) * (1 + lvl * 0.015) + row.upg_atk_speed * 0.05 + extraAS,
    hpRegen:    lvl * 0.02 + row.upg_hp_regen * 0.1 + pt.hpRegenFlat,
    moveSpeed:  (cd.speed || 0) * (1 + pt.moveSpeedPct),
    skillPct,
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
  const st = compute(row);
  const bm = battlePower(st, {
    critChance: row.upg_crit_chance, critPower: row.upg_crit_power,
    hpRegen: row.upg_hp_regen, atkSpeed: row.upg_atk_speed,
  });
  await query(db, 'UPDATE players SET bm = $2, updated_at = now() WHERE id = $1', [playerId, bm]);
  return { bm, stats: st };
}

module.exports = { load, compute, of, battlePower, refreshBm };
