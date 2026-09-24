#!/usr/bin/env node
'use strict';
// ── Сезонные крылья Фарм-зон: по 8 комнат, дверь за билетом ─────────────────
//
//   node dev/farmseason-check.js
//
// Заказ, дословно:
//
//   «в фарм зоне первой 20+ сделай ещё 4 комнаты, в которые могут войти только
//    те у кого сезонный билет, пусть будет телепорт разделяющий комнаты, в
//    который могут войти только с сезонным билетом»
//
//   и позже: «сделай в сезонной комнате 8 комнат, так же сделай в фарм зоне 2
//    тоже такую же комнату с 8 комнатами»
//
// ── что здесь на самом деле проверяется ────────────────────────────────────
// Не «нарисован ли замок». Крыло куплено за GRAM, и единственное утверждение,
// которое чего-то стоит, — СЕРВЕР не пускает туда без билета. Барьеры внутри
// этажа в этой игре клиентские (_isGateBlocked, js/game.js — по нему работают
// уровневые ворота коридоров), поэтому крыло вынесено на свой этаж: переход
// между этажами проверяет resolveFloor, и мимо него в крыло не попасть.
//
// Поэтому главный раздел ниже — «дверь сторожит сервер», и в нём проверяется
// в том числе то, чего легко не заметить: вызывающий, ЗАБЫВШИЙ спросить про
// билет, тоже получает отказ, а не бесплатный вход.

const {
  FARM_LVL_MIN, FARM_LVL_MAX, FARM_ENTRY_LEVEL, FARM_MOBS_PER_ROOM, FARM_SPECIES,
  FARM_XP_MULT, seasonActive, SEASON_END_AT, TILE, FLOOR,
  FARM_HIGH_LVL_MIN, FARM_HIGH_LVL_MAX, FARM_HIGH_ENTRY_LEVEL, FARM_HIGH_MOBS_PER_ROOM, FARM_HIGH_SPECIES,
} = require('../shared/definitions');
const { generateFarmSeason, generateFarmZone, generateFarmHigh, generateFarmHighSeason } = require('../server/game/dungeon');
const { FLOOR_IDS } = require('../server/game/floors');
const world = require('../server/world');
const { STANDABLE, resolveFloor, floorCtxOf, ticketOnlyFloor } = world;

