const { TILE, WALL, FLOOR, ENEMY_DEF, FLOOR_ENEMIES, bandForLocalLevel, monsterStatsAtLevel, monsterNameAtLevel, monsterColorAtLevel, xpAtLevel, goldAtLevel, ARM_NAMES, ARM_ROOM_PAIRS, ARM_OFFSETS, ARM_LEVEL_REQ, roomsInArm, FARM_LVL_MIN, FARM_LVL_MAX, FARM_MOBS_PER_ROOM, FARM_ENTRY_LEVEL, FARM_XP_MULT, FARM_SPECIES, FARM_HIGH_LVL_MIN, FARM_HIGH_LVL_MAX, FARM_HIGH_MOBS_PER_ROOM, FARM_HIGH_ENTRY_LEVEL, FARM_HIGH_XP_MULT, FARM_HIGH_SPECIES, FARM2_LVL_MIN, FARM2_LVL_MAX, FARM2_ENTRY_LEVEL, FARM2_PARTY_SIZE, FARM2_MOBS_PER_ROOM, FARM2_PACK_SIZE, FARM2_SPD_MULT, FARM2_STAT_MULT, FARM2_XP_PER_KILL, FARM2_SPECIES } = require('../../shared/definitions');

function seededRng(seed) {
  let s = seed >>> 0;
  return function() {
    s += 0x6D2B79F5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Open world: one small hub + 4 detached "comb" zones ─────────────────────
// The hub is just spawn + NPCs + 4 teleport pads (one per arm/level range,
// ARM_LEVEL_REQ) — there's no walkable corridor out of it. Each arm is its
// own floor now (see server/game/floors.js), so there's no neighboring
// zone's room chains to keep clear of any more either. Reaching a zone means
// walking onto its hub pad, which requests a real floor transition — see the
// teleport-pad handling in js/game.js.
//
// Inside a zone the layout is unchanged from before: a dead-straight, always-
// empty main corridor with rooms branching off both sides at ARM_ROOM_PAIRS
// [armIdx-1] evenly spaced positions. Each branch chains ROOM_CHAIN_LEN rooms
// in a row (linked by more short stubs) instead of stopping at one, so every
// position has ROOM_CHAIN_LEN rooms per side, all sharing the same monster
// level. The very last position's far side is the exception: a single,
// un-chained boss room. Global room level = arm's base (ARM_OFFSETS[armIdx-1])
// + position-in-arm, reusing one FLOOR_ENEMIES pool per arm (arm index 1-4
// standing in for the old floor 1-4 themes) so enemy stats/gold/xp tuning
// carries over unchanged.
const HUB = 48;           // hub room size (tiles) — spawn + 2 NPCs + 4 teleport pads;
                          // safe to keep small since nothing physically borders it anymore
const SMALL = 9;          // 9×9 → 5 monsters
const LARGE = 14;         // 14×14 → 10 monsters
const CW = 1;             // main corridor half-width (3 tiles wide total)
const BW = 1;             // branch corridor half-width (3 tiles wide total)
const STUB = 6;           // branch length between the main corridor / each chained room
const GAUNTLET_STUB = 12; // wider branch spacing for the local-level-19 pre-boss gauntlet
                          // rooms (see HAS_LVL19_GAUNTLET below) — the default STUB (6 tiles
                          // = 240px) is barely past a monster's max aggro radius (175 + 55 =
                          // 230px), so a player on auto-attack/chase could get dragged clean
                          // out of one gauntlet room into the next one's fight; double the gap
                          // there so that can't happen.
const PITCH = 20;         // tile spacing between consecutive room-pair positions
const LEAD_IN = 10;       // distance from a zone's entrance to its first position
const MARGIN = 10;        // outer wall padding
const ROOM_CHAIN_LEN = 6; // rooms chained per side per position (except the boss slot, always 1)

const REACH = CW + ROOM_CHAIN_LEN * (GAUNTLET_STUB + LARGE); // max perpendicular room-chain reach from the corridor centerline (sized off the wider gauntlet stub, the deepest any chain gets)
const ZONE_H = REACH * 2 + 4; // both sides plus a little pad

const HUB_X0 = MARGIN, HUB_Y0 = MARGIN;
// ── Boss arena ──────────────────────────────────────────────────────────────
// Its own floor now (generateArena, below). Sized so a size-165 boss (≈630px
// across) has room to be kited and its 62 loot piles still land well inside
// the walls.
const ARENA = 40;
// ── 3v3 PvP arena ───────────────────────────────────────────────────────────
// Its own floor now (generatePvpArena, below). Two team bases facing each
// other across a single central corridor — one lane, so both teams meet
// head-on instead of splitting into side skirmishes. Sealed off the same way
// every other special zone is: the only way in is being placed there by the
// match, and the only way out is dying or the match ending. Players only —
// the match is decided by wiping the other side, with nothing else on the
// floor to hit.
const A3_W = 60, A3_H = 27;
const A3_BASE_W = 10;                       // depth of each team's starting box
const A3_LANE_YS = [13];                    // single corridor row, relative to the floor's own Y0
// Spawn rows are kept separate from the (now singular) lane row so a team's
// 3 players still land on 3 distinct tiles inside their own base instead of
// stacking on the one lane spawn.
const A3_SPAWN_YS = [4, 13, 22];
const A3_LANE_HW = 1;                       // half-width: 3 tiles for the corridor

// ── Corridor race ("Кровавая Башня") ─────────────────────────────────────────
// Its own floor now (generateRace10, below). Every entrant runs their own
// sealed lane: 60 level-5 monsters packed shoulder-to-shoulder, a short gap,
// then 60 level-10 monsters the same way — "впритык", so there's no way past
// them except fighting through. All lanes open into ONE shared room at the
// far end holding a single boss (same identity as the world EVENT_BOSS — see
// spawnRaceBoss, server/game/Room.js). Whoever has dealt it the most damage
// when it dies wins; dying anywhere in a lane eliminates that player from
// the run (see the 'respawn' handler, server/index.js).
//
// The event takes however many players register, one lane each — but the
// floor is generated once at startup and its geometry never changes, so the
// lanes have to exist before anyone signs up. This is the ceiling on
// entrants (RACE10_MAX_ENTRANTS, server/index.js reads it from here):
// raising it costs RACE10_LANE_PITCH tiles of map height and
// RACE10_MOB_PER_TIER*2 monsters, and those monsters are skipped by the AI
// loop entirely while no race is running (see the race10 branch in Room.js's
// _tick), so an unused lane costs nothing per tick.
const RACE10_LANES        = 50;
const RACE10_LANE_HW      = 1;   // half-width — 3 tiles wide, same convention as every other corridor
const RACE10_LANE_GAP     = 2;   // wall tiles between adjacent lanes
const RACE10_LANE_PITCH   = RACE10_LANE_HW * 2 + 1 + RACE10_LANE_GAP; // 5 tiles, row to row
const RACE10_MOB_PER_TIER = 60;
const RACE10_MOB_SPACING  = 30;  // px between consecutive monster centres within a tier — "впритык"
const RACE10_XP_MULT      = 4;   // corridor kills grant 4x normal XP — part of the event's own reward, not just the boss-damage prize
const RACE10_TIER_LEN     = Math.ceil((RACE10_MOB_PER_TIER * RACE10_MOB_SPACING) / TILE); // tiles
const RACE10_TIER_GAP     = 4;   // tiles between the level-5 line and the level-10 line
// Spawn sits 2 tiles into the lane (see the `lanes` spot below) — LEAD_IN has
// to clear the first monster's aggro radius (up to 230px, aggroR = 175 +
// rng()*55) from there, or a monster could start hitting a still-frozen
// player during the pre-race countdown with no way to fight back or flee.
const RACE10_LEAD_IN      = 9;   // (9-2)*40 = 280px clearance
const RACE10_LEAD_OUT     = 6;   // last monster to the shared boss room
const RACE10_LANE_LEN     = RACE10_LEAD_IN + RACE10_TIER_LEN * 2 + RACE10_TIER_GAP + RACE10_LEAD_OUT;
// Barrier positions (tile x, relative to the floor's own X0) — centred in
// the gap after each tier's monster line, so the player runs into it right
// where the line ends rather than partway through empty corridor.
// Client-side only (see _isRaceBarrierBlocked, js/game.js) — same trust
// model as the level gates elsewhere in the open world (dungeon.corridorGates).
const RACE10_BARRIER1_X = RACE10_LEAD_IN + RACE10_TIER_LEN + RACE10_TIER_GAP / 2;
const RACE10_BARRIER2_X = RACE10_LEAD_IN + RACE10_TIER_LEN * 2 + RACE10_TIER_GAP + RACE10_LEAD_OUT / 2;
const RACE10_BOSS_ROOM    = 44;  // shared room, square
const RACE10_H  = RACE10_LANES * RACE10_LANE_PITCH;
const RACE10_W  = RACE10_LANE_LEN + RACE10_BOSS_ROOM;

// ── Страх (Fear) — one private instance per entrant ─────────────────────────
// Used to be FEAR_LANES identical sealed rooms sharing one Room object — a
// fixed pool of concurrent runs that could fill up and make an entrant wait.
// Every fearEnter now builds its own fresh Room (server/index.js's
// _createFearRoom), each with its own call to generateFear() below, so
// there is exactly one lane because there is exactly one possible occupant;
// "lane" survives purely as the coordinate scheme Room.js's fear methods
// already speak (fearDeploy/fearSpawnWave/etc. all still work unmodified —
// they just never see more than lane 0). No baked-in monsters either way:
// each wave (20 monsters, escalating one global level at a time) is spawned
// dynamically at runtime by Room.js's fearSpawnWave once the player is
// deployed, so only the room's geometry needs to exist ahead of time.
const FEAR_LANES = 1;
const FEAR_ROOM   = 12;    // room size (tiles) — tight enough that a wave doesn't feel spread thin
const FEAR_GAP    = 8;     // wall padding (irrelevant now with only one room, kept for the shared pitch math below)
const FEAR_PITCH  = FEAR_ROOM + FEAR_GAP;

// ── Война гильдий (Guild War) ────────────────────────────────────────────────
// Its own floor now (generateGuildWar, below). One square sealed zone with a
// single stationary tower/castle dead centre. Whichever clan lands the
// killing blow owns it (Room.js's capture logic resets its HP in place — it
// is never despawned/respawned, see Room.spawnGuildWarTower). No
// matchmaking/capacity cap ("Без ограничений — открытая зона"), so sized
// generously like the boss ARENA rather than tightly like a sealed instance.
// `spawns` is a ring of entry points used both for initial placement and for
// in-zone respawn while the window is live (Room.guildWarRespawn) — dying
// here doesn't eject you, unlike every other sealed zone.
const GW_SIZE = 60;
const GW_SPAWN_COUNT = 8;
const GW_SPAWN_R = Math.floor(GW_SIZE / 2) - 4;

// ── Фарм-зона (Farm Zone) ─────────────────────────────────────────────────
// Its own floor now (generateFarmZone, below). Four identical square rooms
// in a 2x2 grid, joined by a plus-shaped corridor through their shared gap
// so all four are reachable from one entrance — the whole footprint (rooms +
// gap) is itself a square. Baked in at world-gen like a regular room (not
// runtime-spawned like Fear's waves), since every monster here is a fixed
// level with no escalation to track. Monsters spawn non-aggressive (aggroR:
// 0 — never pull first, same pattern as spawnGuildWarTower) and skip the
// normal loot table entirely: only an independent FARM_SHARD_CHANCE roll per
// shard kind, no gold/gear/recipe/key drops at all (see the farmZone flag,
// Room.attackEnemy/skillAttackEnemy and _rollFarmZoneLoot, server/index.js).
// Entry is level-gated server-side (see _doEnterLocation, server/index.js)
// at FARM_ENTRY_LEVEL. Each of the 80 monsters rolls its own level (21-30)
// and species/archetype independently, so every room comes out mixed —
// different kinds and different levels standing next to each other, not one
// uniform pack the way a normal room is.
// FARM_LVL_MIN/MAX, FARM_MOBS_PER_ROOM, FARM_ENTRY_LEVEL, FARM_XP_MULT and
// FARM_SPECIES now live in shared/definitions.js (imported above) — the
// client needs them too, for its own Фарм-зона reference list (js/ui.js).
const FARM_ROOM = 16;
const FARM_GAP = 8;
const FARM_SIZE = FARM_ROOM * 2 + FARM_GAP;

// ── Элитная фарм-зона (Elite Farm Zone 2) ─────────────────────────────────
// Its own floor now (generateFarmZone2, below) — a private instance built
// fresh per party run (see server/index.js's farm2Group* lobby), not a
// shared always-on floor the way the original Фарм-зона is. An entrance
// corridor (dead straight, always empty — same convention every other
// zone's own entrance corridor uses) forks at one point into two short
// branches, one to each of the two identical rooms — reuses LEAD_IN/STUB,
// the same corridor-length/branch-length constants generateArm's own
// buildRoomChain uses for exactly this "branch off the main corridor into a
// room" shape, just applied once per side (north/south) at a single fork
// position instead of a whole chain of them. FARM2_ROOM is sized for
// FARM2_MOBS_PER_ROOM (50) monsters at roughly the same density the
// original farm zone's 20-per-16x16-room uses, since these monsters are
// aggressive (pull on approach, unlike the original zone's aggroR-exempted
// ones) and run full (non-halved) stats — see FARM2_SPECIES and shared/
// definitions.js's own comment on the Elite Farm Zone constants.
const FARM2_ROOM = 30;

// The hub is now the only thing that lives in its own grid — every special
// zone and every leveling arm has moved out into its own floor (see
// server/game/floors.js), so this only needs to fit the hub room itself.
const DH = MARGIN * 2 + HUB;
const DW = MARGIN * 2 + HUB;

const _enemyByEid = new Map(ENEMY_DEF.map(e => [e.eid, e]));

function generateHub() {
  const grid = Array.from({ length: DH }, () => new Array(DW).fill(WALL));

  function inBounds(gx, gy) { return gx >= 0 && gx < DW && gy >= 0 && gy < DH; }
  function paintFloor(gx, gy) { if (inBounds(gx, gy)) grid[gy][gx] = FLOOR; }
  function paintRect(x0, y0, x1, y1) {
    for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) paintFloor(gx, gy);
  }

  const hub = {
    x: HUB_X0, y: HUB_Y0, size: HUB,
    bx1: HUB_X0 - 1, by1: HUB_Y0 - 1, bx2: HUB_X0 + HUB + 1, by2: HUB_Y0 + HUB + 1,
    cx: HUB_X0 + Math.floor(HUB / 2), cy: HUB_Y0 + Math.floor(HUB / 2),
    isHub: true,
  };
  paintRect(hub.x, hub.y, hub.x + hub.size - 1, hub.y + hub.size - 1);

  const rooms = [hub];
  const enemyList = [];

  const armEntries = ARM_NAMES.map(dir => ({ dir, req: ARM_LEVEL_REQ[dir] || 0 }));

  return {
    grid, rooms, w: DW, h: DH,
    spawn: { x: hub.cx * TILE + TILE / 2, y: hub.cy * TILE + TILE / 2 },
    safeZone: { x1: hub.bx1 * TILE, y1: hub.by1 * TILE, x2: hub.bx2 * TILE, y2: hub.by2 * TILE },
    // {dir, req} per arm — where to go and the level gate, resolved into an
    // actual floor by the client's enterLocation request (js/network.js);
    // no target x/y here any more, each arm lives on its own floor now.
    armEntries,
    // Same idea, one entry, for the Фарм-зона hub pad: just the level gate
    // the pad itself needs to draw locked/unlocked — the zone's own geometry
    // now lives entirely on its own floor (generateFarmZone, below), not here.
    farmZoneEntry: { req: FARM_ENTRY_LEVEL },
    // Фарм зона 2 — второй такой же пункт списка телепорта, со своим гейтом.
    // Отдельное поле, а не второй элемент farmZoneEntry: клиент читает эти
    // два по имени, и «список фарм-зон» на две зоны стоил бы обеим сторонам
    // больше, чем стоит одна строка.
    farmHighEntry: { req: FARM_HIGH_ENTRY_LEVEL },
    enemies: enemyList,
  };
}

// One leveling arm (left/top/bottom/right), now its OWN floor with its own
// small 0,0-origin grid instead of a Y-banded slice of the old shared
// mega-grid — everything below is buildArm() from the pre-split
// generateOpenWorld(), unindented, with the corridor's centerline anchored
// at a local yOrigin (MARGIN) instead of a position among the other arms.
function generateArm(dir, armIdx) {
  const rng = seededRng(2026 * 1337 + 777 + armIdx);
  const fe = FLOOR_ENEMIES[armIdx];
  const pairs = ARM_ROOM_PAIRS[armIdx - 1];
  const roomCount = roomsInArm(armIdx);
  const maxLocalLvl = roomCount - 1; // last room is the boss; ranks/colors ramp to this
  // True for every arm whose pre-boss position lands exactly on local level
  // 19 (left/top/bottom; 'right' is one pair short and never reaches it).
  // Those arms get a second 6-large-room level-19 gauntlet corridor one
  // more position further out, past the boss junction — see below.
  const HAS_LVL19_GAUNTLET = (pairs - 1) * 2 + 1 === 19;

  const yOrigin = MARGIN;
  const lastPos = HAS_LVL19_GAUNTLET ? pairs : pairs - 1; // one extra PITCH for the second level-19 gauntlet
  const mainStart = MARGIN;
  const mainEnd = mainStart + LEAD_IN + lastPos * PITCH + Math.floor(PITCH / 2);
  const fixedCoord = yOrigin + Math.floor(ZONE_H / 2);
  const DW_ARM = mainEnd + MARGIN;
  const DH_ARM = ZONE_H + yOrigin * 2;

  const grid = Array.from({ length: DH_ARM }, () => new Array(DW_ARM).fill(WALL));
  function inBounds(gx, gy) { return gx >= 0 && gx < DW_ARM && gy >= 0 && gy < DH_ARM; }
  function paintFloor(gx, gy) { if (inBounds(gx, gy)) grid[gy][gx] = FLOOR; }
  function paintRect(x0, y0, x1, y1) {
    for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) paintFloor(gx, gy);
  }

  const rooms = [];
  const enemyList = [];
  const corridorGates = [];
  let eid = 0;

  function pickEnemy(isBoss, localLvl) {
    if (isBoss) return _enemyByEid.get(fe.boss);
    const pool = bandForLocalLevel(fe, localLvl).pool;
    return _enemyByEid.get(pool[Math.floor(rng() * pool.length)]);
  }

  // Main corridor: one dead-straight, always-empty strip from the zone's
  // entrance out to the last position (plus a little tail), 3 tiles wide.
  paintRect(mainStart, fixedCoord - CW, mainEnd, fixedCoord + CW);

  // Level-gated checkpoints between each room-pair position — same
  // level-gate mechanic that used to guard the arm's entrance (now the
  // teleport pad's own level check does that job instead), just repeated
  // at every position boundary along the corridor. Gate before position
  // `pos` requires the level of that position's first (weaker) room —
  // e.g. the gate before the room pair hosting local levels 3-4 requires
  // character level 3.
  for (let pos = 1; pos < pairs; pos++) {
    const boundary = mainStart + LEAD_IN + (pos - 0.5) * PITCH;
    const req = ARM_OFFSETS[armIdx - 1] + (pos * 2 + 1);
    corridorGates.push({ dir, tx: Math.round(boundary), ty: fixedCoord, req });
  }

  function spawnRoomEnemies(room, x, y, size, isBoss) {
    const count = isBoss ? 1 : (room.isSmall ? 5 : 10);
    const weakMult = isBoss ? 1 : 0.5; // regular monsters spawn in packs — halved individually
    for (let n = 0; n < count; n++) {
      const d = pickEnemy(isBoss, room.localLvl);
      if (!d) continue;
      let ex = room.cx * TILE + TILE / 2, ey = room.cy * TILE + TILE / 2;
      for (let attempt = 0; attempt < 40; attempt++) {
        const gx = x + 1 + Math.floor(rng() * Math.max(1, size - 2));
        const gy = y + 1 + Math.floor(rng() * Math.max(1, size - 2));
        if (inBounds(gx, gy) && grid[gy][gx] === FLOOR) { ex = gx * TILE + TILE / 2; ey = gy * TILE + TILE / 2; break; }
      }
      const stats = monsterStatsAtLevel(room.monsterLvl, isBoss ? 'boss' : d.eType);
      // Movement speed isn't part of monsterStatsAtLevel (it's flat per
      // species in ENEMY_DEF) — scale it up separately past level 20 (and
      // for the level-20 boss itself, see below) to match the HP jumps.
      const isLvl20Boss = isBoss && room.monsterLvl === 20;
      const spdMult = (room.monsterLvl > 20 || isLvl20Boss) ? 1.5 : 1;
      // The boss guarding the end of the starting arm (level 20, right
      // before the level-20 gate) gets an extra x10 HP on top of the
      // regular BOSS_HP_MULT — it was underwhelming next to the buffed
      // level-21+ mobs that immediately follow it.
      const boss20HpMult = isLvl20Boss ? 10 : 1;
      enemyList.push({
        id: `e_${dir}_${eid++}`, ...d, isBoss, arm: dir,
        rlvl: room.monsterLvl,
        name: monsterNameAtLevel(d.name, room.localLvl, isBoss, d.fem, maxLocalLvl),
        color: monsterColorAtLevel(d.color, d.endColor, room.localLvl, isBoss, maxLocalLvl),
        maxHp: Math.floor(stats.hp * weakMult * boss20HpMult), hp: Math.floor(stats.hp * weakMult * boss20HpMult),
        atk: Math.floor(stats.atk * weakMult),
        def: stats.def,
        spd: d.spd * spdMult,
        xp: xpAtLevel(room.monsterLvl), gold: goldAtLevel(room.monsterLvl),
        x: ex, y: ey, spawnX: ex, spawnY: ey,
        atkTimer: 1 + rng(), aggro: false, aggroR: 175 + rng() * 55,
      });
    }
  }

  // side = -1 (near/top side of the corridor) or +1 (far/bottom side).
  // Chains `chainLen` rooms in a row starting from the main corridor's
  // edge and going outward — each subsequent room links to the previous
  // one via another short stub instead of the main corridor, so the
  // corridor itself never gets any longer/wider. All rooms in the chain
  // share the same localLvl/monsterLvl (more room to fight the same
  // level's monsters, not more levels).
  function buildRoomChain(pos, side, localLvl, chainLen, isBoss, stub = STUB) {
    const alongCenter = mainStart + LEAD_IN + pos * PITCH;
    let cursor = side < 0 ? (fixedCoord - CW) : (fixedCoord + CW); // outer edge of whatever it's linking from

    for (let i = 0; i < chainLen; i++) {
      const roomIsBoss = isBoss && i === chainLen - 1;
      // Local level 19 — the row right before the level-20 boss slot in
      // every arm that reaches it — is the pre-boss gauntlet: all 6 rooms
      // large (10 monsters each) instead of the usual random small/large
      // mix, same treatment as a boss room.
      const size = (roomIsBoss || localLvl === 19) ? LARGE : (rng() < 0.5 ? SMALL : LARGE);

      const x = alongCenter - Math.floor(size / 2);
      const y = side < 0 ? (cursor - stub - size) : (cursor + stub);
      const branchX0 = alongCenter - BW, branchX1 = alongCenter + BW;
      const branchY0 = side < 0 ? (y + size) : cursor;
      const branchY1 = side < 0 ? (cursor - 1) : (y - 1);

      const cx = x + Math.floor(size / 2), cy = y + Math.floor(size / 2);
      const room = {
        x, y, size,
        bx1: x - 1, by1: y - 1, bx2: x + size + 1, by2: y + size + 1,
        cx, cy, isSmall: size === SMALL,
        arm: dir, localLvl, monsterLvl: ARM_OFFSETS[armIdx - 1] + localLvl, isBoss: roomIsBoss,
      };
      rooms.push(room);
      paintRect(x, y, x + size - 1, y + size - 1);
      paintRect(branchX0, branchY0, branchX1, branchY1);
      spawnRoomEnemies(room, x, y, size, roomIsBoss);

      cursor = side < 0 ? y : (y + size);
    }
  }

  for (let pos = 0; pos < pairs; pos++) {
    const lvlA = pos * 2 + 1, lvlB = pos * 2 + 2;
    const lvlBIsBossSlot = lvlB === roomCount;
    buildRoomChain(pos, -1, lvlA, ROOM_CHAIN_LEN, false, lvlA === 19 ? GAUNTLET_STUB : STUB);
    buildRoomChain(pos, 1, lvlB, lvlBIsBossSlot ? 1 : ROOM_CHAIN_LEN, lvlBIsBossSlot);
  }

  if (HAS_LVL19_GAUNTLET) {
    // Second level-19 gauntlet: an identical 6-large-room chain one more
    // corridor position past the boss junction (near side only — the far
    // side here just stays plain corridor, nothing needs it). Doubles the
    // farming space at the level everyone bottlenecks on right before the
    // level-20 gate.
    buildRoomChain(pairs, -1, 19, ROOM_CHAIN_LEN, false, GAUNTLET_STUB);
  }

  // Where a teleport into this arm drops the player — right at the start
  // of its main corridor, clear of the return pad and the first rooms. The
  // return pad sits two tiles further back, right at the entrance, so
  // walking back onto it (rather than forward into the corridor) is what
  // triggers enterLocation({target:'hub'}) client-side.
  const spawn = { x: (mainStart + 2) * TILE + TILE / 2, y: fixedCoord * TILE + TILE / 2 };
  const returnPad = { x: mainStart * TILE + TILE / 2, y: fixedCoord * TILE + TILE / 2 };

  return {
    grid, rooms, w: DW_ARM, h: DH_ARM,
    spawn,
    returnPad,
    corridorGates,
    enemies: enemyList,
  };
}

