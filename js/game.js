// Cached DOM elements (set once after DOMContentLoaded)
let _talkBtn = null;

// ─── Performance overlay ───────────────────────────────────
let _perfShow = false;          // toggle with triple-tap top-left corner
let _perfTapCount = 0, _perfTapTs = 0;
// Rolling 60-frame buffer for frame times (ms)
const _FT_BUF = new Float32Array(60);
let _ftIdx = 0, _ftFull = false;
// Rolling max frame time — highlights spikes
let _ftWorstMs = 0, _ftWorstDecay = 0;
// Adaptive quality tier — auto-degrades when FPS stays below 20 for ~3s
let _qualityTier = 0, _lowFpsFrames = 0;
// While a full-screen menu panel covers the world (any tab except the game
// view), the world+HUD are hidden and don't need re-rendering. Kept alive for
// a short grace window after a tab change so the ~0.28s panel slide-in still
// shows live world at the top instead of a frozen frame. Set by setTab().
let _menuGraceUntil = 0;
// How far past the newest snapshot another player may be dead-reckoned before
// they are simply left where they were last seen. ~3 packet intervals: long
// enough to ride out the dropped casts a volatile stream produces on a mobile
// link, short enough that at a 175px/s run speed the worst-case error is ~26px
// — under one character width, and corrected the instant a packet arrives.
const _EXTRAP_MAX_MS = 150;
// A snapshot pair wider than this is not a velocity measurement — see the
// keepalive note at the extrapolation site. ~3 packet intervals.
const _EXTRAP_MAX_SPAN_MS = 160;
// Ceiling on extrapolated speed, in px per MILLISECOND. Derived from the
// fastest class (ranger, speed 175 px/s) with generous headroom for the
// movement buffs stacked on top, so the clamp only ever catches a pair that
// straddles something that was not walking — a teleport pad, a respawn.
const _EXTRAP_MAX_V = 175 * 2 / 1000;
// Frames that ran out of buffer and had to extrapolate. Only meaningful as a
// rate, which is what the perf overlay shows — a few per second is a link
// dropping the odd packet, a steady stream of them means the interpolation
// delay is not keeping up and the adaptive sizing should be widening it.
let _netStarvedFrames = 0;
// Last snapshot-interpolation playback time actually rendered at — the
// monotonic floor for _renderT above.
let _lastRenderT = 0;
// _netStarvedFrames sampled into a per-second rate, so the overlay reads a
// stable number instead of a counter racing upward.
let _netStarvedRate = 0, _netStarvedAt = 0, _netStarvedBase = 0;
function _netStarvedTick() {
  const now = performance.now();
  if (!_netStarvedAt) { _netStarvedAt = now; _netStarvedBase = _netStarvedFrames; return; }
  const dt = now - _netStarvedAt;
  if (dt < 500) return;
  _netStarvedRate = (_netStarvedFrames - _netStarvedBase) * 1000 / dt;
  _netStarvedAt = now; _netStarvedBase = _netStarvedFrames;
}

function _perfToggleTap(cx, cy) {
  if (cx > 80 || cy > 80) return; // only top-left corner
  const now = performance.now();
  if (now - _perfTapTs > 800) _perfTapCount = 0;
  _perfTapTs = now;
  if (++_perfTapCount >= 3) { _perfShow = !_perfShow; _perfTapCount = 0; }
}

function _drawPerf(frameMs) {
  _netStarvedTick();
  // Store frame time
  _FT_BUF[_ftIdx] = frameMs;
  _ftIdx = (_ftIdx + 1) % 60;
  if (_ftIdx === 0) _ftFull = true;
  const samples = _ftFull ? 60 : _ftIdx || 1;
  let sum = 0, maxFt = 0;
  for (let i = 0; i < samples; i++) {
    sum += _FT_BUF[i];
    if (_FT_BUF[i] > maxFt) maxFt = _FT_BUF[i];
  }
  const avgMs = sum / samples;
  const fps = avgMs > 0 ? Math.round(1000 / avgMs) : 0;
  // Adaptive quality: drop to tier 1 when FPS stays < 20 for ~3s; recover when FPS >= 25.
  if (fps < 20) { if (++_lowFpsFrames > 90) _qualityTier = 1; }
  else if (fps >= 25) { _lowFpsFrames = Math.max(0, _lowFpsFrames - 1); if (_lowFpsFrames === 0) _qualityTier = 0; }
  // Decay worst-case slowly
  if (maxFt > _ftWorstMs) { _ftWorstMs = maxFt; _ftWorstDecay = 180; }
  else if (--_ftWorstDecay <= 0) { _ftWorstMs = maxFt; }

  if (!_perfShow) return;

  // Mini frame-time bar graph (60 bars)
  const bw = 2, bh = 40, bx0 = 8, by0 = 55;
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(bx0 - 2, by0 - bh - 2, samples * bw + 4, bh + 4 + 130);

  const _oldest = _ftFull ? _ftIdx : 0;
  for (let i = 0; i < samples; i++) {
    const ft = _FT_BUF[(_oldest + i) % 60];
    const h = Math.min(bh, ft / 50 * bh);
    ctx.fillStyle = ft > 50 ? '#ed5a6b' : ft > 40 ? '#e69419' : '#8cc758';
    ctx.fillRect(bx0 + i * bw, by0 - h, bw - 1, h);
  }
  // 30fps reference line
  ctx.fillStyle = 'rgba(209,204,197,0.25)';
  ctx.fillRect(bx0 - 2, by0 - bh * (33.3 / 50), samples * bw + 4, 1);

  // Text stats
  const mem = performance.memory;
  const _gpuS = typeof gpuStats === 'function' ? gpuStats() : { draws: 0, verts: 0 };
  const lines = [
    `FPS  ${fps}`,
    `ping ${_pingMs >= 0 ? _pingMs + 'ms' : '...'} ${socket?.io?.engine?.transport?.name === 'websocket' ? 'ws' : socket?.io?.engine?.transport?.name ?? ''}`,
    `avg  ${avgMs.toFixed(1)}ms`,
    `max  ${_ftWorstMs.toFixed(1)}ms`,
    `prt  ${particles.length}`,
    `enm  ${_visEnm}/${serverEnemies.length}`,
    `opl  ${otherPlayers.size}`,
    // The two numbers that say whether remote players will look smooth.
    // jit = p95 of how much later than best-case a snapshot arrived; itp = the
    // interpolation delay currently derived from it (js/network.js). strv =
    // starved frames per second — frames that ran past the newest snapshot and
    // had to extrapolate. A healthy link sits at low jit, itp near its 70ms
    // floor, and strv at 0.
    `jit  ${netJitterP95().toFixed(0)}ms  itp ${netInterpCurrent().toFixed(0)}ms`,
    `strv ${_netStarvedRate.toFixed(1)}/s`,
    // Enemy deltas dropped for want of the record behind them. Should be 0;
    // if it climbs, monsters are standing still or missing for this player.
    `lost ${typeof netLostHandles === 'function' ? netLostHandles() : '?'}`,
    `upd  ${_profUpdate.toFixed(1)}ms`,
    `rnd  ${_profRender.toFixed(1)}ms`,
    `skt  ${_profSocketEvtsSnap}e ${_profSocketMsSnap.toFixed(1)}ms`,
    `dpr  ${DPR.toFixed(2)} / ${(window.devicePixelRatio || 1).toFixed(2)} raw`,
    `res  ${_pixiApp ? _pixiApp.renderer.resolution.toFixed(2) : '?'} mob=${_isMobile ? 1 : 0}`,
    `qlty ${_qualityTier}`,
    // What the GPU was actually handed last frame — js/pixi-world.js counts
    // the real gl.draw* calls rather than trusting the scene graph to batch.
    // draws is the number that says whether it IS batching: it should stay
    // roughly flat as enemies, players and particles pile on. verts catches
    // the other failure mode, a Graphics layer quietly tessellating thousands
    // of triangles a frame for circles nobody can see.
    `gpu  ${_gpuS.draws} draws ${(_gpuS.verts / 1000).toFixed(1)}k v`,
    `drp  ${drops.length}`,
    mem ? `mem  ${(mem.usedJSHeapSize / 1048576).toFixed(0)}MB` : '',
  ];
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  const ty0 = by0 + 6;
  lines.forEach((ln, i) => {
    if (!ln) return;
    ctx.fillStyle = '#000000';
    ctx.fillText(ln, bx0 + 1, ty0 + i * 14 + 1);
    let col = '#d1ccc5';
    if (i === 0) col = fps < 20 ? '#ed5a6b' : fps < 27 ? '#e69419' : '#98e456';
    else if (i === 1 && _pingMs >= 0) col = _pingMs > 150 ? '#ed5a6b' : _pingMs > 80 ? '#e69419' : '#98e456';
    ctx.fillStyle = col;
    ctx.fillText(ln, bx0, ty0 + i * 14);
  });
}

// UI overlay canvas (separate DOM element at native DPR)
let _uiOverlay, _uiCtx = null;
// HUD cache canvas — _renderUI() draws here at 20fps; blitted every frame (cheap drawImage)
let _hudCv = null, _hudCvCtx = null, _uiLastMs = 0;
// Camera position cached for UI overlay coordinate conversion
let _lastCamX = 0, _lastCamY = 0;
// Player sprite state flag (used by _drawPlayerNameOnUI for bar offset)
let _lastPlayerUsedSprite = false;
// Rendered-name-bitmap cache (own player) — see _buildNameBitmap below
let _nameBitmap = null, _prevNameKey = '';
// Clan tag cache: icon pre-rendered to offscreen canvas; blit with drawImage (1 call vs 256 fillRects)
let _clanIconCv = null, _clanIconKey = null;
// Rendered clan-tag-text bitmap cache (own player) — see _buildClanTagBitmap
let _clanTagBitmap = null, _prevClanTagKey = '';
// last damage dealt by player — used for optimistic kill prediction on arrow hit
let _lastOwnDmg = 0;

// Reusable sentinel for pvp closest-target — avoids per-frame object spread
const _pvpSentinel = { _socketId: null, x: 0, y: 0 };

// Visible enemy count (set each render frame, read by _drawPerf)
let _visEnm = 0;

// How far out this client keeps SIMULATING enemies — status timers, the chase
// smoothing, the position correction. Everything past it is snapped straight
// to the server's position instead (see the enemy loop in update()): correct,
// just not smoothed, which is all an enemy nobody can see needs.
//
// It has to cover whatever is actually on screen, and the fixed 1100 it
// replaces did not. On a wide desktop window the visible world reaches past
// 1100, so an enemy the player could see was drawn from a position nothing was
// updating. Half the viewport diagonal plus a margin, floored at the old value
// so a phone still gets the CPU saving this gate exists for. Recomputed in
// resize(), because that is the only thing it depends on.
let _ENEMY_SIM_R2 = 1100 * 1100;
function _recalcEnemySimR() {
  const halfW = W / (2 * ZOOM), halfH = (H - HEADER_H) / (2 * ZOOM);
  const r = Math.sqrt(halfW * halfW + halfH * halfH) + 200;
  _ENEMY_SIM_R2 = Math.max(1100 * 1100, r * r);
}

// Profiling breakdown — measures update vs render vs socket processing
let _profUpdate = 0, _profRender = 0;
let _profSocketEvts = 0, _profSocketMs = 0;
let _profSocketEvtsSnap = 0, _profSocketMsSnap = 0;


// ─────────────────────────────────────────────────────────
//  CAMERA
// ─────────────────────────────────────────────────────────
// Height actually free for gameplay: the bottom nav is an opaque overlay
// docked to the bottom of #app, not extra canvas space, so it must come off
// the same as the header or the camera treats that strip as visible and can
// center/clamp the player right behind it (invisible, same for chunk streaming).
function _visH() { return (H - HEADER_H - NAV_H) / ZOOM; }

// True while this client is frozen on the arena start line waiting for the
// death battle's countdown. Gates movement, attacks and skills — the server
// refuses all three for the same window (see _dbFrozen in server/index.js),
// so this only keeps the local view honest rather than being the real guard.
function _dbFrozen() {
  return typeof _dbFightAt !== 'undefined' && _dbFightAt > 0 && Date.now() < _dbFightAt;
}

// ── Server position correction ──────────────────────────────────────────────
// Set by the posCorrect handler (js/network.js) when the server has refused a
// move and is telling us where it still has us. Null when there is nothing to
// converge on, which is almost always: the move guard ships in 'log' mode
// (_MOVE_GUARD, server/game/Room.js) and never sends a correction at all —
// this is what happens once it is switched to 'enforce'.
//
// A correction is authoritative and is applied in full; the only question is
// whether it lands in one frame. A small one (a lag burst that coalesced a
// second of running into one packet, and legitimate play near the budget) is
// eased in over _POS_FIX_MS so the character walks the last stretch instead of
// blinking. A large one is a teleport by definition — easing it would fly the
// character across the map at impossible speed, and every intermediate
// position would itself overdraw the budget and earn another correction, so
// those still snap.
let _posFixX = null, _posFixY = null;
const _POS_FIX_MS  = 150;
const _POS_FIX_MAX = 400;   // px; beyond this, snap

function netApplyPosCorrection(x, y) {
  if (!player) return;
  const dx = x - player.x, dy = y - player.y;
  if (dx * dx + dy * dy > _POS_FIX_MAX * _POS_FIX_MAX) {
    player.x = x; player.y = y;
    _posFixX = _posFixY = null;
    return true;   // snapped — caller resnaps the camera
  }
  _posFixX = x; _posFixY = y;
  return false;
}

function _applyPosCorrection(dt) {
  if (_posFixX === null || !player) return;
  // Exponential convergence, framerate-independent: at _POS_FIX_MS the
  // remaining error is ~5% of what it started as.
  const k = 1 - Math.exp(-(3000 / _POS_FIX_MS) * dt);
  const dx = _posFixX - player.x, dy = _posFixY - player.y;
  if (dx * dx + dy * dy < 1) {
    player.x = _posFixX; player.y = _posFixY;
    _posFixX = _posFixY = null;
    return;
  }
  player.x += dx * k; player.y += dy * k;
}

function clampCamera() {
  const visW = W / ZOOM, visH = _visH();
  camera.x = clamp(camera.x, 0, Math.max(0, dungeon.w * TILE - visW));
  camera.y = clamp(camera.y, 0, Math.max(0, dungeon.h * TILE - visH));
}

// True if a world point currently falls inside the player's own viewport —
// gates sfx (js/network.js) so combat/loot/boss sounds from elsewhere in the
// shared world stay silent unless the player can actually see them happen.
function _isPosVisible(x, y, margin = 80) {
  const sx = (x - _lastCamX) * ZOOM, sy = (y - _lastCamY) * ZOOM + HEADER_H;
  return sx >= -margin && sx <= W + margin && sy >= -margin && sy <= H + margin;
}

function updateCamera(dt) {
  const visW = W / ZOOM, visH = _visH();
  const tx = player.x - visW / 2;
  const ty = player.y - visH / 2;
  // A camera that is not a number cannot be decayed back into one: the offset
  // below is `camera.x - tx`, and NaN survives every arithmetic step and every
  // comparison in it. So one bad assignment used to last the whole session,
  // and the tile pass drew nothing for as long as it did.
  //
  // Snapping instead of decaying is right here on its own terms too: there is
  // no previous position to glide from, so there is nothing to smooth.
  if (!Number.isFinite(camera.x) || !Number.isFinite(camera.y)) {
    camera.x = tx; camera.y = ty;
    clampCamera();
    return;
  }
  // Nor can it be aimed at a target that is not a number. Both W/H and the
  // player are finite by the time anything calls this, but the world watchdog
  // exists because "should be" and "is" have come apart here before.
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) return;
  // Velocity-matched follow. A lerp toward the target trails the player by
  // speed/k while running, and frame-time noise makes that trail length
  // fluctuate — visible as the player wobbling ±1px on screen every uneven
  // frame. Instead, decay the camera→target OFFSET in error space: the
  // camera then moves 1:1 with the player at all times (zero relative
  // wobble), while a large offset (teleport, charge, respawn nearby) still
  // glides down smoothly. Once within a device pixel the offset snaps to 0.
  let ox = camera.x - tx, oy = camera.y - ty;
  const decay = Math.exp(-6 * dt);
  ox *= decay; oy *= decay;
  const _devPx = 1 / (ZOOM * DPR);
  if (Math.abs(ox) < _devPx) ox = 0;
  if (Math.abs(oy) < _devPx) oy = 0;
  camera.x = tx + ox;
  camera.y = ty + oy;
  clampCamera();
}

// Returns the room (from dungeon.rooms) that contains world-pixel point (wx,wy),
// or null if the point is in a corridor or no room data exists.
let _lastRoomHit = null;
function _getRoomAt(wx, wy) {
  if (!dungeon || !dungeon.rooms) return null;
  const tx = Math.floor(wx / TILE), ty = Math.floor(wy / TILE);
  // The world has ~470 rooms and this is called several times per frame, from
  // update() and from the HUD — but the answer almost never changes between
  // calls, because a player takes seconds to walk out of a room and most calls
  // in a frame are for the same point. Check last frame's answer first and the
  // scan below turns into two comparisons for all but the handful of frames
  // where the player actually crosses a boundary.
  const c = _lastRoomHit;
  if (c && tx >= c.x && tx < c.x + c.size && ty >= c.y && ty < c.y + c.size) return c;
  for (let i = 0; i < dungeon.rooms.length; i++) {
    const r = dungeon.rooms[i];
    if (!r.size) continue; // old-format rooms without size field
    if (tx >= r.x && tx < r.x + r.size && ty >= r.y && ty < r.y + r.size) { _lastRoomHit = r; return r; }
  }
  return null;
}

// ─────────────────────────────────────────────────────────
//  АВТО-НАВЫКИ (VIP 2)
// ─────────────────────────────────────────────────────────
// Rides the same АВТО toggle as auto-attack, and the same VIP requirement
// gating it (_checkAutoBtnTouch, js/input.js) — turning auto on with VIP 2
// now means "fight for me", skills included, rather than plain swinging.
//
// What it will NOT do is anything that moves the character: dashes, jumps and
// teleports are marked `auto:false` in SKILL_DEF and are left to the player.
// Firing those unattended throws you across the room, through a gate or out
// of a Страх hall, none of which the player asked for.
const AUTO_SKILL_VIP_MIN = 2;
// Spacing between two auto-casts. Without it every cooldown that came up in
// the same frame would be dumped at once, and each cast locks the attack
// animation for ~0.68s — the character would stand there casting instead of
// hitting anything.
const AUTO_SKILL_GAP = 1.2;
// Healing skills are wasted at (or near) full HP — they are on long
// cooldowns, so spending one for nothing is worse than waiting.
const AUTO_SKILL_HEAL_BELOW = 0.7;
let _autoSkillTimer = 0;

function _autoCastSkills(dt) {
  if (_autoSkillTimer > 0) _autoSkillTimer -= dt;
  if (!autoAttackMode || !player || state !== 'playing') return;
  // Элитная фарм-зона refuses AUTO entirely — forced off on entry and the
  // toggle itself is refused there (js/network.js's farm2Started handler,
  // js/input.js's _autoPressEnd), but this is checked again directly here
  // too rather than trusted solely from those two call sites.
  if (typeof _farm2InRun !== 'undefined' && _farm2InRun) return;
  // The player's own master switch (АВТО button, long press → the picker in
  // js/ui.js). Auto-ATTACK is unaffected: this turns off casting only, which
  // is the point — a player who wants the auto to keep hitting but stop
  // burning cooldowns had no way to say so.
  if (player.autoSkillsOn === false) return;
  // Re-checked here rather than trusted from when the toggle was flipped: the
  // mode persists across sessions and the VIP level can lapse.
  if ((window._vipData?.level || 0) < AUTO_SKILL_VIP_MIN) return;
  if (_autoSkillTimer > 0) return;
  if ((player.stunTimer || 0) > 0) return;
  if (typeof _dbFrozen === 'function' && _dbFrozen()) return;
  if (typeof _teleportCasting === 'function' && _teleportCasting()) return;
  // Never interrupt a swing or another cast that is already playing.
  if ((player.atkAnimTimer || 0) > 0) return;
  // Nor an approach. A cast locks atkAnimTimer for ~0.68s and the chase loop
  // only moves while that is clear, so casting mid-run would stutter the
  // character to a halt every time a cooldown came up.
  if (player._chasing) return;

  // Only in a fight. Without a live enemy nearby this would burn every
  // cooldown on empty corridors, so the buffs are never up when they matter.
  const tgt = (targetId && !targetIsPlayer)
    ? serverEnemiesMap.get(targetId)
    : null;
  const foe = (tgt && (tgt.hp || 0) > 0) ? tgt : nearestEnemy();
  if (!foe) return;
  // Roughly the chase radius — close enough that the fight is actually on.
  if (dist(foe.x, foe.y, player.x, player.y) > 420) return;

  const baseSkills = SKILL_DEF[player.type] || [];
  const hpFrac = player.maxHp > 0 ? (player.hp / player.maxHp) : 1;
  // Slots the player switched off in the picker. Keyed by slot (Q/W/E/R), so
  // it follows the slot rather than the variant — switching a slot to its
  // advanced version does not silently re-enable one that was turned off.
  const offSlots = player.autoSkillOff || {};
  const bonusTypes = (typeof SKILL_BONUS_TYPE !== 'undefined' && SKILL_BONUS_TYPE[player.type]) || {};
  for (let i = 0; i < baseSkills.length; i++) {
    // Resolved to whichever version (base/advanced) is actually active —
    // an advanced skill can flip a slot's auto-eligibility either way (see
    // ADV_SKILL_DEF, js/definitions.js), so this must match useSkill()'s own
    // resolution, not just the base skill's auto flag.
    const sk = (typeof _activeSkillDef === 'function') ? _activeSkillDef(player.type, i) : baseSkills[i];
    if (!sk) continue;
    if (sk.auto === false) continue;                       // dash / jump / teleport
    if (offSlots[sk.key]) continue;                        // switched off by the player
    if (_skillLvl(sk.key) <= 0) continue;                  // not learned
    if ((player.skillCooldowns[sk.key] || 0) > 0) continue;
    if (bonusTypes[sk.key] === 'heal' && hpFrac > AUTO_SKILL_HEAL_BELOW) continue;
    useSkill(i);
    _autoSkillTimer = AUTO_SKILL_GAP;
    return;                                                // one per gap
  }
}

