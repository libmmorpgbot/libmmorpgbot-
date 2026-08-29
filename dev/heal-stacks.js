#!/usr/bin/env node
'use strict';
// ── Собрать расколотые купки ────────────────────────────────────────────────
//
//   node dev/heal-stacks.js            только посчитать
//   node dev/heal-stacks.js --apply    и собрать
//
// Стакающийся предмет обязан лежать в контейнере ОДНОЙ строкой. Два пути
// нарушали это правило — attachFromListing (выкупленный или снятый лот
// приезжал новой строкой рядом с уже лежащей) и moveTo (перенос в контейнер,
// где такая купка уже есть). Оба исправлены в server/db/repos/items.js, но
// строки, которые они успели наделать, лежат в базе и чинятся только здесь.
//
// Игроки видели это так:
//
//   «кидає 11 штук айтема, а в хранилищі 126 відображається; забирає назад —
//    в інвентарі 11»                        переехала одна строка из двух
//   «296 штук виставляю — виставляється 46» клиент держал id первой строки
//   «предмети наче розділилися на дві частини»
//
// Количество ни у кого не меняется — меняется только то, в скольких строках
// оно лежит. Поэтому проверка ниже сверяет ИТОГ до и после и отказывается
// записывать, если он разошёлся хоть на штуку.
const { pool, close, tx } = require('../server/db');
const items = require('../server/db/repos/items');

const APPLY = process.argv.includes('--apply');

const GROUPS = `
  SELECT pi.player_id, pi.container, pi.item_id, pi.enhance,
         count(*)::int AS rows, sum(pi.qty)::bigint AS total
    FROM player_items pi
    JOIN item_catalog c ON c.item_id = pi.item_id AND c.stackable
   WHERE pi.player_id IS NOT NULL AND pi.container IN ('inventory', 'storage')
   GROUP BY pi.player_id, pi.container, pi.item_id, pi.enhance
  HAVING count(*) > 1
   ORDER BY count(*) DESC, pi.player_id`;

(async () => {
  const { rows: groups } = await pool().query(GROUPS);
  if (!groups.length) {
    console.log('\n  расколотых купок нет\n');
    await close();
    return;
  }

  const players = new Set(groups.map(g => Number(g.player_id)));
  const extra = groups.reduce((n, g) => n + (g.rows - 1), 0);
  console.log(`\n  расколотых купок: ${groups.length} у ${players.size} игроков ` +
    `(лишних строк ${extra})`);
  for (const g of groups.slice(0, 12)) {
    console.log(`    игрок ${g.player_id}  ${String(g.container).padEnd(9)} ` +
      `${String(g.item_id).padEnd(16)} строк ${g.rows}, всего ${g.total}`);
  }
  if (groups.length > 12) console.log(`    … и ещё ${groups.length - 12}`);

  if (!APPLY) {
    console.log('\n  это разведка. Собрать:  node dev/heal-stacks.js --apply\n');
    await close();
    return;
  }

  let done = 0, failed = 0;
  for (const g of groups) {
    const pid = Number(g.player_id);
    try {
      await tx(async (t) => {
        // Тот же порядок блокировок, что и везде: строка игрока первой.
        await items.lockPlayer(t, pid);
        const before = await pool().query(
          `SELECT COALESCE(sum(qty), 0)::bigint AS n FROM player_items
            WHERE player_id = $1 AND container = $2 AND item_id = $3 AND enhance = $4`,
          [pid, g.container, g.item_id, g.enhance]);
        await items.mergeStacks(t, pid, g.container, g.item_id, g.enhance);
        const after = await t.query(
          `SELECT COALESCE(sum(qty), 0)::bigint AS n, count(*)::int AS rows FROM player_items
            WHERE player_id = $1 AND container = $2 AND item_id = $3 AND enhance = $4`,
          [pid, g.container, g.item_id, g.enhance]);
        // Итог обязан совпасть. Слияние не создаёт и не уничтожает предметы —
        // и если вдруг создало, транзакция откатывается, а не «почти всё
        // хорошо».
        if (String(before.rows[0].n) !== String(after.rows[0].n)) {
          throw new Error(`итог разошёлся: было ${before.rows[0].n}, стало ${after.rows[0].n}`);
        }
        done++;
      });
    } catch (err) {
      failed++;
      console.error(`  игрок ${pid} ${g.container}/${g.item_id}: ${err.message}`);
    }
  }

  const { rows: left } = await pool().query(GROUPS);
  console.log(`\n  собрано ${done}, не вышло ${failed}, осталось расколотых ${left.length}`);
  console.log(`  ${left.length === 0 && failed === 0 ? '1 пройшло, 0 впало' : '0 пройшло, 1 впало'}\n`);
  await close();
})().catch(e => { console.error('  ОШИБКА: ' + e.message); process.exit(1); });
