#!/usr/bin/env node
'use strict';
// ── Сотрудничество: комната, в которой должны быть монстры ──────────────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/coop-check.js
//
// «Сотрудничество, моя комната первая была пуста, слил попытку.»
//
// Два настоящих сокета проходят весь путь: вход, группа, старт, ожидание
// первой волны — и смотрят, ПРИШЛИ ЛИ монстры каждому из двоих. Не в обход
// сети и не в обход обработчиков: пустая комната — это про то, что доехало до
// клиента, а не про то, что лежит в памяти сервера.
//
// Отдельно проверяется цена ошибки: попытка списывается ДО развёртывания, и
// если развернуть не удалось, игрок обязан получить её назад.
const crypto = require('crypto');
const io = require('socket.io-client');
const { decodeGameState } = require('../shared/netcodec');

const REMOTE = process.env.PLAY_AGAINST || null;
const PORT = Number(process.env.COOP_PORT || 3183);
if (!REMOTE) {
  process.env.PORT = String(PORT);
  process.env.OPS_LIVE = '0';
  process.env.NODE_ENV = 'test';
}
process.env.TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || 'test:token';

const { pool, close } = require('../server/db');
const { wipeItemsAll } = require('./fixtures');
const app = REMOTE ? null : require('../server/app');

let pass = 0, fail = 0;
const ok = (c, name, got) => {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + name); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m  ' + name + (got !== undefined ? ' — ' + got : '')); }
};
const eq = (a, b, n) => ok(a === b, n, `ожидал ${JSON.stringify(b)}, получил ${JSON.stringify(a)}`);

const TAG = 'coop-' + String(process.pid).slice(-5);
const BASE = REMOTE || `http://127.0.0.1:${PORT}`;
const made = [];

function initData(id, username) {
  const user = JSON.stringify({ id, first_name: username, username });
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AA', user });
  const c = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const s = crypto.createHmac('sha256', 'WebAppData').update(process.env.TG_BOT_TOKEN).digest();
  p.set('hash', crypto.createHmac('sha256', s).update(c).digest('hex'));
  return p.toString();
}
const once = (sock, ev, ms = 9000) => new Promise((res, rej) => {
  const to = setTimeout(() => rej(new Error(`таймаут '${ev}'`)), ms);
  sock.once(ev, d => { clearTimeout(to); res(d); });
});
const wait = ms => new Promise(r => setTimeout(r, ms));
// Ждать условия, а не секунд. Фиксированная пауза — это ставка на то, что
// машина не занята; в наборе из шестидесяти проверок рядом с живой игрой эта
// ставка проигрывает, и проверка краснеет на исправном коде.
async function until(cond, ms = 20000, step = 250) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await wait(step);
  }
  return cond();
}

// ── что видит игрок ─────────────────────────────────────────────────────────
// Только из пакетов, как и сам клиент: список живых врагов собирается из
// gameState (бинарный кодек) и правится enemiesRemoved. Пустая комната — это
// когда здесь пусто.
function screenOf(sock) {
  const scr = { enemies: new Map(), floor: null, stage: 0, errors: [], attemptsLeft: null };
  scr.floors = [];
  sock.on('gameStart', g => {
    scr.floor = g.floor;
    scr.floors.push(g.floor);
    scr.enemies.clear();
    for (const e of (g.enemies || [])) scr.enemies.set(e.id, e);
  });
  sock.on('gameState', buf => {
    let st; try { st = decodeGameState(buf); } catch { return; }
    for (const e of (st.enemies || st.e || [])) if (e.id) scr.enemies.set(e.id, e);
  });
  sock.on('enemiesRemoved', ({ ids } = {}) => { for (const id of (ids || [])) scr.enemies.delete(id); });
  sock.on('coopStarted', d => { scr.attemptsLeft = d.attemptsLeft; });
  sock.on('coopStage', d => { scr.stage = d.stage; });
  sock.on('coopError', e => scr.errors.push(e && e.msg));
  // Всё, что приехало, по именам — чтобы «клиент не получил карту» было видно,
  // а не выводилось из отсутствия одной проверки.
  scr.events = new Map();
  sock.onAny((ev) => { if (ev !== 'gameState') scr.events.set(ev, (scr.events.get(ev) || 0) + 1); });
  return scr;
}

