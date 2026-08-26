'use strict';
// ── GRAM in and out ─────────────────────────────────────────────────────────
// Deposits are verified by the chain. Withdrawals are still paid by hand — the
// server holds no private key and cannot move funds — but every step around
// that payment is recorded, idempotent and reversible.
//
// What this replaces, precisely: gramDepositRequest accepted a client-supplied
// `amount` with no upper bound and no finiteness check, created a "request",
// and the only thing standing between that and a credit was an admin looking at
// a Telegram message and pressing ✅. Sending 0.1 TON and asking for 1000 GRAM
// worked if the admin was tired. Nothing anywhere compared the request to the
// chain.
//
// Now the amount is not requested at all. It is READ from the transfer.

const crypto = require('crypto');
const { query, tx } = require('../index');
const money = require('./money');
const ton = require('../../ton');

// GRAM is 1:1 with TON in this game (see js/tonconnect.js's tcSendDeposit,
// which sends amountTon for a GRAM figure).
const MIN_DEPOSIT_TON = Number(process.env.GRAM_MIN_DEPOSIT || 0.05);
const INTENT_TTL_MS = 30 * 60 * 1000;            // shown to the player as "expires in"
// Matching continues well past expiry: a player who left the tab open and sent
// an hour later still gets credited. Only after this does a memo stop matching,
// which is what keeps the scanner's candidate set small.
const INTENT_GRACE_MS = 7 * 24 * 3600 * 1000;
const REFERRAL_PCT = 0.05;

// ── intents ─────────────────────────────────────────────────────────────────

// 6 random bytes. The memo is the ONLY thing linking an on-chain transfer to an
// account, so it has to be unguessable as well as unique: a predictable memo
// would let someone else's incoming transfer be claimed by guessing it.
// crypto.randomBytes, not Math.random.
function _memo() {
  return 'LBT-' + crypto.randomBytes(6).toString('hex').toUpperCase();
}

async function createIntent(db, playerId) {
  const addr = process.env.GRAM_WALLET || '';
  if (!ton.validAddress(addr)) {
    const e = new Error('Приём депозитов временно недоступен');
    e.code = 'no_wallet'; e.userMessage = e.message; throw e;
  }

  // ── one open code per player ────────────────────────────────────────────
  // Opening the deposit panel twice must show the SAME code twice. The unique
  // index is on the memo, not on the player, so nothing in the database stops
  // a second intent, and minting one per tap costs two things that both end in
  // money nobody can place: a row per tap that the sweep only clears after
  // INTENT_GRACE_MS, and a player watching their code change under them — who
  // then stops trusting the one they already pasted into their wallet.
  //
  // expires_at is DISPLAY ONLY: the scanner matches on created_at against the
  // grace window and never reads this column. So it is refreshed here to say
  // honestly how long this view of the code is good for, and LEAST() caps it
  // at the row's own grace deadline — a countdown that outlived the row's
  // matchability would be a promise the scanner does not keep.
  //
  // Two opens racing with no row yet can still both insert. Deliberately not
  // locked: both memos belong to the same player and both credit that player,
  // so the cost is one spare row, while the only lock that would prevent it
  // would serialise every deposit panel in the game behind one table.
  const { rows: open } = await query(db, `
    UPDATE gram_tx
       SET expires_at = LEAST(created_at + ($3 || ' milliseconds')::interval,
                              now()      + ($2 || ' milliseconds')::interval)
     WHERE id = (SELECT g.id FROM gram_tx g
                  WHERE g.player_id = $1 AND g.type = 'deposit' AND g.status = 'pending'
                    AND g.created_at > now() - ($3 || ' milliseconds')::interval
                  ORDER BY g.created_at DESC LIMIT 1)
    RETURNING id, memo, expires_at`,
    [playerId, String(INTENT_TTL_MS), String(INTENT_GRACE_MS)]);
  if (open.length) {
    return {
      id: Number(open[0].id), memo: open[0].memo, address: addr,
      minAmount: MIN_DEPOSIT_TON, expiresAt: open[0].expires_at, reused: true,
    };
  }

  // The partial unique index on (memo) WHERE type='deposit' AND status='pending'
  // is what makes a collision impossible rather than unlikely; the retry loop
  // is here so a collision costs a retry instead of an error to the player.
  for (let i = 0; i < 6; i++) {
    const memo = _memo();
    try {
      const { rows } = await query(db, `
        INSERT INTO gram_tx (player_id, type, amount, status, memo, expires_at)
        VALUES ($1, 'deposit', $2, 'pending', $3, now() + ($4 || ' milliseconds')::interval)
        RETURNING id, memo, expires_at`,
        // amount is a placeholder: the real figure is read from the chain when
        // the transfer arrives. The column is NOT NULL CHECK (> 0), so the
        // minimum is used as the stand-in rather than a lie like zero.
        [playerId, MIN_DEPOSIT_TON, memo, String(INTENT_TTL_MS)]);
      return {
        id: Number(rows[0].id), memo: rows[0].memo, address: addr,
        minAmount: MIN_DEPOSIT_TON, expiresAt: rows[0].expires_at, reused: false,
      };
    } catch (e) {
      if (e.code !== '23505') throw e;            // not a memo collision
    }
  }
  throw new Error('gram: could not allocate a unique memo');
}

