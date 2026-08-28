#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  purge-test.sh — remove the test accounts the suites left in the database
# ═══════════════════════════════════════════════════════════════════════════
#
#   bash /srv/liberty/purge-test.sh
#
# Every suite in dev/ runs against the real database, because it is the only
# PostgreSQL this project has. Each run leaves an account behind: 3521 of them
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
#
# ── why the SQL below is in a QUOTED heredoc ───────────────────────────────
# The previous version used an unquoted one and interpolated $WHERE into it.
# The pattern for test usernames contains `$` (end-of-string anchors), and the
# escaping needed to survive the shell turned two DELETE statements into
# `username ~ $$$;` — an accidental dollar-quoted string that swallowed the
# statement written after it. Nothing in that SQL needs the shell's help, so
# the shell is not given the chance: <<'SQL' passes every byte through
# untouched, and the two values that vary are written inline where they can be
# read.
set -euo pipefail

HOST=private-liberty-db-do-user-42796403-0.m.db.ondigitalocean.com
PORT=25060
DB=liberty

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
psql "$URL" -tA -f - <<'COUNTSQL'
SELECT '    из них тестовых: ' || count(*) FROM players
 WHERE (username ~ '^([a-z]{2,6}-[0-9]{3,6}[_-])|^(probe_|tester$|999$)'
        OR telegram_id !~ '^[0-9]+$')
   AND telegram_id NOT IN ('1199957588','8868342638');
COUNTSQL
echo

# One transaction: either the fixtures and their whole history go, or nothing
# does. That is also what made the first failed run harmless — it stopped on a
# foreign key with three DELETEs already issued, and rolled all of them back.
psql "$URL" -v ON_ERROR_STOP=1 --single-transaction -f - <<'SQL'
-- A tag, a slice of a pid, a role — or a telegram id that is not a number,
-- which no real Telegram account can have. The two ids never touched whatever
-- the pattern says are the two real admins.
CREATE TEMP TABLE doomed AS
SELECT id, username, telegram_id FROM players
 WHERE (username ~ '^([a-z]{2,6}-[0-9]{3,6}[_-])|^(probe_|tester$|999$)'
        OR telegram_id !~ '^[0-9]+$')
   AND telegram_id NOT IN ('1199957588','8868342638');

-- ── the guard ────────────────────────────────────────────────────────────
-- Every table in the list below is there because its foreign key to players
-- has no ON DELETE rule: nothing clears it for us, so one row left behind
-- stops the whole purge with a raw constraint error and no hint about what to
-- add. That is exactly how the first run failed, on gram_tx.
--
-- So the list is not merely written down, it is CHECKED against the live
-- catalog. A migration that adds a new table pointing at players without a
-- delete rule now raises a sentence naming that table, instead of leaving the
-- next person to decode a constraint name a year from now.
DO $guard$
DECLARE unhandled text;
BEGIN
  SELECT string_agg(tbl || '.' || col, ', ') INTO unhandled FROM (
    -- relname, not conrelid::regclass::text: the cast schema-qualifies
    -- anything outside search_path, and a stray "public." prefix would make
    -- every known entry look unknown and raise on a healthy database.
    SELECT cl.relname::text AS tbl, a.attname AS col
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
     WHERE c.contype = 'f'
       AND c.confrelid = 'players'::regclass
       AND c.confdeltype IN ('a', 'r')   -- NO ACTION / RESTRICT: blocks us
  ) f
  WHERE (f.tbl, f.col) NOT IN (
    ('ledger', 'player_id'), ('gram_tx', 'player_id'),
    ('market_listings', 'seller_id'), ('market_listings', 'buyer_id'),
    ('clan_allocations', 'allocated_by'),
    ('unmatched_deposits', 'resolved_player_id')
  );
  IF unhandled IS NOT NULL THEN
    RAISE EXCEPTION
      'purge-test: на players ссылается таблица, которую скрипт не чистит: %. Добавь для неё DELETE выше и внеси в этот список.',
      unhandled;
  END IF;
END
$guard$;

