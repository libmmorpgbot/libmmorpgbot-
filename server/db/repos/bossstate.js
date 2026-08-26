'use strict';
// ── When does this arm's boss come back? ────────────────────────────────────
//
// The `boss_state` table has existed since migration 002 (`floor, arm,
// respawn_at`), with the right shape and the right primary key. Nothing has
// ever read it and nothing has ever written it.
//
// Room already carries the whole mechanism: the constructor takes
// `bossState = { [arm]: respawnAtMs }` and restores each boss's timer from it
// (`server/game/Room.js:416,443`), and every per-arm boss death calls
// `onBossDeath(arm, respawnAtMs)` (`Room.js:1734, 3591, 3687`). The only thing
// missing was the two functions at the ends of that wire — so `initFloors`
// passed `{}` for every floor and `() => {}` for the callback, and every
// restart handed every arm boss back at full health regardless of when it had
// last been killed.
//
// The MongoDB build did this. The port took the table with it and left the
// wiring behind.
//
// Deliberately tiny and deliberately unable to break a kill: a boss dying is a
// gameplay event that has already happened by the time this is called, and a
// database hiccup must not turn it into an error in front of a player. So the
// write is fire-and-forget with its own catch, exactly like the player log.
const { query } = require('../index');
const ops = require('../../tg-ops');

// Everything still in the future, as { [floorId]: { [arm]: respawnAtMs } }.
// Rows already in the past are not returned: a boss whose timer expired while
// the server was down should be alive when it comes back, and restoring an
// elapsed deadline would make Room schedule a respawn that already happened.
async function loadAll(db = null) {
  const out = {};
  const { rows } = await query(db,
    'SELECT floor, arm, respawn_at FROM boss_state WHERE respawn_at > now()');
  for (const r of rows) {
    const f = Number(r.floor);
    if (!out[f]) out[f] = {};
    out[f][r.arm] = new Date(r.respawn_at).getTime();
  }
  return out;
}

// One row per (floor, arm), overwritten on each death.
function save(floor, arm, respawnAtMs) {
  if (!arm || !Number.isFinite(respawnAtMs)) return;
  query(null, `
    INSERT INTO boss_state (floor, arm, respawn_at)
    VALUES ($1, $2, to_timestamp($3 / 1000.0))
    ON CONFLICT (floor, arm) DO UPDATE SET respawn_at = EXCLUDED.respawn_at`,
  [Number(floor), String(arm), respawnAtMs]).catch(err => {
    // Not silent: losing this means one boss comes back early after the next
    // restart, which is a live-service fairness question, not a nothing.
    console.error('[bossstate] save failed:', err.message);
    ops.alertError('bossstate.save', 'Не удалось сохранить таймер босса', err,
      { floor, arm }).catch(() => {});
  });
}

module.exports = { loadAll, save };
