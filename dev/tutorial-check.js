#!/usr/bin/env node
'use strict';
// ── обучение новичка: шаги засчитываются тем, о чём просят ─────────────────
//
//   node dev/tutorial-check.js
//
// js/tutorial.js гоняется в песочнице vm вместе с настоящими строками
// (js/i18n.js): игрок, этаж, вкладки и localStorage — заглушки. Проверяется
// весь путь: язык → ходьба → портал → 5 убийств → зелье → квесты → улучшение
// → вещь → навык → 10 уровень → финал; что шаг не засчитывается раньше
// времени; что у старого игрока (уровень ≥ 10) обучение не всплывает; что
// прогресс переживает перезагрузку; что у каждого шага есть текст на всех
// языках из выбора.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${extra ? ' — ' + extra : ''}`); }
}

const TUT_FILE = path.join(ROOT, 'js', 'tutorial.js');
console.log('\ntutorial-check');
if (!fs.existsSync(TUT_FILE)) {
  ok(false, 'js/tutorial.js существует');
  console.log(`\n  ${pass} пройшло, ${fail} впало`);
  process.exit(1);
}
ok(require('../server/bundle-files').includes('js/tutorial.js'), 'js/tutorial.js входит в сборку клиента');
ok(/tutorialStart\(\)/.test(fs.readFileSync(path.join(ROOT, 'js', 'network.js'), 'utf8')),
  '_finishOnlineStart запускает обучение');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
ok(html.includes('id="tut-card"') && html.includes('id="tut-ring"'), 'в index.html есть карточка и кольцо');

function makeEl() {
  return { style: {}, dataset: {}, innerHTML: '', offsetParent: {},
    classList: { toggle() {}, add() {}, remove() {} },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 40, height: 20, bottom: 20 }) };
}

