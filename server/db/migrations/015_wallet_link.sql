-- ── Which wallet is this ACCOUNT's, and does every device know? ────────────
--
-- The owner's report: "якого хера гра на пк і на телефоні розходиться, на
-- телефоні в мене привязаний гаманець тон а на пк пише підключити гаманець".
--
-- They are right, and the cause is that the linked address was never stored
-- anywhere. `players` held identity and nothing about a wallet; no other table
-- held one either. js/tonconnect.js kept it in a module variable, restored on
-- each launch by TON Connect out of THAT BROWSER'S localStorage — so the phone
-- remembered and the desktop had never heard of it. Every wallet panel asks
-- tcAddress(), so on the desktop every one of them answered "not connected".
--
-- ── the distinction this column exists to make ─────────────────────────────
--
-- Two things were being conflated and only one of them can be per-account:
--
--   the LINKED ADDRESS   a fact about the account. Where this player's money
--                        goes. It must be visible on every device, auto-fill
--                        the withdrawal form everywhere, and be removable
--                        account-wide. That is this column.
--   a LIVE TON CONNECT SESSION   the ability to SIGN. Inherently per-device:
--                        the wallet app approves a transfer on the device it
--                        is paired with, and no column can change that. It
--                        stays in the browser, where it already is.
--
-- What this makes unrepresentable: an account whose payout address is known to
-- one browser and to nothing else.
--
-- It lives on `players` for the same reason can_message does (migration 013):
-- it is a fact about the ACCOUNT rather than about the character, and it is
-- read on the same login that already reads this row.
--
--   ton_address      the player's OWN wallet, friendly form. NOT the project's
--                    deposit address — that is GRAM_WALLET, it is configuration,
--                    it is the same for everybody, and it reaches the client as
--                    `gramWallet` while this one reaches it as `linkedWallet`.
--                    Two addresses on one screen, and confusing them means
--                    telling a player to pay themselves.
--   ton_address_at   when the link was last CHANGED — linked, relinked or
--                    unlinked. NULL means this account has never linked one.
--
-- ── why the timestamp, when an address already says yes or no ──────────────
--
-- Same shape as can_message / write_access_at, and for a sharper reason than
-- reporting. `ton_address IS NULL` is two different accounts wearing one value:
-- somebody who has never linked a wallet, and somebody who linked one and
-- deliberately pressed «Отвязать».
--
-- The client has to tell them apart, and this is the only place it can learn
-- it. A phone that still has a live TON Connect session PUBLISHES it when the
-- account has none — that is the whole backfill, and without it every existing
-- player would have to reconnect by hand on the device that already works to
-- fix a bug about the device that does not. But the same rule applied blindly
-- would undo an unlink: the player unlinks on the desktop, opens the phone,
-- the phone's restored session sees an empty account and links it straight
-- back. Two states, one meaning each:
--
--   ton_address NULL, ton_address_at NULL     never linked — a restored
--                                             session may publish itself
--   ton_address NULL, ton_address_at SET      unlinked on purpose — only a
--                                             deliberate connect may re-link
--   ton_address SET,  ton_address_at SET      linked, and when
--
-- What the pair makes unrepresentable: an unlink that a second device can
-- silently reverse by being opened.
--
-- ── NOT UNIQUE, deliberately ───────────────────────────────────────────────
--
-- The client is what asserts this address — there is no other source, exactly
-- as with can_message. A UNIQUE constraint would therefore hand every client a
-- weapon: claim somebody else's address and the honest owner can no longer
-- link their own wallet, with an error they cannot act on and support cannot
-- explain. It would also make two accounts sharing one wallet — a household,
-- one person with two characters — a support ticket rather than a shrug.
--
-- Nothing here needs uniqueness. This column is a CONVENIENCE (which address
-- to pre-fill, and what to show on the other device), never an authorisation:
-- see server/db/repos/players.js setTonAddress for the full reasoning about
-- what a lying client would actually gain, which is nothing, and about the
-- three ways that stops being true if anyone builds on top of it.

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS ton_address    text,
  ADD COLUMN IF NOT EXISTS ton_address_at timestamptz;

COMMENT ON COLUMN players.ton_address IS
  'the PLAYER''s own TON wallet, friendly UQ… form — NOT GRAM_WALLET (the project deposit address). Client-asserted, never proof of ownership';
COMMENT ON COLUMN players.ton_address_at IS
  'when the link last changed. NULL = never linked. NULL address WITH this set = deliberately unlinked, and a restored session must not re-link it';

-- ── an address names when it was linked ────────────────────────────────────
-- Every path that writes the address writes both columns in one statement, so
-- this constrains nothing the application does today. It is here so that the
-- day somebody adds a second path — a script, an admin endpoint, a hand-run
-- UPDATE during an incident — an address cannot come out with no time on it.
-- That would collapse the three states above back into two and quietly hand a
-- restored session the power to undo an unlink, which is the one behaviour the
-- pair exists to prevent.
--
-- The same rule migration 014 wrote for unmatched_decided_ck, one table over.
-- VALID rather than NOT VALID here, because both columns were created by the
-- ALTER above: every existing row is provably NULL/NULL and passes, so there
-- is no back catalogue to gamble on.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'players_ton_address_ck') THEN
    ALTER TABLE players
      ADD CONSTRAINT players_ton_address_ck
      CHECK (ton_address IS NULL OR ton_address_at IS NOT NULL);
  END IF;
END $$;

-- ── the column can only ever hold the form a person recognises ─────────────
-- server/ton.js validAddress accepts a raw `0:hex…` as readily as a friendly
-- `UQ…`, and the repo normalises before storing precisely so that a raw one
-- never lands here — a player comparing a `0:8fe52cb8…` against what their
-- wallet app shows them concludes the game linked somebody else's account.
-- That normalisation is one function call, and one function call is one edit
-- away from being skipped. This is the same promise enforced where it cannot
-- be skipped: 36 bytes of base64url, which is exactly 48 characters, and which
-- a raw address cannot be.
--
-- Form, not validity. A 48-character string with a broken checksum satisfies
-- this and is not a payable address; that is validAddress's and the wallet's
-- job. What this stops is a WHOLE FORMAT arriving in the wrong column.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'players_ton_address_form_ck') THEN
    ALTER TABLE players
      ADD CONSTRAINT players_ton_address_form_ck
      CHECK (ton_address IS NULL OR ton_address ~ '^[A-Za-z0-9_-]{48}$');
  END IF;
END $$;

-- "Which accounts claim this wallet" — the question an operator asks when a
-- withdrawal is going to an address that has been seen before, and the only
-- lookup on this column that is not by player id. Partial, because for a long
-- time after this ships the vast majority of rows are NULL and they are noise
-- to every question this index exists for. Same reasoning as
-- players_write_access_idx in migration 013.
--
-- An INDEX and not a UNIQUE INDEX: see the header. Two accounts naming one
-- wallet is a thing an operator should be able to SEE, not a thing the client
-- should be able to cause an error with.
CREATE INDEX IF NOT EXISTS players_ton_address_idx
  ON players (ton_address)
  WHERE ton_address IS NOT NULL;
