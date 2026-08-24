#!/usr/bin/env node
'use strict';
// ── Do the event modes still work on the new session? ───────────────────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/modes-check.js
//
// Boots the real server and drives it with real socket.io clients, because the
// modes are the one part of this rewrite whose bodies were kept verbatim —
// which means the risk is not in their logic but in everything AROUND them
// having moved underneath. Every closure they call was a different function an
// hour ago: the room lookup, the return-to-hub, the daily attempt, the level
// gate, the party.
//
// So this asks the questions a repository test cannot:
//
//   * does a mode's registration actually refuse someone below the level, now
//     that the level comes from the room rather than from a client blob?
//   * does a daily attempt get SPENT, in the database, and does the second
//     attempt see the first one?
//   * does a party form, and does leaving it end the run it gated?
//   * does forceFloor move a player into an instanced room without leaving a
//     copy of them in the old one?
//
// The scheduled modes (3v3, the race, the death battle) open on real clock
// windows, so their registration is exercised by asserting the REFUSAL and its
// reason rather than by waiting up to an hour for a window.

const path = require('path');
const io = require('socket.io-client');
const crypto = require('crypto');

const PORT = Number(process.env.MODES_PORT || 3131);
process.env.PORT = String(PORT);
// This process must not reach the operators' bot. It boots the real server,
// and boot() starts the workers: a second getUpdates poll takes the withdrawal
// buttons away from the live server, and the deposit scanner would be aimed at
// a wallet holding real money. dev/sync.sh sets these too — both, because a
// run started any other way has to be just as safe.
process.env.OPS_LIVE = '0';
process.env.NODE_ENV = 'test';
process.env.TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || 'test:token';

const { pool, close, tx, query } = require('../server/db');
const players = require('../server/db/repos/players');
const progression = require('../server/db/repos/progression');
const app = require('../server/app');
const party = require('../server/party');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);

const TAG = 'md-' + String(process.pid).slice(-5);
const made = [];

// The same initData shape server/security.js verifies, signed with the token
// this process is running under — the login path is not what is under test.
function initDataFor(id, username) {
  const user = JSON.stringify({ id, first_name: username, username });
  const params = { auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AA', user };
  const check = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.TG_BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...params, hash }).toString();
}

const once = (sock, ev, ms = 4000) => new Promise((res, rej) => {
  const to = setTimeout(() => rej(new Error(`таймаут очікування '${ev}'`)), ms);
  sock.once(ev, d => { clearTimeout(to); res(d); });
});
const maybe = (sock, ev, ms = 1200) => once(sock, ev, ms).catch(() => null);
const wait = ms => new Promise(r => setTimeout(r, ms));

async function connectAs(tgId, username) {
  const sock = io(`http://127.0.0.1:${PORT}`, { transports: ['websocket'], forceNew: true });
  await once(sock, 'connect');
  sock.emit('loginTelegramWebApp', { initData: initDataFor(tgId, username) });
  const auth = await once(sock, 'authOk', 8000);
  const { rows } = await pool().query('SELECT id FROM players WHERE telegram_id = $1', [String(tgId)]);
  const pid = Number(rows[0].id);
  made.push(pid);
  sock.emit('selectChar', { type: 'deathknight' });
  await once(sock, 'gameStart', 8000);
  return { sock, pid, auth };
}

const setLevel = (pid, lvl) => pool().query(
  'UPDATE player_progress SET lvl = $2 WHERE player_id = $1', [pid, lvl]);

