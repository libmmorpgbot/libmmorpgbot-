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

const { tx, txRetry } = require('./db');
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
  'usePotion', 'useBuffPotion', 'spendUpgrade', 'resetUpgrades', 'rebirth',
  'learnSkill', 'upgradeSkill', 'learnPassive', 'upgradePassive', 'learnAdvSkill',
  'claimQuest', 'completeSpecialQuest', 'claimVipRewards',
  'gramDepositRequest', 'gramWithdrawRequest',
  'clanCreate', 'clanApply', 'clanApprove', 'clanDecline', 'clanKick', 'clanLeave',
  'clanDisband', 'clanStorageDeposit', 'clanStorageGive', 'clanStorageClaim',
  'clanStorageCancel', 'clanStorageUnlock',
  'registerCodexSetItem', 'selectChar', 'respawn',
  // Rewards and purchases. gramShopBuy is a real-money purchase and had no
  // player-log row at all; killReward is the single most common way an item
  // or a coin enters the world.
  'killReward', 'killRewardShare', 'pickupWorldDrop',
  'gramShopBuy', 'starterBonusClaim', 'buyTeleportStone', 'useTeleportStone',
  'seasonBurn', 'seasonBurnAll', 'seasonBurnBook',
  'healParty', 'enterLocation',
]);

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
      this.socket.emit(errEvent, { msg: 'Вы вошли с другого устройства', code: 'session_replaced' });
      return null;
    }
    try {
      const out = await txRetry(t => fn(t, this.playerId));
      // Only the actions that CHANGE something. Logging a read would bury the
      // rows that matter under vipSync and getRating — see WRITE_ACTIONS.
      if (WRITE_ACTIONS.has(name)) plog.log(this.playerId, name, _resultMeta(name, meta, out));
      return out;
    } catch (err) {
      // A domain error carries a message written for the player. Anything else
      // is a bug and must not have its text shown — an internal message in a
      // player's face is both confusing and an information leak.
      if (err && err.userMessage) {
        // A REFUSAL IS RECORDED. This is the hole the market bug fell into:
        // the player was told no, and nobody else was told anything, so "не мог
        // купить лот, и никаких ошибок наш лог не выбил" was literally true.
        // One line per refusal, with the reason the player saw.
        plog.log(this.playerId, `refuse:${name}`, { code: err.code, msg: err.userMessage });
        this.socket.emit(errEvent, { msg: err.userMessage, code: err.code });
        return null;
      }
      console.error(`[act:${name}]`, err);
      plog.log(this.playerId, 'error', { action: name, msg: String(err && err.message || err).slice(0, 300) });
      ops.alertError(`act.${name}`, `Ошибка в обработчике ${name}`, err, {
        player: this.username, telegramId: this.telegramId,
      });
      this.socket.emit(errEvent, { msg: 'Ошибка сервера — попробуйте ещё раз' });
      return null;
    }
  }

  // ── pushes ───────────────────────────────────────────────────────────────
  // The client is told what changed; it never decides. Each of these reads
  // back from the database rather than echoing what the handler thinks it
  // wrote, so a push cannot describe a state the database does not hold.

  async pushItems(db = null) {
    const inv = await items.inventoryOf(db, this.playerId);
    this.socket.emit('inventorySync', inv);
    // A pet is drawn beside its owner on everyone ELSE's screen, and the only
    // way they learn about it is this event. The old build derived it from the
    // save blob the client sent; there is no blob any more, so it comes off
    // the equipment we have just read. Every equip and unequip goes through
    // pushItems, so this is where it changes.
    this.syncPet(inv.equipment);
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
    this.socket.emit('goldSync', { gold: b.gold });
    this.socket.emit('gramBalanceUpdate', { balance: b.gram });
    this.socket.emit('nexumBalanceUpdate', { balance: b.nexum });
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
    // The base figures ride along: applyLevelState reads them, and without
    // them a level-up raised the level on screen while the character stayed as
    // strong as it was at level one.
    this.socket.emit('xpSync', {
      lvl: st.level, xp: st.xp, xpNext: st.xpNext,
      baseAtk: st.baseAtk, baseDef: st.baseDef, baseMaxHp: st.baseMaxHp,
    });
    if (this.room) this.room.setPlayerStats(this.socket.id, st);
    return st;
  }

  async pushProgress(db = null) {
    const prog = await players.progressOf(db, this.playerId);
    const skills = await players.skillsOf(db, this.playerId);
    this.socket.emit('progressSync', { ...prog, ...skills });
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
      bonusSP: p.bonusSP, keptSP: p.keptSP, rebirths: p.rebirths,
      starterBonus: !!p.starterBonusClaimed,
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

    this.room.removePlayer(this.socket.id);
    this.socket.to(`floor_${this.floor}`).emit('playerLeft', { id: this.socket.id });
    if (!INSTANCED_FLOORS.has(this.floor)) this.socket.leave(`floor_${this.floor}`);

    // `was` is the room record being left, which carries whatever it was given
    // — undefined, until this fix. The session is the source.
    const clan = this.clan || null;
    dest.addPlayer(this.socket.id, this.username, clan && clan.name, clan && clan.icon,
      (clan && clan.atkBonus) || 0, this.telegramId, clan && clan.clanId);
    dest.setPlayerChar(this.socket.id, was.type);
    dest.setPlayerStats(this.socket.id, {
      level: was.lvl, atk: was.atk, def: was.def, maxHp: was.maxHp,
      critChance: was.critChance, critPower: was.critPower,
      atkSpeed: was.atkSpeed, hpRegen: was.hpRegen, skillPct: was.skillPct,
    });
    dest.setPlayerHp(this.socket.id, was.hp);

    this.floor = target;
    this.room = dest;
    if (!INSTANCED_FLOORS.has(target)) this.socket.join(`floor_${target}`);

    const p = dest.players.get(this.socket.id);
    if (p && pos && dest.canStandAt(pos.x, pos.y)) { p.x = pos.x; p.y = pos.y; }

    this.socket.to(`floor_${target}`).emit('playerJoined', { id: this.socket.id, username: this.username });
    this.socket.to(`floor_${target}`).emit('playerChar', { id: this.socket.id, type: was.type });

    // The client rebuilds a floor from gameStart and nothing else, so a move it
    // did not ask for still has to arrive as one. Sent after the fact, because
    // the caller needs its answer now and the client can afford one tick.
    this.fullState(null)
      .then(state => this.socket.emit('gameStart', {
        ...state, ...this.worldPayload(target, dest),
      }))
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
  async savePosition() {
    if (!this.authed || !this.room) return;
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
    if (activeSessions.get(this.telegramId) !== this.socket.id) return;
    const p = this.room.players.get(this.socket.id);
    if (!p) return;
    try {
      await players.savePosition(null, this.playerId, this.floor, p.x, p.y);
      if (p.hp > 0) await players.setHp(null, this.playerId, p.hp);
    } catch (err) {
      console.error('[session] savePosition:', err.message);
    }
  }

  // ── teardown ─────────────────────────────────────────────────────────────
  // The old disconnect path had to flush a debounced save, register the write
  // in _pendingFlush so the NEXT login could await it, and hope the ordering
  // held. None of that is needed when the only thing the session holds is a
  // position: there is no unwritten state to race against.
  async close(reason) {
    if (this.authed) {
      await this.savePosition();
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
