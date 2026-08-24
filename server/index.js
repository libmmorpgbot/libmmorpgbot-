const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const helmet = require('helmet');
const compression = require('compression');
const { Server } = require('socket.io');
// Shared with the client so both sides agree on what a facing index means —
// see the 'mv' handler below.
const { NC_FACING, NC_AOE_STYLES } = require('../shared/netcodec');
const mongoose = require('mongoose');
const {
  _sanitizeName, _safeUsername, _sanitizeClanDesc,
  verifyTelegramAuth, verifyTelegramWebApp,
  _verifyAdminToken, _tgEsc,
} = require('./security');
// Splits the hosting bill's one "network egress" number into player downloads,
// the live game stream, and everything else (the database, the Telegram API).
// See server/egress.js — nothing in the game depends on it.
const egress = require('./egress');
const {
  SERVER_INV_MAX, _SANITIZE_MAX, _HP_POTION_IDS, _HP_POTION_HEAL,
  _catalogBase, _unknownItemIds, _canonSavedItem,
  _clampNum, _clampInt, _sanitizeKeyMap,
  _sanitizeSavedStats, calcBM,
} = require('./anticheat');
const {
  MARKET_MAX_PRICE, MARKET_FEE_PCT,
  MARKET_LIST_COOLDOWN_MS,
  _round2, _round7, _canonicalMarketItem, _marketMinPrice,
  _itemSlotOf, _isStackable, _invFindOwned, _invRemove, _invAdd, _invHasRoomFor,
} = require('./inventory');
const { _marketMaxActive, MARKET_VIP_PCT, _marketListingData, _marketHistoryData } = require('./market-helpers');

// ── Why sessions end ─────────────────────────────────────────────────────────
// "Мир перезагружается" is, from the server's side, always the same event: a
// socket went away and the client reconnected — which re-runs selectChar and
// makes gameStart rebuild the whole world on the client. The useful question
// is never "did it reconnect" but "why did the socket go", and socket.io
// answers that precisely, in the `reason` argument the disconnect handler was
// throwing away:
//
//   ping timeout               the client stopped answering engine.io's own
//                              pings for pingTimeout — a real network loss, a
//                              frozen client, or a suspended WebView.
//   transport close            the connection closed under us: the app was
//                              backgrounded/closed, the network dropped, or
//                              something in front of us (a load balancer, a
//                              proxy) cut it.
//   transport error            it broke mid-flight.
//   client namespace disconnect  the CLIENT chose to disconnect — for this
//                              game that is js/network.js's watchdog deciding
//                              the link is dead after 4 unanswered pings, so
//                              a pile of these means the watchdog is firing,
//                              not that the network is failing.
//   server namespace disconnect  we closed it: a duplicate login being kicked,
//                              maintenance mode, the auth timeout.
//   server shutting down       a deploy or a restart, i.e. every session at
//                              once.
//
// Those five outcomes need five different fixes, and they are indistinguishable
// from the outside — which is exactly why this had to stop being a guess.
// Counted rather than logged per-event (a busy server would drown in lines),
// split by whether the session had authenticated and how long it lasted, and
// exposed on /health next to the tick timings. `sinceMs` makes the counts a
// rate rather than a total nobody can interpret.
const _sessionStats = {
  since: Date.now(),
  reasons: new Map(),   // reason -> count
  shortLived: 0,        // authenticated sessions that died inside SHORT_SESSION_MS
  authedEnded: 0,
  totalMs: 0,
};
// A session this short did not end because the player put their phone down.
// It is the shape a reconnect loop makes, and counting it separately means a
// loop shows up as a ratio instead of having to be spotted in a log.
const SHORT_SESSION_MS = 60000;
function _recordSessionEnd(reason, wasAuthed, lifetimeMs) {
  const key = String(reason || 'unknown');
  _sessionStats.reasons.set(key, (_sessionStats.reasons.get(key) || 0) + 1);
  if (!wasAuthed) return;
  _sessionStats.authedEnded++;
  _sessionStats.totalMs += lifetimeMs;
  if (lifetimeMs < SHORT_SESSION_MS) _sessionStats.shortLived++;
}
function _sessionStatsSnapshot() {
  const n = _sessionStats.authedEnded;
  return {
    sinceMs: Date.now() - _sessionStats.since,
    endedAuthed: n,
    shortLived: _sessionStats.shortLived,
    avgSessionS: n ? Math.round(_sessionStats.totalMs / n / 1000) : 0,
    reasons: Object.fromEntries(_sessionStats.reasons),
  };
}

// ── Timers that cannot take the process down ─────────────────────────────────
// A timer callback runs on an empty stack: nothing is above it to catch a
// throw, so it reaches process scope, where uncaughtException (bottom of this
// file) logs it and calls process.exit(1). Every player online loses their
// connection over it, the client wipes the world it was rendering (the
// 'disconnect' handler in js/network.js clears serverEnemies/otherPlayers and
// the Pixi pools) and rebuilds from the reconnect's gameStart — which is
// exactly what "мир сломался и игра перезагрузилась" looks like from a phone.
// Worse, the cause is usually per-player and periodic (one bad savedData blob
// under a 60s autosave), so the restart repeats on a timer and reads as an
// overloaded server rather than as one bug.
//
// safeOn already gives socket handlers this protection; these give it to the
// other half — the scheduled work. A throw is logged with its timer's name and
// swallowed: one broken tick of one timer, not the whole world.
//
// Deliberately NOT applied to the shutdown/exit timer itself (see
// uncaughtException), which must stay a bare setTimeout.
function _safeFire(name, fn) {
  try {
    const ret = fn();
    // An async callback's rejection lands in unhandledRejection instead, which
    // only logs — but it logs without saying which timer it came from, so name
    // it here too.
    if (ret && typeof ret.catch === 'function') ret.catch(err => console.error(`[timer ${name}]`, err));
  } catch (err) {
    console.error(`[timer ${name}]`, err);
  }
}
function safeTimeout(name, fn, ms) {
  return setTimeout(() => _safeFire(name, fn), ms);
}
function safeInterval(name, fn, ms) {
  return setInterval(() => _safeFire(name, fn), ms);
}
const PlayerModel       = require('./models/Player');
const ClanModel         = require('./models/Clan');
const GramTxModel       = require('./models/GramTx');
const MarketListingModel= require('./models/MarketListing');
const SpecialQuestModel = require('./models/SpecialQuest');
const PvpHistoryModel   = require('./models/PvpHistory');
const ChatMessageModel  = require('./models/ChatMessage');
const BossStateModel    = require('./models/BossState');
const GuildWarStateModel = require('./models/GuildWarState');
const Room = require('./game/Room');
const { FLOOR_IDS, FLOOR_REGISTRY } = require('./game/floors');
const registerAdminRoutes = require('./routes/admin');
const registerMarket = require('./handlers/market');
const registerAuth = require('./handlers/auth');
const registerWorld = require('./handlers/world');
const registerPvpmodes = require('./handlers/pvpmodes');
const registerCoopfarm2 = require('./handlers/coopfarm2');
const registerChat = require('./handlers/chat');
const registerQuestseason = require('./handlers/questseason');
const registerItems = require('./handlers/items');
const registerSkills = require('./handlers/skills');
const registerGram = require('./handlers/gram');
const registerCraft = require('./handlers/craft');
const registerClan = require('./handlers/clan');
const createTelegramBot = require('./telegram-bot');
const createDeathBattle = require('./game/death-battle');
const createArena3 = require('./game/arena3');
const createGuildWar = require('./game/guildwar');
const createRace10 = require('./game/race10');
const createFear = require('./game/fear');
const createCoop = require('./game/coop');
const createFarm2 = require('./game/farm2');
const {
  VIP_THRESHOLDS, VIP_BONUSES,
  SEASON_TICKET_XP_PCT, SEASON_TICKET_DROP_PCT, SEASON_TICKET_LIBERTY_PCT,
  ITEM_DEF, CRAFT_MATS, BOX_DEF, ENHANCE_MAX, ENHANCEABLE_SLOTS, isStackableItem,
  codexSetById, codexItemMeetsReq, codexTotalBonus,
  ENEMY_DEF, CHAR_DEF,
  PET_CRAFT_RECIPES, GEAR_CRAFT_RECIPES, GEAR_TIER_CRAFT_RECIPES, MAT_UPGRADE_RECIPES,
  ADV_SKILL_BOOK_CRAFT,
  UNIQUE_SHARDS, UNIQUE_CRAFT_RECIPES,
  CLAN_STORAGE_MIN_DAYS, CLAN_STORAGE_UNLOCK_GOLD,
  TELEPORT_STONE_PRICE, TELEPORT_CAST_MS,
  CLASS_GEAR_SALVAGE_RECIPES, CLAN_MAX_MEMBERS, UPGRADE_RESET_COST, STARTER_BONUS,
  armIndexForLevel,
  DEATH_BATTLE_GRAM_REWARD, deathBattleRewards,
  race10Rewards, race10Liberty,
  WORLD_BOSS_DAYS_MSK, WORLD_BOSS_HOURS_MSK, EVENT_NOTIFY_BEFORE_MS, nextEventStartAt,
  FARM_ENTRY_LEVEL,
  GRAM_MIN_WITHDRAW,
  clanAtkBonusPct, xpToNext, ARM_LEVEL_REQ,
  REBIRTH_LEVEL, REBIRTH_BONUS_SP, rebirthCostFor, skillPointBudget,
  availableSkillPoints, spentSkillPoints, migrateKeptSP,
  SKILL_MAX_LEVEL, PASSIVE_MAX_LEVEL, passiveDefById,
  SKILL_STUDY_COST, SKILL_UPGRADE_COST, SKILL_UPGRADE_CHANCE, ADV_SKILL_STUDY_COST,
  skillBookId, advSkillBookId, passiveBookId, UPGRADE_KEYS, upgradeCost,
  MERCHANT_SHOP, POTION_CAP, CLAN_CREATE_COST, CLAN_LEVELS, questComplete,
  FEAR_MAX_WAVE, COOP_STAGE_LEVELS, QUEST_DEF,
  FARM2_ENTRY_LEVEL, FARM2_PARTY_SIZE, FARM2_DAILY_MINUTES,
  FARM2_LIBERTY_CHANCE,
  SEASON_END_AT, seasonActive,
  SEASON_BURN_POINTS, SEASON_BOOK_BURN_POINTS, SEASON_PRIZES, SEASON_VIP_PRIZE,
  SEASON_ENHANCE_SPECIAL_SLOTS, SEASON_ENHANCE_SPECIAL_POINTS, SEASON_ENHANCE_GEAR_POINTS,
  seasonEnhancePoints, SEASON_ADV_BOOK_POINTS,
  SEASON_REF_POINTS, SEASON_REF_LEVEL,
  SEASON_REBIRTH_POINTS, SEASON_SHOP_POINTS_PER_GRAM, seasonShopPoints,
  SEASON_RATING_MIN_POINTS,
} = require('../shared/definitions');

// enterLocation's generic level gate (see _doEnterLocation) reads from this —
// the arms' own per-key requirements plus every simple "just a level gate,
// no window/queue" special zone folded in next to them, so each new one of
// those doesn't need its own dedicated branch in _doEnterLocation.
const _ZONE_LEVEL_REQ = { ...ARM_LEVEL_REQ, farmZone: FARM_ENTRY_LEVEL };

// ── Coming back to the floor you were standing on ────────────────────────────
// Every new connection starts on the hub, and until now that is where a
// reconnect put you — from anywhere. The floor was already being saved (the
// autosave writes `floor: currentFloor`) and the client sends its own floor in
// every blob; neither was ever read back. So an ordinary mobile drop — the app
// backgrounded past engine.io's 40s of silence, a network handover — rebuilt
// the world on floor 1 and dropped the player at its spawn, which sits in the
// middle of the hub's safe zone. That is the "выкинуло в безопасную зону" half
// of the reload report.
//
// Restored from the DATABASE's copy, never the client's: `floor` rides inside
// the same savedData blob a modified client composes freely, so honouring it
// would be a free teleport onto any floor, past every level gate below. And
// even the stored one is re-checked rather than trusted, because the world can
// have moved on while the player was away — they may have rebirthed back below
// an arm's requirement, or the zone's window may have closed.
//
// Only floors you can STAND on are restorable. The instanced/scheduled ones
// are deliberately absent: pvpArena, race10 and the Death Battle arena all
// treat a disconnect as elimination (see _pvpEliminate), so returning someone
// to an event they are no longer in would be worse than the hub, and Fear has
// its own hall-holding grace path (_fearDisconnectGrace) that runs before this
// one and wins.
const _RESTORABLE_FLOORS = new Set([
  FLOOR_IDS.hub, FLOOR_IDS.left, FLOOR_IDS.top, FLOOR_IDS.bottom, FLOOR_IDS.right,
  FLOOR_IDS.farmZone, FLOOR_IDS.guildWar, FLOOR_IDS.arena,
]);
// floorId -> the key _ZONE_LEVEL_REQ is written in, for the floors that have a
// requirement at all. The arms are already keyed by name in ARM_LEVEL_REQ.
const _FLOOR_KEY = Object.fromEntries(Object.entries(FLOOR_IDS).map(([k, v]) => [v, k]));
function _restoreFloorFor(savedFloor, lvl) {
  const floor = Number(savedFloor);
  if (!Number.isFinite(floor) || !_RESTORABLE_FLOORS.has(floor)) return FLOOR_IDS.hub;
  if (floor === FLOOR_IDS.hub) return FLOOR_IDS.hub;
  // Same level gate the walk-in path applies (_doEnterLocation), re-evaluated
  // against the level they have NOW.
  if ((lvl || 1) < (_ZONE_LEVEL_REQ[_FLOOR_KEY[floor]] || 0)) return FLOOR_IDS.hub;
  // Window-gated zones: only put them back if the zone is still open, exactly
  // as if they were walking in this second.
  if (floor === FLOOR_IDS.guildWar && _gw.phase !== 'live') return FLOOR_IDS.hub;
  if (floor === FLOOR_IDS.arena && !_arenaOpen()) return FLOOR_IDS.hub;
  return floor;
}

// ── Server-side inventory ops for the market ────────────────────────────────
// The item half of every trade used to be entirely client-authoritative: the
// server created/sold/cancelled listings but never touched savedData.inventory,
// trusting the client to splice the item out on listing and to add it back on
// buy/cancel. Two consequences, both exploitable:
//   • nothing verified the seller actually OWNED what they listed — a modified
//     client could list any catalog item it never earned and sell it for real
//     GRAM (unlimited GRAM minting), and
//   • the item only left the seller's saved inventory once the CLIENT's own
//     post-listing save landed, so listing an item and killing the app before
//     that write duplicated it: the save still held the item and the listing
//     was live too. The mirror case lost items instead — a buyer whose
//     marketBought event never arrived (or whose inventory was full) paid GRAM
//     and got nothing, and a cancelled listing whose marketCancelled event was
//     lost destroyed the item outright.
// These mirror js/player.js's invHasSpace/addToInventoryQty/removeFromInventory
// so the server can apply the same change authoritatively. The client still
// applies it optimistically and its next full-array save wins, which keeps the
// two consistent — but the server-side copy means the trade survives a lost
// event or a disconnect mid-trade.
// The four ability slots every class has (SKILL_DEF, js/definitions.js).
const SKILL_SLOTS = ['Q', 'W', 'E', 'R'];






const { _rollMobLoot, _rollFarmZoneLoot, _rollFarm2Loot } = require('./game/loot');

// Bot token — set TG_BOT_TOKEN env var in Railway
const _TG_TOKEN      = process.env.TG_BOT_TOKEN    || '';
const TG_ADMIN_ID  = process.env.TG_ADMIN_ID     || '';   // admin's Telegram chat ID
const GRAM_WALLET  = process.env.GRAM_WALLET      || '';   // TON wallet address for deposits

// ── Maintenance mode ─────────────────────────────────────────────────────────
// In-memory toggle, same convention as _gw/_race10's own open/closed state
// (server/index.js) — not persisted, so a restart always comes back up open.
// While on, only TG_ADMIN_ID may log in (see the `banned` checks inside
// loginTelegramWebApp/loginTelegram below, which this sits right next to);
// everyone else gets the same authError rejection a banned account gets.
let _maintenanceMode = false;
// The admin routes (server/routes/admin.js) live outside this closure and
// both read and write this flag — a get/set pair, not the raw variable, so
// their mutation reaches this binding instead of a disconnected copy.
function _getMaintenanceMode() { return _maintenanceMode; }
function _setMaintenanceMode(v) { _maintenanceMode = v; }

// Disconnects every currently-connected player except TG_ADMIN_ID, mirroring
// /admin/player/:tid/ban's own kick — used when maintenance is switched on so
// nobody is left standing in a world nobody else can rejoin.
function _kickAllForMaintenance() {
  io.sockets.sockets.forEach(s => {
    if (s.data?.telegramId && s.data.telegramId !== TG_ADMIN_ID) {
      s.emit('kicked', { reason: 'Ведутся технические работы' });
      s.disconnect(true);
    }
  });
}
let _tgBotUsername = process.env.TG_BOT_USERNAME  || '';
// server/telegram-bot.js lives outside this closure and both reads and
// writes this cache (once resolved from getMe, or via /tg-botname) — a
// get/set pair, not the raw variable, so its mutation reaches this binding.
function _getTgBotUsername() { return _tgBotUsername; }
function _setTgBotUsername(v) { _tgBotUsername = v; }

// ── Balances ──────────────────────────────────────────────────────────────────
// GRAM and Liberty (Nexum) are real money, and the database is the only place
// that decides what they are. Every movement goes through _incBalance or
// _spendBalance below: one atomic $inc, keyed on the account, whose returned
// value is then adopted everywhere else.
//
// What this replaces: every path used to read a balance, add to it in JavaScript
// and write the whole number back with $set. Two credits landing in the same
// window — a market sale while a deposit is being confirmed, a kill drop while a
// purchase is in flight — each wrote a total computed before the other, so one of
// them simply vanished. A player would watch GRAM arrive and then disappear.
// $inc has no such window: the database applies the delta to whatever it holds
// at that moment, and concurrent deltas add up instead of overwriting.
//
// Two rules follow from this and matter for anything added later:
//   • never write savedData.gramBalance / savedData.nexumBalance with $set —
//     that is what reintroduces the bug. The periodic save deliberately no
//     longer carries either field (see _sanitizeSavedStats, which strips them
//     from the client blob, and the save paths, which no longer add them back).
//   • a spend must use _spendBalance, whose $gte filter makes "can they afford
//     it" and "take it" a single operation. Checking the cached figure first
//     and deducting afterwards is exactly the race this removes.
//
// The Maps below stay as a read cache for display and for spend decisions made
// before the write; they are refreshed from the value the database returns, so
// they can lag but never lead.
const _gramBalanceCache = new Map();

// Same pattern for Nexum. Nexum is server-granted only (mob drops, special-quest
// rewards, admin give) but it also rides along inside the client's saveProgress
// blob, so without an authoritative cache a stale client save could roll back a
// grant the client hadn't observed yet (e.g. a quest/admin nexum award landing
// between two saves). All server-side writers update this map; every persist
// reads nexumBalance from here, never from the client payload.
const _nexumBalanceCache = new Map();

function _balanceCache(field) {
  return field === 'gramBalance' ? _gramBalanceCache : _nexumBalanceCache;
}

// Adds `delta` (negative to subtract) and returns the resulting balance, or
// null if the account could not be found. The returned figure is the database's
// own, post-write, so callers must use it rather than their own arithmetic.
//
// $inc creates the field when it is missing, which is what a brand-new account
// needs; it does throw when savedData itself is null, so the login paths
// initialise savedData to {} before anyone can earn anything.
async function _incBalance(telegramId, field, delta) {
  if (!telegramId || !Number.isFinite(delta) || delta === 0) return null;
  try {
    // An account that only ever pressed /start in the bot has savedData: null
    // (the bot creates the row, the game initialises the object), and a dotted
    // $inc against a null parent throws rather than creating it. That account
    // can still be owed money — it may be someone's referrer, or a seller whose
    // lot was bought — so give it an object first. The filter makes this a
    // no-op for everyone else, i.e. one cheap extra write only in that case.
    await PlayerModel.updateOne(
      { telegramId: String(telegramId), savedData: null },
      { $set: { savedData: {} } },
    );
    const doc = await PlayerModel.findOneAndUpdate(
      { telegramId: String(telegramId) },
      { $inc: { [`savedData.${field}`]: delta } },
      { new: true, projection: { [`savedData.${field}`]: 1 } },
    ).lean();
    if (!doc) return null;
    // Rounded for the cache and for display only — the stored value keeps full
    // precision. Repeated $inc of the 0.0000001 kill drop drifts by ~1e-10 over
    // thousands of hits, far below the seventh decimal anything ever shows.
    const v = _round7(doc.savedData?.[field] ?? 0);
    _balanceCache(field).set(String(telegramId), v);
    return v;
  } catch (err) {
    console.error(`_incBalance(${field}):`, err);
    return null;
  }
}

// Takes `amount` only if the stored balance covers it. Returns the new balance,
// or null when there wasn't enough — in which case nothing was written at all.
// The $gte filter is the whole point: affordability and deduction are one
// operation, so two purchases sent together can't both pass the check.
async function _spendBalance(telegramId, field, amount) {
  if (!telegramId || !Number.isFinite(amount) || amount <= 0) return null;
  try {
    const doc = await PlayerModel.findOneAndUpdate(
      { telegramId: String(telegramId), [`savedData.${field}`]: { $gte: amount } },
      { $inc: { [`savedData.${field}`]: -amount } },
      { new: true, projection: { [`savedData.${field}`]: 1 } },
    ).lean();
    if (!doc) return null;
    const v = _round7(doc.savedData?.[field] ?? 0);
    _balanceCache(field).set(String(telegramId), v);
    return v;
  } catch (err) {
    console.error(`_spendBalance(${field}):`, err);
    return null;
  }
}

// Single-session enforcement: telegramId → socket.id of the active session
const activeSessions = new Map();

// telegramId → in-flight DB-persist promise from a just-disconnected socket.
// A page refresh usually disconnects the old socket (cleanly, fast) well
// before the new page finishes loading and logs back in — by then the old
// socket object is gone, so a login handler has nothing to await against
// even though that socket's debounced save may still be writing to Mongo.
// Any login for this telegramId awaits the pending entry (if any) before
// reading fresh data, so the read can never land ahead of that write.
const _pendingFlush = new Map();

const {
  _VIP_WEAPONS, _VIP_BP,
  pkgPrice, _GRAM_SHOP_PKGS,
  _SHOP_CLASS_WEAPONS, _SHOP_ARMOR_SETS, _shopNewSlots,
  _GRAM_WITHDRAW_FEE_PCT, _STONE_DEFS, _vipLevelItems, _vipGoldReward,
} = require('./shop');

const ROOT = path.join(__dirname, '..');
const {
  jsBundleCode, jsBundleGz, jsBundleEtag,
  JS_BUNDLE_PATH, JS_MAP_PATH, jsBundleMap,
  cssBundle, CSS_PATH,
  INDEX_HTML,
} = require('./assets');
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket'],
  // A silent link (Wi-Fi to LTE handover, a sleeping radio, a suspended
  // WebView) does not close the TCP connection — it just stops delivering, so
  // the heartbeat is the only thing that notices. At 30s/90s the protocol let
  // that state persist for pingInterval + pingTimeout = two minutes, during
  // which the player watched a frozen world without the client even trying to
  // reconnect, and the server kept a ghost in the room for monsters and PvP to
  // hit. 15s/25s brings the worst case to ~40s; js/network.js's own 2s
  // round-trip watchdog usually catches it within 8s, and this is the backstop
  // for the reverse direction (the server noticing a client that is gone).
  pingTimeout: 25000,
  pingInterval: 15000,
  maxHttpBufferSize: 512 * 1024,  // 512 KB max per socket message
});
// Counts the game stream by event name — see the [egress] report below.
egress.attachSockets(io);

// Cross-process fan-out. Everything in this file addresses other players
// through io.to(...).emit(...), and socket.io routes those through its adapter
// — so pointing the adapter at Redis is genuinely all it takes for one process
// to reach a socket connected to another. Left unset it uses the in-memory
// adapter and nothing changes.
//
// This is NOT on its own enough to run a second process: the world lives in
// this process's memory (floorRooms, activeSessions, parties, the arena/race
// queues, the balance caches), and none of that is fan-out. See SCALING.md for
// what has to move first. The hook is here so that when it does, the messaging
// half is already done.
if (process.env.REDIS_URL) {
  let createAdapter, createClient;
  try {
    ({ createAdapter } = require('@socket.io/redis-adapter'));
    ({ createClient } = require('redis'));
  } catch (err) {
    // Explicit rather than a bare MODULE_NOT_FOUND at boot: REDIS_URL being set
    // means somebody intended clustering, and silently continuing single-process
    // would be the wrong kind of quiet.
    console.error('REDIS_URL is set but the adapter packages are missing — ' +
      'run: npm i @socket.io/redis-adapter redis');
    throw err;
  }
  const pub = createClient({ url: process.env.REDIS_URL });
  const sub = pub.duplicate();
  Promise.all([pub.connect(), sub.connect()])
    .then(() => { io.adapter(createAdapter(pub, sub)); console.log('socket.io: redis adapter attached'); })
    .catch(err => { console.error('socket.io: redis adapter failed:', err.message); process.exit(1); });
}

mongoose.connect(process.env.MONGODB_URI, {
  // 10 connections shared by every DB-touching op this process makes —
  // logins, saves, every market/craft/clan-storage handler's awaited
  // read+write, and logPlayer's write on "most kills" (its own comment,
  // fires from _rollMobLoot's item grants) — is a tight ceiling once more
  // than a handful of players are doing any of that at once. Past it,
  // operations queue for a free connection instead of running, which is
  // exactly what a player-facing "завис на секунду" during a busy moment
  // (market buy, a clan storage claim, a save landing) looks like from the
  // inside — nothing crashes, everything just waits its turn. Raised well
  // under any real MongoDB plan's own connection ceiling (even constrained
  // free/shared tiers allow 100+); if this instance's plan caps lower than
  // that, match this number to it rather than the driver ceiling.
  maxPoolSize: 50,
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
})
  .then(() => {
    console.log('MongoDB connected');
    // Repopulate the in-memory global chat from the DB. Runs after connect
    // (not at listen time) because the server starts accepting connections
    // before Mongo is necessarily up — anyone who logs in before this
    // resolves just gets the empty history they'd have got pre-persistence,
    // and the very next login sees the restored one.
    _loadChatHistory();
  })
  .catch(err => console.error('MongoDB connect error:', err));

// Behind Railway's reverse proxy — needed so req.ip reflects the real client
// (used by the admin-login brute-force limiter below), not the proxy hop.
app.set('trust proxy', 1);

