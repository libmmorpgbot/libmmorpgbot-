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
const plog = require('./db/repos/playerlog');
const ops = require('./tg-ops');

// ── what gets a log line on success ─────────────────────────────────────────
// Every refusal and every crash is recorded whatever the action was — those are
// the ones somebody asks about later. Successes are recorded only where the
// action MOVED something: an item, money, a listing, a level. act() also wraps
// reads (vipSync, getRating, codexSync, chatHistory) and a row for each of
// those would bury the ones worth reading — the point of the log is that it can
// be scanned while a player is on the phone.
const WRITE_ACTIONS = new Set([
  'marketList', 'marketBuy', 'marketCancel',
  'craft', 'craftAdvSkillBook', 'enhanceItem', 'openLootBox', 'buyPotion', 'sellItem',
  'equipItem', 'unequipItem', 'storageDeposit', 'storageWithdraw',
  'usePotion', 'useBuffPotion', 'spendUpgrade', 'resetUpgrades', 'rebirth',
  'learnSkill', 'upgradeSkill', 'learnPassive', 'upgradePassive', 'learnAdvSkill',
  'claimQuest', 'completeSpecialQuest', 'claimVipRewards',
  'gramDepositRequest', 'gramWithdrawRequest',
  'clanCreate', 'clanApply', 'clanApprove', 'clanDecline', 'clanKick', 'clanLeave',
  'clanDisband', 'clanStorageDeposit', 'clanStorageGive', 'clanStorageClaim',
  'clanStorageCancel', 'clanStorageUnlock',
  'registerCodexSetItem', 'selectChar', 'respawn',
]);

// telegramId -> socket.id of the live session. Single-session enforcement, the
// one piece of cross-connection state that genuinely has to live in memory
// (it is about sockets, and sockets are per-process). Moves to Redis when a
// second process appears; nothing else here needs to.
const activeSessions = new Map();

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

    // The two numbers that size a loot roll, cached for the session — see the
    // constructor for why they are not read per kill.
    await this.refreshVip();

    // Everything the client needs, from the database, in one place. The blob
    // that comes back with it (savedView) is a projection OUT of these tables,
    // never a thing read back in.
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
      const out = await txRetry(t => fn(t, this.playerId));
      // Only the actions that CHANGE something. Logging a read would bury the
      // rows that matter under vipSync and getRating — see WRITE_ACTIONS.
      if (WRITE_ACTIONS.has(name)) plog.log(this.playerId, name);
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
      eventBoss: m.eventBossState ? m.eventBossState() : null,
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

    dest.addPlayer(this.socket.id, this.username, was.clanName, was.clanIcon,
      was.clanAtkBonus, this.telegramId, was.clanId);
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
