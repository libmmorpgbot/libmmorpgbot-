// ── pixi-world.js — PixiJS WebGL world renderer ────────────────────────────
// Replaces Canvas 2D world drawing; HUD stays on _uiOverlay (2D canvas).

const _isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

let _pixiApp = null;
let _worldCt  = null;   // Container — camera transform applied here
let _tileCt   = null;
let _lightsGfx = null;  // torch flames + warm glow (Graphics, additive blend, cleared each frame)
let _aoeGfx   = null;   // AOE rings (Graphics, cleared each frame)
let _npcCt    = null;   // NPC bodies (Container — pooled per-npc sprite+gfx)
let _npcNames = [];      // PIXI.Text per NPC
let _dropGfx  = null;
let _partGfx  = null;   // particles (Graphics, cleared each frame)
let _enemyCt  = null;
let _otherPCt = null;
let _projGfx  = null;
let _playerCt = null;
let _plAura = null;
let _dmgNumCt = null;
let _petCt = null; // holds every player's pet follower (see _updatePets)

// Entity sprite pools
const _enemyPool  = new Map(); // id  → {ct, spr, gfx}
const _otherPool  = new Map(); // sid → {ct, spr, gfx}
const _npcPool    = new Map(); // npc.id → {ct, spr, gfx}

// Player rendering objects
let _plSpr = null, _plGfx = null;

// petId whose sheets loadPetSprites() has been asked to fetch for the LOCAL
// player. Other players' pets are fetched as their ids arrive (js/network.js).
let _petLoadedFor = null;

// Damage-number pool
const _dmgActive = [];
const _dmgPool   = [];

// Chunk sprite cache — separate from _tileChunks canvas cache (js/game.js).
// That one is capped at _CHUNK_MAX (96) with a comment sizing its worst-case
// CPU-side memory; this one held the GPU-uploaded PIXI.Texture for every
// distinct chunk ever built and was never capped at all. Per _updateTiles'
// own profiling comment below, the texture upload (PIXI.Texture.from, ~5ms
// avg, spikes over 30ms) is the EXPENSIVE half of building a chunk — the
// canvas draw that got the cap is the cheap ~0.6ms half. The only thing that
// ever cleared this was pixiInvalidateChunks(), and that only runs from
// buildTileCanvas() on a fresh gameStart (login/reconnect) — leftover
// plumbing from the old multi-floor game, where every floor change fired it.
// This world is one permanent floor now (MAX_FLOOR=1, server/index.js), so a
// long session that never reconnects never calls it again: every chunk a
// player ever walked past — up to ~8000 across the full map — stayed
// uploaded to the GPU for the rest of the session. That's an unbounded VRAM
// leak, worst on the mobile WebView this actually runs in, and reads exactly
// like the "игра фризит после долгой сессии" reports. Capped the same way
// _tileChunks is, oldest evicted first — see the eviction pass at the end of
// _updateTiles, which skips anything on screen this frame so eviction can
// never pop a visible chunk.
const _CHUNK_SPR_MAX = 96;
const _chunkSprCache = new Map(); // "cx,cy" → PIXI.Sprite

// Texture caches
const _pTex = {};          // charType|animKey → PIXI.Texture[]
const _eTex = {};          // eid|sheetKey     → {down,up,left,right}: PIXI.Texture[]
const _npcTex = {};        // npc icon id      → PIXI.Texture[]
const _petTex = {};        // petId|animKey    → PIXI.Texture[]

let _lastBgColor = null; // dirty flag — bg color only changes on floor switch

// ── init ──────────────────────────────────────────────────
// When the world last drew a frame, and whether there is a renderer at all.
// The watchdog in js/game.js reads both: a blank world with a working HUD is
// exactly what these two tell apart from a working one.
let _pixiLastRender = 0;
let _ctxLost = false;
function pixiAlive() { return !!_pixiApp && !_ctxLost; }
function pixiLastRenderTs() { return _pixiLastRender; }

// Everything holding a GPU object. After a lost context or a failed renderer
// these all point at resources that no longer exist, and calling destroy() on
// them throws — the old context is gone, there is nothing left to free. So
// they are DROPPED, not destroyed, and rebuilt on demand like they were on a
// cold start.
function _dropGpuState() {
  _enemyPool.clear();
  _otherPool.clear();
  _npcPool.clear();
  _petPool.clear();
  _chunkSprCache.clear();
  for (const cache of [_pTex, _eTex, _npcTex, _petTex]) {
    Object.keys(cache).forEach(k => delete cache[k]);
  }
  _npcNames.length = 0;
  _dmgActive.length = 0;
  _dmgPool.length = 0;
  _plSpr = null; _plGfx = null; _plAura = null;
  _petLoadedFor = null;
  _lastBgColor = null;
}

// Build a renderer again on the same canvas element. Returns true if there is
// a working world afterwards.
//
// Why this exists: WebGL context creation fails for reasons that have nothing
// to do with this code and everything to do with the device — the browser caps
// how many live contexts a page may hold, the GPU process restarts under
// memory pressure, and a WebView that has been backgrounded can come back with
// its context gone. Each of those is TRANSIENT, and each of them used to leave
// the game permanently blank behind a perfectly working HUD, because pixiInit
// threw once at startup, was logged to a console nobody reads, and was never
// tried again.
// Whether this device can do WebGL at all, asked on a THROWAWAY canvas so the
// answer is about the device rather than about one element's state. An iPhone
// with WebGL disabled answers no here and will answer no in five seconds too:
// retrying is pointless, and five retries with a stack trace each is five
// alerts about a phone that is never going to work.
function pixiWebglSupported() {
  try {
    const probe = document.createElement('canvas');
    return !!(probe.getContext('webgl2') || probe.getContext('webgl')
      || probe.getContext('experimental-webgl'));
  } catch (e) {
    return false;
  }
}

// Rebuild the world renderer. Returns the canvas element it is now drawing on,
// or null if it could not.
//
// ON A FRESH ELEMENT, ALWAYS. This is the part that took two attempts to get
// right, and the reason is in PixiJS: ContextSystem.destroy() ends with
//
//   gl.getExtension('WEBGL_lose_context')?.loseContext()
//
// So destroying the old renderer TAKES THE CONTEXT AWAY — which, when you are
// destroying it because the context was just restored, means you have thrown
// away the thing you were recovering. Nothing asks the browser for it a second
// time, so every retry after that found it lost and the world stayed blank
// through all five of them. That is what the live test showed: `isContextLost()`
// still true long after `restoreContext()` had been called and had worked.
//
// Not destroying is not an option either: the old renderer keeps its own
// webglcontextlost/restored listeners on the element and would re-initialise
// itself on top of the new one.
//
// A canvas element gets exactly one context in its lifetime and can never be
// handed a different one. So the element is replaced. cloneNode(false) carries
// the id, class and styling across and brings none of the listeners, none of
// the history, and no context at all — which is precisely what is wanted.
function pixiRecover(oldCanvas) {
  const alive = _pixiApp && !_ctxLost;
  const app = _pixiApp;
  _pixiApp = null;
  // Only worth destroying while the context still works — that is the case
  // where it frees something. After a loss there is nothing left to free.
  if (app && alive) {
    try { app.destroy(false, { children: false }); } catch (e) { /* already gone */ }
  }
  _dropGpuState();

  if (!oldCanvas || !oldCanvas.parentNode) return null;
  if (!pixiWebglSupported()) return null;

  const fresh = oldCanvas.cloneNode(false);
  oldCanvas.parentNode.replaceChild(fresh, oldCanvas);

  _ctxLost = false;
  try {
    pixiInit(fresh);
    return fresh;
  } catch (err) {
    _pixiApp = null;
    _ctxLost = true;
    if (typeof window.__reportClientError === 'function') {
      window.__reportClientError('pixi-recover', err && err.message, err && err.stack);
    }
    return null;
  }
}

// Why WebGL refused, in words that identify the device rather than the line of
// code. "Cannot read properties of null" says nothing; "no webgl2, no webgl,
// Adreno 610" says which phones are affected.
function pixiWebglDiagnosis(canvasEl) {
  const out = [];
  try {
    const probe = document.createElement('canvas');
    const gl2 = probe.getContext('webgl2');
    const gl1 = gl2 || probe.getContext('webgl') || probe.getContext('experimental-webgl');
    out.push(gl2 ? 'webgl2 ok' : 'no webgl2');
    out.push(gl1 ? 'webgl1 ok' : 'no webgl1');
    if (gl1) {
      const info = gl1.getExtension('WEBGL_debug_renderer_info');
      if (info) out.push(String(gl1.getParameter(info.UNMASKED_RENDERER_WEBGL)).slice(0, 80));
      if (gl1.isContextLost && gl1.isContextLost()) out.push('probe context already lost');
    }
    if (canvasEl) out.push(`canvas ${canvasEl.clientWidth}x${canvasEl.clientHeight}`);
  } catch (err) {
    out.push('probe threw: ' + (err && err.message));
  }
  return out.join(' · ');
}

