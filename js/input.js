const SKILL_SZ  = 48;   // skill-button diameter (they ride the fan's arc)
const POTION_R  = 26;

// ─────────────────────────────────────────────────────────
//  ACTION FAN  (bottom-right)
// ─────────────────────────────────────────────────────────
// Every right-hand control is polar around a single pivot instead of the old
// stacked 2x2 grid: the manual-attack button sits ON the pivot, the four
// skills ride an arc around it, the АВТО/РУЧ chip clips onto that arc's rim,
// potion and target sit on a wider arc above, and the buff/debuff chips
// follow an outer arc of their own (drawBuffStrip, js/ui.js). Angles are
// canvas-standard — y grows downward, so -90° is straight up and -180°
// straight left — and the pivot is pinned to the bottom-right corner, so the
// whole cluster follows the screen size without any piece needing a layout
// rule of its own. Anything new that wants a place on the fan should ask
// fanPos() for it rather than hardcoding coordinates.
const FAN_MX = 64, FAN_MY = 70;  // pivot inset from the right edge / nav bar
const FAN_R_ATK   = 40;          // attack button — drawn on the pivot itself
const FAN_R_MODE  = 64;          // АВТО/РУЧ chip
const FAN_R_SKILL = 96;          // the four skill buttons
const FAN_R_OUTER = 192;         // potion / target
const FAN_A_MODE   = -55;
const FAN_A_SKILL  = -74;        // topmost skill …
const FAN_A_STEP   = -37;        // … and counter-clockwise from there
const FAN_A_POTION = -84;
const FAN_A_TARGET = -104;

function fanCenter() { return { x: W - FAN_MX, y: H - NAV_H - FAN_MY }; }

function fanPos(r, deg) {
  const c = fanCenter(), a = deg * Math.PI / 180;
  return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) };
}

function fanSkillAngle(idx) { return FAN_A_SKILL + idx * FAN_A_STEP; }

// Cached joystick center — recomputed only on resize via updateJoyCenter()
const _joyCenter = { x: 0, y: 0 };
function joyCenter() { return _joyCenter; }
function updateJoyCenter() { _joyCenter.x = W * 0.27; _joyCenter.y = H - NAV_H - 130; }

function _inJoyZone(cx, cy) {
  const jc = joyCenter();
  return cx < W * 0.5 && cy > H * 0.45 && cy < H - NAV_H &&
         dist(cx, cy, jc.x, jc.y) < JOY_R * 1.35;
}

// Skill button `idx`, counted from the top of the arc down. x/y/w/h is the
// bounding box (what the gradient cache and the drawing code read); cx/cy/r
// is the circle actually drawn and hit-tested.
function getSkillBtnPos(idx) {
  const r = SKILL_SZ / 2;
  const p = fanPos(FAN_R_SKILL, fanSkillAngle(idx));
  return { x: p.x - r, y: p.y - r, w: SKILL_SZ, h: SKILL_SZ, cx: p.x, cy: p.y, r };
}

// Attack is the fan's hub — the biggest button, right in the corner where the
// thumb rests. Target and Potion ride the outer arc above the skills, Target
// to the left of Potion (icon size scales off these radii, so the numbers
// here alone decide how big each icon renders).
function getAttackBtnPos() {
  const c = fanCenter();
  return { x: c.x, y: c.y, r: FAN_R_ATK };
}

function getTargetBtnPos() {
  const p = fanPos(FAN_R_OUTER, FAN_A_TARGET);
  return { x: p.x, y: p.y, r: POTION_R };
}

function getPvpBtnPos() {
  return { x: 8, y: HEADER_H + 6, w: 80, h: 26 };
}

// Directly below the Мир/ПК toggle, same column — opens the "Профессия"
// panel (second-profession skills). See _checkProfessionBtnTouch/input.js
// and drawProfessionButton/openProfessionPanel, js/ui.js.
function getProfessionBtnPos() {
  const pvp = getPvpBtnPos();
  return { x: pvp.x, y: pvp.y + pvp.h + 6, w: pvp.w, h: pvp.h };
}

// Прямо под Профессией, та же колонка — окно смены класса.
//
// Владелец: «треба було як кнопку ПРОФ зробити і під неї добавити». Первый
// заход положил её ВНУТРЬ панели профессии, внизу, — то есть за два нажатия и
// там, где её никто не искал. Кнопка на экране и кнопка в панели — разные
// вещи, и просили первую.
function getClassChangeBtnPos() {
  const prof = getProfessionBtnPos();
  return { x: prof.x, y: prof.y + prof.h + 6, w: prof.w, h: prof.h };
}

