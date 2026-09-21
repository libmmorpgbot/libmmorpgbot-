const {
  generateHub, generateArm, generateGuildWar, generateFarmZone, generateFarmSeason, generateFarmHigh, generateFarmZone2, generateArena, generatePvpArena,
  generateRace10, generateFear, generateCoop, generateTournamentPit, generateTrial, generateDungeonHub, generateDungeonZone,
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
  // Турнир (32-player double elimination) — a private 1v1 pit per match, same
  // instanced-Room shape as fear/coop/farmZone2 below. See server/game/
  // dungeon.js's generateTournamentPit and server/game/tournament.js's
  // _createTournamentPitRoom for the bracket engine that deploys into it.
  tournament: 16,
  // "Опробовать персонажа" — a private, never-directly-standable sandbox
  // (same shape as farmZone2 above: registered here purely so this floor id
  // resolves and its geometry template exists; the shared Room booted for it
  // is never actually entered — trialEnter, server/handlers2/trial.js,
  // always builds its own private Room instead, exactly like Fear/coop do).
  trial: 17,
  // Подземелье — a new endgame teleport hall (see generateDungeonHub,
  // server/game/dungeon.js): an empty room with 7 pads, one per class, each
  // its own floor beyond it (dungeon<Class> below — generateDungeonZone).
  // Not to be confused with race10's "Кровавая Башня" above (FLOOR_IDS.
  // race10) — a different, older mode that just happens to share the
  // Russian word "Башня" in its own (unrelated) name.
  dungeon: 18,
  dungeonLev: 19, dungeonDeathknight: 20, dungeonRanger: 21, dungeonMage: 22,
  dungeonWarlock: 23, dungeonRunefighter: 24, dungeonAssassin: 25,
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
  { id: FLOOR_IDS.tournament, key: 'tournament', generate: () => generateTournamentPit() },
  { id: FLOOR_IDS.trial,     key: 'trial',     generate: () => generateTrial() },
  { id: FLOOR_IDS.dungeon,             key: 'dungeon',             generate: () => generateDungeonHub() },
  { id: FLOOR_IDS.dungeonLev,          key: 'dungeonLev',          generate: () => generateDungeonZone('lev', 0) },
  { id: FLOOR_IDS.dungeonDeathknight,  key: 'dungeonDeathknight',  generate: () => generateDungeonZone('deathknight', 1) },
  { id: FLOOR_IDS.dungeonRanger,       key: 'dungeonRanger',       generate: () => generateDungeonZone('ranger', 2) },
  { id: FLOOR_IDS.dungeonMage,         key: 'dungeonMage',         generate: () => generateDungeonZone('mage', 3) },
  { id: FLOOR_IDS.dungeonWarlock,      key: 'dungeonWarlock',      generate: () => generateDungeonZone('warlock', 4) },
  { id: FLOOR_IDS.dungeonRunefighter,  key: 'dungeonRunefighter',  generate: () => generateDungeonZone('runefighter', 5) },
  { id: FLOOR_IDS.dungeonAssassin,     key: 'dungeonAssassin',     generate: () => generateDungeonZone('assassin', 6) },
];

const _byId = new Map(FLOOR_REGISTRY.map(f => [f.id, f]));

function floorEntry(floorId) { return _byId.get(floorId); }

module.exports = { FLOOR_IDS, FLOOR_REGISTRY, floorEntry };
