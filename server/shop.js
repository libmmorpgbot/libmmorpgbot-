'use strict';
// GRAM shop / VIP reward tables, moved out of server/index.js verbatim.
//
// Pure data and pure functions over the shared catalog: no models, no
// sockets, no session state — same shape as server/inventory.js.
const { CRAFT_MATS, BOX_DEF, SEASON_TICKET_GRAM_PRICE } = require('../shared/definitions');

// ── VIP item data (server-side subset of js/definitions.js) ──────────────────
const _VIP_WEAPONS = {
  deathknight: {
    uncommon:  { id:'sw2', name:'Стальной меч',   slot:'weapon', img:'/images/wep/uk.png', atk:14, critChance:0.03,      rarity:'uncommon' },
    rare:      { id:'sw3', name:'Меч дракона',    slot:'weapon', img:'/images/wep/rk.png', atk:23, critChance:0.05,       rarity:'rare'     },
    epic:      { id:'sw4', name:'Меч теней',      slot:'weapon', img:'/images/wep/ek.png', atk:44, critChance:0.10,       rarity:'epic'     },
    legendary: { id:'sw5', name:'Меч героя',      slot:'weapon', img:'/images/wep/lk.png', atk:65, critChance:0.25,       rarity:'legendary'},
  },
  lev: {
    uncommon:  { id:'tw2', name:'Стальной топор', slot:'weapon', img:'/images/wep/ut.png', atk:15, def:6,                rarity:'uncommon' },
    rare:      { id:'tw3', name:'Топор дракона',  slot:'weapon', img:'/images/wep/rt.png', atk:23, def:10,               rarity:'rare'     },
    epic:      { id:'tw4', name:'Топор теней',    slot:'weapon', img:'/images/wep/et.png', atk:44, def:16,               rarity:'epic'     },
    legendary: { id:'tw5', name:'Топор героя',    slot:'weapon', img:'/images/wep/lt.png', atk:65, def:24,               rarity:'legendary'},
  },
  ranger: {
    uncommon:  { id:'bw2', name:'Серебряный лук', slot:'weapon', img:'/images/wep/ub.png', atk:18, atkSpeed:0.03,         rarity:'uncommon' },
    rare:      { id:'bw3', name:'Лук охотника',   slot:'weapon', img:'/images/wep/rb.png', atk:28, atkSpeed:0.05,         rarity:'rare'     },
    epic:      { id:'bw4', name:'Лунный лук',     slot:'weapon', img:'/images/wep/eb.png', atk:60, atkSpeed:0.10,         rarity:'epic'     },
    legendary: { id:'bw5', name:'Лук героя',      slot:'weapon', img:'/images/wep/lb.png', atk:100,atkSpeed:0.15,critChance:0.10,rarity:'legendary'},
  },
};
_VIP_WEAPONS.mage = {
  uncommon:  { id:'st2', name:'Посох бойца',    slot:'weapon', img:'/images/wep/us.png', atk:17, hpPct:0.03,  rarity:'uncommon' },
  rare:      { id:'st3', name:'Посох охотника', slot:'weapon', img:'/images/wep/rs.png', atk:30, hpPct:0.05,  rarity:'rare'     },
  epic:      { id:'st4', name:'Посох Героя',    slot:'weapon', img:'/images/wep/es.png', atk:60, hpPct:0.10,  rarity:'epic'     },
  legendary: { id:'st5', name:'Посох Легенды',  slot:'weapon', img:'/images/wep/ls.png', atk:100,hpPct:0.15,  rarity:'legendary'},
};
_VIP_WEAPONS.warlock = _VIP_WEAPONS.mage;
_VIP_WEAPONS.runefighter = {
  uncommon:  { id:'rf2', name:'Стальной рунный клинок', slot:'weapon', img:'/images/wep/un.png', atk:16, critChance:0.03, rarity:'uncommon' },
  rare:      { id:'rf3', name:'Клинок дракона',         slot:'weapon', img:'/images/wep/rn.png', atk:26, critChance:0.06, rarity:'rare'     },
  epic:      { id:'rf4', name:'Клинок теней',           slot:'weapon', img:'/images/wep/en.png', atk:48, critChance:0.12, rarity:'epic'     },
  legendary: { id:'rf5', name:'Клинок героя',           slot:'weapon', img:'/images/wep/ln.png', atk:70, critChance:0.28, rarity:'legendary'},
};
_VIP_WEAPONS.assassin = {
  uncommon:  { id:'as2', name:'Стальной кинжал', slot:'weapon', img:'/images/wep/ud.png', atk:17, critChance:0.06, rarity:'uncommon' },
  rare:      { id:'as3', name:'Кинжал дракона',  slot:'weapon', img:'/images/wep/rd.png', atk:27, critChance:0.10, rarity:'rare'     },
  epic:      { id:'as4', name:'Кинжал теней',    slot:'weapon', img:'/images/wep/ed.png', atk:50, critChance:0.16, rarity:'epic'     },
  legendary: { id:'as5', name:'Кинжал героя',    slot:'weapon', img:'/images/wep/ld.png', atk:74, critChance:0.32, rarity:'legendary'},
};

