'use strict';
// ── The event modes: 3v3, death battle, race, fear, co-op, elite farm ───────
//
// The six factories under server/game/ are kept exactly as they are. That is
// the point of this file: they hold hours of tuning — freeze windows, scatter
// radii, elimination ordering, reconnect grace — and none of that had anything
// to do with the database. Checked before touching them:
//
//   arena3.js  race10.js  death-battle.js  fear.js  coop.js  farm2.js
//     require: shared/definitions, game/floors, game/Room  — no Mongo
//
// So this is a wiring layer, not a rewrite. What it replaces is ~200 lines of
// closures scattered through server/index.js, and it changes exactly two
// things about them.
//
// FIRST: a daily attempt is now spent in the database, transactionally.
// _lockDailyAttempt fired a Mongo update and did not await it — `.catch(() =>
// {})`, no retry, no report. A failed write meant a free run, and nobody would
// ever have known. progression.takeAttempt is one conditional UPDATE that
// returns whether it took one, so a run that could not be paid for does not
// start.
//
// SECOND: the modes address players by SOCKET id, which is right — a run is a
// property of a connection, and a player who reconnects gets a new one. The
// bridge to a player id goes through the session, which is the only thing that
// knows both.

const progression = require('./db/repos/progression');
const money = require('./db/repos/money');
const { tx } = require('./db');
const { activeSessions } = require('./session');
const world = require('./world');
const ops = require('./tg-ops');
const { FLOOR_IDS } = require('./game/floors');
const {
  FARM2_DAILY_MINUTES, WORLD_BOSS_DAYS_MSK, WORLD_BOSS_HOURS_MSK,
  EVENT_NOTIFY_BEFORE_MS, nextEventStartAt,
  FEAR_MAX_WAVE, COOP_STAGE_LEVELS, FARM2_ENTRY_LEVEL, FARM2_PARTY_SIZE,
} = require('../shared/definitions');

const createArena3 = require('./game/arena3');
const createRace10 = require('./game/race10');
const createDeathBattle = require('./game/death-battle');
const createFear = require('./game/fear');
const createCoop = require('./game/coop');
const createFarm2 = require('./game/farm2');
const createGuildWar = require('./game/guildwar');

// The caps live INSIDE the factories — RACE10_ATTEMPTS, FEAR_ATTEMPTS and
// COOP_ATTEMPTS are each declared in their own file and returned. Reading them
// back out after construction keeps one copy of each number; declaring them
// again here would be a second copy free to drift, which is how a mode ends up
// offering three runs and refusing the third.
//
// The arena shares the dungeon pool, whose size was a bare `const
// DAILY_DUNGEON_ATTEMPTS = 3` in server/index.js and is stated here instead.
const DUNGEON_ATTEMPTS = 3;
function capOf(mode) {
  switch (mode) {
    case 'arena3': return DUNGEON_ATTEMPTS;
    case 'race10': return modes.RACE10_ATTEMPTS ?? 1;
    case 'fear':   return modes.FEAR_ATTEMPTS ?? 2;
    case 'coop':   return modes.COOP_ATTEMPTS ?? 2;
    default:       return 0;
  }
}

let _io = null;
const modes = {};

// ── socket ↔ player ─────────────────────────────────────────────────────────
// The modes hold socket ids. Everything that writes holds a player id. One
// lookup, in one place, so the two never have to be passed around together.
function sessionOf(socketId) {
  const sock = _io && _io.sockets.sockets.get(socketId);
  return sock && sock.data ? sock.data.session : null;
}
function playerIdOf(socketId) {
  const s = sessionOf(socketId);
  return s && s.authed ? s.playerId : null;
}
function socketTid(socketId) {
  const sock = _io && _io.sockets.sockets.get(socketId);
  return (sock && sock.data && sock.data.telegramId) || null;
}

// ── daily attempts ──────────────────────────────────────────────────────────
// Reading is cheap and answers a UI. Spending is a decision and must be
// awaited: a mode that starts a run it could not charge for is a mode that
// gives out free runs to anyone who can make one write fail.
async function attemptsLeft(socketId, mode) {
  const pid = playerIdOf(socketId);
  if (!pid) return 0;
  try { return await progression.attemptsLeft(null, pid, mode, capOf(mode)); }
  catch { return 0; }          // fail CLOSED: unknown means no free run
}

