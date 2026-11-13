const { TILE, WALL, FLOOR, ENEMY_DEF, FLOOR_ENEMIES, bandForLocalLevel, monsterStatsAtLevel, monsterNameAtLevel, monsterColorAtLevel, xpAtLevel, goldAtLevel, ARM_NAMES, ARM_ROOM_PAIRS, ARM_OFFSETS, ARM_LEVEL_REQ, roomsInArm, FARM_LVL_MIN, FARM_LVL_MAX, FARM_MOBS_PER_ROOM, FARM_ENTRY_LEVEL, FARM_XP_MULT, FARM_SPECIES, FARM_HIGH_LVL_MIN, FARM_HIGH_LVL_MAX, FARM_HIGH_MOBS_PER_ROOM, FARM_HIGH_ENTRY_LEVEL, FARM_HIGH_XP_MULT, FARM_HIGH_SPECIES, WORLD_ENTRY_LEVEL, WORLD_LVL_MIN, WORLD_LVL_MAX, WORLD_BOSS_LEVEL, WORLD_XP_MULT, WORLD_MOB_STAT_MULT, WORLD_BOSS_HP_MULT, WORLD_W, WORLD_H, WORLD_SPAWN, WORLD_TIERS, WORLD_SPOTS, WORLD_BOSS_SPOT, WORLD_RIVER_X, WORLD_RIDGE_X, WORLD_ROADS, WORLD_T, FARM2_LVL_MIN, FARM2_LVL_MAX, FARM2_ENTRY_LEVEL, FARM2_PARTY_SIZE, FARM2_MOBS_PER_ROOM, FARM2_PACK_SIZE, FARM2_SPD_MULT, FARM2_STAT_MULT, FARM2_XP_PER_KILL, FARM2_SPECIES,
  DUNGEON_CLASSES, DUNGEON_ROOM, DUNGEON_ROOM_COUNT, DUNGEON_PACK_SIZE, DUNGEON_MOBS_PER_ROOM, DUNGEON_STUB, DUNGEON_ENTRY_LEVEL, DUNGEON_LVL, DUNGEON_LICH, DUNGEON_SPECIES } = require('../../shared/definitions');

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

// ── Турнир (32-player double elimination tournament) ────────────────────────
// One private 1v1 pit per match now (generateTournamentPit, below), same
// per-instance-Room shape Fear/coop/farmZone2 already use — see
// _createTournamentPitRoom, server/game/tournament.js. Used to be a single
// shared floor with up to 16 sealed pits laid out in a 4x4 grid (round 1: 32
// players, 16 concurrent matches), separated only by a wall gap and the
// explicit opponent check in _isPvpImmune, plus (briefly) a p._trPit lane
// key patched onto Room._playerLaneKey's AOI filter. Both were separation
// bolted onto ONE shared Room; a client still ended up seeing (and once, on
// a lane-key bug, fighting) whoever the grid happened to seat next door —
// «кидает в 3 на одной арене», «кидает в разные комнаты соперников». A
// private Room per match has no shared players/AOI/enemy state to leak
// through in the first place, so there is nothing left to separate.
// Арена турнира — круглый ринг-колизей диаметром TR_ARENA_D клеток (был
// квадрат 10×10 — тесно, бой начинался почти вплотную). Бойцы встают на
// TR_ARENA_SPAWN клеток левее и правее центра, лицом друг к другу.
// Диаметр 25 (пробовали 49 — слишком просторно). Бойцы выходят из ворот:
// каждый стоит у своих (запад/восток, где их рисует _arenaDraw,
// js/themes.js), на клетку отступив от барьера, — и идут навстречу через
// всю арену.
const TR_ARENA_D = 25;
const TR_ARENA_R = (TR_ARENA_D - 1) / 2;   // 12 — радиус в клетках
const TR_ARENA_SPAWN = TR_ARENA_R - 1;     // 11 — у самых ворот

// ── Кровавая Башня (race10) ─────────────────────────────────────────────────
// Одна локация: центральный зал и 50 комнат вокруг него, соединённых в
// лабиринт. Монстров нет. Все участники появляются в зале; в одной случайной
// комнате на каждый забег открывается портал к боссу (_race10Sweep,
// server/game/race10.js) — кто его нашёл, того переносит в запечатанную
// комнату босса справа от лабиринта. Побеждает, как и раньше, тот, кто нанёс
// боссу больше всего урона.
//
// Сетка RACE10_COLS × RACE10_ROWS клеток; средний столбец — один высокий
// зал, остальные клетки — комнаты: 11 × 5 − 5 = 50.
const RACE10_COLS       = 11;
const RACE10_ROWS       = 5;
const RACE10_CELL       = 18;  // тайлов от клетки до клетки
const RACE10_ROOM       = 13;  // сторона комнаты, тайлов
const RACE10_DOOR_HW    = 1;   // полуширина прохода — 3 тайла, как у всех коридоров
const RACE10_EXTRA_DOORS = 14; // лишние проходы поверх остова: петли вместо тупиков
// Мест появления в зале — потолок участников (raceUsableLanes, Room.js).
const RACE10_LANES      = 50;
// Радиус, в котором портал срабатывает (px).
const RACE10_PORTAL_R   = 48;
// Комната босса — запечатана, сюда попадают только порталом.
const RACE10_BOSS_ROOM  = 22;
const RACE10_BOSS_SPOTS = 10;
const RACE10_BOSS_SPOT_R = 3; // tiles from the boss the ring of arrival spots sits at
const RACE10_BOSS_GAP   = 4;  // стена между лабиринтом и комнатой босса
const RACE10_H  = RACE10_ROWS * RACE10_CELL;
const RACE10_W  = RACE10_COLS * RACE10_CELL + RACE10_BOSS_GAP + RACE10_BOSS_ROOM;

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
// Its own floor (generateGuildWar, below), built like the levelling floors:
// rooms joined by corridors, not one open square. Four corner rooms each hold
// a crystal tower (Room.spawnGuildWarTowers); a big hall sits in the centre
// with the way back to the hub; the four entry rooms sit mid-wall, each the
// same walk from the two towers either side of it, so no side of the map
// starts closer to the fight than another. The clan that holds all four
// towers for GUILD_WAR_HOLD_MS wins the castle (server/game/guildwar.js).
const GW_SIZE = 64;          // inner square, tiles
const GW_TOWER_ROOM = 15;
const GW_HALL = 18;
const GW_ENTRY_ROOM = 10;

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
    // Мир — открытая локация со спотами (generateWorld, ниже). Тот же
    // приём: один пункт списка телепорта со своим гейтом.
    worldEntry: { req: WORLD_ENTRY_LEVEL },
    // Подземелье — третий пункт того же списка, со своим гейтом. Сама зона
    // (пустой зал с 7 телепортами по классам) живёт на своём этаже
    // (generateDungeonHub, ниже), здесь только запись для пада.
    dungeonEntry: { req: DUNGEON_ENTRY_LEVEL },
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
  const N = GW_SIZE;
  const w = N + MARGIN * 2, h = N + MARGIN * 2;
  const grid = Array.from({ length: h }, () => new Array(w).fill(WALL));
  // Координаты ниже — внутри квадрата N×N; O сдвигает их на рамку стены.
  const O = MARGIN;
  function paintRect(x0, y0, x1, y1) {
    for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) {
      const X = gx + O, Y = gy + O;
      if (X >= 0 && X < w && Y >= 0 && Y < h) grid[Y][X] = FLOOR;
    }
  }
  const rooms = [];
  function room(x, y, size, kind) {
    paintRect(x, y, x + size - 1, y + size - 1);
    const r = {
      x: x + O, y: y + O, size, kind,
      bx1: x + O - 1, by1: y + O - 1, bx2: x + O + size, by2: y + O + size,
      cx: x + O + Math.floor(size / 2), cy: y + O + Math.floor(size / 2),
      isGuildWar: true,
    };
    rooms.push(r);
    return r;
  }

  // Четыре угла — вышки; центр — зал; середины сторон — входы.
  const T = GW_TOWER_ROOM, E = GW_ENTRY_ROOM, far = N - 3 - T;
  const towerRooms = [room(3, 3, T, 'tower'), room(far, 3, T, 'tower'), room(3, far, T, 'tower'), room(far, far, T, 'tower')];
  const hallAt = Math.floor((N - GW_HALL) / 2);
  const hall = room(hallAt, hallAt, GW_HALL, 'hall');
  const mid = Math.floor((N - E) / 2);
  const entryRooms = [room(mid, 3, E, 'entry'), room(mid, N - 3 - E, E, 'entry'), room(3, mid, E, 'entry'), room(N - 3 - E, mid, E, 'entry')];

  // Внешнее кольцо: вход ↔ соседние угловые комнаты (коридор шириной 3).
  const a = 3 + T, b = far - 1, ringNear = 3 + Math.floor(T / 2) - 1, ringFar = N - 3 - Math.floor(T / 2) - 2;
  for (const y of [ringNear, ringFar]) { paintRect(a, y, mid - 1, y + 2); paintRect(mid + E, y, b, y + 2); }
  for (const x of [ringNear, ringFar]) { paintRect(x, a, x + 2, mid - 1); paintRect(x, mid + E, x + 2, b); }
  // Крест: каждый вход ↔ зал.
  const c0 = Math.floor(N / 2) - 1;
  paintRect(c0, 3 + E, c0 + 1, hallAt - 1);
  paintRect(c0, hallAt + GW_HALL, c0 + 1, N - 4 - E);
  paintRect(3 + E, c0, hallAt - 1, c0 + 1);
  paintRect(hallAt + GW_HALL, c0, N - 4 - E, c0 + 1);
  // Диагонали: каждая угловая комната ↔ зал (ступенькой шириной 3).
  function diag(x0, y0, x1, y1) {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let i = 0; i <= n; i++) {
      const x = Math.round(x0 + (x1 - x0) * i / n), y = Math.round(y0 + (y1 - y0) * i / n);
      paintRect(x - 1, y - 1, x + 1, y + 1);
    }
  }
  const tIn = 3 + T - 1, tOut = far, hIn = hallAt + 1, hOut = hallAt + GW_HALL - 2;
  diag(tIn, tIn, hIn, hIn); diag(tOut, tIn, hOut, hIn); diag(tIn, tOut, hIn, hOut); diag(tOut, tOut, hOut, hOut);

  const px = r => ({ x: r.cx * TILE + TILE / 2, y: r.cy * TILE + TILE / 2 });
  const towers = towerRooms.map(px);
  const spawns = entryRooms.map(px);
  // Прямоугольники входных комнат в пикселях, с отступом в клетку от стен, —
  // Room.spawnPointFor ставит вошедшего в случайную точку одной из них.
  const entryRects = entryRooms.map(r => ({
    x0: (r.x + 1) * TILE, y0: (r.y + 1) * TILE, x1: (r.x + r.size - 1) * TILE, y1: (r.y + r.size - 1) * TILE,
  }));
  // Безопасные зоны — вся входная комната целиком, куда игрок попадает при
  // входе (Room.spawnPointFor). Внутри неё нельзя ни бить, ни получать урон
  // от игроков (Room._inSafeZone), так что появившегося не убивают у точки
  // входа. В пикселях, в той же форме, что и safeZone хаба.
  const safeZones = entryRooms.map(r => ({
    x1: r.x * TILE, y1: r.y * TILE, x2: (r.x + r.size) * TILE, y2: (r.y + r.size) * TILE,
  }));
  const hc = px(hall);
  // Портал в город — в центре зала: туда сходятся все коридоры.
  const returnPad = { x: hc.x, y: hc.y };

  return {
    grid, rooms, w, h,
    spawn: spawns[0],
    returnPad,
    guildWar: { cx: hc.x, cy: hc.y, towers, spawns, entryRects, safeZones, bounds: { x0: 0, y0: 0, x1: w, y1: h } },
    enemies: [],
  };
}

