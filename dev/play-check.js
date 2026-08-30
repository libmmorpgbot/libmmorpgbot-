#!/usr/bin/env node
'use strict';
// ── A session played the way a person plays one ─────────────────────────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/play-check.js
//   PLAY_AGAINST=https://libertymmorpg.online node dev/play-check.js
//
// Every other suite here asks a precise question. This one asks the imprecise
// one the players actually asked: is the game playable?
//
// It logs in, walks, fights, drinks, reloads, and keeps a running model of
// what would be ON SCREEN — gold, experience, potions, which monsters are
// alive — updated only from packets the server sent. Then it compares that
// model against the database. A disagreement between the two is exactly what
// "балансы то есть то нету" and "монстры багнутые" describe: the screen and
// the truth drifting apart.
//
// It can also be pointed at the deployed server, which is the only way to
// answer "is the thing they are testing the thing I fixed".

const crypto = require('crypto');
const io = require('socket.io-client');
const { decodeGameState } = require('../shared/netcodec');

const REMOTE = process.env.PLAY_AGAINST || null;
const PORT = Number(process.env.PLAY_PORT || 3181);
if (!REMOTE) {
  process.env.PORT = String(PORT);
  process.env.OPS_LIVE = '0';
  process.env.NODE_ENV = 'test';
}
process.env.TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || 'test:token';

const { pool, close } = require('../server/db');
const { wipeItemsAll } = require('./fixtures');
const app = REMOTE ? null : require('../server/app');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);

const TAG = 'pl-' + String(process.pid).slice(-5);
const TG = 930000000 + (process.pid % 1000);
const BASE = REMOTE || `http://127.0.0.1:${PORT}`;
let madeId = null;
let second = null;

function initData(id, username) {
  const user = JSON.stringify({ id, first_name: username, username });
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AA', user });
  const c = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const s = crypto.createHmac('sha256', 'WebAppData').update(process.env.TG_BOT_TOKEN).digest();
  p.set('hash', crypto.createHmac('sha256', s).update(c).digest('hex'));
  return p.toString();
}
const once = (sock, ev, ms = 8000) => new Promise((res, rej) => {
  const to = setTimeout(() => rej(new Error(`таймаут '${ev}'`)), ms);
  sock.once(ev, d => { clearTimeout(to); res(d); });
});
const wait = ms => new Promise(r => setTimeout(r, ms));
const wait0 = w => `хвиля ${w.wave}/${w.maxWave}`;

// ── the screen ──────────────────────────────────────────────────────────────
// Everything below is updated ONLY from packets, exactly as the client updates
// itself. Nothing here reads the database; that is the whole point.
function makeScreen(sock) {
  const scr = {
    gold: 0, gram: 0, nexum: 0, lvl: 1, xp: 0,
    potions: {}, inventory: [], equipment: {},
    enemies: new Map(),          // id -> { x, y, hp, alive }
    kills: 0, xpGained: 0, goldGained: 0,
    x: 0, y: 0, corrections: 0,
    events: new Map(),
  };
  const count = ev => scr.events.set(ev, (scr.events.get(ev) || 0) + 1);

  sock.onAny(ev => count(ev));

  sock.on('authOk', a => {
    const sd = a.savedData || {};
    scr.gold = sd.gold || 0; scr.lvl = sd.lvl || 1; scr.xp = sd.xp || 0;
    scr.potions = { ...(sd.potionBag || {}) };
    scr.inventory = sd.inventory || [];
    scr.equipment = sd.equipment || {};
    scr.gram = a.gramBalance || 0; scr.nexum = a.nexumBalance || 0;
  });
  sock.on('goldSync', ({ gold } = {}) => { if (Number.isFinite(gold)) scr.gold = gold; });
  sock.on('gramBalanceUpdate', ({ balance } = {}) => { if (balance != null) scr.gram = balance; });
  sock.on('nexumBalanceUpdate', ({ balance } = {}) => { if (balance != null) scr.nexum = balance; });
  sock.on('xpSync', st => { if (st && Number.isFinite(st.lvl)) { scr.lvl = st.lvl; scr.xp = st.xp; } });
  sock.on('potionBag', ({ potionBag } = {}) => { if (potionBag) scr.potions = { ...potionBag }; });
  sock.on('inventorySync', inv => {
    if (inv && inv.inventory) { scr.inventory = inv.inventory; scr.equipment = inv.equipment || {}; }
  });

  sock.on('gameStart', g => {
    scr.floor = g.floor;
    scr.enemies.clear();
    if (g.spawn) { scr.x = g.spawn.x; scr.y = g.spawn.y; }
    for (const e of (g.enemies || [])) scr.enemies.set(e.id, { x: e.x, y: e.y, hp: e.hp, alive: e.hp > 0 });
  });
  // The server corrects a step it will not accept. A client that ignores this
  // walks on in its own imagination and never reaches anything.
  sock.on('posCorrect', ({ x, y } = {}) => { scr.x = x; scr.y = y; scr.corrections++; });
  sock.on('gameState', data => {
    const st = (data instanceof ArrayBuffer || ArrayBuffer.isView(data) || Buffer.isBuffer(data))
      ? decodeGameState(data) : data;
    for (const e of ((st && st.enemies) || [])) {
      const prev = scr.enemies.get(e.id) || {};
      scr.enemies.set(e.id, { x: e.x, y: e.y, hp: e.hp, alive: e.hp > 0, aggro: e.aggro, moved: prev.x !== e.x || prev.y !== e.y });
    }
  });
  sock.on('enemyHurt', ({ id, hp } = {}) => {
    const e = scr.enemies.get(id); if (e) { e.hp = hp; e.alive = hp > 0; }
  });
  sock.on('enemyKilled', k => {
    // What the client does: remove the body, add the reward.
    scr.enemies.delete(k.id);
    scr.kills++;
    if (Number.isFinite(k.goldTotal)) scr.gold = k.goldTotal;
    scr.goldGained += k.gold || 0;
    scr.xpGained += k.xp || 0;
  });
  sock.on('enemiesRemoved', ({ ids } = {}) => { for (const id of (ids || [])) scr.enemies.delete(id); });
  // Which species died. The kill packet carries `eid`, which is what lets the
  // quest section below pick a quest the bot can actually finish.
  scr.killedEids = [];
  sock.on('enemyKilled', k => { if (k && k.eid) scr.killedEids.push(k.eid); });
  scr.questSyncs = [];
  sock.on('questSync', q => scr.questSyncs.push(q));
  scr.fearWaves = [];
  sock.on('fearWave', w => scr.fearWaves.push(w));
  return scr;
}

