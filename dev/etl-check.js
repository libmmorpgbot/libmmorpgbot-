#!/usr/bin/env node
'use strict';
// ── Does the migration carry a player across intact? ────────────────────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/etl-check.js
//
// Feeds migratePlayer() documents in the OLD shape and checks what lands. No
// Mongo needed — the transform takes a plain object, and the cases that matter
// are far easier to construct than to find in a dump: an account with no
// savedData at all, an item id the catalog no longer knows, a forged xp figure,
// an equipment slot that does not exist.
//
// The last test is the one the real migration is gated on: after everything,
// reconcile() must be silent. A migrated balance has no history, so without the
// opening ledger entry every account reads as drifted and the alarm that says
// "money moved outside money.js" is permanently ringing.

const { pool, tx, close } = require('../server/db');
const etl = require('./etl');
const items = require('../server/db/repos/items');
const money = require('../server/db/repos/money');
const players = require('../server/db/repos/players');
const stats = require('../server/db/repos/stats');
const { xpToNext, ENHANCE_MAX } = require('../shared/definitions');
const { wipeItemsAll } = require('./fixtures');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);

const TAG = 'etl-' + String(process.pid).slice(-5);
const made = [];
let stuck = 0;          // скільки запитів прибирання база відмовила
const madeQuests = [];
let n = 0;
const tgOf = () => `${TAG}-${++n}`;

async function migrate(savedData, extra = {}, questIds = new Map()) {
  const tg = tgOf();
  const doc = {
    telegramId: tg, username: `${TAG}_u${n}`, bm: 500,
    savedData, createdAt: new Date('2025-01-01'), ...extra,
  };
  const res = await etl.migratePlayer(doc, questIds);
  if (res.playerId) made.push(res.playerId);
  return { ...res, tg };
}

