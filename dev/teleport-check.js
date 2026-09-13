#!/usr/bin/env node
'use strict';
// ── Камень телепортации: цена и подтверждение покупки ───────────────────────
//
//   node dev/teleport-check.js
//
// Единственная строка лавки, которая тратит Liberty. Liberty покупают за
// настоящие деньги, а ряды лавки стоят вплотную друг к другу — промах по
// кнопке списывал валюту одним касанием и без вопросов, а с выбранным ×max
// мог увести весь баланс сразу. Отсюда подтверждение, и отсюда же эта
// проверка: «спросить перед списанием» — это порядок действий, и удалить его
// можно, ничего не сломав на вид.
//
// Функция покупки берётся ИЗ js/npc.js и запускается со заглушками, поэтому
// проверяется настоящий порядок, а не мой пересказ.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const D = require(path.join(ROOT, 'shared/definitions'));

let pass = 0, fail = 0;
const ok = (c, n, got) => { if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + n); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m  ' + n + (got !== undefined ? ' — ' + got : '')); } };

ok(D.TELEPORT_STONE_PRICE === 5, 'цена камня — 5 Liberty', D.TELEPORT_STONE_PRICE);

// Сервер считает по ТОЙ ЖЕ константе, а не по своему числу.
const cons = fs.readFileSync(path.join(ROOT, 'server/db/repos/consumables.js'), 'utf8');
ok(cons.includes('const cost = TELEPORT_STONE_PRICE * n;'), 'сервер берёт цену из общей константы');

const src = fs.readFileSync(path.join(ROOT, 'js/npc.js'), 'utf8');
const m = src.match(/function buyTeleportStone\(qty\) \{[\s\S]*?\n\}/);
ok(!!m, 'функция покупки найдена');

// Заглушки: всё, что функция трогает снаружи.
function run(balance, qty, haveModal) {
  const calls = { net: [], modal: [], msg: [] };
  const fn = new Function(
    'player', 'window', 'TELEPORT_STONE_PRICE', 'CRAFT_MATS', 't', 'tVars',
    '_shopMsg', 'netBuyTeleportStone', '_showConfirmModal',
    m[0] + '\n return buyTeleportStone;')(
    { lvl: 1 }, { _nexumBalance: balance }, D.TELEPORT_STONE_PRICE,
    D.CRAFT_MATS, (k) => k, (k, v) => k + ' ' + JSON.stringify(v),
    (s) => calls.msg.push(s),
    (n) => calls.net.push(n),
    haveModal ? ((text, onOk, lbl) => { calls.modal.push({ text, onOk, lbl }); }) : undefined);
  fn(qty);
  return calls;
}

console.log('\n  ── подтверждение ──');
{
  const c = run(100, 3, true);
  ok(c.net.length === 0, 'сразу ничего не покупается');
  ok(c.modal.length === 1, 'спрашивается подтверждение');
  ok(/"cost":15/.test(c.modal[0].text), 'в вопросе — настоящая сумма: 3 × 5 = 15', c.modal[0].text);
  ok(/"n":3/.test(c.modal[0].text), 'и количество');
  ok(/Камень телепортации/.test(c.modal[0].text), 'и название предмета', c.modal[0].text);
  c.modal[0].onOk();
  ok(c.net.length === 1 && c.net[0] === 3, 'после согласия уходит запрос ровно на 3');
}
{
  const c = run(100, 3, true);
  ok(c.net.length === 0, 'отказ (модалку просто закрыли) ничего не покупает');
}
console.log('\n  ── отказы ──');
{
  const c = run(4, 1, true);
  ok(c.modal.length === 0 && c.net.length === 0, 'при нехватке Liberty даже не спрашивается');
  ok(c.msg.length === 1, 'и говорится почему');
}
{
  // Старый бандл без общей модалки не должен остаться без покупки вовсе.
  const c = run(100, 2, false);
  ok(c.net.length === 1 && c.net[0] === 2, 'без модалки покупка всё равно работает');
}

console.log(`\n  ${pass} прошло, ${fail} упало\n`);
process.exit(fail ? 1 : 0);