// ─────────────────────────────────────────────────────────
//  UPDATE
// ─────────────────────────────────────────────────────────
function update(dt, realDt) {
  if (state !== 'playing') return;
  if (realDt == null) realDt = dt;
  frameCount++;
  if (transTimer > 0) { transTimer -= dt; return; }

  _applyPosCorrection(dt);

  {
    // Not gated to activeTab === 0 — target-chasing, auto-attack movement and
    // position sync must keep running while another bottom-nav tab (Inventory/
    // Map/Quests/etc.) is open, or the character just stands frozen (unable to
    // chase or reposition) while enemies out there keep fighting it. Manual
    // joystick input naturally can't reach inp.dx/dy while its touch target is
    // covered by another panel, so this only ever resumes real movement here
    // via the auto-chase path below.
    if (player.atkAnimTimer <= 0 && (player.stunTimer || 0) <= 0 && !_dbFrozen() &&
        !(typeof _teleportCasting === 'function' && _teleportCasting())) {
      const inp = inputDir();
      const _spdMult = (player.slowTimer || 0) > 0 ? 0.35 : 1;
      if (inp.len > 0) {
        player._chasing = false;
        // Manual joystick input cancels a manually-armed sustained attack
        // (autoAttackMode is a separate persistent toggle and stays as-is).
        _chaseArmed = false;
        // Speed depends only on player.speed (character stat), not on how
        // far the stick is pushed — inp.dx/dy are already a unit vector
        // (inputDir() normalizes them), so no inp.len factor here.
        const vx = inp.dx * player.speed * _spdMult * dt;
        const vy = inp.dy * player.speed * _spdMult * dt;
        if (canMoveX(player, vx, 12) && !_isGateBlocked(player.x + vx, player.y) && !_isRaceBarrierBlocked(player.x + vx, player.y) && !_isCoopBarrierBlocked(player.x + vx, player.y)) player.x += vx;
        if (canMoveY(player, vy, 12) && !_isGateBlocked(player.x, player.y + vy) && !_isRaceBarrierBlocked(player.x, player.y + vy) && !_isCoopBarrierBlocked(player.x, player.y + vy)) player.y += vy;
        // 8-way facing from joystick angle, with hysteresis: near a sector
        // boundary, tiny input jitter would otherwise flip facing (and
        // restart the run animation) every frame. The new angle must move
        // clearly past the current sector's edge before facing switches.
        player.facing = facing8FromDelta(inp.dx, inp.dy, player.facing);
      } else if (targetId && (autoAttackMode || _chaseArmed)) {
        // Chase locked target when no manual input — pressing attack on a
        // distant target (manual or auto-attack mode) closes the gap instead
        // of standing still and doing nothing. Merely selecting a target
        // (tap/cycle) does NOT arm this — only an actual attack-button press
        // does, via _chaseArmed.
        const _chEnt = targetIsPlayer ? otherPlayers.get(targetId) : serverEnemiesMap.get(targetId);
        if (_chEnt && (_chEnt.hp || 0) > 0) {
          const _cdx = _chEnt.x - player.x, _cdy = _chEnt.y - player.y;
          const _clen = Math.hypot(_cdx, _cdy);
          const _chR = targetIsPlayer ? 0 : ((_chEnt.size) || 0);
          if (_clen > (player.charDef.atkRange + _chR) * 0.85) {
            const nvx = (_cdx / _clen) * player.speed * _spdMult * dt;
            const nvy = (_cdy / _clen) * player.speed * _spdMult * dt;
            if (canMoveX(player, nvx, 12) && !_isGateBlocked(player.x + nvx, player.y) && !_isRaceBarrierBlocked(player.x + nvx, player.y) && !_isCoopBarrierBlocked(player.x + nvx, player.y)) player.x += nvx;
            if (canMoveY(player, nvy, 12) && !_isGateBlocked(player.x, player.y + nvy) && !_isRaceBarrierBlocked(player.x, player.y + nvy) && !_isCoopBarrierBlocked(player.x, player.y + nvy)) player.y += nvy;
            faceTowards(_chEnt.x, _chEnt.y);
            player._chasing = true;
          } else {
            // Just arrived in range — in manual mode atkTimer isn't ticked
            // down by time, so resolve the queued attack now instead of
            // waiting for another button press.
            if (player._chasing && !autoAttackMode) player.atkTimer = 0;
            player._chasing = false;
          }
        } else {
          player._chasing = false;
        }
      } else {
        player._chasing = false;
      }
    }

    // Entities (monsters, other players) no longer block or push the
    // player's movement — only wall/terrain collision (canMoveX/canMoveY)
    // constrains movement now.

    netSendMove();
  }

  if (player.hurtTimer > 0) player.hurtTimer -= dt;
  if (swingTimer > 0)       swingTimer -= dt;
  if (player.atkAnimTimer > 0) player.atkAnimTimer -= dt;

  // Cancel attack animation immediately if target already dead
  if (player.pendingAttack && !player.attackFired && player.atkAnimTimer > 0) {
    const _pa = player.pendingAttack;
    const _alive = _pa.isPlayer
      ? (otherPlayers.get(_pa.socketId)?.hp || 0) > 0
      : (serverEnemiesMap.get(_pa.id)?.hp || 0) > 0;
    if (!_alive) { player.atkAnimTimer = 0; player.pendingAttack = null; player.attackFired = false; }
  }
  if (partyInvitePending) {
    partyInvitePending.timer -= dt;
    if (partyInvitePending.timer <= 0) partyInvitePending = null;
  }
  // HP regen
  if ((player.hpRegen || 0) > 0 && player.hp < player.maxHp)
    player.hp = Math.min(player.maxHp, player.hp + player.hpRegen * dt);

  // Potion cooldown tick
  if ((player.potCd || 0) > 0) player.potCd = Math.max(0, player.potCd - realDt);

  // Buff timers tick — realDt, so a 10-minute potion lasts ten real minutes
  // instead of ten minutes of foreground animation frames.
  const _buffs = player.buffs || (player.buffs = {});
  let _buffChanged = false;
  for (const btype of Object.keys(_buffs)) {
    if (_buffs[btype] > 0) {
      _buffs[btype] -= realDt;
      if (_buffs[btype] <= 0) {
        _buffs[btype] = 0;
        _buffChanged = true;
      }
    }
  }
  if (_buffChanged) { recompute(); if (typeof updateInvUI === 'function') updateInvUI(); }

  // Auto-use buff potions — re-drink any type whose toggle is on the moment
  // its timer hits 0 (toggleAutoBuffPotion/_autoUseBuffPotionByType, js/player.js)
  const _autoBuffTypes = player.autoBuffTypes;
  if (_autoBuffTypes) {
    for (const bt of Object.keys(_autoBuffTypes)) {
      if (_autoBuffTypes[bt] && (_buffs[bt] || 0) <= 0) _autoUseBuffPotionByType(bt);
    }
  }

  // Auto-use HP potion
  const _autoPct = player.autoHpPct || 0;
  if (_autoPct > 0 && player.potCd <= 0 && player.hp < player.maxHp * _autoPct) {
    usePotion();
  }
  // Safe zone regen: +1 HP/sec; auto-disable PvP on entry
  if (inSafeZone(player.x, player.y)) {
    if (player.hp < player.maxHp) player.hp = Math.min(player.maxHp, player.hp + dt);
    if (pvpMode) {
      pvpMode = false;
      if (typeof netSetPvpMode === 'function') netSetPvpMode(false);
      if (targetIsPlayer) { targetId = null; targetIsPlayer = false; }
      dmgNum(player.x, player.y - 40, typeof t === 'function' ? t('pvpOffToast') : 'ПК режим выключен', '#edc174');
    }
  }

  _updateArmGates(dt);
  _updateRaceBarriers(dt);
  _updateCoopBarriers(dt);
  _updateTeleportPads(dt);

  // Advance sprite animation frame
  if (SPRITE_DEF[player.type]) {
    const ak = getSpriteAnimKey(player);
    if (ak !== player._lastAnimKey) { player._lastAnimKey = ak; player.animFrame = 0; player.animTimer = 0; }
    const ad = SPRITE_DEF[player.type].anims[ak];
    if (ad) {
      player.animTimer += dt;
      const maxF = ad.n;
      // Spread attack frames evenly across the full cast duration
      const step = (!ad.loop && player.atkAnimTimer > 0 && player.castDuration > 0)
        ? player.castDuration / maxF
        : 1 / ad.fps;
      while (player.animTimer >= step) {
        player.animTimer -= step;
        if (ad.loop) { player.animFrame = (player.animFrame + 1) % maxF; }
        else if (player.animFrame < maxF - 1) { player.animFrame++; }
      }
    }
  } else if (player.castDuration > 0 && player.atkAnimTimer > 0) {
    // No sprite sheet: advance animFrame proportionally so frame-8 gate still fires
    const elapsed = player.castDuration - player.atkAnimTimer;
    player.animFrame = Math.floor(elapsed / player.castDuration * 10);
  }

  // Fire pending attack on frame 8
  if (player.pendingAttack && !player.attackFired && player.animFrame >= 8) {
    const pa = player.pendingAttack;
    player.attackFired = true;
    const targetAlive = pa.isPlayer
      ? (otherPlayers.get(pa.socketId)?.hp || 0) > 0
      : (serverEnemiesMap.get(pa.id)?.hp || 0) > 0;
    if (targetAlive) {
      swingTimer = 0.18;
      if (typeof Sound !== 'undefined') Sound.hit();
      if (pa.isPlayer) {
        netPvpAttack(pa.socketId);
        if (player.charDef.atkType === 'ranged') {
          const _op = otherPlayers.get(pa.socketId);
          fireProj(_op?.x ?? pa.x, _op?.y ?? pa.y, null, pa.socketId);
        }
      } else {
        if (player.charDef.atkType === 'ranged') {
          // For ranged: fire projectile carrying enemyId; netAttack sent on visual hit
          const _e = serverEnemiesMap.get(pa.id);
          fireProj(_e?.x ?? pa.x, _e?.y ?? pa.y, pa.id);
        } else {
          netAttack(pa.id);
          // "Безумие" (advanced deathknight E) — while active, every basic
          // melee hit also splashes onto nearby enemies at 50% damage
          // (netAttack's splash flag — server/game/Room.js's attackEnemy is
          // what actually enforces the 50%, this client never sends a
          // damage number of its own).
          if (typeof madnessTimer !== 'undefined' && madnessTimer > 0 && player.type === 'deathknight') {
            const _te = serverEnemiesMap.get(pa.id);
            if (_te) {
              spawnAOE(_te.x, _te.y, 90, 'bloodwave', '#9c2a3a', '#d2495a');
              if (typeof netSpawnAoe === 'function') netSpawnAoe(_te.x, _te.y, 90, 'bloodwave', '#9c2a3a', '#d2495a');
              serverEnemies.forEach(e => {
                if ((e.hp || 0) <= 0 || e.id === pa.id) return;
                if (dist(e.x, e.y, _te.x, _te.y) < 90 && hasLOS(_te.x, _te.y, e.x, e.y)) netAttack(e.id, true);
              });
            }
          }
        }
      }
    }
  }
  if (player.atkAnimTimer <= 0) { player.pendingAttack = null; player.attackFired = false; }

  // Auto-attack, or a single manual attack-button press armed via
  // _chaseArmed — either way keep swinging on its own until the target dies
  // or the joystick cancels it (see inp.len > 0 below), instead of requiring
  // another tap per swing.
  if ((autoAttackMode || _chaseArmed) && (player.stunTimer || 0) <= 0) player.atkTimer -= dt;
  if (player.atkTimer <= 0 && (player.stunTimer || 0) <= 0 && !_dbFrozen() &&
      !(typeof _teleportCasting === 'function' && _teleportCasting())) {
    let closest = null, closestD = Infinity;
    let closestIsPlayer = false;

    // Prefer locked target
    if (targetId && !targetIsPlayer) {
      const t = serverEnemiesMap.get(targetId);
      if (t && (t.hp || 0) > 0) { closest = t; closestD = dist(t.x, t.y, player.x, player.y); }
    } else if (targetId && targetIsPlayer && pvpMode) {
      const op = otherPlayers.get(targetId);
      // A locked target can only have become an ally here via a stale lock
      // carried across a zone change (e.g. targeted in the open world, then
      // walked into Guild War) — the selection UI itself already refuses to
      // hand out an ally as targetId (see _a3Unselectable/_gwUnselectable,
      // js/input.js). Dropping to the fallback search below is simpler than
      // clearing targetId from every place that could invalidate it.
      if (op && (op.hp || 0) > 0 && op.x != null && !_a3Unselectable(targetId) && !_gwUnselectable(targetId)) {
        _pvpSentinel._socketId = targetId; _pvpSentinel.x = op.x; _pvpSentinel.y = op.y;
        closest = _pvpSentinel;
        closestD = dist(op.x, op.y, player.x, player.y);
        closestIsPlayer = true;
      }
    }

    // Fall back to nearest enemy using squared distance (avoids sqrt per candidate)
    if (!closest) {
      const _pRoom = _getRoomAt(player.x, player.y);
      let closestD2 = Infinity;
      serverEnemies.forEach(e => {
        // Own castle excluded the same reason the ally exclusion just below
        // exists for: the server refuses a hit on it either way ('own_tower',
        // Room.js), so AUTO mode locking onto it was just a wasted swing that
        // blocked a real target from being picked instead (see
        // _gwTowerUnselectable, js/input.js).
        if ((e.hp || 0) <= 0 || _gwTowerUnselectable(e)) return;
        // When player is inside a room, only target enemies in that same room
        if (_pRoom) {
          const etx = Math.floor(e.x / TILE), ety = Math.floor(e.y / TILE);
          if (etx < _pRoom.x || etx >= _pRoom.x + _pRoom.size ||
              ety < _pRoom.y || ety >= _pRoom.y + _pRoom.size) return;
        }
        const dx = e.x - player.x, dy = e.y - player.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < closestD2) { closestD2 = d2; closest = e; closestIsPlayer = false; }
      });
      if (pvpMode) {
        otherPlayers.forEach((op, id) => {
          // Unlike the locked-target branch above and the manual target-pick
          // UI (js/input.js), this proximity scan had no ally exclusion at
          // all — AUTO mode could lock onto and swing at your own 3v3
          // teammate or Guild War clanmate (server refuses the hit, so it
          // just wasted the swing and blocked a real target from being
          // picked instead).
          if ((op.hp || 0) <= 0 || op.x == null || _a3Unselectable(id) || _gwUnselectable(id)) return;
          const dx = op.x - player.x, dy = op.y - player.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < closestD2) { closestD2 = d2; _pvpSentinel._socketId = id; _pvpSentinel.x = op.x; _pvpSentinel.y = op.y; closest = _pvpSentinel; closestIsPlayer = true; }
        });
      }
      if (closest) closestD = Math.sqrt(closestD2);
    }

    // If locked target is in a different room, release it so chase stops
    if (targetId && !targetIsPlayer) {
      const _pRoom = _getRoomAt(player.x, player.y);
      if (_pRoom) {
        const _lt = serverEnemiesMap.get(targetId);
        if (_lt && (_lt.hp || 0) > 0) {
          const etx = Math.floor(_lt.x / TILE), ety = Math.floor(_lt.y / TILE);
          if (etx < _pRoom.x || etx >= _pRoom.x + _pRoom.size ||
              ety < _pRoom.y || ety >= _pRoom.y + _pRoom.size) {
            targetId = null; targetIsPlayer = false;
          }
        }
      }
    }

    // Range is measured to the target's CENTRE. For the size 13-22 regular
    // monsters that's indistinguishable from "distance to its body", but a
    // large enemy has to be approached *into* its own sprite before it counts
    // as in range — the size-165 event boss (631px across on screen) was
    // literally unhittable for a 58px-range melee class, and barely reachable
    // for ranged. Adding the target's radius makes range mean "to its edge".
    const _tgtR = closestIsPlayer ? 0 : ((closest && closest.size) || 0);
    const atkRange = player.charDef.atkRange * (closestIsPlayer ? 1.3 : 1) + _tgtR;
    if (!closest || closestD >= atkRange || !hasLOS(player.x, player.y, closest.x, closest.y)) {
      // Lock onto closest enemy so the chase system engages
      if (closest && !targetId) {
        targetId = closestIsPlayer ? closest._socketId : closest.id;
        targetIsPlayer = closestIsPlayer;
      }
      player.atkTimer = 0.15;
    } else {
      if (!targetId) {
        targetId = closestIsPlayer ? closest._socketId : closest.id;
        targetIsPlayer = closestIsPlayer;
      }
      const _as = player.atkSpeed || player.charDef.atkSpeed;
      player.atkTimer = 1 / _as;
      faceTowards(closest.x, closest.y);
      swingAngle = Math.atan2(closest.y - player.y, closest.x - player.x);
      const _animDur = Math.min(0.825, 1 / _as) / ATTACK_ANIM_SPEEDUP;
      player.atkAnimTimer = _animDur; player.castDuration = _animDur; player.animFrame = 0; player.animTimer = 0;
      player.pendingAttack = closestIsPlayer
        ? { isPlayer: true, socketId: closest._socketId, x: closest.x, y: closest.y }
        : { isPlayer: false, id: closest.id, x: closest.x, y: closest.y };
      player.attackFired = false;
    }
  }

  _autoCastSkills(dt);

  // Advance projectiles — visual only; server is authoritative for hit detection
  {
    let j = 0;
    for (let i = 0; i < projs.length; i++) {
      const p = projs[i];
      // Homing: steer toward the locked target's *current* position every frame
      // so a moving target can't dodge the projectile after it's been fired.
      if (p.isPlayer && (p.enemyId || p.pvpTargetId)) {
        let tgt = null;
        if (p.enemyId) {
          const e = serverEnemiesMap.get(p.enemyId);
          if (e && (e.hp || 0) > 0) tgt = e;
        } else {
          const op = otherPlayers.get(p.pvpTargetId);
          if (op && (op.hp || 0) > 0 && op.x != null) tgt = op;
        }
        if (tgt) {
          const tdx = tgt.x - p.x, tdy = tgt.y - p.y, tlen = Math.hypot(tdx, tdy);
          if (tlen > 0.01) {
            const spd = Math.hypot(p.vx, p.vy);
            p.vx = tdx / tlen * spd;
            p.vy = tdy / tlen * spd;
            p.angle = Math.atan2(p.vy, p.vx);
          }
        }
      }
      p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt;
      if (p.life <= 0 || isWall(p.x, p.y)) continue;
      // Cancel projectile early if its locked target is already dead
      if (p.enemyId && (serverEnemiesMap.get(p.enemyId)?.hp || 0) <= 0) continue;
      if (p.isPlayer) {
        const ps = p.size; let hit = false; let hitEnemy = null;
        for (let k = 0; k < serverEnemies.length; k++) {
          const e = serverEnemies[k];
          if ((e.hp || 0) <= 0) continue;
          const r = e.size + ps, ex = p.x - e.x, ey = p.y - e.y;
          if (ex * ex + ey * ey < r * r) { hit = true; hitEnemy = e; break; }
        }
        if (hit) {
          spawnBurst(p.x, p.y, p.color, 5);
          const _atkId = p.enemyId || hitEnemy?.id;
          if (_atkId) {
            netAttack(_atkId);
            // Optimistic feedback — no waiting for server round-trip
            const _he = serverEnemiesMap.get(_atkId);
            if (_he && _he.hp > 0) {
              _he.hurtTimer = 0.3; // instant hurt flash
              // Predict kill if last known damage would finish it
              if (_lastOwnDmg > 0 && _lastOwnDmg >= _he.hp) _he.hp = 0;
            }
          }
          continue;
        }
        if (pvpMode) {
          let _hitOpId = null;
          for (const [_opId, op] of otherPlayers) {
            if ((op.hp || 0) <= 0 || op.x == null) continue;
            const r = 18 + ps, ex = p.x - op.x, ey = p.y - op.y;
            if (ex * ex + ey * ey < r * r) { _hitOpId = _opId; break; }
          }
          if (_hitOpId) {
            if (p.pvpMult) netPvpSkillAttack(_hitOpId, p.pvpMult);
            spawnBurst(p.x, p.y, p.color, 5);
            continue;
          }
        }
      }
      projs[j++] = projs[i];
    }
    projs.length = j;
  }
  {
    let j = 0;
    for (let i = 0; i < otherProjs.length; i++) {
      const p = otherProjs[i];
      p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt;
      if (p.life <= 0 || isWall(p.x, p.y)) continue;
      const ps = p.size; let hit = false;
      for (let k = 0; k < serverEnemies.length; k++) {
        const e = serverEnemies[k];
        if ((e.hp || 0) <= 0) continue;
        const r = e.size + ps, ex = p.x - e.x, ey = p.y - e.y;
        if (ex * ex + ey * ey < r * r) { hit = true; break; }
      }
      if (hit) { spawnBurst(p.x, p.y, p.color, 5); continue; }
      if (player && state === 'playing') {
        const r = 14 + ps, ex = p.x - player.x, ey = p.y - player.y;
        if (ex * ex + ey * ey < r * r) { spawnBurst(p.x, p.y, p.color, 5); continue; }
      }
      otherProjs[j++] = otherProjs[i];
    }
    otherProjs.length = j;
  }

  {
    let j = 0;
    for (let i = 0; i < drops.length; i++) {
      const d = drops[i]; d.life -= dt;
      if (d.life <= 0) continue;
      const _ddx = d.x - player.x, _ddy = d.y - player.y;
      if (_ddx * _ddx + _ddy * _ddy < 900) { pickup(d); continue; }
      drops[j++] = drops[i];
    }
    drops.length = j;
  }

  // Event-boss ground loot: walking over a pile asks the server for it. The
  // server decides who actually gets it (first claim wins), so nothing is
  // added locally here — the worldDropPicked reply does that. Requests are
  // de-duplicated for 2s so standing on a contested pile doesn't emit every
  // frame while the answer is in flight.
  if (worldDrops.size && player && !_worldDropBagFull) {
    const _nowMs = Date.now();
    worldDrops.forEach(d => {
      const wdx = d.x - player.x, wdy = d.y - player.y;
      if (wdx * wdx + wdy * wdy > 900) return;
      if ((_worldDropPending.get(d.id) || 0) > _nowMs) return;
      _worldDropPending.set(d.id, _nowMs + 2000);
      netPickupWorldDrop(d.id);
    });
  }

  {
    let j = 0;
    for (let i = 0; i < aoeRings.length; i++) {
      aoeRings[i].life -= dt;
      if (aoeRings[i].life > 0) aoeRings[j++] = aoeRings[i];
    }
    aoeRings.length = j;
  }

  {
    let j = 0;
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i]; p.x += p.vx * dt; p.y += p.vy * dt; p.life -= dt;
      if (p.life > 0) particles[j++] = particles[i];
    }
    particles.length = Math.min(j, _qualityTier > 0 ? 60 : 200);
  }
  {
    let j = 0;
    for (let i = 0; i < dmgNums.length; i++) {
      const d = dmgNums[i]; d.y += d.vy * dt; d.life -= dt;
      if (d.life > 0) dmgNums[j++] = dmgNums[i];
    }
    dmgNums.length = Math.min(j, _qualityTier > 0 ? 14 : 28);
  }

  // Skill timers
  if (player.skillCooldowns) {
    const cds = player.skillCooldowns;
    if (cds.Q > 0) cds.Q -= realDt;
    if (cds.W > 0) cds.W -= realDt;
    if (cds.E > 0) cds.E -= realDt;
    if (cds.R > 0) cds.R -= realDt;
  }
  // Buffs, cooldowns and crowd control all run on realDt — see the realDt
  // comment in loop(). On dt they stopped advancing whenever the app was
  // backgrounded, so a buff cast right before a screen lock stayed active
  // (and kept boosting server-side damage) for as long as the player was away.
  if (barrierTimer > 0) { barrierTimer -= realDt; if (barrierTimer <= 0) { barrierTimer = 0; recompute(); } }
  if (battleCryTimer > 0) { battleCryTimer -= realDt; if (battleCryTimer <= 0) { battleCryTimer = 0; recompute(); } }
  if (dodgeTimer > 0) dodgeTimer -= realDt;
  if (atkSpeedTimer > 0) { atkSpeedTimer -= realDt; if (atkSpeedTimer <= 0) { atkSpeedTimer = 0; recompute(); } }
  if (faithShieldTimer > 0) { faithShieldTimer -= realDt; if (faithShieldTimer <= 0) { faithShieldTimer = 0; recompute(); } }
  if (guardTimer > 0) { guardTimer -= realDt; if (guardTimer <= 0) { guardTimer = 0; recompute(); } }
  if (vampirismTimer > 0) { vampirismTimer -= realDt; if (vampirismTimer <= 0) vampirismTimer = 0; }
  // Advanced-skill timers ("вторая профессия") — same realDt/recompute()
  // discipline as the base-skill timers above.
  if (advDkQAtkTimer  > 0) { advDkQAtkTimer  -= realDt; if (advDkQAtkTimer  <= 0) { advDkQAtkTimer  = 0; recompute(); } }
  if (critDmgBuffTimer > 0) { critDmgBuffTimer -= realDt; if (critDmgBuffTimer <= 0) { critDmgBuffTimer = 0; recompute(); } }
  if (madnessTimer > 0) { madnessTimer -= realDt; if (madnessTimer <= 0) { madnessTimer = 0; recompute(); } }
  if (critChanceBuffTimer > 0) { critChanceBuffTimer -= realDt; if (critChanceBuffTimer <= 0) { critChanceBuffTimer = 0; recompute(); } }
  if (levShieldAtkTimer > 0) { levShieldAtkTimer -= realDt; if (levShieldAtkTimer <= 0) { levShieldAtkTimer = 0; recompute(); } }
  // Бабочки (adv warlock Q) — periodic 1s self-heal tick while active, not
  // just a flat stat multiplier, so it's driven here instead of recompute().
  if (butterfliesTimer > 0) {
    butterfliesTimer -= realDt;
    _butterfliesTickAcc += realDt;
    while (_butterfliesTickAcc >= 1 && player) {
      _butterfliesTickAcc -= 1;
      const heal = Math.round(player.maxHp * 0.05);
      player.hp = Math.min(player.maxHp, player.hp + heal);
      dmgNum(player.x, player.y - 30, '+' + heal + '♥', '#a855e0');
    }
    if (butterfliesTimer <= 0) { butterfliesTimer = 0; _butterfliesTickAcc = 0; }
  }
  if (invisTimer > 0) { invisTimer -= realDt; if (invisTimer <= 0) { invisTimer = 0; if (typeof netPlayerInvis === 'function') netPlayerInvis(false); } }
  if ((player.stunTimer || 0) > 0) { player.stunTimer -= realDt; if (player.stunTimer <= 0) player.stunTimer = 0; }
  if ((player.slowTimer || 0) > 0) { player.slowTimer -= realDt; if (player.slowTimer <= 0) player.slowTimer = 0; }
  if (skillFlash) { skillFlash.timer -= dt; if (skillFlash.timer <= 0) skillFlash = null; }
  if (typeof tickQuestNotif === 'function') tickQuestNotif(dt);

  // Clear stale target — also disarms a manually-armed sustained attack so
  // it doesn't silently latch onto the next-nearest enemy once this one dies;
  // a fresh attack-button press (or autoAttackMode) is needed to keep going.
  if (targetId) {
    if (targetIsPlayer) {
      const op = otherPlayers.get(targetId);
      if (!op || (op.hp || 0) <= 0) { targetId = null; targetIsPlayer = false; _chaseArmed = false; }
    } else {
      const te = serverEnemiesMap.get(targetId);
      if (!te || (te.hp || 0) <= 0) { targetId = null; targetIsPlayer = false; _chaseArmed = false; }
    }
  }

  // NPC proximity — hysteresis (enter at 65px, only drop past 80px) so
  // standing right at the boundary doesn't flicker the chat-bubble icon and
  // "Поговорить" button on and off every frame from sub-pixel position noise
  // (diagonal-move rounding, wall-collision nudges) tipping the comparison
  // back and forth around a single hard threshold.
  if (nearNpc && dist(player.x, player.y, nearNpc.x, nearNpc.y) > 80) nearNpc = null;
  if (!nearNpc) {
    npcs.forEach(n => { if (dist(player.x, player.y, n.x, n.y) < 65) nearNpc = n; });
  }
  // Hidden while the chat panel is open: the button now draws above the chat
  // layer (css/style.css #npc-talk-btn) so a chat preview bubble can't cover
  // it, and the open panel's own input sits in exactly this strip — without
  // this it would land on top of the text field.
  const _chatOpenNow = document.getElementById('chat-panel')?.classList.contains('open');
  if (_talkBtn) _talkBtn.style.display = (nearNpc && activeTab === 0 && !_chatOpenNow) ? 'block' : 'none';

  // Snapshot interpolation — render others at (serverNow - interpolation
  // delay). Between two known positions this is exact and perfectly linear:
  // no prediction, so no prediction error to correct. netClockNow() is
  // monotonic by construction; netInterpMs() is sized from the link's
  // measured needs — see both in js/network.js.
  const _clkNow = netClockNow();
  let _renderT = _clkNow > 0 ? _clkNow - netInterpMs() : 0;
  // Playback must never run backward — an interpolation buffer growing
  // faster than the render clock advances (both are independently
  // rate-limited; see netInterpMs) can, in rare overlap, still let
  // (clock - delay) dip below its own last value by a fraction of a
  // millisecond. netClockNow()'s own monotonicity guarantee is about the
  // clock alone, not about clock-minus-a-separately-growing-delay, so this
  // needs its own hard floor rather than inheriting one. Cheap, and it's the
  // difference between "provably can't happen" and "practically doesn't."
  if (_renderT > 0 && _renderT < _lastRenderT) _renderT = _lastRenderT;
  if (_renderT > 0) _lastRenderT = _renderT;
  // Whether anyone is actually in motion this frame. The interpolation buffer
  // is only sized against frames where this is true — an idle world tells us
  // nothing about whether the buffer is big enough, and counting it would
  // read a full second of silence between idle heartbeats as an unbounded
  // deficit. See netMarginTick (js/network.js).
  let _anyMoving = false;
  otherPlayers.forEach((op, id) => {
    if (op.moving && (op.hp || 0) > 0) _anyMoving = true;
    const buf = op._buf;
    // op.moving is authoritative — set directly from the sender's own input
    // state on packet arrival (see js/network.js), not derived here from
    // position deltas. Position is still smoothed for the eye below; the
    // animation key no longer rides along with it.
    if (buf && buf.length >= 2 && _renderT > 0) {
      // Walk back to find the two snapshots that bracket _renderT
      let i = buf.length - 2;
      while (i > 0 && buf[i].t > _renderT) i--;
      const s0 = buf[i], s1 = buf[i + 1];
      const span = s1.t - s0.t;
      if (span < 1) {
        op.x = s1.x; op.y = s1.y;
      } else if (_renderT <= s1.t) {
        const a = Math.max(0, (_renderT - s0.t) / span);
        op.x = s0.x + (s1.x - s0.x) * a;
        op.y = s0.y + (s1.y - s0.y) * a;
      } else {
        // ── Buffer starved: extrapolate ────────────────────────────────────
        // Playback has caught up with the newest snapshot. This is NOT an
        // exceptional case here: the server sends this stream volatile (see
        // Room.js), i.e. it deliberately DROPS casts rather than queue them on
        // a backed-up link, so a gap is the normal cost of not being stalled.
        //
        // Clamping to s1 (what this used to do) freezes the avatar in place
        // and then teleports it when the next packet lands — the single most
        // visible form of the stutter. Carrying the last known velocity
        // forward instead keeps the motion continuous, and the next snapshot
        // resumes exact interpolation from wherever it really is.
        //
        // Three guards, all of them load-bearing:
        //
        //  - op.moving is the sender's own authoritative input state, not
        //    something inferred from these very positions, so a player who has
        //    stopped never drifts no matter what the buffer does.
        //  - only for _EXTRAP_MAX_MS. Past that the link is not jittering, it
        //    is gone, and dead reckoning someone across the map is worse than
        //    leaving them where they were last seen.
        //  - only off a RECENT pair. A stationary player re-states their
        //    position once a second (_MOVE_KEEPALIVE_MS, js/network.js), so
        //    the moment they start walking the newest pair can still span a
        //    full second — dividing a real step by 1000ms yields a velocity
        //    several times too slow, which would read as the player wading.
        //    Anything wider than a few packet intervals is not a velocity
        //    measurement, so it isn't treated as one.
        const ex = Math.min(_renderT - s1.t, _EXTRAP_MAX_MS);
        if (op.moving && ex > 0 && span <= _EXTRAP_MAX_SPAN_MS) {
          // Clamped to the fastest anything on foot can go, so a pair that
          // straddles a teleport can't fling the sprite off screen before the
          // next packet corrects it.
          let vx = (s1.x - s0.x) / span, vy = (s1.y - s0.y) / span;
          const v = Math.hypot(vx, vy);
          if (v > _EXTRAP_MAX_V) { vx = vx / v * _EXTRAP_MAX_V; vy = vy / v * _EXTRAP_MAX_V; }
          op.x = s1.x + vx * ex;
          op.y = s1.y + vy * ex;
        } else {
          op.x = s1.x; op.y = s1.y;
        }
        _netStarvedFrames++;
      }
    } else if (op.targetX !== undefined) {
      // Fallback: exponential lerp — framerate-independent at any FPS
      const _lf = 1 - Math.exp(-15 * dt);
      op.x += (op.targetX - op.x) * _lf;
      op.y += (op.targetY - op.y) * _lf;
    }
    if ((op.hurtTimer || 0) > 0) op.hurtTimer -= dt;
    if ((op.atkAnimTimer || 0) > 0) op.atkAnimTimer -= dt;
    if ((op._swingTimer || 0) > 0) op._swingTimer -= dt;
    if ((op.stunTimer || 0) > 0) op.stunTimer -= dt;
    if ((op.slowTimer || 0) > 0) op.slowTimer -= dt;
    if (op.type && SPRITE_DEF[op.type]) {
      if (op.animFrame === undefined) { op.animFrame = 0; op.animTimer = 0; }
      const ak = getOtherPlayerAnimKey(op);
      if (ak !== op._prevAnimKey) { op.animFrame = 0; op.animTimer = 0; op._prevAnimKey = ak; }
      const ad = SPRITE_DEF[op.type].anims[ak];
      if (ad) {
        op.animTimer = (op.animTimer || 0) + dt;
        const maxF = ad.n;
        // Same as the local player (see update()): spread attack frames
        // evenly across the (already speed-adjusted) cast duration instead
        // of the sprite's own fps, so a shorter castDuration actually plays
        // the swing faster instead of just cutting it off early.
        const step = (!ad.loop && (op.atkAnimTimer || 0) > 0 && op.castDuration > 0)
          ? op.castDuration / maxF
          : 1 / ad.fps;
        while (op.animTimer >= step) {
          op.animTimer -= step;
          if (ad.loop) { op.animFrame = (op.animFrame + 1) % maxF; }
          else if (op.animFrame < maxF - 1) { op.animFrame++; }
        }
      }
    }
  });
  // After the loop, so it sees this frame's motion state.
  netMarginTick(_anyMoving);
  let _corpseExpired = false;
  serverEnemies.forEach(e => {
    // Corpse cleanup must run regardless of distance (a far corpse would
    // otherwise never expire and pile up in the array forever).
    if (e._deathTimer !== undefined && (e._deathTimer -= dt) <= 0) _corpseExpired = true;
    if (e.hp <= 0) return;

    // Skip everything else — cosmetic timers AND full AI — for enemies
    // outside local AOI. An open world can hold ~600 enemies at once; ticking
    // 5 status timers on every single one every frame, most of them far
    // off-screen and invisible anyway, adds up for no visible benefit. The
    // server corrects position/hp/status the moment one re-enters range.
    const _epdx = player.x - e.x, _epdy = player.y - e.y;
    const _epd2 = _epdx * _epdx + _epdy * _epdy;
    if (_epd2 > _ENEMY_SIM_R2) {
      // ...but the server's position is still the truth out here, and simply
      // returning is what left a monster standing where it was last drawn
      // while the server walked the real one somewhere else entirely.
      //
      // Three radii disagreed: this gate at 1100, the server's stream at
      // ENEMY_AOI_R (1400), and the client's own prune at ENEMY_AOI_R + 600.
      // Inside the band between the first two the client kept updating
      // targetX/targetY and never applied them, so it drew a ghost — you could
      // be hit by something the server had standing on top of you while your
      // screen showed it a screen away, and the moment you crossed 1100 the
      // correction hauled it a thousand pixels in three frames. Both halves of
      // "урон получаєш, коли біля них не стоїш" and "потім вони тепнуться".
      //
      // Bosses were worse: they stream from ANY distance and are exempt from
      // the prune, so a boss's drawn position could be arbitrarily old.
      //
      // Snapped rather than interpolated, deliberately. Nobody is looking at
      // these; smoothing them would cost the CPU this gate exists to save, and
      // arriving already correct is what stops the lurch on the way back in.
      if (e.targetX !== undefined) { e.x = e.targetX; e.y = e.targetY; }
      return;
    }

    if ((e.hurtTimer || 0) > 0) e.hurtTimer -= dt;
    if ((e.atkAnimTimer || 0) > 0) e.atkAnimTimer -= dt;
    if ((e._moveTimer || 0) > 0) e._moveTimer -= dt;
    if ((e._srvMoving || 0) > 0) e._srvMoving -= dt;
    if ((e.stunTimer || 0) > 0) e.stunTimer -= dt;
    if ((e.slowTimer || 0) > 0) e.slowTimer -= dt;

    // Find closest player — squared dist avoids sqrts in comparison loop
    let closestD2 = _epd2, closestTgt = player;
    otherPlayers.forEach(op => {
      if ((op.hp || 0) <= 0 || op.x == null) return;
      const ddx = op.x - e.x, ddy = op.y - e.y;
      const d2 = ddx * ddx + ddy * ddy;
      if (d2 < closestD2) { closestD2 = d2; closestTgt = op; }
    });
    const dp = Math.sqrt(closestD2); // single sqrt per in-AOI enemy

    const aggroR = e.aggroR || 175;
    const spd    = e.spd    || 70;
    const sz     = e.size   || 16;

    // ── aggro is the SERVER's answer, not a guess ────────────────────────
    // This used to decide for itself: distance plus line of sight, meant to
    // mirror the server's own test. It cannot mirror it, because the server
    // knows things this side is never told.
    //
    // The elite farm zone is the clearest case. Its monsters deliberately do
    // NOT wake on proximity — a pack wakes together when one of them is hit
    // (_wakePack, Room.js) — and nothing on the wire says which enemies those
    // are. So walking up to one lit it up here as awake while the server kept
    // it asleep: it stood there "reacting" and did nothing, and the moment it
    // was actually hit the server's real position and state arrived at once
    // and it lurched. "Не реагує на мене, потім по ньому стріляю, а він
    // тепнеться до мене" — both halves of that, from one guess.
    //
    // Nothing is lost by deleting it. `aggro` arrives in every delta, and an
    // aggro'd enemy is re-sent every cast precisely so this side stays
    // reconciled. The two places that read it — the chase below and the walk
    // animation (pixi-world.js) — are both gated on _srvMoving/_moveTimer
    // anyway, which only a server packet ever sets.
    //
    // The de-aggro line went with it, for the same reason: the leash is the
    // server's rule, measured from a spawn point that is not sent over the
    // wire at all.

    if ((e.stunTimer || 0) > 0) {
      if (e.targetX !== undefined) {
        const cedx = e.targetX - e.x, cedy = e.targetY - e.y;
        const err2 = cedx * cedx + cedy * cedy;
        if (err2 > 100) { const k = 1 - Math.exp(-2.5 * dt); e.x += cedx * k; e.y += cedy * k; }
      }
      return;
    }
    // Only ever smooth out a walk the server is already performing (see
    // _srvMoving, js/network.js) — never start one on our own. The server
    // holds enemies still for several reasons this side knows nothing about:
    // the 420px leash back to their spawn point (spawnX isn't even sent over
    // the wire), players standing in a safe zone, a lost line of sight. When
    // that happened, this branch kept walking the enemy toward the player
    // anyway and the position correction below kept hauling it back — so it
    // wandered in a circle, permanently "running" without ever arriving.
    if (e.aggro && (e._srvMoving || 0) > 0 && dp > sz + 14) {
      const nx = (closestTgt.x - e.x) / dp;
      const ny = (closestTgt.y - e.y) / dp;
      if (Math.abs(nx) >= Math.abs(ny)) e._facing = nx > 0 ? 'right' : 'left';
      else                              e._facing = ny > 0 ? 'down'  : 'up';
      const er  = sz * 0.55;
      const spdMult = (e.slowTimer || 0) > 0 ? 0.35 : 1;
      const evx = nx * spd * spdMult * dt;
      const evy = ny * spd * spdMult * dt;
      const _px = e.x, _py = e.y;
      if (canMoveX(e, evx, er)) e.x += evx;
      if (canMoveY(e, evy, er)) e.y += evy;
      // Only claim to be walking if we actually got somewhere. _moveTimer is
      // what selects the walk animation (see _updateEnemyObj, pixi-world.js),
      // and setting it unconditionally here meant an enemy wedged against
      // geometry — both axes refused by canMoveX/canMoveY — ran on the spot
      // forever instead of standing idle.
      if (e.x !== _px || e.y !== _py) e._moveTimer = 0.2;
    }

    // Server correction — squared fast-reject avoids sqrt when error < 10px.
    // Exponential (frame-rate independent) pull: constant-time correction
    // whether the device runs at 30 or 60fps, so no visible speed-up jerks.
    if (e.targetX !== undefined) {
      const cedx = e.targetX - e.x, cedy = e.targetY - e.y;
      const err2 = cedx * cedx + cedy * cedy;
      if (err2 > 100) {
        const k = 1 - Math.exp(-(err2 > 150 * 150 ? 13 : 2.5) * dt);
        e.x += cedx * k; e.y += cedy * k;
      }
    }
  });
  if (_corpseExpired) {
    let j = 0;
    for (let i = 0; i < serverEnemies.length; i++) {
      const e = serverEnemies[i];
      if (e._deathTimer !== undefined && e._deathTimer <= 0) {
        serverEnemiesMap.delete(e.id);
        if (typeof pixiRemoveEnemy === 'function') pixiRemoveEnemy(e.id);
        continue;
      }
      serverEnemies[j++] = e;
    }
    serverEnemies.length = j;
  }

  updateCamera(dt);
}

