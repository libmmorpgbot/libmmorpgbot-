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
  // Was 4 hand-drawn stroke glyphs here (plus a further 7 replacing their
  // two look-alike pairs one commit ago) — CHAR_DEF now points every class
  // at real artwork instead (iconImg, shared/definitions.js; drawn via
  // drawClassIconCtx/drawClassBadgeCtx below), owner-supplied and swapped in
  // by request. Nothing reads a class by an ICON_SVG key any more, so the
  // vector glyphs are gone rather than left as dead entries.

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

  // ── Enchanting (item-modal enhance panel, js/ui.js) ─────────────────────────
  // Blacksmith hammer for the "⚒ Заточка" button — a rotated square head plus
  // the same diagonal-handle-with-guard shape `sword`/`weapon` already use
  // above, so it reads as the same family of icon rather than a one-off.
  hammer: `<rect x="13" y="2" width="8" height="5" rx="1.2" transform="rotate(45 17 4.5)"/><path d="M13.5 8.5L4 18"/><path d="M2.5 19.5l3 3"/>`,
  // Success/fail/burn indicators for the enhance result reveal — plain
  // circle-with-mark glyphs, same construction as `hpPlus`/`crosshair` above,
  // so a big colored one reads clearly at the result-banner size.
  checkCircle: `<circle cx="12" cy="12" r="9"/><polyline points="8,12.3 11,15.3 16,8.7"/>`,
  xCircle: `<circle cx="12" cy="12" r="9"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/>`,
  burst: `<path d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8z"/><line x1="3.5" y1="19" x2="5.5" y2="17"/><line x1="20.5" y1="19" x2="18.5" y2="17"/><line x1="12" y1="18.5" x2="12" y2="21.5"/>`,

  // ── Замена эмодзи (EMOJI_ICON ниже) ─────────────────────────────────────────
  // Тот же рисунок, что у всей библиотеки: контур 2px, скруглённые концы,
  // без заливки. Каждая — вместо одного-двух эмодзи, которые раньше стояли в
  // текстах интерфейса и выглядели по-разному на каждом телефоне.
  skullFace: `<circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><path d="M8 20v2h8v-2"/><path d="m12.5 17-.5-1-.5 1h1z"/><path d="M16 20a2 2 0 0 0 1.56-3.25 8 8 0 1 0-11.12 0A2 2 0 0 0 8 20"/>`,
  trophy:    `<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>`,
  swords:    `<polyline points="14.5,17.5 3,6 3,3 6,3 17.5,14.5"/><line x1="13" y1="19" x2="19" y2="13"/><line x1="16" y1="16" x2="20" y2="20"/><line x1="19" y1="21" x2="21" y2="19"/><polyline points="14.5,6.5 18,3 21,3 21,6 17.5,9.5"/><line x1="5" y1="14" x2="9" y2="18"/><line x1="7" y1="17" x2="4" y2="20"/><line x1="3" y1="19" x2="5" y2="21"/>`,
  dagger:    `<path d="M20 4l-9.5 9.5"/><path d="M20 4h-3.5L8.5 12"/><path d="M20 4v3.5L12 15.5"/><path d="M6.5 13.5l4 4"/><path d="M8.5 15.5L4 20"/>`,
  hourglass: `<path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.17a2 2 0 0 0-.59-1.42L12 12l-4.41 4.41A2 2 0 0 0 7 17.83V22"/><path d="M7 2v4.17a2 2 0 0 0 .59 1.42L12 12l4.41-4.41A2 2 0 0 0 17 6.17V2"/>`,
  timer:     `<line x1="10" y1="2" x2="14" y2="2"/><line x1="12" y1="14" x2="15" y2="11"/><circle cx="12" cy="14" r="8"/>`,
  castle:    `<path d="M22 20v-9H2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2Z"/><path d="M18 11V4H6v7"/><path d="M15 22v-4a3 3 0 0 0-6 0v4"/><path d="M22 11V9"/><path d="M2 11V9"/><path d="M6 4V2"/><path d="M18 4V2"/><path d="M10 4V2"/><path d="M14 4V2"/>`,
  portal:    `<path d="M12 12.5a1.5 1.5 0 1 1 1.5-1.5"/><path d="M13.5 11a3.5 3.5 0 1 1-3.5-3.5"/><path d="M10 7.5a6 6 0 1 1-6 6"/><path d="M4 13.5A8.5 8.5 0 0 1 12.5 5"/>`,
  gift:      `<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5"/>`,
  wheat:     `<path d="M2 22 16 8"/><path d="M3.47 12.53 5 11l1.53 1.53a3.5 3.5 0 0 1 0 4.94L5 19l-1.53-1.53a3.5 3.5 0 0 1 0-4.94Z"/><path d="M7.47 8.53 9 7l1.53 1.53a3.5 3.5 0 0 1 0 4.94L9 15l-1.53-1.53a3.5 3.5 0 0 1 0-4.94Z"/><path d="M11.47 4.53 13 3l1.53 1.53a3.5 3.5 0 0 1 0 4.94L13 11l-1.53-1.53a3.5 3.5 0 0 1 0-4.94Z"/><path d="M20 2h2v2a4 4 0 0 1-4 4h-2V6a4 4 0 0 1 4-4Z"/>`,
  ticket:    `<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/>`,
  moneyBag:  `<path d="M9 3h6l-1.5 3h-3z"/><path d="M10.5 6C6 8 4 12 4 15.5 4 19 7 21 12 21s8-2 8-5.5C20 12 18 8 13.5 6"/><path d="M14 11.5c-.4-.8-1.2-1-2-1-1.1 0-2 .6-2 1.5s.9 1.3 2 1.5 2 .6 2 1.5-.9 1.5-2 1.5c-.8 0-1.6-.3-2-1"/><path d="M12 9.5v1"/><path d="M12 16.5v1"/>`,
  demon:     `<path d="M5 3l2.5 4.5"/><path d="M19 3l-2.5 4.5"/><path d="M12 21c-4.4 0-7-3.1-7-7.5S7.6 6 12 6s7 3.1 7 7.5-2.6 7.5-7 7.5z"/><path d="M8.5 12l2 1"/><path d="M15.5 12l-2 1"/><path d="M9 17c1.8-1 4.2-1 6 0"/>`,
  scroll:    `<path d="M15 12h-5"/><path d="M15 8h-5"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/>`,
  medal:     `<path d="M7.21 15 2.66 7.14a2 2 0 0 1 .13-2.2L4.4 2.8A2 2 0 0 1 6 2h12a2 2 0 0 1 1.6.8l1.6 2.14a2 2 0 0 1 .14 2.2L16.79 15"/><path d="M11 12 5.12 2.2"/><path d="m13 12 5.88-9.8"/><path d="M8 7h8"/><circle cx="12" cy="17" r="5"/><path d="M12 18v-2h-.5"/>`,
  warning:   `<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>`,
  globe:     `<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>`,
  arrowDown: `<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>`,
  confetti:  `<path d="M5.8 11.3 2 22l10.7-3.79"/><path d="M4 3h.01"/><path d="M22 8h.01"/><path d="M15 2h.01"/><path d="M22 20h.01"/><path d="m22 2-2.24.75a2.9 2.9 0 0 0-1.96 3.12c.1.86-.57 1.63-1.45 1.63h-.38c-.86 0-1.6.6-1.76 1.44L14 10"/><path d="m22 13-.82-.33c-.86-.34-1.82.2-1.98 1.11c-.11.7-.72 1.22-1.43 1.22H17"/><path d="m11 2 .33.82c.34.86-.2 1.82-1.11 1.98C9.52 4.9 9 5.52 9 6.23V7"/><path d="M11 13c1.93 1.93 2.83 4.17 2 5-.83.83-3.07-.07-5-2-1.93-1.93-2.83-4.17-2-5 .83-.83 3.07.07 5 2Z"/>`,
  hole:      `<ellipse cx="12" cy="15" rx="9" ry="4"/><ellipse cx="12" cy="15.5" rx="4.5" ry="1.8"/><path d="M5 8l2 2"/><path d="M19 8l-2 2"/><path d="M12 4v3"/>`,
  link:      `<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>`,
  chain:     `<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" y1="12" x2="16" y2="12"/>`,
  sparkles:  `<path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0l1.58 6.14a2 2 0 0 0 1.44 1.44l6.14 1.58a.5.5 0 0 1 0 .96l-6.14 1.58a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/>`,
  flask:     `<path d="M14 2v6a2 2 0 0 0 .25.96l5.5 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.75-2.96l5.5-10.08A2 2 0 0 0 10 8V2"/><path d="M6.45 15h11.1"/><path d="M8.5 2h7"/>`,
  gem:       `<path d="M6 3h12l4 6-10 13L2 9Z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/>`,
  orb:       `<circle cx="12" cy="10" r="7"/><path d="M9 7.5a3 3 0 0 1 3-1.5"/><path d="M7 20h10"/><path d="M8.5 16.5 7 20"/><path d="M15.5 16.5 17 20"/>`,
  dice:      `<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 8h.01"/><path d="M16 8h.01"/><path d="M12 12h.01"/><path d="M8 16h.01"/><path d="M16 16h.01"/>`,
  mushroom:  `<path d="M3 12a9 8 0 0 1 18 0z"/><path d="M9 12v6a3 3 0 0 0 6 0v-6"/><circle cx="9" cy="8" r="1"/><circle cx="15" cy="7.5" r="1"/>`,
  leaf:      `<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>`,
  trendUp:   `<polyline points="22,7 13.5,15.5 8.5,10.5 2,17"/><polyline points="16,7 22,7 22,13"/>`,
  chart:     `<path d="M3 3v18h18"/><path d="M8 17v-5"/><path d="M13 17V8"/><path d="M18 17v-9"/>`,
  sun:       `<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>`,
  moon:      `<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>`,
  calendar:  `<path d="M8 2v4"/><path d="M16 2v4"/><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 10h18"/>`,
  speaker:   `<path d="M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6A1.4 1.4 0 0 1 5.4 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z"/><path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.36 18.36a9 9 0 0 0 0-12.73"/>`,
  mute:      `<path d="M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6A1.4 1.4 0 0 1 5.4 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/>`,
  music:     `<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>`,
  snowflake: `<path d="M12 2v20"/><path d="m4.93 4.93 14.14 14.14"/><path d="M2 12h20"/><path d="m4.93 19.07 14.14-14.14"/><path d="M9 4l3 2 3-2"/><path d="M9 20l3-2 3 2"/>`,
  snail:     `<path d="M2 13a6 6 0 1 0 12 0 4 4 0 1 0-8 0 2 2 0 0 0 4 0"/><circle cx="10" cy="13" r="8"/><path d="M2 21h12c4.4 0 8-3.6 8-8V7a2 2 0 1 0-4 0v6"/><path d="M18 3 19.1 5.2"/><path d="M22 3 20.9 5.2"/>`,
  unlock:    `<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.75-1.4"/>`,
  statue:    `<path d="M8 21V10a4 4 0 0 1 8 0v11"/><path d="M6 21h12"/><path d="M10 12h.01"/><path d="M14 12h.01"/><path d="M10 16h4"/><path d="M9 6.5 8 3h8l-1 3.5"/>`,
  bot:       `<path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>`,
  pencil:    `<path d="M21.17 6.81a1 1 0 0 0-3.98-3.98L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/><path d="m15 5 4 4"/>`,
  butterfly: `<path d="M12 7v12"/><path d="M12 9C10 5 6 3 3.5 4.5 2 6.5 3.5 10 7 11c-3 1-3.5 4.5-1.5 6 2.5 1 5-1 6.5-4"/><path d="M12 9c2-4 6-6 8.5-4.5 1.5 2 0 5.5-3.5 6.5 3 1 3.5 4.5 1.5 6-2.5 1-5-1-6.5-4"/>`,
  scream:    `<circle cx="12" cy="12" r="10"/><ellipse cx="12" cy="16" rx="2" ry="3"/><path d="M8.5 10h.01"/><path d="M15.5 10h.01"/><path d="M7 7l2.5 1.2"/><path d="M17 7l-2.5 1.2"/>`,
  undo:      `<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>`,
  repeat:    `<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>`,
  store:     `<path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4"/><path d="M2 7h20"/><path d="M2 7v3a2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0V7"/>`,
  brick:     `<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 9v6"/><path d="M16 15v6"/><path d="M16 3v6"/><path d="M3 15h18"/><path d="M3 9h18"/><path d="M8 15v6"/><path d="M8 3v6"/>`,
  clock:     `<circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/>`,
  search:    `<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>`,
  ban:       `<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>`,
  dot:       `<circle cx="12" cy="12" r="6"/>`,
  user:      `<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>`,
  card:      `<rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>`,
  gear:      `<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>`,
  bell:      `<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>`,
  tag:       `<path d="M12.59 2.59A2 2 0 0 0 11.17 2H4a2 2 0 0 0-2 2v7.17a2 2 0 0 0 .59 1.42l8.7 8.7a2.43 2.43 0 0 0 3.42 0l6.58-6.58a2.43 2.43 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r="1.5"/>`,
  rocket:    `<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>`,
  run:       `<circle cx="14" cy="4" r="2"/><path d="m8 22 3-6 3 2v4"/><path d="m6 12 3-4 4 1 3 3 3 1"/><path d="M11 16 9 11"/>`,
  hand:      `<path d="M18 11V6a2 2 0 0 0-4 0"/><path d="M14 10V4a2 2 0 0 0-4 0v2"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>`,
};

