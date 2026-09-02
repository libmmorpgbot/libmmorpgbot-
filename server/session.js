'use strict';
// ── The per-connection session ──────────────────────────────────────────────
// What this replaces is the single biggest structural change of the migration,
// bigger than the database swap itself.
//
// The old session held a MUTABLE COPY of the player: s.lastStats, an object
// carrying inventory, equipment, gold, level, skills, quests — everything. Every
// handler read from it, mutated it, and eventually wrote it back. That copy is
// the source of an entire family of bugs, and the old code's own comments are
// the evidence:
//
//   "the account may have reconnected on a DIFFERENT socket during the awaits
//    above ... writing through _sellerInv here regardless is exactly the 'item
//    vanishes after cancelling' race"
//
//   "a clone-and-commit handler mid-flight is holding a snapshot of the OLD
//    object, and its commit lands on the new one, discarding whatever the
//    re-read brought in"
//
// Both describe the same thing: two copies of one player's state, diverging.
// The machinery built to manage that — _itemOpBusy, _econBusy, _commitServer
// Items, _grantMarketItem, _takeMarketItem, invRev, _pendingFlush — exists
// only because the copy exists.
//
// THIS SESSION HOLDS NO PLAYER STATE. It holds an id and a socket. Every read
// goes to the database, every write is a transaction, and the database is the
// only place a player exists. There is nothing to go stale, so there is
// nothing to reconcile, and all of that machinery is deleted rather than
// ported.
//
// The cost is a round trip where there used to be a property access. On the
// same VPC that is ~0.3ms, and it is paid only on player ACTIONS — the 40Hz
// simulation loop never touches this file.

const { AsyncLocalStorage } = require('async_hooks');
const { tx, txRetry, query } = require('./db');
const players = require('./db/repos/players');
const stats = require('./db/repos/stats');
const items = require('./db/repos/items');
const money = require('./db/repos/money');
const plog = require('./db/repos/playerlog');
const ops = require('./tg-ops');

// ── what gets a log line on success ─────────────────────────────────────────
// Every refusal and every crash is recorded whatever the action was — those are
// the ones somebody asks about later. Successes are recorded only where the
// action MOVED something: an item, money, a listing, a level. act() also wraps
// reads (vipSync, getRating, codexSync, chatHistory) and a row for each of
// those would bury the ones worth reading — the point of the log is that it can
// be scanned while a player is on the phone.
// Successes worth a row in player_logs. Refusals and crashes are logged
// unconditionally (see act() below); this is the list of things that WORKED
// and are worth being able to look up afterwards.
//
// It was missing seventeen actions that move real value, and carried one —
// 'craft' — that no handler is named, which is why all five real craft events
// fell through it. The rule for what belongs here: if a player could later ask
// "where did this go" or "where did this come from", the answer has to exist.
const WRITE_ACTIONS = new Set([
  'marketList', 'marketBuy', 'marketCancel',
  'craftGear', 'craftPet', 'craftClassGear', 'craftMatUpgrade', 'craftBox', 'craftStone',
  'craftAdvSkillBook', 'enhanceItem', 'openLootBox', 'buyPotion', 'sellItem',
  'equipItem', 'unequipItem', 'storageDeposit', 'storageWithdraw',
  'usePotion', 'useBuffPotion', 'spendUpgrade', 'resetUpgrades', 'empower',
  'learnSkill', 'upgradeSkill', 'learnPassive', 'upgradePassive', 'learnAdvSkill',
  'claimQuest', 'completeSpecialQuest', 'claimVipRewards',
  'gramDepositRequest', 'gramWithdrawRequest',
  'clanCreate', 'clanApply', 'clanApprove', 'clanDecline', 'clanKick', 'clanLeave',
  'clanDisband', 'clanStorageDeposit', 'clanStorageGive', 'clanStorageClaim',
  'clanStorageCancel', 'clanStorageUnlock',
  'registerCodexSetItem', 'selectChar', 'respawn',
  // Rewards and purchases. gramShopBuy is a real-money purchase and had no
  // player-log row at all.
  'pickupWorldDrop',
  'gramShopBuy', 'starterBonusClaim', 'buyTeleportStone', 'useTeleportStone',
  'seasonBurn', 'seasonBurnAll', 'seasonBurnBook',
  'enterLocation',
]);

// ── чего здесь БОЛЬШЕ НЕТ, и почему ─────────────────────────────────────────
// killReward, killRewardShare и skillHeal стояли в этом списке и давали 93.6%
// всех строк журнала: за два часа 236 189 записей, из них 225 223 — эти три.
// Порядка 2.8 миллиона в сутки, 97 МБ за неполный месяц. Журнал,
// в котором на одну осмысленную строку приходится пятнадцать «убил моба»,
// нельзя ни прочитать глазами, ни удержать в базе — «логи вообще непонятные,
// так и база задохнётся».
//
// И главное: они ничего не добавляли. Правило этого списка — «если игрок потом
// спросит, куда это делось или откуда взялось, ответ должен существовать», — и
// для убийства ответ уже существует, в ДВУХ местах:
//
//   ledger        каждая монета с reason='mob_kill' и своим idem_key;
//   item_ledger   каждый предмет с reason='kill' и id строки, в которую он лёг.
//
// Оба — с суммами, оба сводятся звёркой (money.reconcile, items.reconcile), и
// оба переживают удаление партиций журнала. Строка «killReward произошёл»
// рядом с ними не отвечает ни на один вопрос.
//
// skillHeal не двигает вообще ничего: он лечит, а лечение — не ценность,
// которую можно потерять. Он попал сюда механически, когда заменил собой
// healParty.
//
// usePotion ОСТАЁТСЯ, хотя это ещё 2%: расход зелья не записан больше нигде —
// сумка это счётчик в jsonb, а не строки с реестром, — и «куда делись мои
// банки» спрашивают. Без трёх верхних он стоит 55 тысяч строк в сутки вместо
// двух с половиной миллионов.
//
// ОТКАЗЫ по всем этим действиям пишутся по-прежнему: они редки, и именно их
// спрашивают.

// ── what a success row SAYS ─────────────────────────────────────────────────
// A row carrying only the action's NAME answers "did it happen", and nobody has
// ever asked that question. What gets asked is "мій +12 меч згорів" — and
// craft.enhance computes { outcome, itemId, from, to, rate } on the way past,
// hands all of it to the client, and the row recorded the single word
// 'enhanceItem'. A burned weapon and a successful sharpening left the SAME
// evidence, so the log could not tell them apart afterwards and the answer to
// every "куда делся" was still "не знаю".
//
// So act() takes an optional fourth argument: either the meta object itself or
// a function of whatever the handler returned. Optional everywhere, and wired
// only where a player could later ask where something went — an amount, an
// item, an outcome.
//
// It CANNOT break the action. By the time this runs the transaction has already
// committed, so a throw here would report a completed craft as a failure and
// roll nothing back. plog swallows its own failures; this swallows the
// extractor's, and records that it did.
function _resultMeta(name, meta, out) {
  if (!meta) return null;
  try {
    const m = typeof meta === 'function' ? meta(out) : meta;
    return m && typeof m === 'object' ? m : null;
  } catch (err) {
    console.error(`[act:${name}] мета для журнала:`, err.message);
    return { metaError: String((err && err.message) || err).slice(0, 120) };
  }
}

// telegramId -> socket.id of the live session. Single-session enforcement, the
// one piece of cross-connection state that genuinely has to live in memory
// (it is about sockets, and sockets are per-process). Moves to Redis when a
// second process appears; nothing else here needs to.
const activeSessions = new Map();

