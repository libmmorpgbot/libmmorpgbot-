'use strict';
// ── Карма ───────────────────────────────────────────────────────────────────
// Правила — shared/definitions.js (KARMA_*). Здесь:
//   * хранение: player_progress.karma (миграция 050) + копия на сессии
//     (s.karma) и на записи игрока в комнате (p.karma) — по ней комната не
//     даёт выключить ПК (Room.setPlayerPvpMode);
//   * onPvpKill — убийство игрока в обычной локации: убийце +KARMA_PER_PK;
//   * onMobKill — убитый монстр смывает KARMA_PER_MOB;
//   * resetOnDeath — смерть обнуляет карму (зовёт обработчик respawn);
//   * apply — после входа на этаж: карма на запись комнаты, ПК включён,
//     клиенту — karmaSync.

const { query, tx, hasColumn } = require('./db');
const { FLOOR_IDS } = require('./game/floors');
const { KARMA_PER_PK, KARMA_PER_MOB, KARMA_FLOOR_KEYS, CLAN_WAR_KILL_XP, PVP_OFF_COOLDOWN_MS, PVP_LINGER_MS } = require('../shared/definitions');

const KARMA_FLOORS = new Set(KARMA_FLOOR_KEYS.map(k => FLOOR_IDS[k]).filter(v => v != null));

async function ready() { return hasColumn('player_progress', 'karma'); }
function isKarmaFloor(floorId) { return KARMA_FLOORS.has(Number(floorId)); }

async function load(t, playerId) {
  if (!await ready()) return 0;
  const { rows } = await query(t, 'SELECT karma FROM player_progress WHERE player_id = $1', [playerId]);
  return rows.length ? Math.max(0, Number(rows[0].karma) || 0) : 0;
}

// Карма сессии → запись игрока в комнате и клиенту. Карма > 0 — ПК включён
// и не выключается.
function apply(s) {
  if (!s || !s.socket) return;
  const k = Math.max(0, Number(s.karma) || 0);
  const p = s.room && s.room.players && s.room.players.get(s.socket.id);
  if (p) {
    // Красный ник у других — меняется вместе с наличием кармы.
    if ((p.karma > 0) !== (k > 0)) p._profileRev = (p._profileRev || 0) + 1;
    p.karma = k;
    if (k > 0 && !p.pvpMode) { p.pvpMode = true; p._profileRev = (p._profileRev || 0) + 1; }
  }
  s.socket.emit('karmaSync', { karma: k });
  if (k > 0) s.socket.emit('pvpModeSync', { pvpMode: true });
}

async function _set(t, s, value) {
  const v = Math.max(0, Math.floor(Number(value) || 0));
  await query(t, 'UPDATE player_progress SET karma = $2 WHERE player_id = $1', [s.playerId, v]);
  s.karma = v;
  apply(s);
  return v;
}

// ── ПК, включённый игроком, переживает вход на новый этаж ───────────────────
// Каждый вход (перезаход, смена локации, телепорт, возврат из события)
// создаёт новую запись в комнате с выключенным ПК. Состояние держится на
// сессии (s.pvpOn, s.pvpOffAt) и в базе (миграция 053) и возвращается сюда.
// Только в обычных локациях и в городе: события ставят ПК сами, а в первой
// локации ПК запрещён вовсе.
async function _pvpReady() { return hasColumn('player_progress', 'pvp_on'); }
function restorePvp(s) {
  if (!s || !s.socket || !s.room) return;
  const p = s.room.players && s.room.players.get(s.socket.id);
  if (!p) return;
  if (s.karma > 0) { apply(s); return; }
  if (!s.pvpOn) return;
  const f = Number(s.room.floor);
  if (f !== FLOOR_IDS.hub && !isKarmaFloor(f)) return;
  if (f === FLOOR_IDS.left) return;
  const offAt = Number(s.pvpOffAt) || 0;
  if (!p.pvpMode) { p.pvpMode = true; p._profileRev = (p._profileRev || 0) + 1; }
  p._pvpOnAt = offAt - PVP_OFF_COOLDOWN_MS;
  s.socket.emit('pvpModeSync', { pvpMode: true, offAt });
}
// Игрок переключил ПК (обработчик setPvpMode): запомнить, что вышло.
function notePvp(s) {
  const p = s && s.room && s.room.players && s.room.players.get(s.socket.id);
  if (!p) return;
  const on = !!p.pvpMode;
  const offAt = on ? (Number(p._pvpOnAt) || 0) + PVP_OFF_COOLDOWN_MS : 0;
  if (on === !!s.pvpOn && offAt === (Number(s.pvpOffAt) || 0)) return;
  s.pvpOn = on; s.pvpOffAt = offAt;
  tx(async (t) => {
    if (!await _pvpReady()) return;
    await query(t, 'UPDATE player_progress SET pvp_on = $2, pvp_off_at = $3 WHERE player_id = $1', [s.playerId, on, offAt]);
  }).catch(err => console.error('[karma] pvp state:', err.message));
}

