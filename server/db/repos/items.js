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

const { query } = require('../index');
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
async function add(db, playerId, itemId, { enhance = 0, qty = 1 } = {}) {
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
    if (merged.length) return Number(merged[0].id);
  }

  if (await usedSlots(db, playerId) >= SERVER_INV_MAX) return null;

  const { rows } = await query(db, `
    INSERT INTO player_items (player_id, container, item_id, enhance, qty)
    VALUES ($1, 'inventory', $2, $3, $4) RETURNING id`,
    [playerId, itemId, enh, qty]);
  return Number(rows[0].id);
}

// Takes `qty` off a stack, or removes the row outright when it runs out.
// Returns true only when the full amount was taken — a partial take is not a
// success, and treating it as one is how a craft consumes three of a material
// the player only had two of.
// Decrement and delete are ONE statement, and that is forced by the schema
// rather than chosen for elegance. player_items has CHECK (qty >= 1), so an
// "UPDATE to zero, then DELETE the empty row" sequence never reaches the
// delete: the update itself violates the constraint and throws. Weakening the
// check to qty >= 0 would have been the easy fix and the wrong one — it would
// permit a zero-quantity row to exist, which every reader downstream then has
// to remember to filter out.
//
// So the row is either decremented or removed, decided inside the statement by
// comparing what is there against what is being taken. FOR UPDATE on the
// target is belt-and-braces under lockPlayer: it makes this correct even if a
// future caller forgets the lock.
async function removeQty(db, playerId, itemId, qty = 1, { enhance = null } = {}) {
  const { rows } = await query(db, `
    WITH target AS (
      SELECT id, qty FROM player_items
       WHERE player_id = $1 AND container = 'inventory' AND item_id = $2
         AND ($4::int IS NULL OR enhance = $4)
         AND qty >= $3
       ORDER BY id LIMIT 1
       FOR UPDATE
    ),
    gone AS (
      DELETE FROM player_items
       WHERE id IN (SELECT id FROM target WHERE qty = $3)
      RETURNING id
    ),
    kept AS (
      UPDATE player_items SET qty = qty - $3
       WHERE id IN (SELECT id FROM target WHERE qty > $3)
      RETURNING id
    )
    SELECT (SELECT count(*) FROM gone) + (SELECT count(*) FROM kept) AS n`,
    [playerId, itemId, qty, enhance]);
  return Number(rows[0].n) === 1;
}

// Removes one specific row — used where the caller already identified the
// exact item (an equipped piece, a listing's item) rather than "one of these".
async function removeRow(db, rowId, playerId) {
  const { rowCount } = await query(db,
    'DELETE FROM player_items WHERE id = $1 AND player_id = $2', [rowId, playerId]);
  return rowCount === 1;
}

// Equip / unequip / storage, as one operation.
//
// Moving INTO an equipment slot that is occupied is refused by
// player_items_equip_slot_key rather than silently replacing — the caller must
// unequip first, in the same transaction, so there is never an instant where
// the displaced item belongs nowhere.
async function moveTo(db, rowId, playerId, container, slot = null) {
  if (container === 'equipment' && !slot) throw new Error('items: equipment move needs a slot');
  if (container !== 'equipment' && slot) throw new Error('items: only equipment has a slot');
  if (container === 'inventory' && await usedSlots(db, playerId) >= SERVER_INV_MAX) {
    // Unequipping into a full inventory would otherwise destroy the piece —
    // the old code's "unequip refuses when the inventory is full" scenario.
    return false;
  }
  const { rowCount } = await query(db, `
    UPDATE player_items SET container = $3, slot = $4
     WHERE id = $1 AND player_id = $2`, [rowId, playerId, container, slot]);
  return rowCount === 1;
}

// ── market handoff ──────────────────────────────────────────────────────────
// Listing an item detaches it from its owner entirely: player_id and container
// both go NULL, which player_items_owned_ck permits only as a pair. While it
// is detached the item belongs to the listing and to nothing else — that is
// the state the old model could not express, and its absence is why "listed
// but still in the inventory" was reachable.

async function detachForListing(db, rowId, playerId) {
  const { rowCount } = await query(db, `
    UPDATE player_items SET player_id = NULL, container = NULL, slot = NULL
     WHERE id = $1 AND player_id = $2 AND container = 'inventory'`, [rowId, playerId]);
  return rowCount === 1;
}

// Hands a detached item to an account — the buyer on a sale, the seller on a
// cancellation. Room must already have been checked by the caller INSIDE the
// same transaction; if it was not, this still cannot overflow, because the
// slot count is re-checked here.
async function attachFromListing(db, rowId, playerId) {
  if (await usedSlots(db, playerId) >= SERVER_INV_MAX) return false;
  const { rowCount } = await query(db, `
    UPDATE player_items SET player_id = $2, container = 'inventory'
     WHERE id = $1 AND player_id IS NULL`, [rowId, playerId]);
  return rowCount === 1;
}

module.exports = {
  syncCatalog, lockPlayer,
  inventoryOf, usedSlots, hasRoomFor,
  add, removeQty, removeRow, moveTo,
  detachForListing, attachFromListing,
  SERVER_INV_MAX,
};
