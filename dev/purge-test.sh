#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  purge-test.sh — remove the test accounts the suites left in the database
# ═══════════════════════════════════════════════════════════════════════════
#
#   bash /srv/liberty/purge-test.sh
#
# Every suite in dev/ runs against the real database, because it is the only
# PostgreSQL this project has. Each run leaves an account behind: 2362 of them
# for 2 players.
#
# dev/purge-test-accounts.js already zeroed their battle rating, so none of
# them shows in any rating a player can open. This removes the rows for real,
# and it needs the admin password because the application's own user has no
# DELETE on `ledger` — a process that moves real money must not be able to
# erase the record of having moved it.
#
# It matters before the Mongo import: the socket suites log in through the real
# Telegram path with ids like 910000001 and 930000631, which are the same shape
# as a real account's. An imported player landing on one of those would be
# merged into a fixture.
set -euo pipefail

HOST=private-liberty-db-do-user-42796403-0.m.db.ondigitalocean.com
PORT=25060
DB=liberty

# Never deleted, whatever the pattern says.
KEEP="'1199957588','8868342638'"
# A tag, a slice of a pid, a role — or a telegram id that is not a number,
# which no real Telegram account can have.
WHERE="(username ~ '^([a-z]{2,6}-[0-9]{3,6}[_-])|^(probe_|tester\$|999\$)' OR telegram_id !~ '^[0-9]+\$')
       AND telegram_id NOT IN ($KEEP)"

echo
echo "  Liberty — очистка тестовых аккаунтов"
echo "  ────────────────────────────────────"
echo
printf "  Пароль doadmin (ввод не отображается): "
read -rs PGPASS
echo; echo
[ -n "$PGPASS" ] || { echo "  Пароль не введён." >&2; exit 1; }

enc() { printf '%s' "$1" | od -An -tx1 -v | tr -d ' \n' | sed 's/../%&/g'; }
URL="postgresql://doadmin:$(enc "$PGPASS")@${HOST}:${PORT}/${DB}?sslmode=require"

PGCONNECT_TIMEOUT=15 psql "$URL" -tAc 'SELECT 1' >/dev/null 2>&1 || {
  echo "  ✗ Не подключился — проверь пароль (нужен doadmin)." >&2; exit 1; }

echo "  До очистки:"
psql "$URL" -tAc "SELECT '    аккаунтов: ' || count(*) FROM players"
psql "$URL" -tAc "SELECT '    из них тестовых: ' || count(*) FROM players WHERE $WHERE"
echo

# One transaction: either the fixtures and their history both go, or neither
# does. Deleting the accounts without their ledger rows is impossible anyway
# (the foreign key sees to that), and deleting ledger rows without the accounts
# would leave balances that no longer add up.
psql "$URL" -v ON_ERROR_STOP=1 --single-transaction <<SQL
CREATE TEMP TABLE doomed AS SELECT id FROM players WHERE $WHERE;
-- An item held by a listing has player_id NULL, so the cascade from players
-- never reaches it: the listing goes first, then the orphan it was holding.
DELETE FROM player_items WHERE player_id IS NULL AND id IN (
  SELECT item_id FROM market_listings
   WHERE item_id IS NOT NULL AND (seller_id IN (SELECT id FROM doomed)
                                  OR buyer_id IN (SELECT id FROM doomed)));
DELETE FROM market_listings WHERE seller_id IN (SELECT id FROM doomed)
                               OR buyer_id  IN (SELECT id FROM doomed);
-- What they said, before what they are. chat_messages.player_id and
-- clan_chat.player_id are ON DELETE SET NULL, so the cascade would leave the
-- lines behind with the id stripped and the display name intact — visible in
-- the history real players open, and no longer traceable to anything. Deleted
-- by id while the id still exists, and by name for whatever was already
-- orphaned by an earlier run.
DELETE FROM chat_messages  WHERE player_id IN (SELECT id FROM doomed) OR username ~ $\$$;
DELETE FROM clan_chat      WHERE player_id IN (SELECT id FROM doomed) OR username ~ $\$$;
DELETE FROM direct_messages WHERE sender_id IN (SELECT id FROM doomed);
DELETE FROM ledger  WHERE player_id IN (SELECT id FROM doomed);
DELETE FROM players WHERE id IN (SELECT id FROM doomed);
SQL

echo
echo "  После очистки:"
psql "$URL" -tAc "SELECT '    аккаунтов: ' || count(*) FROM players"
psql "$URL" -tAc "
  SELECT '    бесхозных предметов: ' || count(*) FROM player_items pi
   WHERE pi.player_id IS NULL AND NOT EXISTS (
     SELECT 1 FROM market_listings m WHERE m.item_id = pi.id)"
psql "$URL" -tAc "
  SELECT '    расхождений баланс/леджер: ' || count(*) FROM (
    SELECT b.player_id, b.currency, b.amount,
           COALESCE((SELECT sum(l.delta) FROM ledger l
                      WHERE l.player_id=b.player_id AND l.currency=b.currency),0) led
      FROM balances b) x WHERE x.amount <> x.led"
echo "  Рейтинг:"
psql "$URL" -tAc "SELECT '    ' || username || '  ' || bm FROM players ORDER BY bm DESC NULLS LAST LIMIT 5"
echo
