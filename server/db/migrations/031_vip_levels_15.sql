-- ── VIP: уровни 11-15 ────────────────────────────────────────────────────────
--
-- VIP_THRESHOLDS (shared/definitions.js) вырос с 10 уровней до 15. Уровень
-- addVipSpend (server/db/repos/progression.js) выводит из суммы `deposited`,
-- но пересчитывает его только при следующем пополнении — игрок, который уже
-- внёс больше порога VIP 11, так и сидел бы на VIP 10, пока не заплатит снова.
--
-- Здесь то же вычисление, один раз, для всех, кто сейчас на VIP 10: уровень
-- поднимается до того, что покрывает его `deposited`, а каждый пройденный
-- уровень ложится в `pending` — награды забираются кнопкой, как при обычном
-- повышении. Только вверх, `deposited` не трогается.
--
-- Пороги — VIP_CUMULATIVE[10..15]; при их правке в definitions.js эта
-- миграция уже применена и повторно не выполнится.
WITH lv AS (
  SELECT p.player_id, p.level AS was,
         (SELECT max(v.l) FROM (VALUES
            (10::smallint, 1341::numeric), (11, 2041), (12, 3041),
            (13, 4541), (14, 6541), (15, 9541)
          ) AS v(l, floor)
          WHERE p.deposited >= v.floor) AS now
    FROM player_vip p
   WHERE p.level = 10
)
UPDATE player_vip p
   SET level = lv.now,
       pending = p.pending || ARRAY(SELECT generate_series(lv.was + 1, lv.now)::smallint),
       updated_at = now()
  FROM lv
 WHERE p.player_id = lv.player_id
   AND lv.now > lv.was;