// ── how often the single-session rule actually fires ────────────────────────
// It fired in complete silence: no player_logs row, no counter, no console
// line. So "с двух устройств можно играть" could be neither confirmed nor
// denied from the server — the rule left no evidence that it had run, which is
// the same position as not having one.
//
// The two outcomes are counted APART, and that split is the whole point. A
// player whose tunnel dropped comes back on a NEW socket id and lands in the
// same branch as a second device; if both were one number it would say the
// rule fires constantly and would be worth nothing to whoever reads it. What
// tells them apart is the client tag — see _claimSlot.
const sessionClaims = {
  takeovers: 0,        // a live OTHER client was told and closed
  reclaims: 0,         // the same client took its own slot back after a drop
  refusedActions: 0,   // an action refused because the session lost the slot
  lastTakeoverAt: null,
  // ── the two position writes that were being thrown away ──────────────────
  // savePosition's guard used to be a bare `return` and left no trace, so
  // "меня закинуло на другой этаж" could not be told from "я не так помню".
  // Both of these are counted rather than logged per-event: they fire on a
  // timer, and a row per tick would drown the player_logs the log exists for.
  posSkipped: 0,       // the slot was gone before the write — nothing written
  posRewritten: 0,     // the floor moved while the write was in flight
  // Объявлен здесь, а не создан по факту первой ошибки: он уходит в /health
  // (spread в app.js), и «posFailed: 0» — это ответ на вопрос, а отсутствие
  // поля — это отсутствие вопроса. За сутки продакшена таких было шесть, и все
  // шесть — deadlock, который никуда не сообщался.
  posFailed: 0,        // база отказала — позиция и HP не записаны
};

// ── the tag that tells a second device from a reconnect ─────────────────────
// The client puts a per-tab, per-launch string in the socket.io handshake (see
// _netClientTag in js/network.js). It travels in the HANDSHAKE rather than in
// either login payload on purpose: the Login Widget's payload is HMAC'd over
// every field it carries, so adding one to it would fail verifyTelegramAuth
// and lock the Android wrapper out of the game.
//
// It is untrusted client input and is used for ONE thing — an equality test
// against the tag of the connection about to be replaced. Nothing is granted
// on the strength of it: forging someone else's tag buys you a takeover that
// closes the other session WITHOUT telling it, which is strictly less than
// the takeover you get by sending no tag at all.
function _clientTagOf(sock) {
  try {
    const tag = sock && sock.handshake && sock.handshake.auth && sock.handshake.auth.client;
    return (typeof tag === 'string' && tag.length >= 8 && tag.length <= 64) ? tag : null;
  } catch { return null; }
}

// ── the outbox: what a handler SAYS, held until the transaction COMMITS ─────
// Every player action runs inside act(), and act() runs it inside a
// transaction. So every push below (pushItems / pushStats / pushProgress /
// pushBalances) and every socket.emit a handler made left the server BEFORE
// the COMMIT, and there are two ways that turns into a lie on the screen:
//
//   * txRetry re-runs fn on a 40001/40P01. The first attempt has already told
//     the client what it did, and PostgreSQL has already rolled it back.
//   * the COMMIT itself can fail — statement_timeout (5s), the
//     idle_in_transaction killer (10s), or a dropped connection; see
//     server/db/index.js. The whole transaction is gone and the client was
//     told about all of it.
//
// handlers2/world.js already names this for killReward — "A player watching
// gold appear and then revert on the next push is describing exactly that" —
// and fixed it for that ONE handler, by moving its pushes below `await
// s.act(...)`. Everywhere else still pushed from inside. empower is the worked
// example: materials consumed, bonusSP +15, season points added, all of it on
// screen, all of it reverted by the next push, and the next spendUpgrade
// refusing the points the player can still see. «покращення зникли» /
// «мій прогрес відкотився».
//
// So the sends are COLLECTED while fn runs and FLUSHED once the transaction
// has committed. No handler had to change: they still call s.socket.emit and
// s.pushItems(t) exactly as they did.
//
// ── why the async context and not a flag on the session ────────────────────
// The gate has to tell "this emit came from the handler I am running" apart
// from "this emit came from something else that happens to share the socket",
// and there is a great deal of the latter: Room._tick fires
// sock.volatile.emit('gameState') at 40Hz and sock.emit('playerHurt') from the
// monster AI — on this socket, on this thread, in the gaps between this
// transaction's awaits. A boolean on the session would swallow those into the
// transaction's outbox and drop a player's health bar on a rollback.
//
// AsyncLocalStorage draws exactly the line wanted: a timer callback is not
// inside act()'s async context, finds no box, and goes out untouched. The cost
// is one getStore() per emit, which is a property read on the current context
// frame.
const _outbox = new AsyncLocalStorage();

// Replaces socket.emit ONCE per connection. `emit` on a socket.io Socket is
// the send-to-this-client method and nothing else: incoming packets are
// dispatched through super.emitUntyped (dispatch(), socket.io/dist/socket.js)
// and the reserved events through emitReserved, and neither goes near this
// property. Replacing it therefore cannot affect anything the client SENDS.
//
// Installed once and never restored, deliberately. Wrapping and unwrapping
// around each act() would go wrong the moment one connection has two actions
// in flight — which is ordinary, socket.io does not serialise handlers — with
// each restoring the other's wrapper and leaving the socket permanently gated
// or permanently raw. Installed once, the state is a function of the async
// context alone and there is nothing to sequence.
function _gateEmit(sock) {
  if (!sock || typeof sock.emit !== 'function') return null;
  if (sock._libertyRawEmit) return sock._libertyRawEmit;
  const raw = sock.emit.bind(sock);
  sock._libertyRawEmit = raw;
  sock.emit = function gatedEmit(...args) {
    const box = _outbox.getStore();
    // No transaction in this async context — a room tick, a mode timer, the
    // login path — or one whose fate is already decided. Send it now.
    if (!box || !box.open) return raw(...args);
    // Not `sock.volatile.emit(...)`-safe, and it does not have to be: the flags
    // socket.io sets on the way in are consumed by whichever emit reaches the
    // real one next, and nothing inside a handler uses them. Room._tick is the
    // only volatile sender and it never runs inside a transaction.
    box.sends.push({ fire: () => raw(...args), state: false });
    return true;
  };
  return raw;
}

// What comes out of the outbox, and when:
//
//   'all'      the transaction COMMITTED. Everything the handler said is true.
//   'refusal'  the handler threw a domain error — it decided "no", and the
//              transaction rolled back. Its OWN words still have to arrive:
//              enterLocation emits 'enterLocationDenied' and then throws, and
//              completeSpecialQuest emits 'specialQuestError' and then throws
//              precisely because that event is the only thing that re-enables
//              the button the client disabled on click ("A generic toast
//              leaves the button dead for the rest of the session"). What must
//              NOT arrive is anything DESCRIBING state read inside the
//              rolled-back transaction — the `state` sends, which are dropped.
//   'drop'     a retry attempt that was superseded, a crash, or a COMMIT that
//              failed. Nothing happened, so nothing is said.
//
// The box is closed FIRST. Anything that emits during the flush — or later,
// from a timer the handler started, whose callback inherits this same async
// context — then finds a closed box and goes out immediately instead of into a
// queue nobody will ever read again. That is the direction this whole
// mechanism is built to fail in: an extra send, never a swallowed one.
//
// The one case that does not get that protection: a timer a handler starts
// that fires INSIDE the few milliseconds the transaction is still open. Its
// emit joins the box and shares the transaction's fate, so a crash would drop
// it. Nothing does that today — the shortest of them is fear's wave countdown,
// measured in seconds — but a handler that ever wants a send in the same
// millisecond, come what may, should use _emitRaw.
function _flushOutbox(box, mode) {
  if (!box) return;
  box.open = false;
  const sends = box.sends;
  box.sends = [];
  if (mode === 'drop') return;
  for (const s of sends) {
    if (s.state && mode !== 'all') continue;
    // One malformed payload must not swallow the sends behind it in the queue.
    try { s.fire(); } catch (err) { console.error('[session] outbox:', err && err.message); }
  }
}

