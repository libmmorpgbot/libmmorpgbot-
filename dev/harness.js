#!/usr/bin/env node
'use strict';
// Boots the REAL server against the in-memory mongoose double (dev/mongo-memory.js)
// and drives it with real socket.io clients.
//
//   node dev/harness.js            run every scenario
//   node dev/harness.js login      run the ones whose name contains "login"
//
// dev/local.js is the launcher for playing locally; this is the one for
// checking that a change did what it was supposed to. It exists because
// mongodb-memory-server cannot fetch a mongod binary in every environment (a
// locked-down runner, an agent sandbox, no network), and without it the server
// is never once started before a change ships — which is not a defensible way
// to touch an economy.
//
// Nothing is mocked except the database and the clock-free bits of Telegram:
// server/index.js is required unmodified, the socket handlers are the real
// ones, the room simulation really ticks, and the clients speak the real
// protocol over a real websocket.

const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const memory = require('./mongo-memory');

// ── Install the double before anything requires mongoose ─────────────────────
// The models call require('mongoose') at load time, so the interception has to
// be in place before server/index.js is pulled in.
const _load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'mongoose') return memory;
  return _load.call(this, request, parent, isMain);
};

const PORT = Number(process.env.HARNESS_PORT || 3111);

// Mirrors /dev/init-data's own username -> telegramId derivation (server/
// index.js) so TG_ADMIN_ID below can be set to the id a scenario will
// actually get back from connectAs('harness-admin') — there is no other way
// to know that id ahead of a real login.
const crypto = require('crypto');
function _devTelegramId(username) {
  return '9' + parseInt(crypto.createHash('sha1').update(username).digest('hex').slice(0, 10), 16)
    .toString().slice(0, 9);
}
const HARNESS_ADMIN_NAME = 'harness-admin';

Object.assign(process.env, {
  MONGODB_URI: 'mongodb://127.0.0.1:27017/harness',
  PORT: String(PORT),
  DEV_LOCAL: '1',
  // Never a real token — it only signs the initData that /dev/init-data hands
  // out, and is verified by the same secret on the way back in.
  TG_BOT_TOKEN: 'harness-token',
  TG_BOT_USERNAME: 'harness_bot',
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD: 'admin',
  // The one account maintenance mode (server/index.js) must never lock out.
  TG_ADMIN_ID: _devTelegramId(HARNESS_ADMIN_NAME),
  GAME_URL: `http://127.0.0.1:${PORT}`,
  // Keep the movement guard measuring but never acting, so a scenario that
  // teleports a client on purpose isn't fighting it.
  MOVE_GUARD: process.env.MOVE_GUARD || 'log',
});

const BASE = `http://127.0.0.1:${PORT}`;
const io = require('socket.io-client');
const { decodeGameState } = require('../shared/netcodec');

// ── Watch for handlers that threw ────────────────────────────────────────────
// safeOn (server/index.js) catches anything a socket handler throws so one bad
// packet can't take the process down. The cost is that a broken handler is
// SILENT to the client: no success, no error, just a reply that never comes —
// which is what a missing import looked like from the outside, twice.
//
// Here it is not silent. Every '[socket:<event>]' the server logs is collected
// and turned into a failure at the end of the run, so any handler a scenario
// happens to touch is also checked for throwing.
const handlerErrors = [];
const _realError = console.error;
console.error = (...args) => {
  const first = String(args[0] || '');
  if (first.startsWith('[socket:')) handlerErrors.push(`${first} ${args[1] && args[1].message ? args[1].message : ''}`.trim());
  _realError.apply(console, args);
};

// ── Tiny assertion kit ───────────────────────────────────────────────────────
let passed = 0, failed = 0, skipped = 0;
const results = [];
function ok(cond, msg, detail) {
  if (cond) { passed++; results.push(['PASS', msg, '']); }
  else { failed++; results.push(['FAIL', msg, detail === undefined ? '' : String(detail)]); }
}

// A SCENARIO THAT COULD NOT RUN IS NOT A SCENARIO THAT PASSED.
//
// The nine browser scenarios below each opened with two lines of
// `ok(true, 'skipped — no chromium in this environment')` and
// `ok(true, 'skipped — playwright not installed')`. On a machine without the
// browser they contributed eighteen green PASSes to the total and told the
// reader the client had been loaded, driven and rendered — over nothing at
// all. Worse than no coverage, because the number at the bottom said there
// was some. This records the skip and leaves both counters alone; the runner
// prints it as SKIP and marks a scenario that did nothing else with a dash.
function skip(msg) { skipped++; results.push(['SKIP', msg, '']); }
const eq = (got, want, msg) => ok(got === want, msg, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Waits for one event, or rejects with something readable rather than a bare
// timeout — a scenario that hangs should say which message never arrived.
// `match` picks a specific payload out of an event name that also carries
// unrelated traffic — the same problem waitForEnemyResync solves for
// 'gameState' below, and for the same reason: several server call sites emit
// one event name with deliberately different payload shapes (a broadcast that
// carries only what changed, a reply that carries everything). Without it the
// first arrival wins, so a broadcast that happens to land between the request
// and its reply is what gets asserted on. Non-matching payloads are ignored
// and the wait continues until the timeout.
function waitFor(sock, event, { timeout = 8000, where = '', match = null } = {}) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      sock.off(event, on);
      reject(new Error(`timed out after ${timeout}ms waiting for '${event}'${where ? ' (' + where + ')' : ''}`));
    }, timeout);
    const on = payload => {
      if (match && !match(payload)) return;
      clearTimeout(t); sock.off(event, on); resolve(payload);
    };
    sock.on(event, on);
  });
}

// Waits for a binary 'gameState' push whose decoded enemies include FULL
// records (id + eid, not just a position delta) for every id in `ids` —
// used to pick the actual enemyResync response out of the room's own
// ordinary periodic 'gameState' broadcasts, which fire on the same event
// name but only ever carry nearby CHANGED enemies as deltas, not an
// arbitrary requested set. c is a connectAs() client (its own .sock is
// needed here — decoding is per-packet, not something the seen/counts maps
// already track).
function waitForEnemyResync(c, ids, { timeout = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { c.sock.off('gameState', onMsg); reject(new Error(`timed out after ${timeout}ms waiting for an enemyResync covering ${ids.join(',')}`)); }, timeout);
    function onMsg(raw) {
      let decoded;
      try { decoded = decodeGameState(raw); } catch (_) { return; }
      const byId = new Map(decoded.enemies.filter(e => e.eid).map(e => [e.id, e]));
      if (ids.every(id => byId.has(id))) {
        clearTimeout(t);
        c.sock.off('gameState', onMsg);
        resolve(byId);
      }
    }
    c.sock.on('gameState', onMsg);
  });
}

// ── A logged-in client ───────────────────────────────────────────────────────
// Goes through the same path a browser does: ask the dev route for signed
// initData, then loginTelegramWebApp with it.
async function connectAs(name) {
  const res = await fetch(`${BASE}/dev/init-data?dev=${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`/dev/init-data ${res.status} for ${name}`);
  const { initData, user } = await res.json();

  const sock = io(BASE, { transports: ['websocket'], upgrade: false, forceNew: true });
  const seen = new Map();          // event -> last payload, for assertions after the fact
  const counts = new Map();
  sock.onAny((ev, payload) => {
    seen.set(ev, payload);
    counts.set(ev, (counts.get(ev) || 0) + 1);
  });

  await waitFor(sock, 'connect', { where: `connect ${name}` });
  const authOk = waitFor(sock, 'authOk', { where: `authOk ${name}` });
  sock.emit('loginTelegramWebApp', { initData });
  const auth = await authOk;

  return {
    name, sock, user, auth, seen, counts,
    last: ev => seen.get(ev),
    count: ev => counts.get(ev) || 0,
    wait: (ev, opts) => waitFor(sock, ev, { where: name, ...opts }),
    emit: (ev, payload) => sock.emit(ev, payload),
    close: () => new Promise(r => { sock.close(); setTimeout(r, 50); }),
  };
}

// Joins the world and waits for the server to actually place the character.
async function enterWorld(c, type, savedStats) {
  const start = c.wait('gameStart', { where: `${c.name} gameStart` });
  c.emit('selectChar', { type, savedStats: savedStats || null });
  return start;
}

// ── Scenarios ────────────────────────────────────────────────────────────────
const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });

scenario('login: a fresh account authenticates and is told it is new', async () => {
  const c = await connectAs('harness_new');
  ok(c.auth && typeof c.auth.username === 'string', 'authOk carries a username');
  eq(c.auth.isNewAccount, true, 'a first login reports isNewAccount');
  eq(typeof c.auth.gramBalance, 'number', 'authOk carries a GRAM balance');
  await c.close();
});

scenario('login: the second login of the same account is not new', async () => {
  const c1 = await connectAs('harness_repeat');
  await c1.close();
  await sleep(120);
  const c2 = await connectAs('harness_repeat');
  eq(c2.auth.isNewAccount, false, 'a returning account is not reported as new');
  await c2.close();
});

scenario('world: selectChar places the character and sends the map', async () => {
  const c = await connectAs('harness_world');
  const start = await enterWorld(c, 'mage');
  // The map itself is fetched over HTTP and cached by the browser — only its
  // version travels on gameStart. See the emit in server/index.js.
  ok(start && typeof start.mapVersion === 'string', 'gameStart carries the map version');
  ok(start.spawn && Number.isFinite(start.spawn.x), 'gameStart carries a server-side spawn');
  ok(Array.isArray(start.enemies), 'gameStart carries an enemy snapshot');
  await c.close();
});

scenario('world: the room ticks, and goes quiet when nothing is happening', async () => {
  const c = await connectAs('harness_tick');
  await enterWorld(c, 'ranger');
  await c.wait('gameState', { timeout: 4000 });
  // Deliberately NOT "arrives repeatedly": a player alone with nothing in
  // range gets one packet and then silence until something changes (see the
  // idle-cast skip in Room.js). Asserting a steady stream here would be
  // asserting that the interest management is broken.
  const idle = c.count('gameState');
  await sleep(600);
  ok(c.count('gameState') - idle <= 2, `an idle client is not spammed (${c.count('gameState') - idle} in 600ms)`);
  // Moving is a change, so the stream resumes.
  for (let i = 0; i < 12; i++) { c.emit('playerMove', { x: 1380 + i * 6, y: 1380, facing: 1, moving: true }); await sleep(45); }
  await sleep(400);
  ok(c.count('gameState') > idle, 'state resumes once the player moves');
  await c.close();
});

scenario('save: the fields a save still owns round-trip', async () => {
  const c = await connectAs('harness_save');
  await enterWorld(c, 'lev');
  // No gold, no items, no levels: those are the server's now. What is left in
  // the blob is preferences and counters nothing is entitled to.
  c.emit('saveProgress', { stats: {
    type: 'lev', lvl: 1, xp: 0, kills: 7, hp: 100, maxHp: 100,
    hudPotion: 'pt1', lang: 'en', autoHpPct: 0.4,
    savedAt: Date.now(),
  } });
  await sleep(3400);   // the server debounces its write by 3s
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  ok(row, 'the player row exists');
  const sd = (row && row.savedData) || {};
  eq(sd.kills, 7, 'kills reached the database');
  eq(sd.lang, 'en', 'settings reached the database');
  eq(sd.autoHpPct, 0.4, 'preferences reached the database');
  await c.close();
});

scenario('gold: a save cannot set the balance', async () => {
  const c = await connectWithSaved('harness_goldpin', { gold: 500 });
  await enterWorld(c, 'mage');
  c.emit('saveProgress', { stats: {
    type: 'mage', lvl: 1, xp: 0, gold: 999999, kills: 0, hp: 10, maxHp: 10,
    savedAt: Date.now(),
  } });
  await sleep(3400);
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  eq(row.savedData.gold, 500, 'the stored balance is the one the server held');
  await c.close();
});

scenario('gold: the merchant charges server-side', async () => {
  const c = await connectWithSaved('harness_merchant', { gold: 100 });
  await enterWorld(c, 'ranger');
  // Both replies land in the same tick, so both listeners go on before the
  // request — subscribing to the second one after awaiting the first misses it.
  const sync = c.wait('goldSync', { timeout: 6000 });
  const bagP = c.wait('potionBag', { timeout: 6000 }).catch(() => null);
  c.emit('buyPotion', { idx: 0, qty: 3 });        // pt1, 5 gold each
  const got = await sync;
  eq(got.gold, 85, 'the price came off the balance');
  const bag = await bagP;
  ok(bag && bag.potionBag && bag.potionBag.pt1 === 3, 'and the potions arrived');
  await sleep(150);
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  eq(row.savedData.gold, 85, 'persisted immediately, not on the save debounce');
  await c.close();
});

scenario('gold: a purchase beyond the balance is refused', async () => {
  const c = await connectWithSaved('harness_broke', { gold: 4 });
  await enterWorld(c, 'mage');
  const err = c.wait('goldError', { timeout: 5000 }).catch(() => null);
  c.emit('buyPotion', { idx: 0, qty: 1 });
  ok(await err, 'refused with a message');
  await sleep(150);
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  eq(row.savedData.gold, 4, 'and nothing was charged');
  await c.close();
});

scenario('gold: founding a clan charges the fee', async () => {
  const c = await connectWithSaved('harness_clan', { gold: 1000 });
  await enterWorld(c, 'warlock');
  const sync = c.wait('goldSync', { timeout: 6000 }).catch(() => null);
  c.emit('clanCreate', { name: 'Test', icon: 1 });
  const got = await sync;
  ok(got && got.gold === 900, `the founding fee was taken (gold=${got && got.gold})`);
  await c.close();
});

scenario('gold: founding is refused when short, and no clan is made', async () => {
  const c = await connectWithSaved('harness_clanbroke', { gold: 10 });
  await enterWorld(c, 'warlock');
  const err = c.wait('clanError', { timeout: 5000 }).catch(() => null);
  c.emit('clanCreate', { name: 'Broke', icon: 1 });
  ok(await err, 'refused with a message');
  eq(memory.__dump('Clan').filter(x => x.name === 'Broke').length, 0, 'and no clan exists');
  await c.close();
});

scenario('level: a save cannot set the level', async () => {
  const c = await connectWithSaved('harness_lvlpin', { lvl: 5, xp: 12 });
  await enterWorld(c, 'mage');
  c.emit('saveProgress', { stats: {
    type: 'mage', lvl: 900, xp: 999999, xpNext: 1, baseAtk: 9999, baseDef: 9999, baseMaxHp: 99999,
    gold: 0, kills: 0, hp: 10, maxHp: 10, savedAt: Date.now(),
  } });
  await sleep(3400);
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  const sd = row.savedData || {};
  eq(sd.lvl, 5, 'the stored level is the one the server held');
  eq(sd.xp, 12, 'and so is the xp');
  ok(sd.baseAtk < 9999, `the level-derived stats came with it (baseAtk=${sd.baseAtk})`);
  await c.close();
});

scenario('combat: a hit reaches the server and lowers the real enemy', async () => {
  const c = await connectAs('harness_combat');
  await enterWorld(c, 'deathknight');
  // The hub floor itself has no regular monsters any more — each leveling
  // arm is now its own floor (server/game/floors.js), reached with a real
  // enterLocation transition instead of a same-grid walk.
  const armStart = c.wait('gameStart', { where: `${c.name} enterLocation left` });
  c.emit('enterLocation', { target: 'left' });
  const start = await armStart;
  const target = (start.enemies || []).filter(e => e && (e.hp || 0) > 0).sort((x, y) => x.hp - y.hp)[0];
  ok(target, 'the room has a live enemy');
  if (!target) return c.close();
  // Killing one is not a test: the weakest enemy reachable from spawn has
  // 24,000 HP against a level-1 character. What matters here is that the hit
  // is resolved server-side at all — the damage number, the range check and
  // the enemy's HP all live there.
  c.emit('playerMove', { x: target.x + 20, y: target.y, facing: 1, moving: false });
  await sleep(120);
  const hurt = c.wait('enemyHurt', { timeout: 6000 }).catch(() => null);
  c.emit('attack', { enemyId: target.id });
  const got = await hurt;
  ok(got && got.id === target.id, 'the server resolved the hit');
  ok(got && got.dmg > 0, `and reported the damage it dealt (${got && got.dmg})`);
  ok(got && got.hp < target.hp, 'and the enemy lost health on its side');
  await c.close();
});

scenario('floors: entering an arm is a real floor change, gated server-side, with a working way back', async () => {
  const c = await connectAs('harness_floors');
  const start = await enterWorld(c, 'ranger');
  eq(start.floor, 1, 'a fresh character lands on the hub floor');

  // 'top' requires level 20 (ARM_LEVEL_REQ) — a level-1 character asking for
  // it must be refused server-side, not just hidden behind the pad's own
  // client-side lock icon.
  const denied = c.wait('enterLocationDenied', { timeout: 3000 });
  c.emit('enterLocation', { target: 'top' });
  const denial = await denied;
  eq(denial && denial.reason, 'level', 'a level-gated arm refuses a character who has not reached it');

  // 'left' has no level requirement — the same request should actually move
  // the character onto that arm's own floor, with its own grid/enemies.
  const leftStart = c.wait('gameStart', { where: `${c.name} enters left` });
  c.emit('enterLocation', { target: 'left' });
  const onLeft = await leftStart;
  eq(onLeft.floor, 2, 'entering the left arm switches to its own floor');
  ok((onLeft.enemies || []).length > 0, 'and that floor reports its own regular enemies');

  // The arm's own return pad sends the character back to the hub floor —
  // same round trip a player makes by walking onto it.
  const hubStart = c.wait('gameStart', { where: `${c.name} returns to hub` });
  c.emit('enterLocation', { target: 'hub' });
  const backAtHub = await hubStart;
  eq(backAtHub.floor, 1, 'requesting hub from an arm returns to the hub floor');

  await c.close();
});

scenario('floors: Guild War is its own floor, window-gated, and force-evicted when it closes', async () => {
  const c = await connectAs('harness_gw');
  await enterWorld(c, 'ranger');

  // The window starts closed — a client that goes straight for it (no pad
  // walk to gate it client-side first) must still be refused server-side.
  const deniedClosed = c.wait('enterLocationDenied', { timeout: 3000 });
  c.emit('enterLocation', { target: 'guildWar' });
  const denial = await deniedClosed;
  eq(denial && denial.reason, 'closed', 'entry is refused while the window is closed');

  // Same force-open the in-game admin panel uses.
  const loginRes = await fetch(`${BASE}/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  const { token } = await loginRes.json();
  const openRes = await fetch(`${BASE}/admin/guildwar/open`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  });
  eq(openRes.status, 200, 'admin can force-open the Guild War window');

  const gwStart = c.wait('gameStart', { where: `${c.name} enters guildWar` });
  c.emit('enterLocation', { target: 'guildWar' });
  const onGw = await gwStart;
  eq(onGw.floor, 6, 'entering guildWar switches to its own floor');
  ok((onGw.enemies || []).some(e => e.eid === 'guildwar_castle'), 'and that floor has its own tower, in view from the spawn ring');

  // Closing the window has to force everyone still inside back out — no pad
  // walk triggers it, so this only works if it can reach the connection from
  // outside (socket.data._forceEnterLocation, server/index.js).
  const hubStart = c.wait('gameStart', { where: `${c.name} force-evicted to hub` });
  const closeRes = await fetch(`${BASE}/admin/guildwar/close`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  });
  eq(closeRes.status, 200, 'admin can force-close the Guild War window');
  const backAtHub = await hubStart;
  eq(backAtHub.floor, 1, 'closing the window sends a still-present player back to the hub floor');

  await c.close();
});

scenario('admin: maintenance mode kicks everyone but TG_ADMIN_ID, and blocks new non-admin logins', async () => {
  const before = await connectAs('harness_maint_before');
  await enterWorld(before, 'ranger');

  const loginRes = await fetch(`${BASE}/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  const { token } = await loginRes.json();

  // A player already in the game when maintenance switches on has to be
  // force-disconnected, not just refused on their next login.
  const kicked = before.wait('kicked', { timeout: 3000 });
  const onRes = await fetch(`${BASE}/admin/maintenance/on`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  });
  eq(onRes.status, 200, 'admin can switch maintenance on');
  const kickMsg = await kicked;
  ok(kickMsg && /технически/i.test(kickMsg.reason || ''), 'a player already online is kicked with a maintenance reason');

  // A normal account cannot log in at all while it's on — same authError
  // path a banned account gets, so no client change was needed for this.
  const { initData: blockedInitData } = await (await fetch(`${BASE}/dev/init-data?dev=harness_maint_blocked`)).json();
  const blockedSock = io(BASE, { transports: ['websocket'], upgrade: false, forceNew: true });
  await waitFor(blockedSock, 'connect', { where: 'maint-blocked connect' });
  const authErrP = waitFor(blockedSock, 'authError', { where: 'maint-blocked authError' });
  blockedSock.emit('loginTelegramWebApp', { initData: blockedInitData });
  const authErr = await authErrP;
  ok(authErr && /технически/i.test(authErr.message || ''), 'a non-admin login is refused with a maintenance message while it is on');
  blockedSock.close();

  // TG_ADMIN_ID itself (see the harness's own env setup) is exempt from both.
  const admin = await connectAs(HARNESS_ADMIN_NAME);
  ok(admin.auth && typeof admin.auth.username === 'string', 'the TG_ADMIN_ID account can still log in while maintenance is on');
  await admin.close();

  const offRes = await fetch(`${BASE}/admin/maintenance/off`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  });
  eq(offRes.status, 200, 'admin can switch maintenance off again');

  const after = await connectAs('harness_maint_after');
  ok(after.auth && typeof after.auth.username === 'string', 'a normal account can log in again once maintenance is off');
  await after.close();

  await before.close();
});

scenario('admin: give-all grants gold+SP to an online account live and an offline account in the DB', async () => {
  const online = await connectWithSaved('harness_giveall_online', { gold: 100, bonusSP: 2 });
  await enterWorld(online, 'ranger');

  // An account that exists but isn't connected right now — the DB-only path.
  const offlineSeed = await connectAs('harness_giveall_offline');
  await offlineSeed.close();
  await sleep(200);

  const loginRes = await fetch(`${BASE}/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  const { token } = await loginRes.json();

  const gave = online.wait('adminGive', { where: 'give-all lands on the online account' });
  const giveRes = await fetch(`${BASE}/admin/give-all`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ gold: 500, sp: 3 }),
  });
  const giveBody = await giveRes.json();
  eq(giveRes.status, 200, 'admin can grant gold+SP to everyone at once');
  ok(giveBody.online >= 1, 'reports at least the one online account it touched');
  ok(giveBody.offline >= 1, 'reports at least the one offline account it touched');

  const onlinePayload = await gave;
  eq(onlinePayload.newGold, 600, 'the online account\'s live session got the new gold total pushed to it');
  eq(onlinePayload.newBonusSP, 5, 'and the new bonusSP total');

  await sleep(150); // _persistSavedFields's DB write
  const onlineRow = memory.__dump('Player').find(p => p.username === online.auth.username);
  eq(onlineRow.savedData.gold, 600, 'the online account\'s DB row matches, not just its live session');
  eq(onlineRow.savedData.bonusSP, 5, 'same for bonusSP');

  const offlineRow = memory.__dump('Player').find(p => p.username === offlineSeed.auth.username);
  eq(offlineRow.savedData.gold, 500, 'the offline account got the gold via a straight DB increment');
  eq(offlineRow.savedData.bonusSP, 3, 'and the SP');

  await online.close();
});

scenario('floors: Фарм-зона is its own floor, gated server-side by level', async () => {
  const low = await connectAs('harness_farm_low');
  await enterWorld(low, 'ranger'); // fresh character, well under FARM_ENTRY_LEVEL (20)

  const denied = low.wait('enterLocationDenied', { timeout: 3000 });
  low.emit('enterLocation', { target: 'farmZone' });
  const denial = await denied;
  eq(denial && denial.reason, 'level', 'a character below FARM_ENTRY_LEVEL is refused, not just hidden behind the pad\'s lock icon');
  await low.close();

  const high = await connectWithSaved('harness_farm_high', { lvl: 20, xp: 0, xpNext: 100 });
  await enterWorld(high, 'ranger');
  const farmStart = high.wait('gameStart', { where: `${high.name} enters farmZone` });
  high.emit('enterLocation', { target: 'farmZone' });
  const onFarm = await farmStart;
  eq(onFarm.floor, 7, 'a character at the level requirement switches to the Фарм-зона floor');
  eq((onFarm.enemies || []).length, 80, 'and that floor reports its own baked-in monsters');

  const hubStart = high.wait('gameStart', { where: `${high.name} returns to hub` });
  high.emit('enterLocation', { target: 'hub' });
  const backAtHub = await hubStart;
  eq(backAtHub.floor, 1, 'the zone\'s own return pad sends the character back to the hub floor');

  await high.close();
});

scenario('floors: Элитная фарм-зона is a private party-of-3 instance, leader-only, cascade-ejecting on a member leaving', async () => {
  // Direct entry is always refused, even above the level gate — the only
  // sanctioned way in is farm2GroupStart (see _doEnterLocation's own
  // comment on why: the floor's monsters are baked in at world-gen, so a
  // bare enterLocation would otherwise find a fully populated, ungated zone).
  const solo = await connectWithSaved('harness_farm2_solo', { lvl: 30, xp: 0, xpNext: 100 });
  await enterWorld(solo, 'ranger');
  const deniedDirect = solo.wait('enterLocationDenied', { timeout: 3000 });
  solo.emit('enterLocation', { target: 'farmZone2' });
  const directDenial = await deniedDirect;
  eq(directDenial && directDenial.reason, 'partyOnly', 'a direct enterLocation is refused regardless of level');
  await solo.close();

  // A leader below FARM2_ENTRY_LEVEL (25) cannot even open a lobby.
  const lowLeader = await connectWithSaved('harness_farm2_low', { lvl: 10, xp: 0, xpNext: 100 });
  await enterWorld(lowLeader, 'ranger');
  const lowErr = lowLeader.wait('farm2Error', { timeout: 3000 });
  lowLeader.emit('farm2GroupCreate');
  const lowErrPayload = await lowErr;
  ok(lowErrPayload && /25/.test(lowErrPayload.msg || ''), 'the level gate names the required level');
  await lowLeader.close();

  // A full party of 3, all at the level requirement.
  const leader = await connectWithSaved('harness_farm2_leader', { lvl: 30, xp: 0, xpNext: 100 });
  const m1 = await connectWithSaved('harness_farm2_m1', { lvl: 30, xp: 0, xpNext: 100 });
  const m2 = await connectWithSaved('harness_farm2_m2', { lvl: 30, xp: 0, xpNext: 100 });
  await enterWorld(leader, 'ranger'); await enterWorld(m1, 'ranger'); await enterWorld(m2, 'ranger');

  const leaderState = leader.wait('farm2GroupState', { timeout: 3000 });
  leader.emit('farm2GroupCreate');
  const ls1 = await leaderState;
  eq(ls1.isLeader, true, 'the creator is the leader of their own lobby');

  const m1State = m1.wait('farm2GroupState', { timeout: 3000 });
  const leaderState2 = leader.wait('farm2GroupState', { timeout: 3000 });
  m1.emit('farm2GroupJoin', { leaderId: leader.sock.id });
  const [m1s, ls2] = await Promise.all([m1State, leaderState2]);
  eq(m1s.inGroup, true, 'm1 lands in the leader\'s group');
  eq(ls2.members.length, 1, 'the leader sees m1 join');

  const m2State = m2.wait('farm2GroupState', { timeout: 3000 });
  const leaderState3 = leader.wait('farm2GroupState', { timeout: 3000 });
  m2.emit('farm2GroupJoin', { leaderId: leader.sock.id });
  const [m2s, ls3] = await Promise.all([m2State, leaderState3]);
  eq(m2s.inGroup, true, 'm2 lands in the leader\'s group too');
  eq(ls3.members.length, 2, 'the leader sees the group fill up to FARM2_PARTY_SIZE');

  // Only the leader can start, and it force-moves every member in together.
  const startDenied = m1.wait('farm2Error', { timeout: 1500 }).then(() => 'error').catch(() => 'nothing');
  m1.emit('farm2GroupStart');
  eq(await startDenied, 'nothing', 'a non-leader\'s farm2GroupStart is silently ignored');

  const leaderStart = leader.wait('farm2Started', { timeout: 5000 });
  const m1Start = m1.wait('gameStart', { where: 'm1 deployed into farmZone2' });
  const m2Start = m2.wait('gameStart', { where: 'm2 deployed into farmZone2' });
  leader.emit('farm2GroupStart');
  const [lStarted, m1Gs, m2Gs] = await Promise.all([leaderStart, m1Start, m2Start]);
  ok(lStarted, 'the leader gets a farm2Started payload');
  eq(m1Gs.floor, 13, 'm1 is force-moved onto the Элитная фарм-зона floor');
  eq(m2Gs.floor, 13, 'so is m2');
  // gameStart only reports enemies within ENEMY_AOI_R (1400px) of the spawn
  // point — the entrance corridor sits roughly equidistant from both forked
  // rooms, so most (not necessarily all — a few of the deepest corners can
  // fall just outside the radius) of the zone's 100 baked-in monsters are
  // already visible from there.
  ok((m1Gs.enemies || []).length > 50, 'most of the zone\'s baked-in monsters are visible from the entrance');
  // The entrance corridor and its fork are never populated — every monster
  // sits inside its own room, at least a few tiles past the fork/branch.
  const spawnTileX = Math.round(m1Gs.spawn.x / 40), spawnTileY = Math.round(m1Gs.spawn.y / 40);
  const closestTiles = Math.min(...(m1Gs.enemies || []).map(e =>
    Math.hypot(Math.round(e.x / 40) - spawnTileX, Math.round(e.y / 40) - spawnTileY)));
  ok(closestTiles > 8, `the entrance corridor is clear of monsters (closest is ${closestTiles.toFixed(1)} tiles away)`);

  // Monsters stand in packs of FARM2_PACK_SIZE (4) and never self-pull —
  // find one by clustering (packMateIds itself isn't part of the wire
  // payload), confirm proximity alone doesn't wake it, then hit it and
  // confirm the whole cluster wakes while an unrelated, distant one doesn't.
  {
    const enemies = m1Gs.enemies || [];
    // 3 tiles cleanly separates same-pack members (at most 2.83 tiles apart,
    // the ±1-tile-offset placement in generateFarmZone2) from different
    // packs' (never closer than 4 tiles — see PACK_MIN_SPACING/the grid
    // layout there).
    const withinTiles = (a, b, t) => Math.hypot(a.x - b.x, a.y - b.y) <= t * 40;
    let anchor = null, cluster = null;
    for (const e of enemies) {
      const mates = enemies.filter(o => o.id !== e.id && withinTiles(e, o, 3));
      if (mates.length >= 3) { anchor = e; cluster = mates; break; }
    }
    ok(anchor, 'found a pack of at least 4 (anchor + 3 clustered neighbours) among the visible monsters');
    const control = enemies.find(e => e !== anchor && !cluster.includes(e) && !withinTiles(e, anchor, 15));
    ok(control, 'found an unrelated, distant monster to use as a control');

    if (anchor && control) {
      m1.emit('playerMove', { x: anchor.x + 20, y: anchor.y, facing: 1, moving: false });
      await sleep(120);
      const hurt = m1.wait('enemyHurt', { timeout: 6000 }).catch(() => null);
      m1.emit('attack', { enemyId: anchor.id });
      const got = await hurt;
      ok(got && got.id === anchor.id, 'the hit on the pack anchor landed');

      await sleep(200); // let the tick loop actually flip aggro server-side
      const resyncIds = [anchor.id, ...cluster.map(e => e.id), control.id];
      const resync = waitForEnemyResync(m1, resyncIds);
      m1.emit('enemyResync', { ids: resyncIds });
      const byId = await resync;
      ok(byId.get(anchor.id)?.aggro, 'the anchor itself is aggro after being hit');
      ok(cluster.every(e => byId.get(e.id)?.aggro), 'every clustered pack mate woke up too, though none of them were hit');
      ok(!byId.get(control.id)?.aggro, 'the unrelated, distant monster stayed asleep');
    }
  }

  // One member walking out (any way other than the run's own end) ends the
  // run for the other two as well — the zone was only ever entered as a
  // full trio.
  const m1Finished = m1.wait('farm2Finished', { timeout: 5000 });
  const m2Finished = m2.wait('farm2Finished', { timeout: 5000 });
  leader.emit('enterLocation', { target: 'hub' });
  const [m1f, m2f] = await Promise.all([m1Finished, m2Finished]);
  eq(m1f.reason, 'partyBroken', 'm1 is told the run ended because the party broke');
  eq(m2f.reason, 'partyBroken', 'so is m2');

  await Promise.all([leader, m1, m2].map(x => x.close()));
});