async function takeAttempt(socketId, mode) {
  const pid = playerIdOf(socketId);
  if (!pid) return false;
  try { return !!await tx(t => progression.takeAttempt(t, pid, mode, capOf(mode))); }
  catch (err) {
    ops.alertError('modes.attempt', `Не удалось списать попытку (${mode})`, err);
    return false;
  }
}

// ── shared helpers the factories expect ─────────────────────────────────────
function getRoom(floor) { return world.roomOf(floor); }

function findPlayerAnyFloor(socketId) {
  const s = sessionOf(socketId);
  if (!s || !s.room) return null;
  return s.room.players.get(socketId) || null;
}

// Sends the player back to the hub and returns where they landed. Goes through
// the session's own floor change, so the room membership, the position write
// and the client's gameStart all happen the one way they happen everywhere
// else — a mode that moved players by hand is a mode with its own bugs.
function returnToHub(socketId) {
  const s = sessionOf(socketId);
  if (!s || typeof s.forceFloor !== 'function') return null;
  const p = s.forceFloor(FLOOR_IDS.hub);
  return p ? { x: p.x, y: p.y } : null;
}

function safeTimeout(name, fn, ms) {
  return setTimeout(() => {
    try { fn(); }
    catch (err) {
      console.error(`[timer:${name}]`, err);
      ops.alertError(`timer.${name}`, `Ошибка в таймере ${name}`, err);
    }
  }, ms);
}

// ── announcements ───────────────────────────────────────────────────────────
// These two are called by EVERY mode — arena, the Tower, the death battle, the
// guild war — whenever its registration window opens.
//
// The rewrite pointed both at 'eventBossAnnounce' / 'eventBossSpawned', which
// are not general event names: they are the WORLD BOSS's, and the client
// handles them by setting _evtBossAlive, loading the demon sprite sheet,
// playing the boss horn and showing "Босс прибыл!". So every arena window
// opening announced a boss that did not exist, and the Events panel then
// believed one was standing on the map.
//
// Announcements go to the global chat, which every client already renders and
// which no mode has to be taught about. The world boss keeps its own two
// events, emitted from where it actually spawns (see scheduleEventBoss).
const _announced = new Set();
function announceOnce(key, text) {
  if (_announced.has(key)) return;
  _announced.add(key);
  // A handful of keys per process, but a long-lived one should not grow
  // without bound either.
  if (_announced.size > 64) _announced.delete(_announced.values().next().value);
  if (_io) _io.emit('chatMsg', { username: 'СОБЫТИЕ', text, time: new Date().toISOString() });
}

const EVENT_NAME = {
  boss:     'Мировой босс',
  battle:   'Битва на смерть',
  race10:   'Кровавая Башня',
  a3:       'Арена 3х3',
  guildWar: 'Война гильдий',
};

// ── и то же самое В TELEGRAM ──────────────────────────────────────────────
// Объявление в игровой чат видит только тот, кто уже в игре, — а смысл
// предупреждения ровно обратный: позвать тех, кого сейчас нет. В прошлой
// сборке эти рассылки были (server/index.js, _EVENT_TEXT + tgBroadcastAll), в
// переписанной остался только чат, и после перехода на боевого бота они бы
// просто перестали приходить.
//
// Тексты — те же, что игроки читали до сих пор: время по Москве, правило
// события и что будет, если не прийти. Короткая строка вида «Арена 3х3 —
// через 30 мин.» годится для чата, где рядом виден сам мир, и не годится для
// личного сообщения, где кроме неё нет ничего.
const _EVENT_TEXT = {
  boss: {
    soon: (m) => `⚔️ <b>Мировой босс</b>\n\nПоявится через ${m} мин. — в 20:00 по Москве.\nДобыча падает на пол для всех: кто успел, тот забрал.`,
    now:  () => '⚔️ <b>Мировой босс появился!</b>\n\nОн уже в безопасной зоне. Заходи в игру — добычу заберут без тебя.',
  },
  battle: {
    soon: (m) => `🗡 <b>Битва на смерть</b>\n\nНачало через ${m} мин.\nПоследний выживший забирает GRAM и снаряжение.`,
    now:  () => '🗡 <b>Битва на смерть</b>\n\nРегистрация открыта — заходи и записывайся, бой начнётся через 5 минут.\nПосле старта присоединиться уже нельзя.',
  },
  race10: {
    soon: (m) => `🏃 <b>Кровавая Башня</b>\n\nОкно регистрации откроется через ${m} мин. — в 20:30 по Москве, всего на 5 минут.\nПобеждает тот, кто нанесёт общему боссу больше всего урона.`,
    now:  () => '🏃 <b>Кровавая Башня открыта!</b>\n\nЗаписывайся в игре — старт через 5 минут со всеми, кто успел.',
  },
  a3: {
    soon: (m) => `⚔️ <b>Арена 3х3</b>\n\nОкно регистрации откроется через ${m} мин. — с 21:00 до 22:00 по Москве.`,
    now:  () => '⚔️ <b>Арена 3х3 открыта!</b>\n\nЗаписывайся в игре — как наберётся 6 человек, старт. Окно открыто до 22:00 по Москве.',
  },
  guildWar: {
    soon: (m) => `🏰 <b>Война гильдий</b>\n\nЛокация с замком откроется через ${m} мин. — с 22:00 до 22:15 по Москве.\nКлан, который захватит замок, будет получать осколки каждый час, пока держит его.`,
    now:  () => '🏰 <b>Война гильдий открыта!</b>\n\nЗаходи в игру — локация с замком доступна до 22:15 по Москве.',
  },
};

