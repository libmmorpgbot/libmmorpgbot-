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

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);

const TAG = 'etl-' + String(process.pid).slice(-5);
const made = [];
let n = 0;
const tgOf = () => `${TAG}-${++n}`;

async function migrate(savedData, extra = {}) {
  const tg = tgOf();
  const doc = {
    telegramId: tg, username: `${TAG}_u${n}`, bm: 500,
    savedData, createdAt: new Date('2025-01-01'), ...extra,
  };
  const res = await etl.migratePlayer(doc);
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
}

async function cleanup() {
  const q = (s, p) => pool().query(s, p).catch(() => {});
  if (!made.length) return;
  for (const t of ['player_items', 'player_skills', 'player_vip', 'player_prefs',
                   'player_season', 'player_special_quests', 'player_daily',
                   'player_progress', 'ledger', 'balances', 'gram_tx']) {
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
