-- ── Рейтинг турнира ─────────────────────────────────────────────────────────
--
-- Раньше рейтинг турнира был списком чемпионов (pvp_history, mode='tournament',
-- kind='win'). Теперь в нём каждый, кто играл в сетке: любая победа в матче —
-- +1 очко, победа во всём турнире — ещё +5 (TOURNAMENT_POINTS_*,
-- shared/definitions.js).
--
-- tournament_rating — итог по игроку. tournament_score_log — каждое
-- начисление с ключом (турнир, игрок, что): PRIMARY KEY не даст засчитать
-- одну и ту же победу дважды (повтор после сбоя, переподключение), а итог
-- двигается только вслед за новой строкой журнала (repos/tournament.js).
CREATE TABLE IF NOT EXISTS tournament_rating (
  player_id  bigint      PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  points     integer     NOT NULL DEFAULT 0 CHECK (points >= 0),
  wins       integer     NOT NULL DEFAULT 0 CHECK (wins >= 0),
  titles     integer     NOT NULL DEFAULT 0 CHECK (titles >= 0),
  played     integer     NOT NULL DEFAULT 0 CHECK (played >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tournament_rating_top_idx ON tournament_rating (points DESC, titles DESC, wins DESC);

CREATE TABLE IF NOT EXISTS tournament_score_log (
  run_id     bigint      NOT NULL,
  player_id  bigint      NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  ref        text        NOT NULL,
  points     integer     NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, player_id, ref)
);

-- Прошлые чемпионы не теряют заслуг: каждый их титул — +5 очков.
INSERT INTO tournament_rating (player_id, points, titles, played)
SELECT player_id, 5 * count(*), count(*), count(*)
  FROM pvp_history WHERE mode = 'tournament' AND kind = 'win'
 GROUP BY player_id
ON CONFLICT (player_id) DO NOTHING;

COMMENT ON TABLE tournament_rating IS 'Рейтинг турнира: +1 за любую победу в матче, +5 за победу в турнире';
COMMENT ON TABLE tournament_score_log IS 'Начисления рейтинга турнира: одна строка — одно начисление, второго не бывает';
