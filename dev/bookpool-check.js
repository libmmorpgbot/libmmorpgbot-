#!/usr/bin/env node
'use strict';
// ── Какие книги вообще может уронить монстр ─────────────────────────────────
//
//   node dev/bookpool-check.js
//
// Жалоба: книги 2 профессии падают с обычных монстров подземелья, начиная с
// локации 21. Так и было. Пулы книг когда-то делились по зонам — базовые
// книги навыков и атакующие классовые пассивки в рукавах 1-2, продвинутые
// книги и защитные пассивки в рукавах 3-4. Половина каталога поэтому не
// существовала ниже 41 уровня: Тёмный панцирь не мог выпасть нигде, куда
// вообще мог дойти персонаж младше 41-го. Это починили, пустив пулы по
// СОБСТВЕННОМУ уровню монстра, — и заодно завели продвинутые книги в тот же
// цикл: четыре уровня из каждых восьми (5-8, 13-16, 21-24, ...) предлагали их
// с рядовых мобов.
//
// Книга 2 профессии — не коридорный дроп, а награда за отдельный путь. Её
// источники: Фарм-зона (свой набор у каждого вида, FARM_SPECIES_BOOKS),
// Элитная фарм-зона, крафт у кузнеца из 10 обычных книг и рынок.
//
// ── почему проверка на данных, а не на убийствах ────────────────────────────
// Сам дроп — один бросок примерно на сто тысяч убийств. Гонять их нечестно и
// незачем: единственное, что тут вообще можно проверить, — какой ПУЛ уровень
// предлагает. А это ровно та же функция, из которой бросает сервер
// (_rollMobLoot, server/game/loot.js) и которую печатает панель дропа на карте
// (_monsterDropBodyHtml, js/ui.js). Базы данных ей не нужно.

const {
  CRAFT_MATS, MAX_MONSTER_LEVEL, EMPOWER_LEVEL, FARM_SPECIES_BOOKS,
  levelSkillBookPool, levelClassPassivePool, levelUniversalPassivePool,
} = require('../shared/definitions');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`    PASS  ${name}`); }
  else { fail++; failures.push(name); console.log(`    FAIL  ${name}${extra ? '   ' + extra : ''}`); }
}
const eq = (got, want, name) => ok(got === want, name, `отримано ${JSON.stringify(got)}, чекали ${JSON.stringify(want)}`);

console.log('\n  ── пули книг з монстрів ──');

const mobBooks = CRAFT_MATS.filter(m => m.skillKey || m.passiveId);
const advBooks = CRAFT_MATS.filter(m => m.advSkillKey);
const poolAt = lvl => [
  ...levelSkillBookPool(lvl), ...levelClassPassivePool(lvl), ...levelUniversalPassivePool(lvl),
];

// ── обе половины подземелья ────────────────────────────────────────────────
const coverage = (lo, hi) => {
  const seen = new Set();
  for (let lvl = lo; lvl <= hi; lvl++) poolAt(lvl).forEach(b => seen.add(b.id));
  return mobBooks.filter(b => !seen.has(b.id)).map(b => b.name);
};
const earlyGap = coverage(1, 40);
const lateGap = coverage(41, MAX_MONSTER_LEVEL);
eq(earlyGap.length, 0, `кожна книга з мобів падає десь на рівнях 1-40${earlyGap.length ? ' (нема: ' + earlyGap.join(', ') + ')' : ''}`);
eq(lateGap.length, 0, `кожна книга з мобів падає десь на рівнях 41-${MAX_MONSTER_LEVEL}${lateGap.length ? ' (нема: ' + lateGap.join(', ') + ')' : ''}`);

// Названная в жалобе книга, на уровне, до которого жалующийся мог дойти.
const darkCarapace = mobBooks.find(b => b.id === 'book_pas_dkdef');
const dropsIt = [];
for (let lvl = 1; lvl <= EMPOWER_LEVEL; lvl++) if (poolAt(lvl).some(b => b === darkCarapace)) dropsIt.push(lvl);
ok(dropsIt.length > 0,
  `${darkCarapace ? darkCarapace.name : 'book_pas_dkdef'} падає нижче ${EMPOWER_LEVEL} рівня (рівні ${dropsIt.slice(0, 5).join(', ')}...)`,
  'не падає на жодному');

// ── сама жалоба: ни один коридорный уровень ────────────────────────────────
const advIds = new Set(advBooks.map(b => b.id));
const leaked = [];
for (let lvl = 1; lvl <= MAX_MONSTER_LEVEL; lvl++) {
  for (const b of poolAt(lvl)) if (advIds.has(b.id)) leaked.push(`${lvl}: ${b.name}`);
}
eq(leaked.length, 0,
  `ЖОДЕН рівень монстра не дає книгу 2 професії${leaked.length ? ' (протекло: ' + leaked.slice(0, 5).join(', ') + ')' : ''}`);

// ...и при этом они всё ещё достижимы.
const farmable = new Set([].concat(...Object.values(FARM_SPECIES_BOOKS)));
const unreachable = advBooks.filter(b => !farmable.has(b.id)).map(b => b.name);
eq(unreachable.length, 0,
  `кожна книга 2 професії падає у Фарм-зоні${unreachable.length ? ' (нема: ' + unreachable.join(', ') + ')' : ''}`);

// ── цикл, а не расширение ──────────────────────────────────────────────────
// Больший пул на убийство молча поделил бы шансы каждой книги: бросок берёт
// одну запись наугад, и лишняя запись в пуле — это чужой шанс, вычтенный из
// всех остальных без единой правки чисел.
const shapes = new Set();
for (let lvl = 1; lvl <= MAX_MONSTER_LEVEL; lvl++) {
  shapes.add([levelSkillBookPool(lvl).length, levelClassPassivePool(lvl).length,
    levelUniversalPassivePool(lvl).length].join('/'));
}
eq([...shapes].join(' '), '5/5/1', 'на кожному рівні 5 навичкових + 5 класових пасивок + 1 універсальна');

console.log(`\n  ${pass} пройшло, ${fail} впало`);
if (failures.length) console.log(`  впали: ${failures.join(', ')}`);
process.exit(fail ? 1 : 0);
