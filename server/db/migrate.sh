#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  migrate.sh — apply pending schema migrations, exactly once, atomically
# ═══════════════════════════════════════════════════════════════════════════
#
#   ADMIN_URL=postgres://doadmin:...@host:25060/liberty?sslmode=require \
#     ./server/db/migrate.sh
#
# Why a script and not a migration library: the whole job is "run these files
# in order, once each, and record which ran". A library adds a dependency, a
# config file and a DSL for something psql already does correctly, and this
# has to be auditable by anyone looking at a database that holds real money.
#
# Two properties that matter more than convenience:
#
#   ATOMIC — each file runs together with the row that records it, inside one
#            transaction (--single-transaction covers every -f/-c in the same
#            invocation). A migration that fails halfway leaves NO trace: not
#            half-applied tables, and not a version row claiming it ran. The
#            files therefore must NOT contain their own BEGIN/COMMIT, which is
#            why they don't.
#
#   ORDERED and IDEMPOTENT — files apply in filename order, and one already in
#            schema_migrations is skipped. Re-running after a partial failure
#            resumes from exactly the file that failed.
#
# ON_ERROR_STOP=1 is what makes any of that true: without it psql reports an
# error, carries on to the next statement and exits 0, which would let a
# broken migration be recorded as successful.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIG_DIR="$HERE/migrations"

if [[ -z "${ADMIN_URL:-}" ]]; then
  echo "ADMIN_URL is not set (postgres://doadmin:...@host:25060/liberty?sslmode=require)" >&2
  exit 1
fi

PSQL=(psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q --no-psqlrc)

# ── The ledger of what has run ─────────────────────────────────────────────
"${PSQL[@]}" -c "
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now(),
    -- How long it took, so a slow migration on a bigger database is a known
    -- number before the maintenance window rather than a surprise inside it.
    duration_ms integer
  );"

applied="$("${PSQL[@]}" -tAc 'SELECT version FROM schema_migrations')"

pending=0
for f in "$MIG_DIR"/*.sql; do
  name="$(basename "$f")"
  if grep -qxF "$name" <<<"$applied"; then
    printf '  ok    %s\n' "$name"
    continue
  fi
  pending=$((pending + 1))
  printf '  APPLY %s ... ' "$name"
  start=$(date +%s%3N)
  # -f and -c share one transaction: the migration and its version row commit
  # together or not at all.
  "${PSQL[@]}" --single-transaction \
      -f "$f" \
      -c "INSERT INTO schema_migrations (version, duration_ms)
          VALUES ('$name', 0)"
  ms=$(( $(date +%s%3N) - start ))
  "${PSQL[@]}" -c "UPDATE schema_migrations SET duration_ms = $ms WHERE version = '$name'"
  printf 'done (%s ms)\n' "$ms"
done

# ── Runtime privileges for the application role ────────────────────────────
# Re-applied on every run, deliberately. A GRANT names objects that exist at
# the time it runs, so a migration adding a table would otherwise leave that
# table unreachable by the app until someone remembered to grant it — a
# failure that shows up as a permission error in production, not in review.
#
# ALTER DEFAULT PRIVILEGES covers tables created LATER by doadmin, so this is
# belt and braces: the default privileges handle the future, this loop repairs
# anything created before they were set.
#
# Note what is NOT granted: no TRUNCATE, no REFERENCES, no CREATE on the
# schema, and no ownership. A compromised application process can change game
# rows — it cannot drop a table or alter the schema.
"${PSQL[@]}" <<'SQL'
GRANT USAGE ON SCHEMA public TO liberty_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO liberty_app;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA public TO liberty_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES    TO liberty_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT                  ON SEQUENCES TO liberty_app;

-- The ledger is append-only, and that is enforced rather than agreed. Without
-- this the app could UPDATE a ledger row and the reconciliation job — whose
-- entire job is to compare sum(delta) against balances — would be comparing
-- against something rewritable, i.e. checking nothing.
REVOKE UPDATE, DELETE ON ledger FROM liberty_app;

-- The item ledger, for the same reason and with the same force. Migration 012
-- carries this REVOKE too, but it CANNOT be the one that holds: the GRANT
-- above re-runs on every invocation of this script and hands UPDATE and DELETE
-- straight back. A REVOKE that lives only in the migration is therefore undone
-- by the next run of the script that applied it — which would leave items
-- reconciled against a table the application can rewrite, i.e. reconciled
-- against nothing. It has to be here, after the GRANT, to mean anything.
--
-- `IF EXISTS` because this script must keep working against a database that
-- has not had 012 applied yet: the migrations run above, so a fresh database
-- reaches this line with the table present, but re-running the script against
-- an older one must not fail on a table that is not there.
DO $$
BEGIN
  IF to_regclass('item_ledger') IS NOT NULL THEN
    REVOKE UPDATE, DELETE ON item_ledger FROM liberty_app;
  END IF;
END $$;

-- Schema history is a record of what happened to this database. The app has
-- no reason to touch it at all.
REVOKE ALL ON schema_migrations FROM liberty_app;
SQL

if [[ $pending -eq 0 ]]; then
  echo "nothing to apply — schema is current"
else
  echo "applied $pending migration(s)"
fi
