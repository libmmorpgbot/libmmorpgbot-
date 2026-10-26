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

// ── состояние с сервера ─────────────────────────────────────────────────────
let _hlpState = { ready: false, list: [], active: null };
let _hlpSel = null;        // какой помощник открыт в окне
let _hlpBusy = false;      // ждём ответ сервера — кнопки выключены
let _hlpRaf = 0;           // цикл анимации карточек, пока окно открыто

function _hlpTier(def) { return Math.max(0, HELPER_RARITIES.indexOf(def && def.rarity)); }
function _hlpOwned(id) { return _hlpState.list.find(h => h.id === id) || null; }
function helperActiveDef() { return _hlpState.ready && _hlpState.active ? helperById(_hlpState.active) : null; }

// Кого считать в характеристики: recompute() (js/player.js) спрашивает
// отсюда, а не держит копию на player — объект игрока пересоздаётся при
// смене персонажа, а состояние помощников живёт своё.
function helperActiveForStats() {
  const act = _hlpState.ready && _hlpState.active && _hlpOwned(_hlpState.active);
  return act ? { id: act.id, level: act.level } : null;
}
// Пересчитать характеристики после того, как пришло новое состояние. Сами
// числа считает recompute() — тем же helperBonusAt, что и сервер.
function _hlpApplyToPlayer() {
  if (player && typeof recompute === 'function') recompute();
  if (player && typeof updateInvUI === 'function') updateInvUI();
}

function onHelpersState(st) {
  _hlpState = {
    ready: !!(st && st.ready),
    list: (st && Array.isArray(st.list) ? st.list : []).filter(h => helperById(h.id)),
    active: (st && st.active) || null,
  };
  _hlpBusy = false;
  if (!_hlpSel || !_hlpOwned(_hlpSel)) _hlpSel = _hlpState.active || (_hlpState.list[0] && _hlpState.list[0].id) || null;
  _hlpApplyToPlayer();
  if (_hlpPanelOpen()) _renderHelpersPanel();
}
function onHelperError() {
  _hlpBusy = false;
  if (_hlpPanelOpen()) _renderHelpersPanel();
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
  _hlpHeadwear(ctx, L, t, tier, _HLP_HEAD_Y[L.body] || -16 - tier);
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
//  ОКНО «ПОМОЩНИКИ»
// ═════════════════════════════════════════════════════════════════════════════
const _HLP_RARITY_RU = { common: 'Обычный', uncommon: 'Необычный', rare: 'Редкий', epic: 'Эпический', legendary: 'Легендарный' };
const _HLP_RARITY_RU_GEN = { common: 'обычного', uncommon: 'необычного', rare: 'редкого', epic: 'эпического', legendary: 'легендарного' };
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

function _hlpPanelOpen() { return document.getElementById('helpers-panel')?.style.display === 'flex'; }

function openHelpersPanel() {
  const panel = document.getElementById('helpers-panel');
  if (!panel) return;
  panel.style.display = 'flex';
  _renderHelpersPanel();
  if (typeof netHelpersSync === 'function') netHelpersSync();
  _hlpStartAnim();
}
function closeHelpersPanel() {
  const panel = document.getElementById('helpers-panel');
  if (panel) panel.style.display = 'none';
  _hlpStopAnim();
}

// Холсты в окне помечены data-hid; один цикл перерисовывает все видимые.
function _hlpStartAnim() {
  if (_hlpRaf) return;
  const loop = (ts) => {
    if (!_hlpPanelOpen() && !document.getElementById('hlp-win-ov')) { _hlpRaf = 0; return; }
    const t = ts / 1000;
    document.querySelectorAll('canvas[data-hid]').forEach(cv => {
      const def = helperById(cv.dataset.hid);
      const ctx = cv.getContext('2d');
      if (def && ctx) helperDrawFrame(ctx, def, t, cv.width, { dim: cv.dataset.dim === '1' });
    });
    _hlpRaf = requestAnimationFrame(loop);
  };
  _hlpRaf = requestAnimationFrame(loop);
}
function _hlpStopAnim() {
  if (_hlpRaf && !document.getElementById('hlp-win-ov')) { cancelAnimationFrame(_hlpRaf); _hlpRaf = 0; }
}

function _hlpCv(id, px, dim) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  return `<canvas data-hid="${id}"${dim ? ' data-dim="1"' : ''} width="${Math.round(px * dpr)}" height="${Math.round(px * dpr)}" style="width:${px}px;height:${px}px"></canvas>`;
}

function _hlpStatsHTML(def, level) {
  const cur = helperBonusAt(def.id, level) || {};
  const nxt = level < HELPER_MAX_LEVEL ? helperBonusAt(def.id, level + 1) : null;
  return Object.keys(def.stats).map(k => `
    <div class="hlp-stat"><span>${_HLP_STAT_RU[k] || k}</span>
      <b>${_hlpFmtStat(k, cur[k])}</b>${nxt ? `<i>→ ${_hlpFmtStat(k, nxt[k])}</i>` : ''}</div>`).join('');
}

