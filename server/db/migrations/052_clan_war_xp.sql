-- ── Очки клана за войну кланов ──────────────────────────────────────────────
-- clan_bonus_xp (047) принимал только 'tournament' и 'world_boss'. Убийство
-- игрока клана-врага приносит клану убийцы очки (CLAN_WAR_KILL_XP,
-- server/karma.js) — с источником 'clan_war' (n — убитые враги), видно во
-- вкладке «Вклад».
ALTER TABLE clan_bonus_xp DROP CONSTRAINT IF EXISTS clan_bonus_xp_source_check;
ALTER TABLE clan_bonus_xp ADD CONSTRAINT clan_bonus_xp_source_check
  CHECK (source IN ('tournament', 'world_boss', 'clan_war'));
