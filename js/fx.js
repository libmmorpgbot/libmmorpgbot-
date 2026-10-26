// ═══════════════════════════════════════════════════════════════════════════
//  Боевые эффекты: искры, вспышки, ударные волны, взмахи, осколки, молнии,
//  рунные круги и шлейфы. Только вид — ни урона, ни сети здесь нет.
// ═══════════════════════════════════════════════════════════════════════════
//
// Частица — плоский объект; рисует их _updateFx (js/pixi-world.js) пулом
// спрайтов из запечённых текстур, по одному вызову отрисовки на слой. Слоёв
// три: «земля» (под персонажами — круги, волны), «верх» (над ними — искры,
// взмахи; оба с аддитивным смешением, то есть светятся) и дым (обычное
// смешение, тёмный). Сколько частиц живёт одновременно — FX_MAX, на слабом
// устройстве (адаптивный _qualityTier) втрое меньше.
//
// Рецепт навыка — SKILL_FX[класс][клавиша](ctx). Зовётся при касте и у
// своего персонажа (useSkill, js/player.js), и у чужого (castAnim,
// js/network.js), так что эффект видят все рядом.

let fxParts = [];
let fxEmitters = [];
const FX_MAX = 700, FX_MAX_LOW = 220;
// Общий множитель размера частиц (кроме колец и рун — у тех размер = радиус
// действия). Камера отдалена (ZOOM 0.75), без него искры теряются.
const FX_SCALE = 1.6;

const FX_TEX = ['dot', 'glow', 'ring', 'slash', 'shard', 'star', 'rune', 'smoke'];

const _fxTintCache = new Map();
function _fxTint(c) {
  if (typeof c === 'number') return c;
  let v = _fxTintCache.get(c);
  if (v === undefined) { v = parseInt(String(c).replace('#', ''), 16) || 0xffffff; _fxTintCache.set(c, v); }
  return v;
}
function _fxCap() { return (typeof _qualityTier !== 'undefined' && _qualityTier > 0) ? FX_MAX_LOW : FX_MAX; }
function _rnd(a, b) { return a + Math.random() * (b - a); }

// Базовая частица. layer: 'top' | 'ground' | 'smoke'. s0→s1 — размер (мир. px)
// от рождения к смерти; fade: 'out' (гаснет к концу) | 'inout' (вспыхивает и
// гаснет); align — повернуть по скорости (искры-штрихи); z/vz — высота над
// полом (дым, поднимающиеся огоньки), рисуется как сдвиг вверх.
function fxP(o) {
  if (fxParts.length >= _fxCap()) return null;
  const p = {
    k: o.k || 'dot', layer: o.layer || 'top',
    x: o.x, y: o.y, z: o.z || 0, vx: o.vx || 0, vy: o.vy || 0, vz: o.vz || 0,
    ax: o.ax || 0, ay: o.ay || 0, az: o.az || 0, drag: o.drag || 0,
    life: o.life || 0.5, max: o.life || 0.5,
    s0: o.s0 != null ? o.s0 : 8, s1: o.s1 != null ? o.s1 : (o.s0 != null ? o.s0 : 8),
    a0: o.a0 != null ? o.a0 : 1, fade: o.fade || 'out',
    rot: o.rot || 0, vr: o.vr || 0, sx: o.sx || 1, align: !!o.align,
    tint: _fxTint(o.col || '#ffffff'), delay: o.delay || 0,
  };
  fxParts.push(p);
  return p;
}

