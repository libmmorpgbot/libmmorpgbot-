// ─────────────────────────────────────────────────────────
//  NPC DIALOG SYSTEM
// ─────────────────────────────────────────────────────────
// Which NPC dialog is currently on screen, or null. Only openNpc/closeNpc
// touch it: the handful of places that rewrite #npc-body directly are
// sub-panels of an already-open NPC, so the id stays true through them.
// Read by refreshStorageNpc (below) to tell "the storage panel is open and
// showing stale indices" from "nothing to redraw".
let _openNpcId = null;

function openNpc(npcId) {
  if (!npcId || !player) return;
  const def = NPC_DEF.find(n => n.id === npcId);
  if (!def) return;

  document.getElementById('npc-emoji-lbl').innerHTML = iconHTML(def.icon, 32, def.color);
  document.getElementById('npc-name-lbl').textContent  = def.name;
  document.getElementById('npc-desc-lbl').textContent  = def.desc;
  document.getElementById('npc-body').innerHTML = _buildNpcBody(npcId);
  const ov = document.getElementById('npc-overlay');
  ov.style.display = 'flex';
  _openNpcId = npcId;
}

// Re-renders whatever NPC panel is open, in place. The merchant shows the gold
// and the potion counts, and both now change server-side — buying used to
// re-open the panel itself right after mutating them locally, which stopped
// working the moment the purchase became a request: the reply arrives later, in
// network.js, with nothing to re-render it.
function refreshNpcPanel() {
  if (!_openNpcId || !player) return;
  const body = document.getElementById('npc-body');
  if (body) body.innerHTML = _buildNpcBody(_openNpcId);
}

function closeNpc() {
  document.getElementById('npc-overlay').style.display = 'none';
  // Storage moves are server-side now (storageDeposit/storageWithdraw), each
  // one applied and persisted as it happens — so there is nothing left here
  // that a flush on close would rescue.
  _openNpcId = null;
}

function _buildNpcBody(npcId) {
  if (npcId === 'merchant') return _merchantBody();
  if (npcId === 'craftsman') return _craftsmanBody();
  if (npcId === 'storage') return _storageBody();
  return '';
}

// ── Merchant ────────────────────────────────────────────
function _potImg(entry, size) {
  if (entry.img) return `<img src="${entry.img}" width="${size}" height="${size}" style="image-rendering:pixelated;vertical-align:middle;border-radius:2px;">`;
  return iconHTML(entry.icon || 'potion', size, '#90d653');
}

// How many potions one tap buys, shared by every row. 'max' is not a number
// but "as many as gold and the 999 cap allow", resolved per row when the shop
// is rendered — the two potions have different prices, so it can't be a single
// figure held here.
// POTION_CAP now lives in shared/definitions.js — the server enforces it in
// buyPotion, and a second `const` here is a duplicate declaration in the
// concatenated bundle, which is a SyntaxError that takes the client down.
const _POTION_QTY_PRESETS = [1, 10, 50, 100];
let _potionQty = 1;

function setPotionQty(q) {
  _potionQty = q;
  openNpc('merchant');
}

// Resolves the shared quantity against one shop row: how many the player has
// room for, and how many of those they can actually pay for.
function _potionBuyPlan(entry) {
  const cur  = (player.potionBag || {})[entry.itemId] || 0;
  const room = Math.max(0, POTION_CAP - cur);
  const afford = entry.price > 0 ? Math.floor((player.gold || 0) / entry.price) : room;
  const want = _potionQty === 'max' ? Math.min(room, afford) : _potionQty;
  return { cur, want, cost: entry.price * want, canBuy: want > 0 && want <= room && want <= afford };
}

function _merchantBody() {
  const p = player;
  const bag = p.potionBag || {};
  const total = (bag.pt1 || 0) + (bag.pt2 || 0);
  let html = `<div class="shop-gold">${iconHTML('coin',16,'#e3941d')} ${typeof t === 'function' ? t('npcGoldLbl') : 'Золото'}: <b>${Math.floor(p.gold)}</b> · ${typeof t === 'function' ? t('npcHpPotionsLbl') : 'Зелий HP'}: <b>${total}/${POTION_CAP}</b></div>`;

  // Quantity picker — applies to every row below it.
  html += '<div class="shop-sec">' + (typeof t === 'function' ? t('npcQtyHdr') : 'Сколько покупать') + '</div>';
  html += '<div class="shop-qty">' + _POTION_QTY_PRESETS.map(q =>
    `<button class="shop-qty-btn${_potionQty === q ? ' on' : ''}" onclick="setPotionQty(${q})">×${q}</button>`
  ).join('') +
    `<button class="shop-qty-btn${_potionQty === 'max' ? ' on' : ''}" onclick="setPotionQty('max')">${typeof t === 'function' ? t('npcQtyMax') : 'Макс'}</button>` +
  '</div>';

  // HP potions
  html += '<div class="shop-sec">' + (typeof t === 'function' ? t('npcHealPotionsHdr') : 'Зелья лечения') + '</div><div class="shop-list">';
  MERCHANT_SHOP_UI.filter(e => {
    const def = ITEM_DEF.find(d => d.id === e.itemId);
    return def && def.slot === 'use';
  }).forEach((entry) => {
    const idx = MERCHANT_SHOP_UI.indexOf(entry);
    const { cur, want, cost, canBuy } = _potionBuyPlan(entry);
    // Falls back to the price of one when nothing can be bought, so a
    // disabled button still says what the potion costs instead of "0".
    const btnQty  = canBuy ? want : (_potionQty === 'max' ? 1 : _potionQty);
    const btnCost = canBuy ? cost : entry.price * btnQty;
    html += `<div class="shop-row">
      <span class="shop-item-icon">${_potImg(entry, 22)}</span>
      <div class="shop-item-info">
        <span class="shop-item-name">${entry.name}</span>
        <span class="shop-item-stat">${entry.desc} · <b style="color:#90d653">×${cur}</b></span>
      </div>
      <button class="shop-btn${canBuy ? '' : ' disabled'}" onclick="buyPotion(${idx},${want})">
        ${btnQty > 1 ? `<span class="shop-btn-qty">×${btnQty}</span> ` : ''}${btnCost}${iconHTML('coin',14,'#e3941d')}
      </button>
    </div>`;
  });
  html += '</div>';

  // Teleport stones — the one merchant row NOT priced in gold. Liberty is
  // server-authoritative (see buyTeleportStone, server/index.js), so unlike
  // every row above, the button only ever asks; the actual stone and the new
  // balance come back through 'teleportStoneBought' (js/network.js).
  const tsMat = typeof CRAFT_MATS !== 'undefined' ? CRAFT_MATS.find(m => m.id === 'teleport_stone') : null;
  if (tsMat) {
    const tsHave = typeof countMaterial === 'function' ? countMaterial('teleport_stone') : 0;
    const tsAfford = TELEPORT_STONE_PRICE > 0 ? Math.floor((window._nexumBalance || 0) / TELEPORT_STONE_PRICE) : 0;
    const tsWant = _potionQty === 'max' ? tsAfford : _potionQty;
    const tsCost = TELEPORT_STONE_PRICE * tsWant;
    const tsCanBuy = tsWant > 0 && tsAfford >= tsWant;
    html += `<div class="shop-sec">${typeof t === 'function' ? t('teleportStoneMerchantHdr') : 'Камни телепортации'}
      &nbsp;·&nbsp; ${typeof _nexumIconHtml === 'function' ? _nexumIconHtml(14) : ''} Liberty: <b>${window._nexumBalance || 0}</b></div><div class="shop-list">`;
    html += `<div class="shop-row">
      <span class="shop-item-icon">${_matIcon(tsMat, 22)}</span>
      <div class="shop-item-info">
        <span class="shop-item-name">${tsMat.name}</span>
        <span class="shop-item-stat">${typeof t === 'function' ? t('teleportStoneMerchantSub') : 'Телепорт в центральный зал (каст 7 сек)'} · <b style="color:#7fd7ff">×${tsHave}</b></span>
      </div>
      <button class="shop-btn${tsCanBuy ? '' : ' disabled'}" onclick="buyTeleportStone(${tsWant})">
        ${tsWant > 1 ? `<span class="shop-btn-qty">×${tsWant}</span> ` : ''}${tsCost} Liberty
      </button>
    </div>`;
    html += '</div>';
  }
  return html;
}

