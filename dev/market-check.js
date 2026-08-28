#!/usr/bin/env node
'use strict';
// ── Proof that a trade cannot half-happen ───────────────────────────────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/market-check.js
//
// The last two tests are the ones that matter most. Everything above them
// checks a rule; those two check the INVARIANT — that after a storm of
// concurrent trades, no item and no GRAM was created or destroyed. That is the
// property the old model could not hold, and no amount of per-case handling
// substitutes for measuring it directly.

const { pool, tx, txRetry, close } = require('../server/db');
const items = require('../server/db/repos/items');
const money = require('../server/db/repos/money');
const market = require('../server/db/repos/market');
const { wipeItemsAll } = require('./fixtures');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);

const TAG = 'mkt-' + process.pid;
const made = [];
const SWORD = 'sw1';

async function mkPlayer(nick, gram = 0) {
  const { rows } = await pool().query(
    'INSERT INTO players (telegram_id, username) VALUES ($1,$2) RETURNING id',
    [`${TAG}-${nick}`, `${TAG}_${nick}`]);
  const id = Number(rows[0].id);
  made.push(id);
  if (gram) await money.credit(null, id, 'gram', gram, { reason: 'seed', idemKey: `${TAG}:seed:${id}` });
  return id;
}
const give = (pid, n = 1) => tx(async t => {
  await items.lockPlayer(t, pid);
  const out = [];
  for (let i = 0; i < n; i++) out.push(await items.add(t, pid, SWORD));
  return out;
});
const invCount = async pid => (await items.inventoryOf(null, pid)).inventory.length;
const gram = async pid => (await money.balancesOf(null, pid)).gram;
const caught = async fn => { try { await fn(); return null; } catch (e) { return e.code || e.message; } };

