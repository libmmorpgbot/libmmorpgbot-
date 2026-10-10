'use strict';
// Guild War (Война гильдий) — tower ownership, combat window, and hourly
// income — moved out of server/index.js verbatim as a factory
// (createGuildWar(deps)), same pattern as arena3.js/death-battle.js.
const {
  GUILD_WAR_DAYS_MSK, GUILD_WAR_HOURS_MSK, GUILD_WAR_WINDOW_MS, GUILD_WAR_TOWER_HP, GUILD_WAR_HOLD_MS,
  GUILD_WAR_SHARD_MIN, GUILD_WAR_SHARD_MAX, GUILD_WAR_INCOME_INTERVAL_MS,
  EVENT_NOTIFY_BEFORE_MS, nextEventStartAt,
  UNIQUE_SHARDS,
} = require('../../shared/definitions');
const { FLOOR_IDS } = require('../game/floors');
// Storage is INJECTED. This file used to require two Mongo models directly,
// which made the last piece of game logic in the tree that could not run
// without Mongo — and none of what it does with them is Mongo-shaped: load the
// castle's owner, save it, add shards to a clan's storage, tell that clan.
// Four functions, handed in, so the schedule and the capture rules stay here
// and the persistence lives with the rest of the persistence.
module.exports = function createGuildWar(deps) {
  const {
    io, playerFloorMap, _socketForTelegramId, notifyEventSoon, broadcastLeadMs, notifyEventStarted, safeTimeout,
    loadCastle, saveCastle, grantClanStorage, clanForStorage, clanStorageViewFor,
  } = deps;

  // ── Война гильдий (Guild War) ────────────────────────────────────────────────
  // Daily window 22:00-22:15 MSK on its own floor with four crystal towers,
  // one per corner room (Room.spawnGuildWarTowers). A tower changes hands the
  // way the old castle did: whoever lands the killing blow takes it for their
  // clan and it comes back at full health (Room.attackEnemy). The clan that
  // holds ALL FOUR at once for GUILD_WAR_HOLD_MS unbroken wins: it becomes the
  // castle's owner (persisted, paid hourly shards by _gwGrantIncome) and the
  // window ends early. Losing any tower resets that clock. A window that ends
  // with no winner leaves the previous owner in place. Every window starts
  // with all four towers neutral.
  const _gw = {
    phase: 'closed',      // 'closed' → 'live' → ('won' for a few seconds) → 'closed'
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

  function _gwPublicState() {
    return {
      phase: _gw.phase,
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

  // The clan that held all four for the full clock owns the castle from now
  // on — same persistence and hourly income the old castle capture had.
  function _gwVictory(w) {
    const prevOwnerClanName = _gw.ownerClanName;
    _gw.ownerClanId = w.clanId;
    _gw.ownerClanName = w.clanName;
    _gw.ownerClanIcon = w.clanIcon;
    _gw.capturedAt = Date.now();
    saveCastle({
      ownerClanId: _gw.ownerClanId, ownerClanName: _gw.ownerClanName,
      ownerClanIcon: _gw.ownerClanIcon, capturedAt: _gw.capturedAt,
    }).catch(err => console.error('[guildwar] persist failed', err));
    _gw.phase = 'won';
    clearTimeout(_gw.closeTimer);
    _gw.closeTimer = safeTimeout('gwClose', _gwCloseWindow, GW_VICTORY_LINGER_MS);
    io.emit('guildWarVictory', { clanName: w.clanName, clanIcon: w.clanIcon, prevOwnerClanName });
    io.emit('chatMsg', {
      username: 'СОБЫТИЕ',
      text: `🏆 Клан «${w.clanName}» удержал все 4 вышки и победил в Войне гильдий!`,
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
  function _gwCloseWindow() {
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

  // Same $inc-then-$push pattern already inlined a few times elsewhere for
  // clan storage credit (e.g. the deposit/allocation-return handlers further
  // down) — factored out here since the income job needs it and there was no
  // shared top-level version yet.

  // Pushes a fresh clanStorage payload to every online member — top-level twin
  // of the per-connection pushClanStorage (handlers2/social.js), needed
  // because there is no socket in scope inside the income job.
  //
  // ── «хранилище клана закрыто», хотя оно открыто ────────────────────────────
  // Здесь стояла своя, урезанная копия пакета: { storageUnlocked, storage }.
  // Клиент (_clanStorageHTML, js/clans.js) читает поле `unlocked`, а не
  // `storageUnlocked`, и заменяет пакетом ВСЁ состояние хранилища. Раз в час,
  // когда клан-владелец замка получал осколки, у каждого его участника в сети
  // вкладка показывала «закрыто» (а заодно теряла canUse, isLeader и раздачи)
  // — до следующей синхронизации. Теперь каждому уходит тот же полный вид,
  // что и по clanStorageSync: одна форма пакета на всю игру.
  async function _gwStoragePushToClan(clan) {
    for (const m of clan.members) {
      const target = _socketForTelegramId(m.telegramId);
      if (!target || m.playerId == null) continue;
      const view = await clanStorageViewFor(clan._id, m.playerId).catch(() => null);
      if (view) target.emit('clanStorage', view);
    }
  }

  // A random total of GUILD_WAR_SHARD_MIN..MAX shard units, each an
  // independent uniform-random pick across UNIQUE_SHARDS' kinds — reads as
  // "assorted" without any rarity weighting, which nothing in the brief asked
  // for. Pure function, easy to sanity-check in isolation (see plan's
  // verification section).
  function _rollGuildWarIncome() {
    const total = GUILD_WAR_SHARD_MIN + Math.floor(Math.random() * (GUILD_WAR_SHARD_MAX - GUILD_WAR_SHARD_MIN + 1));
    const counts = new Map();
    for (let i = 0; i < total; i++) {
      const sh = UNIQUE_SHARDS[Math.floor(Math.random() * UNIQUE_SHARDS.length)];
      counts.set(sh.id, (counts.get(sh.id) || 0) + 1);
    }
    return [...counts.entries()].map(([id, qty]) => ({ id, qty }));
  }

  // The first sub-daily recurring job in this codebase — every other scheduled
  // event is a daily (or less frequent) nextEventStartAt chain. Aligns to the
  // next wall-clock hour boundary (not "boot + 1h") so a mid-hour redeploy
  // doesn't reset the cadence, and re-reads the owning clan fresh from Mongo
  // on every fire (never trusts the cached name/icon) since it may have been
  // renamed, or disbanded (handled by the clanDisband hook releasing
  // _gw.ownerClanId) since the last grant. No retroactive back-pay for a
  // missed hour during downtime — it's simply skipped, matching how nothing
  // else in this codebase back-pays offline time.
  async function _gwGrantIncome() {
    if (!_gw.ownerClanId) return;
    // A clan that no longer exists loses the castle rather than holding it
    // forever: the income would otherwise be paid into nothing every hour.
    const clan = await clanForStorage(_gw.ownerClanId).catch(() => null);
    if (!clan) { _gw.ownerClanId = null; _gw.ownerClanName = null; _gw.ownerClanIcon = null; return; }
    for (const { id, qty } of _rollGuildWarIncome()) {
      await grantClanStorage(_gw.ownerClanId, id, qty);
    }
    const fresh = await clanForStorage(_gw.ownerClanId).catch(() => null);
    if (fresh) await _gwStoragePushToClan(fresh);
  }

  function _gwIncomeSafe() {
    _gwGrantIncome().catch(err => console.error('_gwGrantIncome:', err));
    _gw.incomeTimer = safeTimeout('gwIncome', _gwIncomeSafe, GUILD_WAR_INCOME_INTERVAL_MS);
  }

  function _gwIncomeSchedule() {
    clearTimeout(_gw.incomeTimer);
    const now = Date.now();
    const nextHour = Math.ceil(now / GUILD_WAR_INCOME_INTERVAL_MS) * GUILD_WAR_INCOME_INTERVAL_MS;
    _gw.incomeTimer = safeTimeout('gwIncome', _gwIncomeSafe, nextHour - now);
  }

  // Restores the castle's owner at boot. Without it a restart hands the
  // castle back to nobody and the next window starts from an empty tower —
  // which is a week of a clan's work undone by a deploy.
  async function _gwRestore() {
    const st = await loadCastle().catch(() => null);
    if (!st) return;
    _gw.ownerClanId = st.ownerClanId || null;
    _gw.ownerClanName = st.ownerClanName || null;
    _gw.ownerClanIcon = st.ownerClanIcon || null;
    _gw.capturedAt = st.capturedAt || 0;
  }

  return {
    _gw, _gwNextOpenAt, _gwPublicState, _gwSchedule, _gwOpenWindow, _gwCloseWindow,
    _gwApplyCapture, _gwHoldDone, _gwIncomeSchedule, _gwRestore,
  };
};