async function main() {
  console.log(`\netl-check  (${TAG})\n`);
  await tx(t => items.syncCatalog(t));

  // ── an ordinary account ──────────────────────────────────────────────────
  console.log('  ── звичайний акаунт ──');
  const full = await migrate({
    type: 'deathknight', lvl: 24, xp: 120, kills: 4321,
    gold: 12500, gramBalance: 7.25, nexumBalance: 0.0000015,
    bonusSP: 15, keptSP: 8, rebirths: 1,
    upgrades: { atk: 10, def: 5, hp: 3, critChance: 2 },
    inventory: [{ id: 'sw3', enhance: 5 }, { id: 'norm_stone', qty: 40 }, { id: 'pt1', qty: 12 }],
    equipment: { weapon: { id: 'sw2', enhance: 3 } },
    storage: [{ id: 'bless_stone', qty: 7 }],
    skillLevels: { Q: 4, W: 2 }, passiveLevels: { p1: 3 },
    advSkillLearned: { Q: true }, advSkillActive: { Q: true },
    vipLevel: 3, vipDeposited: 42.5, vipPending: [2, 3],
    seasonTicket: true, seasonPoints2: 8400,
    lang: 'uk', autoHpPct: 0.8, floor: 3, x: 1200, y: 900,
    buffs: { atk: 300, gone: 0 },
    questIdx: 17, questKills: { 'Крыса страж': 6 },
  });
  ok(!full.skipped, 'акаунт перенесено');

  const prog = await players.progressOf(null, full.playerId);
  eq(prog.lvl, 24, 'рівень збережено');
  eq(prog.charClass, 'deathknight', 'клас збережено');
  eq(prog.bonusSP, 15, 'бонусні очки збережені');
  eq(prog.keptSP, 8, 'kept-очки збережені');
  eq(prog.rebirths, 1, 'переродження збережені');
  eq(prog.upgrades.atk, 10, 'вкладені очки збережені');
  eq(prog.questIdx, 17, 'прогрес квестів збережений');
  eq(prog.questKills['Крыса страж'], 6, 'лічильники вбивств збережені');

  const bal = await money.balancesOf(null, full.playerId);
  eq(bal.gold, 12500, 'золото перенесено');
  eq(bal.gram, 7.25, 'GRAM перенесено');
  eq(bal.nexum, 0.0000015, 'Liberty перенесено з 7-м знаком');

  const inv = await items.inventoryOf(null, full.playerId);
  eq(inv.inventory.length, 3, 'три предмети в інвентарі');
  eq(inv.storage.length, 1, 'один на складі');
  eq(inv.equipment.weapon.id, 'sw2', 'вдягнене на місці');
  eq(inv.equipment.weapon.enhance, 3, 'заточка вдягненого збережена');
  eq(inv.inventory.find(i => i.id === 'norm_stone').qty, 40, 'кількість у стеку збережена');
  eq(inv.inventory.find(i => i.id === 'sw3').enhance, 5, 'заточка в інвентарі збережена');

  const sk = await players.skillsOf(null, full.playerId);
  eq(sk.skillLevels.Q, 4, 'рівень навички збережено');
  eq(sk.passiveLevels.p1, 3, 'рівень пасивки збережено');
  eq(sk.advSkillActive.Q, true, 'активний просунутий навик збережено');

  const { rows: vip } = await pool().query(
    'SELECT level, deposited, pending, season_ticket FROM player_vip WHERE player_id=$1', [full.playerId]);
  eq(vip[0].level, 3, 'рівень VIP збережено');
  eq(vip[0].pending.join(','), '2,3', 'нагороди VIP у черзі збережені');
  eq(vip[0].season_ticket, true, 'сезонний білет збережено');

  const { rows: seas } = await pool().query(
    'SELECT points FROM player_season WHERE player_id=$1', [full.playerId]);
  eq(Number(seas[0].points), 8400, 'сезонні очки збережені');

  // Buffs cross a meaning boundary: the old save counted seconds down, the
  // column names the moment a buff ends. Carried across verbatim they would be
  // expiries in 1970 — every buff dead on arrival.
  const { rows: bf } = await pool().query(
    'SELECT buffs FROM player_progress WHERE player_id = $1', [full.playerId]);
  ok(Number(bf[0].buffs.atk) > Date.now(),
    `баф перенесено як момент закінчення в майбутньому (${bf[0].buffs.atk})`);
  ok(bf[0].buffs.gone === undefined, 'уже прострочений баф не переносився');

  const pf = await players.prefsOf(null, full.playerId);
  eq(pf.lang, 'uk', 'мова збережена');
  eq(pf.autoHpPct, 0.8, 'налаштування автолікування збережене');

  // The whole point: after migrating, combat power is computed from what
  // actually landed. If the items or upgrades did not carry, this number is
  // wrong, and it is the number players notice first.
  const st = await stats.of(null, full.playerId);
  ok(st.atk > 0 && st.maxHp > 0, `стати рахуються з перенесеного (atk ${st.atk}, hp ${st.maxHp})`);

  // ── idempotency ──────────────────────────────────────────────────────────
  console.log('  ── повторний прогін ──');
  const again = await etl.migratePlayer({
    telegramId: full.tg, username: 'other', savedData: { gold: 999999 },
  });
  eq(again.skipped, true, 'уже перенесений акаунт пропускається');
  eq((await money.balancesOf(null, full.playerId)).gold, 12500,
    'повторний прогін НЕ переписав баланс — це і робить ETL безпечним для повтору');

  // ── edge cases from real dumps ───────────────────────────────────────────
  console.log('  ── краї ──');

  const empty = await migrate(null);
  ok(!empty.skipped, 'акаунт із savedData: null переноситься');
  eq((await players.progressOf(null, empty.playerId)).lvl, 1, 'він отримує 1-й рівень, а не падає');

  const unknown = await migrate({ inventory: [{ id: 'sw1' }, { id: 'НЕМАЄ_ТАКОГО' }] });
  eq((await items.inventoryOf(null, unknown.playerId)).inventory.length, 1,
    'невідомий id відкинуто, відомий залишено');
  ok(etl.lost.unknownItems.has('НЕМАЄ_ТАКОГО'), 'втрачений id НАЗВАНО у звіті, а не проковтнуто');

  // A forged blob: level 3 claiming a trillion xp. Carrying that verbatim would
  // level the character to the ceiling on the first kill.
  const forged = await migrate({ lvl: 3, xp: 1e12, gold: -500, kills: -1 });
  const fp = await players.progressOf(null, forged.playerId);
  ok(fp.xp <= xpToNext(3), `підроблений досвід обрізано до кривої рівня (${fp.xp} ≤ ${xpToNext(3)})`);
  eq((await money.balancesOf(null, forged.playerId)).gold, 0, "від'ємне золото стало нулем");
  eq(fp.kills, 0, "від'ємні вбивства стали нулем");

  // An enhancement past the ceiling, and a slot name that does not exist.
  const weird = await migrate({
    equipment: { weapon: { id: 'sw1', enhance: 99 }, ВИГАДАНИЙ_СЛОТ: { id: 'sw2' } },
  });
  const wi = await items.inventoryOf(null, weird.playerId);
  eq(wi.equipment.weapon.enhance, ENHANCE_MAX, `заточка +99 обрізана до +${ENHANCE_MAX}`);
  eq(wi.inventory.length, 1, 'предмет із неіснуючого слота переїхав в інвентар, а не зник');
  eq(Object.keys(wi.equipment).length, 1, 'вигаданий слот не створено');

  // A blob carrying the exploited fields. They are structural now: vipPending
  // is a smallint[], seasonTicket a boolean — a dot-path key has nowhere to go.
  const exploited = await migrate({
    'vipPending.0': 10, seasonTicket: 'да', gramBalance: '1e309', lvl: '999999',
  });
  const ev = await pool().query('SELECT pending, season_ticket FROM player_vip WHERE player_id=$1', [exploited.playerId]);
  eq(ev.rows[0].pending.length, 0, 'ключ "vipPending.0" зі старого блоба нікуди не потрапив');
  eq(ev.rows[0].season_ticket, true, "рядок 'да' став булевим true — а не зламав вставку");
  eq((await money.balancesOf(null, exploited.playerId)).gram, 0, 'нескінченність у GRAM стала нулем');
  eq((await players.progressOf(null, exploited.playerId)).lvl, 1000, 'рівень обрізано до стелі схеми');

  // ── the account-shaped losses ────────────────────────────────────────────
  // Everything below costs a WHOLE ACCOUNT when it goes wrong, not a field.
  // The transform is one transaction whose first statement is the players
  // INSERT, so anything that raises there — a duplicate name, a number wider
  // than its column — takes the items and the balance down with it and leaves
  // a single ✗ line behind. These are the cases that produce it.
  console.log('  ── чого коштує один поганий рядок ──');

  // Mongo never made username unique and the value is a Telegram display name,
  // so two accounts called the same thing is ordinary. players.username is
  // citext UNIQUE.
  const shared = `${TAG}_dup`;
  const dupA = await migrate({ gold: 100 }, { username: shared });
  const dupB = await migrate({ gold: 200, inventory: [{ id: 'sw1' }] }, { username: shared });
  ok(!dupA.skipped && !dupB.skipped, 'обидва акаунти з однаковим іменем перенесено');
  eq((await money.balancesOf(null, dupB.playerId)).gold, 200,
    'другий не втратив баланс через чуже імʼя');
  eq((await items.inventoryOf(null, dupB.playerId)).inventory.length, 1,
    'і не втратив предмети — а саме це коштує падіння на UNIQUE');
  const { rows: dupName } = await pool().query('SELECT username FROM players WHERE id=$1', [dupB.playerId]);
  eq(String(dupName[0].username), `tg_${dupB.tg}`, 'він переїхав на запасне імʼя tg_<id>');
  ok(etl.lost.renamed.some(r => r.startsWith(dupB.tg)), 'перейменування НАЗВАНО у звіті');

  // A forged figure wider than its column raises 22003 on INSERT, and the
  // whole account goes with it. Clamping costs the forger the forgery.
  const huge = await migrate({ gold: 1e30, kills: 1e25, inventory: [{ id: 'sw1' }] }, { bm: 1e20 });
  ok(!huge.skipped, 'акаунт із числом ширшим за колонку не впав цілком');
  eq((await items.inventoryOf(null, huge.playerId)).inventory.length, 1,
    'його предмети на місці — заради цього число і обрізається');
  ok((await money.balancesOf(null, huge.playerId)).gold > 0, 'золото обрізане, а не занулене');

  // ── речі, які легко не помітити ──────────────────────────────────────────
  console.log('  ── тихі втрати ──');

  // Before potionBag existed the save carried a single `potions` integer.
  // Reading only potionBag hands such an account an empty bag and no way to
  // heal — and 007's default of 30 does not save them, because an explicit
  // {} overrides a default.
  const legacyPot = await migrate({ potions: 250 });
  const { rows: lp } = await pool().query(
    'SELECT potion_bag FROM player_progress WHERE player_id=$1', [legacyPot.playerId]);
  eq(Number(Object.values(lp[0].potion_bag)[0]), 250, 'старе поле potions переїхало в potionBag');

  // `level` is the legacy spelling of `lvl`. A blob carrying only it would
  // otherwise arrive at level 1 with its gear intact, which reads as a wipe.
  const legacyLvl = await migrate({ level: 31, type: 'mage' });
  eq((await players.progressOf(null, legacyLvl.playerId)).lvl, 31, 'старе поле level дало рівень, а не 1');

  // migration 011 asks "where did this sword come from". items.add() stamps
  // every other grant path; this INSERT is the only one that bypasses it.
  const { rows: src } = await pool().query(
    'SELECT source FROM player_items WHERE player_id=$1 LIMIT 1', [full.playerId]);
  eq(src[0].source, 'migration', 'перенесений предмет знає, звідки він — source=migration');

  // Mongo allowed 500 inventory slots, the game considers 150 full. Nothing is
  // dropped, but past the cap drops stop being picked up — so it is counted.
  const fat = await migrate({ inventory: Array.from({ length: 151 }, () => ({ id: 'sw1' })) });
  eq((await items.inventoryOf(null, fat.playerId)).inventory.length, 151,
    'усі 151 предмет перенесено — обрізати інвентар не можна');
  ok(etl.lost.overCap.some(r => r.startsWith(fat.tg)), 'переповнений інвентар НАЗВАНО у звіті');

  // ── the once-only claims ─────────────────────────────────────────────────
  // specialQuestsDone is the ONLY record that a one-time reward was paid. Lose
  // it and every migrated player claims every special quest a second time.
  console.log('  ── відмітки спецквестів ──');
  const { rows: sq } = await pool().query(`
    INSERT INTO special_quests (title, description, type, url, icon, reward_gold)
    VALUES ($1,'','link','','*',500) RETURNING id`, [`${TAG}_quest`]);
  madeQuests.push(Number(sq[0].id));
  const claimed = await migrate(
    { specialQuestsDone: ['65f000000000000000000001', '65f000000000000000000009'] },
    {}, new Map([['65f000000000000000000001', Number(sq[0].id)]]));
  const { rows: pq } = await pool().query(
    'SELECT quest_id FROM player_special_quests WHERE player_id=$1', [claimed.playerId]);
  eq(pq.length, 1, 'отриману нагороду записано — вдруге її вже не забрати');
  eq(Number(pq[0].quest_id), Number(sq[0].id), 'записано саме той квест');
  ok(etl.lost.questClaimsLost.some(r => r.startsWith(claimed.tg)),
    'відмітка про квест, якого вже немає, НАЗВАНА, а не проковтнута');

  // ── THE GATE ─────────────────────────────────────────────────────────────
  console.log('  ── звірка після переносу ──');
  const mine = made.map(Number);
  const drift = (await money.reconcile(null)).filter(r => mine.includes(r.playerId));
  eq(drift.length, 0,
    'звірка чиста: у кожного перенесеного балансу є відкриваючий запис у леджері');

  // And prove the opening entry is what makes it so — the check has teeth.
  const { rows: led } = await pool().query(
    `SELECT currency, reason, delta FROM ledger WHERE player_id = $1 ORDER BY currency`, [full.playerId]);
  eq(led.length, 3, 'три відкриваючі записи — золото, GRAM, Liberty');
  ok(led.every(l => l.reason === 'migration_opening'), 'усі позначені як migration_opening');
  // Found by CURRENCY, because `led.find(l => Number(l.delta) === 12500).delta`
  // used the search term as the answer: whatever row satisfied the predicate
  // was then asserted to satisfy it, so the only outcome that was not a PASS
  // was no row matching at all — and that is a TypeError on `.delta`, which
  // this file reports as НЕОБРОБЛЕНА ПОМИЛКА rather than as the balance the
  // label names. Each of the three is now read by name and compared against the
  // figure the old blob carried, which is the actual claim: an opening entry
  // written for the wrong currency, or rounded, fails here.
  const opening = (c) => { const r = led.find(l => l.currency === c); return r ? Number(r.delta) : null; };
  eq(opening('gold'), 12500, 'відкриваючий запис золота дорівнює перенесеному балансу');
  eq(opening('gram'), 7.25, 'і GRAM — до сотої');
  eq(opening('nexum'), 0.0000015, 'і Liberty — до сьомого знаку');

  // ── ТІ САМІ ВОРОТА ДЛЯ ПРЕДМЕТІВ ─────────────────────────────────────────
  // Грошова половина цих воріт стояла з самого початку. Предметної не було —
  // і саме ту дірку, яку вона мала б ловити, файл і містив: dev/etl.js не
  // згадував item_ledger жодного разу, тож кожен перенесений гравець із
  // будь-яким майном дав би розходження на весь інвентар.
  //
  // Це не «одна зайва тривога». Сверка предметів існує, щоб ловити речі, що
  // взялися з нізвідки. Тривога, яка після переносу кричить на всіх,
  // вимикається — і наступне справжнє дублювання ховається у вимкненій.
  const idrift = (await items.reconcile(null)).filter(r => mine.includes(r.playerId));
  eq(idrift.length, 0,
    'звірка предметів чиста: у кожного перенесеного предмета є відкриваючий запис',
    idrift.slice(0, 3).map(d => `${d.playerId}/${d.itemId}: на руках ${d.held}, журнал ${d.ledgerTotal}`).join(' · '));

  // І що саме відкриваючий запис це робить — інакше твердження вище пройшло б
  // і на акаунті, у якого просто немає предметів.
  const { rows: iled } = await pool().query(
    `SELECT item_id, reason, delta, qty_after FROM item_ledger
      WHERE player_id = $1 ORDER BY item_id`, [full.playerId]);
  ok(iled.length > 0, 'відкриваючі записи предметів взагалі є', `рядків ${iled.length}`);
  ok(iled.every(l => l.reason === 'migration_opening'), 'усі позначені як migration_opening');
  // Журнал має збігтися з тим, що РЕАЛЬНО лежить у player_items, а не з тим,
  // що ми думаємо, ніби туди поклали.
  const { rows: heldRows } = await pool().query(
    `SELECT item_id, sum(qty)::int AS qty FROM player_items
      WHERE player_id = $1 GROUP BY item_id ORDER BY item_id`, [full.playerId]);
  eq(iled.length, heldRows.length, 'по одному запису на кожен предмет, який є на руках');
  ok(heldRows.every(h => {
    const l = iled.find(x => x.item_id === h.item_id);
    return l && Number(l.delta) === Number(h.qty) && Number(l.qty_after) === Number(h.qty);
  }), 'і кількість у записі дорівнює тій, що на руках — по кожному предмету',
     heldRows.map(h => `${h.item_id}:${h.qty}`).join(' '));
}

