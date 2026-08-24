-- ═══════════════════════════════════════════════════════════════════════════
--  002_social_economy — clans, market, GRAM transactions, logs, world state
-- ═══════════════════════════════════════════════════════════════════════════


CREATE TYPE clan_role_t     AS ENUM ('leader', 'member');
CREATE TYPE listing_status_t AS ENUM ('active', 'sold', 'cancelled');
CREATE TYPE gram_tx_type_t  AS ENUM ('deposit', 'withdraw');
CREATE TYPE gram_tx_status_t AS ENUM ('pending', 'confirmed', 'rejected', 'expired');

-- ── clans ──────────────────────────────────────────────────────────────────
-- Was one document with members/applications/storage/allocations as embedded
-- arrays, saved via clan.save() — a read-modify-write of the whole document,
-- so two members acting at once lost one of the changes (M8 in AUDIT.md).
-- Each array is its own table now, and each operation touches one row.
CREATE TABLE clans (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        citext      NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 10),
  icon        smallint    NOT NULL CHECK (icon BETWEEN 1 AND 30),
  description text        NOT NULL DEFAULT '' CHECK (length(description) <= 200),
  level       smallint    NOT NULL DEFAULT 1 CHECK (level >= 1),
  xp          bigint      NOT NULL DEFAULT 0 CHECK (xp >= 0),
  storage_unlocked boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX clans_xp_idx ON clans (xp DESC);

CREATE TABLE clan_members (
  clan_id   bigint      NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
  player_id bigint      NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  role      clan_role_t NOT NULL DEFAULT 'member',
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clan_id, player_id)
);

-- A player belongs to at most one clan — previously only a convention, and the
-- join path had to check for it by hand across two documents.
CREATE UNIQUE INDEX clan_members_one_clan_key ON clan_members (player_id);
-- Exactly one leader per clan.
CREATE UNIQUE INDEX clan_members_leader_key
  ON clan_members (clan_id) WHERE role = 'leader';

CREATE TABLE clan_applications (
  clan_id    bigint NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
  player_id  bigint NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (clan_id, player_id)
);

-- Clan storage: shard stacks the clan holds collectively.
CREATE TABLE clan_storage (
  clan_id bigint  NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
  item_id text    NOT NULL,
  qty     integer NOT NULL DEFAULT 0 CHECK (qty >= 0),
  PRIMARY KEY (clan_id, item_id)
);

