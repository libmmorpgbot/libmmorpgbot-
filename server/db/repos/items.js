'use strict';
// ── Items ───────────────────────────────────────────────────────────────────
// An item is a ROW WITH AN OWNER. That single change is what closes the whole
// family of "предмет пропал" reports, so it is worth being precise about what
// it replaces.
//
// In the Mongo version an item was an element of an array inside the player
// document, and every operation rewrote the whole array. Two consequences, and
// both of them shipped as bugs:
//
//   * a listing removed the item from the seller's array and wrote the array
//     back — but if the account had reconnected on a different socket in the
//     meantime, that write landed on a stale copy and the item existed in two
//     places, or in none. handlers/market.js carries five separate branches
//     for this, each with its own recovery path.
//   * "sold" and "still in the inventory" were two independent facts that
//     could disagree, because nothing tied them together.
//
// Here the row exists exactly once. Selling it is `UPDATE player_items SET
// player_id = <buyer>`. There is no copy to go stale, no second place for it
// to be, and no state where it is in both or neither — the database cannot
// represent one. player_items_owned_ck rejects a row that has an owner but no
// container, and market_one_active_per_item rejects a second live listing.
//
// The rule for every mutating function here: it takes `db` and that db MUST be
// a transaction client, not the pool. Adding an item is a slot check plus an
// insert; without a transaction those are two statements a concurrent grant
// can land between, and the 150-slot cap becomes a suggestion.

const { query, hasColumn } = require('../index');
const { SERVER_INV_MAX } = require('../../anticheat');
const { ITEM_DEF, CRAFT_MATS, BOX_DEF, ENHANCEABLE_SLOTS, isStackableItem } =
  require('../../../shared/definitions');

// ── syncCatalog ─────────────────────────────────────────────────────────────
// Projects shared/definitions.js into item_catalog so the foreign keys have
// something to point at. Runs at boot, before anything can grant an item.
//
// Retiring an id sets active=false rather than deleting the row: items players
// already own must keep resolving forever, and the FK would refuse the delete
// anyway. That refusal is the feature — it is what stops a catalog edit from
// silently destroying everyone's copies.
async function syncCatalog(db) {
  const all = [...ITEM_DEF, ...CRAFT_MATS, ...BOX_DEF];
  const ids = all.map(d => d.id);
  const slots = all.map(d => d.slot || 'material');
  const stack = all.map(d => !!isStackableItem(d));
  const enh = all.map(d => ENHANCEABLE_SLOTS.has(d.slot));
  const rar = all.map(d => d.rarity || null);
  const names = all.map(d => String(d.name || ''));

  await query(db, `
    INSERT INTO item_catalog (item_id, slot, stackable, enhanceable, rarity, name)
    SELECT * FROM unnest($1::text[], $2::text[], $3::bool[], $4::bool[], $5::text[], $6::text[])
    ON CONFLICT (item_id) DO UPDATE SET
      slot = EXCLUDED.slot, stackable = EXCLUDED.stackable,
      enhanceable = EXCLUDED.enhanceable, rarity = EXCLUDED.rarity,
      name = EXCLUDED.name, active = true, synced_at = now()
  `, [ids, slots, stack, enh, rar, names]);

  // Anything in the table that this build no longer knows about is retired,
  // not removed — see the comment above.
  const { rowCount } = await query(db,
    `UPDATE item_catalog SET active = false
      WHERE active AND item_id <> ALL($1::text[])`, [ids]);
  return { synced: ids.length, retired: rowCount };
}

// ── lockPlayer ──────────────────────────────────────────────────────────────
// Serialises every item operation for ONE account, and nothing else.
//
// The 150-slot cap is a count followed by an insert, and without this two
// grants arriving together both read 149 and both insert. Row-level, so two
// different players never wait on each other: contention only happens where it
// is wanted, between concurrent operations on the same inventory.
//
// Must be the FIRST statement of any transaction that mutates items, so every
// path takes the lock in the same order and there is no lock cycle to
// deadlock on.
async function lockPlayer(db, playerId) {
  const { rows } = await query(db, 'SELECT id FROM players WHERE id = $1 FOR UPDATE', [playerId]);
  if (!rows.length) throw new Error(`items: no player ${playerId}`);
}

// ── reads ───────────────────────────────────────────────────────────────────

function _row(r) {
  return {
    rowId: Number(r.id),
    id: r.item_id,
    enhance: r.enhance,
    qty: r.qty,
    slot: r.slot || undefined,
    container: r.container,
  };
}

// Everything the account holds, split the way the client expects it. One query
// rather than three: the containers differ by a column, and three round trips
// to answer one question is three chances for them to disagree.
async function inventoryOf(db, playerId) {
  const { rows } = await query(db, `
    SELECT id, container, slot, item_id, enhance, qty
      FROM player_items
     WHERE player_id = $1
     ORDER BY id`, [playerId]);
  const out = { inventory: [], equipment: {}, storage: [] };
  for (const r of rows) {
    if (r.container === 'equipment') out.equipment[r.slot] = _row(r);
    else out[r.container].push(_row(r));
  }
  return out;
}

// Slots used, not items held: a stack of 5000 shards is ONE slot. This is the
// number the 150 cap is about, and computing it any other way is how an
// account ends up over the cap with the client's invHasSpace() permanently
// false — at which point world drops stop being picked up and market
// cancellations start failing.
async function usedSlots(db, playerId) {
  const { rows } = await query(db,
    `SELECT count(*)::int n FROM player_items
      WHERE player_id = $1 AND container = 'inventory'`, [playerId]);
  return rows[0].n;
}

