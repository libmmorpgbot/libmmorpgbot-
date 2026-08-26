-- ── The name of a payment, and the operator who places one that has none ────
--
-- Two changes, and they are the same change seen from two ends: a transfer's
-- IDENTITY and a transfer's LOCATOR stopped being the same value, and money
-- that cannot be placed needs someone able to place it.
--
--
-- ── I. identity is not a hyperlink ─────────────────────────────────────────
--
-- On 25 August one 0.05 TON payment produced a credit at 21:52 and
-- "⚠️ Платёж не зачислен — нужен разбор" at 21:53. Both rows are real; the
-- second payment is not. Fetched back from TonAPI, the two ids resolve to one
-- event:
--
--   /v2/events/f7f5e993…  →  event_id 1058d708…  lt 99405635000001  1 action
--   /v2/events/1058d708…  →  event_id 1058d708…  lt 99405635000001  1 action
--
-- TonAPI reports an event whose trace is still in flight under a PROVISIONAL
-- id and renames it when the trace settles. server/ton.js named transfers
-- `<event_id>:<action index>` and nothing anywhere read `in_progress`, so the
-- scanner filed a payment under a name that was about to change and then
-- failed to recognise the payment it had already credited — one false alarm
-- per deposit, which is how the alert that matters stops being read.
--
-- The fix is in server/ton.js: an unsettled trace is not read at all, and a
-- transfer is named by `<lt>:<action index>` — the receiving account's own
-- logical time, which the watermark already depends on being stable and
-- monotonic, and which was IDENTICAL across both readings above.
--
-- The schema consequence is these two columns. A logical time is a perfectly
-- good name and a completely useless URL: Tonviewer resolves a trace hash and
-- nothing else. So the event id is kept BESIDE the identity rather than as it.
--
-- What that makes unrepresentable: a credited transfer whose only recorded
-- name is one the chain is allowed to change. And what it stops costing: the
-- Tonviewer link on the deposit history and on the ops card, which is the only
-- way anyone checks a payment against the chain.
--
-- Both nullable. Rows written before this migration keep a resolvable event id
-- inside chain_tx_hash / tx_id, and the code reads `COALESCE`-style across the
-- two eras rather than rewriting history — see historyOf and _unmatchedRow in
-- server/db/repos/gram.js. NOTHING HERE BACKFILLS. The old values are correct
-- for the rows that hold them, and an UPDATE that guessed at them would be
-- inventing evidence about money.

ALTER TABLE gram_tx
  ADD COLUMN IF NOT EXISTS chain_event_id text;

COMMENT ON COLUMN gram_tx.chain_event_id IS
  'TonAPI event id — the Tonviewer LINK for this transfer, never its identity: an unsettled trace is renamed when it settles';
COMMENT ON COLUMN gram_tx.chain_tx_hash IS
  'what this transfer is FILED under: <lt>:<action index> since the identity fix, <event_id>:<action index> before it. UNIQUE, and therefore the thing that makes one payment one row';