scenario('events: a registration from inside an instanced run is refused, not silently dropped at deploy', async () => {
  // Сотрудничество and Элитная фарм-зона each run on a PRIVATE Room per party
  // (_createCoopRoom/_createFarm2Room), which getRoom(floorId) never returns —
  // it only ever hands back the shared, permanently-empty boot-time Room for
  // those floor ids. So _findPlayerAnyFloor, the "still has a character in the
  // world" filter every scheduled deploy runs, sees nobody at all for a player
  // inside one, and quietly dropped them from the queue at deploy time:
  // registered, waited out the countdown, and never got thrown in, with no
  // error ever shown. coopGroupCreate/farm2GroupCreate have always checked the
  // opposite direction; these three handlers are the half that was missing.
  const leader = await connectWithSaved('harness_evtlock_leader', { lvl: 30, xp: 0, xpNext: 100 });
  const m1 = await connectWithSaved('harness_evtlock_m1', { lvl: 30, xp: 0, xpNext: 100 });
  const m2 = await connectWithSaved('harness_evtlock_m2', { lvl: 30, xp: 0, xpNext: 100 });
  await enterWorld(leader, 'ranger'); await enterWorld(m1, 'ranger'); await enterWorld(m2, 'ranger');

  leader.emit('farm2GroupCreate');
  await leader.wait('farm2GroupState', { timeout: 3000 });
  m1.emit('farm2GroupJoin', { leaderId: leader.sock.id });
  await m1.wait('farm2GroupState', { timeout: 3000 });
  m2.emit('farm2GroupJoin', { leaderId: leader.sock.id });
  await m2.wait('farm2GroupState', { timeout: 3000 });

  const started = leader.wait('farm2Started', { timeout: 5000 });
  const m1In = m1.wait('gameStart', { where: 'm1 deployed into farmZone2' });
  leader.emit('farm2GroupStart');
  await started;
  eq((await m1In).floor, 13, 'the trio is inside a live Элитная фарм-зона run');

  // All three scheduled events, from inside that run. Each has to answer with
  // its own error rather than a successful registration.
  await fetch(`${BASE}/dev/deathbattle/open?reg=4000`, { method: 'POST' });
  await fetch(`${BASE}/dev/arena3/open`, { method: 'POST' });
  await fetch(`${BASE}/dev/race10/open?reg=4000`, { method: 'POST' });

  const dbErr = m1.wait('deathBattleError', { timeout: 3000 });
  m1.emit('deathBattleRegister');
  ok(/фарм-зоне/i.test((await dbErr).msg || ''), 'death battle refuses a registration from inside the zone');

  const a3Err = m1.wait('arena3Error', { timeout: 3000 });
  m1.emit('arena3Register');
  ok(/фарм-зоне/i.test((await a3Err).msg || ''), 'the 3v3 arena refuses it too');

  const r10Err = m1.wait('race10Error', { timeout: 3000 });
  m1.emit('race10Register');
  ok(/фарм-зоне/i.test((await r10Err).msg || ''), 'and so does Кровавая Башня');

  // Ends the run for all three (partyBroken), same exit the zone's own
  // scenario uses — nothing is left holding a private Room or its timers.
  const m1Fin = m1.wait('farm2Finished', { timeout: 5000 });
  leader.emit('enterLocation', { target: 'hub' });
  await m1Fin;

  // The Coop half of the same fix, checked at the LOBBY rather than mid-run:
  // a group that starts while a registration is still pending lands in exactly
  // the same place, which is why the group maps are checked alongside the live
  // ones — the same reason arena3/race10 check each other's QUEUES.
  const coopA = await connectWithSaved('harness_evtlock_coop', { lvl: 30, xp: 0, xpNext: 100 });
  await enterWorld(coopA, 'ranger');
  coopA.emit('coopGroupCreate');
  await coopA.wait('coopGroupState', { timeout: 3000 });
  const coopDbErr = coopA.wait('deathBattleError', { timeout: 3000 });
  coopA.emit('deathBattleRegister');
  ok(/Сотрудничестве/i.test((await coopDbErr).msg || ''), 'an open Сотрудничество lobby blocks death battle registration');
  coopA.emit('coopGroupLeave');

  await Promise.all([leader, m1, m2, coopA].map(x => x.close()));
});

scenario('floors: the boss arena is its own floor, reachable only while a world boss is up', async () => {
  const c = await connectAs('harness_arena_boss');
  await enterWorld(c, 'ranger');

  const deniedClosed = c.wait('enterLocationDenied', { timeout: 3000 });
  c.emit('enterLocation', { target: 'arena' });
  const denial = await deniedClosed;
  eq(denial && denial.reason, 'closed', 'entry is refused while no world boss is up');

  const loginRes = await fetch(`${BASE}/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  const { token } = await loginRes.json();
  const summonRes = await fetch(`${BASE}/admin/event-boss`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  });
  eq(summonRes.status, 200, 'admin can summon the world boss on the spot');

  const arenaStart = c.wait('gameStart', { where: `${c.name} enters the arena` });
  c.emit('enterLocation', { target: 'arena' });
  const onArena = await arenaStart;
  eq(onArena.floor, 8, 'a summoned boss opens the arena as its own floor');
  ok((onArena.enemies || []).some(e => e.eid === 'demon_event_boss'), 'and that floor has the boss itself');

  const hubStart2 = c.wait('gameStart', { where: `${c.name} returns to hub` });
  c.emit('enterLocation', { target: 'hub' });
  const backAtHub2 = await hubStart2;
  eq(backAtHub2.floor, 1, 'the arena\'s own return pad sends the character back to the hub floor');

  await c.close();
});

scenario('floors: Death Battle deploys entrants from wherever they are and returns each one there', async () => {
  const a = await connectAs('harness_db_a');
  const b = await connectAs('harness_db_b');
  const aStart = await enterWorld(a, 'ranger'); // stays on the hub
  await enterWorld(b, 'mage');

  // b heads to the left arm first — registering for the event never required
  // being on any particular floor, so this is the case that actually proves
  // the return trip goes back to where each entrant really was, not always
  // the hub (which is all a single-floor arena could ever have told apart).
  const bOnLeft = b.wait('gameStart', { where: `${b.name} enters left` });
  b.emit('enterLocation', { target: 'left' });
  const bLeftStart = await bOnLeft;
  eq(bLeftStart.floor, 2, 'b moves to the left arm before registering');

  // Registration only accepts entrants while _db.phase === 'reg' — the dev
  // route has to open the window before either of these can register at all.
  const openRes = await fetch(`${BASE}/dev/deathbattle/open?reg=1500`, { method: 'POST' });
  eq(openRes.status, 200, 'the dev route force-opens registration with a short window');

  const aReg = a.wait('deathBattleRegistered', { timeout: 3000 });
  const bReg = b.wait('deathBattleRegistered', { timeout: 3000 });
  a.emit('deathBattleRegister');
  b.emit('deathBattleRegister');
  eq((await aReg)?.registered, true, 'a is registered');
  eq((await bReg)?.registered, true, 'b is registered');

  const aStarted = a.wait('deathBattleStarted', { timeout: 6000 });
  const bStarted = b.wait('deathBattleStarted', { timeout: 6000 });
  await aStarted; await bStarted;
  eq(a.last('gameStart')?.floor, 8, 'a is force-joined onto the arena floor to be deployed');
  eq(b.last('gameStart')?.floor, 8, 'b is force-joined onto the arena floor too, from the left arm');

  // 'respawn' unconditionally counts as an elimination for whoever is still
  // in _db.alive (see _pvpEliminate/_dbEliminate) — a deterministic stand-in
  // for landing a killing PvP blow, without needing real combat, the 500px
  // range check, or the opening freeze timer in a test.
  const aEliminated = a.wait('deathBattleEliminated', { timeout: 3000 });
  a.emit('respawn');
  const aSpot = await aEliminated;
  eq(a.last('gameStart')?.floor, 1, 'the eliminated entrant is returned to the hub floor it actually came from');
  eq(aSpot && aSpot.x, aStart.spawn.x, 'at the exact x it was standing at before deployment');
  eq(aSpot && aSpot.y, aStart.spawn.y, 'at the exact y it was standing at before deployment');

  // Only one entrant is left standing, so _dbEliminate's own alive.size<=1
  // check already finished the round and named b the winner — closing the
  // reward modal is what actually sends the winner home.
  const bReturned = b.wait('deathBattleReturnedPrev', { timeout: 3000 });
  b.emit('deathBattleReturn');
  const bSpot = await bReturned;
  eq(b.last('gameStart')?.floor, 2, 'the winner is returned to the left arm it actually came from, not the hub');
  eq(bSpot && bSpot.x, bLeftStart.spawn.x, 'at the exact x it was standing at before deployment');
  eq(bSpot && bSpot.y, bLeftStart.spawn.y, 'at the exact y it was standing at before deployment');

  await a.close();
  await b.close();
});

scenario('floors: the 3v3 arena deploys a full match and returns an eliminated entrant to the hub', async () => {
  // ARENA3_NEEDED is 6 (two teams of ARENA3_TEAM_SIZE=3) and arena3Register
  // itself tries a deploy the moment the queue reaches it — no separate
  // "start" step to trigger, unlike death battle/race10.
  const openRes = await fetch(`${BASE}/dev/arena3/open`, { method: 'POST' });
  eq(openRes.status, 200, 'the dev route force-opens the 3v3 registration window');

  const players = [];
  for (let i = 0; i < 6; i++) {
    const c = await connectWithSaved(`harness_a3_${i}`, { lvl: 15, xp: 0, xpNext: 100 });
    await enterWorld(c, 'ranger');
    players.push(c);
  }

  const started = players.map(c => c.wait('arena3Started', { timeout: 6000 }));
  players.forEach(c => c.emit('arena3Register'));
  await Promise.all(started);
  players.forEach(c => {
    eq(c.last('gameStart')?.floor, 9, `${c.name} is force-joined onto the pvpArena floor to be deployed`);
  });

  // Same 'respawn' shortcut the death battle test uses — _pvpEliminate tries
  // _a3Eliminate unconditionally for anyone in _a3.alive, no real combat
  // needed to prove the return path works.
  const victim = players[0];
  const eliminated = victim.wait('arena3Eliminated', { timeout: 3000 });
  victim.emit('respawn');
  const spot = await eliminated;
  eq(victim.last('gameStart')?.floor, 1, 'an eliminated entrant is returned to the hub floor');
  ok(spot && spot.x != null && spot.y != null, 'landing at the hub spawn (a real position, not a null placeholder)');

  await Promise.all(players.map(c => c.close()));
});

scenario('floors: Кровавая Башня deploys entrants onto its own floor and an elimination returns them to the hub', async () => {
  const openRes = await fetch(`${BASE}/dev/race10/open?reg=1500`, { method: 'POST' });
  eq(openRes.status, 200, 'the dev route force-opens race10 registration with a short window');

  const a = await connectWithSaved('harness_race10_a', { lvl: 10, xp: 0, xpNext: 100 });
  const b = await connectWithSaved('harness_race10_b', { lvl: 10, xp: 0, xpNext: 100 });
  await enterWorld(a, 'ranger');
  await enterWorld(b, 'mage');

  const aReg = a.wait('race10Registered', { timeout: 3000 });
  const bReg = b.wait('race10Registered', { timeout: 3000 });
  a.emit('race10Register');
  b.emit('race10Register');
  eq((await aReg)?.registered, true, 'a is registered');
  eq((await bReg)?.registered, true, 'b is registered');

  const aStarted = a.wait('race10Started', { timeout: 6000 });
  const bStarted = b.wait('race10Started', { timeout: 6000 });
  await aStarted; await bStarted;
  eq(a.last('gameStart')?.floor, 10, 'a is force-joined onto its own race10 floor to be deployed');
  eq(b.last('gameStart')?.floor, 10, 'b is force-joined onto the same floor, in its own lane');

  // Race10 has no PvP — "eliminated" only ever means a monster kill, reported
  // through the same 'respawn' round trip every death in the game uses. This
  // is exactly the path that used to rely on respawnPlayer's Room-local
  // spawn reset (correct back when race10 shared the hub's own Room, wrong
  // now that it's its own floor with its own default spawn) — _race10Eliminate
  // now does the floor change itself first (see its comment). Eliminating
  // both finishes the race too (no survivors left to hit the boss), so this
  // covers both entrants' return in one pass.
  const aElim = a.wait('race10Eliminated', { timeout: 3000 });
  const bElim = b.wait('race10Eliminated', { timeout: 3000 });
  const aResult = a.wait('race10Result', { timeout: 3000 });
  const bResult = b.wait('race10Result', { timeout: 3000 });
  a.emit('respawn');
  b.emit('respawn');
  await aElim; await bElim;
  eq(a.last('gameStart')?.floor, 1, 'a is returned to the hub floor, not left stranded on race10\'s own');
  eq(b.last('gameStart')?.floor, 1, 'b is returned to the hub floor too');
  const aRes = await aResult, bRes = await bResult;
  eq(aRes?.won, false, 'a\'s result reports a loss (no survivors, nobody won)');
  eq(bRes?.won, false, 'and so does b\'s');

  await a.close();
  await b.close();
});

scenario('floors: Страх deploys into its own floor and a death returns the player to the hub', async () => {
  const c = await connectWithSaved('harness_fear_death', { lvl: 10, xp: 0, xpNext: 100 });
  await enterWorld(c, 'ranger');

  const started = c.wait('fearStarted', { timeout: 3000 });
  c.emit('fearEnter');
  const st = await started;
  eq(c.last('gameStart')?.floor, 11, 'entering Fear force-joins its own floor');
  ok(st && st.x != null && st.y != null, 'and fearDeploy places the player in a lane');

  // Fear has no PvP either — "died mid-run" only ever means a monster kill,
  // reported through the same 'respawn' round trip every death in the game
  // uses. _fearFinish (called via _fearEliminate) has to do its own
  // floor-aware return before the SAME handler's generic respawnPlayer call
  // runs right after it, same class of fix race10Eliminate needed.
  const finished = c.wait('fearFinished', { timeout: 3000 });
  c.emit('respawn');
  const fin = await finished;
  eq(fin?.cleared, false, 'the run ends uncleared (died, not finished the last wave)');
  eq(c.last('gameStart')?.floor, 1, 'and the player is returned to the hub floor, not left on Fear\'s own');

  await c.close();
});

scenario('floors: Страх holds monsters back for FEAR_START_DELAY_MS after entry, then spawns wave 1', async () => {
  // Wave 1 used to spawn (and pre-aggro onto the player) in the same tick as
  // fearDeploy — the exact instant the client was still behind the
  // near-opaque events panel closing itself, or just hadn't finished
  // rendering the new floor. From the player's side that read as "I walked
  // into Страх and the monsters were already on me / invisible", every
  // time. fearEnter now hands out a wave:0 grace record and only calls
  // _fearStartWave 5s later (FEAR_START_DELAY_MS, server/index.js) — this
  // checks both halves: nothing is alive right at entry, and wave 1 really
  // does show up roughly 5s later, not immediately.
  const c = await connectWithSaved('harness_fear_delay', { lvl: 10, xp: 0, xpNext: 100 });
  await enterWorld(c, 'ranger');

  const started = c.wait('fearStarted', { timeout: 3000 });
  const t0 = Date.now();
  c.emit('fearEnter');
  const st = await started;
  ok(st && st.readyAt > t0, 'fearStarted reports when wave 1 will actually spawn');

  const onFear = c.last('gameStart');
  eq(onFear?.floor, 11, 'entering Fear force-joins its own floor');
  eq((onFear?.enemies || []).length, 0, 'and the initial enemy snapshot is empty — nothing has spawned yet');

  // Well inside the grace window — wave 1 must not have fired yet.
  const tooEarly = await c.wait('fearWave', { timeout: 2500 }).catch(() => null);
  eq(tooEarly, null, 'wave 1 does not spawn before the grace window elapses');

  const wave1 = await c.wait('fearWave', { timeout: 4000 });
  const elapsed = Date.now() - t0;
  eq(wave1?.wave, 1, 'wave 1 spawns once the grace window elapses');
  ok(elapsed >= 4500, `and only after roughly FEAR_START_DELAY_MS, not immediately (took ${elapsed}ms)`);

  await c.close();
});

scenario('floors: Страх gives every entrant their own private instance, not shared halls', async () => {
  // The old design stacked a fixed FEAR_LANES rooms into one shared grid —
  // a second entrant landed in lane 1, at a different y-coordinate than
  // lane 0's occupant, and only ever a few lanes were free at once. Every
  // entrant gets a freshly generated, single-lane Room of their own now
  // (_createFearRoom, server/index.js) — two simultaneous entrants are BOTH
  // "lane 0" of their own room, so they land at the exact same (x, y),
  // which could never happen if they were sharing one floor's grid.
  const a = await connectWithSaved('harness_fear_iso_a', { lvl: 10, xp: 0, xpNext: 100 });
  const b = await connectWithSaved('harness_fear_iso_b', { lvl: 10, xp: 0, xpNext: 100 });
  await enterWorld(a, 'ranger');
  await enterWorld(b, 'ranger');

  const aStarted = a.wait('fearStarted', { timeout: 3000 });
  a.emit('fearEnter');
  const aSt = await aStarted;

  const bStarted = b.wait('fearStarted', { timeout: 3000 });
  b.emit('fearEnter');
  const bSt = await bStarted;

  ok(aSt && bSt, 'both entrants were accepted');
  eq(bSt.x, aSt.x, 'two simultaneous entrants land at the same x — each is lane 0 of their OWN room');
  eq(bSt.y, aSt.y, 'and the same y, for the same reason');

  // And they really are isolated, not just coincidentally overlapping:
  // ending a's run must not touch b's.
  const aFin = a.wait('fearFinished', { timeout: 3000 });
  a.emit('respawn');
  const aRes = await aFin;
  eq(aRes?.cleared, false, "a's run ends (died)");

  const bSync = b.wait('fearState', { timeout: 3000 });
  b.emit('fearSync');
  const bSt2 = await bSync;
  eq(bSt2?.inRun, true, "b's own run is completely unaffected by a finishing theirs");

  await a.close();
  await b.close();
});

scenario('floors: Страх never refuses an entrant for lack of space', async () => {
  // The old shared-hall design capped concurrent runs at FEAR_LANES (was 8)
  // and refused anyone past it with "Все N залов заняты". There is no
  // shared pool to exhaust any more — every entrant gets their own Room
  // (_createFearRoom) — so more simultaneous entrants than the old cap must
  // all still be accepted.
  const N = 10;
  const clients = await Promise.all(
    Array.from({ length: N }, (_, i) => connectWithSaved(`harness_fear_volume_${i}`, { lvl: 10, xp: 0, xpNext: 100 })),
  );
  await Promise.all(clients.map(c => enterWorld(c, 'ranger')));

  const waits = clients.map(c => ({
    started: c.wait('fearStarted', { timeout: 6000 }).catch(() => null),
    err: c.wait('fearError', { timeout: 6000 }).catch(() => null),
  }));
  clients.forEach(c => c.emit('fearEnter'));
  const results = await Promise.all(waits.map(w => Promise.race([w.started, w.err])));
  results.forEach((r, i) => ok(r && r.x != null, `entrant ${i + 1}/${N} was accepted, not refused for space${r && r.msg ? ' (' + r.msg + ')' : ''}`));

  await Promise.all(clients.map(c => c.close()));
});

scenario('health: a live Fear run is visible to /health, not hidden with its private Room', async () => {
  // Fear instances are deliberately kept OUT of floorRooms (_createFearRoom),
  // and /health only ever walked floorRooms — so with N players mid-run in
  // Страх, each on their own 40Hz loop, this endpoint reported no rooms with
  // players at all. Whoever is on call cannot see the load they are being
  // asked about.
  const c = await connectWithSaved('harness_fear_health', { lvl: 10, xp: 0, xpNext: 100 });
  await enterWorld(c, 'ranger');
  const started = c.wait('fearStarted', { timeout: 3000 });
  c.emit('fearEnter');
  await started;

  const { token } = await fetch(`${BASE}/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  }).then(r => r.json());
  const _fearRow = async () => {
    const h = await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
    return (h.rooms || []).find(r => r.floor === 11);
  };
  const live = await _fearRow();
  ok(live, '/health reports the Fear floor while a run is live');
  eq(live && live.players, 1, 'and counts the player standing in it');
  ok(live && live.instances >= 1, 'and says how many private instances are running');

  // The index behind that count is a plain Set, so it has to be swept or it
  // becomes the very leak the private-Room design set out to avoid: one
  // retained Room, grid and all, for every Fear run ever started. Ending the
  // run must drop it.
  const finished = c.wait('fearFinished', { timeout: 3000 });
  c.emit('respawn');
  await finished;
  const idle = await _fearRow();
  eq(idle && idle.instances, 0, 'and the instance is released once the run ends, not retained forever');

  await c.close();
});

scenario('health: a DB outage is reported without failing the liveness check', async () => {
  // /health used to answer 503 whenever mongoose left readyState 1. Behind a
  // platform health check that restarts the container on a failing probe, a
  // few seconds of DB trouble therefore killed the process and disconnected
  // every player — which is precisely what "мир сломался, игра
  // перезагрузилась" looks like from a phone, and a restart cannot reach a
  // database that is unreachable anyway. Liveness is now about THIS process;
  // /health/ready is the endpoint that still fails on a DB outage.
  const memoryMod = require('./mongo-memory');
  const real = memoryMod.connection.readyState;
  memoryMod.connection.readyState = 0;              // pretend Mongo went away
  try {
    const live = await fetch(`${BASE}/health`);
    eq(live.status, 200, '/health still answers 200 with the DB down');
    const liveBody = await live.json();
    eq(liveBody.ok, false, 'and still reports the outage in the body');
    eq(liveBody.db, 0, 'and reports the raw readyState');

    const ready = await fetch(`${BASE}/health/ready`);
    eq(ready.status, 503, '/health/ready is the one that fails, for dashboards');
  } finally {
    memoryMod.connection.readyState = real;
  }
  const back = await fetch(`${BASE}/health`).then(r => r.json());
  eq(back.ok, true, 'and it reports healthy again once the DB is back');
});

scenario('reconnect: a drop in an arm comes back to the arm, not the hub safe zone', async () => {
  // The "игру перезагрузило и выкинуло в безопасную зону" half of the reload
  // report. Nothing exotic is needed to trigger it: one ordinary socket drop,
  // which on mobile happens every time the app is backgrounded past
  // engine.io's 40s of silence.
  //
  // The floor was already being saved and never read back — currentFloor is
  // initialised to the hub for every new connection — so the reconnect
  // rebuilt the world on floor 1, whose spawn sits in the middle of the safe
  // zone. It is restored now (_restoreFloorFor, server/index.js), from the
  // DATABASE's copy rather than the client's blob, and re-checked against the
  // gates rather than trusted.
  const c1 = await connectWithSaved('harness_arm_reconnect', { lvl: 20, xp: 0, xpNext: 9999 });
  await enterWorld(c1, 'ranger');
  const onArm = c1.wait('gameStart', { where: 'enter arm' });
  c1.emit('enterLocation', { target: 'top' });
  const arm = await onArm;
  eq(arm.floor, 3, 'the player is standing on the arm floor');

  // Walk somewhere that is not the arm's entrance, so "came back to the right
  // floor" and "came back to the right spot" are two different assertions.
  const walkedX = arm.spawn.x + 120, walkedY = arm.spawn.y;
  for (let i = 0; i < 6; i++) { c1.emit('mv', [Math.round(walkedX * 2), Math.round(walkedY * 2), 1, 500, 1]); await sleep(60); }
  await sleep(300);
  await c1.close();
  await sleep(700);   // let the disconnect flush land

  const c2 = await connectAs('harness_arm_reconnect');
  const back = await enterWorld(c2, 'ranger');
  eq(back.floor, 3, 'the reconnect comes back to the arm it dropped on');
  ok(Math.abs(back.spawn.x - walkedX) < 40 && Math.abs(back.spawn.y - walkedY) < 40,
    `and to the spot it was standing on, not the entrance (${back.spawn.x},${back.spawn.y} vs ${walkedX},${walkedY})`);
  await c2.close();
  await sleep(300);
});

scenario('reconnect: a login that never picks a character leaves the stored spot alone', async () => {
  // floor/x/y are one fact and have to be written as one. currentFloor starts
  // at the hub on every fresh connection and only becomes real once selectChar
  // seats the character — so a session that logged in and stopped there (the
  // app closed at the character screen, a connection that died while it
  // loaded) used to flush `floor: hub` on its way out while leaving the stored
  // x/y pointing at wherever the player had really been. The next real login
  // read that pair back, could not place arm coordinates on the hub grid, and
  // dropped the player on the hub spawn — "вышел в коридоре, зашёл в зале".
  const c1 = await connectWithSaved('harness_nosel_floor', { lvl: 20, xp: 0, xpNext: 9999 });
  await enterWorld(c1, 'ranger');
  const onArm = c1.wait('gameStart', { where: 'enter arm' });
  c1.emit('enterLocation', { target: 'top' });
  const arm = await onArm;
  const wx = arm.spawn.x + 400, wy = arm.spawn.y;
  for (let i = 0; i < 8; i++) { c1.emit('mv', [Math.round(wx * 2), Math.round(wy * 2), 1, 500, 1]); await sleep(60); }
  await sleep(250);
  await c1.close();
  await sleep(700);

  // Open and close again without ever selecting a character.
  const c2 = await connectAs('harness_nosel_floor');
  await sleep(200);
  await c2.close();
  await sleep(700);

  const c3 = await connectAs('harness_nosel_floor');
  const back = await enterWorld(c3, 'ranger');
  eq(back.floor, arm.floor, 'the aborted login did not move the stored floor to the hub');
  ok(Math.abs(back.spawn.x - wx) < 60 && Math.abs(back.spawn.y - wy) < 60,
    `and the stored spot survived it (${back.spawn.x},${back.spawn.y} vs ${wx},${wy})`);
  await c3.close();
  await sleep(300);
});