async function connect(name) {
  const sock = io(BASE, { transports: ['websocket'], forceNew: true });
  await once(sock, 'connect');
  const scr = makeScreen(sock);
  sock.emit('loginTelegramWebApp', { initData: initData(TG, name) });
  const auth = await once(sock, 'authOk', 12000);
  await wait(150);
  return { sock, scr, auth };
}

async function main() {
  console.log(`\nplay-check  (${TAG})  →  ${BASE}\n`);
  if (app) { await app.boot(); console.log(''); }

  // ── logging in ───────────────────────────────────────────────────────────
  console.log('  ── вхід ──');
  const a = await connect(`${TAG}_player`);
  const { rows } = await pool().query('SELECT id FROM players WHERE telegram_id = $1', [String(TG)]);
  ok(rows.length > 0, 'акаунт створено в базі');
  madeId = Number(rows[0].id);

  ok(!!a.auth.savedData, 'клієнт отримав savedData — без нього персонаж порожній');

  // ── the packet the client destructures TWELVE names out of ───────────────
  // Six of them were missing, and every one has a `|| default` behind it, so
  // nothing threw: VIP 9 drew as VIP 0 on every reload, the clan panel was
  // empty for every member, the referral link was blank. Presence of the KEY
  // is the assertion — the values are per-account and mostly zero for a fresh
  // one, and it is the key's absence that produced every symptom.
  for (const k of ['vipData', 'refLink', 'seasonTicketActive', 'vipAuras', 'clanInfo']) {
    ok(k in a.auth, `authOk несе '${k}' — без нього панель малює свій дефолт`);
  }
  ok(a.auth.vipData && typeof a.auth.vipData.level === 'number'
     && Array.isArray(a.auth.vipData.pending),
    'vipData має рівень і список незібраних нагород');
  eq(a.scr.potions.pt1, 30, `на екрані 30 зіль (${JSON.stringify(a.scr.potions)})`);
  eq(a.scr.lvl, 1, 'рівень 1');

  a.sock.emit('selectChar', { type: 'deathknight' });
  const start = await once(a.sock, 'gameStart', 12000);
  ok(!!start.spawn, 'персонаж має де зʼявитись');
  // `(start.enemies || []).length >= 0` is true for a missing field, a null,
  // a number and an empty array alike — the `|| []` made sure of it. What the
  // client needs is the ARRAY: it iterates `g.enemies` on every gameStart, and
  // the hub legitimately has none, so the count cannot be the assertion and
  // the type has to be.
  ok(Array.isArray(start.enemies),
    `у стартовому пакеті масив ворогів (${(start.enemies || []).length})`);

  // ── the world moves ──────────────────────────────────────────────────────
  // A floor with monsters on it. Whether they animate is the whole of
  // "монстры багнутые": a client that never receives a position update draws
  // them standing still forever.
  console.log('  ── світ рухається ──');
  await pool().query('UPDATE player_progress SET lvl = 30 WHERE player_id = $1', [madeId]);
  a.sock.emit('enterLocation', { target: 'left' });
  const arm = await once(a.sock, 'gameStart', 12000);
  eq(arm.floor, 2, 'перехід у руку відбувся');
  ok((arm.enemies || []).length > 0, `на руці видно ворогів (${(arm.enemies || []).length})`);
  await wait(2500);

  // Printed, not asserted, and that is the point of writing it down.
  //
  // Both numbers are ZERO here, and they are supposed to be. The arm entrance
  // is where the bot spawns; ENEMY_AOI_R decides what the server SENDS (plus
  // every boss regardless of distance, Room.js:2432), while aggroR — 175 to
  // 250px — decides what acts. Forty-three monsters on screen and none of them
  // moving is those two radii doing their jobs, not the bug it looks like.
  //
  // It looks like the bug because it is what the report describes: "підходиш
  // до них вони стоять не чіпають". The difference is the walk. The real
  // assertion is a hundred lines below, after the bot has moved into range,
  // and it is the one that would catch a genuinely dead AI.
  //
  // Left as a log line because an assertion here fails on correct behaviour,
  // and because the next person to notice these two numbers should find the
  // reason rather than repeat the mistake.
  const seenMoving = [...a.scr.enemies.values()].filter(e => e.moved).length;
  const seenAggro = [...a.scr.enemies.values()].filter(e => e.aggro).length;
  console.log(`        на вході в руку: ${a.scr.enemies.size} монстрів видно, `
    + `${seenMoving} рухається, ${seenAggro} агресивних — очікувано 0 і 0, гравець поза aggroR`);

  // ── walking and fighting ─────────────────────────────────────────────────
  // The bot navigates badly — it has no pathfinding and the arms have walls —
  // so it walks EAST from the spawn, which is a corridor, and fights whatever
  // it meets. That is a smaller claim than "the bot can play the game", and it
  // is the one this can actually prove: a step is accepted, a swing lands, a
  // monster dies, the reward arrives.
  //
  // Two earlier versions of this measured the map instead of the game. One
  // swung at monsters 1400px away, because that is the interest radius and a
  // sword reaches 350. The other walked at 321px/s into a wall, collected 43
  // position corrections and never arrived. Both read as a broken server.
  console.log('  ── ходьба ──');
  const before = { gold: a.scr.gold, xp: a.scr.xpGained };
  const startX = a.scr.x;
  let hurt = 0, swings = 0;
  a.sock.on('enemyHurt', () => hurt++);

  for (let i = 0; i < 70; i++) {
    a.scr.x += 5;                                        // ~180px/s, under the cap
    a.sock.emit('mv', [Math.round(a.scr.x * 2), Math.round(a.scr.y * 2), 0, 100, 1]);
    await wait(30);
  }
  await wait(300);
  ok(a.scr.corrections === 0,
    `сервер прийняв усі 70 кроків коридором (корекцій ${a.scr.corrections})`);

  // ── where the SERVER thinks the player is ────────────────────────────────
  // `a.scr.x - startX > 250` measured the loop above: it is this file that
  // writes `a.scr.x += 5`, seventy times, and then reads it back. A server
  // that dropped every 'mv' packet on the floor passed both assertions — no
  // corrections, because it sent nothing, and 350px of travel, because the
  // bot moved its own model.
  //
  // Nothing in the ordinary stream can settle it: gameState never carries a
  // player's own entry back to their own socket (Room.js says so where it
  // pushes pvpModeSync by hand for the same reason), so the client's idea of
  // its own position is always local. posCorrect is the one packet that
  // reports the server's copy — and one step off the edge of the map is
  // guaranteed to produce it, because _isWall() calls everything outside the
  // grid a wall and updatePlayerPos answers a refusal with the LAST GOOD
  // POSITION. Which is the number wanted here.
  // Read BEFORE the probe: the posCorrect handler in makeScreen re-anchors
  // scr.x to whatever the server sent, so comparing the two afterwards would
  // be comparing the reply against itself.
  const screenX = a.scr.x;
  const anchored = once(a.sock, 'posCorrect', 4000).catch(() => null);
  a.sock.emit('mv', [Math.round((screenX + 500000) * 2), Math.round(a.scr.y * 2), 0, 100, 1]);
  const anchor = await anchored;
  ok(!!anchor, 'крок за межі карти повернувся корекцією — сервер узагалі читає пакети руху');
  ok(anchor && anchor.x - startX > 250,
    `і сервер справді пересунув гравця на ${Math.round((anchor ? anchor.x : startX) - startX)}px`);
  ok(anchor && Math.abs(anchor.x - screenX) < 1,
    `сервер і екран стоять в одній точці (${anchor && Math.round(anchor.x)} проти ${Math.round(screenX)})`);
  a.scr.corrections = 0;      // the probe's own correction is not a rejected step

  await wait(1500);
  const nowAggro = [...a.scr.enemies.values()].filter(e => e.aggro).length;
  const nowMoving = [...a.scr.enemies.values()].filter(e => e.moved).length;
  ok(a.scr.events.get('gameState') > 10,
    `потік світу йде (${a.scr.events.get('gameState')} пакетів)`);
  // THE check for "моби тупо стоять афк". Not at the arm entrance — see the
  // log line above — but here, after the bot has walked into aggroR. An OR
  // rather than an AND: a monster that has closed the distance and is standing
  // still hitting the player is aggro'd and not moving, which is correct.
  ok(nowMoving > 0 || nowAggro > 0,
    `монстри оживають на екрані (рухались ${nowMoving}, агресивних ${nowAggro})`,
    'жоден не зрушив і жоден не зааґрився за 1.5 с у радіусі — ШІ не працює');

  console.log('  ── бій ──');
  let killedOnScreen = 0;
  for (let n = 0; n < 60 && killedOnScreen < 4; n++) {
    let best = null, bestD = Infinity;
    for (const [id, e] of a.scr.enemies) {
      if (!e.alive) continue;
      const d = Math.hypot(e.x - a.scr.x, e.y - a.scr.y);
      if (d < bestD) { bestD = d; best = id; }
    }
    if (!best) break;
    if (bestD > 320) {                                   // step toward it
      const e = a.scr.enemies.get(best);
      const dx = e.x - a.scr.x, dy = e.y - a.scr.y, d = Math.hypot(dx, dy);
      a.scr.x += (dx / d) * 5; a.scr.y += (dy / d) * 5;
      a.sock.emit('mv', [Math.round(a.scr.x * 2), Math.round(a.scr.y * 2), 0, 100, 1]);
      await wait(30);
      continue;
    }
    a.sock.emit('attack', { enemyId: best });
    swings++;
    await wait(180);
    if (!a.scr.enemies.has(best)) killedOnScreen++;
  }
  await wait(900);

  ok(swings > 0, `бот дійшов на відстань удару (${swings} замахів)`);
  ok(hurt > 0 || a.scr.kills > 0, `удари доходять (${hurt} влучань, ${a.scr.kills} вбивств)`);
  ok(a.scr.kills > 0, `вбивства доходять до екрана (${a.scr.kills})`);
  ok(killedOnScreen > 0, `трупи зникають з екрана (${killedOnScreen}) — «после смерти не исчезают»`);
  // Not "gold > 0": a low-level monster can legitimately roll nothing, and an
  // assertion that depends on a die is one that will fail on a day when
  // nothing is wrong — after which nobody believes it. What must hold is that
  // whatever DID arrive matches the database, and that is checked below.
  //
  // `goldGained >= 0` was not that assertion. goldGained starts at zero and
  // only ever has `k.gold || 0` added to it, so it is >= 0 by construction and
  // the line printed a number without asking anything of it. The claim that
  // survives a zero roll is the ARITHMETIC: the running total the screen draws
  // (set from each packet's goldTotal) has to be the starting balance plus the
  // per-kill amounts those same packets reported. A goldTotal that disagrees
  // with its own deltas is "золото то есть то нету" exactly.
  eq(a.scr.gold, before.gold + a.scr.goldGained,
    `екранний підсумок = початок + сума з пакетів (${before.gold} + ${a.scr.goldGained})`);
  ok(a.scr.xpGained > 0, `досвід за бій дійшов (+${a.scr.xpGained}) — «опыт не идёт»`);

  // ── the screen agrees with the truth ─────────────────────────────────────
  // This is "балансы то есть то нету" stated precisely: what is drawn and what
  // is stored must be the same number.
  console.log('  ── екран проти бази ──');
  await wait(600);
  const { rows: bal } = await pool().query(
    `SELECT currency, amount FROM balances WHERE player_id = $1`, [madeId]);
  const db = Object.fromEntries(bal.map(r => [r.currency, Number(r.amount)]));
  // The one that caught "золото то есть то нету": a monster that rolls no gold
  // used to report a balance of zero, and the number on screen vanished until
  // the next monster that happened to pay.
  eq(a.scr.gold, db.gold || 0, `золото на екрані = золото в базі (${a.scr.gold})`);
  eq(a.scr.gram, db.gram || 0, 'GRAM на екрані = GRAM у базі');
  eq(a.scr.nexum, db.nexum || 0, 'Liberty на екрані = Liberty у базі');

  const { rows: pr } = await pool().query(
    'SELECT lvl, xp, potion_bag FROM player_progress WHERE player_id = $1', [madeId]);
  // The level was raised behind the client's back to reach a gated floor, so
  // the screen legitimately lags until the next push. `a.scr.lvl >= 1` said
  // nothing about that: scr.lvl starts at 1 and is only ever replaced by a
  // number the server sent, so it could not go below 1 and the line was a
  // decoration on the section that is actually about screen-versus-truth.
  //
  // The lag has a DIRECTION, and only one of the two is a bug. Behind the
  // database is the client waiting for its next xpSync; AHEAD of it is a level
  // the server never granted — the same shape as the gold that was on screen
  // and not in the ledger, which is what this whole section exists for.
  ok(a.scr.lvl <= Number(pr[0].lvl),
    `рівень на екрані (${a.scr.lvl}) не випереджає базу (${pr[0].lvl})`);

  // ── the quest chain ──────────────────────────────────────────────────────
  // Two players earned 174,000 gold between them with quest 1 of 60 still
  // reading zero of ten. The counter was bumped from `result.enemyName` — a
  // field nothing has ever set — so `if (undefined)` skipped it on every kill
  // the game has ever resolved.
  //
  // The quest is chosen from what the bot ACTUALLY KILLED a moment ago, which
  // is the only way to make this deterministic: the arm it walks through is
  // whatever the world generated, and asserting against a hard-coded species
  // would be asserting about the map.
  console.log('  ── квести ──');
  const { QUEST_DEF: QD, ENEMY_DEF: ED, questKillsFor } = require('../shared/definitions');
  const killedNames = new Set(a.scr.killedEids
    .map(eid => (ED.find(e => e.eid === eid) || {}).name).filter(Boolean));
  const qIdx = QD.findIndex(q => q.type === 'kill'
    && (q.enemies || []).some(n => killedNames.has(n)));
  if (qIdx < 0) {
    ok(false, `не знайшлось квесту під убитих (${[...killedNames].join(', ') || 'нікого'})`);
  } else {
    const qDef = QD[qIdx];
    await pool().query(
      `UPDATE player_progress SET quest_idx = $2, quest_kills = '{}'::jsonb WHERE player_id = $1`,
      [madeId, qIdx]);
    a.scr.questSyncs.length = 0;

    // One more kill of that species, through the same attack handler a player
    // uses. Hunted for rather than assumed nearby: another player clearing the
    // area is not a failure of the quest chain.
    const wantEids = new Set(qDef.enemies.map(n => (ED.find(e => e.name === n) || {}).eid));
    let questKill = false;
    for (let n = 0; n < 200 && !questKill; n++) {
      let best = null, bestD = Infinity;
      for (const [id, e] of a.scr.enemies) {
        if (!e.alive) continue;
        const d = Math.hypot(e.x - a.scr.x, e.y - a.scr.y);
        if (d < bestD) { bestD = d; best = id; }
      }
      if (!best) { await wait(200); continue; }
      if (bestD > 300) {
        const e = a.scr.enemies.get(best);
        const dx = e.x - a.scr.x, dy = e.y - a.scr.y, d = Math.hypot(dx, dy) || 1;
        a.scr.x += (dx / d) * 5; a.scr.y += (dy / d) * 5;
        a.sock.emit('mv', [Math.round(a.scr.x * 2), Math.round(a.scr.y * 2), 0, 100, 1]);
        await wait(30);
        continue;
      }
      const seen = a.scr.killedEids.length;
      a.sock.emit('attack', { enemyId: best });
      await wait(170);
      for (let i = seen; i < a.scr.killedEids.length; i++) {
        if (wantEids.has(a.scr.killedEids[i])) questKill = true;
      }
    }
    ok(questKill, `бот убив «${qDef.enemies[0]}» — ціль завдання «${qDef.title}»`);
    await wait(500);

    const { rows: qrow } = await pool().query(
      'SELECT quest_kills FROM player_progress WHERE player_id = $1', [madeId]);
    // Counted under the SPECIES ID. It used to be filed under the display name,
    // which is why quests worked in Russian and nowhere else — see the eids
    // binding in shared/definitions.js. The old name keys are read too, so a
    // run against a build from before the change still measures something.
    const counted = (qDef.eids || qDef.enemies).reduce((n, _x, i) =>
      n + questKillsFor(qDef, qrow[0].quest_kills || {}, i), 0);
    ok(counted > 0, `лічильник завдання зрушив у базі (${counted}/${qDef.count})`);
    ok(a.scr.questSyncs.length > 0,
      `клієнт дізнався про це (questSync ×${a.scr.questSyncs.length})`);

    // And the claim itself — the second, independent bug. questComplete takes
    // three arguments and was called with two, so `kills` was the wrapper
    // object and every lookup read zero: no quest could be claimed, ever.
    await pool().query(
      `UPDATE player_progress SET quest_kills = jsonb_build_object($2::text, $3::int)
        WHERE player_id = $1`, [madeId, qDef.enemies[0], qDef.count]);
    const claimed = once(a.sock, 'questClaimed', 6000).catch(() => null);
    a.sock.emit('claimQuest', { idx: qIdx });
    const cl = await claimed;
    ok(!!cl, 'завдання здається — раніше воно відмовляло за будь-яких лічильників');
    if (cl) eq(cl.nextIdx, qIdx + 1, 'ланцюжок просунувся на наступне завдання');
  }

  // ── drinking ─────────────────────────────────────────────────────────────
  console.log('  ── зілля ──');
  const potsBefore = a.scr.potions.pt1;
  a.sock.emit('usePotion', { id: 'pt1', amount: 20 });
  await once(a.sock, 'potionBag', 6000).catch(() => null);
  await wait(300);
  eq(a.scr.potions.pt1, potsBefore - 1, `випито рівно одне (${potsBefore} → ${a.scr.potions.pt1})`);
  const { rows: pr2 } = await pool().query(
    'SELECT potion_bag FROM player_progress WHERE player_id = $1', [madeId]);
  eq(a.scr.potions.pt1, Number(pr2[0].potion_bag.pt1),
    'і сумка на екрані збігається з базою');

  // ── chat and the profile card ────────────────────────────────────────────
  // Both were reported, and both need a SECOND player: a message you cannot
  // see anyone receive proves nothing, and the profile button is something you
  // press on somebody else.
  console.log('  ── чат і профіль ──');
  const TG2 = TG + 1;
  const sock2 = io(BASE, { transports: ['websocket'], forceNew: true });
  await once(sock2, 'connect');
  // The screen is never read; it is attached so the second connection drains
  // its own event stream instead of queueing it behind an unread socket.
  makeScreen(sock2);
  sock2.emit('loginTelegramWebApp', { initData: initData(TG2, `${TAG}_second`) });
  await once(sock2, 'authOk', 12000);
  const { rows: r2 } = await pool().query('SELECT id FROM players WHERE telegram_id = $1', [String(TG2)]);
  second = Number(r2[0].id);
  await pool().query('UPDATE player_progress SET lvl = 30 WHERE player_id = $1', [second]);

  // ── клас перевіряється СПИСКОМ, а не істинністю ──────────────────────────
  // `if (!CHAR_DEF[type])` пропускав будь-який ключ прототипу: CHAR_DEF —
  // звичайний об'єкт, і CHAR_DEF['constructor'] правдивий. Далі baseHP у
  // такого «класу» undefined, тож maxHp, atk і def стають NaN — а NaN <= 0
  // хибне, і персонаж не вмирає НІКОЛИ: ні від монстрів, ні в PvP. Він
  // забирає битву на смерть (нагорода в GRAM, тобто в реальних грошах),
  // арену і Башню. Його atk теж NaN, тож будь-який моб, якого він ударить,
  // стає безсмертним для всіх.
  //
  // Запис незворотний: setClass має `AND char_class IS NULL`, другого шансу
  // в акаунта нема.
  //
  // ['lev'] у списку не для повноти: ключі властивостей зводяться до рядка,
  // тож Object.hasOwn(CHAR_DEF, ['lev']) правдивий — і в char_class лягав би
  // масив. Це той випадок, який ловить лише перевірка типу.
  console.log('  ── клас: ключі прототипу ──');
  for (const bad of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty', ['lev']]) {
    const denied = once(sock2, 'authError', 3000).catch(() => null);
    const slipped = once(sock2, 'gameStart', 3000).catch(() => null);
    sock2.emit('selectChar', { type: bad });
    const e = await denied;
    ok(e && e.code === 'bad_class',
      `selectChar(${JSON.stringify(bad)}) відмовлено`,
      `відповідь: ${JSON.stringify(e)} — ключ прототипу пройшов у setClass`);
    ok(!(await slipped), `і гра не почалась з класом ${JSON.stringify(bad)}`);
  }
  // Головне: у базі НІЧОГО не записалось. Відмова, яка все одно записала
  // char_class, гірша за пропуск — акаунт після неї не відновити.
  eq((await pool().query('SELECT char_class FROM player_progress WHERE player_id = $1',
    [second])).rows[0].char_class, null,
    'жоден із них не записався в char_class');

  sock2.emit('selectChar', { type: 'mage' });
  const start2 = await once(sock2, 'gameStart', 12000);
  // Наслідок, а не лише відмова: якби хоч один ключ пройшов, справжній вибір
  // став би пустишкою (AND char_class IS NULL), і сюди приїхав би NaN.
  ok(start2 && start2.stats && Number.isFinite(start2.stats.maxHp) && start2.stats.maxHp > 0,
    `справжній клас дав скінченне здоров'я (${start2 && start2.stats && start2.stats.maxHp})`,
    'maxHp = NaN — NaN ніколи не <= 0, персонаж безсмертний');
  // Onto the SAME floor. The profile card is deliberately only for someone
  // standing next to you — racePairAllowed refuses a pair that is not in one
  // room — so a test that leaves them on different floors is testing the
  // refusal, not the button.
  sock2.emit('enterLocation', { target: 'left' });
  await once(sock2, 'gameStart', 12000);
  await wait(400);

  const said = `привіт-${TAG}`;
  const heard = once(sock2, 'chatMsg', 6000).catch(() => null);
  a.sock.emit('chat', { text: said });
  const got = await heard;
  ok(!!got, 'повідомлення дійшло до ІНШОГО гравця');
  if (got) {
    eq(got.text, said, 'текст не спотворився');
    eq(got.username, `${TAG}_player`, 'і підписано автором');
  }

  // The rate limit is a security control on a broadcast, so it has to bite.
  const second1 = once(sock2, 'chatMsg', 1500).catch(() => null);
  a.sock.emit('chat', { text: `друге-${TAG}` });
  ok(!(await second1), 'друге повідомлення поспіль відкинуто кулдауном');

  const hist = once(a.sock, 'chatHistory', 6000).catch(() => null);
  a.sock.emit('chatHistory');
  const h = await hist;
  ok(Array.isArray(h) && h.some(m => m.text === said),
    `історія чату віддається і містить сказане (${Array.isArray(h) ? h.length : '?'} рядків)`);

  // The profile card: pressed on a NEARBY player, addressed by socket id.
  // "То кидает то нет" is what an intermittent one looks like, so it is asked
  // for three times.
  let profiles = 0;
  for (let i = 0; i < 3; i++) {
    const pr = once(a.sock, 'playerProfileResult', 5000).catch(() => null);
    a.sock.emit('requestPlayerProfile', { targetId: sock2.id });
    const res = await pr;
    if (res && res.profile) profiles++;
    await wait(120);
  }
  eq(profiles, 3, 'кнопка інфо спрацювала ТРИ рази з трьох — «то кидает то нет»');

  sock2.disconnect();
  await wait(200);

  // ── Страх: the second wave ───────────────────────────────────────────────
  // "Страх после первой волны монстры больше не появляются". Wave 1 is spawned
  // on entry; every wave after it is spawned by _fearTrackKill, and nothing in
  // the rewrite called _fearTrackKill. The run stood still forever.
  console.log('  ── Страх ──');
  a.scr.fearWaves.length = 0;
  // A refusal and a first wave are both answers; racing the refusal against a
  // TIMEOUT is not — the timeout resolves null, wins, and reads as "no wave"
  // even when the run started fine.
  let fearRefusal = null;
  a.sock.once('fearError', e => { fearRefusal = e && e.msg; });
  const w1 = once(a.sock, 'fearWave', 12000).catch(() => null);
  a.sock.emit('fearEnter');
  const wave1 = await w1;
  if (!wave1) {
    ok(false, `у Страх не пустило: ${fearRefusal || 'без відповіді'}`);
  } else {
    ok(wave1 && wave1.wave === 1, `перша хвиля почалась (${wave1 && wait0(wave1)})`);
    await wait(600);
    // Clear it. Wave 1 is global monster level 1 against a level-30 character,
    // so this is a matter of reaching them, not of surviving them.
    let wave2 = null;
    for (let n = 0; n < 900 && !wave2; n++) {
      let best = null, bestD = Infinity;
      for (const [id, e] of a.scr.enemies) {
        if (!e.alive) continue;
        const d = Math.hypot(e.x - a.scr.x, e.y - a.scr.y);
        if (d < bestD) { bestD = d; best = id; }
      }
      if (!best) { await wait(120); }
      else if (bestD > 300) {
        const e = a.scr.enemies.get(best);
        const dx = e.x - a.scr.x, dy = e.y - a.scr.y, d = Math.hypot(dx, dy) || 1;
        a.scr.x += (dx / d) * 6; a.scr.y += (dy / d) * 6;
        a.sock.emit('mv', [Math.round(a.scr.x * 2), Math.round(a.scr.y * 2), 0, 100, 1]);
        await wait(28);
      } else {
        a.sock.emit('attack', { enemyId: best });
        await wait(120);
      }
      wave2 = a.scr.fearWaves.find(w => w.wave >= 2) || null;
    }
    ok(!!wave2, `друга хвиля прийшла${wave2 ? ` (хвиля ${wave2.wave})` : ''} — «после первой волны монстры больше не появляются»`);
  }
  // Out of the instance. A Страх run is a PRIVATE room that nobody else can
  // see into, so anything left running here would fail every later section
  // that needs two players in one place.
  a.sock.emit('enterLocation', { target: 'left' });
  await once(a.sock, 'gameStart', 12000).catch(() => null);
  await wait(300);

  // ── death and the walk back ──────────────────────────────────────────────
  // "При смерти делаешь тп — кидает в то же место, где умер." Two separate
  // moves are involved and either could put a player back on their own corpse:
  // the recall stone, and the respawn itself. Both are checked against where
  // the player ACTUALLY ends up, and against what the database then holds —
  // because a respawn that looks right on screen and stores the death spot is
  // the version that bites on the next login.
  console.log('  ── смерть ──');

  // ── воскресіння ЖИВОГО тепер відмовляється ───────────────────────────────
  // Раніше 'respawn' не перевіряв, чи гравець мертвий, узагалі: живий діставав
  // повне лікування і безкоштовний телепорт у Зал звідки завгодно, у важкому
  // кошику — сорок разів за п'ять секунд. Камінь телепорту робить те саме,
  // але коштує 20 Liberty, має каст і відмовляється в Залі.
  //
  // Перевіряється ДО смерті: після неї відмовляти вже нема за що.
  const gsAlive = once(a.sock, 'gameStart', 3000).catch(() => null);
  const errAlive = once(a.sock, 'itemError', 3000).catch(() => null);
  a.sock.emit('respawn');
  const eAlive = await errAlive;
  ok(eAlive && eAlive.code === 'not_dead',
    `воскресіння живого відмовлено${eAlive ? '' : ' — відповіді не було'}`);
  ok(!(await gsAlive),
    'живому не прийшов gameStart — інакше це безкоштовний телепорт у Зал');
  // Відмова не лікує. Це та половина, що важить більше за телепорт: повне
  // здоров'я на вимогу вирішує будь-який бій.
  await pool().query('UPDATE player_progress SET hp = 5 WHERE player_id = $1', [madeId]);
  a.sock.emit('respawn');
  await wait(400);
  eq(Number((await pool().query('SELECT hp FROM player_progress WHERE player_id = $1',
    [madeId])).rows[0].hp), 5, 'відмова нічого не вилікувала');

  // ── чому одного UPDATE замало, щоб убити ─────────────────────────────────
  // Рядок у базі — не єдина копія здоров'я. Бій іде по копії в кімнаті, і саме
  // її читає перевірка 'respawn'. UPDATE кімнати не чіпає, тож сервер
  // справедливо відповів би «ви живі», і всі перевірки нижче впали б на
  // СПРАВНОМУ коді.
  //
  // Кімната бере здоров'я з рядка при вході на поверх (sendGameStart →
  // setPlayerHp, server/handlers2/world.js), тому смерть доводиться саме так.
  // Через сокет, а не прямим викликом: під PLAY_AGAINST сервер в іншому
  // процесі, і кімнати тут нема.
  await pool().query('UPDATE player_progress SET hp = 0 WHERE player_id = $1', [madeId]);
  a.sock.emit('enterLocation', { target: 'left' });
  await once(a.sock, 'gameStart', 12000).catch(() => null);
  await wait(300);

  // Читається ПІСЛЯ пересадки: вхід на поверх ставить гравця туди, де він
  // збережений, і саме ця точка — місце смерті, з якою порівнюється
  // воскресіння.
  const deathFloor = a.scr.floor;
  const diedAt = { x: a.scr.x, y: a.scr.y };
  const gs = once(a.sock, 'gameStart', 12000).catch(() => null);
  a.sock.emit('respawn');
  const revived = await gs;
  ok(!!revived, 'після воскресіння приходить gameStart');
  if (revived) {
    eq(revived.floor, 1, 'воскресіння повертає в хаб');
    ok(!!revived.spawn, 'і каже, де стати');
    // `!revived.spawn || moved > 200 || deathFloor !== revived.floor` could
    // never fail. A respawn ALWAYS changes floor — you die in an arm and come
    // back in the hub, which the assertion two lines above pins down — so the
    // third disjunct was true on every run and the distance, the only half
    // that describes the report, was never looked at.
    //
    // "При смерти делаешь тп — кидает в то же место, где умер" is the new
    // floor written beside the OLD coordinates, and coordinates are a plain
    // number pair with no floor attached: the hub's spawn is (1380, 1380) and
    // an arm's is (500, 6780), five thousand pixels apart, so carrying them
    // across is visible here and nothing else is within a screen of it.
    // The scenario's own precondition, asserted rather than assumed: the bot
    // died on an arm and came back to the hub. If a future edit ever has it die
    // IN the hub, the distance below stops meaning what its label says, and
    // this is the line that notices instead of quietly going green.
    ok(deathFloor !== revived.floor,
      `смерть сталася не в хабі (поверх ${deathFloor} → ${revived.floor})`);
    // -1 with no spawn at all, so a missing point fails here rather than
    // throwing a TypeError the runner reports as НЕОБРОБЛЕНА ПОМИЛКА.
    const moved = revived.spawn
      ? Math.hypot(revived.spawn.x - diedAt.x, revived.spawn.y - diedAt.y) : -1;
    ok(moved > 200, `це не те місце, де помер (${Math.round(moved)}px від трупа)`);
  }
  await wait(700);
  const { rows: after } = await pool().query(
    'SELECT floor, pos_x, pos_y, hp FROM player_progress WHERE player_id = $1', [madeId]);
  eq(Number(after[0].floor), 1, 'у базі теж записаний хаб, а не поверх смерті');
  ok(Number(after[0].hp) > 0, `здоровʼя відновлено (${after[0].hp})`);

  // ── ціна смерті, як її обіцяє екран ──────────────────────────────────────
  // «Возродиться (10% HP)» і «−50% опыта на 5 минут» стояли в грі з самого
  // початку й не означали нічого: воскресіння лікувало ПОВНІСТЮ, а штрафу не
  // існувало ніде. Власник вирішив, що обіцянка має стати правдою.
  //
  // Перевіряється на живому боці: HP у базі й строк штрафу — після
  // справжнього 'respawn' через сокет, а не з прочитаного вихідника.
  {
    const D = require('../shared/definitions');
    const playersRepo = require('../server/db/repos/players');
    const { rows: st } = await pool().query(
      'SELECT hp, buffs FROM player_progress WHERE player_id = $1', [madeId]);
    // maxHp береться тим самим репозиторієм, яким його бере обробник
    // 'respawn' — інакше перевірка порівнювала б із власною арифметикою.
    const statsRepo = require('../server/db/repos/stats');
    const stx = await statsRepo.of(null, madeId);
    const maxHp = (stx && stx.maxHp) || 0;
    const wantHp = Math.max(1, Math.floor(maxHp * D.RESPAWN_HP_PCT / 100));
    ok(maxHp > 0, `сервер знає maxHp (${maxHp})`);
    eq(Number(st[0].hp), wantHp,
      `воскресіння дало ${D.RESPAWN_HP_PCT}% здоровʼя, а не повне`);

    const until = Number((st[0].buffs || {})[D.DEATH_XP_PENALTY_KEY] || 0);
    const leftSec = Math.round((until - Date.now()) / 1000);
    ok(leftSec > D.DEATH_XP_PENALTY_SEC - 30 && leftSec <= D.DEATH_XP_PENALTY_SEC,
      `штраф поставлено на ${D.DEATH_XP_PENALTY_SEC} с (лишилось ${leftSec})`);

    // І сам штраф — справжньою функцією, справжнім записом у базу.
    const under = await playersRepo.grantXp(null, madeId, 100);
    eq(under && under.granted, 50, 'під штрафом зі 100 досвіду дійшло 50');
    ok(under && under.penalty === true, 'і це позначено як штраф');

    await pool().query(
      `UPDATE player_progress SET buffs = buffs - $2 WHERE player_id = $1`,
      [madeId, D.DEATH_XP_PENALTY_KEY]);
    const clean = await playersRepo.grantXp(null, madeId, 100);
    eq(clean && clean.granted, 100, 'без штрафу доходить усі 100');
    ok(clean && clean.penalty === false, 'і штрафом це не позначено');
  }
  // The stored position must be the one the player is standing on. Writing the
  // new floor beside the old coordinates is exactly what put people back on
  // their corpse on the next login.
  if (revived && revived.spawn) {
    const drift = Math.hypot(Number(after[0].pos_x) - revived.spawn.x,
                             Number(after[0].pos_y) - revived.spawn.y);
    ok(drift < 80, `збережена позиція = та, де стоїть гравець (${Math.round(drift)}px)`);
  }

  // ── coming back ──────────────────────────────────────────────────────────
  // "Золото слетает при перезагрузке" — the whole session, reopened.
  console.log('  ── перезаход ──');
  // Gold and level are re-read from the database below rather than compared
  // against the pre-reload screen, because the quest and Страх sections in
  // between legitimately pay. Nothing pays potions, so for those the
  // before-value is still the right thing to compare against.
  const potsBeforeReload = a.scr.potions.pt1;
  a.sock.disconnect();
  await wait(500);

  const b = await connect(`${TAG}_player`);
  // Re-read: `db` was sampled before the quest and Страх sections, both of
  // which legitimately pay. The claim being tested is "what was stored comes
  // back", not "the number never moved".
  const { rows: balNow } = await pool().query(
    `SELECT amount FROM balances WHERE player_id = $1 AND currency = 'gold'`, [madeId]);
  const goldNow = balNow.length ? Number(balNow[0].amount) : 0;
  eq(b.scr.gold, goldNow, `золото на місці після перезаходу (${b.scr.gold})`);
  eq(b.scr.lvl, pr[0].lvl, `після перезаходу рівень з бази (${b.scr.lvl})`);
  eq(b.scr.potions.pt1, potsBeforeReload, 'зілля на місці');
  // `inventory.length >= 0` is true of every array there has ever been,
  // including the empty one a login that sent no inventory at all produces —
  // which is the failure being claimed against. What the reload has to bring
  // back is the rows that are in the database, counted.
  const { rows: invRows } = await pool().query(
    `SELECT count(*)::int n FROM player_items
      WHERE player_id = $1 AND container = 'inventory'`, [madeId]);
  eq(b.scr.inventory.length, invRows[0].n,
    `інвентар прийшов повністю (${b.scr.inventory.length} предметів, у базі ${invRows[0].n})`);

  b.sock.emit('selectChar', { type: 'deathknight' });
  const back = await once(b.sock, 'gameStart', 12000);
  ok(!!back, 'персонаж повернувся у світ');
  eq(back.progress.charClass, 'deathknight', 'клас запамʼятався');

  b.sock.disconnect();
  await wait(200);
}

