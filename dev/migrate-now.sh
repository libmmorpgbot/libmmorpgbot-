#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  migrate-now.sh — apply pending schema migrations
# ═══════════════════════════════════════════════════════════════════════════
#
#   bash /srv/liberty/migrate-now.sh
#
# Asks for the doadmin password and applies whatever has not been applied yet.
#
# Why the password is TYPED rather than put in the command: `read -s` does not
# echo it and does not put it in ~/.bash_history, where a full connection
# string on the command line would sit forever. It is also never written to
# disk here — it lives in a shell variable for the length of one run.
#
# The application's own database user (liberty_app) cannot do this: it has no
# DDL rights, deliberately. A process that moves real money should not be able
# to change the shape of the tables it moves it in.
set -euo pipefail

APP_DIR=/srv/liberty/next
HOST=private-liberty-db-do-user-42796403-0.m.db.ondigitalocean.com
PORT=25060
DB=liberty

echo
echo "  Liberty — применение миграций базы"
echo "  ──────────────────────────────────"
echo
echo "  Пароль берётся здесь:"
echo "    DigitalOcean → Databases → liberty-db → Connection details"
echo "    User: doadmin → Show password → скопировать"
echo
printf "  Пароль doadmin (ввод не отображается): "
read -rs PGPASS
echo
echo

if [ -z "$PGPASS" ]; then
  echo "  Пароль не введён — ничего не сделано." >&2
  exit 1
fi

# urlencode: a generated password can legitimately contain @ / : # ? and each
# of those would otherwise be read as part of the URL's own structure.
enc() { printf '%s' "$1" | od -An -tx1 -v | tr -d ' \n' | sed 's/../%&/g'; }
ADMIN_URL="postgresql://doadmin:$(enc "$PGPASS")@${HOST}:${PORT}/${DB}?sslmode=require"

echo "  Проверяю доступ..."
if ! PGCONNECT_TIMEOUT=15 psql "$ADMIN_URL" -tAc 'SELECT 1' >/dev/null 2>&1; then
  echo
  echo "  ✗ Не подключился. Обычно это одно из двух:" >&2
  echo "      • пароль скопирован не полностью" >&2
  echo "      • это пароль другого пользователя (нужен именно doadmin)" >&2
  exit 1
fi
echo "  ✓ Доступ есть"
echo

# ── сперва индексы, которые нельзя строить миграцией ───────────────────────
# migrate.sh гоняет каждый файл через --single-transaction — это и делает
# миграцию атомарной. Но CREATE INDEX CONCURRENTLY внутри транзакции не
# создаётся, а без CONCURRENTLY построение берёт на таблицу блокировку SHARE:
# запись в неё встаёт на всё время работы. На боевом журнале денег это секунды
# или минуты, и каждое движение денег упрётся в пятисекундный
# statement_timeout — лечение выглядело бы как болезнь.
#
# Поэтому такие индексы строятся ЗДЕСЬ и ДО миграций: миграция потом находит
# индекс на месте и не делает ничего (в ней IF NOT EXISTS).
#
# Пара «имя · SQL». Добавлять сюда всё, что требует CONCURRENTLY.
INDEXES=(
  "ledger_class_change_idx|CREATE INDEX CONCURRENTLY IF NOT EXISTS ledger_class_change_idx ON ledger (player_id) WHERE reason = 'class_change'"
  "ledger_player_events_idx|CREATE INDEX CONCURRENTLY IF NOT EXISTS ledger_player_events_idx ON ledger (player_id, id DESC) WHERE reason <> 'mob_kill' AND reason <> 'mob_drop'"
  "ledger_player_mobgold_idx|CREATE INDEX CONCURRENTLY IF NOT EXISTS ledger_player_mobgold_idx ON ledger (player_id) INCLUDE (delta) WHERE currency = 'gold' AND (reason = 'mob_kill' OR reason = 'mob_drop')"
)
for entry in "${INDEXES[@]}"; do
  name="${entry%%|*}"
  sql="${entry#*|}"
  if [ "$(psql "$ADMIN_URL" -tAc "SELECT to_regclass('public.$name') IS NOT NULL")" = "t" ]; then
    echo "  ok      индекс $name — уже есть"
    continue
  fi
  echo "  строю   индекс $name (без остановки игры) ..."
  # statement_timeout снят: построение большого индекса законно идёт дольше
  # пяти секунд, а обрыв на середине оставляет непригодный INVALID-индекс.
  if psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "SET statement_timeout = 0" -c "$sql"; then
    echo "  ✓       $name построен"
  else
    echo "  ✗ не построился: $name" >&2
    echo "    Если остался в состоянии INVALID — снимите и повторите:" >&2
    echo "      DROP INDEX CONCURRENTLY IF EXISTS $name;" >&2
    exit 1
  fi
done
echo