// Would `itemId` fit? A stackable that already has a stack needs no slot; one
// WITHOUT a stack needs a slot exactly like anything else.
//
// That second half is the bug this replaces: the old check was "not stackable
// AND inventory full", which let a stackable through when there was no
// existing stack to merge into — so the GRAM was spent, the listing cancelled,
// and the item then dropped on the way in.
async function hasRoomFor(db, playerId, itemId) {
  const { rows } = await query(db, `
    SELECT
      (SELECT stackable FROM item_catalog WHERE item_id = $2) AS stackable,
      EXISTS (SELECT 1 FROM player_items
               WHERE player_id = $1 AND container = 'inventory' AND item_id = $2) AS has_stack,
      (SELECT count(*) FROM player_items
        WHERE player_id = $1 AND container = 'inventory') AS used`,
    [playerId, itemId]);
  const r = rows[0];
  if (r.stackable === null) return false;              // not a real item
  if (r.stackable && r.has_stack) return true;         // merges, costs no slot
  return Number(r.used) < SERVER_INV_MAX;
}

// ── writes ──────────────────────────────────────────────────────────────────

// Puts an item in the inventory. Returns the row id, or null when there was no
// room — never a partial result and never a throw for the ordinary "inventory
// full" case, which callers must handle rather than log.
//
// Refuses rather than overflowing. _dbPushInventory in the old code pushed
// past the cap deliberately ("dropping an item the player has already paid for
// is the one outcome worse than an oversized inventory") and logged it loudly.
// That trade only existed because delivery could not be part of the same
// transaction as the payment. It can be now, so the caller can refuse the
// whole trade instead and nobody is left over the cap.
async function add(db, playerId, itemId, { enhance = 0, qty = 1, source = null, sourceRef = null } = {}) {
  const { rows: cat } = await query(db,
    'SELECT stackable, enhanceable FROM item_catalog WHERE item_id = $1 AND active', [itemId]);
  if (!cat.length) throw new Error(`items: unknown or retired item id ${itemId}`);
  const enh = cat[0].enhanceable ? Math.max(0, Math.min(15, Math.floor(enhance) || 0)) : 0;

  if (cat[0].stackable) {
    // Merge into the existing stack if there is one. `RETURNING` tells us
    // whether that happened without a second query to look first.
    const { rows: merged } = await query(db, `
      UPDATE player_items SET qty = qty + $3
       WHERE id = (SELECT id FROM player_items
                    WHERE player_id = $1 AND container = 'inventory' AND item_id = $2
                    ORDER BY id LIMIT 1)
      RETURNING id`, [playerId, itemId, qty]);
    if (merged.length) {
      // The merge is the case a row-lifecycle ledger cannot see — no row is
      // created, an existing one simply grows. It is recorded here exactly like
      // an insert, which is the whole argument for counting quantities.
      await ledger(db, playerId, itemId, qty,
        { rowId: Number(merged[0].id), reason: source || 'unknown', refType: 'source', refId: sourceRef });
      return Number(merged[0].id);
    }
  }

  if (await usedSlots(db, playerId) >= SERVER_INV_MAX) return null;

  // ── provenance ───────────────────────────────────────────────────────────
  // This is the only INSERT of a player item in the whole live server, so it
  // is the only place that can answer "where did this come from" — and until
  // migration 011 it had nowhere to write the answer. money.reconcile() can
  // prove currency integrity nightly because every movement leaves a ledger
  // row; items had no equivalent, so the guarantee rested on code review.
  //
  // Asked of the schema once rather than assumed, so the deploy order between
  // this code and its migration cannot break a grant. Before the migration the
  // old statement runs and nothing is recorded; after it, everything is.
  let rowId;
  if (await _hasSourceCols(db)) {
    const { rows } = await query(db, `
      INSERT INTO player_items (player_id, container, item_id, enhance, qty, source, source_ref)
      VALUES ($1, 'inventory', $2, $3, $4, $5, $6) RETURNING id`,
      [playerId, itemId, enh, qty, source || null, sourceRef == null ? null : String(sourceRef).slice(0, 80)]);
    rowId = Number(rows[0].id);
  } else {
    const { rows } = await query(db, `
      INSERT INTO player_items (player_id, container, item_id, enhance, qty)
      VALUES ($1, 'inventory', $2, $3, $4) RETURNING id`,
      [playerId, itemId, enh, qty]);
    rowId = Number(rows[0].id);
  }
  // The reason IS the provenance label 011 already defined ('kill', 'craft',
  // 'box', …) rather than a second vocabulary meaning the same things. Every
  // one of the seventeen call sites already passes it, so the creation half of
  // the ledger needed no change at any of them — and the column and the ledger
  // row can never describe the same grant differently.
  await ledger(db, playerId, itemId, qty,
    { rowId, reason: source || 'unknown', refType: 'source', refId: sourceRef });
  return rowId;
}

// Does player_items carry the provenance columns yet? Asked once per process.
// A failure here means "no" rather than an exception: a logging column must
// never be able to refuse a grant.
let _srcCols = null;
async function _hasSourceCols(db) {
  if (_srcCols !== null) return _srcCols;
  try {
    const { rows } = await query(db, `
      SELECT 1 FROM information_schema.columns
       WHERE table_name = 'player_items' AND column_name = 'source' LIMIT 1`);
    _srcCols = rows.length > 0;
  } catch {
    _srcCols = false;
  }
  return _srcCols;
}

