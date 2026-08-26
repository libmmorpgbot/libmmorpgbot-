'use strict';
// Server-side inventory arithmetic and the market's item/price rules, moved out
// of server/index.js verbatim.
//
// Pure functions over an inventory array and the shared catalog: no models, no
// sockets, no session state. Every server-side item grant and removal in the
// game funnels through _invAdd/_invRemove, so having them in one small file
// that can be exercised directly is worth more than their line count suggests.
const {
  ITEM_DEF, CRAFT_MATS, BOX_DEF, isStackableItem, ENHANCE_MAX, ENHANCEABLE_SLOTS,
} = require('../shared/definitions');
const { _catalogBase, SERVER_INV_MAX } = require('./anticheat');

// ── Market (player-to-player item trading for GRAM) ────────────────────────
const MARKET_MIN_PRICE   = 0.1;
const MARKET_MAX_PRICE   = 1000;
const MARKET_FEE_PCT     = 0.10;   // burned — not paid out to anyone
const MARKET_MAX_ACTIVE  = 5;      // active listings per seller below MARKET_MAX_ACTIVE_VIP_LEVEL
const MARKET_MAX_ACTIVE_VIP_LEVEL = 3; // VIP level at which the cap switches to MARKET_MAX_ACTIVE_VIP, see _marketMaxActive (server/index.js)
const MARKET_MAX_ACTIVE_VIP = 10;  // active listings per seller at VIP 3+
const MARKET_MAX_QTY     = 9999;   // sanity bound on a stackable listing's quantity
const MARKET_LIST_COOLDOWN_MS = 3000;
// Per-category floors, below the generic MARKET_MIN_PRICE above — these items
// are cheap/plentiful enough that the flat 0.1 GRAM floor overpriced them
// relative to how easy they are to farm. Keys/recipes/stones are PER UNIT
// (the listing's price covers its whole stack, see _canonicalMarketItem's
// qty); rare gear is a flat per-listing floor since it isn't stackable.
const MARKET_MIN_PRICE_KEY_UNCOMMON = 0.003; // key_uncommon, per key
const MARKET_MIN_PRICE_KEY_RARE     = 0.006; // key_rare (blue), per key
const MARKET_MIN_PRICE_RECIPE      = 0.01; // slot:'recipe' (recu/recr/rece/recl), per scroll
const MARKET_MIN_PRICE_STONE       = 0.40; // norm_stone, per stone
const MARKET_MIN_PRICE_BLESS_STONE = 1.5;  // bless_stone, per stone
const MARKET_MIN_PRICE_BOX_UNCOMMON = 1;   // box_uncommon (green, BOX_DEF), per box
const MARKET_MIN_PRICE_BOX_RARE     = 2;   // box_rare (blue, BOX_DEF), per box
const MARKET_MIN_PRICE_EPIC_GEAR   = 10;   // rarity:'epic' armor/weapon, flat
const MARKET_MIN_PRICE_RARE_GEAR   = 3;    // rarity:'rare' armor/weapon, flat
const MARKET_MIN_PRICE_UNCOMMON_GEAR = 0.3; // rarity:'uncommon' armor/weapon, flat
const MARKET_MIN_PRICE_CLOAK_ARTIFACT = 2; // slot:'cloak'/'artifact', flat, any rarity below 'rare'
const MARKET_MIN_PRICE_SKILL_BOOK  = 0.4;  // book_<cls>_<key> (has skillKey), flat, per book
const MARKET_MIN_PRICE_ADV_SKILL_BOOK = 10; // book_adv_<cls>_<key> ("вторая профессия", has advSkillKey), flat, per book

function _round2(n) { return Math.round(n * 100) / 100; }

// GRAM *balances* carry 7 decimals — kill drops accrue at GRAM_PER_LEVEL
// (0.0000001) per mob level and the client renders every balance with
// toFixed(7). Rounding a balance to 2 decimals (as several credit paths did)
// silently destroyed every fraction below 0.01, so a player's entire farmed
// sub-cent balance disappeared the moment a deposit, referral bonus or market
// sale credited them. Use this for anything that IS a balance; _round2 stays
// for genuinely 2-decimal money figures (listing prices, withdrawal fees).
// The 1e7 multiply-round-divide also clears the float drift that repeated
// += 0.0000001 accumulates.
function _round7(n) { return Math.round(n * 1e7) / 1e7; }

