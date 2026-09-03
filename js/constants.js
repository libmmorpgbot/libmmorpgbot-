// TILE, WALL, FLOOR, CHAR_DEF, ENEMY_DEF → shared/definitions.js
// Top band reserved for the HUD's player plate (drawHeader, js/ui.js): the
// world is drawn from here down. The minimap plate deliberately hangs below
// it, over the world — hudMiniMapRect() is what the right-hand button column
// measures itself from, not this.
const HEADER_H = 100;
const NAV_H = 62;
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
