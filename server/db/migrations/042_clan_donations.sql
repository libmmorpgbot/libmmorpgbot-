-- ── Пожертвования в клан ────────────────────────────────────────────────────
--
-- Опыт клана теперь идёт только отсюда (CLAN_DONATIONS, shared/definitions.js):
-- обычное пожертвование — по 30 осколков каждого вида за 10 очков, большое —
-- 100 Liberty за 100. По три каждого в московские сутки.
--
-- Одна строка — одно пожертвование. Лимит считается по игроку и суткам, а не
-- по клану: ушёл в другой клан — сегодняшние попытки не обнулились. Строка
-- живёт и после выхода из клана: вкладка «Активность» показывает вклад тех,
-- кто ушёл, так же, как раньше показывала их осколки.
--
-- Добавляющая. До неё сервер отвечает на пожертвование «скоро»
-- (hasColumn в repos/clans.js).
CREATE TABLE IF NOT EXISTS clan_donations (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clan_id    bigint      NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
  player_id  bigint      NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  kind       text        NOT NULL CHECK (kind IN ('normal', 'big')),
  day        text        NOT NULL,           -- московские сутки, 'YYYY-MM-DD'
  xp         integer     NOT NULL CHECK (xp > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clan_donations_player_day_idx ON clan_donations (player_id, day);
CREATE INDEX IF NOT EXISTS clan_donations_clan_idx ON clan_donations (clan_id, player_id);

COMMENT ON TABLE clan_donations IS
  'Пожертвования участников — единственный источник опыта клана (CLAN_DONATIONS)';
