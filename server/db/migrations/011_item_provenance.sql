-- ── Where did this sword come from? ────────────────────────────────────────
--
-- The owner's requirement, in their words: "всі предмети все зароблене в бд
-- записується … не може бути нізвідки братись ті предмети все має бути
-- логічно завязано".
--
-- Half of that is already true, and structurally rather than by convention:
-- there is exactly ONE `INSERT INTO player_items` in the whole live server
-- (items.add), and every source funnels through it. A client cannot reach it
-- with a value of its own — savePrefs is the only client-written thing in the
-- build, and it is six enumerated columns.
--
-- The other half is not. `money.reconcile()` can PROVE currency integrity
-- nightly, because every movement leaves a ledger row keyed to the balance it
-- produced. Items have no equivalent. `player_items` carries item_id, enhance,
-- qty and created_at — and nothing that says which of the twelve grant paths
-- put it there. So "nothing came from nowhere" rests on code review, and the
-- honest answer to "where did this sword come from" was "не знаю". That is the
-- same answer player_logs used to give, and for the same reason: the column
-- did not exist.
--
-- Two columns, not a table. A full item ledger (every grant, every
-- destruction, every transfer) is the complete answer and a much larger
-- change; this is the part that pays for itself immediately and cannot drift,
-- because it is written by the single insert everything already goes through.
--
--   source     which path created it: 'kill', 'craft', 'quest', 'market',
--              'admin', 'vip', 'shop', 'mode', 'clan', 'box', 'merchant'
--   source_ref the thing inside that path — the enemy's eid, the recipe id,
--              the quest index, the listing id. Free text on purpose: it is
--              evidence, not a foreign key, and it must survive whatever it
--              points at being deleted.
--
-- Existing rows get NULL, which reads correctly as "created before anyone was
-- writing this down" rather than as a false claim.

ALTER TABLE player_items
  ADD COLUMN IF NOT EXISTS source     text,
  ADD COLUMN IF NOT EXISTS source_ref text;

-- Answering "show me everything this account was ever given by path X" without
-- reading the whole table. Partial, because the interesting rows are the ones
-- that HAVE a source and the pre-existing NULLs are noise.
CREATE INDEX IF NOT EXISTS player_items_source_idx
  ON player_items (source, player_id)
  WHERE source IS NOT NULL;

-- Reference data, so the values above are a closed set rather than whatever
-- each call site felt like typing. Not a foreign key: a constraint here would
-- turn "we added a new way to earn an item and forgot to register it" into a
-- failed grant in front of a player, which is a worse outcome than an
-- unrecognised label in an audit query.
COMMENT ON COLUMN player_items.source IS
  'kill|drop|craft|box|quest|vip|season|shop|merchant|market|clan|mode|admin|migration';
COMMENT ON COLUMN player_items.source_ref IS
  'free-text detail within the source: eid, recipe id, quest idx, listing id';
