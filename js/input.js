const SKILL_SZ  = 54;
const SKILL_GAP = 8;
const POTION_R  = 26;

// Cached joystick center — recomputed only on resize via updateJoyCenter()
const _joyCenter = { x: 0, y: 0 };
function joyCenter() { return _joyCenter; }
// Джойстик ниже, чем был: над ним теперь столбец круглых кнопок —
// телепорт и чат, — и на прежней высоте они наезжали на его обод.
// 96 вместо 130 опускает его к самой навигации, где ему и место: большой
// палец левой руки лежит там, а не в середине экрана.
// Выше — да, правее — нет. Правее не вышло: вторая дуга бафов идёт ВЛЕВО
// от первой (правее её ждёт веер умений), и на 0.30 ширины джойстик
// перекрывал два её гнезда. Перебрал: 0.30 даёт −5 px, 0.29 — ноль,
// 0.27 — восемь. Восемь и оставил. Подъём на 112 при этом сохранён
// целиком, он бафам не мешает.
function updateJoyCenter() { _joyCenter.x = W * 0.27; _joyCenter.y = H - NAV_H - 112; }

function _inJoyZone(cx, cy) {
  const jc = joyCenter();
  return cx < W * 0.5 && cy > H * 0.45 && cy < H - NAV_H &&
         dist(cx, cy, jc.x, jc.y) < JOY_R * 1.35;
}

// ── веер умений ───────────────────────────────────────────────────────────
// Прямоугольник, в котором лежит A3_skill_fan. Правым краем чуть за экран —
// так на макете: веер срезан краем, и это его форма, а не ошибка вёрстки.
//
// Ширина в долях экрана, а не константой: на 320-пиксельном телефоне веер
// в 196 px занял бы больше половины ширины и налез на джойстик.
function fanRect() {
  const a = (typeof HUD_ART !== 'undefined') && HUD_ART.A3_skill_fan;
  const w = Math.min(200, W * 0.47);
  const h = a ? w * a.out[1] / a.out[0] : w;
  // Правым краем ВПРИТЫК, а не за экран. На макете веер срезан краем, и
  // соблазн повторить это буквально был; но малое гнездо переключателя режима
  // лежит на 0.90 ширины веера, и при заезде за край кнопка уезжала вместе с
  // ним — вместе со своей подписью. Форму приходится жертвовать той кнопке,
  // которая должна нажиматься.
  return { x: W - w - 2, y: H - NAV_H - h + 12, w, h };
}

// Гнёзда веера в порядке ДУГИ, а не по площади. Таблица отдаёт их
// отсортированными по величине — так находится место атаки, — но умения
// идут по дуге снизу вверх, и первое умение должно лежать в нижнем гнезде,
// а не в том, которое случайно оказалось на пиксель больше.
let _fanSlotsCache = null;
function fanSlots() {
  if (_fanSlotsCache) return _fanSlotsCache;
  const a = (typeof HUD_ART !== 'undefined') && HUD_ART.A3_skill_fan;
  if (!a || !a.slots || a.slots.length < 6) return null;
  const all = a.slots.slice();
  const attack = all.shift();              // самое большое
  const mode = all.pop();                  // самое маленькое
  all.sort((p, q) => q[1] - p[1]);         // сверху вниз по экрану → снизу вверх по дуге
  _fanSlotsCache = { attack, mode, skills: all };
  return _fanSlotsCache;
}

function _fanAt(slot) {
  const r = fanRect();
  return {
    x: r.x + slot[0] * r.w,
    y: r.y + slot[1] * r.h,
    r: slot[2] * r.w / 2,
  };
}

function getSkillBtnPos(idx) {
  const f = fanSlots();
  if (f) {
    const p = _fanAt(f.skills[idx] || f.skills[0]);
    return { x: p.x - p.r, y: p.y - p.r, w: p.r * 2, h: p.r * 2 };
  }
  // Запасная сетка 2×2 — на случай, если таблица ассетов не доехала.
  const sz = SKILL_SZ, gap = SKILL_GAP;
  const rx = W - 14, by = H - NAV_H - 14;
  const col = idx % 2;             // 0=left, 1=right
  const row = Math.floor(idx / 2); // 0=top, 1=bottom
  return {
    x: rx - (1 - col) * (sz + gap) - sz,
    y: by - (1 - row) * (sz + gap) - sz,
    w: sz, h: sz,
  };
}

