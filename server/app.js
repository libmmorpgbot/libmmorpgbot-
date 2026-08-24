'use strict';
// ── Server bootstrap ────────────────────────────────────────────────────────
// The new entry point. What it does differently from server/index.js is mostly
// about ORDER: nothing accepts a connection until the things a connection needs
// are provably ready.
//
// The old boot connected to Mongo and started listening in parallel, so a
// player could log in before the database was up — the code has a comment
// admitting it ("the server starts accepting connections before Mongo is
// necessarily up"). A login that lands in that window reads nothing, and the
// client then persists that nothing back over real progress. Here the listen
// happens last, after the database answered and the catalog synced.

const path = require('path');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const { Server } = require('socket.io');

const db = require('./db');
const items = require('./db/repos/items');
const players = require('./db/repos/players');
const stats = require('./db/repos/stats');
const ops = require('./tg-ops');
const workers = require('./workers');
const adminAuth = require('./admin-auth');
const { Session, activeSessions, socketForTelegramId } = require('./session');
const world = require('./world');
const party = require('./party');
const modesLib = require('./modes');
const maintenance = require('./maintenance');
let modesRuntime = null;
const { verifyTelegramWebApp, verifyTelegramAuth, _safeUsername } = require('./security');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CORS_ORIGIN || '*' },
  transports: ['websocket'],
  pingTimeout: 25000,
  pingInterval: 15000,
  maxHttpBufferSize: 512 * 1024,
});

// ── HTTP ────────────────────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(helmet({
  frameguard: false,
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      // 'unsafe-inline' and 'unsafe-eval' are still here and still wrong. They
      // are removable only after the client stops using inline onclick handlers
      // (82 of them in index.html) and PixiJS's new Function; that is a client
      // change, scheduled separately. Recording it rather than leaving it to be
      // rediscovered.
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://telegram.org'],
      scriptSrcAttr: ["'unsafe-inline'"],
      workerSrc: ["'self'", 'blob:'],
      childSrc: ["'self'", 'blob:'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      styleSrcAttr: ["'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      connectSrc: ["'self'", 'wss:', 'ws:', 'https:'],
      fontSrc: ["'self'", 'data:'],
      frameSrc: ["'self'", 'https://oauth.telegram.org', 'https://telegram.org'],
      frameAncestors: ["'self'", 'https://web.telegram.org', 'https://*.web.telegram.org',
        'https://telegram.org', 'https://*.telegram.org'],
    },
  },
}));
app.use(compression());
app.use(express.json({ limit: '256kb' }));
// No cookie-parser: admin-auth reads the one cookie it cares about out of the
// raw header itself, and a dependency for that is a dependency to keep patched.

// Liveness is public; the operational detail below it is not. An uptime monitor
// must be able to read the first without credentials, and an attacker learns
// nothing useful from "ok" — but tick timings and pool saturation say precisely
// when the server is already struggling.
app.get('/health', async (req, res) => {
  let dbOk = false;
  try { await db.query(null, 'SELECT 1'); dbOk = true; } catch { /* reported below */ }
  const brief = { ok: dbOk, db: dbOk ? 'up' : 'down' };

  const tok = (req.headers.authorization || '').replace('Bearer ', '');
  if (!await adminAuth.verify(tok)) return res.json(brief);

  const mem = process.memoryUsage();
  res.json({
    ...brief,
    uptimeS: Math.round(process.uptime()),
    heapMb: Math.round(mem.heapUsed / 1048576),
    rssMb: Math.round(mem.rss / 1048576),
    sockets: io.engine.clientsCount,
    sessions: activeSessions.size,
    workers: workers.status(),
    ops: ops.status(),
    // Per-floor tick timings. "Иногда тупит" was unanswerable without these:
    // nothing recorded whether the 25ms world loop was making its budget.
    // Reading RESETS the window, so each poll describes the interval since the
    // last one.
    rooms: world.statsSnapshot(),
    // Config problems surface HERE rather than at the first failed login,
    // which is the difference between finding out now and finding out from a
    // player.
    config: adminAuth.configProblems(),
  });
});

// Readiness is the one a load balancer should watch. It returns 503 when the
// database is unreachable — but must NOT be wired to anything that restarts
// the container: killing the process cannot reach a database it could not
// reach either, and it drops every player to achieve nothing.
app.get('/health/ready', async (_req, res) => {
  try { await db.query(null, 'SELECT 1'); res.json({ ok: true }); }
  catch { res.status(503).json({ ok: false }); }
});

// ── the client ──────────────────────────────────────────────────────────────
// Mounted AFTER the health routes so a page named /health could never shadow
// them, and before nothing else — there is no catch-all, so an unmatched path
// is a 404 rather than index.html.
require('./static').mount(app, { floorRooms: world.floorRooms });