// Фарм-зоны и их сезонные крылья — открытые местности на четыре спота,
// см. generateFarmZone и соседей в блоке «Открытые локации» ниже.

// Мир (см. блок WORLD_* в shared/definitions.js — там заказ и разбор ярусов).
// Не комнаты с коридорами, а одна открытая местность, как в MMORPG: луг у
// входа, река с мостами, лес, скальная гряда с перевалами, выжженные пустоши
// и каменная площадь трона. По краю — сплошной лес, между спотами —
// грунтовые дороги. Проходимость по-прежнему решает grid (лес, вода и скалы —
// WALL); что именно нарисовать на клетке, клиент берёт из terrain
// (WORLD_T, отдаётся в openWorld.terrain).
//
// Монстры стоят ПАЧКАМИ на именованных спотах WORLD_SPOTS; у каждой пачки
// свои packMateIds, так что удар по одному будит всю пачку (Room.js's
// _wakePack). Босс — один, на площади трона за кольцом колонн, с тем же
// таймером 1-2 часа и той же записью в boss_state, что у боссов коридоров
// (arm 'openWorld').
//
// rooms здесь — не геометрия, а квадраты вокруг спотов: клиент по ним
// сужает автоприцел до «своего» спота (_getRoomAt, js/game.js), чтобы игрок
// на краю одного спота не убегал бить пачку соседнего.

// RLE местности: «код + длина серии в base36 + точка», построчно подряд.
// 150×110 клеток сжимаются в несколько килобайт — карта едет в том же
// снимке этажа, что и grid.
function _worldTerrainRle(terrain) {
  const flat = [];
  for (const row of terrain) for (const v of row) flat.push(v);
  let out = '';
  for (let i = 0; i < flat.length;) {
    let j = i;
    while (j < flat.length && flat[j] === flat[i]) j++;
    out += flat[i] + (j - i).toString(36) + '.';
    i = j;
  }
  return out;
}

