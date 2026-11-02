-- ── Войны кланов ────────────────────────────────────────────────────────────
-- Клан 10+ уровня объявляет войну другому клану (status = 'pending'); лидер
-- второго клана принимает — война идёт ('active'), отказывается или первый
-- отзывает — 'declined'/'cancelled', любой из двух заканчивает — 'ended'.
-- Пока война идёт, убийство игрока из враждебного клана не даёт кармы
-- (server/karma.js), а над врагами — красные мечи.
--
-- Одна незакрытая война на пару кланов — держит частичный уникальный индекс
-- по упорядоченной паре.
CREATE TABLE IF NOT EXISTS clan_wars (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  from_clan   bigint      NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
  to_clan     bigint      NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
  status      text        NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'active', 'declined', 'cancelled', 'ended')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  ended_at    timestamptz,
  CHECK (from_clan <> to_clan)
);
CREATE UNIQUE INDEX IF NOT EXISTS clan_wars_open_pair
  ON clan_wars (LEAST(from_clan, to_clan), GREATEST(from_clan, to_clan))
  WHERE status IN ('pending', 'active');
CREATE INDEX IF NOT EXISTS clan_wars_from_idx ON clan_wars (from_clan) WHERE status IN ('pending', 'active');
CREATE INDEX IF NOT EXISTS clan_wars_to_idx   ON clan_wars (to_clan)   WHERE status IN ('pending', 'active');
COMMENT ON TABLE clan_wars IS 'Войны кланов: объявление, принятие, окончание';
