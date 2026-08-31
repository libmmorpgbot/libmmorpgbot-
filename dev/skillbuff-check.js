#!/usr/bin/env node
'use strict';
// ── Бафы навыков действуют на БОЙ, а не только на панель ────────────────────
//
//   node dev/skillbuff-check.js
//
// «Скилл на +20% к атаке не работает», «такое ощущение, как будто защиты нет
// вообще». Игрок измерил это точнее любого лога:
//
//   защита 319, моб с атакой 381 бьёт по 62
//   включает «+80% DEF», в панели 574 — моб бьёт те же 62
//
// Причина одна на всё семейство: множители жили в js/player.js, в recompute(),
// которая пересобирает player.atk и player.def для ОТРИСОВКИ. Урон считает
// сервер — пятью формулами, и ни одна из них о бафах не знала. То же самое уже
// находилось у лечения (skillHeal), у скорости атаки (skillHaste) и у
// регенерации; это последняя часть той же истории.
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const D = require('../shared/definitions');

let pass = 0, fail = 0;
const ok = (c, name, got) => {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + name); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m  ' + name + (got !== undefined ? ' — ' + got : '')); }
};
const eq = (a, b, n) => ok(a === b, n, `ожидал ${JSON.stringify(b)}, получил ${JSON.stringify(a)}`);

const Room = require(path.join(ROOT, 'server/game/Room.js'));
const R = (Room.Room || Room).prototype;
const room = {
  _buffOn: R._buffOn, _atkOf: R._atkOf, _defOf: R._defOf,
  _critChanceOf: R._critChanceOf, _critPowerOf: R._critPowerOf,
  players: new Map(),
};
const setWin = R.setSkillWindow;

// ── 1. измерение игрока, воспроизведённое ──────────────────────────────────
console.log('\n  ── защита под бафом ──');
{
  const p = { socketId: 's', def: 319, atk: 100 };
  room.players.set('s', p);
  const MOB_ATK = 381;
  const before = Math.max(1, MOB_ATK - room._defOf(p));
  eq(before, 62, 'без бафа моб с атакой 381 бьёт по 62 — как на видео');

  // «+80% DEF» Танка: та же таблица, по которой рисует панель.
  const b = D.skillBuffOf('lev', 'E', false);
  ok(!!b && b.def === 1.80, 'таблица знает про +80% защиты', b && b.def);
  setWin.call(room, 's', 'buff', 10000, b);

  eq(Math.round(room._defOf(p)), 574, 'защита в бою стала 574 — та же, что в панели');
  const after = Math.max(1, MOB_ATK - room._defOf(p));
  ok(after < before, `под бафом моб бьёт слабее (${before} → ${after})`,
    'урон не изменился — баф снова только в панели');
  eq(after, 1, 'атака 381 против защиты 574 не пробивает');
}

// ── 2. атака ───────────────────────────────────────────────────────────────
console.log('\n  ── атака под бафом ──');
{
  const p = { socketId: 'a', atk: 1000, def: 0 };
  room.players.set('a', p);
  eq(room._atkOf(p), 1000, 'без бафа — своя атака');
  const b = D.skillBuffOf('deathknight', 'E', false);      // Боевой клич, +20%
  ok(!!b && b.atk === 1.20, 'таблица знает про +20% атаки', b && b.atk);
  setWin.call(room, 'a', 'buff', 10000, b);
  eq(room._atkOf(p), 1200, 'под бафом атака в бою выросла на 20%');

  const adv = D.skillBuffOf('deathknight', 'E', true);     // Безумие, +25%
  setWin.call(room, 'a', 'buff', 10000, adv);
  eq(room._atkOf(p), 1250, 'продвинутая версия даёт 25%');
}

// ── 3. окно кончается ──────────────────────────────────────────────────────
// Баф, который не кончается, — это не баф, а прибавка к характеристике.
console.log('\n  ── окно ──');
{
  const p = { socketId: 'x', atk: 100, def: 100 };
  room.players.set('x', p);
  setWin.call(room, 'x', 'buff', 10000, { atk: 2 });
  eq(room._atkOf(p), 200, 'пока окно открыто — действует');
  p._buffUntil = Date.now() - 1;
  eq(room._atkOf(p), 100, 'как истекло — не действует');
  eq(room._defOf(p), 100, 'и защита тоже вернулась');
}

// ── 4. крит ────────────────────────────────────────────────────────────────
console.log('\n  ── крит ──');
{
  const p = { socketId: 'c', critChance: 0.30, critPower: 2.0 };
  room.players.set('c', p);
  eq(room._critChanceOf(p), 0.30, 'без бафа — свой шанс');
  setWin.call(room, 'c', 'buff', 10000, D.skillBuffOf('ranger', 'E', true));
  eq(Math.round(room._critChanceOf(p) * 100) / 100, 0.35, 'Баф Крит даёт +5%');
  setWin.call(room, 'c', 'buff', 10000, D.skillBuffOf('deathknight', 'W', true));
  eq(room._critPowerOf(p), 2.05, 'Жадность даёт +5% к силе крита');
  // Потолок тот же, что в repos/stats.js: иначе баф в связке с экипировкой
  // делает критом каждый удар.
  const hi = { socketId: 'h', critChance: 0.79, critPower: 2 };
  room.players.set('h', hi);
  setWin.call(room, 'h', 'buff', 10000, { critChance: 0.5 });
  eq(room._critChanceOf(hi), 0.80, 'выше 80% шанс крита не поднимается');
}

