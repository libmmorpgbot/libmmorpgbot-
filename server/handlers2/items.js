'use strict';
// ── Item handlers ───────────────────────────────────────────────────────────
// Compare this file with the one it replaces (server/handlers/items.js, 502
// lines). Almost none of what went away was game logic — it was the machinery
// around a mutable session copy of the inventory: _itemsFor(), _itemsBusy(),
// _commitServerItems(), the beforeLen bookkeeping, the "did the account
// reconnect on another socket" branches, the inventorySync after every path
// because the client had to be told what the server now believed.
//
// Every one of those existed to keep two copies of an inventory in step. There
// is one copy now, in the database, so they are deleted rather than ported.
//
// What is left is the shape of every handler here: validate what the CLIENT is
// allowed to name (a row id, a slot name), hand it to the repository inside a
// transaction, push the result back. The repository owns the rule; the handler
// owns the conversation.

const items = require('../db/repos/items');
const consumables = require('../db/repos/consumables');
const players = require('../db/repos/players');
const { CODEX_SETS, ITEM_DEF } = require('../../shared/definitions');

// The equipment slots that exist. A slot name arrives from the client, and it
// reaches a UNIQUE INDEX — an unknown one would be stored happily and then
// occupy a slot nothing can ever unequip.
const EQ_SLOTS = new Set(['weapon', 'helmet', 'body', 'gloves', 'boots', 'ring', 'belt', 'pet', 'cloak', 'artifact']);