// A request now. The server holds the gold and the potion bag, charges the
// price from the shared catalog and answers with goldSync + potionBag — see
// the buyPotion handler in server/index.js. Deducting here and letting the
// save carry it is what made the price and the balance client-authored.
function buyPotion(idx, qty) {
  const entry = MERCHANT_SHOP_UI[idx];
  if (!entry || !player) return;
  const n = Math.max(1, Math.floor(qty) || 1);
  // Local pre-checks are courtesy so an obviously impossible tap never leaves
  // the device; both are enforced again server-side.
  const cur = (player.potionBag || {})[entry.itemId] || 0;
  if (cur + n > POTION_CAP) { _shopMsg(typeof t === 'function' ? t('npcMaxPotions') : 'Максимум 999 зелий!'); return; }
  if (player.gold < entry.price * n) { _shopMsg(typeof t === 'function' ? t('npcNotEnoughGold') : 'Мало золота!'); return; }
  netBuyPotion(idx, n);
}

// Liberty-priced, unlike buyPotion above — the charge and the grant both
// happen server-side (buyTeleportStone, server/index.js), so this is only a
// courtesy pre-check before asking; the real inventory/balance come back via
// 'teleportStoneBought' (onTeleportStoneBought, js/ui.js).
function buyTeleportStone(qty) {
  if (!player) return;
  const n = Math.max(1, Math.floor(qty) || 1);
  const cost = TELEPORT_STONE_PRICE * n;
  if ((window._nexumBalance || 0) < cost) { _shopMsg(typeof t === 'function' ? t('npcNotEnoughLiberty') : 'Мало Liberty!'); return; }
  netBuyTeleportStone(n);
}

// ── Craftsman ───────────────────────────────────────────
let _craftsmanTab = 'items'; // 'items' | 'mats'

function _matIcon(mat, size) {
  if (!mat) return '?';
  if (mat.img) {
    return `<img src="${mat.img}" width="${size}" height="${size}" style="image-rendering:pixelated;vertical-align:middle;border-radius:2px;">`;
  }
  return iconHTML(mat.icon || '', size);
}

function _listMats() {
  const parts = [];
  CRAFT_MATS.forEach(m => {
    const n = countMaterial(m.id);
    if (n > 0) parts.push(_matIcon(m, 14) + '<span style="font-size:10px">×' + n + '</span>');
  });
  return parts.join(' ') || (typeof t === 'function' ? t('npcNone') : 'нет');
}

function _matAvailable(m) {
  if (m.minEnhance != null) return countEnhancedItem(m.id, m.minEnhance) >= m.n;
  return countMaterial(m.id) >= m.n;
}

function _setCraftsmanTab(tab) {
  _craftsmanTab = tab;
  document.getElementById('npc-body').innerHTML = _buildNpcBody('craftsman');
}

function _craftsmanBody() {
  const p = player;
  const tabs = `<div class="craft-tabs">
    <button class="craft-tab${_craftsmanTab==='items'?' active':''}" onclick="_setCraftsmanTab('items')">${typeof t === 'function' ? t('craftTabItems') : 'Предметы'}</button>
    <button class="craft-tab${_craftsmanTab==='mats'?' active':''}" onclick="_setCraftsmanTab('mats')">${typeof t === 'function' ? t('craftTabMats') : 'Материалы'}</button>
  </div>`;

  let html = `<div class="shop-gold">${iconHTML('coin',16,'#e3941d')} ${typeof t === 'function' ? t('npcGoldLbl') : 'Золото'}: <b>${Math.floor(p.gold)}</b>
    &nbsp;·&nbsp; ${_nexumIconHtml(16)} Liberty: <b>${window._nexumBalance || 0}</b></div>`;
  html += tabs;
  html += _craftsmanTab === 'items' ? _craftsmanItemsTab() : _craftsmanMatsTab();
  return html;
}

function _craftsmanItemsTab() {
  const RARITIES = [
    { key:'uncommon',  label: typeof t === 'function' ? t('rarityGroupUncommon') : 'Необычные' },
    { key:'rare',      label: typeof t === 'function' ? t('rarityGroupRare') : 'Редкие' },
    { key:'epic',      label: typeof t === 'function' ? t('rarityGroupEpic') : 'Эпические' },
    { key:'legendary', label: typeof t === 'function' ? t('rarityGroupLegendary') : 'Легендарные' },
  ];

  let html = '<div class="craft-mats-info">' + (typeof t === 'function' ? t('craftRecipesPrefix') : 'Рецепты: ') + _listMats() + '</div>';

  RARITIES.forEach(r => {
    const entries = ITEM_CRAFT_RECIPES
      .map((rec, idx) => ({ rec, idx, item: rec.itemId ? ITEM_DEF.find(i => i.id === rec.itemId) : null }))
      // Unique weapons are epic/legendary too, but they get their own group
      // below rather than sitting among the ordinary tiers of that rarity.
      .filter(({ rec, item }) => item && item.rarity === r.key && !rec.unique);
    if (!entries.length) return;

    const rc = RARITY_COLOR[r.key] || '#aea599';
    html += `<div class="craft-group-hdr" style="color:${rc}">${r.label}</div><div class="craft-items-grid">`;
    entries.forEach(({ rec, idx, item }) => {
      const canCraft = invHasSpace() &&
        rec.mats.every(m => _matAvailable(m)) &&
        (window._nexumBalance || 0) >= (rec.nexumCost || 0) &&
        player.gold >= (rec.goldCost || 0);
      const enhance = _craftResultEnhance(rec);
      const enhBadge = enhance ? `<span style="position:absolute;top:1px;right:3px;font-size:8px;color:#e69419;font-weight:bold">+${enhance}</span>` : '';
      html += `<div class="craft-item-cell${canCraft ? ' craftable' : ''}" onclick="openCraftModal(${idx})" style="border-color:${rc}66;position:relative">
        ${enhBadge}
        <div class="craft-item-cell-icon">${_itemIcon(item, 32)}</div>
        <div class="craft-item-cell-name" style="color:${rc}">${item.name}</div>
      </div>`;
    });
    html += '</div>';
  });

  html += _uniqueCraftGroupHTML();

  return html;
}

// Уникальное оружие — its own group at the bottom of the Предметы tab.
// Filtered to the player's own class: each weapon is single-class, so showing
// all ten would be eight cells nobody can ever equip. The shard requirement is
// the same for every class anyway, so nothing is hidden by narrowing it.
function _uniqueCraftGroupHTML() {
  if (typeof UNIQUE_CRAFT_RECIPES === 'undefined' || !player) return '';
  const entries = ITEM_CRAFT_RECIPES
    .map((rec, idx) => ({ rec, idx, item: rec.itemId ? ITEM_DEF.find(i => i.id === rec.itemId) : null }))
    .filter(({ rec, item }) => rec.unique && item &&
      (!item.forClass || item.forClass.includes(player.type)));
  if (!entries.length) return '';

  let html = `<div class="craft-group-hdr" style="color:#d9b3ff">${typeof t === 'function' ? t('craftUniqueHdr') : 'Уникальное оружие'}</div>`;
  const _lv = typeof UNIQUE_SHARD_MIN_LEVEL !== 'undefined' ? UNIQUE_SHARD_MIN_LEVEL : 15;
  html += `<div class="craft-mats-info">${typeof tVars === 'function' ? tVars('craftUniqueNote', { lv: _lv }) : ''}</div>`;
  html += '<div class="craft-items-grid">';
  entries.forEach(({ rec, idx, item }) => {
    const rc = RARITY_COLOR[item.rarity] || '#aea599';
    const canCraft = invHasSpace() && rec.mats.every(m => _matAvailable(m));
    html += `<div class="craft-item-cell${canCraft ? ' craftable' : ''}" onclick="openCraftModal(${idx})" style="border-color:${rc}66;position:relative">
      <div class="craft-item-cell-icon">${_itemIcon(item, 32)}</div>
      <div class="craft-item-cell-name" style="color:${rc}">${item.name}</div>
    </div>`;
  });
  html += '</div>';
  return html;
}