// Война гильдий (Guild War), now its own floor (see server/game/floors.js)
// instead of a rectangle painted into the hub's mega-grid — same self-
// contained small 0,0-origin grid pattern generateArm() above uses. One
// square sealed zone with a single stationary tower dead centre; `spawns` is
// a ring of entry points reused both for initial placement (server/index.js's
// enterLocation('guildWar')) and in-zone respawn while the window is live
// (Room.guildWarRespawn) — dying here doesn't eject you, unlike every other
// sealed zone. `bounds` covers the whole grid (there's nothing else on this
// floor to distinguish it from) so the existing position-driven pvpMode
// check in Room.js's _tick keeps working unchanged: everyone on this floor
// is inside `bounds` from the moment they land.
function generateGuildWar() {
  const w = GW_SIZE + MARGIN * 2, h = GW_SIZE + MARGIN * 2;
  const grid = Array.from({ length: h }, () => new Array(w).fill(WALL));
  function inBounds(gx, gy) { return gx >= 0 && gx < w && gy >= 0 && gy < h; }
  function paintFloor(gx, gy) { if (inBounds(gx, gy)) grid[gy][gx] = FLOOR; }
  function paintRect(x0, y0, x1, y1) {
    for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) paintFloor(gx, gy);
  }

  const gw = {
    x: MARGIN, y: MARGIN, size: GW_SIZE,
    bx1: MARGIN - 1, by1: MARGIN - 1, bx2: MARGIN + GW_SIZE + 1, by2: MARGIN + GW_SIZE + 1,
    cx: MARGIN + Math.floor(GW_SIZE / 2), cy: MARGIN + Math.floor(GW_SIZE / 2),
    isGuildWar: true,
  };
  paintRect(gw.x, gw.y, gw.x + gw.size - 1, gw.y + gw.size - 1);

  const cx = gw.cx * TILE + TILE / 2, cy = gw.cy * TILE + TILE / 2;
  const spawns = Array.from({ length: GW_SPAWN_COUNT }, (_, i) => {
    const ang = (i / GW_SPAWN_COUNT) * Math.PI * 2;
    return { x: cx + Math.cos(ang) * GW_SPAWN_R * TILE, y: cy + Math.sin(ang) * GW_SPAWN_R * TILE };
  });
  // Sits just inside the north-west corner, clear of the tower and the spawn
  // ring — walking onto it triggers enterLocation({target:'hub'}) client-side
  // the same generic way an arm's own returnPad does (js/game.js).
  const returnPad = { x: (gw.x + 3) * TILE + TILE / 2, y: (gw.y + 3) * TILE + TILE / 2 };

  return {
    grid, rooms: [gw], w, h,
    // Одно значение, а не геттер. Геттер здесь был ошибкой: вызывающие читают
    // `d.spawn.x` и `d.spawn.y` двумя обращениями, и каждое выбирало бы СВОЮ
    // точку — игрок попадал бы по иксу от одной, по игреку от другой, то есть
    // куда угодно, в том числе в стену.
    //
    // Случайность живёт там, где игрока ставят: Room.spawnPointFor (см. её
    // комментарий). Здесь остаётся значение по умолчанию.
    spawn: spawns[0],
    returnPad,
    guildWar: { cx, cy, spawns, bounds: { x0: 0, y0: 0, x1: w, y1: h } },
    enemies: [],
  };
}