// ── the last resort behind forceFloor's stat carry ──────────────────────────
// NOT the live path: forceFloor hands the destination room the block the
// database computed (Session._roomStats, filled by every fullState and every
// pushStats), and that block is complete by construction. This exists for the
// case where a session reaches forceFloor having never read its own state —
// which cannot happen today, because the only thing that puts a session in a
// Room at all is world.enterFloor, and its one caller reads fullState first.
//
// It carries the room record's own numbers across, INCLUDING the three the
// hand-built version used to omit (see the comment in forceFloor). If it ever
// runs it says so in the log, because a silent fallback here is how the
// original bug survived for so long: the cast simply did nothing, and nothing
// anywhere said why.
function _statsFromRoomRecord(p) {
  return {
    level: p.lvl, atk: p.atk, def: p.def, maxHp: p.maxHp,
    critChance: p.critChance, critPower: p.critPower,
    atkSpeed: p.atkSpeed, hpRegen: p.hpRegen, skillPct: p.skillPct,
    // Room's own private names for them — _skillMultFor reads p._skillLevels,
    // p._advLearned and p._advActive, and setPlayerStats is what fills those.
    skillLevels: p._skillLevels, advSkillLearned: p._advLearned, advSkillActive: p._advActive,
  };
}

// Floors whose rooms are created per run rather than once at boot. Their
// players stay out of the `floor_N` broadcast group, because two simultaneous
// runs on the same floor id would otherwise see each other's traffic.
const INSTANCED_FLOORS = new Set([11, 12, 13]);   // fear, coop, farmZone2

class Session {
  constructor(socket, io = null) {
    this.socket = socket;
    // The server, for the broadcasts that are not to this one client. Passed
    // in rather than required, so a test can drive a session without one.
    this.io = io || (socket && socket.server) || null;
    this.playerId = null;
    this.telegramId = null;
    this.username = null;
    this.banned = false;
    // Where they are. Position is written through to the database on a timer
    // and on disconnect, not on every step — it is the one value where losing
    // the last few seconds costs nothing.
    this.floor = 1;
    this.room = null;
    // Read once at login and refreshed when they change. Both decide the size
    // of a LOOT ROLL, which happens on every kill — a database read per kill
    // for two numbers that move a few times a month would be the most
    // expensive query in the game.
    this.vipLevel = 0;
    this.seasonTicket = false;
    // { clanId, name, icon, level, atkBonus } or null — see refreshClan.
    this.clan = null;
    this.connectedAt = Date.now();
    // ── the block the last database read computed ────────────────────────
    // This is NOT the old build's s.lastStats that the header above damns.
    // Nothing READS it to decide anything — no handler consults it, no rule
    // is evaluated against it, and it is never written back. It has exactly
    // one use: forceFloor has to hand a complete stat block to a Room
    // SYNCHRONOUSLY, and stats.of() is async. So the last block the database
    // computed is kept, and handed over unchanged.
    //
    // The Room already holds a copy of these numbers — it must, the 40Hz loop
    // cannot await — so this is a mirror of a copy that already exists, not a
    // second source of truth.
    this._roomStats = null;
    // Bumped on every completed forceFloor, so the asynchronous half of a move
    // can tell whether it is still describing where the player is. See there.
    this._moveSeq = 0;
    // The send-to-this-client method as it was before the outbox wrapped it —
    // see _gateEmit. Kept because a few things must reach the player whatever
    // the transaction decided; see _emitRaw.
    this._rawEmit = _gateEmit(socket);
  }

  get authed() { return this.playerId !== null; }

  // ── login ────────────────────────────────────────────────────────────────
  // One transaction: find or create the account and its satellite rows. The
  // old path did this across several awaits with a "did another socket get
  // here first" check between them.
  async login(telegramId, username) {
    const res = await tx(async (t) => {
      const { id, isNew } = await players.ensure(t, telegramId, username);
      const p = await players.byTelegramId(t, telegramId);
      if (p.username !== username) await players.setUsername(t, id, username);
      return { id, isNew, banned: p.banned, referredBy: p.referredBy };
    });

    this.playerId = res.id;
    this.telegramId = String(telegramId);
    this.username = username;
    this.banned = res.banned;

    // Single session per account. The previous holder is disconnected rather
    // than refused, because the common case is a page refresh where the old
    // socket has not noticed it is gone yet.
    this._claimSlot();

    // The two numbers that size a loot roll, cached for the session — see the
    // constructor for why they are not read per kill.
    await this.refreshVip();
    await this.refreshClan();

    // Everything the client needs, from the database, in one place. The blob
    // that comes back with it (savedView) is a projection OUT of these tables,
    // never a thing read back in.
    return { ...res, state: await this.fullState() };
  }

  // ── one account, one live client ─────────────────────────────────────────
  // Three things reach this branch and only ONE of them is a second device.
  // Telling them apart is the whole job, because getting it wrong in either
  // direction is worse than the bug:
  //
  //   too loose — two devices both play, which is the report this exists for;
  //   too tight — a player is thrown out mid-fight because their tunnel
  //               blipped, and a reconnect is the single most common event in
  //               a game played on phones.
  //
  //   a genuine second client   different tag, socket still connected. TOLD
  //                             and closed: the client shows the message and
  //                             stops reconnecting, so the account is not
  //                             fought over. This is the only case that emits
  //                             'kicked'.
  //   the same client back      same tag on a new socket — a dropped tunnel, a
  //                             backgrounded WebView, a reload. Whatever the
  //                             server still holds for it is a zombie: closed
  //                             WITHOUT a message, because "вы вошли с другого
  //                             устройства" is both a lie and, if it were
  //                             delivered, an instruction to the client to
  //                             stop reconnecting — the blip would become a
  //                             logout.
  //   nothing left to close     socket.io already reaped it. Counted, so the
  //                             number can be read, and nothing else.
  //
  // The claim is written FIRST, before anything is closed. The socket being
  // closed runs its own disconnect teardown synchronously inside disconnect(),
  // and that teardown ends in close(), which deletes the slot if it still owns
  // it — with the order the other way round it owned it, and the ONLY thing
  // standing between that and a brand-new session with no slot at all was the
  // exact point at which close() happens to await. Claiming first makes the
  // guard in close() true by construction rather than by timing.
  _claimSlot() {
    const prev = activeSessions.get(this.telegramId);
    activeSessions.set(this.telegramId, this.socket.id);
    // A second login on the SAME socket — the client re-sending its login after
    // a authOk it did not see. Nothing changed hands.
    if (!prev || prev === this.socket.id) return null;

    const old = this.socket.nsp.sockets.get(prev);
    if (!old || !old.connected) { sessionClaims.reclaims++; return 'gone'; }

    const mine = _clientTagOf(this.socket);
    const theirs = _clientTagOf(old);
    // Both tags have to be present to claim they are the same client: two
    // clients running a bundle too old to send one would otherwise look
    // identical to each other, and a real second device would go unkicked.
    // No tag at all therefore means "assume a second device", which is the
    // safe direction — it closes the other session either way, and only
    // decides whether that session is told why.
    if (mine && theirs && mine === theirs) {
      sessionClaims.reclaims++;
      old.disconnect(true);
      return 'zombie';
    }

    sessionClaims.takeovers++;
    sessionClaims.lastTakeoverAt = new Date().toISOString();
    // `code` so the client can say this in the player's own language — the
    // string is already in js/i18n.js in all six (loggedInElsewhere), and a
    // hardcoded Russian `reason` overrode it for everybody. The reason is
    // still sent, because a bundle older than that change reads only the
    // reason and would otherwise show an empty error box.
    old.emit('kicked', { reason: 'Вход с другого устройства', code: 'another_device' });
    old.disconnect(true);
    // THE ROW SOMEBODY LOOKS FOR. "Меня выкинуло" and "я не выходил" are the
    // same sentence from the two sides of this event, and until now neither
    // had an answer anywhere. It carries how long the closed session had been
    // connected, because a takeover seconds after a login is a player opening
    // the game twice and one after two hours is somebody else on the account.
    const held = old.data && old.data.session && old.data.session.connectedAt;
    plog.log(this.playerId, 'sessionTakeover', {
      code: 'another_device',
      oldSocket: String(prev).slice(0, 24),
      newSocket: String(this.socket.id).slice(0, 24),
      heldForS: held ? Math.round((Date.now() - held) / 1000) : null,
      oldTagged: !!theirs,
    });
    return 'takeover';
  }