async function main() {
  console.log(`\nmarket-check  (${TAG})\n`);
  await tx(t => items.syncCatalog(t));

  // ── list ─────────────────────────────────────────────────────────────────
  const s = await mkPlayer('seller');
  const [row] = await give(s);
  const lot = await tx(t => market.list(t, s, row, 10));
  eq(await invCount(s), 0, 'виставлений предмет пішов з інвентаря продавця');
  const { rows: det } = await pool().query('SELECT player_id, container FROM player_items WHERE id=$1', [row]);
  ok(det[0].player_id === null && det[0].container === null, 'предмет належить лоту, а не нікому і не обом');

  eq(await caught(() => tx(t => market.list(t, s, row, 10))), 'not_owned',
    'виставити той самий предмет удруге неможливо');

  const [row2] = await give(s);
  eq(await caught(() => tx(t => market.list(t, s, row2, 99999))), 'bad_price', 'ціна понад стелю відхилена');
  eq(await caught(() => tx(t => market.list(t, s, row2, 0))), 'bad_price', 'нульова ціна відхилена');
  eq(await invCount(s), 1, 'відхилені спроби нічого не забрали з інвентаря');

  const other = await mkPlayer('other');
  eq(await caught(() => tx(t => market.list(t, other, row2, 10))), 'not_owned',
    'виставити чужий предмет неможливо');

  // ── buy ──────────────────────────────────────────────────────────────────
  const b = await mkPlayer('buyer', 100);
  eq(await caught(() => tx(t => market.buy(t, s, lot.listingId))), 'own_lot', 'купити власний лот неможливо');

  const poor = await mkPlayer('poor', 1);
  eq(await caught(() => tx(t => market.buy(t, poor, lot.listingId))), 'no_funds', 'без грошей — відмова');
  eq(await invCount(poor), 0, 'невдала покупка не видала предмет');
  eq(await gram(poor), 1, 'невдала покупка не зняла гроші');

  const sold = await tx(t => market.buy(t, b, lot.listingId));
  eq(await invCount(b), 1, 'покупець отримав предмет');
  eq(await gram(b), 90, 'з покупця списано рівно ціну');
  eq(await gram(s), 9, 'продавець отримав ціну мінус 10% комісії');
  eq(sold.fee, 1, 'комісія 1 GRAM з 10');
  eq(await invCount(s), 1, 'у продавця предмет НЕ повернувся (нема дюпу)');

  eq(await caught(() => tx(t => market.buy(t, b, lot.listingId))), 'gone', 'проданий лот удруге не купиш');

  // ── full inventory ───────────────────────────────────────────────────────
  const s2 = await mkPlayer('seller2');
  const [r3] = await give(s2);
  const lot2 = await tx(t => market.list(t, s2, r3, 5));
  const fullBuyer = await mkPlayer('full', 100);
  await give(fullBuyer, items.SERVER_INV_MAX);
  eq(await caught(() => tx(t => market.buy(t, fullBuyer, lot2.listingId))), 'no_room',
    'повний інвентар — покупка відхилена ДО списання грошей');
  eq(await gram(fullBuyer), 100, 'гроші не зняли');
  const { rows: still } = await pool().query(
    'SELECT status FROM market_listings WHERE id=$1', [lot2.listingId]);
  eq(still[0].status, 'active', 'лот лишився активним');

  // ── cancel ───────────────────────────────────────────────────────────────
  await tx(t => market.cancel(t, s2, lot2.listingId));
  eq(await invCount(s2), 1, 'скасування повернуло предмет продавцю');
  eq(await caught(() => tx(t => market.cancel(t, s2, lot2.listingId))), 'not_found',
    'скасувати скасований лот неможливо');

  // ── THE RACE: two buyers, one lot ────────────────────────────────────────
  // The exact shape of a duplicated item in the old model: both buyers claim
  // it, both get delivered, one row becomes two.
  const rs = await mkPlayer('raceSeller');
  const [rrow] = await give(rs);
  const rlot = await tx(t => market.list(t, rs, rrow, 10));
  const b1 = await mkPlayer('b1', 100), b2 = await mkPlayer('b2', 100);
  const results = await Promise.allSettled([
    txRetry(t => market.buy(t, b1, rlot.listingId)),
    txRetry(t => market.buy(t, b2, rlot.listingId)),
  ]);
  const won = results.filter(r => r.status === 'fulfilled').length;
  eq(won, 1, 'два покупці на один лот — виграє РІВНО один');
  eq((await invCount(b1)) + (await invCount(b2)), 1, 'предмет існує рівно в одного з них');
  eq((await gram(b1)) + (await gram(b2)), 190, 'списано рівно з одного (200 - 10)');

  // ── INVARIANT 1: items are conserved under a storm of concurrent trades ──
  const traders = [];
  for (let i = 0; i < 6; i++) traders.push(await mkPlayer(`t${i}`, 200));
  for (const t of traders) await give(t, 3);
  // Scoped to THESE traders, and to listings THEY hold. The first version
  // counted `player_id IS NULL` across the whole table — every item any other
  // account has ever put up for sale — so the baseline was the traders' 18
  // plus however many live listings the database happened to hold. One real
  // listing from an earlier run made this read 19 and fail forever, describing
  // a lost item that was never lost.
  const scoped = `
    SELECT count(*)::int n FROM player_items
      WHERE player_id = ANY($1) OR (player_id IS NULL AND id IN (
        SELECT item_id FROM market_listings WHERE seller_id = ANY($1)))`;
  const itemsBefore = (await pool().query(scoped, [traders])).rows[0].n;

  // Everyone lists one, then everyone tries to buy everything, all at once.
  const lots = [];
  for (const t of traders) {
    const inv = await items.inventoryOf(null, t);
    lots.push(await tx(x => market.list(x, t, inv.inventory[0].rowId, 5)));
  }
  const attempts = [];
  for (const t of traders) for (const l of lots) {
    attempts.push(txRetry(x => market.buy(x, t, l.listingId)).catch(() => null));
  }
  const outcomes = await Promise.all(attempts);

  // EVERY ONE OF THESE IS `.catch(() => null)`, and it has to be: thirty of the
  // thirty-six are meant to fail — own_lot for the six a trader owns, not_found
  // for whichever the winner already took. But conservation is preserved just
  // as exactly by a buy path that is entirely DOWN. Nothing moves, the count
  // below is unchanged, and the line printed says "після 36 одночасних покупок
  // предметів рівно стільки ж" over thirty-six exceptions the catch ate.
  //
  // So the storm is asserted to have been a storm. Six lots and five eligible
  // buyers each: normally all six change hands, and the floor is one, because
  // what is under test here is conservation under concurrency and not the
  // scheduler's choices.
  const bought = outcomes.filter(Boolean).length;
  ok(bought > 0,
    `${bought} із ${lots.length} лотів справді куплено за ${attempts.length} одночасних спроб`,
    'жодна покупка не пройшла — інваріант нижче міряє нерухому базу');

  const itemsAfter = (await pool().query(scoped, [traders])).rows[0].n;
  eq(itemsAfter, itemsBefore, `після ${attempts.length} одночасних покупок предметів рівно стільки ж (${itemsBefore})`);

  // No item may be owned AND listed at the same time — the duplication state.
  const { rows: dup } = await pool().query(`
    SELECT count(*)::int n FROM market_listings l
      JOIN player_items i ON i.id = l.item_id
     WHERE l.status = 'active' AND i.player_id IS NOT NULL`);
  eq(dup[0].n, 0, 'жоден активний лот не тримає предмет, який комусь належить');

  // ── INVARIANT 2: the ledger still explains every balance ────────────────
  const mine = made.map(Number);
  const drift = (await money.reconcile(null)).filter(r => mine.includes(r.playerId));
  eq(drift.length, 0, 'звірка чиста після всіх торгів — гроші не створились і не зникли');
}

