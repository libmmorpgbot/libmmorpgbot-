#!/usr/bin/env node
'use strict';
// ── Proof that the client cannot write what it does not own ─────────────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/players-check.js
//
// The first block replays exploits that WORK against the live Mongo build.
// Each one is sent through savePrefs exactly as a modified client would send
// it, and the test passes only when the server-owned value is untouched
// afterwards. That is the difference between "the sanitizer strips it" and
// "there is no code path that would write it".

const { pool, tx, close } = require('../server/db');
const players = require('../server/db/repos/players');
const money = require('../server/db/repos/money');
const { upgradeCost } = require('../shared/definitions');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);

const TAG = 'pchk-' + process.pid;
const made = [];
async function mk(nick) {
  const { id } = await tx(t => players.ensure(t, `${TAG}-${nick}`, `${TAG}_${nick}`));
  made.push(id);
  return id;
}

async function main() {
  console.log(`\nplayers-check  (${TAG})\n`);
  const p = await mk('a');

  // Seed the server-owned values the exploits below try to reach.
  await pool().query(`UPDATE player_vip SET level = 2, pending = '{}', season_ticket = false WHERE player_id=$1`, [p]);
  await pool().query(`UPDATE player_progress SET lvl = 5, bonus_sp = 0 WHERE player_id=$1`, [p]);
  await money.credit(null, p, 'gram', 10, { reason: 'seed', idemKey: `${TAG}:seed` });

  console.log('  ── експлойти, які працюють на чинній збірці ──');

  // 1. THE dot-path write. On the live build this reaches Mongo as
  //    $set { 'savedData.vipPending.0': 10 } and claimVipRewards then hands
  //    out tier-10 items and gold for free.
  await tx(t => players.savePrefs(t, p, { 'vipPending.0': 10 }));
  let vip = (await pool().query('SELECT level, pending, season_ticket FROM player_vip WHERE player_id=$1', [p])).rows[0];
  eq(vip.pending.length, 0, 'ключ "vipPending.0" НЕ потрапив у нагороди VIP');
  eq(vip.level, 2, 'рівень VIP не змінився');

  // 2. Free season ticket — a permanent x2 xp / drop / Liberty bonus.
  await tx(t => players.savePrefs(t, p, { seasonTicket: true, vipLevel: 10, vipDeposited: 99999 }));
  vip = (await pool().query('SELECT level, season_ticket FROM player_vip WHERE player_id=$1', [p])).rows[0];
  eq(vip.season_ticket, false, 'сезонний білет не видався сам');
  eq(vip.level, 2, 'рівень VIP не піднявся');

  // 3. Money and level straight from the payload.
  await tx(t => players.savePrefs(t, p, { gold: 999999999, gram: 12345, lvl: 999, xp: 1e12, bonusSP: 5000 }));
  const prog = await players.progressOf(null, p);
  eq(prog.lvl, 5, 'рівень не переписався з payload');
  eq(prog.bonusSP, 0, 'очки навичок не нарахувались');
  eq((await money.balancesOf(null, p)).gram, 10, 'GRAM не змінився з payload');
  eq((await money.balancesOf(null, p)).gold, 0, 'золото не з’явилось з payload');

  // 4. Prototype pollution — an own "__proto__" key is what JSON.parse
  //    produces, unlike an object literal.
  const polluted = JSON.parse('{"__proto__":{"polluted":true},"lang":"en"}');
  await tx(t => players.savePrefs(t, p, polluted));
  ok({}.polluted === undefined, 'ключ __proto__ не забруднив прототип');

  // 5. Document bloat. On the live build every unknown key is stored, so a
  //    client can push ~500 KB per save until the 16 MB BSON ceiling bricks
  //    the account permanently.
  const junk = {};
  for (let i = 0; i < 2000; i++) junk['junk_' + i] = 'x'.repeat(200);
  const res = await tx(t => players.savePrefs(t, p, junk));
  eq(res.written, 0, 'зі 2000 сміттєвих ключів записано 0');
  eq(res.ignored, 2000, 'усі 2000 пораховані як проігноровані (видно в логах)');
  const size = (await pool().query(
    `SELECT pg_column_size(pr.*) AS n FROM player_prefs pr WHERE player_id=$1`, [p])).rows[0].n;
  ok(size < 400, `рядок налаштувань лишився малим (${size} байт) — роздути акаунт неможливо`);

  console.log('  ── що клієнту таки МОЖНА ──');

  const good = await tx(t => players.savePrefs(t, p, {
    lang: 'uk', autoHpPct: 0.75, autoSkillsOn: false, autoSkillOff: { Q: true, R: true },
  }));
  eq(good.written, 4, 'чотири дозволені поля записано');
  const prefs = await players.prefsOf(null, p);
  eq(prefs.lang, 'uk', 'мова збережена');
  eq(prefs.autoHpPct, 0.75, 'поріг автолікування збережений');
  eq(prefs.autoSkillsOn, false, 'автоскіли вимкнені');
  eq(JSON.stringify(prefs.autoSkillOff), '{"Q":true,"R":true}', 'вимкнені слоти збережені');

  const bad = await tx(t => players.savePrefs(t, p, {
    lang: 'klingon', autoHpPct: 42, autoSkillOff: { HACK: true },
  }));
  eq(bad.written, 0, 'дозволені ключі з негодящими значеннями не записані');
  eq(bad.rejected.length, 3, 'усі три названі у відповіді, а не проковтнуті');
  eq((await players.prefsOf(null, p)).lang, 'uk', 'попереднє значення вціліло');

  console.log('  ── прогресія ──');

  // xpToNext: 100, 138, 190, 262 — 500 XP from level 1 crosses three levels.
  const q = await mk('b');
  const up = await tx(t => players.grantXp(t, q, 500));
  eq(up.lvl, 4, '500 досвіду з 1-го рівня дає 4-й');
  eq(up.levelsGained, 3, 'зараховано 3 рівні за один виклик');
  eq(up.xp, 500 - 100 - 138 - 190, 'залишок досвіду порахований точно');

  // Concurrency: two grants must both land. A read-modify-write in JS loses
  // one of them; FOR UPDATE serialises them.
  //
  // 30 + 30, deliberately: xpToNext(1) is 100, so an earlier version of this
  // test used 50 + 50 and read back xp = 0 — which looked like both grants
  // vanishing and was in fact the level curve doing its job (100 XP at level 1
  // is exactly one level, leaving zero). Staying under the threshold isolates
  // "no lost update" from "the curve works", which is tested above.
  const r = await mk('c');
  await Promise.all([
    tx(t => players.grantXp(t, r, 30)),
    tx(t => players.grantXp(t, r, 30)),
  ]);
  const rp = await players.progressOf(null, r);
  eq(rp.xp, 60, 'два одночасні нарахування досвіду не загубились');
  eq(rp.lvl, 1, 'рівень не піднявся — 60 менше за поріг 100');

  // ── two budgets, not one ─────────────────────────────────────────────────
  // A stat point costs GOLD as well as a point. upgradeCost() — 300 for the
  // first point in a stat, 600 for the second, 900 for the third — sat in
  // shared/definitions.js under a comment saying the server charges it, and no
  // file in server/ referenced it: every point in the game was free from the
  // PostgreSQL port until spendUpgrade started spending. The assertions below
  // were written in that window and would now refuse for the wrong reason, so
  // each fixture is funded past what it spends: what they are about is the
  // POINT budget, and a test that runs out of money instead measures nothing.
  const threeInOne = upgradeCost(0) + upgradeCost(1) + upgradeCost(2);   // 300 + 600 + 900

  // Upgrade budget: level 1 grants 3 points.
  const u = await mk('d');
  await money.credit(null, u, 'gold', threeInOne + 10000, { reason: 'seed', idemKey: `${TAG}:upg-d` });
  for (let i = 0; i < 3; i++) ok(await tx(t => players.spendUpgrade(t, u, 'atk')) !== null, `очко ${i + 1} з 3 витрачено`);
  eq(await tx(t => players.spendUpgrade(t, u, 'def')), null, 'четверте очко понад бюджет — відмова');
  eq(Number((await money.balancesOf(null, u)).gold), 10000,
    `три очки коштували рівно ${threeInOne} золота`);

  // The race: one point left, two clicks.
  const v = await mk('e');
  await money.credit(null, v, 'gold', threeInOne + 10000, { reason: 'seed', idemKey: `${TAG}:upg-e` });
  await tx(t => players.spendUpgrade(t, v, 'atk'));
  await tx(t => players.spendUpgrade(t, v, 'atk'));
  const race = await Promise.all([
    tx(t => players.spendUpgrade(t, v, 'def')).catch(() => null),
    tx(t => players.spendUpgrade(t, v, 'hp')).catch(() => null),
  ]);
  eq(race.filter(Boolean).length, 1, 'два кліки на останнє очко — проходить РІВНО один');
  const uu = (await players.progressOf(null, v)).upgrades;
  eq(uu.atk + uu.def + uu.hp, 3, 'витрачено рівно 3 очки, не 4');

  // ── and the gold is a real gate, not a decoration ─────────────────────────
  // The point budget above has been guarded since the port; the price has
  // nothing watching it at all. Both halves of a refusal matter and they fail
  // in different ways: money.spend() fuses the affordability test into its own
  // UPDATE, so a purse one gold short must leave the purse alone AND leave the
  // point unspent — a charge that happens after the stat is written is a free
  // point, and a stat written after a failed charge is the same thing.
  const w = await mk('g');
  const first = upgradeCost(0);
  await money.credit(null, w, 'gold', first - 1, { reason: 'seed', idemKey: `${TAG}:upg-poor` });
  eq(await tx(t => players.spendUpgrade(t, w, 'atk')), null,
    `очко за ${first} золота з ${first - 1} у кишені — відмова`);
  eq((await players.progressOf(null, w)).upgrades.atk, 0, 'і очко НЕ витрачено');
  eq(Number((await money.balancesOf(null, w)).gold), first - 1,
    'і золото на місці — невдала купівля не списує нічого');
  // One gold more and the same call goes through, so the refusal above is the
  // PRICE and not something else standing in its way.
  await money.credit(null, w, 'gold', 1, { reason: 'seed', idemKey: `${TAG}:upg-poor2` });
  ok(await tx(t => players.spendUpgrade(t, w, 'atk')) !== null,
    `рівно ${first} — і очко купується`);
  eq(Number((await money.balancesOf(null, w)).gold), 0, 'списано рівно ціну, до нуля');

  // Skills cap at their maximum instead of climbing forever.
  const s = await mk('f');
  for (let i = 0; i < 12; i++) await tx(t => players.bumpSkill(t, s, 'passive', 'p1'));
  eq((await players.skillsOf(null, s)).passiveLevels.p1, 5, 'пасивка зупинилась на максимумі 5');

  // ensure() under a double login.
  // Tagged, like every other fixture in this file. A bare 'dup1' collides with
  // the leftovers of any run that died before cleanup — players.username is
  // UNIQUE — and the suite then fails on the wreckage of the last failure
  // rather than on anything the code did.
  const both = await Promise.all([
    tx(t => players.ensure(t, `${TAG}-dup`, `${TAG}_dup1`)),
    tx(t => players.ensure(t, `${TAG}-dup`, `${TAG}_dup2`)),
  ]);
  made.push(both[0].id);
  eq(both[0].id, both[1].id, 'два одночасні логіни дають ОДИН акаунт');
  eq(both.filter(x => x.isNew).length, 1, 'новим вважається рівно один із них');
}

async function cleanup() {
  if (!made.length) return;
  const q = (s, p) => pool().query(s, p).catch(() => {});
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
