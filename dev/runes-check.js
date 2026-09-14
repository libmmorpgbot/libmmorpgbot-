#!/usr/bin/env node
'use strict';
// ── Руны: таблицы, броски, гнёзда и то, что они реально дают ────────────────
//
//   node dev/runes-check.js
//
// Руна — первая вещь с собственным содержимым у каждого экземпляра, и почти
// всё в ней — числа из задания владельца. Поэтому половина этой проверки
// буквально переписывает задание в код и сверяет с таблицами: «синий на
// редкой руне даёт +13%» — это не деталь реализации, а обещание игроку.
//
// Вторая половина — что обещанное ДОХОДИТ ДО БОЯ. Характеристики считает
// repos/stats.js, его compute() чистая, и здесь она зовётся по-настоящему: с
// надетым предметом, в котором стоит руна. Ровно тем же способом проверяются
// бафы навыков (dev/skillbuff-check.js) и по той же причине — прибавка,
// которую видно в панели и не видно в формуле, прибавкой не является.
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ROOT = path.join(__dirname, '..');

// repos/stats.js тянет пул Postgres ради одной чистой функции. Заглушка
// 'pg' — чтобы проверка оставалась в группе PURE и запускалась без базы.
const _realRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'pg') return { Pool: class { on() {} connect() {} query() {} end() {} } };
  return _realRequire.apply(this, arguments);
};

const D = require(path.join(ROOT, 'shared/definitions'));
const stats = require(path.join(ROOT, 'server/db/repos/stats.js'));

let pass = 0, fail = 0;
const ok = (c, n, got) => {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + n); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m  ' + n + (got !== undefined ? ' — ' + got : '')); }
};
const eq = (a, b, n) => ok(a === b, n, `ожидал ${JSON.stringify(b)}, получил ${JSON.stringify(a)}`);
const near = (a, b, n) => ok(Math.abs(a - b) < 1e-9, n, `ожидал ${b}, получил ${a}`);

// ── 1. таблица процентов — дословно из задания ─────────────────────────────
console.log('\n  ── проценты по редкости и цвету ──');
{
  const spec = {
    common:    { grey: 1,  green: 2,  blue: 3,  purple: 4,  orange: 5  },
    uncommon:  { grey: 6,  green: 7,  blue: 8,  purple: 9,  orange: 10 },
    rare:      { grey: 11, green: 12, blue: 13, purple: 14, orange: 15 },
    epic:      { grey: 16, green: 17, blue: 18, purple: 19, orange: 20 },
    legendary: { green: 25, blue: 30, purple: 40, orange: 50 },
  };
  for (const [rarity, row] of Object.entries(spec)) {
    for (const [q, want] of Object.entries(row)) {
      eq(D.runeStatPct(rarity, q), want, `${rarity}/${q} = +${want}%`);
    }
  }
  eq(D.runeStatPct('legendary', 'grey'), 0, 'у легендарной руны серого цвета нет');
  ok(!D.runeQualityPool('legendary').includes('grey'), 'и в палитру он не попадает');
  eq(D.runeQualityPool('epic').length, 5, 'у эпической — все пять цветов');
}

// ── 2. сколько характеристик даёт редкость ─────────────────────────────────
console.log('\n  ── число характеристик ──');
{
  const want = { common: 1, uncommon: 2, rare: 3, epic: 4, legendary: 5 };
  for (const [rarity, n] of Object.entries(want)) {
    eq(D.RUNE_STAT_COUNT[rarity], n, `${rarity}: ${n}`);
  }
}

// ── 3. бросок ──────────────────────────────────────────────────────────────
console.log('\n  ── что выпадает ──');
{
  let bad = 0, dup = 0, greyOnLegendary = 0;
  for (let i = 0; i < 4000; i++) {
    for (const kind of ['armor', 'weapon']) {
      for (const rarity of D.RUNE_RARITIES) {
        const st = D.rollRuneStats(kind, rarity, Math.random);
        const pool = kind === 'weapon' ? D.RUNE_WEAPON_STATS : D.RUNE_ARMOR_STATS;
        const n = Math.min(pool.length, D.RUNE_STAT_COUNT[rarity]);
        if (st.length !== n) bad++;
        if (new Set(st.map(x => x.stat)).size !== st.length) dup++;
        if (st.some(x => !pool.includes(x.stat))) bad++;
        if (st.some(x => !D.runeQualityPool(rarity).includes(x.q))) bad++;
        if (rarity === 'legendary' && st.some(x => x.q === 'grey')) greyOnLegendary++;
      }
    }
  }
  eq(bad, 0, 'количество и состав характеристик всегда по таблице');
  eq(dup, 0, 'одна характеристика не выпадает дважды на одной руне');
  eq(greyOnLegendary, 0, 'серый на легендарной не выпадает никогда');
  // Легендарная оружейная берёт все пять — это и есть весь её пул.
  eq(D.rollRuneStats('weapon', 'legendary', Math.random).length, D.RUNE_WEAPON_STATS.length,
    'легендарная оружейная забирает весь набор оружейных характеристик');
}

