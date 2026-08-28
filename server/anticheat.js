'use strict';
// What a client-supplied save blob is allowed to SAY — shape and bounds, not
// entitlement. The catalog rebuild, the numeric clamps and the bounded key
// maps live here.
//
// Most of what this file used to do is gone, because the questions it answered
// stopped existing: the item census, the catastrophic-reset guard and the XP
// ledger were all ways of auditing a client-authored character. The character
// is the server's now (see the pins in saveProgress/selectChar), so what
// remains is the job of not letting a malformed blob into the database — bad
// types, junk keys, absurd numbers — plus the catalog rebuild that reading a
// STORED record still needs.
//
// Pure functions over a blob and the shared catalog: no models, no sockets, no
// session state, which is what makes them testable on their own.
const {
  ITEM_DEF, CRAFT_MATS, BOX_DEF, CHAR_DEF,
  ENHANCE_MAX, ENHANCEABLE_SLOTS, isStackableItem,
  xpToNext, skillPointCeiling, spentSkillPoints,
} = require('../shared/definitions');

const SERVER_INV_MAX = 150; // matches invHasSpace() in js/player.js

// The XP multipliers a buff can apply, kept here because _xpCeilingFor still
// uses them. The ledger they were written for is gone: the server applies XP
// and runs the level curve itself now (_grantXp, server/index.js), so there is
// no client claim left to measure against a ceiling.
const XP_CLAN_MAX_PCT = 20;
const XP_POTION_MULT  = 2;
// Progress a join may claim beyond the stored record — the same "last few
// seconds before an unclean disconnect" the debounce has always risked, worth
// about thirty kills at the player's own level. Deliberately derived from the
// DB value on every join rather than from the previous ceiling, so repeated
// reconnects can't ratchet it: at level 40 this is ~1.2k XP against a level
// that costs 136M, so no number of them adds up to anything.
const XP_JOIN_SLACK_KILLS = 30;

// Ids the catalog has renamed. Empty today; the indirection is what lets a
// rename land without every stored save losing the item.
const _ITEM_ID_ALIASES = Object.create(null);

// ── Battle Power (БМ) formula ─────────────────────────────────────────────────
// Persists only the given savedData sub-fields (via Mongo dot-notation
// $set), never the whole savedData object. Several call sites used to do
// `findByIdAndUpdate(id, { savedData: {...} })`, which replaces the entire
// nested object — silently wiping any field that call didn't happen to
// know about. vipLevel/vipDeposited/vipPending (set only by the GRAM
// deposit-confirmation flow) and nexumBalance (set only on a Nexum drop)
// were never part of the client's regular save payload, so the very next
// ordinary save (loot pickup, quest, anything) erased them. Dot-notation
// $set only touches the keys actually passed here, leaving everything
// else already in the document untouched.
// ── Anti-cheat: sanitize the client-supplied save blob ─────────────────────────
// The economy in this game is otherwise client-authoritative (loot rolls,
// crafting and enhancing all happen on the client). This does NOT make it fully
// server-authoritative — a *valid* item id the player never legitimately earned
// still passes — but it removes the worst console-injection vectors before the
// blob is persisted or used for server-side combat/BM stats:
//   • fabricated item stats (a "legendary" with atk:99999) — every item is
//     rebuilt from the canonical catalog; only id + enhance + (stackable) qty
//     are trusted, exactly like the Market's _canonicalMarketItem.
//   • non-existent item ids — dropped entirely.
//   • absurd numeric values (gold:1e15, lvl:99999, baseAtk:1e9) — clamped.
// Rebuilding from the catalog is loss-free for legitimate items: the client
// stores each item as {…catalogBase, enhance} and derives the enhance bonus at
// runtime (see recompute()/enhanceBonus()), so no earned stat is discarded.
const _SANITIZE_MAX = {
  gold: 1e12, xp: 1e12, lvl: 1000, kills: 1e9, bonusSP: 1e6, empowers: 1e4,
  maxHp: 1e7, atk: 1e6, def: 1e6, invLen: 500, storageLen: 200,
  // Raised from 9999 for the Осколки: a unique legendary costs 5000 of every
  // kind, so a player working toward a second one legitimately holds well
  // past the old ceiling. See _canonSavedItem for why going over it now
  // clamps instead of resetting.
  qty: 1e6,
  // HP potions per kind (potionBag). Generous — the shop sells them in
  // hundreds — but bounded, where this field used to take any number at all.
  potions: 1e5,
  // Longest buff in the catalog is 30 min; this leaves room above it without
  // letting a save claim a buff that never expires.
  buffDur: 7200,
};