// Crafting consumes 2 items enhanced to the recipe's minEnhance (e.g. +8) —
// the result comes out pre-enhanced 2 levels below that (+6), instead of
// starting back at +0. Shared by the preview (openCraftModal) and the
// actual craft (craftSpecificItem) so they always agree.
// The rule itself lives in shared/definitions.js, which is in this bundle —
// having it written out here as well is how the server's copy could be dropped
// in the rewrite without anything noticing that the two ends now disagreed.
function _craftResultEnhance(rec) {
  return craftResultEnhance(rec);
}
function _itemWithEnhance(item, enhance) {
  if (!enhance) return item;
  const b = enhanceBonus(item, enhance);
  return { ...item, atk: (item.atk || 0) + (b.atk || 0), def: (item.def || 0) + (b.def || 0), hp: (item.hp || 0) + (b.hp || 0) };
}

function openCraftModal(idx) {
  const rec = ITEM_CRAFT_RECIPES[idx];
  if (!rec || !player) return;
  const item = rec.itemId ? ITEM_DEF.find(i => i.id === rec.itemId) : null;
  const mat  = rec.matId  ? CRAFT_MATS.find(m => m.id === rec.matId)  : null;
  const resultDef = item || mat;
  if (!resultDef) return;
  const rc = RARITY_COLOR[resultDef.rarity] || '#aea599';
  const resultEnhance = item ? _craftResultEnhance(rec) : 0;

  const matsHtml = rec.mats.map(m => {
    if (m.minEnhance != null) {
      const iDef = ITEM_DEF.find(i => i.id === m.id);
      const have = countEnhancedItem(m.id, m.minEnhance);
      const ok = have >= m.n;
      const rc2 = iDef ? (RARITY_COLOR[iDef.rarity] || '#aea599') : '#aea599';
      return `<div class="craft-req-row">
        <span class="craft-req-icon">${iDef ? _itemIcon(iDef, 20) : m.id}</span>
        <span class="craft-req-name" style="color:${rc2}">${iDef ? iDef.name : m.id} <b style="color:#e69419">+${m.minEnhance}</b></span>
        <span class="craft-req-count" style="color:${ok ? '#98e456' : '#eb4e61'}">${have}/${m.n}</span>
      </div>`;
    }
    const matDef = CRAFT_MATS.find(c => c.id === m.id);
    const have = countMaterial(m.id);
    const ok = have >= m.n;
    return `<div class="craft-req-row">
      <span class="craft-req-icon">${matDef ? _matIcon(matDef, 20) : m.id}</span>
      <span class="craft-req-name">${matDef ? matDef.name : m.id}</span>
      <span class="craft-req-count" style="color:${ok ? '#98e456' : '#eb4e61'}">${have}/${m.n}</span>
    </div>`;
  }).join('');

  const _nx = window._nexumBalance || 0;
  const costRow = rec.nexumCost ? `<div class="craft-req-row">
    <span class="craft-req-icon">${_nexumIconHtml(20)}</span>
    <span class="craft-req-name">Liberty</span>
    <span class="craft-req-count" style="color:${_nx >= rec.nexumCost ? '#98e456' : '#eb4e61'}">${_nx}/${rec.nexumCost}</span>
  </div>` : rec.goldCost ? `<div class="craft-req-row">
    <span class="craft-req-icon">${iconHTML('coin', 20, '#e3941d')}</span>
    <span class="craft-req-name">${typeof t === 'function' ? t('npcGoldLbl') : 'Золото'}</span>
    <span class="craft-req-count" style="color:${player.gold >= rec.goldCost ? '#98e456' : '#eb4e61'}">${Math.floor(player.gold)}/${rec.goldCost}</span>
  </div>` : '';

  const canCraft = invHasSpace() &&
    rec.mats.every(m => _matAvailable(m)) &&
    player.gold >= (rec.goldCost || 0) &&
    _nx >= (rec.nexumCost || 0);

  const resultIconHtml = item ? _itemIcon(item, 52) : _matIcon(mat, 52);
  const statsHtml = item ? (statStr(_itemWithEnhance(item, resultEnhance)) || '—') : '';
  const enhBadge = resultEnhance ? ` <b style="color:#e69419">+${resultEnhance}</b>` : '';

  const _backTab = rec.matId ? 'mats' : 'items';
  document.getElementById('npc-body').innerHTML = `
    <button class="craft-back-btn" onclick="_setCraftsmanTab('${_backTab}')">${typeof t === 'function' ? t('craftBackBtn') : '← Назад'}</button>
    <div class="craft-detail-header">
      <div class="craft-detail-icon">${resultIconHtml}</div>
      <div class="craft-detail-info">
        <div class="craft-detail-name" style="color:${rc};text-shadow:0 0 8px ${rc}66">${resultDef.name}${enhBadge}</div>
        ${statsHtml ? `<div class="craft-detail-stats">${statsHtml}</div>` : ''}
      </div>
    </div>
    <div class="craft-reqs-title">${typeof t === 'function' ? t('craftRequiredLbl') : 'Требуется:'}</div>
    <div class="craft-reqs-list">${matsHtml}${costRow}</div>
    <div class="craft-chance-row">${typeof t === 'function' ? t('craftChanceLbl') : 'Шанс успеха: '}<b style="color:#ebab4b">${Math.round(rec.chance * 100)}%</b></div>
    <button class="shop-btn craft-do-btn${canCraft ? '' : ' disabled'}" onclick="craftSpecificItem(${idx})">${typeof t === 'function' ? t('craftDoBtn') : 'Крафтить'}</button>
  `;
}

// Every item/mat recipe — Liberty-priced or not — is now settled entirely by
// the server (craftGear/craftStone, server/index.js): it owns the material
// (and Liberty, where the recipe has one) spend and the roll. This used to
// branch on rec.nexumCost and, for the gold/mats-only tiers, roll and grant
// the result right here — reaching the server only via the next saveProgress
// blob, which trusts any valid item id+enhance outright. The checks below
// still run first so an obviously-impossible craft is refused without a
// round trip; the actual craft always goes through the network now.
function craftSpecificItem(idx) {
  const rec = ITEM_CRAFT_RECIPES[idx];
  if (!rec || !player) return;

  for (const m of rec.mats) {
    if (!_matAvailable(m)) { _shopMsg(typeof t === 'function' ? t('craftNotEnoughMats') : 'Недостаточно материалов!'); return; }
  }
  if ((rec.goldCost || 0) > 0 && player.gold < rec.goldCost) {
    _shopMsg(typeof t === 'function' ? t('npcNotEnoughGold') : 'Мало золота!'); return;
  }
  if ((rec.nexumCost || 0) > 0 && (window._nexumBalance || 0) < rec.nexumCost) {
    _shopMsg(tVars('craftNeedLiberty', { n: rec.nexumCost })); return;
  }
  if (!invHasSpace()) { _shopMsg(typeof t === 'function' ? t('invFull') : 'Инвентарь полон!'); return; }

  if (rec.itemId) {
    _pendingGearCraftIdx = idx;
    if (typeof netCraftGear === 'function') netCraftGear(rec.itemId);
  } else if (rec.matId) {
    _pendingStoneCraftIdx = idx;
    if (typeof netCraftStone === 'function') netCraftStone(rec.matId);
  }
}