// Content-Security-Policy was previously disabled entirely. It's re-enabled
// here as defence-in-depth on top of the existing output escaping. Two
// unavoidable relaxations for this app:
//   • 'unsafe-inline' — index.html has inline <script> blocks and 100+ inline
//     on* handlers.
//   • 'unsafe-eval' + worker-src blob: — PixiJS generates its uniform-sync
//     functions via `new Function` and spins up blob-URL Web Workers; without
//     these the WebGL renderer fails to initialise and the game world renders
//     black. (This is what a first cut of the policy broke.)
// CSP still blocks loading executable script from any origin other than the
// ones whitelisted here and keeps object-src/base-uri locked down via helmet's
// defaults.
//
// frame-ancestors: this app is a Telegram Mini App — on Telegram Web/Desktop
// it's loaded inside a cross-origin <iframe> served from web.telegram.org (not
// a same-origin embed). Helmet's default frame-ancestors 'self' (and the
// matching X-Frame-Options: SAMEORIGIN it used to ship with unchanged) blocks
// that outright with ERR_BLOCKED_BY_RESPONSE — some players hit this, others
// don't, because it only affects the iframe-based Web/Desktop clients, not the
// native mobile app's own WebView. frameguard is disabled below because
// X-Frame-Options can only express a single origin (or none) and would either
// still block Telegram or have to be dropped anyway — frame-ancestors is what
// actually enforces the allow-list in every browser that matters here.
app.use(helmet({
  frameguard: false,
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      scriptSrc:     ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://telegram.org', 'https://cdn.socket.io'],
      scriptSrcAttr: ["'unsafe-inline'"],
      workerSrc:     ["'self'", 'blob:'],
      childSrc:      ["'self'", 'blob:'],
      styleSrc:      ["'self'", "'unsafe-inline'"],
      styleSrcAttr:  ["'unsafe-inline'"],
      // 'https:' (not a fixed domain list) for img/connect: TON Connect talks
      // to whichever bridge server the player's chosen wallet registers (a
      // different https host per wallet, an open/growing set — Tonkeeper,
      // MyTonWallet, etc. — not something this app can enumerate), and pulls
      // each wallet's icon from that wallet's own https host too.
      imgSrc:        ["'self'", 'data:', 'blob:', 'https:'],
      connectSrc:    ["'self'", 'https://cdn.socket.io', 'wss:', 'ws:', 'https:'],
      fontSrc:       ["'self'", 'data:'],
      // The Telegram Login Widget (js/network.js _showTelegramLoginWidget,
      // used by the standalone Android app) embeds its confirm UI in an
      // iframe from oauth.telegram.org — frame-src falls back to child-src
      // otherwise, which only allows 'self'/blob: and would silently block it.
      frameSrc:      ["'self'", 'https://oauth.telegram.org', 'https://telegram.org'],
      frameAncestors: ["'self'", 'https://web.telegram.org', 'https://*.web.telegram.org', 'https://telegram.org', 'https://*.telegram.org'],
    },
  },
}));
// BEFORE compression(), and that order is the whole trick: compression()
// replaces res.write/res.end with its own and calls through to whatever was
// there when it ran — which is this hook. So this counts compressed output,
// i.e. bytes on the wire, which is what the bill counts. Registered after it,
// it would count the uncompressed body and overstate JS/HTML ~3x.
app.use(egress.httpMiddleware);
app.use(compression());
app.use(express.json({ limit: '256kb' }));

const {
  logPlayer, logPlayerErr, _recordPvpHistory,
  PVP_HISTORY_KEEP,
  _logWritesSinceTrim, _pvpHistoryWritesSinceTrim,
} = require('./player-log');


app.get('/health', (req, res) => {
  const dbOk = mongoose.connection.readyState === 1; // 1 = connected
  // Room tick timings alongside the DB state. "Иногда тупит" reports were
  // previously unanswerable because nothing recorded whether the 25ms world
  // loop was actually making its budget; tickOverruns/tickMsMax say so
  // directly. Reading resets the window, so each poll describes the interval
  // since the last one (see Room.stats).
  // The liveness answer itself is public — an uptime monitor has to be able to
  // read it without credentials. The operational detail below it (memory,
  // socket count, tick timings) is only added for an authenticated admin: it
  // says nothing an attacker needs, but it does say precisely when the server
  // is already struggling.
  const brief = { ok: dbOk, db: mongoose.connection.readyState };
  if (!_verifyAdminToken((req.headers.authorization || '').replace('Bearer ', ''))) {
    return res.json(brief);
  }
  const rooms = [];
  // Every floor EXCEPT Fear/Coop reports its one shared Room directly.
  // Their own floorRooms entries are permanently empty placeholders — they
  // exist only so /api/world-map/<id> has bytes to serve — while the runs
  // themselves happen on private Rooms deliberately kept out of that map
  // (see _createFearRoom/_createCoopRoom). Reporting the placeholder is what
  // made this endpoint answer "no rooms with players" while N people were
  // mid-run in Страх, each on their own 40Hz loop: the load being asked
  // about was the only load not shown.
  floorRooms.forEach(r => {
    if (r.floor === FLOOR_IDS.fear || r.floor === FLOOR_IDS.coop) return;
    try { rooms.push(r.stats()); } catch {}
  });
  // One aggregate row per private-instance event instead of N nearly
  // identical ones. Always present, so the floor never silently disappears
  // from the table; instances is 0 when nobody is in there.
  const _aggregateRoomStats = (floorId, liveRooms) => {
    // stats() RESETS its window, so it is read exactly once per room here —
    // calling it twice would hand the second reader a freshly zeroed window.
    const statsList = liveRooms.map(r => { try { return r.stats(); } catch { return {}; } });
    return {
      floor: floorId,
      instances: liveRooms.length,
      players: statsList.reduce((n, s) => n + (s.players || 0), 0),
      enemies: statsList.reduce((n, s) => n + (s.enemies || 0), 0),
      // Worst instance, not the sum: these are parallel loops, so the
      // question "is any run missing its budget" is what a max answers and
      // a total does not.
      tickMsMax: statsList.reduce((n, s) => Math.max(n, s.tickMsMax || 0), 0),
      tickOverruns: statsList.reduce((n, s) => n + (s.tickOverruns || 0), 0),
    };
  };
  rooms.push(_aggregateRoomStats(FLOOR_IDS.fear, _liveFearRooms()));
  rooms.push(_aggregateRoomStats(FLOOR_IDS.coop, _liveCoopRooms()));
  const mem = process.memoryUsage();
  res.json({
    ...brief,
    sockets: io.engine.clientsCount,
    uptimeS: Math.round(process.uptime()),
    heapMb: Math.round(mem.heapUsed / 1048576),
    rssMb: Math.round(mem.rss / 1048576),
    rooms,
    // Why sessions have been ending since this process started — the direct
    // answer to "почему мир перезагружается". See _sessionStats.
    sessions: _sessionStatsSnapshot(),
    // Where the outbound bytes went since this process started — the direct
    // answer to "почему такой счёт за трафик". Cumulative, so two polls a
    // known time apart give a rate; the [egress] log line does that for you
    // every SESSION_REPORT_MS. See server/egress.js.
    egress: egress.snapshot(),
  });
});

// READINESS: "can this process serve a login right now", which /health
// deliberately no longer answers with a status code (see above). 503 here
// means Mongo is unreachable — logins, saves and every DB-backed handler will
// fail until it comes back, while the world itself keeps simulating.
//
// Point dashboards, pager alerts and load-balancer *traffic* decisions at this
// one. Do NOT point a health check that RESTARTS the container at it: killing
// the process cannot reach a database it cannot reach either, and it drops
// every player mid-session to achieve nothing. That misconfiguration is what
// this split exists to make hard to repeat.
app.get('/health/ready', (req, res) => {
  const dbOk = mongoose.connection.readyState === 1;
  res.status(dbOk ? 200 : 503).json({ ok: dbOk, db: mongoose.connection.readyState });
});

// ── World map ────────────────────────────────────────────────────────────────
// The map used to ride inside gameStart: ~132KB (52KB packed grid + ~79KB of
// room JSON) serialized per join. A join is not rare — every socket.io
// reconnect re-runs selectChar, so a phone switching between Wi-Fi and LTE
// paid for the whole map each time, and a redeploy made every client online
// do it within the same second (measured: 150 simultaneous joins stretched a
// 25ms tick to 125ms and pushed p99 latency from 26ms to 146ms).
//
// It is the same bytes for everyone and, because the world generator runs off
// a fixed seed, the same bytes across restarts too. So: serve it once, name it
// by content hash, and let the browser cache do the rest. gameStart now
// carries only mapVersion; the client fetches this URL and, after the first
// time, never asks again.
app.get('/api/world-map/:floor/:ver', (req, res) => {
  const room = floorRooms.get(Number(req.params.floor));
  if (!room) return res.status(503).json({ error: 'not ready' });
  // The version lives in the URL and the response is immutable, so a request
  // naming a different version must not be answered with these bytes — that
  // would poison the cache under the wrong key. It can only happen to a
  // client still running pre-deploy JS, which recovers via the socket
  // fallback below.
  if (req.params.ver !== room.mapVersion) return res.status(404).json({ error: 'stale version' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('ETag', `"${room.mapVersion}"`);
  res.send(room.mapPayload);
});

// Images: cache 30 days — sprites never change between deploys
app.use('/images', express.static(path.join(__dirname, '..', 'images'), { maxAge: '30d', immutable: true }));
// Audio: same treatment — background music/sfx assets don't change between deploys.
app.use('/audio', express.static(path.join(__dirname, '..', 'audio'), { maxAge: '30d', immutable: true }));

// Vendored PixiJS (~456 KB) never changes between deploys, but the catch-all
// static handler below serves it with no explicit caching, so mobile clients
// re-validate the whole file on every load (a wasted round trip and, on a cold
// cache, a full re-download). Serve it immutable with a 1-year TTL so the
// browser skips the request entirely once it's cached.
app.get('/js/pixi.min.js', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(path.join(ROOT, 'js', 'pixi.min.js'));
});

// Vendored TON Connect UI SDK (~445 KB) — same immutable-caching treatment as
// pixi.min.js above, for the same reason (never changes between deploys).
app.get('/js/vendor/tonconnect-ui.min.js', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(path.join(ROOT, 'js', 'vendor', 'tonconnect-ui.min.js'));
});
// The min.js above ends in a //# sourceMappingURL= comment pointing here —
// only fetched by a browser devtools panel, but serve it to avoid a 404.
app.get('/js/vendor/tonconnect-ui.min.js.map', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(path.join(ROOT, 'js', 'vendor', 'tonconnect-ui.min.js.map'));
});

// Single JS bundle, served at a content-addressed path. /bundle.js stays
// answerable for a page that was cached before this change (and for anything
// else pointing at the old name), on the old revalidate-every-time policy.
app.get([JS_BUNDLE_PATH, '/bundle.js'], (req, res) => {
  if (req.headers['if-none-match'] === jsBundleEtag) return res.status(304).end();
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('ETag', jsBundleEtag);
  // Only the hashed path may be cached: the URL is the version, so a change
  // cannot be missed. The legacy name must keep asking.
  res.setHeader('Cache-Control', req.path === JS_BUNDLE_PATH
    ? 'public, max-age=31536000, immutable' : 'no-cache');
  // Setting Content-Encoding ourselves is also what makes compression() skip
  // this response instead of compressing it a second time.
  res.setHeader('Vary', 'Accept-Encoding');
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    res.setHeader('Content-Encoding', 'gzip');
    return res.send(jsBundleGz);
  }
  res.send(jsBundleCode);
});

// HTML/CSS: no cache so updates are picked up immediately.
//
// Served from an ALLOWLIST, not from the repository root. Mounting the root
// published every file in the project: server/index.js and server/security.js
// in full, the models, the audit documents — and /.git, from which the entire
// history (and anything ever committed to it) can be reconstructed. Nothing
// about the game needed any of that; it was the default that came with
// pointing express.static at '..'.
//
// Everything the client actually asks for either has its own route above
// (/bundle.js, /images, /audio, the pixi and tonconnect vendor files) or is
// named here. A file that is not on this list is not public.
const PUBLIC_FILES = {
  '/':                        'index.html',
  '/index.html':              'index.html',
  '/guide.html':              'guide.html',
  '/admin.html':              'admin.html',
  '/tonconnect-manifest.json':'tonconnect-manifest.json',
};
app.get(Object.keys(PUBLIC_FILES), (req, res) => {
  // index.html is the one page that must never be cached: it is what carries
  // the hashed names of everything else, so it is how a deploy is noticed.
  if (PUBLIC_FILES[req.path] === 'index.html') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    return res.send(INDEX_HTML);
  }
  res.sendFile(path.join(ROOT, PUBLIC_FILES[req.path] || 'index.html'), err => {
    if (err) res.status(404).end();
  });
});
// The source map, at a hashed path of its own so it is as cacheable as the
// bundle. Nothing requests it unless devtools is open.
app.get(JS_MAP_PATH, (req, res) => {
  if (!jsBundleMap) return res.status(404).end();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(jsBundleMap);
});

// The hashed stylesheet — cacheable forever for the same reason the bundle is.
app.get(CSS_PATH, (req, res) => {
  res.setHeader('Content-Type', 'text/css; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(cssBundle);
});
// The un-hashed path stays answerable for anything still pointing at it
// (guide.html, admin.html, a cached page from before this change).
app.use('/css', express.static(path.join(ROOT, 'css')));

app.get('/tg-botname', (req, res) => {
  if (_tgBotUsername) return res.json({ username: _tgBotUsername });
  // Retry fetch once in case startup request is still in-flight
  fetch(`https://api.telegram.org/bot${_TG_TOKEN}/getMe`)
    .then(r => r.json())
    .then(d => {
      if (d.ok) { _tgBotUsername = d.result.username; res.json({ username: _tgBotUsername }); }
      else res.status(503).json({ error: 'bot not resolved' });
    })
    .catch(() => res.status(503).json({ error: 'bot not resolved' }));
});

// ── Local development login ───────────────────────────────────────────────────
// Only ever mounted by dev/local.js (which sets DEV_LOCAL=1 alongside a
// throwaway MONGODB_URI and its own dummy TG_BOT_TOKEN) — in every normal
// deployment this route does not exist at all.
//
// The game authenticates with Telegram Mini App initData, which a desktop
// browser opened outside Telegram simply doesn't have, so there is nothing to
// log in with locally. Rather than add a bypass to the login handler, this
// signs a real initData with the same HMAC Telegram uses (verifyTelegramWebApp
// above validates it like any other): the local browser then goes through the
// unmodified loginTelegramWebApp path. With the dev token that signature is
// worthless anywhere else — a production server, holding the real bot token,
// rejects it.
if (process.env.DEV_LOCAL === '1' && process.env.NODE_ENV !== 'production') {
  console.log('DEV_LOCAL: /dev/init-data enabled (local browser login)');
  app.get('/dev/init-data', async (req, res) => {
    const username = String(req.query.dev || 'dev').slice(0, 32).replace(/[^\w-]/g, '') || 'dev';
    // Reuse the seeded account's id when the name matches one, so
    // /?dev=hero always lands on the same character; anything else gets a
    // stable id derived from the name, i.e. a new account on first use that
    // is still the same account on every later run.
    const doc = await PlayerModel.findOne({ username }, 'telegramId').lean().catch(() => null);
    const telegramId = doc
      ? doc.telegramId
      : '9' + parseInt(crypto.createHash('sha1').update(username).digest('hex').slice(0, 10), 16)
          .toString().slice(0, 9);
    const user = { id: Number(telegramId), username, first_name: username };
    const params = new URLSearchParams({
      user: JSON.stringify(user),
      auth_date: String(Math.floor(Date.now() / 1000)),
      query_id: 'DEV',
    });
    const checkStr = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(_TG_TOKEN).digest();
    params.set('hash', crypto.createHmac('sha256', secret).update(checkStr).digest('hex'));
    res.json({ initData: params.toString(), user });
  });

  // Opens the Кровавая Башня registration window on the spot, with a short
  // registration period, so the event can actually be played through locally
  // instead of only at 20:30 Moscow time. Same gate as the login helper above:
  // this route does not exist in a normal deployment.
  app.post('/dev/race10/open', (req, res) => {
    const regMs = Math.max(1000, Math.min(Number(req.query.reg) || 5000, 300000));
    _race10OpenWindow(Date.now(), regMs);
    res.json({ ok: true, regMs, startsAt: _race10.startAt });
  });

  // The live boss's enemy id, so a test client can hit the thing the payout
  // rule is written against. A real client learns this from the enemy stream
  // it decodes; the harness speaks the protocol but does not render, so it
  // has no other way to name the boss.
  app.get('/dev/race10/state', (req, res) => {
    res.json({
      live: _race10.live, bossId: _race10.bossId,
      dmg: Object.fromEntries(_race10.dmg), alive: _race10.alive.size,
    });
  });

  // The registration queue in order. The order is the queue — _race10Start
  // takes the first `capacity` — so it is the thing a fairness test has to be
  // able to read.
  app.get('/dev/race10/queue', (req, res) => {
    res.json({ names: [..._race10.queue.values()].map(v => v.name), size: _race10.queue.size });
  });

  // Ends the current race the way its own clock would, awarding the win to
  // whoever has dealt the most damage — the same _race10Finish path a real
  // ending takes, just without waiting out RACE10_MAX_MS.
  app.post('/dev/race10/finish', (req, res) => {
    if (!_race10.live) return res.status(409).json({ error: 'no race running' });
    let winnerId = null, best = 0;
    _race10.dmg.forEach((d, sid) => { if (d > best) { best = d; winnerId = sid; } });
    _race10Finish(winnerId, true);
    res.json({ ok: true, winnerId, best });
  });

  // Same idea, for Death Battle (Битва на смерть): opens registration on the
  // spot with a short window instead of waiting for the next scheduled slot,
  // so the deploy/eliminate/finish flow (arena floor join, return-to-
  // previous-floor) can actually be exercised locally/in the harness.
  app.post('/dev/deathbattle/open', (req, res) => {
    const regMs = Math.max(500, Math.min(Number(req.query.reg) || 2000, 300000));
    _dbOpenReg(Date.now() + regMs);
    res.json({ ok: true, regMs, startAt: _db.startAt });
  });

  // Same idea, for the 3v3 arena: opens registration on the spot instead of
  // waiting for the 21:00 MSK window. Unlike the other two there is no
  // separate "start" timer to short-circuit — arena3Register already tries
  // a deploy itself the moment enough people are queued (_a3TryStartSafe),
  // so this alone is enough to exercise the flow locally/in the harness.
  app.post('/dev/arena3/open', (req, res) => {
    _a3OpenWindow(Date.now());
    res.json({ ok: true });
  });
}

// One permanent Room per location (see server/game/floors.js's
// FLOOR_REGISTRY) — pre-created at startup, never destroyed. Players move
// between them via a real floor transition (see enterLocation below)
// instead of the old single-shared-grid world this replaced.
const floorRooms = new Map();




// Retired item ids → their replacement. An id that leaves the catalog takes
// every copy of that item with it: _canonSavedItem returns null for an unknown
// id, the sanitizer filters those out, and since a save that SHRINKS is
// legitimate by design (_censusOverflow only looks for growth) the loss is
// accepted silently on both sides. That is a live hazard for any future
// rename or merge of a catalog entry, so renames belong here rather than in a
// migration script: one line keeps every existing copy alive.
// Empty today — nothing has been renamed yet.
const _ITEM_ID_ALIASES = Object.create(null);




// Adds season points to ANY account by telegramId, online or not. The
// per-socket _seasonAddPoints below is the same write for the player holding
// the socket; this one exists because the referral bonus is paid to someone
// else, who is usually not the one who triggered it.
async function _seasonAddPointsTo(telegramId, n, reason, meta) {
  if (!telegramId || !Number.isFinite(n) || n <= 0 || !seasonActive()) return null;
  try {
    const doc = await PlayerModel.findOneAndUpdate(
      { telegramId: String(telegramId) },
      { $inc: { 'savedData.seasonPoints2': n } },
      { new: true, projection: { 'savedData.seasonPoints2': 1, username: 1 } },
    ).lean();
    if (!doc) return null;
    const total = Math.max(0, Math.floor(Number(doc?.savedData?.seasonPoints2) || 0));
    logPlayer(telegramId, doc.username, 'season_points', { add: n, total, reason, ...(meta || {}) });
    return total;
  } catch (err) { console.error('_seasonAddPointsTo:', err); return null; }
}









// Escape user input before embedding it in a Mongo $regex, so a crafted query
// can't inject regex operators (ReDoS / catastrophic backtracking on the DB).
function _escapeRegex(s) { return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Chat "translate" button (js/network.js's _chatTranslateRow) — Google
// Translate's public web endpoints, the same ones translate.google.com and
// the Chrome dictionary extension call. No API key/account needed, but they
// are undocumented endpoints, not the billed Cloud Translation API: Google
// rate-limits them PER IP, and every player's click leaves from this one
// server IP. A burst of them earns an HTTP 429 (sometimes a 403), which is
// what used to surface in chat as a bare "Не удалось перевести" with nothing
// in the logs to say why. Hence, below: a cache so repeated text never asks
// twice, a retry, a second endpoint, and an error that names the status.
//
// sl=auto lets Google detect the source language instead of us guessing it
// from arbitrary chat text.
const _TRANSLATE_TIMEOUT_MS = 5000;
// Chat repeats itself — greetings, "gg", the same question asked all evening
// — and each hit here is one request that never reaches Google, which is the
// cheapest way to stay under the rate limit. Keyed by target language + the
// exact (already length-capped) text; oldest entry evicted at the cap.
const _TRANSLATE_CACHE_MAX = 500;
const _translateCache = new Map();
// Tried in order until one answers with a non-empty translation. Different
// hosts and client ids, deliberately: when the throttle hits one of them the
// other is usually still answering.
const _TRANSLATE_SOURCES = [
  {
    name: 'gtx',
    url: (text, lang) => 'https://translate.googleapis.com/translate_a/single'
      + '?client=gtx&sl=auto&tl=' + encodeURIComponent(lang) + '&dt=t&q=' + encodeURIComponent(text),
    // [[[translatedChunk, originalChunk, ...], ...], null, sourceLang]
    parse: data => (Array.isArray(data) && Array.isArray(data[0]) ? data[0] : [])
      .map(c => (Array.isArray(c) ? c[0] : null))
      .filter(v => typeof v === 'string').join(''),
  },
  {
    name: 'dict-chrome-ex',
    url: (text, lang) => 'https://clients5.google.com/translate_a/t'
      + '?client=dict-chrome-ex&sl=auto&tl=' + encodeURIComponent(lang) + '&q=' + encodeURIComponent(text),
    // [[translated, sourceLang], ...] — a different shape from the one above,
    // which is exactly why each source parses its own response.
    parse: data => (Array.isArray(data) ? data : [])
      .map(c => (Array.isArray(c) ? c[0] : c))
      .filter(v => typeof v === 'string').join(''),
  },
];
// Worth asking the same endpoint again: a throttle or a hiccup, not a refusal.
const _TRANSLATE_RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

async function _translateOnce(src, text, targetLang) {
  // Without a deadline a hung request never settles, and the chat bubble that
  // asked sits on "…" for the rest of the session.
  const res = await fetch(src.url(text, targetLang), { signal: AbortSignal.timeout(_TRANSLATE_TIMEOUT_MS) });
  if (!res.ok) {
    // The body is what distinguishes "too many requests from this IP" from a
    // consent/captcha page, and it is the one thing the old error dropped.
    const body = await res.text().catch(() => '');
    const err = new Error(`${src.name} http ${res.status}: ${body.slice(0, 120).replace(/\s+/g, ' ')}`);
    err.status = res.status;
    throw err;
  }
  return src.parse(await res.json());
}

async function _translateText(text, targetLang) {
  const key = targetLang + '\n' + text;
  if (_translateCache.has(key)) {
    // Re-insert so the most recently used entry is the last one out.
    const hit = _translateCache.get(key);
    _translateCache.delete(key);
    _translateCache.set(key, hit);
    return hit;
  }
  let lastErr = null;
  for (const src of _TRANSLATE_SOURCES) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const out = await _translateOnce(src, text, targetLang);
        // An empty string is a failure dressed as success — it used to reach
        // the player as a blank translation line under their message.
        if (out) {
          _translateCache.set(key, out);
          if (_translateCache.size > _TRANSLATE_CACHE_MAX) {
            _translateCache.delete(_translateCache.keys().next().value);
          }
          return out;
        }
        lastErr = new Error(src.name + ': empty translation');
        break;
      } catch (err) {
        lastErr = err;
        // Only a throttle/hiccup is worth a second try at the same endpoint;
        // anything else goes straight to the next source.
        if (attempt === 0 && _TRANSLATE_RETRY_STATUS.has(err.status)) {
          await new Promise(r => setTimeout(r, 400));
          continue;
        }
        break;
      }
    }
  }
  throw lastErr || new Error('translate failed');
}


// Progress writer. The two real-money balances are structurally excluded here
// rather than merely omitted by every caller: this function takes a whole blob
// (`{..._lastStats}`, the sanitized client save), and one future field slipping
// into that blob would silently turn a periodic progress save back into an
// absolute balance write — which is the entire bug the $inc migration removed.
// Balances move only through _incBalance/_spendBalance.
const _BALANCE_FIELDS = ['gramBalance', 'nexumBalance'];
// Returns the write promise so callers that need the persist to actually
// land before proceeding (see socket.data._flushNow above) can await it;
// existing fire-and-forget call sites are unaffected since they don't.
//
// A failed write used to vanish here with a bare `.catch(() => {})` — total
// silence, no log line, nothing. Every progress field funnels through this
// one function: the 3s save debounce, the 60s autosave, every level-up
// (_grantXp), every item grant (_commitServerItems), and critically the
// flush a device-switch kick or a disconnect registers in _pendingFlush,
// which the NEXT login on this account explicitly awaits before its own DB
// read (_claimSession) — so a DB hiccup spanning that one write was enough
// to make an entire session's worth of honestly-earned progress (a farm run
// left going for hours, say) never reach the database at all, and the next
// login would read back whatever was there before it. Nothing in the logs
// ever said why, which is what made "I farmed for hours and it's gone"
// unanswerable. One retry after a short delay covers a blip (a failover, a
// dropped pool connection) without risk: every field here is a plain $set of
// an absolute value pulled from the session's own live state, so re-sending
// the exact same write a moment later is always safe to repeat.
async function _persistSavedFields(authed, fields, extra) {
  if (!authed) return;
  const set = {};
  Object.keys(fields).forEach(k => {
    if (fields[k] === undefined || _BALANCE_FIELDS.includes(k)) return;
    set[`savedData.${k}`] = fields[k];
  });
  if (extra) Object.keys(extra).forEach(k => { set[k] = extra[k]; });
  try {
    return await PlayerModel.findByIdAndUpdate(authed._id, { $set: set });
  } catch (err) {
    console.error(`[_persistSavedFields] write failed telegramId=${authed.telegramId}, retrying once:`, err);
    await new Promise(r => setTimeout(r, 400));
    try {
      return await PlayerModel.findByIdAndUpdate(authed._id, { $set: set });
    } catch (err2) {
      console.error(`[_persistSavedFields] retry also failed telegramId=${authed.telegramId} — progress NOT saved:`, err2);
      return null;
    }
  }
}

