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
function resolveFloor(floorId, progress) {
  const f = Number(floorId);
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
function enterFloor(session, wantedFloor, progress) {
  const target = resolveFloor(wantedFloor, progress);
  const room = floorRooms.get(target);
  if (!room) return session.floor;

  if (session.room && session.room !== room) {
    session.room.removePlayer(session.socket.id);
    session.socket.leave(`floor_${session.floor}`);
  }

  if (session.room !== room) {
    room.addPlayer(
      session.socket.id, session.username,
      progress && progress.clanName, progress && progress.clanIcon,
      progress && progress.clanAtkBonus, session.telegramId,
      progress && progress.clanId,
    );
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
  initFloors, enterFloor, resolveFloor, roomOf, stopAll, statsSnapshot,
  floorRooms, FLOOR_IDS, STANDABLE,
};
