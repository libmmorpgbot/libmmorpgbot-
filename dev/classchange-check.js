#!/usr/bin/env node
'use strict';
// ── Смена класса ────────────────────────────────────────────────────────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/classchange-check.js
//
// Правила владельца, все четыре:
//
//   снять всю экипировку   иначе отказ;
//   навыки и улучшения     переносятся;
//   ПАССИВКИ               тоже — и вот они как раз не переносились;
//   цена                   первая 2000 Liberty или 3 GRAM, дальше только GRAM.
//
// Про пассивки отдельно. Уровни оставались в базе, но переставали что-либо
// значить: у каждого класса своя пара со своими именами ('tankatk' у танка,
// 'dkatk' у рыцаря смерти), а подсчёт бонусов перебирает пассивки НОВОГО
// класса и старых имён там не находит. Вложенное лежало мёртвым грузом.
const { tx, query, close } = require('../server/db');
const players = require('../server/db/repos/players');
const items = require('../server/db/repos/items');
const money = require('../server/db/repos/money');
const D = require('../shared/definitions');
const { wipeItemsAll } = require('./fixtures');

let pass = 0, fail = 0;
const ok = (c, name, got) => {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + name); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m  ' + name + (got !== undefined ? ' — ' + got : '')); }
};
const eq = (a, b, n) => ok(a === b, n, `ожидал ${JSON.stringify(b)}, получил ${JSON.stringify(a)}`);

const TAG = 'cc-' + String(process.pid).slice(-5);
const made = [];

const passivesOf = async (pid) => {
  const { rows } = await query(null,
    `SELECT key, level FROM player_skills WHERE player_id = $1 AND kind = 'passive' ORDER BY key`, [pid]);
  return Object.fromEntries(rows.map(r => [r.key, r.level]));
};

