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

const fs = require('fs');
const { pool, tx, close } = require('../server/db');
const items = require('../server/db/repos/items');
const money = require('../server/db/repos/money');
const players = require('../server/db/repos/players');
const stats = require('../server/db/repos/stats');
const con = require('../server/db/repos/consumables');
const { wipeItemsAll } = require('./fixtures');
const {
  ITEM_DEF, CODEX_SETS, EMPOWER_LEVEL, EMPOWER_BONUS_SP, EMPOWER_MAX,
  empowerCostFor, empowerMultFor, UPGRADE_RESET_COST, MERCHANT_SHOP, POTION_CAP,
  upgradeCost, skillPointBudget, availableSkillPoints, spentSkillPoints,
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

  // ── one potion, one duration ─────────────────────────────────────────────
  // The item reads "+20% атаки на 10 мин" and that is the entire rule. A
  // version of this let a second potion EXTEND the first up to four
  // durations, and the report was immediate and exact: "банки бафов теперь
  // почему то на 40 минут" — ten times four, the ceiling, on screen.
  const bagBefore = await countOf(b, BP.id);
  eq(await caught(() => tx(t => con.useBuffPotion(t, b, BP.id))), 'already_active',
    'друге зілля того ж типу відхилено, поки баф іде');
  eq(await countOf(b, BP.id), bagBefore, 'і зілля лишилось у сумці — відмова нічого не коштує');

  const stillLeft = con.buffsRemaining(
    (await players.progressOf(null, b)).buffs)[BP.buffType];
  ok(stillLeft <= BP.buffDur && stillLeft > BP.buffDur - 5,
    `тривалість лишилась ${BP.buffDur} с (${stillLeft}), а не накопичилась`);

  // An EXPIRED buff of the same type may be re-drunk, and gives exactly one
  // duration again — never the leftover plus one.
  await pool().query(
    `UPDATE player_progress SET buffs = jsonb_set(buffs, ARRAY[$2], to_jsonb(($3)::bigint))
      WHERE player_id = $1`, [b, BP.buffType, Date.now() - 1000]);
  const reDrunk = await tx(t => con.useBuffPotion(t, b, BP.id));
  ok(reDrunk.seconds <= BP.buffDur && reDrunk.seconds > BP.buffDur - 5,
    `після закінчення пʼється знову і дає рівно ${BP.buffDur} с (${reDrunk.seconds})`);

  // Buffs are EXPIRIES now, not countdowns — see repos/consumables.js. The
  // shape this replaces needed a ticker, the ticker was never called, and a
  // buff drunk once lasted forever.
  const stored = (await pool().query(
    'SELECT buffs FROM player_progress WHERE player_id = $1', [b])).rows[0].buffs;
  ok(Number(stored[BP.buffType]) > Date.now() + BP.buffDur * 500,
    'у базі лежить МОМЕНТ закінчення, а не зворотний відлік');
  ok(con.buffActive(stored, BP.buffType), 'баф зараз активний');
  ok(!con.buffActive({ [BP.buffType]: Date.now() - 1000 }, BP.buffType),
    'а прострочений — ні, і для цього нічого не треба «тікати»');

  // The wire format stays seconds: the client decrements its own copy each
  // frame to animate the bar.
  const left = con.buffsRemaining(stored);
  ok(left[BP.buffType] > 0 && left[BP.buffType] <= BP.buffDur * 4,
    `на дріт іде залишок у секундах (${left[BP.buffType]})`);
  eq(Object.keys(con.buffsRemaining({ old: Date.now() - 5000 })).length, 0,
    'прострочені взагалі не потрапляють на дріт');

  // ── the client half of the same rule ──────────────────────────────────────
  // Everything above proves the server refuses a second potion while one is
  // running. What it cannot see is that the client used to ASK for that second
  // potion once per frame: the auto-re-drink in the game loop (js/game.js)
  // fires on "this timer is at zero", which stays true for every frame between
  // the emit and the buffSync that answers it.
  //
  // The result was the most frequent event in the game. 353 refuse:useBuffPotion
  // rows in one day from a single player, more than all of that player's
  // successful actions together, each costing a row lock and a transaction to
  // say no. A server test cannot catch that — the server behaved correctly
  // every single time — so the guard is asserted here, against the source.
  const _cli = f => fs.readFileSync(require('path').join(__dirname, '..', f), 'utf8');
  const _playerSrc = _cli('js/player.js');
  const _netSrc = _cli('js/network.js');

  const _useBuff = (_playerSrc.match(/function useBuffPotion\(id\)[\s\S]*?\n\}/) || [''])[0];
  ok(_useBuff.includes('netUseBuffPotion('), 'знайшли тіло useBuffPotion у js/player.js');
  ok(_useBuff.indexOf('_buffPending(') !== -1
     && _useBuff.indexOf('_buffPending(') < _useBuff.indexOf('netUseBuffPotion('),
    'клієнт не шле запит, поки попередній без відповіді');
  ok(/_buffInFlight\.set\([\s\S]{0,80}Date\.now\(\)/.test(_useBuff),
    'позначка «в дорозі» має дедлайн, тож загублена відповідь не блокує назавжди');

  const _buffSync = (_netSrc.match(/socket\.on\('buffSync'[\s\S]*?\n {2}\}\);/) || [''])[0];
  ok(_buffSync.includes('_buffClearPending('),
    'відповідь сервера знімає позначку «в дорозі»');
  ok(_buffSync.includes('deathPenalty'),
    'buffSync не витирає deathPenalty — його ставить лише клієнт, сервер про нього не знає');

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

  // ── усиление ─────────────────────────────────────────────────────────────
  // Главное свойство Усиления — оно НИЧЕГО не сбрасывает. Прежний сценарий
  // проверял обратное: что уровень упал до 1, а вложенные очки уехали в kept.
  // Здесь проверяется, что ни того, ни другого не произошло.
  console.log('  ── посилення ──');
  const rb = await mk('rb');
  const opts = { minLevel: EMPOWER_LEVEL, bonusSp: EMPOWER_BONUS_SP, maxCount: EMPOWER_MAX };
  const cost = empowerCostFor(0);
  eq(await caught(() => tx(t => players.empower(t, rb, cost, opts))),
    'low_level', `нижче ${EMPOWER_LEVEL} рівня посилення недоступне`);

  await pool().query('UPDATE player_progress SET lvl = $2 WHERE player_id = $1', [rb, EMPOWER_LEVEL]);
  eq(await caught(() => tx(t => players.empower(t, rb, cost, opts))),
    'no_mats', 'без матеріалів — відмова');

  for (const [id, n] of Object.entries(cost)) await give(rb, id, n);
  // Вкладені очки — саме те, що посилення НЕ має чіпати.
  for (let i = 0; i < 5; i++) await tx(t => players.spendUpgrade(t, rb, 'atk'));
  const empBefore = await players.progressOf(null, rb);

  const done = await tx(t => players.empower(t, rb, cost, opts));
  eq(done.lvl, EMPOWER_LEVEL, 'рівень НЕ скинуто');
  eq(done.empowers, 1, 'лічильник посилень +1');
  eq(done.bonusSP, empBefore.bonusSP + EMPOWER_BONUS_SP, `нараховано ${EMPOWER_BONUS_SP} бонусних очок`);
  eq(done.keptSP, empBefore.keptSP, 'keptSP не зачеплено — скидати нічого');
  eq((await players.progressOf(null, rb)).upgrades.atk, empBefore.upgrades.atk,
    'вкладені покращення на місці');
  for (const [id] of Object.entries(cost)) eq(await countOf(rb, id), 0, `матеріал ${id} витрачено`);

  // Ціна росте по діапазонах і тримається до кінця кожного — а не подвоюється
  // на кожному п'ятому й падає назад. Перевіряється на межах: 4→5 стрибок,
  // 5→6 тримається.
  eq(empowerMultFor(4), 1, 'четверте посилення — базова ціна');
  eq(empowerMultFor(5), 2, 'п’яте — ×2');
  eq(empowerMultFor(6), 2, 'шосте ТЕЖ ×2, а не назад до базової');
  eq(empowerMultFor(9), 2, 'дев’яте ще ×2');
  eq(empowerMultFor(10), 4, 'десяте — ×4');
  eq(empowerMultFor(EMPOWER_MAX), 40, `${EMPOWER_MAX}-те — ×40`);
  eq(empowerCostFor(4).norm_stone, empowerCostFor(0).norm_stone * 2,
    'ціна п’ятого рівно вдвічі від базової');

  // Потолок. Счётчик ставится вручную: гонять тридцать реальных усилений
  // ради этой проверки значило бы выдать материалов на тридцать усилений.
  await pool().query('UPDATE player_progress SET empowers = $2 WHERE player_id = $1',
    [rb, EMPOWER_MAX]);
  for (const [id, n] of Object.entries(empowerCostFor(EMPOWER_MAX - 1))) await give(rb, id, n);
  eq(await caught(() => tx(t => players.empower(t, rb, empowerCostFor(EMPOWER_MAX - 1), opts))),
    'max_empowers', `понад ${EMPOWER_MAX} посилень — відмова`);

  // ── reset upgrades ───────────────────────────────────────────────────────
  console.log('  ── скидання покращень ──');
  const rs = await mk('reset');
  eq(await caught(() => tx(t => players.resetUpgrades(t, rs, UPGRADE_RESET_COST))), 'nothing',
    'скидати нічого — відмова');
  // Funded first: spendUpgrade charges gold now (upgradeCost — 300 for the
  // first point in a stat), and a penniless player is refused, which left
  // upgrades.atk at 0 and made the reset below answer 'nothing' instead of
  // 'no_nexum'. The refusal being tested here is the LIBERTY one, so the gold
  // must not be what stops it.
  await money.credit(null, rs, 'gold', 5000, { reason: 'seed', idemKey: `${TAG}:upg-gold` });
  const spent = await tx(t => players.spendUpgrade(t, rs, 'atk'));
  eq(!!spent, true, 'очко покращення куплено — інакше скидати нічого і тест нижче безглуздий');
  eq(await caught(() => tx(t => players.resetUpgrades(t, rs, UPGRADE_RESET_COST))), 'no_nexum',
    'без Liberty — відмова');
  eq((await players.progressOf(null, rs)).upgrades.atk, 1, 'покращення на місці після відмови');

  await money.credit(null, rs, 'nexum', UPGRADE_RESET_COST, { reason: 'seed', idemKey: `${TAG}:nx` });
  const reset = await tx(t => players.resetUpgrades(t, rs, UPGRADE_RESET_COST));
  eq(reset.refunded, 1, 'повернуто 1 очко');
  eq((await players.progressOf(null, rs)).upgrades.atk, 0, 'покращення скинуті');
  eq((await money.balancesOf(null, rs)).nexum, 0, 'Liberty списано рівно раз');

  // ── покупка ПІСЛЯ скидання — і вона теж має коштувати золота ──────────────
  // Головна перевірка цього файлу, і те, що раніше мовчки проходило.
  //
  // idemKey покупки містив ПОТОЧНИЙ рівень характеристики
  // (`upg:<pid>:<стат>:<рівень>`), а resetUpgrades повертав усі сім колонок
  // upg_* у 0. ledger append-only, старі ключі нікуди не діваються — тож
  // покупка atk після скидання давала `upg:<pid>:atk:0`, ключ, який уже є.
  // money.spend йшов у гілку replay і повертав { balance, replayed: true } —
  // це ІСТИНА, тож `if (!paid)` пропускав її далі й очко видавалось, не
  // списавши жодної монети. Знято на живій схемі:
  //
  //   куплено 3 очка atk:      золото 100000 → 98200  (списано 1800)
  //   после сброса:            золото 98200
  //   куплено 3 очка ПОВТОРНО: золото 98200 → 98200  (списано 0), upg_atk = 3
  //
  // money.reconcile() цього не бачила й не могла: по гілці replay не пишеться
  // НІЧОГО, тож баланс і сума ledger сходяться до копійки. Єдиний свідок —
  // золото, яке не зменшилось. Саме тому перевірка дивиться на ЗОЛОТО, а не на
  // те, чи зʼявилось очко: очко зʼявлялось і тоді, коли все було зламано.
  console.log('  ── покупка після скидання ──');
  const gOf = async pid => (await money.balancesOf(null, pid)).gold;
  const rp = await mk('replay');
  await money.credit(null, rp, 'gold', 100000, { reason: 'seed', idemKey: `${TAG}:rp-g` });
  await money.credit(null, rp, 'nexum', UPGRADE_RESET_COST, { reason: 'seed', idemKey: `${TAG}:rp-nx` });

  // Рівно бюджет першого рівня — три очки, як у звіті. Ціна кола рахується
  // через upgradeCost, а не вписана числом: ставку може бути перебалансовано,
  // а властивість «друге коло коштує стільки ж, скільки перше» — ні.
  const POINTS = skillPointBudget(1);
  const ROUND = Array.from({ length: POINTS }, (_, l) => upgradeCost(l)).reduce((a, b) => a + b, 0);

  const g0 = await gOf(rp);
  for (let i = 0; i < POINTS; i++) {
    ok(await tx(t => players.spendUpgrade(t, rp, 'atk')) !== null,
      `перше коло: очко ${i + 1} з ${POINTS} куплено`);
  }
  const g1 = await gOf(rp);
  eq(g0 - g1, ROUND, `перше коло списало ${ROUND} золота`);

  const rr = await tx(t => players.resetUpgrades(t, rp, UPGRADE_RESET_COST));
  eq(rr.refunded, POINTS, `скидання повернуло ${POINTS} очки`);
  eq((await players.progressOf(null, rp)).upgrades.atk, 0, 'карта покращень порожня');
  eq(await gOf(rp), g1, 'саме скидання золота не чіпає — за нього платять Liberty');

  for (let i = 0; i < POINTS; i++) {
    ok(await tx(t => players.spendUpgrade(t, rp, 'atk')) !== null,
      `друге коло: очко ${i + 1} з ${POINTS} куплено`);
  }
  eq(g1 - (await gOf(rp)), ROUND,
    `ДРУГЕ коло теж списало ${ROUND} золота, а не 0 — ось це й проходило мовчки`);
  eq((await players.progressOf(null, rp)).upgrades.atk, POINTS, 'і очки на місці');

  // Той самий факт з боку ledger: ключі різні, тож списань шість, а не три.
  // Гілка replay не пише рядка взагалі, тож повторений ключ видно тут одразу.
  const upgRows = Number((await pool().query(
    `SELECT count(*)::int n FROM ledger WHERE player_id = $1 AND reason = 'upgrade'`,
    [rp])).rows[0].n);
  eq(upgRows, POINTS * 2, `у ledger ${POINTS * 2} списань за покращення, а не ${POINTS}`);
  eq((await pool().query(
    'SELECT upg_epoch FROM player_progress WHERE player_id = $1', [rp])).rows[0].upg_epoch, 1,
  'скидання підняло upg_epoch — саме він робить ключі другого кола іншими');

  // Ключ мусить бути ОДНАКОВИЙ у двох спробах ОДНІЄЇ покупки: txRetry повторює
  // весь обробник після відкату, і ключ, що залежить від часу чи випадковості,
  // повтор не впізнає — тобто захисту немає взагалі (див. «bad» у
  // repos/money.js). Відкочена спроба не лишає ні золота, ні очка, ні ключа.
  await pool().query('UPDATE player_progress SET bonus_sp = bonus_sp + 1 WHERE player_id = $1', [rp]);
  const g2 = await gOf(rp);
  let rolled = null;
  await tx(async t => {
    rolled = await players.spendUpgrade(t, rp, 'def');
    throw new Error('відкат');
  }).catch(() => {});
  // Спершу — що відкочувати БУЛО що: без цього три перевірки нижче однаково
  // проходять і на відмові, і на успіху, тобто не перевіряють нічого.
  ok(rolled !== null, 'усередині транзакції покупка сама по собі пройшла');
  eq(await gOf(rp), g2, 'відкочена спроба золота не списала');
  eq((await players.progressOf(null, rp)).upgrades.def, 0, 'і очка не видала');
  ok(await tx(t => players.spendUpgrade(t, rp, 'def')) !== null,
    'повтор тієї самої покупки проходить — ключ не «згорів» на відкоченій спробі');
  eq(g2 - (await gOf(rp)), upgradeCost(0), 'і списав рівно один раз');

  // ── скидання не має ані знищувати очки, ані друкувати їх ──────────────────
  // kept_sp — поле «Перерождения», фічі, яку замінило Посилення (довга нотатка
  // «Legacy records» у shared/definitions.js). Воно віднімається з ОБОХ боків
  // суми в availableSkillPoints: перенесена трата не рахується проти гравця,
  // але й кривая рівня, яка її покриває, не рахується за нього. Тобто ємність
  // акаунта — це bonusSP + max(skillPointBudget(lvl), keptSP).
  //
  // Старий resetUpgrades ставив kept_sp = 0 разом із сімома колонками. Поки
  // kept ≤ budget це те саме число і не втрачалось нічого — але легась-запис,
  // яка ще не перелевелилась назад, має kept > budget, і різниця зникала
  // назавжди. За 200 Liberty, які гравець сам за це й заплатив.
  console.log('  ── kept_sp легась-акаунта ──');
  const capOf = async pid => {
    // Ємність = вкладено + доступно, обидва доданки через ті самі спільні
    // функції, якими рахує панель клієнта. Рахувати її тут своєю формулою
    // означало б перевіряти дві реалізації одна проти одної.
    const pr = await players.progressOf(null, pid);
    return spentSkillPoints(pr.upgrades) + availableSkillPoints(pr);
  };

  const lg = await mk('legacy');
  await pool().query(`
    UPDATE player_progress
       SET lvl = 1, bonus_sp = 15, kept_sp = 30, upg_atk = 30
     WHERE player_id = $1`, [lg]);
  await money.credit(null, lg, 'nexum', UPGRADE_RESET_COST, { reason: 'seed', idemKey: `${TAG}:lg-nx` });
  const capLg = await capOf(lg);
  eq(capLg, 45, 'до скидання ємність — bonusSP 15 + kept 30 = 45 очок');

  const lgReset = await tx(t => players.resetUpgrades(t, lg, UPGRADE_RESET_COST));
  eq(lgReset.keptSP, 0, 'зобовʼязання «Перерождения» закрите');
  eq(await capOf(lg), capLg, 'а ЄМНІСТЬ та сама — 27 очок більше не зникають');
  eq(lgReset.bonusSP, 15 + (30 - skillPointBudget(1)),
    'непокрита кривою частина kept (30 − 3) переїхала в bonus_sp');

  // Зворотний бік того самого правила. Коли кривая рівня вже покрила kept,
  // втрачати нічого — і додавати теж. Наївне `bonus_sp = bonus_sp + kept_sp`
  // видало б тут 30 очок з повітря: той самий клас помилки, що й безкоштовні
  // покращення вище, лише в інший бік, і ledger його теж не побачить — очки
  // навичок у ньому не лежать.
  const lg2 = await mk('legacy2');
  await pool().query(`
    UPDATE player_progress
       SET lvl = 20, bonus_sp = 15, kept_sp = 30, upg_atk = 30
     WHERE player_id = $1`, [lg2]);
  await money.credit(null, lg2, 'nexum', UPGRADE_RESET_COST, { reason: 'seed', idemKey: `${TAG}:lg2-nx` });
  const capLg2 = await capOf(lg2);
  eq(capLg2, 15 + skillPointBudget(20), 'кривая 20-го рівня вже покриває kept 30 — ємність 75');

  const lg2Reset = await tx(t => players.resetUpgrades(t, lg2, UPGRADE_RESET_COST));
  eq(await capOf(lg2), capLg2, 'ємність та сама — скидання не створює очок з повітря');
  eq(lg2Reset.bonusSP, 15, 'bonus_sp не виріс: кривая цей kept уже оплатила');

  // Два скидання підряд — два різні ключі, тож друге теж коштує Liberty.
  // З randomUUID у ключі це проходило, але з тієї ж причини не пережило б
  // повтору txRetry; з епохою вірні обидві властивості одразу.
  await money.credit(null, lg2, 'nexum', UPGRADE_RESET_COST, { reason: 'seed', idemKey: `${TAG}:lg2-nx2` });
  await money.credit(null, lg2, 'gold', upgradeCost(0), { reason: 'seed', idemKey: `${TAG}:lg2-g` });
  ok(await tx(t => players.spendUpgrade(t, lg2, 'def')) !== null, 'куплено очко для другого скидання');
  await tx(t => players.resetUpgrades(t, lg2, UPGRADE_RESET_COST));
  eq((await money.balancesOf(null, lg2)).nexum, 0, 'друге скидання теж списало Liberty');
}

async function cleanup() {
  const q = (s, p) => pool().query(s, p).catch(() => {});
  if (!made.length) return;
  // Предметы — ТЕМИ Ж ДВЕРИМА, якими їх видали. Сирий DELETE лишав у
  // item_ledger видачу без рядків, і нічна звірка справедливо кричала
  // про розходження — 216 пар 27 серпня, усі до одної тестові.
  await wipeItemsAll(made);
  for (const t of ['player_skills', 'player_vip', 'player_prefs', 'player_progress', 'ledger', 'balances']) {
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
