'use strict';
// Death Battle (Битва на смерть) scheduling + elimination, moved out of
// server/index.js verbatim as a factory (createDeathBattle(deps)) — same
// pattern as server/routes/admin.js and server/telegram-bot.js. Everything
// here is module state rather than per-socket (see the original comment
// below), so the factory is called once, and its return value is destructured
// back into index.js under the same names every other handler already uses.
const {
  DEATH_BATTLE_DAYS_MSK, DEATH_BATTLE_HOURS_MSK, DEATH_BATTLE_REG_MS, DEATH_BATTLE_FREEZE_MS,
  DEATH_BATTLE_MIN_PLAYERS, DEATH_BATTLE_MAX_MS, DEATH_BATTLE_GRAM_REWARD,
  EVENT_NOTIFY_BEFORE_MS, nextEventStartAt,
} = require('../../shared/definitions');
const { FLOOR_IDS } = require('../game/floors');

module.exports = function createDeathBattle(deps) {
  const {
    io, getRoom, playerFloorMap, _findPlayerAnyFloor, _recordPvpHistory, _socketTid,
    notifyEventSoon, broadcastLeadMs, notifyEventStarted, safeTimeout,
  } = deps;

  // ── Death Battle (Битва на смерть) ──────────────────────────────────────────
  // Runs on a fixed daily schedule (shared/definitions.js): registration opens
  // DEATH_BATTLE_REG_MS before each start, then everyone signed up is dropped
  // into the arena in PvP and fights until one is left. All of it is module
  // state rather than per-socket, so a player who connects mid-registration sees
  // the same countdown as everyone else (sent from gameStart, see selectChar).
  const _db = {
    phase: 'idle',       // 'idle' → 'reg' → 'live' → 'idle'
    startAt: 0,          // when the fighting begins (also the registration deadline)
    reg: new Map(),      // socketId -> { name }
    alive: new Map(),    // socketId -> { name }
    // Set for exactly one socket between winning and closing the reward modal,
    // and cleared the moment it's used — deathBattleReturn teleports whoever
    // sends it to the hub, so without this any client could emit it at will as a
    // free instant travel home.
    winnerId: null,
    // While Date.now() < fightAt everyone is in the arena but held still: the
    // server refuses their movement and attacks outright (see _dbFrozen), so a
    // modified client can't get a head start by ignoring the countdown.
    fightAt: 0,
    regTimer: null, startTimer: null, maxTimer: null, freezeTimer: null, notifyTimer: null,
  };

  // True while this socket is an entrant of a round that hasn't gone live yet.
  function _dbFrozen(socketId) {
    return _db.phase === 'live' && Date.now() < _db.fightAt && _db.alive.has(socketId);
  }

  // Next scheduled start, in UTC ms — вторник/четверг/суббота, дважды в день.
  // The weekday+hour maths lives in shared/definitions.js so the client's
  // countdown reads from exactly the same schedule.
  function _dbNextStartAt(from = Date.now()) {
    return nextEventStartAt(DEATH_BATTLE_DAYS_MSK, DEATH_BATTLE_HOURS_MSK, from);
  }

  function _dbPublicState() {
    return {
      phase:   _db.phase,
      startAt: _db.startAt,
      nextAt:  _dbNextStartAt(),
      count:   _db.phase === 'live' ? _db.alive.size : _db.reg.size,
    };
  }

  function _dbBroadcast() {
    io.to('floor_1').emit('deathBattleState', _dbPublicState());
  }

  // Arms the registration window for the next start time. Called at boot and
  // after every round; if the process happens to start inside a registration
  // window the timeout is already due and fires immediately with whatever time
  // is left, which is the correct behaviour.
  function _dbSchedule() {
    clearTimeout(_db.regTimer);
    clearTimeout(_db.notifyTimer);
    _db.phase = 'idle';
    _db.startAt = 0;
    const startAt = _dbNextStartAt();
    _db.regTimer = safeTimeout('dbOpenReg', () => _dbOpenReg(startAt), Math.max(0, startAt - DEATH_BATTLE_REG_MS - Date.now()));
    // The 30-minute warning is its own timer rather than part of the
    // registration one: registration only opens DEATH_BATTLE_REG_MS ahead, far
    // too late to get anyone into the game in time. Skipped when that moment
    // has already passed, so a restart inside the window doesn't fire it late
    // (see the same guard in _wbSchedule).
    // Сдвиг на длительность самого прохода. Telegram принимает около тридцати
    // сообщений в секунду, и четыре тысячи адресатов — это больше двух минут:
    // предупреждение «за 30 минут», отправленное ровно за тридцать, доходило до
    // конца очереди за двадцать восемь. Начинаем раньше на столько, сколько
    // проход занимает, — и последний получает свои тридцать.
    const warnIn = startAt - EVENT_NOTIFY_BEFORE_MS - broadcastLeadMs() - Date.now();
    if (warnIn > 0) _db.notifyTimer = safeTimeout('dbNotify', () => notifyEventSoon('battle', startAt), warnIn);
  }

  function _dbOpenReg(startAt) {
    _db.phase = 'reg';
    _db.startAt = startAt;
    // Announced when registration opens rather than at startAt: once the round
    // actually begins nobody can join it any more, so a message then would be
    // pointless. This is the moment the event becomes something to act on.
    notifyEventStarted('battle', startAt);
    _db.reg.clear();
    _db.alive.clear();
    clearTimeout(_db.startTimer);
    _db.startTimer = safeTimeout('dbStart', _dbStart, Math.max(0, startAt - Date.now()));
    _dbBroadcast();
  }

  // The arena is its own floor now (server/game/floors.js) — deploying an
  // entrant means a real floor change, and "which floor/spot were they
  // actually standing in before" has to be captured BEFORE that move, from
  // wherever they really were (any floor, not just the hub — registering for
  // the event never required being on any particular one). Room.deathBattleDeploy
  // no longer tracks this itself; _dbPrevFloor/_dbPrevX/_dbPrevY are set here,
  // directly on the arena room's freshly-joined player record, right after.
  function _dbStart() {
    const arenaRoom = getRoom(FLOOR_IDS.arena);
    // Only entrants who are still connected and still have an active character
    // somewhere in the world can fight.
    const ids = [..._db.reg.keys()].filter(sid =>
      io.sockets.sockets.get(sid) && _findPlayerAnyFloor(sid));
    if (!arenaRoom || ids.length < DEATH_BATTLE_MIN_PLAYERS) {
      io.to('floor_1').emit('deathBattleCancelled', { reason: 'notEnough' });
      _db.reg.clear();
      _dbSchedule();
      _dbBroadcast();
      return;
    }
    _db.phase = 'live';
    _db.alive.clear();
    _db.fightAt = Date.now() + DEATH_BATTLE_FREEZE_MS;
    const prevInfo = new Map();
    ids.forEach(sid => {
      const p = _findPlayerAnyFloor(sid);
      if (p) prevInfo.set(sid, { floor: playerFloorMap.get(sid), x: p.x, y: p.y });
    });
    // deathBattleDeploy below needs everyone already present in
    // arenaRoom.players to lay out the ring — force each entrant's own
    // connection onto the arena floor first (bypassing _arenaOpen: this is a
    // scheduled deploy, not a walk-in, and has nothing to do with whether a
    // world boss happens to be up at the same time).
    // _doEnterLocation refuses a transition to the floor you are already on
    // (`targetFloor === currentFloor` — nothing to do), and it says so by
    // returning false, which is indistinguishable here from "the move failed".
    // The arena is reachable on foot for as long as a world boss is up
    // (_arenaOpen), so an entrant who happened to be standing in it when the
    // round deployed was read as a failed join and dropped from the round
    // entirely: they registered, the battle started around them, and they were
    // never placed on the ring, never added to _db.alive and never sent
    // deathBattleStarted — while still standing in the middle of a live
    // free-for-all. Already being there is a successful join, not a failure.
    const joined = ids.filter(sid =>
      playerFloorMap.get(sid) === FLOOR_IDS.arena ||
      !!io.sockets.sockets.get(sid)?.data?._forceEnterLocation?.('arena'));
    const placed = arenaRoom.deathBattleDeploy(joined);
    placed.forEach(({ socketId, x, y, hp }) => {
      const info = prevInfo.get(socketId);
      const p = arenaRoom.players.get(socketId);
      if (p && info) { p._dbPrevFloor = info.floor; p._dbPrevX = info.x; p._dbPrevY = info.y; }
      _db.alive.set(socketId, _db.reg.get(socketId) || { name: '?' });
      io.sockets.sockets.get(socketId)?.data?._seasonAwardEvent?.('deathbattle');
      io.to(socketId).emit('deathBattleStarted', { x, y, hp, total: placed.length, fightAt: _db.fightAt });
    });
    _db.reg.clear();
    // Lift the freeze on a timer as well as by clock, so clients get a clean
    // "go" push instead of each deciding for itself when the countdown ended.
    clearTimeout(_db.freezeTimer);
    _db.freezeTimer = safeTimeout('dbFreeze', () => {
      if (_db.phase !== 'live') return;
      _db.alive.forEach((_, sid) => io.to(sid).emit('deathBattleFight'));
    }, DEATH_BATTLE_FREEZE_MS);
    // Safety net: a round where nobody can finish anybody off (everyone hiding,
    // a wedged client) would otherwise block every later round forever.
    clearTimeout(_db.maxTimer);
    _db.maxTimer = safeTimeout('dbMax', () => _dbFinish(true), DEATH_BATTLE_MAX_MS);
    _dbBroadcast();
  }

  // Sends a death-battle entrant back to the floor+spot they were actually
  // standing in before deployment (see _dbStart, above). The move itself has
  // to run through that specific connection's own socket.data._forceEnterLocation
  // (force accepts the raw floor id _dbPrevFloor holds, and pos restores the
  // exact previous spot instead of that floor's default spawn) — this works
  // the same whether it's called from that connection's own handler (the
  // winner closing the reward modal) or, the common case, from module-level
  // scheduling code with no socket of its own (an elimination, the round
  // ending under everyone still standing).
  function _dbReturnEntrant(socketId) {
    const arenaRoom = getRoom(FLOOR_IDS.arena);
    const p = arenaRoom ? arenaRoom.players.get(socketId) : null;
    if (!p) return null;
    const floor = p._dbPrevFloor || FLOOR_IDS.hub;
    const pos = (p._dbPrevX != null && p._dbPrevY != null) ? { x: p._dbPrevX, y: p._dbPrevY } : null;
    // Came from the arena itself (see _dbStart's own note on walk-in entrants):
    // there is no floor to change to, and _forceEnterLocation would report that
    // as a failure. Undo the deploy in place instead — pvpMode in particular,
    // which deathBattleDeploy set and which only the setPlayerChar inside a
    // real transition would otherwise clear, so returning null here left an
    // eliminated entrant flagged for open PvP on the arena floor.
    if (playerFloorMap.get(socketId) === floor) {
      // pvpMode only. hp is deliberately left alone: a real transition would
      // have re-seated it from the saved record (setPlayerChar), and on the
      // paths that need it the caller heals right after anyway — the 'respawn'
      // handler's own respawnPlayer for an elimination, nothing at all for a
      // timeout, where the entrant is still standing and their current hp is
      // the honest one.
      p.pvpMode = false;
      p._profileRev++;
      if (pos && arenaRoom.canStandAt(pos.x, pos.y)) { p.x = pos.x; p.y = pos.y; }
      return { x: p.x, y: p.y };
    }
    const sock = io.sockets.sockets.get(socketId);
    if (!sock?.data?._forceEnterLocation?.(floor, { pos })) return null;
    const newRoom = getRoom(floor);
    const np = newRoom ? newRoom.players.get(socketId) : null;
    return np ? { x: np.x, y: np.y } : null;
  }

  // Drops one entrant out of a running round. Safe to call for a socket that
  // isn't in the round (a normal PvP kill elsewhere, an unrelated disconnect) —
  // it returns immediately. killerSocketId is only ever set when this came from
  // an actual pvpAttack/pvpSkillAttack hit (see _pvpEliminate) — dying to a
  // monster mid-round (the 'respawn' path) or a disconnect leaves it undefined,
  // and no kill/death pair is recorded for those.
  function _dbEliminate(socketId, killerSocketId) {
    if (_db.phase !== 'live') return false;
    const victim = _db.alive.get(socketId);
    if (!_db.alive.delete(socketId)) return false;
    const spot = _dbReturnEntrant(socketId);
    io.to(socketId).emit('deathBattleEliminated', { left: _db.alive.size, x: spot?.x, y: spot?.y });
    if (killerSocketId) {
      const killer = _db.alive.get(killerSocketId);
      const victimTid = _socketTid(socketId), killerTid = _socketTid(killerSocketId);
      if (victimTid) _recordPvpHistory(victimTid, 'death', 'death_battle', killer?.name || null);
      if (killerTid) _recordPvpHistory(killerTid, 'kill', 'death_battle', victim?.name || null);
    }
    _dbBroadcast();
    if (_db.alive.size <= 1) _dbFinish(false);
    return true;
  }

  async function _dbFinish(timedOut) {
    if (_db.phase !== 'live') return;
    clearTimeout(_db.maxTimer);
    clearTimeout(_db.freezeTimer);
    _db.phase = 'idle';
    _db.fightAt = 0;
    // A timeout has no winner: send everyone still standing back to wherever
    // they each came from (see _dbReturnEntrant).
    const winnerId = (!timedOut && _db.alive.size === 1) ? [..._db.alive.keys()][0] : null;
    _db.alive.forEach((_, sid) => {
      if (sid === winnerId) return;
      const spot = _dbReturnEntrant(sid);
      io.to(sid).emit('deathBattleEliminated', { left: 0, x: spot?.x, y: spot?.y });
    });
    _db.alive.clear();
    _db.winnerId = winnerId;
    if (winnerId) {
      // Everyone else in this match already has a 'death' history row from
      // _dbEliminate on their way out — the winner is the only one who still
      // needs an outcome recorded here. A timeout with no winner records
      // nothing (nobody won or lost, the clock just ran out).
      const winnerTid = _socketTid(winnerId);
      if (winnerTid) _recordPvpHistory(winnerTid, 'win', 'death_battle', null);
      const s = io.sockets.sockets.get(winnerId);
      // The prize is granted through the winner's own socket closure, which is
      // where its inventory/GRAM copies live (same reasoning as pickupWorldDrop).
      const won = s?.data?._dbGrantWin ? await s.data._dbGrantWin() : null;
      // Season points for taking the match, on top of the participation ones
      // already paid at deploy. Awarded here rather than inside _dbGrantWin so
      // it lands on a timed-out-but-still-won match too, and stays next to the
      // 3v3 equivalent in _a3Finish.
      s?.data?._seasonAwardWin?.('deathbattle');
      if (s) s.emit('deathBattleWon', {
        gram: DEATH_BATTLE_GRAM_REWARD,
        items: (won && won.items) || [],
        delivered: !!(won && won.delivered),
      });
    }
    _dbSchedule();
    _dbBroadcast();
  }

  return {
    _db, _dbFrozen, _dbNextStartAt, _dbPublicState, _dbBroadcast, _dbSchedule,
    _dbOpenReg, _dbStart, _dbReturnEntrant, _dbEliminate, _dbFinish,
  };
};
