// TILE, WALL, FLOOR, CHAR_DEF, ENEMY_DEF → shared/definitions.js
// Синяя тема рисует шапку процедурно — плашка игрока слева, плашка карты
// справа, обе фиксированной высоты HUD_PLATE_H (js/ui.js), — а не одной
// растянутой по ширине экрана картинкой из комплекта, поэтому высота шапки
// больше не зависит от W и не пересчитывается на ресайз.
const HDR_PAD = 3;
let HEADER_H = 104;
function updateHeaderH() { /* фиксированная высота, пересчитывать нечего */ }
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