// Rebuild a listing's item entirely from the canonical catalog — the client
// is only trusted for WHICH item (id), WHICH enhance level, and (for
// stackable items) HOW MANY units, never for any stat field. This can't
// stop someone claiming an enhance level or a quantity they don't actually
// have (the enhance/craft system and the inventory itself are still
// client-computed, same as the rest of this game's economy), but it does
// stop a listing from carrying arbitrary made-up stats, rarity, or an item
// id that doesn't exist.
function _canonicalMarketItem(rawItem) {
  if (!rawItem || typeof rawItem !== 'object') return null;
  const id = rawItem.id;
  const base = ITEM_DEF.find(d => d.id === id) || CRAFT_MATS.find(d => d.id === id) || BOX_DEF.find(d => d.id === id);
  if (!base) return null;
  const item = { ...base };
  if (ENHANCEABLE_SLOTS.has(base.slot)) {
    const enh = Math.floor(Number(rawItem.enhance));
    item.enhance = (Number.isFinite(enh) && enh >= 0 && enh <= ENHANCE_MAX) ? enh : 0;
  }
  if (isStackableItem(base)) {
    const qty = Math.floor(Number(rawItem.qty));
    item.qty = (Number.isFinite(qty) && qty >= 1 && qty <= MARKET_MAX_QTY) ? qty : 1;
  }
  return item;
}

// The floor a listing's price has to clear — item-specific where one of the
// categories above applies (scaled by qty for the stackable ones), the
// generic MARKET_MIN_PRICE otherwise. Takes the already-canonicalized item
// (see _canonicalMarketItem) so id/slot/rarity/qty are all trustworthy.
function _marketMinPrice(item) {
  const qty = item.qty || 1;
  if (item.id === 'norm_stone') return MARKET_MIN_PRICE_STONE * qty;
  if (item.id === 'bless_stone') return MARKET_MIN_PRICE_BLESS_STONE * qty;
  if (item.id === 'key_rare') return MARKET_MIN_PRICE_KEY_RARE * qty;
  if (item.id && item.id.startsWith('key_')) return MARKET_MIN_PRICE_KEY_UNCOMMON * qty;
  if (item.slot === 'recipe') return MARKET_MIN_PRICE_RECIPE * qty;
  if (item.slot === 'box') {
    return (item.id === 'box_rare' ? MARKET_MIN_PRICE_BOX_RARE : MARKET_MIN_PRICE_BOX_UNCOMMON) * qty;
  }
  // Cloak/artifact have their own flat floor at every rarity below 'rare'
  // (there's no 'rare' tier for either), so this has to win over the
  // rarity-based gear checks below rather than the other way around —
  // otherwise an uncommon cloak (cloak_u_<class>) would fall through to the
  // cheaper uncommon-gear floor instead.
  if (item.slot === 'cloak' || item.slot === 'artifact') return MARKET_MIN_PRICE_CLOAK_ARTIFACT;
  // Skill/passive books — "вторая профессия" (advSkillKey) has its own,
  // higher floor and must be checked before the regular floor below, which
  // covers both active skill books (skillKey) and passive ones (passiveId —
  // class-exclusive and the 6 universal ones alike).
  if (item.advSkillKey) return MARKET_MIN_PRICE_ADV_SKILL_BOOK * qty;
  if (item.skillKey || item.passiveId) return MARKET_MIN_PRICE_SKILL_BOOK * qty;
  if (item.rarity === 'epic' && ENHANCEABLE_SLOTS.has(item.slot) && item.slot !== 'pet') return MARKET_MIN_PRICE_EPIC_GEAR;
  if (item.rarity === 'rare' && ENHANCEABLE_SLOTS.has(item.slot) && item.slot !== 'pet') return MARKET_MIN_PRICE_RARE_GEAR;
  if (item.rarity === 'uncommon' && ENHANCEABLE_SLOTS.has(item.slot) && item.slot !== 'pet') return MARKET_MIN_PRICE_UNCOMMON_GEAR;
  return MARKET_MIN_PRICE;
}

