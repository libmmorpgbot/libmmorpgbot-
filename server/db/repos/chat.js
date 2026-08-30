'use strict';
// ── Clan chat and direct messages ──────────────────────────────────────────
// Both were Maps in the process. Not caches — the Map was the store, so every
// restart erased every conversation, and two players connected to the same
// server could see different histories after a reconnect.
//
// The rate limit lives with the handler rather than here: it is a property of
// a connection, not of the data.

const { query } = require('../index');

class ChatError extends Error {
  constructor(code, msg) { super(msg); this.code = code; this.userMessage = msg; }
}
const err = (code, msg) => { throw new ChatError(code, msg); };

// ── clan ────────────────────────────────────────────────────────────────────
async function postClan(db, clanId, playerId, username, text) {
  const { rows } = await query(db, `
    INSERT INTO clan_chat (clan_id, player_id, username, text)
    VALUES ($1, $2, $3, $4) RETURNING id, created_at`, [clanId, playerId, username, text]);
  return { id: Number(rows[0].id), username, text, time: rows[0].created_at };
}

async function clanHistory(db, clanId, limit = 50) {
  const { rows } = await query(db, `
    SELECT username, text, created_at FROM clan_chat
     WHERE clan_id = $1 ORDER BY id DESC LIMIT $2`, [clanId, Math.min(200, limit)]);
  return rows.reverse().map(r => ({ username: r.username, text: r.text, time: r.created_at }));
}

// ── direct ──────────────────────────────────────────────────────────────────
// Who a name belongs to. Case-insensitive because the client's "написать
// @Имя" box is typed by hand, and exact-match-only turns a capital letter into
// "Пользователь не найден".
async function playerByUsername(db, username) {
  const u = String(username || '').replace(/^@/, '').trim();
  if (!u) return null;
  const { rows } = await query(db, `
    SELECT id, username, telegram_id FROM players
     WHERE lower(username) = lower($1)
     ORDER BY (username = $1) DESC, id
     LIMIT 1`, [u]);
  return rows.length ? { id: Number(rows[0].id), username: rows[0].username, telegramId: rows[0].telegram_id } : null;
}

const pair = (a, b) => (a < b ? [a, b] : [b, a]);

async function sendDirect(db, fromId, fromUsername, toId, text) {
  if (fromId === toId) err('self', 'Нельзя написать самому себе');
  const [lo, hi] = pair(fromId, toId);
  const { rows } = await query(db, `
    INSERT INTO direct_messages (pair_lo, pair_hi, sender_id, username, text)
    VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
    [lo, hi, fromId, fromUsername, text]);
  return { id: Number(rows[0].id), username: fromUsername, text, time: rows[0].created_at };
}

async function directHistory(db, aId, bId, limit = 50) {
  const [lo, hi] = pair(aId, bId);
  const { rows } = await query(db, `
    SELECT username, text, created_at FROM direct_messages
     WHERE pair_lo = $1 AND pair_hi = $2 ORDER BY id DESC LIMIT $3`,
    [lo, hi, Math.min(200, limit)]);
  return rows.reverse().map(r => ({ username: r.username, text: r.text, time: r.created_at }));
}

module.exports = { postClan, clanHistory, playerByUsername, sendDirect, directHistory, ChatError };
