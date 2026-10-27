'use strict';
// Guild War (Война гильдий) — tower ownership, combat window, and hourly
// income — moved out of server/index.js verbatim as a factory
// (createGuildWar(deps)), same pattern as arena3.js/death-battle.js.
const {
  GUILD_WAR_DAYS_MSK, GUILD_WAR_HOURS_MSK, GUILD_WAR_WINDOW_MS, GUILD_WAR_TOWER_HP, GUILD_WAR_HOLD_MS,
  GUILD_WAR_INCOME_INTERVAL_MS, GUILD_WAR_SIDES, GUILD_WAR_SIDE_KEYS,
  EVENT_NOTIFY_BEFORE_MS, nextEventStartAt,
} = require('../../shared/definitions');
const { FLOOR_IDS } = require('../game/floors');
// Storage is INJECTED. This file used to require two Mongo models directly,
// which made the last piece of game logic in the tree that could not run
// without Mongo — and none of what it does with them is Mongo-shaped: load the
// sides' owners, save one, pay the day's Liberty, tell that clan. Handed in,
// so the schedule and the capture rules stay here and the persistence lives
// with the rest of the persistence (server/db/repos/guildwar.js).
module.exports = function createGuildWar(deps) {
  const {
    io, playerFloorMap, _socketForTelegramId, notifyEventSoon, broadcastLeadMs, notifyEventStarted, safeTimeout,
    loadSides, saveSide, payDaily, clanForStorage, clanStorageViewFor,
  } = deps;

  // ── Война гильдий (Guild War) ────────────────────────────────────────────────
  // Twice a week (GUILD_WAR_DAYS_MSK), 22:00-22:15 MSK, on its own floor with
  // four crystal towers, one per corner room (Room.spawnGuildWarTowers).
  // Whoever lands the killing blow takes a tower for their clan and it comes
  // back at full health (Room.attackEnemy).
  //
  // Награда — стороны поля, а не один замок. Клан, который к концу окна держит
  // обе правые вышки, владеет правой стороной (200 Liberty в сутки), обе
  // левые — левой (100). Сторона, которую никто не собрал целиком, остаётся у
  // прежнего владельца. Держать все четыре GUILD_WAR_HOLD_MS подряд — это
  // досрочная победа: обе стороны сразу, окно закрывается. Каждое окно
  // начинается с ничьих вышек. Деньги — раз в московские сутки, в казну
  // клана (_gwPayDaily), раздаёт их лидер.
  const _gw = {
    phase: 'closed',      // 'closed' → 'live' → ('won' for a few seconds) → 'closed'
    // Владельцы сторон: { clanId, name, icon, capturedAt } или null.
    sides: { right: null, left: null },
    // Клан, у которого ОБЕ стороны (иначе null) — для старых полей пакета и
    // строки в логе загрузки.
    ownerClanId: null, ownerClanName: null, ownerClanIcon: null, capturedAt: 0,
    // Кто сейчас держит все четыре и с какого момента.
    holdClanId: null, holdClanName: null, holdClanIcon: null, holdSince: 0,
    openTimer: null, closeTimer: null, notifyTimer: null, incomeTimer: null, holdTimer: null,
  };
  // Сколько после победы ждать, прежде чем выставить всех из локации: чтобы
  // успели увидеть, кто победил.
  const GW_VICTORY_LINGER_MS = 10 * 1000;

  // The floor's Room, looked up lazily: world.js is loaded after this file.
  function _gwRoom() {
    try { return require('../world').roomOf(FLOOR_IDS.guildWar); } catch { return null; }
  }
  function _gwTowers() {
    const r = _gwRoom();
    return r && typeof r.guildWarTowers === 'function' ? r.guildWarTowers() : [];
  }

  function _gwNextOpenAt(from = Date.now()) {
    return nextEventStartAt(GUILD_WAR_DAYS_MSK, GUILD_WAR_HOURS_MSK, from);
  }

  function _gwSyncOwner() {
    const r = _gw.sides.right, l = _gw.sides.left;
    const both = r && l && r.clanId === l.clanId ? r : null;
    _gw.ownerClanId = both ? both.clanId : null;
    _gw.ownerClanName = both ? both.name : null;
    _gw.ownerClanIcon = both ? both.icon : null;
    _gw.capturedAt = both ? Math.max(r.capturedAt || 0, l.capturedAt || 0) : 0;
  }

  function _gwSideView(key) {
    const sd = _gw.sides[key];
    return {
      clanId: sd ? sd.clanId : null, clanName: sd ? sd.name : null, clanIcon: sd ? sd.icon : null,
      liberty: GUILD_WAR_SIDES[key].liberty, towers: GUILD_WAR_SIDES[key].towers,
    };
  }

  // Сторона перешла клану (или осталась у него). Запоминается сразу и
  // пишется в базу — перезапуск не должен отдавать сторону никому.
  function _gwSetSide(key, owner) {
    const prev = _gw.sides[key];
    const at = (prev && prev.clanId === owner.clanId) ? (prev.capturedAt || Date.now()) : Date.now();
    _gw.sides[key] = { clanId: owner.clanId, name: owner.name, icon: owner.icon, capturedAt: at };
    _gwSyncOwner();
    saveSide(key, owner.clanId, at).catch(err => console.error('[guildwar] persist side failed', err));
    return !prev || prev.clanId !== owner.clanId;
  }

  function _gwPublicState() {
    return {
      phase: _gw.phase,
      sides: { right: _gwSideView('right'), left: _gwSideView('left') },
      nextAt: _gwNextOpenAt(),
      closesAt: _gw.closesAt || 0,
      ownerClanId: _gw.ownerClanId, ownerClanName: _gw.ownerClanName, ownerClanIcon: _gw.ownerClanIcon,
      capturedAt: _gw.capturedAt,
      towerHp: GUILD_WAR_TOWER_HP,
      towers: _gwTowers().map(t => ({
        i: t.gwIndex, ownerClanId: t.ownerClanId, ownerClanName: t.ownerClanName, ownerClanIcon: t.ownerClanIcon,
      })),
      holdClanId: _gw.holdClanId, holdClanName: _gw.holdClanName,
      holdUntil: _gw.holdClanId ? _gw.holdSince + GUILD_WAR_HOLD_MS : 0,
      holdMs: GUILD_WAR_HOLD_MS,
      now: Date.now(),
    };
  }

  function _gwClearHold() {
    clearTimeout(_gw.holdTimer);
    _gw.holdTimer = null;
    _gw.holdClanId = null; _gw.holdClanName = null; _gw.holdClanIcon = null; _gw.holdSince = 0;
  }

  // Re-derives "does one clan hold all four?" from the towers themselves —
  // never from a running tally, so it cannot drift from what is on the map.
  function _gwRecheckHold() {
    const towers = _gwTowers();
    const first = towers[0];
    const allOne = towers.length > 0 && first.ownerClanId != null
      && towers.every(t => t.ownerClanId === first.ownerClanId);
    if (!allOne) { _gwClearHold(); return; }
    if (_gw.holdClanId === first.ownerClanId) return;   // clock already running
    _gwClearHold();
    _gw.holdClanId = first.ownerClanId;
    _gw.holdClanName = first.ownerClanName;
    _gw.holdClanIcon = first.ownerClanIcon;
    _gw.holdSince = Date.now();
    _gw.holdTimer = safeTimeout('gwHold', _gwHoldDone, GUILD_WAR_HOLD_MS);
  }

  function _gwHoldDone() {
    _gw.holdTimer = null;
    if (_gw.phase !== 'live') return;
    // Проверяем ещё раз по самим вышкам: таймер мог пережить захват, который
    // по какой-то причине не дошёл до _gwRecheckHold.
    const towers = _gwTowers();
    if (!towers.length || !towers.every(t => t.ownerClanId === _gw.holdClanId)) { _gwRecheckHold(); return; }
    _gwVictory({ clanId: _gw.holdClanId, clanName: _gw.holdClanName, clanIcon: _gw.holdClanIcon });
  }

  // The clan that held all four for the full clock takes BOTH sides — the
  // full 300 Liberty a day — and the window ends early.
  function _gwVictory(w) {
    const prevOwnerClanName = _gw.ownerClanName;
    const owner = { clanId: w.clanId, name: w.clanName, icon: w.clanIcon };
    for (const key of GUILD_WAR_SIDE_KEYS) _gwSetSide(key, owner);
    _gw.phase = 'won';
    clearTimeout(_gw.closeTimer);
    _gw.closeTimer = safeTimeout('gwClose', _gwCloseWindow, GW_VICTORY_LINGER_MS);
    io.emit('guildWarVictory', { clanName: w.clanName, clanIcon: w.clanIcon, prevOwnerClanName });
    io.emit('chatMsg', {
      username: 'СОБЫТИЕ',
      text: `🏆 Клан «${w.clanName}» удержал все 4 вышки и победил в Войне гильдий! Обе стороны его — ${GUILD_WAR_SIDES.right.liberty + GUILD_WAR_SIDES.left.liberty} Liberty в казну каждый день.`,
      time: new Date().toISOString(),
    });
    _gwClearHold();
    io.emit('guildWarState', _gwPublicState());
  }

  // Arms the next daily window (22:00 MSK) plus its 30-minute warning. Called
  // at boot and every time the window closes — same shape as _race10Schedule.
  function _gwSchedule() {
    clearTimeout(_gw.openTimer);
    clearTimeout(_gw.notifyTimer);
    const openAt = _gwNextOpenAt();
    _gw.openTimer = safeTimeout('gwOpen', () => _gwOpenWindow(openAt), Math.max(0, openAt - Date.now()));
    // Сдвиг на длительность самого прохода. Telegram принимает около тридцати
    // сообщений в секунду, и четыре тысячи адресатов — это больше двух минут:
    // предупреждение «за 30 минут», отправленное ровно за тридцать, доходило до
    // конца очереди за двадцать восемь. Начинаем раньше на столько, сколько
    // проход занимает, — и последний получает свои тридцать.
    const warnIn = openAt - EVENT_NOTIFY_BEFORE_MS - broadcastLeadMs() - Date.now();
    if (warnIn > 0) _gw.notifyTimer = safeTimeout('gwNotify', () => notifyEventSoon('guildWar', openAt), warnIn);
  }

  function _gwOpenWindow(openAt = Date.now()) {
    _gw.phase = 'live';
    _gw.closesAt = Date.now() + GUILD_WAR_WINDOW_MS;
    // Каждое окно начинается с нуля: все четыре вышки ничьи и целые.
    const room = _gwRoom();
    if (room && typeof room.resetGuildWarTowers === 'function') room.resetGuildWarTowers();
    _gwClearHold();
    notifyEventStarted('guildWar', openAt);
    clearTimeout(_gw.closeTimer);
    _gw.closeTimer = safeTimeout('gwClose', _gwCloseWindow, GUILD_WAR_WINDOW_MS);
    io.emit('guildWarState', _gwPublicState());
  }

  // Hard-closes combat access: whoever holds the tower right now keeps it
  // (ownership doesn't reset here, only the closeTimer/phase do) and everyone
  // still standing inside the zone is ejected to the hub. Re-arms tomorrow's
  // window immediately, same as _race10CloseWindow.
  //
  // Guild War is its own floor now (see server/game/floors.js), so "ejected"
  // means a real floor change, not just a position/flag reset within one
  // shared Room — that's what _forceEnterLocation (socket.data, set up per
  // connection near the enterLocation handler) exists for: this runs from a
  // module-level timer with no socket of its own in scope, so it has to reach
  // into each affected connection from outside.
  // Конец окна без досрочной победы: каждая сторона — тому, кто держит обе её
  // вышки. Не собранная целиком сторона остаётся у прежнего владельца.
  function _gwSettleSides() {
    const byIdx = new Map(_gwTowers().map(t => [t.gwIndex, t]));
    const lines = [];
    for (const key of GUILD_WAR_SIDE_KEYS) {
      const [a, b] = GUILD_WAR_SIDES[key].towers.map(i => byIdx.get(i));
      const sideRu = key === 'right' ? 'правые' : 'левые';
      if (a && b && a.ownerClanId != null && a.ownerClanId === b.ownerClanId) {
        _gwSetSide(key, { clanId: a.ownerClanId, name: a.ownerClanName, icon: a.ownerClanIcon });
        lines.push(`клан «${a.ownerClanName}» держит обе ${sideRu} вышки — ${GUILD_WAR_SIDES[key].liberty} Liberty в казну каждый день`);
      } else {
        const prev = _gw.sides[key];
        lines.push(prev ? `${sideRu} вышки никто не собрал — остаются у «${prev.name}»` : `${sideRu} вышки никто не собрал`);
      }
    }
    io.emit('chatMsg', {
      username: 'СОБЫТИЕ',
      text: `🏰 Война гильдий окончена: ${lines.join('; ')}.`,
      time: new Date().toISOString(),
    });
  }

  function _gwCloseWindow() {
    if (_gw.phase === 'live') _gwSettleSides();
    _gw.phase = 'closed';
    _gw.closesAt = 0;
    clearTimeout(_gw.closeTimer);
    _gwClearHold();
    for (const [sid, floor] of playerFloorMap) {
      if (floor !== FLOOR_IDS.guildWar) continue;
      io.sockets.sockets.get(sid)?.data?._forceEnterLocation?.('hub');
    }
    io.emit('guildWarState', _gwPublicState());
    _gwSchedule();
  }

  // A tower changed hands (Room.attackEnemy/skillAttackEnemy returned
  // result.captured — called from modes._onCombatResult). Tells everyone
  // which tower went to whom and restarts or stops the hold clock. The castle
  // itself only changes owner on a full hold (_gwVictory).
  function _gwApplyCapture(enemyId, result) {
    if (_gw.phase !== 'live') return;
    const t = _gwTowers().find(x => x.id === enemyId);
    io.emit('guildWarCaptured', {
      tower: t ? t.gwIndex : null,
      newOwnerClanName: result.newOwnerClanName, newOwnerClanIcon: result.newOwnerClanIcon,
      prevOwnerClanName: result.prevOwnerClanName,
    });
    _gwRecheckHold();
    io.emit('guildWarState', _gwPublicState());
  }

  // Pushes a fresh clanStorage payload to every online member — top-level twin
  // of the per-connection pushClanStorage (handlers2/social.js), needed
  // because there is no socket in scope inside the income job.
  //
  // ── «хранилище клана закрыто», хотя оно открыто ────────────────────────────
  // Здесь стояла своя, урезанная копия пакета: { storageUnlocked, storage }.
  // Клиент (_clanStorageHTML, js/clans.js) читает поле `unlocked`, а не
  // `storageUnlocked`, и заменяет пакетом ВСЁ состояние хранилища. Теперь
  // каждому уходит тот же полный вид, что и по clanStorageSync: одна форма
  // пакета на всю игру.
  async function _gwStoragePushToClan(clan, note) {
    for (const m of clan.members) {
      const target = _socketForTelegramId(m.telegramId);
      if (!target || m.playerId == null) continue;
      const view = await clanStorageViewFor(clan._id, m.playerId).catch(() => null);
      if (view) target.emit('clanStorage', view);
      if (note) target.emit('clanStorageOk', { msg: note });
    }
  }

  // Раз в час: не наступили ли новые московские сутки, за которые владельцам
  // сторон ещё не заплачено. Сама выплата идемпотентна (paid_day, repos/
  // guildwar.js), поэтому лишняя проверка ничего не стоит, а перезапуск
  // ровно в полночь не теряет день — его доплатит первая же проверка.
  async function _gwPayDaily() {
    const paid = await payDaily();
    if (!paid.length) return paid;
    const byClan = new Map();
    for (const p of paid) {
      const cur = byClan.get(p.clanId) || { amount: 0, keys: [] };
      cur.amount += p.amount; cur.keys.push(p.key);
      byClan.set(p.clanId, cur);
    }
    for (const [clanId, { amount, keys }] of byClan) {
      const clan = await clanForStorage(clanId).catch(() => null);
      if (!clan) continue;
      const what = keys.length > 1 ? 'все вышки' : (keys[0] === 'right' ? 'правые вышки' : 'левые вышки');
      await _gwStoragePushToClan(clan, `Война гильдий: +${amount} Liberty в казну клана за ${what}`);
    }
    // Владельцы могли смениться (клан распущен — строка обнулилась сама),
    // так что состояние перечитывается из базы, а не правится по месту.
    await _gwRestore();
    return paid;
  }

  function _gwIncomeSafe() {
    _gwPayDaily().catch(err => console.error('_gwPayDaily:', err));
    _gw.incomeTimer = safeTimeout('gwIncome', _gwIncomeSafe, GUILD_WAR_INCOME_INTERVAL_MS);
  }

  function _gwIncomeSchedule() {
    clearTimeout(_gw.incomeTimer);
    // Сразу — доплатить сутки, если сервер лежал в полночь, — и дальше с
    // начала каждого часа.
    _gwPayDaily().catch(err => console.error('_gwPayDaily:', err));
    const now = Date.now();
    const nextHour = Math.ceil(now / GUILD_WAR_INCOME_INTERVAL_MS) * GUILD_WAR_INCOME_INTERVAL_MS;
    _gw.incomeTimer = safeTimeout('gwIncome', _gwIncomeSafe, nextHour - now + 1000);
  }

  // Restores the sides' owners at boot. Without it a restart hands both
  // sides back to nobody — a war's worth of a clan's work undone by a deploy.
  async function _gwRestore() {
    const st = await loadSides().catch(() => null);
    if (!st) return;
    for (const key of GUILD_WAR_SIDE_KEYS) _gw.sides[key] = st[key] || null;
    _gwSyncOwner();
  }

  return {
    _gw, _gwNextOpenAt, _gwPublicState, _gwSchedule, _gwOpenWindow, _gwCloseWindow,
    _gwApplyCapture, _gwHoldDone, _gwIncomeSchedule, _gwRestore, _gwPayDaily, _gwSettleSides,
  };
};
