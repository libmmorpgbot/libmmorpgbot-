'use strict';
// ── Maintenance mode ────────────────────────────────────────────────────────
// A switch an operator can throw before a deploy: new logins are refused with
// a message rather than a socket that closes for no stated reason.
//
// Held in memory, not in the database, and deliberately. It is a property of
// THIS process — the thing about to be restarted — and a value in the database
// would outlive the restart it was set for and lock everyone out of the server
// that came back.

const ops = require('./tg-ops');

let _on = false;

function isOn() { return _on; }

function set(on) {
  const was = _on;
  _on = !!on;
  if (was !== _on) {
    ops.send('alerts', _on
      ? '🔧 <b>Режим обслуживания ВКЛЮЧЁН</b> — новые входы отклоняются'
      : '✅ <b>Режим обслуживания выключен</b>').catch(() => {});
  }
  return _on;
}

module.exports = { isOn, set };
