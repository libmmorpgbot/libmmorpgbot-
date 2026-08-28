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

const plog = require('../db/repos/playerlog');
const { FLOOR_IDS } = require('../game/floors');

// leaderId currently mid-coopGroupStart. Exactly _farm2Starting's job for
// exactly _farm2Starting's reason (server/game/farm2.js — read its comment):
// coopGroupStart now awaits a daily-attempts read BEFORE the synchronous
// `_coopGroups.delete` that used to be the only thing stopping a duplicate
// event from starting the same group twice. Without this, a double-click could
// have two calls both find the group still present and both deploy it — two
// private Rooms, four attempts charged, one playable run.
//
// A per-connection flag would do the same job (both packets arrive on the
// leader's one socket); it is a module-level Set keyed by socket id so that it
// reads and is maintained exactly like _farm2Starting, which guards the handler
// directly below this one against the identical shape.
const _coopStarting = new Set();

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

  // ── refusals leave a trace ─────────────────────────────────────────────────
  // Same reporter, same reasoning and same throttle as handlers2/modes.js's —
  // see the comment there. Duplicated rather than shared because these two
  // files take their dependencies by two different conventions (this one
  // destructures deps, that one reads `modes`) and neither has a home for a
  // helper the other could import without one requiring the other.
  const RF_WINDOW_MS = 60000;
  const RF_PER_WINDOW = 5;
  let _rfAt = 0, _rfN = 0, _rfHidden = 0;
  function _refuse(event, meta) {
    const now = Date.now();
    if (now - _rfAt > RF_WINDOW_MS) { _rfAt = now; _rfN = 0; }
    if (++_rfN > RF_PER_WINDOW) { _rfHidden++; return; }
    if (_rfHidden) { meta = { ...meta, skipped: _rfHidden }; _rfHidden = 0; }
    plog.log(s.playerId, 'refuse:' + event, meta);
  }

  // "Finished, may go home" — the same gate handlers2/modes.js applies to
  // fearReturn/race10Return/arena3Return, and for the same reason. Read its
  // _mayGoHome comment: _coopFinish and _farm2Finish both call _returnToHub
  // BEFORE they emit the event the result modal is built from, so an honest
  // caller is already standing in the hub and this moves nobody. The second arm
  // is the rescue case — a run that ended while its own _returnToHub did not
  // land leaves the player on the instance floor with the record already
  // released, and they still get home.
  const _mayGoHome = (modeFloor, stillInRun) =>
    s.floor === FLOOR_IDS.hub || (s.floor === modeFloor && !stillInRun);


    // ── Сотрудничество (Coop) ────────────────────────────────────────────────
    // Group-based lobby: coopGroupCreate makes this connection a leader,
    // coopGroupJoin lets someone else take the one open slot, coopGroupKick
    // lets the leader boot them back out, coopGroupLeave covers either side
    // stepping away on their own, and coopGroupStart — leader only — is the
    // sole way a run actually begins.
    //
    // What used to stand here said the real gates all run at create/join time
    // and that "coopGroupStart itself only rechecks that both sides are still
    // actually connected before deploying" — the same trust model race10/
    // arena3's registration queues use for a stored entry. That was an
    // accurate description of the code and a description of the exploit: the
    // ATTEMPTS gate was not among the gates that ran at create/join time,
    // because only coopGroupCreate ever checked it. coopGroupJoin did not, and
    // Start trusted the lobby entry. So the daily cap applied to leaders and
    // to nobody else — exhaust your runs, then only ever JOIN groups other
    // people broadcast, forever.
    //
    // The trust model is therefore no longer the queues'. Level and the
    // cross-mode conflicts still run at create/join time, but the allowance is
    // checked on the way in AND re-checked for both participants at Start,
    // where it is also actually spent — the way farm2GroupStart has always
    // handled its own daily minutes.
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
      // ── the cross-check every other mode has and these two did not ─────────
      // farm2GroupCreate/farm2GroupJoin have always checked Сотрудничество
      // (`_coop`/`_coopGroupOf`, below); deathBattleRegister, arena3Register and
      // race10Register all check Элитная фарм-зона (handlers2/modes.js:170, 217,
      // 276). Only these two coop handlers checked neither, and the cost was not
      // theirs to pay.
      //
      // Traced: joining a coop group from inside a live farm2 run reaches
      // coopGroupStart, whose party formation calls _removeFromParty on the old
      // party (below) → party.js's _onLeave → _farm2Eliminate → _farm2Finish for
      // this player PLUS _farm2CascadeCheck, which finds the remaining two below
      // FARM2_PARTY_SIZE and ends their run too, billing each a rounded-up
      // minute (_farm2SettleMinutes — whole minutes STARTED are what count)
      // against their FARM2_DAILY_MINUTES budget. TWO UNINVOLVED PLAYERS LOSE A
      // LIVE RUN. And that _removeFromParty happens before the coop deploy, so a
      // deploy that then fails destroyed their run for nothing at all.
      //
      // The group (lobby) map is checked alongside the live-run one for the same
      // reason deathBattleRegister checks both: a lobby that starts while this
      // registration is pending lands in exactly the same place.
      if (_farm2.has(s.socket.id) || _farm2GroupOf.has(s.socket.id)) {
        return s.socket.emit('coopError', { msg: 'Вы сейчас в Элитной фарм-зоне' });
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

    safeOn('coopGroupJoin', async ({ leaderId } = {}) => {
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
      // See coopGroupCreate's own comment for what joining from inside a live
      // Элитная фарм-зона run did to the two players who were not involved.
      if (_farm2.has(s.socket.id) || _farm2GroupOf.has(s.socket.id)) {
        return s.socket.emit('coopError', { msg: 'Вы сейчас в Элитной фарм-зоне' });
      }
      const lvl = levelOf();
      if (lvl < COOP_MIN_LEVEL) {
        return s.socket.emit('coopError', { msg: `Нужен ${COOP_MIN_LEVEL} уровень` });
      }
      // ── the allowance, on the way IN ──────────────────────────────────────
      // coopGroupCreate has always checked this. Joining never did, and
      // coopGroupStart did not re-check either, so the daily cap was worth
      // nothing to anyone willing to wait: burn both runs, then only ever JOIN
      // groups other people broadcast. Unlimited Сотрудничество — and each
      // boss pays 100 Liberty plus a bless_stone, against a teleport stone
      // costing 20.
      //
      // Refused here rather than only at Start because a member who cannot
      // afford a run is a member the leader would sit waiting on: the same
      // reasoning farm2GroupJoin's own minutes check already states.
      const left = await modes.attemptsLeft(s.socket.id, 'coop');
      if (left <= 0) {
        return s.socket.emit('coopError', { msg: 'Попытки в Сотрудничество на сегодня закончились' });
      }
      // Re-checked AFTER the await above, not before: this handler now yields
      // to the event loop on the way here, so everything the caller was
      // admitted on has had a chance to change underneath it — the group can
      // have filled, been dissolved, or started, and this connection can have
      // been pulled into a run of its own.
      if (_coop.has(s.socket.id) || _coopGroupOf.has(s.socket.id)) return;
      if (_coopGroups.get(leaderId) !== g || g.memberId) {
        return s.socket.emit('coopError', { msg: 'Группа недоступна' });
      }
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
    //
    // The daily allowance is re-checked here for BOTH participants and then
    // actually SPENT before anyone is moved, which is the opposite of how this
    // read before: create checked the leader, join checked nobody, and start
    // called modes.takeAttempt twice and threw both answers away. See the
    // section header above and the join handler's own comment for what that
    // combination was worth — an uncapped mode.
    safeOn('coopGroupStart', async () => {
      if (!s.authed) return;
      if (_coop.has(s.socket.id) || _coopStarting.has(s.socket.id)) return;
      const g = _coopGroups.get(s.socket.id);
      if (!g) return; // not a leader (or not in a group at all)
      if (!g.memberId) return s.socket.emit('coopError', { msg: 'Нужен второй участник' });
      const partnerSid = g.memberId;
      let partnerSocket = io.sockets.sockets.get(partnerSid);
      if (!partnerSocket) {
        // Member vanished without the disconnect path catching it — clear the
        // slot rather than trying to deploy a ghost.
        g.memberId = null;
        g.memberName = null;
        _coopGroupPush(s.socket.id);
        _coopGroupBroadcastList();
        return s.socket.emit('coopError', { msg: 'Участник отключился' });
      }

      // Marks this leader mid-start for the duration of the awaits below — see
      // _coopStarting's own comment. Cleared in the finally block covering
      // every return path past this point, same as farm2GroupStart does.
      _coopStarting.add(s.socket.id);
      try {
        // ── the authoritative allowance gate, for EVERY participant ──────────
        // Not just the leader, and not just at create time: coopGroupJoin now
        // checks on the way in, but a member can sit in an open lobby past
        // midnight UTC or spend their last run elsewhere while they wait, and
        // the entry the lobby holds says nothing about either. farm2GroupStart
        // has always done exactly this with its own daily minutes, and states
        // the reason: silently deploying an exhausted participant is worse for
        // the group than refusing to start.
        const allIds = [s.socket.id, partnerSid];
        const allNames = [s.username, g.memberName];
        const left = await Promise.all(allIds.map(sid => modes.attemptsLeft(sid, 'coop')));
        const exhaustedIdx = left.findIndex(n => n <= 0);
        if (exhaustedIdx !== -1) {
          const msg = exhaustedIdx === 0
            ? 'Ваши попытки в Сотрудничество на сегодня закончились'
            : `У ${allNames[exhaustedIdx]} закончились попытки в Сотрудничество на сегодня`;
          _refuse('coopGroupStart', { code: 'attempts', who: exhaustedIdx === 0 ? 'leader' : 'member' });
          return s.socket.emit('coopError', { msg });
        }

        // Re-checked AFTER the await, not before: everything this start was
        // admitted on has had a chance to change while the two reads were in
        // flight — either side can have been pulled into another run, and the
        // member can have left or disconnected.
        if (_coop.has(s.socket.id) || _coop.has(partnerSid)) return;
        if (_coopGroups.get(s.socket.id) !== g || g.memberId !== partnerSid) return;
        partnerSocket = io.sockets.sockets.get(partnerSid);
        if (!partnerSocket) {
          g.memberId = null;
          g.memberName = null;
          _coopGroupPush(s.socket.id);
          _coopGroupBroadcastList();
          return s.socket.emit('coopError', { msg: 'Участник отключился' });
        }

        // ── BOTH halves, spent, and the answer READ ─────────────────────────
        // Both halves, because for a while only one of them was: the leader's
        // line was converted to modes.takeAttempt and the partner's was not,
        // so this handler threw ReferenceError on the partner every single
        // time, naming a function that had not existed since the rewrite, and
        // no run ever started at all.
        //
        // And the answer, because once both lines existed they were both
        // ignored. progression.takeAttempt is a conditional upsert (`WHERE
        // player_daily.used < $3`) that returns null once the cap is reached,
        // which modes.takeAttempt turns into false. Both calls dropped that
        // answer on the floor, so the one thing standing between a capped
        // player and an extra run — the database saying no — was discarded and
        // the run deployed anyway.
        //
        // Charged BEFORE anybody is moved, so a refusal costs nothing to undo:
        // nothing has been deployed, no party has been rebuilt, and neither
        // player has left the floor they are standing on.
        //
        // Sequential and in the original order — the MEMBER first, then the
        // leader — rather than a Promise.all, so a member who cannot pay stops
        // the leader from paying at all. Only the reverse case can strand an
        // attempt (progression has no refund), and that one needs the leader's
        // own row to change between the read forty lines up and this line.
        //
        // The other case this cannot make whole is a charge that succeeds
        // followed by a deploy that fails a few lines below (a partner who
        // deselected their character inside this same tick). Same reason — no
        // refund path — so the group is dissolved on that route rather than
        // left for a retry that would spend a SECOND attempt.
        if (!await modes.takeAttempt(partnerSid, 'coop')) {
          _refuse('coopGroupStart', { code: 'charge_failed', who: 'member', charged: 0 });
          return s.socket.emit('coopError', {
            msg: `У ${allNames[1]} закончились попытки в Сотрудничество на сегодня`,
          });
        }
        if (!await modes.takeAttempt(s.socket.id, 'coop')) {
          _refuse('coopGroupStart', { code: 'charge_failed', who: 'leader', charged: 1 });
          return s.socket.emit('coopError', {
            msg: 'Ваши попытки в Сотрудничество на сегодня закончились',
          });
        }

        // The group has done its job — clear it out before deploying, same as
        // the old pool entry was cleared before deploy. It happens here rather
        // than after the deploy now that the attempts are already spent: a
        // failed deploy must not leave a lobby whose Start button silently
        // spends the leader's remaining attempt too.
        _coopGroups.delete(s.socket.id);
        _coopGroupOf.delete(s.socket.id);
        _coopGroupOf.delete(partnerSid);
        _coopGroupBroadcastList();

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
        //
        // NOTHING BETWEEN HERE AND THE TWO _coop.set CALLS MAY `await`. An
        // await in that gap is the Страх bug in this file's shape: both players
        // standing on the coop floor with no run record, so a disconnect finds
        // nothing to eject (_coopEjectOnDisconnect returns on `!run`) and
        // nothing to release, with the attempts already spent.
        const coopRoom = _createCoopRoom();
        const ok1 = partnerSocket.data._forceEnterLocation?.('coop', { room: coopRoom });
        const ok2 = s.socket.data._forceEnterLocation?.('coop', { room: coopRoom });
        if (!ok1 || !ok2) {
          // Something about one of the two connections refused the move (no
          // character selected any more, already elsewhere) — don't strand
          // either one on a half-joined floor. The group is already gone by
          // now, deliberately: the attempts are spent, and a Start button left
          // sitting there would spend the next one too.
          if (ok1) partnerSocket.data._forceEnterLocation?.('hub');
          if (ok2) s.socket.data._forceEnterLocation?.('hub');
          _refuse('coopGroupStart', { code: 'enter_failed', leader: !!ok2, member: !!ok1 });
          s.socket.emit('coopError', { msg: 'Не удалось войти — попробуйте ещё раз' });
          partnerSocket.emit('coopError', { msg: 'Не удалось войти — попробуйте ещё раз' });
          return;
        }
        const spot1 = coopRoom.coopDeploy(partnerSid);
        const spot2 = coopRoom.coopDeploy(s.socket.id);
        if (!spot1 || !spot2) {
          partnerSocket.data._forceEnterLocation?.('hub');
          s.socket.data._forceEnterLocation?.('hub');
          _refuse('coopGroupStart', { code: 'deploy_failed' });
          s.socket.emit('coopError', { msg: 'Не удалось войти — попробуйте ещё раз' });
          partnerSocket.emit('coopError', { msg: 'Не удалось войти — попробуйте ещё раз' });
          return;
        }
        _coop.set(partnerSid, { room: coopRoom, lane: spot1.lane, partnerId: s.socket.id });
        _coop.set(s.socket.id, { room: coopRoom, lane: spot2.lane, partnerId: partnerSid });
        const p1 = coopRoom.players.get(partnerSid), p2 = coopRoom.players.get(s.socket.id);
        const readyAt = Date.now() + COOP_START_DELAY_MS;
        // `left[i] - 1` rather than two more attemptsLeft round trips: the
        // charge above is what made the difference, and it already succeeded.
        // Same idiom fearEnter uses for the same reason — and it keeps two
        // awaits out of the gap between the deploy and the timer below.
        io.to(partnerSid).emit('coopStarted', { x: spot1.x, y: spot1.y, hp: p1?.maxHp, maxStage: COOP_STAGE_LEVELS.length, attemptsLeft: left[1] - 1, readyAt });
        s.socket.emit('coopStarted', { x: spot2.x, y: spot2.y, hp: p2?.maxHp, maxStage: COOP_STAGE_LEVELS.length, attemptsLeft: left[0] - 1, readyAt });
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
      } finally {
        _coopStarting.delete(s.socket.id);
      }
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
    // fearReturn (handlers2/modes.js), and gated the same way and for the same
    // reason: unguarded, this was a free teleport home from any floor in the
    // game, in the loose rate-limit bucket, next to a useTeleportStone that
    // destroys a 20-Liberty item to do the same thing.
    //
    // "Finished" is having no _coop record. _coopFinish releases the run
    // (_coopReleaseRun) before it calls _returnToHub and emits coopFinished, so
    // an honest caller has no record and is already in the hub. A caller who
    // still has one is mid-run and asking to walk out on a partner who would
    // then be left on a stage that can never clear — the legitimate way out of
    // a live run is a portal, which goes through modes.leaveInstanceFloor and
    // ends it for both properly.
    safeOn('coopReturn', () => {
      if (!_mayGoHome(FLOOR_IDS.coop, _coop.has(s.socket.id))) {
        return _refuse('coopReturn', { floor: s.floor, inRun: _coop.has(s.socket.id) });
      }
      const spot = _returnToHub(s.socket.id);
      if (spot) s.socket.emit('deathBattleReturned', spot);
    });

    // ── Элитная фарм-зона (Elite Farm Zone 2) ────────────────────────────────
    // Same group-based lobby shape as Coop just above, sized for
    // FARM2_PARTY_SIZE (leader + FARM2_PARTY_SIZE-1 members) instead of 2. Its
    // daily allowance (minutes, not run attempts) is re-checked for EVERY
    // participant at Start, not just the leader at create/join time: an
    // exhausted member silently deployed and then immediately timed back out
    // would break the whole trio for the other two, which is worse than just
    // refusing to start.
    //
    // This used to read "unlike Coop". It no longer is: Coop was the one that
    // had this wrong, and it now does the same thing for the same reason — see
    // the Сотрудничество header above for what the difference was costing.
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
        const minutesLeft = await Promise.all(allIds.map(sid => modes.farm2MinutesLeft(sid)));
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
        const allSockets = [s.socket, ...memberSockets];
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
            // Charged against the ACCOUNT, not the connection — a reconnect
            // mid-run used to start the budget over.
            //
            // `run.telegramId`, not a socket→account lookup. The lookup was
            // the thing that made this whole ticker inert: it went through
            // `modes._socketTid`, which is a dep passed into the farm2 factory
            // and has never been a property of `modes`. And it would have been
            // the wrong source anyway — a player who reconnects mid-run has a
            // new socket id, so resolving the OLD one gives nothing, which is
            // exactly the reconnect case the comment above is about.
            // _farm2SettleMinutes already bills from run.telegramId.
            //
            // chargedMin is incremented only after the charge is actually
            // made. Incrementing it first told settlement the minute had been
            // paid for, so the remainder came out at zero and nobody was ever
            // billed for anything.
            if (run.telegramId == null) return;
            modes._lockFarm2MinutesFor(run.telegramId, 1);
            run.chargedMin += 1;
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
    // coopReturn above, and gated the same way.
    //
    // "Finished" is having no _farm2 record. _farm2Finish releases the run
    // (_farm2ReleaseRun, which also settles the last partial minute) before it
    // calls _returnToHub and emits farm2Finished, so an honest caller has no
    // record and is already in the hub. A caller who still has one is inside a
    // live run — and note that DYING in the zone does not end one
    // (Room.respawnPlayer respawns in place, see FARM2_START_DELAY_MS's
    // comment in server/game/farm2.js), so without this gate the result modal's
    // event was a way to leave the zone without the exit that ends the run,
    // ends it for the rest of the trio, and bills the minutes.
    safeOn('farm2Return', () => {
      if (!_mayGoHome(FLOOR_IDS.farmZone2, _farm2.has(s.socket.id))) {
        return _refuse('farm2Return', { floor: s.floor, inRun: _farm2.has(s.socket.id) });
      }
      const spot = _returnToHub(s.socket.id);
      if (spot) s.socket.emit('deathBattleReturned', spot);
    });
};
