'use strict';
// Кровавая Башня (Bloody Tower corridor race), moved out of server/index.js
// verbatim as a factory (createRace10(deps)), same pattern as the other
// game-mode managers. _race10Frozen and _race10Eliminate are also called
// from index.js's own cross-mode glue (_pvpFrozen/_pvpEliminate) and from
// _reclaimQueues/_rekeyQueue, which stay in index.js since they reach into
// more than one manager's state.
const {
  RACE10_DAYS_MSK, RACE10_HOURS_MSK, RACE10_LIBERTY, RACE10_LIBERTY_WINNER,
  EVENT_NOTIFY_BEFORE_MS, nextEventStartAt,
} = require('../../shared/definitions');
const { FLOOR_IDS } = require('../game/floors');
// Временная диагностика деплоя — см. её использование ниже, у [DIAG-RACE10].
const playerlog = require('../db/repos/playerlog');
const { idByTelegram } = require('../db/repos/players');

module.exports = function createRace10(deps) {
  const {
    io, getRoom, logPlayer, _recordPvpHistory, _returnToHub, _findPlayerAnyFloor, _socketTid,
    notifyEventSoon, broadcastLeadMs, notifyEventStarted, safeTimeout,
    _race10AttemptsLeft, _lockRace10Daily,
  } = deps;

  // ── Кровавая Башня (corridor race) ──────────────────────────────────────────
  // Registration opens at 20:30 MSK and everyone who signs up runs — no fixed
  // headcount. RACE10_REG_MS later the whole field starts at once, one sealed
  // lane each (server/game/dungeon.js race10): 60 level-5 monsters then 60
  // level-10, packed shoulder to shoulder, no way past but through. Every lane
  // ends at the same shared room and the same single boss (spawnRaceBoss,
  // server/game/Room.js): whoever has dealt it the most cumulative damage when
  // it dies wins Liberty. Dying anywhere in a lane is an elimination — handled
  // by the existing 'respawn' handler via _pvpEliminate, the same wiring the
  // death battle and 3v3 arena already share, so a monster kill in the corridor
  // counts exactly like a PvP kill would.
  //
  // It used to fire the moment ten players were queued, and could run several
  // times in the hour. One start with everyone in it replaces that, which is
  // also what makes a single daily attempt fair: miss the five minutes and you
  // miss the day, rather than losing your one attempt to a race that filled up
  // without you.
  //
  // How many can enter is a property of the map, not of this file: lanes are
  // carved at world generation and never change, so the ceiling is however many
  // exist (read below from the dungeon, not hardcoded here).
  const RACE10_MIN_PLAYERS = 2;            // a race of one has nobody to race
  const RACE10_REG_MS    = 5 * 60 * 1000;  // registration window before the start
  const RACE10_ATTEMPTS  = 1;              // per UTC day — its own limit, not the shared dungeon pool
  const RACE10_MIN_LEVEL = 10;
  const RACE10_FREEZE_MS = 10 * 1000;
  // Liberty (Nexum) and potions, from shared/definitions.js so the client's
  // events panel advertises exactly what the server pays. Two tiers: every
  // entrant who landed at least one hit ON THE BOSS takes RACE10_LIBERTY plus
  // one of each buff potion, and the top damage-dealer takes
  // RACE10_LIBERTY_WINNER plus two of each instead. Corridor kills do not
  // qualify anybody — only damage to the shared boss is tallied
  // (_race10TrackHit), so the corridors still have to be run to be paid.
  const RACE10_REWARD    = RACE10_LIBERTY;
  // Operational guard only, same idea as the 3v3 arena's old wedge — ends the
  // race with no winner if the boss just never comes down, so the one shared
  // instance can't be tied up forever.
  const RACE10_MAX_MS    = 15 * 60 * 1000;
  // ── «жалуются... вылет из игры» ─────────────────────────────────────────
  // Every OTHER competitive mode (arena3, the death battle) eliminating on
  // disconnect with no grace is fine — those are short. This one runs up to
  // RACE10_MAX_MS, so a tunnel blip (Wi-Fi/LTE handover, a backgrounded
  // WebView) that would be nothing anywhere else cost the whole day's one
  // attempt here, with no way back in: race10Eliminated fired the instant
  // socket.io noticed, before the client even had a chance to reconnect.
  // Kept equal to Fear's own FEAR_RECONNECT_GRACE_MS (server/game/fear.js) —
  // same client-side watchdog, same reconnect cost, no reason for a
  // different number.
  const RACE10_RECONNECT_GRACE_MS = 45000;

  // The map's lane count — the hard ceiling on entrants. Read once the world
  // exists; before that (nobody can register yet) it reports 0.
  // How many entrants the Tower can actually take. Usable corridors, not the
  // raw lane count: an entry point that is not standable is not a slot anyone
  // can be given, and advertising it would promise a place that deploy would
  // then have to refuse.
  function _race10Capacity() {
    const room = getRoom(FLOOR_IDS.race10);
    return room ? room.raceUsableLanes().length : 0;
  }

  const _race10 = {
    phase: 'idle',        // 'idle' → 'reg' (20:30 MSK, RACE10_REG_MS window) → 'idle'
    queue: new Map(),    // socketId -> { name, lvl }
    live: false,
    starting: false,     // guards the async attempt re-check inside _race10TryStart
    alive: new Map(),    // socketId -> { name, lane } — still in a lane or the boss room
    names: new Map(),    // socketId -> name, kept for the result screen after elimination
    dmg: new Map(),      // socketId -> cumulative damage dealt to the shared boss
    bossId: null,
    fightAt: 0,
    startAt: 0,          // when the field is deployed — registration closes then
    freezeTimer: null,
    maxTimer: null,
    startTimer: null,
    sweepTimer: null,
    openTimer: null, notifyTimer: null,
  };

  // Как часто идёт страховочный проход по забегу (_race10Sweep).
  const RACE10_SWEEP_MS = 2000;

  // telegramId -> { socketId, timer } — one racer's disconnect held open for
  // a possible reconnect. See _race10HoldOnDisconnect/_race10ClaimOnReconnect
  // below; mirrors Fear's own _fearDisconnectGrace (server/game/fear.js).
  const _race10Grace = new Map();

  // Next scheduled window open, in UTC ms — every day, 20:30 Moscow. Lives in
  // shared/definitions.js (RACE10_DAYS_MSK/HOURS_MSK) so it's computed the
  // same way the death battle's and world boss's own schedules are.
  function _race10NextOpenAt(from = Date.now()) {
    return nextEventStartAt(RACE10_DAYS_MSK, RACE10_HOURS_MSK, from);
  }

  function _race10PublicState() {
    return {
      phase:   _race10.phase,
      nextAt:  _race10NextOpenAt(),
      queued: _race10.queue.size,
      // No headcount to reach any more; the client shows the queue size and
      // counts down to startAt instead. `capacity` is the lane ceiling.
      startAt: _race10.startAt,
      capacity: _race10Capacity(),
      minPlayers: RACE10_MIN_PLAYERS,
      live: _race10.live,
      minLevel: RACE10_MIN_LEVEL,
      // Both tiers, so the panel advertises exactly what gets paid rather than
      // only the winner's line: `reward` is what every entrant who lands a hit
      // on the boss takes, `winReward` what the top damage-dealer takes instead.
      reward: RACE10_REWARD,
      winReward: RACE10_LIBERTY_WINNER,
      maxAttempts: RACE10_ATTEMPTS,
    };
  }

  function _race10Broadcast() {
    const st = _race10PublicState();
    // Same reasoning as _a3Broadcast above — the queue size is only interesting
    // to someone who has NOT signed up yet, and they were the one group never
    // told when it changed.
    io.emit('race10State', st);
    _race10.queue.forEach((_, sid) => io.to(sid).emit('race10State', { ...st, registered: true }));
  }

  // Arms the next daily window (20:30 MSK) plus its 30-minute warning. Called
  // at boot and after every window closes; if the process starts inside the
  // window itself the open-timeout is already due and fires immediately with
  // whatever time is left, same as _dbSchedule.
  function _race10Schedule() {
    clearTimeout(_race10.openTimer);
    clearTimeout(_race10.notifyTimer);
    _race10.phase = 'idle';
    const openAt = _race10NextOpenAt();
    _race10.openTimer = safeTimeout('race10Open', () => _race10OpenWindow(openAt), Math.max(0, openAt - Date.now()));
    // Сдвиг на длительность самого прохода. Telegram принимает около тридцати
    // сообщений в секунду, и четыре тысячи адресатов — это больше двух минут:
    // предупреждение «за 30 минут», отправленное ровно за тридцать, доходило до
    // конца очереди за двадцать восемь. Начинаем раньше на столько, сколько
    // проход занимает, — и последний получает свои тридцать.
    const warnIn = openAt - EVENT_NOTIFY_BEFORE_MS - broadcastLeadMs() - Date.now();
    if (warnIn > 0) _race10.notifyTimer = safeTimeout('race10Notify', () => notifyEventSoon('race10', openAt), warnIn);
  }

  // Opens registration at 20:30 MSK and arms the single start RACE10_REG_MS
  // later. Everyone signed up by then runs; there is no headcount to reach and
  // no second race in the same window, so the five minutes are the whole of the
  // opportunity — which is what the 30-minute warning broadcast is for. The
  // window closes itself the moment that single start attempt is processed
  // (_race10Start below calls _race10CloseWindow once it's done, win or no
  // players) — there's nothing left to wait around for after that.
  // regMs is only ever passed by the local dev opener (see the DEV_LOCAL block
  // near the top of this file) so the event can be exercised without waiting for
  // 20:30; the scheduled path always uses RACE10_REG_MS.
  function _race10OpenWindow(openAt, regMs = RACE10_REG_MS) {
    _race10.phase = 'reg';
    _race10.startAt = Date.now() + regMs;
    notifyEventStarted('race10', openAt);
    clearTimeout(_race10.startTimer);
    _race10.startTimer = safeTimeout('race10Start', _race10StartSafe, regMs);
    _race10Broadcast();
  }

  // Closes registration early — either RACE10_REG_MS after opening, once
  // _race10Start has processed the day's one attempt (silent: true, since
  // anyone still queued by then already got a more specific message about why),
  // or from an admin's manual "close now" (server-authoritative, no silent
  // flag — those callers want the generic notice). Either way there is no
  // second start left in this window, so this always re-arms tomorrow's.
  function _race10CloseWindow(opts = {}) {
    _race10.phase = 'idle';
    _race10.startAt = 0;
    clearTimeout(_race10.startTimer);
    if (!opts.silent) {
      [..._race10.queue.keys()].forEach(sid => {
        io.to(sid).emit('race10Registered', { registered: false });
        io.to(sid).emit('race10Error', { msg: 'Окно Кровавой Башни закрылось — до встречи в 20:30' });
      });
    }
    _race10.queue.clear();
    _race10Schedule();
    _race10Broadcast();
  }

  function _race10Frozen(socketId) {
    return _race10.live && Date.now() < _race10.fightAt && _race10.alive.has(socketId);
  }

  // The scheduled start fires once per window; async because it re-checks daily
  // attempts against the DB, and never awaited by its caller (a timer), so the
  // rejection has to be caught here.
  function _race10StartSafe() { _race10Start().catch(err => console.error('_race10Start:', err)); }

  async function _race10Start() {
    if (_race10.live || _race10.starting) return;
    _race10.startAt = 0;
    const room = getRoom(FLOOR_IDS.race10);
    if (!room) { _race10CloseWindow({ silent: true }); return; }
    // Only entrants still connected and still standing in the world can be
    // deployed; anyone else is dropped rather than counted. Registration never
    // required being on any particular floor, so this checks wherever each one
    // actually is, not just the hub.
    //
    // «жалуются... не забирает на событие»: this used to drop a registered
    // entrant with zero notice whenever the socket was connected but
    // _findPlayerAnyFloor came back empty for a moment (mid floor-change,
    // char-select, a reconnect that hadn't re-joined a room yet right at
    // 20:30:00) — every OTHER rejection path in this file (capacity,
    // out-of-attempts, force-enter failure) tells the client exactly why;
    // this was the one silent exception, and from that client's own screen
    // it read as "registered, then nothing happened."
    const ready = [..._race10.queue.keys()].filter(sid =>
      io.sockets.sockets.get(sid) && _findPlayerAnyFloor(sid));
    [..._race10.queue.keys()].forEach(sid => {
      if (ready.includes(sid)) return;
      _race10.queue.delete(sid);
      if (io.sockets.sockets.get(sid)) {
        io.to(sid).emit('race10Registered', { registered: false });
        io.to(sid).emit('race10Error', { msg: 'Не удалось войти в забег — попробуйте зарегистрироваться на следующий' });
      }
    });
    if (ready.length < RACE10_MIN_PLAYERS) {
      // Not enough showed up. Nobody is charged an attempt (that happens on
      // deploy) — there is no second start, so this is "not today" and
      // registration closes right along with it (silent: already told these
      // exact sockets why, above).
      ready.forEach(sid => io.to(sid).emit('race10Error', {
        msg: `Забег отменён — нужно минимум ${RACE10_MIN_PLAYERS} участника`,
      }));
      _race10CloseWindow({ silent: true });
      return;
    }

    _race10.starting = true;
    try {
      await _race10Deploy(ready, room);
    } catch (err) {
      // _race10.live встаёт в середине деплоя, до раздачи коридоров. Если
      // оттуда что-то бросит, башня остаётся «идущей» без единого участника и
      // без таймеров — а следующий старт отобьётся первой же строкой этой
      // функции (`if (_race10.live ...) return`). То есть событие не
      // запустится больше НИКОГДА, до перезапуска процесса. Откатываем.
      console.error('_race10Deploy:', err);
      if (!_race10.alive.size) _race10Rollback();
    } finally {
      _race10.starting = false;
      // One start per window, successful or not — close registration the
      // moment it's been attempted (queue is already drained by _race10Deploy
      // either way, so this is just phase/reschedule bookkeeping by now).
      _race10CloseWindow();
    }
  }

  // Снимает признаки идущего забега, не трогая участников — общий хвост для
  // отката сорвавшегося деплоя и для нормального финиша.
  function _race10Rollback() {
    _race10.live = false;
    _race10.fightAt = 0;
    clearTimeout(_race10.freezeTimer);
    clearTimeout(_race10.maxTimer);
    clearInterval(_race10.sweepTimer);
    _race10.sweepTimer = null;
  }

  async function _race10Deploy(ready, room) {
    // Everyone who registered, capped only by how many corridors the map has.
    // Anyone past that is told plainly rather than being silently dropped into
    // somebody else's lane.
    const capacity = room.raceUsableLanes().length;
    const picked = ready.slice(0, capacity);
    ready.slice(capacity).forEach(sid => {
      _race10.queue.delete(sid);
      io.to(sid).emit('race10Registered', { registered: false });
      io.to(sid).emit('race10Error', { msg: `В Башне только ${capacity} коридоров — сегодня не хватило места` });
    });

    // Re-checked against fresh DB state right before launch, not just at
    // sign-up — same reasoning as the 3v3 arena's own re-check.
    const spent = await Promise.all(picked.map(sid => _race10AttemptsLeft(sid)));
    const outOfAttempts = picked.filter((sid, i) => spent[i] <= 0);
    // Anyone who used their attempt elsewhere since signing up is dropped, and
    // the race goes ahead with the rest — there is only one start per window, so
    // retrying the whole launch (as the queue-driven version did) would just
    // cancel the event for everybody.
    const running = picked.filter((sid, i) => spent[i] > 0);
    outOfAttempts.forEach(sid => {
      _race10.queue.delete(sid);
      io.to(sid).emit('race10Error', { msg: 'Попытки в Кровавую Башню на сегодня закончились' });
      io.to(sid).emit('race10Registered', { registered: false });
    });
    if (running.length < RACE10_MIN_PLAYERS) {
      running.forEach(sid => io.to(sid).emit('race10Error', {
        msg: `Забег отменён — нужно минимум ${RACE10_MIN_PLAYERS} участника`,
      }));
      _race10Broadcast();
      return;
    }

    _race10.live = true;
    _race10.alive.clear(); _race10.names.clear(); _race10.dmg.clear();
    _race10.fightAt = Date.now() + RACE10_FREEZE_MS;

    // Every lane's monsters have to be back at full strength before this race
    // starts — they don't respawn on their own (see Room.js's tick loop), so a
    // second race later in the same window would otherwise find them still
    // dead from the first one.
    room.resetRaceMonsters();
    // raceDeploy below needs everyone already present in room.players to
    // assign lanes — force each entrant's own connection onto the race10
    // floor first (bypassing any gate: this is a scheduled deploy, not a
    // walk-in, and there is none to bypass anyway — see _doEnterLocation).
    //
    // Each one is joined AT the lane it is about to be given, rather than at the
    // floor's default spawn. That default is the middle of the shared boss room
    // (generateRace10), and joining lands a player there for the short moment
    // between the join and raceDeploy below — which would be invisible, except
    // that the join is also what builds gameStart, so gameStart went out saying
    // "you are at the boss". The client applies gameStart's position, and on a
    // first visit to this floor it applies it LATE: the handler defers behind
    // the world-map HTTP fetch (see socket.on('gameStart'), js/network.js),
    // while race10Started — sent moments later with the real lane — arrives and
    // is applied immediately. So the correct placement landed first and the
    // stale one overwrote it, and every entrant's first race of a session
    // started them standing on the boss instead of in their corridor.
    //
    // lanes[joined.length] is the exact lane raceDeploy is about to assign: it
    // hands out lanes by position in the array it receives, and this pushes in
    // the same order. Anyone who fails to join simply is not pushed, so the two
    // stay in step.
    // raceUsableLanes() rather than the raw lane list: a corridor whose entry
    // point is not standable is not a corridor anyone can be given, and it now
    // reduces capacity instead of silently dumping its occupant on the boss.
    // Same list raceDeploy walks, in the same order, so slot n here is the
    // corridor raceDeploy is about to assign as lane n.
    const _laneSpots = room.raceUsableLanes();
    const joined = [];
    running.forEach(sid => {
      if (joined.length >= _laneSpots.length) return;
      const ok = io.sockets.sockets.get(sid)?.data?._forceEnterLocation?.('race10', { pos: _laneSpots[joined.length] });
      if (ok) { joined.push(sid); return; }
      // "не закидывает на дорожку" — a socket that looked ready a moment ago
      // (the aOk/bOk-style check at the top of _race10Start) but then failed
      // to actually land on the floor used to just sit in _race10.queue
      // forever: never deployed, never told why, still reading
      // registered:true on its own screen for a race that had already
      // started without it.
      _race10.queue.delete(sid);
      io.to(sid).emit('race10Registered', { registered: false });
      io.to(sid).emit('race10Error', { msg: 'Не удалось войти в забег — попробуйте зарегистрироваться на следующий' });
    });
    const placed = room.raceDeploy(joined);
    _race10.bossId = room.spawnRaceBoss();
    // ── ВРЕМЕННАЯ ДИАГНОСТИКА: «жалуются, что двое оказались на одной дорожке» ──
    // Один снимок фактически назначенных дорожек и координат сразу после
    // raceDeploy, на каждый забег. Ищите по тегу [DIAG-RACE10] в логах
    // процесса (journalctl/pm2, смотря чем запущен). Убрать после того, как
    // разберёмся — постоянно эта строка не нужна.
    console.log('[DIAG-RACE10] deploy', JSON.stringify(
      placed.map(p => ({ sid: p.socketId, lane: p.lane, x: p.x, y: p.y }))
    ));
    // Тот же снимок, но в player_logs — доступно через SQL, а не только
    // grep по логам процесса. Best-effort и не блокирует деплой: ошибка
    // резолва id или записи тут не должна портить сам забег.
    Promise.all(placed.map(async ({ socketId, lane, x, y }) => {
      const tid = _socketTid(socketId);
      if (!tid) return;
      const pid = await idByTelegram(null, tid);
      if (pid) playerlog.log(pid, 'diag_race10_deploy', { lane, x, y, socketId });
    })).catch(err => console.error('[DIAG-RACE10] db log failed:', err.message));

    // ── попытка списывается ДО старта, и её ответ теперь читают ─────────────
    // _lockRace10Daily — это takeAttempt (server/modes.js), условный UPDATE
    // «...WHERE used < cap». Он возвращает false и когда попытки кончились, и
    // когда база не ответила, — а звали его без await, ответ выбрасывали.
    // Проверку _race10AttemptsLeft выше отделяет от него минимум один await,
    // то есть ровно тот зазор, ради которого она и написана, не закрывался
    // ничем: гонка с другой сессией или блип базы = бесплатный забег, молча.
    // Кто не оплачен — тот не бежит.
    const charged = await Promise.all(placed.map(p => _lockRace10Daily(p.socketId)));
    const paid = placed.filter((_, i) => charged[i]);
    placed.filter((_, i) => !charged[i]).forEach(({ socketId }) => {
      _race10.queue.delete(socketId);
      _returnToHub(socketId);
      io.to(socketId).emit('race10Registered', { registered: false });
      io.to(socketId).emit('race10Error', { msg: 'Не удалось списать попытку — забег не начат' });
    });
    if (!paid.length) {
      _race10Rollback();
      _race10Broadcast();
      return;
    }

    paid.forEach(({ socketId, lane }) => {
      const name = _race10.queue.get(socketId)?.name || '?';
      // atBoss: false — flips once in _race10ReachBoss, the instant this
      // lane's monsters are all dead. Guards against teleporting the same
      // racer twice if raceLaneClear somehow gets checked again afterward.
      _race10.alive.set(socketId, { name, lane, atBoss: false });
      _race10.names.set(socketId, name);
      _race10.dmg.set(socketId, 0);
      _race10.queue.delete(socketId);
    });

    const roster = paid.map(p => ({ id: p.socketId, name: _race10.names.get(p.socketId), lane: p.lane }));
    paid.forEach(({ socketId, x, y, hp, lane }) => {
      io.to(socketId).emit('race10Started', { x, y, hp, lane, fightAt: _race10.fightAt, roster });
      logPlayer(_socketTid(socketId), _race10.names.get(socketId), 'race10_start', { lane });
    });

    clearTimeout(_race10.freezeTimer);
    _race10.freezeTimer = safeTimeout('race10Freeze', () => {
      if (!_race10.live) return;
      _race10.alive.forEach((_, sid) => io.to(sid).emit('race10Fight'));
    }, RACE10_FREEZE_MS);

    clearTimeout(_race10.maxTimer);
    _race10.maxTimer = safeTimeout('race10Max', () => _race10Finish(null, true), RACE10_FREEZE_MS + RACE10_MAX_MS);

    // Страховка, идущая всё время забега — см. _race10Sweep.
    clearInterval(_race10.sweepTimer);
    _race10.sweepTimer = setInterval(() => {
      // Тот же довод, что у safeTimeout: колбэк таймера выполняется на пустом
      // стеке, и throw отсюда дошёл бы до uncaughtException, то есть уронил бы
      // весь сервер ради одной дорожки.
      try { _race10Sweep(); } catch (err) { console.error('[race10 sweep]', err); }
    }, RACE10_SWEEP_MS);
    if (_race10.sweepTimer.unref) _race10.sweepTimer.unref();
    _race10Broadcast();
  }

  // ── страховка от «стою в пустом тупике» ────────────────────────────────────
  // Коридоров пятьдесят, а комната босса — квадрат в 22 тайла по центру карты
  // (generateRace10, server/game/dungeon.js): к ней примыкают только четыре
  // средних коридора, остальные сорок шесть упираются в стену. Единственный
  // вход туда — _race10ReachBoss, и зовут его ровно из одного места:
  // _onCombatResult, по убийству, закрывшему дорожку (server/modes.js). Любой
  // забег, где это последнее убийство случилось НЕ у самого игрока — дорожка
  // была пуста с самого начала, добил кто-то другой, событие потерялось —
  // оставлял человека в тупике на все пятнадцать минут: ни монстров, ни
  // босса, ни награды (она требует урона по боссу).
  //
  // Здесь же чинится и вторая половина той же жалобы. Видимость ВСЕГО в этом
  // режиме висит на p._raceLane (Room._raceVisible) — и коридорных монстров, и
  // безлейнового босса. Запись игрока, пересозданная без него (реконнект,
  // любой forceFloor на этот этаж мимо raceDeploy), означает «монстров нет,
  // босса нет»; клиентские барьеры при этом считаются по ПРИСЛАННОМУ списку
  // врагов (_raceLaneTierAlive, js/game.js) и на пустом списке просто
  // открываются, пропуская игрока к тому самому тупику. Раз в
  // RACE10_SWEEP_MS сверяем запись комнаты с тем, что забег о человеке знает.
  function _race10Sweep() {
    if (!_race10.live) return;
    const room = getRoom(FLOOR_IDS.race10);
    if (!room) return;
    const laneHasMonsters = room.raceLanesAlive();
    _race10.alive.forEach((run, sid) => {
      const p = room.players.get(sid);
      // Записи нет — либо человек держится по грейсу реконнекта
      // (_race10HoldOnDisconnect), либо уже уходит с этажа. У обоих случаев
      // свой путь, отсюда трогать нечего.
      if (!p) return;
      if (p._raceLane !== run.lane) { p._raceLane = run.lane; p._profileRev++; }
      if (!run.atBoss && !laneHasMonsters.has(run.lane)) _race10ReachBoss(sid, run.lane);
    });
  }

  // Teleports one racer into the shared boss room the instant their own lane
  // is fully cleared — called from modes._onCombatResult on the kill that
  // could be the lane's last one (see Room.raceLaneClear). Replaces walking
  // an empty corridor stretch into a room sized to span every lane's row;
  // see generateRace10's own comment for why that room used to be enormous.
  // The atBoss guard makes this idempotent: nothing should call it twice for
  // the same racer, but if it ever did, this must not re-teleport someone
  // already standing at the boss to a fresh ring spot.
  function _race10ReachBoss(socketId, lane) {
    if (!_race10.live) return;
    const run = _race10.alive.get(socketId);
    if (!run || run.atBoss) return;
    const room = getRoom(FLOOR_IDS.race10);
    if (!room) return;
    const spot = room.raceMoveToBoss(socketId, lane);
    if (!spot) return;
    run.atBoss = true;
    io.to(socketId).emit('race10ReachedBoss', spot);
  }

  // Knocks one player out — dying anywhere in a lane, to anything. Safe to
  // call for anyone not in the race (a normal death elsewhere), it returns
  // immediately. Their damage tally survives them: "most damage dealt" doesn't
  // require surviving to the end.
  //
  // This always runs from inside the 'respawn' handler (race10 has no PvP —
  // "dying anywhere" only ever means a monster kill), which unconditionally
  // calls currentRoom.respawnPlayer() right after _pvpEliminate returns. Before
  // the split that alone sent an eliminated racer back to spawn, because
  // this._dungeon.spawn WAS the hub's own — respawnPlayer and race10 shared a
  // Room. Now race10 has its own floor (its own default spawn, the boss room),
  // so this has to do the floor change itself first: _returnToHub updates the
  // connection's own currentRoom/currentFloor, so by the time respawnPlayer
  // runs afterward it's already operating on the hub and just re-applies the
  // same standard full-heal-at-spawn every other death in the game gets.
  function _race10Eliminate(socketId) {
    if (!_race10.live) return false;
    if (!_race10.alive.has(socketId)) return false;
    _race10.alive.delete(socketId);
    _returnToHub(socketId);
    io.to(socketId).emit('race10Eliminated', {});
    // Nobody left standing anywhere and the boss is still up — no one can ever
    // land another hit, so there's no point riding out RACE10_MAX_MS.
    if (_race10.alive.size === 0) _race10Finish(null, false);
    return true;
  }

  // Ушёл из забега сам — камнем телепорта или переходом в другую локацию
  // (см. modes.leaveInstanceFloor, откуда это и зовётся). До сих пор такого
  // выхода для этого режима не существовало вовсе: человек оказывался в хабе,
  // оставаясь в _race10.alive — то есть блокировал ранний финиш «никого не
  // осталось» и сохранял право на награду, ничего не пробежав.
  //
  // От смерти отличается двумя вещами. Во-первых, счёт урона НЕ переживает
  // уход: смерть в коридоре — часть забега, и «больше всех урона» не требует
  // дожить до конца, а уход по своей воле — это отказ от забега, и платить за
  // него не за что. Во-вторых, никаких перемещений отсюда: функция работает
  // из середины уже идущего перехода между этажами, и второй forceFloor
  // внутри первого сломал бы оба — игрока уносит сам вызывающий.
  function _race10ReleaseRun(socketId) {
    if (!_race10.alive.has(socketId)) return false;
    _race10.alive.delete(socketId);
    _race10.names.delete(socketId);
    _race10.dmg.delete(socketId);
    io.to(socketId).emit('race10Eliminated', {});
    // Та же причина, что и в _race10Eliminate: стоять больше некому, боссу
    // никто уже не нанесёт удара — ждать RACE10_MAX_MS не за чем. Финиш
    // асинхронный (он ждёт выдачу наград), а зовут его отсюда синхронно —
    // без catch отказ базы в награде дошёл бы до uncaughtException.
    if (_race10.live && _race10.alive.size === 0) {
      _race10Finish(null, false).catch(err => console.error('_race10Finish:', err));
    }
    return true;
  }

  // The disconnect-side half of the reconnect grace — called from
  // modes._pvpEliminate INSTEAD OF _race10Eliminate when the socket closing
  // is a disconnect (opts.fearGrace), not a real death. Deliberately does not
  // touch _race10.alive/names/dmg at all: the entry just sits there exactly
  // as it was, which is what lets a reconnect within the window come straight
  // back with its lane, its damage tally and its atBoss flag intact, and
  // what lets _race10Finish still pay out and log this racer normally if the
  // race ends while they're mid-reconnect (the loop there only reads those
  // three maps, never socket.io). Only the disconnect ITSELF is delayed —
  // RACE10_RECONNECT_GRACE_MS later, with no reconnect, it runs the exact
  // elimination this replaced.
  //
  // No telegramId means no account to reconnect against (should be
  // unreachable for a real login) — eliminate for real rather than hold a
  // slot nobody can ever reclaim.
  function _race10HoldOnDisconnect(socketId, telegramId) {
    if (!_race10.live) return false;
    if (!_race10.alive.has(socketId)) return false;
    if (!telegramId) return _race10Eliminate(socketId);
    // Captured NOW, while the room record still exists (this runs from
    // modes._pvpEliminate, called BEFORE the disconnect handler's own
    // room.removePlayer — see server/app.js) — it is gone by the time a
    // reconnect could ask for it otherwise. Already the exact spot to
    // resume at whether this racer was mid-corridor or already at the boss:
    // _race10ReachBoss moves p.x/p.y there the instant it happens, same
    // field this reads.
    const room = getRoom(FLOOR_IDS.race10);
    const p = room && room.players.get(socketId);
    const pos = p ? { x: p.x, y: p.y, hp: p.hp } : null;
    const prior = _race10Grace.get(telegramId);
    if (prior) clearTimeout(prior.timer);
    const timer = safeTimeout('race10Grace', () => {
      _race10Grace.delete(telegramId);
      _race10Eliminate(socketId);
    }, RACE10_RECONNECT_GRACE_MS);
    _race10Grace.set(telegramId, { socketId, pos, timer });
    return true;
  }

  // The other half — called from the login flow (server/handlers2/world.js)
  // once a reconnecting socket is authenticated, before it's placed on any
  // floor. Cancels the pending elimination and rekeys _race10.alive/names/dmg
  // onto the new socket id (same _race10Rekey the same-tick stale-entry path
  // already uses), so every later lookup by the new id — dying again, hitting
  // the boss, the race's own finish — finds this racer exactly as before.
  // Returns { pos } — pos itself may be null on a legitimate hold that
  // couldn't capture a position — or null when there was nothing held at
  // all, which is the caller's "nothing to resume". Wrapped rather than
  // returning pos bare so those two null cases stay distinguishable. The
  // caller still has to move the connection onto the race10 floor itself,
  // which this does not do (it has no socket to move — see
  // _resumeHeldRace10Run).
  function _race10ClaimOnReconnect(telegramId, newSocketId) {
    if (!telegramId) return null;
    const held = _race10Grace.get(telegramId);
    if (!held) return null;
    clearTimeout(held.timer);
    _race10Grace.delete(telegramId);
    _race10Rekey(held.socketId, newSocketId);
    return { pos: held.pos };
  }

  // A network blip (Wi-Fi/LTE handover, a suspended WebView) can reconnect
  // the same account under a NEW socket id while the old one is still
  // sitting around — the exact "a moment longer than its own disconnect
  // cleanup takes to land" case Room.addPlayer's stale-entry cleanup
  // already exists for. Called unconditionally from server/world.js's
  // enterFloor whenever a reconnect's addPlayer reports a stale entry, so
  // it has to cover both places this module keys state by socket id:
  //
  // - Mid-race (_race10.alive/names/dmg): addPlayer's own raceCarry (same
  //   file, Room.js) already carries the departing socket's lane/position/
  //   hp onto the new record, so the reconnect lands back in its own
  //   corridor instead of this floor's default spawn — the shared boss
  //   room, empty of everything but the boss — «жалуются... пустая без
  //   монстров». Placement alone isn't enough, though: without rekeying
  //   these maps too, dying again after reconnecting would silently no-op
  //   (_race10Eliminate looks up a socket id nothing here recognises any
  //   more), and reaching the boss or landing the winning hit wouldn't
  //   credit the right account either.
  // - Still registered, not yet deployed (_race10.queue): a reconnect
  //   during the 5-minute registration window (RACE10_REG_MS) orphans the
  //   entry to a socket id that no longer exists — session.js's own
  //   `registered: !!_race10.queue.has(sid)` then correctly stops claiming
  //   they're registered (nothing shows stale), but the registration
  //   itself is just gone unless they notice and press the button again —
  //   «жалуются... не забирает на событие». Handled the same way: move the
  //   entry across rather than requiring a fresh click.
  function _race10Rekey(oldSocketId, newSocketId) {
    if (oldSocketId === newSocketId) return;
    if (_race10.queue.has(oldSocketId)) {
      _race10.queue.set(newSocketId, _race10.queue.get(oldSocketId));
      _race10.queue.delete(oldSocketId);
    }
    const entry = _race10.alive.get(oldSocketId);
    if (!entry) return;
    _race10.alive.delete(oldSocketId);
    _race10.alive.set(newSocketId, entry);
    if (_race10.names.has(oldSocketId)) {
      _race10.names.set(newSocketId, _race10.names.get(oldSocketId));
      _race10.names.delete(oldSocketId);
    }
    if (_race10.dmg.has(oldSocketId)) {
      _race10.dmg.set(newSocketId, _race10.dmg.get(oldSocketId));
      _race10.dmg.delete(oldSocketId);
    }
    // _race10.bossId is an enemy id, not a socket id — nothing to rekey there.
  }

  async function _race10Finish(winnerId, timedOut) {
    if (!_race10.live) return;
    _race10Rollback();
    const room = getRoom(FLOOR_IDS.race10);
    if (room) room.despawnRaceBoss();
    // ── снимки и очистка ДО расселения, и это обязательный порядок ──────────
    // _returnToHub уводит игрока через forceFloor, а тот зовёт
    // modes.leaveInstanceFloor — то есть _race10ReleaseRun, который честно
    // выбрасывает уходящего из alive/names/dmg. Для финиша это не «ушёл сам»,
    // и платить он мешать не должен: снимаем копии и чистим карты здесь, а по
    // дороге домой Release уже ничего не найдёт и станет no-op. Обратный
    // порядок стоил бы каждому выжившему и награды, и экрана результата.
    const survivors = [..._race10.alive.keys()];
    const names = new Map(_race10.names);
    const dmg = new Map(_race10.dmg);
    const participants = [...names.keys()];
    _race10.alive.clear(); _race10.names.clear(); _race10.dmg.clear(); _race10.bossId = null;
    // Everyone still standing goes home too — the race is over for them as
    // well, they just didn't die to get there. Eliminated racers (already
    // dropped from _race10.alive by _race10Eliminate) stay put where they
    // fell until they close the result modal — see the race10Return handler.
    survivors.forEach(sid => _returnToHub(sid));

    for (const sid of participants) {
      const won = !!winnerId && sid === winnerId;
      const s = io.sockets.sockets.get(sid);
      // Reaching the boss and landing at least one hit on it is what qualifies
      // for a payout — dmg only ever counts damage to the shared boss
      // (_race10TrackHit), never corridor kills. Someone who died in their
      // corridor, or who ran it but never got a swing in, takes nothing; the
      // winner takes the bigger tier of the same reward.
      const hitTheBoss = (dmg.get(sid) || 0) > 0;
      let reward = 0, rewardItems = [];
      if (hitTheBoss && s?.data?._race10GrantReward) {
        const paid = await s.data._race10GrantReward(won);
        if (paid) { reward = paid.nexum; rewardItems = paid.items; }
      }
      io.to(sid).emit('race10Result', {
        won, winnerName: winnerId ? names.get(winnerId) : null,
        myDamage: dmg.get(sid) || 0, timedOut: !!timedOut, reward,
        items: rewardItems.map(i => ({ id: i.id, name: i.name, img: i.img, qty: i.qty })),
      });
      logPlayer(_socketTid(sid), names.get(sid), 'race10_end', {
        result: winnerId ? (won ? 'win' : 'lose') : (timedOut ? 'timeout' : 'no_survivors'),
        dmg: dmg.get(sid) || 0, reward,
      });
      // No player-vs-player damage in this mode (everyone fights the same
      // shared boss/monsters), so only a win/lose result is recorded — never
      // a kill/death. A timeout/no-survivors race records neither.
      if (winnerId) {
        const tid = _socketTid(sid);
        if (tid) _recordPvpHistory(tid, won ? 'win' : 'lose', 'race10', null);
      }
    }
    _race10Broadcast();
    // No follow-up race: the window holds exactly one start (see
    // _race10OpenWindow), so anyone who missed it waits for tomorrow.
  }

  return {
    RACE10_MIN_PLAYERS, RACE10_REG_MS, RACE10_ATTEMPTS, RACE10_MIN_LEVEL, RACE10_FREEZE_MS,
    RACE10_REWARD, RACE10_MAX_MS, RACE10_RECONNECT_GRACE_MS,
    _race10, _race10Capacity, _race10NextOpenAt, _race10PublicState, _race10Broadcast, _race10Schedule,
    _race10OpenWindow, _race10CloseWindow, _race10Frozen, _race10StartSafe, _race10Start, _race10Deploy,
    _race10Eliminate, _race10Finish, _race10ReachBoss, _race10Rekey,
    _race10HoldOnDisconnect, _race10ClaimOnReconnect, _race10ReleaseRun, _race10Sweep,
  };
};
