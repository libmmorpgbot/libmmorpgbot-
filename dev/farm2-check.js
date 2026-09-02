#!/usr/bin/env node
'use strict';
// ── Элитная фарм-зона: полоса, виды и что с кого падает ─────────────────────
//
//   node dev/farm2-check.js
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
// ── почему не миллион убийств ───────────────────────────────────────────────
// Самый редкий бросок здесь — 0.0003%, то есть примерно один на триста тысяч
// убийств. Монте-Карло на таких числах меряет не код, а собственный шум: чтобы
// отличить 0.0003% от 0.0004%, нужны десятки миллионов прогонов, и всё равно
// останется ощутимый разброс.
//
// Поэтому порог проверяется НАПРЯМУ. Math.random() подменяется постоянным
// значением: чуть ниже ставки — бросок обязан сработать, чуть выше — обязан не
// сработать. Это ровно то же утверждение, которое хотел бы проверить замер,
// только точное и мгновенное. Само распределение бросков — забота Math.random,
// а не этого файла.

const {
  FARM2_LVL_MIN, FARM2_LVL_MAX, FARM2_SPECIES, FARM2_MOBS_PER_ROOM, FARM2_ROOM_COUNT,
  FARM2_GEAR_CHANCE, FARM2_LIBERTY_CHANCE, FARM2_NORM_STONE_CHANCE,
  FARM2_EPIC_RECIPE_CHANCE, FARM2_LEGENDARY_RECIPE_CHANCE,
  FARM2_SKILL_BOOK_CHANCE, FARM2_ADV_SKILL_BOOK_CHANCE, FARM2_PASSIVE_BOOK_CHANCE,
  FARM2_SPECIES_GEAR_SLOTS, FARM2_SPECIES_SKILL_BOOKS, FARM2_SPECIES_ADV_BOOKS,
  FARM2_SPECIES_PASSIVE_BOOKS,
  FARM_SPECIES, FLOOR_ENEMIES, ENEMY_DEF, ITEM_DEF, CRAFT_MATS, armIndexForLevel,
} = require('../shared/definitions');
const loot = require('../server/game/loot');
const { generateFarmZone2 } = require('../server/game/dungeon');

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
  try { return loot._rollFarm2Loot([], eid); } finally { Math.random = real; }
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

console.log('\nfarm2-check');

// ════════════════════════════════════════════════════════════════════════════
head('полоса и виды');

eq(FARM2_LVL_MIN, 40, 'нижняя граница зоны — 40');
eq(FARM2_LVL_MAX, 53, 'верхняя — 53');
// КОНТРОЛЬ: старая полоса 30-40 целиком лежала в рукаве 2 и делила виды с
// обычной Фарм-зоной. Обе зоны выглядели одинаково — это и меняли.
ok(FARM2_SPECIES.join() !== FARM_SPECIES.join(),
  'виды Элитной зоны отличаются от видов обычной Фарм-зоны');
const arm3 = FLOOR_ENEMIES[3].species.flatMap(sp => [`${sp}_guard`, `${sp}_warrior`]);
eq(FARM2_SPECIES.join(), arm3.join(), 'и это виды рукава 3 — того, в чью полосу 41-60 попадает зона');
const known = new Set(ENEMY_DEF.map(e => e.eid));
eq(FARM2_SPECIES.filter(sp => !known.has(sp)).join(), '', 'каждый вид есть в бестиарии');

// ════════════════════════════════════════════════════════════════════════════
head('ставки — те, что заказаны');