  // ── Why these reads are sequential, not Promise.all ──────────────────────
  // A pg Client executes ONE query at a time. Inside a transaction every read
  // here shares the same client, so Promise.all does not run them in parallel
  // — it queues them, and emits a deprecation warning that becomes an error in
  // pg@9. The first version of this file used Promise.all and looked faster
  // while being exactly as serial.
  //
  // On the pool (db === null) they COULD genuinely run in parallel, but then
  // they would be spread across several connections and no longer see one
  // consistent snapshot — which for "the whole player, as of now" is the wrong
  // trade. Sequential is both correct and honest about what it costs.
  //
  // The authoritative picture. Sent on login and after anything that changes
  // several things at once — the client mirrors it rather than composing its
  // own version, which is what stops the two disagreeing.
  async fullState(db = null) {
    const progress = await players.progressOf(db, this.playerId);
    const prefs    = await players.prefsOf(db, this.playerId);
    const skills   = await players.skillsOf(db, this.playerId);
    const inv      = await items.inventoryOf(db, this.playerId);
    const balances = await money.balancesOf(db, this.playerId);
    const st       = await stats.of(db, this.playerId);
    // The moment the whole player was read is also the moment the stat block
    // is freshest, and forceFloor needs one it can hand over without awaiting.
    // Recorded here rather than only in pushStats because the login path never
    // calls pushStats at all: handlers2/world.js's sendGameStart takes
    // state.stats from THIS call and writes it into the Room itself, so
    // without this line the session would not know the numbers its own room is
    // running on until the player's first equip.
    if (st) this._roomStats = st;
    return { progress, prefs, skills, items: inv, balances, stats: st };
  }

  // ── the handler wrapper ──────────────────────────────────────────────────
  // Every player action goes through this. It gives four things that were
  // previously each handler's own responsibility, done slightly differently in
  // each of the 133 of them:
  //
  //   * a transaction, so a partial effect is not a state the code has to handle
  //   * a retry on serialisation conflict, which is safe by definition because
  //     PostgreSQL only reports those after rolling back
  //   * a user-facing error for the player and a real one for the admins
  //   * refusal when not logged in, in one place instead of 133 `if (!s.authed)`
  //
  // `errEvent` is what the client listens on for this action's failures.
  // `meta` is what the row it writes should SAY — see _resultMeta above.
  async act(name, errEvent, fn, meta = null) {
    if (!this.authed) return null;
    // ── чей это ход, решается ЗДЕСЬ ────────────────────────────────────────
    // Ниже стоит txRetry, а его обратный вызов запускается после ожидания
    // (соединение из пула). Раньше playerId читался внутри него — и разрыв
    // связи, случившийся в этом промежутке, подставлял туда null: close()
    // обнуляет playerId, обработчик доходил до items.lockPlayer и падал с
    // «items: no player null». Игрок видел «Ошибка сервера», операторы —
    // алерт, а причиной был всего лишь ушедший в этот миг сокет.
    const pid = this.playerId;
    // ── a session that no longer owns the account ────────────────────────
    // savePosition has refused for a superseded session since it was written,
    // and it was the ONLY thing that did — every craft, sale, purchase and
    // market order went through untouched. So "the first device stops being
    // able to write" was true of one value, its coordinates, and false of
    // everything a player could lose.
    //
    // In the ordinary case _claimSlot has already closed that socket and
    // nothing can arrive on it. This is for the cases where it could not: a
    // packet already in flight when the socket went, a client that ignores
    // 'kicked', a socket.io the account outlived. The account has exactly one
    // live session and this is not it.
    if (activeSessions.get(this.telegramId) !== this.socket.id) {
      sessionClaims.refusedActions++;
      plog.log(this.playerId, `refuse:${name}`,
        { code: 'session_replaced', msg: 'Сессия заменена входом с другого устройства' });
      this._emitRaw(errEvent, { msg: 'Вы вошли с другого устройства', code: 'session_replaced' });
      return null;
    }
    // ── the outbox ────────────────────────────────────────────────────────
    // A fresh box per ATTEMPT, not per action: txRetry re-runs fn after a
    // serialisation conflict, and the sends of the attempt PostgreSQL rolled
    // back must not be delivered beside the sends of the one that stuck. The
    // superseded box is CLOSED rather than emptied, so if anything of that
    // attempt is somehow still running it finds the box shut and sends
    // immediately — a duplicate that the next push corrects, rather than a
    // state change the player never sees.
    let box = null;
    try {
      const out = await txRetry((t) => {
        if (box) box.open = false;
        box = { sends: [], open: true };
        return _outbox.run(box, () => fn(t, pid));
      });
      // COMMITTED. Everything the handler said is now true of the database, so
      // all of it goes — including the pushes that read through this very
      // transaction and could not have been sent before it landed.
      _flushOutbox(box, 'all');
      // Only the actions that CHANGE something. Logging a read would bury the
      // rows that matter under vipSync and getRating — see WRITE_ACTIONS.
      if (WRITE_ACTIONS.has(name)) plog.log(pid, name, _resultMeta(name, meta, out));
      return out;
    } catch (err) {
      // A domain error carries a message written for the player. Anything else
      // is a bug and must not have its text shown — an internal message in a
      // player's face is both confusing and an information leak.
      if (err && err.userMessage) {
        // The handler DECIDED to refuse, and several handlers explain that
        // refusal with an event of their own immediately before throwing —
        // enterLocation's 'enterLocationDenied', completeSpecialQuest's
        // 'specialQuestError', which is the only thing that re-enables the
        // button the client disabled on click. Those go. The state pushes do
        // not: the transaction rolled back, so they describe nothing that
        // exists. See _flushOutbox.
        _flushOutbox(box, 'refusal');
        // A REFUSAL IS RECORDED. This is the hole the market bug fell into:
        // the player was told no, and nobody else was told anything, so "не мог
        // купить лот, и никаких ошибок наш лог не выбил" was literally true.
        // One line per refusal, with the reason the player saw.
        plog.log(pid, `refuse:${name}`, { code: err.code, msg: err.userMessage });
        this._emitRaw(errEvent, { msg: err.userMessage, code: err.code });
        return null;
      }
      // A crash, or a COMMIT that failed — the second of the two triggers this
      // outbox exists for (statement_timeout, the idle-transaction killer, a
      // dropped connection). Nothing was written, so nothing is said about it.
      _flushOutbox(box, 'drop');
      console.error(`[act:${name}]`, err);
      plog.log(pid, 'error', { action: name, msg: String(err && err.message || err).slice(0, 300) });
      ops.alertError(`act.${name}`, `Ошибка в обработчике ${name}`, err, {
        player: this.username, telegramId: this.telegramId,
        // Для 40P01/40001 здесь лежит разбор цикла: оба процесса, обе
        // блокировки и оба запроса. Без него «deadlock detected» — это
        // сообщение, по которому нельзя ничего сделать.
        detail: err && err.detail ? String(err.detail).slice(0, 500) : undefined,
        код: err && err.code ? String(err.code) : undefined,
      });
      this._emitRaw(errEvent, { msg: 'Ошибка сервера — попробуйте ещё раз' });
      return null;
    }
  }

