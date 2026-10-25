'use strict';
// ── Достижения: счётчики и выдача наград ───────────────────────────────────
// Что считается и что за это дают — shared/definitions.js (ACHIEVEMENTS,
// ACH_METRICS). Здесь — три вещи:
//
//   bumpIn             двинуть счётчик — в транзакции самого действия
//                      (ковка, заточка, убийство): действие и его зачёт
//                      коммитятся вместе или не коммитятся вовсе.
//   stateOf            что рисует окно «Достижения».
//   claim              забрать награду. Строка в player_ach_claims — и есть
//                      «забрано»: PRIMARY KEY не даёт выдать второй раз, а
//                      брошенная на выдаче ошибка откатывает и саму строку.
//
// Таблиц до миграции 040 нет — код выкладывается раньше неё. Тогда счётчики
// молча не пишутся (запрос к несуществующей таблице сорвал бы всю
// транзакцию убийства или ковки), а окно честно говорит «скоро».
const { query, hasColumn } = require('./db');
const items = require('./db/repos/items');
const money = require('./db/repos/money');
const runes = require('./db/repos/runes');
const { ACH_METRICS, ACHIEVEMENTS, achievementById } = require('../shared/definitions');

class AchError extends Error {
  constructor(code, msg) { super(msg); this.code = code; this.userMessage = msg; }
}
const err = (code, msg) => { throw new AchError(code, msg); };

// Цели каждого счётчика по возрастанию — чтобы по «было → стало» найти, какие
// достижения только что открылись, и после последней цели счётчик больше не
// трогать.
const _BY_METRIC = new Map();
for (const a of ACHIEVEMENTS) {
  if (!_BY_METRIC.has(a.metric)) _BY_METRIC.set(a.metric, []);
  _BY_METRIC.get(a.metric).push(a);
}
for (const list of _BY_METRIC.values()) list.sort((x, y) => x.target - y.target);
const _topTarget = metric => {
  const list = _BY_METRIC.get(metric) || [];
  return list.length ? list[list.length - 1].target : 0;
};

async function _ready() { return hasColumn('player_ach_claims', 'ach_id'); }

// Открывшиеся между `was` и `now` — для уведомления. Уходит через outbox
// act'а (server/session.js), то есть только после COMMIT.
function _notify(s, metric, was, now) {
  const opened = (_BY_METRIC.get(metric) || []).filter(a => was < a.target && now >= a.target);
  if (opened.length && s && s.socket) {
    s.socket.emit('achReady', { ids: opened.map(a => a.id) });
  }
}

// Счётчик прошёл последнюю цель — дальше считать нечего. Запоминается на
// сессии, чтобы игрок с полумиллионом убийств не писал строку на каждое.
function _maxed(s, metric) { return !!(s && s._achMaxed && s._achMaxed.has(metric)); }
function _markMaxed(s, metric, value) {
  if (!s || value < _topTarget(metric)) return;
  if (!s._achMaxed) s._achMaxed = new Set();
  s._achMaxed.add(metric);
}

// amount — на сколько прибавить ('sum') или достигнутое значение ('max').
async function bumpIn(t, s, metric, amount = 1) {
  const def = Object.hasOwn(ACH_METRICS, metric) ? ACH_METRICS[metric] : null;
  const n = Math.floor(Number(amount) || 0);
  if (!def || def.kind === 'lvl' || !(n > 0)) return null;
  if (!s || !s.playerId || _maxed(s, metric)) return null;
  if (!await _ready()) return null;
  // «Было» — для уведомления о только что открытом. У суммы это просто
  // «стало − n»; у максимума — снимок строки до записи (CTE видит состояние
  // на начало запроса).
  const { rows } = def.kind === 'max'
    ? await query(t, `
        WITH prev AS (SELECT value FROM player_ach_progress WHERE player_id = $1 AND metric = $2)
        INSERT INTO player_ach_progress (player_id, metric, value) VALUES ($1, $2, $3)
        ON CONFLICT (player_id, metric) DO UPDATE
          SET value = GREATEST(player_ach_progress.value, EXCLUDED.value), updated_at = now()
        RETURNING value AS now, COALESCE((SELECT value FROM prev), 0) AS was`, [s.playerId, metric, n])
    : await query(t, `
        INSERT INTO player_ach_progress (player_id, metric, value) VALUES ($1, $2, $3)
        ON CONFLICT (player_id, metric) DO UPDATE
          SET value = player_ach_progress.value + EXCLUDED.value, updated_at = now()
        RETURNING value AS now, value - $3 AS was`, [s.playerId, metric, n]);
  const was = Number(rows[0].was), now = Number(rows[0].now);
  _notify(s, metric, was, now);
  _markMaxed(s, metric, now);
  return { metric, was, now };
}