const _VIP_BP = [
  { id:'bp_hp',       name:'Зелье здоровья',  slot:'buff_potion', img:'/images/potion/hp.png',       rarity:'uncommon', buffType:'hp',       buffDur:600},
  { id:'bp_exp',      name:'Зелье опыта',      slot:'buff_potion', img:'/images/potion/exp.png',      rarity:'uncommon', buffType:'exp',      buffDur:600},
  { id:'bp_gold',     name:'Зелье золота',     slot:'buff_potion', img:'/images/potion/gold.png',     rarity:'uncommon', buffType:'gold',     buffDur:600},
  { id:'bp_regen',    name:'Зелье регена',     slot:'buff_potion', img:'/images/potion/regen.png',    rarity:'uncommon', buffType:'regen',    buffDur:600},
  { id:'bp_atkspeed', name:'Зелье скорости',   slot:'buff_potion', img:'/images/potion/atkspeed.png', rarity:'uncommon', buffType:'atkspeed', buffDur:600},
  { id:'bp_atk',      name:'Зелье атаки',      slot:'buff_potion', img:'/images/potion/atk.png',      rarity:'uncommon', buffType:'atk',      buffDur:600},
];

// ── GRAM Shop ─────────────────────────────────────────────────────────────────
// Plain nominal price — the end-of-season -30% sale that used to apply here
// (for as long as seasonActive() held) was removed at the owner's request.
// This is the authoritative price, charged in gramShopBuy; js/ui.js's own
// pkgPrice mirrors it exactly, for the same reason js/ui.js's copy always
// has: what the client shows and gates "afford" on must match what actually
// gets charged, or a card reads as affordable/priced at one number and the
// purchase bills another.
function pkgPrice(pkg) {
  return pkg.gram;
}
// skillBooks grants skill books for the buyer's OWN class (see charClass
// below) — `random: N` picks N books independently at random (can repeat),
// `each: N` grants N copies of EVERY one of the class's 4 books.
// Every other package (pkg1-pkg600, extrapkg1-6, rmat1-3) was removed here at
// the owner's request — the GRAM shop now sells exactly one thing. A past
// receipt for any of those ids still shows the generic «Пакет» fallback
// (packageFallbackLbl, js/ui.js), the same way an old pkg300 receipt already
// did before this list ever grew that large.
const _GRAM_SHOP_PKGS = [
  // Сезонный билет — grants no items, just flips a status flag (gramShopBuy's
  // own seasonTicket branch) that boosts kill rewards for as long as the
  // current season runs (see shared/definitions.js's SEASON_TICKET_* section).
  { id:'season_ticket', gram: SEASON_TICKET_GRAM_PRICE, seasonTicket:true },
];

