#!/usr/bin/env node
'use strict';
// ── Мир: открытая локация со спотами и боссом ───────────────────────────────
//
//   node dev/world-check.js
//
// Заказ, дословно:
//
//   «Можем сделать локацию не как сейчас комнаты, а открытая локация, в разных
//    точках спавнятся монстры пачками, локация называется Мир, с 35 уровня,
//    монстры 40-59, сделай чтоб были споты разные как в ммoрпг играх, топ лоу
//    споты, так же спот где появляется босс 60 уровня»
//
// Каждое слово заказа — утверждение ниже: вход 35, полоса 40-59, пачки,
// ярусы low/mid/top, один босс 60 уровня. Плюс то, что заказ подразумевает:
// монстр не стоит в стене и не заперт в кармане, лоу-спот сам не нападает, а
// мид нападает, и убийство в Мире платит по таблице Фарм зоны 2, а не
// коридора.

const {
  WORLD_ENTRY_LEVEL, WORLD_LVL_MIN, WORLD_LVL_MAX, WORLD_BOSS_LEVEL, WORLD_SPOTS, WORLD_TIERS,
  WORLD_LIBERTY_CHANCE, FARM_HIGH_SPECIES, TILE, FLOOR, WALL,
} = require('../shared/definitions');
const { generateWorld, generateHub } = require('../server/game/dungeon');
const { FLOOR_IDS } = require('../server/game/floors');
const { resolveFloor } = require('../server/world');
const Room = require('../server/game/Room');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('\n── этаж и вход ──');
ok(FLOOR_IDS.openWorld != null, 'этаж openWorld зарегистрирован');
ok(WORLD_ENTRY_LEVEL === 35, 'вход с 35 уровня', WORLD_ENTRY_LEVEL);
ok(generateHub().worldEntry && generateHub().worldEntry.req === 35, 'в хабе есть пункт телепорта с гейтом 35');
ok(resolveFloor('openWorld', { lvl: 34 }) === FLOOR_IDS.hub, 'игрока 34 уровня сервер не пускает');
ok(resolveFloor('openWorld', { lvl: 35 }) === FLOOR_IDS.openWorld, 'игрока 35 уровня пускает');

const d = generateWorld();
console.log('\n── открытое поле, а не комнаты ──');
let floor = 0;
for (const row of d.grid) for (const c of row) if (c === FLOOR) floor++;
ok(floor / (d.w * d.h) > 0.6, 'больше 60% карты — проходимый пол', `${(floor / (d.w * d.h) * 100).toFixed(1)}%`);

// Заливка от входа: каждый монстр должен быть достижим пешком.
const sx = Math.floor(d.spawn.x / TILE), sy = Math.floor(d.spawn.y / TILE);
const seen = Array.from({ length: d.h }, () => new Uint8Array(d.w));
const stack = [[sx, sy]]; seen[sy][sx] = 1;
while (stack.length) {
  const [x, y] = stack.pop();
  for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
    if (nx < 0 || ny < 0 || nx >= d.w || ny >= d.h || seen[ny][nx] || d.grid[ny][nx] === WALL) continue;
    seen[ny][nx] = 1; stack.push([nx, ny]);
  }
}
const tileOf = e => [Math.floor(e.x / TILE), Math.floor(e.y / TILE)];
const unreachable = d.enemies.filter(e => { const [x, y] = tileOf(e); return !seen[y][x]; });
ok(unreachable.length === 0, 'каждый монстр стоит на полу, достижимом от входа', unreachable.map(e => e.id).slice(0, 5).join(','));

