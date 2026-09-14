'use strict';
// ── Руны: ковка, перебор цвета, гнёзда ──────────────────────────────────────
//
// Руна — первая вещь в игре с СОБСТВЕННЫМ содержимым: что именно она даёт,
// решает бросок при ковке и живёт в строке предмета (player_items.rune,
// миграция 029). Отсюда три правила, которых нет у остального снаряжения.
//
// 1. БРОСКИ — ТОЛЬКО ЗДЕСЬ, И ТОЛЬКО ИЗ crypto. Руна стоит Liberty, то есть
//    настоящих денег, а Math.random в V8 предсказуем по нескольким подряд
//    выданным числам. Тот же довод, что и у ковки снаряжения (repos/craft.js),
//    и тот же источник.
//
// 2. ЧТО ИМЕННО МОЖЕТ ВЫПАСТЬ — НЕ ЗДЕСЬ. Таблицы (какие характеристики у
//    какого вида руны, сколько процентов даёт цвет, сколько строк у редкости)
//    лежат в shared/definitions.js, потому что ровно те же числа рисует
//    карточка на клиенте. Разъехаться показанному и посчитанному негде: это
//    один файл.
//
// 3. ГНЕЗДО — ЭТО ССЫЛКА РУНЫ НА ПРЕДМЕТ. Вставленная руна остаётся обычной
//    строкой player_items со своим владельцем и своей историей; меняются два
//    поля (socket_of/socket_idx). Поэтому «вынуть» — это UPDATE, а не
//    уничтожение и создание заново, и руна не теряет ни провенанс, ни место в
//    журнале предметов.
const crypto = require('crypto');
const { query } = require('../index');
const items = require('./items');
const money = require('./money');
const {
  ITEM_DEF, RUNE_CRAFT_RECIPES, RUNE_REROLL_PRICE,
  rollRuneStats, rollRuneQuality, runeKindOf, runeRarityOf, runeCatalogId,
  runeSocketsOf, runeKindForSlot,
} = require('../../../shared/definitions');

class RuneError extends Error {
  constructor(code, msg) { super(msg); this.code = code; this.userMessage = msg; }
}
const err = (code, msg) => { throw new RuneError(code, msg); };

// Тот же источник случайности и та же обёртка, что у ковки снаряжения
// (repos/craft.js) — см. пункт 1 в шапке.
const RAND_MAX = 2 ** 30;
function rand() { return crypto.randomInt(RAND_MAX) / RAND_MAX; }

// ── база ещё без миграции 029 ───────────────────────────────────────────────
// Код выкладывается раньше миграции — это порядок, а не случайность. В окне
// между выкладкой и `migrate-now.sh` колонок rune/socket_of нет, и всё, что
// делают эти четыре функции, писать НЕКУДА. Отказ здесь честнее запроса,
// который упадёт ошибкой Postgres: игрок видит «руны ещё не включены», а не
// «внутренняя ошибка», и не теряет вложенное.
async function _runesReady(db) {
  const { rows } = await query(db, `
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'player_items' AND column_name = 'socket_of' LIMIT 1`);
  return rows.length > 0;
}
function _needRunes(ready) {
  if (!ready) err('runes_off', 'Руны ещё не включены на сервере');
}

