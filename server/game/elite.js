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
//
// И всё это — только внутри окна события (eliteEventOn, shared/definitions.js:
// 13.10 с 00:00 до 23:59 по Москве). До окна первый монстр ставится ровно в
// его начало; после окна новых нет, а живой в момент закрытия убирается.

const { FLOOR_IDS } = require('./floors');
const {
  ELITE_MOB_RESPAWN_MIN_MS, ELITE_MOB_RESPAWN_MAX_MS, ELITE_EVENT_START_AT, ELITE_EVENT_END_AT,
} = require('../../shared/definitions');

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
let _endTimer = null;
let _nextAt = 0;
// Часы подменяемы только ради dev/elite-check.js — проверить окно 13.10, не
// дожидаясь 13.10.
let _clock = () => Date.now();

function respawnDelayMs() {
  return ELITE_MOB_RESPAWN_MIN_MS + Math.random() * (ELITE_MOB_RESPAWN_MAX_MS - ELITE_MOB_RESPAWN_MIN_MS);
}

// Срок прижимается к окну события: раньше начала — в начало, на конец или
// позже — не ставится вовсе (монстров после окна нет).
function _schedule(at) {
  if (_timer) clearTimeout(_timer);
  _timer = null;
  const when = Math.max(at, ELITE_EVENT_START_AT);
  if (when >= ELITE_EVENT_END_AT) { _nextAt = 0; return; }
  _nextAt = when;
  _timer = setTimeout(spawnNow, Math.max(0, when - _clock()));
  if (_timer.unref) _timer.unref();
}

// Конец окна: живой монстр уходит вместе с событием.
function endEvent() {
  _endTimer = null;
  if (_timer) clearTimeout(_timer);
  _timer = null; _nextAt = 0;
  if (!_roomOf) return;
  for (const f of ELITE_FLOORS) {
    const r = _roomOf(f);
    if (r && typeof r.despawnElite === 'function') r.despawnElite();
  }
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
  const at = _clock() + respawnDelayMs();
  if (_save) _save(ELITE_STATE_FLOOR, ELITE_ARM, at);
  _schedule(at);
}

// Ставит монстра в случайное из двух крыльев. Уже жив где-то — ничего.
function spawnNow() {
  _timer = null;
  const now = _clock();
  if (now < ELITE_EVENT_START_AT) { _schedule(ELITE_EVENT_START_AT); return null; }
  if (now >= ELITE_EVENT_END_AT) return null;
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
  _schedule(now + RETRY_MS);
  return null;
}

// deadlineMs — сохранённый срок следующего появления (или null).
function init({ roomOf, save, deadlineMs = null }) {
  _roomOf = roomOf; _save = save || null;
  const now = _clock();
  _schedule(Number.isFinite(deadlineMs) && deadlineMs > now ? deadlineMs : now);
  if (_endTimer) clearTimeout(_endTimer);
  _endTimer = null;
  // setTimeout не держит больше ~24.8 суток; дальше конец окна перепроверит
  // следующий запуск сервера, а до него таймер просто не нужен.
  const untilEnd = ELITE_EVENT_END_AT - now;
  if (untilEnd > 0 && untilEnd < 2 ** 31 - 1) {
    _endTimer = setTimeout(endEvent, untilEnd);
    if (_endTimer.unref) _endTimer.unref();
  }
}

function stop() {
  if (_timer) clearTimeout(_timer);
  if (_endTimer) clearTimeout(_endTimer);
  _timer = null; _endTimer = null;
}

function _setClock(fn) { _clock = fn || (() => Date.now()); }

function status() {
  return { aliveFloor: aliveFloor(), nextAt: _nextAt || null };
}

module.exports = { init, stop, spawnNow, endEvent, status, _setClock, aliveFloor, respawnDelayMs, ELITE_FLOORS, ELITE_STATE_FLOOR, ELITE_ARM };
