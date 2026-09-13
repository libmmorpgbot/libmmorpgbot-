#!/usr/bin/env node
'use strict';
// ── Навыки эпических питомцев: бой, а не только значок ──────────────────────
//
//   node dev/petskill-check.js
//
// У Грута, Нёрба и Вилорда вместо постоянной прибавки — навык, который
// питомец применяет САМ раз в тридцать секунд. Это единственный навык в игре
// без нажатия, поэтому и проверять его приходится не «пришёл ли пакет», а
// тик комнаты: _petSkillTick (server/game/Room.js) с подставленными часами.
//
// Проверка родилась из того же разбора, что и dev/skillbuff-check.js: баф,
// который видно в панели и не видно в формуле урона, — это не баф. Поэтому
// множители читаются здесь через настоящие _atkOf/_defOf/_critPowerOf/
// _attackRate, а не сравниваются с числом из таблицы.
//
// Вторая половина — клиентская: описание навыка обязано появляться в карточке
// питомца (и в той, что открывают ДО покупки), а значок — среди бафов.
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const D = require(path.join(ROOT, 'shared/definitions'));
const Room = require(path.join(ROOT, 'server/game/Room.js'));
const R = (Room.Room || Room).prototype;

let pass = 0, fail = 0;
const ok = (c, n, got) => {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + n); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m  ' + n + (got !== undefined ? ' — ' + got : '')); }
};
const near = (a, b, n) => ok(Math.abs(a - b) < 1e-6, n, `ожидал ${b}, получил ${a}`);

// Комната-заглушка: только то, что читает тик и формулы бафа. Методы взяты с
// НАСТОЯЩЕГО прототипа — подменять их пересказом значило бы проверять пересказ.
const sent = [];
function mkRoom() {
  return {
    _petSkillTick: R._petSkillTick, _maxHpOf: R._maxHpOf,
    _buffOn: R._buffOn, _petBuffOn: R._petBuffOn,
    _atkOf: R._atkOf, _defOf: R._defOf, _critPowerOf: R._critPowerOf,
    _attackRate: R._attackRate, setPlayerPet: R.setPlayerPet,
    skillWindowsOf: R.skillWindowsOf, restoreSkillWindows: R.restoreSkillWindows,
    players: new Map(),
    io: { to: (sid) => ({ emit: (ev, data) => sent.push({ sid, ev, data }) }) },
  };
}
const mkPlayer = (petId) => ({
  socketId: 's1', petId, hp: 1000, maxHp: 2000, atk: 100, def: 50,
  critPower: 1.5, critChance: 0.1, atkSpeed: 1.0,
});

const PERIOD = D.PET_SKILL_PERIOD_MS, DUR = D.PET_SKILL_DUR_MS;
console.log(`\n  период ${PERIOD / 1000} с, окно ${DUR / 1000} с\n`);

// ── Грут ───────────────────────────────────────────────────────────────────
// Часы окна читает Date.now() (внутри _petBuffOn), поэтому и тик кормится
// настоящим временем: со сдвинутыми часами проверялся бы 1970 год.
console.log('  ── Грут: +30% атаки, +20% защиты ──');
{
  const room = mkRoom(); const p = mkPlayer('pet_groot'); room.players.set('s1', p);
  const T = Date.now();
  room._petSkillTick(p, T);
  ok(!room._petBuffOn(p), 'при появлении навык не срабатывает сразу');
  room._petSkillTick(p, T + PERIOD - 1);
  ok(!room._petBuffOn(p), 'за миллисекунду до срока — ещё нет');
  room._petSkillTick(p, T + PERIOD);
  ok(room._petBuffOn(p), 'ровно на сроке — сработал');
  near(room._atkOf(p), 130, 'атака 100 → 130');
  near(room._defOf(p), 60, 'защита 50 → 60');
  near(room._critPowerOf(p), 1.5, 'силу крита Грут не трогает');
  p._petBuffUntil = Date.now() - 1;
  near(room._atkOf(p), 100, 'после окна атака возвращается');
  ok(sent.some(m => m.ev === 'petSkill' && m.data.sec === DUR / 1000),
    'клиенту ушла длительность окна, а не своя догадка');
}

