-- ── Гильдийские боссы ───────────────────────────────────────────────────────
--
-- Лидер клана 11+ уровня вызывает босса Логова (35+) в усиленном виде — два
-- раза в неделю за 500 Liberty (GUILD_BOSS_*, shared/definitions.js). Одна
-- строка — один вызов. Неделя — московская, с понедельника ('YYYY-MM-DD'
-- понедельника, seasonWeekKey).
--
--   active    босс стоит, участники входят;
--   killed    убит — дроп выдан тем, кто был в зале живым;
--   expired   не убит за отведённый час;
--   refunded  сервер перезапустился, пока босс стоял: зал потерян, Liberty
--             вернулась лидеру, и вызов не засчитан в недельный лимит.
--
-- Один активный вызов на клан — частичный уникальный индекс, а не проверка.
CREATE TABLE IF NOT EXISTS guild_boss_summons (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clan_id     bigint      NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
  level       smallint    NOT NULL,
  week        text        NOT NULL,
  summoned_by bigint      REFERENCES players(id) ON DELETE SET NULL,
  cost        integer     NOT NULL,
  status      text        NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'killed', 'expired', 'refunded')),
  killed_by   bigint      REFERENCES players(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz
);
CREATE INDEX IF NOT EXISTS guild_boss_summons_clan_week_idx ON guild_boss_summons (clan_id, week);
CREATE UNIQUE INDEX IF NOT EXISTS guild_boss_summons_one_active
  ON guild_boss_summons (clan_id) WHERE status = 'active';

-- Кто получил дроп за какой вызов. PRIMARY KEY — и есть «второй раз не
-- выдать»: повтор выплаты (сбой между убийством и выдачей) упирается в него.
CREATE TABLE IF NOT EXISTS guild_boss_rewards (
  summon_id  bigint      NOT NULL REFERENCES guild_boss_summons(id) ON DELETE CASCADE,
  player_id  bigint      NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  items      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (summon_id, player_id)
);

COMMENT ON TABLE guild_boss_summons IS 'Вызовы гильдийских боссов (GUILD_BOSS_*, shared/definitions.js)';
COMMENT ON TABLE guild_boss_rewards IS 'Дроп гильдийского босса: одна строка — одна выдача игроку за вызов';
