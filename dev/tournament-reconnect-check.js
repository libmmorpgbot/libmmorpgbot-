#!/usr/bin/env node
'use strict';
// ── турнир переживает перезагрузку ───────────────────────────────────────────
//
//   node dev/tournament-reconnect-check.js
//
// Всё состояние турнира ключуется по socket id, а перезагрузка страницы — это
// новый socket id. Раньше она была поражением: посреди матча сразу (с записью
// в историю), между раундами — неявкой на следующей раздаче, во время
// регистрации — молча потерянным местом. Проверка поднимает настоящий
// server/game/tournament.js на заглушках (io, Room, таймеры) и прогоняет:
// обрыв и возврат на регистрации, посреди матча, между раундами, на раздаче;
// обрыв без возврата (через 45 с — поражение); «висящий» старый сокет, который
// отваливается уже после входа нового; уход из ямы телепортом.

const path = require('path');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${extra ? ' — ' + extra : ''}`); }
}

// ── заглушка Room: одна яма, две точки ──────────────────────────────────────
class FakeRoom {
  constructor() { this.players = new Map(); }
  tournamentSlot() { return { a: { x: 1, y: 1 }, b: { x: 9, y: 9 } }; }
  canStandAt() { return true; }
  tournamentSeat(sid, side, { pos = null, hp = null } = {}) {
    const p = this.players.get(sid);
    if (!p) return null;
    const at = pos || this.tournamentSlot()[side];
    p.x = at.x; p.y = at.y; p.hp = hp != null ? hp : 100; p.pvpMode = true;
    return { socketId: sid, x: p.x, y: p.y, hp: p.hp };
  }
  tournamentDeploy(a, b) {
    const sa = this.tournamentSeat(a, 'a'), sb = this.tournamentSeat(b, 'b');
    return sa && sb ? { a: sa, b: sb } : null;
  }
}
require.cache[require.resolve(path.join(__dirname, '..', 'server', 'game', 'Room.js'))] = {
  id: 'Room', loaded: true, exports: FakeRoom,
};

// ── ручные часы ─────────────────────────────────────────────────────────────
let now = Date.now();
const realNow = Date.now;
Date.now = () => now;
let timers = [];
let timerSeq = 0;
function fakeTimeout(name, fn, ms) {
  const t = { id: ++timerSeq, at: now + ms, fn };
  timers.push(t);
  return t;
}
const realClear = global.clearTimeout;
global.clearTimeout = (t) => { if (t && t.id) timers = timers.filter(x => x !== t); else realClear(t); };
function advance(ms) {
  const until = now + ms;
  for (;;) {
    timers.sort((a, b) => a.at - b.at);
    const t = timers[0];
    if (!t || t.at > until) break;
    timers.shift();
    now = t.at;
    t.fn();
  }
  now = until;
}

// ── заглушка io и сессий ────────────────────────────────────────────────────
const events = [];            // [sid, event, payload]
const sockets = new Map();    // sid -> { data, tid, room }
const history = [];           // [tid, kind]
const grants = [];            // [tid, amount, ref]
const hub = { players: new Map() };
const io = {
  sockets: { sockets },
  emit() {},
  to(sid) { return { emit: (ev, p) => events.push([sid, ev, p]) }; },
};
function connect(sid, tid) {
  const sock = { tid, room: hub, data: {} };
  sock.data._forceEnterLocation = (floor, { room, pos } = {}) => {
    if (floor === 'hub') return goHub(sid);
    sock.room.players.delete(sid);
    // addPlayer's stale-entry cleanup: same account's older record goes
    for (const [osid, p] of room.players) if (p.tid === tid) room.players.delete(osid);
    room.players.set(sid, { tid, x: pos && pos.x, y: pos && pos.y, hp: 100 });
    sock.room = room;
    return room.players.get(sid);
  };
  sock.data._trGrantReward = async (amount, ref) => { grants.push([tid, amount, ref]); };
  sock.data._seasonAwardTournamentWin = async () => {};
  sockets.set(sid, sock);
  hub.players.set(sid, { tid, x: 0, y: 0, hp: 100 });
  return sock;
}
function goHub(sid) {
  const sock = sockets.get(sid);
  if (!sock) return null;
  sock.room.players.delete(sid);
  hub.players.set(sid, { tid: sock.tid, x: 0, y: 0, hp: 100 });
  sock.room = hub;
  return { x: 0, y: 0 };
}

const createTournament = require('../server/game/tournament');
const modes = createTournament({
  io,
  _findPlayerAnyFloor: sid => { const s = sockets.get(sid); return s ? s.room.players.get(sid) : null; },
  _recordPvpHistory: (tid, kind) => history.push([String(tid), kind]),
  _returnToHub: goHub,
  _socketTid: sid => (sockets.get(sid) ? sockets.get(sid).tid : null),
  notifyEventSoon() {}, broadcastLeadMs: () => 0, notifyEventStarted() {},
  safeTimeout: fakeTimeout,
});
const { _tr } = modes;
// modes._pvpEliminate(disconnect) → hold; then the session is gone
function disconnect(sid) {
  const tid = sockets.get(sid).tid;
  modes._trHoldOnDisconnect(sid, tid);
  const sock = sockets.get(sid);
  sock.room.players.delete(sid);
  sockets.delete(sid);
}
// the login flow: land in hub, then _trResumeOnLogin
function relogin(newSid, tid) {
  connect(newSid, tid);
  return modes._trResumeOnLogin(tid, newSid);
}
const sidOfTid = tid => [..._tr.tids].find(([, t]) => t === String(tid))?.[0];
const opponentOf = sid => _tr.matches.get(sid)?.opponent;
const lossesOf = tid => history.filter(([t, k]) => t === String(tid) && k === 'lose').length;

console.log('\ntournament-reconnect-check');

// ── 1. регистрация ───────────────────────────────────────────────────────────
modes._trOpenWindow(now);
for (let i = 0; i < 31; i++) {
  connect('s' + i, 1000 + i);
  modes._trRegister('s' + i, 'P' + i, 1000 + i);
}
disconnect('s0');
ok(_tr.reg.size === 31, 'обрыв во время регистрации не снимает запись', `reg ${_tr.reg.size}`);
relogin('s0b', 1000);
ok(_tr.reg.has('s0b') && !_tr.reg.has('s0'), 'после перезагрузки запись на новом сокете');
ok(events.some(([s, e, p]) => s === 's0b' && e === 'tournamentState' && p.registered === true),
  'клиенту после перезагрузки сказано «записан»');

// тот же аккаунт повторно жмёт «записаться» с другого сокета — не два места
connect('s0c', 1000);
modes._trRegister('s0c', 'P0', 1000);
ok(_tr.reg.size === 31 && _tr.reg.has('s0c') && !_tr.reg.has('s0b'), 'второй сокет того же аккаунта не занимает второе место');
sockets.delete('s0b'); hub.players.delete('s0b');

// кто-то отвалился и не вернулся за 45 с — место освобождается
disconnect('s30');
advance(46000);
ok(!_tr.reg.has('s30') && _tr.reg.size === 30, 'не вернулся за 45 с на регистрации — место снято');
connect('s30b', 1030); modes._trRegister('s30b', 'P30', 1030);

// в момент заполнения один перезагружается — всё равно старт
disconnect('s5');
connect('s31', 1031); modes._trRegister('s31', 'P31', 1031);
modes._trTryStart();
ok(_tr.phase === 'live', 'турнир стартует, даже если один из 32 в этот момент перезагружается');
ok(_tr.names.size === 32, 'в сетке 32', `names ${_tr.names.size}`);

// ── 2. раздача, когда одна сторона ещё не вернулась ─────────────────────────
ok(_tr.matches.has('s5'), 'перезагружающийся на раздаче не получает техпоражение, его матч ждёт');
const opp5 = opponentOf('s5');
ok(opp5 && sockets.get(opp5).room !== hub, 'его соперник уже в яме');
relogin('s5b', 1005);
ok(_tr.matches.has('s5b') && opponentOf('s5b') === opp5 && opponentOf(opp5) === 's5b', 'вернулся — матч тот же, пара переключена на новый сокет');
ok(sockets.get('s5b').room === sockets.get(opp5).room, 'вернулся в свою яму к сопернику');
ok(events.some(([s, e]) => s === 's5b' && e === 'tournamentMatchStarted'), 'клиенту заново прислан старт матча');
ok(lossesOf(1005) === 0, 'поражение не записано');

// ── 3. перезагрузка посреди боя ─────────────────────────────────────────────
advance(20000); // идёт бой
const a = 's1', b = opponentOf('s1');
sockets.get(a).room.players.get(a).hp = 37;
disconnect(a);
ok(_tr.matches.has(a) && !_tr.roundResults.has(a), 'обрыв посреди боя — матч не закрыт');
ok(lossesOf(1001) === 0, 'и поражение не записано');
advance(5000);
relogin('s1b', 1001);
ok(opponentOf('s1b') === b && sockets.get('s1b').room === sockets.get(b).room, 'вернулся в бой к тому же сопернику');
ok(sockets.get('s1b').room.players.get('s1b').hp === 37, 'с тем же здоровьем, не полным');
ok(events.some(([s, e]) => s === 's1b' && e === 'tournamentFight'), 'бой уже идёт — клиенту сразу tournamentFight');

// ── 4. обрыв без возврата ───────────────────────────────────────────────────
const c = 's2', d = opponentOf('s2');
disconnect(c);
advance(46000);
ok(_tr.bracketHistory[0].matches.some(m => (m.a.id === c || m.b.id === c) && m.winnerId === d),
  'не вернулся за 45 с — матч отдан сопернику');

// ── 5. «висящий» старый сокет (ping timeout ещё не сработал) ─────────────────
// Дождёмся следующего раунда, где идёт живой матч.
const r1 = _tr.roundIndex;
for (let guard = 0; guard < 400 && !(_tr.roundIndex > r1 && [..._tr.matches.keys()].some(s => sockets.has(s))); guard++) advance(1000);
ok(_tr.roundIndex > r1, 'следующий раунд начался', `round ${_tr.roundIndex}`);
const e = [..._tr.matches.keys()].find(s => sockets.has(s));
const eTid = sockets.get(e).tid;
relogin(e + 'n', eTid);   // новый сокет входит, старый ещё «жив»
ok(_tr.matches.has(e + 'n') && !_tr.matches.has(e), 'новый сокет забрал матч у висящего старого');
ok(sockets.get(e + 'n').room.players.has(e + 'n') && !sockets.get(e + 'n').room.players.has(e), 'старая запись убрана из ямы');
modes._trHoldOnDisconnect(e, eTid); sockets.delete(e);    // теперь старый наконец отвалился
ok(_tr.matches.has(e + 'n') && !_tr.held.has(String(eTid)), 'поздний обрыв старого сокета ничего не ломает');
advance(60000);
ok(lossesOf(eTid) <= 1, 'лишних поражений нет');

// ── 6. уход из ямы посреди матча ─────────────────────────────────────────────
const r2 = _tr.roundIndex;
for (let guard = 0; guard < 400 && !(_tr.roundIndex > r2 && [..._tr.matches.keys()].some(s => sockets.has(s) && sockets.has(opponentOf(s)))); guard++) advance(1000);
const f = [..._tr.matches.keys()].find(s => sockets.has(s) && sockets.has(opponentOf(s)));
if (f) {
  const g = opponentOf(f);
  modes._trLeavePit(f);
  ok(!_tr.matches.has(f) && _tr.roundResults.get(f) === g, 'ушёл из ямы телепортом — техническое поражение, а не зависший матч');
} else ok(false, 'нашёлся матч для проверки ухода из ямы');

// ── 7. перезагрузка между раундами ──────────────────────────────────────────
for (let guard = 0; guard < 20 && !(_tr.gapEndAt > now); guard++) advance(5000);
const alive = [..._tr.names.keys()].find(s => !_tr.out.has(s) && sockets.has(s));
if (alive && _tr.gapEndAt > now) {
  const tid = sockets.get(alive).tid;
  disconnect(alive);
  relogin(alive + 'g', tid);
  ok(sidOfTid(tid) === alive + 'g', 'перезагрузка между раундами — место в сетке на новом сокете');
  ok(events.some(([s, ev, p]) => s === alive + 'g' && ev === 'tournamentState' && p.inBracket === true),
    'клиенту сказано, что он всё ещё в сетке');
} else ok(false, 'поймали паузу между раундами');

// ── турнир доходит до конца ─────────────────────────────────────────────────
for (let guard = 0; guard < 400 && _tr.phase === 'live'; guard++) advance(10000);
ok(_tr.phase === 'idle', 'турнир доиграл до конца');
ok(_tr.held.size === 0 && _tr.tids.size === 0, 'удержания и привязки очищены после финала');

Date.now = realNow;
console.log(`\n  ${pass} пройшло, ${fail} впало`);
process.exit(fail ? 1 : 0);
