#!/usr/bin/env node
'use strict';
// ── Enhancing an item that was once on the market ───────────────────────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/enhance-check.js
//
// Reported exactly:
//
//   "я в маркет закинул предмет и снял, теперь он думает что он в маркете и не
//    даёт точить, но если много раз нажимать можно вплоть до +15 заточить не
//    ломая"
//
// Both halves are one foreign key. market_listings.item_id references
// player_items(id) and keeps referencing it after the listing is cancelled, so
// the DELETE that burns a failed enhancement is refused. The refusal raises
// inside the transaction, the transaction rolls back — and the rollback takes
// the SPENT STONE with it. A failed roll therefore costs nothing, which is a
// free run to +15 for any item that has ever been listed.
//
// The test that matters is not "does it error". It is: after N attempts, is the
// player's stone count lower, and did the item either rise or burn. An exploit
// looks like a green light everywhere else.

const { pool, tx, txRetry, close } = require('../server/db');
const items = require('../server/db/repos/items');
const players = require('../server/db/repos/players');
const market = require('../server/db/repos/market');
const craft = require('../server/db/repos/craft');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);

const TAG = 'enh-' + String(process.pid).slice(-5);
const made = [];
async function mk(nick) {
  const { id } = await tx(t => players.ensure(t, `${TAG}-${nick}`, `${TAG}_${nick}`));
  made.push(id);
  return id;
}

// A weapon, because ENHANCEABLE_SLOTS is about gear.
const GEAR = 'sw1';
const STONE = 'norm_stone';

const stones = async (pid) => {
  const { rows } = await pool().query(
    `SELECT COALESCE(sum(qty), 0)::int n FROM player_items
      WHERE player_id = $1 AND item_id = $2`, [pid, STONE]);
  return rows[0].n;
};
const rowOf = async (pid) => {
  const { rows } = await pool().query(
    `SELECT id, enhance FROM player_items
      WHERE player_id = $1 AND item_id = $2 AND container = 'inventory'
      ORDER BY id LIMIT 1`, [pid, GEAR]);
  return rows.length ? { id: Number(rows[0].id), enhance: rows[0].enhance } : null;
};
const caught = async fn => { try { await fn(); return null; } catch (e) { return e.code || e.message; } };

