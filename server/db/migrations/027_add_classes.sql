-- ── char_class_t — two new playable classes ─────────────────────────────────
--
-- Рунный боец (runefighter) and Ассасин (assassin) join the five classes
-- players.char_class has accepted since 001_core. Postgres enums can only be
-- widened, never reordered or shrunk in place — ADD VALUE is the whole
-- migration, appended at the end exactly like NC_CHAR_TYPES (shared/
-- netcodec.js) is appended rather than reordered: existing rows and any
-- already-cached wire index stay meaningful.
--
-- ADD VALUE cannot be used in the same transaction that adds it (a Postgres
-- rule, not a choice made here) — this file only adds the values and never
-- references them, so migrate.sh's one-transaction-per-file run is safe.
ALTER TYPE char_class_t ADD VALUE IF NOT EXISTS 'runefighter';
ALTER TYPE char_class_t ADD VALUE IF NOT EXISTS 'assassin';
