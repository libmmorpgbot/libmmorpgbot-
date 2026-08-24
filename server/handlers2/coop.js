'use strict';
// ── Co-op, the elite farm zone, and the party ──────────────────────────────
// Ported from server/handlers/coopfarm2.js with the bodies intact, for the
// same reason as the PvP modes: the lobby rules, the cascade checks and the
// disconnect handling are tuned, and none of them touched the database.
//
// The farm zone's daily minutes are the one real change. They were counted
// against the SOCKET, so a reconnect mid-run started the budget over — an hour
// of elite farming cost nothing if the client dropped and came back. They are
// counted against the player now, clamped to the daily cap in the same
// statement that adds to them.

module.exports = function registerCoopFarm2(s, safeOn, deps) {
  const { io, modes } = deps;
  const {
    _a3, _coop, _coopGroupBroadcastList, _coopGroupDissolve, _coopGroupOf,
    _coopGroupOpenList, _coopGroupPush, _coopGroupStateFor, _coopGroups,
    _createCoopRoom, _createFarm2Room, _db, _farm2, _farm2CascadeCheck,
    _farm2Finish, _farm2GroupBroadcastList, _farm2GroupDissolve, _farm2GroupOf,
    _farm2GroupOpenList, _farm2GroupPush, _farm2GroupStateFor, _farm2Groups,
    _farm2Starting, _fear, _race10,
    COOP_MIN_LEVEL, COOP_START_DELAY_MS,
  } = modes;
  const {
    parties, playerParty, safeInterval, safeTimeout, _removeFromParty, _returnToHub,
  } = deps;
  const {
    COOP_STAGE_LEVELS, FARM2_DAILY_MINUTES, FARM2_ENTRY_LEVEL, FARM2_PARTY_SIZE,
  } = require('../../shared/definitions');
  const COOP_ATTEMPTS = modes.COOP_ATTEMPTS;

  const levelOf = () => {
    const p = s.room && s.room.players.get(s.socket.id);
    return (p && p.lvl) || 1;
  };


    // ── Сотрудничество (Coop) ────────────────────────────────────────────────
    // Group-based lobby: coopGroupCreate makes this connection a leader,
    // coopGroupJoin lets someone else take the one open slot, coopGroupKick
    // lets the leader boot them back out, coopGroupLeave covers either side
    // stepping away on their own, and coopGroupStart — leader only — is the
    // sole way a run actually begins. All the real gates (level, attempts,
    // conflicts with the other instanced modes) run at create/join time, same
    // trust model race10/arena3's registration queues already use for a
    // stored entry — coopGroupStart itself only rechecks that both sides are
    // still actually connected before deploying.
    safeOn('coopGroupCreate', async () => {
      if (!s.authed) return;
      if (_coop.has(s.socket.id) || _coopGroupOf.has(s.socket.id)) return;
      if (!s.room) return;
      const cp = s.room.players.get(s.socket.id);
      if (!cp) return s.socket.emit('coopError', { msg: 'Выберите персонажа' });
      if (_db.reg.has(s.socket.id) || _db.alive.has(s.socket.id)) {
        return s.socket.emit('coopError', { msg: 'Вы уже записаны на битву на смерть' });
      }
      if (_a3.queue.has(s.socket.id) || (_a3.live && _a3.teams.has(s.socket.id))) {
        return s.socket.emit('coopError', { msg: 'Вы сейчас на арене 3х3' });
      }
      if (_race10.queue.has(s.socket.id) || (_race10.live && _race10.alive.has(s.socket.id))) {
        return s.socket.emit('coopError', { msg: 'Вы сейчас в Кровавой Башне' });
      }
      if (_fear.has(s.socket.id)) {
        return s.socket.emit('coopError', { msg: 'Вы сейчас в Страхе' });
      }
      const lvl = levelOf();
      if (lvl < COOP_MIN_LEVEL) {
        return s.socket.emit('coopError', { msg: `Нужен ${COOP_MIN_LEVEL} уровень` });
      }
      const left = await modes.attemptsLeft(s.socket.id, 'coop');
      if (left <= 0) {
        return s.socket.emit('coopError', { msg: 'Попытки в Сотрудничество на сегодня закончились' });
      }
      _coopGroups.set(s.socket.id, { leaderName: s.username, memberId: null, memberName: null });
      _coopGroupOf.set(s.socket.id, s.socket.id);
      _coopGroupPush(s.socket.id);
      _coopGroupBroadcastList();
    });

    safeOn('coopGroupJoin', ({ leaderId } = {}) => {
      if (!s.authed || !leaderId) return;
      if (_coop.has(s.socket.id) || _coopGroupOf.has(s.socket.id)) return;
      const g = _coopGroups.get(leaderId);
      if (!g || g.memberId || !io.sockets.sockets.get(leaderId)) {
        return s.socket.emit('coopError', { msg: 'Группа недоступна' });
      }
      if (!s.room) return;
      const cp = s.room.players.get(s.socket.id);
      if (!cp) return s.socket.emit('coopError', { msg: 'Выберите персонажа' });
      if (_db.reg.has(s.socket.id) || _db.alive.has(s.socket.id)) {
        return s.socket.emit('coopError', { msg: 'Вы уже записаны на битву на смерть' });
      }
      if (_a3.queue.has(s.socket.id) || (_a3.live && _a3.teams.has(s.socket.id))) {
        return s.socket.emit('coopError', { msg: 'Вы сейчас на арене 3х3' });
      }
      if (_race10.queue.has(s.socket.id) || (_race10.live && _race10.alive.has(s.socket.id))) {
        return s.socket.emit('coopError', { msg: 'Вы сейчас в Кровавой Башне' });
      }
      if (_fear.has(s.socket.id)) {
        return s.socket.emit('coopError', { msg: 'Вы сейчас в Страхе' });
      }
      const lvl = levelOf();
      if (lvl < COOP_MIN_LEVEL) {
        return s.socket.emit('coopError', { msg: `Нужен ${COOP_MIN_LEVEL} уровень` });
      }
      // Re-check the slot is still open — two joins racing each other on the
      // same open group must not both land.
      if (g.memberId) return s.socket.emit('coopError', { msg: 'Группа недоступна' });
      g.memberId = s.socket.id;
      g.memberName = s.username;
      _coopGroupOf.set(s.socket.id, leaderId);
      _coopGroupPush(leaderId);
      _coopGroupPush(s.socket.id);
      _coopGroupBroadcastList();
    });

    // Leader-only: boots the current member back to idle, freeing the slot
    // for someone else to join. A no-op if there's no member to kick.
    safeOn('coopGroupKick', () => {
      const g = _coopGroups.get(s.socket.id);
      if (!g || !g.memberId) return;
      const memberId = g.memberId;
      g.memberId = null;
      g.memberName = null;
      _coopGroupOf.delete(memberId);
      _coopGroupPush(memberId, 'kicked');
      _coopGroupPush(s.socket.id);
      _coopGroupBroadcastList();
    });

    // Either side stepping away on their own. The leader leaving dissolves
    // the whole group (the member, if any, is bounced back to idle); a
    // member leaving just frees their own slot.
    safeOn('coopGroupLeave', () => {
      const leaderId = _coopGroupOf.get(s.socket.id);
      if (!leaderId) return;
      if (leaderId === s.socket.id) {
        _coopGroupDissolve(leaderId, 'leaderLeft');
      } else {
        const g = _coopGroups.get(leaderId);
        if (!g || g.memberId !== s.socket.id) return;
        g.memberId = null;
        g.memberName = null;
        _coopGroupOf.delete(s.socket.id);
        _coopGroupPush(leaderId);
        _coopGroupBroadcastList();
      }
    });

    // Leader-only, and only once a member has actually joined — this is the
    // ONLY way a Coop run begins now, replacing the old random matchmaking.
    safeOn('coopGroupStart', async () => {
      if (!s.authed) return;
      if (_coop.has(s.socket.id)) return;
      const g = _coopGroups.get(s.socket.id);
      if (!g) return; // not a leader (or not in a group at all)
      if (!g.memberId) return s.socket.emit('coopError', { msg: 'Нужен второй участник' });
      const partnerSid = g.memberId;
      const partnerSocket = io.sockets.sockets.get(partnerSid);
      if (!partnerSocket) {
        // Member vanished without the disconnect path catching it — clear the
        // slot rather than trying to deploy a ghost.
        g.memberId = null;
        g.memberName = null;
        _coopGroupPush(s.socket.id);
        _coopGroupBroadcastList();
        return s.socket.emit('coopError', { msg: 'Участник отключился' });
      }

      // Group the two into a fresh party of exactly themselves — same shape
      // partyAccept's "create new party" branch uses, and needed for the PvP
      // immunity/heal checks the run itself relies on (see arePlayersNear and
      // playerParty's other readers).
      const oldPartyA = playerParty.get(partnerSid);
      if (oldPartyA) _removeFromParty(oldPartyA, partnerSid);
      const oldPartyB = playerParty.get(s.socket.id);
      if (oldPartyB) _removeFromParty(oldPartyB, s.socket.id);
      const partyId = partnerSid + '_' + s.socket.id;
      const partyMap = new Map();
      partyMap.set(partnerSid, g.memberName);
      partyMap.set(s.socket.id, g.leaderName);
      parties.set(partyId, partyMap);
      playerParty.set(partnerSid, partyId);
      playerParty.set(s.socket.id, partyId);
      partyMap.forEach((_, mid) => {
        const others = [];
        partyMap.forEach((name, oid) => { if (oid !== mid) others.push({ id: oid, name }); });
        io.to(mid).emit('partyUpdated', { members: others });
      });

      // Deploy both. Coop is its own floor (server/game/floors.js), but like
      // Fear there is no shared Room to walk onto — this connection creates a
      // brand-new private instance right here and force-joins BOTH
      // connections onto it via the `room` override (_forceEnterLocation,
      // exposed per-connection so this handler can move a socket that isn't
      // its own).
      const coopRoom = _createCoopRoom();
      const ok1 = partnerSocket.data._forceEnterLocation?.('coop', { room: coopRoom });
      const ok2 = s.socket.data._forceEnterLocation?.('coop', { room: coopRoom });
      if (!ok1 || !ok2) {
        // Something about one of the two connections refused the move (no
        // character selected any more, already elsewhere) — don't strand
        // either one on a half-joined floor, and leave the group intact so
        // the leader can just try again.
        if (ok1) partnerSocket.data._forceEnterLocation?.('hub');
        if (ok2) s.socket.data._forceEnterLocation?.('hub');
        s.socket.emit('coopError', { msg: 'Не удалось войти — попробуйте ещё раз' });
        partnerSocket.emit('coopError', { msg: 'Не удалось войти — попробуйте ещё раз' });
        return;
      }
      const spot1 = coopRoom.coopDeploy(partnerSid);
      const spot2 = coopRoom.coopDeploy(s.socket.id);
      if (!spot1 || !spot2) {
        partnerSocket.data._forceEnterLocation?.('hub');
        s.socket.data._forceEnterLocation?.('hub');
        s.socket.emit('coopError', { msg: 'Не удалось войти — попробуйте ещё раз' });
        partnerSocket.emit('coopError', { msg: 'Не удалось войти — попробуйте ещё раз' });
        return;
      }
      // The group has done its job — clear it out before locking attempts and
      // deploying, same as the old pool entry was cleared before deploy.
      _coopGroups.delete(s.socket.id);
      _coopGroupOf.delete(s.socket.id);
      _coopGroupOf.delete(partnerSid);
      _coopGroupBroadcastList();
      _lockCoopDaily(partnerSid);
      await modes.takeAttempt(s.socket.id, 'coop');
      _coop.set(partnerSid, { room: coopRoom, lane: spot1.lane, partnerId: s.socket.id });
      _coop.set(s.socket.id, { room: coopRoom, lane: spot2.lane, partnerId: partnerSid });
      const p1 = coopRoom.players.get(partnerSid), p2 = coopRoom.players.get(s.socket.id);
      const readyAt = Date.now() + COOP_START_DELAY_MS;
      io.to(partnerSid).emit('coopStarted', { x: spot1.x, y: spot1.y, hp: p1?.maxHp, maxStage: COOP_STAGE_LEVELS.length, attemptsLeft: await _coopAttemptsLeft(partnerSid), readyAt });
      s.socket.emit('coopStarted', { x: spot2.x, y: spot2.y, hp: p2?.maxHp, maxStage: COOP_STAGE_LEVELS.length, attemptsLeft: await modes.attemptsLeft(s.socket.id, 'coop'), readyAt });
      safeTimeout('coopStage1', () => {
        // Still exactly the run this timer was scheduled for? A disconnect
        // during the countdown ends the run for both right away (see
        // _coopEjectOnDisconnect) and drops both _coop entries — a stale timer
        // left over from that quietly no-ops here instead of spawning a stage
        // 1 nobody's left to fight.
        const r1 = _coop.get(partnerSid), r2 = _coop.get(s.socket.id);
        if (!r1 || !r2 || r1.room !== coopRoom || r2.room !== coopRoom || coopRoom.coopStage() !== 0) return;
        coopRoom.coopStartFirstStage();
        io.to(partnerSid).emit('coopStage', { stage: 1, maxStage: COOP_STAGE_LEVELS.length });
        io.to(s.socket.id).emit('coopStage', { stage: 1, maxStage: COOP_STAGE_LEVELS.length });
      }, COOP_START_DELAY_MS);
    });

    safeOn('coopSync', async () => {
      const run = _coop.get(s.socket.id);
      s.socket.emit('coopState', {
        maxAttempts: COOP_ATTEMPTS, maxStage: COOP_STAGE_LEVELS.length, minLevel: COOP_MIN_LEVEL,
        attemptsLeft: await modes.attemptsLeft(s.socket.id, 'coop'),
        inRun: !!run, stage: run?.room ? run.room.coopStage() : 0,
      });
      s.socket.emit('coopGroupState', _coopGroupStateFor(s.socket.id));
      s.socket.emit('coopGroupList', { groups: _coopGroupOpenList() });
    });

    // Sent once the player closes the coop result modal — same reasoning as
    // fearReturn above.
    safeOn('coopReturn', () => {
      const spot = _returnToHub(s.socket.id);
      if (spot) s.socket.emit('deathBattleReturned', spot);
    });

    // ── Элитная фарм-зона (Elite Farm Zone 2) ────────────────────────────────
    // Same group-based lobby shape as Coop just above, sized for
    // FARM2_PARTY_SIZE (leader + FARM2_PARTY_SIZE-1 members) instead of 2, and
    // — unlike Coop — the daily allowance (minutes, not run attempts) is
    // re-checked for EVERY participant at Start, not just the leader at
    // create/join time: an exhausted member silently deployed and then
    // immediately timed back out would break the whole trio for the other
    // two, which is worse than just refusing to start.
    safeOn('farm2GroupCreate', async () => {
      if (!s.authed) return;
      if (_farm2.has(s.socket.id) || _farm2GroupOf.has(s.socket.id)) return;
      if (!s.room) return;
      const cp = s.room.players.get(s.socket.id);
      if (!cp) return s.socket.emit('farm2Error', { msg: 'Выберите персонажа' });
      if (_db.reg.has(s.socket.id) || _db.alive.has(s.socket.id)) {
        return s.socket.emit('farm2Error', { msg: 'Вы уже записаны на битву на смерть' });
      }
      if (_a3.queue.has(s.socket.id) || (_a3.live && _a3.teams.has(s.socket.id))) {
        return s.socket.emit('farm2Error', { msg: 'Вы сейчас на арене 3х3' });
      }
      if (_race10.queue.has(s.socket.id) || (_race10.live && _race10.alive.has(s.socket.id))) {
        return s.socket.emit('farm2Error', { msg: 'Вы сейчас в Кровавой Башне' });
      }
      if (_fear.has(s.socket.id)) {
        return s.socket.emit('farm2Error', { msg: 'Вы сейчас в Страхе' });
      }
      if (_coop.has(s.socket.id) || _coopGroupOf.has(s.socket.id)) {
        return s.socket.emit('farm2Error', { msg: 'Вы сейчас в Сотрудничестве' });
      }
      const lvl = levelOf();
      if (lvl < FARM2_ENTRY_LEVEL) {
        return s.socket.emit('farm2Error', { msg: `Нужен ${FARM2_ENTRY_LEVEL} уровень` });
      }
      const left = await modes.farm2MinutesLeft(s.socket.id);
      if (left <= 0) {
        return s.socket.emit('farm2Error', { msg: 'Время в Элитной фарм-зоне на сегодня закончилось' });
      }
      _farm2Groups.set(s.socket.id, { leaderName: s.username, members: new Map() });
      _farm2GroupOf.set(s.socket.id, s.socket.id);
      _farm2GroupPush(s.socket.id);
      _farm2GroupBroadcastList();
    });

    safeOn('farm2GroupJoin', async ({ leaderId } = {}) => {
      if (!s.authed || !leaderId) return;
      if (_farm2.has(s.socket.id) || _farm2GroupOf.has(s.socket.id)) return;
      const g = _farm2Groups.get(leaderId);
      if (!g || g.members.size >= FARM2_PARTY_SIZE - 1 || !io.sockets.sockets.get(leaderId)) {
        return s.socket.emit('farm2Error', { msg: 'Группа недоступна' });
      }
      if (!s.room) return;
      const cp = s.room.players.get(s.socket.id);
      if (!cp) return s.socket.emit('farm2Error', { msg: 'Выберите персонажа' });
      if (_db.reg.has(s.socket.id) || _db.alive.has(s.socket.id)) {
        return s.socket.emit('farm2Error', { msg: 'Вы уже записаны на битву на смерть' });
      }
      if (_a3.queue.has(s.socket.id) || (_a3.live && _a3.teams.has(s.socket.id))) {
        return s.socket.emit('farm2Error', { msg: 'Вы сейчас на арене 3х3' });
      }
      if (_race10.queue.has(s.socket.id) || (_race10.live && _race10.alive.has(s.socket.id))) {
        return s.socket.emit('farm2Error', { msg: 'Вы сейчас в Кровавой Башне' });
      }
      if (_fear.has(s.socket.id)) {
        return s.socket.emit('farm2Error', { msg: 'Вы сейчас в Страхе' });
      }
      if (_coop.has(s.socket.id) || _coopGroupOf.has(s.socket.id)) {
        return s.socket.emit('farm2Error', { msg: 'Вы сейчас в Сотрудничестве' });
      }
      const lvl = levelOf();
      if (lvl < FARM2_ENTRY_LEVEL) {
        return s.socket.emit('farm2Error', { msg: `Нужен ${FARM2_ENTRY_LEVEL} уровень` });
      }
      const left = await modes.farm2MinutesLeft(s.socket.id);
      if (left <= 0) {
        return s.socket.emit('farm2Error', { msg: 'Время в Элитной фарм-зоне на сегодня закончилось' });
      }
      // Re-check the slot is still open — two joins racing each other on the
      // same open group must not both land.
      if (g.members.size >= FARM2_PARTY_SIZE - 1) return s.socket.emit('farm2Error', { msg: 'Группа недоступна' });
      g.members.set(s.socket.id, s.username);
      _farm2GroupOf.set(s.socket.id, leaderId);
      _farm2GroupPush(leaderId);
      _farm2GroupPush(s.socket.id);
      _farm2GroupBroadcastList();
    });

    // Leader-only: boots the named member back to idle, freeing their slot for
    // someone else to join. A no-op if that member isn't actually in the group.
    safeOn('farm2GroupKick', ({ memberId } = {}) => {
      const g = _farm2Groups.get(s.socket.id);
      if (!g || !memberId || !g.members.has(memberId)) return;
      g.members.delete(memberId);
      _farm2GroupOf.delete(memberId);
      _farm2GroupPush(memberId, 'kicked');
      _farm2GroupPush(s.socket.id);
      _farm2GroupBroadcastList();
    });

    // Any side stepping away on their own. The leader leaving dissolves the
    // whole group (every member is bounced back to idle); a member leaving
    // just frees their own slot.
    safeOn('farm2GroupLeave', () => {
      const leaderId = _farm2GroupOf.get(s.socket.id);
      if (!leaderId) return;
      if (leaderId === s.socket.id) {
        _farm2GroupDissolve(leaderId, 'leaderLeft');
      } else {
        const g = _farm2Groups.get(leaderId);
        if (!g || !g.members.has(s.socket.id)) return;
        g.members.delete(s.socket.id);
        _farm2GroupOf.delete(s.socket.id);
        _farm2GroupPush(leaderId);
        _farm2GroupBroadcastList();
      }
    });

    // Leader-only, and only once the group is FULL (FARM2_PARTY_SIZE-1
    // members) — this is the ONLY way an Элитная фарм-зона run begins: the
    // leader is the one who "enters" and every member is force-moved in with
    // them, exactly as the task spec asks.
    safeOn('farm2GroupStart', async () => {
      if (!s.authed) return;
      if (_farm2.has(s.socket.id) || _farm2Starting.has(s.socket.id)) return;
      const g = _farm2Groups.get(s.socket.id);
      if (!g) return; // not a leader (or not in a group at all)
      const memberIds = [...g.members.keys()];
      if (memberIds.length < FARM2_PARTY_SIZE - 1) {
        return s.socket.emit('farm2Error', { msg: `Нужна полная группа из ${FARM2_PARTY_SIZE} человек` });
      }
      const memberSockets = memberIds.map(id => io.sockets.sockets.get(id));
      const vanished = memberIds.filter((id, i) => !memberSockets[i]);
      if (vanished.length) {
        // One or more members vanished without the disconnect path catching
        // it — clear those slots rather than trying to deploy ghosts.
        vanished.forEach(id => { g.members.delete(id); _farm2GroupOf.delete(id); });
        _farm2GroupPush(s.socket.id);
        _farm2GroupBroadcastList();
        return s.socket.emit('farm2Error', { msg: 'Участник отключился' });
      }

      const allIds = [s.socket.id, ...memberIds];
      const allNames = [s.username, ...memberIds.map(id => g.members.get(id))];

      // Marks this leader mid-start for the duration of the daily-minutes
      // await below — see _farm2Starting's own comment. Cleared in the
      // finally block covering every return path past this point.
      _farm2Starting.add(s.socket.id);
      try {
        // Authoritative daily-minutes gate — see this section's own header
        // comment on why every participant is checked here, not just the
        // leader at create time.
        const minutesLeft = await Promise.all(allIds.map(sid => _farm2MinutesLeft(sid)));
        const exhaustedIdx = minutesLeft.findIndex(m => m <= 0);
        if (exhaustedIdx !== -1) {
          const msg = exhaustedIdx === 0
            ? 'Ваше время в Элитной фарм-зоне на сегодня закончилось'
            : `У ${allNames[exhaustedIdx]} закончилось время в Элитной фарм-зоне на сегодня`;
          return s.socket.emit('farm2Error', { msg });
        }

        // Group everyone into a fresh party of exactly themselves — same shape
        // coopGroupStart's own party formation uses, needed for the kill-share/
        // party-heal/proximity checks the run itself relies on (arePlayersNear
        // and playerParty's other readers).
        allIds.forEach(sid => {
          const oldPartyId = playerParty.get(sid);
          if (oldPartyId) _removeFromParty(oldPartyId, sid);
        });
        const partyId = allIds.join('_');
        const partyMap = new Map();
        allIds.forEach((sid, i) => partyMap.set(sid, allNames[i]));
        parties.set(partyId, partyMap);
        allIds.forEach(sid => playerParty.set(sid, partyId));
        partyMap.forEach((_, mid) => {
          const others = [];
          partyMap.forEach((name, oid) => { if (oid !== mid) others.push({ id: oid, name }); });
          io.to(mid).emit('partyUpdated', { members: others });
        });

        // Deploy everyone. Элитная фарм-зона is its own floor (server/game/
        // floors.js), but like Coop there is no shared, populated Room to walk
        // onto — this connection creates a brand-new private instance right
        // here and force-joins every connection onto it via the `room` override
        // (_forceEnterLocation, exposed per-connection so this handler can move
        // sockets that aren't its own).
        const allSockets = [socket, ...memberSockets];
        const farm2Room = _createFarm2Room();
        const entered = allSockets.map(s => s.data._forceEnterLocation?.('farmZone2', { room: farm2Room }));
        if (entered.some(ok => !ok)) {
          // Something about one of the connections refused the move (no
          // character selected any more, already elsewhere) — don't strand
          // anyone on a half-joined floor, and leave the group intact so the
          // leader can just try again.
          allSockets.forEach((s, i) => { if (entered[i]) s.data._forceEnterLocation?.('hub'); });
          allSockets.forEach(s => s.emit('farm2Error', { msg: 'Не удалось войти — попробуйте ещё раз' }));
          return;
        }
        const spots = allIds.map(sid => farm2Room.farm2Deploy(sid));
        if (spots.some(sp => !sp)) {
          allSockets.forEach(s => s.data._forceEnterLocation?.('hub'));
          allSockets.forEach(s => s.emit('farm2Error', { msg: 'Не удалось войти — попробуйте ещё раз' }));
          return;
        }

        // The group has done its job — clear it out before tracking the run.
        _farm2Groups.delete(s.socket.id);
        allIds.forEach(sid => _farm2GroupOf.delete(sid));
        _farm2GroupBroadcastList();

        allIds.forEach((sid, i) => {
          // startedAt/chargedMin/telegramId are what _farm2SettleMinutes
          // (server/game/farm2.js) bills the daily allowance from when the run
          // ends — the ticker below can only ever charge whole minutes it lives
          // to see, and the run's last (or only) partial one is settled there.
          const run = {
            room: farm2Room, participantIds: allIds,
            telegramId: allSockets[i].data.telegramId,
            startedAt: Date.now(), chargedMin: 0,
            capTimer: null, minuteTimer: null,
          };
          run.capTimer = safeTimeout('farm2Cap_' + sid, () => {
            _farm2Finish(sid, 'timeCap');
            _farm2CascadeCheck(farm2Room, allIds);
          }, minutesLeft[i] * 60000);
          run.minuteTimer = safeInterval('farm2Min_' + sid, () => {
            run.chargedMin += 1;
            _lockFarm2Minutes(sid, 1);
          }, 60000);
          _farm2.set(sid, run);
        });
        allSockets.forEach((s, i) => {
          const p = farm2Room.players.get(allIds[i]);
          s.emit('farm2Started', { x: spots[i].x, y: spots[i].y, hp: p?.maxHp, minutesLeft: minutesLeft[i] });
        });
      } finally {
        _farm2Starting.delete(s.socket.id);
      }
    });

    safeOn('farm2Sync', async () => {
      const run = _farm2.get(s.socket.id);
      s.socket.emit('farm2State', {
        entryLevel: FARM2_ENTRY_LEVEL, partySize: FARM2_PARTY_SIZE, dailyMinutes: FARM2_DAILY_MINUTES,
        minutesLeft: await modes.farm2MinutesLeft(s.socket.id),
        inRun: !!run,
      });
      s.socket.emit('farm2GroupState', _farm2GroupStateFor(s.socket.id));
      s.socket.emit('farm2GroupList', { groups: _farm2GroupOpenList() });
    });

    // Sent once the player closes the farm2 result modal — same reasoning as
    // coopReturn above.
    safeOn('farm2Return', () => {
      const spot = _returnToHub(s.socket.id);
      if (spot) s.socket.emit('deathBattleReturned', spot);
    });
};
