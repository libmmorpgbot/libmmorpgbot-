-- ── Активность клана: кто сколько Осколков задонатил в хранилище ───────────
--
-- clan_storage (002_social_economy.sql) хранит только общий стек — сколько
-- Осколков лежит в кладовой клана сейчас, без имени того, кто их туда
-- положил. item_ledger (012_item_ledger.sql) знает КТО, но депозит в клан
-- списывается той же причиной 'consume', что и обычный расход предмета, —
-- по ней нельзя отличить донат в клан от траты на что-то ещё.
--
-- Эта таблица — отдельный счётчик на пару (клан, игрок), который растёт
-- только вверх при каждом clans.deposit(). Не привязана к clan_members: если
-- игрок покинул клан, его вклад в историю клана не исчезает вместе с ним.
CREATE TABLE IF NOT EXISTS clan_contributions (
  clan_id    bigint      NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
  player_id  bigint      NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  qty        integer     NOT NULL DEFAULT 0 CHECK (qty >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clan_id, player_id)
);

COMMENT ON TABLE clan_contributions IS
  'Сколько Осколков всего задонатил игрок в хранилище своего клана — вкладка "Активность"';
