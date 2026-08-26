'use strict';
// ── Players and progression ─────────────────────────────────────────────────
// This file is where the trust boundary lives, and it is inverted from what it
// replaces.
//
// The old model: the client sent a whole savedData blob, the server copied it
// wholesale (`const s = { ...raw }`), overwrote the fields it cared about, and
// persisted the result. Anything nobody had thought to overwrite went into the
// database exactly as the client wrote it. That is fail-OPEN — every new field
// added to savedData was client-authored by default until someone remembered
// to add a `delete`, which is how vipPending, seasonTicket, specialQuestsDone
// and seasonPoints2 each became an exploit in turn.
//
// Worse, the persist path built Mongo dot-paths from the client's own keys
// (`set['savedData.' + k]`), so a key like "vipPending.0" was a write straight
// into a server-owned array. I verified that on the live code: unknown keys
// survive the sanitizer untouched.
//
// The new model: there is no blob. savePrefs() below names SIX columns, and a
// key that is not one of them cannot be written, because there is no code path
// that would write it. Everything else — level, xp, gold, items, skills, VIP,
// season — is changed only by the server function that owns that rule, and
// each of those takes its inputs as arguments, not as a payload.
//
// Adding a new player-owned field means adding a column and a line here. That
// friction is the point: fail-CLOSED means the default for anything new is
// "the client cannot touch it".

const { query } = require('../index');
const { xpToNext, skillPointBudget, upgradeCost, CHAR_DEF, UPGRADE_KEYS, SKILL_MAX_LEVEL, PASSIVE_MAX_LEVEL } =
  require('../../../shared/definitions');

// ── identity ────────────────────────────────────────────────────────────────

async function byTelegramId(db, telegramId) {
  const { rows } = await query(db,
    `SELECT id, telegram_id, username, bm, banned, referred_by, admin_notified, created_at
       FROM players WHERE telegram_id = $1`, [String(telegramId)]);
  if (!rows.length) return null;
  const r = rows[0];
  return {
    id: Number(r.id), telegramId: r.telegram_id, username: r.username,
    bm: r.bm, banned: r.banned, referredBy: r.referred_by,
    adminNotified: r.admin_notified, createdAt: r.created_at,
  };
}

// Creates the account and its four satellite rows if this telegram id is new.
// One statement per table but ONE transaction from the caller, so a login that
// fails halfway cannot leave a players row with no progress attached — a state
// every reader would then have to defend against.
//
// ON CONFLICT DO NOTHING rather than a "does it exist" read first: two sockets
// from the same account arriving together (a refresh, a double-tap on the
// launch button) both find nothing and both insert, and the second one gets a
// duplicate-key error instead of a session.
async function ensure(db, telegramId, username) {
  const tg = String(telegramId);
  const { rows } = await query(db, `
    INSERT INTO players (telegram_id, username) VALUES ($1, $2)
    ON CONFLICT (telegram_id) DO NOTHING
    RETURNING id`, [tg, username]);

  const isNew = rows.length > 0;
  const id = isNew ? Number(rows[0].id)
                   : Number((await query(db, 'SELECT id FROM players WHERE telegram_id = $1', [tg])).rows[0].id);

  // Idempotent: a legacy account that predates one of these tables gets its
  // row on next login rather than needing a backfill migration.
  await query(db, `INSERT INTO player_progress (player_id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]);
  await query(db, `INSERT INTO player_prefs    (player_id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]);
  await query(db, `INSERT INTO player_vip      (player_id) VALUES ($1) ON CONFLICT DO NOTHING`, [id]);

  return { id, isNew };
}

// Display name comes from Telegram and can change between logins. Sanitising
// is the caller's job (security.js _safeUsername) — this only stores it.
async function setUsername(db, playerId, username) {
  await query(db, 'UPDATE players SET username = $2, updated_at = now() WHERE id = $1',
    [playerId, username]);
}