let pass = 0, fail = 0; const failures = [];
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${extra ? ' — ' + extra : ''}`); }
}
const eq = (got, want, name) => ok(got === want, name, `отримано ${JSON.stringify(got)}, чекали ${JSON.stringify(want)}`);
const head = s => console.log(`\n  ── ${s} ──`);

// Сезон в этой сборке ещё идёт; если бы кончился, каждое утверждение про
// «пускает с билетом» ниже читалось бы наоборот, и молчаливо зелёная проверка
// была бы хуже красной.
const SEASON_ON = seasonActive();
const TICKET = { seasonTicket: true };
const NOPE = { seasonTicket: false };
const HI = { lvl: FARM_ENTRY_LEVEL };
const LOW = { lvl: FARM_ENTRY_LEVEL - 1 };

console.log('\nfarmseason-check');

// ════════════════════════════════════════════════════════════════════════════
head('дверь сторожит сервер');

ok(SEASON_ON, `сезон ещё идёт (до ${new Date(SEASON_END_AT).toISOString()}) — иначе весь раздел ниже проверяет не то`);
ok(FLOOR_IDS.farmSeason != null, 'у крыла свой этаж');
ok(FLOOR_IDS.farmSeason !== FLOOR_IDS.farmZone, 'и он отдельный от первой Фарм-зоны');
ok(STANDABLE.has(FLOOR_IDS.farmSeason), 'на нём можно стоять — это обычная зона, а не инстанс на один заход');
ok(ticketOnlyFloor('farmSeason'), 'этаж помечен как «только за билетом»');
ok(!ticketOnlyFloor('farmZone') && !ticketOnlyFloor('farmHigh'), 'а соседние фарм-зоны — нет');

eq(resolveFloor(FLOOR_IDS.farmSeason, HI, TICKET), FLOOR_IDS.farmSeason, 'с билетом и уровнем — пускает');
eq(resolveFloor(FLOOR_IDS.farmSeason, HI, NOPE), FLOOR_IDS.hub, 'без билета — разворачивает в хаб');
eq(resolveFloor(FLOOR_IDS.farmSeason, LOW, TICKET), FLOOR_IDS.hub, 'билет не отменяет уровень: с 19-го не пускает и с ним');
eq(resolveFloor(FLOOR_IDS.farmSeason, HI), FLOOR_IDS.hub,
  'вызывающий, забывший спросить про билет, получает отказ — а не бесплатный вход в оплаченное крыло');
eq(resolveFloor('farmSeason', HI, TICKET), FLOOR_IDS.farmSeason, 'по имени этажа — то же самое');

// Билет читается с СЕССИИ, а не приходит от клиента: у клиента он был бы
// свободно включаемым флагом.
eq(floorCtxOf({ seasonTicket: true }).seasonTicket, true, 'контекст берёт билет с сессии');
eq(floorCtxOf({ seasonTicket: false }).seasonTicket, false, 'сессия без билета — билета нет');
eq(floorCtxOf(null).seasonTicket, false, 'сессии нет — билета нет');

// Соседей это не задело.
eq(resolveFloor(FLOOR_IDS.farmZone, HI, NOPE), FLOOR_IDS.farmZone, 'в первую Фарм-зону по-прежнему пускают без билета');
eq(resolveFloor(FLOOR_IDS.farmHigh, { lvl: 40 }, NOPE), FLOOR_IDS.farmHigh, 'и в Фарм зону 2 тоже');

// ── и когда сезон кончится ─────────────────────────────────────────────────
// Крыло закрывается вместе с сезоном — тем же правилом, по которому
// перестают работать бонусы билета к дропу и опыту. Проверяется подменой
// часов, а не ожиданием десятого сентября.
{
  const realNow = Date.now;
  Date.now = () => SEASON_END_AT + 1000;
  try {
    eq(resolveFloor(FLOOR_IDS.farmSeason, HI, TICKET), FLOOR_IDS.hub,
      'после конца сезона крыло закрыто даже с билетом');
    eq(resolveFloor(FLOOR_IDS.farmZone, HI, NOPE), FLOOR_IDS.farmZone,
      'а первая Фарм-зона — нет: закрылось крыло, а не зона');
  } finally { Date.now = realNow; }
}

// ════════════════════════════════════════════════════════════════════════════
head('телепорт, разделяющий комнаты');

const zone = generateFarmZone();
const wing = generateFarmSeason();

ok(!!zone.seasonPad, 'в первой Фарм-зоне есть пад в крыло');
eq(zone.seasonPad && zone.seasonPad.requiresTicket, true, 'и он объявлен как требующий билета — по этому клиент рисует замок');
eq(zone.seasonPad && zone.seasonPad.req, FARM_ENTRY_LEVEL, 'уровневый порог у пада тот же, что у самой зоны');
ok(!wing.seasonPad, 'внутри крыла второго такого пада нет — дверь одна');

// Пад и возврат стоят врозь: иначе один шаг попадал бы в оба, и игрока
// швыряло бы между этажами.
const TRIGGER_R = 26;
const padGap = Math.hypot(zone.seasonPad.x - zone.returnPad.x, zone.seasonPad.y - zone.returnPad.y);
ok(padGap > TRIGGER_R * 4, `пад в крыло и возврат в хаб не пересекаются (${Math.round(padGap)}px между ними)`);

// Пад стоит на проходимой плитке — иначе до него не дойти. TILE и FLOOR
// берутся из каталога, а не вписываются числами: первый заход написал здесь
// «=== 0», то есть СТЕНУ, и объявил сломанными три исправных пада.
function walkable(d, px, py) {
  const gx = Math.floor(px / TILE), gy = Math.floor(py / TILE);
  return !!(d.grid[gy] && d.grid[gy][gx] === FLOOR);
}
ok(walkable(zone, zone.seasonPad.x, zone.seasonPad.y), 'пад лежит на полу, а не в стене');
ok(walkable(wing, wing.returnPad.x, wing.returnPad.y), 'возврат из крыла — тоже');
ok(walkable(wing, wing.spawn.x, wing.spawn.y), 'и точка входа в крыло');

// Возврат ведёт назад в зону, а не в хаб: пришли из неё.
eq(wing.returnPad.target, 'farmZone', 'возврат из крыла ведёт обратно в Фарм-зону');
ok(!zone.returnPad.target, 'у первой зоны цели возврата нет — клиент читает хаб по умолчанию');

// ════════════════════════════════════════════════════════════════════════════
head('восемь комнат — и это те же комнаты');

eq(wing.rooms.length, 8, 'в крыле восемь комнат');
eq(zone.rooms.length, 4, 'и первая зона осталась при своих четырёх — крыло ДОБАВЛЕНО, а не отрезано от неё');
eq(wing.enemies.length, FARM_MOBS_PER_ROOM * 8, `${FARM_MOBS_PER_ROOM} монстров в каждой`);

// До каждой комнаты можно дойти пешком от точки входа — коридоры, а не
// отдельные острова. Обход в ширину по плиткам пола.
function reachAll(d, label) {
  const sx = Math.floor(d.spawn.x / TILE), sy = Math.floor(d.spawn.y / TILE);
  const seen = new Set([sx + ',' + sy]); const q = [[sx, sy]];
  while (q.length) {
    const [x, y] = q.shift();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, k = nx + ',' + ny;
      if (seen.has(k) || !d.grid[ny] || d.grid[ny][nx] !== FLOOR) continue;
      seen.add(k); q.push([nx, ny]);
    }
  }
  const cut = d.rooms.filter(r => !seen.has(r.cx + ',' + r.cy));
  eq(cut.length, 0, `${label}: от входа доходишь до всех ${d.rooms.length} комнат`);
  const rx = Math.floor(d.returnPad.x / TILE), ry = Math.floor(d.returnPad.y / TILE);
  ok(seen.has(rx + ',' + ry), `${label}: и до пада возврата`);
}
reachAll(wing, 'крыло Фарм-зоны');

const outOfBand = wing.enemies.filter(e => e.rlvl < FARM_LVL_MIN || e.rlvl > FARM_LVL_MAX);
eq(outOfBand.length, 0, `все уровни в полосе ${FARM_LVL_MIN}-${FARM_LVL_MAX} — та же, что у первой зоны`);
const spawned = new Set(wing.enemies.map(e => e.eid));
eq(FARM_SPECIES.filter(sp => !spawned.has(sp)).join(), '', 'встречаются все виды первой зоны');

// Метка `farmZone` на монстрах крыла — не описка. По ней сервер выбирает
// таблицу дропа, ставку Liberty и отказ в GRAM (rollLoot и соседи,
// server/handlers2/world.js). Без неё крыло платило бы по коридорной таблице.
ok(wing.enemies.every(e => e.farmZone === true && e.arm === 'farmZone'),
  'монстры крыла помечены как монстры Фарм-зоны — выплата идёт по её таблице, а не по коридорной');
ok(wing.enemies.every(e => e.aggro === false && e.aggroR > 0), 'сами не нападают, как и в первой зоне');

// Статы и опыт — те же формулы. Сравниваются по одному уровню, а не по
// конкретным монстрам: расстановка своя, монстры случайны.
const sameLvl = (list, lvl, eid) => list.find(e => e.rlvl === lvl && e.eid === eid);
let mismatched = 0, compared = 0;
for (const e of wing.enemies) {
  const twin = sameLvl(zone.enemies, e.rlvl, e.eid);
  if (!twin) continue;
  compared++;
  if (twin.maxHp !== e.maxHp || twin.atk !== e.atk || twin.xp !== e.xp || twin.gold !== e.gold) mismatched++;
}
ok(compared > 0, `есть с чем сравнивать (${compared} пар «тот же вид, тот же уровень»)`);
eq(mismatched, 0, 'hp/atk/опыт/золото совпадают с первой зоной до числа');
ok(FARM_XP_MULT === 3, 'и множитель опыта зоны тот же');

// id не должны столкнуться с id первой зоны: этажи разные, а журналы и
// античит смотрят на id.
const zoneIds = new Set(zone.enemies.map(e => e.id));
const clash = wing.enemies.filter(e => zoneIds.has(e.id));
eq(clash.length, 0, `id монстров крыла не пересекаются с id первой зоны${clash.length ? ' (' + clash[0].id + ')' : ''}`);

// ════════════════════════════════════════════════════════════════════════════
head('крыло выглядит фарм-зоной');

ok(!!wing.farmZone && !!wing.farmZone.bounds, 'у крыла есть границы зоны — по ним клиент красит плитку её палитрой');
eq(wing.farmZone.seasonWing, true, 'и флаг, которым подпись места отличает крыло от первой зоны');
ok(!zone.farmZone.seasonWing, 'у первой зоны такого флага нет');
eq(wing.farmZone.minLevel, FARM_ENTRY_LEVEL, 'уровневый порог тот же');
ok(wing.rooms.every(r => r.isFarmZone && r.arm === 'farmZone'), 'комнаты крыла — комнаты фарм-зоны');

// ════════════════════════════════════════════════════════════════════════════
head('сезонное крыло Фарм зоны 2');

const hi = generateFarmHigh();
const hiWing = generateFarmHighSeason();
const HI2 = { lvl: FARM_HIGH_ENTRY_LEVEL };
const LOW2 = { lvl: FARM_HIGH_ENTRY_LEVEL - 1 };

ok(FLOOR_IDS.farmHighSeason != null && FLOOR_IDS.farmHighSeason !== FLOOR_IDS.farmHigh, 'у крыла свой этаж, отдельный от Фарм зоны 2');
ok(STANDABLE.has(FLOOR_IDS.farmHighSeason), 'на нём можно стоять');
ok(ticketOnlyFloor('farmHighSeason'), 'этаж помечен как «только за билетом»');
eq(resolveFloor(FLOOR_IDS.farmHighSeason, HI2, TICKET), FLOOR_IDS.farmHighSeason, 'с билетом и уровнем — пускает');
eq(resolveFloor(FLOOR_IDS.farmHighSeason, HI2, NOPE), FLOOR_IDS.hub, 'без билета — разворачивает в хаб');
eq(resolveFloor(FLOOR_IDS.farmHighSeason, LOW2, TICKET), FLOOR_IDS.hub, `билет не отменяет уровень ${FARM_HIGH_ENTRY_LEVEL}+`);
eq(resolveFloor(FLOOR_IDS.farmHighSeason, HI2), FLOOR_IDS.hub, 'забыли спросить про билет — тоже отказ');

ok(!!hi.seasonPad, 'в Фарм зоне 2 есть пад в её крыло');
eq(hi.seasonPad && hi.seasonPad.target, 'farmHighSeason', 'и он ведёт именно в её крыло, а не в крыло первой зоны');
eq(hi.seasonPad && hi.seasonPad.requiresTicket, true, 'с замком по билету');
eq(hi.seasonPad && hi.seasonPad.req, FARM_HIGH_ENTRY_LEVEL, 'порог уровня — как у самой зоны');
ok(walkable(hi, hi.seasonPad.x, hi.seasonPad.y), 'пад лежит на полу');
ok(Math.hypot(hi.seasonPad.x - hi.returnPad.x, hi.seasonPad.y - hi.returnPad.y) > TRIGGER_R * 4, 'и стоит врозь с возвратом в хаб');
ok(!hiWing.seasonPad, 'внутри крыла второго пада нет');
eq(hiWing.returnPad.target, 'farmHigh', 'возврат из крыла ведёт обратно в Фарм зону 2');

eq(hiWing.rooms.length, 8, 'в крыле восемь комнат');
eq(hi.rooms.length, 4, 'сама Фарм зона 2 осталась при своих четырёх');
eq(hiWing.enemies.length, FARM_HIGH_MOBS_PER_ROOM * 8, `${FARM_HIGH_MOBS_PER_ROOM} монстров в каждой`);
reachAll(hiWing, 'крыло Фарм зоны 2');
eq(hiWing.enemies.filter(e => e.rlvl < FARM_HIGH_LVL_MIN || e.rlvl > FARM_HIGH_LVL_MAX).length, 0,
  `все уровни в полосе ${FARM_HIGH_LVL_MIN}-${FARM_HIGH_LVL_MAX}`);
const hiSpawned = new Set(hiWing.enemies.map(e => e.eid));
eq(FARM_HIGH_SPECIES.filter(sp => !hiSpawned.has(sp)).join(), '', 'встречаются все виды Фарм зоны 2');
ok(hiWing.enemies.every(e => e.farmHigh === true && e.arm === 'farmHigh'),
  'монстры помечены как монстры Фарм зоны 2 — дроп и задания идут по её таблицам');
let hiMis = 0, hiCmp = 0;
for (const e of hiWing.enemies) {
  const twin = hi.enemies.find(x => x.rlvl === e.rlvl && x.eid === e.eid);
  if (!twin) continue;
  hiCmp++;
  if (twin.maxHp !== e.maxHp || twin.atk !== e.atk || twin.xp !== e.xp || twin.gold !== e.gold) hiMis++;
}
ok(hiCmp > 0 && hiMis === 0, `hp/atk/опыт/золото совпадают с Фарм зоной 2 (${hiCmp} пар)`);
const hiIds = new Set([...hi.enemies, ...wing.enemies, ...zone.enemies].map(e => e.id));
eq(hiWing.enemies.filter(e => hiIds.has(e.id)).length, 0, 'id монстров не пересекаются с другими фарм-зонами');
eq(hiWing.farmHigh && hiWing.farmHigh.seasonWing, true, 'флаг seasonWing — по нему клиент подписывает место');
ok(!hi.farmHigh.seasonWing, 'у самой Фарм зоны 2 такого флага нет');

console.log(`\n  ${pass} пройшло, ${fail} впало`);
if (failures.length) console.log('  впали: ' + failures.join(' · '));
process.exit(fail ? 1 : 0);