  // ── the ungated send ──────────────────────────────────────────────────────
  // For the few things that must reach this client whatever the transaction
  // decided, and which therefore must not sit in an outbox that may be dropped:
  //
  //   * act()'s own refusal and error reports. A player told NOTHING is the one
  //     outcome worse than a player told the wrong thing — and if act() is ever
  //     called from inside another action's handler, its report would otherwise
  //     land in that outer action's box and be judged by that action's fate.
  //   * forceFloor's gameStart. The move it describes is a change to MEMORY
  //     that has already happened and that no rollback undoes, so a client left
  //     drawing the floor it is no longer standing on would be a worse bug than
  //     the one the outbox fixes.
  _emitRaw(...args) {
    if (this._rawEmit) return this._rawEmit(...args);
    return this.socket ? this.socket.emit(...args) : false;
  }

  // A push describes THE DATABASE. Inside act() it reads through the open
  // transaction — that is the whole point of threading `t` down into it, it has
  // to see what the handler just wrote — so it may not leave the server until
  // that transaction has COMMITTED. Outside act() (killReward, which already
  // pushes after the fact) there is no box and it goes now.
  _sendState(fire) {
    const box = _outbox.getStore();
    if (box && box.open) { box.sends.push({ fire, state: true }); return; }
    fire();
  }

  // ── pushes ───────────────────────────────────────────────────────────────
  // The client is told what changed; it never decides. Each of these reads
  // back from the database rather than echoing what the handler thinks it
  // wrote, so a push cannot describe a state the database does not hold.
  //
  // Each one READS immediately — inside the caller's transaction, where it must
  // be — and SENDS through _sendState, which holds it until that transaction
  // commits. That is the split the bug needed: the read has to be inside, the
  // send has to be outside, and before this they were both inside.

  async pushItems(db = null) {
    const inv = await items.inventoryOf(db, this.playerId);
    this._sendState(() => {
      this._emitRaw('inventorySync', inv);
      // A pet is drawn beside its owner on everyone ELSE's screen, and the only
      // way they learn about it is this event. The old build derived it from the
      // save blob the client sent; there is no blob any more, so it comes off
      // the equipment we have just read. Every equip and unequip goes through
      // pushItems, so this is where it changes.
      //
      // Deferred with the rest of the push, and for the same reason: a pet
      // broadcast out of a transaction that then rolled back shows every other
      // player on the floor a familiar its owner does not have equipped.
      this.syncPet(inv.equipment);
    });
  }

  // Broadcast only when it CHANGES — a pet is a rare event and this is called
  // after every inventory write.
  syncPet(equipment) {
    if (!this.room || !this.room.setPlayerPet) return;
    const petId = (equipment && equipment.pet && equipment.pet.id) || null;
    if (!this.room.setPlayerPet(this.socket.id, petId)) return;
    this.socket.to(`floor_${this.floor}`).emit('playerPet', { id: this.socket.id, petId });
  }

  // Three events, one read. The shipped client keeps gold, GRAM and Liberty in
  // three separate places and listens for three separate names — there is no
  // 'balanceSync' anywhere in it, so a single tidy event went to nobody and
  // every balance on screen stayed at whatever it was at login.
  async pushBalances(db = null) {
    const b = await money.balancesOf(db, this.playerId);
    this._sendState(() => {
      this._emitRaw('goldSync', { gold: b.gold });
      this._emitRaw('gramBalanceUpdate', { balance: b.gram });
      this._emitRaw('nexumBalanceUpdate', { balance: b.nexum });
    });
    return b;
  }

  // Stats AND the room's copy of them, together. This is what replaces
  // 'statsUpdate': the number is computed here and pushed down, where before
  // the client computed it and pushed it up.
  // The room gets the WHOLE computed stat block, because that is what decides
  // damage. The client gets level, experience and the curve — and works out the
  // number on its own HUD from the equipment it can already see.
  //
  // That split is deliberate rather than a compromise. The client's figure is
  // decoration; the server's is the one that hits. Sending the server's final
  // atk as the client's `baseAtk` would have it add the equipment bonuses a
  // second time and display a number nobody's weapon can produce.
  async pushStats(db = null) {
    const st = await stats.of(db, this.playerId);
    if (!st) return null;
    this._sendState(() => {
      // The base figures ride along: applyLevelState reads them, and without
      // them a level-up raised the level on screen while the character stayed as
      // strong as it was at level one.
      this._emitRaw('xpSync', {
        lvl: st.level, xp: st.xp, xpNext: st.xpNext,
        baseAtk: st.baseAtk, baseDef: st.baseDef, baseMaxHp: st.baseMaxHp,
      });
      // The ROOM's copy waits for the commit too, and that is not tidiness. It
      // is what decides damage: an empower whose transaction is rolled back
      // used to leave the room fighting on the boosted numbers until the next
      // push happened to correct it, which in a Fear run may be never.
      this._applyStats(st);
    });
    return st;
  }

  // ── the one writer of a stat block into a Room ────────────────────────────
  // Every stat block the room fights on comes through here, and it is handed
  // over WHOLE — never field by field. The hand-built version that used to live
  // in forceFloor listed nine of its fields and dropped the three that decide
  // whether a skill does any damage at all; a list like that loses the next
  // field somebody adds, so there is no longer a list.
  //
  // `room` is an argument because forceFloor has to seed the room it is moving
  // the player INTO, at a moment when this.room is still the one being left.
  _applyStats(st, room = this.room) {
    if (!st) return null;
    this._roomStats = st;
    if (room) room.setPlayerStats(this.socket.id, st);
    return st;
  }

  async pushProgress(db = null) {
    const prog = await players.progressOf(db, this.playerId);
    const skills = await players.skillsOf(db, this.playerId);
    this._sendState(() => this._emitRaw('progressSync', { ...prog, ...skills }));
  }

  // Everyone who can see this point, optionally including the sender. The
  // event modes and the skill visuals both broadcast this way rather than to
  // the whole floor: a spell effect is worth a packet to the twelve people who
  // can see it and not to the two hundred who cannot.
  emitNearby(x, y, event, payload, includeSelf = false) {
    if (!this.room) return;
    const ids = this.room.nearbyPlayerIds(x, y, includeSelf ? null : this.socket.id,
      this.room.laneOf(this.socket.id));
    if (ids.length) this.io.to(ids).emit(event, payload);
  }

