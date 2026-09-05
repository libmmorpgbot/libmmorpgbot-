// TILE, WALL, FLOOR, CHAR_DEF, ENEMY_DEF → shared/definitions.js

// ── размер HUD, одним числом ───────────────────────────────────────────────
// Владелец: «сделать его компактней и меньше на процентов 10-15». HUD рисуется
// кодом, и его размер задавали восемь десятков чисел, разбросанных по трём
// файлам: высота шапки, радиусы веера, диаметр джойстика, кегли надписей,
// поля кнопок. Уменьшить их по одному — это восемь десятков мест, где можно
// ошибиться, и никакого способа потом сказать «а теперь ещё на пять».
//
// Поэтому множитель один, а числа рядом с ним — исходные, те, под которые
// раскладка рисовалась. 0.87 это те самые 13% из середины просимого.
//
// Что он НЕ трогает и почему:
//
//   NAV_H     нижняя навигация. Её размер живёт не здесь, а в CSS — см. ниже;
//   ZOOM      масштаб МИРА. Уменьшить его значит не «компактный интерфейс»,
//             а «мелкие монстры».
//
// Дальше по коду встречается `hud(...)` и `hudF(...)` — это он же. Первый для
// пикселей и округляет, второй для кеглей и оставляет десятую: 9.5 px после
// округления стали бы 8, то есть на 16% мельче вместо 13.
const HUD_SCALE = 0.87;
function hud(n)  { return Math.round(n * HUD_SCALE); }
function hudF(n) { return Math.round(n * HUD_SCALE * 10) / 10; }

// Top band reserved for the HUD's player plate (drawHeader, js/ui.js): the
// world is drawn from here down. The minimap plate deliberately hangs below
// it, over the world — hudMiniMapRect() is what the right-hand button column
// measures itself from, not this.
//
// `let`, not `const`: Telegram's fullscreen mode (requestFullscreen,
// js/network.js _initTelegramWidget) can leave part of this band under the
// status bar or a punch-hole camera, and how much needs to move down for
// that (_safeInset('top') below) is only known once Telegram has actually
// applied fullscreen — which happens after this file has already run once.
// _recalcHudMetrics() is the real assignment; see resize() in js/game.js,
// which calls it on load and on every later layout change. The value here
// is only what a synchronous script evaluation can know before that.
const HEADER_BASE_H = hud(100);
let HEADER_H = HEADER_BASE_H;
// ── высота нижней навигации ───────────────────────────────────────────────
// Читается ИЗ CSS (--nav-h, css/style.css), а не задаётся здесь. Полоса
// рисуется браузером, а от её высоты отсчитывается вся нижняя половина игры:
// веер действий, джойстик, дуга бафов, нижняя граница мира. Пока это были два
// числа в разных файлах, они держались на том, что кто-то помнит про оба, —
// а разъехались бы молча: полоса ниже, веер по-прежнему от старой высоты, и
// под ним пустая лента.
//
// Тоже `let` и тоже пересчитывается в _recalcHudMetrics(). --nav-h в CSS —
// ЧИСТЫЕ 50px, без calc()/var(): getComputedStyle отдаёт значение
// calc()-свойства как текст, а не число (проверено на этом самом коде — см.
// комментарий у --nav-h, css/style.css), так что считать сумму с safe-area
// приходится здесь же, тем же способом, что и для HEADER_H — сложением, а
// не чтением уже сложенного из CSS. Фактическая высота ПОЛОСЫ НА ЭКРАНЕ
// добавляет тот же отступ через отдельную --nav-h-total (css/style.css),
// чтобы JS-число и то, что видно на экране, остались одним и тем же.
let NAV_H = 50;

// ── safe-area отступы (статус-бар, вырез под камеру, жестовая полоса) ──────
// side — 'top' или 'bottom'. Telegram публикует их как --tg-safe-area-inset-*
// (полноэкранный режим рисует мини-приложение от края до края); вне Telegram
// то же самое даёт обычный env(), уже завёрнутый в --safe-top/--safe-bottom
// (css/style.css). Там, где вырезать нечего, обе читаются как 0.
function _safeInset(side) {
  try {
    const cs = getComputedStyle(document.documentElement);
    const tg = parseFloat(cs.getPropertyValue('--tg-safe-area-inset-' + side));
    const std = parseFloat(cs.getPropertyValue('--safe-' + side));
    return Math.max(Number.isFinite(tg) ? tg : 0, Number.isFinite(std) ? std : 0);
  } catch (e) { return 0; }
}

// Единственное место, которое ДЕЙСТВИТЕЛЬНО присваивает HEADER_H и NAV_H —
// см. вызов в resize() (js/game.js). Запасные значения выше — на случай,
// если стили не доехали или resize() ещё не успел ни разу отработать: лучше
// раскладка с чуть неверной полосой, чем NaN, от которого поедет всё сразу.
function _recalcHudMetrics() {
  let navBase = 50;
  try {
    const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--nav-h'));
    if (Number.isFinite(v) && v > 0) navBase = v;
  } catch (e) { /* нет document — значит и полосы нет */ }
  NAV_H = navBase + _safeInset('bottom');
  HEADER_H = HEADER_BASE_H + _safeInset('top');
}
const JOY_R = hud(58), JOY_KNOB = hud(24);
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
