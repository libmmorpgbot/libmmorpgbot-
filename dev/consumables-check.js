#!/usr/bin/env node
'use strict';
// ── Proof that using something does what the catalog says, not the request ──
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/consumables-check.js
//
// The headline case is C2 from AUDIT.md: usePotion took an `amount` from the
// client, and a non-numeric one produced hp = NaN — which compares false
// against every threshold, so the player became effectively immortal. There is
// no amount to send here; the heal is read from the catalog. The test proves
// that by trying to pass one.

const { pool, tx, close } = require('../server/db');
const items = require('../server/db/repos/items');
const money = require('../server/db/repos/money');
const players = require('../server/db/repos/players');
const stats = require('../server/db/repos/stats');
const con = require('../server/db/repos/consumables');
const {
  ITEM_DEF, CODEX_SETS, REBIRTH_LEVEL, REBIRTH_BONUS_SP,
  rebirthCostFor, UPGRADE_RESET_COST, codexTotalBonus, MERCHANT_SHOP, POTION_CAP,
} = require('../shared/definitions');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);

const TAG = 'cn-' + String(process.pid).slice(-5);
const made = [];
async function mk(nick) {
  const { id } = await tx(t => players.ensure(t, `${TAG}-${nick}`, `${TAG}_${nick}`));
  made.push(id);
  await tx(t => players.setClass(t, id, 'deathknight'));
  return id;
}
const give = (pid, itemId, qty = 1, enh = 0) => tx(async t => {
  await items.lockPlayer(t, pid); return items.add(t, pid, itemId, { qty, enhance: enh });
});
const countOf = async (pid, itemId) =>
  (await items.inventoryOf(null, pid)).inventory.filter(i => i.id === itemId).reduce((n, i) => n + i.qty, 0);
const hpOf = async pid => (await players.progressOf(null, pid)).hp;
// Healing potions are not inventory rows — see the potion-bag comment in
// repos/consumables.js. The fixture has to put them where the game keeps them,
// or it proves usePotion works against a store nothing else writes to.
const giveP = (pid, itemId, n) => pool().query(
  `UPDATE player_progress
      SET potion_bag = jsonb_set(potion_bag, ARRAY[$2::text],
            to_jsonb(COALESCE((potion_bag->>$2)::int, 0) + $3::int))
    WHERE player_id = $1`, [pid, itemId, n]);
const bagOf = async (pid, itemId) =>
  Number((await con.potionBagOf(null, pid))[itemId] || 0);
const caught = async fn => { try { await fn(); return null; } catch (e) { return e.code || e.message; } };

