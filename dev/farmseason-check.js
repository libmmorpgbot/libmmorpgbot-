#!/usr/bin/env node
'use strict';
// ── Сезонное крыло Фарм-зоны: ещё 4 комнаты, дверь за билетом ───────────────
//
//   node dev/farmseason-check.js
//
// Заказ, дословно:
//
//   «в фарм зоне первой 20+ сделай ещё 4 комнаты, в которые могут войти только
//    те у кого сезонный билет, пусть будет телепорт разделяющий комнаты, в
//    который могут войти только с сезонным билетом»
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
} = require('../shared/definitions');
const { generateFarmSeason, generateFarmZone } = require('../server/game/dungeon');
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
head('ещё четыре комнаты — и это те же комнаты');

eq(wing.rooms.length, 4, 'в крыле четыре комнаты');
eq(zone.rooms.length, 4, 'и первая зона осталась при своих четырёх — крыло ДОБАВЛЕНО, а не отрезано от неё');
eq(wing.enemies.length, FARM_MOBS_PER_ROOM * 4, `${FARM_MOBS_PER_ROOM} монстров в каждой`);

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

console.log(`\n  ${pass} пройшло, ${fail} впало`);
if (failures.length) console.log('  впали: ' + failures.join(' · '));
process.exit(fail ? 1 : 0);
