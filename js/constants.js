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
const HEADER_H = hud(100);
// ── высота нижней навигации ───────────────────────────────────────────────
// Читается ИЗ CSS (--nav-h, css/style.css), а не задаётся здесь. Полоса
// рисуется браузером, а от её высоты отсчитывается вся нижняя половина игры:
// веер действий, джойстик, дуга бафов, нижняя граница мира. Пока это были два
// числа в разных файлах, они держались на том, что кто-то помнит про оба, —
// а разъехались бы молча: полоса ниже, веер по-прежнему от старой высоты, и
// под ним пустая лента.
//
// Запасное значение — на случай, если стили не доехали: лучше раскладка с
// чуть неверной полосой, чем NaN, от которого поедет всё сразу.
const NAV_H = (function () {
  try {
    const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--nav-h'));
    if (Number.isFinite(v) && v > 0) return v;
  } catch (e) { /* нет document — значит и полосы нет */ }
  return 56;
})();
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
