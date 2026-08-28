#!/usr/bin/env node
'use strict';
// ── The event modes, entered the way a player enters them ───────────────────
//
//   node dev/events-check.js
//
// "События зайшли, там воно не стартується, монстри не появляються."
//
// Every one of these is an instanced run: a private Room, a deploy that moves
// the players into it, and monsters spawned once they are there. Three things
// have to happen in order, and until now nothing checked that they did —
// modes-check drives the schedulers and the state machines, not the entry.
//
// So this enters them. Co-op needs two people, the elite farm zone needs a
// party, and Страх needs one. What it asserts is the same three things each
// time: the run started, the client was TOLD it started, and there are
// monsters where the player now stands.
//
// The server runs in another process — shared/netcodec.js keeps decoder state
// between calls, and one process holding both ends makes every world packet
// read here fiction.

const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const io = require('socket.io-client');
const { decodeGameState } = require('../shared/netcodec');

const PORT = Number(process.env.PLAY_PORT || 3195);
process.env.TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || 'test:token';

const { pool, close } = require('../server/db');
const { FLOOR_IDS } = require('../server/game/floors');
let child = null;

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);

const TAG = 'ev-' + String(process.pid).slice(-5);
const TG = 970000000 + (process.pid % 1000);
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
    // The crash this file was written for arrived as a ReferenceError in the
    // handler, which safeOn catches and reports — so stderr is watched and
    // printed rather than dropped.
    child.stderr.on('data', b => process.stderr.write(`    [сервер] ${b}`));
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

async function connect(tg, name, cls, lvl = 40) {
  const sock = io(BASE, { transports: ['websocket'], forceNew: true });
  await once(sock, 'connect');
  const st = { floor: null, enemies: new Map(), errors: [], events: [] };
  sock.onAny((ev, d) => { if (/Error$/.test(ev)) st.errors.push(`${ev}: ${d && d.msg}`); });
  sock.on('gameStart', g => {
    st.floor = g.floor;
    st.enemies = new Map((g.enemies || []).map(e => [e.id, e]));
  });
  sock.on('gameState', data => {
    const s2 = (data instanceof ArrayBuffer || ArrayBuffer.isView(data) || Buffer.isBuffer(data))
      ? decodeGameState(data) : data;
    for (const e of ((s2 && s2.enemies) || [])) st.enemies.set(e.id, e);
  });
  sock.emit('loginTelegramWebApp', { initData: initData(tg, name) });
  await once(sock, 'authOk', 12000);
  const { rows } = await pool().query('SELECT id FROM players WHERE telegram_id = $1', [String(tg)]);
  const pid = Number(rows[0].id);
  if (!made.includes(pid)) made.push(pid);
  await pool().query('UPDATE player_progress SET lvl = $2 WHERE player_id = $1', [pid, lvl]);
  sock.emit('selectChar', { type: cls });
  await once(sock, 'gameStart', 12000);
  return { sock, st, pid, name };
}

const alive = (st) => [...st.enemies.values()].filter(e => e.hp > 0);