function generateWorld() {
  const rng = seededRng(2026 * 1337 + 777 + 700);
  const w = WORLD_W, h = WORLD_H;
  const T = WORLD_T;
  const terrain = Array.from({ length: h }, () => new Array(w).fill(T.GRASS));
  function inBounds(gx, gy) { return gx >= 0 && gx < w && gy >= 0 && gy < h; }
  const B = WORLD_BOSS_SPOT, S = WORLD_SPAWN;
  // Гладкий шум для «рваных» краёв леса и берегов: сумма синусов с
  // фазами из rng — детерминированно и без сетки.
  const ph = Array.from({ length: 6 }, () => rng() * Math.PI * 2);
  const wob = (x, y, s) => Math.sin(x * 0.21 * s + ph[0]) * 0.5 + Math.sin(y * 0.17 * s + ph[1]) * 0.5
    + Math.sin((x + y) * 0.11 * s + ph[2]) * 0.6;
  const near = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  const spotPad = (x, y, pad) => WORLD_SPOTS.some(sp => near(x, y, sp.x, sp.y, sp.r + pad))
    || near(x, y, B.x, B.y, B.r + 5 + pad) || near(x, y, S.x, S.y, 5 + pad);

  // ── лес по краю карты ───────────────────────────────────────────────────
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const edge = Math.min(x, y, w - 1 - x, h - 1 - y);
    if (edge < 3 + 1.6 * (wob(x, y, 1) + 1.6)) terrain[y][x] = T.TREE;
  }

  // ── река: петляет с севера на юг ────────────────────────────────────────
  const riverX = y => WORLD_RIVER_X + Math.sin(y / 13 + ph[3]) * 2.2 + Math.sin(y / 5.5) * 0.7;
  for (let y = 0; y < h; y++) {
    const cx = riverX(y), hw = 1.6 + (Math.sin(y / 9 + ph[4]) + 1) * 0.5;
    for (let x = Math.floor(cx - hw - 1); x <= Math.ceil(cx + hw + 1); x++) {
      if (inBounds(x, y) && Math.abs(x - cx) <= hw) terrain[y][x] = T.WATER;
    }
  }

  // ── скальная гряда ──────────────────────────────────────────────────────
  const ridgeX = y => WORLD_RIDGE_X + Math.sin(y / 11 + ph[5]) * 1.8;
  for (let y = 0; y < h; y++) {
    const cx = ridgeX(y), hw = 1.3 + (wob(cx, y, 2) + 1.6) * 0.45;
    for (let x = Math.floor(cx - hw - 1); x <= Math.ceil(cx + hw + 1); x++) {
      if (inBounds(x, y) && Math.abs(x - cx) <= hw && terrain[y][x] !== T.TREE) terrain[y][x] = T.ROCK;
    }
  }

  // ── рощи на лугу и в лесу, валуны в пустошах ────────────────────────────
  const groves = [];
  for (let i = 0; i < 600 && groves.length < 80; i++) {
    const x = 8 + rng() * (w - 16), y = 8 + rng() * (h - 16);
    if (spotPad(x, y, 4)) continue;
    if (Math.abs(x - WORLD_RIVER_X) < 6 || Math.abs(x - WORLD_RIDGE_X) < 6) continue;
    const ash = x > WORLD_RIDGE_X;
    // Луг — редкие перелески: половина бросков мимо, лес между рекой и
    // грядой — густой.
    if (x < WORLD_RIVER_X && rng() < 0.45) continue;
    groves.push({ x, y, r: ash ? 1 + rng() * 1.6 : 1.6 + rng() * (x < WORLD_RIVER_X ? 2.2 : 3.4), kind: ash ? T.ROCK : T.TREE });
    if (!ash && x > WORLD_RIVER_X) groves[groves.length - 1].r += 1;
  }
  for (const g of groves) {
    for (let y = Math.floor(g.y - g.r - 2); y <= g.y + g.r + 2; y++) for (let x = Math.floor(g.x - g.r - 2); x <= g.x + g.r + 2; x++) {
      if (!inBounds(x, y) || terrain[y][x] !== T.GRASS || spotPad(x, y, 2)) continue;
      if (near(x, y, g.x, g.y, g.r + wob(x, y, 3) * 0.5)) terrain[y][x] = g.kind;
    }
  }

  // ── площадь трона и кольцо колонн, проход с запада ──────────────────────
  for (let y = B.y - 12; y <= B.y + 12; y++) for (let x = B.x - 12; x <= B.x + 12; x++) {
    if (!inBounds(x, y)) continue;
    const dx = x - B.x, dy = y - B.y, d = Math.sqrt(dx * dx + dy * dy);
    if (d <= B.r + 3) terrain[y][x] = T.PLAZA;
    else if (d <= B.r + 4.6 && !(dx < 0 && Math.abs(dy) <= 2)) terrain[y][x] = T.ROCK;
    else if (d <= B.r + 7 && terrain[y][x] !== T.TREE) terrain[y][x] = T.GRASS;
  }

  // ── дороги: мост через реку, перевал через гряду ────────────────────────
  // Дорога расчищает себе полосу шириной 3 клетки (и по клетке обочины —
  // чтобы роща не прижималась к самой колее). Вода под дорогой — мост.
  function paintRoad(x0, y0, x1, y1) {
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2);
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const bend = Math.sin(t * Math.PI) * Math.sin((x0 + y1) * 0.7) * 1.5;
      const cx = x0 + (x1 - x0) * t + bend * (y1 - y0) / Math.max(1, Math.hypot(x1 - x0, y1 - y0));
      const cy = y0 + (y1 - y0) * t - bend * (x1 - x0) / Math.max(1, Math.hypot(x1 - x0, y1 - y0));
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const x = Math.round(cx + dx), y = Math.round(cy + dy);
        if (!inBounds(x, y) || x < 2 || y < 2 || x > w - 3 || y > h - 3) continue;
        const d2 = dx * dx + dy * dy;
        const cur = terrain[y][x];
        if (d2 <= 2) {
          if (cur === T.WATER || cur === T.BRIDGE) terrain[y][x] = T.BRIDGE;
          else if (cur !== T.PLAZA) terrain[y][x] = T.ROAD;
        } else if (d2 <= 5 && (cur === T.TREE || cur === T.ROCK) && Math.abs(x - WORLD_RIVER_X) > 4) {
          terrain[y][x] = T.GRASS;
        } else if (d2 <= 5 && cur === T.WATER) {
          terrain[y][x] = T.BRIDGE;
        }
      }
    }
  }
  for (const road of WORLD_ROADS) {
    for (let i = 0; i + 1 < road.length; i++) paintRoad(road[i][0], road[i][1], road[i + 1][0], road[i + 1][1]);
  }

  const passable = v => v === T.GRASS || v === T.ROAD || v === T.BRIDGE || v === T.PLAZA;
  const grid = terrain.map(row => row.map(v => (passable(v) ? FLOOR : WALL)));

  // ── карман, куда не дойти от входа, — тоже лес ──────────────────────────
  // Рощи случайные, и изредка две смыкаются кольцом. Заливка от входа: всё,
  // куда игрок не дойдёт, становится стеной, чтобы там не встал монстр.
  const seen = Array.from({ length: h }, () => new Uint8Array(w));
  const stack = [[S.x, S.y]];
  seen[S.y][S.x] = 1;
  while (stack.length) {
    const [x, y] = stack.pop();
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (!inBounds(nx, ny) || seen[ny][nx] || grid[ny][nx] !== FLOOR) continue;
      seen[ny][nx] = 1;
      stack.push([nx, ny]);
    }
  }
  for (let gy = 0; gy < h; gy++) for (let gx = 0; gx < w; gx++) {
    if (seen[gy][gx] || grid[gy][gx] !== FLOOR) continue;
    grid[gy][gx] = WALL;
    terrain[gy][gx] = gx > WORLD_RIDGE_X ? T.ROCK : T.TREE;
  }

  function freeTileNear(cx, cy, rad) {
    for (let attempt = 0; attempt < 60; attempt++) {
      const gx = Math.round(cx + (rng() * 2 - 1) * rad), gy = Math.round(cy + (rng() * 2 - 1) * rad);
      if (inBounds(gx, gy) && grid[gy][gx] === FLOOR) return { gx, gy };
    }
    return { gx: cx, gy: cy };
  }

  const WEAK_MULT = 0.5; // то же половинение, что у пачек коридоров и фарм-зон
  // Ранг и цвет — по полосе самой локации (40 — «Слабый», 59 — верх), как у
  // Фарм зоны 2 и по той же причине: рукавная шкала ломается на 40/41.
  const maxLocalLvl = WORLD_LVL_MAX - WORLD_LVL_MIN + 1;
  const rooms = [], enemyList = [], spots = [];
  let eid = 0;

  WORLD_SPOTS.forEach(sp => {
    const tier = WORLD_TIERS[sp.tier];
    const size = sp.r * 2 + 5, x = sp.x - Math.floor(size / 2), y = sp.y - Math.floor(size / 2);
    rooms.push({
      x, y, size, bx1: x - 1, by1: y - 1, bx2: x + size + 1, by2: y + size + 1,
      cx: sp.x, cy: sp.y, isWorldSpot: true, spot: sp.id, tier: sp.tier, monsterLvl: sp.lvl[0],
    });
    spots.push({
      id: sp.id, name: sp.name, tier: sp.tier, lvl: sp.lvl.slice(),
      x: sp.x * TILE + TILE / 2, y: sp.y * TILE + TILE / 2, r: sp.r * TILE,
    });
    for (let p = 0; p < sp.packs; p++) {
      // Пачки разнесены по кругу спота, а не свалены в его центр.
      const ang = (p / sp.packs) * Math.PI * 2 + rng() * 0.6;
      const dist = sp.r * (0.4 + rng() * 0.45);
      const pcx = Math.round(sp.x + Math.cos(ang) * dist), pcy = Math.round(sp.y + Math.sin(ang) * dist);
      // Пачка — один вид: так их и различают на споте («слева вампиры»).
      const d = _enemyByEid.get(FARM_HIGH_SPECIES[sp.species[Math.floor(rng() * sp.species.length)]]);
      if (!d) continue;
      const pack = [];
      const taken = new Set();
      for (let n = 0; n < tier.packSize; n++) {
        const lvl = sp.lvl[0] + Math.floor(rng() * (sp.lvl[1] - sp.lvl[0] + 1));
        const stats = monsterStatsAtLevel(lvl, d.eType);
        // Члены пачки — кольцом вокруг её центра, каждый на своём тайле:
        // сваленные в одну клетку, они сливались в одну фигуру, а их имена и
        // полоски HP ложились друг на друга нечитаемой кашей.
        const a = (n / tier.packSize) * Math.PI * 2 + rng() * 0.5;
        let gx = Math.round(pcx + Math.cos(a) * 1.6), gy = Math.round(pcy + Math.sin(a) * 1.6);
        if (!inBounds(gx, gy) || grid[gy][gx] !== FLOOR || taken.has(gy * w + gx)) ({ gx, gy } = freeTileNear(pcx, pcy, 2.5));
        taken.add(gy * w + gx);
        const ex = gx * TILE + TILE / 2, ey = gy * TILE + TILE / 2;
        const localLvl = lvl - WORLD_LVL_MIN + 1;
        pack.push({
          id: `world_${sp.id}_${eid++}`, ...d, isBoss: false, arm: 'openWorld', openWorld: true, spot: sp.id,
          rlvl: lvl,
          name: monsterNameAtLevel(d.name, localLvl, false, d.fem, maxLocalLvl),
          color: monsterColorAtLevel(d.color, d.endColor, localLvl, false, maxLocalLvl),
          maxHp: Math.floor(stats.hp * WEAK_MULT * WORLD_MOB_STAT_MULT), hp: Math.floor(stats.hp * WEAK_MULT * WORLD_MOB_STAT_MULT),
          atk: Math.floor(stats.atk * WEAK_MULT * WORLD_MOB_STAT_MULT), def: Math.floor(stats.def * WORLD_MOB_STAT_MULT), spd: d.spd,
          xp: xpAtLevel(lvl) * WORLD_XP_MULT, gold: goldAtLevel(lvl),
          x: ex, y: ey, spawnX: ex, spawnY: ey,
          atkTimer: 1 + rng(),
          // Лоу-споты сами не бросаются (Room.js читает `passive` в проверке
          // самоагра), мид и топ — агрятся на подходе.
          aggro: false, aggroR: 175 + rng() * 55, passive: !tier.selfAggro,
        });
      }
      const ids = pack.map(e => e.id);
      pack.forEach(e => { e.packMateIds = ids.filter(id => id !== e.id); });
      enemyList.push(...pack);
    }
  });

  // ── Владыка Мира ────────────────────────────────────────────────────────
  const bd = _enemyByEid.get(FLOOR_ENEMIES[3].boss);
  if (bd) {
    const bs = monsterStatsAtLevel(WORLD_BOSS_LEVEL, 'boss');
    const bx = B.x * TILE + TILE / 2, by = B.y * TILE + TILE / 2;
    const size = B.r * 2 + 5, x = B.x - Math.floor(size / 2), y = B.y - Math.floor(size / 2);
    rooms.push({
      x, y, size, bx1: x - 1, by1: y - 1, bx2: x + size + 1, by2: y + size + 1,
      cx: B.x, cy: B.y, isWorldSpot: true, spot: B.id, tier: 'boss', monsterLvl: WORLD_BOSS_LEVEL, isBoss: true,
    });
    spots.push({ id: B.id, name: B.name, tier: 'boss', lvl: [WORLD_BOSS_LEVEL, WORLD_BOSS_LEVEL], x: bx, y: by, r: B.r * TILE });
    enemyList.push({
      id: 'world_boss', ...bd, isBoss: true, arm: 'openWorld', openWorld: true, spot: B.id,
      rlvl: WORLD_BOSS_LEVEL, name: B.bossName, size: 34,
      maxHp: Math.floor(bs.hp * WORLD_BOSS_HP_MULT), hp: Math.floor(bs.hp * WORLD_BOSS_HP_MULT),
      atk: bs.atk, def: bs.def, spd: bd.spd * 1.5,
      xp: xpAtLevel(WORLD_BOSS_LEVEL) * WORLD_XP_MULT * 20, gold: goldAtLevel(WORLD_BOSS_LEVEL) * 20,
      x: bx, y: by, spawnX: bx, spawnY: by,
      atkTimer: 1 + rng(), aggro: false, aggroR: 220,
    });
  }

  const spawn = { x: S.x * TILE + TILE / 2, y: S.y * TILE + TILE / 2 };
  return {
    grid, rooms, w, h, spawn,
    returnPad: { x: (S.x - 5) * TILE + TILE / 2, y: S.y * TILE + TILE / 2 },
    openWorld: { bounds: { x0: 0, y0: 0, x1: w, y1: h }, minLevel: WORLD_ENTRY_LEVEL, spots, terrain: _worldTerrainRle(terrain) },
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

// ── Подземелье: зал телепортов (Dungeon: teleport hall) ──────────────────
// Entry floor (own floor id, server/game/floors.js — walked onto from the
// hub's own portal pad exactly like Фарм зона 2, see generateHub's
// dungeonEntry above): one big, always-empty square hall, no monsters,
// holding DUNGEON_CLASSES.length teleport pads in a row, one per class.
// Walking onto a pad is a real floor transition (js/game.js's
// _updateTeleportPads — the same generic pad-walk mechanism the hub's own
// arm/farm/guild-war pads already use), into that class's own zone floor
// (generateDungeonZone, below). "Можно войти только в свою зону классовую"
// is enforced the same way every level-gated floor already is —
// resolveFloor (server/world.js) refuses the transition outright if the
// walking player's own class doesn't match the pad's class — so there is
// no in-floor class-gate geometry to draw or check here, unlike the old
// Башня's own corridor gates.
function generateDungeonHub() {
  const classes = DUNGEON_CLASSES;
  // Halved from 8/10/24 (owner's own follow-up: "подземелье локацию в 2 раза
  // меньше там где телепорты") — 4/5/12, each term exactly half of what it
  // replaces, so HALL itself comes out exactly half of its old value (29 vs
  // 58 at 7 classes) rather than just approximately smaller.
  const padGap = 4;
  // Square, not just wide — roomAt (js/game.js) tests tx < r.x + r.size and
  // ty < r.y + r.size against the SAME size, so a non-square hall would
  // mis-hit-test its own shorter axis. 12 is a floor so a 7-class row still
  // leaves the spawn/return end some breathing room even at padGap's own
  // smaller multiples.
  const HALL = Math.max((classes.length - 1) * padGap + 5, 12);
  const w = MARGIN * 2 + HALL, h = MARGIN * 2 + HALL;

  const grid = Array.from({ length: h }, () => new Array(w).fill(WALL));
  function inBounds(gx, gy) { return gx >= 0 && gx < w && gy >= 0 && gy < h; }
  function paintFloor(gx, gy) { if (inBounds(gx, gy)) grid[gy][gx] = FLOOR; }
  function paintRect(x0, y0, x1, y1) {
    for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) paintFloor(gx, gy);
  }

  const roomX0 = MARGIN, roomY0 = MARGIN, roomX1 = w - MARGIN - 1, roomY1 = h - MARGIN - 1;
  paintRect(roomX0, roomY0, roomX1, roomY1);
  const room = {
    x: roomX0, y: roomY0, size: HALL,
    bx1: roomX0 - 1, by1: roomY0 - 1, bx2: roomX1 + 1, by2: roomY1 + 1,
    cx: roomX0 + Math.floor(HALL / 2), cy: roomY0 + Math.floor(HALL / 2),
    isDungeonHub: true,
  };

  // One row of pads near the north wall — client draws each with that
  // class's own badge icon (drawClassBadgeCtx, js/icons.js), same artwork
  // the old branch-mouth signs used, just on a walk-to pad now instead of a
  // baked floor decal.
  const padsY = roomY0 + 5;
  const firstX = roomX0 + Math.floor((HALL - (classes.length - 1) * padGap) / 2);
  const classPads = classes.map((cls, i) => ({ cls, tx: firstX + i * padGap, ty: padsY }));

  const cx = room.cx;
  // returnPad sits right at the entrance (south wall); spawn a few tiles
  // further in, clear of it — same "returnPad closer to the door than
  // spawn" shape every arm's own entrance uses (see generateArm above).
  const spawn = { x: cx * TILE + TILE / 2, y: (roomY1 - 4) * TILE + TILE / 2 };
  const returnPad = { x: cx * TILE + TILE / 2, y: (roomY1 - 1) * TILE + TILE / 2 };

  return {
    grid, rooms: [room], w, h,
    spawn,
    returnPad,
    classPads,
    enemies: [],
  };
}