// Фарм-зона (Farm Zone), now its own floor (see server/game/floors.js)
// instead of a corner of the hub's mega-grid — same self-contained small
// 0,0-origin grid pattern generateGuildWar() above uses. Four identical
// square rooms in a 2x2 grid joined by a plus-shaped corridor through their
// shared gap, baked in at world-gen (not runtime-spawned) since every
// monster here is a fixed level range with no escalation to track. Entry is
// level-gated server-side now (see _doEnterLocation, server/index.js) —
// FARM_ENTRY_LEVEL used to only ever be checked client-side.
function generateFarmZone() {
  const rng = seededRng(2026 * 1337 + 777 + 600);
  const w = FARM_SIZE + MARGIN * 2, h = FARM_SIZE + MARGIN * 2;
  const grid = Array.from({ length: h }, () => new Array(w).fill(WALL));
  function inBounds(gx, gy) { return gx >= 0 && gx < w && gy >= 0 && gy < h; }
  function paintFloor(gx, gy) { if (inBounds(gx, gy)) grid[gy][gx] = FLOOR; }
  function paintRect(x0, y0, x1, y1) {
    for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) paintFloor(gx, gy);
  }

  const X0 = MARGIN, Y0 = MARGIN;
  const roomCoords = [
    { x: X0, y: Y0 },                                     // top-left
    { x: X0 + FARM_ROOM + FARM_GAP, y: Y0 },              // top-right
    { x: X0, y: Y0 + FARM_ROOM + FARM_GAP },              // bottom-left
    { x: X0 + FARM_ROOM + FARM_GAP, y: Y0 + FARM_ROOM + FARM_GAP }, // bottom-right
  ];
  const rooms = roomCoords.map(({ x, y }) => {
    const room = {
      x, y, size: FARM_ROOM,
      bx1: x - 1, by1: y - 1, bx2: x + FARM_ROOM + 1, by2: y + FARM_ROOM + 1,
      cx: x + Math.floor(FARM_ROOM / 2), cy: y + Math.floor(FARM_ROOM / 2),
      // Level varies per monster (FARM_LVL_MIN-FARM_LVL_MAX) — this is just a
      // representative midpoint for the HUD's single-number room label.
      isFarmZone: true, monsterLvl: Math.round((FARM_LVL_MIN + FARM_LVL_MAX) / 2), arm: 'farmZone',
    };
    paintRect(x, y, x + FARM_ROOM - 1, y + FARM_ROOM - 1);
    return room;
  });
  const midX = X0 + Math.floor(FARM_SIZE / 2);
  // Top-row and bottom-row corridors (through the horizontal gap), plus one
  // vertical corridor through the centre column tying both rows together —
  // every room reaches every other one without lengthening any room itself.
  paintRect(X0, rooms[0].cy - CW, X0 + FARM_SIZE - 1, rooms[0].cy + CW);
  paintRect(X0, rooms[2].cy - CW, X0 + FARM_SIZE - 1, rooms[2].cy + CW);
  paintRect(midX - CW, Y0, midX + CW, Y0 + FARM_SIZE - 1);
  const midY = Y0 + Math.floor(FARM_SIZE / 2);

  // Same halving every other packed room applies ("regular monsters spawn
  // in packs — halved individually") — 20 in a 16x16 room is denser than
  // the usual 5-10, so this matters here too.
  const FARM_WEAK_MULT = 0.5;
  const maxLocalLvl = roomsInArm(2) - 1; // arm 2's own rank scale (19)
  const enemyList = [];
  let eid = 0;
  rooms.forEach((room, ri) => {
    for (let n = 0; n < FARM_MOBS_PER_ROOM; n++) {
      const d = _enemyByEid.get(FARM_SPECIES[Math.floor(rng() * FARM_SPECIES.length)]);
      if (!d) continue;
      const lvl = FARM_LVL_MIN + Math.floor(rng() * (FARM_LVL_MAX - FARM_LVL_MIN + 1));
      const stats = monsterStatsAtLevel(lvl, d.eType);
      let ex = room.cx * TILE + TILE / 2, ey = room.cy * TILE + TILE / 2;
      for (let attempt = 0; attempt < 40; attempt++) {
        const gx = room.x + 1 + Math.floor(rng() * Math.max(1, room.size - 2));
        const gy = room.y + 1 + Math.floor(rng() * Math.max(1, room.size - 2));
        if (inBounds(gx, gy) && grid[gy][gx] === FLOOR) { ex = gx * TILE + TILE / 2; ey = gy * TILE + TILE / 2; break; }
      }
      // Named/colored the same way arm 2's own rooms would at this level
      // (localLvl relative to ARM_OFFSETS[1]) so a level-27 zombie here looks
      // exactly like a level-27 zombie anywhere else in the open world.
      const localLvl = lvl - ARM_OFFSETS[1];
      enemyList.push({
        id: `farm_${ri}_${eid++}`, ...d, isBoss: false, arm: 'farmZone', farmZone: true,
        rlvl: lvl,
        name: monsterNameAtLevel(d.name, localLvl, false, d.fem, maxLocalLvl),
        color: monsterColorAtLevel(d.color, d.endColor, localLvl, false, maxLocalLvl),
        maxHp: Math.floor(stats.hp * FARM_WEAK_MULT), hp: Math.floor(stats.hp * FARM_WEAK_MULT),
        atk: Math.floor(stats.atk * FARM_WEAK_MULT), def: stats.def, spd: d.spd,
        xp: xpAtLevel(lvl) * FARM_XP_MULT, gold: goldAtLevel(lvl),
        x: ex, y: ey, spawnX: ex, spawnY: ey,
        atkTimer: 1 + rng(),
        // Never self-pulls (Room.js's tick loop exempts farmZone from the
        // aggroR-triggered self-aggro check explicitly) — attackEnemy/
        // skillAttackEnemy still unconditionally set aggro:true on any hit,
        // so it fights back once attacked. aggroR itself stays a normal
        // value: it's what the tick loop's de-aggro leash (aggroR * 2.2)
        // uses to decide when a retaliating monster gives up and walks back
        // to spawn — aggroR:0 collapsed that leash to 0 too and reset aggro
        // right back to false the tick after it was set, so nothing ever
        // visibly retaliated.
        aggro: false, aggroR: 175 + rng() * 55,
      });
    }
  });

  // Sits 2 tiles into the corridor from the north edge — offset from the
  // entry spawn (dead centre of the plus) so arriving and leaving don't
  // trigger each other, same as every other zone's own entrance/return pair.
  const returnPad = { x: midX * TILE + TILE / 2, y: (Y0 + 2) * TILE + TILE / 2 };

  // ── пад в сезонное крыло ─────────────────────────────────────────────────
  // Противоположный конец того же вертикального коридора: возврат в хаб на
  // севере, сезонное крыло на юге. Дальше друг от друга их на этой карте не
  // поставить, а стоять они должны врозь — иначе один шаг попадал бы в оба.
  //
  // Пад — это ЕДИНСТВЕННАЯ дверь в крыло, и разделяет он именно комнаты:
  // пройти туда ногами нельзя, крыло лежит на своём этаже. Гейт при этом не
  // здесь: клиент рисует замок по seasonPad.requiresTicket, а пускает или
  // отказывает сервер (resolveFloor/TICKET_ONLY, server/world.js). Клиентская
  // проверка тут была бы охраной платной зоны силами клиента.
  const seasonPad = {
    x: midX * TILE + TILE / 2, y: (Y0 + FARM_SIZE - 3) * TILE + TILE / 2,
    req: FARM_ENTRY_LEVEL, requiresTicket: true,
  };

  return {
    grid, rooms, w, h,
    spawn: { x: midX * TILE + TILE / 2, y: midY * TILE + TILE / 2 },
    returnPad, seasonPad,
    farmZone: { bounds: { x0: 0, y0: 0, x1: w, y1: h }, minLevel: FARM_ENTRY_LEVEL },
    enemies: enemyList,
  };
}

