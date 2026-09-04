const {
  generateHub, generateArm, generateGuildWar, generateFarmZone, generateFarmSeason, generateFarmHigh, generateFarmZone2, generateArena, generatePvpArena,
  generateRace10, generateFear, generateCoop,
} = require('./dungeon');

// Every location the player can stand in is its own floor id + its own
// generator, replacing the single generateOpenWorld() mega-grid. The hub,
// the 4 leveling arms and every special zone (Guild War, Фарм-зона, the boss
// arena/Death Battle venue, the 3v3 arena, Кровавая Башня, Страх,
// Сотрудничество, Фарм зона 2 and Элитная фарм-зона) are each their own
// floor now.
const FLOOR_IDS = {
  hub: 1, left: 2, top: 3, bottom: 4, right: 5,
  guildWar: 6, farmZone: 7, arena: 8, pvpArena: 9, race10: 10, fear: 11, coop: 12,
  // Private per-run instance, same shape as fear/coop — see
  // server/index.js's _createFarm2Room. Registered here purely so
  // generateFarmZone2's geometry template exists and FLOOR_IDS.farmZone2
  // resolves; the boot-time shared Room _initFloorRooms creates for it is
  // never actually reachable — _doEnterLocation explicitly denies a direct,
  // non-force enterLocation onto this floor (see its own comment).
  farmZone2: 13,
  // Фарм зона 2 — обычный общий этаж, как farmZone: на него можно просто
  // войти с пада в хабе. Имя `farmHigh`, а не `farmZone2`, потому что то имя
  // занято Элитной зоной строкой выше — см. блок FARM_HIGH_* в
  // shared/definitions.js.
  farmHigh: 14,
  // Сезонное крыло Фарм-зоны — ещё 4 комнаты, вход только с сезонным билетом
  // (TICKET_ONLY, server/world.js). Свой этаж, потому что дверь в него должен
  // сторожить сервер, а барьеры внутри этажа здесь клиентские — разбор в
  // generateFarmSeason, server/game/dungeon.js.
  farmSeason: 15,
};

// armIdx (1-4) is the enemy-level/species-curve identity FLOOR_ENEMIES/
// ARM_OFFSETS already index by (shared/definitions.js) — kept distinct from
// the floor id so nothing there needs to change.
const FLOOR_REGISTRY = [
  { id: FLOOR_IDS.hub,      key: 'hub',      generate: () => generateHub() },
  { id: FLOOR_IDS.left,     key: 'left',     generate: () => generateArm('left', 1) },
  { id: FLOOR_IDS.top,      key: 'top',      generate: () => generateArm('top', 2) },
  { id: FLOOR_IDS.bottom,   key: 'bottom',   generate: () => generateArm('bottom', 3) },
  { id: FLOOR_IDS.right,    key: 'right',    generate: () => generateArm('right', 4) },
  { id: FLOOR_IDS.guildWar, key: 'guildWar', generate: () => generateGuildWar() },
  { id: FLOOR_IDS.farmZone, key: 'farmZone', generate: () => generateFarmZone() },
  { id: FLOOR_IDS.arena,    key: 'arena',    generate: () => generateArena() },
  { id: FLOOR_IDS.pvpArena, key: 'pvpArena', generate: () => generatePvpArena() },
  { id: FLOOR_IDS.race10,   key: 'race10',   generate: () => generateRace10() },
  { id: FLOOR_IDS.fear,     key: 'fear',     generate: () => generateFear() },
  { id: FLOOR_IDS.coop,     key: 'coop',     generate: () => generateCoop() },
  { id: FLOOR_IDS.farmZone2, key: 'farmZone2', generate: () => generateFarmZone2() },
  { id: FLOOR_IDS.farmHigh, key: 'farmHigh', generate: () => generateFarmHigh() },
  { id: FLOOR_IDS.farmSeason, key: 'farmSeason', generate: () => generateFarmSeason() },
];

const _byId = new Map(FLOOR_REGISTRY.map(f => [f.id, f]));

function floorEntry(floorId) { return _byId.get(floorId); }

module.exports = { FLOOR_IDS, FLOOR_REGISTRY, floorEntry };
