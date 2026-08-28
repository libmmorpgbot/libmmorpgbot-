#!/usr/bin/env node
'use strict';
// What one player's WebSocket actually carries.
//
// Runs a small crowd of ordinary bots and one instrumented "probe" client in
// the middle of them, then reports that client's traffic broken down by event
// and by direction — bytes, packets, and the engine.io framing underneath
// (socket.io sends a binary event as TWO frames: a JSON envelope naming the
// event, plus the payload).
//
//   npm run dev:local            (in another terminal)
//   node dev/netprobe.js [neighbours] [seconds] [mode]
//     mode: hub | spread | far    (same layouts as dev/loadtest.js)
//
// Knobs: PROJ, ATTACK, MOVE_MODE, MAPVIEW — as in dev/loadtest.js, applied to
// the neighbours so the probe sees a realistic amount of company.

const { io } = require('socket.io-client');
const { decodeGameState } = require('../shared/netcodec');

const URL = process.env.URL || 'http://localhost:3000';
const NEIGH = Number(process.argv[2] || 20);
const SECS = Number(process.argv[3] || 20);
const MODE = process.argv[4] || 'hub';
const SPREAD = MODE === 'hub' ? 200 : MODE === 'far' ? 0 : 1500;

const TYPES = ['lev', 'deathknight', 'ranger', 'mage', 'warlock'];

// Точка входа приходит в самом gameStart (worldPayload, server/session.js).
// Здесь она вычитывалась из карты по адресу /api/world-map/<version>, которого
// не существует — маршрут /api/world-map/:floor/:ver, — так что ответом был
// HTML страницы 404 и разбор падал на ERR_BUFFER_OUT_OF_BOUNDS.

async function connect(name, type) {
  const { initData } = await (await fetch(`${URL}/dev/init-data?dev=${name}`)).json();
  const s = io(URL, { transports: ['websocket'], upgrade: false });
  s.on('connect', () => s.emit('loginTelegramWebApp', { initData }));
  s.on('authOk', () => s.emit('selectChar', { type, savedStats: null }));
  const spawn = await new Promise(res => s.on('gameStart',
    ({ spawn }) => res(spawn)));
  return { s, spawn };
}

// Bots stand in monster territory, so they die — and the server refuses a dead
// player's moves (see updatePlayerPos), which quietly turns a walking bot into
// a corpse that skews everything measured around it. Respawn like a real
// player would.
function keepAlive(c) {
  c.s.on('playerHurt', ({ id, hp }) => {
    if (id === c.s.id && hp <= 0) setTimeout(() => c.s.emit('respawn'), 300);
  });
}

function walker(c, ox, oy, opts = {}) {
  let ang = Math.random() * 7, x = ox, y = oy;
  const timers = [];
  timers.push(setInterval(() => {
    ang += (Math.random() - 0.5) * 0.4;
    x += Math.cos(ang) * 3.2; y += Math.sin(ang) * 3.2;
    const dx = x - ox, dy = y - oy;
    if (dx * dx + dy * dy > 300 * 300) ang += Math.PI;
    // Same compact form the real client sends (netSendMove, js/network.js):
    // [x*2, y*2, facingIndex, hp]. LEGACY_MOVE=1 sends the old object shape
    // instead, which is how the before/after comparison was measured.
    if (process.env.LEGACY_MOVE === '1') c.s.volatile.emit('playerMove', { x, y, facing: 'front', hp: 200 });
    else c.s.volatile.emit('mv', [Math.round(x * 2), Math.round(y * 2), 0, 200]);
    if (opts.onMove) opts.onMove(x, y);
    // 33ms, not 50: that is what the real client's 25ms threshold works out to
    // once it is quantised to frame boundaries (see _MOVE_SEND_MS in
    // js/network.js), and the send rate has to stay above the server's 20Hz
    // cast rate or casts start repeating positions.
  }, 33));
  const proj = Number(process.env.PROJ ?? 2);
  if (proj > 0) timers.push(setInterval(() => {
    c.s.emit('spawnProj', { x, y, vx: 300, vy: 40, color: '#8fbf5a',
      size: 5, projType: 'arrow', angle: 0.1, life: 1.8 });
  }, 1000 / proj));
  return () => timers.forEach(clearInterval);
}