// ── Подземелье: классовая зона (Dungeon: class zone) ──────────────────────
// One floor per class (DUNGEON_CLASSES.length of these, server/game/
// floors.js), entered only from generateDungeonHub's own pad for this
// class — same "own floor per destination" shape every leveling arm
// already uses (generateArm above), just gated by class instead of level.
// A short straight entrance corridor, always empty, leads to
// DUNGEON_ROOM_COUNT rooms (2) chained one after another, every room
// holding DUNGEON_MOBS_PER_ROOM monsters in DUNGEON_PACK_SIZE clusters,
// picked at random from DUNGEON_LICH per cluster — same grid-of-slots
// placement generateFarmZone2 uses above (so no two clusters in a room
// blend into one visual blob), and the same packMateIds
// wake-the-whole-cluster-on-one-hit wiring (Room.js's _wakePack). Exactly
// the same monsters/loot/drop principle the old per-class corridor used,
// just without a shared main corridor or class-gate geometry to maintain —
// only this class's own players are ever routed onto this floor at all
// (resolveFloor, server/world.js).
function generateDungeonZone(cls, idx) {
  const rng = seededRng(2026 * 1337 + 13321 + idx);
  const roomSize = DUNGEON_ROOM;
  const halfRoom = Math.floor(roomSize / 2);
  const entryLen = DUNGEON_STUB;
  const w = roomSize + MARGIN * 2;
  const depth = entryLen + (DUNGEON_STUB + roomSize) * DUNGEON_ROOM_COUNT;
  const h = depth + MARGIN * 2;

  const grid = Array.from({ length: h }, () => new Array(w).fill(WALL));
  function inBounds(gx, gy) { return gx >= 0 && gx < w && gy >= 0 && gy < h; }
  function paintFloor(gx, gy) { if (inBounds(gx, gy)) grid[gy][gx] = FLOOR; }
  function paintRect(x0, y0, x1, y1) {
    for (let gy = y0; gy <= y1; gy++) for (let gx = x0; gx <= x1; gx++) paintFloor(gx, gy);
  }

  const cx = MARGIN + halfRoom;
  const rooms = [];
  const enemyList = [];
  let eid = 0;

  // Entrance corridor, running north from the bottom edge — same shape
  // every arm's own main corridor opens with, just with nothing chained
  // off its sides.
  let cursor = h - MARGIN;
  paintRect(cx - BW, cursor - entryLen, cx + BW, cursor - 1);
  cursor -= entryLen;

  for (let ri = 0; ri < DUNGEON_ROOM_COUNT; ri++) {
    paintRect(cx - BW, cursor - DUNGEON_STUB, cx + BW, cursor - 1);
    cursor -= DUNGEON_STUB;
    const roomY1 = cursor - 1, roomY0 = cursor - roomSize;
    const roomX0 = cx - halfRoom, roomX1 = roomX0 + roomSize - 1;
    paintRect(roomX0, roomY0, roomX1, roomY1);
    const room = {
      x: roomX0, y: roomY0, size: roomSize,
      bx1: roomX0 - 1, by1: roomY0 - 1, bx2: roomX1 + 1, by2: roomY1 + 1,
      cx, cy: roomY0 + halfRoom,
      isDungeon: true, arm: 'dungeon', dungeonClass: cls,
    };
    rooms.push(room);
    cursor -= roomSize;

    const usable = room.size - 4; // inset from the room's own walls
    const packsPerRoom = Math.ceil(DUNGEON_MOBS_PER_ROOM / DUNGEON_PACK_SIZE);
    const gridN = Math.ceil(Math.sqrt(packsPerRoom));
    const pitch = usable / gridN;
    const slots = [];
    for (let gx = 0; gx < gridN; gx++) for (let gy = 0; gy < gridN; gy++) slots.push({ gx, gy });
    for (let i = slots.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [slots[i], slots[j]] = [slots[j], slots[i]];
    }

    let placed = 0, slotIdx = 0;
    while (placed < DUNGEON_MOBS_PER_ROOM) {
      const packSize = Math.min(DUNGEON_PACK_SIZE, DUNGEON_MOBS_PER_ROOM - placed);
      const slot = slots[slotIdx++];
      let ccx = room.x + 2 + Math.round(pitch * (slot.gx + 0.5));
      let ccy = room.y + 2 + Math.round(pitch * (slot.gy + 0.5));
      if (!inBounds(ccx, ccy) || grid[ccy][ccx] !== FLOOR) { ccx = room.cx; ccy = room.cy; }
      const pack = [];
      for (let m = 0; m < packSize; m++) {
        const sp = DUNGEON_LICH[DUNGEON_SPECIES[Math.floor(rng() * DUNGEON_SPECIES.length)]];
        let ex = ccx * TILE + TILE / 2, ey = ccy * TILE + TILE / 2;
        for (let attempt = 0; attempt < 20; attempt++) {
          const gx = ccx + Math.floor(rng() * 3) - 1, gy = ccy + Math.floor(rng() * 3) - 1;
          if (inBounds(gx, gy) && grid[gy][gx] === FLOOR) { ex = gx * TILE + TILE / 2; ey = gy * TILE + TILE / 2; break; }
        }
        const enemy = {
          id: `dungeon_${cls}_${ri}_${eid++}`, eid: sp.eid, name: sp.name, color: sp.color, size: sp.size,
          isBoss: false, arm: 'dungeon', dungeon: true, dungeonClass: cls,
          rlvl: DUNGEON_LVL,
          maxHp: sp.hp, hp: sp.hp, atk: sp.atk, def: 0, spd: sp.spd,
          atkRange: sp.atkRange, atkCdMult: sp.atkCdMult,
          xp: sp.xp, gold: sp.gold,
          x: ex, y: ey, spawnX: ex, spawnY: ey,
          // Aggressive from spawn (owner's own ask), not just on approach —
          // the self-aggro proximity trigger (Room.js's _tick) only ever
          // sets this the same way, so starting it true just skips the
          // "wait for someone to get close" step entirely; aggroR still
          // matters for nothing once this is already true.
          atkTimer: 1 + rng(), aggro: true, aggroR: 175 + rng() * 55,
        };
        enemyList.push(enemy);
        pack.push(enemy);
      }
      pack.forEach(e => { e.packMateIds = pack.filter(o => o !== e).map(o => o.id); });
      placed += packSize;
    }
  }

  // Same entrance/return-pad shape every arm's own floor uses: returnPad
  // right at the door, spawn a couple tiles further in.
  const spawn = { x: cx * TILE + TILE / 2, y: (h - MARGIN - 2) * TILE + TILE / 2 };
  const returnPad = { x: cx * TILE + TILE / 2, y: (h - MARGIN - 1) * TILE + TILE / 2, target: 'dungeon' };

  return {
    grid, rooms, w, h,
    spawn,
    returnPad,
    // Which class this floor belongs to — read by _currentLocationBounds
    // (js/ui.js) to show the zone's bestiary/loot list on the map panel
    // (owner's own ask) without needing a `bounds` sub-object the way
    // farmHigh/farmZone/etc. do: the whole floor already IS the zone, there
    // is nothing else on it to distinguish bounds from.
    dungeonZone: cls,
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

// Турнир (32-player double elimination) — one sealed 1v1 pit, generated
// fresh for every match the bracket deploys (see _createTournamentPitRoom,
// server/game/tournament.js), the same way generateFear() is called fresh
// for every fearEnter rather than once at boot. Two facing spawn points,
// close enough together to fight, far enough apart that a round's deploy
// doesn't start the two of them already in contact (same reasoning
// generatePvpArena's team spawns follow).
function generateTournamentPit() {
  const w = TR_ARENA_D + MARGIN * 2, h = TR_ARENA_D + MARGIN * 2;
  const grid = Array.from({ length: h }, () => new Array(w).fill(WALL));
  const x0 = MARGIN, y0 = MARGIN;
  const cx = x0 + TR_ARENA_R, cy = y0 + TR_ARENA_R;
  // Круг: клетка — пол, если её центр не дальше радиуса (+0.35, чтобы край
  // выходил ровным, без одиночных зубцов на осях).
  const rr = (TR_ARENA_R + 0.35) * (TR_ARENA_R + 0.35);
  for (let gy = y0; gy < y0 + TR_ARENA_D; gy++) {
    for (let gx = x0; gx < x0 + TR_ARENA_D; gx++) {
      const dx = gx - cx, dy = gy - cy;
      if (dx * dx + dy * dy <= rr) grid[gy][gx] = FLOOR;
    }
  }
  const px = t => t * TILE + TILE / 2;
  const pit = {
    a: { x: px(cx - TR_ARENA_SPAWN), y: px(cy) },
    b: { x: px(cx + TR_ARENA_SPAWN), y: px(cy) },
  };

  return {
    grid, rooms: [], w, h,
    spawn: pit.a,
    tournament: { pit },
    // Для клиента: по этим полям он рисует пол колизея — песок, каменное
    // кольцо, трибуны и жаровни (_tournamentArena, js/themes.js). Всё в
    // клетках; spawns — где встают бойцы, там на песке их знаки.
    tournamentArena: {
      bounds: { x0, y0, x1: x0 + TR_ARENA_D, y1: y0 + TR_ARENA_D },
      cx, cy, r: TR_ARENA_R,
      spawns: [{ x: cx - TR_ARENA_SPAWN, y: cy }, { x: cx + TR_ARENA_SPAWN, y: cy }],
    },
    enemies: [],
  };
}

// Кровавая Башня — свой этаж (server/game/floors.js). Генерируется один раз
// при старте с фиксированным зерном, поэтому лабиринт постоянный; меняется
// от забега к забегу только комната с порталом (Room.racePickPortal).
// `bounds` — вся сетка: клиент красит её в цвета Башни (_isRace10Tile,
// js/game.js).
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
  const HALL_COL = Math.floor(RACE10_COLS / 2);
  const pad = Math.floor((RACE10_CELL - RACE10_ROOM) / 2);
  // Верхний левый тайл комнаты в клетке (c, r).
  const cellX = c => X0 + c * RACE10_CELL + pad;
  const cellY = r => Y0 + r * RACE10_CELL + pad;
  const cellCx = c => cellX(c) + Math.floor(RACE10_ROOM / 2);
  const cellCy = r => cellY(r) + Math.floor(RACE10_ROOM / 2);
  const px = t => t * TILE + TILE / 2;

  // Центральный зал — весь средний столбец одним помещением.
  const hallX0 = cellX(HALL_COL), hallY0 = cellY(0);
  const hallX1 = hallX0 + RACE10_ROOM - 1, hallY1 = cellY(RACE10_ROWS - 1) + RACE10_ROOM - 1;
  paintRect(hallX0, hallY0, hallX1, hallY1);

  const rooms = [];
  for (let r = 0; r < RACE10_ROWS; r++) {
    for (let c = 0; c < RACE10_COLS; c++) {
      if (c === HALL_COL) continue;
      const x0 = cellX(c), y0 = cellY(r);
      paintRect(x0, y0, x0 + RACE10_ROOM - 1, y0 + RACE10_ROOM - 1);
      rooms.push({
        c, r,
        x0: x0 * TILE, y0: y0 * TILE, x1: (x0 + RACE10_ROOM) * TILE, y1: (y0 + RACE10_ROOM) * TILE,
        cx: px(cellCx(c)), cy: px(cellCy(r)),
      });
    }
  }

  // Проходы. Остов — случайное остовное дерево по всем клеткам (зал — одна
  // вершина), так что из зала дойти можно до любой комнаты; сверху несколько
  // лишних дверей, чтобы лабиринт не был одними тупиками.
  const key = (c, r) => (c === HALL_COL ? 'hall' : c + ',' + r);
  const doors = new Set();
  function carve(c1, r1, c2, r2) {
    const id = [c1, r1, c2, r2].join(',');
    if (doors.has(id)) return;
    doors.add(id); doors.add([c2, r2, c1, r1].join(','));
    if (r1 === r2) {
      const cy = cellCy(r1);
      const xa = Math.min(cellX(c1), cellX(c2)) + RACE10_ROOM - 1, xb = Math.max(cellX(c1), cellX(c2));
      paintRect(xa, cy - RACE10_DOOR_HW, xb, cy + RACE10_DOOR_HW);
    } else {
      const cx = cellCx(c1);
      const ya = Math.min(cellY(r1), cellY(r2)) + RACE10_ROOM - 1, yb = Math.max(cellY(r1), cellY(r2));
      paintRect(cx - RACE10_DOOR_HW, ya, cx + RACE10_DOOR_HW, yb);
    }
  }
  const edges = [];
  for (let r = 0; r < RACE10_ROWS; r++) {
    for (let c = 0; c < RACE10_COLS; c++) {
      // Внутри зала стен нет — вертикальных проходов в его столбце не нужно.
      if (c + 1 < RACE10_COLS) edges.push([c, r, c + 1, r]);
      if (r + 1 < RACE10_ROWS && c !== HALL_COL) edges.push([c, r, c, r + 1]);
    }
  }
  for (let i = edges.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [edges[i], edges[j]] = [edges[j], edges[i]];
  }
  const parent = new Map();
  const find = k => { while (parent.has(k) && parent.get(k) !== k) k = parent.get(k); return k; };
  const spare = [];
  for (const e of edges) {
    const a = find(key(e[0], e[1])), b = find(key(e[2], e[3]));
    if (a === b) { spare.push(e); continue; }
    parent.set(a, b);
    carve(...e);
  }
  spare.slice(0, RACE10_EXTRA_DOORS).forEach(e => carve(...e));

  // Места появления — плотная сетка вокруг середины зала, по одному на
  // участника (raceDeploy раздаёт их по порядку).
  const hallCx = Math.floor((hallX0 + hallX1) / 2), hallCy = Math.floor((hallY0 + hallY1) / 2);
  const lanes = [];
  for (let i = 0; i < RACE10_LANES; i++) {
    const col = i % 5, row = Math.floor(i / 5);
    lanes.push({ x: px(hallCx + (col - 2) * 2), y: px(hallCy + row * 2 - 9) });
  }

  const bossRoomX0 = X0 + RACE10_COLS * RACE10_CELL + RACE10_BOSS_GAP;
  const bossRoomY0 = Y0 + Math.floor((RACE10_H - RACE10_BOSS_ROOM) / 2);
  paintRect(bossRoomX0, bossRoomY0, bossRoomX0 + RACE10_BOSS_ROOM - 1, bossRoomY0 + RACE10_BOSS_ROOM - 1);
  const bossCx = bossRoomX0 + Math.floor(RACE10_BOSS_ROOM / 2);
  const bossCy = bossRoomY0 + Math.floor(RACE10_BOSS_ROOM / 2);
  // A small ring of arrival points around the boss, one per simultaneous
  // arrival — without these, everyone _race10ReachBoss teleports in lands on
  // the exact same tile as the boss and each other.
  const bossArrivalSpots = Array.from({ length: RACE10_BOSS_SPOTS }, (_, i) => {
    const ang = (i / RACE10_BOSS_SPOTS) * Math.PI * 2;
    return {
      x: (bossCx + Math.round(Math.cos(ang) * RACE10_BOSS_SPOT_R)) * TILE + TILE / 2,
      y: (bossCy + Math.round(Math.sin(ang) * RACE10_BOSS_SPOT_R)) * TILE + TILE / 2,
    };
  });

  return {
    grid, rooms: [], w, h,
    spawn: { x: px(hallCx), y: px(hallCy) },
    race10: {
      // Место появления каждого участника в зале (индекс = «lane»: номер
      // участника в забеге, по нему же Room._raceVisible и реконнект).
      lanes,
      // Комнаты лабиринта, в одной из которых на каждый забег открывается
      // портал. Пиксели.
      rooms,
      portalR: RACE10_PORTAL_R,
      boss: { x: px(bossCx), y: px(bossCy) },
      bossArrivalSpots,
      bounds: { x0: 0, y0: 0, x1: w, y1: h },
      // Past this x, a player is considered to have reached the shared boss
      // room — Room._playerLaneKey uses it to let racers who got there see
      // each other (the one deliberate exception to lane isolation).
      bossRoomX0: bossRoomX0 * TILE,
      barriers: [],
    },
    enemies: [],
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

// ── Опробовать персонажа (character trial) ──────────────────────────────────
// Its own floor (see server/game/floors.js), same "private, generated fresh
// per entrant" shape as Страх just above — one player, one sealed empty room,
// created by server/handlers2/trial.js's trialEnter rather than at boot. No
// lanes (there is never more than one occupant) and no baked-in monsters:
// Room.trialSpawnMonsters lays down a single static batch once the player is
// deployed, same "geometry now, monsters at runtime" split Fear uses.
// Bigger than Fear's own 12-tile room on purpose — this has to comfortably
// fit the widest AOE any class's kit throws (250px, Assassin's «Крик»)
// with room to walk around a monster and see it from every side.
const TRIAL_ROOM = 20;

function generateTrial() {
  const w = TRIAL_ROOM + MARGIN * 2, h = TRIAL_ROOM + MARGIN * 2;
  const grid = Array.from({ length: h }, () => new Array(w).fill(WALL));
  const X0 = MARGIN, Y0 = MARGIN;
  for (let gy = Y0; gy < Y0 + TRIAL_ROOM; gy++) {
    for (let gx = X0; gx < X0 + TRIAL_ROOM; gx++) grid[gy][gx] = FLOOR;
  }
  const spawn = {
    x: (X0 + Math.floor(TRIAL_ROOM / 2)) * TILE + TILE / 2,
    y: (Y0 + Math.floor(TRIAL_ROOM / 2)) * TILE + TILE / 2,
  };
  return { grid, rooms: [], w, h, spawn, enemies: [] };
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

// ═══════════════════════════════════════════════════════════════════════════
//  ОТКРЫТЫЕ ЛОКАЦИИ «ПЕПЕЛЬНОГО КРАЯ»
// ═══════════════════════════════════════════════════════════════════════════
// Этажи прокачки и фарм-зоны без комнат и коридоров: одна местность, как в
// «Пепельном крае», — кромка леса или скал по краю, рощи и валуны, водоёмы
// (в Лаве — лава), петляющая дорога и монстры КУЧКАМИ на полянах-спотах.
// Проходимость по-прежнему решает grid; что нарисовать на клетке, клиент
// берёт из aeMap.terrain (коды WORLD_T, RLE — тот же формат, что у Мира) и
// aeMap.biome (js/ashen.js).
//
// rooms здесь, как и в Мире, — квадраты вокруг спотов: по ним клиент сужает
// автоприцел до своего спота, подписывает уровень и строит бестиарий.
const AE_ARM_BIOME = { left: 'forest', top: 'desert', bottom: 'lava', right: 'abyss' };
const AE_ARM_NAME = { left: 'Лес разбойников', top: 'Пустыня', bottom: 'Лава', right: 'Багровая бездна' };

function _aeOpenMap(o) {
  const rng = seededRng(o.seed);
  const w = o.w, h = o.h, T = WORLD_T;
  const terrain = Array.from({ length: h }, () => new Array(w).fill(T.GRASS));
  const inBounds = (x, y) => x >= 0 && x < w && y >= 0 && y < h;
  const ph = Array.from({ length: 4 }, () => rng() * Math.PI * 2);
  const wob = (x, y) => Math.sin(x * 0.23 + ph[0]) * 0.5 + Math.sin(y * 0.19 + ph[1]) * 0.5 + Math.sin((x + y) * 0.13 + ph[2]) * 0.6;
  const near = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  const keep = [{ x: o.spawn.x, y: o.spawn.y, r: 5 }, ...o.spots, ...(o.boss ? [o.boss] : []), ...(o.keep || [])];
  const kept = (x, y, pad) => keep.some(k => near(x, y, k.x, k.y, k.r + pad));
  const obstacle = () => (rng() < (o.rockShare || 0) ? T.ROCK : T.TREE);

  // Кромка по краю карты — рваная, не по линейке.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const edge = Math.min(x, y, w - 1 - x, h - 1 - y);
    if (edge < 3 + 1.3 * (wob(x, y) + 1.6)) terrain[y][x] = (o.rockShare || 0) > 0.5 ? T.ROCK : T.TREE;
  }

  // Дорога: ломаная по точкам пути, полоса в 3 клетки.
  const road = [];
  function paintRoad(x0, y0, x1, y1) {
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2);
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const bend = Math.sin(t * Math.PI) * Math.sin((x0 + y1) * 0.7) * 1.2;
      const L = Math.max(1, Math.hypot(x1 - x0, y1 - y0));
      const cx = x0 + (x1 - x0) * t + bend * (y1 - y0) / L, cy = y0 + (y1 - y0) * t - bend * (x1 - x0) / L;
      road.push([cx, cy]);
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const x = Math.round(cx + dx), y = Math.round(cy + dy);
        if (!inBounds(x, y) || x < 2 || y < 2 || x > w - 3 || y > h - 3) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 <= 2) terrain[y][x] = T.ROAD;
        else if (d2 <= 5 && terrain[y][x] !== T.ROAD) terrain[y][x] = T.GRASS;
      }
    }
  }
  for (const path of o.roads) for (let i = 0; i + 1 < path.length; i++) paintRoad(path[i][0], path[i][1], path[i + 1][0], path[i + 1][1]);
  const nearRoad = (x, y, r) => road.some(p => near(x, y, p[0], p[1], r));

  // Рощи / валуны / водоёмы — не на дороге и не на спотах.
  const blobs = [];
  for (let i = 0; i < (o.groves || 0) * 8 && blobs.length < (o.groves || 0); i++) {
    const x = 5 + rng() * (w - 10), y = 5 + rng() * (h - 10);
    if (kept(x, y, 3) || nearRoad(x, y, 4)) continue;
    blobs.push({ x, y, r: 1.2 + rng() * 2.6, kind: obstacle() });
  }
  for (let i = 0; i < (o.ponds || 0) * 10 && blobs.filter(b => b.kind === T.WATER).length < (o.ponds || 0); i++) {
    const x = 6 + rng() * (w - 12), y = 6 + rng() * (h - 12);
    if (kept(x, y, 4) || nearRoad(x, y, 5)) continue;
    blobs.push({ x, y, r: 1.6 + rng() * 2.4, kind: T.WATER });
  }
  for (const g of blobs) {
    for (let y = Math.floor(g.y - g.r - 2); y <= g.y + g.r + 2; y++) for (let x = Math.floor(g.x - g.r - 2); x <= g.x + g.r + 2; x++) {
      if (!inBounds(x, y) || terrain[y][x] !== T.GRASS || kept(x, y, 1)) continue;
      if (near(x, y, g.x, g.y, g.r + wob(x * 2, y * 2) * 0.5)) terrain[y][x] = g.kind;
    }
  }

  // Поляны спотов и площадь босса — расчищены.
  for (const k of keep) {
    for (let y = Math.floor(k.y - k.r - 1); y <= k.y + k.r + 1; y++) for (let x = Math.floor(k.x - k.r - 1); x <= k.x + k.r + 1; x++) {
      if (!inBounds(x, y) || x < 2 || y < 2 || x > w - 3 || y > h - 3) continue;
      if (near(x, y, k.x, k.y, k.r + 0.5) && terrain[y][x] !== T.ROAD) terrain[y][x] = T.GRASS;
    }
  }
  if (o.boss) {
    const B = o.boss;
    for (let y = B.y - B.r - 1; y <= B.y + B.r + 1; y++) for (let x = B.x - B.r - 1; x <= B.x + B.r + 1; x++) {
      if (inBounds(x, y) && near(x, y, B.x, B.y, B.r)) terrain[y][x] = T.PLAZA;
    }
  }

  const passable = v => v === T.GRASS || v === T.ROAD || v === T.BRIDGE || v === T.PLAZA;
  const grid = terrain.map(row => row.map(v => (passable(v) ? FLOOR : WALL)));
  // Всё, куда от входа не дойти, — тоже стена: там не встанет монстр.
  const seen = Array.from({ length: h }, () => new Uint8Array(w));
  const stack = [[o.spawn.x, o.spawn.y]];
  seen[o.spawn.y][o.spawn.x] = 1;
  while (stack.length) {
    const [x, y] = stack.pop();
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (!inBounds(nx, ny) || seen[ny][nx] || grid[ny][nx] !== FLOOR) continue;
      seen[ny][nx] = 1; stack.push([nx, ny]);
    }
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (seen[y][x] || grid[y][x] !== FLOOR) continue;
    grid[y][x] = WALL; terrain[y][x] = obstacle();
  }

  // Клетки спота для монстров: на полу, внутри круга, без повторов.
  function spotTiles(sp, n) {
    const out = [], taken = new Set();
    for (let attempt = 0; attempt < n * 40 && out.length < n; attempt++) {
      const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * (sp.r - 0.5);
      const gx = Math.round(sp.x + Math.cos(a) * d), gy = Math.round(sp.y + Math.sin(a) * d);
      if (!inBounds(gx, gy) || grid[gy][gx] !== FLOOR || taken.has(gy * w + gx)) continue;
      taken.add(gy * w + gx); out.push({ gx, gy });
    }
    while (out.length < n) out.push({ gx: sp.x, gy: sp.y });
    return out;
  }
  const spotRoom = (sp, extra) => {
    const size = Math.ceil(sp.r) * 2 + 3, x = sp.x - Math.floor(size / 2), y = sp.y - Math.floor(size / 2);
    return { x, y, size, bx1: x - 1, by1: y - 1, bx2: x + size + 1, by2: y + size + 1, cx: sp.x, cy: sp.y, ...extra };
  };
  return { grid, terrain, w, h, rng, spotTiles, spotRoom, rle: _worldTerrainRle(terrain) };
}

