#!/usr/bin/env node
'use strict';
// ── хранилище: положить / забрать ЧАСТЬ купки ────────────────────────────────
//
//   DATABASE_URL=... node dev/storage-qty-check.js
//
// Окно количества на складе (js/npc.js, _openStorageQty) шлёт qty, а сервер
// делит купку в items.moveQty (server/db/repos/items.js). Проверяется то, что
// может сломаться только на настоящей базе: сколько где оказалось, что купки
// сливаются, а не множатся строками, что новая часть ложится в конец списка,
// что полный инвентарь отказывает без частичного результата, и что журнал
// предметов (reconcile) сходится — перекладывание не должно выглядеть ни как
// дюп, ни как пропажа.

const { pool, tx, close } = require('../server/db');
const items = require('../server/db/repos/items');
const { SERVER_INV_MAX } = require('../server/anticheat');
const { wipeItemsAll } = require('./fixtures');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, n) => ok(a === b, n, `ожидал ${JSON.stringify(b)}, получил ${JSON.stringify(a)}`);

const TAG = 'sqchk-' + process.pid;
const made = [];
async function mkPlayer(nick) {
  const { rows } = await pool().query(
    'INSERT INTO players (telegram_id, username) VALUES ($1,$2) RETURNING id',
    [`${TAG}-${nick}`, `${TAG}_${nick}`]);
  made.push(Number(rows[0].id));
  return Number(rows[0].id);
}
const rowsOf = async (pid, container, itemId) => (await pool().query(
  `SELECT id, qty, sort_seq FROM player_items WHERE player_id = $1 AND container = $2 AND item_id = $3 ORDER BY sort_seq`,
  [pid, container, itemId])).rows.map(r => ({ id: Number(r.id), qty: r.qty, seq: Number(r.sort_seq) }));
const total = rs => rs.reduce((s, r) => s + r.qty, 0);
const drift = async (pid) => ((await tx(t => items.reconcile(t))) || []).filter(d => d.playerId === pid);