// ── the item ledger ─────────────────────────────────────────────────────────
// The append-only record of every quantity movement, and the item half of what
// repos/money.js does for currency. See migration 012 for the shape and for
// why it counts QUANTITIES rather than row lifecycles; the short version is
// that a stackable is duplicated by `qty + n`, which creates no row for a
// lifecycle ledger to notice.
//
// The invariant it buys: for every account and every catalog item, the sum of
// every delta here equals the quantity that account holds. reconcile() below
// is that sentence as one query.
//
// ── ordering, and why a failure here takes the grant down with it ───────────
// This is called AFTER the item write and INSIDE the same transaction, and
// both halves of that are deliberate.
//
// After, because qty_after is read from player_items — it is the quantity the
// account holds once the movement has been applied, and asking before would
// record the previous state as the new one.
//
// Inside, because the alternative is a grant that succeeded with no record of
// itself. If this INSERT raises, the exception propagates, tx() rolls back,
// and the item is not granted either. That is the right way round: an item
// nobody can account for is the exact thing this table exists to make
// impossible, so "the item exists and the ledger does not know" must not be a
// reachable state. A player seeing an error they can retry is a far better
// outcome than an item that reconcile() will alarm on every night from now on.
//
// The one exception is the schema probe below, and it is not a silent one.
let _ledgerCols = null;
let _ledgerWarned = false;
async function _hasLedger() {
  if (_ledgerCols !== null) return _ledgerCols;
  try {
    // hasColumn asks on the POOL, not on the caller's transaction — which
    // matters more here than it looks. A statement that raises inside a
    // transaction poisons it (25P02 on everything after), so a probe run on
    // the caller's client would turn "the table is missing" into a failed
    // player action. On the pool it cannot touch them.
    _ledgerCols = await hasColumn('item_ledger', 'delta');
  } catch {
    // A probe that cannot answer means "no", never an exception: deciding
    // whether the ledger exists must not be a way for an item grant to fail.
    _ledgerCols = false;
  }
  if (!_ledgerCols && !_ledgerWarned) {
    _ledgerWarned = true;
    // Once per process, not once per grant: this is a condition, not an event,
    // and a line per item handed out would bury the log it is meant to warn in.
    // Loud all the same — while this prints, nothing is proving that items are
    // conserved, and an operator has to be able to see that from the journal.
    console.warn('[items] item_ledger отсутствует — миграция 012 не применена;'
      + ' движения предметов НЕ записываются и сверка невозможна');
  }
  return _ledgerCols;
}

// One movement. `delta` is signed: positive when the account gains, negative
// when it loses. Callers pass the row id where the movement is about one
// identifiable row, which is what keeps "what happened to this Excalibur"
// answerable after the row is deleted.
async function ledger(db, playerId, itemId, delta, { rowId = null, reason, refType = null, refId = null, idemKey = null } = {}) {
  if (!playerId || !itemId || !Number.isFinite(delta) || delta === 0) return false;
  if (!reason) throw new Error('items.ledger: reason is required — see migration 012');
  if (!await _hasLedger()) return false;
  try {
    // qty_after is computed by this statement rather than passed in, so it
    // cannot disagree with what the table actually holds — the same reason
    // money.js takes balance_after from the UPDATE's own RETURNING instead of
    // recomputing it in JavaScript. Every container counts: an equipped sword
    // is one the account holds.
    await query(db, `
      INSERT INTO item_ledger (player_id, row_id, item_id, delta, qty_after, reason, ref_type, ref_id, idem_key)
      SELECT $1::bigint, $2::bigint, $3::text, $4::int,
             COALESCE((SELECT sum(qty) FROM player_items
                        WHERE player_id = $1::bigint AND item_id = $3::text), 0)::int,
             $5::text, $6::text, $7::text, $8::text`,
      [playerId, rowId, itemId, Math.trunc(delta), reason, refType,
        refId == null ? null : String(refId).slice(0, 80),
        idemKey == null ? null : String(idemKey).slice(0, 200)]);
    return true;
  } catch (err) {
    // Named before it is rethrown. Without this the operator sees whatever the
    // handler makes of a rolled-back transaction — "Ошибка сервера" — and no
    // indication that the ledger was what refused, which is the one fact that
    // explains why an otherwise ordinary grant stopped working.
    console.error(`[items] ledger write failed (${reason} ${itemId} ${delta} for ${playerId}):`, err.message);
    throw err;
  }
}

