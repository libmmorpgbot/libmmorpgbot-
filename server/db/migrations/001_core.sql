-- ═══════════════════════════════════════════════════════════════════════════
--  001_core — identity, progression, items, money
-- ═══════════════════════════════════════════════════════════════════════════
-- Replaces the single `players.savedData` Mixed blob (server/models/Player.js).
--
-- Three rules this schema exists to enforce, each of which was previously a
-- convention the application had to remember:
--
--   1. An item is a ROW with an owner, not an element of an array inside a
--      document. Moving one is an UPDATE of one row inside a transaction, so
--      "the account reconnected on a different socket during the two awaits"
--      (handlers/market.js) stops being a case anyone has to handle.
--   2. Money is `numeric`, never a float, and never negative — CHECK does
--      that, not a code path. Every movement writes a ledger row in the same
--      transaction, so a balance can be RECONCILED. Today it cannot: there is
--      nothing to compare it against.
--   3. A field is server-owned unless it appears in `player_prefs`. The old
--      model was the reverse — a blob where anything not explicitly stripped
--      was client-authored, which is how vipPending, seasonTicket and
--      specialQuestsDone each became an exploit before someone remembered to
--      add a `delete`.


-- citext is the only extension this schema needs. It gives username equality
-- that ignores case at the TYPE level, which is what retires the Mongo-side
-- workaround: _resolveUsername had to pair a collation index with a matching
-- .collation() on every single query, and forgetting it on one call site
-- silently turned that query into a full collection scan.
--
-- pgcrypto is deliberately NOT required. It was here for gen_random_uuid(),
-- which (a) has been built into PostgreSQL since 13 and needs no extension,
-- and (b) is unused anyway: every key in this schema is a bigint identity.
-- See the ledger's idem_key, which is a semantic string composed by the
-- caller ('market_buy:<listing>:<buyer>'), not a random id — the whole point
-- is that a retry of the SAME operation produces the SAME key.
CREATE EXTENSION IF NOT EXISTS citext;

-- ── Enums ──────────────────────────────────────────────────────────────────
CREATE TYPE currency_t      AS ENUM ('gold', 'gram', 'nexum');
CREATE TYPE item_container_t AS ENUM ('inventory', 'equipment', 'storage');
CREATE TYPE char_class_t    AS ENUM ('lev', 'deathknight', 'ranger', 'mage', 'warlock');
CREATE TYPE skill_kind_t    AS ENUM ('skill', 'passive', 'adv_learned', 'adv_active');