// Сезонное крыло Фарм-зоны — ещё четыре комнаты, вход только с сезонным
// билетом. Это ОТДЕЛЬНЫЙ этаж, а не половина карты первой зоны, и причина
// одна: барьеры внутри этажа в этой игре клиентские (см. _isGateBlocked,
// js/game.js — по нему и работают уровневые ворота коридоров), а крыло
// оплачено за GRAM. Переход между этажами сервер проверяет сам и по-другому
// в него не попасть, поэтому дверь сюда — пад, а не стена.
//
// Внутри — точная копия первой зоны: та же геометрия 2x2, те же виды, та же
// полоса 21-30, то же половинение статов и та же таблица дропа. Монстры
// помечены `farmZone: true` НАМЕРЕННО, а не по недосмотру: по этой метке
// сервер выбирает таблицу дропа, ставку Liberty и отказ в GRAM (см. rollLoot
// и соседей, server/handlers2/world.js). Крыло — это те же комнаты, просто их
// больше, и своей ветки в выплате у него быть не должно.
function generateFarmSeason() {
  const rng = seededRng(2026 * 1337 + 777 + 602); // сосед seed'ов первой зоны (600) и Фарм зоны 2 (601)
  const w = FARM_SIZE + MARGIN * 2, h = FARM_SIZE + MARGIN * 2;
  const grid = Array.from({ length: h }, () => new Array(w).fill(WALL));
  function inBounds(gx, gy) { return gx >= 0 && gx < w && gy >= 0 && gy < h; }
  function paintFloor(gx, gy) { if (inBounds(gx, gy)) grid[gy][gx] = FLOOR; }
  function paintRect(x0, y0, x1, y1) {
    for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) paintFloor(gx, gy);
  }

  const X0 = MARGIN, Y0 = MARGIN;
  const roomCoords = [
    { x: X0, y: Y0 },
    { x: X0 + FARM_ROOM + FARM_GAP, y: Y0 },
    { x: X0, y: Y0 + FARM_ROOM + FARM_GAP },
    { x: X0 + FARM_ROOM + FARM_GAP, y: Y0 + FARM_ROOM + FARM_GAP },
  ];
  const rooms = roomCoords.map(({ x, y }) => {
    const room = {
      x, y, size: FARM_ROOM,
      bx1: x - 1, by1: y - 1, bx2: x + FARM_ROOM + 1, by2: y + FARM_ROOM + 1,
      cx: x + Math.floor(FARM_ROOM / 2), cy: y + Math.floor(FARM_ROOM / 2),
      isFarmZone: true, monsterLvl: Math.round((FARM_LVL_MIN + FARM_LVL_MAX) / 2), arm: 'farmZone',
    };
    paintRect(x, y, x + FARM_ROOM - 1, y + FARM_ROOM - 1);
    return room;
  });
  const midX = X0 + Math.floor(FARM_SIZE / 2);
  paintRect(X0, rooms[0].cy - CW, X0 + FARM_SIZE - 1, rooms[0].cy + CW);
  paintRect(X0, rooms[2].cy - CW, X0 + FARM_SIZE - 1, rooms[2].cy + CW);
  paintRect(midX - CW, Y0, midX + CW, Y0 + FARM_SIZE - 1);
  const midY = Y0 + Math.floor(FARM_SIZE / 2);

  const FARM_WEAK_MULT = 0.5;
  const maxLocalLvl = roomsInArm(2) - 1; // шкала рукава 2 — та же полоса, те же виды
  const enemyList = [];
  let eid = 0;
  rooms.forEach((room, ri) => {
    for (let n = 0; n < FARM_MOBS_PER_ROOM; n++) {
      const d = _enemyByEid.get(FARM_SPECIES[Math.floor(rng() * FARM_SPECIES.length)]);
      if (!d) continue;
      const lvl = FARM_LVL_MIN + Math.floor(rng() * (FARM_LVL_MAX - FARM_LVL_MIN + 1));
      const stats = monsterStatsAtLevel(lvl, d.eType);
      let ex = room.cx * TILE + TILE / 2, ey = room.cy * TILE + TILE / 2;
      for (let attempt = 0; attempt < 40; attempt++) {
        const gx = room.x + 1 + Math.floor(rng() * Math.max(1, room.size - 2));
        const gy = room.y + 1 + Math.floor(rng() * Math.max(1, room.size - 2));
        if (inBounds(gx, gy) && grid[gy][gx] === FLOOR) { ex = gx * TILE + TILE / 2; ey = gy * TILE + TILE / 2; break; }
      }
      const localLvl = lvl - ARM_OFFSETS[1];
      enemyList.push({
        // Префикс свой, чтобы id не столкнулись с id первой зоны: этажи разные,
        // но журналы и античит смотрят на id, а не на этаж.
        id: `farmsz_${ri}_${eid++}`, ...d, isBoss: false, arm: 'farmZone', farmZone: true,
        rlvl: lvl,
        name: monsterNameAtLevel(d.name, localLvl, false, d.fem, maxLocalLvl),
        color: monsterColorAtLevel(d.color, d.endColor, localLvl, false, maxLocalLvl),
        maxHp: Math.floor(stats.hp * FARM_WEAK_MULT), hp: Math.floor(stats.hp * FARM_WEAK_MULT),
        atk: Math.floor(stats.atk * FARM_WEAK_MULT), def: stats.def, spd: d.spd,
        xp: xpAtLevel(lvl) * FARM_XP_MULT, gold: goldAtLevel(lvl),
        x: ex, y: ey, spawnX: ex, spawnY: ey,
        atkTimer: 1 + rng(),
        aggro: false, aggroR: 175 + rng() * 55,
      });
    }
  });

  return {
    grid, rooms, w, h,
    spawn: { x: midX * TILE + TILE / 2, y: midY * TILE + TILE / 2 },
    // Возврат ведёт НАЗАД В ЗОНУ, а не в хаб: сюда пришли из неё, и высадка в
    // центральном зале означала бы идти весь путь заново ради одного шага. Это
    // единственный returnPad в игре со своей целью — у остальных её нет, и
    // клиент читает 'hub' по умолчанию (см. _returnPads, js/game.js).
    returnPad: { x: midX * TILE + TILE / 2, y: (Y0 + 2) * TILE + TILE / 2, target: 'farmZone' },
    // Те же границы под тем же именем — по ним клиент красит плитку палитрой
    // фарм-зоны и подписывает место на карте. `seasonWing` отличает крыло от
    // первой зоны там, где подпись должна это сказать.
    farmZone: { bounds: { x0: 0, y0: 0, x1: w, y1: h }, minLevel: FARM_ENTRY_LEVEL, seasonWing: true },
    enemies: enemyList,
  };
}