async function connect(tg, name) {
  const sock = io(BASE, { transports: ['websocket'], forceNew: true });
  await once(sock, 'connect');
  const scr = screenOf(sock);
  sock.emit('loginTelegramWebApp', { initData: initData(tg, name) });
  await once(sock, 'authOk', 12000);
  const { rows } = await pool().query('SELECT id FROM players WHERE telegram_id = $1', [String(tg)]);
  const id = Number(rows[0].id);
  made.push(id);
  // Уровень 20 — выше порога входа в Сотрудничество (COOP_MIN_LEVEL = 10).
  await pool().query('UPDATE player_progress SET lvl = 20 WHERE player_id = $1', [id]);
  sock.emit('selectChar', { type: 'deathknight' });
  await once(sock, 'gameStart', 12000);
  await wait(200);
  return { sock, scr, id, tg };
}

// Попытка в Сотрудничество — одна в сутки (COOP_ATTEMPTS), а сценариев
// несколько: между ними попытки возвращаются, иначе второй сценарий упирается
// в «попытки закончились» и падает по таймауту, ничего не проверив.
const resetCoop = (ids) => pool().query(
  `DELETE FROM player_daily WHERE player_id = ANY($1::bigint[]) AND mode = 'coop'`, [ids]);

const usedOf = async (pid) => {
  const { rows } = await pool().query(
    `SELECT COALESCE(sum(used), 0)::int u FROM player_daily
      WHERE player_id = $1 AND day = current_date AND mode = 'coop'`, [pid]);
  return rows.length ? rows[0].u : 0;
};