async function cleanup() {
  // НЕ .catch(() => {}). Саме тут сміття й накопичувалось мовчки: DELETE на
  // `ledger` застосунку відкликано (гроші не можна стирати), цей рядок падав
  // беззвучно, далі DELETE FROM players впирався у той самий зовнішній ключ —
  // і акаунт лишався жити разом з усім своїм розходженням у предметах.
  // Шість фікстур за прогін, і жодного слова про це. Купка з датою 2025-01-01
  // у нічній тривозі — рівно ця.
  const q = async (sql, prm) => {
    try { await pool().query(sql, prm); } catch (e) {
      stuck++;
      console.error('  ! прибирання не пройшло: ' + String(e.message).slice(0, 140));
    }
  };
  // The quest rows go LAST. quest_id carries no foreign key, so nothing would
  // refuse the other order — which is exactly why it is written down: removing
  // the quest first leaves a claim row naming a quest that no longer exists,
  // and that is the shape this file is here to detect, not to create.
  const dropQuests = async () => {
    if (madeQuests.length) await q('DELETE FROM special_quests WHERE id = ANY($1)', [madeQuests]);
  };
  if (!made.length) { await dropQuests(); return; }
  // Предметы — ТЕМИ Ж ДВЕРИМА, якими їх видали. Сирий DELETE лишав у
  // item_ledger видачу без рядків, і нічна звірка справедливо кричала
  // про розходження — 216 пар 27 серпня, усі до одної тестові.
  await wipeItemsAll(made);
  for (const t of ['player_skills', 'player_vip', 'player_prefs',
                   'player_season', 'player_special_quests', 'player_daily',
                   'player_progress', 'ledger', 'balances', 'gram_tx']) {
    await q(`DELETE FROM ${t} WHERE player_id = ANY($1)`, [made]);
  }
  await q('DELETE FROM players WHERE id = ANY($1)', [made]);
  await dropQuests();
}

main()
  .catch(err => { fail++; failures.push('НЕОБРОБЛЕНА ПОМИЛКА'); console.error('\n', err); })
  .finally(async () => {
    await cleanup(); await close();
    console.log(`\n  ${pass} пройшло, ${fail} впало`);
    if (failures.length) console.log('  впали: ' + failures.join(' · '));
    if (stuck) {
      console.log(`  ! ${stuck} запитів прибирання відмовлено — фікстури лишились у базі`);
      console.log('    прибрати можна лише bash /srv/liberty/purge-test.sh (потрібен doadmin)');
    }
    process.exit(fail ? 1 : 0);
  });