// ── 4. сложение ────────────────────────────────────────────────────────────
console.log('\n  ── сумма по набору рун ──');
{
  const tot = D.runeBonusTotals([
    { itemId: 'rune_armor_epic', stats: [{ stat: 'hpPct', q: 'orange' }, { stat: 'defPct', q: 'grey' }] },
    { itemId: 'rune_armor_common', stats: [{ stat: 'hpPct', q: 'green' }] },
  ]);
  eq(tot.hpPct, 22, 'здоровье складывается из двух рун: 20 + 2');
  eq(tot.defPct, 16, 'защита — из одной');
  eq(tot.speedPct, undefined, 'то, чего не выпало, не появляется');
}

// ── 5. гнёзда и совместимость ──────────────────────────────────────────────
console.log('\n  ── гнёзда ──');
{
  for (const sl of ['helmet', 'body', 'gloves', 'boots', 'ring', 'belt']) {
    eq(D.runeSocketsOf(sl), 3, `${sl}: три гнезда`);
    eq(D.runeKindForSlot(sl), 'armor', `${sl} принимает руны доспеха`);
  }
  eq(D.runeSocketsOf('weapon'), 1, 'оружие: одно гнездо');
  eq(D.runeKindForSlot('weapon'), 'weapon', 'оружие принимает руны оружия');
  for (const sl of ['cloak', 'artifact', 'wings', 'pet', 'use']) {
    eq(D.runeSocketsOf(sl), 0, `${sl}: гнёзд нет`);
    eq(D.runeKindForSlot(sl), null, `${sl} рун не принимает`);
  }
}

// ── 6. каталог и картинки ──────────────────────────────────────────────────
console.log('\n  ── каталог и иконки ──');
{
  const runes = D.ITEM_DEF.filter(d => d.slot === 'rune');
  eq(runes.length, 10, 'десять рун: два вида на пять редкостей');
  ok(runes.every(r => r.noDrop), 'руны не падают с монстров');
  ok(!D.ENHANCEABLE_SLOTS.has('rune'), 'руны не затачиваются');
  ok(!D.isStackableItem({ slot: 'rune' }), 'и не стакаются — иначе две разные слились бы в одну');
  let missing = 0;
  for (const rarity of D.RUNE_RARITIES) {
    // Оружейная — одна картинка на редкость.
    const w = D.runeIconOf(D.runeCatalogId('weapon', rarity), []);
    if (!fs.existsSync(path.join(ROOT, w))) { missing++; console.log('      нет файла ' + w); }
    // Доспешная — своя на каждую из шести характеристик (три рисунка).
    for (const st of D.RUNE_ARMOR_STATS) {
      const a = D.runeIconOf(D.runeCatalogId('armor', rarity), [{ stat: st, q: 'grey' }]);
      if (!fs.existsSync(path.join(ROOT, a))) { missing++; console.log('      нет файла ' + a); }
    }
  }
  eq(missing, 0, 'у каждой руны есть файл иконки');
}