(async () => {
  console.log(`\ncoop-check  (${TAG})  →  ${BASE}\n`);
  if (app) { await app.boot(); console.log(''); }

  const TG1 = 930000000 + (process.pid % 400000);
  const TG2 = TG1 + 1;
  const lead = await connect(TG1, `${TAG}_lead`);
  const mate = await connect(TG2, `${TAG}_mate`);

  // ── обычный заход: оба должны увидеть монстров ────────────────────────────
  console.log('  ── обычный заход ──');
  lead.sock.emit('coopGroupCreate');
  await once(lead.sock, 'coopGroupState', 6000);
  mate.sock.emit('coopGroupJoin', { id: lead.sock.id, leaderId: lead.sock.id });
  await wait(500);

  const before = await usedOf(lead.id);
  lead.sock.emit('coopGroupStart');
  const started = await Promise.race([
    once(lead.sock, 'coopStarted', 9000).then(() => 'ok'),
    once(lead.sock, 'coopError', 9000).then(e => 'отказ: ' + (e && e.msg)),
  ]).catch(e => 'нет ответа: ' + e.message);
  ok(started === 'ok', 'запуск принят', started);
  if (started !== 'ok') {
    console.log('\n  дальше идти не с чем\n');
    lead.sock.close(); mate.sock.close();
    await wipeItemsAll(made); await close(); process.exit(1);
  }

  // Первая волна приходит через COOP_START_DELAY_MS (5с) после развёртывания.
  // gameStart нового этажа приезжает тоже асинхронно — forceFloor дочитывает
  // состояние из базы и лишь потом отправляет пакет. Ждём оба события, а не
  // «семь с половиной секунд, должно хватить».
  await until(() => lead.scr.enemies.size > 0 && mate.scr.enemies.size > 0
                    && lead.scr.floors.includes(12) && mate.scr.floors.includes(12));
  console.log('      события лидера: ' + [...lead.scr.events].map(([k, n]) => k + '×' + n).join(', '));
  ok(lead.scr.floors.includes(12), `лидер побывал на этаже Сотрудничества (${lead.scr.floors})`);
  ok(mate.scr.floors.includes(12), `напарник тоже (${mate.scr.floors})`);
  const nLead = lead.scr.enemies.size;
  const nMate = mate.scr.enemies.size;
  console.log(`      лидер видит ${nLead} монстров · напарник ${nMate}`);
  ok(nLead > 0, 'комната лидера НЕ пуста', `видно ${nLead}`);
  ok(nMate > 0, 'комната напарника НЕ пуста', `видно ${nMate}`);
  eq(lead.scr.stage, 1, 'первая волна объявлена лидеру');
  eq(mate.scr.stage, 1, 'и напарнику');

  // Монстры должны быть СВОИ: чужая полоса — это чужая комната.
  const laneOf = (scr) => new Set([...scr.enemies.keys()]
    .filter(id => String(id).startsWith('coop_'))
    .map(id => String(id).split('_')[1]));
  const lanesLead = laneOf(lead.scr), lanesMate = laneOf(mate.scr);
  ok(lanesLead.size === 1 && lanesMate.size === 1,
    `каждый видит ровно свою полосу (лидер ${[...lanesLead]}, напарник ${[...lanesMate]})`);
  ok(lanesLead.size === 1 && lanesMate.size === 1 && [...lanesLead][0] !== [...lanesMate][0],
    'и полосы у них разные');

  // ── попытка списана ровно один раз ───────────────────────────────────────
  eq(await usedOf(lead.id) - before, 1, 'списана ровно одна попытка');

  lead.sock.close(); mate.sock.close();
  await wait(1200);

  // ── обрыв связи во время пятисекундного отсчёта ───────────────────────────
  // Между развёртыванием и появлением первой волны проходит пять секунд. Это
  // ровно то окно, в которое у телефона в метро успевает моргнуть сеть.
  //
  // Что должно быть: либо забег идёт у обоих, либо не идёт ни у кого и попытка
  // возвращается. Чего быть НЕ должно: один стоит в пустой комнате, а попытка
  // потрачена — «моя комната первая была пуста, слил попытку».
  console.log('  ── обрыв связи в отсчёте ──');
  await resetCoop([lead.id, mate.id]);
  const lead2 = await connect(TG1, `${TAG}_lead`);
  let mate2 = await connect(TG2, `${TAG}_mate`);
  lead2.sock.emit('coopGroupCreate');
  await once(lead2.sock, 'coopGroupState', 6000);
  mate2.sock.emit('coopGroupJoin', { id: lead2.sock.id, leaderId: lead2.sock.id });
  await wait(500);

  const before2 = await usedOf(mate2.id);
  lead2.sock.emit('coopGroupStart');
  const started2 = await Promise.race([
    once(lead2.sock, 'coopStarted', 9000).then(() => 'ok'),
    once(lead2.sock, 'coopError', 9000).then(e => 'отказ: ' + (e && e.msg)),
  ]).catch(e => 'нет ответа: ' + e.message);
  ok(started2 === 'ok', 'второй запуск принят', started2);

  if (started2 === 'ok') {
    // Сеть моргнула у напарника, он вернулся сразу — как это и происходит.
    await wait(1200);
    mate2.sock.close();
    await wait(400);
    mate2 = await connect(TG2, `${TAG}_mate`);
    // Возврата ждём по факту: этаж и число монстров перестают меняться, когда
    // сервер закончил разбираться с оборвавшимся забегом.
    await until(() => mate2.scr.floor != null && mate2.scr.floors.length > 0, 12000);
    await wait(2000);

    const spent2 = await usedOf(mate2.id) - before2;
    const seen2 = mate2.scr.enemies.size;
    const onCoop = mate2.scr.floor === 12;
    console.log(`      после возврата: этаж ${mate2.scr.floor} · монстров ${seen2} · попыток списано ${spent2}`);
    // Единственное недопустимое сочетание и есть жалоба целиком.
    ok(!(onCoop && seen2 === 0 && spent2 > 0),
      'нет случая «стою в пустой комнате, а попытка списана»',
      `этаж ${mate2.scr.floor}, монстров ${seen2}, списано ${spent2}`);
    // Забег оборвался до первой волны — монстров не было, попытка вернулась.
    await wait(300);
    eq(await usedOf(mate2.id) - before2, 0, 'обрыв в отсчёте — попытка напарника возвращена');
    eq(await usedOf(lead2.id), 0, 'и лидера тоже');
    // И лидер не должен остаться заперт в забеге, которого больше нет.
    await wait(500);
    lead2.sock.emit('coopReturn');
    const home = await Promise.race([
      once(lead2.sock, 'deathBattleReturned', 5000).then(() => 'дома'),
      once(lead2.sock, 'gameStart', 5000).then(g => g.floor === 1 ? 'дома' : 'этаж ' + g.floor),
    ]).catch(() => 'не ответил');
    ok(home === 'дома', 'лидер может уйти домой после срыва забега', home);
  }
  lead2.sock.close(); mate2.sock.close();
  await wait(600);

  // ── медленный телефон: gameStart применяется ПОЗЖЕ, чем пришли монстры ────
  // Карта нового этажа едет по сети (/api/world-map), и клиент пересобирает
  // мир только когда она доехала. На телефоне это секунды — а первая волна
  // Сотрудничества появляется через пять.
  //
  // Здесь это воспроизводится ровно так, как ведёт себя клиент: gameStart
  // придерживается, поток gameState тем временем идёт, и лишь потом снимок
  // применяется поверх — со сбросом таблицы дескрипторов, как в
  // js/network.js. Если после этого комната осталась пустой — это и есть
  // жалоба.
  console.log('  ── медленный телефон ──');
  {
    const { resetNetCodecMaps } = require('../shared/netcodec');
    // Свежая пара: у каждого своя попытка на сутки.
    const TG3 = TG1 + 2, TG4 = TG1 + 3;
    const lead3 = await connect(TG3, `${TAG}_slowlead`);

    // Медленный телефон. gameStart придерживается, поток gameState идёт —
    // ровно так ведёт себя клиент, пока по сети едет карта нового этажа.
    const sock = io(BASE, { transports: ['websocket'], forceNew: true });
    await once(sock, 'connect');
    let held, applied = false;
    const seen = new Map();
    sock.on('gameStart', g => { if (!applied) held = g; });
    sock.on('gameState', buf => {
      let st; try { st = decodeGameState(buf); } catch { return; }
      for (const e of (st.enemies || st.e || [])) if (e.id) seen.set(e.id, e);
    });
    sock.on('enemiesRemoved', ({ ids } = {}) => { for (const id of (ids || [])) seen.delete(id); });
    sock.emit('loginTelegramWebApp', { initData: initData(TG4, `${TAG}_slowmate`) });
    await once(sock, 'authOk', 12000);
    const { rows: r4 } = await pool().query('SELECT id FROM players WHERE telegram_id = $1', [String(TG4)]);
    made.push(Number(r4[0].id));
    await pool().query('UPDATE player_progress SET lvl = 20 WHERE player_id = $1', [Number(r4[0].id)]);
    sock.emit('selectChar', { type: 'mage' });
    await once(sock, 'gameStart', 12000);
    await wait(300);

    lead3.sock.emit('coopGroupCreate');
    await once(lead3.sock, 'coopGroupState', 6000);
    held = null;
    sock.emit('coopGroupJoin', { id: lead3.sock.id, leaderId: lead3.sock.id });
    await wait(500);
    lead3.sock.emit('coopGroupStart');
    const st3 = await Promise.race([
      once(lead3.sock, 'coopStarted', 9000).then(() => 'ok'),
      once(lead3.sock, 'coopError', 9000).then(e => 'отказ: ' + (e && e.msg)),
    ]).catch(e => 'нет ответа: ' + e.message);
    ok(st3 === 'ok', 'забег для медленного телефона запущен', st3);

    if (st3 === 'ok') {
      // Ждём, пока первая волна доедет потоком, — это и есть «карта ещё
      // грузится» с точки зрения клиента.
      await until(() => seen.size > 0, 20000);
      const before = seen.size;
      ok(before > 0, `монстры приехали, пока карта грузилась (${before})`);
      const snapN = (held && held.enemies || []).length;

      // Карта доехала — клиент пересобирает мир: список врагов заменяется
      // снимком из gameStart, таблица дескрипторов сбрасывается.
      applied = true;
      seen.clear();
      for (const e of (held && held.enemies) || []) seen.set(e.id, e);
      resetNetCodecMaps();
      sock.emit('enemyResyncAll');         // ровно то, что теперь шлёт клиент
      // Пересылка ограничена тремя секундами на сервере, поэтому ждём до пяти
      // — но выходим, как только монстры вернулись.
      await until(() => seen.size > 0, 5000);
      console.log(`      до пересборки ${before} · снимок нёс ${snapN} · через 3.5с видно ${seen.size}`);
      ok(snapN === 0, 'снимок был снят ДО первой волны и пуст — это и есть ловушка', String(snapN));
      ok(seen.size > 0, 'после пересборки мира комната НЕ пуста', `видно ${seen.size}`);
    }
    sock.close(); lead3.sock.close();
    await wait(400);
  }

  // ── и правило, из-за которого это вообще случалось ───────────────────────
  // Снимок в gameStart — это ВСЁ, что клиент будет знать о врагах: таблицу
  // дескрипторов он при этом сбрасывает целиком. Значит и серверная память о
  // том, «что клиент уже держит», не может пережить снимок.
  {
    const Room = require('../server/game/Room');
    const { FLOOR_IDS } = require('../server/game/floors');
    const fakeIo = { to: () => ({ emit: () => {} }), emit: () => {}, sockets: { sockets: new Map() } };
    const room = new Room(FLOOR_IDS.coop, fakeIo, {}, null);
    room.addPlayer('S', 'Проверка', null, 0, 0, '1', null);
    room.coopDeploy('S');
    room.coopStartFirstStage();
    const me = room.players.get('S');
    // Сервер «уже отправил» чужого монстра: запись есть, полная.
    me._eKnown.set('посторонний', { x: 0, y: 0, hp: 1, aggro: false, seen: 0, full: true });
    const snap = room.enemySnapshot('S');
    ok(snap.length > 0, `снимок несёт монстров полосы (${snap.length})`);
    ok(!me._eKnown.has('посторонний'),
      'память сервера о «клиент это уже держит» не переживает снимок');
    ok([...me._eKnown.values()].every(v => v.full === false),
      'всё в снимке помечено как «дескриптор ещё не выдан»');
    room._stopLoop && room._stopLoop();
  }

  // ── аудит: смерть, награда за босса, возврат попытки ──────────────────────
  console.log('  ── смерть и награда ──');
  {
    const createCoop = require('../server/game/coop');
    const progression = require('../server/db/repos/progression');
    const sent = [];
    const sockets = new Map();
    const fakeIo = {
      to: (sid) => ({ emit: (ev, d) => sent.push({ sid, ev, d }) }),
      emit: () => {}, sockets: { sockets },
    };
    const homed = [];
    const coop = createCoop({ io: fakeIo, _returnToHub: (sid) => { homed.push(sid); return { x: 1, y: 1 }; } });
    const deploy = () => {
      const room = coop._createCoopRoom();
      room.addPlayer('A', 'Аня', null, null, 0, '1', null);
      room.addPlayer('B', 'Боря', null, null, 0, '2', null);
      room.coopDeploy('A', 0); room.coopDeploy('B', 1);
      coop._coop.set('A', { room, lane: 0, partnerId: 'B' });
      coop._coop.set('B', { room, lane: 1, partnerId: 'A' });
      return room;
    };

    // Монстр убил одного — забег кончается у обоих сразу, без «Возродиться».
    let room = deploy();
    room.players.get('A').hp = 0;
    room.onCoopDeath('A');
    await new Promise(r => setImmediate(r));
    ok(!coop._coop.has('A') && !coop._coop.has('B'), 'смерть от монстра снимает забег у обоих');
    ok(homed.includes('B') && !homed.includes('A'), 'живого напарника — домой, погибший лежит до «Возродиться»');
    ok(sent.some(m => m.sid === 'B' && m.ev === 'coopFinished' && m.d.cleared === false && m.d.reason === 'died'),
      'напарнику — «забег прерван, кто-то погиб»');
    ok(sent.some(m => m.sid === 'A' && m.ev === 'coopFinished'), 'погибшему — тоже');
    room._stopLoop && room._stopLoop();

    // Босс: победитель и что именно легло — в пакете обоим.
    sent.length = 0; homed.length = 0;
    room = deploy();
    const grant = async () => ({ nexum: 100, items: [{ id: 'bless_stone', qty: 1 }], missed: [] });
    sockets.set('A', { data: { username: 'Аня', _grantCoopBossReward: grant } });
    sockets.set('B', { data: { username: 'Боря', _grantCoopBossReward: grant } });
    await coop._coopBossTrackKill('A', { arm: 'coop', isBoss: true });
    const rw = sent.filter(m => m.ev === 'coopBossReward');
    ok(rw.length === 2 && rw.every(m => m.d.nexum === 100 && m.d.items.length === 1 && m.d.winnerName),
      'итог босса несёт победителя, Liberty и предметы', JSON.stringify(rw[0] && rw[0].d));
    ok(rw.filter(m => m.d.won === true).length === 1 && rw.every(m => m.d.won === (m.sid === m.d.winnerId)),
      'won — только победителю жребия', JSON.stringify(rw.map(m => [m.sid, m.d.won])));
    ok(homed.length === 2, 'после босса оба дома');
    room._stopLoop && room._stopLoop();

    // Попытка, списанная под сорвавшийся вход, возвращается.
    const pid = lead.id;
    await resetCoop([pid]);
    await progression.takeAttempt(null, pid, 'coop', 1);
    ok(await progression.attemptsLeft(null, pid, 'coop', 1) === 0, 'попытка списана');
    ok(await progression.refundAttempt(null, pid, 'coop'), 'возврат принят');
    ok(await progression.attemptsLeft(null, pid, 'coop', 1) === 1, 'и попытка снова есть');
    ok(!await progression.refundAttempt(null, pid, 'coop'), 'ниже нуля не возвращается');
  }

  console.log('');
  console.log(fail === 0
    ? `  \x1b[32m${pass} пройшло, 0 впало\x1b[0m\n`
    : `  \x1b[31m${pass} пройшло, ${fail} впало\x1b[0m\n`);
  await wipeItemsAll(made);
  await close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error(e);
  try { await wipeItemsAll(made); await close(); } catch {}
  process.exit(1);
});