module.exports = function registerItems(s, safeOn) {
  const push = async (t) => { await s.pushItems(t); await s.pushStats(t); };

  // ── equip ────────────────────────────────────────────────────────────────
  // The client names a ROW and a SLOT. It cannot name an item — that
  // distinction is the whole of the fix: a row either belongs to this player
  // or the UPDATE matches nothing.
  //
  // Swapping is two moves in one transaction. The old version pushed the
  // displaced item back into the inventory array by hand and had a comment
  // explaining why that could never need room ("the swap is always net-zero").
  // Here it genuinely cannot half-happen, so the reasoning is not needed.
  safeOn('equipItem', (ref = {}) => s.act('equipItem', 'itemError', async (t, pid) => {
    await items.lockPlayer(t, pid);
    const row = await items.resolveRow(t, pid, ref, 'inventory');
    if (!row) return;

    const inv = await items.inventoryOf(t, pid);
    const target = inv.inventory.find(i => i.rowId === row);
    if (!target) throw Object.assign(new Error('Предмет не найден'), { userMessage: 'Предмет не найден' });

    // The SLOT is the catalog's answer, not the client's. The shipped client
    // does not send one at all, and a client that did could ask for a helmet in
    // the weapon slot — which is a stat bonus applied twice over.
    const slot = (ITEM_DEF.find(d => d.id === target.id) || {}).slot;
    if (!EQ_SLOTS.has(slot)) {
      throw Object.assign(new Error('not equipment'), { userMessage: 'Этот предмет нельзя надеть' });
    }

    const occupying = inv.equipment[slot];
    if (occupying) {
      if (!await items.moveTo(t, occupying.rowId, pid, 'inventory')) {
        throw Object.assign(new Error('full'), { userMessage: 'Инвентарь полон' });
      }
    }
    if (!await items.moveTo(t, row, pid, 'equipment', slot)) {
      throw Object.assign(new Error('cannot equip'), { userMessage: 'Не удалось надеть предмет' });
    }
    await push(t);
  }));

  safeOn('unequipItem', ({ slot } = {}) => s.act('unequipItem', 'itemError', async (t, pid) => {
    if (!EQ_SLOTS.has(slot)) return;
    await items.lockPlayer(t, pid);
    const inv = await items.inventoryOf(t, pid);
    const it = inv.equipment[slot];
    if (!it) return;
    // Refusing rather than destroying: a full inventory is the player's
    // problem to solve, not a reason to delete their gear.
    if (!await items.moveTo(t, it.rowId, pid, 'inventory')) {
      throw Object.assign(new Error('full'), { userMessage: 'Инвентарь полон' });
    }
    await push(t);
  }));

  // ── storage ──────────────────────────────────────────────────────────────
  safeOn('storageDeposit', (ref = {}) => s.act('storageDeposit', 'itemError', async (t, pid) => {
    await items.lockPlayer(t, pid);
    const row = await items.resolveRow(t, pid, ref, 'inventory');
    if (!row) return;
    if (!await items.moveTo(t, row, pid, 'storage')) {
      throw Object.assign(new Error('no'), { userMessage: 'Предмет не найден' });
    }
    await push(t);
  }));

  // The index here counts into the STORAGE list, not the inventory — the two
  // panels are separate and the client numbers each from zero.
  safeOn('storageWithdraw', (ref = {}) => s.act('storageWithdraw', 'itemError', async (t, pid) => {
    await items.lockPlayer(t, pid);
    const row = await items.resolveRow(t, pid, ref, 'storage');
    if (!row) return;
    if (!await items.moveTo(t, row, pid, 'inventory')) {
      throw Object.assign(new Error('full'), { userMessage: 'Инвентарь полон' });
    }
    await push(t);
  }));

  // ── consumables ──────────────────────────────────────────────────────────
  // No `amount` parameter anywhere. That is the C2 fix stated as an API: the
  // client says WHICH potion, the catalog says what it does.
  safeOn('usePotion', ({ id } = {}) => s.act('usePotion', 'itemError', async (t, pid) => {
    const res = await consumables.usePotion(t, pid, String(id || ''));
    // The bag count, not the inventory: healing potions are not rows. And the
    // room is told the new HP, because the room is what decides whether the
    // next hit kills.
    s.socket.emit('potionBag', { potionBag: await consumables.potionBagOf(t, pid) });
    if (s.room) s.room.setPlayerHp(s.socket.id, res.hp);
  }));

  safeOn('useBuffPotion', ({ id } = {}) => s.act('useBuffPotion', 'itemError', async (t, pid) => {
    const res = await consumables.useBuffPotion(t, pid, String(id || ''));
    await s.pushItems(t);
    // Stats are re-derived because a buff changes them, and the client is told
    // the result rather than applying the multiplier itself.
    await s.pushStats(t);
    s.socket.emit('buffSync', { buffs: res.buffs });
  }));

  // ── world drops ──────────────────────────────────────────────────────────
  // The room decides WHETHER this player may take this drop (it owns distance,
  // party rules and whether the drop is still on the floor); the repository
  // performs the grant. Splitting it that way keeps the ownership rule in one
  // place and the geometry in another.
  safeOn('pickupWorldDrop', ({ id } = {}) => s.act('pickupWorldDrop', 'worldDropError', async (t, pid) => {
    if (!s.room) return;
    const claim = s.room.claimDrop(s.socket.id, id);
    if (!claim) return;                       // gone, too far, or not theirs
    try {
      await consumables.pickupDrop(t, pid, claim.id, claim.qty || 1, claim.enhance || 0);
      await push(t);
      s.socket.emit('worldDropPicked', { id, item: claim.item || claim, delivered: true });
    } catch (err) {
      // Put it back on the floor: a refused pickup must not destroy the drop,
      // and the transaction rolling back does not un-claim it in the room.
      s.room.returnDrop(claim);
      throw err;
    }
  }));

  // ── codex ────────────────────────────────────────────────────────────────
  safeOn('registerCodexSetItem', ({ setId, slotIdx, idx, id = null, enhance = null } = {}) =>
    s.act('registerCodexSetItem', 'itemError', async (t, pid) => {
      if (typeof setId !== 'string') return;
      await items.lockPlayer(t, pid);
      const row = await items.resolveRow(t, pid, { idx, id, enhance }, 'inventory');
      if (!row) return;
      const res = await consumables.registerCodexItem(t, pid, setId, slotIdx, row);
      await push(t);
      s.socket.emit('codexSync', { codex: res.codex, bonus: res.bonus, complete: res.complete });
    }));

  // ── progression the client asks for, the server decides ──────────────────
  safeOn('spendUpgrade', ({ key } = {}) => s.act('spendUpgrade', 'itemError', async (t, pid) => {
    const res = await players.spendUpgrade(t, pid, String(key || ''));
    if (!res) throw Object.assign(new Error('no points'), { userMessage: 'Нет свободных очков' });
    await s.pushProgress(t);
    await s.pushStats(t);
  }));

  // Read-only: what sets exist, so the client can render the codex tab without
  // shipping 984 set definitions it already has in the bundle. Kept as a
  // handler because the completion state is server-owned.
  safeOn('codexSync', () => s.act('codexSync', 'itemError', async (t, pid) => {
    const prog = await players.progressOf(t, pid);
    s.socket.emit('codexSync', {
      codex: prog.codex,
      bonus: require('../../shared/definitions').codexTotalBonus(prog.codex),
      sets: CODEX_SETS.length,
    });
  }));
};
