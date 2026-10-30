-- ── Вклад в клан не пожертвованием ──────────────────────────────────────────
--
-- Опыт клану приносят не только пожертвования: победы в турнире
-- (TOURNAMENT_CLAN_XP_*, repos/tournament.js) и последний удар по Владыке Мира
-- (WORLD_BOSS_CLAN_XP, handlers2/world.js). Здесь — сколько так принёс каждый
-- участник своему клану, по источнику: вкладка «Вклад» в окне клана
-- показывает это рядом с пожертвованиями (clans.activityView).
--
-- source: 'tournament' (n — победы) | 'world_boss' (n — добитые Владыки).
-- Ключ (клан, игрок, источник): ушедший из клана свой вклад в нём сохраняет,
-- как и с пожертвованиями, а в новом клане начинает с нуля.
CREATE TABLE IF NOT EXISTS clan_bonus_xp (
  clan_id    bigint      NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
  player_id  bigint      NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  source     text        NOT NULL CHECK (source IN ('tournament', 'world_boss')),
  xp         bigint      NOT NULL DEFAULT 0 CHECK (xp >= 0),
  n          integer     NOT NULL DEFAULT 0 CHECK (n >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clan_id, player_id, source)
);

-- Турнирные победы, уже начисленные до этой миграции: в журнале рейтинга
-- (046) это строки раундов ('r1'…'r8'), и клану за каждую тогда шло 10. В
-- каком клане игрок был в тот момент, журнал не помнит — засчитываются
-- клану, в котором он сейчас.
INSERT INTO clan_bonus_xp (clan_id, player_id, source, xp, n)
SELECT m.clan_id, l.player_id, 'tournament', 10 * count(*), count(*)
  FROM tournament_score_log l
  JOIN clan_members m ON m.player_id = l.player_id
 WHERE l.ref ~ '^r[0-9]+$'
 GROUP BY m.clan_id, l.player_id
ON CONFLICT (clan_id, player_id, source) DO NOTHING;

COMMENT ON TABLE clan_bonus_xp IS 'Опыт клану от участника не пожертвованием (турнир, Владыка Мира) — вкладка «Вклад»';
