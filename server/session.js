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

const { tx, txRetry, query } = require('./db');
const players = require('./db/repos/players');
const stats = require('./db/repos/stats');
const items = require('./db/repos/items');
const money = require('./db/repos/money');
const ops = require('./tg-ops');

// telegramId -> socket.id of the live session. Single-session enforcement, the
// one piece of cross-connection state that genuinely has to live in memory
// (it is about sockets, and sockets are per-process). Moves to Redis when a
// second process appears; nothing else here needs to.
const activeSessions = new Map();

class Session {
  constructor(socket) {
    this.socket = socket;
    this.playerId = null;
    this.telegramId = null;
    this.username = null;
    this.banned = false;
    // Where they are. Position is written through to the database on a timer
    // and on disconnect, not on every step — it is the one value where losing
    // the last few seconds costs nothing.
    this.floor = 1;
    this.room = null;
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
    const prev = activeSessions.get(this.telegramId);
    if (prev && prev !== this.socket.id) {
      const old = this.socket.nsp.sockets.get(prev);
      if (old) {
        old.emit('kicked', { reason: 'Вход с другого устройства' });
        old.disconnect(true);
      }
    }
    activeSessions.set(this.telegramId, this.socket.id);

    // Everything the client needs, from the database, in one place. There is
    // no blob to hand back because there is no blob.
    return { ...res, state: await this.fullState() };
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
  async act(name, errEvent, fn) {
    if (!this.authed) return null;
    try {
      return await txRetry(t => fn(t, this.playerId));
    } catch (err) {
      // A domain error carries a message written for the player. Anything else
      // is a bug and must not have its text shown — an internal message in a
      // player's face is both confusing and an information leak.
      if (err && err.userMessage) {
        this.socket.emit(errEvent, { msg: err.userMessage, code: err.code });
        return null;
      }
      console.error(`[act:${name}]`, err);
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
    this.socket.emit('inventorySync', await items.inventoryOf(db, this.playerId));
  }

  async pushBalances(db = null) {
    this.socket.emit('balanceSync', await money.balancesOf(db, this.playerId));
  }

  // Stats AND the room's copy of them, together. This is what replaces
  // 'statsUpdate': the number is computed here and pushed down, where before
  // the client computed it and pushed it up.
  async pushStats(db = null) {
    const st = await stats.of(db, this.playerId);
    if (!st) return null;
    this.socket.emit('statsSync', st);
    if (this.room) this.room.setPlayerStats(this.socket.id, st);
    return st;
  }

  async pushProgress(db = null) {
    const prog = await players.progressOf(db, this.playerId);
    const skills = await players.skillsOf(db, this.playerId);
    this.socket.emit('progressSync', { ...prog, ...skills });
  }

  // ── position ─────────────────────────────────────────────────────────────
  // Written on a timer and on disconnect. Every step would be 40 writes a
  // second per player for a value whose worst-case loss is a few metres of
  // walking.
  async savePosition() {
    if (!this.authed || !this.room) return;
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

module.exports = { Session, activeSessions, socketForTelegramId };