// ── who invited this player ─────────────────────────────────────────────────
// The only writer of players.referred_by, and until it existed there was NONE.
// Three finished features read that column and all three paid nobody: the 5%
// commission on an invited friend's deposit (repos/gram.js), the season points
// when they reach level 20 (repos/progression.js payReferralOnLevel) and the
// invited-friends list the client shows (repos/shop.js referralsOf). Each of
// them joins on a column that was empty for every account in the database, so
// each was a query returning zero rows rather than anything that looked broken.
//
// referred_by holds a TELEGRAM ID and its type is text (migrations/001_core.sql)
// — not a players.id, and not a number. Comparing it against an integer matches
// nothing and raises nothing, which is the failure mode this whole file exists
// to make impossible, so the id goes in as a string and is checked as one.
//
// ONE statement decides, rather than a read followed by a write. Two logins for
// the same account arriving together — a refresh, a second device, the client
// retrying a lost connect — both read "not referred yet", and the second then
// overwrites the first referrer. `referred_by IS NULL` inside the UPDATE means
// the loser writes nothing at all and is told `already`, which is also what a
// player gets for opening a second person's link a week later: the first
// referrer keeps the friend, forever, because the payouts above are once-only
// and there is no way to take one back.
//
// Returns { ok } plus a reason the caller can put in the log. Four refusals,
// each of them a thing somebody has asked an operator about:
//
//   malformed    a start_param that is not a telegram id at all
//   self         the player's own link — the first thing anyone tries
//   already      invited by somebody else, whether a second ago or last month
//   no_referrer  a link built from an id that has no account here
async function registerReferral(db, playerId, referrerTelegramId) {
  const ref = String(referrerTelegramId == null ? '' : referrerTelegramId).trim();
  // start_param is attacker-controlled text: it arrives in a URL a player
  // composes themselves and, if it were stored, would be shown back to whoever
  // opens the invited-friends panel. A telegram id is digits, so anything else
  // never reaches the database at all.
  if (!/^\d{1,20}$/.test(ref)) {
    return { ok: false, reason: 'malformed', msg: 'Некорректная ссылка-приглашение', refId: ref.slice(0, 64) };
  }

  const { rows } = await query(db, `
    UPDATE players p
       SET referred_by = r.telegram_id, updated_at = now()
      FROM players r
     WHERE p.id = $1
       AND r.telegram_id = $2
       AND p.referred_by IS NULL
       AND r.id <> p.id
    RETURNING r.id AS referrer_id, r.username AS referrer_username`, [playerId, ref]);
  if (rows.length) {
    return {
      ok: true, refId: ref,
      referrerId: Number(rows[0].referrer_id),
      referrerUsername: rows[0].referrer_username,
    };
  }

  // Nothing was written, and WHICH of the four it was cannot be read off a row
  // count of zero. One extra read, on a path that only runs when a referral was
  // already refused, is what turns the log line from "не зарегистрировалось"
  // into something an operator can answer a player with.
  const { rows: why } = await query(db, `
    SELECT p.telegram_id, p.referred_by,
           EXISTS (SELECT 1 FROM players r WHERE r.telegram_id = $2) AS referrer_exists
      FROM players p WHERE p.id = $1`, [playerId, ref]);
  if (!why.length) return { ok: false, reason: 'no_player', msg: 'Игрок не найден', refId: ref };
  // Self before already: an account that referred itself would otherwise be
  // reported as "invited by someone else" and the someone else would be them.
  if (why[0].telegram_id === ref) return { ok: false, reason: 'self', msg: 'Нельзя пригласить самого себя', refId: ref };
  if (why[0].referred_by) {
    return { ok: false, reason: 'already', msg: 'Игрок уже приглашён', refId: ref, referredBy: why[0].referred_by };
  }
  if (!why[0].referrer_exists) return { ok: false, reason: 'no_referrer', msg: 'Пригласивший не найден', refId: ref };
  // Every condition the UPDATE tests has just been shown to hold, so reaching
  // here means the row moved between the two statements. Named rather than
  // folded into one of the four above, because a reason that cannot happen and
  // then does is the one worth seeing in the log verbatim.
  return { ok: false, reason: 'raced', msg: 'Приглашение не записано', refId: ref };
}

// ── progression reads ───────────────────────────────────────────────────────

function _progress(r) {
  return {
    charClass: r.char_class,
    lvl: r.lvl, xp: Number(r.xp), xpNext: xpToNext(r.lvl),
    kills: Number(r.kills), hp: r.hp,
    bonusSP: r.bonus_sp, keptSP: r.kept_sp, rebirths: r.rebirths,
    upgrades: {
      atk: r.upg_atk, def: r.upg_def, hp: r.upg_hp,
      critChance: r.upg_crit_chance, critPower: r.upg_crit_power,
      atkSpeed: r.upg_atk_speed, hpRegen: r.upg_hp_regen,
    },
    floor: r.floor, x: r.pos_x, y: r.pos_y,
    questIdx: r.quest_idx, questKills: r.quest_kills,
    buffs: r.buffs, potionBag: r.potion_bag, codex: r.codex,
    starterBonusClaimed: r.starter_bonus_claimed,
  };
}

