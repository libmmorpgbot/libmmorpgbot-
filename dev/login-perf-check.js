#!/usr/bin/env node
'use strict';
// ── Вход не читает журнал денег целиком ─────────────────────────────────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/login-perf-check.js
//
// Игроки перестали заходить в игру: «canceling statement due to statement
// timeout». Ничего не ломалось — один запрос перестал укладываться в пять
// секунд, и он был на пути ВХОДА, то есть отказ получали все сразу.
//
//   SELECT count(*) FROM ledger WHERE player_id = $1 AND reason='class_change'
//
// Считается ради мелочи: доступна ли игроку первая смена класса за Liberty.
// Платится полным чтением таблицы — существующий ledger_player_idx не
// помогает, потому что у активного игрока движений денег половина журнала, и
// планировщик справедливо выбирает последовательный скан.
//
// Такую поломку не видно ни линтеру, ни глазам: запрос корректен, тест на
// «вернул ли он верное число» зелёный. Она видна только планировщику и только
// на объёме. Поэтому здесь EXPLAIN на настоящих данных, а не чтение кода.
//
// ── и почему проверка смотрит ТРИ вещи, а не одну ───────────────────────────
//
//   индекс есть и валиден   CONCURRENTLY при обрыве оставляет INVALID-индекс:
//                           он существует, но планировщик его не берёт;
//   условие совпадает       индекс частичный, по reason='class_change'. Кто-то
//                           переименует причину в session.js — индекс останется
//                           на месте и станет бесполезен, молча;
//   план на объёме          собственно доказательство: с полусотней тысяч
//                           строк у одного игрока полного чтения нет.
const fs = require('fs');
const path = require('path');
const { tx, query, close } = require('../server/db');
const players = require('../server/db/repos/players');

let pass = 0, fail = 0;
const ok = (c, name, got) => {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + name); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m  ' + name + (got !== undefined ? ' — ' + got : '')); }
};

const TAG = 'lperf-' + String(process.pid).slice(-5);
const made = [];
const ROWS = 50000;

(async () => {
  console.log(`\nlogin-perf-check  (${TAG})\n`);

  // ── 1. причина, которую ищет вход ─────────────────────────────────────────
  // Берётся из ЖИВОГО кода, а не повторяется здесь: проверка, которая знает
  // своё собственное 'class_change', подтвердит саму себя и промолчит, когда
  // строку поменяют.
  const sess = fs.readFileSync(path.join(__dirname, '..', 'server/session.js'), 'utf8');
  const m = sess.match(/FROM ledger\s+WHERE player_id = \$1 AND reason = '([a-z_]+)'/);
  ok(!!m, 'запрос про смену класса найден в session.js',
    'его там нет — проверка не о чём: либо он переписан, либо переехал');
  const reason = m ? m[1] : null;

  // ── 2. индекс под него ────────────────────────────────────────────────────
  const { rows: idx } = await query(null, `
    SELECT i.indisvalid, pg_get_expr(i.indpred, i.indrelid) AS pred
      FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
     WHERE c.relname = 'ledger_class_change_idx'`);
  ok(idx.length === 1, 'индекс ledger_class_change_idx существует',
    'миграция 020 не накатана — вход снова читает журнал целиком');
  if (idx.length === 1) {
    ok(idx[0].indisvalid === true, 'и он валиден, а не брошен на середине',
      'INVALID: построение CONCURRENTLY оборвалось. DROP INDEX CONCURRENTLY и заново');
    ok(!!reason && String(idx[0].pred || '').includes(`'${reason}'`),
      `и покрывает ту же причину, что ищет вход (${reason})`,
      `условие индекса: ${idx[0].pred}`);
  }

  // ── 3. план на объёме ─────────────────────────────────────────────────────
  // На пустой таблице планировщик выберет скан и будет прав — на десяти
  // строках он дешевле. Поэтому строки нужны: без них проверка зелёная всегда
  // и не значит ничего.
  console.log(`  ── ${ROWS} строк одному игроку ──`);
  const { id } = await tx(t => players.ensure(t, `${TAG}-a`, `${TAG}_игрок`));
  made.push(id);
  await query(null, `
    INSERT INTO ledger (player_id, currency, delta, balance_after, reason)
    SELECT $1, 'gold', 1, g, 'mob_drop' FROM generate_series(1, $2) g`, [id, ROWS]);
  await query(null, `
    INSERT INTO ledger (player_id, currency, delta, balance_after, reason)
    VALUES ($1, 'gold', -2000, 1, $2)`, [id, reason || 'class_change']);
  await query(null, 'ANALYZE ledger');

  const { rows: plan } = await query(null, `
    EXPLAIN (COSTS OFF, FORMAT TEXT)
    SELECT count(*)::int n FROM ledger WHERE player_id = $1 AND reason = $2`,
    [id, reason || 'class_change']);
  const text = plan.map(r => r['QUERY PLAN']).join('\n');
  ok(!/Seq Scan on ledger/i.test(text),
    'вход не читает журнал целиком',
    'план всё ещё сканирует ledger: ' + text.replace(/\s+/g, ' ').slice(0, 160));
  ok(/ledger_class_change_idx/.test(text),
    'и берёт именно частичный индекс',
    text.replace(/\s+/g, ' ').slice(0, 160));

  console.log('');
  console.log(fail === 0
    ? `  \x1b[32m${pass} пройшло, 0 впало\x1b[0m\n`
    : `  \x1b[31m${pass} пройшло, ${fail} впало\x1b[0m\n`);
  // Строки журнала не удаляются: ledger append-only, а DELETE по нему отозван
  // (миграция 013). Тестовый игрок остаётся со своими строками — как и у
  // остальных детекторов, это цена честного журнала.
  await close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error(e);
  try { await close(); } catch { /* уже закрыт */ }
  process.exit(1);
});
