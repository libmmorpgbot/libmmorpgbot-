// ── SVG Icon Library ─────────────────────────────────────────────────────────
// All icons: 24×24 viewBox, stroke-based, no fill, rounded caps.
// Usage in DOM:  iconHTML('name', size?, color?)
// Usage on canvas: drawIconCtx(ctx, 'name', cx, cy, size, color?)

const ICON_SVG = {
  // ── Navigation / UI ────────────────────────────────────────────────────────
  game:      `<path d="M14.5 17.5L3 6V3h3l11.5 11.5"/><path d="M13 19l6-6"/><path d="M16 16l4 4"/><line x1="19" y1="21" x2="21" y2="19"/>`,
  inventory: `<path d="M4 20V10a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><line x1="8" y1="12" x2="16" y2="12"/>`,
  map:       `<polygon points="3,6 9,3 15,6 21,3 21,18 15,21 9,18 3,21"/><line x1="9" y1="3" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="21"/>`,
  quests:    `<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><line x1="8" y1="7" x2="16" y2="7"/><line x1="8" y1="11" x2="16" y2="11"/><line x1="8" y1="15" x2="12" y2="15"/>`,
  upgrade:   `<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>`,
  skull:     `<circle cx="12" cy="8" r="5"/><path d="M9 17v-2a3 3 0 0 1 6 0v2"/><line x1="9" y1="21" x2="15" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>`,
  chat:      `<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>`,

  // ── Stats ──────────────────────────────────────────────────────────────────
  heart:     `<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>`,
  shield:    `<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>`,
  sword:     `<path d="M14.5 17.5L3 6V3h3l11.5 11.5"/><path d="M13 19l6-6"/><path d="M16 16l4 4"/><line x1="19" y1="21" x2="21" y2="19"/>`,
  lightning: `<polygon points="13,2 3,14 12,14 11,22 21,10 12,10"/>`,
  star:      `<polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26"/>`,
  flame:     `<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>`,
  wind:      `<path d="M17.7 7.7a2.5 2.5 0 1 1 1.8 4.3H2"/><path d="M9.6 4.6A2 2 0 1 1 11 8H2"/><path d="M12.6 19.4A2 2 0 1 0 14 16H2"/>`,
  crosshair: `<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/><line x1="22" y1="12" x2="18" y2="12"/><line x1="6" y1="12" x2="2" y2="12"/><line x1="12" y1="6" x2="12" y2="2"/><line x1="12" y1="22" x2="12" y2="18"/>`,
  drop:      `<path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/>`,
  hpPlus:    `<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>`,
  coin:      `<circle cx="12" cy="12" r="9"/><path d="M12 7v10"/><path d="M15 9.5a3 3 0 0 0-6 0c0 1.5 1 2.2 3 3 2 .8 3 1.5 3 3a3 3 0 0 1-6 0"/>`,
  potion:    `<path d="M9 3h6"/><path d="M9 3v4.5L4 14a2 2 0 0 0 1.76 2.95h12.48A2 2 0 0 0 20 14l-5-6.5V3"/><line x1="7" y1="12" x2="17" y2="12"/>`,
  target:    `<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>`,

  // ── Equipment Slots ────────────────────────────────────────────────────────
  weapon:    `<line x1="5" y1="19" x2="19" y2="5"/><polyline points="15,5 19,5 19,9"/><line x1="10" y1="14" x2="8" y2="16"/>`,
  offhand:   `<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>`,
  bow:       `<path d="M6 3a9 9 0 0 0 0 18"/><line x1="6" y1="12" x2="21" y2="12"/><polyline points="17,8 21,12 17,16"/>`,
  staff:     `<circle cx="12" cy="5" r="3"/><line x1="12" y1="8" x2="12" y2="22"/><path d="M9 14l3-2 3 2"/>`,
  helmet:    `<path d="M2 13C2 7 6.5 2 12 2s10 5 10 11v2H2v-2z"/><rect x="2" y="15" width="20" height="4" rx="2"/>`,
  body:      `<path d="M20 7l-8-4-8 4v12l8 4 8-4V7z"/><line x1="12" y1="3" x2="12" y2="19"/>`,
  legs:      `<path d="M9 2v11l-2.5 9h5l2.5-9V2"/><path d="M9 2h6"/><path d="M15 13l2.5 9h-5"/>`,
  gloves:    `<path d="M18 11V6a2 2 0 0 0-4 0m-4 0V4a2 2 0 0 0-4 0v8"/><path d="M18 11a2 2 0 0 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/><line x1="14" y1="6" x2="14" y2="11"/>`,
  boots:     `<path d="M4 10V5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v5"/><path d="M4 10h9"/><path d="M4 10c0 4 3 7 9 8h3a2 2 0 0 0 2-2v-2a2 2 0 0 0-2-2h-3"/>`,
  ring:      `<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/>`,
  belt:      `<rect x="2" y="10" width="20" height="4" rx="1"/><rect x="10" y="9" width="4" height="6" rx="0.5"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/>`,
  pendant:   `<path d="M12 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/><path d="M9.5 7.5L7 22h10L14.5 7.5"/>`,
  pet:       `<circle cx="7" cy="6" r="1.8"/><circle cx="12" cy="4.5" r="1.8"/><circle cx="17" cy="6" r="1.8"/><circle cx="19" cy="10.5" r="1.8"/><path d="M8.5 21c-2 0-3.5-1.4-3.5-3.4 0-3.6 3.6-6.6 7-6.6s7 3 7 6.6c0 2-1.5 3.4-3.5 3.4-1.3 0-2-.5-3.5-.5s-2.2.5-3.5.5z"/>`,
  cloak:     `<path d="M12 4a4 4 0 0 0-4 4v1L4.5 20h15L16 9V8a4 4 0 0 0-4-4z"/>`,
  wings:     `<path d="M12 6v12"/><path d="M11 8C8 5 5 5 3 7c2 1 3 3 3 5 0 2-1 4-3 5 2 2 5 2 8-1z"/><path d="M13 8c3-3 6-3 8-1-2 1-3 3-3 5 0 2 1 4 3 5-2 2-5 2-8-1z"/>`,
  artifact:  `<polygon points="12,4 20,11 12,20 4,11"/><line x1="4" y1="11" x2="20" y2="11"/><line x1="12" y1="4" x2="9" y2="11"/><line x1="12" y1="4" x2="15" y2="11"/>`,

  // ── Skills — Warrior ───────────────────────────────────────────────────────
  shieldBash: `<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9,12 11,14 15,10"/>`,
  whirlwind:  `<path d="M21 12a9 9 0 0 0-9-9c-3 0-5.4 1.4-7 3.5"/><path d="M3 12a9 9 0 0 0 9 9c3 0 5.4-1.4 7-3.5"/><polyline points="5,6.5 5,3 8.5,3"/><polyline points="19,17.5 19,21 15.5,21"/>`,
  battleCry:  `<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z"/><path d="M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>`,
  dash:       `<path d="M13 17l5-5-5-5"/><path d="M6 17l5-5-5-5"/>`,

  // ── Skills — Lev ───────────────────────────────────────────────────────────
  kick: `<path d="M8 2v10l-5.2 3.9A2 2 0 0 0 2 17.5V19a1 1 0 0 0 1 1h15a1 1 0 0 0 1-1c0-3.3-2.7-6-6-6h-1V2H8z"/><line x1="8" y1="6" x2="12" y2="6"/>`,

  // ── Skills — Archer ────────────────────────────────────────────────────────
  multiShot:  `<line x1="3" y1="7" x2="21" y2="7"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="17" x2="21" y2="17"/><polyline points="17,3 21,7 17,11"/><polyline points="17,8 21,12 17,16"/>`,
  poisonArrow:`<line x1="5" y1="19" x2="19" y2="5"/><polyline points="15,5 19,5 19,9"/><circle cx="7" cy="17" r="3"/>`,
  roll:       `<path d="M12 3c4.97 0 9 4.03 9 9"/><polyline points="21,3 21,12 12,12"/><path d="M12 21C7.03 21 3 16.97 3 12"/>`,
  arrowRain:  `<line x1="8" y1="2" x2="8" y2="14"/><line x1="12" y1="2" x2="12" y2="14"/><line x1="16" y1="2" x2="16" y2="14"/><polyline points="6,11 8,14 10,11"/><polyline points="10,11 12,14 14,11"/><polyline points="14,11 16,14 18,11"/><line x1="3" y1="18" x2="21" y2="18"/>`,

  // ── Skills — Mage ──────────────────────────────────────────────────────────
  fireball:  `<circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="5"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="4.22" y1="4.22" x2="6.34" y2="6.34"/><line x1="17.66" y1="17.66" x2="19.78" y2="19.78"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/><line x1="4.22" y1="19.78" x2="6.34" y2="17.66"/><line x1="17.66" y1="6.34" x2="19.78" y2="4.22"/>`,
  iceNova:   `<line x1="2" y1="12" x2="22" y2="12"/><line x1="12" y1="2" x2="12" y2="22"/><path d="M20 16l-4-4 4-4"/><path d="M4 8l4 4-4 4"/><path d="M16 4l-4 4-4-4"/><path d="M8 20l4-4 4 4"/>`,
  barrier:   `<path d="M12 3L3 8v7c0 5 3.5 8.3 9 10 5.5-1.7 9-5 9-10V8L12 3z"/>`,
  teleport:  `<path d="M5 3h14"/><path d="M5 21h14"/><line x1="12" y1="3" x2="12" y2="8"/><line x1="12" y1="16" x2="12" y2="21"/><polyline points="9,8 12,11 15,8"/><polyline points="9,16 12,13 15,16"/>`,

  // ── Character Classes ──────────────────────────────────────────────────────
  warrior:    `<path d="M14.5 17.5L3 6V3h3l11.5 11.5"/><path d="M13 19l6-6"/><path d="M16 16l4 4"/><line x1="19" y1="21" x2="21" y2="19"/>`,
  archerClass:`<path d="M6 3a9 9 0 0 0 0 18"/><line x1="6" y1="12" x2="21" y2="12"/><polyline points="17,8 21,12 17,16"/>`,
  mageClass:  `<circle cx="12" cy="12" r="5"/><line x1="12" y1="3" x2="12" y2="7"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="3" y1="12" x2="7" y2="12"/><line x1="17" y1="12" x2="21" y2="12"/>`,
  lev:        `<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="12" y1="6" x2="12" y2="16"/><line x1="9" y1="9" x2="15" y2="9"/>`,

  // ── NPCs ───────────────────────────────────────────────────────────────────
  merchant:   `<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>`,
  craftsman:  `<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>`,
  storage:    `<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9,22 9,12 15,12 15,22"/>`,

  // ── PvP ────────────────────────────────────────────────────────────────────
  pvpOn:  `<path d="M14.5 17.5L3 6V3h3l11.5 11.5"/><path d="M13 19l6-6"/><path d="M16 16l4 4"/><line x1="19" y1="21" x2="21" y2="19"/>`,
  pvpOff: `<path d="M3 3l18 18"/><line x1="15" y1="9" x2="9" y2="3"/><polyline points="11,3 15,3 15,7"/>`,

  // ── Party ──────────────────────────────────────────────────────────────────
  party:      `<circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/><path d="M21 21v-2a4 4 0 0 0-3-3.85"/>`,
  partyLeave: `<circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/><line x1="17" y1="8" x2="23" y2="14"/><line x1="23" y1="8" x2="17" y2="14"/>`,

  // ── Materials ──────────────────────────────────────────────────────────────
  mat_iron:    `<rect x="3" y="8" width="18" height="8" rx="2"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="7" y1="8" x2="7" y2="16"/>`,
  mat_leather: `<path d="M12 2L4 8v8l8 6 8-6V8L12 2z"/><line x1="12" y1="2" x2="12" y2="22"/>`,
  mat_gem:     `<path d="M6 3l-3 5 9 13 9-13-3-5H6z"/><line x1="3" y1="8" x2="21" y2="8"/>`,
  mat_scale:   `<circle cx="12" cy="12" r="9"/><path d="M12 3c-3 3-5 6-5 9s2 6 5 9"/><path d="M12 3c3 3 5 6 5 9s-2 6-5 9"/>`,
  mat_dust:    `<path d="M12 2l1.5 4.5H18l-3.75 2.7 1.5 4.5L12 11.1l-3.75 2.6 1.5-4.5L6 6.5h4.5z"/><path d="M5 16l.75 2.25H8l-1.88 1.35.75 2.25L5 20.55l-1.88 1.3.75-2.25L2 18.25h2.25z"/>`,
  key:         `<circle cx="7.5" cy="15.5" r="5.5"/><path d="M11.5 11.5L21 2"/><path d="M15 6l3 3"/><path d="M18 3l3 3"/>`,
  chest:       `<rect x="3" y="10" width="18" height="10" rx="2"/><path d="M3 10a9 4 0 0 1 18 0"/><line x1="12" y1="10" x2="12" y2="14"/><circle cx="12" cy="15" r="1.6"/>`,
  book:        `<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17H6.5A2.5 2.5 0 0 0 4 21.5"/><path d="M4 4.5v17"/><line x1="9" y1="7" x2="16" y2="7"/><line x1="9" y1="11" x2="16" y2="11"/>`,

  // Конверт для кнопки «Письмо» (drawMailBonusButton, js/ui.js). Своего
  // символа у неё не было, а chat — это пузырь речи: рядом с кнопкой чата
  // в том же HUD две одинаковые иконки читались бы как одна кнопка дважды.
  mail:        `<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>`,

  // ── Lock (studied/locked skill overlay) ─────────────────────────────────────
  lock:        `<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>`,

  // ── Events panel (index.html's #events-tab-list) ────────────────────────────
  ghost: `<path d="M12 2a7 7 0 0 0-7 7v12l2.5-2.5L10 21l2-2 2 2 2.5-2.5L19 21V9a7 7 0 0 0-7-7z"/><circle cx="9.5" cy="10" r="1"/><circle cx="14.5" cy="10" r="1"/>`,
  crown: `<path d="M3 8L7 11L12 5L17 11L21 8L19 18H5L3 8Z"/><line x1="5" y1="21" x2="19" y2="21"/>`,
  flag:  `<line x1="5" y1="21" x2="5" y2="3"/><path d="M5 4l13 4-13 4z"/>`,
};