function pixiInit(canvasEl) {
  _pixiApp = new PIXI.Application({
    view: canvasEl,
    width:  canvasEl.clientWidth  || 375,
    height: canvasEl.clientHeight || 667,
    resolution: Math.min(window.devicePixelRatio || 1, _isMobile ? 1.0 : 1.5),
    autoDensity: true,
    backgroundAlpha: 1,
    antialias: false,
    powerPreference: _isMobile ? 'default' : 'high-performance',
  });
  _pixiApp.stop(); // manual render call

  _worldCt  = new PIXI.Container();
  _tileCt   = new PIXI.Container();
  _lightsGfx = new PIXI.Graphics();
  _lightsGfx.blendMode = PIXI.BLEND_MODES.ADD;
  _aoeGfx   = new PIXI.Graphics();
  _npcCt    = new PIXI.Container();
  _dropGfx  = new PIXI.Graphics();
  _partGfx  = new PIXI.Graphics();
  _enemyCt  = new PIXI.Container();
  _otherPCt = new PIXI.Container();
  _projGfx  = new PIXI.Graphics();
  _playerCt = new PIXI.Container();
  _petCt    = new PIXI.Container();
  _dmgNumCt = new PIXI.Container();

  _worldCt.addChild(
    _tileCt, _lightsGfx, _aoeGfx,
    _npcCt, _dropGfx, _partGfx,
    _enemyCt, _otherPCt, _projGfx,
    _petCt, _playerCt, _dmgNumCt
  );
  _worldCt.scale.set(ZOOM); // constant — set once, never changed in the render loop
  _pixiApp.stage.addChild(_worldCt);

  // ── losing the context, and getting it back ──────────────────────────────
  // A WebView takes the GPU context away when it is backgrounded, when memory
  // is short, or when the GPU process restarts. Without a listener the page
  // just stops drawing: the HUD is a separate 2D canvas and keeps working, so
  // what a player sees is a grey rectangle with a perfectly normal interface
  // on top of it — "просто сірий екран замість візуалу гри".
  //
  // preventDefault() on the lost event is not optional. It is what tells the
  // browser this page intends to recover; without it `webglcontextrestored`
  // is NEVER fired, and the grey screen is permanent by specification.
  if (!canvasEl.__pixiCtxHooked) {
    canvasEl.__pixiCtxHooked = true;
    canvasEl.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      _ctxLost = true;
      // Not reported. Losing the context is ROUTINE — a WebView hands it back
      // to the system every time the player switches apps — and it is
      // self-healing, so an alert for each one is a stream of messages about
      // something that fixed itself. What is worth waking someone for is a
      // loss that does NOT come back, and that is what the retry path and
      // 'pixi-dead' report.
      console.warn('[pixi] контекст WebGL потерян — восстанавливаем');
    });
    canvasEl.addEventListener('webglcontextrestored', () => {
      // Rebuilt from scratch rather than resumed: every texture and buffer
      // uploaded to the old context is gone, and the pools still hold handles
      // to them.
      //
      // Through the one entry point in game.js, which owns what has to happen
      // AROUND the renderer: the `canvas` global points at the old element,
      // the input listeners are attached to it, and the tile cache belongs to
      // the renderer that just died. Rebuilding the renderer alone would give
      // back a world nobody could move around in.
      if (typeof _pixiRebuild === 'function') _pixiRebuild();
    });
  }
}

function pixiClearEntityPools() {
  _enemyPool.forEach(obj => obj.ct.destroy({ children: true }));
  _enemyPool.clear();
  _otherPool.forEach(obj => obj.ct.destroy({ children: true }));
  _otherPool.clear();
  _petPool.forEach(obj => obj.ct.destroy({ children: true }));
  _petPool.clear();
  Object.keys(_petTex).forEach(k => delete _petTex[k]);
  // Invalidate player texture cache so new char type picks up fresh textures
  Object.keys(_pTex).forEach(k => delete _pTex[k]);
  // NPCs used to never change at runtime (one permanent floor), so this pool
  // was never cleared — harmless then, but now that each location is its own
  // floor with its own NPC set (see initNpcs, js/game.js) an arm floor has
  // NONE, and _updateNpcs' own trim loop only runs while npcs.length > 0
  // (pixi-world.js), so it can never clean up the hub's stale sprites/name
  // labels on its own. Clear both here, the one choke point every floor
  // change already runs through (buildTileCanvas -> pixiInvalidateChunks).
  _npcPool.forEach(obj => obj.ct.destroy({ children: true }));
  _npcPool.clear();
  Object.keys(_npcTex).forEach(k => delete _npcTex[k]);
  _npcNames.forEach(t => { _worldCt.removeChild(t); t.destroy(); });
  _npcNames.length = 0;
}

// Enemies/other-players are only bulk-freed on floor/raid change (above). Within
// a single floor visit, mobs die and respawn with new ids and other players
// enter/leave your AOI continuously — without this, their pooled Container is
// never destroyed, so _enemyPool/_otherPool grow for as long as the floor visit
// lasts and the per-frame visibility sweep (_updateEnemies/_updateOtherPlayers)
// keeps iterating that ever-growing history instead of just what's on screen.
// The growth tracks play time and exploration, so it reads as "gets janky the
// longer/more I move around" rather than a fixed cost.
function pixiRemoveEnemy(id) {
  const obj = _enemyPool.get(id);
  if (!obj) return;
  obj.ct.destroy({ children: true });
  _enemyPool.delete(id);
}
function pixiRemoveOtherPlayer(sid) {
  const obj = _otherPool.get(sid);
  if (!obj) return;
  obj.ct.destroy({ children: true });
  _otherPool.delete(sid);
  pixiRemovePet(sid);
}

function pixiResize(w, h, dpr) {
  if (!_pixiApp) return;
  _pixiApp.renderer.resolution = dpr;
  _pixiApp.renderer.resize(w, h);
}

function pixiSetBg(cssHex) {
  if (!_pixiApp) return;
  _pixiApp.renderer.background.color = parseInt(cssHex.replace('#', ''), 16);
}

function pixiClearWorld() {
  if (_worldCt) _worldCt.visible = false;
  if (_pixiApp) _pixiApp.renderer.render(_pixiApp.stage);
}

// Called from buildTileCanvas() on floor change
function pixiInvalidateChunks() {
  _chunkSprCache.forEach(spr => {
    _tileCt.removeChild(spr);
    spr.destroy({ texture: true, baseTexture: true });
  });
  _chunkSprCache.clear();
  pixiClearEntityPools();
}

// ── texture helpers ───────────────────────────────────────

function _playerTextures(charType, animKey) {
  const k = charType + '|' + animKey;
  if (_pTex[k]) return _pTex[k];
  const def   = SPRITE_DEF[charType];
  const cache = spriteCache[charType];
  if (!def || !cache) return null;
  const img = cache[animKey];
  if (!img || img.naturalWidth !== undefined) return null; // not yet rasterized
  const ad = def.anims[animKey];
  const fw = img.frameW, fh = img.frameH;
  const bt = PIXI.BaseTexture.from(img);
  bt.scaleMode = PIXI.SCALE_MODES.LINEAR;
  const arr = [];
  for (let i = 0; i < ad.n; i++) {
    const col = i % ad.cols, row = Math.floor(i / ad.cols);
    arr.push(new PIXI.Texture(bt, new PIXI.Rectangle(col * fw, row * fh, fw, fh)));
  }
  return (_pTex[k] = arr);
}

function _petTextures(petId, animKey) {
  const k = petId + '|' + animKey;
  if (_petTex[k]) return _petTex[k];
  const def   = PET_SPRITE_DEF[petId];
  const cache = petSpriteCache[petId];
  if (!def || !cache) return null;
  const img = cache[animKey];
  if (!img || img.naturalWidth !== undefined) return null; // not yet rasterized
  const ad = def.anims[animKey];
  const fw = img.frameW, fh = img.frameH;
  const bt = PIXI.BaseTexture.from(img);
  bt.scaleMode = PIXI.SCALE_MODES.LINEAR;
  const arr = [];
  for (let i = 0; i < ad.n; i++) {
    const col = i % ad.cols, row = Math.floor(i / ad.cols);
    arr.push(new PIXI.Texture(bt, new PIXI.Rectangle(col * fw, row * fh, fw, fh)));
  }
  return (_petTex[k] = arr);
}

// img is only ever a raw <img> while its network load/decode is still in
// flight (enemySpriteCache[eid][sheetKey] flips to a rasterized <canvas>
// once ready, see loadEnemySprites/js/sprites.js) — naturalWidth is
// undefined on a canvas but a number on an <img>, same check _playerTextures
// uses. Building a texture straight off the raw Image (as this used to)
// skipped that rasterize step entirely, so PIXI.BaseTexture.from() paid a
// real GPU upload (~5ms avg, spiking 30-40ms — see profiling notes) off a
// full-size sheet the very first time a new species/animation was seen.
function _enemyTextures(eid, sheetKey) {
  const k = eid + '|' + sheetKey;
  if (_eTex[k]) return _eTex[k];
  const def   = ENEMY_SPRITE_DEF[eid];
  const cache = enemySpriteCache[eid];
  if (!def || !cache) return null;
  const img = cache[sheetKey];
  if (!img || img.naturalWidth !== undefined) return null; // not yet rasterized
  const sh = def.sheets[sheetKey];
  const fw = img.frameW, fh = img.frameH; // rasterized cell size, not the source sheet's
  const bt = PIXI.BaseTexture.from(img);
  bt.scaleMode = PIXI.SCALE_MODES.LINEAR;
  const rows = {};
  for (const [facing, ri] of Object.entries(ENEMY_FACING_ROW)) {
    rows[facing] = [];
    for (let c = 0; c < sh.cols; c++)
      rows[facing].push(new PIXI.Texture(bt, new PIXI.Rectangle(c * fw, ri * fh, fw, fh)));
  }
  return (_eTex[k] = rows);
}

