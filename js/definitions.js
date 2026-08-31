// CHAR_DEF, ENEMY_DEF, TILE, WALL, FLOOR, CLAN_LEVELS, clanAtkBonusPct → shared/definitions.js

// Presentation only: label, icon, and the one-line effect blurb. There is
// deliberately no price column here — every stat upgrade costs the same flat
// upgradeCost(lvl) (shared/definitions.js), which is what the server actually
// deducts (spendUpgrade, down through server/db/repos/players.js) and what
// updateUpgradeUI prints (js/ui.js). A per-stat baseCost — 30/30/25/50/60/60/80
// — used to sit in these entries. It outlived the switch to the flat formula
// and was then read by nothing on either end, so this table sat here quietly
// stating prices the game had not charged in a long time: the kind of lie that
// gets believed the first time someone reprices upgrades and edits the table
// instead of the formula.
const UPGRADE_DEF = {
  atk:        { label:'Атака',       icon:'sword',      desc:'+1 ATK'       },
  def:        { label:'Защита',      icon:'shield',     desc:'+1 DEF'       },
  hp:         { label:'Здоровье',    icon:'heart',      desc:'+10 MaxHP'    },
  atkSpeed:   { label:'Скор. атаки', icon:'lightning',  desc:'+0.05 уд/с'  },
  critChance: { label:'Шанс крита',  icon:'star',       desc:'+1%'          },
  critPower:  { label:'Сила крита',  icon:'flame',      desc:'+3%'          },
  hpRegen:    { label:'Реген HP',    icon:'hpPlus',     desc:'+0.1/сек'     },
};

// Story quest chain: one linear track (player.questIdx) spanning all 4
// corridor arms up to global monster level 78 — 15 quests per arm, each
// arm roughly doubling the previous one's rewards and player-level asks
// (×1/×2/×4/×8 off the floor-1 baseline) so every chapter is noticeably
// harder than the last. Each arm's 3 (2 for arm 4) monster species show up
// in story order weakest→toughest: early kill quests hit the arm's first
// species, the mid-chapter pair introduces its second species, the big
// grind before the boss is its toughest species, matching the level-up
// experience of actually walking further down that corridor. Enemy names
// must match ENEMY_DEF's base names exactly (shared/definitions.js) —
// onEnemyKill() counts kills by that exact string, before any rank prefix.
// The 1st/5th/10th/15th quest of every arm (by array order, not by id
// suffix — quest ids run out of sequence, e.g. f1q11 sits 10th) also hands
// out one of each buff potion, since the merchant no longer sells them.
// _BUFF_POTION_IDS and QUEST_DEF now live in shared/definitions.js so the
// server can validate and grant quest rewards itself (see the claimQuest
// handler, server/index.js). That file is bundled ahead of this one
// (BUNDLE_FILES), so both names are already in scope here.


// Kept as a deliberate, distinct hue ladder (grey -> moss -> steel-blue ->
// amethyst -> gold) rather than run through the general dark-fantasy
// recolor pass below — collapsing rare/epic toward the new gold accent
// would erase the rarity tiers players read at a glance.
const RARITY_COLOR = {
  common:    '#9c9086',
  uncommon:  '#6f9c4a',
  rare:      '#4a7bab',
  epic:      '#8a5cc2',
  legendary: '#e8b93e',
};

// CRAFT_MATS, ITEM_DEF → shared/definitions.js (server needs the same
// canonical item catalog to validate Market listings against)

// Order matters: updateInvUI (js/ui.js) splits this in half for the
// equipment diamond's two columns (first 5 → left, last 5 → right).
const EQ_SLOTS = [
  { slot:'weapon',   label:'Оружие',  emptyIcon:'weapon'   },
  { slot:'helmet',   label:'Шлем',    emptyIcon:'helmet'   },
  { slot:'body',     label:'Тело',    emptyIcon:'body'     },
  { slot:'gloves',   label:'Перчи',   emptyIcon:'gloves'   },
  { slot:'cloak',    label:'Плащ',    emptyIcon:'cloak'    },
  { slot:'wings',    label:'Крылья',  emptyIcon:'wings'    },
  { slot:'boots',    label:'Боты',    emptyIcon:'boots'    },
  { slot:'ring',     label:'Кольцо',  emptyIcon:'ring'     },
  { slot:'belt',     label:'Пояс',    emptyIcon:'belt'     },
  { slot:'pet',      label:'Питомец', emptyIcon:'pet'      },
  { slot:'artifact', label:'Артефакт',emptyIcon:'artifact' },
];

