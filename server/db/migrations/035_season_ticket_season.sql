-- ── player_vip.season_ticket_season — для какого сезона куплен билет ───────
--
-- Билет больше не вечный флаг: Сезон 4 продаёт свой билет, и билет 3-го
-- сезона в 4-м не действует. Код считает билет действующим, только когда
-- season_ticket_season = SEASON_TICKET_SEASON (shared/definitions.js).
-- Уже купленные билеты помечаются 3-м сезоном.
ALTER TABLE player_vip ADD COLUMN IF NOT EXISTS season_ticket_season smallint NOT NULL DEFAULT 0;
UPDATE player_vip SET season_ticket_season = 3 WHERE season_ticket AND season_ticket_season = 0;