-- ── players — identity only ────────────────────────────────────────────────
-- Everything that is NOT progression. Kept narrow deliberately: this row is
-- read on every login and joined from clans/market/ledger, so it stays hot and
-- small.
CREATE TABLE players (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  telegram_id    text        NOT NULL UNIQUE,
  username       citext      NOT NULL,
  -- Battle Power. Denormalised from progression because the leaderboard sorts
  -- by it on every request; recomputed by the app whenever stats change.
  bm             integer     NOT NULL DEFAULT 0,
  referred_by    text,                      -- telegram_id of the referrer
  banned         boolean     NOT NULL DEFAULT false,
  admin_notified boolean     NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- citext already makes this case-insensitive, which is what the old Mongo
-- collation index was working around — _resolveUsername can now be a plain
-- equality match with no special-casing at the call site.
CREATE UNIQUE INDEX players_username_key ON players (username);
CREATE INDEX players_bm_idx              ON players (bm DESC);
CREATE INDEX players_referred_by_idx     ON players (referred_by) WHERE referred_by IS NOT NULL;

-- ── player_progress — 1:1, the server-owned character ───────────────────────
-- Every column here is written ONLY by the server. There is no path by which a
-- client blob reaches this table: the save handler will map named fields, and
-- an unknown key is an error rather than a passthrough.
CREATE TABLE player_progress (
  player_id     bigint PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  char_class    char_class_t,                -- NULL until the player picks one
  lvl           integer NOT NULL DEFAULT 1  CHECK (lvl  BETWEEN 1 AND 1000),
  xp            bigint  NOT NULL DEFAULT 0  CHECK (xp   >= 0),
  kills         bigint  NOT NULL DEFAULT 0  CHECK (kills >= 0),
  hp            integer NOT NULL DEFAULT 100 CHECK (hp  >= 0),

  -- Skill points. bonus_sp is what rebirth/shop granted; kept_sp is the part
  -- already committed to upgrades that a rebirth preserves (see the keptSP
  -- split in handlers/auth.js). Both bounded so the app's budget check has a
  -- floor under it.
  bonus_sp      integer NOT NULL DEFAULT 0 CHECK (bonus_sp >= 0),
  kept_sp       integer NOT NULL DEFAULT 0 CHECK (kept_sp  >= 0),
  rebirths      integer NOT NULL DEFAULT 0 CHECK (rebirths >= 0),

  -- Stat upgrades bought with skill points. Six known keys, each bounded —
  -- a jsonb map here would reintroduce "any key the client sends".
  upg_atk         integer NOT NULL DEFAULT 0 CHECK (upg_atk        >= 0),
  upg_def         integer NOT NULL DEFAULT 0 CHECK (upg_def        >= 0),
  upg_hp          integer NOT NULL DEFAULT 0 CHECK (upg_hp         >= 0),
  upg_crit_chance integer NOT NULL DEFAULT 0 CHECK (upg_crit_chance>= 0),
  upg_crit_power  integer NOT NULL DEFAULT 0 CHECK (upg_crit_power >= 0),
  upg_atk_speed   integer NOT NULL DEFAULT 0 CHECK (upg_atk_speed  >= 0),
  upg_hp_regen    integer NOT NULL DEFAULT 0 CHECK (upg_hp_regen   >= 0),

  -- Where the player was standing. Restored on reconnect, re-checked against
  -- level gates by the app (see _restoreFloorFor) — stored, never trusted.
  floor         integer NOT NULL DEFAULT 1,
  pos_x         real,
  pos_y         real,

  -- Quest chain: the index of the active quest and its per-enemy kill tally.
  -- questKills is genuinely dynamic (keys are enemy species ids from the
  -- catalog), so jsonb is right here — but it is SERVER-written only.
  quest_idx     integer NOT NULL DEFAULT 0 CHECK (quest_idx >= 0),
  quest_kills   jsonb   NOT NULL DEFAULT '{}'::jsonb,

  -- Timed buffs: buffType -> seconds remaining. Server-written (usePotion).
  buffs         jsonb   NOT NULL DEFAULT '{}'::jsonb,
  -- HP potions: potionId -> count. Spent by the server's usePotion handler.
  potion_bag    jsonb   NOT NULL DEFAULT '{}'::jsonb,
  -- Кодекс set progress. Server-written (registerCodexSetItem).
  codex         jsonb   NOT NULL DEFAULT '{}'::jsonb,

  starter_bonus_claimed boolean NOT NULL DEFAULT false,

  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ── player_prefs — the ONLY client-authored surface ─────────────────────────
-- Display preferences with no effect on the economy or combat. Everything the
-- client may write lives here and nowhere else; the save handler writes this
-- table from an explicit allow-list and rejects unknown keys outright.
CREATE TABLE player_prefs (
  player_id       bigint PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  lang            text    NOT NULL DEFAULT 'ru'
                    CHECK (lang IN ('ru','en','uk','es','tr','pt')),
  hud_potion      text,
  auto_hp_pct     real    NOT NULL DEFAULT 0.5 CHECK (auto_hp_pct BETWEEN 0 AND 1),
  auto_skills_on  boolean NOT NULL DEFAULT true,
  -- Small bounded maps: which Q/W/E/R slots are opted out of auto-cast, and
  -- which buff types auto-redrink. Shape validated by the app; size bounded
  -- here so a junk payload cannot be stored at all.
  --
  -- length(x::text), not pg_column_size(x): pg_column_size is marked STABLE,
  -- and PostgreSQL refuses a non-IMMUTABLE function inside a CHECK constraint
  -- ("functions in check constraint must be marked IMMUTABLE"). The jsonb->text
  -- cast and length() are both immutable, so this form is accepted and bounds
  -- the same thing.
  auto_skill_off  jsonb   NOT NULL DEFAULT '{}'::jsonb
                    CHECK (length(auto_skill_off::text)  < 512),
  auto_buff_types jsonb   NOT NULL DEFAULT '{}'::jsonb
                    CHECK (length(auto_buff_types::text) < 512),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ── player_items — an item is a row ────────────────────────────────────────
-- This table is the whole reason for the migration. Compare with what it
-- replaces: an array inside the player document, rewritten wholesale on every
-- change, which is why _itemOpBusy / _econBusy / _commitServerItems /
-- _grantMarketItem / _takeMarketItem exist at all.
--
-- A market sale is now: UPDATE player_items SET player_id = $buyer WHERE id = $1.
-- One row, inside a transaction. It cannot half-happen.
CREATE TABLE player_items (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- NULL while the item sits in an active market listing: it belongs to the
  -- listing, not to a player. That is what makes "listed but still in the
  -- seller's inventory" (the old duplication bug) unrepresentable.
  player_id  bigint REFERENCES players(id) ON DELETE CASCADE,
  container  item_container_t,
  -- Equipment slot name ('weapon', 'helm', ...) for container='equipment';
  -- NULL otherwise.
  slot       text,
  item_id    text     NOT NULL,      -- catalog id (ITEM_DEF/CRAFT_MATS/BOX_DEF)
  enhance    smallint NOT NULL DEFAULT 0 CHECK (enhance BETWEEN 0 AND 20),
  qty        integer  NOT NULL DEFAULT 1 CHECK (qty >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),

  -- An item is either owned by a player (with a container) or held by a
  -- listing (neither) — never half of each.
  CONSTRAINT player_items_owned_ck
    CHECK ((player_id IS NULL) = (container IS NULL)),
  -- A slot name belongs to equipment and only to equipment.
  CONSTRAINT player_items_slot_ck
    CHECK ((container = 'equipment') = (slot IS NOT NULL))
);

CREATE INDEX player_items_owner_idx ON player_items (player_id, container)
  WHERE player_id IS NOT NULL;

-- One item per equipment slot, enforced by the database. The old model could
-- represent two weapons equipped at once; this cannot.
CREATE UNIQUE INDEX player_items_equip_slot_key
  ON player_items (player_id, slot) WHERE container = 'equipment';

-- ── balances + ledger — money ──────────────────────────────────────────────
-- amount is numeric, not double precision. GRAM drops are 0.0000001 each and
-- the old float accumulator drifted ~1e-10 over thousands of kills (there is a
-- comment in server/index.js acknowledging it). numeric does not drift.
CREATE TABLE balances (
  player_id bigint      NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  currency  currency_t  NOT NULL,
  amount    numeric(24,8) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, currency)
);

-- Append-only. Never UPDATE, never DELETE (enforced in 002 by a rule/grant).
-- balance_after is written by the same statement that moved the money, so a
-- reconciliation job can check BOTH invariants:
--   sum(delta) per (player, currency)  ==  balances.amount
--   every row's balance_after          ==  running sum up to that row
CREATE TABLE ledger (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id     bigint      NOT NULL REFERENCES players(id),
  currency      currency_t  NOT NULL,
  delta         numeric(24,8) NOT NULL CHECK (delta <> 0),
  balance_after numeric(24,8) NOT NULL CHECK (balance_after >= 0),
  reason        text        NOT NULL,   -- 'mob_drop','market_buy','vip_claim',...
  ref_type      text,                   -- 'market_listing','gram_tx','clan',...
  ref_id        text,
  -- Idempotency. A retried handler (a lost ack, a reconnect mid-operation)
  -- reuses the same key and the UNIQUE index turns the second attempt into a
  -- no-op instead of a double credit. This is what replaces the hand-written
  -- "did this already run?" checks scattered through the money handlers.
  idem_key      text UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ledger_player_idx ON ledger (player_id, currency, id DESC);
CREATE INDEX ledger_created_idx ON ledger (created_at DESC);

-- ── player_skills — studied progression ────────────────────────────────────
-- Rows rather than four jsonb maps (skillLevels / passiveLevels /
-- advSkillLearned / advSkillActive). The level bound lives in the database, so
-- "a save claiming max levels" is not a shape the table can hold.
CREATE TABLE player_skills (
  player_id bigint      NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  kind      skill_kind_t NOT NULL,
  key       text        NOT NULL,          -- 'Q'/'W'/'E'/'R' or a passive id
  level     smallint    NOT NULL DEFAULT 0 CHECK (level BETWEEN 0 AND 99),
  PRIMARY KEY (player_id, kind, key)
);

-- ── player_vip ─────────────────────────────────────────────────────────────
-- Was three fields inside savedData that a crafted save could set outright
-- (vipLevel/vipDeposited/vipPending) — the exploit that handed out every VIP
-- tier's items for free. Its own table now, written only by the purchase and
-- claim paths.
CREATE TABLE player_vip (
  player_id bigint PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  level     smallint      NOT NULL DEFAULT 0 CHECK (level >= 0),
  deposited numeric(24,8) NOT NULL DEFAULT 0 CHECK (deposited >= 0),
  -- Tiers earned but not yet claimed. smallint[] rather than jsonb: a fixed
  -- element type means "vipPending.0 = 10" is not even a well-typed write.
  pending   smallint[]    NOT NULL DEFAULT '{}',
  season_ticket boolean   NOT NULL DEFAULT false,
  updated_at timestamptz  NOT NULL DEFAULT now()
);

-- ── player_season ──────────────────────────────────────────────────────────
-- Keyed by season number so a new season needs no new column (Season 2 needed
-- `seasonPoints2` precisely because Season 1's field could not be reused).
CREATE TABLE player_season (
  player_id bigint   NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  season    smallint NOT NULL,
  points    bigint   NOT NULL DEFAULT 0 CHECK (points >= 0),
  tier      smallint NOT NULL DEFAULT 0,
  boss_paid boolean  NOT NULL DEFAULT false,
  ref_paid  boolean  NOT NULL DEFAULT false,
  quests    jsonb    NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (player_id, season)
);

CREATE INDEX player_season_board_idx
  ON player_season (season, points DESC) WHERE points > 0;

-- ── player_special_quests — the once-only claim ────────────────────────────
-- Was `specialQuestsDone: []` inside the client-writable blob, so omitting an
-- id re-opened its reward. A row that exists is a claim that happened.
CREATE TABLE player_special_quests (
  player_id  bigint NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  quest_id   bigint NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, quest_id)
);

-- ── player_daily — per-day attempt counters ────────────────────────────────
-- Fear/Coop/Arena/Race attempts were a non-atomic read-modify-write on the
-- blob. A row per (player, day, mode) with an atomic UPSERT cannot lose a
-- decrement to a concurrent one.
CREATE TABLE player_daily (
  player_id bigint NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  day       date   NOT NULL,
  mode      text   NOT NULL,          -- 'fear','coop','arena3','race10','farm2'
  used      integer NOT NULL DEFAULT 0 CHECK (used >= 0),
  seconds   integer NOT NULL DEFAULT 0 CHECK (seconds >= 0),  -- farm2 minutes budget
  PRIMARY KEY (player_id, day, mode)
);

