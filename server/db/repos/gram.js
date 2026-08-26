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
//
// ── why the ledger key is the MEMO and must stay the memo ───────────────────
//
// On 25 August one 0.05 TON payment produced two operator events: a credit at
// 21:52 and "⚠️ Платёж не зачислен" at 21:53, naming two different ids. It was
// never two payments. TonAPI reported the SAME transfer twice — once while its
// trace was still in flight under a provisional event id, once after it
// settled under the final one — and server/ton.js keyed on that id, so the
// second reading looked like money nobody had seen before.
//
//   /v2/events/f7f5e993…  →  event_id 1058d708…  lt 99405635000001
//   /v2/events/1058d708…  →  event_id 1058d708…  lt 99405635000001
//
// One transfer, one lt, two names. `deposit:memo:<memo>` is the ONLY reason
// 0.05 TON was not credited twice: the second reading found the intent already
// confirmed and refused it. Moving that key onto the transfer's id would have
// turned the refusal into a second credit — the key has to be derived from
// something the chain cannot rename, and a memo is minted here.
//
// The identity bug itself is fixed where identity is decided (server/ton.js:
// an unsettled trace is not read at all, and a transfer is named by the
// account's logical time rather than by the trace's provisional hash). This
// key stays as it is, because it is what holds when that layer is wrong.

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

// The shape above, as a prefix the scanner's memo lookup can filter on. See
// the LIKE in scanOnce for what it keeps out.
const MEMO_PREFIX = 'LBT-';

// ── is migration 014 applied? ───────────────────────────────────────────────
// Asked at most once a minute, the way items.js asks about its provenance
// columns, and answered "no" on a failure rather than throwing: a probe about
// bookkeeping must never be the thing that stops a deposit crediting.
//
// ONE question, not four, because the four columns arrive in one migration and
// each of them is useless on its own:
//
//   unmatched_deposits.id                  the only name for a stranded row
//                                          short enough for 64 bytes of
//                                          Telegram callback_data — i.e. the
//                                          reason its card can have buttons
//   unmatched_deposits.resolved_player_id  who received it, and NULL beside a
//                                          set resolved_at meaning "looked at,
//                                          deliberately declined"
//   unmatched_deposits.event_id            the Tonviewer link for a transfer
//   gram_tx.chain_event_id                 the same, for a credited one
//
// The last two exist because identity and locator stopped being the same
// value: a transfer is FILED under the receiving account's logical time (see
// server/ton.js) and LOOKED UP by the trace's event id, and one column was
// being asked to be both.
//
// Everything degrades rather than breaks without them: deposits credit, the
// stranded queue is still reported, the cards just lose their buttons and
// their links — and say so, in the warning below and on the card itself.
//
// ── why "no" is remembered for only a minute ────────────────────────────────
// A column cannot be dropped by anything this process does, so `true` is true
// for ever and is cached for ever. `false` is not: the owner applies migrations
// by hand against a running server, and a permanently cached "no" would mean
// the buttons stay missing until somebody thinks to restart — with the card
// still saying "apply migration 014" after it has been applied, which is the
// most confusing state available. One extra catalogue query a minute buys the
// migration taking effect when it is applied.
//
// ── and why it takes no `db` ────────────────────────────────────────────────
// It is asked from INSIDE creditOnce's transaction, and a probe that ran on
// that connection could abort it: a failed statement leaves a PostgreSQL
// transaction poisoned, so the catch below would swallow the error and the
// UPDATE that actually credits the deposit would then fail with "current
// transaction is aborted". A question about bookkeeping columns must not be
// able to take a payment down with it, so it always asks on its own connection.
let _opsCols = null;
let _opsColsAt = 0;
let _opsColsTold = false;
const OPS_PROBE_RETRY_MS = 60000;