// Разлёт искр из точки.
function fxBurst(x, y, o) {
  const n = o.n || 12;
  for (let i = 0; i < n; i++) {
    const a = o.ang != null ? o.ang + _rnd(-(o.spread || 0.6), o.spread || 0.6) : Math.random() * Math.PI * 2;
    const s = _rnd(o.sp0 || 80, o.sp1 || 240);
    fxP({
      k: o.k || 'dot', layer: o.layer, x, y, z: o.z || 0,
      vx: Math.cos(a) * s, vy: Math.sin(a) * s, vz: o.vz != null ? _rnd(o.vz * 0.5, o.vz) : 0, az: o.az || 0,
      drag: o.drag != null ? o.drag : 3, life: _rnd((o.life || 0.5) * 0.6, o.life || 0.5),
      s0: _rnd((o.size || 6) * 0.6, o.size || 6), s1: o.shrink === false ? undefined : 0.5,
      col: Array.isArray(o.col) ? o.col[i % o.col.length] : o.col, align: o.align !== false && (o.k || 'dot') === 'dot',
      sx: o.sx || ((o.k || 'dot') === 'dot' ? 2.6 : 1), rot: Math.random() * 6.28, vr: o.vr ? _rnd(-o.vr, o.vr) : 0,
      delay: o.delay || 0,
    });
  }
}
function fxGlow(x, y, size, col, life, o) {
  o = o || {};
  return fxP({ k: 'glow', layer: o.layer || 'top', x, y, z: o.z || 0, s0: size * (o.from || 0.4), s1: size, life: life || 0.35, col, a0: o.a || 1, delay: o.delay || 0 });
}
function fxRing(x, y, r0, r1, col, life, o) {
  o = o || {};
  return fxP({ k: 'ring', layer: o.layer || 'ground', x, y, s0: r0 * 2, s1: r1 * 2, life: life || 0.45, col, a0: o.a || 1, delay: o.delay || 0 });
}
// Полумесяц взмаха, выпуклостью по углу ang.
function fxSlash(x, y, ang, r, col, life, o) {
  o = o || {};
  return fxP({ k: 'slash', layer: 'top', x, y, z: o.z || 0, s0: r * 1.6, s1: r * 2.3, rot: ang, vr: o.vr || 0, life: life || 0.24, col, a0: o.a || 1, delay: o.delay || 0, sx: o.flip ? -1 : 1 });
}
function fxRune(x, y, r, col, life, o) {
  o = o || {};
  return fxP({ k: 'rune', layer: 'ground', x, y, s0: r * 1.6, s1: r * 2.1, rot: Math.random() * 6.28, vr: o.vr != null ? o.vr : 1.6, life: life || 0.9, col, a0: o.a || 0.95, fade: 'inout', delay: o.delay || 0 });
}
// Молния ломаной из коротких штрихов.
function fxBolt(x1, y1, x2, y2, col, o) {
  o = o || {};
  const segs = o.segs || 7, jit = o.jit || 14;
  let px = x1, py = y1;
  const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len;
  for (let i = 1; i <= segs; i++) {
    const t = i / segs, j = i === segs ? 0 : _rnd(-jit, jit);
    const qx = x1 + dx * t + nx * j, qy = y1 + dy * t + ny * j;
    const mx = (px + qx) / 2, my = (py + qy) / 2, sl = Math.hypot(qx - px, qy - py);
    fxP({ k: 'dot', layer: 'top', x: mx, y: my, z: o.z || 0, s0: 5, s1: 3, sx: sl / 5 * 1.15, rot: Math.atan2(qy - py, qx - px), life: o.life || 0.18, col: '#ffffff', delay: o.delay || 0 });
    fxP({ k: 'glow', layer: 'top', x: mx, y: my, z: o.z || 0, s0: 16, s1: 12, sx: sl / 16 * 1.4, rot: Math.atan2(qy - py, qx - px), life: o.life || 0.22, col, a0: 0.8, delay: o.delay || 0 });
    px = qx; py = qy;
  }
}
// Поднимающиеся огоньки вокруг точки (баффы, лечение).
function fxRise(x, y, col, o) {
  o = o || {};
  const n = o.n || 14, r = o.r || 26;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * 6.28, d = Math.sqrt(Math.random()) * r;
    fxP({ k: o.k || 'dot', layer: 'top', x: x + Math.cos(a) * d, y: y + Math.sin(a) * d * 0.6, z: _rnd(0, 10),
      vz: _rnd(o.v0 || 40, o.v1 || 110), drag: 0.5, life: _rnd(0.5, o.life || 1.0), s0: _rnd(3, o.size || 7), s1: 0.5,
      col: Array.isArray(col) ? col[i % col.length] : col, delay: _rnd(0, o.spreadT || 0.3), rot: Math.random() * 6.28, vr: o.k === 'star' ? 3 : 0 });
  }
}
// Закручивающийся вихрь частиц вокруг точки — к центру (in) или наружу.
function fxSwirl(x, y, col, o) {
  o = o || {};
  const n = o.n || 18, r = o.r || 60, dir = o.in ? -1 : 1;
  for (let i = 0; i < n; i++) {
    const a = i / n * 6.28 + Math.random() * 0.4;
    const rr = o.in ? r : _rnd(4, 14);
    const sp = _rnd(o.sp0 || 120, o.sp1 || 220);
    const tx = -Math.sin(a), ty = Math.cos(a);
    fxP({ k: 'dot', layer: 'top', x: x + Math.cos(a) * rr, y: y + Math.sin(a) * rr * 0.7, z: o.z || 18,
      vx: (Math.cos(a) * dir * 0.7 + tx * 0.9) * sp, vy: (Math.sin(a) * dir * 0.7 + ty * 0.9) * sp * 0.7,
      drag: o.in ? 0 : 2.5, life: o.life || 0.45, s0: o.size || 6, s1: 1.5, sx: 2.4, align: true,
      col: Array.isArray(col) ? col[i % col.length] : col, delay: o.delay || 0 });
  }
}
// Клубы дыма.
function fxSmoke(x, y, col, o) {
  o = o || {};
  const n = o.n || 6;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * 6.28, s = _rnd(10, o.sp || 50);
    fxP({ k: 'smoke', layer: 'smoke', x: x + _rnd(-8, 8), y: y + _rnd(-6, 6), z: _rnd(0, 12), vx: Math.cos(a) * s, vy: Math.sin(a) * s * 0.6,
      vz: _rnd(8, 30), drag: 2, life: _rnd(0.5, o.life || 0.9), s0: _rnd(14, o.size || 26), s1: (o.size || 26) * 1.7, a0: o.a || 0.55,
      col: col || '#1a1420', delay: o.delay || 0 });
  }
}
// Излучатель, привязанный к сущности на dur секунд: шлейфы рывков, ауры.
function fxEmit(follow, dur, every, fn, onEnd) {
  fxEmitters.push({ follow, t: 0, dur, every, acc: every, fn, onEnd, lx: follow.x, ly: follow.y });
}