// Этаж прокачки: 20 кучек по 10-15 монстров вдоль змейки дороги, уровень
// растёт от входа (внизу слева) к площади босса (вверху). Уровни — те же,
// что были у комнат коридора (ARM_OFFSETS + местный уровень), виды — те же
// полосы FLOOR_ENEMIES, сила — та же половина, что у пачек в комнатах.
const AE_ARM_W = 92, AE_ARM_H = 136, AE_ARM_SPOTS = 20;
function generateOpenArm(dir, armIdx) {
  const fe = FLOOR_ENEMIES[armIdx];
  const N = roomsInArm(armIdx);          // местный уровень босса
  const off = ARM_OFFSETS[armIdx - 1];
  const legsY = [118, 89, 60, 31], X0 = 12, X1 = 80;
  const spawnT = { x: X0, y: 124 };
  const path = [[X0, 127], [X0, legsY[0]], [X1, legsY[0]], [X1, legsY[1]], [X0, legsY[1]], [X0, legsY[2]],
    [X1, legsY[2]], [X1, legsY[3]], [X0, legsY[3]], [X0, 16], [40, 12]];
  const boss = { x: 48, y: 12, r: 5 };
  const xs = [20, 33, 46, 59, 72];
  const spots = [];
  for (let leg = 0; leg < 4; leg++) {
    const order = leg % 2 ? xs.slice().reverse() : xs;
    order.forEach((x, j) => {
      const side = (j % 2 ? 1 : -1) * (leg % 2 ? -1 : 1);
      spots.push({ x, y: legsY[leg] + side * 8, r: 4.5, roadY: legsY[leg] });
    });
  }
  const roads = [path, ...spots.map(s => [[s.x, s.roadY], [s.x, s.y]])];
  const M = _aeOpenMap({
    seed: 2026 * 1337 + 900 + armIdx, w: AE_ARM_W, h: AE_ARM_H, spawn: spawnT, spots, boss, roads,
    groves: 90, ponds: dir === 'top' ? 4 : 10,
    rockShare: { left: 0.15, top: 0.75, bottom: 0.8, right: 0.6 }[dir] || 0.3,
  });
  const rng = M.rng;
  const rooms = [], enemyList = [], spotInfo = [];
  let eid = 0;

  spots.forEach((sp, k) => {
    const lo = Math.min(N - 1, 1 + Math.floor(k * (N - 2) / (AE_ARM_SPOTS - 1)));
    const hi = Math.min(N - 1, lo + 2);
    // Один вид на кучку — как одна комната раньше: так кучки и различают.
    const pool = bandForLocalLevel(fe, lo).pool;
    const d = _enemyByEid.get(pool[Math.floor(rng() * pool.length)]);
    rooms.push(M.spotRoom(sp, { isSmall: false, arm: dir, localLvl: lo, monsterLvl: off + lo, isBoss: false, isWorldSpot: true, spot: 'k' + k }));
    spotInfo.push({ id: 'k' + k, name: `${off + lo}–${off + hi}`, lvl: [off + lo, off + hi], x: sp.x * TILE + TILE / 2, y: sp.y * TILE + TILE / 2, r: sp.r * TILE });
    if (!d) return;
    const n = 10 + Math.floor(rng() * 6);
    const tiles = M.spotTiles(sp, n);
    const pack = [];
    tiles.forEach(({ gx, gy }) => {
      const localLvl = lo + Math.floor(rng() * (hi - lo + 1));
      const mLvl = off + localLvl;
      const stats = monsterStatsAtLevel(mLvl, d.eType);
      const spdMult = mLvl > 20 ? 1.5 : 1;
      const ex = gx * TILE + TILE / 2, ey = gy * TILE + TILE / 2;
      pack.push({
        id: `e_${dir}_${eid++}`, ...d, isBoss: false, arm: dir, spot: 'k' + k,
        rlvl: mLvl,
        name: monsterNameAtLevel(d.name, localLvl, false, d.fem, N - 1),
        color: monsterColorAtLevel(d.color, d.endColor, localLvl, false, N - 1),
        maxHp: Math.floor(stats.hp * 0.5), hp: Math.floor(stats.hp * 0.5),
        atk: Math.floor(stats.atk * 0.5), def: stats.def, spd: d.spd * spdMult,
        xp: xpAtLevel(mLvl), gold: goldAtLevel(mLvl),
        x: ex, y: ey, spawnX: ex, spawnY: ey,
        atkTimer: 1 + rng(), aggro: false, aggroR: 175 + rng() * 55,
      });
    });
    // Удар по одному будит кучку (Room.js, _wakePack) — как в «Пепельном
    // крае», где на шум сбегается весь спот.
    const ids = pack.map(e => e.id);
    pack.forEach(e => { e.packMateIds = ids.filter(id => id !== e.id); });
    enemyList.push(...pack);
  });

  // Босс — на площади в конце дороги, с прежними правилами боссов коридора.
  const bd = _enemyByEid.get(fe.boss);
  if (bd) {
    const mLvl = off + N;
    const stats = monsterStatsAtLevel(mLvl, 'boss');
    const isLvl20Boss = mLvl === 20;
    const bx = boss.x * TILE + TILE / 2, by = boss.y * TILE + TILE / 2;
    rooms.push(M.spotRoom(boss, { isSmall: false, arm: dir, localLvl: N, monsterLvl: mLvl, isBoss: true, isWorldSpot: true, spot: 'boss' }));
    spotInfo.push({ id: 'boss', name: 'boss', lvl: [mLvl, mLvl], x: bx, y: by, r: boss.r * TILE, boss: true });
    enemyList.push({
      id: `e_${dir}_${eid++}`, ...bd, isBoss: true, arm: dir, spot: 'boss',
      rlvl: mLvl,
      name: monsterNameAtLevel(bd.name, N, true, bd.fem, N - 1),
      color: monsterColorAtLevel(bd.color, bd.endColor, N, true, N - 1),
      maxHp: Math.floor(stats.hp * (isLvl20Boss ? 10 : 1)), hp: Math.floor(stats.hp * (isLvl20Boss ? 10 : 1)),
      atk: stats.atk, def: stats.def, spd: bd.spd * (mLvl > 20 || isLvl20Boss ? 1.5 : 1),
      xp: xpAtLevel(mLvl), gold: goldAtLevel(mLvl),
      x: bx, y: by, spawnX: bx, spawnY: by,
      atkTimer: 1 + rng(), aggro: false, aggroR: 175 + rng() * 55,
    });
  }

  return {
    grid: M.grid, rooms, w: M.w, h: M.h,
    spawn: { x: spawnT.x * TILE + TILE / 2, y: spawnT.y * TILE + TILE / 2 },
    returnPad: { x: X0 * TILE + TILE / 2, y: 128 * TILE + TILE / 2 },
    corridorGates: [],
    aeMap: { biome: AE_ARM_BIOME[dir], name: AE_ARM_NAME[dir], terrain: M.rle, spots: spotInfo },
    enemies: enemyList,
  };
}