async function cleanup() {
  const q = (s, p) => pool().query(s, p).catch(() => {});
  const ids = [madeId, second].filter(Boolean);
  if (ids.length) {
    await q('DELETE FROM chat_messages WHERE player_id = ANY($1)', [ids]);
    // Предметы — ТЕМИ Ж ДВЕРИМА, якими їх видали. Сирий DELETE лишав у
    // item_ledger видачу без рядків, і нічна звірка справедливо кричала
    // про розходження — 216 пар 27 серпня, усі до одної тестові.
    await wipeItemsAll(ids);
    for (const t of ['player_skills', 'player_vip', 'player_prefs', 'player_daily',
                     'player_season', 'player_progress', 'ledger', 'balances']) {
      await q(`DELETE FROM ${t} WHERE player_id = ANY($1)`, [ids]);
    }
    await q('DELETE FROM players WHERE id = ANY($1)', [ids]);
  }
  if (app) { try { await app.shutdown('test', { exit: false }); } catch { /* down */ } }
}

main()
  .catch(err => { fail++; failures.push('НЕОБРОБЛЕНА ПОМИЛКА'); console.error('\n', err); })
  .finally(async () => {
    await cleanup(); await close().catch(() => {});
    console.log(`\n  ${pass} пройшло, ${fail} впало`);
    if (failures.length) console.log('  впали: ' + failures.join(' · '));
    process.exit(fail ? 1 : 0);
  });
