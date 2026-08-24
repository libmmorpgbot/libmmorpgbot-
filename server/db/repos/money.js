'use strict';
// ── Money ───────────────────────────────────────────────────────────────────
// Every movement of gold, GRAM and Nexum goes through this file. Nothing else
// may write `balances` — that is enforced below by the shape of these two
// functions and, in the database, by the ledger being append-only to the
// application role (see migrate.sh's REVOKE).
//
// What this replaces, and why the replacement is a different KIND of thing:
//
// The Mongo version moved money with a single atomic $inc, which was correct
// as far as it went — two credits landing together added up instead of
// overwriting. But $inc alone cannot express "take this money AND give that
// item AND close that listing, or do none of it". So every economy handler
// wrote its own unwind by hand: marketBuy refunds the buyer when delivery
// fails, marketList relists when removal fails, gramShopBuy puts the GRAM
// back when the write fails. Each unwind is itself a step that can fail, and
// several of them WERE the bug rather than the fix — a refund that ran twice,
// or one that never ran because the process died between the two writes.
//
// Here the unwind does not exist, because there is nothing to unwind: the
// caller wraps the whole operation in tx() and a throw anywhere rolls back
// the money along with everything else.
//
// Three rules for anyone adding a call site:
//
//   1. NEVER do arithmetic on a balance in JavaScript. `bal - price` in JS is
//      a float operation, and float is exactly what put a 1e-10 drift into the
//      old GRAM totals. The subtraction happens inside PostgreSQL, on numeric,
//      or it does not happen. The numbers these functions return are for
//      DISPLAY.
//   2. Every movement carries an idemKey. It is not optional — see below.
//   3. A spend that returns null is not an error to log and swallow. It means
//      the player could not afford it, and the caller must tell them.

const { query } = require('../index');

// ── Idempotency ─────────────────────────────────────────────────────────────
// idemKey is a UNIQUE column on `ledger`, and it is what makes a retried
// operation safe. It must be derived from WHAT is being paid for, never from
// the current time or a random value — the whole point is that the same
// logical operation produces the same key, so the second attempt is
// recognised and refused.
//
//   good:  `market_buy:${listingId}:${buyerId}`   the same purchase, always
//          `gram_tx:${txId}`                       the same deposit, always
//          `vip_claim:${playerId}:${tier}`         the same tier, once
//   bad:   `market_buy:${Date.now()}`              a new key per attempt, so
//                                                  a retry double-charges —
//                                                  i.e. no protection at all
//
// A replayed key is NOT an error. It returns the balance the original
// operation produced, so a client that retried after a lost acknowledgement
// sees the correct number rather than a failure for something that worked.

// pg returns `numeric` as a string, deliberately: parsing it to a float in the
// driver would silently reintroduce the precision loss numeric exists to
// avoid. Converting here is safe because these values are only ever displayed
// or compared, never accumulated — see rule 1 above. The range is far inside
// what a double represents exactly (a 1e6 GRAM balance at 8 decimals is 1e14,
// against 2^53 ≈ 9e15).
function num(v) {
  return v === null || v === undefined ? null : Number(v);
}

const CURRENCIES = new Set(['gold', 'gram', 'nexum']);

function _check(currency, amount, idemKey) {
  if (!CURRENCIES.has(currency)) throw new Error(`money: unknown currency ${currency}`);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`money: amount must be a positive finite number, got ${amount}`);
  if (typeof idemKey !== 'string' || !idemKey) throw new Error('money: idemKey is required — see the comment in repos/money.js');
}

// ── credit ──────────────────────────────────────────────────────────────────
// Adds money. Creates the balance row if this is the account's first of that
// currency, which is what makes a brand-new player's first drop work without
// anyone having to seed rows at signup.
//
// One statement, one round trip. The CTEs run in dependency order: `replay`
// decides whether anything happens at all, `moved` applies it, `logged`
// records it against the balance `moved` actually produced. Splitting these
// into three awaits would be three chances for the process to die between
// them, and a ledger that disagrees with the balance it claims to explain.
async function credit(db, playerId, currency, amount, { reason, refType = null, refId = null, idemKey }) {
  _check(currency, amount, idemKey);
  const { rows } = await query(db, `
    WITH replay AS (
      SELECT balance_after FROM ledger WHERE idem_key = $5
    ),
    moved AS (
      INSERT INTO balances AS b (player_id, currency, amount)
      SELECT $1, $2, $3::numeric
       WHERE NOT EXISTS (SELECT 1 FROM replay)
      ON CONFLICT (player_id, currency) DO UPDATE
        SET amount = b.amount + EXCLUDED.amount, updated_at = now()
      RETURNING amount
    ),
    logged AS (
      INSERT INTO ledger (player_id, currency, delta, balance_after, reason, ref_type, ref_id, idem_key)
      SELECT $1, $2, $3::numeric, moved.amount, $4, $6, $7, $5 FROM moved
      RETURNING balance_after
    )
    SELECT COALESCE((SELECT balance_after FROM logged),
                    (SELECT balance_after FROM replay)) AS balance,
           EXISTS (SELECT 1 FROM replay)                AS replayed
  `, [playerId, currency, amount, reason, idemKey, refType, refId]);

  const r = rows[0];
  return { balance: num(r.balance), replayed: r.replayed };
}