// ── the admin panel ─────────────────────────────────────────────────────────
// Mounted lazily inside boot(), because half of it answers questions about the
// event modes and those do not exist until the world does.
function mountAdmin() {
  require('./routes/admin2')(app, {
    io,
    modes: modesRuntime,
    maintenance,
    guildWarState: () => (modesRuntime && modesRuntime._gwPublicState ? modesRuntime._gwPublicState() : {}),
    guildWarOpen: () => modesRuntime && modesRuntime._gwOpenWindow && modesRuntime._gwOpenWindow(),
    guildWarClose: () => modesRuntime && modesRuntime._gwCloseWindow && modesRuntime._gwCloseWindow(),
  });
}

// ── sockets ─────────────────────────────────────────────────────────────────

// Rate limiting, unchanged in shape from the build this replaces because the
// shape was right: three buckets, because the events differ by what they COST
// the server, not by what they are called.
const HEAVY = new Set([
  'marketBrowse', 'marketMyListings', 'marketHistory', 'marketList', 'marketBuy', 'marketCancel',
  'gramGetHistory', 'gramDepositRequest', 'gramWithdrawRequest', 'balanceHistory',
  'craft', 'craftAdvSkillBook', 'enhanceItem', 'openLootBox', 'buyPotion', 'sellItem',
  'equipItem', 'unequipItem', 'storageDeposit', 'storageWithdraw',
  'registerCodexSetItem', 'codexSync', 'spendUpgrade', 'usePotion', 'useBuffPotion',
  'learnSkill', 'upgradeSkill', 'learnPassive', 'upgradePassive', 'learnAdvSkill',
  'toggleAdvSkill', 'claimQuest', 'completeSpecialQuest', 'claimVipRewards', 'vipSync',
  'seasonRating', 'rebirth', 'resetUpgrades', 'getRating',
  'clanCreate', 'clanApply', 'clanApprove', 'clanDecline', 'clanKick', 'clanLeave',
  'clanDisband', 'clanSetDescription', 'clanSearch', 'clanRequest',
  'clanStorageDeposit', 'clanStorageGive', 'clanStorageClaim', 'clanStorageCancel',
  'clanStorageUnlock', 'clanStorageSync',
  'chat', 'chatHistory', 'requestPlayerProfile', 'savePrefs',
  'selectChar', 'enterLocation', 'respawn',
  // NOT here on purpose: mv, playerMove, attack, skillAttack, enemyResync.
  // Those arrive per frame and belong in the loose bucket — the tight one
  // would throttle ordinary play, which is a worse outcome than the flood it
  // would prevent. enemyResync has its own, much tighter bound inside the
  // handler (40 records per call) because it is cheap to ask for and
  // expensive to answer.
]);