function _npcTextures(id) {
  if (_npcTex[id]) return _npcTex[id];
  const def = NPC_SPRITE_DEF[id];
  const img = npcSpriteCache[id];
  if (!def || !img || img.naturalWidth !== undefined) return null; // not yet rasterized
  const fw = img.frameW, fh = img.frameH;
  const bt = PIXI.BaseTexture.from(img);
  bt.scaleMode = PIXI.SCALE_MODES.LINEAR;
  const arr = [];
  for (let c = 0; c < def.cols; c++)
    arr.push(new PIXI.Texture(bt, new PIXI.Rectangle(c * fw, 0, fw, fh)));
  return (_npcTex[id] = arr);
}

// ── tiles ─────────────────────────────────────────────────

// Visibility is tracked with a generation stamp on each sprite rather than a
// fresh Set every frame — avoids one GC-pressuring allocation per render on
// mobile, where collection pauses show up as visible hitches.
let _tileVisGen = 0;
// Building a chunk (_buildChunk: 5-6 full passes over its tiles — wall fill,
// floor, cliff caps, two shadow passes, props) plus the GPU texture upload
// from PIXI.Texture.from() is real synchronous work per chunk. Revealing a
// whole viewport of never-seen chunks at once — floor entry, a dash, a
// teleport — used to build all of them (up to ~12 on a typical viewport) in
// a single frame: a real, reproducible hitch every time it happened. Capping
// how many NEW chunks build per frame spreads that burst across a handful of
// frames instead — a brief progressive pop-in rather than one big freeze.
// Already-built chunks are unaffected, this only throttles first-time builds.
const _CHUNK_BUILD_BUDGET = 2;
// Profiling (see PR discussion) found _buildChunk's own canvas drawing is
// cheap (~0.6ms avg) but PIXI.Texture.from()'s GPU upload is not (~5ms avg,
// spikes over 30ms) — and until now a chunk's build+upload only ever started
// the exact frame the camera reached it, i.e. zero lead time while running.
// _CHUNK_LOOKAHEAD extends the range of chunks considered for building (NOT
// the range marked visible, see the cx/cy bounds check below) by this many
// whole chunk-widths in whichever direction the player is currently moving.
// Because c0x/c1x are chunk INDICES (not the viewport edge's exact world
// position), a lookahead of only 1 chunk index can, depending on where the
// viewport edge sits inside its current chunk, buy anywhere from almost a
// full chunk-width of lead down to almost none — so this is 2, guaranteeing
// at least one full chunk-width (~320 world px, ~2s at normal move speed) of
// lead in the worst-case alignment. That's comfortably inside
// _CHUNK_BUILD_BUDGET's 2-per-frame throttle, so the expensive GPU texture
// upload has already happened well before the chunk actually scrolls into
// view instead of landing in the same frame the player needed it rendered.
const _CHUNK_LOOKAHEAD = 2;
function _updateTiles(camX, camY) {
  if (!dungeon || !dungeon.grid) return;
  const maxCx = Math.ceil(dungeon.w * TILE / _CHUNK_PX) - 1;
  const maxCy = Math.ceil(dungeon.h * TILE / _CHUNK_PX) - 1;
  const c0x = Math.max(0, Math.floor(camX / _CHUNK_PX));
  const c0y = Math.max(0, Math.floor(camY / _CHUNK_PX));
  const c1x = Math.min(maxCx, Math.floor((camX + W / ZOOM) / _CHUNK_PX));
  const c1y = Math.min(maxCy, Math.floor((camY + (H - HEADER_H) / ZOOM) / _CHUNK_PX));

  const dir = (typeof inputDir === 'function') ? inputDir() : null;
  const bx0 = (dir && dir.dx < -0.15) ? Math.max(0, c0x - _CHUNK_LOOKAHEAD) : c0x;
  const bx1 = (dir && dir.dx >  0.15) ? Math.min(maxCx, c1x + _CHUNK_LOOKAHEAD) : c1x;
  const by0 = (dir && dir.dy < -0.15) ? Math.max(0, c0y - _CHUNK_LOOKAHEAD) : c0y;
  const by1 = (dir && dir.dy >  0.15) ? Math.min(maxCy, c1y + _CHUNK_LOOKAHEAD) : c1y;

  const gen = ++_tileVisGen;
  let _built = 0;
  _visibleTorches.length = 0;
  for (let cy = by0; cy <= by1; cy++) {
    for (let cx = bx0; cx <= bx1; cx++) {
      const key = cx + ',' + cy;
      let spr = _chunkSprCache.get(key);
      if (!spr) {
        if (_built >= _CHUNK_BUILD_BUDGET) continue; // picked up next frame(s)
        _built++;
        let cv = _tileChunks.get(key);
        if (!cv) {
          cv = _buildChunk(cx, cy);
          if (_tileChunks.size >= _CHUNK_MAX) _tileChunks.delete(_tileChunks.keys().next().value);
          _tileChunks.set(key, cv);
        }
        const tex = PIXI.Texture.from(cv);
        spr = new PIXI.Sprite(tex);
        spr.x = cx * _CHUNK_PX - _CHUNK_G;
        spr.y = cy * _CHUNK_PX - _CHUNK_G;
        _tileCt.addChild(spr);
        _chunkSprCache.set(key, spr);
      }
      // Only chunks truly inside the viewport get marked visible this frame —
      // lookahead chunks outside c0x/c1x/c0y/c1y stay built (upload cost
      // already paid) but hidden until the camera actually reaches them.
      if (cx >= c0x && cx <= c1x && cy >= c0y && cy <= c1y) {
        spr._visGen = gen;
        const torches = _chunkTorches.get(key);
        if (torches) for (let i = 0; i < torches.length; i++) _visibleTorches.push(torches[i]);
      }
    }
  }
  _chunkSprCache.forEach(spr => { spr.visible = spr._visGen === gen; });
  // Evict oldest-first (Map insertion order, same rule _tileChunks uses)
  // once over the cap, skipping anything visible this frame — see
  // _CHUNK_SPR_MAX above. destroy({texture, baseTexture}) is what actually
  // frees the GPU upload; removing the child alone would not.
  if (_chunkSprCache.size > _CHUNK_SPR_MAX) {
    for (const [k, spr] of _chunkSprCache) {
      if (_chunkSprCache.size <= _CHUNK_SPR_MAX) break;
      if (spr.visible) continue;
      _tileCt.removeChild(spr);
      spr.destroy({ texture: true, baseTexture: true });
      _chunkSprCache.delete(k);
    }
  }
}

// ── torch light + ambient dust ───────────────────────────────
// Torches: the iron bracket is baked flat into the chunk texture (see
// _buildChunk); only the flame flicker + its warm glow pooling onto the
// floor are live, driven off the anchor points _updateTiles collected for
// whichever chunks are actually on screen this frame.
const _visibleTorches = [];

function _updateLights(ts) {
  _lightsGfx.clear();
  // Devices the adaptive tier already flagged as struggling (sustained
  // <20fps, see _drawPerf in game.js) skip the big soft falloff circle —
  // it's the widest fill here and large translucent circles are exactly
  // what tends to be fill-rate-bound on low-end mobile GPUs — and drop the
  // dimmest of the two glow rings entirely, keeping just the flame + one
  // tight glow so torches still read as lit without the extra overdraw.
  const lite = (typeof _qualityTier !== 'undefined' && _qualityTier > 0);
  for (let i = 0; i < _visibleTorches.length; i++) {
    const t = _visibleTorches[i];
    const flick = 0.8 + 0.15 * Math.sin(ts * 0.006 + t.x * 0.11) + 0.08 * Math.sin(ts * 0.023 + t.y * 0.05);
    const fx = t.x + Math.sin(ts * 0.014 + t.x) * 1.2;
    const fy = t.y - 2 + Math.sin(ts * 0.02 + t.y) * 1;
    if (!lite) {
      _lightsGfx.beginFill(0xff9d3c, 0.05 * flick); _lightsGfx.drawCircle(t.x, t.y + 10, 60 * flick); _lightsGfx.endFill();
    }
    _lightsGfx.beginFill(0xffb85c, 0.09 * flick); _lightsGfx.drawCircle(t.x, t.y + 10, 32 * flick); _lightsGfx.endFill();
    _lightsGfx.beginFill(0xff8a2e, 0.75); _lightsGfx.drawCircle(fx, fy + 2, 5 * flick); _lightsGfx.endFill();
    _lightsGfx.beginFill(0xffe6a8, 0.9); _lightsGfx.drawCircle(fx, fy, 3.2 * flick); _lightsGfx.endFill();
  }
}

// ── AOE rings ─────────────────────────────────────────────
// Six named styles (spawnAOE's `style` param, js/particles.js) drawn here,
// picked per skill at its call site (js/player.js/game.js) — see each
// draw function's own comment for which cast it's tuned for. `p` is 0..1
// progress through the ring's life (0 = just cast, 1 = about to despawn);
// every style derives its own fade/expand curve from it, matching the
// preview build the visual direction was picked from.
function _easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
function _easeOutQuad(t) { return 1 - (1 - t) * (1 - t); }
function _hexToNum(s, fallback) {
  const n = parseInt((s || '').replace('#', ''), 16);
  return Number.isFinite(n) ? n : (fallback != null ? fallback : 0xffffff);
}

// Original plain ring, unchanged — default when no style is passed at all.
function _drawAoeClassic(g, x, y, R, p, color) {
  const a = 1 - p;
  g.beginFill(color, a * 0.20);
  g.drawCircle(x, y, R);
  g.endFill();
  g.lineStyle(2 / ZOOM, color, a * 0.85);
  g.drawCircle(x, y, R);
  g.lineStyle(0);
}

