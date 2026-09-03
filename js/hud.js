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

// ── золото → сталь, одним поворотом оттенка ─────────────────────────────────
// Комплект нарисован тёплым золотом «факельного подземелья». Синяя тема не
// переиздаёт полсотни картинок заново — она поворачивает оттенок каждой
// один раз при первом обращении и держит результат в своём холсте: тот же
// приём, каким фотографии перекрашивают целиком, сохраняя всю светотень,
// блики и тени — меняется только сам цвет металла.
//
// Число откалибровано по трём цветам, которые эта же перекраска подобрала
// вручную для CSS-токенов (--gold/--gold-hi/--iron, css/style.css) — не
// круглое само по себе, а лучшее совпадение с ними. CSS-сторона держит тот
// же градус в переменной --hud-tint, чтобы холст и разметка не разъезжались.
const HUD_TINT_DEG = 150;
// Горстка кусков раскрашена НАРОЧНО — это не золото, а свой сигнальный цвет:
// алая кнопка «Цель», багровая рамка вражеской цели, бирюзовый телепорт,
// цветные значки уведомлений, фиолетовый шар кнопки атаки. Поворот оттенка
// стёр бы именно то, зачем они такие — единственный способ издалека узнать,
// что это за кнопка, — поэтому эти ключи рисуются как есть.
const HUD_TINT_SKIP = new Set([
  'D1_attack_button', 'D2_attack_mode_button',
  'E6_round_button_crimson', 'E7_round_button_teal',
  'E9_enemy_target_frame', 'E11_notification_badge_red',
  'E12_notification_badge_blue', 'F4_enemy_target_panel_hostile',
]);
const _hudTinted = Object.create(null);

function _hudTint(im, key) {
  if (HUD_TINT_SKIP.has(key)) return im;
  let cv = _hudTinted[key];
  if (cv !== undefined) return cv;
  const w = im.naturalWidth, h = im.naturalHeight;
  if (!w || !h) return im; // не должно случиться (вызывающий уже проверил complete), но лучше исходник, чем пустой холст
  cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  g.filter = `hue-rotate(${HUD_TINT_DEG}deg)`;
  g.drawImage(im, 0, 0);
  // hudDraw/hudDrawW меряют im.naturalWidth/naturalHeight — у канваса таких
  // свойств нет, поэтому им подкладываются те же числа, что ответил бы
  // обычный <img>. Ни одно из ~40 мест вызова этого не замечает.
  cv.naturalWidth = w; cv.naturalHeight = h;
  _hudTinted[key] = cv;
  return cv;
}

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
  if (!(im && im.complete && im.naturalWidth > 0)) return null;
  return _hudTint(im, key);
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

// ── сталь на кнопках ───────────────────────────────────────────────────────
// Текст на боевых кнопках должен читаться поверх чего угодно: под ним и тёмный
// камень, и подсвеченный аметист, и мир за полупрозрачной панелью. Поэтому это
// не заливка одним цветом, а тиснение: тёмная подложка со сдвигом вниз даёт
// край, вертикальный градиент — металл, обводка держит букву на светлом.
//
// Раньше это было золотое тиснение (отсюда прежнее имя функции); ступени
// градиента прогнаны через тот же поворот оттенка на HUD_TINT_DEG, что и
// картинки комплекта (см. _hudTint выше), — тем же числом, посчитанным
// вручную по формуле CSS hue-rotate, а не «на глаз», чтобы текст на кнопке и
// золотая рамка под ней сходились в один и тот же оттенок стали.
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
    grd.addColorStop(0, '#5b8294');
    grd.addColorStop(0.5, '#486673');
    grd.addColorStop(1, '#364c54');
  } else {
    grd.addColorStop(0, '#c3eeff');
    grd.addColorStop(0.45, '#89d8fc');
    grd.addColorStop(0.55, '#70b8d3');
    grd.addColorStop(1, '#4997b9');
  }
  g.fillStyle = grd;
  g.fillText(text, cx, cy);
  if (o.outline !== false) {
    g.lineWidth = Math.max(0.6, size * 0.055);
    g.strokeStyle = 'rgba(12,30,42,0.55)';
    g.strokeText(text, cx, cy);
  }
  g.restore();
}