-- Allocations the leader made to a specific member, pending claim.
CREATE TABLE clan_allocations (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clan_id      bigint  NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
  player_id    bigint  NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  item_id      text    NOT NULL,
  qty          integer NOT NULL CHECK (qty > 0),
  allocated_by bigint  REFERENCES players(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX clan_allocations_player_idx ON clan_allocations (player_id);

-- ── market ─────────────────────────────────────────────────────────────────
-- The item is NOT copied into the listing (the old `item: Mixed` field). It is
-- referenced: player_items.player_id goes NULL and item_id points here. That
-- makes "sold but the seller still has it" and "cancelled and the item is
-- gone" both unrepresentable — the row exists exactly once, wherever it is.
CREATE TABLE market_listings (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  seller_id  bigint          NOT NULL REFERENCES players(id),
  buyer_id   bigint          REFERENCES players(id),
  item_id    bigint          NOT NULL REFERENCES player_items(id),
  price      numeric(24,8)   NOT NULL CHECK (price > 0),
  status     listing_status_t NOT NULL DEFAULT 'active',
  created_at timestamptz     NOT NULL DEFAULT now(),
  closed_at  timestamptz,

  CONSTRAINT market_closed_ck
    CHECK ((status = 'active') = (closed_at IS NULL)),
  CONSTRAINT market_buyer_ck
    CHECK (status = 'sold' OR buyer_id IS NULL)
);

-- An item can be in at most one ACTIVE listing. Two concurrent marketList
-- calls for the same item cannot both win.
CREATE UNIQUE INDEX market_one_active_per_item
  ON market_listings (item_id) WHERE status = 'active';
CREATE INDEX market_browse_idx  ON market_listings (status, created_at DESC)
  WHERE status = 'active';
CREATE INDEX market_seller_idx  ON market_listings (seller_id, status);

-- ── gram_tx — real-money requests ──────────────────────────────────────────
-- Adds what the Mongo version had no room for: an on-chain reference and an
-- expiry. A deposit is only creditable once `chain_tx_hash` is filled by the
-- TON indexer and `chain_amount` matches — the admin button becomes a fallback
-- for edge cases rather than the only check that a payment happened.
CREATE TABLE gram_tx (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id     bigint          NOT NULL REFERENCES players(id),
  type          gram_tx_type_t  NOT NULL,
  amount        numeric(24,8)   NOT NULL CHECK (amount > 0),
  status        gram_tx_status_t NOT NULL DEFAULT 'pending',
  address       text,                     -- withdraw destination
  memo          text,                     -- deposit identifier, matched on-chain
  chain_tx_hash text UNIQUE,              -- set by the indexer once seen
  chain_amount  numeric(24,8),            -- what actually arrived
  admin_msg_id  bigint,
  decided_by    text,                     -- 'indexer' | admin telegram id
  created_at    timestamptz     NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  decided_at    timestamptz,

  -- A withdrawal always names a destination; a deposit always names a memo.
  CONSTRAINT gram_tx_shape_ck CHECK (
    (type = 'withdraw' AND address IS NOT NULL) OR
    (type = 'deposit'  AND memo    IS NOT NULL)
  )
);

CREATE INDEX gram_tx_player_idx  ON gram_tx (player_id, created_at DESC);
CREATE INDEX gram_tx_pending_idx ON gram_tx (status, created_at)
  WHERE status = 'pending';
-- Memo must be unique among OPEN deposits, or the indexer cannot tell two
-- players' payments apart.
CREATE UNIQUE INDEX gram_tx_open_memo_key
  ON gram_tx (memo) WHERE type = 'deposit' AND status = 'pending';

-- ── special quests ─────────────────────────────────────────────────────────
CREATE TABLE special_quests (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title       text    NOT NULL,
  description text    NOT NULL DEFAULT '',
  type        text    NOT NULL DEFAULT 'link',
  url         text    NOT NULL DEFAULT '',
  icon        text    NOT NULL DEFAULT '*',
  reward_gold bigint  NOT NULL DEFAULT 0 CHECK (reward_gold  >= 0),
  reward_xp   bigint  NOT NULL DEFAULT 0 CHECK (reward_xp    >= 0),
  reward_nexum numeric(24,8) NOT NULL DEFAULT 0 CHECK (reward_nexum >= 0),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── world state ────────────────────────────────────────────────────────────
CREATE TABLE boss_state (
  floor      integer NOT NULL,
  arm        text    NOT NULL,
  respawn_at timestamptz NOT NULL,
  PRIMARY KEY (floor, arm)
);

CREATE TABLE guild_war_state (
  key             text PRIMARY KEY DEFAULT 'castle',
  owner_clan_id   bigint REFERENCES clans(id) ON DELETE SET NULL,
  captured_at     timestamptz
);

CREATE TABLE chat_messages (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id  bigint REFERENCES players(id) ON DELETE SET NULL,
  username   text   NOT NULL DEFAULT '',
  text       text   NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX chat_messages_recent_idx ON chat_messages (created_at DESC);

CREATE TABLE pvp_history (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id  bigint NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  kind       text   NOT NULL,
  mode       text   NOT NULL,
  opponent   text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX pvp_history_player_idx ON pvp_history (player_id, created_at DESC);

-- ── player_logs — partitioned by month ─────────────────────────────────────
-- The Mongo version needed a hand-written trim ("keep the last N per player",
-- server/player-log.js) that ran on every write past a counter. Partitioning
-- replaces it: retention is DROP PARTITION, which is instant and produces no
-- write amplification at all.
CREATE TABLE player_logs (
  id         bigint GENERATED ALWAYS AS IDENTITY,
  player_id  bigint NOT NULL,
  event      text   NOT NULL,
  meta       jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);

CREATE INDEX player_logs_player_idx ON player_logs (player_id, created_at DESC);

-- A partitioned table with no partitions REJECTS every insert ("no partition of
-- relation \"player_logs\" found for row"), so the first ones are created here
-- rather than left for the first log line to discover in production.
-- ensure_log_partitions() is called by a daily job and is idempotent, so a
-- month boundary can never arrive without a partition waiting for it.
CREATE OR REPLACE FUNCTION ensure_log_partitions(months_ahead integer DEFAULT 2)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  m      date := date_trunc('month', now())::date;
  i      integer;
  part   text;
BEGIN
  FOR i IN 0..months_ahead LOOP
    part := 'player_logs_' || to_char(m + (i || ' month')::interval, 'YYYY_MM');
    IF to_regclass(part) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF player_logs FOR VALUES FROM (%L) TO (%L)',
        part,
        (m + (i     || ' month')::interval)::date,
        (m + (i + 1 || ' month')::interval)::date
      );
    END IF;
  END LOOP;
END;
$fn$;

SELECT ensure_log_partitions(2);

-- Retention is DROP TABLE on an old partition — instant, and it produces none
-- of the write amplification the Mongo version's per-write trim did
-- (server/player-log.js keeps the last N per player by deleting on every Nth
-- insert).
CREATE OR REPLACE FUNCTION drop_old_log_partitions(keep_months integer DEFAULT 6)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  cutoff date := (date_trunc('month', now()) - (keep_months || ' month')::interval)::date;
  r      record;
BEGIN
  FOR r IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_inherits i ON i.inhrelid = c.oid
     WHERE i.inhparent = 'player_logs'::regclass
       AND c.relname ~ '^player_logs_[0-9]{4}_[0-9]{2}$'
       AND to_date(right(c.relname, 7), 'YYYY_MM') < cutoff
  LOOP
    EXECUTE format('DROP TABLE %I', r.relname);
  END LOOP;
END;
$fn$;