// Takes `qty` units off the player's inventory, across as many rows as it
// needs, and returns true ONLY when the full amount was taken. A partial take
// is not a success — treating it as one is how a craft consumes three of a
// material the player had two of.
//
// Draining ACROSS ROWS is the correction that matters. The first version took
// from one row (`ORDER BY id LIMIT 1`), which is right for a stackable — but a
// non-stackable is one row per copy, so "give me two enhanced swords" found no
// single row holding two and reported "not enough" to a player holding four.
// Every gear recipe asks for n:2 of a non-stackable, so every gear recipe was
// unreachable. The test missed it because the fixture granted qty:2 in ONE row
// — a shape `add()` never produces for a non-stackable and the game therefore
// never has.
//
// Two ways to name an enhancement, and they are not interchangeable:
//   enhance     exact — "this row's item", for selling a specific copy
//   minEnhance  at least — what a recipe means by minEnhance: 8
// The recipes were counted with `>=` and consumed with no filter at all, so a
// player with two +8 and five +0 passed the check and paid with the +0 copies,
// keeping the enhanced ones. That is a craft at a fraction of its price.
//
// Lowest qualifying enhancement goes first. When +8 will do, the +12 stays in
// the bag — the alternative silently eats work the player paid for.
//
// Nothing is taken unless everything can be: `plan` is empty when the total
// falls short, so the caller gets false and an untouched inventory rather than
// a half-consumed one.
async function removeQty(db, playerId, itemId, qty = 1, { enhance = null, minEnhance = null, reason = 'consume', refType = null, refId = null } = {}) {
  // A row a past trade still names cannot be deleted while the reference
  // blocks (see assertDestroyable). Such a row is left out of the pool
  // entirely rather than drained part-way, because a plan that ends in
  // `take >= qty` on it would raise 23503 and roll the caller's whole
  // transaction back — refunding whatever it had already spent. Once
  // migration 010 makes the reference releasable this is never true.
  const guard = await marketRefBlocksDelete(db);
  const { rows } = await query(db, `
    WITH pool AS (
      SELECT id, qty, enhance FROM player_items pi
       WHERE player_id = $1 AND container = 'inventory' AND item_id = $2
         AND ($4::int IS NULL OR enhance = $4::int)
         AND ($5::int IS NULL OR enhance >= $5::int)
         AND ($6::bool = false OR NOT EXISTS (
               SELECT 1 FROM market_listings m WHERE m.item_id = pi.id))
    ),
    avail AS (SELECT COALESCE(sum(qty), 0)::int AS total FROM pool),
    ranked AS (
      SELECT id, qty,
             COALESCE(sum(qty) OVER (ORDER BY enhance, id
               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)::int AS taken_before
        FROM pool
    ),
    plan AS (
      SELECT r.id, r.qty, LEAST(r.qty, $3::int - r.taken_before)::int AS take
        FROM ranked r, avail a
       WHERE a.total >= $3::int AND r.taken_before < $3::int
    ),
    gone AS (
      DELETE FROM player_items
       WHERE id IN (SELECT id FROM plan WHERE take >= qty)
      RETURNING qty
    ),
    kept AS (
      UPDATE player_items pi SET qty = pi.qty - p.take
        FROM plan p WHERE pi.id = p.id AND p.take < p.qty
      RETURNING p.take AS qty
    )
    SELECT (COALESCE((SELECT sum(qty) FROM gone), 0)
          + COALESCE((SELECT sum(qty) FROM kept), 0))::int AS took`,
    [playerId, itemId, qty, enhance, minEnhance, guard]);
  const took = Number(rows[0].took);
  // Only a COMPLETE take is recorded, because only a complete take happened —
  // `plan` is empty when the total falls short, so a false return means the
  // inventory was not touched and there is nothing to write down. Recording the
  // shortfall would invent a movement that the item rows never made, and
  // reconcile() would then alarm on the ledger's own bookkeeping.
  if (took !== Number(qty)) return false;
  // No rowId: a take may drain several rows at once, so there is no single one
  // this movement is about. The column is nullable for exactly this case.
  await ledger(db, playerId, itemId, -took, { reason, refType, refId });
  return true;
}

// Takes `n` units of whatever matches a DESCRIPTION rather than an id — "ten
// skill books, any class" or "thirty non-stackable commons". Two recipes need
// this and neither can be expressed with removeQty: the advanced-book recycle
// accepts any mix of the twenty book ids, and class-gear salvage accepts any
// junk gear of a rarity, which is a catalog property rather than a list.
//
// The filter is applied in SQL against item_catalog, so "what counts as junk"
// is decided by the same table the rest of the server reads. The old version
// asked the client's copy of the inventory whether an item was stackable, and
// that copy is attacker-controlled: relabel a stack of potions as non-stackable
// legendaries and the salvage counts them.
//
// Ordering, availability and the all-or-nothing rule are removeQty's, for the
// same reasons — lowest enhancement first so salvage eats the +0 before the
// +12, and nothing consumed at all unless the whole amount is there.
async function consumeMatching(db, playerId, n, { itemIds = null, rarity = null, stackable = null, reason = 'consume', refType = null, refId = null } = {}) {
  const guard = await marketRefBlocksDelete(db);
  const { rows } = await query(db, `
    WITH pool AS (
      SELECT pi.id, pi.qty, pi.enhance
        FROM player_items pi
        JOIN item_catalog c ON c.item_id = pi.item_id
       WHERE pi.player_id = $1 AND pi.container = 'inventory'
         AND ($3::text[] IS NULL OR pi.item_id = ANY($3::text[]))
         AND ($4::text   IS NULL OR c.rarity = $4::text)
         AND ($5::bool   IS NULL OR c.stackable = $5::bool)
         AND ($6::bool = false OR NOT EXISTS (
               SELECT 1 FROM market_listings m WHERE m.item_id = pi.id))
    ),
    avail AS (SELECT COALESCE(sum(qty), 0)::int AS total FROM pool),
    ranked AS (
      SELECT id, qty,
             COALESCE(sum(qty) OVER (ORDER BY enhance, id
               ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)::int AS taken_before
        FROM pool
    ),
    plan AS (
      SELECT r.id, r.qty, LEAST(r.qty, $2::int - r.taken_before)::int AS take
        FROM ranked r, avail a
       WHERE a.total >= $2::int AND r.taken_before < $2::int
    ),
    gone AS (
      DELETE FROM player_items WHERE id IN (SELECT id FROM plan WHERE take >= qty)
      RETURNING item_id, qty
    ),
    kept AS (
      UPDATE player_items pi SET qty = pi.qty - p.take
        FROM plan p WHERE pi.id = p.id AND p.take < p.qty
      RETURNING pi.item_id, p.take AS qty
    ),
    moved AS (
      -- Aliased "drained" rather than "both": BOTH is a reserved word in
      -- PostgreSQL (it belongs to TRIM(BOTH ...)), and a reserved word as a
      -- subquery alias is a syntax error, not a warning.
      SELECT item_id, sum(qty)::int AS taken
        FROM (SELECT item_id, qty FROM gone
              UNION ALL
              SELECT item_id, qty FROM kept) drained
       GROUP BY item_id
    )
    SELECT (SELECT total FROM avail) AS had,
           (SELECT COALESCE(sum(taken), 0) FROM moved)::int AS took,
           m.item_id AS moved_item, m.taken AS moved_qty
      FROM (SELECT 1 AS one) base
      LEFT JOIN moved m ON true`,
    [playerId, n, itemIds, rarity, stackable, guard]);

  // The LEFT JOIN is what keeps this readable when nothing was taken: `moved`
  // is empty then, and an inner join would return NO rows at all — so rows[0]
  // would be undefined and the `had` count the caller needs to say "нужно 30,
  // есть 24" would throw instead of arriving.
  const had = Number(rows[0].had);
  const took = Number(rows[0].took);
  if (took !== Number(n)) return { ok: false, had };

  // One ledger row per item id, not per player_items row. This function is the
  // only consumer that drains ACROSS ids — ten skill books of any class, thirty
  // commons of any kind — and the ledger's unit is (account, item), so the
  // breakdown has to be grouped that way before it is written. Doing it in SQL
  // above means the split recorded here is the split that actually happened,
  // rather than one recomputed in JavaScript from the same inputs.
  for (const r of rows) {
    if (!r.moved_item) continue;
    await ledger(db, playerId, r.moved_item, -Number(r.moved_qty), { reason, refType, refId });
  }
  return { ok: true, had };
}