// ─────────────────────────────────────────────────────────
//  RENDER
// ─────────────────────────────────────────────────────────

// Renders `text` (black 3px stroke + colored fill, matching the name-tag
// style used below) once into a small offscreen canvas at devicePixelRatio
// resolution — profiling a busy scene (60 enemies, 15 other players) found
// this per-player strokeText+fillText pair was the single heaviest
// per-frame cost after the already-cached HUD panel (_renderUI, 15fps):
// shaping+rasterizing a stroked glyph run every frame for every visible
// name adds up fast, while the text/color themselves rarely change frame
// to frame — only the on-screen POSITION does (it follows the camera).
// _drawNameBitmap below just blits this at the current position instead.
function _buildNameBitmap(text, color, fontPx, px) {
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = `bold ${fontPx * px}px system-ui, Arial`;
  const tw = probe.measureText(text).width;
  const padX = 4 * px, padTop = fontPx * px * 0.4, padBottom = 4 * px;
  const cv = document.createElement('canvas');
  cv.width  = Math.max(1, Math.ceil(tw + padX * 2));
  cv.height = Math.max(1, Math.ceil(fontPx * px + padTop + padBottom));
  const c = cv.getContext('2d');
  c.font = `bold ${fontPx * px}px system-ui, Arial`;
  c.textAlign = 'center'; c.textBaseline = 'alphabetic';
  c.lineWidth = 3 * px; c.strokeStyle = '#000000';
  const bx = cv.width / 2, by = cv.height - padBottom;
  c.strokeText(text, bx, by);
  c.fillStyle = color;
  c.fillText(text, bx, by);
  cv._tw = tw; cv._baseX = bx; cv._baseY = by; cv._px = px;
  return cv;
}
// Blits a bitmap built by _buildNameBitmap centered horizontally on sx, with
// its text baseline at sy — same anchoring strokeText/fillText(text,sx,sy)
// with textAlign='center'/textBaseline='alphabetic' used to give directly.
// Returns the CSS-px text width (callers use it to place e.g. the PvP icon).
function _drawNameBitmap(cv, sx, sy) {
  const px = cv._px;
  const dw = cv.width / px, dh = cv.height / px;
  ctx.drawImage(cv, sx - dw / 2, sy - cv._baseY / px, dw, dh);
  return cv._tw / px;
}