// ── 5. все пять формул урона спрашивают бафы ───────────────────────────────
// Одна пропущенная формула — это один вид боя, в котором баф снова не работает.
console.log('\n  ── все формулы урона ──');
{
  const src = fs.readFileSync(path.join(ROOT, 'server/game/Room.js'), 'utf8');
  ok(!/e\.atk - \(closest\.def \|\| 0\)/.test(src), 'моб по игроку: через _defOf');
  ok(!/attacker\.atk - \(target\.def \|\| 0\)/.test(src), 'PvP удар: через _atkOf/_defOf');
  ok(!/Math\.round\(attacker\.atk \* mult\) - \(target\.def \|\| 0\)/.test(src),
    'PvP навык: через _atkOf/_defOf');
  ok(!/const base = Math\.max\(1, attacker\.atk - _effDef /.test(src), 'игрок по мобу: через _atkOf');
  ok(!/\(attacker\.atk - _effDef2 /.test(src), 'навык по мобу: через _atkOf');
  // И ни одного крита мимо бафа.
  const raw = (src.match(/_critDmg\(base, attacker\.critChance/g) || []).length;
  eq(raw, 0, 'ни один крит не считается мимо бафа');
  eq((src.match(/_critDmg\(base, this\._critChanceOf\(attacker\)/g) || []).length, 4,
    'все четыре крита — через баф');
}

// ── 6. каждый бафающий навык говорит серверу ───────────────────────────────
// Множитель, о котором сервер не узнал, не существует.
console.log('\n  ── клиент сообщает о касте ──');
{
  const pl = fs.readFileSync(path.join(ROOT, 'js/player.js'), 'utf8');
  const TIMERS = ['advDkQAtkTimer', 'critDmgBuffTimer', 'madnessTimer', 'battleCryTimer',
                  'critChanceBuffTimer', 'guardTimer', 'faithShieldTimer', 'barrierTimer'];
  for (const t of TIMERS) {
    // Строка присвоения таймера и следующая за ней.
    const re = new RegExp(`${t} = [^;]+;\\s*\\r?\\n\\s*if \\(typeof netSkillBuff`);
    ok(re.test(pl), `${t}: сервер узнаёт о касте`);
  }
  const net = fs.readFileSync(path.join(ROOT, 'js/network.js'), 'utf8');
  ok(/socket\.emit\('skillBuff', \{ key: String\(key \|\| ''\) \}\)/.test(net),
    'по проводу уходит только клавиша — множитель клиент не называет');
  const soc = fs.readFileSync(path.join(ROOT, 'server/handlers2/social.js'), 'utf8');
  const h = soc.slice(soc.indexOf("safeOn('skillBuff'"), soc.indexOf("safeOn('skillBuff'") + 1600);
  ok(/skillBuffOf\(st\.charClass, k, adv\)/.test(h), 'сервер берёт множитель из общей таблицы');
  ok(/sk\.advSkillLearned\[k\] && sk\.advSkillActive\[k\]/.test(h),
    'и проверяет, изучена ли продвинутая версия');
}

// ── 7. Замок гильдий ───────────────────────────────────────────────────────
// «ПК то врубалось, то вырубалось», «при приближении к замку герои то
// пропадали, то появлялись», «при входе персонаж появляется в одной точке».
console.log('\n  ── замок гильдий ──');
{
  const src = fs.readFileSync(path.join(ROOT, 'server/game/Room.js'), 'utf8');

  // Замок как обычный моб резался по расстоянию — отсюда «моргание замка».
  ok(src.includes('if (e.isBoss || e.guildWar) { this._bossBuf.push(e); continue; }'),
    'замок виден на всём этаже, а не режется по расстоянию');

  // Радиус видимости игроков: 600 при ZOOM 0.75 — это ровно край широкого
  // экрана, поэтому игроки у края мигали.
  const m = src.match(/const PLAYER_AOI_R2 = (\d+) \* \d+;/);
  ok(!!m && Number(m[1]) >= 900, 'радиус видимости игроков покрывает широкий экран', m && m[1]);
  const g = src.match(/const GW_PLAYER_AOI_R2 = (\d+) \* \d+;/);
  ok(!!g && Number(g[1]) > Number(m[1]), 'на этаже войны — ещё шире', g && g[1]);
  ok(src.includes('this._playerAoiR2()'), 'и радиус спрашивается, а не берётся константой');

  // ПК внутри зоны — правило места, а не выбор игрока.
  ok(src.includes('if (!mode && p._guildWarZone) return;'),
    'выключить ПК внутри замка нельзя');
  ok(src.includes('nowInGw !== !!p._guildWarZone || p.pvpMode !== nowInGw'),
    'и он подтверждается каждый тик, а не только на границе');

  // ── точка входа в замок переехала в dev/spawn-check.js ─────────────────
  // Здесь стояло утверждение «вход — во все восемь точек кольца». Оно было
  // верным и стало неверным: восемь точек это 0.22% этажа, их выучили и у них
  // встали («один тіп крисить і вбиває»). Теперь вход — любая проходимая
  // плитка карты, и проверяется это там, где можно построить настоящую
  // комнату, а не заглушку из двух полей.
  //
  // Строка остаётся, чтобы следующий читатель не искал пропавшую проверку.
  ok(typeof R.randomStandPoint === 'function',
    'случайная точка входа живёт в комнате (подробности — dev/spawn-check.js)');
}

console.log('');
console.log(fail === 0
  ? `  \x1b[32m${pass} пройшло, 0 впало\x1b[0m\n`
  : `  \x1b[31m${pass} пройшло, ${fail} впало\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
