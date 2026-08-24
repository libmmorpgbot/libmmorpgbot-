'use strict';
// ── Parties ─────────────────────────────────────────────────────────────────
// Five people, held in memory by socket id, and that is correct: a party is a
// property of who is connected right now, not of an account. Nothing here is
// worth persisting — a party does not survive a restart because the people in
// it do not either.
//
// Moved out of server/index.js unchanged in behaviour. The only addition is
// that the reconnect grace is stated as a constant with a reason next to it,
// because 45 seconds is a decision and it was a bare number.

const ops = require('./tg-ops');

// A player who drops off a train keeps their place for this long. Shorter and
// a tunnel breaks the party; longer and a leaver holds a slot nobody can use.
const PARTY_RECONNECT_GRACE_MS = 45000;
const PARTY_MAX = 5;

let _io = null;
let _onLeave = () => {};                      // set by init: the modes' cleanup

const parties = new Map();                    // partyId  -> Map(socketId -> name)
const playerParty = new Map();                // socketId -> partyId
const _grace = new Map();                     // telegramId -> { partyId, socketId, timer }

function init(io, { onLeave } = {}) {
  _io = io;
  if (typeof onLeave === 'function') _onLeave = onLeave;
  return { parties, playerParty, removeFromParty, holdOnDisconnect, claimGrace, PARTY_MAX };
}

function removeFromParty(partyId, leaverId) {
  const members = parties.get(partyId);
  if (!members) return;

  // Leaving a party ends any co-op or farm run that party was on — those modes
  // are gated on the party existing, so a run with one member left is a run
  // whose rules no longer hold.
  try { _onLeave(leaverId); } catch (err) { ops.alertError('party.leave', 'Ошибка при выходе из группы', err); }

  const leaverName = members.get(leaverId) || String(leaverId).slice(0, 6);
  members.delete(leaverId);
  playerParty.delete(leaverId);

  const remaining = [];
  members.forEach((name, id) => remaining.push({ id, name }));

  // A party of one is not a party. Dissolving it rather than leaving a
  // single-member group behind is what stops a stale party id from following
  // someone into their next invitation.
  if (remaining.length <= 1) {
    parties.delete(partyId);
    for (const m of remaining) {
      playerParty.delete(m.id);
      _io.to(m.id).emit('partyLeft', { leftName: leaverName });
      _io.to(m.id).emit('partyUpdated', { members: [] });
    }
    return;
  }
  for (const m of remaining) {
    _io.to(m.id).emit('partyLeft', { leftName: leaverName });
    _io.to(m.id).emit('partyUpdated', { members: remaining.filter(r => r.id !== m.id) });
  }
}

// A disconnect holds the place open rather than ending the party outright: a
// backgrounded WebView or an LTE handover is not someone leaving.
function holdOnDisconnect(socketId, telegramId) {
  const partyId = playerParty.get(socketId);
  if (!partyId) return;
  if (!telegramId) return removeFromParty(partyId, socketId);

  const prior = _grace.get(telegramId);
  if (prior) clearTimeout(prior.timer);
  const timer = setTimeout(() => {
    _grace.delete(telegramId);
    try { removeFromParty(partyId, socketId); }
    catch (err) { ops.alertError('party.grace', 'Ошибка в таймере группы', err); }
  }, PARTY_RECONNECT_GRACE_MS);
  _grace.set(telegramId, { partyId, socketId, timer });
}

// The reconnect: the same account takes the held place under its new socket id.
function claimGrace(telegramId, socketId, username) {
  const held = _grace.get(telegramId);
  if (!held) return false;
  clearTimeout(held.timer);
  _grace.delete(telegramId);

  const members = parties.get(held.partyId);
  if (!members) return false;
  members.delete(held.socketId);
  playerParty.delete(held.socketId);
  members.set(socketId, username);
  playerParty.set(socketId, held.partyId);

  const all = [];
  members.forEach((name, id) => all.push({ id, name }));
  for (const m of all) {
    _io.to(m.id).emit('partyUpdated', { members: all.filter(r => r.id !== m.id) });
  }
  return true;
}

module.exports = {
  init, parties, playerParty, removeFromParty, holdOnDisconnect, claimGrace,
  PARTY_MAX, PARTY_RECONNECT_GRACE_MS,
};
