// Delegates to shared/definitions.js so client and server can't drift apart.
function _isStackable(it) { return isStackableItem(it); }

function invSlotCount() {
  return player.inventory.length;
}

function invHasSpace() {
  return invSlotCount() < 150;
}

function addToInventory(it) {
  if (_isStackable(it)) {
    const existing = player.inventory.find(i => i.id === it.id);
    if (existing) { existing.qty = (existing.qty || 1) + 1; return true; }
  }
  if (!invHasSpace()) return false;
  if (_isStackable(it)) {
    player.inventory.push({ ...it, qty: 1 });
  } else {
    player.inventory.push(it);
  }
  return true;
}

function countMaterial(id) {
  const item = player.inventory.find(i => i.id === id);
  return item ? (item.qty || 1) : 0;
}

// Sum of every regular skill book owned, any class/skill mixed together —
// what craftAdvSkillBook (server/index.js) consumes toward ADV_SKILL_BOOK_
// CRAFT.count.
function countSkillBooks() {
  return player.inventory.reduce((s, i) => {
    const mat = CRAFT_MATS.find(m => m.id === i.id);
    return s + (mat && mat.skillKey ? (i.qty || 1) : 0);
  }, 0);
}

function countEnhancedItem(id, minEnh) {
  return player.inventory.filter(i => i.id === id && (i.enhance || 0) >= minEnh).length;
}

// ── Storage (Хранилище NPC) ──────────────────────────────────────
function storageSlotCount() {
  return player.storage.length;
}

function storageHasSpace() {
  return storageSlotCount() < 200;
}

// Both directions are server-side moves now (storageDeposit/storageWithdraw,
// server/index.js). Splitting the move across a client edit and a later save
// is what let one item be observed in both containers at once — the case the
// census then read as duplication and rejected the whole set for.
function moveToStorage(idx) {
  if (!player || !player.inventory[idx]) return false;
  if (!storageHasSpace()) return false;
  netStorageDeposit(idx);
  return true;
}

function moveToInventory(idx) {
  if (!player || !player.storage[idx]) return false;
  if (!invHasSpace()) return false;
  netStorageWithdraw(idx);
  return true;
}

function makePlayer(type) {
  const d = CHAR_DEF[type];
  return {
    type, charDef: d,
    x: 0, y: 0,
    baseAtk: d.baseAtk, baseDef: d.baseDef, baseMaxHp: d.baseHP,
    atk: d.baseAtk, def: d.baseDef, maxHp: d.baseHP, hp: d.baseHP,
    speed: d.speed, baseSpeed: d.speed,
    lvl: 1, xp: 0, xpNext: xpToNext(1),
    gold: 0, kills: 0,
    atkTimer: 0, hurtTimer: 0,
    facing: 'front', atkAnimTimer: 0, castDuration: 0, animFrame: 0, animTimer: 0,
    pendingAttack: null, attackFired: false,
    equipment: {
      weapon:null, helmet:null, body:null, gloves:null, boots:null, ring:null, belt:null, pet:null, cloak:null, artifact:null,
    },
    inventory: [],
    storage: [],
    potionBag: { pt1: 30, pt2: 0 },
    hudPotion: 'pt1',
    buffs: {},
    potCd: 0,
    autoHpPct: 0,
    autoBuffTypes: {},
    // Auto-cast (АВТО) settings — see _autoCastSkills (js/game.js) and the
    // picker the AUTO button opens on a long press (openAutoSkillsPicker,
    // js/ui.js). autoSkillsOn is the master switch; autoSkillOff holds the
    // slots the player has switched OFF, so an account that predates this
    // (and any slot never touched) keeps auto-casting exactly as before —
    // storing the ENABLED set instead would have read as "all off" for
    // everyone who upgraded.
    autoSkillsOn: true,
    autoSkillOff: {},
    skillCooldowns: { Q:0, W:0, E:0, R:0 },
    // 0 = locked/not yet studied (see studySkill/upgradeSkillWithBook in
    // js/ui.js) — a fresh character has no Q/W/E/R skills until a skill
    // book drops and is spent to study one.
    skillLevels: { Q:0, W:0, E:0, R:0 },
    // 0 = locked/not yet studied, 1-5 = level (see PASSIVE_MAX_LEVEL,
    // shared/definitions.js) — keyed by passive id across both the
    // class-exclusive pair and the six universal ones. Studied/upgraded with
    // books exactly like skillLevels above (see studyPassiveSkill/
    // upgradePassiveSkillWithBook in js/ui.js).
    passiveLevels: {},
    cdrPct: 0,
    questIdx: 0,
    questKills: {},
    upgrades: { atk:0, def:0, hp:0, atkSpeed:0, critChance:0, critPower:0, hpRegen:0 },
    bonusSP: 0,
    // Points a Перерождение carried across its level reset — a commitment the
    // upgrades map already holds, never spendable capacity. Server-written;
    // see availableSkillPoints (shared/definitions.js).
    keptSP: 0,
    // "Набор новичка already claimed" — server-owned (starterBonusClaim,
    // server/handlers/gram.js, and stripped from every save by
    // _sanitizeSavedStats); the HUD's Бонус button reads it to know whether
    // there is still anything to claim.
    starterBonus: false,
    empowers: 0,
    // Кодекс: { [setId]: boolean[] } filled-slot progress per set
    // (server-owned, see registerCodexSetItem/codexSync) and the flat stat
    // bonus every COMPLETED set totals to.
    codex: {},
    codexBonus: { atk: 0, def: 0, hp: 0 },
    // derived combat stats (computed by recompute)
    atkSpeed: d.atkSpeed,
    critChance: 0.05, critPower: 1.5,
    hpRegen: 0,
  };
}

// Per-level enhance bonus for one stat unit — the formula itself lives in
// shared/definitions.js (enhanceBonus) so the server's Market validation
// can't drift out of sync with what the client actually applies.
function _enhBonusAt(it, levels) { return enhanceBonus(it, levels); }
function _enhBonus(it) { return _enhBonusAt(it, it.enhance || 0); }

// ── Skill level helpers ───────────────────────────────────────
function _skillLvl(key) { return (player && player.skillLevels && player.skillLevels[key]) || 0; }
// Сила навыков from equipment (recompute() above). Multiplies the magnitude
// of a skill — its damage and its healing — on top of the +1%/level the skill
// itself already gives. Durations are not touched: those are seconds, and a
// percentage of a duration is a different kind of number to a percentage of a
// hit.
function _skillPowerMult()     { return 1 + ((player && player.skillPct) || 0); }
function _skillDmgMult(key)    { return skillScaleMult(_skillLvl(key), (player && player.skillPct) || 0); }
// The full multiplier for casting `key` right now — the slot's own factor
// (SKILL_DMG_MULT, shared/definitions.js) times the level/gear scaling above.
// The server derives the identical number from the slot name the cast sends,
// so these must come from the one table rather than from literals here.
function _skillMult(key)       { return skillDamageMult(player && player.type, key, _advActive(key), _skillLvl(key), (player && player.skillPct) || 0); }
function _skillBuffSec(key)    { return _skillLvl(key); }
function _skillHealMult(key)   { return (1 + _skillLvl(key) * 0.01) * _skillPowerMult(); }
function _skillMobRange(key)   { return _skillLvl(key) * 10; }