io.on('connection', (socket) => {
  const s = new Session(socket, io);

  const rl = { heavy: { n: 0, at: 0 }, fast: { n: 0, at: 0 } };
  const bump = (b, max) => {
    const now = Date.now();
    if (now > b.at) { b.n = 0; b.at = now + 5000; }
    return ++b.n <= max;
  };
  socket.use((packet, next) => {
    const ev = packet && packet[0];
    const ok = HEAVY.has(ev) ? bump(rl.heavy, 40) : bump(rl.fast, 1500);
    if (!ok) return;                       // dropped silently, over budget
    next();
  });

  // safeOn keeps a throwing handler from reaching process scope, where the
  // uncaughtException handler would take every player's connection down over
  // one bad packet. s.act() already catches inside a transaction; this is the
  // backstop for everything outside one.
  const errAt = new Map();
  function safeOn(event, handler) {
    socket.on(event, (...args) => {
      if (args.length && args[0] === null) args[0] = undefined;
      try {
        const r = handler(...args);
        if (r && typeof r.catch === 'function') r.catch(e => logErr(event, e));
      } catch (e) { logErr(event, e); }
    });
  }
  function logErr(event, err) {
    const now = Date.now();
    if (now - (errAt.get(event) || 0) < 5000) return;   // console.error is sync I/O
    errAt.set(event, now);
    console.error(`[socket:${event}]`, err);
    ops.alertError(`socket.${event}`, `Ошибка в обработчике ${event}`, err);
  }

  // ── auth ──────────────────────────────────────────────────────────────────
  // A connection that does not authenticate within the window is closed. The
  // socket costs memory and a slot; an anonymous one that never logs in is
  // either a scanner or a broken client.
  const authTimer = setTimeout(() => { if (!s.authed) socket.disconnect(true); }, 20000);

  async function finishLogin(telegramId, username) {
    const res = await s.login(String(telegramId), _safeUsername(username, telegramId));
    if (res.banned) {
      socket.emit('authError', { msg: 'Аккаунт заблокирован' });
      return socket.disconnect(true);
    }
    clearTimeout(authTimer);
    // Everything another connection may need to know about this one without
    // going through the database. `username` in particular: a party invite is
    // addressed to a socket and has to name the person behind it, and the
    // handler that does so was reading a field nothing set.
    socket.data.playerId = s.playerId;
    socket.data.telegramId = s.telegramId;
    socket.data.username = s.username;
    socket.data.session = s;
    socket.join(`tg_${s.telegramId}`);
    socket.emit('authOk', {
      username: s.username,
      isNewAccount: res.isNew,
      ...res.state,
      gramWallet: process.env.GRAM_WALLET || null,
    });
  }

  safeOn('loginTelegramWebApp', async ({ initData } = {}) => {
    const v = verifyTelegramWebApp(String(initData || ''));
    if (!v || !v.user) return socket.emit('authError', { msg: 'Проверка Telegram не пройдена' });
    await finishLogin(v.user.id, v.user.username || v.user.first_name);
  });

  safeOn('loginTelegram', async (data = {}) => {
    if (!verifyTelegramAuth(data)) return socket.emit('authError', { msg: 'Проверка Telegram не пройдена' });
    await finishLogin(data.id, data.username || data.first_name);
  });

  // ── the ported handlers ───────────────────────────────────────────────────
  const deps = {
    io,
    floorRooms: world.floorRooms,
    enterFloor: world.enterFloor,
    floorIdOf: world.floorIdOf,
    resolveFloor: world.resolveFloor,
    modes: modesRuntime,
    parties: party.parties,
    playerParty: party.playerParty,
    _removeFromParty: party.removeFromParty,
    safeTimeout: (name, fn, ms) => setTimeout(() => {
      try { fn(); } catch (err) { ops.alertError(`timer.${name}`, `Ошибка в таймере ${name}`, err); }
    }, ms),
    safeInterval: (name, fn, ms) => setInterval(() => {
      try { fn(); } catch (err) { ops.alertError(`timer.${name}`, `Ошибка в таймере ${name}`, err); }
    }, ms),
    // A socket id to the session behind it. The event modes and the profile
    // card both address other players this way, because a socket id is what
    // the client has for whoever it is standing next to.
    sessionForSocketId: (sid) => {
      const sk = io.sockets.sockets.get(sid);
      return sk && sk.data ? sk.data.session : null;
    },
    // playerId -> socket. Built from the telegram-id map the session already
    // keeps, rather than a second index that could disagree with it.
    socketForPlayerId: (pid) => {
      for (const sk of io.sockets.sockets.values()) {
        if (sk.data && sk.data.playerId === pid) return sk;
      }
      return null;
    },
  };
  // A latency probe. One line, and it is the reason a player can tell whether
  // the lag they are seeing is theirs or the server's.
  socket.on('_ping', t0 => socket.emit('_pong', t0));

  require('./handlers2/items')(s, safeOn, deps);
  require('./handlers2/economy')(s, safeOn, deps);
  require('./handlers2/progression')(s, safeOn, deps);
  require('./handlers2/social')(s, safeOn, deps);
  require('./handlers2/world')(s, safeOn, deps);
  require('./handlers2/modes')(s, safeOn, deps);
  require('./handlers2/coop')(s, safeOn, deps);

  // Preferences: the ONLY place a client value reaches the database. Six
  // fields, none of which touches combat or the economy.
  safeOn('savePrefs', ({ prefs } = {}) => s.act('savePrefs', 'prefsError', async (t, pid) => {
    const res = await players.savePrefs(t, pid, prefs);
    // An unknown key is expected mid-deploy (an old bundle sending a retired
    // field) and is counted rather than refused. A LOT of them is not, and
    // saying so is the difference between expected drift and something
    // sending us junk.
    if (res.ignored > 20) {
      ops.alert('prefs.junk', 'Клиент шлёт много неизвестных полей настроек',
        `игрок ${s.username}: ${res.ignored} неизвестных ключей`);
    }
    // Acknowledged with what was actually stored, not with what was sent. The
    // shipped client saved its preferences inside the progress blob and has no
    // handler for this yet — it is the replacement for that blob, and the one
    // surface a client may still write to. See UNHANDLED_BY_DESIGN in
    // dev/protocol-check.js.
    socket.emit('prefsSync', await players.prefsOf(t, pid));
  }));

  // Position is written on a timer, not per step: 40 writes a second per
  // player, for a value whose worst-case loss is a few metres of walking.
  const posTimer = setInterval(() => { s.savePosition(); }, 20000);
  posTimer.unref();

  socket.on('disconnect', async (reason) => {
    clearTimeout(authTimer);
    clearInterval(posTimer);
    try { await s.close(reason); } catch (e) { console.error('[disconnect]', e); }
  });
});