async function progressOf(db, playerId) {
  const { rows } = await query(db, 'SELECT * FROM player_progress WHERE player_id = $1', [playerId]);
  return rows.length ? _progress(rows[0]) : null;
}

async function prefsOf(db, playerId) {
  const { rows } = await query(db, 'SELECT * FROM player_prefs WHERE player_id = $1', [playerId]);
  if (!rows.length) return null;
  const r = rows[0];
  return {
    lang: r.lang, hudPotion: r.hud_potion, autoHpPct: r.auto_hp_pct,
    autoSkillsOn: r.auto_skills_on, autoSkillOff: r.auto_skill_off,
    autoBuffTypes: r.auto_buff_types,
  };
}

// Studied skills and passives, in the shape the client already expects.
async function skillsOf(db, playerId) {
  const { rows } = await query(db,
    'SELECT kind, key, level FROM player_skills WHERE player_id = $1', [playerId]);
  const out = { skillLevels: {}, passiveLevels: {}, advSkillLearned: {}, advSkillActive: {} };
  for (const r of rows) {
    if (r.kind === 'skill') out.skillLevels[r.key] = r.level;
    else if (r.kind === 'passive') out.passiveLevels[r.key] = r.level;
    else if (r.kind === 'adv_learned') out.advSkillLearned[r.key] = r.level > 0;
    else if (r.kind === 'adv_active') out.advSkillActive[r.key] = r.level > 0;
  }
  return out;
}

// ── THE allow-list ──────────────────────────────────────────────────────────
// The only place a client-supplied value reaches the database.
//
// Six fields, each with its own validator. A key that is not in this table is
// not written — not because it is filtered out somewhere, but because nothing
// here would write it. There is no `{...raw}` and no dot-path.
//
// Unknown keys are counted and reported rather than throwing: a client running
// yesterday's bundle after a deploy will legitimately send a field this build
// has retired, and refusing its entire save over that would lose real
// settings. The count is what makes the difference between "expected drift"
// and "something is sending us junk" visible instead of guessed at.
const PREF_FIELDS = {
  lang:          { col: 'lang',            ok: v => ['ru','en','uk','es','tr','pt'].includes(v) },
  hudPotion:     { col: 'hud_potion',      ok: v => v === null || (typeof v === 'string' && v.length <= 32) },
  autoHpPct:     { col: 'auto_hp_pct',     ok: v => Number.isFinite(v) && v >= 0 && v <= 1 },
  autoSkillsOn:  { col: 'auto_skills_on',  ok: v => typeof v === 'boolean' },
  autoSkillOff:  { col: 'auto_skill_off',  ok: v => _smallMap(v, k => ['Q','W','E','R'].includes(k)) },
  autoBuffTypes: { col: 'auto_buff_types', ok: v => _smallMap(v, k => k.length <= 32) },
};

// A plain object, small, with keys the caller vouches for and boolean values.
// The size bound matches the column's CHECK so a payload that would be
// rejected by the database is rejected here first, with a message that says
// which field.
function _smallMap(v, keyOk) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  if (keys.length > 16) return false;
  if (!keys.every(k => typeof k === 'string' && keyOk(k))) return false;
  return JSON.stringify(v).length < 512;
}

