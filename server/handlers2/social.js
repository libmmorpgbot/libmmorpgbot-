'use strict';
// ── Clans and chat ──────────────────────────────────────────────────────────
// Eleven clan handlers and the chat, on repositories that already hold the
// rules. What is worth noting here is not the clan logic — that lives in
// repos/clans.js — but the two places where a SOCIAL feature is also a
// SECURITY surface, because both were wrong in the build this replaces.
//
//   * a display name is attacker-controlled text. Telegram's first_name is
//     whatever the player types, and the old client wrote several of these
//     into innerHTML unescaped (C1 in AUDIT.md). Escaping on OUTPUT is the
//     client's job and is scheduled separately, but the server must not make
//     it harder: names are bounded and stripped of control characters here.
//   * a chat message is broadcast to everyone. Its rate limit is therefore not
//     a nicety — it is the difference between one bad actor and every player's
//     screen.

const clans = require('../db/repos/clans');
const players = require('../db/repos/players');
const { query } = require('../db');
const { _sanitizeName, _sanitizeClanDesc } = require('../security');
const { CLAN_CREATE_COST } = require('../../shared/definitions');

const id = v => {
  const n = Math.floor(Number(v));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

// The client names other players by TELEGRAM id — every clan button, the
// profile card, the storage table. Internally nothing does: every foreign key
// points at players.id. Translating here, once, against the database is what
// keeps the repositories from having to know two kinds of identifier.
const byTg = (t, v) => players.idByTelegram(t, v);
const fail = (msg, code) => { throw Object.assign(new Error(msg), { userMessage: msg, code }); };

module.exports = function registerSocial(s, safeOn, deps) {
  const { io } = deps;

  // The clan view, from the database, after anything that changes it. One
  // round trip for the whole panel — the old version issued a query per member
  // to resolve names, every time anyone opened the tab.
  async function pushClan(t) {
    const membership = await clans.clanOf(t, s.playerId);
    if (!membership) return s.socket.emit('clanData', null);
    const view = await clans.fullView(t, membership.clanId);
    s.socket.emit('clanData', { ...view, myRole: membership.role });
    return view;
  }

  // ── membership ───────────────────────────────────────────────────────────
  safeOn('clanCreate', ({ name, icon } = {}) => s.act('clanCreate', 'clanError', async (t, pid) => {
    const res = await clans.create(t, pid, _sanitizeName(name), icon);
    await s.pushBalances(t);
    await pushClan(t);
  }));

  safeOn('clanApply', ({ clanId } = {}) => s.act('clanApply', 'clanError', async (t, pid) => {
    const c = id(clanId);
    if (!c) return;
    await clans.apply(t, c, pid);
    s.socket.emit('clanApplySent', { clanId: c });
  }));

  safeOn('clanApprove', ({ telegramId } = {}) => s.act('clanApprove', 'clanError', async (t, pid) => {
    const target = await byTg(t, telegramId);
    const m = await clans.clanOf(t, pid);
    if (!target || !m) return;
    await clans.accept(t, pid, m.clanId, target);
    await pushClan(t);
    // Tell them, if they are here. Their own panel refreshes from the database
    // either way on next open — this is a notification, not the join.
    // Their own panel is refreshed from the database, not told a fact to
    // remember. clanData is the event the client already renders the whole
    // panel from, so an accepted member sees the clan appear without pressing
    // anything — and without the server inventing a second event for it.
    const sock = deps.socketForPlayerId && deps.socketForPlayerId(target);
    if (sock) {
      const view = await clans.fullView(t, m.clanId);
      sock.emit('clanData', { ...view, myRole: 'member' });
    }
  }));

  safeOn('clanDecline', ({ telegramId } = {}) => s.act('clanDecline', 'clanError', async (t, pid) => {
    const target = await byTg(t, telegramId);
    const m = await clans.clanOf(t, pid);
    if (!target || !m) return;
    await clans.decline(t, pid, m.clanId, target);
    await pushClan(t);
  }));

  safeOn('clanKick', ({ telegramId } = {}) => s.act('clanKick', 'clanError', async (t, pid) => {
    const target = await byTg(t, telegramId);
    const m = await clans.clanOf(t, pid);
    if (!target || !m) return;
    await clans.kick(t, pid, m.clanId, target);
    await pushClan(t);
    const sock = deps.socketForPlayerId && deps.socketForPlayerId(target);
    if (sock) sock.emit('clanData', null);
  }));

  safeOn('clanLeave', () => s.act('clanLeave', 'clanError', async (t, pid) => {
    await clans.leave(t, pid);
    s.socket.emit('clanData', null);
  }));

  safeOn('clanDisband', () => s.act('clanDisband', 'clanError', async (t, pid) => {
    const m = await clans.clanOf(t, pid);
    if (!m) return;
    await clans.disband(t, pid, m.clanId);
    s.socket.emit('clanData', null);
  }));

  safeOn('clanSetDescription', ({ description } = {}) =>
    s.act('clanSetDescription', 'clanError', async (t, pid) => {
      const m = await clans.clanOf(t, pid);
      if (!m) return;
      // Stripped of control characters and bounded before storage. The client
      // escapes on output; this is the layer that keeps the stored value sane
      // regardless of what any future client does with it.
      const desc = await clans.setDescription(t, pid, m.clanId, _sanitizeClanDesc(description));
      await pushClan(t);
    }));

  safeOn('clanSearch', ({ query: q } = {}) => s.act('clanSearch', 'clanError', async (t) => {
    // The array itself: the client's handler is `results => ...`, not a
    // destructured object.
    s.socket.emit('clanSearchResults',
      await clans.search(t, typeof q === 'string' ? q.slice(0, 32) : null));
  }));

  safeOn('clanRequest', () => s.act('clanRequest', 'clanError', async (t) => { await pushClan(t); }));

  // ── storage ──────────────────────────────────────────────────────────────
  safeOn('clanStorageDeposit', ({ id: itemId, qty } = {}) =>
    s.act('clanStorageDeposit', 'clanError', async (t, pid) => {
      const m = await clans.clanOf(t, pid);
      if (!m || typeof itemId !== 'string') return;
      await clans.deposit(t, pid, m.clanId, itemId, qty);
      await s.pushItems(t);
      await pushClan(t);
    }));

  safeOn('clanStorageGive', ({ telegramId, id: itemId, qty } = {}) =>
    s.act('clanStorageGive', 'clanError', async (t, pid) => {
      const target = await byTg(t, telegramId);
      const m = await clans.clanOf(t, pid);
      if (!target || !m || typeof itemId !== 'string') return;
      await clans.allocate(t, pid, m.clanId, target, itemId, qty);
      await pushClan(t);
    }));

  // No payload: the client's button takes everything waiting for it.
  safeOn('clanStorageClaim', () =>
    s.act('clanStorageClaim', 'clanError', async (t, pid) => {
      const res = await clans.claimAll(t, pid);
      await s.pushItems(t);
      await pushClan(t);
      s.socket.emit('clanStorageClaimed', res);
    }));

  // Named by recipient and item, which is what the leader's table shows.
  safeOn('clanStorageCancel', ({ telegramId, id: itemId } = {}) =>
    s.act('clanStorageCancel', 'clanError', async (t, pid) => {
      const m = await clans.clanOf(t, pid);
      const target = await byTg(t, telegramId);
      if (!m || !target || typeof itemId !== 'string') return;
      const a = await clans.allocationIdFor(t, m.clanId, target, itemId);
      if (!a) return;
      await clans.cancelAllocation(t, pid, m.clanId, a);
      await pushClan(t);
    }));

  safeOn('clanStorageUnlock', () => s.act('clanStorageUnlock', 'clanError', async (t, pid) => {
    const m = await clans.clanOf(t, pid);
    if (!m) return;
    const { CLAN_STORAGE_UNLOCK_GOLD } = require('../../shared/definitions');
    const res = await clans.unlockStorage(t, pid, m.clanId, CLAN_STORAGE_UNLOCK_GOLD);
    await s.pushBalances(t);
    await pushClan(t);
    s.socket.emit('clanStorageUnlocked', res);
  }));

  safeOn('clanStorageSync', () => s.act('clanStorageSync', 'clanError', async (t) => { await pushClan(t); }));

  // ── chat ─────────────────────────────────────────────────────────────────
  // Rate limited per socket, and the limit is the security control: this
  // message reaches every connected player.
  let lastChatAt = 0;
  const CHAT_COOLDOWN_MS = 3000;
  const MAX_LEN = 100;

  safeOn('chat', ({ text } = {}) => s.act('chat', 'chatError', async (t, pid) => {
    if (typeof text !== 'string') return;
    const now = Date.now();
    if (now - lastChatAt < CHAT_COOLDOWN_MS) return;      // silently dropped
    // Control characters out, length bounded. The client escapes on render;
    // this stops the stored copy from being something a future renderer has to
    // be careful with.
    const msg = _sanitizeName(text.trim()).slice(0, MAX_LEN);
    if (!msg) return;
    lastChatAt = now;

    await query(t, `INSERT INTO chat_messages (player_id, username, text) VALUES ($1, $2, $3)`,
      [pid, s.username, msg]);
    io.emit('chatMsg', { username: s.username, text: msg, time: new Date().toISOString() });
  }));

  safeOn('chatHistory', () => s.act('chatHistory', 'chatError', async (t) => {
    const { rows } = await query(t, `
      SELECT username, text, created_at FROM chat_messages
       ORDER BY id DESC LIMIT 50`);
    s.socket.emit('chatHistory', rows.reverse().map(r => ({
      username: r.username, text: r.text, time: r.created_at,
    })));
  }));

  // ── public profile ───────────────────────────────────────────────────────
  // Answered from the database, not relayed to the target's client. The old
  // version asked the other player's socket and could go unanswered forever if
  // they were slow, on a menu, or gone.
  safeOn('requestPlayerProfile', ({ targetId } = {}) =>
    s.act('requestPlayerProfile', 'profileError', async (t) => {
      const target = await byTg(t, targetId);
      if (!target) return;
      const prog = await players.progressOf(t, target);
      const st = await require('../db/repos/stats').of(t, target);
      const { rows } = await query(t, 'SELECT username, bm FROM players WHERE id = $1', [target]);
      if (!rows.length || !st) {
        return s.socket.emit('playerProfileResult', { fromId: targetId, fromName: null, profile: null });
      }
      s.socket.emit('playerProfileResult', {
        fromId: targetId, fromName: rows[0].username,
        profile: {
          username: rows[0].username, bm: rows[0].bm,
          lvl: st.level, charClass: st.charClass,
          atk: st.atk, def: st.def, maxHp: st.maxHp,
          rebirths: prog.rebirths,
        },
      });
    }));
};
