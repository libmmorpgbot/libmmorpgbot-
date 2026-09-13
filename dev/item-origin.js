#!/usr/bin/env node
'use strict';
// ═══════════════════════════════════════════════════════════════════════════
//  item-origin.js — откуда у игрока взялся конкретный предмет
// ═══════════════════════════════════════════════════════════════════════════
//
//   set -a; . /srv/liberty/env; set +a
//   node dev/item-origin.js 494170668 "Посох новичка"
//   node dev/item-origin.js 494170668 st1
//   node dev/item-origin.js 494170668            # все движения предметов
//
// Отвечает на вопрос «откуда это у него» по item_ledger (миграция 012) —
// append-only журналу, который переживает удаление самой вещи: проданный,
// сожжённый в заточке и выброшенный предмет всё равно оставляет строку.
// Поэтому «ничего не найдено» здесь значит именно «сервер этого не выдавал»,
// а не «строка потерялась вместе с вещью».
//
// Главное, ради чего это написано: у убийства в ref_id лежит ключ вида
//   kill:<player_id>:<id монстра>:<время>
// а id монстра несёт префикс зоны (`farm_`/`farmsz_` — Фарм-зона и её
// сезонное крыло, `farmhi_` — Фарм зона 2, `farm2_` — Элитная, `e_<рукав>_`
// — коридоры, и так далее). То есть по журналу видно НЕ ТОЛЬКО что предмет
// выпал с моба, но и в какой зоне этот моб стоял — именно это и разбирает
// столбец «откуда» ниже.
//
// Права: хватает обычной роли приложения (liberty_app) — только SELECT.

const { query, close } = require('../server/db');
const { ITEM_DEF, CRAFT_MATS, BOX_DEF, itemCatalogBase } = require('../shared/definitions');

const [, , tgArg, itemArg] = process.argv;
if (!tgArg) {
  console.error('Использование: node dev/item-origin.js <telegram_id> [название или id предмета]');
  process.exit(1);
}

// ── что за предмет ──────────────────────────────────────────────────────────
// По id (st1) или по названию, как игрок его видит («Посох новичка»).
// Сравнение без регистра и без лишних пробелов: название приходит из чата.
function resolveItem(arg) {
  if (!arg) return null;
  const direct = itemCatalogBase(arg);
  if (direct) return direct;
  const norm = String(arg).trim().toLowerCase();
  const all = [].concat(ITEM_DEF, CRAFT_MATS, BOX_DEF);
  return all.find(d => String(d.name || '').trim().toLowerCase() === norm)
      || all.find(d => String(d.name || '').trim().toLowerCase().includes(norm))
      || null;
}

// ── префикс id монстра → человеческое имя зоны ──────────────────────────────
// Ровно те id, что раздаёт server/game/dungeon.js и рантайм-спавны Room.js.
// Порядок важен: `farm2_` и `farmsz_` должны проверяться до `farm_`.
const ZONES = [
  ['farmsz_',     'Фарм-зона (сезонное крыло)'],
  ['farmhi_',     'Фарм зона 2'],
  ['farm2_',      'Элитная фарм-зона'],
  ['farm_',       'Фарм-зона (первая)'],
  ['race10boss_', 'Кровавая Башня (босс)'],
  ['race10_',     'Кровавая Башня'],
  ['coop_boss_',  'Сотрудничество (босс)'],
  ['coop_',       'Сотрудничество'],
  ['fear_',       'Страх'],
  ['trial_',      'Испытание'],
  ['evtboss_',    'Мировой босс'],
  ['e_',          'Коридоры'],
];
function zoneOfEnemy(uid) {
  const hit = ZONES.find(([p]) => uid.startsWith(p));
  return hit ? hit[1] : 'неизвестно';
}

