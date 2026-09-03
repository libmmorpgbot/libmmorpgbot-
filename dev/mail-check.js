#!/usr/bin/env node
'use strict';
// ── Письмо: две награды, одна на аккаунт ────────────────────────────────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/mail-check.js
//
// Правила владельца, все четыре:
//
//   без билета  получает первую награду — и ТОЛЬКО её;
//   с билетом   получает вторую — и первая ему недоступна;
//   один раз    забрал — больше нельзя, ни той, ни другой;
//   кнопка      после этого исчезает.
//
// Почему это отдельный детектор, а не строчка в bonuses-check. Развилка здесь
// решается СЕРВЕРОМ по player_vip.season_ticket, и ошибиться в ней можно
// беззвучно: если бы claimMailBonus читал билет из того, что прислал клиент,
// щедрая награда доставалась бы любому, кто отправит mailBonusClaim с
// подделанным флагом — а выглядело бы это как исправно работающая выдача.
// Проверяется поэтому не «не упало ли», а ЧТО ИМЕННО легло в инвентарь, и по
// какой ветке, при билете и без него.
//
// Второе, что здесь ловится, — «забрать дважды». Флаг ставится условным
// UPDATE до выдачи, и в этом весь смысл: два нажатия, два сокета, обрыв
// посреди выдачи — все они гонятся за одной строкой, и совпадает ровно один.
// Проверка гоняет два claim подряд и смотрит на инвентарь, а не на текст
// ошибки: «уже получено» легко напечатать и всё равно выдать награду.
const { tx, query, close } = require('../server/db');
const players = require('../server/db/repos/players');
const items = require('../server/db/repos/items');
const progression = require('../server/db/repos/progression');
const shop = require('../server/db/repos/shop');
const D = require('../shared/definitions');
const { _VIP_BP } = require('../server/shop');
const { wipeItemsAll } = require('./fixtures');

let pass = 0, fail = 0;
const ok = (c, name, got) => {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + name); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m  ' + name + (got !== undefined ? ' — ' + got : '')); }
};
const eq = (a, b, n) => ok(a === b, n, `ожидал ${JSON.stringify(b)}, получил ${JSON.stringify(a)}`);

const TAG = 'mail-' + String(process.pid).slice(-5);
const made = [];

// Что лежит в инвентаре, по видам. Именно это обещает панель, и именно это
// должно прийти — а не «сколько строк добавилось».
const invOf = async (pid) => {
  const { rows } = await query(null,
    `SELECT item_id, sum(qty)::int q FROM player_items
      WHERE player_id = $1 AND container = 'inventory' GROUP BY item_id`, [pid]);
  return Object.fromEntries(rows.map(r => [r.item_id, r.q]));
};
const claimedFlag = async (pid) => {
  const { rows } = await query(null,
    'SELECT mail_bonus_claimed FROM player_progress WHERE player_id = $1', [pid]);
  return rows[0].mail_bonus_claimed;
};
const claim = async (pid) => {
  try { return { ok: true, res: await tx(t => shop.claimMailBonus(t, pid)) }; }
  catch (e) { return { ok: false, code: e.code, msg: e.message }; }
};

