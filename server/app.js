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

const http = require('http');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const { Server } = require('socket.io');

const db = require('./db');
const items = require('./db/repos/items');
const players = require('./db/repos/players');
const plog = require('./db/repos/playerlog');
const bossstate = require('./db/repos/bossstate');
// The built bundle — required here only for its content hash, which is what
// tells a connected client whether the code it is running is still current.
const assets = require('./assets');
const ops = require('./tg-ops');
const workers = require('./workers');
const adminAuth = require('./admin-auth');
// The game bot's own updates. Required at the top rather than at the mount
// below because /health reports its counters and /health is defined above it.
const tgWebhook = require('./routes/tg-webhook');
// socketForTelegramId is no longer imported here: the deposit push was its
// last caller and now addresses the `tg_<id>` ROOM instead — see notifyCredited
// below for why. It is still exported by session.js and still used through
// modes.js's _socketForTelegramId.
const { Session, activeSessions, sessionClaims } = require('./session');
const world = require('./world');
const version = require('./version');
const party = require('./party');
const modesLib = require('./modes');
const maintenance = require('./maintenance');
const presence = require('./presence');
const modeRewards = require('./mode-rewards');
let modesRuntime = null;
const { verifyTelegramWebApp, verifyTelegramAuth, _safeUsername, refLink } = require('./security');

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
    // The single-session rule, which used to fire in total silence. `takeovers`
    // is a live client closed in favour of another; `reclaims` is the same
    // client coming back after a drop and is expected to be much the larger of
    // the two. If it is not — if takeovers tracks reconnects — the rule is
    // throwing people out for a blip, and this is the only place that would
    // say so before the reports arrive.
    sessionClaims: { ...sessionClaims },
    workers: workers.status(),
    ops: ops.status(),
    // The player log: how many rows are queued, written, and lost. An empty
    // player_logs table looked exactly like a quiet server until this existed.
    playerLog: plog.stats(),
    // What the socket rate limiter threw away, and how many failed Telegram
    // checks there have been. Both used to happen entirely in silence, and both
    // are the kind of number that only means anything when you can see it
    // BEFORE somebody complains: a limiter that is too tight looks like a
    // working game, and a hash-guessing burst looks like nothing at all.
    rateLimit: { ...rlStats },
    authFails: { total: _authFail.total, lastMinute: _authFail.n },
    // The bot's webhook: what arrived, what was dropped as a retry, what was
    // refused. `badSecret` is the one nobody would think to ask for until it
    // mattered — the URL is public, and anything reaching that counter is not
    // Telegram.
    tgWebhook: tgWebhook.status(),
    // How the write-access gate is going. `shown` minus (granted + refused) is
    // the players who closed the app rather than answering — see _waGate. A
    // non-zero `notStored` means migration 013 has not been applied yet and
    // every grant is being forgotten.
    writeAccess: { ..._waGate },
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