// General-purpose expanding ring with a thin trailing echo — Lev's Вихрь
// клинка/Вихрь.
function _drawAoeShockwave(g, x, y, R, p, color) {
  const r = R * _easeOutCubic(p);
  const a = 1 - p;
  g.beginFill(color, a * 0.16);
  g.drawCircle(x, y, r);
  g.endFill();
  g.lineStyle(Math.max(1.5, 3 * (1 - p * 0.5)) / ZOOM, color, a);
  g.drawCircle(x, y, r);
  g.lineStyle(1 / ZOOM, color, a * 0.5);
  g.drawCircle(x, y, Math.max(0, r - 8));
  g.lineStyle(0);
}

// Two staggered rings, reads as a volley rippling outward — Ranger's Град
// стрел.
function _drawAoePulse(g, x, y, R, p, color) {
  const ring = (delay, widthMul, alphaMul) => {
    const pp = Math.min(1, Math.max(0, (p - delay) / (1 - delay)));
    if (pp <= 0) return;
    const r = R * _easeOutQuad(pp);
    const a = (1 - pp) * alphaMul;
    g.lineStyle(2.4 * widthMul / ZOOM, color, a);
    g.drawCircle(x, y, r);
  };
  ring(0, 1.2, 1);
  ring(0.16, 0.7, 0.65);
  g.lineStyle(0);
}

// Bright core bloom (approximated with stacked falling-alpha circles, same
// trick the torch glow above uses — PIXI.Graphics has no radial-gradient
// fill) plus an expanding ring — Mage's Вспышка.
function _drawAoeFlash(g, x, y, R, p, color) {
  const bp = Math.min(1, p / 0.3);
  if (bp < 1) {
    const ba = 1 - bp;
    g.beginFill(0xffffff, ba * 0.55); g.drawCircle(x, y, R * 0.16); g.endFill();
    g.beginFill(0xffffff, ba * 0.30); g.drawCircle(x, y, R * 0.28); g.endFill();
    g.beginFill(color,    ba * 0.35); g.drawCircle(x, y, R * 0.42); g.endFill();
    g.beginFill(color,    ba * 0.16); g.drawCircle(x, y, R * 0.55); g.endFill();
  }
  const r = R * _easeOutCubic(p);
  const a = 1 - p;
  g.lineStyle(2.5 / ZOOM, color, a);
  g.drawCircle(x, y, r);
  g.lineStyle(0);
}

// Ring plus small crystal shards flung outward along its edge — Mage's
// Ледяная нова/Разряд.
function _drawAoeFrost(g, x, y, R, p, color, rand) {
  const r = R * _easeOutCubic(p);
  const a = 1 - p;
  g.lineStyle(2 / ZOOM, color, a);
  g.drawCircle(x, y, r);
  g.beginFill(color, a * 0.12);
  g.drawCircle(x, y, r);
  g.endFill();
  g.lineStyle(0);
  const n = 10;
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2 + rand[i] * 0.4;
    const dist = r * (0.55 + rand[i + n] * 0.5);
    const sx = x + Math.cos(ang) * dist, sy = y + Math.sin(ang) * dist;
    const len = 10 * (1 - p * 0.4);
    const dx = Math.cos(ang), dy = Math.sin(ang), px = -dy, py = dx;
    const tipx = sx + dx * len, tipy = sy + dy * len;
    const b1x = sx - dx * len * 0.35 + px * len * 0.28, b1y = sy - dy * len * 0.35 + py * len * 0.28;
    const b2x = sx - dx * len * 0.35 - px * len * 0.28, b2y = sy - dy * len * 0.35 - py * len * 0.28;
    g.beginFill(0xeaf6ff, a);
    g.moveTo(tipx, tipy); g.lineTo(b1x, b1y); g.lineTo(b2x, b2y); g.closePath();
    g.endFill();
  }
}

// Jagged cracks racing outward from the impact point over a pulsing dark
// glow — Deathknight's Вихрь клинка/Безумие splash.
function _drawAoeFissure(g, x, y, R, p, color, color2, rand) {
  const pulseA = Math.sin(p * Math.PI) * 0.35;
  g.beginFill(color2, pulseA * 0.20); g.drawCircle(x, y, R); g.endFill();
  g.beginFill(color2, pulseA * 0.30); g.drawCircle(x, y, R * 0.7); g.endFill();
  g.beginFill(color,  pulseA * 0.30); g.drawCircle(x, y, R * 0.4); g.endFill();

  const appear = Math.min(1, p / 0.25);
  const fade = p < 0.6 ? 1 : 1 - (p - 0.6) / 0.4;
  const crackA = Math.max(0, Math.min(appear, fade));
  const n = 8, segs = 5;
  g.lineStyle(2.2 * (1 - p * 0.3) / ZOOM, color, crackA);
  for (let i = 0; i < n; i++) {
    const baseAng = (i / n) * Math.PI * 2 + rand[i] * 0.5;
    let cx = x, cy = y;
    g.moveTo(cx, cy);
    for (let s = 1; s <= segs; s++) {
      const t = s / segs;
      const rr = R * _easeOutCubic(Math.min(1, p * 1.4)) * t;
      const jitter = (rand[i * segs + s] - 0.5) * R * 0.22 * (1 - t * 0.5);
      const ang = baseAng + jitter / Math.max(rr, 1);
      cx = x + Math.cos(ang) * rr;
      cy = y + Math.sin(ang) * rr;
      g.lineTo(cx, cy);
    }
  }
  g.lineStyle(1.5 / ZOOM, color2, (1 - p) * 0.7);
  g.drawCircle(x, y, R * _easeOutCubic(p));
  g.lineStyle(0);
}

// Thick ring with a turbulent, serrated edge instead of a clean circle —
// Deathknight's own "blade storm" flavor, kept in reserve alongside fissure.
function _drawAoeBloodwave(g, x, y, R, p, color, color2) {
  const r = R * _easeOutCubic(p);
  const a = 1 - p;
  const steps = 40;
  g.lineStyle(3.2 / ZOOM, color2, a);
  g.beginFill(color, a * 0.18);
  for (let i = 0; i <= steps; i++) {
    const ang = (i / steps) * Math.PI * 2;
    const wobble = Math.sin(ang * 7 + p * 10) * 4 + Math.sin(ang * 3 - p * 6) * 6;
    const rr = r + wobble * (1 - p * 0.4);
    const px = x + Math.cos(ang) * rr, py = y + Math.sin(ang) * rr;
    if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
  }
  g.closePath();
  g.endFill();
  g.lineStyle(0);
}

function _updateAoeRings() {
  _aoeGfx.clear();
  aoeRings.forEach(ring => {
    const p = 1 - ring.life / ring.maxLife;
    const color = _hexToNum(ring.color, 0x44aaff);
    switch (ring.style) {
      case 'shockwave': _drawAoeShockwave(_aoeGfx, ring.x, ring.y, ring.r, p, color); break;
      case 'pulse':     _drawAoePulse(_aoeGfx, ring.x, ring.y, ring.r, p, color); break;
      case 'flash':     _drawAoeFlash(_aoeGfx, ring.x, ring.y, ring.r, p, color); break;
      case 'frost':     _drawAoeFrost(_aoeGfx, ring.x, ring.y, ring.r, p, color, ring.rand); break;
      case 'fissure':   _drawAoeFissure(_aoeGfx, ring.x, ring.y, ring.r, p, color, _hexToNum(ring.color2, color), ring.rand); break;
      case 'bloodwave': _drawAoeBloodwave(_aoeGfx, ring.x, ring.y, ring.r, p, color, _hexToNum(ring.color2, color)); break;
      default:          _drawAoeClassic(_aoeGfx, ring.x, ring.y, ring.r, p, color);
    }
  });
}

// ── NPCs ──────────────────────────────────────────────────

const _NPC_DISPLAY_H = 74; // world px — square frames, so width == height

function _getNpcObj(id) {
  if (_npcPool.has(id)) return _npcPool.get(id);
  const ct  = new PIXI.Container();
  const gfx = new PIXI.Graphics();
  const spr = new PIXI.Sprite(PIXI.Texture.WHITE);
  spr.visible = false;
  ct.addChild(gfx, spr);
  _npcCt.addChild(ct);
  const obj = { ct, gfx, spr };
  _npcPool.set(id, obj);
  return obj;
}

