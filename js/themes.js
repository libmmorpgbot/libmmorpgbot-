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

// Стены: кладка со сдвигом рядов, тон на кирпич, шум по поверхности. pal —
// базовый цвет кирпича; паттерн один на цвет, кэшируется.
const _brickWallCache = {};
function _brickWallPattern(pal) {
  const key = pal.join(',');
  if (_brickWallCache[key]) return _brickWallCache[key];
  const S = 480;
  let seed = 41;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const g = []; for (let i = 0; i < 256; i++) g.push(rnd());
  const n = (x, y) => {
    const fx = x / S * 16, fy = y / S * 16, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const at = (a, b) => g[(b & 15) * 16 + (a & 15)];
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx, b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
    return a + (b - a) * ty;
  };
  const clamp = v => v < 0 ? 0 : v > 255 ? 255 : v;
  const wl = document.createElement('canvas'); wl.width = wl.height = S;
  const wc = wl.getContext('2d'), wim = wc.createImageData(S, S), wd = wim.data;
  const bh = 20, bw = 40;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const row = Math.floor(y / bh), off = (row % 2) * bw / 2, col = Math.floor((x + off) / bw);
    const lx = (x + off) % bw, ly = y % bh;
    const shade = ((((row * 73856093) ^ (col * 19349663)) >>> 0) % 100) / 100;
    let k = 0.75 + shade * 0.3 + (n(x, y) - 0.5) * 0.35;
    if (ly < 2 || lx < 2) k = 0.42; else if (ly < 4) k += 0.12; else if (ly > bh - 3) k -= 0.15;
    const i4 = (y * S + x) * 4;
    wd[i4] = clamp(pal[0] * k); wd[i4 + 1] = clamp(pal[1] * k); wd[i4 + 2] = clamp(pal[2] * k); wd[i4 + 3] = 255;
  }
  wc.putImageData(wim, 0, 0);
  return (_brickWallCache[key] = wc.createPattern(wl, 'repeat'));
}
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

  const pc = document.createElement('canvas').getContext('2d');
  _hubLavaCache = { floor: pc.createPattern(fl, 'repeat'), wall: _brickWallPattern([66, 34, 26]) };
  return _hubLavaCache;
}

