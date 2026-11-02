// ── Помощники: внешность, эффекты, окно ─────────────────────────────────────
// Кто они и что дают — shared/definitions.js (HELPERS, helperBonusAt). Сервер
// хранит уровень, опыт и кто летает рядом (repos/helpers.js); здесь — только
// то, что видно.
//
// Картинок у помощников нет: каждый рисуется кодом, кадр за кадром, на свой
// маленький холст (helperDrawFrame). Один и тот же рисовальщик кормит и окно
// (анимированные карточки), и мир (холст становится текстурой PIXI, см.
// _updateHelperLayer в js/pixi-world.js). Чем выше редкость, тем больше
// слоёв: свечение, лучи за спиной, нимб или корона, шлейф, искры по орбите.
//
// Эффекты на хозяина (helperFxTick) — тоже по редкости: у обычного это
// мягкое кольцо под ногами и редкие искры, у легендарного — столп света,
// руны по кругу и луч от помощника к игроку на каждом «касте».

// ── надетый помощник ────────────────────────────────────────────────────────
// Помощник — предмет в слоте 'helper' (миграция 049): кто летает рядом, решает
// экипировка, а уровень едет в самой строке (hlLevel). Мир (pixi-world.js)
// спрашивает отсюда, кого рисовать у плеча.
let _hlpBusy = false;      // ждём ответ сервера — кнопки выключены
let _hlpRaf = 0;           // цикл анимации, пока на экране есть живой холст
let _hlpModal = null;      // { rowId } — помощник, чьё окно сейчас открыто

function _hlpTier(def) { return Math.max(0, HELPER_RARITIES.indexOf(def && def.rarity)); }
function helperActiveDef() {
  const it = typeof player !== 'undefined' && player && player.equipment && player.equipment.helper;
  return it ? helperById(it.id) : null;
}

// ── осколки в сумке ─────────────────────────────────────────────────────────
function _hlpShardCount(id) {
  if (!player || !Array.isArray(player.inventory)) return 0;
  return player.inventory.reduce((s, it) => s + (it && it.id === id ? (it.qty || 1) : 0), 0);
}
function _hlpShardTotal() { return UNIQUE_SHARDS.reduce((s, sh) => s + _hlpShardCount(sh.id), 0); }
function _hlpShardMin() { return Math.min(...UNIQUE_SHARDS.map(sh => _hlpShardCount(sh.id))); }

// ═════════════════════════════════════════════════════════════════════════════
//  РИСОВАЛЬЩИК
// ═════════════════════════════════════════════════════════════════════════════
// Всё рисуется в сетке 128×128 с центром в нуле; масштаб под размер холста
// ставится один раз в начале кадра. t — секунды.

function _hlpRgba(hex, a) {
  const h = String(hex || '#ffffff').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function _hlpHex(hex) { return parseInt(String(hex || '#ffffff').replace('#', ''), 16); }

// Псевдослучайное по зерну — чтобы искры стояли на своих местах от кадра к
// кадру, а не прыгали.
function _hlpRnd(seed) { const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }

function _hlpStar(ctx, x, y, r, rot, points = 4, inner = 0.38) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const rr = i % 2 ? r * inner : r;
    const a = rot + (i * Math.PI) / points;
    const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
    if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
  }
  ctx.closePath();
}

function _hlpEyes(ctx, x, y, gap, r, t, opts = {}) {
  // Моргание раз в несколько секунд — у каждого помощника в свой момент.
  const ph = (t + (opts.seed || 0)) % 3.7;
  const open = ph < 0.12 ? Math.abs(ph - 0.06) / 0.06 : 1;
  for (const s of [-1, 1]) {
    const ex = x + s * gap;
    ctx.fillStyle = opts.color || '#1b1430';
    ctx.beginPath();
    ctx.ellipse(ex, y, r * 0.9, Math.max(0.4, r * 1.15 * open), 0, 0, Math.PI * 2);
    ctx.fill();
    if (open > 0.5) {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(ex - r * 0.3, y - r * 0.4, r * 0.38, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(ex + r * 0.3, y + r * 0.35, r * 0.18, 0, Math.PI * 2); ctx.fill();
    }
  }
  if (opts.blush !== false) {
    ctx.fillStyle = 'rgba(255,120,150,0.35)';
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.ellipse(x + s * (gap + r * 1.4), y + r * 1.5, r * 0.9, r * 0.5, 0, 0, Math.PI * 2); ctx.fill(); }
  }
}

// ── свечение и то, что за спиной ────────────────────────────────────────────
function _hlpBackGlow(ctx, L, t, tier) {
  const pulse = 0.85 + 0.15 * Math.sin(t * 3);
  const R = (34 + tier * 7) * pulse;
  const g = ctx.createRadialGradient(0, 0, 2, 0, 0, R);
  g.addColorStop(0, _hlpRgba(L.glow, 0.55 + tier * 0.06));
  g.addColorStop(0.45, _hlpRgba(L.glow, 0.18 + tier * 0.04));
  g.addColorStop(1, _hlpRgba(L.glow, 0));
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(0, 0, R, 0, Math.PI * 2); ctx.fill();

  // Эпические и легендарные — вращающиеся лучи за спиной.
  if (tier >= 3) {
    const rays = tier >= 4 ? 12 : 8;
    ctx.save();
    ctx.rotate(t * (tier >= 4 ? 0.5 : 0.35));
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < rays; i++) {
      ctx.rotate((Math.PI * 2) / rays);
      const len = 54 + (tier >= 4 ? 8 : 0) + Math.sin(t * 2 + i) * 4;
      const rg = ctx.createLinearGradient(0, 0, 0, -len);
      rg.addColorStop(0, _hlpRgba(L.glow, 0.32));
      rg.addColorStop(1, _hlpRgba(L.glow, 0));
      ctx.fillStyle = rg;
      ctx.beginPath(); ctx.moveTo(-3.5, 0); ctx.lineTo(0, -len); ctx.lineTo(3.5, 0); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }
  // Легендарные — ещё кольцо рун, медленно идущее по кругу.
  if (tier >= 4) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.rotate(-t * 0.6);
    ctx.strokeStyle = _hlpRgba(L.glow, 0.55);
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(0, 0, 46, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([3, 5]);
    ctx.beginPath(); ctx.arc(0, 0, 51, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      ctx.fillStyle = _hlpRgba(L.c1, 0.9);
      _hlpStar(ctx, Math.cos(a) * 46, Math.sin(a) * 46, 3.2, a + t, 4, 0.35);
      ctx.fill();
    }
    ctx.restore();
  }
}