-- An item held by a listing has player_id NULL, so the cascade from players
-- never reaches it: the listing goes first, then the orphan it was holding.
DELETE FROM player_items WHERE player_id IS NULL AND id IN (
  SELECT item_id FROM market_listings
   WHERE item_id IS NOT NULL AND (seller_id IN (SELECT id FROM doomed)
                                  OR buyer_id IN (SELECT id FROM doomed)));
DELETE FROM market_listings WHERE seller_id IN (SELECT id FROM doomed)
                               OR buyer_id  IN (SELECT id FROM doomed);

-- Real-money requests. No cascade there on purpose: a deposit or a withdrawal
-- must not be erasable as a side effect of removing an account.
DELETE FROM gram_tx WHERE player_id IN (SELECT id FROM doomed);

-- Money that arrived on chain and was placed by hand. The ROW never goes: it
-- is the record that the transfer was seen, and a record of real money must
-- not be erasable as a side effect of tidying up test accounts.
--
-- Nor is the pointer simply nulled. Migration 014 gives that state a meaning:
-- `resolved_player_id IS NULL` WITH `resolved_at` SET reads as "an operator
-- looked at this and deliberately declined". Nulling the column alone would
-- rewrite "credited to X" into "declined" — silently, in a money record.
--
-- So the row goes back to OPEN, which is what is actually true once the
-- account it was credited to stops existing: nobody holds this money any
-- more and a human has to decide again. It cannot double-credit anyone —
-- the first credit went to an account being deleted in the same transaction.
--
-- Today this matches zero rows (dev/unmatched-who.js: the only resolved row
-- points at a live player). It exists so that the day a detector resolves
-- one to a fixture, the purge keeps working instead of stopping here.
UPDATE unmatched_deposits
   SET resolved_player_id = NULL, resolved_at = NULL, resolved_by = NULL
 WHERE resolved_player_id IN (SELECT id FROM doomed);

-- An allocation a fixture handed to a REAL member: the member's pending claim
-- is theirs and stays. Only the record of who granted it is forgotten, because
-- the granter is about to stop existing.
UPDATE clan_allocations SET allocated_by = NULL
 WHERE allocated_by IN (SELECT id FROM doomed);

-- What they said, before what they are. chat_messages.player_id and
-- clan_chat.player_id are ON DELETE SET NULL, so the cascade would leave the
-- lines behind with the id stripped and the display name intact — visible in
-- the history real players open, and no longer traceable to anything. Deleted
-- by id while the id still exists, and by name for whatever an earlier run
-- already orphaned.
DELETE FROM chat_messages WHERE player_id IN (SELECT id FROM doomed)
   OR (player_id IS NULL
       AND username ~ '^([a-z]{2,6}-[0-9]{3,6}[_-])|^(probe_|tester$|999$)');
DELETE FROM clan_chat     WHERE player_id IN (SELECT id FROM doomed)
   OR (player_id IS NULL
       AND username ~ '^([a-z]{2,6}-[0-9]{3,6}[_-])|^(probe_|tester$|999$)');
DELETE FROM direct_messages WHERE sender_id IN (SELECT id FROM doomed);

-- player_logs carries no foreign key at all — it is partitioned, and pointing
-- one at a partitioned table is not free — so nothing would stop these rows
-- outliving the accounts they describe.
DELETE FROM player_logs WHERE player_id IN (SELECT id FROM doomed);

-- referred_by holds a telegram id, not a row id: no foreign key to dangle, but
-- it would go on naming an account that no longer exists, and every referral
-- query would silently find nothing while looking like it worked.
UPDATE players SET referred_by = NULL
 WHERE referred_by IN (SELECT telegram_id FROM doomed);

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
# A fixture that led a clan takes its clan_members row with it. The clan itself
# survives the cascade, so a real member can be left in a clan that nobody can
# administer — worth seeing rather than discovering from a complaint.
psql "$URL" -tAc "
  SELECT '    кланов без лидера: ' || count(*) FROM clans c
   WHERE NOT EXISTS (SELECT 1 FROM clan_members m
                      WHERE m.clan_id = c.id AND m.role = 'leader')"
echo "  Рейтинг:"
psql "$URL" -tAc "SELECT '    ' || username || '  ' || bm FROM players ORDER BY bm DESC NULLS LAST LIMIT 5"
echo