function _craftsmanMatsTab() {
  let html = '<div class="craft-group-hdr">' + (typeof t === 'function' ? t('craftRecipesHdr') : 'Рецепты') + '</div><div class="craft-items-grid">';
  MAT_UPGRADE_RECIPES.forEach((recipe, idx) => {
    const fromMat = CRAFT_MATS.find(m => m.id === recipe.from);
    const toMat   = CRAFT_MATS.find(m => m.id === recipe.to);
    if (!fromMat || !toMat) return;
    const have = countMaterial(recipe.from);
    const canCraft = have >= recipe.count && invHasSpace();
    const rc = RARITY_COLOR[toMat.rarity] || '#aea599';
    html += `<div class="craft-item-cell${canCraft ? ' craftable' : ''}" onclick="openMatModal(${idx})" style="border-color:${rc}66">
      <div class="craft-item-cell-icon">${_matIcon(toMat, 32)}</div>
      <div class="craft-item-cell-name" style="color:${rc}">${toMat.name}</div>
    </div>`;
  });
  html += '</div>';

  // Advanced ("2 профессия") skill books — recycle 5 regular skill books
  // (any class/skill mixed) into one random advanced book. Single fixed
  // recipe (ADV_SKILL_BOOK_CRAFT, shared/definitions.js), so no index to
  // thread through like MAT_UPGRADE_RECIPES above.
  if (typeof ADV_SKILL_BOOK_CRAFT !== 'undefined' && CRAFT_MATS.some(m => m.advSkillKey)) {
    const haveBooks = countSkillBooks();
    const canCraftBook = haveBooks >= ADV_SKILL_BOOK_CRAFT.count && invHasSpace();
    html += `<div class="craft-group-hdr" style="color:#f5c542">${typeof t === 'function' ? t('craftAdvBooksHdr') : 'Книги 2 профессии'}</div><div class="craft-items-grid">
      <div class="craft-item-cell${canCraftBook ? ' craftable' : ''}" onclick="openAdvBookCraftModal()" style="border-color:#f5c54266">
        <div class="craft-item-cell-icon">${iconHTML('book', 32, '#f5c542')}</div>
        <div class="craft-item-cell-name" style="color:#f5c542">${typeof t === 'function' ? t('craftAdvBookRandom') : 'Случайная книга'}</div>
      </div>
    </div>`;
  }

  // Камни заточки stood here. They are no longer craftable anywhere — the
  // recipes are gone from shared/definitions.js and the server refuses the
  // craft. Stones still drop from monsters, come with VIP levels and are sold
  // in the season packs.

  if (typeof BOX_DEF !== 'undefined' && BOX_DEF.length) {
    html += `<div class="craft-group-hdr" style="color:#e5a546">${typeof t === 'function' ? t('craftBoxesHdr') : 'Боксы'}</div><div class="craft-items-grid">`;
    BOX_DEF.forEach(box => {
      const have = countMaterial(box.keyId);
      const canCraft = have >= box.keyCost && invHasSpace();
      const rc = RARITY_COLOR[box.rarity] || '#aea599';
      html += `<div class="craft-item-cell${canCraft ? ' craftable' : ''}" onclick="openBoxCraftModal('${box.id}')" style="border-color:${rc}66">
        <div class="craft-item-cell-icon">${_itemIcon(box, 32)}</div>
        <div class="craft-item-cell-name" style="color:${rc}">${box.name}</div>
      </div>`;
    });
    html += '</div>';
  }

  if (typeof PET_CRAFT_RECIPES !== 'undefined' && PET_CRAFT_RECIPES.length) {
    const nexumBal = window._nexumBalance || 0;
    html += `<div class="craft-group-hdr" style="color:#89ba5f">${typeof t === 'function' ? t('craftPetsHdr') : 'Питомцы'}</div><div class="craft-items-grid">`;
    PET_CRAFT_RECIPES.forEach((rec, idx) => {
      const pets = _petsOfRarity(rec.rarity);
      if (!pets.length) return;
      const rc = RARITY_COLOR[rec.rarity] || '#aea599';
      const canCraft = invHasSpace() && nexumBal >= (rec.nexumCost || 0);
      html += `<div class="craft-item-cell${canCraft ? ' craftable' : ''}" onclick="openPetCraftModal(${idx})" style="border-color:${rc}66">
        <div class="craft-item-cell-icon">${_itemIcon(pets[0], 32)}</div>
        <div class="craft-item-cell-name" style="color:${rc}">${_RARITY_NAMES[rec.rarity] || rec.rarity}</div>
      </div>`;
    });
    html += '</div>';
  }

  if (typeof CLASS_GEAR_SALVAGE_RECIPES !== 'undefined' && CLASS_GEAR_SALVAGE_RECIPES.length) {
    const nexumBal = window._nexumBalance || 0;
    html += `<div class="craft-group-hdr" style="color:#c98a4b">${typeof t === 'function' ? t('craftClassGearHdr') : 'Плащи и артефакты классов'}</div><div class="craft-items-grid">`;
    CLASS_GEAR_SALVAGE_RECIPES.forEach((rec, idx) => {
      const pool = _classGearOfRarity(rec.resultSlot, rec.resultRarity);
      if (!pool.length) return;
      const rc = RARITY_COLOR[rec.resultRarity] || '#aea599';
      const canCraft = _salvageMatCount(rec.costRarity) >= rec.costCount && nexumBal >= (rec.nexumCost || 0);
      const label = (rec.resultSlot === 'cloak' ? (_SLOT_NAMES.cloak || 'Плащ') : (_SLOT_NAMES.artifact || 'Артефакт'))
        + ' · ' + (_RARITY_NAMES[rec.resultRarity] || rec.resultRarity);
      html += `<div class="craft-item-cell${canCraft ? ' craftable' : ''}" onclick="openClassGearCraftModal(${idx})" style="border-color:${rc}66">
        <div class="craft-item-cell-icon">${_itemIcon(pool[0], 32)}</div>
        <div class="craft-item-cell-name" style="color:${rc}">${label}</div>
      </div>`;
    });
    html += '</div>';
  }

  return html;
}

// ── Class cloak/artifact salvage-crafting. Priced in salvage material (junk
// gear of the target rarity) plus Liberty (CLASS_GEAR_SALVAGE_RECIPES,
// shared/definitions.js) — Liberty is server-authoritative like pet/gear
// crafting above, so this is a real round-trip: craftClassGear just asks,
// the item + new balance only ever come back via onClassGearCrafted/
// onClassGearCraftError (netCraftClassGear/'classGearCrafted' in
// js/network.js).
function _classGearOfRarity(slot, rarity) {
  return ITEM_DEF.filter(d => d.classItem && d.slot === slot && d.rarity === rarity);
}
function _salvageMatCount(rarity) {
  return player.inventory.filter(it => !_isStackable(it) && it.rarity === rarity).length;
}

let _pendingClassGearCraftIdx = null; // recipe idx awaiting a server response