  // ── the shape the client rebuilds a character from ───────────────────────
  // The client has one function that turns a saved account into a playable
  // player — restoreFromSave(data) in js/player.js — and it is fed from
  // authOk.savedData. Sending everything EXCEPT that field left it holding its
  // own defaults: gold 0, level 1, no inventory, thirty potions it was never
  // given. Every symptom followed from it. Gold "resets on reload" because it
  // was never loaded. The potion count is wrong at login and right after the
  // first use, because the first use is when the server's real number arrives.
  //
  // So the blob comes back — as a PROJECTION, in one direction only. It is
  // built here from the normalised tables, it is never read back, and there is
  // no handler that accepts it. That is the whole difference from the design
  // this replaces: the client renders from this, and the server decides from
  // the tables it was built out of.
  //
  // Keeping the client's vocabulary is deliberate. The alternative — teaching
  // the client the new shape — is a rewrite of the part of the game that draws
  // everything, to gain nothing a projection does not already give.
  async savedView(db = null) {
    const state = await this.fullState(db);
    // players.ensure creates every one of these rows, so a null here means the
    // account was deleted between the ensure and this read — an admin deleting
    // someone mid-session, or a test cleaning up under a reconnect. It is a
    // refused login, not a crash inside one: the old behaviour threw out of
    // finishLogin and reported an internal error to the ops channel for what
    // is a legitimate race.
    if (!state.progress) return null;
    const { progress: p, prefs, skills, items: inv, balances, stats: st } = state;

    // Equipment as a slot map of catalog-shaped items, which is what
    // _rebuildFromCatalog expects on the other side.
    const equipment = {};
    for (const [slot, it] of Object.entries(inv.equipment || {})) {
      if (it) equipment[slot] = { id: it.id, enhance: it.enhance || 0 };
    }

    return {
      // ── WHICH CLASS THIS ACCOUNT ALREADY IS ──────────────────────────────
      // The column is char_class, the client's whole vocabulary for it is
      // `type` (makePlayer(type), SPRITE_DEF[type], SKILL_DEF[type]), and this
      // projection is where the rename has to happen. It did not happen
      // anywhere, on any login path — so `savedData.type` has been undefined
      // for every player since the port, and _showCharSelect (js/network.js)
      // fell through to its localStorage fallback every single time.
      //
      // That fallback is per-DEVICE, which is exactly why this looked like a
      // PC-only bug: the phone that created the character has the class in its
      // own localStorage and skips the roster, and the same account on a
      // desktop has nothing cached and is asked to choose again. Progress
      // belongs to the account, so the answer has to come from here.
      //
      // Null for an account that has not chosen yet — the client then shows the
      // roster, which is the correct screen for that player.
      type: p.charClass || null,
      lvl: p.lvl, xp: p.xp, kills: p.kills,
      // Base figures, NOT the computed ones. recompute() on the client adds the
      // equipment and the upgrades itself, so handing it the final atk would
      // have it count the sword twice and show a number no weapon can produce.
      baseAtk: st ? st.baseAtk : undefined,
      baseDef: st ? st.baseDef : undefined,
      baseMaxHp: st ? st.baseMaxHp : undefined,
      hp: st ? st.hp : undefined,

      gold: balances.gold,
      potionBag: p.potionBag || {},
      hudPotion: prefs.hudPotion || 'pt1',
      // Seconds remaining, not the stored expiry: the client decrements its
      // own copy every frame to animate the bar.
      buffs: require('./db/repos/consumables').buffsRemaining(p.buffs),

      inventory: (inv.inventory || []).map(i => ({ id: i.id, enhance: i.enhance || 0, qty: i.qty || 1 })),
      storage: (inv.storage || []).map(i => ({ id: i.id, enhance: i.enhance || 0, qty: i.qty || 1 })),
      equipment,

      upgrades: p.upgrades || {},
      bonusSP: p.bonusSP, keptSP: p.keptSP, empowers: p.empowers,
      starterBonus: !!p.starterBonusClaimed,
      // Сколько раз этот аккаунт менял класс. Нужно КЛИЕНТУ: за Liberty
      // меняют только первый раз, и предлагать её на второй значит обещать то,
      // в чём сервер откажет. Считается по журналу движения денег — он
      // append-only и уже хранит ровно этот факт.
      classChanges: Number((await query(db, `
        SELECT count(*)::int n FROM ledger
         WHERE player_id = $1 AND reason = 'class_change'`, [this.playerId])).rows[0].n),
      questIdx: p.questIdx, questKills: p.questKills || {},
      // Read by the special-quests panel (js/quests.js) to grey out what is
      // already claimed. The repo function for it has existed since the port
      // and had no caller.
      specialQuestsDone: await require('./db/repos/progression').claimedSpecialQuests(db, this.playerId),
      codex: p.codex || {},

      skillLevels: skills.skillLevels || {},
      passiveLevels: skills.passiveLevels || {},
      advSkillLearned: skills.advSkillLearned || {},
      advSkillActive: skills.advSkillActive || {},

      lang: prefs.lang,
      autoHpPct: prefs.autoHpPct,
      autoSkillsOn: prefs.autoSkillsOn,
      autoSkillOff: prefs.autoSkillOff || {},
      autoBuffTypes: prefs.autoBuffTypes || {},
    };
  }

  // Re-read after anything that can change them: a package purchase, a VIP
  // claim, a season ticket. Cheap, and rare.
  // ── the clan badge ───────────────────────────────────────────────────────
  // Name and icon, for the tag drawn over this player's head on everyone
  // else's screen. Cached on the session for the same reason vipLevel is: it
  // is read on every floor entry and changes a few times in an account's life.
  //
  // It has to be cached SOMEWHERE, and the place it was being read from —
  // `progress.clanName` — does not exist. player_progress has no clan columns,
  // because a clan is not a property of progress; it is a row in clan_members.
  // So Room.addPlayer received undefined for the name and the icon on every
  // entry, and nobody has ever seen anybody's clan tag.
  async refreshClan(db = null) {
    try {
      const clansRepo = require('./db/repos/clans');
      this.clan = await clansRepo.badgeOf(db, this.playerId);
    } catch (err) {
      // A missing badge costs a label, not a capability. The one thing it
      // must not do is stop the login.
      console.error('[session] refreshClan:', err.message);
      this.clan = null;
    }
    // The room the player is standing in right now, if any — leaving or
    // joining a clan must show up without a relog.
    if (this.room && this.room.setPlayerClan) {
      const c = this.clan;
      this.room.setPlayerClan(this.socket.id,
        c && c.name, c && c.icon, (c && c.atkBonus) || 0, c && c.clanId);
    }
    return this.clan;
  }

  async refreshVip(db = null) {
    try {
      const progression = require('./db/repos/progression');
      const v = await progression.vipOf(db, this.playerId);
      this.vipLevel = v.level || 0;
      this.seasonTicket = !!v.seasonTicket;
    } catch (err) {
      // A failure here costs a loot BONUS, not a loot roll. Falling back to
      // zero is the safe direction: the player gets the ordinary chance.
      console.error('[session] refreshVip:', err.message);
    }
  }

  // ── what the client needs to DRAW a floor ────────────────────────────────
  // As opposed to everything it needs to know about the PLAYER, which is
  // fullState. gameStart carries both, and the rewrite sent only the second
  // half — so the packet arrived with no spawn point, no enemy snapshot and no
  // mode state, the client destructured six undefineds, and the screen stayed
  // on the character select with a live socket behind it.
  //
  // No static check can see this. dev/protocol-check.js compares event NAMES
  // and the keys of what the client SENDS; the shape of a REPLY is only
  // verifiable by a client actually reading it. That is what dev/live-check.js
  // is for.
  //
  // Every mode answers "is this player in it", because the client resumes a
  // run from this packet: a reconnect mid-wave has to come back into the wave
  // rather than to an empty hub.
  worldPayload(floor, room = null, modes = null) {
    const r = room || this.room;
    if (!r) return { floor, mapVersion: null };
    const sid = this.socket.id;
    const me = r.players.get(sid);
    const m = modes || require('./modes').modes || {};
    const { FEAR_MAX_WAVE, COOP_STAGE_LEVELS } = require('../shared/definitions');
    const inFear = m._fear && m._fear.get(sid);
    const inCoop = m._coop && m._coop.get(sid);
    return {
      floor,
      mapVersion: r.mapVersion,
      spawn: me ? { x: me.x, y: me.y } : undefined,
      enemies: r.enemySnapshot ? r.enemySnapshot(sid) : [],
      bossStatus: r.getBossStatus ? r.getBossStatus() : null,
      // The world boss is scheduled by modes.js, not by the room it stands in
      // — a Room has no idea what time it is. Reading it off `r` meant this
      // was null on every packet, so the Events panel had no countdown and no
      // idea whether a boss was up.
      //
      // But `drops` is the exception, and it has to be overridden here.
      // eventBossState() reports the ARENA's floor loot, because that is where
      // the boss stands and that is the number the admin panel wants. The
      // client rebuilds its entire ground-loot map from this field on every
      // gameStart — so walking out of the arena into the hub redrew the boss's
      // sixty piles on the hub floor, at the arena's coordinates, unpickable
      // because the hub room has never heard of them. "Вийшли в лоббі і там
      // весь лут з боса валявся."
      //
      // Ground loot is a property of the floor you are standing on. Whatever
      // is on THIS floor is what this player is told about.
      eventBoss: m.eventBossState
        ? { ...m.eventBossState(), drops: r.worldDropSnapshot ? r.worldDropSnapshot() : [] }
        : null,
      deathBattle: m._dbPublicState
        ? { ...m._dbPublicState(), registered: !!(m._db && m._db.reg.has(sid)) } : null,
      race10: m._race10PublicState
        ? { ...m._race10PublicState(), registered: !!(m._race10 && m._race10.queue.has(sid)) } : null,
      arena3: m._a3PublicState
        ? { ...m._a3PublicState(), registered: !!(m._a3 && m._a3.queue.has(sid)) } : null,
      guildWar: m._gwPublicState ? m._gwPublicState() : null,
      fear: inFear ? { inRun: true, wave: inFear.wave, maxWave: FEAR_MAX_WAVE } : null,
      coop: inCoop && inCoop.room
        ? { inRun: true, stage: inCoop.room.coopStage(), maxStage: COOP_STAGE_LEVELS.length }
        : null,
      farm2: m._farm2 && m._farm2.has(sid) ? { inRun: true } : null,
    };
  }