(async () => {
  // Neighbours first, so the probe joins a world that is already busy.
  const spawn = (await connect('probeAnchor', 'lev')).spawn;
  const stops = [];
  const neighbours = [];
  for (let i = 0; i < NEIGH; i++) {
    const c = await connect(`np${i}`, TYPES[i % TYPES.length]);
    neighbours.push(c);
    keepAlive(c);
    stops.push(walker(c, spawn.x + (Math.random() - 0.5) * SPREAD,
      spawn.y + 12000 + (Math.random() - 0.5) * SPREAD));
    await new Promise(r => setTimeout(r, 20));
  }

  const probe = await connect('netprobe', 'ranger');
  // Per-event accounting. socket.io hands binary payloads over as attachments,
  // so the event-level view and the frame-level view below disagree on
  // purpose: the difference IS the framing overhead.
  const inEvents = new Map();  // event -> { n, bytes }
  const outEvents = new Map();
  const gsSizes = [];
  const bump = (m, k, b) => {
    const e = m.get(k) || { n: 0, bytes: 0 };
    e.n++; e.bytes += b; m.set(k, e);
  };
  const sizeOf = a => {
    if (a == null) return 0;
    if (typeof a === 'string') return Buffer.byteLength(a);
    if (a instanceof ArrayBuffer) return a.byteLength;
    if (ArrayBuffer.isView(a)) return a.byteLength;
    return Buffer.byteLength(JSON.stringify(a));
  };

  let inFrames = 0, inFrameBytes = 0, outFrames = 0, outFrameBytes = 0;
  probe.s.io.engine.on('packet', p => { inFrames++; inFrameBytes += sizeOf(p.data); });
  probe.s.io.engine.on('packetCreate', p => { outFrames++; outFrameBytes += sizeOf(p.data); });
  let carriedProjs = 0, carriedAoes = 0;
  probe.s.onAny((ev, ...args) => {
    const b = args.reduce((s, a) => s + sizeOf(a), 0);
    bump(inEvents, ev, b);
    if (ev === 'gameState') {
      gsSizes.push(b);
      const a = args[0];
      try {
        const st = decodeGameState(a instanceof ArrayBuffer ? a
          : a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength));
        carriedProjs += (st.projs || []).length;
        carriedAoes += (st.aoes || []).length;
      } catch (_) { /* not our format */ }
    }
  });
  probe.s.onAnyOutgoing((ev, ...args) => bump(outEvents, ev, args.reduce((s, a) => s + sizeOf(a), 0)));

  keepAlive(probe);
  stops.push(walker(probe, spawn.x, spawn.y + 12000));
  // After the first playerMove has landed: the server only sends map dots for
  // the arm the viewer is standing in, and until a position arrives it still
  // has them at the hub spawn, where there are no monsters to plot.
  if (process.env.MAPVIEW === '1') setTimeout(() => probe.s.emit('mapView', { open: true }), 500);

  // Settle, then reset every counter so the join burst isn't in the sample.
  await new Promise(r => setTimeout(r, 3000));
  inEvents.clear(); outEvents.clear(); gsSizes.length = 0;
  inFrames = inFrameBytes = outFrames = outFrameBytes = 0;
  const t0 = Date.now();
  await new Promise(r => setTimeout(r, SECS * 1000));
  const secs = (Date.now() - t0) / 1000;

  const table = m => [...m.entries()]
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .map(([ev, e]) => ({
      event: ev,
      perSec: +(e.n / secs).toFixed(1),
      bytesPerSec: Math.round(e.bytes / secs),
      avgBytes: Math.round(e.bytes / e.n),
    }));

  const inPayload = [...inEvents.values()].reduce((s, e) => s + e.bytes, 0);
  const outPayload = [...outEvents.values()].reduce((s, e) => s + e.bytes, 0);
  const sorted = [...gsSizes].sort((a, b) => a - b);
  const q = p => sorted.length ? sorted[Math.floor(sorted.length * p)] : 0;

  console.log(JSON.stringify({
    scenario: { neighbours: NEIGH, mode: MODE, seconds: +secs.toFixed(1),
      projectilesPerNeighbour: Number(process.env.PROJ ?? 2) },
    down: {
      events: table(inEvents),
      framesPerSec: +(inFrames / secs).toFixed(1),
      payloadBytesPerSec: Math.round(inPayload / secs),
      wireBytesPerSec: Math.round(inFrameBytes / secs),
      framingOverheadPct: +(100 - inPayload / inFrameBytes * 100).toFixed(1),
      gameStatePayloadBytes: { p50: q(0.5), p90: q(0.9), max: sorted[sorted.length - 1] || 0 },
      // Combat visuals delivered inside the cast rather than as their own
      // events — the same things that used to show up as spawnProj/spawnAoe.
      carriedInCastPerSec: { projectiles: +(carriedProjs / secs).toFixed(1), aoe: +(carriedAoes / secs).toFixed(1) },
    },
    up: {
      events: table(outEvents),
      framesPerSec: +(outFrames / secs).toFixed(1),
      payloadBytesPerSec: Math.round(outPayload / secs),
      wireBytesPerSec: Math.round(outFrameBytes / secs),
    },
    perHourMB: {
      down: +(inFrameBytes / secs * 3600 / 1048576).toFixed(1),
      up: +(outFrameBytes / secs * 3600 / 1048576).toFixed(1),
    },
  }, null, 2));

  stops.forEach(f => f());
  [probe, ...neighbours].forEach(c => c.s.disconnect());
  process.exit(0);
})();