async function savePrefs(db, playerId, raw) {
  if (!raw || typeof raw !== 'object') return { written: 0, ignored: 0, rejected: [] };

  const sets = [], vals = [playerId];
  const rejected = [];
  let ignored = 0;

  for (const [key, value] of Object.entries(raw)) {
    // Object.hasOwn, not `PREF_FIELDS[key]`. A plain object inherits from
    // Object.prototype, so a lookup by "__proto__", "constructor", "toString"
    // or "valueOf" returns something TRUTHY that is not a field descriptor at
    // all — and JSON.parse produces "__proto__" as an own key, so a client can
    // send exactly that. The direct lookup crashed on `field.ok is not a
    // function`, which a caught-and-logged handler would have turned into a
    // save that silently never happened.
    //
    // This is the same class of mistake as the blob it replaces: treating
    // attacker-controlled strings as safe to index a structure with.
    const field = Object.hasOwn(PREF_FIELDS, key) ? PREF_FIELDS[key] : null;
    if (!field) { ignored++; continue; }            // not ours — see above
    if (!field.ok(value)) { rejected.push(key); continue; }
    vals.push(field.col === 'auto_skill_off' || field.col === 'auto_buff_types'
      ? JSON.stringify(value) : value);
    sets.push(`${field.col} = $${vals.length}`);
  }

  if (sets.length) {
    await query(db,
      `UPDATE player_prefs SET ${sets.join(', ')}, updated_at = now() WHERE player_id = $1`, vals);
  }
  return { written: sets.length, ignored, rejected };
}

// ── server-owned writes ─────────────────────────────────────────────────────
// Each of these exists because the server owns that rule. They take arguments,
// not a payload, so there is no shape for an extra field to arrive in.

// Position. Stored, never trusted: the floor is re-checked against level gates
// on the way back in (_restoreFloorFor), because the world can have moved on
// while the player was away.
async function savePosition(db, playerId, floor, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  await query(db, `
    UPDATE player_progress SET floor = $2, pos_x = $3, pos_y = $4, updated_at = now()
     WHERE player_id = $1`, [playerId, Math.trunc(floor) || 1, x, y]);
  return true;
}

async function setHp(db, playerId, hp) {
  await query(db, 'UPDATE player_progress SET hp = $2 WHERE player_id = $1',
    [playerId, Math.max(0, Math.trunc(hp) || 0)]);
}

async function setClass(db, playerId, charClass) {
  if (!CHAR_DEF[charClass]) throw new Error(`players: unknown class ${charClass}`);
  await query(db, `
    UPDATE player_progress SET char_class = $2, updated_at = now()
     WHERE player_id = $1 AND char_class IS NULL`, [playerId, charClass]);
}

// ── grantXp ─────────────────────────────────────────────────────────────────
// The server applies XP and runs the level curve. The client is told the
// result; it never proposes one.
//
// The whole loop happens inside ONE statement so that a level-up cannot be
// split across two writes — the old version's "xp saved, level not yet" window
// is what let a reconnect land between them and lose the level. plpgsql rather
// than a JS loop for the same reason: a round trip per level is a round trip
// per level, and a big quest reward can cross several at once.
async function grantXp(db, playerId, amount) {
  const amt = Math.max(0, Math.floor(Number(amount) || 0));
  if (!amt) return null;

  // The curve is xpToNext(lvl) from shared/definitions.js. It is evaluated in
  // JS and passed in as a lookup table rather than reimplemented in SQL: two
  // implementations of a level curve WILL drift, and the client already uses
  // this one.
  const { rows: cur } = await query(db,
    'SELECT lvl, xp FROM player_progress WHERE player_id = $1 FOR UPDATE', [playerId]);
  if (!cur.length) return null;

  let lvl = cur[0].lvl;
  let xp = Number(cur[0].xp) + amt;
  let gained = 0;
  // Bounded: the lvl column's CHECK stops at 1000, and a reward large enough
  // to cross a thousand levels is a bug worth capping rather than honouring.
  while (lvl < 1000 && xp >= xpToNext(lvl)) { xp -= xpToNext(lvl); lvl++; gained++; }

  await query(db, `
    UPDATE player_progress SET lvl = $2, xp = $3, updated_at = now()
     WHERE player_id = $1`, [playerId, lvl, xp]);

  // Battle Power is STORED (players.bm) and the rating board sorts on it, so
  // it has to be rewritten wherever one of its inputs moves — and level is its
  // largest single term. Here rather than at the call sites: four paths raise a
  // level (a kill, a party share, claimQuest, completeSpecialQuest) and only
  // the first ever refreshed, so levelling in a group or off a quest left the
  // board sorting the player at the rating they had before.
  //
  // Gated on an actual level-up, which is what keeps it off the per-kill path:
  // ordinary xp changes nothing battlePower() reads.
  if (gained > 0) await require('./stats').refreshBm(db, playerId);

  return { lvl, xp, xpNext: xpToNext(lvl), levelsGained: gained };
}

