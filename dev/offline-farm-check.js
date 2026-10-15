#!/usr/bin/env node
'use strict';
// ── Оффлайн-фарм: темп и прогон наград ──────────────────────────────────────
//
//   node dev/offline-farm-check.js
//
// Без базы: проверяются чистые половины — модель темпа (offlineFarmRate,
// shared/definitions.js) и прогон убийств (simulate, server/offline-farm.js).
// Выдача в базу — те же money.credit / items.add / grantXp, что у онлайн-
// убийства, и проверяются они там.

const D = require('../shared/definitions');
const of = require('../server/offline-farm');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const head = t => console.log(`\n${t}`);

const MID = { atk: 300, def: 40, maxHp: 1500, hpRegen: 1.5, critChance: 0.2, critPower: 1.8, atkSpeed: 1.2,
              gearXpPct: 0, gearDropPct: 0, gearNexumPct: 0 };

head('Локации');
const locs = D.offlineFarmLocations();
const corr = locs.filter(l => l.kind === 'corridor');
ok(corr.length === D.ARM_ROOM_COUNTS.reduce((a, n) => a + n - 1, 0), 'все комнаты коридоров, кроме боссов');
ok(locs.some(l => l.id === 'farmZone') && locs.some(l => l.id === 'farmHigh'), 'обе открытые фарм-зоны');
ok(!locs.some(l => l.kind === 'farmZone2' || l.id === 'farmZone2'), 'Элитной зоны нет: она только группой');
ok(new Set(locs.map(l => l.id)).size === locs.length, 'id не повторяются');
ok(D.offlineFarmLocation('c:left:1').reqLevel === 0, 'первая комната открыта с 1 уровня');
ok(D.offlineFarmLocation('c:top:1').reqLevel === D.ARM_LEVEL_REQ.top, 'дверь верхнего коридора — его уровень');
ok(D.offlineFarmLocation('c:left:3').reqLevel === 3, 'ворота перед парой 3-4 — 3 уровень, как в generateArm');
ok(D.offlineFarmLocation('farmZone').reqLevel === D.FARM_ENTRY_LEVEL, 'фарм-зона — с её уровня входа');
ok(D.offlineFarmLocation('constructor') === null, 'чужой ключ — не локация');

head('Монстры — те же, что в генераторе');
const m10 = D.offlineFarmMobs(D.offlineFarmLocation('c:left:10'))[0];
const s10 = D.monsterStatsAtLevel(10, m10.eType);
ok(m10.hp === Math.floor(s10.hp * 0.5) && m10.atk === Math.floor(s10.atk * 0.5) && m10.def === s10.def,
  'hp/atk ослаблены вдвое, def нет (weakMult)');
ok(m10.xp === D.xpAtLevel(10) && m10.gold === D.goldAtLevel(10), 'опыт и золото по уровню');
const fz = D.offlineFarmMobs(D.offlineFarmLocation('farmZone'));
ok(fz.length === D.FARM_SPECIES.length * (D.FARM_LVL_MAX - D.FARM_LVL_MIN + 1), 'фарм-зона: каждый вид на каждом уровне');
ok(fz.every(m => m.xp === D.xpAtLevel(m.rlvl) * D.FARM_XP_MULT), 'фарм-зона: опыт ×FARM_XP_MULT');

head('Темп');
const r10 = D.offlineFarmRate(MID, D.offlineFarmLocation('c:left:10'));
ok(r10.ok && r10.killsPerHour > 0, 'обычный игрок фармит свою комнату');
const hit = Math.max(1, MID.atk - m10.def) * (1 + MID.critChance * (MID.critPower - 1)) * MID.atkSpeed;
ok(r10.secPerKill >= m10.hp / hit + D.OFFLINE_FARM_WALK_SEC - 1e-9, 'на монстра уходит не меньше ttk + дорога');
ok(r10.killsPerHour <= 3600 / D.OFFLINE_FARM_WALK_SEC, 'быстрее, чем дойти до монстра, не бывает');
const strong = D.offlineFarmRate({ ...MID, atk: MID.atk * 2 }, D.offlineFarmLocation('c:left:10'));
ok(strong.killsPerHour >= r10.killsPerHour, 'больше атаки — не медленнее');
const weak = D.offlineFarmRate({ atk: 20, def: 1, maxHp: 100, hpRegen: 0.1, critChance: 0, critPower: 1.5, atkSpeed: 1 },
  D.offlineFarmLocation('c:right:17'));
ok(!weak.ok && weak.reason === 'too_strong', 'монстры, которые убьют раньше, не фармятся');
const tanky = D.offlineFarmRate({ ...MID, def: 5000 }, D.offlineFarmLocation('c:top:5'));
const soft = D.offlineFarmRate({ ...MID, def: 0 }, D.offlineFarmLocation('c:top:5'));
ok(!soft.ok || tanky.killsPerHour >= soft.killsPerHour, 'защита снимает отдых, а не добавляет его');
const empty = D.offlineFarmRate({}, D.offlineFarmLocation('c:left:1'));
ok(Number.isFinite(empty.killsPerHour) && typeof empty.ok === 'boolean', 'пустой блок характеристик не даёт NaN');

head('Прогон убийств');
const loc = D.offlineFarmLocation('c:left:10');
const zero = of.simulate(loc, MID, 0);
ok(zero.kills === 0 && zero.xp === 0 && zero.gold === 0 && zero.drops.length === 0, 'ноль убийств — ноль наград');
const N = 2000;
const res = of.simulate(loc, MID, N);
ok(res.kills === N, 'засчитано ровно столько убийств');
ok(res.xp === N * m10.xp, 'опыт без бонусов — сумма опыта монстров');
const expGold = N * m10.gold * 0.3;
ok(Math.abs(res.gold - expGold) < expGold * 0.25, 'золото — около 30% убийств', `${res.gold} против ${expGold}`);
ok(res.nexum === 0, 'в коридоре Liberty не падает (как онлайн)');
ok(Object.values(res.byEid).reduce((a, n) => a + n, 0) === N, 'убийства разложены по видам для квестов');
const vip = of.simulate(loc, MID, N, { vipLevel: 5 });
ok(vip.xp === Math.round(N * m10.xp * (1 + D.VIP_BONUSES[5].xp / 100)), 'VIP 5 даёт свой процент опыта');
const zone = of.simulate(D.offlineFarmLocation('farmZone'), { ...MID, atk: 3000 }, 20000);
ok(zone.gram === 0, 'в фарм-зоне GRAM не падает (как онлайн)');
const mats = zone.drops.filter(d => D.CRAFT_MATS.some(m => m.id === d.id));
ok(new Set(mats.map(d => d.id)).size === mats.length, 'материалы сложены в одну стопку на вид');

head('Время');
ok(of._overlap(0, 1000, 2000) === 0, 'зелье, кончившееся до фарма, не действует');
ok(of._overlap(1500, 1000, 2000) === 0.5, 'зелье на половину фарма — половина');
ok(of._overlap(9999, 1000, 2000) === 1, 'зелье на весь фарм — весь');
let sum = 0; for (let i = 0; i < 4000; i++) sum += of._killsFor(90, 100);
ok(Math.abs(sum / 4000 - 2.5) < 0.1, 'дробное убийство разыгрывается, а не теряется');
ok(D.OFFLINE_FARM_MAX_HOURS > 0 && D.OFFLINE_FARM_MIN_SEC > 0, 'потолок и минимум заданы');

console.log(`\n  ${pass} пройшло, ${fail} впало`);
if (failures.length) console.log('  впали: ' + failures.join(' · '));
process.exit(fail ? 1 : 0);