function sandbox(store) {
  const els = {};
  const ctx = {
    console, Math, JSON, performance: { now: () => Date.now() },
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    document: {
      getElementById: id => (els[id] = els[id] || makeEl()),
      querySelectorAll: () => [makeEl(), makeEl(), makeEl(), makeEl(), makeEl(), makeEl()],
      body: { classList: { toggle() {}, remove() {} } },
    },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    window: {},
    W: 390, H: 844, HEADER_H: 88, NAV_H: 50, ZOOM: 1, TILE: 32, JOY_R: 50,
    _lastCamX: 0, _lastCamY: 0,
    joyCenter: () => ({ x: 100, y: 700 }),
    getAttackBtnPos: () => ({ x: 330, y: 730, r: 40 }),
    getPotionBtnPos: () => ({ x: 350, y: 570, r: 25 }),
    getAutoBtnPos: () => ({ x: 330, y: 500, w: 40, h: 40, cx: 350, cy: 520, r: 20 }),
    _tgUserId: () => '777',
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'i18n.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(TUT_FILE, 'utf8'), ctx);
  // let-переменные бандла не видны как свойства контекста — ставим их
  // изнутри, как это делает сама игра.
  ctx.set = src => vm.runInContext(src, ctx);
  ctx.get = src => vm.runInContext(src, ctx);
  ctx.set(`var state = 'playing', activeTab = 0, _invTab = 0, autoAttackMode = false,
    _portalPad = { x: 100, y: 300 },
    dungeon = { armEntries: [{ dir: 'left' }] },
    player = { x: 0, y: 0, lvl: 1, kills: 0, potionBag: { pt1: 30 },
      upgrades: { atk: 0, def: 0 }, skillLevels: { Q: 0, W: 0, E: 0, R: 0 },
      equipment: { weapon: null, helmet: null } };`);
  return ctx;
}

const frame = c => c.get('_tutFrame()');
const stepId = c => c.get('_tut && !_tut.off ? TUT_STEPS[_tut.step].id : "off"');

// ── тексты ──────────────────────────────────────────────────────────────────
{
  const c = sandbox({});
  const ids = c.get('TUT_STEPS.map(s => s.id)');
  const langs = c.get('I18N_LANGS.map(l => l.code)');
  const miss = [];
  for (const id of ids) for (const suf of ['_t', '_d']) {
    const row = c.get(`I18N_UI['tut_${id}${suf}']`);
    for (const l of langs) if (!row || !row[l]) miss.push(`tut_${id}${suf}.${l}`);
  }
  ok(miss.length === 0, 'у каждого шага заголовок и текст на всех языках', miss.slice(0, 5).join(', '));
}

// ── полный путь ─────────────────────────────────────────────────────────────
{
  const store = {};
  const c = sandbox(store);
  c.get('tutorialStart()');
  ok(stepId(c) === 'lang', 'новичок начинает с выбора языка');
  frame(c);
  ok(stepId(c) === 'lang', 'шаг не засчитывается сам по себе');
  c.set('activeTab = 5; window._profileTab = "lang";'); frame(c);
  ok(stepId(c) === 'move', 'открыл «Профиль → Язык» — язык засчитан');

  c.set('activeTab = 0; player.x += 60;'); frame(c);
  ok(stepId(c) === 'move', `ход меньше ${c.get('TUT_MOVE_PX')}px ещё не засчитан`);
  c.set('player.x += 120;'); frame(c);
  ok(stepId(c) === 'portal', 'прошёлся — дальше портал');

  frame(c);
  ok(stepId(c) === 'portal', 'пока на базе, портал не засчитан');
  c.set('dungeon = { armEntries: null };'); frame(c);
  ok(stepId(c) === 'kill', 'ушёл с базы — дальше монстры');

  c.set('player.kills += 4;'); frame(c);
  ok(stepId(c) === 'kill', '4 убийства из 5 — ещё нет');
  ok(c.get('TUT_STEPS[_tut.step].progress(_tut.base)') === '4/5', 'прогресс на карточке 4/5');

  // перезагрузка посреди шага: прогресс не обнуляется
  const c2 = sandbox(store);
  c2.set('player.kills = 4; dungeon = { armEntries: null };');
  c2.get('tutorialStart()');
  ok(stepId(c2) === 'kill' && c2.get('TUT_STEPS[_tut.step].progress(_tut.base)') === '4/5',
    'после перезагрузки тот же шаг и тот же прогресс');

  c.set('player.kills += 1;'); frame(c);
  ok(stepId(c) === 'potion', '5 убийств — дальше зелье');
  c.set('player.potionBag.pt1 -= 1;'); frame(c);
  ok(stepId(c) === 'quests', 'выпил зелье — дальше квесты');
  c.set('activeTab = 3;'); frame(c);
  ok(stepId(c) === 'upgrade', 'открыл квесты — дальше улучшения');
  c.set('activeTab = 1; _invTab = 1; player.upgrades.atk = 1;'); frame(c);
  ok(stepId(c) === 'equip', 'купил улучшение — дальше снаряжение');
  c.set('player.equipment.weapon = { uid: "w1", id: "sw1" };'); frame(c);
  ok(stepId(c) === 'skill', 'надел вещь — дальше навык');
  c.set('player.skillLevels.Q = 1;'); frame(c);
  ok(stepId(c) === 'level', 'изучил навык — дальше 10 уровень');
  c.set('player.lvl = 9;'); frame(c);
  ok(stepId(c) === 'level', '9 уровень — ещё нет');
  c.set('player.lvl = 10;'); frame(c);
  ok(stepId(c) === 'final', '10 уровень — финал');
  frame(c);
  ok(stepId(c) === 'final', 'финал не закрывается сам');
  c.get('tutAck()');
  ok(stepId(c) === 'off', '«В бой!» закрывает обучение');
  ok(JSON.parse(store.tut_v1_777).off === true, 'и это сохранено');

  const c3 = sandbox(store);
  c3.get('tutorialStart()');
  ok(stepId(c3) === 'off', 'пройденное обучение не возвращается после перезахода');
  c3.get('tutorialRestart()');
  ok(stepId(c3) === 'lang', '«Пройти обучение заново» начинает с первого шага');
}

// ── «Понятно» и «Пропустить» ───────────────────────────────────────────────
{
  const c = sandbox({});
  c.get('tutorialStart()');
  c.get('tutAck()');
  ok(stepId(c) === 'move', '«Понятно» проходит шаг с языком');
  c.get('tutAck()');
  ok(stepId(c) === 'move', 'у ходьбы «Понятно» нет — шаг остаётся');
  c.get('tutSkip()');
  ok(stepId(c) === 'move', 'первое «Пропустить» только спрашивает');
  c.get('tutSkip()');
  ok(stepId(c) === 'off', 'второе — пропускает');
}

// ── старый игрок ────────────────────────────────────────────────────────────
{
  const store = {};
  const c = sandbox(store);
  c.set('player.lvl = 35;');
  c.get('tutorialStart()');
  ok(stepId(c) === 'off', 'у игрока 35 уровня без сохранения обучение не всплывает');
  const other = sandbox(store);
  other.set('_tgUserId = () => "888";');
  other.get('tutorialStart()');
  ok(stepId(other) === 'lang', 'другой аккаунт на том же устройстве начинает своё обучение');
}

console.log(`\n  ${pass} пройшло, ${fail} впало`);
process.exit(fail ? 1 : 0);
