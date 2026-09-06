-- ── VIP: deposited floor for levels granted under the old per-level formula ─
--
-- addVipSpend used to compare the lifetime `deposited` total directly against
-- VIP_THRESHOLDS[i] — a per-level GRAM delta, not a running total (fixed by
-- the VIP_CUMULATIVE change in server/db/repos/progression.js). Under that
-- bug, `level` could reach a tier the player's actual lifetime deposit never
-- earns under the corrected formula: e.g. deposited=200 old-formula reached
-- level 8 (200 >= VIP_THRESHOLDS[8]=200), but VIP_CUMULATIVE[8]=541 — the
-- account's `deposited` was left at 200, thirty percent of what level 8
-- actually costs.
--
-- That gap is invisible until the VIP panel's progress bar reads it: progress
-- toward the next level is `deposited - VIP_CUMULATIVE[level]` (js/ui.js
-- renderVipPanel), clamped at 0 so it never goes negative. For every account
-- the old formula over-leveled, that subtraction IS negative, so the bar
-- reads 0 / needed — indistinguishable, to the player, from having the whole
-- counter wiped. They did not lose anything: `level` and any items already
-- claimed from `pending` are untouched by this migration. What was wrong is
-- `deposited` being lower than what a real player at that level would show,
-- because it was never asked to cover a level the old bug handed out early.
--
-- The fix is additive only, in the direction that matches what already
-- happened: raise `deposited` up to the floor its OWN `level` implies
-- (VIP_CUMULATIVE[level]), never down, and never touching `level` itself —
-- downgrading `level` would claw back a status (and bonuses) already granted
-- for no gain, since any items behind it are already sitting in inventory.
-- The WHERE guard means an account whose deposited already meets or exceeds
-- its level's floor (i.e. was never affected by the old bug) is left alone.
UPDATE player_vip
   SET deposited = v.floor, updated_at = now()
  FROM (VALUES
    (0::smallint, 0::numeric), (1, 1), (2, 6), (3, 16), (4, 41), (5, 91),
    (6, 191), (7, 341), (8, 541), (9, 841), (10, 1341)
  ) AS v(level, floor)
 WHERE player_vip.level = v.level
   AND player_vip.deposited < v.floor;
