#!/usr/bin/env node
'use strict';
// ── Proof that the server will not put a player inside a wall ───────────────
//
//   node dev/walk-check.js
//
// No database and no sockets: a real Room on a real generated floor, driven
// through updatePlayerPos the way a client drives it. That is enough, because
// the bug being fixed is entirely about geometry the server already had and
// never consulted.

const path = require('path');
const Room = require(path.join(__dirname, '..', 'server', 'game', 'Room.js'));
const { FLOOR_IDS } = require(path.join(__dirname, '..', 'server', 'game', 'floors.js'));
const { TILE } = require(path.join(__dirname, '..', 'shared', 'definitions.js'));

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);

const io = { to: () => ({ emit() {} }), sockets: { sockets: new Map() } };

function main() {
  console.log('\nwalk-check\n');

  const room = new Room(FLOOR_IDS.left, io, {}, () => {});
  room._stopLoop();                       // no ticking needed, only the geometry

  // Find one open tile and one wall tile on the real generated floor.
  const grid = room._dungeon.grid;
  let openPt = null, wallPt = null, deepWallPt = null;
  const isWallT = (tx, ty) => room._isWall(tx * TILE + TILE / 2, ty * TILE + TILE / 2);
  for (let ty = 1; ty < grid.length - 1; ty++) {
    for (let tx = 1; tx < grid[ty].length - 1; tx++) {
      const px = tx * TILE + TILE / 2, py = ty * TILE + TILE / 2;
      if (!openPt && !isWallT(tx, ty)) openPt = { x: px, y: py };
      // A wall tile NEXT TO open floor — what a teleport landing on geometry
      // actually looks like. The first wall tile scanned from the corner is
      // deep inside a solid block at the map edge, and an earlier version of
      // this test used it, then reported the nudge as broken when it correctly
      // found nothing within its bound.
      if (!wallPt && isWallT(tx, ty) &&
          (!isWallT(tx + 1, ty) || !isWallT(tx - 1, ty) ||
           !isWallT(tx, ty + 1) || !isWallT(tx, ty - 1))) {
        wallPt = { x: px, y: py };
      }
      if (openPt && wallPt) break;
    }
    if (openPt && wallPt) break;
  }
  // And one genuinely deep inside a block, to check the bound holds.
  for (let ty = 2; ty < 12 && !deepWallPt; ty++) {
    for (let tx = 2; tx < 12; tx++) {
      if (isWallT(tx, ty) && isWallT(tx + 1, ty) && isWallT(tx - 1, ty) &&
          isWallT(tx, ty + 1) && isWallT(tx, ty - 1)) {
        deepWallPt = { x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 };
        break;
      }
    }
  }
  ok(openPt && wallPt, `на поверсі знайдено прохідний тайл і стіну біля відкритого простору`);

  // A player standing somewhere valid.
  room.players.set('s1', {
    socketId: 's1', x: openPt.x, y: openPt.y, hp: 100, maxHp: 100,
    facing: 'front', moving: false, _known: new Map(), _eKnown: new Map(),
    _projQ: [], _aoeQ: [], _seq: 1, _profileRev: 0,
  });
  const p = room.players.get('s1');

  // ── the fix ──────────────────────────────────────────────────────────────
  console.log('  ── рух у стіну ──');
  const res = room.updatePlayerPos('s1', wallPt.x, wallPt.y, 'front', true);
  ok(res && res.refused === 'wall', 'крок у стіну ВІДХИЛЕНО');
  eq(p.x, openPt.x, 'позиція не змінилась');
  eq(res.x, openPt.x, 'сервер повернув останню правильну позицію для корекції клієнта');

  // Legitimate movement still works — the guard must not be so strict that it
  // refuses ordinary play, which would be a worse bug than the one it fixes.
  let moved = 0;
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      const nx = openPt.x + dx * TILE, ny = openPt.y + dy * TILE;
      if (room._isWall(nx, ny)) continue;
      p.x = openPt.x; p.y = openPt.y;
      const r = room.updatePlayerPos('s1', nx, ny, 'front', true);
      if (!r && p.x === nx && p.y === ny) moved++;
    }
  }
  ok(moved > 0, `${moved} законних кроків по відкритих тайлах пройшли без відмов`);

  // ── the trap that must NOT happen ────────────────────────────────────────
  // Someone already inside a wall (from the old bug, or a bad teleport) must
  // be able to get out. Refusing them would pin them there forever — the same
  // bug, made permanent.
  console.log('  ── застряглий у стіні ──');
  p.x = wallPt.x; p.y = wallPt.y;
  const escape = room.updatePlayerPos('s1', openPt.x, openPt.y, 'front', true);
  ok(!escape, 'гравець, що вже в стіні, може вийти — його НЕ замкнули');
  eq(p.x, openPt.x, 'вийшов на відкритий тайл');

  p.x = wallPt.x; p.y = wallPt.y;
  const deeper = room.updatePlayerPos('s1', wallPt.x + TILE, wallPt.y, 'front', true);
  ok(!deeper, 'із стіни дозволено будь-який крок, навіть у сусідню стіну — інакше це пастка');

  // ── nudging a placement onto valid ground ────────────────────────────────
  console.log('  ── підсадка при телепорті/респавні ──');
  const nudged = room._nearestWalkable(wallPt.x, wallPt.y);
  ok(nudged, 'знайдено найближчий прохідний тайл до точки в стіні');
  ok(nudged && nudged.moved === true, 'позначено, що точку довелось зсунути');
  ok(nudged && !room._isWall(nudged.x, nudged.y), 'результат справді прохідний');
  const dist = nudged ? Math.hypot(nudged.x - wallPt.x, nudged.y - wallPt.y) : Infinity;
  ok(dist <= TILE * 8 * 1.5, `зсув ${Math.round(dist)}px — у межах 8 тайлів, не через пів карти`);

  const untouched = room._nearestWalkable(openPt.x, openPt.y);
  eq(untouched.moved, false, 'коректну точку не зсуває');
  eq(untouched.x, openPt.x, 'і не змінює координат');

  // Deep inside a block there is nothing to nudge TO within the bound, and
  // null is the right answer: relocating a player across half the map because
  // a destination was badly wrong would hide the real problem.
  if (deepWallPt) {
    eq(room._nearestWalkable(deepWallPt.x, deepWallPt.y, 2), null,
      'глибоко в стіні у межах 2 тайлів — null, а не переміщення через пів карти');
  } else {
    ok(true, 'глибокої стіни для перевірки не знайшлось — пропущено');
  }

  // ── malformed input still refused ────────────────────────────────────────
  console.log('  ── некоректні координати ──');
  p.x = openPt.x; p.y = openPt.y;
  room.updatePlayerPos('s1', NaN, openPt.y, 'front', true);
  ok(Number.isFinite(p.x), 'NaN не потрапив у позицію (це виводило гравця з сітки зовсім)');
  room.updatePlayerPos('s1', Infinity, openPt.y, 'front', true);
  eq(p.x, openPt.x, 'Infinity відхилено');

  room._stopLoop();
}

try { main(); } catch (err) { fail++; failures.push('НЕОБРОБЛЕНА ПОМИЛКА'); console.error('\n', err); }
console.log(`\n  ${pass} пройшло, ${fail} впало`);
if (failures.length) console.log('  впали: ' + failures.join(' · '));
process.exit(fail ? 1 : 0);