// ── Эмодзи → иконки ─────────────────────────────────────────────────────────
// Эмодзи стояли по всему интерфейсу: в переводах (js/i18n.js), в тостах, в
// разметке окон, в сообщениях сервера в чат. И на каждом телефоне выглядели
// по-своему — у одного яркий мультяшный кубок, у другого плоский, у третьего
// пустой квадрат. Здесь каждому — своя иконка из библиотеки выше и свой цвет,
// а заменяет их одно место (emojifyDom ниже), а не тысяча правок по строкам.
//
// Эмодзи, которого нет в таблице, остаётся как есть — например, набранный
// игроком в чате. Типографские значки (✓ ✕ → ★) — не эмодзи и не трогаются.
const EMOJI_ICON = {
  '🔒': ['lock', '#c9b48a'], '🔓': ['unlock', '#8fd65a'],
  '⚔': ['swords', '#e6c27a'], '🗡': ['dagger', '#d6dee6'], '🏹': ['bow', '#c9a45c'],
  '🛡': ['shield', '#7fb4e8'], '💀': ['skullFace', '#e0d6c8'], '☠': ['skullFace', '#e0d6c8'],
  '🏆': ['trophy', '#ffcf5c'], '👑': ['crown', '#ffcf5c'], '⭐': ['star', '#ffcf5c'], '🌟': ['star', '#ffe08a'],
  '🥇': ['medal', '#ffcf56'], '🥈': ['medal', '#d6dee6'], '🥉': ['medal', '#e0a46e'], '🏅': ['medal', '#ffcf56'],
  '⏳': ['hourglass', '#e3b066'], '⌛': ['hourglass', '#e3b066'], '⏱': ['timer', '#9cc8ff'], '⏰': ['timer', '#9cc8ff'],
  '🕐': ['clock', '#9cc8ff'], '🕒': ['clock', '#9cc8ff'],
  '🏰': ['castle', '#c9a45c'], '🌀': ['portal', '#4fc3ff'], '🌍': ['globe', '#7fb4e8'], '🌐': ['globe', '#7fb4e8'],
  '🗺': ['map', '#e3c48a'], '🏪': ['store', '#7fd3a0'], '🛒': ['merchant', '#7fd3a0'], '🧱': ['brick', '#d08a52'],
  '🎁': ['gift', '#ff8a7a'], '🌾': ['wheat', '#e3c35c'], '🍄': ['mushroom', '#e8574f'], '🌿': ['leaf', '#8fd65a'],
  '🪙': ['coin', '#ffcf5c'], '💰': ['moneyBag', '#ffcf5c'], '💸': ['moneyBag', '#8fd65a'], '💎': ['gem', '#7fd3ff'],
  '💳': ['card', '#9cc8ff'], '🎟': ['ticket', '#ffb347'], '🏷': ['tag', '#e3c48a'],
  '⚡': ['lightning', '#ffd35c'], '🔥': ['flame', '#ff8a3d'], '❄': ['snowflake', '#a8e0ff'], '☀': ['sun', '#ffcf5c'], '🌙': ['moon', '#ffe08a'],
  '💥': ['burst', '#ff8a3d'], '💢': ['burst', '#ff5a4a'], '✨': ['sparkles', '#ffe08a'], '🎉': ['confetti', '#ff9ad5'],
  '❤': ['heart', '#ff6b7a'], '💗': ['heart', '#ff8ab0'], '💜': ['heart', '#b48ae6'], '🩸': ['drop', '#e8574f'],
  '👹': ['demon', '#e8574f'], '👻': ['ghost', '#c9d3dc'], '🗿': ['statue', '#b9a58a'], '😱': ['scream', '#ffcf5c'],
  '🤖': ['bot', '#9cc8ff'], '🦋': ['butterfly', '#7fd3ff'], '🐾': ['pet', '#d6b38a'], '🐌': ['snail', '#c9a45c'],
  '👥': ['party', '#9cc8ff'], '👤': ['user', '#9cc8ff'], '👇': ['arrowDown', '#ffcf5c'], '✋': ['hand', '#e2d6c1'],
  '📜': ['scroll', '#e3c48a'], '📖': ['book', '#e3c48a'], '📚': ['book', '#e3c48a'], '📬': ['mail', '#9cc8ff'], '✉': ['mail', '#9cc8ff'],
  '📈': ['trendUp', '#8fd65a'], '📊': ['chart', '#9cc8ff'], '📅': ['calendar', '#9cc8ff'], '🔎': ['search', '#9cc8ff'], '🔍': ['search', '#9cc8ff'],
  '🔗': ['link', '#7fb4e8'], '⛓': ['chain', '#a1b2c1'], '🕳': ['hole', '#a58fc4'],
  '🧪': ['flask', '#7ee0c0'], '⚗': ['flask', '#7ee0c0'], '🔮': ['orb', '#c38cff'], '🎲': ['dice', '#e2d6c1'], '🎯': ['target', '#ff6b6b'],
  '⚒': ['hammer', '#c9a45c'], '🔨': ['hammer', '#c9a45c'], '🔧': ['craftsman', '#a1b2c1'], '⚙': ['gear', '#a1b2c1'],
  '🥾': ['boots', '#c9a45c'], '🎒': ['inventory', '#c9a45c'], '💨': ['wind', '#c9d3dc'], '🏃': ['run', '#9cc8ff'], '🚀': ['rocket', '#ff8a3d'],
  '💬': ['chat', '#9cc8ff'], '🔔': ['bell', '#ffcf5c'], '🔇': ['mute', '#a1b2c1'], '🔊': ['speaker', '#a1b2c1'], '🔈': ['speaker', '#a1b2c1'], '🎵': ['music', '#c9a6f0'],
  '✅': ['checkCircle', '#8fd65a'], '❌': ['xCircle', '#eb4e61'], '⚠': ['warning', '#ffb347'], '🚫': ['ban', '#eb4e61'], '⛔': ['ban', '#eb4e61'],
  '✎': ['pencil', '#e2d6c1'], '✏': ['pencil', '#e2d6c1'], '↩': ['undo', '#9cc8ff'], '🔁': ['repeat', '#9cc8ff'], '🔄': ['repeat', '#9cc8ff'],
  '🟢': ['dot', '#5fd068'], '🔴': ['dot', '#eb4e61'], '⚪': ['dot', '#c9d3dc'], '🟡': ['dot', '#ffcf5c'], '🔷': ['gem', '#5aa9e6'],
  '📍': ['crosshair', '#eb4e61'], '🎮': ['game', '#9cc8ff'],
};
// Флаги — не контур, а заливка: три полосы читаются, только если они цветные.
const _FLAG = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 20" width="1.4em" height="0.95em" style="display:inline-block;vertical-align:-0.12em;border-radius:2px;box-shadow:0 0 0 1px rgba(0,0,0,.35)">${body}</svg>`;
const EMOJI_FLAG = {
  '🇷🇺': _FLAG('<rect width="30" height="20" fill="#fff"/><rect y="6.67" width="30" height="6.67" fill="#1c57a7"/><rect y="13.33" width="30" height="6.67" fill="#d52b1e"/>'),
  '🇺🇦': _FLAG('<rect width="30" height="10" fill="#0057b7"/><rect y="10" width="30" height="10" fill="#ffd700"/>'),
  '🇪🇸': _FLAG('<rect width="30" height="20" fill="#c60b1e"/><rect y="5" width="30" height="10" fill="#ffc400"/>'),
  '🇹🇷': _FLAG('<rect width="30" height="20" fill="#e30a17"/><circle cx="11" cy="10" r="5" fill="#fff"/><circle cx="12.3" cy="10" r="4" fill="#e30a17"/><path d="M16.2 10l3.6-1.2-2.2 3.1V8.1l2.2 3.1z" fill="#fff"/>'),
  '🇧🇷': _FLAG('<rect width="30" height="20" fill="#009c3b"/><path d="M15 2.5 27.5 10 15 17.5 2.5 10z" fill="#ffdf00"/><circle cx="15" cy="10" r="4.2" fill="#002776"/>'),
  '🇬🇧': _FLAG('<rect width="30" height="20" fill="#012169"/><path d="M0 0 30 20M30 0 0 20" stroke="#fff" stroke-width="4"/><path d="M0 0 30 20M30 0 0 20" stroke="#c8102e" stroke-width="1.6"/><path d="M15 0v20M0 10h30" stroke="#fff" stroke-width="6"/><path d="M15 0v20M0 10h30" stroke="#c8102e" stroke-width="3.4"/>'),
};
const _EMOJI_KEYS = [...Object.keys(EMOJI_FLAG), ...Object.keys(EMOJI_ICON)]
  .sort((a, b) => b.length - a.length);