// ── DOM helper: returns an <svg> string ───────────────────────────────────────
function iconHTML(name, size = 20, color = 'currentColor') {
  const p = ICON_SVG[name];
  if (!p) return '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" stroke="${color}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;flex-shrink:0">${p}</svg>`;
}

// ── Canvas helper: cached HTMLImageElement ────────────────────────────────────
const _iconImgCache = {};

function _getIconImg(name, strokeColor, px) {
  const key = `${name}|${strokeColor}|${px}`;
  if (_iconImgCache[key]) return _iconImgCache[key];
  const p = ICON_SVG[name];
  if (!p) return null;
  const sw = Math.max(1.5, 2 * (24 / px));
  const svgStr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${px}" height="${px}" stroke="${strokeColor}" stroke-width="${sw}" fill="none" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  const blob = new Blob([svgStr], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const img = new Image(px, px);
  img.onload = () => URL.revokeObjectURL(url);
  img.src = url;
  _iconImgCache[key] = img;
  return img;
}

// Draw icon centered at (cx, cy) on canvas context `c`
function drawIconCtx(c, name, cx, cy, size, color) {
  const px = Math.ceil(size * 2); // 2× for crispness on DPR screens
  const img = _getIconImg(name, color || 'white', px);
  if (!img || !img.complete || img.naturalWidth === 0) return;
  c.drawImage(img, cx - size / 2, cy - size / 2, size, size);
}
