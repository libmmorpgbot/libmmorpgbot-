'use strict';
// ── Quests, season, VIP and daily attempts ──────────────────────────────────
// Everything here is a "this may happen only once" rule, and every one of them
// was previously a value inside the client-writable blob:
//
//   specialQuestsDone : []      omit an id and the reward is claimable again
//   vipPending        : [...]   write a tier in and get its items for free
//   seasonTicket      : true    a permanent x2 xp / drop / Liberty bonus
//   seasonPoints2     : n       decides who takes a real USDT prize
//   fearAttempts      : n       reset it and the daily limit is gone
//
// The sanitizer eventually stripped each of them — but only after each had
// been exploited, and only for the exact key someone remembered. The pattern
// that keeps producing the bug is storing "has this happened" as a NUMBER OR
// FLAG THE CLIENT SENDS BACK.
//
// Here a claim is a ROW. Its existence is the fact. There is no field to omit,
// because absence is what "not claimed" already means, and the primary key is
// what makes a second claim impossible rather than merely checked-for.

const { query } = require('../index');
const items = require('./items');
const money = require('./money');
const {
  VIP_THRESHOLDS, QUEST_DEF, questComplete, seasonActive,
  SEASON_REF_POINTS, SEASON_REF_LEVEL, SEASON_END_AT, SEASON_RATING_MIN_POINTS,
  SEASON_PRIZES, SEASON_VIP_PRIZE, SEASON_ENHANCE_SPECIAL_SLOTS,
  SEASON_ENHANCE_SPECIAL_POINTS, SEASON_ENHANCE_GEAR_POINTS, SEASON_ADV_BOOK_POINTS,
  SEASON_BURN_POINTS, SEASON_BOOK_BURN_POINTS, SEASON_REBIRTH_POINTS,
  SEASON_SHOP_POINTS_PER_GRAM, CRAFT_MATS,
} = require('../../../shared/definitions');

class ProgressionError extends Error {
  constructor(code, msg) { super(msg); this.code = code; this.userMessage = msg; }
}
const err = (code, msg) => { throw new ProgressionError(code, msg); };

// The season a date belongs to. Kept as an explicit number rather than derived
// from "is the current season active", so a claim written a second before the
// deadline is still attributed to the season it was earned in.
const CURRENT_SEASON = 2;

// ── special quests ──────────────────────────────────────────────────────────
// One row per (player, quest). The PRIMARY KEY is the once-only rule: the
// second INSERT raises 23505 rather than needing a "have they already?" read
// that another request can land between.

async function claimSpecialQuest(db, playerId, questId) {
  const { rows: q } = await query(db,
    'SELECT id, reward_gold, reward_xp, reward_nexum, active FROM special_quests WHERE id = $1',
    [questId]);
  if (!q.length || !q[0].active) err('no_quest', 'Завдання недоступне');

  const { rowCount } = await query(db, `
    INSERT INTO player_special_quests (player_id, quest_id) VALUES ($1, $2)
    ON CONFLICT DO NOTHING`, [playerId, questId]);
  // Zero rows means the row was already there — already claimed. Not an error
  // worth a stack trace, but definitely not a second payout.
  if (!rowCount) err('already', 'Нагороду вже отримано');

  const reward = q[0];
  const idem = `special_quest:${playerId}:${questId}`;
  if (Number(reward.reward_gold) > 0) {
    await money.credit(db, playerId, 'gold', Number(reward.reward_gold),
      { reason: 'special_quest', refType: 'special_quest', refId: String(questId), idemKey: `${idem}:gold` });
  }
  if (Number(reward.reward_nexum) > 0) {
    await money.credit(db, playerId, 'nexum', Number(reward.reward_nexum),
      { reason: 'special_quest', refType: 'special_quest', refId: String(questId), idemKey: `${idem}:nexum` });
  }
  return {
    gold: Number(reward.reward_gold), xp: Number(reward.reward_xp), nexum: Number(reward.reward_nexum),
  };
}

async function claimedSpecialQuests(db, playerId) {
  const { rows } = await query(db,
    'SELECT quest_id FROM player_special_quests WHERE player_id = $1', [playerId]);
  return rows.map(r => Number(r.quest_id));
}

// ── the quest chain ─────────────────────────────────────────────────────────
// Counters are server-written from events the server already sees (kills,
// purchases, joining a clan). The client used to hold them, so it could walk
// the whole 60-quest chain in one go by reporting them complete.

