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
// Проверяется буквально по исходнику: каждый путь, где исход крафта известен
// СРАЗУ (без второго прохода через сервер), зовёт _shopMsgOk на успехе и
// обычный _shopMsg на провале — а не одну и ту же функцию на оба.

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

console.log('\n  ── без броска: зелья, боксы — всегда успех ──');
{
  const potion = fn(npc, 'onBuffPotionCrafted');
  ok(potion && /_shopMsgOk\(/.test(potion), 'зелье баффа: _shopMsgOk');
  const box = fn(npc, 'onBoxCrafted');
  ok(box && /_shopMsgOk\(/.test(box), 'бокс: _shopMsgOk');
}

console.log('\n  ── доставка отдельно от броска: классовая экипировка, питомец ──');
for (const name of ['onClassGearCrafted', 'onPetCrafted']) {
  const body = fn(npc, name);
  ok(!!body, `${name} найдена`);
  if (!body) continue;
  ok(/if \(delivered\) \{\s*\n\s*_shopMsgOk\(/.test(body),
    `${name}: доставлено — _shopMsgOk`);
  ok(!/\? \(typeof t === 'function' \? t\('craftCreatedPrefix'\)/.test(body),
    `${name}: больше не тернарник в один _shopMsg (успех и провал разными вызовами)`);
}

console.log('\n  ── бросок прямо здесь: снаряжение, материалы, вторая профессия ──');
for (const [name, next] of [
  ['onGearCrafted', 'onGearCraftError'],
  ['onMatUpgraded', 'onMatUpgradeError'],
  ['onAdvSkillBookCrafted', 'onAdvSkillBookCraftError'],
]) {
  const body = fn(npc, name, next);
  ok(!!body, `${name} найдена`);
  if (!body) continue;
  ok(/if \(success\) \{\s*\n\s*_shopMsgOk\(/.test(body),
    `${name}: успех — _shopMsgOk`);
  ok(/\} else \{\s*\n\s*_shopMsg\(/.test(body),
    `${name}: провал — обычный (красный) _shopMsg`);
  ok(!new RegExp(`_shopMsg\\(success\\s*\\n?\\s*\\?`).test(body),
    `${name}: не тернарник в одну функцию — успех и провал зовут РАЗНОЕ`);
}

console.log('\n  ── руна: _shopMsgOrToast умеет красить, а не всегда один цвет ──');
{
  const toastFn = fn(ui, '_shopMsgOrToast');
  ok(!!toastFn && /ok === true/.test(toastFn) && /ok === false/.test(toastFn),
    '_shopMsgOrToast принимает ok и различает true/false, а не только есть/нет');
  ok(/_shopMsgOk\(msg\); return;/.test(toastFn || ''),
    'ok===true уходит в зелёный _shopMsgOk, когда панель кузнеца открыта');

  const crafted = fn(ui, 'onRuneCrafted');
  ok(!!crafted && /_shopMsgOrToast\([^)]*,\s*true\)/.test(crafted),
    'ковка руны удалась — вызов помечен true');
  ok(!!crafted && /_shopMsgOrToast\([^)]*,\s*false\)/.test(crafted),
    'ковка руны провалилась — вызов помечен false');
}

console.log('');
console.log(fail === 0
  ? `  \x1b[32m${pass} прошло, 0 упало\x1b[0m\n`
  : `  \x1b[31m${pass} прошло, ${fail} упало\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
