#!/usr/bin/env node
'use strict';
// ═══════════════════════════════════════════════════════════════════════════
//  enemysync-check.js — a dropped packet must not cost a monster
// ═══════════════════════════════════════════════════════════════════════════
//
//   node dev/enemysync-check.js          (no server, no database)
//
// Why this exists, in the words of the person who reported it:
//
//   "моби тупо лагаються можуть тупо стояти … підходиш до них вони стоять не
//    чіпають … ти урон можеш получати коли навіть біля них не стоїш по
//    візуалу … дальше вони тупо тепнутись можуть до тебе"
//
// One cause underneath all four. The world cast goes out with volatile.emit,
// which is SUPPOSED to drop rather than queue when a socket is backed up — a
// mobile link, a backgrounded WebView. But the server records "this player has
// it" at ENCODE time (_pushEnemyEntry, Room.js), with no delivery feedback,
// and then suppresses anything that has not changed since. So a dropped packet
// left the server believing a client held state it never received, and
// deliberately silent about it, until ENEMY_REFRESH_CASTS came round — sixty
// seconds.
//
// This file reproduces a dropped packet by simply not decoding one, and holds
// the three repairs to their promises.
const path = require('path');
const codec = require(path.join(__dirname, '..', 'shared', 'netcodec.js'));
const { encodeGameState, decodeGameState, resetNetCodecMaps, netCodecLostIdx } = codec;
const Room = require(path.join(__dirname, '..', 'server', 'game', 'Room.js'));
const { FLOOR_IDS } = require(path.join(__dirname, '..', 'server', 'game', 'floors.js'));

let pass = 0, fail = 0;
const G = s => '\x1b[32m' + s + '\x1b[0m';
const R = s => '\x1b[31m' + s + '\x1b[0m';
const D = s => '\x1b[2m' + s + '\x1b[0m';
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ' + G('PASS') + '  ' + label + (extra ? D('   ' + extra) : '')); }
  else { fail++; console.log('  ' + R('FAIL') + '  ' + label + (extra ? '   ' + extra : '')); }
}
function head(s) { console.log('\n  ── ' + s + ' ──'); }

// ── a room with no sockets and no database ────────────────────────────────
const sent = [];
const fakeSocket = {
  connected: true,
  volatile: { emit: (ev, buf) => sent.push(buf) },
  emit: (ev, buf) => sent.push(buf),
};
const io = { to: () => ({ emit: (ev, buf) => sent.push(buf) }), sockets: { sockets: { get: () => fakeSocket } } };

const room = new Room(FLOOR_IDS.top, io, {}, null);
const enemies = room.enemies.filter(e => !e.isBoss && e.hp > 0);
if (!enemies.length) { console.error('этаж без мобов — проверять нечего'); process.exit(1); }
const mob = enemies[0];

room.addPlayer('p1', 'tester', null, null, 0, '9000001');
room.setPlayerChar('p1', 'lev', null);
const P = room.players.get('p1');
P._socket = fakeSocket;
// Well inside the streaming radius (ENEMY_AOI_R) but well outside the mob's
// aggro radius, so it stands still on its own and the suppression case below
// is the real one rather than one this file arranged.
P.x = mob.x + 600; P.y = mob.y;

// The spatial index the collector reads is rebuilt by _tick(), so a few real
// ticks have to run before any of this means anything. They also cast, which
// fills _eKnown — cleared before each case that cares.
for (let i = 0; i < 4; i++) room._tick();
mob.aggro = false;
const mobHome = { x: mob.x, y: mob.y };

// _collectEnemiesFor is the thing under test; drive it directly so nothing
// depends on tick scheduling. castId continues from the room's own counter:
// the suppression compares castId against what was last sent, and starting
// over at zero would make every difference negative.
const out = [];
let cast = room._tickNo + 2;
function collect() { cast += 2; out.length = 0; room._collectEnemiesFor(P, out, cast); return out.slice(); }
function entryFor(list, id) { return list.find(e => e.id === id); }

// ═══ 1. a dropped full record leaves the client unable to follow ══════════
head('потерянный полный запис');
resetNetCodecMaps();
netCodecLostIdx();                       // clear the counter
room.forgetKnownEnemies('p1');           // pretend this client just arrived
P._eResetAt = 0;