async function bumpQuestKill(db, playerId, enemyName) {
  // jsonb_set on a path that may not exist yet needs the fallback, and doing
  // it in SQL keeps it one atomic statement — two kills in the same tick both
  // count, where a read-modify-write in JS would lose one.
  const { rows } = await query(db, `
    UPDATE player_progress
       SET quest_kills = jsonb_set(
             quest_kills, ARRAY[$2],
             to_jsonb(COALESCE((quest_kills ->> $2)::int, 0) + 1), true),
           updated_at = now()
     WHERE player_id = $1
    RETURNING quest_idx, quest_kills`, [playerId, String(enemyName)]);
  return rows.length ? { questIdx: rows[0].quest_idx, questKills: rows[0].quest_kills } : null;
}

// Advancing the chain is guarded by questComplete() — the same shared function
// the client uses to enable the button, so the two cannot disagree about
// whether a quest is done. `quest_idx = $2` in the WHERE is what stops a
// double-tap claiming the same quest twice.
async function claimQuest(db, playerId, questIdx) {
  const { rows } = await query(db, `
    SELECT quest_idx, quest_kills, lvl FROM player_progress
     WHERE player_id = $1 FOR UPDATE`, [playerId]);
  if (!rows.length) err('no_player', 'Гравця не знайдено');
  const st = rows[0];
  if (st.quest_idx !== questIdx) err('wrong_quest', 'Це не поточне завдання');

  const def = QUEST_DEF[questIdx];
  if (!def) err('no_quest', 'Завдання не існує');
  if (!questComplete(def, { questKills: st.quest_kills, lvl: st.lvl })) {
    err('not_done', 'Завдання ще не виконано');
  }

  await query(db, `
    UPDATE player_progress SET quest_idx = quest_idx + 1, quest_kills = '{}'::jsonb, updated_at = now()
     WHERE player_id = $1 AND quest_idx = $2`, [playerId, questIdx]);
  return { nextIdx: questIdx + 1, reward: def.reward || {} };
}

// ── VIP ─────────────────────────────────────────────────────────────────────
// Progress accrues from real GRAM spending. The tiers a player has crossed but
// not collected live in an array; claiming empties it and grants the items in
// the same transaction, so a claim that fails delivery grants nothing.

async function addVipSpend(db, playerId, gramAmount) {
  const amt = Number(gramAmount);
  if (!Number.isFinite(amt) || amt <= 0) return null;

  const { rows } = await query(db, `
    UPDATE player_vip SET deposited = deposited + $2::numeric, updated_at = now()
     WHERE player_id = $1
    RETURNING level, deposited`, [playerId, amt]);
  if (!rows.length) return null;

  const deposited = Number(rows[0].deposited);
  const was = rows[0].level;
  // The highest threshold this total has reached. Derived from the total, not
  // incremented — so a correction to `deposited` cannot leave the level behind.
  let now = 0;
  for (let i = 0; i < VIP_THRESHOLDS.length; i++) if (deposited >= VIP_THRESHOLDS[i]) now = i;
  if (now <= was) return { level: was, deposited, newTiers: [] };

  const gained = [];
  for (let t = was + 1; t <= now; t++) gained.push(t);
  await query(db, `
    UPDATE player_vip SET level = $2, pending = pending || $3::smallint[]
     WHERE player_id = $1`, [playerId, now, gained]);
  return { level: now, deposited, newTiers: gained };
}

// Collects every pending tier. The array is cleared in the SAME statement that
// reads it, so two clicks cannot both see the same tiers — the second finds an
// empty array. The old version read, awaited, then cleared, and the window
// between handed out the whole item set twice.
async function claimVip(db, playerId, itemsForTier) {
  await items.lockPlayer(db, playerId);

  // RETURNING old.pending — a PostgreSQL 18 feature, and the reason this is
  // one statement instead of three.
  //
  // A plain RETURNING gives the NEW row, so `RETURNING pending` after setting
  // it to '{}' returns an empty array: the tiers were consumed and the caller
  // was handed nothing to grant. That is exactly the bug — silently eating a
  // player's VIP rewards — and it only showed up because the test counted the
  // items granted rather than trusting the call to have worked.
  //
  // The alternative on older PostgreSQL is SELECT ... FOR UPDATE, then UPDATE:
  // correct, but two statements, and the gap between them is where the old
  // Mongo code handed out the whole item set twice.
  const { rows } = await query(db, `
    UPDATE player_vip SET pending = '{}', updated_at = now()
     WHERE player_id = $1 AND array_length(pending, 1) > 0
    RETURNING old.pending AS claimed, new.level AS level`, [playerId]);
  if (!rows.length) return { tiers: [], granted: [] };

  const tiers = rows[0].claimed.map(Number);
  const granted = [];
  for (const tier of tiers) {
    for (const it of (itemsForTier(tier) || [])) {
      // A throw here rolls the whole thing back INCLUDING the array clear, so
      // the tiers stay claimable. That is the behaviour the old code had to
      // implement by hand ("nothing is consumed on failure: vipPending is left
      // intact") and got wrong when the clear and the grant were separate.
      if (await items.add(db, playerId, it.id, { qty: it.qty || 1, enhance: it.enhance || 0 }) === null) {
        err('no_room', 'Інвентар повний — звільніть місце і заберіть нагороди знову');
      }
      granted.push(it);
    }
  }
  return { tiers, granted, level: rows[0].level };
}

