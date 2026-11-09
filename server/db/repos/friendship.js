'use strict';
// ── «Дружба» (второй запуск) и «Комбо дня» ──────────────────────────────────
// Состав наград — FRIEND_EVENT_TIERS / DAILY_COMBO (shared/definitions.js),
// чтобы окно (js/ui.js) обещало ровно то, что выдаётся здесь.
//
// Обе функции живут на уже существующих таблицах — новой миграции нет, деплой
// не ждёт ручного migrate-now:
//   player_friendship_claims (022) — забранные тиры, номер тира
//                                    FRIEND_EVENT_TIER_BASE + count;
//   player_daily (001)             — попытки комбо ('combo') и выигрыш за
//                                    сутки ('combo_win').

const crypto = require('crypto');
const { query } = require('../index');
const items = require('./items');
const money = require('./money');
const players = require('./players');
const progression = require('./progression');
const shop = require('./shop');
const {
  ITEM_DEF, FRIEND_EVENT_START_AT, FRIEND_EVENT_END_AT, FRIEND_EVENT_LEVEL, FRIEND_EVENT_TIER_BASE,
  FRIEND_EVENT_TIERS, friendEventOn, friendEventTier, friendEventPets, DAILY_COMBO, dailyComboPets,
} = require('../../../shared/definitions');

class FriendError extends Error {
  constructor(code, msg) { super(msg); this.code = code; this.userMessage = msg; }
}
const err = (code, msg) => { throw new FriendError(code, msg); };

const BUFF_POTIONS = ITEM_DEF.filter(d => d.slot === 'buff_potion').map(d => d.id);

// ── сколько друзей засчитано ────────────────────────────────────────────────
// Друг — аккаунт, у которого referred_by = telegram_id игрока, созданный во
// время события (раньше — не считается, у всех счётчик с нуля), не забаненный.
// done — дошли до FRIEND_EVENT_LEVEL, invited — все такие друзья.
async function friendCounts(db, playerId) {
  const { rows } = await query(db, `
    SELECT count(*) FILTER (WHERE COALESCE(pr.lvl, 0) >= $4)::int AS done,
           count(*)::int AS invited
      FROM players me
      JOIN players p ON p.referred_by = me.telegram_id AND p.id <> me.id
      LEFT JOIN player_progress pr ON pr.player_id = p.id
     WHERE me.id = $1
       AND NOT p.banned
       AND p.created_at >= $2::timestamptz
       AND p.created_at <  $3::timestamptz`,
  [playerId, new Date(FRIEND_EVENT_START_AT).toISOString(), new Date(FRIEND_EVENT_END_AT).toISOString(),
    FRIEND_EVENT_LEVEL]);
  return { done: rows[0] ? rows[0].done : 0, invited: rows[0] ? rows[0].invited : 0 };
}

async function claimedTiers(db, playerId) {
  const { rows } = await query(db, `
    SELECT tier FROM player_friendship_claims
     WHERE player_id = $1 AND tier > $2 AND tier < $3`,
  [playerId, FRIEND_EVENT_TIER_BASE, FRIEND_EVENT_TIER_BASE + 1000]);
  return rows.map(r => Number(r.tier) - FRIEND_EVENT_TIER_BASE);
}

async function friendStatus(db, playerId) {
  const c = await friendCounts(db, playerId);
  return {
    count: c.done, invited: c.invited,
    claimed: await claimedTiers(db, playerId),
    startAt: FRIEND_EVENT_START_AT, endAt: FRIEND_EVENT_END_AT,
    level: FRIEND_EVENT_LEVEL, now: Date.now(),
  };
}

// ── забрать тир ─────────────────────────────────────────────────────────────
// Флаг (строка в player_friendship_claims) пишется ДО выдачи — тем же
// порядком, что письмо и набор новичка: задвоенная награда хуже потерянной,
// а потерянной она не будет — транзакция откатит строку вместе с выдачей.
async function claimFriendTier(db, playerId, count, petId) {
  if (!friendEventOn()) err('event_over', 'Событие «Дружба» не идёт');
  const tier = friendEventTier(count);
  if (!tier) err('bad_tier', 'Награда не найдена');

  await items.lockPlayer(db, playerId);
  const c = await friendCounts(db, playerId);
  if (c.done < tier.count) {
    err('not_enough', `Нужно ${tier.count} друзей с ${FRIEND_EVENT_LEVEL} уровнем — сейчас ${c.done}`);
  }

  const list = [];
  for (const id of tier.items || []) list.push({ itemId: id, qty: 1, enhance: 0 });
  if (tier.pet) {
    const pool = friendEventPets(tier.pet);
    if (!pool.includes(petId)) err('bad_pet', 'Выберите питомца');
    list.push({ itemId: petId, qty: 1, enhance: 0 });
  }
  if (tier.classGear) {
    const prog = await players.progressOf(db, playerId);
    const cls = prog.charClass || 'lev';
    for (const slot of tier.classGear) {
      const def = ITEM_DEF.find(d => d.slot === slot && d.rarity === tier.classGearRarity
        && Array.isArray(d.forClass) && d.forClass.includes(cls));
      if (def) list.push({ itemId: def.id, qty: 1, enhance: 0 });
    }
  }

  if (list.length) {
    const room = await shop._roomForAll(db, playerId, list);
    if (!room.fits) {
      const { SERVER_INV_MAX } = require('../../anticheat');
      err('no_room', `Нужно ${room.need} свободных мест в инвентаре (занято ${room.used}/${SERVER_INV_MAX})`);
    }
  }

  const { rowCount } = await query(db, `
    INSERT INTO player_friendship_claims (player_id, tier) VALUES ($1, $2)
    ON CONFLICT DO NOTHING`, [playerId, FRIEND_EVENT_TIER_BASE + tier.count]);
  if (!rowCount) err('already', 'Эта награда уже получена');

  const granted = [];
  for (const it of list) {
    const rowId = await items.add(db, playerId, it.itemId,
      { qty: it.qty, enhance: 0, source: 'friendship', sourceRef: String(tier.count) });
    if (rowId === null) err('no_room', 'Инвентарь полон');
    granted.push({ ...it, rowId });
  }
  const idem = `friendship2:${playerId}:${tier.count}`;
  if (tier.nexum) {
    await money.credit(db, playerId, 'nexum', tier.nexum,
      { reason: 'friendship', refType: 'friendship', refId: String(tier.count), idemKey: `${idem}:nexum` });
  }
  if (tier.gram) {
    await money.credit(db, playerId, 'gram', tier.gram,
      { reason: 'friendship', refType: 'friendship', refId: String(tier.count), idemKey: `${idem}:gram` });
  }
  return {
    count: tier.count, granted, nexum: tier.nexum || 0, gram: tier.gram || 0,
    friends: c.done,
  };
}