// ── the bot's own /start ────────────────────────────────────────────────────
// Here, at module scope, and NOT inside boot(): the error handler is registered
// at the end of mountAdmin, and express only dispatches an error to a handler
// registered AFTER the route that raised it. A route mounted during boot would
// sit past it, and its faults would go nowhere at all.
tgWebhook.mount(app, { io });

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
//
// EVERY NAME HERE MUST BE A REGISTERED HANDLER. Two of them were not:
// 'balanceHistory' names nothing in either build, and 'craft' was split into
// craftGear/craftClassGear/craftBox/craftPet/craftMatUpgrade long before this
// list was copied across. A stale name is not inert — it looks like coverage.
// The forge and the pet crafter, which spend Liberty and destroy materials,
// were sitting in the 1500-per-5s bucket the whole time while the list read
// as though crafting were protected. dev/protocol-check.js now fails on a
// name in here that no safeOn registers, so this cannot rot again quietly.
const HEAVY = new Set([
  'marketBrowse', 'marketMyListings', 'marketHistory', 'marketList', 'marketBuy', 'marketCancel',
  'gramGetHistory', 'gramDepositRequest', 'gramWithdrawRequest', 'gramShopBuy',
  'craftGear', 'craftClassGear', 'craftBox', 'craftPet', 'craftMatUpgrade', 'craftAdvSkillBook',
  'enhanceItem', 'openLootBox', 'buyPotion', 'sellItem',
  'buyTeleportStone', 'useTeleportStone',
  'equipItem', 'unequipItem', 'storageDeposit', 'storageWithdraw',
  'registerCodexSetItem', 'codexSync', 'spendUpgrade', 'usePotion', 'useBuffPotion',
  'learnSkill', 'upgradeSkill', 'learnPassive', 'upgradePassive', 'learnAdvSkill',
  'toggleAdvSkill', 'claimQuest', 'completeSpecialQuest', 'claimVipRewards', 'vipSync',
  'seasonRating', 'seasonSync', 'seasonBurn', 'seasonBurnAll', 'seasonBurnBook',
  'rebirth', 'resetUpgrades', 'getRating', 'starterBonusClaim',
  'clanCreate', 'clanApply', 'clanApprove', 'clanDecline', 'clanKick', 'clanLeave',
  'clanDisband', 'clanSetDescription', 'clanSearch', 'clanRequest',
  'clanStorageDeposit', 'clanStorageGive', 'clanStorageClaim', 'clanStorageCancel',
  'clanStorageUnlock', 'clanStorageSync',
  'chat', 'chatHistory', 'clanChat', 'clanChatHistory', 'privMsg', 'privMsgHistory',
  'requestPlayerProfile', 'getPvpHistory', 'getReferrals', 'savePrefs',
  'selectChar', 'enterLocation', 'respawn',
  // Two or three packets per login (gate shown, then the answer), and each
  // answer writes to `players`. The tight bucket costs a real client nothing
  // and stops a scripted one from turning the gate into an UPDATE loop.
  'writeAccess',
  // NOT here on purpose: mv, playerMove, attack, skillAttack, enemyResync.
  // Those arrive per frame and belong in the loose bucket — the tight one
  // would throttle ordinary play, which is a worse outcome than the flood it
  // would prevent. enemyResync has its own, much tighter bound inside the
  // handler (40 records per call) because it is cheap to ask for and
  // expensive to answer.
  //
  // pickupWorldDrop is the same case and is easy to mistake for a button: it
  // is emitted from the frame loop (js/game.js), once per pile within reach
  // every 2s, so walking through the event boss's loot field is a burst the
  // player never asked for. It transacts, but the tight bucket would refuse
  // the loot they are standing on.
  //
  // craftStone is absent because it costs nothing — it only answers "камни
  // заточки больше не создаются" and touches neither database nor catalog.
]);

// ── how a dropped packet reaches the player ─────────────────────────────────
// A refusal has to come back on the channel the CLIENT is listening to for THAT
// action, or it is not a refusal — it is a second silence. The market panel
// re-enables its buy button from 'marketError', the forge from 'enhanceError',
// the merchant from 'goldError'; a new event of our own would be handled by
// none of them and would leave every one of those buttons exactly as stuck as
// the bare `return` left it.
//
// Grouped by channel because that is how the client is written (js/network.js),
// and flattened once at load. Anything not named here answers on 'itemError'.
//
// The channel is the one the handler's OWN refusal uses (session.act's second
// argument), so a throttled action and a refused one reach the same panel.
// Where they disagreed the limiter's answer went to 'itemError' — the right
// shape on the wire, addressed to a panel that was not listening: the forge,
// the season altar, the rating table and the portal all had their limiter
// refusal delivered somewhere the player was not looking.
const RL_ERR_EVENT = new Map();
for (const [channel, events] of Object.entries({
  marketError: ['marketBrowse', 'marketMyListings', 'marketHistory', 'marketBuy', 'marketCancel'],
  marketListError: ['marketList'],
  gramError: ['gramGetHistory', 'gramDepositRequest', 'gramWithdrawRequest', 'getReferrals'],
  gramShopError: ['claimVipRewards', 'vipSync', 'gramShopBuy'],
  craftAdvSkillBookError: ['craftAdvSkillBook'],
  craftGearError: ['craftGear'],
  craftClassGearError: ['craftClassGear'],
  craftBoxError: ['craftBox'],
  craftMatUpgradeError: ['craftMatUpgrade'],
  petCraftError: ['craftPet'],
  teleportStoneError: ['buyTeleportStone'],
  enhanceError: ['enhanceItem'],
  openBoxError: ['openLootBox'],
  goldError: ['buyPotion'],
  sellItemError: ['sellItem'],
  progressError: ['learnSkill', 'upgradeSkill', 'learnPassive', 'upgradePassive',
    'learnAdvSkill', 'toggleAdvSkill'],
  questClaimError: ['claimQuest', 'completeSpecialQuest'],
  seasonError: ['seasonRating', 'seasonSync'],
  seasonBurnError: ['seasonBurn', 'seasonBurnAll', 'seasonBurnBook'],
  starterBonusError: ['starterBonusClaim'],
  rebirthError: ['rebirth'],
  resetUpgradesError: ['resetUpgrades'],
  ratingError: ['getRating'],
  locationError: ['enterLocation'],
  prefsError: ['savePrefs'],
  profileError: ['requestPlayerProfile', 'getPvpHistory'],
  clanError: ['clanCreate', 'clanApply', 'clanApprove', 'clanDecline', 'clanKick', 'clanLeave',
    'clanDisband', 'clanSetDescription', 'clanSearch', 'clanRequest',
    'clanStorageDeposit', 'clanStorageGive', 'clanStorageClaim', 'clanStorageCancel',
    'clanStorageUnlock'],
  clanStorageError: ['clanStorageSync'],
  chatError: ['chat', 'chatHistory', 'clanChat', 'clanChatHistory'],
  privMsgError: ['privMsg', 'privMsgHistory'],
  authError: ['selectChar'],
})) for (const ev of events) RL_ERR_EVENT.set(ev, channel);

