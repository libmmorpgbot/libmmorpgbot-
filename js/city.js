// ─────────────────────────────────────────────────────────
//  ГОРОД — оформление хаба
// ─────────────────────────────────────────────────────────
// Хаб (generateHub, server/game/dungeon.js) — квадратный зал 48×48 клеток,
// обнесённый стеной шириной MARGIN. Геометрию он не меняет: всё ниже —
// только картинка, запекаемая в чанки пола (_buildChunk, js/game.js), чтобы
// зал читался как город:
//
//   • пол — мощёные улицы крестом от площади к четырём воротам, круглая
//     площадь с мозаикой-розой ветров под точкой спавна, четыре сквера
//     между улицами (в двух — фонтаны, в двух — деревья и клумбы);
//   • стена вокруг — ряды домов с черепичными крышами вплотную к улице,
//     за ними крепостная стена с зубцами, угловыми башнями и воротами
//     там, где в неё упирается улица, а за стеной — трава и лес.
//
// Всё, что стоит на проходимом полу (скверы, фонтаны, фонари), плоское или
// маленькое — ходить сквозь это не странно, так же как сквозь бочки и
// ящики на других этажах. Дома, стена и башни стоят только на клетках
// стены, куда игрок не зайдёт.
//
// Рисуется в мировых координатах: каждый чанк рисует целиком всё, что его
// задевает, а холст сам обрезает лишнее — поэтому один и тот же дом в
// соседних чанках совпадает пиксель в пиксель и швов нет. Случайность —
// только детерминированная (_cityHash), чанк, выброшенный из кэша и
// построенный заново, выходит тем же.

const _CITY_ROAD_W  = 4;    // ширина улицы, клеток
const _CITY_PLAZA_R = 6.5;  // радиус площади, клеток
const _CITY_HOUSE_D = 5;    // глубина полосы домов за краем зала, клеток
const _CITY_WALL_W  = 2;    // толщина крепостной стены, клеток

const _CITY_ROOFS = ['#8e3b2c', '#7a4a2a', '#3f5566', '#4e5d3a', '#6e3440', '#855a2e'];
const _CITY_PLASTER = ['#c9b58f', '#b9a27c', '#cfc0a0', '#a89378', '#bfae8e'];

function _cityHash(a, b, salt) {
  let h = (a * 374761393 + b * 668265263 + salt * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 15), 1274126177);
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 100000) / 100000;
}

function _cityShade(hex, t) {
  const n = parseInt(hex.slice(1), 16);
  let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const to = t >= 0 ? 255 : 0, k = Math.abs(t);
  r = Math.round(r + (to - r) * k); g = Math.round(g + (to - g) * k); b = Math.round(b + (to - b) * k);
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

// ── Планировка ───────────────────────────────────────────
// Считается один раз на загруженный этаж: объект dungeon меняется при каждом
// переходе, поэтому кэш держится за него самого.
let _cityCache = null, _cityCacheFor = null;
function _cityLayout() {
  const d = typeof dungeon !== 'undefined' ? dungeon : null;
  if (!d || !d.armEntries || !d.rooms) return null;
  if (typeof dungeonLvl !== 'undefined' && typeof FEAR_FLOOR_ID !== 'undefined' && dungeonLvl === FEAR_FLOOR_ID) return null;
  if (_cityCacheFor === d) return _cityCache;
  _cityCacheFor = d;
  const R = d.rooms.find(r => r.isHub);
  if (!R) return (_cityCache = null);

  const T = TILE;
  const fx0 = R.x * T, fy0 = R.y * T, fx1 = (R.x + R.size) * T, fy1 = (R.y + R.size) * T;
  const cx = (R.cx + 0.5) * T, cy = (R.cy + 0.5) * T;
  const hd = _CITY_HOUSE_D * T, ww = _CITY_WALL_W * T;
  const rw = _CITY_ROAD_W * T;
  const L = {
    fx0, fy0, fx1, fy1, cx, cy,
    // улицы: вертикальная и горизонтальная, через центр
    roadV: { x0: cx - rw / 2, x1: cx + rw / 2 },
    roadH: { y0: cy - rw / 2, y1: cy + rw / 2 },
    plazaR: _CITY_PLAZA_R * T,
    // полоса домов, крепостная стена, дальше — за городом
    bx0: fx0 - hd, by0: fy0 - hd, bx1: fx1 + hd, by1: fy1 + hd,
    wx0: fx0 - hd - ww, wy0: fy0 - hd - ww, wx1: fx1 + hd + ww, wy1: fy1 + hd + ww,
    houses: [], lawns: [], lamps: [], trees: [], fountains: [], gates: [],
  };

  // Проём в ряду домов там, где улица уходит к воротам: сама улица плюс по
  // клетке тротуара с каждой стороны.
  const gapHalf = rw / 2 + T;
  const gv0 = cx - gapHalf, gv1 = cx + gapHalf;   // по X, для северной/южной сторон
  const gh0 = cy - gapHalf, gh1 = cy + gapHalf;   // по Y, для западной/восточной

  // Дома одной стороны: отрезок [a, b) режется на дома шириной 3–5 клеток.
  function run(a, b, salt, place) {
    let p = a, i = 0;
    while (b - p >= 3 * T) {
      let w = (3 + Math.floor(_cityHash(i, salt, 7) * 3)) * T;
      if (b - p - w < 3 * T) w = b - p;     // хвост меньше дома — отдаём его последнему
      place(p, w, i);
      p += w; i++;
    }
  }
  const depth = (i, salt) => (3.4 + _cityHash(i, salt, 3) * 1.4) * T;
  // север: фасадом к улице, прижаты к краю зала снизу
  const N = (p, w, i) => { const h = depth(i, 11); L.houses.push({ x: p, y: fy0 - h, w, h, i, s: 11 }); };
  run(fx0, gv0, 11, N); run(gv1, fx1, 12, (p, w, i) => N(p, w, i + 40));
  // юг: крышей к улице, прижаты к краю зала сверху
  const S = (p, w, i) => { const h = depth(i, 21); L.houses.push({ x: p, y: fy1, w, h, i, s: 21 }); };
  run(fx0, gv0, 21, S); run(gv1, fx1, 22, (p, w, i) => S(p, w, i + 40));
  // запад и восток: дома стоят столбиком, каждый шириной почти во всю полосу
  const Wd = (p, w, i) => { const dw = (3.6 + _cityHash(i, 31, 5) * 1.2) * T; L.houses.push({ x: fx0 - dw, y: p, w: dw, h: w, i, s: 31 }); };
  run(fy0, gh0, 31, Wd); run(gh1, fy1, 32, (p, w, i) => Wd(p, w, i + 40));
  const Ed = (p, w, i) => { const dw = (3.6 + _cityHash(i, 41, 5) * 1.2) * T; L.houses.push({ x: fx1, y: p, w: dw, h: w, i, s: 41 }); };
  run(fy0, gh0, 41, Ed); run(gh1, fy1, 42, (p, w, i) => Ed(p, w, i + 40));
  // угловые участки — по большому дому
  const cd = (_CITY_HOUSE_D - 0.6) * T;
  L.houses.push({ x: fx0 - cd, y: fy0 - cd, w: cd, h: cd, i: 1, s: 51, big: true });
  L.houses.push({ x: fx1,      y: fy0 - cd, w: cd, h: cd, i: 2, s: 51, big: true });
  L.houses.push({ x: fx0 - cd, y: fy1,      w: cd, h: cd, i: 3, s: 51, big: true });
  L.houses.push({ x: fx1,      y: fy1,      w: cd, h: cd, i: 4, s: 51, big: true });
  // Порядок отрисовки — сверху вниз: нижний дом перекрывает крышей фасад
  // верхнего, как и должно быть при взгляде сверху-спереди.
  L.houses.sort((a, b) => (a.y + a.h) - (b.y + b.h));

  L.gates = [
    { dir: 'n', x: cx, y: L.wy0 + ww / 2 }, { dir: 's', x: cx, y: L.wy1 - ww / 2 },
    { dir: 'w', x: L.wx0 + ww / 2, y: cy }, { dir: 'e', x: L.wx1 - ww / 2, y: cy },
  ];

  // Скверы — четыре квартала между улицами, с тротуаром по краю.
  const side = 2 * T;
  const q = [
    { x0: fx0 + side, y0: fy0 + side, x1: L.roadV.x0 - side, y1: L.roadH.y0 - side },
    { x0: L.roadV.x1 + side, y0: fy0 + side, x1: fx1 - side, y1: L.roadH.y0 - side },
    { x0: fx0 + side, y0: L.roadH.y1 + side, x1: L.roadV.x0 - side, y1: fy1 - side },
    { x0: L.roadV.x1 + side, y0: L.roadH.y1 + side, x1: fx1 - side, y1: fy1 - side },
  ];
  q.forEach((r, k) => {
    L.lawns.push(r);
    const mx = (r.x0 + r.x1) / 2, my = (r.y0 + r.y1) / 2;
    // Фонтаны — в северо-западном и юго-восточном, в двух других — рощица.
    if (k === 0 || k === 3) L.fountains.push({ x: mx, y: my, r: 2.6 * T });
    else {
      for (let j = 0; j < 5; j++) {
        const a = j / 5 * Math.PI * 2 + k;
        const rr = (j === 0 ? 0 : 3.2 * T);
        L.trees.push({ x: mx + Math.cos(a) * rr * (j ? 1 : 0), y: my + Math.sin(a) * rr * (j ? 1 : 0), r: (1.1 + _cityHash(j, k, 9) * 0.4) * T, k: j + k * 10 });
      }
    }
    // деревья по углам сквера
    const inset = 1.3 * T;
    [[r.x0 + inset, r.y0 + inset], [r.x1 - inset, r.y0 + inset], [r.x0 + inset, r.y1 - inset], [r.x1 - inset, r.y1 - inset]]
      .forEach(([x, y], j) => L.trees.push({ x, y, r: (0.9 + _cityHash(j, k, 19) * 0.3) * T, k: 100 + j + k * 10 }));
  });

  // Фонари вдоль улиц, по обе стороны, каждые 6 клеток — кроме площади.
  const step = 6 * T;
  for (let p = fy0 + 3 * T; p < fy1 - T; p += step) {
    if (Math.abs(p - cy) < L.plazaR + T) continue;
    L.lamps.push({ x: L.roadV.x0 - T * 0.45, y: p }, { x: L.roadV.x1 + T * 0.45, y: p });
  }
  for (let p = fx0 + 3 * T; p < fx1 - T; p += step) {
    if (Math.abs(p - cx) < L.plazaR + T) continue;
    L.lamps.push({ x: p, y: L.roadH.y0 - T * 0.45 }, { x: p, y: L.roadH.y1 + T * 0.45 });
  }
  // и четыре по диагоналям площади
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + k * Math.PI / 2;
    L.lamps.push({ x: cx + Math.cos(a) * (L.plazaR + T * 0.4), y: cy + Math.sin(a) * (L.plazaR + T * 0.4) });
  }
  // Лавки за NPC — там же, где их ставит initNpcs (js/game.js, _NPC_SPOTS):
  // прилавок сразу за спиной, чтобы NPC стоял перед своей лавкой.
  L.stalls = [];
  if (typeof _NPC_SPOTS !== 'undefined') {
    for (const id of Object.keys(_NPC_SPOTS)) {
      L.stalls.push({ kind: id, x: cx + _NPC_SPOTS[id].dx, y: cy + _NPC_SPOTS[id].dy });
    }
  }
  return (_cityCache = L);
}