async function main() {
  console.log(`\nevents-check  (${TAG})  →  ${BASE}\n`);
  await bootChild();

  const a = await connect(TG, `${TAG}_a`, 'warlock');
  const b = await connect(TG + 1, `${TAG}_b`, 'ranger');
  await wait(400);

  // ── Страх ────────────────────────────────────────────────────────────────
  // One player, its own private Room, wave 1 spawned on entry.
  console.log('  ── Страх ──');
  const wave = once(a.sock, 'fearWave', 12000).catch(() => null);
  a.sock.emit('fearEnter');
  const w1 = await wave;
  ok(!!w1, `у Страх пустило${w1 ? ` (хвиля ${w1.wave}/${w1.maxWave})` : ` — ${a.st.errors.join('; ') || 'без відповіді'}`}`);
  if (w1) {
    eq(w1.wave, 1, 'починається з першої хвилі');
    await wait(1500);
    eq(a.st.floor, FLOOR_IDS.fear, 'гравця перенесено на поверх Страху');
    ok(alive(a.st).length > 0,
      `і там є монстри (${alive(a.st).length}) — «монстри не появляються» саме про це`);
  }
  // ── выход из ЖИВОГО забега — порталом, а не кнопкой результата ──────────
  // 'fearReturn' теперь пускает домой только завершённый забег: он и на клиенте
  // отправляется ровно из одного места — обработчика fearFinished, после того
  // как показан итог (js/network.js). Здесь забег живой, и раньше эта строка
  // работала как «бросить забег» — то есть как бесплатный выход, которого у
  // игрока нет. Отказ оставлял запись в _fear, и следующая же секция получала
  // «Вы сейчас в Страхе».
  //
  // Настоящий выход — портал: enterLocation проходит через
  // modes.leaveInstanceFloor, который освобождает зал и снимает запись.
  a.sock.emit('enterLocation', { target: 'hub' });
  await once(a.sock, 'gameStart', 8000).catch(() => null);
  await wait(400);

  // ── Сотрудничество ───────────────────────────────────────────────────────
  // Two people, a lobby, then a deploy. The lobby half worked; the deploy
  // threw ReferenceError on the PARTNER's line — _lockCoopDaily, a name that
  // has not existed since the rewrite — so the run never started and the error
  // named a function nobody could find.
  console.log('\n  ── Сотрудничество ──');
  a.st.errors.length = 0; b.st.errors.length = 0;
  a.sock.emit('coopGroupCreate');
  await wait(500);
  b.sock.emit('coopGroupJoin', { leaderId: a.sock.id });
  await wait(600);

  const started = Promise.all([
    once(a.sock, 'coopStarted', 12000).catch(() => null),
    once(b.sock, 'coopStarted', 12000).catch(() => null),
  ]);
  // The monsters arrive one stage later, after a deliberate grace window
  // (COOP_START_DELAY_MS, 5s — the same breathing room Страх gives). Waited
  // for as an EVENT rather than a sleep: an earlier version waited 1.8s and
  // reported "0 monsters", which measured the stopwatch, not the game.
  const stage1 = once(a.sock, 'coopStage', 15000).catch(() => null);
  a.sock.emit('coopGroupStart');
  const [sa, sb] = await started;
  ok(!!sa && !!sb,
    `кооператив стартував для обох${sa && sb ? '' : ` — ${[...a.st.errors, ...b.st.errors].join('; ') || 'без відповіді'}`}`);
  if (sa && sb) {
    ok(Number.isFinite(sa.x) && Number.isFinite(sa.y), 'обом сказано, де вони стоять');
    ok(sa.maxStage > 0, `і скільки стадій (${sa.maxStage})`);
    // The partner's attempt count comes back through the line that used to
    // throw, so an undefined here is that bug returning.
    ok(Number.isFinite(sa.attemptsLeft), `лишок спроб порахований (${sa.attemptsLeft})`);
    // gameStart про новий поверх приходить ПІСЛЯ coopStarted: forceFloor
    // читає повний стан з бази і шле його вже з .then. Читати поверх одразу
    // після coopStarted — гонка, яка досі просто щастила.
    await once(a.sock, 'gameStart', 8000).catch(() => null);
    eq(a.st.floor, FLOOR_IDS.coop, 'перенесено на поверх кооперативу');
    const st1 = await stage1;
    ok(!!st1 && st1.stage === 1,
      `перша стадія почалась${st1 ? ` (${st1.stage}/${st1.maxStage})` : ''}`);
    await wait(1200);
    ok(alive(a.st).length > 0,
      `і на ній є монстри (${alive(a.st).length}) — «монстри не появляються» саме про це`);
  }
  // ── вихід із ЖИВОГО забігу — порталом ────────────────────────────────────
  // 'coopReturn' тепер пускає додому лише завершений забіг, і клієнт шле його
  // рівно з одного місця — після показу підсумку. Тут забіг живий, і ця
  // строка працювала як «кинути забіг»: відмова лишала запис у _coop, а
  // наступна секція отримувала «Вы сейчас в Сотрудничестве».
  a.sock.emit('enterLocation', { target: 'hub' });
  b.sock.emit('enterLocation', { target: 'hub' });
  await Promise.all([
    once(a.sock, 'gameStart', 8000).catch(() => null),
    once(b.sock, 'gameStart', 8000).catch(() => null),
  ]);
  await wait(900);

  // ── Элитная фарм-зона ────────────────────────────────────────────────────
  // A party of its own size, a daily minute budget, a private Room. Two of its
  // three broken names were here: the per-participant minute gate and the
  // per-minute charge.
  console.log('\n  ── Елітна фарм-зона ──');
  // The zone wants a FULL party (FARM2_PARTY_SIZE), so the test brings one.
  // Refusing on party size is a rule, and a test that stops at the rule has
  // not entered the zone.
  const { FARM2_PARTY_SIZE } = require('../shared/definitions');
  const extra = [];
  for (let i = 2; i < FARM2_PARTY_SIZE; i++) {
    extra.push(await connect(TG + 10 + i, `${TAG}_${i}`, 'deathknight'));
  }
  const crew = [a, b, ...extra];
  await wait(400);
  for (const c of crew) c.st.errors.length = 0;

  a.sock.emit('farm2GroupCreate');
  await wait(500);
  for (const c of crew.slice(1)) {
    c.sock.emit('farm2GroupJoin', { leaderId: a.sock.id });
    await wait(300);
  }
  await wait(500);

  const f2 = Promise.all(crew.map(c => once(c.sock, 'farm2Started', 15000).catch(() => null)));
  a.sock.emit('farm2GroupStart');
  const res2 = await f2;
  const errs = crew.flatMap(c => c.st.errors).join('; ');
  ok(res2.every(Boolean),
    `фарм-зона стартувала для всіх ${crew.length}${res2.every(Boolean) ? '' : ` — ${errs || 'без відповіді'}`}`);
  if (res2[0]) {
    await wait(1500);
    eq(a.st.floor, FLOOR_IDS.farmZone2, 'перенесено на поверх фарм-зони');
    ok(alive(a.st).length > 0, `на місці є монстри (${alive(a.st).length})`);
  }
  for (const c of crew) c.sock.emit('farm2Return');
  await wait(800);

  // ── nothing threw ────────────────────────────────────────────────────────
  // The whole class this file exists for: a handler that raises ReferenceError
  // answers with a generic server error and leaves no other trace. Any of them
  // here is a name that does not exist being called.
  console.log('\n  ── жодного падіння обробника ──');
  const serverErrors = [a, b, ...extra].flatMap(c => c.st.errors)
    .filter(e => /Ошибка сервера|server error/i.test(e));
  eq(serverErrors.length, 0,
    `жоден обробник не впав${serverErrors.length ? ` (${serverErrors.join('; ')})` : ''}`);

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