// ── шаг симуляции (из update, js/game.js) ───────────────────────────────────
function fxUpdate(dt) {
  if (fxEmitters.length) {
    let j = 0;
    for (let i = 0; i < fxEmitters.length; i++) {
      const e = fxEmitters[i];
      e.t += dt; e.acc += dt;
      while (e.acc >= e.every && e.t <= e.dur) {
        e.acc -= e.every;
        try { e.fn(e.follow.x, e.follow.y, e.t / e.dur, e); } catch (_) { /* сущность исчезла */ }
      }
      e.lx = e.follow.x; e.ly = e.follow.y;
      if (e.t <= e.dur) fxEmitters[j++] = e;
      else if (e.onEnd) { try { e.onEnd(e.follow.x, e.follow.y); } catch (_) { /* нет её */ } }
    }
    fxEmitters.length = j;
  }
  _fxTrails(dt);
  let j = 0;
  for (let i = 0; i < fxParts.length; i++) {
    const p = fxParts[i];
    if (p.delay > 0) { p.delay -= dt; fxParts[j++] = p; continue; }
    p.life -= dt;
    if (p.life <= 0) continue;
    if (p.drag) { const k = Math.max(0, 1 - p.drag * dt); p.vx *= k; p.vy *= k; p.vz *= k; }
    p.vx += p.ax * dt; p.vy += p.ay * dt; p.vz += p.az * dt;
    p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
    if (p.z < 0) { p.z = 0; p.vz = 0; }
    p.rot += p.vr * dt;
    fxParts[j++] = p;
  }
  fxParts.length = j;
}

// Шлейфы снарядов: магические сгустки сыплют искрами, стрелы тянут штрих.
function _fxTrails(dt) {
  const each = (arr) => {
    if (!arr) return;
    for (let i = 0; i < arr.length; i++) {
      const p = arr[i];
      p._fxAcc = (p._fxAcc || 0) + dt;
      if (p._fxAcc < 0.03) continue;
      p._fxAcc = 0;
      if (p.projType === 'arrow') {
        fxP({ k: 'dot', x: p.x, y: p.y, s0: 3.5, s1: 1, sx: 4, rot: Math.atan2(p.vy, p.vx), life: 0.16, col: p.color || '#ffffff', a0: 0.7 });
      } else {
        fxP({ k: 'dot', x: p.x + _rnd(-3, 3), y: p.y + _rnd(-3, 3), vx: -p.vx * 0.1 + _rnd(-30, 30), vy: -p.vy * 0.1 + _rnd(-30, 30),
          drag: 2, s0: _rnd(3, (p.size || 5) * 1.2), s1: 0.5, life: 0.3, col: p.color || '#88ccff' });
        if (Math.random() < 0.5) fxP({ k: 'star', x: p.x, y: p.y, s0: 7, s1: 2, rot: Math.random() * 6, vr: 6, life: 0.25, col: '#ffffff', a0: 0.8 });
      }
    }
  };
  if (typeof projs !== 'undefined') each(projs);
  if (typeof otherProjs !== 'undefined') each(otherProjs);
}