// Каждому зарегистрированному аккаунту, по 30 сообщений в секунду: Telegram
// режет массовые рассылки примерно на этой отметке и дальше отвечает 429.
//
// Ничего не ждём и ни на что не смотрим: упавший бот, заблокировавший его
// игрок или медленный ответ Telegram не должны задержать — и тем более
// сорвать — само событие. Оно начнётся в срок независимо от того, узнал ли
// о нём кто-нибудь.
async function tgBroadcastAll(text) {
  const tg = require('./tg-game');
  if (!tg.isLive()) return 0;
  const { pool } = require('./db');
  const { rows } = await pool().query('SELECT telegram_id FROM players');
  for (let i = 0; i < rows.length; i++) {
    tg.send(rows[i].telegram_id, text).catch(() => {});
    if (i % 30 === 29) await new Promise(r => setTimeout(r, 1000));
  }
  return rows.length;
}

function notifyEventSoon(kind, at) {
  const mins = Math.max(1, Math.round((at - Date.now()) / 60000));
  if (_announced.has(`${kind}:soon:${at}`)) return;
  announceOnce(`${kind}:soon:${at}`, `${EVENT_NAME[kind] || kind} — через ${mins} мин.`);
  const t = _EVENT_TEXT[kind];
  if (t) tgBroadcastAll(t.soon(mins)).catch(err => console.error('notifyEventSoon:' + kind, err));
}
function notifyEventStarted(kind, at) {
  if (_announced.has(`${kind}:now:${at}`)) return;
  announceOnce(`${kind}:now:${at}`, `${EVENT_NAME[kind] || kind} — началось!`);
  const t = _EVENT_TEXT[kind];
  if (t) tgBroadcastAll(t.now()).catch(err => console.error('notifyEventStarted:' + kind, err));
}

// A finished duel, for the history panel. Written outside any transaction the
// caller may hold, because it is a record of something that already happened
// and must not be able to roll a reward back.
// ── two calling conventions, because there are two callers ──────────────────
//
//   _pvpEliminate  (socketId, { kind, mode, opponent })   — this file
//   every mode     (telegramId, kind, mode, opponent)     — server/game/*.js
//
// Seven call sites use the second form, and the rewrite only implemented the
// first. Every one of them therefore looked up a TELEGRAM id in a table of
// SOCKET ids, got nothing, and returned before writing — so even once the
// missing columns are added, the duel history would still record only the
// deaths that happen outside a mode.
//
// Rather than editing seven verbatim-ported call sites, the function accepts
// both. Which it got is unambiguous: the second argument is a string in the
// positional form and an object in the other.
async function recordPvpHistory(who, rowOrKind, mode, opponent) {
  const row = (typeof rowOrKind === 'string')
    ? { kind: rowOrKind, mode, opponent }
    : (rowOrKind || {});

  // A socket id if we hold one, otherwise the account behind a telegram id.
  let pid = playerIdOf(who);
  if (!pid) {
    const sid = activeSessions.get(String(who));
    if (sid) pid = playerIdOf(sid);
  }
  if (!pid) return;

  // 'win'/'lose' are the outcome of a MATCH; 'kill'/'death' are single events
  // inside one. Only the first pair has a verdict, and the column is nullable
  // so "no verdict" stays distinct from "lost".
  const won = row.won != null ? row.won === true
            : row.kind === 'win' ? true
            : row.kind === 'lose' ? false
            : null;
  try {
    const { query, hasColumn } = require('./db');
    // `won` and `reward` are added by migration 009. Until it runs, the row is
    // still worth writing without them — a duel that happened is a fact, and
    // the alternative was the whole INSERT raising 42703 and being swallowed,
    // which is how this table stayed empty since the day it was created.
    const outcome = await hasColumn('pvp_history', 'won');
    if (outcome) {
      await query(null, `
        INSERT INTO pvp_history (player_id, kind, mode, opponent, won, reward)
        VALUES ($1, $2, $3, $4, $5, $6)`,
        [pid, row.kind || 'duel', row.mode || 'pvp', row.opponent || null,
         won, row.reward == null ? null : String(row.reward)]);
    } else {
      await query(null, `
        INSERT INTO pvp_history (player_id, kind, mode, opponent)
        VALUES ($1, $2, $3, $4)`,
        [pid, row.kind || 'duel', row.mode || 'pvp', row.opponent || null]);
    }
  } catch (err) {
    console.error('[modes] pvp history:', err.message);
  }
}

