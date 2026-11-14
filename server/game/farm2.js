'use strict';
// Элитная фарм-зона (Elite Farm Zone 2) — private leader-run-group instances
// of up to FARM2_PARTY_SIZE, moved out of server/index.js verbatim as a
// factory (createFarm2(deps)). Same "no scheduled window, driven by
// per-connection group handlers + shared _removeFromParty glue" shape as
// coop.js, just sized for a party instead of a pair.
const { FARM2_PARTY_SIZE } = require('../../shared/definitions');
const { FLOOR_IDS } = require('../game/floors');
const Room = require('../game/Room');

module.exports = function createFarm2(deps) {
  const { io, _returnToHub, _lockFarm2MinutesFor } = deps;

  // ── Элитная фарм-зона (Elite Farm Zone 2) ───────────────────────────────────
  // Same leader/member group-lobby shape Coop's own _coopGroups uses, just
  // FARM2_PARTY_SIZE seats (leader + FARM2_PARTY_SIZE-1 members) instead of 2,
  // and one shared private instance instead of per-player lanes — every
  // monster here is baked in at world-gen (generateFarmZone2, server/game/
  // dungeon.js), not spawned per-stage, so there is nothing that needs the
  // per-player isolation Coop's stage progression relies on. Unlike Coop,
  // dying inside does NOT end the run (Room.respawnPlayer respawns in place,
  // same as any other free-roam zone) — only actually LEAVING the zone
  // (walking out, disconnecting, or dropping out of the run's temporary
  // party) does, and when it does, everyone else still in goes too: see
  // _farm2CascadeCheck.
  const FARM2_START_DELAY_MS = 3000;

  // leaderId -> { leaderName, members: Map<socketId, name> } — up to
  // FARM2_PARTY_SIZE-1 members. Lives here only until farm2GroupStart
  // consumes it (deleted at that point) or it's dissolved without ever
  // starting (leader leaves/disconnects).
  const _farm2Groups = new Map();
  // socketId -> leaderId, for the leader (points at itself) and every member —
  // the reverse lookup farm2GroupKick/Leave/Start all need.
  const _farm2GroupOf = new Map();
  // leaderId currently mid-farm2GroupStart. farm2GroupStart awaits a daily-
  // minutes DB read (_farm2MinutesLeft) BEFORE its first write to `_farm2` —
  // unlike coopGroupStart, which never yields to the event loop before its
  // own `_coop.set` — so without this, a double-click/duplicate event could
  // have two calls both pass the `_farm2.has(socket.id)` guard while the
  // first is still in flight and deploy the same leader twice. Same shape as
  // _a3.starting (see _a3TryStart's own comment).
  const _farm2Starting = new Set();

  function _farm2GroupStateFor(socketId) {
    const leaderId = _farm2GroupOf.get(socketId);
    const g = leaderId && _farm2Groups.get(leaderId);
    if (!g) return { inGroup: false };
    const members = [...g.members.entries()].map(([id, name]) => ({ id, name }));
    return {
      inGroup: true,
      isLeader: socketId === leaderId,
      leaderId, leaderName: g.leaderName,
      members, maxMembers: FARM2_PARTY_SIZE - 1,
    };
  }

  function _farm2GroupPush(socketId, reason) {
    const st = _farm2GroupStateFor(socketId);
    if (reason) st.reason = reason;
    io.to(socketId).emit('farm2GroupState', st);
  }

  // Only groups still short a member are worth offering.
  function _farm2GroupOpenList() {
    const groups = [];
    _farm2Groups.forEach((g, leaderId) => {
      if (g.members.size < FARM2_PARTY_SIZE - 1 && io.sockets.sockets.get(leaderId)) {
        groups.push({ id: leaderId, leaderName: g.leaderName, size: g.members.size + 1, maxSize: FARM2_PARTY_SIZE });
      }
    });
    return groups;
  }

  function _farm2GroupBroadcastList() {
    io.emit('farm2GroupList', { groups: _farm2GroupOpenList() });
  }

  // Leader gone dissolves the whole group; every member is notified so their
  // panel drops back to idle rather than waiting forever on a leader who's no
  // longer there.
  function _farm2GroupDissolve(leaderId, reason) {
    const g = _farm2Groups.get(leaderId);
    if (!g) return;
    _farm2Groups.delete(leaderId);
    _farm2GroupOf.delete(leaderId);
    g.members.forEach((_, mid) => {
      _farm2GroupOf.delete(mid);
      _farm2GroupPush(mid, reason);
    });
    _farm2GroupBroadcastList();
  }

  // Disconnect while still in the lobby (never reached a live run) drops the
  // disconnecting side immediately — no reconnect grace, same as Coop's own
  // lobby (_coopGroupDropOnDisconnect).
  function _farm2GroupDropOnDisconnect(socketId) {
    const leaderId = _farm2GroupOf.get(socketId);
    if (!leaderId) return;
    if (leaderId === socketId) {
      _farm2GroupDissolve(leaderId, 'leaderLeft');
    } else {
      const g = _farm2Groups.get(leaderId);
      if (g && g.members.has(socketId)) {
        g.members.delete(socketId);
        _farm2GroupOf.delete(socketId);
        _farm2GroupPush(leaderId);
        _farm2GroupBroadcastList();
      }
    }
  }

  // Every Элитная фарм-зона run gets its OWN Room, shared by exactly its
  // FARM2_PARTY_SIZE participants, created here and never registered in
  // floorRooms — same reasoning as _createCoopRoom's own comment.
  function _createFarm2Room() {
    const room = new Room(FLOOR_IDS.farmZone2, io, {}, null);
    _farm2Rooms.add(room);
    return room;
  }
  const _farm2Rooms = new Set();
  function _liveFarm2Rooms() {
    const live = [];
    _farm2Rooms.forEach(r => {
      if (r.players.size > 0) live.push(r);
      else _farm2Rooms.delete(r);
    });
    return live;
  }

  // socketId -> { room, participantIds, telegramId, startedAt, chargedMin,
  // capTimer, minuteTimer } for whoever currently has a run going.
  // participantIds is every one of the FARM2_PARTY_SIZE sockets that started
  // this run together, captured once at farm2GroupStart — read by
  // _farm2CascadeCheck to know who else needs to be pulled out the moment
  // membership drops below the full party. telegramId/startedAt/chargedMin are
  // what _farm2SettleMinutes bills the daily allowance from.
  const _farm2 = new Map();

  // Timer jitter, not playtime: a cap timer set for exactly N minutes can fire
  // a few ms late, and without this that overshoot would round a full N-minute
  // run up to N+1. Anything a player could actually farm in is far above it.
  const FARM2_SETTLE_TOLERANCE_MS = 1000;

  // Bill the allowance for the time this run actually lasted.
  //
  // The per-minute ticker (farm2GroupStart) only ever charges WHOLE minutes it
  // lived to see, and it does not live to see the last one: the cap timer and
  // the ticker's final tick are scheduled for the very same millisecond, and
  // the cap timer — created first, so first in the timer queue — ends the run
  // and clears the interval before that tick can run. So a run that lasted
  // exactly its remaining allowance charged one minute LESS than it used, and
  // the player was ejected still holding a minute they could immediately spend
  // on another run, which charged nothing either: the "1 minute left" that
  // never ran out. Walking out under a minute was free for the same reason.
  //
  // Settling here, on every exit path (cap, walking out, party break,
  // disconnect), is what closes both: whole minutes STARTED are what count, so
  // a partial minute rounds up rather than being free, and the total can never
  // undershoot what the ticker already wrote.
  function _farm2SettleMinutes(run) {
    if (!run || !run.startedAt || run.telegramId == null) return;
    const elapsed = Date.now() - run.startedAt - FARM2_SETTLE_TOLERANCE_MS;
    const owed = Math.max(0, Math.ceil(elapsed / 60000) - (run.chargedMin || 0));
    if (owed <= 0) return;
    run.chargedMin = (run.chargedMin || 0) + owed;
    _lockFarm2MinutesFor(run.telegramId, owed);
  }

  function _farm2ClearTimers(socketId) {
    const run = _farm2.get(socketId);
    if (!run) return;
    if (run.capTimer) clearTimeout(run.capTimer);
    if (run.minuteTimer) clearInterval(run.minuteTimer);
  }

  // Ends this ONE participant's own membership — releases their spot on the
  // room, clears their timers, and drops the run record, without deciding
  // where they go or telling anyone else anything (callers that need to end
  // the run for everyone still in call this once per participant still
  // present — see _farm2CascadeCheck). Returns the run it ended, or null.
  function _farm2ReleaseRun(socketId) {
    const run = _farm2.get(socketId);
    if (!run) return null;
    _farm2ClearTimers(socketId);
    // Before the record goes: the ticker is stopped now, so whatever it never
    // got to charge has to be settled here or it is never charged at all.
    _farm2SettleMinutes(run);
    _farm2.delete(socketId);
    if (run.room) run.room.farm2Release(socketId);
    return run;
  }

  // extra — кто и почему развалил группу ({ who, why }), чтобы остальные
  // видели причину, а не одно «осталось меньше 3».
  function _farm2Finish(socketId, reason, extra) {
    const run = _farm2ReleaseRun(socketId);
    if (!run) return;
    const spot = _returnToHub(socketId);
    io.to(socketId).emit('farm2Finished', { reason, x: spot?.x, y: spot?.y, ...(extra || {}) });
  }

  // Called after any ONE participant's own membership just ended (finished,
  // disconnected, dropped out of the run's party) — the zone was only ever
  // entered as a full FARM2_PARTY_SIZE, so if fewer than that are still
  // actually in the room, whoever's left can't continue and the whole run
  // ends for them too. `room`/`participantIds` are the ones captured on the
  // run record BEFORE the triggering release, since that release already
  // removed its own socket from `_farm2`.
  function _farm2CascadeCheck(room, participantIds, cause) {
    if (!room || !participantIds) return;
    const stillIn = participantIds.filter(sid => _farm2.has(sid) && _farm2.get(sid).room === room);
    if (stillIn.length > 0 && stillIn.length < FARM2_PARTY_SIZE) {
      stillIn.forEach(sid => {
        // Ждущий переподключения (_farm2Held) — тоже участник: снять его
        // ожидание, раз забега больше нет.
        _farm2DropHeldFor(sid);
        _farm2Finish(sid, 'partyBroken', cause);
      });
    }
  }

  // Wired into _removeFromParty's fan-out (mirrors _coopEliminate) — dropping
  // out of the run's temporary party (an explicit partyLeave, or any other
  // removal path) ends this participant's own membership and, if that leaves
  // fewer than a full party still in, ends the run for the rest too.
  function _farm2Eliminate(socketId) {
    const run = _farm2.get(socketId);
    if (!run) return false;
    const { room, participantIds } = run;
    _farm2DropHeldFor(socketId);
    _farm2Finish(socketId, 'left');
    _farm2CascadeCheck(room, participantIds, { who: run.name, why: 'leftParty' });
    return true;
  }

  // Disconnect-class exit — no reconnect grace (same choice Coop made for its
  // own live runs): the disconnecting socket is already gone, so this only
  // releases its own spot/timers (no _returnToHub/farm2Finished round trip —
  // there is nothing to tell it) and cascades to whoever is still in.
  function _farm2EjectOnDisconnect(socketId) {
    const run = _farm2ReleaseRun(socketId);
    if (!run) return false;
    _farm2CascadeCheck(run.room, run.participantIds, { who: run.name, why: 'disconnect' });
    return true;
  }

  // ── переподключение ────────────────────────────────────────────────────
  // «С элиткой стабильно выкидывает, пишет что осталось меньше троих — хотя
  // все с фулл хп, интернет нормальный». Телеграм на телефоне рвёт сокет,
  // стоит свернуть приложение, погасить экран или открыть уведомление, — и
  // раньше это мгновенно выкидывало всю тройку. Теперь место держится
  // FARM2_RECONNECT_GRACE_MS (столько же, сколько держится место в группе,
  // server/party.js): вернулся — снова в своей зоне, с тем же здоровьем; не
  // вернулся — как раньше, забег заканчивается для всех.
  const FARM2_RECONNECT_GRACE_MS = 45000;
  // telegramId -> { oldSid, timer, pos }
  const _farm2Held = new Map();

  function _farm2DropHeldFor(sid) {
    for (const [tid, h] of _farm2Held) {
      if (h.oldSid === sid) { clearTimeout(h.timer); _farm2Held.delete(tid); }
    }
  }

  function _farm2HoldOnDisconnect(socketId, telegramId) {
    const run = _farm2.get(socketId);
    if (!run) return false;
    if (telegramId == null) return _farm2EjectOnDisconnect(socketId);
    const tid = String(telegramId);
    const rec = run.room && run.room.players.get(socketId);
    const prior = _farm2Held.get(tid);
    if (prior) clearTimeout(prior.timer);
    const timer = setTimeout(() => {
      const h = _farm2Held.get(tid);
      if (!h || h.oldSid !== socketId) return;
      _farm2Held.delete(tid);
      _farm2EjectOnDisconnect(socketId);
    }, FARM2_RECONNECT_GRACE_MS);
    if (timer.unref) timer.unref();
    _farm2Held.set(tid, { oldSid: socketId, timer, pos: rec ? { x: rec.x, y: rec.y, hp: rec.hp } : null });
    return true;
  }

  // Вызывается, когда переподключившийся уже стоит в мире (handlers2/
  // world.js). Переносит забег на новый socket id и возвращает в ту же
  // комнату. false — ждать было нечего.
  function _farm2ResumeOnLogin(telegramId, newSid, enter) {
    if (telegramId == null) return false;
    const tid = String(telegramId);
    let h = _farm2Held.get(tid);
    if (h) { clearTimeout(h.timer); _farm2Held.delete(tid); }
    else {
      // Старый сокет ещё не отвалился (сервер узнаёт о разрыве только по
      // таймауту пинга) — забег всё ещё записан на него.
      for (const [sid, r] of _farm2) {
        if (sid !== newSid && r.telegramId != null && String(r.telegramId) === tid) {
          const rec = r.room && r.room.players.get(sid);
          h = { oldSid: sid, pos: rec ? { x: rec.x, y: rec.y, hp: rec.hp } : null };
          break;
        }
      }
      if (!h) return false;
    }
    const run = _farm2.get(h.oldSid);
    if (!run) return false;
    // Сначала — переключить запись, потом входить: вход уводит сессию с
    // текущего этажа, и выход из хаба не должен ничего знать о забеге.
    _farm2.delete(h.oldSid);
    run.sid = newSid;
    _farm2.set(newSid, run);
    const ids = run.participantIds;
    const i = ids ? ids.indexOf(h.oldSid) : -1;
    if (i !== -1) ids[i] = newSid;            // один массив на всю тройку
    if (run.room) { run.room.farm2Release(h.oldSid); }
    const spot = h.pos || (run.room && run.room.farm2Entry());
    const ok = enter(run.room, spot);
    if (!ok) {
      // Не смогли вернуть — значит, вышел; остальным честно сказать, кто.
      _farm2Finish(newSid, 'left');
      _farm2CascadeCheck(run.room, ids, { who: run.name, why: 'disconnect' });
      return false;
    }
    if (!run.room._farm2Members) run.room._farm2Members = new Set();
    run.room._farm2Members.add(newSid);
    return { run, pos: spot };
  }

  return {
    FARM2_START_DELAY_MS,
    _farm2Groups, _farm2GroupOf, _farm2Starting, _farm2GroupStateFor, _farm2GroupPush,
    _farm2GroupOpenList, _farm2GroupBroadcastList, _farm2GroupDissolve, _farm2GroupDropOnDisconnect,
    _createFarm2Room, _farm2Rooms, _liveFarm2Rooms,
    _farm2, _farm2ClearTimers, _farm2ReleaseRun, _farm2SettleMinutes, _farm2Finish, _farm2CascadeCheck,
    _farm2Eliminate, _farm2EjectOnDisconnect, _farm2HoldOnDisconnect, _farm2ResumeOnLogin, _farm2Held,
  };
};