// Bounded { key: value } map out of an arbitrary client object. Keys are
// capped in count and length and values run through `fn`; anything that isn't
// a plain object becomes {}. Used for the progression maps that used to be
// written to the database verbatim (skillLevels, advSkillLearned, ...), where
// what matters is that the container can't be an unbounded junk payload.
const _KEY_MAP_MAX_KEYS = 64;
const _KEY_MAP_MAX_KEY_LEN = 40;

// The HP potions (ITEM_DEF slot 'use') — the only ids potionBag may hold, and
// the only ones usePotion will spend. Derived from the catalog rather than
// hard-coded so adding a third potion needs no change here.
const _HP_POTION_IDS = ITEM_DEF.filter(d => d.slot === 'use').map(d => d.id);
const _HP_POTION_HEAL = new Map(ITEM_DEF.filter(d => d.slot === 'use').map(d => [d.id, Math.max(0, Number(d.hp) || 0)]));
const _BUFF_TYPES = new Set(ITEM_DEF.filter(d => d.slot === 'buff_potion' && d.buffType).map(d => d.buffType));
// The four skill slots — same list server/index.js's own SKILL_SLOTS holds,
// needed here to bound autoSkillOff (the АВТО auto-cast opt-outs).
const _SKILL_SLOT_KEYS = new Set(['Q', 'W', 'E', 'R']);

const _VALID_LANGS = ['ru', 'en', 'uk', 'es', 'tr', 'pt'];

function _catalogBase(id) {
  const key = (id != null && _ITEM_ID_ALIASES[id]) || id;
  return ITEM_DEF.find(d => d.id === key) || CRAFT_MATS.find(d => d.id === key) || BOX_DEF.find(d => d.id === key) || null;
}

// Item ids in a save blob that the catalog no longer knows — i.e. exactly what
// sanitizing is about to delete. Only ever called when the sanitized result
// came out shorter than the raw one, so the scan costs nothing on the normal
// path; its whole job is to turn a silent deletion into a log line naming the
// ids, so a wave of "my items vanished" after a deploy is answerable.
function _unknownItemIds(raw) {
  const out = new Set();
  const scan = it => { if (it && typeof it === 'object' && it.id != null && !_catalogBase(it.id)) out.add(String(it.id)); };
  if (Array.isArray(raw?.inventory)) raw.inventory.forEach(scan);
  if (Array.isArray(raw?.storage)) raw.storage.forEach(scan);
  const eq = raw?.equipment;
  if (eq && typeof eq === 'object' && !Array.isArray(eq)) Object.values(eq).forEach(scan);
  return [...out];
}

// Rebuild one inventory/equipment entry from the canonical catalog, trusting the
// client only for id, enhance level and (stackables) qty. Unknown id → null.
function _canonSavedItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const base = _catalogBase(raw.id);
  if (!base) return null;
  const item = { ...base };
  if (ENHANCEABLE_SLOTS.has(base.slot)) {
    const enh = Math.floor(Number(raw.enhance));
    item.enhance = (Number.isFinite(enh) && enh >= 0 && enh <= ENHANCE_MAX) ? enh : 0;
  }
  if (isStackableItem(base)) {
    const qty = Math.floor(Number(raw.qty));
    // Over the ceiling CLAMPS rather than resetting to 1. The old reset was a
    // trap once stacks got big: a legitimate pile one over the bound was
    // destroyed outright, and destroying goods is a far worse failure than
    // capping a forged number — the census in saveProgress is what actually
    // stops items being minted, and it compares against the stored baseline,
    // so a clamped value cannot smuggle anything past it either.
    item.qty = Number.isFinite(qty) && qty >= 1 ? Math.min(qty, _SANITIZE_MAX.qty) : 1;
  }
  return item;
}