// ── 6б. руда: дроп, переплавка, цена руны ──────────────────────────────────
console.log('\n  ── руда ──');
{
  const ores = ['ore_common', 'ore_uncommon', 'ore_rare', 'ore_epic', 'ore_legendary'];
  for (const id of ores) {
    const m = D.CRAFT_MATS.find(x => x.id === id);
    ok(!!m, `${id} есть в каталоге материалов`);
    ok(m && D.isStackableItem(m), `${id} стакается — иначе 1000 штук это 1000 слотов`);
  }
  ok(!D.ITEM_DEF.some(d => String(d.id).startsWith('ore_')),
    'руда не снаряжение — в таблицу выпадения вещей не попадает');

  // Шанс: 0.1% на первом уровне, +0.01% за каждый следующий.
  near(D.oreDropChance(1), 0.001, 'уровень 1 — 0.1%');
  near(D.oreDropChance(2), 0.0011, 'уровень 2 — 0.11%');
  near(D.oreDropChance(30), 0.001 + 29 * 0.0001, 'уровень 30 — 0.39%');
  near(D.oreDropChance(78), 0.001 + 77 * 0.0001, 'уровень 78 — 0.87%');
  near(D.oreDropChance(0), 0.001, 'нулевой уровень не уводит шанс ниже базового');

  // Лесенка переплавки: 10 к 1, половина попыток впустую.
  const ladder = D.MAT_UPGRADE_RECIPES.filter(r => String(r.from).startsWith('ore_'));
  eq(ladder.length, 4, 'четыре ступени переплавки');
  for (const step of ladder) {
    eq(step.count, 10, `${step.from} → ${step.to}: десять к одному`);
    eq(step.chance, 0.50, `${step.from} → ${step.to}: шанс 50%`);
  }
  eq(ladder.map(r => r.to).join(','), 'ore_uncommon,ore_rare,ore_epic,ore_legendary',
    'ступени идут подряд по редкостям');

  // Цена руны — руда своей редкости, и только она.
  for (const rec of D.RUNE_CRAFT_RECIPES) {
    eq(rec.nexumCost, 0, `${rec.kind}/${rec.rarity}: Liberty за ковку не берётся`);
    eq(rec.mats.length, 1, `${rec.kind}/${rec.rarity}: ровно один материал`);
    eq(rec.mats[0].id, D.RUNE_ORE_OF[rec.rarity], `${rec.kind}/${rec.rarity}: руда своей редкости`);
    eq(rec.mats[0].n, rec.kind === 'armor' ? 1000 : 5000,
      `${rec.kind}/${rec.rarity}: ${rec.kind === 'armor' ? 1000 : 5000} руды`);
    eq(rec.chance, 0.30, `${rec.kind}/${rec.rarity}: шанс ковки 30%`);
  }

  // Бросок руды стоит в общем пути награды, а не в каждой таблице по копии.
  const wSrc = fs.readFileSync(path.join(ROOT, 'server/handlers2/world.js'), 'utf8');
  const lootFn = wSrc.slice(wSrc.indexOf('function rollLoot(result)'),
    wSrc.indexOf('// ── what a clan point means'));
  ok(/rand\(\) < oreDropChance\(result\.rlvl\)/.test(lootFn),
    'руда бросается по уровню монстра');
  ok(lootFn.indexOf("result.arm === 'coop'") < lootFn.indexOf('oreDropChance'),
    'сотрудничество выходит раньше — у него добычи нет по построению');
  ok(lootFn.indexOf('_rollMobLoot') < lootFn.indexOf('oreDropChance'),
    'руда падает поверх любой из четырёх таблиц, а не внутри одной');
}

// ── 7. доходит ли до боя ───────────────────────────────────────────────────
// Зовётся НАСТОЯЩАЯ compute() из repos/stats.js — та, по которой сервер
// считает урон, здоровье и скорость атаки.
console.log('\n  ── руны в расчёте характеристик ──');
{
  const baseRow = () => ({
    char_class: 'lev', lvl: 1, xp: 0, hp: 100, codex: {}, buffs: {},
    upg_atk: 0, upg_def: 0, upg_hp: 0, upg_atk_speed: 0,
    upg_crit_chance: 0, upg_crit_power: 0, upg_hp_regen: 0,
    equipped: [], passives: {}, skill_levels: {}, adv_learned: {}, adv_active: {},
    clan_level: 0,
  });
  const bare = stats.compute(baseRow());

  // Эпическая руна доспеха: оранжевое здоровье (+20%) и серая защита (+16%).
  const row = baseRow();
  row.equipped = [{ id: 'hm1', slot: 'helmet', enhance: 0, runes: [
    { itemId: 'rune_armor_epic', stats: [{ stat: 'hpPct', q: 'orange' }, { stat: 'defPct', q: 'grey' }] },
  ] }];
  const withHelm = stats.compute(row);
  // Тот же шлем без рун — чтобы отделить вклад руны от вклада самого шлема.
  const row0 = baseRow();
  row0.equipped = [{ id: 'hm1', slot: 'helmet', enhance: 0, runes: [] }];
  const plain = stats.compute(row0);
  eq(withHelm.maxHp, Math.floor(plain.maxHp * 1.20), 'оранжевое здоровье на эпической руне = +20% HP');
  eq(withHelm.def, Math.floor(plain.def * 1.16), 'серая защита на эпической руне = +16% DEF');
  ok(withHelm.maxHp > plain.maxHp && plain.maxHp > bare.maxHp, 'и шлем, и руна считаются оба');

  // Оружейная руна: атака, скорость атаки долей от базовой класса, шанс крита.
  const wrow = baseRow();
  wrow.equipped = [{ id: 'sw1', slot: 'weapon', enhance: 0, runes: [
    { itemId: 'rune_weapon_rare', stats: [
      { stat: 'atkPct', q: 'orange' },        // +15%
      { stat: 'atkSpeedPct', q: 'grey' },     // +11% от базовой скорости класса
      { stat: 'critChancePct', q: 'blue' },   // +13 процентных пунктов
    ] },
  ] }];
  const wrow0 = baseRow();
  wrow0.equipped = [{ id: 'sw1', slot: 'weapon', enhance: 0, runes: [] }];
  const wr = stats.compute(wrow), w0 = stats.compute(wrow0);
  eq(wr.atk, Math.floor(w0.atk * 1.15), 'оранжевая атака на редкой руне = +15% ATK');
  near(wr.atkSpeed - w0.atkSpeed, D.CHAR_DEF.lev.atkSpeed * 0.11,
    'скорость атаки — доля от базовой скорости КЛАССА, а не плоская прибавка');
  near(wr.critChance - w0.critChance, 0.13, 'шанс крита +13 пунктов');

  // Шанс Liberty в силу не идёт — уезжает в путь награды отдельным числом.
  const nrow = baseRow();
  nrow.equipped = [{ id: 'sw1', slot: 'weapon', enhance: 0, runes: [
    { itemId: 'rune_weapon_legendary', stats: [{ stat: 'nexumPct', q: 'orange' }] },
  ] }];
  const nr = stats.compute(nrow);
  eq(nr.gearNexumPct, 50, 'оранжевый «Шанс Liberty» на легендарной = +50%');
  eq(nr.atk, w0.atk, 'и на атаку он не влияет');

  // Пустой предмет без поля runes не должен ронять расчёт: старые строки
  // (до миграции) приезжают именно такими.
  const orow = baseRow();
  orow.equipped = [{ id: 'hm1', slot: 'helmet', enhance: 0 }];
  ok(Number.isFinite(stats.compute(orow).maxHp), 'предмет без поля рун считается как раньше');
}