// Фарм-зона на открытой местности: четыре спота по углам, дороги от входа в
// центре к каждому, возврат на севере, пад в сезонное крыло на юге. Кто и
// сколько стоит на споте, решает вызывающий (makeEnemy) — виды, уровни и
// метки зон остаются его, а не этой раскладки.
const AE_FARM = 64;
// spots: 4 — зона (2×2 вокруг входа), 8 — сезонное крыло (2 ряда по 4,
// карта шире, дорога вдоль середины и отвод к каждому споту).
function _aeFarmLayout(seed, biome, rockShare, nSpots) {
  const wide = nSpots === 8;
  const w = wide ? 104 : AE_FARM, h = AE_FARM, cx = w / 2, cy = h / 2;
  const spots = wide
    ? [14, 38, 66, 90].flatMap(x => [{ x, y: 16, r: 8 }, { x, y: 48, r: 8 }])
    : [{ x: 16, y: 16, r: 8 }, { x: 48, y: 16, r: 8 }, { x: 16, y: 48, r: 8 }, { x: 48, y: 48, r: 8 }];
  const roads = wide
    ? [[[cx, 6], [cx, h - 6]], [[8, cy], [w - 8, cy]], ...spots.map(s => [[s.x, cy], [s.x, s.y]])]
    : [[[cx, 6], [cx, h - 6]], ...spots.map(s => [[cx, s.y], [s.x, s.y]])];
  const M = _aeOpenMap({ seed, w, h, spawn: { x: cx, y: cy }, spots, roads, groves: wide ? 40 : 26, ponds: wide ? 5 : 3, rockShare,
    keep: [{ x: cx, y: 8, r: 3 }, { x: cx, y: h - 9, r: 3 }] });
  return { M, spots, cx, cy, biome };
}
function _aeFarmZone(o) {
  const { M, spots, cx, cy } = _aeFarmLayout(o.seed, o.biome, o.rockShare, o.spots || 4);
  const rng = M.rng;
  const rooms = [], enemyList = [], spotInfo = [];
  let eid = 0;
  spots.forEach((sp, ri) => {
    rooms.push(M.spotRoom(sp, o.roomExtra));
    spotInfo.push({ id: 's' + ri, name: o.spotName, lvl: o.lvl, x: sp.x * TILE + TILE / 2, y: sp.y * TILE + TILE / 2, r: sp.r * TILE });
    M.spotTiles(sp, o.perSpot).forEach(({ gx, gy }) => {
      const e = o.makeEnemy(rng, `${o.prefix}_${ri}_${eid++}`, gx * TILE + TILE / 2, gy * TILE + TILE / 2);
      if (e) enemyList.push(e);
    });
  });
  return {
    grid: M.grid, rooms, w: M.w, h: M.h,
    spawn: { x: cx * TILE + TILE / 2, y: cy * TILE + TILE / 2 },
    returnPad: { x: cx * TILE + TILE / 2, y: 8 * TILE + TILE / 2 },
    seasonPadAt: { x: cx * TILE + TILE / 2, y: (AE_FARM - 9) * TILE + TILE / 2 },
    aeMap: { biome: o.biome, name: o.mapName, terrain: M.rle, spots: spotInfo },
    enemies: enemyList,
  };
}