// Same idea as _buildNameBitmap/_drawNameBitmap, but for the clan-tag text
// next to a name — that one uses textAlign='left'/textBaseline='middle'
// (anchored after the clan icon, not centered on the player), so it needs
// its own pair rather than reusing the name one. Anchoring works the same
// way: build with the exact alignment the old direct strokeText/fillText
// call used, at a known offset inside the small canvas, then place that
// same offset at the caller's (x, yMid) when blitting.
function _buildClanTagBitmap(text, color, fontPx, px) {
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = `bold ${fontPx * px}px system-ui, Arial`;
  const tw = probe.measureText(text).width;
  const padL = 2 * px, padR = 3 * px, padV = fontPx * px * 0.8;
  const cv = document.createElement('canvas');
  cv.width  = Math.max(1, Math.ceil(tw + padL + padR));
  cv.height = Math.max(1, Math.ceil(padV * 2));
  const c = cv.getContext('2d');
  c.font = `bold ${fontPx * px}px system-ui, Arial`;
  c.textAlign = 'left'; c.textBaseline = 'middle';
  c.lineWidth = 2.5 * px; c.strokeStyle = '#000000';
  const ax = padL, ay = cv.height / 2;
  c.strokeText(text, ax, ay);
  c.fillStyle = color;
  c.fillText(text, ax, ay);
  cv._tw = tw; cv._anchorX = ax; cv._anchorY = ay; cv._px = px;
  return cv;
}
function _drawClanTagBitmap(cv, x, yMid) {
  const px = cv._px;
  const dw = cv.width / px, dh = cv.height / px;
  ctx.drawImage(cv, x - cv._anchorX / px, yMid - cv._anchorY / px, dw, dh);
}

function _drawPlayerNameOnUI() {
  const barTop = _lastPlayerUsedSprite ? player.y - 39 : player.y - 28;
  const nameY = barTop - 4;
  const sx = (player.x - _lastCamX) * ZOOM;
  const sy = (nameY - _lastCamY) * ZOOM + HEADER_H;
  const displayName = (netUsername || player.charDef.name).slice(0, 16);

  const nameColor = pvpMode ? '#f28a96' : '#edc174';
  const namePx = Math.ceil(DPR);
  const nameKey = displayName + '|' + nameColor + '|' + namePx;
  if (nameKey !== _prevNameKey) { _nameBitmap = _buildNameBitmap(displayName, nameColor, 10, namePx); _prevNameKey = nameKey; }
  const tw = _nameBitmap._tw / namePx;

  // Clan tag: icon (pre-rendered, 1 drawImage) + name. Both cached to avoid per-frame cost.
  if (typeof clanData !== 'undefined' && clanData && clanData.name) {
    const iconKey = String(clanData.icon || 1);
    if (!_clanIconCv || _clanIconKey !== iconKey) {
      // Build once per clan icon change (256 fillRects happens only here)
      _clanIconKey = iconKey;
      const px = Math.ceil(DPR);
      _clanIconCv = document.createElement('canvas');
      _clanIconCv.width = 16 * px; _clanIconCv.height = 16 * px;
      drawClanIconOnCtx(_clanIconCv.getContext('2d'), clanData.icon || 1, 8 * px, 8 * px, px);
    }
    const clanTagPx = Math.ceil(DPR);
    const clanTagKey = clanData.name + '|' + clanTagPx;
    if (clanTagKey !== _prevClanTagKey) { _clanTagBitmap = _buildClanTagBitmap(clanData.name, '#eaa742', 9, clanTagPx); _prevClanTagKey = clanTagKey; }
    const clanTw = _clanTagBitmap._tw / clanTagPx;
    const iconDisp = 14, gap = 3;
    // Not rounded to whole pixels: sx/sy (and the name text below) move
    // continuously as the player moves, so rounding just this element made
    // it step pixel-by-pixel out of sync with everything around it — the
    // clan tag visibly lagged/jittered relative to the name during movement.
    const lineX = sx - (iconDisp + gap + clanTw) / 2;
    const lineY = sy - 16;
    ctx.drawImage(_clanIconCv, lineX, lineY - iconDisp / 2, iconDisp, iconDisp);
    _drawClanTagBitmap(_clanTagBitmap, lineX + iconDisp + gap, lineY);
  }

  _drawNameBitmap(_nameBitmap, sx, sy);
  if (pvpMode) drawIconCtx(_uiCtx, 'pvpOn', sx + tw / 2 + 8, sy - 3, 9, '#ed5a6b');
}

// Other players can show several distinct clans on screen at once, so unlike
// the single-slot cache above this is keyed by icon id (+ DPR, in case it
// changes on resize). Still just a handful of small canvases in the worst case.
const _otherClanIconCv = new Map();
function _getOtherClanIconCv(iconId) {
  const px = Math.ceil(DPR);
  const key = (iconId || 1) + '@' + px;
  let cv = _otherClanIconCv.get(key);
  if (cv) return cv;
  cv = document.createElement('canvas');
  cv.width = 16 * px; cv.height = 16 * px;
  drawClanIconOnCtx(cv.getContext('2d'), iconId || 1, 8 * px, 8 * px, px);
  _otherClanIconCv.set(key, cv);
  return cv;
}

// Other players' username + clan tag, drawn on the 2D overlay at native
// screen resolution every frame — mirrors _drawPlayerNameOnUI above so
// remote players read exactly as crisp and jitter-free as the local player,
// instead of the blurry/wobbly look a WebGL-scaled PIXI.Text gave them
// (see pixi-world.js _getOtherPlayer). p._nameBarTop is written each frame
// by _updateOtherPlayers right before this runs.
// During a 3v3 the one thing that has to be readable at a glance is which
// side someone is on. The server already refuses friendly fire; this is what
// makes that visible instead of players discovering it by swinging at a
// teammate. Returns null outside a match, so normal play is untouched.
function _a3NameColor(id) {
  if (typeof _a3Team === 'undefined' || !_a3Team) return null;
  const mine = (_a3Mates[_a3Team] || []).includes(id);
  if (mine) return '#6fc7ff';
  const other = _a3Team === 'A' ? 'B' : 'A';
  return (_a3Mates[other] || []).includes(id) ? '#ff6b6b' : null;
}

function _drawOtherPlayerNamesOnUI() {
  if (!otherPlayers.size) return;
  otherPlayers.forEach((p, _pid) => {
    if (p.x == null || isNaN(p.x) || !_isOnScreen(p.x, p.y)) return;
    const barTop = p._nameBarTop ?? -20;
    const nameY  = p.y + barTop - 3;
    const sx = (p.x - _lastCamX) * ZOOM;
    const sy = (nameY - _lastCamY) * ZOOM + HEADER_H;
    const uname = (p.username || '?').slice(0, 16);
    const unameColor = _a3NameColor(_pid) || (p.pvpMode ? '#f28a96' : '#d1ccc5');
    const unamePx = Math.ceil(DPR);
    const unameKey = uname + '|' + unameColor + '|' + unamePx;
    if (unameKey !== p._nameKey) { p._nameBitmap = _buildNameBitmap(uname, unameColor, 10, unamePx); p._nameKey = unameKey; }

    const cname = p.clanName || '';
    if (cname) {
      const clanTagPx = Math.ceil(DPR);
      const clanTagKey = cname + '|' + clanTagPx;
      if (clanTagKey !== p._clanTagKey) { p._clanTagBitmap = _buildClanTagBitmap(cname, '#eaa742', 9, clanTagPx); p._clanTagKey = clanTagKey; }
      const clanTw = p._clanTagBitmap._tw / clanTagPx;
      const iconDisp = 14, gap = 3;
      // Not rounded — see the matching comment in _drawPlayerNameOnUI.
      const lineX = sx - (iconDisp + gap + clanTw) / 2;
      const lineY = sy - 16;
      ctx.drawImage(_getOtherClanIconCv(p.clanIcon || 1), lineX, lineY - iconDisp / 2, iconDisp, iconDisp);
      _drawClanTagBitmap(p._clanTagBitmap, lineX + iconDisp + gap, lineY);
    }

    _drawNameBitmap(p._nameBitmap, sx, sy);
  });
}

// Render all HUD/UI elements to the overlay canvas (called every frame from render())
function _renderUI() {
  if (!_uiCtx) return;
  drawHeader();
  if (typeof drawQuestNotif === 'function') drawQuestNotif();
  drawPvpButton();
  drawProfessionButton();
  drawStarterBonusButton();
  drawBuffStrip();
  drawPartyButton();
  drawPartyHUD();
  drawTargetFrame();
  if (activeTab === 0) {
    // Порядок из гайда к комплекту: иконки умений → веер → атака →
    // переключатель режима. Веер рисуется ПОВЕРХ иконок, чтобы золотая
    // окантовка гнезда осталась сверху и отверстие читалось вырезанным
    // в металле, а не заклеенным.
    drawSkillButtons();
    drawSkillFan();
    drawPotionButton();
    drawTargetButton();
    drawAttackButton();
    drawAutoToggle();
  }
  drawPartyInvitePopup();
  if (state === 'dead') drawDead();
}


