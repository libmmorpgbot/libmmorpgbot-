'use strict';
// ── What happened to this player ────────────────────────────────────────────
//
// player_logs was created in migration 002, partitioned by month, indexed on
// (player_id, created_at DESC), with a retention job that drops old partitions.
// Everything was ready except the writing: NOTHING has ever inserted a row.
// modes.js even carries `logPlayer: () => {}` with a comment saying the session
// writes it, and the session does not.
//
// So the one place an admin could look up "where did my item go" has been empty
// since the first day, and the answer to every such question has been "не знаю".
// That is the whole of "всюди логування добавляти на випадок будь яких проблем".
//
// Two decisions worth stating:
//
// BUFFERED. A row per action, written synchronously, doubles the write load on
// the hot path — an inventory change would wait on a log insert. These queue in
// memory and go out as ONE multi-row insert every couple of seconds. The cost
// of that choice is the last two seconds on a hard kill, which is the right
// trade for a log; SIGTERM flushes, so an ordinary restart loses nothing.
//
// IT CANNOT BREAK ANYTHING. Every failure here is swallowed and reported. A
// logging layer that can throw turns a working action into a failed one, and a
// logging layer that can block turns a slow database into a frozen game.

const { query } = require('../index');
const ops = require('../../tg-ops');

const FLUSH_MS = Number(process.env.PLAYER_LOG_FLUSH_MS || 2000);
const MAX_QUEUE = 5000;      // hard ceiling; past it the oldest are dropped
const BATCH = 200;

let _queue = [];
let _timer = null;
let _dropped = 0;
const _stats = { queued: 0, written: 0, dropped: 0, failed: 0 };

// meta is stored as jsonb. Anything unserialisable (a socket, a circular
// object) would throw inside JSON.stringify at flush time and take the whole
// batch with it, so it is reduced here, next to the caller who can be blamed.
function _clean(meta) {
  if (meta == null) return null;
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') {
      try { out[k] = JSON.parse(JSON.stringify(v)); } catch { out[k] = String(v); }
    } else {
      out[k] = typeof v === 'string' ? v.slice(0, 500) : v;
    }
  }
  return Object.keys(out).length ? out : null;
}

// ── одинаковые отказы подряд сворачиваются ──────────────────────────────────
// refuse:useTeleportStone дал 5007 строк за два часа — это один игрок, который
// держит недоступную ему кнопку. Первый отказ важен: он объясняет, почему у
// человека «не работает». Пять тысяч одинаковых — это уже не сведения, это
// шум, в котором тонет всё остальное.
//
// Сворачивается по (игрок, событие, код) и только для отказов: успех — это
// движение ценности, и каждое обязано остаться. Через окно пишется новая
// строка с числом подавленных, так что «сколько раз» не теряется.
const REFUSE_WINDOW_MS = 60000;
const _refuseSeen = new Map();          // ключ -> { at, n }

function _refuseThrottle(pid, event, meta) {
  if (!event.startsWith('refuse:')) return null;
  const key = pid + '|' + event + '|' + ((meta && meta.code) || '');
  const now = Date.now();
  const prev = _refuseSeen.get(key);
  if (prev && now - prev.at < REFUSE_WINDOW_MS) { prev.n++; return false; }
  const suppressed = prev ? prev.n : 0;
  _refuseSeen.set(key, { at: now, n: 0 });
  // Карта не растёт бесконечно: раз в окно из неё выметается всё протухшее.
  if (_refuseSeen.size > 2000) {
    for (const [k, v] of _refuseSeen) if (now - v.at >= REFUSE_WINDOW_MS) _refuseSeen.delete(k);
  }
  return suppressed;
}

function log(playerId, event, meta = null) {
  const pid = Number(playerId);
  if (!pid || !event) return;
  const sup = _refuseThrottle(pid, String(event), meta);
  if (sup === false) return;
  if (sup > 0) meta = { ...(meta || {}), подавлено: sup };
  if (_queue.length >= MAX_QUEUE) {
    // Losing the OLDEST is the right end to lose: whatever is happening right
    // now is what someone is asking about.
    _queue.shift();
    _dropped++; _stats.dropped++;
    return _arm();
  }
  _queue.push([pid, String(event).slice(0, 64), _clean(meta), new Date()]);
  _stats.queued++;
  _arm();
}

function _arm() {
  if (_timer) return;
  _timer = setTimeout(() => { _timer = null; flush().catch(() => {}); }, FLUSH_MS);
  // Never the reason a process stays alive.
  if (_timer.unref) _timer.unref();
}

async function flush() {
  if (!_queue.length) return 0;
  const batch = _queue.splice(0, BATCH);
  // One statement, four parameter columns. Building `VALUES ($1,$2,$3,$4),
  // ($5,...)` by index rather than by interpolation — the event name comes
  // from code, but meta carries player-supplied text.
  const vals = [];
  const params = [];
  batch.forEach((row, i) => {
    const b = i * 4;
    vals.push(`($${b + 1}, $${b + 2}, $${b + 3}::jsonb, $${b + 4})`);
    params.push(row[0], row[1], row[2] === null ? null : JSON.stringify(row[2]), row[3]);
  });
  try {
    await query(null, `
      INSERT INTO player_logs (player_id, event, meta, created_at)
      VALUES ${vals.join(', ')}`, params);
    _stats.written += batch.length;
  } catch (err) {
    _stats.failed += batch.length;
    // Not requeued: a batch that failed once because of its content would fail
    // forever and block everything behind it. Reported instead, with the count,
    // so a broken log is itself visible.
    console.error('[playerlog] flush failed:', err.message);
    ops.alertError('playerlog.flush', 'Не пишется журнал игроков', err,
      { потеряно: batch.length }).catch(() => {});
  }
  if (_dropped) {
    ops.alert('playerlog.overflow', 'Журнал игроков переполнен',
      `отброшено ${_dropped} записей`).catch(() => {});
    _dropped = 0;
  }
  // More waiting: keep going rather than waiting another FLUSH_MS per batch.
  if (_queue.length) return batch.length + await flush();
  return batch.length;
}

// The last hundred things that happened to one player, newest first — the
// admin panel's log pane, and the answer to "куда делся мой предмет".
async function recent(db, playerId, limit = 100) {
  const { rows } = await query(db, `
    SELECT event, meta, created_at FROM player_logs
     WHERE player_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2`, [Number(playerId), Math.min(500, Math.max(1, Number(limit) || 100))]);
  return rows.map(r => ({ event: r.event, meta: r.meta, at: r.created_at }));
}

function stats() { return { ..._stats, pending: _queue.length }; }

module.exports = { log, flush, recent, stats };
