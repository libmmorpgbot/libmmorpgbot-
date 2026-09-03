'use strict';
// The client bundle's file list, in concatenation order — pulled out of
// server/index.js so it can be required without pulling in the server itself
// (index.js boots Express/Mongo/Socket.io as soon as it's required). Also
// what eslint.config.js reads to know which files share one global script
// scope in the browser (see the comment there).
//
// Paths are relative to the repo root; server/index.js does the path.join.
module.exports = [
  'shared/definitions.js',
  'shared/netcodec.js',
  'js/constants.js',
  'js/utils.js',
  'js/state.js',
  'js/icons.js',
  'js/themes.js',
  'js/definitions.js',
  'js/i18n.js',
  'js/tonconnect.js',
  'js/sprites.js',
  'js/particles.js',
  'js/sound.js',
  'js/player.js',
  'js/combat.js',
  'js/input.js',
  'js/ui.js',
  'js/charselect.js',
  'js/network.js',
  'js/quests.js',
  'js/clans.js',
  'js/pixi-world.js',
  'js/game.js',
  'js/npc.js',
];