async function main() {
  console.log(`\nstorage-qty-check  (${TAG})\n`);
  await tx(t => items.syncCatalog(t));
  const { rows: st } = await pool().query(
    `SELECT item_id FROM item_catalog WHERE stackable AND active ORDER BY item_id LIMIT 1`);
  const { rows: ns } = await pool().query(
    `SELECT item_id FROM item_catalog WHERE NOT stackable AND active ORDER BY item_id LIMIT 1`);
  const MAT = st[0].item_id, GEAR = ns[0].item_id;

  const pid = await mkPlayer('a');
  const matRow = await tx(t => items.add(t, pid, MAT, { qty: 50, source: 'test' }));
  await tx(t => items.add(t, pid, GEAR, { source: 'test' }));
  // Что-то уже лежит в хранилище — чтобы было видно, куда встаёт новая часть.
  const gear2 = await tx(t => items.add(t, pid, GEAR, { source: 'test' }));
  await tx(t => items.moveTo(t, gear2, pid, 'storage'));

  // ── положить часть ────────────────────────────────────────────────────────
  eq(await tx(t => items.moveQty(t, matRow, pid, 'storage', 20)), true, 'положить 20 из 50 — получилось');
  let inv = await rowsOf(pid, 'inventory', MAT), sto = await rowsOf(pid, 'storage', MAT);
  eq(total(inv), 30, 'в инвентаре осталось 30');
  eq(total(sto), 20, 'в хранилище легло 20');
  eq(inv.length, 1, 'в инвентаре одна купка, а не две');
  eq(inv[0].id, matRow, 'и это та же строка — купка не «переехала» в конец инвентаря');
  const gearSeq = (await pool().query('SELECT sort_seq FROM player_items WHERE id = $1', [gear2])).rows[0].sort_seq;
  ok(sto[0].seq > Number(gearSeq), 'новая часть легла в конец хранилища, после того, что там уже было');
  eq((await drift(pid)).length, 0, 'журнал предметов сходится — ни дюпа, ни пропажи');

  // ── доложить к той же купке ────────────────────────────────────────────────
  await tx(t => items.moveQty(t, matRow, pid, 'storage', 5));
  sto = await rowsOf(pid, 'storage', MAT);
  eq(sto.length, 1, 'доложили 5 — долилось в ту же купку хранилища, новой строки нет');
  eq(total(sto), 25, 'в хранилище теперь 25');
  eq(total(await rowsOf(pid, 'inventory', MAT)), 25, 'в инвентаре 25');

  // ── забрать часть, забрать всё ────────────────────────────────────────────
  await tx(t => items.moveQty(t, sto[0].id, pid, 'inventory', 10));
  inv = await rowsOf(pid, 'inventory', MAT); sto = await rowsOf(pid, 'storage', MAT);
  eq(inv.length, 1, 'забрали 10 — долились в купку инвентаря');
  eq(total(inv), 35, 'в инвентаре 35');
  eq(total(sto), 15, 'в хранилище 15');
  await tx(t => items.moveQty(t, sto[0].id, pid, 'inventory', 999));
  inv = await rowsOf(pid, 'inventory', MAT); sto = await rowsOf(pid, 'storage', MAT);
  eq(sto.length, 0, 'забрать больше, чем есть, = забрать всё: хранилище пусто');
  eq(total(inv), 50, 'и все 50 снова в инвентаре одной купкой');
  eq(inv.length, 1, 'одной строкой');
  eq((await drift(pid)).length, 0, 'журнал по-прежнему сходится');

  // ── нештабелируемое ────────────────────────────────────────────────────────
  eq(await tx(t => items.moveQty(t, gear2, pid, 'inventory', 1)), true, 'снаряжение с qty переносится целиком');
  eq((await rowsOf(pid, 'storage', GEAR)).length, 0, 'и из хранилища оно ушло');

  // ── полный инвентарь ───────────────────────────────────────────────────────
  const pid2 = await mkPlayer('b');
  const r2 = await tx(t => items.add(t, pid2, MAT, { qty: 10, source: 'test' }));
  await tx(t => items.moveTo(t, r2, pid2, 'storage'));
  // Забиваем инвентарь снаряжением до предела.
  await pool().query(`
    INSERT INTO player_items (player_id, container, item_id, enhance, qty)
    SELECT $1, 'inventory', $2, 0, 1 FROM generate_series(1, $3)`, [pid2, GEAR, SERVER_INV_MAX]);
  eq(await tx(t => items.moveQty(t, r2, pid2, 'inventory', 4)), false, 'полный инвентарь: забрать часть — отказ');
  eq(total(await rowsOf(pid2, 'storage', MAT)), 10, 'и в хранилище ничего не убыло');
  eq(total(await rowsOf(pid2, 'inventory', MAT)), 0, 'и в инвентарь ничего не попало');
  // Но если в инвентаре уже есть купка — места не нужно.
  await pool().query(
    `DELETE FROM player_items WHERE id = (SELECT id FROM player_items WHERE player_id = $1 AND item_id = $2 AND container = 'inventory' LIMIT 1)`,
    [pid2, GEAR]);
  await tx(t => items.add(t, pid2, MAT, { qty: 1, source: 'test' }));   // заняло последний слот
  eq(await tx(t => items.moveQty(t, r2, pid2, 'inventory', 4)), true, 'полный инвентарь, но купка есть — долилось');
  eq(total(await rowsOf(pid2, 'inventory', MAT)), 5, 'в инвентаре 1 + 4 = 5');
  eq(total(await rowsOf(pid2, 'storage', MAT)), 6, 'в хранилище 6');

  // ── мусорное количество ────────────────────────────────────────────────────
  eq(await tx(t => items.moveQty(t, r2, pid2, 'inventory', 0)), false, 'qty 0 — отказ, а не «всё»');
  eq(total(await rowsOf(pid2, 'storage', MAT)), 6, 'и ничего не сдвинулось');
}

async function cleanup() {
  if (!made.length) return;
  await wipeItemsAll(made).catch(() => {});
  await pool().query('DELETE FROM item_ledger WHERE player_id = ANY($1)', [made]).catch(() => {});
  await pool().query('DELETE FROM player_items WHERE player_id = ANY($1)', [made]).catch(() => {});
  await pool().query('DELETE FROM players WHERE id = ANY($1)', [made]).catch(() => {});
}

main()
  .catch(err => { fail++; failures.push('НЕОБРАБОТАННАЯ ОШИБКА'); console.error('\n', err); })
  .finally(async () => {
    await cleanup(); await close();
    console.log(`\n  ${pass} прошло, ${fail} упало`);
    if (failures.length) console.log('  упали: ' + failures.join(' · '));
    process.exit(fail ? 1 : 0);
  });
