#!/usr/bin/env node
'use strict';
// ── язык спрашивают первым экраном ───────────────────────────────────────────
//
//   node dev/firstlang-check.js
//
// Новичок (аккаунт без героя) выбирает язык сразу после заставки — до экрана
// разрешения и до выбора героя. Раньше экран всплывал только на устройстве,
// где localStorage 'lang' пуст, и только после экрана разрешения: второй
// аккаунт на том же телефоне язык не выбирал вовсе.
//
// Функции берутся из настоящих js/network.js и js/charselect.js и гоняются в
// vm с заглушками localStorage/DOM. Красная на коде до исправления.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${extra ? ' — ' + extra : ''}`); }
}
function done() {
  console.log(`\n  ${pass} пройшло, ${fail} впало`);
  process.exit(fail ? 1 : 0);
}

console.log('\nfirstlang-check');
const net = fs.readFileSync(path.join(ROOT, 'js', 'network.js'), 'utf8');
const cs = fs.readFileSync(path.join(ROOT, 'js', 'charselect.js'), 'utf8');

// Вырезать объявление функции целиком (по балансу скобок).
function fn(src, name) {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) return null;
  let d = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}' && --d === 0) return src.slice(i, j + 1);
  }
  return null;
}

const names = ['_langAskedKey', '_needsFirstLang', '_firstLangThen'];
const bodies = names.map(n => fn(net, n));
ok(bodies.every(Boolean), 'в js/network.js есть _needsFirstLang/_firstLangThen', names.filter((_, i) => !bodies[i]).join(', '));
if (!bodies.every(Boolean)) done();

ok(/_firstLangThen\(_savedData,\s*\(\)\s*=>\s*_waGateIfNeeded\(/.test(net),
  'authOk: сначала язык, потом экран разрешения, потом выбор героя');
const csBody = fn(net, '_showCharSelect') || '';
ok(!/_showFirstLangPicker/.test(csBody), '_showCharSelect больше не спрашивает язык сам (не дважды)');

function sandbox(store, uid) {
  const els = {
    'first-lang-select': { style: { display: 'none' } },
    'fls-grid': { innerHTML: '' },
  };
  const ctx = {
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    document: { getElementById: id => els[id] || null },
    window: { Telegram: { WebApp: { initDataUnsafe: { user: { id: uid, language_code: 'uk' } } } } },
    I18N_LANGS: [{ code: 'ru', native: 'Русский', flag: '' }, { code: 'en', native: 'English', flag: '' }, { code: 'uk', native: 'Українська', flag: '' }],
    setLang: code => { store.lang = code; },
    els,
  };
  ctx._tgUserId = () => String(uid);
  vm.createContext(ctx);
  vm.runInContext(bodies.join('\n') + '\n' + fn(cs, '_showFirstLangPicker') + '\n' + fn(cs, '_firstLangPick'), ctx);
  return ctx;
}

// ── новичок на чистом устройстве ────────────────────────────────────────────
{
  const store = {};
  const c = sandbox(store, 1);
  let went = 0;
  c._firstLangThen(null, () => { went++; });
  ok(c.els['first-lang-select'].style.display === 'flex' && went === 0, 'новичок: экран языка открыт, дальше не пускает');
  ok(/Українська[\s\S]*Русский/.test(c.els['fls-grid'].innerHTML) && c.els['fls-grid'].innerHTML.indexOf('active') < c.els['fls-grid'].innerHTML.indexOf('Русский'),
    'язык Telegram первым и подсвечен');
  c._firstLangPick('en');
  ok(went === 1 && store.lang === 'en', 'выбрал — язык сохранён, игра пошла дальше');
  const c2 = sandbox(store, 1);
  let went2 = 0;
  c2._firstLangThen(null, () => { went2++; });
  ok(went2 === 1 && c2.els['first-lang-select'].style.display !== 'flex', 'закрыл на выборе героя и вернулся — второй раз не спрашивает');
}

// ── второй аккаунт на том же телефоне ───────────────────────────────────────
{
  const store = { lang: 'ru' };          // кто-то уже играл на этом устройстве
  const c = sandbox(store, 2);
  let went = 0;
  c._firstLangThen({ type: null }, () => { went++; });
  ok(c.els['first-lang-select'].style.display === 'flex' && went === 0,
    'новый аккаунт на устройстве, где язык уже выбирали, — всё равно спрашивает');
}

// ── у кого герой есть ───────────────────────────────────────────────────────
{
  const store = {};
  const c = sandbox(store, 3);
  let went = 0;
  c._firstLangThen({ type: 'ranger', lang: 'en' }, () => { went++; });
  ok(went === 1 && c.els['first-lang-select'].style.display !== 'flex', 'у старого игрока с героем экран не всплывает');
}

// ── переподключение, пока экран открыт ─────────────────────────────────────
{
  const store = {};
  const c = sandbox(store, 4);
  let a = 0, b = 0;
  c._firstLangThen(null, () => { a++; });
  c._firstLangThen(null, () => { b++; });
  c._firstLangPick('ru');
  ok(a === 0 && b === 1, 'повторный authOk не открывает второй экран; выбор ведёт по новому пути');
}

done();