scenario('reconnect: a drop out of a private instance reports the floor it actually lands on', async () => {
  // Сотрудничество/Элитная фарм-зона/Страх are private per-party Rooms with
  // nothing to rejoin, so a reconnect out of one is sent to the hub
  // (_RESTORABLE_FLOORS). The client cannot keep the position it was holding
  // across that — those coordinates belong to a grid that no longer exists,
  // and off the hub's own 68x68 grid canMoveX/canMoveY refuse EVERY direction
  // (tileAt reads out of bounds as WALL), which is what left people frozen
  // inside what looked like solid wall on the hub. gameStart is what tells it
  // where it really is, so the spawn it carries has to be a real spot on the
  // floor it reports — that is the contract the client's reposition reads.
  const leader = await connectWithSaved('harness_instdrop_l', { lvl: 30, xp: 0, xpNext: 9999 });
  const m1 = await connectWithSaved('harness_instdrop_a', { lvl: 30, xp: 0, xpNext: 9999 });
  const m2 = await connectWithSaved('harness_instdrop_b', { lvl: 30, xp: 0, xpNext: 9999 });
  await enterWorld(leader, 'ranger'); await enterWorld(m1, 'ranger'); await enterWorld(m2, 'ranger');
  leader.emit('farm2GroupCreate'); await leader.wait('farm2GroupState', { timeout: 3000 });
  m1.emit('farm2GroupJoin', { leaderId: leader.sock.id }); await m1.wait('farm2GroupState', { timeout: 3000 });
  m2.emit('farm2GroupJoin', { leaderId: leader.sock.id }); await m2.wait('farm2GroupState', { timeout: 3000 });
  const m1In = m1.wait('gameStart', { where: 'm1 into farmZone2' });
  const started = leader.wait('farm2Started', { timeout: 5000 });
  leader.emit('farm2GroupStart');
  await started;
  const f2 = await m1In;
  eq(f2.floor, 13, 'm1 is inside the private Элитная фарм-зона instance');
  // Deep enough in that the position is off the hub's own grid (68 tiles,
  // 2720px) — the case that froze the player rather than merely misplacing
  // them.
  const wx = f2.spawn.x + 200, wy = f2.spawn.y + 1200;
  for (let i = 0; i < 8; i++) { m1.emit('mv', [Math.round(wx * 2), Math.round(wy * 2), 1, 500, 1]); await sleep(60); }
  await sleep(250);

  // A transport blip: the old socket is still connected server-side, which is
  // what a mobile reconnect really looks like before engine.io times it out.
  const m1b = await connectAs('harness_instdrop_a');
  const back = m1b.wait('gameStart', { where: 'live reconnect' });
  m1b.emit('selectChar', { type: 'ranger', savedStats: {
    type: 'ranger', lvl: 30, xp: 0, xpNext: 9999, hp: 500, maxHp: 500, kills: 0, savedAt: Date.now(),
  } });
  const g = await back;
  eq(g.floor, 1, 'the reconnect lands on the hub, not back in the instance');
  ok(g.spawn && Math.abs(g.spawn.x - wx) > 1 || Math.abs(g.spawn.y - wy) > 1,
    'and gameStart carries a spawn of its own rather than echoing the instance position');
  ok(g.spawn.x >= 0 && g.spawn.y >= 0 && g.spawn.y < 68 * 40 && g.spawn.x < 68 * 40,
    `that spawn is a real spot on the hub grid (${g.spawn.x},${g.spawn.y})`);
  ok(wy >= 68 * 40, `while the position it was holding is off that grid entirely (y=${wy})`);
  await Promise.all([m1b, leader, m1, m2].map(x => x.close()));
  await sleep(300);
});

scenario('reconnect: the restored floor is re-checked, not trusted', async () => {
  // Restoring a floor is a server-side entry to it, so it has to answer the
  // same question the walk-in path does — asked against the state NOW, not
  // the state when the player left. A level that no longer qualifies (a
  // rebirth, an admin correction) must land in the hub instead.
  const c1 = await connectWithSaved('harness_arm_gate', { lvl: 20, xp: 0, xpNext: 9999 });
  await enterWorld(c1, 'ranger');
  const onArm = c1.wait('gameStart', { where: 'enter arm' });
  c1.emit('enterLocation', { target: 'top' });
  eq((await onArm).floor, 3, 'in the arm at a level that qualifies');
  await c1.close();
  await sleep(700);

  // Drop the level below that arm's requirement while they are away.
  const Player = require('../server/models/Player');
  const row = memory.__dump('Player').find(p => p.username === c1.auth.username);
  await Player.updateOne({ _id: row._id }, { $set: { 'savedData.lvl': 1 } });
  await sleep(50);

  const c2 = await connectAs('harness_arm_gate');
  const back = await enterWorld(c2, 'ranger');
  eq(back.floor, 1, 'a floor the account can no longer enter falls back to the hub');
  await c2.close();
});

scenario('reconnect: a stored floor the client made up is ignored', async () => {
  // `floor` rides inside the same savedData blob a modified client composes
  // freely, so honouring the client's copy would be a free teleport onto any
  // floor past every gate. The restore reads the DB record only.
  const c = await connectAs('harness_arm_forge');
  const start = c.wait('gameStart', { where: 'forged floor' });
  c.emit('selectChar', { type: 'ranger', savedStats: {
    type: 'ranger', floor: 10, x: 4000, y: 4000, lvl: 1, xp: 0,
    hp: 100, maxHp: 100, kills: 0, savedAt: Date.now(),
  } });
  eq((await start).floor, 1, 'a floor claimed by the save is not honoured');
  await c.close();
});


scenario('health: /health says WHY sessions ended, split by cause', async () => {
  // "Мир перезагружается" is a client reconnecting — the reconnect re-runs
  // selectChar and gameStart rebuilds the world from scratch. Which of the
  // several possible causes is happening is not visible from outside, and the
  // server was throwing away socket.io's `reason` argument, the one field
  // that separates them. A client closing itself (js/network.js's watchdog
  // giving up on the link) and the server closing it (a duplicate login being
  // kicked) are opposite problems with opposite fixes, and they must not read
  // the same in the counts.
  const { token } = await fetch(`${BASE}/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  }).then(r => r.json());
  const stats = async () => (await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${token}` } })
    .then(r => r.json())).sessions;

  const before = await stats();
  ok(before && typeof before.sinceMs === 'number', '/health carries a session breakdown');

  // A client hanging up on itself — exactly the shape the watchdog produces.
  const a = await connectAs('harness_sessreason_a');
  await enterWorld(a, 'mage');
  a.sock.disconnect();
  await sleep(400);
  const afterClient = await stats();
  const clientQuits = (afterClient.reasons['client namespace disconnect'] || 0)
                    - (before.reasons['client namespace disconnect'] || 0);
  eq(clientQuits, 1, 'a client hanging up is counted as the client hanging up');
  eq(afterClient.endedAuthed - before.endedAuthed, 1, 'and counted as an authenticated session ending');
  ok(afterClient.shortLived - before.shortLived === 1,
    'and flagged short-lived, which is what a reconnect loop looks like in bulk');

  // The server closing one instead: a second login for the same account kicks
  // the first, and that must NOT land in the same bucket as the case above.
  const b1 = await connectAs('harness_sessreason_b');
  await enterWorld(b1, 'ranger');
  const b2 = await connectAs('harness_sessreason_b');
  await sleep(500);
  const afterKick = await stats();
  eq((afterKick.reasons['server namespace disconnect'] || 0)
     - (afterClient.reasons['server namespace disconnect'] || 0), 1,
  'a server-side kick is counted separately from a client giving up');
  eq(afterKick.reasons['client namespace disconnect'] || 0, clientQuits + (before.reasons['client namespace disconnect'] || 0),
    'and did not inflate the client-side bucket');

  await b2.close();
  await b1.close();
});

scenario('rating: the tables are built once and shared, not rebuilt per request', async () => {
  // getRating sits in the heavy bucket, which still allows 40 calls per 5s per
  // socket. The clans tab reads EVERY clan plus a bm document for EVERY member
  // of every clan — unbounded, against the same connection pool every progress
  // save shares. Cached process-wide for RATING_TTL_MS: a change landing in the
  // database mid-window must NOT show up until the window turns over, which is
  // the observable proof the second request never went to the database.
  const c = await connectWithSaved('harness_rating_cache', { lvl: 5 });
  await enterWorld(c, 'mage');

  const first = c.wait('ratingData', { timeout: 5000 });
  c.emit('getRating', { tab: 'players' });
  const before = await first;
  ok(Array.isArray(before.rows), 'the players tab answers with rows');

  // A brand-new account at the very top of the table by bm. Written straight
  // to the database, the way a real bm update lands.
  const Player = require('../server/models/Player');
  await Player.create({ telegramId: 'harness_rating_top', username: 'harness_rating_top', savedData: { lvl: 99 }, bm: 999999999 });

  const second = c.wait('ratingData', { timeout: 5000 });
  c.emit('getRating', { tab: 'players' });
  const after = await second;
  ok(!after.rows.some(r => r.username === 'harness_rating_top'),
    'the second request is served from the cache, not from a fresh query');

  await c.close();
});

scenario('floors: a mid-run disconnect+reconnect resumes a Fear run on its own floor, not the hub', async () => {
  const a1 = await connectWithSaved('harness_fear_reconnect', { lvl: 10, xp: 0, xpNext: 100 });
  await enterWorld(a1, 'ranger');

  const started = a1.wait('fearStarted', { timeout: 3000 });
  a1.emit('fearEnter');
  await started;
  eq(a1.last('gameStart')?.floor, 11, 'the first session is on the fear floor mid-run');

  // An ordinary disconnect (not a clean exit) — the run is meant to be held
  // open for a possible reconnect (_fearHoldOnDisconnect/_fearGraceStart),
  // not ended outright the way arena3/race10/death battle disconnects are.
  // This also lands well inside FEAR_START_DELAY_MS's grace window, so it
  // doubles as coverage for the reconnect-during-countdown path: the
  // deferred wave-1 setTimeout was scheduled against the now-dead socket
  // and must no-op, with the fearCarry reclaim starting wave 1 itself
  // instead (see its comment in server/index.js).
  await a1.close();

  // Reconnect as the SAME account. Every fresh connection's own currentFloor
  // starts at the hub (see its declaration) — without the reconnect-floor
  // fix (selectChar checking _fearDisconnectGrace before defaulting there),
  // this session would join the hub's Room instead of the fear floor's, and
  // Room.addPlayer's own _fearGraceClaim would check the wrong Room and
  // never find the held hall at all.
  const a2 = await connectAs('harness_fear_reconnect');
  const start2 = await enterWorld(a2, 'ranger');
  eq(start2.floor, 11, 'reconnecting mid-run lands back on the fear floor, not the hub');
  eq(start2.fear && start2.fear.inRun, true, 'and the run itself is reported as still live');
  eq(start2.fear && start2.fear.wave, 1, 'and reconnecting during the countdown starts wave 1 immediately, not a resumed countdown nobody can see');

  await a2.close();
});

// "У некоторых игроков попытки в Страх не уходят", and the "некоторых" is the
// whole shape of it: it depends entirely on HOW the player leaves.
//
// Only clearing the last wave and dying used to end a run. Walking out — the
// map panel, or an event window closing and force-moving everyone — moved the
// player off the fear floor and left the _fear record behind. Every later
// fearEnter checks that record first and returns SILENTLY on a hit, so the
// button did nothing, no error appeared, and the remaining attempts were never
// spent. Players who die or clear the run never saw it.
scenario('fear: walking out of Страх ends the run, so the next entry is charged', async () => {
  const c = await connectWithSaved('harness_fear_attempts', { lvl: 20, xp: 0, xpNext: 100 });
  await enterWorld(c, 'ranger');

  const first = c.wait('fearStarted', { timeout: 4000 });
  c.emit('fearEnter');
  eq((await first).attemptsLeft, 1, 'the first entry spends one of the two attempts');

  // Out through the front door: alive, mid-run, not having cleared anything.
  // Both waiters are armed before the emit — the run-over notice is sent
  // ahead of the floor change, so arming it afterwards would miss it.
  const back = c.wait('gameStart', { timeout: 4000 });
  // The client mirrors the run flag in page-level JS, so being told is part
  // of the fix — without it the wave HUD keeps drawing a finished run.
  const told = c.wait('fearState', { timeout: 4000 }).catch(() => null);
  c.emit('enterLocation', { target: 'hub' });
  eq((await back).floor, 1, 'the player is back on the hub floor');
  eq((await told)?.inRun, false, 'and is told the run is over');

  // The actual report: this entry used to be swallowed in silence.
  const second = Promise.race([
    c.wait('fearStarted', { timeout: 4000 }),
    c.wait('fearError', { timeout: 4000 }).then(e => { throw new Error('refused: ' + JSON.stringify(e)); }),
  ]);
  c.emit('fearEnter');
  eq((await second).attemptsLeft, 0, 'entering again works and spends the second attempt');

  // And the cap still means something afterwards.
  const outAgain = c.wait('gameStart', { timeout: 4000 });
  c.emit('enterLocation', { target: 'hub' });
  await outAgain;
  const refused = c.wait('fearError', { timeout: 4000 });
  c.emit('fearEnter');
  ok(/закончились/.test((await refused).msg || ''),
     'a third entry is refused for want of attempts, not swallowed', (await refused).msg);

  await c.close();
});

scenario('floors: leaving for an arm tells hub-side players you left, not just moved', async () => {
  const a = await connectAs('harness_floors_a');
  const b = await connectAs('harness_floors_b');
  await enterWorld(a, 'ranger');
  await enterWorld(b, 'mage'); // both start on the hub floor

  // A plain in-floor move must NOT look like a departure.
  const noLeaveYet = b.wait('playerLeft', { timeout: 800 }).catch(() => null);
  a.emit('playerMove', { x: 1400, y: 1400, facing: 1, moving: true });
  eq(await noLeaveYet, null, 'moving within the same floor does not fire playerLeft');

  // Leaving for the left arm is a real floor change — b (still on the hub)
  // must be told a left, the same as an actual disconnect would.
  const aLeftForB = b.wait('playerLeft', { timeout: 3000 });
  const aOnLeft = a.wait('gameStart', { where: 'a enters left' });
  a.emit('enterLocation', { target: 'left' });
  await aOnLeft;
  const leftEvt = await aLeftForB;
  eq(leftEvt && leftEvt.id, a.sock.id, 'the hub floor is told a left when they entered the arm');

  await a.close();
  await b.close();
});

scenario('level: a server-granted reward crosses the level threshold', async () => {
  // One XP short of level 2, then claim the first story quest — a flat 50 XP
  // reward, granted and applied entirely server-side.
  // The kills the quest asks for are seeded too: the server checks the claim
  // against its own counters now, so an unfinished quest is refused.
  const c = await connectWithSaved('harness_levelup', {
    lvl: 1, xp: 99, xpNext: 100, questIdx: 0, questKills: { 'Крыса страж': 10 },
  });
  await enterWorld(c, 'mage');
  const claimed = c.wait('questClaimed', { timeout: 6000 }).catch(() => null);
  const synced  = c.wait('xpSync', { timeout: 6000 }).catch(() => null);
  c.emit('claimQuest', { idx: 0 });
  const q = await claimed;
  ok(q && q.xp === 50, `the quest paid its flat XP (${q && q.xp})`);
  const st = await synced;
  ok(st, 'the level state came back from the server');
  eq(st && st.lvl, 2, 'which crossed into level 2');
  ok(st && st.xpNext > 100, 'with the next threshold recomputed');
  ok(st && st.baseAtk > 0 && st.baseMaxHp > 0, 'and the level-derived stats');
  await sleep(200);
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  eq(row.savedData.lvl, 2, 'the level up was persisted immediately');
  await c.close();
});

scenario('quests: a claim for an unfinished quest is refused', async () => {
  // The check that was missing entirely: claimQuest verified WHICH quest was
  // being claimed but never whether it had been done, so a client could walk
  // the whole 60-quest chain in one go and collect every reward.
  const c = await connectWithSaved('harness_questcheat', { questIdx: 0, questKills: { 'Крыса страж': 9 } });
  await enterWorld(c, 'mage');
  const err = c.wait('questClaimError', { timeout: 6000 }).catch(() => null);
  c.emit('claimQuest', { idx: 0 });
  ok(await err, 'one kill short is refused');
  await sleep(200);
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  eq(row.savedData.questIdx, 0, 'and the chain did not advance');
  await c.close();
});

scenario('quests: a save cannot write the counters', async () => {
  const c = await connectWithSaved('harness_questpin', { questIdx: 0, questKills: {} });
  await enterWorld(c, 'mage');
  c.emit('saveProgress', { stats: {
    type: 'mage', lvl: 1, xp: 0, hp: 10, maxHp: 10,
    questIdx: 42, questKills: { 'Крыса страж': 999 },
    savedAt: Date.now(),
  } });
  await sleep(3400);
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  eq(row.savedData.questIdx, 0, 'the stored index is the server\'s');
  eq(Object.keys(row.savedData.questKills || {}).length, 0, 'and so are the counters');
  await c.close();
});

scenario('quests: f1q14 is now a level-15 gate and f1q15 asks to enter Фарм-зона', async () => {
  // QUEST_DEF indices are positional: f1q14 sits at index 12 (after
  // f1..f1q13), f1q15 at index 14 (after f1q9's level-20 quest at 13) — see
  // shared/definitions.js's own comment on why the array position, not the
  // id, is what player progress keys off.
  const F1Q14_IDX = 12, F1Q15_IDX = 14;

  // f1q14: replaced "join a clan" with "reach level 15" — a save already at
  // level 15 should find it claimable immediately, no separate event needed.
  const leveled = await connectWithSaved('harness_quest_lvl15', { lvl: 15, questIdx: F1Q14_IDX, questKills: {} });
  await enterWorld(leveled, 'ranger');
  const claimed14 = leveled.wait('questClaimed', { timeout: 6000 }).catch(() => null);
  leveled.emit('claimQuest', { idx: F1Q14_IDX });
  ok(await claimed14, 'level 15 alone is enough to claim f1q14');
  await leveled.close();

  const short = await connectWithSaved('harness_quest_lvl14', { lvl: 14, questIdx: F1Q14_IDX, questKills: {} });
  await enterWorld(short, 'ranger');
  const err14 = short.wait('questClaimError', { timeout: 6000 }).catch(() => null);
  short.emit('claimQuest', { idx: F1Q14_IDX });
  ok(await err14, 'one level short of 15 is refused');
  await short.close();

  // f1q15: replaced "reach the top corridor" with "enter Фарм-зона" — actually
  // walking through the portal (enterLocation('farmZone')) has to be what
  // completes it, not a kill-triggered proxy (there's no monster-level curve
  // to hook into for a zone outside the arm progression).
  const farmer = await connectWithSaved('harness_quest_farm', { lvl: 25, questIdx: F1Q15_IDX, questKills: {} });
  await enterWorld(farmer, 'ranger');
  const preErr = farmer.wait('questClaimError', { timeout: 3000 }).catch(() => null);
  farmer.emit('claimQuest', { idx: F1Q15_IDX });
  ok(await preErr, 'not claimable before actually entering the zone');

  const farmStart = farmer.wait('gameStart', { where: `${farmer.name} enters farmZone` });
  farmer.emit('enterLocation', { target: 'farmZone' });
  const onFarm = await farmStart;
  eq(onFarm.floor, 7, 'the transition landed on the farm-zone floor');

  const claimed15 = farmer.wait('questClaimed', { timeout: 6000 }).catch(() => null);
  farmer.emit('claimQuest', { idx: F1Q15_IDX });
  ok(await claimed15, 'entering the zone alone made it claimable');
  await farmer.close();
});

scenario('progression: a repeat selectChar resumes the session instead of rolling it back to login', async () => {
  // `authed` is the account document as READ AT LOGIN and nothing refreshes
  // it — every write goes through the model, not the document. selectChar
  // pinned every server-owned field to it, so a SECOND selectChar on the same
  // connection handed the client back its login-time state: a skill studied
  // minutes earlier un-learned itself (the books already spent), the
  // authoritative progressSync said so, and the next save persisted the
  // rollback. selectChar is a plain client event, so a duplicate is always
  // one packet away — it has to be idempotent.
  const c = await connectWithSaved('harness_reselect', {
    lvl: 20, xp: 0, xpNext: 9999, type: 'ranger',
    inventory: [{ id: 'book_ranger_Q', qty: 10 }],
  });
  await enterWorld(c, 'ranger');
  await sleep(200);

  const learned = c.wait('progressSync', { timeout: 4000 });
  c.emit('learnSkill', { key: 'Q' });
  eq((await learned).skillLevels.Q, 1, 'the skill is studied');
  await sleep(600);   // let _persistLearned land

  const again = c.wait('progressSync', { timeout: 4000 });
  c.emit('selectChar', { type: 'ranger', savedStats: {
    type: 'ranger', lvl: 20, xp: 0, xpNext: 9999, hp: 500, maxHp: 500, kills: 0, savedAt: Date.now(),
  } });
  eq((await again).skillLevels.Q, 1, 'a repeat selectChar does not un-learn it');

  // And the rollback must not be what gets written down either: the pinned
  // blob becomes _lastStats, which every later save persists verbatim.
  await c.close();
  await sleep(700);
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  eq((row.savedData.skillLevels || {}).Q, 1, 'and the studied level is what reaches the database');
});

scenario('progression: learning a passive without the book is refused', async () => {
  const c = await connectAs('harness_passive');
  await enterWorld(c, 'mage');
  const err = c.wait('progressError', { timeout: 5000 }).catch(() => null);
  c.emit('learnPassive', { id: 'allhp' });
  const got = await err;
  ok(got && got.msg, `refused with a message (${got && got.msg})`);
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  const lvl = row && row.savedData && row.savedData.passiveLevels && row.savedData.passiveLevels.allhp;
  ok(!lvl, 'and nothing was written to the database');
  await c.close();
});

scenario('progression: a save cannot write passive levels the server did not grant', async () => {
  const c = await connectAs('harness_pin');
  await enterWorld(c, 'mage');
  c.emit('saveProgress', { stats: {
    type: 'mage', lvl: 1, xp: 0, gold: 0, kills: 0, hp: 10, maxHp: 10,
    inventory: [], storage: [], equipment: {},
    passiveLevels: { allhp: 5 }, skillLevels: { Q: 10 }, upgrades: { atk: 50 },
    savedAt: Date.now(), invRev: 0,
  } });
  await sleep(3400);
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  const sd = (row && row.savedData) || {};
  ok(!(sd.passiveLevels && sd.passiveLevels.allhp), 'forged passive level did not persist');
  ok(!(sd.skillLevels && sd.skillLevels.Q), 'forged skill level did not persist');
  ok(!(sd.upgrades && sd.upgrades.atk), 'forged stat upgrades did not persist');
  await c.close();
});


// Seeds an account's stored inventory and returns a session that has it.
//
// The two-step connect is not ceremony: authed.savedData is the document as it
// was read AT LOGIN, and selectChar builds the session's item set from that —
// so anything written to the row after the socket authenticated is invisible
// to it until the next login. Granting first and connecting second is what a
// real drop does too (it goes through _commitServerItems on a live session).
async function connectWithSaved(name, saved) {
  const seed = await connectAs(name);           // creates the row
  await seed.close();
  // Long enough for that socket's disconnect flush to land. It writes the
  // session's own view of the character, so seeding before it completes gets
  // silently overwritten — which is a real property of the server, not a quirk
  // of the double.
  await sleep(500);
  const Player = require('../server/models/Player');
  const row = memory.__dump('Player').find(p => p.username === seed.auth.username);
  const set = {};
  for (const [k, v] of Object.entries(saved)) set['savedData.' + k] = v;
  await Player.updateOne({ _id: row._id }, { $set: set });
  await sleep(50);
  return connectAs(name);
}

scenario('items: equipping is performed by the server, not the save', async () => {
  const c = await connectWithSaved('harness_equip', { inventory: [{ id: 'uq_sword_l', enhance: 0 }] });
  await enterWorld(c, 'deathknight');
  const sync = c.wait('inventorySync', { timeout: 6000 });
  c.emit('equipItem', { idx: 0 });
  const got = await sync;
  eq(got.inventory.length, 0, 'the item left the inventory');
  ok(got.equipment && got.equipment.weapon && got.equipment.weapon.id === 'uq_sword_l',
     'and landed in the weapon slot');
  await sleep(120);
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  ok(row.savedData.equipment && row.savedData.equipment.weapon, 'and was persisted immediately');
  await c.close();
});

scenario('items: unequip refuses when the inventory is full', async () => {
  const c = await connectWithSaved('harness_unequip', { inventory: [{ id: 'uq_axe_l', enhance: 0 }] });
  await enterWorld(c, 'lev');
  await (async () => { const s = c.wait('inventorySync'); c.emit('equipItem', { idx: 0 }); await s; })();
  // Fill every inventory slot, then try to take the weapon back. Seeded after
  // the session is closed AND its disconnect flush has landed, or that flush
  // writes the session's empty inventory over this.
  await c.close(); await sleep(500);
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  const Player = require('../server/models/Player');
  await Player.updateOne({ _id: row._id }, { $set: { 'savedData.inventory':
    Array.from({ length: 150 }, () => ({ id: 'uq_axe_e', enhance: 0 })) } });
  await sleep(80);
  const c2 = await connectAs('harness_unequip');
  await enterWorld(c2, 'lev');
  const err = c2.wait('itemError', { timeout: 5000 }).catch(() => null);
  c2.emit('unequipItem', { slot: 'weapon' });
  ok(await err, 'a full inventory refuses the unequip');
  await c2.close();
});

scenario('items: a save can no longer write the item set', async () => {
  const c = await connectAs('harness_mint');
  await enterWorld(c, 'mage');
  c.emit('saveProgress', { stats: {
    type: 'mage', lvl: 1, xp: 0, gold: 0, kills: 0, hp: 10, maxHp: 10,
    inventory: [{ id: 'uq_sword_l', enhance: 15 }, { id: 'rece', qty: 9999 }],
    storage: [{ id: 'bless_stone', qty: 500 }],
    equipment: { weapon: { id: 'uq_bow_l', enhance: 15 } },
    savedAt: Date.now(),
  } });
  await sleep(3400);
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  const sd = row.savedData || {};
  eq((sd.inventory || []).length, 0, 'minted inventory did not persist');
  eq((sd.storage || []).length, 0, 'minted storage did not persist');
  eq(Object.values(sd.equipment || {}).filter(Boolean).length, 0, 'minted equipment did not persist');
  await c.close();
});

scenario('items: a storage move is one server-side operation', async () => {
  const c = await connectWithSaved('harness_storage', { inventory: [{ id: 'rece', qty: 10 }] });
  await enterWorld(c, 'ranger');
  let sync = c.wait('inventorySync', { timeout: 6000 });
  c.emit('storageDeposit', { idx: 0 });
  let got = await sync;
  eq(got.inventory.length, 0, 'deposit removed it from the inventory');
  eq((got.storage || []).length, 1, 'and put it in storage — in the same message');
  sync = c.wait('inventorySync', { timeout: 6000 });
  c.emit('storageWithdraw', { idx: 0 });
  got = await sync;
  eq((got.storage || []).length, 0, 'withdraw took it back out');
  eq(got.inventory.length, 1, 'and returned it to the inventory');
  eq(got.inventory[0].qty, 10, 'with the stack intact');
  await c.close();
});

scenario('rating: bm reflects real gear, not just level and maxHp', async () => {
  // calcBM (server/anticheat.js) reads sd.atk/sd.def — the full, gear-
  // inclusive combat stats — but _buildSaveStats() (js/network.js) never
  // sends those fields in ANY saveProgress call, ever; only baseAtk/baseDef
  // (pre-equipment) ever reach the server. Calling calcBM directly on the
  // saved blob silently treated atk/def as 0 for every player, so the
  // stored bm (what the rating panel sorts by) collapsed to roughly
  // lvl*50 + maxHp*0.5 the moment a real saveProgress landed — discarding
  // gear entirely — while the client's own HUD (recompute()'s real atk/def)
  // kept showing the correct number. That's what made the rating look
  // wrong: two players at the same level with very different gear ended up
  // with nearly-identical stored bm.
  //
  // uq_sword_l is a legendary deathknight weapon worth +130 atk — enough to
  // move calcBM's atk*5 term by 650, an unmissable jump if gear is actually
  // being counted at all.
  const { calcBM } = require('../server/anticheat');
  const RoomClass = require('../server/game/Room');
  const { CHAR_DEF } = require('../shared/definitions');
  const bare = await connectWithSaved('harness_bm_bare', { lvl: 20, type: 'deathknight' });
  await enterWorld(bare, 'deathknight');
  // The exact bare shape _buildSaveStats() sends — no atk/def, ever.
  bare.emit('saveProgress', { stats: {
    type: 'deathknight', floor: 1, hp: 100, maxHp: 100, kills: 0,
    hudPotion: 'pt1', autoHpPct: 0.5, autoBuffTypes: {}, lang: 'ru', savedAt: Date.now(),
  } });
  await sleep(3400);
  const bareRow = memory.__dump('Player').find(p => p.username === bare.auth.username);
  await bare.close();

  const geared = await connectWithSaved('harness_bm_geared', {
    lvl: 20, type: 'deathknight',
    equipment: { weapon: { id: 'uq_sword_l', enhance: 0 } },
  });
  await enterWorld(geared, 'deathknight');
  geared.emit('saveProgress', { stats: {
    type: 'deathknight', floor: 1, hp: 100, maxHp: 100, kills: 0,
    hudPotion: 'pt1', autoHpPct: 0.5, autoBuffTypes: {}, lang: 'ru', savedAt: Date.now(),
  } });
  await sleep(3400);
  const gearedRow = memory.__dump('Player').find(p => p.username === geared.auth.username);
  await geared.close();

  ok(bareRow.bm > 0, 'the bare account still gets a real bm (not zero/undefined)');
  ok(gearedRow.bm >= bareRow.bm + 600,
    `the legendary weapon actually moves bm (bare=${bareRow.bm}, geared=${gearedRow.bm})`);

  // Not just "some number changed" — has to match what Room.computeStats
  // (the same authoritative source combat/publicProfile already trust)
  // derives for this exact level+gear, so a regression that over- or
  // under-counts gear doesn't slip through unnoticed.
  const cd = CHAR_DEF.deathknight;
  const trueStats = RoomClass.computeStats(
    { lvl: 20, baseAtk: cd.baseAtk + 19, baseDef: cd.baseDef + 19, baseMaxHp: cd.baseHP + 19 * 20,
      equipment: { weapon: { atk: 130, def: 0, hp: 1000, critChance: 0.50, enhance: 0 } }, upgrades: {} },
    cd, 'deathknight', 0,
  );
  const expected = calcBM({ lvl: 20, atk: trueStats.atk, def: trueStats.def, maxHp: trueStats.maxHp, upgrades: {} });
  eq(gearedRow.bm, expected, 'the stored bm matches the real computeStats-derived figure exactly');
});

