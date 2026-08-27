#!/usr/bin/env node
'use strict';
// ── VIP, the season card and the buff potions ───────────────────────────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/bonuses-check.js
//
// "Вип бонусы, бонусы от сезонной карты, зелья бафов — не работают."
//
// All three were the same shape of bug, and none of them threw: a value
// defined in shared/definitions.js that nothing on the server ever read.
//
//   VIP_BONUSES has xp, gold and drop columns. Only `drop` was read, so VIP 10
//   paid exactly what VIP 0 paid.
//
//   SEASON_TICKET_XP_PCT — the x2 experience that IS the card — appeared in no
//   file outside its own definition. Nor did SEASON_TICKET_LIBERTY_PCT.
//
//   Six buff potions write a buff into player_progress.buffs. Three of them —
//   exp, gold, regen — were read by nothing. Bought, dropped, drunk, no effect.
//
//   And NEXUM_DROP_CHANCE never came across from the retired handler file at
//   all, so `result.nexum` was read, passed on and emitted while nothing ever
//   set it: Liberty did not drop from monsters.
//
// A test for this class cannot be "does it error" — none of them did. It has to
// read the number that comes out and compare it against the number the item's
// own text promises.

const fs = require('fs');
const path = require('path');
const { pool, tx, close } = require('../server/db');
const players = require('../server/db/repos/players');
const money = require('../server/db/repos/money');
const stats = require('../server/db/repos/stats');
const consumables = require('../server/db/repos/consumables');
const items = require('../server/db/repos/items');
const { wipeItemsAll } = require('./fixtures');
const {
  VIP_BONUSES, SEASON_TICKET_XP_PCT, SEASON_TICKET_LIBERTY_PCT,
  SEASON_TICKET_DROP_PCT, NEXUM_DROP_CHANCE, GRAM_DROP_CHANCE, GRAM_PER_LEVEL, ITEM_DEF,
} = require('../shared/definitions');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);

const TAG = 'bon-' + String(process.pid).slice(-5);
const made = [];
async function mk(nick) {
  const { id } = await tx(t => players.ensure(t, `${TAG}-${nick}`, `${TAG}_${nick}`));
  made.push(id);
  await tx(t => players.setClass(t, id, 'deathknight'));
  // A real level: at level 1 the base attack is small enough that +20% floors
  // straight back to the same integer, which measures rounding rather than the
  // buff.
  await pool().query('UPDATE player_progress SET lvl = 40 WHERE player_id = $1', [id]);
  return id;
}
const setBuff = (pid, type, ms) => pool().query(
  `UPDATE player_progress
      SET buffs = jsonb_set(COALESCE(buffs, '{}'::jsonb), ARRAY[$2], to_jsonb($3::bigint), true)
    WHERE player_id = $1`, [pid, type, Date.now() + ms]);