// ── Advanced skills ("вторая профессия") ───────────────────────────────────
// A slot's advanced version shares its base's key/cd/level/cooldown-slot —
// only name/icon/img/desc/behavior change — so switching is purely cosmetic
// bookkeeping plus a branch inside useSkill() below. MUST be learned
// (advSkillLearned, a one-time book spend — see learnAdvSkill, js/ui.js)
// before advSkillActive can mean anything; checking both here means a stray
// active:true with no matching learned:true (e.g. a hand-edited save) can
// never silently activate an unearned skill.
function _advActive(key) {
  return !!(player && player.advSkillLearned && player.advSkillLearned[key] &&
    player.advSkillActive && player.advSkillActive[key]);
}
// Resolves which version of a slot to actually show — used by the HUD skill
// buttons and touch hitboxes (js/ui.js, js/input.js) so both always agree
// with what useSkill() below will actually run. cd/key are identical between
// base and advanced by construction (ADV_SKILL_DEF, js/definitions.js), so
// spreading the advanced entry over the base one changes only display fields.
function _activeSkillDef(cls, idx) {
  const base = (typeof SKILL_DEF !== 'undefined' && SKILL_DEF[cls]) ? SKILL_DEF[cls][idx] : null;
  if (!base) return null;
  if (_advActive(base.key)) {
    const adv = (typeof ADV_SKILL_DEF !== 'undefined' && ADV_SKILL_DEF[cls]) ? ADV_SKILL_DEF[cls][idx] : null;
    if (adv) return { ...base, ...adv };
  }
  return base;
}

// Вампиризм (deathknight Q) — heals a % of any damage the player deals
// while vampirismTimer is active. Called from network.js wherever a hit/kill
// event reports how much damage this player's own attack just dealt.
// Возврат считает СЕРВЕР (Room._vampGain): урон применяет он, и другого
// честного числа не существует. Оттуда же приходит 'skillHealTick', который и
// рисует цифру, — поэтому здесь не осталось ничего, кроме таймера иконки.
//
// Функция сохранена: её зовут три места в js/network.js на каждое сообщение о
// нанесённом уроне, и превращать три вызова в три проверки на undefined ради
// пустого тела не стоит.
function _applyVampirism(_dmg) { /* сервер, см. Room._vampGain */ }

// AOE helper with optional damage multiplier (replaces _skillAOE for leveled skills)
function _skillAOEMult(r, mult, key) {
  const m = Math.max(1, mult || 1);
  serverEnemies.forEach(e => {
    if ((e.hp || 0) <= 0) return;
    if (dist(e.x, e.y, player.x, player.y) < r + (e.size || 0) && hasLOS(player.x, player.y, e.x, e.y)) netSkillAttack(e.id, m, key);
  });
}

// Directional AOE with optional damage multiplier
function _skillDirMult(dx, dy, r, arcDot, mult, key) {
  const m = Math.max(1, mult || 1);
  const len = Math.hypot(dx, dy) || 1;
  const nx = dx / len, ny = dy / len;
  serverEnemies.forEach(e => {
    if ((e.hp || 0) <= 0) return;
    const ex = e.x - player.x, ey = e.y - player.y;
    const d = Math.hypot(ex, ey);
    if (d > r + (e.size || 0) || d < 1) return;
    if ((ex / d) * nx + (ey / d) * ny > (arcDot ?? 0.3) && hasLOS(player.x, player.y, e.x, e.y)) netSkillAttack(e.id, m, key);
  });
}

function recompute() {
  const u = player.upgrades || {};
  let a = player.baseAtk + (u.atk || 0) * 1;
  let d = player.baseDef + (u.def || 0) * 1;
  let h = player.baseMaxHp + (u.hp || 0) * 10;
  // Кодекс предметов — small, flat, permanent bonus from registered items
  // (server-authoritative, see codexSync/js/network.js). Applies regardless
  // of what's currently equipped, so it sits with the base stats above
  // rather than the per-slot equipment loop below.
  const cx = player.codexBonus || null;
  if (cx) { a += cx.atk || 0; d += cx.def || 0; h += cx.hp || 0; }
  let extraCrit = 0, extraAS = 0, hpPct = 0, skillPct = 0;
  Object.values(player.equipment).forEach(it => {
    if (!it) return;
    const eb = _enhBonus(it);
    a += (it.atk || 0) + (eb.atk || 0);
    d += (it.def || 0) + (eb.def || 0);
    h += (it.hp  || 0) + (eb.hp  || 0);
    if (it.critChance) extraCrit += it.critChance;
    if (it.atkSpeed)   extraAS   += it.atkSpeed;
    if (it.hpPct)      hpPct     += it.hpPct;
    // Сила навыков — only the unique weapons carry it today, but it is summed
    // over every slot like any other stat so a future item can grant it too.
    if (it.skillPct)   skillPct  += it.skillPct;
  });
  // Read by _skillDmgMult/_skillHealMult below. Stored on the player rather
  // than recomputed at cast time so it follows the same rebuild-from-scratch
  // rule as atk/def/maxHp — every equip, unequip and enhance already calls
  // recompute(), so it can never go stale.
  player.skillPct = skillPct;

  // Passive skills (shared/definitions.js) — class-exclusive pair + six
  // universal ones, bought with gold in the Skills → Passive tab (js/ui.js).
  const pt = (typeof passiveBonusTotal === 'function') ? passiveBonusTotal(player.passiveLevels, player.type) : null;
  if (pt) hpPct += pt.hpPct;
  h = Math.floor(h * (1 + hpPct));

  // Buff potion bonuses
  const buffs = player.buffs || {};
  if (buffs.hp        > 0) h = Math.floor(h * 1.10);
  if (buffs.atk       > 0) a = Math.floor(a * 1.20);
  if (buffs.atkspeed  > 0) extraAS += (player.charDef.atkSpeed || 0) * 0.20;

  if (pt) {
    a = Math.floor(a * (1 + pt.atkPct));
    d = Math.floor(d * (1 + pt.defPct));
    extraAS += (player.charDef.atkSpeed || 0) * pt.atkSpeedPct;
  }

  // Clan "Атака" perk (js/definitions.js CLAN_LEVELS, cumulative % at the
  // clan's current level) — was only ever shown in the clan panel and never
  // actually multiplied into combat atk anywhere. getClanBonus() lives in
  // js/clans.js; guarded the same way pt/battleCryTimer etc. are here since
  // this file doesn't otherwise depend on clans.js loading first.
  const clanBonus = typeof getClanBonus === 'function' ? getClanBonus() : null;
  if (clanBonus && clanBonus.atk > 0) a = Math.floor(a * (1 + clanBonus.atk / 100));

  // Active skill buffs (timers live in js/state.js, ticked in js/game.js).
  // Derived here rather than mutating player.atk/def at cast time: this
  // function rebuilds both fields from scratch, so any unrelated recompute()
  // — a level-up, a gear swap, a potion buff expiring — used to silently
  // erase a still-running skill buff while its timer and icon kept going.
  if (typeof battleCryTimer !== 'undefined' && battleCryTimer > 0) a = Math.floor(a * 1.20);
  // Advanced-skill ATK buffs (own separate timers — see js/state.js's
  // comment block above them for why they can't just share battleCryTimer).
  if (typeof advDkQAtkTimer  !== 'undefined' && advDkQAtkTimer  > 0) a = Math.floor(a * 1.20); // "Истощение" (adv DK Q)
  if (typeof madnessTimer    !== 'undefined' && madnessTimer    > 0) a = Math.floor(a * 1.25); // "Безумие" (adv DK E)
  if (typeof levShieldAtkTimer !== 'undefined' && levShieldAtkTimer > 0) a = Math.floor(a * 1.10); // "Щит" (adv Lev E)
  let defMult = 1;
  if (typeof guardTimer       !== 'undefined' && guardTimer       > 0) defMult *= 1.80;
  // "Вспышка" (adv mage E) gives +80% def instead of Barrier's own +50% —
  // barrierTimer is mage-only either way, so the active-skill check just
  // picks which magnitude this cast actually meant.
  if (typeof barrierTimer !== 'undefined' && barrierTimer > 0) {
    defMult *= (player.type === 'mage' && _advActive('E')) ? 1.80 : 1.50;
  }
  if (typeof faithShieldTimer !== 'undefined' && faithShieldTimer > 0) defMult *= 1.50;
  if (defMult !== 1) d = Math.floor(d * defMult);

  player.atk = a; player.def = d; player.maxHp = h;
  if (player.hp > player.maxHp) player.hp = player.maxHp;

  const lvl = player.lvl - 1;
  const cd  = player.charDef;
  player.atkSpeed   = cd.atkSpeed * (1 + lvl * 0.015) + (u.atkSpeed   || 0) * 0.05 + extraAS;
  if (typeof atkSpeedTimer !== 'undefined' && atkSpeedTimer > 0) {
    // ×2 instead of ranger's own ×1.5 for "Ускорение" (adv ranger R); warlock
    // never sets atkSpeedTimer at all except via "Жажда" (adv warlock E), so
    // it's unconditionally ×2 there.
    let _asMult = 1.5;
    if (player.type === 'ranger' && _advActive('R')) _asMult = 2;
    if (player.type === 'warlock') _asMult = 2;
    player.atkSpeed *= _asMult;
  }
  const _critChanceBuff = (typeof critChanceBuffTimer !== 'undefined' && critChanceBuffTimer > 0) ? 0.05 : 0; // "Баф Крит" (adv ranger E)
  const _critDmgBuff    = (typeof critDmgBuffTimer    !== 'undefined' && critDmgBuffTimer    > 0) ? 0.05 : 0; // "Жадность" (adv DK W)
  player.critChance = Math.min(0.80, 0.05 + lvl * 0.004 + (u.critChance || 0) * 0.01 + extraCrit + _critChanceBuff);
  player.critPower  = 1.5 + lvl * 0.015 + (u.critPower  || 0) * 0.03 + (pt ? pt.critPowerFlat : 0) + _critDmgBuff;
  if (typeof netStatsUpdate === 'function') netStatsUpdate(a, d, h, player.critChance, player.critPower);
  player.hpRegen    = lvl * 0.02 + (u.hpRegen    || 0) * 0.1 + (buffs.regen > 0 ? 2 : 0) + (pt ? pt.hpRegenFlat : 0);
  player.cdrPct     = pt ? Math.min(0.80, pt.cdrPct) : 0;
  player.speed      = player.baseSpeed * (1 + (pt ? pt.moveSpeedPct : 0));
}