// ── 8. защиты в слое предметов ─────────────────────────────────────────────
// По тексту файла: это правила порядка, которые нельзя увидеть, запустив
// функцию без базы, — и ровно их «уборка кода» убирает первыми.
console.log('\n  ── защиты ──');
{
  const src = fs.readFileSync(path.join(ROOT, 'server/db/repos/items.js'), 'utf8');
  ok(/async function assertDestroyable\(db, rowId\) \{\s*\n\s*await assertNoRunes/.test(src),
    'продажа и разбор отказывают, пока руны в предмете');
  ok(/async function detachForListing[\s\S]{0,600}await assertNoRunes/.test(src),
    'и рынок тоже');
  const socketFilters = (src.match(/socket_of IS NULL/g) || []).length;
  ok(socketFilters >= 6, `руна в гнезде исключена из всех запросов инвентаря (${socketFilters} мест)`);
  ok(/INSERT INTO player_items \(player_id, container, item_id, enhance, qty, source, source_ref, rune\)/.test(src),
    'содержимое руны пишется единственной вставкой предметов');

  const stSrc = fs.readFileSync(path.join(ROOT, 'server/db/repos/stats.js'), 'utf8');
  ok(/LOAD_SQL_NO_RUNES/.test(stSrc) && /column_name = 'socket_of'/.test(stSrc),
    'до миграции характеристики грузятся прежним запросом, а не падают');
  const m = stSrc.match(/const LOAD_SQL = `([\s\S]*?)`;/);
  const stripped = m[1].replace(/,\n {15}-- Руны[\s\S]*?'\[\]'::json\)\)\)/, '))');
  ok(!/socket_of/.test(stripped), 'и в том запросе действительно нет колонок рун');

  const runeSrc = fs.readFileSync(path.join(ROOT, 'server/db/repos/runes.js'), 'utf8');
  ok(/crypto\.randomInt/.test(runeSrc), 'броски руны идут из crypto, а не из Math.random');
  // Порядок проверяется ВНУТРИ craftRune, а не по всему файлу: имена
  // встречаются и в списке импортов наверху, и сравнение позиций там
  // измеряло бы порядок require, а не порядок действий.
  const craftBody = runeSrc.slice(runeSrc.indexOf('async function craftRune'),
    runeSrc.indexOf('// ── перебор цвета'));
  ok(craftBody.indexOf('hasRoomFor') < craftBody.indexOf('money.spend'),
    'проверка места — до оплаты');
  ok(craftBody.indexOf('money.spend') < craftBody.indexOf('rollRuneStats'),
    'оплата — до броска: отказ после оплаты невозможен');
  ok(/if \(!took\.ok\) err\('no_mats'/.test(runeSrc),
    'расход материалов проверяется по полю ok, а не по самому объекту');

  const cliSrc = fs.readFileSync(path.join(ROOT, 'js/player.js'), 'utf8');
  ok(/if \(it\.rune\) item\.rune = it\.rune;/.test(cliSrc),
    'пересборка по каталогу не стирает содержимое руны');
  ok(/runeBonusTotals\(\[\]\.concat/.test(cliSrc), 'панель считает руны той же общей функцией');
}

console.log('');
console.log(fail === 0
  ? `  \x1b[32m${pass} прошло, 0 упало\x1b[0m\n`
  : `  \x1b[31m${pass} прошло, ${fail} упало\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
