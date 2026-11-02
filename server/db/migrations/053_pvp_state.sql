-- ── ПК переживает перезаход и переходы ──────────────────────────────────────
-- Запись игрока в комнате создаётся заново при каждом входе на этаж — и ПК
-- в ней всегда выключен. Без этих колонок «включил ПК, ударил, перезашёл /
-- сменил локацию / телепортнулся» снимало и ПК, и двухминутный запрет его
-- выключать (PVP_OFF_COOLDOWN_MS). pvp_on — включён ли ПК игроком,
-- pvp_off_at — с какой миллисекунды его можно выключить (server/karma.js).
ALTER TABLE player_progress ADD COLUMN IF NOT EXISTS pvp_on boolean NOT NULL DEFAULT false;
ALTER TABLE player_progress ADD COLUMN IF NOT EXISTS pvp_off_at bigint NOT NULL DEFAULT 0;
