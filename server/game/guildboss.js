'use strict';
// ── Гильдийские боссы: бой ──────────────────────────────────────────────────
// Правила — shared/definitions.js (GUILD_BOSS_*), строки и деньги —
// server/db/repos/guildboss.js. Здесь — то, что живёт только в памяти: зал
// (собственный приватный Room, как у Логова), кто вошёл, кто умер, таймер.
//
// Зал один на клан и на вызов. Участники встают в одну дорожку без владельца
// (Room.guildBossJoin), так что видят друг друга и бьют одного босса. Умерший
// вылетает домой и в этот вызов больше не входит. Дроп — один бросок на клан,
// целиком в хранилище клана; раздаёт лидер (repos/guildboss.settleKill).
//
// Перезапуск сервера зал теряет; вызов, застигнутый активным, возвращается
// лидеру при старте (repos/guildboss.refundActive) — см. server/workers.js.

const Room = require('./Room');
const { FLOOR_IDS } = require('./floors');
const { GUILD_BOSS_LIFETIME_MS, bossLairBoss } = require('../../shared/definitions');

// Сколько после убийства постоять в зале, прежде чем всех отправить домой:
// чтобы увидели, как босс падает, и окно с дропом.
const GB_LINGER_MS = 4000;

module.exports = function createGuildBoss(deps) {
  const { io, _returnToHub, safeTimeout, finishSummon, settleKill, notifyClan, playerIdOf } = deps;

  // clanId -> { summonId, clanId, level, room, startedAt, expiresAt, timer,
  //             done, dead: Set<playerId> }
  const _gb = new Map();

  function _gbState(clanId) { return _gb.get(clanId) || null; }

  function _gbPublic(clanId) {
    const g = _gb.get(clanId);
    if (!g || g.done) return null;
    const boss = g.room.enemies.find(e => e.guildBoss === clanId && e.hp > 0);
    return {
      summonId: g.summonId, level: g.level,
      name: (bossLairBoss(g.level) || {}).name || '',
      expiresAt: g.expiresAt,
      hp: boss ? boss.hp : 0, maxHp: boss ? boss.maxHp : 0,
      inside: g.room.guildBossParticipants(clanId).length,
    };
  }

  // Вызов уже записан и оплачен (repos/guildboss.summon) — поднять зал.
  function _gbStart({ summonId, clanId, level, at }) {
    if (_gb.has(clanId)) return null;
    const room = new Room(FLOOR_IDS.fear, io, {}, null);
    const boss = room.fearSpawnBoss(0, level, { guildBoss: clanId });
    if (!boss) return null;
    const startedAt = at || Date.now();
    const g = {
      summonId, clanId, level, room, startedAt,
      expiresAt: startedAt + GUILD_BOSS_LIFETIME_MS,
      done: false, dead: new Set(), timer: null,
    };
    g.timer = safeTimeout('guildBossExpire', () => _gbExpire(clanId, summonId), Math.max(1000, g.expiresAt - Date.now()));
    _gb.set(clanId, g);
    return g;
  }

  // Можно ли войти: босс стоит и этот игрок в этот вызов ещё не умирал.
  function _gbCanEnter(clanId, playerId) {
    const g = _gb.get(clanId);
    if (!g || g.done) return 'Босс не вызван';
    if (g.dead.has(playerId)) return 'Вы уже пали в этом бою — дождитесь следующего вызова';
    return null;
  }

  function _gbRoomOf(socketId) {
    for (const g of _gb.values()) if (g.room.players.has(socketId)) return g;
    return null;
  }

  // Смерть в зале — домой, и обратно в этот вызов нельзя.
  function _gbEliminate(socketId) {
    const g = _gbRoomOf(socketId);
    if (!g) return false;
    const p = g.room.players.get(socketId);
    if (!p || p._guildBoss !== g.clanId) return false;
    const pid = playerIdOf(socketId);
    if (pid) g.dead.add(pid);
    const spot = _returnToHub(socketId);
    io.to(socketId).emit('guildBossOut', { reason: 'dead', level: g.level, x: spot?.x, y: spot?.y });
    return true;
  }

  // Убийство: итог и дроп в хранилище клана — одной транзакцией
  // (settleKill), потом весь клан в сети видит окно с дропом и свежее
  // хранилище, а через паузу все из зала — домой. Повторный удар по трупу в
  // тот же тик сюда не пройдёт: done ставится до первого await.
  async function _gbTrackKill(socketId, result) {
    const clanId = result.guildBoss;
    const g = _gb.get(clanId);
    if (!g || g.done) return;
    g.done = true;
    clearTimeout(g.timer);
    const killerPid = playerIdOf(socketId);
    let drop = null;
    try { drop = await settleKill(g.summonId, clanId, g.level, killerPid || null); }
    catch (err) { console.error('[guildBoss] settle:', err.message); }
    const payload = { level: g.level, drop, toStorage: true };
    for (const sid of g.room.players.keys()) io.to(sid).emit('guildBossKilled', payload);
    await notifyClan(clanId, payload, [...g.room.players.keys()]).catch(() => {});
    safeTimeout('guildBossLinger', () => _gbClose(clanId, 'killed'), GB_LINGER_MS);
  }

  function _gbExpire(clanId, summonId) {
    const g = _gb.get(clanId);
    if (!g || g.summonId !== summonId || g.done) return;
    g.done = true;
    finishSummon(summonId, 'expired', null).catch(err => console.error('[guildBoss] expire:', err.message));
    _gbClose(clanId, 'expired');
  }

  // Всех, кто ещё в зале, — домой; зал забыть.
  function _gbClose(clanId, reason) {
    const g = _gb.get(clanId);
    if (!g) return;
    clearTimeout(g.timer);
    for (const sid of [...g.room.players.keys()]) {
      const spot = _returnToHub(sid);
      if (reason !== 'killed') io.to(sid).emit('guildBossOut', { reason, level: g.level, x: spot?.x, y: spot?.y });
    }
    _gb.delete(clanId);
  }

  return {
    _gb, _gbState, _gbPublic, _gbStart, _gbCanEnter, _gbRoomOf, _gbEliminate, _gbTrackKill, _gbClose,
  };
};
