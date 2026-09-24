// ─────────────────────────────────────────────────────────
//  LOCATION THEMES — indices 1-4 match the open world's 4 corridor arms
//  (index = armIndexForLevel, see shared/definitions.js) and their rotating
//  monster cast: Крыса→Слизень→Бес (arm1), Зомби→Ящер→Орк (arm2),
//  Лоза→Вампир→Бехолдер (arm3), Древень→Демон (arm4) — see FLOOR_ENEMIES'
//  `bands`. The live world itself renders with a single theme
//  (getTheme(dungeonLvl), dungeonLvl is fixed at 1).
//  buildTileCanvas() in game.js handles all drawing.
// ─────────────────────────────────────────────────────────

// ── Floor props (painted sprites, not procedural shapes) ──────────────────
// Source: a hand-painted top-down dungeon prop pack. Each entry's `w` is the
// world-px display width; height follows the source image's own aspect
// ratio so nothing looks squashed.
const PROP_DEF = {
  barrel_small:    { src: 'images/props/barrel_small.png',    w: 20 },
  barrel_large:    { src: 'images/props/barrel_large.png',    w: 28 },
  barrel_slime:    { src: 'images/props/barrel_slime.png',    w: 24 },
  crate_stack:     { src: 'images/props/crate_stack.png',     w: 26 },
  crate_single:    { src: 'images/props/crate_single.png',    w: 22 },
  chest_round:     { src: 'images/props/chest_round.png',     w: 26 },
  chest_banded:    { src: 'images/props/chest_banded.png',    w: 24 },
  treasure_small:  { src: 'images/props/treasure_small.png',  w: 30 },
  treasure_medium: { src: 'images/props/treasure_medium.png', w: 40 },
  treasure_large:  { src: 'images/props/treasure_large.png',  w: 46 },
  treasure_trophy: { src: 'images/props/treasure_trophy.png', w: 36 },
  trophy:          { src: 'images/props/trophy.png',          w: 18 },
  gem_red:         { src: 'images/props/gem_red.png',         w: 8  },
  gem_gold:        { src: 'images/props/gem_gold.png',        w: 8  },
  gem_blue:        { src: 'images/props/gem_blue.png',        w: 8  },
  gem_green:       { src: 'images/props/gem_green.png',       w: 8  },
  gem_purple:      { src: 'images/props/gem_purple.png',      w: 8  },
  slime_small:     { src: 'images/props/slime_small.png',     w: 22 },
  slime_medium:    { src: 'images/props/slime_medium.png',    w: 30 },
  slime_large:     { src: 'images/props/slime_large.png',     w: 38 },
  stump:           { src: 'images/props/stump.png',           w: 20 },
  branch1:         { src: 'images/props/branch1.png',         w: 16 },
  branch2:         { src: 'images/props/branch2.png',         w: 16 },
  signpost:        { src: 'images/props/signpost.png',        w: 22 },
  jug:             { src: 'images/props/jug.png',              w: 14 },
  trap_bear:       { src: 'images/props/trap_bear.png',       w: 20 },
  trap_spike:      { src: 'images/props/trap_spike.png',      w: 18 },
  spikes_row:      { src: 'images/props/spikes_row.png',      w: 34 },
  boulder:         { src: 'images/props/boulder.png',         w: 34 },
  pillar:          { src: 'images/props/pillar.png',          w: 28 },
  vine1:           { src: 'images/props/vine1.png',           w: 24 },
  vine2:           { src: 'images/props/vine2.png',           w: 24 },
  bush1:           { src: 'images/props/bush1.png',           w: 20 },
  bush2:           { src: 'images/props/bush2.png',           w: 18 },
  bone_long:       { src: 'images/props/bone_long.png',       w: 18 },
  bone_small:      { src: 'images/props/bone_small.png',      w: 16 },
  bone_skull:      { src: 'images/props/bone_skull.png',      w: 14 },
  bone_ribcage:    { src: 'images/props/bone_ribcage.png',    w: 28 },
  crystal_purple:  { src: 'images/props/crystal_purple.png',  w: 14 },
  crystal_blue:    { src: 'images/props/crystal_blue.png',    w: 14 },
  crystal_green:   { src: 'images/props/crystal_green.png',   w: 16 },
  rune_stone1:     { src: 'images/props/rune_stone1.png',     w: 18 },
  rune_stone2:     { src: 'images/props/rune_stone2.png',     w: 18 },
  mushroom_spotted:{ src: 'images/props/mushroom_spotted.png',w: 18 },
  spore_sac:       { src: 'images/props/spore_sac.png',       w: 22 },
};

// Start loading immediately (script parse time) — small, low-priority
// images, no reason to gate the character-select loading screen on them.
const _propImg = {};
Object.keys(PROP_DEF).forEach(key => {
  const img = new Image();
  img.src = PROP_DEF[key].src;
  _propImg[key] = img;
});