// ── Пол из готовых текстур ────────────────────────────────────────────────────
// База — плитка храма, фарм-зоны — раскалённая лава. Фото-материалы
// ambientCG (Tiles093, Lava002; CC0 — можно без указания автора), ужаты до
// 512px и затемнены под палитру игры заранее: ctx.filter на старых iOS нет.
// Картинка грузится при первом чанке такого этажа; пока её нет — обычные
// плитки темы, а когда пришла, кэш чанков сбрасывается и пол перерисовывается.
// Не загрузилась — так и остаются плитки темы, ничего не ломается.
//
// px — сколько мировых пикселей занимает один повтор текстуры (клетка — 40):
// подобрано на глаз по размеру персонажа. brick — цвет кирпичной кладки стен
// в тон полу (_brickWallPattern), wallBase — цвет их кромки над полом.
// wall/wallPx — вместо кладки из кода стены тоже картинкой.
//
// Коридоры прокачки (dun1..dun60 — с какого уровня открываются) — у каждого
// свой пол и свои стены, тоже ambientCG CC0, запечены так же (512px, объём
// из карты AO, затемнение и тон заранее):
//   dun1  PavingStones138 / Bricks075B  — булыжник с мхом, замшелая кладка
//   dun20 Ground085 / Planks037A        — каменистая земля, частокол из досок
//   dun40 Tiles140 / Bricks066          — тёмные плиты склепа, каменные блоки
//   dun60 Lava001 / Rock035             — корка с лавовыми прожилками, чёрная порода
const _FLOOR_IMG = {
  temple: { src: '/images/floor/temple_tiles.jpg', px: 420, wallBase: '#38342f', brick: [60, 56, 52] },
  lava:   { src: '/images/floor/lava.jpg',         px: 420, wallBase: '#3a1d14', brick: [66, 34, 26] },
  dun1:   { src: '/images/floor/dun1_floor.jpg',  px: 320, wall: '/images/floor/dun1_wall.jpg',  wallPx: 280, wallBase: '#2a2f28' },
  dun20:  { src: '/images/floor/dun20_floor.jpg', px: 360, wall: '/images/floor/dun20_wall.jpg', wallPx: 240, wallBase: '#3a2a1c' },
  dun40:  { src: '/images/floor/dun40_floor.jpg', px: 300, wall: '/images/floor/dun40_wall.jpg', wallPx: 280, wallBase: '#2a2028' },
  dun60:  { src: '/images/floor/dun60_floor.jpg', px: 400, wall: '/images/floor/dun60_wall.jpg', wallPx: 320, wallBase: '#2a1612' },
  // Фентези-набор: светлее и ярче; стены — кроны и скалы, а не кладка.
  //   fan1  Grass004 / Moss002             — зелёная долина, стены — кусты и кроны
  //   fan20 ScatteredLeaves009 / Moss002   — осенний лес, кроны в рыжем тоне
  //   fan40 PavingStones150 / Rock063      — эльфийские руины, замшелые скалы
  //   fan60 Ice003 / Rock026               — ледяное царство, снежные скалы
  fan1:   { src: '/images/floor/fan1_floor.jpg',  px: 300, wall: '/images/floor/fan1_wall.jpg',  wallPx: 220, wallBase: '#2c4220' },
  fan20:  { src: '/images/floor/fan20_floor.jpg', px: 300, wall: '/images/floor/fan20_wall.jpg', wallPx: 220, wallBase: '#5a3214' },
  fan40:  { src: '/images/floor/fan40_floor.jpg', px: 340, wall: '/images/floor/fan40_wall.jpg', wallPx: 300, wallBase: '#3a4430' },
  fan60:  { src: '/images/floor/fan60_floor.jpg', px: 360, wall: '/images/floor/fan60_wall.jpg', wallPx: 300, wallBase: '#56677a' },
  // Подземелье (зал телепортов и 7 классовых зон) — готический склеп в духе
  // Diablo Immortal: треснувшие плиты в комнатах, плитняк в проходах, грубая
  // замковая кладка. ambientCG CC0: Tiles130 / PavingStones054 / Bricks076A,
  // запечены с AO и светом из карты нормалей, холодный тон (см. LICENSE.txt).
  abyss:  { src: '/images/floor/abyss_floor.jpg', px: 380, src2: '/images/floor/abyss_floor2.jpg', px2: 300,
            wall: '/images/floor/abyss_wall.jpg', wallPx: 240, wallBase: '#15171c', abyss: true },
  // Арена турнира — колизей: утоптанный песок, кольцо брусчатки у барьера,
  // трибуны из песчаника. ambientCG CC0: Ground054 / PavingStones131 /
  // Bricks083, запечены с AO, тёплый тон (см. LICENSE.txt). Рисует её
  // _arenaDraw ниже — по кругу, а не по клеткам.
  arena:  { src: '/images/floor/arena_sand.jpg', px: 360, src2: '/images/floor/arena_stone.jpg', px2: 200,
            wall: '/images/floor/arena_wall.jpg', wallPx: 260, wallBase: '#3a2e22', arena: true },
};
const _floorImgCache = {};
function _floorImgTex(key) {
  const def = _FLOOR_IMG[key];
  if (!def || typeof Image === 'undefined') return null;
  const hit = _floorImgCache[key];
  if (hit) return hit.tex;
  const ent = _floorImgCache[key] = { tex: null };
  // Пол и (если есть) стены грузятся параллельно; текстура готова, когда
  // пришло всё, — иначе чанки успели бы запечься с полом, но без стен.
  const pattern = (img, px) => {
    const cv = document.createElement('canvas'); cv.width = cv.height = px;
    const c = cv.getContext('2d');
    if (!c) return null;
    c.imageSmoothingQuality = 'high';
    c.drawImage(img, 0, 0, px, px);
    return c.createPattern(cv, 'repeat');
  };
  const load = src => new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = src; });
  Promise.all([load(def.src), def.wall ? load(def.wall) : null, def.src2 ? load(def.src2) : null]).then(([fl, wl, f2]) => {
    const floor = pattern(fl, def.px);
    const wall = wl ? pattern(wl, def.wallPx || def.px) : _brickWallPattern(def.brick);
    if (!floor || !wall) return;
    // relief — стены коридоров рисуются с высотой: видимая грань над
    // полом и толща, темнеющая вглубь (_buildChunk, js/game.js).
    ent.tex = { floor, wall, wallBase: def.wallBase, relief: !!def.wall,
      floor2: f2 ? pattern(f2, def.px2 || def.px) : null, abyss: !!def.abyss, arena: !!def.arena };
    if (typeof buildTileCanvas === 'function' && typeof dungeon !== 'undefined' && dungeon) buildTileCanvas();
  }).catch(() => {});
  return null;
}