async function main() {
  console.log(`\nmodes-check  (${TAG})\n`);
  await app.boot();
  console.log('');

  const a = await connectAs(900000001, `${TAG}_a`);
  const b = await connectAs(900000002, `${TAG}_b`);

  // ── the level gate is the server's ───────────────────────────────────────
  console.log('  ── рівень ──');
  // Level 1: below every mode's minimum. The old gate read s.lastStats.lvl —
  // a field the client filled in — so "минимальный уровень 15" was advice.
  a.sock.emit('arena3Register');
  const lowA3 = await maybe(a.sock, 'arena3Error');
  ok(!!lowA3, `арена 3х3 на 1-му рівні відмовила (${lowA3 && lowA3.msg})`);

  a.sock.emit('fearEnter');
  const lowFear = await maybe(a.sock, 'fearError');
  ok(!!lowFear, `Страх на 1-му рівні відмовив (${lowFear && lowFear.msg})`);

  a.sock.emit('coopGroupCreate');
  const lowCoop = await maybe(a.sock, 'coopError');
  ok(!!lowCoop, `Сотрудництво на 1-му рівні відмовило (${lowCoop && lowCoop.msg})`);

  // ── the party ────────────────────────────────────────────────────────────
  console.log('  ── група ──');
  a.sock.emit('partyInvite', { targetId: b.sock.id });
  const invite = await once(b.sock, 'partyInviteReceived');
  eq(invite.fromId, a.sock.id, 'запрошення прийшло від того, хто його надіслав');
  eq(invite.fromName, `${TAG}_a`, "і несе ім'я запрошувача");

  b.sock.emit('partyAccept', { fromId: a.sock.id });
  const upA = await once(a.sock, 'partyUpdated');
  eq(upA.members.length, 1, 'у запрошувача один партнер');
  eq(upA.members[0].id, b.sock.id, 'і це саме той, хто прийняв');
  ok(party.playerParty.has(a.sock.id) && party.playerParty.has(b.sock.id),
    'обидва записані в одну групу на сервері');

  // Leaving dissolves a party of two rather than leaving one person in a
  // group of one — a stale party id would follow them into the next invite.
  b.sock.emit('partyLeave');
  const left = await once(a.sock, 'partyLeft');
  eq(left.leftName, `${TAG}_b`, 'той, хто лишився, дізнався, хто вийшов');
  await wait(150);
  ok(!party.playerParty.has(a.sock.id) && !party.playerParty.has(b.sock.id),
    'група з двох розпалась повністю, а не лишила групу з одного');

  // ── daily attempts are spent in the database ─────────────────────────────
  console.log('  ── денні спроби ──');
  // _lockDailyAttempt fired a Mongo update and did not await it: a failed
  // write was a free run nobody could see. takeAttempt is a conditional UPDATE
  // whose answer decides whether the run starts.
  const CAP = 2;
  await pool().query('DELETE FROM player_daily WHERE player_id = $1', [a.pid]);
  const first = await tx(t => progression.takeAttempt(t, a.pid, 'fear', CAP));
  ok(!!first, 'перша спроба списалась');
  eq(await progression.attemptsLeft(null, a.pid, 'fear', CAP), CAP - 1,
    'лічильник побачив її одразу');

  const second = await tx(t => progression.takeAttempt(t, a.pid, 'fear', CAP));
  ok(!!second, 'друга спроба списалась');
  const third = await tx(t => progression.takeAttempt(t, a.pid, 'fear', CAP));
  eq(third, null, `третя спроба понад ліміт ${CAP} відхилена базою, а не кодом`);
  eq(await progression.attemptsLeft(null, a.pid, 'fear', CAP), 0, 'спроб не лишилось');

  // Two runs starting at the same instant race on one row, and exactly one of
  // them may win. A read-then-write would let both through.
  await pool().query('DELETE FROM player_daily WHERE player_id = $1', [b.pid]);
  const race = await Promise.all([
    tx(t => progression.takeAttempt(t, b.pid, 'coop', 1)).catch(() => null),
    tx(t => progression.takeAttempt(t, b.pid, 'coop', 1)).catch(() => null),
  ]);
  eq(race.filter(Boolean).length, 1, 'дві одночасні спроби на останню — проходить РІВНО одна');

  // ── being moved by the server ────────────────────────────────────────────
  console.log('  ── переміщення сервером ──');
  const hub = app.io.sockets.sockets.get(a.sock.id).data.session.room;
  ok(hub && hub.players.has(a.sock.id), 'гравець у кімнаті хаба');

  const sess = app.io.sockets.sockets.get(a.sock.id).data.session;
  const landed = sess.forceFloor(7);                    // farmZone — gated at level
  ok(!!landed, 'forceFloor провів повз рівневий гейт');
  eq(sess.floor, 7, 'сесія знає про новий поверх');
  ok(!hub.players.has(a.sock.id),
    'у старій кімнаті гравця НЕ лишилось — інакше він був би у двох місцях');
  ok(sess.room.players.has(a.sock.id), 'а в новій — є');
  const moved = await once(a.sock, 'gameStart', 4000);
  eq(moved.floor, 7, 'клієнт отримав gameStart нового поверху');

  // The class and the numbers travel with them. A player who arrived without a
  // type is a player nobody else can draw and the modes refuse entry to.
  const there = sess.room.players.get(a.sock.id);
  eq(there.type, 'deathknight', 'клас переїхав разом із гравцем');
  ok(there.atk > 0 && there.maxHp > 0, `стати переїхали (atk ${there.atk}, hp ${there.maxHp})`);

  sess.forceFloor(1);
  await maybe(a.sock, 'gameStart', 3000);
  eq(sess.floor, 1, 'повернення в хаб працює так само');

  // ── the modes are actually running ───────────────────────────────────────
  console.log('  ── розклад режимів ──');
  a.sock.emit('deathBattleSync');
  const dbState = await once(a.sock, 'deathBattleState');
  ok(dbState && typeof dbState === 'object', 'битва на смерть відповідає своїм станом');

  a.sock.emit('arena3Sync');
  const a3State = await once(a.sock, 'arena3State');
  ok(a3State && typeof a3State === 'object', 'арена 3х3 відповідає своїм станом');

  a.sock.emit('race10Sync');
  const r10 = await once(a.sock, 'race10State');
  ok(r10 && typeof r10 === 'object', 'Кровава Башта відповідає своїм станом');

  a.sock.emit('fearSync');
  const fear = await once(a.sock, 'fearState');
  ok(fear && Number.isFinite(fear.maxWave), `Страх відповідає (хвиль ${fear.maxWave})`);

  a.sock.emit('coopSync');
  const coop = await once(a.sock, 'coopState');
  ok(coop && Number.isFinite(coop.maxStage), `Сотрудництво відповідає (етапів ${coop.maxStage})`);

  a.sock.emit('farm2Sync');
  const farm = await once(a.sock, 'farm2State');
  ok(farm && Number.isFinite(farm.dailyMinutes), `Елітна ферма відповідає (${farm.dailyMinutes} хв на добу)`);

  // ── the visual relays carry no damage ────────────────────────────────────
  console.log('  ── візуальні ефекти ──');
  // A projectile is a drawing. The point of checking is that a nonsense one
  // cannot crash the room or reach another player as anything but pixels.
  const hpBefore = sess.room.players.get(a.sock.id).hp;
  a.sock.emit('spawnProj', { x: 1e9, y: -1e9, vx: 1e9, vy: 1e9, size: 1e6, life: 1e6, color: 'javascript:x', projType: '__proto__' });
  a.sock.emit('spawnAoe', { x: NaN, y: 'нет', r: 1e9, style: 'вигаданий', color: '<script>' });
  a.sock.emit('skillEffect', { enemyIds: new Array(500).fill('x'), type: 'stun', duration: 1e9 });
  await wait(300);
  eq(sess.room.players.get(a.sock.id).hp, hpBefore, 'жоден із трьох ефектів не завдав шкоди');
  ok(app.io.sockets.sockets.get(a.sock.id), 'сервер живий після сміттєвих ефектів');

  // ── the teleport stone ───────────────────────────────────────────────────
  console.log('  ── камінь телепорту ──');
  sess.forceFloor(7);
  await maybe(a.sock, 'gameStart', 3000);
  a.sock.emit('useTeleportStone');
  const noStone = await once(a.sock, 'itemError');
  ok(!!noStone, `без каменя телепорт відмовлено (${noStone.msg})`);

  await tx(async t => {
    const items = require('../server/db/repos/items');
    await items.lockPlayer(t, a.pid);
    return items.add(t, a.pid, 'teleport_stone', { qty: 1 });
  });
  a.sock.emit('useTeleportStone');
  const cast = await once(a.sock, 'teleportCastStarted');
  ok(cast && cast.ms > 0, `каст почався (${cast && cast.ms} мс)`);
  const { rows: stones } = await pool().query(
    `SELECT count(*)::int n FROM player_items WHERE player_id=$1 AND item_id='teleport_stone'`, [a.pid]);
  eq(stones[0].n, 0, 'камінь витрачено на СТАРТІ касту, а не після нього');

  a.sock.disconnect(); b.sock.disconnect();
  await wait(200);
}

async function cleanup() {
  const q = (s, p) => pool().query(s, p).catch(() => {});
  if (made.length) {
    for (const t of ['player_items', 'player_skills', 'player_vip', 'player_prefs', 'player_daily',
                     'player_season', 'player_progress', 'pvp_history', 'ledger', 'balances']) {
      await q(`DELETE FROM ${t} WHERE player_id = ANY($1)`, [made]);
    }
    await q('DELETE FROM players WHERE id = ANY($1)', [made]);
  }
  try { await app.shutdown('test', { exit: false }); } catch { /* already down */ }
}

main()
  .catch(err => { fail++; failures.push('НЕОБРОБЛЕНА ПОМИЛКА'); console.error('\n', err); })
  .finally(async () => {
    await cleanup();
    await close().catch(() => {});
    console.log(`\n  ${pass} пройшло, ${fail} впало`);
    if (failures.length) console.log('  впали: ' + failures.join(' · '));
    process.exit(fail ? 1 : 0);
  });
