// ─────────────────────────────────────────────────────────
//  ОФОРМЛЕНИЕ КОРИДОРОВ ПРОКАЧКИ
// ─────────────────────────────────────────────────────────
// Каждый из четырёх коридоров (generateArm, server/game/dungeon.js) может
// получить свою тему под монстров, которые в нём живут, и тема меняется по ходу
// (что включено сейчас — см. _ZONE_ARMS):
// первая половина коридора — одна, ближе к боссу — другая. Граница между
// ними размыта по клеткам, чтобы смена читалась как переход, а не шов.
//
//   left   Крыса → Слизень → Бес      канализация      → адский подвал
//   top    Зомби → Ящер → Орк         болото           → лагерь орков
//   bottom Лоза → Вампир → Бехолдер   заросший склеп   → вампирская гробница
//   right  Древень → Демон            мёртвый лес      → преисподняя
//
// Геометрия не меняется — только картинка в чанках пола (_buildChunk,
// js/game.js), как и у города (js/city.js). Каждая клетка рисует свой
// декор в своих границах, поэтому соседние чанки стыкуются без швов. Тёмная
// вуаль у каждой темы своя; то, что светится (лава, свечи, огни на болоте),
// доигрывается поверх неё.

let _zonesEnabled = true;

function _zh(a, b, salt) {
  let h = (a * 374761393 + b * 668265263 + salt * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 15), 1274126177);
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 100000) / 100000;
}
function _zShade(hex, t) { return typeof _cityShade === 'function' ? _cityShade(hex, t) : hex; }
function _zVar(hex, tx, ty, salt, amt) { return _zShade(hex, (_zh(tx, ty, salt) - 0.5) * amt); }

// Все четыре коридора — в одном стиле, заданном канализацией (выбор
// владельца): кирпичный пол, толща стен в темноте, мелкие детали на
// клетках. Различаются палитрой и деталями. Вторая тема в паре — на случай,
// если захочется смены по ходу коридора; сейчас у всех одна.
const _ZONE_ARMS = {
  left:   ['sewer', 'sewer'],         // с 1 ур.
  top:    ['orcvault', 'orcvault'],   // с 20 ур.
  bottom: ['ossuary', 'ossuary'],     // с 40 ур.
  right:  ['emberhall', 'emberhall'], // с 60 ур.
};
// Фарм-зоны — в том же стиле, со своими темами.
const _ZONE_FARMS = {
  farmZone:  ['frostvault', 'frostvault'],    // Фарм-зона и её сезонное крыло
  farmHigh:  ['crystalmine', 'crystalmine'],  // Фарм зона 2 и её сезонное крыло
  farmZone2: ['goldvault', 'goldvault'],      // Элитная фарм-зона
};

let _zoneCache = null, _zoneCacheFor = null;
function _zoneLayout() {
  if (!_zonesEnabled) return null;
  const d = typeof dungeon !== 'undefined' ? dungeon : null;
  if (!d || !d.rooms) return null;
  if (_zoneCacheFor === d) return _zoneCache;
  _zoneCacheFor = d;
  // Коридор прокачки — по названию ветки в его комнатах; фарм-зоны — по
  // своему полю в данных этажа (сезонное крыло несёт то же поле, что и его
  // зона, поэтому выглядит так же).
  let stages = null;
  if (d.corridorGates) {
    const r0 = d.rooms.find(r => r.arm);
    stages = r0 && _ZONE_ARMS[r0.arm];
  } else if (d.farmZone2) stages = _ZONE_FARMS.farmZone2;
  else if (d.farmHigh) stages = _ZONE_FARMS.farmHigh;
  else if (d.farmZone) stages = _ZONE_FARMS.farmZone;
  if (!stages) return (_zoneCache = null);
  let x0 = 1e9, x1 = -1e9;
  for (const r of d.rooms) { x0 = Math.min(x0, r.x); x1 = Math.max(x1, r.x + r.size); }
  if (x1 <= x0) { x0 = 0; x1 = d.w; }
  return (_zoneCache = { stages, x0, x1 });
}
function zonesToggle(on) {
  _zonesEnabled = !!on;
  _zoneCacheFor = null;
  if (typeof buildTileCanvas === 'function') buildTileCanvas();
}

function _zoneStage(Z, tx, ty) {
  const t = (tx - Z.x0) / Math.max(1, Z.x1 - Z.x0);
  const j = (_zh(tx, ty, 7) - 0.5) * 0.14;
  return _ZONE_ST[Z.stages[t + j < 0.55 ? 0 : 1]];
}
function zoneWallColor(Z, tx, ty) { return _zoneStage(Z, tx, ty).wall; }

// Земля и стены — до теней и «обрыва» стен.
function zonesDrawGround(c, Z, tx0, ty0, tx1, ty1) {
  const T = TILE;
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    const st = _zoneStage(Z, tx, ty);
    const x = tx * T, y = ty * T;
    if (dungeon.grid[ty][tx] === FLOOR) st.floor(c, x, y, tx, ty);
    else st.wallTile(c, x, y, tx, ty);
  }
}

// Декор, вуаль и свечение — последним. Декор рисует только своя клетка
// чанка (без кольца соседей), вуаль — на всё полотно.
function zonesDrawDecor(c, Z, tx0, ty0, tx1, ty1, ptx0, pty0, ptx1, pty1, torchList) {
  const T = TILE;
  const glows = [];
  const isFloor = (tx, ty) => tx >= 0 && tx < dungeon.w && ty >= 0 && ty < dungeon.h && dungeon.grid[ty][tx] === FLOOR;
  const ctx = {
    glow: fn => { fn(c); glows.push(fn); },
    torch: (x, y) => torchList.push({ x, y }),
    isFloor,
  };
  for (let ty = pty0; ty <= pty1; ty++) for (let tx = ptx0; tx <= ptx1; tx++) {
    const st = _zoneStage(Z, tx, ty);
    const x = tx * T, y = ty * T;
    if (isFloor(tx, ty)) st.deco(c, x, y, tx, ty, ctx);
    else if (isFloor(tx, ty + 1) && st.wallDeco) st.wallDeco(c, x, y, tx, ty, ctx);
  }
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    c.fillStyle = _zoneStage(Z, tx, ty).overlay;
    c.fillRect(tx * T, ty * T, T, T);
    // Толща стены уходит в темноту: чем дальше от прохода, тем темнее, —
    // иначе кладка стены и пол одного тона, и коридор в ней теряется.
    if (!isFloor(tx, ty)) {
      let d = 3;
      for (let r = 1; r <= 2 && d === 3; r++) {
        for (let oy = -r; oy <= r && d === 3; oy++) for (let ox = -r; ox <= r; ox++) if (isFloor(tx + ox, ty + oy)) { d = r; break; }
      }
      c.fillStyle = `rgba(0,0,0,${[0, 0.3, 0.55, 0.78][d]})`;
      c.fillRect(tx * T, ty * T, T, T);
    }
  }
  for (const fn of glows) fn(c);
}