// ── Нёрб ───────────────────────────────────────────────────────────────────
console.log('\n  ── Нёрб: 30% здоровья ──');
{
  sent.length = 0;
  const room = mkRoom(); const p = mkPlayer('pet_nerb'); room.players.set('s1', p);
  const T = Date.now();
  room._petSkillTick(p, T);
  room._petSkillTick(p, T + PERIOD);
  ok(p.hp === 1600, 'вылечил 30% максимума: 1000 → 1600', p.hp);
  ok(!room._petBuffOn(p), 'боевого окна лечащий навык не открывает');
  ok(p._hpDirty === true, 'полоса помечена на отправку');
  const heal = sent.find(m => m.ev === 'skillHealTick');
  ok(heal && heal.data.amount === 600 && heal.data.kind === 'pet', 'цифра лечения ушла клиенту');
  const ps = sent.find(m => m.ev === 'petSkill');
  ok(ps && ps.data.sec === 0, 'sec = 0 — держать нечего');
  p.hp = p.maxHp;
  room._petSkillTick(p, T + PERIOD * 2);
  ok(p.hp === p.maxHp, 'при полном здоровье лечение ничего не ломает');
}

// ── Вилорд ─────────────────────────────────────────────────────────────────
console.log('\n  ── Вилорд: сила крита и скорость атаки ──');
{
  const room = mkRoom(); const p = mkPlayer('pet_vilord'); room.players.set('s1', p);
  const T = Date.now();
  room._petSkillTick(p, T);
  room._petSkillTick(p, T + PERIOD);
  near(room._critPowerOf(p), 1.8, 'сила крита 1.5 → 1.8');
  near(room._attackRate(p), 1.1, 'скорость атаки 1.0 → 1.1');
  near(room._atkOf(p), 100, 'атаку Вилорд не трогает');
}

// ── два источника ──────────────────────────────────────────────────────────
// Окно питомца отдельное от навычного намеренно: общее перезаписывается
// целиком, и питомец, срабатывающий каждые тридцать секунд, стирал бы
// «Щит» через мгновение после нажатия.
console.log('\n  ── навык игрока и навык питомца вместе ──');
{
  const room = mkRoom(); const p = mkPlayer('pet_groot'); room.players.set('s1', p);
  p._buffUntil = Date.now() + 60000; p._buffAtk = 1; p._buffDef = 1.8;
  p._buffCritChance = 0; p._buffCritPower = 0; p._buffHp = 1;
  const T = Date.now();
  room._petSkillTick(p, T);
  room._petSkillTick(p, T + PERIOD);
  ok(room._buffOn(p), 'баф игрока на месте, а не затёрт питомцем');
  near(room._defOf(p), 50 * 1.8 * 1.2, 'защита множится обоими: 50 → 108');
  near(room._atkOf(p), 130, 'атака — только питомцем');
}

// ── смерть и снятие ────────────────────────────────────────────────────────
console.log('\n  ── смерть и снятие ──');
{
  const room = mkRoom(); const p = mkPlayer('pet_groot'); room.players.set('s1', p);
  const T = Date.now();
  room._petSkillTick(p, T);
  p.hp = 0;
  room._petSkillTick(p, T + PERIOD);
  ok(!room._petBuffOn(p), 'мёртвому навык не применяется');
  p.hp = 100;
  room._petSkillTick(p, T + PERIOD * 2);
  ok(room._petBuffOn(p), 'воскрес — навык снова работает');
  room.setPlayerPet('s1', null);
  ok(!room._petBuffOn(p), 'снял питомца — баф ушёл вместе с ним');
  room._petSkillTick(p, T + PERIOD * 3);
  ok(p._petSkillAt === 0, 'без питомца часы сброшены');
}

// ── дверь ──────────────────────────────────────────────────────────────────
console.log('\n  ── переход между этажами ──');
{
  const a = mkRoom(); const p = mkPlayer('pet_groot'); a.players.set('s1', p);
  const T = Date.now();
  a._petSkillTick(p, T);
  a._petSkillTick(p, T + PERIOD);
  const w = a.skillWindowsOf('s1');
  ok(w && w.petBuffUntil > 0 && w.petSkillAt === T + PERIOD, 'окно и часы уезжают с игроком');
  const b = mkRoom(); const p2 = mkPlayer('pet_groot'); b.players.set('s1', p2);
  b.restoreSkillWindows('s1', w);
  ok(b._petBuffOn(p2), 'на новом этаже баф продолжается');
  near(b._atkOf(p2), 130, 'и продолжает считаться в бою');
  b._petSkillTick(p2, T + PERIOD + 1);
  ok(p2._petSkillAt === T + PERIOD, 'дверь не даёт применить навык заново');
}

