'use strict';
// ── HUD: загрузка ассетов, рисование, золото на кнопках ───────────────────
//
// Таблица геометрии лежит в js/hudart.js и ГЕНЕРИРУЕТСЯ dev/hud-assets.js.
// Этот код держится отдельно ровно поэтому: первый раз он был дописан в конец
// сгенерированного файла, и следующий же прогон конвейера стёр его целиком.
// Файл, который перезаписывает машина, не место для того, что пишет человек.

// ── загрузка ───────────────────────────────────────────────────────────────
// Ленивая, по первому обращению, и БЕЗ ожидания: HUD рисуется каждый кадр,
// и кадр, который ждёт картинку, — это подвисший кадр. Пока файл не пришёл,
// hudImg() возвращает null, а вызывающий рисует тем, чем рисовал раньше.
const _hudImgs = Object.create(null);
let _hudReady = 0, _hudFailed = 0;

function hudImg(key) {
  let im = _hudImgs[key];
  if (im === undefined) {
    if (typeof HUD_ART === 'undefined' || !HUD_ART[key]) {
      // Опечатка в имени ассета иначе была бы просто пустым местом на экране —
      // молча, каждый кадр, до конца жизни сборки.
      console.warn('[hud] нет такого ассета: ' + key);
      _hudImgs[key] = null;
      return null;
    }
    im = new Image();
    im.onload = function () { _hudReady++; };
    im.onerror = function () {
      _hudFailed++;
      console.warn('[hud] не загрузился: ' + key);
    };
    im.src = HUD_ART_DIR + key + '.webp';
    _hudImgs[key] = im;
  }
  return (im && im.complete && im.naturalWidth > 0) ? im : null;
}

function hudPreload() {
  if (typeof HUD_ART === 'undefined') return;
  for (const k in HUD_ART) hudImg(k);
}

function hudArtStatus() {
  let total = 0;
  if (typeof HUD_ART !== 'undefined') for (const k in HUD_ART) total++;
  return { total: total, ready: _hudReady, failed: _hudFailed };
}

// ── рисование ──────────────────────────────────────────────────────────────
// Вписать по ДЛИННОЙ стороне в w×h и центрировать. Гайд к комплекту требует
// ровно этого: «не розтягувати елементи непропорційно».
function hudDraw(g, key, cx, cy, w, h, alpha) {
  const im = hudImg(key);
  if (!im) return false;
  const bh = (h == null) ? w : h;
  const k = Math.min(w / im.naturalWidth, bh / im.naturalHeight);
  const dw = im.naturalWidth * k, dh = im.naturalHeight * k;
  const a = (alpha == null) ? 1 : alpha;
  const prev = g.globalAlpha;
  if (a !== 1) g.globalAlpha = prev * a;
  g.drawImage(im, cx - dw / 2, cy - dh / 2, dw, dh);
  if (a !== 1) g.globalAlpha = prev;
  return true;
}

// Растянуть по ШИРИНЕ, высота по пропорции: для полос, где ширину задаёт
// экран, а не вкус.
function hudDrawW(g, key, cx, cy, w, alpha) {
  const a = (typeof HUD_ART !== 'undefined') && HUD_ART[key];
  if (!a) return false;
  return hudDraw(g, key, cx, cy, w, w * a.out[1] / a.out[0], alpha);
}

// Какой высоты выйдет кусок шириной w. Нужно ДО отрисовки — по этому
// считается раскладка, а картинка к тому моменту может ещё не приехать.
function hudHeightAt(key, w) {
  const a = (typeof HUD_ART !== 'undefined') && HUD_ART[key];
  return a ? w * a.out[1] / a.out[0] : 0;
}

// Посадочное место N внутри ассета, нарисованного в прямоугольнике r.
function hudSlot(key, i, r) {
  const a = (typeof HUD_ART !== 'undefined') && HUD_ART[key];
  if (!a || !a.slots || !a.slots[i]) return null;
  const s = a.slots[i];
  return { x: r.x + s[0] * r.w, y: r.y + s[1] * r.h, w: s[2] * r.w, h: s[3] * r.h };
}

// ── золото на кнопках ──────────────────────────────────────────────────────
// Текст на боевых кнопках должен читаться поверх чего угодно: под ним и тёмный
// камень, и подсвеченный аметист, и мир за полупрозрачной панелью. Поэтому это
// не заливка одним цветом, а тиснение: тёмная подложка со сдвигом вниз даёт
// край, вертикальный градиент — металл, обводка держит букву на светлом.
function hudGoldText(g, text, cx, cy, size, opts) {
  const o = opts || {};
  const f = o.font || 'Georgia, "Iowan Old Style", serif';
  g.save();
  g.font = (o.weight || '700') + ' ' + size + 'px ' + f;
  g.textAlign = o.align || 'center';
  g.textBaseline = 'middle';
  // Тень вниз, а не размытие вокруг: размытие на кегле 9–11 px съедает саму
  // букву и превращает надпись в жёлтое пятно.
  g.fillStyle = 'rgba(0,0,0,0.85)';
  g.fillText(text, cx, cy + Math.max(1, size * 0.08));
  const grd = g.createLinearGradient(0, cy - size * 0.6, 0, cy + size * 0.6);
  if (o.dim) {
    grd.addColorStop(0, '#8a7a55');
    grd.addColorStop(0.5, '#6d6045');
    grd.addColorStop(1, '#514735');
  } else {
    grd.addColorStop(0, '#f7e6bc');
    grd.addColorStop(0.45, '#e8c87e');
    grd.addColorStop(0.55, '#c9a86a');
    grd.addColorStop(1, '#a8873f');
  }
  g.fillStyle = grd;
  g.fillText(text, cx, cy);
  if (o.outline !== false) {
    g.lineWidth = Math.max(0.6, size * 0.055);
    g.strokeStyle = 'rgba(48,34,12,0.55)';
    g.strokeText(text, cx, cy);
  }
  g.restore();
}
