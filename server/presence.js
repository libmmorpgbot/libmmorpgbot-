'use strict';
// ── Two facts every client draws, about players other than itself ───────────
//
//   topPlayer   the rating leader, who gets a crown in the world
//   vipAuras    which online players are VIP enough to glow
//
// Both existed in the old build and neither survived the rewrite, so nobody
// has had a crown or an aura since — a silent regression, because the absence
// of a visual effect looks exactly like not having earned it.
//
// Neither belongs in the per-player world packet. That packet goes through the
// binary codec at 40Hz per player; VIP level changes on a purchase and the
// leader changes rarely, and paying for either in every frame forever would be
// absurd. They are broadcast when they change, and included in authOk so a
// client that connects between two broadcasts still knows.

const { query } = require('./db');

// The threshold at which a VIP glows. Two, as in the old build.
const VIP_AURA_MIN_LEVEL = 2;
const TOP_PLAYER_POLL_MS = 60000;

let _io = null;
let _topPlayer = null;
let _timer = null;

// username -> vip level, for everyone currently connected. Usernames rather
// than ids because that is what the client matches a rendered character
// against — it has no player id for the stranger standing next to it.
const _auraUsers = new Set();

// ── the rating leader ───────────────────────────────────────────────────────
// Polled, not recomputed on every change: bm moves whenever anyone's equipment
// does, and the leader changes maybe once a day. One indexed read a minute.
async function refreshTopPlayer() {
  try {
    const { rows } = await query(null,
      'SELECT username FROM players ORDER BY bm DESC NULLS LAST LIMIT 1');
    const name = (rows[0] && rows[0].username) || null;
    if (name === _topPlayer) return;
    _topPlayer = name;
    if (_io) _io.emit('topPlayer', { username: name });
  } catch (err) {
    console.error('[presence] topPlayer:', err.message);
  }
}

function broadcastAuras() {
  if (_io) _io.emit('vipAuras', { usernames: [..._auraUsers] });
}

// Called on login, on logout, and after anything that can change a VIP level.
// No-ops unless the roster really moved, so a login storm is not a broadcast
// storm.
function setAura(username, vipLevel) {
  if (!username) return;
  const should = (vipLevel || 0) >= VIP_AURA_MIN_LEVEL;
  const had = _auraUsers.has(username);
  if (should === had) return;
  if (should) _auraUsers.add(username);
  else _auraUsers.delete(username);
  broadcastAuras();
}

function clearAura(username) {
  if (!username || !_auraUsers.delete(username)) return;
  broadcastAuras();
}

function init(io) {
  _io = io;
  clearInterval(_timer);
  refreshTopPlayer().catch(() => {});
  _timer = setInterval(() => { refreshTopPlayer().catch(() => {}); }, TOP_PLAYER_POLL_MS);
  if (_timer.unref) _timer.unref();
}

function stop() { clearInterval(_timer); _timer = null; }

module.exports = {
  init, stop, setAura, clearAura, refreshTopPlayer,
  topPlayer: () => _topPlayer,
  auraUsers: () => [..._auraUsers],
  VIP_AURA_MIN_LEVEL,
};
