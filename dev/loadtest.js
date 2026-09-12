#!/usr/bin/env node
'use strict';
// Synthetic load: N socket.io clients that log in through /dev/init-data,
// pick a class, walk around and fight, and report the latency they see.
// Needs a server started by dev/local.js (the /dev/init-data login route only
// exists there) — see dev/README.md.
//
//   node dev/loadtest.js [count] [seconds] [mode]
//     mode: hub    — everyone piles into the spawn area (default)
//           spread — bots wander over a wide area
//           far    — one bot every 3000px: nobody in anybody's interest radius
//
// Knobs, all env vars, each isolating one measured cost:
//   MOVE_HZ=40   playerMove rate per bot; 0 = never move
//   MOVE_MODE=legacy|smart   which client generation to imitate (see below)
//   IDLE_PCT=0   share of bots that stand still for the whole run
//   ATTACK=5     attacks/s per bot (server caps a socket at 20/s)
//   PROJ=0       spawnProj/s per bot — the floor-wide combat visuals
//   MAPVIEW=1    keep the map panel open (subscribes to the mapBlips feed)
//   STAGGER=25   ms between logins; 0 reproduces a post-restart reconnect storm
//   TAG=bot      account name prefix (distinct names = distinct accounts)
//   URL=http://localhost:3000

const { io } = require('socket.io-client');

const URL = process.env.URL || 'http://localhost:3000';
const N = Number(process.argv[2] || 100);
const SECS = Number(process.argv[3] || 30);
const MODE = process.argv[4] || 'hub';
const TAG = process.env.TAG || 'bot';

const TYPES = ['lev', 'deathknight', 'ranger', 'mage', 'warlock'];

const rtts = [];          // every ping sample
const perBot = new Map(); // id -> {samples, max}
let connected = 0, authed = 0, started = 0, errors = 0, gsPackets = 0, gsBytes = 0;
let blipPackets = 0, blipBytes = 0;
let disconnects = 0;

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

// The world map, fetched once per floor per process (a browser would cache it
// per device). Only the spawn point is needed here — bots don't render.
//
// Keyed and requested BY FLOOR: since the world was split into one Room per
// floor the route is /api/world-map/:floor/:ver and each floor has its own
// bytes, so the old single-slot cache under a bare version string asked for a
// URL that no longer exists (every call 404'd, and the await never produced a
// spawn) and would have mixed two floors' maps if it had.
const _mapPromises = new Map(); // floor -> Promise<spawn>
function worldSpawn(floor, version) {
  if (!_mapPromises.has(floor)) {
    _mapPromises.set(floor, fetch(`${URL}/api/world-map/${floor}/${version}`)
      .then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`world-map ${r.status}`))))
      .then(buf => {
        const dv = new DataView(buf);
        const jsonLen = dv.getUint32(0, true);
        return JSON.parse(Buffer.from(buf, 4, jsonLen).toString('utf8')).spawn;
      }));
  }
  return _mapPromises.get(floor);
}

async function initData(name) {
  const r = await fetch(`${URL}/dev/init-data?dev=${name}`);
  const j = await r.json();
  return j.initData;
}