// ── палитры классов ─────────────────────────────────────────────────────────
const FX_PAL = {
  lev:         { c1: '#ffd36a', c2: '#9fe0ff', c3: '#fff4d0' },
  deathknight: { c1: '#ff3a4e', c2: '#7a0a24', c3: '#ffb0b8' },
  ranger:      { c1: '#9dff6a', c2: '#3fae4a', c3: '#efffc8' },
  mage:        { c1: '#6ad8ff', c2: '#3a6aff', c3: '#e0f8ff' },
  warlock:     { c1: '#ff8a2a', c2: '#ffd060', c3: '#7aff9a' },
  runefighter: { c1: '#ffa040', c2: '#ff5a1a', c3: '#ffe6b0' },
  assassin:    { c1: '#b56aff', c2: '#40ffd0', c3: '#f0d8ff' },
};
const _FACE_ANG = { right: 0, frontright: Math.PI / 4, front: Math.PI / 2, frontleft: Math.PI * 3 / 4,
  left: Math.PI, backleft: -Math.PI * 3 / 4, back: -Math.PI / 2, backright: -Math.PI / 4 };

function _fxCtx(type, caster, adv) {
  const pal = FX_PAL[type] || FX_PAL.mage;
  const x = caster.x, y = caster.y;
  let ang = _FACE_ANG[caster.facing] != null ? _FACE_ANG[caster.facing] : Math.PI / 2;
  // цель — ближайший живой монстр рядом с кастующим, иначе точка перед ним
  let tx = x + Math.cos(ang) * 70, ty = y + Math.sin(ang) * 70, best = 260 * 260, tgt = null;
  if (typeof serverEnemies !== 'undefined') {
    for (let i = 0; i < serverEnemies.length; i++) {
      const e = serverEnemies[i];
      if (!e || (e.hp || 0) <= 0) continue;
      const d = (e.x - x) * (e.x - x) + (e.y - y) * (e.y - y);
      if (d < best) { best = d; tgt = e; }
    }
  }
  if (tgt) { tx = tgt.x; ty = tgt.y; ang = Math.atan2(ty - y, tx - x); }
  return { x, y, tx, ty, ang, adv: !!adv, m: adv ? 1.4 : 1, caster, ...pal };
}

// Общие заготовки, из которых собраны рецепты.
const FXK = {
  impact(x, y, c, m) {
    fxGlow(x, y - 14, 70 * m, c.c3 || '#ffffff', 0.22);
    fxGlow(x, y - 14, 46 * m, c.c1, 0.3);
    fxRing(x, y, 6, 46 * m, c.c1, 0.35);
    fxBurst(x, y - 14, { n: Math.round(14 * m), col: [c.c1, c.c3 || '#fff'], sp0: 120, sp1: 330, size: 6, life: 0.4 });
  },
  whirl(x, y, c, m, turns) {
    for (let i = 0; i < 6 * (turns || 1); i++) {
      const a = i * Math.PI / 3;
      fxSlash(x, y - 14, a, 52 * m, i % 2 ? c.c2 : c.c1, 0.26, { delay: i * 0.045, vr: 9 });
    }
    fxRing(x, y, 20, 110 * m, c.c1, 0.45);
    fxRing(x, y, 10, 90 * m, c.c3 || '#fff', 0.35, { delay: 0.12, a: 0.6 });
    fxBurst(x, y - 10, { n: Math.round(22 * m), col: [c.c1, '#ffffff'], sp0: 160, sp1: 380, size: 5, life: 0.45, delay: 0.05 });
  },
  aura(x, y, c, m, col) {
    fxRune(x, y, 46 * m, col || c.c1, 1.0);
    fxRing(x, y, 14, 60 * m, col || c.c1, 0.5);
    fxRing(x, y, 14, 60 * m, c.c3 || '#fff', 0.5, { delay: 0.18, a: 0.5 });
    fxRise(x, y, [col || c.c1, c.c3 || '#fff'], { n: Math.round(22 * m), r: 30, k: 'star', size: 9, life: 1.1 });
    fxGlow(x, y - 24, 90 * m, col || c.c1, 0.5, { a: 0.55 });
  },
  dash(caster, c, m, smoke) {
    const x0 = caster.x, y0 = caster.y;
    fxRing(x0, y0, 6, 40, c.c1, 0.3);
    fxBurst(x0, y0, { n: 10, col: c.c3 || '#fff', sp0: 60, sp1: 160, size: 4, life: 0.35 });
    if (smoke) fxSmoke(x0, y0, smoke, { n: 5 });
    fxEmit(caster, 0.38, 0.016, (x, y, t, e) => {
      const dx = x - e.lx, dy = y - e.ly;
      const a = Math.atan2(dy, dx), d = Math.hypot(dx, dy);
      if (d > 0.5) {
        fxP({ k: 'glow', x, y, z: 16, s0: 26 * m, s1: 10, sx: Math.max(1, d / 6), rot: a, life: 0.28, col: c.c1, a0: 0.7 });
        fxP({ k: 'dot', x: x + _rnd(-6, 6), y: y + _rnd(-6, 6), z: _rnd(4, 30), s0: 5, s1: 1, sx: 3, rot: a, life: 0.3, col: c.c3 || '#fff' });
      }
      if (smoke && Math.random() < 0.4) fxSmoke(x, y, smoke, { n: 1, size: 18, life: 0.6 });
    }, (x, y) => FXK.impact(x, y, c, m));
  },
};