// ── нельзя сбежать, закрыв игру ─────────────────────────────────────────────
// Отключившийся в бою с игроками (удар за последние PVP_LINGER_MS) или с
// кармой не исчезает сразу: тело стоит ещё PVP_LINGER_MS, его можно убить —
// и тогда работает всё как обычно (карма убийце, выпадение вещи, обнуление
// кармы), а в базе игрок переносится в город. Сессия на это время хранится
// здесь: сокета уже нет, а убийству нужна её запись.
const _linger = new Map();   // socketId -> session
function shouldLinger(s, rec) {
  if (!s || !rec || !(rec.hp > 0)) return false;
  if (s.karma > 0) return true;
  return Date.now() - (Number(rec._pvpAt) || 0) < PVP_LINGER_MS;
}
function holdLinger(socketId, s, room) {
  _linger.set(socketId, s);
  const rec = room.players.get(socketId);
  if (rec) rec._lingering = true;
  const t = setTimeout(() => {
    _linger.delete(socketId);
    if (room.players.get(socketId) === rec) {
      try { room.removePlayer(socketId); } catch (e) { console.error('[karma] linger remove:', e.message); }
      if (room.io) room.io.to(`floor_${room.floor}`).emit('playerLeft', { id: socketId });
    }
  }, PVP_LINGER_MS);
  if (t.unref) t.unref();
}
function lingerSession(socketId) { return _linger.get(socketId) || null; }

// После входа на этаж (sendGameStart) — карма и ПК из базы на сессию и комнату.
async function onEnter(t, s) {
  if (!s || !s.playerId) return;
  if (await ready()) s.karma = await load(t, s.playerId);
  if (await _pvpReady()) {
    const { rows } = await query(t, 'SELECT pvp_on, pvp_off_at FROM player_progress WHERE player_id = $1', [s.playerId]);
    if (rows.length) { s.pvpOn = !!rows[0].pvp_on; s.pvpOffAt = Number(rows[0].pvp_off_at) || 0; }
  }
  if (s.karma > 0) apply(s);
  else if (await ready()) s.socket && s.socket.emit('karmaSync', { karma: 0 });
  restorePvp(s);
}

async function onMobKill(t, s) {
  if (!s || !s.playerId || !(s.karma > 0) || !await ready()) return;
  await _set(t, s, s.karma - KARMA_PER_MOB);
}

async function resetOnDeath(t, s) {
  if (!s || !s.playerId) return;
  // Смерть снимает и ПК: в город — мирным.
  if (s.pvpOn && await _pvpReady()) {
    s.pvpOn = false; s.pvpOffAt = 0;
    await query(t, 'UPDATE player_progress SET pvp_on = false, pvp_off_at = 0 WHERE player_id = $1', [s.playerId]);
  }
  if (!await ready()) return;
  if (!(s.karma > 0)) { s.karma = 0; return; }
  await _set(t, s, 0);
}