// ── spendUpgrade ────────────────────────────────────────────────────────────
// Buys one point of a stat. The budget check and the increment are one
// statement under the row lock taken by the SELECT, so two clicks arriving
// together cannot both pass a check against the same remaining point.
//
// skillPointBudget(lvl, rebirths) + bonus_sp is the same function the client
// uses to grey out the button, so the two can never disagree about how many
// points exist.
const UPG_COL = {
  atk: 'upg_atk', def: 'upg_def', hp: 'upg_hp', atkSpeed: 'upg_atk_speed',
  critChance: 'upg_crit_chance', critPower: 'upg_crit_power', hpRegen: 'upg_hp_regen',
};

async function spendUpgrade(db, playerId, key) {
  // Object.hasOwn for the same reason as PREF_FIELDS above: `UPG_COL['constructor']`
  // is truthy and would be interpolated straight into the UPDATE below.
  const col = Object.hasOwn(UPG_COL, key) ? UPG_COL[key] : null;
  if (!col) throw new Error(`players: unknown upgrade ${key}`);
  if (!UPGRADE_KEYS.includes(key)) throw new Error(`players: ${key} is not in UPGRADE_KEYS`);

  // The players row, before player_progress. This function now ends by writing
  // players.bm, and the kill path takes those two locks the other way round
  // (lockPlayer, then grantXp's FOR UPDATE) — buying a stat point while a kill
  // is in flight would be a lock cycle, which is the exact thing lockPlayer's
  // "FIRST statement" rule exists to make impossible. rebirth below already
  // opens this way.
  await require('./items').lockPlayer(db, playerId);

  const { rows } = await query(db, `
    SELECT lvl, rebirths, bonus_sp,
           upg_atk + upg_def + upg_hp + upg_atk_speed
         + upg_crit_chance + upg_crit_power + upg_hp_regen AS spent
      FROM player_progress WHERE player_id = $1 FOR UPDATE`, [playerId]);
  if (!rows.length) return null;
  const r = rows[0];
  const budget = skillPointBudget(r.lvl, r.rebirths) + r.bonus_sp;
  if (Number(r.spent) >= budget) return null;          // no points left

  // The gold. money.spend fuses affordability and deduction into one
  // statement, so an unaffordable upgrade cannot half-apply — and the idem key
  // names the exact point being bought, so a retry inside txRetry pays once.
  const { rows: cur } = await query(db,
    `SELECT ${col} AS v FROM player_progress WHERE player_id = $1`, [playerId]);
  const cost = upgradeCost(Number(cur[0].v) || 0);
  const money = require('./money');
  let goldLeft = null;
  if (cost > 0) {
    const paid = await money.spend(db, playerId, 'gold', cost, {
      reason: 'upgrade', refType: 'upgrade', refId: key,
      idemKey: `upg:${playerId}:${key}:${Number(cur[0].v) || 0}`,
    });
    // spend() returns null when the balance could not cover it — that is the
    // whole affordability check, fused into the UPDATE so two purchases in the
    // same instant cannot both pass against the same gold.
    if (!paid) return null;
    goldLeft = paid.balance;
  }

  const { rows: out } = await query(db, `
    UPDATE player_progress SET ${col} = ${col} + 1, updated_at = now()
     WHERE player_id = $1 RETURNING ${col} AS v`, [playerId]);
  // All seven upgrade columns are battlePower() inputs — four through atk/def/
  // maxHp and the other four as its `extras` term — so a point bought here is
  // rating the board has to see. Only on the success path: the three returns
  // above moved nothing.
  await require('./stats').refreshBm(db, playerId);
  return { key, level: out[0].v, remaining: budget - Number(r.spent) - 1, cost, gold: goldLeft };
}

// ── skills ──────────────────────────────────────────────────────────────────
// Levels are bounded by the database (player_skills CHECK level 0..99) and by
// the game's own maxima here. The old model stored these in a client-written
// map, so "my passive rolled back" was a whole class of report; a row the
// client cannot address has nothing to roll back.
async function setSkillLevel(db, playerId, kind, key, level) {
  const max = kind === 'passive' ? PASSIVE_MAX_LEVEL
            : kind === 'skill'   ? SKILL_MAX_LEVEL : 1;
  const lv = Math.max(0, Math.min(max, Math.floor(Number(level) || 0)));
  await query(db, `
    INSERT INTO player_skills (player_id, kind, key, level) VALUES ($1, $2, $3, $4)
    ON CONFLICT (player_id, kind, key) DO UPDATE SET level = EXCLUDED.level`,
    [playerId, kind, key, lv]);
  return lv;
}

