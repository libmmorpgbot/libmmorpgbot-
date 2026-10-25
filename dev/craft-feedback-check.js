#!/usr/bin/env node
'use strict';
// ── Крафт: понятно ли, удался он или нет ─────────────────────────────────────
//
//   node dev/craft-feedback-check.js
//
// Владелец: «сейчас при крафте непонятно скрафтилась вещь или нет — сделай
// какой-нибудь всплывающий текст, удачно зелёным либо провал красным».
//
// Причина была не в отсутствии текста — текст всегда был («✓ Создано: …»,
// «Провал! Материалы потеряны.») — а в том, что ОБЫЧНЫЙ _shopMsg КРАСНЫЙ
// ПО УМОЛЧАНИЮ (.shop-msg в css/style.css — это цвет отказов и ошибок), и
// успех крафта через него же выглядел так же тревожно, как провал. Зелёная
// версия (_shopMsgOk/.shop-msg-ok) уже существовала — её использовала только
// покупка на рынке, но ни один из семи путей крафта её не звал.
//
// Следующий шаг, тоже по просьбе владельца: «во время нажатия скрафтить —
// чтобы понятно было, успех или неудача, окошко как в достижении». Строка над
// карточкой рецепта сменилась окном результата (showCraftResult, js/npc.js):
// успех — золотое, неудача — красное, с треснувшим предметом. Здесь
// проверяется, что окно и правда различает исходы и что его открывает КАЖДЫЙ
// путь крафта, передавая исход броска, а не константу.

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (c, n, got) => {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + n); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m  ' + n + (got !== undefined ? ' — ' + got : '')); }
};

// ── 1. сама раскраска ────────────────────────────────────────────────────
console.log('\n  ── .shop-msg действительно красный, .shop-msg-ok — зелёный ──');
{
  const css = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');
  const plain = css.slice(css.indexOf('.shop-msg {'), css.indexOf('.shop-msg-ok'));
  const good = css.slice(css.indexOf('.shop-msg-ok {'), css.indexOf('@keyframes shopMsgPop'));
  ok(/#eb4e61|#f17e8b/.test(plain), '.shop-msg (обычный) — красная палитра');
  ok(!/#90d653|#98e456/.test(plain), '.shop-msg не зелёный — иначе отказы выглядели бы как успех');
  ok(/#90d653|#98e456/.test(good), '.shop-msg-ok — зелёная палитра');
}

// ── 2. каждый путь крафта ────────────────────────────────────────────────
const npc = fs.readFileSync(path.join(ROOT, 'js/npc.js'), 'utf8');
const ui = fs.readFileSync(path.join(ROOT, 'js/ui.js'), 'utf8');

function fn(src, name, nextName) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) return null;
  const end = nextName ? src.indexOf(`function ${nextName}(`, at) : src.indexOf('\nfunction ', at + 10);
  return src.slice(at, end > at ? end : undefined);
}

console.log('\n  ── окно результата различает успех и неудачу ──');
{
  const show = fn(npc, 'showCraftResult');
  const close = fn(npc, 'closeCraftResult');
  ok(!!show && !!close, 'showCraftResult и closeCraftResult найдены');
  // Само окно — настоящим вызовом на заглушке DOM, а не поиском по тексту.
  const made = [];
  const fakeDoc = {
    getElementById: () => null,
    createElement: () => ({ className: '', innerHTML: '', remove() {} }),
    body: { appendChild: (el) => made.push(el) },
  };
  const run = new Function('document', `let _craftResRetry = null;\n${show}\n${close}\nreturn showCraftResult;`)(fakeDoc);
  run({ ok: true, name: 'X' });
  run({ ok: false, name: 'X' });
  const [good, bad] = made;
  ok(good && /\bok\b/.test(good.className) && !/\bfail\b/.test(good.className), 'успех — окно с классом ok', good && good.className);
  ok(bad && /\bfail\b/.test(bad.className) && !/\bok\b/.test(bad.className), 'неудача — окно с классом fail', bad && bad.className);
  ok(good && /Успешно/.test(good.innerHTML) && !/Неудача/.test(good.innerHTML), 'успех подписан «Успешно!»');
  ok(bad && /Неудача/.test(bad.innerHTML) && /Материалы сгорели/.test(bad.innerHTML), 'неудача подписана «Неудача» и «Материалы сгорели»');

  const css = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');
  const okCss = css.slice(css.indexOf('.craft-res-ov.ok .craft-res {'), css.indexOf('.craft-res-ov.fail .craft-res {'));
  const failCss = css.slice(css.indexOf('.craft-res-ov.fail .craft-res {'), css.indexOf('.craft-res-rays {'));
  ok(/255,\s*(207|190)/.test(okCss) && !/235,\s*78|220,\s*60/.test(okCss), 'успех — золотая палитра');
  ok(/235,\s*78|220,\s*60/.test(failCss), 'неудача — красная палитра');
}

console.log('\n  ── окно открывает каждый путь крафта, с исходом броска ──');
for (const [name, next, src, okExpr] of [
  ['onBuffPotionCrafted', 'onBuffPotionCraftError', npc, /ok: true/],
  ['onBoxCrafted', 'onBoxCraftError', npc, /ok: true/],
  ['onClassGearCrafted', 'onClassGearCraftError', npc, /ok: !!item/],
  ['onPetCrafted', 'onPetCraftError', npc, /ok: !!pet/],
  ['onGearCrafted', 'onGearCraftError', npc, /ok: !!success/],
  ['onMatUpgraded', 'onMatUpgradeError', npc, /ok: got > 0/],
  ['onAdvSkillBookCrafted', 'onAdvSkillBookCraftError', npc, /ok: !!success/],
  ['onRuneCrafted', 'onRuneCraftError', ui, /ok: !!delivered/],
]) {
  const body = fn(src, name, next);
  ok(!!body && /showCraftResult\(\{/.test(body), `${name}: открывает окно результата`);
  ok(!!body && okExpr.test(body), `${name}: исход — ${okExpr.source.replace('ok: ', '')}`);
}
// «Нет места» — не исход броска: остаётся строкой, а не окном «Неудача».
for (const name of ['onClassGearCrafted', 'onPetCrafted']) {
  const body = fn(npc, name);
  ok(!!body && /if \(!delivered\) _shopMsg\(/.test(body) && /\|\| delivered\)\)/.test(body),
    `${name}: полный инвентарь — строкой, окно только для настоящего исхода`);
}

console.log('');
console.log(fail === 0
  ? `  \x1b[32m${pass} прошло, 0 упало\x1b[0m\n`
  : `  \x1b[31m${pass} прошло, ${fail} упало\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