// The panel's figure and the server's are the same function now
// (availableSkillPoints, shared/definitions.js — the skill point accounting
// block there is where the rule itself is written down), so the number on the
// button and the number spendUpgrade sells against cannot drift apart.
function getAvailableSkillPoints() {
  return availableSkillPoints(player);
}

// A request now, not a purchase. The server checks the point budget and the
// gold, charges both and answers with goldSync + progressSync — see the
// spendUpgrade handler in server/index.js. Deducting here and letting the save
// carry it is what made both the point and the price client-authored.
//
// The two local checks are UI courtesy so an obviously impossible click never
// leaves the device; both are enforced again server-side.
function upgradeStats(key) {
  if (!player || !UPGRADE_DEF[key]) return;
  const lvl = (player.upgrades || {})[key] || 0;
  if (player.gold < upgradeCost(lvl)) {
    dmgNum(player.x, player.y - 30, t('npcNotEnoughGold'), '#f88');
    return;
  }
  if (getAvailableSkillPoints() < 1) {
    dmgNum(player.x, player.y - 30, t('notEnoughSkillPoints'), '#f88');
    return;
  }
  netSpendUpgrade(key);
}

// Display only. Gold is the server's number now: it applies the clan bonus and
// the x2 potion itself and sends the new total (goldTotal on enemyKilled,
// goldSync everywhere else), so adding here as well would double-count it and
// put the client back in the business of authoring a balance.
//
// Kept as a function because a dozen call sites still want the figure to float
// over the player's head; it just no longer touches player.gold.
function gainGold(amount) {
  return Math.max(0, Math.floor(Number(amount)) || 0);
}

// Applies a level state the server computed. Everything derived from the level
// lives in these six fields, so taking them as a set is what keeps the sheet,
// the stats and the curve from disagreeing.
function applyLevelState(st) {
  if (!player || !st) return;
  const before = player.lvl;
  if (Number.isFinite(st.lvl))       player.lvl       = st.lvl;
  if (Number.isFinite(st.xp))        player.xp        = st.xp;
  if (Number.isFinite(st.xpNext))    player.xpNext    = st.xpNext;
  if (Number.isFinite(st.baseAtk))   player.baseAtk   = st.baseAtk;
  if (Number.isFinite(st.baseDef))   player.baseDef   = st.baseDef;
  if (Number.isFinite(st.baseMaxHp)) player.baseMaxHp = st.baseMaxHp;
  recompute();
  if (player.lvl > before) {
    // Комментарий здесь уверял, что «the heal itself was applied server-side».
    // Этого не делал никто: во всём server/ нет ни одного места, которое
    // лечило бы на повышении уровня. Теперь делает — handlers2/world.js, там
    // же, где начисляется опыт, — а строка прибавки отсюда убрана, чтобы
    // лечение снова не оказалось двойным.
    dmgNum(player.x, player.y - 38, '↑ УРОВЕНЬ ' + player.lvl, '#ff0');
    dmgNum(player.x, player.y - 54, '+3 очка навыка', '#a0f0a0');
    spawnBurst(player.x, player.y, '#ff0', 14);
    if (typeof onLevelUp === 'function') onLevelUp(player.lvl);
  }
}