// Weapon IDs per class and rarity for the shop (reuses ITEM_DEF entries)
const _SHOP_CLASS_WEAPONS = {
  lev:         { common:'tw1', uncommon:'tw2', rare:'tw3', epic:'tw4' },
  deathknight: { common:'sw1', uncommon:'sw2', rare:'sw3', epic:'sw4' },
  ranger:      { common:'bw1', uncommon:'bw2', rare:'bw3', epic:'bw4' },
  mage:        { common:'st1', uncommon:'st2', rare:'st3', epic:'st4' },
  warlock:     { common:'st1', uncommon:'st2', rare:'st3', epic:'st4' },
  runefighter: { common:'rf1', uncommon:'rf2', rare:'rf3', epic:'rf4' },
  assassin:    { common:'as1', uncommon:'as2', rare:'as3', epic:'as4' },
};
// Armor slot IDs per rarity for the shop
const _SHOP_ARMOR_SETS = {
  common:   ['hm1','ar1','gl1','bt1','rn1','nd1'],
  uncommon: ['hm2','ar2','gl2','bt2','rn2','nd2'],
  rare:     ['hm3','ar3','gl3','bt3','rn3','nd3'],
  epic:     ['hm4','ar4','gl4','bt4','rn4','nd4'],
};
// Wings item id per rarity (ITEM_DEF's wing_c..wing_l) — used by the
// extrapkg1-6 packages' `wings` field, the same way _SHOP_ARMOR_SETS
// resolves `armor`.
const _WING_ID = {
  common: 'wing_c', uncommon: 'wing_u', rare: 'wing_r', epic: 'wing_e', legendary: 'wing_l',
};
// How many NEW inventory slots a package needs, given what the player already
// holds. Mirrors exactly what gramShopBuy grants below — stackables that merge
// into an existing entry cost nothing, everything else is one slot per item.
// Kept next to the package tables so the two can't drift apart.
function _shopNewSlots(pkg, inv, charClass) {
  const has = id => inv.some(i => i && i.id === id);
  const pending = new Set();          // ids this purchase will itself create
  let slots = 0;
  const need = (id, stackable) => {
    if (stackable) {
      if (has(id) || pending.has(id)) return;
      pending.add(id);
    }
    slots++;
  };

  if (pkg.potions > 0) _VIP_BP.forEach(bp => need(bp.id, true));
  if (pkg.armor) (_SHOP_ARMOR_SETS[pkg.armor] || []).forEach(() => slots++);
  if (pkg.weapon) {
    const wepMap = _SHOP_CLASS_WEAPONS[charClass] || _SHOP_CLASS_WEAPONS.lev;
    if (wepMap[pkg.weapon]) slots++;
  }
  if (pkg.skillBooks) {
    const classBooks = CRAFT_MATS.filter(m => m.forClass === charClass && m.skillKey);
    if (pkg.skillBooks.each) classBooks.forEach(bk => need(bk.id, true));
    // `random` picks N books independently, so worst case it touches every one
    else if (pkg.skillBooks.random) classBooks.forEach(bk => need(bk.id, true));
  }
  if (pkg.boxes) Object.keys(pkg.boxes).forEach(boxId => need(boxId, true));
  if (pkg.stones) Object.keys(pkg.stones).forEach(sid => need(sid, true));
  if (pkg.classArtifact) slots++;
  if (pkg.classCloak) slots++;
  if (pkg.petChoice) slots++;
  return slots;
}

const _GRAM_WITHDRAW_FEE_PCT = 0.10;

const _STONE_DEFS = {
  norm_stone:  { id:'norm_stone',  name:'Камень обычной заточки',    img:'/images/norm.png',  slot:'material', rarity:'uncommon' },
  bless_stone: { id:'bless_stone', name:'Камень безопасной заточки', img:'/images/bless.png', slot:'material', rarity:'rare'     },
};

function _vipLevelItems(vipLevel, charClass) {
  const wepMap = _VIP_WEAPONS[charClass] || _VIP_WEAPONS.lev;
  const items = [];
  function addStone(id, qty) { if (qty > 0) items.push({ ..._STONE_DEFS[id], qty }); }
  function addBP(qty)        { _VIP_BP.forEach(bp => items.push({ ...bp, qty })); }
  function addWep(rarity, enhance) {
    const w = wepMap[rarity]; if (w) items.push({ ...w, enhance: enhance || 0, qty: 1 });
  }
  function addBox(id, qty) {
    if (qty <= 0) return;
    const b = BOX_DEF.find(x => x.id === id);
    if (b) items.push({ ...b, qty });
  }
  switch (vipLevel) {
    case 2:  addBox('box_uncommon', 3); break;
    case 3:  addStone('bless_stone', 2); addBox('box_uncommon', 5); break;
    case 4:  addStone('bless_stone', 5); addBP(10); addBox('box_rare', 2); addBox('box_uncommon', 3); break;
    case 5:  addStone('bless_stone', 7); addBP(10); addBox('box_rare', 5); break;
    case 6:  addWep('uncommon', 8); addStone('bless_stone', 7); addBP(10); addBox('box_rare', 10); break;
    case 7:  addWep('rare', 8); addStone('norm_stone', 20); addStone('bless_stone', 10); addBox('box_rare', 15); break;
    case 8:  addWep('epic', 1); addBP(50); addStone('norm_stone', 50); addStone('bless_stone', 30); addBox('box_rare', 20); break;
    case 9:  addWep('epic', 8); addBP(80); addStone('norm_stone', 70); addStone('bless_stone', 30); addBox('box_rare', 25); break;
    case 10: addWep('legendary', 0); addBP(100); addStone('norm_stone', 100); addStone('bless_stone', 100); addBox('box_rare', 30); break;
    default: break;
  }
  return items;
}

function _vipGoldReward(vipLevel) {
  if (vipLevel === 7) return 10000;
  if (vipLevel === 8) return 20000;
  return 0;
}

module.exports = {
  _VIP_WEAPONS, _VIP_BP,
  pkgPrice, _GRAM_SHOP_PKGS,
  _SHOP_CLASS_WEAPONS, _SHOP_ARMOR_SETS, _WING_ID, _shopNewSlots,
  _GRAM_WITHDRAW_FEE_PCT, _STONE_DEFS, _vipLevelItems, _vipGoldReward,
};