// ── каталог ────────────────────────────────────────────────────────────────
console.log('\n  ── каталог ──');
for (const id of ['pet_groot', 'pet_nerb', 'pet_vilord']) {
  const it = D.ITEM_DEF.find(i => i.id === id);
  ok(!it.critPower && !it.atkSpeed && !it.atkPct,
    `${it.name}: постоянного бонуса больше нет (иначе он платил бы дважды)`);
  ok(it.hp === 1200 && it.atk === 100 && it.def === 100 && it.xpPct === 0.10,
    `${it.name}: основа не тронута`);
  const sk = D.petSkillOf(id);
  ok(!!sk, `${it.name}: навык описан`);
  ok(sk && fs.existsSync(path.join(ROOT, sk.img)), `${it.name}: иконка навыка лежит на месте — ${sk && sk.img}`);
}
{
  const bear = D.ITEM_DEF.find(i => i.id === 'pet_bear');
  ok(bear.hpPct === 0.15, 'у обычного питомца собственный бонус на месте');
  ok(!D.petSkillOf('pet_bear'), 'и навыка у него нет');
  ok(!D.petSkillOf('constructor'), 'прототипный ключ навыком не притворяется');
}

// ── клиент: описание и значок ──────────────────────────────────────────────
// _itemStatRows берётся ИЗ ФАЙЛА и запускается как есть: карточка предмета
// собирается ею в трёх местах, и «строка навыка появилась» — это про неё, а
// не про мой пересказ её содержимого.
console.log('\n  ── карточка предмета ──');
{
  const uiSrc = fs.readFileSync(path.join(ROOT, 'js/ui.js'), 'utf8');
  const m = uiSrc.match(/function _itemStatRows\(it, eb\) \{[\s\S]*?\n\}/);
  ok(!!m, 'функция строк карточки найдена');
  if (m) {
    const rows = new Function('t', 'petSkillOf', m[0] + '\n return _itemStatRows;')(
      (k) => k, D.petSkillOf);
    const groot = rows(D.ITEM_DEF.find(i => i.id === 'pet_groot')).join('\n');
    ok(/HP <b>\+1200<\/b>/.test(groot), 'основа питомца в карточке есть');
    ok(groot.includes('Каменная кора') && groot.includes('+30% к атаке'),
      'навык и его описание — в карточке');
    ok(groot.includes('/images/pet/pet_groot/skill.png'), 'и иконка навыка тоже');
    ok(!/Сила крита/.test(groot), 'старой постоянной строки силы крита больше нет');
    const bear = rows(D.ITEM_DEF.find(i => i.id === 'pet_bear')).join('\n');
    ok(!bear.includes('<img'), 'у питомца без навыка строки навыка нет');
  }

  // Значок среди бафов и множители в панели — по тексту файлов: эти куски
  // живут внутри функций отрисовки, которые в одиночку не запустить.
  ok(/chips\.push\(\{ kind:'img', img: _psk\.img/.test(uiSrc),
    'значок навыка встаёт в ряд бафов');
  ok(uiSrc.includes("if (chip.kind === 'img') ctx.drawImage(img, cx + 3, cy + 1, SZ - 6, SZ - 6);"),
    'и рисуется квадратом, а не пропорциями склянки');
  const playerSrc = fs.readFileSync(path.join(ROOT, 'js/player.js'), 'utf8');
  ok(playerSrc.includes('if (_petSk.atk) a = Math.floor(a * _petSk.atk);'),
    'панель множит атаку тем же числом, что и сервер');
  ok(playerSrc.includes('if (_petSk && _petSk.haste > 1) player.atkSpeed *= _petSk.haste;'),
    'и скорость атаки тоже');
  const gameSrc = fs.readFileSync(path.join(ROOT, 'js/game.js'), 'utf8');
  ok(/petSkillTimer -= realDt/.test(gameSrc), 'таймер идёт на realDt, как все бафы');
  const netSrc = fs.readFileSync(path.join(ROOT, 'js/network.js'), 'utf8');
  ok(/socket\.on\('petSkill'/.test(netSrc), 'клиент слушает событие навыка');
}

console.log('');
console.log(fail === 0
  ? `  \x1b[32m${pass} прошло, 0 упало\x1b[0m\n`
  : `  \x1b[31m${pass} прошло, ${fail} упало\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
