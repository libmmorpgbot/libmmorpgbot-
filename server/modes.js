'use strict';
// ── The event modes: 3v3, death battle, race, fear, co-op, elite farm ───────
//
// The six factories under server/game/ are kept exactly as they are. That is
// the point of this file: they hold hours of tuning — freeze windows, scatter
// radii, elimination ordering, reconnect grace — and none of that had anything
// to do with the database. Checked before touching them:
//
//   arena3.js  race10.js  death-battle.js  fear.js  coop.js  farm2.js
//     require: shared/definitions, game/floors, game/Room  — no Mongo
//
// So this is a wiring layer, not a rewrite. What it replaces is ~200 lines of
// closures scattered through server/index.js, and it changes exactly two
// things about them.
//
// FIRST: a daily attempt is now spent in the database, transactionally.
// _lockDailyAttempt fired a Mongo update and did not await it — `.catch(() =>
// {})`, no retry, no report. A failed write meant a free run, and nobody would
// ever have known. progression.takeAttempt is one conditional UPDATE that
// returns whether it took one, so a run that could not be paid for does not
// start.
//
// SECOND: the modes address players by SOCKET id, which is right — a run is a
// property of a connection, and a player who reconnects gets a new one. The
// bridge to a player id goes through the session, which is the only thing that
// knows both.

const progression = require('./db/repos/progression');
const money = require('./db/repos/money');
const { tx } = require('./db');
const { activeSessions } = require('./session');
const world = require('./world');
const ops = require('./tg-ops');
const { FLOOR_IDS } = require('./game/floors');
const { FARM2_DAILY_MINUTES } = require('../shared/definitions');

const createArena3 = require('./game/arena3');
const createRace10 = require('./game/race10');
const createDeathBattle = require('./game/death-battle');
const createFear = require('./game/fear');
const createCoop = require('./game/coop');
const createFarm2 = require('./game/farm2');

// The caps live INSIDE the factories — RACE10_ATTEMPTS, FEAR_ATTEMPTS and
// COOP_ATTEMPTS are each declared in their own file and returned. Reading them
// back out after construction keeps one copy of each number; declaring them
// again here would be a second copy free to drift, which is how a mode ends up
// offering three runs and refusing the third.
//
// The arena shares the dungeon pool, whose size was a bare `const
// DAILY_DUNGEON_ATTEMPTS = 3` in server/index.js and is stated here instead.
const DUNGEON_ATTEMPTS = 3;
function capOf(mode) {
  switch (mode) {
    case 'arena3': return DUNGEON_ATTEMPTS;
    case 'race10': return modes.RACE10_ATTEMPTS ?? 1;
    case 'fear':   return modes.FEAR_ATTEMPTS ?? 2;
    case 'coop':   return modes.COOP_ATTEMPTS ?? 2;
    default:       return 0;
  }
}

let _io = null;
const modes = {};

// ── socket ↔ player ─────────────────────────────────────────────────────────
// The modes hold socket ids. Everything that writes holds a player id. One
// lookup, in one place, so the two never have to be passed around together.
function sessionOf(socketId) {
  const sock = _io && _io.sockets.sockets.get(socketId);
  return sock && sock.data ? sock.data.session : null;
}
function playerIdOf(socketId) {
  const s = sessionOf(socketId);
  return s && s.authed ? s.playerId : null;
}
function socketTid(socketId) {
  const sock = _io && _io.sockets.sockets.get(socketId);
  return (sock && sock.data && sock.data.telegramId) || null;
}

// ── daily attempts ──────────────────────────────────────────────────────────
// Reading is cheap and answers a UI. Spending is a decision and must be
// awaited: a mode that starts a run it could not charge for is a mode that
// gives out free runs to anyone who can make one write fail.
async function attemptsLeft(socketId, mode) {
  const pid = playerIdOf(socketId);
  if (!pid) return 0;
  try { return await progression.attemptsLeft(null, pid, mode, capOf(mode)); }
  catch { return 0; }          // fail CLOSED: unknown means no free run
}