// Cached per-frame view bounds — updated once at the top of render(), read by _isOnScreen
let _vL = 0, _vR = 0, _vT = 0, _vB = 0;
let _nowMs = 0;
function render(dt, ts) {
  _nowMs = ts;
  // Вторая линия к тому же: resize выше больше не пропустит ноль, но до
  // ПЕРВОГО resize размера ещё нет ни у кого, а loop уже крутится. Рисовать
  // в никуда нечем и незачем — и именно отсюда прилетали 'arc: radius -1' и
  // 'drawImage: width or height of 0'.
  if (!(W > 0) || !(H > 0)) return;

  // When a full-screen menu panel (inventory/map/quests/clans/profile) is open,
  // an opaque panel covers the whole viewport above the bottom nav — the PixiJS
  // world and the 2D HUD are completely hidden, so re-rendering them every frame
  // is wasted GPU/CPU/battery on mobile. Skip both once the open-panel slide-in
  // has finished (the grace window keeps drawing during the CSS transition); the
  // last frame stays on the hidden canvas and is revealed intact on close.
  if (state === 'playing' && activeTab !== 0 && ts >= _menuGraceUntil) return;

  const _camX = _lastCamX = camera.x;
  const _camY = _lastCamY = camera.y;
  const _vM = 60;
  _vL = _camX - _vM; _vR = _camX + W / ZOOM + _vM;
  _vT = _camY - _vM; _vB = _camY + (H - HEADER_H) / ZOOM + _vM;

  const theme = (state === 'playing' || state === 'dead') && dungeon ? getTheme(dungeonLvl) : null;

  // ── PixiJS world ─────────────────────────────────────────
  if (state !== 'select') {
    // Queued BEFORE the world renders, so pads and barriers land in the same
    // frame as everything else instead of one behind.
    _buildDecals(ts);
    pixiWorldRender(dt, ts, _camX, _camY, theme);
  } else {
    pixiSetBg('#0f0c07');
    pixiClearWorld();
  }

  // ── UI canvas — cleared every frame so layers don't accumulate ──────────────
  _uiCtx.clearRect(0, 0, _uiOverlay.width, _uiOverlay.height);
  _uiCtx.setTransform(DPR, 0, 0, DPR, 0, 0);

  // HUD panels: rebuild cache at 15fps, blit every frame (cheap drawImage)
  if (ts - _uiLastMs >= 67) {
    _uiLastMs = ts;
    if (!_hudCv || _hudCv.width !== _uiOverlay.width || _hudCv.height !== _uiOverlay.height) {
      _hudCv = document.createElement('canvas');
      _hudCv.width = _uiOverlay.width;
      _hudCv.height = _uiOverlay.height;
      _hudCvCtx = _hudCv.getContext('2d');
    }
    _hudCvCtx.clearRect(0, 0, _hudCv.width, _hudCv.height);
    _hudCvCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const _prevCtx = ctx; ctx = _hudCvCtx;
    _renderUI();
    ctx = _prevCtx;
  }
  // ── подписи мира идут ПЕРВЫМИ, HUD ложится поверх ──────────────────────
  // Имена игроков, названия залов, «Телепорт» и прочие метки рисуются в 60
  // fps, а HUD — кэшированной картинкой в 15. Раньше картинка блитилась
  // раньше подписей, и подписи оказывались НА ней: «Зал» и «Телепорт»
  // просвечивали сквозь панель статов, кнопки и веер.
  //
  // Порядок обратный: мир и его метки внизу, интерфейс сверху. Это ещё и
  // единственно верно по смыслу — интерфейс существует, чтобы его было
  // видно поверх мира, а не наоборот.
  if (player && dungeon) _drawPlayerNameOnUI();
  if (dungeon) _drawOtherPlayerNamesOnUI();
  drawDecalLabels();

  if (_hudCv) {
    _uiCtx.setTransform(1, 0, 0, 1, 0, 0);
    _uiCtx.drawImage(_hudCv, 0, 0);
    _uiCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  // Джойстик — поверх всего: его двигают пальцем, и метка мира, легшая на
  // ручку, читается как часть управления.
  if (activeTab === 0) drawJoystick();

  // Баннер «Безопасная зона» убран по решению владельца. Полоса под шапкой
  // освободилась под бафы, а сам факт безопасной зоны видно по самой зоне:
  // она подсвечена на карте и в мире, и подпись поверх неё была третьим
  // способом сказать то же самое.

  // Transition flash (topmost layer)
  if (transTimer > 0) {
    _uiCtx.fillStyle = `rgba(180,120,255,${Math.min(1, transTimer * 3)})`;
    _uiCtx.fillRect(0, 0, W, H);
  }
}

// ─────────────────────────────────────────────────────────
//  GAME FLOW
// ─────────────────────────────────────────────────────────
function selectChar(type) {
  joy.active = false; joy.dx = 0; joy.dy = 0;
  try { localStorage.setItem(_lastCharTypeKey(), type); } catch (_) {}
  player = makePlayer(type);
  dungeonLvl = 1;
  // A single account has one savedData blob, not per-type save slots — gating
  // restoration on savedData.type === type dropped real progress to defaults
  // whenever that metadata field was missing/stale (e.g. a fast refresh
  // before the DB write finished), and the next debounced saveProgress then
  // persisted those defaults over the real save. restoreFromSave() itself
  // never reads .type, so just use whatever savedData exists.
  const savedStats = (typeof _savedData !== 'undefined' && _savedData) ? _savedData : null;
  csStartLoading(type, () => { initNpcs(); _finishOnlineStart(); });
  // Gate the loading screen on BOTH player and floor-1 enemy sprites being decoded.
  const _floor1Eids = (FLOOR_ENEMIES[1]?.species || []).flatMap(sp => [sp + '_guard', sp + '_warrior']).concat([FLOOR_ENEMIES[1]?.boss]).filter(Boolean);
  let _spritesPending = 1 + _floor1Eids.length;
  // Полоса считает НАБОРЫ, а не листы: наборов ровно столько, сколько ждёт
  // _spritesPending, и это то число, по которому видно, сколько осталось.
  const _spritesTotal = _spritesPending;
  const _onSpriteSetReady = () => {
    if (typeof csLoadProgress === 'function') {
      csLoadProgress(_spritesTotal - _spritesPending + 1, _spritesTotal);
    }
    if (--_spritesPending === 0) csOnSpritesReady();
  };
  _floor1Eids.forEach(eid => loadEnemySprites(eid, _onSpriteSetReady));
  loadSprites(type, _onSpriteSetReady);
  netSelectChar(type, savedStats);
}


function getOtherPlayerAnimKey(p) {
  if ((p.hp ?? 1) <= 0) return 'die';
  const dir = p.facing || 'front';
  if ((p.atkAnimTimer || 0) > 0) return `${dir}-attack`;
  if (p.moving) return `${dir}-run`;
  return `${dir}-idle`;
}


// ─────────────────────────────────────────────────────────
//  SAFE ZONE
// ─────────────────────────────────────────────────────────
function inSafeZone(px, py) {
  if (!dungeon || !dungeon.safeZone) return false;
  const sz = dungeon.safeZone;
  return px >= sz.x1 && px <= sz.x2 && py >= sz.y1 && py <= sz.y2;
}

// ─────────────────────────────────────────────────────────
//  ARM GATES — level-gated checkpoints between every room-pair position
//  down each (now hub-detached) corridor
// ─────────────────────────────────────────────────────────
// Each zone still gates its own deeper rooms by character level: reaching
// e.g. the level-3/4 room pair requires character level 3, the next pair
// requires 5, and so on (dungeon.corridorGates, built server-side in
// server/game/dungeon.js). The zone's OWN entrance is no longer a physical
// door you walk through — see the TELEPORT PADS section below for that.
// Rebuilt any time `dungeon` changes (see _buildArmGates() call sites in
// network.js/game.js).
let _armGates = null;
let _raceBarriers = null;
let _coopBarriers = null;
let _raceGateMsgCd = 0;
let _coopGateMsgCd = 0;
const _enteredArms = new Set();
let _gateMsgCd = 0;
function _armLabel(dir) { return typeof t === 'function' ? t({ left:'armLeft', top:'armTop', bottom:'armBottom', right:'armRight' }[dir]) : ({ left:'левый', top:'верхний', bottom:'нижний', right:'правый' }[dir]); }
const _ARM_LABEL = new Proxy({}, { get: (_, dir) => _armLabel(dir) });

// ─────────────────────────────────────────────────────────
//  TELEPORT PADS — a single hub-side portal opens a modal listing every arm
//  (labeled by its level range) plus Фарм-зона; picking one warps straight
//  into that zone's corridor entrance, and a matching pad at each zone's
//  entrance warps back to the hub. Replaces the old walk-down-the-corridor
//  hub doors entirely — the hub isn't physically connected to any zone
//  anymore.
// ─────────────────────────────────────────────────────────
function _teleportLabel(dir) { const n = { left:1, top:20, bottom:40, right:60 }[dir]; return typeof tVars === 'function' ? tVars('lvlNTeleport', { n }) : n + ' уровень'; }
const _TELEPORT_LABEL = new Proxy({}, { get: (_, dir) => _teleportLabel(dir) });
// Single hub-side portal, standing in for what used to be 5 separate pads
// (the 4 arm pads + the Фарм-зона pad): walking up to it opens a modal
// listing every destination instead of triggering a transition directly —
// see _portalDestinations/_openPortalModal below.
const _PORTAL_DX = 0; // tiles, hub-side (NPCs sit north, at dy -11)
const _PORTAL_DY = 7; // tiles south of spawn — closer in than the old arm-pad row (was 10)
let _portalPad = null;          // hub-only: {x, y} — approach opens the modal
let _portalDestinations = null; // hub-only: [{target, req, label}] — modal contents
let _returnPads = null;   // arm-side: [{x, y}] (at most one) — enterLocation('hub') on trigger
// Event-boss arena pad (see _evtArenaOpen) and the Guild War pad just below —
// both sit right next to the main portal (_PORTAL_DX/_PORTAL_DY), one tile
// either side of it, rather than off in their own row: same swirl look as
// the portal now (see _pushSwirlPad), just recoloured, so the three read as
// one family of "teleport here" circles instead of two different pad styles
// scattered around the hub.
const _EVENT_PAD_DX = _PORTAL_DX - 2.4;
const _EVENT_PAD_DY = _PORTAL_DY;
let _evtPad = null;
let _evtBossAlive = false;
// Guild War zone pad — mirrors the event pad on the other side of the
// portal. Gated on _gwOpen() (22:00-22:15 MSK) instead of _evtArenaOpen();
// _gwPhase is set by js/network.js's guildWarState handler and by the
// gameStart payload.
const _GW_PAD_DX = _PORTAL_DX + 2.4;
const _GW_PAD_DY = _PORTAL_DY;
let _gwPad = null;
let _gwPhase = 'closed';
function _gwOpen() { return _gwPhase === 'live'; }
let _portalModalOpen = false; // true while the destination-picker modal is up
let _portalDismissed = false; // player closed it manually; don't reopen until they step away and back
// World boss state as the server last reported it: spawnAt is a summon already
// counting down, nextAt the next scheduled appearance (пн/ср/пт/вс 20:00 МСК).
// Read by the Events panel — see _worldBossBodyHTML in js/ui.js.
let _evtBossState = { spawnAt: 0, alive: false, nextAt: 0 };
let _evtHpCd = 0;

function _buildArmGates() {
  _closePortalModal();
  if (!dungeon) { _armGates = []; _portalPad = null; _portalDestinations = null; _returnPads = []; _raceBarriers = []; _coopBarriers = []; return; }
  _armGates = (dungeon.corridorGates || []).map(g => (
    { dir: g.dir, x: g.tx * TILE + TILE / 2, y: g.ty * TILE + TILE / 2, req: g.req }
  ));
  // Кровавая Башня barriers — pixel coords already come from the server
  // (dungeon.race10.barriers); see _isRaceBarrierBlocked for how "cleared"
  // is decided.
  _raceBarriers = (dungeon.race10 && dungeon.race10.barriers) || [];
  // Сотрудничество barriers — same idea, but "cleared" is the shared
  // _coopStageNo counter (js/state.js, pushed by coopStage/gameStart) rather
  // than a live-monster scan: the server only advances that counter once
  // BOTH lanes have cleared the current stage (Room.coopRegisterKill), so
  // there's no per-lane aliveness to check client-side — see
  // _isCoopBarrierBlocked.
  _coopBarriers = (dungeon.coop && dungeon.coop.barriers) || [];

  const sx = dungeon.spawn ? dungeon.spawn.x : 0, sy = dungeon.spawn ? dungeon.spawn.y : 0;

  // Arm-side return pad — only present when THIS floor IS an arm (its own
  // returnPad field, see generateArm in server/game/dungeon.js); the hub
  // itself has none.
  _returnPads = dungeon.returnPad ? [{ x: dungeon.returnPad.x, y: dungeon.returnPad.y }] : [];

  // armEntries is a hub-only field (generateHub, server/game/dungeon.js) —
  // the one reliable signal, from any floor's dungeon payload, that this is
  // the hub itself and its special-zone outbound pads belong on screen.
  const onHub = !!dungeon.armEntries;

  // Single hub-side portal — the 4 arm pads and the Фарм-зона pad used to
  // each sit in their own spot and transition directly on touch; now they're
  // just entries in a list a single pad shows in a modal on approach (see
  // _openPortalModal/_updateTeleportPads), each still carrying its own req
  // (level gate) and label the same way the old individual pads did.
  const entries = dungeon.armEntries || [];
  _portalDestinations = entries.map(e => (
    { target: e.dir, req: e.req, label: _TELEPORT_LABEL[e.dir] || `${typeof t === 'function' ? t('levelAbbrev') : 'Ур.'} ${e.req}` }
  ));
  const fze = dungeon.farmZoneEntry;
  if (fze) {
    _portalDestinations.push(
      { target: 'farmZone', req: fze.req || 0, label: typeof t === 'function' ? t('farmZoneLbl') : 'Фарм зона' }
    );
  }
  _portalPad = (onHub && _portalDestinations.length)
    ? { x: sx + _PORTAL_DX * TILE, y: sy + _PORTAL_DY * TILE }
    : null;

  // Event-boss arena pad — its own floor now (server/game/floors.js), same
  // change every other special-zone pad below already went through: a real
  // transition (netEnterLocation) instead of a same-grid teleport. Built
  // whenever we're on the hub; only drawn and only trigger while the event is
  // running (see _evtArenaOpen) — outside an event the pad just sits inert.
  // The zone's own returnPad flows back through the generic _returnPads
  // handling above, so there's no dedicated return pad to build here either
  // — same for Death Battle's own return, which is a server push (gameStart
  // + deathBattleEliminated/deathBattleReturnedPrev), not a pad walk at all.
  _evtPad = onHub ? { x: sx + _EVENT_PAD_DX * TILE, y: sy + _EVENT_PAD_DY * TILE } : null;

  // Guild War hub-side pad — its own floor now (server/game/floors.js), so
  // stepping onto it requests a real transition (netEnterLocation) rather
  // than a same-grid teleport; no targetX/targetY any more, same change the
  // portal above already went through. The zone's own returnPad
  // (generateGuildWar) flows back through the generic _returnPads handling
  // above, so there's no dedicated return pad to build here any more either.
  _gwPad = onHub ? { x: sx + _GW_PAD_DX * TILE, y: sy + _GW_PAD_DY * TILE } : null;
}

// True while a world boss is announced, alive, or its loot is still on the
// floor — the window in which the arena is reachable.
function _evtArenaOpen() {
  return (typeof _evtBossSpawnAt !== 'undefined' && _evtBossSpawnAt > Date.now()) ||
         _evtBossAlive ||
         (typeof worldDrops !== 'undefined' && worldDrops.size > 0);
}

function _teleportTo(tx, ty, label) {
  // Same guard posCorrect already applies before touching player.x/y, and for
  // the same reason: an undefined coordinate assigned here is permanent. Every
  // later read is NaN, so the camera goes NaN with it (nothing renders at all),
  // the safe-zone/room/pad tests all come back false, and the server refuses
  // the resulting move packets outright (updatePlayerPos, server/game/Room.js)
  // — leaving the client somewhere it can never move away from while the
  // server keeps the player standing wherever they last legitimately were.
  // Every caller here is a server placement that carries real coordinates, so
  // this can only ever fire on a payload that was already broken; refusing to
  // apply it keeps the player where they are instead of erasing them.
  if (!player || !Number.isFinite(tx) || !Number.isFinite(ty)) return;
  // Every server-driven placement lands here (deathBattleStarted,
  // arena3Started, race10Started, fearStarted and each event's return path),
  // so this is the one place that has to record when it happened.
  _serverPlacedAt = Date.now();
  player.x = tx; player.y = ty;
  camera.x = player.x - W / (2 * ZOOM); camera.y = player.y - _visH() / 2; clampCamera();
  spawnBurst(player.x, player.y, '#7fd7ff', 20);
  dmgNum(player.x, player.y - 30, `→ ${label}`, '#7fd7ff', 15);
}

// Real floor transition (hub <-> arm) — replaces _teleportTo for the pads
// that now cross into a different floor's own Room (server/index.js's
// enterLocation handler). _floorChangePending guards against re-firing every
// frame while the request is in flight: the player visibly stays standing
// on the same old-floor pad tile for the round trip, since the reposition
// onto the new floor only happens once the matching gameStart lands (see
// _applyGameStart's floorChange branch, js/network.js).
let _floorChangePending = false;
function _requestEnterLocation(target, label, icon) {
  if (_floorChangePending) return;
  if (typeof netEnterLocation !== 'function') return;
  _floorChangePending = true;
  if (typeof csStartFloorLoading === 'function') {
    csStartFloorLoading(label, icon, () => {
      _floorChangePending = false;
      if (typeof csHide === 'function') csHide();
    });
    // Nothing floor-specific to preload ahead of time — enemy/NPC sprites
    // for a newly-entered floor lazy-load on first draw the same way an
    // already-open session picks up a never-before-seen species (see
    // _enemyTextures, js/pixi-world.js) — so the sprite gate is a no-op here,
    // only the server round trip actually gates the overlay.
    if (typeof csOnSpritesReady === 'function') csOnSpritesReady();
  } else {
    _floorChangePending = false;
  }
  netEnterLocation(target);
}

// Called once per frame from update(): opens the portal's destination modal
// the instant the player walks up to it (closing it again once they step
// away), and triggers a teleport the instant they walk onto any pad that
// still transitions directly (return pads, the event arena, Guild War).
function _updateTeleportPads(dt) {
  if (!player) return;
  const TRIGGER_R = 26;
  if (_portalPad) {
    const inRange = dist(player.x, player.y, _portalPad.x, _portalPad.y) < TRIGGER_R;
    if (inRange) {
      if (!_portalModalOpen && !_portalDismissed) _openPortalModal();
    } else {
      if (_portalModalOpen) _closePortalModal();
      _portalDismissed = false;
    }
  }
  (_returnPads || []).forEach(p => {
    if (dist(player.x, player.y, p.x, p.y) >= TRIGGER_R) return;
    _requestEnterLocation('hub', typeof t === 'function' ? t('centralHall') : 'Центральный зал');
  });
  // Boss HP readout, refreshed 8x/sec — a DOM write every frame would be
  // wasted work for a bar that only needs to look live.
  _evtHpCd -= dt;
  if (_evtHpCd <= 0) {
    _evtHpCd = 0.125;
    if (typeof updateEventBossHpBar === 'function') updateEventBossHpBar();
  }
  // The way back is the zone's own returnPad (generic _returnPads handling
  // above) and stays usable even after the event closes, so nobody can be
  // stranded in the arena when the loot expires.
  if (_evtArenaOpen() && _evtPad && dist(player.x, player.y, _evtPad.x, _evtPad.y) < TRIGGER_R) {
    _requestEnterLocation('arena', t('evtArenaLbl'));
  }
  if (typeof updateGuildWarHpBar === 'function') updateGuildWarHpBar();
  // The way back is the zone's own returnPad, handled generically by the
  // _returnPads loop above (same as an arm) — the server refuses re-entry
  // once the window closes (see _doEnterLocation, server/index.js), and a
  // reconnect mid-eviction lands back on the hub already, so there's no
  // "stranded with the window shut" case left to special-case here.
  if (_gwOpen() && _gwPad && dist(player.x, player.y, _gwPad.x, _gwPad.y) < TRIGGER_R) {
    _requestEnterLocation('guildWar', typeof t === 'function' ? t('guildWarLbl') : 'Война гильдий');
  }
}

// Destination-picker modal for the single hub portal — lists every arm +
// Фарм-зона (see _portalDestinations, built in _buildArmGates), each showing
// its own lock state the same way the old individual pads did. Follows the
// same dynamically-built-overlay pattern as openPetStatsModal (js/npc.js):
// a fresh .imod-overlay/.imod-box appended to #app, torn down by id. Rows
// use .shop-list/.shop-row (js/npc.js's merchant panel) rather than the
// craft grid — a vertical list of named destinations reads better than a
// grid of icon tiles when every entry already carries its own text label.
function _openPortalModal() {
  if (!_portalDestinations || !_portalDestinations.length) return;
  _closePortalModal();
  _portalModalOpen = true;
  const lvl = (player && player.lvl) || 1;
  const rowsHtml = _portalDestinations.map(d => {
    const locked = d.req > 0 && lvl < d.req;
    const sub = d.req > 0
      ? (typeof t === 'function' ? `${t('levelAbbrev')} ${d.req}` : `Ур. ${d.req}`)
      : '';
    return `<div class="shop-row" style="cursor:pointer;touch-action:manipulation;${locked ? 'opacity:.7' : 'border-color:rgba(79,195,255,0.35)'}" onclick="_pickPortalDestination('${d.target}')">
      <div class="shop-item-icon">${locked ? '🔒' : '🌀'}</div>
      <div class="shop-item-info">
        <div class="shop-item-name">${d.label}</div>
        ${sub ? `<div class="shop-item-stat" style="color:${locked ? '#f17e8b' : '#7fd7ff'}">${sub}</div>` : ''}
      </div>
    </div>`;
  }).join('');
  const ov = document.createElement('div');
  ov.id = 'portal-modal-ov';
  ov.className = 'imod-overlay';
  ov.onclick = () => { _portalDismissed = true; _closePortalModal(); };
  ov.innerHTML = `<div class="imod-box" onclick="event.stopPropagation()" style="max-width:340px">
    <div class="imod-hdr">
      <span class="imod-big-icon" style="font-size:32px;filter:drop-shadow(0 0 6px #4fc3ff)">🌀</span>
      <div class="imod-title-block">
        <div class="imod-name" style="color:#8fd8ff">${typeof t === 'function' ? t('portalPickTitle') : 'Куда телепортироваться?'}</div>
      </div>
      <button class="npc-close" onclick="_portalDismissed = true; _closePortalModal()" style="touch-action:manipulation">✕</button>
    </div>
    <div class="shop-list">${rowsHtml}</div>
  </div>`;
  document.getElementById('app').appendChild(ov);
}

function _closePortalModal() {
  _portalModalOpen = false;
  const el = document.getElementById('portal-modal-ov');
  if (el) el.remove();
}

function _pickPortalDestination(target) {
  const d = (_portalDestinations || []).find(x => x.target === target);
  if (!d) return;
  const lvl = (player && player.lvl) || 1;
  if (d.req > 0 && lvl < d.req) {
    dmgNum(player.x, player.y - 40, typeof tVars === 'function' ? tVars('lockedNeedLevel', { n: d.req }) : `🔒 Нужен ${d.req} уровень`, '#f17e8b');
    return;
  }
  _portalDismissed = true;
  _closePortalModal();
  _requestEnterLocation(d.target, d.label);
}

// ── ground decals: teleport pads, level gates, zone barriers ──────────────
// One pass decides what is on the floor and whether it is locked; the GPU
// pass and the label pass then only consume that. They used to be two
// independent walks of the same lists inside one 2D drawing function, which
// is how a shape and its label get to disagree about whether a gate is open.
//
// Shapes now live in the PixiJS world (see pixiDecalRing/Swirl/Wall in
// js/pixi-world.js) instead of being stroked onto the 2D HUD canvas every
// frame — the swirl alone was measured at 0.205ms per pad per frame, and the
// hub shows up to four. Labels stay on the overlay: at native DPR they are
// crisp, and they must stay readable over whatever is standing on the pad.
//
// Radii are WORLD units here. The old code worked in screen pixels and wrote
// them as `30 * ZOOM`, which is the same circle — screen = world x ZOOM — just
// expressed in the space the overlay happened to draw in.
const _decals = [];      // {k, ...} — shapes, world coordinates
const _decalLbls = [];   // {wx, wy, dy, text, color, px, mid} — dy is a screen-px offset

const _PAD_R    = 30;
const _GATE_R   = 34;
const _SWIRL_R  = 28;
const _DECAL_MARGIN = 90;   // world px past the viewport edge before a decal is dropped

// Colour families for the swirl pads — glow/disc/rings/label all move
// together so a pad reads as one coherent colour rather than a blue shape
// with an odd-coloured label. Blue is the original (and still the only) look
// for the main hub portal; red/green are the boss-arena and Guild War pads,
// recoloured into the same swirl instead of the plainer pulsing ring
// everything else still uses.
const _SWIRL_THEMES = {
  blue:  { glow: 0x46aaff, disc: 0x0c376e, ring1: 0x4fc3ff, ring2: 0xbfe9ff, label: '#8fd8ff' },
  red:   { glow: 0xff5050, disc: 0x6e0f0f, ring1: 0xff5252, ring2: 0xffb0b0, label: '#ff9a9a' },
  green: { glow: 0x50eb8c, disc: 0x0c5a2d, ring1: 0x4fe38a, ring2: 0xbfffd9, label: '#8fffbf' },
};

function _decalVisible(x, y, r) {
  return x >= _vL - r - _DECAL_MARGIN && x <= _vR + r + _DECAL_MARGIN &&
         y >= _vT - r - _DECAL_MARGIN && y <= _vB + r + _DECAL_MARGIN;
}

// A plain pulsing pad — a translucent disc with a ring breathing around it.
function _pushRingPad(x, y, r, locked, lockedEdge, openEdge, label, lockedLbl, openLbl) {
  if (!_decalVisible(x, y, r)) return;
  _decals.push({
    k: 'ring', x, y, r,
    fill: locked ? 0x5a141a : 0x146e46,
    fillA: locked ? 0.35 : 0.28,
    edge: locked ? lockedEdge : openEdge,
  });
  if (label) _decalLbls.push({ wx: x, wy: y, dy: r * ZOOM + 14, text: label, color: locked ? lockedLbl : openLbl, px: 11, mid: false });
}

function _pushSwirlPad(x, y, label, themeKey) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  if (!_decalVisible(x, y, _SWIRL_R)) return;
  const th = _SWIRL_THEMES[themeKey] || _SWIRL_THEMES.blue;
  _decals.push({ k: 'swirl', x, y, r: _SWIRL_R, th });
  if (label) _decalLbls.push({ wx: x, wy: y, dy: _SWIRL_R * ZOOM + 16, text: label, color: th.label, px: 11, mid: false });
}

function _pushWall(x, y, hw, hh, fill, edge) {
  if (x + hw < _vL - _DECAL_MARGIN || x - hw > _vR + _DECAL_MARGIN ||
      y + hh < _vT - _DECAL_MARGIN || y - hh > _vB + _DECAL_MARGIN) return;
  _decals.push({ k: 'wall', x, y, hw, hh, fill, edge });
  _decalLbls.push({ wx: x, wy: y, dy: 0, text: '\u{1F512}', color: '#fff', px: 20, mid: true });
}

// Runs once per frame, before the world is rendered, so the shapes it queues
// are in the same frame as everything else rather than a frame behind.
function _buildDecals(ts) {
  _decals.length = 0;
  _decalLbls.length = 0;
  if (!player || !dungeon) return;

  // ── teleport pads ──
  if (_portalPad) _pushSwirlPad(_portalPad.x, _portalPad.y, typeof t === 'function' ? t('portalLbl') : '\u{1F300} \u0422\u0435\u043b\u0435\u043f\u043e\u0440\u0442', 'blue');
  const hallLbl = typeof t === 'function' ? t('hallShort') : '\u0417\u0430\u043b';
  (_returnPads || []).forEach(p => _pushRingPad(p.x, p.y, _PAD_R, false, 0xeb4e61, 0x4ee69a, hallLbl, '#f17e8b', '#8ff0c0'));
  if (_evtArenaOpen() && _evtPad) _pushSwirlPad(_evtPad.x, _evtPad.y, t('evtArenaLbl'), 'red');
  if (_gwOpen() && _gwPad) _pushSwirlPad(_gwPad.x, _gwPad.y, typeof t === 'function' ? t('guildWarLbl') : '\u0412\u043e\u0439\u043d\u0430 \u0433\u0438\u043b\u044c\u0434\u0438\u0439', 'green');
  // Teleport-stone cast (useTeleportStone, server/index.js) — the same blue
  // swirl the hub portal itself uses, centred on the player so it visibly
  // follows them while they're held still. No label: it's already right under
  // the character, a name would just clutter it.
  if (typeof _teleportCasting === 'function' && _teleportCasting()) _pushSwirlPad(player.x, player.y, '', 'blue');

  // ── arm level gates ──
  // t is the i18n function. It used to be shadowed here by a local
  // `const t = _nowMs / 1000`, so `typeof t === 'function'` was false on every
  // single frame and the level abbreviation fell through to hardcoded Russian
  // for every language in the game.
  if (_armGates && _armGates.length) {
    const lvlAbbr = typeof t === 'function' ? t('levelAbbrev') : '\u0423\u0440.';
    for (const g of _armGates) {
      const locked = g.req > 0 && (player.lvl || 1) < g.req;
      const lbl = g.req > 0 ? (locked ? '\u{1F512} ' : '') + lvlAbbr + ' ' + g.req : '';
      if (!_decalVisible(g.x, g.y, _GATE_R)) continue;
      _decals.push({
        k: 'ring', x: g.x, y: g.y, r: _GATE_R,
        fill: locked ? 0x5a141a : 0x1e5a6e,
        fillA: locked ? 0.35 : 0.28,
        edge: locked ? 0xeb4e61 : 0x7fd7ff,
      });
      if (lbl) _decalLbls.push({ wx: g.x, wy: g.y, dy: _GATE_R * ZOOM + 14, text: lbl, color: locked ? '#f17e8b' : '#a8e9ff', px: 11, mid: false });
    }
  }

  // ── race10 barriers ──
  // A solid pulsing wall across the corridor while its tier still has
  // survivors — reads as "physically blocked", not just another level-gate
  // pad, since a barrier spans the whole 3-tile width rather than sitting as
  // a circle in its centre. Drops out entirely once the tier's cleared:
  // there's nothing left to explain at that point.
  if (_raceBarriers && _raceBarriers.length) {
    for (const b of _raceBarriers) {
      if (!_raceLaneTierAlive(b.lane, b.tier)) continue;
      _pushWall(b.x, b.y, RACE_BARRIER_THICK, RACE_BARRIER_HALF_W, 0xeb4e61, 0xf7b0b8);
    }
  }

  // ── coop barriers ──
  // Same treatment, tinted green to read as part of Сотрудничество rather
  // than a copy-paste of race10's red — see _isCoopBarrierBlocked for what
  // "still blocked" means here.
  if (_coopBarriers && _coopBarriers.length) {
    const stageNo = (typeof _coopStageNo !== 'undefined' && _coopStageNo) || 0;
    for (const b of _coopBarriers) {
      if (stageNo > b.stage) continue;
      _pushWall(b.x, b.y, COOP_BARRIER_THICK, COOP_BARRIER_HALF_W, 0x2f9e4f, 0xa8f0b8);
    }
  }

  _pushDecalsToGpu(ts);
}

function _pushDecalsToGpu(ts) {
  if (typeof pixiDecalsBegin !== 'function') return;
  pixiDecalsBegin();
  const tsec  = ts / 1000;
  const pulse = 0.5 + 0.5 * Math.sin(tsec * 2.4);
  const sPulse = 0.5 + 0.5 * Math.sin(tsec * 2.1);
  for (let i = 0; i < _decals.length; i++) {
    const d = _decals[i];
    if (d.k === 'ring')       pixiDecalRing(d.x, d.y, d.r, d.fill, d.fillA, d.edge, pulse);
    else if (d.k === 'swirl') pixiDecalSwirl(d.x, d.y, d.r, d.th, tsec, sPulse);
    else                      pixiDecalWall(d.x, d.y, d.hw, d.hh, d.fill, 0.35 + 0.15 * pulse, d.edge, 0.7 + 0.3 * pulse);
  }
  pixiDecalsEnd();
}

// The overlay half: text only. Measured cheaper as live strokeText than as
// cached bitmaps blitted per frame (0.147ms vs 0.180ms for twelve labels on
// the dev bench), so these stay direct draws.
function drawDecalLabels() {
  if (!_decalLbls.length) return;
  ctx.textAlign = 'center';
  ctx.lineWidth = 3;
  for (let i = 0; i < _decalLbls.length; i++) {
    const L = _decalLbls[i];
    const sx = (L.wx - _lastCamX) * ZOOM;
    const sy = (L.wy - _lastCamY) * ZOOM + HEADER_H + L.dy;
    if (sx < -80 || sx > W + 80 || sy < -40 || sy > H + 40) continue;
    ctx.font = 'bold ' + L.px + 'px system-ui, Arial';
    ctx.textBaseline = L.mid ? 'middle' : 'alphabetic';
    ctx.lineWidth = L.mid ? 4 : 3;
    ctx.strokeStyle = '#000';
    ctx.strokeText(L.text, sx, sy);
    ctx.fillStyle = L.color;
    ctx.fillText(L.text, sx, sy);
  }
}

// Every zone's main corridor runs along X — the arm names ('left', 'top',
// 'bottom', 'right') are just labels for the four stacked zones, not compass
// directions, ever since they stopped radiating out of the hub (see buildArm
// in server/game/dungeon.js: all four paint their corridor along X at a fixed
// Y). Orienting the barrier from the name left the 'top' and 'bottom' zones
// with a barrier turned 90°: it only covered the middle GATE_THICK of the
// 3-tile corridor, so anyone hugging either edge walked straight past a gate
// they were too low-level for.
const GATE_THICK  = 22;        // along the corridor — how deep the barrier is
const GATE_HALF_W = TILE * 2;  // across it — 4 tiles, wider than the 3-tile corridor
function _isGateBlocked(wx, wy) {
  if (!player || !_armGates) return false;
  for (const g of _armGates) {
    if (g.req <= 0 || (player.lvl || 1) >= g.req) continue;
    if (Math.abs(wx - g.x) < GATE_THICK && Math.abs(wy - g.y) < GATE_HALF_W) return true;
  }
  return false;
}

// Called once per frame from update(): shows a throttled lock message near a
// gate the player can't pass yet, and fires a one-time "teleport" flourish
// the first time they cross an unlocked one this session.
function _updateArmGates(dt) {
  if (!player || !_armGates || !_armGates.length) return;
  if (_gateMsgCd > 0) _gateMsgCd -= dt;
  for (const g of _armGates) {
    if (dist(player.x, player.y, g.x, g.y) >= 90) continue;
    if (g.req > 0 && (player.lvl || 1) < g.req) {
      if (_gateMsgCd <= 0) {
        dmgNum(player.x, player.y - 40, typeof tVars === 'function' ? tVars('lockedNeedLevel', { n: g.req }) : `🔒 Нужен ${g.req} уровень`, '#f17e8b');
        _gateMsgCd = 1.5;
      }
    } else if (!_enteredArms.has(g.dir)) {
      _enteredArms.add(g.dir);
      spawnBurst(g.x, g.y, '#7fd7ff', 16);
      dmgNum(g.x, g.y - 30, '→ ' + (typeof tVars === 'function' ? tVars('enteredCorridorToast', { arm: _ARM_LABEL[g.dir] }) : `Вы вошли в ${_ARM_LABEL[g.dir]} коридор`), '#7fd7ff', 15);
    }
  }
}

