'use strict';
// ── The floors ──────────────────────────────────────────────────────────────
// One Room per floor, created at boot, and the rule for moving between them.
//
// The rule is where the interesting part is. A floor is STORED for a player
// (so a reconnect puts them back where they were rather than in the hub) but
// never TRUSTED: it is re-evaluated against the level they have NOW, every
// time. The world can have moved on while they were away — they may have
// rebirthed back below an arm's requirement, or a timed zone may have closed —
// and honouring a stored floor blindly is a free teleport past every gate.

const Room = require('./game/Room');
const { FLOOR_IDS, FLOOR_REGISTRY } = require('./game/floors');
const { ARM_LEVEL_REQ, FARM_ENTRY_LEVEL } = require('../shared/definitions');

const floorRooms = new Map();

// The generic level gate: every arm's own requirement, plus each simple
// "just a level, no window or queue" zone folded in beside them, so a new one
// needs no dedicated branch below.
const ZONE_LEVEL_REQ = { ...ARM_LEVEL_REQ, farmZone: FARM_ENTRY_LEVEL };
const FLOOR_KEY = Object.fromEntries(Object.entries(FLOOR_IDS).map(([k, v]) => [v, k]));

// Floors a player can simply STAND on. The instanced and scheduled ones are
// deliberately absent: an arena, a race or a Fear run treats a disconnect as
// elimination, so returning someone to an event they are no longer in would be
// worse than the hub.
const STANDABLE = new Set([
  FLOOR_IDS.hub, FLOOR_IDS.left, FLOOR_IDS.top, FLOOR_IDS.bottom, FLOOR_IDS.right,
  FLOOR_IDS.farmZone, FLOOR_IDS.guildWar, FLOOR_IDS.arena,
]);

function initFloors(io, onBossDeath = () => {}) {
  for (const f of FLOOR_REGISTRY) {
    try {
      floorRooms.set(f.id, new Room(f.id, io, {}, onBossDeath));
    } catch (err) {
      // A floor that cannot generate is a hard failure: the world is built from
      // a fixed seed, so this is a code problem, not a transient one, and
      // starting without it would mean players falling through a hole.
      console.error(`[world] floor ${f.key} failed to generate:`, err.message);
      throw err;
    }
  }
  return floorRooms.size;
}

// Is this floor open to this player, right now? Returns the floor they may
// actually be on — which is the hub whenever the answer is no.
// The client names a floor by KEY — 'hub', 'farmZone', 'arena' — because that
// is what its portal table holds. Accepting the number too costs one line and
// keeps every internal caller (respawn, the guild-war deploy, the ETL) able to
// say what it means.
function floorIdOf(target) {
  if (typeof target === 'string' && FLOOR_IDS[target] != null) return FLOOR_IDS[target];
  const n = Number(target);
  return Number.isFinite(n) ? n : NaN;
}

function resolveFloor(floorId, progress) {
  const f = floorIdOf(floorId);
  if (!Number.isFinite(f) || !STANDABLE.has(f)) return FLOOR_IDS.hub;
  if (f === FLOOR_IDS.hub) return FLOOR_IDS.hub;
  const need = ZONE_LEVEL_REQ[FLOOR_KEY[f]] || 0;
  if ((progress && progress.lvl ? progress.lvl : 1) < need) return FLOOR_IDS.hub;
  return f;
}

// Moves a session onto a floor: out of the old Room, into the new one, with
// the level gate applied. Returns the floor they LANDED on, which the caller
// compares against what was asked for to tell "you moved" from "you were
// refused and are still in the hub".
// `force` skips the level gate, and only the SERVER may pass it: a mode
// deploying its entrants into the arena, a run ending and sending everyone
// home, the guild-war window opening. A player request never reaches this with
// force set — enterLocation checks resolveFloor itself and refuses.
function enterFloor(session, wantedFloor, progress, { force = false } = {}) {
  const target = force ? floorIdOf(wantedFloor) : resolveFloor(wantedFloor, progress);
  const room = floorRooms.get(target);
  if (!room) return session.floor;

  if (session.room && session.room !== room) {
    // Same rule as forceFloor's: walking off an instanced floor ends the run
    // that was happening on it. Without this a player who left Страх by any
    // route other than dying kept a run record that silently refused every
    // later entry — to Страх and to every other instanced mode.
    if (typeof session._leaveInstance === 'function') session._leaveInstance(session.floor);
    session.room.removePlayer(session.socket.id);
    session.socket.leave(`floor_${session.floor}`);
  }

  if (session.room !== room) {
    // The clan comes off the SESSION, not off `progress`. player_progress has
    // no clan columns — a clan is a row in clan_members — so these three
    // arguments were undefined on every entry since the rewrite, and the tag
    // over a player's head was null for everyone. Two people in two clans
    // standing beside each other saw nothing over either head.
    const clan = session.clan || null;
    room.addPlayer(
      session.socket.id, session.username,
      clan && clan.name, clan && clan.icon,
      (clan && clan.atkBonus) || 0, session.telegramId,
      clan && clan.clanId,
    );
    // The CLASS, without which the room has a player record with no `type`:
    // no sprite for anyone else to draw, no class multipliers in combat, and
    // the event modes refusing entry with "Выберите персонажа" to someone who
    // chose one months ago. addPlayer alone does not set it, and nothing was
    // calling this.
    //
    // No savedStats argument, deliberately: that path recomputes combat power
    // from a client blob. The numbers arrive immediately afterwards from
    // pushStats, which computed them here.
    if (progress && progress.charClass) {
      room.setPlayerChar(session.socket.id, progress.charClass);
    }
    session.socket.join(`floor_${target}`);
    session.room = room;
    session.floor = target;
  }

  // Where to stand. A stored position is used when it is on this floor AND
  // walkable — the second half matters because a position saved before the
  // walkability guard existed may be inside geometry, and restoring it would
  // put the player straight back into the bug the guard was added to fix.
  const p = room.players.get(session.socket.id);
  if (p) {
    const wantX = progress && progress.x, wantY = progress && progress.y;
    const useStored = target === (progress && progress.floor) &&
      Number.isFinite(wantX) && Number.isFinite(wantY);
    const at = useStored
      ? room._nearestWalkable(wantX, wantY)
      : null;
    const spawn = at || room._nearestWalkable(room._dungeon.spawn.x, room._dungeon.spawn.y)
      || room._dungeon.spawn;
    p.x = spawn.x; p.y = spawn.y;
  }
  return target;
}

function roomOf(floorId) { return floorRooms.get(Number(floorId)) || null; }

function stopAll() {
  for (const r of floorRooms.values()) {
    try { r._stopLoop(); } catch { /* already stopped */ }
  }
}

// What /health reports. Rooms with nobody in them tick out immediately (see
// the players.size check at the top of _tick), so an idle floor costs nothing
// and reporting it as "0 players, 0ms" is the truth rather than noise.
function statsSnapshot() {
  const out = [];
  for (const r of floorRooms.values()) {
    try { out.push(r.stats()); } catch { /* a floor that cannot report is not fatal */ }
  }
  return out;
}

module.exports = {
  initFloors, enterFloor, resolveFloor, floorIdOf, roomOf, stopAll, statsSnapshot,
  floorRooms, FLOOR_IDS, STANDABLE,
};
