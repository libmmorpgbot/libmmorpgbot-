// ── Монстры «Пограничья» ─────────────────────────────────────
// Объёмные спрайты с 8 направлениями и анимациями (стойка, бег, удар,
// попадание, смерть). Данные кадров — PM_SPR (js/pm-data.js), атласы —
// images/pm/<вид>.webp, уменьшенные под размер на экране, чтобы не грузить
// телефон. Атлас вида грузится только когда такой монстр появился рядом.
//
// Видов 19, монстров в Liberty больше — недостающих рисуем теми же видами,
// но в другом цвете и размере.

const PM_VER = 1;
// eid → [вид, оттенок, множитель роста]
const PM_MONSTER = {
  rat_guard:         ['goblin'],
  rat_warrior:       ['goblin_elite'],
  slime_guard:       ['antlion', 0xb8ffb0, 0.85],
  slime_warrior:     ['antlion', 0x8fe0a0],
  imp_guard:         ['fire_ant', 0, 0.9],
  imp_warrior:       ['vesuvvio', 0, 1.05],
  imp_boss:          ['fire_ant', 0xffc090, 1.25],
  zombie_guard:      ['zombie'],
  zombie_warrior:    ['zombie', 0xb8e09a, 1.05],
  lizardman_guard:   ['hobgoblin', 0xb8f0b0],
  lizardman_warrior: ['hobgoblin_archer', 0xb8f0b0],
  orc_guard:         ['grisbon', 0, 1.05],
  orc_warrior:       ['scathelocke', 0, 1.1],
  orc_boss:          ['minotaur'],
  plant_guard:       ['antlion', 0x90e070],
  plant_warrior:     ['antlion_armored', 0xa8e890, 0.9],
  vampire_guard:     ['wyvern', 0xd0a0ff, 0.85],
  vampire_warrior:   ['necromancer', 0, 1.1],
  beholder_guard:    ['skeleton_mage'],
  beholder_warrior:  ['skeleton_archer'],
  beholder_boss:     ['skeleton_mage_high_boss'],
  ent_guard:         ['antlion_armored', 0xd0b080, 0.95],
  ent_warrior:       ['minotaur', 0xc8a882, 0.95],
  demon_guard:       ['skeleton', 0xffa090],
  demon_warrior:     ['skeleton_knight_boss', 0xff9080, 0.95],
  demon_boss:        ['wyvern', 0xff7060, 1.2],
  demon_event_boss:  ['wyvern', 0xff7060, 1.2],
  race10_boss:       ['minotaur', 0xff9070, 1.1],
  dungeon_lich_skeleton:  ['skeleton_knight_boss'],
  dungeon_lich_blue:      ['skeleton_mage_high_boss', 0x9ccfff],
  dungeon_lich_commander: ['skeleton_knight_boss', 0x9cb4ff, 1.08],
};

// Атласы и кадры: вид → { base, tex[] } после загрузки.
const _pmSheets = new Map();
function _pmSheet(kind) {
  let s = _pmSheets.get(kind);
  if (s) return s.ready ? s : null;
  const d = typeof PM_SPR !== 'undefined' ? PM_SPR[kind] : null;
  if (!d || typeof PIXI === 'undefined') return null;
  s = { ready: false, tex: null, d };
  _pmSheets.set(kind, s);
  const img = new Image();
  img.decoding = 'async';
  img.onload = () => {
    const bt = PIXI.BaseTexture.from(img);
    const f = d.f, n = f.length / 6, tex = new Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * 6;
      tex[i] = new PIXI.Texture(bt, new PIXI.Rectangle(f[o], f[o + 1], Math.max(1, f[o + 2]), Math.max(1, f[o + 3])),
        null, null, 0, new PIXI.Point(f[o + 4] / Math.max(1, f[o + 2]), f[o + 5] / Math.max(1, f[o + 3])));
    }
    s.tex = tex; s.ready = true;
  };
  img.onerror = () => { _pmSheets.delete(kind); };
  img.src = '/images/pm/' + kind + '.webp?v=' + PM_VER;
  return null;
}

// Направление 0..7 (0 — запад, дальше против часовой по экрану: ЮЗ, Ю, ЮВ,
// В, СВ, С, СЗ) по вектору взгляда.
function pmDir(dx, dy) {
  const a = Math.atan2(dy, dx);
  return ((4 - Math.round(a / (Math.PI / 4))) % 8 + 8) % 8;
}

// Номер кадра анимации an=[start,count,ms,mode] за время t (сек).
function _pmFrame(an, t) {
  const n = an[1], dur = an[2] / 1000;
  if (n <= 1) return an[0];
  const mode = an[3];
  let k;
  if (mode === 'once') k = Math.min(n - 1, Math.floor(t / dur * n));
  else if (mode === 'bf') {
    const per = 2 * n - 2, i = Math.floor(t / dur * n) % per;
    k = i < n ? i : per - i;
  } else k = Math.floor(t / dur * n) % n;
  return an[0] + k;
}