function _clampNum(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

function _clampInt(v, min, max, dflt) { return Math.floor(_clampNum(v, min, max, dflt)); }

function _sanitizeKeyMap(raw, fn) {
  if (raw === undefined) return undefined;
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (n >= _KEY_MAP_MAX_KEYS) break;
    if (typeof k !== 'string' || k.length > _KEY_MAP_MAX_KEY_LEN) continue;
    out[k] = fn(v);
    n++;
  }
  return out;
}

function _sanitizeSavedStats(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const s = { ...raw };

  // Language preference (js/i18n.js) — display-only, but validate anyway
  // rather than trust an arbitrary client string.
  if (s.lang != null) s.lang = _VALID_LANGS.includes(s.lang) ? s.lang : 'ru';

  // Inventory — canonicalize, drop unknowns, cap length
  s.inventory = Array.isArray(s.inventory)
    ? s.inventory.slice(0, _SANITIZE_MAX.invLen).map(_canonSavedItem).filter(Boolean)
    : [];

  // Storage (Хранилище NPC) — same canonicalization, capped at storageLen slots
  s.storage = Array.isArray(s.storage)
    ? s.storage.slice(0, _SANITIZE_MAX.storageLen).map(_canonSavedItem).filter(Boolean)
    : [];

  // Equipment — { slot: item }; canonicalize, drop unknowns
  if (s.equipment && typeof s.equipment === 'object' && !Array.isArray(s.equipment)) {
    const eq = {};
    for (const [slot, it] of Object.entries(s.equipment)) {
      if (!it) continue;
      const c = _canonSavedItem(it);
      if (c) eq[slot] = c;
    }
    s.equipment = eq;
  } else {
    s.equipment = {};
  }

  // Numeric progression clamps (reject NaN/Infinity/negatives/absurd values)
  s.gold    = _clampInt(s.gold,    0, _SANITIZE_MAX.gold, 0);
  s.lvl     = _clampInt(s.lvl,     1, _SANITIZE_MAX.lvl, 1);
  s.xp      = _clampNum(s.xp,      0, _SANITIZE_MAX.xp, 0);
  s.kills   = _clampInt(s.kills,   0, _SANITIZE_MAX.kills, 0);
  s.bonusSP = _clampInt(s.bonusSP, 0, _SANITIZE_MAX.bonusSP, 0);
  s.empowers = _clampInt(s.empowers, 0, _SANITIZE_MAX.empowers, 0);
  // Points Перерождение carried across its level reset (see the skill point
  // accounting block in shared/definitions.js). Server-written like bonusSP —
  // saveProgress pins it from the session copy — but clamped here all the same,
  // because a STORED record is read through this function too.
  s.keptSP  = _clampInt(s.keptSP,  0, _SANITIZE_MAX.bonusSP, 0);
  if (s.maxHp     != null) s.maxHp     = _clampInt(s.maxHp,     1, _SANITIZE_MAX.maxHp, 100);
  if (s.hp        != null) s.hp        = _clampNum(s.hp,        0, s.maxHp ?? _SANITIZE_MAX.maxHp, 0);
  if (s.atk       != null) s.atk       = _clampNum(s.atk,       0, _SANITIZE_MAX.atk, 0);
  if (s.def       != null) s.def       = _clampNum(s.def,       0, _SANITIZE_MAX.def, 0);
  // baseAtk/baseDef/baseMaxHp are a pure function of class + level — gainXP
  // (js/player.js) starts them at the class's CHAR_DEF stats and adds a flat
  // +1/+1/+20 on every level-up, nothing else ever changes them. They used
  // to be trusted straight from the client here (just clamped to a huge
  // ceiling), which was a direct line to real, server-enforced PvE *and*
  // PvP combat power: these three feed computeStats (server/game/Room.js)
  // with no relationship to whether the reported level actually earned
  // them. Derived here instead of trusted, so the client's own copy of
  // these fields is simply ignored.
  const _cd = CHAR_DEF[s.type] || CHAR_DEF.lev;
  s.baseAtk   = _cd.baseAtk + (s.lvl - 1);
  s.baseDef   = _cd.baseDef + (s.lvl - 1);
  s.baseMaxHp = _cd.baseHP  + (s.lvl - 1) * 20;
  // Same treatment, same reason: xpNext is a pure function of the level (see
  // xpToNext, shared/definitions.js), but it round-tripped through the client
  // — saved by it and handed straight back on load. A blob claiming
  // xpNext:1 levelled the character up on every single point of XP, and
  // level is what every line above derives real combat power from.
  s.xpNext = xpToNext(s.lvl);
  if (s.autoHpPct != null) s.autoHpPct = _clampNum(s.autoHpPct, 0, 1, 0.5);

  // Upgrade points spent must not exceed what the (now server-derived) lvl/
  // bonusSP/keptSP could actually have paid for — skillPointCeiling
  // (shared/definitions.js), the same accounting the client's own panel and
  // the spendUpgrade handler read. Nothing enforced it here once, so a crafted
  // save could report any upgrades total up to the per-stat ceiling regardless
  // of level — and, same as baseAtk/baseDef above, these feed real combat power
  // via computeStats. A legitimate client can never violate this ceiling, so a
  // save that does is treated the same as an untrusted item id: the whole map
  // is dropped rather than guessing which entries (if any) were legitimate.
  if (s.upgrades && typeof s.upgrades === 'object' && !Array.isArray(s.upgrades)) {
    const u = {};
    for (const [k, v] of Object.entries(s.upgrades)) u[k] = _clampInt(v, 0, 1e5, 0);
    const _spent = spentSkillPoints(u);
    // The CEILING, not what's spendable: straight after a Перерождение the kept
    // upgrades are worth more than a level-1 character's own curve plus bonus,
    // which is exactly what keptSP is here to account for. availableSkillPoints
    // is what gates buying a point (the spendUpgrade handler); this only
    // decides whether the map as a whole could have been paid for.
    s.upgrades = _spent <= skillPointCeiling(s) ? u : {};
    // A commitment can never exceed what is actually committed — so a reset
    // (which empties the map) takes the carried points with it, and a dropped
    // map above leaves nothing behind to be re-spent later.
    s.keptSP = Math.min(s.keptSP, spentSkillPoints(s.upgrades));
  } else {
    s.keptSP = 0;
  }
  // ── Fields that used to pass through untouched ────────────────────────────
  // Everything above this point was validated; these were not, and went into
  // the stored document exactly as the client sent them — arbitrary keys,
  // arbitrary sizes, arbitrary values. They are all still CLIENT-OWNED (HP
  // potions are bought client-side, skills are learned client-side by
  // consuming a book, which is a shrink the save path already allows), so the
  // job here is shape and bounds, not entitlement: a save can no longer carry
  // a hundred-kilobyte junk object or a nonsense value into the database.
  //
  // potionBag is the one with teeth: the usePotion handler now spends from
  // this copy, so it has to be a small map of REAL potion ids to sane counts.
  {
    const bag = {};
    for (const id of _HP_POTION_IDS) bag[id] = 0;
    if (s.potionBag && typeof s.potionBag === 'object' && !Array.isArray(s.potionBag)) {
      for (const id of _HP_POTION_IDS) {
        const n = Math.floor(Number(s.potionBag[id]));
        bag[id] = Number.isFinite(n) && n > 0 ? Math.min(n, _SANITIZE_MAX.potions) : 0;
      }
    } else if (s.potions != null) {
      // Legacy record: a single `potions` integer from before the bag existed.
      // restoreFromSave (js/player.js) migrates it to pt1 the same way — doing
      // it here too means a session that falls back to the stored blob (a
      // selectChar with no savedStats) doesn't zero those potions out.
      const n = Math.floor(Number(s.potions));
      if (Number.isFinite(n) && n > 0) bag[_HP_POTION_IDS[0]] = Math.min(n, _SANITIZE_MAX.potions);
    }
    s.potionBag = bag;
  }
  if (s.hudPotion != null) s.hudPotion = _HP_POTION_IDS.includes(s.hudPotion) ? s.hudPotion : _HP_POTION_IDS[0];
  // Character class. Validated rather than pinned: the char-select flow does
  // legitimately write a new one (see selectChar's own $set), so the rule is
  // "a known class or nothing" — an unknown value is dropped entirely, and
  // _persistSavedFields skips undefined, so the stored class stays put.
  if (s.type != null && !CHAR_DEF[s.type]) delete s.type;
  // Skill/passive progression: bounded shape only. passiveLevels is
  // additionally clamped per-entry where it is actually read
  // (passiveBonusTotal, shared/definitions.js), and the skill multiplier a
  // client claims in combat is clamped to ×10 in Room.js regardless of what
  // these say — so bounding the container is what is missing, not a new
  // entitlement check.
  s.skillLevels    = _sanitizeKeyMap(s.skillLevels,    v => _clampInt(v, 0, 99, 0));
  s.passiveLevels  = _sanitizeKeyMap(s.passiveLevels,  v => _clampInt(v, 0, 99, 0));
  s.advSkillLearned = _sanitizeKeyMap(s.advSkillLearned, v => !!v);
  s.advSkillActive  = _sanitizeKeyMap(s.advSkillActive,  v => !!v);
  // Active buff timers, in seconds. Only the buff types that exist, and never
  // longer than the longest buff in the catalog.
  if (s.buffs !== undefined) {
    const b = {};
    if (s.buffs && typeof s.buffs === 'object' && !Array.isArray(s.buffs)) {
      for (const [k, v] of Object.entries(s.buffs)) {
        if (!_BUFF_TYPES.has(k)) continue;
        const n = _clampNum(v, 0, _SANITIZE_MAX.buffDur, 0);
        if (n > 0) b[k] = n;
      }
    }
    s.buffs = b;
  }
  // Per-type auto-redrink toggles for buff potions — same bounded-shape
  // treatment as buffs above: only known buff types survive, as booleans.
  if (s.autoBuffTypes !== undefined) {
    const ab = {};
    if (s.autoBuffTypes && typeof s.autoBuffTypes === 'object' && !Array.isArray(s.autoBuffTypes)) {
      for (const [k, v] of Object.entries(s.autoBuffTypes)) {
        if (!_BUFF_TYPES.has(k) || !v) continue;
        ab[k] = true;
      }
    }
    s.autoBuffTypes = ab;
  }
  // АВТО's auto-cast settings: a master switch and the set of skill slots the
  // player switched off. Same bounded-shape treatment — only the four real
  // slot keys survive, as booleans. Both are display preferences the client
  // owns (nothing on this side reads them), so the only job here is to keep a
  // junk blob from being stored and handed back.
  if (s.autoSkillsOn != null) s.autoSkillsOn = !!s.autoSkillsOn;
  if (s.autoSkillOff !== undefined) {
    const as = {};
    if (s.autoSkillOff && typeof s.autoSkillOff === 'object' && !Array.isArray(s.autoSkillOff)) {
      for (const [k, v] of Object.entries(s.autoSkillOff)) {
        if (!_SKILL_SLOT_KEYS.has(k) || !v) continue;
        as[k] = true;
      }
    }
    s.autoSkillOff = as;
  }
  // Freshness stamp used only to pick the newer of {DB, client localStorage
  // backup} on reload. Clamp to a sane range so a client can't write a
  // far-future value that would make its record permanently "win".
  if (s.savedAt != null) s.savedAt = _clampInt(s.savedAt, 0, Date.now() + 60000, 0);
  // Real-money balances are server-authoritative and are NEVER taken from the
  // client blob — they live in _gramBalanceCache/_nexumBalanceCache and are
  // re-attached explicitly by every persist path (see _liveGram/_liveNexum).
  // Dropping them here (rather than merely overriding them downstream) means
  // a client can't inject a balance, and a future persist call that forgets
  // the explicit override writes nothing for these keys instead of writing a
  // client-supplied number — _persistSavedFields skips undefined values.
  delete s.gramBalance;
  delete s.nexumBalance;
  // VIP progress is set only by gramShopBuy's own targeted $set (server/
  // index.js) after a real GRAM spend, never by this general save path — but
  // unlike the balances above, nothing here ever stripped it, so a crafted
  // saveProgress carrying e.g. vipPending:[1..10] was accepted verbatim and
  // claimVipRewards (which reads it straight back from the DB) would then
  // hand out every VIP tier's items and gold for free, plus the permanent
  // per-kill xp/gold/drop bonuses that come with a fake vipLevel — without a
  // single GRAM ever being spent. Same reasoning as gramBalance/nexumBalance:
  // drop it here so the DB write below leaves whatever the real purchase
  // flow last set untouched.
  delete s.vipLevel;
  delete s.vipDeposited;
  delete s.vipPending;
  // Same reasoning: a fake seasonTicket:true is a free permanent x2 xp / drop
  // / Liberty bonus. Owned exclusively by gramShopBuy's targeted $set.
  delete s.seasonTicket;
  // specialQuestsDone gates completeSpecialQuest's once-only claim via a DB
  // $ne filter against this very array — but the array itself came from this
  // same client-trusted save path, so a saveProgress that simply omitted an
  // id (or reset the whole array) let that quest's reward be claimed again.
  // Stripped for the same reason as vipPending: the server already owns this
  // field via completeSpecialQuest's own targeted $set.
  delete s.specialQuestsDone;
  // Season points and quest progress decide who takes a real prize, so they
  // are owned exclusively by the handlers that award them — same rule the
  // currency balances and vipPending already follow.
  delete s.seasonPoints;
  delete s.seasonQuest;
  delete s.seasonQuests;
  delete s.seasonTier;
  delete s.seasonBossPaid;
  // Season 2's own running total (Season 1 used seasonPoints, above) — same
  // reasoning, still server-authoritative only.
  delete s.seasonPoints2;
  // Набор новичка: the once-per-account free kit (starterBonusClaim, server/
  // handlers/gram.js) is gated entirely by this flag, and its own conditional
  // write is what sets it. Left in the blob, a save could simply clear it and
  // claim a second set of gear and 300 potions — same reasoning as the VIP and
  // season fields above. Stripped, so the save path never writes this key at
  // all and whatever the claim recorded stands.
  delete s.starterBonus;
  // "This invited friend has already been counted." Lives on the friend's own
  // record, so without this they could clear it and have their referrer paid
  // the 200 again on the next login.
  delete s.seasonRefPaid;
  return s;
}


