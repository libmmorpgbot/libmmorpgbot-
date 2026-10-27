-- ── Война гильдий: стороны и Liberty в казну клана ──────────────────────────
--
-- Вместо одного «замка» с осколками раз в час — две стороны поля. Клан,
-- который держит обе правые вышки, получает 200 Liberty в сутки, обе левые —
-- 100 (GUILD_WAR_SIDES, shared/definitions.js). Деньги идут не игрокам, а в
-- казну клана (clans.nexum), и раздаёт их лидер.
--
-- guild_war_state уже держит строки по ключу — стороны ложатся туда же
-- строками 'right' и 'left'. paid_day — московские сутки последней выплаты:
-- выплата ставит его тем же UPDATE, что и решает «платить ли», так что
-- перезапуск или две проверки подряд не заплатят за день дважды.
--
-- Добавляющая. Пока её нет, сервер о сторонах молчит: выплата и раздача
-- спрашивают колонку (hasColumn) и до миграции ничего не делают.

ALTER TABLE guild_war_state ADD COLUMN IF NOT EXISTS paid_day text;

ALTER TABLE clans ADD COLUMN IF NOT EXISTS nexum bigint NOT NULL DEFAULT 0;
DO $$ BEGIN
  ALTER TABLE clans ADD CONSTRAINT clans_nexum_nonneg CHECK (nexum >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Журнал казны: каждый приход и каждая раздача. Игроку раздача пишется ещё
-- и в ledger (money.credit), а здесь — сторона клана: откуда пришло и кому
-- ушло, чтобы на вопрос «куда делись 300 Liberty» был ответ.
CREATE TABLE IF NOT EXISTS clan_nexum_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clan_id    bigint      NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
  delta      bigint      NOT NULL CHECK (delta <> 0),
  reason     text        NOT NULL,          -- 'guild_war_right', 'guild_war_left', 'give'
  player_id  bigint      REFERENCES players(id) ON DELETE SET NULL,   -- кому раздали
  by_id      bigint      REFERENCES players(id) ON DELETE SET NULL,   -- кто раздал
  ref        text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clan_nexum_log_clan_idx ON clan_nexum_log (clan_id, created_at DESC);

-- Нынешний владелец замка держал все четыре вышки — ему обе стороны.
INSERT INTO guild_war_state (key, owner_clan_id, captured_at)
SELECT k, g.owner_clan_id, g.captured_at
  FROM guild_war_state g, (VALUES ('right'), ('left')) AS v(k)
 WHERE g.key = 'castle' AND g.owner_clan_id IS NOT NULL
ON CONFLICT (key) DO NOTHING;

COMMENT ON TABLE clan_nexum_log IS
  'Казна клана (clans.nexum): приходы с Войны гильдий и раздачи лидера';