// Вариант-селектор U+FE0F после знака необязателен: «⚔» и «⚔️» — один эмодзи.
const _EMOJI_RE = new RegExp(`(?:${_EMOJI_KEYS.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\uFE0F?`, 'gu');

function _emojiKey(raw) { return String(raw).replace(/️/g, ''); }

// SVG одного эмодзи по размеру строки (em), чтобы стоять в тексте любой
// величины. Внутри — сам эмодзи невидимым текстом: textContent элемента не
// меняется, и код, сравнивающий его со своей строкой перед перерисовкой,
// не перерисовывает каждый кадр. Его же прочтёт экранный диктор.
function emojiIconHTML(raw) {
  const key = _emojiKey(raw);
  const flag = EMOJI_FLAG[key];
  const hid = `<span class="emo-t">${raw}</span>`;
  if (flag) return `<span class="emo-ico">${flag}${hid}</span>`;
  const m = EMOJI_ICON[key];
  if (!m || !ICON_SVG[m[0]]) return raw;
  return `<span class="emo-ico"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1.15em" height="1.15em" stroke="${m[1]}" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:-0.2em">${ICON_SVG[m[0]]}</svg>${hid}</span>`;
}

// Для холста, где SVG в строку не вставить (летящий текст над персонажем):
// первая иконка отдельно, текст — без эмодзи.
function emojiSplit(text) {
  const s = String(text);
  let icon = null;
  const rest = s.replace(_EMOJI_RE, (raw) => {
    const m = EMOJI_ICON[_emojiKey(raw)];
    if (!icon && m) icon = m;
    return '';
  }).replace(/\s{2,}/g, ' ').trim();
  return { icon, text: rest };
}

