#!/usr/bin/env node
'use strict';
// ── Can the client decode the first world packet it gets? ───────────────────
//
//   node dev/stream-check.js
//
// The world stream is binary and names enemies by a small numeric handle. The
// handle→id mapping is established only by a FULL entry in that stream, and
// the client clears the mapping on every gameStart — handles belong to the
// room it just left.
//
// So there is one rule, and nothing else in the codebase states it:
//
//   THE FIRST CAST AFTER A PLAYER ARRIVES MUST CARRY FULL ENTRIES.
//
// Break it and the failure is silent in both directions. The server believes
// it is sending updates. The decoder skips every entry whose handle it cannot
// resolve — no error, no gap, no resync request, because the client is not
// missing the enemy, it has one from the JSON snapshot. The monsters simply
// stand where the snapshot left them, take no visible damage, react to
// nothing, and pop into place one by one as ENEMY_REFRESH_CASTS comes round —
// 1200 casts, once a minute.
//
// That was the bug. This is the test that would have caught it: decode what
// the server actually sends, from the state a freshly-arrived client is in.

const Room = require('../server/game/Room');
const { encodeGameState, decodeGameState, resetNetCodecMaps } = require('../shared/netcodec');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);

const io = { to: () => ({ emit: () => {} }), emit: () => {}, sockets: { sockets: new Map() } };

function join(room, sid) {
  room.addPlayer(sid, 'p' + sid, null, null, 0, '9' + sid, null);
  room.setPlayerChar(sid, 'deathknight');
  room.setPlayerStats(sid, {
    level: 40, atk: 120, def: 40, maxHp: 900,
    critChance: 0, critPower: 1.5, atkSpeed: 1, hpRegen: 0, skillPct: 1,
  });
  room.setPlayerHp(sid, 900);
  return room.players.get(sid);
}

// One cast for one player, exactly as _tick builds it, and the bytes that
// would go down the socket.
function castFor(room, sid, castId) {
  const p = room.players.get(sid);
  room._rebuildEnemyGrid();
  const out = [];
  room._collectEnemiesFor(p, out, castId);
  const buf = encodeGameState([], out, Date.now(), undefined, [], []);
  return { entries: out, buf };
}

function main() {
  console.log('\nstream-check\n');

  const room = new Room(2, io, {}, null);
  const p = join(room, 'a');
  // Stand where the monsters are, so the interest radius holds a real crowd.
  const anchor = room.enemies.find(e => e.hp > 0 && !e.isBoss);
  p.x = anchor.x; p.y = anchor.y;

  // ── what a client does on arrival ────────────────────────────────────────
  console.log('  ── прихід на поверх ──');
  const snap = room.enemySnapshot('a');
  ok(snap.length > 0, `знімок несе ${snap.length} ворогів`);
  ok(snap.every(e => e.eid !== undefined && e.id !== undefined),
    'кожен запис у знімку повний — з id та eid');

  // The client clears its handle map here, because handles belong to the room
  // it just left. This line IS the client's gameStart handler.
  resetNetCodecMaps();

  // ── the first cast after that ────────────────────────────────────────────
  const first = castFor(room, 'a', 2);
  ok(first.entries.length > 0, `перший каст несе ${first.entries.length} записів`);

  const full = first.entries.filter(e => e.eid !== undefined);
  eq(full.length, first.entries.length,
    'усі записи першого касту — повні (інакше клієнт не звʼяже handle з id)');

  const decoded = decodeGameState(first.buf);
  eq(decoded.enemies.length, first.entries.length,
    'декодер прочитав рівно стільки ж, скільки надіслано');
  ok(decoded.enemies.every(e => typeof e.id === 'string' && e.id.length > 0),
    'у кожного розшифрованого ворога є справжній id, а не втрачений handle');

  // ── and the casts after THAT are deltas, as designed ─────────────────────
  // The point of the fix is not "send everything always" — it is "send
  // everything ONCE, at the moment the client has nothing to resolve handles
  // with". If this stopped being true the stream would go back to ~960KB a
  // login, which is what the AOI work removed.
  console.log('\n  ── далі — дельти ──');
  const anyEnemy = room.enemies.find(e => e.hp > 0 && !e.isBoss);
  anyEnemy.x += 3;                                   // something to report
  const second = castFor(room, 'a', 4);
  const secondFull = second.entries.filter(e => e.eid !== undefined);
  ok(secondFull.length < first.entries.length,
    `другий каст уже не повний (${secondFull.length} повних з ${second.entries.length})`);
  const d2 = decodeGameState(second.buf);
  ok(d2.enemies.every(e => typeof e.id === 'string' && e.id.length > 0),
    'і дельти теж розшифровуються — handle вже відомий');

  // ── the same, on a floor CHANGE ──────────────────────────────────────────
  // Not just first login: every portal does this. The client resets its map
  // on each gameStart, so each arrival needs its own full cast.
  console.log('\n  ── перехід на інший поверх ──');
  const room2 = new Room(3, io, {}, null);
  room.removePlayer('a');
  const p2 = join(room2, 'a');
  const anchor2 = room2.enemies.find(e => e.hp > 0 && !e.isBoss);
  p2.x = anchor2.x; p2.y = anchor2.y;

  room2.enemySnapshot('a');
  resetNetCodecMaps();                               // the client's gameStart
  const afterPortal = castFor(room2, 'a', 2);
  const fullAfter = afterPortal.entries.filter(e => e.eid !== undefined);
  eq(fullAfter.length, afterPortal.entries.length,
    'після переходу перший каст теж повний');
  const d3 = decodeGameState(afterPortal.buf);
  ok(d3.enemies.length > 0 && d3.enemies.every(e => typeof e.id === 'string'),
    `і читається (${d3.enemies.length} ворогів)`);

  room._stopLoop(); room2._stopLoop();
  console.log(`\n  ${pass} пройшло, ${fail} впало`);
  if (failures.length) console.log(`  впали: ${failures.join(', ')}`);
  process.exit(fail ? 1 : 0);
}

main();