// ── рецепты навыков ────────────────────────────────────────────────────────
const SKILL_FX = {
  lev: {
    Q(c) { // Ледяной удар / Молот гнева — ледяной взрыв на цели
      FXK.impact(c.tx, c.ty, { c1: c.c2, c3: '#ffffff' }, c.m);
      fxBurst(c.tx, c.ty - 16, { k: 'shard', n: Math.round(12 * c.m), col: ['#d8f4ff', c.c2], sp0: 140, sp1: 300, size: 16, life: 0.55, vr: 8, shrink: true });
      if (c.adv) fxBolt(c.tx, c.ty - 160, c.tx, c.ty - 10, c.c1, { segs: 8, jit: 18 });
      fxRune(c.tx, c.ty, 38, c.c2, 0.6, { vr: -3 });
    },
    W(c) { FXK.whirl(c.x, c.y, c, c.m, c.adv ? 2 : 1); },
    E(c) { FXK.aura(c.x, c.y, c, c.m); fxP({ k: 'ring', layer: 'top', x: c.x, y: c.y - 24, s0: 70, s1: 84, life: 0.9, col: c.c1, a0: 0.5, fade: 'inout' }); },
    R(c) { FXK.dash(c.caster, c, c.m); },
  },
  deathknight: {
    Q(c) { // Вампиризм — кровь стягивается к рыцарю
      fxSwirl(c.x, c.y, [c.c1, c.c2], { in: true, n: Math.round(26 * c.m), r: 90, life: 0.5 });
      fxGlow(c.x, c.y - 20, 80 * c.m, c.c1, 0.55, { a: 0.6, delay: 0.3 });
      fxRune(c.x, c.y, 44 * c.m, c.c1, 0.9, { vr: -2 });
    },
    W(c) { FXK.whirl(c.x, c.y, c, c.m, c.adv ? 2 : 1); fxSmoke(c.x, c.y, '#2a0610', { n: 6, sp: 90 }); },
    E(c) { // Ярость — алые языки пламени
      FXK.aura(c.x, c.y, c, c.m);
      fxRise(c.x, c.y, [c.c1, '#ff8a6a'], { n: Math.round(30 * c.m), r: 22, v0: 80, v1: 170, size: 9, life: 0.8 });
    },
    R(c) { FXK.dash(c.caster, c, c.m, '#1a0610'); },
  },
  ranger: {
    Q(c) { // Мульти-выстрел — веер зелёных вспышек
      for (let i = -2; i <= 2; i++) {
        const a = c.ang + i * 0.22;
        fxP({ k: 'glow', x: c.x + Math.cos(a) * 40, y: c.y - 16 + Math.sin(a) * 40, s0: 18, s1: 10, sx: 5, rot: a, life: 0.22, col: c.c1, delay: Math.abs(i) * 0.03 });
      }
      fxGlow(c.x + Math.cos(c.ang) * 20, c.y - 16 + Math.sin(c.ang) * 20, 50 * c.m, c.c3, 0.2);
      fxBurst(c.x + Math.cos(c.ang) * 22, c.y - 16 + Math.sin(c.ang) * 22, { n: 14, ang: c.ang, spread: 0.7, col: [c.c1, c.c3], sp0: 150, sp1: 320, size: 5, life: 0.35 });
      if (c.adv) for (let i = 0; i < 14; i++) fxP({ k: 'dot', x: c.tx + _rnd(-80, 80), y: c.ty + _rnd(-60, 60), z: 220, vz: -700, s0: 4, s1: 3, sx: 5, rot: Math.PI / 2, life: 0.32, col: c.c3, delay: _rnd(0, 0.25) });
    },
    W(c) { // Комбо стрела — три пронзающих штриха
      for (let i = 0; i < 3; i++) {
        fxP({ k: 'glow', x: (c.x + c.tx) / 2, y: (c.y + c.ty) / 2 - 16, s0: 30, s1: 18, sx: Math.hypot(c.tx - c.x, c.ty - c.y) / 22, rot: c.ang, life: 0.2, col: c.c1, delay: i * 0.09 });
        FXK.impact(c.tx, c.ty, c, 0.7, i);
      }
      if (c.adv) fxBolt(c.x, c.y - 16, c.tx, c.ty - 16, c.c3, { segs: 6 });
    },
    E(c) { // Прыжок — пыль и ветер
      fxSmoke(c.x, c.y, '#5a5040', { n: 6, sp: 70, a: 0.4 });
      FXK.dash(c.caster, c, c.m);
    },
    R(c) { // Скорость атаки — зелёная спираль
      FXK.aura(c.x, c.y, c, c.m);
      fxEmit(c.caster, 0.8, 0.03, (x, y, t) => {
        const a = t * 18;
        fxP({ k: 'dot', x: x + Math.cos(a) * 26, y: y + Math.sin(a) * 16, z: 6 + t * 60, s0: 6, s1: 1, life: 0.45, col: t % 0.2 < 0.1 ? c.c1 : c.c3 });
      });
    },
  },
  mage: {
    Q(c) { // Ледяной шар / Урон молнии — вспышка в руке
      fxGlow(c.x + Math.cos(c.ang) * 18, c.y - 22 + Math.sin(c.ang) * 18, 60 * c.m, c.c1, 0.25);
      fxBurst(c.x + Math.cos(c.ang) * 18, c.y - 22 + Math.sin(c.ang) * 18, { k: 'star', n: 8, col: ['#ffffff', c.c1], sp0: 40, sp1: 140, size: 10, life: 0.4, vr: 6 });
      if (c.adv) fxBolt(c.x, c.y - 22, c.tx, c.ty - 16, c.c1, { segs: 9, jit: 20, life: 0.25 });
    },
    W(c) { // Ледяная нова / Разряд
      fxRing(c.x, c.y, 10, 140 * c.m, c.c1, 0.55);
      fxRing(c.x, c.y, 10, 120 * c.m, '#ffffff', 0.45, { delay: 0.08, a: 0.7 });
      fxBurst(c.x, c.y - 10, { k: 'shard', n: Math.round(20 * c.m), col: ['#e8f8ff', c.c1], sp0: 220, sp1: 420, size: 16, life: 0.5, vr: 6 });
      fxBurst(c.x, c.y - 10, { k: 'star', n: 16, col: '#ffffff', sp0: 60, sp1: 260, size: 9, life: 0.7, vr: 4 });
      fxGlow(c.x, c.y - 10, 160 * c.m, c.c1, 0.35, { a: 0.6 });
      if (c.adv) for (let i = 0; i < 6; i++) { const a = i * 1.047 + Math.random(); fxBolt(c.x, c.y - 14, c.x + Math.cos(a) * 130, c.y + Math.sin(a) * 100, c.c1, { segs: 6, delay: i * 0.03 }); }
    },
    E(c) { // Барьер / Вспышка — рунный купол
      FXK.aura(c.x, c.y, c, c.m);
      fxP({ k: 'glow', layer: 'top', x: c.x, y: c.y - 26, s0: 70, s1: 90, life: 0.9, col: c.c1, a0: 0.45, fade: 'inout' });
      if (c.adv) { fxGlow(c.x, c.y - 20, 240, '#ffffff', 0.25); fxRing(c.x, c.y, 20, 220, c.c1, 0.5); }
    },
    R(c) { // Телепорт — схлопывание и вспышка на месте прибытия
      fxSwirl(c.x, c.y, [c.c1, c.c2, '#ffffff'], { in: true, n: 22, r: 70, life: 0.3 });
      fxGlow(c.x, c.y - 20, 90, c.c2, 0.3);
      const cs = c.caster;
      fxEmit(cs, 0.12, 0.2, () => {}, (x, y) => {
        fxGlow(x, y - 20, 120 * c.m, '#ffffff', 0.25);
        fxRing(x, y, 8, 80 * c.m, c.c1, 0.45);
        fxBurst(x, y - 20, { k: 'star', n: 14, col: [c.c1, '#ffffff'], sp0: 80, sp1: 240, size: 10, life: 0.5, vr: 5 });
      });
    },
  },
  warlock: {
    Q(c) { // Тёмное исцеление / Бабочки — огненный всплеск и целебные огоньки
      FXK.impact(c.x, c.y, c, c.m * 1.2);
      fxRing(c.x, c.y, 20, 150 * c.m, c.c1, 0.55);
      fxRise(c.x, c.y, [c.c3, '#ffffff'], { n: Math.round(22 * c.m), r: 34, k: 'star', size: 8, life: 1.1 });
      if (c.adv) fxEmit(c.caster, 1.2, 0.08, (x, y) => fxP({ k: 'star', x: x + _rnd(-60, 60), y: y + _rnd(-40, 40), z: _rnd(10, 50), vx: _rnd(-40, 40), vz: _rnd(-10, 30), s0: 10, s1: 4, rot: 0, vr: 10, life: 0.8, col: _rnd(0, 1) < 0.5 ? c.c2 : c.c3, fade: 'inout' }));
    },
    W(c) { // Оковы тьмы — пламенные путы сходятся к цели
      fxRune(c.tx, c.ty, 40, c.c1, 1.0, { vr: 3 });
      fxSwirl(c.tx, c.ty, [c.c1, c.c2], { in: true, n: 20, r: 80, life: 0.4, z: 10 });
      for (let i = 0; i < 4; i++) { const a = i * 1.57 + 0.4; fxBolt(c.tx + Math.cos(a) * 60, c.ty + Math.sin(a) * 45, c.tx, c.ty - 12, c.c1, { segs: 5, jit: 8, delay: 0.15 + i * 0.04, life: 0.3 }); }
    },
    E(c) { FXK.aura(c.x, c.y, c, c.m, c.c2); fxP({ k: 'ring', layer: 'top', x: c.x, y: c.y - 24, s0: 72, s1: 86, life: 0.9, col: c.c2, a0: 0.5, fade: 'inout' }); },
    R(c) { // Тёмная молитва / Исцеление — столп света и волна
      for (let i = 0; i < 26; i++) fxP({ k: 'glow', x: c.x + _rnd(-14, 14), y: c.y, z: _rnd(0, 20), vz: _rnd(200, 420), s0: 26, s1: 8, sx: 0.6, rot: Math.PI / 2, life: 0.6, col: i % 2 ? c.c2 : c.c1, delay: _rnd(0, 0.3) });
      fxGlow(c.x, c.y - 30, 200 * c.m, c.c2, 0.5, { a: 0.6 });
      fxRing(c.x, c.y, 20, 180 * c.m, c.c2, 0.6);
      fxRing(c.x, c.y, 20, 160 * c.m, c.c3, 0.6, { delay: 0.15, a: 0.7 });
      fxRise(c.x, c.y, [c.c3, '#ffffff', c.c2], { n: 30, r: 90, k: 'star', size: 9, life: 1.2 });
    },
  },
  runefighter: {
    Q(c) { // Сильный удар / Удар в череп — серия рубящих взмахов
      const n = c.adv ? 5 : 3;
      for (let i = 0; i < n; i++) {
        fxSlash(c.x + Math.cos(c.ang) * 26, c.y - 14 + Math.sin(c.ang) * 26, c.ang + (i % 2 ? 0.5 : -0.5), 44, i % 2 ? c.c2 : c.c1, 0.2, { delay: i * 0.1, flip: !!(i % 2) });
        fxBurst(c.tx, c.ty - 14, { n: 8, col: [c.c1, '#fff'], sp0: 120, sp1: 260, size: 5, life: 0.3, delay: i * 0.1 + 0.05 });
      }
    },
    W(c) { // Встряска / Сокрушение — удар оземь
      fxRing(c.x, c.y, 10, 150 * c.m, c.c1, 0.5);
      fxRing(c.x, c.y, 10, 120 * c.m, '#ffe6b0', 0.4, { delay: 0.1, a: 0.6 });
      fxRune(c.x, c.y, 60 * c.m, c.c1, 0.8, { vr: 0.5 });
      fxBurst(c.x, c.y, { k: 'shard', n: Math.round(16 * c.m), col: ['#7a6040', '#a08060', c.c1], sp0: 150, sp1: 320, size: 12, life: 0.6, vz: 220, az: -900, vr: 8 });
      fxSmoke(c.x, c.y, '#4a4030', { n: 8, sp: 120, a: 0.45 });
      fxGlow(c.x, c.y - 6, 150 * c.m, c.c1, 0.3, { a: 0.6 });
    },
    E(c) { FXK.aura(c.x, c.y, { ...c, c1: '#7aff7a' }, c.m); },
    R(c) { FXK.dash(c.caster, c, c.m, '#3a3020'); },
  },
  assassin: {
    Q(c) { // Шепот смерти / Смертоносность — крестовой разрез на цели
      fxSlash(c.tx, c.ty - 14, c.ang - 0.8, 40, c.c1, 0.22);
      fxSlash(c.tx, c.ty - 14, c.ang + 0.8, 40, c.c2, 0.22, { delay: 0.08, flip: true });
      FXK.impact(c.tx, c.ty, c, c.m);
      fxSmoke(c.tx, c.ty, '#1a1028', { n: 4 });
    },
    W(c) { // Буйство / Крик — шквал взмахов кругом
      for (let i = 0; i < 9; i++) fxSlash(c.x + _rnd(-30, 30), c.y - 14 + _rnd(-20, 20), Math.random() * 6.28, 36, i % 2 ? c.c1 : c.c2, 0.18, { delay: i * 0.035 });
      fxRing(c.x, c.y, 10, 120 * c.m, c.c1, 0.4);
      if (c.adv) { fxRing(c.x, c.y, 10, 250, c.c2, 0.6, { delay: 0.1 }); fxGlow(c.x, c.y - 20, 200, c.c1, 0.4, { a: 0.5 }); }
    },
    E(c) { // Пронзание / Убийца — красный прицел
      FXK.aura(c.x, c.y, { ...c, c1: '#ff4a6a' }, c.m);
      fxBurst(c.x, c.y - 30, { k: 'star', n: 10, col: ['#ff4a6a', '#ffffff'], sp0: 30, sp1: 120, size: 12, life: 0.6, vr: 6 });
    },
    R(c) { // Бегство / Прыжок за спину — тени
      fxSmoke(c.x, c.y, '#140a20', { n: 10, sp: 70, a: 0.65 });
      FXK.dash(c.caster, c, c.m, '#140a20');
    },
  },
};