// Last-resort delivery: append items straight to the stored inventory when
// there is no live session to hand them to (a market purchase whose buyer
// reconnected and then vanished, a death-battle prize, VIP rewards). Never
// refuses — dropping an item the player has already paid for is the one
// outcome worse than an oversized inventory.
//
// But an oversized inventory is not harmless either, and nothing used to say
// when it happened: past SERVER_INV_MAX the client's own invHasSpace() is
// false forever, so world drops stop being picked up and every market
// cancellation starts failing its room check. So the push still goes through
// and the overflow is recorded, loudly, with the reason that caused it —
// which is what makes such an account findable and trimmable instead of
// quietly broken.
async function _dbPushInventory(authed, items, reason) {
  const list = (Array.isArray(items) ? items : [items]).filter(Boolean);
  if (!authed || !list.length) return false;
  try {
    const doc = await PlayerModel.findByIdAndUpdate(
      authed._id,
      { $push: { 'savedData.inventory': { $each: list } } },
      { new: true, projection: { 'savedData.inventory': 1 } },
    ).lean();
    const len = Array.isArray(doc?.savedData?.inventory) ? doc.savedData.inventory.length : null;
    if (len !== null && len > SERVER_INV_MAX) {
      logPlayer(authed.telegramId, authed.username, 'inv_over_cap',
        { reason, slots: len, cap: SERVER_INV_MAX, added: list.length });
      console.error(`[${reason}] telegramId=${authed.telegramId}: inventory is now ${len} slots, over the ` +
        `${SERVER_INV_MAX} cap — drops and market returns will fail for this account until it is trimmed.`);
    }
    return true;
  } catch (err) {
    console.error('_dbPushInventory:', err);
    return false;
  }
}


// ── Rating tables ────────────────────────────────────────────────────────────
// Both tabs of the rating panel, built at most once every RATING_TTL_MS for
// the whole process instead of once per request.
//
// getRating is a heavy-bucket event, which still allows 40 calls per 5s per
// socket — 8 rebuilds a second from one client, and the clans tab in
// particular is not a small query: it reads EVERY clan document and then a bm
// document for EVERY member of every clan, unbounded, and sorts the result in
// JS. That ran against the same connection pool every progress save shares, so
// a few players idly flipping between the tabs could starve saves and logins
// while nothing looked wrong anywhere. A leaderboard does not need to be
// fresher than a minute; anyone's own live rank is still computed per request
// (see getRating), so the one number a player watches is never stale.
//
// In flight requests share a single promise, so N callers arriving during a
// rebuild queue behind it instead of each starting their own.
const RATING_TTL_MS = 60000;
const _ratingCache = { players: { at: 0, rows: [], p: null }, clans: { at: 0, rows: [], p: null } };
function _cachedRating(key, build) {
  const slot = _ratingCache[key];
  if (slot.p) return slot.p;
  if (Date.now() - slot.at < RATING_TTL_MS) return Promise.resolve(slot.rows);
  slot.p = build()
    .then(rows => { slot.rows = rows; slot.at = Date.now(); return rows; })
    // Keep serving the last good table on a failed rebuild rather than
    // blanking the panel, and let the next caller retry immediately.
    .catch(err => { console.error('rating rebuild:', err); return slot.rows; })
    .finally(() => { slot.p = null; });
  return slot.p;
}

function _ratingPlayers() {
  return _cachedRating('players', async () => {
    // 'savedData.lvl', not 'savedData': the whole blob carries the player's
    // inventory, equipment and every counter — tens of KB each, fetched and
    // BSON-decoded 50 at a time purely to read one number off it.
    const players = await PlayerModel.find({}, 'username bm savedData.lvl savedData.level')
      .sort({ bm: -1 }).limit(50).lean();
    return players.map(p => ({
      username: p.username,
      bm: p.bm || 0,
      level: p.savedData?.lvl || p.savedData?.level || 1,
    }));
  });
}

// Capped as well as cached. Ranking by summed member BM means every clan has
// to be read to rank any of them, so the cap is on the WIDEST reasonable
// candidate set rather than on the answer: the top RATING_CLAN_SCAN clans by
// level/xp (the clan collection's own existing sort key) are the only ones
// that could plausibly hold a top-50 total, and it bounds the second query's
// $in list at the same time.
const RATING_CLAN_SCAN = 300;
function _ratingClans() {
  return _cachedRating('clans', async () => {
    const clans = await ClanModel.find({}, 'name icon members')
      .sort({ level: -1, xp: -1 }).limit(RATING_CLAN_SCAN).lean();
    // One query for every clan's members instead of one aggregate per clan
    // in a loop: at a few dozen clans the old shape queued thousands of
    // aggregations against the same connection pool everyone's saves share.
    const memberIds = [...new Set(clans.flatMap(c => (c.members || []).map(m => m.telegramId)))];
    const bmDocs = memberIds.length
      ? await PlayerModel.find({ telegramId: { $in: memberIds } }, 'telegramId bm').lean()
      : [];
    const bmByTid = new Map(bmDocs.map(d => [d.telegramId, d.bm || 0]));
    const rows = [];
    for (const clan of clans) {
      if (!clan.members?.length) continue;
      rows.push({
        name: clan.name,
        icon: clan.icon,
        memberCount: clan.members.length,
        totalBm: clan.members.reduce((s, m) => s + (bmByTid.get(m.telegramId) || 0), 0),
      });
    }
    rows.sort((a, b) => b.totalBm - a.totalBm);
    return rows.slice(0, 50);
  });
}

// ── Rating leader ─────────────────────────────────────────────────────────────
// Whoever currently sits at #1 in the players rating gets a visible aura in the
// world (js/pixi-world.js). Sorted by bm, the same order getRating uses, so the
// glowing character is always the one at the top of the table players can open
// for themselves. Clients are told a username and nothing else — exactly the
// identity that rating table already shows everyone.
//
// Polled rather than recomputed on every bm change: bm moves on each
// saveProgress (every few seconds, per player), while the leader changes rarely.
// The query rides the existing { bm: -1 } index and reads a single document.
let _topPlayerUsername = null;
const TOP_PLAYER_POLL_MS = 60000;
async function _refreshTopPlayer() {
  try {
    const top = await PlayerModel.findOne({}, 'username').sort({ bm: -1 }).lean();
    const name = top?.username || null;
    if (name === _topPlayerUsername) return;
    _topPlayerUsername = name;
    io.emit('topPlayer', { username: name });
  } catch (err) { console.error('_refreshTopPlayer:', err); }
}

// ── VIP aura roster ───────────────────────────────────────────────────────────
// Usernames of currently-online players at VIP_AURA_MIN_LEVEL or above, so
// every client can draw their aura. Broadcast as a plain username list — the
// same shape/pattern as _topPlayerUsername above — rather than adding a field
// to the per-player gameState entries, because those go through the binary
// codec (shared/netcodec.js) and VIP level changes at most once per purchase;
// paying for it in every world packet, forever, would be absurd.
const VIP_AURA_MIN_LEVEL = 2;
const _vipAuraUsers = new Set();

function _broadcastVipAuras() {
  io.emit('vipAuras', { usernames: [..._vipAuraUsers] });
}

// Called whenever an account's online/VIP state changes (login, logout, a
// GRAM purchase that levels them up). No-ops unless the roster really
// changed, so a login storm doesn't turn into a broadcast storm.
function _setVipAura(username, vipLevel) {
  if (!username) return;
  const should = (vipLevel || 0) >= VIP_AURA_MIN_LEVEL;
  const had = _vipAuraUsers.has(username);
  if (should === had) return;
  if (should) _vipAuraUsers.add(username);
  else _vipAuraUsers.delete(username);
  _broadcastVipAuras();
}

// Global chat history — last CHAT_HISTORY_MAX messages across all floors.
// Unlike clan chat and DMs below, this one is DB-backed (models/ChatMessage):
// the in-memory array stays the hot path every read goes through, and Mongo
// is only touched to write new messages and to repopulate the array at
// startup, so a restart/redeploy no longer wipes the chat everyone sees.
const CHAT_HISTORY_MAX = 50;
const globalChatHistory = [];
// Trimming on every single message would double the write load for no
// benefit — the array is already capped in memory, and the only cost of the
// collection running slightly long is a few extra stored rows.
let _chatWritesSinceTrim = 0;
const CHAT_TRIM_EVERY = 20;

// What clients receive. Strips the Mongo _id carried on entries loaded from
// (or written to) the DB, so the wire shape stays exactly the {username,
// text, time} the client has always parsed and no internal ids leak out.
function _publicChatHistory() {
  return globalChatHistory.map(({ username, text, time }) => ({ username, text, time }));
}

async function _loadChatHistory() {
  try {
    const docs = await ChatMessageModel.find({}, 'username text time')
      .sort({ createdAt: -1 }).limit(CHAT_HISTORY_MAX).lean();
    // Query is newest-first for the limit; the array is oldest-first.
    globalChatHistory.length = 0;
    docs.reverse().forEach(d => globalChatHistory.push({ username: d.username, text: d.text, time: d.time }));
    console.log(`Chat history restored: ${globalChatHistory.length} message(s)`);
  } catch (err) {
    // A failed load must not stop the server coming up — chat simply starts
    // empty for this boot, exactly as it always did before persistence.
    console.error('_loadChatHistory:', err);
  }
}

async function _trimChatHistory() {
  // Deletes exactly the rows past the newest CHAT_HISTORY_MAX, by id. Doing
  // it as a range delete on _id instead would rely on ObjectId ordering
  // matching createdAt ordering — which only holds within one process, since
  // the per-process counter resets on restart.
  const stale = await ChatMessageModel.find({}, '_id')
    .sort({ createdAt: -1 }).skip(CHAT_HISTORY_MAX).lean();
  if (stale.length) {
    await ChatMessageModel.deleteMany({ _id: { $in: stale.map(d => d._id) } });
  }
}

function _recordChat(username, text) {
  const now = new Date();
  const time = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
  const entry = { username, text, time };
  globalChatHistory.push(entry);
  if (globalChatHistory.length > CHAT_HISTORY_MAX) globalChatHistory.shift();
  // Fire-and-forget: chat must never block on (or be lost to) a slow DB.
  ChatMessageModel.create({ username, text, time, createdAt: now })
    .then(doc => {
      // Lets the admin panel's delete-by-index remove the row too, not just
      // the in-memory copy that the next restart would resurrect.
      entry._id = doc._id;
      if (++_chatWritesSinceTrim >= CHAT_TRIM_EVERY) {
        _chatWritesSinceTrim = 0;
        return _trimChatHistory();
      }
    })
    .catch(err => console.error('_recordChat persist:', err));
}

// Clan chat history — last 30 per clan, keyed by clan _id (string). Same
// ephemeral in-memory model as globalChatHistory above (resets on restart,
// no DB persistence) — kept consistent with the rest of this chat system.
// Nothing ever removed a clan's entry here, including when the clan itself
// was disbanded (see the ClanModel.deleteOne in clanLeave/clanDisband), so
// this grew by one row per distinct clan ID ever created for the life of the
// process — the same shape of leak dmHistory below already had fixed. Evict
// the least recently written clan once there are too many, same mechanism.
const clanChatHistory = new Map(); // clanId string -> [{username, text, time}]
const CLAN_CHAT_MAX_CLANS = 2000;
function _recordClanChat(clanId, username, text) {
  const key = String(clanId);
  const now = new Date();
  const time = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
  const arr = clanChatHistory.get(key) || [];
  arr.push({ username, text, time });
  if (arr.length > 30) arr.shift();
  // Re-inserting moves this key to the end of the Map's iteration order, same
  // LRU trick dmHistory uses below.
  clanChatHistory.delete(key);
  clanChatHistory.set(key, arr);
  while (clanChatHistory.size > CLAN_CHAT_MAX_CLANS) {
    clanChatHistory.delete(clanChatHistory.keys().next().value);
  }
}

// Private messages — last 50 per conversation, keyed by the two participants'
// telegramIds sorted into a stable pair key. Also in-memory only, same model
// as above; resolving a conversation by username (not telegramId) works
// whether or not the other party is currently online — only realtime
// *delivery* requires them to be connected (see the privMsg handler).
const dmHistory = new Map(); // "tidA|tidB" -> [{username, text, time}]
// Each conversation holds up to 50 messages and nothing ever removed a
// conversation, so this grew for the life of the process — every pair of
// players who ever exchanged one message, forever. Evict the least recently
// written conversation once there are too many; the history is best-effort
// in-memory state that a restart clears anyway (unlike global chat, which is
// DB-backed).
const DM_MAX_CONVERSATIONS = 2000;
function _dmKey(a, b) { return [String(a), String(b)].sort().join('|'); }
function _recordDm(tidA, tidB, username, text) {
  const key = _dmKey(tidA, tidB);
  const now = new Date();
  const time = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
  const arr = dmHistory.get(key) || [];
  arr.push({ username, text, time });
  if (arr.length > 50) arr.shift();
  // Re-inserting moves this key to the end of the Map's iteration order, which
  // is what makes the eviction below least-recently-used rather than arbitrary.
  dmHistory.delete(key);
  dmHistory.set(key, arr);
  while (dmHistory.size > DM_MAX_CONVERSATIONS) {
    dmHistory.delete(dmHistory.keys().next().value);
  }
}
// Resolves a @nickname to the canonical account, whether or not they're
// currently online (DB lookup, case-insensitive exact match — Telegram
// handles are treated as case-insensitive everywhere else in this app).
// Plain equality + .collation() rather than a case-insensitive regex: Mongo
// can serve this off Player.js's strength:2 collation index on `username`,
// where the regex form was a full collection scan on every call — see the
// comment on that index.
async function _resolveUsername(name) {
  const target = String(name || '').trim().replace(/^@/, '');
  if (!target) return null;
  return PlayerModel.findOne({ username: target }, 'telegramId username')
    .collation({ locale: 'en', strength: 2 }).lean();
}

// ── Party state ───────────────────────────────────────────────────────────────
// partyId -> Map<socketId, username>  (up to 5 members)
const parties     = new Map();
// socketId -> partyId
const playerParty = new Map();
// socketId -> current floor number (for proximity check)
const playerFloorMap = new Map();
// socketId -> Date.now() ms when an in-progress teleport-stone cast
// completes (useTeleportStone, below). Module-level rather than a
// per-connection closure var so _pvpFrozen (which every movement/attack
// handler already gates on) can see it — see _teleportCastFrozen.
const _teleportCasting = new Map();

// Looks up a player's own record on whichever floor they're actually on
// right now, without the caller having to know which Room that is —
// registration for a scheduled event (death battle, …) doesn't require
// being on any particular floor, so deploy-time code that only used to check
// the hub's own Room (back when every reachable zone lived inside it) needs
// this instead.
function _findPlayerAnyFloor(sid) {
  const floor = playerFloorMap.get(sid);
  if (floor == null) return null;
  const room = getRoom(floor);
  return room ? room.players.get(sid) || null : null;
}

// Sends a match/round participant back to the hub for real — the shared exit
// path for 3v3 and Кровавая Башня (an elimination, the round ending under
// everyone still standing). Unlike the death battle's own _dbReturnEntrant,
// neither of those cares where the entrant actually came from: registering
// never required being on any particular floor, but Room.deathBattleReturn
// always sent them to the hub specifically, and this preserves that exactly
// — it's just a real floor change now instead of a position reset within a
// Room they were never really in. socket.data._forceEnterLocation is what
// makes the move even though this may be running from module-level
// scheduling code with no socket of its own.
function _returnToHub(socketId) {
  const sock = io.sockets.sockets.get(socketId);
  if (!sock?.data?._forceEnterLocation?.('hub')) return null;
  const room = getRoom(FLOOR_IDS.hub);
  const p = room ? room.players.get(socketId) : null;
  return p ? { x: p.x, y: p.y } : null;
}

// Arena 3v3 and the Кровавая Башня allow DAILY_DUNGEON_ATTEMPTS runs per UTC
// day — each gets its own savedData field (see the wrapper functions below)
// so their attempt pools are independent. The attempt is consumed on entry,
// not on a successful clear, so dying/failing doesn't refund it. Written
// straight to Mongo by telegramId so it works regardless of which member's
// socket triggered it.
const DAILY_DUNGEON_ATTEMPTS = 3;
function _todayStr() { return new Date().toISOString().slice(0, 10); }

// Consuming an attempt is ONE update, expressed as an aggregation pipeline so
// the "is the stored record still today's?" decision happens inside the same
// atomic document write as the increment. The previous read-then-$set version
// lost increments whenever two runs started in the same window — a party's
// members all trigger this at once — which handed out more runs per day than
// the limit allows. A pair of conditional updates would still leak one attempt
// in the narrow case of two simultaneous runs being the first of the day.
function _lockDailyAttempt(socketId, field) {
  const s = io.sockets.sockets.get(socketId);
  const tid = s?.data?.telegramId;
  if (tid == null) return;
  const today = _todayStr();
  const path = `savedData.${field}`;
  PlayerModel.updateOne({ telegramId: tid }, [{
    $set: {
      [path]: {
        $cond: [
          { $eq: [`$${path}.date`, today] },
          { date: today, count: { $add: [{ $ifNull: [`$${path}.count`, 0] }, 1] } },
          { date: today, count: 1 },
        ],
      },
    },
  }]).catch(() => {});
}

// An admin-forced Tower open (/admin/race10/open) grants everyone a bonus
// daily attempt on top of RACE10_ATTEMPTS for the day it opens on, so an
// account that already spent today's regular one isn't locked out of this
// extra race. Cumulative across more than one admin open the same day;
// rolls back to 0 the moment the UTC date changes, same boundary
// _dailyAttemptsLeft's own per-player records reset on (_todayStr).
let _race10BonusDate = null;
let _race10BonusCount = 0;
function _race10BonusReset() {
  const today = _todayStr();
  if (_race10BonusDate !== today) { _race10BonusDate = today; _race10BonusCount = 0; }
}
// /admin/race10/open (server/routes/admin.js) bumps this from outside the
// closure — an increment function it can call, rather than the raw
// reassignable variable, so the bump reaches this binding.
function _getRace10BonusCount() { return _race10BonusCount; }
function _incRace10BonusCount() { return ++_race10BonusCount; }

// How many runs a day each event allows. They share one helper but not one
// pool — the Кровавая Башня has a single start per day now, so a single
// attempt is what makes that start the whole of the opportunity (plus
// whatever _race10BonusCount an admin has granted today).
//
// Read inside the function rather than from a table built up here:
// RACE10_ATTEMPTS/FEAR_ATTEMPTS are declared further down the file, and a
// `const` table evaluated at load time would hit their temporal dead zone
// and take the whole process down on boot.
function _attemptCap(field) {
  if (field === 'race10Attempts') { _race10BonusReset(); return RACE10_ATTEMPTS + _race10BonusCount; }
  if (field === 'fearAttempts') return FEAR_ATTEMPTS;
  if (field === 'coopAttempts') return COOP_ATTEMPTS;
  return DAILY_DUNGEON_ATTEMPTS;
}

async function _dailyAttemptsLeft(socketId, field) {
  const s = io.sockets.sockets.get(socketId);
  const tid = s?.data?.telegramId;
  const cap = _attemptCap(field);
  if (tid == null) return cap;
  try {
    const doc = await PlayerModel.findOne({ telegramId: tid }).select(`savedData.${field}`).lean();
    const rec = doc?.savedData?.[field];
    if (!rec || rec.date !== _todayStr()) return cap;
    return Math.max(0, cap - rec.count);
  } catch (_) { return cap; }
}

function _lockArena3Daily(socketId)                  { _lockDailyAttempt(socketId, 'arena3Attempts'); }
async function _arena3AttemptsLeft(socketId)         { return _dailyAttemptsLeft(socketId, 'arena3Attempts'); }
function _lockRace10Daily(socketId)                  { _lockDailyAttempt(socketId, 'race10Attempts'); }
async function _race10AttemptsLeft(socketId)         { return _dailyAttemptsLeft(socketId, 'race10Attempts'); }
function _lockFearDaily(socketId)                    { _lockDailyAttempt(socketId, 'fearAttempts'); }
async function _fearAttemptsLeft(socketId)           { return _dailyAttemptsLeft(socketId, 'fearAttempts'); }
function _lockCoopDaily(socketId)                    { _lockDailyAttempt(socketId, 'coopAttempts'); }
async function _coopAttemptsLeft(socketId)           { return _dailyAttemptsLeft(socketId, 'coopAttempts'); }

// Элитная фарм-зона's daily cap is minutes actually spent inside, not a
// count of runs — same "$cond on the stored date" atomic-pipeline shape as
// _lockDailyAttempt above, just $add-ing whole minutes instead of +1, and
// read back against FARM2_DAILY_MINUTES instead of a fixed per-field cap.
// Only ever called with small positive integers (the per-minute ticker in
// server/index.js's farm2GroupStart, and the entry-time budget read below),
// so there is no need for _attemptCap's field-keyed dispatch.
function _lockDailyMinutes(socketId, field, minutes) {
  const s = io.sockets.sockets.get(socketId);
  _lockDailyMinutesFor(s?.data?.telegramId, field, minutes);
}
// The same write, addressed by account rather than by socket. A run's last
// minutes are settled when it ENDS (_farm2SettleMinutes, server/game/farm2.js),
// and one of the ways a run ends is the socket disconnecting — by which point
// socket.io has already dropped it from io.sockets.sockets, so the lookup above
// would find nothing and the time would simply not be charged. The run record
// carries the telegramId it started with for exactly this.
function _lockDailyMinutesFor(tid, field, minutes) {
  if (tid == null || !(minutes > 0)) return;
  const today = _todayStr();
  const path = `savedData.${field}`;
  PlayerModel.updateOne({ telegramId: tid }, [{
    $set: {
      [path]: {
        $cond: [
          { $eq: [`$${path}.date`, today] },
          { date: today, minutes: { $add: [{ $ifNull: [`$${path}.minutes`, 0] }, minutes] } },
          { date: today, minutes },
        ],
      },
    },
  }]).catch(() => {});
}
async function _dailyMinutesLeft(socketId, field, cap) {
  const s = io.sockets.sockets.get(socketId);
  const tid = s?.data?.telegramId;
  if (tid == null) return cap;
  try {
    const doc = await PlayerModel.findOne({ telegramId: tid }).select(`savedData.${field}`).lean();
    const rec = doc?.savedData?.[field];
    if (!rec || rec.date !== _todayStr()) return cap;
    return Math.max(0, cap - rec.minutes);
  } catch (_) { return cap; }
}
function _lockFarm2Minutes(socketId, minutes)        { _lockDailyMinutes(socketId, 'farm2Minutes', minutes); }
function _lockFarm2MinutesFor(tid, minutes)          { _lockDailyMinutesFor(tid, 'farm2Minutes', minutes); }
async function _farm2MinutesLeft(socketId)           { return _dailyMinutesLeft(socketId, 'farm2Minutes', FARM2_DAILY_MINUTES); }

// Remove leaverId from their party; notify remaining members.
// If only 1 member remains the party dissolves entirely.
function _removeFromParty(partyId, leaverId) {
  const members = parties.get(partyId);
  if (!members) return;

  // Сотрудничество's party is exactly the two participants (formed by
  // coopGroupStart once the leader launches the run) — there's no way to
  // keep going once it breaks, so losing it ends the run for both the same
  // way a death does. Covers an explicit partyLeave from either side; a
  // disconnect already ends the run immediately on its own
  // (_coopEjectOnDisconnect), well before this could ever be reached
  // through the party's own disconnect-grace timeout.
  _coopEliminate(leaverId);
  // Элитная фарм-зона: same idea, generalized from exactly-2 to "fewer than
  // FARM2_PARTY_SIZE of the run's original participants are still in" — see
  // _farm2Eliminate's own comment. A no-op for anyone not currently on a run.
  _farm2Eliminate(leaverId);

  const leaverName = members.get(leaverId) || leaverId.slice(0, 6);
  members.delete(leaverId);
  playerParty.delete(leaverId);

  const remaining = [];
  members.forEach((name, id) => remaining.push({ id, name }));

  if (remaining.length <= 1) {
    // Party fully dissolves. partyLeft alone used to leave the last member's
    // own partyMembers array (js/network.js) never cleared — its handler
    // explicitly defers clearing to a partyUpdated that, in this branch, was
    // never sent — so their party HUD (drawPartyHUD, js/ui.js) kept showing
    // the departed member's HP bar indefinitely. Sending an empty
    // partyUpdated alongside partyLeft here matches the >1-member branch
    // below and actually clears it.
    parties.delete(partyId);
    remaining.forEach(m => {
      playerParty.delete(m.id);
      io.to(m.id).emit('partyLeft', { leftName: leaverName });
      io.to(m.id).emit('partyUpdated', { members: [] });
    });
  } else {
    // Party shrinks; send notification then updated list to each remaining member
    remaining.forEach(m => {
      io.to(m.id).emit('partyLeft', { leftName: leaverName });
      const othersForM = remaining.filter(r => r.id !== m.id);
      io.to(m.id).emit('partyUpdated', { members: othersForM });
    });
  }
}

// How long a disconnected member's party slot is held before they're actually
// dropped — same reasoning/window as Fear's own reconnect grace
// (FEAR_RECONNECT_GRACE_MS): an ordinary network blip's reconnect (transport
// re-handshake, then loginTelegramWebApp's own DB round trip) routinely eats
// several seconds beyond the client's 8s silence watchdog before it even
// starts, so anything shorter drops the member for real before a perfectly
// ordinary reconnect can land. Kept as its own constant (not shared with
// Fear's) since the two systems have nothing to do with each other.
const PARTY_RECONNECT_GRACE_MS = 45000;
// telegramId -> { partyId, socketId, timer } — a party slot held across a
// disconnect. `socketId` is the now-dead socket still sitting in `parties`/
// `playerParty`; reclaimed onto the reconnecting socket in the login flow
// below (mirrors _fearDisconnectGrace/_fearGraceClaim) or, if the timer
// fires first, actually removed via _removeFromParty.
const _partyDisconnectGrace = new Map();
// Called from the 'disconnect' handler instead of an immediate
// _removeFromParty — holds the slot open rather than dissolving the party
// (or evicting the member) over what may just be a brief drop. Falls back to
// removing immediately when there's no telegramId to reconnect-match against
// (shouldn't happen for an authed session, but leaves nothing orphaned if it
// somehow does).
function _partyHoldOnDisconnect(socketId, telegramId) {
  const partyId = playerParty.get(socketId);
  if (!partyId) return;
  if (!telegramId) { _removeFromParty(partyId, socketId); return; }
  const prior = _partyDisconnectGrace.get(telegramId);
  if (prior) clearTimeout(prior.timer);
  const timer = safeTimeout('partyGrace', () => {
    _partyDisconnectGrace.delete(telegramId);
    _removeFromParty(partyId, socketId);
  }, PARTY_RECONNECT_GRACE_MS);
  _partyDisconnectGrace.set(telegramId, { partyId, socketId, timer });
}