// Прямо под «Класс», та же колонка — «Письмо»: одна из двух наград
// MAIL_BONUS, забирается один раз (openMailBonusPanel, js/ui.js). Место
// безусловно, как и у «Бонуса» ниже: колонка не должна прыгать в тот момент,
// когда награду забрали.
function getMailBonusBtnPos() {
  const cc = getClassChangeBtnPos();
  return { x: cc.x, y: cc.y + cc.h + 6, w: cc.w, h: cc.h };
}

// Directly below Письмо, same column — opens the free "Набор новичка"
// kit (openStarterBonusPanel, js/ui.js). Only drawn while the account still
// has it to claim, but the position is unconditional: the party list below is
// laid out from it either way (see _partyHudStartY).
function getStarterBonusBtnPos() {
  const mb = getMailBonusBtnPos();
  return { x: mb.x, y: mb.y + mb.h + 6, w: mb.w, h: mb.h };
}

function getPartyLeaveBtnPos() {
  const bh = 26, gap = 4;
  const startY = _partyHudStartY();
  const count = (typeof partyMembers !== 'undefined') ? partyMembers.length : 0;
  return { x: getPvpBtnPos().x, y: startY + count * (bh + gap), w: 80, h: 22 };
}

// Party member list starts directly below the Бонус slot (which sits below
// +Pack, which sits below Профессия) — used to be two slots further down,
// past the since-removed Special and "ТЕХ" gift buttons. Laid out from that
// slot whether or not the button is currently drawn, so the list does not
// jump the moment the kit is claimed.
function _partyHudStartY() {
  const bonus = getStarterBonusBtnPos();
  return bonus.y + bonus.h + 6;
}

// x is offset so the Пати+/Инфо pair as a whole sits centered on screen —
// see getPartyInfoBtnPos, whose width completes the pair's total span back
// to W/2 ± (80 + 6 + 52) / 2.
function getPartyBtnPos() {
  return { x: W / 2 - 69, y: HEADER_H + 52, w: 80, h: 26 };
}

// "Инфо" button right next to Пати+ — view whoever is currently targeted
// (any nearby player, not just someone who invited you), see
// showPeerProfileModal (js/ui.js) and netRequestPlayerProfile (js/network.js).
function getPartyInfoBtnPos() {
  const pb = getPartyBtnPos();
  return { x: pb.x + pb.w + 6, y: pb.y, w: 52, h: pb.h };
}

function getPotionBtnPos() {
  const p = fanPos(FAN_R_OUTER, FAN_A_POTION);
  return { x: p.x, y: p.y, r: POTION_R + 2 };
}

// АВТО/РУЧ chip, clipped onto the fan's rim between the attack hub and the
// skill arc. Drawn round, but the box stays x/y/w/h — that is what the hit
// test and dev/harness.js read.
function getAutoBtnPos() {
  const r = 15;
  const p = fanPos(FAN_R_MODE, FAN_A_MODE);
  return { x: p.x - r, y: p.y - r, w: r * 2, h: r * 2, cx: p.x, cy: p.y, r };
}

// Invite accept/decline buttons (for popup)
function getPartyAcceptPos()  { return { x: W / 2 - 68, y: H / 2 + 18, w: 58, h: 26 }; }
function getPartyDeclinePos() { return { x: W / 2 + 10, y: H / 2 + 18, w: 58, h: 26 }; }

function _isOnScreen(wx, wy) {
  return wx >= _vL && wx <= _vR && wy >= _vT && wy <= _vB;
}

// True while in a live 3v3 match for an id that shouldn't be selectable as a
// target: your own teammates, since assist should only ever offer the enemy
// team. There is nothing else on this floor to exclude — the match is
// players only now.
function _a3Unselectable(id) {
  if (typeof _a3InMatch === 'undefined' || !_a3InMatch || !_a3Team) return false;
  return (_a3Mates[_a3Team] || []).includes(id);
}

// True while standing inside Guild War's zone for a candidate sharing your
// own clan. The zone deliberately suspends the usual clan-immunity rule for
// everyone ELSE (see _isPvpImmune, server/index.js — "open PvP between
// different clans"), but keeps it for your own clan, so the server always
// refuses a hit on one anyway; offering one as a target/assist candidate is
// just a wasted swing and a wrong lock. Gated on live position exactly like
// the server's own nowInGw check (Room.js's tick loop), not on pvpMode alone
// — that flag is shared with the open world's manual PvP toggle, where clan
// ties still fully protect (the generic fallback in _isPvpImmune), so there
// is nothing GW-specific to gate on there.
function _gwUnselectable(id) {
  if (!player || typeof _isGuildWarTile !== 'function') return false;
  const myClan = (typeof clanData !== 'undefined' && clanData && clanData.name) || null;
  if (!myClan) return false;
  if (!_isGuildWarTile(Math.floor(player.x / TILE), Math.floor(player.y / TILE))) return false;
  const op = otherPlayers.get(id);
  return !!op && op.clanName === myClan;
}