// Фарм зона 2 (см. блок FARM_HIGH_* в shared/definitions.js — там же разбор,
// почему префикс не FARM2_: то имя занято Элитной фарм-зоной). Копия
// generateFarmZone выше — те же четыре квадратные комнаты 2x2, соединённые
// коридором-плюсом, та же половинная сила монстров, тот же возвратный пад, —
// с тремя отличиями: полоса 40-53 вместо 21-30, виды рукава 3 вместо рукава
// 2 и своя таблица дропа (_rollFarmHighLoot, server/game/loot.js). Вход, как
// и у первой зоны, проверяется на сервере (resolveFloor/ZONE_LEVEL_REQ,
// server/world.js), а не только клиентом.
function generateFarmHigh() {
  const rng = seededRng(2026 * 1337 + 777 + 601); // сосед seed'а первой зоны (600) — другая раскладка при той же геометрии
  const w = FARM_SIZE + MARGIN * 2, h = FARM_SIZE + MARGIN * 2;
  const grid = Array.from({ length: h }, () => new Array(w).fill(WALL));
  function inBounds(gx, gy) { return gx >= 0 && gx < w && gy >= 0 && gy < h; }
  function paintFloor(gx, gy) { if (inBounds(gx, gy)) grid[gy][gx] = FLOOR; }
  function paintRect(x0, y0, x1, y1) {
    for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) paintFloor(gx, gy);
  }

  const X0 = MARGIN, Y0 = MARGIN;
  const roomCoords = [
    { x: X0, y: Y0 },                                     // top-left
    { x: X0 + FARM_ROOM + FARM_GAP, y: Y0 },              // top-right
    { x: X0, y: Y0 + FARM_ROOM + FARM_GAP },              // bottom-left
    { x: X0 + FARM_ROOM + FARM_GAP, y: Y0 + FARM_ROOM + FARM_GAP }, // bottom-right
  ];
  const rooms = roomCoords.map(({ x, y }) => {
    const room = {
      x, y, size: FARM_ROOM,
      bx1: x - 1, by1: y - 1, bx2: x + FARM_ROOM + 1, by2: y + FARM_ROOM + 1,
      cx: x + Math.floor(FARM_ROOM / 2), cy: y + Math.floor(FARM_ROOM / 2),
      isFarmHigh: true, monsterLvl: Math.round((FARM_HIGH_LVL_MIN + FARM_HIGH_LVL_MAX) / 2), arm: 'farmHigh',
    };
    paintRect(x, y, x + FARM_ROOM - 1, y + FARM_ROOM - 1);
    return room;
  });
  const midX = X0 + Math.floor(FARM_SIZE / 2);
  paintRect(X0, rooms[0].cy - CW, X0 + FARM_SIZE - 1, rooms[0].cy + CW);
  paintRect(X0, rooms[2].cy - CW, X0 + FARM_SIZE - 1, rooms[2].cy + CW);
  paintRect(midX - CW, Y0, midX + CW, Y0 + FARM_SIZE - 1);
  const midY = Y0 + Math.floor(FARM_SIZE / 2);

  const FARM_WEAK_MULT = 0.5; // то же половинение, что и в первой зоне
  // ── ранг и цвет считаются по полосе САМОЙ ЗОНЫ ────────────────────────────
  // «Слабый» … «Запредельный» — это положение монстра на шкале. Первая
  // Фарм-зона берёт шкалой рукав (её 21-30 целиком лежат внутри рукава 2), и
  // это там верно. Полоса 40-53 так не ложится: по рукавной шкале уровень 40
  // — это местный 20 рукава 2 при потолке 19, то есть «Запредельный», а
  // следующий за ним 41 — местный 1 рукава 3, то есть «Слабый». Подъём
  // рушился бы ровно посреди зоны, и цвет вместе с ним.
  //
  // Шкала зоны такой границы не знает: 40 — низ, 53 — верх, между ними ровный
  // подъём, и ранг означает «насколько он силён ДЛЯ ЭТОЙ ЗОНЫ».
  const maxLocalLvl = FARM_HIGH_LVL_MAX - FARM_HIGH_LVL_MIN + 1;
  const enemyList = [];
  let eid = 0;
  rooms.forEach((room, ri) => {
    for (let n = 0; n < FARM_HIGH_MOBS_PER_ROOM; n++) {
      const d = _enemyByEid.get(FARM_HIGH_SPECIES[Math.floor(rng() * FARM_HIGH_SPECIES.length)]);
      if (!d) continue;
      const lvl = FARM_HIGH_LVL_MIN + Math.floor(rng() * (FARM_HIGH_LVL_MAX - FARM_HIGH_LVL_MIN + 1));
      const stats = monsterStatsAtLevel(lvl, d.eType);
      let ex = room.cx * TILE + TILE / 2, ey = room.cy * TILE + TILE / 2;
      for (let attempt = 0; attempt < 40; attempt++) {
        const gx = room.x + 1 + Math.floor(rng() * Math.max(1, room.size - 2));
        const gy = room.y + 1 + Math.floor(rng() * Math.max(1, room.size - 2));
        if (inBounds(gx, gy) && grid[gy][gx] === FLOOR) { ex = gx * TILE + TILE / 2; ey = gy * TILE + TILE / 2; break; }
      }
      const localLvl = lvl - FARM_HIGH_LVL_MIN + 1;
      enemyList.push({
        id: `farmhi_${ri}_${eid++}`, ...d, isBoss: false, arm: 'farmHigh', farmHigh: true,
        rlvl: lvl,
        name: monsterNameAtLevel(d.name, localLvl, false, d.fem, maxLocalLvl),
        color: monsterColorAtLevel(d.color, d.endColor, localLvl, false, maxLocalLvl),
        maxHp: Math.floor(stats.hp * FARM_WEAK_MULT), hp: Math.floor(stats.hp * FARM_WEAK_MULT),
        atk: Math.floor(stats.atk * FARM_WEAK_MULT), def: stats.def, spd: d.spd,
        xp: xpAtLevel(lvl) * FARM_HIGH_XP_MULT, gold: goldAtLevel(lvl),
        x: ex, y: ey, spawnX: ex, spawnY: ey,
        atkTimer: 1 + rng(),
        // Сами не бросаются — ровно как в первой Фарм-зоне (Room.js исключает
        // farmHigh из проверки самоагра наравне с farmZone/farmZone2), но
        // отвечают на удар и держат обычный aggroR как поводок отхода.
        aggro: false, aggroR: 175 + rng() * 55,
      });
    }
  });

  const returnPad = { x: midX * TILE + TILE / 2, y: (Y0 + 2) * TILE + TILE / 2 };

  return {
    grid, rooms, w, h,
    spawn: { x: midX * TILE + TILE / 2, y: midY * TILE + TILE / 2 },
    returnPad,
    farmHigh: { bounds: { x0: 0, y0: 0, x1: w, y1: h }, minLevel: FARM_HIGH_ENTRY_LEVEL },
    enemies: enemyList,
  };
}

