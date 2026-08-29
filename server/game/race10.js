'use strict';
// Кровавая Башня (Bloody Tower corridor race), moved out of server/index.js
// verbatim as a factory (createRace10(deps)), same pattern as the other
// game-mode managers. _race10Frozen and _race10Eliminate are also called
// from index.js's own cross-mode glue (_pvpFrozen/_pvpEliminate) and from
// _reclaimQueues/_rekeyQueue, which stay in index.js since they reach into
// more than one manager's state.
const {
  RACE10_DAYS_MSK, RACE10_HOURS_MSK, RACE10_LIBERTY, RACE10_LIBERTY_WINNER,
  EVENT_NOTIFY_BEFORE_MS, nextEventStartAt,
} = require('../../shared/definitions');
const { FLOOR_IDS } = require('../game/floors');

module.exports = function createRace10(deps) {
  const {
    io, getRoom, logPlayer, _recordPvpHistory, _returnToHub, _findPlayerAnyFloor, _socketTid,
    notifyEventSoon, broadcastLeadMs, notifyEventStarted, safeTimeout,
    _race10AttemptsLeft, _lockRace10Daily,
  } = deps;

  // ── Кровавая Башня (corridor race) ──────────────────────────────────────────
  // Registration opens at 20:30 MSK and everyone who signs up runs — no fixed
  // headcount. RACE10_REG_MS later the whole field starts at once, one sealed
  // lane each (server/game/dungeon.js race10): 60 level-5 monsters then 60
  // level-10, packed shoulder to shoulder, no way past but through. Every lane
  // ends at the same shared room and the same single boss (spawnRaceBoss,
  // server/game/Room.js): whoever has dealt it the most cumulative damage when
  // it dies wins Liberty. Dying anywhere in a lane is an elimination — handled
  // by the existing 'respawn' handler via _pvpEliminate, the same wiring the
  // death battle and 3v3 arena already share, so a monster kill in the corridor
  // counts exactly like a PvP kill would.
  //
  // It used to fire the moment ten players were queued, and could run several
  // times in the hour. One start with everyone in it replaces that, which is
  // also what makes a single daily attempt fair: miss the five minutes and you
  // miss the day, rather than losing your one attempt to a race that filled up
  // without you.
  //
  // How many can enter is a property of the map, not of this file: lanes are
  // carved at world generation and never change, so the ceiling is however many
  // exist (read below from the dungeon, not hardcoded here).
  const RACE10_MIN_PLAYERS = 2;            // a race of one has nobody to race
  const RACE10_REG_MS    = 5 * 60 * 1000;  // registration window before the start
  const RACE10_ATTEMPTS  = 1;              // per UTC day — its own limit, not the shared dungeon pool
  const RACE10_MIN_LEVEL = 10;
  const RACE10_FREEZE_MS = 10 * 1000;
  // Liberty (Nexum) and potions, from shared/definitions.js so the client's
  // events panel advertises exactly what the server pays. Two tiers: every
  // entrant who landed at least one hit ON THE BOSS takes RACE10_LIBERTY plus
  // one of each buff potion, and the top damage-dealer takes
  // RACE10_LIBERTY_WINNER plus two of each instead. Corridor kills do not
  // qualify anybody — only damage to the shared boss is tallied
  // (_race10TrackHit), so the corridors still have to be run to be paid.
  const RACE10_REWARD    = RACE10_LIBERTY;
  // Operational guard only, same idea as the 3v3 arena's old wedge — ends the
  // race with no winner if the boss just never comes down, so the one shared
  // instance can't be tied up forever.
  const RACE10_MAX_MS    = 15 * 60 * 1000;

  // The map's lane count — the hard ceiling on entrants. Read once the world
  // exists; before that (nobody can register yet) it reports 0.
  // How many entrants the Tower can actually take. Usable corridors, not the
  // raw lane count: an entry point that is not standable is not a slot anyone
  // can be given, and advertising it would promise a place that deploy would
  // then have to refuse.
  function _race10Capacity() {
    const room = getRoom(FLOOR_IDS.race10);
    return room ? room.raceUsableLanes().length : 0;
  }

  const _race10 = {
    phase: 'idle',        // 'idle' → 'reg' (20:30 MSK, RACE10_REG_MS window) → 'idle'
    queue: new Map(),    // socketId -> { name, lvl }
    live: false,
    starting: false,     // guards the async attempt re-check inside _race10TryStart
    alive: new Map(),    // socketId -> { name, lane } — still in a lane or the boss room
    names: new Map(),    // socketId -> name, kept for the result screen after elimination
    dmg: new Map(),      // socketId -> cumulative damage dealt to the shared boss
    bossId: null,
    fightAt: 0,
    startAt: 0,          // when the field is deployed — registration closes then
    freezeTimer: null,
    maxTimer: null,
    startTimer: null,
    openTimer: null, notifyTimer: null,
  };

  // Next scheduled window open, in UTC ms — every day, 20:30 Moscow. Lives in
  // shared/definitions.js (RACE10_DAYS_MSK/HOURS_MSK) so it's computed the
  // same way the death battle's and world boss's own schedules are.
  function _race10NextOpenAt(from = Date.now()) {
    return nextEventStartAt(RACE10_DAYS_MSK, RACE10_HOURS_MSK, from);
  }

  function _race10PublicState() {
    return {
      phase:   _race10.phase,
      nextAt:  _race10NextOpenAt(),
      queued: _race10.queue.size,
      // No headcount to reach any more; the client shows the queue size and
      // counts down to startAt instead. `capacity` is the lane ceiling.
      startAt: _race10.startAt,
      capacity: _race10Capacity(),
      minPlayers: RACE10_MIN_PLAYERS,
      live: _race10.live,
      minLevel: RACE10_MIN_LEVEL,
      // Both tiers, so the panel advertises exactly what gets paid rather than
      // only the winner's line: `reward` is what every entrant who lands a hit
      // on the boss takes, `winReward` what the top damage-dealer takes instead.
      reward: RACE10_REWARD,
      winReward: RACE10_LIBERTY_WINNER,
      maxAttempts: RACE10_ATTEMPTS,
    };
  }

  function _race10Broadcast() {
    const st = _race10PublicState();
    // Same reasoning as _a3Broadcast above — the queue size is only interesting
    // to someone who has NOT signed up yet, and they were the one group never
    // told when it changed.
    io.emit('race10State', st);
    _race10.queue.forEach((_, sid) => io.to(sid).emit('race10State', { ...st, registered: true }));
  }

  // Arms the next daily window (20:30 MSK) plus its 30-minute warning. Called
  // at boot and after every window closes; if the process starts inside the
  // window itself the open-timeout is already due and fires immediately with
  // whatever time is left, same as _dbSchedule.
  function _race10Schedule() {
    clearTimeout(_race10.openTimer);
    clearTimeout(_race10.notifyTimer);
    _race10.phase = 'idle';
    const openAt = _race10NextOpenAt();
    _race10.openTimer = safeTimeout('race10Open', () => _race10OpenWindow(openAt), Math.max(0, openAt - Date.now()));
    // Сдвиг на длительность самого прохода. Telegram принимает около тридцати
    // сообщений в секунду, и четыре тысячи адресатов — это больше двух минут:
    // предупреждение «за 30 минут», отправленное ровно за тридцать, доходило до
    // конца очереди за двадцать восемь. Начинаем раньше на столько, сколько
    // проход занимает, — и последний получает свои тридцать.
    const warnIn = openAt - EVENT_NOTIFY_BEFORE_MS - broadcastLeadMs() - Date.now();
    if (warnIn > 0) _race10.notifyTimer = safeTimeout('race10Notify', () => notifyEventSoon('race10', openAt), warnIn);
  }

  // Opens registration at 20:30 MSK and arms the single start RACE10_REG_MS
  // later. Everyone signed up by then runs; there is no headcount to reach and
  // no second race in the same window, so the five minutes are the whole of the
  // opportunity — which is what the 30-minute warning broadcast is for. The
  // window closes itself the moment that single start attempt is processed
  // (_race10Start below calls _race10CloseWindow once it's done, win or no
  // players) — there's nothing left to wait around for after that.
  // regMs is only ever passed by the local dev opener (see the DEV_LOCAL block
  // near the top of this file) so the event can be exercised without waiting for
  // 20:30; the scheduled path always uses RACE10_REG_MS.
  function _race10OpenWindow(openAt, regMs = RACE10_REG_MS) {
    _race10.phase = 'reg';
    _race10.startAt = Date.now() + regMs;
    notifyEventStarted('race10', openAt);
    clearTimeout(_race10.startTimer);
    _race10.startTimer = safeTimeout('race10Start', _race10StartSafe, regMs);
    _race10Broadcast();
  }

  // Closes registration early — either RACE10_REG_MS after opening, once
  // _race10Start has processed the day's one attempt (silent: true, since
  // anyone still queued by then already got a more specific message about why),
  // or from an admin's manual "close now" (server-authoritative, no silent
  // flag — those callers want the generic notice). Either way there is no
  // second start left in this window, so this always re-arms tomorrow's.
  function _race10CloseWindow(opts = {}) {
    _race10.phase = 'idle';
    _race10.startAt = 0;
    clearTimeout(_race10.startTimer);
    if (!opts.silent) {
      [..._race10.queue.keys()].forEach(sid => {
        io.to(sid).emit('race10Registered', { registered: false });
        io.to(sid).emit('race10Error', { msg: 'Окно Кровавой Башни закрылось — до встречи в 20:30' });
      });
    }
    _race10.queue.clear();
    _race10Schedule();
    _race10Broadcast();
  }

  function _race10Frozen(socketId) {
    return _race10.live && Date.now() < _race10.fightAt && _race10.alive.has(socketId);
  }

  // The scheduled start fires once per window; async because it re-checks daily
  // attempts against the DB, and never awaited by its caller (a timer), so the
  // rejection has to be caught here.
  function _race10StartSafe() { _race10Start().catch(err => console.error('_race10Start:', err)); }

  async function _race10Start() {
    if (_race10.live || _race10.starting) return;
    _race10.startAt = 0;
    const room = getRoom(FLOOR_IDS.race10);
    if (!room) { _race10CloseWindow({ silent: true }); return; }
    // Only entrants still connected and still standing in the world can be
    // deployed; anyone else is dropped rather than counted. Registration never
    // required being on any particular floor, so this checks wherever each one
    // actually is, not just the hub.
    const ready = [..._race10.queue.keys()].filter(sid =>
      io.sockets.sockets.get(sid) && _findPlayerAnyFloor(sid));
    [..._race10.queue.keys()].forEach(sid => { if (!ready.includes(sid)) _race10.queue.delete(sid); });
    if (ready.length < RACE10_MIN_PLAYERS) {
      // Not enough showed up. Nobody is charged an attempt (that happens on
      // deploy) — there is no second start, so this is "not today" and
      // registration closes right along with it (silent: already told these
      // exact sockets why, above).
      ready.forEach(sid => io.to(sid).emit('race10Error', {
        msg: `Забег отменён — нужно минимум ${RACE10_MIN_PLAYERS} участника`,
      }));
      _race10CloseWindow({ silent: true });
      return;
    }

    _race10.starting = true;
    try {
      await _race10Deploy(ready, room);
    } finally {
      _race10.starting = false;
      // One start per window, successful or not — close registration the
      // moment it's been attempted (queue is already drained by _race10Deploy
      // either way, so this is just phase/reschedule bookkeeping by now).
      _race10CloseWindow();
    }
  }

  async function _race10Deploy(ready, room) {
    // Everyone who registered, capped only by how many corridors the map has.
    // Anyone past that is told plainly rather than being silently dropped into
    // somebody else's lane.
    const capacity = room.raceUsableLanes().length;
    const picked = ready.slice(0, capacity);
    ready.slice(capacity).forEach(sid => {
      _race10.queue.delete(sid);
      io.to(sid).emit('race10Registered', { registered: false });
      io.to(sid).emit('race10Error', { msg: `В Башне только ${capacity} коридоров — сегодня не хватило места` });
    });

    // Re-checked against fresh DB state right before launch, not just at
    // sign-up — same reasoning as the 3v3 arena's own re-check.
    const spent = await Promise.all(picked.map(sid => _race10AttemptsLeft(sid)));
    const outOfAttempts = picked.filter((sid, i) => spent[i] <= 0);
    // Anyone who used their attempt elsewhere since signing up is dropped, and
    // the race goes ahead with the rest — there is only one start per window, so
    // retrying the whole launch (as the queue-driven version did) would just
    // cancel the event for everybody.
    const running = picked.filter((sid, i) => spent[i] > 0);
    outOfAttempts.forEach(sid => {
      _race10.queue.delete(sid);
      io.to(sid).emit('race10Error', { msg: 'Попытки в Кровавую Башню на сегодня закончились' });
      io.to(sid).emit('race10Registered', { registered: false });
    });
    if (running.length < RACE10_MIN_PLAYERS) {
      running.forEach(sid => io.to(sid).emit('race10Error', {
        msg: `Забег отменён — нужно минимум ${RACE10_MIN_PLAYERS} участника`,
      }));
      _race10Broadcast();
      return;
    }

    _race10.live = true;
    _race10.alive.clear(); _race10.names.clear(); _race10.dmg.clear();
    _race10.fightAt = Date.now() + RACE10_FREEZE_MS;

    // Every lane's monsters have to be back at full strength before this race
    // starts — they don't respawn on their own (see Room.js's tick loop), so a
    // second race later in the same window would otherwise find them still
    // dead from the first one.
    room.resetRaceMonsters();
    // raceDeploy below needs everyone already present in room.players to
    // assign lanes — force each entrant's own connection onto the race10
    // floor first (bypassing any gate: this is a scheduled deploy, not a
    // walk-in, and there is none to bypass anyway — see _doEnterLocation).
    //
    // Each one is joined AT the lane it is about to be given, rather than at the
    // floor's default spawn. That default is the middle of the shared boss room
    // (generateRace10), and joining lands a player there for the short moment
    // between the join and raceDeploy below — which would be invisible, except
    // that the join is also what builds gameStart, so gameStart went out saying
    // "you are at the boss". The client applies gameStart's position, and on a
    // first visit to this floor it applies it LATE: the handler defers behind
    // the world-map HTTP fetch (see socket.on('gameStart'), js/network.js),
    // while race10Started — sent moments later with the real lane — arrives and
    // is applied immediately. So the correct placement landed first and the
    // stale one overwrote it, and every entrant's first race of a session
    // started them standing on the boss instead of in their corridor.
    //
    // lanes[joined.length] is the exact lane raceDeploy is about to assign: it
    // hands out lanes by position in the array it receives, and this pushes in
    // the same order. Anyone who fails to join simply is not pushed, so the two
    // stay in step.
    // raceUsableLanes() rather than the raw lane list: a corridor whose entry
    // point is not standable is not a corridor anyone can be given, and it now
    // reduces capacity instead of silently dumping its occupant on the boss.
    // Same list raceDeploy walks, in the same order, so slot n here is the
    // corridor raceDeploy is about to assign as lane n.
    const _laneSpots = room.raceUsableLanes();
    const joined = [];
    running.forEach(sid => {
      if (joined.length >= _laneSpots.length) return;
      const ok = io.sockets.sockets.get(sid)?.data?._forceEnterLocation?.('race10', { pos: _laneSpots[joined.length] });
      if (ok) joined.push(sid);
    });
    const placed = room.raceDeploy(joined);
    _race10.bossId = room.spawnRaceBoss();

    placed.forEach(({ socketId, lane }) => {
      const name = _race10.queue.get(socketId)?.name || '?';
      _race10.alive.set(socketId, { name, lane });
      _race10.names.set(socketId, name);
      _race10.dmg.set(socketId, 0);
      _race10.queue.delete(socketId);
      // Attempt spent the moment the race starts, win or lose — same rule as
      // the 3v3 arena.
      _lockRace10Daily(socketId);
    });

    const roster = placed.map(p => ({ id: p.socketId, name: _race10.names.get(p.socketId), lane: p.lane }));
    placed.forEach(({ socketId, x, y, hp, lane }) => {
      io.to(socketId).emit('race10Started', { x, y, hp, lane, fightAt: _race10.fightAt, roster });
      logPlayer(_socketTid(socketId), _race10.names.get(socketId), 'race10_start', { lane });
    });

    clearTimeout(_race10.freezeTimer);
    _race10.freezeTimer = safeTimeout('race10Freeze', () => {
      if (!_race10.live) return;
      _race10.alive.forEach((_, sid) => io.to(sid).emit('race10Fight'));
    }, RACE10_FREEZE_MS);

    clearTimeout(_race10.maxTimer);
    _race10.maxTimer = safeTimeout('race10Max', () => _race10Finish(null, true), RACE10_FREEZE_MS + RACE10_MAX_MS);
    _race10Broadcast();
  }

  // Knocks one player out — dying anywhere in a lane, to anything. Safe to
  // call for anyone not in the race (a normal death elsewhere), it returns
  // immediately. Their damage tally survives them: "most damage dealt" doesn't
  // require surviving to the end.
  //
  // This always runs from inside the 'respawn' handler (race10 has no PvP —
  // "dying anywhere" only ever means a monster kill), which unconditionally
  // calls currentRoom.respawnPlayer() right after _pvpEliminate returns. Before
  // the split that alone sent an eliminated racer back to spawn, because
  // this._dungeon.spawn WAS the hub's own — respawnPlayer and race10 shared a
  // Room. Now race10 has its own floor (its own default spawn, the boss room),
  // so this has to do the floor change itself first: _returnToHub updates the
  // connection's own currentRoom/currentFloor, so by the time respawnPlayer
  // runs afterward it's already operating on the hub and just re-applies the
  // same standard full-heal-at-spawn every other death in the game gets.
  function _race10Eliminate(socketId) {
    if (!_race10.live) return false;
    if (!_race10.alive.has(socketId)) return false;
    _race10.alive.delete(socketId);
    _returnToHub(socketId);
    io.to(socketId).emit('race10Eliminated', {});
    // Nobody left standing anywhere and the boss is still up — no one can ever
    // land another hit, so there's no point riding out RACE10_MAX_MS.
    if (_race10.alive.size === 0) _race10Finish(null, false);
    return true;
  }

  async function _race10Finish(winnerId, timedOut) {
    if (!_race10.live) return;
    clearTimeout(_race10.freezeTimer);
    clearTimeout(_race10.maxTimer);
    _race10.live = false;
    _race10.fightAt = 0;
    const room = getRoom(FLOOR_IDS.race10);
    if (room) room.despawnRaceBoss();
    // Everyone still standing goes home too — the race is over for them as
    // well, they just didn't die to get there. Eliminated racers (already
    // dropped from _race10.alive by _race10Eliminate) stay put where they
    // fell until they close the result modal — see the race10Return handler.
    _race10.alive.forEach((_, sid) => _returnToHub(sid));

    const names = new Map(_race10.names);
    const dmg = new Map(_race10.dmg);
    const participants = [...names.keys()];
    _race10.alive.clear(); _race10.names.clear(); _race10.dmg.clear(); _race10.bossId = null;

    for (const sid of participants) {
      const won = !!winnerId && sid === winnerId;
      const s = io.sockets.sockets.get(sid);
      // Reaching the boss and landing at least one hit on it is what qualifies
      // for a payout — dmg only ever counts damage to the shared boss
      // (_race10TrackHit), never corridor kills. Someone who died in their
      // corridor, or who ran it but never got a swing in, takes nothing; the
      // winner takes the bigger tier of the same reward.
      const hitTheBoss = (dmg.get(sid) || 0) > 0;
      let reward = 0, rewardItems = [];
      if (hitTheBoss && s?.data?._race10GrantReward) {
        const paid = await s.data._race10GrantReward(won);
        if (paid) { reward = paid.nexum; rewardItems = paid.items; }
      }
      io.to(sid).emit('race10Result', {
        won, winnerName: winnerId ? names.get(winnerId) : null,
        myDamage: dmg.get(sid) || 0, timedOut: !!timedOut, reward,
        items: rewardItems.map(i => ({ id: i.id, name: i.name, img: i.img, qty: i.qty })),
      });
      logPlayer(_socketTid(sid), names.get(sid), 'race10_end', {
        result: winnerId ? (won ? 'win' : 'lose') : (timedOut ? 'timeout' : 'no_survivors'),
        dmg: dmg.get(sid) || 0, reward,
      });
      // No player-vs-player damage in this mode (everyone fights the same
      // shared boss/monsters), so only a win/lose result is recorded — never
      // a kill/death. A timeout/no-survivors race records neither.
      if (winnerId) {
        const tid = _socketTid(sid);
        if (tid) _recordPvpHistory(tid, won ? 'win' : 'lose', 'race10', null);
      }
    }
    _race10Broadcast();
    // No follow-up race: the window holds exactly one start (see
    // _race10OpenWindow), so anyone who missed it waits for tomorrow.
  }

  return {
    RACE10_MIN_PLAYERS, RACE10_REG_MS, RACE10_ATTEMPTS, RACE10_MIN_LEVEL, RACE10_FREEZE_MS,
    RACE10_REWARD, RACE10_MAX_MS,
    _race10, _race10Capacity, _race10NextOpenAt, _race10PublicState, _race10Broadcast, _race10Schedule,
    _race10OpenWindow, _race10CloseWindow, _race10Frozen, _race10StartSafe, _race10Start, _race10Deploy,
    _race10Eliminate, _race10Finish,
  };
};
