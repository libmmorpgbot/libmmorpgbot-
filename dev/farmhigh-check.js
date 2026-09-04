#!/usr/bin/env node
'use strict';
// ── Фарм зона 2: свой телепорт, своя полоса, своя таблица дропа ─────────────
//
//   node dev/farmhigh-check.js
//
// Заказ на зону, дословно:
//
//   «сделай фарм зону 2, там будут 40-53 уровень монстры, с них будет падать
//    всё начиная от common до epic снаряжений, навыков всех абсолютно и
//    Либерти с шансом 0.1% и заточки обычные с шансом 0.05%
//    шансы на эпик снаряжение 0.0003% / рар 0.005% / анкомон 0.005% /
//    комон 0.005% / легендарный рецепт 0.001% / эпический рецепт 0.01%
//    книги первой профессии 0.0009% / книги второй профессии 0.0007%
//    расскидай дроп по разным монстрам в зоне»
//
// и — отдельным заходом, потому что первый раз это сделали не так:
//
//   «нужно было сделать отдельный телепорт в фарм зону 2, с 40 уровня»
//
// Поэтому здесь два рода утверждений. Первый — про саму зону. Второй, ничуть
// не менее важный, — КОНТРОЛЬНЫЙ: Элитная фарм-зона осталась той, какой была,
// и её ни полоса, ни виды, ни таблица дропа этой работой не задеты. Именно
// это и было сломано в прошлый раз.
//
// ── почему не миллион убийств ───────────────────────────────────────────────
// Самый редкий бросок здесь — 0.0003%, то есть примерно один на триста тысяч
// убийств. Монте-Карло на таких числах меряет не код, а собственный шум: чтобы
// отличить 0.0003% от 0.0004%, нужны десятки миллионов прогонов, и всё равно
// останется ощутимый разброс.
//
// Поэтому порог проверяется НАПРЯМУЮ. Math.random() подменяется постоянным
// значением: чуть ниже ставки — бросок обязан сработать, чуть выше — обязан не
// сработать. Это ровно то же утверждение, которое хотел бы проверить замер,
// только точное и мгновенное. Само распределение бросков — забота Math.random,
// а не этого файла.

const {
  FARM_HIGH_LVL_MIN, FARM_HIGH_LVL_MAX, FARM_HIGH_ENTRY_LEVEL, FARM_HIGH_SPECIES,
  FARM_HIGH_MOBS_PER_ROOM, FARM_HIGH_XP_MULT,
  FARM_HIGH_GEAR_CHANCE, FARM_HIGH_LIBERTY_CHANCE, FARM_HIGH_NORM_STONE_CHANCE,
  FARM_HIGH_EPIC_RECIPE_CHANCE, FARM_HIGH_LEGENDARY_RECIPE_CHANCE,
  FARM_HIGH_SKILL_BOOK_CHANCE, FARM_HIGH_ADV_SKILL_BOOK_CHANCE, FARM_HIGH_PASSIVE_BOOK_CHANCE,
  FARM_HIGH_SPECIES_GEAR_SLOTS, FARM_HIGH_SPECIES_SKILL_BOOKS, FARM_HIGH_SPECIES_ADV_BOOKS,
  FARM_HIGH_SPECIES_PASSIVE_BOOKS,
  FARM_SPECIES, FARM_LVL_MIN, FARM_LVL_MAX, FARM_ENTRY_LEVEL,
  FARM2_LVL_MIN, FARM2_LVL_MAX, FARM2_SPECIES, FARM2_ENTRY_LEVEL, FARM2_LIBERTY_CHANCE,
  FLOOR_ENEMIES, ENEMY_DEF, ITEM_DEF, CRAFT_MATS, armIndexForLevel,
} = require('../shared/definitions');
const loot = require('../server/game/loot');
const { generateFarmHigh, generateHub } = require('../server/game/dungeon');
const { FLOOR_IDS } = require('../server/game/floors');
const { STANDABLE, floorIdOf, resolveFloor } = require('../server/world');

