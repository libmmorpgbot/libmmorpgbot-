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
// ── что вообще можно надеть ──────────────────────────────────────────────
// Выводится из каталога, а не выписывается руками. Руками здесь стоял список
// из десяти слотов, и крылья в него просто не попали: предмет есть, слот есть,
// панель его рисует — а сервер отвечает «этот предмет нельзя надеть».
//
// Два перечня одного и того же обязаны разойтись, вопрос только когда.
// Каталог — единственное место, где слот предмета объявлен, поэтому и ответ
// на «надевается ли» берётся оттуда.
//
// 'use', 'recipe', 'box' и прочее сюда не попадают по построению: у них слот
// свой и в снаряжение он не входит (см. NOT_EQUIPPABLE).
const NOT_EQUIPPABLE = new Set(['use', 'buff_potion', 'recipe', 'box', 'mat', 'book', 'shard']);
const EQ_SLOTS = new Set(
  ITEM_DEF.map(d => d.slot).filter(sl => sl && !NOT_EQUIPPABLE.has(sl)));

// ── why a refusal throws instead of returning ───────────────────────────────
// act() decides what to write from whether the handler THREW. A bare `return;`
// looks exactly like a handler that ran to the end, so it wrote a success row
// into player_logs for an action that moved nothing — a row saying this player
// equipped an item, deposited into storage or registered a set piece, when none
// of it happened. That is worse than the silence it replaced: an operator
// reading the log believes it.
//
// Throwing with a userMessage puts a `refuse:<action>` row in instead, with the
// code and the text the player saw, and hands the client its own error event so
// the button it disabled comes back.
const fail = (msg, code) => { throw Object.assign(new Error(code || msg), { userMessage: msg, code }); };

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
    if (!row) fail('Предмет не найден — список обновлён', 'not_found');

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
    if (!EQ_SLOTS.has(slot)) fail('Неизвестный слот', 'bad_slot');
    await items.lockPlayer(t, pid);
    const inv = await items.inventoryOf(t, pid);
    const it = inv.equipment[slot];
    if (!it) fail('В этом слоте ничего нет', 'empty_slot');
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
    if (!row) fail('Предмет не найден — список обновлён', 'not_found');
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
    if (!row) fail('Предмет не найден — список обновлён', 'not_found');
    if (!await items.moveTo(t, row, pid, 'inventory')) {
      throw Object.assign(new Error('full'), { userMessage: 'Инвентарь полон' });
    }
    await push(t);
  }));

  // ── consumables ──────────────────────────────────────────────────────────
  // No `amount` parameter anywhere. That is the C2 fix stated as an API: the
  // client says WHICH potion, the catalog says what it does.
  safeOn('usePotion', ({ id } = {}) => s.act('usePotion', 'itemError', async (t, pid) => {
    // HP берётся из комнаты — это живое число, которым считаются урон и смерть.
    // player_progress.hp отстаёт до двадцати секунд, и лечение от него давало
    // «то фулл, то ничего» (см. разбор над consumables.usePotion).
    const me = s.room && s.room.players.get(s.socket.id);
    const res = await consumables.usePotion(t, pid, String(id || ''),
      me ? me.hp : null);
    // The bag count, not the inventory: healing potions are not rows. And the
    // room is told the new HP, because the room is what decides whether the
    // next hit kills.
    s.socket.emit('potionBag', { potionBag: await consumables.potionBagOf(t, pid) });
    if (s.room) s.room.setPlayerHp(s.socket.id, res.hp);
    return res;
  }, r => r && { зелье: r.potionId, вылечено: r.healed, стало: r.hp, осталось: r.left }));

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
    // Both of these were bare returns, and pickupWorldDrop is a WRITE_ACTION —
    // so every pile somebody lost the race for wrote a row saying they PICKED
    // IT UP. A boss killed by a party produces sixty piles and five losers per
    // pile, which is three hundred rows a fight claiming an item entered an
    // account that never received one. The log for the one player who really
    // got it was indistinguishable from the four who did not.
    if (!s.room) fail('Вы не на карте — перезайдите', 'no_room');
    const claim = s.room.claimDrop(s.socket.id, id);
    // Gone, expired, or out of the server's (generous) range. The client draws
    // the pile until it is told otherwise, so this has to come back as a reason
    // rather than as nothing — see 'кто успел, тот забрал' in Room.claimWorldDrop.
    if (!claim) fail('Добыча уже подобрана или слишком далеко', 'gone');
    try {
      // THE DROP AND THE ITEM ARE TWO DIFFERENT THINGS. A drop is a pile on
      // the floor: `{ id: 'wd_7', x, y, item, expiresAt }`. What goes into an
      // inventory is `claim.item` — `{ id: 'key_uncommon', qty, enhance }`.
      //
      // This passed `claim.id`, so every pickup asked the catalog for an item
      // called "wd_7". hasRoomFor answers false for an id it does not know,
      // and pickupDrop reports that as 'Инвентарь полон' — so a boss killed by
      // a party dropped sixty piles that every one of them was told they had
      // no room for, with a full inventory of two items. `qty` and `enhance`
      // were read off the drop as well, where they have never existed: even a
      // pickup that had somehow worked would have delivered one unenhanced
      // copy of a ten-item stack.
      const it = claim.item || {};
      if (!it.id) throw Object.assign(new Error('drop has no item'), {
        userMessage: 'Эта добыча повреждена — сообщите админам',
      });
      await consumables.pickupDrop(t, pid, it.id, it.qty || 1, it.enhance || 0);
      await push(t);
      s.socket.emit('worldDropPicked', { id, item: it, delivered: true });
    } catch (err) {
      // Put it back on the floor: a refused pickup must not destroy the drop,
      // and the transaction rolling back does not un-claim it in the room.
      s.room.returnDrop(claim);
      throw err;
    }
  }));

  // ── codex ────────────────────────────────────────────────────────────────
  safeOn('registerCodexSetItem', ({ setId, slotIdx, idx, id = null, enhance = null, rowId = null } = {}) =>
    s.act('registerCodexSetItem', 'itemError', async (t, pid) => {
      if (typeof setId !== 'string') fail('Набор не выбран', 'bad_set');
      await items.lockPlayer(t, pid);
      // rowId FIRST. This DESTROYS the item, and the client's confirmation
      // names it by hand — "Внести «Меч +8»? Предмет будет уничтожен без
      // возврата". An index alone means whatever occupies that position when
      // the message lands, and a kill between the dialog and the click
      // renumbers the list.
      // This is the row that DESTROYS an item, so a false success here is the
      // most expensive one in the file: "Внести «Меч +8»?" answered by a log
      // line saying the sword was consumed by the codex, when the resolve found
      // nothing and the sword is still — or is no longer — somewhere else.
      // Whoever reads that row stops looking, which is the whole cost.
      const row = await items.resolveRow(t, pid, { rowId, idx, id, enhance }, 'inventory');
      if (!row) fail('Предмет не найден — список обновлён', 'not_found');
      const res = await consumables.registerCodexItem(t, pid, setId, slotIdx, row);
      await push(t);
      s.socket.emit('codexSync', { codex: res.codex, bonus: res.bonus, complete: res.complete });
      // What was destroyed and where it went. Registering is irreversible.
      return { setId, slotIdx, rowId: row, complete: res.complete };
    }, r => r && { setId: r.setId, slotIdx: r.slotIdx, rowId: r.rowId, complete: r.complete }));

  // ── progression the client asks for, the server decides ──────────────────
  safeOn('spendUpgrade', ({ key } = {}) => s.act('spendUpgrade', 'itemError', async (t, pid) => {
    const res = await players.spendUpgrade(t, pid, String(key || ''));
    // Two different refusals arrive as the same null: no free point, and not
    // enough gold now that upgradeCost() is actually charged (repos/players.js).
    // Naming only the first would put a reason in the player's face — and in
    // the `refuse:spendUpgrade` row — that is wrong half the time.
    if (!res) {
      throw Object.assign(new Error('cannot upgrade'),
        { userMessage: 'Не хватает очков или золота', code: 'no_points_or_gold' });
    }
    await s.pushProgress(t);
    await s.pushStats(t);
    // A point costs GOLD now. Without this the counter on screen kept the
    // number it had before the purchase — too high, and staying too high until
    // some unrelated push corrected it, which reads as "золото не списалось".
    await s.pushBalances(t);
    return res;
    // Which point, and what it cost. The price climbs with the level already
    // bought, so "почему так дорого" is only answerable if the row says which
    // step was paid for.
  }, r => r && { key: r.key, level: r.level, cost: r.cost, gold: r.gold }));

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
