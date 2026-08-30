#!/usr/bin/env node
'use strict';
// ── Сколько байт уезжает игроку и переживают ли их координаты дорогу ────────
//
//   node dev/netsize-check.js
//
// «Не можна це покращити, щоб було ідеально, 0 лагів?»
//
// Серверный тик оказался не при чём: 3.2мс из 25 при 68 онлайн, переборов ноль.
// А вот поток к игроку никто не мерил. Здесь он измеряется — настоящим кодеком,
// на сцене того же размера, что сейчас в игре.
//
// И заодно стережётся то, чем за это заплачено: позиция уехала с четырёх байт
// на два. Точность прежняя (половина пикселя), запас втрое — но если карта
// когда-нибудь вырастет за предел u16, координаты начнут заворачиваться, и
// игроки поедут в противоположный угол. Проверка ниже покраснеет раньше.
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { encodeGameState, decodeGameState } = require('../shared/netcodec');
const dungeon = require('../server/game/dungeon');

let pass = 0, fail = 0;
const ok = (c, name, got) => {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + name); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m  ' + name + (got !== undefined ? ' — ' + got : '')); }
};

// ── 1. координаты переживают дорогу ────────────────────────────────────────
console.log('\n  ── туда и обратно ──');
{
  const players = [
    { id: 's1', x: 0, y: 0, facing: 'front', hp: 10, maxHp: 100, pvpMode: false, atkSeq: 0,
      moving: false, username: 'a', clanName: null, clanIcon: 0 },
    { id: 's2', x: 10799.5, y: 10799.5, facing: 'back', hp: 55, maxHp: 900, pvpMode: true,
      atkSeq: 3, moving: true },
    { id: 's3', x: 1234.5, y: 5678, facing: 'left', hp: 1, maxHp: 2, pvpMode: false,
      atkSeq: 0, moving: false },
  ];
  const enemies = [
    { id: 'e1', idx: 1, eid: 'rat', x: 10800, y: 3, hp: 5, maxHp: 5, name: 'Крыса',
      color: '#888', size: 20, isBoss: false, aggro: true, aggroR: 200, spd: 40, rlvl: 3,
      atkAnimTimer: 0 },
    { id: 'e2', idx: 2, x: 0.5, y: 9999.5, hp: 3, aggro: false, atkAnimTimer: 0 },
  ];
  // ── порядок как в игре ───────────────────────────────────────────────────
  // Дельта моба несёт только номер (idx), а не строковый id: он экономит как
  // раз те байты, ради которых всё и делается. Декодер сопоставляет номер с id
  // по таблице, которую заполняют ПОЛНЫЕ записи. Поэтому сначала уезжает пакет
  // с полными, и лишь потом — с дельтами.
  //
  // Первый заход этого не сделал и объявил кодек сломанным: моб-дельта, чей
  // полной записи никто не присылал, честно отбрасывается (netCodecLostIdx).
  decodeGameState(encodeGameState([], enemies.map(e => ({
    ...e, eid: e.eid || 'rat', maxHp: e.maxHp || e.hp, name: e.name || 'x',
    color: e.color || '#fff', size: e.size || 10, isBoss: false,
    aggroR: e.aggroR || 0, spd: e.spd || 0, rlvl: e.rlvl || 0,
  })), Date.now(), undefined, [], []));

  const buf = encodeGameState(players, enemies, Date.now(), undefined, [], []);
  const out = decodeGameState(buf);
  const gotP = out.players || out.p || [];
  const gotE = out.enemies || out.e || [];
  ok(gotP.length === 3, 'все игроки доехали', gotP.length);
  ok(gotE.length === 2, 'все мобы доехали', gotE.length);
  for (let i = 0; i < players.length; i++) {
    const a = players[i], b = gotP[i] || {};
    ok(Math.abs(b.x - a.x) <= 0.5 && Math.abs(b.y - a.y) <= 0.5,
      `игрок ${i}: координаты целы (${a.x},${a.y} → ${b.x},${b.y})`);
  }
  for (let i = 0; i < enemies.length; i++) {
    const a = enemies[i], b = gotE[i] || {};
    ok(Math.abs(b.x - a.x) <= 0.5 && Math.abs(b.y - a.y) <= 0.5,
      `моб ${i}: координаты целы (${a.x},${a.y} → ${b.x},${b.y})`);
  }
}

