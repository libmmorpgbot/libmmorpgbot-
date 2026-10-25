-- ── Достижения ──────────────────────────────────────────────────────────────
--
-- Две таблицы, и разделены они намеренно.
--
-- player_ach_progress — СЧЁТЧИКИ (сколько рун обычной редкости выковано, до
-- какой заточки дошёл). Один счётчик на действие, а не на достижение: на
-- счётчике «runeCommon» висят три цели (10/50/100), и ковка двигает его один
-- раз. Пишется в той же транзакции, что и само действие
-- (server/achievements.js).
--
-- player_ach_claims — ЗАБРАННЫЕ НАГРАДЫ. Строка и есть факт: PRIMARY KEY
-- делает вторую выдачу невозможной, а не «проверенной» — тот же приём, что
-- у player_special_quests (repos/progression.js, шапка файла).
--
-- Что считается достижением и что за него дают, решает shared/definitions.js
-- (ACHIEVEMENTS) — один файл на клиент и сервер. CHECK на метрику здесь не
-- ставится по той же причине, что у рун (029): правило жило бы в двух местах.
--
-- Добавляющая: пока её нет, сервер не пишет счётчики (hasColumn в
-- server/achievements.js), и действия игроков идут как раньше.
CREATE TABLE IF NOT EXISTS player_ach_progress (
  player_id  bigint      NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  metric     text        NOT NULL,
  value      bigint      NOT NULL DEFAULT 0 CHECK (value >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, metric)
);

CREATE TABLE IF NOT EXISTS player_ach_claims (
  player_id  bigint      NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  ach_id     text        NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, ach_id)
);

COMMENT ON TABLE player_ach_progress IS
  'Счётчики достижений (ACH_METRICS, shared/definitions.js) — пишет только сервер';
COMMENT ON TABLE player_ach_claims IS
  'Забранные награды достижений: одна строка — одна выдача, второй не бывает';