// ── spend ───────────────────────────────────────────────────────────────────
// Takes money, but only if it is there. Returns null when it is not — and
// when it returns null, NOTHING was written.
//
// `AND amount >= $3` inside the UPDATE is the whole design. Affordability and
// deduction are one statement under one row lock, so two purchases sent in the
// same instant cannot both pass the check against the same funds: the second
// one's UPDATE matches zero rows. There is no window between "can they afford
// it" and "take it", because there is no gap for a window to live in.
//
// This is what retires the "check, await, deduct" race that let a player buy
// two things with one balance (C3 in AUDIT.md).
async function spend(db, playerId, currency, amount, { reason, refType = null, refId = null, idemKey }) {
  _check(currency, amount, idemKey);
  const { rows } = await query(db, `
    WITH replay AS (
      SELECT balance_after FROM ledger WHERE idem_key = $5
    ),
    moved AS (
      UPDATE balances SET amount = amount - $3::numeric, updated_at = now()
       WHERE player_id = $1 AND currency = $2
         AND amount >= $3::numeric
         AND NOT EXISTS (SELECT 1 FROM replay)
      RETURNING amount
    ),
    logged AS (
      INSERT INTO ledger (player_id, currency, delta, balance_after, reason, ref_type, ref_id, idem_key)
      SELECT $1, $2, -$3::numeric, moved.amount, $4, $6, $7, $5 FROM moved
      RETURNING balance_after
    )
    SELECT (SELECT balance_after FROM logged) AS applied,
           (SELECT balance_after FROM replay) AS replay_balance,
           EXISTS (SELECT 1 FROM replay)      AS replayed
  `, [playerId, currency, amount, reason, idemKey, refType, refId]);

  const r = rows[0];
  if (r.replayed) return { balance: num(r.replay_balance), replayed: true };
  if (r.applied === null) return null;          // not enough — nothing written
  return { balance: num(r.applied), replayed: false };
}

// ── transfer ────────────────────────────────────────────────────────────────
// Moves money between two accounts. Not a convenience wrapper: doing it as
// spend-then-credit from a handler is how you get a seller who was never paid
// because the process died in between. Here both legs share the caller's
// transaction, so the pair is atomic.
//
// The two idemKeys are derived from one, so a retry recognises BOTH legs. If
// they were independent, a retry could replay one and re-apply the other —
// which is worse than no idempotency at all, because it silently creates money.
async function transfer(db, fromId, toId, currency, amount, { reason, refType = null, refId = null, idemKey }) {
  const taken = await spend(db, fromId, currency, amount,
    { reason, refType, refId, idemKey: `${idemKey}:out` });
  if (!taken) return null;
  const given = await credit(db, toId, currency, amount,
    { reason, refType, refId, idemKey: `${idemKey}:in` });
  return { from: taken.balance, to: given.balance };
}

// ── reads ───────────────────────────────────────────────────────────────────

// Every currency the account holds, as a plain object with zeros filled in —
// a missing row means zero, and making the caller distinguish those two is a
// source of `undefined` arithmetic for no benefit.
async function balancesOf(db, playerId) {
  const { rows } = await query(db,
    'SELECT currency, amount FROM balances WHERE player_id = $1', [playerId]);
  const out = { gold: 0, gram: 0, nexum: 0 };
  for (const r of rows) out[r.currency] = num(r.amount);
  return out;
}

// Recent movements for one account — the "where did my GRAM go" answer that
// the Mongo version simply could not give, because nothing recorded it.
async function history(db, playerId, currency, limit = 30) {
  const { rows } = await query(db, `
    SELECT delta, balance_after, reason, ref_type, ref_id, created_at
      FROM ledger
     WHERE player_id = $1 AND currency = $2
     ORDER BY id DESC
     LIMIT $3`, [playerId, currency, Math.min(limit, 200)]);
  return rows.map(r => ({
    delta: num(r.delta),
    balanceAfter: num(r.balance_after),
    reason: r.reason,
    refType: r.ref_type,
    refId: r.ref_id,
    at: r.created_at,
  }));
}

// ── reconcile ───────────────────────────────────────────────────────────────
// The check that makes the ledger worth having: for every account and every
// currency, the sum of everything that ever moved must equal what the balance
// says it holds. Anything else means money was created or destroyed outside
// these functions, and this is the only way to find out.
//
// Returns the accounts that DISAGREE. An empty array is the expected result,
// and the day it stops being empty is the day something is genuinely wrong —
// which is exactly the signal that did not exist before, when a balance was a
// number with no history to check it against.
//
// Meant to run nightly. It is a full aggregate over the ledger, so it is not
// something to call from a request path.
async function reconcile(db) {
  const { rows } = await query(db, `
    SELECT b.player_id, b.currency,
           b.amount                    AS balance,
           COALESCE(SUM(l.delta), 0)   AS ledger_total,
           b.amount - COALESCE(SUM(l.delta), 0) AS drift
      FROM balances b
      LEFT JOIN ledger l
        ON l.player_id = b.player_id AND l.currency = b.currency
     GROUP BY b.player_id, b.currency, b.amount
    HAVING b.amount <> COALESCE(SUM(l.delta), 0)
     ORDER BY abs(b.amount - COALESCE(SUM(l.delta), 0)) DESC`);
  return rows.map(r => ({
    playerId: Number(r.player_id),
    currency: r.currency,
    balance: num(r.balance),
    ledgerTotal: num(r.ledger_total),
    drift: num(r.drift),
  }));
}

module.exports = { credit, spend, transfer, balancesOf, history, reconcile };
