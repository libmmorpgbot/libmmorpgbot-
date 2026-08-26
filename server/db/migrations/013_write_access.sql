-- ── May the bot write to this player, and did we ever ask? ─────────────────
--
-- The owner's requirement: a player who opens the Mini App is asked to let the
-- bot message them in DM, and one who refuses does not get into the game.
--
-- Telegram already answers half of that, badly. `allows_write_to_pm` is baked
-- into initData AT LAUNCH and does not change for the rest of the session, so
-- the moment a player taps Allow the client knows and the server has no way to
-- find out — and the next launch asks again, because Telegram may not have
-- refreshed the flag yet. There is no API to ask Telegram whether a user has
-- granted write access; the grant is reported once, to the client, and then it
-- is gone. If nothing writes it down it is not remembered at all.
--
-- So the column is not a cache of something authoritative elsewhere. It IS the
-- record. That is why it lives on `players` — whose header says it is identity
-- only, and this is identity: it is a fact about the Telegram account, not
-- about the character, and it is read on the same login that already reads
-- this row.
--
--   can_message      the player granted write access. Written by the client's
--                    report of Telegram's own callback (there is nothing else
--                    to write it from), and MONOTONIC: see below.
--   write_access_at  when the prompt was last ANSWERED. NULL means never asked.
--
-- ── why the timestamp, when a boolean already says yes or no ───────────────
--
-- Because `can_message = false` is two completely different players wearing
-- one value: somebody who has never seen the prompt, and somebody who saw it
-- and said no. The first is an ordinary account that simply has not launched
-- since this shipped. The second is a player who was turned away at the door,
-- and the number of them is the one figure that decides whether this gate is
-- worth having at all — the owner has to be able to see "most people refuse"
-- BEFORE it has cost them a month of installs.
--
-- What the pair makes unrepresentable: a refusal indistinguishable from a
-- player nobody ever asked.
--
-- player_logs records both outcomes as they happen (writeAccessGranted /
-- refuse:writeAccess) and is the per-player answer to "why can't the bot reach
-- this account". It is NOT the answer to "what share refuse": it is
-- partitioned by month with a retention job that drops old partitions, so the
-- history dies on a schedule. These two columns are the standing total, and
-- they survive.
--
-- ── monotonic ──────────────────────────────────────────────────────────────
--
-- can_message goes false → true and never back. A refusal writes only
-- write_access_at. Two reasons, and either one alone would be enough:
--
--   * the client is what reports this, and a client-driven path that can
--     CLEAR a permission is a client that can revoke its own account's
--     notifications by sending one packet.
--   * a player who really did revoke write access revokes it in Telegram, and
--     Telegram tells us by failing the send with 403. That is the authority
--     here, not a message from the app.
--
-- Existing rows get false / NULL, which reads correctly as "nobody has asked
-- this account yet" rather than as a refusal that never happened.

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS can_message     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS write_access_at timestamptz;

COMMENT ON COLUMN players.can_message IS
  'player allowed the bot to DM them (Telegram requestWriteAccess) — only ever set to true';
COMMENT ON COLUMN players.write_access_at IS
  'when the write-access prompt was last answered; NULL = never asked. false + NOT NULL = refused';

-- "How many were asked, and how many said no" without a sequential scan of
-- every account in the game. Partial, because the rows that answer it are the
-- ones that HAVE an answer — and for a long time after this ships the vast
-- majority will be NULL, which is noise to every question this index exists
-- for. Same reasoning as player_items_source_idx in migration 011.
CREATE INDEX IF NOT EXISTS players_write_access_idx
  ON players (can_message, write_access_at)
  WHERE write_access_at IS NOT NULL;
