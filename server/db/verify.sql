-- ═══════════════════════════════════════════════════════════════════════════
--  verify.sql — proves the schema's guarantees actually bite
-- ═══════════════════════════════════════════════════════════════════════════
-- A constraint that exists is not the same as a constraint that fires. Every
-- rule this migration was written to enforce is attacked here with the exact
-- shape of the bug it replaces, and the test passes only when the database
-- REFUSES it. Everything runs inside one transaction that is rolled back, so
-- this leaves no rows behind and can be run against a live database.
\set ON_ERROR_STOP off
\t on

BEGIN;

-- A player to hang the tests off.
INSERT INTO players (telegram_id, username) VALUES ('t-verify', 'verify_user');
INSERT INTO player_progress (player_id) SELECT id FROM players WHERE telegram_id='t-verify';
INSERT INTO player_prefs    (player_id) SELECT id FROM players WHERE telegram_id='t-verify';
INSERT INTO balances (player_id, currency, amount)
  SELECT id, 'gram', 10 FROM players WHERE telegram_id='t-verify';

\echo '── 1. citext: username matching must ignore case ──'
SELECT CASE WHEN count(*)=1 THEN 'PASS  VERIFY_USER matches verify_user'
            ELSE 'FAIL  citext is not case-insensitive' END
  FROM players WHERE username = 'VERIFY_USER';

\echo '── 2. duplicate username must be refused regardless of case ──'
SAVEPOINT s; INSERT INTO players (telegram_id, username) VALUES ('t-dup','VeRiFy_UsEr');
\echo '   (expect: duplicate key)'
ROLLBACK TO s;

\echo '── 3. two items in ONE equipment slot must be impossible ──'
INSERT INTO player_items (player_id, container, slot, item_id)
  SELECT id,'equipment','weapon','w1' FROM players WHERE telegram_id='t-verify';
SAVEPOINT s;
INSERT INTO player_items (player_id, container, slot, item_id)
  SELECT id,'equipment','weapon','w2' FROM players WHERE telegram_id='t-verify';
\echo '   (expect: duplicate key on player_items_equip_slot_key)'
ROLLBACK TO s;

\echo '── 4. an item cannot be half-owned (owner without container) ──'
SAVEPOINT s;
INSERT INTO player_items (player_id, container, item_id)
  SELECT id, NULL, 'x1' FROM players WHERE telegram_id='t-verify';
\echo '   (expect: player_items_owned_ck)'
ROLLBACK TO s;

\echo '── 5. a negative balance must be impossible ──'
SAVEPOINT s;
UPDATE balances SET amount = amount - 999
 WHERE player_id=(SELECT id FROM players WHERE telegram_id='t-verify') AND currency='gram';
\echo '   (expect: balances_amount_check)'
ROLLBACK TO s;

\echo '── 6. spend guarded by amount >= price: too-large spend touches 0 rows ──'
UPDATE balances SET amount = amount - 999
 WHERE player_id=(SELECT id FROM players WHERE telegram_id='t-verify')
   AND currency='gram' AND amount >= 999;
\echo '   (expect: UPDATE 0 — this is how affordability and deduction become one step)'

\echo '── 7. ledger idem_key must make a retry a no-op, not a double credit ──'
INSERT INTO ledger (player_id,currency,delta,balance_after,reason,idem_key)
  SELECT id,'gram',5,15,'test','market_buy:1:1' FROM players WHERE telegram_id='t-verify';
SAVEPOINT s;
INSERT INTO ledger (player_id,currency,delta,balance_after,reason,idem_key)
  SELECT id,'gram',5,20,'test','market_buy:1:1' FROM players WHERE telegram_id='t-verify';
\echo '   (expect: duplicate key on ledger_idem_key_key)'
ROLLBACK TO s;

\echo '── 8. an unknown language must be refused ──'
SAVEPOINT s;
UPDATE player_prefs SET lang='klingon'
 WHERE player_id=(SELECT id FROM players WHERE telegram_id='t-verify');
\echo '   (expect: player_prefs_lang_check)'
ROLLBACK TO s;

\echo '── 9. an oversized prefs blob must be refused (the CHECK I rewrote) ──'
SAVEPOINT s;
UPDATE player_prefs SET auto_skill_off = jsonb_build_object('junk', repeat('x', 600))
 WHERE player_id=(SELECT id FROM players WHERE telegram_id='t-verify');
\echo '   (expect: player_prefs_auto_skill_off_check)'
ROLLBACK TO s;

\echo '── 10. one clan per player, one leader per clan ──'
INSERT INTO clans (name, icon) VALUES ('VerA', 1), ('VerB', 2);
INSERT INTO clan_members (clan_id, player_id, role)
  SELECT (SELECT id FROM clans WHERE name='VerA'), id, 'leader' FROM players WHERE telegram_id='t-verify';
SAVEPOINT s;
INSERT INTO clan_members (clan_id, player_id, role)
  SELECT (SELECT id FROM clans WHERE name='VerB'), id, 'member' FROM players WHERE telegram_id='t-verify';
\echo '   (expect: duplicate key on clan_members_one_clan_key)'
ROLLBACK TO s;

\echo '── 11. one ACTIVE listing per item ──'
INSERT INTO market_listings (seller_id, item_id, price)
  SELECT p.id, i.id, 1 FROM players p JOIN player_items i ON i.player_id=p.id
   WHERE p.telegram_id='t-verify' LIMIT 1;
SAVEPOINT s;
INSERT INTO market_listings (seller_id, item_id, price)
  SELECT p.id, i.id, 2 FROM players p JOIN player_items i ON i.player_id=p.id
   WHERE p.telegram_id='t-verify' LIMIT 1;
\echo '   (expect: duplicate key on market_one_active_per_item)'
ROLLBACK TO s;

\echo '── 12. a sold listing must carry a close time (status/closed_at agree) ──'
SAVEPOINT s;
UPDATE market_listings SET status='sold'
 WHERE seller_id=(SELECT id FROM players WHERE telegram_id='t-verify');
\echo '   (expect: market_closed_ck)'
ROLLBACK TO s;

\echo '── 13. a log row must land in a real partition ──'
INSERT INTO player_logs (player_id, event)
  SELECT id,'verify' FROM players WHERE telegram_id='t-verify';
SELECT '   PASS  logged into ' || tableoid::regclass::text FROM player_logs WHERE event='verify';

ROLLBACK;

\echo ''
\echo '── все відкочено, рядків не лишилось ──'
SELECT CASE WHEN count(*)=0 THEN 'PASS  база чиста' ELSE 'FAIL  лишились рядки' END
  FROM players WHERE telegram_id='t-verify';