// Attack and Target are stacked ABOVE the 2×2 skill grid (row); Potion takes
// the primary slot above that row. Attack keeps the bigger (formerly
// Potion's-slot-sized) radius here, Potion the smaller one below — icon size
// scales off these radii, so this alone swaps how big each icon renders.
function getAttackBtnPos() {
  const f = fanSlots();
  // Радиус чуть меньше гнезда: D1 садится ВНУТРЬ отверстия, а золотая
  // окантовка гнезда остаётся сверху — гайд про порядок слоёв.
  if (f) { const p = _fanAt(f.attack); return { x: p.x, y: p.y, r: p.r * 0.94 }; }
  const sz = SKILL_SZ, gap = SKILL_GAP, r = 30;
  const gridTop = H - NAV_H - 14 - 2 * sz - gap;
  return { x: W - 14 - sz / 2, y: gridTop - gap - r, r };
}

// Цель — слева от веера, на уровне его верхней трети: место, где на макете
// стоит «Target», и единственное свободное — веер занимает весь угол.
function getTargetBtnPos() {
  const f = fanSlots();
  if (f) {
    const r = fanRect();
    // Слева от зелья, на ОДНОЙ с ним высоте: две кнопки одного ряда, а не
    // лесенка. Зазор между ободами 6 px — это одна группа, а не две разные
    // части экрана.
    // Ниже зелья и левее его: прямо вниз идти некуда — там начинается
    // веер. Кнопка спускается вдоль его дуги, а не в неё.
    const pot = getPotionBtnPos();
    return { x: pot.x - 56, y: pot.y + 16, r: 25 };
  }
  const sz = SKILL_SZ, gap = SKILL_GAP, r = POTION_R;
  const gridTop = H - NAV_H - 14 - 2 * sz - gap;
  return { x: W - 14 - sz - gap - sz / 2, y: gridTop - gap - r, r };
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

// Directly below Профессия, same column — opens the free "Набор новичка" kit
// (openStarterBonusPanel, js/ui.js). Only drawn while the account still has
// it to claim, but the position is unconditional: the party list below is
// laid out from it either way (see _partyHudStartY).
//
// Раньше между ним и Профессией стояла кнопка "+Pack". Её убрали целиком —
// вместе с товаром, — и Бонус поднялся в освободившийся слот, а не остался
// висеть с дыркой над собой.
function getStarterBonusBtnPos() {
  const prof = getProfessionBtnPos();
  return { x: prof.x, y: prof.y + prof.h + 6, w: prof.w, h: prof.h };
}

function getPartyLeaveBtnPos() {
  const bh = 26, gap = 4;
  const startY = _partyHudStartY();
  const count = (typeof partyMembers !== 'undefined') ? partyMembers.length : 0;
  return { x: getPvpBtnPos().x, y: startY + count * (bh + gap), w: 80, h: 22 };
}

// Party member list starts directly below the Бонус slot (which sits below
// Профессия) — used to be further down, past the since-removed +Pack,
// Special and "ТЕХ" gift buttons. Laid out from that slot whether or not the
// button is currently drawn, so the list does not jump the moment the kit is
// claimed.
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

// Potion is above the attack/target row; AUTO sits directly above Potion
// Фляга — над веером, как на макете: это расходник, а не умение, и она
// намеренно вынесена из дуги, потому что промах по ней в бою дороже всего.
function getPotionBtnPos() {
  const f = fanSlots();
  if (f) {
    const r = fanRect();
    // К правому краю экрана и ровно над кромкой веера. Раньше кнопка стояла
    // посреди его ширины и висела над миром сама по себе; прижатая к стенке
    // она читается как верхний ряд того же блока, что и умения под ней.
    return { x: W - 36, y: r.y - 32, r: 27 };
  }
  const sz = SKILL_SZ, gap = SKILL_GAP, r = POTION_R;
  const ab = getAttackBtnPos();
  return { x: W - 14 - sz / 2, y: ab.y - ab.r - gap - r, r };
}

// Переключатель ручной/авто садится в МАЛОЕ гнездо веера — гайд называет его
// «єдине посадкове місце для D2_attack_mode_button».
function getAutoBtnPos() {
  const f = fanSlots();
  if (f) {
    const p = _fanAt(f.mode);
    // Гнездо мелкое — 0.081 ширины веера, около 16 px, — а палец нет. Область
    // нажатия расширена до 44: у макета тут одна кнопка, и она обязана
    // нажиматься, а не «иногда нажиматься». art несёт размер РИСУНКА, чтобы
    // отрисовка не раздувалась вместе с зоной попадания.
    const d = Math.max(44, p.r * 2);
    // Рисунок КРУПНЕЕ отверстия — так и на макете: «РУЧ» там не тонет в
    // гнезде, а лежит на нём пилюлей. Само отверстие 0.081 ширины веера,
    // около 16 px, и три буквы в него не помещаются никаким кеглем.
    return { x: p.x - d / 2, y: p.y - d / 2, w: d, h: d, art: Math.max(30, p.r * 3.8) };
  }
  const pb = getPotionBtnPos();
  const gap = SKILL_GAP;
  const w = 52, h = 22;
  return { x: pb.x - w / 2, y: pb.y - pb.r - gap - h, w, h };
}

// ── дуга бафов ─────────────────────────────────────────────────────────────
// Две дуги по шесть вдоль внешнего края веера. Здесь, рядом с остальной
// раскладкой, а не внутри рисовалки: положение бафов надо уметь проверить,
// не рисуя их, — иначе «ничего ни на что не налезает» так и остаётся
// обещанием, которое каждый раз проверяют глазами по скриншоту.
//
// Дуга не подобрана: четыре гнезда умений в A3 лежат на окружности, по трём
// из них считается её центр — (0.898, 0.897) размера веера — и радиус
// 0.707 ширины. Бафы идут по той же окружности радиусом побольше, поэтому
// лента повторяет форму веера.
const BUFF_SZ = 21, BUFF_PER_ARC = 6, BUFF_MAX = 12, BUFF_ARC_STEP = 26;
// Концы: 1.03π — там, где нижнее гнездо ещё не достаёт до навигации,
// 1.29π — где верхнее ещё не достаёт до кнопки цели.
const BUFF_A0 = Math.PI * 1.02, BUFF_A1 = Math.PI * 1.31;
// Внешний край веера. Он проходит через верхний правый и нижний левый углы
// своего прямоугольника, и от центра дуги до них — 0.903 ширины. Нужен
// именно он, а не край прямоугольника: верхний левый угол прямоугольника
// ПУСТ, там воздух, и мерить по нему — значит объявлять столкновением то,
// чего нет.
const FAN_OUTER_R = 0.903;
function fanOuter() {
  const f = fanRect();
  return { x: f.x + f.w * 0.898, y: f.y + f.h * 0.897, r: f.w * FAN_OUTER_R };
}

function buffSlotPos(i) {
  const f = fanRect();
  const cx0 = f.x + f.w * 0.898, cy0 = f.y + f.h * 0.897;
  const ring = Math.floor(i / BUFF_PER_ARC);
  const k = i % BUFF_PER_ARC;
  // Вторая дуга ДАЛЬШЕ от центра, то есть левее первой. Раньше она шла
  // ближе к центру — то есть правее, — и вторая шестёрка ложилась прямо на
  // веер умений. Основная дуга — левая, остальные достраиваются от неё
  // наружу.
  const rr = f.w * 0.98 + ring * BUFF_ARC_STEP;
  // Шаг постоянный, а не «поделить дугу на число бафов»: иначе при двух
  // бафах они расползлись бы по всей дуге, а при десяти сползлись в кучу,
  // и одно и то же зелье каждый раз оказывалось бы в новом месте.
  const ang = BUFF_A0 + k * (BUFF_A1 - BUFF_A0) / (BUFF_PER_ARC - 1);
  return {
    x: cx0 + Math.cos(ang) * rr - BUFF_SZ / 2,
    y: cy0 + Math.sin(ang) * rr - BUFF_SZ / 2,
    w: BUFF_SZ, h: BUFF_SZ,
  };
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
    const b = getSkillBtnPos(i);
    if (cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h) {
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
