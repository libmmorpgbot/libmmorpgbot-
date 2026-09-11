#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  delete-player.sh — remove ONE player's account from the production DB
# ═══════════════════════════════════════════════════════════════════════════
#
#   bash dev/delete-player.sh <telegram_id>
#
# Same shape as dev/purge-test.sh (which purges test fixtures by pattern),
# but targets exactly one telegram_id and is meant for a real player who
# asked to be removed / needs to be removed by an operator. It runs the same
# battle-tested cascade purge-test.sh uses, with the admin (doadmin)
# credential — the application's own role has no DELETE on `ledger` or
# `gram_tx` on purpose (see server/db/repos/players.js's long comment: a
# process that moves real money must not be able to erase the record of
# having moved it), so removing an account that ever held money needs the
# admin password, same as purge-test.sh does.
#
# ── this is IRREVERSIBLE ────────────────────────────────────────────────────
# It first PRINTS what is about to disappear (username, BM, ledger/gram_tx
# row counts, clan role, market listings, anyone they referred) and refuses
# to touch anything until you type the account's own username back. If the
# account ever moved real money (ledger or gram_tx has rows), read that
# printed count before confirming — deleting it also deletes that financial
# history, which is exactly what the app's own automatic cleanup
# (dev/purge-test-accounts.js) refuses to do for accidental/test cases. For
# a real player who explicitly asked to be deleted this is the point; if that
# is not what you want, ban the account instead (see BAN_ONLY below).
#
# BAN_ONLY=1 bash dev/delete-player.sh <telegram_id>
#   Does not delete anything. Bans the account and zeroes its battle power —
#   the same fallback the app already uses for accounts ledger holds — so it
#   drops out of the rating/chat/admin panel but every financial record and
#   the row itself stay intact.
set -euo pipefail

