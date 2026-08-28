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
const cards = require('../ops-cards');
const {
  GRAM_MIN_WITHDRAW, ITEM_DEF, MERCHANT_SHOP,
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

// ── why a bad payload throws instead of returning ───────────────────────────
// Every `return;` below used to be a bare one, and act() cannot tell a handler
// that decided to do nothing from a handler that finished: it sees no throw, so
// it writes the success row. A client that sent `marketBuy` with a malformed
// listingId produced a player_logs row saying the purchase happened — evidence
// that is worse than silence, because somebody reading it later believes it.
//
// A refusal is recorded as `refuse:<action>` with the code and the message the
// player saw (see act(), server/session.js), and the client gets its own error
// event back so the button it disabled comes alive again. Same helper the other
// three handler files already use.
const fail = (msg, code) => { throw Object.assign(new Error(code || msg), { userMessage: msg, code }); };

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
  // ── what a craft row has to say ──────────────────────────────────────────
  // A craft either produced an item or ate the materials for nothing, and the
  // row used to record the word 'craftGear' for both. `outcome` is the whole
  // difference between "он получил" and "он потратил" — and `itemId` is what
  // the question is usually about.
  const craftMeta = r => r && {
    outcome: r.outcome, itemId: r.itemId, family: r.family, index: r.index,
    chance: r.chance, rarity: r.rarity, slot: r.slot,
  };

  safeOn('craftGear', ({ itemId } = {}) => s.act('craftGear', 'craftGearError', async (t, pid) => {
    if (typeof itemId !== 'string' || !itemId) fail('Не выбран предмет для ковки', 'bad_item');
    const { family, index } = craft.gearRecipeByItemId(itemId);
    const res = await craft.craft(t, pid, family, index);
    await pushAll(t);
    s.socket.emit('gearCrafted', {
      itemId, success: res.outcome === 'success', newNexumBalance: await nexumOf(t, pid),
    });
    return res;
  }, craftMeta));

  safeOn('craftPet', ({ rarity } = {}) => s.act('craftPet', 'petCraftError', async (t, pid) => {
    if (typeof rarity !== 'string' || !rarity) fail('Не выбрана редкость питомца', 'bad_rarity');
    const res = await craft.craftPet(t, pid, rarity);
    await pushAll(t);
    // The client wants the pet's catalog entry, not just its id — it draws the
    // reward card from it before the inventory panel is next opened.
    const pet = res.outcome === 'success' ? ITEM_DEF.find(d => d.id === res.itemId) : null;
    s.socket.emit('petCrafted', {
      pet, newNexumBalance: await nexumOf(t, pid), delivered: res.outcome === 'success',
    });
    return res;
  }, craftMeta));

  safeOn('craftClassGear', ({ slot, rarity } = {}) =>
    s.act('craftClassGear', 'craftClassGearError', async (t, pid) => {
      if (typeof slot !== 'string' || typeof rarity !== 'string') {
        fail('Не выбран слот или редкость', 'bad_recipe');
      }
      const res = await craft.craftClassGear(t, pid, slot, rarity);
      await pushAll(t);
      const item = ITEM_DEF.find(d => d.id === res.itemId) || null;
      s.socket.emit('classGearCrafted', {
        item, newNexumBalance: await nexumOf(t, pid), delivered: !!item,
      });
      return res;
    }, craftMeta));

  safeOn('craftMatUpgrade', ({ from } = {}) =>
    s.act('craftMatUpgrade', 'craftMatUpgradeError', async (t, pid) => {
      if (typeof from !== 'string' || !from) fail('Не выбран материал', 'bad_material');
      const res = await craft.upgradeMat(t, pid, from);
      await pushAll(t);
      s.socket.emit('matUpgraded', { from: res.from, to: res.to, success: res.outcome === 'success' });
      return res;
    }, r => r && { outcome: r.outcome, from: r.from, to: r.to, spent: r.spent, chance: r.chance }));

  safeOn('craftBox', ({ boxId } = {}) => s.act('craftBox', 'craftBoxError', async (t, pid) => {
    if (typeof boxId !== 'string' || !boxId) fail('Не выбран сундук', 'bad_box');
    const res = await craft.craftBox(t, pid, boxId);
    await pushAll(t);
    s.socket.emit('boxCrafted', { boxId: res.boxId });
    return res;
  }, r => r && { outcome: r.outcome, boxId: r.boxId, spent: r.spent }));

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
      return res;
    }, r => r && { outcome: r.outcome, itemId: r.itemId, spent: r.spent, chance: r.chance }));

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
  safeOn('enhanceItem', ({ id, enhance, stoneType, slot, rowId } = {}) =>
    s.act('enhanceItem', 'enhanceError', async (t, pid) => {
    await items.lockPlayer(t, pid);
    // rowId FIRST. Two copies of one item at the same enhancement are
    // interchangeable for selling and equipping, and they stop being
    // interchangeable the moment one of them is enhanced — so this is the one
    // action where "whichever row matches" is the wrong answer. It is also the
    // action a player watches closely, which is why it was noticed as "точишь
    // одну вещь, и всё что на неё похоже точится вместе с ней".
    const row = slot
      ? await items.resolveRow(t, pid, { slot }, 'equipment')
      : await items.resolveRow(t, pid, { rowId, id, enhance }, 'inventory');
    if (!row) throw Object.assign(new Error('gone'), { userMessage: 'Предмет не найден — список обновлён' });
    const res = await craft.enhance(t, pid, row, stoneType === 'bless' ? 'bless' : 'norm');
    // Квест «Заточи предмет до +N» — В ТОЙ ЖЕ транзакции, что и сама заточка.
    // Отдельным шагом после неё зачёт мог бы не случиться на удавшемся броске:
    // камень потрачен, вещь заточена, квест стоит. Порог и «только текущий
    // квест» проверяются внутри questOnEnhance.
    if (res && res.outcome === 'success') {
      const _q = await progression.questOnEnhance(t, pid, res.to);
      if (_q) s.socket.emit('questSync', _q);
    }
    await pushAll(t);
    // NAMED FIELDS, not the repository's own object. The client reads
    // `{ id, slot, outcome, newEnhance }` and this used to forward
    // `{ outcome, rowId, from, to, rate }` — so `newEnhance` was undefined,
    // the toast said "Заточка +undefined", and the lookup that reopens the
    // item card (`findIndex(i => i.id === undefined ...)`) found nothing and
    // silently returned. The stone was spent and the item was enhanced;
    // nothing on screen moved. "Все работает правильно, просто ui не меняется."
    //
    // It also explains why reply-shape-check never caught it: that checker
    // reads the KEYS of an emitted object literal, and this emitted a
    // variable, so it counted as unverifiable rather than as a mismatch.
    s.socket.emit('enhanceResult', {
      outcome: res.outcome,
      id: res.itemId,
      rowId: res.rowId,
      slot: slot || null,
      from: res.from,
      to: res.to,
      newEnhance: res.to,
      rate: res.rate,
    });
    return res;
    // ── the row that answers "мій +12 меч згорів" ─────────────────────────
    // This is the action the question is always about, and the one where the
    // three outcomes are indistinguishable from the outside: success, fail and
    // burned all left the same 'enhanceItem' row. Nothing had to be computed
    // for this — the repository already returns every field, and act() threw
    // them away on the way to the log.
  }, r => r && {
    outcome: r.outcome, itemId: r.itemId, rowId: r.rowId,
    from: r.from, to: r.to, rate: r.rate,
  }));

  // ── boxes ────────────────────────────────────────────────────────────────
  safeOn('openLootBox', ({ id } = {}) => s.act('openLootBox', 'openBoxError', async (t, pid) => {
    const res = await craft.openBox(t, pid, String(id || ''));
    await pushAll(t);
    s.socket.emit('boxOpened', res);
    return res;
    // A box is the commonest way a rare item enters an account, so this is the
    // row that answers "откуда у него это" — which is the same question as
    // "куда делось моё", asked from the other side.
  }, r => r && { boxId: r.boxId, rarity: r.rarity, itemId: r.itemId }));

  // ── merchant ─────────────────────────────────────────────────────────────
  // `idx` counts into MERCHANT_SHOP, the table the client renders — not into
  // anything the client owns, so the position is authoritative here in a way it
  // never is for an inventory.
  safeOn('buyPotion', ({ idx: shopIdx, qty } = {}) => s.act('buyPotion', 'goldError', async (t, pid) => {
    const i = idx(shopIdx);
    const entry = i === null ? null : MERCHANT_SHOP[i];
    if (!entry) fail('Такого товара нет у торговца', 'no_entry');
    const res = await consumables.buyPotions(t, pid, entry.itemId, qty);
    await s.pushBalances(t);
    // "Купи 10 зелий" counts here, where the purchase actually happens.
    const q = await progression.questOnEvent(t, pid, 'buy_potion', '_potion', res.qty);
    if (q) s.socket.emit('questSync', q);
    s.socket.emit('potionBag', { potionBag: res.potionBag, bought: { id: res.itemId, n: res.qty } });
    return res;
  }, r => r && { itemId: r.itemId, qty: r.qty }));

  safeOn('sellItem', ({ idx: at, id, enhance, qty = 1 } = {}) => s.act('sellItem', 'sellItemError', async (t, pid) => {
    await items.lockPlayer(t, pid);
    const row = await items.resolveRow(t, pid, { idx: at, id, enhance }, 'inventory');
    if (!row) throw Object.assign(new Error('gone'), { userMessage: 'Предмет не найден — список обновлён' });
    const res = await craft.sellItem(t, pid, row, qty);
    await pushAll(t);
    s.socket.emit('itemSold', { gold: res.gold, newGold: res.goldLeft });
    return res;
    // WHAT was sold and for how much. A sale is irreversible and the item is
    // gone from the bag the instant it happens, so "я не продавал этот меч" has
    // to be answerable from the row alone.
  }, r => r && { itemId: r.itemId, qty: r.qty, gold: r.gold, goldTotal: r.goldTotal }));

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
    return res;
    // The three market rows are the ones an admin reads back most often, because
    // a lot is the only way an item legitimately crosses accounts. Which lot,
    // which item, what price — none of it was recorded.
  }, r => r && { listingId: r.listingId || r.id, price: r.price, item: r.item }));

  safeOn('marketCancel', ({ listingId } = {}) => s.act('marketCancel', 'marketError', async (t, pid) => {
    const id = rowId(listingId);
    if (!id) fail('Лот не найден — список обновлён', 'bad_listing');
    const res = await market.cancel(t, pid, id);
    await pushAll(t);
    s.socket.emit('marketCancelled', res);
    return res;
  }, r => r && { listingId: r.listingId, item: r.item, delivered: r.delivered }));

  // The buy path. Everything that used to be five branches and a refund is one
  // call — money, item and listing move together or none of them does.
  safeOn('marketBuy', ({ listingId } = {}) => s.act('marketBuy', 'marketError', async (t, pid) => {
    const id = rowId(listingId);
    if (!id) fail('Лот не найден — список обновлён', 'bad_listing');
    const res = await market.buy(t, pid, id);
    await pushAll(t);
    // Buying counts toward VIP, and the panel reads its level from this reply.
    const vip = await progression.vipOf(t, pid);
    s.socket.emit('marketBought', {
      ...res,
      vipData: { level: vip.level, deposited: vip.deposited, pending: vip.pending },
    });

    // Tell the seller, if they are online. Best-effort: a seller who is
    // offline must not fail someone else's purchase, and their balance is
    // already correct in the database either way — this is a notification,
    // not the payment.
    const sellerSock = deps.socketForPlayerId && deps.socketForPlayerId(res.sellerId);
    if (sellerSock) {
      // item and price too: the seller's toast names what sold and for how
      // much, and without them it read "Продано: undefined за undefined".
      sellerSock.emit('marketSold', {
        listingId: res.listingId, payout: res.payout, fee: res.fee,
        price: res.price, item: res.item,
      });
      // And the money. The payout was credited inside the transaction above,
      // but the seller was only TOLD that a sale happened — their GRAM counter
      // kept the number it had at login until they reloaded the game.
      //
      // Through the seller's own session, so the balance is read from the
      // database and pushed the one way every other balance is.
      const sellerSess = sellerSock.data && sellerSock.data.session;
      if (sellerSess && sellerSess.authed) {
        sellerSess.pushBalances().catch(err =>
          console.error('[marketBuy] seller balance:', err.message));
      }
    }
    return res;
    // sellerId rides along: this is the one row that records an item leaving
    // one account and arriving on another, and both halves of that are the
    // question when somebody asks how a lot ended up where it did.
  }, r => r && {
    listingId: r.listingId, price: r.price, fee: r.fee,
    item: r.item, sellerId: r.sellerId,
  }));

  safeOn('marketBrowse', ({ slot = null, offset = 0 } = {}) => s.act('marketBrowse', 'marketError', async (t) => {
    // Wrapped, like marketMyListingsData right below. A bare array arrives as
    // `{ listings: undefined }` on the other side, so the market browser was
    // empty no matter what was for sale.
    s.socket.emit('marketBrowseData', {
      listings: await market.browse(t, {
        slot: typeof slot === 'string' ? slot : null,
        offset: idx(offset) || 0,
      }),
    });
  }));

  safeOn('marketMyListings', () => s.act('marketMyListings', 'marketError', async (t, pid) => {
    s.socket.emit('marketMyListingsData', { listings: await market.mine(t, pid) });
  }));

  safeOn('marketHistory', () => s.act('marketHistory', 'marketError', async (t, pid) => {
    s.socket.emit('marketHistoryData', { entries: await market.history(t, pid) });
  }));

  // ── GRAM ─────────────────────────────────────────────────────────────────
  // A deposit is an INTENT now. The client asks for an address and a memo; it
  // does not state an amount, because the amount is whatever arrives on the
  // chain. That single change is what retires "send 0.1 TON, request 1000
  // GRAM, hope the admin is tired".
  //
  // NO PAYLOAD IS READ, and that is the other half of it. A client-supplied
  // memo is the same class of bug as a client-supplied price, only worse:
  // the memo is the ONLY thing that says whose an incoming transfer is (see
  // _memo, repos/gram.js), so a client that could name one could name someone
  // else's and be handed their money. The player RECEIVES a code; they never
  // send one. The shipped client used to send `{ amount, memo }` here and this
  // handler has always ignored both — the client is now changed to match, and
  // this signature is what keeps it that way.
  safeOn('gramDepositRequest', () => s.act('gramDepositRequest', 'gramError', async (t, pid) => {
    const intent = await gram.createIntent(t, pid);
    // Its own event rather than gramTxCreated. An intent is not a transaction
    // that happened: its `amount` is the minimum standing in for a figure only
    // the chain knows, so feeding it to the history list drew a "Пополнение
    // +0.05 GRAM · Ожидание" row for a deposit the player had not made.
    // `reused` rides along because the modal has to be able to tell "here is
    // your code" from "here is the code you already have" — a player who
    // re-opens the panel and sees a countdown restart concludes the previous
    // code is dead and stops trusting the one already pasted into their wallet.
    s.socket.emit('gramDepositIntent', {
      memo: intent.memo, address: intent.address,
      minAmount: intent.minAmount, expiresAt: intent.expiresAt,
      reused: intent.reused,
    });
    return intent;
    // WHICH code this player was handed. When a transfer arrives carrying a
    // comment, this row is what turns it back into an account — and `reused`
    // separates re-opening the panel from minting a second code, which is the
    // difference between one player looking twice and one player accumulating
    // open intents.
  }, r => r && { memo: r.memo, intentId: r.id, reused: r.reused }));

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
