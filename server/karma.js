'use strict';
// ── Карма ───────────────────────────────────────────────────────────────────
// Правила — shared/definitions.js (KARMA_*). Здесь:
//   * хранение: player_progress.karma (миграция 050) + копия на сессии
//     (s.karma) и на записи игрока в комнате (p.karma) — по ней комната не
//     даёт выключить ПК (Room.setPlayerPvpMode);
//   * onPvpKill — убийство игрока в обычной локации: убийце +KARMA_PER_PK,
//     с кармической жертвы — шанс выпадения предмета убийце;
//   * onMobKill — убитый монстр смывает KARMA_PER_MOB;
//   * resetOnDeath — смерть обнуляет карму (зовёт обработчик respawn);
//   * apply — после входа на этаж: карма на запись комнаты, ПК включён,
//     клиенту — karmaSync.

const { query, tx, hasColumn } = require('./db');
const items = require('./db/repos/items');
const { FLOOR_IDS } = require('./game/floors');
const { KARMA_PER_PK, KARMA_PER_MOB, KARMA_FLOOR_KEYS, karmaDropChance, ITEM_DEF } = require('../shared/definitions');

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

// После входа на этаж (sendGameStart) — карма из базы на сессию и комнату.
async function onEnter(t, s) {
  if (!s || !s.playerId || !await ready()) return;
  s.karma = await load(t, s.playerId);
  apply(s);
}

async function onMobKill(t, s) {
  if (!s || !s.playerId || !(s.karma > 0) || !await ready()) return;
  await _set(t, s, s.karma - KARMA_PER_MOB);
}

async function resetOnDeath(t, s) {
  if (!s || !s.playerId || !await ready()) return;
  if (!(s.karma > 0)) { s.karma = 0; return; }
  await _set(t, s, 0);
}

// Случайный предмет жертвы — из экипировки или сумки, не стакающийся (стопки
// камней и материалов не выпадают), не руна в гнезде. Уходит убийце в сумку
// вместе с рунами в нём. Нет места у убийцы — ничего не выпадает.
async function _dropItem(t, victimId, killerId) {
  const [a, b] = victimId < killerId ? [victimId, killerId] : [killerId, victimId];
  await items.lockPlayer(t, a); await items.lockPlayer(t, b);
  const socketCol = await hasColumn('player_items', 'socket_of');
  const { rows } = await query(t, `
    SELECT i.id, i.item_id, i.container
      FROM player_items i JOIN item_catalog c ON c.item_id = i.item_id
     WHERE i.player_id = $1 AND i.container IN ('inventory', 'equipment') AND NOT c.stackable
       ${socketCol ? 'AND i.socket_of IS NULL' : ''}
     ORDER BY random() LIMIT 1`, [victimId]);
  if (!rows.length) return null;
  const it = rows[0];
  if (await items.usedSlots(t, killerId) >= items.SERVER_INV_MAX) return null;
  const rowId = Number(it.id);
  await query(t, `
    UPDATE player_items SET player_id = $2, container = 'inventory', slot = NULL
     WHERE id = $1 AND player_id = $3`, [rowId, killerId, victimId]);
  await items.ledger(t, victimId, it.item_id, -1, { rowId, reason: 'pk_drop', refType: 'pk', refId: String(killerId) });
  await items.ledger(t, killerId, it.item_id, 1, { rowId, reason: 'pk_drop', refType: 'pk', refId: String(victimId) });
  // Руны в гнёздах этого предмета — вместе с ним.
  if (socketCol) {
    const { rows: rs } = await query(t, `
      UPDATE player_items SET player_id = $2 WHERE socket_of = $1 AND player_id = $3
      RETURNING id, item_id`, [rowId, killerId, victimId]);
    for (const r of rs) {
      await items.ledger(t, victimId, r.item_id, -1, { rowId: Number(r.id), reason: 'pk_drop', refType: 'pk', refId: String(killerId) });
      await items.ledger(t, killerId, r.item_id, 1, { rowId: Number(r.id), reason: 'pk_drop', refType: 'pk', refId: String(victimId) });
    }
  }
  const def = ITEM_DEF.find(d => d.id === it.item_id);
  return { itemId: it.item_id, name: (def && def.name) || it.item_id, rowId, equipped: it.container === 'equipment' };
}

// Убийство игрока игроком. Зовётся из открытой ветки modes._pvpEliminate —
// ни один режим смерть не забрал. vs/ks — сессии жертвы и убийцы.
async function onPvpKill(t, vs, ks, floorId) {
  if (!vs || !ks || !vs.playerId || !ks.playerId || vs.playerId === ks.playerId) return null;
  if (!isKarmaFloor(floorId) || !await ready()) return null;
  const victimKarma = await load(t, vs.playerId);
  vs.karma = victimKarma;
  let drop = null;
  if (victimKarma > 0 && Math.random() < karmaDropChance(victimKarma)) {
    drop = await _dropItem(t, vs.playerId, ks.playerId);
  }
  // Смерть жертвы обнуляет её карму сразу, не дожидаясь возрождения.
  if (victimKarma > 0) await _set(t, vs, 0);
  const killerKarma = await load(t, ks.playerId);
  ks.karma = killerKarma;
  await _set(t, ks, killerKarma + KARMA_PER_PK);
  return { drop, victimKarma, killerKarma: ks.karma };
}

// То же, но своей транзакцией и с рассылкой — для modes._pvpEliminate, у
// которого транзакции нет.
function onPvpKillSoon(vs, ks, floorId) {
  if (!vs || !ks) return;
  tx(async (t) => {
    const res = await onPvpKill(t, vs, ks, floorId);
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

module.exports = { ready, isKarmaFloor, load, apply, onEnter, onMobKill, resetOnDeath, onPvpKill, onPvpKillSoon, KARMA_FLOORS };