function _invMsg(msg) {
  const panel = document.getElementById('panel-inv');
  if (!panel) return;
  const el = document.createElement('div');
  el.className = 'inv-msg-err';
  el.textContent = msg;
  panel.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

// Equipping and unequipping both save. They used to rely on some later
// autosave carrying the change along, which is fine while grinding (kills and
// loot fire one constantly) but not in the hub: standing at the forge there
// is nothing to trigger a save at all, so the server could go on believing a
// just-equipped item was still loose in the inventory for minutes. That gap
// is what made enhancing a freshly-crafted pet fail with "Предмет не найден"
// — the enhance roll is server-side now (see 'enhanceItem', server/index.js)
// and it looks the target up in the server's own copy, not the client's.
// Requests, not edits. The server moves the item on its own copy and answers
// with inventorySync — see the equipItem/unequipItem handlers in
// server/index.js. Doing it locally and letting the save carry the result is
// what made the item set client-authored, and what the whole item census
// existed to police after the fact.
//
// Deliberately not applied optimistically: the point of the change is that
// there is one copy of the item set, and a local edit reintroduces the second
// one for as long as the round trip lasts. Equipping is not a twitch action.
function equipItem(idx) {
  const it = player.inventory[idx]; if (!it) return;
  if (_isStackable(it) || it.slot === 'use') return;
  if (it.forClass && player.type && !it.forClass.includes(player.type)) {
    _invMsg('Этот предмет не для вашего класса');
    return;
  }
  netEquipItem(idx);
}

function unequipItem(slot) {
  const it = player.equipment[slot];
  if (!it || !invHasSpace()) return;
  netUnequipItem(slot);
}

function usePotion() {
  if (!player || state !== 'playing') return;
  if ((player.potCd || 0) > 0) return;
  const bag = player.potionBag || {};
  const type = player.hudPotion || 'pt1';
  if ((bag[type] || 0) <= 0) return;
  if (player.hp >= player.maxHp) return;
  // Not decremented here: the server spends from its own bag and answers
  // with potionBag, which is what the HUD and the shop read.
  // ── зелье лечит РОВНО ОДИН РАЗ ────────────────────────────────────────
  // Здесь прибавлялось def.hp, а следом приходило число сервера (usePotion →
  // setPlayerHp → 'playerHurt' с готовым hp) и ставилось поверх. Видимое
  // лечение получалось не «плюс двадцать», а разностью двух чисел, которые
  // успели разойтись: «малые хилки как будто по 140, а иногда по 20» и «то
  // сразу фулл хп делают».
  //
  // Прибавка убрана. Цифру рисует ответ сервера — там она настоящая.
  player.potCd = 4;
  spawnBurst(player.x, player.y, '#4f4', 5);
  if (typeof netUsePotion === 'function') netUsePotion(type);
  if (typeof updateInvUI === 'function') updateInvUI();
  netSaveProgress();
}

// Buff types with a drink already asked for and not yet answered.
//
// The auto-re-drink below is driven from the per-frame loop in js/game.js, and
// the condition it fires on is "this timer is at zero" — which stays true for
// every single frame between the emit and the server's buffSync. At 60fps and
// an ordinary round trip that is another six to ten requests, of which the
// first one drinks the potion and the rest come back "Этот бафф уже активен".
//
// That was not a theory. refuse:useBuffPotion was the most frequent event in
// the entire game — 353 of them in one day from one player, more than every
// successful action that player took put together — and each one cost the
// server a row lock and a transaction to say no.
//
// A deadline rather than a plain flag, because a reply that never arrives must
// not wedge the toggle: the worst case is an auto-drink late by
// _BUFF_INFLIGHT_MS, not one that stays off until the page is reloaded.
const _buffInFlight = new Map();   // buffType -> ms after which asking again is allowed
const _BUFF_INFLIGHT_MS = 3000;

function _buffPending(btype) {
  const until = _buffInFlight.get(btype);
  if (!until) return false;
  if (Date.now() >= until) { _buffInFlight.delete(btype); return false; }
  return true;
}

// Called from the buffSync handler (js/network.js) the moment the server
// answers. A function declaration rather than exposing the Map: the bundle is
// one script scope, and a hoisted function is the only thing the other file
// needs to be able to reach.
function _buffClearPending() { _buffInFlight.clear(); }

// A request now. The server removes the potion and holds the timer — it has
// to, because buffs.gold and buffs.exp are what the x2 payouts read, so a
// client-written timer would be a client-written multiplier.
function useBuffPotion(id) {
  if (!player || state !== 'playing') return;
  const def = ITEM_DEF.find(d => d.id === id);
  if (!def || def.slot !== 'buff_potion') return;
  if (((player.buffs || {})[def.buffType] || 0) > 0) {
    dmgNum(player.x, player.y - 26, 'Уже активно!', '#f88');
    return;
  }
  if (_buffPending(def.buffType)) return;
  _buffInFlight.set(def.buffType, Date.now() + _BUFF_INFLIGHT_MS);
  netUseBuffPotion(id);
}

// Re-drink a buff potion of the given type from inventory the moment its
// timer expires — used by the per-type auto toggle (toggleAutoBuffPotion)
// and the game-loop check in js/game.js. No-ops quietly if the bag is empty.
function _autoUseBuffPotionByType(btype) {
  if (!player) return;
  const it = (player.inventory || []).find(i => i.slot === 'buff_potion' && i.buffType === btype);
  if (it && (it.qty || 1) > 0) useBuffPotion(it.id);
}

function toggleAutoBuffPotion(btype) {
  if (!player || !btype) return;
  const auto = player.autoBuffTypes || (player.autoBuffTypes = {});
  auto[btype] = !auto[btype];
  if (auto[btype] && ((player.buffs || {})[btype] || 0) <= 0) _autoUseBuffPotionByType(btype);
  if (typeof updateInvUI === 'function') updateInvUI();
  netSaveProgress();
}

// Return direction toward locked target or nearest enemy; fall back to joystick if active
function nearestEnemyDir() {
  const jl = Math.hypot(joy.dx, joy.dy);
  if (jl > 0.25) return { dx: joy.dx / jl, dy: joy.dy / jl };
  if (pvpMode && targetIsPlayer && targetId) {
    const op = otherPlayers.get(targetId);
    if (op && (op.hp || 0) > 0 && op.x != null) {
      const len = Math.max(1, dist(op.x, op.y, player.x, player.y));
      return { dx: (op.x - player.x) / len, dy: (op.y - player.y) / len };
    }
  }
  if (targetId && !targetIsPlayer) {
    const t = serverEnemies.find(e => e.id === targetId && (e.hp || 0) > 0);
    if (t) {
      const len = Math.max(1, dist(t.x, t.y, player.x, player.y));
      return { dx: (t.x - player.x) / len, dy: (t.y - player.y) / len };
    }
  }
  let closest = null, closestD = Infinity;
  serverEnemies.forEach(e => {
    if ((e.hp || 0) <= 0) return;
    if (!hasLOS(player.x, player.y, e.x, e.y)) return;
    const d = dist(e.x, e.y, player.x, player.y);
    if (d < closestD) { closestD = d; closest = e; }
  });
  if (pvpMode) {
    otherPlayers.forEach((op) => {
      if ((op.hp || 0) <= 0 || op.x == null) return;
      const d = dist(op.x, op.y, player.x, player.y);
      if (d < closestD) { closestD = d; closest = op; }
    });
  }
  if (!closest) return { dx: 1, dy: 0 };
  const len = Math.max(1, closestD);
  return { dx: (closest.x - player.x) / len, dy: (closest.y - player.y) / len };
}

function nearestEnemy() {
  let closest = null, closestD2 = Infinity;
  serverEnemies.forEach(e => {
    if ((e.hp || 0) <= 0) return;
    if (!hasLOS(player.x, player.y, e.x, e.y)) return;
    const dx = e.x - player.x, dy = e.y - player.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < closestD2) { closestD2 = d2; closest = e; }
  });
  return closest;
}

// Move player toward (tx, ty) in small steps, stopping before hitting a wall.
// Radius 12 matches normal movement collision.
function _dashTo(tx, ty) {
  const dx = tx - player.x, dy = ty - player.y;
  const d = Math.hypot(dx, dy);
  if (d < 1) return;
  const nx = dx / d, ny = dy / d;
  const R = 12, STEP = 8;
  let safeX = player.x, safeY = player.y;
  for (let s = STEP; s <= d + STEP; s += STEP) {
    const cx = player.x + nx * Math.min(s, d);
    const cy = player.y + ny * Math.min(s, d);
    // Check center + forward edge + two side edges, plus the level-gate
    // strip so dash/jump skills can't hop straight over a locked gate the
    // player couldn't otherwise walk through.
    if (isWall(cx + nx * R, cy + ny * R) ||
        isWall(cx - ny * R, cy + nx * R) ||
        isWall(cx + ny * R, cy - nx * R) ||
        (typeof _isGateBlocked === 'function' && _isGateBlocked(cx, cy))) break;
    safeX = cx; safeY = cy;
  }
  player.x = safeX; player.y = safeY;
}

// PvP: return targeted/nearest other player as {id, op}, or null
function _pvpPlayerTarget() {
  if (!pvpMode) return null;
  if (targetIsPlayer && targetId) {
    const op = otherPlayers.get(targetId);
    if (op && (op.hp || 0) > 0 && op.x != null) return { id: targetId, op };
  }
  let best = null, bestId = null, bestD2 = Infinity;
  otherPlayers.forEach((op, id) => {
    if ((op.hp || 0) <= 0 || op.x == null) return;
    const dx = op.x - player.x, dy = op.y - player.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; best = op; bestId = id; }
  });
  return best ? { id: bestId, op: best } : null;
}

// PvP: skill damage AOE hitting all nearby other players
function _pvpSkillAOE(r, mult, key) {
  if (!pvpMode) return;
  otherPlayers.forEach((op, id) => {
    if ((op.hp || 0) <= 0 || op.x == null) return;
    if (dist(op.x, op.y, player.x, player.y) < r) netPvpSkillAttack(id, mult, key);
  });
}

// PvP: slow all nearby other players
function _pvpSkillSlow(r, duration) {
  if (!pvpMode) return;
  otherPlayers.forEach((op, id) => {
    if ((op.hp || 0) <= 0 || op.x == null) return;
    if (dist(op.x, op.y, player.x, player.y) < r) {
      op.slowTimer = duration;
      netPvpSkillCC(id, 'slow', duration);
    }
  });
}

