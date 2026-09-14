#!/usr/bin/env node
'use strict';
// ── Что попадает в ленту админки, а что нет ────────────────────────────────
//
//   node dev/playerlog-check.js
//
// Журнал игрока читают, когда человек уже звонит и спрашивает «где моя вещь».
// Значит проверять надо не «пишется ли строка», а отвечает ли она на вопрос:
// у кого купил, кому продал, что положил в хранилище, куда зашёл. Строка
// «marketBuy» без имени продавца — это запись о том, что что-то было.
//
// Здесь нет базы: всё проверяемое — это списки действий и формы меты, то есть
// текст файлов и чистые функции. Живой путь (плата → строка) проверяют
// dev/market-check.js и dev/items-check.js из группы DB.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const D = require(path.join(ROOT, 'shared/definitions'));
const F = require(path.join(ROOT, 'server/game/floors')).FLOOR_IDS;

let pass = 0, fail = 0;
const ok = (c, n, got) => {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + n); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m  ' + n + (got !== undefined ? ' — ' + got : '')); }
};
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const session = read('server/session.js');
const econ = read('server/handlers2/economy.js');
const itemsH = read('server/handlers2/items.js');
const worldH = read('server/handlers2/world.js');
const modes = read('server/modes.js');

// ── что пишется вообще ─────────────────────────────────────────────────────
console.log('\n  ── список пишущих действий ──');
{
  const m = session.match(/const WRITE_ACTIONS = new Set\(\[([\s\S]*?)\]\);/);
  ok(!!m, 'список найден');
  // Комментарии выбрасываются: в них имена действий тоже встречаются, и без
  // этого «usePotion упомянут в объяснении, почему его тут нет» читалось как
  // «usePotion в списке».
  const body = m[1].split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  const acts = [...body.matchAll(/'([\w:]+)'/g)].map(x => x[1]);
  // То, ради чего журнал заводили.
  for (const a of ['marketList', 'marketBuy', 'marketCancel', 'storageDeposit', 'storageWithdraw',
    'enhanceItem', 'craftGear', 'craftRune', 'craftPet', 'enterLocation',
    'gramDepositRequest', 'gramWithdrawRequest', 'sellItem', 'itemDisassemble']) {
    ok(acts.includes(a), `пишется: ${a}`);
  }
  // А это — то, чего в ленте быть не должно.
  ok(!acts.includes('usePotion'), 'зелье здоровья НЕ пишется — иначе лента это один сплошной usePotion');
  ok(acts.includes('useBuffPotion'), 'зелья бафа пишутся: их покупают и крафтят');
}

