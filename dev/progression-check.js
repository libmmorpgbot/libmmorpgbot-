#!/usr/bin/env node
'use strict';
// ── Proof that a once-only reward happens once ──────────────────────────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/progression-check.js
//
// Every rule here used to be a value the client sent back, and every one was
// exploited before it was pinned. The tests are the double-claim races: the
// same reward requested twice at the same instant, which is what a modified
// client (or a retried packet) actually produces.

const { pool, tx, txRetry, close } = require('../server/db');
const items = require('../server/db/repos/items');
const money = require('../server/db/repos/money');
const players = require('../server/db/repos/players');
const prog = require('../server/db/repos/progression');
const { VIP_THRESHOLDS, SEASON_REF_POINTS, SEASON_REF_LEVEL } = require('../shared/definitions');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);

const TAG = 'gchk-' + String(process.pid).slice(-5);
const made = []; let questId = null;
async function mk(nick) {
  const { id } = await tx(t => players.ensure(t, `${TAG}-${nick}`, `${TAG}_${nick}`));
  made.push(id); return id;
}
const gold = async id => (await money.balancesOf(null, id)).gold;
const caught = async fn => { try { await fn(); return null; } catch (e) { return e.code || e.message; } };

async function main() {
  console.log(`\nprogression-check  (${TAG})\n`);
  await tx(t => items.syncCatalog(t));

  const { rows: q } = await pool().query(`
    INSERT INTO special_quests (title, reward_gold, reward_nexum)
    VALUES ($1, 500, 2) RETURNING id`, [`${TAG} quest`]);
  questId = Number(q[0].id);

  // ── special quests: the reward that was claimable again ──────────────────
  const p = await mk('a');
  const first = await tx(t => prog.claimSpecialQuest(t, p, questId));
  eq(first.gold, 500, 'нагороду за спецквест видано');
  eq(await gold(p), 500, 'золото зараховане');

  eq(await caught(() => tx(t => prog.claimSpecialQuest(t, p, questId))), 'already',
    'той самий спецквест удруге — відмова');
  eq(await gold(p), 500, 'повторна спроба нічого не додала');

  // The double-tap: both requests in flight at once.
  const p2 = await mk('b');
  const race = await Promise.all([
    txRetry(t => prog.claimSpecialQuest(t, p2, questId)).catch(() => null),
    txRetry(t => prog.claimSpecialQuest(t, p2, questId)).catch(() => null),
  ]);
  eq(race.filter(Boolean).length, 1, 'два одночасні запити нагороди — виплата РІВНО одна');
  eq(await gold(p2), 500, 'золота нарахованого рівно на одну виплату');
  eq((await prog.claimedSpecialQuests(null, p2)).length, 1, 'запис про отримання один');

  // ── VIP: tiers accrue from real spending, and collect once ───────────────
  const v = await mk('vip');
  const t1 = await tx(t => prog.addVipSpend(t, v, VIP_THRESHOLDS[1]));
  eq(t1.level, 1, `витрата ${VIP_THRESHOLDS[1]} GRAM дає VIP 1`);
  eq(JSON.stringify(t1.newTiers), '[1]', 'нарахований рівно один новий рівень');

  const t3 = await tx(t => prog.addVipSpend(t, v, VIP_THRESHOLDS[3] - VIP_THRESHOLDS[1]));
  eq(t3.level, 3, 'дострибнули до VIP 3');
  eq(JSON.stringify(t3.newTiers), '[2,3]', 'обидва пропущені рівні потрапили в нагороди');
  eq((await prog.vipOf(null, v)).pending.join(','), '1,2,3', 'до отримання чекають три рівні');

  const grant = tier => [{ id: 'sw1', qty: 1 }];
  const claimed = await tx(t => prog.claimVip(t, v, grant));
  eq(claimed.tiers.join(','), '1,2,3', 'забрано всі три рівні');
  eq(claimed.granted.length, 3, 'видано три предмети');
  eq((await prog.vipOf(null, v)).pending.length, 0, 'черга нагород порожня');

  const again = await tx(t => prog.claimVip(t, v, grant));
  eq(again.tiers.length, 0, 'повторне отримання не видає нічого');
  eq((await items.inventoryOf(null, v)).inventory.length, 3, 'предметів так само три');

  // The double-tap that handed out the whole set twice on the old code.
  const v2 = await mk('vip2');
  await tx(t => prog.addVipSpend(t, v2, VIP_THRESHOLDS[2]));
  const vr = await Promise.all([
    txRetry(t => prog.claimVip(t, v2, grant)).catch(() => ({ tiers: [] })),
    txRetry(t => prog.claimVip(t, v2, grant)).catch(() => ({ tiers: [] })),
  ]);
  eq(vr.reduce((n, r) => n + r.tiers.length, 0), 2, 'два одночасні отримання видали рівно 2 рівні разом');
  eq((await items.inventoryOf(null, v2)).inventory.length, 2, 'предметів рівно 2, не 4');

  // A full inventory must leave the tiers claimable, not consume them.
  const v3 = await mk('vip3');
  await tx(t => prog.addVipSpend(t, v3, VIP_THRESHOLDS[1]));
  await tx(async t => {
    await items.lockPlayer(t, v3);
    for (let i = 0; i < items.SERVER_INV_MAX; i++) await items.add(t, v3, 'sw1');
  });
  eq(await caught(() => tx(t => prog.claimVip(t, v3, grant))), 'no_room', 'повний інвентар — відмова');
  eq((await prog.vipOf(null, v3)).pending.length, 1, 'рівень лишився в черзі, а не згорів');

  // Season ticket: once per account, even under two simultaneous purchases.
  const st = await mk('ticket');
  const tickets = await Promise.all([
    tx(t => prog.grantSeasonTicket(t, st)),
    tx(t => prog.grantSeasonTicket(t, st)),
  ]);
  eq(tickets.filter(Boolean).length, 1, 'сезонний білет видається РІВНО один раз');

  // ── season points ────────────────────────────────────────────────────────
  const s1 = await mk('s1'), s2 = await mk('s2');
  await Promise.all([
    tx(t => prog.addSeasonPoints(t, s1, 300)),
    tx(t => prog.addSeasonPoints(t, s1, 200)),
  ]);
  eq((await prog.seasonOf(null, s1)).points, 500, 'два одночасні нарахування очок не загубились');
  await tx(t => prog.addSeasonPoints(t, s2, 900));

  const board = await prog.seasonBoard(null, { limit: 200 });
  const mineOnBoard = board.filter(b => made.includes(b.playerId));
  eq(mineOnBoard[0].playerId, s2, 'у таблиці лідер той, у кого більше очок');
  ok(mineOnBoard[0].place < mineOnBoard[1].place, 'місця впорядковані');

  // Referral bonus: paid once per invited friend, and the flag lives on the
  // FRIEND — on the old model it was in the friend's own blob, so clearing it
  // paid the referrer again on the next login.
  const friend = await mk('friend'), ref = await mk('ref');
  eq(await tx(t => prog.paySeasonReferral(t, friend, ref, SEASON_REF_LEVEL - 1)), null,
    'нижче порогового рівня бонус не платиться');
  const paid = await tx(t => prog.paySeasonReferral(t, friend, ref, SEASON_REF_LEVEL));
  eq(paid, SEASON_REF_POINTS, 'бонус за друга нарахований');
  eq(await tx(t => prog.paySeasonReferral(t, friend, ref, SEASON_REF_LEVEL)), null,
    'за того самого друга вдруге не платиться');
  eq((await prog.seasonOf(null, ref)).points, SEASON_REF_POINTS, 'у реферера рівно один бонус');

  // ── daily attempts ───────────────────────────────────────────────────────
  const d = await mk('daily');
  eq(await prog.attemptsLeft(null, d, 'fear', 3), 3, 'на початку доби 3 спроби');
  ok(await tx(t => prog.takeAttempt(t, d, 'fear', 3)), 'спроба 1 взята');
  ok(await tx(t => prog.takeAttempt(t, d, 'fear', 3)), 'спроба 2 взята');
  ok(await tx(t => prog.takeAttempt(t, d, 'fear', 3)), 'спроба 3 взята');
  eq(await tx(t => prog.takeAttempt(t, d, 'fear', 3)), null, 'четверта спроба — відмова');
  eq(await prog.attemptsLeft(null, d, 'fear', 3), 0, 'спроб не лишилось');

  // Modes are independent — spending Fear must not touch Coop.
  eq(await prog.attemptsLeft(null, d, 'coop', 2), 2, 'ліміти режимів незалежні');

  // The race: one attempt left, two entries at once.
  const d2 = await mk('daily2');
  await tx(t => prog.takeAttempt(t, d2, 'fear', 2));
  const dr = await Promise.all([
    tx(t => prog.takeAttempt(t, d2, 'fear', 2)),
    tx(t => prog.takeAttempt(t, d2, 'fear', 2)),
  ]);
  eq(dr.filter(Boolean).length, 1, 'два одночасні входи на останню спробу — проходить РІВНО один');
  eq(await prog.attemptsLeft(null, d2, 'fear', 2), 0, 'витрачено рівно 2 з 2');

  // Minutes budget for the elite farm zone.
  const f = await mk('farm');
  const BUDGET = 7200;
  await tx(t => prog.spendSeconds(t, f, 'farm2', 3000, BUDGET));
  eq(await prog.secondsLeft(null, f, 'farm2', BUDGET), 4200, 'списано 3000 секунд');
  const capped = await tx(t => prog.spendSeconds(t, f, 'farm2', 99999, BUDGET));
  eq(capped.left, 0, 'бюджет не йде в мінус — обрізається по нулю');
}

async function cleanup() {
  const q = (s, p) => pool().query(s, p).catch(() => {});
  if (questId) {
    await q('DELETE FROM player_special_quests WHERE quest_id = $1', [questId]);
    await q('DELETE FROM special_quests WHERE id = $1', [questId]);
  }
  if (!made.length) return;
  for (const t of ['player_daily', 'player_season', 'player_special_quests', 'player_items',
                   'player_skills', 'player_vip', 'player_prefs', 'player_progress', 'ledger', 'balances']) {
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
