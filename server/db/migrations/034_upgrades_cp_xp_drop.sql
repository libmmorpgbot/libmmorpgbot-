-- ── Улучшения: ЦП, бонус к опыту, бонус к дропу ─────────────────────────────
--
-- Три новых слота в панели «Улучшения» (UPGRADE_KEYS, shared/definitions.js),
-- по одной колонке на слот — так же, как семь прежних (001_core.sql): очки
-- считаются суммой этих колонок, и каждая обязана быть неотрицательной.
--
--   upg_cp    +200 к запасу CP за очко
--   upg_xp    +0.1% к опыту за очко
--   upg_drop  +0.1% к шансу выпадения за очко
ALTER TABLE player_progress
  ADD COLUMN IF NOT EXISTS upg_cp   integer NOT NULL DEFAULT 0 CHECK (upg_cp   >= 0),
  ADD COLUMN IF NOT EXISTS upg_xp   integer NOT NULL DEFAULT 0 CHECK (upg_xp   >= 0),
  ADD COLUMN IF NOT EXISTS upg_drop integer NOT NULL DEFAULT 0 CHECK (upg_drop >= 0);
