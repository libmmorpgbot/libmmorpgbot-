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

const { pool, close, tx } = require('../server/db');
const progression = require('../server/db/repos/progression');
const app = require('../server/app');
const party = require('../server/party');
const { wipeItemsAll } = require('./fixtures');

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
  // `x && typeof x === 'object'` was the ONLY coverage these three modes had,
  // and `{}` satisfies it — which is exactly what a factory that forgot to
  // return its public state hands over, and exactly what the panel gets when
  // one does. The two below them (Страх, Сотрудництво) were already written the
  // other way, naming a field the client actually reads, so the shape of the
  // fix is already in this file.
  //
  // Every name below is destructured in js/network.js's handler for that event
  // and drawn by the Events panel. A missing `nextAt` is a countdown to 1970;
  // a missing `phase` puts the whole panel in 'idle' and hides the button; a
  // missing `attemptsLeft` reads as "unknown" forever. `await once(...)` above
  // already proves the reply ARRIVED — what it never asked was what was in it.
  const shape = (st, name, keys) => {
    const missing = keys.filter(k => !(k in (st || {})));
    ok(missing.length === 0, `${name} несе всі поля, які читає клієнт`,
      `немає: ${missing.join(', ')}`);
  };

  a.sock.emit('deathBattleSync');
  const dbState = await once(a.sock, 'deathBattleState');
  shape(dbState, 'битва на смерть', ['phase', 'startAt', 'nextAt', 'count', 'registered']);
  ok(typeof dbState.phase === 'string' && Number.isFinite(dbState.nextAt) && dbState.nextAt > Date.now(),
    `битва на смерть: фаза '${dbState.phase}', наступний старт через ${Math.round((dbState.nextAt - Date.now()) / 60000)} хв`);

  a.sock.emit('arena3Sync');
  const a3State = await once(a.sock, 'arena3State');
  shape(a3State, 'арена 3х3', ['phase', 'nextAt', 'queued', 'needed', 'live',
                               'minLevel', 'reward', 'maxAttempts', 'registered', 'inMatch', 'attemptsLeft']);
  ok(typeof a3State.phase === 'string' && Number.isFinite(a3State.nextAt) && a3State.nextAt > Date.now()
     && a3State.needed > 0,
    `арена 3х3: фаза '${a3State.phase}', потрібно ${a3State.needed} гравців`);

  a.sock.emit('race10Sync');
  const r10 = await once(a.sock, 'race10State');
  shape(r10, 'Кровава Башта', ['phase', 'nextAt', 'startAt', 'queued', 'capacity', 'minPlayers',
                               'live', 'minLevel', 'reward', 'winReward', 'maxAttempts',
                               'registered', 'inMatch', 'attemptsLeft']);
  // capacity is counted from the map at request time (raceUsableLanes), so it
  // is asserted as a number and not as a floor — a corridor that generated
  // unusable this run is a map question, and this file is not the place it
  // would be answered.
  ok(typeof r10.phase === 'string' && Number.isFinite(r10.nextAt) && r10.nextAt > Date.now()
     && Number.isFinite(r10.capacity),
    `Кровава Башта: фаза '${r10.phase}', місць ${r10.capacity}`);

  a.sock.emit('fearSync');
  const fear = await once(a.sock, 'fearState');
  ok(fear && Number.isFinite(fear.maxWave), `Страх відповідає (хвиль ${fear.maxWave})`);

  a.sock.emit('coopSync');
  const coop = await once(a.sock, 'coopState');
  ok(coop && Number.isFinite(coop.maxStage), `Сотрудництво відповідає (етапів ${coop.maxStage})`);

  // ── Страх переживає обрив звʼязку ────────────────────────────────────────
  // A disconnect mid-run holds the run for FEAR_RECONNECT_GRACE_MS — 45s,
  // raised to that from 15s precisely because ordinary reconnects were missing
  // the window. The hold came across in the rewrite and the CLAIM did not, so
  // the whole thing was a deletion on a timer wearing the word "grace": a
  // player who reconnected two seconds later came back to a hall still full of
  // their own monsters with no run behind it. The wave never advanced again
  // (_fearTrackKill returns on `!run`), fearSync answered inRun:false, and
  // dying in there did not end it either — with the attempt already spent on
  // entry, the only way out was walking to a portal.
  //
  // Driven end to end rather than by inspecting the maps, because the maps
  // were never the broken part: _fearDisconnectGrace held exactly the right
  // record for exactly the right length of time. What was missing was anybody
  // asking it for one.
  console.log('  ── Страх переживає обрив ──');
  const modesRt = require('../server/modes').modes;
  const TG_C = 900000003;
  {
    const c0 = await connectAs(TG_C, `${TAG}_c`);
    await setLevel(c0.pid, 40);
    await pool().query('DELETE FROM player_daily WHERE player_id = $1', [c0.pid]);
    // The gate reads the ROOM's copy of the level, stamped at login — so the
    // new level only counts from the next one.
    c0.sock.disconnect();
    await wait(300);
    const c = await connectAs(TG_C, `${TAG}_c`);

    c.sock.emit('fearEnter');
    const started = await maybe(c.sock, 'fearStarted', 5000);
    ok(!!started, `Страх почався (хвиль ${started && started.maxWave})`);

    // Wave 1 spawns FEAR_START_DELAY_MS after entry. Waiting for it is what
    // makes this a test of RESUMING something rather than of re-entering:
    // wave 0 has its own path (the countdown timer is a closure over a socket
    // id that no longer exists, so the claim starts the wave itself).
    const w1 = started ? await maybe(c.sock, 'fearWave', 9000) : null;
    ok(w1 && w1.wave === 1, `перша хвиля піднялась (${w1 && w1.wave})`);

    if (w1) {
      const oldSid = c.sock.id;
      c.sock.disconnect();
      await wait(500);
      ok(!modesRt._fear.has(oldSid), 'обрив зняв забіг зі старого сокета');
      ok(modesRt._fearDisconnectGrace.has(String(TG_C)),
        'і поклав його в утримання, а не викинув');

      // Back inside the window. Everything below this line is what did not
      // exist before: without the claim, `fear` comes back null and _fear has
      // no entry for the new socket at all.
      const back = io(`http://127.0.0.1:${PORT}`, { transports: ['websocket'], forceNew: true });
      await once(back, 'connect');
      // The LAST gameStart, not the first: login lands in the hub (the fear
      // floor is deliberately not STANDABLE), and the claim moves the
      // connection into its private hall right after, which pushes a second.
      let lastStart = null;
      back.on('gameStart', d => { lastStart = d; });
      back.emit('loginTelegramWebApp', { initData: initDataFor(TG_C, `${TAG}_c`) });
      await once(back, 'authOk', 8000);
      back.emit('selectChar', { type: 'deathknight' });
      await wait(1500);

      const fearBlock = lastStart && lastStart.fear;
      ok(!!(fearBlock && fearBlock.inRun),
        `gameStart після перезаходу каже, що забіг триває (${JSON.stringify(fearBlock)})`);
      eq(fearBlock && fearBlock.wave, w1.wave, 'і на тій самій хвилі, а не з нуля');
      ok(modesRt._fear.has(back.id), 'сервер знову веде цей забіг на новому сокеті');
      ok(!modesRt._fearDisconnectGrace.has(String(TG_C)),
        'утримання забране, а не лишене протухати поруч із живим забігом');
      back.disconnect();
      await wait(200);
    }
  }

  a.sock.emit('farm2Sync');
  const farm = await once(a.sock, 'farm2State');
  ok(farm && Number.isFinite(farm.dailyMinutes), `Елітна ферма відповідає (${farm.dailyMinutes} хв на добу)`);

  // ── Сотрудництво: денний ліміт не обходиться приєднанням ─────────────────
  // coopGroupCreate has always read the allowance. coopGroupJoin never did,
  // coopGroupStart never re-read it, and its two modes.takeAttempt calls threw
  // their answers away — progression.takeAttempt is a conditional UPDATE that
  // returns null at the cap and NOBODY LOOKED. The three together made the cap
  // apply to leaders and to nobody else: burn both of your runs, then only ever
  // JOIN groups other people broadcast, forever. Each Coop boss pays 100
  // Liberty plus a bless_stone; a teleport stone costs 20.
  //
  // Driven through real sockets rather than by calling the repo, because the
  // repo was never the broken part — takeAttempt has always refused correctly,
  // as the "денні спроби" block above already proves. What was missing was
  // anybody asking it, and asking is a handler's job.
  console.log('  ── Сотрудництво: ліміт спроб ──');
  {
    const COOP_CAP = require('../server/modes').capOf('coop');
    const TG_D = 900000004, TG_E = 900000005;
    // Both have to come back on a SECOND connection to count as level 40: the
    // gate reads the room's copy of the level, stamped at login. Same dance the
    // Страх block above does, for the same reason.
    const d0 = await connectAs(TG_D, `${TAG}_d`);
    const e0 = await connectAs(TG_E, `${TAG}_e`);
    await setLevel(d0.pid, 40);
    await setLevel(e0.pid, 40);
    d0.sock.disconnect(); e0.sock.disconnect();
    await wait(300);
    const d = await connectAs(TG_D, `${TAG}_d`);
    const e = await connectAs(TG_E, `${TAG}_e`);
    await pool().query('DELETE FROM player_daily WHERE player_id = ANY($1)', [[d.pid, e.pid]]);

    // The joiner has spent every Coop run they get today. The leader has not.
    for (let i = 0; i < COOP_CAP; i++) await tx(t => progression.takeAttempt(t, e.pid, 'coop', COOP_CAP));
    eq(await progression.attemptsLeft(null, e.pid, 'coop', COOP_CAP), 0,
      `у того, хто приєднується, спроб не лишилось (з ${COOP_CAP})`);

    d.sock.emit('coopGroupCreate');
    const grp = await maybe(d.sock, 'coopGroupState');
    ok(!!(grp && grp.inGroup && grp.isLeader), 'лідер зі спробами створив групу');

    // THE EXPLOIT, exactly as it was performed: join, don't create.
    e.sock.emit('coopGroupJoin', { leaderId: d.sock.id });
    const joinErr = await maybe(e.sock, 'coopError');
    ok(!!joinErr, `приєднання без спроб відмовлено (${joinErr && joinErr.msg})`);
    ok(!modesRt._coopGroupOf.has(e.sock.id),
      'і в групу його НЕ записано — інакше ліміт обходиться приєднанням');

    // ── і друга половина того самого ліміту: перевірка на СТАРТІ ───────────
    // A member can join with runs left and be out of them by the time the
    // leader presses Start — they can spend the last one elsewhere while they
    // wait, or the day can roll over under them. The lobby entry says nothing
    // about either, which is why farm2GroupStart re-reads its own daily minutes
    // for every participant and why this now does the same.
    await pool().query('DELETE FROM player_daily WHERE player_id = $1', [e.pid]);
    e.sock.emit('coopGroupJoin', { leaderId: d.sock.id });
    const joined = await maybe(e.sock, 'coopGroupState');
    ok(!!(joined && joined.inGroup && !joined.isLeader), 'зі спробами приєднання проходить');

    for (let i = 0; i < COOP_CAP; i++) await tx(t => progression.takeAttempt(t, e.pid, 'coop', COOP_CAP));
    d.sock.emit('coopGroupStart');
    const startErr = await maybe(d.sock, 'coopError');
    ok(!!startErr, `старт із вичерпаним учасником відмовлено (${startErr && startErr.msg})`);
    // The load-bearing pair. The refusal above could in principle come from
    // somewhere else; these two cannot.
    ok(!modesRt._coop.has(d.sock.id) && !modesRt._coop.has(e.sock.id),
      'жоден із двох у забіг не потрапив');
    eq(await progression.attemptsLeft(null, d.pid, 'coop', COOP_CAP), COOP_CAP,
      'і з лідера не списано спробу за забіг, якого не було');

    d.sock.disconnect(); e.sock.disconnect();
    await wait(300);
  }

  // ── п'ять безкоштовних телепортів додому ─────────────────────────────────
  // fearReturn, race10Return, arena3Return, coopReturn and farm2Return were
  // three lines each with no check that the caller was ever in that mode: every
  // one of them called _returnToHub and every one of them sat in the loose
  // 1500-per-5s bucket. So any of the five, sent from any floor in the game, was
  // the teleport home that useTeleportStone destroys a 20-Liberty item to
  // perform — and which useTeleportStone refuses outright to a dead player.
  // deathBattleReturn was the only one of the six that was gated, and its own
  // line says why in as many words: "not a free teleport home".
  //
  // The legitimate half is asserted right after the exploit half, because the
  // gate is worth nothing if it also breaks the button it is guarding: every
  // mode's finish (_fearFinish, _coopFinish, _farm2Finish, _a3Eliminate,
  // _a3Finish, _race10Eliminate, _race10Finish) calls _returnToHub BEFORE it
  // emits the event the result modal is built from, so an honest client answers
  // from the hub and must still get its coordinates back.
  console.log('  ── повернення з режимів ──');
  {
    const RETURNS = ['fearReturn', 'race10Return', 'arena3Return', 'coopReturn', 'farm2Return'];
    sess.forceFloor(7);                                  // farmZone — no mode's floor
    await maybe(a.sock, 'gameStart', 3000);
    eq(sess.floor, 7, 'гравець стоїть на фермі й у жодному режимі не бере участі');
    for (const ev of RETURNS) {
      a.sock.emit(ev);
      const moved = await maybe(a.sock, 'deathBattleReturned', 700);
      ok(!moved && sess.floor === 7, `${ev} поза режимом нікого не перемістив (поверх ${sess.floor})`);
      // Put them back if one of them DID move them, so the remaining names in
      // the list are still being asked the same question and not "does it move
      // someone who is already in the hub".
      if (sess.floor !== 7) { sess.forceFloor(7); await maybe(a.sock, 'gameStart', 3000); }
    }

    sess.forceFloor(1);
    await maybe(a.sock, 'gameStart', 3000);
    for (const ev of RETURNS) {
      a.sock.emit(ev);
      const spot = await maybe(a.sock, 'deathBattleReturned', 700);
      ok(!!spot && Number.isFinite(spot.x) && sess.floor === 1,
        `${ev} після закритого вікна результату відповідає координатами (${spot && Math.round(spot.x)}, ${spot && Math.round(spot.y)})`);
    }
  }

  // ── the visual relays carry no damage ────────────────────────────────────
  console.log('  ── візуальні ефекти ──');
  // A projectile is a drawing. The point of checking is that a nonsense one
  // cannot crash the room or reach another player as anything but pixels.
  const hpBefore = sess.room.players.get(a.sock.id).hp;
  a.sock.emit('spawnProj', { x: 1e9, y: -1e9, vx: 1e9, vy: 1e9, size: 1e6, life: 1e6, color: 'javascript:x', projType: '__proto__' });
  a.sock.emit('spawnAoe', { x: NaN, y: 'нет', r: 1e9, style: 'вигаданий', color: '<script>' });
  a.sock.emit('skillEffect', { enemyIds: new Array(500).fill('x'), type: 'stun', duration: 1e9 });
  await wait(300);
  const hpAfter = sess.room.players.get(a.sock.id).hp;
  ok(hpAfter >= hpBefore,
    `жоден із трьох ефектів не завдав шкоди (${hpBefore.toFixed(2)} → ${hpAfter.toFixed(2)})`);
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
    // Предметы — ТЕМИ Ж ДВЕРИМА, якими їх видали. Сирий DELETE лишав у
    // item_ledger видачу без рядків, і нічна звірка справедливо кричала
    // про розходження — 216 пар 27 серпня, усі до одної тестові.
    await wipeItemsAll(made);
    for (const t of ['player_skills', 'player_vip', 'player_prefs', 'player_daily',
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