// icon = SVG fallback (js/icons.js); img = the real skill artwork from
// images/skill/ — both the HUD canvas buttons (drawSkillButtons) and the
// skill-upgrade modal already prefer img over icon when it's set.
//
// `auto:false` marks a skill the auto-cast (VIP 2, see _autoCastSkills in
// js/game.js) must never fire on its own. Every one of them displaces the
// character — a dash, a jump or a teleport — and having those go off by
// themselves means being thrown across the room, into a gate or out of a
// Страх hall while the player is doing something else. They stay fully
// available on the buttons; only the automation leaves them alone.
const SKILL_DEF = {
  // lev <-> deathknight skill sets swapped (name/icon/img/cd/desc only —
  // useSkill()'s per-key mechanics in js/player.js were already identical
  // between these two classes, so swapping the definitions is enough).
  lev: [
    { key:'Q', name:'Ледяной удар',   icon:'shieldBash', img:'/images/skill/wstun_v2.png',   cd:18, desc:'×2 урон по цели + стан 3 сек' },
    { key:'W', name:'Смерч клинков',  icon:'whirlwind',  img:'/images/skill/wvixr_v2.png',   cd:12, desc:'АОЕ урон, радиус 110'          },
    { key:'E', name:'Гнев мертвеца',  icon:'battleCry',  img:'/images/skill/wboevoy_v2.png', cd:20, desc:'+80% защиты на 10 сек'         },
    { key:'R', name:'Рывок света',    icon:'dash',       img:'/images/skill/wrivok_v2.png',  cd:15, desc:'Прыгает к цели нанося урон', auto:false },
  ],
  deathknight: [
    { key:'Q', name:'Вампиризм',    icon:'drop',       img:'/images/skill/adim_v2.png',      cd:28, desc:'Вампиризм 10% от удара на 10 сек' },
    { key:'W', name:'Вихрь клинка', icon:'whirlwind',  img:'/images/skill/asmertudar.png', cd:12, desc:'АОЕ урон, радиус 110'          },
    { key:'E', name:'Ярость',       icon:'battleCry',  img:'/images/skill/ainvidible_v2.png', cd:20, desc:'+20% атака на 5 сек'           },
    { key:'R', name:'Кувырок',      icon:'roll',       img:'/images/skill/audarteni.png',  cd:15, desc:'Прыгает к цели нанося урон', auto:false },
  ],
  ranger: [
    { key:'Q', name:'Мульти-выстрел', icon:'multiShot',   img:'/images/skill/lmulti.png',    cd:6,  desc:'3 стрелы под углом ±0.35 рад' },
    { key:'W', name:'Комбо стрела',   icon:'poisonArrow', img:'/images/skill/lkombo.png',    cd:10, desc:'3 стрелы ×1 урон'             },
    { key:'E', name:'Прыжок',         icon:'roll',        img:'/images/skill/lprijok.png',   cd:8,  desc:'Рывок 80px', auto:false },
    { key:'R', name:'Скорость атаки', icon:'arrowRain',   img:'/images/skill/latkspeed.png', cd:20, desc:'×1.5 скорость атаки на 5 сек' },
  ],
  mage: [
    { key:'Q', name:'Ледяной шар',  icon:'fireball', img:'/images/skill/mshar_v2.png',  cd:5,  desc:'Снаряд ×2 урона'               },
    { key:'W', name:'Ледяная нова', icon:'iceNova',  img:'/images/skill/mnova.png',     cd:10, desc:'АОЕ урон 130 + заморозка 3 сек' },
    { key:'E', name:'Барьер',       icon:'barrier',  img:'/images/skill/mbarier.png',   cd:18, desc:'Защита +50% на 3 сек'           },
    { key:'R', name:'Телепорт',     icon:'teleport', img:'/images/skill/mteleport.png', cd:12, desc:'Рывок 180px по направлению', auto:false },
  ],
  warlock: [
    { key:'Q', name:'Тёмное исцеление', icon:'hpPlus',  img:'/images/skill/sheal.png',        cd:8,  desc:'+20% maxHP'                    },
    { key:'W', name:'Оковы тьмы',       icon:'iceNova', img:'/images/skill/socepinenie.png',  cd:15, desc:'Удерживает цель на месте 3 сек'},
    { key:'E', name:'Тёмный щит',       icon:'barrier', img:'/images/skill/sshit.png',        cd:18, desc:'+50% защита себе и пати 4 сек' },
    { key:'R', name:'Тёмная молитва',   icon:'hpPlus',  img:'/images/skill/spartyheal.png',   cd:25, desc:'+10% maxHP себе и +10% пати'   },
  ],
};

