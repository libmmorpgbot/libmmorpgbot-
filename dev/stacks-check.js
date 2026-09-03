#!/usr/bin/env node
'use strict';
// ── Одна купка — одна строка, и зелье лечит от живого HP ────────────────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/stacks-check.js
//
// Две жалобы одного дня, обе про расхождение между тем, что показано, и тем,
// что произошло.
//
// 1. «кидає 11 штук айтема, а в хранилищі 126 відображається; забирає назад —
//    в інвентарі 11», «предмети наче розділилися на дві частини»
//
//    Стакающийся предмет обязан лежать в контейнере ОДНОЙ строкой. add() это
//    соблюдал, а два других пути создания строк — нет: attachFromListing клал
//    выкупленный лот рядом с уже лежащей купкой, moveTo переносил строку в
//    контейнер, где такая купка уже есть. Клиент показывает СУММУ строк, а
//    действие работает со СТРОКОЙ — отсюда и «положил 11, показывает 126».
//
//    В живой базе таких купок нашлось 108 у 20 игроков.
//
// 2. «Банки здоровья неправильно работают: то сразу фулл хп делают, то нет.
//    Маленькая должна 20, большая 500»
//
//    Числа верные и всегда были верными (pt1=20, pt2=500, как в прежней
//    сборке). Неверным было то, ОТ ЧЕГО они прибавлялись: usePotion читал
//    player_progress.hp, а эту колонку пишет savePosition раз в двадцать
//    секунд. Бой идёт в комнате, значит в колонке лежит HP, которое было
//    когда-то. Прибавь двадцать к устаревшим 2900 при живых 100 — получишь
//    «фулл»; к устаревшим 100 при живых 2900 — «не работает».
const { pool, close, tx } = require('../server/db');
const items = require('../server/db/repos/items');
const consumables = require('../server/db/repos/consumables');
const { ITEM_DEF } = require('../shared/definitions');

let pass = 0, fail = 0;
const ok = (c, name, got) => {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + name); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m  ' + name + (got !== undefined ? ' — ' + got : '')); }
};
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);

const TG = String(982000000 + (process.pid % 100000));
let pid = null;

async function rowsOf(db, container, itemId) {
  const { rows } = await (db || pool()).query(
    `SELECT id, qty FROM player_items
      WHERE player_id = $1 AND container = $2 AND item_id = $3 ORDER BY id`,
    [pid, container, itemId]);
  return rows.map(r => ({ id: Number(r.id), qty: Number(r.qty) }));
}
const sum = rs => rs.reduce((n, r) => n + r.qty, 0);

