#!/usr/bin/env node
'use strict';
// ── Элитный монстр сезонных крыльев ─────────────────────────────────────────
//
//   node dev/elite-check.js
//
// Заказ: «в сезонной фарм-зоне раз в час появляется элитный монстр, светится
// красным внизу как у персонажей, в 3 раза больше обычного, появляется в
// сезонной фарм-зоне 1 и 2, один на весь сервер, респ 60-70 минут, шанс дропа
// x10 и фиксированно 3 000 000 здоровья».
//
// Позже: «только 13.10 с 00:00 по Москве до 23:59».

const {
  ELITE_MOB_HP, ELITE_MOB_SIZE_MULT, ELITE_MOB_DROP_MULT, ELITE_MOB_GRAM,
  ELITE_MOB_RESPAWN_MIN_MS, ELITE_MOB_RESPAWN_MAX_MS,
  ELITE_EVENT_START_AT, ELITE_EVENT_END_AT, eliteEventOn,
} = require('../shared/definitions');
const Room = require('../server/game/Room');
const { FLOOR_IDS } = require('../server/game/floors');
const { encodeGameState, decodeGameState, resetNetCodecMaps } = require('../shared/netcodec');
const loot = require('../server/game/loot');
const elite = require('../server/game/elite');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, n) => ok(a === b, n, `ждали ${JSON.stringify(b)}, получили ${JSON.stringify(a)}`);
const head = s => console.log(`\n  ── ${s} ──`);

const chat = [];
const io = { to: () => ({ emit: () => {} }), emit: (ev, m) => { if (ev === 'chatMsg') chat.push(m.text); }, sockets: { sockets: new Map() } };

console.log('\nelite-check');

const rooms = new Map();
for (const f of [FLOOR_IDS.farmSeason, FLOOR_IDS.farmHighSeason, FLOOR_IDS.farmZone]) {
  const r = new Room(f, io, {}, null);
  r._stopLoop();
  rooms.set(f, r);
}
const roomOf = f => rooms.get(Number(f)) || null;

// ════════════════════════════════════════════════════════════════════════════
head('монстр');
for (const f of [FLOOR_IDS.farmSeason, FLOOR_IDS.farmHighSeason]) {
  const room = rooms.get(f);
  const before = room.enemies.length;
  let died = null;
  const e = room.spawnEliteMonster((floor, en) => { died = { floor, id: en.id }; });
  ok(!!e, `этаж ${f}: монстр поставлен`);
  eq(room.enemies.length, before + 1, `этаж ${f}: ровно один новый монстр`);
  eq(e.hp, ELITE_MOB_HP, `этаж ${f}: 3 000 000 здоровья`);
  eq(e.maxHp, 3000000, `этаж ${f}: maxHp тоже ровно 3 000 000`);
  const tpl = room.enemies.find(x => !x.elite && x.eid === e.eid);
  eq(e.size, tpl.size * ELITE_MOB_SIZE_MULT, `этаж ${f}: в 3 раза крупнее обычного того же вида`);
  ok(e.elite && !e.isBoss, `этаж ${f}: элитный, но не босс`);
  ok(f === FLOOR_IDS.farmSeason ? e.farmZone : e.farmHigh, `этаж ${f}: таблица дропа своей зоны`);
  ok(!room.canStandAt || room.canStandAt(e.x, e.y), `этаж ${f}: стоит на полу, а не в стене`);
  eq(room.spawnEliteMonster(() => {}), null, `этаж ${f}: второго, пока жив первый, не ставит`);

  // Убийство: удар игрока вплотную по монстру с 1 hp.
  room.addPlayer('p' + f, 'probe', null, null, 0, '9' + f, null);
  room.setPlayerChar('p' + f, 'deathknight');
  room.setPlayerStats('p' + f, { level: 60, atk: 5000, def: 40, maxHp: 900, critChance: 0, critPower: 1.5, atkSpeed: 1, hpRegen: 0, skillPct: 1 });
  room.setPlayerHp('p' + f, 900);
  const p = room.players.get('p' + f);
  p.x = e.x + 20; p.y = e.y;
  e.hp = 1;
  const res = room.attackEnemy('p' + f, e.id);
  ok(res && res.killed, `этаж ${f}: убивается`, JSON.stringify(res));
  ok(res && res.elite === true, `этаж ${f}: в результате убийства есть пометка elite`);
  room._tick();
  ok(died && died.id === e.id && died.floor === f, `этаж ${f}: о смерти сообщено планировщику`);
  ok(!room._enemyMap.has(e.id), `этаж ${f}: убран с этажа, а не воскрес на месте`);
  ok(!room.isEliteAlive(), `этаж ${f}: больше не жив`);
}

