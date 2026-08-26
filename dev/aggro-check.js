#!/usr/bin/env node
'use strict';
// ── Does a monster behave differently the first time you arrive? ────────────
//
//   node dev/aggro-check.js
//
// Reported twice, in the same words:
//
//   "Монстры в начале не так реагируют как надо, но потом уже все нормально"
//   "перший раз як приходиш вони деякий час можуть не реагувати, потім
//    тепаються до тебе і потім вже нормально"
//
// Three claims, and each one is measurable: a delay before reacting, a jump in
// position, and a difference between a cold room and a warm one.
//
// It drives the Room DIRECTLY — no socket, no codec, no bot walking into
// walls. Two earlier versions of this file tried to answer the question by
// walking a client up to a monster, and both measured the map instead: the bot
// has no pathfinding, the arms are rooms off a corridor, and it spent 381 of
// 400 steps being refused by geometry. "The monsters never reacted" was true
// of the test, not of the game.
//
// What a Room cannot tell us is what the CLIENT draws. This settles whether
// the server's own AI has a cold-start problem; the wire and the screen are
// dev/reply-shape-check.js and dev/play-check.js's business.

const Room = require('../server/game/Room');
const { ENEMY_AOI_R } = require('../shared/definitions');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);

const TICK_MS = 25;
const io = { to: () => ({ emit: () => {} }), emit: () => {}, sockets: { sockets: new Map() } };

function join(room, sid) {
  room.addPlayer(sid, 'probe-' + sid, null, null, 0, '9' + sid, null);
  room.setPlayerChar(sid, 'deathknight');
  room.setPlayerStats(sid, {
    level: 40, atk: 120, def: 40, maxHp: 900,
    critChance: 0, critPower: 1.5, atkSpeed: 1, hpRegen: 0, skillPct: 1,
  });
  room.setPlayerHp(sid, 900);
  return room.players.get(sid);
}

// Stand a player next to a monster and run the room's own tick loop by hand.
// Returns when it noticed, when it first landed a hit, and the largest single
// tick of movement any enemy made.
function encounter(room, sid, enemy, ticks = 600) {
  const p = room.players.get(sid);
  p.x = enemy.x + 40;
  p.y = enemy.y;
  enemy.aggro = false;
  enemy._targetId = null;
  enemy._cachedTarget = null;

  const hp0 = p.hp;
  const prev = new Map();
  let aggroTick = null, hitTick = null, jump = 0, jumper = null;
  for (let i = 0; i < ticks; i++) {
    room._lastTick = Date.now() - TICK_MS;
    room._tick();
    if (aggroTick === null && enemy.aggro) aggroTick = i;
    if (hitTick === null && p.hp < hp0) hitTick = i;
    // A monster cannot move further in one tick than its own speed allows.
    // Anything larger is a position that jumped rather than travelled, which
    // is the "тепаються" half of the report.
    for (const e of room.enemies) {
      if (e.hp <= 0) continue;
      const was = prev.get(e.id);
      if (was) {
        const d = Math.hypot(e.x - was.x, e.y - was.y);
        const allowed = (e.spd || 120) * (TICK_MS / 1000) + 1;
        if (d > allowed && d > jump) { jump = d; jumper = e; }
      }
      prev.set(e.id, { x: e.x, y: e.y });
    }
  }
  return {
    aggroMs: aggroTick === null ? null : aggroTick * TICK_MS,
    hitMs: hitTick === null ? null : hitTick * TICK_MS,
    jump: Math.round(jump),
    jumper: jumper && { id: jumper.id, spd: jumper.spd },
    damage: hp0 - p.hp,
  };
}