# ── и один индекс, который так построить НЕЛЬЗЯ ────────────────────────────
# player_logs секционирована по месяцам, а CREATE INDEX CONCURRENTLY на
# секционированной таблице PostgreSQL просто отказывается делать:
#
#   ERROR: cannot create index on partitioned table "player_logs" concurrently
#
# Обычный CREATE INDEX на родителе сработал бы, но взял бы блокировку на все
# секции на время построения — а flush журнала (server/db/repos/playerlog.js)
# НЕ ПЕРЕСТАВЛЯЕТ пачку в очередь при ошибке: упёршись в пятисекундный таймаут,
# он теряет её и пишет об этом операторам. Терять записи ради ускорения чтения
# этих же записей — плохая сделка.
#
# Штатный обходной путь и делается ниже: пустой индекс на родителе (ON ONLY —
# секции он не трогает), потом по индексу CONCURRENTLY на каждой секции, потом
# ATTACH. Когда прицеплены все, родительский индекс становится валидным сам.
# Секции, которые создаст ежемесячная задача, получат совпадающий индекс от
# PostgreSQL автоматически — про них думать не нужно.
SEASON_IDX=player_logs_season_idx
SEASON_DEF="(player_id, created_at DESC) WHERE event LIKE 'season%'"
if [ "$(psql "$ADMIN_URL" -tAc "SELECT to_regclass('public.$SEASON_IDX') IS NOT NULL")" = "t" ]; then
  echo "  ok      индекс $SEASON_IDX — уже есть"
else
  echo "  строю   индекс $SEASON_IDX по секциям (без остановки игры) ..."
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q \
    -c "CREATE INDEX IF NOT EXISTS $SEASON_IDX ON ONLY player_logs $SEASON_DEF"
  # Список секций спрашивается у базы, а не выводится из календаря: их состав
  # меняет и ежемесячная задача, и чистка старых.
  parts=$(psql "$ADMIN_URL" -tAc "
    SELECT c.relname FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'player_logs'::regclass ORDER BY 1")
  for part in $parts; do
    pidx="${part}_season_idx"
    if [ "$(psql "$ADMIN_URL" -tAc "SELECT to_regclass('public.$pidx') IS NOT NULL")" != "t" ]; then
      psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q \
        -c "SET statement_timeout = 0" \
        -c "CREATE INDEX CONCURRENTLY $pidx ON $part $SEASON_DEF" \
        || { echo "  ✗ не построился: $pidx" >&2
             echo "    Если остался INVALID: DROP INDEX CONCURRENTLY IF EXISTS $pidx;" >&2
             exit 1; }
    fi
    psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q \
      -c "ALTER INDEX $SEASON_IDX ATTACH PARTITION $pidx"
    echo "    ✓ $part"
  done
  # Родительский индекс валиден, только когда прицеплены ВСЕ секции. Пока он
  # невалиден, планировщик его не берёт — то есть молчаливо ничего не
  # ускорилось, и об этом надо сказать вслух.
  if [ "$(psql "$ADMIN_URL" -tAc "
        SELECT i.indisvalid FROM pg_index i WHERE i.indexrelid = '$SEASON_IDX'::regclass")" = "t" ]; then
    echo "  ✓       $SEASON_IDX построен и валиден"
  else
    echo "  ✗ $SEASON_IDX собран не полностью — планировщик его не возьмёт" >&2
    exit 1
  fi
fi
echo

cd "$APP_DIR"
ADMIN_URL="$ADMIN_URL" bash server/db/migrate.sh

echo
echo "  Проверяю, что колонки на месте..."
psql "$ADMIN_URL" -tAc "
  SELECT 'pvp_history.won      ' || CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name='pvp_history' AND column_name='won') THEN 'ЕСТЬ' ELSE 'НЕТ' END
  UNION ALL
  SELECT 'market_listings.snap ' || CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name='market_listings' AND column_name='snap_item_id') THEN 'ЕСТЬ' ELSE 'НЕТ' END
  UNION ALL
  SELECT 'market FK            ' || COALESCE((
    SELECT delete_rule FROM information_schema.referential_constraints
     WHERE constraint_name='market_listings_item_id_fkey'), 'НЕТ')
  UNION ALL
  SELECT 'письмо (mail_bonus)  ' || CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name='player_progress' AND column_name='mail_bonus_claimed') THEN 'ЕСТЬ' ELSE 'НЕТ' END
  UNION ALL
  SELECT 'индекс входа         ' || CASE WHEN EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
     WHERE c.relname='ledger_class_change_idx' AND i.indisvalid) THEN 'ЕСТЬ' ELSE 'НЕТ' END
" | sed 's/^/    /'

echo
echo "  Перезапускаю сервер, чтобы он перечитал схему..."
# The migration itself needs no special user — psql authenticates with the
# password just typed. Restarting the service does: systemd will not take an
# order from an unprivileged account, and it asks for a password nobody has.
# Running the whole script under sudo would mean typing a second one, so only
# this last step escalates, and only if it has to.
if [ "$(id -u)" -eq 0 ]; then
  systemctl restart liberty-next; RESTARTED=1
elif sudo -n systemctl restart liberty-next 2>/dev/null; then
  RESTARTED=1
else
  RESTARTED=0
fi

if [ "$RESTARTED" -eq 1 ]; then
  sleep 5
  echo -n "    "
  curl -s localhost:3000/health
  echo
  echo
  echo "  Готово. Скажи Клоду — он выкатит остальное и проверит."
else
  echo
  echo "  Миграции применены. Сервер отсюда не перезапустить — нужен root"
  echo "  (сейчас пользователь $(whoami)). Это не проблема: скажи Клоду."
  echo "  Схема уже изменена; перезапуск нужен только чтобы её перечитали."
fi
echo