async function makeBot(i) {
  const name = `${TAG}${i}`;
  const initDataStr = await initData(name);
  const socket = io(URL, { transports: ['websocket'], upgrade: false });
  const st = { t0: Date.now(), startMs: -1, samples: [], max: 0, spawn: null, x: 0, y: 0, ang: Math.random() * 7, enemies: new Map() };
  perBot.set(i, st);

  socket.on('connect', () => {
    connected++;
    socket.emit('loginTelegramWebApp', { initData: initDataStr });
  });
  socket.on('connect_error', () => { errors++; });
  socket.on('disconnect', () => { disconnects++; });
  socket.on('authError', m => { errors++; console.error('authError', name, m); });
  socket.on('authOk', () => {
    authed++;
    socket.emit('selectChar', { type: TYPES[i % TYPES.length], savedStats: null });
  });
  socket.on('gameStart', async ({ floor, mapVersion, enemies }) => {
    started++;
    st.startMs = Date.now() - st.t0;
    // Same path as the real client: the map comes over HTTP, cached per
    // process here the way the browser caches it per device.
    const spawn = await worldSpawn(floor, mapVersion);
    st.spawn = spawn;
    if (MODE === 'far') {
      // One bot every 3000px down the map: nobody is inside anybody else's
      // interest radius, which is what an idle player alone in a corridor
      // looks like to the server.
      st.x = spawn.x;
      st.y = spawn.y + 4000 + i * 3000;
    } else {
      st.x = spawn.x + (Math.random() - 0.5) * (MODE === 'hub' ? 200 : 1200);
      st.y = spawn.y + (Math.random() - 0.5) * (MODE === 'hub' ? 200 : 1200);
    }
    st.ox = st.x; st.oy = st.y;
    (enemies || []).forEach(e => st.enemies.set(e.id, e));
  });
  socket.on('gameState', buf => {
    gsPackets++;
    gsBytes += buf.byteLength || buf.length || 0;
  });
  socket.on('mapBlips', buf => {
    blipPackets++;
    blipBytes += buf.byteLength || buf.length || 0;
  });
  socket.on('_pong', t0 => {
    const rtt = Date.now() - t0;
    rtts.push(rtt);
    st.samples.push(rtt);
    if (rtt > st.max) st.max = rtt;
  });

  // Movement. MOVE_MODE picks which client generation to imitate:
  //   legacy — a fixed MOVE_HZ, sent whether or not anything changed
  //   smart  — what js/network.js does now: at most 20Hz, only on real change,
  //            with a 1Hz keepalive
  // IDLE_PCT of the bots stand still for the whole run (players in a menu, at
  // a vendor, reading chat) — the population the "only on change" rule is for.
  const MOVE_HZ = Number(process.env.MOVE_HZ ?? 40);
  const MOVE_MODE = process.env.MOVE_MODE || 'legacy';
  const idle = (i % 100) < Number(process.env.IDLE_PCT ?? 0);
  let lastSentX = null, lastSentY = null, lastSentAt = 0;
  const moveTimer = MOVE_HZ === 0 ? null : setInterval(() => {
    if (!st.spawn) return;
    if (!idle) {
      st.ang += (Math.random() - 0.5) * 0.4;
      const spd = 3.2;
      st.x += Math.cos(st.ang) * spd;
      st.y += Math.sin(st.ang) * spd;
      // keep bots roughly inside their zone
      const r = MODE === 'hub' ? 260 : (MODE === 'far' ? 400 : 1500);
      const ox = st.ox ?? st.spawn.x, oy = st.oy ?? st.spawn.y;
      const dx = st.x - ox, dy = st.y - oy;
      if (dx * dx + dy * dy > r * r) st.ang += Math.PI;
    }
    if (MOVE_MODE === 'smart') {
      const now = Date.now();
      const moved = lastSentX === null ||
        Math.abs(st.x - lastSentX) > 0.5 || Math.abs(st.y - lastSentY) > 0.5;
      if (!moved && now - lastSentAt < 1000) return;
      lastSentX = st.x; lastSentY = st.y; lastSentAt = now;
      socket.volatile.emit('playerMove', { x: st.x, y: st.y, facing: 'front', hp: 200 });
      return;
    }
    socket.emit('playerMove', { x: st.x, y: st.y, facing: 'front', hp: 200 });
  }, 1000 / (MOVE_MODE === 'smart' ? Math.min(MOVE_HZ, 20) : MOVE_HZ));

  const pingTimer = setInterval(() => socket.volatile.emit('_ping', Date.now()), 1000);

  // Combat: the server caps a socket at 20 attacks/s (_atkAllowed); real
  // players sit near that with auto-attack on. ATTACK=0 disables.
  const ATK_HZ = Number(process.env.ATTACK ?? 5);
  let atkTimer = null;
  if (ATK_HZ > 0) {
    atkTimer = setInterval(() => {
      if (!st.enemies.size) return;
      const ids = [...st.enemies.keys()];
      socket.emit('attack', { enemyId: ids[(Math.random() * ids.length) | 0] });
    }, 1000 / ATK_HZ);
  }
  // Ranged classes emit one spawnProj per auto-attack (js/combat.js fireProj)
  const PROJ_HZ = Number(process.env.PROJ ?? 0);
  let projTimer = null;
  if (PROJ_HZ > 0) {
    projTimer = setInterval(() => {
      socket.emit('spawnProj', { x: st.x, y: st.y, vx: 300, vy: 40, color: '#8fbf5a',
        size: 5, projType: 'arrow', angle: 0.1, life: 1.8 });
    }, 1000 / PROJ_HZ);
  }
  if (process.env.MAPVIEW === '1') socket.on('gameStart', () => socket.emit('mapView', { open: true }));

  return () => {
    if (moveTimer) clearInterval(moveTimer);
    clearInterval(pingTimer);
    if (atkTimer) clearInterval(atkTimer);
    if (projTimer) clearInterval(projTimer);
    socket.disconnect();
  };
}

(async () => {
  const stops = [];
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    stops.push(await makeBot(i));
    await new Promise(r => setTimeout(r, Number(process.env.STAGGER ?? 25)));
  }
  console.log(`[load] ${N} bots up in ${Date.now() - t0}ms — running ${SECS}s`);
  rtts.length = 0; // discard login-storm samples
  await new Promise(r => setTimeout(r, SECS * 1000));

  const bad = [...perBot.entries()]
    .map(([i, s]) => ({ i, p95: pct(s.samples, 0.95), max: s.max, n: s.samples.length }))
    .sort((a, b) => b.p95 - a.p95);

  console.log(JSON.stringify({
    bots: N, mode: MODE, secs: SECS,
    connected, authed, started, errors, disconnects,
    rttSamples: rtts.length,
    rtt: { p50: pct(rtts, 0.5), p90: pct(rtts, 0.9), p99: pct(rtts, 0.99), max: Math.max(...rtts, 0) },
    worstBots: bad.slice(0, 5),
    loginToGameStartMs: (() => {
      const v = [...perBot.values()].map(s => s.startMs).filter(x => x >= 0).sort((a, b) => a - b);
      return v.length ? { p50: v[v.length >> 1], p90: v[Math.floor(v.length * 0.9)], max: v[v.length - 1] } : null;
    })(),
    gameStatePacketsPerSecPerBot: +(gsPackets / SECS / N).toFixed(1),
    gameStateKBsPerSecPerBot: +(gsBytes / 1024 / SECS / N).toFixed(1),
    mapBlipsPacketsPerSecPerBot: +(blipPackets / SECS / N).toFixed(1),
    mapBlipsKBsPerSecPerBot: +(blipBytes / 1024 / SECS / N).toFixed(1),
  }, null, 2));
  stops.forEach(f => f());
  process.exit(0);
})();