function _cityHit(o, x0, y0, x1, y1) {
  return o.x1 > x0 && o.x0 < x1 && o.y1 > y0 && o.y0 < y1;
}

// ── Земля: улицы, площадь, скверы ────────────────────────
// Зовётся после пола, до теней от стен. (x0,y0)-(x1,y1) — мировой
// прямоугольник чанка с запасом; всё, что его не задевает, пропускается.
function cityDrawGround(c, L, x0, y0, x1, y1) {
  const T = TILE;
  // улицы
  const roads = [
    { x0: L.roadV.x0, x1: L.roadV.x1, y0: L.fy0 - (_CITY_HOUSE_D + _CITY_WALL_W) * T, y1: L.fy1 + (_CITY_HOUSE_D + _CITY_WALL_W) * T, v: true },
    { y0: L.roadH.y0, y1: L.roadH.y1, x0: L.fx0 - (_CITY_HOUSE_D + _CITY_WALL_W) * T, x1: L.fx1 + (_CITY_HOUSE_D + _CITY_WALL_W) * T, v: false },
  ];
  for (const r of roads) if (_cityHit(r, x0, y0, x1, y1)) _cityCobbles(c, r, x0, y0, x1, y1);
  for (const r of roads) if (_cityHit(r, x0, y0, x1, y1)) _cityCurbs(c, r, L);

  // площадь
  const pr = L.plazaR + T * 0.6;
  if (_cityHit({ x0: L.cx - pr, y0: L.cy - pr, x1: L.cx + pr, y1: L.cy + pr }, x0, y0, x1, y1)) _cityPlaza(c, L);

  // скверы
  for (const q of L.lawns) if (_cityHit(q, x0, y0, x1, y1)) _cityLawn(c, q, x0, y0, x1, y1);
  for (const f of L.fountains) {
    if (_cityHit({ x0: f.x - f.r - 8, y0: f.y - f.r - 8, x1: f.x + f.r + 8, y1: f.y + f.r + 8 }, x0, y0, x1, y1)) _cityFountain(c, f);
  }
}

function _cityCobbles(c, r, x0, y0, x1, y1) {
  const T = TILE;
  const ax0 = Math.max(r.x0, x0), ay0 = Math.max(r.y0, y0), ax1 = Math.min(r.x1, x1), ay1 = Math.min(r.y1, y1);
  c.fillStyle = '#2f2a26';
  c.fillRect(ax0, ay0, ax1 - ax0, ay1 - ay0);
  // Булыжник: по 3×3 камня на клетку, у каждого свой оттенок и сдвиг.
  const s = T / 3;
  const gx0 = Math.floor(ax0 / s), gy0 = Math.floor(ay0 / s), gx1 = Math.ceil(ax1 / s), gy1 = Math.ceil(ay1 / s);
  c.save();
  c.beginPath(); c.rect(ax0, ay0, ax1 - ax0, ay1 - ay0); c.clip();
  for (let gy = gy0; gy < gy1; gy++) {
    const off = (gy & 1) ? s / 2 : 0;
    for (let gx = gx0 - 1; gx < gx1; gx++) {
      const h = _cityHash(gx, gy, 61);
      const x = gx * s + off + 1.5 + (h - 0.5) * 2, y = gy * s + 1.5 + (_cityHash(gx, gy, 62) - 0.5) * 2;
      const w = s - 3, hh = s - 3;
      const k = 0.78 + h * 0.34;
      const base = [98 * k, 90 * k, 80 * k].map(v => Math.round(v));
      c.fillStyle = `rgb(${base[0]},${base[1]},${base[2]})`;
      _cityRRect(c, x, y, w, hh, 4); c.fill();
      c.fillStyle = 'rgba(255,240,210,0.10)';
      _cityRRect(c, x + 1, y + 1, w - 3, hh * 0.45, 3); c.fill();
      c.fillStyle = 'rgba(0,0,0,0.18)';
      c.fillRect(x + 2, y + hh - 2, w - 3, 2);
    }
  }
  c.restore();
}