async function hasDepositOpsCols() {
  if (_opsCols === true) return true;
  if (_opsCols === false && Date.now() - _opsColsAt < OPS_PROBE_RETRY_MS) return false;
  _opsColsAt = Date.now();
  try {
    const { rows } = await query(null, `
      SELECT count(*)::int n FROM information_schema.columns
       WHERE (table_name = 'unmatched_deposits'
              AND column_name IN ('id', 'resolved_player_id', 'event_id'))
          OR (table_name = 'gram_tx' AND column_name = 'chain_event_id')`);
    _opsCols = rows[0].n === 4;
    // ONCE, not once a minute. "The operator cannot place these" is a state
    // somebody has to be able to find out about without reading this file, and
    // a line repeated every minute for a week is a line nobody reads.
    if (!_opsCols && !_opsColsTold) {
      _opsColsTold = true;
      console.warn('[gram] миграция 014 не применена — незачисленные переводы '
        + 'показываются без кнопок и без ссылки на Tonviewer, '
        + 'зачислить вручную нельзя');
    }
    if (_opsCols) _opsColsTold = false;
  } catch (err) {
    console.error('[gram] проверка схемы под миграцию 014:', err.message);
    _opsCols = false;
  }
  return _opsCols;
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
//
// ── what `comment_reused` means now, and what it used to mean ──────────────
// Until the identity fix in server/ton.js it meant, almost every time, "the
// same payment under a second name": the transfer had already been credited,
// TonAPI had simply renamed it. That is why the branch is reached with an
// intent whose chain_tx_hash is set and DIFFERENT — it was the shape of a
// re-read, not of a second payment.
//
// With a transfer named by the receiving account's logical time, a re-read
// carries the id it carried before and never gets this far. What is left is
// the genuine case: a player paying a second time with a code they still have
// in their wallet. That money is real, it is theirs, and it is NOT credited
// automatically — the memo-keyed ledger entry is the last thing standing
// between a renamed re-read and a double credit, and it is not being spent on
// convenience. It goes to the operator queue, which can now place it in two
// presses (resolveUnmatched below). The alert is rare enough to be read again.
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

// ── the referral leg ────────────────────────────────────────────────────────
// 5% to the referrer, and it is shared by all three ways a deposit can land
// (the open intent, a repeat, an operator placing a stranded transfer) so that
// none of them can quietly be the one that does not pay it.
//
// The key is passed in WHOLE rather than built here, and that is not
// squeamishness: the scanner's deposits are keyed on the memo and an
// operator's placement on the transfer, because those are the two different
// things that make each of them once-only. A helper that invented one key for
// both would quietly give one of its callers the wrong guarantee.
async function _payReferral(t, playerId, amount, refId, idemKey) {
  const { rows: ref } = await query(t,
    `SELECT r.id AS ref_id FROM players p JOIN players r ON r.telegram_id = p.referred_by
      WHERE p.id = $1`, [playerId]);
  if (!ref.length) return null;
  const bonus = Math.round(Number(amount) * REFERRAL_PCT * 100) / 100;
  if (!(bonus > 0)) return null;
  await money.credit(t, Number(ref[0].ref_id), 'gram', bonus, {
    reason: 'deposit_referral', refType: 'gram_tx', refId: String(refId),
    idemKey,
  });
  return { playerId: Number(ref[0].ref_id), amount: bonus };
}

// Who the credit is announced to. One read rather than three copies of it.
async function _who(t, playerId) {
  const { rows } = await query(t,
    'SELECT username, telegram_id FROM players WHERE id = $1', [playerId]);
  return { username: rows[0] && rows[0].username, telegramId: rows[0] && rows[0].telegram_id };
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

    // Two whole statements rather than one with a column list built at
    // runtime — the same shape items.add() uses for its provenance columns,
    // and for the same two reasons: dev/sql-check.js can hand each of them to
    // the database as written, and a server on the pre-014 schema goes on
    // crediting deposits rather than failing on a column that records a
    // hyperlink. `chain_event_id` is the Tonviewer name for this transfer;
    // `chain_tx_hash` is what it is FILED under, and after the identity fix in
    // server/ton.js those are deliberately different values.
    if (await hasDepositOpsCols()) {
      await query(t, `
        UPDATE gram_tx
           SET status = 'confirmed', amount = $2::numeric, chain_amount = $2::numeric,
               chain_tx_hash = $3, chain_event_id = $5, sender = $4,
               decided_by = 'indexer', decided_at = now(), credited_at = now()
         WHERE id = $1`,
        [intentId, transfer.amount, transfer.txId, transfer.sender, transfer.eventId || null]);
    } else {
      await query(t, `
        UPDATE gram_tx
           SET status = 'confirmed', amount = $2::numeric, chain_amount = $2::numeric,
               chain_tx_hash = $3, sender = $4, decided_by = 'indexer',
               decided_at = now(), credited_at = now()
         WHERE id = $1`, [intentId, transfer.amount, transfer.txId, transfer.sender]);
    }

    // Keyed on the MEMO, not the transfer. One memo credits once, whatever
    // arrives carrying it — and that is the guarantee that held on 25 August,
    // when TonAPI offered the same 0.05 TON twice under two different event
    // ids. A transfer-keyed entry would have seen a name it had never stored
    // and credited the payment a second time. The chain can rename a transfer;
    // it cannot rename a code minted here.
    const credited = await money.credit(t, playerId, 'gram', Number(transfer.amount), {
      reason: 'deposit', refType: 'gram_tx', refId: String(intentId),
      idemKey: `deposit:memo:${intent.memo}`,
    });

    // 5% to the referrer, same as the old flow. Its own idem key, so a retry
    // of the deposit cannot pay the referral twice.
    const referral = await _payReferral(t, playerId, transfer.amount, intentId,
      `deposit:referral:${intent.memo}`);
    const who = await _who(t, playerId);
    return {
      intentId, playerId, memo: intent.memo, ...who,
      amount: Number(transfer.amount), balance: credited.balance,
      txId: transfer.txId, eventId: transfer.eventId || null,
      sender: transfer.sender, referral,
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
    // Truncated to the column bounds. An over-long on-chain comment used to
    // raise a truncation error the caller swallowed, so no row was written,
    // no alert fired, and the transfer was re-parsed every tick forever while
    // real money sat unclaimed.
    const comment = transfer.comment ? String(transfer.comment).slice(0, 128) : null;
    const sender = transfer.sender ? String(transfer.sender).slice(0, 72) : null;
    // The event id is stored where there is a column for it, because it is the
    // ONLY thing that gets an operator from this row to the transfer on
    // Tonviewer — and deciding who should receive somebody's 15 TON without
    // being able to look at it is not a decision anyone should be asked to make.
    if (await hasDepositOpsCols()) {
      const { rowCount } = await query(null, `
        INSERT INTO unmatched_deposits (tx_id, currency, amount, comment, sender, reason, event_id)
        VALUES ($1, 'ton', $2::numeric, $3, $4, $5, $6)
        ON CONFLICT (tx_id) DO NOTHING`,
        [transfer.txId, transfer.amount, comment, sender, reason, transfer.eventId || null]);
      return rowCount === 1;
    }
    const { rowCount } = await query(null, `
      INSERT INTO unmatched_deposits (tx_id, currency, amount, comment, sender, reason)
      VALUES ($1, 'ton', $2::numeric, $3, $4, $5)
      ON CONFLICT (tx_id) DO NOTHING`,
      [transfer.txId, transfer.amount, comment, sender, reason]);
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

  // ── everything already dealt with, in one query rather than per transfer ──
  // BOTH NAMES ARE ASKED FOR, and the second one is not belt and braces: it is
  // what carries the rows written before server/ton.js started naming
  // transfers by logical time. Those rows hold `<event_id>:<index>`; the same
  // transfer now arrives as `<lt>:<index>`, so a lookup on the new name alone
  // would find nothing, re-offer every recently-credited deposit as new, and
  // raise exactly the "нужен разбор" alert this change exists to stop — once
  // per deposit still inside the scan window, on the first tick after deploy.
  //
  // It also keeps working the other way round for ever: if TonAPI renames a
  // trace again, the old name is still on file and still recognised.
  const ids = [];
  for (const t of transfers) {
    ids.push(t.txId);
    if (t.eventId) ids.push(`${t.eventId}:${t.txId.split(':')[1]}`);
  }
  const { rows: done } = await query(null, `
    SELECT chain_tx_hash AS id FROM gram_tx WHERE chain_tx_hash = ANY($1)
    UNION ALL
    SELECT tx_id AS id FROM unmatched_deposits WHERE tx_id = ANY($1)`, [ids]);
  const seenIds = new Set(done.map(r => r.id));
  const fresh = transfers.filter(t =>
    !seenIds.has(t.txId)
    && !(t.eventId && seenIds.has(`${t.eventId}:${t.txId.split(':')[1]}`)));
  if (!fresh.length) return { credited: [], unmatched: [], failed, seen: transfers.length };

  // Resolve every referenced memo at ANY status, so classify() can tell a
  // re-scan apart from a reused memo.
  //
  // The LIKE is not decoration: gram_tx also holds deposit rows an OPERATOR
  // created by hand (resolveUnmatched below), whose memo is a `MANUAL:<tx>`
  // label rather than a code — the shape check in migration 002 requires a
  // deposit to have one. Routing a later payment by one of those labels would
  // credit whoever the operator picked that day. Only codes _memo() issued are
  // matchable, and this is the line that says so.
  const memos = [...new Set(fresh.map(t => t.comment).filter(Boolean))];
  const byMemo = new Map();
  if (memos.length) {
    const { rows } = await query(null, `
      SELECT id, player_id, memo, status, chain_tx_hash
        FROM gram_tx
       WHERE type = 'deposit' AND memo = ANY($1) AND memo LIKE $3
         AND created_at > now() - ($2 || ' milliseconds')::interval`,
      [memos, String(INTENT_GRACE_MS), MEMO_PREFIX + '%']);
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

// `link` reads chain_event_id first and falls back to chain_tx_hash, which is
// not redundancy: rows written before the identity fix hold a resolvable event
// id IN chain_tx_hash, and rows written after hold a logical time that
// Tonviewer has never heard of. One expression covers both eras, and
// explorerLink returns null rather than a URL that opens on "not found".
async function historyOf(db, playerId, limit = 30) {
  const n = Math.min(limit, 100);
  if (await hasDepositOpsCols()) {
    const { rows } = await query(db, `
      SELECT id, type, amount, status, address, memo, chain_tx_hash, chain_event_id,
             created_at, decided_at
        FROM gram_tx WHERE player_id = $1
       ORDER BY created_at DESC LIMIT $2`, [playerId, n]);
    return rows.map(_historyRow);
  }
  const { rows } = await query(db, `
    SELECT id, type, amount, status, address, memo, chain_tx_hash, created_at, decided_at
      FROM gram_tx WHERE player_id = $1
     ORDER BY created_at DESC LIMIT $2`, [playerId, n]);
  return rows.map(_historyRow);
}

function _historyRow(r) {
  return {
    id: Number(r.id), type: r.type, amount: Number(r.amount), status: r.status,
    address: r.address, memo: r.memo, txHash: r.chain_tx_hash,
    link: ton.explorerLink(r.chain_event_id || r.chain_tx_hash),
    createdAt: r.created_at, decidedAt: r.decided_at,
  };
}

// ── placing money that arrived and could not be credited ────────────────────
// Everything from here to expireStaleIntents is the path that did not exist.
// `unmatched_deposits` has recorded stranded transfers since migration 004 —
// 43 of them, 646 TON, from 26 wallets, the oldest since 24 August — and
// nothing has ever been able to act on one: openUnmatched() was called by a
// detector, `resolved_by`/`resolved_at` were written by no code at all, and the
// Telegram card the scanner posts carries no buttons. A queue an operator is
// shown and cannot empty is an alert they learn to scroll past.
//
// Nothing here runs automatically, and that is deliberate rather than
// cautious. The deposit wallet is shared with the live Mongo build, so most of
// those transfers are that game's players; an automatic sweep would hand one
// game's money to the other game's accounts. Every placement is one operator
// naming one account.

function _unmatchedRow(r) {
  return {
    id: r.id === undefined ? null : Number(r.id),
    txId: r.tx_id, amount: Number(r.amount), comment: r.comment, sender: r.sender,
    reason: r.reason, at: r.created_at,
    // Same two-era fallback as the deposit history: the 43 rows already in
    // this table hold a resolvable event id in tx_id, new ones hold a logical
    // time and carry the event id beside it.
    link: ton.explorerLink(r.event_id || r.tx_id),
  };
}

// Two whole statements rather than one with an interpolated column list, so
// dev/sql-check.js can hand both to the database as written. The pre-014 one
// is not dead code kept for tidiness: it is what the ops card falls back to,
// and it is why a server on the old schema still REPORTS stranded money
// instead of failing to post the card at all.
async function openUnmatched(db, limit = 50) {
  const n = Math.min(limit, 200);
  if (await hasDepositOpsCols()) {
    const { rows } = await query(db, `
      SELECT id, tx_id, amount, comment, sender, reason, created_at
        FROM unmatched_deposits WHERE resolved_at IS NULL
       ORDER BY created_at DESC LIMIT $1`, [n]);
    return rows.map(_unmatchedRow);
  }
  const { rows } = await query(db, `
    SELECT tx_id, amount, comment, sender, reason, created_at
      FROM unmatched_deposits WHERE resolved_at IS NULL
     ORDER BY created_at DESC LIMIT $1`, [n]);
  return rows.map(_unmatchedRow);
}

// One row by the short handle its card's buttons carry.
async function unmatchedById(db, id) {
  if (!(await hasDepositOpsCols())) return null;
  const { rows } = await query(db, `
    SELECT id, tx_id, amount, comment, sender, reason, created_at,
           resolved_at, resolved_by, resolved_player_id, admin_msg_id, ops_chat_id
      FROM unmatched_deposits WHERE id = $1`, [id]);
  if (!rows.length) return null;
  const r = rows[0];
  return {
    ..._unmatchedRow(r),
    resolvedAt: r.resolved_at, resolvedBy: r.resolved_by,
    resolvedPlayerId: r.resolved_player_id === null ? null : Number(r.resolved_player_id),
    msgId: r.admin_msg_id, chatId: r.ops_chat_id,
  };
}

// The same row, found by the chain's name for it. The scanner reports a fresh
// stranding as the TRANSFER it just parsed — recordUnmatched answers only
// whether this was the first sighting, because that is what the alert is keyed
// on — so the card has to look up the short handle it is about to print on a
// button. Its own statement rather than a column list built at runtime, so
// dev/sql-check.js reads both this and the one above as written.
async function unmatchedByTx(db, txId) {
  if (!(await hasDepositOpsCols())) return null;
  const { rows } = await query(db, `
    SELECT id, tx_id, amount, comment, sender, reason, created_at
      FROM unmatched_deposits WHERE tx_id = $1`, [txId]);
  return rows.length ? _unmatchedRow(rows[0]) : null;
}

// Which Telegram card carries this row, so a decision made in the operator's
// DM can rewrite the one sitting in the group instead of leaving live buttons
// under money that has already been placed. Best-effort: a card that cannot be
// found later is a cosmetic loss, and it must not fail the placement.
async function noteUnmatchedCard(db, id, msgId, chatId) {
  if (!(await hasDepositOpsCols())) return false;
  try {
    await query(db, `
      UPDATE unmatched_deposits SET admin_msg_id = $2, ops_chat_id = $3
       WHERE id = $1`, [id, msgId, chatId === null ? null : String(chatId)]);
    return true;
  } catch (err) {
    console.error('[gram] noteUnmatchedCard:', err.message);
    return false;
  }
}

// ── credit a stranded transfer to a named account ───────────────────────────
// Once, and provably once, by three independent means — which is not
// belt-and-braces so much as three different questions each having one answer:
//
//   `resolved_at IS NULL` in the WHERE      claims the row. A second press
//                                           updates nothing and returns null.
//   `chain_tx_hash UNIQUE`                  the transfer can appear on exactly
//                                           one deposit row, ever — so if the
//                                           scanner ever credited it, this
//                                           INSERT cannot.
//   `deposit:unmatched:<tx>` on the ledger  its own key namespace, because
//                                           this is a different act from the
//                                           scanner's memo-keyed credit and
//                                           must not be able to replay one.
//
// The claim goes first on purpose: it is the cheapest of the three and the one
// whose failure means "another operator already did this", which is the answer
// the person pressing the button needs.
//
// ── the one thing this refuses ──────────────────────────────────────────────
// A stranded row whose transfer has ALREADY been credited. Before the identity
// fix in server/ton.js, a re-read of a settled trace under its final event id
// produced a `comment_reused` row for money that was already in the player's
// balance — the 25 August row is exactly that, and crediting it would mint
// 0.05 GRAM from nothing. The rows written since cannot be that shape, but the
// ones already in the table can, and this is the operator path that would
// otherwise hand them out. Checked by the transfer's own name AND by the event
// id, because the two eras file it differently.
async function resolveUnmatched(id, playerId, adminTgId) {
  if (!(await hasDepositOpsCols())) {
    const e = new Error('Миграция 014 не применена — зачислить нельзя');
    e.code = 'no_migration'; e.userMessage = e.message; throw e;
  }
  return tx(async (t) => {
    const { rows } = await query(t, `
      UPDATE unmatched_deposits
         SET resolved_at = now(), resolved_by = $2, resolved_player_id = $3
       WHERE id = $1 AND resolved_at IS NULL
      RETURNING tx_id, amount, sender, comment, event_id`,
      [id, String(adminTgId), playerId]);
    if (!rows.length) return null;                   // already decided
    const u = rows[0];

    // Raised, not returned: this rolls the claim back, so the row stays open
    // and an operator who was about to give away money that is already spent
    // is told so instead of quietly succeeding.
    const { rows: dup } = await query(t, `
      SELECT id FROM gram_tx
       WHERE type = 'deposit' AND status = 'confirmed'
         AND (chain_tx_hash = $1
              OR ($2::text IS NOT NULL
                  AND (chain_event_id = $2 OR chain_tx_hash LIKE $2 || ':%')))
       LIMIT 1`, [u.tx_id, u.event_id]);
    if (dup.length) {
      const e = new Error(
        `Этот перевод уже зачислен (депозит №${dup[0].id}) — повторное зачисление создало бы GRAM из воздуха`);
      e.code = 'already_credited'; e.userMessage = e.message; throw e;
    }

    // A deposit row, so the player's own history shows the payment. Without
    // it their balance would rise with nothing in the wallet panel to explain
    // it, which is the same "where did this come from" the ledger exists to
    // answer — asked by the person it happened to.
    //
    // The memo is a LABEL, not a code. gram_tx's shape check requires a
    // deposit to have one, and putting the transfer's own comment here would
    // be worse than useless: if that comment were somebody's real LBT code,
    // this row would then compete with theirs to route their next payment.
    // `MANUAL:` cannot be issued by _memo() and is filtered out of the
    // scanner's lookup by MEMO_PREFIX.
    const { rows: dep } = await query(t, `
      INSERT INTO gram_tx (player_id, type, amount, status, memo, chain_tx_hash,
                           chain_event_id, chain_amount, sender, decided_by,
                           decided_at, credited_at)
      VALUES ($1, 'deposit', $2::numeric, 'confirmed', $3, $4, $7, $2::numeric, $5,
              $6, now(), now())
      RETURNING id`,
      [playerId, u.amount, `MANUAL:${u.tx_id}`.slice(0, 120), u.tx_id, u.sender,
       String(adminTgId), u.event_id]);
    const rowId = Number(dep[0].id);

    const credited = await money.credit(t, playerId, 'gram', Number(u.amount), {
      reason: 'deposit', refType: 'gram_tx', refId: String(rowId),
      idemKey: `deposit:unmatched:${u.tx_id}`,
    });
    const referral = await _payReferral(t, playerId, u.amount, rowId,
      `deposit:unmatched:referral:${u.tx_id}`);
    const who = await _who(t, playerId);

    // Recorded next to every other decision an operator makes about somebody
    // else's money. unmatched_deposits says what happened to the transfer;
    // this says who did it, in the one table that answers that question for
    // the whole system.
    await query(t, `
      INSERT INTO admin_actions (admin_tg_id, action, ref_type, ref_id, meta)
      VALUES ($1, 'unmatched_credit', 'unmatched_deposit', $2, $3)`,
      [String(adminTgId), String(id),
       JSON.stringify({ txId: u.tx_id, amount: Number(u.amount), playerId,
         username: who.username, comment: u.comment })]);

    return {
      id, txId: u.tx_id, eventId: u.event_id, playerId, gramTxId: rowId, ...who,
      amount: Number(u.amount), balance: credited.balance,
      sender: u.sender, referral, memo: null,
    };
  });
}

// ── not ours ────────────────────────────────────────────────────────────────
// The other half of a queue that can be emptied. A transfer from a stranger's
// wallet with a stranger's comment is not a mistake to fix, and without this
// the only way to clear a row would be to give the money to somebody — so the
// rows that should stay unclaimed are exactly the ones that would sit open for
// ever, reported on every scan, teaching everyone to ignore the topic.
//
// No credit, so no idem key: the state change is the whole effect, and
// `resolved_at IS NULL` makes it once-only. resolved_player_id stays NULL,
// which is what tells the two outcomes apart afterwards (migration 014).
async function declineUnmatched(id, adminTgId, note = null) {
  if (!(await hasDepositOpsCols())) {
    const e = new Error('Миграция 014 не применена');
    e.code = 'no_migration'; e.userMessage = e.message; throw e;
  }
  const { rows } = await query(null, `
    UPDATE unmatched_deposits
       SET resolved_at = now(), resolved_by = $2
     WHERE id = $1 AND resolved_at IS NULL
    RETURNING tx_id, amount`, [id, String(adminTgId)]);
  if (!rows.length) return null;
  await query(null, `
    INSERT INTO admin_actions (admin_tg_id, action, ref_type, ref_id, meta)
    VALUES ($1, 'unmatched_decline', 'unmatched_deposit', $2, $3)`,
    [String(adminTgId), String(id),
     JSON.stringify({ txId: rows[0].tx_id, amount: Number(rows[0].amount), note })])
    .catch(err => console.error('[gram] declineUnmatched audit:', err.message));
  return { id, txId: rows[0].tx_id, amount: Number(rows[0].amount) };
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
  historyOf, expireStaleIntents,
  openUnmatched, unmatchedById, unmatchedByTx, noteUnmatchedCard,
  resolveUnmatched, declineUnmatched, hasDepositOpsCols,
  MIN_DEPOSIT_TON, REFERRAL_PCT, MEMO_PREFIX,
  // Exported for the suite: the watermark's behaviour on an EMPTY key is the
  // part that decides whether a wallet's past is re-read, and it is not
  // reachable through scanOnce without a live chain.
  _watermark,
};