// Кровавая Башня (race10) barriers — same box-collision shape as the arm
// gates above, but "unlocked" means "every monster this lane's tier spawned
// is dead" instead of a level check. Counted live off serverEnemies rather
// than tracked incrementally: ids are `race10_<lane>_<n>` and rlvl is
// exactly 5 (tier 0) or 10 (tier 1) — see spawnRace10Tier, server/game/
// dungeon.js — so a lane+tier's survivors are a cheap filter, and this only
// ever runs for a barrier the player is actually standing next to.
const RACE_BARRIER_THICK  = 22;
const RACE_BARRIER_HALF_W = TILE * 2;
function _raceLaneTierAlive(lane, tier) {
  if (typeof serverEnemies === 'undefined') return true;
  const rlvl = tier === 0 ? 5 : 10;
  const prefix = `race10_${lane}_`;
  for (let i = 0; i < serverEnemies.length; i++) {
    const e = serverEnemies[i];
    if ((e.hp || 0) > 0 && e.rlvl === rlvl && e.id.startsWith(prefix)) return true;
  }
  return false;
}
function _isRaceBarrierBlocked(wx, wy) {
  if (!_raceBarriers || !_raceBarriers.length) return false;
  for (const b of _raceBarriers) {
    if (Math.abs(wx - b.x) >= RACE_BARRIER_THICK || Math.abs(wy - b.y) >= RACE_BARRIER_HALF_W) continue;
    if (_raceLaneTierAlive(b.lane, b.tier)) return true;
  }
  return false;
}

// Сотрудничество (coop) barriers — same box-collision shape as the race10
// barriers above, but "unlocked" reads off the shared _coopStageNo counter
// (js/state.js) instead of scanning serverEnemies: the server only advances
// it once BOTH lanes have cleared the current stage (Room.coopRegisterKill),
// so by the time the counter passes a barrier's `stage`, that barrier's
// corridor is already empty on both sides.
const COOP_BARRIER_THICK  = 22;
const COOP_BARRIER_HALF_W = TILE * 2;
function _isCoopBarrierBlocked(wx, wy) {
  if (!_coopBarriers || !_coopBarriers.length) return false;
  const stageNo = (typeof _coopStageNo !== 'undefined' && _coopStageNo) || 0;
  for (const b of _coopBarriers) {
    if (Math.abs(wx - b.x) >= COOP_BARRIER_THICK || Math.abs(wy - b.y) >= COOP_BARRIER_HALF_W) continue;
    if (stageNo <= b.stage) return true;
  }
  return false;
}

// Called once per frame from update(): throttled "clear the monsters first"
// message while standing at a still-blocked coop barrier.
function _updateCoopBarriers(dt) {
  if (!player || !_coopBarriers || !_coopBarriers.length) return;
  if (_coopGateMsgCd > 0) _coopGateMsgCd -= dt;
  const stageNo = (typeof _coopStageNo !== 'undefined' && _coopStageNo) || 0;
  for (const b of _coopBarriers) {
    if (dist(player.x, player.y, b.x, b.y) >= 90) continue;
    if (stageNo <= b.stage && _coopGateMsgCd <= 0) {
      dmgNum(player.x, player.y - 40, typeof t === 'function' ? t('coopBarrierLockedMsg') : 'Дождитесь напарника', '#8fe8a0');
      _coopGateMsgCd = 1.5;
    }
  }
}

// Called once per frame from update(): throttled "clear the monsters first"
// message while standing at a still-blocked barrier.
function _updateRaceBarriers(dt) {
  if (!player || !_raceBarriers || !_raceBarriers.length) return;
  if (_raceGateMsgCd > 0) _raceGateMsgCd -= dt;
  for (const b of _raceBarriers) {
    if (dist(player.x, player.y, b.x, b.y) >= 90) continue;
    if (_raceLaneTierAlive(b.lane, b.tier) && _raceGateMsgCd <= 0) {
      dmgNum(player.x, player.y - 40, typeof t === 'function' ? t('raceBarrierLockedMsg') : 'Убейте всех монстров', '#f17e8b');
      _raceGateMsgCd = 1.5;
    }
  }
}

// ─────────────────────────────────────────────────────────
//  NPCs
// ─────────────────────────────────────────────────────────
// The hub has no physical exits anymore (see TELEPORT PADS above) — NPCs
// just sit side by side north of spawn, clear of the teleport pad row south
// of it. Called on every floor (re)load now that locations are separate
// floors (js/network.js's _applyGameStart) — only the hub actually has
// NPCs, so every other floor just clears the list. armEntries only exists
// on the hub's own dungeon payload (server/game/dungeon.js's generateHub),
// so its presence is what tells the two apart rather than a hardcoded floor
// number.
function initNpcs() {
  if (!dungeon || !dungeon.armEntries) { npcs = []; nearNpc = null; return; }
  const sx = dungeon.spawn.x, sy = dungeon.spawn.y;
  const offsets = [
    { dx: -TILE * 4, dy: -TILE * 11 },
    { dx:  TILE * 4, dy: -TILE * 11 },
    { dx: 0,         dy: -TILE * 8  }, // storage — between merchant and craftsman, one row forward
  ];
  npcs = NPC_DEF.map((def, i) => ({
    ...def,
    x: sx + offsets[i].dx,
    y: sy + offsets[i].dy,
  }));
}


// ── Tile chunks ────────────────────────────────────────────
// The map used to pre-render into ONE huge canvas (up to ~3200×2400,
// ~30MB as a GPU texture). Mobile GPUs evict textures that big under
// memory pressure and re-upload them mid-scroll — the whole background
// visibly hitched. Instead the map renders as lazy 8×8-tile chunks
// (320×320px, ~400KB each): only visible chunks are drawn (~12/frame),
// each texture is small enough to stay resident, and a chunk builds in
// well under a millisecond the first time it scrolls into view.
const _CHUNK_T  = 8;                 // tiles per chunk side
const _CHUNK_PX = _CHUNK_T * TILE;   // 320 world px
const _CHUNK_G  = 2;                 // gutter so bilinear edges sample real content
const _CHUNK_MAX = 96;               // cache cap (~38MB worst case, oldest evicted)
const _tileChunks = new Map();       // "cx,cy" -> canvas
const _chunkTorches = new Map();     // "cx,cy" -> [{x,y}] wall-torch flame anchor points

function buildTileCanvas() {
  _tileChunks.clear();
  _chunkTorches.clear();
  if (typeof pixiInvalidateChunks === 'function') pixiInvalidateChunks();
  _mmTileCv = null; // minimap floor-tile buffer (js/ui.js) — new dungeon grid
}

// Deterministic per-tile pseudo-random in [0,1) — stable across chunk
// rebuild/eviction (unlike Math.random()), so a tile always redraws with
// the exact same procedural detail no matter when its chunk gets rebuilt.
function _tileHash(tx, ty, salt) {
  let h = (tx * 374761393 + ty * 668265263 + salt * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 15), 1274126177);
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 100000) / 100000;
}

// Lightens (t>0) or darkens (t<0) a hex color toward white/black by |t|.
function _shadeHexColor(hex, t) {
  return t >= 0 ? _lerpHexColor(hex, '#ffffff', t) : _lerpHexColor(hex, '#000000', -t);
}

// A short deterministic zig-zag crack, 2px thick (no 1px hairlines).
function _drawCrack(c, x, y, tx, ty, color, segLen) {
  c.strokeStyle = color;
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(x, y);
  let cx = x, cy = y;
  for (let i = 0; i < 3; i++) {
    const a = _tileHash(tx, ty, i * 3 + 21) * Math.PI * 2;
    cx += Math.cos(a) * segLen;
    cy += Math.sin(a) * segLen;
    c.lineTo(cx, cy);
  }
  c.stroke();
}

// A soft radial grime/blood stain blob.
function _drawStain(c, x, y, radius, color) {
  const g = c.createRadialGradient(x, y, 0, x, y, radius);
  g.addColorStop(0, color);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = g;
  c.beginPath();
  c.arc(x, y, radius, 0, Math.PI * 2);
  c.fill();
}

// "Кровавая Башня" (the 10-player corridor race) gets its own deep blood-red
// palette instead of the normal biome theme, so the location actually looks
// like the name — see race10.bounds (server/game/dungeon.js), sent to the
// client as part of dungeonData.
const _RACE10_WALL    = '#2a0a0a';
const _RACE10_FLOOR_A = '#210707';
const _RACE10_FLOOR_B = '#150404';
function _isRace10Tile(tx, ty) {
  const b = typeof dungeon !== 'undefined' && dungeon && dungeon.race10 && dungeon.race10.bounds;
  return !!b && tx >= b.x0 && tx < b.x1 && ty >= b.y0 && ty < b.y1;
}

// Война гильдий gets its own palette too — a near-black, war-torn indigo
// courtyard rather than the default biome floor, so the siege ground under
// the tower actually reads as its own place instead of just more dungeon.
// The violet undertone echoes the tower's crystal roof gems; ember stains
// stand in for the blood ones race10 gets, since this is a structure siege,
// not a gore-fest.
const _GW_WALL    = '#170f24';
const _GW_FLOOR_A = '#221733';
const _GW_FLOOR_B = '#120c1c';
function _isGuildWarTile(tx, ty) {
  const b = typeof dungeon !== 'undefined' && dungeon && dungeon.guildWar && dungeon.guildWar.bounds;
  return !!b && tx >= b.x0 && tx < b.x1 && ty >= b.y0 && ty < b.y1;
}

// Фарм-зона gets a dedicated dark-icy palette instead of falling through to
// the biome theme (getTheme() clamps every floor past index 4 to the same
// golem-fortress brown) — cold, dim blues instead of the old bright
// green/tan so the zone reads as a frozen grinding spot, not a sunlit field.
const _FARM_WALL    = '#2e4a5e';
const _FARM_FLOOR_A = '#16242e';
const _FARM_FLOOR_B = '#1c2f3a';
function _isFarmZoneTile(tx, ty) {
  const b = typeof dungeon !== 'undefined' && dungeon && dungeon.farmZone && dungeon.farmZone.bounds;
  return !!b && tx >= b.x0 && tx < b.x1 && ty >= b.y0 && ty < b.y1;
}

// Сотрудничество (Coop) gets a dark, overgrown palette instead of falling
// through to the biome theme — near-black hedge walls and deep grass-green
// floor with scattered bright-green tufts (see the grass pass in
// _buildChunk below), so a "dark green with grass" dungeon actually looks
// like one instead of just another normal room.
const _COOP_WALL    = '#0f2413';
const _COOP_FLOOR_A = '#173a1c';
const _COOP_FLOOR_B = '#1f4726';
function _isCoopTile(tx, ty) {
  const b = typeof dungeon !== 'undefined' && dungeon && dungeon.coop && dungeon.coop.bounds;
  return !!b && tx >= b.x0 && tx < b.x1 && ty >= b.y0 && ty < b.y1;
}

// A little tuft of grass blades — a few short bright strokes fanning out
// from a base point, same "cheap procedural detail" role _drawCrack/
// _drawStain play for the other reskinned zones.
function _drawGrassTuft(c, x, y, tx, ty, color) {
  c.strokeStyle = color;
  c.lineWidth = 2;
  for (let i = 0; i < 3; i++) {
    const ang = -Math.PI / 2 + (_tileHash(tx, ty, 40 + i) - 0.5) * 1.6;
    const len = 5 + _tileHash(tx, ty, 43 + i) * 5;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
    c.stroke();
  }
}

function _buildChunk(cx, cy) {
  const th = getTheme(dungeonLvl);
  const x0 = cx * _CHUNK_PX, y0 = cy * _CHUNK_PX;
  const cv = document.createElement('canvas');
  cv.width = cv.height = _CHUNK_PX + _CHUNK_G * 2;
  const c = cv.getContext('2d');
  c.translate(_CHUNK_G - x0, _CHUNK_G - y0);

  function isFloor(tx, ty) {
    return tx >= 0 && tx < dungeon.w && ty >= 0 && ty < dungeon.h
      && dungeon.grid[ty][tx] === FLOOR;
  }

  // Tile range: chunk + 1-tile ring so gutter pixels and neighbor-dependent
  // passes (cliff faces, shadows) render identically to adjacent chunks
  const tx0 = Math.max(0, cx * _CHUNK_T - 1);
  const ty0 = Math.max(0, cy * _CHUNK_T - 1);
  const tx1 = Math.min(dungeon.w - 1, (cx + 1) * _CHUNK_T);
  const ty1 = Math.min(dungeon.h - 1, (cy + 1) * _CHUNK_T);

  // NOTE: no 1px features — flat multi-pixel fills only, so the bilinear
  // blit at ZOOM 0.75 stays clean (thin lines would render unevenly).

  // 1. Wall base — flat theme color, then per-tile procedural stone-block
  // shading, coarse 2-tile masonry seams, and occasional cracks. All
  // deterministic per (tx,ty) so a tile looks identical no matter when its
  // chunk gets rebuilt from the LRU cache.
  c.fillStyle = th.wallColor;
  c.fillRect(x0 - _CHUNK_G, y0 - _CHUNK_G, cv.width, cv.height);
  const mortarWall = _shadeHexColor(th.wallColor, -0.45);
  const mortarWallRace10 = _shadeHexColor(_RACE10_WALL, -0.45);
  const mortarWallGw = _shadeHexColor(_GW_WALL, -0.45);
  const mortarWallFarm = _shadeHexColor(_FARM_WALL, -0.45);
  const mortarWallCoop = _shadeHexColor(_COOP_WALL, -0.45);
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      if (dungeon.grid[ty][tx] !== WALL) continue;
      const x = tx * TILE, y = ty * TILE;
      const inTower = _isRace10Tile(tx, ty);
      const inGw = !inTower && _isGuildWarTile(tx, ty);
      const inFarm = !inTower && !inGw && _isFarmZoneTile(tx, ty);
      const inCoop = !inTower && !inGw && !inFarm && _isCoopTile(tx, ty);
      const wallBase = inTower ? _RACE10_WALL : inGw ? _GW_WALL : inFarm ? _FARM_WALL : inCoop ? _COOP_WALL : th.wallColor;
      const mortar = inTower ? mortarWallRace10 : inGw ? mortarWallGw : inFarm ? mortarWallFarm : inCoop ? mortarWallCoop : mortarWall;
      c.fillStyle = _shadeHexColor(wallBase, (_tileHash(tx, ty, 10) - 0.5) * 0.15);
      c.fillRect(x, y, TILE, TILE);
      c.fillStyle = mortar;
      if (ty % 2 === 0) c.fillRect(x, y, TILE, 2);
      if (tx % 2 === 0) c.fillRect(x, y, 2, TILE);
      if (_tileHash(tx, ty, 11) < 0.12) {
        const cx = x + 6 + _tileHash(tx, ty, 12) * (TILE - 12);
        const cy = y + 6 + _tileHash(tx, ty, 13) * (TILE - 12);
        _drawCrack(c, cx, cy, tx, ty, mortar, 7);
      }
    }
  }

  // 2. Floor — per-tile procedural flagstone: shade blended between this
  // theme's floorA/floorB, 2px mortar seams on the tile's own right/bottom
  // edge, occasional cracks, and occasional grime/blood stains.
  const mortarFloor = _shadeHexColor(th.floorA, -0.35);
  const mortarFloorRace10 = _shadeHexColor(_RACE10_FLOOR_A, -0.35);
  const mortarFloorGw = _shadeHexColor(_GW_FLOOR_A, -0.35);
  const mortarFloorFarm = _shadeHexColor(_FARM_FLOOR_A, -0.35);
  const mortarFloorCoop = _shadeHexColor(_COOP_FLOOR_A, -0.35);
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      if (dungeon.grid[ty][tx] !== FLOOR) continue;
      const x = tx * TILE, y = ty * TILE;
      const inTower = _isRace10Tile(tx, ty);
      const inGw = !inTower && _isGuildWarTile(tx, ty);
      const inFarm = !inTower && !inGw && _isFarmZoneTile(tx, ty);
      const inCoop = !inTower && !inGw && !inFarm && _isCoopTile(tx, ty);
      const floorA = inTower ? _RACE10_FLOOR_A : inGw ? _GW_FLOOR_A : inFarm ? _FARM_FLOOR_A : inCoop ? _COOP_FLOOR_A : th.floorA;
      const floorB = inTower ? _RACE10_FLOOR_B : inGw ? _GW_FLOOR_B : inFarm ? _FARM_FLOOR_B : inCoop ? _COOP_FLOOR_B : th.floorB;
      const mortar = inTower ? mortarFloorRace10 : inGw ? mortarFloorGw : inFarm ? mortarFloorFarm : inCoop ? mortarFloorCoop : mortarFloor;
      c.fillStyle = _lerpHexColor(floorA, floorB, _tileHash(tx, ty, 0));
      c.fillRect(x, y, TILE, TILE);
      c.fillStyle = mortar;
      c.fillRect(x, y + TILE - 2, TILE, 2);
      c.fillRect(x + TILE - 2, y, 2, TILE);
      if (_tileHash(tx, ty, 1) < 0.1) {
        const crx = x + 8 + _tileHash(tx, ty, 2) * (TILE - 16);
        const cry = y + 8 + _tileHash(tx, ty, 3) * (TILE - 16);
        _drawCrack(c, crx, cry, tx, ty, mortar, 6);
      }
      // Bloodier and far more frequent stains inside the tower — the whole
      // point of the reskin is that it actually looks like the name. Coop is
      // excluded: a red blood blob doesn't fit "dark green with grass" the
      // way it still reads fine on the other, still-stone-toned reskins.
      const stainChance = inTower ? 0.35 : 0.06;
      if (!inCoop && _tileHash(tx, ty, 4) < stainChance) {
        const sx = x + TILE * (0.3 + _tileHash(tx, ty, 5) * 0.4);
        const sy = y + TILE * (0.3 + _tileHash(tx, ty, 6) * 0.4);
        _drawStain(c, sx, sy, 8 + _tileHash(tx, ty, 8) * 6, inTower ? 'rgba(140,10,10,0.55)' : 'rgba(60,10,10,0.35)');
      }
      // Guild War: scorched siege ground — frequent dark ash patches, plus a
      // rare glowing violet ember that echoes the tower's crystal roof gems,
      // so the courtyard reads as "battlefield under a haunted tower" rather
      // than a copy-pasted dungeon floor.
      if (inGw) {
        if (_tileHash(tx, ty, 14) < 0.22) {
          const sx = x + TILE * (0.25 + _tileHash(tx, ty, 15) * 0.5);
          const sy = y + TILE * (0.25 + _tileHash(tx, ty, 16) * 0.5);
          _drawStain(c, sx, sy, 7 + _tileHash(tx, ty, 17) * 6, 'rgba(6,4,10,0.6)');
        }
        if (_tileHash(tx, ty, 18) < 0.035) {
          const sx = x + TILE * (0.3 + _tileHash(tx, ty, 19) * 0.4);
          const sy = y + TILE * (0.3 + _tileHash(tx, ty, 20) * 0.4);
          _drawStain(c, sx, sy, 5 + _tileHash(tx, ty, 21) * 3, 'rgba(168,85,247,0.5)');
        }
      }
      // Coop: frequent grass tufts (bright green blade clusters) plus rarer,
      // darker earth patches where the grass thins out — reads as an
      // overgrown dungeon floor rather than a flat colour swap.
      if (inCoop) {
        if (_tileHash(tx, ty, 25) < 0.5) {
          const gx = x + TILE * (0.2 + _tileHash(tx, ty, 26) * 0.6);
          const gy = y + TILE * (0.35 + _tileHash(tx, ty, 27) * 0.55);
          _drawGrassTuft(c, gx, gy, tx, ty, `rgba(120,210,110,${0.5 + _tileHash(tx, ty, 28) * 0.35})`);
        }
        if (_tileHash(tx, ty, 29) < 0.05) {
          const sx = x + TILE * (0.3 + _tileHash(tx, ty, 30) * 0.4);
          const sy = y + TILE * (0.3 + _tileHash(tx, ty, 31) * 0.4);
          _drawStain(c, sx, sy, 6 + _tileHash(tx, ty, 32) * 5, 'rgba(30,20,10,0.4)');
        }
      }
    }
  }

  // 3. Wall "cliff face" strip above floor (top-down depth cue) — beveled
  // gradient (dark at top fading to base wallColor) with a soft highlight
  // line along the very top edge for a lit-edge depth cue.
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      if (dungeon.grid[ty][tx] !== WALL) continue;
      if (!isFloor(tx, ty + 1)) continue;
      const wallBase = _isRace10Tile(tx, ty) ? _RACE10_WALL
        : _isGuildWarTile(tx, ty) ? _GW_WALL
        : _isFarmZoneTile(tx, ty) ? _FARM_WALL
        : _isCoopTile(tx, ty) ? _COOP_WALL : th.wallColor;
      const x = tx * TILE, y = ty * TILE + TILE - 10;
      const grad = c.createLinearGradient(0, y, 0, y + 10);
      grad.addColorStop(0, _shadeHexColor(wallBase, -0.5));
      grad.addColorStop(1, wallBase);
      c.fillStyle = grad;
      c.fillRect(x, y, TILE, 10);
      c.fillStyle = _shadeHexColor(wallBase, 0.35);
      c.fillRect(x, y, TILE, 2);
    }
  }

  // 4. Shadows cast onto floor from walls above / beside
  c.fillStyle = 'rgba(0,0,0,0.4)';
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      if (dungeon.grid[ty][tx] !== FLOOR) continue;
      if (!isFloor(tx, ty - 1)) c.fillRect(tx * TILE, ty * TILE, TILE, 6);
    }
  }
  c.fillStyle = 'rgba(0,0,0,0.2)';
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      if (dungeon.grid[ty][tx] !== FLOOR) continue;
      const x = tx * TILE, y = ty * TILE;
      if (!isFloor(tx - 1, ty)) c.fillRect(x, y, 4, TILE);
      if (!isFloor(tx + 1, ty)) c.fillRect(x + TILE - 4, y, 4, TILE);
    }
  }

  // 5. Floor props — painted clutter (crates, chests, boulders, stumps, etc.)
  // scattered sparsely on floor tiles. Same own-tile-block scoping as the
  // wall decor pass above, so seams never get a doubled-up prop.
  const ptx0 = cx * _CHUNK_T, pty0 = cy * _CHUNK_T;
  const ptx1 = Math.min(dungeon.w - 1, ptx0 + _CHUNK_T - 1);
  const pty1 = Math.min(dungeon.h - 1, pty0 + _CHUNK_T - 1);
  if (th.drawFloorProp) {
    for (let ty = pty0; ty <= pty1; ty++) {
      for (let tx = ptx0; tx <= ptx1; tx++) {
        if (dungeon.grid[ty][tx] !== FLOOR) continue;
        const h = ((tx * 41) ^ (ty * 59)) & 0xff;
        c.save();
        th.drawFloorProp(c, tx * TILE, ty * TILE, h);
        c.restore();
      }
    }
  }

  // 6. Wall-mounted torch brackets — sparse, deterministic per (tx,ty). Only
  // the iron bracket is baked into this static texture; the flickering flame
  // and its warm light pooling onto the floor are animated live every frame
  // (see _updateLights in pixi-world.js) off the anchor points collected here.
  const torchList = [];
  for (let ty = pty0; ty <= pty1; ty++) {
    for (let tx = ptx0; tx <= ptx1; tx++) {
      if (dungeon.grid[ty][tx] !== WALL || !isFloor(tx, ty + 1)) continue;
      if (_tileHash(tx, ty, 90) >= 0.05) continue;
      const bx = tx * TILE + TILE / 2, by = ty * TILE + TILE - 6;
      c.fillStyle = '#2a2018';
      c.fillRect(bx - 3, by - 10, 6, 10);
      c.fillStyle = '#4a3826';
      c.fillRect(bx - 5, by - 12, 10, 3);
      torchList.push({ x: bx, y: by - 12 });
    }
  }
  _chunkTorches.set(cx + ',' + cy, torchList);

  return cv;
}