eq(pct(FARM2_LIBERTY_CHANCE), 0.1, 'Liberty 0.1%');
eq(pct(FARM2_NORM_STONE_CHANCE), 0.05, 'камень обычной заточки 0.05%');
eq(pct(FARM2_GEAR_CHANCE.common), 0.005, 'снаряжение common 0.005%');
eq(pct(FARM2_GEAR_CHANCE.uncommon), 0.005, 'uncommon 0.005%');
eq(pct(FARM2_GEAR_CHANCE.rare), 0.005, 'rare 0.005%');
eq(pct(FARM2_GEAR_CHANCE.epic), 0.0003, 'epic 0.0003%');
eq(pct(FARM2_LEGENDARY_RECIPE_CHANCE), 0.001, 'легендарный рецепт 0.001%');
eq(pct(FARM2_EPIC_RECIPE_CHANCE), 0.01, 'эпический рецепт 0.01%');
eq(pct(FARM2_SKILL_BOOK_CHANCE), 0.0009, 'книги 1-й профессии 0.0009%');
eq(pct(FARM2_ADV_SKILL_BOOK_CHANCE), 0.0007, 'книги 2-й профессии 0.0007%');
eq(pct(FARM2_PASSIVE_BOOK_CHANCE), 0.0009, 'книги пассивок 0.0009%');
ok(FARM2_GEAR_CHANCE.legendary === undefined,
  'legendary в зоне не падает — потолок коридора 4 и крафта, а не фарма');

// ════════════════════════════════════════════════════════════════════════════
head('и бросок идёт ИМЕННО по ним');
// Ставки выше — это числа в каталоге. Ниже — то, по чему бросает сервер.

const sp0 = FARM2_SPECIES[0];
for (const rarity of Object.keys(FARM2_GEAR_CHANCE)) {
  ok(gateHolds(sp0, FARM2_GEAR_CHANCE[rarity], hasGear(rarity)),
    `снаряжение ${rarity} выпадает ровно на своём пороге`);
}
ok(gateHolds(sp0, FARM2_SKILL_BOOK_CHANCE, hasBook('skillKey')), 'книга 1-й профессии — на своём');
ok(gateHolds(sp0, FARM2_ADV_SKILL_BOOK_CHANCE, hasBook('advSkillKey')), 'книга 2-й профессии — на своём');
ok(gateHolds(sp0, FARM2_PASSIVE_BOOK_CHANCE, hasBook('passiveId')), 'книга пассивки — на своём');
ok(gateHolds(sp0, FARM2_NORM_STONE_CHANCE, hasId('norm_stone')), 'камень обычной заточки — на своём');
ok(gateHolds(sp0, FARM2_EPIC_RECIPE_CHANCE, hasId('rece')), 'эпический рецепт — на своём');
ok(gateHolds(sp0, FARM2_LEGENDARY_RECIPE_CHANCE, hasId('recl')), 'легендарный рецепт — на своём');

// Liberty здесь не бросается вовсе — это валюта, её начисляет обработчик
// убийства (server/handlers2/world.js). В таблице предметов её быть не должно.
ok(!rollAt(sp0, 0).some(x => x.id === 'nexum' || x.id === 'liberty'),
  'Liberty не лежит в предметной таблице — она валюта, её платит выплата за убийство');

// ════════════════════════════════════════════════════════════════════════════
head('«раскидай дроп по разным монстрам»');

// Пул делится, ставка — нет. Если бы делилась ставка, зона отдавала бы всё
// вшестеро реже заказанного.
const everyoneRolls = FARM2_SPECIES.every(sp => hasGear('epic')(rollAt(sp, FARM2_GEAR_CHANCE.epic * 0.999)));
ok(everyoneRolls, 'epic-снаряжение роняет КАЖДЫЙ вид зоны — делится набор, а не шанс');

