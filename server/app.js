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
const plog = require('./db/repos/playerlog');
const ops = require('./tg-ops');
const workers = require('./workers');
const adminAuth = require('./admin-auth');
const { Session, activeSessions, socketForTelegramId } = require('./session');
const world = require('./world');
const version = require('./version');
const party = require('./party');
const modesLib = require('./modes');
const maintenance = require('./maintenance');
const presence = require('./presence');
const modeRewards = require('./mode-rewards');
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
  // The build, in the ONE response anyone can reach without credentials.
  // A bug report against the wrong server costs more than this line saves.
  const brief = { ok: dbOk, db: dbOk ? 'up' : 'down', build: version.COMMIT, since: version.STARTED_AT };

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
    // The player log: how many rows are queued, written, and lost. An empty
    // player_logs table looked exactly like a quiet server until this existed.
    playerLog: plog.stats(),
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

// ── what breaks in the BROWSER ──────────────────────────────────────────────
// Half of what a player calls a bug never reaches this process at all. The
// market lot that could not be bought was a string compared against a number
// in js/ui.js: the click did nothing, no request was made, the server had
// nothing to log — and the report was "не мог купить лот, и никаких ошибок наш
// лог не выбил". It was right. There was no way for the client to say so.
//
// This is that way. The page reports its own exceptions, its rejected
// promises, and any request that came back wrong; they land in the same
// alerts topic as everything else, through the same throttle, so a broken
// build cannot flood it.
const _clientErrRate = new Map();       // ip -> { n, until }
app.post('/client-error', (req, res) => {
  // Answered before anything else can go wrong. A reporting endpoint that
  // returns an error is a reporting endpoint that starts a loop.
  res.status(204).end();
  try {
    const ip = req.ip || 'anon';
    const now = Date.now();
    const b = _clientErrRate.get(ip) || { n: 0, until: 0 };
    if (now > b.until) { b.n = 0; b.until = now + 60000; }
    _clientErrRate.set(ip, b);
    // 20 a minute per address. Past that the sender is looping, and the
    // throttle inside ops.alert would collapse them anyway — this stops the
    // work before it is done rather than after.
    if (++b.n > 20) return;
    if (_clientErrRate.size > 2000) {
      for (const [k, v] of _clientErrRate) if (v.until < now) _clientErrRate.delete(k);
    }

    // ── crawlers are not players ─────────────────────────────────────────────
    // The first alert this path produced in anger was
    //
    //   Ошибка у игрока (pixi-unsupported)
    //   на устройстве нет WebGL — no webgl2 · no webgl1
    //   браузер: Mozilla/5.0 (compatible; Dataprovider.com)
    //
    // which is a web crawler. Of course it has no WebGL — it is not a browser
    // and there is no player. Every indexer, scanner and link-preview fetcher
    // that loads the page will report the same thing forever, and an alerts
    // topic that fills with robots is one nobody reads.
    //
    // Judged on the User-Agent, which is the server's to see. A crawler that
    // lies about being Chrome gets treated as a player, and that is the right
    // way round to be wrong.
    const ua = String(req.headers['user-agent'] || '');
    if (!ua || /bot|crawl|spider|slurp|scan|preview|fetch|monitor|headless|dataprovider|curl|wget|python-requests|go-http|okhttp|java\//i.test(ua)) {
      return;
    }

    const body = req.body || {};
    const where = String(body.where || 'client').slice(0, 60);
    const message = String(body.message || '').slice(0, 400);
    if (!message) return;
    const stack = String(body.stack || '').split('\n').slice(0, 6).join('\n').slice(0, 900);

    // Keyed on the message with the numbers taken out, so "лот 229" and "лот
    // 471" are one alert and not two hundred.
    const key = `client.${where}.${message.replace(/\d+/g, '#').slice(0, 80)}`;
    ops.alert(key, `Ошибка у игрока (${where})`, stack || message, {
      сообщение: message,
      игрок: String(body.user || '').slice(0, 40) || undefined,
      страница: String(body.url || '').slice(0, 120) || undefined,
      сборка: String(body.build || '').slice(0, 20) || undefined,
      браузер: String(req.headers['user-agent'] || '').slice(0, 120),
    }).catch(() => {});
  } catch (err) {
    console.error('[client-error]', err.message);
  }
});

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

  // ── after every route, and only here ──────────────────────────────────────
  // Express dispatches an error to the next error handler REGISTERED AFTER the
  // route that raised it. One installed at the top of this file would sit in
  // front of everything and catch nothing, which is the trap in wiring it the
  // way middleware is usually wired. So it goes last, inside the last mount.
  //
  // Four arguments is what makes express treat it as an error handler. Removing
  // the unused `next` silently turns it back into an ordinary one.
  app.use((err, req, res, _next) => {
    console.error(`[http] ${req.method} ${req.path}`, err);
    ops.alertError(`http.${req.method}.${req.path.split('/').slice(0, 3).join('/')}`,
      `Ошибка запроса ${req.method} ${req.path}`, err,
      { админ: (req.admin && req.admin.sub) || undefined }).catch(() => {});
    if (res.headersSent) return;
    res.status(500).json({ error: 'Ошибка сервера' });
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
    // ── how a MODE moves this player ─────────────────────────────────────
    // Every instanced mode deploys its entrants by reaching into their
    // connection: `sock.data._forceEnterLocation(floor, { pos, room })`. There
    // are fifteen of those calls across arena3, the death battle, the Tower,
    // the guild war, co-op and the elite farm — and every one is written with
    // `?.()`, so when nothing assigned this they all evaluated to undefined
    // and did nothing at all. Silently: optional call, falsy result, and each
    // caller's own "could not deploy" branch.
    //
    // The effect is not subtle. Co-op refused every entry. The 3v3 arena, the
    // death battle and the Кровавая Башня each opened a registration window,
    // took the attempt, and then deployed nobody. The guild-war window closed
    // without sending anyone home.
    //
    // forceFloor is the session's own synchronous move — it is what the modes
    // need, because they have to know where an entrant landed before they can
    // scatter the rest of the team around them.
    socket.data._forceEnterLocation = (target, opts) => s.forceFloor(target, opts);
    // And what a mode PAYS. Four more closures the modes call through
    // `sock.data`, and the rewrite assigned none of them either — see
    // server/mode-rewards.js.
    modeRewards.attach(socket, s);
    // The other half of holdOnDisconnect: the same account takes its held
    // party place under the new socket id. Without it the hold is only a
    // delayed removal, and a blip still costs the party.
    try { party.claimGrace(s.telegramId, socket.id, s.username); }
    catch (err) { console.error('[login:party]', err); }
    socket.join(`tg_${s.telegramId}`);
    // savedData is what the client rebuilds a character from — one function,
    // restoreFromSave, fed from this field and nothing else. Omitting it left
    // every returning player holding the client's own defaults: no gold, level
    // one, an empty bag. It is a PROJECTION built from the tables, in one
    // direction: nothing reads it back, and no handler accepts it.
    const savedData = await s.savedView();
    if (!savedData) {
      socket.emit('authError', { msg: 'Аккаунт недоступен — попробуйте войти снова' });
      return socket.disconnect(true);
    }
    const money = require('./db/repos/money');
    const bal = res.state.balances || await money.balancesOf(null, s.playerId);

    // ── the six fields the rewrite dropped ────────────────────────────────
    // The client destructures twelve names out of this packet. The rewrite
    // sent six of them. Every missing one has a `|| default` behind it on the
    // other side, so nothing threw and nothing logged — the panels simply drew
    // a consistent, plausible, wrong world:
    //
    //   vipData            VIP 9 rendered as VIP 0, on every single reload,
    //                      and nine unclaimed tiers shown as nothing to claim
    //   clanInfo           the clan panel empty for every member — and the
    //                      client only asks for a refresh if it ALREADY has a
    //                      clan, so nothing ever populated it
    //   refLink            the referral link blank
    //   seasonTicketActive a paid-for x2 season ticket invisible
    //   topPlayer          nobody wearing the leader's crown
    //   vipAuras           no VIP glow on anyone
    //
    // "VIP не сохраняется после перезагрузки" is this line, not the VIP code:
    // the database had level 9 the whole time (player_vip is server-written and
    // was never wrong). It just was not on the wire.
    const progression = require('./db/repos/progression');
    const clansRepo = require('./db/repos/clans');
    const vip = await progression.vipOf(null, s.playerId);
    const membership = await clansRepo.clanOf(null, s.playerId);
    const clanInfo = membership
      ? await clansRepo.dataView(null, membership.clanId, s.playerId)
      : null;
    presence.setAura(s.username, vip.level);

    socket.emit('authOk', {
      username: s.username,
      isNewAccount: res.isNew,
      savedData,
      ...res.state,
      // The client keeps these three outside the player object, in globals its
      // panels read directly.
      gramBalance: bal.gram,
      nexumBalance: bal.nexum,
      gramWallet: process.env.GRAM_WALLET || null,
      clanInfo,
      refLink: refLinkFor(s.telegramId),
      vipData: { level: vip.level, deposited: vip.deposited, pending: vip.pending },
      seasonTicketActive: !!vip.seasonTicket,
      topPlayer: presence.topPlayer(),
      vipAuras: presence.auraUsers(),
      build: version.COMMIT,
    });

    // ── the season, at login ──────────────────────────────────────────────
    // The HUD's season-ticket chip needs BOTH `seasonTicketActive` (which
    // arrives above) AND `_seasonState.active`, and the season state only
    // reached the client when it opened the Season panel. So a paid-for ticket
    // vanished on every reload and came back the moment you looked at the
    // panel and closed it — reported in exactly those words.
    //
    // Sent as its own event rather than folded into authOk because the client
    // already has a handler that merges it, and one shape is easier to keep
    // right than two.
    try {
      socket.emit('seasonState', await progression.seasonState(null, s.playerId));
    } catch (err) {
      // A missing season panel is not a reason to fail a login.
      console.error('[login] seasonState:', err.message);
    }
  }

  // The classic deep link, not a Mini App startapp one: it opens the bot's own
  // chat first, which is where the /start ref_<id> that registers the referral
  // is actually sent. Telegram requires a manual tap before that message goes
  // out — a platform anti-spam rule no code here can skip.
  function refLinkFor(telegramId) {
    const bot = process.env.TG_BOT_USERNAME || '';
    return bot ? `https://t.me/${bot}?start=ref_${telegramId}` : '';
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
    // handlers2/coop.js destructures this out of `deps` (handlers2/modes.js
    // takes it off `modes` instead — two files, two conventions). It was in
    // neither place here, so leaving a co-op run or the elite farm zone called
    // `undefined(...)` and threw: the run ended, the player stayed in the
    // instance, and the only trace was an ops alert.
    _returnToHub: (sid) => (modesRuntime ? modesRuntime._returnToHub(sid) : null),
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

  // ── leaving ───────────────────────────────────────────────────────────────
  // The rewrite's version cleared two timers and closed the session. Nothing
  // took the player OUT OF THE ROOM, and everything below follows from that:
  //
  //   the body stays on the floor    nobody is sent 'playerLeft', so every
  //                                  other client keeps drawing them
  //   the room never goes quiet      players.size never reaches zero, so
  //                                  _stopLoop never runs and every floor
  //                                  ticks at 40Hz forever
  //   monsters chase a ghost         _closestTargetFor takes any record with
  //                                  hp > 0 and a class, which a departed
  //                                  player still has. A monster near where
  //                                  somebody logged out keeps chasing that
  //                                  spot and ignores whoever is actually
  //                                  standing there
  //
  // That last one is its own answer to "монстры не реагируют", separate from
  // the packet bug, and it needed no bad luck at all: one player closing the
  // app is enough.
  //
  // The rest is the old build's own disconnect list, which was not ported: a
  // run in Страх or co-op held its lane forever, an arena match waited on
  // someone who had closed the app, and a party kept a member who was gone.
  socket.on('disconnect', async (reason) => {
    clearTimeout(authTimer);
    clearInterval(posTimer);
    // The aura roster is "who is online AND VIP", so leaving takes the glow
    // with it — otherwise it accumulates every VIP who has ever logged in.
    if (s.username) presence.clearAura(s.username);

    const m = modesRuntime;
    if (m) {
      try {
        // fearGrace: a blip is not a decision. Страх and co-op hold the run
        // for a reconnect; the competitive modes eliminate immediately,
        // because a shared match cannot wait on one person's tunnel.
        m._pvpEliminate(socket.id, undefined, s.room, {
          fearGrace: true, telegramId: s.telegramId,
        });
        if (m._farm2EjectOnDisconnect) m._farm2EjectOnDisconnect(socket.id);
        // The pre-run lobbies get no grace, deliberately: they are a queue,
        // and a queue that holds places for absent people stops filling.
        if (m._coopGroupDropOnDisconnect) m._coopGroupDropOnDisconnect(socket.id);
        if (m._farm2GroupDropOnDisconnect) m._farm2GroupDropOnDisconnect(socket.id);
      } catch (err) {
        console.error('[disconnect:modes]', err);
      }
    }
    // Held rather than dissolved: 45 seconds, the same reasoning as the run
    // grace above. claimGrace in finishLogin takes the place back.
    try { party.holdOnDisconnect(socket.id, s.telegramId); }
    catch (err) { console.error('[disconnect:party]', err); }

    if (s.room) {
      // Told BEFORE removed, so the id is still meaningful to whoever hears it.
      socket.to(`floor_${s.floor}`).emit('playerLeft', { id: socket.id });
      try { s.room.removePlayer(socket.id); }
      catch (err) { console.error('[disconnect:room]', err); }
    }

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

  // 2d. The rating leader's crown and the VIP auras. Both are broadcasts about
  //     OTHER players, so they need io and nothing else.
  presence.init(io);
  party.init(io, {
    onLeave: (socketId) => {
      // Leaving a party ends the co-op and farm runs that party was on: both
      // modes are gated on the party existing.
      modesRuntime._coopEliminate(socketId);
      if (modesRuntime._farm2Eliminate) modesRuntime._farm2Eliminate(socketId);
    },
  });
  if (modesRuntime._gwRestore) await modesRuntime._gwRestore();

  // ── the castle itself ────────────────────────────────────────────────────
  // Room.spawnGuildWarTower has existed the whole time and NOTHING has ever
  // called it. The old build spawned it while building the floor's Room
  // (`if (f === FLOOR_IDS.guildWar) room.spawnGuildWarTower(_gw)`); the
  // rewrite moved room creation into world.initFloors and left this behind.
  //
  // So the Guild War zone opened on schedule, players walked in, and there was
  // nothing there to fight over — "замка в битвах гільдій нема", "башни нету
  // короче". The whole mode is a fight for one structure, and the structure
  // was never placed.
  //
  // AFTER _gwRestore, so the tower is handed the owner that survived the
  // restart instead of standing unclaimed every time the process starts.
  const gwRoom = world.roomOf(world.FLOOR_IDS.guildWar);
  if (gwRoom && gwRoom.spawnGuildWarTower && modesRuntime._gw) {
    const tower = gwRoom.spawnGuildWarTower(modesRuntime._gw);
    console.log(`guild war: замок ${tower ? 'на месте' : 'НЕ создан'}`
      + `${tower && tower.ownerClanName ? ` · владеет «${tower.ownerClanName}»` : ' · ничей'}`);
  } else {
    console.error('[boot] замок Войны гильдий не создан — комната или режим недоступны');
  }

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
  console.log(`listening on ${PORT} · build ${version.COMMIT}`);
  await ops.send('alerts',
    `🟢 <b>Сервер запущен</b> · порт ${PORT} · сборка <code>${version.COMMIT}</code> · каталог ${synced.synced} предметов`);
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

  // Whatever is still queued goes out before the pool closes. The buffer is
  // what makes logging cheap; flushing here is what keeps an ordinary restart
  // from losing the last two seconds of it.
  await plog.flush().catch(() => {});

  await db.close();
  console.log('shutdown complete');
  if (exit) process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ── the last net ────────────────────────────────────────────────────────────
// Both of these existed in the build this replaces and neither was carried
// over, which is why "в баг-алерт не прилетает ничего" was partly true even
// when everything else was configured correctly: a promise that rejects with
// nobody awaiting it, or a throw from inside a timer, produced a line in the
// journal at best and nothing at all at worst. Neither is something anybody
// watches. Now every one of them is a message in the group.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  ops.alertError('unhandled.rejection', 'Необработанная ошибка (promise)', reason, {
    build: version.COMMIT,
  }).catch(() => {});
});

