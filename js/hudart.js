'use strict';
// СГЕНЕРИРОВАНО dev/hud-assets.js — руками не править.
//
// Геометрия каждого куска HUD после обрезки по alpha bounds и сжатия.
// src   — размер исходного холста из присланного комплекта
// off   — где кусок лежал в этом холсте (для координат из гайда)
// box   — его размер там же
// out   — размер файла, который реально едет игроку
// css   — на сколько CSS-пикселей он рассчитан на телефоне 390 px
const HUD_ART_DIR = "/images/hud/";
const HUD_ART = {
  A1_stat_panel: { src: [1639, 959], off: [38, 44], box: [1567, 872], out: [516, 287], css: 172 },
  A2_map_panel: { src: [1200, 1310], off: [17, 0], box: [1165, 1267], out: [276, 300], css: 100 },
  A3_skill_fan: { src: [1254, 1254], off: [41, 16], box: [1161, 1184], out: [518, 528], css: 176 },
  A4_bottom_navigation_bar: { src: [2172, 724], off: [0, 118], box: [2172, 483], out: [1170, 260], css: 390 },
  A5_active_tab_plate: { src: [1254, 1254], off: [17, 28], box: [1220, 1189], out: [198, 193], css: 66 },
  A6_joystick_base: { src: [1254, 1254], off: [33, 0], box: [1184, 1189], out: [311, 312], css: 104 },
  A7_joystick_knob: { src: [1254, 1254], off: [325, 311], box: [603, 610], out: [125, 126], css: 42 },
  A8_chat_bar: { src: [1672, 941], off: [27, 244], box: [1617, 452], out: [714, 200], css: 238 },
  B10_zone_banner: { src: [2172, 724], off: [28, 183], box: [2116, 318], out: [444, 67], css: 148 },
  B11_menu_plate: { src: [1672, 940], off: [16, 206], box: [1639, 464], out: [186, 53], css: 62 },
  B12_amethyst_diamond_small: { src: [1254, 1254], off: [320, 278], box: [614, 651], out: [91, 96], css: 10 },
  B13_amethyst_diamond_medium: { src: [1254, 1254], off: [194, 154], box: [865, 946], out: [88, 96], css: 14 },
  B14_amethyst_diamond_large: { src: [1254, 1254], off: [62, 46], box: [1129, 1143], out: [95, 96], css: 20 },
  B1_portrait_ring: { src: [1233, 1275], off: [0, 0], box: [1233, 1231], out: [222, 222], css: 74 },
  B2_level_badge_ring: { src: [1254, 1254], off: [40, 5], box: [1174, 1182], out: [95, 96], css: 30 },
  B3_currency_plate: { src: [1983, 793], off: [19, 94], box: [1922, 522], out: [288, 78], css: 96 },
  B4_plus_button_plate: { src: [1254, 1254], off: [0, 0], box: [1254, 1234], out: [96, 94], css: 26 },
  B5_round_button_rim: { src: [1230, 1278], off: [2, 1], box: [1227, 1226], out: [120, 120], css: 40 },
  B6_skill_socket: { src: [1284, 1225], off: [47, 5], box: [1183, 1185], out: [126, 126], css: 42 },
  B7_consumable_slot: { src: [1254, 1254], off: [58, 59], box: [1138, 1101], out: [102, 99], css: 34 },
  B8_attack_ring: { src: [1287, 1222], off: [12, 0], box: [1263, 1207], out: [186, 178], css: 62 },
  B9_counter_badge: { src: [1271, 1237], off: [123, 79], box: [1025, 1045], out: [94, 96], css: 18 },
  C10_speech_bubble: { src: [1536, 1024], off: [278, 144], box: [981, 658], out: [96, 64], css: 22 },
  C11_single_broadsword: { src: [1295, 1214], off: [15, 31], box: [1221, 1080], out: [96, 85], css: 28 },
  C12_gold_coin: { src: [1254, 1254], off: [200, 111], box: [860, 992], out: [83, 96], css: 20 },
  C13_amethyst_gem: { src: [1218, 1292], off: [114, 53], box: [990, 1158], out: [82, 96], css: 20 },
  C14_ruby_gem: { src: [1254, 1254], off: [124, 44], box: [1005, 1102], out: [88, 96], css: 20 },
  C1_crossed_longswords: { src: [1254, 1254], off: [94, 50], box: [1066, 1149], out: [89, 96], css: 30 },
  C2_knight_bust: { src: [1221, 1288], off: [5, 11], box: [1212, 1266], out: [92, 96], css: 30 },
  C3_folded_map_pin: { src: [1254, 1254], off: [46, 56], box: [1162, 1053], out: [96, 87], css: 30 },
  C4_hourglass: { src: [1024, 1536], off: [205, 46], box: [615, 1433], out: [41, 96], css: 30 },
  C5_heraldic_shield_crest: { src: [1122, 1402], off: [105, 72], box: [910, 1263], out: [69, 96], css: 30 },
  C6_portrait_medallion_symbol: { src: [1168, 1347], off: [96, 29], box: [975, 1225], out: [76, 96], css: 30 },
  C7_armillary_globe: { src: [1254, 1254], off: [159, 142], box: [933, 961], out: [93, 96], css: 24 },
  C8_crosshair_reticle: { src: [1254, 1254], off: [46, 11], box: [1161, 1199], out: [93, 96], css: 24 },
  C9_plain_heater_shield: { src: [1122, 1402], off: [119, 29], box: [883, 1339], out: [63, 96], css: 16 },
  D1_attack_button: { src: [1254, 1254], off: [31, 17], box: [1191, 1169], out: [228, 224], css: 76 },
  D2_attack_mode_button: { src: [1254, 1254], off: [141, 135], box: [970, 959], out: [96, 95], css: 30 },
};

