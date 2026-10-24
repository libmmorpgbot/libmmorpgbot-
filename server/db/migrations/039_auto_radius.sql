-- ── Радиус АВТО в Мире ─────────────────────────────────────────────────────
--
-- Игрок выбирает радиус круга АВТО ползунком (долгое нажатие на кнопку АВТО).
-- В клетках, AUTO_RADIUS_MIN..AUTO_RADIUS_MAX (shared/definitions.js).
-- NULL — не выбирал, действует AUTO_RADIUS_DEFAULT.
--
-- Добавляющая: до неё сервер просто не пишет это поле (players.savePrefs
-- спрашивает hasColumn), остальные настройки сохраняются как раньше.
ALTER TABLE player_prefs
  ADD COLUMN IF NOT EXISTS auto_radius smallint
    CHECK (auto_radius BETWEEN 3 AND 20);
