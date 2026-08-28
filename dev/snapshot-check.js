#!/usr/bin/env node
'use strict';
// Do the position snapshots of a running player actually advance every cast?
//
// One bot runs in a straight line at a fixed send rate; another decodes the
// world stream and looks at the sequence of positions it is given for them. A
// snapshot that repeats the previous position is a 50ms window in which the
// watcher's interpolation has nothing to move towards — on screen that is the
// character standing still for a frame and then jumping, and the run animation
// restarting from frame 0. It happens when the sender's rate is not comfortably
// above the server's cast rate: the two clocks drift against each other, and
// every so often a cast lands with no new position to report.
//
//   npm run dev:local     (in another terminal)
//   node dev/snapshot-check.js [seconds]
//     MOVE_HZ=20   sender's rate (the server casts at 20Hz)

const { io } = require('socket.io-client');
const { decodeGameState, unpackGrid } = require('../shared/netcodec');

const URL = process.env.URL || 'http://localhost:3000';
const SECS = Number(process.argv[2] || 15);
const MOVE_HZ = Number(process.env.MOVE_HZ || 20);

async function connect(name, type) {
  const { initData } = await (await fetch(`${URL}/dev/init-data?dev=${name}`)).json();
  const s = io(URL, { transports: ['websocket'], upgrade: false });
  s.on('connect', () => s.emit('loginTelegramWebApp', { initData }));
  s.on('authOk', () => s.emit('selectChar', { type, savedStats: null }));
  const start = await new Promise(res => s.on('gameStart', res));
  return { s, start };
}

// ── круг, по которому бежит бегун, ищется в НАСТОЯЩЕЙ сетке этажа ──────────
// Раньше центр был записан числами: X0 = 700, Y0 = 13380, «в открытом мире,
// заведомо вне безопасной зоны». Карта с тех пор изменилась, там стена, и
// updatePlayerPos отклонял КАЖДЫЙ шаг. Бегун стоял на точке входа, наблюдатель
// видел одну и ту же позицию раз за разом, и проверка печатала
// «repeatedPct: 100» — то есть обвиняла сервер в том, что снимки не двигаются,
// хотя двигаться было нечему. Симптом при этом выглядел ровно как настоящий
// баг, который она и сторожит.
//
// Теперь центр берётся из сетки: ищется проходимая клетка, вокруг которой
// проходим весь круг радиуса R. Если такой нет — проверка честно об этом
// говорит, а не тихо меряет неподвижного бота.
async function findCircle(start, R) {
  const buf = await (await fetch(
    `${URL}/api/world-map/${start.floor}/${encodeURIComponent(start.mapVersion)}`)).arrayBuffer();
  const jsonLen = new DataView(buf).getUint32(0, true);
  const meta = JSON.parse(Buffer.from(buf, 4, jsonLen).toString('utf8'));
  const grid = unpackGrid(new Uint8Array(buf, 4 + jsonLen), meta.w, meta.h);
  const T = meta.tile || 40;
  const walk = (x, y) => {
    const gx = Math.floor(x / T), gy = Math.floor(y / T);
    return gy >= 0 && gy < meta.h && gx >= 0 && gx < meta.w && !!grid[gy][gx];
  };
  // Шестнадцать точек круга плюс место наблюдателя в 120 px правее центра.
  const ok = (cx, cy) => {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      if (!walk(cx + Math.cos(a) * R, cy + Math.sin(a) * R)) return false;
    }
    return walk(cx + 120, cy);
  };
  for (let gy = 0; gy < meta.h; gy++) {
    for (let gx = 0; gx < meta.w; gx++) {
      if (!grid[gy][gx]) continue;
      const cx = gx * T + T / 2, cy = gy * T + T / 2;
      if (ok(cx, cy)) return { x: cx, y: cy };
    }
  }
  return null;
}