// Монстр фарм-зоны — тот же, что ставили её комнаты: вид, полоса уровней,
// половинение, шкала ранга и метки зоны (по меткам считаются дроп и опыт).
function _farmMob(o) {
  return (rng, id, ex, ey) => {
    const d = _enemyByEid.get(o.species[Math.floor(rng() * o.species.length)]);
    if (!d) return null;
    const lvl = o.lvlMin + Math.floor(rng() * (o.lvlMax - o.lvlMin + 1));
    const stats = monsterStatsAtLevel(lvl, d.eType);
    const localLvl = lvl - o.localBase;
    return {
      id, ...d, isBoss: false, arm: o.arm, ...o.flags,
      rlvl: lvl,
      name: monsterNameAtLevel(d.name, localLvl, false, d.fem, o.maxLocalLvl),
      color: monsterColorAtLevel(d.color, d.endColor, localLvl, false, o.maxLocalLvl),
      maxHp: Math.floor(stats.hp * 0.5), hp: Math.floor(stats.hp * 0.5),
      atk: Math.floor(stats.atk * 0.5), def: stats.def, spd: d.spd,
      xp: xpAtLevel(lvl) * o.xpMult, gold: goldAtLevel(lvl),
      x: ex, y: ey, spawnX: ex, spawnY: ey,
      atkTimer: 1 + rng(),
      // Сами не бросаются (Room.js исключает фарм-зоны из самоагра), но
      // отвечают на удар; aggroR — поводок отхода.
      aggro: false, aggroR: 175 + rng() * 55,
    };
  };
}
const _FARM1 = () => ({ species: FARM_SPECIES, lvlMin: FARM_LVL_MIN, lvlMax: FARM_LVL_MAX, localBase: ARM_OFFSETS[1],
  maxLocalLvl: roomsInArm(2) - 1, xpMult: FARM_XP_MULT, arm: 'farmZone', flags: { farmZone: true } });