function playerDie() {
  // Guarded because several paths can report the same death (a playerHurt
  // and a pvpDamage for the killing blow, plus the server re-announcing an
  // unacknowledged death — see updatePlayerPos, server/game/Room.js). Only
  // the first one should count: re-running this would restart the 5-minute
  // XP penalty from scratch every time.
  if (state === 'dead') return;
  state = 'dead';
  const modal = document.getElementById('death-modal');
  if (!modal) return;
  // Stored as remaining seconds in player.buffs (like every other timed buff/
  // debuff) instead of a standalone client-only timestamp — that variable
  // reset to 0 on every page refresh/reconnect since it was never part of
  // the saved/restored player state, silently letting a refresh clear the
  // penalty. buffs.* already round-trips through saveProgress/restoreFromSave
  // and ticks down in the existing per-frame buff-timer loop for free.
  // Assigning (not adding) also gives the "dying again resets the timer"
  // behavior for free.
  if (player) (player.buffs || (player.buffs = {})).deathPenalty = 5 * 60;
  const info = document.getElementById('death-info');
  if (info && player) {
    const _dRoom = (typeof _getRoomAt === 'function') ? _getRoomAt(player.x, player.y) : null;
    const _dLoc = (_dRoom?.arm && typeof _armLabel === 'function')
      ? `${_armLabel(_dRoom.arm)} ${typeof t === 'function' ? t('corridorSuffix') : 'коридор'} · ${typeof t === 'function' ? t('levelAbbrev') : 'Ур.'} ${_dRoom.monsterLvl}` : (typeof t === 'function' ? t('centralHall') : 'Центральный зал');
    info.innerHTML =
      `<span class="death-stat">${_dLoc}</span>` +
      `<span class="death-stat">${Math.floor(player.gold)} <span class="death-lbl">${typeof t === 'function' ? t('deathGoldLbl') : 'золота'}</span> · ${player.kills} <span class="death-lbl">${typeof t === 'function' ? t('deathKillsLbl') : 'убийств'}</span></span>`;
  }
  const penaltyEl = document.getElementById('death-penalty');
  if (penaltyEl) penaltyEl.style.display = 'block';
  modal.style.display = 'flex';
}

function respawnPlayer() {
  if (!player || state !== 'dead') return;
  targetId = null; targetIsPlayer = false; _chaseArmed = false;
  player.hp = Math.max(1, Math.floor(player.maxHp * 0.1));
  player.hurtTimer = 0;
  player.atkTimer = 0.5;
  if (dungeon) {
    player.x = dungeon.spawn.x; player.y = dungeon.spawn.y;
    camera.x = player.x - W / (2 * ZOOM); camera.y = player.y - _visH() / 2;
    clampCamera();
  }
  state = 'playing';
  document.getElementById('death-modal').style.display = 'none';
  dmgNum(player.x, player.y - 30, typeof t === 'function' ? t('deathXpPenalty') : '−50% XP (5 мин)', '#c4838a');
  // 'respawn' first, and no playerMove alongside it: the server's own
  // respawnPlayer() puts us back at the same spawn point this function just
  // moved to, so the move was always redundant — and sending it while the
  // server still has us at hp<=0 now bounces a "you're dead" notice straight
  // back at us (see updatePlayerPos, server/game/Room.js), which would land
  // just after this and kill us again the instant we respawned.
  if (socket?.connected) socket.emit('respawn');
  netSaveProgress();
}

// ─────────────────────────────────────────────────────────
//  LOOP
// ─────────────────────────────────────────────────────────
// Driven by requestAnimationFrame so every frame lands exactly on a vsync
// boundary — a setTimeout-scheduled loop fires at arbitrary offsets from the
// display's refresh, which reads as constant micro-stutter even when the
// average rate is steady.
//
// render() used to be skipped on mobile when less than ~32ms had elapsed
// since the last one (an attempt at a ~30fps cap to save heat/battery), then
// later replaced with a wall-clock accumulator (compare accumulated rAF time
// against a 33.33ms threshold). Both were reverted for the same underlying
// reason: real rAF timestamps jitter by a millisecond or two from OS/GPU
// scheduling noise, and whenever that jitter tips a threshold comparison the
// wrong way at the wrong moment, one render lands early to "catch up" right
// after a skipped one — a visible double-step in on-screen motion. This was
// confirmed directly: frame-by-frame analysis of a user-reported jitter
// video measured a repeating ~12px/12px/12px/24px world-position displacement
// pattern, the exact signature of an occasional swallowed-then-caught-up
// tick, not smooth motion.
//
// Fix: render every Nth native rAF *tick*, N picked from the device's own
// measured refresh rate, instead of comparing elapsed time to a threshold.
// Counting ticks is immune to per-tick duration jitter — the trigger is
// "this is tick number N", not "has enough time passed", so a tick that runs
// long or short doesn't shift when the next render fires.
let _loopTs = 0;
let _lastRenderTs = 0;
// dt smoother. A flat N-frame average decouples on-screen motion from real
// elapsed time: the value it feeds update() lags the true frame duration by up
// to N frames, so when frame times wobble the player/camera position drifts
// behind then catches up — visible as micro-judder during movement even when
// the frame cadence itself is perfectly steady (confirmed on-device: a phone
// sitting at a rock-steady 30fps with <2ms/frame of work still juddered while
// moving). The window exists only to cancel the period-2 rAF jitter some mobile
// GPUs show (alternating short/long native gaps), and an *even* window of 2 already
// cancels that exactly — (a+b)/2 is constant for an a,b,a,b sequence — so N=2
// keeps the one benefit while halving the lag that causes the drift. (At the
// 30fps cap each rendered frame already spans two native gaps, which self-cancels
// period-2 at the source, making even a 2-frame average conservative there.)
const _DT_SMOOTH_N = 2;
const _dtBuf = new Float32Array(_DT_SMOOTH_N).fill(1 / 30);
let _dtBufIdx = 0;

const _FPS_CAP_MS = 1000 / 30; // ~33.33ms — first-frame fallback for sinceLastRender
// ── Physics sub-stepping ──────────────────────────────────────────────────
// dt used to be hard-clamped to _PHYS_STEP_MAX, which silently threw away
// every millisecond a frame ran longer than that. Movement is dt-scaled
// (player.x += speed * dt), so below ~20fps the character genuinely covered
// less ground per real second — at 10fps, half speed; at 6fps, a third. Auto
// -attack cadence and HP regen ride on the same dt and were penalised too.
// (Buffs, cooldowns and crowd control were never affected — they run on
// realDt, see the block in update().)
//
// The clamp itself was right to exist: collision here is a plain per-axis
// check against the destination, with no swept test, so one oversized step
// can put the player through a wall. The fix is to keep steps small but stop
// discarding the leftover — simulate a long frame as several ≤_PHYS_STEP_MAX
// steps instead of one truncated one. Real-time speed then holds at any frame
// rate while no single step is ever bigger than what the clamp already
// allowed.
//
// _PHYS_STEPS_MAX bounds the catch-up so a long stall (tab switch, screen
// lock, GC pause) can't replay seconds of movement in one frame; past that
// the extra time is dropped exactly as it always was. At 20fps and above a
// frame needs one step, so the common path stays bit-for-bit what it was.
const _PHYS_STEP_MAX  = 0.05; // seconds — the old dt clamp, now the step size
const _PHYS_STEPS_MAX = 4;    // ≤200ms of catch-up per rendered frame
// Target render cadence: 60fps on every device, including phones. The 30fps
// mobile cap was justified as heat/battery savings, but the built-in overlay
// disproved that on real hardware: a phone sat at a steady 30fps spending only
// ~0.8ms in update() and ~1.1ms in render() — under 2ms of a 33ms frame, ~15×
// headroom. The GPU idles either way, so the cap saved almost no power while
// forcing 30fps, and full-screen camera panning at 30fps reads as visible
// judder on the 60/90/120Hz screens phones now ship with — the exact symptom
// reported. Net-send rate is decoupled from frame rate (netSendMove is capped
// to 40Hz), so 60fps adds only cheap extra draws, not radio/CPU wakeups. The
// tick-counting scheduler below yields an even cadence at any divisor (N=1
// included), so this is steady 60fps, not the jittery 60fps the cap once
// guarded against; a device that genuinely can't hold 60 simply renders slower
// (rAF delivers fewer ticks) and the adaptive-quality tier still trims particle
// load below 20fps.
const _TARGET_FRAME_MS = 1000 / 60;
// Refresh-rate detection: the native frame interval is the *shortest* real gap
// between rAF ticks — jank only ever makes a frame longer, never shorter. The
// old code averaged the first dozen ticks, but those land on the jankiest
// moment of the session (sprite decode stalls right after load); a slow startup
// inflated the average, so round(target/avg) collapsed to 1 and the cap silently
// became "render every tick" (full native rate, no cap). Instead, sample a longer
// window and take a low percentile of the intervals: robust against both the
// slow startup frames (they sit at the high end, ignored) and the occasional
// sub-native catch-up frame after a stall (a handful at the very low end, also
// skipped). Rendering runs at native rate during this ~0.5s window — a cost not
// worth avoiding. N is then locked for the rest of the session.
const _RATE_DETECT_TICKS = 30;
const _detectBuf = new Float32Array(_RATE_DETECT_TICKS);
let _detectCount = 0;
let _renderEveryN = null;
let _tickCounter = 0;

function loop(ts) {
  const rAFMs = ts - _loopTs; _loopTs = ts;

  if (_renderEveryN === null) {
    // Guard >4ms rejects spurious sub-native catch-up glitches while still
    // admitting up to ~240Hz displays (4.16ms); <100ms drops tab-switch stalls.
    if (rAFMs > 4 && rAFMs < 100) _detectBuf[_detectCount++] = rAFMs;
    if (_detectCount >= _RATE_DETECT_TICKS) {
      const sorted = Array.from(_detectBuf).sort((a, b) => a - b);
      const nativeMs = sorted[Math.floor(_RATE_DETECT_TICKS * 0.2)]; // ~20th pct
      _renderEveryN = Math.max(1, Math.round(_TARGET_FRAME_MS / nativeMs));
    }
  } else {
    _tickCounter++;
    if (_tickCounter % _renderEveryN !== 0) { requestAnimationFrame(loop); return; }
  }

  // dt = actual wall-clock time since the last render, not a derived budget —
  // avoids inflating physics speed on sub-30fps devices. Bounded by the total
  // catch-up budget rather than truncated to a single step: the loop below
  // splits whatever lands here into steps no longer than _PHYS_STEP_MAX.
  const sinceLastRender = _lastRenderTs > 0 ? ts - _lastRenderTs : _FPS_CAP_MS;
  _lastRenderTs = ts;
  const frameMs = Math.min(sinceLastRender, _PHYS_STEP_MAX * _PHYS_STEPS_MAX * 1000);
  const rawDt = frameMs / 1000;
  _dtBuf[_dtBufIdx] = rawDt;
  _dtBufIdx = (_dtBufIdx + 1) % _DT_SMOOTH_N;
  let dt = 0;
  for (let i = 0; i < _DT_SMOOTH_N; i++) dt += _dtBuf[i];
  dt /= _DT_SMOOTH_N;
  // Unclamped wall-clock delta, for anything that must expire on real time
  // rather than on rendered frames. rAF stops entirely while the page is
  // hidden (screen lock, app switch, another Telegram chat) and dt above is
  // bounded to _PHYS_STEP_MAX × _PHYS_STEPS_MAX per frame, so buffs and
  // cooldowns ticked on dt froze for the whole background period — a 10s buff
  // could outlive half an hour of real time. Physics stays on the bounded dt
  // (see the comment above it).
  const realDt = sinceLastRender / 1000;
  const _t0 = performance.now();
  // One step at 20fps+ (identical to the old single update() call); more only
  // when the frame overran, so the time is caught up instead of discarded.
  // realDt is divided the same way so buffs/cooldowns still tick exactly once
  // over the frame's real duration rather than once per step.
  const _steps = Math.min(_PHYS_STEPS_MAX, Math.max(1, Math.ceil(dt / _PHYS_STEP_MAX)));
  const _stepDt = dt / _steps;
  const _stepRealDt = realDt / _steps;
  // update()/render() used to run unguarded — one exception on one frame (a
  // specific class/pet/zone edge case, an unloaded texture, whatever) threw
  // out of loop() before reaching the requestAnimationFrame(loop) call below,
  // so it was never rescheduled: the whole client froze on the last frame
  // that DID render (which, since pixiWorldRender runs before the HUD canvas
  // is cleared/redrawn in render(), often left a perfectly normal-looking
  // HUD on screen forever while the world behind it stopped updating —
  // "game won't load" reports with an otherwise fine-looking header/HUD
  // match this exactly). Catch here so a bad frame logs instead of
  // permanently killing every frame after it; the try/finally keeps
  // rescheduling unconditionally so the loop self-heals next frame if the
  // failure was transient/state-dependent.
  try {
    for (let i = 0; i < _steps; i++) update(_stepDt, _stepRealDt);
    const _t1 = performance.now();
    render(dt, ts);
    const _t2 = performance.now();
    _profUpdate = _t1 - _t0;
    _profRender = _t2 - _t1;
  } catch (err) {
    console.error('[loop] frame crashed, continuing:', err);
    // A frame that throws once is noise; a frame that throws every frame is a
    // broken game that still looks alive, because the loop keeps rescheduling.
    // Reported through the same throttled path as everything else — the server
    // collapses repeats, so 60 identical failures a second become one alert.
    if (typeof window.__reportClientError === 'function') {
      window.__reportClientError('frame', err && err.message, err && err.stack);
    }
  } finally {
    _profSocketEvtsSnap = _profSocketEvts; _profSocketEvts = 0;
    _profSocketMsSnap = _profSocketMs; _profSocketMs = 0;
    if (_uiCtx) _drawPerf(frameMs);
    requestAnimationFrame(loop);
  }
}

window.addEventListener('beforeunload', () => { netSaveProgressNow(); });
// Mobile browsers rarely fire beforeunload — flush the save when the app
// goes to background (tab switch, screen lock, app switcher)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { netSaveProgressNow(); return; }
  // Coming back, the last render timestamp is as old as the time spent away —
  // the watchdog has to be told when the clock started running again, or it
  // reads a paused tab as a dead renderer.
  _visibleSince = performance.now();
  // ── everything on screen is as old as the time spent away ────────────────
  // rAF is paused while the app is backgrounded, so the last frame drawn is
  // whatever was true when the player switched away — and the world cast is
  // volatile, so most of what happened meanwhile was dropped rather than
  // queued. Coming back to a stale picture is exactly "моби пропадають, якась
  // херня". Three things put it right, and all three are cheap:
  //   the viewport, which the WebView may have resized while hidden;
  //   the enemy stream, asked for in full rather than waited for;
  //   the camera, in case anything drifted while nothing was drawing it.
  if (_doResize) _doResize(true);
  if (typeof netResyncWorld === 'function') netResyncWorld();
  if (dungeon) clampCamera();
  // Coming back to the foreground: requestAnimationFrame (and with it,
  // update()/render()) is paused for the entire time the tab is hidden, but
  // socket messages still get processed as they arrive, so a fatal
  // 'playerHurt' while backgrounded already set player.hp to 0 and flipped
  // state to 'dead' correctly — this is just a defensive catch-all in case
  // that ever races with a reconnect (see the gameStart handler in
  // network.js for the main fix) and leaves hp at 0 without state following.
  if (player && player.hp <= 0 && state !== 'dead' && typeof playerDie === 'function') playerDie();
});

// ── the blank-world watchdog ────────────────────────────────────────────────
// Two failures produce the same picture — a grey rectangle under a working
// HUD — and neither announced itself:
//
//   * the renderer never came up (WebGL refused a context at startup)
//   * the renderer came up and then lost its context (backgrounded WebView,
//     GPU process restart, memory pressure)
//
// Both are recoverable by building a new renderer, and both are transient, so
// retrying is the right response rather than an apology. The attempts back off
// and stop, because a device that genuinely cannot do WebGL should not be made
// to try forever — at that point the player is told, once, instead of being
// left to guess at a grey screen.
let _pixiRetries = 0;
let _pixiRetryTimer = null;
const _PIXI_MAX_RETRIES = 5;
// resize() is defined inside the load listener because it closes over the app
// element; a rebuild needs to call it, so it is published here.
let _doResize = null;

// The one place a renderer is rebuilt. pixiRecover replaces the canvas ELEMENT
// (a used one can never be handed a working context again), so everything
// pointing at the old element has to be moved across: the `canvas` global, the
// five input listeners bound to it, the renderer's size, and the tile cache,
// whose GPU textures died with the old context.
//
// Rebuilding the renderer without this leaves a world that draws and does not
// respond — which would read as a worse bug than the blank screen it fixed.
function _pixiRebuild() {
  const fresh = pixiRecover(canvas);
  if (!fresh) return false;
  canvas = fresh;
  if (typeof bindCanvasInput === 'function') bindCanvasInput(canvas);
  if (_doResize) _doResize(true);
  buildTileCanvas();
  _pixiRetries = 0;
  return true;
}

function _pixiRetry(canvasEl, err) {
  if (_pixiRetryTimer) return;

  // A device with no WebGL at all is not a transient failure. An iPhone with
  // it disabled answered "no webgl2 · no webgl1" and then got five retries,
  // each throwing the same "Unable to auto-detect a suitable renderer" — a
  // dozen seconds of pointless work and a stack trace in the alerts topic for
  // a phone that was never going to render anything. Say so once and stop.
  if (!pixiWebglSupported()) {
    if (typeof window.__reportClientError === 'function') {
      window.__reportClientError('pixi-unsupported',
        `на устройстве нет WebGL — ${pixiWebglDiagnosis(canvasEl)}`);
    }
    _pixiRetries = _PIXI_MAX_RETRIES;
    _pixiGiveUp({ unsupported: true });
    return;
  }

  if (_pixiRetries === 0 && err && typeof window.__reportClientError === 'function') {
    // Reported on the FIRST failure, with the device's own explanation, so a
    // phone that cannot start the world is visible in the alerts topic rather
    // than only in a screenshot somebody happens to send.
    //
    // Only when there IS an error to report: the restore path calls this with
    // null after a context that simply was not ready yet, which is an ordinary
    // step in recovering and not something to wake anyone up about.
    window.__reportClientError('pixi-init',
      `${err.message || 'WebGL недоступен'} — ${pixiWebglDiagnosis(canvasEl)}`,
      err.stack);
  }
  if (_pixiRetries >= _PIXI_MAX_RETRIES) {
    _pixiGiveUp();
    return;
  }
  // 400ms, 800ms, 1.6s, 3.2s, 6.4s — long enough for a GPU process to come
  // back, short enough that a player who is already looking at the screen sees
  // it fix itself.
  const delay = 400 * Math.pow(2, _pixiRetries++);
  _pixiRetryTimer = setTimeout(() => {
    _pixiRetryTimer = null;
    // Deliberately silent on success. A player who was looking at a grey
    // screen sees the world appear, which is the whole message; a banner
    // explaining what just fixed itself is noise.
    if (!_pixiRebuild()) _pixiRetry(canvas, null);
  }, delay);
}

// ── the one thing the player is ever told about the graphics failing ───────
// Its own element, drawn over everything. showAuthError() writes into the
// LOGIN screen's error line, which nobody in the game can see — the message
// has to appear where the black rectangle is.
//
// ONE element id, deliberately, and that is what keeps two of these from
// stacking. Three failures now end up here — the renderer gave up, the device
// has no WebGL at all, the world never drew — and more than one of them can be
// true at the same moment (a dead renderer is also a blank world). Two boxes
// on top of each other tell a player nothing the first one didn't, so whoever
// arrives first speaks and everyone after finds the id taken.
//
// `src` records who raised it, because only one of them can ever take it back
// down: the watchdog can watch its own cause clear, _pixiGiveUp cannot — it
// only runs once the retries are spent.
//
// The text is Russian in place rather than a t() lookup, the same way the
// WebGL message this grew out of already was: this banner exists for a client
// that is already failing, and reaching through the locale tables to explain
// why the game is broken adds one more thing that can be broken.
function _gfxBanner(src, text, actionLabel, action) {
  if (document.getElementById('gfx-dead')) return;
  const box = document.createElement('div');
  box.id = 'gfx-dead';
  box.dataset.src = src;
  box.style.cssText = 'position:fixed;left:50%;top:45%;transform:translate(-50%,-50%);'
    + 'max-width:80vw;background:#2a1616;border:1px solid #b05a5a;color:#e8c4c4;'
    + 'padding:14px 18px;border-radius:12px;font-size:14px;line-height:1.45;'
    + 'text-align:center;z-index:99999';
  const msg = document.createElement('div');
  msg.textContent = text;
  box.appendChild(msg);
  if (actionLabel) {
    const btn = document.createElement('button');
    btn.id = 'gfx-dead-btn';
    // touch-action is `none` on everything (css/style.css `*`) so the game
    // canvas never scrolls under a joystick drag; a button inside a banner is
    // the one place that has to opt back in, or the tap is eaten on mobile —
    // which would leave the player looking at a button that does nothing,
    // which is worse than not offering one.
    btn.style.cssText = 'margin-top:12px;background:#4a2222;border:1px solid #b05a5a;'
      + 'color:#f0dede;padding:8px 18px;border-radius:9px;font-size:14px;'
      + 'cursor:pointer;touch-action:manipulation';
    btn.textContent = actionLabel;
    btn.onclick = action;
    box.appendChild(btn);
  }
  document.body.appendChild(box);
}

