#!/usr/bin/env node
'use strict';
// ═══════════════════════════════════════════════════════════════════════════
//  hud-assets.js — из присланного набора в то, что можно отдать телефону
// ═══════════════════════════════════════════════════════════════════════════
//
//   node dev/hud-assets.js            показать, что получится
//   APPLY=1 node dev/hud-assets.js    записать images/hud/ и js/hudart.js
//
// Присланный комплект — 41 файл, 50 МБ. Весь images/ игры до него весил 19.
// Каждый файл — PNG 1000–2200 px, а рисуется он в HUD размером 25–180 CSS px:
// иконка вкладки приходит как 1254×1254 и ставится в 34 px. Это не «немного
// с запасом», это в тысячу раз больше пикселей, чем дойдёт до экрана, и по
// сотовой сети Mini App с таким весом просто не откроется.
//
// Что делает конвейер, по порядку:
//
//   1. Режет по alpha bounds. Гайд к комплекту сам про это пишет: «для
//      визначення реальної геометрії використовуйте alpha bounds, а не повний
//      canvas». У A7_joystick_knob полезная часть — 603×610 в холсте
//      1254×1254, то есть 77% файла это прозрачные поля.
//   2. Уменьшает до размера, который реально нужен: CSS-размер в макете × 3
//      (запас под DPR 3 — это потолок среди телефонов, на которых в это
//      играют).
//   3. Кодирует в WebP. PNG держит альфу без потерь и платит за это втрое;
//      WebP с альфой умеют все webview, в которых открывается Mini App.
//
// И записывает js/hudart.js — таблицу с реальной геометрией каждого куска.
// Без неё код позиционировал бы ассеты по размеру холста, то есть по полям,
// которых в итоговом файле уже нет.
const fs = require('fs');
const path = require('path');

const SRC = process.env.SRC || 'F:/LibMMORPG_UI_Assets/output';
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'images', 'hud');
const APPLY = process.env.APPLY === '1';
const DPR = 3;