function useSkill(idx) {
  if (!player || state !== 'playing') return;
  if ((player.stunTimer || 0) > 0) return;
  // Frozen on the death-battle start line — no getting a buff or a dash off
  // before the countdown ends (the server refuses these too).
  if (typeof _dbFrozen === 'function' && _dbFrozen()) return;
  const skills = SKILL_DEF[player.type];
  if (!skills || !skills[idx]) return;
  const sk = skills[idx];
  if (_skillLvl(sk.key) <= 0) {
    dmgNum(player.x, player.y - 38, '🔒 Навык не изучен', '#f17e8b');
    return;
  }
  if ((player.skillCooldowns[sk.key] || 0) > 0) return;

  player.skillCooldowns[sk.key] = sk.cd * (1 - (player.cdrPct || 0));
  skillFlash = { key: sk.key, timer: 0.4 };
  player.atkAnimTimer = 0.675; player.castDuration = 0.675; player.animFrame = 0; player.animTimer = 0;

  if (player.type === 'deathknight') {
    if (sk.key === 'Q') {
      // Таймер здесь остаётся только для иконки на панели навыков: лечит
      // окно на СЕРВЕРЕ, и открывает его netSkillHeal, а не эта строка.
      if (_advActive('Q')) { // Истощение — 15% lifesteal + 20% ATK, 10s (+1s per level)
        vampirismTimer = 10 + _skillBuffSec('Q');
        advDkQAtkTimer = 10 + _skillBuffSec('Q');
        recompute();
        if (typeof netSkillHeal === 'function') netSkillHeal('Q');
        dmgNum(player.x, player.y - 40, '🩸 Истощение!', '#f5c542');
        spawnBurst(player.x, player.y, '#f5c542', 12);
      } else { // Вампиризм — 10% lifesteal for 10s (+1s per level)
        vampirismTimer = 10 + _skillBuffSec('Q');
        if (typeof netSkillHeal === 'function') netSkillHeal('Q');
        dmgNum(player.x, player.y - 40, '🩸 Вампиризм!', '#a5f');
        spawnBurst(player.x, player.y, '#a5f', 10);
      }
    } else if (sk.key === 'W') {
      if (_advActive('W')) { // Жадность — +5% crit damage, 20 min (+1s per level)
        critDmgBuffTimer = 1200 + _skillBuffSec('W');
        recompute();
        dmgNum(player.x, player.y - 40, '💰 Жадность!', '#f5c542');
        spawnBurst(player.x, player.y, '#f5c542', 10);
      } else { // Смерч клинков — AOE 110
        spawnAOE(player.x, player.y, 110, 'fissure', '#9c2a3a', '#5a3a7a');
        _skillAOEMult(110, _skillMult('W'), 'W'); netSpawnAoe(player.x, player.y, 110, 'fissure', '#9c2a3a', '#5a3a7a');
        _pvpSkillAOE(110, _skillMult('W'), 'W');
      }
    } else if (sk.key === 'E') {
      if (_advActive('E')) { // Безумие — +25% ATK + basic attacks splash AOE, 5s (+1s per level)
        madnessTimer = 5 + _skillBuffSec('E');
        recompute();
        dmgNum(player.x, player.y - 40, '💢 Безумие!', '#f5c542');
        spawnBurst(player.x, player.y, '#f5c542', 12);
      } else { // Гнев мертвеца — +20% ATK 5s (+1s per level)
        battleCryTimer = 5 + _skillBuffSec('E');
        recompute(); // applies the buff off the timer above and pushes the new stats to the server
        dmgNum(player.x, player.y - 40, '⚔ +20% ATK!', '#a5f');
        spawnBurst(player.x, player.y, '#a5f', 10);
      }
    } else if (sk.key === 'R') { // Рывок тьмы / Охота — dash 140px toward target/enemy, ×1.5 on arrival;
      // advanced additionally strips 20% of the (PvE) target's defense for 10s.
      const _advR = _advActive('R');
      const _pvpR = _pvpPlayerTarget();
      let _rdx, _rdy, _chargeTarget = null, _chargePvpTarget = null;
      if (_pvpR) {
        _rdx = _pvpR.op.x - player.x; _rdy = _pvpR.op.y - player.y;
        _chargePvpTarget = _pvpR;
      } else {
        _chargeTarget = (targetId && !targetIsPlayer)
          ? serverEnemies.find(e => e.id === targetId && (e.hp || 0) > 0)
          : nearestEnemy();
        if (_chargeTarget) { _rdx = _chargeTarget.x - player.x; _rdy = _chargeTarget.y - player.y; }
        else { _rdx = joy.dx || 1; _rdy = joy.dy || 0; }
      }
      const len = Math.hypot(_rdx, _rdy) || 1;
      _dashTo(player.x + (_rdx / len) * 140, player.y + (_rdy / len) * 140);
      if (_chargePvpTarget) {
        netPvpSkillAttack(_chargePvpTarget.id, _skillMult('R'), 'R');
        faceTowards(_chargePvpTarget.op.x, _chargePvpTarget.op.y);
        spawnAOE(_chargePvpTarget.op.x, _chargePvpTarget.op.y, 40);
      } else if (_chargeTarget) {
        netSkillAttack(_chargeTarget.id, _skillMult('R'), 'R');
        if (_advR && typeof netSkillDefDown === 'function') netSkillDefDown(_chargeTarget.id, 10);
        faceTowards(_chargeTarget.x, _chargeTarget.y);
        spawnAOE(_chargeTarget.x, _chargeTarget.y, 40);
      }
      if (_advR) dmgNum(player.x, player.y - 40, '🏹 Охота!', '#f5c542');
      spawnBurst(player.x, player.y, _advR ? '#f5c542' : '#a5f', 8);
    }
  } else if (player.type === 'ranger') {
    if (sk.key === 'Q') {
      if (_advActive('Q')) { // Град стрел — AOE ×3, radius 220
        spawnAOE(player.x, player.y, 220, 'pulse', '#8fbf5a');
        _skillAOEMult(220, _skillMult('Q'), 'Q'); netSpawnAoe(player.x, player.y, 220, 'pulse', '#8fbf5a');
        _pvpSkillAOE(220, _skillMult('Q'), 'Q');
        dmgNum(player.x, player.y - 40, '🏹 Град стрел!', '#f5c542');
      } else { // Multi-Shot — 3 arrows fan
        const dir = nearestEnemyDir();
        const base = Math.atan2(dir.dy, dir.dx);
        const dmgMult = _skillDmgMult('Q');
        [-0.35, 0, 0.35].forEach(off => {
          const ang = base + off;
          const p = { x: player.x, y: player.y, vx: Math.cos(ang)*380, vy: Math.sin(ang)*380,
            color: '#8fbf5a', dmg: player.atk * dmgMult, pvpMult: dmgMult, life: 1.5, size: 5, isPlayer: true, projType: 'arrow', angle: ang };
          projs.push(p);
          netSpawnProj({ x: p.x, y: p.y, vx: p.vx, vy: p.vy, color: '#8fbf5a', size: 5, projType: 'arrow', angle: ang, life: 1.5 });
        });
        _skillDirMult(dir.dx, dir.dy, 220, 0.1, dmgMult, 'Q');
      }
    } else if (sk.key === 'W') {
      if (_advActive('W')) { // Остриё — ×3 damage + 2s stun on nearest/PvP target
        const stunDur = 2 + _skillBuffSec('W');
        const pvpTgt = _pvpPlayerTarget();
        if (pvpTgt) {
          spawnAOE(pvpTgt.op.x, pvpTgt.op.y, 40);
          netPvpSkillAttack(pvpTgt.id, _skillMult('W'), 'W');
          pvpTgt.op.stunTimer = stunDur;
          netPvpSkillCC(pvpTgt.id, 'stun', stunDur);
          faceTowards(pvpTgt.op.x, pvpTgt.op.y);
        } else {
          const tgt = nearestEnemy();
          if (tgt) {
            spawnAOE(tgt.x, tgt.y, 40);
            netSkillAttack(tgt.id, _skillMult('W'), 'W');
            tgt.stunTimer = stunDur;
            netSkillStun(tgt.id, stunDur);
            faceTowards(tgt.x, tgt.y);
          }
        }
        spawnBurst(player.x, player.y, '#f5c542', 8);
        dmgNum(player.x, player.y - 40, '🎯 Остриё!', '#f5c542');
      } else { // Combo Arrow — 3 arrows toward target
        const dir = nearestEnemyDir();
        const ang = Math.atan2(dir.dy, dir.dx);
        const dmgMult = _skillDmgMult('W');
        [0, 80, 160].forEach(delayMs => {
          setTimeout(() => {
            if (!player) return;
            projs.push({ x: player.x, y: player.y, vx: Math.cos(ang)*400, vy: Math.sin(ang)*400,
              color: '#a8d47a', dmg: player.atk * dmgMult, pvpMult: dmgMult, life: 1.5, size: 5, isPlayer: true, projType: 'arrow', angle: ang });
            netSpawnProj({ x: player.x, y: player.y, vx: Math.cos(ang)*400, vy: Math.sin(ang)*400,
              color: '#a8d47a', size: 5, projType: 'arrow', angle: ang, life: 1.5 });
          }, delayMs);
        });
        _skillDirMult(dir.dx, dir.dy, 240, 0.5, dmgMult, 'W');
      }
    } else if (sk.key === 'E') {
      if (_advActive('E')) { // Баф Крит — +5% crit chance, 20 min (+1s per level)
        critChanceBuffTimer = 1200 + _skillBuffSec('E');
        recompute();
        dmgNum(player.x, player.y - 40, '🎯 Баф Крит!', '#f5c542');
        spawnBurst(player.x, player.y, '#f5c542', 10);
      } else { // Jump — dash 80px (+1s per level)
        dodgeTimer = 0.6 + _skillBuffSec('E');
        const dx = joy.dx || 0, dy = joy.dy || 0;
        const len = Math.hypot(dx, dy) || 1;
        _dashTo(player.x + (dx / len) * 80, player.y + (dy / len) * 80);
        spawnBurst(player.x, player.y, '#7e7', 6);
      }
    } else if (sk.key === 'R') { // Скорость атаки / Ускорение — ×1.5 or (advanced) ×2 attack speed
      // for 5s (+1s per level); recompute() itself picks the multiplier off
      // _advActive('R'), so this cast is identical either way.
      atkSpeedTimer = 5 + _skillBuffSec('R');
      recompute();
      // Порог между принятыми ударами сервер считает от скорости атаки, а про
      // этот баф он узнаёт только отсюда — см. Room._attackMinGapMs.
      if (typeof netSkillHaste === 'function') netSkillHaste('R');
      const _advR2 = _advActive('R');
      dmgNum(player.x, player.y - 40, _advR2 ? '⚡ Ускорение!' : '⚡ Скорость!', _advR2 ? '#f5c542' : '#ffd98a');
      spawnBurst(player.x, player.y, _advR2 ? '#f5c542' : '#ffd98a', 8);
    }
  } else if (player.type === 'mage') {
    if (sk.key === 'Q') {
      const _advQ = _advActive('Q');
      const dir = nearestEnemyDir();
      const ang = Math.atan2(dir.dy, dir.dx);
      const dmgMult = _skillMult('Q'); // Урон молнии ×3 / Ледяной шар ×2
      projs.push({ x: player.x, y: player.y, vx: Math.cos(ang)*340, vy: Math.sin(ang)*340,
        color: _advQ ? '#f5c542' : '#f60', dmg: player.atk * dmgMult, pvpMult: dmgMult, life: 2, size: 11, isPlayer: true, projType: 'ball', angle: ang });
      _skillDirMult(dir.dx, dir.dy, 160, 0.5, dmgMult, 'Q');
      netSpawnProj({ x: player.x, y: player.y, vx: Math.cos(ang)*340, vy: Math.sin(ang)*340, color: _advQ ? '#f5c542' : '#f60', size: 11, projType: 'ball', angle: ang, life: 2 });
      if (_advQ) { // + 3s stun (+1s per level) on the same target the shot is aimed at
        const stunDur = 3 + _skillBuffSec('Q');
        const pvpTgt = _pvpPlayerTarget();
        if (pvpTgt) {
          pvpTgt.op.stunTimer = stunDur;
          netPvpSkillCC(pvpTgt.id, 'stun', stunDur);
        } else {
          const tgt = nearestEnemy();
          if (tgt) { tgt.stunTimer = stunDur; netSkillStun(tgt.id, stunDur); }
        }
        dmgNum(player.x, player.y - 40, '⚡ Урон молнии!', '#f5c542');
      }
    } else if (sk.key === 'W') {
      const _advW = _advActive('W');
      const r = _advW ? 220 : 130;
      const dmgMult = _skillMult('W'); // Разряд ×3 / Ледяная нова ×1
      spawnAOE(player.x, player.y, r, 'frost', '#66ccff');
      _skillAOEMult(r, dmgMult, 'W'); netSpawnAoe(player.x, player.y, r, 'frost', '#66ccff');
      const slowIds = [];
      serverEnemies.forEach(e => {
        if ((e.hp || 0) <= 0) return;
        if (dist(e.x, e.y, player.x, player.y) < r) { e.slowTimer = 3; slowIds.push(e.id); }
      });
      if (slowIds.length) netSkillSlow(slowIds, 3);
      _pvpSkillAOE(r, dmgMult, 'W');
      _pvpSkillSlow(r, 3);
      dmgNum(player.x, player.y - 40, _advW ? '⚡ Разряд!' : '❄ Заморозка!', _advW ? '#f5c542' : '#ffe0a8');
      spawnBurst(player.x, player.y, _advW ? '#f5c542' : '#ffe0a8', 12);
    } else if (sk.key === 'E') {
      if (_advActive('E')) { // Вспышка — AOE ×2 damage, radius 220 + the same +80% DEF 3s (+1s per level)
        spawnAOE(player.x, player.y, 220, 'flash', '#c9a3ff');
        _skillAOEMult(220, _skillMult('E'), 'E'); netSpawnAoe(player.x, player.y, 220, 'flash', '#c9a3ff');
        _pvpSkillAOE(220, _skillMult('E'), 'E');
        barrierTimer = 3 + _skillBuffSec('E');
        recompute();
        dmgNum(player.x, player.y - 40, '✨ Вспышка!', '#f5c542');
        spawnBurst(player.x, player.y, '#f5c542', 14);
      } else { // Barrier — +50% DEF for 3s (+1s per level)
        barrierTimer = 3 + _skillBuffSec('E');
        recompute();
        dmgNum(player.x, player.y - 40, '🔮 Барьер!', '#e8e');
        spawnBurst(player.x, player.y, '#e8e', 8);
      }
    } else if (sk.key === 'R') { // Teleport / Перенесение — dash (+10px per level);
      // advanced additionally restores 20% HP on arrival.
      const _advR3 = _advActive('R');
      const dx = joy.dx || 0, dy = joy.dy || 0;
      const len = Math.hypot(dx, dy) || 1;
      const range = 180 + _skillMobRange('R');
      const tx = player.x + (dx / len) * range;
      const ty = player.y + (dy / len) * range;
      spawnBurst(player.x, player.y, '#f4f', 6);
      _dashTo(tx, ty); // steps toward tx/ty, stopping at walls or locked gates
      spawnBurst(player.x, player.y, _advR3 ? '#f5c542' : '#f4f', 6);
      // Лечение начисляет сервер и присылает 'skillHeal' с суммой — здесь
      // остаётся только подпись, чтобы название навыка появилось сразу, а не
      // через круг до сервера и обратно.
      if (_advR3) {
        if (typeof netSkillHeal === 'function') netSkillHeal('R');
        dmgNum(player.x, player.y - 50, 'Перенесение!', '#f5c542');
      }
    }
  } else if (player.type === 'warlock') {
    if (sk.key === 'Q') {
      if (_advActive('Q')) { // Бабочки — summon for 10s, healing 5% maxHP/sec (+1s per level)
        // Таймер — для иконки. Тики лечения идут с сервера (_regenTick), где
        // им и место: раньше их отсчитывал кадр, и сервер о них не знал.
        butterfliesTimer = 10 + _skillBuffSec('Q');
        _butterfliesTickAcc = 0;
        if (typeof netSkillHeal === 'function') netSkillHeal('Q');
        dmgNum(player.x, player.y - 40, '🦋 Бабочки!', '#f5c542');
        spawnBurst(player.x, player.y, '#f5c542', 14);
      } else { // Тёмное исцеление — +20% maxHP (+1% per level)
        if (typeof netSkillHeal === 'function') netSkillHeal('Q');
        spawnBurst(player.x, player.y, '#a855e0', 8);
      }
    } else if (sk.key === 'W') { // Оковы тьмы / Колючие оковы — stun nearest/PvP target 3s
      // (+1s per level); advanced also deals ×3 damage (base PvE stun deals
      // none today — only its PvP branch already did, at ×1).
      const _advW3 = _advActive('W');
      const stunDur = 3 + _skillBuffSec('W');
      const dmgMult3 = _skillMult('W');
      const pvpTgt = _pvpPlayerTarget();
      if (pvpTgt) {
        spawnAOE(pvpTgt.op.x, pvpTgt.op.y, 40);
        netPvpSkillAttack(pvpTgt.id, dmgMult3, 'W');
        pvpTgt.op.stunTimer = stunDur;
        netPvpSkillCC(pvpTgt.id, 'stun', stunDur);
        faceTowards(pvpTgt.op.x, pvpTgt.op.y);
      } else {
        const tgt = nearestEnemy();
        if (tgt) {
          spawnAOE(tgt.x, tgt.y, 40);
          if (_advW3) netSkillAttack(tgt.id, dmgMult3, 'W');
          tgt.stunTimer = stunDur;
          netSkillStun(tgt.id, stunDur);
          faceTowards(tgt.x, tgt.y);
        }
      }
      spawnBurst(player.x, player.y, _advW3 ? '#f5c542' : '#a855e0', 8);
      dmgNum(player.x, player.y - 40, _advW3 ? '⛓ Колючие оковы!' : '⛓ Оковы тьмы!', _advW3 ? '#f5c542' : '#a855e0');
    } else if (sk.key === 'E') { // Тёмный щит / Жажда — +50% DEF self + party 4s (+1s per
      // level); advanced additionally grants ×2 attack speed for the same duration.
      const _advE3 = _advActive('E');
      faithShieldTimer = 4 + _skillBuffSec('E');
      if (_advE3) atkSpeedTimer = 4 + _skillBuffSec('E');
      recompute();
      // См. комментарий у «Ускорения» лучника выше.
      if (_advE3 && typeof netSkillHaste === 'function') netSkillHaste('E');
      if (typeof netFaithShield === 'function') netFaithShield(faithShieldTimer);
      dmgNum(player.x, player.y - 40, _advE3 ? '⚡ Жажда!' : '🛡 Тёмный щит!', _advE3 ? '#f5c542' : '#a855e0');
      spawnBurst(player.x, player.y, _advE3 ? '#f5c542' : '#a855e0', 10);
    } else if (sk.key === 'R') { // Тёмная молитва / Исцеление — heals self + party for 10%
      // (or, advanced, 20%) of maxHP (+1% per level).
      // Один вызов на всё: сервер лечит и заклинателя, и группу, одной и той
      // же суммой. Прежний обработчик 'healParty' лечил ТОЛЬКО чужих и требовал
      // группу — одиночный чернокнижник не получал ничего, а его собственное
      // лечение целиком жило вот в этой строке и откатывалось на следующей
      // поправке HP.
      const _advR4 = _advActive('R');
      dmgNum(player.x, player.y - 50, _advR4 ? 'Исцеление!' : 'Молитва!', _advR4 ? '#f5c542' : '#a855e0');
      spawnBurst(player.x, player.y, _advR4 ? '#f5c542' : '#a855e0', 14);
      if (typeof netSkillHeal === 'function') netSkillHeal('R');
    }
  } else if (player.type === 'lev') {
    if (sk.key === 'Q') { // Пинок / Молот гнева — single target, base ×2 + 3s
      // stun, advanced ×3 + 5s stun (+1s per level either way).
      const _advQ2 = _advActive('Q');
      const stunDur = (_advQ2 ? 5 : 3) + _skillBuffSec('Q');
      const dmgMult4 = _skillMult('Q');
      const pvpTgt = _pvpPlayerTarget();
      if (pvpTgt) {
        spawnAOE(pvpTgt.op.x, pvpTgt.op.y, 50);
        netPvpSkillAttack(pvpTgt.id, dmgMult4, 'Q');
        pvpTgt.op.stunTimer = stunDur;
        netPvpSkillCC(pvpTgt.id, 'stun', stunDur);
        faceTowards(pvpTgt.op.x, pvpTgt.op.y);
      } else {
        const tgt = nearestEnemy();
        if (tgt) {
          spawnAOE(tgt.x, tgt.y, 50);
          netSkillAttack(tgt.id, dmgMult4, 'Q');
          tgt.stunTimer = stunDur;
          netSkillStun(tgt.id, stunDur);
          faceTowards(tgt.x, tgt.y);
        }
      }
      spawnBurst(player.x, player.y, _advQ2 ? '#f5c542' : '#e8e0cc', 8);
      dmgNum(player.x, player.y - 40, _advQ2 ? '🔨 Молот гнева!' : '🥾 Пинок!', _advQ2 ? '#f5c542' : '#e8e0cc');
    } else if (sk.key === 'W') { // Вихрь клинка / Вихрь — AOE, base radius 110,
      // advanced ×2 damage at radius 220.
      const _advW4 = _advActive('W');
      const r2 = _advW4 ? 220 : 110;
      spawnAOE(player.x, player.y, r2, 'shockwave', '#ccccdd');
      _skillAOEMult(r2, _skillMult('W'), 'W'); netSpawnAoe(player.x, player.y, r2, 'shockwave', '#ccccdd');
      _pvpSkillAOE(r2, _skillMult('W'), 'W');
    } else if (sk.key === 'E') { // Гнев мертвеца / Щит — +80% DEF 10s (+1s per
      // level) either way; advanced additionally gives +10% ATK for the same duration.
      const _advE4 = _advActive('E');
      guardTimer = 10 + _skillBuffSec('E');
      if (_advE4) levShieldAtkTimer = 10 + _skillBuffSec('E');
      recompute();
      dmgNum(player.x, player.y - 40, _advE4 ? '🛡 Щит!' : '🛡 +80% DEF!', _advE4 ? '#f5c542' : '#e8e0cc');
      spawnBurst(player.x, player.y, _advE4 ? '#f5c542' : '#e8e0cc', 10);
    } else if (sk.key === 'R') { // Кувырок / Рывок — dash 140px toward
      // target/enemy, ×1.5 on arrival; advanced additionally slows the (PvE)
      // target 30% for 10s.
      const _advR5 = _advActive('R');
      const _pvpR = _pvpPlayerTarget();
      let _rdx, _rdy, _chargeTarget = null, _chargePvpTarget = null;
      if (_pvpR) {
        _rdx = _pvpR.op.x - player.x; _rdy = _pvpR.op.y - player.y;
        _chargePvpTarget = _pvpR;
      } else {
        _chargeTarget = (targetId && !targetIsPlayer)
          ? serverEnemies.find(e => e.id === targetId && (e.hp || 0) > 0)
          : nearestEnemy();
        if (_chargeTarget) { _rdx = _chargeTarget.x - player.x; _rdy = _chargeTarget.y - player.y; }
        else { _rdx = joy.dx || 1; _rdy = joy.dy || 0; }
      }
      const len = Math.hypot(_rdx, _rdy) || 1;
      _dashTo(player.x + (_rdx / len) * 140, player.y + (_rdy / len) * 140);
      if (_chargePvpTarget) {
        netPvpSkillAttack(_chargePvpTarget.id, _skillMult('R'), 'R');
        if (_advR5) { _chargePvpTarget.op.slowTimer = 10; netPvpSkillCC(_chargePvpTarget.id, 'slow', 10); }
        faceTowards(_chargePvpTarget.op.x, _chargePvpTarget.op.y);
        spawnAOE(_chargePvpTarget.op.x, _chargePvpTarget.op.y, 40);
      } else if (_chargeTarget) {
        netSkillAttack(_chargeTarget.id, _skillMult('R'), 'R');
        if (_advR5) { _chargeTarget.slowTimer = 10; netSkillSlow([_chargeTarget.id], 10); }
        faceTowards(_chargeTarget.x, _chargeTarget.y);
        spawnAOE(_chargeTarget.x, _chargeTarget.y, 40);
      }
      spawnBurst(player.x, player.y, _advR5 ? '#f5c542' : '#e8e0cc', 8);
    }
  }
}