// ── what the limiter threw away ─────────────────────────────────────────────
// Process-wide, for /health. "Сколько пакетов мы выбросили" had no answer
// anywhere in this process, so a limiter that was too tight and a game that was
// working were the same observation.
const rlStats = { dropped: 0, bursts: 0, sockets: 0, lastEvent: null, lastAt: null };

// ── a login that fails is a login somebody TRIED ────────────────────────────
// Both Telegram paths used to answer a failed check with an authError to the
// client and nothing else: no console line, no counter, no alert. So a burst of
// forged initData — the exact thing the hash check exists to stop — was
// undetectable from inside the server, while the admin panel's own bad-login
// path (admin.badlogin, routes/admin2.js) has alerted since the first day.
//
// Counted across connections, not per socket, because that is where the signal
// is: one client retrying with a stale Mini App session is noise, two hundred
// attempts a minute is somebody trying hashes.
const _authFail = { total: 0, at: 0, n: 0 };
const AUTH_FAIL_WINDOW_MS = 60000;
const AUTH_FAIL_ALERT = Number(process.env.AUTH_FAIL_ALERT || 20);

function authCheckFailed(socket, kind) {
  const now = Date.now();
  _authFail.total++;
  if (now - _authFail.at > AUTH_FAIL_WINDOW_MS) { _authFail.at = now; _authFail.n = 0; }
  _authFail.n++;

  const h = socket.handshake || {};
  const ip = String((h.headers && h.headers['x-forwarded-for']) || h.address || '?')
    .split(',')[0].trim().slice(0, 45);
  console.error(`[auth] проверка Telegram не пройдена (${kind}) · ip ${ip} · за минуту ${_authFail.n} · всего ${_authFail.total}`);

  // The RATE, not the event. A single failure is an expired session and alerting
  // on it would train everyone to ignore this. Past the threshold every further
  // failure re-raises the same key, and ops.alert's own throttle collapses them
  // into one message plus a count — which is what makes "sustained" readable.
  if (_authFail.n >= AUTH_FAIL_ALERT) {
    ops.alert('auth.telegram.fail', 'Много неудачных проверок Telegram',
      `${_authFail.n} за минуту (всего с запуска: ${_authFail.total})`,
      { канал: kind, ip }).catch(() => {});
  }
  socket.emit('authError', { msg: 'Проверка Telegram не пройдена' });
}

// ── the write-access gate, as a number ──────────────────────────────────────
// A player who refuses to let the bot DM them does not get into the game (see
// _waShowGate in js/network.js). That is the owner's decision and it is not
// free: every refusal is an install that bounced off the front door. If most
// people refuse, they need to know THIS WEEK, not from a month of flat
// retention that looks like a hundred other things.
//
// player_logs carries every outcome per player and is the per-account answer;
// players.write_access_at is the standing total that outlives log retention.
// This is neither — it is the live rate, for /health, so the question can be
// asked of a running server without opening a psql session.
//
// `shown` is reported by the client when the gate goes up and is therefore
// bigger than granted + refused: the difference is people who closed the app
// rather than answering, which is its own kind of refusal and is worth being
// able to see separately.
const _waGate = { shown: 0, granted: 0, refused: 0, notStored: 0, told: 0 };
// The rate is only meaningful once there is a rate. Under this many answers a
// single refusal is 100% and would alert on nothing at all.
const WA_MIN_SAMPLE = Number(process.env.WA_MIN_SAMPLE || 20);
const WA_REFUSE_ALERT_PCT = Number(process.env.WA_REFUSE_ALERT_PCT || 40);

