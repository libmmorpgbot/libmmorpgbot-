#!/usr/bin/env node
'use strict';
// ── Диагностика «руна не даёт характеристик» ─────────────────────────────────
//
//   set -a; . /srv/liberty/env; set +a
//   node dev/rune-diag.js <telegramId>
//
// Владелец сообщил: «не растёт ни атака, ни защита, ни БМ от надевания руны»
// — уже после того, как фикс кеша схемы (server/db/index.js hasColumn)
// выложен и сервис перезапущен (подтверждено через /health: build содержит
// фикс). Значит дело либо в конкретном аккаунте — руна, выкованная в другом
// состоянии базы, либо в чём-то, что нельзя увидеть чтением кода, а можно
// только чтением базы.
//
// Печатает пять фактов подряд, каждый — отдельная гипотеза:
//
//   1. применена ли миграция 029 ПРЯМО СЕЙЧАС (а не «была применена когда-то»)
//   2. что вообще надето, и что в гнёздах каждого надетого предмета
//   3. содержимое КАЖДОЙ руны в гнезде — пустое (rune=null/stats=[]) или нет
//   4. что даёт этот набор рун по общей формуле (runeBonusTotals) —
//      ДОЛЖНО совпасть с тем, что видит игрок
//   5. atk/def/hp из stats.of() — и то же самое БЕЗ рун, посчитанное вручную
//      той же функцией, чтобы разница была видна как число, а не как «вроде
//      не растёт»
//
// Read-only. Прав приложения (liberty_app) достаточно для всего, что здесь
// читается.
const { query, hasColumn } = require('../server/db');
const items = require('../server/db/repos/items');
const stats = require('../server/db/repos/stats');
const { runeBonusTotals, RUNE_STAT_NAME } = require('../shared/definitions');

async function main() {
  const telegramId = process.argv[2];
  if (!telegramId) {
    console.error('Использование: node dev/rune-diag.js <telegramId>');
    process.exit(1);
  }

  const { rows: prow } = await query(null,
    `SELECT id, username, bm FROM players WHERE telegram_id = $1`, [telegramId]);
  if (!prow.length) { console.error('Игрок с таким telegramId не найден'); process.exit(1); }
  const pid = prow[0].id;
  console.log(`\nИгрок: ${prow[0].username} (id ${pid}), players.bm сейчас = ${prow[0].bm}\n`);

  console.log('── 1. миграция 029 на этой базе прямо сейчас ──');
  const hasRune = await hasColumn('player_items', 'rune');
  const hasSocket = await hasColumn('player_items', 'socket_of');
  console.log(`  rune: ${hasRune ? 'ЕСТЬ' : 'НЕТ'}   socket_of: ${hasSocket ? 'ЕСТЬ' : 'НЕТ'}`);
  if (!hasRune || !hasSocket) {
    console.log('  ПРИЧИНА НАЙДЕНА: колонок нет — миграция 029 не применена на ЭТОЙ базе.');
    console.log('  (проверьте, что DATABASE_URL из env указывает на боевую базу, а не на тестовую)');
    process.exit(0);
  }

  console.log('\n── 2. что надето и что в гнёздах ──');
  const inv = await items.inventoryOf(null, pid);
  const equipped = Object.entries(inv.equipment || {}).filter(([, v]) => v);
  if (!equipped.length) { console.log('  ничего не надето'); }
  for (const [slot, it] of equipped) {
    console.log(`  ${slot}: ${it.id} (rowId ${it.rowId}) — гнёзд занято: ${(it.runes || []).length}`);
  }

  console.log('\n── 3. содержимое каждой руны в гнезде ──');
  let anyRune = false;
  const allRunes = [];
  for (const [slot, it] of equipped) {
    for (const r of (it.runes || [])) {
      anyRune = true;
      allRunes.push(r);
      // items.inventoryOf() отдаёт гнездо через _row() — {id, rune:{stats}},
      // НЕ {itemId, stats}. Это и была вторая половина находки: сама эта
      // строка когда-то читала r.itemId/r.stats и показывала руну пустой,
      // хотя та была полной — той же ошибкой, что стояла в recompute()
      // (js/player.js) и не давала характеристикам доехать до экрана игрока.
      const statsArr = r.stats || (r.rune && r.rune.stats) || [];
      const empty = !statsArr.length;
      console.log(`  ${slot} гнездо ${r.idx}: ${r.itemId || r.id}` +
        (empty ? '  ⚠ ПУСТАЯ — stats:[] или rune:null, характеристик нет вообще'
               : '  ' + statsArr.map(s => `${RUNE_STAT_NAME[s.stat] || s.stat}(${s.q})`).join(', ')));
    }
  }
  if (!anyRune) console.log('  рун в гнёздах нет вообще — не вставлена ни одна');

  console.log('\n── 4. что это даёт по общей формуле (runeBonusTotals) ──');
  const tot = runeBonusTotals(allRunes);
  if (!Object.keys(tot).length) {
    console.log('  0 по всем характеристикам — либо руны пустые (см. пункт 3),');
    console.log('  либо ни одна не вставлена, либо у вставленных не распознаётся редкость/вид.');
  } else {
    for (const [k, v] of Object.entries(tot)) console.log(`  ${RUNE_STAT_NAME[k] || k}: +${v}%`);
  }

  console.log('\n── 5. stats.of() — сейчас, и без рун для сравнения ──');
  const withRunes = await stats.of(null, pid);
  console.log(`  СЕЙЧАС:   atk ${withRunes.atk}  def ${withRunes.def}  hp ${withRunes.maxHp}`);

  // Пересчитать вручную БЕЗ рун — тем же stats.compute(), но обнулив runes
  // на каждом надетом предмете. Не трогает базу, только показывает разницу.
  const row = await stats.load(null, pid);
  const rowNoRunes = { ...row, equipped: (row.equipped || []).map(it => ({ ...it, runes: [] })) };
  const withoutRunes = stats.compute(rowNoRunes);
  console.log(`  БЕЗ РУН:  atk ${withoutRunes.atk}  def ${withoutRunes.def}  hp ${withoutRunes.maxHp}`);
  const diff = withRunes.atk !== withoutRunes.atk || withRunes.def !== withoutRunes.def || withRunes.maxHp !== withoutRunes.maxHp;
  console.log(diff
    ? '\n  ✓ разница ЕСТЬ — руны считаются. Если в игре всё равно "не растёт",'
    + '\n    смотрите на КЛИЕНТСКИЙ экран: возможно, дело в отображении, а не в бою.'
    : '\n  ✗ разницы НЕТ — вот она, причина. Смотрите пункты 3-4 выше: что именно пусто.');

  process.exit(0);
}

main().catch(e => { console.error('ФАТАЛЬНО:', e.message, '\n', e.stack); process.exit(1); });
