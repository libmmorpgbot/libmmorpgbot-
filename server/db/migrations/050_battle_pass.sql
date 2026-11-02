-- ── Боевой пропуск ──────────────────────────────────────────────────────────
--
-- Одна строка на (игрок, сезон). progress — счётчики заданий пропуска
-- (BATTLE_PASS_TASKS, shared/definitions.js) за этот сезон: метрика → число.
-- claimed_free / claimed_prem — номера заданий, чьи награды уже забраны,
-- отдельно для бесплатной и премиальной дорожек. premium — куплен ли пропуск.
--
-- Добавляющая: пока таблицы нет, сервер отвечает окну «скоро» и ничего не
-- считает (hasColumn в server/battlepass.js).
CREATE TABLE IF NOT EXISTS player_battlepass (
  player_id    bigint      NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  season       integer     NOT NULL,
  premium      boolean     NOT NULL DEFAULT false,
  premium_at   timestamptz,
  progress     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  claimed_free integer[]   NOT NULL DEFAULT '{}',
  claimed_prem integer[]   NOT NULL DEFAULT '{}',
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, season)
);

COMMENT ON TABLE player_battlepass IS
  'Боевой пропуск: счётчики заданий сезона, купленный премиум, забранные награды';