// Paying a mode's reward. GRAM and Liberty both go through money.js, which is
// the whole point of money.js — the old modes credited a session field and let
// the debounced save carry it, so a disconnect between the win and the save
// lost the prize.
async function payReward(socketId, currency, amount, ref) {
  const pid = playerIdOf(socketId);
  if (!pid || !(amount > 0)) return null;
  try {
    return await tx(t => money.credit(t, pid, currency, amount, {
      reason: 'mode_reward', refType: 'mode', refId: String(ref || ''),
      idemKey: `mode:${pid}:${ref}`,
    }));
  } catch (err) {
    ops.alertError('modes.reward', `Не удалось выплатить награду (${ref})`, err, { playerId: pid });
    return null;
  }
}

// ── construction ────────────────────────────────────────────────────────────
function init(io) {
  _io = io;
  const shared = {
    io,
    getRoom,
    // Read as a map AND iterated as one: _gwCloseWindow walks every connection
    // to send whoever is standing in the castle home. A stub with only `.get`
    // threw `playerFloorMap is not iterable` from inside a timer, so the guild
    // war never closed — the log is the only place it appeared.
    playerFloorMap: {
      get: (sid) => { const s = sessionOf(sid); return s ? s.floor : null; },
      [Symbol.iterator]: function* () {
        if (!_io) return;
        for (const sock of _io.sockets.sockets.values()) {
          const s = sock.data && sock.data.session;
          if (s && s.authed) yield [sock.id, s.floor];
        }
      },
    },
    logPlayer: () => {},                       // player_logs is written by the session
    _recordPvpHistory: recordPvpHistory,
    _returnToHub: returnToHub,
    _findPlayerAnyFloor: findPlayerAnyFloor,
    _socketTid: socketTid,
    notifyEventSoon,
    notifyEventStarted,
    safeTimeout,
  };

  Object.assign(modes, createArena3({
    ...shared,
    DAILY_DUNGEON_ATTEMPTS: DUNGEON_ATTEMPTS,
    _arena3AttemptsLeft: (sid) => attemptsLeft(sid, 'arena3'),
    _lockArena3Daily: (sid) => takeAttempt(sid, 'arena3'),
  }));
  Object.assign(modes, createRace10({
    ...shared,
    _race10AttemptsLeft: (sid) => attemptsLeft(sid, 'race10'),
    _lockRace10Daily: (sid) => takeAttempt(sid, 'race10'),
  }));
  Object.assign(modes, createDeathBattle(shared));

  // The castle. Its persistence is handed in — see the comment at the top of
  // game/guildwar.js for why that file no longer reaches for a model itself.
  Object.assign(modes, createGuildWar({
    ...shared,
    _socketForTelegramId: (tid) => {
      const sid = activeSessions.get(String(tid));
      return sid ? io.sockets.sockets.get(sid) : null;
    },
    loadCastle: async () => {
      const { query } = require('./db');
      // The name and the icon are the CLAN's, joined at read time rather than
      // copied into this row. A clan that renames itself would otherwise keep
      // flying its old banner over the castle until the next capture — and a
      // clan that is deleted would leave a name pointing at nothing.
      const { rows } = await query(null, `
        SELECT g.owner_clan_id, g.captured_at, c.name, c.icon
          FROM guild_war_state g LEFT JOIN clans c ON c.id = g.owner_clan_id
         WHERE g.key = 'castle'`);
      if (!rows.length) return null;
      return {
        ownerClanId: rows[0].owner_clan_id == null ? null : Number(rows[0].owner_clan_id),
        ownerClanName: rows[0].name,
        ownerClanIcon: rows[0].icon,
        capturedAt: rows[0].captured_at ? new Date(rows[0].captured_at).getTime() : 0,
      };
    },
    saveCastle: async (st) => {
      const { query } = require('./db');
      await query(null, `
        INSERT INTO guild_war_state (key, owner_clan_id, captured_at)
        VALUES ('castle', $1, to_timestamp($2 / 1000.0))
        ON CONFLICT (key) DO UPDATE SET
          owner_clan_id = EXCLUDED.owner_clan_id,
          captured_at = EXCLUDED.captured_at`,
        [st.ownerClanId, st.capturedAt || Date.now()]);
    },
    // One upsert. The Mongo version was two writes with a race between them:
    // the second only ran when the first matched nothing, so two grants landing
    // together could both decide the entry did not exist yet.
    grantClanStorage: async (clanId, itemId, qty) => {
      const { query } = require('./db');
      await query(null, `
        INSERT INTO clan_storage (clan_id, item_id, qty) VALUES ($1, $2, $3)
        ON CONFLICT (clan_id, item_id) DO UPDATE SET qty = clan_storage.qty + EXCLUDED.qty`,
        [clanId, itemId, qty]);
    },
    clanForStorage: async (clanId) => {
      const clans = require('./db/repos/clans');
      const view = await clans.fullView(null, clanId);
      if (!view) return null;
      const { query } = require('./db');
      const { rows } = await query(null, `
        SELECT p.telegram_id FROM clan_members m JOIN players p ON p.id = m.player_id
         WHERE m.clan_id = $1`, [clanId]);
      return {
        _id: clanId,
        storageUnlocked: view.storageUnlocked,
        storage: view.storage,
        members: rows.map(r => ({ telegramId: r.telegram_id })),
      };
    },
  }));
  Object.assign(modes, createFear(shared));
  Object.assign(modes, createCoop(shared));
  // Named and kept, rather than written inline into the factory's deps. It has
  // TWO callers — farm2.js settles the last partial minute with it, and the
  // per-minute ticker in handlers2/coop.js charges the whole ones — and the
  // second could not reach it: a dep passed INTO a factory is in that
  // factory's closure, not on `modes`, so `modes._lockFarm2MinutesFor` was
  // undefined and `modes._socketTid` with it.
  //
  // The ticker's line was `if (tid) modes._lockFarm2MinutesFor(tid, 1)` behind
  // `const tid = modes._socketTid && modes._socketTid(sid)` — guarded, so it
  // never threw and never ran. But the ticker also did `run.chargedMin += 1`,
  // which is what _farm2SettleMinutes subtracts from the elapsed time at the
  // end of a run. So the run claimed to have paid for every minute, settlement
  // computed nothing left owing, and the elite farm zone's daily allowance was
  // never spent by anyone. The gate has been open since the rewrite.
  const _lockFarm2MinutesFor = (tid, minutes) => {
    // Charged against the PLAYER, not the connection: a reconnect mid-run
    // used to start the budget over, because the old counter hung off the
    // socket. The budget itself is the cap, so a run that overruns it is
    // clamped rather than allowed to go negative.
    const sid = activeSessions.get(String(tid));
    const pid = sid ? playerIdOf(sid) : null;
    if (!pid || !(minutes > 0)) return;
    tx(t => progression.spendSeconds(t, pid, 'farm2', minutes * 60, FARM2_DAILY_MINUTES * 60))
      .catch(err => ops.alertError('modes.farm2', 'Не удалось списать минуты фарма', err));
  };
  Object.assign(modes, createFarm2({ ...shared, _lockFarm2MinutesFor }));
  // On the runtime as well as in the closure, because a caller outside this
  // file has no other way to reach it.
  modes._lockFarm2MinutesFor = _lockFarm2MinutesFor;
  modes._socketTid = socketTid;

  // ── the two cross-mode predicates ───────────────────────────────────────
  // Every mode has its own freeze window and its own idea of what elimination
  // means, and a player can only be in one of them — so these ask all of them
  // and take the first answer. They lived in server/index.js because that is
  // where every mode's closures happened to be in scope; they belong here.
  modes._teleportFrozen = new Map();          // socketId -> until (ms)
  modes._pvpFrozen = (socketId) => {
    const until = modes._teleportFrozen.get(socketId) || 0;
    if (until > Date.now()) return true;
    return !!(modes._dbFrozen(socketId) || modes._a3Frozen(socketId) || modes._race10Frozen(socketId));
  };

  // Order matters and is unchanged: whichever mode claims the elimination
  // handles it, and only a death that NO mode claimed is an open-world kill
  // worth writing to the duel history.
  modes._pvpEliminate = (socketId, killerSocketId, room, opts) => {
    const dbHandled   = modes._dbEliminate(socketId, killerSocketId);
    const a3Handled   = modes._a3Eliminate(socketId, killerSocketId);
    const r10Handled  = modes._race10Eliminate(socketId);
    const fearHandled = (opts && opts.fearGrace)
      ? modes._fearHoldOnDisconnect(socketId, opts.telegramId)
      : modes._fearEliminate(socketId);
    const coopHandled = (opts && opts.fearGrace)
      ? modes._coopEjectOnDisconnect(socketId)
      : modes._coopEliminate(socketId);
    if (killerSocketId && !dbHandled && !a3Handled && !r10Handled && !fearHandled && !coopHandled) {
      const victim = room && room.players.get(socketId);
      const killer = room && room.players.get(killerSocketId);
      recordPvpHistory(socketId, { kind: 'death', mode: 'open_pvp', opponent: killer && killer.username });
      recordPvpHistory(killerSocketId, { kind: 'kill', mode: 'open_pvp', opponent: victim && victim.username });
    }
  };
  modes._returnToHub = returnToHub;
  modes._recordPvpHistory = recordPvpHistory;

  // ── the world boss ───────────────────────────────────────────────────────
  // Room.spawnEventBoss() exists, is correct, and was called by nothing: the
  // scheduler that summons it four evenings a week did not survive the
  // rewrite. So the Events panel counted down to a boss that never arrived,
  // and the arena was never open.
  //
  // The boss appears the MOMENT it is summoned — there is no five-minute
  // countdown between the schedule and the spawn, because that made the
  // advertised 20:00 mean 20:05. `spawnAt` stays in the wire shape pinned at
  // zero: the client's countdown UI reads it, and zero is what tells it there
  // is nothing pending.
  let wbSpawnTimer = null, wbNotifyTimer = null;
  const wbNextAt = (from = Date.now()) =>
    nextEventStartAt(WORLD_BOSS_DAYS_MSK, WORLD_BOSS_HOURS_MSK, from);

  modes.eventBossState = () => {
    const room = getRoom(FLOOR_IDS.arena);
    return {
      spawnAt: 0,
      alive: !!(room && room.isEventBossAlive()),
      // Travels with the rest of the state rather than being computed on the
      // client from a copy of the schedule that could drift.
      nextAt: wbNextAt(),
      drops: room ? room.worldDropSnapshot() : [],
    };
  };

  // Whether the arena can be walked into. Up while the boss lives, and for as
  // long as its loot is still on the floor after — so nobody who was fighting
  // is locked out of collecting a drop.
  modes._arenaOpen = () => {
    const room = getRoom(FLOOR_IDS.arena);
    if (!room) return false;
    return room.isEventBossAlive() || room.worldDropSnapshot().length > 0;
  };

  modes.scheduleEventBoss = () => {
    const room = getRoom(FLOOR_IDS.arena);
    if (!room) return { error: 'Мир ещё не инициализирован' };
    if (room.isEventBossAlive()) return { error: 'Босс уже на карте' };
    const boss = room.spawnEventBoss();
    if (!boss) return { error: 'Не удалось призвать босса' };
    // Everyone, not just the arena: the banner and the horn are how a player
    // standing in the hub learns it is worth walking in. `x`/`y` are the
    // client's own visibility test for whether to play the sound.
    io.emit('eventBossSpawned', { x: boss.x, y: boss.y });
    return { ok: true, spawnAt: 0 };
  };

  // Arms the next summon plus its 30-minute warning, then re-arms itself.
  function wbSchedule() {
    clearTimeout(wbSpawnTimer);
    clearTimeout(wbNotifyTimer);
    const at = wbNextAt();
    if (!at) return;
    // Only arm the warning if its moment is still ahead — otherwise a restart
    // inside the 30-minute window announces "coming soon" the instant the
    // process boots, so every redeploy would spam everyone.
    const warnIn = at - EVENT_NOTIFY_BEFORE_MS - Date.now();
    if (warnIn > 0) wbNotifyTimer = safeTimeout('wbNotify', () => notifyEventSoon('boss', at), warnIn);
    wbSpawnTimer = safeTimeout('wbSpawn', () => {
      const r = modes.scheduleEventBoss();
      // A summon refused because an admin already called it is not worth
      // announcing — skip the notice and re-arm for next time.
      if (!r.error) notifyEventStarted('boss', at);
      wbSchedule();
    }, Math.max(0, at - Date.now()));
    if (wbSpawnTimer.unref) wbSpawnTimer.unref();
    if (wbNotifyTimer && wbNotifyTimer.unref) wbNotifyTimer.unref();
  }
  wbSchedule();

  // ── and the other three, which nobody was arming ─────────────────────────
  // The world boss above and the guild war (armed from server/app.js) each
  // schedule themselves at boot. The 3v3 arena, Кровавая Башня and the death
  // battle do not: _a3Schedule, _race10Schedule and _dbSchedule are called
  // ONLY from inside their own close/finish handlers.
  //
  // Which never runs. A window that never opens never closes, so it never
  // re-arms, so it never opens. All three sat in their initial phase forever
  // and the player who asked "события включи как-нибудь" was right — there was
  // no way to start them short of an admin pressing the button by hand.
  //
  // Same defect as spawnGuildWarTower: a function that existed, was correct,
  // was exported, and was called by nothing. Three times over.
  //
  // Guarded per mode rather than in one try: a factory that failed to load
  // should cost its own schedule and not the other two.
  for (const [name, fn] of [
    ['arena3', modes._a3Schedule],
    ['race10', modes._race10Schedule],
    ['deathBattle', modes._dbSchedule],
  ]) {
    if (typeof fn !== 'function') {
      console.error('[modes] ' + name + ': нет функции расписания — событие не запустится');
      ops.alert('modes.noschedule', 'Событие без расписания',
        name + ': _*Schedule отсутствует, окно никогда не откроется').catch(() => {});
      continue;
    }
    try { fn(); } catch (err) {
      console.error('[modes] ' + name + ' schedule:', err);
      ops.alertError('modes.schedule.' + name, 'Не удалось поставить расписание события', err).catch(() => {});
    }
  }

  // ── walking out of an instanced run ends it ──────────────────────────────
  // Страх, co-op and the elite farm zone each keep a record saying "this
  // connection is mid-run". Two things used to clear it: clearing the last
  // wave, and dying. Leaving the floor ANY other way — the return button, a
  // portal, an event window closing and moving you — left the record behind.
  //
  // A leftover record is not inert. fearEnter checks it FIRST and returns in
  // silence on a hit, so the button does nothing at all and the attempt is
  // never spent; co-op and the farm zone check it too and refuse out loud with
  // "Вы сейчас в Страхе". So one walk out of Страх locked a player out of
  // every instanced mode in the game until they reconnected — which is exactly
  // "события зайшли, воно не стартується".
  //
  // The old build did this inside its own floor-change function. This is the
  // same rule in the one place both floor changes go through.
  modes.leaveInstanceFloor = (socketId, oldFloor) => {
    if (!Number.isFinite(oldFloor)) return;
    try {
      if (oldFloor === FLOOR_IDS.fear) {
        if (modes._fearReleaseRun(socketId)) {
          io.to(socketId).emit('fearState', {
            maxAttempts: modes.FEAR_ATTEMPTS, maxWave: FEAR_MAX_WAVE,
            minLevel: modes.FEAR_MIN_LEVEL, inRun: false, wave: 0,
          });
        }
        return;
      }
      if (oldFloor === FLOOR_IDS.coop) {
        const run = modes._coop.get(socketId);
        if (!run) return;
        const partnerId = run.partnerId;
        modes._coopReleaseRun(socketId);
        // A co-op run with one person left is a run whose rules no longer
        // hold: the partner is sent home rather than left waiting on a stage
        // that can now never clear.
        if (partnerId && modes._coop.has(partnerId)) modes._coopFinish(partnerId, false);
        io.to(socketId).emit('coopState', {
          maxAttempts: modes.COOP_ATTEMPTS, maxStage: COOP_STAGE_LEVELS.length,
          minLevel: modes.COOP_MIN_LEVEL, inRun: false, stage: 0,
        });
        return;
      }
      if (oldFloor === FLOOR_IDS.farmZone2) {
        const run = modes._farm2.get(socketId);
        if (!run) return;
        const { room, participantIds } = run;
        modes._farm2ReleaseRun(socketId);
        modes._farm2CascadeCheck(room, participantIds);
        io.to(socketId).emit('farm2State', {
          entryLevel: FARM2_ENTRY_LEVEL, partySize: FARM2_PARTY_SIZE,
          dailyMinutes: FARM2_DAILY_MINUTES, inRun: false,
        });
      }
    } catch (err) {
      ops.alertError('modes.leaveInstance', 'Ошибка при выходе из инстанса', err);
    }
  };

  // ── every mode's stake in one swing of a sword ───────────────────────────
  // A hit is a hit in the open world. Inside a mode it is also a wave counter,
  // a damage tally, a stage, a captured tower or the end of a run — and each
  // of those lives in a different module. The old build called five of them by
  // name from the attack handler; the rewrite's handler called none, which is
  // not a subtle failure: Страх spawned wave 1 and never wave 2, because
  // nothing was counting. Co-op never left stage one. The race boss took
  // damage nobody tallied, so it could not be won.
  //
  // Collected here rather than back in the handler because this is the only
  // file that has all of them in scope, and because the two attack handlers
  // must not drift apart — the old build's did, subtly, twice.
  //
  // Returns true when the caller should stop: only the race boss does that,
  // and only on the killing hit, because _race10Finish despawns it and the
  // ordinary reward path would then be paying out for a monster that is gone.
  modes._onCombatResult = (socketId, enemyId, result, room) => {
    if (!result) return false;

    // The race boss tallies EVERY hit, not just the last: the winner is whoever
    // dealt the most damage, which a killing-blow-only count cannot know.
    if (result.raceBoss) {
      if (modes._race10.live && modes._race10.bossId === enemyId) {
        const dmg = (modes._race10.dmg.get(socketId) || 0) + (result.dmg || 0);
        modes._race10.dmg.set(socketId, dmg);
        const ranked = [...modes._race10.dmg.values()].sort((a, b) => b - a);
        io.to(socketId).emit('race10Score', {
          myDamage: dmg, rank: ranked.indexOf(dmg) + 1, total: modes._race10.dmg.size,
        });
      }
      if (!result.killed) return false;
      // Visual only — no reward fields. Without it the boss freezes on every
      // screen, because _race10Finish removes it before the next tick could
      // ever report hp 0.
      if (room && room.viewersOfEnemy) {
        const all = room.viewersOfEnemy(enemyId, null);
        if (all && all.length) {
          io.to(all).emit('enemyKilled', { id: enemyId, ex: result.ex, ey: result.ey, color: result.color });
        }
      }
      let winnerId = null, best = -1;
      modes._race10.dmg.forEach((d, sid) => { if (d > best) { best = d; winnerId = sid; } });
      modes._race10Finish(winnerId, false);
      return true;
    }

    if (!result.killed) return false;

    // Fear and co-op kills still pay through the ordinary reward path — these
    // only advance the run, so neither gates the rest of the handler.
    if (result.arm === 'fear') modes._fearTrackKill(socketId, result);
    else if (result.arm === 'coop') {
      if (result.isBoss) {
        modes._coopBossTrackKill(socketId, result)
          .catch(err => ops.alertError('modes.coopBoss', 'Ошибка награды за босса кооператива', err));
      } else modes._coopTrackKill(socketId, result);
    }

    // A floor boss going down is floor-wide news: the client draws the respawn
    // countdown from it, and the countdown is the only thing that tells a
    // player whether it is worth waiting.
    if (result.isBoss && room && Number.isFinite(room.floor)) {
      io.to(`floor_${room.floor}`).emit('bossStatus', {
        arm: result.arm, alive: false, respawnAt: result.respawnAt,
      });
    }
    return false;
  };

  modes.farm2MinutesLeft = async (socketId) => {
    const pid = playerIdOf(socketId);
    if (!pid) return 0;
    try {
      const left = await progression.secondsLeft(null, pid, 'farm2', FARM2_DAILY_MINUTES * 60);
      return Math.max(0, Math.floor(left / 60));
    } catch { return 0; }
  };
  modes.capOf = capOf;
  modes.attemptsLeft = attemptsLeft;
  modes.takeAttempt = takeAttempt;
  modes.payReward = payReward;
  modes.sessionOf = sessionOf;
  modes.playerIdOf = playerIdOf;
  return modes;
}

module.exports = { init, modes, capOf, attemptsLeft, takeAttempt, payReward, sessionOf, playerIdOf };