// ── загрузка ───────────────────────────────────────────────────────────────
// Ленивая, по первому обращению, и БЕЗ ожидания: HUD рисуется каждый кадр,
// и кадр, который ждёт картинку, — это подвисший кадр. Пока файл не пришёл,
// hudImg() возвращает null, а вызывающий рисует тем, чем рисовал раньше.
// Так первый кадр после входа выглядит как старый HUD, а не как дырка.
const _hudImgs = Object.create(null);
let _hudReady = 0, _hudFailed = 0;

function hudImg(key) {
  let im = _hudImgs[key];
  if (im === undefined) {
    if (!HUD_ART[key]) {
      // Опечатка в имени ассета иначе была бы просто пустым местом на
      // экране — молча, каждый кадр, до конца жизни сборки.
      console.warn("[hud] нет такого ассета: " + key);
      _hudImgs[key] = null;
      return null;
    }
    im = new Image();
    im.onload = function () { _hudReady++; };
    im.onerror = function () {
      _hudFailed++;
      console.warn("[hud] не загрузился: " + key);
    };
    im.src = HUD_ART_DIR + key + ".webp";
    _hudImgs[key] = im;
  }
  return (im && im.complete && im.naturalWidth > 0) ? im : null;
}

// Прогрев: всё, что нужно боевому экрану, одним махом при входе в мир,
// чтобы куски не проявлялись по одному у игрока на глазах.
function hudPreload() {
  for (const k in HUD_ART) hudImg(k);
}

// Сколько ассетов не доехало. Нужно наружу: пустой HUD и HUD из
// нарисованных кодом кругов выглядят по-разному, и понять, что именно
// случилось, должно быть можно без открытой вкладки сети.
function hudArtStatus() {
  let total = 0;
  for (const k in HUD_ART) total++;
  return { total: total, ready: _hudReady, failed: _hudFailed };
}

// ── рисование ──────────────────────────────────────────────────────────────
// Вписать по ДЛИННОЙ стороне в w×h и центрировать в (cx, cy). Гайд к
// комплекту требует ровно этого: «не розтягувати елементи непропорційно».
// Панель 1170×260 и ромб 91×96 идут через одну функцию, потому что она
// смотрит на пропорции самого куска, а не на то, куда его кладут.
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

// Растянуть по ШИРИНЕ, высота по пропорции. Для полос — навигации, чата,
// баннера зоны, — где ширина задана экраном, а не вкусом.
function hudDrawW(g, key, cx, cy, w, alpha) {
  const a = HUD_ART[key];
  if (!a) return false;
  return hudDraw(g, key, cx, cy, w, w * a.out[1] / a.out[0], alpha);
}

// Какой высоты выйдет кусок, растянутый до ширины w. Нужно ДО отрисовки:
// по этому считается раскладка, а картинка к тому моменту может ещё не
// приехать — поэтому берётся из таблицы, а не из Image.
function hudHeightAt(key, w) {
  const a = HUD_ART[key];
  return a ? w * a.out[1] / a.out[0] : 0;
}

// ── золото на кнопках ──────────────────────────────────────────────────────
// Текст на боевых кнопках должен читаться поверх чего угодно: под ним и
// тёмный камень, и подсвеченный аметист, и мир за полупрозрачной панелью.
// Поэтому это не заливка одним цветом, а тиснение: тёмная подложка со
// сдвигом вниз даёт край, вертикальный градиент — металл, обводка держит
// букву на светлом.
function hudGoldText(g, text, cx, cy, size, opts) {
  const o = opts || {};
  const f = o.font || "Forum, Georgia, serif";
  g.save();
  g.font = (o.weight || "700") + " " + size + "px " + f;
  g.textAlign = "center";
  g.textBaseline = "middle";
  // Тень вниз, а не размытие вокруг: размытие на кегле 9-11 px съедает
  // саму букву и превращает надпись в жёлтое пятно.
  g.fillStyle = "rgba(0,0,0,0.85)";
  g.fillText(text, cx, cy + Math.max(1, size * 0.08));
  const grd = g.createLinearGradient(0, cy - size * 0.6, 0, cy + size * 0.6);
  if (o.dim) {
    grd.addColorStop(0, "#8a7a55");
    grd.addColorStop(0.5, "#6d6045");
    grd.addColorStop(1, "#514735");
  } else {
    grd.addColorStop(0, "#f7e6bc");
    grd.addColorStop(0.45, "#e8c87e");
    grd.addColorStop(0.55, "#c9a86a");
    grd.addColorStop(1, "#a8873f");
  }
  g.fillStyle = grd;
  g.fillText(text, cx, cy);
  if (o.outline !== false) {
    g.lineWidth = Math.max(0.6, size * 0.055);
    g.strokeStyle = "rgba(48,34,12,0.55)";
    g.strokeText(text, cx, cy);
  }
  g.restore();
}

