// Полный набор анимаций класса: images/<Dir>/<Facing> - <Action>.png, по
// полосе 15 кадров на каждое из 8 направлений. Кроме стойки/бега/атаки/смерти
// у класса есть attack2 (второй замах, чередуется с первым — у Егеря его нет,
// выстрел один) и skillq..skillr — своя анимация на каждый навык, её выбирает
// getSpriteAnimKey по player._skillAnim. ?v=4: под теми же именами раньше
// лежали другие кадры атаки, а картинки кэшируются по URL.
const _FACINGS = [['front', 'Front'], ['back', 'Back'], ['left', 'Left'], ['right', 'Right'],
  ['frontright', 'FrontRight'], ['frontleft', 'FrontLeft'], ['backright', 'BackRight'], ['backleft', 'BackLeft']];
function _classAnims(dir, hasAttack2) {
  const acts = [['idle', 'Idle', 7, true], ['run', 'Running', 15, true], ['attack', 'Attacking', 14, false],
    ['skillq', 'SkillQ', 14, false], ['skillw', 'SkillW', 14, false], ['skille', 'SkillE', 14, false], ['skillr', 'SkillR', 14, false]];
  if (hasAttack2) acts.push(['attack2', 'Attacking2', 14, false]);
  const anims = {};
  for (const [fk, fn] of _FACINGS) {
    for (const [ak, an, fps, loop] of acts) {
      anims[`${fk}-${ak}`] = { src: `images/${dir}/${fn} - ${an}.png?v=4`, cols: 15, rows: 1, n: 15, fps, loop };
    }
  }
  anims['die'] = { src: `images/${dir}/Dying.png?v=4`, cols: 15, rows: 1, n: 15, fps: 12, loop: false };
  return anims;
}

