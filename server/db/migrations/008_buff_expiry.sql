-- ── Buffs stop being a countdown nobody counts ─────────────────────────────
-- player_progress.buffs held SECONDS REMAINING, and nothing decremented them.
-- expireBuffs() existed, was correct, and was called from exactly one place:
-- its own test. So a buff drunk once lasted forever, and every reload showed
-- the full ten minutes again — which is what players reported, and is also a
-- permanent stat bonus for the price of one potion.
--
-- A countdown is the wrong shape for something that decays with wall-clock
-- time in a system that restarts. It needs a ticker, the ticker has to survive
-- a deploy, and a missed tick is a buff that outlives its welcome. An EXPIRY
-- is a fact: it needs nobody to maintain it, a restart cannot lose it, and the
-- remaining time is a subtraction at read time.
--
-- The wire format stays seconds — the client decrements its own copy every
-- frame to animate the bar — so this changes only what is STORED.
UPDATE player_progress
   SET buffs = COALESCE((
         SELECT jsonb_object_agg(
                  k,
                  to_jsonb((EXTRACT(EPOCH FROM now()) * 1000)::bigint + v * 1000))
           FROM jsonb_each_text(buffs) AS e(k, val),
                LATERAL (SELECT GREATEST(0, (val)::numeric)::bigint AS v) AS c
          WHERE v > 0
       ), '{}'::jsonb)
 WHERE buffs <> '{}'::jsonb
   -- Only rows still in the OLD shape. A timestamp is a 13-digit number; a
   -- countdown is at most four. Re-running this migration must not push every
   -- live buff a thousand years into the future.
   AND EXISTS (
     SELECT 1 FROM jsonb_each_text(buffs) AS e(k, val)
      WHERE (val)::numeric < 100000000000
   );