(async () => {
  console.log(`\nclasschange-check  (${TAG})\n`);

  const { id } = await tx(t => players.ensure(t, `${TAG}-a`, `${TAG}_герой`));
  made.push(id);
  await query(null, `UPDATE player_progress SET char_class = 'lev', lvl = 40 WHERE player_id = $1`, [id]);

  // ── пассивки, вложенные танком ──────────────────────────────────────────
  const [pAtk, pDef] = D.PASSIVE_CLASS_DEF.lev;
  const [nAtk, nDef] = D.PASSIVE_CLASS_DEF.deathknight;
  await query(null, `
    INSERT INTO player_skills (player_id, kind, key, level) VALUES ($1,'passive',$2,7), ($1,'passive',$3,4)
    ON CONFLICT (player_id, kind, key) DO UPDATE SET level = EXCLUDED.level`,
    [id, pAtk.id, pDef.id]);
  // И одна общая — она к классу не привязана и должна пережить смену как есть.
  const common = D.PASSIVE_COMMON_DEF[0];
  await query(null, `
    INSERT INTO player_skills (player_id, kind, key, level) VALUES ($1,'passive',$2,5)
    ON CONFLICT (player_id, kind, key) DO UPDATE SET level = EXCLUDED.level`, [id, common.id]);
  // И обычный навык — он переносится тем, что его никто не трогает.
  await query(null, `
    INSERT INTO player_skills (player_id, kind, key, level) VALUES ($1,'skill','Q',6)
    ON CONFLICT (player_id, kind, key) DO UPDATE SET level = EXCLUDED.level`, [id]);
  await query(null, `UPDATE player_progress SET upg_atk = 12, upg_hp = 30 WHERE player_id = $1`, [id]);

  const before = await passivesOf(id);
  console.log(`      до смены: ${JSON.stringify(before)}`);
  eq(before[pAtk.id], 7, 'пассивка танка на атаку вложена на 7');
  eq(before[pDef.id], 4, 'и на защиту на 4');

  // ── отказ, пока что-то надето ───────────────────────────────────────────
  console.log('  ── снять всё ──');
  const rowId = await tx(async (t) => {
    await items.lockPlayer(t, id);
    return items.add(t, id, 'sw1', { source: 'test' });
  });
  await tx(t => items.moveTo(t, rowId, id, 'equipment', 'weapon'));
  const refused = await tx(t => players.changeClass(t, id, 'deathknight'));
  eq(refused.ok, false, 'с надетым предметом смена отклонена');
  eq(refused.code, 'has_equipment', 'и причина названа');
  ok(refused.worn >= 1, `сказано, сколько надето (${refused.worn})`);
  await tx(t => items.moveTo(t, rowId, id, 'inventory'));

  // ── сама смена ──────────────────────────────────────────────────────────
  console.log('  ── смена ──');
  const res = await tx(t => players.changeClass(t, id, 'deathknight'));
  eq(res.ok, true, 'после снятия экипировки смена проходит', JSON.stringify(res));

  const after = await passivesOf(id);
  console.log(`      после смены: ${JSON.stringify(after)}`);
  eq(after[nAtk.id], 7, 'пассивка на атаку переехала к рыцарю смерти С ТЕМ ЖЕ уровнем');
  eq(after[nDef.id], 4, 'и на защиту тоже');
  ok(!(pAtk.id in after), 'старые имена не остались вторым экземпляром');
  ok(!(pDef.id in after), 'и второе тоже');
  eq(after[common.id], 5, 'общая пассивка не тронута — она к классу не привязана');

  // Эффект не изменился: пары у всех классов одинаковы по построению.
  const bTot = D.passiveBonusTotal(before, 'lev');
  const aTot = D.passiveBonusTotal(after, 'deathknight');
  eq(aTot.atkPct, bTot.atkPct, `бонус к атаке тот же (${(aTot.atkPct * 100).toFixed(0)}%)`);
  eq(aTot.defPct, bTot.defPct, `и к защите (${(aTot.defPct * 100).toFixed(0)}%)`);

  // Навыки и улучшения — их никто не трогал.
  const { rows: sk } = await query(null,
    `SELECT level FROM player_skills WHERE player_id = $1 AND kind = 'skill' AND key = 'Q'`, [id]);
  eq(sk.length && sk[0].level, 6, 'обычный навык остался на своём уровне');
  const { rows: up } = await query(null,
    'SELECT upg_atk, upg_hp FROM player_progress WHERE player_id = $1', [id]);
  ok(up[0].upg_atk === 12 && up[0].upg_hp === 30,
    'улучшения характеристик на месте', JSON.stringify(up[0]));

  // ── цена ────────────────────────────────────────────────────────────────
  // Первая смена может быть за Liberty; вторая и дальше — только за GRAM.
  // Здесь проверяется само правило, по которому обработчик выбирает валюту.
  console.log('  ── цена ──');
  const paid = await query(null,
    `SELECT count(*)::int n FROM ledger WHERE player_id = $1 AND reason = 'class_change'`, [id]);
  console.log(`      списаний за смену в журнале: ${paid.rows[0].n} (сама смена здесь без оплаты)`);
  ok(D.CLASS_CHANGE_FIRST_NEXUM === 2000, `первая — ${D.CLASS_CHANGE_FIRST_NEXUM} Liberty`);
  ok(D.CLASS_CHANGE_GRAM === 3, `остальные — ${D.CLASS_CHANGE_GRAM} GRAM`);
  const econ = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'server/handlers2/economy.js'), 'utf8');
  ok(/const wantsGram = pay === 'gram' \|\| done > 0;/.test(econ),
    'после первой смены валюта только GRAM, что бы ни просил клиент');

  console.log('');
  console.log(fail === 0
    ? `  \x1b[32m${pass} пройшло, 0 впало\x1b[0m\n`
    : `  \x1b[31m${pass} пройшло, ${fail} впало\x1b[0m\n`);
  await wipeItemsAll(made);
  await close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error(e);
  try { await wipeItemsAll(made); await close(); } catch {}
  process.exit(1);
});