function getRoom(floor) {
  return floorRooms.get(floor) || floorRooms.get(FLOOR_IDS.hub);
}

// Builds the gameStart-shaped payload for a socket that just joined (first
// login/reconnect) or transitioned to (enterLocation) a floor's Room — one
// shared builder so both paths send an identical shape, and so the client's
// _applyGameStart (js/network.js) never has to special-case which one it
// came from.
function _buildGameStartPayload(socket, room, floor) {
  const _selfP = room.players.get(socket.id);
  return {
    floor,
    // The map itself is fetched over HTTP and cached by the browser — see
    // /api/world-map above. Only its name (and now its floor) travels here.
    mapVersion: room.mapVersion,
    spawn: _selfP ? { x: _selfP.x, y: _selfP.y } : undefined,
    enemies: room.enemySnapshot(socket.id),
    bossStatus: room.getBossStatus(),
    // So someone logging in mid-countdown still sees the timer, and someone
    // arriving after the kill still sees loot already lying on the floor.
    // These four event systems are still tied to the hub floor for now (see
    // server/game/floors.js) — reported unconditionally since a socket on
    // any floor may still be registered/mid-run in one of them.
    eventBoss: eventBossState(),
    deathBattle: { ..._dbPublicState(), registered: _db.reg.has(socket.id) },
    race10: { ..._race10PublicState(), registered: _race10.queue.has(socket.id) },
    arena3: { ..._a3PublicState(), registered: _a3.queue.has(socket.id) },
    guildWar: _gwPublicState(),
    // Unlike the three above, Fear has no scheduled window/queue to report
    // when nothing's running — only present at all when a run is live for
    // this socket.
    fear: _fear.has(socket.id) ? { inRun: true, wave: _fear.get(socket.id).wave, maxWave: FEAR_MAX_WAVE } : null,
    // Same "only present when a run is live" shape as Fear above — stage
    // comes from the shared Room (both lanes are always on the same one),
    // not the run record itself.
    coop: (() => {
      const run = _coop.get(socket.id);
      if (!run || !run.room) return null;
      return { inRun: true, stage: run.room.coopStage(), maxStage: COOP_STAGE_LEVELS.length };
    })(),
    // Same "only present when a run is live" shape as Fear/Coop above — a
    // reconnect mid-run needs this to resume the client's own "in the zone"
    // UI state (see js/network.js's _applyGameStart).
    farm2: _farm2.has(socket.id) ? { inRun: true } : null,
  };
}

// ── Event announcements over the bot ────────────────────────────────────────
// Both scheduled events warn everyone EVENT_NOTIFY_BEFORE_MS ahead and again
// the moment they start. Fire-and-forget: a bot that is down or a player who
// blocked it must never hold up (or break) the event itself, so nothing here
// is awaited and every failure is swallowed by tgBroadcastAll's per-message
// catch.
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

// Sends `text` to every registered account over the bot. Paced at 30 messages
// a second because Telegram throttles bulk sends and starts dropping (or
// 429-ing) past roughly that rate. Also used by /admin/broadcast (server/
// routes/admin.js, passed in via deps) for the admin's own manual broadcasts.
async function tgBroadcastAll(text) {
  const players = await PlayerModel.find({}, 'telegramId').lean();
  let sent = 0;
  for (let i = 0; i < players.length; i++) {
    tgApi('sendMessage', { chat_id: players[i].telegramId, text, parse_mode: 'HTML' }).catch(() => {});
    sent++;
    if (i % 30 === 29) await new Promise(r => setTimeout(r, 1000));
  }
  return sent;
}

// Each occurrence is announced at most once per process. _dbSchedule and
// _wbSchedule are both re-entrant (boot, end of a round, a cancelled round),
// so without this a single event could be announced several times over.
const _notifiedEvents = new Set();
function _announceOnce(key, text, where) {
  if (_notifiedEvents.has(key)) return;
  _notifiedEvents.add(key);
  // The set only ever holds a handful of keys per process, but a long-lived
  // one shouldn't grow forever either.
  if (_notifiedEvents.size > 64) {
    _notifiedEvents.delete(_notifiedEvents.values().next().value);
  }
  tgBroadcastAll(text).catch(err => console.error(where, err));
}

function notifyEventSoon(kind, at) {
  const mins = Math.max(1, Math.round((at - Date.now()) / 60000));
  _announceOnce(`${kind}:soon:${at}`, _EVENT_TEXT[kind].soon(mins), 'notifyEventSoon:' + kind);
}

function notifyEventStarted(kind, at) {
  _announceOnce(`${kind}:now:${at}`, _EVENT_TEXT[kind].now(), 'notifyEventStarted:' + kind);
}

// ── Event boss scheduling ───────────────────────────────────────────────────
// The boss appears the moment it is summoned. There used to be a five-minute
// countdown banner in between, which meant the schedule said 20:00 and the
// boss actually turned up at 20:05. The 30-minute "coming soon" broadcast
// (notifyEventSoon below) is the warning now, so the advertised time is the
// time it lands.
//
// spawnAt is kept in the wire shape and pinned at 0: the client still has the
// countdown UI wired to it, and 0 is what tells it there's nothing pending.
function _wbNextStartAt(from = Date.now()) {
  return nextEventStartAt(WORLD_BOSS_DAYS_MSK, WORLD_BOSS_HOURS_MSK, from);
}

function eventBossState() {
  const room = getRoom(FLOOR_IDS.arena);
  return {
    spawnAt: 0,
    alive: !!(room && room.isEventBossAlive()),
    // The Events panel counts down to this, so it has to travel with the rest
    // of the boss state rather than being computed client-side from a
    // schedule copy that could drift.
    nextAt: _wbNextStartAt(),
    drops: room ? room.worldDropSnapshot() : [],
  };
}

function scheduleEventBoss() {
  const room = getRoom(FLOOR_IDS.arena);
  if (!room) return { error: 'Мир ещё не инициализирован' };
  if (room.isEventBossAlive()) return { error: 'Босс уже на карте' };
  const boss = room.spawnEventBoss();
  if (!boss) return { error: 'Не удалось призвать босса' };
  io.to('floor_1').emit('eventBossSpawned', { x: boss.x, y: boss.y });
  return { ok: true, spawnAt: 0 };
}

// Whether the arena is currently reachable via a walk-in pad (the world
// boss's own entry path — Death Battle deploys entrants with force:true and
// never consults this, see _doEnterLocation). Mirrors the client's own
// _evtArenaOpen (js/game.js): up while the boss is alive, and for as long as
// its loot still lies on the floor afterward, so nobody who was already
// fighting gets locked out of collecting a drop.
function _arenaOpen() {
  const room = getRoom(FLOOR_IDS.arena);
  if (!room) return false;
  return room.isEventBossAlive() || room.worldDropSnapshot().length > 0;
}

// Arms the next scheduled summon (понедельник/среда/пятница/воскресенье в
// 20:00 МСК) plus its 30-minute warning. Re-arms itself after each firing.
// setTimeout is capped at ~24.8 days, which every gap here is comfortably
// under, so a single timeout per event is safe.
let _wbSpawnTimer  = null;
let _wbNotifyTimer = null;

function _wbSchedule() {
  clearTimeout(_wbSpawnTimer);
  clearTimeout(_wbNotifyTimer);
  const at = _wbNextStartAt();
  if (!at) return;
  // Only arm the warning if its moment is still ahead. Without this, a
  // restart inside the 30-minute window fires a "coming soon" the instant the
  // process boots — every redeploy would spam everyone.
  const warnIn = at - EVENT_NOTIFY_BEFORE_MS - Date.now();
  if (warnIn > 0) _wbNotifyTimer = safeTimeout('wbNotify', () => notifyEventSoon('boss', at), warnIn);
  _wbSpawnTimer = safeTimeout('wbSpawn', () => {
    const r = scheduleEventBoss();
    // A summon refused because an admin already called the boss (or it is
    // still on the map) is not worth alarming anyone about — just skip the
    // announcement and re-arm for next time.
    if (!r.error) notifyEventStarted('boss', at);
    else console.log('world boss schedule skipped:', r.error);
    _wbSchedule();
  }, Math.max(0, at - Date.now()));
}


function _socketTid(socketId) {
  return io.sockets.sockets.get(socketId)?.data?.telegramId || null;
}

// Moves a queue entry from a dead socket id to the reconnected one WITHOUT
// losing its place in line.
//
// A Map iterates in insertion order, and for the registration queues that
// order is the queue: _race10Start takes the first `capacity` entrants and
// _a3TryStart the first six. The obvious set-then-delete rekey appends, so a
// player whose connection blipped during registration silently went to the
// back — and at 50+ registrants for the Tower's 50 corridors that is the
// difference between racing and being told there was no room. Rebuilding the
// map preserves the position; these queues hold tens of entries at most, so
// the cost is irrelevant next to being fair about who signed up first.
// Hands every pre-match registration this account is holding to its current
// socket, keeping each one's place in line. Called from selectChar on every
// join, so it covers a reconnect however the old socket went away — cleanly
// disconnected, kicked by this very login, or still hanging around as a stale
// room entry. Keyed by telegramId rather than by the old socket id precisely
// because in the common case that id is already gone by the time we get here.
function _reclaimQueues(telegramId, socketId) {
  if (!telegramId) return;
  const each = [[_db.reg, _dbBroadcast], [_a3.queue, _a3Broadcast], [_race10.queue, _race10Broadcast]];
  for (const [map, broadcast] of each) {
    for (const [sid, entry] of map) {
      if (sid === socketId || !entry || entry.tid !== telegramId) continue;
      _rekeyQueue(map, sid, socketId);
      broadcast();
      break;   // one registration per account per event
    }
  }
}

function _rekeyQueue(map, oldKey, newKey) {
  if (!map.has(oldKey)) return false;
  const entries = [...map];
  map.clear();
  for (const [k, v] of entries) map.set(k === oldKey ? newKey : k, v);
  return true;
}


// True while this socket is mid-cast on a teleport stone (useTeleportStone,
// below) — folded into _pvpFrozen so the same movement/attack guards that
// already hold a player still during a PvP pre-fight freeze hold them still
// for the cast too, with no extra per-handler check needed.
function _teleportCastFrozen(socketId) {
  const until = _teleportCasting.get(socketId);
  return until != null && Date.now() < until;
}

// Both PvP modes can hold a player in a pre-fight freeze, and both need to
// know when one goes down; the teleport-stone cast is a third kind of the
// same thing. Every movement/combat path goes through this rather than
// checking each mode separately — adding another one later means changing
// this function, not every attack handler. Each half no-ops for a socket
// that isn't in that mode.
function _pvpFrozen(socketId) {
  return _dbFrozen(socketId) || _a3Frozen(socketId) || _race10Frozen(socketId) || _teleportCastFrozen(socketId);
}
// killerSocketId is only passed by the actual PvP attack handlers below —
// the 'respawn' and disconnect call sites leave it undefined, since dying to
// a monster mid-round (or just leaving) isn't a kill by another player.
// race10 has no player-vs-player damage at all, so it never needs it.
// room is the attacker's Room, only needed to resolve names for the open-world
// fallback below — the three mode-specific eliminates already know names from
// their own alive maps.
//
// opts.fearGrace: true only from the two disconnect-class call sites (the
// real 'disconnect' handler and the stale half of a same-account reconnect)
// — routes the Fear half through _fearHoldOnDisconnect instead of
// _fearEliminate, so an involuntary exit holds the run for a possible
// reconnect instead of ending it on the spot. Every other caller (dying,
// respawn) leaves this unset and gets the immediate, real elimination.
function _pvpEliminate(socketId, killerSocketId, room, opts) {
  const dbHandled = _dbEliminate(socketId, killerSocketId);
  const a3Handled = _a3Eliminate(socketId, killerSocketId);
  const r10Handled = _race10Eliminate(socketId);
  const fearHandled = (opts && opts.fearGrace)
    ? _fearHoldOnDisconnect(socketId, opts.telegramId)
    : _fearEliminate(socketId);
  const coopHandled = (opts && opts.fearGrace)
    ? _coopEjectOnDisconnect(socketId)
    : _coopEliminate(socketId);
  // A PvP kill (setPvpMode duel) that isn't part of any live Death
  // Battle/Arena3/race10/Fear/Coop round falls through all five above
  // untouched — they only record when the victim was in their own alive
  // map. Without this, open-world PvP kills/deaths never appeared in the
  // История tab.
  if (killerSocketId && !dbHandled && !a3Handled && !r10Handled && !fearHandled && !coopHandled) {
    const victimTid = _socketTid(socketId), killerTid = _socketTid(killerSocketId);
    const victim = room?.players.get(socketId);
    const killer = room?.players.get(killerSocketId);
    if (victimTid) _recordPvpHistory(victimTid, 'death', 'open_pvp', killer?.username || null);
    if (killerTid) _recordPvpHistory(killerTid, 'kill', 'open_pvp', victim?.username || null);
  }
}






// Pre-create all floor rooms once MongoDB is reachable. Idempotent so it's
// safe to trigger from more than one path below — _floorRoomsStarted is set
// synchronously (before the first await) so two calls racing in before
// either finishes can't both pass the guard and double-init.
let _floorRoomsStarted = false;
async function _initFloorRooms() {
  if (floorRooms.size > 0 || _floorRoomsStarted) return;
  _floorRoomsStarted = true;
  // Per-arm boss cooldowns survive a restart from here: load whatever was
  // last persisted (see the onBossDeath hook passed to each Room below) so
  // a boss that was mid-cooldown resumes the real remaining time instead of
  // restarting a fresh random 1-2h wait on every deploy.
  const bossDocs = await BossStateModel.find({}).lean().catch(() => []);
  const bossStateByFloor = new Map();
  bossDocs.forEach(d => {
    if (!bossStateByFloor.has(d.floor)) bossStateByFloor.set(d.floor, {});
    bossStateByFloor.get(d.floor)[d.arm] = d.respawnAt;
  });
  // Guild War ownership survives a restart the same way per-arm boss
  // deadlines do (just above) — loaded once here, before any Room exists, so
  // spawnGuildWarTower below can hand the tower its persisted owner instead
  // of starting every restart unowned.
  const gwDoc = await GuildWarStateModel.findOne({ key: 'castle' }).lean().catch(() => null);
  if (gwDoc) {
    _gw.ownerClanId = gwDoc.ownerClanId || null;
    _gw.ownerClanName = gwDoc.ownerClanName || null;
    _gw.ownerClanIcon = gwDoc.ownerClanIcon || null;
    _gw.capturedAt = gwDoc.capturedAt || 0;
  }
  for (const entry of FLOOR_REGISTRY) {
    const f = entry.id;
    const onBossDeath = (arm, respawnAt) => {
      BossStateModel.updateOne({ floor: f, arm }, { $set: { respawnAt } }, { upsert: true })
        .catch(err => console.error('[BossState] persist failed', f, arm, err));
    };
    const room = new Room(f, io, bossStateByFloor.get(f) || {}, onBossDeath);
    if (f === FLOOR_IDS.guildWar) room.spawnGuildWarTower(_gw);
    floorRooms.set(f, room);
  }
  console.log('Floor rooms initialized');
  // Needs Mongo, so it starts here rather than at require time.
  _refreshTopPlayer();
  safeInterval('topPlayer', _refreshTopPlayer, TOP_PLAYER_POLL_MS);
}
// 'open' only ever fires once per connection and never fires at all if
// Mongo wasn't reachable yet at the moment this ran — so the game world
// used to stay permanently uninitialized (every player crashing at
// selectChar) whenever Mongo had a slow/failed cold start. Cover the
// already-connected case immediately, then either wait for 'open' (the
// common fast path) or poll until the connection comes up as a fallback
// for the delayed/retried-connection case.
if (mongoose.connection.readyState === 1) {
  _initFloorRooms();
} else {
  mongoose.connection.once('open', _initFloorRooms);
  const _roomInitRetry = safeInterval('roomInitRetry', () => {
    if (mongoose.connection.readyState !== 1) return;
    clearInterval(_roomInitRetry);
    _initFloorRooms();
  }, 2000);
}

// ── Clan helpers ─────────────────────────────────────────────────────────────
// The live socket for an account. Every clan fan-out used to find this with
// `[...io.sockets.sockets.values()].find(s => s.data.telegramId === ...)` —
// a full copy of the socket table, per member, per notification. activeSessions
// is already the authoritative telegramId -> socketId index; use it.
function _socketForTelegramId(telegramId) {
  const sid = activeSessions.get(telegramId);
  if (!sid) return null;
  return io.sockets.sockets.get(sid) || null;
}

// One bm read for the whole clan. _clanDataFor does this lookup itself, and it
// was being called once per member inside a notification loop — so telling a
// 50-member clan anything meant 50 sequential queries that each read the same
// 50 documents. Split out so a fan-out can do it once and reuse the result.
async function _clanBmMap(clan) {
  const memberIds = clan.members.map(m => m.telegramId);
  const docs = await PlayerModel.find({ telegramId: { $in: memberIds } }, { telegramId: 1, bm: 1 })
    .lean().catch(() => []);
  const bmMap = {};
  docs.forEach(d => { bmMap[d.telegramId] = d.bm || 0; });
  return bmMap;
}

function _clanDataWith(clan, telegramId, bmMap) {
  const myRole = clan.members.find(m => m.telegramId === telegramId)?.role || null;
  return {
    _id:          clan._id,
    name:         clan.name,
    icon:         clan.icon,
    description:  clan.description || '',
    level:        clan.level,
    xp:           clan.xp,
    members:      clan.members.map(m => ({ telegramId: m.telegramId, username: m.username, role: m.role, bm: bmMap[m.telegramId] || 0 })),
    applications: myRole === 'leader' ? clan.applications.map(a => ({ telegramId: a.telegramId, username: a.username })) : [],
    myRole,
  };
}

async function _clanDataFor(clan, telegramId) {
  return _clanDataWith(clan, telegramId, await _clanBmMap(clan));
}

async function _notifyClan(clan) {
  const bmMap = await _clanBmMap(clan);
  for (const m of clan.members) {
    const target = _socketForTelegramId(m.telegramId);
    if (!target) continue;
    target.emit('clanData', _clanDataWith(clan, m.telegramId, bmMap));
    // Membership changes are made on the LEADER's socket, so the member's own
    // connection has no idea it now belongs to a clan. It used to find out
    // only on its next kill, because the per-kill XP path happened to re-read
    // the clan and refresh these — which also meant a freshly approved member
    // ran around with no clan tag over their head until they hit something.
    // Now that the kill path is a pure counter bump, refresh it here, where
    // the member is already being told about the change. Also covers a level-
    // up (this is the only path _flushClanXp goes through), so the new atk%
    // reaches every online member's Room player immediately instead of
    // waiting for their client to happen to recompute() on its own.
    target.data._setClanIdentity?.(clan._id, clan.name, clan.icon, clan.level);
  }
}

// Withdraws every pending application this telegramId has anywhere except
// (optionally) one clan — called whenever their clan status is about to
// change: applying elsewhere, getting approved, or founding their own. Without
// this a stale application could sit in some other clan's queue indefinitely
// and, if that leader later approved it, put the player in two clans at once
// (nothing at the DB level stops that — see server/models/Clan.js).
async function _clearOtherClanApplications(telegramId, exceptClanId = null) {
  const filter = { 'applications.telegramId': telegramId };
  if (exceptClanId) filter._id = { $ne: exceptClanId };
  const others = await ClanModel.find(filter).catch(() => []);
  if (!others.length) return;
  await ClanModel.updateMany(
    { _id: { $in: others.map(c => c._id) } },
    { $pull: { applications: { telegramId } } }
  ).catch(() => {});
  for (const c of others) {
    c.applications = c.applications.filter(a => a.telegramId !== telegramId);
    await _notifyClan(c);
  }
}

// ── Clan XP batching ─────────────────────────────────────────────────────────
// Clan XP is +1 per monster kill. It used to be applied inline on every single
// kill: a findOne on an unindexed embedded field, a full-document clan.save(),
// a second query over every member's bm, and a whole clanData packet — four
// round trips of work for one point, hundreds of times a second across the
// server, all sharing a 10-connection pool with everyone's progress saves.
// That is the single biggest reason ordinary actions would intermittently hang.
//
// Kills now just increment an in-memory counter. A timer folds each clan's
// accumulated points into one atomic $inc, and members only hear about it when
// the level actually changes — which is the only part of it they can see. A
// concurrent $inc is also correct under load in a way clan.save() never was:
// two members of the same clan killing at once each read-modify-wrote the whole
// document, so one of the two increments was simply lost.
const CLAN_XP_LEVELS = [0, 500, 1500, 4000, 10000, 25000, 60000, 150000, 350000, 800000];
const CLAN_MAX_LEVEL = 10;
const CLAN_XP_FLUSH_MS = 20000;
const _clanXpPending = new Map(); // clanId string -> accumulated xp

function _clanXpAdd(clanId, amount) {
  if (!clanId || amount <= 0) return;
  const k = String(clanId);
  _clanXpPending.set(k, (_clanXpPending.get(k) || 0) + amount);
}

async function _flushClanXp() {
  if (!_clanXpPending.size) return;
  const batch = [..._clanXpPending];
  _clanXpPending.clear();
  for (const [clanId, xp] of batch) {
    if (xp <= 0) continue;
    try {
      // level filter mirrors the old early-return: a maxed clan stops earning.
      const clan = await ClanModel.findOneAndUpdate(
        { _id: clanId, level: { $lt: CLAN_MAX_LEVEL } },
        { $inc: { xp } },
        { new: true },
      );
      if (!clan) continue;
      // A batch can carry a clan across more than one threshold at once, which
      // the old one-point-at-a-time path never had to consider.
      let lvl = clan.level;
      while (lvl < CLAN_MAX_LEVEL && clan.xp >= CLAN_XP_LEVELS[lvl]) lvl++;
      if (lvl === clan.level) continue;
      clan.level = lvl;
      await ClanModel.updateOne({ _id: clan._id }, { $set: { level: lvl } });
      // Everyone gets the level-up, not just whoever happened to land the kill
      // that crossed the line — the client shows a toast off exactly this.
      await _notifyClan(clan);
    } catch (err) { console.error('_flushClanXp:', err); }
  }
}
safeInterval('clanXpFlush', () => { _flushClanXp().catch(() => {}); }, CLAN_XP_FLUSH_MS).unref();