// ── boot ────────────────────────────────────────────────────────────────────
// The order below is the point of this file.
async function boot() {
  // 1. The database must answer before anything else is attempted. Failing
  //    here is a refusal to start, not a warning — a server that boots without
  //    its database is a server that accepts logins it cannot serve.
  await db.query(null, 'SELECT 1');
  console.log('postgres: connected');

  // 2. The catalog must be in place before any item can be granted, because
  //    player_items references it. Doing this at boot rather than lazily means
  //    a retired id is discovered now, in the log, rather than by a foreign-key
  //    error during a player's craft.
  const synced = await db.tx(t => items.syncCatalog(t));
  console.log(`catalog: ${synced.synced} items (${synced.retired} retired)`);

  // 2b. The world. Generated from a fixed seed, so this is deterministic and
  //     a failure here is a code problem rather than a transient one — which
  //     is why initFloors throws rather than continuing with a hole in the map.
  const floors = world.initFloors(io);
  console.log(`world: ${floors} floors`);

  // 2c. The event modes. Their schedules start here, which is why this is after
  //     the floors exist and before the first player can connect: a mode that
  //     opens its registration window while the arena has no room would deploy
  //     its entrants into nothing.
  modesRuntime = modesLib.init(io);
  party.init(io, {
    onLeave: (socketId) => {
      // Leaving a party ends the co-op and farm runs that party was on: both
      // modes are gated on the party existing.
      modesRuntime._coopEliminate(socketId);
      if (modesRuntime._farm2Eliminate) modesRuntime._farm2Eliminate(socketId);
    },
  });
  if (modesRuntime._gwRestore) await modesRuntime._gwRestore();
  if (modesRuntime._gwSchedule) modesRuntime._gwSchedule();
  if (modesRuntime._gwIncomeSchedule) modesRuntime._gwIncomeSchedule();
  console.log('modes: arena3, death battle, race, fear, co-op, elite farm, guild war');

  // 2d. The admin panel, now that the modes it reports on exist.
  mountAdmin();

  // 3. Configuration problems that would otherwise surface as a failed login
  //    or a missing alert.
  const problems = adminAuth.configProblems();
  if (problems.length) {
    console.error('[config] ' + problems.join('; '));
    await ops.send('alerts', `⚠️ <b>Проблемы конфигурации при запуске</b>\n` +
      problems.map(p => `• ${p}`).join('\n'));
  }

  // 4. Background work.
  const w = workers.start({
    notifyPlayer: async (c) => {
      const sock = socketForTelegramId(io, c.telegramId);
      // Two events the client already handles: the balance it shows, and the
      // row in the deposit history. 'gramCredited' was a third name for the
      // same news that nothing listened for, so a confirmed deposit left the
      // player's screen at the old number until they reloaded.
      if (sock) {
        sock.emit('gramBalanceUpdate', { balance: c.balance });
        sock.emit('gramTxUpdate', { id: c.txId || c.memo, status: 'credited' });
      }
    },
  });
  console.log(`workers: deposit scan every ${w.deposits}ms`);

  // 5. Only now.
  await new Promise(r => server.listen(PORT, r));
  console.log(`listening on ${PORT}`);
  await ops.send('alerts', `🟢 <b>Сервер запущен</b> · порт ${PORT} · каталог ${synced.synced} предметов`);
}

// ── shutdown ────────────────────────────────────────────────────────────────
let _shuttingDown = false;
// `exit` is false when a test calls this: the process has to survive long
// enough to print its own summary. A signal still exits, because that is what
// a signal means — and the first version exited unconditionally, so every
// integration test ended before it could say whether it had passed.
async function shutdown(signal, { exit = true } = {}) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`${signal}: shutting down`);

  workers.stop();
  world.stopAll();
  // Stop taking new connections first, so the flush below is bounded by the
  // sessions that already exist rather than racing new ones.
  server.close();
  io.close();

  // Positions, in parallel and bounded. Each is one small UPDATE; there is no
  // unwritten player state to flush, because the session never held any.
  await Promise.race([
    Promise.allSettled([...io.sockets.sockets.values()].map(sk =>
      sk.data && sk.data.session ? sk.data.session.close(signal) : null)),
    new Promise(r => setTimeout(r, 5000)),
  ]);

  await db.close();
  console.log('shutdown complete');
  if (exit) process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (require.main === module) {
  boot().catch(err => {
    console.error('[boot] failed:', err);
    ops.alertError('boot', 'Сервер НЕ запустился', err).finally(() => process.exit(1));
  });
}

module.exports = { app, server, io, boot, shutdown };
