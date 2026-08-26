#!/usr/bin/env node
'use strict';
// ── A party, from the invitation to the last person leaving ─────────────────
//
//   node dev/party-check.js
//
// Two sockets, both real logins, doing what two players do. What it is really
// checking is the LEAVING, because that is where the holes were: nothing
// removed a departing player from the room, so their body stayed on the floor,
// the floor's tick loop never stopped, and monsters kept chasing a ghost
// instead of whoever was actually standing there.
//
// A party has a second rule that only shows up on a bad connection: a blip is
// not a decision. holdOnDisconnect keeps the place for 45 seconds and
// claimGrace takes it back on the next login — both existed, and neither was
// called.
//
// The server runs in ANOTHER process: shared/netcodec.js keeps decoder state
// between calls, and putting the encoder and decoder in one process makes
// every world packet read here fiction.

const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const io = require('socket.io-client');
const { decodeGameState } = require('../shared/netcodec');

const PORT = Number(process.env.PLAY_PORT || 3193);
process.env.TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || 'test:token';

const { pool, close } = require('../server/db');
let child = null;

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);

const TAG = 'pt-' + String(process.pid).slice(-5);
const TG_A = 960000000 + (process.pid % 1000);
const TG_B = TG_A + 1;
const BASE = `http://127.0.0.1:${PORT}`;
const made = [];

function bootChild() {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'app.js')], {
      env: { ...process.env, PORT: String(PORT), OPS_LIVE: '0', NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const to = setTimeout(() => reject(new Error('сервер не піднявся')), 30000);
    child.stdout.on('data', b => { if (/listening on/.test(String(b))) { clearTimeout(to); resolve(); } });
    child.stderr.on('data', () => {});
    child.on('exit', c => { clearTimeout(to); reject(new Error(`сервер вийшов (${c})`)); });
  });
}

function initData(id, username) {
  const user = JSON.stringify({ id, first_name: username, username });
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AA', user });
  const c = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const s = crypto.createHmac('sha256', 'WebAppData').update(process.env.TG_BOT_TOKEN).digest();
  p.set('hash', crypto.createHmac('sha256', s).update(c).digest('hex'));
  return p.toString();
}
const once = (s, ev, ms = 10000) => new Promise((res, rej) => {
  const to = setTimeout(() => rej(new Error(`таймаут '${ev}'`)), ms);
  s.once(ev, d => { clearTimeout(to); res(d); });
});
const wait = ms => new Promise(r => setTimeout(r, ms));

async function connect(tg, name, cls) {
  const sock = io(BASE, { transports: ['websocket'], forceNew: true });
  await once(sock, 'connect');
  const state = { party: null, invites: [], left: [], gone: [] };
  sock.on('partyUpdated', d => { state.party = d.members; });
  sock.on('partyInviteReceived', d => state.invites.push(d));
  sock.on('partyLeft', d => state.left.push(d));
  sock.on('playerLeft', d => state.gone.push(d.id));
  // Who the world stream says is standing here, and when it last said so.
  state.seen = new Map();
  sock.on('gameState', data => {
    const st = (data instanceof ArrayBuffer || ArrayBuffer.isView(data) || Buffer.isBuffer(data))
      ? decodeGameState(data) : data;
    const at = Date.now();
    for (const p of ((st && st.players) || [])) state.seen.set(p.id, at);
  });
  sock.emit('loginTelegramWebApp', { initData: initData(tg, name) });
  await once(sock, 'authOk', 12000);
  const { rows } = await pool().query('SELECT id FROM players WHERE telegram_id = $1', [String(tg)]);
  const pid = Number(rows[0].id);
  if (!made.includes(pid)) made.push(pid);
  await pool().query('UPDATE player_progress SET lvl = 30 WHERE player_id = $1', [pid]);
  sock.emit('selectChar', { type: cls });
  await once(sock, 'gameStart', 12000);
  return { sock, state, pid, name };
}

// Whether the server still thinks somebody is on the floor, asked the way a
// PLAYER finds out: does that person keep arriving in the world stream. The
// per-floor counts on /health need an admin token, and a check that silently
// falls back to "cannot tell" is a check that passes without looking.