async function takeAttempt(socketId, mode) {
  const pid = playerIdOf(socketId);
  if (!pid) return false;
  try { return !!await tx(t => progression.takeAttempt(t, pid, mode, capOf(mode))); }
  catch (err) {
    ops.alertError('modes.attempt', `Не удалось списать попытку (${mode})`, err);
    return false;
  }
}

// ── shared helpers the factories expect ─────────────────────────────────────
function getRoom(floor) { return world.roomOf(floor); }

function findPlayerAnyFloor(socketId) {
  const s = sessionOf(socketId);
  if (!s || !s.room) return null;
  return s.room.players.get(socketId) || null;
}

// Sends the player back to the hub and returns where they landed. Goes through
// the session's own floor change, so the room membership, the position write
// and the client's gameStart all happen the one way they happen everywhere
// else — a mode that moved players by hand is a mode with its own bugs.
function returnToHub(socketId) {
  const s = sessionOf(socketId);
  if (!s || typeof s.forceFloor !== 'function') return null;
  const p = s.forceFloor(FLOOR_IDS.hub);
  return p ? { x: p.x, y: p.y } : null;
}

function safeTimeout(name, fn, ms) {
  return setTimeout(() => {
    try { fn(); }
    catch (err) {
      console.error(`[timer:${name}]`, err);
      ops.alertError(`timer.${name}`, `Ошибка в таймере ${name}`, err);
    }
  }, ms);
}

// Announcements. The old pair wrote into the global chat; keeping the same
// shape means the client's existing banner works unchanged.
function notifyEventSoon(kind, at) {
  if (_io) _io.emit('eventBossAnnounce', { kind, spawnAt: at });
}
function notifyEventStarted(kind, at) {
  if (_io) _io.emit('eventBossSpawned', { kind, at });
}

// A finished duel, for the history panel. Written outside any transaction the
// caller may hold, because it is a record of something that already happened
// and must not be able to roll a reward back.
async function recordPvpHistory(socketId, row) {
  const pid = playerIdOf(socketId);
  if (!pid) return;
  try {
    const { query } = require('./db');
    await query(null, `
      INSERT INTO pvp_history (player_id, kind, mode, opponent, won, reward)
      VALUES ($1, $2, $3, $4, $5, $6)`,
      [pid, row.kind || 'duel', row.mode || 'pvp', row.opponent || null,
       row.won === true, row.reward == null ? null : String(row.reward)]);
  } catch (err) {
    console.error('[modes] pvp history:', err.message);
  }
}

// Paying a mode's reward. GRAM and Liberty both go through money.js, which is
// the whole point of money.js — the old modes credited a session field and let
// the debounced save carry it, so a disconnect between the win and the save
// lost the prize.
async function payReward(socketId, currency, amount, ref) {
  const pid = playerIdOf(socketId);
  if (!pid || !(amount > 0)) return null;
  try {
    return await tx(t => money.credit(t, pid, currency, amount, {
      reason: 'mode_reward', refType: 'mode', refId: String(ref || ''),
      idemKey: `mode:${pid}:${ref}`,
    }));
  } catch (err) {
    ops.alertError('modes.reward', `Не удалось выплатить награду (${ref})`, err, { playerId: pid });
    return null;
  }
}