// Turns whatever the client used to name an item into a row id it owns.
//
// A row id is the right way to name an item and the rest of this layer uses
// nothing else. The SHIPPED client does not have one: it addresses items by
// position in its own copy of the inventory (`{ idx }`), sometimes with the
// item id and enhancement alongside as a sanity check (`{ idx, id, enhance }`),
// and for enhancement by identity plus an equipment slot. Handlers written to
// take a row id therefore received undefined from every one of those, hit their
// guard clause, and returned silently — a button that does nothing, with no
// error anywhere. See dev/protocol-check.js.
//
// So the position is accepted, but it is only ever a HINT. The list it indexes
// is the database's, not the client's, and when identity is supplied it must
// match or the index is discarded and the identity used instead. That is
// strictly safer than what it replaces: the old handlers spliced an index out
// of an array the client itself had last written.
//
// Ambiguity is not a problem here the way it is for enhancement. Two rows that
// share (item_id, enhance) are interchangeable by definition — selling or
// burning "one of them" has one outcome. Enhancement is the exception, because
// afterwards they are no longer identical, and that is why the client sends the
// slot for equipped items: an equipped item is unambiguous by its slot.
async function resolveRow(db, playerId, ref = {}, container = 'inventory') {
  const direct = Math.floor(Number(ref.rowId));
  if (Number.isSafeInteger(direct) && direct > 0) {
    const { rows } = await query(db,
      `SELECT id FROM player_items WHERE id = $1 AND player_id = $2 AND container = $3`,
      [direct, playerId, container]);
    if (rows.length) return Number(rows[0].id);
    // Falls THROUGH rather than refusing. A row id can go stale honestly — the
    // item was sold, burned or equipped from another tab between the render
    // and the click — and identity below still names what the player meant.
    // Returning null here would turn every such click into "Предмет не найден"
    // where the old identity-only path quietly worked.
  }

  // An equipped item is named by its slot, and that is unambiguous.
  if (container === 'equipment' && typeof ref.slot === 'string' && ref.slot) {
    const { rows } = await query(db,
      `SELECT id FROM player_items
        WHERE player_id = $1 AND container = 'equipment' AND slot = $2`,
      [playerId, ref.slot]);
    return rows.length ? Number(rows[0].id) : null;
  }

  const { rows } = await query(db,
    `SELECT id, item_id, enhance FROM player_items
      WHERE player_id = $1 AND container = $2 ORDER BY id`, [playerId, container]);
  if (!rows.length) return null;

  const wantId = typeof ref.id === 'string' && ref.id ? ref.id : null;
  const wantEnh = Number.isFinite(Number(ref.enhance)) && ref.enhance !== null
    ? Math.floor(Number(ref.enhance)) : null;
  const matches = r =>
    (wantId === null || r.item_id === wantId) &&
    (wantEnh === null || r.enhance === wantEnh);

  const i = Math.floor(Number(ref.idx));
  if (Number.isSafeInteger(i) && i >= 0 && i < rows.length && matches(rows[i])) {
    return Number(rows[i].id);
  }
  // The index was stale or absent. Identity still names the item, and this is
  // the branch that makes a desynchronised inventory panel harmless instead of
  // destructive — the old code would have acted on whatever sat at that index.
  if (wantId === null) return null;
  const found = rows.find(matches);
  return found ? Number(found.id) : null;
}


// Counts without consuming, same filter. A recipe that cannot proceed should
// say how many the player actually has — "нужно 30, есть 24" is an answer;
// "не хватает" is a support ticket.
async function countMatching(db, playerId, { itemIds = null, rarity = null, stackable = null } = {}) {
  const { rows } = await query(db, `
    SELECT COALESCE(sum(pi.qty), 0)::int AS n
      FROM player_items pi
      JOIN item_catalog c ON c.item_id = pi.item_id
     WHERE pi.player_id = $1 AND pi.container = 'inventory'
       AND ($2::text[] IS NULL OR pi.item_id = ANY($2::text[]))
       AND ($3::text   IS NULL OR c.rarity = $3::text)
       AND ($4::bool   IS NULL OR c.stackable = $4::bool)`,
    [playerId, itemIds, rarity, stackable]);
  return Number(rows[0].n);
}