function _hlpHeroHTML() {
  const def = helperById(_hlpSel);
  const own = def && _hlpOwned(def.id);
  if (!def || !own) {
    return `<div class="hlp-hero hlp-hero-empty">
      <div class="hlp-hero-empty-txt">У вас пока нет помощников.<br>Создайте первого из осколков — ниже.</div>
    </div>`;
  }
  const col = _hlpRarCol(def.rarity);
  const maxed = own.level >= HELPER_MAX_LEVEL;
  const need = helperXpToNext(own.level);
  const pct = maxed ? 100 : Math.floor((own.xp / Math.max(1, need)) * 100);
  const total = _hlpShardTotal();
  const isActive = _hlpState.active === def.id;
  const feedBtn = n => {
    const plan = helperFeedPlan(own.level, own.xp, n);
    const ok = plan.feeds > 0 && total >= plan.cost && !_hlpBusy;
    return `<button class="hlp-feed-btn" ${ok ? '' : 'disabled'} onclick="helperFeed('${def.id}', ${n})">
      <span>💎 Кормить${n > 1 ? ' ×' + plan.feeds : ''}</span><small>${_hlpNum(plan.cost)} осколков</small></button>`;
  };
  return `
    <div class="hlp-hero r-${def.rarity}" style="--rc:${col}">
      <div class="hlp-hero-stage">${_hlpCv(def.id, 150)}</div>
      <div class="hlp-hero-info">
        <div class="hlp-hero-rar">${_HLP_RARITY_RU[def.rarity]}</div>
        <div class="hlp-hero-name">${def.name}</div>
        <div class="hlp-hero-lvl">Уровень <b>${own.level}</b> / ${HELPER_MAX_LEVEL}</div>
        <div class="hlp-xp"><div class="hlp-xp-fill" style="width:${pct}%"></div>
          <span>${maxed ? 'МАКС.' : `${own.xp} / ${need} опыта`}</span></div>
      </div>
      <div class="hlp-stats hlp-hero-stats">${_hlpStatsHTML(def, own.level)}</div>
      <div class="hlp-hero-actions">
        ${maxed ? '<div class="hlp-maxed">★ Максимальный уровень</div>' : `${feedBtn(1)}${feedBtn(5)}${feedBtn(10)}`}
        <button class="hlp-summon-btn${isActive ? ' on' : ''}" ${_hlpBusy ? 'disabled' : ''}
          onclick="helperSetActive(${isActive ? 'null' : `'${def.id}'`})">${isActive ? '✓ Летает рядом — убрать' : '✨ Призвать'}</button>
      </div>
      <div class="hlp-hero-note">Одно кормление: +${HELPER_FEED_XP} опыта · ${_hlpNum(helperFeedCost(own.level))} осколков любых видов (берутся с самых больших стопок). Чем выше уровень — тем дороже порция.</div>
    </div>`;
}

function _hlpCraftHTML() {
  const minShard = _hlpShardMin();
  const rows = HELPER_RARITIES.map(r => {
    const cost = HELPER_CRAFT_COST[r];
    const ok = minShard >= cost && !_hlpBusy;
    const pool = HELPERS.filter(h => h.rarity === r);
    const got = pool.filter(h => _hlpOwned(h.id)).length;
    return `<div class="hlp-craft r-${r}" style="--rc:${_hlpRarCol(r)}">
      <div class="hlp-craft-pics">${pool.map(h => _hlpCv(h.id, 34, !_hlpOwned(h.id))).join('')}</div>
      <div class="hlp-craft-txt">
        <div class="hlp-craft-name">${_HLP_RARITY_RU[r]} <small>${got}/${pool.length}</small></div>
        <div class="hlp-craft-cost">по ${_hlpNum(cost)} каждого осколка</div>
      </div>
      <button class="hlp-craft-btn" ${ok ? '' : 'disabled'} onclick="helperCraft('${r}')">Создать</button>
    </div>`;
  }).join('');
  return `<div class="hlp-sec-hdr">🔮 Создание — случайный помощник выбранной редкости</div>
    <div class="hlp-shards">Осколков: всего <b>${_hlpNum(_hlpShardTotal())}</b>, меньше всего одного вида — <b>${_hlpNum(minShard)}</b>.
      Повтор уже открытого помощника превращается в +${HELPER_DUP_XP} опыта ему.</div>
    ${rows}`;
}