// Same reasoning as _gwUnselectable just above, for the castle itself rather
// than a clanmate: the server refuses a hit on your own currently-held tower
// outright ('own_tower', Room.js), so offering it as a target/assist
// candidate is just a wasted swing and a wrong lock. Takes the enemy record
// (not just an id) since the tower lives in the enemy list, not
// otherPlayers. Ownership isn't on the enemy record itself — netcodec's
// fixed enemy wire shape has no room for it, see updateGuildWarHpBar's own
// comment (js/ui.js) — so this reads _gwState instead, kept in sync by
// js/network.js's guildWarState handler.
function _gwTowerUnselectable(e) {
  if (!e || e.eid !== 'guildwar_castle') return false;
  const myClan = (typeof clanData !== 'undefined' && clanData && clanData.name) || null;
  if (!myClan) return false;
  return typeof _gwState !== 'undefined' && _gwState && _gwState.ownerClanName === myClan;
}

// True while racing (Кровавая Башня) for a racer in a different lane than
// yours — visible (see the pIsRacer exception in Room.js's per-player
// candidate filter, server/game/Room.js), but not selectable: every lane is
// its own sealed corridor until the one shared room every lane opens into,
// so a party invite or profile lookup across lanes has nobody real to reach.
// Both being past bossRoomX0 (sent as part of dungeon.race10 — see
// dungeonData, Room.js) is the same "converged" exception the server's own
// visibility check already makes, so nothing here needs to track it
// separately once both racers have actually arrived.
function _raceUnselectable(id) {
  if (typeof _race10Lane === 'undefined' || _race10Lane == null) return false;
  const op = otherPlayers.get(id);
  if (!op || op.raceLane == null || op.raceLane === _race10Lane) return false;
  const bx = typeof dungeon !== 'undefined' && dungeon && dungeon.race10 && dungeon.race10.bossRoomX0;
  if (bx != null && player.x >= bx && op.x >= bx) return false;
  return true;
}

function cycleTarget() {
  if (!player) return;
  const isOnline = !!(socket?.connected);
  const activeEnemies = serverEnemies; // see the comment on the identical fallback in js/ui.js's drawTargetFrame()
  const candidates = [];
  activeEnemies.forEach(e => {
    if ((e.hp || 0) > 0 && _isOnScreen(e.x, e.y) && !_a3Unselectable(e.id) && !_gwTowerUnselectable(e))
      candidates.push({ id: e.id, isPlayer: false, d: dist(e.x, e.y, player.x, player.y) });
  });
  // Selectable regardless of pvpMode: locking onto a player this way is only
  // ever used for viewing their profile or inviting them to a party — the
  // actual attack logic (js/game.js) refuses to swing at a targetIsPlayer
  // target unless pvpMode is separately on, so there's nothing to guard here.
  if (isOnline) {
    otherPlayers.forEach((op, id) => {
      if ((op.hp || 0) > 0 && op.x != null && _isOnScreen(op.x, op.y) && !_a3Unselectable(id) && !_raceUnselectable(id) && !_gwUnselectable(id))
        candidates.push({ id, isPlayer: true, d: dist(op.x, op.y, player.x, player.y) });
    });
  }
  candidates.sort((a, b) => a.d - b.d);
  if (candidates.length === 0) { targetId = null; targetIsPlayer = false; _chaseArmed = false; return; }
  const curIdx = candidates.findIndex(c => c.id === targetId && c.isPlayer === targetIsPlayer);
  const next = candidates[(curIdx + 1) % candidates.length];
  targetId = next.id;
  targetIsPlayer = next.isPlayer;
  _chaseArmed = false; // selecting a target this way is just aiming, not committing to chase it
}

function _trySelectEntityAtTouch(cx, cy) {
  if (!player || state !== 'playing') return;
  const worldX = cx / ZOOM + camera.x;
  const worldY = (cy - HEADER_H) / ZOOM + camera.y;
  const isOnline = !!(socket?.connected);
  const activeEnemies = serverEnemies; // see the comment on the identical fallback in js/ui.js's drawTargetFrame()
  const tapR = 28;
  let best = null, bestD = Infinity;
  activeEnemies.forEach(e => {
    if ((e.hp || 0) <= 0 || _a3Unselectable(e.id) || _gwTowerUnselectable(e)) return;
    const d = dist(worldX, worldY, e.x, e.y);
    if (d < e.size + tapR && d < bestD) { bestD = d; best = { id: e.id, isPlayer: false }; }
  });
  if (isOnline) {
    otherPlayers.forEach((op, id) => {
      if ((op.hp || 0) <= 0 || op.x == null || _a3Unselectable(id) || _gwUnselectable(id)) return;
      const d = dist(worldX, worldY, op.x, op.y);
      if (d < 22 + tapR && d < bestD) { bestD = d; best = { id, isPlayer: true }; }
    });
  }
  if (best) { targetId = best.id; targetIsPlayer = best.isPlayer; _chaseArmed = false; }
}

