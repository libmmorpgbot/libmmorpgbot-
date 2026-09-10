-- ── player_season.prize_gram / prize_paid_at — season-end GRAM payout ──────
--
-- SEASON_PRIZES (shared/definitions.js) used to be paid out by hand, off-chain
-- — the game only ranked players and showed the USDT table. distributeSeasonPrizes
-- (server/db/repos/progression.js) now credits places 1-10 straight onto the
-- winner's GRAM balance the moment seasonActive() goes false, and these two
-- columns are what makes that safe to run more than once and what the season
-- panel's "Итоги" screen reads from.
--
-- prize_paid_at IS NULL is the guard the job filters on — a background tick
-- that runs again (server/workers.js) does nothing once a row already has
-- one; money.credit's own idemKey is the second, independent guard on the
-- actual balance movement. prize_gram is the amount that was actually
-- credited, kept alongside rather than re-derived from SEASON_PRIZES by place
-- every time, so a rate change for a future season never rewrites what a
-- past one already paid.
ALTER TABLE player_season ADD COLUMN IF NOT EXISTS prize_gram numeric(24,8) NOT NULL DEFAULT 0;
ALTER TABLE player_season ADD COLUMN IF NOT EXISTS prize_paid_at timestamptz;