// ── общие кусочки ────────────────────────────────────────
function _zBricks(c, x, y, tx, ty, base, mortar, bw, bh, amt) {
  c.fillStyle = mortar; c.fillRect(x, y, TILE, TILE);
  for (let r = 0; r * bh < TILE; r++) {
    const off = ((ty * (TILE / bh) + r) & 1) ? bw / 2 : 0;
    for (let k = -1; k * bw < TILE; k++) {
      const bx = x + k * bw + off, by = y + r * bh;
      c.fillStyle = _zVar(base, tx * 7 + k, ty * 5 + r, 11, amt);
      c.fillRect(Math.max(x, bx + 1), by + 1, Math.min(bx + bw - 1, x + TILE) - Math.max(x, bx + 1), bh - 2);
    }
  }
}
function _zBlob(c, x, y, rx, ry, col) { c.fillStyle = col; c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); c.fill(); }
// Трещина: ломаная, которая держит направление и лишь слегка виляет, —
// иначе выходят закорючки, похожие на буквы.
function _zCrack(c, x, y, tx, ty, len, w, col) {
  c.strokeStyle = col; c.lineWidth = w; c.lineCap = 'round'; c.lineJoin = 'round';
  let a = _zh(tx, ty, 29) * Math.PI * 2;
  let px = x - Math.cos(a) * len * 2.5, py = y - Math.sin(a) * len * 2.5;
  c.beginPath(); c.moveTo(px, py);
  for (let i = 0; i < 5; i++) {
    a += (_zh(tx, ty, 30 + i) - 0.5) * 0.9;
    px += Math.cos(a) * len; py += Math.sin(a) * len;
    c.lineTo(px, py);
    if (i === 2 && _zh(tx, ty, 36) < 0.5) {
      const b = a + (_zh(tx, ty, 37) < 0.5 ? 0.9 : -0.9);
      c.moveTo(px, py); c.lineTo(px + Math.cos(b) * len * 1.2, py + Math.sin(b) * len * 1.2); c.moveTo(px, py);
    }
  }
  c.stroke(); c.lineCap = 'butt'; c.lineJoin = 'miter';
}
// Земля без сетки: ровный тон клетки почти не меняется, а пятна светлее и
// темнее лежат поверх и переходят через границы — клетки не читаются.
function _zGround(c, x, y, tx, ty, base) {
  c.fillStyle = _zVar(base, tx, ty, 12, 0.06); c.fillRect(x, y, TILE, TILE);
  for (let k = 0; k < 5; k++) {
    const bx = x + _zh(tx, ty, 40 + k) * TILE, by = y + _zh(tx, ty, 45 + k) * TILE;
    _zBlob(c, bx, by, 6 + _zh(tx, ty, 50 + k) * 9, 4 + _zh(tx, ty, 55 + k) * 6, k & 1 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.12)');
  }
}
function _zRadial(c, x, y, r, col) {
  const g = c.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, col); g.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = g; c.fillRect(x - r, y - r, r * 2, r * 2);
}
function _zTuft(c, x, y, col, n, h) {
  c.strokeStyle = col; c.lineWidth = 2;
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i - (n - 1) / 2) * 0.35;
    c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * h, y + Math.sin(a) * h); c.stroke();
  }
}
function _zFireBowl(c, x, y, ctx, flameCol) {
  _zBlob(c, x + 2, y + 6, 11, 4, 'rgba(0,0,0,0.4)');
  c.fillStyle = '#2a2420'; c.fillRect(x - 2, y - 4, 4, 10);
  c.fillStyle = '#3e3630';
  c.beginPath(); c.moveTo(x - 10, y - 10); c.lineTo(x + 10, y - 10); c.lineTo(x + 6, y - 3); c.lineTo(x - 6, y - 3); c.closePath(); c.fill();
  ctx.glow(g => { _zRadial(g, x, y - 12, 34, flameCol); g.fillStyle = '#ffcf6a'; g.fillRect(x - 6, y - 13, 12, 3); });
  ctx.torch(x, y - 14);
}

// Факел на стене над проходом: кованая скоба, огонь живой (_updateLights).
function _zTorch(c, x, y, ctx) {
  const bx = x + 20, by = y + TILE - 6;
  c.fillStyle = '#2a2018'; c.fillRect(bx - 3, by - 10, 6, 10);
  c.fillStyle = '#4a3826'; c.fillRect(bx - 5, by - 12, 10, 3);
  ctx.torch(bx, by - 12);
}