const first = collect();
ok(!!entryFor(first, mob.id) && entryFor(first, mob.id).eid !== undefined,
   'первый каст шлёт моба полностью', 'записей: ' + first.length);

// The packet is encoded and then NOT decoded — exactly what volatile.emit
// does when the socket is backed up.
encodeGameState(null, first, Date.now());

// The mob moves, so the next cast carries a slim delta for it.
mob.x += 5; mob.y += 5;
const second = collect();
const slim = entryFor(second, mob.id);
ok(!!slim && slim.eid === undefined, 'следующий каст шлёт уже только дельту');

const decoded = decodeGameState(encodeGameState(null, second, Date.now()));
const gotIt = decoded.enemies.some(e => e.id === mob.id);
ok(!gotIt, 'клиент дельту применить НЕ МОЖЕТ — полного записи он не получал');
const lost = netCodecLostIdx();
ok(lost > 0, 'и декодер об этом ЗАЯВЛЯЕТ, а не глотает молча',
   lost + ' потерянных дельт (раньше было тихое отбрасывание)');

// ═══ 2. the client can ask for it back, and the server answers ════════════
head('ремонт по запросу клиента');
const beforeReset = P._eKnown.size;
room.forgetKnownEnemies('p1');
ok(P._eKnown.size === 0, 'forgetKnownEnemies сбрасывает учёт сервера',
   beforeReset + ' -> ' + P._eKnown.size);

const third = collect();
const full = entryFor(third, mob.id);
ok(!!full && full.eid !== undefined, 'и следующий каст снова шлёт полный запис');

// A client on a bad link must not be able to turn the repair into a second
// stream: one request makes the server encode a full record per enemy in range.
P._eKnown.set('sentinel', { x: 0, y: 0, hp: 1, aggro: false, seen: cast, sent: cast, full: true });
room.forgetKnownEnemies('p1');
ok(P._eKnown.has('sentinel'), 'повторный запрос в ту же секунду игнорируется',
   'иначе плохой линк превращает ремонт во второй поток');

// ═══ 3. a lost one-shot transition heals itself in seconds, not a minute ══
head('потерянный одноразовый переход (агро -> нет)');
// Fresh state, mob standing perfectly still and not aggroed: the case the
// suppression is designed for, and the case a dropped packet used to freeze.
room.forgetKnownEnemies('p1');
P._eResetAt = 0;
mob.aggro = false;
mob.x = mobHome.x; mob.y = mobHome.y;
collect();                                  // full record, k.sent = cast
const still = [];
let casts = 0, restatedAt = -1;
for (let i = 0; i < 200; i++) {
  casts++;
  const list = collect();
  if (entryFor(list, mob.id)) { restatedAt = casts; break; }
  still.push(list.length);
}
ok(restatedAt > 1, 'неподвижный моб не шлётся каждый каст (подавление работает)',
   'молчал ' + (restatedAt - 1) + ' кастов');
ok(restatedAt > 0 && restatedAt <= 60,
   'но сервер сам переподтверждает его за считаные секунды, а не за минуту',
   'переподтверждён на касте ' + restatedAt + ' (~' + (restatedAt / 20).toFixed(1) + 'с; было 1200 = 60с)');

// ═══ 4. the encoder still round-trips ═════════════════════════════════════
head('кодек цел');
resetNetCodecMaps();
netCodecLostIdx();
room.forgetKnownEnemies('p1');
P._eResetAt = 0;
const fresh = collect();
const rt = decodeGameState(encodeGameState(null, fresh, Date.now()));
ok(rt.enemies.length === fresh.length, 'все записи доехали', fresh.length + ' -> ' + rt.enemies.length);
const a = entryFor(fresh, mob.id), b = rt.enemies.find(e => e.id === mob.id);
ok(!!b && Math.abs(b.x - a.x) < 1 && Math.abs(b.y - a.y) < 1, 'координаты совпали');
ok(netCodecLostIdx() === 0, 'ни одной потерянной дельты на здоровом потоке');

console.log('\n  ' + (fail === 0 ? G(pass + ' пройшло, 0 впало') : R(pass + ' пройшло, ' + fail + ' впало')) + '\n');
process.exit(fail === 0 ? 0 : 1);
