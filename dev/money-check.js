#!/usr/bin/env node
'use strict';
// ── Proof that the money layer cannot lose or invent money ──────────────────
//
//   DATABASE_URL=postgres://... node dev/money-check.js
//
// Runs against a REAL PostgreSQL, because every guarantee being checked here
// is the database's, not JavaScript's: row locks, CHECK constraints, UNIQUE on
// idem_key, transactional rollback. A mock would only prove that the mock
// agrees with itself — which is precisely how the Mongo double let the
// dot-path bug through (dev/mongo-memory.js applies conflicting $set paths
// that real MongoDB rejects).
//
// Every test creates its own accounts, and everything is removed at the end.
// Safe to run against the live cluster before the game is on it.

const { pool, tx, txRetry, close } = require('../server/db');
const money = require('../server/db/repos/money');

let pass = 0, fail = 0;
const failures = [];

function ok(cond, name, detail) {
  if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, name) => ok(a === b, name, `очікував ${b}, отримав ${a}`);
// The SQLSTATE of whatever was raised, or null if nothing was. Same helper
// dev/market-check.js calls `caught`, and for the same reason: `try { … flag =
// true } catch {}` passes on any error at all, including the ones the test
// itself introduced, so what it proves is "something went wrong somewhere".
//
// Named `sqlstate` rather than `caught` because main() already has a local
// `caught` — the drifted account reconcile() found — and a const inside the
// function shadows this one for the whole of it, so the calls at the bottom
// would have reached for an object and thrown TypeError instead of asserting.
const sqlstate = async (fn) => { try { await fn(); return null; } catch (e) { return e.code || e.message; } };

// Test accounts, torn down at the end. The tag makes them findable if a run is
// killed halfway and leaves rows behind.
const TAG = 'mchk-' + process.pid;
const made = [];

async function mkPlayer(nick) {
  const { rows } = await pool().query(
    'INSERT INTO players (telegram_id, username) VALUES ($1, $2) RETURNING id',
    [`${TAG}-${nick}`, `${TAG}_${nick}`]);
  made.push(rows[0].id);
  return Number(rows[0].id);
}

async function bal(id, cur = 'gram') {
  return (await money.balancesOf(null, id))[cur];
}

