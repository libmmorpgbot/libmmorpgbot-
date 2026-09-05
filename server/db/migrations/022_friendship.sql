-- ── Дружба: тиры наград за приглашённых друзей ──────────────────────────────
--
-- Кто считается — это НЕ новая колонка. `players.referred_by` уже пишет
-- registerReferral (см. её комментарий в repos/players.js), и уровень друга
-- уже лежит в player_progress.lvl. Дружбе нужен только фильтр по времени —
-- players.created_at >= FRIENDSHIP_LAUNCH_AT (shared/definitions.js) — чтобы
-- друг, приглашённый до появления этой награды, не закрывал тир задним
-- числом, и порог по уровню — lvl >= FRIENDSHIP_LEVEL. Оба условия проверяет
-- friendshipStatus/claimFriendshipTier (server/db/repos/shop.js), не схема.
--
-- Единственное, что нужно хранить, — какие тиры уже забраны, и ровно этот
-- случай уже решён в 001_core.sql для похожей задачи: player_special_quests,
-- где СТРОКА ЕСТЬ значит «забрано», а не булев флаг, который пришлось бы
-- держать по одному на тир. `tier` хранит порог числа друзей (1, 5, 10, 25,
-- 50, 100 — FRIENDSHIP_TIERS[].count), а не индекс массива: изменить порядок
-- или вставить тир между существующими можно, не рискуя переадресовать чей-то
-- уже случившийся claim на другую награду.
CREATE TABLE IF NOT EXISTS player_friendship_claims (
  player_id  bigint   NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  tier       smallint NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, tier)
);

COMMENT ON TABLE player_friendship_claims IS
  'Тиры наград "Дружба" (FRIENDSHIP_TIERS), уже полученные игроком — раз на тир';