scenario('party: growing an existing party doesn\'t break it for the others', async () => {
  // Investigated a report that a party "breaks apart" when someone else
  // sends a party invite. Covers every shape that report could reasonably
  // mean: an existing member inviting a new one to grow the party, an
  // outsider trying to invite someone who is already partied (must be
  // silently refused, not disrupt anything), and a full party refusing a
  // 6th member — none of these should touch the existing members' rosters.
  const a = await connectAs('harness_party_a');
  const b = await connectAs('harness_party_b');
  const c = await connectAs('harness_party_c');
  const d = await connectAs('harness_party_d');
  await enterWorld(a, 'ranger'); await enterWorld(b, 'ranger');
  await enterWorld(c, 'ranger'); await enterWorld(d, 'ranger');

  // Form a 2-person party: a invites b, b accepts.
  const aUpd1 = a.wait('partyUpdated', { timeout: 4000 });
  const bInv  = b.wait('partyInviteReceived', { timeout: 4000 });
  a.emit('partyInvite', { targetId: b.sock.id });
  const inv1 = await bInv;
  eq(inv1.fromId, a.sock.id, 'b is told who invited them');
  const bUpd1 = b.wait('partyUpdated', { timeout: 4000 });
  b.emit('partyAccept', { fromId: a.sock.id });
  const [au1, bu1] = await Promise.all([aUpd1, bUpd1]);
  eq(au1.members.length, 1, 'a now sees exactly b');
  eq(bu1.members.length, 1, 'b now sees exactly a');

  // An outsider (d) invites a, who is already partied — must be silently
  // refused: d gets nothing back, and — the actual bug shape reported — the
  // party must not dissolve or change for b either.
  const dGotNothing = d.wait('partyInviteReceived', { timeout: 1500 }).then(() => 'got one').catch(() => 'nothing');
  const bGotNothing = b.wait('partyUpdated', { timeout: 1500 }).then(() => 'got one').catch(() => 'nothing');
  d.emit('partyInvite', { targetId: a.sock.id });
  eq(await dGotNothing, 'nothing', 'a, already partied, never sees the outside invite reach them');
  eq(await bGotNothing, 'nothing', 'and b\'s side of the party is never touched by it');

  // b (an existing member, not the one who formed the party) invites c to
  // grow it. a must be told about the new member — that is the actual "does
  // the party survive a new invite" question the report was about.
  const aUpd2 = a.wait('partyUpdated', { timeout: 4000 });
  const cInv  = c.wait('partyInviteReceived', { timeout: 4000 });
  b.emit('partyInvite', { targetId: c.sock.id });
  await cInv;
  const cUpd = c.wait('partyUpdated', { timeout: 4000 });
  const bUpd2 = b.wait('partyUpdated', { timeout: 4000 });
  c.emit('partyAccept', { fromId: b.sock.id });
  const [au2, bu2, cu2] = await Promise.all([aUpd2, bUpd2, cUpd]);
  eq(au2.members.length, 2, 'a sees the party grow to 2 others (b, c) — not dissolve');
  eq(bu2.members.length, 2, 'so does b');
  eq(cu2.members.length, 2, 'and c joined the SAME party (a+b), not a fresh one');
  ok(au2.members.some(m => m.id === c.sock.id), 'a specifically sees c as a new party-mate');

  // c declining a fresh invite tells the inviter, instead of leaving them
  // with no signal at all (partyDecline used to be a pure no-op).
  const e = await connectAs('harness_party_e');
  await enterWorld(e, 'ranger');
  const declineToast = a.wait('partyInviteDeclined', { timeout: 4000 });
  const eInv = e.wait('partyInviteReceived', { timeout: 4000 });
  a.emit('partyInvite', { targetId: e.sock.id });
  await eInv;
  e.emit('partyDecline', { fromId: a.sock.id });
  const declined = await declineToast;
  eq(declined.byName, e.auth.username, 'the inviter is told who declined');

  await Promise.all([a, b, c, d, e].map(x => x.close()));
});

scenario('heal: healParty is floored server-side at HEAL_PARTY_CD_MS, not just the client\'s 25s cooldown', async () => {
  // The client-side cooldown on the warlock's party heal (25s) was purely
  // advisory — nothing on the server stopped a modified client firing
  // 'healParty' back to back. Two casts inside HEAL_PARTY_CD_MS (2s) from the
  // same connection: only the first should land.
  const healer = await connectAs('harness_heal_healer');
  const ally = await connectAs('harness_heal_ally');
  await enterWorld(healer, 'warlock');
  await enterWorld(ally, 'ranger');

  const allyUpd = ally.wait('partyUpdated', { timeout: 4000 });
  const healerInv = healer.wait('partyInviteReceived', { timeout: 4000 });
  ally.emit('partyInvite', { targetId: healer.sock.id });
  await healerInv;
  const healerUpd = healer.wait('partyUpdated', { timeout: 4000 });
  healer.emit('partyAccept', { fromId: ally.sock.id });
  await Promise.all([allyUpd, healerUpd]);

  const firstHeal = ally.wait('healPartyMember', { timeout: 3000 });
  healer.emit('healParty', { amount: 50 });
  const h1 = await firstHeal;
  eq(h1.amount, 50, 'the first cast lands in full');

  const secondHeal = ally.wait('healPartyMember', { timeout: 800 }).then(() => 'landed').catch(() => 'nothing');
  healer.emit('healParty', { amount: 50 });
  eq(await secondHeal, 'nothing', 'a second cast inside HEAL_PARTY_CD_MS is silently dropped');

  await Promise.all([healer, ally].map(x => x.close()));
});

scenario('reconnect: a second socket for the same account kicks the first', async () => {
  const c1 = await connectAs('harness_kick');
  await enterWorld(c1, 'warlock');
  const kicked = c1.wait('kicked', { timeout: 6000 }).catch(() => null);
  const c2 = await connectAs('harness_kick');
  ok(await kicked, 'the first session was told it was replaced');
  await c1.close(); await c2.close();
});

scenario('bundle: the concatenated client parses and declares nothing twice', async () => {
  // The client is 24 files joined into ONE script, so two files declaring the
  // same `const` is a SyntaxError that stops the entire bundle from loading —
  // a total outage, and one no server-side scenario can see. Moving a constant
  // into shared/definitions.js without deleting the old copy does exactly
  // that, and it reached a commit before this check existed.
  const fs = require('fs');
  const files = require('../server/bundle-files');
  ok(files.length > 10, `bundle file list found (${files.length} files)`);
  const bundle = files.map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n;\n');
  let err = null;
  try { new (require('vm').Script)(bundle, { filename: 'bundle.js' }); }
  catch (e) { err = e.message; }
  ok(!err, 'the concatenated bundle parses', err);

  // Name the collision rather than only reporting a parse error, so the fix is
  // obvious from the failure line.
  const seen = new Map(), dupes = [];
  for (const f of files) {
    for (const m of fs.readFileSync(path.join(ROOT, f), 'utf8').matchAll(/^const ([A-Za-z_$][\w$]*)\s*=/gm)) {
      if (seen.has(m[1]) && seen.get(m[1]) !== f) dupes.push(`${m[1]} (${seen.get(m[1])} and ${f})`);
      else seen.set(m[1], f);
    }
  }
  ok(dupes.length === 0, 'no top-level const is declared in two bundle files', dupes.join(', '));
});

scenario('buffs: the x2 multipliers cannot be claimed by a save', async () => {
  // This one is load-bearing: gold and XP read buffs.gold / buffs.exp to apply
  // the x2, so a save able to write a permanently active buff would double
  // every payout for good. Drinking is a request (useBuffPotion) and the timer
  // is the server's.
  const c = await connectWithSaved('harness_buff', { gold: 0, buffs: {} });
  await enterWorld(c, 'mage');
  c.emit('saveProgress', { stats: {
    type: 'mage', lvl: 1, xp: 0, hp: 10, maxHp: 10,
    buffs: { gold: 999999, exp: 999999 }, savedAt: Date.now(),
  } });
  await sleep(3400);
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  eq(Object.keys(row.savedData.buffs || {}).length, 0, 'the forged buffs did not persist');
  await c.close();
});

scenario('buffs: drinking one is served by the server', async () => {
  const c = await connectWithSaved('harness_drink', { inventory: [{ id: 'bp_gold', qty: 1 }] });
  await enterWorld(c, 'ranger');
  const sync = c.wait('buffSync', { timeout: 6000 }).catch(() => null);
  const inv  = c.wait('inventorySync', { timeout: 6000 }).catch(() => null);
  c.emit('useBuffPotion', { id: 'bp_gold' });
  const st = await sync;
  ok(st && st.buffs && st.buffs.gold > 0, `the buff started server-side (${st && st.buffs && st.buffs.gold}s)`);
  const iv = await inv;
  eq(iv && iv.inventory.length, 0, 'and the potion was consumed');
  await c.close();
});

scenario('save: a blank save no longer resets anything', async () => {
  // The catastrophic-reset guard used to catch this. It is gone, because every
  // field it protected is taken from the session copy now — so an empty blob
  // has nothing left to overwrite.
  const c = await connectWithSaved('harness_blank', {
    gold: 777, lvl: 4, inventory: [{ id: 'rece', qty: 3 }], questIdx: 2,
  });
  await enterWorld(c, 'lev');
  c.emit('saveProgress', { stats: { type: 'lev', savedAt: Date.now() } });
  await sleep(3400);
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  const sd = row.savedData || {};
  eq(sd.gold, 777, 'gold survived a blank save');
  eq(sd.lvl, 4, 'level survived');
  eq((sd.inventory || []).length, 1, 'items survived');
  eq(sd.questIdx, 2, 'quest progress survived');
  await c.close();
});

scenario('race: claimVipRewards racing marketList cannot duplicate an enhanced item', async () => {
  // claimVipRewards clones _lastStats.inventory before its DB awaits and
  // commits that clone wholesale (_lastStats.inventory = inv) once they
  // resolve — see claimVipRewards' own comment and _itemsBusy's. marketList
  // is async too: it re-verifies ownership, then awaits
  // MarketListingModel.create(), and only removes the item from the live
  // inventory once that resolves. Neither side is the other's clone, so
  // nothing before this fix stopped them interleaving: claimVipRewards
  // clones the inventory (sword still in it), marketList's removal runs and
  // the listing goes live, and THEN claimVipRewards' delayed commit stamps
  // its stale clone — sword included — back over the live array. The sword
  // ends up both sold (an active listing) and back in the inventory, at
  // whatever enhance level the stale clone happened to carry. The fix makes
  // marketList refuse outright (like every other item handler already does)
  // while a clone-and-commit handler is mid-flight, via the shared
  // _itemOpBusy flag.
  const c = await connectWithSaved('harness_race_vip_marketlist', {
    vipLevel: 1, inventory: [{ id: 'uq_sword_l', enhance: 5 }],
    vipPending: [1],
  });
  await enterWorld(c, 'deathknight');

  const Player = require('../server/models/Player');
  await _withDbDelay(Player, 'updateOne', 60, async () => {
    const claimedP = c.wait('vipRewardsClaimed', { timeout: 8000 }).catch(() => null);
    c.emit('claimVipRewards');
    // Sent right as claimVipRewards' updateOne is in flight — see _withDbDelay.
    await sleep(20);
    const listedP = c.wait('marketListed', { timeout: 8000 }).catch(() => null);
    const listErrP = c.wait('marketListError', { timeout: 8000 }).catch(() => null);
    c.emit('marketList', { item: { id: 'uq_sword_l', enhance: 5 }, price: 10 });
    await Promise.race([listedP, listErrP]);
    await claimedP;
  });
  await sleep(300);

  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  const listings = memory.__dump('MarketListing')
    .filter(l => l.sellerUsername === c.auth.username && l.status === 'active');
  const invCopies = (row.savedData.inventory || []).filter(i => i && i.id === 'uq_sword_l').length;
  eq(invCopies + listings.length, 1,
    `exactly one copy of the sword survives the race (inventoryCopies:${invCopies} activeListings:${listings.length})`);

  await c.close();
});

scenario('race: marketList racing claimVipRewards (listing first) cannot duplicate the item', async () => {
  // The mirror ordering of the scenario above: marketList's own removal runs
  // BEFORE claimVipRewards clones the inventory, but claimVipRewards' commit
  // (delayed here) still lands after it. Proves the fix holds regardless of
  // which one started first — what matters is that marketList now holds
  // _itemOpBusy for its own critical section too, so claimVipRewards' entry
  // check refuses it instead of cloning a soon-to-be-stale snapshot.
  const c = await connectWithSaved('harness_race_marketlist_vip', {
    vipLevel: 1, inventory: [{ id: 'uq_sword_l', enhance: 0 }],
    vipPending: [1],
  });
  await enterWorld(c, 'deathknight');

  const Player = require('../server/models/Player');
  await _withDbDelay(Player, 'updateOne', 80, async () => {
    const listedP = c.wait('marketListed', { timeout: 8000 }).catch(() => null);
    const listErrP = c.wait('marketListError', { timeout: 8000 }).catch(() => null);
    c.emit('marketList', { item: { id: 'uq_sword_l', enhance: 0 }, price: 10 });
    await sleep(5);
    const claimedP = c.wait('vipRewardsClaimed', { timeout: 8000 }).catch(() => null);
    c.emit('claimVipRewards');
    await Promise.race([listedP, listErrP]);
    await claimedP;
  });
  await sleep(300);

  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  const listings = memory.__dump('MarketListing')
    .filter(l => l.sellerUsername === c.auth.username && l.status === 'active');
  const invCopies = (row.savedData.inventory || []).filter(i => i && i.id === 'uq_sword_l').length;
  eq(invCopies + listings.length, 1,
    `exactly one copy of the sword survives the race (inventoryCopies:${invCopies} activeListings:${listings.length})`);

  await c.close();
});

scenario('race: a reconnect during marketList cannot leave the item listed AND in the inventory', async () => {
  // marketList holds _lastStats.inventory across two awaits (countDocuments,
  // then create) and only removes the item once they resolve. Every other
  // item handler re-checks activeSessions after its awaits — marketCancel,
  // marketBuy, craftGear, gramShopBuy — because a reconnect in that window
  // orphans this closure's _lastStats. marketList was the one that did not,
  // and it is the direction that DUPLICATES rather than loses: the removal
  // lands in an inventory no client can see, the listing goes live anyway,
  // and the reconnected session's next save writes its own inventory — item
  // still in it — back over the removal. The lot then sells and the seller
  // keeps the item and the GRAM both. Reported as "выставил книгу на маркет,
  // она продалась, а книга вернулась в инвентарь, и GRAM с продажи остались".
  const seller = await connectWithSaved('harness_race_marketlist_recon', {
    vipLevel: 1, inventory: [{ id: 'book_lev_Q', qty: 3 }],
  });
  await enterWorld(seller, 'lev');

  const MarketListing = require('../server/models/MarketListing');
  let live = null;
  await _withDbDelay(MarketListing, 'create', 400, async () => {
    const listedP = seller.wait('marketListed', { timeout: 8000 }).catch(() => null);
    const errP    = seller.wait('marketListError', { timeout: 8000 }).catch(() => null);
    seller.emit('marketList', { item: { id: 'book_lev_Q', qty: 1 }, price: 1 });
    // The phone backgrounds, the WebView blips: socket.io reconnects and the
    // client logs in again while create() is still in flight. That login
    // kicks this socket and re-reads the account from the database — with
    // the book still in it, since the removal has not run yet.
    await sleep(30);
    live = await connectAs('harness_race_marketlist_recon');
    await enterWorld(live, 'lev');
    await Promise.race([listedP, errP]);
  });
  await sleep(300);

  // The live session goes on playing and saves, as the real client does —
  // this is the write that used to make the duplicate permanent.
  live.emit('saveProgress', { stats: {
    type: 'lev', floor: 1, hp: 100, maxHp: 100, kills: 0, lang: 'ru', savedAt: Date.now(),
  } });
  await sleep(3500);
  await live.close();
  await sleep(600);

  const row = memory.__dump('Player').find(p => p.username === seller.auth.username);
  const held = (row.savedData.inventory || [])
    .filter(i => i && i.id === 'book_lev_Q').reduce((s, i) => s + (i.qty || 1), 0);
  const lots = memory.__dump('MarketListing')
    .filter(x => x.sellerUsername === seller.auth.username && x.status === 'active').length;
  eq(held + lots, 3, `all 3 books exist exactly once (inventory:${held} activeListings:${lots})`);
  await seller.close();
});

scenario('race: marketList with no session left to take the item from drops the lot', async () => {
  // Same race as above with nobody to delegate to — the account reconnected
  // (or simply went away) and there is no live socket at all when create()
  // resolves. Listing an item that was never actually taken off the account
  // is the duplication; dropping the lot costs the player only the request,
  // since the book is untouched and can be listed again.
  const seller = await connectWithSaved('harness_race_marketlist_gone', {
    vipLevel: 1, inventory: [{ id: 'book_lev_W', qty: 2 }],
  });
  await enterWorld(seller, 'lev');

  const MarketListing = require('../server/models/MarketListing');
  await _withDbDelay(MarketListing, 'create', 400, async () => {
    seller.emit('marketList', { item: { id: 'book_lev_W', qty: 1 }, price: 1 });
    await sleep(30);
    await seller.close();          // the app is closed mid-request
    await sleep(500);
  });
  await sleep(400);

  const row = memory.__dump('Player').find(p => p.username === seller.auth.username);
  const held = (row.savedData.inventory || [])
    .filter(i => i && i.id === 'book_lev_W').reduce((s, i) => s + (i.qty || 1), 0);
  const lots = memory.__dump('MarketListing')
    .filter(x => x.sellerUsername === seller.auth.username && x.status === 'active').length;
  eq(held + lots, 2, `both books exist exactly once (inventory:${held} activeListings:${lots})`);
  eq(lots, 0, 'the lot was dropped rather than left for sale over an item still in the inventory');
});

scenario('market: listing an item and reading my lots back', async () => {
  // VIP 1 is the gate on selling; the item has to be in the SERVER's inventory.
  const c = await connectWithSaved('harness_market', {
    vipLevel: 1, inventory: [{ id: 'uq_sword_l', enhance: 0 }],
  });
  await enterWorld(c, 'deathknight');

  const listed = c.wait('marketListed', { timeout: 8000 }).catch(() => null);
  const err    = c.wait('marketListError', { timeout: 8000 }).catch(() => null);
  const inv    = c.wait('inventorySync', { timeout: 8000 }).catch(() => null);
  c.emit('marketList', { item: { id: 'uq_sword_l', enhance: 0 }, price: 10 });
  const got = await Promise.race([listed, err]);
  ok(got && got.listing, `the listing was created${got && got.msg ? ' — refused: ' + got.msg : ''}`);
  const iv = await inv;
  eq(iv && iv.inventory.length, 0, 'and the item left the server inventory');

  // The tab that is reported as stuck on "loading".
  const mine = c.wait('marketMyListingsData', { timeout: 8000 }).catch(() => null);
  c.emit('marketMyListings', {});
  const rows = await mine;
  ok(rows, 'marketMyListingsData came back at all');
  eq(rows && rows.listings && rows.listings.length, 1, 'and carried the lot');
  await c.close();
});

scenario('market: cancelling a lot returns the item', async () => {
  const c = await connectWithSaved('harness_marketcancel', {
    vipLevel: 1, inventory: [{ id: 'uq_bow_l', enhance: 0 }],
  });
  await enterWorld(c, 'ranger');
  const listed = c.wait('marketListed', { timeout: 8000 }).catch(() => null);
  c.emit('marketList', { item: { id: 'uq_bow_l', enhance: 0 }, price: 10 });
  const l = await listed;
  ok(l && l.listing, 'listed');
  if (!l || !l.listing) return c.close();
  const back = c.wait('inventorySync', { timeout: 8000 }).catch(() => null);
  c.emit('marketCancel', { listingId: l.listing.id });
  const iv = await back;
  eq(iv && iv.inventory.length, 1, 'the item came back to the inventory');
  await c.close();
});

scenario('market: a regular seller is capped at 5 active listings, VIP 3+ is not', async () => {
  // Seeded directly rather than listed one at a time — marketList's own
  // MARKET_LIST_COOLDOWN_MS (3s) would make 5-6 real listings slow, and the
  // cap itself is just a countDocuments comparison, so pre-existing rows are
  // exactly as good a fixture as ones this session created.
  const MarketListing = require('../server/models/MarketListing');
  async function seedActive(telegramId, username, n) {
    for (let i = 0; i < n; i++) {
      await MarketListing.create({
        sellerId: telegramId, sellerUsername: username,
        item: { id: 'rece', qty: 1 }, price: 1, status: 'active',
      });
    }
  }

  const c1 = await connectWithSaved('harness_market_cap5', {
    vipLevel: 1, inventory: [{ id: 'uq_sword_l', enhance: 0 }],
  });
  await enterWorld(c1, 'deathknight');
  const row1 = memory.__dump('Player').find(p => p.username === c1.auth.username);
  await seedActive(row1.telegramId, c1.auth.username, 5);

  const err = c1.wait('marketListError', { timeout: 8000 });
  c1.emit('marketList', { item: { id: 'uq_sword_l', enhance: 0 }, price: 10 });
  const e = await err;
  ok(e && /Максимум 5/.test(e.msg || ''), `a 6th listing is refused below VIP 3 (got: ${e && e.msg})`);
  await c1.close();

  const c2 = await connectWithSaved('harness_market_vip3_cap', {
    vipLevel: 3, inventory: [{ id: 'uq_sword_l', enhance: 0 }],
  });
  await enterWorld(c2, 'deathknight');
  const row2 = memory.__dump('Player').find(p => p.username === c2.auth.username);
  await seedActive(row2.telegramId, c2.auth.username, 5);

  const listed = c2.wait('marketListed', { timeout: 8000 }).catch(() => null);
  const err2 = c2.wait('marketListError', { timeout: 8000 }).catch(() => null);
  c2.emit('marketList', { item: { id: 'uq_sword_l', enhance: 0 }, price: 10 });
  const got = await Promise.race([listed, err2]);
  ok(got && got.listing, `VIP 3 lists a 6th past the 5-listing cap${got && got.msg ? ' — refused: ' + got.msg : ''}`);
  await c2.close();
});

// The in-memory Mongo double (dev/mongo-memory.js) resolves every query
// through a plain Promise with no real I/O behind it — every await in a
// handler settles within the same microtask sweep, all of which drains
// before the event loop looks at the NEXT incoming socket frame. Against a
// real MongoDB (single-digit-to-double-digit milliseconds per round trip)
// that gap is wide open; against the double it's sub-microsecond, too narrow
// for a second client message to land inside no matter how fast it's sent.
// These two races specifically need that gap to be real, so they patch the
// one model call the vulnerable handler awaits to actually take a few
// milliseconds — not to mock server logic (nothing about the handler changes),
// only to give the double the same round-trip shape a production database
// already has. Restored in a `finally` so no later scenario inherits it.
async function _withDbDelay(Model, method, ms, fn) {
  const orig = Model[method].bind(Model);
  Model[method] = async (...args) => { await sleep(ms); return orig(...args); };
  try { await fn(); } finally { Model[method] = orig; }
}

scenario('race: marketList racing equipItem cannot duplicate the item', async () => {
  // marketList re-verifies ownership, then awaits MarketListingModel.create()
  // — a real yield point — and only removes the item from inventory AFTER
  // that resolves. equipItem is fully synchronous: fired into that gap it
  // moves the sword out of plain inventory and into the equipment slot
  // before marketList's own removal runs. The bug this proves fixed: that
  // removal used to fire-and-forget (_invRemove's return value discarded),
  // so it silently found nothing and did nothing — the listing went live
  // for a sword that was ALSO still equipped and usable. The fix checks
  // _invRemove's result and unwinds (deletes) the listing when it fails.
  const c = await connectWithSaved('harness_race_market_equip', {
    vipLevel: 1, inventory: [{ id: 'uq_sword_l', enhance: 0 }],
  });
  await enterWorld(c, 'deathknight');

  const MarketListing = require('../server/models/MarketListing');
  await _withDbDelay(MarketListing, 'create', 60, async () => {
    const listedP = c.wait('marketListed', { timeout: 8000 }).catch(() => null);
    const listErrP = c.wait('marketListError', { timeout: 8000 }).catch(() => null);
    c.emit('marketList', { item: { id: 'uq_sword_l', enhance: 0 }, price: 10 });
    // Sent right as marketList's create() is in flight — see _withDbDelay.
    await sleep(20);
    c.emit('equipItem', { idx: 0 });
    await Promise.race([listedP, listErrP]);
  });
  await sleep(200); // let any trailing inventorySync settle

  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  const listings = memory.__dump('MarketListing')
    .filter(l => l.sellerUsername === c.auth.username && l.status === 'active');
  const invHasSword = (row.savedData.inventory || []).some(i => i && i.id === 'uq_sword_l');
  const eqHasSword = !!(row.savedData.equipment && row.savedData.equipment.weapon
    && row.savedData.equipment.weapon.id === 'uq_sword_l');
  const copies = (invHasSword ? 1 : 0) + (eqHasSword ? 1 : 0) + listings.length;
  eq(copies, 1,
    `exactly one copy of the sword survives the race (inventory:${invHasSword} equipped:${eqHasSword} activeListings:${listings.length})`);

  await c.close();
});

scenario('race: a cross-session market item arriving mid-purchase survives it', async () => {
  // _grantMarketItem is how a cancelled/bought lot reaches an account whose
  // live socket is a different one from the handler that is running. It is a
  // pure addition into the live inventory, so a clone-holder's stale stamp
  // erased it outright — the lot was gone AND the item never arrived, which
  // is the worst of the two outcomes. The replay queue (_pendingOobGrants)
  // pours it back into the snapshot instead of refusing, because there is
  // nowhere to retry a cancellation from once the listing is closed.
  const seller = await connectWithSaved('harness_oob_market_seller', {
    vipLevel: 1, inventory: [{ id: 'uq_sword_l', enhance: 4 }], vipPending: [1],
  });
  await enterWorld(seller, 'deathknight');

  const listed = seller.wait('marketListed', { timeout: 8000 }).catch(() => null);
  seller.emit('marketList', { item: { id: 'uq_sword_l', enhance: 4 }, price: 10 });
  const l = await listed;
  ok(l && l.listing, 'the sword is listed to begin with');
  if (!l || !l.listing) return seller.close();

  const Player = require('../server/models/Player');
  await _withDbDelay(Player, 'updateOne', 120, async () => {
    const claimedP = seller.wait('vipRewardsClaimed', { timeout: 8000 }).catch(() => null);
    seller.emit('claimVipRewards');
    await sleep(25);
    const backP = seller.wait('marketCancelled', { timeout: 8000 }).catch(() => null);
    const errP = seller.wait('marketError', { timeout: 8000 }).catch(() => null);
    seller.emit('marketCancel', { listingId: l.listing.id });
    await Promise.race([backP, errP]);
    await claimedP;
  });
  await sleep(400);

  const row = memory.__dump('Player').find(p => p.username === seller.auth.username);
  const live = memory.__dump('MarketListing')
    .filter(x => x.sellerUsername === seller.auth.username && x.status === 'active');
  const held = (row.savedData.inventory || []).filter(i => i && i.id === 'uq_sword_l').length;
  eq(held + live.length, 1,
    `the sword exists exactly once — never in limbo (inventory:${held} activeListings:${live.length})`);

  await seller.close();
});