// ── Advanced skills ("вторая профессия") ────────────────────────────────────
// One enhanced replacement per Q/W/E/R slot, same shape as SKILL_DEF (key
// matches so it shares that slot's cooldown/level/book — see _skillLvl,
// player.skillCooldowns). Unlocked per-slot once that slot's book-taught
// level (player.skillLevels[key]) hits the max (10) AND the player has
// learned this slot's advanced book (player.advSkillLearned[key] — a
// separate one-time consumable, ADV_SKILL_BOOK_SRC/CRAFT_MATS in
// shared/definitions.js, dropped only in the Фарм-зона). Once learned,
// toggling player.advSkillActive[key] freely swaps which version useSkill()
// (js/player.js) runs and which one is shown on the HUD button/skill panel
// (see _activeSkillDef, js/player.js) — no extra cost either direction.
// desc numbers are additive over the base skill's own secondary effects
// unless explicitly restated here (e.g. Lev R keeps its arrival damage and
// adds the slow; Mage W keeps its freeze and adds the bigger AOE) — only the
// stat actually named below overrides the base one.
const ADV_SKILL_DEF = {
  lev: [
    { key:'Q', name:'Молот гнева', icon:'shieldBash', img:'/images/skill/adv/adv_molotgneva.png', cd:18, desc:'×3 урон по цели + стан 5 сек' },
    { key:'W', name:'Вихрь',       icon:'whirlwind',  img:'/images/skill/adv/adv_vixr.png',        cd:12, desc:'АОЕ урон ×2, радиус 220' },
    { key:'E', name:'Щит',         icon:'barrier',    img:'/images/skill/adv/adv_shit.png',        cd:20, desc:'+80% защиты и +10% атаки на 10 сек' },
    { key:'R', name:'Рывок',       icon:'dash',       img:'/images/skill/adv/adv_rivok.png',       cd:15, desc:'Прыгает к цели, замедляя её на 30% на 10 сек', auto:false },
  ],
  deathknight: [
    { key:'Q', name:'Истощение', icon:'drop',      img:'/images/skill/adv/adv_istoshenie.png', cd:28, desc:'Вампиризм 15% + атака +20% на 10 сек' },
    { key:'W', name:'Жадность',  icon:'battleCry', img:'/images/skill/adv/adv_jadnost.png',    cd:12, desc:'+5% крит. урона на 20 минут' },
    { key:'E', name:'Безумие',   icon:'battleCry', img:'/images/skill/adv/adv_bezumie.png',    cd:20, desc:'+25% атака, обычные удары наносят АОЕ урон, на 5 сек' },
    { key:'R', name:'Охота',     icon:'roll',      img:'/images/skill/adv/adv_oxota.png',      cd:15, desc:'Прыгает к цели, снимая 20% её защиты на 10 сек', auto:false },
  ],
  ranger: [
    { key:'Q', name:'Град стрел', icon:'arrowRain',   img:'/images/skill/adv/adv_grad.png',        cd:6,  desc:'АОЕ урон ×3, радиус 220' },
    { key:'W', name:'Остриё',     icon:'poisonArrow', img:'/images/skill/adv/adv_ostrie.png',      cd:10, desc:'×3 урон по цели + стан 2 сек' },
    // Base ranger E ("Прыжок") is a dash and carries auto:false — this
    // advanced replacement is a stationary self-buff instead, so auto must
    // be explicitly re-enabled here or it would silently inherit the dash's
    // auto:false through _activeSkillDef's {...base, ...adv} spread.
    { key:'E', name:'Баф Крит',   icon:'multiShot',   img:'/images/skill/adv/adv_buffcrit.png',    cd:8,  desc:'+5% шанс крита на 20 минут', auto:true },
    { key:'R', name:'Ускорение',  icon:'arrowRain',   img:'/images/skill/adv/adv_buffskratak.png', cd:20, desc:'×2 скорость атаки на 5 сек' },
  ],
  mage: [
    { key:'Q', name:'Урон молнии',  icon:'fireball', img:'/images/skill/adv/adv_uronmolnii.png',  cd:5,  desc:'Снаряд ×3 урона + стан 3 сек' },
    { key:'W', name:'Разряд',       icon:'iceNova',  img:'/images/skill/adv/adv_razryad.png',     cd:10, desc:'АОЕ урон ×3, радиус 220' },
    { key:'E', name:'Вспышка',      icon:'barrier',  img:'/images/skill/adv/adv_vspishka.png',    cd:18, desc:'АОЕ урон ×2, радиус 220 + защита +80% на 3 сек' },
    { key:'R', name:'Перенесение',  icon:'teleport', img:'/images/skill/adv/adv_perenesenie.png', cd:12, desc:'Рывок 180px + восстанавливает 20% здоровья', auto:false },
  ],
  warlock: [
    { key:'Q', name:'Бабочки',        icon:'hpPlus',  img:'/images/skill/adv/adv_babochki.png',      cd:8,  desc:'Призывает бабочек на 10 сек — лечат 5% HP в секунду' },
    { key:'W', name:'Колючие оковы',  icon:'iceNova', img:'/images/skill/adv/adv_koluchieokovi.png', cd:15, desc:'Удерживает цель 3 сек, нанося ×3 урона' },
    { key:'E', name:'Жажда',          icon:'barrier', img:'/images/skill/adv/adv_jajda.png',         cd:18, desc:'+50% защита себе и пати, ×2 скорость атаки, на 4 сек' },
    { key:'R', name:'Исцеление',      icon:'hpPlus',  img:'/images/skill/adv/adv_iscelenie.png',     cd:25, desc:'Лечит 20% HP себе и пати' },
  ],
};

