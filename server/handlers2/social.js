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
const progression = require('../db/repos/progression');
const translate = require('../translate');
const chat = require('../db/repos/chat');
const { SKILL_SELF_HEAL, skillSelfHealOf, BUTTERFLIES_SEC,
        SKILL_HASTE, skillHasteOf, skillBuffOf,
        VAMPIRISM_SEC, VAMPIRISM_PCT, ADV_VAMPIRISM_PCT } = require('../../shared/definitions');
const stats = require('../db/repos/stats');
const party = require('../party');
const players = require('../db/repos/players');
const { query } = require('../db');
const { _sanitizeName, _sanitizeText, _sanitizeClanDesc } = require('../security');
const { CHAR_DEF } = require('../../shared/definitions');

const id = v => {
  const n = Math.floor(Number(v));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

// The client names other players by TELEGRAM id — every clan button, the
// profile card, the storage table. Internally nothing does: every foreign key
// points at players.id. Translating here, once, against the database is what
// keeps the repositories from having to know two kinds of identifier.
const byTg = (t, v) => players.idByTelegram(t, v);
// ── why the guards below fail instead of returning ──────────────────────────
// act() writes the success row when the handler does not throw, so every bare
// `return;` in a clan or storage handler put a row in player_logs saying an
// item was handed over, a member kicked, a claim taken — for a call that did
// nothing. The clan storage is the one place items move between accounts
// without a market listing, which makes its log the only record there is.
const fail = (msg, code) => { throw Object.assign(new Error(msg), { userMessage: msg, code }); };

module.exports = function registerSocial(s, safeOn, deps) {
  const { io } = deps;

  // The clan view, from the database, after anything that changes it. One
  // round trip for the whole panel — the old version issued a query per member
  // to resolve names, every time anyone opened the tab.
  async function pushClan(t) {
    // The tag over this player's head, in every room, refreshed here — this is
    // the one place every membership change funnels through. Without it a
    // player who just founded a clan wears no tag until they relog.
    await s.refreshClan(t);
    const membership = await clans.clanOf(t, s.playerId);
    if (!membership) return s.socket.emit('clanData', null);
    // The shape the client's panel renders: members and applications keyed by
    // telegram id, because that is the only identifier it ever sees, and _id
    // because that is what its buttons carry.
    s.socket.emit('clanData', await clans.dataView(t, membership.clanId, s.playerId));
    return membership;
  }

  // The storage is its own panel and its own event. It is not a subset of
  // clanData: it carries the days-in-clan rule, the unlock price, and the
  // allocation list filtered to what THIS player may see.
  async function pushClanStorage(t) {
    const membership = await clans.clanOf(t, s.playerId);
    if (!membership) return s.socket.emit('clanStorage', null);
    s.socket.emit('clanStorage', await clans.storageView(t, membership.clanId, s.playerId));
    return membership;
  }

  // ── membership ───────────────────────────────────────────────────────────
  safeOn('clanCreate', ({ name, icon } = {}) => s.act('clanCreate', 'clanError', async (t, pid) => {
    await clans.create(t, pid, _sanitizeName(name), icon);
    await s.pushBalances(t);
    await pushClan(t);
  }));

  safeOn('clanApply', ({ clanId } = {}) => s.act('clanApply', 'clanError', async (t, pid) => {
    const c = id(clanId);
    if (!c) fail('Клан не найден', 'bad_clan');
    await clans.apply(t, pid, c);
    s.socket.emit('clanApplySent', { clanId: c });
  }));

  safeOn('clanApprove', ({ telegramId } = {}) => s.act('clanApprove', 'clanError', async (t, pid) => {
    const target = await byTg(t, telegramId);
    const m = await clans.clanOf(t, pid);
    if (!target) fail('Игрок не найден', 'no_user');
    if (!m) fail('Вы не состоите в клане', 'no_clan');
    await clans.accept(t, pid, m.clanId, target);
    await pushClan(t);
    // Tell them, if they are here. Their own panel refreshes from the database
    // either way on next open — this is a notification, not the join.
    // Their own panel is refreshed from the database, not told a fact to
    // remember. clanData is the event the client already renders the whole
    // panel from, so an accepted member sees the clan appear without pressing
    // anything — and without the server inventing a second event for it.
    const sock = deps.socketForPlayerId && deps.socketForPlayerId(target);
    // "Вступи в гильдию" is the joiner's quest, not the leader's — so the
    // counter moves on the account that was accepted.
    const q = await progression.questOnEvent(t, target, 'join_guild', '_guild', 1);
    if (sock) {
      // Their tag, on their session — this handler runs on the LEADER's, so
      // without this the new member wears nothing until they relog.
      if (sock.data && sock.data.session) await sock.data.session.refreshClan(t);
      sock.emit('clanData', await clans.dataView(t, m.clanId, target));
      if (q) sock.emit('questSync', q);
    }
  }));

  safeOn('clanDecline', ({ telegramId } = {}) => s.act('clanDecline', 'clanError', async (t, pid) => {
    const target = await byTg(t, telegramId);
    const m = await clans.clanOf(t, pid);
    if (!target) fail('Игрок не найден', 'no_user');
    if (!m) fail('Вы не состоите в клане', 'no_clan');
    await clans.decline(t, pid, m.clanId, target);
    await pushClan(t);
  }));

  safeOn('clanKick', ({ telegramId } = {}) => s.act('clanKick', 'clanError', async (t, pid) => {
    const target = await byTg(t, telegramId);
    const m = await clans.clanOf(t, pid);
    if (!target) fail('Игрок не найден', 'no_user');
    if (!m) fail('Вы не состоите в клане', 'no_clan');
    await clans.kick(t, pid, m.clanId, target);
    await pushClan(t);
    const sock = deps.socketForPlayerId && deps.socketForPlayerId(target);
    if (sock) {
      if (sock.data && sock.data.session) await sock.data.session.refreshClan(t);
      sock.emit('clanData', null);
    }
  }));

  safeOn('clanLeave', () => s.act('clanLeave', 'clanError', async (t, pid) => {
    await clans.leave(t, pid);
    await s.refreshClan(t);          // the tag comes off now, not on relog
    s.socket.emit('clanData', null);
  }));

  safeOn('clanDisband', () => s.act('clanDisband', 'clanError', async (t, pid) => {
    const m = await clans.clanOf(t, pid);
    if (!m) fail('Вы не состоите в клане', 'no_clan');
    await clans.disband(t, pid, m.clanId);
    await s.refreshClan(t);
    s.socket.emit('clanData', null);
  }));

  safeOn('clanSetDescription', ({ description } = {}) =>
    s.act('clanSetDescription', 'clanError', async (t, pid) => {
      const m = await clans.clanOf(t, pid);
      if (!m) return;
      // Stripped of control characters and bounded before storage. The client
      // escapes on output; this is the layer that keeps the stored value sane
      // regardless of what any future client does with it.
      await clans.setDescription(t, pid, m.clanId, _sanitizeClanDesc(description));
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
      if (!m) fail('Вы не состоите в клане', 'no_clan');
      if (typeof itemId !== 'string') fail('Предмет не выбран', 'bad_item');
      const n = await clans.deposit(t, pid, m.clanId, itemId, qty);
      await s.pushItems(t);
      await pushClanStorage(t);
      // The storage panel repaints either way, but a deposit into a shared box
      // is the kind of action a player wants confirmed by name and count —
      // otherwise the item is simply gone from their bag.
      s.socket.emit('clanStorageOk', {
        msg: `Передано в хранилище: ${(n && n.qty) || qty || 1}`,
      });
    }));

  safeOn('clanStorageGive', ({ telegramId, id: itemId, qty } = {}) =>
    s.act('clanStorageGive', 'clanError', async (t, pid) => {
      const target = await byTg(t, telegramId);
      const m = await clans.clanOf(t, pid);
      if (!target) fail('Игрок не найден', 'no_user');
      if (!m) fail('Вы не состоите в клане', 'no_clan');
      if (typeof itemId !== 'string') fail('Предмет не выбран', 'bad_item');
      const a = await clans.allocate(t, pid, m.clanId, target, itemId, qty);
      await pushClanStorage(t);
      s.socket.emit('clanStorageOk', { msg: `Выдано: ${(a && a.qty) || qty || 1}` });
      // And the recipient, if they are online — an allocation waiting in a
      // panel nobody was told about is one nobody claims.
      const sock = deps.socketForPlayerId && deps.socketForPlayerId(target);
      if (sock) sock.emit('clanStorageOk', { msg: 'Вам выдали предмет из хранилища клана' });
    }));

  // No payload: the client's button takes everything waiting for it.
  safeOn('clanStorageClaim', () =>
    s.act('clanStorageClaim', 'clanError', async (t, pid) => {
      const res = await clans.claimAll(t, pid);
      await s.pushItems(t);
      await pushClanStorage(t);
      s.socket.emit('clanStorageClaimed', res);
    }));

  // Named by recipient and item, which is what the leader's table shows.
  safeOn('clanStorageCancel', ({ telegramId, id: itemId } = {}) =>
    s.act('clanStorageCancel', 'clanError', async (t, pid) => {
      const m = await clans.clanOf(t, pid);
      const target = await byTg(t, telegramId);
      if (!m) fail('Вы не состоите в клане', 'no_clan');
      if (!target) fail('Игрок не найден', 'no_user');
      if (typeof itemId !== 'string') fail('Предмет не выбран', 'bad_item');
      const a = await clans.allocationIdFor(t, m.clanId, target, itemId);
      // Already claimed or already cancelled — the leader's table is stale. A
      // success row here would say the leader took an outstanding allocation
      // back, which is exactly the sort of thing the other member disputes.
      if (!a) fail('Выдача не найдена — список обновлён', 'no_allocation');
      await clans.cancelAllocation(t, pid, m.clanId, a);
      await pushClanStorage(t);
    }));

  safeOn('clanStorageUnlock', () => s.act('clanStorageUnlock', 'clanError', async (t, pid) => {
    const m = await clans.clanOf(t, pid);
    if (!m) fail('Вы не состоите в клане', 'no_clan');
    const { CLAN_STORAGE_UNLOCK_GOLD } = require('../../shared/definitions');
    const res = await clans.unlockStorage(t, pid, m.clanId, CLAN_STORAGE_UNLOCK_GOLD);
    await s.pushBalances(t);
    await pushClanStorage(t);
    s.socket.emit('clanStorageUnlocked', res);
  }));

  safeOn('clanStorageSync', () => s.act('clanStorageSync', 'clanStorageError', async (t) => {
    await pushClanStorage(t);
  }));

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
    // _sanitizeText, а не _sanitizeName: второй режет до длины ИМЕНИ —
    // тридцати двух знаков, — и slice(0, MAX_LEN) ниже уже ничего не делал.
    // Так резались все три канала: общий, клановый и личные.
    const msg = _sanitizeText(text, MAX_LEN);
    if (!msg) return;
    lastChatAt = now;

    await query(t, `INSERT INTO chat_messages (player_id, username, text) VALUES ($1, $2, $3)`,
      [pid, s.username, msg]);
    io.emit('chatMsg', { username: s.username, text: msg, time: new Date().toISOString() });
  }));

  // The "translate" button on a chat bubble — global, clan and DM alike; this
  // only ever sees the text, never which channel it came from. Keyed by reqId
  // so a reply cannot land on the wrong bubble when several are in flight.
  //
  // Not routed through s.act: there is no transaction here, and a refusal must
  // still come back as translateChatResult. The client marks the bubble as
  // translating the moment it asks and clears that ONLY on a reply, so
  // returning in silence leaves it on "…" for the rest of the session — and
  // the same flag makes a second click a no-op, so there is no retry either.
  let lastTranslateAt = 0;
  safeOn('translateChat', async ({ text, target, reqId } = {}) => {
    if (!s.authed || typeof text !== 'string' || !text) return;
    const now = Date.now();
    if (now - lastTranslateAt < 1000) {
      return s.socket.emit('translateChatResult', { reqId, error: true, reason: 'rate' });
    }
    lastTranslateAt = now;
    const lang = (typeof target === 'string' && /^[a-z]{2}$/.test(target)) ? target : 'en';
    try {
      const out = await translate.translateText(text.slice(0, 200), lang);
      s.socket.emit('translateChatResult', { reqId, text: out });
    } catch {
      // Google throttles its free endpoints per IP and every player's click
      // leaves from this one server address, so this is "come back in a bit",
      // not a broken message.
      s.socket.emit('translateChatResult', { reqId, error: true, reason: 'unavailable' });
    }
  });

  safeOn('chatHistory', () => s.act('chatHistory', 'chatError', async (t) => {
    const { rows } = await query(t, `
      SELECT username, text, created_at FROM chat_messages
       ORDER BY id DESC LIMIT 50`);
    s.socket.emit('chatHistory', rows.reverse().map(r => ({
      username: r.username, text: r.text, time: r.created_at,
    })));
  }));



  // ── party ────────────────────────────────────────────────────────────────
  // Held in memory by socket id, and that is right: a party is a property of
  // who is connected, not of an account. Ported unchanged in behaviour from
  // server/handlers/chat.js.
  safeOn('partyInvite', ({ targetId } = {}) => {
    if (!s.authed || typeof targetId !== 'string') return;
    if (party.playerParty.has(targetId)) return;              // already in one
    const mine = party.playerParty.get(s.socket.id);
    if (mine) {
      const members = party.parties.get(mine);
      if (members && members.size >= party.PARTY_MAX) return;
    }
    const targetSock = deps.io.sockets.sockets.get(targetId);
    if (!targetSock || !targetSock.data || !targetSock.data.username) return;
    // Race lanes are private, so an invitation cannot be used to find out who
    // is in the tower with you.
    if (s.room && typeof s.room.racePairAllowed === 'function'
        && !s.room.racePairAllowed(s.socket.id, targetId)) return;
    targetSock.emit('partyInviteReceived', { fromId: s.socket.id, fromName: s.username });
  });

  safeOn('partyAccept', ({ fromId } = {}) => {
    if (!s.authed || typeof fromId !== 'string') return;
    if (party.playerParty.has(s.socket.id)) return;
    const fromSock = deps.io.sockets.sockets.get(fromId);
    if (!fromSock) return;

    const existing = party.playerParty.get(fromId);
    let members;
    let partyId;
    if (existing) {
      members = party.parties.get(existing);
      if (!members || members.size >= party.PARTY_MAX) return;
      partyId = existing;
      members.set(s.socket.id, s.username);
      party.playerParty.set(s.socket.id, partyId);
    } else {
      partyId = `${fromId}_${s.socket.id}`;
      members = new Map();
      members.set(fromId, (fromSock.data && fromSock.data.username) || fromId.slice(0, 6));
      members.set(s.socket.id, s.username);
      party.parties.set(partyId, members);
      party.playerParty.set(fromId, partyId);
      party.playerParty.set(s.socket.id, partyId);
    }

    const all = [];
    members.forEach((name, id) => all.push({ id, name }));
    for (const m of all) {
      deps.io.to(m.id).emit('partyUpdated', { members: all.filter(r => r.id !== m.id) });
    }
  });

  safeOn('partyDecline', ({ fromId } = {}) => {
    if (!s.authed || typeof fromId !== 'string') return;
    const fromSock = deps.io.sockets.sockets.get(fromId);
    if (fromSock) fromSock.emit('partyInviteDeclined', { byName: s.username });
  });

  safeOn('partyLeave', () => {
    const partyId = party.playerParty.get(s.socket.id);
    if (partyId) party.removeFromParty(partyId, s.socket.id);
  });

  // The warlock's R heals the party. The AMOUNT is the server's now: the old
  // handler took it from the request and clamped it to 9999, which is a heal
  // whose size the client chooses — and 9999 is more health than anything in
  // the game has. It is derived here from the same three inputs the client
  // uses to draw its own number, so the two agree without either trusting the
  // other.
  //
  // The 2-second floor between casts stays. It is not the real cooldown (25s
  // on the client); it is what makes spamming the socket pointless.
  const HEAL_PARTY_CD_MS = 2000;
  let lastHealAt = 0;

  // ── five refusals that were logged as a heal ─────────────────────────────
  // healParty is a WRITE_ACTION, so each of these bare returns wrote a row
  // saying the party was healed. The cooldown one is the worst: it is the
  // branch that fires most often — the client's own 25s cooldown means the 2s
  // floor is only reached by a socket being spammed — so the log's picture of
  // this skill was mostly casts that healed nobody, mixed in with the real ones
  // and indistinguishable from them.
  // Боевой баф: атака, защита, крит. Клиент присылает только клавишу — во
  // сколько раз и на сколько секунд решает общая таблица (SKILL_BUFFS) из
  // класса и изученности, то есть из того, что уже лежит в базе.
  //
  // Без этого обработчика бафы существовали только в панели: урон считает
  // сервер, а множители были в js/player.js. «Скилл на +20% к атаке не
  // работает», «защита 319 → 574 под бафом, моб как бил 62, так и бьёт».
  safeOn('skillBuff', ({ key } = {}) => s.act('skillBuff', 'skillError', async (t, pid) => {
    const k = String(key || '');
    if (k !== 'Q' && k !== 'W' && k !== 'E' && k !== 'R') fail('Неизвестный навык', 'bad_skill');
    if (!s.room) fail('Вы не на карте — перезайдите', 'no_room');
    const st = await stats.of(t, pid);
    if (!st) fail('Персонаж недоступен — перезайдите', 'no_stats');
    const sk = await players.skillsOf(t, pid);
    const adv = !!(sk.advSkillLearned[k] && sk.advSkillActive[k]);
    const b = skillBuffOf(st.charClass, k, adv);
    if (!b) fail('Этот навык не даёт бафа', 'not_buff');
    const sec = b.sec + (sk.skillLevels[k] || 0);
    s.room.setSkillWindow(s.socket.id, 'buff', sec * 1000, {
      atk: b.atk, def: b.def, critChance: b.critChance, critPower: b.critPower,
    });
    return { sec, atk: b.atk || 1, def: b.def || 1 };
  }));

  // Ускоряющий навык. Отдельно от skillHeal, потому что это другое действие с
  // другим правилом — и потому что «лечение» в имени обработчика, который
  // ускоряет атаку, врёт читателю следующего года.
  //
  // Клиент, как и с лечением, сообщает ТОЛЬКО клавишу: во сколько раз и на
  // сколько секунд — решает общая таблица (SKILL_HASTE) из класса и
  // изученности, то есть из того, что уже лежит в базе.
  safeOn('skillHaste', ({ key } = {}) => s.act('skillHaste', 'skillError', async (t, pid) => {
    const k = String(key || '');
    if (k !== 'Q' && k !== 'W' && k !== 'E' && k !== 'R') fail('Неизвестный навык', 'bad_skill');
    if (!s.room) fail('Вы не на карте — перезайдите', 'no_room');
    const st = await stats.of(t, pid);
    if (!st) fail('Персонаж недоступен — перезайдите', 'no_stats');
    const sk = await players.skillsOf(t, pid);
    const adv = !!(sk.advSkillLearned[k] && sk.advSkillActive[k]);
    const mult = skillHasteOf(st.charClass, k, adv);
    if (mult == null) fail('Этот навык не ускоряет атаку', 'not_haste');
    const def = SKILL_HASTE[st.charClass][k];
    const sec = def.sec + (sk.skillLevels[k] || 0);
    s.room.setSkillWindow(s.socket.id, 'haste', sec * 1000, mult);
    return { mult, sec };
  }));

  safeOn('skillHeal', ({ key } = {}) => s.act('skillHeal', 'itemError', async (t, pid) => {
    const k = String(key || '');
    if (k !== 'Q' && k !== 'W' && k !== 'E' && k !== 'R') fail('Неизвестный навык', 'bad_skill');
    if (!s.room) fail('Вы не на карте — перезайдите', 'no_room');

    const healer = s.room.players.get(s.socket.id);
    if (!healer || healer.hp <= 0) fail('Сначала возродитесь', 'dead');   // the dead do not cast

    const now = Date.now();
    if (now - lastHealAt < HEAL_PARTY_CD_MS) fail('Слишком часто', 'cooldown');

    const st = await stats.of(t, pid);
    if (!st) fail('Персонаж недоступен — перезайдите', 'no_stats');
    const sk = await players.skillsOf(t, pid);
    const adv = !!(sk.advSkillLearned[k] && sk.advSkillActive[k]);
    const lvl = sk.skillLevels[k] || 0;

    // ── окна, а не разовое лечение ────────────────────────────────────────
    // «Бабочки» и вампиризм лечат не в момент нажатия, а некоторое время
    // после: первое — раз в секунду, второе — с каждого нанесённого удара.
    // Комната их и тикает (_regenTick / _vampGain); здесь только проверка
    // права и запись окна.
    if (st.charClass === 'warlock' && k === 'Q' && adv) {
      s.room.setSkillWindow(s.socket.id, 'butterflies', (BUTTERFLIES_SEC + lvl) * 1000);
      lastHealAt = now;
      return { window: 'butterflies', sec: BUTTERFLIES_SEC + lvl };
    }
    if (st.charClass === 'deathknight' && k === 'Q') {
      const pct = adv ? ADV_VAMPIRISM_PCT : VAMPIRISM_PCT;
      s.room.setSkillWindow(s.socket.id, 'vampirism', (VAMPIRISM_SEC + lvl) * 1000, pct);
      lastHealAt = now;
      return { window: 'vampirism', sec: VAMPIRISM_SEC + lvl, pct };
    }

    // ── разовое лечение ───────────────────────────────────────────────────
    // Сколько именно — решает общая таблица, а не клиент: он прислал одну
    // букву. Навык, который не лечит, получает отказ, а не молчаливый ноль:
    // молчаливый ноль неотличим от «полечило на 0».
    const amount = skillSelfHealOf(st.charClass, k, adv, lvl, st.skillPct || 0, st.maxHp);
    if (amount == null) fail('Этот навык не лечит', 'not_heal');
    lastHealAt = now;

    const beforeSelf = healer.hp;
    s.room.setPlayerHp(s.socket.id, Math.min(healer.maxHp, healer.hp + amount));
    const self = Math.round(healer.hp - beforeSelf);

    // ── и группа, если навык её лечит ─────────────────────────────────────
    // Раньше это был весь обработчик, и заклинатель в нём пропускался явно —
    // отчего его собственное лечение целиком жило на клиенте и откатывалось.
    // Теперь он лечится выше, а группа осталась ровно тем же правилом
    // близости; одиночке она просто не нужна, и отсутствие группы больше не
    // отказ.
    let reached = 0, total = 0;
    const heals = SKILL_SELF_HEAL[st.charClass];
    const wantsParty = !!(heals && heals[k] && heals[k].party);
    const partyId = wantsParty ? party.playerParty.get(s.socket.id) : null;
    const members = partyId ? party.parties.get(partyId) : null;
    if (members) {
      for (const [sid] of members) {
        if (sid === s.socket.id) continue;
        const p = s.room.players.get(sid);
        if (!p || p.hp <= 0) continue;                       // no resurrecting
        // Only members actually standing with the healer, and only on this
        // floor — the room's own proximity rule, unchanged.
        if (typeof s.room.arePlayersNear === 'function'
            && !s.room.arePlayersNear(s.socket.id, sid)) continue;
        const before = p.hp;
        s.room.setPlayerHp(sid, Math.min(p.maxHp, p.hp + amount));
        const healed = Math.round(p.hp - before);
        if (healed > 0) { reached++; total += healed; }
        if (healed > 0) deps.io.to(sid).emit('healPartyMember', { amount: healed });
      }
    }
    // Цифру над головой рисует ЭТОТ ответ, а не клиент. HP до него доедет и
    // само (setPlayerHp рассылает 'playerHurt'), но сумма нужна отдельно:
    // разность двух чисел, которые могли разойтись, — это не то, на сколько
    // полечило.
    s.socket.emit('skillHealDone', { amount, self, reached, total });
    return { amount, self, reached, total };
  }, r => r && { amount: r.amount, self: r.self, reached: r.reached, healed: r.total }));

  // ── clan chat ────────────────────────────────────────────────────────────
  // The cooldown is SHARED with the global chat below, deliberately: it is one
  // person's rate of speech, not a per-channel allowance. Two counters would
  // let the same player post twice as often by alternating channels.
  safeOn('clanChat', ({ text } = {}) => s.act('clanChat', 'chatError', async (t, pid) => {
    if (typeof text !== 'string') return;
    const now = Date.now();
    if (now - lastChatAt < CHAT_COOLDOWN_MS) return;
    // _sanitizeText, а не _sanitizeName: второй режет до длины ИМЕНИ —
    // тридцати двух знаков, — и slice(0, MAX_LEN) ниже уже ничего не делал.
    // Так резались все три канала: общий, клановый и личные.
    const msg = _sanitizeText(text, MAX_LEN);
    if (!msg) return;

    const m = await clans.clanOf(t, pid);
    if (!m) fail('Вы не состоите в клане', 'no_clan');
    lastChatAt = now;

    const posted = await chat.postClan(t, m.clanId, pid, s.username, msg);
    // Delivered to the members who are online, by looking up each one's socket
    // — the same list the panel is built from, so a member who joined a second
    // ago is included and one who left is not.
    const view = await clans.fullView(t, m.clanId);
    for (const member of (view.members || [])) {
      const sock = deps.socketForPlayerId && deps.socketForPlayerId(member.playerId);
      if (sock) sock.emit('clanChatMsg', { username: posted.username, text: posted.text });
    }
  }));

  safeOn('clanChatHistory', () => s.act('clanChatHistory', 'chatError', async (t, pid) => {
    const m = await clans.clanOf(t, pid);
    s.socket.emit('clanChatHistory', {
      messages: m ? await chat.clanHistory(t, m.clanId) : [],
    });
  }));

  // ── direct messages ──────────────────────────────────────────────────────
  // Stored once per conversation rather than once per participant, so the two
  // sides cannot drift — and stored at all, which is new: the history was a
  // Map in the process and every restart erased every conversation.
  safeOn('privMsg', ({ toUsername, text } = {}) => s.act('privMsg', 'privMsgError', async (t, pid) => {
    if (typeof text !== 'string' || typeof toUsername !== 'string') return;
    const now = Date.now();
    if (now - lastChatAt < CHAT_COOLDOWN_MS) return;
    // _sanitizeText, а не _sanitizeName: второй режет до длины ИМЕНИ —
    // тридцати двух знаков, — и slice(0, MAX_LEN) ниже уже ничего не делал.
    // Так резались все три канала: общий, клановый и личные.
    const msg = _sanitizeText(text, MAX_LEN);
    if (!msg) return;

    const target = await chat.playerByUsername(t, toUsername);
    if (!target) fail(`Пользователь @${toUsername} не найден`, 'no_user');
    if (target.id === pid) fail('Нельзя написать самому себе', 'self');
    lastChatAt = now;

    const posted = await chat.sendDirect(t, pid, s.username, target.id, msg);
    // Both sides see the thread named by the OTHER person, which is how the
    // client indexes its conversation list.
    s.socket.emit('privMsg', { withUsername: target.username, username: s.username, text: posted.text });
    const sock = deps.socketForPlayerId && deps.socketForPlayerId(target.id);
    if (sock) sock.emit('privMsg', { withUsername: s.username, username: s.username, text: posted.text });
  }));

  safeOn('privMsgHistory', ({ withUsername } = {}) =>
    s.act('privMsgHistory', 'privMsgError', async (t, pid) => {
      if (typeof withUsername !== 'string') return;
      const target = await chat.playerByUsername(t, withUsername);
      if (!target) fail(`Пользователь @${withUsername} не найден`, 'no_user');
      s.socket.emit('privMsgHistory', {
        withUsername: target.username,
        messages: await chat.directHistory(t, pid, target.id),
      });
    }));

  // ── public profile ───────────────────────────────────────────────────────
  // Answered from the database, not relayed to the target's client. The old
  // version asked the other player's socket and could go unanswered forever if
  // they were slow, on a menu, or gone.
  // `targetId` is the other player's SOCKET id — the id the client has for
  // whoever it is standing next to. It is not a telegram id and never was; the
  // rewrite read it as one, so the profile button answered "no such player"
  // every time.
  //
  // The numbers come from the database rather than from Room.publicProfile,
  // which builds them out of `p._sd` — the client's own last save blob. That
  // blob is exactly what this rewrite removed, so a profile read from it would
  // be a profile a player can write.
  safeOn('requestPlayerProfile', ({ targetId } = {}) =>
    s.act('requestPlayerProfile', 'profileError', async (t) => {
      const empty = { fromId: targetId, fromName: null, profile: null };
      if (typeof targetId !== 'string' || !s.room) return s.socket.emit('playerProfileResult', empty);
      // During a race the lanes are private: opponents must not be able to
      // scout each other's gear mid-run.
      if (typeof s.room.racePairAllowed === 'function'
          && !s.room.racePairAllowed(s.socket.id, targetId)) {
        return s.socket.emit('playerProfileResult', empty);
      }
      const other = deps.sessionForSocketId && deps.sessionForSocketId(targetId);
      if (!other || !other.authed) return s.socket.emit('playerProfileResult', empty);

      const target = other.playerId;
      const prog = await players.progressOf(t, target);
      const st = await require('../db/repos/stats').of(t, target);
      const inv = await require('../db/repos/items').inventoryOf(t, target);
      const { rows } = await query(t, 'SELECT username, bm FROM players WHERE id = $1', [target]);
      if (!rows.length || !st) return s.socket.emit('playerProfileResult', empty);

      const cd = CHAR_DEF[st.charClass] || {};
      s.socket.emit('playerProfileResult', {
        fromId: targetId,
        fromName: rows[0].username,
        profile: {
          name: rows[0].username, bm: rows[0].bm,
          charIcon: cd.icon || null, charColor: cd.color || null,
          className: cd.name || st.charClass,
          lvl: st.level, empowers: prog.empowers,
          hp: Math.ceil(st.hp), maxHp: st.maxHp,
          atk: st.atk, def: st.def, atkSpeed: st.atkSpeed,
          critChance: st.critChance, critPower: st.critPower, hpRegen: st.hpRegen,
          equipment: inv.equipment,
        },
      });
    }));
};