function joyGuard() { return state === 'playing' && activeTab === 0; }

function _checkSkillTouch(cx, cy) {
  if (!player) return false;
  const skills = SKILL_DEF[player.type];
  if (!skills) return false;
  for (let i = 0; i < 4; i++) {
    // Circular, not the bounding box: on the arc the boxes of neighbouring
    // buttons clip each other's corners, so a box test would hand a tap in
    // the gap between two skills to whichever one happens to be checked first.
    const b = getSkillBtnPos(i);
    if (Math.hypot(cx - b.cx, cy - b.cy) <= b.r + 6) {
      useSkill(i);
      return true;
    }
  }
  return false;
}

// Potion button: a quick tap uses the potion immediately; holding it down
// opens the auto-use settings picker instead (and suppresses the tap-use).
const POTION_LONGPRESS_MS = 450;
let _potionTouchId = null;
let _potionPressTimer = null;
let _potionLongFired = false;

function _potionPressStart(touchId) {
  _potionTouchId = touchId;
  _potionLongFired = false;
  clearTimeout(_potionPressTimer);
  _potionPressTimer = setTimeout(() => {
    _potionLongFired = true;
    if (typeof openHpPicker === 'function') openHpPicker();
  }, POTION_LONGPRESS_MS);
}

function _potionPressEnd(touchId) {
  if (_potionTouchId !== touchId) return;
  clearTimeout(_potionPressTimer);
  _potionPressTimer = null;
  _potionTouchId = null;
  if (!_potionLongFired) usePotion();
}

function _potionPressCancel(touchId) {
  if (touchId !== undefined && _potionTouchId !== touchId) return;
  clearTimeout(_potionPressTimer);
  _potionPressTimer = null;
  _potionTouchId = null;
}

function _checkPotionTouch(cx, cy, touchId) {
  const pb = getPotionBtnPos();
  if (Math.hypot(cx - pb.x, cy - pb.y) < pb.r + 6) {
    _potionPressStart(touchId);
    return true;
  }
  return false;
}

function _checkTargetBtnTouch(cx, cy) {
  const tb = getTargetBtnPos();
  if (Math.hypot(cx - tb.x, cy - tb.y) < tb.r + 6) {
    cycleTarget();
    return true;
  }
  return false;
}

function _checkPvpBtnTouch(cx, cy) {
  const pb = getPvpBtnPos();
  if (cx >= pb.x && cx <= pb.x + pb.w && cy >= pb.y && cy <= pb.y + pb.h) {
    // PvP is not optional inside a death battle — letting an entrant switch it
    // off would make them unkillable and stall the round.
    if (typeof _dbInFight !== 'undefined' && _dbInFight) {
      if (typeof dmgNum === 'function') dmgNum(player.x, player.y - 40, t('dbPvpLockedToast'), '#f88');
      return true;
    }
    if (!pvpMode && typeof inSafeZone === 'function' && player && inSafeZone(player.x, player.y)) {
      if (typeof dmgNum === 'function') dmgNum(player.x, player.y - 40, 'Нельзя в безопасной зоне', '#f88');
      return true;
    }
    pvpMode = !pvpMode;
    if (typeof netSetPvpMode === 'function') netSetPvpMode(pvpMode);
    if (!pvpMode && targetIsPlayer) { targetId = null; targetIsPlayer = false; }
    return true;
  }
  return false;
}

function _checkProfessionBtnTouch(cx, cy) {
  const pb = getProfessionBtnPos();
  if (cx >= pb.x && cx <= pb.x + pb.w && cy >= pb.y && cy <= pb.y + pb.h) {
    if (typeof openProfessionPanel === 'function') openProfessionPanel();
    return true;
  }
  return false;
}

function _checkClassChangeBtnTouch(cx, cy) {
  const cb = getClassChangeBtnPos();
  if (cx >= cb.x && cx <= cb.x + cb.w && cy >= cb.y && cy <= cb.y + cb.h) {
    if (typeof openClassChangeModal === 'function') openClassChangeModal();
    return true;
  }
  return false;
}

