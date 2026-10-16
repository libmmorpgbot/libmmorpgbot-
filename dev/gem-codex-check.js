#!/usr/bin/env node
'use strict';
// ── Самоцветы и Кодекс самоцветов ──────────────────────────────────────────
//
//   DATABASE_URL=... node dev/gem-codex-check.js
//
// Лесенки бонусов (чистые функции), дроп Фарм-зоны, минимальная цена на
// рынке — и сдача в кодекс на настоящей базе: списание, журнал, потолок 500,
// отказ при нехватке, бонус в характеристиках, посчитанных сервером.

const { tx, query, close } = require('../server/db');
const items = require('../server/db/repos/items');
const players = require('../server/db/repos/players');
const stats = require('../server/db/repos/stats');
const consumables = require('../server/db/repos/consumables');
const loot = require('../server/game/loot');
const { _marketMinPrice } = require('../server/inventory');
const D = require('../shared/definitions');
const { wipeItemsAll } = require('./fixtures');

let pass = 0, fail = 0;
const ok = (c, name, got) => {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + name); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m  ' + name + (got !== undefined ? ' — ' + got : '')); }
};
const TAG = 'gems-' + String(process.pid).slice(-5);
const made = [];

(async () => {
  console.log(`\ngem-codex-check  (${TAG})\n`);

  console.log('  ── лесенки ──');
  const b = (id, n) => D.gemCodexBonusFor(id, n);
  ok(b('gem_jewel', 0).atk === 0, '0 сдано — бонуса нет');
  ok(b('gem_jewel', 1).atk === 5 && b('gem_jewel', 1).def === 0, 'бусы, 1 шт. — +5 атаки');
  ok(b('gem_jewel', 20).atk === 15 && b('gem_jewel', 20).def === 10, 'бусы, 20 шт. — пороги 1+10+20 складываются');
  const j500 = b('gem_red', 500);
  ok(j500.atk === 115 && j500.def === 100 && j500.hp === 3000 && j500.atkSpeedPct === 0.2,
    'красный, 500 шт. — 115/100/3000/+20%', JSON.stringify(j500));
  const s500 = b('gem_stone', 500);
  ok(s500.atk === 270 && s500.def === 210 && s500.hp === 5000 && s500.atkSpeedPct === 0.2,
    'камень, 500 шт. — 270/210/5000/+20%', JSON.stringify(s500));
  ok(b('gem_shard', 29).atk === 20 && b('gem_shard', 30).atk === 40, 'осколок: порог 30 срабатывает ровно на 30');
  const tot = D.codexTotalBonus({ [D.GEM_CODEX_KEY]: { gem_jewel: 1, gem_shard: 1 } });
  ok(tot.atk === 15 && tot.completed === 0, 'каждый вид по отдельности, наборы не задеты', JSON.stringify(tot));
  ok(D.codexTotalBonus({ [D.GEM_CODEX_KEY]: { gem_jewel: 99999 } }).atk === 115, 'больше 500 не считается');

  console.log('  ── дроп и рынок ──');
  const got = new Map();
  for (let i = 0; i < 200; i++) {
    for (const d of loot._rollFarmZoneLoot([], 'goblin', 1e6)) got.set(d.id, (got.get(d.id) || 0) + 1);
  }
  ok(['gem_jewel', 'gem_red', 'gem_shard', 'gem_stone'].every(id => got.get(id) > 0), 'Фарм-зона роняет все четыре самоцвета');
  ok(D.FARM_GEM_COMMON_CHANCE === D.FARM_NORM_STONE_CHANCE, 'бусы и красный — шанс обычной заточки');
  ok(D.FARM_GEM_RARE_CHANCE === D.FARM_BLESS_STONE_CHANCE, 'осколок и камень — шанс безопасной');
  const gemDef = D.CRAFT_MATS.find(m => m.id === 'gem_shard');
  ok(_marketMinPrice({ ...gemDef, qty: 1 }) === 0.4, 'минимальная цена на рынке — 0.4 за штуку');
  ok(_marketMinPrice({ ...gemDef, qty: 10 }) === 4, 'и за стак — 0.4 × штук');

  console.log('  ── сдача в кодекс ──');
  await tx(t => items.syncCatalog(t));
  const { id: pid } = await tx(t => players.ensure(t, `${TAG}-a`, `${TAG}_a`));
  made.push(pid);
  await tx(t => players.setClass(t, pid, 'lev'));
  const st0 = stats.compute(await stats.load(null, pid));
  await tx(t => items.add(t, pid, 'gem_jewel', { qty: 12, source: 'test' }));
  const reg = (id, qty) => tx(t => consumables.registerCodexGem(t, pid, id, qty))
    .then(r => ({ ok: true, r }), e => ({ ok: false, code: e.code }));

  const r1 = await reg('gem_jewel', 10);
  ok(r1.ok && r1.r.count === 10 && r1.r.taken === 10, 'сдано 10 бус', JSON.stringify(r1));
  const { rows: inv } = await query(null,
    `SELECT COALESCE(sum(qty),0)::int n FROM player_items WHERE player_id = $1 AND item_id = 'gem_jewel'`, [pid]);
  ok(inv[0].n === 2, 'в сумке осталось 2', inv[0].n);
  const { rows: led } = await query(null,
    `SELECT COALESCE(sum(delta),0)::int n FROM item_ledger WHERE player_id = $1 AND reason = 'codex_gem'`, [pid]);
  ok(led[0].n === -10, 'списание — в журнале предметов', led[0].n);
  const st1 = stats.compute(await stats.load(null, pid));
  ok(st1.atk - st0.atk === 10 && st1.def - st0.def === 5, 'бонус дошёл до характеристик сервера (+10 АТК, +5 ЗАЩ)',
    `${st1.atk - st0.atk}/${st1.def - st0.def}`);

  const r2 = await reg('gem_jewel', 5);
  ok(!r2.ok && r2.code === 'not_enough', 'больше, чем в сумке, — отказ', r2.code);
  const r3 = await reg('gem_red', 1);
  ok(!r3.ok && r3.code === 'not_enough', 'чего нет вовсе — отказ', r3.code);
  const r4 = await reg('norm_stone', 1);
  ok(!r4.ok && r4.code === 'bad_gem', 'не самоцвет — отказ', r4.code);
  const r5 = await reg('gem_jewel', 0);
  ok(!r5.ok && r5.code === 'bad_qty', 'ноль штук — отказ', r5.code);

  // Потолок: 498 сдано, в сумке 5 — берётся 2, три остаются.
  await query(null, `UPDATE player_progress SET codex = jsonb_set(codex, '{_gems,gem_jewel}', '498') WHERE player_id = $1`, [pid]);
  await tx(t => items.add(t, pid, 'gem_jewel', { qty: 3, source: 'test' }));
  const r6 = await reg('gem_jewel', 5);
  ok(r6.ok && r6.r.taken === 2 && r6.r.count === 500, 'у потолка берётся только до 500', JSON.stringify(r6.r));
  const { rows: inv2 } = await query(null,
    `SELECT COALESCE(sum(qty),0)::int n FROM player_items WHERE player_id = $1 AND item_id = 'gem_jewel'`, [pid]);
  ok(inv2[0].n === 3, 'лишнее осталось в сумке', inv2[0].n);
  const r7 = await reg('gem_jewel', 1);
  ok(!r7.ok && r7.code === 'maxed', 'на 500 больше не принимается', r7.code);

  console.log('');
  console.log(fail === 0
    ? `  \x1b[32m${pass} пройшло, 0 впало\x1b[0m\n`
    : `  \x1b[31m${pass} пройшло, ${fail} впало\x1b[0m\n`);
  await wipeItemsAll(made);
  await close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error(e);
  try { await wipeItemsAll(made); await close(); } catch { /* уже закрыто */ }
  process.exit(1);
});