// ════════════════════════════════════════════════════════════════════════════
head('сеть');
{
  resetNetCodecMaps();
  const base = { idx: 7, eid: 'orc_warrior', x: 100, y: 100, hp: 3000000, maxHp: 3000000, name: 'x', color: '#fff', size: 51, aggro: false, aggroR: 200, spd: 75, rlvl: 30 };
  const one = decodeGameState(encodeGameState([], [{ ...base, id: 'elite_1', elite: true, isBoss: false }], 0)).enemies[0];
  ok(one.elite === true && one.isBoss === false, 'элитный доходит до клиента элитным и не боссом');
  eq(one.maxHp, 3000000, '3 000 000 помещается в поле maxHp');
  eq(one.size, 51, 'размер x3 помещается в u8');
  const boss = decodeGameState(encodeGameState([], [{ ...base, idx: 8, id: 'b', isBoss: true }], 0)).enemies[0];
  ok(boss.isBoss === true && boss.elite === false, 'босс остаётся боссом');
  const plain = decodeGameState(encodeGameState([], [{ ...base, idx: 9, id: 'p', isBoss: false }], 0)).enemies[0];
  ok(plain.isBoss === false && plain.elite === false, 'обычный остаётся обычным');
}

// ════════════════════════════════════════════════════════════════════════════
head('дроп x10');
{
  const N = 20000;
  const count = (fn, m) => { let n = 0; for (let i = 0; i < N; i++) n += fn([], m).length; return n; };
  const z1 = count((inv, m) => loot._rollFarmZoneLoot(inv, 'orc_warrior', m), 1);
  const z10 = count((inv, m) => loot._rollFarmZoneLoot(inv, 'orc_warrior', m), ELITE_MOB_DROP_MULT);
  ok(z10 > z1 * 6, `Фарм-зона: x10 к шансу даёт заметно больше дропа (${z1} → ${z10})`);
  eq(ELITE_MOB_DROP_MULT, 10, 'множитель — ровно 10');
  eq(ELITE_MOB_GRAM, 0.3, 'GRAM с элитного — 0.3');
}