// Bonus category for each skill key per class
// damage → +1% per level  |  buff → +1s duration  |  barrier → +0.2s  |  invis → +0.2s  |  heal → +1%  |  mobility → +10px range
const SKILL_BONUS_TYPE = {
  lev:         { Q: 'damage', W: 'damage', E: 'buff', R: 'damage'   },
  deathknight: { Q: 'buff',   W: 'damage', E: 'buff', R: 'damage'   },
  ranger:      { Q: 'damage', W: 'damage', E: 'buff', R: 'buff'     },
  mage:        { Q: 'damage', W: 'damage', E: 'buff', R: 'mobility' },
  warlock:     { Q: 'heal',   W: 'buff',   E: 'buff', R: 'heal'     },
};

const NPC_DEF = [
  { id:'merchant',   name:'Торговец',   icon:'merchant',   color:'#ffaa00', desc:'Зелья и расходники'          },
  { id:'craftsman',  name:'Кузнец',     icon:'craftsman',  color:'#8888ff', desc:'Крафт предметов'             },
  { id:'storage',    name:'Хранилище', icon:'storage',    color:'#44ff44', desc:'Хранение предметов (200 ячеек)' },
];

// Display fields only. itemId and price come from the shared catalog (which
// the server charges against), so the price on the button is the price taken.
const _MERCHANT_UI = {
  pt1: { name:'Малое зелье',   img:'/images/potion/smallhp.png', desc:'HP +20' },
  pt2: { name:'Большое зелье', img:'/images/potion/bighp.png',   desc:'HP +500' },
};
const MERCHANT_SHOP_UI = MERCHANT_SHOP.map(e => ({ ...e, ..._MERCHANT_UI[e.itemId] }));

// Crafting recipes: uncommon+ = 2× same-type lower tier at +8 + 1 recipe scroll
// GEAR_TIER_CRAFT_RECIPES (uncommon/rare) and GEAR_CRAFT_RECIPES (epic/
// legendary) both now live in shared/definitions.js — the server rolls and
// validates every one of them (craftGear, server/index.js), not just the
// Liberty-priced tiers, so it needs the same single copy of each recipe the
// client shows. Spliced together here purely so the craftsman UI keeps
// listing every tier from one place.
// Enchant stones used to be spliced in here too; they are no longer craftable
// at all (see shared/definitions.js).
const ITEM_CRAFT_RECIPES = [];
if (typeof GEAR_TIER_CRAFT_RECIPES !== 'undefined') ITEM_CRAFT_RECIPES.push(...GEAR_TIER_CRAFT_RECIPES);
if (typeof GEAR_CRAFT_RECIPES !== 'undefined') ITEM_CRAFT_RECIPES.push(...GEAR_CRAFT_RECIPES);
// Уникальное оружие. In the same list so openCraftModal's index-based lookup
// and the whole craft flow work unchanged, but flagged `unique` so the
// craftsman renders them under their own heading instead of mixing them into
// the epic/legendary groups — they are a separate line, not another tier.
if (typeof UNIQUE_CRAFT_RECIPES !== 'undefined') ITEM_CRAFT_RECIPES.push(...UNIQUE_CRAFT_RECIPES);

// CLASS_GEAR_SALVAGE_RECIPES (class cloaks/artifacts) lives in
// shared/definitions.js, not here — it costs Liberty on top of the salvage
// materials, and Liberty is server-authoritative, so the server needs its own
// copy of the recipe to charge against (same reasoning as GEAR_CRAFT_RECIPES
// above).

// MAT_UPGRADE_RECIPES (recipe-scroll tier-up) also moved to shared/
// definitions.js — see the comment there for why.

// Battle Power — reflects the player's overall combat strength.
// Keep in sync with the identical calcBM in server/index.js, which stores this
// for the rating. The level field is `lvl` on both the live player object and
// save blobs; reading `p.level` matched nothing, so the level term silently
// collapsed to its `|| 1` fallback and BM ignored levels entirely.
function calcBM(p) {
  if (!p) return 0;
  const upg = p.upgrades || {};
  const extras = ((upg.critChance || 0) + (upg.critPower || 0) +
    (upg.hpRegen || 0) + (upg.atkSpeed || 0)) * 8;
  return Math.round((p.lvl || p.level || 1) * 50 + (p.atk || 0) * 5 + (p.def || 0) * 3 + (p.maxHp || 100) * 0.5 + extras);
}