scenario('race: a grant landing during a shop purchase is not erased by its stale commit', async () => {
  // Every cross-socket/out-of-band item grant — _grantKillLoot (the mob loot
  // table, fired on every single kill), _applyGrant (death-battle and Tower
  // rewards), _grantMarketItem, _applyCraftResult, _adminApplyItems — writes
  // straight into the LIVE inventory and commits, with no _itemsBusy guard.
  // A claimVipRewards/gramShopBuy clone taken before one of them stamps the
  // grant away on commit: the player is told "+1×" (or the admin is told the
  // gift landed) and nothing arrives.
  //
  // Driven here through the admin item-edit endpoint, which goes through the
  // very same _adminApplyItems -> _commitServerItems path the loot grant uses
  // and is the one reachable from a test without a live mob.
  const c = await connectWithSaved('harness_race_grant_shop', {
    inventory: [], vipPending: [1],
  });
  await enterWorld(c, 'deathknight');

  const loginRes = await fetch(`${BASE}/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  const { token } = await loginRes.json();
  const tid = memory.__dump('Player').find(p => p.username === c.auth.username).telegramId;

  const Player = require('../server/models/Player');
  let giveStatus = 0;
  await _withDbDelay(Player, 'updateOne', 120, async () => {
    const claimedP = c.wait('vipRewardsClaimed', { timeout: 8000 }).catch(() => null);
    c.emit('claimVipRewards');
    // Sent right as claimVipRewards' updateOne is in flight — see _withDbDelay.
    await sleep(25);
    const giveRes = await fetch(`${BASE}/admin/player/${tid}/items`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'add', itemId: 'norm_stone', qty: 3 }),
    });
    giveStatus = giveRes.status;
    await claimedP;
  });
  await sleep(400);

  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  const stones = (row.savedData.inventory || [])
    .reduce((s, i) => s + (i && i.id === 'norm_stone' ? (i.qty || 1) : 0), 0);
  if (giveStatus === 200) {
    eq(stones, 3, 'a grant the server reported as applied really survived the purchase commit');
  } else {
    eq(stones, 0, 'a grant the server refused was not half-applied either');
  }

  await c.close();
});

scenario('race: claimVipRewards racing openLootBox neither duplicates the box nor eats the prize', async () => {
  // openLootBox is synchronous and mutates the LIVE inventory twice: it spends
  // the box (splice/qty--) and adds whatever the roll won. Every other
  // synchronous item handler defers to _itemOpBusy for exactly this reason —
  // openLootBox was the one that never got the check. With claimVipRewards
  // holding a clone taken before the open, its delayed commit stamps that
  // clone back: the box returns (openable again, and again) and the prize the
  // roll already announced to the client is gone. A duplicated box AND a lost
  // item out of one race.
  const c = await connectWithSaved('harness_race_vip_box', {
    inventory: [{ id: 'box_rare', qty: 1 }],
    vipPending: [1],
  });
  await enterWorld(c, 'deathknight');

  const Player = require('../server/models/Player');
  await _withDbDelay(Player, 'updateOne', 60, async () => {
    const claimedP = c.wait('vipRewardsClaimed', { timeout: 8000 }).catch(() => null);
    c.emit('claimVipRewards');
    // Sent right as claimVipRewards' updateOne is in flight — see _withDbDelay.
    await sleep(20);
    const openedP = c.wait('boxOpened', { timeout: 8000 }).catch(() => null);
    const boxErrP = c.wait('openBoxError', { timeout: 8000 }).catch(() => null);
    c.emit('openLootBox', { id: 'box_rare' });
    const opened = await Promise.race([openedP, boxErrP]);
    await claimedP;
    // If the open was refused (the fix), the box must still be there to retry.
    // If it went through, its prize must have survived the claim's commit.
    c._openResult = opened;
  });
  await sleep(300);

  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  const inv = row.savedData.inventory || [];
  const boxes = inv.reduce((s, i) => s + (i && i.id === 'box_rare' ? (i.qty || 1) : 0), 0);
  const res = c._openResult;
  if (res && res.boxId) {
    // The open was served: the box is spent and the prize is really in stock.
    eq(boxes, 0, 'the opened box was really spent, not restored by the stale commit');
    ok(!res.item || inv.some(i => i && i.id === res.item.id),
      `the prize the server announced (${res.item ? res.item.id : 'none'}) is actually in the inventory`);
  } else {
    // The open was refused: nothing was consumed, so the box survives intact.
    eq(boxes, 1, 'a refused open leaves the box untouched so it can be retried');
  }

  await c.close();
});

scenario('race: claimVipRewards racing equipItem cannot duplicate or lose the item', async () => {
  // claimVipRewards clones _lastStats.inventory before its DB awaits
  // (findById, updateOne) and commits that clone wholesale at the end via
  // _commitServerItems(inv, null, ...) — which does _lastStats.inventory =
  // inv unconditionally. equipItem is synchronous: fired into that window it
  // moves an item out of the LIVE inventory and into the equipment slot —
  // but the clone still has it, since it was taken before the equip ran. The
  // bug this proves fixed: claimVipRewards' stale-clone commit used to stamp
  // that clone back over the live array, resurrecting the sword in inventory
  // even though it was ALSO now equipped. The fix gates equipItem (and every
  // other synchronous inventory handler) behind _itemOpBusy, which
  // claimVipRewards already raises for the duration of its own await window.
  const c = await connectWithSaved('harness_race_vip_equip', {
    inventory: [{ id: 'uq_sword_l', enhance: 0 }],
    vipPending: [1],
  });
  await enterWorld(c, 'deathknight');

  // Delaying findById (the FIRST await) is too early: the vulnerable
  // inventory snapshot (_liveInventory()) isn't taken until AFTER it
  // resolves, so an equip landing during that particular wait is captured
  // correctly, not lost. The real window is between that snapshot and the
  // handler's LAST await — the same-session PlayerModel.updateOne that
  // commits the snapshot — so that's the one this delays.
  const Player = require('../server/models/Player');
  await _withDbDelay(Player, 'updateOne', 60, async () => {
    const claimedP = c.wait('vipRewardsClaimed', { timeout: 8000 }).catch(() => null);
    c.emit('claimVipRewards');
    // Sent right as claimVipRewards' updateOne is in flight — see _withDbDelay.
    await sleep(20);
    c.emit('equipItem', { idx: 0 });
    await claimedP;
  });
  await sleep(200);

  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  const invCopies = (row.savedData.inventory || []).filter(i => i && i.id === 'uq_sword_l').length;
  const eqHasSword = !!(row.savedData.equipment && row.savedData.equipment.weapon
    && row.savedData.equipment.weapon.id === 'uq_sword_l');
  eq(invCopies + (eqHasSword ? 1 : 0), 1,
    `the original sword survives exactly once (inventoryCopies:${invCopies} equipped:${eqHasSword})`);

  await c.close();
});

scenario('race: spendUpgrade cannot exceed the skill point budget by racing two keys', async () => {
  // Budget/gold were read from _lastStats, then _serverSpendGold was
  // awaited, and only THEN was upgrades[key] written off a `lvl` captured
  // before that await — with nothing serializing two spendUpgrade calls
  // against each other. Racing two DIFFERENT keys let both read the same
  // pre-write "spent" total and both pass the same one-point-left budget
  // check, so both committed — one point over budget, for free. The fix
  // wraps the whole handler in _withEconLock so only one can run at a time.
  //
  // lvl 1 with no rebirths gives a tiny, known budget (skillPointBudget) —
  // seeded with gold to spare so only the point budget, not gold, gates this.
  const c = await connectWithSaved('harness_race_upgrade_budget', {
    lvl: 1, gold: 1_000_000, upgrades: {},
  });
  await enterWorld(c, 'ranger');

  const budget = require('../shared/definitions').skillPointBudget(1, 0);
  if (budget < 1) {
    // Nothing to prove at budget 0 — a fresh level-1 account with no rebirth
    // bonus may simply have none to spend yet. A SKIP, not a pass: the race
    // this scenario exists for was never run, and counting it as a success
    // would say it was.
    skip('level 1 has no skill points to budget-test — the race did NOT run');
    await c.close();
    return;
  }
  // Spend the budget down to exactly one point left, sequentially (each one
  // awaited), so what's left is deterministic before the race below.
  const keys = require('../shared/definitions').UPGRADE_KEYS;
  for (let i = 0; i < budget - 1; i++) {
    const sync = c.wait('progressSync', { timeout: 5000 });
    c.emit('spendUpgrade', { key: keys[0] });
    await sync;
  }

  // Exactly one point of budget left. Race it across two DIFFERENT keys —
  // the bug is specifically a cross-key bypass (same-key racing just
  // double-charges gold for one committed level, which _withEconLock closes
  // too, but this is the one that lets a player exceed their true budget).
  const p1 = c.wait('progressSync', { timeout: 8000 }).catch(() => null);
  c.emit('spendUpgrade', { key: keys[0] });
  c.emit('spendUpgrade', { key: keys[1] });
  await p1;
  await sleep(400);

  const after = memory.__dump('Player').find(p => p.username === c.auth.username);
  const spentAfter = Object.values(after.savedData.upgrades || {})
    .reduce((s, v) => s + (Number(v) || 0), 0);
  ok(spentAfter <= budget,
    `total spent upgrade points (${spentAfter}) never exceeds the real budget (${budget})`);

  await c.close();
});

scenario('market: buying a lot pays the seller', async () => {
  // MARKET_FEE_PCT used to be undefined here (exported from inventory.js but
  // never imported into index.js): price * (1 - undefined) is NaN, and
  // _incBalance refuses a non-finite delta outright, so the seller's payout
  // silently never happened while the buyer still paid and got the item.
  const seller = await connectWithSaved('harness_market_seller', {
    vipLevel: 1, gramBalance: 0, inventory: [{ id: 'uq_sword_l', enhance: 0 }],
  });
  await enterWorld(seller, 'deathknight');
  const listed = seller.wait('marketListed', { timeout: 8000 });
  seller.emit('marketList', { item: { id: 'uq_sword_l', enhance: 0 }, price: 10 });
  const l = await listed;
  ok(l && l.listing, 'listing created');
  if (!l || !l.listing) return seller.close();

  const buyer = await connectWithSaved('harness_market_buyer', { gramBalance: 100 });
  await enterWorld(buyer, 'ranger');

  const sellerCredit = seller.wait('gramBalanceUpdate', { timeout: 8000 });
  const bought = buyer.wait('marketBought', { timeout: 8000 });
  buyer.emit('marketBuy', { listingId: l.listing.id });
  const bo = await bought;
  ok(bo && bo.delivered !== false, 'buyer received the item');

  const credit = await sellerCredit;
  eq(credit.balance, 9, 'seller was credited price minus the 10% fee');

  await seller.close();
  await buyer.close();
});

scenario('rebirth: every 5th rebirth really costs double, proven across a live run through two boundaries', async () => {
  // rebirthCostFor(rebirths) — shared/definitions.js. `rebirths` passed in is
  // the count BEFORE the rebirth about to happen, so (rebirths+1) is the
  // rebirth number that is about to land; that number being a multiple of 5
  // is what doubles the cost. This used to be reported as "not working" in
  // practice, so rather than only checking one isolated boundary, this drives
  // ONE account through seven REAL, consecutive rebirths (the 4th through the
  // 10th — crossing both the 5th and 10th boundaries) with a real reconnect
  // between each, and checks the exact quantity actually deducted every time.
  const normal = { box_uncommon: 10, box_rare: 5, rece: 100, recl: 30 };
  // 5 normal + 2 doubled rebirths = 9x normal cost, worth of stock up front.
  const stock = Object.fromEntries(Object.entries(normal).map(([id, n]) => [id, n * 9]));

  let c = await connectWithSaved('harness_rebirth_seq', {
    lvl: 30, rebirths: 3,
    inventory: Object.entries(stock).map(([id, qty]) => ({ id, qty })),
  });
  await enterWorld(c, 'lev');
  const Player = require('../server/models/Player');
  const countOf = (inv, id) => inv.reduce((s, i) => s + (i && i.id === id ? (i.qty || 1) : 0), 0);

  let prevCounts = { ...stock };
  for (const before of [3, 4, 5, 6, 7, 8, 9]) { // -> becomes rebirth #4..#10
    const rebirthN = before + 1;
    const expectDouble = rebirthN % 5 === 0;

    const sync = c.wait('inventorySync', { timeout: 5000 });
    const done = c.wait('rebirthDone', { timeout: 5000 });
    const err  = c.wait('rebirthError', { timeout: 5000 }).catch(() => null);
    c.emit('rebirth');
    const res = await Promise.race([done, err]);
    ok(res && !res.msg, `rebirth #${rebirthN} succeeded`, res && res.msg);
    eq(res && res.rebirths, rebirthN, `and the server now counts it as rebirth #${rebirthN}`);

    const inv = await sync;
    const newCounts = {};
    for (const id of Object.keys(normal)) {
      newCounts[id] = countOf(inv.inventory, id);
      const spent = prevCounts[id] - newCounts[id];
      const want = normal[id] * (expectDouble ? 2 : 1);
      eq(spent, want, `rebirth #${rebirthN} (${expectDouble ? 'DOUBLED' : 'normal'}) spent ${want} × ${id}, not ${normal[id] * (expectDouble ? 1 : 2)}`);
    }
    prevCounts = newCounts;

    // Rebirth resets level to 1; bump it back to REBIRTH_LEVEL through a real
    // reconnect (not just in-memory) so the next iteration reloads `rebirths`
    // from the DB exactly the way a real returning player would — which is
    // the path a stale/mistyped stored value would have broken.
    await c.close();
    await sleep(300);
    const row = memory.__dump('Player').find(p => p.username === c.auth.username);
    await Player.updateOne({ _id: row._id }, { $set: { 'savedData.lvl': 30 } });
    await sleep(80);
    c = await connectAs('harness_rebirth_seq');
    await enterWorld(c, 'lev');
  }
  await c.close();
});

scenario('reconnect: bonusSP/rebirths/upgrades survive it', async () => {
  // A reconnect's selectChar sends _buildSaveStats() (js/network.js), which
  // never carries lvl/bonusSP/rebirths/upgrades at all — only type, floor,
  // hp/maxHp, kills, potion/buff prefs and lang. The level/XP-become-
  // server-owned change pinned lvl/xp back from the stored record on every
  // selectChar, but left bonusSP/rebirths/upgrades to fall through from
  // that bare blob — so a reconnect zeroed them in memory, and the very next
  // periodic autosave wrote the zero over the real stored totals for good.
  // lvl 35 (past REBIRTH_LEVEL=30) so a rebirth's budget isn't zeroed
  // (skillPointBudget returns 0 below REBIRTH_LEVEL once rebirths > 0).
  const c1 = await connectWithSaved('harness_reconnect_sp', {
    lvl: 35, bonusSP: 15, rebirths: 2, upgrades: { atk: 30 },
  });
  await enterWorld(c1, 'lev');
  await c1.close();
  await sleep(500);

  const c2 = await connectAs('harness_reconnect_sp');
  const sync = c2.wait('progressSync', { timeout: 8000 });
  // The exact shape _buildSaveStats() sends on a real reconnect.
  c2.emit('selectChar', { type: 'lev', savedStats: {
    type: 'lev', floor: 1, hp: 100, maxHp: 100, kills: 0,
    hudPotion: 'pt1', autoHpPct: 0.5, autoBuffTypes: {}, lang: 'ru', savedAt: Date.now(),
  } });
  const ps = await sync;
  eq(ps.upgrades && ps.upgrades.atk, 30, 'progressSync still carries the real upgrades');

  // The periodic autosave the real client fires every few seconds off the
  // same bare _buildSaveStats() shape — this is the write that would make a
  // reconnect's in-memory zeroing permanent.
  c2.emit('saveProgress', { stats: {
    type: 'lev', floor: 1, hp: 100, maxHp: 100, kills: 0,
    hudPotion: 'pt1', autoHpPct: 0.5, autoBuffTypes: {}, lang: 'ru', savedAt: Date.now(),
  } });
  await sleep(3400); // let the debounced write land
  const row = memory.__dump('Player').find(p => p.username === c2.auth.username);
  eq(row.savedData.bonusSP, 15, 'bonusSP was not zeroed by the autosave');
  eq(row.savedData.rebirths, 2, 'rebirths was not zeroed by the autosave');
  eq(row.savedData.upgrades && row.savedData.upgrades.atk, 30, 'upgrades was not zeroed by the autosave');
  await c2.close();
});

scenario('reconnect: potionBag/buffs/specialQuestsDone survive it', async () => {
  // Same failure shape as the bonusSP/rebirths/upgrades bug above, just for
  // fields that were missed when that fix went in: _buildSaveStats()
  // (js/network.js) never carries potionBag, buffs or specialQuestsDone at
  // all, so a reconnect's bare selectChar blob sanitizes down to an empty
  // bag/no buffs/no-quests-done — and the very
  // next periodic autosave (which pins these straight from _lastStats) wrote
  // that wipe over the real stored values for good. This is what made HP
  // potions "randomly disappear": any ordinary reconnect (a backgrounded
  // mobile tab, a brief network drop) was enough to zero the bag.
  const c1 = await connectWithSaved('harness_reconnect_potions', {
    lvl: 10, potionBag: { pt1: 12, pt2: 3 }, buffs: { gold: 3600 },
    specialQuestsDone: ['welcome'],
  });
  await enterWorld(c1, 'ranger');
  await c1.close();
  await sleep(500);

  const c2 = await connectAs('harness_reconnect_potions');
  const sync = c2.wait('potionBag', { timeout: 8000 });
  // The exact shape _buildSaveStats() sends on a real reconnect — no
  // potionBag/buffs/specialQuestsDone field at all.
  c2.emit('selectChar', { type: 'ranger', savedStats: {
    type: 'ranger', floor: 1, hp: 100, maxHp: 100, kills: 0,
    hudPotion: 'pt1', autoHpPct: 0.5, autoBuffTypes: {}, lang: 'ru', savedAt: Date.now(),
  } });
  const bagSync = await sync;
  eq(bagSync.potionBag && bagSync.potionBag.pt1, 12, 'the reconnect is told its real bag right away, not zero');

  // The periodic autosave the real client fires every few seconds off the
  // same bare _buildSaveStats() shape — this is the write that would make a
  // reconnect's in-memory wipe permanent.
  c2.emit('saveProgress', { stats: {
    type: 'ranger', floor: 1, hp: 100, maxHp: 100, kills: 0,
    hudPotion: 'pt1', autoHpPct: 0.5, autoBuffTypes: {}, lang: 'ru', savedAt: Date.now(),
  } });
  await sleep(3400); // let the debounced write land
  const row = memory.__dump('Player').find(p => p.username === c2.auth.username);
  eq(row.savedData.potionBag && row.savedData.potionBag.pt1, 12, 'potionBag.pt1 was not zeroed by the autosave');
  eq(row.savedData.potionBag && row.savedData.potionBag.pt2, 3, 'potionBag.pt2 was not zeroed by the autosave');
  eq(row.savedData.buffs && row.savedData.buffs.gold, 3600, 'buffs was not wiped by the autosave');
  ok((row.savedData.specialQuestsDone || []).includes('welcome'), 'specialQuestsDone was not wiped by the autosave');
  await c2.close();
});

scenario('hp: a save cannot hand the player health', async () => {
  const c = await connectWithSaved('harness_hp', { lvl: 1, hp: 5 });
  await enterWorld(c, 'lev');
  c.emit('saveProgress', { stats: {
    type: 'lev', hp: 99999, maxHp: 99999, kills: 0, savedAt: Date.now(),
  } });
  await sleep(3400);
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  ok(row.savedData.hp < 99999, `the stored hp is the server's (${row.savedData.hp})`);
  await c.close();
});

scenario('hp: reconnecting does not full-heal', async () => {
  // setPlayerChar seats the character at the hp selectChar was given, so
  // accepting it from the client meant a free full heal on demand — reconnect
  // with hp at maximum, mid-boss or mid-PvP, and walk away topped up.
  const c = await connectWithSaved('harness_hpheal', { lvl: 1, hp: 7, maxHp: 260 });
  await enterWorld(c, 'lev');
  await c.close();
  await sleep(500);
  const c2 = await connectAs('harness_hpheal');
  await enterWorld(c2, 'lev', { type: 'lev', hp: 99999, maxHp: 99999, savedAt: Date.now() });
  await sleep(300);
  const row = memory.__dump('Player').find(p => p.username === c2.auth.username);
  ok(row.savedData.hp < 100, `the character resumed on its stored hp (${row.savedData.hp})`);
  await c2.close();
});

