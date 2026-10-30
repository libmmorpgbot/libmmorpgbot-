-- ── Рейтинг турнира: вернуть то, что не записалось ─────────────────────────
--
-- После выкладки 046 первый турнир на 16 прошёл, а в рейтинг и в опыт кланов
-- не легло ничего: начисление (repos/tournament.js) молча пропускалось, когда
-- проверка схемы отвечала «таблицы нет» (гонка в db.hasColumn, исправлена в
-- той же выкладке, что и этот файл).
--
-- Восстанавливается по тому, что турнир записал сам и что не терялось:
--   • победа в бою — выплата Liberty за раунд в ledger (reason 'mode_reward',
--     ref_id 'tournament:ub:rN' / 'tournament:lb:rN' / 'tournament:final:win');
--     'tournament:final:lose' — выплата финалисту, это не победа;
--   • титул — pvp_history, mode 'tournament', kind 'win' (только чемпиону);
--   • участие — pvp_history, mode 'tournament': у каждого из шестнадцати ровно
--     одна строка за турнир (вылет — 'lose', чемпион — 'win').
--
-- Только после того, как была применена 046 (до неё рейтинг был списком
-- чемпионов и уже перенесён), и только для турниров, у которых в журнале
-- начислений нет НИ ОДНОЙ строки: где начисление сработало хоть раз, его не
-- трогаем, чтобы не засчитать дважды. Турнир — окно расписания: 12:00–23:00
-- по Москве — дневной, 23:00–12:00 — вечерний.
--
-- Клану победителя — +10 опыта за каждую восстановленную победу (как
-- TOURNAMENT_CLAN_XP_PER_WIN), клану, в котором игрок состоит сейчас. Уровень
-- клана по новому опыту пересчитает сервер на старте (clans.syncLevels).

CREATE TEMP TABLE _tr_fix_since ON COMMIT DROP AS
SELECT COALESCE(
  (SELECT applied_at FROM schema_migrations WHERE version = '046_tournament_rating.sql'),
  now()) AS at;

CREATE TEMP TABLE _tr_fix_ev ON COMMIT DROP AS
SELECT player_id, created_at AS at, 'win' AS what
  FROM ledger
 WHERE reason = 'mode_reward' AND ref_type = 'mode'
   AND ref_id LIKE 'tournament:%' AND ref_id <> 'tournament:final:lose'
   AND created_at >= (SELECT at FROM _tr_fix_since)
UNION ALL
SELECT player_id, created_at, CASE WHEN kind = 'win' THEN 'title' ELSE 'played' END
  FROM pvp_history
 WHERE mode = 'tournament' AND kind IN ('win', 'lose')
   AND created_at >= (SELECT at FROM _tr_fix_since);
-- Чемпион: его строка 'win' — это и титул, и участие.
INSERT INTO _tr_fix_ev SELECT player_id, at, 'played' FROM _tr_fix_ev WHERE what = 'title';

CREATE TEMP TABLE _tr_fix_win ON COMMIT DROP AS
SELECT *,
  CASE WHEN extract(hour FROM at AT TIME ZONE 'Europe/Moscow') BETWEEN 12 AND 22
       THEN to_char(at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') || ' день'
       ELSE to_char((at AT TIME ZONE 'Europe/Moscow') - interval '12 hours', 'YYYY-MM-DD') || ' вечер'
  END AS run
  FROM _tr_fix_ev;

-- Турниры, где начисление хоть раз сработало, — не трогаем.
DELETE FROM _tr_fix_win w
 WHERE EXISTS (
   SELECT 1 FROM tournament_score_log l
    WHERE l.ref <> 'repair'
      AND CASE WHEN extract(hour FROM l.created_at AT TIME ZONE 'Europe/Moscow') BETWEEN 12 AND 22
               THEN to_char(l.created_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') || ' день'
               ELSE to_char((l.created_at AT TIME ZONE 'Europe/Moscow') - interval '12 hours', 'YYYY-MM-DD') || ' вечер'
          END = w.run);

CREATE TEMP TABLE _tr_fix ON COMMIT DROP AS
SELECT run, player_id,
       count(*) FILTER (WHERE what = 'win')::int    AS wins,
       count(*) FILTER (WHERE what = 'title')::int  AS titles,
       LEAST(1, count(*) FILTER (WHERE what = 'played'))::int AS played,
       min(at) AS at
  FROM _tr_fix_win
 GROUP BY run, player_id;

-- Журнал: одна строка на игрока и турнир, ref 'repair'. run_id отрицательный
-- — настоящие (Date.now() старта) всегда положительные и с ним не совпадут.
INSERT INTO tournament_score_log (run_id, player_id, ref, points, created_at)
SELECT -(('x' || substr(md5(run), 1, 15))::bit(60)::bigint), player_id, 'repair',
       wins + 5 * titles, at
  FROM _tr_fix
ON CONFLICT DO NOTHING;

INSERT INTO tournament_rating (player_id, points, wins, titles, played)
SELECT player_id, sum(wins + 5 * titles), sum(wins), sum(titles), sum(played)
  FROM _tr_fix
 GROUP BY player_id
ON CONFLICT (player_id) DO UPDATE SET
  points = tournament_rating.points + EXCLUDED.points,
  wins   = tournament_rating.wins   + EXCLUDED.wins,
  titles = tournament_rating.titles + EXCLUDED.titles,
  played = tournament_rating.played + EXCLUDED.played,
  updated_at = now();

UPDATE clans c SET xp = c.xp + x.add
  FROM (SELECT m.clan_id, 10 * sum(f.wins) AS add
          FROM _tr_fix f JOIN clan_members m ON m.player_id = f.player_id
         GROUP BY m.clan_id) x
 WHERE c.id = x.clan_id AND x.add > 0;