// Rebuilds a saved item against the LIVE catalog (shared/definitions.js),
// trusting the save only for the truly player-specific fields (enhance,
// qty). A saved item's own name/img/stats are a frozen snapshot of whatever
// language/balance was active the last time the account was saved — reading
// through the catalog instead means an item picked up before a language
// switch (or before this account was ever restored) still shows correctly
// translated the next time it's rendered, same as items picked up fresh.
function _rebuildFromCatalog(it) {
  if (!it) return null;
  const base = (typeof itemCatalogBase === 'function') ? itemCatalogBase(it.id) : null;
  if (!base) return it; // unknown id (e.g. a removed item) — keep as-is rather than dropping it
  const item = { ...base };
  if (it.enhance != null) item.enhance = it.enhance;
  if (it.qty != null) item.qty = it.qty;
  // WHICH copy this is. The catalog knows what a Ring of Ash is; only the
  // database knows which of your three you are pointing at, and this rebuild
  // used to throw that away — so the client could name an item only by
  // (id, enhance), and the server had to pick whichever row matched first.
  //
  // For selling or equipping that is harmless: two rows with the same id and
  // the same enhancement are interchangeable. For ENHANCEMENT it is not, and
  // that is the bug — "точишь одну вещь, и всё похожее точится вместе с ней".
  // With two +2 copies the server enhanced the first row it found, which is
  // not the one the player clicked; enhance again and it found the other. Both
  // climbed. Six item types on one live account are sitting in exact pairs
  // because of it.
  if (it.rowId != null) item.rowId = it.rowId;
  return item;
}