scenario('handlers: none of the 115 throws on a bare request', async () => {
  // The check the two missing-import regressions needed, and the reason a
  // scenario per handler is not the answer: there are 115 of them and the
  // scenarios cover 17.
  //
  // Both regressions were a symbol moved out of server/index.js with the uses
  // left behind. Neither is a syntax error — a reference that never executes is
  // not one — so they surfaced only when a handler ran. This runs all of them:
  // every safeOn event is emitted once with an empty payload, and the
  // handler-error watch above turns any ReferenceError into a failure.
  //
  // Most will refuse the request on validation, which is the point: a missing
  // constant is usually read BEFORE the payload is looked at (a rate-limit
  // window, a price ceiling, a cap), so an empty payload is enough to find it.
  // What this deliberately does NOT check is that a handler does its job — the
  // scenarios above are for that.
  const fs = require('fs');
  // index.js plus every per-domain handler module: most safeOn registrations
  // live in server/handlers/*.js now, and reading only index.js would quietly
  // shrink this sweep to the handful still registered there — exactly the kind
  // of silent loss of coverage this scenario exists to prevent.
  const handlerDir = path.join(ROOT, 'server', 'handlers');
  const src = [
    fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8'),
    ...fs.readdirSync(handlerDir).filter(f => f.endsWith('.js'))
      .map(f => fs.readFileSync(path.join(handlerDir, f), 'utf8')),
  ].join('\n');
  const events = [...new Set([...src.matchAll(/safeOn\('([a-zA-Z0-9_]+)'/g)].map(m => m[1]))]
    // Skip the ones that would end the session out from under the sweep.
    .filter(e => !['disconnect', 'loginTelegram', 'loginTelegramWebApp'].includes(e));
  ok(events.length > 100, `found ${events.length} handlers to sweep`);

  const c = await connectWithSaved('harness_sweep', { vipLevel: 1, gold: 100, inventory: [] });
  await enterWorld(c, 'mage');
  const before = handlerErrors.length;
  for (const ev of events) { c.emit(ev, {}); await sleep(12); }
  await sleep(1200);   // let the async ones settle
  const thrown = handlerErrors.slice(before);
  ok(thrown.length === 0, `no handler threw on an empty payload (${thrown.length} did)`,
     [...new Set(thrown)].slice(0, 10).join(' | '));
  await c.close();
});

scenario('exposure: the repository is not served as static files', async () => {
  // express.static was mounted on the project root, which published every file
  // in it: server/index.js and server/security.js in full, the models, the
  // audit documents, and /.git — from which the whole history, and anything
  // ever committed to it, can be reconstructed. It was the default that came
  // with pointing it at '..', and nothing about the game needed any of it.
  const leaky = ['/server/index.js', '/server/security.js', '/server/anticheat.js',
                 '/server/models/Player.js', '/shared/definitions.js', '/dev/harness.js',
                 '/package.json', '/package-lock.json', '/.git/config', '/.git/HEAD',
                 '/AUDIT.md', '/SCALING.md', '/dev/seed.js'];
  for (const p of leaky) {
    const r = await fetch(BASE + p).catch(() => ({ status: 599 }));
    ok(r.status !== 200, `not public: ${p}`, `served with ${r.status}`);
  }
  // And the things that must stay public still are.
  for (const p of ['/', '/index.html', '/guide.html', '/admin.html', '/css/style.css',
                   '/bundle.js', '/tonconnect-manifest.json', '/js/pixi.min.js']) {
    const r = await fetch(BASE + p).catch(() => ({ status: 599 }));
    eq(r.status, 200, `still public: ${p}`);
  }
});

scenario('potions: buying adds them and persists', async () => {
  const c = await connectWithSaved('harness_potbuy', { gold: 100, potionBag: {} });
  await enterWorld(c, 'mage');
  const gold = c.wait('goldSync', { timeout: 6000 }).catch(() => null);
  const bag  = c.wait('potionBag', { timeout: 6000 }).catch(() => null);
  c.emit('buyPotion', { idx: 0, qty: 4 });     // pt1, 5 gold each
  const g = await gold, b = await bag;
  eq(g && g.gold, 80, 'gold went down by the price');
  eq(b && b.potionBag && b.potionBag.pt1, 4, 'and the potions came back in the same round trip');
  ok(b && b.bought && b.bought.n === 4, 'with what was bought, for the confirmation line');
  await sleep(200);
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  eq(row.savedData.potionBag && row.savedData.potionBag.pt1, 4, 'and both were persisted');
  eq(row.savedData.gold, 80, 'gold too');
  await c.close();
});

scenario('potions: drinking one is persisted, not just decremented in memory', async () => {
  // It used to ride "the normal progress save", which stopped carrying
  // potionBag the moment that field was pinned — so a drunk potion came back
  // on the next reconnect.
  const c = await connectWithSaved('harness_potuse', { potionBag: { pt1: 3 }, hp: 10, maxHp: 260, lvl: 1 });
  await enterWorld(c, 'lev');
  const bag = c.wait('potionBag', { timeout: 6000 }).catch(() => null);
  c.emit('usePotion', { id: 'pt1' });
  const b = await bag;
  eq(b && b.potionBag && b.potionBag.pt1, 2, 'the server spent one from its own bag');
  await sleep(250);
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  eq(row.savedData.potionBag && row.savedData.potionBag.pt1, 2, 'and wrote it down');
  await c.close();
});

scenario('potions: an empty bag cannot be drunk from', async () => {
  const c = await connectWithSaved('harness_potempty', { potionBag: { pt1: 0 }, hp: 10, maxHp: 260 });
  await enterWorld(c, 'lev');
  const empty = c.wait('potionEmpty', { timeout: 5000 }).catch(() => null);
  c.emit('usePotion', { id: 'pt1' });
  ok(await empty, 'refused');
  await c.close();
});

scenario('build: the launch path is cacheable and the legacy names still answer', async () => {
  const html = await (await fetch(BASE + '/')).text();
  const js  = (html.match(/\/bundle\.[a-f0-9]+\.js/) || [])[0];
  const css = (html.match(/css\/style\.[a-f0-9]+\.css/) || [])[0];
  ok(js,  'index.html points at a content-addressed bundle', html.match(/bundle[^"']*/) || '');
  ok(css, 'and a content-addressed stylesheet');
  if (!js || !css) return;

  // The whole point: these two may be cached forever, so a repeat launch does
  // not go to the network for them at all.
  for (const [p, what] of [[js, 'bundle'], ['/' + css, 'stylesheet']]) {
    const r = await fetch(BASE + p);
    eq(r.status, 200, `the hashed ${what} is served`);
    ok(/immutable/.test(r.headers.get('cache-control') || ''),
       `and may be cached forever`, r.headers.get('cache-control'));
  }
  // index.html itself must never be: it is how a deploy is noticed.
  const idx = await fetch(BASE + '/');
  ok(/no-cache/.test(idx.headers.get('cache-control') || ''),
     'index.html is not cached', idx.headers.get('cache-control'));

  // A page cached from before the change still points at the old names.
  for (const p of ['/bundle.js', '/css/style.css']) {
    eq((await fetch(BASE + p)).status, 200, `the legacy path still answers: ${p}`);
  }

  // Nothing on the launch path comes from a third party any more.
  // Only real script tags count — the markup carries a comment explaining why
  // the CDN was dropped, and matching that would be matching the explanation.
  const tags = [...html.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/g)].map(m => m[1]);
  ok(!tags.some(u => /^https?:\/\/cdn\.socket\.io/.test(u)), 'no script comes from the socket.io CDN', tags.join(' '));
  ok(!tags.some(u => /tonconnect-ui/.test(u)), 'the wallet library is not in the launch path', tags.join(' '));
  ok(/\/socket\.io\/socket\.io\.js/.test(html), 'it is served from our own origin');
  eq((await fetch(BASE + '/js/vendor/tonconnect-ui.min.js')).status, 200,
     'but is still fetchable on demand');
});

// The egress accounting is the thing that answers "why is the hosting bill
// what it is", and it can only answer that if it is measuring the right bytes.
// Two ways it silently stops doing so: the middleware ends up registered AFTER
// compression() (then it counts uncompressed bodies and overstates every text
// response about 3x), and socket.io's encoding changes shape so the event-name
// regex stops matching (then the whole game stream collapses into 'unnamed'
// and there is nothing to act on). Both look fine — numbers still appear.
scenario('egress: the accounting counts wire bytes and names the events', async () => {
  const egress = require('../server/egress');
  const { token } = await fetch(`${BASE}/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  }).then(r => r.json());

  const before = egress.snapshot();

  // A gzip-capable request for something big and compressible.
  const r = await fetch(`${BASE}/js/pixi.min.js`, { headers: { 'accept-encoding': 'gzip' } });
  const decoded = Buffer.from(await r.arrayBuffer()).length;
  eq(r.headers.get('content-encoding'), 'gzip', 'the vendor bundle is served compressed');

  // A player, so the stream is exercised with a real event name.
  const c = await connectAs('egress-meter');
  await enterWorld(c, 'mage');
  await sleep(700);

  const d = egress.diff(before, egress.snapshot());
  const js = d.http.js ? d.http.js.bytes : 0;
  ok(js > 0, 'the JS response landed in the http accounting', JSON.stringify(d.http));
  ok(js < decoded * 0.6,
     `counted compressed bytes, not the decoded body (${Math.round(js / 1024)}K counted vs ` +
     `${Math.round(decoded / 1024)}K decoded)`);

  const names = Object.keys(d.ws);
  ok(names.length > 0, 'the socket stream landed in the ws accounting');
  ok(!names.includes('unnamed'),
     'every packet was attributed to a named event', names.join(' '));
  ok(names.some(n => !n.startsWith('_')),
     'and at least one is a real game event, not just protocol traffic', names.join(' '));

  // And it reaches an operator, which is the only reason any of it exists.
  const h = await fetch(`${BASE}/health`, { headers: { Authorization: `Bearer ${token}` } })
    .then(x => x.json());
  ok(h.egress && h.egress.http && h.egress.ws, '/health carries the breakdown');
  ok('nicTx' in (h.egress || {}),
     'including the interface total the bill is actually computed from');

  c.close();
});

scenario('build: the bundle is minified, mapped, and keeps its HTML entry points', async () => {
  const html = await (await fetch(BASE + '/')).text();
  const jsPath = (html.match(/\/bundle\.[a-f0-9]+\.js/) || [])[0];
  ok(jsPath, 'index.html names the bundle');
  if (!jsPath) return;
  const code = await (await fetch(BASE + jsPath)).text();

  // Minified at all: comments gone, and materially smaller than the sources.
  const fs = require('fs');
  const raw = require('../server/bundle-files')
    .map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n;\n');
  ok(code.length < raw.length * 0.75,
     `smaller than the sources (${Math.round(raw.length / 1024)}K -> ${Math.round(code.length / 1024)}K)`);

  // The names the minifier cannot see: onclick attributes in index.html and
  // handlers built inside JS strings. Renaming any of them breaks silently.
  const fromHtml = [...html.matchAll(/on\w+="\s*([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]);
  const fromStrings = [...raw.matchAll(/onclick=\\?["'`]\s*([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]);
  const entryPoints = [...new Set([...fromHtml, ...fromStrings])];
  ok(entryPoints.length > 10, `found ${entryPoints.length} names reachable only from markup`);
  // Looked for in the bundle AND in index.html's own inline scripts — some
  // handlers (the chat panel) are defined right there beside their markup and
  // never reach the minifier at all, so searching only the bundle reports them
  // as lost when nothing happened to them.
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
  const reachable = code + '\n' + inline;
  const lost = entryPoints.filter(n => !new RegExp('\\b' + n + '\\b').test(reachable));
  ok(lost.length === 0, 'every one of them is still defined somewhere', lost.join(', '));

  // And a stack trace stays readable.
  ok(/sourceMappingURL=\/bundle\.[a-f0-9]+\.js\.map/.test(code), 'the bundle points at a source map');
  const mapRes = await fetch(BASE + jsPath + '.map');
  eq(mapRes.status, 200, 'which is served');
  const map = await mapRes.json();
  ok(Array.isArray(map.sources) && map.sources.length > 0, 'and carries sources');
  ok(typeof map.mappings === 'string' && map.mappings.length > 1000, 'and real mappings');
});

// ── Browser check ────────────────────────────────────────────────────────────
// Everything above talks to the server over a socket. This drives the actual
// client: real Chromium, the real bundle, real WebGL. It is what makes changes
// to the BUILD checkable at all — a server scenario cannot tell you the page
// loaded, and the concatenated-bundle parse check cannot tell you it ran.
//
// The browser Playwright wants and the one this environment ships are
// different builds, so the path is resolved rather than assumed; if neither is
// there the scenario says so instead of failing the run for the wrong reason.
//
// CHROMIUM_PATH FIRST, which is how dev/egress.js has always resolved it. This
// copy did not read it and searched exactly one directory, so every machine
// keeping its browser anywhere else — a developer's laptop, a CI image with
// its own Playwright cache, a container with a system chromium — fell through
// to the skip branch. The skip used to register as a pass, so on all of those
// the nine browser scenarios reported success without a browser ever starting.
// Set but wrong is deliberately NOT silently ignored: launch() then fails and
// names the path, which is a better answer than another quiet skip.
function chromiumPath() {
  const fs = require('fs');
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const roots = ['/opt/pw-browsers'];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const d of fs.readdirSync(root)) {
      const p = path.join(root, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

scenario('browser: the real client loads and reaches the world', async () => {
  const exe = chromiumPath();
  if (!exe) { skip('no chromium in this environment — the browser scenario did NOT run'); return; }
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch { skip('playwright not installed — the browser scenario did NOT run'); return; }

  const browser = await chromium.launch({ executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
    const errors = [], failed = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
    page.on('pageerror', e => errors.push('pageerror: ' + e.message.slice(0, 200)));
    page.on('response', r => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
    page.on('requestfailed', r => failed.push(`${r.failure() && r.failure().errorText} ${r.url()}`));

    // DEV_LOCAL is on in the harness, so /?dev=<name> logs in through the same
    // path the Mini App uses, with locally signed initData.
    await page.goto(`${BASE}/?dev=browsercheck`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(7000);

    // A fresh account lands on character select; pick a class to reach the world.
    // A fresh account lands on the character carousel (#char-select). Picking
    // a class goes through selectChar(), which is what the play button calls.
    const needsClass = await page.evaluate(() => typeof state !== 'undefined' && state === 'select');
    if (needsClass) {
      await page.evaluate(() => selectChar('mage'));
      await page.waitForTimeout(8000);
    }

    const st = await page.evaluate(() => ({
      state: typeof state !== 'undefined' ? state : null,
      hasPlayer: typeof player !== 'undefined' && !!player,
      lvl: typeof player !== 'undefined' && player ? player.lvl : null,
      connected: typeof socket !== 'undefined' && !!(socket && socket.connected),
      // The three shapes the build changes could break: the shared catalog, a
      // late file in the concat order, and the renderer.
      sharedOk: typeof CHAR_DEF !== 'undefined' && typeof skillDamageMult === 'function',
      lateFileOk: typeof openNpc === 'function',
      pixiOk: typeof PIXI !== 'undefined',
    }));

    ok(st.hasPlayer, 'the client built a player');
    eq(st.state, 'playing', 'and reached the world');
    ok(st.connected, 'with a live socket');
    ok(st.sharedOk, 'the shared catalog is in scope for the game code');
    ok(st.lateFileOk, 'so is the last file in the concat order');
    ok(st.pixiOk, 'the renderer loaded');

    // Real floor transition, driven through the actual client code path
    // (netEnterLocation -> _applyGameStart's floorChange branch -> initNpcs/
    // pixiClearEntityPools/_buildArmGates/buildTileCanvas) rather than the
    // raw socket protocol the 'floors:' scenarios already cover — this is
    // the one check that would catch a client-side exception (a null deref
    // in a real PIXI/DOM environment) those can't.
    await page.evaluate(() => netEnterLocation('left'));
    await page.waitForTimeout(2500);
    const onArm = await page.evaluate(() => ({
      floor: typeof dungeonLvl !== 'undefined' ? dungeonLvl : null,
      npcCount: typeof npcs !== 'undefined' ? npcs.length : null,
      overlayHidden: (() => {
        const el = document.getElementById('char-select');
        return !el || el.style.display === 'none';
      })(),
    }));
    eq(onArm.floor, 2, 'the client followed the server onto the arm floor');
    eq(onArm.npcCount, 0, 'and cleared the hub-only NPCs');
    ok(onArm.overlayHidden, 'and hid the floor-loading overlay again');

    await page.evaluate(() => netEnterLocation('hub'));
    await page.waitForTimeout(2500);
    const backHome = await page.evaluate(() => ({
      floor: typeof dungeonLvl !== 'undefined' ? dungeonLvl : null,
      npcCount: typeof npcs !== 'undefined' ? npcs.length : null,
    }));
    eq(backHome.floor, 1, 'and came back from the return pad request');
    eq(backHome.npcCount, 3, 'with the hub NPCs rebuilt');

    // Only same-origin requests are the game's own responsibility. This
    // sandbox's proxy refuses third-party hosts outright, which says nothing
    // about production — and is a large part of why serving socket.io from
    // our own origin is worth doing.
    const ours = failed.filter(f => f.includes(BASE));
    ok(ours.length === 0, 'no same-origin request failed', ours.join(', '));
    const realErrors = errors.filter(e => !/ERR_TUNNEL|ERR_(NAME|CONNECTION|PROXY)|telegram\.org|cdn\.socket\.io/.test(e));
    ok(realErrors.length === 0, 'no console errors of our own', realErrors.slice(0, 4).join(' | '));
  } finally {
    await browser.close();
  }
});

scenario('browser: entering Страх closes the events panel instead of leaving it over the world', async () => {
  // Clicking "Войти" (netFearEnter) teleports the player into Fear and spawns
  // wave 1 immediately — unlike deathBattle/race10/arena3, which all sit
  // behind a registration window that gives the player time to close this
  // panel themselves before anything actually happens. #events-panel is a
  // near-opaque full-screen overlay (97% alpha, z-index 120, see css/
  // style.css) that used to only ever close on its own "✕" button — so a
  // player who entered Fear was dropped into a live run, monsters and all,
  // still looking at a panel reading "Войдите, чтобы начать". Every single
  // entry went through this exact button, which is why it read as "monsters
  // never appear in Страх" for everyone, every time, right on entry.
  const exe = chromiumPath();
  if (!exe) { skip('no chromium in this environment — the browser scenario did NOT run'); return; }
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch { skip('playwright not installed — the browser scenario did NOT run'); return; }

  // Seeded above FEAR_MIN_LEVEL (10) the same way the other 'reconnect:'
  // scenarios seed a save — connectWithSaved creates the DB row and patches
  // it, then closes; the browser page below logs into that same account via
  // the same /dev/init-data route connectAs itself uses.
  const seed = await connectWithSaved('harness_fear_ui', { lvl: 15 });
  await seed.close();

  const browser = await chromium.launch({ executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
    await page.goto(`${BASE}/?dev=harness_fear_ui`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    const needsClass = await page.evaluate(() => typeof state !== 'undefined' && state === 'select');
    if (needsClass) {
      await page.evaluate(() => selectChar('ranger'));
      await page.waitForTimeout(4000);
    }
    ok(await page.evaluate(() => typeof state !== 'undefined' && state === 'playing'), 'reached the world');

    await page.evaluate(() => { openEventsPanel(); openEventDetail('fear'); });
    await page.waitForTimeout(300);
    ok(await page.evaluate(() => document.getElementById('events-panel')?.style.display === 'flex'),
      'the events panel is open, same as a real player checking Страх');

    await page.evaluate(() => netFearEnter());
    // Poll rather than wait on a fixed delay: fearStarted is a single round
    // trip, but no need to hard-code how long that takes.
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(300);
      if (await page.evaluate(() => typeof dungeonLvl !== 'undefined' && dungeonLvl === 11)) break;
    }

    const after = await page.evaluate(() => ({
      floor: typeof dungeonLvl !== 'undefined' ? dungeonLvl : null,
      panelDisplay: document.getElementById('events-panel')?.style.display,
    }));
    eq(after.floor, 11, 'the client followed the server onto the fear floor');
    eq(after.panelDisplay, 'none', 'and the events panel closed itself, uncovering the world');
  } finally {
    await browser.close();
  }
});

scenario('browser: the market search, rarity filter and sort actually narrow the list', async () => {
  // The market's category strip was the only way to narrow it, and on a PC
  // the strip itself could not be scrolled past its visible width (see the
  // next scenario). This drives the real panel in a real browser: seeded lots
  // from another seller, then the toolbar the player types into.
  const exe = chromiumPath();
  if (!exe) { skip('no chromium in this environment — the browser scenario did NOT run'); return; }
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch { skip('playwright not installed — the browser scenario did NOT run'); return; }

  const MarketListing = require('../server/models/MarketListing');
  // Every scenario in a run shares one in-memory database, and the market
  // ones above leave their lots behind — the panel shows all of them, so the
  // counts below would mean nothing. Cleared here rather than counted around:
  // no scenario after this one reads the market except the strip check right
  // below, which seeds its own.
  await MarketListing.deleteMany({});
  const lots = [
    { item: { id: 'sw5', name: 'Меч героя', slot: 'weapon', rarity: 'legendary' }, price: 90 },
    { item: { id: 'hm3', name: 'Платиновый шлем', slot: 'helmet', rarity: 'rare' }, price: 12 },
    { item: { id: 'ar1', name: 'Кожаная броня', slot: 'body', rarity: 'common' }, price: 3 },
    { item: { id: 'book_lev_Q', name: 'Книга: Ледяной удар', slot: 'material', rarity: 'uncommon', qty: 1 }, price: 1 },
  ];
  for (const l of lots) {
    await MarketListing.create({
      sellerId: 'harness_market_ui_seller', sellerUsername: 'ui_seller',
      item: l.item, price: l.price, status: 'active',
    });
  }

  const seed = await connectWithSaved('harness_market_ui', { lvl: 15 });
  await seed.close();

  const browser = await chromium.launch({ executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message.slice(0, 200)));
    await page.goto(`${BASE}/?dev=harness_market_ui`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    if (await page.evaluate(() => typeof state !== 'undefined' && state === 'select')) {
      await page.evaluate(() => selectChar('mage'));
      await page.waitForTimeout(4000);
    }
    ok(await page.evaluate(() => typeof state !== 'undefined' && state === 'playing'), 'reached the world');

    await page.evaluate(() => openMarketPanel());
    await page.waitForTimeout(1200);
    const rowCount = () => page.evaluate(() => document.querySelectorAll('#market-body .market-row').length);
    eq(await rowCount(), 4, 'all four seeded lots are listed to begin with');
    ok(await page.evaluate(() => !!document.getElementById('market-search-input')), 'the search box is there');

    // Typing, the way a player does — one input event per keystroke, which is
    // also what re-renders the body underneath the field.
    await page.evaluate(async () => {
      const el = document.getElementById('market-search-input');
      el.focus();
      for (const ch of 'книга') {
        const cur = document.getElementById('market-search-input');
        cur.value += ch;
        cur.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await page.waitForTimeout(200);
    eq(await rowCount(), 1, 'the search narrows the list to the matching item');
    eq(await page.evaluate(() => document.activeElement && document.activeElement.id), 'market-search-input',
      'and the field keeps focus across the re-render it causes');
    eq(await page.evaluate(() => document.getElementById('market-search-input').value), 'книга',
      'with everything typed still in it');

    // Clear the search, then filter by rarity instead.
    await page.evaluate(() => {
      const el = document.getElementById('market-search-input');
      el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(150);
    await page.evaluate(() => _marketSetFilter('rarity', 'legendary'));
    await page.waitForTimeout(150);
    eq(await rowCount(), 1, 'the rarity filter leaves only the legendary lot');

    await page.evaluate(() => _marketSetFilter('rarity', 'all'));
    await page.evaluate(() => _marketSetFilter('sort', 'rarity'));
    await page.waitForTimeout(150);
    const order = await page.evaluate(() =>
      [...document.querySelectorAll('#market-body .market-row-name')].map(e => e.textContent.trim()));
    eq(order[0], 'Меч героя', 'sorting by rarity puts the legendary lot first');
    eq(order[order.length - 1], 'Кожаная броня', 'and the common one last');

    // Typing into the box must not also play the game. The key listeners are
    // on window (initInput, js/input.js), so every character used to reach
    // them too: q/w/e/r cast, f drank a potion, w/a/s/d walked. Real key
    // events through the focused field, not synthesised ones, since that is
    // the whole point of the check.
    await page.evaluate(() => {
      window.__skills = 0; window.__potions = 0;
      window.useSkill = () => { window.__skills++; };
      window.usePotion = () => { window.__potions++; };
      document.getElementById('market-search-input').focus();
    });
    await page.keyboard.type('wqerf');
    await page.waitForTimeout(150);
    const leaked = await page.evaluate(() => ({
      skills: window.__skills, potions: window.__potions, walking: !!keys.w,
      typed: document.getElementById('market-search-input').value,
    }));
    eq(leaked.typed, 'wqerf', 'the field took the keystrokes');
    eq(leaked.skills, 0, 'and none of them cast a skill');
    eq(leaked.potions, 0, 'or drank a potion');
    eq(leaked.walking, false, 'or held a movement key down');

    // Back to the default so the filter state cannot leak into the next
    // scenario's page (a fresh page, but the same seeded lots).
    await page.evaluate(() => {
      const el = document.getElementById('market-search-input');
      el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true }));
      _marketSetFilter('sort', 'new');
    });
    eq(errors.length, 0, 'and nothing threw in the browser', errors.join(' | '));
  } finally {
    await browser.close();
  }
});

scenario('browser: the market category strip can be scrolled with a mouse', async () => {
  // The strip is overflow-x:auto with its scrollbar hidden — designed for a
  // finger. On a PC there is no flick, an ordinary wheel only reports deltaY,
  // and there was nothing visible to drag, so "Все / Оружие / Шлемы / …" past
  // the panel's 430px was unreachable: the reported "с ПК невозможно листать
  // вкладки". Both mouse gestures are checked here.
  const exe = chromiumPath();
  if (!exe) { skip('no chromium in this environment — the browser scenario did NOT run'); return; }
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch { skip('playwright not installed — the browser scenario did NOT run'); return; }

  // Seeded across enough categories that the strip is wider than the 430px
  // panel whatever else the run left in the market — the whole point of the
  // check is that it has somewhere to scroll to.
  const MarketListing = require('../server/models/MarketListing');
  const stripLots = [
    { id: 'sw5', name: 'Меч героя', slot: 'weapon', rarity: 'legendary' },
    { id: 'hm3', name: 'Платиновый шлем', slot: 'helmet', rarity: 'rare' },
    { id: 'ar1', name: 'Кожаная броня', slot: 'body', rarity: 'common' },
    { id: 'gl1', name: 'Кожаные перчи', slot: 'gloves', rarity: 'common' },
    { id: 'bt1', name: 'Кожаные боты', slot: 'boots', rarity: 'common' },
    { id: 'rn1', name: 'Кольцо силы', slot: 'ring', rarity: 'common' },
    { id: 'nd1', name: 'Пояс силы', slot: 'belt', rarity: 'common' },
    { id: 'cloak_c_lev', name: 'Плащ танка', slot: 'cloak', rarity: 'common' },
    { id: 'artifact_c_lev', name: 'Артефакт танка', slot: 'artifact', rarity: 'common' },
    { id: 'book_lev_Q', name: 'Книга: Ледяной удар', slot: 'material', rarity: 'uncommon', qty: 1 },
  ];
  for (const item of stripLots) {
    await MarketListing.create({
      sellerId: 'harness_market_strip_seller', sellerUsername: 'strip_seller',
      item, price: 2, status: 'active',
    });
  }

  const seed = await connectWithSaved('harness_market_strip', { lvl: 15 });
  await seed.close();

  const browser = await chromium.launch({ executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
    await page.goto(`${BASE}/?dev=harness_market_strip`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    if (await page.evaluate(() => typeof state !== 'undefined' && state === 'select')) {
      await page.evaluate(() => selectChar('mage'));
      await page.waitForTimeout(4000);
    }
    await page.evaluate(() => openMarketPanel());
    await page.waitForTimeout(1200);

    const strip = await page.evaluate(() => {
      const s = document.querySelector('#market-body .market-cat-tabs');
      return s ? { overflows: s.scrollWidth > s.clientWidth + 1, left: s.scrollLeft } : null;
    });
    ok(strip && strip.overflows, 'the strip is wider than the panel — there is something to reach');
    if (!strip || !strip.overflows) return;

    // A plain vertical wheel over the strip, which is all a mouse sends.
    const afterWheel = await page.evaluate(() => {
      const s = document.querySelector('#market-body .market-cat-tabs');
      s.dispatchEvent(new WheelEvent('wheel', { deltaY: 200, bubbles: true, cancelable: true }));
      return s.scrollLeft;
    });
    ok(afterWheel > 0, `the wheel scrolls the strip sideways (scrollLeft ${afterWheel})`);

    // And dragging it like a finger, without that drag counting as a click on
    // whichever tab the mouse happened to be released over.
    const dragged = await page.evaluate(() => {
      const s = document.querySelector('#market-body .market-cat-tabs');
      s.scrollLeft = 0;
      const before = _marketCategoryFilter;
      const tab = s.querySelectorAll('.market-cat-tab')[2];
      const r = tab.getBoundingClientRect();
      const opts = { pointerType: 'mouse', button: 0, bubbles: true, cancelable: true, clientY: r.top + 5 };
      tab.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: r.left + 30 }));
      tab.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: r.left - 90 }));
      tab.dispatchEvent(new PointerEvent('pointerup',   { ...opts, clientX: r.left - 90 }));
      tab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return { left: s.scrollLeft, catBefore: before, catAfter: _marketCategoryFilter };
    });
    ok(dragged.left > 0, `dragging with the mouse scrolls it too (scrollLeft ${dragged.left})`);
    eq(dragged.catAfter, dragged.catBefore, 'and the drag does not count as clicking the tab it ended on');

    // An ordinary click still switches category — the drag suppression must
    // not have eaten it.
    const clicked = await page.evaluate(() => {
      const s = document.querySelector('#market-body .market-cat-tabs');
      const tab = s.querySelectorAll('.market-cat-tab')[1];
      tab.click();
      return _marketCategoryFilter;
    });
    ok(clicked !== 'all', `a plain click still selects a category (${clicked})`);
  } finally {
    await browser.close();
  }
});

scenario('browser: АВТО casts only the skills left switched on, and none when switched off', async () => {
  // АВТО used to cast whatever was off cooldown, in slot order, with no say
  // in it — no way to save an ultimate for a boss, to stop a knockback
  // scattering a pull, or to have the auto attack without spending anything.
  // The picker (hold the AUTO button, or the button in the skills panel)
  // writes autoSkillsOn/autoSkillOff, and this is what _autoCastSkills does
  // with them.
  const exe = chromiumPath();
  if (!exe) { skip('no chromium in this environment — the browser scenario did NOT run'); return; }
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch { skip('playwright not installed — the browser scenario did NOT run'); return; }

  const seed = await connectWithSaved('harness_autoskills', {
    lvl: 15, vipLevel: 2, skillLevels: { Q: 5, W: 5, E: 5, R: 5 },
  });
  await seed.close();

  const browser = await chromium.launch({ executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message.slice(0, 200)));
    await page.goto(`${BASE}/?dev=harness_autoskills`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    if (await page.evaluate(() => typeof state !== 'undefined' && state === 'select')) {
      await page.evaluate(() => selectChar('lev'));
      await page.waitForTimeout(4000);
    }
    ok(await page.evaluate(() => typeof state !== 'undefined' && state === 'playing'), 'reached the world');

    // A fight the auto-cast will actually engage with: one live enemy right
    // next to the player, every cooldown clear, VIP high enough.
    const arm = () => page.evaluate(() => {
      window._vipData = { level: 2 };
      autoAttackMode = true;
      player.skillLevels = { Q: 5, W: 5, E: 5, R: 5 };
      player.skillCooldowns = { Q: 0, W: 0, E: 0, R: 0 };
      player.hp = player.maxHp;
      player.stunTimer = 0; player.atkAnimTimer = 0; player._chasing = false;
      serverEnemies.length = 0;
      serverEnemies.push({ id: 'dummy', hp: 500, maxHp: 500, x: player.x + 40, y: player.y, size: 20 });
      window.__cast = [];
      window.useSkill = i => { window.__cast.push(i); };
    });

    // The real loop is running and calls _autoCastSkills itself, so these
    // read every cast recorded over the window rather than assuming one:
    // what matters is WHICH slots the auto reached for, and that it reached
    // for none at all once switched off.
    const castsOver = async ms => {
      await arm();
      await page.waitForTimeout(ms);
      return page.evaluate(() => { _autoCastSkills(5); return window.__cast.slice(); });
    };

    // Everything on (the default, and what every existing account has).
    const first = await castsOver(400);
    ok(first.length > 0, 'the auto casts at all to begin with');
    ok(first.every(i => i === 0), `and with nothing switched off it only reaches for the first slot (${first})`);

    // Switch that slot off — the auto must move on to the next one, not go
    // quiet and not cast it anyway.
    await page.evaluate(() => toggleAutoSkill('Q'));
    const second = await castsOver(400);
    ok(second.length > 0, 'the auto still casts with one slot switched off');
    ok(second.every(i => i === 1), `and skips the switched-off slot for the next one (${second})`);

    // Master switch off: auto-ATTACK keeps running, casting stops entirely.
    await page.evaluate(() => setAutoSkillsOn(false));
    const third = await castsOver(600);
    eq(third.length, 0, 'nothing is cast with auto-cast switched off');
    eq(await page.evaluate(() => autoAttackMode), true, 'while auto-attack itself is untouched');

    await page.evaluate(() => { setAutoSkillsOn(true); document.getElementById('auto-skills-ov')?.remove(); });

    // The gesture that opens the picker: hold the AUTO button. A short tap on
    // the same button must still be the auto-attack toggle. The what's-new
    // modal is a full-screen overlay on a first login and would swallow both
    // presses before the canvas ever sees them.
    await page.evaluate(() => {
      if (typeof closeWhatsNewModal === 'function') closeWhatsNewModal();
      document.getElementById('whatsnew-ov')?.remove();
    });
    await page.waitForTimeout(150);
    const btn = await page.evaluate(() => {
      const a = getAutoBtnPos();
      const r = canvas.getBoundingClientRect();
      return { x: r.left + a.x + a.w / 2, y: r.top + a.y + a.h / 2, mode: autoAttackMode };
    });
    await page.mouse.move(btn.x, btn.y);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();
    await page.waitForTimeout(200);
    const held = await page.evaluate(() => ({
      open: !!document.getElementById('auto-skills-ov'),
      mode: autoAttackMode,
    }));
    ok(held.open, 'holding the AUTO button opens the auto-cast picker');
    eq(held.mode, btn.mode, 'and does not also flip auto-attack');

    await page.evaluate(() => document.getElementById('auto-skills-ov')?.remove());
    await page.mouse.move(btn.x, btn.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(150);
    const tapped = await page.evaluate(() => ({
      open: !!document.getElementById('auto-skills-ov'),
      mode: autoAttackMode,
    }));
    eq(tapped.mode, !btn.mode, 'a short tap still toggles auto-attack');
    eq(tapped.open, false, 'without opening the picker');

    // And the settings survive a reload — they ride the save blob and come
    // back from the stored record, like the potion/auto-HP preferences.
    await page.waitForTimeout(4000);
    await page.goto(`${BASE}/?dev=harness_autoskills`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);
    const restored = await page.evaluate(() => (player && player.autoSkillOff) || null);
    ok(restored && restored.Q === true, `the switched-off slot came back after a reload (${JSON.stringify(restored)})`);

    eq(errors.length, 0, 'and nothing threw in the browser', errors.join(' | '));
  } finally {
    await browser.close();
  }
});

scenario('browser: pressing Вывести below VIP 3 says so instead of opening the form', async () => {
  // The server has always refused a withdrawal below VIP 3
  // (gramWithdrawRequest, server/index.js) — but its gramError went to
  // _gramMsg, whose #gram-msg element existed nowhere, so the refusal was
  // dropped on the floor: the player filled in an amount and a wallet
  // address, submitted, and nothing happened, with no reason given. The gate
  // is stated on the press now, and the message element is real.
  const exe = chromiumPath();
  if (!exe) { skip('no chromium in this environment — the browser scenario did NOT run'); return; }
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch { skip('playwright not installed — the browser scenario did NOT run'); return; }

  const seed = await connectWithSaved('harness_withdraw_vip', { lvl: 15, vipLevel: 0, gramBalance: 500 });
  await seed.close();

  const browser = await chromium.launch({ executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message.slice(0, 200)));
    await page.goto(`${BASE}/?dev=harness_withdraw_vip`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    if (await page.evaluate(() => typeof state !== 'undefined' && state === 'select')) {
      await page.evaluate(() => selectChar('mage'));
      await page.waitForTimeout(4000);
    }

    // Профиль → Кошелёк, the tab the button lives on.
    await page.evaluate(() => { setTab(5); switchProfileTab('wallet'); });
    await page.waitForTimeout(400);

    const refused = await page.evaluate(() => {
      window._vipData = { level: 0 };
      openGramWithdrawModal();
      const msg = document.getElementById('gram-msg');
      return {
        opened: !!document.getElementById('gram-modal-wrap'),
        shown: !!msg && msg.style.display !== 'none',
        text: msg ? msg.textContent : null,
      };
    });
    eq(refused.opened, false, 'the withdrawal form does not open below VIP 3');
    ok(refused.shown, 'a message is shown instead of nothing happening');
    ok(/VIP 3/.test(refused.text || ''), `and it names the level required (got: ${refused.text})`);

    // At VIP 3 the form opens as before — the gate is a gate, not a wall.
    const allowed = await page.evaluate(() => {
      window._vipData = { level: 3 };
      openGramWithdrawModal();
      return !!document.getElementById('gram-modal-wrap');
    });
    ok(allowed, 'at VIP 3 the form opens');
    await page.evaluate(() => closeGramModal());

    // And the server's own refusals reach the player now that the element
    // they are written into exists at all.
    const relayed = await page.evaluate(() => {
      _gramMsg('серверный отказ', 'err');
      const msg = document.getElementById('gram-msg');
      return { shown: !!msg && msg.style.display !== 'none', text: msg ? msg.textContent : null };
    });
    ok(relayed.shown && relayed.text === 'серверный отказ',
      `a gramError from the server lands somewhere visible (${JSON.stringify(relayed)})`);

    eq(errors.length, 0, 'and nothing threw in the browser', errors.join(' | '));
  } finally {
    await browser.close();
  }
});

scenario('browser: a short drop resumes in place instead of rebuilding the world', async () => {
  // The other half of "мир перезагружается". Even once the reconnect lands
  // back on the right floor, it used to rebuild everything on arrival —
  // unpack the grid, re-run buildTileCanvas(), re-init NPCs — and the
  // 'disconnect' handler had already emptied enemies, other players and the
  // Pixi pools the moment the socket went. A half-second blip therefore
  // looked exactly like an hour offline. This drives a real client through a
  // real drop and checks the world was resumed, not rebuilt.
  const exe = chromiumPath();
  if (!exe) { skip('no chromium in this environment — the browser scenario did NOT run'); return; }
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch { skip('playwright not installed — the browser scenario did NOT run'); return; }

  const seed = await connectWithSaved('harness_resume_ui', { lvl: 20, xp: 0, xpNext: 9999 });
  await seed.close();
  await sleep(300);

  const browser = await chromium.launch({ executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
    await page.goto(`${BASE}/?dev=harness_resume_ui`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    if (await page.evaluate(() => typeof state !== 'undefined' && state === 'select')) {
      await page.evaluate(() => selectChar('ranger'));
      await page.waitForTimeout(5000);
    }
    ok(await page.evaluate(() => typeof state !== 'undefined' && state === 'playing'), 'reached the world');

    // Out to an arm, so the floor being restored is a real one and the grid
    // being skipped is the big one (240x338, not the hub's 68x68).
    await page.evaluate(() => netEnterLocation('top'));
    await page.waitForTimeout(2500);
    eq(await page.evaluate(() => dungeonLvl), 3, 'standing on the arm floor');

    // Count the expensive rebuild from here on.
    await page.evaluate(() => {
      window.__tileBuilds = 0;
      const orig = window.buildTileCanvas;
      window.buildTileCanvas = function (...a) { window.__tileBuilds++; return orig.apply(this, a); };
      window.__dungeonRef = dungeon;
    });

    // A real drop, exactly as the transport would deliver it.
    await page.evaluate(() => socket.io.engine.close());
    await page.waitForTimeout(400);
    ok(await page.evaluate(() => !socket.connected), 'the socket really went down');
    // Mid-drop the world must still be there — this is the frame players saw
    // emptied.
    ok(await page.evaluate(() => !!dungeon && typeof serverEnemies !== 'undefined'),
      'the world is still standing while the socket is down');

    // Let socket.io reconnect on its own.
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(500);
      if (await page.evaluate(() => !!socket.connected && state === 'playing')) break;
    }
    await page.waitForTimeout(1500);

    const after = await page.evaluate(() => ({
      connected: !!socket.connected,
      floor: dungeonLvl,
      tileBuilds: window.__tileBuilds,
      sameDungeon: dungeon === window.__dungeonRef,
      enemies: serverEnemies.length,
    }));
    ok(after.connected, 'and it came back');
    eq(after.floor, 3, 'onto the same arm floor it dropped on');
    eq(after.tileBuilds, 0, 'without re-rasterising a single tile');
    ok(after.sameDungeon, 'and without rebuilding the map it was already rendering');
    ok(after.enemies > 0, 'while the enemy list was resynced, not left empty', String(after.enemies));
  } finally {
    await browser.close();
  }
});

scenario('browser: a kicked session stays down instead of reloading into a kick loop', async () => {
  // One live session per account: a second login kicks the first (see
  // loginTelegramWebApp, server/index.js). The client used to answer that by
  // reloading the page two seconds later — which re-ran the login, which
  // kicked whichever session was now live, which reloaded and kicked this one
  // back. Two clients on one account (a phone plus Telegram Desktop, two
  // tabs) ping-ponged forever, each paying for a full login round trip every
  // couple of seconds. From inside either one it is indistinguishable from a
  // server that keeps restarting — which is exactly the report this whole
  // branch started from.
  const exe = chromiumPath();
  if (!exe) { skip('no chromium in this environment — the browser scenario did NOT run'); return; }
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch { skip('playwright not installed — the browser scenario did NOT run'); return; }

  const browser = await chromium.launch({ executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
    let navigations = 0;
    page.on('framenavigated', f => { if (f === page.mainFrame()) navigations++; });
    await page.goto(`${BASE}/?dev=harness_kickloop`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    const needsClass = await page.evaluate(() => typeof state !== 'undefined' && state === 'select');
    if (needsClass) {
      await page.evaluate(() => selectChar('mage'));
      await page.waitForTimeout(4000);
    }
    ok(await page.evaluate(() => typeof state !== 'undefined' && state === 'playing'), 'reached the world');
    const navsBefore = navigations;
    // Read the same field on a HEALTHY socket first, so the assertion after
    // the kick is known to be reading a real property rather than quietly
    // passing on undefined.
    eq(await page.evaluate(() => !!(socket && socket.io && socket.io._reconnection)), true,
      'socket.io auto-reconnect is on for a normal session');

    // The second login for the same account, from outside the browser — the
    // other device.
    const rival = await connectAs('harness_kickloop');
    await enterWorld(rival, 'mage');

    // Long enough to cover the old two-second reload timer several times over.
    await page.waitForTimeout(7000);

    const after = await page.evaluate(() => ({
      connected: typeof socket !== 'undefined' && !!(socket && socket.connected),
      // The manager must not be waiting to reconnect on its own either.
      willReconnect: typeof socket !== 'undefined' && !!(socket && socket.io && socket.io._reconnection),
      err: document.getElementById('auth-error')?.textContent || '',
    }));
    eq(navigations, navsBefore, 'the kicked page did not reload itself');
    eq(after.connected, false, 'its socket stayed down');
    eq(after.willReconnect, false, 'and socket.io will not reconnect it behind our back');
    ok(after.err.length > 0, 'the player is told why', after.err);

    // And the session that did the kicking is still the live one — the whole
    // point of the rule.
    const sync = rival.wait('fearState', { timeout: 4000 });
    rival.emit('fearSync');
    ok(await sync, 'the surviving session is still served');
    await rival.close();
  } finally {
    await browser.close();
  }
});

scenario('browser: the season ticket info modal does not get stuck on "season ended" before its first sync', async () => {
  // _seasonState is only ever refreshed by a seasonSync round trip — nothing
  // pushes it at login (see openSeasonPanel, js/ui.js). A player who tapped
  // the ticket row in the GRAM shop without having opened the Сезон panel
  // first this session was still reading state.js's inert default
  // ({active:false, endAt:0}), which _openSeasonTicketInfo read as "season
  // ended" even mid-season. The fix: the modal now requests its own sync on
  // open and re-renders once the reply lands.
  const exe = chromiumPath();
  if (!exe) { skip('no chromium in this environment — the browser scenario did NOT run'); return; }
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch { skip('playwright not installed — the browser scenario did NOT run'); return; }

  const browser = await chromium.launch({ executablePath: exe });
  try {
    const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
    await page.goto(`${BASE}/?dev=harness_seasontix`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(7000);
    const needsClass = await page.evaluate(() => typeof state !== 'undefined' && state === 'select');
    if (needsClass) {
      await page.evaluate(() => selectChar('mage'));
      await page.waitForTimeout(8000);
    }
    ok(await page.evaluate(() => typeof state !== 'undefined' && state === 'playing'), 'reached the world');

    // Confirms the bug's precondition still exists: before any seasonSync
    // round trip this session, the client only has the inert default.
    const before = await page.evaluate(() => ({ active: _seasonState.active, endAt: _seasonState.endAt }));
    eq(before.active, false, 'starts on state.js\'s default (active:false) — no seasonState pushed yet this session');

    // Open the ticket info modal directly, the way tapping the shop row
    // does, WITHOUT ever opening the Сезон events panel first — the only
    // other path that would have refreshed _seasonState.
    await page.evaluate(() => _openSeasonTicketInfo());
    const seasonEndedStr = await page.evaluate(() => t('seasonEnded'));

    await page.waitForTimeout(1500); // let the seasonSync round trip land
    const after = await page.evaluate(() => ({ active: _seasonState.active }));
    ok(after.active, 'the real season state (active, per SEASON_END_AT) landed');
    const line = await page.evaluate(() => {
      const el = document.getElementById('season-ticket-info-ov');
      if (!el) return null;
      const rows = el.querySelectorAll('.market-modal-sheet > div');
      return rows.length ? rows[rows.length - 1].textContent.trim() : null;
    });
    ok(line && line !== seasonEndedStr,
      'the modal shows the real "ends in" countdown, not "season ended", despite never having opened the Сезон panel', line);
  } finally {
    await browser.close();
  }
});

scenario('race10: an entrant is joined AT its lane, so gameStart cannot say "boss room"', async () => {
  // Every entrant used to start the race standing on the boss instead of in
  // their own corridor. The join that builds gameStart runs BEFORE raceDeploy
  // assigns lanes, so gameStart carried this floor's default spawn — which for
  // the Tower is the middle of the shared boss room — while race10Started
  // carried the real lane moments later. The client applies race10Started at
  // once but defers gameStart behind the world-map fetch on a first visit to
  // the floor, so the stale position won by arriving last.
  //
  // Fixed at the source: each entrant is joined at the exact lane raceDeploy is
  // about to give it, so the two payloads agree and the ordering stops
  // mattering. Asserted as "these two agree", which is the property that has to
  // hold however the client is written.
  const a = await connectWithSaved('harness_r10_lane_a', { lvl: 10, xp: 0, xpNext: 100 });
  const b = await connectWithSaved('harness_r10_lane_b', { lvl: 10, xp: 0, xpNext: 100 });
  await enterWorld(a, 'ranger');
  await enterWorld(b, 'mage');
  await fetch(`${BASE}/dev/race10/open?reg=1500`, { method: 'POST' });

  const aReg = a.wait('race10Registered', { timeout: 3000 });
  const bReg = b.wait('race10Registered', { timeout: 3000 });
  a.emit('race10Register'); b.emit('race10Register');
  await aReg; await bReg;

  const aStarted = a.wait('race10Started', { timeout: 6000 });
  const bStarted = b.wait('race10Started', { timeout: 6000 });
  const as = await aStarted, bs = await bStarted;

  const bossSpot = require('../server/game/dungeon').generateRace10().race10.boss;
  const aGs = a.last('gameStart');
  eq(aGs.floor, 10, 'joined onto the Tower floor');
  eq(aGs.spawn.x, as.x, 'gameStart puts the entrant at the same x race10Started does');
  eq(aGs.spawn.y, as.y, 'and the same y — not the floor default');
  ok(!(aGs.spawn.x === bossSpot.x && aGs.spawn.y === bossSpot.y),
    'and that spot is not the shared boss room');

  // Two entrants, two different corridors — the lanes really are per player.
  eq(as.lane, 0, 'the first entrant gets lane 0');
  eq(bs.lane, 1, 'the second gets lane 1');
  ok(as.y !== bs.y, 'and they are on different rows');

  await a.close(); await b.close();
});

scenario('race10: 51 entrants for 50 corridors — the 51st is refused, not stuffed into a shared lane', async () => {
  // RACE10_LANES is 50 (server/game/dungeon.js) and the map is generated with
  // exactly that many sealed corridors, so a 51st registrant cannot be given
  // one. Sharing a corridor would put two players on the same monsters and
  // undo the isolation the whole design rests on; silently dropping them would
  // leave someone waiting for a race that never starts. Run at the real
  // numbers rather than a scaled-down stand-in — 50 is the number in the
  // question, so it is the number under test.
  const N = 51;
  const clients = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      connectWithSaved(`harness_r10_cap_${i}`, { lvl: 10, xp: 0, xpNext: 100 })),
  );
  await Promise.all(clients.map((c, i) => enterWorld(c, i % 2 ? 'mage' : 'ranger')));
  await fetch(`${BASE}/dev/race10/open?reg=3000`, { method: 'POST' });

  const regs = clients.map(c => c.wait('race10Registered', { timeout: 6000 }).catch(() => null));
  clients.forEach(c => c.emit('race10Register'));
  const regged = await Promise.all(regs);
  eq(regged.filter(r => r && r.registered).length, N,
    'all 51 are accepted into the queue — the cap is applied at deploy, not at sign-up');

  const outcomes = clients.map(c => Promise.race([
    c.wait('race10Started', { timeout: 12000 }).then(v => ({ started: v })).catch(() => null),
    c.wait('race10Error', { timeout: 12000 }).then(v => ({ error: v })).catch(() => null),
  ]));
  const res = await Promise.all(outcomes);

  const started = res.filter(r => r && r.started);
  const refused = res.filter(r => r && r.error);
  eq(started.length, 50, 'exactly 50 are deployed — one per corridor, never shared');
  eq(refused.length, 1, 'and the 51st is refused rather than silently dropped');
  ok(/коридор/i.test((refused[0].error.msg) || ''),
    'with a message naming the reason', refused[0].error.msg);

  // Every deployed entrant holds a corridor of its own.
  const lanes = started.map(r => r.started.lane);
  eq(new Set(lanes).size, 50, 'all 50 lanes are distinct');
  eq(Math.min(...lanes), 0, 'numbered from 0');
  eq(Math.max(...lanes), 49, 'up to 49');

  // And the refused one is not left believing it is still in.
  const rejected = clients[res.findIndex(r => r && r.error)];
  // Only the race10Sync REPLY carries registered/inMatch; _race10Broadcast
  // (server/game/race10.js) sends the same event name to everyone with just
  // the public state, and the 50 deploys above make one likely to arrive right
  // about now. Match on the reply's own shape rather than taking the first
  // race10State to show up — the client makes the same distinction, keeping
  // its previous value when the field is absent (js/network.js).
  const sync = rejected.wait('race10State', { timeout: 5000, match: st => st.registered !== undefined });
  rejected.emit('race10Sync');
  const st = await sync;
  eq(st.registered, false, 'the refused entrant is unregistered, not left waiting for a race it is not in');
  eq(st.inMatch, false, 'and is not in the match either');

  await Promise.all(clients.map(c => c.close()));
});

scenario('race10: everyone who hits the boss is paid, the winner more, and nobody else', async () => {
  // Reaching the boss and landing a hit on it is the qualifying line — corridor
  // kills never count, because only damage to the shared boss is tallied
  // (_race10TrackHit, server/index.js). Two entrants both reach the boss and
  // hit it; a third runs the race but never touches it. The winner takes the
  // bigger tier of the same reward, not a different one.
  const a = await connectWithSaved('harness_r10_pay_a', { lvl: 10, xp: 0, xpNext: 100 });
  const b = await connectWithSaved('harness_r10_pay_b', { lvl: 10, xp: 0, xpNext: 100 });
  const c = await connectWithSaved('harness_r10_pay_c', { lvl: 10, xp: 0, xpNext: 100 });
  await enterWorld(a, 'ranger');
  await enterWorld(b, 'mage');
  await enterWorld(c, 'lev');
  await fetch(`${BASE}/dev/race10/open?reg=1500`, { method: 'POST' });

  const regs = [a, b, c].map(x => x.wait('race10Registered', { timeout: 4000 }));
  [a, b, c].forEach(x => x.emit('race10Register'));
  await Promise.all(regs);

  const starts = [a, b, c].map(x => x.wait('race10Started', { timeout: 8000 }));
  const fights = [a, b, c].map(x => x.wait('race10Fight', { timeout: 20000 }));
  await Promise.all(starts);
  // Entrants are frozen for RACE10_FREEZE_MS after the deploy — the server
  // refuses both movement and attacks until race10Fight goes out, so swinging
  // before it lands would silently do nothing.
  await Promise.all(fights);

  // Walk a and b onto the boss and hit it; c stays in its corridor.
  const boss = require('../server/game/dungeon').generateRace10().race10.boss;
  const results = [a, b, c].map(x => x.wait('race10Result', { timeout: 20000 }).catch(() => null));
  for (const x of [a, b]) {
    x.emit('playerMove', { x: boss.x + 30, y: boss.y, facing: 1, moving: false });
  }
  await sleep(300);
  // a swings far more than b, so a is the top damage-dealer. The server rate
  // limits one hit per 150ms per socket, so these are paced.
  const bossId = (await fetch(`${BASE}/dev/race10/state`).then(r => r.json())).bossId;
  ok(bossId, 'the shared boss is up and nameable');
  for (let i = 0; i < 14; i++) {
    a.emit('attack', { enemyId: bossId });
    if (i % 4 === 0) b.emit('attack', { enemyId: bossId });
    await sleep(170);
  }
  // End the race on the clock rather than by killing the boss — the payout
  // rule is the same either way and this keeps the scenario short.
  await fetch(`${BASE}/dev/race10/finish`, { method: 'POST' });

  const [ra, rb, rc] = await Promise.all(results);
  ok(ra && rb && rc, 'all three get a result');

  const winner = [ra, rb].find(r => r.won);
  const loser  = [ra, rb].find(r => !r.won);
  ok(winner, 'the top damage-dealer is marked the winner');
  eq(winner.reward, 30, 'the winner takes 30 Liberty');
  eq(loser.reward, 10, 'the other boss-hitter takes 10 Liberty');
  eq(rc.reward, 0, 'and the entrant who never reached the boss takes nothing');

  const qtyOf = r => (r.items || []).map(i => i.qty);
  eq((winner.items || []).length, 6, 'the winner gets every kind of buff potion');
  ok(qtyOf(winner).every(q => q === 2), 'two of each', JSON.stringify(qtyOf(winner)));
  eq((loser.items || []).length, 6, 'so does the other boss-hitter');
  ok(qtyOf(loser).every(q => q === 1), 'one of each', JSON.stringify(qtyOf(loser)));
  eq((rc.items || []).length, 0, 'and the non-participant gets no potions either');

  // The potions really landed in the inventory, not just in the modal.
  await sleep(400);
  const rowW = memory.__dump('Player').find(p => p.username === (winner === ra ? a : b).auth.username);
  const bag = (rowW.savedData.inventory || []).filter(i => i && i.id.startsWith('bp_'));
  eq(bag.length, 6, 'the winner\'s inventory really holds all six kinds');
  ok(bag.every(i => i.qty === 2), 'at two each', JSON.stringify(bag.map(i => i.qty)));

  await a.close(); await b.close(); await c.close();
});

// A throwaway Tower Room, for the scenarios that ask Room.js questions
// directly rather than through a socket. Built fresh (and stopped again)
// rather than reaching into the server's live one, so poking at its geometry
// cannot leak into any other scenario.
function _towerRoom() {
  const Room = require('../server/game/Room');
  const { FLOOR_IDS } = require('../server/game/floors');
  const _io = { to: () => ({ emit() {} }), sockets: { sockets: { get: () => null } } };
  return new Room(FLOOR_IDS.race10, _io, {}, null);
}

scenario('race10: a same-account reconnect during registration keeps its place in the queue', async () => {
  // The Map's insertion order IS the queue — _race10Start takes the first
  // `capacity` entrants — and the rekey onto the reconnecting socket used to
  // be set-then-delete, which appends. A player whose connection blipped
  // during registration therefore went to the back of a line they were at the
  // front of, and at 50+ registrants for 50 corridors that decides who races.
  //
  // The path under test is the duplicate-login one: a second socket for the
  // same account arrives while the first is still live (addPlayer reports it
  // as a stale entry), which is what a fast mobile reconnect looks like. A
  // fully processed disconnect is a different case — it drops the
  // registration outright, on purpose, since only a connected entrant can be
  // deployed.
  const a = await connectWithSaved('harness_r10_q_a', { lvl: 10, xp: 0, xpNext: 100 });
  const b = await connectWithSaved('harness_r10_q_b', { lvl: 10, xp: 0, xpNext: 100 });
  const c = await connectWithSaved('harness_r10_q_c', { lvl: 10, xp: 0, xpNext: 100 });
  await enterWorld(a, 'ranger');
  await enterWorld(b, 'mage');
  await enterWorld(c, 'lev');
  await fetch(`${BASE}/dev/race10/open?reg=6000`, { method: 'POST' });

  for (const x of [a, b, c]) {
    const r = x.wait('race10Registered', { timeout: 4000 });
    x.emit('race10Register');
    await r;
  }
  const before = await fetch(`${BASE}/dev/race10/queue`).then(r => r.json());
  eq(before.names[0], a.auth.username, 'a signed up first');

  // a's client reconnects without its old socket having been torn down yet.
  const a2 = await connectAs('harness_r10_q_a');
  await enterWorld(a2, 'ranger');
  await sleep(400);

  const after = await fetch(`${BASE}/dev/race10/queue`).then(r => r.json());
  eq(after.size, 3, 'the queue still holds all three');
  eq(after.names[0], a2.auth.username, 'and the reconnected entrant is still FIRST, not appended to the back');
  eq(after.names[1], b.auth.username, 'with everyone behind it in the order they signed up');
  eq(after.names[2], c.auth.username, 'unchanged');

  // And the same after a FULLY processed disconnect, which is what a real
  // mobile drop looks like once engine.io has given up on it. This is the
  // case that used to lose the sign-up outright rather than merely reorder
  // it: the registration is parked on disconnect and reclaimed by account.
  await b.close();
  await sleep(700);
  const midway = await fetch(`${BASE}/dev/race10/queue`).then(r => r.json());
  eq(midway.size, 3, 'a dropped entrant stays parked in the queue rather than being unregistered');

  const b2 = await connectAs('harness_r10_q_b');
  await enterWorld(b2, 'mage');
  await sleep(400);
  const healed = await fetch(`${BASE}/dev/race10/queue`).then(r => r.json());
  eq(healed.size, 3, 'and reconnecting does not duplicate it');
  eq(healed.names[1], b2.auth.username, 'it is reclaimed in the same position it signed up at');

  // The client is told it is still registered, so it does not sit showing a
  // sign-up button for a race it is already in.
  const sync = b2.wait('race10State', { timeout: 4000 });
  b2.emit('race10Sync');
  eq((await sync).registered, true, 'and the reconnected client knows it is still registered');

  await Promise.all([a2, b2, c].map(x => x.close()));
});

scenario('race10: a corridor whose entry is unusable lowers capacity instead of dumping its occupant on the boss', async () => {
  // raceDeploy used to fall back to the boss room when a lane's entry point
  // came out inside geometry — the same silent misplacement that put every
  // entrant on the boss for real. A placement that cannot be honoured has to
  // reduce capacity and refuse someone plainly.
  const room = _towerRoom();
  try {
    const all = room.dungeonData.race10.lanes;
    eq(room.raceUsableLanes().length, all.length, 'every corridor is usable on the map as drawn');

    // Move one lane's entry point into the wall block between corridors and
    // confirm it drops out of the usable set rather than becoming a boss slot.
    const victim = all[7];
    victim.x = 0; victim.y = 0;             // margin, solid wall
    const usable = room.raceUsableLanes();
    eq(usable.length, all.length - 1, 'the unusable corridor is not offered');
    ok(!usable.some(u => u.lane === 7), 'and specifically lane 7 is the one missing');
    ok(usable.every(u => u.x !== room.dungeonData.race10.boss.x || u.y !== room.dungeonData.race10.boss.y),
      'no corridor resolves to the boss room');
    // Lane identity survives the gap: the remaining corridors keep their own
    // map indices, because every corridor monster is tagged with one.
    eq(usable[7].lane, 8, 'lanes past the gap keep their real index, they are not renumbered');
  } finally {
    room._stopLoop();
  }
});

scenario('race10: a racer cannot damage another corridor\'s monsters even when told the id directly', async () => {
  // Cross-lane hits were stopped only by the walls and the line-of-sight
  // sampling — true for the geometry as drawn, but the wrong thing to rely
  // on: a client that names an enemy id is not constrained by what it can
  // see. The rule is now explicit on the damage path (_raceVisible in
  // attackEnemy/skillAttackEnemy), so this asks the server directly rather
  // than through a client.
  const room = _towerRoom();
  const mine = room.enemies.find(e => e.arm === 'race10' && e.lane === 0 && e.hp > 0);
  const theirs = room.enemies.find(e => e.arm === 'race10' && e.lane === 1 && e.hp > 0);
  ok(mine && theirs, 'two corridors have live monsters');

  const sid = 'harness_lanerule';
  room.addPlayer(sid, 'lanerule', null, null, 0, '900000001');
  room.setPlayerChar(sid, 'ranger', { lvl: 40, upgrades: {}, equipment: {} });
  const p = room.players.get(sid);
  try {
    p._raceLane = 0;
    // Stand right on top of the OTHER corridor's monster: in range, clear
    // line of sight, nothing geometric left to refuse the hit.
    p.x = theirs.x; p.y = theirs.y;
    const hpBefore = theirs.hp;
    eq(room.attackEnemy(sid, theirs.id), null, 'a basic attack on another corridor\'s monster is refused');
    eq(theirs.hp, hpBefore, 'and it takes no damage');
    eq(room.skillAttackEnemy(sid, theirs.id, 'Q'), null, 'a skill on it is refused too');
    eq(theirs.hp, hpBefore, 'still no damage');

    // The same player, same distance, against its OWN corridor: allowed.
    // The refused hits above still spent the attacker's 150ms basic-attack
    // slot (the limiter is stamped before any target check, deliberately, so
    // a client spamming refused ids is still throttled) — so wait it out,
    // or this measures the rate limit instead of the lane rule.
    await sleep(200);
    p.x = mine.x; p.y = mine.y;
    const ownBefore = mine.hp;
    const hit = room.attackEnemy(sid, mine.id);
    ok(hit && hit.dmg > 0, 'its own corridor is still perfectly attackable');
    ok(mine.hp < ownBefore, 'and that monster really takes the damage');
  } finally {
    room.removePlayer(sid);
    room._stopLoop();
  }
});

scenario('arena3: entrants are joined AT their base, not in the middle of the map', async () => {
  // Same shape the Bloody Tower had. The join that builds gameStart runs
  // before pvpArenaDeploy assigns base slots, so gameStart carried this
  // floor's default spawn — which for the arena is the CENTRE tile, right on
  // the lane between the two bases — while arena3Started carried the real
  // slot moments later. The client applies arena3Started at once but defers
  // gameStart behind the world-map fetch on a first visit, so the stale
  // centre won by arriving last and both teams appeared standing on top of
  // each other in the middle.
  const arena = require('../server/game/dungeon').generatePvpArena();
  const centre = arena.spawn;

  const players = [];
  for (let i = 0; i < 6; i++) {
    const c = await connectWithSaved(`harness_a3_pos_${i}`, { lvl: 15, xp: 0, xpNext: 100 });
    await enterWorld(c, 'ranger');
    players.push(c);
  }
  await fetch(`${BASE}/dev/arena3/open`, { method: 'POST' });

  const started = players.map(c => c.wait('arena3Started', { timeout: 8000 }));
  players.forEach(c => c.emit('arena3Register'));
  const starts = await Promise.all(started);

  players.forEach((c, i) => {
    const gs = c.last('gameStart');
    eq(gs.floor, 9, `${c.name} is on the arena floor`);
    eq(gs.spawn.x, starts[i].x, `${c.name}: gameStart agrees with arena3Started on x`);
    eq(gs.spawn.y, starts[i].y, `${c.name}: and on y`);
    ok(!(gs.spawn.x === centre.x && gs.spawn.y === centre.y),
      `${c.name} is not dropped on the centre tile`);
  });

  // The two teams start apart, which is the point of the base slots.
  const xsA = starts.filter(s => s.team === 'A').map(s => s.x);
  const xsB = starts.filter(s => s.team === 'B').map(s => s.x);
  eq(xsA.length, 3, 'three on each side');
  eq(xsB.length, 3, 'three on the other');
  ok(Math.min(...xsB) - Math.max(...xsA) > 500,
    'and the two bases really are at opposite ends', `${Math.max(...xsA)} vs ${Math.min(...xsB)}`);
  // Within a team nobody stacks on anybody.
  eq(new Set(starts.filter(s => s.team === 'A').map(s => `${s.x},${s.y}`)).size, 3,
    'teammates get distinct slots rather than the same tile');

  await Promise.all(players.map(c => c.close()));
});

scenario('arena3: the queue counter reaches people who have NOT signed up', async () => {
  // The counter on the panel is the one number that moves because of what
  // OTHER people do, and _a3Broadcast only ever pushed it to the queue and to
  // players already in a match. So somebody sitting on the panel deciding
  // whether to join watched a figure that never changed — "счётчик записанных
  // неправильно считается". It was not wrong when sent, it was never re-sent.
  const watcher = await connectWithSaved('harness_a3_watch', { lvl: 15, xp: 0, xpNext: 100 });
  const joiner  = await connectWithSaved('harness_a3_join',  { lvl: 15, xp: 0, xpNext: 100 });
  await enterWorld(watcher, 'ranger');
  await enterWorld(joiner, 'mage');
  await fetch(`${BASE}/dev/arena3/open`, { method: 'POST' });

  // The watcher asks once, the way opening the panel does, and then does
  // nothing else at all.
  const first = watcher.wait('arena3State', { timeout: 4000 });
  watcher.emit('arena3Sync');
  const before = await first;
  const baseline = before.queued;

  // Somebody else signs up. The watcher must hear about it without asking.
  const pushed = watcher.wait('arena3State', { timeout: 4000 });
  joiner.emit('arena3Register');
  const after = await pushed;
  eq(after.queued, baseline + 1, 'an unregistered onlooker is told the queue grew');
  ok(!after.registered, 'and is not told it is registered itself');

  // And shrinking is pushed too.
  const shrunk = watcher.wait('arena3State', { timeout: 4000 });
  joiner.emit('arena3Unregister');
  eq((await shrunk).queued, baseline, 'and told when it shrinks again');

  await watcher.close(); await joiner.close();
});

scenario('arena3: the arena holds no bosses — the match is players only', async () => {
  // The two stationary guard bosses are gone: no spawn, no geometry, no
  // sprite entry, and no "destroy the enemy's to win instantly" shortcut. A
  // match is decided by wiping the other side and nothing else.
  const arena = require('../server/game/dungeon').generatePvpArena();
  eq(arena.enemies.length, 0, 'the arena floor is generated with no enemies at all');
  ok(!('bossA' in arena.pvpArena) && !('bossB' in arena.pvpArena),
    'and carries no boss placements', JSON.stringify(Object.keys(arena.pvpArena)));

  const Room = require('../server/game/Room');
  const { FLOOR_IDS } = require('../server/game/floors');
  const _io = { to: () => ({ emit() {} }), sockets: { sockets: { get: () => null } } };
  const room = new Room(FLOOR_IDS.pvpArena, _io, {}, null);
  try {
    eq(room.enemies.length, 0, 'and its live Room has none either');
    eq(typeof room.spawnPvpArenaBosses, 'undefined', 'the spawn helper is gone, not just unused');
    eq(typeof room.despawnPvpArenaBosses, 'undefined', 'and so is its teardown');
  } finally {
    room._stopLoop();
  }

  // A real match still runs and still ends by elimination.
  const players = [];
  for (let i = 0; i < 6; i++) {
    const c = await connectWithSaved(`harness_a3_nb_${i}`, { lvl: 15, xp: 0, xpNext: 100 });
    await enterWorld(c, 'ranger');
    players.push(c);
  }
  await fetch(`${BASE}/dev/arena3/open`, { method: 'POST' });
  const started = players.map(c => c.wait('arena3Started', { timeout: 8000 }));
  players.forEach(c => c.emit('arena3Register'));
  const starts = await Promise.all(started);
  ok(starts.every(s => s && s.bossIds === undefined), 'arena3Started no longer carries boss ids');

  // Wipe one whole side; the other must be declared the winner.
  const teamOf = new Map(players.map((c, i) => [c, starts[i].team]));
  const losers = players.filter(c => teamOf.get(c) === 'A');
  const results = players.map(c => c.wait('arena3Result', { timeout: 8000 }).catch(() => null));
  for (const c of losers) { c.emit('respawn'); await sleep(150); }
  const res = await Promise.all(results);
  ok(res.every(r => r), 'everyone gets a result');
  players.forEach((c, i) => {
    eq(res[i].won, teamOf.get(c) === 'B', `${c.name} (team ${teamOf.get(c)}) has the right outcome`);
  });

  await Promise.all(players.map(c => c.close()));
});

scenario('season ticket: purchase charges 15 GRAM flat, pays shop points, and doubles kill xp', async () => {
  const buyer = await connectWithSaved('harness_ticket_buy', { gramBalance: 100 });
  await enterWorld(buyer, 'ranger');

  const bought = buyer.wait('gramShopResult', { timeout: 6000 });
  const shopPts = buyer.wait('seasonEventDone', { timeout: 6000 });
  buyer.emit('gramShopBuy', { pkgId: 'season_ticket' });
  const res = await bought;
  eq(res && res.newBalance, 85, 'the flat 15 GRAM price was charged — no 30% discount');
  const shopEvt = await shopPts;
  eq(shopEvt && shopEvt.task, 'shop_buy', 'the purchase paid season shop points, not a market-buy award');
  eq(shopEvt && shopEvt.points, 1500, '100 season points per GRAM spent (15 GRAM x 100)');

  await sleep(200);
  const row = memory.__dump('Player').find(p => p.username === buyer.auth.username);
  eq(row.savedData.seasonTicket, true, 'the ticket flag persisted to the account');
  eq(row.savedData.seasonPoints2, 1500, 'and the season points landed in savedData.seasonPoints2');

  // One per account — a second attempt in the same session must be refused
  // outright, not silently re-charge GRAM for no extra effect.
  const secondAttempt = buyer.wait('gramShopError', { timeout: 3000 });
  buyer.emit('gramShopBuy', { pkgId: 'season_ticket' });
  const err = await secondAttempt;
  ok(err, 'a second purchase in the same session is refused');
  await sleep(200);
  const rowAfter = memory.__dump('Player').find(p => p.username === buyer.auth.username);
  eq(rowAfter.savedData.seasonPoints2, 1500, 'the refused second attempt did not award more season points');

  await buyer.close();
  await sleep(300);

  // Reconnect (the flag must survive — it's read fresh off savedData at
  // login, see socket.data.seasonTicketActive) and compare a kill's xp
  // against a plain baseline account of the same level, so the only
  // difference between the two is the ticket itself.
  const withTicket = await connectAs('harness_ticket_buy');
  const baseline = await connectWithSaved('harness_ticket_base', {});
  await enterWorld(withTicket, 'ranger');
  await enterWorld(baseline, 'ranger');

  // The refusal must hold after a fresh login too — socket.data.seasonTicketActive
  // is reloaded from savedData at connect time, not carried over in memory.
  const crossSessionAttempt = withTicket.wait('gramShopError', { timeout: 3000 });
  withTicket.emit('gramShopBuy', { pkgId: 'season_ticket' });
  const crossErr = await crossSessionAttempt;
  ok(crossErr, 'a purchase attempt after reconnecting is also refused');

  async function killWeakestAndGetXp(c) {
    const armStart = c.wait('gameStart', { where: `${c.name} enterLocation left` });
    c.emit('enterLocation', { target: 'left' });
    const start = await armStart;
    const target = (start.enemies || []).filter(e => e && (e.hp || 0) > 0).sort((x, y) => x.hp - y.hp)[0];
    if (!target) return null;
    c.emit('playerMove', { x: target.x + 20, y: target.y, facing: 1, moving: false });
    await sleep(150);
    let dead = null;
    // Room.attackEnemy floors one server hit per 150ms — pace attempts to
    // match rather than hammering faster than the server will accept.
    for (let i = 0; i < 60 && !dead; i++) {
      const hit = c.wait('enemyKilled', { timeout: 400 }).catch(() => null);
      c.emit('attack', { enemyId: target.id });
      dead = await hit;
      if (!dead) await sleep(160);
    }
    return dead;
  }

  const baseKill = await killWeakestAndGetXp(baseline);
  ok(baseKill, 'the baseline account can kill the weakest enemy in the left arm');
  const ticketKill = await killWeakestAndGetXp(withTicket);
  ok(ticketKill, 'the ticketed account can kill the weakest enemy in the left arm');
  if (baseKill && ticketKill) {
    eq(ticketKill.rlvl, baseKill.rlvl, `compared the same monster level (${baseKill.rlvl} vs ${ticketKill.rlvl})`);
    eq(ticketKill.xp, baseKill.xp * 2,
      `the season ticket exactly doubled the kill's xp reward (${baseKill.xp} -> ${ticketKill.xp})`);
  }

  await withTicket.close();
  await baseline.close();
});

scenario('admin: top-referrals ranks by GRAM earned (not headcount), and top-market ranks trading volume', async () => {
  const { token } = await fetch(`${BASE}/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  }).then(r => r.json());
  const adminGet = path => fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
  const Player = require('../server/models/Player');
  const GramTx = require('../server/models/GramTx');
  const dump = () => memory.__dump('Player');

  // ── Referrals: A has two referrals who deposited little, B has one
  // referral who deposited a lot — B must outrank A, proving the ranking is
  // by GRAM earned and not by how many accounts were referred.
  const refA = await connectAs('harness_admin_ref_a');
  const refB = await connectAs('harness_admin_ref_b');
  const kidA1 = await connectAs('harness_admin_kid_a1');
  const kidA2 = await connectAs('harness_admin_kid_a2');
  const kidB1 = await connectAs('harness_admin_kid_b1');
  await Promise.all([refA.close(), refB.close(), kidA1.close(), kidA2.close(), kidB1.close()]);
  await sleep(400);

  const rowRefA = dump().find(p => p.username === refA.auth.username);
  const rowRefB = dump().find(p => p.username === refB.auth.username);
  const rowKidA1 = dump().find(p => p.username === kidA1.auth.username);
  const rowKidA2 = dump().find(p => p.username === kidA2.auth.username);
  const rowKidB1 = dump().find(p => p.username === kidB1.auth.username);

  await Player.updateOne({ _id: rowKidA1._id }, { $set: { referredBy: rowRefA.telegramId } });
  await Player.updateOne({ _id: rowKidA2._id }, { $set: { referredBy: rowRefA.telegramId } });
  await Player.updateOne({ _id: rowKidB1._id }, { $set: { referredBy: rowRefB.telegramId } });

  await GramTx.create({ telegramId: rowKidA1.telegramId, type: 'deposit', status: 'confirmed', amount: 10 });
  await GramTx.create({ telegramId: rowKidA2.telegramId, type: 'deposit', status: 'confirmed', amount: 10 });
  await GramTx.create({ telegramId: rowKidB1.telegramId, type: 'deposit', status: 'confirmed', amount: 1000 });

  const refResult = await adminGet('/admin/top-referrals');
  const refs = refResult.referrers || [];
  const rA = refs.find(r => r.telegramId === rowRefA.telegramId);
  const rB = refs.find(r => r.telegramId === rowRefB.telegramId);
  ok(rA && rB, 'both referrers appear in the ranking');
  if (rA && rB) {
    eq(rA.count, 2, 'referrer A has 2 referred accounts');
    eq(rB.count, 1, 'referrer B has 1 referred account');
    eq(rA.bonusEarned, 1, "5% of the 20 GRAM A's referrals deposited");
    eq(rB.bonusEarned, 50, "5% of the 1000 GRAM B's single referral deposited");
    ok(refs.indexOf(rB) < refs.indexOf(rA),
      'ranked by GRAM earned, not referral count — B (1 referral, more earned) outranks A (2 referrals, less earned)');
  }

  // ── Market: a completed sale must show up for both sides — the seller's
  // sold total and the buyer's bought total.
  const seller = await connectWithSaved('harness_admin_mkt_seller', {
    vipLevel: 1, gramBalance: 0, inventory: [{ id: 'uq_sword_l', enhance: 0 }],
  });
  await enterWorld(seller, 'deathknight');
  const listed = seller.wait('marketListed', { timeout: 8000 });
  seller.emit('marketList', { item: { id: 'uq_sword_l', enhance: 0 }, price: 40 });
  const l = await listed;
  ok(l && l.listing, 'listing created for the market rating check');

  const buyer = await connectWithSaved('harness_admin_mkt_buyer', { gramBalance: 100 });
  await enterWorld(buyer, 'ranger');
  if (l && l.listing) {
    const bought = buyer.wait('marketBought', { timeout: 8000 });
    buyer.emit('marketBuy', { listingId: l.listing.id });
    await bought;
  }
  await sleep(200);

  const mktResult = await adminGet('/admin/top-market');
  const traders = mktResult.traders || [];
  const sellerRow = traders.find(row => row.username === seller.auth.username);
  const buyerRow = traders.find(row => row.username === buyer.auth.username);
  ok(sellerRow, 'the seller appears in the market rating');
  ok(buyerRow, 'the buyer appears in the market rating');
  if (sellerRow) {
    eq(sellerRow.sold, 40, "the seller's sold total is the listing price");
    eq(sellerRow.soldCount, 1, 'one completed sale');
  }
  if (buyerRow) {
    eq(buyerRow.bought, 40, "the buyer's bought total is what they paid");
    eq(buyerRow.boughtCount, 1, 'one completed purchase');
  }

  await seller.close();
  await buyer.close();
});

// ── Runner ───────────────────────────────────────────────────────────────────
(async () => {
  const filter = process.argv[2] || '';
  console.log('booting the real server against the in-memory database...\n');
  require(path.join(ROOT, 'server', 'index.js'));
  // Give the HTTP listener and the room loops a moment to come up.
  await sleep(900);

  for (const s of scenarios) {
    if (filter && !s.name.includes(filter)) continue;
    const before = results.length;
    try {
      await s.fn();
      const mine = results.slice(before);
      const bad = mine.filter(r => r[0] === 'FAIL');
      const skips = mine.filter(r => r[0] === 'SKIP');
      // A scenario that asserted nothing but a skip gets its own mark. A ✓ over
      // it is the whole problem: it reads as "this was checked", and for the
      // browser scenarios on a machine with no chromium it never was.
      const nothingRan = skips.length > 0 && skips.length === mine.length;
      console.log(`${bad.length ? '✗' : nothingRan ? '–' : '✓'} ${s.name}`);
      mine.forEach(([st, msg, detail]) => {
        if (st === 'FAIL') console.log(`    FAIL ${msg}${detail ? ' — ' + detail : ''}`);
        else if (st === 'SKIP') console.log(`    SKIP ${msg}`);
      });
    } catch (err) {
      failed++;
      console.log(`✗ ${s.name}\n    THREW ${err.message}`);
    }
  }

  // Any handler that threw during any scenario, however unrelated.
  const uniqueErrors = [...new Set(handlerErrors)];
  if (uniqueErrors.length) {
    failed += uniqueErrors.length;
    console.log('\n✗ socket handlers threw (safeOn swallowed these, the client saw nothing):');
    uniqueErrors.forEach(e => console.log('    ' + e));
  }

  // Skipped is its own column, never folded into passed. A run that could not
  // start a browser now says so on the bottom line instead of adding eighteen
  // to a number a reader takes for coverage. CHROMIUM_PATH is named because it
  // is the fix, and chromiumPath() reads it.
  console.log(`\n${passed} passed, ${failed} failed`
    + (skipped ? `, ${skipped} SKIPPED — not checked` : ''));
  if (results.some(r => r[0] === 'SKIP' && /chromium|playwright/.test(r[1]))) {
    console.log('  (set CHROMIUM_PATH to run the browser scenarios)');
  }
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.error('harness:', err);
  process.exit(1);
});

scenario('rebirth: is worth exactly REBIRTH_BONUS_SP, not a free 90 points on top', async () => {
  // The bug this pins down: a rebirth kept the upgrades a player had already
  // bought AND banked what they cost into bonusSP, which availableSkillPoints
  // reads as spendable capacity. The level curve then paid for those same
  // points a second time the moment REBIRTH_LEVEL was re-climbed — 90 free
  // points every cycle at level 30 — and Улучшения → Сбросить handed the whole
  // banked total over as well (90 + 105 = 195 where 105 is the real ceiling).
  //
  // Driven through the REAL handlers end to end: every one of the 90 points is
  // bought with spendUpgrade, the rebirth is a real rebirth with its real item
  // cost, and the re-climb goes through a real reconnect so the numbers are
  // re-read from the stored record rather than from session memory.
  const { availableSkillPoints, skillPointBudget, UPGRADE_KEYS, REBIRTH_BONUS_SP,
          REBIRTH_LEVEL, REBIRTH_COST } = require('../shared/definitions');
  const Player = require('../server/models/Player');
  const budget = skillPointBudget(REBIRTH_LEVEL, 0);
  let c = await connectWithSaved('harness_rebirth_sp', {
    lvl: REBIRTH_LEVEL, rebirths: 0, bonusSP: 0, upgrades: {},
    gold: 50_000_000, nexumBalance: 100_000,
    inventory: Object.entries(REBIRTH_COST).map(([id, qty]) => ({ id, qty })),
  });
  await enterWorld(c, 'lev');

  // What the stored record says the player may still spend — the same function
  // the panel (getAvailableSkillPoints, js/player.js) and the spendUpgrade
  // handler both use, read off the DB so nothing in memory can flatter it.
  const availNow = () => {
    const row = memory.__dump('Player').find(p => p.username === c.auth.username);
    return availableSkillPoints(row.savedData);
  };
  const spentNow = () => {
    const row = memory.__dump('Player').find(p => p.username === c.auth.username);
    return Object.values(row.savedData.upgrades || {}).reduce((s, v) => s + (Number(v) || 0), 0);
  };

  eq(availNow(), budget, `level ${REBIRTH_LEVEL} with no rebirth is worth ${budget} points`);
  for (let i = 0; i < budget; i++) {
    const sync = c.wait('progressSync', { timeout: 5000 });
    const err  = c.wait('progressError', { timeout: 5000 }).catch(() => null);
    c.emit('spendUpgrade', { key: UPGRADE_KEYS[i % UPGRADE_KEYS.length] });
    const r = await Promise.race([sync, err]);
    if (r && r.msg) break;
  }
  await sleep(200);
  eq(spentNow(), budget, `all ${budget} of them were really bought through spendUpgrade`);
  eq(availNow(), 0, 'and nothing is left to spend');

  const done = c.wait('rebirthDone', { timeout: 5000 });
  const rerr = c.wait('rebirthError', { timeout: 5000 }).catch(() => null);
  c.emit('rebirth');
  const res = await Promise.race([done, rerr]);
  ok(res && !res.msg, 'the rebirth went through', res && res.msg);
  await sleep(400);
  eq(spentNow(), budget, 'the upgrades bought before the rebirth are kept');
  eq(availNow(), REBIRTH_BONUS_SP,
     `and level 1 has exactly the flat +${REBIRTH_BONUS_SP} to spend, not the ${budget} it just lost`);

  // Re-climb to REBIRTH_LEVEL through a real reconnect — this is where the
  // banked spend used to be paid out a second time.
  await c.close();
  await sleep(300);
  let row = memory.__dump('Player').find(p => p.username === c.auth.username);
  await Player.updateOne({ _id: row._id }, { $set: { 'savedData.lvl': REBIRTH_LEVEL } });
  await sleep(80);
  c = await connectAs('harness_rebirth_sp');
  await enterWorld(c, 'lev');
  await sleep(300);
  eq(spentNow(), budget, 'the kept upgrades survived the reconnect (the budget check did not wipe them)');
  eq(availNow(), REBIRTH_BONUS_SP,
     `back at level ${REBIRTH_LEVEL} the curve pays for the KEPT points, not for a second copy of them`);

  // ...and a reset now hands back this level's real ceiling, not that plus the
  // banked total on top.
  const rst = c.wait('upgradesReset', { timeout: 5000 });
  const rsterr = c.wait('resetUpgradesError', { timeout: 5000 }).catch(() => null);
  c.emit('resetUpgrades');
  const r2 = await Promise.race([rst, rsterr]);
  ok(r2 && !r2.msg, 'the reset went through', r2 && r2.msg);
  await sleep(400);
  eq(spentNow(), 0, 'the upgrades map is empty');
  eq(availNow(), budget + REBIRTH_BONUS_SP,
     `and everything spendable at level ${REBIRTH_LEVEL} with one rebirth is ${budget + REBIRTH_BONUS_SP}, no more`);
  await c.close();
});

scenario('rebirth: a record that banked the kept spend into bonusSP is repaired at login', async () => {
  // Accounts that rebirthed before keptSP existed carry the kept upgrades' cost
  // inside bonusSP — a level-30 one-rebirth character with 90 points invested
  // shows bonusSP 105, and availableSkillPoints reads 105 of those as free.
  // migrateKeptSP (shared/definitions.js) splits it at login, once, without
  // changing the sum, so the upgrades still clear the anti-cheat ceiling.
  const { availableSkillPoints, REBIRTH_BONUS_SP, REBIRTH_LEVEL } = require('../shared/definitions');
  const legacy = {
    lvl: REBIRTH_LEVEL, rebirths: 1, bonusSP: 105,
    upgrades: { atk: 30, def: 30, hp: 30 },       // 90 points, kept across the rebirth
  };
  const Player = require('../server/models/Player');
  let c = await connectWithSaved('harness_rebirth_legacy', legacy);
  // A real legacy record has no keptSP field AT ALL — which is exactly what
  // makes the repair a one-off. connectWithSaved's own seeding login has
  // already written one, so it has to go before the login under test.
  await c.close();
  await sleep(500);
  const seeded = memory.__dump('Player').find(p => p.username === c.auth.username);
  const set = {};
  for (const [k, v] of Object.entries(legacy)) set['savedData.' + k] = v;
  await Player.updateOne({ _id: seeded._id },
    { $set: set, $unset: { 'savedData.keptSP': '' } });
  await sleep(80);
  c = await connectAs('harness_rebirth_legacy');
  await enterWorld(c, 'lev');
  await sleep(400);
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  const sd = row.savedData;
  eq(sd.keptSP, 90, 'the banked spend moved into keptSP');
  eq(sd.bonusSP, REBIRTH_BONUS_SP, 'and bonusSP is back to the rebirth reward it should have been');
  eq(Object.values(sd.upgrades || {}).reduce((s, v) => s + v, 0), 90,
     'the kept upgrades were not wiped by the budget check');
  eq(availableSkillPoints(sd), REBIRTH_BONUS_SP,
     `so the character has ${REBIRTH_BONUS_SP} to spend, not the 105 the banked bonus used to show`);
  await c.close();
});

scenario('farm2: the daily minute allowance is charged for time actually spent, cap included', async () => {
  // The bug: minutes were only ever charged by a 60s ticker, so anything
  // shorter than a whole minute was free — and the LAST minute of a capped run
  // was free too, because the cap timer and the ticker's final tick fall on the
  // same millisecond and the cap timer (created first) ends the run and clears
  // the interval before that tick can fire. A player ejected at the cap
  // therefore still held the minute they had just spent, walked straight back
  // in with it, was ejected again a minute later having again been charged
  // nothing: "1 minute left" that never ran out, forever.
  //
  // Both halves are checked here against the REAL handlers: a short visit, and
  // a run that sits through its whole remaining allowance.
  const { FARM2_DAILY_MINUTES } = require('../shared/definitions');
  const today = new Date().toISOString().slice(0, 10);
  const minutesUsedBy = c => {
    const row = memory.__dump('Player').find(p => p.username === c.auth.username);
    const rec = row.savedData.farm2Minutes;
    return rec && rec.date === today ? rec.minutes : 0;
  };
  // A full party of three, all seeded with the same already-spent allowance.
  const trio = async (tag, used) => {
    const seed = { lvl: 30, xp: 0, xpNext: 100, farm2Minutes: { date: today, minutes: used } };
    const cs = [];
    for (const n of ['l', '1', '2']) cs.push(await connectWithSaved(`harness_f2m_${tag}_${n}`, seed));
    for (const c of cs) await enterWorld(c, 'ranger');
    return cs;
  };
  const start = async ([leader, m1, m2]) => {
    leader.emit('farm2GroupCreate');
    await leader.wait('farm2GroupState', { timeout: 3000 });
    m1.emit('farm2GroupJoin', { leaderId: leader.sock.id });
    await m1.wait('farm2GroupState', { timeout: 3000 });
    m2.emit('farm2GroupJoin', { leaderId: leader.sock.id });
    await m2.wait('farm2GroupState', { timeout: 3000 });
    const started = leader.wait('farm2Started', { timeout: 5000 });
    const err = leader.wait('farm2Error', { timeout: 5000 }).catch(() => null);
    leader.emit('farm2GroupStart');
    return Promise.race([started, err]);
  };

  // ── A short visit costs a minute, not nothing ────────────────────────────
  const short = await trio('short', FARM2_DAILY_MINUTES - 2);   // two minutes left
  const startedShort = await start(short);
  ok(startedShort && !startedShort.msg, 'the trio is inside', startedShort && startedShort.msg);
  await sleep(1200);
  // Walking out ends this membership and cascades the other two out with it.
  short[0].emit('enterLocation', { target: 'hub' });
  await sleep(900);
  short.forEach((c, i) => eq(minutesUsedBy(c), FARM2_DAILY_MINUTES - 1,
    `${['leader', 'member 1', 'member 2'][i]} was charged the minute they started, not nothing`));
  for (const c of short) await c.close();

  // ── A run that sits through its whole allowance charges all of it ────────
  const capped = await trio('cap', FARM2_DAILY_MINUTES - 1);    // one minute left
  const startedCap = await start(capped);
  ok(startedCap && !startedCap.msg, 'a second trio starts with a single minute left', startedCap && startedCap.msg);
  eq(startedCap.minutesLeft, 1, 'and the server sizes the run at that one minute');
  // The cap fires 60s in — this is the wait the bug was hiding behind.
  const fin = await capped[0].wait('farm2Finished', { timeout: 75000 });
  eq(fin && fin.reason, 'timeCap', 'the cap ejects the player from the zone');
  await sleep(800);
  capped.forEach((c, i) => eq(minutesUsedBy(c), FARM2_DAILY_MINUTES,
    `${['leader', 'member 1', 'member 2'][i]}'s allowance is fully spent, so the last minute was not free`));

  // ...and with nothing left, the zone will not take them again.
  const denied = capped[0].wait('farm2Error', { timeout: 3000 });
  const reopened = capped[0].wait('farm2GroupState', { timeout: 3000 }).catch(() => null);
  capped[0].emit('farm2GroupCreate');
  const res = await Promise.race([denied, reopened]);
  ok(res && res.msg && /закончилось/.test(res.msg),
     'a fresh run is refused rather than handing back the same minute again', JSON.stringify(res));
  for (const c of capped) await c.close();
});

scenario('drops: every skill and passive book is reachable from monsters in BOTH halves of the dungeon', async () => {
  // The pools used to be split by zone: base skill books and the offense
  // class passives in arms 1-2, advanced books and the defense passives in
  // arms 3-4. Half the catalog therefore did not exist below level 41 — a
  // Тёмный панцирь could not drop anywhere a character under 41 could stand —
  // and the other half stopped existing above it, while base books are
  // exactly what a level-10 skill (and so the advanced unlock) still needs
  // there. Both pools cycle on the monster's own level now.
  //
  // Data-level on purpose: the drop itself is one roll in ~100k kills, so the
  // only honest thing to check is the pool a level offers — which is the same
  // shared function the server rolls from (_rollMobLoot, server/game/loot.js)
  // and the map's drop panel renders (_monsterDropBodyHtml, js/ui.js).
  const {
    CRAFT_MATS, MAX_MONSTER_LEVEL, REBIRTH_LEVEL,
    levelSkillBookPool, levelClassPassivePool, levelUniversalPassivePool,
  } = require('../shared/definitions');
  const allBooks = CRAFT_MATS.filter(m => m.skillKey || m.advSkillKey || m.passiveId);
  const poolAt = lvl => [
    ...levelSkillBookPool(lvl), ...levelClassPassivePool(lvl), ...levelUniversalPassivePool(lvl),
  ];
  const coverage = (lo, hi) => {
    const seen = new Set();
    for (let lvl = lo; lvl <= hi; lvl++) poolAt(lvl).forEach(b => seen.add(b.id));
    return allBooks.filter(b => !seen.has(b.id)).map(b => b.name);
  };
  const earlyGap = coverage(1, 40);
  const lateGap  = coverage(41, MAX_MONSTER_LEVEL);
  eq(earlyGap.length, 0, `every book drops somewhere in levels 1-40 (missing: ${earlyGap.join(', ')})`);
  eq(lateGap.length, 0, `every book drops somewhere in levels 41-${MAX_MONSTER_LEVEL} (missing: ${lateGap.join(', ')})`);
  // The reported one, by name, at a level the reporter could actually reach.
  const darkCarapace = allBooks.find(b => b.id === 'book_pas_dkdef');
  const dropsIt = [];
  for (let lvl = 1; lvl <= REBIRTH_LEVEL; lvl++) if (poolAt(lvl).some(b => b === darkCarapace)) dropsIt.push(lvl);
  ok(dropsIt.length > 0,
     `${darkCarapace.name} drops below level ${REBIRTH_LEVEL} (levels ${dropsIt.slice(0, 5).join(', ')}...)`);

  // Cycling, not widening: a bigger pool per kill would quietly divide every
  // book's own odds, since the roll picks one entry at random.
  const shapes = new Set();
  for (let lvl = 1; lvl <= MAX_MONSTER_LEVEL; lvl++) {
    shapes.add([levelSkillBookPool(lvl).length, levelClassPassivePool(lvl).length,
                levelUniversalPassivePool(lvl).length].join('/'));
  }
  eq([...shapes].join(' '), '5/5/1', 'every level still offers 5 skill + 5 class-passive + 1 universal book');
});

scenario('chat: every translate request gets an answer, whatever the upstream does', async () => {
  // Two halves of the same complaint ("переводчик пишет не удалось перевести").
  //
  // The per-connection rate limit (one translate per second) used to `return`
  // in silence. The client marks the bubble as translating the moment it asks
  // and only clears that on a reply, so a swallowed request left it stuck on
  // "…" forever — and the same flag makes every later click on that bubble a
  // no-op, so the row could never be retried either.
  //
  // The upstream half cannot be asserted on: translate.googleapis.com is an
  // undocumented free endpoint that throttles per IP, so whether it answers a
  // given run is genuinely not this repo's business. What IS asserted is that
  // the answer comes back either way, and that a refusal is labelled
  // 'unavailable' rather than surfacing as a bare failure.
  const c = await connectWithSaved('harness_translate', { lvl: 5 });
  await enterWorld(c, 'ranger');

  const ask = (reqId, text) => {
    const p = c.wait('translateChatResult', { timeout: 30000, match: r => r && r.reqId === reqId });
    c.emit('translateChat', { text, target: 'en', reqId });
    return p;
  };

  const first = await ask('t1', 'привет как дела');
  ok(first && (typeof first.text === 'string' || first.error),
     'a translate request is answered');
  if (first.error) {
    eq(first.reason, 'unavailable', 'and an upstream refusal says so rather than failing bare');
    console.log('   (upstream declined this run — the rate-limit half below is what matters here)');
  } else {
    ok(first.text.length > 0, `the translation came back non-empty (${first.text})`);
    // Same text again: served from the server's own cache now, which is what
    // keeps the shared server IP under Google's per-IP throttle.
    await sleep(1100);
    const again = await ask('t2', 'привет как дела');
    eq(again.text, first.text, 'the same text translates to the same thing (cache hit)');
  }

  // Two in the same tick: the second one trips the 1s limit. Both must be
  // answered — that is the bug this pins.
  await sleep(1100);
  const a = c.wait('translateChatResult', { timeout: 30000, match: r => r && r.reqId === 'burst1' });
  const b = c.wait('translateChatResult', { timeout: 30000, match: r => r && r.reqId === 'burst2' });
  c.emit('translateChat', { text: 'доброе утро', target: 'en', reqId: 'burst1' });
  c.emit('translateChat', { text: 'добрый вечер', target: 'en', reqId: 'burst2' });
  const [r1, r2] = await Promise.all([a, b]);
  ok(r1, 'the first of a burst is answered');
  ok(r2 && r2.error && r2.reason === 'rate',
     'and the one that tripped the rate limit is answered too, labelled as such');

  await c.close();
});

scenario('starter bonus: the free kit lands once per account and never twice', async () => {
  // The HUD's Бонус button (drawStarterBonusButton, js/ui.js) behind its real
  // handler: a full set of common armour, the common weapon of the claimer's
  // OWN class, two of every buff potion and 300 small HP potions — free, and
  // exactly once, whatever the client sends afterwards.
  const { ITEM_DEF, STARTER_BONUS, POTION_CAP } = require('../shared/definitions');
  // type seeded on the record, the way selectChar itself persists it — the
  // grant reads the class from there, not from whatever blob a client sent.
  const c = await connectWithSaved('harness_starter_bonus', { lvl: 3, inventory: [], type: 'ranger', potionBag: { pt1: 3 } });
  await enterWorld(c, 'ranger');

  const sync = c.wait('inventorySync', { timeout: 6000 });
  const bag = c.wait('potionBag', { timeout: 6000 });
  const done = c.wait('starterBonusDone', { timeout: 6000 });
  const err = c.wait('starterBonusError', { timeout: 6000 }).catch(() => null);
  c.emit('starterBonusClaim');
  const res = await Promise.race([done, err]);
  ok(res && !res.msg, 'the claim went through', res && res.msg);

  const inv = (await sync).inventory || [];
  const idsOf = list => list.map(i => i.id);
  // Every common armour slot, one each.
  ['hm1', 'ar1', 'gl1', 'bt1', 'rn1', 'nd1'].forEach(id => {
    eq(inv.filter(i => i.id === id).length, 1, `the kit contains ${id} exactly once`);
  });
  // ...and the RANGER's own common weapon, not another class's.
  eq(inv.filter(i => i.id === 'bw1').length, 1, 'and the common weapon of the claimer\'s class (bw1)');
  ok(!idsOf(inv).some(id => ['tw1', 'sw1', 'st1'].includes(id)), 'and no other class\'s weapon');
  // Two of every buff potion.
  ITEM_DEF.filter(d => d.slot === 'buff_potion').forEach(bp => {
    const got = inv.find(i => i.id === bp.id);
    eq(got && got.qty, STARTER_BONUS.buffPotions, `${bp.qty || ''}${bp.name} ×${STARTER_BONUS.buffPotions}`);
  });
  // ...and the HP potions, which live in potionBag rather than the inventory.
  const bagNow = (await bag).potionBag || {};
  eq(bagNow[STARTER_BONUS.hpPotionId], Math.min(POTION_CAP, 3 + STARTER_BONUS.hpPotions),
     `${STARTER_BONUS.hpPotions} HP potions landed in potionBag, on top of the 3 already there`);

  // Once. A second tap is refused, and nothing further reaches the inventory.
  const invLen = inv.length;
  const err2 = c.wait('starterBonusError', { timeout: 6000 });
  const done2 = c.wait('starterBonusDone', { timeout: 6000 }).catch(() => null);
  c.emit('starterBonusClaim');
  const res2 = await Promise.race([err2, done2]);
  ok(res2 && res2.msg && /уже получен/i.test(res2.msg), 'a second claim is refused', JSON.stringify(res2));
  await sleep(400);
  const row = memory.__dump('Player').find(p => p.username === c.auth.username);
  eq(row.savedData.starterBonus, true, 'the claim flag is stored');
  eq((row.savedData.inventory || []).length, invLen, 'and the second claim granted nothing');

  // ...and a save that tries to clear the flag cannot buy a second kit: the
  // sanitizer drops the field outright, so the stored claim stands.
  c.emit('saveProgress', { type: 'ranger', starterBonus: false, hp: 100, maxHp: 100 });
  await sleep(3600);
  const row2 = memory.__dump('Player').find(p => p.username === c.auth.username);
  eq(row2.savedData.starterBonus, true, 'a save claiming starterBonus:false does not clear it');

  await c.close();
});