// Элитная фарм-зона (Elite Farm Zone 2), its own floor (see
// server/game/floors.js) — a private instance built fresh per party run
// (server/index.js's _createFarm2Room, called from the farm2GroupStart
// handler), not a shared always-on floor. Players land in a dead-straight,
// always-empty entrance corridor (no monster is ever placed outside a
// room's own rectangle, so this stretch — and the fork below — is
// guaranteed clear); it runs east from the entrance and forks at one point
// into two short branches, one north to room A and one south to room B,
// each identical. Every monster is baked in at world-gen exactly like the
// original Фарм-зона's own generator, standing in FARM2_PACK_SIZE clusters
// (packMateIds below) rather than scattered individually — passive like the
// original zone's own monsters (never self-pulls on proximity, see Room.js's
// tick-loop comment), but a hit on any one member wakes the whole pack
// (Room.js's _wakePack) — and running full (non-halved) monsterStatsAtLevel()
// stats, scaled by FARM2_STAT_MULT, at FARM2_SPD_MULT move speed.
function generateFarmZone2() {
  const rng = seededRng(2026 * 1337 + 777 + 900);
  const roomSize = FARM2_ROOM;
  const halfRoom = Math.floor(roomSize / 2);
  // Fork column (x) and the entrance corridor's own row (y) — leaves
  // headroom above fixedCoord for room A + its branch stub, the corridor's
  // own half-width, then the same again below for room B.
  const alongCenter = MARGIN + LEAD_IN;
  const fixedCoord = MARGIN + roomSize + STUB + CW;

  const w = alongCenter + halfRoom + MARGIN;
  const h = fixedCoord + CW + STUB + roomSize + MARGIN;
  const grid = Array.from({ length: h }, () => new Array(w).fill(WALL));
  function inBounds(gx, gy) { return gx >= 0 && gx < w && gy >= 0 && gy < h; }
  function paintFloor(gx, gy) { if (inBounds(gx, gy)) grid[gy][gx] = FLOOR; }
  function paintRect(x0, y0, x1, y1) {
    for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) paintFloor(gx, gy);
  }

  // Entrance corridor: dead straight, always empty, from the west edge to
  // the fork column.
  paintRect(MARGIN, fixedCoord - CW, alongCenter, fixedCoord + CW);

  // side: -1 = north (above the corridor), +1 = south (below) — same
  // branch-off-the-main-corridor shape buildRoomChain uses (generateArm,
  // above), just one room per side instead of a chain.
  function buildRoom(side) {
    const cursor = side < 0 ? (fixedCoord - CW) : (fixedCoord + CW);
    const x = alongCenter - halfRoom;
    const y = side < 0 ? (cursor - STUB - roomSize) : (cursor + STUB);
    const branchX0 = alongCenter - BW, branchX1 = alongCenter + BW;
    const branchY0 = side < 0 ? (y + roomSize) : cursor;
    const branchY1 = side < 0 ? (cursor - 1) : (y - 1);
    paintRect(x, y, x + roomSize - 1, y + roomSize - 1);
    paintRect(branchX0, branchY0, branchX1, branchY1);
    const cx = x + halfRoom, cy = y + halfRoom;
    return {
      x, y, size: roomSize,
      bx1: x - 1, by1: y - 1, bx2: x + roomSize + 1, by2: y + roomSize + 1,
      cx, cy,
      // Representative midpoint for the HUD's single-number room label —
      // every monster's own level still varies (FARM2_LVL_MIN-FARM2_LVL_MAX),
      // same convention as the original farm zone's own rooms.
      isFarmZone2: true, monsterLvl: Math.round((FARM2_LVL_MIN + FARM2_LVL_MAX) / 2), arm: 'farmZone2',
    };
  }
  const rooms = [buildRoom(-1), buildRoom(1)];

  const maxLocalLvl = roomsInArm(2) - 1; // arm 2's own rank scale (19) — same species/level band
  const enemyList = [];
  let eid = 0;
  // Pack cluster centers sit on an evenly-spaced GRID_N×GRID_N grid instead
  // of being retried into position — random placement plus a minimum-
  // distance retry can still leave two packs' clusters close enough to blend
  // into one visual blob (and to make a hit on one look, from position
  // alone, like it woke its neighbour too), especially once most of a
  // room's slots are already taken. A grid guarantees every pack's center is
  // evenly clear of every other one; which of the grid's slots gets used
  // (and in what order) is still shuffled per room, so the layout doesn't
  // read as a rigid checkerboard.
  const packsPerRoom = Math.ceil(FARM2_MOBS_PER_ROOM / FARM2_PACK_SIZE);
  const gridN = Math.ceil(Math.sqrt(packsPerRoom));
  rooms.forEach((room, ri) => {
    const usable = room.size - 4; // inset from the room's own walls
    const pitch = usable / gridN;
    const slots = [];
    for (let gx = 0; gx < gridN; gx++) for (let gy = 0; gy < gridN; gy++) slots.push({ gx, gy });
    for (let i = slots.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [slots[i], slots[j]] = [slots[j], slots[i]];
    }

    let placed = 0, slotIdx = 0;
    while (placed < FARM2_MOBS_PER_ROOM) {
      const packSize = Math.min(FARM2_PACK_SIZE, FARM2_MOBS_PER_ROOM - placed);
      const slot = slots[slotIdx++];
      let ccx = room.x + 2 + Math.round(pitch * (slot.gx + 0.5));
      let ccy = room.y + 2 + Math.round(pitch * (slot.gy + 0.5));
      if (!inBounds(ccx, ccy) || grid[ccy][ccx] !== FLOOR) { ccx = room.cx; ccy = room.cy; }
      const pack = [];
      for (let m = 0; m < packSize; m++) {
        const d = _enemyByEid.get(FARM2_SPECIES[Math.floor(rng() * FARM2_SPECIES.length)]);
        if (!d) continue;
        const lvl = FARM2_LVL_MIN + Math.floor(rng() * (FARM2_LVL_MAX - FARM2_LVL_MIN + 1));
        // NOT halved (see FARM2_STAT_MULT's own comment, shared/definitions.js)
        // — full monsterStatsAtLevel(), then scaled by FARM2_STAT_MULT.
        const stats = monsterStatsAtLevel(lvl, d.eType);
        let ex = ccx * TILE + TILE / 2, ey = ccy * TILE + TILE / 2;
        for (let attempt = 0; attempt < 20; attempt++) {
          const gx = ccx + Math.floor(rng() * 3) - 1, gy = ccy + Math.floor(rng() * 3) - 1;
          if (inBounds(gx, gy) && grid[gy][gx] === FLOOR) { ex = gx * TILE + TILE / 2; ey = gy * TILE + TILE / 2; break; }
        }
        const localLvl = lvl - ARM_OFFSETS[1];
        const hp = Math.max(1, Math.round(stats.hp * FARM2_STAT_MULT));
        const atk = Math.max(1, Math.round(stats.atk * FARM2_STAT_MULT));
        const enemy = {
          id: `farm2_${ri}_${eid++}`, ...d, isBoss: false, arm: 'farmZone2', farmZone2: true,
          rlvl: lvl,
          name: monsterNameAtLevel(d.name, localLvl, false, d.fem, maxLocalLvl),
          color: monsterColorAtLevel(d.color, d.endColor, localLvl, false, maxLocalLvl),
          maxHp: hp, hp,
          atk, def: stats.def, spd: d.spd * FARM2_SPD_MULT,
          xp: FARM2_XP_PER_KILL, gold: goldAtLevel(lvl),
          x: ex, y: ey, spawnX: ex, spawnY: ey,
          // Passive: standard aggroR (still the de-aggro leash distance —
          // see Room.js's own tick-loop comment), never self-pulled. Room.js
          // excludes farmZone2 from that proximity trigger entirely; waking
          // up only ever happens via a hit — this enemy's own, or a pack
          // mate's (packMateIds, wired below once the whole pack exists).
          atkTimer: 1 + rng(), aggro: false, aggroR: 175 + rng() * 55,
        };
        enemyList.push(enemy);
        pack.push(enemy);
      }
      pack.forEach(e => { e.packMateIds = pack.filter(o => o !== e).map(o => o.id); });
      placed += packSize;
    }
  });

  // Sits in the entrance corridor, well clear of the fork (let alone either
  // room) — same entrance/return-pad pattern every other zone uses.
  const corridorYPx = fixedCoord * TILE + TILE / 2;
  const returnPad = { x: (MARGIN + 2) * TILE + TILE / 2, y: corridorYPx };
  const spawn = { x: (MARGIN + 4) * TILE + TILE / 2, y: corridorYPx };

  return {
    grid, rooms, w, h,
    spawn,
    returnPad,
    farmZone2: { bounds: { x0: 0, y0: 0, x1: w, y1: h }, minLevel: FARM2_ENTRY_LEVEL, partySize: FARM2_PARTY_SIZE },
    enemies: enemyList,
  };
}