function _pixiGiveUp({ unsupported = false } = {}) {
  // The unsupported case has already reported itself, with a better message.
  if (!unsupported && typeof window.__reportClientError === 'function') {
    window.__reportClientError('pixi-dead',
      `сдались после ${_PIXI_MAX_RETRIES} попыток — ${pixiWebglDiagnosis(canvas)}`);
  }
  // No button on either: a device with no WebGL will not grow any by
  // reloading, and the retries have already done the reloading equivalent
  // five times over. The instruction is the only useful thing left to give.
  _gfxBanner('gfx', unsupported
    ? 'Этот браузер не поддерживает WebGL, без него игра не рисуется. '
      + 'Откройте игру в Telegram или в Chrome/Safari — и проверьте, что в настройках '
      + 'браузера включено аппаратное ускорение.'
    : 'Графика не запустилась на этом устройстве. '
      + 'Закройте и откройте игру заново — если не поможет, перезапустите Telegram.');
}

// Checked once a second, not every frame: the question is "has the world drawn
// at all recently", and asking it 60 times a second answers it no better.
//
// Every condition below is a case where NOT drawing is correct, and each one
// would otherwise be a false alarm that restarts a perfectly healthy renderer:
//
//   select        — character selection, the world is deliberately hidden
//   activeTab     — a menu is open and render() returns before the world (see
//                   the early return at the top of render())
//   document.hidden — requestAnimationFrame is paused by the browser
//   _visibleSince — just came back from the background, where the last render
//                   timestamp is by definition old
let _visibleSince = 0;
// ── and a THIRD failure, which the watchdog above could not see at all ─────
// The renderer is alive. It is drawing sixty frames a second. Of nothing.
//
// "Заходжу в апку, інтерфейс є, екран чорний." The interface is DOM and a
// separate 2D canvas, so it comes up regardless — and a world with no map, or
// a canvas the WebView laid out at zero height, or tiles that were never
// built, renders perfectly happily in black. Ask "did it render recently" and
// the answer is yes, every time, forever.
//
// So the question has to be what the world CONTAINS. Each answer below has its
// own recovery, because restarting the renderer fixes none of them.
const _WD_GRACE_MS = 4000;
const _wdReported = new Set();   // one alert per distinct cause per episode
let _wdWhy = null, _wdWhySince = 0;
// How many times the SAME cause has survived its own recovery. The recoveries
// below get harder as this climbs, and at the end of them the player is told —
// see _worldGiveUp. Not on the first strike: the recoveries usually work, and
// a banner that flashes every time the world quietly heals itself is what
// teaches a player to ignore the one time it doesn't.
const _WD_GIVE_UP_STRIKES = 3;
let _wdStrikes = 0;

function _worldBlankWhy() {
  if (!canvas) return 'no-canvas';
  // #app can be laid out at zero height for the first frames after Telegram
  // opens the Mini App, and every size in the game is derived from it — so a
  // zero here is a zero everywhere, including both canvases.
  // Свёрнутое приложение — не поломка. document.hidden здесь именно для
  // этого: раньше сторож честно видел экран 0x0 и честно об этом писал, но
  // сообщал он о том, что игрок переключился на другое окно, а выглядело это
  // как «у игрока чёрный экран». Настоящий нулевой экран у ВИДИМОЙ страницы
  // по-прежнему докладывается.
  if (document.hidden) return null;
  if (!(W > 8) || !(H > 8)) return 'zero-viewport';
  if (canvas.clientWidth < 8 || canvas.clientHeight < 8) return 'zero-canvas';
  if (!pixiAlive()) return 'no-renderer';
  if (performance.now() - pixiLastRenderTs() > _WD_GRACE_MS) return 'not-rendering';
  // No map means the server never told us about a floor (or told us and the
  // world-map fetch behind it failed). Nothing local can conjure one.
  if (!dungeon || !dungeon.grid) return 'no-map';
  // A map with no rasterised chunk is a floor that was never drawn — the tile
  // cache is rebuilt by buildTileCanvas(), which a floor change already calls.
  if (typeof _chunkSprCache !== 'undefined' && _chunkSprCache.size === 0) return 'no-tiles';
  // Last resort: everything looks right and the GPU was still handed nothing.
  if (typeof gpuStats === 'function' && gpuStats().draws === 0) return 'nothing-drawn';
  return null;
}

// Everything an operator needs to tell these apart from a phone they cannot
// hold. Numbers, not adjectives.
const _n = v => (Number.isFinite(v) ? Math.round(v) : String(v));
function _tileRangeStr() {
  if (typeof pixiTileRange !== 'function') return '?';
  const r = pixiTileRange();
  // Written out rather than left to be worked out from four numbers, and NaN
  // reads as ПУСТ too (every comparison against NaN is false), which is the
  // shape a non-finite camera makes.
  const empty = !(r.c0x <= r.c1x && r.c0y <= r.c1y);
  return 'x' + r.c0x + '..' + r.c1x + ' y' + r.c0y + '..' + r.c1y
    + (empty ? ' ПУСТ' : '')
    + ' постр.' + r.built
    + ' проход ' + (r.ranAt ? Math.round(performance.now() - r.ranAt) + 'мс назад' : 'НЕ ШЁЛ')
    + (r.failed ? ' СБОЙ_СБОРКИ x' + r.fails + ': ' + String(r.err).slice(0, 70) : '');
}
function _worldFacts() {
  const g = (typeof gpuStats === 'function') ? gpuStats() : { draws: -1, verts: -1 };
  return [
    'экран ' + W + 'x' + H + ' @' + (DPR || 0).toFixed(2),
    'canvas ' + (canvas ? canvas.clientWidth + 'x' + canvas.clientHeight : 'нет'),
    'pixi ' + (pixiAlive() ? 'жив' : 'мёртв'),
    // dungeon.w/h is what the CHUNK RANGE is computed from; dungeon.grid is
    // what the chunk builder indexes. They are supposed to agree and the
    // report only ever carried the first — and every tile pass reads
    // grid[ty][tx] unguarded inside a range derived from w/h, so a grid
    // shorter than h is a TypeError on every chunk with a map that looks
    // perfectly fine in the alert.
    'карта ' + (dungeon && dungeon.grid ? dungeon.w + 'x' + dungeon.h + ' эт.' + dungeonLvl : 'НЕТ'),
    'сетка ' + (dungeon && dungeon.grid
      ? dungeon.grid.length + 'x' + (dungeon.grid[0] ? dungeon.grid[0].length : '?')
      : 'НЕТ'),
    'чанки ' + (typeof _chunkSprCache !== 'undefined' ? _chunkSprCache.size : '?') + '/' + _tileChunks.size,
    // "no tiles" has two very different causes and the first report of it
    // could not tell them apart: the tile pass computed an EMPTY chunk range
    // (camera outside the map — nothing to build), or it tried and the build
    // threw. The range and the camera say which.
    'диапазон ' + _tileRangeStr(),
    // And a third cause neither of those can show, because it happens OUTSIDE
    // the chunk build's own try/catch and is swallowed by _layer(): the tile
    // pass throwing on the texture upload or on a container that died with a
    // previous renderer. _layer reports that once, at the very start of the
    // session, in a different alert nobody is reading next to this one — so
    // the count is repeated here, where the question is being asked.
    'слои ' + (typeof pixiLayerFaults === 'function' ? (pixiLayerFaults() || 'ок') : '?'),
    'камера ' + _n(camera.x) + ',' + _n(camera.y),
    'игрок ' + (player ? _n(player.x) + ',' + _n(player.y) : 'нет'),
    'draws ' + g.draws,
    // Which recovery has already been tried and failed — and therefore
    // whether the player is looking at the give-up banner while reading this.
    'попытка ' + _wdStrikes,
    'контекст ' + (typeof pixiCtxCounts === 'function'
      ? (function (c) { return 'терял ' + c.lost + ', вернул ' + c.restored; })(pixiCtxCounts())
      : '?'),
    'сокет ' + (socket && socket.connected ? 'на связи' : 'НЕТ'),
    'кадр ' + Math.round(performance.now() - pixiLastRenderTs()) + 'мс назад',
  ].join(' · ');
}

// `чанки 0/0` on a valid map with a live renderer leaves exactly two
// possibilities, and it is the ZERO that narrows it to two: the pass stores
// the canvas in _tileChunks the instant _buildChunk returns, before any GPU
// work at all, so one single successful build in the whole session would have
// left a 1 there. Nothing was ever built. Which means either
//
//   the loop never entered its body — an empty chunk range; or
//   every build threw — _built is incremented BEFORE the try, so two failing
//   chunks spend the whole per-frame budget and nothing is ever stored.
//
// Only the first has a cheap fix, so it is tried on its own first.
function _recoverNoTiles() {
  if (_wdStrikes < 2) {
    // buildTileCanvas() only CLEARS the caches — chunks are built lazily by
    // the tile pass. So calling it here was not a recovery at all: it threw
    // away whatever existed and built nothing in its place.
    //
    // What actually stops the tile pass is a camera whose chunk range comes
    // out empty, and the only way that happens on a valid map is a camera
    // (or a player) that is not a finite number inside it: a clamped camera's
    // own bounds always overlap at least one chunk, so a finite one cannot
    // produce an empty range. clamp puts it back; the pass builds next frame.
    if (player && dungeon.spawn
        && (!Number.isFinite(player.x) || !Number.isFinite(player.y))) {
      player.x = dungeon.spawn.x; player.y = dungeon.spawn.y;
    }
    if (!Number.isFinite(camera.x) || !Number.isFinite(camera.y)) {
      camera.x = (player ? player.x : 0) - W / (2 * ZOOM);
      camera.y = (player ? player.y : 0) - _visH() / 2;
    }
    clampCamera();
    return;
  }
  // Once only, and only after the camera has been ruled out by having been
  // fixed and changing nothing. What is left is the pass itself failing every
  // frame, in one of the two places it can: inside _buildChunk (a 2D context
  // the WebView refused under canvas-memory pressure — the low-end Android
  // case), or after it, on the texture upload and _tileCt.addChild, which
  // _layer() swallows silently after its one report.
  //
  // Everything in the second group belongs to the renderer, so a fresh one is
  // the only lever that reaches it: a new element, a new context, new
  // containers, and every stale GPU handle dropped. It also frees the whole
  // chunk atlas, which is the largest thing this client holds and the most
  // likely reason a WebView started refusing 2D contexts in the first place.
  //
  // The fault latches go with it: they describe a renderer that no longer
  // exists, and leaving them set means the next failure — the one that says
  // whether this helped — is swallowed as a repeat.
  if (_wdStrikes !== 2) return;
  if (typeof pixiResetFaults === 'function') pixiResetFaults();
  if (!_pixiRebuild()) _pixiRetry(canvas, null);
}

// What the player is told once every recovery for this cause has been tried
// and the world is still black. Deliberately not a stack trace and not a
// cause code: they can act on "restart", and cannot act on 'no-tiles'.
const _WD_GIVE_UP_MSG = {
  'no-map': 'Сервер не прислал карту — строить мир не из чего. '
    + 'Перезапустите игру; если чёрный экран останется, напишите в поддержку.',
  'no-tiles': 'Карта пришла, но мир так и не отрисовался на этом устройстве. '
    + 'Перезапустите игру; если чёрный экран останется, напишите в поддержку.',
};
const _WD_GIVE_UP_ANY = 'Мир не запустился на этом устройстве. '
  + 'Перезапустите игру; если чёрный экран останется, напишите в поддержку.';

function _worldGiveUp(why) {
  _gfxBanner('world', _WD_GIVE_UP_MSG[why] || _WD_GIVE_UP_ANY,
    'Перезапустить', () => location.reload());
}

function _worldWatchdog() {
  if (state !== 'playing') return;
  if (activeTab !== 0) return;                       // a panel is covering the world on purpose
  if (document.hidden) return;
  if (performance.now() - _visibleSince < _WD_GRACE_MS) return;
  if (_pixiRetryTimer) return;                       // a retry is already in flight

  const why = _worldBlankWhy();
  if (!why) {
    _wdWhy = null;
    _wdStrikes = 0;
    // Once per EPISODE, not once per session. The once-per-session rule was
    // there so a phone that stays broken does not spend its battery saying so,
    // and inside one episode that still holds — but a world that broke, healed
    // and broke again is the second-most useful thing this could tell anyone,
    // and it was the one report guaranteed never to be sent.
    _wdReported.clear();
    // The banner is a claim about right now, so a world that came back takes
    // it away again — an apology left standing over a working world is the
    // same kind of lie as the black screen that explained nothing. Only the
    // watchdog's own: _pixiGiveUp's is raised after its retries are spent and
    // nothing here has re-run them, so it is not this code's to withdraw.
    const box = document.getElementById('gfx-dead');
    if (box && box.dataset.src === 'world') box.remove();
    return;
  }

  // The same complaint has to hold across two checks before anything is done
  // about it: a single tick can land inside a floor change, where there is
  // legitimately no map for a moment.
  if (_wdWhy !== why) { _wdWhy = why; _wdWhySince = performance.now(); _wdStrikes = 0; return; }
  if (performance.now() - _wdWhySince < _WD_GRACE_MS) return;
  _wdWhySince = performance.now();
  _wdStrikes++;

  const facts = _worldFacts();
  console.error('[world] пусто:', why, facts);
  // Reported once per cause per session — the server collapses repeats anyway,
  // but a phone that stays broken should not spend its battery saying so.
  if (!_wdReported.has(why) && typeof window.__reportClientError === 'function') {
    _wdReported.add(why);
    window.__reportClientError('world-blank', why + ' — ' + facts);
  }

  switch (why) {
    case 'zero-viewport':
    case 'zero-canvas':
      // Costs nothing and fixes itself the moment the WebView reports a real
      // size; the ResizeObserver below usually gets there first.
      if (_doResize) _doResize(true);
      break;
    case 'no-tiles':
      _recoverNoTiles();
      break;
    case 'no-map':
      // Only the server can answer this, and the only thing that makes it
      // answer is a fresh attachment.
      if (socket) { socket.disconnect(); socket.connect(); }
      break;
    default:
      _pixiRetry(canvas, new Error('пустой мир: ' + why));
  }

  // Every recovery for this cause has now been tried and the cause has
  // outlived all of them. This is the whole point of the exercise: the report
  // above goes to the operators, and until now the PLAYER — the one actually
  // looking at the black rectangle — was told nothing at all, and given
  // nothing to press. _pixiGiveUp has done this for a dead renderer since the
  // day it was written; a world that never drew earns the same courtesy.
  if (_wdStrikes >= _WD_GIVE_UP_STRIKES) _worldGiveUp(why);
}

window.addEventListener('load', () => {
  canvas = document.getElementById('canvas');
  _uiOverlay = document.getElementById('ui-canvas');
  const appEl = document.getElementById('app');

  // Initialise PixiJS on the world canvas. Guarded: WebGL context creation
  // can fail outright on some devices/WebViews (GPU blocklisted, hardware
  // acceleration off, too many contexts already open) — an uncaught throw
  // here used to abort the rest of this listener before it reached resize(),
  // initInput() or the requestAnimationFrame(loop) call at the bottom, so
  // literally nothing rendered or responded to input. Now it at least logs
  // and lets the rest of startup continue; the world stays blank and the
  // in-loop try/catch (see loop()) keeps every later pixi call from being
  // fatal, but HUD and input still come up instead of a completely dead page.
  // ── and if it fails, it is TRIED AGAIN ────────────────────────────────────
  // The guard above was right about the cause and wrong about what to do
  // next: it logged once and left the world blank for the rest of the
  // session. Every reason WebGL refuses a context here is transient —
  // the browser's live-context cap still holding the previous run's context,
  // the GPU process restarting, a moment of memory pressure — so the answer
  // is to wait a moment and ask again, not to give up on the first no.
  //
  // "Деколи запускаєшся і просто сірий екран замість візуалу гри, ну UI є" is
  // exactly this: the HUD is a separate 2D canvas and comes up regardless.
  try {
    pixiInit(canvas);
  } catch (err) {
    console.error('[pixiInit] failed, retrying:', err);
    _pixiRetry(canvas, err);
  }

  // Dirty-checked so a ResizeObserver can be pointed at it without either
  // wasting work or feeding itself. `force` is for the two callers that need
  // it applied to something new regardless: a rebuilt canvas after a context
  // loss, and the blank-world watchdog.
  let _rzW = -1, _rzH = -1, _rzDpr = -1;
  const resize = (force) => {
    const _dpr = Math.min(window.devicePixelRatio || 1, _isMobile ? 1.5 : 2);
    const _w = appEl.clientWidth, _h = appEl.clientHeight;
    // ── нулевой размер НЕ ПРИНИМАЕТСЯ ────────────────────────────────────
    // Свёрнутая игра, переключение приложений, зависший интернет в Telegram —
    // WebView в любом из этих случаев отдаёт clientWidth/clientHeight равными
    // нулю. Раньше это записывалось в W и H как есть, и дальше от них считали
    // ВСЁ: радиусы кнопок уходили в минус, кадровый холст получал нулевую
    // сторону, и каждый кадр падал:
    //
    //   Failed to execute 'arc': The radius provided (-1.5) is negative.
    //   Failed to execute 'drawImage': the image argument is a canvas element
    //     with a width or height of 0.
    //
    // По десять писем в минуту в операторский чат, и все — об одном: игру
    // свернули. Настоящих ошибок за ними было не разглядеть.
    //
    // Ноль — это не новый размер экрана, это отсутствие ответа. Держим
    // последний известный: WebView пришлёт настоящий, когда вернётся.
    if (!(_w > 0 && _h > 0)) return;
    if (!force && _w === _rzW && _h === _rzH && _dpr === _rzDpr) return;
    _rzW = _w; _rzH = _h; _rzDpr = _dpr;
    DPR = _dpr;
    W = _w;
    H = _h;
    // WebGL resolution capped at 1.5 (same cap for mobile and desktop) so
    // the GPU fill-rate stays reasonable on high-DPR phones without
    // sacrificing visual quality the way res=1.0 would.
    const _pixiRes = Math.min(window.devicePixelRatio || 1, 1.5);
    pixiResize(W, H, _pixiRes);
    // UI overlay — 2D canvas for HUD, joystick, name labels, etc.
    _uiOverlay.width  = Math.round(W * DPR);
    _uiOverlay.height = Math.round(H * DPR);
    _uiCtx = _uiOverlay.getContext('2d');
    // ctx global points to _uiCtx so HUD drawing functions work unchanged
    ctx = _uiCtx;
    _hudCv = null;
    _clanIconCv = null; _clanIconKey = null; // DPR may have changed
    _skillBtnGradCache = null;
    _uiBtnGrads = null;
    _partyHpGrads = null;
    _recalcEnemySimR();
    // Высота шапки зависит от ширины экрана: панель одна и держит свою
    // пропорцию. Пересчитывается ПЕРЕД updateJoyCenter — джойстик стоит от
    // низа, но всё остальное в раскладке отсчитывается от HEADER_H.
    if (typeof updateHeaderH === 'function') updateHeaderH();
    updateJoyCenter();
    _hdrSlotsCache = null;
    if (dungeon) clampCamera();
  };
  _doResize = resize;
  resize(true);
  window.addEventListener('resize', () => resize(false));
  // window.resize is not enough inside a Telegram Mini App. The WebView lays
  // #app out at its final height AFTER the page loads (and changes it again
  // when the app is expanded, when the keyboard opens, when the system bars
  // hide) — and it does not always fire a window resize for it. Everything in
  // the game is sized off #app, so missing that layout means W/H stay at
  // whatever the first measurement said, which can be zero: a black screen
  // with a working interface. Watch the element itself instead of hoping.
  if (typeof ResizeObserver === 'function') {
    try { new ResizeObserver(() => resize(false)).observe(appEl); } catch (e) { /* old WebView */ }
  }
  if (window.visualViewport) {
    // ── экранная клавиатура утаскивает страницу вверх ────────────────────
    // «Написав повідомлення — і його перекосойобило, вниз закинуло, хрестик
    // не працював.» Так и есть: #app лежит position:absolute; inset:0, и когда
    // Telegram открывает клавиатуру, документ не ужимается, а ПРОКРУЧИВАЕТСЯ.
    // Панель чата стоит на bottom:0 внутри #app, поэтому уезжает вместе с ним
    // за нижний край, а крестик закрытия оказывается там, куда пальцем не
    // дотянуться.
    //
    // Возврат прокрутки в ноль на каждом изменении видимой области: и когда
    // клавиатура открылась, и когда закрылась. Игра — один экран, ей
    // прокручиваться некуда, поэтому отнимать этим нечего.
    const _unscroll = () => {
      if (window.scrollY || window.pageYOffset) window.scrollTo(0, 0);
      if (document.body && document.body.scrollTop) document.body.scrollTop = 0;
      if (document.documentElement && document.documentElement.scrollTop) {
        document.documentElement.scrollTop = 0;
      }
    };
    window.visualViewport.addEventListener('resize', () => { _unscroll(); resize(false); });
    window.visualViewport.addEventListener('scroll', _unscroll);
    window.addEventListener('focusout', () => setTimeout(_unscroll, 60));
  }
  _talkBtn = document.getElementById('npc-talk-btn');
  initInput();
  // Startup gets the same grace as coming back from the background: the world
  // cannot have drawn yet, and a watchdog that fires before the first frame
  // would restart a renderer that was never given a chance.
  _visibleSince = performance.now();
  setInterval(_worldWatchdog, 1000);
  requestAnimationFrame(ts => { _loopTs = ts; requestAnimationFrame(loop); });
});