const SPRITE_DEF = {
  deathknight: {
    frameW: 128, frameH: 128,
    dispScale: 1.5,
    anims: {
      'front-idle':   { src:'images/DeathKnight/Front - Idle.png?v=2',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'back-idle':    { src:'images/DeathKnight/Back - Idle.png?v=2',        cols:15, rows:1, n:15, fps:7,  loop:true  },
      'left-idle':    { src:'images/DeathKnight/Left - Idle.png?v=2',        cols:15, rows:1, n:15, fps:7,  loop:true  },
      'right-idle':   { src:'images/DeathKnight/Right - Idle.png?v=2',       cols:15, rows:1, n:15, fps:7,  loop:true  },
      'front-run':    { src:'images/DeathKnight/Front - Running.png?v=2',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'back-run':     { src:'images/DeathKnight/Back - Running.png?v=2',     cols:15, rows:1, n:15, fps:15, loop:true  },
      'left-run':     { src:'images/DeathKnight/Left - Running.png?v=2',     cols:15, rows:1, n:15, fps:15, loop:true  },
      'right-run':    { src:'images/DeathKnight/Right - Running.png?v=2',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'front-attack': { src:'images/DeathKnight/Front - Attacking.png?v=2',  cols:15, rows:1, n:15, fps:14, loop:false },
      'back-attack':  { src:'images/DeathKnight/Back - Attacking.png?v=2',   cols:15, rows:1, n:15, fps:14, loop:false },
      'left-attack':  { src:'images/DeathKnight/Left - Attacking.png?v=2',   cols:15, rows:1, n:15, fps:14, loop:false },
      'right-attack': { src:'images/DeathKnight/Right - Attacking.png?v=2',  cols:15, rows:1, n:15, fps:14, loop:false },
      'frontright-idle':   { src:'images/DeathKnight/FrontRight - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'frontleft-idle':   { src:'images/DeathKnight/FrontLeft - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'backright-idle':   { src:'images/DeathKnight/BackRight - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'backleft-idle':   { src:'images/DeathKnight/BackLeft - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'frontright-run':    { src:'images/DeathKnight/FrontRight - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'frontleft-run':    { src:'images/DeathKnight/FrontLeft - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'backright-run':    { src:'images/DeathKnight/BackRight - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'backleft-run':    { src:'images/DeathKnight/BackLeft - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'frontright-attack': { src:'images/DeathKnight/FrontRight - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'frontleft-attack': { src:'images/DeathKnight/FrontLeft - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'backright-attack': { src:'images/DeathKnight/BackRight - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'backleft-attack': { src:'images/DeathKnight/BackLeft - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'die':          { src:'images/DeathKnight/Dying.png?v=2',              cols:15, rows:1, n:15, fps:12, loop:false },
    }
  },
  // Танк, Маг, Егерь и Целитель — из полных паков (8 направлений × 30
  // анимаций): у каждого навыка и рывка своя анимация, а не общий замах.
  // Какие листы у них есть — см. _classAnims выше.
  ranger:  { frameW: 128, frameH: 128, dispScale: 1.5, anims: _classAnims('Ranger',  false) },
  mage:    { frameW: 128, frameH: 128, dispScale: 1.5, anims: _classAnims('Mage',    true) },
  warlock: { frameW: 128, frameH: 128, dispScale: 1.5, anims: _classAnims('Warlock', true) },
  lev:     { frameW: 128, frameH: 128, dispScale: 1.5, anims: _classAnims('Lev',     true) },
  runefighter: {
    frameW: 128, frameH: 128,
    // 1.75, not 1.5 like every other class: the sheets THEMSELVES draw this
    // character smaller inside the same 128×128 frame — measured, the actual
    // non-transparent pixels run ~53px tall against ~59px average for the
    // five original classes at the same dispScale, which is what "меньше
    // других персонажей" was actually reporting. Rendering scales the WHOLE
    // frame to a fixed on-screen height (pixi-world.js), so a character
    // drawn smaller inside that frame comes out smaller on screen no matter
    // what the frame's own bounding box says — this compensates for that
    // directly, since re-cropping 25 sheets is not something a display
    // constant can substitute for, but bringing the apparent size back in
    // line with the other classes is exactly what one can do.
    dispScale: 1.75,
    anims: {
      'front-idle': { src:'images/RuneFighter/Front - Idle.png?v=2', cols:15, rows:1, n:15, fps:7, loop:true },
      'back-idle': { src:'images/RuneFighter/Back - Idle.png?v=2', cols:15, rows:1, n:15, fps:7, loop:true },
      'left-idle': { src:'images/RuneFighter/Left - Idle.png?v=2', cols:15, rows:1, n:15, fps:7, loop:true },
      'right-idle': { src:'images/RuneFighter/Right - Idle.png?v=2', cols:15, rows:1, n:15, fps:7, loop:true },
      'frontright-idle': { src:'images/RuneFighter/FrontRight - Idle.png?v=2', cols:15, rows:1, n:15, fps:7, loop:true },
      'frontleft-idle': { src:'images/RuneFighter/FrontLeft - Idle.png?v=2', cols:15, rows:1, n:15, fps:7, loop:true },
      'backright-idle': { src:'images/RuneFighter/BackRight - Idle.png?v=2', cols:15, rows:1, n:15, fps:7, loop:true },
      'backleft-idle': { src:'images/RuneFighter/BackLeft - Idle.png?v=2', cols:15, rows:1, n:15, fps:7, loop:true },
      'front-run': { src:'images/RuneFighter/Front - Running.png?v=2', cols:15, rows:1, n:15, fps:15, loop:true },
      'back-run': { src:'images/RuneFighter/Back - Running.png?v=2', cols:15, rows:1, n:15, fps:15, loop:true },
      'left-run': { src:'images/RuneFighter/Left - Running.png?v=2', cols:15, rows:1, n:15, fps:15, loop:true },
      'right-run': { src:'images/RuneFighter/Right - Running.png?v=2', cols:15, rows:1, n:15, fps:15, loop:true },
      'frontright-run': { src:'images/RuneFighter/FrontRight - Running.png?v=2', cols:15, rows:1, n:15, fps:15, loop:true },
      'frontleft-run': { src:'images/RuneFighter/FrontLeft - Running.png?v=2', cols:15, rows:1, n:15, fps:15, loop:true },
      'backright-run': { src:'images/RuneFighter/BackRight - Running.png?v=2', cols:15, rows:1, n:15, fps:15, loop:true },
      'backleft-run': { src:'images/RuneFighter/BackLeft - Running.png?v=2', cols:15, rows:1, n:15, fps:15, loop:true },
      'front-attack': { src:'images/RuneFighter/Front - Attacking.png?v=2', cols:15, rows:1, n:15, fps:14, loop:false },
      'back-attack': { src:'images/RuneFighter/Back - Attacking.png?v=2', cols:15, rows:1, n:15, fps:14, loop:false },
      'left-attack': { src:'images/RuneFighter/Left - Attacking.png?v=2', cols:15, rows:1, n:15, fps:14, loop:false },
      'right-attack': { src:'images/RuneFighter/Right - Attacking.png?v=2', cols:15, rows:1, n:15, fps:14, loop:false },
      'frontright-attack': { src:'images/RuneFighter/FrontRight - Attacking.png?v=2', cols:15, rows:1, n:15, fps:14, loop:false },
      'frontleft-attack': { src:'images/RuneFighter/FrontLeft - Attacking.png?v=2', cols:15, rows:1, n:15, fps:14, loop:false },
      'backright-attack': { src:'images/RuneFighter/BackRight - Attacking.png?v=2', cols:15, rows:1, n:15, fps:14, loop:false },
      'backleft-attack': { src:'images/RuneFighter/BackLeft - Attacking.png?v=2', cols:15, rows:1, n:15, fps:14, loop:false },
      'die': { src:'images/RuneFighter/Dying.png?v=2', cols:15, rows:1, n:15, fps:12, loop:false },
    }
  },
  assassin: {
    frameW: 128, frameH: 128,
    // 2.0, not 1.5 — same reasoning as runefighter's own dispScale comment
    // above, and this one draws smaller still: ~45px of actual character
    // inside the 128px frame against the same ~59px average.
    dispScale: 2.0,
    anims: {
      'front-idle': { src:'images/Assassin/Front - Idle.png?v=2', cols:15, rows:1, n:15, fps:7, loop:true },
      'back-idle': { src:'images/Assassin/Back - Idle.png?v=2', cols:15, rows:1, n:15, fps:7, loop:true },
      'left-idle': { src:'images/Assassin/Left - Idle.png?v=2', cols:15, rows:1, n:15, fps:7, loop:true },
      'right-idle': { src:'images/Assassin/Right - Idle.png?v=2', cols:15, rows:1, n:15, fps:7, loop:true },
      'frontright-idle': { src:'images/Assassin/FrontRight - Idle.png?v=2', cols:15, rows:1, n:15, fps:7, loop:true },
      'frontleft-idle': { src:'images/Assassin/FrontLeft - Idle.png?v=2', cols:15, rows:1, n:15, fps:7, loop:true },
      'backright-idle': { src:'images/Assassin/BackRight - Idle.png?v=2', cols:15, rows:1, n:15, fps:7, loop:true },
      'backleft-idle': { src:'images/Assassin/BackLeft - Idle.png?v=2', cols:15, rows:1, n:15, fps:7, loop:true },
      'front-run': { src:'images/Assassin/Front - Running.png?v=2', cols:15, rows:1, n:15, fps:15, loop:true },
      'back-run': { src:'images/Assassin/Back - Running.png?v=2', cols:15, rows:1, n:15, fps:15, loop:true },
      'left-run': { src:'images/Assassin/Left - Running.png?v=2', cols:15, rows:1, n:15, fps:15, loop:true },
      'right-run': { src:'images/Assassin/Right - Running.png?v=2', cols:15, rows:1, n:15, fps:15, loop:true },
      'frontright-run': { src:'images/Assassin/FrontRight - Running.png?v=2', cols:15, rows:1, n:15, fps:15, loop:true },
      'frontleft-run': { src:'images/Assassin/FrontLeft - Running.png?v=2', cols:15, rows:1, n:15, fps:15, loop:true },
      'backright-run': { src:'images/Assassin/BackRight - Running.png?v=2', cols:15, rows:1, n:15, fps:15, loop:true },
      'backleft-run': { src:'images/Assassin/BackLeft - Running.png?v=2', cols:15, rows:1, n:15, fps:15, loop:true },
      'front-attack': { src:'images/Assassin/Front - Attacking.png?v=2', cols:15, rows:1, n:15, fps:14, loop:false },
      'back-attack': { src:'images/Assassin/Back - Attacking.png?v=2', cols:15, rows:1, n:15, fps:14, loop:false },
      'left-attack': { src:'images/Assassin/Left - Attacking.png?v=2', cols:15, rows:1, n:15, fps:14, loop:false },
      'right-attack': { src:'images/Assassin/Right - Attacking.png?v=2', cols:15, rows:1, n:15, fps:14, loop:false },
      'frontright-attack': { src:'images/Assassin/FrontRight - Attacking.png?v=2', cols:15, rows:1, n:15, fps:14, loop:false },
      'frontleft-attack': { src:'images/Assassin/FrontLeft - Attacking.png?v=2', cols:15, rows:1, n:15, fps:14, loop:false },
      'backright-attack': { src:'images/Assassin/BackRight - Attacking.png?v=2', cols:15, rows:1, n:15, fps:14, loop:false },
      'backleft-attack': { src:'images/Assassin/BackLeft - Attacking.png?v=2', cols:15, rows:1, n:15, fps:14, loop:false },
      'die': { src:'images/Assassin/Dying.png?v=2', cols:15, rows:1, n:15, fps:12, loop:false },
    }
  },
};

// ── PET SPRITE SHEETS ────────────────────────────────────────────────────────
// One sheet per direction × state (front/back/left/right × idle/run), same
// "Dir - State.png" naming and 4-column grid layout as the player sheets
// above, just no attack/die/diagonal facings — pets are a cosmetic follower,
// not a combatant. cols/rows come straight from images/pet/<id>/ (idle: 4×4 =
// 16 frames, run: 4×3 = 12 frames); frameW/frameH is the exact per-pet cell
// size baked into those PNGs (see the pet-sprite prep pipeline — every sheet
// for one pet shares one cell size, but it differs pet-to-pet).
// anchorY = fraction of the cell's height (from the top) where this pet's
// feet actually sit in the front-idle art — measured once from the source
// frames (they're not bottom-flush like the player sheets; each cell carries
// a lot of transparent headroom, and the two "cell shapes" here — the wide
// 840-square-sourced pets vs. the 480-square-sourced ones — land at a
// consistently different foot line). Used the same way player rendering uses
// its fixed 0.62 (js/pixi-world.js _updatePlayer/_updatePet): position the
// sprite box so this fraction lines up with the pet's world (x,y).
const PET_SPRITE_DEF = {
  pet_aztec:   { frameW:320, frameH:274, dispScale:1, anchorY:0.66 },
  pet_maya:    { frameW:320, frameH:274, dispScale:1, anchorY:0.66 },
  pet_bear:    { frameW:320, frameH:274, dispScale:1, anchorY:0.66 },
  pet_medusa:  { frameW:320, frameH:320, dispScale:1, anchorY:0.80 },
  pet_bone:    { frameW:320, frameH:320, dispScale:1, anchorY:0.80 },
  pet_ogre:    { frameW:320, frameH:274, dispScale:1, anchorY:0.66 },
  pet_bonessa: { frameW:320, frameH:320, dispScale:1, anchorY:0.80 },
  pet_cyclops: { frameW:320, frameH:274, dispScale:1, anchorY:0.66 },
  pet_yeti:    { frameW:320, frameH:274, dispScale:1, anchorY:0.66 },
  // Присланная анимация квадратная (кадр 480x480 до пережатия), поэтому
  // кадр 320x320 — как у Медузы, Костяка и Бонессы. Растянуть её под
  // 320x274 значило бы сплющить питомца.
  pet_groot:   { frameW:320, frameH:320, dispScale:1, anchorY:0.80 },
  pet_nerb:    { frameW:320, frameH:320, dispScale:1, anchorY:0.80 },
  pet_vilord:  { frameW:320, frameH:320, dispScale:1, anchorY:0.80 },
};
Object.keys(PET_SPRITE_DEF).forEach(id => {
  PET_SPRITE_DEF[id].anims = {
    'front-idle': { src:`images/pet/${id}/Front - Idle.png`,    cols:4, rows:4, n:16, fps:7,  loop:true },
    'back-idle':  { src:`images/pet/${id}/Back - Idle.png`,     cols:4, rows:4, n:16, fps:7,  loop:true },
    'left-idle':  { src:`images/pet/${id}/Left - Idle.png`,     cols:4, rows:4, n:16, fps:7,  loop:true },
    'right-idle': { src:`images/pet/${id}/Right - Idle.png`,    cols:4, rows:4, n:16, fps:7,  loop:true },
    'front-run':  { src:`images/pet/${id}/Front - Running.png`, cols:4, rows:3, n:12, fps:14, loop:true },
    'back-run':   { src:`images/pet/${id}/Back - Running.png`,  cols:4, rows:3, n:12, fps:14, loop:true },
    'left-run':   { src:`images/pet/${id}/Left - Running.png`,  cols:4, rows:3, n:12, fps:14, loop:true },
    'right-run':  { src:`images/pet/${id}/Right - Running.png`, cols:4, rows:3, n:12, fps:14, loop:true },
  };
});

const petSpriteCache = {};
// A pet is drawn at half a player's height (_PET_DISPLAY_SCALE, js/pixi-
// world.js), so its cells only need half the player's cell — the source
// frames are 320px, rasterized at the full player cell they took ~4x the
// memory they could ever show.
// A function, not a const: _SPRITE_CELL_H is declared further down this file.
function _petCellH() { return Math.max(64, Math.ceil(_SPRITE_CELL_H * 0.5)); }
const _petSpriteLoadPromises = {};

// Mirrors loadSprites() below — its own cache/promise map so a pet's 8 sheets
// never collide with a class's 25, and so an equipped pet's (small) sheets
// aren't paid for by players who never craft one.
function loadPetSprites(petId, onDone) {
  onDone = onDone || function () {};
  const def = PET_SPRITE_DEF[petId];
  if (!def) { onDone(); return; }
  if (_petSpriteLoadPromises[petId]) { _petSpriteLoadPromises[petId].then(onDone); return; }
  petSpriteCache[petId] = petSpriteCache[petId] || {};
  const cache = petSpriteCache[petId];
  const keys = Object.keys(def.anims);
  let total = keys.length, done = 0;
  let resolveReady;
  _petSpriteLoadPromises[petId] = new Promise(res => { resolveReady = res; });
  function tick() { if (++done >= total) resolveReady(); }
  keys.forEach(key => {
    const img = new Image();
    img.src = def.anims[key].src;
    img.onload = () => {
      const raster = () => _queueRaster(() => {
        // tick() in finally, not after: a bad decode must still let this
        // pet's gate finish (see _queueRaster's own comment on the queue
        // itself) — cache[key] just stays the raw Image, same as onerror.
        try { cache[key] = _rasterizeSheet(img, def.anims[key], def, _petCellH()); } finally { tick(); }
      });
      if (img.decode) img.decode().then(raster, raster); else raster();
    };
    img.onerror = tick;
    cache[key] = img;
  });
  if (total === 0) resolveReady();
  _petSpriteLoadPromises[petId].then(onDone);
}

// ── one sheet, on demand ─────────────────────────────────────────────────────
// Other players' characters and pets used to load EVERY sheet the moment they
// were seen — 25 per class, 8 per pet — whether or not that animation was ever
// shown, and whether or not perf mode was even going to draw that player. In a
// crowd that is every class and every pet at once, all of it resident as a
// canvas plus a GPU texture for the rest of the session. These load one sheet
// the first time it is actually drawn (see _otherPlayerTextures/_updateOnePet,
// js/pixi-world.js), so a crowd standing still costs its idle sheets only.
// Shares the caches with loadSprites/loadPetSprites: whichever gets there
// first, the other finds the canvas and skips it.
const _sheetRequested = new Set();
function _loadOneSheet(cacheRoot, id, def, key, cellH) {
  if (!def || !def.anims || !def.anims[key]) return;
  const tag = id + '|' + key;
  const cache = cacheRoot[id] = cacheRoot[id] || {};
  if (cache[key] || _sheetRequested.has(tag)) return;
  _sheetRequested.add(tag);
  const img = new Image();
  img.onload = () => {
    const raster = () => _queueRaster(() => {
      // Someone else (a full loadSprites for our own class) may have
      // finished it first — keep theirs.
      if (cache[key] && _sheetReady(cache[key])) return;
      cache[key] = _rasterizeSheet(img, def.anims[key], def, cellH);
    });
    if (img.decode) img.decode().then(raster, raster); else raster();
  };
  // A failed sheet may be retried later rather than never.
  img.onerror = () => { _sheetRequested.delete(tag); if (cache[key] === img) delete cache[key]; };
  img.src = def.anims[key].src;
  cache[key] = img;
}
// The other half of pixi-world.js's _sweepSheets: forget a rasterized sheet
// so the canvas can be collected and the next request loads it again (from
// the browser's HTTP cache — no second download). The load promise goes too,
// or a later full loadSprites/loadEnemySprites would think it is all there.
function forgetSheet(kind, id, key) {
  if (kind === 'e') {
    delete enemySpriteCache[id];
    delete _enemySpriteLoadPromises[id];
    return;
  }
  const root  = kind === 'pet' ? petSpriteCache : spriteCache;
  const proms = kind === 'pet' ? _petSpriteLoadPromises : _spriteLoadPromises;
  if (root[id]) delete root[id][key];
  delete proms[id];
  _sheetRequested.delete(id + '|' + key);
}
// Other players' and pets' sheets are kept at 3/4 of the cell, on every
// device: under half the memory per sheet, a barely softer sprite on someone
// else. Your own class is loaded by the full loadSprites and keeps its size —
// if another player shares your class, they share your sheets.
function _otherCellH(full) { return Math.max(64, Math.ceil(full * 0.75)); }
function loadSpriteSheet(charType, key) {
  const def = SPRITE_DEF[charType];
  _loadOneSheet(spriteCache, charType, def, key,
    def ? _otherCellH(Math.min(_SPRITE_CELL_H, def.frameH || Infinity)) : undefined);
}
function loadPetSheet(petId, key) {
  _loadOneSheet(petSpriteCache, petId, PET_SPRITE_DEF[petId], key, _otherCellH(_petCellH()));
}

// ── всё при входе ────────────────────────────────────────────────────────────
// Персонажи у всех одинаковые — семь классов и двенадцать питомцев, а не свой
// набор на каждого игрока: сорок магов рисуются одним и тем же листом. Поэтому
// после входа (preloadAllSprites зовётся из js/game.js, когда мир уже на
// экране) грузится всё разом, в два слоя:
//
//   1. Стойки (все *-idle) каждого класса и питомца — сразу в память, готовыми
//      к отрисовке, и закреплены: _sweepSheets (js/pixi-world.js) их не
//      выгружает. Толпа, которая стоит, появляется мгновенно, и у любой другой
//      анимации всегда есть готовая стойка, пока та подгружается.
//   2. Всё остальное (бег, атака, смерть) — только скачивается в кэш браузера:
//      это файлы, а не картинки в памяти, и памяти они не занимают. Когда
//      анимация понадобится, лист берётся из кэша, без сети, за кадр.
//
// Держать в памяти ВСЁ сразу — ровно то, что вызывало перезагрузки в толпе,
// поэтому в памяти только стойки. Картинки отдаются с кэшем на 30 дней
// (server/static.js), так что скачивание происходит один раз, а не на каждый
// вход. При включённой экономии трафика второй слой пропускается.
const _pinnedSheets = new Set();   // 'id|key'
function isPinnedSheet(id, key) { return _pinnedSheets.has(id + '|' + key); }
let _preloadStarted = false;
function preloadAllSprites() {
  if (_preloadStarted) return;
  _preloadStarted = true;
  const rest = [];
  Object.keys(SPRITE_DEF).forEach(type => {
    Object.keys(SPRITE_DEF[type].anims).forEach(key => {
      if (key.endsWith('-idle')) { _pinnedSheets.add(type + '|' + key); loadSpriteSheet(type, key); }
      else rest.push(SPRITE_DEF[type].anims[key].src);
    });
  });
  Object.keys(PET_SPRITE_DEF).forEach(petId => {
    Object.keys(PET_SPRITE_DEF[petId].anims).forEach(key => {
      if (key.endsWith('-idle')) { _pinnedSheets.add(petId + '|' + key); loadPetSheet(petId, key); }
      else rest.push(PET_SPRITE_DEF[petId].anims[key].src);
    });
  });
  let saveData = false;
  try { saveData = !!(navigator.connection && navigator.connection.saveData); } catch (e) { /* нет API */ }
  if (saveData || typeof fetch !== 'function') return;
  // Три потока, по очереди, с низким приоритетом — не отнимать канал у игры.
  let i = 0;
  const next = () => {
    if (i >= rest.length) return;
    const url = rest[i++];
    fetch(url, { cache: 'force-cache', priority: 'low' })
      .then(r => r.arrayBuffer()).catch(() => {}).then(next);
  };
  for (let k = 0; k < 3; k++) next();
}

// ── ENEMY SPRITE SHEETS ─────────────────────────────────────────────────────
// images/monsters/<Вид><ярус>/{idle,walk,attack,death}.png — свои, отрендерены
// в том же ракурсе и свете, что и листы классов. У всех одна раскладка: кадр
// 128×128, 4 ряда направлений (0=вниз 1=вверх 2=влево 3=вправо), стоит — 6
// кадров, идёт / бьёт / умирает — по 8. Ярус 1 — страж, 2 — воин, 3 — босс
// своего рукава (shared/definitions.js ENEMY_DEF).
function _monsterSheets(name, slow) {
  const f = slow ? 0.8 : 1;
  const sh = (key, cols, fps, loop) => ({ src: `images/monsters/${name}/${key}.png`, cols, fps: Math.round(fps * f), loop });
  return { frameW: 128, frameH: 128, sheets: {
    idle: sh('idle', 6, 8, true), walk: sh('walk', 8, 12, true),
    attack: sh('attack', 8, 14, false), death: sh('death', 8, 10, false),
  } };
}
const ENEMY_SPRITE_DEF = {
  // ── Arm 1 (levels 1-30) ──────────────────────────────────────────────────
  rat_guard:         _monsterSheets('Rat1'),
  rat_warrior:       _monsterSheets('Rat2'),
  slime_guard:       _monsterSheets('Slime1'),
  slime_warrior:     _monsterSheets('Slime2'),
  imp_guard:         _monsterSheets('Imp1'),
  imp_warrior:       _monsterSheets('Imp2'),
  imp_boss:          _monsterSheets('Imp3'),
  // ── Arm 2 (levels 31-60) ─────────────────────────────────────────────────
  zombie_guard:      _monsterSheets('Zombie1'),
  zombie_warrior:    _monsterSheets('Zombie2'),
  lizardman_guard:   _monsterSheets('Lizardman1'),
  lizardman_warrior: _monsterSheets('Lizardman2'),
  orc_guard:         _monsterSheets('Orc1'),
  orc_warrior:       _monsterSheets('Orc2'),
  orc_boss:          _monsterSheets('Orc3'),
  // ── Arm 3 (levels 61-90) ─────────────────────────────────────────────────
  plant_guard:       _monsterSheets('Plant1'),
  plant_warrior:     _monsterSheets('Plant2'),
  vampire_guard:     _monsterSheets('Vampire1'),
  vampire_warrior:   _monsterSheets('Vampire2'),
  beholder_guard:    _monsterSheets('Beholder1'),
  beholder_warrior:  _monsterSheets('Beholder2'),
  beholder_boss:     _monsterSheets('Beholder3'),
  // ── Arm 4 (levels 91-120) — крупные, двигаются чуть медленнее ─────────────
  ent_guard:         _monsterSheets('Ent1', true),
  ent_warrior:       _monsterSheets('Ent2', true),
  demon_guard:       _monsterSheets('Demon1', true),
  demon_warrior:     _monsterSheets('Demon2', true),
  demon_boss:        _monsterSheets('Demon3', true),
  // Admin-summoned world-event boss (shared/definitions.js EVENT_BOSS) and the
  // 10-player corridor race boss (server/game/Room.js spawnRaceBoss) — the same
  // Demon3 art as the arm boss, drawn far larger via their own size. Each needs
  // its own entry because sprites are looked up by eid (js/ui.js
  // updateEventBossHpBar keys off eid === 'demon_event_boss').
  demon_event_boss:  _monsterSheets('Demon3', true),
  race10_boss:       _monsterSheets('Demon3', true),
  // Подземелье (Dungeon) zone guards — shared/definitions.js's DUNGEON_LICH.
  dungeon_lich_skeleton:  _monsterSheets('Lich1'),
  dungeon_lich_blue:      _monsterSheets('Lich2'),
  dungeon_lich_commander: _monsterSheets('Lich3'),
};

const enemySpriteCache = {};
// eid -> Promise resolved once every sheet for that enemy is loaded AND decoded.
// Callers may ask for the same eid again while a load is still in flight (e.g.
// the loading-screen gate and drawEnemySprite's own lazy-load both do) — chain
// onto the existing promise instead of firing onDone before decode finishes.
const _enemySpriteLoadPromises = {};

// Same rationale/fix as _SPRITE_CELL_H above, applied to monsters: enemy
// sheets are a 4-facing-row × N-frame grid in one image (up to ~1664×512px
// for a 13-frame death sheet) fed straight into PIXI.BaseTexture.from() on
// the raw Image with no rasterize step at all — profiling found that the
// first texture upload for a never-before-seen species+animation costs
// ~5-10ms avg, spiking past 30ms, and (same as the player bug) the raw
// Image stays a re-decode risk for as long as it's cached. Unlike player
// sheets there's no real headroom to downscale here — source frames are
// already only 64 or 128px and enemies render at up to ~130 world px — so
// this rasterizes 1:1 (cellH = def.frameH, i.e. scale 1) purely to convert
// Image → Canvas; a canvas's raw pixel buffer isn't subject to the
// browser's compressed-image-bitmap eviction/re-decode behavior the way an
// <img> is, which is the actual freeze this avoids, not a byte-size cut.
// A sheet whose img.onerror fires (mobile network blip, a request dropped
// mid-flight) used to just count as "done" and leave enemySpriteCache[eid][key]
// pointing at the broken <img> forever — _enemyTextures' naturalWidth check
// then treats that as "not yet rasterized" on every future frame, so the
// sprite never appears again for the rest of the session even though the
// server keeps simulating and hitting with that enemy: exactly the "monster
// hits you but you can't see it" symptom. A few retries with backoff gives a
// transient failure a real chance to recover before this enemy is given up on.
const ENEMY_SPRITE_LOAD_RETRIES = 4;
const ENEMY_SPRITE_RETRY_DELAY_MS = 600;

function loadEnemySprites(eid, onDone) {
  onDone = onDone || function () {};
  const def = ENEMY_SPRITE_DEF[eid];
  if (!def || !def.sheets) { onDone(); return; }
  if (_enemySpriteLoadPromises[eid]) { _enemySpriteLoadPromises[eid].then(onDone); return; }
  enemySpriteCache[eid] = {};
  const keys = Object.keys(def.sheets);
  let total = keys.length, done = 0;
  let resolveReady;
  _enemySpriteLoadPromises[eid] = new Promise(res => { resolveReady = res; });
  function tick() { if (++done >= total) resolveReady(); }
  keys.forEach(key => {
    const sh = def.sheets[key];
    let attempt = 0;
    const load = () => {
      const img = new Image();
      img.src = sh.src + (attempt > 0 ? (sh.src.includes('?') ? '&' : '?') + 'retry=' + attempt : '');
      img.onload = () => {
        const raster = () => _queueRaster(() => {
          // 4 facing rows × sh.cols frames, all in this one sheet image.
          // tick() in finally — a bad decode degrades to the raw Image
          // (same as the onerror branch below) instead of stalling this
          // enemy's gate forever.
          try {
            enemySpriteCache[eid][key] = _rasterizeSheet(img, { n: sh.cols * 4, cols: sh.cols }, def, def.frameH);
          } finally { tick(); }
        });
        if (img.decode) img.decode().then(raster, raster); else raster();
      };
      img.onerror = () => {
        attempt++;
        if (attempt <= ENEMY_SPRITE_LOAD_RETRIES) {
          setTimeout(load, ENEMY_SPRITE_RETRY_DELAY_MS * attempt);
        } else {
          console.error('[sprites] gave up loading enemy sheet after retries:', eid, key, sh.src);
          tick();
        }
      };
      enemySpriteCache[eid][key] = img;
    };
    load();
  });
  if (total === 0) resolveReady();
  _enemySpriteLoadPromises[eid].then(onDone);
}

// Sheet rows are uniform across all enemy sheets: 0=down 1=up 2=left 3=right
const ENEMY_FACING_ROW = { down: 0, up: 1, left: 2, right: 3 };


// ── NPC SPRITE SHEETS ───────────────────────────────────────────────────────
// NPCs stand in one spot facing the camera — a single-row idle loop is
// enough, no per-facing rows like enemies/players need.
const NPC_SPRITE_DEF = {
  merchant:   { src: 'images/npc/merchant.png',   frameW: 128, frameH: 128, cols: 7,  fps: 6,  loop: true },
  craftsman:  { src: 'images/npc/craftsman.png',  frameW: 128, frameH: 128, cols: 12, fps: 10, loop: true },
  storage:    { src: 'images/npc/shopkeeper.png', frameW: 128, frameH: 128, cols: 7,  fps: 6,  loop: true },
};

const npcSpriteCache = {};
const _npcSpriteLoadPromises = {};

function loadNpcSprites(id, onDone) {
  onDone = onDone || function () {};
  const def = NPC_SPRITE_DEF[id];
  if (!def) { onDone(); return; }
  if (npcSpriteCache[id]) { onDone(); return; }
  if (_npcSpriteLoadPromises[id]) { _npcSpriteLoadPromises[id].then(onDone); return; }
  let resolveReady;
  _npcSpriteLoadPromises[id] = new Promise(res => { resolveReady = res; });
  const img = new Image();
  img.src = def.src;
  img.onload = () => {
    const raster = () => _queueRaster(() => {
      // Single facing row, def.cols frames — same 1:1 rasterize-to-canvas
      // treatment as loadEnemySprites above (scale 1, Image → Canvas only).
      // resolveReady() in finally — a bad decode must still resolve this
      // NPC's promise, same as the onerror branch below.
      try {
        npcSpriteCache[id] = _rasterizeSheet(img, { n: def.cols, cols: def.cols }, def, def.frameH);
      } finally { resolveReady(); }
    });
    if (img.decode) img.decode().then(raster, raster); else raster();
  };
  img.onerror = resolveReady;
  npcSpriteCache[id] = img;
  _npcSpriteLoadPromises[id].then(onDone);
}


// ── PLAYER SPRITE SHEETS ────────────────────────────────────────────────────

const spriteCache = {};
// charType -> Promise resolved once every frame is loaded AND decoded — see
// _enemySpriteLoadPromises for why concurrent callers must chain onto it
// rather than firing onDone as soon as the cache object exists.
const _spriteLoadPromises = {};

// Player sheets ship at up to 3360×2880 (~37MB decoded RGBA apiece, ~13 sheets
// per character) but the character renders at 80 world-px × ZOOM(0.75) × DPR —
// at most ~240 device px tall. Keeping the full-res decoded bitmaps resident
// costs hundreds of MB; mobile browsers respond by discarding decoded image
// data under memory pressure and silently re-decoding on the next drawImage,
// which froze the main thread for 100-300ms exactly when the animation
// switched sheets (i.e. while moving / turning). Fix: rasterize each sheet
// once, at gameplay size, into a canvas — canvases stay rasterized and are
// never re-decoded — and drop the reference to the huge Image so GC can
// reclaim the decoded bitmap.
const _SPRITE_CELL_H = Math.max(120, Math.min(240,
  Math.ceil(80 * (typeof ZOOM !== 'undefined' ? ZOOM : 1) * (window.devicePixelRatio || 1))));

// Rasterizing one 3360×2880 sheet costs 10-50ms of main-thread time; when a
// character's sheets all come from HTTP cache their decodes resolve nearly
// simultaneously and 13 back-to-back rasterizations freeze the game for a
// beat — visible as a stutter the moment another player enters the screen.
// Serialize them: one sheet per frame so the game loop breathes between.
//
// This used setTimeout(pump, 0) between jobs, which does NOT reliably give
// the browser a chance to paint — a zero-delay timeout only defers to the
// next macrotask, and a chain of them can run back-to-back with no repaint
// in between under load, which is exactly the "freeze that doesn't show up
// in the frame-time counters" this queue was supposed to prevent (profiling
// on a real device found the drop-in-the-hub stutter this comment already
// describes, with _profUpdate/_profRender both reporting nothing wrong,
// because this whole queue runs outside the main loop() call it measures).
// requestAnimationFrame callbacks are specifically defined to run once per
// actual paint, so scheduling the next job through it guarantees the
// browser gets to draw the frame in between — same one-job-at-a-time
// pacing, just synced to real paints instead of hoping a paint sneaks in.
const _rasterQueue = [];
let _rasterPumping = false;
function _queueRaster(job) {
  _rasterQueue.push(job);
  if (_rasterPumping) return;
  _rasterPumping = true;
  const pump = () => {
    const j = _rasterQueue.shift();
    // try/catch, not just "let it throw": a job left `j()` to throw (a bad
    // decode, a canvas over some browser's size cap — whatever the cause) and
    // the two lines below it — the ones that either schedule the NEXT frame
    // or clear _rasterPumping — never ran. Nothing after that point ever
    // pumped again: not the rest of THIS character's sheets, not any other
    // character's, not an enemy's or an NPC's — every future _queueRaster
    // call just piled onto _rasterQueue forever, because _rasterPumping was
    // stuck true. That is a loading bar parked at whatever percentage had
    // loaded before the bad sheet, permanently, for the rest of the session.
    if (j) { try { j(); } catch (e) { console.error('[sprites] rasterize job failed', e); } }
    if (_rasterQueue.length) requestAnimationFrame(pump);
    else _rasterPumping = false;
  };
  requestAnimationFrame(pump);
}

// Never above the source frame: the class sheets are 128px frames, and on a
// DPR-3 phone _SPRITE_CELL_H is 180 — rasterizing "up" to it added no detail
// (the GPU scales the same way at draw time) and cost twice the memory, as a
// canvas AND as a texture. With every class and a dozen pets on screen in
// the hub that was over a gigabyte, and Telegram's WebView answers that by
// killing the page and loading it again — «в местах скопления игра сама
// перезагружается».
function _rasterizeSheet(img, ad, def, cellH) {
  const targetH = Math.min(cellH || _SPRITE_CELL_H, def.frameH || Infinity);
  const scale = targetH / def.frameH;
  const cw = Math.ceil(def.frameW * scale), ch = targetH;
  const rows = Math.ceil(ad.n / ad.cols);
  const cv = document.createElement('canvas');
  cv.width = cw * ad.cols; cv.height = ch * rows;
  const c = cv.getContext('2d');
  // Per-frame integer cells (not one whole-sheet scaled blit) so frames never
  // bleed into each other through bilinear filtering at fractional borders.
  for (let i = 0; i < ad.n; i++) {
    const col = i % ad.cols, row = Math.floor(i / ad.cols);
    c.drawImage(img, col * def.frameW, row * def.frameH, def.frameW, def.frameH,
      col * cw, row * ch, cw, ch);
  }
  // Draw code reads frame size off the cache entry so canvas and Image
  // entries stay interchangeable.
  cv.frameW = cw; cv.frameH = ch;
  return cv;
}

// A cache entry is drawable only after rasterization (canvas). Raw Images are
// never used for drawing — even a loaded Image can be 3360×2880px (warrior),
// and downsampling it per frame at 6× on mobile GPU costs 20ms+.
function _sheetReady(entry) {
  if (!entry) return false;
  return entry.naturalWidth === undefined; // true only for rasterized canvas
}

// Char-select shows 5 idle previews at once — only the 'front-idle' frame is
// ever drawn there, so only load+decode that one sheet per unpicked character.
// Eagerly decoding all 13 sheets × 5 characters (some up to 3360×2880px) at
// once was overwhelming the browser's image-decode pipeline: decode() calls
// started silently rejecting under the load, leaving bitmaps un-warmed, which
// then forced a synchronous decode-on-draw (a 100-300ms freeze) the first
// time the chosen character's run/attack animation was drawn mid-game.
function loadSpritePreviewFrame(charType, onDone) {
  onDone = onDone || function () {};
  const def = SPRITE_DEF[charType];
  if (!def) { onDone(); return; }
  spriteCache[charType] = spriteCache[charType] || {};
  const cache = spriteCache[charType];
  if (cache['front-idle']) { onDone(); return; }
  const img = new Image();
  img.src = def.anims['front-idle'].src;
  img.onload = () => {
    const raster = () => {
      try { cache['front-idle'] = _rasterizeSheet(img, def.anims['front-idle'], def); }
      finally { onDone(); }
    };
    if (img.decode) img.decode().then(raster, raster); else raster();
  };
  img.onerror = onDone;
  cache['front-idle'] = img;
}

// onProgress(done, total) — необязательный третий аргумент, по одному вызову
// на разобранный лист. Экран загрузки рисует по нему НАСТОЯЩУЮ полосу: до
// этого там крутились три точки, которые анимировались одинаково и на быстрой
// сети, и на застрявшей загрузке, то есть не значили ничего.
function loadSprites(charType, onDone, onProgress) {
  const def = SPRITE_DEF[charType];
  if (!def) { if (onProgress) onProgress(1, 1); onDone(); return; }
  if (_spriteLoadPromises[charType]) { _spriteLoadPromises[charType].then(onDone); return; }
  spriteCache[charType] = spriteCache[charType] || {};
  const cache = spriteCache[charType];
  // Навыки и второй замах в полосу загрузки не входят: без них в игру войти
  // можно, а это 40 листов на класс. Они догружаются следом, по одному за
  // кадр (_queueRaster), пока игрок уже бегает.
  const all = Object.keys(def.anims);
  const keys = all.filter(k => !_isCastExtra(k));
  let total = keys.length, done = 0;
  let resolveReady;
  _spriteLoadPromises[charType] = new Promise(res => { resolveReady = res; });
  function tick() {
    done++;
    if (onProgress) { try { onProgress(done, total); } catch (e) { /* екран не зобов’язаний існувати */ } }
    if (done >= total) resolveReady();
  }
  keys.forEach(key => {
    const existing = cache[key];
    // Already rasterized (char-select preview) — nothing left to do.
    if (existing && existing.naturalWidth === undefined) { tick(); return; }
    const applyRaster = (img) => {
      const raster = () => _queueRaster(() => {
        // tick() in finally — this is the gate csOnSpritesReady waits on
        // (js/charselect.js): a bad decode that skipped tick() here used to
        // leave the loading bar parked short of 100% forever, with no error
        // visible anywhere but the console. Degrades to the raw Image
        // instead, same as the onerror branch below.
        try { cache[key] = _rasterizeSheet(img, def.anims[key], def); } finally { tick(); }
      });
      if (img.decode) img.decode().then(raster, raster); else raster();
    };
    // Preview Image loaded but not yet rasterized — rasterize it in place.
    if (existing && existing.complete && existing.naturalWidth > 0) {
      applyRaster(existing);
      return;
    }
    const img = new Image();
    img.src = def.anims[key].src;
    img.onload = () => applyRaster(img);
    img.onerror = tick;
    cache[key] = img;
  });
  if (total === 0) { if (onProgress) onProgress(1, 1); resolveReady(); }
  _spriteLoadPromises[charType].then(() => {
    all.forEach(k => { if (_isCastExtra(k)) _loadOneSheet(spriteCache, charType, def, k); });
  });
  _spriteLoadPromises[charType].then(onDone);
}

// ── скорость анимации бега ───────────────────────────────────────────────
// Опорная нога в листах Running проходит 4–5 px листа за кадр (замерено по
// Right - Running у всех классов). Лист крутился на постоянных 15 к/с, а
// персонаж едет 130–175 px/с — ноги шли вдвое медленнее земли, и он будто
// полз на месте. Теперь кадры идут с той скоростью, с какой он реально
// движется: шаг совпадает с землёй при любом бонусе к бегу или замедлении.
const RUN_STRIDE_SRC_PX = 4.5;
function runAnimFps(type, speed) {
  const def = SPRITE_DEF[type];
  if (!def) return 15;
  const dh = (typeof _PLAYER_DISPLAY_H !== 'undefined' ? _PLAYER_DISPLAY_H : 74.8) * (def.dispScale || 1);
  const px = RUN_STRIDE_SRC_PX * dh / (def.frameH || 128);
  return Math.max(12, Math.min(48, speed / px));
}
// Сглаженная фактическая скорость сущности (px/с) — по ней runAnimFps. Не
// по заявленной скорости: та не знает ни про стену, ни про джойстик вполсилы.
function animMoveSpeed(o, dt) {
  if (o._ax !== undefined && dt > 0) {
    const v = Math.min(400, Math.hypot(o.x - o._ax, o.y - o._ay) / dt);
    o._vSm = o._vSm === undefined ? v : o._vSm + (v - o._vSm) * Math.min(1, dt * 8);
  }
  o._ax = o.x; o._ay = o.y;
  return o._vSm || 0;
}

function _isCastExtra(key) { return /-(skill[qwer]|attack2)$/.test(key); }

// Ключ замаха или навыка. p._skillAnim ('skillq'..'skillr') ставит каст
// навыка, обычный удар его снимает и чередует attack/attack2 через p._atkAlt.
// Если нужного листа нет (класс без таких анимаций) или он ещё не готов —
// играет обычная атака, а лист заказывается: свой класс в полном размере,
// чужой — как все чужие листы (loadSpriteSheet).
function castAnimKey(p, dir, own) {
  const base = `${dir}-attack`;
  const def = SPRITE_DEF[p.type];
  if (!def) return base;
  const want = p._skillAnim ? `${dir}-${p._skillAnim}` : (p._atkAlt ? `${dir}-attack2` : base);
  if (want === base || !def.anims[want]) return base;
  if (_sheetReady(spriteCache[p.type] && spriteCache[p.type][want])) return want;
  if (own) _loadOneSheet(spriteCache, p.type, def, want);
  else loadSpriteSheet(p.type, want);
  return base;
}

function getSpriteAnimKey(p) {
  if (state === 'dead') return 'die';
  const dir = p.facing || 'front';
  if (p.atkAnimTimer > 0)  return castAnimKey(p, dir, true);
  const inp = inputDir();
  if (inp.len > 0.05 || p._chasing) return `${dir}-run`;
  return `${dir}-idle`;
}

