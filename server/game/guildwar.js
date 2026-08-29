'use strict';
// Guild War (Война гильдий) — tower ownership, combat window, and hourly
// income — moved out of server/index.js verbatim as a factory
// (createGuildWar(deps)), same pattern as arena3.js/death-battle.js.
const {
  GUILD_WAR_DAYS_MSK, GUILD_WAR_HOURS_MSK, GUILD_WAR_WINDOW_MS, GUILD_WAR_TOWER_HP,
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
    loadCastle, saveCastle, grantClanStorage, clanForStorage,
  } = deps;

  // ── Война гильдий (Guild War) ────────────────────────────────────────────────
  // One sealed zone, open daily 22:00-22:15 MSK, containing one stationary
  // tower (Room.spawnGuildWarTower). Whichever clan lands the killing blow
  // owns it — Room.attackEnemy/skillAttackEnemy reset its hp to maxHp in
  // place and reassign ownership the instant it happens (see result.captured,
  // handled below by _gwApplyCapture). Ownership itself has no schedule: it
  // persists across the closed 22:15-22:00 gap and pays out passive income
  // every hour, 24/7 (_gwGrantIncome), independent of whether the zone is
  // currently open for combat — only combat access follows the window.
  const _gw = {
    phase: 'closed',      // 'closed' → 'live' (22:00-22:15 MSK) → 'closed'
    ownerClanId: null, ownerClanName: null, ownerClanIcon: null, capturedAt: 0,
    openTimer: null, closeTimer: null, notifyTimer: null, incomeTimer: null,
  };

  function _gwNextOpenAt(from = Date.now()) {
    return nextEventStartAt(GUILD_WAR_DAYS_MSK, GUILD_WAR_HOURS_MSK, from);
  }

  function _gwPublicState() {
    return {
      phase: _gw.phase,
      nextAt: _gwNextOpenAt(),
      ownerClanId: _gw.ownerClanId, ownerClanName: _gw.ownerClanName, ownerClanIcon: _gw.ownerClanIcon,
      capturedAt: _gw.capturedAt,
      towerHp: GUILD_WAR_TOWER_HP,
    };
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
    clearTimeout(_gw.closeTimer);
    for (const [sid, floor] of playerFloorMap) {
      if (floor !== FLOOR_IDS.guildWar) continue;
      io.sockets.sockets.get(sid)?.data?._forceEnterLocation?.('hub');
    }
    io.emit('guildWarState', _gwPublicState());
    _gwSchedule();
  }

  // Applies a capture result from Room.attackEnemy/skillAttackEnemy
  // (result.captured) — updates the in-memory owner, persists it, and tells
  // everyone. Module-level (not per-connection) since result is self-contained
  // and the hourly income job (below) needs the same _gw.ownerClanId it writes.
  function _gwApplyCapture(result) {
    _gw.ownerClanId = result.newOwnerClanId;
    _gw.ownerClanName = result.newOwnerClanName;
    _gw.ownerClanIcon = result.newOwnerClanIcon;
    _gw.capturedAt = Date.now();
    saveCastle({
      ownerClanId: _gw.ownerClanId, ownerClanName: _gw.ownerClanName,
      ownerClanIcon: _gw.ownerClanIcon, capturedAt: _gw.capturedAt,
    }).catch(err => console.error('[guildwar] persist failed', err));
    io.emit('guildWarCaptured', {
      newOwnerClanName: result.newOwnerClanName, newOwnerClanIcon: result.newOwnerClanIcon,
      prevOwnerClanName: result.prevOwnerClanName,
    });
    io.emit('guildWarState', _gwPublicState());
  }

  // shardName/shardImg used to only exist inside io.on('connection', ...) (see
  // the per-connection clan-storage handlers further down) — moved to module
  // scope (unchanged) so the hourly income job below, which runs from a
  // top-level setTimeout chain with no socket in scope, can reach them too.
  const _gwShardName = id => (UNIQUE_SHARDS.find(s => s.id === id) || {}).name || id;
  const _gwShardImg  = id => (UNIQUE_SHARDS.find(s => s.id === id) || {}).img || null;

  // Same $inc-then-$push pattern already inlined a few times elsewhere for
  // clan storage credit (e.g. the deposit/allocation-return handlers further
  // down) — factored out here since the income job needs it and there was no
  // shared top-level version yet.

  // Pushes a fresh clanStorage payload to every online member — top-level twin
  // of the per-connection _clanStoragePush, needed for the same reason
  // shardName/shardImg were moved up: no socket in scope inside the income job.
  function _gwStoragePushToClan(clan) {
    clan.members.forEach(m => {
      const target = _socketForTelegramId(m.telegramId);
      if (!target) return;
      target.emit('clanStorage', {
        storageUnlocked: !!clan.storageUnlocked,
        storage: (clan.storage || []).filter(e => e && e.qty > 0)
          .map(e => ({ id: e.id, name: _gwShardName(e.id), img: _gwShardImg(e.id), qty: e.qty })),
      });
    });
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
    if (fresh) _gwStoragePushToClan(fresh);
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
    _gwApplyCapture, _gwIncomeSchedule, _gwRestore,
  };
};