console.log('\n── споты и пачки ──');
const mobs = d.enemies.filter(e => !e.isBoss);
ok(mobs.every(e => e.rlvl >= WORLD_LVL_MIN && e.rlvl <= WORLD_LVL_MAX), 'все монстры 40-59');
ok(mobs.some(e => e.rlvl === WORLD_LVL_MIN) && mobs.some(e => e.rlvl === WORLD_LVL_MAX), 'полоса покрыта от 40 до 59');
for (const tier of ['low', 'mid', 'top']) {
  ok(WORLD_SPOTS.filter(s => s.tier === tier).length >= 2, `спотов яруса ${tier} не меньше двух`);
}
const lowMax = Math.max(...WORLD_SPOTS.filter(s => s.tier === 'low').map(s => s.lvl[1]));
const topMin = Math.min(...WORLD_SPOTS.filter(s => s.tier === 'top').map(s => s.lvl[0]));
ok(lowMax < topMin, 'лоу-споты слабее топ-спотов', `${lowMax} / ${topMin}`);
for (const sp of WORLD_SPOTS) {
  const here = mobs.filter(e => e.spot === sp.id);
  const want = sp.packs * WORLD_TIERS[sp.tier].packSize;
  ok(here.length === want, `${sp.name}: ${want} монстров`, here.length);
}
ok(mobs.every(e => e.packMateIds && e.packMateIds.length === WORLD_TIERS[WORLD_SPOTS.find(s => s.id === e.spot).tier].packSize - 1),
  'у каждого монстра есть сопачечники — удар будит пачку');
ok(mobs.every(e => FARM_HIGH_SPECIES.includes(e.eid)), 'виды — из Фарм зоны 2 (её деление дропа по видам работает)');
ok(mobs.every(e => e.passive === (e.spot && WORLD_SPOTS.find(s => s.id === e.spot).tier === 'low')), 'сами не нападают ровно лоу-споты');

console.log('\n── босс ──');
const bosses = d.enemies.filter(e => e.isBoss);
ok(bosses.length === 1, 'босс один', bosses.length);
ok(bosses[0] && bosses[0].rlvl === WORLD_BOSS_LEVEL && WORLD_BOSS_LEVEL === 60, 'босс 60 уровня');
ok(bosses[0] && bosses[0].arm === 'openWorld', 'босс на общем механизме таймера (arm openWorld)');

console.log('\n── живая комната ──');
const io = { to: () => ({ emit() {} }), emit() {}, sockets: { sockets: new Map() } };
function aggroAt(spotId) {
  const room = new Room(FLOOR_IDS.openWorld, io, {}, () => {});
  room.addPlayer('s1', 'probe', null, null, 0, '91', null);
  room.setPlayerChar('s1', 'deathknight');
  room.setPlayerStats('s1', { level: 40, atk: 120, def: 40, maxHp: 900000, critChance: 0, critPower: 1.5, atkSpeed: 1, hpRegen: 0, skillPct: 1 });
  room.setPlayerHp('s1', 900000);
  const p = room.players.get('s1');
  const pack = room.enemies.filter(e => e.spot === spotId);
  p.x = pack[0].x + 40; p.y = pack[0].y;
  for (let i = 0; i < 200; i++) { room._lastTick = Date.now() - 25; room._tick(); }
  return { room, n: pack.filter(e => e.aggro).length };
}
const low = aggroAt(WORLD_SPOTS.find(s => s.tier === 'low').id);
ok(low.n === 0, 'на лоу-споте рядом стоящий игрок никого не будит', low.n);
const mid = aggroAt(WORLD_SPOTS.find(s => s.tier === 'mid').id);
ok(mid.n > 0, 'на мид-споте пачка нападает сама', mid.n);
ok(mid.room.getBossStatus().openWorld && mid.room.getBossStatus().openWorld.alive === true, 'статус Владыки уходит клиенту');
const payload = mid.room.dungeonData;
ok(payload.openWorld && payload.openWorld.spots.length === WORLD_SPOTS.length + 1, 'клиент получает споты для подписей');

