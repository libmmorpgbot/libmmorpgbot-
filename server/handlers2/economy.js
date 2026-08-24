'use strict';
// ── Crafting, the merchant, the market, GRAM ────────────────────────────────
// The four handlers that move value. In the build this replaces they are the
// four largest files (craft 752 lines, market 532, gram 428, items 502) and the
// bulk of each is compensation: a refund after a failed delivery, a re-listing
// after a failed removal, a "did the account reconnect" branch before every
// write. Every one of those is a step that can itself fail, and several of them
// WERE the bug rather than the fix.
//
// None of it appears here, because a throw rolls the transaction back. What is
// left is: check what the client may name, call the repository, push the truth.

const craft = require('../db/repos/craft');
const items = require('../db/repos/items');
const market = require('../db/repos/market');
const gram = require('../db/repos/gram');
const money = require('../db/repos/money');
const progression = require('../db/repos/progression');
const consumables = require('../db/repos/consumables');
const ops = require('../tg-ops');
const cards = require('../ops-cards');
const {
  GRAM_MIN_WITHDRAW, MARKET_FEE_PCT, GEAR_CRAFT_RECIPES, ITEM_DEF, MERCHANT_SHOP,
} = require('../../shared/definitions');
const { _GRAM_WITHDRAW_FEE_PCT } = require('../shop');

