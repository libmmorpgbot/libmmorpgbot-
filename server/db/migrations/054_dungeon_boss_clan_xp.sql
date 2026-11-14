-- ── Очки клана за Владыку Подземелья ────────────────────────────────────────
-- clan_bonus_xp (047, 052) принимал 'tournament', 'world_boss' и 'clan_war'.
-- Добивший Владыку Подземелья приносит клану DUNGEON_BOSS_CLAN_XP с
-- источником 'dungeon_boss' (n — добитые боссы), видно во вкладке «Вклад».
-- До этой миграции сервер начисляет клану опыт без строки вклада
-- (clans.bonusSourceReady, server/db/repos/clans.js), так что порядок
-- «код раньше миграции» награду не ломает.
ALTER TABLE clan_bonus_xp DROP CONSTRAINT IF EXISTS clan_bonus_xp_source_check;
ALTER TABLE clan_bonus_xp ADD CONSTRAINT clan_bonus_xp_source_check
  CHECK (source IN ('tournament', 'world_boss', 'clan_war', 'dungeon_boss'));