async function vipOf(db, playerId) {
  const { rows } = await query(db,
    'SELECT level, deposited, pending, season_ticket FROM player_vip WHERE player_id = $1', [playerId]);
  if (!rows.length) return { level: 0, deposited: 0, pending: [], seasonTicket: false };
  return {
    level: rows[0].level, deposited: Number(rows[0].deposited),
    pending: rows[0].pending.map(Number), seasonTicket: rows[0].season_ticket,
  };
}

// Once per account, and `AND NOT season_ticket` is what makes it so: two
// purchases sent together cannot both spend, because the second matches no row.
async function grantSeasonTicket(db, playerId) {
  const { rowCount } = await query(db, `
    UPDATE player_vip SET season_ticket = true, updated_at = now()
     WHERE player_id = $1 AND NOT season_ticket`, [playerId]);
  return rowCount === 1;
}

// ── season ──────────────────────────────────────────────────────────────────

async function addSeasonPoints(db, playerId, points, season = CURRENT_SEASON) {
  const n = Math.max(0, Math.floor(Number(points) || 0));
  if (!n || !seasonActive()) return null;
  const { rows } = await query(db, `
    INSERT INTO player_season (player_id, season, points) VALUES ($1, $2, $3)
    ON CONFLICT (player_id, season) DO UPDATE SET points = player_season.points + EXCLUDED.points
    RETURNING points`, [playerId, season, n]);
  return Number(rows[0].points);
}

// The referral bonus: paid once, when an invited friend crosses the level
// threshold. `ref_paid` lives on the FRIEND's row — on the old model it was a
// field in the friend's own blob, so they could clear it and have their
// referrer paid again on the next login.
async function paySeasonReferral(db, friendId, referrerId, friendLevel, season = CURRENT_SEASON) {
  if (friendLevel < SEASON_REF_LEVEL || !seasonActive()) return null;
  const { rowCount } = await query(db, `
    INSERT INTO player_season (player_id, season, ref_paid) VALUES ($1, $2, true)
    ON CONFLICT (player_id, season) DO UPDATE SET ref_paid = true
     WHERE NOT player_season.ref_paid`, [friendId, season]);
  if (!rowCount) return null;                       // already paid for this friend
  return addSeasonPoints(db, referrerId, SEASON_REF_POINTS, season);
}

// The leaderboard. Indexed by (season, points DESC) WHERE points > 0, so this
// is an index scan rather than the full-collection sort plus in-memory ordering
// the Mongo version ran on every request — from a PLAYER-facing handler.
async function seasonBoard(db, { season = CURRENT_SEASON, limit = 50, minPoints = 1 } = {}) {
  const { rows } = await query(db, `
    SELECT s.player_id, s.points, p.username, p.bm
      FROM player_season s JOIN players p ON p.id = s.player_id
     WHERE s.season = $1 AND s.points >= $2
     ORDER BY s.points DESC, s.player_id
     LIMIT $3`, [season, minPoints, Math.min(limit, 200)]);
  return rows.map((r, i) => ({
    place: i + 1, playerId: Number(r.player_id), username: r.username,
    points: Number(r.points), bm: r.bm,
  }));
}

async function seasonOf(db, playerId, season = CURRENT_SEASON) {
  const { rows } = await query(db, `
    SELECT points, tier, boss_paid, ref_paid, quests,
           (SELECT count(*) + 1 FROM player_season s2
             WHERE s2.season = $2 AND s2.points > s.points)::int AS place
      FROM player_season s WHERE player_id = $1 AND season = $2`, [playerId, season]);
  if (!rows.length) return { points: 0, tier: 0, place: null, bossPaid: false, refPaid: false, quests: {} };
  const r = rows[0];
  return {
    points: Number(r.points), tier: r.tier, place: r.place,
    bossPaid: r.boss_paid, refPaid: r.ref_paid, quests: r.quests,
  };
}