console.log('\n── награда ──');
const src = fs.readFileSync(path.join(__dirname, '../server/handlers2/world.js'), 'utf8');
ok(/result\.openWorld \? loot\._rollFarmHighLoot/.test(src), 'дроп Мира — таблица Фарм зоны 2');
ok(/result\.openWorld \? \(WORLD_LIBERTY_CHANCE/.test(src) && WORLD_LIBERTY_CHANCE > 0, 'Liberty в Мире падает');
const roomSrc = fs.readFileSync(path.join(__dirname, '../server/game/Room.js'), 'utf8');
ok((roomSrc.match(/openWorld: !!enemy\.openWorld/g) || []).length === 2, 'оба пути убийства несут флаг openWorld');

console.log('\n── монета удачи ──');
const D = require('../shared/definitions');
const coin = D.CRAFT_MATS.find(m => m.id === 'clover_coin');
ok(coin && coin.gem && coin.worldOnly, 'предмет есть, сдаётся в кодекс и помечен «только Мир»');
ok(Math.abs(D.WORLD_CLOVER_CHANCE - 0.00003) < 1e-12, 'шанс 0.003% за убийство', D.WORLD_CLOVER_CHANCE);
const cb = n => D.gemCodexBonusFor('clover_coin', n).atk;
ok(cb(29) === 0 && cb(30) === 40, '30 штук — +40 атаки', `${cb(29)} / ${cb(30)}`);
ok(cb(79) === 40 && cb(80) === 110, '80 штук — ещё +70', `${cb(79)} / ${cb(80)}`);
ok(cb(199) === 110 && cb(200) === 220, '200 штук — ещё +110', `${cb(199)} / ${cb(200)}`);
ok(D.gemCodexMax('clover_coin') === 200 && D.gemCodexMax('gem_jewel') === 500, 'потолок монеты 200, у самоцветов прежние 500');
ok(D.codexTotalBonus({ [D.GEM_CODEX_KEY]: { clover_coin: 9999 } }).atk === 220, 'сверх 200 не считается');
ok(/result\.openWorld && rand\(\) < \(WORLD_CLOVER_CHANCE/.test(src), 'бросок монеты — только для убийств в Мире');

console.log('\n── свитки и опыт ──');
ok(D.WORLD_XP_MULT === 10, 'опыт ×10', D.WORLD_XP_MULT);
ok(Math.abs(D.WORLD_SCROLL_CHANCE - 0.00003) < 1e-12, 'шанс свитка 0.003%');
const classes = Object.keys(D.CHAR_DEF);
const byTier = t => new Set(WORLD_SPOTS.filter(s => s.tier === t).flatMap(s => s.scrolls || []));
ok(WORLD_SPOTS.every(s => (s.scrolls || []).length > 0 && s.scrolls.every(c => D.CRAFT_MATS.some(m => m.id === `dungeon_scroll_${c}`))), 'у каждого спота есть свиток, и такой предмет существует');
ok(classes.every(c => byTier('low').has(c) || byTier('mid').has(c)), 'лоу + мид вместе дают все 7 классов');
ok(classes.every(c => byTier('top').has(c)), 'топ-споты вместе дают все 7 классов');
ok(WORLD_SPOTS.filter(s => s.tier !== 'top').every(s => s.scrolls.length === 1), 'на лоу и мид — по одному свитку на спот');
ok(/WORLD_SPOTS\.find\(x => x\.id === result\.spot\)/.test(src) && (roomSrc.match(/spot: enemy\.spot/g) || []).length === 2, 'спот доходит до броска свитка');

console.log('\n── сила монстров ──');
{
  const e = mobs.find(m => m.rlvl === 50);
  const st = D.monsterStatsAtLevel(50, e.eType);
  ok(e.maxHp === Math.floor(st.hp * 0.5 * 2) && e.atk === Math.floor(st.atk * 0.5 * 2) && e.def === Math.floor(st.def * 2),
    'здоровье, атака и защита обычных монстров ×2', `${e.maxHp}/${e.atk}/${e.def}`);
  const boss = d.enemies.find(x => x.isBoss), bs = D.monsterStatsAtLevel(60, 'boss');
  ok(boss.def === bs.def, 'Владыка не задет');
}

console.log(`\n  ${pass} пройшло, ${fail} впало`);
if (fail) { console.log('  впало: ' + failures.join('; ')); process.exit(1); }
process.exit(0);