function _hlpCollectionHTML() {
  return `<div class="hlp-sec-hdr">📖 Коллекция</div>` + HELPER_RARITIES.map(r => {
    const list = HELPERS.filter(h => h.rarity === r);
    return `<div class="hlp-grid">${list.map(h => {
      const own = _hlpOwned(h.id);
      const act = _hlpState.active === h.id, sel = _hlpSel === h.id;
      return `<div class="hlp-cell r-${r}${own ? '' : ' locked'}${sel ? ' sel' : ''}" style="--rc:${_hlpRarCol(r)}"
        ${own ? `onclick="helperSelect('${h.id}')"` : ''}>
        ${_hlpCv(h.id, 64, !own)}
        <div class="hlp-cell-name">${own ? h.name : '???'}</div>
        <div class="hlp-cell-lvl">${own ? `ур. ${own.level}` : _HLP_RARITY_RU[r]}</div>
        ${act ? '<i class="hlp-cell-act">✓</i>' : ''}
      </div>`;
    }).join('')}</div>`;
  }).join('');
}

function _renderHelpersPanel() {
  const body = document.getElementById('helpers-panel-body');
  if (!body) return;
  if (!_hlpState.ready) {
    body.innerHTML = '<div class="s4-wrap"><div class="s4-empty">Помощники скоро появятся</div></div>';
    return;
  }
  body.innerHTML = `<div class="s4-wrap hlp-wrap">${_hlpHeroHTML()}${_hlpCraftHTML()}${_hlpCollectionHTML()}</div>`;
}

function helperSelect(id) {
  if (!_hlpOwned(id)) return;
  _hlpSel = id;
  _renderHelpersPanel();
}
function helperCraft(rarity) {
  if (_hlpBusy) return;
  _hlpBusy = true; _renderHelpersPanel();
  if (typeof netHelperCraft === 'function') netHelperCraft(rarity);
}
function helperFeed(id, n) {
  if (_hlpBusy) return;
  _hlpBusy = true; _renderHelpersPanel();
  if (typeof netHelperFeed === 'function') netHelperFeed(id, n);
}
function helperSetActive(id) {
  if (_hlpBusy) return;
  _hlpBusy = true; _renderHelpersPanel();
  if (typeof netHelperSetActive === 'function') netHelperSetActive(id);
}

// Окно «Новый помощник!» — большой, с лучами за спиной.
function showHelperCrafted(res) {
  const def = res && helperById(res.id);
  if (!def) return;
  _hlpSel = def.id;
  document.getElementById('hlp-win-ov')?.remove();
  const col = _hlpRarCol(def.rarity);
  const dup = res.outcome === 'duplicate';
  const ov = document.createElement('div');
  ov.id = 'hlp-win-ov';
  ov.className = 'ach-win-ov';
  ov.onclick = () => ov.remove();
  ov.innerHTML = `
    <div class="db-win-panel hlp-win r-${def.rarity}" onclick="event.stopPropagation()" style="--rc:${col}">
      <div class="ach-win-rays"></div>
      <div class="hlp-win-stage">${_hlpCv(def.id, 180)}</div>
      <div class="db-win-title">${dup ? 'Повтор!' : 'Новый помощник!'}</div>
      <div class="hlp-win-rar">${_HLP_RARITY_RU[def.rarity]}</div>
      <div class="hlp-win-name">${def.name}</div>
      <div class="db-win-sub">${dup ? `+${HELPER_DUP_XP} опыта · уровень ${res.to}` : 'Уже в вашей коллекции'}</div>
      <div class="hlp-stats hlp-win-stats">${_hlpStatsHTML(def, res.to || 1)}</div>
      <button class="db-win-btn" onclick="document.getElementById('hlp-win-ov')?.remove()">Отлично</button>
    </div>`;
  document.body.appendChild(ov);
  _hlpStartAnim();
}

function onHelperFed(res) {
  if (!res || typeof _marketToast !== 'function') return;
  const def = helperById(res.id);
  const lvl = res.to > res.from ? ` · уровень ${res.from} → ${res.to}!` : '';
  _marketToast(`${def ? def.name : 'Помощник'}: +${res.xpGained} опыта${lvl}`, 'ok');
}

// Кнопка — в колонке меню, под «Достижениями».
function _positionHelpersBtn() {
  const above = document.getElementById('ach-btn');
  const btn = document.getElementById('helpers-btn');
  if (!btn || !above) return;
  const aTop = parseFloat(above.style.top) || 0;
  btn.style.top       = (aTop + 28 + 4) + 'px';
  btn.style.left      = above.style.left;
  btn.style.width     = above.style.width;
  btn.style.right     = 'auto';
  btn.style.transform = 'none';
}
function showHelpersBtn() {
  const btn = document.getElementById('helpers-btn');
  if (btn) { btn.dataset.shown = '1'; btn.style.display = _hudSubBtnDisplay(); _positionHelpersBtn(); }
}
