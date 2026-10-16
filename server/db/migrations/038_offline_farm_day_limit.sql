-- ── Оффлайн-фарм: лимит часов на сутки ─────────────────────────────────────
--
-- Лимит (OFFLINE_FARM_MAX_HOURS с сезонным билетом, OFFLINE_FARM_FREE_HOURS
-- без него, shared/definitions.js) — на сутки по Москве, а не на один запуск:
-- иначе после выдачи фарм ставят снова, и так по кругу.
--
-- Две колонки, а не поле offline_farm: та обнуляется при выдаче, а
-- засчитанное за день должно её пережить.
--
--   offline_farm_day        сутки, к которым относится счётчик ('YYYY-MM-DD', МСК)
--   offline_farm_used_sec   сколько секунд фарма засчитано в эти сутки
ALTER TABLE player_progress
  ADD COLUMN IF NOT EXISTS offline_farm_day text,
  ADD COLUMN IF NOT EXISTS offline_farm_used_sec integer NOT NULL DEFAULT 0
    CHECK (offline_farm_used_sec >= 0);