(async () => {
  console.log(`\nmail-check  (${TAG})\n`);

  // Каталог наполняется на старте сервера, а не миграцией (syncCatalog,
  // server/db/repos/items.js). Без него items.add откажет на первом же
  // bp_hp — «unknown or retired item id», — и провалится вся проверка, ничего
  // не сказав о самой награде.
  await tx(t => items.syncCatalog(t));

  // ── без сезонного билета ────────────────────────────────────────────────
  console.log('  ── без билета ──');
  const { id: plain } = await tx(t => players.ensure(t, `${TAG}-a`, `${TAG}_без`));
  made.push(plain);

  eq(await claimedFlag(plain), false, 'до получения флаг снят — кнопка на экране');

  const a = await claim(plain);
  ok(a.ok, 'награда выдана', a.msg);
  eq(a.ok && a.res.seasonTicket, false, 'и выдана по ветке БЕЗ билета');

  const invA = await invOf(plain);
  const freeTier = D.MAIL_BONUS.free;
  const missA = _VIP_BP.filter(bp => invA[bp.id] !== freeTier.buffPotions);
  ok(missA.length === 0,
    `по ${freeTier.buffPotions} банок каждого из ${_VIP_BP.length} бафов`,
    missA.map(bp => `${bp.id}=${invA[bp.id]}`).join(', '));
  eq(invA.norm_stone, freeTier.mats.norm_stone,
    `${freeTier.mats.norm_stone} камня обычной заточки`);

  // Вот это и есть правило «первая награда — не для владельцев билета»,
  // прочитанное с другой стороны: в бесплатной ветке нет ни безопасных
  // заточек, ни сундуков.
  ok(!invA.bless_stone, 'безопасных заточек в бесплатной ветке нет', String(invA.bless_stone));
  ok(!invA.box_uncommon && !invA.box_rare, 'и сундуков тоже',
    `${invA.box_uncommon} / ${invA.box_rare}`);

  // ── второй раз ──────────────────────────────────────────────────────────
  console.log('  ── второй раз ──');
  eq(await claimedFlag(plain), true, 'флаг поднят — кнопка исчезает');
  const again = await claim(plain);
  eq(again.ok, false, 'повторное получение отклонено');
  eq(again.code, 'already', 'и причина названа');
  // Текст отказа ничего не стоит. Стоит то, что в инвентаре ничего не
  // прибавилось: обработчик, который печатает «уже получено» и всё равно
  // выдаёт, прошёл бы проверку по коду ошибки.
  const invAfter = await invOf(plain);
  eq(JSON.stringify(invAfter), JSON.stringify(invA), 'и инвентарь не изменился');

  // ── с сезонным билетом ──────────────────────────────────────────────────
  console.log('  ── с билетом ──');
  const { id: vip } = await tx(t => players.ensure(t, `${TAG}-b`, `${TAG}_билет`));
  made.push(vip);
  await tx(t => progression.grantSeasonTicket(t, vip));
  const v = await tx(t => progression.vipOf(t, vip));
  eq(v.seasonTicket, true, 'билет у аккаунта действительно есть');

  const b = await claim(vip);
  ok(b.ok, 'награда выдана', b.msg);
  eq(b.ok && b.res.seasonTicket, true, 'и выдана по ветке С билетом');

  const invB = await invOf(vip);
  const tk = D.MAIL_BONUS.ticket;
  const missB = _VIP_BP.filter(bp => invB[bp.id] !== tk.buffPotions);
  ok(missB.length === 0,
    `по ${tk.buffPotions} банок каждого из ${_VIP_BP.length} бафов`,
    missB.map(bp => `${bp.id}=${invB[bp.id]}`).join(', '));
  eq(invB.bless_stone, tk.mats.bless_stone,
    `${tk.mats.bless_stone} камня безопасной заточки`);
  eq(invB.box_uncommon, tk.boxes.box_uncommon,
    `${tk.boxes.box_uncommon} необычных (зелёных) сундука`);
  eq(invB.box_rare, tk.boxes.box_rare,
    `${tk.boxes.box_rare} редких (синих) сундука`);
  // И зеркало первой ветки: владельцу билета не досталось обычных заточек,
  // то есть бесплатную награду он не получил.
  ok(!invB.norm_stone, 'обычных заточек владельцу билета не досталось', String(invB.norm_stone));

  console.log('  ── и ему второй раз тоже нельзя ──');
  const againB = await claim(vip);
  eq(againB.ok, false, 'повторное получение отклонено и с билетом');

  // ── билет, купленный ПОСЛЕ ──────────────────────────────────────────────
  // Награда одна на аккаунт, и это значит ровно то, что написано: купить
  // билет после получения бесплатной ветки и прийти за второй нельзя.
  // Проверяется отдельно, потому что соблазн «ну ему же теперь положено»
  // выглядит как доброта, а на деле это вторая награда на один аккаунт.
  console.log('  ── билет куплен после получения ──');
  await tx(t => progression.grantSeasonTicket(t, plain));
  const late = await claim(plain);
  eq(late.ok, false, 'билет, купленный после, второй награды не открывает');
  const invLate = await invOf(plain);
  eq(JSON.stringify(invLate), JSON.stringify(invA), 'инвентарь по-прежнему тот же');

  // ── журнал предметов ────────────────────────────────────────────────────
  // Выдача идёт через items.add, значит каждая единица обязана быть в
  // item_ledger. Если однажды кто-то ускорит выдачу прямым INSERT, звёздочка
  // сойдётся здесь, а не через неделю в ночной сверке.
  console.log('  ── журнал ──');
  const { rows: led } = await query(null,
    `SELECT sum(delta)::int total FROM item_ledger WHERE player_id = $1`, [vip]);
  const held = Object.values(invB).reduce((n, q) => n + q, 0);
  eq(Number(led[0].total), held, `журнал сходится с руками (${held})`);

  console.log('');
  console.log(fail === 0
    ? `  \x1b[32m${pass} пройшло, 0 впало\x1b[0m\n`
    : `  \x1b[31m${pass} пройшло, ${fail} впало\x1b[0m\n`);
  await wipeItemsAll(made);
  await close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error(e);
  try { await wipeItemsAll(made); await close(); } catch {}
  process.exit(1);
});