// ════════════════════════════════════════════════════════════════════════════
head('один на весь сервер, респ 60-70 минут');
{
  for (let i = 0; i < 1000; i++) {
    const d = elite.respawnDelayMs();
    if (d < ELITE_MOB_RESPAWN_MIN_MS || d > ELITE_MOB_RESPAWN_MAX_MS) { ok(false, 'задержка в пределах 60-70 минут', String(d)); break; }
  }
  eq(ELITE_MOB_RESPAWN_MIN_MS, 60 * 60 * 1000, 'нижняя граница — 60 минут');
  eq(ELITE_MOB_RESPAWN_MAX_MS, 70 * 60 * 1000, 'верхняя — 70');

  // Внутри окна события: 13.10, 12:00 по Москве.
  let clock = ELITE_EVENT_START_AT + 12 * 3600e3;
  elite._setClock(() => clock);
  const saved = [];
  elite.init({ roomOf, save: (f, arm, at) => saved.push({ f, arm, at }), deadlineMs: clock + 3600e3 });
  eq(elite.aliveFloor(), null, 'сохранённый срок в будущем — сразу не появляется');
  const first = elite.spawnNow();
  ok(first && elite.ELITE_FLOORS.includes(first.floor), 'появляется в одном из двух сезонных крыльев');
  eq(elite.spawnNow(), null, 'второй, пока жив первый, не появляется — ни в том же крыле, ни в другом');
  const alive = [...rooms.keys()].filter(f => rooms.get(f).isEliteAlive());
  eq(alive.length, 1, 'жив ровно один на весь сервер');
  ok(!rooms.get(FLOOR_IDS.farmZone).isEliteAlive(), 'в обычной Фарм-зоне (не крыле) не появляется');
  eq(chat.length, 0, 'о появлении в чат не пишется');

  first.enemy.hp = 0;
  const t0 = clock;
  rooms.get(first.floor)._tick();
  eq(saved.length, 1, 'смерть записывает срок следующего');
  const st = elite.status();
  ok(st.nextAt >= t0 + ELITE_MOB_RESPAWN_MIN_MS && st.nextAt <= t0 + ELITE_MOB_RESPAWN_MAX_MS,
    'следующий — через 60-70 минут после смерти');
  eq(saved[0].at, st.nextAt, 'в базу уходит тот же срок, что стоит на таймере');
  eq(elite.aliveFloor(), null, 'до срока на сервере элитного нет');
  eq(chat.length, 0, 'о смерти в чат тоже не пишется (пишет только выдача GRAM)');
  elite.stop();
}

// ════════════════════════════════════════════════════════════════════════════
head('только 13.10 с 00:00 до 23:59 по Москве');
{
  eq(new Date(ELITE_EVENT_START_AT).toISOString(), '2026-10-12T21:00:00.000Z', 'начало — 13.10 00:00 МСК (UTC+3)');
  eq(new Date(ELITE_EVENT_END_AT).toISOString(), '2026-10-13T21:00:00.000Z', 'конец — 14.10 00:00 МСК, то есть после 23:59');
  ok(!eliteEventOn(ELITE_EVENT_START_AT - 1), '12.10 23:59:59 МСК — ещё нет');
  ok(eliteEventOn(ELITE_EVENT_START_AT), '13.10 00:00 МСК — уже да');
  ok(eliteEventOn(ELITE_EVENT_END_AT - 1), '13.10 23:59:59 МСК — ещё да');
  ok(!eliteEventOn(ELITE_EVENT_END_AT), '14.10 00:00 МСК — уже нет');

  let clock = ELITE_EVENT_START_AT - 5 * 3600e3;
  elite._setClock(() => clock);
  elite.init({ roomOf, save: () => {}, deadlineMs: null });
  eq(elite.spawnNow(), null, 'до 13.10 не появляется');
  eq(elite.status().nextAt, ELITE_EVENT_START_AT, 'первый поставлен ровно на 13.10 00:00 МСК');

  clock = ELITE_EVENT_START_AT + 23 * 3600e3 + 30 * 60e3; // 23:30 МСК
  const late = elite.spawnNow();
  ok(late, '13.10 в 23:30 появляется');
  late.enemy.hp = 0; rooms.get(late.floor)._tick();
  eq(elite.status().nextAt, null, 'убит в 23:30 — следующего уже не будет (60-70 минут выходят за окно)');

  clock = ELITE_EVENT_START_AT + 23 * 3600e3 + 50 * 60e3;
  const last = elite.spawnNow();
  ok(last, 'в 23:50 ставится, если никого нет');
  clock = ELITE_EVENT_END_AT;
  elite.endEvent();
  eq(elite.aliveFloor(), null, 'в 00:00 14.10 живой исчезает');
  eq(elite.spawnNow(), null, 'после окна не появляется');
  elite.stop();
  elite._setClock(null);
}

for (const r of rooms.values()) r._stopLoop();
console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) { console.log('\n  провалено:\n' + failures.map(f => '    - ' + f).join('\n')); process.exit(1); }
process.exit(0);