// ── Предметы на полу коридоров прокачки ──────────────────────────────────────
// Рисованные спрайты из PROP_DEF, своя подборка на каждый коридор. Плотность
// выше, чем у старых тем (1 на 70 клеток пола против 1 на 120): на фото-полу
// пустые комнаты смотрятся голо.
const _ARM_PROPS = {
  dun1:  _floorProps(70, [{ key: 'barrel_small' }, { key: 'barrel_slime' }, { key: 'slime_small' }, { key: 'crate_single' }, { key: 'bone_small' }, { key: 'jug' }, { key: 'slime_medium' }]),
  dun20: _floorProps(70, [{ key: 'bone_skull' }, { key: 'bone_ribcage' }, { key: 'bone_long' }, { key: 'crate_stack' }, { key: 'barrel_large' }, { key: 'spikes_row' }, { key: 'trap_bear' }, { key: 'stump' }]),
  dun40: _floorProps(70, [{ key: 'bone_skull' }, { key: 'pillar' }, { key: 'crystal_purple' }, { key: 'chest_banded' }, { key: 'bone_small' }, { key: 'bone_long' }, { key: 'bone_ribcage' }]),
  fan1:  _floorProps(60, [{ key: 'bush1' }, { key: 'bush2' }, { key: 'mushroom_spotted' }, { key: 'stump' }, { key: 'branch1' }, { key: 'signpost' }, { key: 'boulder' }]),
  fan20: _floorProps(60, [{ key: 'stump' }, { key: 'branch1' }, { key: 'branch2' }, { key: 'mushroom_spotted' }, { key: 'bush2' }, { key: 'boulder' }]),
  fan40: _floorProps(60, [{ key: 'pillar' }, { key: 'vine1' }, { key: 'vine2' }, { key: 'chest_round' }, { key: 'boulder' }, { key: 'crystal_green' }, { key: 'bush1' }]),
  fan60: _floorProps(60, [{ key: 'crystal_blue' }, { key: 'boulder' }, { key: 'crystal_purple' }, { key: 'chest_banded' }, { key: 'crystal_blue' }]),
  dun60: _floorProps(70, [{ key: 'boulder' }, { key: 'bone_ribcage' }, { key: 'bone_skull' }, { key: 'spikes_row' }, { key: 'trap_spike' }, { key: 'crystal_blue' }, { key: 'crystal_purple' }]),
};
// Какой коридор сейчас загружен: по названию ветки в его комнатах
// (generateArm, server/game/dungeon.js), а не по номеру этажа.
// Два набора: мрачные подземелья и фентези. Какой стоит — _armStyleSet.
const _ARM_DECOR_SETS = {
  dark:    { left: 'dun1', top: 'dun20', bottom: 'dun40', right: 'dun60' },
  fantasy: { left: 'fan1', top: 'fan20', bottom: 'fan40', right: 'fan60' },
};
let _armStyleSet = 'dark';
function armSetStyle(key) {
  if (!_ARM_DECOR_SETS[key]) return;
  _armStyleSet = key;
  if (typeof buildTileCanvas === 'function') buildTileCanvas();
}
function _armDecorKey() {
  // Коридоры, оформленные кодом (js/zones.js), фото-текстуры не берут.
  if (typeof _zonesEnabled !== 'undefined' && _zonesEnabled) return null;
  const d = typeof dungeon !== 'undefined' ? dungeon : null;
  if (!d || !d.corridorGates || !d.rooms) return null;
  const r = d.rooms.find(x => x.arm);
  return (r && _ARM_DECOR_SETS[_armStyleSet][r.arm]) || null;
}


