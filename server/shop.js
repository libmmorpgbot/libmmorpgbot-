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

const _VIP_BP = [
  { id:'bp_hp',       name:'Зелье здоровья',  slot:'buff_potion', img:'/images/potion/hp.png',       rarity:'uncommon', buffType:'hp',       buffDur:600},
  { id:'bp_exp',      name:'Зелье опыта',      slot:'buff_potion', img:'/images/potion/exp.png',      rarity:'uncommon', buffType:'exp',      buffDur:600},
  { id:'bp_gold',     name:'Зелье золота',     slot:'buff_potion', img:'/images/potion/gold.png',     rarity:'uncommon', buffType:'gold',     buffDur:600},
  { id:'bp_regen',    name:'Зелье регена',     slot:'buff_potion', img:'/images/potion/regen.png',    rarity:'uncommon', buffType:'regen',    buffDur:600},
  { id:'bp_atkspeed', name:'Зелье скорости',   slot:'buff_potion', img:'/images/potion/atkspeed.png', rarity:'uncommon', buffType:'atkspeed', buffDur:600},
  { id:'bp_atk',      name:'Зелье атаки',      slot:'buff_potion', img:'/images/potion/atk.png',      rarity:'uncommon', buffType:'atk',      buffDur:600},
];

// ── GRAM Shop ─────────────────────────────────────────────────────────────────
// Every package sells at its own nominal price — the 30% discount that used
// to apply here (and the per-package noDiscount flag that opted specific
// packs out of it) has been removed entirely. Mirrors js/ui.js's own
// pkgPrice, which is what actually draws the price — this is what gets
// charged, in gramShopBuy.
function pkgPrice(pkg) { return pkg.gram; }
// skillBooks grants skill books for the buyer's OWN class (see charClass
// below) — `random: N` picks N books independently at random (can repeat),
// `each: N` grants N copies of EVERY one of the class's 4 books.
const _GRAM_SHOP_PKGS = [
  { id:'pkg1',   gram:1,   gold:10000,  potions:2,   armor:null,       weapon:null,       bonusSP:0,  skillBooks:null },
  { id:'pkg5',   gram:5,   gold:5000,   potions:10,  armor:'uncommon', weapon:'uncommon', bonusSP:0,  skillBooks:{ random:1 } },
  { id:'pkg10',  gram:20,  gold:7000,   potions:20,  armor:'uncommon', weapon:'uncommon', bonusSP:1,  skillBooks:{ random:5 }, enhance:5, nexum:500 },
  { id:'pkg50',  gram:100, gold:50000,  potions:50,  armor:'rare',     weapon:'rare',     bonusSP:5,  skillBooks:{ each:4 },  boxes:{ box_rare:5 },  enhance:3, nexum:4000 },
  { id:'pkg100', gram:180, gold:100000, potions:100, armor:'rare',     weapon:'rare',     bonusSP:10, skillBooks:{ each:12 }, boxes:{ box_rare:15 }, enhance:8, nexum:10000 },
  // pkg300 («Эпический» / «+Pack») стоял здесь — полный эпический комплект
  // с оружием в +3, 50 благословенных камней, 60 классовых книг, Liberty и
  // бонусные очки навыка за 600 GRAM. Товар убран целиком по просьбе
  // владельца: кнопки на HUD нет, карточки в магазине нет, и этой строки
  // нет — значит gramShopBuy на 'pkg300' отвечает «нет такого пакета», а не
  // списывает GRAM за то, чего в игре уже не существует.
  //
  // Прошлые покупки при этом остаются в GramTx как были: id в чеке — это
  // запись о том, что случилось, а не ссылка на живой товар. Подпишется
  // такой чек общим «Пакет» (packageFallbackLbl, js/ui.js).
  // Pet+cloak+artifact packages (rendered on the GRAM shop's own Питомцы
  // tab, js/ui.js's _SPECIAL_PET_PKGS_UI — bought through this same handler
  // since petChoice/classCloak/classArtifact/enhance are already fully
  // supported below, just never previously used by any other package).
  // classCloak/classArtifact only ever exist at common/uncommon (see
  // ITEM_DEF) — there is no rare tier, so petpkg3's own pet jump to rare
  // isn't mirrored there.
  { id:'petpkg1', gram:50,  gold:0, potions:0, armor:null, weapon:null, bonusSP:0, skillBooks:null,
    petChoice:'common',   classCloak:'common',   classArtifact:'common',   enhance:8 },
  { id:'petpkg2', gram:150, gold:0, potions:0, armor:null, weapon:null, bonusSP:0, skillBooks:null,
    petChoice:'uncommon', classCloak:'uncommon', classArtifact:'uncommon', enhance:10 },
  { id:'petpkg3', gram:250, gold:0, potions:0, armor:null, weapon:null, bonusSP:0, skillBooks:null,
    petChoice:'rare',     classCloak:'uncommon', classArtifact:'uncommon', enhance:10 },
  // Усиление tab — pure material packs. These only GRANT the listed
  // items (via the same pkg.boxes/pkg.stones handling every other package
  // already uses below — `stones` isn't stone-specific, it resolves any
  // CRAFT_MATS id, which is how rece/recl and norm_stone land here too);
  // buying one never performs an empowerment by itself, that's still the
  // separate 'empower' event above, spending materials out of the inventory
  // these packs fill.
  //
  // Id'ы остались rmat1-3 со времён, когда вкладка называлась Перерождением:
  // они записаны в GramTx каждой прошлой покупки, и переименование разорвало
  // бы связь чека с товаром.
  //
  // norm_stone добавлен вместе с Усилением: обычные камни заточки входят в
  // его цену, и без них набор перестал бы покрывать ровно одно усиление —
  // ради чего наборы и собраны по этой шкале.
  { id:'rmat1', gram:25, boxes:{ box_uncommon:10, box_rare:5  }, stones:{ rece:100, recl:30,  norm_stone:20  } },
  { id:'rmat2', gram:40, boxes:{ box_uncommon:20, box_rare:10 }, stones:{ rece:200, recl:60,  norm_stone:40  } },
  { id:'rmat3', gram:80, boxes:{ box_uncommon:50, box_rare:25 }, stones:{ rece:500, recl:150, norm_stone:100 } },
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
};
// Armor slot IDs per rarity for the shop
const _SHOP_ARMOR_SETS = {
  common:   ['hm1','ar1','gl1','bt1','rn1','nd1'],
  uncommon: ['hm2','ar2','gl2','bt2','rn2','nd2'],
  rare:     ['hm3','ar3','gl3','bt3','rn3','nd3'],
  epic:     ['hm4','ar4','gl4','bt4','rn4','nd4'],
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
  _SHOP_CLASS_WEAPONS, _SHOP_ARMOR_SETS, _shopNewSlots,
  _GRAM_WITHDRAW_FEE_PCT, _STONE_DEFS, _vipLevelItems, _vipGoldReward,
};