// Та же оговорка, что и у «Бонуса» ниже: пока награда не забрана, слот ловит
// нажатие, а после — обязан перестать, иначе он съедал бы нажатия по тому,
// что нарисовано под ним.
function _checkMailBonusBtnTouch(cx, cy) {
  if (typeof _mailBonusAvailable === 'function' && !_mailBonusAvailable()) return false;
  const mb = getMailBonusBtnPos();
  if (cx >= mb.x && cx <= mb.x + mb.w && cy >= mb.y && cy <= mb.y + mb.h) {
    if (typeof openMailBonusPanel === 'function') openMailBonusPanel();
    return true;
  }
  return false;
}

// Same gate the drawing uses (_starterBonusAvailable, js/ui.js): once the kit
// is claimed the button is gone, and its slot must stop swallowing taps meant
// for whatever is drawn under it.
function _checkStarterBonusBtnTouch(cx, cy) {
  if (typeof _starterBonusAvailable === 'function' && !_starterBonusAvailable()) return false;
  const bb = getStarterBonusBtnPos();
  if (cx >= bb.x && cx <= bb.x + bb.w && cy >= bb.y && cy <= bb.y + bb.h) {
    if (typeof openStarterBonusPanel === 'function') openStarterBonusPanel();
    return true;
  }
  return false;
}


function _checkPartyLeaveBtnTouch(cx, cy) {
  if (!partyMembers || partyMembers.length === 0) return false;
  const lb = getPartyLeaveBtnPos();
  if (cx >= lb.x && cx <= lb.x + lb.w && cy >= lb.y && cy <= lb.y + lb.h) {
    if (typeof netPartyLeave === 'function') netPartyLeave();
    return true;
  }
  return false;
}

function _checkPartyInfoBtnTouch(cx, cy) {
  if (!player || !targetIsPlayer || !targetId) return false;
  const ib = getPartyInfoBtnPos();
  if (cx >= ib.x && cx <= ib.x + ib.w && cy >= ib.y && cy <= ib.y + ib.h) {
    if (typeof netRequestPlayerProfile === 'function') netRequestPlayerProfile(targetId);
    return true;
  }
  return false;
}

function _checkPartyBtnTouch(cx, cy) {
  if (!player) return false;
  if (_checkPartyInfoBtnTouch(cx, cy)) return true;
  const pb = getPartyBtnPos();
  if (cx >= pb.x && cx <= pb.x + pb.w && cy >= pb.y && cy <= pb.y + pb.h) {
    if (targetIsPlayer && targetId) {
      if (typeof netPartyInvite === 'function') netPartyInvite(targetId);
    }
    return true;
  }
  return false;
}

function _checkPartyInviteTouch(cx, cy) {
  if (!partyInvitePending) return false;
  const ac = getPartyAcceptPos(), dc = getPartyDeclinePos();
  if (cx >= ac.x && cx <= ac.x + ac.w && cy >= ac.y && cy <= ac.y + ac.h) {
    if (typeof netPartyAccept === 'function') netPartyAccept(partyInvitePending.fromId);
    return true;
  }
  if (cx >= dc.x && cx <= dc.x + dc.w && cy >= dc.y && cy <= dc.y + dc.h) {
    if (typeof netPartyDecline === 'function') netPartyDecline(partyInvitePending.fromId);
    return true;
  }
  return false;
}

function _checkAttackBtnTouch(cx, cy) {
  if (!player) return false;
  const ab = getAttackBtnPos();
  if (Math.hypot(cx - ab.x, cy - ab.y) < ab.r + 8) {
    // Only force an immediate swing on a FRESH press. Once sustained attack
    // is already armed (or full autoAttackMode is on), atkTimer is already
    // ticking down toward the next swing on its own — forcing it to -1 again
    // here on a repeat tap would skip whatever cooldown is left and fire
    // faster than the character's real attack speed (this was the manual-
    // attack-feels-faster-than-auto bug).
    if (!_chaseArmed && !autoAttackMode && (player.atkAnimTimer || 0) <= 0) {
      player.atkTimer = -1;
    }
    _chaseArmed = true;
    return true;
  }
  return false;
}

const AUTO_ATTACK_VIP_MIN = 2;
// AUTO button: a quick tap flips auto-attack, holding it opens the auto-cast
// settings — which skills the auto may use, and whether it casts at all. Same
// tap/hold split the potion button above uses for its own picker, so the
// gesture is already one this HUD teaches.
const AUTO_LONGPRESS_MS = 450;
let _autoTouchId = null;
let _autoPressTimer = null;
let _autoLongFired = false;

function _autoPressStart(touchId) {
  _autoTouchId = touchId;
  _autoLongFired = false;
  clearTimeout(_autoPressTimer);
  _autoPressTimer = setTimeout(() => {
    _autoLongFired = true;
    // Opened regardless of VIP: the settings are the player's own and worth
    // seeing before they pay for the mode that uses them. The toggle itself
    // (below) is what stays gated.
    if (typeof openAutoSkillsPicker === 'function') openAutoSkillsPicker();
  }, AUTO_LONGPRESS_MS);
}