function _updateNpcs(dt, ts) {
  if (!npcs || !npcs.length) return;
  // Sync name text objects count
  while (_npcNames.length > npcs.length) {
    const t = _npcNames.pop();
    _worldCt.removeChild(t); t.destroy();
  }
  while (_npcNames.length < npcs.length) {
    const n = npcs[_npcNames.length];
    const t = new PIXI.Text(n.name, {
      fontFamily: 'system-ui, Arial', fontSize: 10, fontWeight: 'bold',
      fill: n.color || '#7b5ea7', stroke: '#000', strokeThickness: 3,
    });
    t.anchor.set(0.5, 1);
    _worldCt.addChild(t);
    _npcNames.push(t);
  }
  const bounce = Math.sin(ts * 0.009) * 3;
  for (let i = 0; i < npcs.length; i++) {
    const n = npcs[i], t = _npcNames[i];
    const onScreen = n.x >= _vL && n.x <= _vR && n.y >= _vT && n.y <= _vB;
    t.visible = onScreen;
    const obj = _getNpcObj(n.id);
    obj.ct.visible = onScreen;
    if (!onScreen) continue;
    obj.ct.x = n.x; obj.ct.y = n.y;
    const { gfx, spr } = obj;
    gfx.clear();
    const col = parseInt((n.color || '#7b5ea7').replace('#', ''), 16);

    // Sprite (lazy-load on first encounter, matches enemy loading pattern)
    if (!npcSpriteCache[n.icon]) loadNpcSprites(n.icon);
    const def      = NPC_SPRITE_DEF[n.icon];
    const textures = def ? _npcTextures(n.icon) : null;

    // Sprite top/bottom in local space — the shadow and label are derived
    // from this so they line up with the character instead of the small
    // fixed-radius token they were sized for before sprites existed.
    const spriteTop    = -_NPC_DISPLAY_H * 0.55;
    const spriteBottom = spriteTop + _NPC_DISPLAY_H;

    // Shadow at the feet
    gfx.beginFill(0x000000, 0.3);
    gfx.drawEllipse(0, textures ? spriteBottom - 6 : 18, 14, 5);
    gfx.endFill();

    if (textures && def) {
      if (n._animTimer === undefined) { n._animFrame = 0; n._animTimer = 0; }
      n._animTimer += dt;
      const fd = 1 / def.fps;
      while (n._animTimer >= fd) {
        n._animTimer -= fd;
        n._animFrame = (n._animFrame + 1) % def.cols;
      }
      spr.texture = textures[n._animFrame] || textures[0];
      spr.width  = _NPC_DISPLAY_H;
      spr.height = _NPC_DISPLAY_H;
      spr.x = -_NPC_DISPLAY_H * 0.5;
      spr.y = spriteTop;
      spr.visible = true;
    } else {
      // Circle fallback while the sheet is still loading
      spr.visible = false;
      gfx.beginFill(col);
      gfx.drawCircle(0, 0, 18);
      gfx.endFill();
    }

    t.x = n.x; t.y = n.y + (textures ? spriteTop + 8 : -26);

    if (nearNpc && nearNpc.id === n.id) {
      // chat bubble indicator
      const bubbleY = (textures ? spriteTop - 20 : -44) + bounce;
      gfx.beginFill(0xffffff, 0.85);
      gfx.drawRoundedRect(-8, bubbleY, 16, 13, 3);
      gfx.endFill();
    }
  }
}

// ── drops ─────────────────────────────────────────────────

function _updateDrops(ts) {
  _dropGfx.clear();
  _drawWorldDrops(ts);
  if (!drops.length) return;
  const s = Math.sin(ts * 0.0054);
  const bob = s * 3;
  drops.forEach(d => {
    const a = Math.min(1, d.life * 1.5) * (0.85 + 0.15 * s);
    if (d.type === 'gold') {
      _dropGfx.beginFill(0xffff00, a);
      _dropGfx.drawCircle(d.x, d.y + bob, 9);
      _dropGfx.endFill();
      _dropGfx.beginFill(0xcc8800, a * 0.9);
      _dropGfx.drawCircle(d.x, d.y + bob, 5);
      _dropGfx.endFill();
    } else {
      _dropGfx.beginFill(0xaaaacc, a * 0.85);
      _dropGfx.drawRoundedRect(d.x - 10, d.y + bob - 10, 20, 20, 3);
      _dropGfx.endFill();
      _dropGfx.lineStyle(1.5, 0xffffff, a * 0.5);
      _dropGfx.drawRoundedRect(d.x - 10, d.y + bob - 10, 20, 20, 3);
      _dropGfx.lineStyle(0);
    }
  });
}

// Event-boss ground loot (js/state.js worldDrops). Drawn as rarity-tinted
// gems on the same graphics layer as ordinary drops, with a soft halo so a
// field of 60+ piles reads clearly against the floor tiles.
const _WD_RARITY_HEX = {
  common: 0x9aa0a6, uncommon: 0x6fc46f, rare: 0x5aa8e6, epic: 0xb06fe0, legendary: 0xe0a24a,
};
function _drawWorldDrops(ts) {
  if (!worldDrops || !worldDrops.size) return;
  const s = Math.sin(ts * 0.0054);
  const bob = s * 3;
  const a = 0.85 + 0.15 * s;
  worldDrops.forEach(d => {
    const col = _WD_RARITY_HEX[d.item && d.item.rarity] || 0xc4a276;
    const y = d.y + bob;
    _dropGfx.beginFill(col, a * 0.18);
    _dropGfx.drawCircle(d.x, y, 17);
    _dropGfx.endFill();
    _dropGfx.beginFill(col, a * 0.9);
    _dropGfx.drawRoundedRect(d.x - 9, y - 9, 18, 18, 4);
    _dropGfx.endFill();
    _dropGfx.lineStyle(1.5, 0xffffff, a * 0.55);
    _dropGfx.drawRoundedRect(d.x - 9, y - 9, 18, 18, 4);
    _dropGfx.lineStyle(0);
  });
}

// ── particles ─────────────────────────────────────────────

function _updateParticles() {
  _partGfx.clear();
  if (!particles.length) return;
  if (_particlesDirty) {
    if (particles.length > 1) particles.sort((a, b) => (a.color > b.color) - (a.color < b.color));
    _particlesDirty = false;
  }
  let i = 0;
  while (i < particles.length) {
    const col = particles[i].color;
    const cn = parseInt(col.replace('#', ''), 16);
    let j = i;
    while (j < particles.length && particles[j].color === col) j++;
    // find max alpha in this batch for beginFill (individual alphas via separate fills)
    while (i < j) {
      const p = particles[i++];
      const a = Math.max(0, p.life);
      if (a <= 0) continue;
      _partGfx.beginFill(cn, a);
      _partGfx.drawCircle(p.x, p.y, p.size);
      _partGfx.endFill();
    }
  }
}

// ── projectiles ───────────────────────────────────────────

function _pixiDrawProj(p) {
  const col = parseInt((p.color || '#fa0').replace('#', ''), 16);
  if (p.projType === 'arrow') {
    const ang = p.angle ?? Math.atan2(p.vy, p.vx);
    const cos = Math.cos(ang), sin = Math.sin(ang);
    const rx = (dx, dy) => p.x + dx * cos - dy * sin;
    const ry = (dx, dy) => p.y + dx * sin + dy * cos;
    _projGfx.lineStyle(2.5, col, 1);
    _projGfx.moveTo(rx(-13, 0), ry(-13, 0));
    _projGfx.lineTo(rx(9,   0), ry(9,   0));
    _projGfx.lineStyle(0);
    _projGfx.beginFill(col);
    _projGfx.drawPolygon([
      rx(13, 0), ry(13, 0),
      rx(6, -3.5), ry(6, -3.5),
      rx(6,  3.5), ry(6,  3.5),
    ]);
    _projGfx.endFill();
  } else {
    _projGfx.beginFill(col, 0.3);
    _projGfx.drawCircle(p.x, p.y, p.size + 7);
    _projGfx.endFill();
    _projGfx.beginFill(col, 0.8);
    _projGfx.drawCircle(p.x, p.y, p.size);
    _projGfx.endFill();
    _projGfx.beginFill(0xffffff, 0.9);
    _projGfx.drawCircle(p.x, p.y, p.size * 0.38);
    _projGfx.endFill();
  }
}

function _updateProjs() {
  _projGfx.clear();
  projs.forEach(_pixiDrawProj);
  otherProjs.forEach(_pixiDrawProj);
}

// ── damage numbers ────────────────────────────────────────

function _getDmgText() {
  if (_dmgPool.length) return _dmgPool.pop();
  const t = new PIXI.Text('', {
    fontFamily: 'Arial', fontWeight: 'bold',
    fill: '#fff', stroke: '#000', strokeThickness: 3,
    align: 'center',
  });
  t.anchor.set(0.5, 0.5);
  _dmgNumCt.addChild(t);
  return t;
}

function _updateDmgNums() {
  while (_dmgActive.length > dmgNums.length) {
    const t = _dmgActive.pop();
    t.visible = false;
    _dmgPool.push(t);
  }
  while (_dmgActive.length < dmgNums.length) _dmgActive.push(_getDmgText());
  for (let i = 0; i < dmgNums.length; i++) {
    const d = dmgNums[i], t = _dmgActive[i];
    t.visible = true;
    if (t.text !== d.text) t.text = d.text;
    if (t.style.fontSize !== (d.fontSize || 15)) t.style.fontSize = d.fontSize || 15;
    if (t.style.fill !== (d.color || '#fff')) t.style.fill = d.color || '#fff';
    t.alpha = Math.min(1, d.life * 1.5);
    t.x = d.x; t.y = d.y;
  }
}

// ── enemy pool ────────────────────────────────────────────

function _getEnemy(id) {
  if (_enemyPool.has(id)) return _enemyPool.get(id);
  const ct  = new PIXI.Container();
  const spr = new PIXI.Sprite(PIXI.Texture.WHITE);
  spr.visible = false;
  const gfx = new PIXI.Graphics();
  const lbl = new PIXI.Text('', { fontFamily: 'system-ui,Arial', fontWeight: 'bold', fontSize: 14, fill: '#e8e8e8', stroke: '#000', strokeThickness: 4, align: 'center' });
  lbl.anchor.set(0.5, 1);
  ct.addChild(spr, gfx, lbl);
  _enemyCt.addChild(ct);
  const obj = { ct, spr, gfx, lbl };
  _enemyPool.set(id, obj);
  return obj;
}