const slotOf = id => (ITEM_DEF.find(d => d.id === id) || {}).slot;
let wrongSlot = [];
for (const sp of FARM2_SPECIES) {
  const mine = FARM2_SPECIES_GEAR_SLOTS[sp];
  for (const rarity of Object.keys(FARM2_GEAR_CHANCE)) {
    for (const g of rollAt(sp, FARM2_GEAR_CHANCE[rarity] * 0.999)) {
      const s = slotOf(g.id);
      if (s && !mine.includes(s) && s !== 'material') wrongSlot.push(`${sp} → ${g.id} (${s})`);
    }
  }
}
// Уникальное оружие делению не подлежит и падает со всех — его в счёт не берём.
wrongSlot = wrongSlot.filter(w => !/uq_/.test(w));
eq(wrongSlot.length, 0,
  `каждый вид роняет снаряжение ТОЛЬКО своих слотов${wrongSlot.length ? ' (чужое: ' + wrongSlot.slice(0, 4).join(', ') + ')' : ''}`);

const tables = {
  'слоты снаряжения': FARM2_SPECIES_GEAR_SLOTS,
  'книги 1-й профессии': FARM2_SPECIES_SKILL_BOOKS,
  'книги 2-й профессии': FARM2_SPECIES_ADV_BOOKS,
  'книги пассивок': FARM2_SPECIES_PASSIVE_BOOKS,
};
for (const [name, tbl] of Object.entries(tables)) {
  const empty = FARM2_SPECIES.filter(sp => !(tbl[sp] || []).length);
  eq(empty.length, 0, `${name}: пустых наборов нет${empty.length ? ' (' + empty.join(', ') + ')' : ''}`);
  const flat = [].concat(...FARM2_SPECIES.map(sp => tbl[sp]));
  eq(flat.length, new Set(flat).size, `${name}: наборы не пересекаются`);
}

// Все 56 книг игры достижимы в зоне — «навыков всех абсолютно».
const allBooks = CRAFT_MATS.filter(m => m.skillKey || m.advSkillKey || m.passiveId);
const reachable = new Set([].concat(
  ...FARM2_SPECIES.map(sp => [].concat(FARM2_SPECIES_SKILL_BOOKS[sp], FARM2_SPECIES_ADV_BOOKS[sp], FARM2_SPECIES_PASSIVE_BOOKS[sp]))));
const missing = allBooks.filter(b => !reachable.has(b.id)).map(b => b.name);
eq(missing.length, 0,
  `все ${allBooks.length} книг игры достижимы в зоне${missing.length ? ' (нет: ' + missing.slice(0, 5).join(', ') + ')' : ''}`);

// И все слоты снаряжения тоже — иначе «от common до epic» было бы неправдой
// для той части набора, которую не роняет никто.
const allSlots = ['weapon', 'helmet', 'body', 'gloves', 'boots', 'ring', 'belt'];
const covered = new Set([].concat(...FARM2_SPECIES.map(sp => FARM2_SPECIES_GEAR_SLOTS[sp])));
eq(allSlots.filter(s => !covered.has(s)).join(), '', 'все семь слотов снаряжения кто-то да роняет');

// ════════════════════════════════════════════════════════════════════════════
head('зона строится и заселяется');

const zone = generateFarmZone2();
eq(zone.enemies.length, FARM2_MOBS_PER_ROOM * FARM2_ROOM_COUNT,
  `${FARM2_MOBS_PER_ROOM} монстров в каждой из ${FARM2_ROOM_COUNT} комнат`);
const outOfBand = zone.enemies.filter(e => e.rlvl < FARM2_LVL_MIN || e.rlvl > FARM2_LVL_MAX);
eq(outOfBand.length, 0, `все уровни в полосе ${FARM2_LVL_MIN}-${FARM2_LVL_MAX}`);
const spawned = new Set(zone.enemies.map(e => e.eid));
eq(FARM2_SPECIES.filter(sp => !spawned.has(sp)).join(), '', 'встречаются все шесть видов');
ok(zone.enemies.every(e => e.farmZone2 === true && e.arm === 'farmZone2'),
  'каждый помечен как монстр зоны — иначе выплата пойдёт по коридорной таблице');

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

console.log(`\n  ${pass} пройшло, ${fail} впало`);
if (failures.length) console.log('  впали: ' + failures.join(' · '));
process.exit(fail ? 1 : 0);
