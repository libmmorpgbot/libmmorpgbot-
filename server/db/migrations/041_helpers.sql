-- ── Помощники ───────────────────────────────────────────────────────────────
--
-- Летающие спутники (HELPERS, shared/definitions.js). Не предметы: у каждого
-- свой уровень и опыт, на рынок и в сумку они не попадают — поэтому своя
-- таблица, а не строки player_items.
--
-- Одна строка на помощника у игрока: повтор при крафте не заводит вторую, а
-- уходит опытом в эту (repos/helpers.js). Активный — не больше одного, и это
-- держит частичный уникальный индекс, а не проверка в коде.
--
-- CHECK на helper_id не ставится по той же причине, что у рун (029) и
-- достижений (040): список живёт в shared/definitions.js, и правило было бы
-- в двух местах.
--
-- Добавляющая: пока её нет, сервер отвечает окну «скоро» и не считает
-- помощников в характеристики (hasColumn в repos/helpers.js и repos/stats.js).
CREATE TABLE IF NOT EXISTS player_helpers (
  player_id  bigint      NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  helper_id  text        NOT NULL,
  level      integer     NOT NULL DEFAULT 1 CHECK (level >= 1),
  xp         integer     NOT NULL DEFAULT 0 CHECK (xp >= 0),
  active     boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, helper_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS player_helpers_one_active
  ON player_helpers (player_id) WHERE active;

COMMENT ON TABLE player_helpers IS
  'Помощники игрока (HELPERS, shared/definitions.js): уровень, опыт, кто сейчас летает рядом';