// ── ковка ───────────────────────────────────────────────────────────────────
// Порядок: сперва отказы, которые ничего не стоят, потом плата, потом бросок.
// Отказ, за который уже заплачено, — худший вид отказа; ровно этот порядок
// соблюдает и craftPet рядом.
//
// При неудаче (70% по RUNE_CRAFT_CHANCE) вложенное сгорает и руны не
// появляется — это и есть цена попытки.
async function craftRune(db, playerId, kind, rarity) {
  _needRunes(await _runesReady(db));
  await items.lockPlayer(db, playerId);
  const rec = RUNE_CRAFT_RECIPES.find(r => r.kind === kind && r.rarity === rarity);
  if (!rec) err('bad_recipe', 'Неизвестный рецепт руны');

  const itemId = runeCatalogId(kind, rarity);
  if (!ITEM_DEF.some(d => d.id === itemId)) err('bad_recipe', 'Такой руны нет в каталоге');
  if (!await items.hasRoomFor(db, playerId, itemId)) err('no_room', 'Инвентарь полон');

  // Материалы. Список приходит из рецепта и сегодня пуст — владелец пришлёт
  // его отдельно; цикл написан так, что заполнить таблицу можно будет НЕ
  // трогая этот файл.
  for (const m of (rec.mats || [])) {
    const have = await items.countMatching(db, playerId, { itemIds: [m.id] });
    if (have < m.n) err('no_mats', 'Не хватает материалов');
  }

  if (rec.nexumCost > 0) {
    const paid = await money.spend(db, playerId, 'nexum', rec.nexumCost, {
      reason: 'craft_rune', refType: 'rune', refId: `${kind}:${rarity}`,
      idemKey: `craft_rune:${playerId}:${kind}:${rarity}:${crypto.randomUUID()}`,
    });
    if (!paid) err('no_nexum', 'Недостаточно Liberty');
  }
  for (const m of (rec.mats || [])) {
    const took = await items.consumeMatching(db, playerId, m.n, {
      itemIds: [m.id], reason: 'craft_rune', refType: 'rune', refId: `${kind}:${rarity}`,
    });
    // Возвращает { ok, had } — не булево. Проверка на сам объект была бы
    // всегда истинной, и «не хватило» прошло бы как «взяли».
    if (!took.ok) err('no_mats', 'Не хватает материалов');
  }

  const chance = rec.chance == null ? 1 : Number(rec.chance);
  if (chance < 1 && rand() >= chance) {
    return { outcome: 'fail', kind, rarity, chance, cost: rec.nexumCost };
  }

  const stats = rollRuneStats(kind, rarity, rand);
  // Пустой набор значит, что бросок не состоялся — на боевой базе такого быть
  // не может (таблицы непустые), но выдать пустую оболочку за руну было бы
  // хуже, чем отказать: отказ виден, пустая руна — нет.
  if (!stats.length) err('bad_recipe', 'Руна вышла пустой — ковка отменена');

  const rowId = await items.add(db, playerId, itemId, {
    source: 'craft', sourceRef: 'rune:' + itemId, rune: { stats },
  });
  if (rowId === null) err('no_room', 'Инвентарь полон');

  // Читаем обратно из базы, а не отдаём то, что послали: если колонки rune
  // на этой базе ещё нет (миграция не применена), вещь выдастся пустой
  // оболочкой, и лучше узнать об этом здесь, чем от игрока.
  const { rows } = await query(db, 'SELECT rune FROM player_items WHERE id = $1', [rowId]);
  if (!rows.length || !rows[0].rune) {
    err('no_rune_column', 'Руны недоступны — база ещё не обновлена');
  }
  return { outcome: 'success', kind, rarity, chance, cost: rec.nexumCost, itemId, rowId, stats };
}

// ── перебор цвета одной характеристики ──────────────────────────────────────
// Именно перебор, а не повышение: цвет бросается заново и может выйти хуже.
// Поэтому и цена одна на любой цвет — платят за бросок.
//
// Номер строки проверяется по НАСТОЯЩЕЙ длине набора, а не по редкости: две
// характеристики у необычной руны — это правило ковки, а не свойство строки,
// и руна, доставшаяся из более старой версии, может не совпасть с таблицей.
async function rerollRuneStat(db, playerId, rowId, statIdx) {
  _needRunes(await _runesReady(db));
  await items.lockPlayer(db, playerId);
  const id = Math.floor(Number(rowId));
  if (!Number.isSafeInteger(id) || id <= 0) err('bad_rune', 'Руна не найдена');
  const idx = Math.floor(Number(statIdx));

  const { rows } = await query(db,
    'SELECT item_id, rune FROM player_items WHERE id = $1 AND player_id = $2', [id, playerId]);
  if (!rows.length) err('bad_rune', 'Руна не найдена');
  const rarity = runeRarityOf(rows[0].item_id);
  if (!rarity) err('bad_rune', 'Это не руна');
  const stats = (rows[0].rune && rows[0].rune.stats) || [];
  if (!Number.isSafeInteger(idx) || idx < 0 || idx >= stats.length) {
    err('bad_stat', 'У руны нет такой характеристики');
  }

  const paid = await money.spend(db, playerId, 'nexum', RUNE_REROLL_PRICE, {
    reason: 'rune_reroll', refType: 'rune', refId: String(id),
    idemKey: `rune_reroll:${playerId}:${id}:${idx}:${crypto.randomUUID()}`,
  });
  if (!paid) err('no_nexum', 'Недостаточно Liberty');

  const before = stats[idx].q;
  const next = stats.map((st, i) => (i === idx ? { ...st, q: rollRuneQuality(rarity, rand) } : st));
  await query(db, 'UPDATE player_items SET rune = $3 WHERE id = $1 AND player_id = $2',
    [id, playerId, JSON.stringify({ stats: next })]);
  return { rowId: id, statIdx: idx, before, after: next[idx].q, cost: RUNE_REROLL_PRICE, stats: next };
}