function openClassGearCraftModal(idx) {
  const rec = CLASS_GEAR_SALVAGE_RECIPES[idx];
  if (!rec || !player) return;
  const pool = _classGearOfRarity(rec.resultSlot, rec.resultRarity);
  if (!pool.length) return;
  const rc = RARITY_COLOR[rec.resultRarity] || '#aea599';
  const have = _salvageMatCount(rec.costRarity);
  const okMats = have >= rec.costCount;
  const nexumBal = window._nexumBalance || 0;
  const okNexum = nexumBal >= (rec.nexumCost || 0);
  const pending = _pendingClassGearCraftIdx === idx;

  const candidatesHtml = pool.map(p => `
    <div class="pet-pick" onclick="openPetStatsModal('${p.id}')">
      <div>${_itemIcon(p, 44)}</div>
      <div style="font-size:11px;color:${rc};margin-top:2px">${p.name}</div>
    </div>`).join('');

  const previewHtml = `<div class="pet-preview-hint">${typeof t === 'function' ? t('craftPetTapHint') : 'Нажмите на предмет — характеристики'}</div>`;

  const matLabel = rec.costRarity === 'uncommon'
    ? (typeof t === 'function' ? t('craftUncommonItemLbl') : 'Необычный предмет')
    : (typeof t === 'function' ? t('craftCommonItemLbl') : 'Обычный предмет');
  const costRow = `<div class="craft-req-row">
    <span class="craft-req-icon">${iconHTML('inventory', 20, rc)}</span>
    <span class="craft-req-name">${matLabel}</span>
    <span class="craft-req-count" style="color:${okMats ? '#98e456' : '#eb4e61'}">${have}/${rec.costCount}</span>
  </div>
  <div class="craft-req-row">
    <span class="craft-req-icon">${_nexumIconHtml(20)}</span>
    <span class="craft-req-name">Liberty</span>
    <span class="craft-req-count" style="color:${okNexum ? '#98e456' : '#eb4e61'}">${nexumBal}/${rec.nexumCost}</span>
  </div>`;

  const canCraft = !pending && okMats && okNexum;
  const pickOneOfN = typeof tVars === 'function' ? tVars('craftPickOneOfN', { n: pool.length }) : `Один случайный из ${pool.length}`;

  document.getElementById('npc-body').innerHTML = `
    <button class="craft-back-btn" onclick="_setCraftsmanTab('mats')">${typeof t === 'function' ? t('craftBackBtn') : '← Назад'}</button>
    <div class="craft-detail-header">
      <div class="craft-detail-info">
        <div class="craft-detail-name" style="color:${rc};text-shadow:0 0 8px ${rc}66">${(rec.resultSlot === 'cloak' ? (_SLOT_NAMES.cloak || 'Плащ') : (_SLOT_NAMES.artifact || 'Артефакт'))} · ${_RARITY_NAMES[rec.resultRarity] || rec.resultRarity}</div>
        <div class="craft-detail-stats">${pickOneOfN}</div>
      </div>
    </div>
    <div style="display:flex;gap:6px;margin:8px 0;flex-wrap:wrap">${candidatesHtml}</div>
    ${previewHtml}
    <div class="craft-reqs-title">${typeof t === 'function' ? t('craftRequiredLbl') : 'Требуется:'}</div>
    <div class="craft-reqs-list">${costRow}</div>
    <button class="shop-btn craft-do-btn${canCraft ? '' : ' disabled'}" onclick="craftClassGear(${idx})">${pending ? (typeof t === 'function' ? t('listingBusyLbl') : '...') : (typeof t === 'function' ? t('craftDoBtn') : 'Крафтить')}</button>
  `;
}

function craftClassGear(idx) {
  const rec = CLASS_GEAR_SALVAGE_RECIPES[idx];
  if (!rec || !player || _pendingClassGearCraftIdx !== null) return;
  if (!netIsLive()) { _shopMsg(typeof t === 'function' ? t('noServerConn') : 'Нет соединения с сервером'); return; }
  if (_salvageMatCount(rec.costRarity) < rec.costCount) { _shopMsg('Недостаточно предметов!'); return; }
  if ((window._nexumBalance || 0) < (rec.nexumCost || 0)) { _shopMsg('Недостаточно Liberty!'); return; }

  _pendingClassGearCraftIdx = idx;
  openClassGearCraftModal(idx); // re-render with the button disabled/busy
  netCraftClassGear(rec.resultSlot, rec.resultRarity);
}

function onClassGearCrafted(item, delivered) {
  const idx = _pendingClassGearCraftIdx;
  _pendingClassGearCraftIdx = null;
  if (item) {
    // The server owns the grant: it added the item (and removed the salvage
    // mats) and its inventorySync landed before this event. delivered:false
    // means it could NOT hand it over — there was no room — so the honest
    // thing is to say so. Adding it here instead, as this used to, both
    // duplicated it when the server HAD delivered and forged one when it
    // hadn't; the save path now rejects the latter outright.
    if (delivered) {
      _shopMsg((typeof t === 'function' ? t('craftCreatedPrefix') : '✓ Создано: ') + item.name);
    } else {
      _shopMsg(typeof t === 'function' ? t('invFull') : 'Инвентарь полон!');
    }
    if (typeof updateInvUI === 'function') updateInvUI();
  } else {
    _shopMsg(typeof t === 'function' ? t('craftFailMsg') : 'Провал! Материалы потеряны.');
  }
  if (idx !== null) openClassGearCraftModal(idx);
}

function onClassGearCraftError(msg) {
  const idx = _pendingClassGearCraftIdx;
  _pendingClassGearCraftIdx = null;
  _shopMsg(msg || (typeof t === 'function' ? t('genericErrorLbl') : 'Ошибка'));
  if (idx !== null) openClassGearCraftModal(idx);
}

// ── Pet crafting (Liberty/Nexum-only; result is random among that rarity's
// 3 skins — see PET_CRAFT_RECIPES/ITEM_DEF slot:'pet' in
// shared/definitions.js). Nexum is server-authoritative (unlike gold, which
// every other craft here spends client-side), so this is the one craft flow
// that's a real round-trip: craftPet() just asks the server and waits, the
// item + new balance only ever come from onPetCrafted/onPetCraftError below
// (see netCraftPet/'petCrafted'/'petCraftError' in js/network.js).
function _petsOfRarity(rarity) {
  return ITEM_DEF.filter(d => d.slot === 'pet' && d.rarity === rarity);
}
function _nexumIconHtml(size) {
  return `<img src="/images/nexum-coin_v2.png" width="${size}" height="${size}" style="vertical-align:middle;border-radius:50%">`;
}

let _pendingPetCraftIdx = null; // recipe idx awaiting a server response
// Same idea for the Liberty-priced enchant stones: which craft modal to
// re-render once the server answers (see craftSpecificItem above).
let _pendingStoneCraftIdx = null;

// The server took the materials and added the stone itself, and its
// inventorySync has already landed — so there's nothing to add here, only the
// panel to refresh with the new balance and material counts.
function onStoneCrafted(matId) {
  const idx = _pendingStoneCraftIdx;
  _pendingStoneCraftIdx = null;
  const mat = CRAFT_MATS.find(m => m.id === matId);
  if (typeof updateInvUI === 'function') updateInvUI();
  _shopMsg((typeof t === 'function' ? t('craftCreatedPrefix') : '✓ Создано: ') + (mat ? mat.name : matId));
  if (idx !== null) openCraftModal(idx);
}

function onStoneCraftError(msg) {
  const idx = _pendingStoneCraftIdx;
  _pendingStoneCraftIdx = null;
  _shopMsg(msg || 'Ошибка');
  if (idx !== null) openCraftModal(idx);
}

// Same idea for the Liberty-priced epic/legendary gear tiers, which the
// server settles too — but unlike a stone (chance:1.0) this can genuinely
// fail, so the message branches on `success`.
let _pendingGearCraftIdx = null;
function onGearCrafted(itemId, success) {
  const idx = _pendingGearCraftIdx;
  _pendingGearCraftIdx = null;
  const item = ITEM_DEF.find(i => i.id === itemId);
  if (typeof updateInvUI === 'function') updateInvUI();
  _shopMsg(success
    ? (typeof t === 'function' ? t('craftCreatedPrefix') : '✓ Создано: ') + (item ? item.name : itemId)
    : (typeof t === 'function' ? t('craftFailMsg') : 'Провал! Материалы потеряны.'));
  if (idx !== null) openCraftModal(idx);
}
function onGearCraftError(msg) {
  const idx = _pendingGearCraftIdx;
  _pendingGearCraftIdx = null;
  _shopMsg(msg || 'Ошибка');
  if (idx !== null) openCraftModal(idx);
}