async function main() {
  console.log(`\nenhance-check  (${TAG})\n`);
  await tx(t => items.syncCatalog(t));

  const blocks = await items.marketRefBlocksDelete(null);
  console.log(`  зовнішній ключ ${blocks ? 'БЛОКУЄ' : 'звільняється (міграція 010 застосована)'} видалення\n`);

  // ── an item that has never been listed still burns ───────────────────────
  // The control. Without it, "nothing was destroyed" could mean the guard is
  // refusing everything rather than only what it should.
  console.log('  ── звичайний предмет ──');
  const a = await mk('a');
  await tx(t => items.add(t, a, GEAR));
  await tx(async (t) => { for (let i = 0; i < 40; i++) await items.add(t, a, STONE); });

  let burned = false, rose = false;
  for (let i = 0; i < 40; i++) {
    const row = await rowOf(a);
    if (!row) { burned = true; break; }
    const before = row.enhance;
    const res = await txRetry(t => craft.enhance(t, a, row.id, 'norm')).catch(() => null);
    if (!res) break;
    if (res.outcome === 'burned') { burned = true; break; }
    if (res.outcome === 'success' && res.to > before) rose = true;
  }
  ok(burned || rose, 'заточка звичайного предмета або підіймає, або спалює');
  const leftA = await stones(a);
  ok(leftA < 40, `камені витрачаються (${40 - leftA} з 40)`);

  // ── the same item, after a round trip through the market ─────────────────
  console.log('\n  ── предмет, що побував на ринку ──');
  const b = await mk('b');
  await tx(t => items.add(t, b, GEAR));
  const listed = await rowOf(b);
  const lot = await tx(t => market.list(t, b, listed.id, 100));
  await tx(t => market.cancel(t, b, lot.listingId));

  const backRow = await rowOf(b);
  ok(!!backRow, 'предмет повернувся в інвентар після зняття з ринку');
  const { rows: refs } = await pool().query(
    'SELECT count(*)::int n FROM market_listings WHERE item_id = $1', [backRow.id]);
  eq(refs[0].n, 1, 'знятий лот усе ще посилається на цей рядок');

  await tx(async (t) => { for (let i = 0; i < 60; i++) await items.add(t, b, STONE); });
  const stonesBefore = await stones(b);
  const enhBefore = backRow.enhance;

  // Sixty attempts. Against the bug, every one of them refunded its stone and
  // left the item where it was — sixty free rolls, which is what "до +15 не
  // ломая" means in practice.
  let attempts = 0, errs = 0, gone = false, top = enhBefore;
  for (let i = 0; i < 60; i++) {
    const row = await rowOf(b);
    if (!row) { gone = true; break; }
    attempts++;
    const e = await caught(() => txRetry(t => craft.enhance(t, b, row.id, 'norm')));
    if (e) errs++;
    const now = await rowOf(b);
    if (!now) { gone = true; break; }
    if (now.enhance > top) top = now.enhance;
  }
  const stonesAfter = await stones(b);
  const spent = stonesBefore - stonesAfter;

  if (blocks) {
    // The reference still blocks, so the honest answer is a refusal — and the
    // point is that it refuses BEFORE the stone, so nothing rolls back and
    // there is nothing free to repeat.
    eq(errs, attempts, `кожна спроба відмовлена з поясненням (${errs}/${attempts})`);
    eq(spent, 0, 'жодного каменя не витрачено на відмову');
    eq(top, enhBefore, `заточка не піднялась (+${enhBefore} → +${top}) — саме це давало «до +15 не ломая»`);
    ok(!gone, 'предмет не зник');
    const code = await caught(() => txRetry(t => craft.enhance(t, b, backRow.id, 'norm')));
    eq(code, 'was_listed', 'причина названа кодом, а не «Ошибка сервера»');
  } else {
    // After migration 010 the reference releases itself: the item behaves
    // exactly like any other, and the listing keeps its own record of the sale.
    ok(gone || top > enhBefore, 'предмет поводиться як звичайний — піднявся або згорів');
    ok(spent > 0, `камені витрачені по-справжньому (${spent})`);
    const hist = await market.history(null, b, 30);
    const row = hist.find(h => Number(h.id) === Number(lot.listingId));
    ok(!!row, 'скасований лот лишився в історії');
    if (row) ok(!!row.item && !!row.item.id, `історія пам'ятає, що це було (${row.item && row.item.id})`);
  }

  // ── selling it must not fail either ──────────────────────────────────────
  // Same foreign key, different verb: the merchant sale deletes the row too.
  console.log('\n  ── продаж такого предмета ──');
  const c = await mk('c');
  await tx(t => items.add(t, c, GEAR));
  const cRow = await rowOf(c);
  const cLot = await tx(t => market.list(t, c, cRow.id, 100));
  await tx(t => market.cancel(t, c, cLot.listingId));
  const back = await rowOf(c);
  const sold = await caught(() => txRetry(t => craft.sellItem(t, c, back.id, 1)));
  if (blocks) {
    ok(!!sold, `продаж теж відмовлено з поясненням (${sold})`);
    ok(!!await rowOf(c), 'і предмет лишився у гравця');
  } else {
    eq(sold, null, 'продаж проходить');
    ok(!await rowOf(c), 'предмет пішов з інвентаря');
  }

  // ── ЯКА САМЕ з двох однакових ───────────────────────────────────────────
  // "Одну вещь точишь, и всё что на неё похоже точится вместе с ней."
  //
  // Two identical copies at the same enhancement are interchangeable for
  // selling and equipping, and they STOP being interchangeable the moment one
  // is enhanced. The client could not say which it meant —
  // _rebuildFromCatalog copied the catalog entry plus enhance and qty and
  // dropped rowId — so the server matched on (id, enhance) and took whichever
  // row came first. Enhance again and it took the other. Both climbed, one
  // click apart, and the player watched every copy rise together.
  //
  // Blessed stones throughout: a blessed failure changes nothing, so what this
  // measures is which ROW moved and nothing else.
  console.log('');
  console.log('  ── дві однакові речі ──');
  const d = await mk('d');
  await tx(t => items.add(t, d, GEAR));
  await tx(t => items.add(t, d, GEAR));
  await tx(async (t) => { for (let i = 0; i < 30; i++) await items.add(t, d, 'bless_stone'); });

  const bothRows = async (pid) => {
    const { rows } = await pool().query(
      `SELECT id, enhance FROM player_items
        WHERE player_id = $1 AND item_id = $2 AND container = 'inventory'
        ORDER BY id`, [pid, GEAR]);
    return rows.map(r => ({ id: Number(r.id), enhance: r.enhance }));
  };

  const pair = await bothRows(d);
  eq(pair.length, 2, 'у гравця дві однакові речі, окремими рядками');
  const target = pair[1].id;          // the SECOND — a first-row match would miss it
  const other  = pair[0].id;

  const named = await txRetry(t =>
    items.resolveRow(t, d, { rowId: target, id: GEAR }, 'inventory'));
  eq(named, target, 'resolveRow повертає саме той рядок, який назвали');

  let moved = 0;
  for (let i = 0; i < 12 && moved < 3; i++) {
    const res = await txRetry(t => craft.enhance(t, d, target, 'bless'));
    if (res.outcome === 'success') moved++;
  }

  const after = await bothRows(d);
  const t2 = after.find(r => r.id === target);
  const o2 = after.find(r => r.id === other);
  ok(t2 && t2.enhance > 0, `заточилась саме та річ (+${t2 && t2.enhance})`);
  eq(o2 && o2.enhance, 0,
    `а друга однакова лишилась +0 — саме це і був баг (+${o2 && o2.enhance})`);

  // The shape the bug took: named by IDENTITY alone, the server answers with
  // the first matching row, which is not the one that was clicked.
  const e = await mk('e');
  await tx(t => items.add(t, e, GEAR));
  await tx(t => items.add(t, e, GEAR));
  const eRows = await bothRows(e);
  const byIdentity = await txRetry(t =>
    items.resolveRow(t, e, { id: GEAR, enhance: 0 }, 'inventory'));
  eq(byIdentity, eRows[0].id,
    'без rowId сервер бере ПЕРШИЙ збіг — не той, на який натиснули');

  // A row id that no longer exists must not break the click: identity still
  // names what the player meant.
  const stale = await txRetry(t =>
    items.resolveRow(t, e, { rowId: 999999999, id: GEAR, enhance: 0 }, 'inventory'));
  eq(stale, eRows[0].id,
    'застарілий rowId відкочується на впізнання, а не відмовляє');


  console.log(`\n  ${pass} пройшло, ${fail} впало`);
  if (failures.length) console.log(`  впали: ${failures.join(', ')}`);
}

main()
  .catch(err => { console.error(err); fail++; })
  .finally(async () => {
    if (made.length) {
      await pool().query('DELETE FROM market_listings WHERE seller_id = ANY($1)', [made]).catch(() => {});
      await pool().query('DELETE FROM players WHERE id = ANY($1)', [made]).catch(() => {});
    }
    await close();
    process.exit(fail ? 1 : 0);
  });
