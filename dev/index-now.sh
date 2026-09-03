#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  index-now.sh — построить индексы на ЖИВОЙ базе, не останавливая игру
# ═══════════════════════════════════════════════════════════════════════════
#
#   bash /srv/liberty/next/dev/index-now.sh
#
# Зачем отдельно от миграций. migrate.sh гоняет каждый файл через
# --single-transaction — это и делает миграцию атомарной, ради этого всё и
# затевалось. Но CREATE INDEX CONCURRENTLY внутри транзакции не создаётся, а
# без CONCURRENTLY построение берёт на таблицу блокировку SHARE: запись в неё
# встаёт на всё время работы. На боевом журнале денег это секунды или минуты,
# и каждое движение денег в игре упрётся в пятисекундный statement_timeout.
#
# То есть выбор не «удобно или правильно», а «индекс без простоя» против
# «индекс с простоем». Поэтому такие вещи живут здесь, запускаются РУКАМИ и
# ДО выкладки, а миграция потом находит индекс на месте и ничего не делает.
#
# Скрипт идемпотентен: IF NOT EXISTS, и повторный запуск ничего не строит.
set -euo pipefail

HOST=private-liberty-db-do-user-42796403-0.m.db.ondigitalocean.com
PORT=25060
DB=liberty

# ── что строим ─────────────────────────────────────────────────────────────
# Пара «имя · SQL». Добавлять сюда, а не в миграции, всё, что требует
# CONCURRENTLY.
INDEXES=(
  "ledger_class_change_idx|CREATE INDEX CONCURRENTLY IF NOT EXISTS ledger_class_change_idx ON ledger (player_id) WHERE reason = 'class_change'"
)

echo
echo "  Liberty — построение индексов без остановки игры"
echo "  ────────────────────────────────────────────────"
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

# Пароль в URL кодируется: в сгенерированном могут быть @ / : # ?, и каждый
# из них иначе прочитается как часть структуры самого адреса.
enc() { printf '%s' "$1" | od -An -tx1 -v | tr -d ' \n' | sed 's/../%&/g'; }
ADMIN_URL="postgresql://doadmin:$(enc "$PGPASS")@${HOST}:${PORT}/${DB}?sslmode=require"

echo "  Проверяю доступ..."
if ! PGCONNECT_TIMEOUT=15 psql "$ADMIN_URL" -tAc 'SELECT 1' >/dev/null 2>&1; then
  echo "  ✗ Не подключился. Обычно это одно из двух:" >&2
  echo "      • пароль скопирован не полностью" >&2
  echo "      • это пароль другого пользователя (нужен именно doadmin)" >&2
  exit 1
fi
echo "  ✓ Доступ есть"
echo

for entry in "${INDEXES[@]}"; do
  name="${entry%%|*}"
  sql="${entry#*|}"

  have=$(psql "$ADMIN_URL" -tAc "SELECT to_regclass('public.$name') IS NOT NULL")
  if [ "$have" = "t" ]; then
    echo "  ok      $name — уже есть"
    continue
  fi

  echo "  строю   $name ..."
  # Без statement_timeout: построение большого индекса законно идёт дольше
  # пяти секунд, и оборвать его на середине — значит получить непригодный
  # индекс (INVALID), который потом надо удалять руками.
  if psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q \
       -c "SET statement_timeout = 0" -c "$sql"; then
    echo "  ✓       $name построен"
  else
    echo "  ✗ не построился: $name" >&2
    # CONCURRENTLY при неудаче оставляет INVALID-индекс: он не используется
    # планировщиком, но занимает место и мешает повторной попытке под тем же
    # именем. Сказать об этом надо здесь, а не оставлять на потом.
    echo "    Если он остался в состоянии INVALID, снимите его и повторите:" >&2
    echo "      DROP INDEX CONCURRENTLY IF EXISTS $name;" >&2
    exit 1
  fi
done

echo
echo "  Проверяю, что вход больше не читает журнал целиком..."
PLAN=$(psql "$ADMIN_URL" -tAc "
  EXPLAIN (COSTS OFF)
  SELECT count(*)::int n FROM ledger
   WHERE player_id = (SELECT id FROM players ORDER BY id LIMIT 1)
     AND reason = 'class_change'")
if printf '%s' "$PLAN" | grep -qi 'Seq Scan on ledger'; then
  echo "  ⚠ план всё ещё читает ledger целиком:" >&2
  printf '%s\n' "$PLAN" | sed 's/^/      /' >&2
  echo "    Обычно помогает ANALYZE ledger — статистика ещё не обновилась." >&2
else
  echo "  ✓ индекс используется, полного чтения нет"
fi
echo
echo "  Готово. Перезапускать сервер не нужно — индекс работает сразу."
echo