// ── construction ────────────────────────────────────────────────────────────
function init(io) {
  _io = io;
  const shared = {
    io,
    getRoom,
    playerFloorMap: { get: (sid) => { const s = sessionOf(sid); return s ? s.floor : null; } },
    logPlayer: () => {},                       // player_logs is written by the session
    _recordPvpHistory: recordPvpHistory,
    _returnToHub: returnToHub,
    _findPlayerAnyFloor: findPlayerAnyFloor,
    _socketTid: socketTid,
    notifyEventSoon,
    notifyEventStarted,
    safeTimeout,
  };

  Object.assign(modes, createArena3({
    ...shared,
    DAILY_DUNGEON_ATTEMPTS: DUNGEON_ATTEMPTS,
    _arena3AttemptsLeft: (sid) => attemptsLeft(sid, 'arena3'),
    _lockArena3Daily: (sid) => takeAttempt(sid, 'arena3'),
  }));
  Object.assign(modes, createRace10({
    ...shared,
    _race10AttemptsLeft: (sid) => attemptsLeft(sid, 'race10'),
    _lockRace10Daily: (sid) => takeAttempt(sid, 'race10'),
  }));
  Object.assign(modes, createDeathBattle(shared));
  Object.assign(modes, createFear(shared));
  Object.assign(modes, createCoop(shared));
  Object.assign(modes, createFarm2({
    ...shared,
    _lockFarm2MinutesFor: (tid, minutes) => {
      // Charged against the PLAYER, not the connection: a reconnect mid-run
      // used to start the budget over, because the old counter hung off the
      // socket. The budget itself is the cap, so a run that overruns it is
      // clamped rather than allowed to go negative.
      const sid = activeSessions.get(String(tid));
      const pid = sid ? playerIdOf(sid) : null;
      if (!pid || !(minutes > 0)) return;
      tx(t => progression.spendSeconds(t, pid, 'farm2', minutes * 60, FARM2_DAILY_MINUTES * 60))
        .catch(err => ops.alertError('modes.farm2', 'Не удалось списать минуты фарма', err));
    },
  }));

  // ── the two cross-mode predicates ───────────────────────────────────────
  // Every mode has its own freeze window and its own idea of what elimination
  // means, and a player can only be in one of them — so these ask all of them
  // and take the first answer. They lived in server/index.js because that is
  // where every mode's closures happened to be in scope; they belong here.
  modes._teleportFrozen = new Map();          // socketId -> until (ms)
  modes._pvpFrozen = (socketId) => {
    const until = modes._teleportFrozen.get(socketId) || 0;
    if (until > Date.now()) return true;
    return !!(modes._dbFrozen(socketId) || modes._a3Frozen(socketId) || modes._race10Frozen(socketId));
  };

  // Order matters and is unchanged: whichever mode claims the elimination
  // handles it, and only a death that NO mode claimed is an open-world kill
  // worth writing to the duel history.
  modes._pvpEliminate = (socketId, killerSocketId, room, opts) => {
    const dbHandled   = modes._dbEliminate(socketId, killerSocketId);
    const a3Handled   = modes._a3Eliminate(socketId, killerSocketId);
    const r10Handled  = modes._race10Eliminate(socketId);
    const fearHandled = (opts && opts.fearGrace)
      ? modes._fearHoldOnDisconnect(socketId, opts.telegramId)
      : modes._fearEliminate(socketId);
    const coopHandled = (opts && opts.fearGrace)
      ? modes._coopEjectOnDisconnect(socketId)
      : modes._coopEliminate(socketId);
    if (killerSocketId && !dbHandled && !a3Handled && !r10Handled && !fearHandled && !coopHandled) {
      const victim = room && room.players.get(socketId);
      const killer = room && room.players.get(killerSocketId);
      recordPvpHistory(socketId, { kind: 'death', mode: 'open_pvp', opponent: killer && killer.username });
      recordPvpHistory(killerSocketId, { kind: 'kill', mode: 'open_pvp', opponent: victim && victim.username });
    }
  };
  modes._returnToHub = returnToHub;
  modes._recordPvpHistory = recordPvpHistory;

  modes.farm2MinutesLeft = async (socketId) => {
    const pid = playerIdOf(socketId);
    if (!pid) return 0;
    try {
      const left = await progression.secondsLeft(null, pid, 'farm2', FARM2_DAILY_MINUTES * 60);
      return Math.max(0, Math.floor(left / 60));
    } catch { return 0; }
  };
  modes.capOf = capOf;
  modes.attemptsLeft = attemptsLeft;
  modes.takeAttempt = takeAttempt;
  modes.payReward = payReward;
  modes.sessionOf = sessionOf;
  modes.playerIdOf = playerIdOf;
  return modes;
}

module.exports = { init, modes, capOf, attemptsLeft, takeAttempt, payReward, sessionOf, playerIdOf };