  // ── moved by the server, not by the player ───────────────────────────────
  // A mode deploying its entrants, a run ending, the guild-war window closing:
  // all of them move a player to a floor they may not be able to walk into. The
  // level gate is skipped, and skipping it is why this is a separate method
  // rather than a flag on the handler — a client request cannot reach it.
  //
  // Returns the player's room record so the caller knows where they landed,
  // which is what every mode's "returned to hub at x,y" answer is built from.
  forceFloor(floorId, { pos = null, room = null } = {}) {
    if (!this.authed || !this.room) return null;
    const world = require('./world');
    const target = world.floorIdOf(floorId);
    if (!Number.isFinite(target)) return null;

    // Fear, co-op and the elite farm zone are INSTANCED: each run gets its own
    // Room that is not in floorRooms, and its players do not join the
    // `floor_N` broadcast group — a run is private to its participants, and
    // joining would put every simultaneous run on one channel.
    const dest = room || world.roomOf(target);
    if (!dest) return null;
    if (dest === this.room) return this.room.players.get(this.socket.id) || null;

    // Everything the new room needs, taken from the record the OLD room
    // already holds. This is the reason forceFloor can be synchronous, and a
    // synchronous answer is what the modes need — they have to know where the
    // entrant landed before they can scatter the rest of the team around them.
    // Re-reading the database here would make every deploy a round trip and
    // hand back a player who is not in a room yet.
    const was = this.room.players.get(this.socket.id);
    if (!was || !was.type) return null;            // no character chosen yet

    // Leaving an instanced floor ends the run on it — see
    // modes.leaveInstanceFloor for what a leftover run record does to every
    // OTHER mode. Both floor-change routes go through here or through
    // world.enterFloor, and both have to apply it.
    this._leaveInstance(this.floor);

    // Окна навыков — вампиризм, «Бабочки», ускорение, боевой баф. Живут в
    // записи игрока, а она у каждого этажа своя: addPlayer ниже создаёт новую,
    // с чистыми полями. Снимаются здесь, до removePlayer, и надеваются после
    // него — иначе включённый перед входом в режим баф пропадал на пороге, и
    // молча: таймер в HUD клиента идёт своим ходом и об этом не знает.
    // То же самое делает world.enterFloor для обычных переходов.
    const carryWindows = typeof this.room.skillWindowsOf === 'function'
      ? this.room.skillWindowsOf(this.socket.id) : null;

    this.room.removePlayer(this.socket.id);
    this.socket.to(`floor_${this.floor}`).emit('playerLeft', { id: this.socket.id });
    if (!INSTANCED_FLOORS.has(this.floor)) this.socket.leave(`floor_${this.floor}`);

    // `was` is the room record being left, which carries whatever it was given
    // — undefined, until this fix. The session is the source.
    const clan = this.clan || null;
    dest.addPlayer(this.socket.id, this.username, clan && clan.name, clan && clan.icon,
      (clan && clan.atkBonus) || 0, this.telegramId, clan && clan.clanId);
    dest.setPlayerChar(this.socket.id, was.type);
    // ── THE WHOLE STAT BLOCK, not the nine fields somebody typed out ────────
    // This is where every skill in every instanced mode did ZERO damage.
    //
    // addPlayer above creates a BRAND-NEW record in `dest`, and the block that
    // used to be built here by hand carried level, atk, def, maxHp, crit,
    // atkSpeed, hpRegen and skillPct — and not skillLevels, advSkillLearned or
    // advSkillActive. Room.setPlayerStats only assigns those three `if
    // (st.skillLevels)`, and its comment says the guard is there so THIS caller
    // "cannot blank them" — but there was nothing to blank in a record that had
    // just been created, so they were never set at all. setPlayerChar with no
    // savedStats leaves p._sd = {}, so the fallback under them was empty too,
    // and Room._skillMultFor then read `p._skillLevels || sd.skillLevels || {}`,
    // found lvl 0, returned a multiplier of 0 — and the cast was dropped with
    // no damage, no enemyHurt, no error and no log line.
    //
    // Every entry through forceFloor was affected: Страх, co-op, the Elite farm
    // zone, Кровавая Башня, arena3, the death battle, the guild-war close, the
    // teleport stone, the fear reconnect resume and modes.returnToHub. For the
    // whole run the player had spent every book on Q/W/E/R for nothing — «я
    // активировал навык, а книги на месте / навыка нет» — and it healed only if
    // some unrelated action happened to call pushStats, which in a Fear run may
    // never happen.
    //
    // The fix is not another field in the list; it is that there is no list.
    // _roomStats is the block stats.of() computed, kept whole, and _applyStats
    // is the only thing that ever hands one to a Room.
    const carried = this._roomStats || _statsFromRoomRecord(was);
    if (!this._roomStats) {
      console.error('[session] forceFloor: нет stats из БД, переношу запись комнаты — ' +
        `player=${this.playerId} floor=${this.floor}->${target}`);
    }
    this._applyStats(carried, dest);
    // AFTER the stats, always: setPlayerHp clamps to p.maxHp, so a room whose
    // maxHp is still the class baseline would silently cut the player's HP down
    // to it and never raise it back — setPlayerStats never raises current HP.
    dest.setPlayerHp(this.socket.id, was.hp);
    if (carryWindows && typeof dest.restoreSkillWindows === 'function') {
      dest.restoreSkillWindows(this.socket.id, carryWindows);
    }

    this.floor = target;
    this.room = dest;
    // Which move this is. The asynchronous half below reads it back to find out
    // whether it is still describing where the player is.
    const seq = ++this._moveSeq;
    if (!INSTANCED_FLOORS.has(target)) this.socket.join(`floor_${target}`);

    const p = dest.players.get(this.socket.id);
    if (p && pos && dest.canStandAt(pos.x, pos.y)) { p.x = pos.x; p.y = pos.y; }

    this.socket.to(`floor_${target}`).emit('playerJoined', { id: this.socket.id, username: this.username });
    this.socket.to(`floor_${target}`).emit('playerChar', { id: this.socket.id, type: was.type });

    // The client rebuilds a floor from gameStart and nothing else, so a move it
    // did not ask for still has to arrive as one. Sent after the fact, because
    // the caller needs its answer now and the client can afford one tick.
    //
    // And the block that comes back is APPLIED, not merely forwarded. Until now
    // this read the authoritative stats and handed them to the client while the
    // room kept whatever the partial above had given it. It is the belt to that
    // brace: if anything upstream ever puts a session here with stale numbers,
    // this is where the room is corrected, one round trip in.
    this.fullState(null)
      .then((state) => {
        // A second move can land while this read is in flight — a mode
        // deploying an entrant and the run ending underneath them is two moves
        // in the same tick, and world.enterFloor can take the player out from
        // under this one without touching _moveSeq at all. Either way, applying
        // THIS move's answer now would re-seat the stats of a room the player
        // has already left and put the wrong floor's payload on their screen.
        // Whatever moved them last sends its own gameStart.
        if (seq !== this._moveSeq || this.room !== dest) return;
        this._applyStats(state.stats, dest);
        this._emitRaw('gameStart', { ...state, ...this.worldPayload(target, dest) });
      })
      .catch(err => console.error('[session] forceFloor push:', err.message));

    return p || null;
  }

