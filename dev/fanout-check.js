#!/usr/bin/env node
'use strict';
// Functional check for the AOI-scoped combat visuals: a player standing next
// to the shooter must still see the projectile, and a player on the far side
// of the world must not. Guards the optimisation in server/index.js
// (_emitNearby) against silently deleting other people's effects.
//
//   MOVE_GUARD=off npm run dev:local     (in another terminal)
//   node dev/fanout-check.js
//
// MOVE_GUARD=off обязателен, и вот почему. Проверка ставит трёх ботов на
// расстояниях, которые НЕЛЬЗЯ пройти шагом: один рядом со стрелком, второй в
// другом рукаве, за восемнадцать тысяч пикселей. С включённым бюджетом
// движения (_checkMoveBudget, server/game/Room.js) такой прыжок — это ровно
// то, что бюджет и обязан отклонять, боты остаются на точке входа, снаряд
// ставится за двенадцать тысяч пикселей от них и выпадает из зоны видимости
// у ВСЕХ. Проверка тогда печатает нули по всем трём и не объясняет, почему.
//
// Здесь это уже не молчит: отказы считаются и печатаются отдельной строкой
// (см. posCorrect ниже). Проверка про зону видимости, а не про бюджет
// движения — у бюджета свой сценарий, dev/play-check.js.

const { io } = require('socket.io-client');
const { decodeGameState, unpackGrid } = require('../shared/netcodec');
const URL = process.env.URL || 'http://localhost:3000';

async function bot(name) {
  const { initData } = await (await fetch(`${URL}/dev/init-data?dev=${name}`)).json();
  const s = io(URL, { transports: ['websocket'], upgrade: false });
  // Projectiles and AOE rings ride the world cast now (shared/netcodec.js),
  // so they are counted out of the decoded gameState rather than off their own
  // events. The legacy events are still counted, so this check keeps working
  // whichever delivery a server is using.
  const got = { proj: 0, aoe: 0, refused: 0 };
  s.on('spawnProj', () => got.proj++);
  s.on('spawnAoe', () => got.aoe++);
  s.on('gameState', buf => {
    const st = decodeGameState(buf instanceof ArrayBuffer ? buf
      : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    got.proj += (st.projs || []).length;
    got.aoe  += (st.aoes  || []).length;
  });
  // Точка входа берётся ПРЯМО из gameStart — она там есть (worldPayload,
  // server/session.js). Раньше ради неё качалась и разбиралась вся карта, по
  // адресу /api/world-map/<version>, которого не существует: маршрут давно
  // /api/world-map/:floor/:ver. Ответом приходил HTML страницы 404, разбор
  // падал на ERR_BUFFER_OUT_OF_BOUNDS, и проверка не запускалась вообще —
  // то есть ничего не сторожила ровно с того дня, как маршрут поменяли.
  const start = await new Promise(resolve => {
    s.on('connect', () => s.emit('loginTelegramWebApp', { initData }));
    s.on('authOk', () => s.emit('selectChar', { type: 'ranger', savedStats: null }));
    s.on('gameStart', (p) => resolve(p));
  });
  const spawn = start.spawn;
  // Сервер отвечает posCorrect на каждый отклонённый шаг. Без этого счётчика
  // отклонённая расстановка выглядела как «никто ничего не увидел» — то есть
  // как провал самой проверки, а не как невыполненное условие.
  s.on('posCorrect', () => { got.refused++; });
  return { s, got, spawn, start,
    moveTo(x, y) { s.emit('playerMove', { x, y, facing: 'front', hp: 200 }); } };
}

(async () => {
  const shooter = await bot('fanShooter');
  const near    = await bot('fanNear');
  const far     = await bot('fanFar');
  // ── позиции берутся из КАРТЫ, а не назначаются числами ─────────────────
  // Прежние координаты (spawn + 12000 и + 30000 по вертикали) сервер
  // отклонял: там стена. Отклонённая расстановка выглядела как «никто ничего
  // не увидел» — то есть как провал самой проверки. Теперь проходимые клетки
  // ищутся в настоящей сетке этажа, той же, которую грузит клиент.
  const { floor, mapVersion } = shooter.start;
  const mbuf = await (await fetch(`${URL}/api/world-map/${floor}/${encodeURIComponent(mapVersion)}`)).arrayBuffer();
  const jsonLen = new DataView(mbuf).getUint32(0, true);
  const meta = JSON.parse(Buffer.from(mbuf, 4, jsonLen).toString('utf8'));
  const grid = unpackGrid(new Uint8Array(mbuf, 4 + jsonLen), meta.w, meta.h);
  const T = meta.tile || 40;
  const walkable = [];
  for (let gy = 0; gy < meta.h; gy++) {
    for (let gx = 0; gx < meta.w; gx++) if (grid[gy][gx]) walkable.push([gx * T + T / 2, gy * T + T / 2]);
  }
  if (walkable.length < 3) throw new Error('на этаже нет проходимых клеток — карта не разобралась');
  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  // Стрелок — в первой проходимой клетке; «рядом» — ближайшая к нему другая;
  // «далеко» — самая дальняя, какая есть на этаже.
  const pShooter = walkable[0];
  let pNear = null, pFar = null, nearD = Infinity, farD = -1;
  for (const c of walkable) {
    const d = d2(c, pShooter);
    if (d > 0 && d < nearD) { nearD = d; pNear = c; }
    if (d > farD) { farD = d; pFar = c; }
  }
  const [x, y] = pShooter;

  shooter.moveTo(x, y);
  near.moveTo(pNear[0], pNear[1]);
  far.moveTo(pFar[0], pFar[1]);
  await new Promise(r => setTimeout(r, 1500));

  for (let i = 0; i < 10; i++) {
    shooter.s.emit('spawnProj', { x, y, vx: 300, vy: 0, color: '#8fbf5a',
      size: 5, projType: 'arrow', angle: 0, life: 1.8 });
    shooter.s.emit('spawnAoe', { x, y, r: 110 });
  }
  await new Promise(r => setTimeout(r, 1500));

  const refused = shooter.got.refused + near.got.refused + far.got.refused;
  const ok = refused === 0
    && near.got.proj === 10 && near.got.aoe === 10
    && far.got.proj === 0 && far.got.aoe === 0;
  console.log(JSON.stringify({
    ok,
    // Не ноль — значит расстановка не состоялась, и всё, что ниже, говорит о
    // бюджете движения, а не о зоне видимости. Запускать с MOVE_GUARD=off.
    positionsRefused: refused,
    placedAt: { shooter: [x, y], near: pNear, far: pFar,
      farDistance: Math.round(Math.sqrt(farD)) },
    sent: { proj: 10, aoe: 10 },
    nearbyPlayerReceived: near.got,
    distantPlayerReceived: far.got,
    shooterEcho: shooter.got,
  }, null, 2));
  if (refused) {
    console.error('\n  боти не змогли зайняти позиції: ' + refused + ' відмов.'
      + '\n  запускати сервер з MOVE_GUARD=off — інакше перевіряється бюджет руху,'
      + '\n  а не зона видимості.');
  }
  [shooter, near, far].forEach(b => b.s.disconnect());
  process.exit(ok ? 0 : 1);
})();