// Draws prop `key` with its ground-contact point at (x, groundY).
function drawProp(c, key, x, groundY) {
  const def = PROP_DEF[key];
  const img = _propImg[key];
  if (!def || !img || !img.complete || !img.naturalWidth) return;
  const w = def.w;
  const h = w * (img.naturalHeight / img.naturalWidth);
  c.drawImage(img, x - w / 2, groundY - h, w, h);
}

// Builds a drawFloorProp(c,px,py,h) for a theme from a short prop list —
// h % entries.length picks (at most) one entry per floor tile, so overall
// density is 1-in-N where N = the modulus, not the list length.
function _floorProps(mod, entries) {
  return function (c, px, py, h) {
    const idx = h % mod;
    if (idx >= entries.length) return;
    const e = entries[idx];
    drawProp(c, e.key, px + (e.dx ?? TILE / 2), py + (e.dy ?? TILE - 4));
  };
}

// ── Themes ────────────────────────────────────────────────
const THEMES = [

  // Floor 1 — Костяной склеп (skeletons)
  {
    name: '💀 Костяной склеп', bg: '#0a0c10', mmFloor: '#6a7488',
    wallColor: '#3a4550', floorA: '#262c34', floorB: '#2d333c',
    drawFloorProp: _floorProps(120, [{ key: 'bone_long' }, { key: 'bone_small' }, { key: 'bone_skull' }, { key: 'bone_ribcage' }, { key: 'spikes_row' }]),
  },

  // Floor 2 — Логово гоблинов (goblins). Colors match Floor 1 (the hub) —
  // same bg/wallColor/floorA/floorB/mmFloor — while keeping its own name and
  // floor props, so it still reads as a distinct zone, just recolored.
  {
    name: '🏹 Логово гоблинов', bg: '#0a0c10', mmFloor: '#6a7488',
    wallColor: '#3a4550', floorA: '#262c34', floorB: '#2d333c',
    drawFloorProp: _floorProps(120, [{ key: 'stump' }, { key: 'branch1' }, { key: 'branch2' }, { key: 'bush1' }, { key: 'crate_single' }, { key: 'barrel_small' }]),
  },

  // Floor 3 — Грибные пещеры (mushrooms)
  {
    name: '🍄 Грибные пещеры', bg: '#0a0814', mmFloor: '#6a4d8a',
    wallColor: '#3d3a5a', floorA: '#241f38', floorB: '#2b2542',
    drawFloorProp: _floorProps(120, [{ key: 'slime_small' }, { key: 'slime_medium' }, { key: 'mushroom_spotted' }, { key: 'spore_sac' }, { key: 'barrel_slime' }]),
  },

  // Floor 4 — Обитель призраков (ghosts)
  {
    name: '👻 Обитель призраков', bg: '#0a0c16', mmFloor: '#7a7ab0',
    wallColor: '#4a4568', floorA: '#2c2c48', floorB: '#333356',
    drawFloorProp: _floorProps(120, [{ key: 'rune_stone1' }, { key: 'rune_stone2' }, { key: 'crystal_purple' }, { key: 'treasure_medium' }]),
  },

  // Floor 5 — Крепость големов (golems)
  {
    name: '🗿 Крепость големов', bg: '#120c08', mmFloor: '#b07840',
    wallColor: '#6b4a35', floorA: '#3c2c20', floorB: '#453427',
    drawFloorProp: _floorProps(120, [{ key: 'boulder' }, { key: 'crate_single' }, { key: 'treasure_large' }, { key: 'pillar' }, { key: 'rune_stone1' }, { key: 'crystal_blue' }]),
  },
];

function getTheme(lvl) {
  return THEMES[Math.max(0, Math.min(lvl - 1, THEMES.length - 1))];
}

