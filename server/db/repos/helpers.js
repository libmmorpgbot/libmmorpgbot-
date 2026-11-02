'use strict';
// ── Помощники: крафт и кормление ────────────────────────────────────────────
// Что за помощники и что они дают — shared/definitions.js (HELPERS,
// helperBonusAt). С миграции 049 помощник — предмет player_items со слотом
// 'helper': надевается обычным equipItem, продаётся обычным рынком, а
// уровень и опыт — колонки самой строки (hl_level, hl_xp). Здесь — только
// то, что их рождает (крафт в кузнице) и растит (кормление осколками), и
// всегда в транзакции вызывающего: осколки списываются вместе с результатом
// или не списываются вовсе.
//
// Порядок как у ковки (repos/craft.js): сперва игрок (items.lockPlayer —
// первый запрос транзакции), потом проверки, потом плата, потом выдача.
//
// До миграции 049 колонок нет — код выкладывается раньше неё. Тогда крафт и
// кормление честно отказывают, а характеристики считаются без помощника.

const crypto = require('crypto');
const { query } = require('../index');
const items = require('./items');
const {
  HELPERS, HELPER_CRAFT_COST, HELPER_MAX_LEVEL, HELPER_FEED_XP,
  UNIQUE_SHARDS, helperById, helperFeedPlan,
} = require('../../../shared/definitions');

class HelperError extends Error {
  constructor(code, msg) { super(msg); this.code = code; this.userMessage = msg; }
}
const err = (code, msg) => { throw new HelperError(code, msg); };

const SHARD_IDS = UNIQUE_SHARDS.map(s => s.id);

async function ready() { return items._hasHelperCols(); }

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

// Крафт: каждый вид осколков по цене редкости — и случайный помощник этой
// редкости, новым предметом в сумку 1-го уровня. Повтор — тоже новый
// предмет: лишнего можно продать.
async function craft(db, playerId, rarity) {
  if (!await ready()) err('off', 'Помощники ещё не включены на сервере');
  if (typeof rarity !== 'string' || !Object.hasOwn(HELPER_CRAFT_COST, rarity)) err('bad_rarity', 'Неизвестная редкость');
  await items.lockPlayer(db, playerId);
  const cost = HELPER_CRAFT_COST[rarity];

  const have = await shardCounts(db, playerId);
  const short = UNIQUE_SHARDS.find(s => have[s.id] < cost);
  if (short) err('no_shards', `Нужно по ${cost.toLocaleString('ru-RU')} осколков каждого вида — не хватает: ${short.name} (${have[short.id]})`);

  const pool = HELPERS.filter(h => h.rarity === rarity);
  const pick = pool[crypto.randomInt(pool.length)];
  // Место проверяется ДО списания: полная сумка не должна съесть двадцать
  // тысяч осколков и не выдать ничего.
  if (!await items.hasRoomFor(db, playerId, pick.id)) err('inv_full', 'Инвентарь полон — освободите место');

  for (const id of SHARD_IDS) {
    if (!await items.removeQty(db, playerId, id, cost, { reason: 'helper_craft', refType: 'helper', refId: rarity })) {
      // Недостижимо после проверки в той же транзакции — бросок, а не
      // return, потому что сюда попадают, только если они разошлись.
      err('no_shards', `Не хватает осколков: ${id}`);
    }
  }

  const rowId = await items.add(db, playerId, pick.id,
    { source: 'helper_craft', sourceRef: rarity, helper: { level: 1, xp: 0 } });
  if (!rowId) err('inv_full', 'Инвентарь полон — освободите место');
  return { outcome: 'new', id: pick.id, rowId, rarity, from: 1, to: 1, ref: `helper_craft:${rarity}` };
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

// Кормление ОДНОЙ строки — той, на которую нажали (в сумке или надетой).
async function feed(db, playerId, rowId, times = 1) {
  if (!await ready()) err('off', 'Помощники ещё не включены на сервере');
  const rid = Math.floor(Number(rowId));
  if (!Number.isSafeInteger(rid) || rid <= 0) err('bad_helper', 'Не выбран помощник');
  await items.lockPlayer(db, playerId);

  const { rows } = await query(db, `
    SELECT id, item_id, container, hl_level, hl_xp FROM player_items
     WHERE id = $1 AND player_id = $2 AND container IN ('inventory', 'equipment')
       AND hl_level IS NOT NULL
     FOR UPDATE`, [rid, playerId]);
  if (!rows.length) err('not_owned', 'Этого помощника у вас нет');
  const def = helperById(rows[0].item_id);
  if (!def) err('bad_helper', 'Такого помощника нет');
  const was = { level: Number(rows[0].hl_level), xp: Number(rows[0].hl_xp) || 0 };
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

  await query(db, 'UPDATE player_items SET hl_level = $2, hl_xp = $3 WHERE id = $1',
    [rid, plan.level, plan.xp]);
  const equipped = rows[0].container === 'equipment';
  // Надетый вырос — меняется и боевая мощь в рейтинге.
  if (equipped && plan.level !== was.level) await require('./stats').refreshBm(db, playerId);
  return {
    id: def.id, rowId: rid, feeds: plan.feeds, cost: plan.cost, xpGained: plan.feeds * HELPER_FEED_XP,
    from: was.level, to: plan.level, xp: plan.xp, equipped,
  };
}

module.exports = { ready, shardCounts, craft, feed, HelperError, _planTake };