// ── гнёзда ──────────────────────────────────────────────────────────────────
// Руна доспеха не лезет в оружие и наоборот. Это не украшение правил: наборы
// характеристик у них разные (у оружейных есть шанс крита и шанс Liberty, у
// доспешных — здоровье и бег), и позволить перепутать значит отдать оружию
// прибавку, придуманную для брони.
async function socketRune(db, playerId, hostRowId, runeRowId, socketIdx) {
  _needRunes(await _runesReady(db));
  await items.lockPlayer(db, playerId);
  const host = Math.floor(Number(hostRowId));
  const rune = Math.floor(Number(runeRowId));
  const idx = Math.floor(Number(socketIdx));
  if (!Number.isSafeInteger(host) || !Number.isSafeInteger(rune)) err('bad_ref', 'Предмет не найден');

  const { rows: h } = await query(db,
    `SELECT pi.id, pi.item_id, pi.container, c.slot
       FROM player_items pi JOIN item_catalog c ON c.item_id = pi.item_id
      WHERE pi.id = $1 AND pi.player_id = $2 AND pi.socket_of IS NULL`, [host, playerId]);
  if (!h.length) err('bad_ref', 'Предмет не найден');
  const sockets = runeSocketsOf(h[0].slot);
  if (!sockets) err('no_sockets', 'В этот предмет руны не вставляются');
  if (!Number.isSafeInteger(idx) || idx < 0 || idx >= sockets) err('bad_socket', 'Нет такого гнезда');

  const { rows: r } = await query(db,
    'SELECT id, item_id, rune, socket_of FROM player_items WHERE id = $1 AND player_id = $2',
    [rune, playerId]);
  if (!r.length) err('bad_rune', 'Руна не найдена');
  if (r[0].socket_of != null) err('rune_busy', 'Эта руна уже стоит в предмете');
  const kind = runeKindOf(r[0].item_id);
  if (!kind) err('bad_rune', 'Это не руна');
  if (kind !== runeKindForSlot(h[0].slot)) {
    err('wrong_kind', kind === 'weapon' ? 'Руна оружия — только в оружие' : 'Руна доспеха — только в броню');
  }

  // Гнездо занято? Спрашивается явно, хотя есть и уникальный индекс: игроку
  // нужно «гнездо занято», а не «ошибка базы».
  const { rows: busy } = await query(db,
    'SELECT 1 FROM player_items WHERE socket_of = $1 AND socket_idx = $2', [host, idx]);
  if (busy.length) err('socket_busy', 'Гнездо занято');

  await query(db,
    `UPDATE player_items SET socket_of = $3, socket_idx = $4, container = 'inventory', slot = NULL
      WHERE id = $1 AND player_id = $2`, [rune, playerId, host, idx]);
  return { hostRowId: host, runeRowId: rune, socketIdx: idx };
}

// Вынуть. Руна возвращается в сумку — значит нужно место, и проверяется оно
// ДО того, как гнездо освободится: иначе руна оказалась бы нигде.
async function unsocketRune(db, playerId, runeRowId) {
  _needRunes(await _runesReady(db));
  await items.lockPlayer(db, playerId);
  const rune = Math.floor(Number(runeRowId));
  if (!Number.isSafeInteger(rune) || rune <= 0) err('bad_rune', 'Руна не найдена');

  const { rows } = await query(db,
    'SELECT id, item_id, socket_of FROM player_items WHERE id = $1 AND player_id = $2 AND socket_of IS NOT NULL',
    [rune, playerId]);
  if (!rows.length) err('bad_rune', 'Эта руна не стоит в предмете');
  if (!await items.hasRoomFor(db, playerId, rows[0].item_id)) err('no_room', 'Инвентарь полон');

  await query(db,
    `UPDATE player_items SET socket_of = NULL, socket_idx = NULL, container = 'inventory'
      WHERE id = $1 AND player_id = $2`, [rune, playerId]);
  return { runeRowId: rune, hostRowId: Number(rows[0].socket_of) };
}

// «Стоят ли в предмете руны» живёт НЕ здесь, а в repos/items.js
// (assertNoRunes): спрашивают об этом продажа, разбор и рынок, то есть пути,
// которые об руны ничего не знают и знать не должны. Две функции с одним
// ответом разошлись бы на первом же изменении правила.

module.exports = { craftRune, rerollRuneStat, socketRune, unsocketRune };