// ── обход DOM ───────────────────────────────────────────────────────────────
// Текстовый узел с эмодзи заменяется на текст + иконки. Поля ввода, <option>,
// <title>, <script>/<style> и уже заменённые иконки не трогаются: в первых
// SVG не показать, во вторых он не нужен.
const _EMOJI_SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'OPTION', 'TITLE', 'NOSCRIPT']);
function _emojiNodeOk(node) {
  const p = node.parentNode;
  if (!p || p.nodeType !== 1) return false;
  if (_EMOJI_SKIP.has(p.nodeName) || p.isContentEditable) return false;
  if (p.namespaceURI === 'http://www.w3.org/2000/svg') return false;
  return !(p.closest && p.closest('.emo-ico, [data-no-emoji-icons]'));
}
function _emojifyText(node) {
  const v = node.nodeValue;
  if (!v) return;
  _EMOJI_RE.lastIndex = 0;
  if (!_EMOJI_RE.test(v) || !_emojiNodeOk(node)) return;
  _EMOJI_RE.lastIndex = 0;
  const frag = document.createDocumentFragment();
  let at = 0, m;
  while ((m = _EMOJI_RE.exec(v))) {
    if (m.index > at) frag.appendChild(document.createTextNode(v.slice(at, m.index)));
    const box = document.createElement('span');
    box.innerHTML = emojiIconHTML(m[0]);
    frag.appendChild(box.firstChild);
    at = m.index + m[0].length;
  }
  if (at < v.length) frag.appendChild(document.createTextNode(v.slice(at)));
  node.parentNode.replaceChild(frag, node);
}
function emojifyDom(root) {
  if (!root) return;
  if (root.nodeType === 3) { _emojifyText(root); return; }
  if (root.nodeType !== 1 && root.nodeType !== 11) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const found = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    _EMOJI_RE.lastIndex = 0;
    if (_EMOJI_RE.test(n.nodeValue)) found.push(n);
  }
  found.forEach(_emojifyText);
}
// Всё, что появится потом — окна, тосты, сообщения чата, — проходит через
// тот же обход: интерфейс строится через innerHTML в сотне мест, и ставить
// вызов в каждое значило бы однажды забыть одно.
function startEmojiIcons() {
  if (typeof MutationObserver === 'undefined' || !document.body) return;
  emojifyDom(document.body);
  new MutationObserver((list) => {
    for (const r of list) {
      if (r.type === 'characterData') _emojifyText(r.target);
      else r.addedNodes.forEach(emojifyDom);
    }
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
}
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startEmojiIcons);
  else startEmojiIcons();
}

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

