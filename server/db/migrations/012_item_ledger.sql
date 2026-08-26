-- ── Where did this sword come from, and where did it go? ───────────────────
--
-- Migration 011 added `player_items.source` / `.source_ref` and said what it
-- was not: "A full item ledger (every grant, every destruction, every
-- transfer) is the complete answer and a much larger change". This is that
-- change.
--
-- The gap 011 left is that provenance written ON the item row DIES WITH IT.
-- Delete the row — enhance it to destruction, burn it for season points, feed
-- it to a craft, register it into the codex — and the record of where it came
-- from is deleted in the same statement. So the one question an item dupe
-- makes you ask, "what happened to this row", has no answer after the fact,
-- and an item created outside items.add() leaves nothing behind at all.
--
-- Money does not have this problem, and the difference is structural rather
-- than diligent: `ledger` is a SEPARATE APPEND-ONLY TABLE, so a movement's
-- record does not live inside the thing it describes and cannot be removed
-- with it. money.reconcile() can therefore prove nightly that
-- sum(ledger.delta) == balances.amount for every account. Items had no such
-- proof, and "nothing came from nowhere" rested on code review.
--
-- What this table makes unrepresentable: a change in how many of an item an
-- account holds, with no row saying why.
--
--
-- ── Why QUANTITY DELTAS and not row lifecycle events ───────────────────────
--
-- The obvious shape is one row per player_items.id per lifecycle event —
-- created / moved / destroyed — because an item here IS a row with identity.
-- It was rejected, for one reason that decides it:
--
--   A STACKABLE IS DUPLICATED BY ARITHMETIC, NOT BY INSERTION.
--
-- items.add() merges into an existing stack with `UPDATE player_items SET
-- qty = qty + $3`. No row is created. A lifecycle ledger keyed on the row id
-- sees nothing at all — the row was created once, honestly, months ago, and
-- has been growing ever since. That is precisely the write a dupe would use,
-- and it is the write a lifecycle ledger is blind to.
--
-- Quantity deltas see both: a phantom INSERT and a phantom `qty + n` are the
-- same event to this table, because both change how many the account holds.
-- It is also the shape `ledger` already has, which is the point — the two
-- reconcilers are then the same query about different nouns, and an operator
-- who understands one understands the other.
--
-- Row identity is not lost, it is demoted from the KEY to a COLUMN: `row_id`
-- records which player_items row the movement was about, so "where did this
-- Excalibur come from" is still answerable — `SELECT * FROM item_ledger WHERE
-- row_id = <id> ORDER BY id` — and, unlike 011, it stays answerable after the
-- row is gone.
--
-- The invariant, in one sentence: FOR EVERY ACCOUNT AND EVERY CATALOG ITEM,
-- THE SUM OF EVERY DELTA IN THIS TABLE EQUALS THE QUANTITY THAT ACCOUNT HOLDS
-- RIGHT NOW. items.reconcile() is that sentence as one query.
--
--
-- ── What is deliberately NOT recorded ──────────────────────────────────────
--
-- Equipping, unequipping and moving to clan storage change an item's
-- CONTAINER, not how many the account holds, so they write nothing here. That
-- is not an omission: `delta <> 0` below means a container move has no
-- well-formed row to write, and a table of zeroes would bury the movements
-- that matter. Where an item sits is player_logs' subject; this table is
-- about existence and ownership.
--
-- A market listing IS recorded, because it moves the item between owners:
-- the seller's holding drops when the item is detached, and the buyer's rises
-- when it is delivered. In between the item belongs to the listing and to no
-- account, so it is in nobody's sum — exactly as player_items represents it,
-- with player_id NULL.

CREATE TABLE IF NOT EXISTS item_ledger (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- ON DELETE CASCADE, and this is the one place this table deliberately
  -- DIFFERS from `ledger`. Money history must outlive the account that made it
  -- (dev/purge-test-accounts.js deletes both sides by hand for exactly that
  -- reason), because a deposit is real money and a deleted account does not
  -- unmake it. Items are not: player_items is itself ON DELETE CASCADE, so a
  -- deleted account's items are gone. If this table did not cascade with them,
  -- every deleted account would leave rows summing to N against zero items
  -- held — permanent drift, on an account nobody can look at, alarming for
  -- ever. An alarm that cannot be cleared is an alarm that gets muted, and a
  -- muted channel is where the next real dupe goes to die.
  player_id  bigint  NOT NULL REFERENCES players(id) ON DELETE CASCADE,

  -- Which player_items row this movement was about. NOT a foreign key, for the
  -- same reason source_ref is not one (migration 011): it is EVIDENCE, and
  -- evidence must survive the thing it points at being deleted. A reference
  -- here would either block the destruction it exists to record, or be nulled
  -- out by it — and the row that says "this item was destroyed" is the single
  -- most important row in the table. NULL where a movement genuinely names no
  -- single row (a consume that drained three stacks at once).
  row_id     bigint,

  item_id    text    NOT NULL,          -- catalog id, as player_items.item_id

  -- Signed, and never zero — a row that moves nothing is not a movement. The
  -- same rule as ledger.delta, for the same reason.
  delta      integer NOT NULL CHECK (delta <> 0),

  -- How many of this item the account held once the movement was applied,
  -- written by the same transaction that applied it. This is what makes drift
  -- LOCATABLE rather than merely detectable: reconcile() says an account's
  -- count is off by three, and the first row here whose qty_after departs from
  -- the running sum of delta says which operation did it, and when.
  qty_after  integer NOT NULL CHECK (qty_after >= 0),

  reason     text    NOT NULL,          -- 'kill_drop','craft_out','enhance_burn',...
  ref_type   text,                      -- 'listing','recipe','quest','enemy',...
  ref_id     text,

  -- Idempotency, and it is OPTIONAL here where on `ledger` it is mandatory.
  -- The difference is what guards the operation. A money movement is its own
  -- unit of work and can be retried on its own, so the key is the only thing
  -- standing between a lost acknowledgement and a double credit. An item
  -- movement is written INSIDE the transaction that moves the item, so a retry
  -- after a failure re-runs a transaction that wrote nothing, and a retry after
  -- a commit is a second genuine movement. Paths that do have a stable natural
  -- key (a listing, an admin request) still pass one, so a replay is refused
  -- here as loudly as it is there. NULL is not UNIQUE-constrained in
  -- PostgreSQL, so the paths that have no such key simply omit it.
  idem_key   text UNIQUE,

  created_at timestamptz NOT NULL DEFAULT now()
);

-- The reconcile query's access path: sum(delta) grouped per account and item.
CREATE INDEX IF NOT EXISTS item_ledger_owner_idx
  ON item_ledger (player_id, item_id, id DESC);

-- "What happened to this row" — the question 011 could not answer once the row
-- was deleted. Partial, because a movement that names no single row is noise
-- to that question.
CREATE INDEX IF NOT EXISTS item_ledger_row_idx
  ON item_ledger (row_id) WHERE row_id IS NOT NULL;

-- "What did this path hand out today", for an audit that starts from a
-- suspicion rather than from an account.
CREATE INDEX IF NOT EXISTS item_ledger_reason_idx
  ON item_ledger (reason, created_at DESC);

-- One string constant, not three joined with `||`: COMMENT ON takes a string
-- CONSTANT, and an expression there is a syntax error that would fail the whole
-- migration on a line that only documents things.
--
-- A creation reason is the same label migration 011 already defined for
-- player_items.source, so the column and the ledger cannot describe the same
-- grant differently. The rest name what removed or moved it.
COMMENT ON COLUMN item_ledger.reason IS
  'created: kill|drop|craft|box|quest|vip|season|shop|merchant|clan|mode|admin — moved/destroyed: consume|destroy|craft_mats|enhance_burn|season_burn|codex_register|market_list|market_buy|market_cancel|migration_opening';
COMMENT ON COLUMN item_ledger.row_id IS
  'player_items.id this movement was about — evidence, not a reference: it outlives the row';

-- ── the opening balance ────────────────────────────────────────────────────
-- Every item that exists right now was granted before anything was writing
-- this down, so without a seed the very first reconcile reports EVERY account
-- as drifted. dev/etl.js hit exactly this for money and solved it the same way
-- ("Without this, reconcile() reports every migrated account as drifted and the
-- alarm becomes noise"), down to the reason string.
--
-- One row per existing item row, not one per (account, item): the running sum
-- below gives each of them a truthful qty_after, and seeding per row means
-- row_id is populated for items that already exist — so the "what happened to
-- this row" query has a starting point for the whole current inventory rather
-- than only for items granted after today.
--
-- `source` is carried into ref_id where 011 recorded one. It is the only thing
-- known about where these items came from, and it is better evidence than NULL.
--
-- Guarded on the table being empty so a re-run cannot double the opening
-- balance — which would itself be drift, manufactured by the fix for drift.
INSERT INTO item_ledger (player_id, row_id, item_id, delta, qty_after, reason, ref_type, ref_id, idem_key)
SELECT pi.player_id,
       pi.id,
       pi.item_id,
       pi.qty,
       -- Cast spelled out: sum() over integers returns bigint, and while an
       -- INSERT would narrow it by assignment cast anyway, a running total
       -- that silently changes width is not something to leave implicit in the
       -- one statement that establishes what every later reconcile compares
       -- against.
       (SUM(pi.qty) OVER (PARTITION BY pi.player_id, pi.item_id
                              ORDER BY pi.id
                              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW))::int,
       'migration_opening',
       'migration',
       pi.source,
       'migration:item:' || pi.id
  FROM player_items pi
 WHERE pi.player_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM item_ledger);

-- ── append-only ────────────────────────────────────────────────────────────
-- The same REVOKE `ledger` has, and for the same reason: a reconciler that
-- compares a count against a table the application can rewrite is comparing a
-- number against a number the same process wrote, which is checking nothing.
--
-- THIS REVOKE IS NOT SUFFICIENT ON ITS OWN, and that is worth being explicit
-- about. server/db/migrate.sh re-runs `GRANT SELECT, INSERT, UPDATE, DELETE ON
-- ALL TABLES IN SCHEMA public TO liberty_app` AFTER every migration, on every
-- invocation — so this line is undone by the next run of the very script that
-- applied it. The REVOKE that actually holds is the one added beside
-- `REVOKE UPDATE, DELETE ON ledger` at the bottom of migrate.sh. This one is
-- here so that a hand-applied migration is not silently writable in the window
-- before that script runs.
--
-- Conditional because no other migration names a role at all — every GRANT in
-- this project lives in migrate.sh, which runs against a database where
-- liberty_app is already present. A local database restored without that role
-- applies 001 through 011 without noticing it is missing, and 012 must not be
-- the first migration that stops dead on it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liberty_app') THEN
    REVOKE UPDATE, DELETE ON item_ledger FROM liberty_app;
  END IF;
END $$;