// Boss arena, now its own floor (see server/game/floors.js) instead of a
// square room off to the right of the hub. Doubles as the Death Battle
// (Битва на смерть) venue — same zone, same sealed-off rules, just placed
// via Room.deathBattleDeploy's ring layout instead of a walk-in pad. Players
// arrive at the middle of the west wall; the way out sits in the north-west
// corner, well clear of both the arrival spot and the boss/ring in the
// centre so nobody teleports out by accident mid-fight.
function generateArena() {
  const w = ARENA + MARGIN * 2, h = ARENA + MARGIN * 2;
  const grid = Array.from({ length: h }, () => new Array(w).fill(WALL));
  function inBounds(gx, gy) { return gx >= 0 && gx < w && gy >= 0 && gy < h; }
  function paintFloor(gx, gy) { if (inBounds(gx, gy)) grid[gy][gx] = FLOOR; }
  function paintRect(x0, y0, x1, y1) {
    for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) paintFloor(gx, gy);
  }

  const ar = {
    x: MARGIN, y: MARGIN, size: ARENA,
    cx: MARGIN + Math.floor(ARENA / 2), cy: MARGIN + Math.floor(ARENA / 2),
    isArena: true,
  };
  paintRect(ar.x, ar.y, ar.x + ar.size - 1, ar.y + ar.size - 1);

  const spawn = { x: (MARGIN + 6) * TILE + TILE / 2, y: ar.cy * TILE + TILE / 2 };
  const returnPad = { x: (MARGIN + 3) * TILE + TILE / 2, y: (MARGIN + 3) * TILE + TILE / 2 };

  return {
    grid, rooms: [ar], w, h,
    spawn,
    returnPad,
    arena: { cx: ar.cx * TILE + TILE / 2, cy: ar.cy * TILE + TILE / 2 },
    enemies: [],
  };
}

// 3v3 PvP arena, now its own floor (see server/game/floors.js) instead of a
// rectangle painted into the hub's mega-grid. Two team bases at either end
// joined by a single central lane; teamA/teamB are per-player spawn points
// set back inside each base so a match never starts with the two teams
// already in contact.
function generatePvpArena() {
  const w = A3_W + MARGIN * 2, h = A3_H + MARGIN * 2;
  const grid = Array.from({ length: h }, () => new Array(w).fill(WALL));
  function inBounds(gx, gy) { return gx >= 0 && gx < w && gy >= 0 && gy < h; }
  function paintFloor(gx, gy) { if (inBounds(gx, gy)) grid[gy][gx] = FLOOR; }
  function paintRect(x0, y0, x1, y1) {
    for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) paintFloor(gx, gy);
  }

  const X0 = MARGIN, Y0 = MARGIN;
  const a3 = {
    x: X0, y: Y0, size: A3_W,
    cx: X0 + Math.floor(A3_W / 2), cy: Y0 + Math.floor(A3_H / 2),
    isPvpArena: true,
  };
  paintRect(X0, Y0, X0 + A3_BASE_W - 1, Y0 + A3_H - 1);                       // left base
  paintRect(X0 + A3_W - A3_BASE_W, Y0, X0 + A3_W - 1, Y0 + A3_H - 1);         // right base
  A3_LANE_YS.forEach(dy => {
    const cy = Y0 + dy;
    paintRect(X0 + A3_BASE_W, cy - A3_LANE_HW, X0 + A3_W - A3_BASE_W - 1, cy + A3_LANE_HW);
  });

  return {
    grid, rooms: [a3], w, h,
    spawn: { x: a3.cx * TILE + TILE / 2, y: a3.cy * TILE + TILE / 2 },
    pvpArena: {
      cx: a3.cx * TILE + TILE / 2, cy: a3.cy * TILE + TILE / 2,
      teamA: A3_SPAWN_YS.map(dy => ({
        x: (X0 + 4) * TILE + TILE / 2, y: (Y0 + dy) * TILE + TILE / 2,
      })),
      teamB: A3_SPAWN_YS.map(dy => ({
        x: (X0 + A3_W - 5) * TILE + TILE / 2, y: (Y0 + dy) * TILE + TILE / 2,
      })),
    },
    enemies: [],
  };
}

// Кровавая Башня (the 10-player corridor race), now its own floor (see
// server/game/floors.js) instead of a slice of the hub's mega-grid. Ten
// parallel sealed lanes, each running the full RACE10_LANE_LEN before
// opening into one shared boss room spanning every lane's row — everyone who
// registered gets their own lane (Room.raceDeploy), isolated from every
// other lane the same way Fear's private halls are (see _raceVisible,
// Room.js), just now on this floor instead of inside the hub's Room.
// `bounds` covers the whole grid (there's nothing else on this floor to
// distinguish it from), same reasoning generateGuildWar's own bounds field
// has, so the client's "Кровавая Башня" tile tinting (_isRace10Tile,
// js/game.js) still applies to the whole thing.
function generateRace10() {
  const rng = seededRng(2026 * 1337 + 777 + 800);
  const w = RACE10_W + MARGIN * 2, h = RACE10_H + MARGIN * 2;
  const grid = Array.from({ length: h }, () => new Array(w).fill(WALL));
  function inBounds(gx, gy) { return gx >= 0 && gx < w && gy >= 0 && gy < h; }
  function paintFloor(gx, gy) { if (inBounds(gx, gy)) grid[gy][gx] = FLOOR; }
  function paintRect(x0, y0, x1, y1) {
    for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) paintFloor(gx, gy);
  }

  const X0 = MARGIN, Y0 = MARGIN;
  const laneRows = [];
  for (let i = 0; i < RACE10_LANES; i++) {
    const cy = Y0 + i * RACE10_LANE_PITCH + RACE10_LANE_HW;
    laneRows.push(cy);
    paintRect(X0, cy - RACE10_LANE_HW, X0 + RACE10_LANE_LEN - 1, cy + RACE10_LANE_HW);
  }
  const bossRoomX0 = X0 + RACE10_LANE_LEN;
  paintRect(bossRoomX0, Y0, bossRoomX0 + RACE10_BOSS_ROOM - 1, Y0 + RACE10_H - 1);
  const bossCx = bossRoomX0 + Math.floor(RACE10_BOSS_ROOM / 2);
  const bossCy = Y0 + Math.floor(RACE10_H / 2);

  const enemyList = [];
  let eid = 0;

  // Exact pixel spacing (RACE10_MOB_SPACING), not the random-within-a-room
  // placement buildArm's rooms use: "впритык" means the gap itself has to be
  // exact. Arm 1's species rotation (rat/slime/imp) covers both tiers
  // (level 5 and level 10) comfortably.
  const fe = FLOOR_ENEMIES[1];
  function pickEnemy(lvl) {
    const pool = bandForLocalLevel(fe, lvl).pool;
    return _enemyByEid.get(pool[Math.floor(rng() * pool.length)]);
  }
  function spawnTier(laneIdx, laneRow, tierIdx, lvl) {
    const baseX = (X0 + RACE10_LEAD_IN + tierIdx * (RACE10_TIER_LEN + RACE10_TIER_GAP)) * TILE;
    const ey = laneRow * TILE + TILE / 2;
    for (let i = 0; i < RACE10_MOB_PER_TIER; i++) {
      const d = pickEnemy(lvl);
      if (!d) continue;
      const stats = monsterStatsAtLevel(lvl, d.eType);
      const ex = baseX + i * RACE10_MOB_SPACING + TILE / 2;
      // Same halving buildArm's spawnRoomEnemies applies to every regular
      // room monster ("regular monsters spawn in packs — halved
      // individually") — race10's lines are packed even tighter (60 per
      // tier, RACE10_MOB_SPACING=30px apart, vs. 5-10 spread across a whole
      // room), so full monsterStatsAtLevel() here hit far harder than
      // anywhere else a player meets a level 5 or 10 monster.
      const weakMult = 0.5;
      enemyList.push({
        id: `race10_${laneIdx}_${eid++}`, ...d, isBoss: false, arm: 'race10',
        // Which lane this monster belongs to. The id has carried it all along
        // (the client slices it out to match barriers), but the server needs it
        // as a field: it is what keeps a monster from ever seeing — or being
        // seen by — a player running a different corridor. Lanes are 5 tiles
        // apart and aggro reaches up to 230px, so without it every monster
        // within two rows was fair game across a solid wall.
        lane: laneIdx,
        rlvl: lvl,
        name: monsterNameAtLevel(d.name, lvl, false, d.fem, 20),
        color: monsterColorAtLevel(d.color, d.endColor, lvl, false, 20),
        maxHp: Math.floor(stats.hp * weakMult), hp: Math.floor(stats.hp * weakMult),
        atk: Math.floor(stats.atk * weakMult), def: stats.def, spd: d.spd,
        xp: xpAtLevel(lvl) * RACE10_XP_MULT, gold: goldAtLevel(lvl),
        x: ex, y: ey, spawnX: ex, spawnY: ey,
        atkTimer: 1 + rng(), aggro: false, aggroR: 175 + rng() * 55,
      });
    }
  }
  laneRows.forEach((laneRow, laneIdx) => {
    spawnTier(laneIdx, laneRow, 0, 5);
    spawnTier(laneIdx, laneRow, 1, 10);
  });

  return {
    grid, rooms: [], w, h,
    spawn: { x: bossCx * TILE + TILE / 2, y: bossCy * TILE + TILE / 2 },
    // One spawn point per lane (index = lane number) and the single shared
    // boss's spot at the end of every lane.
    race10: {
      lanes: laneRows.map(cy => ({
        x: (X0 + 2) * TILE + TILE / 2, y: cy * TILE + TILE / 2,
      })),
      boss: { x: bossCx * TILE + TILE / 2, y: bossCy * TILE + TILE / 2 },
      bounds: { x0: 0, y0: 0, x1: w, y1: h },
      // Where the shared boss room starts (px, world x) — every lane's
      // corridor ends before this and the one shared room spans everything
      // past it. Room.js uses this to tell "still in my own sealed corridor"
      // apart from "reached the shared room", the same distinction the boss
      // itself already gets (see spawnRaceBoss's `lane`-less enemy).
      bossRoomX0: bossRoomX0 * TILE,
      // One barrier pair per lane: tier 0 blocks until every level-5 monster
      // in that lane is dead, tier 1 until every level-10 one is. lane/tier
      // let the client match a barrier to the right slice of serverEnemies
      // (ids are `race10_<lane>_<n>`, rlvl is 5 or 10 — see spawnTier above).
      barriers: laneRows.flatMap((cy, lane) => [
        { x: (X0 + RACE10_BARRIER1_X) * TILE + TILE / 2, y: cy * TILE + TILE / 2, lane, tier: 0 },
        { x: (X0 + RACE10_BARRIER2_X) * TILE + TILE / 2, y: cy * TILE + TILE / 2, lane, tier: 1 },
      ]),
    },
    enemies: enemyList,
  };
}

