-- ═══════════════════════════════════════════════════════════════════════════
--  004_deposits — on-chain deposits, withdrawals, and the state the scanner
--                 cannot afford to lose
-- ═══════════════════════════════════════════════════════════════════════════
-- What this replaces: gramDepositRequest created a row with a client-supplied
-- amount and no upper bound, and the ONLY check that a payment had actually
-- arrived was the admin looking at a Telegram message and pressing ✅. A player
-- could send 0.1 TON and request 1000 GRAM; the defence was the admin being
-- awake.
--
-- The model here is receive-only, so the server never holds a private key:
--   * the player asks for an intent → gets the address plus a UNIQUE comment
--   * they transfer TON with that comment
--   * a scanner reads the chain, matches the comment, and credits exactly once
--   * the admin button becomes a fallback for edge cases, not the check

-- ── kv — small pieces of operational state ─────────────────────────────────
-- Exists for one value in particular: the scanner's watermark.
--
-- It lives in POSTGRES, not Redis, and that is a deliberate durability
-- decision rather than convenience. If the watermark is lost the scanner
-- cannot re-establish it: it walks its whole page budget every tick, gets rate
-- limited, sees empty pages and credits NOTHING — silently, with no exception
-- and therefore no alert. Redis is a cache we are allowed to lose. This is not.
CREATE TABLE kv (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── gram_tx additions ──────────────────────────────────────────────────────
-- The sending address, kept for every credited deposit: it is what lets a
-- support question ("I sent it from Tonkeeper, where is it") be answered from
-- the record rather than from the chain.
ALTER TABLE gram_tx ADD COLUMN sender text;

-- Which tick of the scanner credited it, so a run can be audited end to end.
ALTER TABLE gram_tx ADD COLUMN credited_at timestamptz;

-- Withdrawals move real money out. `paid_tx_hash` is the outgoing transfer the
-- admin actually sent — without it, "was this paid?" is answerable only by a
-- human remembering.
ALTER TABLE gram_tx ADD COLUMN paid_tx_hash text;

-- A deposit intent is only matchable while it is pending, and the partial
-- unique index in 002 already enforces one open memo at a time. This one makes
-- the scanner's lookup (memo -> intent, ANY status) an index scan: it has to
-- see credited intents too, in order to tell "a re-scan of the transfer we
-- already credited" apart from "someone reused a spent comment".
CREATE INDEX gram_tx_memo_idx ON gram_tx (memo) WHERE memo IS NOT NULL;

-- ── unmatched_deposits — money that arrived and could not be credited ───────
-- Real TON that reached the address with no comment, an unknown comment, a
-- reused one, or below the minimum. Without this table those transfers are
-- invisible: the scanner would re-parse them every tick forever while the
-- player's money sits unclaimed and nobody knows.
--
-- tx_id is the primary key, which is what makes recording one idempotent — the
-- scanner deliberately re-reads old events (overlap is safe), and a second
-- sighting must not produce a second row or a second admin alert.
CREATE TABLE unmatched_deposits (
  tx_id       text PRIMARY KEY,
  currency    text        NOT NULL DEFAULT 'ton',
  amount      numeric(24,8) NOT NULL CHECK (amount > 0),
  -- Verbatim from the chain, and therefore attacker-controlled. Bounded here
  -- because an over-long value raised a truncation error that the caller
  -- swallowed — so no row was written, no alert fired, and the transfer was
  -- re-parsed every tick forever.
  comment     text        CHECK (comment IS NULL OR length(comment) <= 128),
  sender      text        CHECK (sender  IS NULL OR length(sender)  <= 72),
  reason      text        NOT NULL,   -- no_comment | unknown_comment | comment_reused | below_min
  resolved_by text,                   -- admin telegram id, once handled
  resolved_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX unmatched_open_idx ON unmatched_deposits (created_at DESC)
  WHERE resolved_at IS NULL;

-- ── admin actions — who did what with someone else's money ─────────────────
-- Every manual decision (approve a withdrawal, credit an unmatched deposit,
-- ban an account) gets a row. The old build logged some of this to the player
-- log and some nowhere at all, so "who approved this payout" had no answer.
CREATE TABLE admin_actions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  admin_tg_id text        NOT NULL,
  action      text        NOT NULL,
  ref_type    text,
  ref_id      text,
  meta        jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX admin_actions_recent_idx ON admin_actions (created_at DESC);