// ── Class portrait icons ─────────────────────────────────────────────────────
// CHAR_DEF's own iconImg per class (shared/definitions.js) — real artwork
// (images/classicon/<cls>.png), not a stroke path, so this is a plain
// Image cache rather than the SVG-blob wrapping _getIconImg needs above.
const _classIconImgCache = {};
function _getClassIconImg(src) {
  if (!src) return null;
  if (_classIconImgCache[src]) return _classIconImgCache[src];
  const img = new Image();
  img.src = src;
  return (_classIconImgCache[src] = img);
}

// Just the portrait, centered at (cx, cy) — for callers that already draw
// their own background (charselect.js's fallback circle, the HUD avatar's
// gradient disc).
function drawClassIconCtx(c, cls, cx, cy, size) {
  const cd = (typeof CHAR_DEF !== 'undefined') && CHAR_DEF[cls];
  const img = cd && _getClassIconImg(cd.iconImg);
  if (!img || !img.complete || img.naturalWidth === 0) return;
  c.drawImage(img, cx - size / 2, cy - size / 2, size, size);
}

// Full badge: a filled circle in the class's own color, portrait inset —
// for callers with no background of their own (Подземелье's teleport-hall
// pads, js/game.js).
function drawClassBadgeCtx(c, cls, cx, cy, size) {
  const cd = (typeof CHAR_DEF !== 'undefined') && CHAR_DEF[cls];
  if (!cd) return;
  c.fillStyle = cd.color;
  c.strokeStyle = 'rgba(0,0,0,0.65)';
  c.lineWidth = 2;
  c.beginPath();
  c.arc(cx, cy, size / 2, 0, Math.PI * 2);
  c.fill();
  c.stroke();
  drawClassIconCtx(c, cls, cx, cy, size * 0.72);
}