async function main() {
  console.log(`\nparty-check  (${TAG})  →  ${BASE}\n`);
  await bootChild();

  const a = await connect(TG_A, `${TAG}_a`, 'warlock');
  const b = await connect(TG_B, `${TAG}_b`, 'ranger');
  await wait(400);

  // ── forming one ──────────────────────────────────────────────────────────
  console.log('  ── запрошення ──');
  a.sock.emit('partyInvite', { targetId: b.sock.id });
  const inv = await once(b.sock, 'partyInviteReceived', 6000).catch(() => null);
  ok(!!inv, 'запрошення дійшло');
  if (inv) {
    eq(inv.fromId, a.sock.id, 'у запрошенні той, хто запросив');
    eq(inv.fromName, `${TAG}_a`, 'і його імʼя');
  }

  b.sock.emit('partyAccept', { fromId: a.sock.id });
  await wait(500);
  ok(Array.isArray(a.state.party) && a.state.party.length === 1,
    `запрошувач бачить напарника (${a.state.party && a.state.party.length})`);
  ok(Array.isArray(b.state.party) && b.state.party.length === 1,
    `і напарник бачить його (${b.state.party && b.state.party.length})`);
  if (a.state.party && a.state.party[0]) {
    eq(a.state.party[0].name, `${TAG}_b`, 'у списку — імʼя, а не id');
  }

  // ── a second invitation to somebody already in one ───────────────────────
  a.sock.emit('partyInvite', { targetId: b.sock.id });
  const dup = await once(b.sock, 'partyInviteReceived', 1200).catch(() => null);
  ok(!dup, 'того, хто вже в групі, не запрошують удруге');

  // ── the warlock's heal ───────────────────────────────────────────────────
  console.log('\n  ── лікування групи ──');
  // Hurt, not dead, and hurt in the ROOM — which is what healParty reads. An
  // earlier version of this wrote 50 hp to the database and then called
  // respawn, which restores full health: the heal then had nothing to add and
  // emitted nothing, and the test called that a broken heal.
  //
  // Re-entering the floor is how the room's copy is refreshed: sendGameStart
  // pushes stats and hp from the database on every entry, including one that
  // does not change floor.
  await pool().query('UPDATE player_progress SET hp = 50 WHERE player_id = $1', [b.pid]);
  b.sock.emit('enterLocation', { target: 'hub' });
  await once(b.sock, 'gameStart', 8000).catch(() => null);
  await wait(400);
  // 'healPartyMember' — the name the shipped client listens on (js/network.js).
  const healed = once(b.sock, 'healPartyMember', 6000).catch(() => null);
  a.sock.emit('healParty');
  const heal = await healed;
  ok(!!heal && heal.amount > 0,
    `варлок лікує групу — напарник отримав +${heal && heal.amount}`);

  // Only the warlock has it. A ranger casting it must heal nobody, or the
  // class restriction is decoration.
  //
  // THE WARLOCK HAS TO BE HURT FOR THIS TO MEAN ANYTHING. It watched a.sock
  // while only b had ever been damaged, and healParty emits nothing to a
  // member already at full health — `healed > 0` is the condition on the emit.
  // So the silence it read as "the class check held" was the same silence a
  // full-health target produces, and deleting `st.charClass !== 'warlock'`
  // from server/handlers2/social.js left this green. Same route as above:
  // the database, then a re-entry, because sendGameStart is what refreshes
  // the room's copy of a player's hp.
  await pool().query('UPDATE player_progress SET hp = 50 WHERE player_id = $1', [a.pid]);
  a.sock.emit('enterLocation', { target: 'hub' });
  const aBack = await once(a.sock, 'gameStart', 8000).catch(() => null);
  await wait(400);
  ok(aBack && aBack.progress && Number(aBack.progress.hp) === 50,
    `варлок теж поранений (${aBack && aBack.progress && aBack.progress.hp}) — інакше нульове лікування не відрізнити від жодного`);

  const notHealed = once(a.sock, 'healPartyMember', 2500).catch(() => null);
  b.sock.emit('healParty');
  ok(!await notHealed, 'рейнджер груп не лікує — це вміння варлока');

  // ── leaving on purpose ───────────────────────────────────────────────────
  console.log('\n  ── вихід ──');
  b.sock.emit('partyLeave');
  await wait(500);
  ok(Array.isArray(a.state.party) && a.state.party.length === 0,
    'той, хто лишився, бачить порожню групу');
  ok(a.state.left.length > 0, `і йому сказали, хто пішов (${a.state.left.map(x => x.leftName).join(', ')})`);

  // ── the disconnect ───────────────────────────────────────────────────────
  // The hole: nothing removed a departing player from the room. Their body
  // stayed on the floor for everyone, the floor never went quiet, and monsters
  // kept chasing where they used to be.
  console.log('\n  ── обрив звʼязку ──');
  b.sock.emit('partyAccept', { fromId: a.sock.id });   // re-form for the test
  a.sock.emit('partyInvite', { targetId: b.sock.id });
  await once(b.sock, 'partyInviteReceived', 4000).catch(() => null);
  b.sock.emit('partyAccept', { fromId: a.sock.id });
  await wait(400);

  a.state.gone.length = 0;
  const bSocketId = b.sock.id;
  b.sock.disconnect();
  await wait(900);

  ok(a.state.gone.includes(bSocketId),
    "решті сказано 'playerLeft' — інакше труп стоїть у всіх на екрані");

  // The visible half: a departed player must stop arriving in the world
  // stream. While nothing removed them from the room they kept being cast to
  // everyone, which is the body standing on the floor.
  a.state.seen.clear();
  await wait(1200);
  ok(!a.state.seen.has(bSocketId),
    'той, хто вийшов, більше не приходить у потоці світу — тіло не лишилось стояти');

  // The party place is HELD, not dissolved: a blip is not a decision.
  ok(Array.isArray(a.state.party) && a.state.party.length === 1,
    'місце в групі притримано на час обриву, а не викинуто одразу');

  // ── and taken back on reconnect ──────────────────────────────────────────
  const b2 = await connect(TG_B, `${TAG}_b`, 'ranger');
  await wait(600);
  ok(Array.isArray(b2.state.party) && b2.state.party.length === 1,
    'після перезаходу гравець знову в тій самій групі');
  ok(Array.isArray(a.state.party) && a.state.party.length === 1
     && a.state.party[0].id === b2.sock.id,
    'а напарник бачить його вже під новим зʼєднанням');

  // ── the last one out ─────────────────────────────────────────────────────
  console.log('\n  ── останній виходить ──');
  const aId = a.sock.id;
  a.sock.disconnect();
  await wait(1000);
  b2.state.seen.clear();
  await wait(1200);
  ok(!b2.state.seen.has(aId), 'і другий бачить те саме, коли виходить перший');
  b2.sock.disconnect();
  await wait(600);

  console.log(`\n  ${pass} пройшло, ${fail} впало`);
  if (failures.length) console.log(`  впали: ${failures.join(', ')}`);
}

main()
  .catch(err => { console.error(err); fail++; })
  .finally(async () => {
    if (made.length) await pool().query('DELETE FROM players WHERE id = ANY($1)', [made]).catch(() => {});
    if (child) child.kill('SIGTERM');
    await close();
    process.exit(fail ? 1 : 0);
  });
