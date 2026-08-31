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
  ranger: {
    frameW: 128, frameH: 128,
    dispScale: 1.5,
    anims: {
      'front-idle':   { src:'images/Ranger/Front - Idle.png?v=2',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'back-idle':    { src:'images/Ranger/Back - Idle.png?v=2',        cols:15, rows:1, n:15, fps:7,  loop:true  },
      'left-idle':    { src:'images/Ranger/Left - Idle.png?v=2',        cols:15, rows:1, n:15, fps:7,  loop:true  },
      'right-idle':   { src:'images/Ranger/Right - Idle.png?v=2',       cols:15, rows:1, n:15, fps:7,  loop:true  },
      'front-run':    { src:'images/Ranger/Front - Running.png?v=2',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'back-run':     { src:'images/Ranger/Back - Running.png?v=2',     cols:15, rows:1, n:15, fps:15, loop:true  },
      'left-run':     { src:'images/Ranger/Left - Running.png?v=2',     cols:15, rows:1, n:15, fps:15, loop:true  },
      'right-run':    { src:'images/Ranger/Right - Running.png?v=2',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'front-attack': { src:'images/Ranger/Front - Attacking.png?v=2',  cols:15, rows:1, n:15, fps:14, loop:false },
      'back-attack':  { src:'images/Ranger/Back - Attacking.png?v=2',   cols:15, rows:1, n:15, fps:14, loop:false },
      'left-attack':  { src:'images/Ranger/Left - Attacking.png?v=2',   cols:15, rows:1, n:15, fps:14, loop:false },
      'right-attack': { src:'images/Ranger/Right - Attacking.png?v=2',  cols:15, rows:1, n:15, fps:14, loop:false },
      'frontright-idle':   { src:'images/Ranger/FrontRight - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'frontleft-idle':   { src:'images/Ranger/FrontLeft - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'backright-idle':   { src:'images/Ranger/BackRight - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'backleft-idle':   { src:'images/Ranger/BackLeft - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'frontright-run':    { src:'images/Ranger/FrontRight - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'frontleft-run':    { src:'images/Ranger/FrontLeft - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'backright-run':    { src:'images/Ranger/BackRight - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'backleft-run':    { src:'images/Ranger/BackLeft - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'frontright-attack': { src:'images/Ranger/FrontRight - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'frontleft-attack': { src:'images/Ranger/FrontLeft - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'backright-attack': { src:'images/Ranger/BackRight - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'backleft-attack': { src:'images/Ranger/BackLeft - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'die':          { src:'images/Ranger/Dying.png?v=2',              cols:15, rows:1, n:15, fps:12, loop:false },
    }
  },
  mage: {
    frameW: 128, frameH: 128,
    dispScale: 1.5,
    anims: {
      'front-idle':   { src:'images/Mage/Front - Idle.png?v=2',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'back-idle':    { src:'images/Mage/Back - Idle.png?v=2',        cols:15, rows:1, n:15, fps:7,  loop:true  },
      'left-idle':    { src:'images/Mage/Left - Idle.png?v=2',        cols:15, rows:1, n:15, fps:7,  loop:true  },
      'right-idle':   { src:'images/Mage/Right - Idle.png?v=2',       cols:15, rows:1, n:15, fps:7,  loop:true  },
      'front-run':    { src:'images/Mage/Front - Running.png?v=2',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'back-run':     { src:'images/Mage/Back - Running.png?v=2',     cols:15, rows:1, n:15, fps:15, loop:true  },
      'left-run':     { src:'images/Mage/Left - Running.png?v=2',     cols:15, rows:1, n:15, fps:15, loop:true  },
      'right-run':    { src:'images/Mage/Right - Running.png?v=2',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'front-attack': { src:'images/Mage/Front - Attacking.png?v=2',  cols:15, rows:1, n:15, fps:14, loop:false },
      'back-attack':  { src:'images/Mage/Back - Attacking.png?v=2',   cols:15, rows:1, n:15, fps:14, loop:false },
      'left-attack':  { src:'images/Mage/Left - Attacking.png?v=2',   cols:15, rows:1, n:15, fps:14, loop:false },
      'right-attack': { src:'images/Mage/Right - Attacking.png?v=2',  cols:15, rows:1, n:15, fps:14, loop:false },
      'frontright-idle':   { src:'images/Mage/FrontRight - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'frontleft-idle':   { src:'images/Mage/FrontLeft - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'backright-idle':   { src:'images/Mage/BackRight - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'backleft-idle':   { src:'images/Mage/BackLeft - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'frontright-run':    { src:'images/Mage/FrontRight - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'frontleft-run':    { src:'images/Mage/FrontLeft - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'backright-run':    { src:'images/Mage/BackRight - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'backleft-run':    { src:'images/Mage/BackLeft - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'frontright-attack': { src:'images/Mage/FrontRight - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'frontleft-attack': { src:'images/Mage/FrontLeft - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'backright-attack': { src:'images/Mage/BackRight - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'backleft-attack': { src:'images/Mage/BackLeft - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'die':          { src:'images/Mage/Dying.png?v=2',              cols:15, rows:1, n:15, fps:12, loop:false },
    }
  },
  warlock: {
    frameW: 128, frameH: 128,
    dispScale: 1.5,
    anims: {
      'front-idle':   { src:'images/Warlock/Front - Idle.png?v=2',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'back-idle':    { src:'images/Warlock/Back - Idle.png?v=2',        cols:15, rows:1, n:15, fps:7,  loop:true  },
      'left-idle':    { src:'images/Warlock/Left - Idle.png?v=2',        cols:15, rows:1, n:15, fps:7,  loop:true  },
      'right-idle':   { src:'images/Warlock/Right - Idle.png?v=2',       cols:15, rows:1, n:15, fps:7,  loop:true  },
      'front-run':    { src:'images/Warlock/Front - Running.png?v=2',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'back-run':     { src:'images/Warlock/Back - Running.png?v=2',     cols:15, rows:1, n:15, fps:15, loop:true  },
      'left-run':     { src:'images/Warlock/Left - Running.png?v=2',     cols:15, rows:1, n:15, fps:15, loop:true  },
      'right-run':    { src:'images/Warlock/Right - Running.png?v=2',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'front-attack': { src:'images/Warlock/Front - Attacking.png?v=2',  cols:15, rows:1, n:15, fps:14, loop:false },
      'back-attack':  { src:'images/Warlock/Back - Attacking.png?v=2',   cols:15, rows:1, n:15, fps:14, loop:false },
      'left-attack':  { src:'images/Warlock/Left - Attacking.png?v=2',   cols:15, rows:1, n:15, fps:14, loop:false },
      'right-attack': { src:'images/Warlock/Right - Attacking.png?v=2',  cols:15, rows:1, n:15, fps:14, loop:false },
      'frontright-idle':   { src:'images/Warlock/FrontRight - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'frontleft-idle':   { src:'images/Warlock/FrontLeft - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'backright-idle':   { src:'images/Warlock/BackRight - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'backleft-idle':   { src:'images/Warlock/BackLeft - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'frontright-run':    { src:'images/Warlock/FrontRight - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'frontleft-run':    { src:'images/Warlock/FrontLeft - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'backright-run':    { src:'images/Warlock/BackRight - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'backleft-run':    { src:'images/Warlock/BackLeft - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'frontright-attack': { src:'images/Warlock/FrontRight - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'frontleft-attack': { src:'images/Warlock/FrontLeft - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'backright-attack': { src:'images/Warlock/BackRight - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'backleft-attack': { src:'images/Warlock/BackLeft - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'die':          { src:'images/Warlock/Dying.png?v=2',              cols:15, rows:1, n:15, fps:12, loop:false },
    }
  },
  lev: {
    frameW: 128, frameH: 128,
    dispScale: 1.5,
    anims: {
      // ?v=3 cache-busts these paths: the underlying PNGs were re-extracted
      // (correcting left/right) multiple times under the same filenames, and
      // browsers/Telegram's WebView cache images by URL — without a version
      // bump, clients that had already loaded Lev once kept rendering the
      // stale, pre-fix sprites no matter what the server now serves.
      'front-idle':   { src:'images/Lev/Front - Idle.png?v=3',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'back-idle':    { src:'images/Lev/Back - Idle.png?v=3',        cols:15, rows:1, n:15, fps:7,  loop:true  },
      'left-idle':    { src:'images/Lev/Left - Idle.png?v=3',        cols:15, rows:1, n:15, fps:7,  loop:true  },
      'right-idle':   { src:'images/Lev/Right - Idle.png?v=3',       cols:15, rows:1, n:15, fps:7,  loop:true  },
      'front-run':    { src:'images/Lev/Front - Running.png?v=3',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'back-run':     { src:'images/Lev/Back - Running.png?v=3',     cols:15, rows:1, n:15, fps:15, loop:true  },
      'left-run':     { src:'images/Lev/Left - Running.png?v=3',     cols:15, rows:1, n:15, fps:15, loop:true  },
      'right-run':    { src:'images/Lev/Right - Running.png?v=3',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'front-attack': { src:'images/Lev/Front - Attacking.png?v=3',  cols:15, rows:1, n:15, fps:14, loop:false },
      'back-attack':  { src:'images/Lev/Back - Attacking.png?v=3',   cols:15, rows:1, n:15, fps:14, loop:false },
      'left-attack':  { src:'images/Lev/Left - Attacking.png?v=3',   cols:15, rows:1, n:15, fps:14, loop:false },
      'right-attack': { src:'images/Lev/Right - Attacking.png?v=3',  cols:15, rows:1, n:15, fps:14, loop:false },
      'frontright-idle':   { src:'images/Lev/FrontRight - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'frontleft-idle':   { src:'images/Lev/FrontLeft - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'backright-idle':   { src:'images/Lev/BackRight - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'backleft-idle':   { src:'images/Lev/BackLeft - Idle.png',      cols:15, rows:1, n:15, fps:7,  loop:true  },
      'frontright-run':    { src:'images/Lev/FrontRight - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'frontleft-run':    { src:'images/Lev/FrontLeft - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'backright-run':    { src:'images/Lev/BackRight - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'backleft-run':    { src:'images/Lev/BackLeft - Running.png',    cols:15, rows:1, n:15, fps:15, loop:true  },
      'frontright-attack': { src:'images/Lev/FrontRight - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'frontleft-attack': { src:'images/Lev/FrontLeft - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'backright-attack': { src:'images/Lev/BackRight - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'backleft-attack': { src:'images/Lev/BackLeft - Attacking.png',  cols:15, rows:1, n:15, fps:14, loop:false },
      'die':          { src:'images/Lev/Dying.png',              cols:15, rows:1, n:15, fps:12, loop:false },
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
        cache[key] = _rasterizeSheet(img, def.anims[key], def); tick();
      });
      if (img.decode) img.decode().then(raster, raster); else raster();
    };
    img.onerror = tick;
    cache[key] = img;
  });
  if (total === 0) resolveReady();
  _petSpriteLoadPromises[petId].then(onDone);
}

// ── ENEMY SPRITE SHEETS ─────────────────────────────────────────────────────
// 64×64 frames (Rat/Ent/Demon 128×128), 4 directional rows: 0=down 1=up 2=left 3=right.
// Each species has 3 tiers (Species1 weakest look → Species3 strongest); guard
// uses tier1, warrior uses tier2, and whichever species is that arm's boss
// reuses its own tier3 for the boss look — see shared/definitions.js ENEMY_DEF.
const ENEMY_SPRITE_DEF = {
  // ── Arm 1 (levels 1-30) ──────────────────────────────────────────────────
  rat_guard: {
    frameW: 128, frameH: 128,
    sheets: {
      idle:   { src:'images/Monster2/Rat/Rat1/With_shadow/Rat1_Idle_with_shadow.png',     cols:6, fps:8,  loop:true  },
      walk:   { src:'images/Monster2/Rat/Rat1/With_shadow/Rat1_Run_with_shadow.png',      cols:6, fps:12, loop:true  },
      attack: { src:'images/Monster2/Rat/Rat1/With_shadow/Rat1_Attack_with_shadow.png',   cols:8, fps:14, loop:false },
      death:  { src:'images/Monster2/Rat/Rat1/With_shadow/Rat1_Death_with_shadow.png',    cols:5, fps:8,  loop:false },
    }
  },
  rat_warrior: {
    frameW: 128, frameH: 128,
    sheets: {
      idle:   { src:'images/Monster2/Rat/Rat2/With_shadow/Rat2_Idle_with_shadow.png',     cols:6, fps:8,  loop:true  },
      walk:   { src:'images/Monster2/Rat/Rat2/With_shadow/Rat2_Run_with_shadow.png',      cols:6, fps:12, loop:true  },
      attack: { src:'images/Monster2/Rat/Rat2/With_shadow/Rat2_Attack_with_shadow.png',   cols:8, fps:14, loop:false },
      death:  { src:'images/Monster2/Rat/Rat2/With_shadow/Rat2_Death_with_shadow.png',    cols:5, fps:8,  loop:false },
    }
  },
  slime_guard: {
    frameW: 64, frameH: 64,
    sheets: {
      idle:   { src:'images/Monster2/Slime/Slime1/With_shadow/Slime1_Idle_with_shadow.png',     cols:6,  fps:8,  loop:true  },
      walk:   { src:'images/Monster2/Slime/Slime1/With_shadow/Slime1_Run_with_shadow.png',      cols:8,  fps:12, loop:true  },
      attack: { src:'images/Monster2/Slime/Slime1/With_shadow/Slime1_Attack_with_shadow.png',   cols:10, fps:14, loop:false },
      death:  { src:'images/Monster2/Slime/Slime1/With_shadow/Slime1_Death_with_shadow.png',     cols:8,  fps:8,  loop:false },
    }
  },
  slime_warrior: {
    frameW: 64, frameH: 64,
    sheets: {
      idle:   { src:'images/Monster2/Slime/Slime2/With_shadow/Slime2_Idle_with_shadow.png',     cols:6,  fps:8,  loop:true  },
      walk:   { src:'images/Monster2/Slime/Slime2/With_shadow/Slime2_Run_with_shadow.png',      cols:8,  fps:12, loop:true  },
      attack: { src:'images/Monster2/Slime/Slime2/With_shadow/Slime2_Attack_with_shadow.png',   cols:10, fps:14, loop:false },
      death:  { src:'images/Monster2/Slime/Slime2/With_shadow/Slime2_Death_with_shadow.png',     cols:10, fps:8,  loop:false },
    }
  },
  imp_guard: {
    frameW: 64, frameH: 64,
    sheets: {
      idle:   { src:'images/Monster2/Imp/Imp1/With_shadow/Imp1_Idle_with_shadow.png',     cols:4,  fps:8,  loop:true  },
      walk:   { src:'images/Monster2/Imp/Imp1/With_shadow/Imp1_Run_with_shadow.png',      cols:8,  fps:12, loop:true  },
      attack: { src:'images/Monster2/Imp/Imp1/With_shadow/Imp1_Attack_with_shadow.png',   cols:6,  fps:14, loop:false },
      death:  { src:'images/Monster2/Imp/Imp1/With_shadow/Imp1_Death_with_shadow.png',    cols:10, fps:8,  loop:false },
    }
  },
  imp_warrior: {
    frameW: 64, frameH: 64,
    sheets: {
      idle:   { src:'images/Monster2/Imp/Imp2/With_shadow/Imp2_Idle_with_shadow.png',     cols:4,  fps:8,  loop:true  },
      walk:   { src:'images/Monster2/Imp/Imp2/With_shadow/Imp2_Run_with_shadow.png',      cols:8,  fps:12, loop:true  },
      attack: { src:'images/Monster2/Imp/Imp2/With_shadow/Imp2_Attack_with_shadow.png',   cols:6,  fps:14, loop:false },
      death:  { src:'images/Monster2/Imp/Imp2/With_shadow/Imp2_Death_with_shadow.png',    cols:10, fps:8,  loop:false },
    }
  },
  imp_boss: {
    frameW: 64, frameH: 64,
    sheets: {
      idle:   { src:'images/Monster2/Imp/Imp3/With_shadow/Imp3_Idle_with_shadow.png',     cols:4,  fps:8,  loop:true  },
      walk:   { src:'images/Monster2/Imp/Imp3/With_shadow/Imp3_Run_with_shadow.png',      cols:8,  fps:12, loop:true  },
      attack: { src:'images/Monster2/Imp/Imp3/With_shadow/Imp3_Attack_with_shadow.png',   cols:6,  fps:14, loop:false },
      death:  { src:'images/Monster2/Imp/Imp3/With_shadow/Imp3_Death_with_shadow.png',    cols:10, fps:8,  loop:false },
    }
  },
  // ── Arm 2 (levels 31-60) ─────────────────────────────────────────────────
  zombie_guard: {
    frameW: 64, frameH: 64,
    sheets: {
      idle:   { src:'images/Monster2/Zombie/Zombie1/With_shadow/Zombie1_Idle_with_shadow.png',     cols:4,  fps:8,  loop:true  },
      walk:   { src:'images/Monster2/Zombie/Zombie1/With_shadow/Zombie1_Run_with_shadow.png',      cols:8,  fps:12, loop:true  },
      attack: { src:'images/Monster2/Zombie/Zombie1/With_shadow/Zombie1_Attack_with_shadow.png',   cols:10, fps:14, loop:false },
      death:  { src:'images/Monster2/Zombie/Zombie1/With_shadow/Zombie1_Death_with_shadow.png',    cols:9,  fps:8,  loop:false },
    }
  },
  zombie_warrior: {
    frameW: 64, frameH: 64,
    sheets: {
      idle:   { src:'images/Monster2/Zombie/Zombie2/With_shadow/Zombie2_Idle_with_shadow.png',     cols:4,  fps:8,  loop:true  },
      walk:   { src:'images/Monster2/Zombie/Zombie2/With_shadow/Zombie2_Run_with_shadow.png',      cols:8,  fps:12, loop:true  },
      attack: { src:'images/Monster2/Zombie/Zombie2/With_shadow/Zombie2_Attack_with_shadow.png',   cols:10, fps:14, loop:false },
      death:  { src:'images/Monster2/Zombie/Zombie2/With_shadow/Zombie2_Death_with_shadow.png',    cols:9,  fps:8,  loop:false },
    }
  },
  lizardman_guard: {
    frameW: 64, frameH: 64,
    sheets: {
      idle:   { src:'images/Monster2/Lizardman/Lizardman1/With_shadow/Lizardman1_Idle_with_shadow.png',     cols:4, fps:8,  loop:true  },
      walk:   { src:'images/Monster2/Lizardman/Lizardman1/With_shadow/Lizardman1_Run_with_shadow.png',      cols:8, fps:12, loop:true  },
      attack: { src:'images/Monster2/Lizardman/Lizardman1/With_shadow/Lizardman1_Attack_with_shadow.png',   cols:7, fps:14, loop:false },
      death:  { src:'images/Monster2/Lizardman/Lizardman1/With_shadow/Lizardman1_Death_with_shadow.png',    cols:7, fps:8,  loop:false },
    }
  },
  lizardman_warrior: {
    frameW: 64, frameH: 64,
    sheets: {
      idle:   { src:'images/Monster2/Lizardman/Lizardman2/With_shadow/Lizardman2_Idle_with_shadow.png',     cols:4, fps:8,  loop:true  },
      walk:   { src:'images/Monster2/Lizardman/Lizardman2/With_shadow/Lizardman2_Run_with_shadow.png',      cols:8, fps:12, loop:true  },
      attack: { src:'images/Monster2/Lizardman/Lizardman2/With_shadow/Lizardman2_Attack_with_shadow.png',   cols:7, fps:14, loop:false },
      death:  { src:'images/Monster2/Lizardman/Lizardman2/With_shadow/Lizardman2_Death_with_shadow.png',    cols:7, fps:8,  loop:false },
    }
  },
  orc_guard: {
    frameW: 64, frameH: 64,
    sheets: {
      idle:   { src:'images/Monster2/Orc/Orc1/With_shadow/orc1_idle_with_shadow.png',     cols:4, fps:8,  loop:true  },
      walk:   { src:'images/Monster2/Orc/Orc1/With_shadow/orc1_run_with_shadow.png',      cols:8, fps:12, loop:true  },
      attack: { src:'images/Monster2/Orc/Orc1/With_shadow/orc1_attack_with_shadow.png',   cols:8, fps:14, loop:false },
      death:  { src:'images/Monster2/Orc/Orc1/With_shadow/orc1_death_with_shadow.png',    cols:8, fps:8,  loop:false },
    }
  },
  orc_warrior: {
    frameW: 64, frameH: 64,
    sheets: {
      idle:   { src:'images/Monster2/Orc/Orc2/With_shadow/orc2_idle_with_shadow.png',     cols:4, fps:8,  loop:true  },
      walk:   { src:'images/Monster2/Orc/Orc2/With_shadow/orc2_run_with_shadow.png',      cols:8, fps:12, loop:true  },
      attack: { src:'images/Monster2/Orc/Orc2/With_shadow/orc2_attack_with_shadow.png',   cols:8, fps:14, loop:false },
      death:  { src:'images/Monster2/Orc/Orc2/With_shadow/orc2_death_with_shadow.png',    cols:8, fps:8,  loop:false },
    }
  },
  orc_boss: {
    frameW: 64, frameH: 64,
    sheets: {
      idle:   { src:'images/Monster2/Orc/Orc3/With_shadow/orc3_idle_with_shadow.png',     cols:4, fps:8,  loop:true  },
      walk:   { src:'images/Monster2/Orc/Orc3/With_shadow/orc3_run_with_shadow.png',      cols:8, fps:12, loop:true  },
      attack: { src:'images/Monster2/Orc/Orc3/With_shadow/orc3_attack_with_shadow.png',   cols:8, fps:14, loop:false },
      death:  { src:'images/Monster2/Orc/Orc3/With_shadow/orc3_death_with_shadow.png',    cols:8, fps:8,  loop:false },
    }
  },
  // ── Arm 3 (levels 61-90) ─────────────────────────────────────────────────
  plant_guard: {
    frameW: 64, frameH: 64,
    sheets: {
      idle:   { src:'images/Monster2/Plant/Plant1/With_shadow/Plant1_Idle_with_shadow.png',     cols:4,  fps:8,  loop:true  },
      walk:   { src:'images/Monster2/Plant/Plant1/With_shadow/Plant1_Run_with_shadow.png',      cols:8,  fps:12, loop:true  },
      attack: { src:'images/Monster2/Plant/Plant1/With_shadow/Plant1_Attack_with_shadow.png',   cols:7,  fps:14, loop:false },
      death:  { src:'images/Monster2/Plant/Plant1/With_shadow/Plant1_Death_with_shadow.png',    cols:10, fps:8,  loop:false },
    }
  },
  plant_warrior: {
    frameW: 64, frameH: 64,
    sheets: {
      idle:   { src:'images/Monster2/Plant/Plant2/With_shadow/Plant2_Idle_with_shadow.png',     cols:4,  fps:8,  loop:true  },
      walk:   { src:'images/Monster2/Plant/Plant2/With_shadow/Plant2_Run_with_shadow.png',      cols:8,  fps:12, loop:true  },
      attack: { src:'images/Monster2/Plant/Plant2/With_shadow/Plant2_Attack_with_shadow.png',   cols:7,  fps:14, loop:false },
      death:  { src:'images/Monster2/Plant/Plant2/With_shadow/Plant2_Death_with_shadow.png',    cols:10, fps:8,  loop:false },
    }
  },
  vampire_guard: {
    frameW: 64, frameH: 64,
    sheets: {
      idle:   { src:'images/Monster2/Vampire/Vampires1/With_shadow/Vampires1_Idle_with_shadow.png',     cols:4,  fps:8,  loop:true  },
      walk:   { src:'images/Monster2/Vampire/Vampires1/With_shadow/Vampires1_Run_with_shadow.png',      cols:8,  fps:12, loop:true  },
      attack: { src:'images/Monster2/Vampire/Vampires1/With_shadow/Vampires1_Attack_with_shadow.png',   cols:12, fps:14, loop:false },
      death:  { src:'images/Monster2/Vampire/Vampires1/With_shadow/Vampires1_Death_with_shadow.png',    cols:11, fps:8,  loop:false },
    }
  },
  vampire_warrior: {
    frameW: 64, frameH: 64,
    sheets: {
      idle:   { src:'images/Monster2/Vampire/Vampires2/With_shadow/Vampires2_Idle_with_shadow.png',     cols:4,  fps:8,  loop:true  },
      walk:   { src:'images/Monster2/Vampire/Vampires2/With_shadow/Vampires2_Run_with_shadow.png',      cols:8,  fps:12, loop:true  },
      attack: { src:'images/Monster2/Vampire/Vampires2/With_shadow/Vampires2_Attack_with_shadow.png',   cols:12, fps:14, loop:false },
      death:  { src:'images/Monster2/Vampire/Vampires2/With_shadow/Vampires2_Death_with_shadow.png',    cols:11, fps:8,  loop:false },
    }
  },
  beholder_guard: {
    frameW: 64, frameH: 64,
    sheets: {
      idle:   { src:'images/Monster2/Beholder/Beholder1/With_shadow/Beholder1_Idle_with_shadow.png',     cols:12, fps:8,  loop:true  },
      walk:   { src:'images/Monster2/Beholder/Beholder1/With_shadow/Beholder1_Run_with_shadow.png',      cols:8,  fps:12, loop:true  },
      attack: { src:'images/Monster2/Beholder/Beholder1/With_shadow/Beholder1_Attack_with_shadow.png',   cols:12, fps:14, loop:false },
      death:  { src:'images/Monster2/Beholder/Beholder1/With_shadow/Beholder1_Death_with_shadow.png',    cols:9,  fps:8,  loop:false },
    }
  },
  beholder_warrior: {
    frameW: 64, frameH: 64,
    sheets: {
      idle:   { src:'images/Monster2/Beholder/Beholder2/With_shadow/Beholder2_Idle_with_shadow.png',     cols:12, fps:8,  loop:true  },
      walk:   { src:'images/Monster2/Beholder/Beholder2/With_shadow/Beholder2_Run_with_shadow.png',      cols:8,  fps:12, loop:true  },
      attack: { src:'images/Monster2/Beholder/Beholder2/With_shadow/Beholder2_Attack_with_shadow.png',   cols:12, fps:14, loop:false },
      death:  { src:'images/Monster2/Beholder/Beholder2/With_shadow/Beholder2_Death_with_shadow.png',    cols:9,  fps:8,  loop:false },
    }
  },
  beholder_boss: {
    frameW: 64, frameH: 64,
    sheets: {
      idle:   { src:'images/Monster2/Beholder/Beholder3/With_shadow/Beholder3_Idle_with_shadow.png',     cols:12, fps:8,  loop:true  },
      walk:   { src:'images/Monster2/Beholder/Beholder3/With_shadow/Beholder3_Run_with_shadow.png',      cols:8,  fps:12, loop:true  },
      attack: { src:'images/Monster2/Beholder/Beholder3/With_shadow/Beholder3_Attack_with_shadow.png',   cols:12, fps:14, loop:false },
      death:  { src:'images/Monster2/Beholder/Beholder3/With_shadow/Beholder3_Death_with_shadow.png',    cols:9,  fps:8,  loop:false },
    }
  },
  // ── Arm 4 (levels 91-120) ────────────────────────────────────────────────
  ent_guard: {
    frameW: 128, frameH: 128,
    sheets: {
      idle:   { src:'images/Monster2/Ent/Ent1/With_shadow/Ent1_Idle_with_shadow.png',     cols:4, fps:6,  loop:true  },
      walk:   { src:'images/Monster2/Ent/Ent1/With_shadow/Ent1_Run_with_shadow.png',      cols:8, fps:10, loop:true  },
      attack: { src:'images/Monster2/Ent/Ent1/With_shadow/Ent1_Attack_with_shadow.png',   cols:7, fps:12, loop:false },
      death:  { src:'images/Monster2/Ent/Ent1/With_shadow/Ent1_Death_with_shadow.png',    cols:6, fps:7,  loop:false },
    }
  },
  ent_warrior: {
    frameW: 128, frameH: 128,
    sheets: {
      idle:   { src:'images/Monster2/Ent/Ent2/With_shadow/Ent2_Idle_with_shadow.png',     cols:4,  fps:6,  loop:true  },
      walk:   { src:'images/Monster2/Ent/Ent2/With_shadow/Ent2_Run_with_shadow.png',      cols:8,  fps:10, loop:true  },
      attack: { src:'images/Monster2/Ent/Ent2/With_shadow/Ent2_Attack_with_shadow.png',   cols:7,  fps:12, loop:false },
      death:  { src:'images/Monster2/Ent/Ent2/With_shadow/Ent2_Death_with_shadow.png',    cols:12, fps:7,  loop:false },
    }
  },
  demon_guard: {
    frameW: 128, frameH: 128,
    sheets: {
      idle:   { src:'images/Monster2/Demon/Demon1/With_shadow/Demon1_Idle_with_shadow.png',     cols:4,  fps:6,  loop:true  },
      walk:   { src:'images/Monster2/Demon/Demon1/With_shadow/Demon1_Run_with_shadow.png',      cols:8,  fps:10, loop:true  },
      attack: { src:'images/Monster2/Demon/Demon1/With_shadow/Demon1_Attack_with_shadow.png',   cols:10, fps:12, loop:false },
      death:  { src:'images/Monster2/Demon/Demon1/With_shadow/Demon1_Death_with_shadow.png',    cols:13, fps:7,  loop:false },
    }
  },
  demon_warrior: {
    frameW: 128, frameH: 128,
    sheets: {
      idle:   { src:'images/Monster2/Demon/Demon2/With_shadow/Demon2_Idle_with_shadow.png',     cols:4,  fps:6,  loop:true  },
      walk:   { src:'images/Monster2/Demon/Demon2/With_shadow/Demon2_Run_with_shadow.png',      cols:8,  fps:10, loop:true  },
      attack: { src:'images/Monster2/Demon/Demon2/With_shadow/Demon2_Attack_with_shadow.png',   cols:10, fps:12, loop:false },
      death:  { src:'images/Monster2/Demon/Demon2/With_shadow/Demon2_Death_with_shadow.png',    cols:13, fps:7,  loop:false },
    }
  },
  demon_boss: {
    frameW: 128, frameH: 128,
    sheets: {
      idle:   { src:'images/Monster2/Demon/Demon3/With_shadow/Demon3_Idle_with_shadow.png',     cols:4,  fps:6,  loop:true  },
      walk:   { src:'images/Monster2/Demon/Demon3/With_shadow/Demon3_Run_with_shadow.png',      cols:8,  fps:10, loop:true  },
      attack: { src:'images/Monster2/Demon/Demon3/With_shadow/Demon3_Attack_with_shadow.png',   cols:10, fps:12, loop:false },
      death:  { src:'images/Monster2/Demon/Demon3/With_shadow/Demon3_Death_with_shadow.png',    cols:13, fps:7,  loop:false },
    }
  },
  // Admin-summoned world-event boss (shared/definitions.js EVENT_BOSS) — same
  // Demon3 sheets as the arm boss above, just drawn far larger via its own
  // size. Needs its own entry because sprites are looked up by eid.
  demon_event_boss: {
    frameW: 128, frameH: 128,
    sheets: {
      idle:   { src:'images/Monster2/Demon/Demon3/With_shadow/Demon3_Idle_with_shadow.png',     cols:4,  fps:6,  loop:true  },
      walk:   { src:'images/Monster2/Demon/Demon3/With_shadow/Demon3_Run_with_shadow.png',      cols:8,  fps:10, loop:true  },
      attack: { src:'images/Monster2/Demon/Demon3/With_shadow/Demon3_Attack_with_shadow.png',   cols:10, fps:12, loop:false },
      death:  { src:'images/Monster2/Demon/Demon3/With_shadow/Demon3_Death_with_shadow.png',    cols:13, fps:7,  loop:false },
    }
  },
  // Guild War tower/castle (server/game/Room.js spawnGuildWarTower) — a
  // single static illustration, no facing/movement/attack of its own
  // (guildWar enemies are permanently stationary — see the stationary branch
  // in Room.js's tick loop). The loader/rasterizer above hard-require 4 facing
  // rows per sheet, so the one idle sheet is the same picture duplicated
  // into all 4 rows (cols:1) rather than a pipeline change — it never turns
  // to face anything, so every row draws identically anyway. No walk/attack
  // /death sheets: aggro and atkAnimTimer are permanently false/0 for this
  // enemy, so pixi-world.js's animation-key selector only ever resolves
  // 'idle'.
  guildwar_castle: {
    frameW: 70, frameH: 130,
    sheets: {
      idle: { src: 'images/enemy/guildwar_castle.png', cols: 1, fps: 1, loop: false },
    },
  },
  // 10-player corridor race boss (server/game/Room.js spawnRaceBoss) —
  // visually the world event boss, but its own eid so it doesn't show up in
  // the real world boss's HP-bar/alive tracking (js/ui.js
  // updateEventBossHpBar keys off eid === 'demon_event_boss').
  race10_boss: {
    frameW: 128, frameH: 128,
    sheets: {
      idle:   { src:'images/Monster2/Demon/Demon3/With_shadow/Demon3_Idle_with_shadow.png',     cols:4,  fps:6,  loop:true  },
      walk:   { src:'images/Monster2/Demon/Demon3/With_shadow/Demon3_Run_with_shadow.png',      cols:8,  fps:10, loop:true  },
      attack: { src:'images/Monster2/Demon/Demon3/With_shadow/Demon3_Attack_with_shadow.png',   cols:10, fps:12, loop:false },
      death:  { src:'images/Monster2/Demon/Demon3/With_shadow/Demon3_Death_with_shadow.png',    cols:13, fps:7,  loop:false },
    }
  },
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
          enemySpriteCache[eid][key] = _rasterizeSheet(img, { n: sh.cols * 4, cols: sh.cols }, def, def.frameH);
          tick();
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
      npcSpriteCache[id] = _rasterizeSheet(img, { n: def.cols, cols: def.cols }, def, def.frameH);
      resolveReady();
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
    if (j) j();
    if (_rasterQueue.length) requestAnimationFrame(pump);
    else _rasterPumping = false;
  };
  requestAnimationFrame(pump);
}

function _rasterizeSheet(img, ad, def, cellH) {
  const targetH = cellH || _SPRITE_CELL_H;
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
      cache['front-idle'] = _rasterizeSheet(img, def.anims['front-idle'], def);
      onDone();
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
  const keys = Object.keys(def.anims);
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
        cache[key] = _rasterizeSheet(img, def.anims[key], def); tick();
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
  _spriteLoadPromises[charType].then(onDone);
}

function getSpriteAnimKey(p) {
  if (state === 'dead') return 'die';
  const dir = p.facing || 'front';
  if (p.atkAnimTimer > 0)  return `${dir}-attack`;
  const inp = inputDir();
  if (inp.len > 0.05 || p._chasing) return `${dir}-run`;
  return `${dir}-idle`;
}