// Убийство игрока игроком. Зовётся из открытой ветки modes._pvpEliminate —
// ни один режим смерть не забрал. vs/ks — сессии жертвы и убийцы.
async function onPvpKill(t, vs, ks, floorId, { victimPvp = false } = {}) {
  if (!vs || !ks || !vs.playerId || !ks.playerId || vs.playerId === ks.playerId) return null;
  if (!isKarmaFloor(floorId) || !await ready()) return null;
  // Война кланов: враги бьют друг друга без кармы — ни начисления, ни
  // выпадения вещей (server/db/repos/clanwars.js).
  const ca = vs.clan && vs.clan.clanId, cb = ks.clan && ks.clan.clanId;
  if (ca && cb && await require('./db/repos/clanwars').atWar(t, ca, cb)) {
    // Зато клану убийцы — очки клана (CLAN_WAR_KILL_XP), видны во «Вкладе».
    // Точка сохранения: до миграции 052 источник 'clan_war' запрещён, и
    // отказ не должен утянуть за собой остальную транзакцию.
    const clans = require('./db/repos/clans');
    let xp = null;
    await query(t, 'SAVEPOINT clan_war_xp');
    try {
      xp = await clans.addBonusXp(t, cb, ks.playerId, 'clan_war', CLAN_WAR_KILL_XP);
      await query(t, 'RELEASE SAVEPOINT clan_war_xp');
    } catch (e) {
      await query(t, 'ROLLBACK TO SAVEPOINT clan_war_xp');
      console.error('[karma] clan war xp:', e.message);
    }
    if (xp && xp.leveledUp) setImmediate(() => clans.refreshMembersBm(cb).catch(() => {}));
    if (xp && ks.socket) ks.socket.emit('clanWarNotice', { text: `Враг повержен — клану +${CLAN_WAR_KILL_XP} очка` });
    return { war: true, clanXp: xp ? CLAN_WAR_KILL_XP : 0 };
  }
  const victimKarma = await load(t, vs.playerId);
  vs.karma = victimKarma;
  // Вещи с ПК-шников не выпадают (снято по просьбе владельца) — наказание
  // кармой: ни опыта, ни дропа с монстров, пока она не смыта.
  const drop = null;
  // Смерть жертвы обнуляет её карму сразу, не дожидаясь возрождения.
  if (victimKarma > 0) await _set(t, vs, 0);
  // Оба были в ПК — убийце кармы нет.
  if (victimPvp) return { drop, victimKarma, killerKarma: await load(t, ks.playerId), bothPvp: true };
  const killerKarma = await load(t, ks.playerId);
  ks.karma = killerKarma;
  await _set(t, ks, killerKarma + KARMA_PER_PK);
  return { drop, victimKarma, killerKarma: ks.karma };
}

// То же, но своей транзакцией и с рассылкой — для modes._pvpEliminate, у
// которого транзакции нет.
function onPvpKillSoon(vs, ks, floorId, opts = {}) {
  if (!vs || !ks) return;
  tx(async (t) => {
    const res = await onPvpKill(t, vs, ks, floorId, opts);
    // Убит, уже отключившись: в базе — в город, без ПК, как после возрождения.
    if (vs.socket && _linger.get(vs.socket.id) === vs) {
      const hub = require('./world').roomOf(FLOOR_IDS.hub);
      const sp = hub && hub.spawnPointFor();
      if (sp) await require('./db/repos/players').savePosition(t, vs.playerId, FLOOR_IDS.hub, sp.x, sp.y);
      if (await _pvpReady()) await query(t, 'UPDATE player_progress SET pvp_on = false, pvp_off_at = 0 WHERE player_id = $1', [vs.playerId]);
      if (!(res && res.victimKarma > 0) && await ready()) await query(t, 'UPDATE player_progress SET karma = 0 WHERE player_id = $1', [vs.playerId]);
    }
    if (res && res.drop) {
      if (typeof vs.pushItems === 'function') { await vs.pushItems(t); await vs.pushStats(t); }
      if (typeof ks.pushItems === 'function') await ks.pushItems(t);
      if (res.drop.equipped) await require('./db/repos/stats').refreshBm(t, vs.playerId);
      vs.socket && vs.socket.emit('pkDrop', { lost: true, name: res.drop.name, by: ks.username });
      ks.socket && ks.socket.emit('pkDrop', { lost: false, name: res.drop.name, from: vs.username });
    }
    return res;
  }).catch(err => console.error('[karma] pvp kill:', err.message));
}

module.exports = { ready, isKarmaFloor, load, apply, onEnter, onMobKill, resetOnDeath, onPvpKill, onPvpKillSoon, restorePvp, notePvp, shouldLinger, holdLinger, lingerSession, KARMA_FLOORS };