// ── daily attempts ──────────────────────────────────────────────────────────
// One row per (player, day, mode). The old version kept these in the blob and
// updated them with a read-modify-write, so two entries started in the same
// second each spent one attempt and only one was recorded.
//
// The upsert below is the whole rule: `used + 1 <= limit` inside the WHERE
// means "take an attempt if one is left" is a single decision. Zero rows back
// means none was left, and nothing was spent.

// ── burning for season points ───────────────────────────────────────────────
// Gear is destroyed outright: no gold, no materials back, only points. So the
// two writes — the item gone, the points added — have to be one thing. The old
// handler could not make them one, and its comment says exactly what it chose
// instead:
//
//     "Points FIRST. The destruction used to be committed before this await,
//      so a failed points write burned the item for nothing. Awarding first
//      means the worst case is points credited for a burn that then didn't
//      happen, which the player can simply redo."
//
// That is a well-reasoned choice between two bad outcomes, and inside a
// transaction there is no choice to make: either both happen or neither does.
// The re-resolution after the await, the index re-check, the desync branch that
// pushed the whole inventory back and logged 'season_burn_desync' — all of it
// was scaffolding for a gap that no longer exists.
//
// The VALUE comes from item_catalog, never from the request. A crafted burn
// claiming a common is an uncommon is the difference between 1 point and 5.

// What one row is worth. Non-stackable only: books have their own flat rate,
// and materials are worth nothing.
async function burnValueOf(db, playerId, rowId) {
  const { rows } = await query(db, `
    SELECT pi.id, pi.item_id, c.rarity, c.stackable
      FROM player_items pi JOIN item_catalog c ON c.item_id = pi.item_id
     WHERE pi.id = $1 AND pi.player_id = $2 AND pi.container = 'inventory'`,
    [rowId, playerId]);
  if (!rows.length) return null;
  const r = rows[0];
  if (r.stackable) return null;
  return { itemId: r.item_id, rarity: r.rarity, points: SEASON_BURN_POINTS[r.rarity] || 0 };
}

async function burnItem(db, playerId, rowId) {
  if (!seasonActive()) err('season_over', 'Сезон завершён');
  await items.lockPlayer(db, playerId);

  const v = await burnValueOf(db, playerId, rowId);
  if (!v) err('not_found', 'Предмет не найден — список обновлён');
  if (!v.points) err('cannot_burn', 'Этот предмет нельзя сжечь');

  const { rowCount } = await query(db,
    'DELETE FROM player_items WHERE id = $1 AND player_id = $2', [rowId, playerId]);
  if (!rowCount) err('not_found', 'Предмет не найден — список обновлён');

  const total = await addSeasonPoints(db, playerId, v.points);
  return { burned: 1, points: v.points, total: total == null ? 0 : total, itemId: v.itemId };
}

// Everything of one rarity, in one statement. The old version collected the
// indices, awaited the points write, then re-checked each index on the way back
// because the array could have moved — a loop that could half-finish. This
// deletes exactly the rows it counted, because it counts and deletes in the
// same statement.
async function burnAllOfRarity(db, playerId, rarity) {
  if (!seasonActive()) err('season_over', 'Сезон завершён');
  const per = SEASON_BURN_POINTS[rarity];
  if (!per) err('cannot_burn', 'Эту редкость нельзя сжечь');
  await items.lockPlayer(db, playerId);

  const { rows } = await query(db, `
    DELETE FROM player_items pi
     USING item_catalog c
     WHERE c.item_id = pi.item_id
       AND pi.player_id = $1 AND pi.container = 'inventory'
       AND NOT c.stackable AND c.rarity = $2
    RETURNING pi.id`, [playerId, rarity]);
  if (!rows.length) err('nothing', 'Нечего сжигать');

  const points = rows.length * per;
  const total = await addSeasonPoints(db, playerId, points);
  return { burned: rows.length, points, total: total == null ? 0 : total };
}