// Ширина в CSS-пикселях на телефоне 390 px — снята с макета 941×1672
// пропорцией, а не выдумана. Ключ — префикс имени файла.
//
// Здесь же решается, что вообще едет игроку: FULL_* это превью и готовые
// композиции из гайда. Они нужны человеку, чтобы свериться глазами, и не
// нужны рушію — он собирает то же самое из частей, потому что кнопки должны
// нажиматься и крутиться по отдельности.
const PLAN = {
  A1_stat_panel:            { css: 172 },
  A2_map_panel:             { css: 100 },
  A3_skill_fan:             { css: 176 },
  A4_bottom_navigation_bar: { css: 390 },
  A5_active_tab_plate:      { css: 66 },
  A6_joystick_base:         { css: 104 },
  A7_joystick_knob:         { css: 42 },
  A8_chat_bar:              { css: 238 },
  B1_portrait_ring:         { css: 74 },
  B2_level_badge_ring:      { css: 30 },
  B3_currency_plate:        { css: 96 },
  B4_plus_button_plate:     { css: 26 },
  B5_round_button_rim:      { css: 40 },
  B6_skill_socket:          { css: 42 },
  B7_consumable_slot:       { css: 34 },
  B8_attack_ring:           { css: 62 },
  B9_counter_badge:         { css: 18 },
  B10_zone_banner:          { css: 148 },
  B11_menu_plate:           { css: 62 },
  B12_amethyst_diamond_small:  { css: 10 },
  B13_amethyst_diamond_medium: { css: 14 },
  B14_amethyst_diamond_large:  { css: 20 },
  C1_crossed_longswords:    { css: 30 },
  C2_knight_bust:           { css: 30 },
  C3_folded_map_pin:        { css: 30 },
  C4_hourglass:             { css: 30 },
  C5_heraldic_shield_crest: { css: 30 },
  C6_portrait_medallion_symbol: { css: 30 },
  C7_armillary_globe:       { css: 24 },
  C8_crosshair_reticle:     { css: 24 },
  C9_plain_heater_shield:   { css: 16 },
  C10_speech_bubble:        { css: 22 },
  C11_single_broadsword:    { css: 28 },
  C12_gold_coin:            { css: 20 },
  C13_amethyst_gem:         { css: 20 },
  C14_ruby_gem:             { css: 20 },
  D1_attack_button:         { css: 76 },
  D2_attack_mode_button:    { css: 30 },

  // ── партия 2: кнопки с заливкой ─────────────────────────────────────────
  // Отличаются от первой тем, ради чего первая писалась: там внутри дыра,
  // потому что рушій кладёт туда своё. Здесь внутри стекло, а поверх идёт
  // только текст. Два предмета — E10 и E13 — остались сквозными.
  E1_small_pill_button:        { css: 96 },
  E2_small_pill_button_accent: { css: 96 },
  E3_wide_menu_row:            { css: 132 },
  E4_menu_button:              { css: 84 },
  E5_round_button:             { css: 56 },
  E6_round_button_crimson:     { css: 52 },
  E7_round_button_teal:        { css: 46 },
  E8_zone_banner_filled:       { css: 190 },
  E9_enemy_target_frame:       { css: 190 },
  E10_bar_track_hollow:        { css: 128 },
  E11_notification_badge_red:  { css: 18 },
  E12_notification_badge_blue: { css: 18 },
  E13_icon_socket_hollow:      { css: 46 },

  // ── партия 3: панели с непрозрачным фоном ───────────────────────────────
  // Заменяют A1/A2/B3 первой партии: у тех середина сквозная, и сквозь
  // шапку было видно подземелье — цифры баланса лежали прямо на нём.
  // A1/A2/B3 остаются в наборе как запасной путь, если F-файл не доедет.
  F1_character_stat_panel_opaque: { css: 172 },
  F2_map_panel_opaque:            { css: 100 },
  F3_currency_plate_opaque:       { css: 96 },
  F4_enemy_target_panel_hostile:  { css: 200 },
  F5_buff_rail_six_hollow:        { css: 132 },
  F6_buff_slot_hollow:            { css: 28 },
  F7_count_badge_opaque:          { css: 34 },

  // ── партия 4: вся шапка одной панелью ───────────────────────────────────
  // Заменяет F1 + F3 + F2 разом: панель статов, четыре плашки валют и карту.
  // Пропорция 2.61:1 — её задаёт сам ассет, и от неё считается высота шапки,
  // а не наоборот.
  G2_wide_header_with_map:        { css: 404 },
};

// Никогда не потолок: минимум под мелкие ромбы, иначе B12 приедет 30 px и
// на ретине будет мылом.
const MIN_PX = 96;