// ── a destroyed item and the trades it was in ───────────────────────────────
// market_listings.item_id references player_items(id), and — before migration
// 010 — the reference is `NO ACTION`: the database REFUSES to delete a row any
// listing still names, including a listing that was sold or cancelled months
// ago. Everything that destroys an item hits it: enhancing and burning,
// selling, feeding a craft, burning for season points.
//
// The refusal is what the players saw, and it was worse than an error:
//
//   "я в маркет закинул предмет и снял, теперь он думает что он в маркете и
//    не даёт точить, но если много раз нажимать можно вплоть до +15 заточить
//    не ломая"
//
// Exactly right, and the second half is the serious one. Enhancement runs in a
// transaction: the stone is taken, the roll fails, the DELETE raises 23503, and
// the WHOLE transaction rolls back — stone refunded, item intact. So a failed
// roll costs nothing and an item that has ever been listed can be taken to +15
// for free. A live economy exploit produced by a foreign key.
//
// This asks the database what its own constraint does, once, and caches it:
//
//   NO ACTION / RESTRICT   the reference blocks — refuse the destruction up
//                          front, with a reason, before anything is spent.
//                          Nothing is rolled back, so there is nothing to
//                          exploit.
//   SET NULL               migration 010 has run: the reference releases
//                          itself and the trade history keeps its own snapshot
//                          of what was sold. Nothing to check.
//
// Reading `delete_rule` rather than a version flag means the code cannot be
// wrong about which schema it is talking to.
let _fkBlocks = null;
async function marketRefBlocksDelete(db) {
  if (_fkBlocks !== null) return _fkBlocks;
  const { rows } = await query(db, `
    SELECT delete_rule FROM information_schema.referential_constraints
     WHERE constraint_name = 'market_listings_item_id_fkey'`);
  // No constraint at all is also "does not block".
  _fkBlocks = rows.length ? !/SET NULL/i.test(rows[0].delete_rule) : false;
  return _fkBlocks;
}

// Throws when this row cannot be destroyed because a past trade still names
// it. Called BEFORE anything is spent — that ordering is the whole point.
async function assertDestroyable(db, rowId) {
  if (!await marketRefBlocksDelete(db)) return;
  const { rows } = await query(db,
    'SELECT 1 FROM market_listings WHERE item_id = $1 LIMIT 1', [rowId]);
  if (rows.length) {
    throw Object.assign(new Error('listed'), {
      code: 'was_listed',
      userMessage: 'Этот предмет был на рынке — операция станет доступна после обновления базы',
    });
  }
}

// Removes one specific row — used where the caller already identified the
// exact item (an equipped piece, a listing's item) rather than "one of these".
async function removeRow(db, rowId, playerId, { reason = 'destroy', refType = null, refId = null } = {}) {
  await assertDestroyable(db, rowId);
  // RETURNING rather than a SELECT first: the ledger needs to know WHAT was
  // destroyed, and reading it beforehand would be a second statement whose
  // answer could be stale by the time the DELETE ran. The row tells us on its
  // way out, which is the only moment both facts are certainly true together.
  const { rows } = await query(db,
    'DELETE FROM player_items WHERE id = $1 AND player_id = $2 RETURNING item_id, qty', [rowId, playerId]);
  if (rows.length !== 1) return false;
  await ledger(db, playerId, rows[0].item_id, -Number(rows[0].qty),
    { rowId: Number(rowId), reason, refType, refId });
  return true;
}