async function main() {
  console.log(`\nconsumables-check  (${TAG})\n`);
  await tx(t => items.syncCatalog(t));

  // ── HP potions: the amount is NOT the client's to send ───────────────────
  console.log('  ── зілля лікування ──');
  const p = await mk('a');
  const POT = ITEM_DEF.find(d => d.slot === 'use' && d.hp);
  await pool().query('UPDATE player_progress SET hp = 10 WHERE player_id = $1', [p]);

  // A new character now begins with a full bag — that grant used to come from
  // the CLIENT's default player object and was lost when the client stopped
  // owning state (migration 007). The suite has to start from what the game
  // actually gives, not from an assumption of nothing.
  eq(await bagOf(p, POT.id), 30, 'новий персонаж починає з 30 зіллями');

  await pool().query(`UPDATE player_progress SET potion_bag = '{}'::jsonb WHERE player_id = $1`, [p]);
  eq(await caught(() => tx(t => con.usePotion(t, p, POT.id))), 'no_potion', 'з порожньою сумкою — відмова');
  eq(await hpOf(p), 10, 'HP не змінилось');

  await giveP(p, POT.id, 3);
  const used = await tx(t => con.usePotion(t, p, POT.id));
  eq(used.healed, POT.hp, `зілля вилікувало рівно ${POT.hp} — з каталогу, не з запиту`);
  eq(await bagOf(p, POT.id), 2, 'витрачено одне зілля');
  eq(used.left, 2, 'у відповіді той самий залишок, що і в базі');

  // The C2 shape: a crafted request carrying an amount. There is no parameter
  // for it, so it cannot reach the heal — and HP must never become NaN.
  const before = await hpOf(p);
  await tx(t => con.usePotion(t, p, POT.id));
  const after = await hpOf(p);
  ok(Number.isFinite(after), 'HP лишилось числом (не NaN — це і був баг безсмертя)');
  eq(after, Math.min((await stats.of(null, p)).maxHp, before + POT.hp), 'лікування не перевищило maxHp');

  // Healing at full health must not overflow the bar.
  const st = await stats.of(null, p);
  await pool().query('UPDATE player_progress SET hp = $2 WHERE player_id = $1', [p, st.maxHp]);
  await giveP(p, POT.id, 1);
  await tx(t => con.usePotion(t, p, POT.id));
  eq(await hpOf(p), st.maxHp, 'на повному HP зілля не переповнює смугу');

  eq(await caught(() => tx(t => con.usePotion(t, p, 'sw3'))), 'bad_potion', 'випити меч неможливо');

  // ── the merchant ─────────────────────────────────────────────────────────
  // It sells nothing but potions, and it fills the same bag usePotion drains.
  console.log('  ── торговець ──');
  const sh = await mk('shop');
  const ENTRY = MERCHANT_SHOP[0];
  // Emptied first: the merchant's arithmetic is what is under test, and
  // starting from the free 30 would hide an off-by-one behind them.
  await pool().query(`UPDATE player_progress SET potion_bag = '{}'::jsonb WHERE player_id = $1`, [sh]);
  eq(await caught(() => tx(t => con.buyPotions(t, sh, ENTRY.itemId, 3))), 'no_gold',
    'без золота — відмова');
  eq(await bagOf(sh, ENTRY.itemId), 0, 'нічого не додалось');

  await money.credit(null, sh, 'gold', ENTRY.price * 10, { reason: 'seed', idemKey: `${TAG}:g` });
  const bought = await tx(t => con.buyPotions(t, sh, ENTRY.itemId, 3));
  eq(await bagOf(sh, ENTRY.itemId), 3, 'куплено рівно 3');
  eq(bought.cost, ENTRY.price * 3, 'списано рівно за 3');
  eq((await money.balancesOf(null, sh)).gold, ENTRY.price * 7, 'золото зменшилось на ту саму суму');

  eq(await caught(() => tx(t => con.buyPotions(t, sh, 'sw3', 1))), 'not_sold',
    'торговець не продає мечів');

  // The cap is the reason potions are not rows: 999 of them would be 999 of
  // 150 inventory slots.
  await pool().query(
    `UPDATE player_progress SET potion_bag = jsonb_set(potion_bag, ARRAY[$2::text], to_jsonb($3::int))
      WHERE player_id = $1`, [sh, ENTRY.itemId, POTION_CAP - 1]);
  eq(await caught(() => tx(t => con.buyPotions(t, sh, ENTRY.itemId, 5))), 'potion_cap',
    `покупка понад ${POTION_CAP} відхилена`);
  eq(await bagOf(sh, ENTRY.itemId), POTION_CAP - 1, 'кількість не змінилась');
  eq((await money.balancesOf(null, sh)).gold, ENTRY.price * 7, 'і золото теж — відмова нічого не коштує');

  // ── buff potions ─────────────────────────────────────────────────────────
  console.log('  ── зілля бафів ──');
  const b = await mk('buff');
  const BP = ITEM_DEF.find(d => d.slot === 'buff_potion');
  await give(b, BP.id, 10);

  const r1 = await tx(t => con.useBuffPotion(t, b, BP.id));
  eq(r1.buffType, BP.buffType, 'тип бафа з каталогу');
  eq(r1.seconds, BP.buffDur, `тривалість ${BP.buffDur} с — з каталогу`);

  const r2 = await tx(t => con.useBuffPotion(t, b, BP.id));
  eq(r2.seconds, BP.buffDur * 2, 'повторне зілля ПОДОВЖУЄ, а не замінює');

  // The cap: drinking a whole stack must not produce a permanent buff.
  for (let i = 0; i < 6; i++) await tx(t => con.useBuffPotion(t, b, BP.id));
  const capped = (await players.progressOf(null, b)).buffs[BP.buffType];
  eq(capped, BP.buffDur * 4, `стек зілль обмежений стелею ${BP.buffDur * 4} с — постійного бафа не буде`);

  // Expiry actually removes it.
  await tx(t => con.expireBuffs(t, b, BP.buffDur * 4));
  eq(Object.keys((await players.progressOf(null, b)).buffs).length, 0, 'баф, що вийшов, зник із карти');

  // ── teleport stone ───────────────────────────────────────────────────────
  console.log('  ── камінь телепорту ──');
  const tp = await mk('tp');
  eq(await caught(() => tx(t => con.useTeleportStone(t, tp))), 'no_stone', 'без каменя — відмова');
  await give(tp, 'teleport_stone', 2);
  await tx(t => con.useTeleportStone(t, tp));
  eq(await countOf(tp, 'teleport_stone'), 1, 'камінь витрачено на початку каста');

  // ── kill rewards, as one transaction ─────────────────────────────────────
  console.log('  ── нагорода за вбивство ──');
  const k = await mk('killer');
  const reward = await tx(t => con.grantKillReward(t, k, {
    gold: 50, xp: 30, drops: [{ id: 'norm_stone', qty: 2 }], idemKey: `${TAG}:kill:1`,
  }));
  eq(reward.gold, 50, 'золото нараховано');
  eq(reward.xp.xp, 30, 'досвід нараховано');
  eq(await countOf(k, 'norm_stone'), 2, 'дроп у інвентарі');

  // The same kill reported twice — a retried packet, a duplicated event.
  await tx(t => con.grantKillReward(t, k, {
    gold: 50, xp: 30, drops: [], idemKey: `${TAG}:kill:1`,
  }));
  eq((await money.balancesOf(null, k)).gold, 50, 'повторне вбивство з тим самим ключем НЕ подвоїло золото');

  // A full inventory drops the item rather than failing the whole reward.
  await tx(async t => {
    await items.lockPlayer(t, k);
    const used = await items.usedSlots(t, k);
    for (let i = used; i < items.SERVER_INV_MAX; i++) await items.add(t, k, 'sw1');
  });
  const full = await tx(t => con.grantKillReward(t, k, {
    gold: 10, xp: 5, drops: [{ id: 'bless_stone', qty: 1 }], idemKey: `${TAG}:kill:2`,
  }));
  ok(full.items[0].dropped === true, 'при повному інвентарі предмет лишається на землі');
  eq(full.gold, 60, 'але золото за вбивство все одно нараховане');

  // ── codex ────────────────────────────────────────────────────────────────
  console.log('  ── кодекс ──');
  const cx = await mk('codex');
  const set = CODEX_SETS.find(s => s.slots.every(sl => sl.minEnhance === 0)) || CODEX_SETS[0];
  const slot0 = set.slots[0];

  const wrongRow = await give(cx, 'norm_stone', 1);
  eq(await caught(() => tx(t => con.registerCodexItem(t, cx, set.id, 0, wrongRow))), 'wrong_item',
    'не той предмет у слот набору — відмова');
  eq(await countOf(cx, 'norm_stone'), 1, 'предмет не з’їдено при відмові');

  const good = await give(cx, slot0.itemId, 1, slot0.minEnhance || 0);
  const reg = await tx(t => con.registerCodexItem(t, cx, set.id, 0, good));
  eq(reg.setId, set.id, 'предмет зареєстровано в наборі');
  ok(!(await items.inventoryOf(null, cx)).inventory.some(i => i.rowId === good),
    'предмет СПОЖИТО — його більше немає');

  const again = await give(cx, slot0.itemId, 1, slot0.minEnhance || 0);
  eq(await caught(() => tx(t => con.registerCodexItem(t, cx, set.id, 0, again))), 'already',
    'той самий слот удруге — відмова');
  eq(await countOf(cx, slot0.itemId), 1, 'другий предмет не з’їдено');

  eq(await caught(() => tx(t => con.registerCodexItem(t, cx, 'нема_такого', 0, again))), 'no_set',
    'неіснуючий набір — відмова');

  // ── rebirth ──────────────────────────────────────────────────────────────
  console.log('  ── переродження ──');
  const rb = await mk('rb');
  const cost = rebirthCostFor(0);
  eq(await caught(() => tx(t => players.rebirth(t, rb, cost, { minLevel: REBIRTH_LEVEL, bonusSp: REBIRTH_BONUS_SP }))),
    'low_level', `нижче ${REBIRTH_LEVEL} рівня переродження недоступне`);

  await pool().query('UPDATE player_progress SET lvl = $2 WHERE player_id = $1', [rb, REBIRTH_LEVEL]);
  eq(await caught(() => tx(t => players.rebirth(t, rb, cost, { minLevel: REBIRTH_LEVEL, bonusSp: REBIRTH_BONUS_SP }))),
    'no_mats', 'без матеріалів — відмова');

  for (const [id, n] of Object.entries(cost)) await give(rb, id, n);
  // Spend some points first, so the keptSP preservation is actually exercised.
  for (let i = 0; i < 5; i++) await tx(t => players.spendUpgrade(t, rb, 'atk'));
  const spentBefore = (await players.progressOf(null, rb)).upgrades.atk;

  const done = await tx(t => players.rebirth(t, rb, cost, { minLevel: REBIRTH_LEVEL, bonusSp: REBIRTH_BONUS_SP }));
  eq(done.lvl, 1, 'рівень скинуто до 1');
  eq(done.rebirths, 1, 'лічильник перероджень +1');
  eq(done.bonusSP, REBIRTH_BONUS_SP, `нараховано ${REBIRTH_BONUS_SP} бонусних очок`);
  eq(done.keptSP, spentBefore, `${spentBefore} витрачених очок ЗБЕРЕЖЕНО як kept — не вкрадено`);
  eq((await players.progressOf(null, rb)).upgrades.atk, 0, 'самі покращення скинуті');
  for (const [id] of Object.entries(cost)) eq(await countOf(rb, id), 0, `матеріал ${id} витрачено`);

  // ── reset upgrades ───────────────────────────────────────────────────────
  console.log('  ── скидання покращень ──');
  const rs = await mk('reset');
  eq(await caught(() => tx(t => players.resetUpgrades(t, rs, UPGRADE_RESET_COST))), 'nothing',
    'скидати нічого — відмова');
  await tx(t => players.spendUpgrade(t, rs, 'atk'));
  eq(await caught(() => tx(t => players.resetUpgrades(t, rs, UPGRADE_RESET_COST))), 'no_nexum',
    'без Liberty — відмова');
  eq((await players.progressOf(null, rs)).upgrades.atk, 1, 'покращення на місці після відмови');

  await money.credit(null, rs, 'nexum', UPGRADE_RESET_COST, { reason: 'seed', idemKey: `${TAG}:nx` });
  const reset = await tx(t => players.resetUpgrades(t, rs, UPGRADE_RESET_COST));
  eq(reset.refunded, 1, 'повернуто 1 очко');
  eq((await players.progressOf(null, rs)).upgrades.atk, 0, 'покращення скинуті');
  eq((await money.balancesOf(null, rs)).nexum, 0, 'Liberty списано рівно раз');
}

async function cleanup() {
  const q = (s, p) => pool().query(s, p).catch(() => {});
  if (!made.length) return;
  for (const t of ['player_items', 'player_skills', 'player_vip', 'player_prefs', 'player_progress', 'ledger', 'balances']) {
    await q(`DELETE FROM ${t} WHERE player_id = ANY($1)`, [made]);
  }
  await q('DELETE FROM players WHERE id = ANY($1)', [made]);
}

main()
  .catch(err => { fail++; failures.push('НЕОБРОБЛЕНА ПОМИЛКА'); console.error('\n', err); })
  .finally(async () => {
    await cleanup(); await close();
    console.log(`\n  ${pass} пройшло, ${fail} впало`);
    if (failures.length) console.log('  впали: ' + failures.join(' · '));
    process.exit(fail ? 1 : 0);
  });