function _cityCurbs(c, r, L) {
  // бордюр вдоль улицы — светлая полоса по краю
  c.fillStyle = '#8d8578';
  if (r.v) {
    c.fillRect(r.x0 - 3, r.y0, 5, r.y1 - r.y0);
    c.fillRect(r.x1 - 2, r.y0, 5, r.y1 - r.y0);
  } else {
    c.fillRect(r.x0, r.y0 - 3, r.x1 - r.x0, 5);
    c.fillRect(r.x0, r.y1 - 2, r.x1 - r.x0, 5);
  }
  c.fillStyle = 'rgba(0,0,0,0.25)';
  if (r.v) { c.fillRect(r.x0 + 2, r.y0, 3, r.y1 - r.y0); c.fillRect(r.x1 - 5, r.y0, 3, r.y1 - r.y0); }
  else { c.fillRect(r.x0, r.y0 + 2, r.x1 - r.x0, 3); c.fillRect(r.x0, r.y1 - 5, r.x1 - r.x0, 3); }
}

function _cityPlaza(c, L) {
  const R = L.plazaR, x = L.cx, y = L.cy;
  c.save();
  // бордюр и тень
  c.fillStyle = 'rgba(0,0,0,0.35)';
  c.beginPath(); c.arc(x, y + 3, R + 8, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#8d8578';
  c.beginPath(); c.arc(x, y, R + 7, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#5c554c';
  c.beginPath(); c.arc(x, y, R + 2, 0, Math.PI * 2); c.fill();
  // кольца брусчатки: камни раскладываются по окружностям
  c.beginPath(); c.arc(x, y, R, 0, Math.PI * 2); c.clip();
  c.fillStyle = '#4a443d';
  c.fillRect(x - R, y - R, R * 2, R * 2);
  const ring = 16;
  for (let rr = R - ring / 2, n = 0; rr > 50; rr -= ring, n++) {
    const cnt = Math.max(8, Math.round(2 * Math.PI * rr / 20));
    const off = (n & 1) ? Math.PI / cnt : 0;
    for (let j = 0; j < cnt; j++) {
      const a0 = j / cnt * Math.PI * 2 + off, a1 = (j + 1) / cnt * Math.PI * 2 + off;
      const k = 0.8 + _cityHash(j, n, 71) * 0.3;
      c.fillStyle = `rgb(${Math.round(150 * k)},${Math.round(138 * k)},${Math.round(118 * k)})`;
      c.beginPath();
      c.arc(x, y, rr + ring / 2 - 2, a0 + 0.02, a1 - 0.02);
      c.arc(x, y, rr - ring / 2 + 1, a1 - 0.02, a0 + 0.02, true);
      c.closePath(); c.fill();
    }
  }
  // мозаика в центре — роза ветров
  const mr = 50;
  c.fillStyle = '#2d3d52';
  c.beginPath(); c.arc(x, y, mr, 0, Math.PI * 2); c.fill();
  c.strokeStyle = '#c9a452'; c.lineWidth = 4;
  c.beginPath(); c.arc(x, y, mr - 3, 0, Math.PI * 2); c.stroke();
  c.lineWidth = 2;
  c.beginPath(); c.arc(x, y, mr - 11, 0, Math.PI * 2); c.stroke();
  const star = (n, ro, ri, rot, fillA, fillB) => {
    for (let j = 0; j < n; j++) {
      const a = rot + j / n * Math.PI * 2, da = Math.PI / n;
      c.fillStyle = fillA;
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * ro, y + Math.sin(a) * ro); c.lineTo(x + Math.cos(a + da) * ri, y + Math.sin(a + da) * ri); c.closePath(); c.fill();
      c.fillStyle = fillB;
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * ro, y + Math.sin(a) * ro); c.lineTo(x + Math.cos(a - da) * ri, y + Math.sin(a - da) * ri); c.closePath(); c.fill();
    }
  };
  star(4, mr - 13, 10, Math.PI / 4, '#8a7a55', '#6b5e40');
  star(4, mr - 7, 12, -Math.PI / 2, '#e2c26a', '#b08d3e');
  c.fillStyle = '#e2c26a';
  c.beginPath(); c.arc(x, y, 5, 0, Math.PI * 2); c.fill();
  c.restore();
}

function _cityLawn(c, q, x0, y0, x1, y1) {
  const w = q.x1 - q.x0, h = q.y1 - q.y0;
  // живая изгородь по краю, внутри — трава
  c.fillStyle = 'rgba(0,0,0,0.3)';
  _cityRRect(c, q.x0 - 2, q.y0 + 2, w + 4, h + 4, 18); c.fill();
  c.fillStyle = '#1f3a1d';
  _cityRRect(c, q.x0, q.y0, w, h, 16); c.fill();
  c.fillStyle = '#2e5a28';
  _cityRRect(c, q.x0 + 4, q.y0 + 2, w - 8, h - 8, 14); c.fill();
  const g = c.createLinearGradient(0, q.y0, 0, q.y1);
  g.addColorStop(0, '#3d6e2f'); g.addColorStop(1, '#335f28');
  c.fillStyle = g;
  _cityRRect(c, q.x0 + 10, q.y0 + 10, w - 20, h - 20, 10); c.fill();
  // травинки и цветы — только в клетках, которые задевают чанк
  const T = TILE;
  const tx0 = Math.max(Math.floor((q.x0 + 10) / T), Math.floor(x0 / T)), tx1 = Math.min(Math.ceil((q.x1 - 10) / T), Math.ceil(x1 / T));
  const ty0 = Math.max(Math.floor((q.y0 + 10) / T), Math.floor(y0 / T)), ty1 = Math.min(Math.ceil((q.y1 - 10) / T), Math.ceil(y1 / T));
  c.save();
  _cityRRect(c, q.x0 + 10, q.y0 + 10, w - 20, h - 20, 10); c.clip();
  const flowers = ['#e8d36a', '#e98aa6', '#f2f0e6', '#b48ae8'];
  for (let ty = ty0; ty < ty1; ty++) for (let tx = tx0; tx < tx1; tx++) {
    for (let k = 0; k < 3; k++) {
      const gx = tx * T + _cityHash(tx, ty, 80 + k) * T, gy = ty * T + _cityHash(tx, ty, 83 + k) * T;
      c.strokeStyle = k === 0 ? 'rgba(120,180,90,0.7)' : 'rgba(30,70,25,0.6)';
      c.lineWidth = 2;
      c.beginPath(); c.moveTo(gx, gy); c.lineTo(gx - 2, gy - 5); c.moveTo(gx, gy); c.lineTo(gx + 2, gy - 6); c.stroke();
    }
    if (_cityHash(tx, ty, 90) < 0.22) {
      const fx = tx * T + _cityHash(tx, ty, 91) * T, fy = ty * T + _cityHash(tx, ty, 92) * T;
      c.fillStyle = flowers[Math.floor(_cityHash(tx, ty, 93) * flowers.length)];
      for (let k = 0; k < 3; k++) { c.beginPath(); c.arc(fx + (k - 1) * 4, fy + (k & 1) * 3, 2.2, 0, Math.PI * 2); c.fill(); }
    }
  }
  c.restore();
}