// ── Подземелье в духе Diablo Immortal ────────────────────────────────────────
// Пол и стены — фото-текстуры (abyss в _FLOOR_IMG), поверх них — то, что
// делает склеп склепом: кровь и щебень на плитах, ритуальный круг с рунами в
// центре каждой комнаты, высокие стены с контрфорсами и факелами, жаровни по
// углам комнат. Всё запекается в чанки один раз (_buildChunk, js/game.js);
// живое — пламя и его свет (_updateLights), затемнение краёв экрана
// (_updateAbyssDark, js/pixi-world.js) и искры с туманом (_fxAmbient, js/fx.js).
function _abyssFloor() {
  const d = typeof dungeon !== 'undefined' ? dungeon : null;
  return !!(d && (d.dungeonZone || d.classPads));
}
function _abyssRoomAt(tx, ty) {
  const rs = (typeof dungeon !== 'undefined' && dungeon && dungeon.rooms) || [];
  for (let i = 0; i < rs.length; i++) {
    const r = rs[i], sz = r.size || 0;
    if (tx >= r.x && tx < r.x + sz && ty >= r.y && ty < r.y + sz) return r;
  }
  return null;
}
// Пятна на плитах: кровь, щебень, копоть, светящиеся трещины. Детерминировано
// по клетке — чанк, собранный заново, выглядит так же.
function _abyssFloorDecor(c, tx, ty, x, y, inRoom) {
  const h = (k) => _tileHash(tx, ty, k);
  if (h(40) < (inRoom ? 0.07 : 0.04)) {             // лужа крови из нескольких капель
    const cx = x + TILE * (0.25 + h(41) * 0.5), cy = y + TILE * (0.25 + h(42) * 0.5);
    const n = 3 + Math.floor(h(43) * 4);
    for (let i = 0; i < n; i++) {
      const a = h(44 + i) * 6.28, d = h(50 + i) * 12;
      _drawStain(c, cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.7, 5 + h(56 + i) * 9, 'rgba(92,8,10,0.55)');
    }
    _drawStain(c, cx, cy, 6, 'rgba(40,2,4,0.5)');
  }
  if (h(60) < 0.12) {                               // щебень
    const n = 2 + Math.floor(h(61) * 4);
    for (let i = 0; i < n; i++) {
      const px = x + h(62 + i) * TILE, py = y + h(68 + i) * TILE, s = 2 + h(74 + i) * 3;
      c.fillStyle = 'rgba(0,0,0,0.45)'; c.fillRect(px + 1, py + 1, s, s * 0.8);
      c.fillStyle = h(80 + i) < 0.5 ? '#3a3c42' : '#2c2e33'; c.fillRect(px, py, s, s * 0.8);
    }
  }
  if (h(86) < 0.05) _drawStain(c, x + TILE / 2, y + TILE / 2, 14 + h(87) * 10, 'rgba(0,0,0,0.38)');
  if (h(88) < 0.006) {                              // трещина, тлеющая изнутри
    c.save(); c.shadowColor = '#ff5a1a'; c.shadowBlur = 6;
    _drawCrack(c, x + 8 + h(89) * (TILE - 16), y + 8 + h(90) * (TILE - 16), tx, ty, 'rgba(255,110,40,0.75)', 9);
    c.restore();
  }
}
// Ритуальный круг в центре комнаты: два кольца, пентаграмма, руны по кругу,
// тусклое алое свечение. Рисуется в каждом чанке, который его задевает, —
// холст обрежет лишнее сам.
function _abyssRoomDecor(c, x0, y0, x1, y1) {
  const rs = (typeof dungeon !== 'undefined' && dungeon && dungeon.rooms) || [];
  for (const r of rs) {
    const cx = (r.cx + 0.5) * TILE, cy = (r.cy + 0.5) * TILE;
    const R = Math.min(r.size || 10, 18) * TILE * 0.2;
    if (cx + R < x0 || cx - R > x1 || cy + R < y0 || cy - R > y1) continue;
    c.save();
    const g = c.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.25);
    g.addColorStop(0, 'rgba(120,10,14,0.16)'); g.addColorStop(1, 'rgba(120,10,14,0)');
    c.fillStyle = g; c.beginPath(); c.arc(cx, cy, R * 1.25, 0, 6.283); c.fill();
    c.strokeStyle = 'rgba(10,8,10,0.7)'; c.lineWidth = 7;            // выбитая в камне канавка
    c.beginPath(); c.arc(cx, cy, R, 0, 6.283); c.stroke();
    c.shadowColor = '#ff2a1a'; c.shadowBlur = 7;
    c.strokeStyle = 'rgba(190,28,22,0.45)'; c.lineWidth = 2.5;
    c.beginPath(); c.arc(cx, cy, R, 0, 6.283); c.stroke();
    c.beginPath(); c.arc(cx, cy, R * 0.8, 0, 6.283); c.stroke();
    c.beginPath();
    for (let i = 0; i <= 5; i++) {
      const a = -Math.PI / 2 + i * Math.PI * 4 / 5;
      const px = cx + Math.cos(a) * R * 0.8, py = cy + Math.sin(a) * R * 0.8;
      if (i) c.lineTo(px, py); else c.moveTo(px, py);
    }
    c.stroke();
    c.fillStyle = 'rgba(220,46,30,0.55)';
    for (let i = 0; i < 12; i++) {                   // руны между кольцами
      const a = i / 12 * 6.283, rr = R * 0.9;
      const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr;
      c.save(); c.translate(px, py); c.rotate(a + Math.PI / 2);
      const k = (i * 7) % 4;
      c.fillRect(-1, -5, 2, 10);
      if (k === 0) c.fillRect(-4, -5, 8, 2);
      if (k === 1) { c.fillRect(-4, 0, 8, 2); c.fillRect(2, -5, 2, 5); }
      if (k === 2) { c.fillRect(-4, 3, 8, 2); c.fillRect(-4, -5, 2, 4); }
      if (k === 3) { c.rotate(0.6); c.fillRect(-1, -4, 2, 8); }
      c.restore();
    }
    c.restore();
  }
}
// Передняя грань стены: высокая кладка, затемнённая книзу, контрфорс через
// каждые 4 клетки (на нём факел, _abyssTorches) и светлая кромка по верху.
const ABYSS_WALL_H = 34;
function _abyssWallFace(c, tex, tx, ty) {
  const fx = tx * TILE, fy = ty * TILE + TILE - ABYSS_WALL_H;
  c.fillStyle = tex.wall; c.fillRect(fx, fy, TILE, ABYSS_WALL_H);
  const fg = c.createLinearGradient(0, fy, 0, fy + ABYSS_WALL_H);
  fg.addColorStop(0, 'rgba(0,0,0,0.15)'); fg.addColorStop(1, 'rgba(0,0,0,0.7)');
  c.fillStyle = fg; c.fillRect(fx, fy, TILE, ABYSS_WALL_H);
  if (tx % 4 === 0) {
    const px = fx + 8, pw = TILE - 16;
    const pg = c.createLinearGradient(px, 0, px + pw, 0);
    pg.addColorStop(0, 'rgba(120,125,140,0.22)'); pg.addColorStop(0.5, 'rgba(0,0,0,0)'); pg.addColorStop(1, 'rgba(0,0,0,0.5)');
    c.fillStyle = tex.wall; c.fillRect(px, fy - 6, pw, ABYSS_WALL_H + 8);
    c.fillStyle = pg; c.fillRect(px, fy - 6, pw, ABYSS_WALL_H + 8);
    c.fillStyle = 'rgba(0,0,0,0.55)'; c.fillRect(px + pw, fy, 3, ABYSS_WALL_H);   // тень контрфорса
    c.fillStyle = 'rgba(170,175,190,0.25)'; c.fillRect(px - 2, fy - 8, pw + 4, 3); // капитель
  }
  c.fillStyle = 'rgba(200,205,220,0.14)'; c.fillRect(fx, fy, TILE, 2);
  c.fillStyle = 'rgba(0,0,0,0.5)'; c.fillRect(fx, fy - 2, TILE, 2);
}
// Факелы на контрфорсах и жаровни по углам комнат. Кронштейн и чаша
// запекаются в чанк, огонь и свет — живые (big — жаровня, пятно света шире).
function _abyssTorches(c, ptx0, pty0, ptx1, pty1, isFloor, list) {
  for (let ty = pty0; ty <= pty1; ty++) for (let tx = ptx0; tx <= ptx1; tx++) {
    if (dungeon.grid[ty][tx] !== WALL || !isFloor(tx, ty + 1) || tx % 4 !== 0) continue;
    const bx = tx * TILE + TILE / 2, by = ty * TILE + TILE - 14;
    c.fillStyle = '#1a1612'; c.fillRect(bx - 2, by - 6, 4, 12);
    c.fillStyle = '#3a2c20'; c.fillRect(bx - 6, by - 9, 12, 4);
    c.fillStyle = '#5a4630'; c.fillRect(bx - 6, by - 9, 12, 1);
    list.push({ x: bx, y: by - 9 });
  }
  const rs = dungeon.rooms || [];
  for (const r of rs) {
    const sz = r.size || 0;
    if (!sz) continue;
    for (const [ox, oy] of [[1, 1], [sz - 2, 1], [1, sz - 2], [sz - 2, sz - 2]]) {
      const tx = r.x + ox, ty = r.y + oy;
      if (tx < ptx0 || tx > ptx1 || ty < pty0 || ty > pty1 || !isFloor(tx, ty)) continue;
      const bx = tx * TILE + TILE / 2, by = ty * TILE + TILE / 2 + 6;
      c.fillStyle = 'rgba(0,0,0,0.45)'; c.beginPath(); c.ellipse(bx + 3, by + 8, 16, 6, 0, 0, 6.283); c.fill();
      c.fillStyle = '#16120e';
      c.fillRect(bx - 9, by - 2, 3, 12); c.fillRect(bx + 6, by - 2, 3, 12); c.fillRect(bx - 1, by, 2, 11);
      c.fillStyle = '#2e241a'; c.beginPath(); c.ellipse(bx, by - 4, 13, 6, 0, 0, 6.283); c.fill();
      c.fillStyle = '#4a3a28'; c.beginPath(); c.ellipse(bx, by - 6, 11, 4, 0, 0, 6.283); c.fill();
      c.fillStyle = '#1c0a04'; c.beginPath(); c.ellipse(bx, by - 6, 9, 3, 0, 0, 6.283); c.fill();
      list.push({ x: bx, y: by - 8, big: true });
    }
  }
}
const _ABYSS_PROPS = _floorProps(130, [{ key: 'bone_skull' }, { key: 'bone_ribcage' }, { key: 'bone_long' }, { key: 'bone_small' },
  { key: 'bone_skull' }, { key: 'pillar' }, { key: 'spikes_row' }, { key: 'chest_banded' }]);


