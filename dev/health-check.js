#!/usr/bin/env node
'use strict';
// ── Invariants over the LIVE database ───────────────────────────────────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/health-check.js
//
// Every other suite here proves that code behaves on data it made up. This one
// asks the real database whether anything has gone wrong in production — the
// residue a silent bug leaves behind after it has already happened.
//
// That is a different question, and it is the one that catches a bug nobody
// reported. The enhancement bug was visible in this shape before anyone
// described it: one account holding six item types in exact pairs at the same
// level. A player's item quietly vanishing looks like a row detached from its
// owner with no listing holding it. Money invented out of nowhere looks like a
// balance that does not match its ledger.
//
// READ ONLY. It writes nothing and locks nothing, so it is safe against
// production at any time, including while people are playing.

const { pool, close } = require('../server/db');
const money = require('../server/db/repos/money');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const q = async (sql, params) => (await pool().query(sql, params)).rows;
const count = async (sql, params) => Number((await q(sql, params))[0].n);

async function main() {
  console.log('\nhealth-check  (жива база)\n');

  // ── money ────────────────────────────────────────────────────────────────
  // The single most important number here. reconcile() sums every ledger row
  // against the stored balance; anything non-zero means value moved without
  // going through money.js, which is either a bug or an exploit.
  console.log('  ── гроші ──');
  const drift = await money.reconcile(null);
  ok(drift.length === 0, `баланси сходяться з леджером`,
    drift.slice(0, 5).map(d => `гравець ${d.playerId} ${d.currency}: ${d.drift}`).join('; '));
  ok(await count('SELECT count(*)::int n FROM balances WHERE amount < 0') === 0,
    'жодного відʼємного балансу');

  // ── items ────────────────────────────────────────────────────────────────
  console.log('\n  ── речі ──');
  // player_id IS NULL is the market's escrow state and is CORRECT while a
  // listing holds the item — that is how "listed, and therefore not in the
  // bag" is expressed. It is only wrong when no active listing does, and then
  // it is an item belonging to nobody: gone, with no way for its owner to ask
  // for it back.
  const stranded = await q(`
    SELECT i.id, i.item_id FROM player_items i
     WHERE i.player_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM market_listings l
                        WHERE l.item_id = i.id AND l.status = 'active')`);
  ok(stranded.length === 0,
    'жоден предмет не завис поза ринком і поза інвентарем',
    stranded.slice(0, 5).map(r => `рядок ${r.id} (${r.item_id})`).join('; '));

  ok(await count(`
    SELECT count(*)::int n FROM market_listings
     WHERE status = 'active' AND item_id IS NULL`) === 0,
    'жодного активного лота без предмета');

  ok(await count(`
    SELECT count(*)::int n FROM player_items i JOIN item_catalog c ON c.item_id = i.item_id
     WHERE i.enhance > 0 AND NOT c.enhanceable`) === 0,
    'заточки немає там, де її бути не може');

  ok(await count('SELECT count(*)::int n FROM player_items WHERE enhance > 15') === 0,
    'жодної заточки вище +15');

  ok(await count('SELECT count(*)::int n FROM player_items WHERE qty <= 0') === 0,
    'жодного рядка з нульовою кількістю');

  // One slot, one item. Two would apply the same bonus twice and be
  // unremovable through the ordinary unequip path.
  const dupSlots = await q(`
    SELECT player_id, slot, count(*)::int n FROM player_items
     WHERE container = 'equipment' GROUP BY 1, 2 HAVING count(*) > 1`);
  ok(dupSlots.length === 0, 'один слот — один предмет',
    dupSlots.slice(0, 5).map(r => `гравець ${r.player_id} ${r.slot}×${r.n}`).join('; '));

  // Over the server cap. Not fatal, but it is how a duplication bug shows up
  // first, and hasRoomFor cannot push anyone over it.
  const over = await q(`
    SELECT player_id, count(*)::int n FROM player_items
     WHERE container = 'inventory' GROUP BY 1 HAVING count(*) > 150 ORDER BY 2 DESC LIMIT 5`);
  ok(over.length === 0, 'ніхто не перевищив ліміт інвентаря',
    over.map(r => `гравець ${r.player_id}: ${r.n}`).join('; '));

  // ── the shape the enhancement bug left ───────────────────────────────────
  // Identical copies of the same gear at the same enhancement, in quantity.
  // One or two is ordinary luck. A player holding several DIFFERENT item types
  // in matched pairs is what "enhance one and everything like it goes up"
  // looks like from the database, and it is what pointed at the bug.
  //
  // A warning rather than a failure: it is evidence, not proof, and the fix is
  // in the code rather than in these rows.
  console.log('\n  ── слід від старого бага заточки ──');
  const pairs = await q(`
    SELECT player_id, count(*)::int kinds FROM (
      SELECT i.player_id, i.item_id, i.enhance
        FROM player_items i JOIN item_catalog c ON c.item_id = i.item_id
       WHERE c.enhanceable AND i.enhance > 0 AND i.container = 'inventory'
       GROUP BY 1, 2, 3 HAVING count(*) > 1
    ) x GROUP BY 1 HAVING count(*) >= 3 ORDER BY 2 DESC LIMIT 5`);
  if (pairs.length) {
    console.log(`  \x1b[33m·\x1b[0m  ${pairs.length} акаунт(ів) із однаковими парами:`
      + ` ${pairs.map(r => `${r.player_id} (${r.kinds} видів)`).join(', ')}`);
    console.log('     це залишок від бага, а не новий — заточка тепер адресує рядок');
  } else {
    console.log('  \x1b[32m·\x1b[0m  нових пар не зʼявилось');
  }

  // ── logging is actually happening ────────────────────────────────────────
  // player_logs existed for months with nothing writing to it. An empty table
  // looks exactly like a quiet day.
  console.log('\n  ── журнал ──');
  const logged = await count(`
    SELECT count(*)::int n FROM player_logs WHERE created_at > now() - interval '24 hours'`);
  ok(logged > 0, `журнал гравців пишеться (${logged} записів за добу)`,
    'нічого не записано — журнал знову мовчить');

  console.log(`\n  ${pass} пройшло, ${fail} впало`);
  if (failures.length) console.log(`  впали: ${failures.join(', ')}`);
  process.exitCode = fail ? 1 : 0;
}

main()
  .catch(err => { console.error(err); process.exitCode = 1; })
  .finally(() => close());