const _FARM2 = () => ({ species: FARM_HIGH_SPECIES, lvlMin: FARM_HIGH_LVL_MIN, lvlMax: FARM_HIGH_LVL_MAX, localBase: FARM_HIGH_LVL_MIN - 1,
  maxLocalLvl: FARM_HIGH_LVL_MAX - FARM_HIGH_LVL_MIN + 1, xpMult: FARM_HIGH_XP_MULT, arm: 'farmHigh', flags: { farmHigh: true } });

function generateFarmZone() {
  const z = _aeFarmZone({
    seed: 2026 * 1337 + 777 + 600, biome: 'frozen', rockShare: 0.5, mapName: 'Фарм-зона', prefix: 'farm',
    perSpot: FARM_MOBS_PER_ROOM, lvl: [FARM_LVL_MIN, FARM_LVL_MAX], spotName: `${FARM_LVL_MIN}–${FARM_LVL_MAX}`,
    roomExtra: { isFarmZone: true, monsterLvl: Math.round((FARM_LVL_MIN + FARM_LVL_MAX) / 2), arm: 'farmZone' },
    makeEnemy: _farmMob(_FARM1()),
  });
  // Пад в сезонное крыло — единственная дверь в него; пускает сервер
  // (resolveFloor/TICKET_ONLY), клиент лишь рисует замок.
  const seasonPad = { ...z.seasonPadAt, req: FARM_ENTRY_LEVEL, requiresTicket: true };
  delete z.seasonPadAt;
  return { ...z, seasonPad, farmZone: { bounds: { x0: 0, y0: 0, x1: z.w, y1: z.h }, minLevel: FARM_ENTRY_LEVEL } };
}

// Сезонное крыло Фарм-зоны — свой этаж за билетом, восемь спотов (2 ряда по
// 4), на каждом столько же монстров, сколько на споте самой зоны.
function generateFarmSeason() {
  const z = _aeFarmZone({
    seed: 2026 * 1337 + 777 + 602, biome: 'swamp', rockShare: 0.2, mapName: 'Сезонное крыло', prefix: 'farmsz', spots: 8,
    perSpot: FARM_MOBS_PER_ROOM, lvl: [FARM_LVL_MIN, FARM_LVL_MAX], spotName: `${FARM_LVL_MIN}–${FARM_LVL_MAX}`,
    roomExtra: { isFarmZone: true, monsterLvl: Math.round((FARM_LVL_MIN + FARM_LVL_MAX) / 2), arm: 'farmZone' },
    makeEnemy: _farmMob(_FARM1()),
  });
  delete z.seasonPadAt;
  // Возврат — назад в зону, а не в хаб.
  z.returnPad = { ...z.returnPad, target: 'farmZone' };
  return { ...z, farmZone: { bounds: { x0: 0, y0: 0, x1: z.w, y1: z.h }, minLevel: FARM_ENTRY_LEVEL, seasonWing: true } };
}

function generateFarmHigh() {
  const z = _aeFarmZone({
    seed: 2026 * 1337 + 777 + 601, biome: 'grave', rockShare: 0.4, mapName: 'Фарм зона 2', prefix: 'farmhi',
    perSpot: FARM_HIGH_MOBS_PER_ROOM, lvl: [FARM_HIGH_LVL_MIN, FARM_HIGH_LVL_MAX], spotName: `${FARM_HIGH_LVL_MIN}–${FARM_HIGH_LVL_MAX}`,
    roomExtra: { isFarmHigh: true, monsterLvl: Math.round((FARM_HIGH_LVL_MIN + FARM_HIGH_LVL_MAX) / 2), arm: 'farmHigh' },
    makeEnemy: _farmMob(_FARM2()),
  });
  const seasonPad = { ...z.seasonPadAt, req: FARM_HIGH_ENTRY_LEVEL, requiresTicket: true, target: 'farmHighSeason' };
  delete z.seasonPadAt;
  return { ...z, seasonPad, farmHigh: { bounds: { x0: 0, y0: 0, x1: z.w, y1: z.h }, minLevel: FARM_HIGH_ENTRY_LEVEL } };
}

function generateFarmHighSeason() {
  const z = _aeFarmZone({
    seed: 2026 * 1337 + 777 + 603, biome: 'wastes', rockShare: 0.8, mapName: 'Сезонное крыло 2', prefix: 'farmhs', spots: 8,
    perSpot: FARM_HIGH_MOBS_PER_ROOM, lvl: [FARM_HIGH_LVL_MIN, FARM_HIGH_LVL_MAX], spotName: `${FARM_HIGH_LVL_MIN}–${FARM_HIGH_LVL_MAX}`,
    roomExtra: { isFarmHigh: true, monsterLvl: Math.round((FARM_HIGH_LVL_MIN + FARM_HIGH_LVL_MAX) / 2), arm: 'farmHigh' },
    makeEnemy: _farmMob(_FARM2()),
  });
  delete z.seasonPadAt;
  z.returnPad = { ...z.returnPad, target: 'farmHigh' };
  return { ...z, farmHigh: { bounds: { x0: 0, y0: 0, x1: z.w, y1: z.h }, minLevel: FARM_HIGH_ENTRY_LEVEL, seasonWing: true } };
}

module.exports = {
  generateHub, generateArm, generateOpenArm, generateGuildWar, generateFarmZone, generateFarmSeason, generateFarmHighSeason, generateFarmHigh, generateWorld, generateFarmZone2, generateArena, generatePvpArena,
  generateRace10, generateFear, generateCoop, generateTournamentPit, generateTrial, generateDungeonHub, generateDungeonZone,
  TILE, WALL, FLOOR,
};
