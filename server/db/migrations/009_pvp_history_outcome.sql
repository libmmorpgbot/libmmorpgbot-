-- ── pvp_history: the two columns both sides of the code already use ────────
--
-- The table was created with (kind, mode, opponent) and nothing else. Every
-- write since has been
--
--   INSERT INTO pvp_history (player_id, kind, mode, opponent, won, reward)
--
-- which raises 42703 and is swallowed by the catch around it — so not one duel
-- has ever been recorded, and the only trace was a line in the journal:
--
--   [modes] pvp history: column "won" of relation "pvp_history" does not exist
--
-- The read side fails the same way, on `SELECT ... won, reward`, and that
-- throw lands on 'profileError', which no client listens for. The history
-- panel is therefore empty for two independent reasons at once, neither of
-- which reaches anybody.
--
-- The columns are added rather than the queries trimmed, because the client's
-- own renderer draws both: _pvpHistoryRowHTML colours a row by `won` and
-- prints `reward` beside it. Removing them from the queries would leave a
-- panel that renders "undefined" for every entry.
--
-- `won` is nullable on purpose: a death in an open-world fight is recorded
-- from both sides (kind 'kill' and kind 'death'), and a mode that ends in a
-- draw or a timeout has no winner to name. NULL means "no verdict", which is
-- a different fact from false.
ALTER TABLE pvp_history
  ADD COLUMN IF NOT EXISTS won    boolean,
  ADD COLUMN IF NOT EXISTS reward text;
