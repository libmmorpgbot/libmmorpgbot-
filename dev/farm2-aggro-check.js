#!/usr/bin/env node
'use strict';
// ── Фарм зона 2: монстры агрессивные ────────────────────────────────────────
//
//   node dev/farm2-aggro-check.js
//
// Заказ: «Сделай в фарм зоне 2 монстров агрессивными». «Фарм зона 2» у
// игроков — этаж farmHigh (пад в хабе, farmHighLbl) и его сезонное крыло
// farmHighSeason, а НЕ farmZone2 — та Элитная фарм-зона для групп.
//
// Игрок встаёт в 40 px от монстра и ничего не делает; крутим тики комнаты.
//   * farmHigh / farmHighSeason — монстр сам бросается и бьёт;
//   * farmZone (первая) и farmZone2 (Элитная) — по-прежнему стоят, пока их
//     не ударили.

const Room = require('../server/game/Room');
const { FLOOR_IDS } = require('../server/game/floors');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const TICK_MS = 25;
const io = { to: () => ({ emit: () => {} }), emit: () => {}, sockets: { sockets: new Map() } };

function join(room, sid) {
  room.addPlayer(sid, 'probe-' + sid, null, null, 0, '9' + sid, null);
  room.setPlayerChar(sid, 'deathknight');
  room.setPlayerStats(sid, {
    level: 80, atk: 120, def: 40, maxHp: 90000,
    critChance: 0, critPower: 1.5, atkSpeed: 1, hpRegen: 0, skillPct: 1,
  });
  room.setPlayerHp(sid, 90000);
  return room.players.get(sid);
}

// Игрок рядом с монстром, сам не бьёт. Через сколько тиков монстр проснулся
// и ударил (null — ни разу).
function idleNextTo(room, sid, enemy, ticks = 400) {
  const p = room.players.get(sid);
  p.x = enemy.x + 40; p.y = enemy.y;
  const hp0 = p.hp;
  let aggroTick = null, hitTick = null;
  for (let i = 0; i < ticks; i++) {
    room._lastTick = Date.now() - TICK_MS;
    room._tick();
    if (aggroTick === null && enemy.aggro) aggroTick = i;
    if (hitTick === null && p.hp < hp0) hitTick = i;
  }
  return { aggroTick, hitTick };
}

function check(label, floorId, flag, wantAggro) {
  console.log(`\n${label} (этаж ${floorId})`);
  const room = new Room(floorId, io, {}, null);
  const mob = room.enemies.find(e => e.hp > 0 && !e.isBoss && !e.elite && e[flag]);
  ok(!!mob, `на этаже есть монстр с ${flag}`);
  if (!mob) return;
  join(room, 's1');
  const r = idleNextTo(room, 's1', mob);
  if (wantAggro) {
    ok(r.aggroTick !== null, 'монстр сам заметил игрока', `aggroTick=${r.aggroTick}`);
    ok(r.hitTick !== null, 'монстр сам ударил игрока', `hitTick=${r.hitTick}`);
  } else {
    ok(r.aggroTick === null, 'монстр стоит, пока его не ударили', `aggroTick=${r.aggroTick}`);
    ok(r.hitTick === null, 'и не бьёт первым', `hitTick=${r.hitTick}`);
  }
}

check('Фарм зона 2', FLOOR_IDS.farmHigh, 'farmHigh', true);
if (FLOOR_IDS.farmHighSeason != null) check('Фарм зона 2 · сезонное крыло', FLOOR_IDS.farmHighSeason, 'farmHigh', true);
check('Фарм-зона (первая) — без изменений', FLOOR_IDS.farmZone, 'farmZone', false);
check('Элитная фарм-зона — без изменений', FLOOR_IDS.farmZone2, 'farmZone2', false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILED:\n  ' + failures.join('\n  ')); process.exit(1); }
process.exit(0);