// An uncaught exception leaves the process in an undefined state — node's own
// documentation is explicit that resuming is not safe. So it is reported and
// then the process ends, which systemd turns into a restart three seconds
// later. The ALERT IS AWAITED before exiting: exiting first is how a crash
// report gets lost, and the crash is precisely the thing worth knowing about.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  ops.alertError('fatal.uncaught', 'Сервер упал — процесс перезапускается', err, {
    build: version.COMMIT, uptimeS: Math.round(process.uptime()),
  }).catch(() => {}).finally(() => process.exit(1));
  // A hard ceiling in case the alert itself hangs: the group message is worth
  // waiting for, but not worth staying down for.
  setTimeout(() => process.exit(1), 5000).unref();
});

// Telegram's API, the TON API and the database all reach the network. A
// warning node raises about a leaking listener or a deprecated call is the
// early form of a bug that shows up later as a freeze.
process.on('warning', (w) => {
  if (w.name === 'MaxListenersExceededWarning' || w.name === 'DeprecationWarning') {
    ops.alert(`node.warning.${w.name}`, `Предупреждение Node: ${w.name}`, w.message).catch(() => {});
  }
});

if (require.main === module) {
  boot().catch(err => {
    console.error('[boot] failed:', err);
    ops.alertError('boot', 'Сервер НЕ запустился', err).finally(() => process.exit(1));
  });
}

module.exports = { app, server, io, boot, shutdown };
