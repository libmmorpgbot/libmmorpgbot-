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
const market = require('../db/repos/market');
const gram = require('../db/repos/gram');
const money = require('../db/repos/money');
const progression = require('../db/repos/progression');
const ops = require('../tg-ops');
const cards = require('../ops-cards');
const {
  GRAM_MIN_WITHDRAW, MARKET_FEE_PCT, GEAR_CRAFT_RECIPES,
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
  // One handler for every recipe family. The old build had six near-identical
  // ones, each with its own copy of "take the materials, then grant", and the
  // write ordering had to be correct in all six.
  safeOn('craft', ({ family, index } = {}) => s.act('craft', 'craftError', async (t, pid) => {
    const i = idx(index);
    if (i === null || typeof family !== 'string') return;
    const res = await craft.craft(t, pid, family, i);
    await pushAll(t);
    s.socket.emit('craftResult', res);
  }));

  safeOn('craftAdvSkillBook', ({ key } = {}) => s.act('craftAdvSkillBook', 'craftError', async (t, pid) => {
    const res = await craft.craftAdvSkillBook(t, pid, String(key || ''));
    await pushAll(t);
    s.socket.emit('craftResult', res);
  }));

  // ── enhancement ──────────────────────────────────────────────────────────
  // Named by ROW, not by (id, enhance). The old handler searched the inventory
  // for something matching both, which is ambiguous the moment a player holds
  // two of the same item — and it carries a whole investigation path built for
  // when that search found the wrong one.
  safeOn('enhanceItem', ({ id, stoneType } = {}) => s.act('enhanceItem', 'enhanceError', async (t, pid) => {
    const row = rowId(id);
    if (!row) return;
    const res = await craft.enhance(t, pid, row, stoneType === 'bless' ? 'bless' : 'norm');
    await pushAll(t);
    s.socket.emit('enhanceResult', res);
  }));

  // ── boxes ────────────────────────────────────────────────────────────────
  safeOn('openLootBox', ({ boxId } = {}) => s.act('openLootBox', 'craftError', async (t, pid) => {
    const res = await craft.openBox(t, pid, String(boxId || ''));
    await pushAll(t);
    s.socket.emit('boxOpened', res);
  }));

  // ── merchant ─────────────────────────────────────────────────────────────
  safeOn('buyPotion', ({ itemId, qty } = {}) => s.act('buyPotion', 'shopError', async (t, pid) => {
    const res = await craft.buyFromMerchant(t, pid, String(itemId || ''), qty);
    await pushAll(t);
    s.socket.emit('bought', res);
  }));

  safeOn('sellItem', ({ id, qty } = {}) => s.act('sellItem', 'shopError', async (t, pid) => {
    const row = rowId(id);
    if (!row) return;
    const res = await craft.sellItem(t, pid, row, qty);
    await pushAll(t);
    s.socket.emit('sold', res);
  }));

  // ── market ───────────────────────────────────────────────────────────────
  safeOn('marketList', ({ id, price } = {}) => s.act('marketList', 'marketListError', async (t, pid) => {
    const row = rowId(id);
    if (!row) return;
    const vip = await progression.vipOf(t, pid);
    const res = await market.list(t, pid, row, price, { vipLevel: vip.level });
    await pushAll(t);
    s.socket.emit('marketListed', res);
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

  safeOn('marketBrowse', ({ slot, offset } = {}) => s.act('marketBrowse', 'marketError', async (t) => {
    s.socket.emit('marketLots', await market.browse(t, {
      slot: typeof slot === 'string' ? slot : null,
      offset: idx(offset) || 0,
    }));
  }));

  safeOn('marketMyListings', () => s.act('marketMyListings', 'marketError', async (t, pid) => {
    s.socket.emit('marketMine', await market.mine(t, pid));
  }));

  safeOn('marketHistory', () => s.act('marketHistory', 'marketError', async (t, pid) => {
    s.socket.emit('marketHist', await market.history(t, pid));
  }));

  // ── GRAM ─────────────────────────────────────────────────────────────────
  // A deposit is an INTENT now. The client asks for an address and a memo; it
  // does not state an amount, because the amount is whatever arrives on the
  // chain. That single change is what retires "send 0.1 TON, request 1000
  // GRAM, hope the admin is tired".
  safeOn('gramDepositRequest', () => s.act('gramDepositRequest', 'gramError', async (t, pid) => {
    const intent = await gram.createIntent(t, pid);
    s.socket.emit('gramDepositIntent', intent);
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
      s.socket.emit('gramWithdrawCreated', req);
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

  safeOn('balanceHistory', ({ currency } = {}) => s.act('balanceHistory', 'gramError', async (t, pid) => {
    const cur = ['gold', 'gram', 'nexum'].includes(currency) ? currency : 'gram';
    // The "where did my GRAM go" answer, which the old model could not give at
    // all because nothing recorded the movements.
    s.socket.emit('balanceHistory', { currency: cur, rows: await money.history(t, pid, cur) });
  }));
};
