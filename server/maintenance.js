'use strict';
// ── Maintenance mode ────────────────────────────────────────────────────────
// A switch an operator can throw before a deploy: new logins are refused with
// a message rather than a socket that closes for no stated reason.
//
// ── и он переживает перезапуск ──────────────────────────────────────────────
// Раньше флаг жил только в памяти процесса — «это свойство ЭТОГО процесса,
// того самого, который сейчас перезапустят». Рассуждение красивое и неверное:
// режим включают ИМЕННО ПЕРЕД выкаткой, а выкатка перезапускает процесс. То
// есть флаг гарантированно умирал ровно там, где был нужен.
//
// Владелец описал это точно: «весь час апка на технічні роботи має бути
// закрита, бо після твого деплою було спало і всі могли заходити».
//
// Теперь он лежит файлом РЯДОМ с приложением, а не в каталоге приложения:
// выкатка перезаписывает каталог целиком, и файл внутри неё не пережил бы и
// одного деплоя.
//
// Страх из прежнего комментария — «запрёт всех навсегда» — снят сроком: флаг
// старше суток игнорируется и стирается. Забытый режим обслуживания
// перестаёт быть режимом обслуживания и становится поломкой.
const fs = require('fs');
const path = require('path');
const ops = require('./tg-ops');

const FLAG_PATH = process.env.MAINTENANCE_FLAG
  || path.join(path.dirname(path.dirname(__dirname)), 'maintenance.on');
const FLAG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function _readFlag() {
  try {
    const raw = fs.readFileSync(FLAG_PATH, 'utf8');
    const at = Number(String(raw).trim()) || 0;
    if (!at) return false;
    if (Date.now() - at > FLAG_MAX_AGE_MS) {
      console.warn('[maintenance] флаг старше суток — снимаю, это уже не обслуживание');
      try { fs.unlinkSync(FLAG_PATH); } catch { /* уже нет */ }
      return false;
    }
    return true;
  } catch { return false; }
}

function _writeFlag(on) {
  try {
    if (on) fs.writeFileSync(FLAG_PATH, String(Date.now()));
    else fs.unlinkSync(FLAG_PATH);
  } catch (err) {
    // Не роняем режим из-за файла: в памяти он всё равно включён, а о том,
    // что он не переживёт перезапуск, надо сказать вслух.
    if (!(err && err.code === 'ENOENT')) {
      console.error('[maintenance] не смог записать флаг', FLAG_PATH, '-', err.message);
    }
  }
}

// Прочитан при загрузке модуля: сервер поднимается уже в том состоянии, в
// котором его оставили.
let _on = _readFlag();
if (_on) {
  console.warn('[maintenance] сервер поднялся В РЕЖИМЕ ОБСЛУЖИВАНИЯ (флаг ' + FLAG_PATH + ')');
}
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
  _writeFlag(_on);
  if (was !== _on) {
    const evicted = _on ? _evictAll() : 0;
    ops.send('alerts', _on
      ? `🔧 <b>Режим обслуживания ВКЛЮЧЁН</b> — входы отклоняются, отключено игроков: ${evicted}`
      : '✅ <b>Режим обслуживания выключен</b>').catch(() => {});
  }
  return _on;
}

// Путь наружу — чтобы админка и проверки могли сказать, ГДЕ лежит флаг, а не
// только включён он или нет.
module.exports = { isOn, set, attach, FLAG_PATH };
