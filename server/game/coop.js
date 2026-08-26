'use strict';
// Сотрудничество (Coop) — private 2-player leader-run-group instances, moved
// out of server/index.js verbatim as a factory (createCoop(deps)). Like Fear,
// there is no scheduled window here — every run is driven by the
// per-connection coopGroup*/coopEnter handlers and the shared
// _pvpEliminate/_reclaimQueues glue still in index.js.
const { COOP_STAGE_LEVELS, COOP_LIBERTY_CHANCE } = require('../../shared/definitions');
const { FLOOR_IDS } = require('../game/floors');
const Room = require('../game/Room');

module.exports = function createCoop(deps) {
  const { io, _returnToHub } = deps;

  // ── Сотрудничество (Coop) ────────────────────────────────────────────────────
  // A private, 2-player instance, entered through a leader-run group rather
  // than random matchmaking: one player creates a group (coopGroupCreate) and
  // becomes its leader, the open group is broadcast to everyone so a second
  // player can join it (coopGroupJoin), the leader can boot the member back
  // out at any time (coopGroupKick), and only the leader can actually launch
  // the run (coopGroupStart) — never automatic, never a random pairing. See
  // the group handlers further down this file for the lobby itself; once
  // launched, both are deployed together exactly like the old flow did. 8
  // stages of COOP_MOBS_PER_STAGE monsters (server/game/Room.js) escalate
  // through COOP_STAGE_LEVELS (shared/definitions.js, read by both here and
  // Room.js); neither lane's next stage spawns until BOTH lanes have cleared
  // the current one (Room.coopRegisterKill), then a shared
  // level-COOP_BOSS_LEVEL boss. Dying anywhere, or a disconnect hold lapsing
  // for good, ends the run for BOTH participants — there is no way to keep
  // going with only one of them.
  const COOP_ATTEMPTS = 2;
  const COOP_MIN_LEVEL = 10;
  // Same role FEAR_START_DELAY_MS plays — see its own comment.
  const COOP_START_DELAY_MS = 5000;
  // Flat per-kill Liberty chance — Coop's only per-kill reward besides xp; see
  // calcGoldDrop's `arm === 'coop'` branch (shared/definitions.js) for why
  // there's no gold, and the coop branch of the kill-reward path
  // (server/handlers2/world.js) for how this is actually rolled.
  //
  // The number itself now lives in shared/definitions.js. It was declared here
  // and returned to nobody: this factory's consumer was the retired build, and
  // the live kill-reward path imports its drop chances from the catalog rather
  // than reaching into a mode runtime. A tuning constant with no reader does
  // not tune anything — the co-op Liberty roll was silently running on the
  // ordinary corridor table instead.

  // socketId -> { room, lane, partnerId } for whoever currently has a run
  // going — read by the attack/skillAttack handlers to advance the run one
  // kill at a time, by _coopEliminate on death, and by the disconnect handler
  // if they drop mid-run. Stage/cleared state itself lives on the Room
  // (coopRegisterKill/coopStage), not here, since by design both lanes are
  // always on the same stage — this only needs to remember which room, which
  // lane, and who the partner is so an event can be told to both of them.
  const _coop = new Map();

  // ── Coop lobby (pre-run groups) ─────────────────────────────────────────────
  // leaderId -> { leaderName, memberId, memberName }. A group always has a
  // leader (the socketId that created it) and at most one member — the Room
  // this eventually deploys onto only has 2 lanes (see Room.coopDeploy). Groups
  // live here only until coopGroupStart consumes one (deleted at that point)
  // or it's dissolved without ever starting (leader leaves/disconnects).
  const _coopGroups = new Map();
  // socketId -> leaderId, for both the leader (points at itself) and the
  // member — the reverse lookup coopGroupKick/Leave/Start all need to find
  // which group (if any) a given connection currently belongs to.
  const _coopGroupOf = new Map();

  // Everything a given socket needs to render its own view of Coop group
  // membership — sent as coopGroupState after every change that touches it.
  function _coopGroupStateFor(socketId) {
    const leaderId = _coopGroupOf.get(socketId);
    const g = leaderId && _coopGroups.get(leaderId);
    if (!g) return { inGroup: false };
    return {
      inGroup: true,
      isLeader: socketId === leaderId,
      leaderId, leaderName: g.leaderName,
      memberId: g.memberId || null, memberName: g.memberName || null,
    };
  }

  // `reason` is only set for a push the recipient didn't themselves trigger
  // (kicked, or the leader dissolved the group) — the client uses it to show
  // the right toast instead of silently updating.
  function _coopGroupPush(socketId, reason) {
    const st = _coopGroupStateFor(socketId);
    if (reason) st.reason = reason;
    io.to(socketId).emit('coopGroupState', st);
  }

  // Only groups still missing a member are worth offering — a full group has
  // nothing left to join.
  function _coopGroupOpenList() {
    const groups = [];
    _coopGroups.forEach((g, leaderId) => {
      if (!g.memberId && io.sockets.sockets.get(leaderId)) groups.push({ id: leaderId, leaderName: g.leaderName });
    });
    return groups;
  }

  // Broadcast to literally everyone, same as race10Broadcast/_a3Broadcast —
  // this is the lobby list any idle player's Events panel shows, not just the
  // two people involved.
  function _coopGroupBroadcastList() {
    io.emit('coopGroupList', { groups: _coopGroupOpenList() });
  }

  // Leader gone (explicit leave, kick target having been the sole member is
  // handled separately) dissolves the whole group; the member, if any, is
  // notified so their panel drops back to idle rather than waiting forever on
  // a leader who's no longer there.
  function _coopGroupDissolve(leaderId, reason) {
    const g = _coopGroups.get(leaderId);
    if (!g) return;
    _coopGroups.delete(leaderId);
    _coopGroupOf.delete(leaderId);
    if (g.memberId) {
      _coopGroupOf.delete(g.memberId);
      _coopGroupPush(g.memberId, reason);
    }
    _coopGroupBroadcastList();
  }

  // Disconnect while still in the lobby (never reached a live run) drops the
  // disconnecting side immediately — no reconnect grace, same as the random
  // pool this replaces never had one either. Called from the main disconnect
  // handler alongside _partyHoldOnDisconnect.
  function _coopGroupDropOnDisconnect(socketId) {
    const leaderId = _coopGroupOf.get(socketId);
    if (!leaderId) return;
    if (leaderId === socketId) {
      _coopGroupDissolve(leaderId, 'leaderLeft');
    } else {
      const g = _coopGroups.get(leaderId);
      if (g && g.memberId === socketId) {
        g.memberId = null;
        g.memberName = null;
        _coopGroupOf.delete(socketId);
        _coopGroupPush(leaderId);
        _coopGroupBroadcastList();
      }
    }
  }

  // Every Coop run gets its OWN Room, shared by exactly the 2 participants,
  // created here and never registered in floorRooms — same reasoning as
  // _createFearRoom's own comment, just seating two players instead of one.
  function _createCoopRoom() {
    const room = new Room(FLOOR_IDS.coop, io, {}, null);
    _coopRooms.add(room);
    return room;
  }

  // Same sweep-rather-than-trust shape as _liveFearRooms — see its own
  // comment for why (health reporting, _gracefulShutdown).
  const _coopRooms = new Set();
  function _liveCoopRooms() {
    const live = [];
    _coopRooms.forEach(r => {
      if (r.players.size > 0) live.push(r);
      else _coopRooms.delete(r);
    });
    return live;
  }
  // Re-registers a room a reconnect landed back on — see _trackFearRoom.
  function _trackCoopRoom(room) {
    if (room && room.floor === FLOOR_IDS.coop) _coopRooms.add(room);
  }

  // Called right after a kill lands on a `coop`-tagged, non-boss enemy (see
  // the attack/skillAttack handlers). The kill itself already paid out xp
  // through the normal reward path — this only owns the stage-progression
  // side effect, entirely driven by Room.coopRegisterKill's own return value
  // (left>0: still fighting; waiting: this lane finished first; stage: both
  // cleared, the next one is up; bossSpawned: both cleared the last stage).
  function _coopTrackKill(socketId, result) {
    if (result.arm !== 'coop') return;
    const run = _coop.get(socketId);
    if (!run) return;
    const room = run.room;
    if (!room) return;
    // Same staleness guard _fearTrackKill uses — the run record is only
    // trustworthy while the player is still actually standing in that lane.
    if (room.coopLaneOf(socketId) !== run.lane || room.coopOwnerOf(run.lane) !== socketId) {
      _coop.delete(socketId);
      return;
    }
    const res = room.coopRegisterKill(run.lane);
    if (res.left > 0) return;
    const partnerId = run.partnerId;
    if (res.waiting) {
      io.to(socketId).emit('coopWaitingPartner', {});
      return;
    }
    if (res.bossSpawned) {
      io.to(socketId).emit('coopBossSpawned', {});
      if (partnerId) io.to(partnerId).emit('coopBossSpawned', {});
      return;
    }
    io.to(socketId).emit('coopStage', { stage: res.stage, maxStage: COOP_STAGE_LEVELS.length });
    if (partnerId) io.to(partnerId).emit('coopStage', { stage: res.stage, maxStage: COOP_STAGE_LEVELS.length });
  }

  // Called right after a kill lands on the coop boss (see the attack/
  // skillAttack handlers). Picks one of the two participants at random for the
  // fixed reward (1 bless_stone + 100 Liberty — see socket.data.
  // _grantCoopBossReward) and ends the run for BOTH with cleared:true.
  async function _coopBossTrackKill(socketId, result) {
    if (result.arm !== 'coop') return;
    const run = _coop.get(socketId);
    if (!run) return;
    const partnerId = run.partnerId;
    const participants = [socketId, partnerId].filter(sid => sid && _coop.has(sid));
    if (!participants.length) return;
    const winnerId = participants[Math.floor(Math.random() * participants.length)];
    const winnerSocket = io.sockets.sockets.get(winnerId);
    const reward = winnerSocket?.data?._grantCoopBossReward
      ? await winnerSocket.data._grantCoopBossReward()
      : null;
    participants.forEach(sid => io.to(sid).emit('coopBossReward', { winnerId, nexum: reward?.nexum || 0 }));
    participants.forEach(sid => _coopFinish(sid, true));
  }

  // Ends this ONE participant's own half of the run — releases their lane and
  // drops the run record, without deciding where they go or telling the
  // partner anything (callers that need to end the run for BOTH — death, the
  // boss falling — call this once per participant). Returns the run it ended,
  // or null if there wasn't one.
  function _coopReleaseRun(socketId) {
    const run = _coop.get(socketId);
    if (!run) return null;
    _coop.delete(socketId);
    const room = run.room;
    const ownedBefore = room ? room.coopOwnerOf(run.lane) === socketId : false;
    if (room && ownedBefore) room.coopReleaseLane(run.lane);
    return run;
  }

  function _coopFinish(socketId, cleared) {
    const run = _coopReleaseRun(socketId);
    if (!run) return;
    const spot = _returnToHub(socketId);
    io.to(socketId).emit('coopFinished', { cleared, x: spot?.x, y: spot?.y });
  }

  // Wired into _pvpEliminate's fan-out (mirrors _fearEliminate) — dying
  // anywhere while in a Coop lane ends the run for BOTH participants: there is
  // no way to keep going with only one of the two, so the partner is sent
  // home too rather than left stuck waiting on a stage that can never clear.
  function _coopEliminate(socketId) {
    const run = _coop.get(socketId);
    if (!run) return false;
    const partnerId = run.partnerId;
    _coopFinish(socketId, false);
    if (partnerId && _coop.has(partnerId)) _coopFinish(partnerId, false);
    return true;
  }

  // Wired into _pvpEliminate's fan-out for the disconnect case (opts.fearGrace)
  // — unlike Fear/race10/arena3, a Coop run gets no reconnect grace at all:
  // "если один вылетел ... выкидывает с подземелья" (a dropped connection
  // ejects both). Releases the disconnecting half's own lane immediately
  // (_coopReleaseRun — same as a clean finish, just without the _returnToHub/
  // coopFinished round trip: this socket is on its way out, there's nothing to
  // tell it) and ends the partner's run for real right away, no wait.
  function _coopEjectOnDisconnect(socketId) {
    const run = _coopReleaseRun(socketId);
    if (!run) return false;
    const partnerId = run.partnerId;
    if (partnerId && _coop.has(partnerId)) _coopFinish(partnerId, false);
    return true;
  }

  return {
    COOP_ATTEMPTS, COOP_MIN_LEVEL, COOP_START_DELAY_MS, COOP_LIBERTY_CHANCE,
    _coop, _coopGroups, _coopGroupOf, _coopGroupStateFor, _coopGroupPush,
    _coopGroupOpenList, _coopGroupBroadcastList, _coopGroupDissolve, _coopGroupDropOnDisconnect,
    _createCoopRoom, _coopRooms, _liveCoopRooms, _trackCoopRoom,
    _coopTrackKill, _coopBossTrackKill, _coopReleaseRun, _coopFinish, _coopEliminate, _coopEjectOnDisconnect,
  };
};
