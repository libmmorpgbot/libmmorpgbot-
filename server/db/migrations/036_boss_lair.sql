-- ── player_progress.boss_lair_max — the furthest Логово боссов boss killed ──
--
-- Bosses open one after another (bossLairUnlocked, shared/definitions.js):
-- the next rung opens once the previous one has been killed at least once.
-- This is the level of the strongest boss the player has ever killed there;
-- 0 means none yet, so only the first boss is open.
ALTER TABLE player_progress ADD COLUMN IF NOT EXISTS boss_lair_max smallint NOT NULL DEFAULT 0;
