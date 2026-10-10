-- ── elite_kills — сколько элитных монстров убил игрок ──────────────────────
--
-- Элитный монстр сезонных крыльев (server/game/elite.js) — один на сервер,
-- поэтому строк тут немного. Счётчик растёт в той же транзакции, что и
-- награда за убийство (onKill, server/handlers2/world.js), и по нему строится
-- вкладка «Элитный» в HUD (eliteRating, server/handlers2/progression.js).
CREATE TABLE IF NOT EXISTS elite_kills (
  player_id    bigint      PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  kills        integer     NOT NULL DEFAULT 0,
  last_kill_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS elite_kills_rank_idx ON elite_kills (kills DESC, last_kill_at);

COMMENT ON TABLE elite_kills IS
  'Убийства элитного монстра сезонных крыльев — рейтинг во вкладке «Элитный»';