(async () => {
  const players = require('../server/db/repos/players');
  const res = await players.ensure(null, TG, 'stackchk');
  pid = Number(res.id || res.playerId || res);
  await pool().query('DELETE FROM player_items WHERE player_id = $1', [pid]);

  // Стакающийся предмет из каталога — берём тот, что реально есть.
  const STACK = 'rece';
  const { rows: cat } = await pool().query(
    'SELECT stackable FROM item_catalog WHERE item_id = $1', [STACK]);
  ok(cat.length && cat[0].stackable === true, `${STACK} действительно стакается`);

  // ── 1. moveTo собирает купку на новом месте ──────────────────────────────
  console.log('\n  ── склад: положил и забрал ──');
  await tx(async (t) => {
    await items.lockPlayer(t, pid);
    // Две отдельные строки: ровно то состояние, в котором сегодня находятся
    // 20 живых аккаунтов. Через add() их не получить — он сливает, — поэтому
    // строится напрямую, как их наделали attachFromListing и moveTo.
    await t.query(`INSERT INTO player_items (player_id, container, item_id, enhance, qty)
                   VALUES ($1,'storage',$2,0,115), ($1,'storage',$2,0,11)`, [pid, STACK]);
  });
  let st = await rowsOf(null, 'storage', STACK);
  eq(st.length, 2, 'подготовлено две строки в хранилище');
  eq(sum(st), 126, 'и всего в них 126 — именно это число видел игрок');

  // Забираем ОДНУ строку, как делает панель.
  await tx(async (t) => {
    await items.lockPlayer(t, pid);
    await items.moveTo(t, st[1].id, pid, 'inventory');
  });
  const inv = await rowsOf(null, 'inventory', STACK);
  const st2 = await rowsOf(null, 'storage', STACK);
  eq(inv.length, 1, 'в инвентаре одна строка');
  eq(inv[0].qty, 11, 'и в ней 11 — столько и переехало');
  // А вот это и есть починка: остаток в хранилище собран в ОДНУ строку, и
  // следующее «забрать» унесёт всё сразу, а не «сначала одну часть, потом
  // другую».
  eq(st2.length, 1, 'остаток в хранилище собран в одну строку');
  eq(st2[0].qty, 115, 'и это весь остаток');

  // Кладём обратно — обязано слиться с тем, что там уже лежит.
  await tx(async (t) => {
    await items.lockPlayer(t, pid);
    await items.moveTo(t, inv[0].id, pid, 'storage');
  });
  const st3 = await rowsOf(null, 'storage', STACK);
  eq(st3.length, 1, 'вернули — в хранилище снова ОДНА строка, а не две');
  eq(st3[0].qty, 126, 'и в ней всё');
  eq((await rowsOf(null, 'inventory', STACK)).length, 0, 'в инвентаре не осталось ничего');

  // ── 2. слияние ничего не создаёт и не теряет ─────────────────────────────
  console.log('\n  ── слияние не двигает количество ──');
  await pool().query('DELETE FROM player_items WHERE player_id = $1', [pid]);
  await tx(async (t) => {
    await items.lockPlayer(t, pid);
    await t.query(`INSERT INTO player_items (player_id, container, item_id, enhance, qty)
                   VALUES ($1,'inventory',$2,0,5), ($1,'inventory',$2,0,7),
                          ($1,'inventory',$2,0,9), ($1,'inventory',$2,0,50)`, [pid, STACK]);
  });
  const beforeN = sum(await rowsOf(null, 'inventory', STACK));
  await tx(async (t) => {
    await items.lockPlayer(t, pid);
    await items.mergeStacks(t, pid, 'inventory', STACK, 0);
  });
  const afterRows = await rowsOf(null, 'inventory', STACK);
  eq(afterRows.length, 1, 'четыре строки стали одной');
  eq(sum(afterRows), beforeN, 'итог не изменился ни на штуку');

  // Не стакающийся предмет не трогается: две одинаковые шапки — это две шапки.
  // Берётся из КАТАЛОГА БАЗЫ, а не угадывается по slot: первый заход искал
  // slot === 'head', не нашёл ничего — и весь блок молча не выполнился. Такая
  // проверка неотличима от отсутствующей.
  const { rows: ns } = await pool().query(
    "SELECT item_id FROM item_catalog WHERE NOT stackable AND active ORDER BY item_id LIMIT 1");
  ok(ns.length === 1, 'в каталоге есть нестакающийся предмет — иначе проверять нечего');
  const NOSTACK = ns.length ? ns[0].item_id : null;
  if (NOSTACK) {
    await tx(async (t) => {
      await items.lockPlayer(t, pid);
      await t.query(`INSERT INTO player_items (player_id, container, item_id, enhance, qty)
                     VALUES ($1,'inventory',$2,0,1), ($1,'inventory',$2,0,1)`, [pid, NOSTACK]);
      await items.mergeStacks(t, pid, 'inventory', NOSTACK, 0);
    });
    eq((await rowsOf(null, 'inventory', NOSTACK)).length, 2,
      `${NOSTACK} не стакается — две вещи остались двумя`);
  }

  // ── 2б. снятие лота, когда такая купка уже лежит ─────────────────────────
  // Первая версия слияния роняла ровно это. market.cancel возвращает предмет
  // через attachFromListing, а лот помечает отменённым СТРОКОЙ НИЖЕ — значит
  // в момент слияния лот ещё active и ссылается на только что прицепленную
  // строку. Слияние удаляло её как младшую, внешний ключ (ON DELETE SET NULL)
  // обнулял ссылку живого лота, и market_active_has_item_ck валил транзакцию:
  // игрок не мог снять лот совсем.
  console.log('\n  ── снятие лота поверх своей же купки ──');
  {
    const market = require('../server/db/repos/market');
    const POT = 'bp_exp';
    await pool().query('DELETE FROM player_items WHERE player_id = $1', [pid]);
    await pool().query('DELETE FROM market_listings WHERE seller_id = $1', [pid]);
    const rowId = await tx(async (t) => {
      await items.lockPlayer(t, pid);
      return items.add(t, pid, POT, { qty: 40, source: 'test' });
    });
    const lot = await tx(t => market.list(t, pid, rowId, 0.18, { qty: 1 }));
    ok(!!lot && lot.id > 0, 'лот выставлен');
    const held = await rowsOf(null, 'inventory', POT);
    eq(sum(held), 39, 'у продавца осталось 39');

    let res = null, boom = null;
    try { res = await tx(t => market.cancel(t, pid, lot.id)); } catch (e) { boom = e; }
    ok(!boom, 'снятие лота не падает', boom && boom.message);
    ok(res && res.delivered === true, 'и говорит, что предмет вернулся');
    const back = await rowsOf(null, 'inventory', POT);
    eq(back.length, 1, 'вернувшийся предмет слился в ОДНУ строку');
    eq(sum(back), 40, 'и всё количество на месте');
    const { rows: st4 } = await pool().query(
      'SELECT status, item_id FROM market_listings WHERE id = $1', [lot.id]);
    eq(st4[0].status, 'cancelled', 'лот отмечен снятым');
    // Сначала ОТЦЕПЛЕННЫЕ строки, потом лоты. У выставленной строки player_id
    // равен NULL, поэтому `DELETE ... WHERE player_id = $1` её не достаёт, а
    // удаление лота убирает последнюю ссылку — и строка остаётся висеть ничьей.
    // Ровно такой мусор нашла dev/health-check.js после первых прогонов этой
    // проверки: «жоден предмет не завис поза ринком і поза інвентарем».
    await pool().query(
      `DELETE FROM player_items WHERE id IN (
         SELECT item_id FROM market_listings WHERE seller_id = $1 AND item_id IS NOT NULL)`, [pid]);
    await pool().query('DELETE FROM market_listings WHERE seller_id = $1', [pid]);
    await pool().query('DELETE FROM player_items WHERE player_id = $1', [pid]);
  }

  // ── 3. зелье лечит от ЖИВОГО HP ──────────────────────────────────────────
  console.log('\n  ── банки ──');
  const small = ITEM_DEF.find(d => d.id === 'pt1');
  const big = ITEM_DEF.find(d => d.id === 'pt2');
  eq(small && small.hp, 20, 'малое зелье лечит 20 — как в прежней сборке');
  eq(big && big.hp, 500, 'большое лечит 500 — как в прежней сборке');

  await pool().query(
    `UPDATE player_progress SET potion_bag = '{"pt1":9,"pt2":9}'::jsonb, hp = 2900, lvl = 30
      WHERE player_id = $1`, [pid]);
  const stats = require('../server/db/repos/stats');
  const stt = await stats.of(null, pid);

  // Комната говорит 100, база — 2900. Это обычное положение дел: колонку
  // пишет savePosition раз в двадцать секунд.
  // Дробное HP — обычное состояние комнаты: регенерация прибавляет hpRegen*dt
  // сорок раз в секунду. Колонка hp целая, и незакруглённое значение роняло
  // запись, откатывая транзакцию — зелье не тратилось совсем. Поймано
  // play-check, поэтому проверяется здесь же.
  const rFrac = await tx(t => consumables.usePotion(t, pid, 'pt1', 100.37));
  eq(rFrac.hp, 120, 'дробное живое HP не роняет запись — 100.37 + 20 = 120');
  await pool().query('UPDATE player_progress SET hp = 2900 WHERE player_id = $1', [pid]);

  const r1 = await tx(t => consumables.usePotion(t, pid, 'pt1', 100));
  eq(r1.healed, 20, 'малое зелье при живых 100 HP вылечило ровно 20');
  eq(r1.hp, 120, 'и HP стало 120, а не 2920 — вот это и было «фулл делает»');

  const r2 = await tx(t => consumables.usePotion(t, pid, 'pt2', 100));
  eq(r2.healed, 500, 'большое вылечило ровно 500');
  eq(r2.hp, 600, 'и HP стало 600');

  // У потолка лечит на остаток, а не на всю величину.
  const near = Math.max(1, stt.maxHp - 5);
  const r3 = await tx(t => consumables.usePotion(t, pid, 'pt2', near));
  eq(r3.hp, stt.maxHp, 'у потолка HP становится ровно maxHp');
  eq(r3.healed, stt.maxHp - near, 'а вылечило — только недостающее');

  // И запасной путь: без комнаты берётся сохранённое hp. Не лучше прежнего,
  // но и не хуже — поэтому именно запасной.
  await pool().query('UPDATE player_progress SET hp = 300 WHERE player_id = $1', [pid]);
  const r4 = await tx(t => consumables.usePotion(t, pid, 'pt1', null));
  eq(r4.hp, 320, 'без комнаты — от сохранённого HP');

  await pool().query('DELETE FROM player_items WHERE player_id = $1', [pid]);
  await pool().query('DELETE FROM player_progress WHERE player_id = $1', [pid]);
  await pool().query('DELETE FROM players WHERE id = $1', [pid]);

  console.log('');
  console.log(fail === 0
    ? `  \x1b[32m${pass} пройшло, 0 впало\x1b[0m\n`
    : `  \x1b[31m${pass} пройшло, ${fail} впало\x1b[0m\n`);
  await close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('  ОШИБКА: ' + e.message + '\n' + (e.stack || ''));
  try { if (pid) { await pool().query('DELETE FROM player_items WHERE player_id = $1', [pid]); } } catch (_x) { /* ignore */ }
  await close().catch(() => {});
  process.exit(1);
});