-- ── II. money that arrived and could not be placed ─────────────────────────
--
-- Migration 004 built `unmatched_deposits` to make stranded money VISIBLE, and
-- it succeeded at exactly that: 43 transfers totalling 646 TON from 26 wallets
-- are sitting in it, the oldest since 24 August. What 004 did not build is a
-- way to place one. `resolved_by` and `resolved_at` have been there since the
-- first day and NOTHING HAS EVER WRITTEN THEM — there is no code path that
-- could. gram.openUnmatched() was called by a detector and by nothing else,
-- and the Telegram card the scanner posts carries no buttons.
--
-- So the table is a list of money nobody can reach, which is worse than not
-- knowing: the operator is told, repeatedly, about a problem the system offers
-- them no way to act on. That is the shape of an alert people scroll past.
--
--
-- ── why an id, when tx_id is already the primary key ───────────────────────
--
-- Because a button has to carry it. Telegram caps `callback_data` at 64 BYTES,
-- and a tx id here is 66 characters or more before any prefix. There is no way
-- to name one of these rows on an inline keyboard, which is the mechanical
-- reason the card has no buttons rather than an oversight: whoever wrote
-- postUnmatched had nothing short enough to press.
--
-- tx_id STAYS the primary key. It is what makes recording a transfer
-- idempotent across the scanner's deliberate re-reads. This is a short local
-- handle for the same row, nothing more.
--
--
-- ── why resolved_player_id, when the credit is already in the ledger ───────
--
-- Two of these questions look alike and are not:
--
--   "who was given this money"   answerable from gram_tx: the placement writes
--                                a deposit row whose chain_tx_hash IS this
--                                row's tx_id, so the join needs no column.
--   "was this looked at and DECLINED"   answerable from nothing at all.
--
-- A transfer from a stranger's wallet with a stranger's comment is not a
-- mistake to fix; it is somebody else's money and the right outcome is that
-- nobody is credited. That outcome has to be recordable, or the queue can only
-- ever be emptied by giving money away — and an operator who cannot say "not
-- ours" leaves the row open, where it goes on being reported for ever.
--
-- The pair carries the meaning, the same way players.can_message and
-- .write_access_at do in migration 013:
--
--   resolved_at NULL                          nobody has looked at it yet
--   resolved_at set, resolved_player_id set   credited to that account
--   resolved_at set, resolved_player_id NULL  looked at, deliberately declined
--
-- What that makes unrepresentable: a stranded transfer marked handled with no
-- record of whether anyone received it.
--
--
-- ── why the message id ─────────────────────────────────────────────────────
--
-- The same reason migration 005 put admin_msg_id/ops_chat_id on gram_tx: the
-- decision is made somewhere other than the card. Placing a transfer takes
-- three presses across two chats — the card in the ops group, then a prompt and
-- a confirmation in the operator's DM, because a keyboard that hands out GRAM
-- has no business being drawn in a group. Without these the original card is
-- left in the topic with live buttons after the money has already been placed,
-- which is the shape that gets pressed again by the next operator to scroll
-- past it.

ALTER TABLE unmatched_deposits
  -- Existing rows are numbered by this ALTER in their physical order, which is
  -- arbitrary but stable, and that is all this column has to be.
  ADD COLUMN IF NOT EXISTS id                 bigint GENERATED ALWAYS AS IDENTITY,
  ADD COLUMN IF NOT EXISTS resolved_player_id bigint REFERENCES players(id),
  ADD COLUMN IF NOT EXISTS event_id           text,
  ADD COLUMN IF NOT EXISTS admin_msg_id       bigint,
  ADD COLUMN IF NOT EXISTS ops_chat_id        text;

-- The handle a button carries has to resolve to exactly one row, and it is the
-- only lookup key besides the primary key that anything uses.
CREATE UNIQUE INDEX IF NOT EXISTS unmatched_deposits_id_key
  ON unmatched_deposits (id);

COMMENT ON COLUMN unmatched_deposits.id IS
  'short local handle — the only name for this row that fits in 64 bytes of Telegram callback_data; tx_id remains the identity';
COMMENT ON COLUMN unmatched_deposits.resolved_player_id IS
  'who was credited; NULL WITH resolved_at SET means an operator looked and deliberately declined';
COMMENT ON COLUMN unmatched_deposits.event_id IS
  'TonAPI event id — the Tonviewer link, kept separately from tx_id for the same reason as gram_tx.chain_event_id';

-- ── a decision names its decider ───────────────────────────────────────────
-- Every path that resolves a row writes both columns in one statement, so this
-- constrains nothing the application does today. It is here so that the day
-- somebody adds a second path — a script, an admin endpoint, a hand-run UPDATE
-- during an incident — "resolved by whom" cannot come out NULL. Money leaving
-- an operator's hands with no name attached is precisely what migration 004's
-- admin_actions table exists to prevent, and this is the same rule for the same
-- reason, one table over.
--
-- NOT VALID deliberately. All 43 existing rows have resolved_at IS NULL and
-- would pass, but that is a claim about data nobody has read, and it is not
-- worth gambling the whole migration on. NOT VALID enforces the rule on every
-- row written or updated from now on — which is every row that matters — and
-- leaves the back catalogue alone. It can be promoted later with
-- `ALTER TABLE unmatched_deposits VALIDATE CONSTRAINT unmatched_decided_ck`,
-- which takes no exclusive lock.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'unmatched_decided_ck') THEN
    ALTER TABLE unmatched_deposits
      ADD CONSTRAINT unmatched_decided_ck
      CHECK (resolved_at IS NULL OR resolved_by IS NOT NULL) NOT VALID;
  END IF;
END $$;