  // The one line both floor-change routes share. Kept on the session because
  // that is what holds `floor`, and guarded because modes are initialised
  // after the first connection can exist.
  _leaveInstance(oldFloor) {
    const m = require('./modes').modes;
    if (m && typeof m.leaveInstanceFloor === 'function') {
      m.leaveInstanceFloor(this.socket.id, oldFloor);
    }
  }

  // ── position ─────────────────────────────────────────────────────────────
  // Written on a timer and on disconnect. Every step would be 40 writes a
  // second per player for a value whose worst-case loss is a few metres of
  // walking.
  async savePosition({ force = false } = {}) {
    if (!this.authed || !this.room) return;
    if (this._savingPos) {
      // Обычный тик — пропустить. Следующий через двадцать секунд напишет
      // координаты СВЕЖЕЕ тех, что стояли бы в очереди.
      if (!force) { sessionClaims.posSkipped++; return; }
      // Выход из игры — дождаться. Другой записи не будет, и пропуск здесь
      // это ровно тот игрок, который вернулся не туда и не с тем HP.
      // Ошибка идущей записи уже записана ею самой, здесь она не нужна.
      try { await this._savingPos; } catch (err) { /* уже в журнале */ }
    }
    const run = this._savePositionNow();
    this._savingPos = run;
    try {
      return await run;
    } finally {
      if (this._savingPos === run) this._savingPos = null;
    }
  }

  async _savePositionNow() {
    // The ONE write in this build that comes out of memory rather than out of
    // a server-owned rule — which makes it the one place the old build's
    // rollback bug could still take root, in a smaller form.
    //
    // login() kicks the previous socket and immediately claims activeSessions;
    // the kicked socket's teardown then runs, and it ends here. Nothing
    // sequenced the two. So: open a second tab, get kicked on the first, walk
    // through a portal on the second — the new floor is persisted inside its
    // own transaction, and then the OLD socket's timer writes the old floor,
    // the old coordinates and the old HP straight over it. Next login lands on
    // the wrong floor with HP the player no longer had.
    //
    // A session that is no longer the account's active one has nothing true
    // left to say about where that account is.
    //
    // ── and the guard has to be checked WHERE THE WRITE IS ────────────────
    // It used to be checked once, here, and then two separate autocommit
    // statements went out through the pool, each of them after an await. Both
    // gaps were losses:
    //
    //   cross-session   a takeover landing between the check and the UPDATE let
    //                   this dead session's floor, coordinates and HP land on
    //                   top of the live one's. Next login: wrong floor, old
    //                   position, old HP. And with two statements rather than
    //                   one, a takeover could land BETWEEN them and leave the
    //                   row holding this session's floor beside the other's HP,
    //                   which is a state neither session was ever in.
    //
    //   same socket     handlers2/world.js writes position inside a transaction
    //                   on a DIFFERENT connection (enterLocation, respawn). A
    //                   timer tick that issues its UPDATE while that transaction
    //                   holds the row lock waits for it and then applies on top
    //                   — the player lands back on the floor they just left.
    //
    // So: one transaction for both writes, the ownership re-checked inside it
    // (after the wait for a connection, which is where the gap actually was),
    // and the floor compared again afterwards. The last one is what catches the
    // lock-wait case, because respawn takes the row lock with setHp BEFORE it
    // changes the session's floor — no check made before the statement can see
    // that coming, and only looking afterwards can.
    const owns = () => activeSessions.get(this.telegramId) === this.socket.id;
    if (!owns()) { sessionClaims.posSkipped++; return; }
    // Two passes at most: the write, and one correction if the floor moved
    // underneath it. Bounded rather than a loop-until-stable, because the thing
    // it is racing is a player walking through portals and that has no end.
    for (let pass = 0; pass < 2; pass++) {
      if (!this.room) return;
      const p = this.room.players.get(this.socket.id);
      if (!p) return;
      const floor = this.floor, x = p.x, y = p.y, hp = p.hp;
      let wrote = false;
      try {
        await txRetry(async (t) => {
          // wrote сбрасывается на КАЖДОЙ попытке: txRetry перезапускает тело
          // после отката, и попытка, которую база откатила, не имеет права
          // оставить после себя «записано» от предыдущей.
          wrote = false;
          if (!owns() || this.floor !== floor) { sessionClaims.posSkipped++; return; }
          await players.savePosition(t, this.playerId, floor, x, y);
          if (hp > 0) await players.setHp(t, this.playerId, hp);
          wrote = true;
        });
      } catch (err) {
        // Раньше здесь было только err.message, и в журнале стояло голое
        // «deadlock detected» — сообщение, по которому нельзя ничего сделать.
        // У ошибки PostgreSQL есть detail, и для 40P01 в нём лежит разбор
        // цикла: оба процесса, обе блокировки и оба запроса.
        sessionClaims.posFailed = (sessionClaims.posFailed || 0) + 1;
        console.error(`[session] savePosition: ${err.message}` +
          (err.code ? ` [${err.code}]` : '') +
          (err.detail ? ` — ${String(err.detail).replace(/\s+/g, ' ').slice(0, 400)}` : '') +
          ` — player=${this.playerId}, позиция и HP не записаны`);
        return;
      }
      if (!wrote) return;                     // superseded before it went out
      if (!owns()) {
        // The account was taken over WHILE this was in flight, so this row may
        // now be sitting on top of the live session's. Nothing here can undo it
        // — the other session owns the account — but it is exactly the event
        // behind "меня закинуло не туда после входа с телефона", and it left no
        // trace at all before this line.
        sessionClaims.posSkipped++;
        console.warn(`[session] savePosition: слот перехвачен во время записи — player=${this.playerId}`);
        return;
      }
      if (this.floor === floor) return;       // still where we said they were
      sessionClaims.posRewritten++;
    }
  }

  // ── teardown ─────────────────────────────────────────────────────────────
  // The old disconnect path had to flush a debounced save, register the write
  // in _pendingFlush so the NEXT login could await it, and hope the ordering
  // held. None of that is needed when the only thing the session holds is a
  // position: there is no unwritten state to race against.
  async close(reason) {
    if (this.authed) {
      // force: это последняя запись этой сессии. См. savePosition выше.
      await this.savePosition({ force: true });
      if (activeSessions.get(this.telegramId) === this.socket.id) {
        activeSessions.delete(this.telegramId);
      }
    }
    this.playerId = null;
    this.room = null;
    return reason;
  }
}

function socketForTelegramId(io, telegramId) {
  const id = activeSessions.get(String(telegramId));
  return id ? io.sockets.sockets.get(id) : null;
}

module.exports = { Session, activeSessions, socketForTelegramId, sessionClaims };