function _waRecord(outcome) {
  if (outcome === 'shown') { _waGate.shown++; return; }
  if (outcome === 'granted') _waGate.granted++; else _waGate.refused++;
  const answered = _waGate.granted + _waGate.refused;
  const pct = Math.round((_waGate.refused / answered) * 100);
  // The RATE, not the event — the same rule authCheckFailed follows above, and
  // for the same reason: one refusal is a person changing their mind, and an
  // alert for it teaches everyone to ignore this key. Re-raised on every
  // further answer past the threshold; ops.alert's own throttle collapses the
  // repeats into one message plus a count.
  if (answered >= WA_MIN_SAMPLE && pct >= WA_REFUSE_ALERT_PCT) {
    _waGate.told++;
    ops.alert('writeAccess.refused', 'Игроки отказываются пускать бота в личку',
      `${pct}% отказов — ${_waGate.refused} из ${answered} ответивших. ` +
      `Отказ = игрок не попал в игру.`,
      { показан: _waGate.shown, разрешили: _waGate.granted, отказались: _waGate.refused })
      .catch(() => {});
  }
}

io.on('connection', (socket) => {
  const s = new Session(socket, io);

  // ── which build this server is ───────────────────────────────────────────
  // Sent before anything else, on every connection including a reconnect. A
  // deploy restarts the process, every client reconnects within seconds, and
  // this is the moment each of them learns its bundle is stale.
  //
  // It matters beyond tidiness: a client running an older bundle is a client
  // whose idea of the protocol may differ from the server's, and that is
  // exactly the sort of mismatch that turns into "какой-то бред в игре".
  socket.emit('serverBuild', { build: assets.jsBundleHash });

  const rl = { heavy: { n: 0, at: 0 }, fast: { n: 0, at: 0 } };
  const bump = (b, max) => {
    const now = Date.now();
    if (now > b.at) { b.n = 0; b.at = now + 5000; }
    return ++b.n <= max;
  };
  // ── a dropped packet is a button that does nothing ───────────────────────
  // This used to be `if (!ok) return;` — no next(), no log, no counter, no
  // alert, nothing to the client. HEAVY holds marketBuy, marketCancel,
  // sellItem, enhanceItem, clanStorageClaim, storageDeposit and equipItem, and
  // 40 of them in five seconds is reachable by ordinary spam-clicking. So a
  // player hit the ceiling on the actions that MOVE VALUE and got a button that
  // had simply stopped responding, and nobody could tell them why: the packet
  // never reached a handler, so session.act never saw it and player_logs has
  // nothing. This is the same hole session.js:210 closed one layer down,
  // reproduced above it.
  //
  // ONE TRACE PER BURST. A spam-click is dozens of packets a second and a row
  // for each would bury the log this is supposed to fill — so the first drop
  // reports itself and everything for the next window is counted and carried
  // into the following report. Nothing is discarded: the remainder is flushed
  // on disconnect.
  const RL_REPORT_MS = 5000;                     // one bucket window
  const rlDrop = { n: 0, at: 0, ev: null, counted: false };

  function rlReport(ev, n) {
    rlStats.bursts++;
    rlStats.lastEvent = ev || null;
    rlStats.lastAt = new Date().toISOString();
    // s.playerId is null before login, and plog.log drops a row with no player
    // — an unauthenticated flood is still counted in rlStats and still refused,
    // it just has no account to hang a row on.
    plog.log(s.playerId, 'ratelimit', {
      ev: String(ev || '?').slice(0, 60),
      bucket: HEAVY.has(ev) ? 'heavy' : 'fast',
      dropped: n,
    });
  }

  socket.use((packet, next) => {
    const ev = packet && packet[0];
    const ok = HEAVY.has(ev) ? bump(rl.heavy, 40) : bump(rl.fast, 1500);
    if (!ok) {
      rlDrop.n++;
      rlDrop.ev = ev;
      rlStats.dropped++;
      if (!rlDrop.counted) { rlDrop.counted = true; rlStats.sockets++; }
      const now = Date.now();
      if (now - rlDrop.at >= RL_REPORT_MS) {
        rlDrop.at = now;
        rlReport(ev, rlDrop.n);
        rlDrop.n = 0;
        // On the channel this action's own panel listens to, so the button it
        // disabled comes back and says why. Emitted through a variable
        // deliberately: every name in RL_ERR_EVENT is already handled by the
        // client, and this is a refusal for an existing action rather than a
        // new event in the protocol.
        socket.emit(RL_ERR_EVENT.get(ev) || 'itemError',
          { msg: 'Слишком часто — подождите пару секунд', code: 'rate_limit' });
      }
      return;
    }
    next();
  });

  // safeOn keeps a throwing handler from reaching process scope, where the
  // uncaughtException handler would take every player's connection down over
  // one bad packet. s.act() already catches inside a transaction; this is the
  // backstop for everything outside one.
  const errAt = new Map();     // event -> { at, n, timer } — n is what logErr hid
  function safeOn(event, handler) {
    socket.on(event, (...args) => {
      if (args.length && args[0] === null) args[0] = undefined;
      try {
        const r = handler(...args);
        if (r && typeof r.catch === 'function') r.catch(e => logErr(event, e));
      } catch (e) { logErr(event, e); }
    });
  }
  // ── what the throttle swallowed ──────────────────────────────────────────
  // This was `if (now - (errAt.get(event) || 0) < 5000) return;` — one error
  // reported and then five seconds of silence that looks exactly like five
  // seconds of nothing going wrong. A handler failing on every packet reported
  // roughly one in a hundred, and nothing anywhere said so, so the alerts topic
  // showed a single incident where there had been thousands.
  //
  // tg-ops has _sweepAlerts for precisely this — an alert that fired four times
  // reported three and lost the fourth — and this path had no equivalent. Now
  // the window CLOSES with a number rather than merely stopping: the count is
  // carried into the next report, and if the burst ends inside the window a
  // one-shot timer says what was hidden.
  const ERR_WINDOW_MS = 5000;
  function logErr(event, err) {
    const now = Date.now();
    const st = errAt.get(event);
    if (st && now - st.at < ERR_WINDOW_MS) {
      st.n++;                                  // console.error is sync I/O
      if (!st.timer) {
        st.timer = setTimeout(() => flushErrWindow(event), ERR_WINDOW_MS - (now - st.at) + 50);
        // Never the reason a process stays alive, and never the reason a
        // disconnected socket keeps one open.
        if (st.timer.unref) st.timer.unref();
      }
      return;
    }
    const swallowed = st ? st.n : 0;
    if (st && st.timer) clearTimeout(st.timer);
    errAt.set(event, { at: now, n: 0, timer: null });
    console.error(`[socket:${event}]${swallowed ? ` (+${swallowed} подавлено за прошлое окно)` : ''}`, err);
    ops.alertError(`socket.${event}`, `Ошибка в обработчике ${event}`, err,
      swallowed ? { подавлено: swallowed } : {});
  }

  function flushErrWindow(event) {
    const st = errAt.get(event);
    if (!st) return;
    st.timer = null;
    if (!st.n) return;
    const n = st.n;
    st.n = 0;
    console.error(`[socket:${event}] подавлено ${n} повторов за ${ERR_WINDOW_MS}мс`);
    ops.alert(`socket.${event}.suppressed`, `Ошибка в обработчике ${event} повторялась`,
      `подавлено ${n} повторов за ${Math.round(ERR_WINDOW_MS / 1000)}с`).catch(() => {});
  }

  // ── auth ──────────────────────────────────────────────────────────────────
  // A connection that does not authenticate within the window is closed. The
  // socket costs memory and a slot; an anonymous one that never logs in is
  // either a scanner or a broken client.
  const authTimer = setTimeout(() => { if (!s.authed) socket.disconnect(true); }, 20000);

  async function finishLogin(telegramId, username, startParam = '') {
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

    // ── has this account already let the bot write to it ─────────────────
    // The client cannot answer this on its own. `allows_write_to_pm` is frozen
    // into initData at launch, so a player who granted access last session is
    // reported as not having granted it until Telegram refreshes the payload —
    // and would be shown the gate again on every launch. This is the
    // remembered answer (migration 013), and it is what stops the prompt from
    // becoming a thing players see forever.
    //
    // Behind its own catch: a login that fails because a PERMISSION FLAG could
    // not be read is a player who cannot play, over a field whose worst case is
    // one extra prompt. Same rule as the season and referral blocks below.
    let canMessage = false;
    try {
      canMessage = await players.canMessage(null, s.playerId);
    } catch (err) {
      console.error('[login] canMessage:', err.message);
    }

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
      refLink: refLink(s.telegramId),
      vipData: { level: vip.level, deposited: vip.deposited, pending: vip.pending },
      seasonTicketActive: !!vip.seasonTicket,
      topPlayer: presence.topPlayer(),
      vipAuras: presence.auraUsers(),
      // Whether the write-access gate has anything to ask. The client ORs this
      // with initData's own allows_write_to_pm — see _waShouldGate in
      // js/network.js — so either source saying yes is enough.
      canMessage,
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

    // ── who invited this player ──────────────────────────────────────────
    // LAST, and behind its own catch, for the same reason as the season block
    // above: a referral is a bonus attached to a login, and a login that fails
    // because a bonus could not be recorded is a player who cannot play at
    // all. Outside s.login()'s transaction for the same reason — PostgreSQL
    // refuses every statement after one that raised until the transaction is
    // rolled back, so a fault here could not be caught and shrugged off in
    // there: it would take the account creation down with it.
    //
    // start_param is how a referral reaches the MINI APP: the ?startapp= link
    // refLink() builds (server/security.js) opens the game directly and
    // Telegram signs the parameter into initData. Attempted on EVERY login
    // carrying it, not only a new account — the repo refuses a second referrer
    // itself, and a player who followed a link before their first launch would
    // otherwise be the one case that never worked.
    //
    // A login carrying nothing may still have one waiting. The classic
    // t.me/<bot>?start=ref_<id> link opens the BOT'S chat, and at the moment
    // that /start arrives the person usually has no account at all — so the
    // webhook remembers the referrer rather than creating a half-account for
    // them, and this is where it is redeemed (the reasoning for not creating
    // the row there is written out in server/routes/tg-webhook.js). Through
    // the same registerReferral below, deliberately: a referral that came by
    // bot and one that came by Mini App must leave the same rows behind.
    const sp = String(startParam || '');
    const ref = sp.startsWith('ref_') ? sp.slice(4) : tgWebhook.takePendingRef(s.telegramId);
    if (ref) await registerReferral(ref);
  }

  // Every outcome leaves a row in player_logs: a registration under
  // 'referralRegistered', a refusal under 'refuse:referralRegistered' with the
  // reason and the id that was refused — the same shape session.act() writes
  // for a refused action, so both read the same way in the admin panel. A
  // referral that did not take is precisely what operators get asked about,
  // and until this existed the only available answer was that nothing anywhere
  // had recorded the attempt.
  async function registerReferral(refId) {
    try {
      const res = await players.registerReferral(null, s.playerId, refId);
      if (!res.ok) {
        plog.log(s.playerId, 'refuse:referralRegistered',
          { code: res.reason, msg: res.msg, refId: res.refId });
        return;
      }
      plog.log(s.playerId, 'referralRegistered',
        { refId: res.refId, referrerId: res.referrerId, referrer: res.referrerUsername });
      // The referrer is a different session and may be offline entirely. The
      // room emit reaches every device they have open and is dropped when
      // there are none — the referral itself is committed either way. Same
      // shape as the season referral bonus in handlers2/world.js.
      io.to(`tg_${res.refId}`).emit('friendJoined', { username: s.username });
    } catch (err) {
      // Not silent. This is the one path where a referral is lost to a fault
      // rather than to a rule, and it is invisible from both sides: the
      // invited player is never told a referral was attempted, and the
      // referrer is simply never paid.
      console.error('[login:referral]', err);
      ops.alertError('login.referral', 'Не удалось записать реферала', err, {
        player: s.username, telegramId: s.telegramId,
        пригласил: String(refId).slice(0, 64),
      }).catch(() => {});
    }
  }

  // Both failures go through authCheckFailed (top of this file), which counts
  // them, writes a console line and alerts on a sustained rate. They used to
  // emit to the client and leave nothing behind at all.
  safeOn('loginTelegramWebApp', async ({ initData } = {}) => {
    const v = verifyTelegramWebApp(String(initData || ''));
    if (!v || !v.user) return authCheckFailed(socket, 'miniapp');
    // startParam was verified alongside the user and then dropped on the
    // floor here, which is where the whole referral feature ended.
    await finishLogin(v.user.id, v.user.username || v.user.first_name, v.startParam || '');
  });

  safeOn('loginTelegram', async (data = {}) => {
    if (!verifyTelegramAuth(data)) return authCheckFailed(socket, 'widget');
    await finishLogin(data.id, data.username || data.first_name);
  });

  // ── "разреши боту писать тебе" ────────────────────────────────────────────
  // What the client reports about the write-access gate. Three messages, all on
  // one event because they are three states of one question:
  //
  //   { shown: true }      the gate is on screen — the player is being asked
  //   { granted: true }    Telegram's requestWriteAccess called back with true
  //   { granted: false }   they refused, or the 30s timeout expired
  //
  // THE CLIENT IS THE ONLY POSSIBLE SOURCE, and that is not a hole somebody
  // forgot to close: Telegram delivers the answer to requestWriteAccess's
  // callback in the Mini App and offers no API to ask afterwards. So a player
  // who lies and claims a grant they did not give buys themselves exactly one
  // thing — a bot that cannot DM them, which is where they already were. There
  // is nothing here worth forging.
  //
  // It lives beside the login handlers rather than in handlers2 because it is
  // part of getting in: it fires between authOk and the character select,
  // before the player exists as a character at all.
  safeOn('writeAccess', async ({ granted, shown } = {}) => {
    if (!s.authed) return;
    if (shown) {
      _waRecord('shown');
      // The row that says the player was ASKED. Without it a player who closed
      // the app on the gate leaves no trace anywhere — not in players
      // (write_access_at is only written by an answer) and not here — and
      // "почему я не могу зайти" has no evidence behind it at all.
      plog.log(s.playerId, 'writeAccessShown', null);
      return;
    }
    if (granted) {
      _waRecord('granted');
      // Not through s.act: this is not a game action, it takes no transaction
      // worth the name, and a failure must NOT emit an error channel the gate
      // would have to handle — the player has already been let in by the time
      // this lands. Failures are reported, not shown.
      let stored = false;
      try {
        ({ stored } = await players.setWriteAccess(null, s.playerId, true));
      } catch (err) {
        console.error('[writeAccess] запись:', err.message);
        ops.alertError('writeAccess.store', 'Не записано разрешение на личку', err,
          { игрок: s.username, telegramId: s.telegramId }).catch(() => {});
      }
      // A grant that was not stored is a grant the player will be asked for
      // again next launch. It is the expected state in the window between this
      // code deploying and migration 013 being applied by hand — so it is
      // counted and logged rather than alerted, and the count is what says
      // whether that window is still open.
      if (!stored) _waGate.notStored++;
      plog.log(s.playerId, 'writeAccessGranted', { stored });
      return;
    }
    _waRecord('refused');
    // `refuse:` — the same prefix session.act writes for a refused action, so a
    // player who was turned away at the door reads the same way in the admin
    // panel as one who was refused a purchase. This is the row somebody looks
    // for when a player says the game will not let them in, and before it
    // existed the honest answer would have been "не знаю".
    plog.log(s.playerId, 'refuse:writeAccess',
      { code: 'write_access_denied', msg: 'Игрок не разрешил боту писать в личку' });
    // The refusal is recorded on the account too, so "asked and said no" stops
    // being indistinguishable from "never asked" the moment the app is closed
    // and the log partition ages out. can_message is NOT cleared — see
    // repos/players.setWriteAccess.
    try {
      await players.setWriteAccess(null, s.playerId, false);
    } catch (err) {
      console.error('[writeAccess] отказ:', err.message);
    }
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

  // ── a client-side failure, reported over the socket ──────────────────────
  // /client-error (the HTTP endpoint above) still exists and still has to: it
  // is the only way to hear about a failure that happens before a connection,
  // or instead of one. But it identifies the player from a name the PAGE put
  // in a JSON body — and for the whole life of that endpoint the client filled
  // that field with `window.state.username`, where `state` is a script-scope
  // `let` holding the string 'playing'. Every report ever received arrived
  // with an empty player. Nobody could look up who anything happened to.
  //
  // Here the player is the SESSION's. Nothing in the payload says who this is,
  // so nothing in the payload can lie about it — and it lands in player_logs,
  // where it can be queried after the fact instead of scrolling back through a
  // Telegram topic.
  let _cerrN = 0, _cerrAt = 0;
  safeOn('clientError', ({ where, message, stack } = {}) => {
    const now = Date.now();
    if (now - _cerrAt > 60000) { _cerrAt = now; _cerrN = 0; }
    if (++_cerrN > 10) return;               // a looping client is one problem
    const w = String(where || 'client').slice(0, 60);
    const msg = String(message || '').slice(0, 400);
    if (!msg) return;
    const st = String(stack || '').split('\n').slice(0, 6).join('\n').slice(0, 900);
    const ua = String(socket.handshake.headers['user-agent'] || '').slice(0, 160);
    plog.log(s.playerId, 'client:' + w, { msg, stack: st || undefined, ua });
    ops.alert(`client.${w}.${msg.replace(/\d+/g, '#').slice(0, 80)}`,
      `Ошибка у игрока (${w})`, st || msg, {
        сообщение: msg,
        игрок: s.username || String(s.playerId || '?'),
        сборка: version.COMMIT,
        браузер: ua,
      }).catch(() => {});
  });

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
    // The tail of both throttles. A burst that ends without reaching the next
    // report window would otherwise take its own count away with it, which is
    // the failure both of them exist to stop.
    if (rlDrop.n) { rlReport(rlDrop.ev, rlDrop.n); rlDrop.n = 0; }
    for (const [event, st] of errAt) {
      if (st.timer) { clearTimeout(st.timer); st.timer = null; }
      if (st.n) flushErrWindow(event);
    }
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

    // Told BEFORE removed, so the id is still meaningful to whoever hears it.
    if (s.room) socket.to(`floor_${s.floor}`).emit('playerLeft', { id: socket.id });

    // ── close() FIRST, and the room reference kept ──────────────────────────
    // close() flushes the player's position and HP, and it reads them out of
    // the room: savePosition does `this.room.players.get(this.socket.id)` and
    // returns at `if (!p)`. removePlayer used to run one line above it, so `p`
    // was ALWAYS undefined here and the disconnect flush this path exists for
    // has never written a single row. The periodic timer covered it well
    // enough that nobody noticed — the cost was up to one timer period of
    // movement and HP lost on every logout.
    //
    // The reference is captured because close() ends by setting this.room to
    // null. Reading s.room after it — which is what the old order allowed —
    // would now skip removePlayer entirely and leave the player standing in
    // the floor forever, which is a worse bug than the one being fixed.
    const room = s.room;
    try { await s.close(reason); } catch (e) { console.error('[disconnect]', e); }

    if (room) {
      try { room.removePlayer(socket.id); }
      catch (err) { console.error('[disconnect:room]', err); }
    }
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
  // Per-arm boss respawn deadlines, so a restart does not hand every boss back
  // at once. Read before the rooms exist, because Room restores each timer in
  // its constructor; written on every boss death, fire-and-forget.
  const bossStates = await bossstate.loadAll();
  const restored = Object.values(bossStates).reduce((n, m) => n + Object.keys(m).length, 0);
  const floors = world.initFloors(io, bossstate.save, bossStates);
  console.log(`world: ${floors} floors` + (restored ? `, восстановлено таймеров боссов: ${restored}` : ''));

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
    // Whether the castle may be fought over at all. A Room knows geometry and
    // combat and deliberately nothing about the clock, so the question is
    // handed in — without it the castle could be brought down and captured any
    // hour of any day, with the event not running and nobody able to contest.
    gwRoom._gwIsOpen = () => !!(modesRuntime._gw && modesRuntime._gw.phase === 'live');
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
    // ops.alert, not ops.send: a broken config is a CONDITION, not an event. It
    // is still broken on the next boot and the one after that, so a crash loop
    // sent this raw message every three seconds — past the throttle, past the
    // burst ceiling, and past the alert accounting /health reports, which is
    // the one place somebody would look to ask how bad it is. Through alert()
    // the same fault collapses into one message and a count.
    await ops.alert('config.problems', 'Проблемы конфигурации при запуске',
      problems.map(p => `• ${p}`).join('\n'), { сборка: version.COMMIT });
  }

  // 4. Background work.
  // ── a credited deposit, pushed to whoever is holding that account ────────
  // This is what replaces the "Я оплатил" button. The player sent TON and then
  // had to TELL the game about it; now the chain tells the game and the game
  // tells the player, so the only thing they have to do is pay.
  //
  // THE ROOM, not the socket. socketForTelegramId finds the connection that
  // asked for the deposit code, and by the time a transfer settles that
  // connection is routinely gone — a phone locked, a tab reloaded, the app
  // reopened. `tg_<telegramId>` is joined at login (see the join beside
  // savedData above) and is what the admin panel already uses to reach an
  // account rather than a session. It also covers the original socket, which
  // is why that socket is not emitted to separately: two deliveries of one
  // credit would be one balance update and two toasts.
  //
  // Nothing is queued for an offline player, deliberately. The balance and the
  // deposit history are already correct in the database, so the next login
  // shows the truth; a replay queue would be a second source of it.
  const notifyCredited = (c) => {
    const room = `tg_${c.telegramId}`;
    io.to(room).emit('gramBalanceUpdate', { balance: c.balance });
    io.to(room).emit('gramTxUpdate', { id: c.txId || c.memo, status: 'credited' });
    io.to(room).emit('gramDepositCredited', {
      amount: c.amount, balance: c.balance, memo: c.memo || null,
      txHash: c.txId, at: Date.now(),
    });
  };

  const w = workers.start({
    notifyPlayer: async (c) => notifyCredited(c),
    // The same push for a transfer an operator placed by hand. The player has
    // no way to tell the two apart and no reason to: money arrived.
    notifyCredit: async (c) => notifyCredited(c),
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
