-- ── player_skills.foreign_class — the fifth, independent skill slot ────────
--
-- A legendary-rune-reroll jackpot book (RUNE_REROLL_BONUS_SKILL_CHANCE, 3%,
-- shared/definitions.js) can be learned into a slot of its OWN — it never
-- touches the player's real Q/W/E/R. One row: kind='foreign', key = the
-- Q/W/E/R that ability is WITHIN its own class, level = 1..10 like any
-- other skill, and this column names which class it actually belongs to.
--
-- Exactly one such row per account. Learning a different jackpot book
-- REPLACES it — repos/players.js's setForeignSkill deletes the old kind=
-- 'foreign' row before inserting the new one — there is no second slot to
-- stack into.
--
-- No advanced ("вторая профессия") variant for this slot: the jackpot only
-- ever grants BASE skill books (_SKILL_BOOK_SRC, never _ADV_SKILL_BOOK_SRC),
-- so adv_learned/adv_active rows are never written for kind='foreign'.
ALTER TABLE player_skills
  ADD COLUMN IF NOT EXISTS foreign_class char_class_t;

ALTER TABLE player_skills
  DROP CONSTRAINT IF EXISTS player_skills_foreign_class_ck;
ALTER TABLE player_skills
  ADD CONSTRAINT player_skills_foreign_class_ck
    CHECK ((kind = 'foreign') = (foreign_class IS NOT NULL));

COMMENT ON COLUMN player_skills.foreign_class IS
  'Only for kind=''foreign'': which class the fifth slot''s ability actually belongs to — the legendary-rune-reroll jackpot (learnForeignSkill). This row''s own key is that class''s Q/W/E/R.';
