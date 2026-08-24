-- ── A closed listing is a RECORD, not a pointer ────────────────────────────
--
-- market_listings.item_id is `bigint NOT NULL REFERENCES player_items(id)`,
-- and the reference is kept forever — including after the listing is sold or
-- cancelled. The item, meanwhile, goes on living: the buyer equips it,
-- enhances it, breaks it, feeds it to a craft.
--
-- The first of those that DELETES the row is refused by the database:
--
--   [act:enhanceItem] update or delete on table "player_items" violates
--   foreign key constraint "market_listings_item_id_fkey"
--
-- So enhancing anything ever bought on the market fails, permanently, for
-- everyone — and the player is told "Ошибка сервера", because there is nothing
-- in the message a player could act on. It was found in the journal while two
-- of them were hitting it.
--
-- history() already LEFT JOINs the item and its comment already says "history
-- must survive the thing it describes" — the intent was right and the schema
-- made it unreachable. This finishes it:
--
--   * what was sold is SNAPSHOT onto the listing at listing time. A record of
--     a trade should say what was traded, not ask another table what that row
--     happens to hold today — by the time anyone reads the history, the answer
--     could be a different enhancement level or nothing at all.
--
--   * item_id becomes nullable, ON DELETE SET NULL. An ACTIVE listing still
--     points at the real row (that is how the market holds an item away from
--     its owner, and browse/mine join it for live data); a closed one keeps
--     the link only while the row survives.
--
-- The unique index on active listings is unaffected: a NULL item_id can only
-- occur on a closed row, and that index is partial on status = 'active'.

ALTER TABLE market_listings
  ADD COLUMN IF NOT EXISTS snap_item_id text,
  ADD COLUMN IF NOT EXISTS snap_enhance integer,
  ADD COLUMN IF NOT EXISTS snap_qty     integer;

-- Backfill from the rows that are still there, so existing history keeps its
-- detail rather than starting blank.
UPDATE market_listings l
   SET snap_item_id = i.item_id,
       snap_enhance = COALESCE(i.enhance, 0),
       snap_qty     = COALESCE(i.qty, 1)
  FROM player_items i
 WHERE i.id = l.item_id AND l.snap_item_id IS NULL;

ALTER TABLE market_listings
  ALTER COLUMN item_id DROP NOT NULL;

ALTER TABLE market_listings
  DROP CONSTRAINT IF EXISTS market_listings_item_id_fkey;

ALTER TABLE market_listings
  ADD CONSTRAINT market_listings_item_id_fkey
  FOREIGN KEY (item_id) REFERENCES player_items(id) ON DELETE SET NULL;

-- An ACTIVE listing must still hold a real item. Losing that would be a lot
-- for sale with nothing behind it.
ALTER TABLE market_listings
  DROP CONSTRAINT IF EXISTS market_active_has_item_ck;
ALTER TABLE market_listings
  ADD CONSTRAINT market_active_has_item_ck
  CHECK (status <> 'active' OR item_id IS NOT NULL);
