// TILE, WALL, FLOOR, CHAR_DEF, ENEMY_DEF → shared/definitions.js
// 112, а не 64: шапка стала тремя блоками из комплекта — панель статов A1
// с кольцом портрета, столбец валютных плашек B3 и рамка карты A2. В 64 px
// они помещались только сжатыми поперёк, а это то самое непропорциональное
// растяжение, от которого гайд к комплекту предостерегает.
// Считается из пропорции самой панели, а не назначается. Вся шапка теперь
// одна картинка — G2, 2.613 : 1, — и её высота при данной ширине экрана
// определена однозначно. Назначить сюда число значило бы растянуть панель
// непропорционально, чего гайд к комплекту прямо запрещает.
//
// let, а не const: ширина экрана известна только в браузере и меняется при
// повороте, поэтому значение пересчитывается в updateHeaderH().
const HDR_PAD = 3;
let HEADER_H = 90;
function updateHeaderH() {
  const a = (typeof HUD_ART !== 'undefined') && HUD_ART.G2_wide_header_with_map;
  if (!a || typeof W !== 'number' || !W) return;
  const pw = W - HDR_PAD * 2;
  HEADER_H = Math.round(pw * a.out[1] / a.out[0]) + HDR_PAD * 2;
}
// 78, а не 62: полоса навигации теперь картинка A4 с пропорцией
// 1170×260, и на телефоне 390 px она высотой 87. Тянуть её в 62 —
// это ровно то «непропорційне розтягування», от которого гайд к
// комплекту предостерегает; 78 обрезает по 4 px сверху и снизу,
// а углубления вкладок стоят по центру и не страдают.
const NAV_H = 78;
const JOY_R = 58, JOY_KNOB = 24;
const ZOOM = 0.75;

// Basic-attack swing animation plays this many times faster than the
// attack-speed-derived duration it's based on (game.js, network.js) — a
// purely visual snappiness knob, independent of actual attack rate/DPS
// (governed separately by player.atkTimer).
const ATTACK_ANIM_SPEEDUP = 2;

// Player level required to use auto-attack / Market / Rating
const FEATURE_UNLOCK_LEVEL = 3;
// Gold cost to found a clan — now in shared/definitions.js, because the server
// is what charges it (clanCreate). Declaring it here as well is a duplicate
// `const` in the concatenated bundle, which is a SyntaxError that takes the
// whole client down.
