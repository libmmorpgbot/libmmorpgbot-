// ── Сезон 4: ежедневные и еженедельные задания — точки начисления ─────────
// Счётчик и очки — progression.bumpSeasonTask (одна запись под FOR UPDATE).
// Здесь — то, что нужно обработчикам: сессия игрока, уведомление о
// выполненном задании и кеш «уже выполнено в этом периоде», чтобы после
// выполнения (100 000 убийств, три удара по боссу) база больше не трогалась
// на каждом событии.
const progression = require('./db/repos/progression');
const { tx } = require('./db');
const { SEASON_DAILY_TASKS, seasonDayKey, seasonWeekKey } = require('../shared/definitions');

const _DAILY = new Set(SEASON_DAILY_TASKS.map(d => d.id));
const _periodKey = (taskId) => (_DAILY.has(taskId) ? seasonDayKey() : seasonWeekKey());

function _doneCached(s, taskId) {
  return !!(s && s._seasonTaskDone && s._seasonTaskDone.get(taskId) === _periodKey(taskId));
}

// В транзакции вызывающего (убийство, чат, крафт — всё в одной записи).
async function bumpIn(t, s, taskId, amount = 1) {
  if (!s || !s.playerId || _doneCached(s, taskId)) return null;
  const r = await progression.bumpSeasonTask(t, s.playerId, taskId, amount);
  if (r && r.done) {
    if (!s._seasonTaskDone) s._seasonTaskDone = new Map();
    s._seasonTaskDone.set(taskId, _periodKey(taskId));
  }
  if (r && r.completed && s.socket) {
    s.socket.emit('seasonTaskDone', { task: taskId, points: r.points, total: r.total });
  }
  return r;
}

// Своей транзакцией и без исключений наружу — для мест, где ошибка задания
// не должна ломать само действие (удар по боссу, старт Башни).
function bumpSoon(s, taskId, amount = 1) {
  if (!s || !s.playerId || _doneCached(s, taskId)) return;
  tx(t => bumpIn(t, s, taskId, amount))
    .catch(err => console.error(`[season-task] ${taskId}:`, err.message));
}

module.exports = { bumpIn, bumpSoon };