function _autoPressEnd(touchId) {
  if (_autoTouchId !== touchId) return;
  clearTimeout(_autoPressTimer);
  _autoPressTimer = null;
  _autoTouchId = null;
  if (_autoLongFired) return;
  if (player && (window._vipData?.level || 0) < AUTO_ATTACK_VIP_MIN) {
    if (typeof dmgNum === 'function') dmgNum(player.x, player.y - 38, `🔒 Авто-атака с VIP ${AUTO_ATTACK_VIP_MIN}`, '#f93');
    return;
  }
  // Элитная фарм-зона: AUTO is switched off on entry (see the farm2Started
  // handler, js/network.js) and refused here too — otherwise a player could
  // just flip it back on the instant they land, defeating the whole point
  // of forcing it off for that zone.
  if (player && typeof _farm2InRun !== 'undefined' && _farm2InRun) {
    if (typeof dmgNum === 'function') dmgNum(player.x, player.y - 38, '🔒 АВТО недоступно в Элитной фарм-зоне', '#f93');
    return;
  }
  autoAttackMode = !autoAttackMode;
}

function _autoPressCancel(touchId) {
  if (touchId !== undefined && _autoTouchId !== touchId) return;
  clearTimeout(_autoPressTimer);
  _autoPressTimer = null;
  _autoTouchId = null;
}

function _checkAutoBtnTouch(cx, cy, touchId) {
  const ab = getAutoBtnPos();
  if (cx >= ab.x && cx <= ab.x + ab.w && cy >= ab.y && cy <= ab.y + ab.h) {
    _autoPressStart(touchId);
    return true;
  }
  return false;
}

// Canvas can be offset from the viewport origin — on desktop #app is
// centered by the body flexbox (and capped at max-height:932px), so once the
// window is wider/taller than a phone screen, raw e.clientX/clientY no
// longer line up with the W/H pixel space every button/joystick hitbox is
// computed in. Mobile browsers happen to render #app flush against the
// viewport, which is why this only ever showed up on desktop.
function _toCanvasXY(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  return { x: clientX - r.left, y: clientY - r.top };
}

function onTS(e) {
  e.preventDefault();
  for (const t of e.changedTouches) {
    const p = _toCanvasXY(t.clientX, t.clientY);
    _perfToggleTap(p.x, p.y);
  }
  if (!joyGuard()) return;
  const jc = joyCenter();
  for (const t of e.changedTouches) {
    const p = _toCanvasXY(t.clientX, t.clientY);
    // continue, not return — this only means "ignore this one touch", not
    // "stop processing every other simultaneous touch in this event" (a
    // multi-touch batch, e.g. one finger already on the attack button while
    // another lands near the nav bar, was dropping the rest of the batch).
    if (p.y > H - NAV_H) continue;
    if (_checkPartyInviteTouch(p.x, p.y)) continue;
    if (_checkPartyLeaveBtnTouch(p.x, p.y)) continue;
    if (_checkPvpBtnTouch(p.x, p.y)) continue;
    if (_checkProfessionBtnTouch(p.x, p.y)) continue;
    if (_checkClassChangeBtnTouch(p.x, p.y)) continue;
    if (_checkMailBonusBtnTouch(p.x, p.y)) continue;
    if (_checkStarterBonusBtnTouch(p.x, p.y)) continue;
    if (_checkPartyBtnTouch(p.x, p.y)) continue;
    if (_checkAutoBtnTouch(p.x, p.y, t.identifier)) continue;
    if (_checkAttackBtnTouch(p.x, p.y)) continue;
    if (_checkPotionTouch(p.x, p.y, t.identifier)) continue;
    if (_checkTargetBtnTouch(p.x, p.y)) continue;
    if (_checkSkillTouch(p.x, p.y)) continue;
    // Starting (or already holding) the joystick claims this touch entirely —
    // don't ALSO tap-select whatever enemy/NPC happens to be rendered behind
    // it on screen (that was firing on every joystick press-down, since this
    // ran unconditionally before the joystick-zone check below).
    if (joy.active || _inJoyZone(p.x, p.y)) {
      if (!joy.active) {
        joy.active = true; joy.id = t.identifier;
        joy.sx = jc.x; joy.sy = jc.y; joy.dx = 0; joy.dy = 0;
      }
      continue;
    }
    _trySelectEntityAtTouch(p.x, p.y);
  }
}

