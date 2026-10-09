'use strict';
// ── Элитный монстр сезонных крыльев ─────────────────────────────────────────
//
// Заказ: «раз в час в сезонной фарм-зоне появляется элитный монстр… он
// появляется в сезонной фарм-зоне 1 и 2, один на весь сервер, раз в 60-70
// минут респ, шанс дропа x10, фиксированно 3 000 000 здоровья».
//
// «Один на весь сервер» — правило на ДВА этажа сразу, а Room знает только про
// себя. Поэтому решение «пора ли и куда» живёт здесь, а комната лишь ставит
// монстра (Room.spawnEliteMonster) и сообщает о его смерти.
//
// Таймер следующего появления переживает перезапуск: он пишется в boss_state
// (та же таблица, что у таймеров боссов коридоров) под ключом ELITE_ARM.
// Записи нет или срок прошёл — монстр появляется сразу после старта: это и
// «был жив, когда сервер упал», и самый первый запуск.

const { FLOOR_IDS } = require('./floors');
const { ELITE_MOB_RESPAWN_MIN_MS, ELITE_MOB_RESPAWN_MAX_MS } = require('../../shared/definitions');

const ELITE_FLOORS = [FLOOR_IDS.farmSeason, FLOOR_IDS.farmHighSeason];
// Строка в boss_state: (floor = сезонное крыло первой зоны, arm = 'elite').
// Один ключ на сервер, а не на этаж — монстр тоже один.
const ELITE_STATE_FLOOR = FLOOR_IDS.farmSeason;
const ELITE_ARM = 'elite';
// Комната не смогла поставить монстра (этажа нет, не из кого взять вид) —
// повторить через минуту, а не ждать следующего часа.
const RETRY_MS = 60 * 1000;

let _roomOf = null, _save = null;
let _timer = null;
let _nextAt = 0;

function respawnDelayMs() {
  return ELITE_MOB_RESPAWN_MIN_MS + Math.random() * (ELITE_MOB_RESPAWN_MAX_MS - ELITE_MOB_RESPAWN_MIN_MS);
}

function _schedule(at) {
  if (_timer) clearTimeout(_timer);
  _nextAt = at;
  _timer = setTimeout(spawnNow, Math.max(0, at - Date.now()));
  if (_timer.unref) _timer.unref();
}

function aliveFloor() {
  if (!_roomOf) return null;
  for (const f of ELITE_FLOORS) {
    const r = _roomOf(f);
    if (r && typeof r.isEliteAlive === 'function' && r.isEliteAlive()) return f;
  }
  return null;
}

function _onDeath() {
  const at = Date.now() + respawnDelayMs();
  if (_save) _save(ELITE_STATE_FLOOR, ELITE_ARM, at);
  _schedule(at);
}

// Ставит монстра в случайное из двух крыльев. Уже жив где-то — ничего.
function spawnNow() {
  _timer = null;
  if (aliveFloor() != null) return null;
  const order = ELITE_FLOORS.slice().sort(() => Math.random() - 0.5);
  for (const f of order) {
    const room = _roomOf && _roomOf(f);
    const e = room && typeof room.spawnEliteMonster === 'function' ? room.spawnEliteMonster(_onDeath) : null;
    if (e) {
      _nextAt = 0;
      return { floor: f, enemy: e };
    }
  }
  _schedule(Date.now() + RETRY_MS);
  return null;
}

// deadlineMs — сохранённый срок следующего появления (или null).
function init({ roomOf, save, deadlineMs = null }) {
  _roomOf = roomOf; _save = save || null;
  _schedule(Number.isFinite(deadlineMs) && deadlineMs > Date.now() ? deadlineMs : Date.now());
}

function stop() {
  if (_timer) clearTimeout(_timer);
  _timer = null;
}

function status() {
  return { aliveFloor: aliveFloor(), nextAt: _nextAt || null };
}

module.exports = { init, stop, spawnNow, status, aliveFloor, respawnDelayMs, ELITE_FLOORS, ELITE_STATE_FLOOR, ELITE_ARM };
