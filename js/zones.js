// ─────────────────────────────────────────────────────────
//  ОФОРМЛЕНИЕ КОРИДОРОВ ПРОКАЧКИ
// ─────────────────────────────────────────────────────────
// Каждый из четырёх коридоров (generateArm, server/game/dungeon.js) получает
// свою тему под монстров, которые в нём живут, и тема меняется по ходу:
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

let _zonesEnabled = false;

function _zh(a, b, salt) {
  let h = (a * 374761393 + b * 668265263 + salt * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 15), 1274126177);
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 100000) / 100000;
}
function _zShade(hex, t) { return typeof _cityShade === 'function' ? _cityShade(hex, t) : hex; }
function _zVar(hex, tx, ty, salt, amt) { return _zShade(hex, (_zh(tx, ty, salt) - 0.5) * amt); }

const _ZONE_ARMS = {
  left:   ['sewer', 'hellcellar'],
  top:    ['swamp', 'orccamp'],
  bottom: ['crypt', 'vampire'],
  right:  ['deadwood', 'inferno'],
};

let _zoneCache = null, _zoneCacheFor = null;
function _zoneLayout() {
  if (!_zonesEnabled) return null;
  const d = typeof dungeon !== 'undefined' ? dungeon : null;
  if (!d || !d.corridorGates || !d.rooms) return null;
  if (_zoneCacheFor === d) return _zoneCache;
  _zoneCacheFor = d;
  const r0 = d.rooms.find(r => r.arm);
  const stages = r0 && _ZONE_ARMS[r0.arm];
  if (!stages) return (_zoneCache = null);
  let x0 = 1e9, x1 = -1e9;
  for (const r of d.rooms) { x0 = Math.min(x0, r.x); x1 = Math.max(x1, r.x + r.size); }
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
};