async function main() {
  console.log(`\nbonuses-check  (${TAG})\n`);
  await tx(t => items.syncCatalog(t));

  // ── the tables say what they promise ─────────────────────────────────────
  console.log('  ── що обіцяно ──');
  ok(VIP_BONUSES[10] && VIP_BONUSES[10].xp > 0 && VIP_BONUSES[10].gold > 0,
    `VIP 10 обіцяє +${VIP_BONUSES[10].xp}% досвіду і +${VIP_BONUSES[10].gold}% золота`);
  eq(SEASON_TICKET_XP_PCT, 100, 'сезонна картка обіцяє x2 досвіду');
  ok(SEASON_TICKET_DROP_PCT > 0 && SEASON_TICKET_LIBERTY_PCT > 0,
    `і +${SEASON_TICKET_DROP_PCT} до лута та +${SEASON_TICKET_LIBERTY_PCT}% до шансу Liberty`);
  ok(Array.isArray(NEXUM_DROP_CHANCE) && NEXUM_DROP_CHANCE.some(c => c > 0),
    'Liberty має падати з мобів — таблиця шансів на місці');
  ok(GRAM_DROP_CHANCE > 0 && GRAM_PER_LEVEL > 0,
    `і GRAM теж — ${GRAM_DROP_CHANCE * 100}% шанс, ${GRAM_PER_LEVEL} за рівень`);

  // ── the buff potions ─────────────────────────────────────────────────────
  // Every potion in the catalog must move something. The three that did not —
  // exp, gold, regen — are the report.
  console.log('\n  ── зілля бафів ──');
  const potions = ITEM_DEF.filter(i => i.slot === 'buff_potion');
  eq(potions.length, 6, 'шість зіль бафів у каталозі');

  const p = await mk('buff');
  const base = await stats.of(null, p);

  // hp, atk, atkspeed live in the stat block.
  await setBuff(p, 'hp', 60000);
  ok((await stats.of(null, p)).maxHp > base.maxHp, 'зілля HP піднімає максимум здоровʼя');
  await pool().query(`UPDATE player_progress SET buffs = '{}'::jsonb WHERE player_id = $1`, [p]);

  await setBuff(p, 'atk', 60000);
  ok((await stats.of(null, p)).atk > base.atk, 'зілля атаки піднімає атаку');
  await pool().query(`UPDATE player_progress SET buffs = '{}'::jsonb WHERE player_id = $1`, [p]);

  await setBuff(p, 'atkspeed', 60000);
  ok((await stats.of(null, p)).atkSpeed > base.atkSpeed, 'зілля швидкості піднімає швидкість атаки');
  await pool().query(`UPDATE player_progress SET buffs = '{}'::jsonb WHERE player_id = $1`, [p]);

  // regen was written and read by nothing.
  await setBuff(p, 'regen', 60000);
  const withRegen = await stats.of(null, p);
  ok(withRegen.hpRegen > base.hpRegen,
    `зілля регену піднімає реген (${base.hpRegen.toFixed(2)} → ${withRegen.hpRegen.toFixed(2)})`);
  eq(Math.round((withRegen.hpRegen - base.hpRegen) * 100) / 100, 2,
    'рівно +2 HP/сек, як написано на предметі');
  await pool().query(`UPDATE player_progress SET buffs = '{}'::jsonb WHERE player_id = $1`, [p]);

  // An expired buff must do nothing — the column holds the moment it ENDS.
  await setBuff(p, 'atk', -60000);
  eq((await stats.of(null, p)).atk, base.atk, 'протермінований баф не діє');
  await pool().query(`UPDATE player_progress SET buffs = '{}'::jsonb WHERE player_id = $1`, [p]);

  // ── the kill payout multipliers, in the handler that pays them ───────────
  // Six assertions used to stand here about a lambda defined three lines above
  // them. They restated the rule inside this file and then checked that this
  // file's own arithmetic worked: `Math.round(100 * (1 + 100 / 100))` is 200
  // whatever server/handlers2/world.js does, so deleting every multiplier from
  // the live handler left all six green. That is this file's own subject
  // matter one level up — a number written down that nothing reads.
  //
  // The rule cannot be CALLED from here. It lives inside registerWorld()'s
  // closure — `myXp = Math.round(baseXp * (1 + xpPct / 100))`, and the
  // `buffOn('exp')` doubling sixty lines further down — with no export and no
  // seam short of a real socket, a real floor and a real monster. That path is
  // driven by dev/kill-check.js and dev/play-check.js, which read the xp out
  // of the packet the client gets.
  //
  // What IS asked here is the question every one of these bugs answered wrong:
  // does the live payout read the constant at all. Each name has to occur in
  // the handler somewhere besides its own import line — exactly one occurrence
  // means imported and then never used, which is the state SEASON_TICKET_XP_PCT
  // was in on the day a bought season card doubled nothing.
  console.log('\n  ── чи читає їх живий обробник виплати ──');
  const worldSrc = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'handlers2', 'world.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    // WHOLE-line comments only. The comments in that file name these constants
    // on purpose, to record what used to be missing, so counting them would
    // report every fix as the bug it fixed.
    .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  const reads = (name) => (worldSrc.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length;
  // clanBonusOf is here for the same reason the rest are: CLAN_LEVELS has
  // advertised a gold and an xp bonus at every level since clans existed, the
  // clan panel printed both, and nothing on the server read either. Twice —
  // once for the killer, once for each party member on their own clan.
  for (const name of ['VIP_BONUSES', 'SEASON_TICKET_XP_PCT', 'SEASON_TICKET_LIBERTY_PCT',
                      'SEASON_TICKET_DROP_PCT', 'NEXUM_DROP_CHANCE', 'GRAM_DROP_CHANCE',
                      'GRAM_PER_LEVEL', 'clanBonusOf']) {
    ok(reads(name) >= 2, `${name} читається у виплаті за вбивство (${reads(name)} згадок)`,
      'імпортовано і не використано — саме так картка й не подвоювала нічого');
  }
  ok(/buffOn\s*\(\s*'exp'\s*\)/.test(worldSrc), "зілля досвіду читається при виплаті");
  ok(/buffOn\s*\(\s*'gold'\s*\)/.test(worldSrc), "зілля золота читається при виплаті");
  // And the party share pays the MEMBER's own bonuses, not the killer's — its
  // own three lines, and its own chance of being the one that gets dropped.
  ok(/mBuff\s*\(\s*'exp'\s*\)/.test(worldSrc),
    'частка напарника теж рахує ЙОГО зілля, а не зілля вбивці');

  // ── and the money actually lands ─────────────────────────────────────────
  // grantKillReward is what the handler calls; the doubled amount has to reach
  // the ledger, not just the arithmetic.
  console.log('\n  ── гроші доходять ──');
  const q = await mk('pay');
  // A level-40 mob's GRAM drop, to the exact fraction the rule produces.
  const gramDrop = 40 * GRAM_PER_LEVEL;
  const r = await tx(t => consumables.grantKillReward(t, q, {
    gold: 200, xp: 0, nexum: 1, gram: gramDrop, drops: [], idemKey: `${TAG}:pay:1`,
  }));
  const bal = await money.balancesOf(null, q);
  // `eq(Number(r.gold), 200)` asserted the number this test handed in one
  // statement earlier. grantKillReward could have returned its own argument
  // and credited nothing at all and that still passed — which is precisely
  // what "зелья бафов не работают" looked like from the outside: a number
  // reported, and no money. The BALANCE is where "зараховано" is either true
  // or not.
  eq(Number(bal.gold), 200, 'подвоєне золото лежить у балансі, а не лише у відповіді');
  eq(Number(r.gold), Number(bal.gold),
    'а у відповіді — той самий підсумок, що й у базі (клієнт малює саме його)');
  eq(Number(bal.nexum), 1, 'Liberty з моба зарахована');
  // The whole reason balances are numeric(24,8): rounding this to 2 decimals
  // destroys it entirely, and a session of farming with it.
  eq(Number(bal.gram), gramDrop,
    `GRAM зарахований до останнього знаку (${gramDrop.toFixed(7)}) — не округлений у нуль`);

  const { rows: led } = await pool().query(
    `SELECT currency, delta, reason FROM ledger WHERE player_id = $1 ORDER BY currency`, [q]);
  ok(led.some(l => l.currency === 'nexum' && l.reason === 'mob_drop'),
    'і Liberty має рядок у леджері — не зʼявилась повз money.js');
  ok(led.some(l => l.currency === 'gram' && l.reason === 'mob_drop'),
    'і GRAM теж — реальна валюта не зʼявляється повз леджер');

  console.log(`\n  ${pass} пройшло, ${fail} впало`);
  if (failures.length) console.log(`  впали: ${failures.join(', ')}`);
}

main()
  .catch(err => { console.error(err); fail++; })
  .finally(async () => {
    const del = (t) => pool().query(`DELETE FROM ${t} WHERE player_id = ANY($1)`, [made]).catch(() => {});
    if (made.length) {
      // Предмети — тими ж дверима, якими їх видали: сирий DELETE лишав у
      // item_ledger видачу без рядків, і нічна звірка справедливо кричала.
      await wipeItemsAll(made);
      for (const t of ['player_skills', 'player_vip', 'player_prefs', 'player_daily',
                       'player_season', 'player_progress', 'player_logs', 'ledger', 'balances']) await del(t);
      await pool().query('DELETE FROM players WHERE id = ANY($1)', [made]).catch(() => {});
    }
    await close();
    process.exit(fail ? 1 : 0);
  });
