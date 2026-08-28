#!/usr/bin/env node
'use strict';
// ── что в unmatched_deposits ссылается на тестовые аккаунты ─────────────────
//
//   node dev/unmatched-who.js
//
// purge-test.sh отказался чистить, потому что на players ссылается
// unmatched_deposits.resolved_player_id, а обработчика для неё в скрипте нет.
// Отказ правильный: эта таблица — запись о РЕАЛЬНЫХ деньгах, пришедших на
// адрес, и слепо занулить колонку нельзя.
//
// Причина в комментарии к самой колонке (миграция 014): «NULL WITH resolved_at
// SET означает, что оператор посмотрел и осознанно отказал». То есть занулить
// resolved_player_id у уже разобранной строки — это переписать «зачислено
// игроку X» в «оператор отказал», молча и необратимо.
//
// Поэтому сначала смотрим, что там за строки, и только потом решаем.
const { pool, close } = require('../server/db');

const TEST_USERNAME = '^([a-z]{2,6}-[0-9]{3,6}[_-])|^(probe_|tester$|999$)';
const NEVER = ['1199957588', '8868342638'];

async function main() {
  const { rows: all } = await pool().query(
    `SELECT count(*)::int n,
            count(*) FILTER (WHERE resolved_at IS NULL)::int open,
            count(*) FILTER (WHERE resolved_player_id IS NOT NULL)::int credited
       FROM unmatched_deposits`);
  console.log(`\nвсего строк: ${all[0].n} · открытых: ${all[0].open} · зачисленных кому-то: ${all[0].credited}`);

  const { rows } = await pool().query(
    `SELECT u.tx_id, u.amount, u.currency, u.reason, u.sender, u.comment,
            u.resolved_at, u.resolved_by, u.created_at,
            p.id AS pid, p.username, p.telegram_id,
            (p.username ~ $1 OR p.telegram_id !~ '^[0-9]+$') AS is_test,
            (p.telegram_id = ANY($2))                        AS is_live
       FROM unmatched_deposits u
       JOIN players p ON p.id = u.resolved_player_id
      ORDER BY u.created_at`, [TEST_USERNAME, NEVER]);

  if (!rows.length) {
    console.log('\n  ни одна строка не ссылается на игрока — колонка везде NULL');
    console.log('  (значит внешний ключ ничего не держит, и хватит внести её в список скрипта)\n');
    return;
  }

  console.log(`\nссылаются на игрока: ${rows.length}`);
  const test = rows.filter(r => r.is_test);
  const real = rows.filter(r => !r.is_test);
  console.log(`  на тестовые аккаунты: ${test.length}`);
  console.log(`  на боевые:            ${real.length}`);

  const show = (r) => `    ${r.tx_id.slice(0, 26).padEnd(26)} ${String(r.amount).padStart(12)} ${r.currency}`
    + `  ${r.reason.padEnd(16)} → ${r.username} (${r.pid})`
    + `  ${r.resolved_at ? new Date(r.resolved_at).toISOString().slice(0, 16) : 'не разобрано'}`;

  if (test.length) {
    console.log('\n  на тестовые:');
    for (const r of test.slice(0, 15)) console.log(show(r));
    if (test.length > 15) console.log(`    … и ещё ${test.length - 15}`);
    // Синтетический ли tx_id — по нему видно, фикстура это или настоящий
    // перевод, который кто-то по ошибке зачислил на тестовый аккаунт.
    const synthetic = test.filter(r => !/^[0-9]+:/.test(r.tx_id));
    console.log(`\n    из них с синтетическим tx_id (не «lt:index» с цепочки): ${synthetic.length}`);
    console.log(`    с настоящим видом tx_id: ${test.length - synthetic.length}`);
  }
  if (real.length) {
    console.log('\n  ✗ НА БОЕВЫЕ АККАУНТЫ — эти строки трогать нельзя:');
    for (const r of real) console.log(show(r));
  }
  console.log('');
}

// ── и заодно: что ещё способно остановить purge-test.sh ────────────────────
// Тот же запрос, что и страж внутри скрипта. Смысл в том, чтобы упереться в
// новую таблицу ЗДЕСЬ, а не на середине очистки боевой базы с введённым
// паролём администратора.
const HANDLED = [
  'ledger.player_id', 'gram_tx.player_id',
  'market_listings.seller_id', 'market_listings.buyer_id',
  'clan_allocations.allocated_by',
  'unmatched_deposits.resolved_player_id',
];

async function blockers() {
  const { rows } = await pool().query(`
    SELECT cl.relname::text AS tbl, a.attname AS col
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
     WHERE c.contype = 'f' AND c.confrelid = 'players'::regclass
       AND c.confdeltype IN ('a', 'r')
     ORDER BY 1, 2`);
  const found = rows.map(r => `${r.tbl}.${r.col}`);
  const unknown = found.filter(f => !HANDLED.includes(f));
  console.log('внешние ключи на players, которые блокируют удаление:');
  for (const f of found) {
    console.log(`  ${HANDLED.includes(f) ? '✓' : '✗'} ${f}`);
  }
  if (unknown.length) {
    console.log('');
    console.log(`  ✗ purge-test.sh остановится на: ${unknown.join(', ')}`);
    console.log('    добавь для них обработчик и внеси в список стража');
    console.log('');
    process.exitCode = 3;
  } else {
    console.log('');
    console.log('  ✓ все обработаны — скрипт дойдёт до конца');
    console.log('');
  }
}

main().then(blockers).catch(e => { console.error(e); process.exitCode = 1; }).finally(close);
