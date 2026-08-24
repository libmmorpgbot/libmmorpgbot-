-- ═══════════════════════════════════════════════════════════════════════════
--  003_item_catalog — an item id that does not exist becomes unrepresentable
-- ═══════════════════════════════════════════════════════════════════════════
-- The Mongo version handled unknown item ids by DELETING them on the way in
-- (_canonSavedItem returns null, saveProgress drops the entry) and logging
-- what it dropped so "my items vanished after a deploy" would at least be
-- answerable. That is damage control for a problem the database can simply
-- not have: if item_id is a foreign key, a row referencing a nonexistent item
-- cannot be written in the first place, and — the half that actually protects
-- players — a catalog entry that still has items pointing at it cannot be
-- deleted either.
--
-- Source of truth stays shared/definitions.js. This table is a projection of
-- it, re-synced at every boot (see syncCatalog in server/db/repos/items.js).
-- Balance numbers deliberately do NOT live here: atk/def/hp change with every
-- tuning pass and belong in code, where they can be reviewed in a diff. What
-- is stored is only what the DATABASE needs in order to enforce a rule.

CREATE TABLE item_catalog (
  item_id     text PRIMARY KEY,
  -- 'weapon','helmet','material','box','use','buff_potion',... — which slot
  -- an equippable belongs in, and what kind of thing everything else is.
  slot        text    NOT NULL,
  -- Whether two of these merge into one row with a qty, or occupy a slot each.
  -- Derived from isStackableItem(), so the DB and the client cannot disagree
  -- about it — which is what made "a stackable with no existing stack still
  -- needs a free slot" a bug that had to be found twice.
  stackable   boolean NOT NULL,
  -- Whether a +N enhancement is meaningful. ENHANCEABLE_SLOTS in
  -- shared/definitions.js.
  enhanceable boolean NOT NULL,
  rarity      text,
  -- Kept only so an admin looking at a row in psql can tell what it is
  -- without cross-referencing the catalog in code.
  name        text    NOT NULL DEFAULT '',
  -- Set to false when an id is retired instead of deleting the row: items
  -- players already own must keep resolving, but the id stops being grantable.
  active      boolean NOT NULL DEFAULT true,
  synced_at   timestamptz NOT NULL DEFAULT now()
);

-- ── The foreign keys ───────────────────────────────────────────────────────
-- NOT VALID is not needed here (the tables are empty), and ON DELETE is
-- deliberately absent: the default NO ACTION is what makes a catalog row with
-- live items undeletable. A CASCADE here would mean "removing an item from the
-- catalog silently destroys every copy players own", which is precisely the
-- outcome this migration exists to prevent.
ALTER TABLE player_items
  ADD CONSTRAINT player_items_item_fk
  FOREIGN KEY (item_id) REFERENCES item_catalog (item_id);

ALTER TABLE clan_storage
  ADD CONSTRAINT clan_storage_item_fk
  FOREIGN KEY (item_id) REFERENCES item_catalog (item_id);

ALTER TABLE clan_allocations
  ADD CONSTRAINT clan_allocations_item_fk
  FOREIGN KEY (item_id) REFERENCES item_catalog (item_id);

-- ── Tighten the enhancement ceiling to the game's real one ─────────────────
-- 001 allowed 0..20 as headroom. ENHANCE_MAX is 15, and the looser bound only
-- means a bug can store a +18 the client cannot draw. Raising the cap should
-- be a deliberate migration, not something a wrong number slips through.
ALTER TABLE player_items DROP CONSTRAINT player_items_enhance_check;
ALTER TABLE player_items
  ADD CONSTRAINT player_items_enhance_check CHECK (enhance BETWEEN 0 AND 15);

-- A stack ceiling, matching _SANITIZE_MAX.qty. The unique legendaries cost
-- 5000 shards of each kind, so a legitimate pile is large — but unbounded is
-- how a forged number gets stored and then has to be reasoned about
-- everywhere downstream.
ALTER TABLE player_items
  ADD CONSTRAINT player_items_qty_max_check CHECK (qty <= 1000000);

-- Lets the boot-time sync and the admin item picker read the catalog by slot
-- without a scan.
CREATE INDEX item_catalog_slot_idx ON item_catalog (slot) WHERE active;