(async () => {
  const runnerC = await connect('snapRunner', 'lev');
  const watcherC = await connect('snapWatcher', 'lev');
  const runner = runnerC.s, watcher = watcherC.s;

  // Side by side in open world, on ground both of them can actually stand on.
  const R = 150;
  const centre = await findCircle(runnerC.start, R);
  if (!centre) {
    console.error('');
    console.error('  сервер отклонил ' + refused + ' ходов — бегун стоял на месте.');
    console.error('  цифры выше НЕ о снимках; запускать сервер с MOVE_GUARD=off.');
    process.exit(1);
  }
  const X0 = centre.x, Y0 = centre.y;
  watcher.volatile.emit('mv', [(X0 + 120) * 2, Y0 * 2, 0, 200]);

  // Сервер отвечает posCorrect на каждый отклонённый шаг. Без этого счётчика
  // отклонённая расстановка выглядит как «снимки не двигаются» — то есть как
  // ровно тот баг, который проверка сторожит.
  let refused = 0;
  runner.on('posCorrect', () => { refused++; });
  watcher.on('posCorrect', () => { refused++; });

  // The watcher's view of the runner: one entry per cast that mentions them.
  const seen = [];
  watcher.on('gameState', buf => {
    const st = decodeGameState(buf instanceof ArrayBuffer ? buf
      : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    if (!st.players) return;
    for (const p of st.players) {
      if (p.id === watcher.id) continue;
      seen.push({ t: st.t, x: p.x, y: p.y });
    }
  });

  // A circle rather than a straight line: constant speed, no direction
  // reversals to mistake for stalls, and the runner never leaves the watcher's
  // 600px interest radius (a straight run leaves it in about three seconds and
  // the stream correctly goes quiet).
  const speed = 200; // px/s, roughly a character's run
  const step = 1000 / MOVE_HZ;
  let th = 0;
  const timer = setInterval(() => {
    th += (speed / R) * (step / 1000);
    const x = X0 + Math.cos(th) * R, y = Y0 + Math.sin(th) * R;
    runner.volatile.emit('mv', [Math.round(x * 2), Math.round(y * 2), 3, 200]);
  }, step);
  // Keep the watcher's own position fresh so the server keeps them in the room.
  const keep = setInterval(() => watcher.volatile.emit('mv', [(X0 + 120) * 2, Y0 * 2, 0, 200]), 500);

  await new Promise(r => setTimeout(r, 2000));
  seen.length = 0;
  await new Promise(r => setTimeout(r, SECS * 1000));
  clearInterval(timer); clearInterval(keep);

  let dupes = 0, gaps = 0;
  const deltas = [];
  for (let i = 1; i < seen.length; i++) {
    const d = Math.hypot(seen[i].x - seen[i - 1].x, seen[i].y - seen[i - 1].y);
    deltas.push(d);
    if (d < 0.01) dupes++;
    if (d > 15) gaps++; // two casts' worth of movement in one step
  }
  const secs = seen.length ? (seen[seen.length - 1].t - seen[0].t) / 1000 : 0;
  const avg = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;

  console.log(JSON.stringify({
    senderHz: MOVE_HZ,
    seconds: +secs.toFixed(1),
    snapshots: seen.length,
    snapshotsPerSec: +(seen.length / secs).toFixed(1),
    // Не ноль — значит бегун никуда не бежал, и всё, что ниже, меряет
    // неподвижного бота. Отчёт об этом обязан стоять ПЕРЕД цифрами: без него
    // «repeatedPct: 100» читается как найденный баг сервера, а не как
    // отклонённая расстановка.
    positionsRefused: refused,
    centre: { x: X0, y: Y0, r: R },
    repeatedPositions: dupes,
    repeatedPct: +(dupes / Math.max(1, deltas.length) * 100).toFixed(1),
    doubleSteps: gaps,
    avgPxPerSnapshot: +avg.toFixed(2),
  }, null, 2));

  runner.disconnect(); watcher.disconnect();
  if (refused) {
    console.error('');
    console.error('  сервер отклонил ' + refused + ' ходов — бегун стоял на месте.');
    console.error('  цифры выше НЕ о снимках; запускать сервер с MOVE_GUARD=off.');
    process.exit(1);
  }
  process.exit(0);
})();
