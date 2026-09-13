-- ── обслуживание журнала должно работать из-под роли приложения ────────────
--
-- Каждый запуск сервера писал в алерты «Ошибка обслуживания БД: permission
-- denied for schema public», и это не шум: maintain() (server/workers.js)
-- падает на ПЕРВОМ же шаге, а значит следом не выполняются и два остальных.
--
--   ensure_log_partitions   создаёт разделы player_logs на месяцы вперёд
--   drop_old_log_partitions удаляет разделы старше срока хранения
--   gram.expireStaleIntents закрывает зависшие намерения на депозит
--
-- Обе функции объявлены в миграции 002 без SECURITY DEFINER, то есть
-- выполняются с правами ВЫЗЫВАЮЩЕГО. Вызывает их приложение, под ролью
-- liberty_app, а у неё — намеренно — нет ни CREATE на схеме, ни владения
-- таблицами: так и написано в блоке прав (server/db/migrate.sh), и это
-- правильное решение, которое отменять нельзя. Скомпрометированный процесс
-- игры не должен уметь менять схему.
--
-- Отсюда и тупик: функция обязана создавать таблицы, а тому, кто её зовёт,
-- создавать таблицы запрещено. Выдать liberty_app CREATE ON SCHEMA public
-- значило бы разменять ровно ту защиту, ради которой её не выдавали, — на
-- удобство двух служебных вызовов.
--
-- Правильный размен другой: не расширять роль, а сузить задачу. SECURITY
-- DEFINER выполняет тело функции с правами ВЛАДЕЛЬЦА (им станет роль,
-- применяющая эту миграцию, — та же, что создавала таблицы). Приложение при
-- этом не получает ни одного нового права на схему: оно получает возможность
-- сделать ровно две вещи, которые делают эти функции, и ничего сверх.
--
-- Что эскалация действительно ограничена — видно из тел функций, они здесь не
-- меняются ни на строку: имена разделов собираются из to_char(date) и
-- отбираются по pg_inherits с жёсткой маской ^player_logs_[0-9]{4}_[0-9]{2}$,
-- а подставляются через format(%I). Ни одна таблица за пределами разделов
-- player_logs этим функциям недостижима.
--
-- search_path задан явно — обязательная часть SECURITY DEFINER: без него
-- вызывающий выбирает, в какой схеме искать player_logs и to_regclass, то
-- есть решает, что именно выполнится с правами владельца.

CREATE OR REPLACE FUNCTION ensure_log_partitions(months_ahead integer DEFAULT 2)
RETURNS void LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  m      date := date_trunc('month', now())::date;
  i      integer;
  part   text;
BEGIN
  FOR i IN 0..months_ahead LOOP
    part := 'player_logs_' || to_char(m + (i || ' month')::interval, 'YYYY_MM');
    IF to_regclass(part) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF player_logs FOR VALUES FROM (%L) TO (%L)',
        part,
        (m + (i     || ' month')::interval)::date,
        (m + (i + 1 || ' month')::interval)::date
      );
    END IF;
  END LOOP;
END;
$fn$;

CREATE OR REPLACE FUNCTION drop_old_log_partitions(keep_months integer DEFAULT 6)
RETURNS void LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
  cutoff date := (date_trunc('month', now()) - (keep_months || ' month')::interval)::date;
  r      record;
BEGIN
  FOR r IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_inherits i ON i.inhrelid = c.oid
     WHERE i.inhparent = 'player_logs'::regclass
       AND c.relname ~ '^player_logs_[0-9]{4}_[0-9]{2}$'
       AND to_date(right(c.relname, 7), 'YYYY_MM') < cutoff
  LOOP
    EXECUTE format('DROP TABLE %I', r.relname);
  END LOOP;
END;
$fn$;

-- EXECUTE на функции Postgres выдаёт PUBLIC по умолчанию, и для обычной
-- функции это безобидно. Для SECURITY DEFINER — нет: право вызвать её это
-- право выполнить её тело с правами владельца. Оставляем это право одному
-- приложению, ради которого всё и делается.
REVOKE ALL ON FUNCTION ensure_log_partitions(integer)   FROM PUBLIC;
REVOKE ALL ON FUNCTION drop_old_log_partitions(integer) FROM PUBLIC;

-- Роль проверяется, а не предполагается: миграции гоняют и на машинах, где
-- приложенческой роли нет вовсе (локальная разработка под одним пользователем),
-- и падение здесь оставило бы всю миграцию неприменённой из-за GRANT, без
-- которого на такой машине и так всё работает.
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liberty_app') THEN
    GRANT EXECUTE ON FUNCTION ensure_log_partitions(integer)   TO liberty_app;
    GRANT EXECUTE ON FUNCTION drop_old_log_partitions(integer) TO liberty_app;
  END IF;
END;
$grant$;

-- И сразу закрыть текущую дыру, не дожидаясь ближайшего maintain(): разделы
-- существуют только те, что создала миграция 002 в день своего применения.
-- Партиционированная таблица без раздела на сегодняшнюю дату ОТКАЗЫВАЕТ во
-- всех вставках — то есть журнал игроков умер бы молча в первый же день
-- месяца, на который раздела не оказалось.
SELECT ensure_log_partitions(2);