let pass = 0, fail = 0; const failures = [];
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${extra ? ' — ' + extra : ''}`); }
}
const eq = (got, want, name) => ok(got === want, name, `отримано ${JSON.stringify(got)}, чекали ${JSON.stringify(want)}`);
const head = s => console.log(`\n  ── ${s} ──`);
const pct = v => +(v * 100).toFixed(7);

// Один бросок зоны при заданном значении Math.random(). Одно значение проходит
// через ВСЕ ворота сразу, поэтому за раз срабатывает не одна категория — но
// нам и нужно только «есть ли среди выпавшего вот эта».
function rollAt(eid, v) {
  const real = Math.random;
  Math.random = () => v;
  try { return loot._rollFarmHighLoot([], eid); } finally { Math.random = real; }
}
// Ставка проверяется с двух сторон: чуть ниже — обязано выпасть, чуть выше —
// обязано не выпасть. Односторонняя проверка зеленела бы и на «падает всегда».
function gateHolds(eid, chance, has) {
  return has(rollAt(eid, chance * 0.999)) && !has(rollAt(eid, chance * 1.001));
}
const hasId = id => g => g.some(x => x.id === id);
const hasGear = rarity => g => g.some(x => {
  const d = ITEM_DEF.find(i => i.id === x.id);
  return d && d.rarity === rarity && !d.unique;
});
const hasBook = field => g => g.some(x => {
  const m = CRAFT_MATS.find(c => c.id === x.id);
  return !!(m && m[field]);
});

console.log('\nfarmhigh-check');

// ════════════════════════════════════════════════════════════════════════════
head('отдельный телепорт, с 40 уровня');

// Зона — свой этаж, а не надстройка над чужим. Это и есть «отдельный».
ok(FLOOR_IDS.farmHigh != null, 'у зоны свой floor id');
ok(FLOOR_IDS.farmHigh !== FLOOR_IDS.farmZone2, 'и он НЕ этаж Элитной фарм-зоны');
ok(FLOOR_IDS.farmHigh !== FLOOR_IDS.farmZone, 'и не этаж обычной Фарм-зоны');
eq(floorIdOf('farmHigh'), FLOOR_IDS.farmHigh, 'клиент называет её по ключу farmHigh, сервер этот ключ знает');
ok(STANDABLE.has(FLOOR_IDS.farmHigh), 'на ней можно просто стоять — как в обычной Фарм-зоне, без лобби и без группы');

// Пад в хабе. Без него «отдельного телепорта» нет — есть только этаж, до
// которого нечем дойти.
const hub = generateHub();
ok(!!hub.farmHighEntry, 'в хабе есть свой вход в зону');
eq(hub.farmHighEntry && hub.farmHighEntry.req, 40, 'и его гейт — 40 уровень');
eq(FARM_HIGH_ENTRY_LEVEL, 40, 'вход в зону открывается с 40 уровня');
ok(hub.farmZoneEntry && hub.farmHighEntry !== hub.farmZoneEntry,
  'вход в первую Фарм-зону остался своим, отдельным');

// Гейт — серверный, а не совет клиенту.
eq(resolveFloor(FLOOR_IDS.farmHigh, { lvl: 39 }), FLOOR_IDS.hub, 'с 39 уровня сервер разворачивает в хаб');
eq(resolveFloor(FLOOR_IDS.farmHigh, { lvl: 40 }), FLOOR_IDS.farmHigh, 'с 40 — пускает');
eq(resolveFloor(FLOOR_IDS.farmHigh, { lvl: 78 }), FLOOR_IDS.farmHigh, 'и выше тоже');

// ════════════════════════════════════════════════════════════════════════════
head('полоса и виды');

eq(FARM_HIGH_LVL_MIN, 40, 'нижняя граница зоны — 40');
eq(FARM_HIGH_LVL_MAX, 53, 'верхняя — 53');
const arm3 = FLOOR_ENEMIES[3].species.flatMap(sp => [`${sp}_guard`, `${sp}_warrior`]);
eq(FARM_HIGH_SPECIES.join(), arm3.join(), 'виды — рукава 3, того, в чью полосу 41-60 попадает зона');
ok(FARM_HIGH_SPECIES.join() !== FARM_SPECIES.join(),
  'и они отличаются от видов обычной Фарм-зоны — по монстрам две зоны различимы');
const known = new Set(ENEMY_DEF.map(e => e.eid));
eq(FARM_HIGH_SPECIES.filter(sp => !known.has(sp)).join(), '', 'каждый вид есть в бестиарии');

// ════════════════════════════════════════════════════════════════════════════
head('ставки — те, что заказаны');

eq(pct(FARM_HIGH_LIBERTY_CHANCE), 0.1, 'Liberty 0.1%');
eq(pct(FARM_HIGH_NORM_STONE_CHANCE), 0.05, 'камень обычной заточки 0.05%');
eq(pct(FARM_HIGH_GEAR_CHANCE.common), 0.005, 'снаряжение common 0.005%');
eq(pct(FARM_HIGH_GEAR_CHANCE.uncommon), 0.005, 'uncommon 0.005%');
eq(pct(FARM_HIGH_GEAR_CHANCE.rare), 0.005, 'rare 0.005%');
eq(pct(FARM_HIGH_GEAR_CHANCE.epic), 0.0003, 'epic 0.0003%');
eq(pct(FARM_HIGH_LEGENDARY_RECIPE_CHANCE), 0.001, 'легендарный рецепт 0.001%');
eq(pct(FARM_HIGH_EPIC_RECIPE_CHANCE), 0.01, 'эпический рецепт 0.01%');
eq(pct(FARM_HIGH_SKILL_BOOK_CHANCE), 0.0009, 'книги 1-й профессии 0.0009%');
eq(pct(FARM_HIGH_ADV_SKILL_BOOK_CHANCE), 0.0007, 'книги 2-й профессии 0.0007%');
eq(pct(FARM_HIGH_PASSIVE_BOOK_CHANCE), 0.0009, 'книги пассивок 0.0009%');
ok(FARM_HIGH_GEAR_CHANCE.legendary === undefined,
  'legendary в зоне не падает — потолок коридора 4 и крафта, а не фарма');

// ════════════════════════════════════════════════════════════════════════════
head('и бросок идёт ИМЕННО по ним');
// Ставки выше — это числа в каталоге. Ниже — то, по чему бросает сервер.

const sp0 = FARM_HIGH_SPECIES[0];
for (const rarity of Object.keys(FARM_HIGH_GEAR_CHANCE)) {
  ok(gateHolds(sp0, FARM_HIGH_GEAR_CHANCE[rarity], hasGear(rarity)),
    `снаряжение ${rarity} выпадает ровно на своём пороге`);
}
ok(gateHolds(sp0, FARM_HIGH_SKILL_BOOK_CHANCE, hasBook('skillKey')), 'книга 1-й профессии — на своём');
ok(gateHolds(sp0, FARM_HIGH_ADV_SKILL_BOOK_CHANCE, hasBook('advSkillKey')), 'книга 2-й профессии — на своём');
ok(gateHolds(sp0, FARM_HIGH_PASSIVE_BOOK_CHANCE, hasBook('passiveId')), 'книга пассивки — на своём');
ok(gateHolds(sp0, FARM_HIGH_NORM_STONE_CHANCE, hasId('norm_stone')), 'камень обычной заточки — на своём');
ok(gateHolds(sp0, FARM_HIGH_EPIC_RECIPE_CHANCE, hasId('rece')), 'эпический рецепт — на своём');
ok(gateHolds(sp0, FARM_HIGH_LEGENDARY_RECIPE_CHANCE, hasId('recl')), 'легендарный рецепт — на своём');

// Liberty здесь не бросается вовсе — это валюта, её начисляет обработчик
// убийства (server/handlers2/world.js). В таблице предметов её быть не должно.
ok(!rollAt(sp0, 0).some(x => x.id === 'nexum' || x.id === 'liberty'),
  'Liberty не лежит в предметной таблице — она валюта, её платит выплата за убийство');
// Уникального оружия зона не роняет: это остаётся исключением Элитной зоны,
// которая берётся только полной группой и под дневным лимитом.
ok(!rollAt(sp0, 0).some(x => (ITEM_DEF.find(d => d.id === x.id) || {}).unique),
  'уникального оружия в зоне нет — оно остаётся за Элитной');

// ════════════════════════════════════════════════════════════════════════════
head('«раскидай дроп по разным монстрам»');

// Пул делится, ставка — нет. Если бы делилась ставка, зона отдавала бы всё
// вшестеро реже заказанного.
const everyoneRolls = FARM_HIGH_SPECIES.every(sp => hasGear('epic')(rollAt(sp, FARM_HIGH_GEAR_CHANCE.epic * 0.999)));
ok(everyoneRolls, 'epic-снаряжение роняет КАЖДЫЙ вид зоны — делится набор, а не шанс');

const slotOf = id => (ITEM_DEF.find(d => d.id === id) || {}).slot;
const wrongSlot = [];
for (const sp of FARM_HIGH_SPECIES) {
  const mine = FARM_HIGH_SPECIES_GEAR_SLOTS[sp];
  for (const rarity of Object.keys(FARM_HIGH_GEAR_CHANCE)) {
    for (const g of rollAt(sp, FARM_HIGH_GEAR_CHANCE[rarity] * 0.999)) {
      const sl = slotOf(g.id);
      if (sl && !mine.includes(sl) && sl !== 'material') wrongSlot.push(`${sp} → ${g.id} (${sl})`);
    }
  }
}
eq(wrongSlot.length, 0,
  `каждый вид роняет снаряжение ТОЛЬКО своих слотов${wrongSlot.length ? ' (чужое: ' + wrongSlot.slice(0, 4).join(', ') + ')' : ''}`);

const tables = {
  'слоты снаряжения': FARM_HIGH_SPECIES_GEAR_SLOTS,
  'книги 1-й профессии': FARM_HIGH_SPECIES_SKILL_BOOKS,
  'книги 2-й профессии': FARM_HIGH_SPECIES_ADV_BOOKS,
  'книги пассивок': FARM_HIGH_SPECIES_PASSIVE_BOOKS,
};
for (const [name, tbl] of Object.entries(tables)) {
  const empty = FARM_HIGH_SPECIES.filter(sp => !(tbl[sp] || []).length);
  eq(empty.length, 0, `${name}: пустых наборов нет${empty.length ? ' (' + empty.join(', ') + ')' : ''}`);
  const flat = [].concat(...FARM_HIGH_SPECIES.map(sp => tbl[sp]));
  eq(flat.length, new Set(flat).size, `${name}: наборы не пересекаются`);
}

// Все 56 книг игры достижимы в зоне — «навыков всех абсолютно».
const allBooks = CRAFT_MATS.filter(m => m.skillKey || m.advSkillKey || m.passiveId);
const reachable = new Set([].concat(
  ...FARM_HIGH_SPECIES.map(sp => [].concat(
    FARM_HIGH_SPECIES_SKILL_BOOKS[sp], FARM_HIGH_SPECIES_ADV_BOOKS[sp], FARM_HIGH_SPECIES_PASSIVE_BOOKS[sp]))));
const missing = allBooks.filter(b => !reachable.has(b.id)).map(b => b.name);
eq(missing.length, 0,
  `все ${allBooks.length} книг игры достижимы в зоне${missing.length ? ' (нет: ' + missing.slice(0, 5).join(', ') + ')' : ''}`);

// И все слоты снаряжения тоже — иначе «от common до epic» было бы неправдой
// для той части набора, которую не роняет никто.
const allSlots = ['weapon', 'helmet', 'body', 'gloves', 'boots', 'ring', 'belt'];
const covered = new Set([].concat(...FARM_HIGH_SPECIES.map(sp => FARM_HIGH_SPECIES_GEAR_SLOTS[sp])));
eq(allSlots.filter(sl => !covered.has(sl)).join(), '', 'все семь слотов снаряжения кто-то да роняет');

// ════════════════════════════════════════════════════════════════════════════
head('зона строится и заселяется');

const zone = generateFarmHigh();
const ROOMS = 4; // 2x2, как в обычной Фарм-зоне
eq(zone.enemies.length, FARM_HIGH_MOBS_PER_ROOM * ROOMS,
  `${FARM_HIGH_MOBS_PER_ROOM} монстров в каждой из ${ROOMS} комнат`);
const outOfBand = zone.enemies.filter(e => e.rlvl < FARM_HIGH_LVL_MIN || e.rlvl > FARM_HIGH_LVL_MAX);
eq(outOfBand.length, 0, `все уровни в полосе ${FARM_HIGH_LVL_MIN}-${FARM_HIGH_LVL_MAX}`);
const spawned = new Set(zone.enemies.map(e => e.eid));
eq(FARM_HIGH_SPECIES.filter(sp => !spawned.has(sp)).join(), '', 'встречаются все шесть видов');
ok(zone.enemies.every(e => e.farmHigh === true && e.arm === 'farmHigh'),
  'каждый помечен как монстр зоны — иначе выплата пойдёт по коридорной таблице');
ok(zone.enemies.every(e => e.aggro === false && e.aggroR > 0),
  'сами не нападают, но поводок отхода у них обычный — как в первой Фарм-зоне');
ok(!!zone.returnPad, 'есть возвратный пад — выйти можно ногами, без камня');
eq(zone.farmHigh && zone.farmHigh.minLevel, FARM_HIGH_ENTRY_LEVEL, 'клиент получает границы зоны и её гейт');
ok(zone.enemies.every(e => e.xp === Math.round(e.xp)) && FARM_HIGH_XP_MULT === 3,
  'опыт зоны — тройной, как у первой Фарм-зоны');

// ── ранг не сбрасывается посреди зоны ──────────────────────────────────────
// Полоса 40-53 пересекает границу рукавов 2 и 3. Если считать ранг по рукаву,
// уровень 40 даёт местный 20 при потолке 19 («Запредельный»), а 41 — местный 1
// («Слабый»): подъём рушится ровно посреди зоны. Проверяется то, что видно, —
// подпись обязана расти вместе с уровнем.
ok(new Set([40, 41].map(l => armIndexForLevel(l))).size === 2,
  'контроль: полоса и правда пересекает границу рукавов — проверять есть что');
const rankByLvl = new Map();
zone.enemies.forEach(e => { if (!rankByLvl.has(e.rlvl)) rankByLvl.set(e.rlvl, e.name.split(' ')[0]); });
const lvls = [...rankByLvl.keys()].sort((a, b) => a - b);
const ranks = lvls.map(l => rankByLvl.get(l));
eq(new Set(ranks).size, ranks.length,
  `ранг у каждого уровня свой, без повторов и сброса (${ranks[0]} → ${ranks[ranks.length - 1]})`);

// ════════════════════════════════════════════════════════════════════════════
head('КОНТРОЛЬ: соседние зоны не задеты');
// В прошлый раз всё это положили ПОВЕРХ Элитной фарм-зоны и сдвинули её
// полосу. Здесь и проверяется, что теперь она осталась собой.

eq(FARM2_LVL_MIN, 30, 'Элитная фарм-зона: нижняя граница снова 30');
eq(FARM2_LVL_MAX, 40, 'Элитная фарм-зона: верхняя снова 40');
eq(FARM2_SPECIES.join(), FARM_SPECIES.join(),
  'Элитная снова стоит на видах рукава 2, как и была');
eq(FARM2_ENTRY_LEVEL, 25, 'её вход остался на 25 — и он через лобби группы, а не через пад');
eq(pct(FARM2_LIBERTY_CHANCE), 0.3, 'её Liberty снова 0.3% — число владельца');
eq(FARM_LVL_MIN, 21, 'обычная Фарм-зона: полоса не тронута (низ)');
eq(FARM_LVL_MAX, 30, 'обычная Фарм-зона: полоса не тронута (верх)');
eq(FARM_ENTRY_LEVEL, 20, 'и её вход остался на 20');

console.log(`\n  ${pass} пройшло, ${fail} впало`);
if (failures.length) console.log('  впали: ' + failures.join(' · '));
process.exit(fail ? 1 : 0);