// ── 1б. константы размера совпадают с настоящей записью ────────────────────
// Ровно это и сломалось при переходе на двухбайтовую позицию: запись стала
// короче, а условие цикла при ЧТЕНИИ осталось требовать прежние 19 и 17 байт —
// и последняя запись в пакете не проходила. Снаряды доезжали 10 из 10, кольца
// 9 из 10, стабильно каждый раз. Число, написанное в двух местах, рано или
// поздно разъедется; здесь оно сверяется с тем, что кодек делает на самом деле.
console.log('\n  ── размеры записей ──');
{
  const base = encodeGameState([], [], Date.now(), undefined, [], []).byteLength;
  const proj = encodeGameState([], [], Date.now(), undefined,
    [{ x: 1, y: 1, vx: 1, vy: 1, size: 4, life: 1, color: '#fff', projType: 'arrow', ageMs: 0 }],
    []).byteLength - base;
  const aoe = encodeGameState([], [], Date.now(), undefined, [],
    [{ x: 1, y: 1, r: 50, style: 'classic', color: '#fff', color2: '#000' }]).byteLength - base;

  const src = require('fs').readFileSync(path.join(ROOT, 'shared/netcodec.js'), 'utf8');
  // Привязано к САМОМУ циклу снарядов: без `i < pn &&` этот шаблон ловил
  // строкой выше `if (o + 2 <= dv.byteLength)` — проверку того, что секция
  // вообще есть, — и объявлял исправное чтение сломанным.
  const guardP = src.match(/i < pn && o \+ (NC_PROJ_B|\d+) <= dv\.byteLength/);
  const guardA = src.match(/i < an && o \+ (NC_AOE_B|\d+) <= dv\.byteLength/);
  ok(guardP && guardP[1] === 'NC_PROJ_B', 'чтение снарядов меряет запись константой, а не числом', guardP && guardP[1]);
  ok(guardA && guardA[1] === 'NC_AOE_B', 'чтение колец — тоже', guardA && guardA[1]);

  // И сама константа — та, что получается на деле.
  const mP = src.match(/const NC_PROJ_B = ([^;]+);/);
  const mA = src.match(/const NC_AOE_B\s*= ([^;]+);/);
  const NC_POS_B = 2;
  const evalC = (e) => Function('NC_POS_B', 'return ' + e)(NC_POS_B);
  ok(mP && evalC(mP[1]) === proj, `снаряд: константа ${mP && evalC(mP[1])} = запись ${proj} Б`);
  ok(mA && evalC(mA[1]) === aoe, `кольцо: константа ${mA && evalC(mA[1])} = запись ${aoe} Б`);
}

// ── 2. ни одна карта не выходит за предел ──────────────────────────────────
// Это и есть цена двухбайтовой позиции: она верна ровно до тех пор, пока самая
// большая карта помещается. Проверяется у КАЖДОЙ, а не у той, что вспомнили.
console.log('\n  ── карты помещаются в два байта ──');
{
  const LIMIT = 65535;      // потолок u16, в половинках пикселя
  let worst = { name: '-', half: 0 };
  const MAPS = ['generateHub', 'generateGuildWar', 'generateFarmZone', 'generateFarmZone2',
                'generateArena', 'generatePvpArena', 'generateRace10', 'generateFear',
                'generateCoop'];
  for (const fn of MAPS) {
    if (typeof dungeon[fn] !== 'function') continue;
    let m; try { m = dungeon[fn](); } catch { continue; }
    const half = Math.max(m.w, m.h) * dungeon.TILE * 2;
    if (half > worst.half) worst = { name: fn, half };
  }
  // Коридоры строятся с аргументами, поэтому берутся отдельно.
  for (let arm = 0; arm < 4; arm++) {
    let m; try { m = dungeon.generateArm(arm); } catch { continue; }
    const half = Math.max(m.w, m.h) * dungeon.TILE * 2;
    if (half > worst.half) worst = { name: 'generateArm(' + arm + ')', half };
  }
  ok(worst.half > 0, 'карты вообще построились', worst.half);
  ok(worst.half <= LIMIT,
    `самая большая карта помещается: ${worst.name} = ${worst.half} из ${LIMIT}`,
    `${worst.name} = ${worst.half} — позиции начнут заворачиваться`);
  // Запас, а не «впритык»: карта может подрасти между релизами.
  ok(worst.half <= LIMIT * 0.7,
    `и с запасом (занято ${Math.round(worst.half / LIMIT * 100)}%)`);
}

// ── 3. сколько это стоит в байтах ──────────────────────────────────────────
// Не утверждение, а измерение: печатается, чтобы в следующий раз спорить с
// числом, а не с ощущением.
console.log('\n  ── размер пакета ──');
{
  const mk = (n, full) => Array.from({ length: n }, (_, i) => ({
    id: 's' + i, x: 1000 + i * 13, y: 1000 + i * 7, facing: 'front', hp: 500, maxHp: 900,
    pvpMode: false, atkSeq: 0, moving: true,
    ...(full ? { username: 'player' + i, clanName: 'Clan', clanIcon: 3 } : {}),
  }));
  const mkE = (n) => Array.from({ length: n }, (_, i) => ({
    id: 'e' + i, idx: i, x: 900 + i * 11, y: 900 + i * 9, hp: 50, aggro: true, atkAnimTimer: 0,
  }));
  const one = (np, ne) => encodeGameState(mk(np, false), mkE(ne), Date.now(), undefined, [], []).byteLength;

  const busy = one(36, 40);
  const perSec = busy * 20;
  console.log(`      36 игроков + 40 мобов дельтами: ${busy} Б  ·  ${(perSec / 1024).toFixed(1)} КБ/с на игрока`);
  const one_p = one(2, 0) - one(1, 0);
  const one_e = one(1, 1) - one(1, 0);
  console.log(`      запись игрока ${one_p} Б  ·  запись моба ${one_e} Б`);
  // До сокращения было 18 и 17; позиция занимала по 4 байта на ось.
  ok(one_p <= 14, `запись игрока не больше 14 Б (было 18)`, one_p);
  ok(one_e <= 13, `запись моба не больше 13 Б (было 17)`, one_e);
}

console.log('');
console.log(fail === 0
  ? `  \x1b[32m${pass} пройшло, 0 впало\x1b[0m\n`
  : `  \x1b[31m${pass} пройшло, ${fail} впало\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