// Equip / unequip / storage, as one operation.
//
// Moving INTO an equipment slot that is occupied is refused by
// player_items_equip_slot_key rather than silently replacing — the caller must
// unequip first, in the same transaction, so there is never an instant where
// the displaced item belongs nowhere.
//
// Writes NO ledger row, and that is a decision rather than an omission. The
// item ledger counts how many of an item an ACCOUNT holds; equipping a sword
// moves it between that account's own containers and changes the count by
// nothing. `delta <> 0` means such a movement has no well-formed row to write,
// and a table full of zeroes would bury the movements that matter under the
// ones that cannot. Where an item sits is player_logs' subject.
//
// ── why the battle rating is written here ───────────────────────────────────
// This is the only statement in the build that changes WHICH rows are worn,
// and worn rows are most of what battlePower() adds up. players.bm is a stored
// column that the rating board sorts on, so gear moving without rewriting it
// leaves the board describing a character that no longer exists — which is
// what it did for everyone, because outside a level-up nothing called
// refreshBm at all.
//
// Here rather than in the two handlers so a sixth call site cannot forget it.
// The price is that a swap (unequip the displaced piece, equip the new one)
// refreshes twice inside one transaction; the first value is overwritten
// before COMMIT, so nothing outside ever reads the intermediate, and two
// statements on an action a player takes by hand is the cheaper half of the
// trade.
// ── одна купка — одна строка ───────────────────────────────────────────────
// Стакающийся предмет обязан лежать в контейнере ОДНОЙ строкой. add() это
// правило соблюдает — он сливает в существующую купку, — а два других пути
// создания строк нет:
//
//   attachFromListing   лот, который выкупили или сняли, приезжал НОВОЙ
//                       строкой рядом с уже лежащей;
//   moveTo              перенос строки в контейнер, где такая купка уже есть,
//                       клал вторую.
//
// Клиент показывает сумму строк, а действия работают со строкой, и расхождение
// между этими двумя видами счёта — это ровно то, на что жаловались:
//
//   «кидає 11 штук айтема, а в хранилищі 126 відображається; забирає назад — в
//    інвентарі 11»                     — переехала одна строка из двух;
//   «296 штук виставляю — виставляється 46»  — клиент держал id первой строки;
//   «предмети наче розділилися на дві частини, забираєш спочатку одну»
//
// Собирает ВСЕ строки, а не только вторую: у части аккаунтов их успело
// накопиться больше двух, и починка при первом же касании лучше, чем починка
// «по одной за раз».
//
// Количество не меняется — меняется только то, в скольких строках оно лежит, —
// поэтому в ledger ничего не пишется: он считает штуки на игрока, а не строки.
async function mergeStacks(db, playerId, container, itemId, enhance = 0) {
  const { rows: cat } = await query(db,
    'SELECT stackable FROM item_catalog WHERE item_id = $1', [itemId]);
  if (!cat.length || !cat[0].stackable) return null;

  // Строки, на которые ещё ссылается лот, не трогаем: они принадлежат лоту, а
  // не игроку, и внешний ключ запрещает их удалять. То же условие, что в
  // removeQty и в market._splitOffForListing.
  const guard = await marketRefBlocksDelete(db);
  const { rows } = await query(db, `
    SELECT id, qty FROM player_items pi
     WHERE player_id = $1 AND container = $2 AND item_id = $3 AND enhance = $4
       AND ($5::bool = false OR NOT EXISTS (
             SELECT 1 FROM market_listings m WHERE m.item_id = pi.id))
     ORDER BY id
     FOR UPDATE`, [playerId, container, itemId, enhance, guard]);
  if (rows.length < 2) return rows.length ? Number(rows[0].id) : null;

  const keep = Number(rows[0].id);
  const total = rows.reduce((n, r) => n + Number(r.qty), 0);
  const moved = total - Number(rows[0].qty);
  const drop = rows.slice(1).map(r => Number(r.id));
  await query(db, 'DELETE FROM player_items WHERE id = ANY($1)', [drop]);
  await query(db, 'UPDATE player_items SET qty = $2 WHERE id = $1', [keep, total]);

  // ── и это записывается ────────────────────────────────────────────────────
  // У игрока не прибавилось и не убавилось ничего — поменялось только то, в
  // скольких строках лежит одно и то же количество. Соблазн ничего не писать
  // поэтому силён, и он неверен по двум причинам.
  //
  // Первая: правило этого файла — «каждая запись в player_items сопровождается
  // записью в леджер», и держится оно ровно до первого исключения. Исключение,
  // сделанное потому что «здесь и так сходится», — это то самое исключение,
  // под которое в следующий раз спрячут настоящую пропажу.
  //
  // Вторая: historyOfRow отвечает на вопрос «откуда взялась эта строка», и без
  // этих записей история поглощённой строки обрывается на полуслове, а у
  // выжившей появляется количество ниоткуда.
  //
  // Сумма дельт — ноль, поэтому reconcile() остаётся сойтись обязан.
  for (const r of rows.slice(1)) {
    await ledger(db, playerId, itemId, -Number(r.qty),
      { rowId: Number(r.id), reason: 'stack_merge', refType: 'row', refId: String(keep) });
  }
  if (moved > 0) {
    await ledger(db, playerId, itemId, moved,
      { rowId: keep, reason: 'stack_merge', refType: 'row', refId: String(keep) });
  }
  return keep;
}

async function moveTo(db, rowId, playerId, container, slot = null) {
  if (container === 'equipment' && !slot) throw new Error('items: equipment move needs a slot');
  if (container !== 'equipment' && slot) throw new Error('items: only equipment has a slot');
  if (container === 'inventory' && await usedSlots(db, playerId) >= SERVER_INV_MAX) {
    // Unequipping into a full inventory would otherwise destroy the piece —
    // the old code's "unequip refuses when the inventory is full" scenario.
    return false;
  }
  // Where the row is LEAVING from, read before the move: afterwards the column
  // holds the destination and nothing is left to say it had been worn. An
  // unequip and a withdrawal from storage are the same call with the same
  // arguments, so the origin is the only thing that tells them apart.
  const { rows: from } = await query(db,
    'SELECT container FROM player_items WHERE id = $1 AND player_id = $2', [rowId, playerId]);
  const { rowCount } = await query(db, `
    UPDATE player_items SET container = $3, slot = $4
     WHERE id = $1 AND player_id = $2`, [rowId, playerId, container, slot]);
  if (rowCount !== 1) return false;
  // На новом месте купка обязана стать одной строкой — иначе склад показывает
  // сумму, а «забрать» уносит одну строку из двух. См. mergeStacks выше.
  // Снаряжение исключено: там строка — это конкретная надетая вещь, и слот у
  // неё один.
  if (container !== 'equipment') {
    const { rows: what } = await query(db,
      'SELECT item_id, enhance FROM player_items WHERE id = $1', [rowId]);
    if (what.length) await mergeStacks(db, playerId, container, what[0].item_id, what[0].enhance || 0);
  }
  if (container === 'equipment' || (from.length && from[0].container === 'equipment')) {
    await require('./stats').refreshBm(db, playerId);
  }
  return true;
}

// ── market handoff ──────────────────────────────────────────────────────────
// Listing an item detaches it from its owner entirely: player_id and container
// both go NULL, which player_items_owned_ck permits only as a pair. While it
// is detached the item belongs to the listing and to nothing else — that is
// the state the old model could not express, and its absence is why "listed
// but still in the inventory" was reachable.

// A listing IS a ledger movement, unlike an equip: the item leaves the
// seller's holding for one that belongs to no account. Recording it is what
// keeps the invariant exact on both sides of a trade — without it every active
// listing would read as an item the seller still owes the ledger, and every
// seller with something for sale would show as drift.
async function detachForListing(db, rowId, playerId, { reason = 'market_list', refType = 'listing', refId = null } = {}) {
  const { rows } = await query(db, `
    UPDATE player_items SET player_id = NULL, container = NULL, slot = NULL
     WHERE id = $1 AND player_id = $2 AND container = 'inventory'
    RETURNING item_id, qty`, [rowId, playerId]);
  if (rows.length !== 1) return false;
  await ledger(db, playerId, rows[0].item_id, -Number(rows[0].qty),
    { rowId: Number(rowId), reason, refType, refId });
  return true;
}