// ── DOM helper: class portrait as an <img> ───────────────────────────────────
// Same role iconHTML plays for a stroke glyph, for the places that build a
// class icon into innerHTML instead of a canvas (charselect.js's loading
// screen, the peer-profile card in js/ui.js).
function classIconHTML(cls, size = 20) {
  const cd = (typeof CHAR_DEF !== 'undefined') && CHAR_DEF[cls];
  if (!cd || !cd.iconImg) return '';
  return `<img src="${cd.iconImg}" width="${size}" height="${size}" style="display:inline-block;vertical-align:middle;object-fit:contain;flex-shrink:0">`;
}

// Same portrait, round badge with the class's own color behind it (the DOM
// equivalent of drawClassBadgeCtx above) — for a compact "whose class is
// this" marker next to a username: the season rating list, the regular BM
// rating list and the clan member list (all js/ui.js/js/clans.js), and the
// header avatar slot (drawn on canvas there instead, via drawClassBadgeCtx
// directly — see drawHeader, js/ui.js). Empty string, not a placeholder,
// for a class that hasn't been picked yet (null/undefined) — every caller
// here already only shows it when truthy.
function classBadgeHTML(cls, size = 20) {
  const cd = (typeof CHAR_DEF !== 'undefined') && CHAR_DEF[cls];
  if (!cd || !cd.iconImg) return '';
  const name = typeof _esc === 'function' ? _esc(cd.name) : cd.name;
  return `<img src="${cd.iconImg}" class="class-icon-badge" style="width:${size}px;height:${size}px;background:${cd.color}" title="${name}">`;
}
