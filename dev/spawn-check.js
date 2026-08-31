#!/usr/bin/env node
'use strict';
// ── Где появляется игрок ────────────────────────────────────────────────────
//
//   node dev/spawn-check.js
//
// «Ти телепорти наробив рандомні місця всюди де не треба, крім того місця де
// треба — це в замку гільдій.»
//
// Владелец прав в обе стороны, и причины разные.
//
// ЗАМОК ГИЛЬДИЙ. Случайность БЫЛА и умирала через десять строк: addPlayer
// честно выбирал точку, а вход на этаж тут же перезаписывал её статическим
// спавном. Одна и та же плитка на каждый вход — одна из трёх с половиной
// тысяч проходимых. Её выучили и у неё встали: «один тіп крисить і вбиває».
//
// РЕЖИМЫ. Обратное: игрок входил на этаж на статический спавн (это вход ЧУЖОЙ
// полосы), и лишь потом развёртывание двигало его к себе. Пока клиент грузил
// карту нового этажа, он слал свою ПРЕЖНЮЮ позицию — а координаты хаба
// оказываются полом и в Сотрудничестве, и в Элитной зоне. Сервер их принимал.
// Отсюда «спавнишся не в тій кімнаті, там мобів нема, а в інакшій є».
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

let pass = 0, fail = 0;
const ok = (c, name, got) => {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + name); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m  ' + name + (got !== undefined ? ' — ' + got : '')); }
};

const Room = require('../server/game/Room');
const { FLOOR_IDS } = require('../server/game/floors');
const fakeIo = { to: () => ({ emit: () => {} }), emit: () => {}, sockets: { sockets: new Map() } };
const mkRoom = (floor) => new Room(floor, fakeIo, {}, null);