// ── Арена турнира: колизей ───────────────────────────────────────────────────
// Ринг круглый (generateTournamentPit, server/game/dungeon.js), поэтому пол
// рисуется не по клеткам, а дугами вокруг центра — поверх всего, что чанк
// успел нарисовать, на весь его холст: песок, кольцо брусчатки, барьер,
// ступени трибун со зрителями, ворота за спинами бойцов, знамёна, жаровни
// (огонь в них живой — точки уходят в torchList, как факелы на стенах), в
// центре — медальон со скрещёнными мечами, на местах бойцов — их круги.
// Всё детерминировано: соседние чанки рисуют стыки одинаково.
const _ARENA_CLOTH = ['#6b2a22', '#2c3e6b', '#4a5a2a', '#6b5a2a', '#3d2a4a', '#55524c', '#7a3a1a', '#2a4a4a'];
const _ARENA_SKIN = ['#c8a07a', '#a87a55', '#e0bc96', '#7a5236'];
const _ARENA_SIDE = ['#c0392b', '#2f6fd6'];          // боец a (слева) / b (справа)
function _arenaDraw(c, tex, ar, X0, Y0, X1, Y1, own, torchList) {
  const T = TILE, TAU = Math.PI * 2;
  const cx = (ar.cx + 0.5) * T, cy = (ar.cy + 0.5) * T;
  const rIn = (ar.r + 0.5) * T;        // край песка — внутренняя грань барьера
  const rRing = rIn - 1.6 * T;         // начало кольца брусчатки
  const rPar = rIn + 0.9 * T;          // внешняя кромка барьера
  const TIER = 0.85 * T;               // ширина ступени трибун
  const near = Math.hypot(Math.max(X0 - cx, 0, cx - X1), Math.max(Y0 - cy, 0, cy - Y1));
  const far = Math.max(Math.hypot(X0 - cx, Y0 - cy), Math.hypot(X1 - cx, Y0 - cy), Math.hypot(X0 - cx, Y1 - cy), Math.hypot(X1 - cx, Y1 - cy));
  const ring = (r0, r1, fill) => {
    if (r1 < near || r0 > far) return;
    c.beginPath(); c.arc(cx, cy, r1, 0, TAU);
    if (r0 > 0) { c.moveTo(cx + r0, cy); c.arc(cx, cy, r0, 0, TAU, true); }
    c.fillStyle = fill; c.fill();
  };
  const radGrad = (r0, r1, stops) => {
    const g = c.createRadialGradient(cx, cy, Math.max(0, r0), cx, cy, r1);
    stops.forEach(([o, col]) => g.addColorStop(o, col));
    return g;
  };
  c.save();
  c.beginPath(); c.rect(X0, Y0, X1 - X0, Y1 - Y0); c.clip();

  // 1. Трибуны — всё, что за барьером. Ступени: тень подступенка и светлая
  // кромка сиденья; к верхним рядам темнее.
  if (far > rIn) {
    c.fillStyle = tex.wall; c.fillRect(X0, Y0, X1 - X0, Y1 - Y0);
    for (let k = 0, r = rPar; r < far + TIER; k++, r += TIER) {
      if (r + TIER < near) continue;
      ring(r, r + 8, 'rgba(0,0,0,0.5)');
      ring(r + 8, r + 10, 'rgba(255,225,180,0.12)');
      // Проходы между секторами — каждые 45°, сдвинутые от ворот.
      if (k > 0) for (let s = 0; s < 8; s++) {
        const a = s * TAU / 8 + TAU / 16;
        c.save(); c.translate(cx, cy); c.rotate(a);
        c.fillStyle = 'rgba(0,0,0,0.28)'; c.fillRect(r, -9, TIER, 18);
        c.fillStyle = 'rgba(255,225,180,0.08)'; c.fillRect(r, -9, TIER, 2);
        c.restore();
      }
      // Зрители. Ряд 0 — проход вдоль барьера, там пусто.
      if (k === 0) continue;
      const rk = r + TIER * 0.55;
      if (rk < near - 12 || rk > far + 12) continue;
      const n = Math.floor(TAU * rk / 15);
      for (let i = 0; i < n; i++) {
        const h = _tileHash(k, i, 77);
        if (h < 0.24) continue;                          // пустое место
        const a = (i + 0.3 * _tileHash(k, i, 79)) / n * TAU;
        if (Math.abs(((a * 8 / TAU) % 1) - 0.5) < 0.06) continue; // проход
        const px = cx + Math.cos(a) * rk, py = cy + Math.sin(a) * rk;
        if (px < X0 - 10 || px > X1 + 10 || py < Y0 - 10 || py > Y1 + 10) continue;
        c.fillStyle = _ARENA_CLOTH[Math.floor(_tileHash(k, i, 78) * _ARENA_CLOTH.length)];
        c.beginPath(); c.ellipse(px, py, 6.5, 4.5, a + Math.PI / 2, 0, TAU); c.fill();
        c.fillStyle = _ARENA_SKIN[Math.floor(_tileHash(k, i, 80) * _ARENA_SKIN.length)];
        c.beginPath(); c.arc(px - Math.cos(a) * 1.5, py - Math.sin(a) * 1.5, 3.3, 0, TAU); c.fill();
        if (h > 0.965) {                                 // флажок болельщика
          const side = Math.cos(a) < 0 ? 0 : 1;
          const fx = px - Math.cos(a) * 4, fy = py - Math.sin(a) * 4;
          c.strokeStyle = '#3a2a1a'; c.lineWidth = 2;
          c.beginPath(); c.moveTo(fx, fy); c.lineTo(fx, fy - 13); c.stroke();
          c.fillStyle = _ARENA_SIDE[side]; c.fillRect(fx, fy - 13, 8, 6);
        }
      }
    }
    ring(rPar, Math.max(far, rPar + 1), radGrad(rPar, rPar + 11 * TIER, [[0, 'rgba(0,0,0,0)'], [1, 'rgba(0,0,0,0.6)']]));

    // 2. Барьер: каменный парапет с кромкой и стыками блоков.
    ring(rIn, rPar, 'rgba(255,232,196,0.10)');
    ring(rPar - 4, rPar, 'rgba(255,240,210,0.22)');
    ring(rPar, rPar + 5, 'rgba(0,0,0,0.45)');
    ring(rIn, rIn + 12, radGrad(rIn, rIn + 12, [[0, 'rgba(0,0,0,0.55)'], [1, 'rgba(0,0,0,0)']]));
    if (rPar > near && rIn < far) {
      c.fillStyle = 'rgba(0,0,0,0.35)';
      const nb = Math.round(TAU * rPar / 46);
      for (let i = 0; i < nb; i++) {
        c.save(); c.translate(cx, cy); c.rotate(i / nb * TAU);
        c.fillRect(rIn, -1, rPar - rIn, 2);
        c.restore();
      }
    }
  }

  // 3. Песок — с выгоревшим светлым центром и следами грабель по кругу.
  if (near < rIn) {
    c.save();
    c.beginPath(); c.arc(cx, cy, rIn, 0, TAU); c.clip();
    c.fillStyle = tex.floor; c.fillRect(X0, Y0, X1 - X0, Y1 - Y0);
    ring(0, rIn, radGrad(0, rIn, [[0, 'rgba(255,224,170,0.16)'], [0.6, 'rgba(255,224,170,0.04)'], [1, 'rgba(0,0,0,0.1)']]));
    c.strokeStyle = 'rgba(60,40,20,0.10)'; c.lineWidth = 3;
    for (let r = 4.6 * T; r < rRing - 10; r += 22 + _tileHash(Math.round(r), 3, 81) * 18) {
      if (r < near - 4 || r > far + 4) continue;
      c.beginPath(); c.arc(cx, cy, r, 0, TAU); c.stroke();
    }
    // Пятна крови и рытвины — по клеткам, как на остальных этажах.
    const tx0 = Math.floor(X0 / T) - 1, tx1 = Math.floor(X1 / T) + 1;
    const ty0 = Math.floor(Y0 / T) - 1, ty1 = Math.floor(Y1 / T) + 1;
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      const x = tx * T, y = ty * T;
      if (Math.hypot(x + T / 2 - cx, y + T / 2 - cy) > rRing - T * 0.6) continue;
      if (_tileHash(tx, ty, 82) < 0.07) {
        const sx = x + T * (0.2 + _tileHash(tx, ty, 83) * 0.6), sy = y + T * (0.2 + _tileHash(tx, ty, 84) * 0.6);
        const nd = 2 + Math.floor(_tileHash(tx, ty, 85) * 3);
        for (let i = 0; i < nd; i++) {
          const a = _tileHash(tx, ty, 86 + i) * TAU, d = _tileHash(tx, ty, 90 + i) * 9;
          _drawStain(c, sx + Math.cos(a) * d, sy + Math.sin(a) * d * 0.7, 4 + _tileHash(tx, ty, 94 + i) * 7, 'rgba(110,14,10,0.45)');
        }
      } else if (_tileHash(tx, ty, 87) < 0.08) {
        _drawStain(c, x + T * (0.3 + _tileHash(tx, ty, 88) * 0.4), y + T * (0.3 + _tileHash(tx, ty, 89) * 0.4), 9 + _tileHash(tx, ty, 98) * 6, 'rgba(50,32,16,0.28)');
      }
    }

    // 4. Кольцо брусчатки у барьера: бордюр со светлой кромкой и тень,
    // которую барьер бросает на камень.
    if (far > rRing) {
      c.save();
      c.beginPath(); c.arc(cx, cy, rIn, 0, TAU); c.moveTo(cx + rRing, cy); c.arc(cx, cy, rRing, 0, TAU, true); c.clip();
      c.fillStyle = tex.floor2 || tex.floor; c.fillRect(X0, Y0, X1 - X0, Y1 - Y0);
      c.restore();
      ring(rRing - 6, rRing, 'rgba(0,0,0,0.4)');
      ring(rRing, rRing + 4, 'rgba(255,236,200,0.22)');
      ring(rIn - 22, rIn, radGrad(rIn - 22, rIn, [[0, 'rgba(0,0,0,0)'], [1, 'rgba(0,0,0,0.5)']]));
    }

    // 5. Центр: медальон из камня с золотым ободом, насечки по кругу и
    // скрещённые мечи.
    // Внешнее кольцо — в долю радиуса арены, чтобы на большом ринге не
    // терялось точкой посреди песка.
    const rEmb = Math.max(3.6, ar.r * 0.3) * T;
    if (near < rEmb + 0.6 * T) {
      const gold = 'rgba(206,160,78,';
      c.strokeStyle = gold + '0.45)'; c.lineWidth = 4;
      c.beginPath(); c.arc(cx, cy, rEmb, 0, TAU); c.stroke();
      c.beginPath(); c.arc(cx, cy, rEmb * 0.55, 0, TAU); c.stroke();
      c.lineWidth = 3;
      const nt = Math.round(rEmb / T * 6.7);
      for (let i = 0; i < nt; i++) {
        const a = i / nt * TAU, r0 = rEmb, r1 = r0 + (i % 3 === 0 ? 18 : 9);
        c.beginPath(); c.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); c.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); c.stroke();
      }
      c.fillStyle = tex.floor2 || tex.floor;
      c.beginPath(); c.arc(cx, cy, 1.7 * T, 0, TAU); c.fill();
      ring(0, 1.7 * T, radGrad(0, 1.7 * T, [[0, 'rgba(0,0,0,0)'], [1, 'rgba(0,0,0,0.35)']]));
      c.strokeStyle = gold + '0.9)'; c.lineWidth = 6;
      c.beginPath(); c.arc(cx, cy, 1.7 * T, 0, TAU); c.stroke();
      c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = 2;
      c.beginPath(); c.arc(cx, cy, 1.7 * T + 4, 0, TAU); c.stroke();
      [-1, 1].forEach(sg => {
        c.save(); c.translate(cx, cy); c.rotate(sg * Math.PI / 4);
        c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillRect(-4 + 3, -44 + 3, 8, 64);
        c.fillStyle = '#c9ccd2'; c.beginPath(); c.moveTo(-4, 18); c.lineTo(-4, -38); c.lineTo(0, -46); c.lineTo(4, -38); c.lineTo(4, 18); c.closePath(); c.fill();
        c.fillStyle = '#8f949c'; c.fillRect(-1, -36, 2, 52);
        c.fillStyle = '#b8913a'; c.fillRect(-13, 18, 26, 5);
        c.fillStyle = '#4a2e1a'; c.fillRect(-3, 23, 6, 13);
        c.fillStyle = '#b8913a'; c.beginPath(); c.arc(0, 38, 4, 0, TAU); c.fill();
        c.restore();
      });
    }

    // 6. Места бойцов — круги в цветах сторон.
    (ar.spawns || []).forEach((sp, i) => {
      const sx = (sp.x + 0.5) * T, sy = (sp.y + 0.5) * T, col = _ARENA_SIDE[i % 2];
      if (sx + T < X0 || sx - T > X1 || sy + T < Y0 || sy - T > Y1) return;
      c.fillStyle = col + '30'; c.beginPath(); c.arc(sx, sy, 0.9 * T, 0, TAU); c.fill();
      c.strokeStyle = col + 'cc'; c.lineWidth = 4; c.beginPath(); c.arc(sx, sy, 0.9 * T, 0, TAU); c.stroke();
      c.lineWidth = 2; c.setLineDash([6, 6]); c.beginPath(); c.arc(sx, sy, 0.6 * T, 0, TAU); c.stroke(); c.setLineDash([]);
    });
    c.restore();
  }

  // 7. Ворота за спинами бойцов, знамёна и жаровни на барьере.
  if (far > rIn - T && near < rPar + 2 * T) {
    [Math.PI, 0].forEach((a, side) => {
      c.save(); c.translate(cx, cy); c.rotate(a);
      const gw = 2.4 * T, gx0 = rIn - 3, gx1 = rPar + 1.4 * T;
      c.fillStyle = '#120c08'; c.fillRect(gx0, -gw / 2, gx1 - gx0, gw);
      c.strokeStyle = '#4c4034'; c.lineWidth = 3;
      for (let y = -gw / 2 + 8; y < gw / 2; y += 10) { c.beginPath(); c.moveTo(gx0, y); c.lineTo(gx1, y); c.stroke(); }
      for (let x = gx0 + 6; x < gx1; x += 14) { c.beginPath(); c.moveTo(x, -gw / 2); c.lineTo(x, gw / 2); c.stroke(); }
      c.fillStyle = '#6e5e4c';
      c.fillRect(gx0 - 6, -gw / 2 - 10, gx1 - gx0 + 6, 10); c.fillRect(gx0 - 6, gw / 2, gx1 - gx0 + 6, 10);
      c.fillStyle = 'rgba(255,236,200,0.25)'; c.fillRect(gx0 - 6, -gw / 2 - 10, gx1 - gx0 + 6, 2);
      c.fillStyle = _ARENA_SIDE[side]; c.fillRect(gx0 - 10, -10, 10, 20);  // герб стороны над воротами
      c.restore();
    });
    // Знамёна свисают с барьера на кольцо: по краям ворот — цвета сторон,
    // на севере и юге — золотые.
    [[Math.PI * 0.75, 0], [Math.PI * 1.25, 0], [Math.PI * 0.25, 1], [Math.PI * 1.75, 1], [Math.PI * 0.5, 2], [Math.PI * 1.5, 2]].forEach(([a, k]) => {
      const col = k < 2 ? (k === 0 ? '#8e1b1b' : '#1b3f8e') : '#8a6418';
      c.save(); c.translate(cx, cy); c.rotate(a);
      const x1 = rIn + 6, x0 = rIn - 1.1 * T, hw = 13;
      c.fillStyle = 'rgba(0,0,0,0.35)'; c.beginPath(); c.moveTo(x1, -hw + 4); c.lineTo(x0 + 18, -hw + 4); c.lineTo(x0 - 2, 4); c.lineTo(x0 + 18, hw + 4); c.lineTo(x1, hw + 4); c.fill();
      c.fillStyle = col; c.beginPath(); c.moveTo(x1, -hw); c.lineTo(x0 + 14, -hw); c.lineTo(x0, 0); c.lineTo(x0 + 14, hw); c.lineTo(x1, hw); c.closePath(); c.fill();
      c.strokeStyle = '#d4a94a'; c.lineWidth = 2; c.stroke();
      c.fillStyle = '#d4a94a'; c.beginPath(); c.arc(x0 + 22, 0, 4, 0, TAU); c.fill();
      c.fillStyle = '#3a2a1a'; c.fillRect(x1 - 2, -hw - 3, 6, hw * 2 + 6);
      c.restore();
    });
    // Жаровни между знамёнами; огонь над ними живой (torchList). Число —
    // по длине барьера: 8 на малом ринге, 16 на большом.
    const rb = (rIn + rPar) / 2;
    const nBr = ar.r >= 18 ? 16 : 8;
    for (let i = 0; i < nBr; i++) {
      const a = i * TAU / nBr + TAU / (nBr * 2);
      const bx = cx + Math.cos(a) * rb, by = cy + Math.sin(a) * rb;
      if (bx < X0 - 60 || bx > X1 + 60 || by < Y0 - 60 || by > Y1 + 60) continue;
      const g = c.createRadialGradient(bx, by, 0, bx, by, 60);
      g.addColorStop(0, 'rgba(255,150,60,0.28)'); g.addColorStop(1, 'rgba(255,150,60,0)');
      c.fillStyle = g; c.beginPath(); c.arc(bx, by, 60, 0, TAU); c.fill();
      c.fillStyle = 'rgba(0,0,0,0.4)'; c.beginPath(); c.arc(bx + 3, by + 4, 12, 0, TAU); c.fill();
      c.fillStyle = '#2a2420'; c.beginPath(); c.arc(bx, by, 12, 0, TAU); c.fill();
      c.strokeStyle = '#6a5848'; c.lineWidth = 3; c.stroke();
      const cg = c.createRadialGradient(bx, by, 0, bx, by, 9);
      cg.addColorStop(0, '#ffd27a'); cg.addColorStop(0.5, '#e8641e'); cg.addColorStop(1, '#5a1a08');
      c.fillStyle = cg; c.beginPath(); c.arc(bx, by, 8, 0, TAU); c.fill();
      if (own && torchList && bx >= own.x0 && bx < own.x1 && by >= own.y0 && by < own.y1) torchList.push({ x: bx, y: by - 4 });
    }
  }
  c.restore();
}
