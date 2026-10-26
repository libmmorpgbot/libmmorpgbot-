'use strict';
// ── Помощники: крафт, кормление, кто летает рядом ───────────────────────────
// Что за помощники и что они дают — shared/definitions.js (HELPERS,
// helperBonusAt). Здесь — только то, что двигает строки player_helpers и
// осколки в сумке, и всегда в транзакции вызывающего: осколки списываются
// вместе с результатом или не списываются вовсе.
//
// Порядок как у ковки (repos/craft.js): сперва игрок (items.lockPlayer —
// первый запрос транзакции), потом проверки, потом плата, потом выдача.
//
// Таблицы до миграции 041 нет — код выкладывается раньше неё. Тогда окно
// честно говорит «скоро», а характеристики считаются без помощника
// (repos/stats.js спрашивает ту же колонку).

const crypto = require('crypto');
const { query, hasColumn } = require('../index');
const items = require('./items');
const {
  HELPERS, HELPER_CRAFT_COST, HELPER_MAX_LEVEL, HELPER_FEED_XP, HELPER_DUP_XP,
  UNIQUE_SHARDS, helperById, helperAddXp, helperFeedPlan,
} = require('../../../shared/definitions');

class HelperError extends Error {
  constructor(code, msg) { super(msg); this.code = code; this.userMessage = msg; }
}
const err = (code, msg) => { throw new HelperError(code, msg); };

const SHARD_IDS = UNIQUE_SHARDS.map(s => s.id);

async function ready() { return hasColumn('player_helpers', 'helper_id'); }

// Сколько каждого вида осколков лежит в сумке — одним запросом на все
// двадцать, а не двадцатью.
async function shardCounts(db, playerId) {
  const { rows } = await query(db, `
    SELECT item_id, COALESCE(sum(qty), 0)::int AS n
      FROM player_items
     WHERE player_id = $1 AND container = 'inventory' AND item_id = ANY($2::text[])
     GROUP BY item_id`, [playerId, SHARD_IDS]);
  const out = {};
  for (const id of SHARD_IDS) out[id] = 0;
  for (const r of rows) out[r.item_id] = Number(r.n) || 0;
  return out;
}

async function stateOf(db, playerId) {
  if (!await ready()) return { ready: false, list: [], active: null };
  const { rows } = await query(db, `
    SELECT helper_id, level, xp, active FROM player_helpers
     WHERE player_id = $1 ORDER BY created_at, helper_id`, [playerId]);
  // Id, которого больше нет в каталоге, не показывается и ничего не даёт —
  // ровно как снятый с продажи предмет в compute().
  const list = rows.filter(r => helperById(r.helper_id))
    .map(r => ({ id: r.helper_id, level: Number(r.level), xp: Number(r.xp) }));
  const act = rows.find(r => r.active && helperById(r.helper_id));
  return { ready: true, list, active: act ? act.helper_id : null };
}

// Крафт: каждый вид осколков по цене редкости — и случайный помощник этой
// редкости. Уже открытый выпал снова — его опыт растёт на HELPER_DUP_XP.
async function craft(db, playerId, rarity) {
  if (!await ready()) err('off', 'Помощники ещё не включены на сервере');
  if (typeof rarity !== 'string' || !Object.hasOwn(HELPER_CRAFT_COST, rarity)) err('bad_rarity', 'Неизвестная редкость');
  await items.lockPlayer(db, playerId);
  const cost = HELPER_CRAFT_COST[rarity];

  const have = await shardCounts(db, playerId);
  const short = UNIQUE_SHARDS.find(s => have[s.id] < cost);
  if (short) err('no_shards', `Нужно по ${cost.toLocaleString('ru-RU')} осколков каждого вида — не хватает: ${short.name} (${have[short.id]})`);

  const ref = `helper_craft:${rarity}`;
  for (const id of SHARD_IDS) {
    if (!await items.removeQty(db, playerId, id, cost, { reason: 'helper_craft', refType: 'helper', refId: rarity })) {
      // Недостижимо после проверки в той же транзакции — бросок, а не
      // return, потому что сюда попадают, только если они разошлись.
      err('no_shards', `Не хватает осколков: ${id}`);
    }
  }

  const pool = HELPERS.filter(h => h.rarity === rarity);
  const pick = pool[crypto.randomInt(pool.length)];

  const { rows: had } = await query(db,
    'SELECT level, xp FROM player_helpers WHERE player_id = $1 AND helper_id = $2 FOR UPDATE',
    [playerId, pick.id]);
  if (had.length) {
    const was = { level: Number(had[0].level), xp: Number(had[0].xp) };
    const now = helperAddXp(was.level, was.xp, HELPER_DUP_XP);
    await query(db, `
      UPDATE player_helpers SET level = $3, xp = $4, updated_at = now()
       WHERE player_id = $1 AND helper_id = $2`, [playerId, pick.id, now.level, now.xp]);
    if (now.level !== was.level) await _refreshIfActive(db, playerId, pick.id);
    return { outcome: 'duplicate', id: pick.id, rarity, from: was.level, to: now.level, ref };
  }
  // Первый помощник сразу летает рядом — иначе новичок открыл бы окно,
  // увидел его в списке и не понял, почему у плеча пусто.
  const { rows: anyActive } = await query(db,
    'SELECT 1 FROM player_helpers WHERE player_id = $1 AND active LIMIT 1', [playerId]);
  const active = !anyActive.length;
  await query(db, `
    INSERT INTO player_helpers (player_id, helper_id, level, xp, active)
    VALUES ($1, $2, 1, 0, $3)`, [playerId, pick.id, active]);
  if (active) await require('./stats').refreshBm(db, playerId);
  return { outcome: 'new', id: pick.id, rarity, from: 1, to: 1, ref };
}