async function cleanup() {
  if (!made.length) return;
  const q = (s, p) => pool().query(s, p).catch(() => {});
  await q('DELETE FROM market_listings WHERE seller_id = ANY($1) OR buyer_id = ANY($1)', [made]);
  // Тими ж дверима, якими видали. Відчеплені на ринок рядки мають
  // player_id NULL і сюди не потрапляють — їх знімає окремий запит нижче.
  await wipeItemsAll(made).catch(() => {});
  // ── this line used to have no WHERE beyond "player_id IS NULL" ───────────
  // Which is not "leftover test rows". It is the market ESCROW state: listing
  // an item DETACHES the row from its owner (items.detachForListing), so
  // player_id IS NULL means "somebody has this on sale right now". Unscoped,
  // and inside a .catch(() => {}) that would have said nothing, this cleanup
  // was aimed at every live player's active lots — and it runs from a
  // .finally(), on every run, success or failure. dev/sync.sh sources the
  // PRODUCTION env, so "run the market check" meant it.
  //
  // Nothing was actually lost: market_listings.item_id REFERENCES
  // player_items(id), so the delete was refused and the refusal was swallowed.
  // The schema saved it, not the test.
  //
  // Scoped to the rows this run created, the same way every other line here
  // already was.
  await q(`DELETE FROM player_items pi
            USING market_listings m
            WHERE pi.id = m.item_id AND m.seller_id = ANY($1)`, [made]);
  await q('DELETE FROM ledger   WHERE player_id = ANY($1)', [made]);
  await q('DELETE FROM balances WHERE player_id = ANY($1)', [made]);
  await q('DELETE FROM players  WHERE id = ANY($1)', [made]);
}

main()
  .catch(err => { fail++; failures.push('НЕОБРОБЛЕНА ПОМИЛКА'); console.error('\n', err); })
  .finally(async () => {
    await cleanup(); await close();
    console.log(`\n  ${pass} пройшло, ${fail} впало`);
    if (failures.length) console.log('  впали: ' + failures.join(' · '));
    process.exit(fail ? 1 : 0);
  });