// One line every SESSION_REPORT_MS naming why sessions ended in that window,
// so the answer is in the deploy log rather than only behind an authenticated
// /health poll nobody is making at 3am. Silent when nothing disconnected, and
// on stdout rather than stderr — this is a routine measurement, and a hosting
// dashboard paints anything from stderr as an error (see the [move] guard
// lines, which are console.warn and get flagged red for no reason).
//
// Read it as a shape, not as numbers: mostly 'transport close' with long
// average sessions is ordinary mobile churn and nothing to fix. A large
// 'client namespace disconnect' share means js/network.js's own watchdog is
// tearing down healthy links. A large 'ping timeout' share means the link (or
// the client) really is going quiet. 'server shutting down' means the process
// restarted and took everyone with it. shortLived/endedAuthed climbing toward
// 1 is a reconnect loop whatever the reason column says.
const SESSION_REPORT_MS = 5 * 60 * 1000;
let _lastSessionReport = _sessionStatsSnapshot();
safeInterval('sessionReport', () => {
  const now = _sessionStatsSnapshot();
  const delta = {};
  let total = 0;
  for (const [k, v] of Object.entries(now.reasons)) {
    const d = v - (_lastSessionReport.reasons[k] || 0);
    if (d > 0) { delta[k] = d; total += d; }
  }
  const endedAuthed = now.endedAuthed - _lastSessionReport.endedAuthed;
  const shortLived  = now.shortLived  - _lastSessionReport.shortLived;
  _lastSessionReport = now;
  if (!total) return;
  console.log(`[sessions] ${total} ended in ${SESSION_REPORT_MS / 60000}min ` +
    `(${endedAuthed} authed, ${shortLived} under ${SHORT_SESSION_MS / 1000}s, ` +
    `avg ${now.avgSessionS}s all-time) — ` +
    Object.entries(delta).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '));
}, SESSION_REPORT_MS).unref();

// The same window, for the other recurring question: the hosting bill says
// egress is what costs money, and this says which egress. Unlike [sessions]
// this prints even when the number is small — a quiet window is itself the
// answer when the bill is large, because it means the traffic is arriving in
// bursts (new devices downloading assets) rather than continuously (the game
// stream, or a database being written to across a network boundary).
//
// What to do with the line, in the order the numbers appear:
//   http dominates  — assets. Look at the by-type breakdown: it is per FRESH
//                     DEVICE (everything but index.html is immutable for a
//                     year), so a big number means new players, not online
//                     ones. dev/egress.js prices one such load exactly.
//   ws dominates    — the world stream, and it scales with concurrency and
//                     with how tightly players are packed. dev/roombench.js
//                     prices it per player per cast.
//   other dominates — nothing to do with players. MongoDB (every autosave, and
//                     Atlas is outside the hosting network so those bytes are
//                     billed like a download) or the Telegram Bot API.
let _lastEgress = egress.snapshot();
safeInterval('egressReport', () => {
  const now = egress.snapshot();
  const d = egress.diff(_lastEgress, now);
  _lastEgress = now;
  console.log(egress.format(d));
}, SESSION_REPORT_MS).unref();

// ── Combat fan-out ───────────────────────────────────────────────────────────
// enemyHurt/enemyKilled describe ONE enemy, and they used to go to the whole
// floor on every swing. The world is a single shared floor, so the cost of one
// player hitting one monster scaled with everyone online: at a few hundred
// players each landing a handful of hits a second, that is six figures of
// outbound packets a second, almost all of them about an enemy the recipient
// has never been told exists and prunes on arrival. The AOI stream already
// knows exactly who can see a given enemy (Room._eKnown, via viewersOfEnemy),
// so address these to that set instead.
//
// Returns the recipient list, or null when nobody is left to tell — callers
// skip the emit entirely in that case rather than paying for an empty
// broadcast. `exclude` is for the recipients that already got a richer,
// personally-addressed copy (the attacker, their party).
function _enemyViewers(room, enemyId, exclude) {
  if (!room) return null;
  const viewers = room.viewersOfEnemy(enemyId);
  if (!viewers.length) return null;
  // Copy: viewersOfEnemy hands back a buffer it reuses on the next call.
  const out = [];
  for (let i = 0; i < viewers.length; i++) {
    const id = viewers[i];
    if (exclude && exclude.includes(id)) continue;
    out.push(id);
  }
  return out.length ? out : null;
}

// Emits `event` to everyone currently able to see `enemyId`, minus `exclude`.
// io.to(idArray) resolves each socket id as its own room and encodes the
// payload once for the whole set, so this stays a single serialization.
function _emitToEnemyViewers(room, enemyId, event, payload, exclude) {
  const ids = _enemyViewers(room, enemyId, exclude);
  if (!ids) return;
  io.to(ids).emit(event, payload);
}

// Server-side floor between two 'healParty' casts from the same connection —
// see the handler's own comment (below, inside io.on('connection')) for why
// this exists at all. Same "far below the real cooldown, just tight enough
// that spamming isn't worth anything" role SKILL_CD_MS plays for every other
// skill (server/game/Room.js) — legitimate play (25s between casts, the
// warlock R skill's own client-side cooldown) never gets near it.
const HEAL_PARTY_CD_MS = 2000;

// Game-mode managers, called here (rather than at their original in-file
// position) for the same reason registerAdminRoutes is: each one is a
// `const`/function declaration further down this same module in the
// original layout, and calling the factory only once everything it needs
// already exists avoids reaching into any of it early. The cross-mode glue
// that reaches into more than one of these — _socketTid, _reclaimQueues,
// _pvpFrozen, _pvpEliminate — stays defined in index.js itself, since it
// spans managers rather than belonging to one.
const {
  _db, _dbFrozen, _dbNextStartAt, _dbPublicState, _dbBroadcast, _dbSchedule,
  _dbOpenReg, _dbStart, _dbReturnEntrant, _dbEliminate, _dbFinish,
} = createDeathBattle({
  io, getRoom, playerFloorMap, _findPlayerAnyFloor, _recordPvpHistory, _socketTid,
  notifyEventSoon, notifyEventStarted, safeTimeout,
});

const {
  ARENA3_MIN_LEVEL, ARENA3_REWARD,
  _a3, _a3NextOpenAt, _a3PublicState, _a3Broadcast, _a3Schedule, _a3OpenWindow, _a3CloseWindow,
  _a3Frozen, _a3Allies, _a3Enemies, _a3TryStartSafe, _a3TryStart, _a3Deploy, _a3Eliminate, _a3Finish,
} = createArena3({
  io, getRoom, logPlayer, _recordPvpHistory, _returnToHub, _findPlayerAnyFloor, _socketTid,
  notifyEventSoon, notifyEventStarted, safeTimeout,
  DAILY_DUNGEON_ATTEMPTS, _arena3AttemptsLeft, _lockArena3Daily,
});

const {
  _gw, _gwNextOpenAt, _gwPublicState, _gwSchedule, _gwOpenWindow, _gwCloseWindow,
  _gwApplyCapture, _gwIncomeSchedule,
} = createGuildWar({
  io, playerFloorMap, _socketForTelegramId, notifyEventSoon, notifyEventStarted, safeTimeout,
});

const {
  RACE10_ATTEMPTS, RACE10_MIN_LEVEL,
  _race10, _race10Capacity, _race10NextOpenAt, _race10PublicState, _race10Broadcast, _race10Schedule,
  _race10OpenWindow, _race10CloseWindow, _race10Frozen, _race10StartSafe, _race10Start, _race10Deploy,
  _race10Eliminate, _race10Finish,
} = createRace10({
  io, getRoom, logPlayer, _recordPvpHistory, _returnToHub, _findPlayerAnyFloor, _socketTid,
  notifyEventSoon, notifyEventStarted, safeTimeout,
  _race10AttemptsLeft, _lockRace10Daily,
});

const {
  FEAR_ATTEMPTS, FEAR_MIN_LEVEL, FEAR_START_DELAY_MS,
  _fear, _fearRooms, _createFearRoom, _liveFearRooms, _trackFearRoom,
  _fearStartWave, _fearTrackKill, _fearReleaseRun, _fearFinish, _fearEliminate,
  _fearDisconnectGrace, _fearHoldOnDisconnect,
} = createFear({
  io, _returnToHub, _socketTid, safeTimeout,
});

const {
  COOP_ATTEMPTS, COOP_MIN_LEVEL, COOP_START_DELAY_MS, COOP_LIBERTY_CHANCE,
  _coop, _coopGroups, _coopGroupOf, _coopGroupStateFor, _coopGroupPush,
  _coopGroupOpenList, _coopGroupBroadcastList, _coopGroupDissolve, _coopGroupDropOnDisconnect,
  _createCoopRoom, _coopRooms, _liveCoopRooms,
  _coopTrackKill, _coopBossTrackKill, _coopReleaseRun, _coopFinish, _coopEliminate, _coopEjectOnDisconnect,
} = createCoop({
  io, _returnToHub,
});

const {
  _farm2Groups, _farm2GroupOf, _farm2Starting, _farm2GroupStateFor, _farm2GroupPush,
  _farm2GroupOpenList, _farm2GroupBroadcastList, _farm2GroupDissolve, _farm2GroupDropOnDisconnect,
  _createFarm2Room, _farm2Rooms,
  _farm2, _farm2ClearTimers, _farm2ReleaseRun, _farm2Finish, _farm2CascadeCheck,
  _farm2Eliminate, _farm2EjectOnDisconnect,
} = createFarm2({
  io, _returnToHub, _lockFarm2MinutesFor,
});

// Same reasoning as registerAdminRoutes below: safeTimeout/_incBalance are
// plain function declarations (hoisted, safe anywhere), but the bot-username
// cache is a `let` other code reads/writes directly, so it crosses as the
// get/set pair defined next to it above.
const {
  tgApi, notifyAdminGram, _pollTg, _handleAdminCallback, _txData,
  _registerReferral, _notifyAdminNewPlayer, _handleBotMessage, _refLink,
} = createTelegramBot({
  io, TG_ADMIN_ID, _incBalance, safeTimeout, _getTgBotUsername, _setTgBotUsername,
});

// Registered here rather than up next to the other app.use()/app.get() calls
// because several routes (race10/guildwar open-close, event-boss, the fear/
// coop attempt resets) close over managers — _gw, _race10, _coop, _fear,
// eventBossState/scheduleEventBoss — that are `const`/function declarations
// further down this same module; calling the factory only once they've all
// executed avoids reaching into any of them before they exist. Express
// doesn't care about registration order for non-overlapping paths, so moving
// the call here (vs. its routes' original position) changes nothing about
// how requests are matched.
registerAdminRoutes(app, {
  io, activeSessions, globalChatHistory, tgApi, tgBroadcastAll, _incBalance, _kickAllForMaintenance,
  _escapeRegex, _publicChatHistory, _socketForTelegramId,
  eventBossState, scheduleEventBoss,
  _gw, _gwOpenWindow, _gwCloseWindow, _gwPublicState,
  _race10, _race10OpenWindow, _race10CloseWindow, _race10PublicState, _race10BonusReset,
  _coop, _fear,
  _getMaintenanceMode, _setMaintenanceMode,
  _getRace10BonusCount, _incRace10BonusCount,
});

io.on('connection', socket => {
  let authed = null;
  let currentRoom = null;
  let currentFloor = FLOOR_IDS.hub;
  let _lastStats = null;

  // ── The session ───────────────────────────────────────────────────
  // This connection's own state, handed to the per-domain handler modules in
  // server/handlers/. It is what the game-mode factories in server/game/ cannot
  // express: those move a singleton state machine (one _a3 per process), while
  // these handlers are per-socket and run against the variables below.
  //
  // Every member is an accessor on purpose, so this object can be built here —
  // before most of what it exposes is declared — without tripping over the TDZ
  // of a const declared further down. The reassigned ones need to be accessors
  // for a second reason: selectChar/saveProgress/login replace authed,
  // _lastStats and the balances wholesale AFTER the modules are wired, so a
  // value captured at wiring time would be stale for the rest of the session.
  //
  // Reassigned members are exposed without their leading underscore (s.authed,
  // s.lastStats); the rest keep their original names so the moved handler
  // bodies stay byte-identical to what they were in this closure.
  const session = {
    socket,
    get atkCount() { return _atkCount; }, set atkCount(v) { _atkCount = v; },
    get atkResetAt() { return _atkResetAt; }, set atkResetAt(v) { _atkResetAt = v; },
    get balancePersistTimer() { return _balancePersistTimer; }, set balancePersistTimer(v) { _balancePersistTimer = v; },
    get econBusy() { return _econBusy; }, set econBusy(v) { _econBusy = v; },
    get gramBalance() { return _gramBalance; }, set gramBalance(v) { _gramBalance = v; },
    get gramPending() { return _gramPending; }, set gramPending(v) { _gramPending = v; },
    get invRev() { return _invRev; }, set invRev(v) { _invRev = v; },
    get itemOpBusy() { return _itemOpBusy; }, set itemOpBusy(v) { _itemOpBusy = v; },
    get lastChatAt() { return _lastChatAt; }, set lastChatAt(v) { _lastChatAt = v; },
    get lastStats() { return _lastStats; }, set lastStats(v) { _lastStats = v; },
    get myClanIcon() { return _myClanIcon; }, set myClanIcon(v) { _myClanIcon = v; },
    get myClanId() { return _myClanId; }, set myClanId(v) { _myClanId = v; },
    get myClanLevel() { return _myClanLevel; }, set myClanLevel(v) { _myClanLevel = v; },
    get myClanName() { return _myClanName; }, set myClanName(v) { _myClanName = v; },
    get nexumBalance() { return _nexumBalance; }, set nexumBalance(v) { _nexumBalance = v; },
    get nexumPending() { return _nexumPending; }, set nexumPending(v) { _nexumPending = v; },
    get pendingOobGrants() { return _pendingOobGrants; }, set pendingOobGrants(v) { _pendingOobGrants = v; },
    get saveDebounceTimer() { return _saveDebounceTimer; }, set saveDebounceTimer(v) { _saveDebounceTimer = v; },
    get seasonPoints() { return _seasonPoints; }, set seasonPoints(v) { _seasonPoints = v; },
    get seasonRefChecked() { return _seasonRefChecked; }, set seasonRefChecked(v) { _seasonRefChecked = v; },
    get teleportCastTimer() { return _teleportCastTimer; }, set teleportCastTimer(v) { _teleportCastTimer = v; },
    get authed() { return authed; }, set authed(v) { authed = v; },
    get currentFloor() { return currentFloor; }, set currentFloor(v) { currentFloor = v; },
    get currentRoom() { return currentRoom; }, set currentRoom(v) { currentRoom = v; },
    get _AMPLIFYING_EVENTS() { return _AMPLIFYING_EVENTS; },
    get _ERR_LOG_MS() { return _ERR_LOG_MS; },
    get _HEAVY_EVENTS() { return _HEAVY_EVENTS; },
    get _ITEMS_BUSY_MSG() { return _ITEMS_BUSY_MSG; },
    get _atkAllowed() { return _atkAllowed; },
    get _commitServerItems() { return _commitServerItems; },
    get _currentQuest() { return _currentQuest; },
    get _doEnterLocation() { return _doEnterLocation; },
    get _emitNearby() { return _emitNearby; },
    get _errLoggedAt() { return _errLoggedAt; },
    get _flushBalances() { return _flushBalances; },
    get _goldNow() { return _goldNow; },
    get _grantGold() { return _grantGold; },
    get _grantXp() { return _grantXp; },
    get _itemErr() { return _itemErr; },
    get _itemsBusy() { return _itemsBusy; },
    get _killGold() { return _killGold; },
    get _liveGram() { return _liveGram; },
    get _liveInventory() { return _liveInventory; },
    get _liveNexum() { return _liveNexum; },
    get _logHandlerErr() { return _logHandlerErr; },
    get _questBump() { return _questBump; },
    get _questKills() { return _questKills; },
    get _questOnKill() { return _questOnKill; },
    get _questPush() { return _questPush; },
    get _recordOobGrant() { return _recordOobGrant; },
    get _resolveInvIdx() { return _resolveInvIdx; },
    get _rlAmp() { return _rlAmp; },
    get _rlBump() { return _rlBump; },
    get _rlFast() { return _rlFast; },
    get _rlHeavy() { return _rlHeavy; },
    get _seasonAddPoints() { return _seasonAddPoints; },
    get _seasonCheckRefFriend() { return _seasonCheckRefFriend; },
    get _serverSpendGold() { return _serverSpendGold; },
    get _setGram() { return _setGram; },
    get _setNexum() { return _setNexum; },
    get _wherePlayerIs() { return _wherePlayerIs; },
    get _withEconLock() { return _withEconLock; },
    get _xpMult() { return _xpMult; },
  };

  // Banks one XP grant at the most generous multiplier the client could
  // legitimately apply to it. Exposed on socket.data because a kill pays
  // every nearby party member, and their entitlement lives in THEIR socket's
  // closure, not this one — same reason _grantKillLoot is exposed.
  // The XP entitlement ledger used to live here: it banked what the server had
  // handed out so a CLIENT-COMPOSED level could be measured against it. The
  // server applies the XP and runs the level curve itself now (_grantXp), so
  // there is no claim left to audit and nothing to bank.
  // A party member's share is credited against their OWN session — same
  // reasoning as the XP share below, and the same delivery route. Returns what was
  // credited as well as the new total: the attacker's socket cannot compute a
  // member's clan bonus or potion buff, so the figure their client displays has
  // to come back from their own session.
  socket.data._grantKillGold = base => {
    const gained = _killGold(base);
    return { gained, total: _grantGold(gained, 'kill', { quiet: true }) };
  };

  // ── Server-side gold spend ────────────────────────────────────────────────
  // Gold is the one currency the server does not own: it rides in on the
  // client's save blob and the next saveProgress replaces _lastStats wholesale.
  // So deducting it here is not enough on its own — a save composed BEFORE the
  // deduction, arriving after it, carries the pre-spend figure and hands the
  // money straight back. That is why "золото не снимает" for the clan storage
  // unlock: the charge landed and was then quietly undone.
  //
  // That whole correction is gone: gold is server-owned, a save cannot report
  // a balance, and so nothing can hand a charge back. What is left is the
  // charge itself.
  async function _serverSpendGold(amount, reason) {
    if (!authed || !_lastStats || !(amount > 0)) return null;
    const before = _goldNow();
    const after = Math.max(0, before - Math.floor(amount));
    _lastStats.gold = after;
    await _persistSavedFields(authed, { gold: after });
    socket.emit('goldSync', { gold: after });
    logPlayer(authed.telegramId, authed.username, 'gold_spend',
      { reason, amount, before, after });
    return after;
  }
  let _myClanName = null;
  let _myClanIcon = null;
  // The clan's _id, kept beside the name/icon so the per-kill XP tally can be
  // a pure in-memory increment instead of re-resolving the clan from the DB on
  // every single monster death — see _onKillClanXp and _clanXpAdd.
  let _myClanId = null;
  // The clan's current level, kept purely so its atk% (clanAtkBonusPct) can be
  // pushed onto the Room player object below — Room.js's computeStats needs
  // it synchronously and has no DB access of its own.
  let _myClanLevel = null;

  // Lets another connection (a clan leader approving/kicking, the XP flusher
  // announcing a level-up) update THIS session's clan identity — see
  // _notifyClan. Passing nulls clears it, which is what a kick/disband does.
  socket.data._setClanIdentity = (clanId, name, icon, level) => {
    _myClanId    = clanId ? String(clanId) : null;
    _myClanName  = name || null;
    _myClanIcon  = icon || null;
    _myClanLevel = level || null;
    currentRoom?.setPlayerClan(socket.id, _myClanName, _myClanIcon, clanAtkBonusPct(_myClanLevel), _myClanId);
  };
  // Per-socket MIRROR of the account's balances — NOT the source of truth.
  // _gramBalanceCache/_nexumBalanceCache (keyed by telegramId) are, because
  // several credit paths run in a *different* connection's closure — or in no
  // connection at all — and can only reach the account through the cache:
  //   • a market sale's payout to the seller (marketBuy runs on the BUYER's
  //     socket),
  //   • an admin confirming a deposit, and the 5% referral bonus it pays,
  //   • POST /admin/player/:tid/give.
  // All of those write the cache and push a gramBalanceUpdate to the client,
  // so the player SEES the credit — but this socket's mirror stays at the old
  // number. Anything that then based a new value on the mirror (a gram drop,
  // a purchase, a withdrawal) wrote that stale figure straight back over the
  // credit, in both the cache and the DB. With a 30% gram-drop chance per
  // kill, a sale's proceeds could vanish within seconds of arriving — the
  // reported "продал лот, а GRAM не пришли / баланс перезаписался" bug.
  // Read every balance through _liveGram/_liveNexum and write every change
  // through _setGram/_setNexum so the mirror and the cache can never diverge.
  let _gramBalance = 0;
  let _nexumBalance = 0;
  function _liveGram() {
    return (authed && _gramBalanceCache.has(authed.telegramId))
      ? _gramBalanceCache.get(authed.telegramId) : _gramBalance;
  }
  function _setGram(v) {
    _gramBalance = v;
    if (authed) _gramBalanceCache.set(authed.telegramId, v);
    return v;
  }
  function _liveNexum() {
    return (authed && _nexumBalanceCache.has(authed.telegramId))
      ? _nexumBalanceCache.get(authed.telegramId) : _nexumBalance;
  }
  function _setNexum(v) {
    _nexumBalance = v;
    if (authed) _nexumBalanceCache.set(authed.telegramId, v);
    return v;
  }

  // ── One-at-a-time guard for spend/claim handlers ──────────────────────────
  // gramShopBuy, claimVipRewards and completeSpecialQuest all read a balance
  // or a claim flag, then `await` a DB round trip, and only then spend or
  // clear it. Two events sent in the same tick both pass the check while the
  // first is still awaiting — buying one package twice for one payment,
  // claiming a VIP tier's items twice, taking a quest reward twice. The rate
  // limiter doesn't help: it allows 40 heavy events per 5s, and this needs
  // exactly two.
  //
  // marketBuy solves the same problem by keeping no await between its
  // re-check and its deduction (see the comment there); these three can't be
  // rearranged that way, so they serialize instead. Per-socket is the right
  // scope: all three act on the connection's own account, and a second
  // connection for the same account is already impossible (activeSessions).
  let _econBusy = false;
  async function _withEconLock(fn) {
    if (_econBusy) return false;
    _econBusy = true;
    try { await fn(); } finally { _econBusy = false; }
    return true;
  }

  // ── Stale-inventory-array guard for item-granting handlers ─────────────────
  // marketCancel/marketBuy/craftGear/craftClassGear/gramShopBuy/claimVipRewards/
  // clanStorageDeposit/clanStorageClaim/_dbGrantWin all read _lastStats.inventory
  // (or a copy of it) BEFORE at least one `await` (a DB round trip), then
  // mutate/commit it AFTER. saveProgress runs fully synchronously and needs no
  // await of its own, so it can — and does — run to completion in the gap
  // between two of THIS handler's awaits, on the very same socket (safeOn just
  // does a plain socket.on; nothing serializes different event types against
  // each other). When it does, its accepted branch replaces _lastStats
  // wholesale with a brand-new object (see `_lastStats = clean` below), which
  // orphans the array these handlers are still holding a reference to — their
  // eventual _commitServerItems() then stamps that stale, detached array back
  // over the live one, silently discarding whatever the save legitimately
  // changed in between, INCLUDING — if the ordering lands the other way — the
  // item the handler itself just granted or returned. This is what made a
  // cancelled market listing's item vanish right after coming back.
  //
  // _lastStats is otherwise only ever reassigned wholesale at login/selectChar
  // (both before any of these handlers can fire) — saveProgress is the one
  // recurring source of the race, so gating just it is enough to close the
  // window for every handler below without touching their internal logic.
  let _itemOpBusy = 0;
  let _saveDebounceTimer = null;
  // Pending teleport-stone cast's setTimeout handle (server/index.js's own
  // useTeleportStone below) — cleared on disconnect so a dead connection
  // never fires _doEnterLocation against a socket that is no longer live.
  let _teleportCastTimer = null;

  // Items granted from OUTSIDE a player-initiated handler while one of the
  // clone-and-commit handlers above is mid-flight: mob loot (every kill),
  // a market item arriving cross-session, a death-battle/Tower reward, a
  // craft result landing on a reconnected socket.
  //
  // Those grants go straight into the live inventory, and the clone-holder's
  // eventual wholesale commit stamps them away — the "+1×" floating text
  // plays for an item that never arrives. A player-initiated handler can
  // simply refuse and be retried (that is what _itemsBusy is for), but a
  // grant has nowhere to be retried FROM: the mob is already dead, the lot
  // already sold. Refusing would destroy it just as surely.
  //
  // So they are recorded here as well as applied, and the stale commit
  // re-applies them on top of the snapshot it is about to install (see
  // _commitServerItems). Nothing is refused and nothing is lost: the grant
  // survives whichever way the two land.
  let _pendingOobGrants = [];
  // Takes either a full item object or a bare {id, qty} (the loot roll reports
  // its drops in a display shape, not a catalog one). Either way what is
  // stored is rebuilt from the catalog, so the replay is a real item _invAdd
  // can place — slot included, which is what decides stacking.
  function _recordOobGrant(items) {
    if (_itemOpBusy <= 0) return;
    for (const it of items) {
      if (!it || !it.id) continue;
      const base = _catalogBase(it.id);
      if (!base) continue;
      const qty = Math.max(1, Math.floor(Number(it.qty)) || 1);
      _pendingOobGrants.push(isStackableItem(base) ? { ...base, qty } : { ...base, ...(it.enhance ? { enhance: it.enhance } : {}) });
    }
  }

  let _balancePersistTimer = null;
  let _gramPending = 0;    // GRAM earned since the last flush
  let _nexumPending = 0;   // Liberty earned since the last flush
  async function _flushBalances() {
    if (_balancePersistTimer) { clearTimeout(_balancePersistTimer); _balancePersistTimer = null; }
    if (!authed) return;
    const g = _gramPending, n = _nexumPending;
    // Cleared before the awaits so drops landing during the write are counted
    // toward the NEXT flush instead of being written twice.
    _gramPending = 0; _nexumPending = 0;
    if (g > 0) {
      const v = await _incBalance(authed.telegramId, 'gramBalance', g);
      if (v !== null) _gramBalance = v;
    }
    if (n > 0) {
      const v = await _incBalance(authed.telegramId, 'nexumBalance', n);
      if (v !== null) _nexumBalance = v;
    }
  }
  let _lastChatAt = 0;
  // Simple per-second rate limiter for attack events
  let _atkCount = 0, _atkResetAt = 0;
  function _atkAllowed() {
    const now = Date.now();
    if (now > _atkResetAt) { _atkCount = 0; _atkResetAt = now + 1000; }
    return ++_atkCount <= 20;
  }

  // ── Per-socket event rate limiting ─────────────────────────────────────────
  // Two token buckets over a 5s window: a tight one for DB-touching / broadcast
  // / query events (spam of these is the real DoS + race-condition surface —
  // e.g. hammering marketBuy or clanApply), and a loose one for everything else
  // (movement/combat, already bounded by _atkAllowed and cheap in-memory ops).
  // Excess packets are dropped silently before the handler runs. Single-instance
  // in-memory limiter — matches this server's existing state model.
  const _HEAVY_EVENTS = new Set([
    'marketBrowse', 'marketMyListings', 'marketHistory', 'marketList', 'marketBuy', 'marketCancel',
    'gramGetHistory', 'gramShopBuy', 'gramDepositRequest', 'gramWithdrawRequest',
    // Grants items and writes the once-only claim flag — one DB round trip
    // per tap, same as the shop purchase above it.
    'starterBonusClaim',
    'getReferrals', 'getRating', 'getPvpHistory', 'completeSpecialQuest', 'claimVipRewards',
    'clanCreate', 'clanSearch', 'clanApply', 'clanApprove', 'clanDecline', 'clanRequest',
    'clanKick', 'clanLeave', 'clanDisband', 'clanSetDescription',
    // Clan storage — every one of these reads and writes the clan document.
    'clanStorageSync', 'clanStorageDeposit', 'clanStorageGive',
    'clanStorageCancel', 'clanStorageClaim', 'clanStorageUnlock',
    'partyInvite', 'partyAccept', 'saveProgress', 'selectChar',
    'requestPlayerProfile', 'resetUpgrades', 'rebirth', 'craftPet', 'craftStone', 'craftGear', 'craftClassGear', 'enhanceItem',
    'buyTeleportStone',
    'craftBox', 'craftMatUpgrade', 'craftAdvSkillBook', 'openLootBox',
    // Hits the database on every call — seasonRating sorts the whole player
    // collection.
    'seasonRating',
    // History/lookup reads that were left in the loose default bucket even
    // though each call is its own DB round trip — a client idly re-opening
    // (or scripting) a DM thread or the clan chat panel could fire these at
    // up to 300/s in the fast bucket, same amplification shape as the ones
    // above, just missed when this list was written.
    'privMsgHistory', 'clanChatHistory',
    // arena3/race10/fear Register+Sync all await the daily-attempts DB read
    // (see _dailyAttemptsLeft) on every single call — Register additionally
    // rewrites the queue and re-broadcasts it. Same shape as the rest of this
    // list; only the *Unregister/*Return/*ing-state variants stay in the fast
    // bucket because they're pure in-memory reads/writes.
    'arena3Register', 'arena3Sync', 'race10Register', 'race10Sync', 'fearEnter', 'fearSync',
    // coopGroupCreate/Join/Kick/Leave all rewrite the lobby and re-broadcast
    // it to every connected socket (_coopGroupBroadcastList) — same
    // broadcast-amplification shape as arena3Register/race10Register above.
    'coopGroupCreate', 'coopGroupJoin', 'coopGroupKick', 'coopGroupLeave', 'coopGroupStart', 'coopSync',
    // Same shape as the coopGroup* bucket just above, for Элитная фарм-зона's
    // own lobby.
    'farm2GroupCreate', 'farm2GroupJoin', 'farm2GroupKick', 'farm2GroupLeave', 'farm2GroupStart', 'farm2Sync',
  ]);
  // A third bucket for the events that are cheap to ASK for and expensive to
  // ANSWER. enemyResync is the amplifier: one request makes the server encode
  // and send up to ENEMY_RESYNC_MAX (40) full enemy records, strings and all,
  // and in the fast bucket a client was allowed 300 of those a second — 12000
  // full records/s off a few bytes of request. The real client sends at most
  // two a second (_ENEMY_RESYNC_MS = 500, js/network.js), so 10 per 5s window
  // is five times what honest play needs. worldMapInline is here for the same
  // reason: it answers with the entire map.
  const _AMPLIFYING_EVENTS = new Set(['enemyResync', 'worldMapInline']);
  const _rlHeavy = { n: 0, reset: 0 };
  const _rlFast  = { n: 0, reset: 0 };
  const _rlAmp   = { n: 0, reset: 0 };
  function _rlBump(bucket, max) {
    const now = Date.now();
    if (now > bucket.reset) { bucket.n = 0; bucket.reset = now + 5000; }
    return ++bucket.n <= max;
  }
  socket.use((packet, next) => {
    const ev = packet && packet[0];
    // per 5s window. Heavy (DB/query/broadcast) kept tight; amplifying ones
    // tighter still; fast (movement/combat, sent per-frame) set high enough to
    // never throttle real play — it only exists to cut a scripted flood.
    let bucket, max;
    if (_AMPLIFYING_EVENTS.has(ev))  { bucket = _rlAmp;   max = 10; }
    else if (_HEAVY_EVENTS.has(ev))  { bucket = _rlHeavy; max = 40; }
    else                             { bucket = _rlFast;  max = 1500; }
    if (!_rlBump(bucket, max)) return; // drop silently — over budget
    next();
  });

  playerFloorMap.set(socket.id, currentFloor);

  // Exposed on socket.data so a *different* connection's closure (e.g. the
  // new socket that's about to kick this one on same-account reconnect) can
  // force this socket's pending debounced save to persist before reading
  // fresh data from the DB. Without this, a fast refresh raced the DB read
  // in loginTelegram(WebApp) against this socket's async disconnect-flush —
  // if the read won, the new session got stale savedData and, a few seconds
  // later, persisted it right back over the real progress.
  socket.data._flushNow = async () => {
    if (_saveDebounceTimer) { clearTimeout(_saveDebounceTimer); _saveDebounceTimer = null; }
    // Read BEFORE the first await. The disconnect handler ends in
    // currentRoom.removePlayer(socket.id), which runs synchronously while this
    // is still suspended on _flushBalances below — so by the time the write
    // itself happens there is no room entry left to read a position off, and
    // the flush that matters most (the one on the way out) was the one path
    // that always stored the floor without a position to go with it.
    const _where = _wherePlayerIs();
    // Balances are their own write and are never part of the progress blob —
    // see the balance block at the top of this file. Whatever this session has
    // earned since the last flush has to land either way.
    await _flushBalances();
    if (authed && _lastStats) {
      await _persistSavedFields(authed, { ..._lastStats, ..._where }, { bm: authed.bm });
    }
  };

  // ── Admin inventory editing on a LIVE session ────────────────────────────
  // _lastStats is this socket's authoritative copy and its next autosave
  // rewrites savedData wholesale, so an admin edit written straight to the DB
  // would be silently undone. These let the admin endpoints go through the
  // session instead: read the current items, then apply the edit to
  // _lastStats, persist it, and push it to the client so the player sees it
  // immediately instead of on their next login.
  // ── Server-owned inventory changes ───────────────────────────────────────
  // The client sends its WHOLE inventory on every autosave and the server has
  // always taken it as truth. That autosave is debounced up to 2s, so one
  // queued before a server-side grant lands after it and silently reverts it —
  // which is how bought packs "never arrived" for some players.
  //
  // A per-session counter bumped by every server-side item change. It used to
  // be an ordering token echoed back by the client's save so the server could
  // tell a pre-grant item set from a post-grant one; with items server-owned
  // there is no client item set to order, and nothing reads it back. Kept as a
  // sequence number in the item log, which is what makes a "where did my item
  // go" report answerable.
  let _invRev = 0;

  // Single choke point for every server-side item change: updates the live
  // copy, bumps the revision, persists, and pushes the authoritative result to
  // the client so it can't drift.
  // opts.persist === false: the caller writes the document itself (marketBuy
  // bundles the item and the payment into one atomic $set), but the live copy,
  // the revision bump, the client sync and the log still have to happen.
  //
  // IMPORTANT for callers that also emit their own "here's your item" event
  // (worldDropPicked, marketBought, marketCancelled, petCrafted,
  // deathBattleWon): the inventorySync below already carries the item, and it
  // is delivered first. Those events must therefore tell the client whether
  // the item was committed here (delivered: true) so it does NOT mirror it
  // into the local inventory a second time — that mirroring is what handed
  // out a free duplicate of every market purchase and world drop.
  function _commitServerItems(inventory, equipment, reason, meta, opts) {
    if (!_lastStats) _lastStats = {};
    // Most callers grab `_lastStats.inventory` itself (not a copy), mutate it
    // in place (push/qty++) and only THEN call this — so by the time we get
    // here _lastStats.inventory already IS `inventory`, post-mutation, and
    // reading its length as "before" always printed the post-grant count
    // twice (`slots: 39 -> 39` no matter what actually landed). Callers that
    // mutate in place instead snapshot the true pre-mutation length and pass
    // it as opts.beforeLen; opts-less callers (the admin panel's wholesale
    // replace) never mutated the old array, so its still-current length is
    // the real "before" and the fallback stays correct for them.
    const _before = (opts && Number.isFinite(opts.beforeLen))
      ? opts.beforeLen
      : (Array.isArray(_lastStats.inventory) ? _lastStats.inventory.length : 0);
    // A commit of a DETACHED array (one of the clone-and-commit handlers
    // installing the snapshot it took before its DB awaits) would drop every
    // out-of-band grant that landed in the live array in the meantime. Pour
    // them back in first, so the snapshot carries them too — see
    // _pendingOobGrants. A commit of the live array itself already holds
    // them, so there is only the bookkeeping to clear.
    if (_pendingOobGrants.length) {
      if (Array.isArray(inventory) && inventory !== _lastStats.inventory) {
        const _rescued = [];
        for (const it of _pendingOobGrants) {
          if (_invAdd(inventory, it)) _rescued.push(it.id);
        }
        if (authed) {
          logPlayer(authed.telegramId, authed.username, 'inv:oob_rescued', {
            reason: reason || 'change', n: _rescued.length,
            of: _pendingOobGrants.length, ids: _rescued.slice(0, 10).join(','),
          });
        }
      }
      _pendingOobGrants = [];
    }
    _lastStats.inventory = inventory;
    if (equipment) _lastStats.equipment = equipment;
    _invRev++;
    // Every server-side item change funnels through here, so logging it here
    // covers all of them at once — and records the slot count before/after,
    // which is what makes a later "my item vanished" report answerable.
    // mob_loot is the one exception: it fires on nearly every kill, so it
    // drowned out everything else in the shared 100-row window (see
    // LOG_SEASON_EVENTS's own comment in player-log.js for the same problem
    // hitting season rows) without being the kind of report a "where did my
    // item go" investigation actually needs — a lost drop is invisible either
    // way, since nothing else records what a kill *should* have dropped.
    if (authed && reason !== 'mob_loot') {
      logPlayer(authed.telegramId, authed.username, 'inv:' + (reason || 'change'), {
        slots: `${_before} -> ${inventory.length}`, rev: _invRev, ...(meta || {}),
      });
    }
    if (currentRoom) currentRoom.updatePlayerSavedData(socket.id, _lastStats);
    // storage travels with the other two whenever a caller touched it. It is
    // the third leg of the same set — the census counts all three together and
    // an inventory <-> storage move changes both halves at once — so writing
    // and syncing only part of it is what left the client holding an item in
    // two places at the same time.
    const _fields = { inventory };
    if (equipment) _fields.equipment = equipment;
    if (opts && opts.storage) _fields.storage = _lastStats.storage || [];
    const written = (opts && opts.persist === false) ? null : _persistSavedFields(authed, _fields);
    socket.emit('inventorySync', {
      inventory, equipment: _lastStats.equipment || {},
      storage: _lastStats.storage || [],
    });
    return written;
  }

  // The live inventory, or the DB copy when this session has yet to receive
  // one. Server-side grants must start from THIS, never from a fresh DB read:
  // the debounced save means Mongo can be up to ~3s behind, and building on
  // that snapshot rolls back whatever the player picked up in the meantime.
  function _liveInventory() {
    return (_lastStats && Array.isArray(_lastStats.inventory)) ? _lastStats.inventory : null;
  }

  socket.data._adminReadItems = () => ({
    inventory: (_lastStats && Array.isArray(_lastStats.inventory)) ? _lastStats.inventory : [],
    equipment: (_lastStats && _lastStats.equipment && typeof _lastStats.equipment === 'object')
      ? _lastStats.equipment : {},
  });

  // Unlike the grants below this is a WHOLESALE replace, so it cannot be
  // replayed on top of a stale snapshot the way _pendingOobGrants are — there
  // is no delta to replay, only "this is the inventory now". Committing it
  // while a clone-and-commit handler is outstanding just means that handler
  // stamps the edit away a moment later and the admin is told it worked.
  // Refusing and saying so is the honest answer: the admin retries, and the
  // window is a fraction of a second.
  socket.data._adminApplyItems = async (inventory, equipment) => {
    if (!authed) return false;
    if (_itemsBusy()) return false;
    await _commitServerItems(inventory, equipment, 'admin');
    return true;
  };

  // Cross-socket kill-loot grant. A party member other than the attacker can
  // win a kill's loot (random pick among party + attacker — see 'attack'/
  // 'skillAttack' below), and their inventory only lives in THEIR OWN
  // socket's closure, not the attacker's whose handler is actually running.
  // Same pattern as _adminApplyItems above: exposed on socket.data so a
  // different connection's handler can invoke it and land the grant where it
  // belongs. Rolls and grants everything itself (the mob loot table, the VIP
  // drop-bonus reroll, and — for a boss kill — the box/enchant-stone drops
  // that used to be rolled by the caller but only ever granted by the
  // client) so the caller only has to decide who won and relay what comes
  // back for that player's floating-text feedback.
  socket.data._grantKillLoot = ({ eid, rlvl, isBoss, farmZone, farmZone2, coop }) => {
    const empty = { items: [], boxUncommon: 0, boxRare: 0, normStone: 0, blessStone: 0 };
    if (!authed || !_lastStats || !Array.isArray(_lastStats.inventory)) return empty;
    const inv = _lastStats.inventory;
    const _beforeLen = inv.length;
    // Фарм-зона kills skip the normal loot table (and its VIP drop-bonus
    // reroll below) entirely — see _rollFarmZoneLoot's own comment. Элитная
    // фарм-зона kills skip it the same way, in favor of _rollFarm2Loot's own
    // box/stone/recipe/book table. Coop kills skip it too (including a boss
    // kill's box/stone rolls just below) and grant nothing from this
    // function at all — a regular kill's only reward beyond xp is the flat
    // COOP_LIBERTY_CHANCE Liberty roll in the attack/skillAttack handlers,
    // and the boss's own fixed reward is granted separately by
    // _coopBossTrackKill.
    const items = farmZone ? _rollFarmZoneLoot(inv, eid) : farmZone2 ? _rollFarm2Loot(inv) : coop ? [] : _rollMobLoot(inv, eid, rlvl, _lastStats.lvl);
    const _vipBon = VIP_BONUSES[socket.data.vipLevel || 0] || VIP_BONUSES[0];
    // Season ticket adds its own +30 on top, same units as VIP's own drop
    // bonus (a % chance to re-roll the loot table a second time) — see
    // gramShopBuy/'season_ticket'. Read off THIS closure's own socket (the
    // loot WINNER, who may be a party member other than the attacker), same
    // as _vipBon just above.
    const _dropBon = (_vipBon.drop || 0) + ((seasonActive() && socket.data.seasonTicketActive) ? SEASON_TICKET_DROP_PCT : 0);
    if (!farmZone && !farmZone2 && !coop && _dropBon > 0 && Math.random() * 100 < _dropBon) {
      items.push(..._rollMobLoot(inv, eid, rlvl, _lastStats.lvl));
    }
    let boxUncommon = 0, boxRare = 0, normStone = 0, blessStone = 0;
    if (isBoss && !coop && !farmZone2) {
      // The flag is set from what _invAdd ACTUALLY placed, not from the roll.
      // Setting it first and ignoring the return (as this did) meant a full
      // inventory still told the client "+1× Ящик" — the floating text played,
      // nothing arrived, and the player had no way to tell the drop apart from
      // one that was stolen. Every other grant in this file already reports
      // only what landed (see _rollMobLoot's addMat).
      const _rollInto = (chance, item) => (Math.random() < chance && _invAdd(inv, item)) ? 1 : 0;
      boxUncommon = _rollInto(0.50, { ...BOX_DEF.find(b => b.id === 'box_uncommon'), qty: 1 });
      boxRare     = _rollInto(0.10, { ...BOX_DEF.find(b => b.id === 'box_rare'), qty: 1 });
      normStone   = _rollInto(0.10, { ..._STONE_DEFS.norm_stone, qty: 1 });
      blessStone  = _rollInto(0.01, { ..._STONE_DEFS.bless_stone, qty: 1 });
    }
    if (items.length || boxUncommon || boxRare || normStone || blessStone) {
      // Recorded before the commit so a clone-holder's later stamp re-applies
      // them instead of erasing the drop — see _pendingOobGrants. Kills are by
      // far the most frequent grant in the game, so this is the path that path
      // exists for.
      _recordOobGrant([
        ...items,
        ...(boxUncommon ? [{ id: 'box_uncommon', qty: 1 }] : []),
        ...(boxRare ? [{ id: 'box_rare', qty: 1 }] : []),
        ...(normStone ? [{ id: 'norm_stone', qty: 1 }] : []),
        ...(blessStone ? [{ id: 'bless_stone', qty: 1 }] : []),
      ]);
      _commitServerItems(inv, null, 'mob_loot', { eid, rlvl, n: items.length, boxUncommon, boxRare, normStone, blessStone }, { beforeLen: _beforeLen });
    }
    return { items, boxUncommon, boxRare, normStone, blessStone };
  };

  // Cross-socket item grant for a handler resuming after this account may
  // have reconnected on a DIFFERENT socket while it was mid-flight —
  // marketCancel/marketBuy hold across two-to-four DB awaits before they
  // apply the item, and Node never cancels a promise chain just because its
  // socket disconnected. A stale handler that kept _sellerInv/_buyerInv as a
  // direct reference into THIS closure's _lastStats.inventory would, on
  // resuming, either write into a _lastStats nobody's client can see any
  // more (harmless but the item is gone from the account's real, live
  // session) or — via _commitServerItems' unconditional persist — overwrite
  // whatever the real live session has saved since, with the returned/bought
  // item nowhere in it. That is exactly what "предмет пропал после снятия с
  // маркета" kept coming back as: the reconnect itself is what raced it.
  // Same reasoning as _grantKillLoot above; this is the same pattern for a
  // single specific item instead of a loot roll.
  socket.data._grantMarketItem = (item) => {
    if (!authed || !_lastStats || !Array.isArray(_lastStats.inventory) || !item) return { delivered: false };
    _itemOpBusy++;
    try {
      const inv = _lastStats.inventory;
      const _beforeLen = inv.length;
      const delivered = _invAdd(inv, item);
      if (delivered) {
        _recordOobGrant([item]);
        _commitServerItems(inv, null, 'market_cross_session_grant', { item: item.id }, { beforeLen: _beforeLen });
      }
      return { delivered };
    } finally {
      _itemOpBusy--;
    }
  };

  // The mirror of _grantMarketItem: takes an item OUT of whichever socket is
  // the account's live session, for marketList resuming after the account
  // reconnected mid-flight. Same reasoning, opposite direction — and the
  // direction is what makes it worse. A grant that lands in an orphaned
  // _lastStats merely goes missing; a REMOVAL that lands there removes
  // nothing anyone can see: the listing is live in the database while the
  // item is still sitting in the live session's inventory, and that
  // session's next save writes it back to the account for good. The seller
  // then gets paid for a book they still own — "продал книгу, а она
  // вернулась в инвентарь, и GRAM с продажи остались".
  //
  // Returns { removed } so the caller can undo the listing when the live
  // session doesn't actually hold the item any more (it was equipped, spent
  // or stored between the two sessions).
  socket.data._takeMarketItem = (item) => {
    if (!authed || !_lastStats || !Array.isArray(_lastStats.inventory) || !item) return { removed: false };
    // Refused while THIS session has a clone-and-commit handler of its own in
    // flight (gramShopBuy/specialShopBuy/claimVipRewards): its snapshot was
    // taken before this removal and stamps the item straight back in — the
    // very duplication marketList's own entry guard exists to stop, only
    // arriving from the other session. There is nothing to replay it into
    // either (_pendingOobGrants only carries additions), so the honest answer
    // is "not taken", which drops the lot.
    if (_itemsBusy()) return { removed: false };
    _itemOpBusy++;
    try {
      const inv = _lastStats.inventory;
      const _beforeLen = inv.length;
      if (!_invRemove(inv, item)) return { removed: false };
      _commitServerItems(inv, null, 'market_list_cross_session',
        { item: item.id, enhance: item.enhance || 0, qty: item.qty || 1 }, { beforeLen: _beforeLen });
      return { removed: true };
    } finally {
      _itemOpBusy--;
    }
  };

  // General-purpose version of _grantMarketItem above, for handlers that
  // touch more than one item and/or gold/bonusSP/VIP progress in one go
  // (crafts consuming materials, shop packages granting several rewards at
  // once). Same reasoning: those handlers hold across several DB awaits
  // before applying anything, and if the account reconnected on a different
  // socket in the meantime, this is what actually applies the result
  // against whichever session's _lastStats is live NOW — see each caller's
  // own comment for the specific race this closes.
  //
  // patch: { addItems: [{item, qty?}], removeItems: [{item, qty?}],
  //          goldDelta, bonusSPDelta, vipGramDelta, clearVipPending }
  // removeItems are applied before addItems (matters for crafts: spend
  // materials, then hand back the result). Returns null if this socket
  // isn't authed/loaded; otherwise the account's resulting gold/VIP state,
  // which callers use to build the event they emit back.
  socket.data._applyGrant = (patch, reason, meta) => {
    if (!authed || !_lastStats) return null;
    _itemOpBusy++;
    try {
      if (!Array.isArray(_lastStats.inventory)) _lastStats.inventory = [];
      const inv = _lastStats.inventory;
      const _beforeLen = inv.length;
      (patch.removeItems || []).forEach(({ item, qty }) => {
        if (item) _invRemove(inv, qty != null ? { ...item, qty } : item);
      });
      (patch.addItems || []).forEach(({ item, qty }) => {
        if (item) _invAdd(inv, qty != null ? { ...item, qty } : item);
      });
      // Same replay bookkeeping as _grantKillLoot's — this is the path the
      // death-battle and Tower rewards arrive on. Only the additions: a
      // removal that gets undone by a stale stamp costs the player nothing.
      _recordOobGrant((patch.addItems || []).map(({ item, qty }) => (
        item ? { id: item.id, qty: qty != null ? qty : item.qty, enhance: item.enhance } : null)));
      if (patch.goldDelta) _lastStats.gold = Math.max(0, (_lastStats.gold || 0) + patch.goldDelta);
      if (patch.bonusSPDelta) _lastStats.bonusSP = (_lastStats.bonusSP || 0) + patch.bonusSPDelta;
      let vipLeveled = false;
      if (patch.vipGramDelta) {
        let _vipLvl = _lastStats.vipLevel || 0;
        let _vipDep = (_lastStats.vipDeposited || 0) + patch.vipGramDelta;
        const _vipPend = Array.isArray(_lastStats.vipPending) ? [..._lastStats.vipPending] : [];
        const _prevVipLvl = _vipLvl;
        while (_vipLvl < 10 && _vipDep >= VIP_THRESHOLDS[_vipLvl + 1]) {
          _vipDep -= VIP_THRESHOLDS[_vipLvl + 1]; _vipLvl++; _vipPend.push(_vipLvl);
        }
        _lastStats.vipLevel = _vipLvl; _lastStats.vipDeposited = _vipDep; _lastStats.vipPending = _vipPend;
        vipLeveled = _vipLvl > _prevVipLvl;
        socket.data.vipLevel = _vipLvl;
        _setVipAura(authed.username, _vipLvl);
      }
      if (patch.clearVipPending) _lastStats.vipPending = [];
      // Season ticket — see gramShopBuy's own comment. A flag, not a balance,
      // so it just needs setting on this (now live) socket and persisting.
      if (patch.seasonTicket) socket.data.seasonTicketActive = true;
      _commitServerItems(inv, null, reason, meta, { beforeLen: _beforeLen });
      _persistSavedFields(authed, {
        gold: _lastStats.gold, bonusSP: _lastStats.bonusSP, vipLevel: _lastStats.vipLevel,
        vipDeposited: _lastStats.vipDeposited, vipPending: _lastStats.vipPending,
        ...(patch.seasonTicket ? { seasonTicket: true } : {}),
      });
      if (vipLeveled) {
        socket.emit('vipUpdate', {
          level: _lastStats.vipLevel, deposited: _lastStats.vipDeposited, pending: _lastStats.vipPending,
        });
      }
      return {
        gold: _lastStats.gold, bonusSP: _lastStats.bonusSP || 0, vipLevel: _lastStats.vipLevel || 0,
        vipDeposited: _lastStats.vipDeposited || 0, vipPending: _lastStats.vipPending || [], vipLeveled,
      };
    } finally {
      _itemOpBusy--;
    }
  };

  // Cross-socket craft delegate: craftGear/craftClassGear consume materials
  // with matching rules (minEnhance thresholds, rarity/salvage counts) that
  // don't fit the generic addItems/removeItems shape _applyGrant takes, so
  // instead of re-encoding that matching here, the caller passes in the exact
  // same removal closure it already built against its own (possibly stale)
  // inventory — it runs the same, just against whichever socket is actually
  // live. removeFn(inv) mutates in place; resultItem (or null on a failed
  // craft roll) is appended after.
  socket.data._applyCraftResult = (removeFn, resultItem, reason, meta) => {
    if (!authed || !_lastStats || !Array.isArray(_lastStats.inventory)) return { delivered: false };
    _itemOpBusy++;
    try {
      const inv = _lastStats.inventory;
      const _beforeLen = inv.length;
      removeFn(inv);
      const delivered = resultItem ? _invAdd(inv, resultItem) : true;
      if (delivered && resultItem) _recordOobGrant([resultItem]);
      _commitServerItems(inv, null, reason, meta, { beforeLen: _beforeLen });
      return { delivered };
    } finally {
      _itemOpBusy--;
    }
  };

  // Gold and/or skill points granted by an admin to a player who is online.
  // Both have to land in _lastStats, not just in the database: this
  // session's 60s autosave writes _lastStats wholesale, so a grant written
  // only to Mongo was reverted the next time that timer fired (most visibly
  // for a backgrounded mobile client, whose own save — which does carry the
  // grant, see the adminGive handler in js/network.js — may not come for a
  // long time). No double-counting: the client's next save replaces
  // _lastStats rather than adding to it. Used by both /admin/give-all (a
  // mass grant to every online account) and /admin/player/:tid/give (a
  // single account) — both fields move in one _persistSavedFields call so a
  // gold+SP grant sets them together.
  socket.data._adminGiveGoldSP = async (goldAmount, spAmount) => {
    if (!authed) return null;
    if (!_lastStats) _lastStats = {};
    const fields = {};
    if (Number.isFinite(goldAmount) && goldAmount !== 0) {
      _lastStats.gold = Math.max(0, (_lastStats.gold || 0) + goldAmount);
      fields.gold = _lastStats.gold;
    }
    if (Number.isFinite(spAmount) && spAmount !== 0) {
      _lastStats.bonusSP = (_lastStats.bonusSP || 0) + spAmount;
      fields.bonusSP = _lastStats.bonusSP;
    }
    if (!Object.keys(fields).length) return { gold: _lastStats.gold || 0, bonusSP: _lastStats.bonusSP || 0 };
    await _persistSavedFields(authed, fields);
    logPlayer(authed.telegramId, authed.username, 'admin_give_all_live',
      { gold: goldAmount, sp: spAmount, balance: _lastStats.gold, bonusSP: _lastStats.bonusSP });
    return { gold: _lastStats.gold || 0, bonusSP: _lastStats.bonusSP || 0 };
  };

  // Hands the death-battle winner its prize. Lives here rather than beside
  // _dbFinish because this is where the socket's own inventory/GRAM copies
  // are (same reasoning as pickupWorldDrop's award path). Returns the item
  // list so the caller can show it in the win modal, plus whether the prize
  // actually landed in the server-side inventory — see _commitServerItems.
  socket.data._dbGrantWin = async () => {
    if (!authed) return null;
    _itemOpBusy++;
    try {
      const items = deathBattleRewards();
      const _dbBal = await _incBalance(authed.telegramId, 'gramBalance', DEATH_BATTLE_GRAM_REWARD);
      if (_dbBal !== null) { _gramBalance = _dbBal; socket.emit('gramBalanceUpdate', { balance: _dbBal }); }
      // The account may have reconnected on a different socket during the
      // balance award above — this closure (`socket` here is whichever
      // socket _dbFinish resolved as the winner's live one AT THE TIME it
      // called this) can be stale by now. Apply the item reward against
      // whichever socket is the account's live session RIGHT NOW instead of
      // writing it through a closure nobody's client can see any more —
      // same race as marketCancel/marketBuy, see _applyGrant's comment.
      const _liveSid = activeSessions.get(authed.telegramId);
      const _target = _liveSid === socket.id ? socket : _socketForTelegramId(authed.telegramId);
      const _result = _target && _target.data._applyGrant
        ? _target.data._applyGrant({ addItems: items.map(it => ({ item: it })) }, 'death_battle_win',
            { items: items.map(i => i.id), gram: DEATH_BATTLE_GRAM_REWARD })
        : null;
      const _delivered = !!_result;
      if (!_delivered && items.length) {
        await _dbPushInventory(authed, items, 'death_battle_win');
      }
      logPlayer(authed.telegramId, authed.username, 'death_battle_win',
        { gram: DEATH_BATTLE_GRAM_REWARD, delivered: _delivered, crossSession: !!_target && _target !== socket });
      return { items, delivered: _delivered };
    } finally {
      _itemOpBusy--;
    }
  };

  // Pays out a 3v3 win. Lives on the socket for the same reason _dbGrantWin
  // does: Liberty is server-authoritative and its live value is in this
  // closure, not in whatever the DB last saw. Returns what was actually paid
  // so the result screen can't claim a reward that didn't land.
  socket.data._a3GrantWin = async () => {
    if (!authed) return 0;
    const _a3Bal = await _incBalance(authed.telegramId, 'nexumBalance', ARENA3_REWARD);
    if (_a3Bal !== null) _nexumBalance = _a3Bal;
    socket.emit('nexumBalanceUpdate', { balance: _liveNexum() });
    logPlayer(authed.telegramId, authed.username, 'arena3_reward',
      { nexum: ARENA3_REWARD, balance: _liveNexum() });
    return ARENA3_REWARD;
  };

  // Pays out a race10 finish. Unlike _a3GrantWin above this runs for EVERY
  // entrant who landed a hit on the boss, not only the winner — `won` picks
  // the tier (see race10Rewards/race10Liberty, shared/definitions.js).
  //
  // Items go through _applyGrant against whichever socket is the account's
  // live session right now, not through this closure: a three-minute race is
  // long enough that the account may have reconnected on a different socket
  // since _race10Finish resolved this one, and writing the prize through a
  // socket nobody's client is listening to would lose it. Same race
  // _dbGrantWin already handles; the _dbPushInventory fallback covers the
  // case where there is no live session at all.
  socket.data._race10GrantReward = async (won) => {
    if (!authed) return null;
    _itemOpBusy++;
    try {
      const nexum = race10Liberty(won);
      const items = race10Rewards(won);
      const _rcBal = await _incBalance(authed.telegramId, 'nexumBalance', nexum);
      if (_rcBal !== null) _nexumBalance = _rcBal;
      socket.emit('nexumBalanceUpdate', { balance: _liveNexum() });
      const _liveSid = activeSessions.get(authed.telegramId);
      const _target = _liveSid === socket.id ? socket : _socketForTelegramId(authed.telegramId);
      const _result = _target && _target.data._applyGrant
        ? _target.data._applyGrant({ addItems: items.map(it => ({ item: it })) }, 'race10_reward',
            { items: items.map(i => i.id), nexum })
        : null;
      const _delivered = !!_result;
      if (!_delivered && items.length) {
        await _dbPushInventory(authed, items, 'race10_reward');
      }
      logPlayer(authed.telegramId, authed.username, 'race10_reward',
        { won: !!won, nexum, balance: _liveNexum(), items: items.map(i => i.id), delivered: _delivered });
      return { nexum, items, delivered: _delivered };
    } finally {
      _itemOpBusy--;
    }
  };

  // Coop's fixed boss reward — 1 bless_stone (a "safe" enchant stone, i.e.
  // one that can't fail/break an attempt) + 100 Liberty, to whichever
  // participant _coopBossTrackKill (server/index.js) randomly picked. Same
  // cross-socket-safe shape as _race10GrantReward just above: _incBalance is
  // a DB-level atomic op (safe to call from another connection's context),
  // and the item goes through _applyGrant against whichever socket is the
  // account's LIVE session right now (it may have reconnected on a
  // different one since the run started), falling back to a raw DB push if
  // there is no live session at all.
  socket.data._grantCoopBossReward = async () => {
    if (!authed) return null;
    _itemOpBusy++;
    try {
      const nexum = 100;
      const stone = { ..._STONE_DEFS.bless_stone, qty: 1 };
      const _rcBal = await _incBalance(authed.telegramId, 'nexumBalance', nexum);
      if (_rcBal !== null) _nexumBalance = _rcBal;
      socket.emit('nexumBalanceUpdate', { balance: _liveNexum() });
      const _liveSid = activeSessions.get(authed.telegramId);
      const _target = _liveSid === socket.id ? socket : _socketForTelegramId(authed.telegramId);
      const _result = _target && _target.data._applyGrant
        ? _target.data._applyGrant({ addItems: [{ item: stone }] }, 'coop_boss_reward', { items: ['bless_stone'], nexum })
        : null;
      const _delivered = !!_result;
      if (!_delivered) await _dbPushInventory(authed, [stone], 'coop_boss_reward');
      logPlayer(authed.telegramId, authed.username, 'coop_boss_reward', { nexum, balance: _liveNexum(), delivered: _delivered });
      return { nexum, items: [stone], delivered: _delivered };
    } finally {
      _itemOpBusy--;
    }
  };



  // Where this session currently is, for every persist path below. Used to be
  // written by the 60s autosave alone and by nothing else, so a player who
  // walked into an arm and dropped 10 seconds later had the HUB stored as
  // their floor — and _restoreFloorFor would faithfully put them back there.
  // The floor is only worth restoring if it is actually current, so every
  // write carries it: the periodic save, the debounced saveProgress, and the
  // final flush on disconnect.
  //
  // x/y ride along for the same reason the floor does. Landing on an arm's
  // entrance after every blip is better than landing in the hub, but it is
  // still not where the player was standing; the position is validated on the
  // way back out (see the restore in selectChar), never trusted blindly.
  function _wherePlayerIs() {
    const p = currentRoom && currentRoom.players.get(socket.id);
    // floor/x/y are ONE fact, and this either reports all of it or none of it.
    // Reporting a floor with no position to go with it is what stranded
    // people: currentFloor starts at the hub on every fresh connection and
    // only becomes real once selectChar seats the character, so a session that
    // logged in and never got that far — the app closed at the character
    // screen, a connection that died while it was loading — flushed
    // `floor: hub` on its way out and left the stored x/y pointing at
    // wherever the player had really been. The next login then read that pair
    // back, found coordinates the hub grid cannot contain, and dropped the
    // player on the hub spawn: "вышел в коридоре — зашёл в зале".
    //
    // Blanking all three (rather than returning {}) matters because every
    // caller spreads this OVER the save blob, and _sanitizeSavedStats passes
    // the client's own floor/x/y through untouched — so leaving the keys out
    // would persist whatever the client happened to send instead of simply
    // leaving the stored position alone. _persistSavedFields skips undefined,
    // so this writes none of the three.
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      return { floor: undefined, x: undefined, y: undefined };
    }
    return { floor: currentFloor, x: p.x, y: p.y };
  }


  // Wraps every socket.on registration below so a thrown error or rejected
  // promise inside a single handler can't escape to process scope — the
  // global uncaughtException/unhandledRejection handler calls process.exit()
  // shortly after logging, which would otherwise drop every connected
  // player's connection over one bad packet in one handler.
  //
  // Logging is throttled per event. console.error is a SYNCHRONOUS write and
  // formatting an Error means building its stack string, so a client sending
  // malformed packets in a loop turned every one of them into blocking I/O on
  // the same thread the world loop runs on — a handful of junk clients could
  // stall the tick for everyone without ever tripping the rate limiter's
  // budget. One line per event per _ERR_LOG_MS says the same thing.
  const _ERR_LOG_MS = 5000;
  const _errLoggedAt = new Map();
  function _logHandlerErr(event, err) {
    const now = Date.now();
    const last = _errLoggedAt.get(event) || 0;
    if (now - last < _ERR_LOG_MS) return;
    _errLoggedAt.set(event, now);
    console.error(`[socket:${event}]`, err);
  }
  function safeOn(event, handler) {
    socket.on(event, (...args) => {
      // A client can send an explicit null where a handler expects a payload
      // object; `({ x } = {})` defaults only cover undefined, so normalise it
      // here and let those defaults do their job for both cases.
      if (args.length && args[0] === null) args[0] = undefined;
      try {
        const ret = handler(...args);
        if (ret && typeof ret.catch === 'function') {
          ret.catch(err => _logHandlerErr(event, err));
        }
      } catch (err) {
        _logHandlerErr(event, err);
      }
    });
  }


  // ── Shared login plumbing ──────────────────────────────────────────────
  // loginTelegramWebApp (Mini App) and loginTelegram (bot widget) differ only
  // in how they establish WHO is logging in; everything after that was two
  // byte-identical copies, which is how a fix to one of them could silently
  // miss the other.














  // ── Quest progress ────────────────────────────────────────────────────────
  // claimQuest checked WHICH quest was being claimed but never whether it had
  // been done: the counters lived in the client's blob, so the server had
  // nothing to ask. A client could walk the whole 60-quest chain in one go.
  //
  // The server sees every event these counters are made of — kills, potion
  // purchases, clan membership, the corridor a kill happened in — so it counts
  // them itself, and the claim is checked against questComplete (shared, so the
  // button and the rule cannot disagree).
  function _questKills() {
    if (!_lastStats) return null;
    if (!_lastStats.questKills || typeof _lastStats.questKills !== 'object') _lastStats.questKills = {};
    return _lastStats.questKills;
  }

  // Only the CURRENT quest's counters are tracked, exactly as the client did:
  // a counter for a quest that isn't active yet would let a player arrive at it
  // already complete.
  function _currentQuest() {
    if (!_lastStats) return null;
    return QUEST_DEF[Math.max(0, Math.floor(Number(_lastStats.questIdx)) || 0)] || null;
  }

  function _questBump(key, by) {
    const k = _questKills();
    if (!k) return false;
    k[key] = Math.max(0, Math.floor(Number(k[key])) || 0) + (by || 1);
    return true;
  }

  // Pushes the counters and lets the client light up the claim button.
  function _questPush() {
    if (!_lastStats) return;
    socket.emit('questSync', { questIdx: _lastStats.questIdx || 0, questKills: _lastStats.questKills || {} });
  }

  // Called for every kill this session is credited for.
  function _questOnKill(eid, rlvl) {
    const q = _currentQuest();
    if (!q || !_questKills()) return;
    let changed = false;
    if ((q.type === 'kill' || q.type === 'kill_multi') && eid) {
      const def = ENEMY_DEF.find(e => e.eid === eid);
      // Matched on the base catalog name, the same string the quest lists and
      // the same one the client counted (the level prefix is display only).
      if (def && (q.enemies || []).includes(def.name)) changed = _questBump(def.name, 1);
    }
    // Legacy floor quests: with one seamless world there is no floor to walk
    // into, so reaching the corridor a kill happened in is what completes them
    // — the same rule the client applied in onEnterArm.
    if ((q.type === 'dungeon_clear' || q.type === 'goto_floor') && rlvl > 0) {
      const arm = armIndexForLevel(rlvl);
      if (q.type === 'dungeon_clear' && arm > q.floor) {
        const k = _questKills();
        if ((k['_dungeon_' + q.floor] || 0) < q.count) {
          k['_dungeon_' + q.floor] = q.count;
          changed = true;
        }
      }
      if (q.type === 'goto_floor' && arm >= q.targetFloor) {
        changed = _questBump('_floor_' + q.targetFloor, 1) || changed;
      }
    }
    if (changed) _questPush();
  }
  socket.data._questOnKill = (eid, rlvl) => _questOnKill(eid, rlvl);

  // ── Experience and level ──────────────────────────────────────────────────
  // The mirror image of gold. The server decided how much XP a kill was worth
  // and banked an entitlement for it (_allowXp), but the CLIENT applied the
  // clan bonus, the ×2 exp potion and the death penalty, added the result to
  // its own total, ran the level-up loop and reported the resulting level in
  // the next save. The ledger then checked afterwards whether that level was
  // reachable.
  //
  // Applying it here instead makes the level derivable, which is what lets the
  // ledger go: there is no claim left to audit.
  function _xpMult(base) {
    if (!(base > 0)) return 0;
    let x = base;
    const _cl = _myClanLevel ? CLAN_LEVELS[_myClanLevel - 1] : null;
    const clanPct = (_cl && _cl.bonus && _cl.bonus.xp) || 0;
    if (clanPct > 0) x = Math.round(x * (1 + clanPct / 100));
    const buffs = (_lastStats && _lastStats.buffs) || {};
    if (buffs.exp > 0) x *= 2;
    // Halving would floor a level-1 monster's single XP to zero — the penalty
    // must not be able to zero out a kill entirely, so it skips anything
    // already under 2. Identical to what gainXP did client-side.
    if (buffs.deathPenalty > 0 && x >= 2) x = Math.floor(x * 0.5);
    return Math.round(x);
  }

  // Credits XP, runs the level-up curve, and returns everything the client
  // needs to render the result. Levels raise the base stats by the same steps
  // the client used to apply, and computeStats (Room.js) reads them straight
  // out of _sd — so the room's idea of the player follows the level up without
  // waiting for a save.
  function _grantXp(base, opts) {
    if (!authed || !_lastStats) return null;
    const gained = (opts && opts.flat) ? Math.max(0, Math.round(Number(base) || 0)) : _xpMult(base);
    if (!(gained > 0)) return null;
    const before = Math.max(1, Math.floor(Number(_lastStats.lvl)) || 1);
    _lastStats.xp = Math.round((Number(_lastStats.xp) || 0) + gained);
    _lastStats.lvl = before;
    if (!Number.isFinite(Number(_lastStats.xpNext)) || _lastStats.xpNext <= 0) {
      _lastStats.xpNext = xpToNext(_lastStats.lvl);
    }
    while (_lastStats.xp >= _lastStats.xpNext && _lastStats.lvl < _SANITIZE_MAX.lvl) {
      _lastStats.xp = Math.round(_lastStats.xp - _lastStats.xpNext);
      _lastStats.lvl += 1;
      _lastStats.xpNext = xpToNext(_lastStats.lvl);
      _lastStats.baseAtk   = (Number(_lastStats.baseAtk)   || 0) + 1;
      _lastStats.baseDef   = (Number(_lastStats.baseDef)   || 0) + 1;
      _lastStats.baseMaxHp = (Number(_lastStats.baseMaxHp) || 0) + 20;
    }
    const levelled = _lastStats.lvl > before;
    if (levelled && currentRoom) {
      currentRoom.updatePlayerSavedData(socket.id, _lastStats);
      currentRoom.healPlayer(socket.id, 35 * (_lastStats.lvl - before));
      _persistSavedFields(authed, {
        lvl: _lastStats.lvl, xp: _lastStats.xp, xpNext: _lastStats.xpNext,
        baseAtk: _lastStats.baseAtk, baseDef: _lastStats.baseDef, baseMaxHp: _lastStats.baseMaxHp,
      });
      logPlayer(authed.telegramId, authed.username, 'level_up', { from: before, to: _lastStats.lvl });
    }
    return {
      gained, levelled,
      lvl: _lastStats.lvl, xp: _lastStats.xp, xpNext: _lastStats.xpNext,
      baseAtk: _lastStats.baseAtk, baseDef: _lastStats.baseDef, baseMaxHp: _lastStats.baseMaxHp,
    };
  }
  // A party member's share lands on their own session, for the same reason
  // their gold share does: their clan and their buffs are not visible here.
  socket.data._grantXp = (base, opts) => _grantXp(base, opts);

  // ── Gold ──────────────────────────────────────────────────────────────────
  // Gold was a client-side number. The server computed a kill's drop and sent
  // it, but the CLIENT applied the clan bonus and the ×2 potion on top, added
  // it to its own total, and reported the result in the next save. Merchant
  // purchases and the clan founding fee were deducted the same way — locally,
  // with the server never told the price.
  //
  // So the server had no idea what a player's balance should be, and the only
  // thing standing between that and an arbitrary figure was a rate guess (the
  // gold growth cap) that had to be loose enough never to punish a good farming
  // streak. Applying the multipliers here instead makes the total derivable,
  // which is what lets that cap go.
  function _goldNow() {
    return Math.max(0, Math.floor(Number(_lastStats && _lastStats.gold)) || 0);
  }

  // Credits gold and tells the client the new total. `reason` shows up in the
  // player log beside every other economic event.
  function _grantGold(amount, reason, opts) {
    if (!authed || !_lastStats || !(amount > 0)) return _goldNow();
    const before = _goldNow();
    const after = before + Math.floor(amount);
    _lastStats.gold = after;
    // Persisted on the ordinary save debounce rather than per kill: a kill is
    // the highest-frequency event in the game and a write per kill would be a
    // write per player per second. The debounce already covers a crash to
    // within a few seconds, which is the same window it always did.
    if (!(opts && opts.quiet)) socket.emit('goldSync', { gold: after });
    return after;
  }

  // Everything a kill's gold passes through before it lands, in the order the
  // client used to apply it: the VIP bonus is already folded into the figure
  // Room.js returns, then the clan's gold bonus, then the ×2 potion.
  function _killGold(base) {
    if (!(base > 0)) return 0;
    let g = base;
    const _cl = _myClanLevel ? CLAN_LEVELS[_myClanLevel - 1] : null;
    const clanPct = (_cl && _cl.bonus && _cl.bonus.gold) || 0;
    if (clanPct > 0) g = Math.round(g * (1 + clanPct / 100));
    if (((_lastStats && _lastStats.buffs) || {}).gold > 0) g *= 2;
    return Math.floor(g);
  }




  function _itemErr(msg) { socket.emit('itemError', { msg }); }

  // True while an async handler that CLONES _lastStats.inventory before an
  // await (gramShopBuy/specialShopBuy/claimVipRewards — see _itemOpBusy's own
  // comment, above) is mid-flight. Every handler below moves an item into or
  // out of the SAME live inventory array synchronously; if one of those
  // clone-and-commit handlers is holding a snapshot taken before this runs,
  // this handler's own splice/push is invisible to it — and gets silently
  // discarded, or for a move INTO a slot (equip, an unequip landing back in
  // inventory), duplicated, since the item survives in both the stale clone
  // and its new home the instant that handler's delayed _commitServerItems
  // stamps the snapshot back over the live array. Refusing here for the
  // brief window _itemOpBusy is raised closes the race at the source rather
  // than trying to reconcile it after the fact.
  function _itemsBusy() { return _itemOpBusy > 0; }
  const _ITEMS_BUSY_MSG = 'Секунду, идёт другая операция — повторите';


































  // ── Сезон 2 ───────────────────────────────────────────────────────────────
  // Every point is added right here. seasonPoints2 never travels in from a
  // client save (_sanitizeSavedStats drops it, same as the balances), so the
  // leaderboard the prizes are read off cannot be written to by the people
  // competing on it.
  // Held here rather than on _lastStats: that object is REPLACED wholesale by
  // every saveProgress with the sanitized client blob, and the sanitizer
  // deletes the season field (it must never arrive from a client). Keeping it
  // there meant each save silently wiped the running total from memory — the
  // panel fell back to 0. Same reason the currency balances live in their own
  // closure variables.
  let _seasonPoints = 0;


  // Atomic, like the currency balances — two sockets for one account (a
  // reconnect overlapping its predecessor) must not lose each other's points.
  async function _seasonAddPoints(n, reason, meta) {
    if (!authed || !Number.isFinite(n) || n <= 0) return null;
    if (!seasonActive()) {
      logPlayer(authed.telegramId, authed.username, 'season_points_failed',
        { add: n, reason, why: 'season_over', ...(meta || {}) });
      return null;
    }
    try {
      // An account that only ever pressed /start has savedData: null, and a
      // dotted $inc against a null parent THROWS instead of creating it — the
      // same trap _incBalance documents. Without this the award was lost and
      // the only trace was a console line.
      await PlayerModel.updateOne(
        { telegramId: String(authed.telegramId), savedData: null },
        { $set: { savedData: {} } },
      );
      const doc = await PlayerModel.findOneAndUpdate(
        { telegramId: String(authed.telegramId) },
        { $inc: { 'savedData.seasonPoints2': n } },
        { new: true, projection: { 'savedData.seasonPoints2': 1 } },
      ).lean();
      // No document matched: nothing was incremented. This used to fall
      // through to `total = 0`, which both reported success to the caller AND
      // wiped the running total held in memory — a failed award turned into a
      // reset to zero. Report the failure instead and leave _seasonPoints be.
      if (!doc) {
        logPlayer(authed.telegramId, authed.username, 'season_points_failed',
          { add: n, reason, why: 'player_not_found', ...(meta || {}) });
        return null;
      }
      const total = Math.max(0, Math.floor(Number(doc?.savedData?.seasonPoints2) || 0));
      _seasonPoints = total;
      logPlayer(authed.telegramId, authed.username, 'season_points', { add: n, total, reason, ...(meta || {}) });
      return total;
    } catch (err) {
      console.error('_seasonAddPoints:', err);
      // Both rows on purpose: the 'error' one so it shows under Ошибки with a
      // stack message, and the durable season one so it survives the ordinary
      // log's 100-row window like every other points movement.
      logPlayerErr(authed.telegramId, authed.username, 'season_points', err, { add: n, reason, ...(meta || {}) });
      logPlayer(authed.telegramId, authed.username, 'season_points_failed',
        { add: n, reason, why: 'db_error', message: err && err.message, ...(meta || {}) });
      return null;
    }
  }



  // ── Приведи друга ─────────────────────────────────────────────────────────
  // Paid to the REFERRER when someone they invited reaches SEASON_REF_LEVEL.
  // The claim is the flag flip itself: only the update that actually changes
  // seasonRefPaid from unset to true goes on to pay, so two sessions racing
  // (or one player relogging) cannot collect twice. The flag lives on the
  // FRIEND's document because that is what "this friend has been counted"
  // is about — and _sanitizeSavedStats strips it from client saves, so the
  // friend cannot clear their own.
  //
  // Checked at most once per session: the level only ever goes up, so if it
  // is not there yet at login the next login will catch it.
  let _seasonRefChecked = false;
  async function _seasonCheckRefFriend() {
    if (_seasonRefChecked || !authed || !_lastStats || !seasonActive()) return;
    const lvl = Math.floor(Number(_lastStats.lvl)) || 1;
    if (lvl < SEASON_REF_LEVEL) return;
    _seasonRefChecked = true;
    try {
      const me = await PlayerModel.findOneAndUpdate(
        {
          _id: authed._id,
          referredBy: { $nin: [null, ''] },
          'savedData.seasonRefPaid': { $ne: true },
        },
        { $set: { 'savedData.seasonRefPaid': true } },
        { new: false, projection: { referredBy: 1 } },
      ).lean();
      if (!me || !me.referredBy) return;   // no referrer, or already paid
      const total = await _seasonAddPointsTo(me.referredBy, SEASON_REF_POINTS,
        'ref_lvl20', { friend: authed.username, lvl });
      if (total === null) return;
      // The referrer is usually a different session, and may be offline —
      // the room emit reaches every device they have open and is simply
      // dropped when there are none.
      io.to(`tg_${me.referredBy}`).emit('seasonRefBonus', {
        points: SEASON_REF_POINTS, friend: authed.username, total,
      });
    } catch (err) { console.error('_seasonCheckRefFriend:', err); }
  }
  socket.data._seasonCheckRefFriend = _seasonCheckRefFriend;



  // ── Addressing an inventory item the client tapped ────────────────────────
  // The client sends the slot INDEX it drew the item at, and destructive
  // handlers (burn, sell) used to index straight into the server's own array
  // with it. The two copies legitimately drift: every server-side splice
  // (craft materials, a market listing, a clan deposit) renumbers the server's
  // slots, and the client only catches up when the inventorySync that follows
  // arrives. A tap sent inside that window addressed a DIFFERENT item — and
  // for the burn path, which accepts any burnable rarity, that meant
  // destroying something the player never picked.
  //
  // So the request also carries WHAT the client thinks is there (id, plus
  // enhance for gear, where +0 and +9 of the same sword are different things
  // to own — the same identity scheme enhanceItem resolves by). The index is
  // used as a hint and verified; if it doesn't hold, the item is looked up by
  // identity instead, and only a request naming something the server doesn't
  // have at all is refused. `id` absent means a client from before this
  // change: fall back to the index alone so an open tab keeps working.
  // Returns an index, or -1.
  function _resolveInvIdx(inv, idx, id, enhance) {
    const i = Math.floor(Number(idx));
    const inRange = Number.isFinite(i) && i >= 0 && i < inv.length;
    if (id == null) return inRange ? i : -1;
    const wantEnh = Math.floor(Number(enhance));
    const _matches = it => it && it.id === id &&
      (!ENHANCEABLE_SLOTS.has(_itemSlotOf(it)) || !Number.isFinite(wantEnh) || (it.enhance || 0) === wantEnh);
    if (inRange && _matches(inv[i])) return i;
    return inv.findIndex(_matches);
  }














  // Real floor transition — replaces the old client-only _teleportTo trick
  // (js/game.js) for the hub's arm pads, and (as the special zones split off
  // the hub one by one, see server/game/floors.js) their pads too: the player
  // leaves their current floor's Room entirely and joins a different one,
  // with its own grid/enemies/NPCs, instead of just being repositioned
  // inside a shared grid. `target` is an arm key ('left'/'top'/'bottom'/
  // 'right'), a special-zone key ('guildWar', …), 'hub', or (force-only, see
  // below) a raw numeric floor id.
  //
  // Factored out of the socket handler (rather than living inline in it) so
  // code OUTSIDE this connection — a scheduled window closing, a match
  // ending — can also move this specific player between floors. Every other
  // per-connection escape hatch in this file follows the same shape: a
  // closure assigned onto socket.data (see _grantXp, _questOnKill, …) so a
  // handler elsewhere can call back into a connection it doesn't otherwise
  // have a reference to.
  //
  // `force` skips every gate (level/window/reachability) and accepts a raw
  // floor id as `target` — this is what a trusted server-initiated move
  // (an eviction, a death-battle deploy or its return-to-wherever-you-were)
  // needs: those are not requests that can be refused, they are the server
  // telling this connection where it has already decided the player goes.
  // The plain client-facing 'enterLocation' handler below never sets it.
  //
  // `pos`, when given, overrides the landing spot after the normal join
  // (which otherwise always lands on the target floor's own default spawn/
  // zone placement) — used only by the death battle's "send this entrant
  // back to the exact spot they were standing in before" return path.
  function _doEnterLocation(target, { force = false, pos, room = null } = {}) {
    if (!authed || !currentRoom) return false;
    const oldP = currentRoom.players.get(socket.id);
    if (!oldP || !oldP.type) return false; // no character selected yet
    let targetFloor;
    if (force && typeof target === 'number') {
      targetFloor = target;
    } else if (target === 'hub') {
      targetFloor = FLOOR_IDS.hub;
    } else if (target === 'guildWar') {
      // Combat access follows the daily window, not a level — see _gw
      // (phase 'live' only 22:00-22:15 MSK).
      if (!force && _gw.phase !== 'live') { socket.emit('enterLocationDenied', { target, reason: 'closed' }); return false; }
      targetFloor = FLOOR_IDS.guildWar;
    } else if (target === 'arena') {
      // Reachable while a world boss is up (or its loot still lies on the
      // floor) — see _arenaOpen. Death Battle deploys entrants with
      // force:true regardless, since registering for it has nothing to do
      // with whether a world boss happens to be up at the same time.
      if (!force && !_arenaOpen()) { socket.emit('enterLocationDenied', { target, reason: 'closed' }); return false; }
      targetFloor = FLOOR_IDS.arena;
    } else if (target === 'farmZone2') {
      // Элитная фарм-зона has no walk-in pad — this floor's monsters are
      // baked in at world-gen (unlike Fear/Coop's runtime-spawned ones), so
      // an ordinary enterLocation landing here directly would find a fully
      // populated, functional zone with no party-of-3/leader/daily-minutes
      // gating ever having run. The only sanctioned way in is
      // farm2GroupStart, which calls this with force:true — a plain client
      // request always gets denied, same "no equivalent to a walk-in pad"
      // deal Fear/Coop's own floors have (their own generic branch below
      // would technically also accept a bare request, they just never spawn
      // anything for it to find).
      if (!force) { socket.emit('enterLocationDenied', { target, reason: 'partyOnly' }); return false; }
      targetFloor = FLOOR_IDS.farmZone2;
    } else if (FLOOR_IDS[target] != null) {
      // Server-side level gate — the pad's own lock icon is client-side
      // decoration only, this is the check that actually matters. Фарм-зона
      // used to only ever be checked client-side (FARM_ENTRY_LEVEL, shared/
      // definitions.js) — folded into the same map as the arms' own
      // ARM_LEVEL_REQ now that entry is a real gated floor transition too.
      const req = _ZONE_LEVEL_REQ[target] || 0;
      const lvl = (oldP._sd && oldP._sd.lvl) || 1;
      if (!force && lvl < req) { socket.emit('enterLocationDenied', { target, reason: 'level', req }); return false; }
      targetFloor = FLOOR_IDS[target];
    } else {
      return false; // unknown target
    }
    if (targetFloor === currentFloor) return false; // already there

    const oldFloor = currentFloor;
    const charType = oldP.type;
    const savedStats = oldP._sd;

    // Fear/Coop players never join the shared floor_<id> broadcast group —
    // each Fear entrant (and each Coop pair) is on its own private Room now
    // (see _createFearRoom/_createCoopRoom), so there is never anyone else
    // legitimately on that floor id to tell about a join/leave/char change,
    // and joining them all into one group would leak exactly that across
    // otherwise-isolated runs. Skipping the join means every
    // socket.to(`floor_${currentFloor}`) broadcast below is already a no-op
    // for Fear/Coop on their own — nothing else here needs to know the
    // difference.
    if (oldFloor !== FLOOR_IDS.fear && oldFloor !== FLOOR_IDS.coop && oldFloor !== FLOOR_IDS.farmZone2) socket.leave(`floor_${oldFloor}`);
    // Walking out of Страх ends the run, exactly as dying in it does.
    //
    // Only two things used to end a run: clearing wave FEAR_MAX_WAVE and
    // dying (_fearFinish / _fearEliminate). Leaving the floor any other way —
    // the player choosing a destination from the map, or an event window
    // closing and force-moving them — took them off the fear floor and left
    // the _fear record behind. That record is what every later fearEnter
    // checks first, and it returns SILENTLY on a hit: the player is standing
    // in the hub, the button does nothing at all, no error is shown, and
    // their remaining attempts are never spent. It reads as "попытки в Страх
    // не уходят", and only for the players who happen to leave that way —
    // anyone who dies or clears the run is unaffected.
    //
    // Released before removePlayer, for the reason spelled out in
    // _fearFinish: removePlayer holds a still-owned lane open on the 45s
    // reconnect grace, which is meant for a genuine disconnect and not for
    // someone who deliberately walked out.
    //
    // A real disconnect does NOT come through here — it goes to
    // _fearHoldOnDisconnect and keeps its grace window, which is the whole
    // point of the distinction.
    if (oldFloor === FLOOR_IDS.fear && _fearReleaseRun(socket.id)) {
      // The client mirrors this state in page-level JS (_fearInRun,
      // js/network.js) and would otherwise keep drawing the wave HUD for a
      // run that no longer exists. attemptsLeft is deliberately omitted —
      // it costs a DB read and the client keeps its previous value for any
      // field this event leaves out.
      socket.emit('fearState', {
        maxAttempts: FEAR_ATTEMPTS, maxWave: FEAR_MAX_WAVE, minLevel: FEAR_MIN_LEVEL,
        inRun: false, wave: 0,
      });
    }
    // Same reasoning as Fear's own block just above, for Сотрудничество —
    // walking off the coop floor any other way than clearing/dying also has
    // to end the run, and (there being no way to continue with only one of
    // the two) end it for the partner too. This function is only already
    // moving THIS connection, so the partner has to be redirected home
    // explicitly rather than left mid-lane forever waiting on a stage that
    // can now never clear.
    if (oldFloor === FLOOR_IDS.coop) {
      const run = _coop.get(socket.id);
      if (run) {
        const partnerId = run.partnerId;
        _coopReleaseRun(socket.id);
        if (partnerId && _coop.has(partnerId)) _coopFinish(partnerId, false);
        socket.emit('coopState', {
          maxAttempts: COOP_ATTEMPTS, maxStage: COOP_STAGE_LEVELS.length, minLevel: COOP_MIN_LEVEL,
          inRun: false, stage: 0,
        });
      }
    }
    // Same reasoning as Coop's own block just above, generalized from
    // exactly-2 to "fewer than FARM2_PARTY_SIZE still in" — walking off the
    // Элитная фарм-зона floor any other way than the run's own end also has
    // to end this connection's own membership, and cascades to whoever else
    // is still in via _farm2CascadeCheck (self already excluded, since
    // _farm2ReleaseRun above already removed it from `_farm2`).
    if (oldFloor === FLOOR_IDS.farmZone2) {
      const run = _farm2.get(socket.id);
      if (run) {
        const { room, participantIds } = run;
        _farm2ReleaseRun(socket.id);
        _farm2CascadeCheck(room, participantIds);
        socket.emit('farm2State', {
          entryLevel: FARM2_ENTRY_LEVEL, partySize: FARM2_PARTY_SIZE, dailyMinutes: FARM2_DAILY_MINUTES,
          inRun: false,
        });
      }
    }
    currentRoom.removePlayer(socket.id);
    socket.to(`floor_${oldFloor}`).emit('playerLeft', { id: socket.id });

    currentFloor = targetFloor;
    playerFloorMap.set(socket.id, currentFloor);
    if (currentFloor !== FLOOR_IDS.fear && currentFloor !== FLOOR_IDS.coop && currentFloor !== FLOOR_IDS.farmZone2) socket.join(`floor_${currentFloor}`);
    // `room`, when given, is a fresh private instance this connection just
    // created (fearEnter) — the ordinary getRoom(floorId) lookup only ever
    // returns the one shared Room per floor, which Fear no longer has one of.
    currentRoom = room || getRoom(currentFloor);
    currentRoom.addPlayer(socket.id, authed.username, _myClanName, _myClanIcon, clanAtkBonusPct(_myClanLevel), authed.telegramId, _myClanId);
    currentRoom.setPlayerChar(socket.id, charType, savedStats);
    // Guild War: spread fresh entrants across the spawn ring instead of
    // landing everyone on the same tile — the same placement a mid-window
    // death respawn already uses (Room.guildWarRespawn).
    if (target === 'guildWar') currentRoom.guildWarRespawn(socket.id);
    const _joined = currentRoom.players.get(socket.id);
    // Validated against the DESTINATION floor's own grid, never applied raw.
    // `pos` is a spot remembered from before a deploy (_dbReturnEntrant), and
    // the only thing that guarantees it is still standable on arrival is that
    // it came from this same floor — which is a caller's invariant, not
    // something checkable here. A restore that drops someone inside geometry
    // strands them in a wall with no way out (the client's own collision only
    // stops you ENTERING a wall, it can't push you out of one), so a spot the
    // floor won't accept falls through to the normal spawn placement instead
    // — the same rule the reconnect restore in selectChar already applies.
    if (pos && _joined && currentRoom.canStandAt(pos.x, pos.y)) { _joined.x = pos.x; _joined.y = pos.y; }
    socket.to(`floor_${currentFloor}`).emit('playerJoined', { id: socket.id, username: authed.username });
    socket.to(`floor_${currentFloor}`).emit('playerChar', { id: socket.id, type: charType });

    socket.emit('gameStart', _buildGameStartPayload(socket, currentRoom, currentFloor));
    socket.emit('playerPets', { pets: currentRoom.petSnapshot() });
    const _selfP2 = currentRoom.players.get(socket.id);
    if (_selfP2 && _selfP2.petId) {
      socket.to(`floor_${currentFloor}`).emit('playerPet', { id: socket.id, petId: _selfP2.petId });
    }
    // 'enter_zone' quests (currently just "Войди в Фарм-зону") complete the
    // instant the transition actually lands — unlike goto_floor's legacy
    // kill-triggered proxy (there's no monster-level curve to hook into for
    // a zone that isn't part of the arm progression), this fires directly
    // off the real event.
    {
      const q = _currentQuest();
      if (q && q.type === 'enter_zone' && q.zone === target) {
        if (_questBump('_zone_' + target, 1)) _questPush();
      }
    }
    return true;
  }
  socket.data._forceEnterLocation = (target, opts) => _doEnterLocation(target, { ...opts, force: true });


















































  // Recipients for a visual-only combat event: everyone close enough to see
  // the point it happens at. These used to go to `floor_${currentFloor}`,
  // which — with one shared world floor — means every player online, so a
  // single archer's auto-attack cost one packet per player and the feature's
  // total cost grew as the square of the population (measured: 37% of a CPU
  // core at 150 players firing twice a second, more than the world simulation
  // itself). Same treatment enemyHurt/enemyKilled already get, see
  // _emitToEnemyViewers.
  // `includeSelf` is for the events the caster's own client does NOT render
  // locally and therefore has to be told about like everyone else.
  function _emitNearby(x, y, event, payload, includeSelf) {
    if (!currentRoom) return;
    const ids = currentRoom.nearbyPlayerIds(x, y, includeSelf ? null : socket.id,
      currentRoom.laneOf(socket.id));
    if (!ids.length) return;
    io.to(ids).emit(event, payload);
  }
















  // ── Clan handlers ─────────────────────────────────────────────
  // _clanDataFor / _notifyClan now live at module scope (see the clan helpers
  // block above) — they take no closure state, and the batched XP flusher
  // needs them too.












  // ── Хранилище клана ───────────────────────────────────────────────────────
  // A shared pool of Осколки: members deposit, the leader decides who gets
  // what. Shards do NOT go straight from the pool into the recipient's
  // inventory — the leader allocates, the member collects. The recipient is
  // usually offline when a leader hands things out, and writing items into an
  // offline account's saved inventory races that account's own next login;
  // making the member collect means every grant lands through their own live
  // session and _commitServerItems, the same path all other server-side item
  // grants use.
  //
  // Every mutation below is a single conditional Mongo update rather than
  // read-modify-write: two members depositing, or a leader handing out the
  // same stack twice from two taps, must not be able to interleave.













  // ── Market ────────────────────────────────────────────────────────────────
  // The six market handlers live in server/handlers/market.js now. They are
  // per-connection, not a module-level state machine, so unlike the game-mode
  // splits they take a session object rather than a plain deps bag: authed and
  // lastStats are getters onto this closure's own variables, which is what
  // lets the module see the values selectChar/saveProgress install LATER,
  // after it has been wired. _itemOpBusy is reached through begin/end rather
  // than handed over, because it is shared with every other item handler in
  // this closure and has to stay one counter.
  registerMarket(session, safeOn, {
    MarketListingModel, PlayerModel, io, activeSessions,
    logPlayer, logPlayerErr,
    _marketListingData, _marketHistoryData, _marketMaxActive, _marketMinPrice,
    _canonicalMarketItem, _round2, _round7,
    _incBalance, _spendBalance, _socketForTelegramId, _setVipAura, _dbPushInventory,
    _invFindOwned, _invHasRoomFor, _invAdd, _invRemove,
    MARKET_MAX_PRICE, MARKET_LIST_COOLDOWN_MS, MARKET_FEE_PCT, MARKET_VIP_PCT,
    VIP_THRESHOLDS,
  });
  // ── clan ────────────────────────────────────────────────────────────────
  // Moved to server/handlers/clan.js — see the note there.
  registerClan(session, safeOn, {
      CLAN_CREATE_COST, CLAN_MAX_MEMBERS, CLAN_STORAGE_MIN_DAYS,
      CLAN_STORAGE_UNLOCK_GOLD, CRAFT_MATS, ClanModel, FLOOR_IDS,
      GuildWarStateModel, SERVER_INV_MAX, UNIQUE_SHARDS, _clanDataFor,
      _clearOtherClanApplications, _escapeRegex, _gw, _gwPublicState, _invAdd,
      _notifyClan, _recordClanChat, _sanitizeClanDesc, _sanitizeName,
      _socketForTelegramId, activeSessions, clanAtkBonusPct, clanChatHistory,
      getRoom, io, logPlayer, logPlayerErr,
  });
  // ── craft ───────────────────────────────────────────────────────────────
  // Moved to server/handlers/craft.js — see the note there.
  registerCraft(session, safeOn, {
      ADV_SKILL_BOOK_CRAFT, BOX_DEF, CLASS_GEAR_SALVAGE_RECIPES, CRAFT_MATS,
      ENHANCEABLE_SLOTS, ENHANCE_MAX, GEAR_CRAFT_RECIPES,
      GEAR_TIER_CRAFT_RECIPES, ITEM_DEF, MAT_UPGRADE_RECIPES,
      PET_CRAFT_RECIPES, SEASON_ADV_BOOK_POINTS, SERVER_INV_MAX,
      UNIQUE_CRAFT_RECIPES, _catalogBase, _incBalance, _invAdd,
      _socketForTelegramId, _spendBalance, activeSessions, isStackableItem,
      logPlayer, logPlayerErr, seasonActive, seasonEnhancePoints,
  });
  // ── gram ────────────────────────────────────────────────────────────────
  // Moved to server/handlers/gram.js — see the note there.
  registerGram(session, safeOn, {
      BOX_DEF, CRAFT_MATS, GRAM_MIN_WITHDRAW, GramTxModel, ITEM_DEF,
      POTION_CAP, PlayerModel, SERVER_INV_MAX, STARTER_BONUS, VIP_THRESHOLDS,
      _GRAM_SHOP_PKGS, _SHOP_ARMOR_SETS, _SHOP_CLASS_WEAPONS, _STONE_DEFS,
      _VIP_BP, _incBalance, _persistSavedFields, _setVipAura, _shopNewSlots,
      _socketForTelegramId, _spendBalance, _txData, activeSessions, io,
      logPlayer, logPlayerErr, notifyAdminGram, pkgPrice, seasonActive,
      seasonShopPoints,
  });
  // ── skills ──────────────────────────────────────────────────────────────
  // Moved to server/handlers/skills.js — see the note there.
  registerSkills(session, safeOn, {
      ADV_SKILL_STUDY_COST, BOX_DEF, CHAR_DEF, CRAFT_MATS, FLOOR_IDS, ITEM_DEF,
      PASSIVE_MAX_LEVEL, REBIRTH_BONUS_SP, REBIRTH_LEVEL,
      SEASON_REBIRTH_POINTS, SKILL_MAX_LEVEL, SKILL_SLOTS, SKILL_STUDY_COST,
      SKILL_UPGRADE_CHANCE, SKILL_UPGRADE_COST, UPGRADE_KEYS,
      UPGRADE_RESET_COST, _persistSavedFields, _spendBalance, advSkillBookId,
      availableSkillPoints, logPlayer, logPlayerErr, passiveBookId, passiveDefById,
      rebirthCostFor, seasonActive, skillBookId, skillPointBudget, spentSkillPoints,
      upgradeCost, xpToNext,
  });
  // ── items ───────────────────────────────────────────────────────────────
  // Moved to server/handlers/items.js — see the note there.
  registerItems(session, safeOn, {
      CRAFT_MATS, FLOOR_IDS, ITEM_DEF, MERCHANT_SHOP, POTION_CAP,
      SERVER_INV_MAX, TELEPORT_CAST_MS, TELEPORT_STONE_PRICE, _HP_POTION_HEAL,
      _HP_POTION_IDS, _catalogBase, _incBalance, _invAdd, _invHasRoomFor,
      _invRemove, _isStackable, _persistSavedFields, _socketForTelegramId,
      _spendBalance, _teleportCastFrozen, _teleportCasting, activeSessions,
      codexItemMeetsReq, codexSetById, codexTotalBonus, isStackableItem,
      logPlayer, logPlayerErr,
  });
  // ── questseason ─────────────────────────────────────────────────────────
  // Moved to server/handlers/questseason.js — see the note there.
  registerQuestseason(session, safeOn, {
      BOX_DEF, CRAFT_MATS, GramTxModel, ITEM_DEF, PVP_HISTORY_KEEP,
      PlayerModel, PvpHistoryModel, QUEST_DEF, SEASON_ADV_BOOK_POINTS,
      SEASON_BOOK_BURN_POINTS, SEASON_BURN_POINTS, SEASON_END_AT,
      SEASON_ENHANCE_GEAR_POINTS, SEASON_ENHANCE_SPECIAL_POINTS,
      SEASON_ENHANCE_SPECIAL_SLOTS, SEASON_PRIZES, SEASON_RATING_MIN_POINTS,
      SEASON_REBIRTH_POINTS, SEASON_REF_LEVEL, SEASON_REF_POINTS,
      SEASON_SHOP_POINTS_PER_GRAM, SEASON_VIP_PRIZE, SERVER_INV_MAX,
      SpecialQuestModel, _catalogBase, _incBalance, _invAdd, _isStackable,
      _persistSavedFields, _ratingClans, _ratingPlayers, _refLink,
      _socketForTelegramId, _vipGoldReward, _vipLevelItems, activeSessions,
      isStackableItem, logPlayer, logPlayerErr, questComplete, seasonActive,
  });
  // ── chat ────────────────────────────────────────────────────────────────
  // Moved to server/handlers/chat.js — see the note there.
  registerChat(session, safeOn, {
      _dmKey, _recordChat, _recordDm, _removeFromParty, _resolveUsername,
      _translateText, activeSessions, calcBM, dmHistory, io, parties,
      playerParty,
  });
  // ── coopfarm2 ───────────────────────────────────────────────────────────
  // Moved to server/handlers/coopfarm2.js — see the note there.
  registerCoopfarm2(session, safeOn, {
      COOP_ATTEMPTS, COOP_MIN_LEVEL, COOP_STAGE_LEVELS, COOP_START_DELAY_MS,
      FARM2_DAILY_MINUTES, FARM2_ENTRY_LEVEL, FARM2_PARTY_SIZE, _a3, _coop,
      _coopAttemptsLeft, _coopGroupBroadcastList, _coopGroupDissolve,
      _coopGroupOf, _coopGroupOpenList, _coopGroupPush, _coopGroupStateFor,
      _coopGroups, _createCoopRoom, _createFarm2Room, _db, _farm2,
      _farm2CascadeCheck, _farm2Finish, _farm2GroupBroadcastList,
      _farm2GroupDissolve, _farm2GroupOf, _farm2GroupOpenList, _farm2GroupPush,
      _farm2GroupStateFor, _farm2Groups, _farm2MinutesLeft, _farm2Starting,
      _fear, _lockCoopDaily, _lockFarm2Minutes, _race10, _removeFromParty,
      _returnToHub, io, parties, playerParty, safeInterval, safeTimeout,
  });
  // ── pvpmodes ────────────────────────────────────────────────────────────
  // Moved to server/handlers/pvpmodes.js — see the note there.
  registerPvpmodes(session, safeOn, {
      ARENA3_MIN_LEVEL, FEAR_ATTEMPTS, FEAR_MAX_WAVE, FEAR_MIN_LEVEL,
      FEAR_START_DELAY_MS, RACE10_MIN_LEVEL, _a3, _a3Allies, _a3Broadcast,
      _a3Enemies, _a3PublicState, _a3TryStartSafe, _arena3AttemptsLeft, _coop,
      _coopGroupOf, _createFearRoom, _db, _dbBroadcast, _dbPublicState,
      _dbReturnEntrant, _farm2, _farm2GroupOf, _fear, _fearAttemptsLeft,
      _fearStartWave, _lockFearDaily, _pvpEliminate, _pvpFrozen, _race10,
      _race10AttemptsLeft, _race10Broadcast, _race10PublicState, _returnToHub,
      io, playerParty, safeTimeout,
  });
  // ── world ───────────────────────────────────────────────────────────────
  // Moved to server/handlers/world.js — see the note there.
  registerWorld(session, safeOn, {
      COOP_LIBERTY_CHANCE, FARM2_LIBERTY_CHANCE, HEAL_PARTY_CD_MS,
      NC_AOE_STYLES, NC_FACING, SEASON_TICKET_LIBERTY_PCT,
      SEASON_TICKET_XP_PCT, VIP_BONUSES, _clanXpAdd, _coopBossTrackKill,
      _coopTrackKill, _emitToEnemyViewers, _fearTrackKill, _gw,
      _gwApplyCapture, _pvpEliminate, _pvpFrozen, _race10, _race10Finish,
      _round7, armIndexForLevel, getRoom, io, isFinite, parties,
      playerFloorMap, playerParty, safeTimeout, seasonActive,
  });
  // ── auth ────────────────────────────────────────────────────────────────
  // Moved to server/handlers/auth.js — see the note there.
  registerAuth(session, safeOn, {
      CHAR_DEF, ClanModel, FLOOR_IDS, GRAM_WALLET, PlayerModel, Room,
      TG_ADMIN_ID, _a3Broadcast, _buildGameStartPayload, _clanDataFor,
      _coopGroupDropOnDisconnect, _dbBroadcast, _farm2EjectOnDisconnect,
      _farm2GroupDropOnDisconnect, _fear, _fearDisconnectGrace, _fearStartWave,
      _gramBalanceCache, _logWritesSinceTrim, _maintenanceMode,
      _nexumBalanceCache, _notifyAdminNewPlayer, _partyDisconnectGrace,
      _partyHoldOnDisconnect, _pendingFlush, _persistSavedFields,
      _publicChatHistory, _pvpEliminate, _pvpHistoryWritesSinceTrim,
      _race10Broadcast, _reclaimQueues, _recordSessionEnd, _refLink,
      _registerReferral, _restoreFloorFor, _safeUsername, _sanitizeSavedStats,
      _setVipAura, _teleportCasting, _topPlayerUsername, _trackFearRoom,
      _unknownItemIds, _vipAuraUsers, activeSessions, calcBM, clanAtkBonusPct,
      codexTotalBonus, getRoom, globalChatHistory, io, logPlayer, migrateKeptSP,
      parties, playerFloorMap, playerParty, safeInterval, safeTimeout,
      verifyTelegramAuth, verifyTelegramWebApp,
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server on port ${PORT}`);
  // Same reasoning as the getMe call above: getUpdates can only 404 without a
  // real token, and _pollTg re-arms itself every 500ms, so an unconfigured
  // instance — or a local dev one, whose token is a dummy used purely to sign
  // its own initData — would hammer api.telegram.org for nothing.
  if (_TG_TOKEN && process.env.DEV_LOCAL !== '1') _pollTg();
  _dbSchedule();
  _wbSchedule();
  _race10Schedule();
  _a3Schedule();
  _gwSchedule();
  _gwIncomeSchedule();
  console.log('next death battle:', new Date(_dbNextStartAt()).toISOString(),
              '| next world boss:', new Date(_wbNextStartAt()).toISOString(),
              '| next Bloody Tower window:', new Date(_race10NextOpenAt()).toISOString(),
              '| next 3v3 window:', new Date(_a3NextOpenAt()).toISOString(),
              '| next Guild War window:', new Date(_gwNextOpenAt()).toISOString());
});

// ── Error handlers ────────────────────────────────────────────────────────────
// A rejected promise nobody handled. Unlike uncaughtException this does NOT
// mean the process is unsound — it usually means one handler forgot a .catch —
// so it logs and continues. But it went only to the console before, where
// nobody reads it, which is how a handler that has been quietly failing for a
// week gets discovered by a player report instead of by us. The alert
// collapses by key, so a rejection inside a loop is one message and a count.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  try {
    require('./tg-ops').alertError('unhandled.rejection', 'Необработанная ошибка в обработчике', reason);
  } catch { /* never let reporting be the failure */ }
});
// A throw that reached process scope means the state of this process is now
// UNDEFINED — some invariant broke somewhere and nothing caught it. The old
// handler logged, then waited two seconds before exiting, and during those two
// seconds the server kept accepting socket events and kept writing to the
// database. That is a window in which corruption gets persisted, and it is the
// worst possible moment to still be taking work.
//
// So: stop taking work first, THEN allow the already-started writes to finish,
// THEN die. The two seconds are for draining, not for serving.
let _fatal = false;
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  // A second throw while dying must not restart the clock or re-run the
  // teardown — that turns a crash into a hang.
  if (_fatal) return;
  _fatal = true;

  // Each guarded separately: one of these failing is entirely plausible in a
  // process that has already thrown, and it must not stop the others.
  try { server.close(); } catch (e) { console.error('[fatal] server.close:', e.message); }
  try { io.close(); } catch (e) { console.error('[fatal] io.close:', e.message); }
  try { floorRooms.forEach(r => r._stopLoop()); } catch (e) { console.error('[fatal] rooms:', e.message); }

  // Tell the admins, best-effort and without awaiting: an alert that hangs
  // would hold the process open past the exit timer.
  try {
    require('./tg-ops').alertError('fatal.uncaught', 'Сервер упал — процесс перезапускается', err, {
      uptimeS: Math.round(process.uptime()),
    });
  } catch { /* alerting must never be the thing that breaks */ }

  setTimeout(() => process.exit(1), 2000).unref();
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// Upper bound on how long to wait for final saves. Generous compared with the
// writes themselves (each is one small $set) but well inside the grace period
// a host gives between SIGTERM and SIGKILL.
const SHUTDOWN_FLUSH_MS = 8000;

async function _gracefulShutdown(signal) {
  console.log(`${signal}: shutting down...`);
  // Stop all game loops — the static per-floor ones AND the private Fear
  // instances, which are deliberately not in floorRooms (_createFearRoom) and
  // so were left ticking through the whole shutdown, right across the final
  // save flush below.
  floorRooms.forEach(r => r._stopLoop());
  _liveFearRooms().forEach(r => r._stopLoop());
  _liveCoopRooms().forEach(r => r._stopLoop());
  // Land whatever clan XP has accumulated since the last 20s flush, so a
  // redeploy doesn't quietly discard it.
  await _flushClanXp().catch(() => {});
  // Disconnect all sockets. Each socket's own disconnect handler registers its
  // final save in _pendingFlush, keyed by account.
  io.close();
  // Then WAIT FOR THOSE WRITES, rather than for a fixed two seconds and hoping.
  // The sleep was a guess that got worse the more players were online: every
  // one of them lands a flush at the same instant, they queue for the Mongo
  // pool (maxPoolSize), and anything still queued when the timer expired was
  // dropped by process.exit below — the last few seconds of progress, for
  // whoever happened to be at the back of the queue, on every single deploy.
  //
  // Bounded all the same: a shutdown that hangs on one stuck write is worse
  // than one that loses it, and SIGTERM usually comes with a hard kill behind
  // it. The race resolves on whichever comes first, and the timeout path says
  // so instead of exiting silently.
  // io.close() disconnects the sockets, but each socket's disconnect handler is
  // what registers its flush — give the event loop a turn so they have all run
  // before the map is read, or this collects an empty set and waits for
  // nothing at all.
  await new Promise(r => setTimeout(r, 200));
  const _flushes = [..._pendingFlush.values()];
  if (_flushes.length) {
    console.log(`waiting for ${_flushes.length} pending save(s)...`);
    const _done = await Promise.race([
      Promise.allSettled(_flushes).then(() => true),
      new Promise(r => setTimeout(() => r(false), SHUTDOWN_FLUSH_MS)),
    ]);
    console.log(_done ? 'all pending saves landed'
      : `WARNING: ${SHUTDOWN_FLUSH_MS}ms elapsed with saves still in flight — exiting anyway`);
  }
  await mongoose.connection.close();
  console.log('Shutdown complete');
  process.exit(0);
}
process.on('SIGTERM', () => _gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => _gracefulShutdown('SIGINT'));