function _updateEnemyObj(e, obj, dt, pulse, bossGlow) {
  const { ct, spr, gfx } = obj;
  ct.x = e.x; ct.y = e.y;

  const isSelected = e.id === targetId && !targetIsPlayer;

  // Determine animation key (mirrors drawEnemySprite logic)
  if (!e._facing) e._facing = 'down';
  let key;
  if (e.hp <= 0)                               key = 'death';
  else if (e.atkAnimTimer > 0 && !e._atkDone) key = 'attack';
  else if (e.aggro && (e._moveTimer||0) > 0)  key = 'walk';
  else                                         key = 'idle';

  // Advance animation timer (drawEnemySprite did this; now we do it here)
  const def = ENEMY_SPRITE_DEF[e.eid];
  if (def) {
    const sh = def.sheets[key];
    if (sh) {
      if (e._animKey !== key) { e._animKey = key; e._animFrame = 0; e._animTimer = 0; }
      e._animTimer = (e._animTimer || 0) + dt;
      const fd = 1 / sh.fps;
      while (e._animTimer >= fd) {
        e._animTimer -= fd;
        e._animFrame = (e._animFrame || 0) + 1;
        if (e._animFrame >= sh.cols) {
          e._animFrame = sh.loop ? 0 : sh.cols - 1;
          if (!sh.loop && key === 'attack') e._atkDone = true;
        }
      }
    }
  }

  const ds     = (e.isBoss ? e.size * 4.5 : e.size * 6.75) * 0.85;
  const texRows = def ? _enemyTextures(e.eid, key) : null;
  const sh = def?.sheets[key];
  if (texRows && sh) {
    const facing = e._facing || 'down';
    const rowTex = texRows[facing];
    const frame  = Math.min(e._animFrame || 0, sh.cols - 1);
    const tex    = rowTex?.[frame];
    if (tex) {
      spr.texture  = tex;
      spr.width    = ds;
      spr.height   = ds;
      spr.x        = -ds * 0.5;
      spr.y        = -ds * 0.55;
      spr.tint    = (e.hurtTimer > 0) ? 0xff4444 : 0xffffff;
      spr.visible = true;
    } else { spr.visible = false; }
  } else {
    spr.visible = false;
  }

  const hurt    = (e.hurtTimer||0)  > 0;
  const slowed  = (e.slowTimer||0)  > 0;
  const stunned = (e.stunTimer||0)  > 0;
  const dead    = e.hp <= 0;
  const isBossAlive = e.isBoss && !dead;

  // The selection ring and boss glow pulse every frame (sin-based), so those
  // force a rebuild while active. Everything else here — HP bar, status
  // tints — only changes when the underlying state changes, so
  // gfx.clear()+redraw (CPU tessellation + a fresh GPU buffer upload) is
  // skipped unless something actually moved. Previously this ran unconditionally
  // for every visible enemy every frame, a cost that scaled with enemy count
  // (crowded rooms, raids) even when nothing on screen was changing.
  const needsRedraw = isSelected || isBossAlive ||
    obj._gfxSelected  !== isSelected ||
    obj._gfxHurt     !== hurt ||
    obj._gfxSlowed    !== slowed ||
    obj._gfxStunned   !== stunned ||
    obj._gfxDead       !== dead ||
    obj._gfxHp          !== e.hp ||
    obj._gfxMaxHp         !== e.maxHp;

  if (!needsRedraw) return;

  gfx.clear();
  obj._gfxSelected = isSelected;

  // Selection ring
  if (isSelected) {
    gfx.lineStyle(2.5, 0xff3c3c, 0.65 + 0.35 * pulse);
    gfx.drawCircle(0, 0, e.size + 8 + pulse * 3);
    gfx.lineStyle(0);
  }

  // Status overlays
  if (slowed)  { gfx.beginFill(0x44aaff, 0.28); gfx.drawCircle(0,0,e.size); gfx.endFill(); }
  if (stunned) { gfx.beginFill(0xffff88, 0.35); gfx.drawCircle(0,0,e.size); gfx.endFill(); }

  obj._gfxHurt     = hurt;
  obj._gfxSlowed    = slowed;
  obj._gfxStunned   = stunned;
  obj._gfxDead       = dead;
  obj._gfxHp          = e.hp;
  obj._gfxMaxHp         = e.maxHp;

  if (dead) return; // no bars for corpse

  // HP bar
  const bw  = Math.round(ds * 0.7 * 0.85);
  const bh  = 5;
  const bx  = -bw / 2;
  const by  = -ds * 0.55 - 8;
  gfx.beginFill(0x440000); gfx.drawRect(bx, by, bw, bh); gfx.endFill();
  const pct = e.hp / e.maxHp;
  const bc  = pct > 0.5 ? 0x22dd22 : pct > 0.25 ? 0xddaa22 : 0xdd2222;
  gfx.beginFill(bc); gfx.drawRect(bx, by, bw * pct, bh); gfx.endFill();

  if (isBossAlive) {
    gfx.lineStyle(3, 0xff3232, bossGlow);
    gfx.drawCircle(0, 0, e.size + 5);
    gfx.lineStyle(0);
  }

  // Name / boss label above HP bar — level on its own line above the name
  const { lbl } = obj;
  const lvlLine  = e.rlvl > 0 ? `Уровень ${e.rlvl}\n` : '';
  const nameLine = e.isBoss ? `⚠ БОСС · ${e.name || ''}` : `${e.name || ''}`;
  const lblText  = lvlLine + nameLine;
  if (lbl.text !== lblText) lbl.text = lblText;
  lbl.style.fill         = e.isBoss ? '#ff9999' : '#e8e8e8';
  lbl.style.fontSize     = e.isBoss ? 18 : 14;
  lbl.style.strokeThickness = e.isBoss ? 5 : 4;
  lbl.x = 0;
  lbl.y = by - 4;
}

let _enemyVisGen = 0;
function _updateEnemies(dt, pulse, bossGlow) {
  _visEnm = 0;
  const gen = ++_enemyVisGen;
  serverEnemies.forEach(e => {
    if (!_isOnScreen(e.x, e.y)) return;
    // Lazy-load sprites on first encounter (mirrors old drawEnemySprite behaviour)
    if (!enemySpriteCache[e.eid]) loadEnemySprites(e.eid);
    _visEnm++;
    const obj = _getEnemy(e.id);
    obj.ct.visible = true;
    obj._visGen = gen;
    _updateEnemyObj(e, obj, dt, pulse, bossGlow);
  });
  _enemyPool.forEach(obj => { if (obj._visGen !== gen) obj.ct.visible = false; });
}

// Base sprite display height for the local player and other players (world
// px, before each class's own def.dispScale) — ×1.1 over the original 68.
const _PLAYER_DISPLAY_H = 68 * 1.1;

// ── other players ─────────────────────────────────────────

// Username + clan tag for other players are drawn on the 2D UI overlay
// (see _drawOtherPlayerNamesOnUI in game.js), not here — a WebGL PIXI.Text
// gets rasterized once and then scaled by the world container's ZOOM factor,
// which blurs it, and re-centering it every frame from live text metrics is
// what caused the jitter. The overlay draws text at native screen resolution
// every frame, exactly like the local player's own name/clan tag already do.
// ── status auras ──────────────────────────────────────────
// Two ranks of player wear a light aura so they're recognisable on sight:
//   • the #1 player in the rating (server/index.js _refreshTopPlayer tells
//     every client who that is) — purple, since it's the rarer of the two;
//   • anyone at VIP 2 or above who is currently online (server/index.js
//     _vipAuraUsers / the 'vipAuras' broadcast) — gold.
// Top-1 outranks VIP, so the leader shows purple even when they're also VIP.
// Drawn on its own Graphics UNDER the sprite, so it reads as light around
// the character rather than paint on top of them.
//
// Everything here is flat Graphics — the strict CSP this game ships under
// rules out loading a glow texture, so the soft falloff is faked with a few
// stacked translucent ellipses, cheapest-first. Each aura forces one
// Graphics rebuild per frame for the player wearing it.
const _AURA_PALETTES = {
  // pool: ground light · halo: body light · core: hot centre ·
  // rim: pool outline · ray: sweeping spokes · mote: rising sparks
  gold:   { pool: 0xffc63c, halo: 0xffd76a, core: 0xfff3cf, rim: 0xffe9a8, ray: 0xffd76a, mote: 0xfff0c0 },
  purple: { pool: 0x9b3fe0, halo: 0xb56cf0, core: 0xf3e2ff, rim: 0xd8a8ff, ray: 0xb56cf0, mote: 0xe8c8ff },
};

function isTopPlayer(username) {
  const top = window._topPlayer;
  return !!top && !!username && username === top;
}

function hasVipAura(username) {
  const set = window._vipAuraUsers;
  return !!set && !!username && set.has(username);
}

// Which aura (if any) this username wears — 'purple' | 'gold' | null.
// Returning a plain key lets callers cheaply detect a change (and skip the
// redraw/clear) without re-deriving the whole thing.
function auraKindFor(username) {
  if (isTopPlayer(username)) return 'purple';
  if (hasVipAura(username))  return 'gold';
  return null;
}