function _migrateInventory(inv) {
  const stacked = [];
  const matMap = {};
  inv.forEach(raw => {
    const it = _rebuildFromCatalog(raw);
    if (!it) return;
    if (_isStackable(it)) {
      if (matMap[it.id]) {
        matMap[it.id].qty = (matMap[it.id].qty || 1) + (it.qty || 1);
      } else {
        const entry = { ...it, qty: it.qty || 1 };
        matMap[it.id] = entry;
        stacked.push(entry);
      }
    } else {
      stacked.push(it);
    }
  });
  return stacked;
}

function restoreFromSave(data) {
  if (!player || !data) return;
  // Account-level language preference, synced across devices — applied here
  // (not just localStorage, see js/i18n.js's initLocale) so a login on a
  // fresh device picks up whatever language was last chosen anywhere.
  if (data.lang && typeof setLang === 'function' && data.lang !== currentLang) setLang(data.lang);
  player.lvl      = data.lvl      || 1;
  // Rounded on load: old saves picked up float noise from party-kill splits
  // (e.g. 2182.666666666666g) before those were fixed to divide to whole
  // numbers server-side — this cleans up anything already persisted.
  player.xp       = Math.round(data.xp   || 0);
  // Derived from the level, never read back from the save: a blob claiming
  // xpNext:1 used to level the character up on every point of XP it earned.
  player.xpNext   = xpToNext(player.lvl);
  player.gold     = Math.floor(data.gold || 0);
  player.kills    = data.kills    || 0;
  // migrate old integer potions save → potionBag
  if (data.potionBag) {
    player.potionBag = { pt1: 0, pt2: 0, ...data.potionBag };
  } else {
    player.potionBag = { pt1: data.potions ?? 3, pt2: 0 };
  }
  player.hudPotion  = data.hudPotion  || 'pt1';
  player.buffs      = data.buffs      || {};
  player.potCd      = 0;
  player.autoHpPct  = data.autoHpPct  != null ? data.autoHpPct : 0;
  player.autoBuffTypes = data.autoBuffTypes || {};
  // Absent means "never set" — auto-cast stays on, which is what every
  // account had before the switch existed.
  player.autoSkillsOn  = data.autoSkillsOn !== false;
  player.autoSkillOff  = data.autoSkillOff || {};
  player.baseAtk  = data.baseAtk  || player.baseAtk;
  player.baseDef  = data.baseDef  || player.baseDef;
  player.baseMaxHp= data.baseMaxHp|| player.baseMaxHp;
  player.inventory  = _migrateInventory(data.inventory || []);
  player.storage    = _migrateInventory(data.storage || []);
  player.upgrades = data.upgrades || { atk:0, def:0, hp:0, atkSpeed:0, critChance:0, critPower:0, hpRegen:0 };
  player.bonusSP  = data.bonusSP  || 0;
  player.keptSP   = data.keptSP   || 0;
  player.empowers = data.empowers || 0;
  player.starterBonus = !!data.starterBonus;
  player.questIdx  = data.questIdx  || 0;
  player.questKills = data.questKills || {};
  player.specialQuestsDone = data.specialQuestsDone || [];

  // Migrate old save: armor → body
  const rawEq = data.equipment || {};
  if (rawEq.armor && !rawEq.body) rawEq.body = rawEq.armor;
  delete rawEq.armor;

  const blank = { weapon:null, helmet:null, body:null, gloves:null, boots:null, ring:null, belt:null, pet:null, cloak:null, artifact:null };
  // strip removed slots from old saves
  const { offhand:_, legs:__, pendant:___, ...cleanEq } = rawEq;
  const rebuiltEq = {};
  Object.keys(cleanEq).forEach(slot => { if (cleanEq[slot]) rebuiltEq[slot] = _rebuildFromCatalog(cleanEq[slot]); });
  player.equipment = { ...blank, ...rebuiltEq };

  player.skillLevels = { Q:0, W:0, E:0, R:0, ...(data.skillLevels || {}) };
  player.passiveLevels = { ...(data.passiveLevels || {}) };
  // "Вторая профессия" — advSkillLearned is permanent (one-time book spend,
  // see learnAdvSkill, js/ui.js); advSkillActive is a free toggle on top of
  // it and defaults to false (base skill) even once learned, same as any
  // other loadout choice — see _activeSkillDef, js/player.js.
  player.advSkillLearned = { Q:false, W:false, E:false, R:false, ...(data.advSkillLearned || {}) };
  player.advSkillActive  = { Q:false, W:false, E:false, R:false, ...(data.advSkillActive || {}) };
  // Server corrects this via codexSync moments after connect
  // (registerCodexSetItem is the only path that ever changes it), same as
  // skillLevels/passiveLevels above — restoring it here just avoids a stat
  // flash on load. Guards against the old (pre-sets) array-shaped field too.
  player.codex = (data.codex && typeof data.codex === 'object' && !Array.isArray(data.codex)) ? { ...data.codex } : {};
  player.codexBonus = (typeof codexTotalBonus === 'function') ? codexTotalBonus(player.codex) : { atk:0, def:0, hp:0 };
  recompute();
  player.hp = (data.hp && data.hp > 0) ? Math.min(data.hp, player.maxHp) : player.maxHp;
}

function statStr(it) {
  const p = [];
  if (it.atk)       p.push('ATK+' + it.atk);
  if (it.def)       p.push('DEF+' + it.def);
  if (it.hp)        p.push('HP+' + it.hp);
  if (it.critChance) p.push('Крит+' + (it.critChance * 100).toFixed(0) + '%');
  if (it.atkSpeed)   p.push('Скор+' + (it.atkSpeed   * 100).toFixed(0) + '%');
  if (it.hpPct)      p.push('HP+' +  (it.hpPct       * 100).toFixed(0) + '%макс');
  if (it.skillPct)   p.push('Навыки+' + (it.skillPct * 100).toFixed(0) + '%');
  return p.join('  ');
}
