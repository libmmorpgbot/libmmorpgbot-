-- ── Вклад в клан с турнира ──────────────────────────────────────────────────
--
-- Каждая победа в турнирном бою даёт клану победителя опыт
-- (TOURNAMENT_CLAN_XP_PER_WIN, repos/tournament.js). Здесь — сколько всего
-- так принёс каждый участник своему клану: вкладка «Вклад» в окне клана
-- показывает это рядом с пожертвованиями (clans.activityView).
--
-- Ключ (клан, игрок): ушедший из клана свой вклад в нём сохраняет, как и с
-- пожертвованиями, а в новом клане начинает с нуля.
CREATE TABLE IF NOT EXISTS clan_tournament_xp (
  clan_id    bigint      NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
  player_id  bigint      NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  xp         bigint      NOT NULL DEFAULT 0 CHECK (xp >= 0),
  wins       integer     NOT NULL DEFAULT 0 CHECK (wins >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clan_id, player_id)
);

-- Победы, уже начисленные до этой миграции: в журнале рейтинга (046) это
-- строки раундов ('r1'…'r8'). В каком клане игрок был в тот момент, журнал не
-- помнит — засчитываются клану, в котором он сейчас, по 10 за победу.
INSERT INTO clan_tournament_xp (clan_id, player_id, xp, wins)
SELECT m.clan_id, l.player_id, 10 * count(*), count(*)
  FROM tournament_score_log l
  JOIN clan_members m ON m.player_id = l.player_id
 WHERE l.ref ~ '^r[0-9]+$'
 GROUP BY m.clan_id, l.player_id
ON CONFLICT (clan_id, player_id) DO NOTHING;

COMMENT ON TABLE clan_tournament_xp IS 'Сколько опыта клану принёс участник победами в турнире — вкладка «Вклад»';
