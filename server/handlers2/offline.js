'use strict';
// ── Оффлайн-фарм: окно выбора и кнопка «Начать» ─────────────────────────────
// Расчёт и выдача — server/offline-farm.js. Здесь только два пакета:
//
//   offlineFarmInfo    список локаций с темпом «в час» для ЭТОГО игрока
//   offlineFarmStart   запомнить выбор и закрыть соединение
//
// Забирается фарм не здесь, а на входе (finishLogin, server/app.js): игрок,
// запустивший фарм, в игре больше не находится, и любой следующий вход — это
// и есть «вернулся».
const offlineFarm = require('../offline-farm');
const { FLOOR_IDS } = require('../game/floors');

module.exports = function registerOffline(s, safeOn) {
  // Чтение: транзакция не нужна, как и у trialEnter — safeOn ловит ошибки сам.
  safeOn('offlineFarmInfo', async () => {
    if (!s.authed) return;
    s.socket.emit('offlineFarmInfo', await offlineFarm.info(null, s.playerId));
  });

  safeOn('offlineFarmStart', async ({ loc } = {}) => {
    if (!s.authed) return;
    // Только из центрального зала. Уход из игры посреди режима — арены, башни,
    // турнира, группы в Элитной зоне — это поражение в нём, и кнопка, которая
    // молча к нему ведёт, хуже, чем кнопка, которая просит сначала выйти.
    if (s.floor !== FLOOR_IDS.hub) {
      s.socket.emit('offlineFarmError', { msg: 'Оффлайн-фарм запускается из центрального зала', code: 'not_hub' });
      return;
    }
    const me = s.room && s.room.players.get(s.socket.id);
    if (me && me.hp <= 0) {
      s.socket.emit('offlineFarmError', { msg: 'Сначала возродитесь', code: 'dead' });
      return;
    }
    const res = await s.act('offlineFarmStart', 'offlineFarmError',
      (t, pid) => offlineFarm.start(t, pid, loc), { loc });
    if (!res) return;
    // Записано — дальше игрок в мире не нужен. Позиция сохраняется как при
    // обычном выходе, клиенту говорится, что случилось, и соединение
    // закрывается: клиент не переподключается (см. 'offlineFarmStarted',
    // js/network.js), а следующий вход заберёт награду.
    try { await s.savePosition({ force: true }); } catch (_) { /* позиция — не повод оставить игрока в мире */ }
    s.socket.emit('offlineFarmStarted', res);
    setTimeout(() => { try { s.socket.disconnect(true); } catch (_) { /* уже закрыт */ } }, 250);
  });
};