// Raises a skill by one, never past its maximum, and reports whether it moved.
// Returning the fact rather than throwing lets the caller answer "already at
// max" without treating it as an error.
async function bumpSkill(db, playerId, kind, key) {
  const max = kind === 'passive' ? PASSIVE_MAX_LEVEL
            : kind === 'skill'   ? SKILL_MAX_LEVEL : 1;
  const { rows } = await query(db, `
    INSERT INTO player_skills (player_id, kind, key, level) VALUES ($1, $2, $3, 1)
    ON CONFLICT (player_id, kind, key) DO UPDATE
      SET level = player_skills.level + 1
      WHERE player_skills.level < $4
    RETURNING level`, [playerId, kind, key, max]);
  if (!rows.length) return { level: max, changed: false };
  // A PASSIVE is a battlePower() input and an active skill is not: passives
  // multiply atk, def and maxHp (passiveBonusTotal, repos/stats.js), while a
  // Q/W/E/R level only decides a damage coefficient in combat. Studying
  // "Кровавая ярость" to 10 really does raise a character's rating, and
  // without this it raised it only on paper.
  if (kind === 'passive') await require('./stats').refreshBm(db, playerId);
  return { level: rows[0].level, changed: true };
}

// ── rebirth ─────────────────────────────────────────────────────────────────
// Resets the character to level 1 and grants permanent bonus skill points, in
// exchange for a materials cost that grows with how many rebirths have already
// happened. Everything in one transaction: the old handler consumed materials,
// then reset the level, then granted the points, and a failure between any two
// of those left a character that had paid and not been reset — or reset twice.
//
// keptSP is the subtlety. Points already spent on upgrades are PRESERVED across
// a rebirth, so the reset must not simply zero the upgrades: it moves what was
// committed into kept_sp, leaving the total the player controls unchanged.
// Getting that wrong in either direction either steals progression or doubles it.
async function rebirth(db, playerId, cost, { minLevel, bonusSp }) {
  const items = require('./items');
  await items.lockPlayer(db, playerId);

  const { rows } = await query(db, `
    SELECT lvl, rebirths, bonus_sp, kept_sp,
           upg_atk + upg_def + upg_hp + upg_atk_speed
         + upg_crit_chance + upg_crit_power + upg_hp_regen AS spent
      FROM player_progress WHERE player_id = $1 FOR UPDATE`, [playerId]);
  if (!rows.length) throw Object.assign(new Error('Игрок не найден'), { code: 'no_player' });
  const st = rows[0];
  if (st.lvl < minLevel) {
    throw Object.assign(new Error(`Нужен ${minLevel} уровень`), { code: 'low_level', userMessage: `Нужен ${minLevel} уровень` });
  }

  for (const [itemId, need] of Object.entries(cost)) {
    if (!await items.removeQty(db, playerId, itemId, need)) {
      throw Object.assign(new Error(`Не хватает: ${itemId}`), { code: 'no_mats', userMessage: `Не хватает материалов: ${itemId}` });
    }
  }

  const { rows: out } = await query(db, `
    UPDATE player_progress
       SET lvl = 1, xp = 0,
           rebirths = rebirths + 1,
           bonus_sp = bonus_sp + $2,
           -- what was already committed stays committed, as kept points
           kept_sp  = kept_sp + $3,
           upg_atk = 0, upg_def = 0, upg_hp = 0, upg_atk_speed = 0,
           upg_crit_chance = 0, upg_crit_power = 0, upg_hp_regen = 0,
           updated_at = now()
     WHERE player_id = $1
    RETURNING rebirths, bonus_sp, kept_sp`, [playerId, bonusSp, Number(st.spent)]);

  // A rebirth is the single largest move a rating can make — level back to 1
  // and every upgrade column zeroed — and it moves it DOWN, which is the
  // direction nothing else here does. Left unwritten, a rebirthed character
  // keeps its pre-rebirth place on the board indefinitely, because the next
  // refresh is a level-up it now has to earn all over again.
  await require('./stats').refreshBm(db, playerId);

  return {
    rebirths: out[0].rebirths, bonusSP: out[0].bonus_sp, keptSP: out[0].kept_sp,
    lvl: 1, spentReturned: Number(st.spent),
  };
}

