#!/usr/bin/env node
'use strict';
// ── Возмещение владельцам сезонного билета ──────────────────────────────────
//
//   node dev/ticket-refund.js                       только посчитать
//   node dev/ticket-refund.js --liberty 5000        и выдать по 5000 Liberty
//   node dev/ticket-refund.js --gram 15             или вернуть цену билета
//   node dev/ticket-refund.js --liberty 5000 --apply
//
// Билет стоит реальных денег (15 GRAM), а часть того, за что платили, неделю
// не работала: очки сезона за заточку не начислялись вовсе, а множитель к
// выпадению Liberty в фарм-зонах упирался в жёсткий ноль. Возмещение — это
// признание, что человек заплатил за то, чего не получил.
//
// ── почему сумма ЗАДАЁТСЯ, а не зашита ─────────────────────────────────────
// Сколько именно вернуть — не техническое решение. Это деньги игроков и
// решение владельца: вернуть цену билета целиком, дать Liberty сверх, или и
// то и другое. Скрипт делает ровно то, что ему сказали, и ни копейкой больше.
//
// ── и почему один раз ──────────────────────────────────────────────────────
// Ключ идемпотентности содержит и сумму, и валюту, и метку кампании. Второй
// запуск с теми же аргументами не выдаст ничего повторно — money.spend/credit
// узнают ключ и уйдут в ветку повтора. Запуск с ДРУГОЙ суммой — это другая
// кампания, и она пройдёт: так и задумано, дважды по разным причинам возместить
// можно, дважды по одной — нет.
const { pool, tx, close } = require('../server/db');
const money = require('../server/db/repos/money');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const numArg = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return 0;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : 0;
};
const LIBERTY = numArg('--liberty');
const GRAM = numArg('--gram');
// Метка кампании: входит в ключ, поэтому две разные выплаты не сливаются.
const TAG = (() => {
  const i = argv.indexOf('--tag');
  return (i >= 0 && argv[i + 1]) ? String(argv[i + 1]) : 'season1';
})();

const q = (sql, args) => pool().query(sql, args);

(async () => {
  const { rows: holders } = await q(`
    SELECT p.id, p.username, p.telegram_id
      FROM player_vip v JOIN players p ON p.id = v.player_id
     WHERE v.season_ticket = true
       AND p.telegram_id ~ '^[0-9]+$'
       AND NOT p.banned
     ORDER BY p.id`);

  console.log(`\n  владельцев билета: ${holders.length}`);
  if (!holders.length) { await close(); return; }

  if (!LIBERTY && !GRAM) {
    console.log('\n  сумма не задана — ничего не выдано.');
    console.log('    node dev/ticket-refund.js --liberty 5000 --apply');
    console.log('    node dev/ticket-refund.js --gram 15 --apply');
    console.log(`\n  первые десять из списка:`);
    for (const h of holders.slice(0, 10)) console.log(`    ${h.username} (tg ${h.telegram_id})`);
    await close();
    return;
  }

  console.log(`  выдать каждому: ${LIBERTY ? LIBERTY + ' Liberty' : ''}`
    + `${LIBERTY && GRAM ? ' и ' : ''}${GRAM ? GRAM + ' GRAM' : ''}`);
  console.log(`  метка кампании: ${TAG}`);
  console.log(`  итого: ${LIBERTY ? holders.length * LIBERTY + ' Liberty' : ''}`
    + `${LIBERTY && GRAM ? ' и ' : ''}${GRAM ? holders.length * GRAM + ' GRAM' : ''}`);

  if (!APPLY) {
    console.log('\n  это разведка. Выдать: добавьте --apply\n');
    await close();
    return;
  }

  let done = 0, already = 0, failed = 0;
  for (const h of holders) {
    try {
      await tx(async (t) => {
        if (LIBERTY) {
          const r = await money.credit(t, h.id, 'nexum', LIBERTY, {
            reason: 'ticket_refund', refType: 'campaign', refId: TAG,
            idemKey: `refund:${TAG}:nexum:${LIBERTY}:${h.id}`,
          });
          if (r && r.replayed) already++;
        }
        if (GRAM) {
          const r = await money.credit(t, h.id, 'gram', GRAM, {
            reason: 'ticket_refund', refType: 'campaign', refId: TAG,
            idemKey: `refund:${TAG}:gram:${GRAM}:${h.id}`,
          });
          if (r && r.replayed) already++;
        }
      });
      done++;
    } catch (err) {
      failed++;
      console.error(`  ! ${h.username} (${h.id}): ${err.message}`);
    }
  }

  console.log(`\n  выдано: ${done}`);
  if (already) console.log(`  из них уже получали по этой метке: ${already} (повторно не начислено)`);
  if (failed) console.log(`  \x1b[31mне удалось: ${failed}\x1b[0m`);
  console.log('');
  await close();
})().catch(async (e) => { console.error(e); try { await close(); } catch {} process.exit(1); });