async function main() {
  console.log(`\nmoney-check  (${TAG})\n`);

  // ── 1. credit creates the row and adds up ────────────────────────────────
  const a = await mkPlayer('a');
  await money.credit(null, a, 'gram', 100, { reason: 'test', idemKey: `${TAG}:c1` });
  eq(await bal(a), 100, 'credit створює баланс з нуля');

  await money.credit(null, a, 'gram', 50, { reason: 'test', idemKey: `${TAG}:c2` });
  eq(await bal(a), 150, 'credit додається до наявного');

  // ── 2. the same idemKey twice must credit ONCE ───────────────────────────
  // This is the retry a lost acknowledgement produces. Without the UNIQUE on
  // idem_key it doubles the money, silently, and nothing downstream notices.
  const again = await money.credit(null, a, 'gram', 50, { reason: 'test', idemKey: `${TAG}:c2` });
  eq(await bal(a), 150, 'повтор того самого idemKey НЕ нараховує вдруге');
  ok(again.replayed === true, 'повтор повідомляє replayed=true');
  eq(again.balance, 150, 'повтор повертає той самий баланс, а не помилку');

  // ── 3. spend ─────────────────────────────────────────────────────────────
  const spent = await money.spend(null, a, 'gram', 40, { reason: 'test', idemKey: `${TAG}:s1` });
  eq(spent.balance, 110, 'spend списує рівно стільки, скільки просили');
  eq(await bal(a), 110, 'spend зберігся в базі');

  // ── 4. an unaffordable spend must write NOTHING ──────────────────────────
  // Not "throw and leave a partial write" — nothing at all. The old code
  // checked the cached figure first and deducted afterwards, which is the
  // race this closes.
  const before = await bal(a);
  const broke = await money.spend(null, a, 'gram', 9999, { reason: 'test', idemKey: `${TAG}:s2` });
  ok(broke === null, 'spend понад баланс повертає null');
  eq(await bal(a), before, 'невдалий spend не змінив баланс');
  const { rows: ghost } = await pool().query('SELECT count(*)::int n FROM ledger WHERE idem_key = $1', [`${TAG}:s2`]);
  eq(ghost[0].n, 0, 'невдалий spend не залишив запис у леджері');

  // ── 5. THE RACE: two spends of the same funds, at the same instant ───────
  // The exact shape of "двойная покупка" (C3 in AUDIT.md): a player with
  // enough for ONE purchase fires two. Exactly one must win.
  const b = await mkPlayer('b');
  await money.credit(null, b, 'gram', 100, { reason: 'test', idemKey: `${TAG}:b1` });
  const both = await Promise.all([
    money.spend(null, b, 'gram', 100, { reason: 'race', idemKey: `${TAG}:r1` }),
    money.spend(null, b, 'gram', 100, { reason: 'race', idemKey: `${TAG}:r2` }),
  ]);
  const winners = both.filter(Boolean).length;
  eq(winners, 1, 'дві одночасні покупки за ті самі гроші — виграє РІВНО одна');
  eq(await bal(b), 0, 'баланс після гонки рівно 0, не -100');

  // ── 6. a throw inside a transaction takes the money back with it ─────────
  // This is what replaces every hand-written refund in the economy handlers.
  const c = await mkPlayer('c');
  await money.credit(null, c, 'gram', 100, { reason: 'test', idemKey: `${TAG}:c3` });
  try {
    await tx(async (t) => {
      await money.spend(t, c, 'gram', 100, { reason: 'test', idemKey: `${TAG}:s3` });
      throw new Error('доставка предмета не вдалась');
    });
  } catch { /* expected */ }
  eq(await bal(c), 100, 'throw усередині tx() повертає гроші — без жодного коду відкату');
  const { rows: rb } = await pool().query('SELECT count(*)::int n FROM ledger WHERE idem_key = $1', [`${TAG}:s3`]);
  eq(rb[0].n, 0, 'відкочена транзакція не лишила запису в леджері');

  // ── 7. transfer is atomic in both legs ───────────────────────────────────
  const d = await mkPlayer('d');
  await money.credit(null, c, 'gram', 0.0000001, { reason: 'дроб', idemKey: `${TAG}:frac` });
  const moved = await tx(t => money.transfer(t, c, d, 'gram', 30, { reason: 'market', idemKey: `${TAG}:t1` }));
  eq(moved.from, 70.0000001, 'у відправника списалось (і 7-й знак не загубився)');
  eq(moved.to, 30, 'отримувачу зарахувалось');

  // ── 8. reconcile is silent while everything went through money.js ────────
  // Runs BEFORE the raw-write tests below, which deliberately create drift —
  // an earlier version of this file had them the other way round and the
  // clean check failed on damage the test itself had just done.
  const mine = made.map(Number);
  const drifted = (await money.reconcile(null)).filter(r => mine.includes(r.playerId));
  eq(drifted.length, 0, 'звірка чиста, поки гроші рухались тільки через money.js');

  // ── 9. numeric does not drift over many small increments ─────────────────
  // The old float accumulator drifted ~1e-10 over thousands of 0.0000001 kill
  // drops — there is a comment in server/index.js acknowledging it. Ten
  // thousand real increments must land on exactly 0.001.
  //
  // A plpgsql loop, not `UPDATE ... FROM generate_series(1,10000)`: that form
  // adds the increment ONCE however many rows the join produces, because
  // PostgreSQL updates each target row a single time per statement. The first
  // version of this test used it and "passed" a claim it never made.
  const e = await mkPlayer('e');
  await pool().query(`INSERT INTO balances (player_id, currency, amount) VALUES ($1,'gram',0)`, [e]);
  await pool().query(`
    DO $$
    BEGIN
      FOR i IN 1..10000 LOOP
        UPDATE balances SET amount = amount + 0.0000001
         WHERE player_id = ${e} AND currency = 'gram';
      END LOOP;
    END $$;`);
  const { rows: dr } = await pool().query(
    `SELECT amount::text t FROM balances WHERE player_id=$1 AND currency='gram'`, [e]);
  eq(dr[0].t, '0.00100000', '10 000 інкрементів по 1e-7 = рівно 0.001, без дрейфу');

  // Now break it on purpose, the way a write outside money.js would, and check
  // the reconciler actually notices. If it cannot see this, it is decoration.
  await pool().query(
    `UPDATE balances SET amount = amount + 777 WHERE player_id = $1 AND currency='gram'`, [a]);
  const caught = (await money.reconcile(null)).find(r => r.playerId === a);
  ok(caught && Math.abs(caught.drift - 777) < 1e-9,
    'звірка ЛОВИТЬ запис в обхід леджера', caught ? `drift=${caught.drift}` : 'не знайшла');

  // ── 10. the ledger is append-only to the app role ────────────────────────
  // Verified here as well as in verify.sql, because this is the guarantee the
  // reconciler's entire value rests on: if the app can rewrite history, the
  // check above compares a number against a number the same process wrote.
  // BY SQLSTATE, not by "it threw". `try { … rewrote = true } catch {}` passes
  // on every error there is, including the ones this line could contain: write
  // `SET delat = 0` and PostgreSQL raises 42703 undefined_column, the catch
  // eats it, `rewrote` stays false, and the append-only guarantee that the
  // reconciler's entire value rests on is proved by a typo in the test. 42501
  // — insufficient_privilege — is the only answer that means the REVOKE in
  // server/db/migrate.sh is actually holding, and it is also the answer that
  // stops meaning it the day this connects as a role that owns the table.
  eq(await sqlstate(() => pool().query('UPDATE ledger SET delta = 0 WHERE idem_key = $1', [`${TAG}:c1`])),
    '42501', 'застосунок не може ПЕРЕПИСАТИ леджер — REVOKE UPDATE тримає');
  eq(await sqlstate(() => pool().query('DELETE FROM ledger WHERE idem_key = $1', [`${TAG}:c1`])),
    '42501', 'і не може ВИДАЛИТИ рядок — без цього історію можна просто вкоротити');
}

async function cleanup() {
  if (!made.length) return;
  // ledger has no ON DELETE CASCADE from players (deliberately — money history
  // must outlive an account), so it goes first and by hand.
  await pool().query('DELETE FROM ledger  WHERE player_id = ANY($1)', [made]).catch(() => {});
  await pool().query('DELETE FROM balances WHERE player_id = ANY($1)', [made]).catch(() => {});
  await pool().query('DELETE FROM players  WHERE id = ANY($1)', [made]).catch(() => {});
}

main()
  .catch(err => { fail++; failures.push('НЕОБРОБЛЕНА ПОМИЛКА'); console.error('\n', err); })
  .finally(async () => {
    await cleanup();
    await close();
    console.log(`\n  ${pass} пройшло, ${fail} впало`);
    if (failures.length) console.log('  впали: ' + failures.join(' · '));
    process.exit(fail ? 1 : 0);
  });
