'use strict';
// ── PvP, and the four event modes ──────────────────────────────────────────
// Ported from server/handlers/pvpmodes.js with the bodies intact. The tuning
// in here — freeze windows, elimination order, which mode refuses which other
// mode — is the product of live play, and rewriting it would have thrown that
// away to gain nothing: none of it touched the database.
//
// What changed is the three things that did.
//
//   * A daily attempt is SPENT, transactionally, and the spend is awaited.
//     _lockDailyAttempt fired a Mongo update with `.catch(() => {})` — a
//     failed write meant a free run and no record of it.
//   * A reward is CREDITED through money.js, so it lands in the ledger with
//     everything else. The old modes wrote a session field and let the
//     debounced save carry it, which lost the prize on a disconnect.
//   * The level gate reads the room's own copy of the level rather than
//     s.lastStats, which was whatever blob the client last sent.

module.exports = function registerPvpModes(s, safeOn, deps) {
  const { io, modes } = deps;
  const {
    _a3, _a3Allies, _a3Broadcast, _a3Enemies, _a3PublicState, _a3TryStartSafe,
    _coop, _coopGroupOf, _createFearRoom, _db, _dbBroadcast, _dbPublicState,
    _dbReturnEntrant, _farm2, _farm2GroupOf, _fear, _fearStartWave,
    _race10, _race10Broadcast, _race10PublicState,
    ARENA3_MIN_LEVEL, FEAR_ATTEMPTS, FEAR_MIN_LEVEL, FEAR_START_DELAY_MS,
    RACE10_MIN_LEVEL,
  } = modes;
  // FEAR_MAX_WAVE is not the fear module's to own — Room.js reads it too, so
  // it lives in shared/definitions and both take it from there.
  const { FEAR_MAX_WAVE } = require('../../shared/definitions');
  const { playerParty, safeTimeout } = deps;
  const { _pvpEliminate, _pvpFrozen, _returnToHub } = modes;

  // The level the SERVER computed, carried on the room's player record by
  // setPlayerStats. The old gate read s.lastStats.lvl — a field the client
  // filled in — so "минимальный уровень 15" was advice, not a rule.
  const levelOf = () => {
    const p = s.room && s.room.players.get(s.socket.id);
    return (p && p.lvl) || 1;
  };
  const _atkAllowed = () => !!(s.authed && s.room);
  // The modes deploy players into floors they may not be able to walk into,
  // and fear/coop/farm2 into a Room created for that one run. forceFloor takes
  // both, and returns the record so the caller knows where the entrant landed.
  const _doEnterLocation = (target, opts = {}) =>
    !!s.forceFloor(target, { pos: opts.pos || null, room: opts.room || null });


    // Returns true if attacker and target share a party or clan (PvP immune)
    function _isPvpImmune(attackerId, targetId) {
      // Guild War: while both players are physically inside the zone, ordinary
      // party/clan protection is suspended for anyone NOT sharing a clan — the
      // zone's whole point is open PvP between different clans ("PvE +
      // полноценный PvP"). Same-clan players inside the zone stay immune. This
      // has to run before every other check below because it's conditional on
      // live position, unlike the generic clan/party checks further down which
      // apply everywhere with no zone awareness.
      const gwA = s.room?.players.get(attackerId);
      const gwT = s.room?.players.get(targetId);
      if (gwA?._guildWarZone && gwT?._guildWarZone) {
        return !!gwA.clanName && gwA.clanName === gwT.clanName;
      }
      // In a 3v3 the teams are what matter, not who is whose friend: allies are
      // protected outright, and opponents can always be hit even if they happen
      // to share a party or a clan with the attacker.
      if (_a3Allies(attackerId, targetId)) return true;
      if (_a3Enemies(attackerId, targetId)) return false;
      // A death battle is a free-for-all: party and clan protection would let
      // allied entrants refuse to fight and stall the round forever, so both are
      // suspended for as long as the two of them are in the same live round.
      if (_db.phase === 'live' && _db.alive.has(attackerId) && _db.alive.has(targetId)) return false;
      const aParty = playerParty.get(attackerId);
      const tParty = playerParty.get(targetId);
      if (aParty && aParty === tParty) return true;
      const aPlayer = s.room?.players.get(attackerId);
      const tPlayer = s.room?.players.get(targetId);
      if (aPlayer?.clanName && aPlayer.clanName === tPlayer?.clanName) return true;
      return false;
    }

    safeOn('pvpAttack', ({ targetId } = {}) => {
      if (!_atkAllowed()) return;
      if (!s.room) return;
      if (_pvpFrozen(s.socket.id) || _pvpFrozen(targetId)) return;
      if (_isPvpImmune(s.socket.id, targetId)) return;
      const result = s.room.pvpAttack(s.socket.id, targetId);
      if (!result) return;
      // hp is now applied server-side inside pvpAttack itself — the target's
      // client used to self-report "actual damage taken" separately, which let
      // a modified client always report 0 and become unkillable.
      io.to(targetId).emit('pvpDamage', { dmg: result.dmg, hp: result.hp });
      s.socket.emit('pvpHit', { x: result.x, y: result.y, dmg: result.dmg, isCrit: result.isCrit, targetId });
      if (result.hp <= 0) { io.to(targetId).emit('playerHurt', { id: targetId, hp: 0 }); _pvpEliminate(targetId, s.socket.id, s.room); }
    });

    safeOn('pvpSkillAttack', ({ targetId, key } = {}) => {
      // Was the only combat handler outside the attack limiter, i.e. in the
      // 300 events/s bucket.
      if (!_atkAllowed()) return;
      if (!s.room) return;
      if (_pvpFrozen(s.socket.id) || _pvpFrozen(targetId)) return;
      if (_isPvpImmune(s.socket.id, targetId)) return;
      const result = s.room.pvpSkillAttack(s.socket.id, targetId, key);
      if (!result) return;
      io.to(targetId).emit('pvpDamage', { dmg: result.dmg, hp: result.hp });
      s.socket.emit('pvpHit', { x: result.x, y: result.y, dmg: result.dmg, isCrit: result.isCrit, targetId });
      if (result.hp <= 0) { io.to(targetId).emit('playerHurt', { id: targetId, hp: 0 }); _pvpEliminate(targetId, s.socket.id, s.room); }
    });

    safeOn('pvpSkillCC', ({ targetId, type, duration } = {}) => {
      if (!s.room) return;
      if (_pvpFrozen(s.socket.id) || _pvpFrozen(targetId)) return;
      if (_isPvpImmune(s.socket.id, targetId)) return;
      const attacker = s.room.players.get(s.socket.id);
      if (!attacker || !attacker.pvpMode) return;
      if (attacker.hp <= 0) return;
      if (s.room.isPlayerInSafeZone(s.socket.id)) return;
      const target = s.room.players.get(targetId);
      if (!target || target.hp <= 0) return;
      if (s.room.isPlayerInSafeZone(targetId)) return;
      const dur = Math.max(0, Math.min(duration, 6));
      // Anchored on the TARGET, and including the caster: the target's own
      // client is what applies the freeze/stun, so it must be in the recipient
      // set, and it always is — it sits at distance 0 from the anchor. Everyone
      // else nearby gets it for the visual. See _emitNearby for why this is no
      // longer a floor-wide broadcast.
      s.emitNearby(target.x, target.y, 'pvpPlayerCC', { targetId, type, duration: dur }, true);
    });

    // ── Death Battle (Битва на смерть) ─────────────────────────────────────────
    safeOn('deathBattleRegister', () => {
      if (!s.authed) return;
      if (_db.phase !== 'reg') return s.socket.emit('deathBattleError', { msg: 'Регистрация закрыта' });
      const cp = s.room?.players.get(s.socket.id);
      if (!cp) return s.socket.emit('deathBattleError', { msg: 'Выберите персонажа' });
      if (_fear.has(s.socket.id)) return s.socket.emit('deathBattleError', { msg: 'Вы сейчас в Страхе' });
      // Checked against the QUEUE too, not just live participation — same
      // reasoning as fearEnter's own cross-checks (see its comment): arena3/
      // race10 registration opens minutes before the match actually deploys,
      // so a player who queued there and then also queued here could get
      // deployed into arena3/race10 while still holding a death-battle slot,
      // or the reverse. This was the one direction that never got the
      // treatment — arena3Register/race10Register already check .reg here.
      if (_a3.queue.has(s.socket.id) || (_a3.live && _a3.teams.has(s.socket.id))) {
        return s.socket.emit('deathBattleError', { msg: 'Вы сейчас на арене 3х3' });
      }
      if (_race10.queue.has(s.socket.id) || (_race10.live && _race10.alive.has(s.socket.id))) {
        return s.socket.emit('deathBattleError', { msg: 'Вы сейчас в Кровавой Башне' });
      }
      // Сотрудничество / Элитная фарм-зона — the two instanced modes that were
      // never checked here (or in arena3Register/race10Register below), even
      // though coopGroupCreate/farm2GroupCreate have always checked THIS
      // direction. That asymmetry is not harmless: both run on a private Room
      // per party (_createCoopRoom/_createFarm2Room), and _findPlayerAnyFloor —
      // the "still has a character in the world" filter every deploy runs — only
      // ever looks at getRoom(floor), which for those floor ids returns the
      // shared, permanently-empty boot-time Room, never the party's instance. So
      // a player who signed up from inside a run was silently dropped at deploy
      // time: registered, waited out the whole countdown, and simply never got
      // thrown in, with no error ever shown. The same shape as the race10/arena3
      // queue gap fearEnter's own cross-checks were added to close.
      //
      // The group (lobby) maps are checked alongside the live-run ones for the
      // same reason the arena3/race10 QUEUES are: a lobby that starts while this
      // registration is still pending lands in exactly the same place.
      if (_coop.has(s.socket.id) || _coopGroupOf.has(s.socket.id)) {
        return s.socket.emit('deathBattleError', { msg: 'Вы сейчас в Сотрудничестве' });
      }
      if (_farm2.has(s.socket.id) || _farm2GroupOf.has(s.socket.id)) {
        return s.socket.emit('deathBattleError', { msg: 'Вы сейчас в Элитной фарм-зоне' });
      }
      _db.reg.set(s.socket.id, { name: s.username, tid: s.telegramId });
      s.socket.emit('deathBattleRegistered', { registered: true });
      _dbBroadcast();
    });

    safeOn('deathBattleUnregister', () => {
      if (_db.phase !== 'reg') return;
      if (!_db.reg.delete(s.socket.id)) return;
      s.socket.emit('deathBattleRegistered', { registered: false });
      _dbBroadcast();
    });

    // ── 3v3 Arena ─────────────────────────────────────────────────────────────
    safeOn('arena3Register', async () => {
      if (!s.authed) return;
      if (_a3.live && _a3.teams.has(s.socket.id)) return;
      if (_a3.phase !== 'reg') return s.socket.emit('arena3Error', { msg: 'Арена 3х3 открыта с 21:00 до 22:00 по Москве' });
      const cp = s.room?.players.get(s.socket.id);
      if (!cp) return s.socket.emit('arena3Error', { msg: 'Выберите персонажа' });
      // Signing up for both at once would have the death battle yank someone out
      // of a running 3v3 (or the reverse) mid-fight.
      if (_db.reg.has(s.socket.id) || _db.alive.has(s.socket.id)) {
        return s.socket.emit('arena3Error', { msg: 'Вы уже записаны на битву на смерть' });
      }
      // Кровавая Башня's 5-minute registration (20:30) and its own 15-minute
      // overrun grace period normally wrap up well before this window opens at
      // 21:00, but an admin can force-open either one off-schedule, so a race
      // can in principle still be live right as this one opens.
      //
      // Checked against the QUEUE too, not just live participation — the same
      // gap fearEnter's own cross-checks were added to close (see its
      // comment): without this, queuing here AND for race10 let both windows'
      // deploys fight over the same player, landing them in one match while
      // still holding a slot in the other.
      if (_race10.queue.has(s.socket.id) || _race10.alive.has(s.socket.id)) {
        return s.socket.emit('arena3Error', { msg: 'Вы сейчас в Кровавой Башне' });
      }
      if (_fear.has(s.socket.id)) {
        return s.socket.emit('arena3Error', { msg: 'Вы сейчас в Страхе' });
      }
      // See deathBattleRegister for why these two were missing and what it cost.
      if (_coop.has(s.socket.id) || _coopGroupOf.has(s.socket.id)) {
        return s.socket.emit('arena3Error', { msg: 'Вы сейчас в Сотрудничестве' });
      }
      if (_farm2.has(s.socket.id) || _farm2GroupOf.has(s.socket.id)) {
        return s.socket.emit('arena3Error', { msg: 'Вы сейчас в Элитной фарм-зоне' });
      }
      const lvl = levelOf();
      if (lvl < ARENA3_MIN_LEVEL) {
        return s.socket.emit('arena3Error', { msg: `Нужен ${ARENA3_MIN_LEVEL} уровень` });
      }
      const left = await modes.attemptsLeft(s.socket.id, 'arena3');
      if (left <= 0) {
        return s.socket.emit('arena3Error', { msg: 'Попытки на арену на сегодня закончились' });
      }
      _a3.queue.set(s.socket.id, { name: s.username, lvl, tid: s.telegramId });
      s.socket.emit('arena3Registered', { registered: true, attemptsLeft: left });
      _a3Broadcast();
      _a3TryStartSafe();
    });

    safeOn('arena3Unregister', () => {
      if (!_a3.queue.delete(s.socket.id)) return;
      s.socket.emit('arena3Registered', { registered: false });
      _a3Broadcast();
    });

    // The only place attemptsLeft is read from the DB — the periodic broadcasts
    // stay a pure in-memory push, so opening the panel costs one query rather
    // than every queue change costing one per waiting player.
    safeOn('arena3Sync', async () => {
      s.socket.emit('arena3State', {
        ..._a3PublicState(),
        registered: _a3.queue.has(s.socket.id),
        inMatch: _a3.teams.has(s.socket.id),
        attemptsLeft: await modes.attemptsLeft(s.socket.id, 'arena3'),
      });
    });

    // ── 10-Player Corridor Race ──────────────────────────────────────────────
    safeOn('race10Register', async () => {
      if (!s.authed) return;
      if (_race10.live && _race10.alive.has(s.socket.id)) return;
      if (_race10.phase !== 'reg') return s.socket.emit('race10Error', { msg: 'Кровавая Башня открыта в 20:30 по Москве, всего на 5 минут' });
      const cp = s.room?.players.get(s.socket.id);
      if (!cp) return s.socket.emit('race10Error', { msg: 'Выберите персонажа' });
      if (_db.reg.has(s.socket.id) || _db.alive.has(s.socket.id)) {
        return s.socket.emit('race10Error', { msg: 'Вы уже записаны на битву на смерть' });
      }
      // Checked against the QUEUE too, not just live participation — mirrors
      // the check arena3Register now runs the other way (see its comment):
      // without this, queuing here AND for arena3 let both windows' deploys
      // fight over the same player.
      if (_a3.queue.has(s.socket.id) || (_a3.live && _a3.teams.has(s.socket.id))) {
        return s.socket.emit('race10Error', { msg: 'Вы сейчас на арене 3х3' });
      }
      if (_fear.has(s.socket.id)) {
        return s.socket.emit('race10Error', { msg: 'Вы сейчас в Страхе' });
      }
      // See deathBattleRegister for why these two were missing and what it cost.
      if (_coop.has(s.socket.id) || _coopGroupOf.has(s.socket.id)) {
        return s.socket.emit('race10Error', { msg: 'Вы сейчас в Сотрудничестве' });
      }
      if (_farm2.has(s.socket.id) || _farm2GroupOf.has(s.socket.id)) {
        return s.socket.emit('race10Error', { msg: 'Вы сейчас в Элитной фарм-зоне' });
      }
      const lvl = levelOf();
      if (lvl < RACE10_MIN_LEVEL) {
        return s.socket.emit('race10Error', { msg: `Нужен ${RACE10_MIN_LEVEL} уровень` });
      }
      const left = await modes.attemptsLeft(s.socket.id, 'race10');
      if (left <= 0) {
        return s.socket.emit('race10Error', { msg: 'Попытки в Кровавую Башню на сегодня закончились' });
      }
      // Registering no longer risks starting the race — it begins on its own
      // timer with whoever is signed up by then.
      _race10.queue.set(s.socket.id, { name: s.username, lvl, tid: s.telegramId });
      s.socket.emit('race10Registered', { registered: true, attemptsLeft: left });
      _race10Broadcast();
    });

    safeOn('race10Unregister', () => {
      if (!_race10.queue.delete(s.socket.id)) return;
      s.socket.emit('race10Registered', { registered: false });
      _race10Broadcast();
    });

    safeOn('race10Sync', async () => {
      s.socket.emit('race10State', {
        ..._race10PublicState(),
        registered: _race10.queue.has(s.socket.id),
        inMatch: _race10.alive.has(s.socket.id),
        attemptsLeft: await modes.attemptsLeft(s.socket.id, 'race10'),
      });
    });

    // ── Страх (Fear) ──────────────────────────────────────────────────────────
    // On-demand: no registration queue, no scheduled window — entering IS
    // starting, so this single handler does everything arena3Register/
    // race10Register + their deploy step do together.
    safeOn('fearEnter', async () => {
      if (!s.authed) return;
      if (_fear.has(s.socket.id)) return; // already running — the client shouldn't offer the button
      if (!s.room) return;
      const cp = s.room.players.get(s.socket.id);
      if (!cp) return s.socket.emit('fearError', { msg: 'Выберите персонажа' });
      if (_db.reg.has(s.socket.id) || _db.alive.has(s.socket.id)) {
        return s.socket.emit('fearError', { msg: 'Вы уже записаны на битву на смерть' });
      }
      // Checked against the QUEUE too, not just live participation: race10/
      // arena3 registration opens minutes before the match actually deploys
      // (race10Register/arena3Register), and neither of those two checked Fear
      // the other way around before this. A player could register, then start
      // a Fear run while waiting, and get yanked into the race/match the
      // moment it deployed — raceDeploy/arena3's own deploy only ever set
      // _raceLane, never checked or cleared an existing _fearLane, so the
      // player ended up with BOTH set at once. Their Fear hall was never
      // released (fearReleaseLane never ran) — a leaked, permanently-occupied
      // slot — while the AOI distance check silently dropped its monsters off
      // their screen the instant they were teleported to the race lane: from
      // their side that reads as "the monsters just disappeared". Death battle
      // registration already checked `.reg` (not just `.alive`) for exactly
      // this reason; race10/arena3 just never got the same treatment.
      if (_a3.queue.has(s.socket.id) || (_a3.live && _a3.teams.has(s.socket.id))) {
        return s.socket.emit('fearError', { msg: 'Вы сейчас на арене 3х3' });
      }
      if (_race10.queue.has(s.socket.id) || (_race10.live && _race10.alive.has(s.socket.id))) {
        return s.socket.emit('fearError', { msg: 'Вы сейчас в Кровавой Башне' });
      }
      const lvl = levelOf();
      if (lvl < FEAR_MIN_LEVEL) {
        return s.socket.emit('fearError', { msg: `Нужен ${FEAR_MIN_LEVEL} уровень` });
      }
      const left = await modes.attemptsLeft(s.socket.id, 'fear');
      if (left <= 0) {
        return s.socket.emit('fearError', { msg: 'Попытки в Страх на сегодня закончились' });
      }
      // Fear is its own floor (server/game/floors.js), but unlike every other
      // one there is no shared Room to walk onto — this connection creates a
      // brand-new private instance right here and force-joins it via the
      // `room` override (_doEnterLocation), the same way it used to force-join
      // the old shared floor. Every real gate (level, attempts, the cross-
      // checks above) is already applied, so force:true is just skipping the
      // (nonexistent) reachability gate, not bypassing anything that still
      // needs checking.
      const fearRoom = _createFearRoom();
      if (!_doEnterLocation('fear', { force: true, room: fearRoom })) {
        return s.socket.emit('fearError', { msg: 'Не удалось войти — попробуйте ещё раз' });
      }
      // Always succeeds: fearRoom was just created for this connection alone,
      // so its one lane can only ever already belong to this same socket.
      // Kept as a real check (not assumed) rather than trusting that no future
      // change to fearDeploy's own logic could ever disagree.
      const spot = s.room.fearDeploy(s.socket.id);
      if (!spot) {
        _doEnterLocation('hub', { force: true });
        return s.socket.emit('fearError', { msg: 'Не удалось войти — попробуйте ещё раз' });
      }
      await modes.takeAttempt(s.socket.id, 'fear');
      // wave:0 first — see FEAR_START_DELAY_MS's own comment for why this has
      // to be a real _fear record (not just a bare setTimeout with nothing
      // backing it) rather than calling _fearStartWave immediately.
      const readyAt = Date.now() + FEAR_START_DELAY_MS;
      _fear.set(s.socket.id, { room: fearRoom, lane: spot.lane, wave: 0 });
      s.socket.emit('fearStarted', { x: spot.x, y: spot.y, hp: cp.hp, maxWave: FEAR_MAX_WAVE, attemptsLeft: left - 1, readyAt });
      safeTimeout('fearWave1', () => {
        // Still exactly the run this timer was scheduled for? A disconnect
        // during the countdown deletes this socket's _fear entry (moved to
        // _fearDisconnectGrace instead — see _fearHoldOnDisconnect), so a
        // stale timer for a socket that's since gone quietly no-ops here
        // rather than double-spawning the wave once the reconnect path
        // starts it (see the fearCarry reclaim, further up this file).
        //
        // run.room !== fearRoom (identity, not just lane/wave) is the part
        // that matters now that every run gets its own fresh Room: lane is
        // always 0 and wave is always 0 at this point for ANY fresh entry, so
        // a player who died during this exact countdown (impossible today —
        // wave 0 has no monsters — but not a case worth trusting to stay that
        // way) and re-entered before this timer fired would have a NEW room
        // with the same lane/wave numbers as this stale closure's. Without the
        // identity check that coincidence would pass the old guard and spawn
        // wave 1 into the abandoned OLD room while stamping ITS reference back
        // over the new run's _fear entry — silently hijacking the active run.
        const run = _fear.get(s.socket.id);
        if (!run || run.room !== fearRoom || run.lane !== spot.lane || run.wave !== 0) return;
        _fearStartWave(fearRoom, s.socket.id, spot.lane, 1);
      }, FEAR_START_DELAY_MS);
    });

    safeOn('fearSync', async () => {
      const run = _fear.get(s.socket.id);
      s.socket.emit('fearState', {
        maxAttempts: FEAR_ATTEMPTS, maxWave: FEAR_MAX_WAVE, minLevel: FEAR_MIN_LEVEL,
        attemptsLeft: await modes.attemptsLeft(s.socket.id, 'fear'),
        inRun: !!run, wave: run?.wave || 0,
        // No freeLanes/totalLanes any more — every entrant gets their own
        // private Room now (_createFearRoom), so there is no shared pool that
        // can ever be "full".
      });
    });

    // Sent once the player closes the fear result modal — same reasoning as
    // race10Return/arena3Return: server-side position was already reset when
    // the run ended (_fearFinish), this just makes the client catch up
    // visually if it somehow missed the fearFinished payload's x/y.
    safeOn('fearReturn', () => {
      const spot = _returnToHub(s.socket.id);
      if (spot) s.socket.emit('deathBattleReturned', spot);
    });

    // Sent once the player closes the race10 result modal — same reasoning as
    // arena3Return above. Server-side position was already reset to the hub
    // floor by the time this fires either way (an eliminated racer via
    // _race10Eliminate, called from the 'respawn' handler; a survivor via
    // _race10Finish once the race ends) — this is just the visual catch-up,
    // and _returnToHub's own same-floor guard makes it a safe no-op if so.
    safeOn('race10Return', () => {
      const spot = _returnToHub(s.socket.id);
      if (spot) s.socket.emit('deathBattleReturned', spot);
    });

    // Sent once the player closes the arena3 result modal. Server-side position
    // was already reset to the hub floor when the match ended (eliminated
    // players get it immediately via arena3Eliminated; survivors get it inside
    // _a3Finish) — this just tells THIS client to catch up visually. Safe to
    // call any time (not gated on being mid-match): _returnToHub always just
    // re-lands the caller on the hub floor, and no-ops if they're already
    // there (see _doEnterLocation's same-floor guard).
    safeOn('arena3Return', () => {
      const spot = _returnToHub(s.socket.id);
      if (spot) s.socket.emit('deathBattleReturned', spot);
    });

    // Sent once the winner closes the reward modal — everyone else was already
    // sent back (to wherever they each were, see _dbReturnEntrant) the
    // moment they were eliminated; the winner is left standing in the arena
    // until this. Own event name (not the shared 'deathBattleReturned'
    // arena3Return/race10Return use) so the client can label this teleport
    // correctly — it lands somewhere different (the winner's own pre-battle
    // spot) from what that event means for those other two.
    safeOn('deathBattleReturn', () => {
      if (_db.winnerId !== s.socket.id) return; // see _db.winnerId — not a free teleport home
      _db.winnerId = null;
      const spot = _dbReturnEntrant(s.socket.id);
      if (spot) s.socket.emit('deathBattleReturnedPrev', spot);
    });

    safeOn('deathBattleSync', () => {
      s.socket.emit('deathBattleState', { ..._dbPublicState(), registered: _db.reg.has(s.socket.id) });
    });

    safeOn('setPvpMode', ({ pvpMode } = {}) => {
      if (s.room) s.room.setPlayerPvpMode(s.socket.id, pvpMode);
    });
};