// Read-only twin of the inventory item modal (openInvItemModal, js/ui.js) —
// same imod-* shell so a pet looks the same here as it does once owned. The
// three candidates of a rarity share hp/atk/def and differ only in a fourth
// stat, so being able to read that before paying for the roll is the point.
// No enhance block and no buttons: this pet isn't owned yet.
function openPetStatsModal(petId) {
  const p = ITEM_DEF.find(i => i.id === petId);
  if (!p) return;
  const rc = RARITY_COLOR[p.rarity] || '#aea599';

  const statRows = [];
  if (p.atk) statRows.push(`ATK <b>+${p.atk}</b>`);
  if (p.def) statRows.push(`DEF <b>+${p.def}</b>`);
  if (p.hp)  statRows.push(`HP <b>+${p.hp}</b>`);
  if (p.critChance) statRows.push(`${t('statCritInline')} <b>${(p.critChance * 100).toFixed(0)}%</b>`);
  if (p.atkSpeed)   statRows.push(`${t('statSpeedInline')} <b>${(p.atkSpeed * 100).toFixed(0)}%</b>`);
  if (p.hpPct)      statRows.push(`HP% <b>+${(p.hpPct * 100).toFixed(0)}%</b>`);

  closePetStatsModal();
  const ov = document.createElement('div');
  ov.id = 'pet-stats-modal-ov';
  ov.className = 'imod-overlay';
  ov.onclick = closePetStatsModal;
  ov.innerHTML = `<div class="imod-box" onclick="event.stopPropagation()" style="max-width:340px">
    <div class="imod-hdr">
      <span class="imod-big-icon">${_itemIcon(p, 52)}</span>
      <div class="imod-title-block">
        <div class="imod-name" style="color:${rc}">${p.name}</div>
        <div class="imod-sub"><span style="color:${rc}">${_RARITY_NAMES[p.rarity] || p.rarity}</span> · ${_SLOT_NAMES[p.slot] || p.slot}</div>
      </div>
      <button class="npc-close" onclick="closePetStatsModal()" style="touch-action:manipulation">✕</button>
    </div>
    <div class="imod-stats">${statRows.join('<br>') || '—'}</div>
  </div>`;
  document.getElementById('app').appendChild(ov);
}

function closePetStatsModal() {
  const el = document.getElementById('pet-stats-modal-ov');
  if (el) el.remove();
}

function openPetCraftModal(idx) {
  const rec = PET_CRAFT_RECIPES[idx];
  if (!rec || !player) return;
  const pets = _petsOfRarity(rec.rarity);
  if (!pets.length) return;
  const rc = RARITY_COLOR[rec.rarity] || '#aea599';
  const nexumBal = window._nexumBalance || 0;
  const pending = _pendingPetCraftIdx === idx;

  const candidatesHtml = pets.map(p => `
    <div class="pet-pick" onclick="openPetStatsModal('${p.id}')">
      <div>${_itemIcon(p, 44)}</div>
      <div style="font-size:11px;color:${rc};margin-top:2px">${p.name}</div>
    </div>`).join('');

  const previewHtml = `<div class="pet-preview-hint">${typeof t === 'function' ? t('craftPetTapHint') : 'Нажмите на питомца — характеристики'}</div>`;

  const costRow = `<div class="craft-req-row">
    <span class="craft-req-icon">${_nexumIconHtml(20)}</span>
    <span class="craft-req-name">Liberty</span>
    <span class="craft-req-count" style="color:${nexumBal >= rec.nexumCost ? '#98e456' : '#eb4e61'}">${nexumBal}/${rec.nexumCost}</span>
  </div>`;

  const canCraft = !pending && invHasSpace() && nexumBal >= (rec.nexumCost || 0);

  document.getElementById('npc-body').innerHTML = `
    <button class="craft-back-btn" onclick="_setCraftsmanTab('mats')">${typeof t === 'function' ? t('craftBackBtn') : '← Назад'}</button>
    <div class="craft-detail-header">
      <div class="craft-detail-info">
        <div class="craft-detail-name" style="color:${rc};text-shadow:0 0 8px ${rc}66">${_RARITY_NAMES[rec.rarity] || rec.rarity}</div>
        <div class="craft-detail-stats">${typeof t === 'function' ? t('craftPetPickOneOf') : 'Один случайный из 3'}</div>
      </div>
    </div>
    <div style="display:flex;gap:6px;margin:8px 0">${candidatesHtml}</div>
    ${previewHtml}
    <div class="craft-reqs-title">${typeof t === 'function' ? t('craftRequiredLbl') : 'Требуется:'}</div>
    <div class="craft-reqs-list">${costRow}</div>
    <button class="shop-btn craft-do-btn${canCraft ? '' : ' disabled'}" onclick="craftPet(${idx})">${pending ? (typeof t === 'function' ? t('listingBusyLbl') : '...') : (typeof t === 'function' ? t('craftDoBtn') : 'Крафтить')}</button>
  `;
}

function craftPet(idx) {
  const rec = PET_CRAFT_RECIPES[idx];
  if (!rec || !player || _pendingPetCraftIdx !== null) return;
  if (!netIsLive()) { _shopMsg(typeof t === 'function' ? t('noServerConn') : 'Нет соединения с сервером'); return; }
  if ((window._nexumBalance || 0) < (rec.nexumCost || 0)) { _shopMsg('Недостаточно Liberty!'); return; }
  if (!invHasSpace()) { _shopMsg(typeof t === 'function' ? t('invFull') : 'Инвентарь полон!'); return; }

  _pendingPetCraftIdx = idx;
  openPetCraftModal(idx); // re-render with the button disabled/busy
  netCraftPet(rec.rarity);
}

function onPetCrafted(pet, delivered) {
  const idx = _pendingPetCraftIdx;
  _pendingPetCraftIdx = null;
  if (pet) {
    // Same rule as onClassGearCrafted above — the server owns the grant, and
    // delivered:false means it had no room to hand the pet over.
    if (delivered) {
      _shopMsg((typeof t === 'function' ? t('craftCreatedPrefix') : '✓ Создано: ') + pet.name);
    } else {
      _shopMsg(typeof t === 'function' ? t('invFull') : 'Инвентарь полон!');
    }
    if (typeof updateInvUI === 'function') updateInvUI();
  } else {
    _shopMsg(typeof t === 'function' ? t('craftFailMsg') : 'Провал! Материалы потеряны.');
  }
  if (idx !== null) openPetCraftModal(idx);
}

function onPetCraftError(msg) {
  const idx = _pendingPetCraftIdx;
  _pendingPetCraftIdx = null;
  _shopMsg(msg || (typeof t === 'function' ? t('genericErrorLbl') : 'Ошибка'));
  if (idx !== null) openPetCraftModal(idx);
}

