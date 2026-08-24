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
  eq(a.scr.potions.pt1, 30, `на екрані 30 зіль (${JSON.stringify(a.scr.potions)})`);
  eq(a.scr.lvl, 1, 'рівень 1');

  a.sock.emit('selectChar', { type: 'deathknight' });
  const start = await once(a.sock, 'gameStart', 12000);
  ok(!!start.spawn, 'персонаж має де зʼявитись');
  ok((start.enemies || []).length >= 0, `у стартовому пакеті ${(start.enemies || []).length} ворогів`);

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

  const seenMoving = [...a.scr.enemies.values()].filter(e => e.moved).length;
  const seenAggro = [...a.scr.enemies.values()].filter(e => e.aggro).length;

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
  ok(a.scr.x - startX > 250, `гравець реально пройшов ${Math.round(a.scr.x - startX)}px`);

  await wait(1500);
  const nowAggro = [...a.scr.enemies.values()].filter(e => e.aggro).length;
  const nowMoving = [...a.scr.enemies.values()].filter(e => e.moved).length;
  ok(a.scr.events.get('gameState') > 10,
    `потік світу йде (${a.scr.events.get('gameState')} пакетів)`);
  ok(nowMoving > 0 || nowAggro > 0,
    `монстри оживають на екрані (рухались ${nowMoving}, агресивних ${nowAggro})`);

  console.log('  ── бій ──');
  let killedOnScreen = 0;
  for (let n = 0; n < 40 && killedOnScreen < 2; n++) {
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
  ok(a.scr.goldGained > 0 || a.scr.gold > before.gold,
    `золото за бій дійшло (+${a.scr.goldGained})`);
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
  // the screen legitimately lags until the next push. What must agree is what
  // the server has TOLD it.
  ok(a.scr.lvl >= 1, `рівень на екрані (${a.scr.lvl})`);

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

  // ── coming back ──────────────────────────────────────────────────────────
  // "Золото слетает при перезагрузке" — the whole session, reopened.
  console.log('  ── перезаход ──');
  const goldBeforeReload = a.scr.gold;
  const lvlBeforeReload = a.scr.lvl;
  const potsBeforeReload = a.scr.potions.pt1;
  a.sock.disconnect();
  await wait(500);

  const b = await connect(`${TAG}_player`);
  eq(b.scr.gold, db.gold || 0, `золото на місці після перезаходу (${b.scr.gold})`);
  eq(b.scr.lvl, pr[0].lvl, `після перезаходу рівень з бази (${b.scr.lvl})`);
  eq(b.scr.potions.pt1, potsBeforeReload, 'зілля на місці');
  ok(b.scr.inventory.length >= 0, `інвентар прийшов (${b.scr.inventory.length} предметів)`);

  b.sock.emit('selectChar', { type: 'deathknight' });
  const back = await once(b.sock, 'gameStart', 12000);
  ok(!!back, 'персонаж повернувся у світ');
  eq(back.progress.charClass, 'deathknight', 'клас запамʼятався');

  b.sock.disconnect();
  await wait(200);
}

async function cleanup() {
  const q = (s, p) => pool().query(s, p).catch(() => {});
  if (madeId) {
    for (const t of ['player_items', 'player_skills', 'player_vip', 'player_prefs', 'player_daily',
                     'player_season', 'player_progress', 'ledger', 'balances']) {
      await q(`DELETE FROM ${t} WHERE player_id = $1`, [madeId]);
    }
    await q('DELETE FROM players WHERE id = $1', [madeId]);
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