function onTM(e) {
  e.preventDefault();
  if (!joyGuard()) return;
  // joy.active is required here, not just the identifier match: touch
  // identifiers are small integers many mobile browsers hand out
  // sequentially and REUSE once a touch ends. onTE below cleared
  // joy.active but left joy.id holding that now-stale identifier, so once
  // some later, completely unrelated touch (tapping a skill button,
  // attacking, anything) happened to be assigned the same reused id, its
  // touchmove would silently hijack the joystick — matching what looks
  // like "the joystick keeps steering no matter where I tap afterwards."
  for (const t of e.changedTouches) {
    if (joy.active && t.identifier === joy.id) {
      const p = _toCanvasXY(t.clientX, t.clientY);
      setJoy(p.x, p.y);
    }
    // Dragging off the potion button cancels a pending tap/long-press
    // instead of firing either once the finger lifts elsewhere.
    if (t.identifier === _potionTouchId) {
      const p = _toCanvasXY(t.clientX, t.clientY);
      const pb = getPotionBtnPos();
      if (Math.hypot(p.x - pb.x, p.y - pb.y) > pb.r + 40) _potionPressCancel(t.identifier);
    }
    // Same for the AUTO button's own tap/hold.
    if (t.identifier === _autoTouchId) {
      const p = _toCanvasXY(t.clientX, t.clientY);
      const ab = getAutoBtnPos();
      if (p.x < ab.x - 40 || p.x > ab.x + ab.w + 40 || p.y < ab.y - 40 || p.y > ab.y + ab.h + 40) {
        _autoPressCancel(t.identifier);
      }
    }
  }
}

function onTE(e) {
  for (const t of e.changedTouches) {
    if (t.identifier === joy.id) { joy.active = false; joy.id = null; joy.dx = 0; joy.dy = 0; }
    _potionPressEnd(t.identifier);
    _autoPressEnd(t.identifier);
  }
  if (e.touches.length === 0) { joy.active = false; joy.id = null; joy.dx = 0; joy.dy = 0; }
}

function onTC() { joy.active = false; joy.id = null; joy.dx = 0; joy.dy = 0; _potionPressCancel(); _autoPressCancel(); }

function onMD(e) {
  const p = _toCanvasXY(e.clientX, e.clientY);
  _perfToggleTap(p.x, p.y);
  if (!joyGuard()) return;
  if (p.y > H - NAV_H) return;
  const jc = joyCenter();
  if (_checkPartyInviteTouch(p.x, p.y)) return;
  if (_checkPartyLeaveBtnTouch(p.x, p.y)) return;
  if (_checkPvpBtnTouch(p.x, p.y)) return;
  if (_checkProfessionBtnTouch(p.x, p.y)) return;
  if (_checkClassChangeBtnTouch(p.x, p.y)) return;
  if (_checkMailBonusBtnTouch(p.x, p.y)) return;
  if (_checkStarterBonusBtnTouch(p.x, p.y)) return;
  if (_checkPartyBtnTouch(p.x, p.y)) return;
  if (_checkAutoBtnTouch(p.x, p.y, 'mouse')) return;
  if (_checkAttackBtnTouch(p.x, p.y)) return;
  if (_checkPotionTouch(p.x, p.y, 'mouse')) return;
  if (_checkTargetBtnTouch(p.x, p.y)) return;
  if (_checkSkillTouch(p.x, p.y)) return;
  if (_inJoyZone(p.x, p.y)) {
    joy.active = true; joy.sx = jc.x; joy.sy = jc.y; joy.dx = 0; joy.dy = 0;
    return;
  }
  _trySelectEntityAtTouch(p.x, p.y);
}

function onMM(e) {
  if (_potionTouchId === 'mouse') {
    const p = _toCanvasXY(e.clientX, e.clientY);
    const pb = getPotionBtnPos();
    if (Math.hypot(p.x - pb.x, p.y - pb.y) > pb.r + 40) _potionPressCancel('mouse');
  }
  if (_autoTouchId === 'mouse') {
    const p = _toCanvasXY(e.clientX, e.clientY);
    const ab = getAutoBtnPos();
    if (p.x < ab.x - 40 || p.x > ab.x + ab.w + 40 || p.y < ab.y - 40 || p.y > ab.y + ab.h + 40) {
      _autoPressCancel('mouse');
    }
  }
  if (joy.active && joyGuard()) {
    const p = _toCanvasXY(e.clientX, e.clientY);
    setJoy(p.x, p.y);
  }
}
function onMU()  { joy.active = false; joy.dx = 0; joy.dy = 0; _potionPressEnd('mouse'); _autoPressEnd('mouse'); }

function setJoy(cx, cy) {
  const dx = cx - joy.sx, dy = cy - joy.sy, len = Math.hypot(dx, dy);
  if (len > JOY_R) { joy.dx = dx / len; joy.dy = dy / len; }
  else { joy.dx = dx / JOY_R; joy.dy = dy / JOY_R; }
}