// Страх (Fear), now its own floor (see server/game/floors.js) instead of a
// stack of sealed rooms in the hub's mega-grid. Called fresh for every
// fearEnter (see _createFearRoom, server/index.js) rather than once at boot,
// so every entrant gets a newly generated, single-lane room of their own —
// unlike race10's corridors these hold no baked-in monsters at all: each
// wave is spawned dynamically at runtime by Room.fearSpawnWave once the
// player is deployed, so only the geometry needs to exist ahead of time.
function generateFear() {
  const w = FEAR_ROOM + MARGIN * 2, h = FEAR_LANES * FEAR_PITCH + MARGIN * 2;
  const grid = Array.from({ length: h }, () => new Array(w).fill(WALL));
  function inBounds(gx, gy) { return gx >= 0 && gx < w && gy >= 0 && gy < h; }
  function paintFloor(gx, gy) { if (inBounds(gx, gy)) grid[gy][gx] = FLOOR; }
  function paintRect(x0, y0, x1, y1) {
    for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) paintFloor(gx, gy);
  }

  const X0 = MARGIN, Y0 = MARGIN;
  const lanes = [];
  for (let i = 0; i < FEAR_LANES; i++) {
    const x0 = X0, y0 = Y0 + i * FEAR_PITCH;
    paintRect(x0, y0, x0 + FEAR_ROOM - 1, y0 + FEAR_ROOM - 1);
    lanes.push({
      x0, y0, size: FEAR_ROOM,
      entryX: (x0 + Math.floor(FEAR_ROOM / 2)) * TILE + TILE / 2,
      entryY: (y0 + Math.floor(FEAR_ROOM / 2)) * TILE + TILE / 2,
    });
  }

  return {
    grid, rooms: [], w, h,
    // Just lane 0's entry as a fallback default (Room.addPlayer needs SOME
    // valid spawn point) — every real entrant is placed precisely by
    // Room.fearDeploy right after joining, same as every other matchmade/
    // deployed zone.
    spawn: { x: lanes[0].entryX, y: lanes[0].entryY },
    // Lane geometry only — Room.js reaches into this directly
    // (this._dungeon.fear), it is deliberately NOT part of Room.dungeonData,
    // since the client needs no rendering/tinting hints for it: entry and
    // every wave transition are server-pushed teleports, not something the
    // client discovers by walking around.
    fear: { lanes },
    enemies: [],
  };
}

// ── Сотрудничество (Cooperation) ─────────────────────────────────────────────
// A 2-player-only co-op climb, its own floor (see server/game/floors.js).
// Called fresh for every pair (see _createCoopRoom, server/index.js) —
// same "one fresh private Room per run" shape Fear uses just above, just
// seating two players in their own lanes instead of one. Each lane is a
// straight line of COOP_STAGE_COUNT rooms (wider than Кровавая Башня's
// tight 3-tile corridor, so COOP_MOBS_PER_STAGE monsters can scatter across
// one instead of standing shoulder-to-shoulder), connected by short
// corridors, converging into ONE shared boss room at the far end — same
// convergence Кровавая Башня's lanes use. No baked-in monsters: each
// stage's pack is spawned dynamically at runtime by Room.coopSpawnStage,
// gated on BOTH lanes clearing the current stage (Room.coopRegisterKill),
// which a baked-in world-gen layout can't express.
const COOP_LANES      = 2;
const COOP_STAGE_ROOM = 16;  // one stage's room size (tiles)
const COOP_STAGE_GAP  = 4;   // connector corridor length between consecutive stage rooms
const COOP_LANE_HW    = 1;   // connector corridor half-width (3 tiles), same convention as every other corridor
const COOP_LANE_PITCH = COOP_STAGE_ROOM + 6; // row-to-row spacing between the 2 lanes
const COOP_STAGE_COUNT = 8;
const COOP_BOSS_ROOM  = 34;  // shared boss room, at least this big (also stretched to cover every lane's own row — see bossSize below)

function generateCoop() {
  const stageSpan = COOP_STAGE_ROOM + COOP_STAGE_GAP;
  const X0 = MARGIN, Y0 = MARGIN;
  const bossX0 = X0 + COOP_STAGE_COUNT * stageSpan;
  // Tall enough to cover every lane's own row (so each lane's connector
  // lands inside it regardless of how many lanes there are), at least
  // COOP_BOSS_ROOM square otherwise.
  const bossSize = Math.max(COOP_BOSS_ROOM, (COOP_LANES - 1) * COOP_LANE_PITCH + COOP_STAGE_ROOM);
  const w = bossX0 + bossSize + MARGIN;
  const h = Y0 + bossSize + MARGIN;

  const grid = Array.from({ length: h }, () => new Array(w).fill(WALL));
  function inBounds(gx, gy) { return gx >= 0 && gx < w && gy >= 0 && gy < h; }
  function paintFloor(gx, gy) { if (inBounds(gx, gy)) grid[gy][gx] = FLOOR; }
  function paintRect(x0, y0, x1, y1) {
    for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) paintFloor(gx, gy);
  }

  const lanes = [];
  // One barrier per lane at the exit of each stage room (into the next
  // stage's room, or — the last one — into the shared boss room): blocks
  // the connector corridor until BOTH lanes have cleared that stage
  // (Room.coopRegisterKill only advances the shared `_coopStage` counter
  // once both lanes report clear), same "physically can't walk ahead of
  // your partner" idea as Кровавая Башня's barriers, just gated on the
  // stage counter instead of a live-monster scan since Coop's sync is
  // already tracked server-side. `stage` is 1-indexed to match
  // Room.coopStage()/COOP_STAGE_LEVELS — see _isCoopBarrierBlocked,
  // js/game.js.
  const barriers = [];
  for (let i = 0; i < COOP_LANES; i++) {
    const laneY0 = Y0 + i * COOP_LANE_PITCH;
    const cy = laneY0 + Math.floor(COOP_STAGE_ROOM / 2);
    const stages = [];
    for (let k = 0; k < COOP_STAGE_COUNT; k++) {
      const sx0 = X0 + k * stageSpan;
      paintRect(sx0, laneY0, sx0 + COOP_STAGE_ROOM - 1, laneY0 + COOP_STAGE_ROOM - 1);
      // Connector out of this stage — into the next stage's room, or (the
      // last stage) straight into the shared boss room's west wall.
      const connEndX = (k === COOP_STAGE_COUNT - 1) ? (bossX0 - 1) : (sx0 + stageSpan - 1);
      paintRect(sx0 + COOP_STAGE_ROOM, cy - COOP_LANE_HW, connEndX, cy + COOP_LANE_HW);
      stages.push({
        // Tile bounds for Room.coopSpawnStage's random scatter — deliberately
        // NOT a single ring-around-a-point the way Fear/race10 spawn: "не
        // стоят в ряд ... монстры в разброс" wants them scattered across the
        // whole room, not converging from one centre.
        x0: sx0, y0: laneY0, x1: sx0 + COOP_STAGE_ROOM - 1, y1: laneY0 + COOP_STAGE_ROOM - 1,
        cx: (sx0 + Math.floor(COOP_STAGE_ROOM / 2)) * TILE + TILE / 2, cy: cy * TILE + TILE / 2,
      });
      barriers.push({
        x: (sx0 + COOP_STAGE_ROOM + COOP_STAGE_GAP / 2) * TILE + TILE / 2,
        y: cy * TILE + TILE / 2,
        lane: i, stage: k + 1,
      });
    }
    lanes.push({
      entryX: (X0 + 2) * TILE + TILE / 2, entryY: cy * TILE + TILE / 2,
      stages,
    });
  }

  paintRect(bossX0, Y0, bossX0 + bossSize - 1, Y0 + bossSize - 1);
  const bossCx = (bossX0 + Math.floor(bossSize / 2)) * TILE + TILE / 2;
  const bossCy = (Y0 + Math.floor(bossSize / 2)) * TILE + TILE / 2;

  return {
    grid, rooms: [], w, h,
    // Lane 0's entry as a fallback default (Room.addPlayer needs SOME valid
    // spawn point) — every real entrant is placed precisely by
    // Room.coopDeploy right after joining, same as Fear.
    spawn: { x: lanes[0].entryX, y: lanes[0].entryY },
    // `lanes`/`boss`/`bossRoomX0` are geometry Room.js reaches into directly
    // (this._dungeon.coop) — every stage transition is a server-pushed
    // spawn, not something the client discovers by walking around (same
    // reasoning as this._dungeon.fear). `bounds` is the one thing about this
    // floor that IS sent to the client — see Room.dungeonData — purely so it
    // can tint the whole room to look like a dark grassy dungeon instead of
    // the default biome theme (_isCoopTile, js/game.js), same as
    // race10.bounds/guildWar.bounds/farmZone.bounds.
    coop: {
      lanes,
      boss: { x: bossCx, y: bossCy },
      // Where the shared boss room starts (px, world x) — same role
      // race10.bossRoomX0 plays: tells "still in my own lane" apart from
      // "reached the shared room" (Room.js's _raceVisible-style isolation).
      bossRoomX0: bossX0 * TILE,
      bounds: { x0: 0, y0: 0, x1: w, y1: h },
      barriers,
    },
    enemies: [],
  };
}

module.exports = {
  generateHub, generateArm, generateGuildWar, generateFarmZone, generateFarmSeason, generateFarmHigh, generateFarmZone2, generateArena, generatePvpArena,
  generateRace10, generateFear, generateCoop,
  TILE, WALL, FLOOR,
};