// ── the scanner ─────────────────────────────────────────────────────────────

const WATERMARK_KEY = 'deposit:last_lt';

async function _watermark() {
  const { rows } = await query(null, 'SELECT value FROM kv WHERE key = $1', [WATERMARK_KEY]);
  const n = rows.length ? Number(rows[0].value) : 0;
  return Number.isFinite(n) ? n : 0;
}

async function _setWatermark(v) {
  await query(null, `
    INSERT INTO kv (key, value) VALUES ($1, $2)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [WATERMARK_KEY, String(v)]);
}

// Decides what to do with ONE incoming transfer, given the intent it names.
// Pure, so it can be tested without a chain or a database.
//
// The 'skip' verdict matters more than it looks: the scanner re-reads old
// events on purpose (overlap is free because crediting is idempotent), and
// without this branch every re-scan of an already-credited transfer would land
// in "reused comment" and produce a bogus unmatched row plus a false alert —
// one per real deposit, on the very next tick.
function classify(transfer, intent) {
  if (!transfer.comment) return { verdict: 'unmatched', reason: 'no_comment' };
  if (!intent) return { verdict: 'unmatched', reason: 'unknown_comment' };
  if (intent.status === 'confirmed') {
    return intent.chain_tx_hash === transfer.txId
      ? { verdict: 'skip' }
      : { verdict: 'unmatched', reason: 'comment_reused' };
  }
  if (intent.status !== 'pending') return { verdict: 'unmatched', reason: 'comment_reused' };
  if (Number(transfer.amount) < MIN_DEPOSIT_TON) {
    // Deliberately does NOT burn the memo: the player can top up, and an admin
    // can credit it manually. Burning it would strand the money.
    return { verdict: 'unmatched', reason: 'below_min' };
  }
  return { verdict: 'credit' };
}

// Credits exactly once. The intent row is locked and its status re-checked
// inside the transaction, so two overlapping scanner ticks — or the same memo
// paid twice in one batch — cannot both credit.
async function creditOnce(transfer, intentId) {
  return tx(async (t) => {
    const { rows } = await query(t, `
      SELECT id, player_id, status, memo FROM gram_tx
       WHERE id = $1 FOR UPDATE`, [intentId]);
    if (!rows.length || rows[0].status !== 'pending') return null;   // raced
    const intent = rows[0];
    const playerId = Number(intent.player_id);

    await query(t, `
      UPDATE gram_tx
         SET status = 'confirmed', amount = $2::numeric, chain_amount = $2::numeric,
             chain_tx_hash = $3, sender = $4, decided_by = 'indexer',
             decided_at = now(), credited_at = now()
       WHERE id = $1`, [intentId, transfer.amount, transfer.txId, transfer.sender]);

    // Keyed on the MEMO, not the tx: one memo credits once, whatever arrives
    // carrying it. That is the same guarantee from the other direction, and it
    // holds even if the same transfer is reported under two different ids.
    const credited = await money.credit(t, playerId, 'gram', Number(transfer.amount), {
      reason: 'deposit', refType: 'gram_tx', refId: String(intentId),
      idemKey: `deposit:memo:${intent.memo}`,
    });

    // 5% to the referrer, same as the old flow. Its own idem key, so a retry
    // of the deposit cannot pay the referral twice.
    let referral = null;
    const { rows: ref } = await query(t,
      `SELECT r.id AS ref_id FROM players p JOIN players r ON r.telegram_id = p.referred_by
        WHERE p.id = $1`, [playerId]);
    if (ref.length) {
      const bonus = Math.round(Number(transfer.amount) * REFERRAL_PCT * 100) / 100;
      if (bonus > 0) {
        await money.credit(t, Number(ref[0].ref_id), 'gram', bonus, {
          reason: 'deposit_referral', refType: 'gram_tx', refId: String(intentId),
          idemKey: `deposit:referral:${intent.memo}`,
        });
        referral = { playerId: Number(ref[0].ref_id), amount: bonus };
      }
    }

    const { rows: who } = await query(t,
      'SELECT username, telegram_id FROM players WHERE id = $1', [playerId]);
    return {
      intentId, playerId, memo: intent.memo,
      username: who[0] && who[0].username, telegramId: who[0] && who[0].telegram_id,
      amount: Number(transfer.amount), balance: credited.balance,
      txId: transfer.txId, sender: transfer.sender, referral,
    };
  });
}

// Money that arrived and cannot be credited. Idempotent on tx_id — the scanner
// re-reads old events by design, and a second sighting must produce neither a
// second row nor a second alert.
//
// Returns true only on FIRST sight, which is what the caller keys the alert on.
async function recordUnmatched(transfer, reason) {
  try {
    const { rowCount } = await query(null, `
      INSERT INTO unmatched_deposits (tx_id, currency, amount, comment, sender, reason)
      VALUES ($1, 'ton', $2::numeric, $3, $4, $5)
      ON CONFLICT (tx_id) DO NOTHING`,
      // Truncated to the column bounds. An over-long on-chain comment used to
      // raise a truncation error the caller swallowed, so no row was written,
      // no alert fired, and the transfer was re-parsed every tick forever while
      // real money sat unclaimed.
      [transfer.txId, transfer.amount,
       transfer.comment ? String(transfer.comment).slice(0, 128) : null,
       transfer.sender ? String(transfer.sender).slice(0, 72) : null, reason]);
    return rowCount === 1;
  } catch (err) {
    console.error('[gram] recordUnmatched:', err.message);
    return false;                                  // never break the scan
  }
}

// One pass. Returns what happened so the caller can report it; throws nothing
// that a caller has to handle, because a scan that fails must retry, not crash
// the process it runs in.
async function scanOnce({ pageSize = 50, maxPages = 20 } = {}) {
  const ourRaw = await ton.ourAddressRaw();
  if (!ourRaw) return { credited: [], unmatched: [], failed: true, reason: 'address_unresolved' };

  const wm = await _watermark();

  // ── the first run on a wallet that already has a past ────────────────────
  // The watermark is a LOGICAL TIME, not a timestamp: an ever-increasing
  // number the chain assigns to each transaction. Absent, it reads as 0, which
  // is below every event that has ever happened — so the first scan walked the
  // wallet's entire history and raised "платёж не зачислен" for every payment
  // it had ever received. This wallet carries months of them from the build
  // being replaced: ten alerts in one second, all describing transfers that
  // were credited correctly a month ago.
  //
  // That is worse than noise. An operator who has learned that those alerts
  // are meaningless is an operator who will scroll past the real one.
  //
  // So the first run PLANTS the mark at the newest event and processes
  // nothing. Everything from that moment on is ours; everything before it
  // belongs to whatever was running before. Bootstrapping cannot be done in
  // _watermark() — the starting point has to come from the chain, and a read
  // that fails must leave the mark unset so the next tick tries again rather
  // than silently starting from zero.
  if (!wm) {
    const probe = await ton.fetchSince(0, { pageSize: 1, maxPages: 1 });
    if (probe.failed || !probe.highest) {
      return { credited: [], unmatched: [], failed: true, reason: 'bootstrap_unreadable' };
    }
    await _setWatermark(probe.highest);
    console.log(`[gram] метка сканирования установлена на lt=${probe.highest}; ` +
                'история кошелька до этого момента не рассматривается');
    return { credited: [], unmatched: [], failed: false, seen: 0, bootstrapped: probe.highest };
  }

  const { events, highest, clean, failed } = await ton.fetchSince(wm, { pageSize, maxPages });

  // ONLY on a clean pass. Advancing past events we could not read would lose
  // those deposits permanently and silently; re-scanning costs nothing.
  if (clean && highest > wm) await _setWatermark(highest);

  const transfers = ton.incomingFrom(events, ourRaw);
  if (!transfers.length) return { credited: [], unmatched: [], failed, seen: 0 };

  // Drop everything already dealt with, in one query rather than per transfer.
  const ids = transfers.map(t => t.txId);
  const { rows: done } = await query(null, `
    SELECT chain_tx_hash AS id FROM gram_tx WHERE chain_tx_hash = ANY($1)
    UNION ALL
    SELECT tx_id AS id FROM unmatched_deposits WHERE tx_id = ANY($1)`, [ids]);
  const seenIds = new Set(done.map(r => r.id));
  const fresh = transfers.filter(t => !seenIds.has(t.txId));
  if (!fresh.length) return { credited: [], unmatched: [], failed, seen: transfers.length };

  // Resolve every referenced memo at ANY status, so classify() can tell a
  // re-scan apart from a reused memo.
  const memos = [...new Set(fresh.map(t => t.comment).filter(Boolean))];
  const byMemo = new Map();
  if (memos.length) {
    const { rows } = await query(null, `
      SELECT id, player_id, memo, status, chain_tx_hash
        FROM gram_tx
       WHERE type = 'deposit' AND memo = ANY($1)
         AND created_at > now() - ($2 || ' milliseconds')::interval`,
      [memos, String(INTENT_GRACE_MS)]);
    for (const r of rows) byMemo.set(r.memo, r);
  }

  const credited = [], unmatched = [];
  for (const t of fresh) {
    const intent = t.comment ? byMemo.get(t.comment) : null;
    const { verdict, reason } = classify(t, intent);
    if (verdict === 'skip') continue;
    if (verdict === 'unmatched') {
      if (await recordUnmatched(t, reason)) unmatched.push({ ...t, reason });
      continue;
    }
    const res = await creditOnce(t, intent.id);
    if (res) credited.push(res);
    // creditOnce returning null means another tick won the race for this memo;
    // this transfer is then a genuine second send on a spent comment.
    else if (await recordUnmatched(t, 'comment_reused')) unmatched.push({ ...t, reason: 'comment_reused' });
  }
  return { credited, unmatched, failed, seen: transfers.length };
}

// ── withdrawals ─────────────────────────────────────────────────────────────
// The GRAM leaves the balance when the request is CREATED, not when it is paid.
// Otherwise a player could request three payouts against one balance and the
// admin would approve all three before any of them deducted.

async function requestWithdraw(db, playerId, amount, address, { minAmount, feePct }) {
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    const e = new Error('Некорректная сумма'); e.code = 'bad_amount'; e.userMessage = e.message; throw e;
  }
  if (amt < minAmount) {
    const e = new Error(`Минимальная сумма вывода — ${minAmount} GRAM`);
    e.code = 'below_min'; e.userMessage = e.message; throw e;
  }
  if (!ton.validAddress(String(address || '').trim())) {
    const e = new Error('Некорректный TON-адрес'); e.code = 'bad_address'; e.userMessage = e.message; throw e;
  }

  const { rows: open } = await query(db, `
    SELECT count(*)::int n FROM gram_tx
     WHERE player_id = $1 AND type = 'withdraw' AND status = 'pending'`, [playerId]);
  if (open[0].n > 0) {
    const e = new Error('У вас уже есть заявка на рассмотрении');
    e.code = 'already_pending'; e.userMessage = e.message; throw e;
  }

  const { rows } = await query(db, `
    INSERT INTO gram_tx (player_id, type, amount, status, address)
    VALUES ($1, 'withdraw', $2::numeric, 'pending', $3) RETURNING id`,
    [playerId, amt, String(address).trim()]);
  const id = Number(rows[0].id);

  // Deducted here, in the same transaction that creates the request. If the
  // spend fails the request never existed.
  const paid = await money.spend(db, playerId, 'gram', amt, {
    reason: 'withdraw_request', refType: 'gram_tx', refId: String(id),
    idemKey: `withdraw:${id}`,
  });
  if (!paid) {
    const e = new Error('Недостаточно GRAM'); e.code = 'no_funds'; e.userMessage = e.message; throw e;
  }

  const fee = Math.round(amt * feePct * 100) / 100;
  return { id, amount: amt, fee, payout: Math.round((amt - fee) * 100) / 100, balance: paid.balance };
}

// Admin marks it paid. `status = 'pending'` in the WHERE is what stops two
// admins pressing the button at the same time from both recording a payout.
async function markWithdrawPaid(db, txId, adminTgId, paidTxHash = null) {
  const { rows } = await query(db, `
    UPDATE gram_tx SET status = 'confirmed', decided_by = $2, decided_at = now(),
                       paid_tx_hash = $3
     WHERE id = $1 AND type = 'withdraw' AND status = 'pending'
    RETURNING player_id, amount, address`, [txId, String(adminTgId), paidTxHash]);
  return rows.length ? { playerId: Number(rows[0].player_id), amount: Number(rows[0].amount), address: rows[0].address } : null;
}

// ── the two ways to cancel ──────────────────────────────────────────────────
// They are separate functions rather than one with a flag, because the flag
// would be the single most consequential argument in this file and the easiest
// to pass wrongly. The GRAM already left the player's balance when they
// submitted; one of these puts it back and the other does not.

// Отменить (забрать) — the payout does not happen and the GRAM stays gone. For
// a fraudulent request or an account being closed out. No credit at all, so
// there is no idem key: the state change IS the whole effect, and the
// `status = 'pending'` filter makes it once-only.
async function forfeitWithdraw(db, txId, adminTgId, note = null) {
  const { rows } = await query(db, `
    UPDATE gram_tx SET status = 'forfeited', decided_by = $2, decided_at = now(),
                       admin_note = COALESCE($3, admin_note)
     WHERE id = $1 AND type = 'withdraw' AND status = 'pending'
    RETURNING player_id, amount`, [txId, String(adminTgId), note]);
  if (!rows.length) return null;
  return { playerId: Number(rows[0].player_id), amount: Number(rows[0].amount), refunded: false };
}

// Отменить (вернуть) — the GRAM goes back. Its own idem key so a double press
// refunds once.
async function rejectWithdraw(db, txId, adminTgId, reason = null) {
  const { rows } = await query(db, `
    UPDATE gram_tx SET status = 'rejected', decided_by = $2, decided_at = now()
     WHERE id = $1 AND type = 'withdraw' AND status = 'pending'
    RETURNING player_id, amount`, [txId, String(adminTgId)]);
  if (!rows.length) return null;

  const back = await money.credit(db, Number(rows[0].player_id), 'gram', Number(rows[0].amount), {
    reason: 'withdraw_refund', refType: 'gram_tx', refId: String(txId),
    idemKey: `withdraw_refund:${txId}`,
  });
  return { playerId: Number(rows[0].player_id), amount: Number(rows[0].amount), balance: back.balance, reason };
}

// ── reads ───────────────────────────────────────────────────────────────────

async function historyOf(db, playerId, limit = 30) {
  const { rows } = await query(db, `
    SELECT id, type, amount, status, address, memo, chain_tx_hash, created_at, decided_at
      FROM gram_tx WHERE player_id = $1
     ORDER BY created_at DESC LIMIT $2`, [playerId, Math.min(limit, 100)]);
  return rows.map(r => ({
    id: Number(r.id), type: r.type, amount: Number(r.amount), status: r.status,
    address: r.address, memo: r.memo, txHash: r.chain_tx_hash,
    link: r.chain_tx_hash ? ton.explorerLink(r.chain_tx_hash) : null,
    createdAt: r.created_at, decidedAt: r.decided_at,
  }));
}

async function openUnmatched(db, limit = 50) {
  const { rows } = await query(db, `
    SELECT tx_id, amount, comment, sender, reason, created_at
      FROM unmatched_deposits WHERE resolved_at IS NULL
     ORDER BY created_at DESC LIMIT $1`, [Math.min(limit, 200)]);
  return rows.map(r => ({
    txId: r.tx_id, amount: Number(r.amount), comment: r.comment, sender: r.sender,
    reason: r.reason, at: r.created_at, link: ton.explorerLink(r.tx_id),
  }));
}

// Sweeps intents nobody ever paid, so the scanner's candidate set stays small.
// Expiry is generous (INTENT_GRACE_MS) because a late transfer is still real
// money and should still credit.
async function expireStaleIntents(db) {
  const { rowCount } = await query(db, `
    UPDATE gram_tx SET status = 'expired'
     WHERE type = 'deposit' AND status = 'pending'
       AND created_at < now() - ($1 || ' milliseconds')::interval`, [String(INTENT_GRACE_MS)]);
  return rowCount;
}

module.exports = {
  createIntent, scanOnce, classify, creditOnce, recordUnmatched,
  requestWithdraw, markWithdrawPaid, rejectWithdraw, forfeitWithdraw,
  historyOf, openUnmatched, expireStaleIntents,
  MIN_DEPOSIT_TON, REFERRAL_PCT,
  // Exported for the suite: the watermark's behaviour on an EMPTY key is the
  // part that decides whether a wallet's past is re-read, and it is not
  // reachable through scanOnce without a live chain.
  _watermark,
};