// Порции осколков с самых больших стопок: по одному осколку за шаг, всякий
// раз с той, где их сейчас больше всего. Так последний редкий вид не
// уходит в корм, пока есть лишние обычные. Двадцать видов и не больше
// нескольких десятков тысяч штук — счёт в памяти, списание одним
// removeQty на вид.
function _planTake(have, total) {
  const left = { ...have };
  const take = {};
  // Сразу выровнять до общего уровня, а не по штуке: при 100 000 штук
  // пошаговый цикл был бы ощутимо долгим, а итог тот же.
  let need = total;
  while (need > 0) {
    const ids = SHARD_IDS.filter(id => left[id] > 0).sort((a, b) => left[b] - left[a]);
    if (!ids.length) return null;
    const top = left[ids[0]];
    const tied = ids.filter(id => left[id] === top);
    const next = ids.find(id => left[id] < top);
    const gap = next ? top - left[next] : top;
    // Сколько можно снять с каждого из «верхних», не опустив их ниже
    // следующей стопки.
    const per = Math.max(1, Math.min(gap, Math.floor(need / tied.length) || 1));
    for (const id of tied) {
      if (need <= 0) break;
      const n = Math.min(per, need, left[id]);
      left[id] -= n; take[id] = (take[id] || 0) + n; need -= n;
    }
  }
  return take;
}

async function feed(db, playerId, helperId, times = 1) {
  if (!await ready()) err('off', 'Помощники ещё не включены на сервере');
  const def = helperById(helperId);
  if (!def) err('bad_helper', 'Такого помощника нет');
  await items.lockPlayer(db, playerId);

  const { rows } = await query(db,
    'SELECT level, xp FROM player_helpers WHERE player_id = $1 AND helper_id = $2 FOR UPDATE',
    [playerId, def.id]);
  if (!rows.length) err('not_owned', 'Этого помощника у вас нет');
  const was = { level: Number(rows[0].level), xp: Number(rows[0].xp) };
  if (was.level >= HELPER_MAX_LEVEL) err('maxed', 'Помощник уже максимального уровня');

  const plan = helperFeedPlan(was.level, was.xp, times);
  if (!plan.feeds) err('maxed', 'Помощник уже максимального уровня');

  const have = await shardCounts(db, playerId);
  const total = Object.values(have).reduce((s, n) => s + n, 0);
  if (total < plan.cost) {
    err('no_shards', `Нужно ${plan.cost.toLocaleString('ru-RU')} осколков (есть ${total.toLocaleString('ru-RU')})`);
  }
  const take = _planTake(have, plan.cost);
  if (!take) err('no_shards', 'Не хватает осколков');
  for (const [id, n] of Object.entries(take)) {
    if (n > 0 && !await items.removeQty(db, playerId, id, n, { reason: 'helper_feed', refType: 'helper', refId: def.id })) {
      err('no_shards', `Не хватает осколков: ${id}`);
    }
  }

  await query(db, `
    UPDATE player_helpers SET level = $3, xp = $4, updated_at = now()
     WHERE player_id = $1 AND helper_id = $2`, [playerId, def.id, plan.level, plan.xp]);
  if (plan.level !== was.level) await _refreshIfActive(db, playerId, def.id);
  return {
    id: def.id, feeds: plan.feeds, cost: plan.cost, xpGained: plan.feeds * HELPER_FEED_XP,
    from: was.level, to: plan.level, xp: plan.xp,
  };
}

// helperId = null — убрать помощника (никто не летает).
async function setActive(db, playerId, helperId) {
  if (!await ready()) err('off', 'Помощники ещё не включены на сервере');
  await items.lockPlayer(db, playerId);
  if (helperId != null) {
    const def = helperById(helperId);
    if (!def) err('bad_helper', 'Такого помощника нет');
    const { rows } = await query(db,
      'SELECT 1 FROM player_helpers WHERE player_id = $1 AND helper_id = $2', [playerId, def.id]);
    if (!rows.length) err('not_owned', 'Этого помощника у вас нет');
  }
  // Сперва снять всех, потом поставить одного: частичный уникальный индекс
  // проверяется на каждой строке, и обратный порядок упёрся бы в него.
  await query(db, `
    UPDATE player_helpers SET active = false, updated_at = now()
     WHERE player_id = $1 AND active`, [playerId]);
  if (helperId != null) {
    await query(db, `
      UPDATE player_helpers SET active = true, updated_at = now()
       WHERE player_id = $1 AND helper_id = $2`, [playerId, helperId]);
  }
  await require('./stats').refreshBm(db, playerId);
  return { active: helperId || null };
}

async function _refreshIfActive(db, playerId, helperId) {
  const { rows } = await query(db,
    'SELECT active FROM player_helpers WHERE player_id = $1 AND helper_id = $2', [playerId, helperId]);
  if (rows.length && rows[0].active) await require('./stats').refreshBm(db, playerId);
}

module.exports = { ready, stateOf, shardCounts, craft, feed, setActive, HelperError, _planTake };
