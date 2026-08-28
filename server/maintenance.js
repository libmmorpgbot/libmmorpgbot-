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
// Ставится из server/app.js при старте: модуль не должен требовать io, чтобы
// его можно было прочитать и без сервера (админка, тесты).
let _io = null;
function attach(io) { _io = io; }

function isOn() { return _on; }

// ── выставить за дверь тех, кто уже внутри ──────────────────────────────────
// Отклонять новые входы мало: смысл режима — чтобы к базе никто не ходил, а
// уже подключённый игрок ходит к ней каждым действием. Владелец так и сказал:
// «коли активні тех роботи, всіх викидувало і нікого не пускало, крім
// адмінів».
//
// Админы остаются. Тот, кто включил режим, не должен вылетать первым — ему в
// этот момент как раз и надо смотреть, что происходит.
//
// 'kicked' — тот же канал, которым пользуется блокировка аккаунта
// (routes/admin2.js), и клиент его уже обрабатывает. Новое событие пришлось
// бы учить понимать, а этот режим включают тогда, когда учить некогда.
function _evictAll() {
  if (!_io) return 0;
  let n = 0;
  for (const sock of _io.sockets.sockets.values()) {
    const sess = sock.data && sock.data.session;
    const tg = sess && sess.telegramId;
    if (tg && ops.isAdmin(tg)) continue;
    sock.emit('kicked', { reason: 'Технические работы', code: 'maintenance' });
    sock.disconnect(true);
    n++;
  }
  return n;
}

function set(on) {
  const was = _on;
  _on = !!on;
  if (was !== _on) {
    const evicted = _on ? _evictAll() : 0;
    ops.send('alerts', _on
      ? `🔧 <b>Режим обслуживания ВКЛЮЧЁН</b> — входы отклоняются, отключено игроков: ${evicted}`
      : '✅ <b>Режим обслуживания выключен</b>').catch(() => {});
  }
  return _on;
}

module.exports = { isOn, set, attach };