function skillFx(type, key, adv, caster) {
  try {
    const r = SKILL_FX[type] && SKILL_FX[type][key];
    if (!r || !caster || caster.x == null) return;
    if (typeof _isPosVisible === 'function' && !_isPosVisible(caster.x, caster.y)) return;
    r(_fxCtx(type, caster, adv));
  } catch (e) { /* эффект — не повод ронять игру */ }
}

// ── удар, попадание, крит, смерть ──────────────────────────────────────────
// Замах: ближний бой — светящийся полумесяц перед персонажем, чередуя
// сторону; дальний — вспышка у руки.
function fxAttack(type, caster, alt) {
  try {
    if (!caster || (typeof _isPosVisible === 'function' && !_isPosVisible(caster.x, caster.y))) return;
    const pal = FX_PAL[type] || FX_PAL.lev;
    const cd = typeof CHAR_DEF !== 'undefined' && CHAR_DEF[type];
    const ang = _FACE_ANG[caster.facing] != null ? _FACE_ANG[caster.facing] : Math.PI / 2;
    const hx = caster.x + Math.cos(ang) * 24, hy = caster.y - 16 + Math.sin(ang) * 24;
    if (cd && cd.atkType === 'melee') {
      fxSlash(hx, hy, ang + (alt ? 0.35 : -0.35), 34, pal.c1, 0.2, { flip: !!alt, delay: 0.12 });
    } else {
      fxGlow(hx, hy - 4, 34, pal.c1, 0.18, { delay: 0.12 });
      fxBurst(hx, hy - 4, { n: 5, ang, spread: 0.5, col: pal.c3, sp0: 60, sp1: 150, size: 4, life: 0.25, delay: 0.12 });
    }
  } catch (e) { /* только вид */ }
}
function fxHit(x, y, isCrit, col) {
  if (typeof _isPosVisible === 'function' && !_isPosVisible(x, y)) return;
  const c = col || '#ffd9a0';
  fxBurst(x, y - 16, { n: isCrit ? 16 : 7, col: [c, '#ffffff'], sp0: 110, sp1: isCrit ? 360 : 240, size: isCrit ? 6 : 4.5, life: 0.32 });
  fxGlow(x, y - 16, isCrit ? 70 : 34, c, isCrit ? 0.26 : 0.16, { a: 0.8 });
  if (isCrit) {
    fxP({ k: 'star', x, y: y - 18, s0: 26, s1: 60, rot: Math.random(), vr: 3, life: 0.3, col: '#ffffff' });
    fxRing(x, y, 8, 54, '#ffe28a', 0.3, { layer: 'top' });
  }
}
function fxKill(x, y, col) {
  if (typeof _isPosVisible === 'function' && !_isPosVisible(x, y)) return;
  const c = col || '#ff8a4a';
  fxGlow(x, y - 16, 90, c, 0.3, { a: 0.7 });
  fxRing(x, y, 6, 60, c, 0.4);
  fxBurst(x, y - 16, { n: 18, col: [c, '#ffffff'], sp0: 90, sp1: 300, size: 6, life: 0.5 });
  fxRise(x, y, ['#ffffff', c], { n: 10, r: 18, size: 5, life: 0.9, spreadT: 0.2 });
  fxSmoke(x, y, '#20181a', { n: 4, a: 0.4 });
}