// ── 1. замок гильдий: точка каждый раз новая ───────────────────────────────
console.log('\n  ── замок гильдий ──');
{
  const room = mkRoom(FLOOR_IDS.guildWar);
  const gw = room._dungeon.guildWar;
  const pad = room._dungeon.returnPad;

  let walkable = 0;
  for (let y = 0; y < room._dungeon.h; y++) {
    for (let x = 0; x < room._dungeon.w; x++) {
      if (room.canStandAt(x * 40 + 20, y * 40 + 20)) walkable++;
    }
  }

  const N = 1000;
  const seen = new Map();
  let inWall = 0, nearCastle = 0, nearPad = 0;
  for (let i = 0; i < N; i++) {
    const p = room.spawnPointFor();
    const k = p.x + ',' + p.y;
    seen.set(k, (seen.get(k) || 0) + 1);
    if (!room.canStandAt(p.x, p.y)) inWall++;
    if (gw && Math.hypot(p.x - gw.cx, p.y - gw.cy) < 320) nearCastle++;
    if (pad && Math.hypot(p.x - pad.x, p.y - pad.y) < 160) nearPad++;
  }
  const worst = Math.max(...seen.values());
  console.log(`      проходимых плиток ${walkable} · ${N} входов -> ${seen.size} различных точек`
    + ` · самая частая ${worst} раз`);

  ok(seen.size >= 300, `точек много, а не одна (${seen.size} из ${N})`, String(seen.size));
  ok(worst <= 20, `ни одна не повторяется часто (максимум ${worst})`, String(worst));
  ok(inWall === 0, 'ни одна не в стене', String(inWall));
  ok(nearCastle === 0, 'ни одна не вплотную к замку', String(nearCastle));
  ok(nearPad === 0, 'ни одна не на паде возврата — иначе мгновенный выход', String(nearPad));
  ok(room.randomEntry === true, 'этаж помечен как со случайным входом');

  // И то, из-за чего случайность не доживала до игрока.
  const w = fs.readFileSync(path.join(ROOT, 'server/world.js'), 'utf8');
  ok(/const entry = room\.spawnPointFor\(\)/.test(w),
    'вход на этаж спрашивает точку у КОМНАТЫ, а не берёт статический спавн');
  ok(/const useStored = !room\.randomEntry/.test(w),
    'и не восстанавливает хранёную позицию там, где вход случайный');
  ok(!/const spawn = at \|\| room\._nearestWalkable\(room\._dungeon\.spawn\.x/.test(w),
    'статический спавн больше не затирает выбор комнаты');
}

// ── 2. обычные этажи случайности НЕ получили ───────────────────────────────
// Владелец прямо об этом и говорит: рандом нужен ровно в замке.
console.log('\n  ── и только там ──');
{
  for (const [name, id] of [['хаб', FLOOR_IDS.hub], ['коридор', FLOOR_IDS.left],
                            ['Сотрудничество', FLOOR_IDS.coop], ['Страх', FLOOR_IDS.fear]]) {
    const r = mkRoom(id);
    const a = r.spawnPointFor(), b = r.spawnPointFor();
    ok(a.x === b.x && a.y === b.y && a.x === r._dungeon.spawn.x,
      `${name}: точка входа постоянная`, `${a.x},${a.y} против ${b.x},${b.y}`);
    ok(r.randomEntry !== true, `${name}: хранёная позиция восстанавливается как прежде`);
  }
}

// ── 3. в режимы входят СРАЗУ в свою точку ──────────────────────────────────
// Правило: игрок входит на этаж туда, где будет стоять. Иначе он сперва
// оказывается на статическом спавне — а это вход чужой полосы, — и всё, что
// успевает прочитать позицию в этом промежутке, называет чужую комнату.
console.log('\n  ── вход сразу в свою комнату ──');
{
  const coop = mkRoom(FLOOR_IDS.coop);
  const e0 = coop.coopLaneEntry(0), e1 = coop.coopLaneEntry(1);
  ok(!!e0 && !!e1, 'точки входа обеих полос известны ДО развёртывания');
  ok(e0.y !== e1.y, `полосы стоят в разных комнатах (${e0.y} против ${e1.y})`);
  ok(e0.x === coop._dungeon.spawn.x && e0.y === coop._dungeon.spawn.y,
    'статический спавн этажа — это вход полосы 0, то есть чужой для второго');

  // Развёртывание отдаёт ровно ту полосу, которую назвал вызывающий.
  coop.addPlayer('A', 'А', null, 0, 0, '1', null);
  coop.addPlayer('B', 'Б', null, 0, 0, '2', null);
  const s1 = coop.coopDeploy('A', 0), s2 = coop.coopDeploy('B', 1);
  ok(s1 && s1.lane === 0, 'первому досталась запрошенная полоса 0', s1 && String(s1.lane));
  ok(s2 && s2.lane === 1, 'второму — запрошенная полоса 1', s2 && String(s2.lane));
  ok(s2 && s2.x === e1.x && s2.y === e1.y,
    'и он стоит там же, куда его впустили', s2 && `${s2.x},${s2.y} против ${e1.x},${e1.y}`);
  if (coop._stopLoop) coop._stopLoop();

  const fear = mkRoom(FLOOR_IDS.fear);
  const fe = fear.fearLaneEntry(0);
  ok(!!fe, 'у Страха точка входа известна');
  const farm2 = mkRoom(FLOOR_IDS.farmZone2);
  const f2 = farm2.farm2Entry();
  ok(!!f2, 'у Элитной зоны тоже');
  ok(Math.hypot(f2.x - farm2._dungeon.returnPad.x, f2.y - farm2._dungeon.returnPad.y) < 400,
    'и она рядом с порталом — «кидало не с места, где портал»');
  if (fear._stopLoop) fear._stopLoop();
  if (farm2._stopLoop) farm2._stopLoop();

  // Три места, где вход обязан называть точку.
  const coopSrc = fs.readFileSync(path.join(ROOT, 'server/handlers2/coop.js'), 'utf8');
  const modesSrc = fs.readFileSync(path.join(ROOT, 'server/handlers2/modes.js'), 'utf8');
  ok(/coopLaneEntry\(LANE_MEMBER\)/.test(coopSrc) && /coopLaneEntry\(LANE_LEADER\)/.test(coopSrc),
    'Сотрудничество впускает каждого в свою полосу');
  ok(/pos: farm2Room\.farm2Entry\(\)/.test(coopSrc), 'Элитная зона — в точку у портала');
  ok(/pos: fearRoom\.fearLaneEntry\(0\)/.test(modesSrc), 'Страх — в зал');
}

// ── 4. предохранитель: прежние координаты не принимаются ───────────────────
// Клиент на новом этаже несколько секунд живёт на СТАРОЙ карте и всё это время
// шлёт прежнюю позицию. Если она случайно попадает на пол новой карты, её
// принимали и уже никогда не исправляли.
console.log('\n  ── прежние координаты не принимаются ──');
{
  const room = mkRoom(FLOOR_IDS.coop);
  room.addPlayer('S', 'Проверка', null, 0, 0, '1', null);
  const spot = room.coopDeploy('S', 1);
  const p = room.players.get('S');
  ok(!!spot && p._entryGuardUntil > Date.now(), 'развёртывание отметило точку постановки');

  // Координаты спавна хаба — на сетке Сотрудничества это ПОЛ, и раньше их
  // принимали.
  const hub = mkRoom(FLOOR_IDS.hub)._dungeon.spawn;
  ok(room.canStandAt(hub.x, hub.y),
    `координаты хаба (${hub.x},${hub.y}) на этой сетке — пол, то есть ловушка настоящая`);
  const res = room.updatePlayerPos('S', hub.x, hub.y, 'front', true);
  ok(res && res.refused === 'entry', 'пакет с прежнего этажа отклонён', JSON.stringify(res));
  ok(p.x === spot.x && p.y === spot.y, 'игрок остался там, куда его поставил сервер',
    `${p.x},${p.y} против ${spot.x},${spot.y}`);

  // А честный шаг проходит.
  const step = room.updatePlayerPos('S', spot.x + 40, spot.y, 'right', true);
  ok(!step || step.refused !== 'entry', 'обычный шаг не отклоняется', JSON.stringify(step));

  // ── и БЕГ ПО ПРЯМОЙ внутри окна тоже ────────────────────────────────────
  // Первый заход мерил расстояние от точки постановки, и на своих же ногах
  // пятьсот пикселей набегаются за три секунды при окне в восемь. Человек
  // входил на этаж, бежал прямо — и его дёргало назад: «при бігу ривки».
  //
  // Сто шагов по десять пикселей: тысяча пикселей от входа, но каждый шаг
  // честный. Ни один не должен быть отклонён.
  let refusedRun = 0;
  let rx = room.players.get('S').x;
  for (let i = 0; i < 100; i++) {
    rx += 10;
    const r = room.updatePlayerPos('S', rx, spot.y, 'right', true);
    if (r && r.refused === 'entry') refusedRun++;
  }
  const ranTo = room.players.get('S');
  ok(refusedRun === 0,
    `бег по прямой внутри окна не отклоняется ни разу (${Math.round(rx - spot.x)}px от входа)`,
    `отклонено пакетов: ${refusedRun}`);
  ok(Math.abs(ranTo.x - rx) < 1, 'и игрок действительно там, куда добежал',
    `${ranTo.x} против ${rx}`);

  // ── спор с клиентом ограничен ────────────────────────────────────────────
  // Первый заход отказывал все восемь секунд. Клиент бежал, серверная позиция
  // стояла, расстояние росло с каждым пакетом — 881, 888, 895, 902 — и так
  // 1286 раз за двенадцать часов. Каждый отказ это рывок на экране живого
  // человека: «біжиш і є фрізи».
  //
  // Теперь предохранитель сдаётся: либо клиент прислал честный пакет, либо
  // отказов набралось столько, что спорить дальше вреднее.
  {
    const r2 = mkRoom(FLOOR_IDS.coop);
    r2.addPlayer('Z', 'Упрямый', null, 0, 0, '9', null);
    const sp2 = r2.coopDeploy('Z', 1);
    // Клиент, который НЕ подчиняется: шлёт прежние координаты и уходит дальше.
    let bad = 0, gx = hub.x;
    for (let i = 0; i < 40; i++) {
      gx += 7;
      const r = r2.updatePlayerPos('Z', gx, hub.y, 'right', true);
      if (r && r.refused === 'entry') bad++;
    }
    console.log(`      упрямый клиент: отклонено ${bad} пакетов из 40`);
    ok(bad <= 6, `спор ограничен (${bad} отказов, не 40)`, String(bad));
    ok(bad >= 1, 'но первые пакеты всё-таки отклонены — иначе защиты нет');
    if (r2._stopLoop) r2._stopLoop();
  }
  if (room._stopLoop) room._stopLoop();
}

// ── мёртвый игрок пропадает с чужих экранов ────────────────────────────────
// «Коли хтось помирає, він має пропадати.»
//
// Труп игрока оставался в потоке НАВСЕГДА: поток отбирает по расстоянию и по
// полосе, а живой он или нет — не спрашивал никто. Чужие экраны рисовали его
// стоящим с нулём здоровья до самого перерождения.
//
// Пропадает не сразу: пока идёт анимация падения, тело нужно — иначе человек
// не умирает, а мгновенно исчезает, и никто не понимает, что случилось.
console.log('\n  ── мёртвый игрок ──');
{
  const room = mkRoom(FLOOR_IDS.hub);
  room.addPlayer('D', 'Умрёт', null, 0, 0, '7', null);
  const d = room.players.get('D');
  ok(!d._diedAt, 'пока жив — момента смерти нет');
  room.setPlayerHp('D', 0);
  ok(d._diedAt > 0, 'смерть отмечена временем, а не флагом — по нему считается анимация');
  room.setPlayerHp('D', 50);
  ok(!d._diedAt, 'воскрес — отметка снята, иначе он пропал бы живым');

  // И само правило в потоке.
  const src = fs.readFileSync(path.join(ROOT, 'server/game/Room.js'), 'utf8');
  ok(/op\.hp <= 0 && op\._diedAt && Date\.now\(\) - op\._diedAt > PLAYER_CORPSE_MS/.test(src),
    'поток перестаёт слать труп после анимации');
  const ms = (src.match(/const PLAYER_CORPSE_MS = (\d+)/) || [])[1];
  ok(Number(ms) >= 800 && Number(ms) <= 3000,
    `тело держится на экране ${ms}мс — хватает на падение и не превращается в памятник`, ms);
  if (room._stopLoop) room._stopLoop();
}

console.log('');
console.log(fail === 0
  ? `  \x1b[32m${pass} пройшло, 0 впало\x1b[0m\n`
  : `  \x1b[31m${pass} пройшло, ${fail} впало\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
