#!/usr/bin/env node
'use strict';
// ── Proof that an item cannot be duplicated or lost ─────────────────────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/items-check.js
//
// Every test here is a "предмет пропал" or "предмет задвоился" report from
// production, reproduced against the new model. It passes only when the
// outcome is impossible rather than merely handled.

const { pool, tx, close } = require('../server/db');
const items = require('../server/db/repos/items');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);

const TAG = 'ichk-' + process.pid;
const made = [];
async function mkPlayer(nick) {
  const { rows } = await pool().query(
    'INSERT INTO players (telegram_id, username) VALUES ($1,$2) RETURNING id',
    [`${TAG}-${nick}`, `${TAG}_${nick}`]);
  made.push(Number(rows[0].id));
  return Number(rows[0].id);
}

// A real non-stackable weapon and a real stackable material, taken from the
// catalog rather than invented — the FK would refuse anything else, which is
// itself one of the tests below.
const SWORD = 'sw1';
const MAT = 'mat_iron';

async function main() {
  console.log(`\nitems-check  (${TAG})\n`);

  // ── catalog ──────────────────────────────────────────────────────────────
  const synced = await tx(t => items.syncCatalog(t));
  ok(synced.synced === 184, `каталог синхронізовано (${synced.synced} предметів, ${synced.retired} виведено)`);

  const { rows: matRow } = await pool().query(
    'SELECT item_id, stackable FROM item_catalog WHERE stackable AND slot=$1 LIMIT 1', ['material']);
  const STACKABLE = matRow[0].item_id;

  // ── 1. an unknown item id must be impossible, not filtered ───────────────
  const p = await mkPlayer('a');
  let refusedFake = false;
  try {
    await pool().query(
      `INSERT INTO player_items (player_id, container, item_id) VALUES ($1,'inventory','no_such_item')`, [p]);
  } catch { refusedFake = true; }
  ok(refusedFake, 'предмет із неіснуючим id відхиляється зовнішнім ключем');

  // ── 2. a catalog row with live items cannot be deleted ───────────────────
  // This is the half that protects players: a catalog edit must not be able to
  // destroy copies people already own.
  await tx(async t => { await items.lockPlayer(t, p); await items.add(t, p, SWORD); });
  let deletedCat = false;
  try { await pool().query('DELETE FROM item_catalog WHERE item_id = $1', [SWORD]); deletedCat = true; }
  catch { /* expected */ }
  ok(!deletedCat, 'запис каталогу з живими предметами неможливо видалити');

  // ── 3. stacking ──────────────────────────────────────────────────────────
  await tx(async t => {
    await items.lockPlayer(t, p);
    await items.add(t, p, STACKABLE, { qty: 5 });
    await items.add(t, p, STACKABLE, { qty: 3 });
  });
  let inv = await items.inventoryOf(null, p);
  const stack = inv.inventory.filter(i => i.id === STACKABLE);
  eq(stack.length, 1, 'стековані зливаються в ОДИН слот');
  eq(stack[0].qty, 8, 'кількість у стеку складається');
  eq(inv.inventory.length, 2, 'меч + стек = 2 слоти');

  // ── 4. partial and full removal ──────────────────────────────────────────
  await tx(async t => { await items.lockPlayer(t, p); await items.removeQty(t, p, STACKABLE, 3); });
  inv = await items.inventoryOf(null, p);
  eq(inv.inventory.find(i => i.id === STACKABLE).qty, 5, 'часткове зняття зменшує стек');

  const tooMany = await tx(async t => {
    await items.lockPlayer(t, p);
    return items.removeQty(t, p, STACKABLE, 999);
  });
  eq(tooMany, false, 'зняти більше, ніж є, — відмова, а не часткове списання');
  eq((await items.inventoryOf(null, p)).inventory.find(i => i.id === STACKABLE).qty, 5,
    'невдале зняття нічого не змінило');

  await tx(async t => { await items.lockPlayer(t, p); await items.removeQty(t, p, STACKABLE, 5); });
  ok(!(await items.inventoryOf(null, p)).inventory.some(i => i.id === STACKABLE),
    'стек, що вичерпався, зникає зі слота');

  // ── 5. equipment: one item per slot, enforced by the database ────────────
  const q = await mkPlayer('b');
  const [w1, w2] = await tx(async t => {
    await items.lockPlayer(t, q);
    return [await items.add(t, q, SWORD), await items.add(t, q, SWORD)];
  });
  await tx(t => items.moveTo(t, w1, q, 'equipment', 'weapon'));
  let second = true;
  try { await tx(t => items.moveTo(t, w2, q, 'equipment', 'weapon')); }
  catch { second = false; }
  ok(!second, 'другий предмет у зайнятий слот екіпіровки — відхилено базою');

  inv = await items.inventoryOf(null, q);
  eq(Object.keys(inv.equipment).length, 1, 'в екіпіровці лишився рівно один');

  // ── 6. THE ROOM BUG: a stackable with no existing stack still needs a slot ─
  // The old check was "not stackable AND full", which let this through — the
  // GRAM was spent, the listing cancelled, and the item then dropped on the
  // way in. Fill the inventory to the cap and ask both questions.
  const r = await mkPlayer('c');
  await tx(async t => {
    await items.lockPlayer(t, r);
    for (let i = 0; i < items.SERVER_INV_MAX; i++) await items.add(t, r, SWORD);
  });
  eq(await items.usedSlots(null, r), items.SERVER_INV_MAX, 'інвентар заповнено до межі');
  eq(await items.hasRoomFor(null, r, STACKABLE), false,
    'стековане БЕЗ наявного стеку в повний інвентар — місця немає (той самий баг)');

  await tx(async t => {
    await items.lockPlayer(t, r);
    await items.removeRow(t, (await items.inventoryOf(t, r)).inventory[0].rowId, r);
    await items.add(t, r, STACKABLE, { qty: 1 });
    await items.add(t, r, SWORD);                       // назад до межі
  });
  eq(await items.hasRoomFor(null, r, STACKABLE), true,
    'стековане З наявним стеком у повний інвентар — місце є (зливається)');
  eq(await items.hasRoomFor(null, r, SWORD), false, 'нестековане в повний інвентар — місця немає');

  // ── 7. add() refuses at the cap instead of overflowing ───────────────────
  const over = await tx(async t => { await items.lockPlayer(t, r); return items.add(t, r, SWORD); });
  eq(over, null, 'add понад межу повертає null, а не переповнює інвентар');
  eq(await items.usedSlots(null, r), items.SERVER_INV_MAX, 'слотів не побільшало');

  // ── 8. unequipping into a full inventory must not destroy the piece ──────
  const eqRow = Object.values((await items.inventoryOf(null, q)).equipment)[0].rowId;
  await tx(async t => {
    await items.lockPlayer(t, q);
    // добиваємо інвентар q до межі
    const used = await items.usedSlots(t, q);
    for (let i = used; i < items.SERVER_INV_MAX; i++) await items.add(t, q, SWORD);
  });
  const unequipped = await tx(t => items.moveTo(t, eqRow, q, 'inventory'));
  eq(unequipped, false, 'зняти екіпіровку в повний інвентар — відмова');
  ok(Object.keys((await items.inventoryOf(null, q)).equipment).length === 1,
    'предмет лишився вдягненим, а не зник');

  // ── 9. THE RACE: two grants at 149 slots ─────────────────────────────────
  // Without lockPlayer both read 149 and both insert, and the account ends up
  // at 151 — past the cap, where the client's invHasSpace() is false forever.
  const s = await mkPlayer('d');
  await tx(async t => {
    await items.lockPlayer(t, s);
    for (let i = 0; i < items.SERVER_INV_MAX - 1; i++) await items.add(t, s, SWORD);
  });
  const both = await Promise.all([
    tx(async t => { await items.lockPlayer(t, s); return items.add(t, s, SWORD); }),
    tx(async t => { await items.lockPlayer(t, s); return items.add(t, s, SWORD); }),
  ]);
  eq(both.filter(Boolean).length, 1, 'дві одночасні видачі на останній слот — проходить РІВНО одна');
  eq(await items.usedSlots(null, s), items.SERVER_INV_MAX, 'інвентар рівно на межі, не понад неї');

  // ── 10. market handoff: the item is in exactly one place, always ─────────
  const seller = await mkPlayer('e'), buyer = await mkPlayer('f');
  const row = await tx(async t => { await items.lockPlayer(t, seller); return items.add(t, seller, SWORD); });

  await tx(t => items.detachForListing(t, row, seller));
  eq((await items.inventoryOf(null, seller)).inventory.length, 0, 'виставлений предмет зник з інвентаря продавця');
  const { rows: orphan } = await pool().query(
    'SELECT player_id, container FROM player_items WHERE id = $1', [row]);
  ok(orphan[0].player_id === null && orphan[0].container === null,
    'предмет належить лоту: власника немає, контейнера немає');

  await tx(t => items.attachFromListing(t, row, buyer));
  eq((await items.inventoryOf(null, buyer)).inventory.length, 1, 'покупець отримав предмет');
  eq((await items.inventoryOf(null, seller)).inventory.length, 0, 'у продавця його НЕ лишилось (нема дюпу)');

  // ── 11. rollback: a failed trade leaves nothing behind ───────────────────
  const t2 = await mkPlayer('g');
  try {
    await tx(async t => {
      await items.lockPlayer(t, t2);
      await items.add(t, t2, SWORD);
      throw new Error('оплата не пройшла');
    });
  } catch { /* expected */ }
  eq((await items.inventoryOf(null, t2)).inventory.length, 0,
    'предмет, виданий у транзакції що впала, не існує');
}

async function cleanup() {
  if (!made.length) return;
  await pool().query('DELETE FROM market_listings WHERE seller_id = ANY($1)', [made]).catch(() => {});
  await pool().query('DELETE FROM player_items WHERE player_id = ANY($1) OR player_id IS NULL', [made]).catch(() => {});
  await pool().query('DELETE FROM players WHERE id = ANY($1)', [made]).catch(() => {});
}

main()
  .catch(err => { fail++; failures.push('НЕОБРОБЛЕНА ПОМИЛКА'); console.error('\n', err); })
  .finally(async () => {
    await cleanup(); await close();
    console.log(`\n  ${pass} пройшло, ${fail} впало`);
    if (failures.length) console.log('  впали: ' + failures.join(' · '));
    process.exit(fail ? 1 : 0);
  });