// Which slot this item really occupies. isStackableItem (shared/definitions.js)
// answers purely off `it.slot`, so an item passed around as a bare
// {id, qty} — no slot — reads as NON-stackable, and every stack rule built on
// that answer silently inverts: _invRemove takes the whole entry instead of
// `qty` units, _invAdd refuses to merge into an existing stack, and a room
// check thinks a stackable needs a fresh slot. That is how depositing 5
// осколки into clan storage could delete a stack of 5000 (see
// clanStorageDeposit's cross-session branch, which passed exactly such a bare
// {id}). Resolving the slot from the catalog when the caller didn't carry one
// makes all three read the same way no matter which shape reached them.
function _itemSlotOf(item) {
  if (!item) return undefined;
  if (item.slot !== undefined) return item.slot;
  const base = _catalogBase(item.id);
  return base ? base.slot : undefined;
}

function _isStackable(item) {
  return !!item && isStackableItem({ slot: _itemSlotOf(item) });
}

// Does `inv` hold at least `qty` of this item (matching enhance level for
// enhanceable gear, which is what makes two otherwise-identical swords
// different)? Returns the matching entry's index, or -1.
function _invFindOwned(inv, item) {
  if (!Array.isArray(inv)) return -1;
  const wantEnh = ENHANCEABLE_SLOTS.has(_itemSlotOf(item)) ? (item.enhance || 0) : null;
  const wantQty = _isStackable(item) ? (item.qty || 1) : 1;
  return inv.findIndex(i =>
    i && i.id === item.id &&
    (wantEnh === null || (i.enhance || 0) === wantEnh) &&
    ((i.qty || 1) >= wantQty));
}

// Removes `item` (respecting stack quantity) from `inv` in place. Caller must
// have checked _invFindOwned first. Returns true when something was removed.
function _invRemove(inv, item) {
  const idx = _invFindOwned(inv, item);
  if (idx < 0) return false;
  const entry = inv[idx];
  if (_isStackable(item)) {
    const take = item.qty || 1;
    const have = entry.qty || 1;
    if (have > take) entry.qty = have - take;
    else inv.splice(idx, 1);
  } else {
    inv.splice(idx, 1);
  }
  return true;
}

// Adds `item` to `inv` in place. Returns false when there's no room — the
// caller must then refuse the trade rather than silently destroying the item.
function _invAdd(inv, item) {
  if (_isStackable(item)) {
    const existing = inv.find(i => i && i.id === item.id);
    if (existing) { existing.qty = (existing.qty || 1) + (item.qty || 1); return true; }
  }
  if (inv.length >= SERVER_INV_MAX) return false;
  inv.push({ ...item });
  return true;
}

// Would _invAdd succeed for this item? A stackable rides in for free ONLY when
// a stack of it already exists — with no existing stack it needs a slot just
// like a non-stackable does. Callers that tested `!isStackableItem(item) &&
// full` instead were letting exactly that case through, and since the item was
// by then already paid for (marketBuy) or already off the listing
// (marketCancel), _invAdd's refusal destroyed it. pickupWorldDrop worked this
// out first; this is that check, in one place, for everyone.
// A null/absent inventory answers false: "no room" is the safe reading, and
// every caller here refuses the trade rather than proceeding without one.
function _invHasRoomFor(inv, item) {
  if (!Array.isArray(inv) || !item) return false;
  if (_isStackable(item) && inv.some(i => i && i.id === item.id)) return true;
  return inv.length < SERVER_INV_MAX;
}

module.exports = {
  // The market's own bounds moved here with the price floors, but
  // server/index.js is where they are USED — exporting them is what that split
  // forgot, and every marketList/marketMyListings call has thrown a
  // ReferenceError since.
  MARKET_MIN_PRICE, MARKET_MAX_PRICE, MARKET_FEE_PCT, MARKET_MAX_ACTIVE, MARKET_MAX_ACTIVE_VIP_LEVEL,
  MARKET_MAX_ACTIVE_VIP,
  MARKET_MAX_QTY,
  MARKET_LIST_COOLDOWN_MS,
  _round2, _round7, _canonicalMarketItem, _marketMinPrice,
  _itemSlotOf, _isStackable, _invFindOwned, _invRemove, _invAdd, _invHasRoomFor,
};