if [ $# -ne 1 ] || ! [[ "$1" =~ ^[0-9]+$ ]]; then
  echo "Использование: bash dev/delete-player.sh <telegram_id>" >&2
  exit 1
fi
TG="$1"
BAN_ONLY="${BAN_ONLY:-0}"

HOST=private-liberty-db-do-user-42796403-0.m.db.ondigitalocean.com
PORT=25060
DB=liberty

echo
echo "  Liberty — удаление аккаунта (telegram_id=$TG)"
echo "  ──────────────────────────────────────────────"
echo
printf "  Пароль doadmin (ввод не отображается): "
read -rs PGPASS
echo; echo
[ -n "$PGPASS" ] || { echo "  Пароль не введён." >&2; exit 1; }

enc() { printf '%s' "$1" | od -An -tx1 -v | tr -d ' \n' | sed 's/../%&/g'; }
URL="postgresql://doadmin:$(enc "$PGPASS")@${HOST}:${PORT}/${DB}?sslmode=require"

PGCONNECT_TIMEOUT=15 psql "$URL" -tAc 'SELECT 1' >/dev/null 2>&1 || {
  echo "  ✗ Не подключился — проверь пароль (нужен doadmin)." >&2; exit 1; }

USERNAME=$(psql "$URL" -tA -v tg="$TG" -c "SELECT username FROM players WHERE telegram_id = :'tg'")
if [ -z "$USERNAME" ]; then
  echo "  Игрок с telegram_id=$TG не найден." >&2
  exit 1
fi

echo "  Аккаунт:"
psql "$URL" -tA -v tg="$TG" -f - <<'SQL'
SELECT '    username: '   || username
    || ', id: '            || id
    || ', bm: '            || bm
    || ', banned: '        || banned
    || ', создан: '        || created_at
  FROM players WHERE telegram_id = :'tg';
SQL
echo "  Держит:"
psql "$URL" -tA -v tg="$TG" -f - <<'SQL'
SELECT '    строк в ledger (движения золота/грамов): '
    || (SELECT count(*) FROM ledger l JOIN players p ON p.id=l.player_id WHERE p.telegram_id = :'tg');
SELECT '    строк в gram_tx (депозиты/выводы TON): '
    || (SELECT count(*) FROM gram_tx g JOIN players p ON p.id=g.player_id WHERE p.telegram_id = :'tg');
SELECT '    активных лотов на рынке: '
    || (SELECT count(*) FROM market_listings m JOIN players p ON p.id=m.seller_id WHERE p.telegram_id = :'tg' AND m.status='active');
SELECT '    состоит в клане (роль): '
    || COALESCE((SELECT cm.role FROM clan_members cm JOIN players p ON p.id=cm.player_id WHERE p.telegram_id = :'tg'), '—');
SELECT '    привёл живых игроков: '
    || (SELECT count(*) FROM players r JOIN players p ON p.telegram_id = :'tg' WHERE r.referred_by = p.telegram_id);
SQL
echo

if [ "$BAN_ONLY" = "1" ]; then
  printf "  Забанить и обнулить БМ (без удаления)? Введи username «%s» для подтверждения: " "$USERNAME"
  read -r CONFIRM
  [ "$CONFIRM" = "$USERNAME" ] || { echo "  Отменено."; exit 1; }
  psql "$URL" -v ON_ERROR_STOP=1 -v tg="$TG" -c \
    "UPDATE players SET banned = true, bm = 0, updated_at = now() WHERE telegram_id = :'tg'"
  echo "  Готово: аккаунт забанен, БМ обнулён, ничего не удалено."
  exit 0
fi

echo "  ⚠ Это НЕОБРАТИМО и удалит аккаунт целиком, включая ledger/gram_tx (если есть)."
printf "  Введи username «%s» для подтверждения: " "$USERNAME"
read -r CONFIRM
[ "$CONFIRM" = "$USERNAME" ] || { echo "  Отменено."; exit 1; }
echo

# One transaction: either everything goes, or nothing does. Body copied from
# dev/purge-test.sh (including its self-checking FK guard) with `doomed`
# selecting this one telegram_id instead of the fixture pattern.
psql "$URL" -v ON_ERROR_STOP=1 -v tg="$TG" --single-transaction -f - <<'SQL'
CREATE TEMP TABLE doomed AS
SELECT id, username, telegram_id FROM players WHERE telegram_id = :'tg';

DO $guard$
DECLARE unhandled text;
BEGIN
  SELECT string_agg(tbl || '.' || col, ', ') INTO unhandled FROM (
    SELECT cl.relname::text AS tbl, a.attname AS col
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
     WHERE c.contype = 'f'
       AND c.confrelid = 'players'::regclass
       AND c.confdeltype IN ('a', 'r')
  ) f
  WHERE (f.tbl, f.col) NOT IN (
    ('ledger', 'player_id'), ('gram_tx', 'player_id'),
    ('market_listings', 'seller_id'), ('market_listings', 'buyer_id'),
    ('clan_allocations', 'allocated_by'),
    ('unmatched_deposits', 'resolved_player_id')
  );
  IF unhandled IS NOT NULL THEN
    RAISE EXCEPTION
      'delete-player: на players ссылается таблица, которую скрипт не чистит: %. Добавь для неё DELETE выше и внеси в этот список.',
      unhandled;
  END IF;
END
$guard$;

CREATE TEMP TABLE doomed_items AS
SELECT item_id AS id FROM market_listings
 WHERE item_id IS NOT NULL AND (seller_id IN (SELECT id FROM doomed)
                                OR buyer_id IN (SELECT id FROM doomed));
DELETE FROM market_listings WHERE seller_id IN (SELECT id FROM doomed)
                               OR buyer_id  IN (SELECT id FROM doomed);
DELETE FROM player_items WHERE player_id IS NULL
                           AND id IN (SELECT id FROM doomed_items);

DELETE FROM gram_tx WHERE player_id IN (SELECT id FROM doomed);

UPDATE unmatched_deposits
   SET resolved_player_id = NULL, resolved_at = NULL, resolved_by = NULL
 WHERE resolved_player_id IN (SELECT id FROM doomed);

UPDATE clan_allocations SET allocated_by = NULL
 WHERE allocated_by IN (SELECT id FROM doomed);

DELETE FROM chat_messages WHERE player_id IN (SELECT id FROM doomed);
DELETE FROM clan_chat     WHERE player_id IN (SELECT id FROM doomed);
DELETE FROM direct_messages WHERE sender_id IN (SELECT id FROM doomed);

DELETE FROM player_logs WHERE player_id IN (SELECT id FROM doomed);

UPDATE players SET referred_by = NULL
 WHERE referred_by IN (SELECT telegram_id FROM doomed);

DELETE FROM ledger  WHERE player_id IN (SELECT id FROM doomed);
DELETE FROM players WHERE id IN (SELECT id FROM doomed);
SQL

echo "  Готово: аккаунт telegram_id=$TG (username «$USERNAME») удалён."