// ── Темы ─────────────────────────────────────────────────
const _ZONE_ST = {
  // Канализация: мокрый кирпич, лужи, решётки стоков, слизь.
  sewer: {
    wall: '#2b3532', overlay: 'rgba(4,14,12,0.34)',
    floor(c, x, y, tx, ty) { _zBricks(c, x, y, tx, ty, '#3b4642', '#1c2321', 20, 10, 0.22); },
    wallTile(c, x, y, tx, ty) {
      _zBricks(c, x, y, tx, ty, '#2b3532', '#151b19', 26, 13, 0.2);
      if (_zh(tx, ty, 50) < 0.3) { c.fillStyle = 'rgba(70,110,40,0.45)'; c.fillRect(x + _zh(tx, ty, 51) * 30, y + 20, 6, 20); }
    },
    deco(c, x, y, tx, ty, ctx) {
      const h = _zh(tx, ty, 1);
      if (h < 0.1) {
        const px = x + 20, py = y + 22;
        _zBlob(c, px, py, 15, 8, 'rgba(18,40,46,0.85)');
        c.strokeStyle = 'rgba(160,210,220,0.35)'; c.lineWidth = 2;
        c.beginPath(); c.ellipse(px - 3, py - 2, 8, 3, 0, Math.PI, Math.PI * 1.8); c.stroke();
      } else if (h < 0.13) {
        c.fillStyle = '#121615'; c.fillRect(x + 7, y + 11, 26, 18);
        c.fillStyle = '#4a5250'; for (let k = 0; k < 5; k++) c.fillRect(x + 9 + k * 5, y + 13, 2, 14);
        c.fillStyle = 'rgba(80,130,50,0.35)'; c.fillRect(x + 7, y + 25, 26, 4);
      } else if (h < 0.19) {
        _zBlob(c, x + 12 + _zh(tx, ty, 2) * 16, y + 14 + _zh(tx, ty, 3) * 14, 9, 6, 'rgba(110,170,40,0.55)');
        _zBlob(c, x + 16 + _zh(tx, ty, 2) * 10, y + 12 + _zh(tx, ty, 3) * 14, 4, 3, 'rgba(190,240,110,0.5)');
      }
    },
    wallDeco(c, x, y, tx, ty, ctx) {
      if (_zh(tx, ty, 60) < 0.18) {
        c.fillStyle = 'rgba(110,170,40,0.6)';
        const sx = x + 8 + _zh(tx, ty, 61) * 22;
        c.fillRect(sx, y + 22, 5, 18); _zBlob(c, sx + 2.5, y + 40, 5, 3, 'rgba(110,170,40,0.6)');
      }
    },
  },

  // Адский подвал: тёмный камень, трещины с жаром, тлеющие угли, жаровни.
  hellcellar: {
    wall: '#3a1a16', overlay: 'rgba(22,4,2,0.38)',
    floor(c, x, y, tx, ty) {
      _zGround(c, x, y, tx, ty, '#2c1d1a');
      c.fillStyle = 'rgba(10,4,3,0.45)'; c.fillRect(x, y + TILE - 2, TILE, 2); c.fillRect(x + TILE - 2, y, 2, TILE);
    },
    wallTile(c, x, y, tx, ty) { _zBricks(c, x, y, tx, ty, '#3a1a16', '#1a0a08', 26, 13, 0.25); },
    deco(c, x, y, tx, ty, ctx) {
      const h = _zh(tx, ty, 1);
      if (h < 0.1) {
        const cx = x + 20, cy = y + 20;
        _zCrack(c, cx, cy, tx, ty, 6, 5, '#120706');
        ctx.glow(g => { _zCrack(g, cx, cy, tx, ty, 6, 2.2, '#ff7a22'); _zCrack(g, cx, cy, tx, ty, 6, 0.9, '#ffd27a'); });
      } else if (h < 0.3) {
        const ex = x + _zh(tx, ty, 4) * 36, ey = y + _zh(tx, ty, 5) * 36;
        ctx.glow(g => { _zRadial(g, ex, ey, 6, 'rgba(255,120,40,0.7)'); g.fillStyle = '#ffb04a'; g.fillRect(ex - 1, ey - 1, 2, 2); });
      } else if (h < 0.312) _zFireBowl(c, x + 20, y + 26, ctx, 'rgba(255,120,40,0.35)');
    },
  },

  // Болото: грязь, тёмная вода, камыш, кувшинки, блуждающие огни.
  swamp: {
    wall: '#20281a', overlay: 'rgba(6,16,10,0.40)',
    floor(c, x, y, tx, ty) {
      _zGround(c, x, y, tx, ty, '#2e2c1c');
    },
    wallTile(c, x, y, tx, ty) {
      _zGround(c, x, y, tx, ty, '#20281a');
      c.strokeStyle = 'rgba(10,14,6,0.6)'; c.lineWidth = 3;
      c.beginPath(); c.moveTo(x, y + _zh(tx, ty, 52) * TILE); c.quadraticCurveTo(x + 20, y + _zh(tx, ty, 53) * TILE, x + TILE, y + _zh(tx, ty, 54) * TILE); c.stroke();
    },
    deco(c, x, y, tx, ty, ctx) {
      const h = _zh(tx, ty, 1);
      if (h < 0.16) {
        const px = x + 20, py = y + 20;
        _zBlob(c, px, py, 17, 12, '#16302a');
        _zBlob(c, px - 3, py - 2, 11, 7, '#1d3c34');
        if (_zh(tx, ty, 2) < 0.5) { _zBlob(c, px + 6, py + 3, 5, 3.5, '#3e7a32'); c.fillStyle = '#16302a'; c.fillRect(px + 6, py + 1, 4, 2); }
      } else if (h < 0.32) {
        const rx = x + 8 + _zh(tx, ty, 3) * 24, ry = y + 20 + _zh(tx, ty, 4) * 16;
        _zTuft(c, rx, ry, '#4a5e2a', 4, 12);
        c.fillStyle = '#5a3a1e'; c.fillRect(rx - 1, ry - 15, 3, 6);
      } else if (h < 0.34) {
        const wx = x + 20, wy = y + 16;
        ctx.glow(g => { _zRadial(g, wx, wy, 22, 'rgba(140,255,170,0.35)'); _zRadial(g, wx, wy, 5, 'rgba(220,255,220,0.9)'); });
      }
    },
  },

  // Лагерь орков: утоптанная земля, настилы, кости, костры, частокол с черепами.
  orccamp: {
    wall: '#3a2a1c', overlay: 'rgba(16,8,2,0.30)',
    floor(c, x, y, tx, ty) {
      _zGround(c, x, y, tx, ty, '#4a3a28');
      c.fillStyle = 'rgba(30,20,10,0.25)';
      for (let k = 0; k < 4; k++) c.fillRect(x + _zh(tx, ty, 13 + k) * 34, y + _zh(tx, ty, 17 + k) * 34, 4, 3);
    },
    wallTile(c, x, y, tx, ty) {
      // частокол: брёвна стоймя
      c.fillStyle = '#20160e'; c.fillRect(x, y, TILE, TILE);
      for (let k = 0; k < 4; k++) {
        c.fillStyle = _zVar('#4a3422', tx * 4 + k, ty, 14, 0.3);
        c.fillRect(x + k * 10 + 1, y, 8, TILE);
        c.fillStyle = 'rgba(0,0,0,0.25)'; c.fillRect(x + k * 10 + 7, y, 2, TILE);
      }
    },
    deco(c, x, y, tx, ty, ctx) {
      const h = _zh(tx, ty, 1);
      if (h < 0.07) {
        c.fillStyle = '#6a4c2e';
        for (let k = 0; k < 3; k++) { c.fillRect(x + 4, y + 8 + k * 9, 32, 7); c.fillStyle = k & 1 ? '#6a4c2e' : '#5c4026'; }
        c.fillStyle = 'rgba(0,0,0,0.3)'; c.fillRect(x + 4, y + 14, 32, 2); c.fillRect(x + 4, y + 23, 32, 2);
      } else if (h < 0.12) {
        c.fillStyle = '#d8ccb0'; c.save(); c.translate(x + 20, y + 20); c.rotate(_zh(tx, ty, 2) * 3);
        c.fillRect(-9, -1.5, 18, 3); _zBlob(c, -9, 0, 3, 3, '#d8ccb0'); _zBlob(c, 9, 0, 3, 3, '#d8ccb0'); c.restore();
      } else if (h < 0.125) {
        const fx = x + 20, fy = y + 24;
        for (let k = 0; k < 7; k++) { const a = k / 7 * Math.PI * 2; _zBlob(c, fx + Math.cos(a) * 12, fy + Math.sin(a) * 7, 4, 3, '#5a5650'); }
        c.fillStyle = '#3a2416'; c.fillRect(fx - 10, fy - 2, 20, 4); c.fillRect(fx - 2, fy - 7, 4, 12);
        ctx.glow(g => { _zRadial(g, fx, fy - 4, 40, 'rgba(255,140,50,0.35)'); _zRadial(g, fx, fy - 2, 8, 'rgba(255,210,120,0.9)'); });
        ctx.torch(fx, fy - 6);
      }
    },
    wallDeco(c, x, y, tx, ty, ctx) {
      // острия кольев над тропой и черепа на некоторых
      c.fillStyle = '#5a4030';
      for (let k = 0; k < 4; k++) { c.beginPath(); c.moveTo(x + k * 10 + 1, y + 10); c.lineTo(x + k * 10 + 5, y); c.lineTo(x + k * 10 + 9, y + 10); c.closePath(); c.fill(); }
      if (_zh(tx, ty, 62) < 0.15) {
        const sx = x + 20, sy = y + 16;
        _zBlob(c, sx, sy, 7, 6, '#ddd2b4'); c.fillRect(sx - 4, sy + 3, 8, 5);
        c.fillStyle = '#1a1208'; c.fillRect(sx - 4, sy - 1, 3, 3); c.fillRect(sx + 1, sy - 1, 3, 3);
      }
    },
  },

  // Заросший склеп: крупные плиты, корни и лозы, мох, редкие цветы.
  crypt: {
    wall: '#363a34', overlay: 'rgba(6,12,8,0.34)',
    floor(c, x, y, tx, ty) {
      c.fillStyle = '#1c1e1a'; c.fillRect(x, y, TILE, TILE);
      c.fillStyle = _zVar('#4a4c46', tx, ty, 12, 0.22); c.fillRect(x + 2, y + 2, TILE - 4, TILE - 4);
      if (_zh(tx, ty, 9) < 0.25) _zCrack(c, x + 20, y + 20, tx, ty, 7, 2, '#26282a');
      if (_zh(tx, ty, 8) < 0.3) _zBlob(c, x + _zh(tx, ty, 6) * 40, y + _zh(tx, ty, 7) * 40, 9, 6, 'rgba(60,90,40,0.5)');
    },
    wallTile(c, x, y, tx, ty) { _zBricks(c, x, y, tx, ty, '#363a34', '#191b18', 26, 13, 0.2); },
    deco(c, x, y, tx, ty, ctx) {
      const h = _zh(tx, ty, 1);
      if (h < 0.26) {
        c.strokeStyle = h < 0.13 ? '#3e6a2a' : '#4a3424'; c.lineWidth = h < 0.13 ? 3 : 4; c.lineCap = 'round';
        const sx = x + _zh(tx, ty, 2) * 10, sy = y + 5 + _zh(tx, ty, 3) * 30;
        c.beginPath(); c.moveTo(sx, sy);
        c.bezierCurveTo(x + 14, sy - 14 + _zh(tx, ty, 4) * 28, x + 26, sy - 14 + _zh(tx, ty, 5) * 28, x + 38, y + 5 + _zh(tx, ty, 6) * 30); c.stroke();
        c.lineCap = 'butt';
        if (h < 0.13) for (let k = 0; k < 3; k++) _zBlob(c, x + 10 + k * 9, sy - 4 + k * 3, 3.5, 2.2, '#5a8c3a');
      } else if (h < 0.3) {
        const fx = x + 10 + _zh(tx, ty, 2) * 20, fy = y + 10 + _zh(tx, ty, 3) * 20;
        c.fillStyle = _zh(tx, ty, 4) < 0.5 ? '#c8b0e0' : '#e8e0a0';
        for (let k = 0; k < 4; k++) _zBlob(c, fx + Math.cos(k * 1.57) * 3, fy + Math.sin(k * 1.57) * 3, 2.5, 2.5, c.fillStyle);
      }
    },
    wallDeco(c, x, y, tx, ty, ctx) {
      if (_zh(tx, ty, 63) < 0.3) {
        c.strokeStyle = '#3e6a2a'; c.lineWidth = 3;
        const sx = x + 6 + _zh(tx, ty, 64) * 28;
        c.beginPath(); c.moveTo(sx, y + 14); c.quadraticCurveTo(sx + 6, y + 28, sx - 2, y + 40); c.stroke();
        _zBlob(c, sx + 3, y + 26, 3.5, 2.5, '#5a8c3a'); _zBlob(c, sx - 1, y + 36, 3.5, 2.5, '#5a8c3a');
      }
    },
  },

  // Вампирская гробница: шахматный мрамор, кровь, свечи, гробы, багровые окна.
  vampire: {
    wall: '#26161e', overlay: 'rgba(18,0,10,0.42)',
    floor(c, x, y, tx, ty) {
      const dark = ((tx + ty) & 1) === 0;
      c.fillStyle = dark ? _zVar('#1a1418', tx, ty, 12, 0.2) : _zVar('#3e1622', tx, ty, 12, 0.2);
      c.fillRect(x, y, TILE, TILE);
      c.fillStyle = 'rgba(255,255,255,0.05)'; c.fillRect(x + 3, y + 3, TILE - 6, 5);
      c.strokeStyle = 'rgba(255,255,255,0.06)'; c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(x + _zh(tx, ty, 2) * 40, y); c.quadraticCurveTo(x + 20, y + 20, x + _zh(tx, ty, 3) * 40, y + 40); c.stroke();
    },
    wallTile(c, x, y, tx, ty) { _zBricks(c, x, y, tx, ty, '#26161e', '#0e070b', 26, 13, 0.22); },
    deco(c, x, y, tx, ty, ctx) {
      const h = _zh(tx, ty, 1);
      if (h < 0.05) {
        const cx = x + 10 + _zh(tx, ty, 2) * 20, cy = y + 16 + _zh(tx, ty, 3) * 16;
        _zBlob(c, cx + 1, cy + 3, 6, 2.5, 'rgba(0,0,0,0.4)');
        c.fillStyle = '#e8dcc8'; c.fillRect(cx - 2.5, cy - 10, 5, 12);
        c.fillStyle = '#c03040'; c.fillRect(cx - 2.5, cy - 10, 5, 3);
        ctx.glow(g => { _zRadial(g, cx, cy - 13, 22, 'rgba(255,90,60,0.35)'); _zRadial(g, cx, cy - 13, 4, 'rgba(255,220,150,0.95)'); });
      } else if (h < 0.1) {
        _zBlob(c, x + 14 + _zh(tx, ty, 2) * 12, y + 14 + _zh(tx, ty, 3) * 12, 10, 6, 'rgba(120,8,20,0.7)');
        _zBlob(c, x + 26, y + 26, 3, 2, 'rgba(120,8,20,0.7)');
      } else if (h < 0.108) {
        // гроб
        c.save(); c.translate(x + 20, y + 20); c.rotate(_zh(tx, ty, 4) < 0.5 ? 0 : Math.PI / 2);
        c.fillStyle = 'rgba(0,0,0,0.4)'; c.beginPath(); c.moveTo(-6, -16); c.lineTo(8, -16); c.lineTo(11, -6); c.lineTo(7, 18); c.lineTo(-5, 18); c.lineTo(-9, -6); c.closePath(); c.fill();
        c.fillStyle = '#3a2016'; c.beginPath(); c.moveTo(-7, -18); c.lineTo(7, -18); c.lineTo(10, -8); c.lineTo(6, 16); c.lineTo(-6, 16); c.lineTo(-10, -8); c.closePath(); c.fill();
        c.fillStyle = '#c9a452'; c.fillRect(-1, -10, 2, 14); c.fillRect(-5, -6, 10, 2);
        c.restore();
      }
    },
    wallDeco(c, x, y, tx, ty, ctx) {
      if (_zh(tx, ty, 65) < 0.14) {
        const wx = x + 20, wy = y + 14;
        c.fillStyle = '#0a0508'; c.beginPath(); c.moveTo(wx - 7, wy + 22); c.lineTo(wx - 7, wy + 4); c.lineTo(wx, wy - 6); c.lineTo(wx + 7, wy + 4); c.lineTo(wx + 7, wy + 22); c.closePath(); c.fill();
        ctx.glow(g => {
          _zRadial(g, wx, wy + 8, 22, 'rgba(220,30,60,0.3)');
          g.fillStyle = '#b8102a'; g.beginPath(); g.moveTo(wx - 5, wy + 20); g.lineTo(wx - 5, wy + 5); g.lineTo(wx, wy - 3); g.lineTo(wx + 5, wy + 5); g.lineTo(wx + 5, wy + 20); g.closePath(); g.fill();
          g.fillStyle = '#0a0508'; g.fillRect(wx - 0.75, wy - 2, 1.5, 22); g.fillRect(wx - 5, wy + 9, 10, 1.5);
        });
      }
    },
  },

  // Мёртвый лес: пепельная земля, опавшие листья, корни, пни.
  deadwood: {
    wall: '#26221c', overlay: 'rgba(10,10,6,0.34)',
    floor(c, x, y, tx, ty) {
      _zGround(c, x, y, tx, ty, '#3a352c');
      const n = Math.floor(_zh(tx, ty, 19) * 5);
      const leaves = ['#8a4a1e', '#a0622a', '#6a3a1a', '#7a6a2a'];
      for (let k = 0; k < n; k++) {
        c.fillStyle = leaves[Math.floor(_zh(tx, ty, 20 + k) * 4)];
        c.save(); c.translate(x + _zh(tx, ty, 25 + k) * 36 + 2, y + _zh(tx, ty, 30 + k) * 36 + 2); c.rotate(_zh(tx, ty, 35 + k) * 3);
        c.beginPath(); c.ellipse(0, 0, 4, 2, 0, 0, Math.PI * 2); c.fill(); c.restore();
      }
    },
    wallTile(c, x, y, tx, ty) {
      _zGround(c, x, y, tx, ty, '#221e18');
      c.strokeStyle = 'rgba(0,0,0,0.35)'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(x + _zh(tx, ty, 55) * TILE, y); c.quadraticCurveTo(x + 20, y + 20, x + _zh(tx, ty, 56) * TILE, y + TILE); c.stroke();
    },
    deco(c, x, y, tx, ty, ctx) {
      const h = _zh(tx, ty, 1);
      if (h < 0.12) {
        c.strokeStyle = '#4a3a2a'; c.lineWidth = 4; c.lineCap = 'round';
        c.beginPath(); c.moveTo(x + 2, y + 10 + _zh(tx, ty, 2) * 20); c.bezierCurveTo(x + 14, y + _zh(tx, ty, 3) * 40, x + 26, y + _zh(tx, ty, 4) * 40, x + 38, y + 10 + _zh(tx, ty, 5) * 20); c.stroke();
        c.lineCap = 'butt';
      } else if (h < 0.14 && typeof drawProp === 'function') drawProp(c, 'stump', x + 20, y + 34);
      else if (h < 0.16 && typeof drawProp === 'function') drawProp(c, _zh(tx, ty, 6) < 0.5 ? 'branch1' : 'branch2', x + 20, y + 30);
      else if (h < 0.175) {
        const mx = x + 20, my = y + 20;
        ctx.glow(g => { _zRadial(g, mx, my, 16, 'rgba(180,140,255,0.3)'); _zBlob(g, mx, my, 2, 2, '#e8dcff'); });
      }
    },
  },

  // Преисподняя: обсидиан, лавовые трещины и озерца, огненные чаши.
  inferno: {
    wall: '#2a1210', overlay: 'rgba(26,4,0,0.36)',
    floor(c, x, y, tx, ty) {
      _zGround(c, x, y, tx, ty, '#1c1416');
      if (_zh(tx, ty, 9) < 0.3) _zBlob(c, x + _zh(tx, ty, 10) * 40, y + _zh(tx, ty, 11) * 40, 7, 3, 'rgba(140,120,170,0.10)');
    },
    wallTile(c, x, y, tx, ty) {
      _zGround(c, x, y, tx, ty, '#2a1210');
    },
    deco(c, x, y, tx, ty, ctx) {
      const h = _zh(tx, ty, 1);
      if (h < 0.16) {
        const cx = x + 20, cy = y + 20;
        _zCrack(c, cx, cy, tx, ty, 7, 6, '#0a0506');
        ctx.glow(g => { _zCrack(g, cx, cy, tx, ty, 7, 3, '#ff5a10'); _zCrack(g, cx, cy, tx, ty, 7, 1.2, '#ffd060'); });
      } else if (h < 0.19) {
        const px = x + 20, py = y + 20;
        _zBlob(c, px, py, 17, 11, '#120808');
        ctx.glow(g => {
          _zRadial(g, px, py, 34, 'rgba(255,90,20,0.35)');
          const lg = g.createRadialGradient(px - 3, py - 2, 1, px, py, 12);
          lg.addColorStop(0, '#ffe07a'); lg.addColorStop(0.5, '#ff7a1a'); lg.addColorStop(1, '#a01e06');
          g.fillStyle = lg; g.beginPath(); g.ellipse(px, py, 15, 9.5, 0, 0, Math.PI * 2); g.fill();
        });
      } else if (h < 0.2) _zFireBowl(c, x + 20, y + 26, ctx, 'rgba(255,90,30,0.4)');
    },
    wallDeco(c, x, y, tx, ty, ctx) {
      if (_zh(tx, ty, 66) < 0.25) {
        const sx = x + 6 + _zh(tx, ty, 67) * 28;
        ctx.glow(g => { g.strokeStyle = '#ff6a1a'; g.lineWidth = 2; g.beginPath(); g.moveTo(sx, y + 14); g.lineTo(sx + 4, y + 26); g.lineTo(sx - 2, y + 38); g.stroke(); });
      }
    },
  },

  // ── Семейство «кирпичных подземелий» (в стиле канализации) ─────────────

  // Орочьи катакомбы: тёплый бурый кирпич, кости, кровь, ржавые решётки,
  // цепи и факелы на стенах.
  orcvault: {
    wall: '#33271c', overlay: 'rgba(14,8,2,0.30)',
    floor(c, x, y, tx, ty) { _zBricks(c, x, y, tx, ty, '#4a3c2e', '#1e160f', 20, 10, 0.24); },
    wallTile(c, x, y, tx, ty) { _zBricks(c, x, y, tx, ty, '#33271c', '#140e09', 26, 13, 0.22); },
    deco(c, x, y, tx, ty, ctx) {
      const h = _zh(tx, ty, 1);
      if (h < 0.07) {
        _zBlob(c, x + 20, y + 22, 14, 8, 'rgba(70,8,8,0.75)');
        _zBlob(c, x + 16, y + 20, 7, 4, 'rgba(110,14,14,0.6)');
      } else if (h < 0.1) {
        c.fillStyle = '#100b08'; c.fillRect(x + 7, y + 11, 26, 18);
        c.fillStyle = '#6a4a30'; for (let k = 0; k < 5; k++) c.fillRect(x + 9 + k * 5, y + 13, 2, 14);
        c.fillStyle = 'rgba(150,80,30,0.35)'; c.fillRect(x + 7, y + 11, 26, 3);
      } else if (h < 0.17) {
        c.fillStyle = '#d8ccb0'; c.save(); c.translate(x + 20, y + 20); c.rotate(_zh(tx, ty, 2) * 3);
        c.fillRect(-8, -1.5, 16, 3); _zBlob(c, -8, 0, 2.6, 2.6, '#d8ccb0'); _zBlob(c, 8, 0, 2.6, 2.6, '#d8ccb0'); c.restore();
      } else if (h < 0.185) {
        const sx = x + 20, sy = y + 20;
        _zBlob(c, sx, sy, 7, 6, '#ddd2b4'); c.fillStyle = '#ddd2b4'; c.fillRect(sx - 4, sy + 3, 8, 5);
        c.fillStyle = '#1a1208'; c.fillRect(sx - 4, sy - 1, 3, 3); c.fillRect(sx + 1, sy - 1, 3, 3);
      }
    },
    wallDeco(c, x, y, tx, ty, ctx) {
      const h = _zh(tx, ty, 60);
      if (h < 0.12) {
        // цепь
        c.fillStyle = '#5a5650';
        const cx = x + 10 + _zh(tx, ty, 61) * 20;
        for (let k = 0; k < 4; k++) { c.fillRect(cx - 2, y + 14 + k * 7, 4, 5); c.fillStyle = k & 1 ? '#5a5650' : '#46423c'; }
      } else if (h < 0.18) _zTorch(c, x, y, ctx);
    },
  },

  // Склеп: серо-лиловый кирпич, свечи, паутина, кости, светящиеся руны.
  ossuary: {
    wall: '#2c2834', overlay: 'rgba(10,4,16,0.34)',
    floor(c, x, y, tx, ty) { _zBricks(c, x, y, tx, ty, '#3e3a48', '#17141c', 20, 10, 0.2); },
    wallTile(c, x, y, tx, ty) { _zBricks(c, x, y, tx, ty, '#2c2834', '#110e15', 26, 13, 0.2); },
    deco(c, x, y, tx, ty, ctx) {
      const h = _zh(tx, ty, 1);
      if (h < 0.05) {
        const cx = x + 10 + _zh(tx, ty, 2) * 20, cy = y + 16 + _zh(tx, ty, 3) * 16;
        _zBlob(c, cx + 1, cy + 3, 6, 2.5, 'rgba(0,0,0,0.4)');
        c.fillStyle = '#e8dcc8'; c.fillRect(cx - 2.5, cy - 10, 5, 12);
        ctx.glow(g => { _zRadial(g, cx, cy - 13, 22, 'rgba(255,170,90,0.32)'); _zRadial(g, cx, cy - 13, 4, 'rgba(255,230,160,0.95)'); });
      } else if (h < 0.09) {
        // паутина в углу клетки
        c.strokeStyle = 'rgba(220,220,230,0.35)'; c.lineWidth = 1;
        const ox = x + 2, oy = y + 2;
        for (let k = 0; k < 4; k++) { const a = k / 3 * Math.PI / 2; c.beginPath(); c.moveTo(ox, oy); c.lineTo(ox + Math.cos(a) * 22, oy + Math.sin(a) * 22); c.stroke(); }
        for (let r = 7; r <= 21; r += 7) { c.beginPath(); c.arc(ox, oy, r, 0, Math.PI / 2); c.stroke(); }
      } else if (h < 0.15) {
        c.fillStyle = '#cfc6b4'; c.save(); c.translate(x + 20, y + 20); c.rotate(_zh(tx, ty, 2) * 3);
        c.fillRect(-8, -1.5, 16, 3); _zBlob(c, -8, 0, 2.6, 2.6, '#cfc6b4'); _zBlob(c, 8, 0, 2.6, 2.6, '#cfc6b4'); c.restore();
      } else if (h < 0.18) {
        const px = x + 20, py = y + 22;
        _zBlob(c, px, py, 13, 7, 'rgba(40,24,60,0.8)');
        ctx.glow(g => { _zRadial(g, px, py, 20, 'rgba(170,110,255,0.22)'); });
      }
    },
    wallDeco(c, x, y, tx, ty, ctx) {
      const h = _zh(tx, ty, 60);
      if (h < 0.12) {
        const rx = x + 20, ry = y + 26;
        ctx.glow(g => {
          _zRadial(g, rx, ry, 18, 'rgba(170,110,255,0.3)');
          g.strokeStyle = '#c8a0ff'; g.lineWidth = 2;
          g.beginPath(); g.moveTo(rx, ry - 8); g.lineTo(rx, ry + 8); g.moveTo(rx - 5, ry - 3); g.lineTo(rx + 5, ry + 3); g.moveTo(rx + 5, ry - 3); g.lineTo(rx - 5, ry + 3); g.stroke();
        });
      } else if (h < 0.17) _zTorch(c, x, y, ctx);
    },
  },

  // Огненные катакомбы: чёрно-багровый кирпич, жар в швах, решётки над
  // лавой, угли.
  emberhall: {
    wall: '#2c1a16', overlay: 'rgba(20,4,0,0.32)',
    floor(c, x, y, tx, ty) { _zBricks(c, x, y, tx, ty, '#3a2622', '#110605', 20, 10, 0.22); },
    wallTile(c, x, y, tx, ty) { _zBricks(c, x, y, tx, ty, '#2c1a16', '#0e0605', 26, 13, 0.22); },
    deco(c, x, y, tx, ty, ctx) {
      const h = _zh(tx, ty, 1);
      if (h < 0.12) {
        // раскалённый шов между кирпичами
        const row = Math.floor(_zh(tx, ty, 2) * 4), sy = y + row * 10 + 9;
        const x0 = x + Math.floor(_zh(tx, ty, 3) * 2) * 10, len = 10 + Math.floor(_zh(tx, ty, 4) * 3) * 10;
        ctx.glow(g => {
          _zRadial(g, x0 + len / 2, sy, 16, 'rgba(255,90,20,0.28)');
          g.fillStyle = '#ff6a1a'; g.fillRect(x0, sy - 1, len, 2.5);
          g.fillStyle = '#ffd27a'; g.fillRect(x0 + 2, sy - 0.5, len - 4, 1);
        });
      } else if (h < 0.15) {
        c.fillStyle = '#0c0504'; c.fillRect(x + 7, y + 11, 26, 18);
        ctx.glow(g => {
          const lg = g.createLinearGradient(0, y + 11, 0, y + 29);
          lg.addColorStop(0, '#ff8a2a'); lg.addColorStop(1, '#a01e06');
          g.fillStyle = lg; g.fillRect(x + 8, y + 12, 24, 16);
          _zRadial(g, x + 20, y + 20, 30, 'rgba(255,100,30,0.3)');
          g.fillStyle = '#2a1a16'; for (let k = 0; k < 5; k++) g.fillRect(x + 9 + k * 5, y + 13, 2, 14);
        });
      } else if (h < 0.2) {
        const ex = x + _zh(tx, ty, 5) * 36, ey = y + _zh(tx, ty, 6) * 36;
        ctx.glow(g => { _zRadial(g, ex, ey, 6, 'rgba(255,120,40,0.7)'); g.fillStyle = '#ffb04a'; g.fillRect(ex - 1, ey - 1, 2, 2); });
      } else if (h < 0.24) {
        c.fillStyle = '#4a3a34'; c.save(); c.translate(x + 20, y + 20); c.rotate(_zh(tx, ty, 2) * 3);
        c.fillRect(-8, -1.5, 16, 3); c.restore();
      }
    },
    wallDeco(c, x, y, tx, ty, ctx) {
      const h = _zh(tx, ty, 60);
      if (h < 0.2) {
        const row = 1 + Math.floor(_zh(tx, ty, 61) * 2), sy = y + row * 13 + 12;
        ctx.glow(g => { g.fillStyle = '#ff5a14'; g.fillRect(x + 4, sy, TILE - 8, 2); });
      } else if (h < 0.26) _zTorch(c, x, y, ctx);
    },
  },

  // Ледяные катакомбы (Фарм-зона): промёрзший кирпич, наледь, иней,
  // сосульки на стенах, холодный голубой свет.
  frostvault: {
    wall: '#2a3440', overlay: 'rgba(4,10,24,0.32)',
    floor(c, x, y, tx, ty) { _zBricks(c, x, y, tx, ty, '#46525e', '#1a2028', 20, 10, 0.2); },
    wallTile(c, x, y, tx, ty) {
      _zBricks(c, x, y, tx, ty, '#2a3440', '#11161d', 26, 13, 0.2);
      if (_zh(tx, ty, 50) < 0.25) { c.fillStyle = 'rgba(200,230,255,0.18)'; c.fillRect(x, y + 13 * Math.floor(_zh(tx, ty, 51) * 3), TILE, 3); }
    },
    deco(c, x, y, tx, ty, ctx) {
      const h = _zh(tx, ty, 1);
      if (h < 0.1) {
        // наледь
        const px = x + 20, py = y + 21;
        _zBlob(c, px, py, 16, 9, 'rgba(170,215,240,0.45)');
        _zBlob(c, px - 4, py - 2, 8, 3, 'rgba(240,250,255,0.5)');
      } else if (h < 0.2) {
        // иней по кирпичам
        c.fillStyle = 'rgba(230,245,255,0.35)';
        for (let k = 0; k < 6; k++) c.fillRect(x + _zh(tx, ty, 10 + k) * 36, y + _zh(tx, ty, 20 + k) * 36, 3, 2);
      } else if (h < 0.23) {
        const cx = x + 20, cy = y + 20;
        ctx.glow(g => {
          _zRadial(g, cx, cy, 22, 'rgba(120,200,255,0.3)');
          g.fillStyle = '#bfe8ff';
          g.beginPath(); g.moveTo(cx, cy - 9); g.lineTo(cx + 5, cy); g.lineTo(cx, cy + 9); g.lineTo(cx - 5, cy); g.closePath(); g.fill();
        });
      } else if (h < 0.27) {
        c.fillStyle = '#c8d4dc'; c.save(); c.translate(x + 20, y + 20); c.rotate(_zh(tx, ty, 2) * 3);
        c.fillRect(-8, -1.5, 16, 3); _zBlob(c, -8, 0, 2.6, 2.6, '#c8d4dc'); _zBlob(c, 8, 0, 2.6, 2.6, '#c8d4dc'); c.restore();
      }
    },
    wallDeco(c, x, y, tx, ty, ctx) {
      // сосульки по нижнему краю стены
      if (_zh(tx, ty, 60) < 0.45) {
        c.fillStyle = 'rgba(200,235,255,0.75)';
        for (let k = 0; k < 4; k++) {
          const ix = x + 4 + k * 9 + _zh(tx, ty, 61 + k) * 4, il = 6 + _zh(tx, ty, 65 + k) * 10;
          c.beginPath(); c.moveTo(ix - 2.5, y + 26); c.lineTo(ix + 2.5, y + 26); c.lineTo(ix, y + 26 + il); c.closePath(); c.fill();
        }
      } else if (_zh(tx, ty, 60) < 0.5) _zTorch(c, x, y, ctx);
    },
  },

  // Кристальные шахты (Фарм зона 2): тёмный сине-зелёный кирпич, кристаллы
  // разных цветов, рельсы вагонеток, фонари на стенах.
  crystalmine: {
    wall: '#1e2a2c', overlay: 'rgba(2,12,14,0.34)',
    floor(c, x, y, tx, ty) { _zBricks(c, x, y, tx, ty, '#34403f', '#121817', 20, 10, 0.22); },
    wallTile(c, x, y, tx, ty) { _zBricks(c, x, y, tx, ty, '#1e2a2c', '#0b1011', 26, 13, 0.22); },
    deco(c, x, y, tx, ty, ctx) {
      const h = _zh(tx, ty, 1);
      if (h < 0.09) {
        const cx = x + 12 + _zh(tx, ty, 2) * 16, cy = y + 26;
        const cols = [['#5ae0d0', 'rgba(90,224,208,0.35)'], ['#b07aff', 'rgba(176,122,255,0.35)'], ['#6ab8ff', 'rgba(106,184,255,0.35)']];
        const [col, glow] = cols[Math.floor(_zh(tx, ty, 3) * 3)];
        _zBlob(c, cx, cy + 2, 10, 3, 'rgba(0,0,0,0.45)');
        ctx.glow(g => {
          _zRadial(g, cx, cy - 8, 26, glow);
          g.fillStyle = col;
          for (let k = -1; k <= 1; k++) {
            const hh = 14 - Math.abs(k) * 4;
            g.beginPath(); g.moveTo(cx + k * 5 - 3, cy); g.lineTo(cx + k * 6, cy - hh); g.lineTo(cx + k * 5 + 3, cy); g.closePath(); g.fill();
          }
          g.fillStyle = 'rgba(255,255,255,0.6)'; g.fillRect(cx - 1, cy - 12, 1.5, 7);
        });
      } else if (h < 0.15) {
        // кусок рельсов
        c.fillStyle = '#3a2a1c'; for (let k = 0; k < 4; k++) c.fillRect(x + 4 + k * 10, y + 12, 5, 18);
        c.fillStyle = '#6a6a70'; c.fillRect(x, y + 15, TILE, 3); c.fillRect(x, y + 25, TILE, 3);
      } else if (h < 0.21) {
        c.fillStyle = '#4a4440';
        for (let k = 0; k < 4; k++) _zBlob(c, x + 10 + _zh(tx, ty, 4 + k) * 20, y + 12 + _zh(tx, ty, 8 + k) * 18, 4 + _zh(tx, ty, 12 + k) * 3, 3, '#4a4440');
      }
    },
    wallDeco(c, x, y, tx, ty, ctx) {
      const h = _zh(tx, ty, 60);
      if (h < 0.08) _zTorch(c, x, y, ctx);
      else if (h < 0.22) {
        const cx = x + 12 + _zh(tx, ty, 61) * 16, cy = y + 34;
        ctx.glow(g => {
          _zRadial(g, cx, cy - 6, 18, 'rgba(90,224,208,0.3)');
          g.fillStyle = '#5ae0d0';
          g.beginPath(); g.moveTo(cx - 4, cy); g.lineTo(cx, cy - 14); g.lineTo(cx + 4, cy); g.closePath(); g.fill();
        });
      }
    },
  },

  // Сокровищница (Элитная фарм-зона): чёрно-бурый кирпич с золотыми
  // прожилками, россыпи монет, золотые урны, золотые знамёна на стенах.
  goldvault: {
    wall: '#261e14', overlay: 'rgba(14,8,0,0.30)',
    floor(c, x, y, tx, ty) {
      _zBricks(c, x, y, tx, ty, '#3a3024', '#14100a', 20, 10, 0.22);
      if (_zh(tx, ty, 9) < 0.15) { c.fillStyle = 'rgba(220,180,80,0.35)'; c.fillRect(x, y + 10 * Math.floor(_zh(tx, ty, 8) * 4) + 9, TILE, 1.5); }
    },
    wallTile(c, x, y, tx, ty) { _zBricks(c, x, y, tx, ty, '#261e14', '#0d0a06', 26, 13, 0.22); },
    deco(c, x, y, tx, ty, ctx) {
      const h = _zh(tx, ty, 1);
      if (h < 0.1) {
        const n = 3 + Math.floor(_zh(tx, ty, 2) * 5);
        const pts = [];
        for (let k = 0; k < n; k++) pts.push([x + 8 + _zh(tx, ty, 10 + k) * 24, y + 10 + _zh(tx, ty, 20 + k) * 22]);
        ctx.glow(g => {
          _zRadial(g, x + 20, y + 22, 18, 'rgba(255,200,80,0.18)');
          for (const [px, py] of pts) { _zBlob(g, px, py, 3.2, 2.4, '#e8b840'); _zBlob(g, px - 0.8, py - 0.6, 1.4, 1, '#fff0b0'); }
        });
      } else if (h < 0.12) {
        // золотая урна
        const ux = x + 20, uy = y + 30;
        _zBlob(c, ux + 2, uy + 2, 9, 3, 'rgba(0,0,0,0.45)');
        ctx.glow(g => {
          const ug = g.createLinearGradient(ux - 8, 0, ux + 8, 0);
          ug.addColorStop(0, '#8a6420'); ug.addColorStop(0.5, '#f0cc60'); ug.addColorStop(1, '#8a6420');
          g.fillStyle = ug;
          g.beginPath(); g.ellipse(ux, uy - 9, 8, 9, 0, 0, Math.PI * 2); g.fill();
          g.fillRect(ux - 4, uy - 22, 8, 6); g.fillRect(ux - 6, uy - 1, 12, 3);
        });
      } else if (h < 0.17) {
        c.fillStyle = '#5a3a20'; c.fillRect(x + 10, y + 14, 20, 14);
        c.fillStyle = '#c9a452'; c.fillRect(x + 10, y + 18, 20, 2); c.fillRect(x + 18, y + 20, 4, 5);
      }
    },
    wallDeco(c, x, y, tx, ty, ctx) {
      const h = _zh(tx, ty, 60);
      if (h < 0.1) {
        const bx = x + 20, by = y + 12;
        c.fillStyle = '#2a2018'; c.fillRect(bx - 10, by - 2, 20, 3);
        c.fillStyle = '#6a1a20';
        c.beginPath(); c.moveTo(bx - 8, by); c.lineTo(bx + 8, by); c.lineTo(bx + 8, by + 24); c.lineTo(bx, by + 19); c.lineTo(bx - 8, by + 24); c.closePath(); c.fill();
        ctx.glow(g => { g.fillStyle = '#e8b840'; g.beginPath(); g.moveTo(bx, by + 5); g.lineTo(bx + 4, by + 10); g.lineTo(bx, by + 15); g.lineTo(bx - 4, by + 10); g.closePath(); g.fill(); });
      } else if (h < 0.17) _zTorch(c, x, y, ctx);
    },
  },
};
