'use strict';
// Страх (Fear) — private on-demand wave-survival instances, moved out of
// server/index.js verbatim as a factory (createFear(deps)). Unlike
// arena3/race10/guildwar there is no scheduled window or module-level
// registration queue here — every one of these is driven directly by the
// per-connection fearEnter/fearSync handlers still in index.js, which is why
// so much of this module's surface is exported: those handlers, and the
// shared _pvpEliminate/_reclaimQueues glue, all reach into it by name.
const { FEAR_MAX_WAVE } = require('../../shared/definitions');
const { FLOOR_IDS } = require('../game/floors');
const Room = require('../game/Room');

module.exports = function createFear(deps) {
  const { io, _returnToHub, _socketTid, safeTimeout } = deps;

  // ── Страх (Fear) ─────────────────────────────────────────────────────────────
  // A private, on-demand wave-survival instance: no scheduled window and no
  // registration queue, unlike arena3/race10 above — a player spends one of
  // FEAR_ATTEMPTS daily attempts the instant they enter (fearEnter, below the
  // socket handlers further down this file), same "spent on entry, not on a
  // successful clear" rule the shared daily-attempts pool already follows for
  // arena3/race10. Waves escalate one global monster level at a time, 20
  // monsters per wave (server/game/Room.js's FEAR_WAVE_MOBS), up to
  // FEAR_MAX_WAVE (shared/definitions.js, read by both here and Room.js).
  // Dying or clearing the last wave both send the player home — there is no
  // way to fail out and keep the attempt, and no way to "win" beyond that.
  const FEAR_ATTEMPTS = 2;
  const FEAR_MIN_LEVEL = 10;
  // Grace window between landing in a hall and wave 1 actually spawning —
  // long enough to get your bearings before 20 pre-aggroed monsters close in,
  // short enough that it doesn't feel like waiting. A _fear record at wave:0
  // (see fearEnter) means "deployed, wave 1 not up yet"; the same disconnect
  // grace/reclaim machinery that already carries wave>=1 runs across a
  // reconnect carries this state too (see fearEnter's setTimeout guard and the
  // fearCarry reclaim below, which starts the wave immediately on reconnect
  // rather than resuming a countdown no client is around to show).
  const FEAR_START_DELAY_MS = 5000;

  // socketId -> { room, lane, wave } for whoever currently has a run going —
  // read by the attack/skillAttack handlers to advance the run one kill at a
  // time, by _fearEliminate on death, and by the disconnect handler if they
  // drop mid-run. `room` is that socket's own private Room instance (see
  // _createFearRoom) — there is no shared Fear floor any more to look one up
  // from, so the run record has to carry it. A player can only ever be in one
  // lane at once (fearEnter refuses a second entry while this already has
  // them), so a flat map is enough.
  const _fear = new Map();

  // Every Fear run gets its OWN Room, created here and never registered in
  // floorRooms — it exists only as long as something (a live socket's
  // currentRoom, this player's _fear/_fearDisconnectGrace entry) still
  // references it, and becomes eligible for GC the moment the run ends and
  // the grace window (if any) elapses. This is what removed the old "every
  // hall is busy, wait for a slot" refusal: there is no shared pool to run out
  // of, since nobody ever shares a Room with a stranger's run. generateFear()
  // (server/game/dungeon.js) builds a fresh single-lane dungeon on every call,
  // so this is otherwise exactly how every OTHER floor's Room is constructed —
  // no boss content on this floor, hence the empty bossState and null
  // onBossDeath.
  function _createFearRoom() {
    const room = new Room(FLOOR_IDS.fear, io, {}, null);
    _fearRooms.add(room);
    return room;
  }

  // Weak, observation-only index of the private Rooms above. It exists because
  // keeping them out of floorRooms also kept them out of everything that reads
  // floorRooms: /health reported no rooms with players at all while N people
  // were mid-run in Страх (each on their own 40Hz loop), and _gracefulShutdown's
  // "stop all floor game loops" pass never stopped a single one of them.
  //
  // A WeakSet cannot be enumerated, so this is a plain Set that is swept rather
  // than trusted: an entry is dropped as soon as its Room has no players left
  // (its loop is already stopped by then — see Room.removePlayer — so neither
  // reader has anything to do with it, and a reconnect within the grace window
  // re-registers it through _trackFearRoom). Without the sweep this would be the
  // very leak the private-Room design was careful to avoid: one retained Room,
  // grid and all, per Fear run ever started.
  const _fearRooms = new Set();
  function _liveFearRooms() {
    const live = [];
    _fearRooms.forEach(r => {
      if (r.players.size > 0) live.push(r);
      else _fearRooms.delete(r);
    });
    return live;
  }
  // Re-registers a room a reconnect landed back on (see the fearCarry path in
  // the login flow) — it may have been swept while the player was away.
  function _trackFearRoom(room) {
    if (room && room.floor === FLOOR_IDS.fear) _fearRooms.add(room);
  }

  // Spawns wave `wave` in `lane` and tells the client — split out since both
  // fearEnter (wave 1) and _fearTrackKill (every wave after) need it.
  function _fearStartWave(room, socketId, lane, wave) {
    room.fearSpawnWave(lane, wave);
    _fear.set(socketId, { room, lane, wave });
    io.to(socketId).emit('fearWave', { wave, maxWave: FEAR_MAX_WAVE });
  }

  // Called right after a kill lands on a `fear`-tagged enemy (see the attack/
  // skillAttack handlers, alongside the existing _race10TrackHit call). The kill
  // itself already paid out xp/gold through the normal reward path — this only
  // owns the wave-progression side effect: advance to the next wave once the
  // current one's last monster falls, or finish the run if that was
  // FEAR_MAX_WAVE.
  function _fearTrackKill(socketId, result) {
    if (result.arm !== 'fear') return;
    const run = _fear.get(socketId);
    if (!run || run.lane !== result.lane) return;
    const room = run.room;
    if (!room) return;
    // The run record is only trustworthy while the player is still actually
    // standing in that hall. Several handlers unrelated to this event
    // (race10Return/arena3Return/_fearFinish itself) end up releasing a hall
    // as a side effect of moving its owner off this floor — so a stale record
    // here could otherwise be counting kills against a hall that now belongs
    // to somebody else's run.
    if (room.fearLaneOf(socketId) !== run.lane || room.fearOwnerOf(run.lane) !== socketId) {
      _fear.delete(socketId);
      return;
    }
    const left = room.fearRegisterKill(result.lane);
    if (left > 0) return;
    if (run.wave >= FEAR_MAX_WAVE) { _fearFinish(socketId, true); return; }
    _fearStartWave(room, socketId, result.lane, run.wave + 1);
  }

  // Sends the player home and frees their lane — either because they cleared
  // FEAR_MAX_WAVE (cleared: true) or died mid-run (cleared: false, called from
  // _fearEliminate). Safe to call on someone not currently in a run.
  // Ends the run record and gives the hall back, without deciding where the
  // player goes next — that differs between the two callers. _fearFinish below
  // sends them home and tells them how it ended; leaving the floor under their
  // own steam (_doEnterLocation) has already chosen a destination.
  //
  // Returns the run it ended, or null if there wasn't one, so a caller can
  // report the wave it died at.
  function _fearReleaseRun(socketId) {
    const run = _fear.get(socketId);
    if (!run) return null;
    _fear.delete(socketId);
    const room = run.room;
    // Release the lane BEFORE the floor change below, not after. _returnToHub
    // ends in Room.removePlayer, which — if the departing record still has a
    // lane set — holds it open for a possible reconnect instead of releasing
    // it (_fearGraceStart, a 45s grace window meant for a genuine disconnect).
    // This is a clean finish, not a disconnect: fearReleaseLane clears the
    // player's own p._fearLane as part of releasing, so by the time
    // removePlayer runs there's nothing left for that grace path to hold.
    // Skipping it here would leave a stale _fearGrace entry that outlives the
    // lane's real state — fearDeploy only ever checks _fearOwner, so the lane
    // would look free and get handed to a new entrant while the old grace
    // timer is still ticking down, and when it eventually fires it would
    // silently release THEIR run out from under them 45s later.
    // ownedBefore guards against releasing a lane this run record no longer
    // actually owns (see _fearTrackKill's identical check) — it could be
    // stale if the hall was already reassigned since this player last held it.
    const ownedBefore = room ? room.fearOwnerOf(run.lane) === socketId : false;
    if (room && ownedBefore) room.fearReleaseLane(run.lane);
    return run;
  }

  function _fearFinish(socketId, cleared) {
    const run = _fearReleaseRun(socketId);
    if (!run) return;
    const spot = _returnToHub(socketId);
    io.to(socketId).emit('fearFinished', { cleared, wave: run.wave, x: spot?.x, y: spot?.y });
  }

  // Wired into _pvpEliminate's fan-out (mirrors _race10Eliminate) — dying
  // anywhere while in a Fear lane ends the run on the spot. Only a lane's own
  // monsters can ever reach a player there, but this covers the death path
  // generically the same way the other instanced events do.
  function _fearEliminate(socketId) {
    if (!_fear.has(socketId)) return false;
    _fearFinish(socketId, false);
    return true;
  }

  // How long a disconnected entrant's run record is held before it's dropped
  // for real — kept equal to Room.js's own FEAR_RECONNECT_GRACE_MS (not
  // imported: Room has no reason to depend on this file, so the two are kept
  // in sync by comment). Room's copy is what actually holds the hall/monsters;
  // this one is what lets fearSync/fearWave keep reporting the right wave to a
  // client that's mid-reconnect.
  //
  // Was 15000. The client's own disconnect watchdog (_PONG_SILENCE_MS,
  // js/network.js) doesn't even START reconnecting until 8s of silence, and a
  // real reconnect on the exact flaky link that caused the drop in the first
  // place — transport re-handshake, then loginTelegramWebApp's own DB round
  // trip — routinely eats several more. 15s total left as little as ~7s for
  // all of that, so an ordinary reconnect (not just a same-tick socket-id
  // swap) missed the window more often than not: the hall released for real,
  // its monsters purged, and the returning player's next enemy snapshot came
  // back empty — read as "the monsters just vanished," reported as happening
  // "at any moment" tied to reconnects. Raised well past the watchdog's own
  // 8s floor.
  const FEAR_RECONNECT_GRACE_MS = 45000;
  // telegramId -> { run: {lane, wave}, timer } — a Fear run held across a
  // disconnect. See _pvpEliminate's opts.fearGrace and the reconnect handling
  // in the login flow below (where a matching Room._fearGraceClaim result
  // reclaims this back onto the new socketId).
  const _fearDisconnectGrace = new Map();
  function _fearHoldOnDisconnect(socketId, telegramId) {
    const run = _fear.get(socketId);
    if (!run) return false;
    _fear.delete(socketId);
    const tid = telegramId || _socketTid(socketId);
    // No account to reconnect against — Room's own grace still holds the hall
    // briefly and releases it on its own timer regardless of what happens here.
    if (!tid) return true;
    const prior = _fearDisconnectGrace.get(tid);
    if (prior) clearTimeout(prior.timer);
    const timer = safeTimeout('fearGrace', () => { _fearDisconnectGrace.delete(tid); }, FEAR_RECONNECT_GRACE_MS);
    _fearDisconnectGrace.set(tid, { run, timer });
    return true;
  }

  // ── the other half of the hold ─────────────────────────────────────────────
  // Without a claim, the hold above is a DELAYED DELETION and not a grace at
  // all: it takes the run out of _fear on the spot and schedules the held copy
  // to be dropped 45s later, and nothing ever put it back. A player who
  // reconnected well inside the window came back to a hall full of their own
  // monsters with no run behind it — _fearTrackKill returns on `!run`, so the
  // wave never advanced again once the current one was cleared; fearSync
  // answered `inRun: false`; and _fearEliminate returned false, so dying in
  // there did not end it either. The attempt was already spent on entry, and
  // the only way out was walking to a portal.
  //
  // The client has expected this to work since it was written: the gameStart
  // handler in js/network.js restores its wave HUD from the `fear` block and
  // says in as many words that the common case is "a reconnect that landed
  // back in a held hall". It was reading a field the server never filled.
  //
  // Deliberately splits taking the hold from re-registering the run. The
  // caller has to move the connection back into that private Room first (the
  // hall itself is held by the Room, on its own timer of the same length —
  // see _fearGraceStart/_fearGraceClaim in server/game/Room.js), and a _fear
  // record pointing at a hall this player does not own is worse than none:
  // fearEnter checks _fear FIRST and would refuse every later entry, forever.
  function _fearClaimOnReconnect(telegramId) {
    if (!telegramId) return null;
    const held = _fearDisconnectGrace.get(telegramId);
    if (!held) return null;
    clearTimeout(held.timer);
    _fearDisconnectGrace.delete(telegramId);
    return held.run;
  }

  // Puts a claimed run back on the new socket id, once the caller has actually
  // landed them in the hall. _trackFearRoom because the sweep in _liveFearRooms
  // will have dropped this Room while nobody was standing in it — without it
  // the resumed run ticks along invisible to /health and to the shutdown pass.
  function _fearResumeRun(socketId, run) {
    if (!run || !run.room) return false;
    _trackFearRoom(run.room);
    _fear.set(socketId, run);
    return true;
  }

  return {
    FEAR_ATTEMPTS, FEAR_MIN_LEVEL, FEAR_START_DELAY_MS, FEAR_RECONNECT_GRACE_MS,
    _fear, _fearRooms, _createFearRoom, _liveFearRooms, _trackFearRoom,
    _fearStartWave, _fearTrackKill, _fearReleaseRun, _fearFinish, _fearEliminate,
    _fearDisconnectGrace, _fearHoldOnDisconnect, _fearClaimOnReconnect, _fearResumeRun,
  };
};