// Hands a detached item to an account — the buyer on a sale, the seller on a
// cancellation. Room must already have been checked by the caller INSIDE the
// same transaction; if it was not, this still cannot overflow, because the
// slot count is re-checked here.
async function attachFromListing(db, rowId, playerId, { reason = 'market_buy', refType = 'listing', refId = null } = {}) {
  if (await usedSlots(db, playerId) >= SERVER_INV_MAX) return false;
  const { rows } = await query(db, `
    UPDATE player_items SET player_id = $2, container = 'inventory'
     WHERE id = $1 AND player_id IS NULL
    RETURNING item_id, qty`, [rowId, playerId]);
  if (rows.length !== 1) return false;
  // ЛЕДЖЕР ПЕРВЫМ, слияние вторым: строка, в которую вольют, может исчезнуть, а
  // запись о приходе должна остаться привязанной к той, что была в этот момент.
  await ledger(db, playerId, rows[0].item_id, Number(rows[0].qty),
    { rowId: Number(rowId), reason, refType, refId });
  // Купленный или снятый лот приезжал ОТДЕЛЬНОЙ строкой рядом с уже лежащей —
  // это и есть источник расколотых купок, из-за которых «296 штук виставляю,
  // виставляється 46». См. mergeStacks выше.
  const { rows: what } = await query(db,
    'SELECT item_id, enhance FROM player_items WHERE id = $1', [rowId]);
  if (what.length) await mergeStacks(db, playerId, 'inventory', what[0].item_id, what[0].enhance || 0);
  return true;
}

// ── history ─────────────────────────────────────────────────────────────────
// "Where did this sword come from" — the question migration 011 could only
// answer while the row was alive. Keyed on the row id, and it keeps answering
// after the row is deleted, because these rows are not attached to it.
async function historyOfRow(db, rowId, limit = 50) {
  const { rows } = await query(db, `
    SELECT player_id, item_id, delta, qty_after, reason, ref_type, ref_id, created_at
      FROM item_ledger
     WHERE row_id = $1
     ORDER BY id
     LIMIT $2`, [rowId, Math.min(limit, 200)]);
  return rows.map(r => ({
    playerId: Number(r.player_id),
    itemId: r.item_id,
    delta: Number(r.delta),
    qtyAfter: Number(r.qty_after),
    reason: r.reason,
    refType: r.ref_type,
    refId: r.ref_id,
    at: r.created_at,
  }));
}

// ── reconcile ───────────────────────────────────────────────────────────────
// The check that makes the item ledger worth having, and the exact counterpart
// of money.reconcile(): for every account and every catalog item, the sum of
// everything that ever moved must equal the quantity that account holds now.
// Anything else means items were created or destroyed outside this file, and
// this is the only way to find out.
//
// Returns the pairs that DISAGREE. An empty array is the expected result, and
// the day it stops being empty is the day an item came from somewhere nobody
// wrote down — which is precisely the signal that did not exist before, when an
// inventory was a set of rows with no history to check it against.
//
// A FULL JOIN rather than money's LEFT JOIN, and the difference matters. Money
// iterates `balances`, so an account with a ledger row and no balance row is
// invisible to it — tolerable there, because credit() creates the balance row
// in the same statement as the ledger row. Here the two failure directions are
// both real and neither is rarer than the other: an item held with no ledger
// row behind it (something inserted around items.add) and a ledger row with no
// item left (something deleted around this file). A LEFT JOIN from either side
// would silently report only half of them, which is the shape of a check that
// looks like it is working.
//
// player_id IS NOT NULL on both sides: an item detached into a market listing
// belongs to no account, so it is in neither sum. That is not an exclusion, it
// is the same fact counted consistently on both sides.
//
// Meant to run nightly. It is a full aggregate over the ledger, so it is not
// something to call from a request path.
async function reconcile(db) {
  if (!await _hasLedger()) return null;
  const { rows } = await query(db, `
    SELECT COALESCE(h.player_id, l.player_id) AS player_id,
           COALESCE(h.item_id,   l.item_id)   AS item_id,
           COALESCE(h.held, 0)                AS held,
           COALESCE(l.ledger_total, 0)        AS ledger_total,
           COALESCE(h.held, 0) - COALESCE(l.ledger_total, 0) AS drift
      FROM (SELECT player_id, item_id, sum(qty)::int AS held
              FROM player_items
             WHERE player_id IS NOT NULL
             GROUP BY player_id, item_id) h
      FULL JOIN (SELECT player_id, item_id, sum(delta)::int AS ledger_total
                   FROM item_ledger
                  GROUP BY player_id, item_id) l
        ON l.player_id = h.player_id AND l.item_id = h.item_id
     WHERE COALESCE(h.held, 0) <> COALESCE(l.ledger_total, 0)
     ORDER BY abs(COALESCE(h.held, 0) - COALESCE(l.ledger_total, 0)) DESC
     LIMIT 500`);
  return rows.map(r => ({
    playerId: Number(r.player_id),
    itemId: r.item_id,
    held: Number(r.held),
    ledgerTotal: Number(r.ledger_total),
    drift: Number(r.drift),
  }));
}

module.exports = {
  consumeMatching, countMatching, resolveRow,
  syncCatalog, lockPlayer, mergeStacks,
  inventoryOf, usedSlots, hasRoomFor,
  add, removeQty, removeRow, moveTo,
  assertDestroyable, marketRefBlocksDelete,
  detachForListing, attachFromListing,
  ledger, reconcile, historyOfRow,
  SERVER_INV_MAX,
};
