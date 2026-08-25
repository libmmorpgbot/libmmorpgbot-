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