function main() {
  console.log('\naggro-check\n');

  // ── a room whose loop has never run ──────────────────────────────────────
  console.log('  ── холодна кімната ──');
  const room = new Room(2, io, {}, null);
  ok(room.enemies.length > 0, `поверх згенеровано (${room.enemies.length} ворогів)`);

  join(room, 'a');
  const target = room.enemies.find(e => e.hp > 0 && !e.isBoss && !e.farmZone && !e.farmZone2);
  ok(!!target, 'знайшовся звичайний монстр');

  const cold = encounter(room, 'a', target);
  console.log(`    агро ${cold.aggroMs}мс, перший удар ${cold.hitMs}мс, шкода ${cold.damage}`);
  ok(cold.aggroMs !== null && cold.aggroMs <= 100,
    `монстр помічає гравця одразу (${cold.aggroMs}мс)`);
  ok(cold.hitMs !== null && cold.hitMs <= 3000, `і встигає вдарити (${cold.hitMs}мс)`);
  ok(cold.damage > 0, `шкода реальна (${cold.damage})`);

  // ── the same room after it emptied and filled again ──────────────────────
  // The loop stops when the last player leaves and starts again for the next
  // one. Everything the enemies were doing is frozen in between: mid-chase
  // positions, a target id belonging to a socket that no longer exists, an
  // attack timer part-way down. If a cold start behaved differently, this is
  // where it would show.
  console.log('\n  ── та сама кімната після простою ──');
  room.removePlayer('a');
  eq(room.players.size, 0, 'кімната спорожніла — цикл зупинено');

  // Aggro'd, chasing a socket that no longer exists — the state an idle room
  // really holds. Positions are left alone on purpose: an earlier version
  // shifted every enemy 60px to simulate "mid-chase" and pushed some of them
  // inside geometry, which broke line of sight and made the test report that
  // monsters had stopped noticing anyone. That was the shove, not the game.
  let dirtied = 0;
  for (const e of room.enemies) {
    if (e.hp <= 0 || e.isBoss) continue;
    e.aggro = true;
    e._targetId = 'ghost';
    e._cachedTarget = null;
    dirtied++;
  }
  console.log(`    ${dirtied} монстрів лишились «в погоні» за гравцем, якого вже нема`);

  join(room, 'b');
  const target2 = room.enemies.find(e => e.hp > 0 && !e.isBoss && !e.farmZone && !e.farmZone2);
  const warm = encounter(room, 'b', target2);
  console.log(`    агро ${warm.aggroMs}мс, перший удар ${warm.hitMs}мс, шкода ${warm.damage}`);

  ok(warm.aggroMs !== null && warm.aggroMs <= 100,
    `після простою монстр так само помічає одразу (${warm.aggroMs}мс)`);
  ok(warm.hitMs !== null && warm.hitMs <= 3000, `і бʼє (${warm.hitMs}мс)`);
  ok(cold.aggroMs !== null && warm.aggroMs !== null
     && Math.abs(cold.aggroMs - warm.aggroMs) <= 200,
    `перший прихід не відрізняється від наступного (${cold.aggroMs}мс проти ${warm.aggroMs}мс)`);

  // ── nothing teleports while somebody is standing there ───────────────────
  // A leash reset DOES send an enemy home, deliberately — but only one with no
  // eligible target. With a player right there, nothing may jump.
  console.log('\n  ── без телепортів ──');
  ok(cold.jump === 0,
    `холодна кімната: жоден монстр не стрибнув${cold.jumper ? ` (${cold.jumper.id} на ${cold.jump}px при spd ${cold.jumper.spd})` : ''}`);
  ok(warm.jump === 0,
    `після простою: жоден монстр не стрибнув${warm.jumper ? ` (${warm.jumper.id} на ${warm.jump}px при spd ${warm.jumper.spd})` : ''}`);

  // ── what the client is told on arrival ───────────────────────────────────
  // The snapshot is the client's entire picture until the first delta arrives.
  // Every entry has to be inside the same interest radius the live stream
  // uses: anything beyond it is drawn once and never updated again, so it
  // stands frozen wherever the snapshot left it — and jumps when the player
  // finally walks close enough for the stream to pick it up.
  console.log('\n  ── знімок при вході ──');
  const p = room.players.get('b');
  const snap = room.enemySnapshot('b');
  const outside = snap.filter(e => !e.isBoss
    && Math.hypot(e.x - p.x, e.y - p.y) > ENEMY_AOI_R);
  console.log(`    ${snap.length} ворогів у знімку, радіус інтересу ${ENEMY_AOI_R}px`);
  // AN EMPTY SNAPSHOT PASSES BOTH ASSERTIONS BELOW: nothing is outside the
  // radius when there is nothing at all, and `0 >= 0` holds. And an empty
  // snapshot is the exact failure they are here to catch — a player arriving
  // on a floor and being told about no monsters is what "монстры багнутые"
  // looked like from the inside. The count printed a line above was never a
  // condition for anything, so it is one now.
  ok(snap.length > 0, `знімок непорожній (${snap.length} ворогів) — інакше перевіряти нічого`);
  eq(outside.length, 0, 'у знімку немає нікого поза радіусом, кого потік ніколи не оновить');

  const known = p._eKnown.size;
  ok(known >= snap.length && known > 0,
    `сервер запамʼятав, що вже надіслав (${known} записів на ${snap.length} у знімку)`);

  room._stopLoop();
  console.log(`\n  ${pass} пройшло, ${fail} впало`);
  if (failures.length) console.log(`  впали: ${failures.join(', ')}`);
  process.exit(fail ? 1 : 0);
}

main();
