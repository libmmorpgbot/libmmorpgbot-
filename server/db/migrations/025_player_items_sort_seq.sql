-- ── player_items.sort_seq — where an item sits in its list, not when it was
--    made ──────────────────────────────────────────────────────────────────
--
-- inventoryOf and resolveRow both ordered by `id`, which was fine as long as
-- nothing ever changed which container a row lives in without also changing
-- its id — and moveTo() (equip/unequip, storage deposit/withdraw) never did:
-- it only ever updated `container` in place. So a weapon worn for weeks
-- reappeared on unequip wherever it sorted back when it was first looted,
-- and a shard type deposited into storage for the first time could land
-- ahead of things acquired long before it — "кладу в хранилище, а оно
-- ложится непонятно куда".
--
-- `id` keeps meaning exactly what it always has — created in this order,
-- forever — because too much already leans on that: item_ledger.row_id,
-- a closed market listing's item_id (ON DELETE SET NULL, migration 010), a
-- caller that captures a row id before one moveTo call and still means the
-- same row after a second one (dev/stats-check.js does exactly this,
-- chaining unequip -> storage -> inventory against one captured id).
--
-- sort_seq is a separate, purely cosmetic ordering key. It starts equal to
-- id (nothing has moved yet, so "created order" and "display order" agree),
-- and moveTo's _bumpToEnd() advances it — one UPDATE, never a new row —
-- whenever an item lands somewhere with no existing stack to fold into.
ALTER TABLE player_items ADD COLUMN IF NOT EXISTS sort_seq bigint;
UPDATE player_items SET sort_seq = id WHERE sort_seq IS NULL;
ALTER TABLE player_items ALTER COLUMN sort_seq SET NOT NULL;
-- Drawn from player_items' own identity sequence, not a new one: that
-- guarantees every value handed out from here on — whether to a freshly
-- INSERTed row or to a bump — is higher than every id and every sort_seq
-- assigned so far, so "newest" and "sorts last" stay the same thing.
ALTER TABLE player_items ALTER COLUMN sort_seq
  SET DEFAULT nextval(pg_get_serial_sequence('player_items', 'id'));

-- inventoryOf's and resolveRow's own access path: one player's rows, in
-- display order.
CREATE INDEX IF NOT EXISTS player_items_sort_idx ON player_items (player_id, sort_seq);