function openBoxCraftModal(boxId) {
  const box = BOX_DEF.find(b => b.id === boxId);
  if (!box || !player) return;
  const keyDef = CRAFT_MATS.find(m => m.id === box.keyId);
  const have = countMaterial(box.keyId);
  const ok = have >= box.keyCost;
  const canCraft = ok && invHasSpace();
  const rc = RARITY_COLOR[box.rarity] || '#aea599';

  const oddsHtml = box.odds.map(o => {
    const rcO = RARITY_COLOR[o.rarity] || '#aea599';
    return `<div class="craft-req-row">
      <span class="craft-req-name" style="color:${rcO}">${_RARITY_NAMES[o.rarity] || o.rarity}</span>
      <span class="craft-req-count" style="color:${rcO}">${Math.round(o.chance * 100)}%</span>
    </div>`;
  }).join('');

  document.getElementById('npc-body').innerHTML = `
    <button class="craft-back-btn" onclick="_setCraftsmanTab('mats')">${typeof t === 'function' ? t('craftBackBtn') : '← Назад'}</button>
    <div class="craft-detail-header">
      <div class="craft-detail-icon">${_itemIcon(box, 52)}</div>
      <div class="craft-detail-info">
        <div class="craft-detail-name" style="color:${rc};text-shadow:0 0 8px ${rc}66">${box.name}</div>
      </div>
    </div>
    <div class="craft-reqs-title">${typeof t === 'function' ? t('craftRequiredLbl') : 'Требуется:'}</div>
    <div class="craft-reqs-list">
      <div class="craft-req-row">
        <span class="craft-req-icon">${keyDef ? _matIcon(keyDef, 20) : box.keyId}</span>
        <span class="craft-req-name">${keyDef ? keyDef.name : box.keyId}</span>
        <span class="craft-req-count" style="color:${ok ? '#98e456' : '#eb4e61'}">${have}/${box.keyCost}</span>
      </div>
    </div>
    <div class="craft-reqs-title">${typeof t === 'function' ? t('craftBoxContentsLbl') : 'Содержимое (1 предмет из бокса):'}</div>
    <div class="craft-reqs-list">${oddsHtml}</div>
    <button class="shop-btn craft-do-btn${canCraft ? '' : ' disabled'}" onclick="craftBox('${box.id}')">${typeof t === 'function' ? t('craftDoBtn') : 'Крафтить'}</button>
  `;
}

// Settled server-side (craftBox, server/index.js) — same reasoning as
// craftSpecificItem above. The checks here just refuse an obviously-
// impossible craft before the round trip.
function craftBox(boxId) {
  const box = BOX_DEF.find(b => b.id === boxId);
  if (!box || !player) return;
  const have = countMaterial(box.keyId);
  if (have < box.keyCost) { _shopMsg(typeof t === 'function' ? t('craftNotEnoughKeys') : 'Недостаточно ключей!'); return; }
  if (!invHasSpace())     { _shopMsg(typeof t === 'function' ? t('invFull') : 'Инвентарь полон!'); return; }
  _pendingBoxCraftId = boxId;
  if (typeof netCraftBox === 'function') netCraftBox(boxId);
}

// The server took the keys and added the box itself, and its inventorySync
// has already landed — nothing to add here, only the panel to refresh.
let _pendingBoxCraftId = null;
function onBoxCrafted(boxId) {
  const id = _pendingBoxCraftId;
  _pendingBoxCraftId = null;
  const box = BOX_DEF.find(b => b.id === boxId);
  if (typeof updateInvUI === 'function') updateInvUI();
  _shopMsg((typeof t === 'function' ? t('craftCreatedPrefix') : '✓ Создано: ') + (box ? box.name : boxId));
  if (id !== null) openBoxCraftModal(id);
}
function onBoxCraftError(msg) {
  const id = _pendingBoxCraftId;
  _pendingBoxCraftId = null;
  _shopMsg(msg || 'Ошибка');
  if (id !== null) openBoxCraftModal(id);
}

function openMatModal(idx) {
  const recipe = MAT_UPGRADE_RECIPES[idx];
  if (!recipe || !player) return;
  const fromMat = CRAFT_MATS.find(m => m.id === recipe.from);
  const toMat   = CRAFT_MATS.find(m => m.id === recipe.to);
  if (!fromMat || !toMat) return;

  const have = countMaterial(recipe.from);
  const ok = have >= recipe.count;
  const canCraft = ok && invHasSpace();
  const rcTo = RARITY_COLOR[toMat.rarity] || '#aea599';

  document.getElementById('npc-body').innerHTML = `
    <button class="craft-back-btn" onclick="_setCraftsmanTab('mats')">${typeof t === 'function' ? t('craftBackBtn') : '← Назад'}</button>
    <div class="craft-detail-header">
      <div class="craft-detail-icon">${_matIcon(toMat, 52)}</div>
      <div class="craft-detail-info">
        <div class="craft-detail-name" style="color:${rcTo};text-shadow:0 0 8px ${rcTo}66">${toMat.name}</div>
      </div>
    </div>
    <div class="craft-reqs-title">${typeof t === 'function' ? t('craftRequiredLbl') : 'Требуется:'}</div>
    <div class="craft-reqs-list">
      <div class="craft-req-row">
        <span class="craft-req-icon">${_matIcon(fromMat, 20)}</span>
        <span class="craft-req-name">${fromMat.name}</span>
        <span class="craft-req-count" style="color:${ok ? '#98e456' : '#eb4e61'}">${have}/${recipe.count}</span>
      </div>
    </div>
    <div class="craft-chance-row">${typeof t === 'function' ? t('craftChanceLbl') : 'Шанс успеха: '}<b style="color:#ebab4b">${Math.round(recipe.chance * 100)}%</b></div>
    <button class="shop-btn craft-do-btn${canCraft ? '' : ' disabled'}" onclick="craftMatUpgrade(${idx})">${typeof t === 'function' ? t('craftDoBtn') : 'Крафтить'}</button>
  `;
}

// Settled server-side (craftMatUpgrade, server/index.js) — same reasoning as
// craftSpecificItem above. The checks here just refuse an obviously-
// impossible craft before the round trip.
function craftMatUpgrade(idx) {
  const recipe = MAT_UPGRADE_RECIPES[idx];
  if (!recipe || !player) return;
  const fromHave = countMaterial(recipe.from);
  if (fromHave < recipe.count)  { _shopMsg(typeof t === 'function' ? t('craftNotEnoughMats') : 'Недостаточно материалов!'); return; }
  if (!invHasSpace())           { _shopMsg(typeof t === 'function' ? t('invFull') : 'Инвентарь полон!'); return; }
  _pendingMatUpgradeIdx = idx;
  if (typeof netCraftMatUpgrade === 'function') netCraftMatUpgrade(recipe.from);
}

// The server took the lower-tier scrolls and, on success, added the higher
// tier itself; its inventorySync has already landed — nothing to add here,
// only the panel to refresh with the right message for the roll's outcome.
let _pendingMatUpgradeIdx = null;
function onMatUpgraded(from, to, success) {
  const idx = _pendingMatUpgradeIdx;
  _pendingMatUpgradeIdx = null;
  const mat = CRAFT_MATS.find(m => m.id === to);
  if (typeof updateInvUI === 'function') updateInvUI();
  _shopMsg(success
    ? (typeof t === 'function' ? t('craftReceivedPrefix') : '✓ Получено: ') + (mat ? mat.name : to)
    : (typeof t === 'function' ? t('craftFailMsg') : 'Провал! Материалы потеряны.'));
  if (idx !== null) openMatModal(idx);
}
function onMatUpgradeError(msg) {
  const idx = _pendingMatUpgradeIdx;
  _pendingMatUpgradeIdx = null;
  _shopMsg(msg || 'Ошибка');
  if (idx !== null) openMatModal(idx);
}