function _cityFountain(c, f) {
  const { x, y, r } = f;
  c.fillStyle = 'rgba(0,0,0,0.35)';
  c.beginPath(); c.ellipse(x + 3, y + 6, r + 4, r + 4, 0, 0, Math.PI * 2); c.fill();
  // плиточная дорожка вокруг
  c.fillStyle = '#8d8578';
  c.beginPath(); c.arc(x, y, r + 14, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#6f685d';
  c.beginPath(); c.arc(x, y, r + 10, 0, Math.PI * 2); c.fill();
  // чаша
  c.fillStyle = '#b8ae9c';
  c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#7d7466';
  c.beginPath(); c.arc(x, y, r - 7, 0, Math.PI * 2); c.fill();
  const wg = c.createRadialGradient(x - r * 0.3, y - r * 0.3, 4, x, y, r - 9);
  wg.addColorStop(0, '#6fc3e8'); wg.addColorStop(0.6, '#2f7fb0'); wg.addColorStop(1, '#1d4e76');
  c.fillStyle = wg;
  c.beginPath(); c.arc(x, y, r - 9, 0, Math.PI * 2); c.fill();
  // блики и круги на воде
  c.strokeStyle = 'rgba(210,240,255,0.45)'; c.lineWidth = 2;
  for (let k = 1; k <= 3; k++) { c.beginPath(); c.arc(x, y, 14 + k * 13, -0.9 + k * 0.4, 0.4 + k * 0.4); c.stroke(); }
  // центральная колонна с верхней чашей
  c.fillStyle = '#9a917f';
  c.beginPath(); c.arc(x, y, 18, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#c9bfab';
  c.beginPath(); c.arc(x, y - 2, 14, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#5fb4de';
  c.beginPath(); c.arc(x, y - 2, 9, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#e6f6ff';
  c.beginPath(); c.arc(x - 2, y - 5, 3, 0, Math.PI * 2); c.fill();
}

// ── Постройки: дома, стена, ворота, деревья, фонари ──────
// Зовётся последним, поверх теней. own — собственный прямоугольник чанка
// (без кольца соседей): точки огня фонарей попадают в список ровно одного
// чанка, иначе на стыке фонарь горел бы дважды.
function cityDrawStructures(c, L, x0, y0, x1, y1, own, torchList) {
  const T = TILE;
  // за стеной — трава и лес
  const outer = [
    { x0: -1e5, y0: -1e5, x1: 1e5, y1: L.wy0 }, { x0: -1e5, y0: L.wy1, x1: 1e5, y1: 1e5 },
    { x0: -1e5, y0: L.wy0, x1: L.wx0, y1: L.wy1 }, { x0: L.wx1, y0: L.wy0, x1: 1e5, y1: L.wy1 },
  ];
  for (const o of outer) if (_cityHit(o, x0, y0, x1, y1)) _cityOutside(c, o, x0, y0, x1, y1);

  // полоса домов: сначала мощёный двор-переулок под ними
  const band = [
    { x0: L.bx0, y0: L.by0, x1: L.bx1, y1: L.fy0 }, { x0: L.bx0, y0: L.fy1, x1: L.bx1, y1: L.by1 },
    { x0: L.bx0, y0: L.fy0, x1: L.fx0, y1: L.fy1 }, { x0: L.fx1, y0: L.fy0, x1: L.bx1, y1: L.fy1 },
  ];
  for (const b of band) {
    if (!_cityHit(b, x0, y0, x1, y1)) continue;
    const ax0 = Math.max(b.x0, x0), ay0 = Math.max(b.y0, y0);
    c.fillStyle = '#26221e';
    c.fillRect(ax0, ay0, Math.min(b.x1, x1) - ax0, Math.min(b.y1, y1) - ay0);
  }
  // улица продолжается через проём к воротам
  const rw = _CITY_ROAD_W * T;
  const cont = [
    { x0: L.cx - rw / 2, x1: L.cx + rw / 2, y0: L.wy0, y1: L.fy0, v: true },
    { x0: L.cx - rw / 2, x1: L.cx + rw / 2, y0: L.fy1, y1: L.wy1, v: true },
    { y0: L.cy - rw / 2, y1: L.cy + rw / 2, x0: L.wx0, x1: L.fx0, v: false },
    { y0: L.cy - rw / 2, y1: L.cy + rw / 2, x0: L.fx1, x1: L.wx1, v: false },
  ];
  for (const r of cont) if (_cityHit(r, x0, y0, x1, y1)) { _cityCobbles(c, r, x0, y0, x1, y1); _cityCurbs(c, r, L); }

  // крепостная стена
  _cityWalls(c, L, x0, y0, x1, y1);

  // дома
  for (const h of L.houses) {
    if (!_cityHit({ x0: h.x - 6, y0: h.y - 20, x1: h.x + h.w + 8, y1: h.y + h.h + 8 }, x0, y0, x1, y1)) continue;
    _cityHouse(c, h, own, torchList);
  }

  // ворота и угловые башни — поверх стены
  for (const g of L.gates) {
    if (!_cityHit({ x0: g.x - 4 * T, y0: g.y - 3 * T, x1: g.x + 4 * T, y1: g.y + 3 * T }, x0, y0, x1, y1)) continue;
    _cityGate(c, L, g);
  }
  const ww = _CITY_WALL_W * T;
  for (const [tx, ty] of [[L.wx0 + ww / 2, L.wy0 + ww / 2], [L.wx1 - ww / 2, L.wy0 + ww / 2], [L.wx0 + ww / 2, L.wy1 - ww / 2], [L.wx1 - ww / 2, L.wy1 - ww / 2]]) {
    if (!_cityHit({ x0: tx - 2 * T, y0: ty - 3 * T, x1: tx + 2 * T, y1: ty + 2 * T }, x0, y0, x1, y1)) continue;
    _cityTower(c, tx, ty, 1.5 * T);
  }

  // деревья в скверах
  for (const t of L.trees) {
    if (!_cityHit({ x0: t.x - t.r - 6, y0: t.y - t.r - 6, x1: t.x + t.r + 10, y1: t.y + t.r + 12 }, x0, y0, x1, y1)) continue;
    _cityTree(c, t.x, t.y, t.r, t.k);
  }

  // лавки NPC
  for (const st of L.stalls) {
    if (!_cityHit({ x0: st.x - 90, y0: st.y - 170, x1: st.x + 90, y1: st.y + 10 }, x0, y0, x1, y1)) continue;
    _cityStall(c, st, own, torchList);
  }

  // фонари
  for (const l of L.lamps) {
    if (!_cityHit({ x0: l.x - 12, y0: l.y - 50, x1: l.x + 12, y1: l.y + 8 }, x0, y0, x1, y1)) continue;
    _cityLamp(c, l.x, l.y);
    if (l.x >= own.x0 && l.x < own.x1 && l.y >= own.y0 && l.y < own.y1) torchList.push({ x: l.x, y: l.y - 38 });
  }

  // бочки и ящики у домов вдоль улиц
  if (typeof drawProp === 'function') {
    const props = ['barrel_small', 'crate_single', 'barrel_large', 'crate_stack'];
    const tx0 = Math.floor(own.x0 / T), ty0 = Math.floor(own.y0 / T), tx1 = Math.ceil(own.x1 / T), ty1 = Math.ceil(own.y1 / T);
    const fX0 = L.fx0 / T, fY0 = L.fy0 / T, fX1 = L.fx1 / T - 1, fY1 = L.fy1 / T - 1;
    for (let ty = ty0; ty < ty1; ty++) for (let tx = tx0; tx < tx1; tx++) {
      const edge = (ty === fY0 || ty === fY1) ? (tx > fX0 && tx < fX1) : ((tx === fX0 || tx === fX1) && ty > fY0 && ty < fY1);
      if (!edge) continue;
      if (Math.abs(tx * T + T / 2 - L.cx) < rw || Math.abs(ty * T + T / 2 - L.cy) < rw) continue;
      if (_cityHash(tx, ty, 95) > 0.14) continue;
      drawProp(c, props[Math.floor(_cityHash(tx, ty, 96) * props.length)], tx * T + T / 2, ty * T + T - 6);
    }
  }
}

function _cityOutside(c, o, x0, y0, x1, y1) {
  const T = TILE;
  const ax0 = Math.max(o.x0, x0), ay0 = Math.max(o.y0, y0), ax1 = Math.min(o.x1, x1), ay1 = Math.min(o.y1, y1);
  if (ax1 <= ax0 || ay1 <= ay0) return;
  c.fillStyle = '#1b2a17';
  c.fillRect(ax0, ay0, ax1 - ax0, ay1 - ay0);
  const tx0 = Math.floor(ax0 / T), ty0 = Math.floor(ay0 / T), tx1 = Math.ceil(ax1 / T), ty1 = Math.ceil(ay1 / T);
  for (let ty = ty0; ty < ty1; ty++) for (let tx = tx0; tx < tx1; tx++) {
    c.fillStyle = _cityHash(tx, ty, 101) < 0.5 ? 'rgba(40,64,30,0.6)' : 'rgba(14,22,12,0.5)';
    c.beginPath(); c.arc(tx * T + _cityHash(tx, ty, 102) * T, ty * T + _cityHash(tx, ty, 103) * T, 8 + _cityHash(tx, ty, 104) * 8, 0, Math.PI * 2); c.fill();
  }
  // Деревья за стеной: центр берётся из клетки на сетке 2×2, чтобы крона,
  // вылезающая в соседний чанк, дорисовывалась и там.
  const s = 2 * T;
  const gx0 = Math.floor((ax0 - T) / s), gy0 = Math.floor((ay0 - T) / s), gx1 = Math.ceil((ax1 + T) / s), gy1 = Math.ceil((ay1 + T) / s);
  c.save();
  c.beginPath(); c.rect(o.x0, o.y0, o.x1 - o.x0, o.y1 - o.y0); c.clip();
  for (let gy = gy0; gy < gy1; gy++) for (let gx = gx0; gx < gx1; gx++) {
    if (_cityHash(gx, gy, 110) > 0.55) continue;
    const x = gx * s + _cityHash(gx, gy, 111) * s, y = gy * s + _cityHash(gx, gy, 112) * s;
    _cityTree(c, x, y, (0.9 + _cityHash(gx, gy, 113) * 0.5) * T, gx * 7 + gy, true);
  }
  c.restore();
}

function _cityWalls(c, L, x0, y0, x1, y1) {
  const ww = _CITY_WALL_W * TILE;
  const segs = [
    { x0: L.wx0, y0: L.wy0, x1: L.wx1, y1: L.wy0 + ww, h: true },
    { x0: L.wx0, y0: L.wy1 - ww, x1: L.wx1, y1: L.wy1, h: true },
    { x0: L.wx0, y0: L.wy0, x1: L.wx0 + ww, y1: L.wy1, h: false },
    { x0: L.wx1 - ww, y0: L.wy0, x1: L.wx1, y1: L.wy1, h: false },
  ];
  for (const s of segs) {
    if (!_cityHit(s, x0, y0, x1, y1)) continue;
    const ax0 = Math.max(s.x0, x0 - TILE), ay0 = Math.max(s.y0, y0 - TILE), ax1 = Math.min(s.x1, x1 + TILE), ay1 = Math.min(s.y1, y1 + TILE);
    c.save();
    c.beginPath(); c.rect(s.x0, s.y0, s.x1 - s.x0, s.y1 - s.y0); c.clip();
    // верх стены — каменная кладка
    c.fillStyle = '#5d5850';
    c.fillRect(ax0, ay0, ax1 - ax0, ay1 - ay0);
    const bw = 26, bh = 13;
    for (let y = Math.floor(ay0 / bh) * bh; y < ay1; y += bh) {
      const row = Math.round(y / bh), off = (row & 1) ? bw / 2 : 0;
      for (let x = Math.floor((ax0 - off) / bw) * bw + off; x < ax1; x += bw) {
        const k = 0.85 + _cityHash(Math.round(x), row, 121) * 0.3;
        c.fillStyle = `rgb(${Math.round(112 * k)},${Math.round(106 * k)},${Math.round(96 * k)})`;
        c.fillRect(x + 1, y + 1, bw - 2, bh - 2);
      }
    }
    // дорожка по верху и зубцы с обеих сторон
    const m = 12, gap = 10;
    if (s.h) {
      const my = s.y0 + ww / 2;
      c.fillStyle = 'rgba(40,36,32,0.55)';
      c.fillRect(ax0, my - 12, ax1 - ax0, 24);
      for (let x = Math.floor(ax0 / (m + gap)) * (m + gap); x < ax1; x += m + gap) {
        for (const yy of [s.y0 + 2, s.y1 - 14]) {
          c.fillStyle = '#8a8377'; c.fillRect(x, yy, m, 12);
          c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillRect(x, yy + 9, m, 3);
        }
      }
      // лицевая сторона, обращённая к городу (видна сверху-спереди), — у северной стены
      if (s.y0 === L.wy0) {
        c.fillStyle = '#3e3a34'; c.fillRect(ax0, s.y1 - 10, ax1 - ax0, 10);
        c.fillStyle = 'rgba(0,0,0,0.3)'; c.fillRect(ax0, s.y1 - 3, ax1 - ax0, 3);
      }
    } else {
      const mx = s.x0 + ww / 2;
      c.fillStyle = 'rgba(40,36,32,0.55)';
      c.fillRect(mx - 12, ay0, 24, ay1 - ay0);
      for (let y = Math.floor(ay0 / (m + gap)) * (m + gap); y < ay1; y += m + gap) {
        for (const xx of [s.x0 + 2, s.x1 - 14]) {
          c.fillStyle = '#8a8377'; c.fillRect(xx, y, 12, m);
          c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillRect(xx, y + m - 3, 12, 3);
        }
      }
    }
    c.restore();
  }
}

function _cityGate(c, L, g) {
  const T = TILE, ww = _CITY_WALL_W * T, rw = _CITY_ROAD_W * T;
  const horiz = g.dir === 'n' || g.dir === 's';
  // проём: тёмная арка с решёткой, по бокам — надвратные башни
  c.save();
  if (horiz) {
    const ox = g.x - rw / 2, oy = g.y - ww / 2;
    c.fillStyle = '#4a443c'; c.fillRect(ox - 6, oy, rw + 12, ww);
    c.fillStyle = '#120f0d';
    _cityRRect(c, ox + 6, oy + 10, rw - 12, ww - 10 + 12, 14); c.fill();
    c.strokeStyle = '#3c3a38'; c.lineWidth = 3;
    for (let x = ox + 18; x < ox + rw - 10; x += 16) { c.beginPath(); c.moveTo(x, oy + 12); c.lineTo(x, oy + ww); c.stroke(); }
    for (let y = oy + 30; y < oy + ww; y += 16) { c.beginPath(); c.moveTo(ox + 8, y); c.lineTo(ox + rw - 8, y); c.stroke(); }
    c.fillStyle = '#8a8377'; c.fillRect(ox - 6, oy, rw + 12, 8);
  } else {
    const ox = g.x - ww / 2, oy = g.y - rw / 2;
    c.fillStyle = '#4a443c'; c.fillRect(ox, oy - 6, ww, rw + 12);
    c.fillStyle = '#120f0d'; c.fillRect(ox + 10, oy + 6, ww - 20, rw - 12);
    c.strokeStyle = '#3c3a38'; c.lineWidth = 3;
    for (let y = oy + 16; y < oy + rw - 8; y += 16) { c.beginPath(); c.moveTo(ox + 10, y); c.lineTo(ox + ww - 10, y); c.stroke(); }
    for (let x = ox + 20; x < ox + ww - 10; x += 16) { c.beginPath(); c.moveTo(x, oy + 6); c.lineTo(x, oy + rw - 6); c.stroke(); }
  }
  c.restore();
  const tr = 1.15 * T;
  if (horiz) { _cityTower(c, g.x - rw / 2 - tr + 8, g.y, tr); _cityTower(c, g.x + rw / 2 + tr - 8, g.y, tr); }
  else { _cityTower(c, g.x, g.y - rw / 2 - tr + 8, tr); _cityTower(c, g.x, g.y + rw / 2 + tr - 8, tr); }
  // знамёна над воротами
  const bx = horiz ? [g.x - rw / 2 - tr + 8, g.x + rw / 2 + tr - 8] : [g.x, g.x];
  const by = horiz ? [g.y, g.y] : [g.y - rw / 2 - tr + 8, g.y + rw / 2 + tr - 8];
  for (let k = 0; k < 2; k++) _cityBanner(c, bx[k], by[k] + tr - 4);
}

function _cityTower(c, x, y, r) {
  // круглая башня: основание с тенью, кольцо зубцов, конусная крыша
  c.fillStyle = 'rgba(0,0,0,0.4)';
  c.beginPath(); c.ellipse(x + 4, y + 8, r + 2, r * 0.95, 0, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#4c473f';
  c.fillRect(x - r, y, r * 2, r * 0.55);
  c.beginPath(); c.ellipse(x, y + r * 0.55, r, r * 0.5, 0, 0, Math.PI); c.fill();
  c.fillStyle = '#6f695e';
  c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#8a8377';
  for (let k = 0; k < 12; k++) {
    const a = k / 12 * Math.PI * 2;
    c.beginPath(); c.arc(x + Math.cos(a) * (r - 5), y + Math.sin(a) * (r - 5), 5, 0, Math.PI * 2); c.fill();
  }
  const rg = c.createRadialGradient(x - r * 0.3, y - r * 0.5, 2, x, y, r - 6);
  rg.addColorStop(0, '#7b8ea3'); rg.addColorStop(1, '#2c3947');
  c.fillStyle = rg;
  c.beginPath(); c.arc(x, y, r - 9, 0, Math.PI * 2); c.fill();
  c.strokeStyle = 'rgba(0,0,0,0.3)'; c.lineWidth = 2;
  for (let k = 0; k < 8; k++) {
    const a = k / 8 * Math.PI * 2;
    c.beginPath(); c.moveTo(x, y); c.lineTo(x + Math.cos(a) * (r - 9), y + Math.sin(a) * (r - 9)); c.stroke();
  }
  c.fillStyle = '#c9a452';
  c.beginPath(); c.arc(x, y, 3.5, 0, Math.PI * 2); c.fill();
}

function _cityBanner(c, x, y) {
  c.fillStyle = '#2a2018'; c.fillRect(x - 12, y - 2, 24, 4);
  c.fillStyle = '#7d1f2a';
  c.beginPath(); c.moveTo(x - 10, y); c.lineTo(x + 10, y); c.lineTo(x + 10, y + 26); c.lineTo(x, y + 20); c.lineTo(x - 10, y + 26); c.closePath(); c.fill();
  c.fillStyle = '#e2c26a';
  c.beginPath(); c.moveTo(x, y + 5); c.lineTo(x + 5, y + 11); c.lineTo(x, y + 17); c.lineTo(x - 5, y + 11); c.closePath(); c.fill();
}

function _cityHouse(c, h, own, torchList) {
  const T = TILE;
  const { x, y, w } = h;
  const H = h.h;
  const r1 = _cityHash(h.i, h.s, 201), r2 = _cityHash(h.i, h.s, 202), r3 = _cityHash(h.i, h.s, 203);
  const roof = _CITY_ROOFS[Math.floor(r1 * _CITY_ROOFS.length)];
  const wall = _CITY_PLASTER[Math.floor(r2 * _CITY_PLASTER.length)];
  const fh = Math.min(h.big ? 46 : 38, H * 0.42);      // высота фасада
  const rh = H - fh;                                    // крыша над ним
  const pad = 3;

  // тень на землю
  c.fillStyle = 'rgba(0,0,0,0.35)';
  c.fillRect(x + pad + 4, y + 6, w - pad * 2, H);

  // фасад
  const fx = x + pad, fy = y + rh, fw = w - pad * 2;
  c.fillStyle = wall;
  c.fillRect(fx, fy, fw, fh);
  // фахверк: балки по краям и под крышей
  const beam = '#4a3122';
  c.fillStyle = beam;
  c.fillRect(fx, fy, 5, fh); c.fillRect(fx + fw - 5, fy, 5, fh);
  c.fillRect(fx, fy, fw, 4);
  c.fillRect(fx, fy + fh - 5, fw, 5);
  // цоколь
  c.fillStyle = '#6b6358';
  c.fillRect(fx, fy + fh - 7, fw, 7);
  // дверь и окна по ширине дома
  const slots = Math.max(2, Math.round(fw / 34));
  const doorAt = Math.floor(r3 * slots);
  const sw = fw / slots;
  for (let k = 0; k < slots; k++) {
    const sx = fx + sw * k + sw / 2;
    if (k === doorAt) {
      const dw = 16, dh = Math.min(26, fh - 6);
      c.fillStyle = '#2a1a10';
      c.beginPath(); c.moveTo(sx - dw / 2 - 2, fy + fh); c.lineTo(sx - dw / 2 - 2, fy + fh - dh + 6); c.arc(sx, fy + fh - dh + 6, dw / 2 + 2, Math.PI, 0); c.lineTo(sx + dw / 2 + 2, fy + fh); c.closePath(); c.fill();
      c.fillStyle = '#6a4326';
      c.beginPath(); c.moveTo(sx - dw / 2, fy + fh); c.lineTo(sx - dw / 2, fy + fh - dh + 6); c.arc(sx, fy + fh - dh + 6, dw / 2, Math.PI, 0); c.lineTo(sx + dw / 2, fy + fh); c.closePath(); c.fill();
      c.fillStyle = '#4a2e18'; c.fillRect(sx - 1, fy + fh - dh + 2, 2, dh - 2);
      c.fillStyle = '#d9b45a'; c.fillRect(sx + 3, fy + fh - dh / 2, 3, 3);
      // фонарь у двери — живой огонёк (см. _updateLights)
      if (r2 > 0.35) {
        const lx = sx + dw / 2 + 7, ly = fy + fh - dh + 4;
        c.fillStyle = '#1f1a16'; c.fillRect(lx - 1, ly - 2, 6, 2); c.fillRect(lx - 3, ly, 6, 7);
        if (lx >= own.x0 && lx < own.x1 && ly >= own.y0 && ly < own.y1) torchList.push({ x: lx, y: ly + 2 });
      }
    } else {
      const ww = 14, wh = Math.min(15, fh - 16), wy = fy + 9;
      c.fillStyle = beam; c.fillRect(sx - ww / 2 - 3, wy - 3, ww + 6, wh + 6);
      const lit = _cityHash(h.i * 13 + k, h.s, 211) < 0.7;
      c.fillStyle = lit ? '#f3c66b' : '#2d3a48';
      c.fillRect(sx - ww / 2, wy, ww, wh);
      if (lit) { c.fillStyle = 'rgba(255,236,170,0.6)'; c.fillRect(sx - ww / 2, wy, ww, 4); }
      c.fillStyle = beam; c.fillRect(sx - 1, wy, 2, wh); c.fillRect(sx - ww / 2, wy + wh / 2 - 1, ww, 2);
      // ящик с цветами под окном
      if (_cityHash(h.i * 13 + k, h.s, 212) < 0.45) {
        c.fillStyle = '#5a3a22'; c.fillRect(sx - ww / 2 - 2, wy + wh + 3, ww + 4, 4);
        c.fillStyle = _cityHash(k, h.i, 213) < 0.5 ? '#e0607a' : '#e8d36a';
        for (let j = 0; j < 4; j++) { c.beginPath(); c.arc(sx - ww / 2 + 2 + j * 4, wy + wh + 2, 2, 0, Math.PI * 2); c.fill(); }
      }
    }
  }

  // крыша: двускатная, конёк вдоль улицы; задний скат светлее
  const ov = 5; // свес
  const rx = x, ry = y, rw = w, rH = rh + 4;
  const ridge = ry + rH * 0.36;
  c.fillStyle = _cityShade(roof, 0.12);
  c.fillRect(rx, ry, rw, ridge - ry);
  const fg = c.createLinearGradient(0, ridge, 0, ry + rH);
  fg.addColorStop(0, roof); fg.addColorStop(1, _cityShade(roof, -0.25));
  c.fillStyle = fg;
  c.fillRect(rx - 1, ridge, rw + 2, ry + rH - ridge + ov * 0.4);
  // черепица: ряды с полукруглым краем
  c.save();
  c.beginPath(); c.rect(rx - 1, ry, rw + 2, rH + ov); c.clip();
  const tileW = 10, rowH = 8;
  for (let yy = ridge + 3, row = 0; yy < ry + rH + ov; yy += rowH, row++) {
    c.fillStyle = 'rgba(0,0,0,0.22)';
    c.fillRect(rx, yy + rowH - 2, rw, 2);
    const off = (row & 1) ? tileW / 2 : 0;
    c.fillStyle = 'rgba(0,0,0,0.16)';
    for (let xx = rx + off; xx < rx + rw; xx += tileW) c.fillRect(xx, yy, 2, rowH - 2);
  }
  for (let yy = ry + 3, row = 0; yy < ridge - 2; yy += rowH, row++) {
    c.fillStyle = 'rgba(0,0,0,0.12)';
    c.fillRect(rx, yy + rowH - 2, rw, 2);
  }
  c.restore();
  // конёк и торцы
  c.fillStyle = _cityShade(roof, -0.45);
  c.fillRect(rx, ridge - 2, rw, 4);
  c.fillStyle = _cityShade(roof, 0.3);
  c.fillRect(rx, ridge - 3, rw, 1.5);
  c.fillStyle = 'rgba(0,0,0,0.3)';
  c.fillRect(rx, ry, 3, rH); c.fillRect(rx + rw - 3, ry, 3, rH);
  // карниз
  c.fillStyle = _cityShade(roof, -0.55);
  c.fillRect(rx - 1, ry + rH - 2, rw + 2, 4);
  c.fillStyle = 'rgba(0,0,0,0.35)';
  c.fillRect(fx, ry + rH + 2, fw, 4);

  // труба
  if (_cityHash(h.i, h.s, 204) < 0.6) {
    const chx = rx + rw * (0.2 + _cityHash(h.i, h.s, 205) * 0.6), chy = ry + 2;
    c.fillStyle = '#6b3b2e'; c.fillRect(chx - 6, chy - 12, 12, 18);
    c.fillStyle = '#4a2820'; c.fillRect(chx - 6, chy - 3, 12, 3);
    c.fillStyle = '#8a8377'; c.fillRect(chx - 8, chy - 14, 16, 4);
    c.fillStyle = '#1a1512'; c.fillRect(chx - 4, chy - 13, 8, 2);
  }
  // слуховое окно на больших крышах
  if (w >= 4 * T && rH > 70) {
    const dx = rx + rw * (0.3 + _cityHash(h.i, h.s, 206) * 0.4), dy = ridge + 8;
    c.fillStyle = _cityShade(roof, -0.3);
    c.beginPath(); c.moveTo(dx - 14, dy + 20); c.lineTo(dx, dy); c.lineTo(dx + 14, dy + 20); c.closePath(); c.fill();
    c.fillStyle = wall; c.fillRect(dx - 9, dy + 12, 18, 14);
    c.fillStyle = '#f3c66b'; c.fillRect(dx - 5, dy + 15, 10, 9);
  }
}

function _cityTree(c, x, y, r, k, dark) {
  c.fillStyle = 'rgba(0,0,0,0.35)';
  c.beginPath(); c.ellipse(x + 5, y + r * 0.55, r * 0.95, r * 0.5, 0, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#4a3322';
  c.fillRect(x - 3, y, 6, r * 0.55);
  const base = dark ? ['#1e3a1c', '#27482a', '#2f5530'] : ['#2f5a26', '#3b6e30', '#4d8a3c'];
  const blobs = 5;
  for (let j = 0; j < blobs; j++) {
    const a = j / blobs * Math.PI * 2 + _cityHash(k, j, 301) * 0.8;
    const bx = x + Math.cos(a) * r * 0.42, by = y - r * 0.35 + Math.sin(a) * r * 0.32;
    c.fillStyle = base[0];
    c.beginPath(); c.arc(bx, by, r * 0.55, 0, Math.PI * 2); c.fill();
  }
  c.fillStyle = base[1];
  c.beginPath(); c.arc(x, y - r * 0.4, r * 0.62, 0, Math.PI * 2); c.fill();
  c.fillStyle = base[2];
  c.beginPath(); c.arc(x - r * 0.18, y - r * 0.58, r * 0.34, 0, Math.PI * 2); c.fill();
  if (!dark && _cityHash(k, 7, 302) < 0.5) {
    c.fillStyle = '#d8494a';
    for (let j = 0; j < 4; j++) { c.beginPath(); c.arc(x + (_cityHash(k, j, 303) - 0.5) * r, y - r * 0.4 + (_cityHash(k, j, 304) - 0.5) * r * 0.8, 2.5, 0, Math.PI * 2); c.fill(); }
  }
}

function _cityLamp(c, x, y) {
  c.fillStyle = 'rgba(0,0,0,0.35)';
  c.beginPath(); c.ellipse(x + 3, y + 2, 9, 4, 0, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#1f1c1a';
  c.fillRect(x - 5, y - 4, 10, 5);         // основание
  c.fillRect(x - 2, y - 38, 4, 36);        // столб
  c.fillRect(x - 7, y - 46, 14, 3);        // крышка фонаря
  c.fillStyle = 'rgba(255,200,110,0.55)';
  c.fillRect(x - 5, y - 43, 10, 9);        // стекло
  c.fillStyle = '#1f1c1a';
  c.fillRect(x - 6, y - 34, 12, 2);
  c.fillRect(x - 1, y - 43, 2, 9);
}

function _cityRRect(c, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

// ── Лавки NPC ────────────────────────────────────────────
// Навес на столбах над прилавком, всё смотрит вниз, на игрока. (x, y) —
// точка, где стоит NPC: прилавок заканчивается чуть выше неё, и спрайт
// NPC, нарисованный поверх пола, оказывается прямо перед лавкой.
const _CITY_STALL = {
  merchant:  { a: '#d9822b', b: '#f1e3c4', sign: '#d9822b' },
  craftsman: { a: '#3b4a63', b: '#6a7a94', sign: '#8888ff' },
  storage:   { a: '#3d7a3a', b: '#d9d1b0', sign: '#44cc44' },
};
function _cityStall(c, st, own, torchList) {
  const sty = _CITY_STALL[st.kind] || _CITY_STALL.merchant;
  const W = 132, x = st.x - W / 2;
  const yb = st.y - 14;          // низ прилавка
  const yt = yb - 104;           // верх задней стенки
  // тень
  c.fillStyle = 'rgba(0,0,0,0.35)';
  c.fillRect(x + 6, yt + 10, W, yb - yt);
  // задняя стенка из досок
  c.fillStyle = '#5a3c24';
  c.fillRect(x + 6, yt, W - 12, 70);
  c.fillStyle = 'rgba(0,0,0,0.25)';
  for (let px = x + 6; px < x + W - 6; px += 12) c.fillRect(px, yt, 2, 70);

  // товар на полках за прилавком
  if (st.kind === 'merchant') {
    c.fillStyle = '#3e2816'; c.fillRect(x + 10, yt + 34, W - 20, 4);
    const cols = ['#e04848', '#4a8fe0', '#4ac06a', '#e0c048', '#b060e0'];
    for (let k = 0; k < 9; k++) {
      const bx = x + 18 + k * 12.5;
      c.fillStyle = cols[k % cols.length];
      c.beginPath(); c.arc(bx, yt + 28, 5, 0, Math.PI * 2); c.fill();
      c.fillRect(bx - 1.5, yt + 18, 3, 6);
      c.fillStyle = 'rgba(255,255,255,0.5)'; c.fillRect(bx - 3, yt + 25, 2, 2);
    }
  } else if (st.kind === 'craftsman') {
    // горн: каменная печь с огнём
    const fx = x + W - 34, fy = yt + 12;
    c.fillStyle = '#4a4540'; _cityRRect(c, fx - 22, fy, 44, 56, 6); c.fill();
    c.fillStyle = '#2a2622'; _cityRRect(c, fx - 14, fy + 20, 28, 24, 10); c.fill();
    const fg = c.createRadialGradient(fx, fy + 38, 2, fx, fy + 34, 16);
    fg.addColorStop(0, '#ffe08a'); fg.addColorStop(0.5, '#ff8a2e'); fg.addColorStop(1, 'rgba(160,40,10,0.2)');
    c.fillStyle = fg; _cityRRect(c, fx - 12, fy + 24, 24, 18, 8); c.fill();
    if (fx >= own.x0 && fx < own.x1 && fy + 30 >= own.y0 && fy + 30 < own.y1) torchList.push({ x: fx, y: fy + 30 });
    // инструменты на стене
    c.strokeStyle = '#8a8f99'; c.lineWidth = 3;
    for (let k = 0; k < 3; k++) {
      const hx = x + 22 + k * 18;
      c.beginPath(); c.moveTo(hx, yt + 12); c.lineTo(hx, yt + 40); c.stroke();
    }
    c.fillStyle = '#8a8f99'; c.fillRect(x + 16, yt + 10, 12, 6); c.fillRect(x + 34, yt + 38, 8, 6);
  } else {
    // сундуки и бочки
    const chest = (cx0, cy0, w) => {
      c.fillStyle = '#6a4326'; c.fillRect(cx0, cy0, w, 20);
      c.fillStyle = '#7d5230'; c.fillRect(cx0, cy0 - 6, w, 8);
      c.fillStyle = '#c9a452'; c.fillRect(cx0, cy0 + 2, w, 3); c.fillRect(cx0 + w / 2 - 3, cy0 + 4, 6, 7);
    };
    chest(x + 14, yt + 44, 30); chest(x + 50, yt + 44, 34); chest(x + 20, yt + 22, 26);
    c.fillStyle = '#5d3a20'; _cityRRect(c, x + W - 36, yt + 20, 22, 44, 8); c.fill();
    c.fillStyle = '#2a2018'; c.fillRect(x + W - 36, yt + 30, 22, 3); c.fillRect(x + W - 36, yt + 52, 22, 3);
  }

  // навес: полосатая ткань с фестонами
  const ay0 = yt - 8, ay1 = yt + 46;
  c.save();
  c.beginPath(); c.rect(x - 4, ay0, W + 8, ay1 - ay0 + 10); c.clip();
  const sw = 16;
  for (let k = 0, px = x - 4; px < x + W + 4; px += sw, k++) {
    c.fillStyle = k & 1 ? sty.b : sty.a;
    c.fillRect(px, ay0, sw, ay1 - ay0);
    c.beginPath(); c.arc(px + sw / 2, ay1, sw / 2, 0, Math.PI); c.fill();
  }
  const sh = c.createLinearGradient(0, ay0, 0, ay1);
  sh.addColorStop(0, 'rgba(255,255,255,0.18)'); sh.addColorStop(1, 'rgba(0,0,0,0.22)');
  c.fillStyle = sh; c.fillRect(x - 4, ay0, W + 8, ay1 - ay0);
  c.restore();
  c.fillStyle = 'rgba(0,0,0,0.3)'; c.fillRect(x - 4, ay0, W + 8, 3);

  // столбы
  c.fillStyle = '#4a3122';
  c.fillRect(x + 2, ay1, 6, yb - ay1); c.fillRect(x + W - 8, ay1, 6, yb - ay1);

  // прилавок
  const ct = yb - 30;
  c.fillStyle = '#7d5230'; c.fillRect(x, ct, W, 8);
  c.fillStyle = '#5e3c22'; c.fillRect(x + 4, ct + 8, W - 8, yb - ct - 8);
  c.fillStyle = 'rgba(0,0,0,0.25)';
  for (let px = x + 4; px < x + W - 4; px += 14) c.fillRect(px, ct + 8, 2, yb - ct - 8);
  c.fillStyle = 'rgba(255,230,190,0.18)'; c.fillRect(x, ct, W, 2);
  // на прилавке
  if (st.kind === 'merchant') {
    c.fillStyle = '#8a5a2e'; c.fillRect(x + 14, ct - 8, 26, 9);
    c.fillStyle = '#e04848'; for (let k = 0; k < 3; k++) { c.beginPath(); c.arc(x + 19 + k * 8, ct - 9, 3.5, 0, Math.PI * 2); c.fill(); }
    c.fillStyle = '#e0c048'; for (let k = 0; k < 4; k++) { c.beginPath(); c.arc(x + W - 32 + k * 5, ct - 3 - (k & 1) * 2, 3, 0, Math.PI * 2); c.fill(); }
  } else if (st.kind === 'craftsman') {
    // наковальня
    const axc = x + 34;
    c.fillStyle = '#2e3136'; c.fillRect(axc - 6, ct - 8, 12, 8);
    c.fillStyle = '#4d535c';
    c.beginPath(); c.moveTo(axc - 20, ct - 16); c.lineTo(axc + 16, ct - 16); c.lineTo(axc + 10, ct - 8); c.lineTo(axc - 14, ct - 8); c.closePath(); c.fill();
    c.fillStyle = '#7b828d'; c.fillRect(axc - 20, ct - 17, 36, 3);
    c.fillStyle = '#a8adb5'; c.fillRect(x + W - 50, ct - 5, 22, 4); c.fillRect(x + W - 30, ct - 8, 5, 10);
  } else {
    c.fillStyle = '#d9d1b0'; c.fillRect(x + 20, ct - 5, 30, 6);
    c.fillStyle = '#8a5a2e'; c.fillRect(x + W - 44, ct - 12, 22, 13);
    c.fillStyle = '#c9a452'; c.fillRect(x + W - 36, ct - 8, 6, 5);
  }

  // вывеска над навесом
  const sx = st.x, sy = ay0 - 14;
  c.fillStyle = '#2a2018'; c.fillRect(sx - 1.5, sy + 10, 3, 10);
  c.fillStyle = '#3e2816';
  c.beginPath(); c.arc(sx, sy, 15, 0, Math.PI * 2); c.fill();
  c.fillStyle = sty.sign;
  c.beginPath(); c.arc(sx, sy, 12, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#1a1410';
  if (st.kind === 'merchant') {
    c.beginPath(); c.arc(sx, sy + 2, 6, 0, Math.PI * 2); c.fill();
    c.fillRect(sx - 2.5, sy - 8, 5, 6);
  } else if (st.kind === 'craftsman') {
    c.save(); c.translate(sx, sy); c.rotate(-Math.PI / 4);
    c.fillRect(-1.5, -3, 3, 12); c.fillRect(-6, -7, 12, 5);
    c.restore();
  } else {
    c.fillRect(sx - 7, sy - 4, 14, 10);
    c.fillStyle = sty.sign; c.fillRect(sx - 7, sy - 1, 14, 2);
    c.fillStyle = '#1a1410'; c.fillRect(sx - 7, sy - 7, 14, 4);
  }
}