const rowId = v => {
  const n = Math.floor(Number(v));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const idx = v => {
  const n = Math.floor(Number(v));
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

module.exports = function registerEconomy(s, safeOn, deps) {
  const pushAll = async (t) => { await s.pushItems(t); await s.pushBalances(t); await s.pushStats(t); };

  // ── crafting ─────────────────────────────────────────────────────────────
  // Six families, one repository function each, and the wire names the client
  // already speaks. The generic `craft` below stays because it is the honest
  // interface — a family and a recipe — but the client asks for gear by the
  // ITEM it wants, pets by rarity, salvage by slot, and it will keep doing that
  // until the client is rewritten. Renaming the events instead would have meant
  // shipping a server the existing bundle cannot talk to.
  //
  // Every one of these answers with the fresh Liberty balance, because that is
  // what the client's handlers read. `pushBalances` already sent the truth a
  // line earlier; this is the same number in the shape the UI expects.
  const nexumOf = async (t, pid) => (await money.balancesOf(t, pid)).nexum;

  // Gear, named by the item it produces. Three recipe lists can make gear and
  // the resolver searches them in the order the old handler did, so an id that
  // appears twice resolves the way it always has.
  safeOn('craftGear', ({ itemId } = {}) => s.act('craftGear', 'craftGearError', async (t, pid) => {
    if (typeof itemId !== 'string' || !itemId) return;
    const { family, index } = craft.gearRecipeByItemId(itemId);
    const res = await craft.craft(t, pid, family, index);
    await pushAll(t);
    s.socket.emit('gearCrafted', {
      itemId, success: res.outcome === 'success', newNexumBalance: await nexumOf(t, pid),
    });
  }));

  safeOn('craftPet', ({ rarity } = {}) => s.act('craftPet', 'petCraftError', async (t, pid) => {
    if (typeof rarity !== 'string' || !rarity) return;
    const res = await craft.craftPet(t, pid, rarity);
    await pushAll(t);
    // The client wants the pet's catalog entry, not just its id — it draws the
    // reward card from it before the inventory panel is next opened.
    const pet = res.outcome === 'success' ? ITEM_DEF.find(d => d.id === res.itemId) : null;
    s.socket.emit('petCrafted', {
      pet, newNexumBalance: await nexumOf(t, pid), delivered: res.outcome === 'success',
    });
  }));

  safeOn('craftClassGear', ({ slot, rarity } = {}) =>
    s.act('craftClassGear', 'craftClassGearError', async (t, pid) => {
      if (typeof slot !== 'string' || typeof rarity !== 'string') return;
      const res = await craft.craftClassGear(t, pid, slot, rarity);
      await pushAll(t);
      const item = ITEM_DEF.find(d => d.id === res.itemId) || null;
      s.socket.emit('classGearCrafted', {
        item, newNexumBalance: await nexumOf(t, pid), delivered: !!item,
      });
    }));

  safeOn('craftMatUpgrade', ({ from } = {}) =>
    s.act('craftMatUpgrade', 'craftMatUpgradeError', async (t, pid) => {
      if (typeof from !== 'string' || !from) return;
      const res = await craft.upgradeMat(t, pid, from);
      await pushAll(t);
      s.socket.emit('matUpgraded', { from: res.from, to: res.to, success: res.outcome === 'success' });
    }));

  safeOn('craftBox', ({ boxId } = {}) => s.act('craftBox', 'craftBoxError', async (t, pid) => {
    if (typeof boxId !== 'string' || !boxId) return;
    const res = await craft.craftBox(t, pid, boxId);
    await pushAll(t);
    s.socket.emit('boxCrafted', { boxId: res.boxId });
  }));

  // No payload: the recipe is "any ten skill books" and the result is rolled
  // here. The version this replaces took a `key` and tried to build the book id
  // from it, which is not what the table describes — see repos/craft.js.
  safeOn('craftAdvSkillBook', () =>
    s.act('craftAdvSkillBook', 'craftAdvSkillBookError', async (t, pid) => {
      const res = await craft.craftAdvSkillBook(t, pid);
      await pushAll(t);
      s.socket.emit('advSkillBookCrafted', {
        success: res.outcome === 'success', id: res.itemId || null,
      });
    }));

  // Enchant stones stopped being craftable before this port, and the refusal is
  // kept rather than dropped: the button is still in the shipped client, and a
  // handler that does not exist leaves it spinning with no explanation.
  safeOn('craftStone', () => {
    s.socket.emit('craftStoneError', { msg: 'Камни заточки больше не создаются в кузнице' });
  });

  // ── merchant: teleport stones ────────────────────────────────────────────
  safeOn('buyTeleportStone', ({ qty } = {}) =>
    s.act('buyTeleportStone', 'teleportStoneError', async (t, pid) => {
      const res = await consumables.buyTeleportStone(t, pid, qty);
      await pushAll(t);
      s.socket.emit('teleportStoneBought', {
        qty: res.qty, newNexumBalance: await nexumOf(t, pid), delivered: true,
      });
    }));

  // ── enhancement ──────────────────────────────────────────────────────────
  // Named by ROW, not by (id, enhance). The old handler searched the inventory
  // for something matching both, which is ambiguous the moment a player holds
  // two of the same item — and it carries a whole investigation path built for
  // when that search found the wrong one.
  // The client names it by identity plus, for something worn, the slot it is
  // worn in. An equipped item is unambiguous by its slot; two identical items
  // in the bag are interchangeable UNTIL one is enhanced, which is why the
  // client sends the slot at all.
  safeOn('enhanceItem', ({ id, enhance, stoneType, slot } = {}) =>
    s.act('enhanceItem', 'enhanceError', async (t, pid) => {
    await items.lockPlayer(t, pid);
    const row = slot
      ? await items.resolveRow(t, pid, { slot }, 'equipment')
      : await items.resolveRow(t, pid, { id, enhance }, 'inventory');
    if (!row) throw Object.assign(new Error('gone'), { userMessage: 'Предмет не найден — список обновлён' });
    const res = await craft.enhance(t, pid, row, stoneType === 'bless' ? 'bless' : 'norm');
    await pushAll(t);
    s.socket.emit('enhanceResult', res);
  }));

  // ── boxes ────────────────────────────────────────────────────────────────
  safeOn('openLootBox', ({ id } = {}) => s.act('openLootBox', 'openBoxError', async (t, pid) => {
    const res = await craft.openBox(t, pid, String(id || ''));
    await pushAll(t);
    s.socket.emit('boxOpened', res);
  }));

  // ── merchant ─────────────────────────────────────────────────────────────
  // `idx` counts into MERCHANT_SHOP, the table the client renders — not into
  // anything the client owns, so the position is authoritative here in a way it
  // never is for an inventory.
  safeOn('buyPotion', ({ idx: shopIdx, qty } = {}) => s.act('buyPotion', 'goldError', async (t, pid) => {
    const i = idx(shopIdx);
    const entry = i === null ? null : MERCHANT_SHOP[i];
    if (!entry) return;
    const res = await consumables.buyPotions(t, pid, entry.itemId, qty);
    await s.pushBalances(t);
    s.socket.emit('potionBag', { potionBag: res.potionBag, bought: { id: res.itemId, n: res.qty } });
  }));

  safeOn('sellItem', ({ idx: at, id, enhance, qty = 1 } = {}) => s.act('sellItem', 'shopError', async (t, pid) => {
    await items.lockPlayer(t, pid);
    const row = await items.resolveRow(t, pid, { idx: at, id, enhance }, 'inventory');
    if (!row) throw Object.assign(new Error('gone'), { userMessage: 'Предмет не найден — список обновлён' });
    const res = await craft.sellItem(t, pid, row, qty);
    await pushAll(t);
    s.socket.emit('itemSold', { gold: res.gold, newGold: res.goldLeft });
  }));

  // ── market ───────────────────────────────────────────────────────────────
  // `item` is the client's own copy of the row it wants to sell — the same
  // object the server pushed, so it carries rowId, id and enhance. Only the
  // identity is used; every number in it (price floor, rarity, stats) is
  // re-read from the database.
  safeOn('marketList', ({ item, price } = {}) => s.act('marketList', 'marketListError', async (t, pid) => {
    await items.lockPlayer(t, pid);
    const row = await items.resolveRow(t, pid, item || {}, 'inventory');
    if (!row) throw Object.assign(new Error('gone'), { userMessage: 'Предмет не найден — список обновлён' });
    const vip = await progression.vipOf(t, pid);
    const res = await market.list(t, pid, row, price, { vipLevel: vip.level });
    await pushAll(t);
    s.socket.emit('marketListed', { listing: res.listing || res });
  }));

  safeOn('marketCancel', ({ listingId } = {}) => s.act('marketCancel', 'marketError', async (t, pid) => {
    const id = rowId(listingId);
    if (!id) return;
    const res = await market.cancel(t, pid, id);
    await pushAll(t);
    s.socket.emit('marketCancelled', res);
  }));

  // The buy path. Everything that used to be five branches and a refund is one
  // call — money, item and listing move together or none of them does.
  safeOn('marketBuy', ({ listingId } = {}) => s.act('marketBuy', 'marketError', async (t, pid) => {
    const id = rowId(listingId);
    if (!id) return;
    const res = await market.buy(t, pid, id);
    await pushAll(t);
    s.socket.emit('marketBought', res);

    // Tell the seller, if they are online. Best-effort: a seller who is
    // offline must not fail someone else's purchase, and their balance is
    // already correct in the database either way — this is a notification,
    // not the payment.
    const sellerSock = deps.socketForPlayerId && deps.socketForPlayerId(res.sellerId);
    if (sellerSock) {
      sellerSock.emit('marketSold', { listingId: res.listingId, payout: res.payout, fee: res.fee });
    }
  }));

  safeOn('marketBrowse', ({ slot = null, offset = 0 } = {}) => s.act('marketBrowse', 'marketError', async (t) => {
    s.socket.emit('marketBrowseData', await market.browse(t, {
      slot: typeof slot === 'string' ? slot : null,
      offset: idx(offset) || 0,
    }));
  }));

  safeOn('marketMyListings', () => s.act('marketMyListings', 'marketError', async (t, pid) => {
    s.socket.emit('marketMyListingsData', { listings: await market.mine(t, pid) });
  }));

  safeOn('marketHistory', () => s.act('marketHistory', 'marketError', async (t, pid) => {
    s.socket.emit('marketHistoryData', await market.history(t, pid));
  }));

  // ── GRAM ─────────────────────────────────────────────────────────────────
  // A deposit is an INTENT now. The client asks for an address and a memo; it
  // does not state an amount, because the amount is whatever arrives on the
  // chain. That single change is what retires "send 0.1 TON, request 1000
  // GRAM, hope the admin is tired".
  safeOn('gramDepositRequest', () => s.act('gramDepositRequest', 'gramError', async (t, pid) => {
    const intent = await gram.createIntent(t, pid);
    s.socket.emit('gramTxCreated', { tx: intent, newBalance: (await money.balancesOf(t, pid)).gram });
  }));

  safeOn('gramWithdrawRequest', ({ amount, address } = {}) =>
    s.act('gramWithdrawRequest', 'gramError', async (t, pid) => {
      const vip = await progression.vipOf(t, pid);
      if (vip.level < 3) {
        throw Object.assign(new Error('vip'), { userMessage: 'Вывод GRAM доступен с VIP 3' });
      }
      const req = await gram.requestWithdraw(t, pid, amount, address, {
        minAmount: GRAM_MIN_WITHDRAW, feePct: _GRAM_WITHDRAW_FEE_PCT,
      });
      await s.pushBalances(t);
      s.socket.emit('gramTxCreated', { tx: req, newBalance: (await money.balancesOf(t, pid)).gram });
      return req;
    }).then(async (req) => {
      // Posted AFTER the transaction commits. Sending the admin card from
      // inside would announce a request that a later rollback un-made.
      if (!req) return;
      const w = await cards.loadWithdraw(req.id, _GRAM_WITHDRAW_FEE_PCT);
      if (w) await cards.postWithdrawRequest(w);
    }));

  safeOn('gramGetHistory', () => s.act('gramGetHistory', 'gramError', async (t, pid) => {
    s.socket.emit('gramHistory', { txs: await gram.historyOf(t, pid) });
  }));

};