// Single fixed recipe (ADV_SKILL_BOOK_CRAFT), so unlike openMatModal there's
// no idx to thread through — just re-open this same screen on either result.
function openAdvBookCraftModal() {
  if (!player) return;
  const have = countSkillBooks();
  const ok = have >= ADV_SKILL_BOOK_CRAFT.count;
  const canCraft = ok && invHasSpace();

  document.getElementById('npc-body').innerHTML = `
    <button class="craft-back-btn" onclick="_setCraftsmanTab('mats')">${typeof t === 'function' ? t('craftBackBtn') : '← Назад'}</button>
    <div class="craft-detail-header">
      <div class="craft-detail-icon">${iconHTML('book', 52, '#f5c542')}</div>
      <div class="craft-detail-info">
        <div class="craft-detail-name" style="color:#f5c542;text-shadow:0 0 8px #f5c54266">${typeof t === 'function' ? t('craftAdvBookRandom') : 'Случайная книга 2 профессии'}</div>
      </div>
    </div>
    <div class="craft-reqs-title">${typeof t === 'function' ? t('craftRequiredLbl') : 'Требуется:'}</div>
    <div class="craft-reqs-list">
      <div class="craft-req-row">
        <span class="craft-req-icon">${iconHTML('book', 20, '#c48a3a')}</span>
        <span class="craft-req-name">${typeof t === 'function' ? t('craftAnySkillBook') : 'Любые книги навыков'}</span>
        <span class="craft-req-count" style="color:${ok ? '#98e456' : '#eb4e61'}">${have}/${ADV_SKILL_BOOK_CRAFT.count}</span>
      </div>
    </div>
    <div class="craft-chance-row">${typeof t === 'function' ? t('craftChanceLbl') : 'Шанс успеха: '}<b style="color:#ebab4b">${Math.round(ADV_SKILL_BOOK_CRAFT.chance * 100)}%</b></div>
    <button class="shop-btn craft-do-btn${canCraft ? '' : ' disabled'}" onclick="craftAdvSkillBook()">${typeof t === 'function' ? t('craftDoBtn') : 'Крафтить'}</button>
  `;
}

// Settled server-side (craftAdvSkillBook, server/index.js) — same reasoning
// as craftMatUpgrade above. The checks here just refuse an obviously-
// impossible craft before the round trip.
function craftAdvSkillBook() {
  if (!player) return;
  if (countSkillBooks() < ADV_SKILL_BOOK_CRAFT.count) { _shopMsg(typeof t === 'function' ? t('craftNotEnoughMats') : 'Недостаточно материалов!'); return; }
  if (!invHasSpace()) { _shopMsg(typeof t === 'function' ? t('invFull') : 'Инвентарь полон!'); return; }
  if (typeof netCraftAdvSkillBook === 'function') netCraftAdvSkillBook();
}

// The server took the 5 skill books and, on success, added the random
// advanced book itself; its inventorySync has already landed — only the
// panel to refresh with the right message for the roll's outcome.
function onAdvSkillBookCrafted(success, id) {
  const book = CRAFT_MATS.find(m => m.id === id);
  if (typeof updateInvUI === 'function') updateInvUI();
  _shopMsg(success
    ? (typeof t === 'function' ? t('craftReceivedPrefix') : '✓ Получено: ') + (book ? book.name : '')
    : (typeof t === 'function' ? t('craftFailMsg') : 'Провал! Материалы потеряны.'));
  openAdvBookCraftModal();
}
function onAdvSkillBookCraftError(msg) {
  _shopMsg(msg || 'Ошибка');
  openAdvBookCraftModal();
}

// ── Storage ─────────────────────────────────────────────
let _storageTab = 'inv'; // 'inv' | 'storage'

function _setStorageTab(tab) {
  _storageTab = tab;
  document.getElementById('npc-body').innerHTML = _buildNpcBody('storage');
}

function _storageBody() {
  const tabs = `<div class="craft-tabs">
    <button class="craft-tab${_storageTab==='inv'?' active':''}" onclick="_setStorageTab('inv')">${typeof t === 'function' ? t('storageInvTab') : 'Инвентарь'} (${invSlotCount()}/150)</button>
    <button class="craft-tab${_storageTab==='storage'?' active':''}" onclick="_setStorageTab('storage')">${typeof t === 'function' ? t('storageStorageTab') : 'Хранилище'} (${storageSlotCount()}/200)</button>
  </div>`;
  return tabs + (_storageTab === 'inv' ? _storageInvTab() : _storageStoTab());
}

function _storageItemCell(it, idx, onclickFn) {
  const rc = RARITY_COLOR[it.rarity] || '#aea599';
  const cnt = it.qty > 1 ? `<span style="position:absolute;bottom:1px;right:2px;font-size:7px;color:#cfc0ad;font-weight:bold">×${it.qty}</span>` : '';
  const enh = it.enhance ? `<span style="position:absolute;top:1px;right:3px;font-size:8px;color:#e69419;font-weight:bold">+${it.enhance}</span>` : '';
  return `<div class="craft-item-cell craftable" style="border-color:${rc}66;position:relative" onclick="${onclickFn}(${idx})" title="${it.name}">
    ${enh}${cnt}
    <div class="craft-item-cell-icon">${_itemIcon(it, 32)}</div>
    <div class="craft-item-cell-name" style="color:${rc}">${it.name}</div>
  </div>`;
}

function _storageInvTab() {
  if (!player.inventory.length) return '<div class="craft-mats-info">' + (typeof t === 'function' ? t('storageInvEmpty') : 'Инвентарь пуст') + '</div>';
  let html = '<div class="craft-mats-info">' + (typeof t === 'function' ? t('storageTapToStore') : 'Нажмите на предмет, чтобы положить в хранилище') + '</div><div class="craft-items-grid">';
  player.inventory.forEach((it, idx) => { html += _storageItemCell(it, idx, '_doMoveToStorage'); });
  html += '</div>';
  return html;
}

function _storageStoTab() {
  if (!player.storage.length) return '<div class="craft-mats-info">' + (typeof t === 'function' ? t('storageEmpty') : 'Хранилище пусто') + '</div>';
  let html = '<div class="craft-mats-info">' + (typeof t === 'function' ? t('storageTapToTake') : 'Нажмите на предмет, чтобы забрать') + '</div><div class="craft-items-grid">';
  player.storage.forEach((it, idx) => { html += _storageItemCell(it, idx, '_doMoveToInventory'); });
  html += '</div>';
  return html;
}

// Both moves ride the ordinary 2s debounce — a save blob carries the whole
// inventory AND storage as full item objects, so flushing per tap would
// re-upload all of it for every item of a bulk move. closeNpc flushes once
// instead; see the note there for why the timing matters.
function _doMoveToStorage(idx) {
  if (!player) return;
  if (!moveToStorage(idx)) { _shopMsg(typeof t === 'function' ? t('storageFull') : 'Хранилище полно!'); return; }
  netSaveProgress();
  document.getElementById('npc-body').innerHTML = _buildNpcBody('storage');
}

function _doMoveToInventory(idx) {
  if (!player) return;
  if (!moveToInventory(idx)) { _shopMsg(typeof t === 'function' ? t('invFull') : 'Инвентарь полон!'); return; }
  netSaveProgress();
  document.getElementById('npc-body').innerHTML = _buildNpcBody('storage');
}

// The panel's cells carry raw indices into player.inventory / player.storage
// (see _storageItemCell), so an inventorySync that swaps those arrays under
// an open panel leaves every cell pointing at whatever now sits at that
// index — the next tap moves an item the player never picked. Redraw instead.
// No-op unless the storage NPC is actually on screen.
function refreshStorageNpc() {
  if (_openNpcId !== 'storage' || !player) return;
  document.getElementById('npc-body').innerHTML = _buildNpcBody('storage');
}

function _shopMsg(msg) {
  const body = document.getElementById('npc-body');
  const el = document.createElement('div');
  el.className = 'shop-msg';
  el.textContent = msg;
  body.insertBefore(el, body.firstChild);
  setTimeout(() => el.remove(), 2500);
}

function _shopMsgOk(msg) {
  const body = document.getElementById('npc-body');
  const el = document.createElement('div');
  el.className = 'shop-msg shop-msg-ok';
  el.textContent = msg;
  body.insertBefore(el, body.firstChild);
  setTimeout(() => el.remove(), 2000);
}