// ── resetUpgrades ───────────────────────────────────────────────────────────
// Refunds every spent point for a Nexum fee. `spent > 0` is checked inside the
// same transaction as the charge, so a double-click cannot pay twice for one
// reset — the second finds nothing spent.
async function resetUpgrades(db, playerId, cost) {
  const money = require('./money');
  // Same reason as spendUpgrade: this ends by writing players.bm, so the
  // players row is taken before player_progress and the lock order stays the
  // one every other path uses.
  await require('./items').lockPlayer(db, playerId);

  const { rows } = await query(db, `
    SELECT upg_atk + upg_def + upg_hp + upg_atk_speed
         + upg_crit_chance + upg_crit_power + upg_hp_regen AS spent
      FROM player_progress WHERE player_id = $1 FOR UPDATE`, [playerId]);
  if (!rows.length) throw Object.assign(new Error('Игрок не найден'), { code: 'no_player' });
  if (Number(rows[0].spent) <= 0) {
    throw Object.assign(new Error('Улучшений нет'), { code: 'nothing', userMessage: 'Улучшений нет — сбрасывать нечего' });
  }

  const paid = await money.spend(db, playerId, 'nexum', cost, {
    reason: 'upgrade_reset', refType: 'player', refId: String(playerId),
    // Random per attempt: resetting twice on purpose is two legitimate resets.
    idemKey: `upgrade_reset:${playerId}:${require('crypto').randomUUID()}`,
  });
  if (!paid) throw Object.assign(new Error('Недостаточно Liberty'), { code: 'no_nexum', userMessage: 'Недостаточно Liberty' });

  // kept_sp goes with the map it was covering. It is the part of a previous
  // rebirth's spend that the rebirth PRESERVED — emptying the upgrades ends
  // that commitment, so leaving it set means the server keeps charging the
  // player for upgrades they no longer have. The client already zeroes its own
  // copy from this reply, so the two would silently disagree about how many
  // points are spendable, and the server's answer — 'Мало очков навыка!' on a
  // panel showing points available — is the one that wins.
  await query(db, `
    UPDATE player_progress
       SET upg_atk = 0, upg_def = 0, upg_hp = 0, upg_atk_speed = 0,
           upg_crit_chance = 0, upg_crit_power = 0, upg_hp_regen = 0,
           kept_sp = 0, updated_at = now()
     WHERE player_id = $1`, [playerId]);

  // Seven columns just went to zero. The refund buys the points back, but the
  // rating that was standing on them is gone until they are re-spent.
  await require('./stats').refreshBm(db, playerId);

  // Named as the client reads them. It destructures
  // { pointsReturned, keptSP, newNexumBalance } — `refunded`/`nexumLeft`
  // arrived as three undefineds, which set the on-screen Liberty balance to
  // undefined every time somebody reset their upgrades.
  return {
    pointsReturned: Number(rows[0].spent),
    keptSP: 0,
    newNexumBalance: paid.balance,
    refunded: Number(rows[0].spent),      // the old names, for the tests
    nexumLeft: paid.balance,
  };
}

// Telegram id -> internal player id.
//
// The shipped client names OTHER players by telegram id everywhere — clanKick,
// clanApprove, clanStorageGive, requestPlayerProfile. Internally nothing else
// does: every foreign key points at players.id, which is why the repositories
// take that. The translation belongs here, at the edge, done once against the
// database rather than by trusting a client-supplied mapping.
async function idByTelegram(db, telegramId) {
  const tg = String(telegramId == null ? '' : telegramId);
  if (!tg) return null;
  const { rows } = await query(db, 'SELECT id FROM players WHERE telegram_id = $1', [tg]);
  return rows.length ? Number(rows[0].id) : null;
}

module.exports = {
  idByTelegram,
  byTelegramId, ensure, setUsername, registerReferral,
  progressOf, prefsOf, skillsOf,
  savePrefs, PREF_FIELDS,
  savePosition, setHp, setClass,
  grantXp, spendUpgrade,
  setSkillLevel, bumpSkill,
  rebirth, resetUpgrades,
};