function _drawAura(g, cx, cy, ts, kind) {
  const c = _AURA_PALETTES[kind];
  if (!c) return;
  const t     = ts * 0.001;
  const pulse = 0.5 + 0.5 * Math.sin(t * 2.2);
  const gy    = cy + 6;                       // ground contact, just below the feet

  // Ground pool: widest and faintest first, so the overlaps build a falloff.
  // Many thin layers rather than few thick ones — at three or four the steps
  // between them read as visible rings instead of as light.
  for (let i = 10; i >= 1; i--) {
    const r = 6 + i * 2.9 + pulse * 2;
    g.beginFill(c.pool, 0.020 + 0.013 * (11 - i));
    g.drawEllipse(cx, gy, r, r * 0.42);
    g.endFill();
  }
  // Body halo — vertical, so the character stands inside the light rather
  // than on top of a lit patch.
  for (let i = 7; i >= 1; i--) {
    g.beginFill(c.halo, 0.013 + 0.009 * (8 - i));
    g.drawEllipse(cx, cy - 12, 12 + i * 2.6, 20 + i * 3.6);
    g.endFill();
  }
  // Bright core where the light meets the floor.
  g.beginFill(c.core, 0.10 + 0.06 * pulse);
  g.drawEllipse(cx, gy, 11, 4.6);
  g.endFill();
  // Rim of the pool.
  const rr = 25 + pulse * 2.5;
  g.lineStyle(2, c.rim, 0.40 + 0.25 * pulse);
  g.drawEllipse(cx, gy, rr, rr * 0.42);
  g.lineStyle(0);
  // Rays sweeping around the rim, at two speeds so the motion isn't a rigid
  // spin. These are what read as "radiant" rather than just "lit".
  for (let i = 0; i < 8; i++) {
    const a  = t * 0.7 + (i * Math.PI * 2) / 8;
    const r1 = 30 + 5 * Math.sin(t * 3 + i);
    g.lineStyle(2, c.ray, 0.16 + 0.16 * pulse);
    g.moveTo(cx + Math.cos(a) * 13, gy + Math.sin(a) * 13 * 0.42);
    g.lineTo(cx + Math.cos(a) * r1, gy + Math.sin(a) * r1 * 0.42);
  }
  g.lineStyle(0);
  // Motes drifting upward around the body.
  for (let i = 0; i < 5; i++) {
    const a  = t * 1.1 + (i * Math.PI * 2) / 5;
    const ry = ((t * 22 + i * 15) % 46);
    g.beginFill(c.mote, 0.5 * (1 - ry / 46));
    g.drawCircle(cx + Math.cos(a) * 17, gy - ry, 1.7);
    g.endFill();
  }
}

function _getOtherPlayer(sid) {
  if (_otherPool.has(sid)) return _otherPool.get(sid);
  const ct   = new PIXI.Container();
  const aura = new PIXI.Graphics();
  const spr  = new PIXI.Sprite(PIXI.Texture.WHITE);
  spr.visible = false;
  const gfx = new PIXI.Graphics();
  ct.addChild(aura, spr, gfx);
  _otherPCt.addChild(ct);
  const obj = { ct, spr, gfx, aura };
  _otherPool.set(sid, obj);
  return obj;
}

let _otherVisGen = 0;
function _updateOtherPlayers(pulse, ts) {
  const gen = ++_otherVisGen;
  otherPlayers.forEach((p, pid) => {
    if (p.x == null || isNaN(p.x) || !_isOnScreen(p.x, p.y)) return;
    const obj = _getOtherPlayer(pid);
    obj._visGen = gen;
    const { ct, spr, gfx, aura } = obj;
    ct.visible = true;
    ct.x = p.x; ct.y = p.y;

    // Rating-leader / VIP aura. Animated, so unlike the gfx layer below it
    // can't sit behind the needsRedraw guard. Drawn in container-local
    // space, hence 0,0.
    const auraKind = auraKindFor(p.username);
    if (auraKind) {
      aura.clear();
      _drawAura(aura, 0, 0, ts, auraKind);
      aura.visible = true;
    } else if (obj._auraKind) {
      aura.clear();
      aura.visible = false;
    }
    obj._auraKind = auraKind;

    const isSelected = pid === targetId && targetIsPlayer;
    const swinging = (p._swingTimer || 0) > 0;

    // Sprite — always updated, the texture/frame changes with the walk/idle
    // animation every frame regardless of whether the Graphics layer redraws.
    const key      = getOtherPlayerAnimKey(p);
    const textures = _playerTextures(p.type, key);
    const def      = SPRITE_DEF[p.type];
    let usedSprite = false;
    if (textures && def) {
      const ad = def.anims[key];
      const fi = Math.min(Math.floor(p.animFrame || 0), (ad?.n || 1) - 1);
      spr.texture = textures[fi] || PIXI.Texture.WHITE;
      const cache = spriteCache[p.type];
      const img   = cache?.[key];
      const fw    = img?.frameW || def.frameW || 64;
      const fh    = img?.frameH || def.frameH || 64;
      const dh = _PLAYER_DISPLAY_H * (def.dispScale || 1), dw = dh * fw / fh;
      spr.width = dw; spr.height = dh;
      spr.x = -dw / 2; spr.y = -dh * 0.62;
      spr.visible = true;
      usedSprite = true;
    } else {
      spr.visible = false;
    }

    // Read every frame by the 2D name/clan overlay — cheap, independent of gfx.
    const barTop = usedSprite ? -39 : -20;
    p._nameBarTop = barTop;

    const slowed  = (p.slowTimer||0) > 0;
    const stunned = (p.stunTimer||0) > 0;
    const hp = p.hp || 0, maxHp = p.maxHp || 1;

    // Selection ring pulses continuously while active, so it forces a redraw
    // every frame it's on. Everything else (swing arc, HP bar, status tints,
    // fallback circle) is state-driven, not animated — skip the Graphics
    // rebuild (CPU tessellation + GPU buffer upload) unless the underlying
    // state actually changed. Previously this ran unconditionally for every
    // visible other player every frame, a cost that scaled with player count
    // (raids, crowded floors) even while everyone stood still.
    const needsRedraw = isSelected ||
      obj._gfxSelected   !== isSelected ||
      obj._gfxSwinging   !== swinging ||
      obj._gfxUsedSprite !== usedSprite ||
      obj._gfxSlowed      !== slowed ||
      obj._gfxStunned      !== stunned ||
      obj._gfxHp             !== hp ||
      obj._gfxMaxHp            !== maxHp;

    if (!needsRedraw) return;

    gfx.clear();
    obj._gfxSelected = isSelected;

    if (isSelected) {
      gfx.lineStyle(2.5, 0xff5050, 0.65 + 0.35 * pulse);
      gfx.drawCircle(0, 0, 22 + pulse * 3);
      gfx.lineStyle(0);
    }

    if (swinging) {
      const sa = p._swingAngle || 0;
      gfx.lineStyle(2.5, 0xc8dcff, 0.65);
      gfx.arc(0, 0, 30, sa - 0.65, sa + 0.65);
      gfx.lineStyle(0);
    }

    if (!usedSprite) {
      const fc = parseInt((CHAR_DEF[p.type]?.color || '#aaaaaa').replace('#',''), 16);
      gfx.beginFill(fc); gfx.drawCircle(0, 0, 14); gfx.endFill();
    }

    if (slowed)  { gfx.beginFill(0x44aaff, 0.28); gfx.drawCircle(0,0,18); gfx.endFill(); }
    if (stunned) { gfx.beginFill(0xffff88, 0.35); gfx.drawCircle(0,0,18); gfx.endFill(); }

    const bw = 38, bh = 4;
    gfx.beginFill(0x330000); gfx.drawRect(-bw/2, barTop, bw, bh); gfx.endFill();
    gfx.beginFill(0x22dd22); gfx.drawRect(-bw/2, barTop, bw * Math.max(0, hp/maxHp), bh); gfx.endFill();

    obj._gfxSwinging    = swinging;
    obj._gfxUsedSprite  = usedSprite;
    obj._gfxSlowed       = slowed;
    obj._gfxStunned       = stunned;
    obj._gfxHp              = hp;
    obj._gfxMaxHp             = maxHp;
  });
  _otherPool.forEach(obj => { if (obj._visGen !== gen) obj.ct.visible = false; });
}

// ── player ────────────────────────────────────────────────

function _initPlayer() {
  if (_plSpr) return;
  _plSpr = new PIXI.Sprite(PIXI.Texture.WHITE);
  _plSpr.visible = false;
  _plGfx  = new PIXI.Graphics();
  _plAura = new PIXI.Graphics();
  // Under the sprite, same as other players' aura layer.
  _playerCt.addChild(_plAura, _plSpr, _plGfx);
}