// Below this raw magnitude (fraction of JOY_R), treat the stick as centered.
// A real thumb resting near the middle — or just touchscreen digitizer noise
// on an otherwise-still finger — reports 1-2px of jitter around dead center.
// joy.dx/dy near zero still have SOME direction (angle is unstable at tiny
// magnitude), and inputDir() below normalizes that to a full-strength unit
// vector — so without a deadzone, that noise was flipping player.facing
// back and forth at full confidence (the hysteresis check only compares the
// two normalized axes against each other, and noise makes them trade off
// arbitrarily), which resets the walk/idle animation frame every time and
// reads as the character sprite twitching/jittering while barely moving.
const _JOY_DEADZONE = 0.12;

// Pre-allocated return value — callers must consume before next call
const _inputDirResult = { dx: 0, dy: 0, len: 0 };
function inputDir() {
  let dx = joy.dx, dy = joy.dy;
  // Полный WASD наравне со стрелками. W раньше движением НЕ был: он же хоткей
  // навыка W, и удержание «вверх» вместо поворота персонажа раз за разом
  // кастовало навык — анимация каста забирает player.atkAnimTimer, который
  // глушит весь код движения и поворота, пока играет. Теперь навыки живут на
  // Q/E/R и на цифрах 1-4 (см. initInput ниже), W освободился под движение, а
  // повторный keydown от удержания клавиши навык больше не перезапускает.
  if (keys['ArrowLeft']  || keys['KeyA']) dx -= 1;
  if (keys['ArrowRight'] || keys['KeyD']) dx += 1;
  if (keys['ArrowUp']    || keys['KeyW']) dy -= 1;
  if (keys['ArrowDown']  || keys['KeyS']) dy += 1;
  const l = Math.hypot(dx, dy);
  if (l > _JOY_DEADZONE) {
    _inputDirResult.dx = dx / l; _inputDirResult.dy = dy / l; _inputDirResult.len = Math.min(1, l);
  } else {
    _inputDirResult.dx = 0; _inputDirResult.dy = 0; _inputDirResult.len = 0;
  }
  return _inputDirResult;
}

function initInput() {
  window.addEventListener('keydown', e => {
    // Typing into a text field is not gameplay input. These listeners are on
    // window, so every character typed into the chat line, the codex search
    // or the market's own search box also reached the game: q/w/e/r cast
    // skills, f drank a potion, and w/a/s/d were held as movement until the
    // matching keyup. A PC player searching the market for "sword" fired two
    // skills and walked. Movement is left to keyup to clear (it only ever
    // sets keys to false, so a skipped keydown cannot strand a key down).
    const el = e.target;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    keys[e.code] = true;
    if (state === 'playing' && activeTab === 0) {
      // e.repeat — удержание клавиши. Браузер повторяет keydown, пока клавишу
      // держат, и без этой проверки зажатая клавиша навыка слала каст каждые
      // несколько десятков миллисекунд.
      if (e.repeat) return;
      // По ФИЗИЧЕСКОЙ клавише, а не по букве: с кириллической раскладкой Q
      // печатает «й», и ни один навык с клавиатуры не кастовался.
      //
      // W в этой таблице нет — он ушёл под движение. Второй навык остался на
      // цифре 2, и все четыре продублированы цифрами 1-4: это обычная для
      // такой игры раскладка, и она не спорит с WASD ни одной клавишей.
      const map = {
        KeyQ: 0, KeyE: 2, KeyR: 3,
        Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3,
        Numpad1: 0, Numpad2: 1, Numpad3: 2, Numpad4: 3,
      };
      if (e.code in map) useSkill(map[e.code]);
      if (e.code === 'KeyF') usePotion();
      if (e.code === 'Tab') { e.preventDefault(); cycleTarget(); }
    }
  });
  window.addEventListener('keyup', e => { keys[e.code] = false; });
  bindCanvasInput(canvas);
  window.addEventListener('mousemove',   onMM);
  window.addEventListener('mouseup',     onMU);
}

// The five listeners that live on the CANVAS ELEMENT rather than on window.
// Split out because the element can be replaced at runtime: recovering from a
// lost WebGL context means building the renderer on a fresh canvas (a used one
// cannot be given a working context back — see pixiRecover), and a fresh
// element has none of these. Without rebinding, the world would come back and
// the joystick would not.
function bindCanvasInput(el) {
  if (!el) return;
  el.addEventListener('touchstart',  onTS, { passive: false });
  el.addEventListener('touchmove',   onTM, { passive: false });
  el.addEventListener('touchend',    onTE);
  el.addEventListener('touchcancel', onTC);
  el.addEventListener('mousedown',   onMD);
}