// Расшифровка ref_id. Для убийства это ключ идемпотентности выплаты
// (см. server/handlers2/world.js), для остального — то, что записал свой путь.
function explainRef(reason, refId) {
  if (!refId) return '—';
  const m = /^kill:(\d+):(.+):(\d+)$/.exec(refId);
  if (m) {
    const uid = m[2];
    return `${zoneOfEnemy(uid)} · моб ${uid}`;
  }
  return refId;
}

// Как назывался источник в момент выдачи (столбец reason = provenance-метка
// из items.add: 'kill', 'craft', 'box', 'market', 'quest', 'admin', ...).
const REASONS = {
  kill: 'выпал с монстра', craft: 'скрафчен', box: 'из ящика', market: 'рынок',
  quest: 'награда за квест', admin: 'выдан админом', mail: 'из почты',
  shop: 'куплен в лавке', start: 'стартовый набор', unknown: 'источник не записан',
};

(async () => {
  const p = (await query(null,
    'SELECT id, username, telegram_id FROM players WHERE telegram_id = $1', [tgArg])).rows[0];
  if (!p) { console.log(`Игрок с telegram_id ${tgArg} не найден.`); return; }
  console.log(`\nИгрок: ${p.username || '(без имени)'} · tg ${p.telegram_id} · player_id ${p.id}`);

  const def = resolveItem(itemArg);
  if (itemArg && !def) { console.log(`\nПредмет «${itemArg}» в каталоге не найден.`); return; }
  if (def) console.log(`Предмет: ${def.name} (${def.id}${def.rarity ? ', ' + def.rarity : ''})`);

  const rows = (await query(null, `
    SELECT id, row_id, item_id, delta, qty_after, reason, ref_type, ref_id, created_at
      FROM item_ledger
     WHERE player_id = $1 ${def ? 'AND item_id = $2' : ''}
     ORDER BY id`, def ? [p.id, def.id] : [p.id])).rows;

  if (!rows.length) {
    console.log('\nВ журнале предметов движений нет.');
    if (def) console.log('Значит сервер этот предмет этому игроку не выдавал — ни разу.');
  } else {
    console.log(`\nДвижений в журнале: ${rows.length}\n`);
    for (const r of rows) {
      const when = new Date(r.created_at).toISOString().replace('T', ' ').slice(0, 19);
      const sign = r.delta > 0 ? '+' : '';
      const base = itemCatalogBase(r.item_id);
      const name = base ? base.name : r.item_id;
      console.log(`  ${when}  ${sign}${r.delta}  стало ${r.qty_after}  ${name} (${r.item_id})`);
      console.log(`      ${REASONS[r.reason] || r.reason}  ·  ${explainRef(r.reason, r.ref_id)}`);
    }
  }

  // Что от этого лежит в инвентаре прямо сейчас — со своей меткой источника
  // (player_items.source/source_ref, миграция 011). Журнал говорит, что было;
  // это — что осталось.
  const held = (await query(null, `
    SELECT id, container, slot, item_id, qty, enhance, source, source_ref, created_at
      FROM player_items
     WHERE player_id = $1 ${def ? 'AND item_id = $2' : ''}
     ORDER BY created_at`, def ? [p.id, def.id] : [p.id])).rows;
  const plural = (n, a, b, c) => { const d = n % 100, e = n % 10;
    return d > 10 && d < 20 ? c : e === 1 ? a : e > 1 && e < 5 ? b : c; };
  console.log(`\nСейчас на руках: ${held.length} ${plural(held.length, 'строка', 'строки', 'строк')}`);
  for (const h of held) {
    const base = itemCatalogBase(h.item_id);
    const when = new Date(h.created_at).toISOString().replace('T', ' ').slice(0, 19);
    console.log(`  ${when}  ${base ? base.name : h.item_id} x${h.qty}${h.enhance ? ' +' + h.enhance : ''}` +
      `  [${h.container}${h.slot ? '/' + h.slot : ''}]  ${REASONS[h.source] || h.source || '—'}` +
      `  ·  ${explainRef(h.source, h.source_ref)}`);
  }
  console.log('');
})().catch(e => { console.error(e); process.exit(1); }).finally(() => close());
