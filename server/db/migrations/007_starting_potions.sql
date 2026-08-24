-- ── The starting potions ───────────────────────────────────────────────────
-- A new character used to begin with 30 healing potions. Nobody granted them:
-- the CLIENT's default player object had `potionBag: { pt1: 30, pt2: 0 }`, and
-- the first saveProgress wrote that default into the account as if it were
-- earned. When the client stopped owning state, the grant went with it, and
-- every new player started with an empty bag and no way to heal.
--
-- It belongs in the schema rather than in ensure(): a default is a fact about
-- what a row means when nothing has happened yet, and putting it here makes it
-- true for every path that creates a player — login, the ETL, a test fixture —
-- without any of them having to remember.
--
-- Migrated accounts are unaffected: the ETL writes potion_bag explicitly from
-- what the player actually had, and an explicit value overrides a default.
ALTER TABLE player_progress
  ALTER COLUMN potion_bag SET DEFAULT '{"pt1": 30, "pt2": 0}'::jsonb;

-- Anyone who already registered on the new build under the empty default. The
-- WHERE clause makes this exact: only a bag that is still literally empty, so
-- a player who has since bought or spent potions is not touched.
UPDATE player_progress
   SET potion_bag = '{"pt1": 30, "pt2": 0}'::jsonb
 WHERE potion_bag = '{}'::jsonb;