// Keep in sync with the identical calcBM in js/definitions.js — the client
// renders this number in the HUD and clan panel, the server stores it for
// the rating, and the two disagreeing is immediately visible to players.
// The level field is `lvl` everywhere (save blobs and the live player object
// alike); reading `s.level` matched nothing, so the level term silently
// collapsed to its `|| 1` fallback and BM ignored levels entirely.
function calcBM(s) {
  if (!s) return 0;
  const upg = s.upgrades || {};
  const extras = ((upg.critChance || 0) + (upg.critPower || 0) +
    (upg.hpRegen || 0) + (upg.atkSpeed || 0)) * 8;
  return Math.round((s.lvl || s.level || 1) * 50 + (s.atk || 0) * 5 + (s.def || 0) * 3 + (s.maxHp || 100) * 0.5 + extras);
}

function _xpCeilingFor(n) { return Math.round(n * (1 + XP_CLAN_MAX_PCT / 100)) * XP_POTION_MULT; }

module.exports = {
  SERVER_INV_MAX, XP_CLAN_MAX_PCT, XP_POTION_MULT, XP_JOIN_SLACK_KILLS, _SANITIZE_MAX, _HP_POTION_IDS, _HP_POTION_HEAL,
  _catalogBase, _unknownItemIds, _canonSavedItem,
  _clampNum, _clampInt, _sanitizeKeyMap,
  _sanitizeSavedStats, calcBM, _xpCeilingFor,
};