// ── Страх: лавовый пол (раньше был на базе, отсюда имена _hub*) ──────────────────────────────────────────────────────
// Вместо плиток с тёмными швами зал Страха выложен сплошной бесшовной
// текстурой: тёмный базальт, в части трещин светится лава, часть остыла —
// чтобы пол не пестрил и игроки с монстрами читались поверх него. Стены —
// кладка в тон. Рисуется кодом один раз (при первом чанке Страха) и кэшируется:
// скачивать нечего, на любом телефоне выглядит одинаково. Паттерн мира не
// зависит от холста чанка — _buildChunk сдвигает контекст на мировые
// координаты, поэтому соседние чанки стыкуются без шва.
const _HUB_LAVA_WALL = '#3a1d14';
let _hubLavaCache = null;
function _hubLavaTex() {
  if (_hubLavaCache) return _hubLavaCache;
  const S = 480; // 12 клеток по 40 — повтор на глаз не ловится
  let seed = 37;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  function noise(freq) {
    const g = []; for (let i = 0; i < freq * freq; i++) g.push(rnd());
    return (x, y) => {
      const fx = x / S * freq, fy = y / S * freq, x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const at = (a, b) => g[((b % freq + freq) % freq) * freq + ((a % freq + freq) % freq)];
      const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
      const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
      return a + (b - a) * sy;
    };
  }
  const n1 = noise(4), n2 = noise(16), n3 = noise(48);
  const fbm = (x, y) => n1(x, y) * 0.5 + n2(x, y) * 0.32 + n3(x, y) * 0.18;
  const clamp = v => v < 0 ? 0 : v > 255 ? 255 : v;

  // Пол: ячейки Вороного на торе (бесшовно), трещины между ними.
  const fl = document.createElement('canvas'); fl.width = fl.height = S;
  const fc = fl.getContext('2d'), fim = fc.createImageData(S, S), fd = fim.data;
  // 55 камней на текстуру (размер как у первого варианта; 26 крупных
  // смотрелись плитами), центры не ближе 44px друг к другу с учётом
  // повтора: слипшиеся центры давали пучки тонких трещин «солнышком».
  const pts = [];
  for (let tries = 0; pts.length < 55 && tries < 8000; tries++) {
    const x = rnd() * S, y = rnd() * S;
    let ok = true;
    for (const q of pts) {
      let dx = x - q[0], dy = y - q[1];
      dx -= Math.round(dx / S) * S; dy -= Math.round(dy / S) * S;
      if (dx * dx + dy * dy < 44 * 44) { ok = false; break; }
    }
    if (ok) pts.push([x, y, rnd()]);
  }
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let d1 = 1e9, d2 = 1e9, id = 0, ddx = 0, ddy = 0;
    for (let i = 0; i < pts.length; i++) {
      let dx = x - pts[i][0], dy = y - pts[i][1];
      dx -= Math.round(dx / S) * S; dy -= Math.round(dy / S) * S;
      const dd = dx * dx + dy * dy;
      if (dd < d1) { d2 = d1; d1 = dd; id = i; ddx = dx; ddy = dy; } else if (dd < d2) d2 = dd;
    }
    const edge = Math.sqrt(d2) - Math.sqrt(d1);
    // Накал трещины — плавный (без порога): резкая граница «горячо/остыло»
    // резала камни прямыми линиями. Светится меньшая часть трещин.
    const v = fbm(x, y), hz = Math.max(0, Math.min(1, (n1(x + 5, y + 9) - 0.52) / 0.18));
    const gapW = 1.8 + n2(x, y) * 1.2;
    let r, g, b;
    if (edge < gapW) {
      const hot = hz * (1 - edge / gapW) * 0.85;
      r = 230 * hot + 30 * (1 - hot); g = (50 + 70 * (1 - edge / gapW)) * hot + 20 * (1 - hot); b = 15 * hot + 18 * (1 - hot);
    } else {
      const len = Math.sqrt(d1) + 0.01;
      const bev = Math.max(-0.25, Math.min(0.25, (-ddx - ddy) / (len * 6)));
      const edgeDark = Math.min(1, (edge - gapW) / 6);
      const k = (0.72 + pts[id][2] * 0.38) * (0.82 + v * 0.35) * (0.7 + 0.3 * edgeDark) + bev * edgeDark;
      const heat = hz * Math.max(0, 1 - (edge - gapW) / 7);
      r = 50 * k + 45 * heat; g = 36 * k + 10 * heat; b = 33 * k;
    }
    const i4 = (y * S + x) * 4;
    fd[i4] = clamp(r); fd[i4 + 1] = clamp(g); fd[i4 + 2] = clamp(b); fd[i4 + 3] = 255;
  }
  fc.putImageData(fim, 0, 0);

  // Стены: кладка со сдвигом рядов, тон на кирпич, шум по поверхности.
  const wl = document.createElement('canvas'); wl.width = wl.height = S;
  const wc = wl.getContext('2d'), wim = wc.createImageData(S, S), wd = wim.data;
  const pal = [66, 34, 26], bh = 20, bw = 40;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const row = Math.floor(y / bh), off = (row % 2) * bw / 2, col = Math.floor((x + off) / bw);
    const lx = (x + off) % bw, ly = y % bh;
    const shade = ((((row * 73856093) ^ (col * 19349663)) >>> 0) % 100) / 100;
    let k = 0.75 + shade * 0.3 + (fbm(x, y) - 0.5) * 0.35;
    if (ly < 2 || lx < 2) k = 0.42; else if (ly < 4) k += 0.12; else if (ly > bh - 3) k -= 0.15;
    const i4 = (y * S + x) * 4;
    wd[i4] = clamp(pal[0] * k); wd[i4 + 1] = clamp(pal[1] * k); wd[i4 + 2] = clamp(pal[2] * k); wd[i4 + 3] = 255;
  }
  wc.putImageData(wim, 0, 0);

  const pc = document.createElement('canvas').getContext('2d');
  _hubLavaCache = { floor: pc.createPattern(fl, 'repeat'), wall: pc.createPattern(wl, 'repeat') };
  return _hubLavaCache;
}