// Books are stackable, so they are addressed by id and count rather than by
// row, and they pay a flat rate whichever book it is.
async function burnBooks(db, playerId, itemId, qty) {
  if (!seasonActive()) err('season_over', 'Сезон завершён');
  const def = CRAFT_MATS.find(m => m.id === itemId);
  if (!def || !(def.skillKey || def.passiveId || def.advSkillKey)) {
    err('cannot_burn', 'Эту вещь нельзя сжечь');
  }
  await items.lockPlayer(db, playerId);

  const have = await items.countMatching(db, playerId, { itemIds: [itemId] });
  if (!have) err('not_found', 'Предмет не найден — список обновлён');
  const n = Math.max(1, Math.min(Math.floor(Number(qty)) || 1, have));

  if (!await items.removeQty(db, playerId, itemId, n)) {
    err('not_found', 'Предмет не найден — список обновлён');
  }
  const points = n * SEASON_BOOK_BURN_POINTS;
  const total = await addSeasonPoints(db, playerId, points);
  return { burned: n, points, total: total == null ? 0 : total };
}

// Everything the season tab renders from, in the shape the client already
// merges into its own copy. The constants ride along because the client draws
// the whole "what is worth how much" table from them.
async function seasonState(db, playerId) {
  const mine = await seasonOf(db, playerId);
  return {
    endAt: SEASON_END_AT,
    active: seasonActive(),
    points: mine.points,
    place: mine.place,
    minRatingPoints: SEASON_RATING_MIN_POINTS,
    prizes: SEASON_PRIZES,
    vipPrize: SEASON_VIP_PRIZE,
    enhanceSpecialSlots: [...SEASON_ENHANCE_SPECIAL_SLOTS],
    enhanceSpecial: SEASON_ENHANCE_SPECIAL_POINTS,
    enhanceGear: SEASON_ENHANCE_GEAR_POINTS,
    advBookPoints: SEASON_ADV_BOOK_POINTS,
    burn: SEASON_BURN_POINTS,
    bookBurnPoints: SEASON_BOOK_BURN_POINTS,
    ref: { points: SEASON_REF_POINTS, level: SEASON_REF_LEVEL },
    rebirthPoints: SEASON_REBIRTH_POINTS,
    shopPointsPerGram: SEASON_SHOP_POINTS_PER_GRAM,
  };
}

async function takeAttempt(db, playerId, mode, limit) {
  const { rows } = await query(db, `
    INSERT INTO player_daily (player_id, day, mode, used)
    VALUES ($1, CURRENT_DATE, $2, 1)
    ON CONFLICT (player_id, day, mode) DO UPDATE
      SET used = player_daily.used + 1
      WHERE player_daily.used < $3
    RETURNING used`, [playerId, mode, limit]);
  return rows.length ? { used: rows[0].used, left: limit - rows[0].used } : null;
}

async function attemptsLeft(db, playerId, mode, limit) {
  const { rows } = await query(db, `
    SELECT used FROM player_daily
     WHERE player_id = $1 AND day = CURRENT_DATE AND mode = $2`, [playerId, mode]);
  return limit - (rows.length ? rows[0].used : 0);
}

// Elite farm zone bills minutes rather than entries, so the same "spend only
// what is left" shape applies to a seconds budget.
//
// The ::int casts are required, not decorative: node-postgres sends every
// parameter as text, and inside LEAST() PostgreSQL has no column to infer the
// type from — it resolves both arguments as text and then refuses to assign
// text to an integer column. Anywhere a parameter is used only inside a
// function call rather than compared against a column, it needs the cast.
async function spendSeconds(db, playerId, mode, seconds, budgetSeconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (!s) return { spent: 0, left: await secondsLeft(db, playerId, mode, budgetSeconds) };
  const { rows } = await query(db, `
    INSERT INTO player_daily (player_id, day, mode, seconds)
    VALUES ($1, CURRENT_DATE, $2, LEAST($3::int, $4::int))
    ON CONFLICT (player_id, day, mode) DO UPDATE
      SET seconds = LEAST(player_daily.seconds + $3::int, $4::int)
    RETURNING seconds`, [playerId, mode, s, budgetSeconds]);
  return { spent: s, left: budgetSeconds - rows[0].seconds };
}

async function secondsLeft(db, playerId, mode, budgetSeconds) {
  const { rows } = await query(db, `
    SELECT seconds FROM player_daily
     WHERE player_id = $1 AND day = CURRENT_DATE AND mode = $2`, [playerId, mode]);
  return budgetSeconds - (rows.length ? rows[0].seconds : 0);
}

module.exports = {
  burnItem, burnAllOfRarity, burnBooks, burnValueOf, seasonState,
  claimSpecialQuest, claimedSpecialQuests,
  bumpQuestKill, claimQuest,
  addVipSpend, claimVip, vipOf, grantSeasonTicket,
  addSeasonPoints, paySeasonReferral, seasonBoard, seasonOf,
  takeAttempt, attemptsLeft, spendSeconds, secondsLeft,
  CURRENT_SEASON, ProgressionError,
};