function _updatePlayer(dt, ts) {
  _initPlayer();
  if (!player || (state !== 'playing' && state !== 'dead')) {
    _playerCt.visible = false;
    return;
  }
  _playerCt.visible = true;
  _playerCt.alpha   = invisTimer > 0 ? 0.35 : 1;
  _plGfx.clear();

  // The leader sees their own aura too. netUsername is this client's own name,
  // the same value the rating table matches on.
  _plAura.clear();
  const _selfAura = auraKindFor(typeof netUsername !== 'undefined' ? netUsername : null);
  _plAura.visible = !!_selfAura;
  if (_selfAura) _drawAura(_plAura, player.x, player.y, ts, _selfAura);

  const key      = getSpriteAnimKey(player);
  const textures = _playerTextures(player.type, key);
  const def      = SPRITE_DEF[player.type];
  let usedSprite = false;
  if (textures && def) {
    const ad = def.anims[key];
    const fi = Math.min(Math.floor(player.animFrame), (ad?.n || 1) - 1);
    _plSpr.texture = textures[fi] || PIXI.Texture.WHITE;
    const cache = spriteCache[player.type];
    const img   = cache?.[key];
    const fw    = img?.frameW || def.frameW || 64;
    const fh    = img?.frameH || def.frameH || 64;
    const dh = _PLAYER_DISPLAY_H * (def.dispScale || 1), dw = dh * fw / fh;
    _plSpr.width = dw; _plSpr.height = dh;
    _plSpr.x = player.x - dw / 2;
    _plSpr.y = player.y - dh * 0.62;
    _plSpr.tint    = (player.hurtTimer > 0) ? 0xff4444 : 0xffffff;
    _plSpr.visible = true;
    usedSprite = true;
  } else {
    _plSpr.visible = false;
    const hurt = player.hurtTimer > 0;
    const fc   = parseInt((player.charDef?.color || '#888888').replace('#',''), 16);
    _plGfx.beginFill(hurt ? 0xff4444 : fc);
    _plGfx.drawCircle(player.x, player.y, 14);
    _plGfx.endFill();
    _plGfx.lineStyle(2, 0xffffff, 0.4);
    _plGfx.drawCircle(player.x, player.y, 14);
    _plGfx.lineStyle(0);
  }

  // Swing arc
  if (swingTimer > 0) {
    _plGfx.lineStyle(3, 0xc8dcff, 0.75);
    _plGfx.arc(player.x, player.y, 34, swingAngle - 0.7, swingAngle + 0.7);
    _plGfx.lineStyle(0);
  }

  // HP bar
  const barTop = usedSprite ? player.y - 39 : player.y - 28;
  const bw = 44, bh = 4, bx = player.x - bw / 2;
  const hpPct = Math.max(0, Math.min(1, player.hp / player.maxHp));
  _plGfx.beginFill(0x1e0000, 0.75); _plGfx.drawRect(bx, barTop, bw, bh); _plGfx.endFill();
  if (hpPct > 0) {
    const bc = hpPct > 0.5 ? 0x2ecc71 : hpPct > 0.25 ? 0xf39c12 : 0xe74c3c;
    _plGfx.beginFill(bc); _plGfx.drawRect(bx, barTop, bw * hpPct, bh); _plGfx.endFill();
  }

  _lastPlayerUsedSprite = usedSprite;
}

// ── equipped pets ─────────────────────────────────────────
// Every player's pet is drawn, not just the local one: pet ids arrive via
// the 'playerPets'/'playerPet' events (see js/network.js) and ride on the
// otherPlayers entries. Each pet trails a point behind its owner rather than
// sitting glued to them, so it visibly follows instead of teleporting.
function _dirVecFromFacing(facing) {
  const idx = FACING8_DIRS.indexOf(facing);
  if (idx < 0) return [0, 1]; // default: front
  const rad = idx * 45 * Math.PI / 180;
  return [Math.cos(rad), Math.sin(rad)];
}
function _petFacing4(nx, ny) {
  return Math.abs(nx) > Math.abs(ny) ? (nx > 0 ? 'right' : 'left') : (ny > 0 ? 'front' : 'back');
}
const _PET_TRAIL_OFFSET = 24;  // world px behind the owner the pet trails at
const _PET_SNAP_DIST    = 260; // floor change / respawn — snap instead of visibly sliding across the map
const _PET_DISPLAY_SCALE = 0.5; // fraction of the player's own sprite height (was 1/3, ×1.5)
// Chase cap for OTHER players' pets. The local pet uses its owner's real
// player.speed, but remote players don't report their speed — this just has to be
// at least the fastest class (ranger, 175) plus move-speed passives so a pet
// never visibly lags behind its owner; the trailing offset above, not this,
// is what produces the follow look.
const _PET_REMOTE_SPEED = 260;

// One pooled {ct, spr, gfx} + trailing sim state per pet owner, keyed by
// socket id ('self' for the local player).
const _petPool = new Map();

function _getPetObj(key) {
  let obj = _petPool.get(key);
  if (obj) return obj;
  const ct  = new PIXI.Container();
  const gfx = new PIXI.Graphics();
  const spr = new PIXI.Sprite(PIXI.Texture.WHITE);
  spr.visible = false;
  ct.addChild(gfx, spr);
  _petCt.addChild(ct);
  obj = { ct, gfx, spr, st: null };
  _petPool.set(key, obj);
  return obj;
}

function pixiRemovePet(key) {
  const obj = _petPool.get(key);
  if (!obj) return;
  obj.ct.destroy({ children: true });
  _petPool.delete(key);
}

// Advances one pet's trailing position/facing toward a point behind its
// owner, then draws it. ownerX/ownerY/ownerFacing describe the owner this
// frame; speed caps how fast the pet may close the gap.
function _updateOnePet(key, petId, ownerX, ownerY, ownerFacing, speed, dt) {
  const obj = _getPetObj(key);
  obj._visGen = _petVisGen;

  const [fx, fy] = _dirVecFromFacing(ownerFacing);
  const targetX = ownerX - fx * _PET_TRAIL_OFFSET;
  const targetY = ownerY - fy * _PET_TRAIL_OFFSET;

  if (!obj.st) obj.st = { x: targetX, y: targetY, facing: 'front', moving: false };
  const st = obj.st;

  const dx = targetX - st.x, dy = targetY - st.y;
  const dist = Math.hypot(dx, dy);
  if (dist > _PET_SNAP_DIST) {
    st.x = targetX; st.y = targetY;
    st.moving = false;
  } else if (dist > 0.5) {
    const step = Math.min(dist, (speed || 0) * dt);
    st.x += (dx / dist) * step;
    st.y += (dy / dist) * step;
    st.moving = step > 0.05;
    if (st.moving) st.facing = _petFacing4(dx / dist, dy / dist);
  } else {
    st.moving = false;
  }

  obj.ct.visible = true;
  obj.gfx.clear();
  obj.gfx.beginFill(0x000000, 0.25);
  obj.gfx.drawEllipse(st.x, st.y + 3, 9, 3.5);
  obj.gfx.endFill();

  const def = PET_SPRITE_DEF[petId];
  const animKey = `${st.facing}-${st.moving ? 'run' : 'idle'}`;
  const textures = _petTextures(petId, animKey);
  if (textures && def) {
    const ad = def.anims[animKey];
    if (st._animKey !== animKey) { st._animKey = animKey; st._animFrame = 0; st._animTimer = 0; }
    st._animTimer += dt;
    const fstep = 1 / ad.fps;
    while (st._animTimer >= fstep) {
      st._animTimer -= fstep;
      st._animFrame = ad.loop ? (st._animFrame + 1) % ad.n : Math.min(ad.n - 1, st._animFrame + 1);
    }
    const cache = petSpriteCache[petId];
    const img   = cache && cache[animKey];
    const fw    = img?.frameW || def.frameW;
    const fh    = img?.frameH || def.frameH;
    const dh = _PLAYER_DISPLAY_H * _PET_DISPLAY_SCALE, dw = dh * fw / fh;
    obj.spr.texture = textures[st._animFrame] || PIXI.Texture.WHITE;
    obj.spr.width = dw; obj.spr.height = dh;
    obj.spr.x = st.x - dw / 2;
    obj.spr.y = st.y - dh * (def.anchorY != null ? def.anchorY : 0.7);
    obj.spr.visible = true;
  } else {
    obj.spr.visible = false;
  }
}

let _petVisGen = 0;
function _updatePets(dt) {
  if (!_petCt) return;
  const gen = ++_petVisGen;

  if (player && (state === 'playing' || state === 'dead')) {
    const petItem = player.equipment ? player.equipment.pet : null;
    if (petItem && petItem.id) {
      if (_petLoadedFor !== petItem.id) {
        _petLoadedFor = petItem.id;
        if (typeof loadPetSprites === 'function') loadPetSprites(petItem.id);
      }
      _updateOnePet('self', petItem.id, player.x, player.y, player.facing, player.speed, dt);
    }
  }

  // Other players — only the ones actually on screen, matching the same AOI
  // sweep _updateOtherPlayers does, so an off-screen pet costs nothing.
  otherPlayers.forEach((p, pid) => {
    const petId = otherPets.get(pid);
    if (!petId || p.x == null || isNaN(p.x) || !_isOnScreen(p.x, p.y)) return;
    _updateOnePet(pid, petId, p.x, p.y, p.facing || 'front', _PET_REMOTE_SPEED, dt);
  });

  // Anything not touched this frame (owner gone, off screen, pet unequipped)
  // is hidden — and its trailing state dropped, so it doesn't slide across
  // the map from a stale position when it comes back.
  _petPool.forEach((obj, key) => {
    if (obj._visGen === gen) return;
    if (obj.ct.visible) { obj.ct.visible = false; obj.spr.visible = false; obj.gfx.clear(); }
    obj.st = null;
  });
}

// ── main render entry ─────────────────────────────────────

function pixiWorldRender(dt, ts, camX, camY, theme) {
  if (!_pixiApp || _ctxLost) return;
  // Stamped BEFORE the work, not after: if this frame throws halfway through,
  // the renderer is still alive and the watchdog must not mistake one bad
  // frame for a dead context.
  _pixiLastRender = ts;

  const bgCol = theme ? theme.bg : '#060610';
  if (bgCol !== _lastBgColor) { pixiSetBg(bgCol); _lastBgColor = bgCol; }
  _worldCt.visible = true;
  _worldCt.x = -camX * ZOOM;
  _worldCt.y = HEADER_H - camY * ZOOM;

  const pulse    = 0.5 + 0.5 * Math.sin(ts * 0.009);
  const bossGlow = 0.6 + 0.4 * Math.sin(ts * 0.006);

  _updateTiles(camX, camY);
  _updateLights(ts);
  _updateAoeRings();
  _updateNpcs(dt, ts);
  _updateDrops(ts);
  _updateParticles();
  _updateEnemies(dt, pulse, bossGlow);
  _updateOtherPlayers(pulse, ts);
  _updateProjs();
  _updatePets(dt);
  _updatePlayer(dt, ts);
  _updateDmgNums();

  _pixiApp.renderer.render(_pixiApp.stage);
}
