-- ── Clan chat and direct messages ──────────────────────────────────────────
-- Both of these lived in a Map in the server process. Not a cache in front of
-- storage — the Map WAS the storage, so every deploy, crash and restart wiped
-- every conversation in the game, and a player who reconnected to a different
-- process saw an empty history that another player could still read.
--
-- They are also the two places a player writes text that another player reads,
-- which makes them the surface a moderator has to be able to look at after the
-- fact. That is not possible against a Map that no longer exists.

CREATE TABLE clan_chat (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clan_id    bigint NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
  player_id  bigint          REFERENCES players(id) ON DELETE SET NULL,
  username   text   NOT NULL DEFAULT '',
  text       text   NOT NULL CHECK (length(text) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The panel reads the last N of one clan, newest first. Leading with clan_id
-- makes that an index scan over one clan rather than a scan of every clan's
-- history filtered afterwards.
CREATE INDEX clan_chat_recent_idx ON clan_chat (clan_id, id DESC);

-- A conversation between two players, stored ONCE rather than as a row in each
-- of their outboxes. `pair_lo`/`pair_hi` are the two player ids in ascending
-- order, which is what makes "the conversation between A and B" a single
-- indexable value regardless of who is asking — the alternative is an OR
-- across two columns, which no index serves well.
CREATE TABLE direct_messages (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pair_lo    bigint NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  pair_hi    bigint NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  sender_id  bigint NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  username   text   NOT NULL DEFAULT '',
  text       text   NOT NULL CHECK (length(text) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Enforced rather than assumed: a row with the pair the wrong way round
  -- would be invisible to every read, which is the kind of bug that looks like
  -- "messages sometimes disappear".
  CONSTRAINT direct_messages_pair_ordered CHECK (pair_lo < pair_hi),
  CONSTRAINT direct_messages_sender_in_pair CHECK (sender_id IN (pair_lo, pair_hi))
);

CREATE INDEX direct_messages_thread_idx ON direct_messages (pair_lo, pair_hi, id DESC);