// Уровень не хранится счётчиком — он и так лежит в player_progress. Здесь
// только уведомление о только что взятом уровне.
function onLevel(s, lvl, gained) {
  const now = Math.floor(Number(lvl) || 0);
  const was = now - Math.max(0, Math.floor(Number(gained) || 0));
  if (now > was) _notify(s, 'lvl', was, now);
}

async function _metricsOf(db, playerId) {
  const out = {};
  const { rows } = await query(db,
    'SELECT metric, value FROM player_ach_progress WHERE player_id = $1', [playerId]);
  for (const r of rows) out[r.metric] = Number(r.value);
  const { rows: p } = await query(db,
    'SELECT lvl FROM player_progress WHERE player_id = $1', [playerId]);
  out.lvl = p.length ? Number(p[0].lvl) || 0 : 0;
  return out;
}

async function stateOf(db, playerId) {
  if (!await _ready()) return { ready: false, metrics: {}, claimed: [] };
  const metrics = await _metricsOf(db, playerId);
  const { rows } = await query(db,
    'SELECT ach_id FROM player_ach_claims WHERE player_id = $1', [playerId]);
  return { ready: true, metrics, claimed: rows.map(r => r.ach_id) };
}

// Порядок как везде: сперва игрок (items.lockPlayer — первый запрос
// транзакции), потом проверки, потом строка «забрано», потом выдача. Любой
// отказ на выдаче (нет места) бросает — и откатывает вместе с выданным
// и саму строку, так что награду можно забрать снова, освободив место.
async function claim(db, playerId, achId) {
  const def = achievementById(achId);
  if (!def) err('no_ach', 'Такого достижения нет');
  if (!await _ready()) err('ach_off', 'Достижения ещё не включены на сервере');
  await items.lockPlayer(db, playerId);

  const metrics = await _metricsOf(db, playerId);
  if ((metrics[def.metric] || 0) < def.target) err('not_done', 'Достижение ещё не выполнено');

  const { rowCount } = await query(db, `
    INSERT INTO player_ach_claims (player_id, ach_id) VALUES ($1, $2)
    ON CONFLICT DO NOTHING`, [playerId, def.id]);
  if (!rowCount) err('already', 'Награда уже получена');

  const granted = [];
  const ref = 'ach:' + def.id;
  for (let i = 0; i < def.rewards.length; i++) {
    const r = def.rewards[i];
    if (r.t === 'rune') {
      const got = await runes.grantRune(db, playerId, r.kind, r.rarity, ref);
      if (!got) err('no_room', 'Инвентарь полон — освободите место и заберите награду снова');
      granted.push({ t: 'rune', itemId: got.itemId, rowId: got.rowId, stats: got.stats });
    } else if (r.t === 'item') {
      const rowId = await items.add(db, playerId, r.id, { qty: r.qty || 1, source: 'achievement', sourceRef: ref });
      if (rowId === null) err('no_room', 'Инвентарь полон — освободите место и заберите награду снова');
      granted.push({ t: 'item', id: r.id, qty: r.qty || 1 });
    } else if (r.t === 'gold' || r.t === 'nexum') {
      await money.credit(db, playerId, r.t, r.n, {
        reason: 'achievement', refType: 'achievement', refId: def.id,
        idemKey: `achievement:${playerId}:${def.id}:${i}`,
      });
      granted.push({ t: r.t, n: r.n });
    }
  }
  return { id: def.id, granted };
}

module.exports = { bumpIn, onLevel, stateOf, claim, AchError };