async function main() {
  const { chromium } = require('playwright');
  const files = fs.readdirSync(SRC).filter(f => /\.png$/i.test(f)).sort();
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const page = await browser.newPage();

  const rows = [];
  let srcTotal = 0, outTotal = 0, skipped = 0;

  for (const f of files) {
    const key = f.replace(/\.png$/i, '');
    const srcBytes = fs.statSync(path.join(SRC, f)).size;
    srcTotal += srcBytes;
    const plan = PLAN[key];
    if (!plan) { skipped++; continue; }

    const target = Math.max(MIN_PX, Math.round(plan.css * DPR));
    const b64 = fs.readFileSync(path.join(SRC, f)).toString('base64');

    const r = await page.evaluate(async ({ src, target }) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const W = img.naturalWidth, H = img.naturalHeight;
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, W, H).data;

      // Alpha bounds. Порог 8, а не 0: у краёв мягкая полупрозрачная кайма,
      // и по строгому нулю в обрезку попал бы почти весь холст.
      let x0 = W, y0 = H, x1 = -1, y1 = -1;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (d[(y * W + x) * 4 + 3] > 8) {
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
      }
      if (x1 < 0) return null;
      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;

      // Масштаб по ДЛИННОЙ стороне: панель 2172×483 и ромб 614×651 нельзя
      // мерить одинаково по ширине.
      const k = Math.min(1, target / Math.max(bw, bh));
      const ow = Math.max(1, Math.round(bw * k));
      const oh = Math.max(1, Math.round(bh * k));

      // Через промежуточный холст в размер bounds, чтобы уменьшение шло от
      // обрезанного куска, а не тянуло с собой пустые поля.
      const cut = document.createElement('canvas');
      cut.width = bw; cut.height = bh;
      cut.getContext('2d').drawImage(c, x0, y0, bw, bh, 0, 0, bw, bh);

      // Ступенями по половине: одношаговое уменьшение в 4+ раза даёт рванину
      // на тонкой золотой окантовке, а она тут — весь стиль.
      let cur = cut;
      while (cur.width > ow * 2 && cur.height > oh * 2) {
        const half = document.createElement('canvas');
        half.width = Math.max(ow, Math.round(cur.width / 2));
        half.height = Math.max(oh, Math.round(cur.height / 2));
        const hg = half.getContext('2d');
        hg.imageSmoothingQuality = 'high';
        hg.drawImage(cur, 0, 0, half.width, half.height);
        cur = half;
      }
      const fin = document.createElement('canvas');
      fin.width = ow; fin.height = oh;
      const fg = fin.getContext('2d');
      fg.imageSmoothingQuality = 'high';
      fg.drawImage(cur, 0, 0, ow, oh);

      // ── посадочные места ────────────────────────────────────────────────
      // Полностью прозрачные области ВНУТРИ фигуры: гнёзда умений, окно
      // портрета, поле карты, углубления вкладок. Гайд даёт координаты
      // ровно для двух из них; остальные нигде не записаны, а рисовать
      // контент надо во все.
      //
      // Область, касающаяся края bounds, — это фон вокруг фигуры, а не
      // дырка в ней, и она отбрасывается: иначе «гнездом» станет весь
      // воздух вокруг веера.
      const seen = new Uint8Array(W * H);
      const stack = new Int32Array(W * H);
      const slots = [];
      for (let sy = y0; sy <= y1; sy++) {
        for (let sx = x0; sx <= x1; sx++) {
          const si = sy * W + sx;
          if (seen[si] || d[si * 4 + 3] > 8) continue;
          let sp = 0; stack[sp++] = si; seen[si] = 1;
          let n = 0, mnx = W, mxx = -1, mny = H, mxy = -1, edge = false;
          while (sp) {
            const i = stack[--sp];
            const px = i % W, py = (i / W) | 0;
            n++;
            if (px < mnx) mnx = px; if (px > mxx) mxx = px;
            if (py < mny) mny = py; if (py > mxy) mxy = py;
            if (px <= x0 || px >= x1 || py <= y0 || py >= y1) edge = true;
            const nb = [i - 1, i + 1, i - W, i + W];
            for (let q = 0; q < 4; q++) {
              const j = nb[q];
              if (j < 0 || j >= W * H || seen[j]) continue;
              const jx = j % W, jy = (j / W) | 0;
              if (jx < x0 || jx > x1 || jy < y0 || jy > y1) continue;
              if (d[j * 4 + 3] > 8) continue;
              seen[j] = 1; stack[sp++] = j;
            }
          }
          // Порог в 400 пикселей отсекает крапины антиалиасинга по резьбе:
          // самое мелкое настоящее гнездо здесь — 94×95.
          if (edge || n < 400) continue;
          const hw = mxx - mnx + 1, hh = mxy - mny + 1;
          slots.push({
            cx: +((mnx + hw / 2 - x0) / bw).toFixed(4),
            cy: +((mny + hh / 2 - y0) / bh).toFixed(4),
            w: +(hw / bw).toFixed(4),
            h: +(hh / bh).toFixed(4),
            area: n,
          });
        }
      }
      // По площади: самое большое гнездо веера — место атаки, и код должен
      // находить его первым, не пересчитывая порядок обхода.
      slots.sort((a, b) => b.area - a.area);

      return {
        srcW: W, srcH: H, x0, y0, bw, bh, ow, oh,
        slots: slots.map(sl => [sl.cx, sl.cy, sl.w, sl.h]),
        webp: fin.toDataURL('image/webp', 0.92),
      };
    }, { src: 'data:image/png;base64,' + b64, target });

    if (!r) { console.log('  ! ' + f + ' — полностью прозрачный, пропущен'); continue; }

    const buf = Buffer.from(r.webp.slice(r.webp.indexOf(',') + 1), 'base64');
    outTotal += buf.length;
    rows.push({ key, ...r, bytes: buf.length, buf, css: plan.css });
  }

  await browser.close();

  console.log('\nимя                            исходник        →  в игру        экономия');
  for (const r of rows) {
    const save = (100 * (1 - r.bytes / fs.statSync(path.join(SRC, r.key + '.png')).size)).toFixed(0);
    console.log(
      r.key.padEnd(30) +
      `${r.srcW}×${r.srcH}`.padStart(10) + '  →' +
      `${r.ow}×${r.oh}`.padStart(10) + '  ' +
      `${(r.bytes / 1024).toFixed(0)} КБ`.padStart(8) + '  ' +
      `−${save}%`.padStart(6) + `   ${r.css} css`);
  }
  console.log('\n  исходников: ' + (srcTotal / 1048576).toFixed(1) + ' МБ'
    + '  ·  в игру: ' + (outTotal / 1024).toFixed(0) + ' КБ'
    + '  ·  не берём: ' + skipped + ' файлов (FULL_* — превью и готовые сборки)');

  if (!APPLY) { console.log('\n  ничего не записано — запусти с APPLY=1\n'); return; }

  fs.mkdirSync(OUT, { recursive: true });
  for (const r of rows) fs.writeFileSync(path.join(OUT, r.key + '.webp'), r.buf);

  // ── таблица геометрии ─────────────────────────────────────────────────────
  // Позиционировать ассет по размеру исходного холста нельзя: холста больше
  // нет, он обрезан. Здесь лежит то, что осталось, и куда оно попадало в
  // исходнике — второе нужно, чтобы посадочные места из гайда (координаты в
  // системе 1254×1254) пересчитывались, а не подгонялись на глаз.
  const lines = [
    "'use strict';",
    '// СГЕНЕРИРОВАНО dev/hud-assets.js — руками не править.',
    '//',
    '// Геометрия каждого куска HUD после обрезки по alpha bounds и сжатия.',
    '// src   — размер исходного холста из присланного комплекта',
    '// off   — где кусок лежал в этом холсте (для координат из гайда)',
    '// box   — его размер там же',
    '// out   — размер файла, который реально едет игроку',
    '// css   — на сколько CSS-пикселей он рассчитан на телефоне 390 px',
    '// slots — посадочные места под контент: [cx, cy, w, h] в ДОЛЯХ от куска,',
    '//         по убыванию площади. Измерены заливкой по прозрачности, а не',
    '//         вписаны руками: гайд к комплекту называет координаты только',
    '//         двух гнёзд веера, а рисовать надо во все.',
    'const HUD_ART_DIR = "/images/hud/";',
    'const HUD_ART = {',
  ];
  for (const r of rows) {
    const slots = r.slots.length
      ? `, slots: [${r.slots.map(sl => '[' + sl.join(',') + ']').join(', ')}]` : '';
    lines.push(`  ${r.key}: { src: [${r.srcW}, ${r.srcH}], off: [${r.x0}, ${r.y0}], `
      + `box: [${r.bw}, ${r.bh}], out: [${r.ow}, ${r.oh}], css: ${r.css}${slots} },`);
  }
  lines.push('};', '');
  fs.writeFileSync(path.join(ROOT, 'js', 'hudart.js'), lines.join('\n'));

  console.log('\n  записано: images/hud/ (' + rows.length + ' файлов) и js/hudart.js\n');
}

main().catch(e => { console.error(e); process.exit(1); });