// ── сделки: обе стороны ────────────────────────────────────────────────────
console.log('\n  ── рынок ──');
{
  ok(/plog\.log\(res\.sellerId, 'marketSold'/.test(econ),
    'у продавца появляется своя строка — покупка идёт в транзакции покупателя, и без этого его ленте сказать нечего');
  // Именно ЗАПИСЬ В ЖУРНАЛ, а не первое совпадение: строкой выше в файле
  // стоит emit('marketSold') продавцу, и слайс от него читал чужой код.
  const soldAt = econ.indexOf("plog.log(res.sellerId, 'marketSold'");
  const sold = econ.slice(soldAt, soldAt + 400);
  ok(/покупатель:/.test(sold), 'в ней сказано, КОМУ продал');
  ok(/предмет:/.test(sold) && /цена:/.test(sold), 'а также что и почём');
  const buyAt = econ.indexOf('продавец:');
  const buyMeta = econ.slice(Math.max(0, buyAt - 200), buyAt + 200);
  ok(/продавец:/.test(buyMeta), 'у покупателя в строке — У КОГО купил');
  ok(/_twoSides/.test(econ) && /username/.test(econ),
    'обе стороны названы ником, а не внутренним id');
  ok(/адрес:/.test(econ) && /сумма:/.test(econ), 'вывод GRAM пишет сумму, комиссию и адрес');
}

// ── хранилище ──────────────────────────────────────────────────────────────
console.log('\n  ── хранилище ──');
{
  ok(/_describeRow\(t, pid, row, 'inventory'\)/.test(itemsH), 'при вкладывании предмет читается ДО переноса');
  ok(/_describeRow\(t, pid, row, 'storage'\)/.test(itemsH), 'при изъятии — тоже');
  const descAt = itemsH.indexOf('async function _describeRow');
  const desc = itemsH.slice(descAt, itemsH.indexOf('\n}', descAt));
  ok(/предмет:/.test(desc), 'в строке есть название предмета');
  // Без двоеточия: в коде это присваивания (out.заточка = ...), а не пары
  // объектного литерала — двоеточие искало то, чего там и не должно быть.
  ok(/out\.заточка/.test(desc) && /out\.штук/.test(desc), 'а также заточка и количество');
  ok(/ITEM_DEF\.find/.test(desc), 'название берётся из каталога, а не со слов клиента');
  ok(/catch \{/.test(desc), 'и журнал не может сорвать сам перенос');
}

// ── локации и события ──────────────────────────────────────────────────────
console.log('\n  ── куда зашёл ──');
{
  ok(/куда: _floorName\(target, landed\)/.test(worldH), 'enterLocation пишет, КУДА зашёл');
  ok(/Фарм зона 2/.test(worldH) && /Кровавая Башня/.test(worldH), 'локации названы по-русски, а не номером этажа');

  ok(/plog\.log\(this\.playerId, 'eventEnter'/.test(session), 'вход в событие пишется');
  const tbl = session.match(/const EVENT_FLOOR_RU = \{([\s\S]*?)\};/);
  ok(!!tbl, 'таблица событий найдена');
  const ev = [...tbl[1].matchAll(/FLOOR_IDS\.(\w+)\]: '([^']+)'/g)].map(x => x[1]);
  for (const key of ['race10', 'pvpArena', 'fear', 'coop', 'farmZone2', 'arena', 'guildWar', 'tournament']) {
    ok(ev.includes(key) && F[key] !== undefined, `событие ${key} (этаж ${F[key]})`);
  }
  ok(!ev.includes('hub') && !ev.includes('left'),
    'хаб и коридоры событиями не считаются — иначе лента утонет в возвратах');
  // Одно место на все режимы: запись стоит в forceFloor, куда сходятся все.
  // От объявления метода до его конца, а не «четыре тысячи символов вперёд»:
  // длина метода — не константа, и слайс по числу однажды промахнётся.
  const ffAt = session.indexOf('  forceFloor(floorId');
  const ff = session.slice(ffAt, session.indexOf('\n  }', ffAt));
  ok(/eventEnter/.test(ff), 'запись стоит в forceFloor — общем пути всех режимов');
}

// ── режимы больше не пишут в никуда ────────────────────────────────────────
console.log('\n  ── старты и финалы забегов ──');
{
  ok(!/logPlayer: \(\) => \{\},/.test(modes),
    'заглушка logPlayer убрана — четыре вызова из arena3/race10 уходили в никуда');
  ok(/logPlayer: \(telegramId, name, event, meta\)/.test(modes), 'на её месте настоящая запись');
  ok(/_pidOf\(telegramId\)/.test(modes), 'telegram-id переводится в player_id');
  ok(/_pidCache/.test(modes), 'и перевод кешируется — за забег он зовётся десятки раз');
  const race = read('server/game/race10.js'), a3 = read('server/game/arena3.js');
  // В вызове есть вложенные скобки (_socketTid(...)), поэтому [^)]* обрывался
  // на первой закрывающей и не доходил до имени события.
  ok(/logPlayer\([\s\S]{0,120}?'race10_start'/.test(race) && /logPlayer\([\s\S]{0,120}?'race10_end'/.test(race),
    'башня пишет старт и финал');
  ok(/logPlayer\([\s\S]{0,120}?'arena3_start'/.test(a3) && /logPlayer\([\s\S]{0,120}?'arena3_end'/.test(a3),
    'арена тоже');
}

// ── ошибки и отказы ────────────────────────────────────────────────────────
console.log('\n  ── ошибки ──');
{
  ok(/plog\.log\(pid, 'error', \{ action: name/.test(session), 'ошибка действия пишется с названием действия');
  ok(/plog\.log\(pid, `refuse:\$\{name\}`/.test(session), 'отказ пишется с кодом и текстом, который увидел игрок');
  ok(/plog\.log\(s\.playerId, 'client:' \+ w/.test(read('server/app.js')),
    'ошибки клиента тоже попадают в журнал игрока');
}

console.log('');
console.log(fail === 0
  ? `  \x1b[32m${pass} прошло, 0 упало\x1b[0m\n`
  : `  \x1b[31m${pass} прошло, ${fail} упало\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