// Искры по орбите: сзади рисуется половина, что дальше от глаза, спереди —
// ближняя. Так они и правда облетают помощника.
function _hlpOrbit(ctx, L, t, tier, front) {
  if (tier < 1) return;
  const n = [0, 3, 4, 6, 8][tier];
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < n; i++) {
    const a = t * (1.2 + (i % 3) * 0.25) + (i / n) * Math.PI * 2;
    const z = Math.sin(a);
    if ((z > 0) !== front) continue;
    const rx = 30 + (i % 2) * 6, ry = 9 + (i % 3) * 2;
    const x = Math.cos(a) * rx, y = z * ry + 4 + Math.sin(t * 2 + i) * 2;
    const s = (1.6 + tier * 0.35) * (front ? 1.15 : 0.8);
    const g = ctx.createRadialGradient(x, y, 0, x, y, s * 3);
    g.addColorStop(0, _hlpRgba('#ffffff', 0.95));
    g.addColorStop(0.35, _hlpRgba(L.glow, 0.8));
    g.addColorStop(1, _hlpRgba(L.glow, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, s * 3, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

// Мерцающие звёздочки вокруг (с редкого).
function _hlpTwinkles(ctx, L, t, tier) {
  if (tier < 2) return;
  const n = tier * 3;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < n; i++) {
    const life = (t * 0.7 + _hlpRnd(i)) % 1;
    const a = _hlpRnd(i + 10) * Math.PI * 2, r = 22 + _hlpRnd(i + 20) * 30;
    const x = Math.cos(a) * r, y = Math.sin(a) * r * 0.8 - life * 8;
    const al = Math.sin(life * Math.PI);
    ctx.fillStyle = _hlpRgba(i % 2 ? '#ffffff' : L.c1, al * 0.95);
    _hlpStar(ctx, x, y, 2 + al * 2.2, life * 2, 4, 0.3);
    ctx.fill();
  }
  ctx.restore();
}

// ── крылья ──────────────────────────────────────────────────────────────────
function _hlpWings(ctx, L, t, tier) {
  const w = L.wings;
  if (!w || w === 'none') return;
  const fast = (w === 'bug' || w === 'moth' || w === 'fairy' || w === 'leaf');
  const flap = Math.sin(t * (fast ? 16 : 5.5));
  for (const s of [-1, 1]) {
    ctx.save();
    ctx.scale(s, 1);
    if (w === 'bug') {
      ctx.rotate(-0.5 - flap * 0.35);
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.strokeStyle = _hlpRgba(L.glow, 0.8);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.ellipse(12, -6, 12, 6.5, -0.3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(9, 3, 8, 4.5, 0.4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    } else if (w === 'leaf') {
      ctx.rotate(-0.35 - flap * 0.3);
      for (const [ox, oy, sz, rot] of [[12, -8, 13, -0.5], [10, 4, 9, 0.35]]) {
        ctx.save(); ctx.translate(ox, oy); ctx.rotate(rot);
        const g = ctx.createLinearGradient(-sz, 0, sz, 0);
        g.addColorStop(0, L.c2); g.addColorStop(1, L.c1);
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.moveTo(-sz, 0);
        ctx.quadraticCurveTo(0, -sz * 0.7, sz, 0); ctx.quadraticCurveTo(0, sz * 0.7, -sz, 0); ctx.fill();
        ctx.strokeStyle = 'rgba(30,80,30,0.5)'; ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.moveTo(-sz, 0); ctx.lineTo(sz, 0); ctx.stroke();
        ctx.restore();
      }
    } else if (w === 'moth') {
      ctx.rotate(-0.2 - flap * 0.25);
      const g = ctx.createRadialGradient(14, -6, 2, 14, -6, 22);
      g.addColorStop(0, L.c1); g.addColorStop(0.7, L.c2); g.addColorStop(1, _hlpRgba(L.c2, 0.6));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(4, -2);
      ctx.bezierCurveTo(10, -26, 34, -24, 30, -6); ctx.bezierCurveTo(28, 0, 14, 2, 4, -2); ctx.fill();
      ctx.beginPath(); ctx.moveTo(4, 2);
      ctx.bezierCurveTo(14, 4, 26, 10, 18, 20); ctx.bezierCurveTo(12, 24, 6, 14, 4, 2); ctx.fill();
      ctx.fillStyle = _hlpRgba('#ffffff', 0.85);
      ctx.beginPath(); ctx.arc(20, -12, 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = _hlpRgba(L.glow, 0.9);
      ctx.beginPath(); ctx.arc(20, -12, 1.8, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(14, 12, 2, 0, Math.PI * 2); ctx.fill();
    } else if (w === 'fairy') {
      ctx.rotate(-0.25 - flap * 0.22);
      ctx.globalCompositeOperation = 'lighter';
      for (const [len, wid, rot, oy] of [[30, 11, -0.55, -4], [20, 8, 0.45, 4]]) {
        ctx.save(); ctx.translate(4, oy); ctx.rotate(rot);
        const g = ctx.createLinearGradient(0, 0, len, 0);
        g.addColorStop(0, _hlpRgba(L.glow, 0.75)); g.addColorStop(0.6, _hlpRgba(L.c1, 0.35)); g.addColorStop(1, _hlpRgba(L.glow, 0.05));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.moveTo(0, 0);
        ctx.bezierCurveTo(len * 0.3, -wid, len * 0.9, -wid * 0.9, len, 0);
        ctx.bezierCurveTo(len * 0.8, wid * 0.6, len * 0.3, wid * 0.5, 0, 0); ctx.fill();
        ctx.strokeStyle = _hlpRgba('#ffffff', 0.45); ctx.lineWidth = 0.7;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(len * 0.5, -wid * 0.3, len * 0.92, -1); ctx.stroke();
        ctx.restore();
      }
    } else if (w === 'flame') {
      ctx.rotate(-0.3 - flap * 0.3);
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 6; i++) {
        const a = -1.1 + i * 0.32, len = 22 + (5 - Math.abs(i - 2)) * 3 + Math.sin(t * 13 + i * 2) * 3;
        ctx.save(); ctx.translate(5, 0); ctx.rotate(a);
        const g = ctx.createLinearGradient(0, 0, len, 0);
        g.addColorStop(0, '#fff6c0'); g.addColorStop(0.35, L.glow); g.addColorStop(1, _hlpRgba(L.c2, 0));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.moveTo(0, -3);
        ctx.quadraticCurveTo(len * 0.6, -6, len, 0); ctx.quadraticCurveTo(len * 0.6, 5, 0, 3); ctx.fill();
        ctx.restore();
      }
    } else if (w === 'shadow') {
      ctx.rotate(-0.15 - flap * 0.2);
      for (let i = 0; i < 4; i++) {
        const a = -0.9 + i * 0.45, len = 30 - i * 2;
        const wv = Math.sin(t * 4 + i) * 5;
        ctx.save(); ctx.translate(6, 0); ctx.rotate(a);
        const g = ctx.createLinearGradient(0, 0, len, 0);
        g.addColorStop(0, _hlpRgba('#1a0630', 0.95)); g.addColorStop(0.6, _hlpRgba(L.c2, 0.8)); g.addColorStop(1, _hlpRgba(L.glow, 0));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.moveTo(0, -4);
        ctx.bezierCurveTo(len * 0.4, -8 + wv, len * 0.7, 4 - wv, len, wv * 0.6);
        ctx.bezierCurveTo(len * 0.6, 6 + wv, len * 0.3, 6, 0, 4); ctx.fill();
        ctx.restore();
      }
    } else if (w === 'dragon') {
      ctx.translate(6, -4);
      ctx.rotate(-0.25 - flap * 0.35);
      const tipX = 36, tipY = -20;
      const g = ctx.createLinearGradient(0, -20, 30, 10);
      g.addColorStop(0, _hlpRgba(L.c2, 0.95)); g.addColorStop(1, _hlpRgba('#5a1010', 0.9));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(tipX, tipY);
      ctx.quadraticCurveTo(30, -6, 32, 2); ctx.quadraticCurveTo(24, -2, 22, 8);
      ctx.quadraticCurveTo(15, 2, 12, 10); ctx.quadraticCurveTo(6, 4, 0, 6); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = _hlpRgba(L.c1, 0.9); ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(tipX, tipY); ctx.stroke();
      ctx.lineWidth = 0.8;
      for (const [x, y] of [[32, 2], [22, 8], [12, 10]]) { ctx.beginPath(); ctx.moveTo(tipX * 0.55, tipY * 0.55); ctx.lineTo(x, y); ctx.stroke(); }
      ctx.fillStyle = L.c1;
      ctx.beginPath(); ctx.arc(tipX, tipY, 1.6, 0, Math.PI * 2); ctx.fill();
    } else if (w === 'angel') {
      ctx.translate(5, -2);
      ctx.rotate(-0.2 - flap * 0.18);
      for (let row = 0; row < 3; row++) {
        const n = 7 - row * 2;
        for (let i = 0; i < n; i++) {
          const a = -1.25 + i * (1.5 / n) + row * 0.15;
          const len = (36 - row * 9) - Math.abs(i - n * 0.3) * 1.2;
          ctx.save(); ctx.rotate(a);
          const g = ctx.createLinearGradient(0, 0, len, 0);
          g.addColorStop(0, row === 0 ? '#ffffff' : L.c1); g.addColorStop(1, row === 2 ? L.c2 : _hlpRgba(L.glow, 0.9));
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.ellipse(len / 2, 0, len / 2, 3.4 - row * 0.4, 0, 0, Math.PI * 2); ctx.fill();
          ctx.restore();
        }
      }
    } else if (w === 'tails') {
      // Хвосты кицунэ: веер за спиной, у каждого светлый кончик.
      // Угол — поворот оси хвоста от «вниз»: −2.9 смотрит почти вверх,
      // −1.75 — вбок. Хвосты расходятся веером и покачиваются вразнобой.
      for (let i = 0; i < 4; i++) {
        const a = -2.85 + i * 0.36 + Math.sin(t * 2.4 + i * 0.8) * 0.1;
        ctx.save(); ctx.translate(2, 8); ctx.rotate(a);
        const len = 36 - Math.abs(i - 1.5) * 2;
        const g = ctx.createLinearGradient(0, 0, 0, len);
        g.addColorStop(0, L.c2); g.addColorStop(0.55, _hlpRgba(L.glow, 0.95)); g.addColorStop(0.85, '#ffe6f6'); g.addColorStop(1, '#ffffff');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.moveTo(-4, 0);
        ctx.bezierCurveTo(-13, len * 0.4, -9, len * 0.85, 0, len);
        ctx.bezierCurveTo(9, len * 0.85, 13, len * 0.4, 4, 0); ctx.fill();
        ctx.strokeStyle = _hlpRgba('#ffffff', 0.35); ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.moveTo(0, 2); ctx.quadraticCurveTo(-4, len * 0.5, 0, len * 0.92); ctx.stroke();
        ctx.restore();
      }
    }
    ctx.restore();
  }
}

// ── тела ────────────────────────────────────────────────────────────────────
function _hlpSphere(ctx, r, c1, c2, alpha = 1) {
  const g = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r);
  g.addColorStop(0, _hlpRgba(c1, alpha)); g.addColorStop(1, _hlpRgba(c2, alpha));
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
}
function _hlpShine(ctx, x, y, r) {
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.beginPath(); ctx.ellipse(x, y, r, r * 0.6, -0.6, 0, Math.PI * 2); ctx.fill();
}

function _hlpBody(ctx, def, t, tier) {
  const L0 = def.look;
  if (L0.body === 'drake') return _hlpDrake(ctx, def, t, tier);
  if (L0.body === 'succubus') return _hlpHumanoid(ctx, def, t, tier, 'succubus');
  if (L0.body === 'sprite') return _hlpHumanoid(ctx, def, t, tier, 'fairy');
  if (L0.body === 'imp') return _hlpImp(ctx, def, t, tier);
  const L = def.look, seed = def.id.length;
  const r = 13 + tier * 1.2;
  switch (L.body) {
    case 'orb': {
      _hlpSphere(ctx, r, L.c1, L.c2);
      _hlpShine(ctx, -r * 0.4, -r * 0.45, r * 0.3);
      _hlpEyes(ctx, 0, 1, r * 0.36, r * 0.16, t, { seed });
      // Светлячку — светящееся брюшко.
      if (def.id === 'hl_firefly') {
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = _hlpRgba(L.glow, 0.5 + 0.4 * Math.sin(t * 5));
        ctx.beginPath(); ctx.arc(0, r * 0.75, r * 0.45, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      }
      break;
    }
    case 'seed': {
      const g = ctx.createRadialGradient(-4, -2, 1, 0, 2, r * 1.2);
      g.addColorStop(0, L.c1); g.addColorStop(1, L.c2);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(0, -r * 1.05);
      ctx.bezierCurveTo(r * 1.1, -r * 0.3, r * 0.95, r, 0, r);
      ctx.bezierCurveTo(-r * 0.95, r, -r * 1.1, -r * 0.3, 0, -r * 1.05); ctx.fill();
      const sw = Math.sin(t * 3) * 0.2;
      for (const s of [-1, 1]) {
        ctx.save(); ctx.translate(0, -r * 1.02); ctx.rotate(s * (0.7 + sw));
        ctx.fillStyle = s < 0 ? L.c1 : L.glow;
        ctx.beginPath(); ctx.ellipse(0, -5, 3, 6, 0, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
      _hlpShine(ctx, -r * 0.35, -r * 0.2, r * 0.22);
      _hlpEyes(ctx, 0, r * 0.15, r * 0.36, r * 0.16, t, { seed });
      break;
    }
    case 'stone': {
      const pts = [[-1, -0.55], [-0.35, -1], [0.45, -0.9], [1, -0.3], [0.85, 0.6], [0.15, 1], [-0.75, 0.8], [-1.05, 0.1]];
      const g = ctx.createLinearGradient(-r, -r, r, r);
      g.addColorStop(0, L.c1); g.addColorStop(1, L.c2);
      ctx.fillStyle = g;
      ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * r, y * r) : ctx.moveTo(x * r, y * r))); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(60,50,40,0.45)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(-0.35 * r, -r); ctx.lineTo(-0.1 * r, -0.2 * r); ctx.lineTo(0.85 * r, 0.6 * r); ctx.stroke();
      ctx.fillStyle = 'rgba(120,190,90,0.7)';
      ctx.beginPath(); ctx.ellipse(0.1 * r, -0.92 * r, r * 0.4, r * 0.14, 0.1, 0, Math.PI * 2); ctx.fill();
      _hlpEyes(ctx, 0, r * 0.15, r * 0.36, r * 0.15, t, { seed });
      break;
    }
    case 'wisp': {
      // Завиток-хвост вниз, сам дух — светлая капля.
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 5; i++) {
        const k = i / 5, wv = Math.sin(t * 4 - i) * 4 * k;
        ctx.fillStyle = _hlpRgba(L.glow, 0.35 * (1 - k));
        ctx.beginPath(); ctx.arc(wv, r * 0.6 + i * 4.5, r * (0.8 - k * 0.6), 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
      _hlpSphere(ctx, r, L.c1, L.c2, 0.92);
      if (def.id === 'hl_storm') {
        ctx.strokeStyle = _hlpRgba('#ffffff', 0.5 + 0.5 * Math.abs(Math.sin(t * 9)));
        ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(-r * 0.2, -r * 0.9); ctx.lineTo(r * 0.15, -r * 0.35); ctx.lineTo(-r * 0.1, -r * 0.3); ctx.lineTo(r * 0.25, r * 0.1); ctx.stroke();
      }
      _hlpShine(ctx, -r * 0.4, -r * 0.45, r * 0.28);
      _hlpEyes(ctx, 0, r * 0.1, r * 0.36, r * 0.16, t, { seed });
      break;
    }
    case 'bubble': {
      const g = ctx.createRadialGradient(0, 0, r * 0.4, 0, 0, r);
      g.addColorStop(0, _hlpRgba(L.c1, 0.15)); g.addColorStop(0.85, _hlpRgba(L.glow, 0.35)); g.addColorStop(1, _hlpRgba(L.c2, 0.85));
      ctx.fillStyle = g;
      const wob = Math.sin(t * 4) * 0.06;
      ctx.beginPath(); ctx.ellipse(0, 0, r * (1 + wob), r * (1 - wob), 0, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = _hlpRgba('#ffffff', 0.6); ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.arc(0, 0, r * 0.98, -2.6, -1.2); ctx.stroke();
      _hlpShine(ctx, -r * 0.45, -r * 0.5, r * 0.25);
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.beginPath(); ctx.arc(r * 0.5, r * 0.45, r * 0.08, 0, Math.PI * 2); ctx.fill();
      _hlpEyes(ctx, 0, r * 0.1, r * 0.34, r * 0.15, t, { seed, color: '#123a5a' });
      break;
    }
    case 'flame': {
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      const layers = [[1.25, L.c2, 0.75], [0.95, L.glow, 0.85], [0.6, L.c1, 0.95]];
      for (const [sc, col, al] of layers) {
        const f = Math.sin(t * 11 + sc * 5) * 2;
        ctx.fillStyle = _hlpRgba(col, al);
        ctx.beginPath(); ctx.moveTo(0, -r * 1.5 * sc + f);
        ctx.bezierCurveTo(r * 0.7 * sc, -r * 0.6 * sc, r * sc, r * 0.5 * sc, 0, r * 0.9 * sc);
        ctx.bezierCurveTo(-r * sc, r * 0.5 * sc, -r * 0.7 * sc, -r * 0.6 * sc, 0, -r * 1.5 * sc + f); ctx.fill();
      }
      ctx.restore();
      _hlpEyes(ctx, 0, r * 0.1, r * 0.34, r * 0.15, t, { seed, color: '#3a1205' });
      break;
    }
    case 'coin': {
      const spin = Math.cos(t * 2.6);
      const sx = Math.max(0.18, Math.abs(spin));
      ctx.save(); ctx.scale(sx, 1);
      const g = ctx.createLinearGradient(-r, -r, r, r);
      g.addColorStop(0, L.c1); g.addColorStop(0.5, L.glow); g.addColorStop(1, L.c2);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = _hlpRgba('#8a6510', 0.8); ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(0, 0, r * 0.8, 0, Math.PI * 2); ctx.stroke();
      if (spin < 0) { ctx.fillStyle = _hlpRgba('#8a6510', 0.85); _hlpStar(ctx, 0, 0, r * 0.5, -Math.PI / 2, 5, 0.45); ctx.fill(); }
      ctx.restore();
      if (spin >= 0 && sx > 0.55) _hlpEyes(ctx, 0, 0, r * 0.34 * sx, r * 0.15, t, { seed, color: '#5a3b05' });
      _hlpShine(ctx, -r * 0.35 * sx, -r * 0.5, r * 0.22 * sx);
      break;
    }
    case 'crystal': {
      ctx.save();
      const rot = Math.sin(t * 1.5) * 0.25;
      const pts = [[0, -1.35], [0.8, -0.35], [0.55, 0.9], [0, 1.25], [-0.55, 0.9], [-0.8, -0.35]];
      const faces = [[0, 1, 3], [1, 2, 3], [0, 3, 5], [5, 3, 4]];
      const shade = [L.c1, L.c2, L.glow, _hlpRgba(L.c2, 0.85)];
      faces.forEach((f, i) => {
        ctx.fillStyle = shade[(i + Math.floor(t * 2)) % 4];
        ctx.beginPath(); f.forEach((pi, j) => {
          const [x, y] = pts[pi]; const px = x * r * (1 + rot * (x > 0 ? 1 : -1) * 0.3), py = y * r;
          if (j) ctx.lineTo(px, py); else ctx.moveTo(px, py);
        }); ctx.closePath(); ctx.fill();
      });
      ctx.strokeStyle = _hlpRgba('#ffffff', 0.7); ctx.lineWidth = 0.8;
      ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * r, y * r) : ctx.moveTo(x * r, y * r))); ctx.closePath(); ctx.stroke();
      ctx.restore();
      _hlpEyes(ctx, 0, r * 0.05, r * 0.3, r * 0.14, t, { seed, color: '#0b3a2c' });
      break;
    }
    case 'fairy': {
      // Маленькая фея: платье, голова, волосы, ручки с искрой.
      const skin = '#ffe7d6';
      const sway = Math.sin(t * 2.5) * 1.5;
      const g = ctx.createLinearGradient(0, -2, 0, r * 1.2);
      g.addColorStop(0, L.c1); g.addColorStop(1, L.c2);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(-3, 0);
      ctx.quadraticCurveTo(-r * 0.9, r * 0.9, -r * 0.8 + sway, r * 1.25);
      ctx.quadraticCurveTo(0, r * 1.1, r * 0.8 + sway, r * 1.25);
      ctx.quadraticCurveTo(r * 0.9, r * 0.9, 3, 0); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = skin; ctx.lineWidth = 2; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-3, 3); ctx.lineTo(-9, 9 + sway); ctx.moveTo(3, 3); ctx.lineTo(9, -1 - sway); ctx.stroke();
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = _hlpRgba(L.glow, 0.9);
      _hlpStar(ctx, 10, -3 - sway, 3.5 + Math.sin(t * 8), t * 3, 4, 0.3); ctx.fill();
      ctx.restore();
      ctx.fillStyle = skin;
      ctx.beginPath(); ctx.arc(0, -r * 0.55, r * 0.55, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = L.c2;
      ctx.beginPath(); ctx.arc(0, -r * 0.7, r * 0.6, Math.PI * 1.05, Math.PI * 1.95); ctx.fill();
      ctx.beginPath(); ctx.ellipse(-r * 0.5, -r * 0.4, r * 0.2, r * 0.45, 0.3, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(r * 0.5, -r * 0.4, r * 0.2, r * 0.45, -0.3, 0, Math.PI * 2); ctx.fill();
      _hlpEyes(ctx, 0, -r * 0.48, r * 0.22, r * 0.1, t, { seed, color: '#2a1a40' });
      break;
    }
    case 'bird': {
      // Феникс: длинный огненный хвост, тело, голова с хохолком.
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 3; i++) {
        const wv = Math.sin(t * 3 + i) * 5;
        const g = ctx.createLinearGradient(0, 4, 0, 40);
        g.addColorStop(0, _hlpRgba(L.glow, 0.9)); g.addColorStop(1, _hlpRgba(L.c2, 0));
        ctx.strokeStyle = g; ctx.lineWidth = 4 - i; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(0, 6); ctx.bezierCurveTo((i - 1) * 8, 18, (i - 1) * 6 + wv, 28, (i - 1) * 12 + wv, 40); ctx.stroke();
      }
      ctx.restore();
      const g = ctx.createRadialGradient(-3, -2, 1, 0, 2, r);
      g.addColorStop(0, L.c1); g.addColorStop(1, L.c2);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(0, 3, r * 0.75, r * 0.9, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(0, -r * 0.65, r * 0.55, 0, Math.PI * 2); ctx.fill();
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      for (let i = -1; i <= 1; i++) {
        ctx.fillStyle = _hlpRgba(i ? L.glow : '#fff2b0', 0.95);
        ctx.beginPath(); ctx.moveTo(i * 3, -r * 1.05);
        ctx.quadraticCurveTo(i * 7, -r * 1.6 + Math.sin(t * 10 + i) * 2, i * 4 + 1, -r * 1.85); ctx.quadraticCurveTo(i * 2, -r * 1.4, i * 3 - 2, -r * 1.05); ctx.fill();
      }
      ctx.restore();
      ctx.fillStyle = '#ffcf40';
      ctx.beginPath(); ctx.moveTo(-2.5, -r * 0.5); ctx.lineTo(0, -r * 0.2); ctx.lineTo(2.5, -r * 0.5); ctx.closePath(); ctx.fill();
      _hlpEyes(ctx, 0, -r * 0.75, r * 0.26, r * 0.11, t, { seed, blush: false, color: '#3a0e02' });
      break;
    }
    case 'eye': {
      // Дух бездны: тёмная сфера, большой глаз и луны вокруг.
      _hlpSphere(ctx, r, '#3a1260', '#0d0318');
      ctx.strokeStyle = _hlpRgba(L.glow, 0.8); ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
      const ph = (t + 1.3) % 4.2, lid = ph < 0.16 ? Math.abs(ph - 0.08) / 0.08 : 1;
      ctx.fillStyle = L.c1;
      ctx.beginPath(); ctx.ellipse(0, 0, r * 0.7, r * 0.45 * lid, 0, 0, Math.PI * 2); ctx.fill();
      if (lid > 0.3) {
        const lx = Math.sin(t * 0.9) * r * 0.2;
        const ig = ctx.createRadialGradient(lx, 0, 0, lx, 0, r * 0.32);
        ig.addColorStop(0, '#ffffff'); ig.addColorStop(0.3, L.glow); ig.addColorStop(1, L.c2);
        ctx.fillStyle = ig;
        ctx.beginPath(); ctx.arc(lx, 0, r * 0.32 * Math.min(1, lid * 1.2), 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#05000a';
        ctx.beginPath(); ctx.ellipse(lx, 0, r * 0.06, r * 0.24 * lid, 0, 0, Math.PI * 2); ctx.fill();
      }
      break;
    }
    case 'dragon': {
      // Хвост, тело, светлое брюшко, голова с рогами, звезда на лбу.
      const tw = Math.sin(t * 2.5) * 6;
      ctx.strokeStyle = L.c2; ctx.lineWidth = 5; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(0, r * 0.7); ctx.bezierCurveTo(8, r * 1.4, -6 + tw, r * 1.8, 6 + tw, r * 2.2); ctx.stroke();
      ctx.fillStyle = L.glow;
      _hlpStar(ctx, 6 + tw, r * 2.25, 3.5, t, 4, 0.4); ctx.fill();
      const g = ctx.createRadialGradient(-3, -2, 1, 0, 2, r * 1.1);
      g.addColorStop(0, '#ff8a5a'); g.addColorStop(1, L.c2);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(0, r * 0.25, r * 0.7, r * 0.8, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = L.c1;
      ctx.beginPath(); ctx.ellipse(0, r * 0.4, r * 0.4, r * 0.55, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#f2b14a';
      for (const s of [-1, 1]) {
        ctx.beginPath(); ctx.moveTo(s * r * 0.35, -r * 1.05); ctx.quadraticCurveTo(s * r * 0.8, -r * 1.6, s * r * 0.75, -r * 1.75);
        ctx.quadraticCurveTo(s * r * 0.55, -r * 1.3, s * r * 0.12, -r * 1.0); ctx.fill();
      }
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(0, -r * 0.6, r * 0.7, r * 0.58, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ff9a70';
      ctx.beginPath(); ctx.ellipse(0, -r * 0.35, r * 0.42, r * 0.28, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#5a1608';
      ctx.beginPath(); ctx.arc(-r * 0.13, -r * 0.33, 0.9, 0, Math.PI * 2); ctx.arc(r * 0.13, -r * 0.33, 0.9, 0, Math.PI * 2); ctx.fill();
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = _hlpRgba('#ffffff', 0.7 + 0.3 * Math.sin(t * 6));
      _hlpStar(ctx, 0, -r * 1.02, 3, t * 1.5, 4, 0.35); ctx.fill();
      ctx.restore();
      _hlpEyes(ctx, 0, -r * 0.72, r * 0.3, r * 0.13, t, { seed, color: '#2a0800' });
      break;
    }
    case 'fox': {
      // Мордочка кицунэ: уши с розовыми кончиками, знак на лбу, улыбка.
      ctx.fillStyle = L.c1;
      for (const s of [-1, 1]) {
        ctx.save(); ctx.rotate(s * (0.15 + Math.sin(t * 3) * 0.05));
        ctx.beginPath(); ctx.moveTo(s * r * 0.25, -r * 0.6); ctx.lineTo(s * r * 0.85, -r * 1.45); ctx.lineTo(s * r * 0.95, -r * 0.35); ctx.closePath(); ctx.fill();
        ctx.fillStyle = L.c2;
        ctx.beginPath(); ctx.moveTo(s * r * 0.5, -r * 0.65); ctx.lineTo(s * r * 0.82, -r * 1.25); ctx.lineTo(s * r * 0.85, -r * 0.55); ctx.closePath(); ctx.fill();
        ctx.fillStyle = L.c1;
        ctx.restore();
      }
      const g = ctx.createRadialGradient(-3, -4, 1, 0, 0, r * 1.1);
      g.addColorStop(0, '#ffffff'); g.addColorStop(1, L.c1);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(-r, -r * 0.35);
      ctx.quadraticCurveTo(-r * 0.9, r * 0.5, 0, r * 0.95);
      ctx.quadraticCurveTo(r * 0.9, r * 0.5, r, -r * 0.35);
      ctx.quadraticCurveTo(0, -r * 1.05, -r, -r * 0.35); ctx.fill();
      ctx.fillStyle = L.c2;
      for (const s of [-1, 1]) { ctx.beginPath(); ctx.ellipse(s * r * 0.62, r * 0.1, r * 0.2, r * 0.08, s * 0.4, 0, Math.PI * 2); ctx.fill(); }
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = _hlpRgba(L.glow, 0.85 + 0.15 * Math.sin(t * 4));
      ctx.beginPath(); ctx.ellipse(0, -r * 0.62, r * 0.1, r * 0.22, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.strokeStyle = '#3a0a2a'; ctx.lineWidth = 1.5; ctx.lineCap = 'round';
      for (const s of [-1, 1]) { ctx.beginPath(); ctx.arc(s * r * 0.35, -r * 0.08, r * 0.17, Math.PI * 1.1, Math.PI * 1.9); ctx.stroke(); }
      ctx.fillStyle = '#3a0a2a';
      ctx.beginPath(); ctx.ellipse(0, r * 0.42, r * 0.1, r * 0.07, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,120,170,0.4)';
      for (const s of [-1, 1]) { ctx.beginPath(); ctx.ellipse(s * r * 0.5, r * 0.25, r * 0.16, r * 0.09, 0, 0, Math.PI * 2); ctx.fill(); }
      break;
    }
    default:
      _hlpSphere(ctx, r, L.c1, L.c2);
      _hlpEyes(ctx, 0, 1, r * 0.36, r * 0.16, t, { seed });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  СУЩЕСТВА: дракон, суккуба, фея, бесёнок
// ═════════════════════════════════════════════════════════════════════════════
// Крупные фигуры во весь кадр, с обводкой — читаются и на значке 24 px.
// Крылья рисуются здесь же (L.wings у них 'none'), потому что дальнее крыло
// должно лечь ЗА тело, а ближнее — перед ним.

// Смешать два цвета (#rrggbb) — 0 = a, 1 = b.
function _hlpMix(a, b, k) {
  const x = _hlpHex(a), y = _hlpHex(b);
  const ch = (v, sh) => (v >> sh) & 255;
  const m = sh => Math.round(ch(x, sh) + (ch(y, sh) - ch(x, sh)) * k);
  return '#' + [m(16), m(8), m(0)].map(v => v.toString(16).padStart(2, '0')).join('');
}
const _HLP_INK = 'rgba(20,10,30,0.55)';   // обводка

// Перепончатое крыло: начало — плечо, тянется вправо (зеркалят scale(-1,1)).
// flap −1..1 — взмах. cMem — перепонка, cBone — «пальцы».
function _hlpBatWing(ctx, span, h, cMem, cBone, flap, alpha = 1) {
  ctx.save();
  ctx.rotate(-0.3 - flap * 0.5);
  const el = [span * 0.42, -h * 0.82];
  const tips = [[span, -h * 0.95], [span * 0.95, -h * 0.05], [span * 0.68, h * 0.42], [span * 0.36, h * 0.5]];
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(el[0], el[1]); ctx.lineTo(tips[0][0], tips[0][1]);
  for (let i = 1; i < tips.length; i++) {
    const a = tips[i - 1], b = tips[i];
    ctx.quadraticCurveTo((a[0] + b[0]) / 2 * 0.62 + el[0] * 0.38, (a[1] + b[1]) / 2 * 0.62 + el[1] * 0.38, b[0], b[1]);
  }
  ctx.quadraticCurveTo(span * 0.12, h * 0.42, 0, h * 0.12);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, -h, span * 0.8, h * 0.5);
  g.addColorStop(0, _hlpRgba(_hlpMix(cMem, '#ffffff', 0.15), 0.92 * alpha)); g.addColorStop(1, _hlpRgba(cMem, 0.78 * alpha));
  ctx.fillStyle = g; ctx.fill();
  ctx.strokeStyle = _hlpRgba(cBone, 0.7 * alpha); ctx.lineWidth = 0.9; ctx.stroke();
  ctx.strokeStyle = _hlpRgba(cBone, alpha); ctx.lineCap = 'round';
  ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(el[0], el[1]); ctx.stroke();
  ctx.lineWidth = 0.9;
  for (const tp of tips) { ctx.beginPath(); ctx.moveTo(el[0], el[1]); ctx.lineTo(tp[0], tp[1]); ctx.stroke(); }
  ctx.fillStyle = _hlpRgba('#f4eadf', alpha);
  ctx.beginPath(); ctx.moveTo(el[0] - 1, el[1]); ctx.lineTo(el[0] + 1, el[1] - 4); ctx.lineTo(el[0] + 2, el[1] + 0.5); ctx.fill();
  ctx.restore();
}

// Крылья феи: две пары прозрачных, с прожилками и светлой каймой.
function _hlpFairyWings(ctx, L, t, big = 1) {
  const flap = Math.sin(t * 14);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const s of [-1, 1]) {
    ctx.save(); ctx.scale(s, 1); ctx.translate(2, -2);
    ctx.rotate(-0.1 - flap * 0.18);
    for (const [len, wid, rot] of [[30 * big, 15 * big, -0.75], [22 * big, 10 * big, 0.55]]) {
      ctx.save(); ctx.rotate(rot);
      const g = ctx.createLinearGradient(0, 0, len, 0);
      g.addColorStop(0, _hlpRgba(L.glow, 0.7)); g.addColorStop(0.55, _hlpRgba(L.wing || L.c1, 0.45)); g.addColorStop(1, _hlpRgba(L.glow, 0.15));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(0, 0);
      ctx.bezierCurveTo(len * 0.2, -wid, len * 0.95, -wid * 1.05, len, -wid * 0.1);
      ctx.bezierCurveTo(len * 0.95, wid * 0.55, len * 0.35, wid * 0.6, 0, 0); ctx.fill();
      ctx.strokeStyle = _hlpRgba('#ffffff', 0.6); ctx.lineWidth = 0.8; ctx.stroke();
      ctx.strokeStyle = _hlpRgba('#ffffff', 0.35); ctx.lineWidth = 0.6;
      for (const k of [0.35, 0.6, 0.85]) {
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(len * k * 0.6, -wid * 0.45, len * k, -wid * (0.75 - k * 0.5)); ctx.stroke();
      }
      ctx.fillStyle = _hlpRgba('#ffffff', 0.6);
      ctx.beginPath(); ctx.arc(len * 0.62, -wid * 0.35, 1.6 * big, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }
  ctx.restore();
}

// Глаза существ в аниме-манере: высокий овал радужки с бликами и чёрточка
// ресниц сверху. Моргают раз в несколько секунд.
function _hlpAlmondEyes(ctx, x, y, gap, w, h, iris, t, seed, opts = {}) {
  const ph = (t + seed) % 4.1;
  const open = ph < 0.14 ? Math.abs(ph - 0.07) / 0.07 : 1;
  for (const s of [-1, 1]) {
    const ex = x + s * gap;
    ctx.save(); ctx.translate(ex, y);
    if (open < 0.35) {
      ctx.strokeStyle = '#2a1424'; ctx.lineWidth = 0.9; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-w * 0.7, 0); ctx.quadraticCurveTo(0, h * 0.5, w * 0.7, 0); ctx.stroke();
      ctx.restore(); continue;
    }
    const rw = w * 0.62, rh = h * 1.05;
    const ig = ctx.createLinearGradient(0, -rh, 0, rh);
    ig.addColorStop(0, _hlpMix(iris, '#000000', 0.45)); ig.addColorStop(0.55, iris); ig.addColorStop(1, _hlpMix(iris, '#ffffff', opts.glowIris ? 0.7 : 0.45));
    ctx.fillStyle = ig;
    ctx.beginPath(); ctx.ellipse(0, 0, rw, rh, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = opts.slit ? '#120408' : _hlpMix(iris, '#000000', 0.7);
    ctx.beginPath(); opts.slit ? ctx.ellipse(0, 0, rw * 0.22, rh * 0.75, 0, 0, Math.PI * 2) : ctx.ellipse(0, -rh * 0.1, rw * 0.42, rh * 0.45, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(-rw * 0.35, -rh * 0.45, rw * 0.42, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(rw * 0.35, rh * 0.45, rw * 0.2, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#2a1424'; ctx.lineWidth = 0.9; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-rw * 1.25, -rh * 0.55); ctx.quadraticCurveTo(0, -rh * 1.45, rw * 1.3, -rh * 0.7); ctx.stroke();
    if (opts.lashes) {
      ctx.lineWidth = 0.7;
      ctx.beginPath(); ctx.moveTo(s * rw * 1.2, -rh * 0.65); ctx.lineTo(s * rw * 1.75, -rh * 1.1); ctx.stroke();
    }
    ctx.restore();
  }
}

// ── летающий дракон (вид в три четверти, мордой вправо) ─────────────────────
function _hlpDrake(ctx, def, t, tier) {
  const L = def.look, seed = def.id.length;
  const k = 0.8 + tier * 0.045;
  ctx.save(); ctx.translate(-4, 3); ctx.scale(k, k);
  const flap = Math.sin(t * 5.5);
  const body = L.c2, belly = L.c1, dark = _hlpMix(L.c2, '#000000', 0.45), horn = L.horn || '#f1e3c4';
  const memb = L.memb || _hlpMix(L.c2, L.glow, 0.35);
  const bone = _hlpMix(L.c2, '#000000', 0.2);
  // крылья — оба за телом, растут из спины: дальнее темнее и выше
  ctx.save(); ctx.translate(4, -6); ctx.scale(-1, 1); ctx.rotate(0.75);
  _hlpBatWing(ctx, 34, 26, _hlpMix(memb, '#000000', 0.35), bone, flap, 0.95);
  ctx.restore();
  ctx.save(); ctx.translate(-3, -4); ctx.scale(-1, 1); ctx.rotate(0.3);
  _hlpBatWing(ctx, 40, 30, memb, bone, Math.sin(t * 5.5 + 0.25), 1);
  ctx.restore();
  // хвост
  const tw = Math.sin(t * 2.2) * 4;
  ctx.strokeStyle = dark; ctx.lineCap = 'round'; ctx.lineWidth = 9.5;
  const tail = () => { ctx.beginPath(); ctx.moveTo(-6, 10); ctx.bezierCurveTo(-18, 22, -30, 20 + tw, -33, 8 + tw); };
  tail(); ctx.stroke();
  ctx.strokeStyle = body; ctx.lineWidth = 7.5; tail(); ctx.stroke();
  ctx.save(); ctx.translate(-33, 8 + tw); ctx.rotate(-1.3 + tw * 0.03);
  ctx.fillStyle = L.tip || dark;
  ctx.beginPath(); ctx.moveTo(0, -2); ctx.lineTo(-6, -10); ctx.lineTo(4, -7); ctx.lineTo(8, -14); ctx.lineTo(5, 0); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = _HLP_INK; ctx.lineWidth = 0.8; ctx.stroke();
  ctx.restore();
  // задняя лапа
  ctx.fillStyle = dark;
  ctx.beginPath(); ctx.ellipse(-7, 13, 5, 7, 0.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = horn;
  for (const cx of [-10, -7.5, -5]) { ctx.beginPath(); ctx.moveTo(cx, 18); ctx.lineTo(cx - 1, 21.5); ctx.lineTo(cx + 1, 18.5); ctx.fill(); }
  // тело
  const bg = ctx.createRadialGradient(-2, -2, 2, 0, 4, 18);
  bg.addColorStop(0, _hlpMix(body, '#ffffff', 0.25)); bg.addColorStop(1, body);
  ctx.fillStyle = bg;
  ctx.beginPath(); ctx.ellipse(0, 5, 14, 11, -0.35, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = _HLP_INK; ctx.lineWidth = 1.1; ctx.stroke();
  // брюхо пластинами
  ctx.save();
  ctx.beginPath(); ctx.ellipse(4, 8, 8, 8.5, -0.5, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = belly; ctx.fillRect(-6, -4, 22, 24);
  ctx.strokeStyle = _hlpMix(belly, '#000000', 0.25); ctx.lineWidth = 0.8;
  for (let i = 0; i < 6; i++) { ctx.beginPath(); ctx.moveTo(-6, i * 3.4 - 1); ctx.lineTo(16, i * 3.4 - 6); ctx.stroke(); }
  ctx.restore();
  // шея
  ctx.fillStyle = body;
  ctx.beginPath(); ctx.moveTo(4, -4); ctx.quadraticCurveTo(8, -14, 15, -18); ctx.lineTo(20, -12); ctx.quadraticCurveTo(14, -6, 12, 2); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = _HLP_INK; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = belly;
  ctx.beginPath(); ctx.moveTo(12, 1); ctx.quadraticCurveTo(14, -7, 19, -12); ctx.lineTo(20, -11); ctx.quadraticCurveTo(16, -5, 13.5, 3); ctx.closePath(); ctx.fill();
  // шипы по хребту
  ctx.fillStyle = L.spike || horn;
  const ridge = [[13, -19, -0.6], [8, -13, -0.9], [3, -7, -1.2], [-4, -4, -1.6], [-11, 0, -2.0], [-19, 12, -2.5], [-26, 17 + tw * 0.6, -2.9]];
  for (const [x, y, a] of ridge) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(a);
    ctx.beginPath(); ctx.moveTo(-2.2, 0); ctx.lineTo(0, -4.5); ctx.lineTo(2.2, 0); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  // передняя лапа
  ctx.fillStyle = body;
  ctx.beginPath(); ctx.ellipse(9, 13, 3.6, 6, -0.3, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = _HLP_INK; ctx.lineWidth = 0.9; ctx.stroke();
  ctx.fillStyle = horn;
  for (const cx of [8, 10.5, 13]) { ctx.beginPath(); ctx.moveTo(cx, 18); ctx.lineTo(cx + 0.6, 21.5); ctx.lineTo(cx + 1.6, 18); ctx.fill(); }
  // голова
  ctx.save(); ctx.translate(19, -19); ctx.rotate(0.08 + Math.sin(t * 1.7) * 0.05);
  // рога
  ctx.fillStyle = horn;
  for (const [ox, len, a] of [[-5, 14, -2.45], [-1, 11, -2.2]]) {
    ctx.save(); ctx.translate(ox, -4); ctx.rotate(a);
    ctx.beginPath(); ctx.moveTo(0, -2.2); ctx.quadraticCurveTo(len * 0.6, -3, len, 1.5); ctx.quadraticCurveTo(len * 0.55, 0.5, 0, 2.2); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = _HLP_INK; ctx.lineWidth = 0.8; ctx.stroke();
    ctx.restore();
  }
  const hg = ctx.createRadialGradient(-2, -3, 1, 2, 0, 13);
  hg.addColorStop(0, _hlpMix(body, '#ffffff', 0.3)); hg.addColorStop(1, body);
  ctx.fillStyle = hg;
  ctx.beginPath();
  ctx.moveTo(-8, -1); ctx.quadraticCurveTo(-7, -9, 1, -8.5); ctx.quadraticCurveTo(7, -8, 14, -4);
  ctx.quadraticCurveTo(16, -2, 15, 1); ctx.lineTo(8, 4); ctx.quadraticCurveTo(-2, 8, -8, -1); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = _HLP_INK; ctx.lineWidth = 1.1; ctx.stroke();
  // челюсть
  const jaw = (L.breath && tier >= 3) ? Math.max(0, Math.sin(t * 1.3)) * 2.5 : 0;
  ctx.fillStyle = _hlpMix(body, belly, 0.5);
  ctx.beginPath(); ctx.moveTo(-3, 3); ctx.quadraticCurveTo(5, 5 + jaw, 13, 2 + jaw); ctx.lineTo(8, 4); ctx.quadraticCurveTo(2, 6, -3, 3); ctx.fill();
  ctx.strokeStyle = _HLP_INK; ctx.lineWidth = 0.9;
  ctx.beginPath(); ctx.moveTo(-1, 3.5); ctx.quadraticCurveTo(6, 3.5 + jaw * 0.5, 14, 1 + jaw); ctx.stroke();
  // ноздря, бровь, гребень
  ctx.fillStyle = dark; ctx.beginPath(); ctx.ellipse(12.5, -3.2, 1.1, 0.7, 0.4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = L.spike || horn;
  ctx.beginPath(); ctx.moveTo(-8, 1); ctx.lineTo(-12, 3); ctx.lineTo(-8, -2); ctx.fill();
  // глаз
  ctx.save(); ctx.translate(1.5, -3.5);
  const ph = (t + seed) % 4.3, open = ph < 0.14 ? Math.abs(ph - 0.07) / 0.07 : 1;
  ctx.scale(1, Math.max(0.15, open));
  ctx.fillStyle = L.eye || '#ffd23a';
  ctx.beginPath(); ctx.ellipse(0, 0, 3.4, 2.4, 0.15, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#1a0606'; ctx.beginPath(); ctx.ellipse(0.4, 0, 0.75, 2.1, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(-1.1, -0.9, 0.8, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
  ctx.strokeStyle = dark; ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.moveTo(-2.5, -6.5); ctx.quadraticCurveTo(1.5, -8.2, 5, -6.2); ctx.stroke();
  // корона
  if (L.crown) _hlpCrown(ctx, L, t, -2, -9, 0.8);
  // дыхание огнём (эпик+)
  if (jaw > 0.6) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    const fl = jaw / 2.5;
    for (let i = 0; i < 4; i++) {
      const x = 16 + i * 5 * fl, y = 2 + jaw + Math.sin(t * 20 + i) * 1.2, r = (2.2 + i * 1.4) * fl;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, '#fffbe0'); g.addColorStop(0.4, L.glow); g.addColorStop(1, _hlpRgba(L.glow, 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  ctx.restore();
  // молнии у грозового
  if (L.bolts) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    const on = (t * 1.6) % 1 < 0.18;
    if (on) {
      ctx.strokeStyle = _hlpRgba('#e8eaff', 0.95); ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(-22, -26); ctx.lineTo(-17, -18); ctx.lineTo(-21, -16); ctx.lineTo(-14, -6); ctx.stroke();
    }
    ctx.restore();
  }
  ctx.restore();
}

// Корона в любом месте (дракон, суккуба).
function _hlpCrown(ctx, L, t, x, y, k = 1) {
  ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
  const g = ctx.createLinearGradient(0, -9, 0, 0);
  g.addColorStop(0, '#fff6c2'); g.addColorStop(1, '#d9a021');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.moveTo(-7, 0); ctx.lineTo(-8, -7); ctx.lineTo(-4, -4); ctx.lineTo(0, -10);
  ctx.lineTo(4, -4); ctx.lineTo(8, -7); ctx.lineTo(7, 0); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(90,50,0,0.6)'; ctx.lineWidth = 0.8; ctx.stroke();
  ctx.fillStyle = L.gem || L.c2;
  ctx.beginPath(); ctx.arc(0, -3, 1.6, 0, Math.PI * 2); ctx.fill();
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = _hlpRgba('#ffffff', 0.5 + 0.5 * Math.sin(t * 5));
  _hlpStar(ctx, 0, -10, 2.2, t, 4, 0.3); ctx.fill();
  ctx.restore();
  ctx.restore();
}

// ── человекоподобные: суккуба и фея ─────────────────────────────────────────
// Общая фигура «в три головы»: ноги, платье, руки, голова, волосы. Различаются
// крыльями, рогами, хвостом и тем, что в руке.
function _hlpHumanoid(ctx, def, t, tier, kind) {
  const L = def.look, seed = def.id.length;
  const k = 0.86 + tier * 0.05;
  ctx.save(); ctx.scale(k, k); ctx.translate(0, -2);
  const skin = L.skin || '#ffe1cf', skinD = _hlpMix(skin, '#7a3a3a', 0.25);
  const hair = L.hair || L.c2, hairD = _hlpMix(hair, '#000000', 0.18);
  const dress = L.dress || L.c2, dressL = _hlpMix(dress, '#ffffff', 0.3), dressD = _hlpMix(dress, '#000000', 0.35);
  const sway = Math.sin(t * 2.3 + seed) * 1.6;
  const succ = kind === 'succubus';

  // крылья (за всем)
  if (succ) {
    const flap = Math.sin(t * 3.2 + seed);
    for (const s of [-1, 1]) {
      ctx.save(); ctx.scale(s, 1); ctx.translate(5, -6); ctx.rotate(0.15);
      _hlpBatWing(ctx, 30, 24, L.wing || _hlpMix(dress, '#000000', 0.15), L.wingBone || _hlpMix(L.wing || dress, '#000000', 0.3), flap * 0.8, 0.97);
      ctx.restore();
    }
  } else if (L.angel) {
    ctx.save(); ctx.scale(1.02, 1.02); ctx.translate(0, -6);
    _hlpWings(ctx, { ...L, wings: 'angel' }, t, tier);
    ctx.restore();
  } else {
    _hlpFairyWings(ctx, L, t + seed, 1 + tier * 0.06);
  }
  // волосы сзади
  const hairBack = () => {
    const len = succ ? 10 : 0;
    ctx.beginPath(); ctx.moveTo(-8, -20);
    ctx.quadraticCurveTo(-12 + sway * 0.4, -8, -9 + sway, -2 + len);
    ctx.quadraticCurveTo(0, 1 + len, 9 + sway, -2 + len);
    ctx.quadraticCurveTo(12 + sway * 0.4, -8, 8, -20); ctx.closePath();
  };
  ctx.fillStyle = hairD; hairBack(); ctx.fill();
  // хвост суккубы
  if (succ) {
    const tw = Math.sin(t * 2.6 + seed) * 5;
    ctx.strokeStyle = L.tail || hairD; ctx.lineWidth = 1.8; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(2, 14); ctx.bezierCurveTo(14, 22, 24, 18 + tw, 22 + tw * 0.3, 6 + tw); ctx.stroke();
    ctx.save(); ctx.translate(22 + tw * 0.3, 6 + tw); ctx.rotate(-0.4);
    ctx.fillStyle = L.tail || hairD;
    ctx.beginPath(); ctx.moveTo(0, 1);
    ctx.bezierCurveTo(-5, -2, -3, -7, 0, -4); ctx.bezierCurveTo(3, -7, 5, -2, 0, 1); ctx.fill();
    ctx.restore();
  }
  // ноги
  for (const s of [-1, 1]) {
    const dx = s * 3.2, dy = Math.sin(t * 2 + s) * 0.8;
    ctx.strokeStyle = skinD; ctx.lineWidth = 3.6; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(dx, 14); ctx.lineTo(dx + s * 1.2, 27 + dy); ctx.stroke();
    ctx.strokeStyle = skin; ctx.lineWidth = 2.8;
    ctx.beginPath(); ctx.moveTo(dx, 14); ctx.lineTo(dx + s * 1.2, 27 + dy); ctx.stroke();
    ctx.fillStyle = succ ? (L.boots || '#2a1030') : dressD;
    ctx.beginPath(); ctx.ellipse(dx + s * 1.6, 28 + dy, 2.4, 1.6, s * 0.3, 0, Math.PI * 2); ctx.fill();
    if (succ) { ctx.fillRect(dx + s * 1.2 - 1.6, 22 + dy, 3.2, 6); }
  }
  // платье
  const dg = ctx.createLinearGradient(0, -8, 0, 20);
  dg.addColorStop(0, dressL); dg.addColorStop(1, dress);
  ctx.fillStyle = dg;
  ctx.beginPath();
  ctx.moveTo(-5.5, -8); ctx.quadraticCurveTo(-4, 2, -3.6, 4);
  if (succ) {
    ctx.lineTo(-9 + sway * 0.3, 15); ctx.quadraticCurveTo(0, 18, 9 + sway * 0.3, 15);
  } else {
    // лепестки
    const n = 5;
    ctx.lineTo(-11 + sway * 0.4, 16);
    for (let i = 0; i < n; i++) {
      const x0 = -11 + (22 / n) * i + sway * 0.4, x1 = x0 + 22 / n;
      ctx.quadraticCurveTo((x0 + x1) / 2, 21 + (i % 2) * 2, x1, 16);
    }
  }
  ctx.lineTo(3.6, 4); ctx.quadraticCurveTo(4, 2, 5.5, -8); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = _HLP_INK; ctx.lineWidth = 0.9; ctx.stroke();
  // пояс / корсет
  ctx.fillStyle = succ ? (L.trim || '#1a0a22') : _hlpMix(dress, L.glow, 0.5);
  ctx.beginPath(); ctx.moveTo(-4.2, 0); ctx.lineTo(4.2, 0); ctx.lineTo(3.8, 4); ctx.lineTo(-3.8, 4); ctx.closePath(); ctx.fill();
  if (succ) {
    ctx.strokeStyle = _hlpRgba(L.glow, 0.9); ctx.lineWidth = 0.6;
    ctx.beginPath(); ctx.moveTo(-2, 0.6); ctx.lineTo(2, 3.4); ctx.moveTo(2, 0.6); ctx.lineTo(-2, 3.4); ctx.stroke();
  }
  // руки
  ctx.strokeStyle = skin; ctx.lineWidth = 2.4; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-5.5, -6.5); ctx.quadraticCurveTo(-9, -1, -6 + sway * 0.2, 3); ctx.stroke(); // на бедре
  const hx = 11, hy = -9 + Math.sin(t * 2.6) * 1.5;
  ctx.beginPath(); ctx.moveTo(5.5, -6.5); ctx.quadraticCurveTo(9, -6, hx, hy); ctx.stroke();
  // в руке: фея — палочка со звездой, суккуба — сгусток пламени
  ctx.save(); ctx.globalCompositeOperation = 'lighter';
  if (succ) {
    const r = 3.4 + Math.sin(t * 6) * 0.6;
    const g = ctx.createRadialGradient(hx + 1, hy - 3, 0, hx + 1, hy - 3, r * 2.2);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.35, L.glow); g.addColorStop(1, _hlpRgba(L.glow, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(hx + 1, hy - 3, r * 2.2, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.restore(); ctx.save();
    ctx.strokeStyle = L.wand || '#f6e3a0'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(hx, hy + 1); ctx.lineTo(hx + 4, hy - 8); ctx.stroke();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = _hlpRgba(L.glow, 0.95);
    _hlpStar(ctx, hx + 4.3, hy - 9.5, 3.6 + Math.sin(t * 8) * 0.8, t * 2, 5, 0.42); ctx.fill();
  }
  ctx.restore();
  // голова
  const headY = -16;
  ctx.fillStyle = skin;
  ctx.beginPath(); ctx.ellipse(0, headY, 7.8, 8.4, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = _HLP_INK; ctx.lineWidth = 0.9; ctx.stroke();
  // уши (у феи — острые)
  if (!succ) {
    ctx.fillStyle = skin;
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.moveTo(s * 7, headY - 1); ctx.lineTo(s * 12, headY - 5); ctx.lineTo(s * 7.2, headY + 2.5); ctx.fill(); }
  }
  // лицо
  _hlpAlmondEyes(ctx, 0, headY + 0.6, 3.2, 2.4, 1.9, L.eye || '#6a4ad8', t, seed, { lashes: true, glowIris: succ });
  ctx.fillStyle = 'rgba(255,110,140,0.35)';
  for (const s of [-1, 1]) { ctx.beginPath(); ctx.ellipse(s * 4.6, headY + 3.6, 1.7, 0.9, 0, 0, Math.PI * 2); ctx.fill(); }
  ctx.strokeStyle = succ ? '#9a1a40' : '#b04a5a'; ctx.lineWidth = 0.9;
  ctx.beginPath(); ctx.arc(0.3, headY + 4.4, 1.6, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
  // чёлка и пряди
  const hg = ctx.createLinearGradient(0, headY - 10, 0, headY + 2);
  hg.addColorStop(0, _hlpMix(hair, '#ffffff', 0.25)); hg.addColorStop(1, hair);
  ctx.fillStyle = hg;
  ctx.beginPath();
  ctx.moveTo(-8.6, headY + 3);
  ctx.quadraticCurveTo(-10, headY - 10, 0, headY - 9.8);
  ctx.quadraticCurveTo(10, headY - 10, 8.6, headY + 3);
  ctx.quadraticCurveTo(7, headY - 3, 4, headY - 3.6);
  ctx.quadraticCurveTo(2.5, headY - 1.5, 0.5, headY - 3.8);
  ctx.quadraticCurveTo(-2, headY - 1.2, -4, headY - 3.6);
  ctx.quadraticCurveTo(-7, headY - 3, -8.6, headY + 3); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = _HLP_INK; ctx.lineWidth = 0.8; ctx.stroke();
  // пряди по бокам
  ctx.fillStyle = hair;
  for (const s of [-1, 1]) {
    ctx.beginPath(); ctx.moveTo(s * 8.4, headY);
    ctx.quadraticCurveTo(s * (10 + sway * 0.2), headY + 8, s * 7 + sway * 0.3, headY + 13);
    ctx.quadraticCurveTo(s * 7.5, headY + 6, s * 6.6, headY + 1); ctx.fill();
  }
  ctx.fillStyle = _hlpRgba('#ffffff', 0.35);
  ctx.beginPath(); ctx.ellipse(-3.5, headY - 7, 3, 1, -0.3, 0, Math.PI * 2); ctx.fill();
  // рога суккубы
  if (succ) {
    const hc = L.hornC || '#2a1426';
    for (const s of [-1, 1]) {
      ctx.save(); ctx.scale(s, 1);
      const g = ctx.createLinearGradient(4, headY - 8, 10, headY - 20);
      g.addColorStop(0, hc); g.addColorStop(1, _hlpMix(hc, L.glow, 0.6));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(3.5, headY - 7.5);
      ctx.bezierCurveTo(5, headY - 15, 11, headY - 15, 11.5, headY - 21);
      ctx.bezierCurveTo(9.5, headY - 15, 8, headY - 10, 7.2, headY - 6.4); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = _HLP_INK; ctx.lineWidth = 0.7; ctx.stroke();
      ctx.restore();
    }
  } else if (L.flower) {
    ctx.fillStyle = L.flower;
    for (let i = 0; i < 5; i++) {
      const a = i / 5 * Math.PI * 2;
      ctx.beginPath(); ctx.arc(-6 + Math.cos(a) * 1.8, headY - 7 + Math.sin(a) * 1.8, 1.4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = '#ffe680'; ctx.beginPath(); ctx.arc(-6, headY - 7, 1, 0, Math.PI * 2); ctx.fill();
  }
  if (L.crown) _hlpCrown(ctx, L, t, 0, headY - 8.5, 0.75);
  else if (L.tiara) {
    ctx.fillStyle = '#fff2b8';
    ctx.beginPath(); ctx.moveTo(-5, headY - 8); ctx.lineTo(-2, headY - 12); ctx.lineTo(0, headY - 9.5); ctx.lineTo(2, headY - 12); ctx.lineTo(5, headY - 8); ctx.quadraticCurveTo(0, headY - 9.5, -5, headY - 8); ctx.fill();
    ctx.fillStyle = L.gem || L.glow; ctx.beginPath(); ctx.arc(0, headY - 10.2, 1.1, 0, Math.PI * 2); ctx.fill();
  }
  if (L.halo) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = _hlpRgba('#fff3a0', 0.95); ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.ellipse(0, headY - 13 + Math.sin(t * 2) * 1, 8, 2.4, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

// ── бесёнок ─────────────────────────────────────────────────────────────────
function _hlpImp(ctx, def, t, tier) {
  const L = def.look, seed = def.id.length;
  const k = 0.95 + tier * 0.05;
  ctx.save(); ctx.scale(k, k);
  const body = L.c2, belly = L.c1, dark = _hlpMix(L.c2, '#000000', 0.45);
  const flap = Math.sin(t * 7 + seed);
  for (const s of [-1, 1]) {
    ctx.save(); ctx.scale(s, 1); ctx.translate(7, -2);
    _hlpBatWing(ctx, 22, 17, _hlpMix(body, '#000000', 0.2), _hlpMix(body, '#000000', 0.35), flap, 0.95);
    ctx.restore();
  }
  // хвост
  const tw = Math.sin(t * 3 + seed) * 4;
  ctx.strokeStyle = dark; ctx.lineWidth = 2; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-4, 12); ctx.bezierCurveTo(-14, 18, -20, 10 + tw, -18, 2 + tw); ctx.stroke();
  ctx.fillStyle = dark;
  ctx.save(); ctx.translate(-18, 2 + tw); ctx.rotate(-0.5);
  ctx.beginPath(); ctx.moveTo(0, 2); ctx.lineTo(-3.5, -1); ctx.lineTo(0, -6); ctx.lineTo(3.5, -1); ctx.closePath(); ctx.fill();
  ctx.restore();
  // ножки
  ctx.fillStyle = dark;
  for (const s of [-1, 1]) { ctx.beginPath(); ctx.ellipse(s * 5, 16 + Math.sin(t * 4 + s) * 0.8, 3.2, 4, 0, 0, Math.PI * 2); ctx.fill(); }
  // тело-груша
  const g = ctx.createRadialGradient(-3, -4, 2, 0, 2, 18);
  g.addColorStop(0, _hlpMix(body, '#ffffff', 0.35)); g.addColorStop(1, body);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.ellipse(0, 3, 12, 13, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = _HLP_INK; ctx.lineWidth = 1.1; ctx.stroke();
  ctx.fillStyle = belly;
  ctx.beginPath(); ctx.ellipse(0, 8, 7, 6.5, 0, 0, Math.PI * 2); ctx.fill();
  // трезубец
  const fy = Math.sin(t * 2.5) * 1.5;
  ctx.strokeStyle = '#3a2a2a'; ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.moveTo(14, 16 + fy); ctx.lineTo(19, -14 + fy); ctx.stroke();
  ctx.strokeStyle = L.fork || '#ffd36a'; ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(15.5, -13 + fy); ctx.quadraticCurveTo(19, -10 + fy, 22.5, -14 + fy);
  ctx.moveTo(15.5, -13 + fy); ctx.lineTo(14.5, -18 + fy);
  ctx.moveTo(19.2, -12 + fy); ctx.lineTo(19.4, -19 + fy);
  ctx.moveTo(22.5, -14 + fy); ctx.lineTo(23.5, -18.5 + fy); ctx.stroke();
  ctx.strokeStyle = body; ctx.lineWidth = 3; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(9, 2); ctx.lineTo(15.5, 3 + fy); ctx.stroke();
  // уши и рожки
  ctx.fillStyle = body;
  for (const s of [-1, 1]) { ctx.beginPath(); ctx.moveTo(s * 9, -5); ctx.lineTo(s * 17, -10); ctx.lineTo(s * 10, -1); ctx.fill(); }
  ctx.fillStyle = L.horn || '#f2e6cc';
  for (const s of [-1, 1]) {
    ctx.beginPath(); ctx.moveTo(s * 3, -9); ctx.quadraticCurveTo(s * 5, -16, s * 8, -17); ctx.quadraticCurveTo(s * 6, -13, s * 6.5, -8); ctx.fill();
  }
  // пламя на голове у огненного
  if (L.flameHair) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (let i = -1; i <= 1; i++) {
      const h = 9 + Math.sin(t * 9 + i * 2) * 2.5;
      const fg = ctx.createLinearGradient(0, -9, 0, -9 - h);
      fg.addColorStop(0, L.glow); fg.addColorStop(1, _hlpRgba('#fff2a0', 0));
      ctx.fillStyle = fg;
      ctx.beginPath(); ctx.moveTo(i * 3 - 2.5, -8); ctx.quadraticCurveTo(i * 3, -9 - h, i * 3 + 2.5, -8); ctx.fill();
    }
    ctx.restore();
  }
  // лицо
  _hlpAlmondEyes(ctx, 0, -2, 4, 2.6, 2, L.eye || '#ffe24a', t, seed, { glowIris: true, slit: true });
  ctx.fillStyle = '#3a0a10';
  ctx.beginPath(); ctx.moveTo(-5, 3); ctx.quadraticCurveTo(0, 8.5, 5, 3); ctx.quadraticCurveTo(0, 5, -5, 3); ctx.fill();
  ctx.fillStyle = '#ffffff';
  for (const s of [-1, 1]) { ctx.beginPath(); ctx.moveTo(s * 3.2, 3.6); ctx.lineTo(s * 2.4, 5.6); ctx.lineTo(s * 1.6, 3.9); ctx.fill(); }
  ctx.restore();
}

// Нимб и корона — над головой.
function _hlpHeadwear(ctx, L, t, tier, headY) {
  if (L.halo) {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    const y = headY - 6 + Math.sin(t * 2) * 1.2;
    ctx.strokeStyle = _hlpRgba('#fff3a0', 0.95); ctx.lineWidth = 2.2;
    ctx.shadowColor = '#ffe680'; ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.ellipse(0, y, 10, 3, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  } else if (L.crown) {
    const y = headY - 2;
    const g = ctx.createLinearGradient(0, y - 9, 0, y);
    g.addColorStop(0, '#fff6c2'); g.addColorStop(1, '#d9a021');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(-7, y); ctx.lineTo(-8, y - 7); ctx.lineTo(-4, y - 4); ctx.lineTo(0, y - 10);
    ctx.lineTo(4, y - 4); ctx.lineTo(8, y - 7); ctx.lineTo(7, y); ctx.closePath(); ctx.fill();
    ctx.fillStyle = L.c2;
    ctx.beginPath(); ctx.arc(0, y - 3, 1.5, 0, Math.PI * 2); ctx.fill();
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = _hlpRgba('#ffffff', 0.5 + 0.5 * Math.sin(t * 5));
    _hlpStar(ctx, 0, y - 10, 2.2, t, 4, 0.3); ctx.fill();
    ctx.restore();
  }
}

// Новые существа рисуют корону и нимб сами — голова у них не в центре.
const _HLP_OWN_HEADWEAR = new Set(['drake', 'succubus', 'sprite', 'imp']);
const _HLP_HEAD_Y = { fairy: -16, bird: -18, dragon: -22, fox: -20, seed: -20 };

// opts.dim — силуэт ещё не открытого (тёмный и без эффектов).
function helperDrawFrame(ctx, def, t, size, opts = {}) {
  if (!def) return;
  const L = def.look, tier = _hlpTier(def);
  ctx.save();
  ctx.clearRect(0, 0, size, size);
  ctx.translate(size / 2, size / 2);
  ctx.scale(size / 128, size / 128);
  const bob = Math.sin(t * 2.2 + def.id.length) * 3;
  if (opts.dim) {
    ctx.filter = 'grayscale(1) brightness(0.35)';
    ctx.translate(0, bob);
    ctx.scale(1.15, 1.15);
    _hlpWings(ctx, L, t * 0.3, tier);
    _hlpBody(ctx, def, t * 0.3, tier);
    ctx.filter = 'none';
    ctx.restore();
    return;
  }
  _hlpBackGlow(ctx, L, t, tier);
  ctx.translate(0, bob);
  ctx.scale(1.15, 1.15);
  _hlpOrbit(ctx, L, t, tier, false);
  _hlpWings(ctx, L, t, tier);
  _hlpBody(ctx, def, t, tier);
  if (!_HLP_OWN_HEADWEAR.has(L.body)) _hlpHeadwear(ctx, L, t, tier, _HLP_HEAD_Y[L.body] || -16 - tier);
  _hlpOrbit(ctx, L, t, tier, true);
  _hlpTwinkles(ctx, L, t, tier);
  ctx.restore();
}

// ═════════════════════════════════════════════════════════════════════════════
//  ЭФФЕКТЫ НА ХОЗЯИНА (мир, PIXI)
// ═════════════════════════════════════════════════════════════════════════════
// Две кисти PIXI.Graphics: «пол» (под игроком — кольца, руны, столп) и «верх»
// (над ним — частицы, луч каста). Обе очищаются и рисуются заново каждый
// кадр; частицы — простой массив в мировых координатах.
const _hlpParts = [];
let _hlpCastT = 0;          // секунд до следующего каста
let _hlpBeam = 0;           // сколько ещё горит луч (0..1)
let _hlpBurst = 0;          // волна от каста (0..1)
let _hlpEmitAcc = 0;
const _HLP_MAX_PARTS = 140;

function _hlpSpawn(p) { if (_hlpParts.length < _HLP_MAX_PARTS) _hlpParts.push(p); }

// Частица по типу эффекта помощника. x/y — откуда, vx/vy — куда.
function _hlpSpawnFx(fx, L, x, y, burst) {
  const R = Math.random;
  const glow = _hlpHex(L.glow), c1 = _hlpHex(L.c1), c2 = _hlpHex(L.c2);
  const base = { x: x + (R() - 0.5) * 34, y: y + (R() - 0.5) * 10, life: 0, max: 0.9 + R() * 0.9, rot: R() * 6.28, vr: (R() - 0.5) * 4 };
  const up = burst ? 1.8 : 1;
  switch (fx) {
    case 'leaves': case 'petals':
      _hlpSpawn({ ...base, kind: 'leaf', vx: (R() - 0.5) * 30, vy: -25 * up - R() * 20, size: 3 + R() * 2, col: fx === 'petals' ? (R() < 0.5 ? c1 : glow) : (R() < 0.5 ? c2 : glow) }); break;
    case 'sparks': case 'flames':
      _hlpSpawn({ ...base, kind: 'spark', vx: (R() - 0.5) * 20, vy: -60 * up - R() * 40, size: 1.5 + R() * 1.5, col: R() < 0.4 ? c1 : glow, max: 0.5 + R() * 0.5 }); break;
    case 'bubbles':
      _hlpSpawn({ ...base, kind: 'bubble', vx: (R() - 0.5) * 12, vy: -30 * up - R() * 15, size: 2 + R() * 3, col: glow }); break;
    case 'coins':
      _hlpSpawn({ ...base, kind: 'coin', vx: (R() - 0.5) * 30, vy: -50 * up, g: 90, size: 2.4, col: glow }); break;
    case 'snow':
      _hlpSpawn({ ...base, y: y - 50 - R() * 20, kind: 'flake', vx: (R() - 0.5) * 14, vy: 18 + R() * 12, size: 2 + R() * 1.6, col: R() < 0.5 ? 0xffffff : glow }); break;
    case 'shards':
      _hlpSpawn({ ...base, kind: 'shard', vx: (R() - 0.5) * 40, vy: -40 * up - R() * 20, size: 2.5 + R() * 2, col: R() < 0.5 ? c1 : glow }); break;
    case 'void':
      { const a = R() * 6.28, d = 36 + R() * 14; _hlpSpawn({ ...base, x: x + Math.cos(a) * d, y: y + Math.sin(a) * d * 0.45 - 20, kind: 'void', cx: x, cy: y - 20, a, d, size: 1.6 + R() * 1.6, col: R() < 0.5 ? c2 : glow, max: 1.1 }); } break;
    case 'stars':
      _hlpSpawn({ ...base, kind: 'star', vx: (R() - 0.5) * 26, vy: -35 * up - R() * 25, size: 2.5 + R() * 2, col: R() < 0.5 ? 0xffffff : glow }); break;
    case 'holy':
      _hlpSpawn({ ...base, kind: R() < 0.5 ? 'feather' : 'mote', vx: (R() - 0.5) * 16, vy: -30 * up - R() * 20, size: 2 + R() * 2, col: R() < 0.5 ? 0xffffff : glow }); break;
    case 'bolts':
      _hlpSpawn({ ...base, kind: 'bolt', vx: 0, vy: 0, size: 10 + R() * 8, col: R() < 0.5 ? 0xffffff : glow, max: 0.18 + R() * 0.12 }); break;
    case 'swirl':
      { const a = R() * 6.28; _hlpSpawn({ ...base, kind: 'swirl', cx: x, cy: y, a, d: 20 + R() * 10, vy: -20, size: 1.6, col: glow, max: 1.2 }); } break;
    case 'ring':
      _hlpSpawn({ ...base, x, y, kind: 'ring', vx: 0, vy: 0, size: 6, col: glow, max: 0.9 }); break;
    default:
      _hlpSpawn({ ...base, kind: 'mote', vx: (R() - 0.5) * 16, vy: -22 * up - R() * 18, size: 1.4 + R() * 1.6, col: R() < 0.5 ? c1 : glow });
  }
}

function _hlpPoly(g, x, y, pts, rot, s) {
  const c = Math.cos(rot), sn = Math.sin(rot);
  const out = [];
  for (let i = 0; i < pts.length; i += 2) {
    const px = pts[i] * s, py = pts[i + 1] * s;
    out.push(x + px * c - py * sn, y + px * sn + py * c);
  }
  g.drawPolygon(out);
}
const _HLP_LEAF = [-1, 0, -0.4, -0.45, 0.4, -0.45, 1, 0, 0.4, 0.45, -0.4, 0.45];
const _HLP_SHARD = [0, -1.3, 0.55, 0, 0, 1.3, -0.55, 0];
const _HLP_STAR4 = [0, -1, 0.25, -0.25, 1, 0, 0.25, 0.25, 0, 1, -0.25, 0.25, -1, 0, -0.25, -0.25];
const _HLP_STAR5 = (() => { const a = []; for (let i = 0; i < 10; i++) { const r = i % 2 ? 0.42 : 1, an = -Math.PI / 2 + i * Math.PI / 5; a.push(Math.cos(an) * r, Math.sin(an) * r); } return a; })();

// Один кадр эффектов. gGround/gTop — PIXI.Graphics в мировых координатах;
// owner — {x, y}; hx/hy — где сейчас сам помощник.
function helperFxTick(gGround, gTop, def, owner, hx, hy, dt, ts) {
  gGround.clear(); gTop.clear();
  if (!def || !owner) return;
  const L = def.look, tier = _hlpTier(def);
  const t = ts / 1000;
  const glow = _hlpHex(L.glow), c1 = _hlpHex(L.c1);
  const ox = owner.x, oy = owner.y;

  // ── пол: аура под ногами ──
  const pulse = 0.5 + 0.5 * Math.sin(t * 3);
  const rings = 1 + Math.min(2, tier);
  for (let i = 0; i < rings; i++) {
    const k = 1 + i * 0.28 + (i === 0 ? pulse * 0.08 : 0);
    gGround.lineStyle(1.4 + tier * 0.25, glow, (0.32 + tier * 0.06) * (1 - i * 0.28));
    gGround.drawEllipse(ox, oy + 4, 22 * k, 8 * k);
  }
  gGround.lineStyle(0);
  gGround.beginFill(glow, 0.08 + tier * 0.03 + pulse * 0.04);
  gGround.drawEllipse(ox, oy + 4, 20, 7.5);
  gGround.endFill();
  // Редкий и выше — руны, бегущие по кругу.
  if (tier >= 2) {
    const n = 4 + tier * 2;
    for (let i = 0; i < n; i++) {
      const a = t * (0.8 + tier * 0.1) + (i / n) * Math.PI * 2;
      gGround.beginFill(i % 2 ? c1 : glow, 0.55 + 0.3 * pulse);
      _hlpPoly(gGround, ox + Math.cos(a) * 28, oy + 4 + Math.sin(a) * 10.5, _HLP_STAR4, a, 2.4 + tier * 0.3);
      gGround.endFill();
    }
  }
  // Легендарный — столп света над хозяином.
  if (tier >= 4) {
    const h = 90, w = 16 + pulse * 4;
    for (let i = 0; i < 4; i++) {
      gGround.beginFill(glow, 0.05 + i * 0.015);
      gGround.drawPolygon([ox - w * (1 - i * 0.22), oy + 4, ox - w * 0.35 * (1 - i * 0.22), oy - h, ox + w * 0.35 * (1 - i * 0.22), oy - h, ox + w * (1 - i * 0.22), oy + 4]);
      gGround.endFill();
    }
  }

  // ── каст: луч от помощника и волна ──
  _hlpCastT -= dt;
  if (_hlpCastT <= 0) {
    _hlpCastT = 7 - tier * 0.8;
    _hlpBeam = 1; _hlpBurst = 1;
    for (let i = 0; i < 6 + tier * 4; i++) _hlpSpawnFx(L.fx, L, ox, oy, true);
  }
  if (_hlpBurst > 0) {
    const k = 1 - _hlpBurst;
    gGround.lineStyle(2 + tier * 0.5, glow, _hlpBurst * 0.8);
    gGround.drawEllipse(ox, oy + 4, 14 + k * (40 + tier * 8), 5 + k * (15 + tier * 3));
    if (tier >= 3) {
      gGround.lineStyle(1.2, c1, _hlpBurst * 0.6);
      gGround.drawEllipse(ox, oy + 4, 8 + k * (28 + tier * 6), 3 + k * (10 + tier * 2));
    }
    gGround.lineStyle(0);
    _hlpBurst = Math.max(0, _hlpBurst - dt * 1.6);
  }
  if (_hlpBeam > 0 && tier >= 1) {
    const ty = oy - 30;
    const wob = Math.sin(t * 40) * 1.5;
    gTop.lineStyle((2 + tier) * 2.2, glow, _hlpBeam * 0.18);
    gTop.moveTo(hx, hy); gTop.lineTo(ox + wob, ty);
    gTop.lineStyle(1.4 + tier * 0.6, tier >= 3 ? 0xffffff : c1, _hlpBeam * 0.85);
    gTop.moveTo(hx, hy); gTop.lineTo(ox, ty);
    gTop.lineStyle(0);
    gTop.beginFill(glow, _hlpBeam * 0.4);
    gTop.drawCircle(ox, ty, 6 + tier * 2 + (1 - _hlpBeam) * 10);
    gTop.endFill();
    _hlpBeam = Math.max(0, _hlpBeam - dt * 2.2);
  }

  // ── постоянный поток частиц и шлейф за помощником ──
  _hlpEmitAcc += dt * (1.2 + tier * 1.4);
  while (_hlpEmitAcc >= 1) { _hlpEmitAcc -= 1; _hlpSpawnFx(L.fx, L, ox, oy, false); }
  if (L.trail && Math.random() < dt * 22) {
    _hlpSpawn({ kind: 'mote', x: hx + (Math.random() - 0.5) * 8, y: hy + 4, vx: (Math.random() - 0.5) * 8, vy: 6 + Math.random() * 8,
      life: 0, max: 0.5 + Math.random() * 0.4, size: 1.6 + Math.random() * 1.4, col: Math.random() < 0.5 ? glow : c1, rot: 0, vr: 0 });
  }

  for (let i = _hlpParts.length - 1; i >= 0; i--) {
    const p = _hlpParts[i];
    p.life += dt;
    if (p.life >= p.max) { _hlpParts.splice(i, 1); continue; }
    const k = p.life / p.max, al = Math.sin(k * Math.PI);
    if (p.kind === 'void') {
      const d = p.d * (1 - k);
      p.x = p.cx + Math.cos(p.a + k * 4) * d; p.y = p.cy + Math.sin(p.a + k * 4) * d * 0.45;
    } else if (p.kind === 'swirl') {
      p.a += dt * 4; p.cy += (p.vy || 0) * dt;
      p.x = p.cx + Math.cos(p.a) * p.d; p.y = p.cy + Math.sin(p.a) * p.d * 0.4 - k * 30;
    } else {
      p.x += (p.vx || 0) * dt; p.y += (p.vy || 0) * dt;
      if (p.g) p.vy += p.g * dt;
    }
    p.rot += (p.vr || 0) * dt;
    switch (p.kind) {
      case 'leaf': gTop.beginFill(p.col, al * 0.9); _hlpPoly(gTop, p.x, p.y, _HLP_LEAF, p.rot, p.size); gTop.endFill(); break;
      case 'shard': gTop.beginFill(p.col, al * 0.9); _hlpPoly(gTop, p.x, p.y, _HLP_SHARD, p.rot, p.size); gTop.endFill(); break;
      case 'star': gTop.beginFill(p.col, al); _hlpPoly(gTop, p.x, p.y, _HLP_STAR5, p.rot, p.size); gTop.endFill(); break;
      case 'flake': gTop.beginFill(p.col, al); _hlpPoly(gTop, p.x, p.y, _HLP_STAR4, p.rot, p.size); gTop.endFill(); break;
      case 'feather':
        gTop.beginFill(p.col, al * 0.85); gTop.drawEllipse(p.x, p.y, p.size * 0.6, p.size * 1.6); gTop.endFill(); break;
      case 'bubble':
        gTop.lineStyle(1, p.col, al * 0.9); gTop.drawCircle(p.x, p.y, p.size); gTop.lineStyle(0);
        gTop.beginFill(0xffffff, al * 0.7); gTop.drawCircle(p.x - p.size * 0.35, p.y - p.size * 0.35, p.size * 0.25); gTop.endFill(); break;
      case 'coin':
        gTop.beginFill(p.col, al); gTop.drawEllipse(p.x, p.y, p.size * Math.max(0.2, Math.abs(Math.cos(p.rot * 2))), p.size); gTop.endFill(); break;
      case 'spark':
        gTop.lineStyle(p.size, p.col, al); gTop.moveTo(p.x, p.y); gTop.lineTo(p.x - (p.vx || 0) * 0.05, p.y - (p.vy || 0) * 0.05); gTop.lineStyle(0); break;
      case 'bolt': {
        gTop.lineStyle(1.6, p.col, al);
        let bx = p.x, by = p.y - 30; gTop.moveTo(bx, by);
        for (let j = 0; j < 4; j++) { bx += (Math.random() - 0.5) * 10; by += p.size / 2; gTop.lineTo(bx, by); }
        gTop.lineStyle(0); break;
      }
      case 'ring':
        gTop.lineStyle(1.5, p.col, (1 - k) * 0.7); gTop.drawEllipse(p.x, p.y + 4, p.size + k * 34, (p.size + k * 34) * 0.36); gTop.lineStyle(0); break;
      default:
        gTop.beginFill(p.col, al * 0.35); gTop.drawCircle(p.x, p.y, p.size * 2.2); gTop.endFill();
        gTop.beginFill(p.col, al); gTop.drawCircle(p.x, p.y, p.size); gTop.endFill();
    }
  }
}

function helperFxReset() { _hlpParts.length = 0; _hlpBeam = 0; _hlpBurst = 0; _hlpCastT = 1.5; }

// ═════════════════════════════════════════════════════════════════════════════
//  ОКНО ПОМОЩНИКА И КРАФТ В КУЗНИЦЕ
// ═════════════════════════════════════════════════════════════════════════════
const _HLP_RARITY_RU = { common: 'Обычный', uncommon: 'Необычный', rare: 'Редкий', epic: 'Эпический', legendary: 'Легендарный' };
const _HLP_STAT_RU = {
  atk: 'Атака', def: 'Защита', hp: 'Здоровье', critChance: 'Шанс крита', critPower: 'Сила крита',
  atkSpeed: 'Скорость атаки', hpPct: 'Здоровье %', atkPct: 'Атака %', speedPct: 'Скорость бега',
  xpPct: 'Опыт', dropPct: 'Дроп',
};
function _hlpRarCol(r) { return (typeof RARITY_COLOR !== 'undefined' && RARITY_COLOR[r]) || '#c4a276'; }
function _hlpFmtStat(k, v) {
  if (k === 'atk' || k === 'def' || k === 'hp') return '+' + Number(v).toLocaleString('ru-RU');
  if (k === 'atkSpeed') return '+' + (Math.round(v * 100) / 100);
  return '+' + (Math.round(v * 1000) / 10) + '%';
}
function _hlpNum(n) { return Number(n || 0).toLocaleString('ru-RU'); }

// ── значок для сумки, слота и рынка ─────────────────────────────────────────
// Один неподвижный кадр, растрированный в dataURL один раз на вид. Раньше окно
// перерисовывало каждый кадр все ~40 холстов (герой, коллекция, крафт) — от
// этого и дёргалось. Теперь живым остаётся только один большой помощник в
// открытом окне, а все маленькие — картинки.
const _hlpIconCache = new Map();
function helperIconUrl(id) {
  if (_hlpIconCache.has(id)) return _hlpIconCache.get(id);
  const def = helperById(id);
  if (!def || typeof document === 'undefined') return null;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 96;
  const ctx = cv.getContext('2d');
  if (!ctx) return null;
  helperDrawFrame(ctx, def, 0.8, 96);
  let url;
  try { url = cv.toDataURL('image/png'); } catch { url = null; }
  _hlpIconCache.set(id, url);
  return url;
}
function _hlpIconImg(id, px, dim) {
  const url = helperIconUrl(id);
  return url ? `<img src="${url}" width="${px}" height="${px}" alt=""${dim ? ' style="opacity:.35;filter:grayscale(1)"' : ''}>` : '';
}

// ── живой холст ─────────────────────────────────────────────────────────────
// Только в окне помощника и в окне «Новый помощник!» — по одному холсту.
// Кадр — не чаще 30 раз в секунду: на телефоне 60 полных перерисовок с
// градиентами и свечением и давали рывки, а глаз разницы не видит.
function _hlpCv(id, px) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  return `<canvas data-hid="${id}" width="${Math.round(px * dpr)}" height="${Math.round(px * dpr)}" style="width:${px}px;height:${px}px"></canvas>`;
}
function _hlpStartAnim() {
  if (_hlpRaf) return;
  let last = 0;
  const loop = (ts) => {
    const list = document.querySelectorAll('canvas[data-hid]');
    if (!list.length) { _hlpRaf = 0; return; }
    if (ts - last >= 33) {
      last = ts;
      const t = ts / 1000;
      list.forEach(cv => {
        const def = helperById(cv.dataset.hid);
        const ctx = cv.getContext('2d');
        if (def && ctx) helperDrawFrame(ctx, def, t, cv.width);
      });
    }
    _hlpRaf = requestAnimationFrame(loop);
  };
  _hlpRaf = requestAnimationFrame(loop);
}

function _hlpStatsHTML(def, level) {
  const cur = helperBonusAt(def.id, level) || {};
  const nxt = level < HELPER_MAX_LEVEL ? helperBonusAt(def.id, level + 1) : null;
  return Object.keys(def.stats).map(k => `
    <div class="hlp-stat"><span>${_HLP_STAT_RU[k] || k}</span>
      <b>${_hlpFmtStat(k, cur[k])}</b>${nxt ? `<i>→ ${_hlpFmtStat(k, nxt[k])}</i>` : ''}</div>`).join('');
}

// ── окно помощника (тап по нему в сумке или в слоте) ────────────────────────
// Где он лежит — по номеру строки: после кормления сумка приходит заново, и
// индексы в ней могут сдвинуться, а строка та же.
function _hlpFindRow(rowId) {
  if (!player) return null;
  const eq = player.equipment && player.equipment.helper;
  if (eq && eq.rowId === rowId) return { it: eq, where: 'eq' };
  const idx = (player.inventory || []).findIndex(x => x && x.rowId === rowId);
  return idx >= 0 ? { it: player.inventory[idx], where: 'inv', idx } : null;
}

function openHelperItemModal(where, key) {
  if (!player) return;
  const it = where === 'eq' ? (player.equipment || {})[key] : (player.inventory || [])[key];
  if (!it || it.slot !== 'helper') return;
  _hlpModal = { rowId: it.rowId };
  _hlpBusy = false;
  _renderHelperItemModal();
}

function _renderHelperItemModal() {
  if (!_hlpModal) return;
  const found = _hlpFindRow(_hlpModal.rowId);
  const def = found && helperById(found.it.id);
  if (!def) { _hlpModal = null; if (typeof closeInvItemModal === 'function') closeInvItemModal(); return; }
  const it = found.it;
  const level = it.hlLevel || 1, xp = it.hlXp || 0;
  const col = _hlpRarCol(def.rarity);
  const maxed = level >= HELPER_MAX_LEVEL;
  const need = helperXpToNext(level);
  const pct = maxed ? 100 : Math.floor((xp / Math.max(1, need)) * 100);
  const total = typeof _hlpShardTotal === 'function' ? _hlpShardTotal() : 0;
  const equipped = found.where === 'eq';
  const feedBtn = n => {
    const plan = helperFeedPlan(level, xp, n);
    const ok = plan.feeds > 0 && total >= plan.cost && !_hlpBusy;
    return `<button class="hlp-feed-btn" ${ok ? '' : 'disabled'} onclick="helperFeedRow(${it.rowId}, ${n})">
      <span>💎 Кормить${n > 1 ? ' ×' + plan.feeds : ''}</span><small>${_hlpNum(plan.cost)} осколков</small></button>`;
  };
  const equipBtn = equipped
    ? `<button class="hlp-summon-btn on" ${_hlpBusy ? 'disabled' : ''} onclick="_hlpUnequip()">✓ Надет — снять</button>`
    : `<button class="hlp-summon-btn" ${_hlpBusy ? 'disabled' : ''} onclick="_hlpEquip(${it.rowId})">✨ Надеть</button>`;

  // Холст живёт, пока окно открыто: перерисовка окна (после кормления)
  // переиспользует тот же элемент, а не создаёт новый, — иначе кадр мигал бы.
  let ov = document.getElementById('inv-item-modal-ov');
  const sameRow = ov && ov.dataset.hlpRow === String(it.rowId);
  if (!sameRow) {
    if (typeof closeInvItemModal === 'function') closeInvItemModal();
    _hlpModal = { rowId: it.rowId };
    ov = document.createElement('div');
    ov.id = 'inv-item-modal-ov';
    ov.className = 'imod-overlay';
    ov.dataset.hlpRow = String(it.rowId);
    ov.onclick = () => { _hlpModal = null; if (typeof closeInvItemModal === 'function') closeInvItemModal(); };
    ov.innerHTML = `<div class="imod-box hlp-imod" onclick="event.stopPropagation()">
      <div class="hlp-hero r-${def.rarity}" style="--rc:${col}">
        <button class="npc-close hlp-imod-close" onclick="_hlpModal=null;closeInvItemModal()">✕</button>
        <div class="hlp-hero-stage">${_hlpCv(def.id, 150)}</div>
        <div class="hlp-hero-info" id="hlp-imod-info"></div>
        <div class="hlp-stats hlp-hero-stats" id="hlp-imod-stats"></div>
        <div class="hlp-hero-actions" id="hlp-imod-actions"></div>
        <div class="hlp-hero-note" id="hlp-imod-note"></div>
      </div>
    </div>`;
    (document.getElementById('app') || document.body).appendChild(ov);
  }
  ov.querySelector('#hlp-imod-info').innerHTML = `
    <div class="hlp-hero-rar">${_HLP_RARITY_RU[def.rarity]}${equipped ? ' · надет' : ''}</div>
    <div class="hlp-hero-name">${def.name}</div>
    <div class="hlp-hero-lvl">Уровень <b>${level}</b> / ${HELPER_MAX_LEVEL}</div>
    <div class="hlp-xp"><div class="hlp-xp-fill" style="width:${pct}%"></div>
      <span>${maxed ? 'МАКС.' : `${xp} / ${need} опыта`}</span></div>`;
  ov.querySelector('#hlp-imod-stats').innerHTML = _hlpStatsHTML(def, level);
  ov.querySelector('#hlp-imod-actions').innerHTML =
    (maxed ? '<div class="hlp-maxed">★ Максимальный уровень</div>' : `${feedBtn(1)}${feedBtn(5)}${feedBtn(10)}`) + equipBtn;
  ov.querySelector('#hlp-imod-note').innerHTML = maxed ? 'Помощника можно продать на рынке — уровень переходит вместе с ним.'
    : `Одно кормление: +${HELPER_FEED_XP} опыта · ${_hlpNum(helperFeedCost(level))} осколков любых видов (берутся с самых больших стопок; у вас ${_hlpNum(total)}). Чем выше уровень — тем дороже порция. Продать помощника можно на рынке — уровень переходит вместе с ним.`;
  _hlpStartAnim();
}

function helperFeedRow(rowId, n) {
  if (_hlpBusy) return;
  _hlpBusy = true; _renderHelperItemModal();
  if (typeof netHelperFeed === 'function') netHelperFeed(rowId, n);
}
function _hlpEquip(rowId) {
  const f = _hlpFindRow(rowId);
  _hlpModal = null;
  if (typeof closeInvItemModal === 'function') closeInvItemModal();
  if (f && f.where === 'inv' && typeof equipItem === 'function') equipItem(f.idx);
}
function _hlpUnequip() {
  _hlpModal = null;
  if (typeof closeInvItemModal === 'function') closeInvItemModal();
  if (typeof unequipItem === 'function') unequipItem('helper');
}

function onHelperFed(res) {
  _hlpBusy = false;
  if (res && typeof _marketToast === 'function') {
    const def = helperById(res.id);
    const lvl = res.to > res.from ? ` · уровень ${res.from} → ${res.to}!` : '';
    _marketToast(`${def ? def.name : 'Помощник'}: +${res.xpGained} опыта${lvl}`, 'ok');
  }
  if (_hlpModal) _renderHelperItemModal();
}
function onHelperError() {
  _hlpBusy = false;
  if (_hlpModal) _renderHelperItemModal();
  if (typeof _craftsmanTab !== 'undefined' && _craftsmanTab === 'helpers' && typeof _setCraftsmanTab === 'function'
    && document.getElementById('npc-body')) _setCraftsmanTab('helpers');
}

// ── кузница: вкладка «Помощники» ────────────────────────────────────────────
// Пять рецептов — по редкости. Каждый вид осколков по цене редкости, выпадает
// случайный помощник этой редкости новым предметом в сумку.
function helperCraftTabHTML() {
  const minShard = _hlpShardMin();
  const rows = HELPER_RARITIES.map(r => {
    const cost = HELPER_CRAFT_COST[r];
    const ok = minShard >= cost && !_hlpBusy;
    const pool = HELPERS.filter(h => h.rarity === r);
    return `<div class="hlp-craft r-${r}" style="--rc:${_hlpRarCol(r)}">
      <div class="hlp-craft-pics">${pool.map(h => `<button class="hlp-craft-pic" title="${h.name}" onclick="helperPreview('${h.id}')">${_hlpIconImg(h.id, 34)}</button>`).join('')}</div>
      <div class="hlp-craft-txt">
        <div class="hlp-craft-name">${_HLP_RARITY_RU[r]} <small>${pool.length} ${pool.length >= 5 ? "видов" : "вида"}</small></div>
        <div class="hlp-craft-cost">по ${_hlpNum(cost)} каждого осколка</div>
      </div>
      <button class="hlp-craft-btn" ${ok ? '' : 'disabled'} onclick="helperCraft('${r}')">Создать</button>
    </div>`;
  }).join('');
  return `<div class="hlp-wrap">
    <div class="hlp-sec-hdr">🔮 Помощники — случайный выбранной редкости</div>
    <div class="hlp-shards">Осколков: всего <b>${_hlpNum(_hlpShardTotal())}</b>, меньше всего одного вида — <b>${_hlpNum(minShard)}</b>.
      Помощник появится в сумке: нажмите на него, чтобы надеть или прокачать.
      Нажмите на любого помощника ниже, чтобы посмотреть, что он даёт.</div>
    ${rows}</div>`;
}
function helperCraft(rarity) {
  if (_hlpBusy) return;
  _hlpBusy = true;
  if (typeof _setCraftsmanTab === 'function' && document.getElementById('npc-body')) _setCraftsmanTab('helpers');
  if (typeof netHelperCraft === 'function') netHelperCraft(rarity);
}

// Карточка помощника из кузницы: кто он, что даёт на 1-м уровне и на
// максимальном. Не трогает ни сумку, ни сервер — только показывает.
function helperPreview(id) {
  const def = helperById(id);
  if (!def) return;
  document.getElementById('hlp-prev-ov')?.remove();
  const col = _hlpRarCol(def.rarity);
  const b1 = helperBonusAt(def.id, 1) || {}, bMax = helperBonusAt(def.id, HELPER_MAX_LEVEL) || {};
  const rows = Object.keys(def.stats).map(k => `
    <div class="hlp-stat"><span>${_HLP_STAT_RU[k] || k}</span>
      <b>${_hlpFmtStat(k, b1[k])}</b><i>→ ${_hlpFmtStat(k, bMax[k])}</i></div>`).join('');
  const ov = document.createElement('div');
  ov.id = 'hlp-prev-ov';
  ov.className = 'ach-win-ov hlp-prev-ov';
  ov.onclick = () => ov.remove();
  ov.innerHTML = `
    <div class="db-win-panel hlp-win r-${def.rarity}" onclick="event.stopPropagation()" style="--rc:${col}">
      <div class="hlp-win-stage">${_hlpCv(def.id, 150)}</div>
      <div class="hlp-win-rar">${_HLP_RARITY_RU[def.rarity]}</div>
      <div class="hlp-win-name">${def.name}</div>
      <div class="db-win-sub">Характеристики на 1-м уровне → на ${HELPER_MAX_LEVEL}-м</div>
      <div class="hlp-stats hlp-win-stats">${rows}</div>
      <div class="db-win-sub" style="font-size:11px;opacity:.8">Каждый уровень: +${Math.round(HELPER_LEVEL_GROWTH * 100)}% к характеристикам 1-го уровня.
        Создание — по ${_hlpNum(HELPER_CRAFT_COST[def.rarity])} каждого осколка, выпадает случайный помощник этой редкости.</div>
      <button class="db-win-btn" onclick="document.getElementById('hlp-prev-ov')?.remove()">Закрыть</button>
    </div>`;
  document.body.appendChild(ov);
  _hlpStartAnim();
}

// Окно «Новый помощник!» — большой, с лучами за спиной.
function showHelperCrafted(res) {
  _hlpBusy = false;
  if (typeof _craftsmanTab !== 'undefined' && _craftsmanTab === 'helpers' && typeof _setCraftsmanTab === 'function'
    && document.getElementById('npc-body')) _setCraftsmanTab('helpers');
  const def = res && helperById(res.id);
  if (!def) return;
  document.getElementById('hlp-win-ov')?.remove();
  const col = _hlpRarCol(def.rarity);
  const ov = document.createElement('div');
  ov.id = 'hlp-win-ov';
  ov.className = 'ach-win-ov';
  ov.onclick = () => ov.remove();
  ov.innerHTML = `
    <div class="db-win-panel hlp-win r-${def.rarity}" onclick="event.stopPropagation()" style="--rc:${col}">
      <div class="ach-win-rays"></div>
      <div class="hlp-win-stage">${_hlpCv(def.id, 180)}</div>
      <div class="db-win-title">Новый помощник!</div>
      <div class="hlp-win-rar">${_HLP_RARITY_RU[def.rarity]}</div>
      <div class="hlp-win-name">${def.name}</div>
      <div class="db-win-sub">Лежит в сумке — нажмите на него, чтобы надеть</div>
      <div class="hlp-stats hlp-win-stats">${_hlpStatsHTML(def, 1)}</div>
      <button class="db-win-btn" onclick="document.getElementById('hlp-win-ov')?.remove()">Отлично</button>
    </div>`;
  document.body.appendChild(ov);
  _hlpStartAnim();
}
