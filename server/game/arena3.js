'use strict';
// 3v3 Arena (Арена 3х3) queue/deploy/eliminate, moved out of server/index.js
// verbatim as a factory (createArena3(deps)) — same pattern as death-battle.js.
// The cross-mode glue that reaches into this module's `_a3` state from outside
// — _socketTid, _reclaimQueues, _pvpFrozen, _pvpEliminate — stays in index.js,
// since it also reaches into Death Battle/race10/Fear/Coop state the same way;
// see index.js's own comment where those are still defined.
const {
  ARENA3_DAYS_MSK, ARENA3_HOURS_MSK, ARENA3_WINDOW_MS,
  EVENT_NOTIFY_BEFORE_MS, nextEventStartAt,
} = require('../../shared/definitions');
const { FLOOR_IDS } = require('../game/floors');

module.exports = function createArena3(deps) {
  const {
    io, getRoom, logPlayer, _recordPvpHistory, _returnToHub, _findPlayerAnyFloor, _socketTid,
    notifyEventSoon, broadcastLeadMs, notifyEventStarted, safeTimeout,
    DAILY_DUNGEON_ATTEMPTS, _arena3AttemptsLeft, _lockArena3Daily,
  } = deps;

  // ── 3v3 Arena (Арена 3х3) ───────────────────────────────────────────────────
  // Queue-driven team PvP: six players sign up, get split at random into two
  // teams of three, and are dropped into the three-lane arena (see pvpArena in
  // server/game/dungeon.js). Allies cannot damage each other; the team with
  // anyone left standing wins. Unlike the death battle this has no scheduled
  // slot — it fires whenever six people are waiting.
  const ARENA3_TEAM_SIZE   = 3;
  const ARENA3_NEEDED      = ARENA3_TEAM_SIZE * 2;
  const ARENA3_MIN_LEVEL   = 15;
  const ARENA3_FREEZE_MS   = 10 * 1000;   // shorter than the death battle's: six known players, no scatter to take in
  const ARENA3_REWARD      = 10;          // Liberty (Nexum) per winner

  // A real match clock now (it used to be a 30-minute operational guard only,
  // back when the rules said a match ran until one side was wiped out however
  // long that took). Counted from when the fight itself starts (_a3.fightAt),
  // not from deploy — the freeze countdown doesn't eat into it. If nobody wipes
  // the other team or drops their guard boss to 0 before this runs out, the
  // match ends with no winner and no reward (see the wedged path in _a3Finish).
  const ARENA3_ROUND_MS    = 3 * 60 * 1000;

  const _a3 = {
    phase: 'idle',       // 'idle' → 'reg' (21:00–22:00 MSK window) → 'idle'
    queue: new Map(),   // socketId -> { name, lvl }
    live: false,
    starting: false,    // guards the async attempt re-check inside _a3TryStart
    teams: new Map(),   // socketId -> 'A' | 'B'
    alive: new Map(),   // socketId -> { name, team }
    names: new Map(),   // socketId -> name, kept for the result screen after elimination
    fightAt: 0,
    roundEndAt: 0,       // fightAt + ARENA3_ROUND_MS — pushed to clients so they can show a countdown
    freezeTimer: null,
    roundTimer: null,
    openTimer: null, closeTimer: null, notifyTimer: null,
  };

  // Next scheduled window open, in UTC ms — every day, 21:00 Moscow. Same
  // nextEventStartAt helper the death battle/world boss/race10 schedules use.
  function _a3NextOpenAt(from = Date.now()) {
    return nextEventStartAt(ARENA3_DAYS_MSK, ARENA3_HOURS_MSK, from);
  }

  function _a3PublicState() {
    return {
      phase:   _a3.phase,
      nextAt:  _a3NextOpenAt(),
      queued: _a3.queue.size,
      needed: ARENA3_NEEDED,
      live: _a3.live,
      minLevel: ARENA3_MIN_LEVEL,
      reward: ARENA3_REWARD,
      maxAttempts: DAILY_DUNGEON_ATTEMPTS,
    };
  }

  // Only the people waiting or fighting care about this, so it goes to them
  // rather than the whole floor.
  function _a3Broadcast() {
    const st = _a3PublicState();
    // To EVERYONE, not just to the queue and the players in a live match. The
    // queue size is the one number on this panel that changes because of what
    // other people do, and it was only ever pushed to people who had already
    // signed up — so anyone sitting on the panel deciding whether to join saw
    // whatever count happened to be in their last gameStart or arena3Sync and
    // watched it never move. That is the "счётчик записанных неправильно
    // считается" report: the figure was not wrong when it was sent, it was
    // simply never sent again.
    //
    // Safe to send without a `registered` field: the client only overwrites its
    // own flag when the field is actually present (see the arena3State handler,
    // js/network.js), so a broadcast cannot un-register anybody. The per-socket
    // push below is what carries the flag to the people it is true for.
    io.emit('arena3State', st);
    _a3.queue.forEach((_, sid) => io.to(sid).emit('arena3State', { ...st, registered: true }));
  }

  // Arms the next daily window (21:00 MSK) plus its 30-minute warning. Called
  // at boot and after every window closes — same shape as _race10Schedule.
  function _a3Schedule() {
    clearTimeout(_a3.openTimer);
    clearTimeout(_a3.notifyTimer);
    _a3.phase = 'idle';
    const openAt = _a3NextOpenAt();
    _a3.openTimer = safeTimeout('a3Open', () => _a3OpenWindow(openAt), Math.max(0, openAt - Date.now()));
    // Сдвиг на длительность самого прохода. Telegram принимает около тридцати
    // сообщений в секунду, и четыре тысячи адресатов — это больше двух минут:
    // предупреждение «за 30 минут», отправленное ровно за тридцать, доходило до
    // конца очереди за двадцать восемь. Начинаем раньше на столько, сколько
    // проход занимает, — и последний получает свои тридцать.
    const warnIn = openAt - EVENT_NOTIFY_BEFORE_MS - broadcastLeadMs() - Date.now();
    if (warnIn > 0) _a3.notifyTimer = safeTimeout('a3Notify', () => notifyEventSoon('a3', openAt), warnIn);
  }

  // Opens the hour-long registration window. Like race10, the queue keeps
  // trying for the whole hour — more than one match can fire if enough
  // players keep signing up.
  function _a3OpenWindow(openAt) {
    _a3.phase = 'reg';
    notifyEventStarted('a3', openAt);
    clearTimeout(_a3.closeTimer);
    _a3.closeTimer = safeTimeout('a3Close', _a3CloseWindow, ARENA3_WINDOW_MS);
    _a3Broadcast();
    _a3TryStartSafe();
  }

  // Closes the window at 22:00 MSK. Anyone still only queued is bumped back to
  // "not registered" — a match already under way keeps running on its own
  // ARENA3_ROUND_MS clock regardless.
  function _a3CloseWindow() {
    _a3.phase = 'idle';
    [..._a3.queue.keys()].forEach(sid => {
      io.to(sid).emit('arena3Registered', { registered: false });
      io.to(sid).emit('arena3Error', { msg: 'Окно арены 3х3 закрылось — до встречи в 21:00' });
    });
    _a3.queue.clear();
    _a3Schedule();
    _a3Broadcast();
  }

  function _a3Frozen(socketId) {
    return _a3.live && Date.now() < _a3.fightAt && _a3.alive.has(socketId);
  }

  // True only for two players on the SAME side of a running match — that is the
  // one case where PvP has to be refused inside the arena.
  function _a3Allies(a, b) {
    if (!_a3.live) return false;
    const ta = _a3.teams.get(a), tb = _a3.teams.get(b);
    return !!ta && ta === tb;
  }
  // ...and this is the opposite: two players on OPPOSITE sides, who must be able
  // to hit each other even if they share a party or a clan.
  function _a3Enemies(a, b) {
    if (!_a3.live) return false;
    const ta = _a3.teams.get(a), tb = _a3.teams.get(b);
    return !!ta && !!tb && ta !== tb;
  }

  // _a3TryStart is async now (it re-checks daily attempts against the DB), and
  // every caller fires it without waiting — this keeps a failed launch from
  // surfacing as an unhandled rejection and taking the process down.
  function _a3TryStartSafe() { _a3TryStart().catch(err => console.error('_a3TryStart:', err)); }

  async function _a3TryStart() {
    // _a3.starting covers the await below: without it two callers could both
    // pass the _a3.live check while the attempt re-check is in flight and
    // deploy two matches into the one arena.
    if (_a3.live || _a3.starting) return;
    const room = getRoom(FLOOR_IDS.pvpArena);
    if (!room) return;
    // Only entrants still connected and still standing in the world can be
    // deployed; anyone else is dropped from the queue rather than counted.
    // Registration never required being on any particular floor, so this
    // checks wherever each one actually is, not just the hub.
    const ready = [..._a3.queue.keys()].filter(sid =>
      io.sockets.sockets.get(sid) && _findPlayerAnyFloor(sid));
    const _pruned = [..._a3.queue.keys()].filter(sid => !ready.includes(sid));
    _pruned.forEach(sid => _a3.queue.delete(sid));
    // This dropped players from the queue silently — _a3PublicState().queued
    // (a plain _a3.queue.size) kept reporting the pre-prune count to everyone
    // still waiting until the next registration/unregistration happened to
    // re-broadcast. That's exactly "показывает больше чем зарегистрировано":
    // the count stays inflated by however many quietly disconnected, and if
    // that's what pushed it over ARENA3_NEEDED, the match then also never
    // starts — the ready count right below is the honest one, but nobody
    // downstream saw it until someone else registered.
    if (_pruned.length) _a3Broadcast();
    if (ready.length < ARENA3_NEEDED) return;

    _a3.starting = true;
    try {
      await _a3Deploy(ready, room);
    } finally {
      _a3.starting = false;
    }
  }

  async function _a3Deploy(ready, room) {
    const picked = ready.slice(0, ARENA3_NEEDED);

    // Attempts are re-checked against fresh DB state right before launch, not
    // just at sign-up: someone can burn their last attempt in another session
    // while sitting in this queue. Anyone out of attempts is dropped and the
    // launch is retried with whoever is left.
    const spent = await Promise.all(picked.map(sid => _arena3AttemptsLeft(sid)));
    const outOfAttempts = picked.filter((sid, i) => spent[i] <= 0);
    if (outOfAttempts.length) {
      outOfAttempts.forEach(sid => {
        _a3.queue.delete(sid);
        io.to(sid).emit('arena3Error', { msg: 'Попытки на арену на сегодня закончились' });
        io.to(sid).emit('arena3Registered', { registered: false });
      });
      _a3Broadcast();
      // Each pass removes at least one entrant, so this can't loop forever.
      // Deferred so _a3.starting has been cleared by the caller's finally.
      setImmediate(_a3TryStartSafe);
      return;
    }
    // Fisher-Yates, so the split is genuinely random rather than "first three to
    // press the button are one team".
    for (let i = picked.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [picked[i], picked[j]] = [picked[j], picked[i]];
    }
    const teamA = picked.slice(0, ARENA3_TEAM_SIZE);
    const teamB = picked.slice(ARENA3_TEAM_SIZE);

    _a3.live = true;
    _a3.teams.clear(); _a3.alive.clear(); _a3.names.clear();
    _a3.fightAt = Date.now() + ARENA3_FREEZE_MS;
    _a3.roundEndAt = _a3.fightAt + ARENA3_ROUND_MS;

    // pvpArenaDeploy below needs everyone already present in room.players to
    // lay out the two bases — force each entrant's own connection onto the
    // pvpArena floor first (bypassing any gate: this is a matchmade deploy,
    // not a walk-in, and there is none to bypass anyway — see _doEnterLocation).
    //
    // Each one is joined AT the base slot it is about to be given, not at the
    // floor's default spawn. That default is the middle of the arena
    // (generateArena3's `spawn` is the centre tile), and joining is also what
    // builds gameStart — so gameStart went out saying "you are in the middle of
    // the map", pvpArenaDeploy moved them to their base a moment later, and
    // arena3Started reported the real spot. The client applies arena3Started
    // immediately but defers gameStart behind the world-map fetch on a first
    // visit to this floor, so the stale centre position won by arriving last
    // and both teams appeared standing on each other in the middle. Exactly the
    // Bloody Tower's bug, on a different floor.
    //
    // Indexed by how many have actually joined, not by position in the source
    // list: pvpArenaDeploy indexes the array it RECEIVES, so a player who fails
    // to join would otherwise shift everyone behind them onto a different slot
    // than the one they were placed at.
    const _ar = room.pvpArenaSlots();
    const _joinTeam = (ids, spots) => {
      const out = [];
      ids.forEach(sid => {
        const pos = (spots && spots.length) ? spots[out.length % spots.length] : undefined;
        if (io.sockets.sockets.get(sid)?.data?._forceEnterLocation?.('pvpArena', { pos })) out.push(sid);
      });
      return out;
    };
    const joinedA = _joinTeam(teamA, _ar.teamA);
    const joinedB = _joinTeam(teamB, _ar.teamB);

    const placed = room.pvpArenaDeploy(joinedA, joinedB);
    // Someone can vanish between the readiness filter above and the deploy. A
    // side with nobody on it would never trigger the win check — no one is left
    // to be killed — and with no match timer that would hold the arena until the
    // round guard fired. Put everyone back and wait instead.
    if (placed.filter(p => p.team === 'A').length === 0 ||
        placed.filter(p => p.team === 'B').length === 0) {
      placed.forEach(({ socketId }) => _returnToHub(socketId));
      _a3.live = false;
      _a3.fightAt = 0;
      _a3.roundEndAt = 0;
      _a3Broadcast();
      return;
    }
    placed.forEach(({ socketId, team }) => {
      const name = _a3.queue.get(socketId)?.name || '?';
      _a3.teams.set(socketId, team);
      _a3.alive.set(socketId, { name, team });
      _a3.names.set(socketId, name);
      _a3.queue.delete(socketId);
      // The attempt is spent the moment the match starts, win or lose. Only
      // players actually deployed are charged, so a cancelled launch costs
      // nobody anything.
      _lockArena3Daily(socketId);
      // ── очков сезона арена 3х3 НЕ даёт ────────────────────────────────────
      // Решение владельца. Здесь начислялись очки «за участие», ниже — «за
      // победу»; оба вызова сняты. Сезон считает вещи, а не бои: заточку,
      // сжигание, книги. Три на три от них не зависит и в зачёт не идёт.
      //
      // Строки оставлены пустыми намеренно — чтобы следующий читатель видел,
      // что начисление отсюда УБРАЛИ, а не забыли добавить.
    });
    // Rosters are only known once everyone is placed, so this is a second pass.
    const roster = placed.map(p => ({ id: p.socketId, name: _a3.names.get(p.socketId), team: p.team }));
    placed.forEach(({ socketId, x, y, hp, team }) => {
      io.to(socketId).emit('arena3Started', {
        x, y, hp, team, fightAt: _a3.fightAt, roundEndAt: _a3.roundEndAt, roster,
      });
      logPlayer(_socketTid(socketId), _a3.names.get(socketId), 'arena3_start', { team });
    });

    clearTimeout(_a3.freezeTimer);
    _a3.freezeTimer = safeTimeout('a3Freeze', () => {
      if (!_a3.live) return;
      _a3.alive.forEach((_, sid) => io.to(sid).emit('arena3Fight', { roundEndAt: _a3.roundEndAt }));
    }, ARENA3_FREEZE_MS);

    clearTimeout(_a3.roundTimer);
    _a3.roundTimer = safeTimeout('a3Round', () => _a3Finish(null, true), ARENA3_FREEZE_MS + ARENA3_ROUND_MS);
    _a3Broadcast();
  }

  // Knocks one player out. Safe to call for anyone not in a match — a normal PvP
  // kill elsewhere, an unrelated disconnect — it returns immediately.
  // killerSocketId (only set by an actual pvpAttack/pvpSkillAttack hit, see
  // _pvpEliminate) records the kill/death pair; a monster/disconnect
  // elimination leaves it undefined and records nothing.
  function _a3Eliminate(socketId, killerSocketId) {
    if (!_a3.live) return false;
    const rec = _a3.alive.get(socketId);
    if (!rec) return false;
    _a3.alive.delete(socketId);
    const spot = _returnToHub(socketId);
    io.to(socketId).emit('arena3Eliminated', { x: spot?.x, y: spot?.y });
    if (killerSocketId) {
      const killerRec = _a3.alive.get(killerSocketId);
      const victimTid = _socketTid(socketId), killerTid = _socketTid(killerSocketId);
      if (victimTid) _recordPvpHistory(victimTid, 'death', 'arena3', killerRec?.name || null);
      if (killerTid) _recordPvpHistory(killerTid, 'kill', 'arena3', rec?.name || null);
    }
    const aliveA = [..._a3.alive.values()].filter(r => r.team === 'A').length;
    const aliveB = [..._a3.alive.values()].filter(r => r.team === 'B').length;
    // Sent relative to each recipient — "mine" is always their own side, so the
    // client can always render itself as the blue half of the score and the
    // opponent as the red half, regardless of which internal team (A/B) either
    // side actually got assigned.
    _a3.alive.forEach((_, sid) => {
      const mine  = _a3.teams.get(sid) === 'A' ? aliveA : aliveB;
      const enemy = _a3.teams.get(sid) === 'A' ? aliveB : aliveA;
      io.to(sid).emit('arena3Score', { mine, enemy });
    });
    if (aliveA === 0 || aliveB === 0) {
      _a3Finish(aliveA === 0 && aliveB === 0 ? null : (aliveA === 0 ? 'B' : 'A'), false);
    }
    return true;
  }

  async function _a3Finish(winner, wedged) {
    if (!_a3.live) return;
    clearTimeout(_a3.freezeTimer);
    clearTimeout(_a3.roundTimer);
    _a3.live = false;
    _a3.fightAt = 0;
    _a3.roundEndAt = 0;
    // The match is decided by wiping the other side — there are no guard
    // bosses to knock down as a shortcut any more, so this needs nothing torn
    // down between rounds.
    // Everyone still standing goes home too — the match is over for them as
    // well, they just didn't die to get there.
    _a3.alive.forEach((_, sid) => _returnToHub(sid));

    const teams = new Map(_a3.teams);
    const names = new Map(_a3.names);
    _a3.teams.clear(); _a3.alive.clear(); _a3.names.clear();

    for (const [sid, team] of teams) {
      const won = !!winner && team === winner;
      const s = io.sockets.sockets.get(sid);
      let reward = 0;
      if (won && s?.data?._a3GrantWin) {
        reward = await s.data._a3GrantWin();
      }
      // Every player on the winning side gets the full amount — it is a team
      // result, not a pot split three ways.
      // Очков за победу тоже нет — см. выше.
      io.to(sid).emit('arena3Result', { won, winner, wedged: !!wedged, reward, team });
      logPlayer(_socketTid(sid), names.get(sid), 'arena3_end',
        { team, result: winner ? (won ? 'win' : 'lose') : (wedged ? 'wedged' : 'draw'), reward });
      // Team result, independent of whether this player personally got
      // eliminated mid-match (already its own 'death' row from _a3Eliminate if
      // so) — a wedged/no-winner match records neither.
      if (winner) {
        const tid = _socketTid(sid);
        if (tid) _recordPvpHistory(tid, won ? 'win' : 'lose', 'arena3', null);
      }
    }
    _a3Broadcast();
    // A queue that filled up while this match ran starts the next one straight
    // away rather than waiting for someone to press register again.
    _a3TryStartSafe();
  }

  return {
    ARENA3_TEAM_SIZE, ARENA3_NEEDED, ARENA3_MIN_LEVEL, ARENA3_FREEZE_MS, ARENA3_REWARD, ARENA3_ROUND_MS,
    _a3, _a3NextOpenAt, _a3PublicState, _a3Broadcast, _a3Schedule, _a3OpenWindow, _a3CloseWindow,
    _a3Frozen, _a3Allies, _a3Enemies, _a3TryStartSafe, _a3TryStart, _a3Deploy, _a3Eliminate, _a3Finish,
  };
};