// ── Комбо дня ───────────────────────────────────────────────────────────────
// Комбинация — HMAC от даты базы: одинаковая у всех в одни сутки, меняется в
// полночь вместе с попытками, и без секрета сервера её не вычислить.
function _comboSecret() {
  return process.env.COMBO_SECRET || process.env.ADMIN_TOKEN_SECRET || process.env.TG_BOT_TOKEN
    || 'liberty-daily-combo';
}

function comboFor(day) {
  const pool = dailyComboPets().slice();
  const h = crypto.createHmac('sha256', _comboSecret()).update(`combo:${day}`).digest();
  // Фишер–Йейтс на байтах хэша: первые DAILY_COMBO.len — комбинация.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = h.readUInt16BE((pool.length - 1 - i) * 2 % (h.length - 1)) % (i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, DAILY_COMBO.len);
}

async function _today(db) {
  const { rows } = await query(db, 'SELECT CURRENT_DATE::text AS d');
  return rows[0].d;
}

async function comboStatus(db, playerId) {
  const left = await progression.attemptsLeft(db, playerId, 'combo', DAILY_COMBO.attempts);
  const winLeft = await progression.attemptsLeft(db, playerId, 'combo_win', 1);
  return {
    day: await _today(db), left: Math.max(0, left), max: DAILY_COMBO.attempts, won: winLeft <= 0,
    pets: dailyComboPets(), len: DAILY_COMBO.len,
  };
}

// Попытка. Списывается атомарно (takeAttempt); при выигрыше в той же
// транзакции — отметка 'combo_win' и награда. Любой throw откатывает всё,
// включая попытку.
async function comboGuess(db, playerId, picks) {
  const pool = dailyComboPets();
  if (!Array.isArray(picks) || picks.length !== DAILY_COMBO.len
      || picks.some(p => typeof p !== 'string' || !pool.includes(p))
      || new Set(picks).size !== picks.length) {
    err('bad_pick', `Выберите ${DAILY_COMBO.len} разных питомцев`);
  }
  await items.lockPlayer(db, playerId);
  if (await progression.attemptsLeft(db, playerId, 'combo_win', 1) <= 0) {
    err('already', 'Комбо дня уже собрано — новое завтра');
  }
  const att = await progression.takeAttempt(db, playerId, 'combo', DAILY_COMBO.attempts);
  if (!att) err('no_attempts', 'Попытки на сегодня закончились — новое комбо завтра');

  const day = await _today(db);
  const combo = comboFor(day);
  const result = picks.map((p, i) => (combo[i] === p ? 'hit' : combo.includes(p) ? 'near' : 'miss'));
  const won = result.every(r => r === 'hit');
  if (!won) return { day, picks, result, won: false, left: att.left };

  const list = BUFF_POTIONS.map(id => ({ itemId: id, qty: DAILY_COMBO.buffPotions, enhance: 0 }));
  const room = await shop._roomForAll(db, playerId, list);
  if (!room.fits) {
    const { SERVER_INV_MAX } = require('../../anticheat');
    err('no_room', `Нужно ${room.need} свободных мест в инвентаре (занято ${room.used}/${SERVER_INV_MAX})`);
  }
  if (!await progression.takeAttempt(db, playerId, 'combo_win', 1)) err('already', 'Комбо дня уже собрано');
  for (const it of list) {
    const rowId = await items.add(db, playerId, it.itemId,
      { qty: it.qty, enhance: 0, source: 'daily_combo', sourceRef: day });
    if (rowId === null) err('no_room', 'Инвентарь полон');
  }
  if (DAILY_COMBO.nexum) {
    await money.credit(db, playerId, 'nexum', DAILY_COMBO.nexum,
      { reason: 'daily_combo', refType: 'daily_combo', refId: day, idemKey: `combo:${playerId}:${day}` });
  }
  return { day, picks, result, won: true, left: att.left, nexum: DAILY_COMBO.nexum, buffPotions: DAILY_COMBO.buffPotions };
}

module.exports = {
  friendCounts, friendStatus, claimFriendTier, comboFor, comboStatus, comboGuess, FriendError,
  FRIEND_EVENT_TIERS,
};
