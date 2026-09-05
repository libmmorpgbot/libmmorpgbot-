// ─────────────────────────────────────────────────────────
//  PANEL UIs
// ─────────────────────────────────────────────────────────
function _itemIcon(it, size) {
  // Skill books: the book glyph framed around that skill's own icon/art, so
  // each one is identifiable at a glance instead of all looking identical.
  if (it && it.skillKey && it.forClass) {
    const sk = (SKILL_DEF[it.forClass] || []).find(s => s.key === it.skillKey);
    const gs = Math.round(size * 0.58);
    const glyph = sk && sk.img
      ? `<img src="${sk.img}" width="${gs}" height="${gs}" style="image-rendering:pixelated;border-radius:2px">`
      : iconHTML((sk && sk.icon) || 'book', gs, '#e3941d');
    return `<div style="position:relative;width:${size}px;height:${size}px">
      ${iconHTML('book', size, '#c48a3a')}
      <div style="position:absolute;left:50%;top:46%;transform:translate(-50%,-50%)">${glyph}</div>
    </div>`;
  }
  // Advanced-skill books ("вторая профессия") — same book-glyph treatment as
  // regular skill books above, framing ADV_SKILL_DEF's art instead of
  // SKILL_DEF's, with a gold ring so the rare drop reads differently at a
  // glance even before the tooltip/name is read.
  if (it && it.advSkillKey && it.forClass) {
    const sk = ((typeof ADV_SKILL_DEF !== 'undefined' && ADV_SKILL_DEF[it.forClass]) || []).find(s => s.key === it.advSkillKey);
    const gs = Math.round(size * 0.58);
    const glyph = sk && sk.img
      ? `<img src="${sk.img}" width="${gs}" height="${gs}" style="image-rendering:pixelated;border-radius:2px">`
      : iconHTML((sk && sk.icon) || 'book', gs, '#f5c542');
    return `<div style="position:relative;width:${size}px;height:${size}px">
      ${iconHTML('book', size, '#f5c542')}
      <div style="position:absolute;left:50%;top:46%;transform:translate(-50%,-50%)">${glyph}</div>
    </div>`;
  }
  // Passive skill books: same book-glyph treatment, framing the passive's
  // own icon (PASSIVE_CLASS_DEF for class-exclusive ones, PASSIVE_COMMON_DEF
  // for universal ones — passiveDefById checks both).
  if (it && it.passiveId) {
    const pd = typeof passiveDefById === 'function' ? passiveDefById(it.forClass, it.passiveId) : null;
    const gs = Math.round(size * 0.58);
    const glyph = pd && pd.img
      ? `<img src="${pd.img}" width="${gs}" height="${gs}" style="image-rendering:pixelated;border-radius:2px">`
      : iconHTML('star', gs, '#e3941d');
    return `<div style="position:relative;width:${size}px;height:${size}px">
      ${iconHTML('book', size, '#c48a3a')}
      <div style="position:absolute;left:50%;top:46%;transform:translate(-50%,-50%)">${glyph}</div>
    </div>`;
  }
  if (it && it.img) {
    return `<img src="${it.img}" width="${size}" height="${size}"
      style="image-rendering:pixelated;border-radius:3px;"
      onerror="this.style.display='none'">`;
  }
  const rc = it ? (RARITY_COLOR[it.rarity] || '#aea599') : '#6c6354';
  return iconHTML((it && it.icon) || 'weapon', size, rc);
}
function updateInvUI() {
  if (!player) return;
  const p = player;
  const inv = p.inventory;

  // Equipment diamond: left column = weapon/helmet/body/gloves/cloak, right
  // column = boots/ring/belt/pet/artifact (EQ_SLOTS' own order, see
  // js/definitions.js — first half/second half), with the animated portrait
  // (eq-center-canvas) floating between them — see _startInvPortraitAnim
  // below.
  const _eqCellHtml = ({ slot, label, emptyIcon }) => {
    const it = p.equipment[slot];
    const rc = it ? (RARITY_COLOR[it.rarity] || '#aea599') : '';
    const enhBadge = it && it.enhance ? `<span style="position:absolute;top:1px;right:2px;font-size:7px;color:#e69419;font-weight:bold">+${it.enhance}</span>` : '';
    return `<div class="eq-cell${it ? ' filled' : ''}" onclick="${it ? `openEqItemModal('${slot}')` : ''}"
      title="${it ? it.name + (it.enhance ? ' +' + it.enhance : '') + ' — ' + statStr(it) : label}"
      style="${it ? 'border-color:' + rc + '55;position:relative' : ''}">
      <div class="cell-icon">${it ? _itemIcon(it, 34) : iconHTML(emptyIcon, 27, '#6c6354')}</div>
      <div class="cell-lbl" style="${it ? 'color:' + rc : ''}">${it ? it.name : label}</div>
      ${enhBadge}
    </div>`;
  };
  // Слотов стало одиннадцать (добавились крылья), и половина перестала быть
  // целой. Округление вверх — решение, а не побочный эффект: слева шесть,
  // справа пять. Без него slice(0, 5.5) молча отдавал то же самое, но по
  // случайности, а не по правилу.
  const _eqHalf = Math.ceil(EQ_SLOTS.length / 2);
  document.getElementById('eq-col-left').innerHTML  = EQ_SLOTS.slice(0, _eqHalf).map(_eqCellHtml).join('');
  document.getElementById('eq-col-right').innerHTML = EQ_SLOTS.slice(_eqHalf).map(_eqCellHtml).join('');
  _startInvPortraitAnim();

  // Character preview
  const _bag = p.potionBag || {};
  const _hudPtDef = ITEM_DEF.find(d => d.id === (p.hudPotion || 'pt1'));
  const _hudCount = _bag[p.hudPotion || 'pt1'] || 0;
  const _activeBufCount = Object.values(p.buffs || {}).filter(v => v > 0).length;
  document.getElementById('char-preview').innerHTML = `
    <div class="inv-char-row">
      <div style="line-height:1">${iconHTML(p.charDef.icon, 40, p.charDef.color)}</div>
      <div style="flex:1">
        <div style="font-size:14px;font-weight:bold;color:${p.charDef.color}">${p.charDef.name}</div>
        <div style="font-size:11px;color:#a2988a;margin-top:2px">${tVars('charLevelFmt', { lvl: p.lvl })}</div>
        <div style="font-size:11px;color:#5d564b;margin-top:2px;display:flex;align-items:center;gap:3px">
          ${iconHTML('heart',11,'#da4658')}${Math.ceil(p.hp)}/${p.maxHp} ·
          <span style="color:#eaa742;font-weight:700">${t('bmAbbrev')} ${typeof calcBM==='function'?calcBM(p):0}</span> ·
          ${iconHTML('coin',11,'#e3941d')}${Math.floor(p.gold)}
        </div>
      </div>
      <div onclick="openHpPicker()" style="color:#98e456;text-align:right;font-weight:bold;display:flex;flex-direction:column;align-items:center;gap:1px;cursor:pointer">
        ${_hudPtDef && _hudPtDef.img ? `<img src="${_hudPtDef.img}" width="20" height="20" style="image-rendering:pixelated">` : iconHTML('potion',20,'#90d653')}
        <span style="font-size:10px">×${_hudCount}</span>
        ${_activeBufCount > 0 ? `<span style="font-size:9px;color:#e5a546">${_activeBufCount} ${t('buffCountSuffix')}</span>` : ''}
      </div>
    </div>
  `;

  // Inventory grid — materials stack by id
  document.getElementById('inv-count').textContent = invSlotCount() + '/150';
  const _displayInv = [];
  inv.forEach((it, idx) => {
    if (_isStackable(it)) {
      _displayInv.push({ it, idx, count: it.qty || 1 });
    } else {
      _displayInv.push({ it, idx });
    }
  });

  document.getElementById('inv-grid').innerHTML = Array.from({ length: 150 }, (_, i) => {
    const entry = _displayInv[i];
    if (!entry) return `<div class="inv-cell"></div>`;
    const { it, idx, count } = entry;
    const rc = RARITY_COLOR[it.rarity] || '#aea599';
    const enh = it.enhance ? `<span style="position:absolute;top:1px;right:2px;font-size:7px;color:#e69419;font-weight:bold">+${it.enhance}</span>` : '';
    const cntBadge = count ? `<span style="position:absolute;bottom:1px;right:2px;font-size:7px;color:#cfc0ad;font-weight:bold">×${count}</span>` : '';
    const clickable = idx !== undefined;
    return `<div class="inv-cell filled" onclick="${clickable ? `openInvItemModal(${idx})` : ''}"
      title="${it.name + (it.enhance ? ' +' + it.enhance : '') + ' — ' + statStr(it)}"
      style="border-color:${rc}77;position:relative">
      <div style="display:flex;justify-content:center;align-items:center">${_itemIcon(it, 24)}</div>
      <div style="font-size:7px;color:${rc};text-align:center;margin-top:1px;overflow:hidden;white-space:normal;word-break:break-word;line-height:1.2">${it.name}</div>
      ${enh}${cntBadge}
    </div>`;
  }).join('');
  _refreshTeleportBadge();
}

// ── Teleport stones ─────────────────────────────────────────────────────
// Badge on #teleport-btn (index.html) mirrors how many teleport_stone the
// player currently holds — hidden at 0, same shape as #chat-badge's unread
// count. Refreshed here (every inventory redraw already covers a purchase's
// inventorySync) and again explicitly after a teleport is used, since that
// consumes a stone without necessarily re-running updateInvUI first.
function _refreshTeleportBadge() {
  const badge = document.getElementById('teleport-stone-badge');
  if (!badge) return;
  const n = (typeof countMaterial === 'function' && player) ? countMaterial('teleport_stone') : 0;
  if (n > 0) { badge.textContent = n > 99 ? '99+' : String(n); badge.style.display = 'flex'; }
  else { badge.style.display = 'none'; }
}

// Client-local mirror of the server's cast window (set from
// 'teleportCastStarted', js/network.js). Purely cosmetic — the server is
// sole authority over whether the player can actually move or attack during
// a cast (_teleportCastFrozen folded into _pvpFrozen, server/index.js) —
// but this is what drives the blue swirl (_buildDecals, js/game.js) and
// lets the button itself ignore extra taps while one is already running.
let _teleportCastUntil = 0;
function _teleportCasting() {
  return Date.now() < _teleportCastUntil;
}

// Always recalls to the hub after a channelled cast — no destination picker
// any more, a teleport stone only ever goes home. Consuming the stone and
// starting/timing the cast are both server-side (useTeleportStone,
// server/index.js); this is only the button's own courtesy pre-check (a
// 0-stone tap refuses locally instead of paying a round trip for a message
// 'itemError' would show anyway) plus the request itself.
function _useTeleportStone() {
  if (!player) return;
  if (_teleportCasting()) return; // already mid-cast, ignore the extra tap
  const have = typeof countMaterial === 'function' ? countMaterial('teleport_stone') : 0;
  if (have <= 0) {
    dmgNum(player.x, player.y - 40, typeof t === 'function' ? t('teleportStoneNoneMsg') : 'Нет камня телепортации', '#f17e8b');
    return;
  }
  if (typeof netUseTeleportStone === 'function') netUseTeleportStone();
}

// Merchant purchase result (buyTeleportStone, server/index.js) — the stone
// itself arrives via the usual inventorySync, this only has to refresh what
// displays a count (merchant panel, badge) and report the outcome.
function onTeleportStoneBought(qty, delivered) {
  if (typeof updateInvUI === 'function') updateInvUI();
  if (typeof refreshNpcPanel === 'function') refreshNpcPanel();
  _refreshTeleportBadge();
  if (typeof _shopMsg === 'function') {
    _shopMsg(delivered
      ? (typeof t === 'function' ? t('craftCreatedPrefix') : '✓ Создано: ') + `×${qty} ` + (typeof t === 'function' ? t('teleportBtnTitle') : 'Камни телепортации')
      : (typeof t === 'function' ? t('invFull') : 'Инвентарь полон!'));
  }
}
function onTeleportStoneError(msg) {
  if (typeof _shopMsg === 'function') _shopMsg(msg || t('genericErrorLbl'));
}

// ── Inventory portrait (eq-center-canvas) ──────────────────
// Always shows the player's frontleft-idle animation, looping, instead of a
// static class icon — same rasterize-then-draw approach as the char-select
// preview (_csDrawFrame, js/charselect.js), just pinned to one direction/
// state rather than switching with input. Self-terminating: each tick checks
// the panel is still open before scheduling the next frame, so leaving the
// Персонаж tab (or the Инвентарь sub-tab) stops it within one frame without
// needing an explicit stop call anywhere panels get switched.
let _invPortraitRAF = null;
let _invPortraitState = { frame: 0, timer: 0, type: null };
const _INV_PORTRAIT_ANIM = 'frontleft-idle';

function _startInvPortraitAnim() {
  if (_invPortraitRAF) return;
  let last = performance.now();
  function tick(now) {
    const panel = document.getElementById('panel-inv');
    const canvas = document.getElementById('eq-center-canvas');
    if (!panel || !panel.classList.contains('open') || _invTab !== 0 || !canvas) {
      _invPortraitRAF = null;
      return;
    }
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    _drawInvPortraitFrame(canvas, dt);
    _invPortraitRAF = requestAnimationFrame(tick);
  }
  _invPortraitRAF = requestAnimationFrame(tick);
}

function _drawInvPortraitFrame(canvas, dt) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const type = player && player.type;
  const def = type && SPRITE_DEF[type];
  const animDef = def && def.anims[_INV_PORTRAIT_ANIM];
  if (!type || !def || !animDef) return;

  if (_invPortraitState.type !== type) _invPortraitState = { frame: 0, timer: 0, type };
  const s = _invPortraitState;
  const fps = animDef.fps || 7;
  s.timer += dt;
  while (s.timer >= 1 / fps) { s.timer -= 1 / fps; s.frame = (s.frame + 1) % animDef.n; }

  const img = spriteCache[type] && spriteCache[type][_INV_PORTRAIT_ANIM];
  if (img && _sheetReady(img)) {
    const fw = img.frameW || def.frameW, fh = img.frameH || def.frameH;
    const col = s.frame % animDef.cols;
    const row = Math.floor(s.frame / animDef.cols);
    ctx.drawImage(img, col * fw, row * fh, fw, fh, 0, 0, W, H);
    return;
  }
  // Sheet not loaded/rasterized yet (shouldn't normally happen — loadSprites
  // runs for the player's own type at gameStart) — kick off loading and show
  // the class-colored fallback the char-select canvas uses meanwhile.
  if (typeof loadSprites === 'function') loadSprites(type, () => {});
  const cd = CHAR_DEF[type];
  if (!cd) return;
  ctx.fillStyle = cd.color + 'aa';
  ctx.beginPath();
  ctx.arc(W / 2, H / 2, Math.min(W, H) * 0.32, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = cd.color;
  ctx.lineWidth = 3;
  ctx.stroke();
}

// ─────────────────────────────────────────────────────────
//  HP PICKER MODAL
// ─────────────────────────────────────────────────────────
function openHpPicker() {
  if (!player) return;
  const existing = document.getElementById('hp-picker-ov');
  if (existing) existing.remove();

  const bag = player.potionBag || {};
  const hudPt = player.hudPotion || 'pt1';
  const autoThresholds = [0, 0.3, 0.5, 0.7];
  const autoLabels = [t('offLbl'), '30%', '50%', '70%'];
  const curAuto = player.autoHpPct || 0;

  const hpPots = ITEM_DEF.filter(d => d.slot === 'use');
  const potCells = hpPots.map(def => {
    const cnt = bag[def.id] || 0;
    const isHud = def.id === hudPt;
    const imgEl = def.img
      ? `<img src="${def.img}" width="28" height="28" style="image-rendering:pixelated;display:block;margin:0 auto 2px">`
      : iconHTML(def.icon || 'potion', 28, isHud ? '#90d653' : '#9c9383');
    return `<div onclick="setHudPotion('${def.id}');openHpPicker()" style="
      flex:1;padding:10px 6px;border-radius:10px;text-align:center;cursor:pointer;
      border:2px solid ${isHud ? '#90d653' : 'rgba(209,204,197,0.1)'};
      background:${isHud ? 'rgba(143,214,82,0.12)' : 'rgba(209,204,197,0.04)'};
    ">
      ${imgEl}
      <div style="font-size:10px;color:${isHud ? '#90d653' : '#968a7a'};font-weight:${isHud?'700':'400'}">${def.name}</div>
      <div style="font-size:11px;color:#98e456;margin-top:2px">×${cnt}</div>
      <div style="font-size:9px;color:#72685a">${tVars('potCooldownFmt', { hp: def.hp, s: 4 })}</div>
      ${isHud ? `<div style="font-size:9px;color:#90d653;font-weight:700;margin-top:2px">${t('inHudBadge')}</div>` : ''}
    </div>`;
  }).join('');

  const autoRows = autoThresholds.map((v, i) => {
    const isActive = Math.abs(curAuto - v) < 0.01;
    return `<button onclick="setAutoHpPct(${v})" style="
      flex:1;padding:8px 4px;border:none;border-radius:8px;cursor:pointer;font-size:12px;font-weight:700;
      background:${isActive ? '#29361e' : 'rgba(209,204,197,0.06)'};
      color:${isActive ? '#90d653' : '#968a7a'};
      border:1px solid ${isActive ? '#90d65344' : 'transparent'};
    ">${autoLabels[i]}</button>`;
  }).join('');

  const ov = document.createElement('div');
  ov.id = 'hp-picker-ov';
  ov.onclick = () => ov.remove();
  ov.style.cssText = 'position:fixed;inset:0;z-index:220;background:rgba(0,0,0,.75);backdrop-filter:blur(4px);display:flex;align-items:flex-end;justify-content:center;';
  ov.innerHTML = `<div onclick="event.stopPropagation()" style="width:100%;background:#16120a;border-radius:18px 18px 0 0;border-top:1px solid rgba(209,204,197,.1);padding:18px 16px 30px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
      <div style="font-size:15px;font-weight:800;color:#90d653">${t('npcHealPotionsHdr')}</div>
      <button onclick="document.getElementById('hp-picker-ov').remove()" style="width:28px;height:28px;border:none;border-radius:50%;background:rgba(209,204,197,.08);color:#968a7a;font-size:13px;cursor:pointer;">✕</button>
    </div>
    <div style="display:flex;gap:10px;margin-bottom:16px">${potCells}</div>
    <div style="font-size:11px;color:#72685a;margin-bottom:8px">${t('autoUseHint')}</div>
    <div style="display:flex;gap:8px">${autoRows}</div>
    <button onclick="usePotion();document.getElementById('hp-picker-ov').remove()" style="
      width:100%;margin-top:14px;padding:12px;border:none;border-radius:12px;
      background:linear-gradient(135deg,#29361e,#415331);color:#90d653;font-size:15px;font-weight:700;cursor:pointer;
    ">${t('useBtn')}</button>
  </div>`;
  document.getElementById('app').appendChild(ov);
}

function setAutoHpPct(pct) {
  if (!player) return;
  player.autoHpPct = pct;
  netSaveProgress();
  openHpPicker();
}

// ─────────────────────────────────────────────────────────
//  AUTO-CAST PICKER (which skills АВТО is allowed to use)
// ─────────────────────────────────────────────────────────
// Opened by holding the AUTO button (js/input.js) or from the skills panel.
// АВТО used to cast whatever was off cooldown, in slot order, with no say in
// it: no way to keep an ultimate for a boss, to stop a knockback scattering a
// pull, or to have the auto simply attack without spending anything.
function openAutoSkillsPicker() {
  if (!player) return;
  const existing = document.getElementById('auto-skills-ov');
  if (existing) existing.remove();

  const skills = SKILL_DEF[player.type] || [];
  const master = player.autoSkillsOn !== false;
  const off = player.autoSkillOff || {};
  const vipMin = (typeof AUTO_SKILL_VIP_MIN !== 'undefined') ? AUTO_SKILL_VIP_MIN : 2;
  const vipNow = (window._vipData && window._vipData.level) || 0;

  const masterBtns = [true, false].map(on => `<button onclick="setAutoSkillsOn(${on})" style="
    flex:1;padding:8px 4px;border-radius:8px;cursor:pointer;font-size:12px;font-weight:700;
    background:${master === on ? '#29361e' : 'rgba(209,204,197,0.06)'};
    color:${master === on ? '#90d653' : '#968a7a'};
    border:1px solid ${master === on ? '#90d65344' : 'transparent'};
  ">${on ? t('onLbl') : t('offLbl')}</button>`).join('');

  const rows = skills.map((base, i) => {
    // The variant actually in play — an advanced skill can be auto-castable
    // where its base version isn't (or the other way round), and this has to
    // agree with what _autoCastSkills (js/game.js) will really do.
    const sk = (typeof _activeSkillDef === 'function') ? _activeSkillDef(player.type, i) : base;
    if (!sk) return '';
    const learned = _skillLvl(sk.key) > 0;
    const neverAuto = sk.auto === false;
    const enabled = !off[sk.key];
    const glyph = sk.img
      ? `<img src="${sk.img}" width="22" height="22" style="image-rendering:pixelated;border-radius:3px;display:block">`
      : iconHTML(sk.icon, 22, '#e3941d');
    let right;
    if (neverAuto) {
      // Dash/jump/teleport: firing these unattended throws the character
      // across the room, so they are not offered at all rather than offered
      // and quietly ignored.
      right = `<span style="font-size:11px;color:#645f57">${t('autoSkillNotForAuto')}</span>`;
    } else if (!learned) {
      right = `<span style="font-size:11px;color:#645f57">${t('notStudiedLbl')}</span>`;
    } else {
      right = `<button onclick="toggleAutoSkill('${sk.key}')" style="
        min-width:62px;padding:7px 10px;border-radius:8px;cursor:pointer;font-size:11.5px;font-weight:800;
        background:${enabled ? 'rgba(143,214,82,0.12)' : 'rgba(209,204,197,0.05)'};
        color:${enabled ? '#90d653' : '#968a7a'};
        border:1px solid ${enabled ? '#90d65355' : 'rgba(209,204,197,0.1)'};
      ">${enabled ? t('onLbl') : t('offLbl')}</button>`;
    }
    const dim = (!master || neverAuto || !learned) ? 0.55 : 1;
    return `<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:10px;
      background:rgba(209,204,197,0.04);opacity:${dim}">
      <div style="width:26px;height:26px;display:flex;align-items:center;justify-content:center">${glyph}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:12.5px;font-weight:700;color:#d1ccc5">
          <span style="color:#e3941d">${sk.key}</span> · ${sk.name}
        </div>
        <div style="font-size:10.5px;color:#72685a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${sk.desc || ''}</div>
      </div>
      ${right}
    </div>`;
  }).join('');

  const vipWarn = vipNow < vipMin
    ? `<div style="font-size:11px;color:#eaa742;margin-top:10px">🔒 ${tVars('autoSkillsVipHintFmt', { n: vipMin })}</div>`
    : '';

  const ov = document.createElement('div');
  ov.id = 'auto-skills-ov';
  ov.onclick = () => ov.remove();
  ov.style.cssText = 'position:fixed;inset:0;z-index:220;background:rgba(0,0,0,.75);backdrop-filter:blur(4px);display:flex;align-items:flex-end;justify-content:center;';
  ov.innerHTML = `<div onclick="event.stopPropagation()" style="width:100%;background:#16120a;border-radius:18px 18px 0 0;border-top:1px solid rgba(209,204,197,.1);padding:18px 16px 30px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
      <div style="font-size:15px;font-weight:800;color:#90d653">${t('autoSkillsHdr')}</div>
      <button onclick="document.getElementById('auto-skills-ov').remove()" style="width:28px;height:28px;border:none;border-radius:50%;background:rgba(209,204,197,.08);color:#968a7a;font-size:13px;cursor:pointer;">✕</button>
    </div>
    <div style="font-size:11px;color:#72685a;margin-bottom:10px">${t('autoSkillsHint')}</div>
    <div style="font-size:11.5px;color:#b2a288;margin-bottom:6px">${t('autoSkillsMasterLbl')}</div>
    <div style="display:flex;gap:8px;margin-bottom:14px">${masterBtns}</div>
    <div style="display:flex;flex-direction:column;gap:6px">${rows}</div>
    ${vipWarn}
  </div>`;
  document.getElementById('app').appendChild(ov);
}

function setAutoSkillsOn(on) {
  if (!player) return;
  player.autoSkillsOn = !!on;
  netSaveProgress();
  openAutoSkillsPicker();
}

// Stores the OFF set, not the ON one: a slot nobody has touched — and every
// account that predates this picker — keeps auto-casting exactly as before.
function toggleAutoSkill(key) {
  if (!player) return;
  const off = player.autoSkillOff || (player.autoSkillOff = {});
  if (off[key]) delete off[key];
  else off[key] = true;
  netSaveProgress();
  openAutoSkillsPicker();
}

function closePotionModal() {
  const el = document.getElementById('hp-picker-ov');
  if (el) el.remove();
  const el2 = document.getElementById('pt-modal');
  if (el2) el2.style.display = 'none';
}

function setHudPotion(itemId) {
  if (!player) return;
  player.hudPotion = itemId;
  updateInvUI();
  netSaveProgress();
}

// ─────────────────────────────────────────────────────────
//  PEER PROFILE MODAL (view another player's stats/equipment —
//  currently reached from the party invite popup's info button)
// ─────────────────────────────────────────────────────────
function showPeerProfileModal(fromName, profile) {
  if (!profile) return;
  const existing = document.getElementById('peer-profile-ov');
  if (existing) existing.remove();

  const fmt1 = v => ((v || 0) * 100).toFixed(1) + '%';
  const eqCells = EQ_SLOTS.map(({ slot, label, emptyIcon }) => {
    const it = profile.equipment[slot];
    const rc = it ? (RARITY_COLOR[it.rarity] || '#aea599') : '';
    const enhBadge = it && it.enhance ? `<span style="position:absolute;top:1px;right:2px;font-size:7px;color:#e69419;font-weight:bold">+${it.enhance}</span>` : '';
    return `<div class="eq-cell${it ? ' filled' : ''}"
      title="${it ? it.name + (it.enhance ? ' +' + it.enhance : '') + ' — ' + statStr(it) : label}"
      style="${it ? 'border-color:' + rc + '55;position:relative' : ''}">
      <div class="cell-icon">${it ? _itemIcon(it, 28) : iconHTML(emptyIcon, 22, '#6c6354')}</div>
      <div class="cell-lbl" style="${it ? 'color:' + rc : ''}">${it ? it.name : label}</div>
      ${enhBadge}
    </div>`;
  }).join('');

  const ov = document.createElement('div');
  ov.id = 'peer-profile-ov';
  ov.onclick = () => ov.remove();
  ov.style.cssText = 'position:fixed;inset:0;z-index:220;background:rgba(0,0,0,.75);backdrop-filter:blur(4px);display:flex;align-items:flex-end;justify-content:center;';
  ov.innerHTML = `<div onclick="event.stopPropagation()" style="width:100%;max-height:82vh;overflow-y:auto;background:#16120a;border-radius:18px 18px 0 0;border-top:1px solid rgba(209,204,197,.1);padding:18px 16px 30px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
      <div style="font-size:15px;font-weight:800;color:#90d653">${_escHtml(fromName || profile.name || '')}</div>
      <button onclick="document.getElementById('peer-profile-ov').remove()" style="width:28px;height:28px;border:none;border-radius:50%;background:rgba(209,204,197,.08);color:#968a7a;font-size:13px;cursor:pointer;">✕</button>
    </div>
    <div class="prof-hero">
      <div class="prof-emoji">${iconHTML(profile.charIcon, 40, profile.charColor)}</div>
      <div>
        <div class="prof-cls" style="color:${profile.charColor}">${profile.className}</div>
        <div class="prof-lvl">${tVars('charLevelFmt', { lvl: profile.lvl })}</div>
      </div>
    </div>
    <div class="stat-grid" style="margin-top:12px">
      <div class="stat-card"><div class="stat-ic">${iconHTML('heart',14,'#da4658')}</div><div class="stat-vl">${profile.hp}/${profile.maxHp}</div><div class="stat-nm">HP</div></div>
      <div class="stat-card"><div class="stat-ic">${iconHTML('sword',14,'#da952e')}</div><div class="stat-vl">${profile.atk}</div><div class="stat-nm">${t('clanPerkAtk')}</div></div>
      <div class="stat-card"><div class="stat-ic">${iconHTML('shield',14,'#d1aa65')}</div><div class="stat-vl">${profile.def}</div><div class="stat-nm">${t('statDef')}</div></div>
      <div class="stat-card"><div class="stat-ic">${iconHTML('lightning',14,'#e3941d')}</div><div class="stat-vl">${(profile.atkSpeed || 0).toFixed(2)}</div><div class="stat-nm">${t('statAtkSpeedAbbrev')}</div></div>
      <div class="stat-card"><div class="stat-ic">${iconHTML('star',14,'#da4658')}</div><div class="stat-vl">${fmt1(profile.critChance)}</div><div class="stat-nm">${t('statCritChance')}</div></div>
      <div class="stat-card"><div class="stat-ic">${iconHTML('flame',14,'#da952e')}</div><div class="stat-vl">${(profile.critPower || 0).toFixed(2)}x</div><div class="stat-nm">${t('statCritPower')}</div></div>
      <div class="stat-card"><div class="stat-ic">${iconHTML('hpPlus',14,'#79b644')}</div><div class="stat-vl">${(profile.hpRegen || 0).toFixed(2)}</div><div class="stat-nm">${t('statHpRegen')}</div></div>
      <div class="stat-card"><div class="stat-ic">${iconHTML('star',14,'#eaa742')}</div><div class="stat-vl">${profile.bm}</div><div class="stat-nm">${t('bmAbbrev')}</div></div>
    </div>
    <div style="font-size:12px;font-weight:700;color:#a2988a;margin:14px 0 8px">${t('peerEquipHdr')}</div>
    <div id="peer-eq-grid" class="eq-grid-5col">${eqCells}</div>
  </div>`;
  document.getElementById('app').appendChild(ov);
}

function updateProfileUI() {
  if (!player) return;
  const p = player, d = p.charDef;
  const th = getTheme(dungeonLvl);
  const pct = Math.floor(p.xp / p.xpNext * 100);
  const fmt1 = v => (v * 100).toFixed(1) + '%';
  document.getElementById('profile-body').innerHTML = `
    <div class="prof-hero">
      <div class="prof-emoji">${iconHTML(d.icon, 40, d.color)}</div>
      <div>
        <div class="prof-cls" style="color:${d.color}">${d.name}</div>
        <div class="prof-lvl">${tVars('charLevelFmt', { lvl: p.lvl })} · ${th.name}</div>
      </div>
    </div>
    <div class="xp-lbl">${tVars('xpFmt', { xp: Math.floor(p.xp), xpNext: p.xpNext })}</div>
    <div class="xp-bg"><div class="xp-fill" style="width:${pct}%"></div></div>
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-ic">${iconHTML('heart',14,'#da4658')}</div><div class="stat-vl">${Math.ceil(p.hp)}</div><div class="stat-nm">HP</div></div>
      <div class="stat-card"><div class="stat-ic">${iconHTML('sword',14,'#da952e')}</div><div class="stat-vl">${p.atk}</div><div class="stat-nm">${t('clanPerkAtk')}</div></div>
      <div class="stat-card"><div class="stat-ic">${iconHTML('shield',14,'#d1aa65')}</div><div class="stat-vl">${p.def}</div><div class="stat-nm">${t('statDef')}</div></div>
      <div class="stat-card"><div class="stat-ic">${iconHTML('lightning',14,'#e3941d')}</div><div class="stat-vl">${p.atkSpeed.toFixed(2)}</div><div class="stat-nm">${t('statAtkSpeedAbbrev')}</div></div>
      <div class="stat-card"><div class="stat-ic">${iconHTML('star',14,'#da4658')}</div><div class="stat-vl">${fmt1(p.critChance)}</div><div class="stat-nm">${t('statCritChance')}</div></div>
      <div class="stat-card"><div class="stat-ic">${iconHTML('flame',14,'#da952e')}</div><div class="stat-vl">${p.critPower.toFixed(2)}x</div><div class="stat-nm">${t('statCritPower')}</div></div>
      <div class="stat-card"><div class="stat-ic">${iconHTML('hpPlus',14,'#79b644')}</div><div class="stat-vl">${p.hpRegen.toFixed(2)}</div><div class="stat-nm">${t('statHpRegen')}</div></div>
    </div>`;
  updateUpgradeUI();
}

function updateUpgradeUI() {
  if (!player) return;
  const el = document.getElementById('upgrade-grid');
  if (!el) return;
  const goldLbl = document.getElementById('upg-gold-lbl');
  if (goldLbl) goldLbl.innerHTML = iconHTML('coin', 14, '#e3941d') + ' ' + player.gold;
  const availSP = getAvailableSkillPoints();
  const spLbl = document.getElementById('upg-sp-lbl');
  if (spLbl) spLbl.textContent = tVars('skillPointsFmt', { n: availSP });
  const u = player.upgrades || {};
  el.innerHTML = Object.entries(UPGRADE_DEF).map(([key, cfg]) => {
    const lvl  = u[key] || 0;
    // The price the server will actually charge — upgradeCost() is in
    // shared/definitions.js, so it is in this bundle's scope, and the
    // deduction bills from that same function (spendUpgrade, down through
    // server/db/repos/players.js). This line used to re-type the formula
    // as `300 * (lvl + 1)`. That is the same number only for as long as
    // nobody edits the shared one: the moment pricing moves, the button
    // keeps printing the old cost AND keeps enabling itself against it,
    // so the click leaves the device and comes back rejected — which
    // reads as "the upgrade button is broken", not as a stale copy of a
    // formula, and sends you looking in the wrong file.
    const cost = upgradeCost(lvl);
    const can  = player.gold >= cost && availSP >= 1;
    return `<div class="upg-row">
      <div class="upg-info">
        <span class="upg-label">${iconHTML(cfg.icon, 14, '#b2a58e')} ${cfg.label}</span>
        <span class="upg-meta">${t('levelAbbrev')}${lvl} · ${cfg.desc}</span>
      </div>
      <button class="upg-btn${can ? '' : ' disabled'}" onclick="upgradeStats('${key}')">
        ${iconHTML('coin',12,'#e3941d')}${cost} + 1 ${t('spAbbrev')}
      </button>
    </div>`;
  }).join('');

  const rw = document.getElementById('upg-reset-wrap');
  if (rw) {
    const spent = Object.values(u).reduce((s, v) => s + (v || 0), 0);
    const bal = window._nexumBalance || 0;
    const can = spent > 0 && bal >= UPGRADE_RESET_COST;
    rw.innerHTML = `
      <button class="upg-reset-btn${can ? '' : ' disabled'}" onclick="openUpgradeResetModal()">
        ${t('upgResetBtn')} · ${_nexumIconHtml(13)} ${UPGRADE_RESET_COST}
      </button>
      <div class="upg-reset-hint">${spent > 0
        ? tVars('upgResetHint', { n: spent })
        : t('upgResetNothing')}</div>`;
  }
}

// ─────────────────────────────────────────────────────────
//  UPGRADE RESET  (Улучшения → Сбросить, стоит Liberty)
// ─────────────────────────────────────────────────────────
function openUpgradeResetModal() {
  if (!player) return;
  const spent = Object.values(player.upgrades || {}).reduce((s, v) => s + (v || 0), 0);
  if (spent <= 0) return;
  const bal = window._nexumBalance || 0;
  if (bal < UPGRADE_RESET_COST) {
    dmgNum(player.x, player.y - 30, tVars('upgResetNeedFmt', { n: UPGRADE_RESET_COST }), '#f88');
    return;
  }
  const ov = document.createElement('div');
  ov.id = 'upg-reset-ov';
  ov.onclick = () => ov.remove();
  ov.style.cssText = 'position:fixed;inset:0;z-index:240;background:rgba(0,0,0,.75);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:20px;';
  ov.innerHTML = `<div onclick="event.stopPropagation()" style="width:100%;max-width:340px;background:#16120a;border-radius:16px;border:1px solid rgba(209,204,197,.12);padding:20px 18px;">
    <div style="font-size:16px;font-weight:800;color:#e5aa52;margin-bottom:10px">${t('upgResetTitle')}</div>
    <div style="font-size:13px;color:#a2988a;line-height:1.5;margin-bottom:16px">
      ${tVars('upgResetConfirm', { n: spent, cost: UPGRADE_RESET_COST })}
    </div>
    <div style="display:flex;gap:10px">
      <button onclick="document.getElementById('upg-reset-ov').remove()" style="
        flex:1;padding:11px;border:none;border-radius:10px;background:rgba(209,204,197,.07);
        color:#968a7a;font-size:14px;font-weight:600;cursor:pointer">${t('cancelBtn')}</button>
      <button onclick="_confirmUpgradeReset()" style="
        flex:1;padding:11px;border:none;border-radius:10px;
        background:linear-gradient(135deg,#4a3410,#6b4a17);color:#e5aa52;
        font-size:14px;font-weight:700;cursor:pointer">${t('upgResetGo')}</button>
    </div>
  </div>`;
  document.getElementById('app').appendChild(ov);
}

// ─────────────────────────────────────────────────────────
//  СМЕНА КЛАССА  (Профиль → Сменить класс, стоит Liberty)
// ─────────────────────────────────────────────────────────
// Окно устроено как сброс улучшений выше — та же цена в Liberty, то же
// подтверждение, — но говорит вслух ДВЕ вещи, которых там нет: снаряжение
// чужого класса снимется в инвентарь, а изученные навыки сбросятся. Человек
// должен знать это до нажатия, а не после.
function openClassChangeModal() {
  if (!player) return;
  const costLib = (typeof CLASS_CHANGE_FIRST_NEXUM !== 'undefined') ? CLASS_CHANGE_FIRST_NEXUM : 2000;
  const costGram = (typeof CLASS_CHANGE_GRAM !== 'undefined') ? CLASS_CHANGE_GRAM : 3;
  const bal = window._nexumBalance || 0;
  const gbal = window._gramBalance || 0;
  const cur = player.type;
  // Первая смена или нет. Число приходит от сервера (он считает его по журналу
  // движения денег), клиент только показывает то, что действительно можно.
  // Показывать Liberty на второй смене значит обещать то, в чём сервер
  // откажет — «после первой смены не пропадает возможность менять за Либерти».
  const isFirst = Number(player.classChanges || 0) === 0;

  // Смена требует, чтобы всё было снято. Считаем здесь, чтобы сказать это ДО
  // нажатия, а не отказом после.
  const wornNow = Object.values(player.equipment || {}).filter(Boolean).length;

  const classes = Object.keys(CHAR_DEF).filter(c => c !== cur).map(c => {
    const d = CHAR_DEF[c];
    return `<button onclick="_confirmClassChange('${c}')" style="
      display:flex;align-items:center;gap:10px;width:100%;margin-bottom:8px;padding:10px 12px;
      border:1px solid rgba(209,204,197,.14);border-radius:10px;background:rgba(209,204,197,.04);
      color:#d9cfbe;font-size:14px;font-weight:600;cursor:pointer;text-align:left">
      <span style="flex:1">${d.name}</span>
    </button>`;
  }).join('');

  const ov = document.createElement('div');
  ov.id = 'class-change-ov';
  ov.onclick = () => ov.remove();
  ov.style.cssText = 'position:fixed;inset:0;z-index:240;background:rgba(0,0,0,.75);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:20px;';
  ov.innerHTML = `<div onclick="event.stopPropagation()" style="width:100%;max-width:360px;background:#16120a;border-radius:16px;border:1px solid rgba(209,204,197,.12);padding:20px 18px;">
    <div style="font-size:16px;font-weight:800;color:#e5aa52;margin-bottom:10px">Смена класса</div>
    <div style="font-size:13px;color:#a2988a;line-height:1.5;margin-bottom:14px">
      <b style="color:#e0a24a">Снимите всю экипировку</b> — иначе смена не пройдёт.<br>
      Навыки и улучшения переносятся полностью.<br>
      Уровень, опыт, вещи, валюта и клан остаются.<br>
      ${isFirst
        ? `Первая смена — <b style="color:#e5aa52">${costLib}</b> Liberty (у вас ${bal})
           или <b style="color:#4fd67a">${costGram}</b> GRAM.`
        : `Стоит <b style="color:#4fd67a">${costGram}</b> GRAM (у вас ${gbal.toFixed(2)}).
           Бесплатная за Liberty была только первой.`}
    </div>
    ${wornNow > 0
      ? `<div style="font-size:12px;color:#eb4e61;margin-bottom:12px">Надето вещей: ${wornNow}. Снимите всё и вернитесь.</div>`
      : `${isFirst ? `<div style="display:flex;gap:8px;margin-bottom:10px">
          <button onclick="_setClassPay('nexum')" id="cc-pay-nexum" style="
            flex:1;padding:9px;border-radius:9px;border:1px solid rgba(229,170,82,.5);
            background:rgba(229,170,82,.12);color:#e5aa52;font-size:13px;font-weight:700;cursor:pointer">
            ${costLib} Liberty</button>
          <button onclick="_setClassPay('gram')" id="cc-pay-gram" style="
            flex:1;padding:9px;border-radius:9px;border:1px solid rgba(79,214,122,.35);
            background:rgba(209,204,197,.05);color:#4fd67a;font-size:13px;font-weight:700;cursor:pointer">
            ${costGram} GRAM</button>
         </div>
         <div style="font-size:11px;color:#7d7466;margin-bottom:10px">Выберите, чем платить, затем класс</div>` : ''}
         ${classes}`}
    <button onclick="document.getElementById('class-change-ov').remove()" style="
      width:100%;padding:11px;border:none;border-radius:10px;background:rgba(209,204,197,.07);
      color:#968a7a;font-size:14px;font-weight:600;cursor:pointer;margin-top:4px">${t('cancelBtn')}</button>
  </div>`;
  document.getElementById('app').appendChild(ov);
}

// Чем платить. Первая смена может пройти за Liberty; на всех следующих сервер
// возьмёт GRAM независимо от выбора — и скажет об этом, если GRAM не хватает.
let _classPay = 'nexum';
function _setClassPay(kind) {
  _classPay = kind;
  const a = document.getElementById('cc-pay-nexum');
  const b = document.getElementById('cc-pay-gram');
  if (a) a.style.background = kind === 'nexum' ? 'rgba(229,170,82,.12)' : 'rgba(209,204,197,.05)';
  if (b) b.style.background = kind === 'gram' ? 'rgba(79,214,122,.12)' : 'rgba(209,204,197,.05)';
}

function _confirmClassChange(type) {
  // На второй и дальше платить можно только GRAM — выбора нет, и клиент его
  // не предлагает. Отправляем то же, что решит сервер, чтобы отказ не пришёл
  // из-за расхождения.
  if (Number((player && player.classChanges) || 0) > 0) _classPay = 'gram';
  const ov = document.getElementById('class-change-ov');
  if (ov) ov.remove();
  if (typeof netChangeClass === 'function') netChangeClass(type, _classPay);
}

function onClassChanged(from, to) {
  // ── игра перезагружается ────────────────────────────────────────────────
  // Смена класса меняет слишком многое, чтобы дособирать это по частям:
  // спрайты персонажа, набор умений, панель профессии, то, что можно надеть.
  // Прежняя версия обновляла три панели и оставляла остальное как было —
  // «немного неточности, нужно обновить вручную».
  //
  // Перезагрузка честнее любой досборки: клиент возвращается с полным
  // состоянием от сервера. Секунда задержки — чтобы человек успел прочитать,
  // что смена прошла.
  const name = (CHAR_DEF[to] && CHAR_DEF[to].name) || to;
  if (player) dmgNum(player.x, player.y - 30, 'Класс: ' + name, '#98e456');
  if (typeof _marketToast === 'function') {
    _marketToast('Класс изменён: ' + name + ' — перезагружаю', 'ok');
  }
  setTimeout(() => { location.reload(); }, 1200);
}

function _confirmUpgradeReset() {
  const ov = document.getElementById('upg-reset-ov');
  if (ov) ov.remove();
  if (typeof netResetUpgrades === 'function') netResetUpgrades();
}

function onUpgradesReset(pointsReturned) {
  if (typeof updateUpgradeUI === 'function') updateUpgradeUI();
  if (typeof updateProfileUI === 'function') updateProfileUI();
  if (typeof updateInvUI === 'function') updateInvUI();
  if (player) dmgNum(player.x, player.y - 30, tVars('upgResetDone', { n: pointsReturned }), '#98e456');
}

function onUpgradesResetError(msg) {
  if (player) dmgNum(player.x, player.y - 30, msg || t('genericErrorLbl'), '#f88');
}

// ── определение предмета по id, из ЛЮБОГО каталога ────────────────────────
// Каталогов три и они не пересекаются: ITEM_DEF — снаряжение и зелья,
// CRAFT_MATS — материалы, книги и камни заточки, BOX_DEF — сундуки. Искать в
// одном ITEM_DEF значит молча не найти половину: список награды «Письма»
// на первом заходе показал шесть зелий и ни одной заточки и ни одного
// сундука — ровно потому, что они лежат в двух других.
function _anyItemDef(id) {
  return (typeof ITEM_DEF !== 'undefined' && ITEM_DEF.find(d => d.id === id))
      || (typeof CRAFT_MATS !== 'undefined' && CRAFT_MATS.find(d => d.id === id))
      || (typeof BOX_DEF !== 'undefined' && BOX_DEF.find(d => d.id === id))
      || null;
}

// ─────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────
//  EMPOWER  (Персонаж → Усиление)
//  EMPOWER_LEVEL/EMPOWER_BONUS_SP/EMPOWER_COST/EMPOWER_TIERS live in
//  shared/definitions.js — the server's own empower handler
//  (server/handlers2/progression.js) reads the SAME functions, so the
//  requirement, the price and the cap shown here can never drift from what
//  actually gets charged and granted.
// ─────────────────────────────────────────────────────────
function _empowerCostDef(id) { return _anyItemDef(id); }
// dungeonLvl === 1 is the hub — server/game/floors.js's FLOOR_IDS.hub, which
// the client never imports (it's server-only), so this mirrors that literal
// the same way _resumeSameFloor (js/network.js) already compares dungeonLvl
// against a raw floor id. The server's own empower handler enforces the real
// gate (currentFloor !== FLOOR_IDS.hub); this is only what disables the
// button so a player isn't sent to the confirm dialog just to have the
// server refuse it a moment later.
function _inHub() { return dungeonLvl === 1; }
function _empowerReady() {
  if (!player) return false;
  if (!_inHub()) return false;
  if ((player.lvl || 1) < EMPOWER_LEVEL) return false;
  // Потолок: тридцатое усиление — последнее, за ним у лестницы цен ничего
  // нет. Сервер откажет и так, но кнопка не должна вести в диалог, который
  // заведомо кончится отказом.
  if ((player.empowers || 0) >= EMPOWER_MAX) return false;
  return Object.entries(empowerCostFor(player.empowers || 0)).every(([id, need]) => countMaterial(id) >= need);
}

// One reward row — icon + label — shared by every shop/reward panel below
// (empower cost, VIP tiers, GRAM packs, season packs). It was copy-pasted as a
// local `ri()` inside five of them, which is how the same markup ended up
// maintained in five places at once.
function ri(img, label, cls) {
  return `<div class="vip-ri${cls ? ' vip-ri-' + cls : ''}"><img class="vip-ri-img" src="${img}"><span class="vip-ri-label">${label}</span></div>`;
}

function updateEmpowerUI() {
  if (!player) return;
  const el = document.getElementById('empower-body');
  if (!el) return;
  const lvlOk = (player.lvl || 1) >= EMPOWER_LEVEL;
  const done = player.empowers || 0;
  const nextN = done + 1;
  const capped = done >= EMPOWER_MAX;
  // Множитель берётся из той же функции, что и цена, а не пересчитывается
  // здесь по «каждое пятое ×2»: это правило больше не действует, цена растёт
  // по диапазонам и держится до конца каждого.
  const mult = capped ? 0 : empowerMultFor(nextN);
  const rows = Object.entries(empowerCostFor(done)).map(([id, need]) => {
    const def = _empowerCostDef(id);
    const have = countMaterial(id);
    const ok = have >= need;
    const label = `<span style="color:${ok ? '#98e456' : '#f88'}">${have}/${need}</span>`;
    return ri(def ? def.img : '', label, '');
  }).join('');
  const ready = _empowerReady();
  const multHint = (!capped && mult > 1)
    ? `<div style="padding:0 12px 10px;font-size:12.5px;font-weight:700;color:#eb4e61">${tVars('empowerMultFmt', { n: nextN, mult })}</div>`
    : '';
  const capHint = capped
    ? `<div style="padding:0 12px 10px;font-size:12.5px;font-weight:700;color:#eb4e61">${tVars('empowerCapFmt', { max: EMPOWER_MAX })}</div>`
    : '';
  const hubHint = _inHub() ? '' :
    `<div style="padding:0 12px 10px;font-size:12.5px;font-weight:700;color:#f88">${t('empowerNeedHubLbl')}</div>`;

  el.innerHTML = `
    <div class="sec-title">${t('empowerTabLbl')}</div>
    <div style="padding:0 12px 10px;font-size:12.5px;color:#a2988a;line-height:1.55">${t('empowerDesc')}</div>
    <div style="padding:0 12px 12px;font-size:13px;font-weight:700;color:${lvlOk ? '#98e456' : '#f88'}">
      ${tVars('empowerLevelReqFmt', { lvl: EMPOWER_LEVEL, cur: player.lvl || 1 })}
    </div>
    ${hubHint}
    ${capHint}
    ${multHint}
    <div class="vip-items-row" style="padding:0 12px">${rows}</div>
    <div style="padding:16px 12px 20px">
      <button class="upg-reset-btn${ready ? '' : ' disabled'}" onclick="${ready ? 'openEmpowerConfirm()' : ''}">
        ${t('empowerBtn')}
      </button>
      <div class="upg-reset-hint">${tVars('empowerCountFmt', { n: done, max: EMPOWER_MAX })}</div>
    </div>`;
}

function openEmpowerConfirm() {
  if (!_empowerReady()) return;
  const existing = document.getElementById('empower-confirm-ov');
  if (existing) existing.remove();
  const ov = document.createElement('div');
  ov.id = 'empower-confirm-ov';
  ov.onclick = () => ov.remove();
  ov.style.cssText = 'position:fixed;inset:0;z-index:240;background:rgba(0,0,0,.75);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:20px;';
  ov.innerHTML = `<div onclick="event.stopPropagation()" style="width:100%;max-width:340px;background:#16120a;border-radius:16px;border:1px solid rgba(209,204,197,.12);padding:20px 18px;">
    <div style="font-size:16px;font-weight:800;color:#e5aa52;margin-bottom:10px">${t('empowerConfirmTitle')}</div>
    <div style="font-size:13px;color:#a2988a;line-height:1.5;margin-bottom:16px">${t('empowerConfirmBody')}</div>
    <div style="display:flex;gap:10px">
      <button onclick="document.getElementById('empower-confirm-ov').remove()" style="
        flex:1;padding:11px;border:none;border-radius:10px;background:rgba(209,204,197,.07);
        color:#968a7a;font-size:14px;font-weight:600;cursor:pointer">${t('cancelBtn')}</button>
      <button onclick="_confirmEmpower()" style="
        flex:1;padding:11px;border:none;border-radius:10px;
        background:linear-gradient(135deg,#4a3410,#6b4a17);color:#e5aa52;
        font-size:14px;font-weight:700;cursor:pointer">${t('empowerGo')}</button>
    </div>
  </div>`;
  document.getElementById('app').appendChild(ov);
}

function _confirmEmpower() {
  const ov = document.getElementById('empower-confirm-ov');
  if (ov) ov.remove();
  if (typeof netEmpower === 'function') netEmpower();
}

function onEmpowerDone() {
  if (typeof updateEmpowerUI === 'function') updateEmpowerUI();
  if (typeof updateUpgradeUI === 'function') updateUpgradeUI();
  if (typeof updateProfileUI === 'function') updateProfileUI();
  if (typeof updateInvUI === 'function') updateInvUI();
  if (player) dmgNum(player.x, player.y - 30, t('empowerDoneToast'), '#98e456');
}

function onEmpowerError(msg) {
  if (player) dmgNum(player.x, player.y - 30, msg || t('genericErrorLbl'), '#f88');
}

// ─────────────────────────────────────────────────────────
//  SKILL UPGRADE UI
// ─────────────────────────────────────────────────────────
function _skillBonusDesc(type, level) {
  if (level <= 0) return null;
  switch (type) {
    case 'damage':   return `+${level}% ${t('bonusToDamage')}`;
    case 'buff':     return `+${level}${t('bonusToDuration')}`;
    case 'heal':     return `+${level}% ${t('bonusToHeal')}`;
    case 'mobility': return `+${level * 10}${t('bonusToRange')}`;
    default:         return null;
  }
}

function _skillBonusTypeLabel(type) {
  switch (type) {
    case 'damage':   return t('bonusTypeDamage');
    case 'buff':     return t('bonusTypeBuff');
    case 'heal':     return t('bonusTypeHeal');
    case 'mobility': return t('bonusTypeMobility');
    default:         return '';
  }
}

// Costs and book ids now live in shared/definitions.js — the server charges
// and rolls them itself, so both sides have to read one copy.
function _skillBookId(cls, key) { return skillBookId(cls, key); }
function _skillBookDef(cls, key) {
  return CRAFT_MATS.find(m => m.id === _skillBookId(cls, key));
}

// ── Advanced skills ("вторая профессия") ─────────────────────────────────
// Separate book pool/id space from the regular skill books above — see
// ADV_SKILL_DEF (js/definitions.js) and _ADV_SKILL_BOOK_SRC (shared/
// definitions.js). One-time unlock (ADV_SKILL_STUDY_COST), then a free
// toggle (toggleAdvSkill) between base/advanced for that slot — see
// _activeSkillDef/useSkill, js/player.js.
function _advSkillBookId(cls, key) { return advSkillBookId(cls, key); }
function _advSkillBookDef(cls, key) {
  return CRAFT_MATS.find(m => m.id === _advSkillBookId(cls, key));
}

// Drives the Профессия HUD button's glow (drawProfessionButton, below) —
// true once at least one Q/W/E/R slot is maxed and its book is in hand but
// not yet learned, same "something to claim" signal as other HUD badges.
function _professionHasReady() {
  if (!player) return false;
  const skills = SKILL_DEF[player.type];
  if (!skills) return false;
  const sl = player.skillLevels || {};
  const al = player.advSkillLearned || {};
  return skills.some(sk => (sl[sk.key] || 0) >= 10 && !al[sk.key] &&
    countMaterial(_advSkillBookId(player.type, sk.key)) >= ADV_SKILL_STUDY_COST);
}

function updateSkillsUI() {
  if (!player) return;
  const el = document.getElementById('skill-upgrade-panel');
  if (!el) return;
  const skills = SKILL_DEF[player.type];
  if (!skills) { el.innerHTML = `<div style="padding:16px;color:#645f57;text-align:center">${t('selectCharacterHint')}</div>`; return; }
  const bonusTypes = (SKILL_BONUS_TYPE || {})[player.type] || {};
  const sl = player.skillLevels || {};

  el.innerHTML = `
    <div class="skill-upg-header">
      <span>${iconHTML('book', 13, '#e3941d')} ${t('skillBooksHdr')}</span>
      <span class="skill-upg-hint">${tVars('studyUpgradeHintFmt', { a: SKILL_STUDY_COST, b: SKILL_UPGRADE_COST, c: Math.round(SKILL_UPGRADE_CHANCE * 100) })}</span>
    </div>
    <!-- Second way into the auto-cast picker. The first is holding the AUTO
         button on the HUD, which nobody finds without being told. -->
    <button onclick="openAutoSkillsPicker()" style="
      width:100%;margin-bottom:10px;padding:10px;border:1px solid rgba(143,214,82,0.25);border-radius:10px;
      background:rgba(143,214,82,0.08);color:#90d653;font-size:12.5px;font-weight:700;cursor:pointer;
    ">${t('autoModeAbbrev')} · ${t('autoSkillsOpenBtn')}
      <div style="font-size:10px;color:#72685a;font-weight:400;margin-top:3px">${t('autoSkillsHoldHint')}</div>
    </button>
    ${skills.map(sk => {
      const level = sl[sk.key] || 0;
      const locked = level <= 0;
      const maxed = level >= 10;
      const bonusType = bonusTypes[sk.key] || 'damage';
      const bonusNow  = locked ? null : _skillBonusDesc(bonusType, level);
      const bonusNext = (locked || maxed) ? null : _skillBonusDesc(bonusType, level + 1);
      const bookId = _skillBookId(player.type, sk.key);
      const bookName = (_skillBookDef(player.type, sk.key) || {}).name || t('skillBookFallback');
      const bookCount = countMaterial(bookId);

      const dots = Array.from({ length: 10 }, (_, i) =>
        `<span class="sk-dot${i < level ? ' filled' : ''}"></span>`
      ).join('');

      // Book-framed icon — the skill's own icon/art nested inside the book
      // glyph, so each skill's book is visually identifiable at a glance.
      const skillGlyph = sk.img
        ? `<img src="${sk.img}" width="15" height="15" style="image-rendering:pixelated;border-radius:2px">`
        : iconHTML(sk.icon, 15, locked ? '#645f57' : '#e3941d');
      const iconEl = `<div style="position:relative;width:26px;height:26px;opacity:${locked ? 0.4 : 1}">
        ${iconHTML('book', 26, locked ? '#645f57' : '#c48a3a')}
        <div style="position:absolute;left:50%;top:46%;transform:translate(-50%,-50%)">${skillGlyph}</div>
      </div>`;

      let btnLabel, btnAction, btnDisabled;
      if (locked) {
        btnDisabled = bookCount < SKILL_STUDY_COST;
        btnLabel = iconHTML('book', 12, '#e3941d') + ` ${SKILL_STUDY_COST} · ${tVars('studyBtnFmt', { n: bookCount })}`;
        btnAction = `studySkill('${sk.key}')`;
      } else if (maxed) {
        btnDisabled = true;
        btnLabel = t('maxLbl');
        btnAction = '';
      } else {
        btnDisabled = bookCount < SKILL_UPGRADE_COST;
        btnLabel = iconHTML('book', 12, '#e3941d') + ` ${SKILL_UPGRADE_COST} · ${tVars('upgradeBtnFmt', { pct: Math.round(SKILL_UPGRADE_CHANCE * 100), n: bookCount })}`;
        btnAction = `upgradeSkillWithBook('${sk.key}')`;
      }

      // Advanced skill ("вторая профессия") — only ever shown once this slot
      // itself is maxed (level 10). Learning is a one-time book spend
      // (dropped only in the Фарм-зона, see FARM_ADV_SKILL_BOOK_CHANCE); once
      // learned, advActive is a free toggle — see toggleAdvSkill below.
      let advHtml = '';
      if (maxed) {
        const adv = ((typeof ADV_SKILL_DEF !== 'undefined' && ADV_SKILL_DEF[player.type]) || []).find(a => a.key === sk.key);
        if (adv) {
          const advLearned = !!(player.advSkillLearned || {})[sk.key];
          const advActive  = !!(player.advSkillActive  || {})[sk.key];
          const advBookId  = _advSkillBookId(player.type, sk.key);
          const advBookName = (_advSkillBookDef(player.type, sk.key) || {}).name || t('skillBookFallback');
          const advBookCount = countMaterial(advBookId);
          const advGlyph = adv.img
            ? `<img src="${adv.img}" width="15" height="15" style="image-rendering:pixelated;border-radius:2px">`
            : iconHTML(adv.icon, 15, '#f5c542');
          const advIconEl = `<div style="position:relative;width:26px;height:26px">
            ${iconHTML('book', 26, '#f5c542')}
            <div style="position:absolute;left:50%;top:46%;transform:translate(-50%,-50%)">${advGlyph}</div>
          </div>`;
          let advBtnLabel, advBtnAction, advBtnDisabled;
          if (!advLearned) {
            advBtnDisabled = advBookCount < ADV_SKILL_STUDY_COST;
            advBtnLabel = iconHTML('book', 12, '#f5c542') + ` ${ADV_SKILL_STUDY_COST} · ${tVars('advStudyBtnFmt', { n: advBookCount })}`;
            advBtnAction = `learnAdvSkill('${sk.key}')`;
          } else {
            advBtnDisabled = false;
            advBtnLabel = advActive ? t('advSwitchToBaseBtn') : t('advSwitchToAdvBtn');
            advBtnAction = `toggleAdvSkill('${sk.key}')`;
          }
          advHtml = `<div class="adv-skill-box${advActive ? ' active' : ''}">
            <div class="adv-skill-hdr">${iconHTML('star', 11, '#f5c542')} ${t('advSkillHdr')}${advActive ? `<span class="adv-skill-active-badge">${t('advActiveLbl')}</span>` : ''}</div>
            <div class="skill-upg-top">
              <div class="skill-upg-icon" style="position:relative">
                ${advIconEl}
                ${!advLearned ? `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">${iconHTML('lock', 15, '#d1ccc5')}</div>` : ''}
              </div>
              <div class="skill-upg-info">
                <div class="skill-upg-name" style="color:#f5c542">${adv.name}</div>
                <div class="skill-upg-desc">${adv.desc}</div>
                <div class="skill-upg-type">${!advLearned ? advBookName : ''}</div>
              </div>
            </div>
            <button class="skill-upg-btn adv-btn${advBtnDisabled ? ' disabled' : ''}" onclick="${advBtnAction}">${advBtnLabel}</button>
          </div>`;
        }
      }

      return `<div class="skill-upg-card">
        <div class="skill-upg-top">
          <div class="skill-upg-icon" style="position:relative">
            ${iconEl}
            ${locked ? `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">${iconHTML('lock', 15, '#d1ccc5')}</div>` : ''}
          </div>
          <div class="skill-upg-info">
            <div class="skill-upg-name">${sk.name}<span class="skill-upg-lvl">${locked ? ' 🔒 ' + t('notStudiedLbl') : maxed ? ' ' + t('maxAbbrev') : ' ' + t('levelAbbrev') + level}</span></div>
            <div class="skill-upg-desc">${sk.desc}</div>
            <div class="skill-upg-type">${locked ? bookName : _skillBonusTypeLabel(bonusType)}</div>
          </div>
        </div>
        ${!locked ? `<div class="sk-dots">${dots}</div>` : ''}
        ${!locked ? `<div class="sk-bonus-row">
          ${bonusNow ? `<span class="sk-bonus-now">${bonusNow}</span>` : ''}
          ${bonusNext ? `<span class="sk-bonus-next">→ ${bonusNext}</span>` : ''}
        </div>` : ''}
        <button class="skill-upg-btn${btnDisabled ? ' disabled' : ''}" onclick="${btnAction}">${btnLabel}</button>
        ${advHtml}
      </div>`;
    }).join('')}
  `;
}

// ── Learning and upgrading ──────────────────────────────────────────────────
// These five used to do the whole thing locally: check the books, remove them,
// roll the chance, write the new level and let the next debounced save carry
// it. That made the level a client-authored value, which is what let a stale
// save roll a studied passive back — and let a modified client write itself max
// levels outright.
//
// They are requests now. The server counts the books out of its own copy,
// rolls the chance itself, and answers with progressSync (the new levels) and
// inventorySync (the books it spent); upgradeRolled carries the success/failure
// so the same floating text still plays. Nothing is applied here — see the
// progressSync handler in js/network.js.
//
// The local pre-checks that remain are UI courtesy, not rules: they keep the
// button from sending a request the server will obviously refuse. Every one of
// them is enforced again server-side.
function studySkill(key) {
  if (!player) return;
  const sl = player.skillLevels || {};
  if ((sl[key] || 0) > 0) return;
  if (countMaterial(_skillBookId(player.type, key)) < SKILL_STUDY_COST) {
    dmgNum(player.x, player.y - 30, t('needSkillBookToast'), '#f17e8b');
    return;
  }
  netLearnSkill(key);
}

function upgradeSkillWithBook(key) {
  if (!player) return;
  const sl = player.skillLevels || {};
  const lvl = sl[key] || 0;
  if (lvl <= 0) { dmgNum(player.x, player.y - 30, t('studySkillFirstToast'), '#f17e8b'); return; }
  if (lvl >= SKILL_MAX_LEVEL) return;
  if (countMaterial(_skillBookId(player.type, key)) < SKILL_UPGRADE_COST) {
    dmgNum(player.x, player.y - 30, tVars('needNSkillBooksFmt', { n: SKILL_UPGRADE_COST }), '#f17e8b');
    return;
  }
  netUpgradeSkill(key);
}

// ── Advanced skills ("вторая профессия") ─────────────────────────────────
function learnAdvSkill(key) {
  if (!player) return;
  const sl = player.skillLevels || {};
  if ((sl[key] || 0) < SKILL_MAX_LEVEL) return;   // this slot isn't maxed yet
  if ((player.advSkillLearned || {})[key]) return;
  if (countMaterial(_advSkillBookId(player.type, key)) < ADV_SKILL_STUDY_COST) {
    dmgNum(player.x, player.y - 30, t('needAdvSkillBookToast'), '#f17e8b');
    return;
  }
  netLearnAdvSkill(key);
}

// Free toggle between a slot's base and advanced version — no cost either
// direction, only gated on having learned it (learnAdvSkill above). Shares
// the same cooldown/level as the base skill (see _activeSkillDef, js/
// player.js), so switching mid-fight never resets or dodges a cooldown.
//
// Still a request rather than a local flip: this is what decides which
// variant's damage the SERVER applies (_skillMultFor, server/game/Room.js), so
// its copy is the one that has to change.
function toggleAdvSkill(key) {
  if (!player) return;
  if (!(player.advSkillLearned || {})[key]) return;
  netToggleAdvSkill(key);
}

// ─────────────────────────────────────────────────────────
//  ПРОФЕССИЯ PANEL — full-screen codex reached from the HUD button below
//  Мир/ПК (drawProfessionButton, getProfessionBtnPos). Re-presents the same
//  underlying state as the Character→Skills tab's adv-skill-box (SKILL_DEF,
//  ADV_SKILL_DEF, player.skillLevels/advSkillLearned/advSkillActive) as one
//  standalone "what I have → what I'll get" page instead of one box per card
//  buried in the upgrade list — same data, same learnAdvSkill/toggleAdvSkill
//  actions, just laid out to actually show off the transformation.
function openProfessionPanel() {
  const panel = document.getElementById('profession-panel');
  if (!panel || !player) return;
  panel.style.display = 'flex';
  renderProfessionPanel();
}

function closeProfessionPanel() {
  const panel = document.getElementById('profession-panel');
  if (panel) panel.style.display = 'none';
}

function _refreshProfessionPanelIfOpen() {
  const panel = document.getElementById('profession-panel');
  if (panel && panel.style.display !== 'none') renderProfessionPanel();
}

function renderProfessionPanel() {
  const body = document.getElementById('profession-panel-body');
  if (!body || !player) return;
  const skills = SKILL_DEF[player.type];
  if (!skills) { body.innerHTML = ''; return; }
  const advSkills = (typeof ADV_SKILL_DEF !== 'undefined' && ADV_SKILL_DEF[player.type]) || [];
  const cc = _FARM_ADV_BOOK_CLASS_COLOR[player.type] || '#cdb8ec';
  const sl = player.skillLevels || {};
  const al = player.advSkillLearned || {};
  const aa = player.advSkillActive || {};
  const cls = (typeof CHAR_DEF !== 'undefined' ? CHAR_DEF[player.type] : null) || {};

  const cards = skills.map(sk => {
    const level = sl[sk.key] || 0;
    const maxed = level >= 10;
    const adv = advSkills.find(a => a.key === sk.key);
    const learned = !!al[sk.key];
    const active = !!aa[sk.key];
    const advBookCount = countMaterial(_advSkillBookId(player.type, sk.key));

    // 0 = slot not maxed yet, 1 = maxed but missing books, 2 = maxed & ready
    // to learn, 3 = learned (free toggle from here on).
    const stage = !maxed ? 0 : learned ? 3 : (advBookCount >= ADV_SKILL_STUDY_COST ? 2 : 1);

    const baseGlyph = sk.img
      ? `<img src="${sk.img}" class="profp-icon-img" alt="">`
      : iconHTML(sk.icon, 22, '#e3941d');
    const advGlyph = adv
      ? (adv.img ? `<img src="${adv.img}" class="profp-icon-img" alt="">` : iconHTML(adv.icon, 22, cc))
      : '';

    let stateHtml;
    if (stage === 0) {
      stateHtml = `<div class="profp-lockrow">${iconHTML('lock', 12, '#645f57')} ${tVars('profpLockedFmt', { n: level })}</div>`;
    } else if (stage === 1) {
      stateHtml = `<div class="profp-lockrow">${iconHTML('book', 12, '#a58fc4')} ${tVars('profpNeedBooksFmt', { have: advBookCount, need: ADV_SKILL_STUDY_COST })}</div>`;
    } else if (stage === 2) {
      stateHtml = `<button class="profp-learn-btn" onclick="learnAdvSkill('${sk.key}')">${iconHTML('star', 12, '#150f08')} ${t('profpLearnBtn')}</button>`;
    } else {
      stateHtml = `<div class="profp-toggle" onclick="toggleAdvSkill('${sk.key}')">
        <span class="profp-toggle-opt${!active ? ' on' : ''}">${sk.name}</span>
        <span class="profp-toggle-switch${active ? ' adv' : ''}" style="--cc:${cc}"><span class="profp-toggle-knob"></span></span>
        <span class="profp-toggle-opt${active ? ' on' : ''}" style="--cc:${cc}">${adv ? adv.name : ''}</span>
      </div>`;
    }

    return `
      <div class="profp-card${stage === 3 ? ' learned' : ''}" style="--cc:${cc}">
        <div class="profp-card-key">${sk.key}</div>
        <div class="profp-flow">
          <div class="profp-node">
            <div class="profp-node-icon">${baseGlyph}</div>
            <div class="profp-node-name">${sk.name}</div>
            <div class="profp-bar"><div class="profp-bar-fill" style="width:${Math.min(100, level * 10)}%"></div></div>
          </div>
          <div class="profp-connector">
            <span class="profp-fx profp-fx-${stage === 3 ? 'pulse' : 'classic'}" style="--fx:${stage >= 1 ? cc : '#4a4438'}"></span>
          </div>
          <div class="profp-node adv">
            <div class="profp-node-icon${stage < 3 ? ' dim' : ''}">${advGlyph}${stage < 3 ? `<div class="profp-node-lockbadge">${iconHTML('lock', 10, '#d1ccc5')}</div>` : ''}</div>
            <div class="profp-node-name" style="color:${stage === 3 ? cc : '#8a8070'}">${adv ? adv.name : ''}</div>
          </div>
        </div>
        <div class="profp-descs">
          <div class="profp-desc-row${stage === 3 && active ? ' dim' : ''}">
            <span class="profp-desc-tag">${t('profpNowLbl')}</span>${sk.desc}
          </div>
          ${adv ? `<div class="profp-desc-row${stage === 3 && active ? ' lit' : ''}" style="--cc:${cc}">
            <span class="profp-desc-tag">${t('profpWillBeLbl')}</span>${adv.desc}
          </div>` : ''}
        </div>
        ${stateHtml}
      </div>`;
  }).join('');

  body.innerHTML = `
    <div class="profp-banner" style="--cc:${cc}">
      <div class="profp-banner-icon">${iconHTML(cls.icon || 'star', 24, cc)}</div>
      <div>
        <div class="profp-banner-cls">${cls.name || ''}</div>
        <div class="profp-banner-sub">${t('profpBannerSub')}</div>
      </div>
    </div>
    <div class="profp-cards">${cards}</div>
    <div class="profp-hint">${t('profpFarmHint')}</div>
    ${/* Кнопки смены класса здесь БОЛЬШЕ НЕТ: она переехала на экран, под
         «Проф» (drawClassChangeButton). Внутри панели это было два нажатия и
         место, где её никто не искал. */ ''}
  `;
}

// ─────────────────────────────────────────────────────────
//  CODEX PANEL — L2M/Night Crow-style item collections. Each of CODEX_SETS
//  (shared/definitions.js, ~1000 generated entries) needs 2-4 specific items,
//  each at its own minimum enchant level, consumed one at a time into that
//  set's slots; completing every slot folds the set's flat stat bonus into
//  player.codexBonus forever. The server owns all progress and the resulting
//  bonus (registerCodexSetItem/codexSync, server/index.js) — this only
//  renders what arrived and asks for a change (tryFillCodexSlot below).
// ─────────────────────────────────────────────────────────
let _codexFilters = { q: '', cls: 'all', rarity: 'all', status: 'all' };
const _CODEX_PAGE = 40;
let _codexShown = _CODEX_PAGE;

function openCodexPanel() {
  const panel = document.getElementById('codex-panel');
  if (!panel || !player) return;
  panel.style.display = 'flex';
  renderCodexPanel();
}

function closeCodexPanel() {
  const panel = document.getElementById('codex-panel');
  if (panel) panel.style.display = 'none';
}

function _refreshCodexPanelIfOpen() {
  const panel = document.getElementById('codex-panel');
  if (panel && panel.style.display !== 'none') renderCodexPanel();
}

function _codexSetDone(set, filled) {
  return Array.isArray(filled) && filled.length === set.slots.length && filled.every(Boolean);
}

// Does this (not-yet-complete) set have at least one unfilled slot the
// inventory can fill RIGHT NOW — the same {itemId, minEnhance} match
// tryFillCodexSlot uses (codexItemMeetsReq, shared/definitions.js). These
// are the sets a player can act on immediately, so they're worth surfacing
// above ones that still need farming.
function _codexSetHasReadySlot(set, filled, inv) {
  if (_codexSetDone(set, filled)) return false;
  return set.slots.some((req, i) => !(filled && filled[i]) &&
    inv.some(it => typeof codexItemMeetsReq === 'function' && codexItemMeetsReq(it, req)));
}

// Filtered + sorted view over CODEX_SETS: sets with an immediately-fillable
// slot surface first (there's something to DO right now), then sets with
// progress but nothing ready, then completed ones sink to the bottom since
// there's nothing left to do with them.
function _codexSetsFiltered() {
  if (typeof CODEX_SETS === 'undefined') return [];
  const { q, cls, rarity, status } = _codexFilters;
  const qLower = q.trim().toLowerCase();
  const codex = (player && player.codex) || {};
  const inv = (player && player.inventory) || [];
  const filtered = CODEX_SETS.filter(set => {
    // Class-agnostic sets (universal armor combos) pass every class filter
    // — they're not the pursuit of one class over another, so narrowing to
    // "Танк" shouldn't hide them, only the OTHER classes' own weapon sets.
    if (cls !== 'all' && set.cls && set.cls !== cls) return false;
    if (rarity !== 'all' && set.rarity !== rarity) return false;
    if (qLower && !set.name.toLowerCase().includes(qLower)) return false;
    const filled = codex[set.id];
    const doneCount = Array.isArray(filled) ? filled.filter(Boolean).length : 0;
    const done = _codexSetDone(set, filled);
    if (status === 'progress' && (doneCount === 0 || done)) return false;
    if (status === 'done' && !done) return false;
    return true;
  });
  // Readiness is computed once per set here rather than inline in the
  // comparator below — the comparator runs O(n log n) times during sort,
  // and re-scanning the whole inventory per slot on every one of those
  // calls would be needlessly quadratic.
  const readyById = new Map(filtered.map(set => [set.id, _codexSetHasReadySlot(set, codex[set.id], inv)]));
  return filtered.sort((a, b) => {
    const readyA = readyById.get(a.id), readyB = readyById.get(b.id);
    if (readyA !== readyB) return readyA ? -1 : 1;
    const fa = codex[a.id], fb = codex[b.id];
    const da = Array.isArray(fa) ? fa.filter(Boolean).length : 0;
    const db = Array.isArray(fb) ? fb.filter(Boolean).length : 0;
    const doneA = _codexSetDone(a, fa), doneB = _codexSetDone(b, fb);
    if (doneA !== doneB) return doneA ? 1 : -1;
    if (da !== db) return db - da;
    return 0;
  });
}

function _codexSetFilter(key, val) {
  _codexFilters[key] = val;
  _codexShown = _CODEX_PAGE;
  renderCodexPanel();
}

function _codexShowMore() {
  _codexShown += _CODEX_PAGE;
  renderCodexPanel();
}

// Tries to fill one slot of one set from whatever's in the inventory right
// now. Confirmed client-side purely so a misclick doesn't destroy an item —
// the server re-checks the item/enchant match and slot availability itself
// regardless. When nothing in the inventory qualifies, this just tells the
// player exactly what the slot still needs instead of failing silently.
function tryFillCodexSlot(setId, slotIdx) {
  if (!player || typeof codexSetById !== 'function') return;
  const set = codexSetById(setId);
  if (!set) return;
  const req = set.slots[slotIdx];
  if (!req) return;
  const idx = (player.inventory || []).findIndex(it => typeof codexItemMeetsReq === 'function' && codexItemMeetsReq(it, req));
  if (idx < 0) {
    const base = typeof itemCatalogBase === 'function' ? itemCatalogBase(req.itemId) : null;
    const label = base ? base.name : req.itemId;
    const msg = `Нужен «${label}» ровно +${req.minEnhance}`;
    if (typeof _marketToast === 'function') _marketToast(msg, 'err');
    return;
  }
  const it = player.inventory[idx];
  if (!confirm(`Внести «${it.name}${it.enhance ? ' +' + it.enhance : ''}» в набор «${set.name}»? Предмет будет уничтожен без возврата.`)) return;
  // The confirmation above names this exact item and warns it will be
  // destroyed without return. Sending only the index means the server destroys
  // whatever sits at that position when the message ARRIVES — and a kill or a
  // pickup between the dialog opening and the click renumbers the list. The
  // row id names the item the player actually agreed to lose.
  netRegisterCodexSetItem(setId, slotIdx, idx, it);
}

function _codexSetRowHtml(set) {
  const codex = (player && player.codex) || {};
  const filled = Array.isArray(codex[set.id]) ? codex[set.id] : set.slots.map(() => false);
  const doneCount = filled.filter(Boolean).length;
  const done = doneCount === set.slots.length;
  const bonusParts = [];
  if (set.bonus.atk) bonusParts.push(`+${set.bonus.atk} АТК`);
  if (set.bonus.def) bonusParts.push(`+${set.bonus.def} ЗАЩ`);
  if (set.bonus.hp)  bonusParts.push(`+${set.bonus.hp} HP`);

  const inv = player.inventory || [];
  const slotsHtml = set.slots.map((req, i) => {
    const base = typeof itemCatalogBase === 'function' ? itemCatalogBase(req.itemId) : null;
    const rc = base ? (RARITY_COLOR[base.rarity] || '#aea599') : '#aea599';
    const isFilled = !!filled[i];
    // Ready = not filled yet, but the inventory already holds an item that
    // meets this slot's {itemId, minEnhance} — same check tryFillCodexSlot
    // uses to auto-fill, so "highlighted" and "actually fillable by one tap"
    // never disagree.
    const isReady = !isFilled && inv.some(it => typeof codexItemMeetsReq === 'function' && codexItemMeetsReq(it, req));
    const title = `${base ? base.name : req.itemId}${req.minEnhance ? ' +' + req.minEnhance : ''}` +
      (isFilled ? ' — уже внесено' : isReady ? ' — есть в инвентаре, нажми чтобы внести' : '');
    return `<div class="codexslot${isFilled ? ' filled' : ''}${isReady ? ' ready' : ''}" style="--rc:${rc}" title="${_escAttr(title)}"
      ${isFilled ? '' : `onclick="tryFillCodexSlot('${set.id}', ${i})"`}>
      ${base ? _itemIcon(base, 28) : ''}
      ${req.minEnhance ? `<span class="codexslot-enh">+${req.minEnhance}</span>` : ''}
      ${isFilled ? `<span class="codexslot-check">✓</span>` : ''}
    </div>`;
  }).join('');

  return `<div class="codex-set-row${done ? ' done' : ''}">
    <span class="codex-set-star">${iconHTML('star', 15, done ? '#e8b93e' : '#4a4438')}</span>
    <div class="codex-set-main">
      <div class="codex-set-name">${set.name}</div>
      <div class="codex-set-bonus">${bonusParts.join(' &nbsp; ') || '—'}</div>
    </div>
    <div class="codex-set-slots">${slotsHtml}</div>
    <div class="codex-set-frac${done ? ' done' : ''}">${doneCount}/${set.slots.length}</div>
  </div>`;
}

function renderCodexPanel() {
  const body = document.getElementById('codex-panel-body');
  if (!body || !player) return;

  // Re-rendering the whole body on every keystroke (the search input lives
  // inside it) would otherwise steal focus and the caret on each character —
  // restore both afterward when the search box was the thing being typed in.
  const prevInput = document.getElementById('codex-search-input');
  const hadFocus = prevInput && document.activeElement === prevInput;
  const caret = hadFocus ? prevInput.selectionStart : null;

  const bonus = player.codexBonus || { atk: 0, def: 0, hp: 0 };
  const bonusParts = [];
  if (bonus.atk) bonusParts.push(`+${bonus.atk} АТК`);
  if (bonus.def) bonusParts.push(`+${bonus.def} ЗАЩ`);
  if (bonus.hp)  bonusParts.push(`+${bonus.hp} HP`);
  const codex = player.codex || {};
  const allSets = (typeof CODEX_SETS !== 'undefined') ? CODEX_SETS : [];
  const doneTotal = allSets.filter(s => _codexSetDone(s, codex[s.id])).length;

  const filtered = _codexSetsFiltered();
  const shown = filtered.slice(0, _codexShown);
  const rowsHtml = shown.length ? shown.map(_codexSetRowHtml).join('') : `<div class="rating-empty">Ничего не найдено</div>`;
  const moreBtn = filtered.length > _codexShown
    ? `<button class="codex-more-btn" onclick="_codexShowMore()">Показать ещё (${filtered.length - _codexShown})</button>` : '';

  const clsOptions = ['lev', 'deathknight', 'ranger', 'mage', 'warlock']
    .map(c => `<option value="${c}"${_codexFilters.cls === c ? ' selected' : ''}>${CHAR_DEF[c].name}</option>`).join('');
  const rarityOptions = ['common', 'uncommon', 'rare', 'epic', 'legendary']
    .map(r => `<option value="${r}"${_codexFilters.rarity === r ? ' selected' : ''}>${_RARITY_NAMES[r]}</option>`).join('');

  body.innerHTML = `
    <div class="codex-hint">Каждый набор — 2-4 конкретных предмета, часто с требованием по заточке. Внесённый предмет расходуется без возврата; бонус набора остаётся навсегда, как только заполнены все его слоты.</div>
    <div class="codex-total">
      <div class="codex-total-label">Бонус кодекса · наборов завершено ${doneTotal}/${allSets.length}</div>
      <div class="codex-total-stats">${bonusParts.length ? bonusParts.join(' &nbsp; ') : '—'}</div>
    </div>
    <div class="codex-toolbar">
      <input id="codex-search-input" class="codex-search" type="text" placeholder="Поиск по названию…"
        value="${_escAttr(_codexFilters.q)}" oninput="_codexSetFilter('q', this.value)">
      <select class="codex-select" onchange="_codexSetFilter('cls', this.value)">
        <option value="all"${_codexFilters.cls === 'all' ? ' selected' : ''}>Все классы</option>
        ${clsOptions}
      </select>
      <select class="codex-select" onchange="_codexSetFilter('rarity', this.value)">
        <option value="all"${_codexFilters.rarity === 'all' ? ' selected' : ''}>Все редкости</option>
        ${rarityOptions}
      </select>
    </div>
    <div class="codex-status-tabs">
      <button class="codex-status-tab${_codexFilters.status === 'all' ? ' active' : ''}" onclick="_codexSetFilter('status','all')">Все</button>
      <button class="codex-status-tab${_codexFilters.status === 'progress' ? ' active' : ''}" onclick="_codexSetFilter('status','progress')">В процессе</button>
      <button class="codex-status-tab${_codexFilters.status === 'done' ? ' active' : ''}" onclick="_codexSetFilter('status','done')">Завершено</button>
    </div>
    <div class="codex-set-list-meta">Показано ${shown.length} из ${filtered.length}</div>
    <div class="codex-set-list">${rowsHtml}</div>
    ${moreBtn}
  `;

  if (hadFocus) {
    const el = document.getElementById('codex-search-input');
    if (el) { el.focus(); if (caret != null) el.setSelectionRange(caret, caret); }
  }
}

// ─────────────────────────────────────────────────────────
//  PASSIVE SKILL UI
// ─────────────────────────────────────────────────────────
let _activeSkillSubTab = 'active';

function switchSkillTab(tab) {
  _activeSkillSubTab = tab;
  const wrapActive  = document.getElementById('skill-active-wrap');
  const wrapPassive = document.getElementById('skill-passive-wrap');
  const btnActive   = document.getElementById('sktab-active');
  const btnPassive  = document.getElementById('sktab-passive');
  if (!wrapActive || !wrapPassive) return;
  const onPassive = tab === 'passive';
  wrapActive.style.display  = onPassive ? 'none' : '';
  wrapPassive.style.display = onPassive ? '' : 'none';
  btnActive?.classList.toggle('active', !onPassive);
  btnPassive?.classList.toggle('active', onPassive);
  if (onPassive) updatePassiveSkillsUI(); else updateSkillsUI();
}

function _passiveBonusText(p, level) {
  if (level <= 0) return null;
  const val = p.perLevel * level;
  if (p.stat === 'hpRegenFlat') return `+${val.toFixed(1)} ${t('hpPerSecSuffix')}`;
  if (p.stat === 'cdrPct') return `-${Math.round(val * 100)}% ${t('skillCdrSuffix')}`;
  const label = {
    atkPct: t('passiveStatAtk'), defPct: t('passiveStatDef'), hpPct: t('passiveStatHp'),
    atkSpeedPct: t('passiveStatAtkSpeed'), moveSpeedPct: t('passiveStatMoveSpeed'), critPowerFlat: t('passiveStatCritPower'),
  }[p.stat] || '';
  return `+${Math.round(val * 100)}% ${label}`;
}

// One book per passive id (shared/definitions.js CRAFT_MATS, id
// "book_pas_<id>") — mirrors _skillBookId/_skillBookDef above exactly.
function _passiveBookId(id) { return passiveBookId(id); }
function _passiveBookDef(id) {
  return CRAFT_MATS.find(m => m.id === _passiveBookId(id));
}

function _passiveCardHtml(p) {
  if (!player) return '';
  const pl = player.passiveLevels || {};
  const level = pl[p.id] || 0;
  const locked = level <= 0;
  const maxed = level >= PASSIVE_MAX_LEVEL;
  const bonusNow  = locked ? null : _passiveBonusText(p, level);
  const bonusNext = (locked || maxed) ? null : _passiveBonusText(p, level + 1);
  const bookId = _passiveBookId(p.id);
  const bookName = (_passiveBookDef(p.id) || {}).name || t('skillBookFallback');
  const bookCount = countMaterial(bookId);

  const dots = Array.from({ length: PASSIVE_MAX_LEVEL }, (_, i) =>
    `<span class="sk-dot${i < level ? ' filled' : ''}"></span>`
  ).join('');

  // Book-framed icon — the passive's own icon nested inside the book glyph,
  // same visual treatment as active skill books.
  const passiveGlyph = `<img src="${p.img}" width="15" height="15" style="image-rendering:pixelated;border-radius:2px;opacity:${locked ? 0.5 : 1}">`;
  const iconEl = `<div style="position:relative;width:26px;height:26px;opacity:${locked ? 0.4 : 1}">
    ${iconHTML('book', 26, locked ? '#645f57' : '#c48a3a')}
    <div style="position:absolute;left:50%;top:46%;transform:translate(-50%,-50%)">${passiveGlyph}</div>
  </div>`;

  let btnLabel, btnAction, btnDisabled;
  if (locked) {
    btnDisabled = bookCount < SKILL_STUDY_COST;
    btnLabel = iconHTML('book', 12, '#e3941d') + ` ${SKILL_STUDY_COST} · ${tVars('studyBtnFmt', { n: bookCount })}`;
    btnAction = `studyPassiveSkill('${p.id}')`;
  } else if (maxed) {
    btnDisabled = true;
    btnLabel = t('maxLbl');
    btnAction = '';
  } else {
    btnDisabled = bookCount < SKILL_UPGRADE_COST;
    btnLabel = iconHTML('book', 12, '#e3941d') + ` ${SKILL_UPGRADE_COST} · ${tVars('upgradeBtnFmt', { pct: Math.round(SKILL_UPGRADE_CHANCE * 100), n: bookCount })}`;
    btnAction = `upgradePassiveSkillWithBook('${p.id}')`;
  }

  return `<div class="skill-upg-card">
    <div class="skill-upg-top">
      <div class="skill-upg-icon" style="position:relative">
        ${iconEl}
        ${locked ? `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">${iconHTML('lock', 15, '#d1ccc5')}</div>` : ''}
      </div>
      <div class="skill-upg-info">
        <div class="skill-upg-name">${p.name}<span class="skill-upg-lvl">${locked ? ' 🔒 ' + t('notStudiedLbl') : maxed ? ' ' + t('maxAbbrev') : ' ' + t('levelAbbrev') + level}</span></div>
        <div class="skill-upg-desc">${p.desc}</div>
        <div class="skill-upg-type">${locked ? bookName : ''}</div>
      </div>
    </div>
    ${!locked ? `<div class="sk-dots">${dots}</div>` : ''}
    ${!locked ? `<div class="sk-bonus-row">
      ${bonusNow ? `<span class="sk-bonus-now">${bonusNow}</span>` : ''}
      ${bonusNext ? `<span class="sk-bonus-next">→ ${bonusNext}</span>` : ''}
    </div>` : ''}
    <button class="skill-upg-btn${btnDisabled ? ' disabled' : ''}" onclick="${btnAction}">${btnLabel}</button>
  </div>`;
}

function updatePassiveSkillsUI() {
  const el = document.getElementById('passive-skill-panel');
  if (!el || !player) return;
  const classDef = PASSIVE_CLASS_DEF[player.type] || [];

  el.innerHTML = `
    <div class="skill-upg-header">
      <span>${iconHTML('book', 13, '#e3941d')} ${t('passiveBooksHdr')}</span>
      <span class="skill-upg-hint">${tVars('studyUpgradeHintFmt', { a: SKILL_STUDY_COST, b: SKILL_UPGRADE_COST, c: Math.round(SKILL_UPGRADE_CHANCE * 100) })}</span>
    </div>
    <div class="sec-title">${tVars('classPassivesFmt', { cls: CHAR_DEF[player.type]?.name || '' })}</div>
    ${classDef.map(_passiveCardHtml).join('')}
    <div class="sec-title" style="margin-top:14px">${t('commonPassivesHdr')}</div>
    ${PASSIVE_COMMON_DEF.map(_passiveCardHtml).join('')}
  `;
}

function studyPassiveSkill(id) {
  if (!player) return;
  if (!passiveDefById(player.type, id)) return;
  if (((player.passiveLevels || {})[id] || 0) > 0) return;   // already studied
  if (countMaterial(_passiveBookId(id)) < SKILL_STUDY_COST) {
    dmgNum(player.x, player.y - 30, t('needPassiveBookToast'), '#f17e8b');
    return;
  }
  netLearnPassive(id);
}

function upgradePassiveSkillWithBook(id) {
  if (!player) return;
  if (!passiveDefById(player.type, id)) return;
  const lvl = (player.passiveLevels || {})[id] || 0;
  if (lvl <= 0) { dmgNum(player.x, player.y - 30, t('studyPassiveFirstToast'), '#f17e8b'); return; }
  if (lvl >= PASSIVE_MAX_LEVEL) return;
  if (countMaterial(_passiveBookId(id)) < SKILL_UPGRADE_COST) {
    dmgNum(player.x, player.y - 30, tVars('needNPassiveBooksFmt', { n: SKILL_UPGRADE_COST }), '#f17e8b');
    return;
  }
  netUpgradePassive(id);
}

// Which location (hub or one of the 4 corridor arms) the player is currently
// in, as a tile bounding box — so the "Мир" map only ever draws that one
// location instead of the whole world (hub + all 4 arms stacked end to end).
// Uses the player's Y position against each arm's own room-derived Y range
// rather than requiring the player stand inside a specific room rectangle,
// since most play happens in the connecting corridor between rooms.
function _currentLocationBounds() {
  if (!dungeon || !dungeon.rooms) return null;
  const margin = 6;
  const sz = dungeon.safeZone;
  if (sz && player.x >= sz.x1 && player.x <= sz.x2 && player.y >= sz.y1 && player.y <= sz.y2) {
    return {
      tx0: Math.max(0, Math.floor(sz.x1 / TILE) - margin),
      ty0: Math.max(0, Math.floor(sz.y1 / TILE) - margin),
      tx1: Math.min(dungeon.w - 1, Math.ceil(sz.x2 / TILE) + margin),
      ty1: Math.min(dungeon.h - 1, Math.ceil(sz.y2 / TILE) + margin),
    };
  }
  // Sealed zones that carry their own tile-space `bounds` (Фарм-зона, Война
  // гильдий, Кровавая Башня — see their dungeon.js entries). Checked by raw
  // tile bounds rather than _getRoomAt's room-only lookup, so standing in a
  // zone's connecting corridor (not inside one of its rooms) still resolves
  // here instead of falling through to the whole-map fallback below — this
  // was the actual bug: a Фарм-зона player between rooms had no `arm` match
  // (farmZone isn't one of ARM_NAMES) and no room hit either, so every path
  // above missed and the "shouldn't normally happen" fallback fired for
  // completely normal play. zoneLabel lets drawMapPanel's status line reuse
  // this same detection instead of re-deriving it.
  const px = player.x / TILE, py = player.y / TILE;
  // Сезонное крыло приходит под тем же полем `farmZone` (та же зона, те же
  // монстры, та же палитра плитки) и отличается флагом seasonWing — им и
  // отличается подпись места, иначе игрок в крыле читал бы «Фарм зона» и не
  // понимал, в какой из двух половин стоит.
  const namedZones = [
    { z: dungeon.farmZone, zoneLabel: dungeon.farmZone && dungeon.farmZone.seasonWing ? 'farmSeasonLbl' : 'farmZoneLbl' },
    { z: dungeon.farmHigh, zoneLabel: 'farmHighLbl' },
    { z: dungeon.guildWar, zoneLabel: 'guildWarLbl' },
    { z: dungeon.race10,   zoneLabel: 'race10ArenaLbl' },
  ];
  for (const { z, zoneLabel } of namedZones) {
    const zb = z && z.bounds;
    if (!zb || px < zb.x0 || px > zb.x1 || py < zb.y0 || py > zb.y1) continue;
    return {
      tx0: Math.max(0, zb.x0 - margin), ty0: Math.max(0, zb.y0 - margin),
      tx1: Math.min(dungeon.w - 1, zb.x1 + margin), ty1: Math.min(dungeon.h - 1, zb.y1 + margin),
      zoneLabel,
    };
  }
  const playerTy = player.y / TILE;
  for (const dir of ARM_NAMES) {
    const armRooms = dungeon.rooms.filter(r => r.arm === dir);
    if (!armRooms.length) continue;
    const minTy = Math.min(...armRooms.map(r => r.by1));
    const maxTy = Math.max(...armRooms.map(r => r.by2));
    if (playerTy < minTy - margin || playerTy > maxTy + margin) continue;
    const minTx = Math.min(...armRooms.map(r => r.bx1));
    const maxTx = Math.max(...armRooms.map(r => r.bx2));
    // Include the arm's own entrance point so its corridor lead-in (between
    // the teleport pad and the first room pair) never gets clipped off.
    const entry = (dungeon.armEntries || []).find(e => e.dir === dir);
    const entryTx = entry ? entry.x / TILE : minTx;
    return {
      tx0: Math.max(0, Math.floor(Math.min(minTx, entryTx)) - margin),
      ty0: Math.max(0, minTy - margin),
      tx1: Math.min(dungeon.w - 1, maxTx + margin),
      ty1: Math.min(dungeon.h - 1, maxTy + margin),
    };
  }
  // Shouldn't normally happen (hub + 4 arms should cover every reachable Y) —
  // fall back to the whole map rather than drawing nothing.
  return { tx0: 0, ty0: 0, tx1: dungeon.w - 1, ty1: dungeon.h - 1 };
}

function drawMapPanel() {
  if (!dungeon || !player) return;
  const th = getTheme(dungeonLvl);
  const mc = document.getElementById('map-canvas');
  const panel = document.getElementById('panel-map');
  const pw = panel.clientWidth;
  const ph = Math.max(180, Math.floor((panel.clientHeight - 240) * 0.85));
  mc.width = pw; mc.height = ph;
  mc.style.width = pw + 'px'; mc.style.height = ph + 'px';
  const mx2 = mc.getContext('2d');
  const b = _currentLocationBounds() || { tx0: 0, ty0: 0, tx1: dungeon.w - 1, ty1: dungeon.h - 1 };
  const bw = b.tx1 - b.tx0 + 1, bh = b.ty1 - b.ty0 + 1;
  const sc = Math.min((pw - 20) / bw, (ph - 10) / bh);
  const ox = (pw - bw * sc) / 2, oy = 8;
  const wx = tx => ox + (tx - b.tx0) * sc, wy = ty => oy + (ty - b.ty0) * sc;
  mx2.fillStyle = '#070604'; mx2.fillRect(0, 0, pw, ph);
  for (let ty = b.ty0; ty <= b.ty1; ty++) {
    for (let tx = b.tx0; tx <= b.tx1; tx++) {
      const t = dungeon.grid[ty][tx]; if (t === WALL) continue;
      mx2.fillStyle = th.mmFloor;
      mx2.fillRect(wx(tx), wy(ty), Math.max(1, sc - 0.5), Math.max(1, sc - 0.5));
    }
  }
  mx2.fillStyle = '#79dc23';
  mx2.beginPath(); mx2.arc(wx(player.x / TILE), wy(player.y / TILE), Math.max(2, sc * 0.7), 0, Math.PI * 2); mx2.fill();
  // There is no offline mode in this game — serverEnemies is the only enemy
  // list that ever exists. The old `: enemies` fallback below referenced a
  // global that was never declared anywhere; it silently never ran while the
  // socket stayed connected, but any real disconnect (a backgrounded tab
  // losing its connection, a network blip) hit it immediately and threw a
  // ReferenceError out of render() — which is called from the
  // requestAnimationFrame loop, so the throw skipped the loop's own
  // rAF(loop) call at the end and froze the entire game, permanently, even
  // after the socket reconnected moments later.
  const inBounds = (x, y) => {
    const tx = x / TILE, ty = y / TILE;
    return tx >= b.tx0 && tx <= b.tx1 && ty >= b.ty0 && ty <= b.ty1;
  };
  // Bosses still come from serverEnemies — they're streamed from anywhere on
  // the map, unlike regular monsters, so their skulls stay accurate.
  const aliveEnemies = serverEnemies.filter(e => (e.hp || 0) > 0 && inBounds(e.x, e.y));
  // Regular monsters come from the panel's own coarse feed instead: this view
  // spans a whole arm, far more than the radius serverEnemies now covers.
  // Until the first batch lands (it's requested when the panel opens), fall
  // back to the nearby ones so the map is never momentarily empty.
  const _dotR = Math.max(1.5, sc * 0.5);
  mx2.fillStyle = '#e9364b';
  mx2.beginPath();
  if (_mapBlips) {
    for (let i = 0; i < _mapBlips.length; i += 2) {
      const tx = _mapBlips[i], ty = _mapBlips[i + 1];
      if (tx < b.tx0 || tx > b.tx1 || ty < b.ty0 || ty > b.ty1) continue;
      mx2.moveTo(wx(tx) + _dotR, wy(ty));
      mx2.arc(wx(tx), wy(ty), _dotR, 0, Math.PI * 2);
    }
  } else {
    aliveEnemies.forEach(e => {
      if (e.isBoss) return;
      mx2.moveTo(wx(e.x / TILE) + _dotR, wy(e.y / TILE));
      mx2.arc(wx(e.x / TILE), wy(e.y / TILE), _dotR, 0, Math.PI * 2);
    });
  }
  mx2.fill();
  // Boss skull icon on map
  const _bossIconSz = Math.max(10, Math.round(sc * 4));
  mx2.font = `${_bossIconSz}px serif`;
  mx2.textAlign = 'center'; mx2.textBaseline = 'middle';
  aliveEnemies.forEach(e => {
    if (!e.isBoss) return;
    mx2.fillText('💀', wx(e.x / TILE), wy(e.y / TILE));
  });
  // NPC blips on map
  mx2.fillStyle = '#e69419';
  mx2.beginPath();
  npcs.filter(n => inBounds(n.x, n.y)).forEach(n => {
    mx2.moveTo(wx(n.x / TILE) + Math.max(2, sc * 0.7), wy(n.y / TILE));
    mx2.arc(wx(n.x / TILE), wy(n.y / TILE), Math.max(2, sc * 0.7), 0, Math.PI * 2);
  });
  mx2.fill();
  const _pRoom = (typeof _getRoomAt === 'function') ? _getRoomAt(player.x, player.y) : null;
  // _armLabel/_ARM_LABEL (js/game.js) only return the bare adjective (e.g.
  // "left") — corridorSuffix is appended at each call site instead of baked
  // into the shared helper, matching how enteredCorridorToast's own template
  // already does it. b.zoneLabel (set by _currentLocationBounds for Фарм-
  // зона/Guild War/race10) takes priority — _pRoom.arm can be 'farmZone',
  // which isn't one of ARM_NAMES and would otherwise reach _armLabel with a
  // key it doesn't know.
  const _locLabel = b.zoneLabel ? t(b.zoneLabel)
    : (_pRoom?.arm && ARM_NAMES.includes(_pRoom.arm)) ? (_armLabel(_pRoom.arm) + ' ' + t('corridorSuffix') + ' · ' + t('levelAbbrev') + ' ' + _pRoom.monsterLvl)
    : t('centralHall');
  document.getElementById('map-status').textContent =
    _locLabel + ' · ' + tVars('enemiesCountFmt', { n: aliveEnemies.length });
}

// Which corridor arm (1-4) the player currently stands in, by the same
// room-Y-range check _currentLocationBounds uses — covers the corridor
// between room pairs too, not just a room's own rectangle (unlike a bare
// _getRoomAt, which returns null there). null in the hub/safe zone or any
// zone that isn't one of the 4 arms (Фарм-зона, Guild War, race10 — those
// have their own bestiary list or none at all).
function _currentArmIdx() {
  if (!dungeon || !dungeon.rooms || !player) return null;
  const sz = dungeon.safeZone;
  if (sz && player.x >= sz.x1 && player.x <= sz.x2 && player.y >= sz.y1 && player.y <= sz.y2) return null;
  const margin = 6;
  const playerTy = player.y / TILE;
  for (let i = 0; i < ARM_NAMES.length; i++) {
    const armRooms = dungeon.rooms.filter(r => r.arm === ARM_NAMES[i]);
    if (!armRooms.length) continue;
    const minTy = Math.min(...armRooms.map(r => r.by1));
    const maxTy = Math.max(...armRooms.map(r => r.by2));
    if (playerTy < minTy - margin || playerTy > maxTy + margin) continue;
    return i + 1;
  }
  return null;
}

function _floorEnemyPool(n, localLvl) {
  const eMap = new Map(ENEMY_DEF.map(e => [e.eid, e]));
  const fe = FLOOR_ENEMIES[n];
  const band = bandForLocalLevel(fe, localLvl);
  const regular = band.pool.map(eid => eMap.get(eid)).filter(Boolean);
  const boss    = eMap.get(fe.boss);
  return { regular, boss };
}

// Flat monster reference list (no corridor/location grouping) — one row per
// GLOBAL LEVEL 1-MAX_MONSTER_LEVEL (matching what actually spawns at that
// level, name/color included), collapsed by default; tapping a row expands
// its full stat/drop breakdown for the one regular species+archetype that
// room spawns (which one depends on the level's room within its arm, cycling
// every room, see FLOOR_ENEMIES/bandForLocalLevel in shared/definitions.js —
// or the zone boss on its one level).
// Which bestiary list should be showing right now — a specific arm, the
// Фарм-зона species list, or the hub (no list). Movement doesn't pause while
// this panel is open (mapBlips keeps drawMapPanel's canvas live for the same
// reason — see js/network.js), so the list itself needs a way to notice the
// player walked into a different corridor without rebuilding (and collapsing
// any expanded row in) the DOM on every tick while they haven't actually
// moved between locations — see _refreshFloorUIIfLocationChanged below.
function _floorUISignature() {
  const _b = (typeof _currentLocationBounds === 'function') ? _currentLocationBounds() : null;
  if (_b && (_b.zoneLabel === 'farmZoneLbl' || _b.zoneLabel === 'farmSeasonLbl')) return 'farm';
  if (_b && _b.zoneLabel === 'farmHighLbl') return 'farmHigh';
  return _currentArmIdx() || 'hub';
}
let _lastFloorUISignature = null;
function _refreshFloorUIIfLocationChanged() {
  const sig = _floorUISignature();
  if (sig === _lastFloorUISignature) return;
  updateFloorUI();
}

function updateFloorUI() {
  const grid = document.getElementById('floor-grid');
  if (!grid) return;
  _lastFloorUISignature = _floorUISignature();
  // Фарм-зона isn't part of the arm/level system this list otherwise walks —
  // showing the regular 1-78 bestiary while standing inside it would name
  // monsters nobody here actually is. Swap to its own species list instead.
  const _b = (typeof _currentLocationBounds === 'function') ? _currentLocationBounds() : null;
  // Крыло — те же виды и та же таблица дропа, что и первая зона, поэтому и
  // список тот же самый: своя копия расходилась бы с ней на первой же правке.
  if (_b && (_b.zoneLabel === 'farmZoneLbl' || _b.zoneLabel === 'farmSeasonLbl')) { grid.innerHTML = _farmZoneMonsterListHtml(); return; }
  if (_b && _b.zoneLabel === 'farmHighLbl') { grid.innerHTML = _farmHighMonsterListHtml(); return; }

  // Scoped to wherever the player actually is: the hub has no monsters at
  // all, and each corridor only ever spawns its own level band (arm 1 =
  // levels 1-20, arm 2 = 21-40, ...) — showing the full 1-78 reference list
  // regardless of location named monsters nobody standing there could ever
  // meet.
  const _armIdx = _currentArmIdx();
  if (!_armIdx) {
    grid.innerHTML = `<div style="padding:0 4px 12px;color:#83725a;font-size:11px;line-height:1.5">${t('noMonstersHereHint')}</div>`;
    return;
  }
  let html = '';
  for (let lvl = 1; lvl <= MAX_MONSTER_LEVEL; lvl++) {
    const armIdx = armIndexForLevel(lvl);
    if (armIdx !== _armIdx) continue;
    const floor = armIdx;
    const localLvl = armLocalLevel(lvl);
    const roomCount = roomsInArm(armIdx);
    const maxLocalLvl = roomCount - 1;
    const isBossLvl = localLvl === roomCount;
    const { regular, boss } = _floorEnemyPool(floor, localLvl);
    html += isBossLvl
      ? _levelAccordionItem(lvl, [_liveEnemy(boss, lvl, localLvl, true, maxLocalLvl)], floor, true)
      : _levelAccordionItem(lvl, regular.map(base => _liveEnemy(base, lvl, localLvl, false, maxLocalLvl)), floor, false);
  }
  grid.innerHTML = html;
}

// Builds the enemy instance exactly as it would spawn at this level (same
// monsterStatsAtLevel/monsterNameAtLevel/monsterColorAtLevel calls dungeon.js
// uses), so the reference list always matches what's actually in the world.
function _liveEnemy(base, lvl, localLvl, isBoss, maxLocalLvl) {
  const stats = monsterStatsAtLevel(lvl, isBoss ? 'boss' : base.eType);
  // Same hp/atk/spd multipliers spawnRoomEnemies applies (server/game/dungeon.js):
  // regular monsters spawn in packs so their stats are halved individually,
  // the level-20 starting-arm boss gets an extra x10 HP, and every monster
  // past level 20 (floors 2-4) moves x1.5 faster. Without these the reference
  // list showed 2x the real HP/ATK for every regular monster (1/10th for that
  // one boss), and the un-boosted base speed for anything on floor 2+.
  const weakMult = isBoss ? 1 : 0.5;
  const isLvl20Boss = isBoss && lvl === 20;
  const boss20HpMult = isLvl20Boss ? 10 : 1;
  const spdMult = (lvl > 20 || isLvl20Boss) ? 1.5 : 1;
  return {
    ...base, isBoss,
    name: monsterNameAtLevel(base.name, localLvl, isBoss, base.fem, maxLocalLvl),
    color: monsterColorAtLevel(base.color, base.endColor, localLvl, isBoss, maxLocalLvl),
    hp: Math.floor(stats.hp * weakMult * boss20HpMult), atk: Math.floor(stats.atk * weakMult), def: stats.def,
    spd: base.spd * spdMult,
    xp: xpAtLevel(lvl), gold: goldAtLevel(lvl),
  };
}

// ── Фарм-зона reference list ─────────────────────────────────────────────
// Every FARM_SPECIES entry rolls its OWN level 21-30 independently at spawn
// (server/game/dungeon.js) — there is no single "level" for this zone the
// way a normal room has one. This snapshots each species at the midpoint
// (FARM_LVL_MIN..FARM_LVL_MAX average) purely for a representative stat
// line; farmBestiaryHint says as much in the panel itself.
function _liveFarmEnemy(base) {
  const lvl = Math.round((FARM_LVL_MIN + FARM_LVL_MAX) / 2);
  const stats = monsterStatsAtLevel(lvl, base.eType);
  // Named/colored the same way dungeon.js's actual spawn does (localLvl
  // relative to ARM_OFFSETS[1], arm 2's own rank scale) — see its comment
  // for why: a level-27 zombie here should look identical to one anywhere
  // else in the open world.
  const localLvl = lvl - ARM_OFFSETS[1];
  const maxLocalLvl = roomsInArm(2) - 1;
  return {
    ...base, isBoss: false,
    name: monsterNameAtLevel(base.name, localLvl, false, base.fem, maxLocalLvl),
    color: monsterColorAtLevel(base.color, base.endColor, localLvl, false, maxLocalLvl),
    hp: Math.floor(stats.hp * 0.5), atk: Math.floor(stats.atk * 0.5), def: stats.def,
    xp: xpAtLevel(lvl) * FARM_XP_MULT, gold: goldAtLevel(lvl),
  };
}

// Drop breakdown shared by every Фарм-зона species — the zone skips the
// normal loot table entirely (no recipes/gear/keys/stones/regular skill
// books, no GRAM/Liberty — see _rollFarmZoneLoot, server/index.js), so this
// is deliberately NOT _monsterDropBodyHtml: that function's rows would all
// be either wrong (recipe/gear chances that never actually roll here) or
// misleadingly absent (no hint that shards/adv books exist at all).

// One row of that icon/label/chance list — and of _monsterDropBodyHtml's,
// further down. That function used to carry its own copy of this, nested
// inside itself and differing only in how the template literal was indented,
// which shadowed this one for the whole of it. Nothing in either place said
// so, so every edit made here — a class name, a colour, an extra span —
// landed on the Фарм-зона panel and silently missed the monster panel, and
// the two lists drifted apart until someone diffed the rendered HTML. It
// lives at top level, once; the nested callers resolve to it.
function _dropRow(icon, label, valHtml, color) {
  const st = color ? ` style="color:${color}"` : '';
  return `<div class="fi-drop">
    <span class="fi-drop-icon">${icon}</span>
    <span class="fi-drop-lbl"${st}>${label}</span>
    <span class="fi-drop-val"${st}>${valHtml}</span>
  </div>`;
}

// Formats a percentage that can be arbitrarily tiny (a Фарм-зона book/shard
// chance split across a species' own few-item pool routinely lands well
// below 0.0001%) without collapsing to a misleading "0%". A fixed 4-decimal
// format is enough for the zone's coarser rates (gold, stones) but truncates
// anything smaller than that to all zeros — this picks enough decimal
// places to keep the first couple of significant digits instead, however
// small v is.
function _pctSmall(v) {
  if (!(v > 0)) return '0%';
  const leadingZeros = Math.max(0, -Math.floor(Math.log10(v)));
  const digits = Math.min(15, leadingZeros + 3);
  return v.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '') + '%';
}

// Unlike the books below, a shard roll is independent PER SHARD (see
// _rollFarmZoneLoot, server/index.js) — every shard in the killed species'
// own subset (FARM_SPECIES_SHARDS, shared/definitions.js) has its own
// FARM_SHARD_CHANCE shot on every kill, so the per-shard rate shown here
// doesn't get divided by the pool size the way the shared book roll does.
function _farmSpeciesShardRows(eid) {
  const ids = (typeof FARM_SPECIES_SHARDS !== 'undefined' && FARM_SPECIES_SHARDS[eid]) || [];
  const pool = ids.map(id => (typeof UNIQUE_SHARDS !== 'undefined' ? UNIQUE_SHARDS : []).find(s => s.id === id)).filter(Boolean);
  if (!pool.length) return '';
  const _mi = typeof _matIcon === 'function' ? _matIcon : () => '';
  const pct = _pctSmall(FARM_SHARD_CHANCE * 100);
  return pool.map(sh => _dropRow(_mi(sh, 20), sh.name, pct, '#c9a24b')).join('');
}

// One shared roll per kill picks a single random book out of THIS species'
// own pool (FARM_SPECIES_BOOKS, shared/definitions.js — see
// _rollFarmZoneLoot, server/index.js) — the drop itself is NOT per-book
// independent. This breaks that one shared chance down per book (equal share
// of the species' own pool) so players can see which class+skill book a
// given species is actually good for, instead of one opaque merged line
// shared by every species.
const _FARM_ADV_BOOK_CLASS_COLOR = { lev: '#9aa3ab', deathknight: '#a58fc4', ranger: '#8fbf5a', mage: '#66aaff', warlock: '#c47a92' };
function _farmSpeciesBookRows(eid) {
  const ids = (typeof FARM_SPECIES_BOOKS !== 'undefined' && FARM_SPECIES_BOOKS[eid]) || [];
  const pool = ids.map(id => (typeof CRAFT_MATS !== 'undefined' ? CRAFT_MATS : []).find(m => m.id === id)).filter(Boolean);
  if (!pool.length) return '';
  const perBookPct = _pctSmall(FARM_ADV_SKILL_BOOK_CHANCE / pool.length * 100);
  return pool.map(b => {
    const def = (typeof ADV_SKILL_DEF !== 'undefined' && ADV_SKILL_DEF[b.forClass] || []).find(s => s.key === b.advSkillKey);
    const icon = def && def.img
      ? `<img src="${def.img}" style="width:20px;height:20px;border-radius:5px;image-rendering:pixelated">`
      : '📖';
    return _dropRow(icon, b.name, perBookPct, _FARM_ADV_BOOK_CLASS_COLOR[b.forClass] || '#f5c542');
  }).join('');
}

function _farmDropBodyHtml(e) {
  const normPct  = _pctSmall(FARM_NORM_STONE_CHANCE * 100);
  const blessPct = _pctSmall(FARM_BLESS_STONE_CHANCE * 100);
  const epicRecPct = _pctSmall(FARM_EPIC_RECIPE_CHANCE * 100);
  const legRecPct  = _pctSmall(FARM_LEGENDARY_RECIPE_CHANCE * 100);
  const _mi = typeof _matIcon === 'function' ? _matIcon : () => '';
  const normStone  = typeof CRAFT_MATS !== 'undefined' ? CRAFT_MATS.find(m => m.id === 'norm_stone')  : null;
  const blessStone = typeof CRAFT_MATS !== 'undefined' ? CRAFT_MATS.find(m => m.id === 'bless_stone') : null;
  const epicRec = typeof CRAFT_MATS !== 'undefined' ? CRAFT_MATS.find(m => m.id === 'rece') : null;
  const legRec  = typeof CRAFT_MATS !== 'undefined' ? CRAFT_MATS.find(m => m.id === 'recl') : null;
  return `
    ${_dropRow('✨', t('clanPerkXp'), `<b style="color:#b4eb84">${e.xp}</b>`, '#b4eb84')}
    ${_dropRow('🪙', t('npcGoldLbl'), `${e.gold}g · 30%`)}
    ${/* Liberty. Строки не было вовсе — «в фарм зоне в дропе не указан
         LIBERTY», — и это было честно ровно до сегодня: зона платила ноль.
         Теперь платит, и панель обязана называть то же число, по которому
         идёт бросок. */ ''}
    ${(typeof FARM_LIBERTY_CHANCE !== 'undefined' && FARM_LIBERTY_CHANCE > 0)
      ? _dropRow(_nexumIconHtml(16), t('libertyLbl'), _pctSmall(FARM_LIBERTY_CHANCE * 100), '#e8c15a')
      : ''}
    ${_farmSpeciesShardRows(e.eid)}
    ${normStone  ? _dropRow(_mi(normStone, 16),  normStone.name,  normPct,  '#f17e8b') : ''}
    ${blessStone ? _dropRow(_mi(blessStone, 16), blessStone.name, blessPct, '#efc680') : ''}
    ${epicRec ? _dropRow(_mi(epicRec, 16), epicRec.name, epicRecPct, '#c98fef') : ''}
    ${legRec  ? _dropRow(_mi(legRec, 16),  legRec.name,  legRecPct,  '#f5c542') : ''}
    ${_farmSpeciesBookRows(e.eid)}
  `;
}

function _farmZoneMonsterListHtml() {
  const eMap = new Map(ENEMY_DEF.map(e => [e.eid, e]));
  const species = (typeof FARM_SPECIES !== 'undefined' ? FARM_SPECIES : [])
    .map(eid => eMap.get(eid)).filter(Boolean).map(_liveFarmEnemy);
  const items = species.map(e => `
    <div class="mon-item">
      <div class="mon-hdr" onclick="_toggleMonster(this)">
        <span class="dot" style="background:${e.color}"></span>
        <div class="mon-titles">
          <span class="mon-lvl">${t('farmLevelRangeLbl')}</span>
          <div class="mon-name-row"><span class="mon-name">${e.name}</span></div>
        </div>
        <span class="mon-chevron">›</span>
      </div>
      <div class="mon-body">${_farmDropBodyHtml(e)}</div>
    </div>`).join('');
  return `<div style="padding:0 4px 12px;color:#83725a;font-size:11px;line-height:1.5">${t('farmBestiaryHint')}</div>${items}`;
}

// ── Фарм зона 2: бестиарий зоны ───────────────────────────────────────────
// Та же форма, что у _farmZoneMonsterListHtml выше — аккордеон по видам, —
// но зона делит между видами не один пул, а четыре (снаряжение и три
// книжных набора, FARM_HIGH_SPECIES_* в shared/definitions.js), и панель
// обязана это показывать: ставка у всей зоны общая, а вид решает, ЧТО
// именно выпадет. Поэтому каждая строка — доля предмета в СВОЁМ пуле
// (chance / pool.length), а не доля от каталога: игрок должен видеть, за чем
// именно ему идти к этому монстру.
function _farmHighBookRows(ids, chance, iconFor) {
  const pool = (ids || []).map(id => (typeof CRAFT_MATS !== 'undefined' ? CRAFT_MATS : []).find(m => m.id === id)).filter(Boolean);
  if (!pool.length) return '';
  const per = _pctSmall(chance / pool.length * 100);
  return pool.map(b => _dropRow(iconFor(b), b.name, per,
    _FARM_ADV_BOOK_CLASS_COLOR[b.forClass] || '#cdb8ec')).join('');
}

// Иконка книги — та же, что рисует её инвентарная запись: картинка самого
// навыка, если она есть в каталоге, иначе значок книги.
function _farmHighSkillBookIcon(b) {
  const src = b.advSkillKey
    ? (typeof ADV_SKILL_DEF !== 'undefined' && ADV_SKILL_DEF[b.forClass] || []).find(sk => sk.key === b.advSkillKey)
    : b.skillKey
      ? (typeof SKILL_DEF !== 'undefined' && SKILL_DEF[b.forClass] || []).find(sk => sk.key === b.skillKey)
      : null;
  return src && src.img
    ? `<img src="${src.img}" style="width:16px;height:16px;border-radius:4px;image-rendering:pixelated">`
    : iconHTML('book', 16, '#f5c542');
}

// Снаряжение вида: свои слоты, и по одному броску на КАЖДУЮ редкость
// (FARM_HIGH_GEAR_CHANCE) — не один бросок с жребием редкости, как в
// коридорах. Поэтому и рисуется по разделу на редкость, с её собственным
// заголовком: иначе шестнадцать строк подряд отличались бы только цветом, и
// «сколько стоит эпик» пришлось бы выискивать глазами.
function _farmHighGearSections(eid) {
  const slots = (typeof FARM_HIGH_SPECIES_GEAR_SLOTS !== 'undefined' && FARM_HIGH_SPECIES_GEAR_SLOTS[eid]) || [];
  if (!slots.length || typeof FARM_HIGH_GEAR_CHANCE === 'undefined') return '';
  return Object.keys(FARM_HIGH_GEAR_CHANCE).map(rarity => {
    const pool = ITEM_DEF.filter(d => d.rarity === rarity && !d.noDrop && slots.includes(d.slot));
    if (!pool.length) return '';
    const rc = (typeof RARITY_COLOR !== 'undefined' ? RARITY_COLOR[rarity] : null) || '#aea599';
    const rn = (typeof _RARITY_NAMES !== 'undefined' ? _RARITY_NAMES[rarity] : null) || rarity;
    const per = _pctSmall(FARM_HIGH_GEAR_CHANCE[rarity] / pool.length * 100);
    const rows = pool.map(it => _dropRow(_itemIcon(it, 16), it.name, per, rc)).join('');
    return `<div class="fi-drops-hdr" style="margin-top:8px">${tVars('gearRarityFmt', { rn })}</div><div class="fi-drops">${rows}</div>`;
  }).join('');
}

// Строки, одинаковые для всех видов зоны: опыт, золото, Liberty, камень
// заточки и оба рецепта. Всё остальное поделено, и живёт в разделах ниже.
function _farmHighZoneRows(e) {
  const _mi = typeof _matIcon === 'function' ? _matIcon : () => '';
  const normStone = typeof CRAFT_MATS !== 'undefined' ? CRAFT_MATS.find(m => m.id === 'norm_stone') : null;
  const epicRec   = typeof CRAFT_MATS !== 'undefined' ? CRAFT_MATS.find(m => m.id === 'rece') : null;
  const legRec    = typeof CRAFT_MATS !== 'undefined' ? CRAFT_MATS.find(m => m.id === 'recl') : null;
  return `
    ${_dropRow('✨', t('clanPerkXp'), `<b style="color:#b4eb84">${e.xp}</b>`, '#b4eb84')}
    ${_dropRow('🪙', t('npcGoldLbl'), `${e.gold}g · 30%`)}
    ${(typeof FARM_HIGH_LIBERTY_CHANCE !== 'undefined' && FARM_HIGH_LIBERTY_CHANCE > 0)
      ? _dropRow(_nexumIconHtml(16), t('libertyLbl'), _pctSmall(FARM_HIGH_LIBERTY_CHANCE * 100), '#e8c15a')
      : ''}
    ${normStone ? _dropRow(_mi(normStone, 16), normStone.name, _pctSmall(FARM_HIGH_NORM_STONE_CHANCE * 100), '#f17e8b') : ''}
    ${epicRec   ? _dropRow(_mi(epicRec, 16),   epicRec.name,   _pctSmall(FARM_HIGH_EPIC_RECIPE_CHANCE * 100), '#c98fef') : ''}
    ${legRec    ? _dropRow(_mi(legRec, 16),    legRec.name,    _pctSmall(FARM_HIGH_LEGENDARY_RECIPE_CHANCE * 100), '#f5c542') : ''}`;
}

function _farmHighSpeciesBodyHtml(e) {
  const sec = (hdr, rows) => rows ? `<div class="fi-drops-hdr" style="margin-top:8px">${hdr}</div><div class="fi-drops">${rows}</div>` : '';
  const S = typeof FARM_HIGH_SPECIES_SKILL_BOOKS   !== 'undefined' ? FARM_HIGH_SPECIES_SKILL_BOOKS[e.eid]   : [];
  const A = typeof FARM_HIGH_SPECIES_ADV_BOOKS     !== 'undefined' ? FARM_HIGH_SPECIES_ADV_BOOKS[e.eid]     : [];
  const P = typeof FARM_HIGH_SPECIES_PASSIVE_BOOKS !== 'undefined' ? FARM_HIGH_SPECIES_PASSIVE_BOOKS[e.eid] : [];
  return `
    <div class="fi-mstats">
      <span>HP <b>${e.hp}</b></span>
      <span>ATK <b>${e.atk}</b></span>
      <span>DEF <b>${e.def}</b></span>
      <span>${t('spdAbbrev')} <b>${e.spd}</b></span>
    </div>
    ${sec(t('farmHighZoneDropHdr'), _farmHighZoneRows(e))}
    ${_farmHighGearSections(e.eid)}
    ${sec(t('farmHighSkillBooksHdr'), _farmHighBookRows(S, FARM_HIGH_SKILL_BOOK_CHANCE, _farmHighSkillBookIcon))}
    ${sec(t('farmHighAdvBooksHdr'), _farmHighBookRows(A, FARM_HIGH_ADV_SKILL_BOOK_CHANCE, _farmHighSkillBookIcon))}
    ${sec(t('farmHighPassiveBooksHdr'), _farmHighBookRows(P, FARM_HIGH_PASSIVE_BOOK_CHANCE, b => _itemIcon(b, 16)))}`;
}

function _farmHighMonsterListHtml() {
  const eMap = new Map(ENEMY_DEF.map(e => [e.eid, e]));
  const lvl = Math.round((FARM_HIGH_LVL_MIN + FARM_HIGH_LVL_MAX) / 2);
  // Имя/цвет ранга — по шкале САМОЙ ЗОНЫ, ровно как их считает её настоящий
  // спавн (generateFarmHigh, server/game/dungeon.js — там же разбор, почему
  // не по шкале рукава). Здесь показан средний уровень полосы, значит и ранг
  // средний.
  const localLvl = lvl - FARM_HIGH_LVL_MIN + 1;
  const maxLocalLvl = FARM_HIGH_LVL_MAX - FARM_HIGH_LVL_MIN + 1;
  const items = (typeof FARM_HIGH_SPECIES !== 'undefined' ? FARM_HIGH_SPECIES : [])
    .map(eid => eMap.get(eid)).filter(Boolean)
    .map(base => {
      const stats = monsterStatsAtLevel(lvl, base.eType);
      const e = {
        ...base,
        // Те же половинные hp/atk, что кладёт генератор зоны.
        name: monsterNameAtLevel(base.name, localLvl, false, base.fem, maxLocalLvl),
        color: monsterColorAtLevel(base.color, base.endColor, localLvl, false, maxLocalLvl),
        hp: Math.floor(stats.hp * 0.5), atk: Math.floor(stats.atk * 0.5), def: stats.def,
        xp: xpAtLevel(lvl) * FARM_HIGH_XP_MULT, gold: goldAtLevel(lvl),
      };
      return `
    <div class="mon-item">
      <div class="mon-hdr" onclick="_toggleMonster(this)">
        <span class="dot" style="background:${e.color}"></span>
        <div class="mon-titles">
          <span class="mon-lvl">${tVars('farmHighLevelRangeFmt', { a: FARM_HIGH_LVL_MIN, b: FARM_HIGH_LVL_MAX })}</span>
          <div class="mon-name-row"><span class="mon-name">${e.name}</span></div>
        </div>
        <span class="mon-chevron">›</span>
      </div>
      <div class="mon-body">${_farmHighSpeciesBodyHtml(e)}</div>
    </div>`;
    }).join('');
  const hint = tVars('farmHighBestiaryHint', { a: FARM_HIGH_LVL_MIN, b: FARM_HIGH_LVL_MAX });
  return `<div style="padding:0 4px 12px;color:#83725a;font-size:11px;line-height:1.5">${hint}</div>${items}`;
}

function _levelAccordionItem(lvl, variants, floor, isBossLvl) {
  const head = variants[0];
  const nameRow = isBossLvl
    ? `<span class="mon-name">${head.name}</span><span class="fi-boss-tag">${t('bossTag')}</span>`
    : `<span class="mon-name">${variants.map(v => v.name).join(' / ')}</span>`;
  const body = variants.map(e => `
    <div class="mon-variant">
      ${variants.length > 1 ? `<div class="mon-variant-hdr"><span class="dot" style="background:${e.color}"></span>${e.name}</div>` : ''}
      ${_monsterDropBodyHtml(e, floor, lvl)}
    </div>`).join('');
  return `
    <div class="mon-item">
      <div class="mon-hdr" onclick="_toggleMonster(this)">
        <span class="dot" style="background:${head.color}"></span>
        <div class="mon-titles">
          <span class="mon-lvl">${tVars('charLevelFmt', { lvl })}</span>
          <div class="mon-name-row">${nameRow}</div>
        </div>
        <span class="mon-chevron">›</span>
      </div>
      <div class="mon-body">${body}</div>
    </div>`;
}

function _toggleMonster(hdrEl) {
  const item = hdrEl.closest('.mon-item');
  if (!item) return;
  const opening = !item.classList.contains('open');
  item.classList.toggle('open', opening);
  const body = item.querySelector('.mon-body');
  if (body) body.style.display = opening ? 'block' : 'none';
}

// Every row below mirrors a real roll in applyLootToInventory() (js/combat.js)
// — same drop-chance formulas, same item pools — so this list is a complete,
// accurate picture of everything that enemy can drop, not just a subset.
function _monsterDropBodyHtml(e, floor, lvl) {
  const isBoss = !!e.isBoss;
  const hp  = e.hp;
  const atk = e.atk;

  // dropMult matches _dropMult in combat.js exactly: arm index × room-level
  // growth (roomDropMult), used for recipes below. The room level goes in
  // uncapped — roomDropMult/roomKeyChance/roomEnchantStoneChance apply
  // DROP_GROWTH_MAX_ROOM_LEVEL themselves (shared/definitions.js), which is
  // why rooms 13-20 of a floor all print the same numbers here: past that
  // room the chances stop growing, and this panel says so.
  //
  // There is no Liberty row: an ordinary corridor kill pays none any more
  // (see the Liberty branch in server/handlers2/world.js). It still drops in
  // the two farm zones, and those panels have their own row for it.
  const localLvl = typeof armLocalLevel === 'function' ? armLocalLevel(lvl) : (floor >= 1 ? 1 : 1);
  const dropMult = floor * (typeof roomDropMult === 'function' ? roomDropMult(localLvl) : 1);
  // Mirrors _zoneMult in _rollMobLoot (server/index.js) exactly: arms 1-2
  // (levels 1-40) get every drop chance below cut to a third.
  const zoneMult = (typeof EARLY_ZONE_ARMS !== 'undefined' && EARLY_ZONE_ARMS.has(floor)) ? EARLY_ZONE_DROP_MULT : 1;
  function _pctText(v) {
    if (v <= 0) return '0%';
    if (v >= 1)   return v.toFixed(1).replace(/\.0$/, '') + '%';
    if (v >= 0.1) return v.toFixed(2).replace(/\.?0+$/, '') + '%';
    return v.toFixed(4).replace(/\.?0+$/, '') + '%';
  }

  // Gold: deterministic amount = level, 30% chance to drop (100% for boss)
  const goldText = isBoss
    ? `<span style="color:#e6ac19">${e.gold}g</span>`
    : `${e.gold}g · 30%`;

  // XP: deterministic = level
  const xpFinal = e.xp;
  const xpColor = isBoss ? '#79dc23' : '#b4eb84';

  const _mi = typeof _matIcon === 'function' ? _matIcon : () => '';

  // Boss-only rows — fixed chances matching the server's boss-kill payout
  const _boxUncommon = BOX_DEF.find(bx=>bx.id==='box_uncommon');
  const _boxRare = BOX_DEF.find(bx=>bx.id==='box_rare');
  const _normStone = CRAFT_MATS.find(m=>m.id==='norm_stone');
  const _blessStone = CRAFT_MATS.find(m=>m.id==='bless_stone');
  const stoneRow = isBoss
    ? _dropRow(_itemIcon(_boxUncommon, 16), _boxUncommon.name, `&times;1 · <b style="color:#90d653">50%</b>`, '#90d653')
    + _dropRow(_itemIcon(_boxRare, 16), _boxRare.name, `&times;1 · <b style="color:#4a7bab">10%</b>`, '#4a7bab')
    + _dropRow(_mi(_normStone, 16), _normStone.name, `&times;1 · <b style="color:#f17e8b">10%</b>`, '#f17e8b')
    + _dropRow(_mi(_blessStone, 16), _blessStone.name, `&times;1 · <b style="color:#efc680">1%</b>`, '#efc680')
    : '';

  // Recipe drops (non-boss only) — one roll picks at most one of the 4
  // tiers via cumulative thresholds in combat.js; the numbers below are the
  // equivalent independent per-item percentages (the gaps between those
  // thresholds), so they can be shown as separate rows.
  let recipeSection = '';
  if (!isBoss) {
    const recipeDrops = [
      { id:'recl', base:0.001 },
      { id:'rece', base:0.02  },
      { id:'recr', base:0.05  },
      { id:'recu', base:0.1   },
    ];
    const rows = recipeDrops.map(d => {
      const mat = CRAFT_MATS.find(m => m.id === d.id);
      if (!mat) return '';
      const rc = (typeof RARITY_COLOR !== 'undefined' ? RARITY_COLOR[mat.rarity] : null) || '#aea599';
      return _dropRow(_mi(mat, 16), mat.name, `&times;1 · <b style="color:${rc}">${_pctText(d.base * dropMult * zoneMult)}</b>`, rc);
    }).join('');
    recipeSection = `<div class="fi-drops-hdr" style="margin-top:8px">${t('craftRecipesHdr')}</div><div class="fi-drops">${rows}</div>`;
  }

  // Room-level keys + enchant stone (non-boss only — bosses use the fixed
  // stoneRow above instead)
  let keySection = '';
  if (!isBoss && typeof roomKeyChance === 'function') {
    const matU = CRAFT_MATS.find(m => m.id === 'key_uncommon');
    const matR = CRAFT_MATS.find(m => m.id === 'key_rare');
    const matN = CRAFT_MATS.find(m => m.id === 'norm_stone');
    const rows =
      (matU ? _dropRow(_mi(matU, 16), matU.name, `&times;1 · <b>${_pctText(roomKeyChance(localLvl, 'uncommon') * zoneMult * 100)}</b>`) : '') +
      (matR ? _dropRow(_mi(matR, 16), matR.name, `&times;1 · <b>${_pctText(roomKeyChance(localLvl, 'rare') * zoneMult * 100)}</b>`) : '') +
      (matN && typeof roomEnchantStoneChance === 'function' ? _dropRow(_mi(matN, 16), matN.name, `&times;1 · <b>${_pctText(roomEnchantStoneChance(localLvl) * zoneMult * 100)}</b>`) : '');
    keySection = `<div class="fi-drops-hdr" style="margin-top:8px">${t('keysStonesHdr')}</div><div class="fi-drops">${rows}</div>`;
  }

  // Equipment drop: one continuous chance (+0.1%/level, never resets across
  // zones) picks a single rarity by the level's arm (itemDropChanceAtLevel/
  // itemRarityForLevel) then one item uniformly among ALL candidates at that
  // rarity — every class's weapon competes alongside every armor/accessory
  // slot now (js/combat.js no longer restricts weapons to the killing
  // player's own class), so each item's share is 1-in-candidates.length,
  // not a fixed 1-in-7. No 'cloak'/'artifact' — craft-only, matches js/combat.js.
  let gearSection = '';
  if (typeof itemDropChanceAtLevel === 'function') {
    const pct = Math.min(100, itemDropChanceAtLevel(lvl) * (isBoss ? BOSS_ITEM_DROP_MULT : 1)) * zoneMult;
    const rarity = itemRarityForLevel(lvl);
    const rc = (typeof RARITY_COLOR !== 'undefined' ? RARITY_COLOR[rarity] : null) || '#aea599';
    const rn = (typeof _RARITY_NAMES !== 'undefined' ? _RARITY_NAMES[rarity] : null) || rarity;
    const GEAR_SLOTS = ['weapon', 'helmet', 'body', 'gloves', 'boots', 'ring', 'belt'];
    // !d.noDrop matches the server's own pool (_rollMobLoot, server/index.js):
    // the unique weapons are craft-only and must not be advertised as drops.
    const candidates = ITEM_DEF.filter(d => d.rarity === rarity && !d.noDrop && GEAR_SLOTS.includes(d.slot));
    const perItemPct = candidates.length ? pct / candidates.length : 0;
    const rows = candidates.map(it => _dropRow(_itemIcon(it, 16), it.name, `&times;1 · <b style="color:${rc}">${_pctText(perItemPct)}</b>`, rc)).join('');
    gearSection = `<div class="fi-drops-hdr" style="margin-top:8px">${tVars('gearRarityFmt', { rn })}</div><div class="fi-drops">${rows}</div>`;
  }

  // Skill books — restricted to a 5-book pool (one per class) that rotates
  // with this monster's own level; see levelSkillBookPool (shared/
  // definitions.js). Four consecutive levels cover all twenty base Q/W/E/R
  // books — same roll/pool the server rolls in _rollMobLoot (server/game/
  // loot.js), so this list is exactly what this monster can actually drop,
  // not the full 20-book catalog. The advanced ("2 профессия") books are not
  // in it and must not be advertised here: they come from the farm zones and
  // the forge craft only (see _farmSpeciesBookRows/_farm2AdvBookRows below).
  let bookSection = '';
  {
    const pool = typeof levelSkillBookPool === 'function' ? levelSkillBookPool(lvl) : CRAFT_MATS.filter(m => m.skillKey);
    if (pool.length) {
      const rows = pool.map(b => {
        const className = (CHAR_DEF[b.forClass] || {}).name || b.forClass;
        const label = `${b.name} <span style="opacity:.6">(${className})</span>`;
        return isBoss
          ? _dropRow(_itemIcon(b, 16), label, `&times;2 · <b style="color:#98e456">${_pctText(100 / pool.length * 0.001 * zoneMult)}</b>`, '#98e456')
          : _dropRow(_itemIcon(b, 16), label, `&times;1 · <b>${_pctText(0.00002 * Math.min(dropMult, 3) / pool.length * zoneMult * 100)}</b>`);
      }).join('');
      bookSection = `<div class="fi-drops-hdr" style="margin-top:8px">${t('skillBooksAllClassesHdr')}</div><div class="fi-drops">${rows}</div>`;
    }
  }

  // Passive skill books — same mechanic/odds as active skill books above,
  // separate roll and separate pool. The class-exclusive half alternates
  // offense/defense by level (odd/even), the 6 universal ones rotate
  // one-per-level the same way the skill books cycle Q/W/E/R.
  let passiveBookSection = '';
  {
    const classPool = typeof levelClassPassivePool === 'function' ? levelClassPassivePool(lvl) : [];
    const universalPool = typeof levelUniversalPassivePool === 'function' ? levelUniversalPassivePool(lvl) : CRAFT_MATS.filter(m => m.passiveId && !m.forClass);
    const allPassiveBooks = classPool.concat(universalPool);
    if (allPassiveBooks.length) {
      const rows = allPassiveBooks.map(b => {
        const label = b.forClass
          ? `${b.name} <span style="opacity:.6">(${(CHAR_DEF[b.forClass] || {}).name || b.forClass})</span>`
          : `${b.name} <span style="opacity:.6">(${t('commonTag')})</span>`;
        return isBoss
          ? _dropRow(_itemIcon(b, 16), label, `&times;2 · <b style="color:#98e456">${_pctText(100 / allPassiveBooks.length * 0.001 * zoneMult)}</b>`, '#98e456')
          : _dropRow(_itemIcon(b, 16), label, `&times;1 · <b>${_pctText(0.00002 * Math.min(dropMult, 3) / allPassiveBooks.length * zoneMult * 100)}</b>`);
      }).join('');
      passiveBookSection = `<div class="fi-drops-hdr" style="margin-top:8px">${t('passiveBooksAllClassesHdr')}</div><div class="fi-drops">${rows}</div>`;
    }
  }

  // Осколки уникального оружия. Listed for the same reason every other roll
  // is: this panel promises a complete picture of what an enemy drops, so a
  // roll that exists and isn't shown makes the rest of it untrustworthy.
  // Below the level gate there is nothing to show at all.
  let shardSection = '';
  if (typeof UNIQUE_SHARDS !== 'undefined' && lvl >= UNIQUE_SHARD_MIN_LEVEL) {
    // "×1" rather than "×1–1" when a kill can only ever yield one.
    const qtyText = UNIQUE_SHARD_MAX_QTY > 1 ? `1–${UNIQUE_SHARD_MAX_QTY}` : '1';
    const rows = UNIQUE_SHARDS.map(sh => {
      const def = CRAFT_MATS.find(m => m.id === sh.id) || sh;
      return _dropRow(_itemIcon(def, 16), def.name,
        `&times;${qtyText} · <b style="color:#d9b3ff">${_pctText(UNIQUE_SHARD_CHANCE * zoneMult * 100)}</b>`,
        '#d9b3ff');
    }).join('');
    shardSection = `<div class="fi-drops-hdr" style="margin-top:8px">${t('uniqueShardsHdr')}</div><div class="fi-drops">${rows}</div>`;
  }

  return `
    <div class="fi-mstats">
      <span>HP <b>${hp}</b></span>
      <span>ATK <b>${atk}</b></span>
      <span>DEF <b>${e.def}</b></span>
      <span>${t('spdAbbrev')} <b>${e.spd}</b></span>
    </div>
    <div class="fi-drops-hdr">${t('dropHdr')}</div>
    <div class="fi-drops">
      <div class="fi-drop">
        <span class="fi-drop-lbl">${t('clanPerkXp')}</span>
        <span class="fi-drop-val" style="color:${xpColor}">${xpFinal} XP</span>
      </div>
      <div class="fi-drop">
        <span class="fi-drop-lbl">${t('npcGoldLbl')}</span>
        <span class="fi-drop-val">${goldText}</span>
      </div>
      ${stoneRow}
    </div>
    ${recipeSection}
    ${keySection}
    ${gearSection}
    ${bookSection}
    ${passiveBookSection}
    ${shardSection}`;
}

// ─────────────────────────────────────────────────────────
//  TAB MANAGEMENT
// ─────────────────────────────────────────────────────────
let _invTab = 0;

function setMapTab() {
  if (typeof netSetMapView === 'function') netSetMapView(activeTab === 2);
  updateFloorUI();
  setTimeout(drawMapPanel, 320);
}

function setInvTab(n) {
  _invTab = n;
  document.querySelectorAll('.inv-tab').forEach((el, i) => el.classList.toggle('active', i === n));
  document.getElementById('inv-tab-content-0').style.display = n === 0 ? '' : 'none';
  document.getElementById('inv-tab-content-1').style.display = n === 1 ? '' : 'none';
  document.getElementById('inv-tab-content-2').style.display = n === 2 ? '' : 'none';
  document.getElementById('inv-tab-content-3').style.display = n === 3 ? '' : 'none';
  if (n === 0) updateInvUI();
  if (n === 1) updateProfileUI();
  if (n === 2) switchSkillTab(_activeSkillSubTab);
  if (n === 3) updateEmpowerUI();
}

// Chat floats above the world canvas and only makes sense while actually
// playing — hidden on every other bottom-nav tab. dataset.shown gates this
// so a button that hasn't been unlocked yet (before login/char-select
// finishes) never gets forced visible.
const _CHAT_BTN_ID = 'chat-btn';
// Teleport-stone button sits right above chat-btn and follows the exact same
// tab-only visibility rule (see _syncGameOnlyBtns below).
const _TELEPORT_BTN_ID = 'teleport-btn';
// VIP/Market/Магазин/События/Сезон/Кодекс — seven of them got crowded enough
// to need a fold-away menu (hud-menu-btn) rather than sitting on screen the
// whole time; see toggleHudMenu below. Same dataset.shown gating, plus they
// only ever show while the menu is expanded.
const _HUD_MENU_BTN_IDS = ['vip-btn', 'market-btn', 'gram-shop-btn', 'rating-btn', 'events-btn', 'season-btn', 'codex-btn'];
let _hudMenuExpanded = false;
// hud-menu-btn's own visibility is tab-only (like chat); the seven behind it
// need tab AND expanded — this is that second check, shared by every
// showXBtn below and by the tab-switch sync.
function _hudSubBtnDisplay() { return (activeTab === 0 && _hudMenuExpanded) ? 'flex' : 'none'; }

function _syncGameOnlyBtns(n) {
  const chatEl = document.getElementById(_CHAT_BTN_ID);
  if (chatEl && chatEl.dataset.shown === '1') chatEl.style.display = (n === 0) ? 'flex' : 'none';
  const teleEl = document.getElementById(_TELEPORT_BTN_ID);
  if (teleEl && teleEl.dataset.shown === '1') teleEl.style.display = (n === 0) ? 'flex' : 'none';
  const menuEl = document.getElementById('hud-menu-btn');
  if (menuEl && menuEl.dataset.shown === '1') menuEl.style.display = (n === 0) ? 'flex' : 'none';
  const subDisplay = (n === 0 && _hudMenuExpanded) ? 'flex' : 'none';
  _HUD_MENU_BTN_IDS.forEach(id => {
    const el = document.getElementById(id);
    if (el && el.dataset.shown === '1') el.style.display = subDisplay;
  });
  // chat-btn's own visibility just changed above — keep the last-message
  // preview bubble (js/network.js) in sync with it (also hidden off the
  // Игра tab).
  if (typeof _refreshChatPreview === 'function') _refreshChatPreview();
}

// Folds the VIP/Market/.../Кодекс column away behind hud-menu-btn — seven
// buttons permanently on screen was too much clutter, so only the toggle
// stays put and the rest render only while expanded.
function toggleHudMenu() {
  _hudMenuExpanded = !_hudMenuExpanded;
  const btn = document.getElementById('hud-menu-btn');
  if (btn) btn.classList.toggle('expanded', _hudMenuExpanded);
  _syncGameOnlyBtns(activeTab);
  if (_hudMenuExpanded) _positionHudColumn();
}

function setTab(n) {
  activeTab = n;
  // Keep the world rendering through the panel slide-in/out animation (~0.28s
  // CSS transition) so it doesn't freeze mid-slide; render() stops drawing the
  // hidden world once this grace window elapses. See _menuGraceUntil in game.js.
  _menuGraceUntil = performance.now() + 350;
  document.querySelectorAll('.nav-tab').forEach((el, i) => el.classList.toggle('active', i === n));
  document.querySelectorAll('.bpanel').forEach(p => { p.classList.remove('open'); });
  _syncGameOnlyBtns(n);
  if (n !== 0) {
    joy.active = false; joy.dx = 0; joy.dy = 0;
    const tb = document.getElementById('npc-talk-btn');
    if (tb) tb.style.display = 'none';
  }
  // Leaving the map panel stops the world-wide dot feed (setMapTab turns it
  // back on when the map panel itself is the one showing).
  if (n !== 2 && typeof netSetMapView === 'function') netSetMapView(false);
  const pid = ['', 'panel-inv', 'panel-map', 'panel-quests', 'panel-clans', 'panel-profile'][n];
  if (pid) {
    const el = document.getElementById(pid);
    el.style.display = 'block';
    requestAnimationFrame(() => { el.classList.add('open'); el.scrollTop = 0; });
    if (n === 1) {
      if (_invTab === 1) updateProfileUI();
      else if (_invTab === 2) switchSkillTab(_activeSkillSubTab);
      else if (_invTab === 3) updateEmpowerUI();
      else updateInvUI();
    }
    if (n === 2) { setMapTab(); }
    if (n === 3 && typeof updateQuestUI === 'function') updateQuestUI();
    if (n === 4 && typeof updateClanUI === 'function') {
      // Ask for current clan state as the panel opens — see netClanRequest.
      if (typeof netClanRequest === 'function') netClanRequest();
      updateClanUI();
    }
    if (n === 5) switchProfileTab(window._profileTab || 'wallet');
  }
}

// ─────────────────────────────────────────────────────────
//  HUD STATE  (caches shared by the header and the buttons)
// ─────────────────────────────────────────────────────────
// Avatar bg gradient (re-created only when character color changes)
let _avBgGrad = null, _avBgColor = '';
// All button + target-frame gradients — rebuilt when null (set null on resize)
let _uiBtnGrads = null;

// Minimap floor-tile buffer — see the cache block inside drawMiniMapPanel().
// Only rebuilt when the player crosses into a new tile (or theme/scale
// changes); every other frame just blits it at the current sub-tile offset.
// Invalidated on floor change too, see buildTileCanvas() in js/game.js.
let _mmTileCv = null, _mmTileCvTx = null, _mmTileCvTy = null, _mmTileCvSc = null, _mmTileCvTheme = null;
const _MM_MARGIN = 2; // buffer margin (tiles) beyond the visible window

// Telegram profile photo shown in the header avatar slot in place of the
// class-color/icon avatar, once it loads. Set once from initDataUnsafe at
// login (see _initTelegramWidget in network.js) — not every user has one,
// so drawHeader() keeps the existing icon avatar as a fallback.
let _tgAvatarImg = null, _tgAvatarReady = false;
// crossOrigin='anonymous' стоял ради чистого холста — и был ровно тем, из-за
// чего аватарки не было вообще. CDN телеграма (t.me/i/userpic/…) заголовков
// CORS не шлёт, а с этим атрибутом браузер такую картинку не грузит НИКАК:
// срабатывает onerror, и вместо лица игрока рисовалась иконка класса.
//
// Платили при этом ни за что: во всём клиенте нет ни одного getImageData и ни
// одного toDataURL, то есть «испорченный» холст ничему не мешает. Проверено
// поиском, а не по памяти.
//
// Порядок такой: сначала с CORS — вдруг однажды CDN начнёт их слать, и холст
// останется чистым; при отказе тот же URL заново, уже без атрибута.
function setTelegramAvatar(url) {
  if (!url) return;
  const load = (withCors) => {
    const img = new Image();
    if (withCors) img.crossOrigin = 'anonymous';
    img.onload = () => { _tgAvatarImg = img; _tgAvatarReady = true; };
    img.onerror = () => {
      if (withCors) { load(false); return; }
      _tgAvatarReady = false; _tgAvatarImg = null;
      console.warn('[hud] аватар телеграма не загрузился: ' + url);
    };
    img.src = url;
    if (!_tgAvatarImg) _tgAvatarImg = img;
  };
  load(true);
}

// ─────────────────────────────────────────────────────────
//  HUD PANEL SHELL
// ─────────────────────────────────────────────────────────
// Every floating HUD plate — the header, the minimap, the target frame, the
// party list — is the same shell: a glass-navy body, a lit frame, a highlight
// along the top edge and four corner ticks. Drawn from one place so the look
// only has to be changed once.
const HUD_FRAME     = 'rgba(104,178,240,0.55)';
const HUD_FRAME_DIM = 'rgba(104,178,240,0.26)';
const HUD_GLOW      = 'rgba(86,170,255,0.16)';
const HUD_TEXT      = '#dbe9f8';
const HUD_TEXT_DIM  = '#8fb0cd';

// Both header plates — the player one and the map one — are this tall, so
// they read as one row (hudMiniMapRect / drawHeader below).
const HUD_PLATE_H = hud(96);

function _hudCorners(x, y, w, h, len, color) {
  ctx.strokeStyle = color || 'rgba(150,215,255,0.7)';
  ctx.lineWidth = 1.6; ctx.lineCap = 'round';
  const corners = [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]];
  for (const [cx, cy, sx, sy] of corners) {
    ctx.beginPath();
    ctx.moveTo(cx + sx * 3, cy + sy * len);
    ctx.lineTo(cx + sx * 3, cy + sy * 3);
    ctx.lineTo(cx + sx * len, cy + sy * 3);
    ctx.stroke();
  }
  ctx.lineCap = 'butt';
}

// The whole HUD is redrawn at 15fps into a cached canvas (see _renderUI,
// js/game.js), so building these two gradients per panel per rebuild is
// nothing next to keeping them in sync with a resize.
function _hudPanel(x, y, w, h, r, frame) {
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, 'rgba(22,42,67,0.93)');
  g.addColorStop(1, 'rgba(8,15,26,0.95)');
  ctx.fillStyle = g;
  roundRect(ctx, x, y, w, h, r); ctx.fill();

  ctx.strokeStyle = HUD_GLOW; ctx.lineWidth = 3;
  roundRect(ctx, x - 1, y - 1, w + 2, h + 2, r + 1); ctx.stroke();
  ctx.strokeStyle = frame || HUD_FRAME; ctx.lineWidth = 1.2;
  roundRect(ctx, x, y, w, h, r); ctx.stroke();
  ctx.strokeStyle = 'rgba(150,210,255,0.13)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x + r, y + 1.5); ctx.lineTo(x + w - r, y + 1.5); ctx.stroke();

  _hudCorners(x, y, w, h, 10);
}

// A value bar (HP, XP, a party member's health) in the HUD's own style:
// sunken track, gradient fill, a shine along the top of the fill.
function _hudBar(x, y, w, h, pct, c0, c1, label, labelColor, fontScale) {
  // Snapped to whole device-independent pixels: a track/fill drawn on a
  // half-pixel boundary gets anti-aliased on both edges instead of one,
  // which is a second, smaller source of the same "blurry" look as the
  // undersized label font below.
  x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
  ctx.fillStyle = 'rgba(4,9,16,0.85)';
  roundRect(ctx, x, y, w, h, h / 2); ctx.fill();
  ctx.strokeStyle = 'rgba(96,160,220,0.30)'; ctx.lineWidth = 1;
  roundRect(ctx, x, y, w, h, h / 2); ctx.stroke();
  const fw = Math.max(0, Math.min(1, pct)) * (w - 2);
  if (fw > 1) {
    const g = ctx.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, c0); g.addColorStop(1, c1);
    ctx.fillStyle = g;
    roundRect(ctx, x + 1, y + 1, fw, h - 2, (h - 2) / 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    roundRect(ctx, x + 1, y + 1, fw, (h - 2) / 2, (h - 2) / 2); ctx.fill();
  }
  if (label) {
    // h*0.62 put the HP/XP readout at 6-7px on a scaled HUD — canvas text has
    // no hinting at that size, so it renders as a grey smear rather than
    // digits. Floored at 12 (scaled down again by fontScale for callers that
    // ask for it — the player's own HP/XP bar, now printing the full,
    // un-abbreviated number, wants it smaller so a long value still fits):
    // a thin bar's text overhangs it a little, which reads fine (it's how
    // most game HUDs draw health text) and beats "technically inside,
    // actually illegible."
    const fs = fontScale || 1;
    let fontPx = Math.max(Math.round(12 * fs), Math.round(h * 0.85 * fs));
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `bold ${fontPx}px system-ui, -apple-system, sans-serif`;
    // Shrink-to-fit: a full, comma-separated HP/XP number can run longer than
    // an abbreviated one ever did, and this is the guard against it running
    // past the bar's own ends.
    const maxTextW = w - 6;
    while (fontPx > 7 && ctx.measureText(label).width > maxTextW) {
      fontPx -= 0.5;
      ctx.font = `bold ${fontPx}px system-ui, -apple-system, sans-serif`;
    }
    const lx = Math.round(x + w / 2), ly = Math.round(y + h / 2 + 0.5);
    // A real stroke instead of a second offset fillText: the old approach
    // read as a soft shadow that blurred INTO the glyph at small sizes
    // rather than outlining it.
    ctx.lineJoin = 'round'; ctx.miterLimit = 2;
    ctx.lineWidth = Math.max(2.5, fontPx * 0.22);
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.strokeText(label, lx, ly);
    ctx.fillStyle = labelColor || '#f4f9ff';
    ctx.fillText(label, lx, ly);
  }
}

// Header numbers are read at a glance, not counted — 5.5B of gold in full is
// noise on a 60px chip. Anything under 10k keeps its exact value.
function _hudNum(v) {
  const n = Number(v) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(1) + 'K';
  if (n >= 100 || Number.isInteger(n)) return String(Math.floor(n));
  return n.toFixed(2);
}

// ─────────────────────────────────────────────────────────
//  UNIFIED HEADER  (player plate + floating minimap)
// ─────────────────────────────────────────────────────────
// The minimap is its own plate to the right of the player one and hangs
// below the header band, over the world — which is why the HUD's right-hand
// button column starts underneath it (_positionHudMenuBtn below).
function hudMiniMapRect() {
  // И потолок, и доля от ширины — обе через hud(): на узком экране размер
  // диктует доля, и оставить её прежней значило бы не уменьшить карту там,
  // где тесно как раз сильнее всего.
  const w = Math.round(Math.min(hud(96), W * 0.26 * HUD_SCALE));
  return { x: W - w - 8, y: 4, w, h: HUD_PLATE_H };
}

function drawMiniMapPanel() {
  const p = player;
  const mp = hudMiniMapRect();
  const _MM_RADIUS = 30;                       // tiles each direction from the player
  const mmX = mp.x + 3, mmY = mp.y + 3, mmW = mp.w - 6, mmH = mp.h - 6;
  const mmSc = mmW / (_MM_RADIUS * 2);
  const th = getTheme(dungeonLvl);
  // The window is only as square as the plate is: the player stays at its
  // centre either way, so the vertical span is measured off mmH rather than
  // assumed equal to the horizontal one.
  const winTilesX = mmW / mmSc, winTilesY = mmH / mmSc;
  const winTx = p.x / TILE - winTilesX / 2, winTy = p.y / TILE - winTilesY / 2;

  _hudPanel(mp.x, mp.y, mp.w, mp.h, 11);

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  roundRect(ctx, mmX, mmY, mmW, mmH, 8); ctx.clip();
  ctx.fillStyle = '#060b12'; ctx.fillRect(mmX, mmY, mmW, mmH);

  // The floor pattern only actually changes when the player crosses into a
  // new tile — this window's origin is float-precision but the underlying
  // grid isn't — so rebuilding a ~3700-rect path and filling it EVERY frame
  // (profiled at ~1.1ms, the single biggest chunk of drawHeader's cost) was
  // redoing the same work up to a dozen-plus times between actual changes.
  // Redraw the static pattern into an offscreen buffer only on a tile
  // crossing (or scale/theme change); every other frame just blits it,
  // repositioned for the current sub-tile offset.
  const _mmTileFx = Math.floor(winTx), _mmTileFy = Math.floor(winTy);
  if (!_mmTileCv || _mmTileCvTx !== _mmTileFx || _mmTileCvTy !== _mmTileFy || _mmTileCvSc !== mmSc || _mmTileCvTheme !== th.mmFloor) {
    _mmTileCvTx = _mmTileFx; _mmTileCvTy = _mmTileFy; _mmTileCvSc = mmSc; _mmTileCvTheme = th.mmFloor;
    const bufTilesX = Math.ceil(winTilesX) + _MM_MARGIN * 2 + 2;
    const bufTilesY = Math.ceil(winTilesY) + _MM_MARGIN * 2 + 2;
    const bufPxX = Math.ceil(bufTilesX * mmSc), bufPxY = Math.ceil(bufTilesY * mmSc);
    if (!_mmTileCv) _mmTileCv = document.createElement('canvas');
    if (_mmTileCv.width !== bufPxX || _mmTileCv.height !== bufPxY) { _mmTileCv.width = bufPxX; _mmTileCv.height = bufPxY; }
    const mctx = _mmTileCv.getContext('2d');
    mctx.clearRect(0, 0, bufPxX, bufPxY);
    mctx.fillStyle = th.mmFloor;
    mctx.beginPath();
    const bufTx0 = _mmTileFx - _MM_MARGIN, bufTy0 = _mmTileFy - _MM_MARGIN;
    const tx0 = Math.max(0, bufTx0), tx1 = Math.min(dungeon.w - 1, bufTx0 + bufTilesX - 1);
    const ty0 = Math.max(0, bufTy0), ty1 = Math.min(dungeon.h - 1, bufTy0 + bufTilesY - 1);
    for (let ty = ty0; ty <= ty1; ty++) {
      const row = dungeon.grid[ty];
      for (let tx = tx0; tx <= tx1; tx++) {
        if (row[tx] === WALL) continue;
        mctx.rect((tx - bufTx0) * mmSc, (ty - bufTy0) * mmSc, Math.max(1, Math.ceil(mmSc)), Math.max(1, Math.ceil(mmSc)));
      }
    }
    mctx.fill();
  }
  const _mmBlitX = mmX - (winTx - (_mmTileCvTx - _MM_MARGIN)) * mmSc;
  const _mmBlitY = mmY - (winTy - (_mmTileCvTy - _MM_MARGIN)) * mmSc;
  // Half strength: each location's own floor colour still identifies where you
  // are, but at full opacity it shouts over the blips, which are the point.
  ctx.globalAlpha = 0.42;
  ctx.drawImage(_mmTileCv, _mmBlitX, _mmBlitY);
  ctx.globalAlpha = 1;

  const mmEnemies = serverEnemies;
  const _mmR = Math.max(1, mmSc * 0.8);
  ctx.fillStyle = 'rgba(233,55,76,0.9)';
  ctx.beginPath();
  mmEnemies.forEach(e => {
    if ((e.hp || 0) <= 0 || e.isBoss) return;
    const ex = mmX + (e.x / TILE - winTx) * mmSc, ey = mmY + (e.y / TILE - winTy) * mmSc;
    ctx.moveTo(ex + _mmR, ey); ctx.arc(ex, ey, _mmR, 0, Math.PI * 2);
  });
  ctx.fill();
  // Boss skull icon on minimap
  const _bossIconSz = Math.max(8, Math.round(mmSc * 4));
  ctx.font = `${_bossIconSz}px serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  mmEnemies.forEach(e => {
    if ((e.hp || 0) <= 0 || !e.isBoss) return;
    const ex = mmX + (e.x / TILE - winTx) * mmSc, ey = mmY + (e.y / TILE - winTy) * mmSc;
    ctx.fillText('💀', ex, ey);
  });
  const _mmRn = Math.max(1, mmSc);
  ctx.fillStyle = 'rgba(240,168,60,0.95)';
  ctx.beginPath();
  npcs.forEach(n => {
    const nx = mmX + (n.x / TILE - winTx) * mmSc, ny = mmY + (n.y / TILE - winTy) * mmSc;
    ctx.moveTo(nx + _mmRn, ny); ctx.arc(nx, ny, _mmRn, 0, Math.PI * 2);
  });
  ctx.fill();
  if (socket?.connected) {
    const _mmRop = Math.max(1.5, mmSc);
    ctx.fillStyle = 'rgba(126,196,255,0.95)';
    ctx.beginPath();
    otherPlayers.forEach(op => {
      if (op.x == null) return;
      const ox = mmX + (op.x / TILE - winTx) * mmSc, oy = mmY + (op.y / TILE - winTy) * mmSc;
      ctx.moveTo(ox + _mmRop, oy); ctx.arc(ox, oy, _mmRop, 0, Math.PI * 2);
    });
    ctx.fill();
  }
  // Player is always at the window's center
  const pdx = mmX + mmW / 2, pdy = mmY + mmH / 2;
  ctx.fillStyle = 'rgba(121,220,35,0.28)';
  ctx.beginPath(); ctx.arc(pdx, pdy, 5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#8dee46';
  ctx.beginPath(); ctx.arc(pdx, pdy, 2.5, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  ctx.strokeStyle = HUD_FRAME_DIM; ctx.lineWidth = 1;
  roundRect(ctx, mmX, mmY, mmW, mmH, 8); ctx.stroke();
}

function drawHeader() {
  if (!player || !dungeon) return;
  const p = player;
  const F = 'system-ui, -apple-system, sans-serif';

  ctx.save();

  drawMiniMapPanel();

  // ── Player plate ──────────────────────────────────────────
  const mp = hudMiniMapRect();
  // Всё внутри плашки разложено под ЕЁ высоту, а она уменьшается вместе с
  // остальным HUD. Поэтому здесь исходные числа, пропущенные через hud() и
  // hudF(): иначе аватар, полосы и чипы остались бы прежними в плашке,
  // которая под них уже мала.
  const px = hud(6), py = hud(4), pw = mp.x - px - hud(4), ph = HUD_PLATE_H;
  const pRight = px + pw - hud(11);
  _hudPanel(px, py, pw, ph, 12);

  // ── Avatar + level badge ──────────────────────────────────
  const avR = hud(25), avX = px + hud(30), avY = py + hud(32);
  const hasTgAvatar = _tgAvatarReady && _tgAvatarImg;
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.beginPath(); ctx.arc(avX, avY, avR, 0, Math.PI * 2); ctx.fill();
  if (hasTgAvatar) {
    ctx.save();
    ctx.beginPath(); ctx.arc(avX, avY, avR, 0, Math.PI * 2); ctx.clip();
    ctx.drawImage(_tgAvatarImg, avX - avR, avY - avR, avR * 2, avR * 2);
    ctx.restore();
  } else {
    if (!_avBgGrad || _avBgColor !== p.charDef.color) {
      _avBgGrad = ctx.createRadialGradient(avX - 6, avY - 6, 2, avX, avY, avR);
      _avBgGrad.addColorStop(0, p.charDef.color + '55');
      _avBgGrad.addColorStop(1, 'rgba(4,9,17,0.85)');
      _avBgColor = p.charDef.color;
    }
    ctx.fillStyle = _avBgGrad;
    ctx.beginPath(); ctx.arc(avX, avY, avR, 0, Math.PI * 2); ctx.fill();
    drawIconCtx(ctx, p.charDef.icon, avX, avY + 1, 26, p.charDef.color);
  }
  ctx.strokeStyle = 'rgba(122,196,255,0.85)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(avX, avY, avR, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = p.charDef.color + '55'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(avX, avY, avR + hud(3), 0, Math.PI * 2); ctx.stroke();

  const lbR = hud(11), lbX = avX - hud(14), lbY = avY + avR - 2;
  ctx.fillStyle = 'rgba(9,18,31,0.96)';
  ctx.beginPath(); ctx.arc(lbX, lbY, lbR, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(240,196,110,0.9)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(lbX, lbY, lbR, 0, Math.PI * 2); ctx.stroke();
  ctx.font = `bold ${hudF(11)}px ${F}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#f4d9a4';
  ctx.fillText(p.lvl, lbX, lbY + 0.5);

  // ── Name + class ──────────────────────────────────────────
  const infoX = avX + avR + hud(12);
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  ctx.font = `bold ${hudF(14)}px ${F}`; ctx.fillStyle = HUD_TEXT;
  ctx.fillText((netUsername || p.charDef.name).slice(0, 14), infoX, py + hud(20));
  ctx.font = `${hudF(11)}px ${F}`; ctx.fillStyle = p.charDef.color + 'e0';
  ctx.fillText(p.charDef.name, infoX, py + hud(35));
  // БМ (battle might) reads as part of the class line — "Танк БМ 3150" — not
  // as a currency, so it sits here rather than in the chip row below.
  const bmX = infoX + ctx.measureText(p.charDef.name).width + hud(8);
  ctx.font = `bold ${hudF(9)}px ${F}`; ctx.fillStyle = 'rgba(240,196,110,0.8)';
  ctx.fillText(t('bmAbbrev'), bmX, py + hud(35));
  const bmLblW = ctx.measureText(t('bmAbbrev')).width;
  ctx.font = `bold ${hudF(11)}px ${F}`; ctx.fillStyle = '#f0c46e';
  ctx.fillText(_hudNum(typeof calcBM === 'function' ? calcBM(p) : 0), bmX + bmLblW + hud(4), py + hud(35));

  // ── HP / XP ───────────────────────────────────────────────
  // Full numbers, not _hudNum's K/M/B rounding: unlike the BM figure above,
  // this is the one pair of stats a player actually reads exact values off
  // of moment to moment. fontScale 0.7 makes room for the longer string —
  // see _hudBar's shrink-to-fit for the rest of that margin.
  const barX = infoX, barW = pRight - infoX;
  _hudBar(barX, py + hud(42), barW, hud(12),
    p.maxHp ? p.hp / p.maxHp : 0,
    '#2f7a2a', '#5fd45a',
    Math.ceil(p.hp).toLocaleString() + ' / ' + Math.floor(p.maxHp).toLocaleString(),
    null, 0.7);
  // Floor the XP readout: party kills split their reward (result.xp / members
  // on the server), so xp is legitimately fractional and float addition turns
  // that into "858.9999999999418" on the bar.
  _hudBar(barX, py + hud(58), barW, hud(10),
    p.xpNext ? p.xp / p.xpNext : 0,
    '#8a5a12', '#f0a63c',
    Math.floor(p.xp).toLocaleString() + ' / ' + Math.floor(p.xpNext).toLocaleString(),
    null, 0.7);

  // ── Currency chips ────────────────────────────────────────
  // Liberty (Nexum) is the balance players track exactly — teleport stones,
  // gear crafting and pet crafting all cost precise Nexum amounts — so it is
  // spelled out in full instead of through _hudNum's K/M/B rounding, which
  // is fine for a glance at gold but hides the figure players need here.
  const chipY = py + hud(74), chipH = hud(20), chipGap = hud(5), chipX0 = px + hud(10);
  const _nxBal = window._nexumBalance || 0;
  const _grBal = window._gramBalance || 0;
  const chips = [
    { icon: 'coin', color: '#f0b44a', val: _hudNum(p.gold) },
    { img: '/images/nexum-coin_v2.png', color: '#5fe08f', val: Math.floor(_nxBal).toLocaleString() },
    { img: '/images/gram-icon.png', color: '#7fd0ff', val: _grBal >= 1000 ? _hudNum(_grBal) : _grBal.toFixed(2) },
  ];
  const chipW = (pRight + 1 - chipX0 - chipGap * (chips.length - 1)) / chips.length;
  ctx.textBaseline = 'middle';
  for (let i = 0; i < chips.length; i++) {
    const c = chips[i], cx = chipX0 + i * (chipW + chipGap);
    ctx.fillStyle = 'rgba(9,19,32,0.85)';
    roundRect(ctx, cx, chipY, chipW, chipH, hud(9)); ctx.fill();
    ctx.strokeStyle = 'rgba(96,160,220,0.30)'; ctx.lineWidth = 1;
    roundRect(ctx, cx, chipY, chipW, chipH, hud(9)); ctx.stroke();
    if (c.img) {
      const img = _getPotImg(c.img);
      if (img && img.complete && img.naturalWidth > 0) ctx.drawImage(img, cx + hud(3), chipY + hud(4), hud(12), hud(12));
      else drawIconCtx(ctx, 'coin', cx + hud(9), chipY + chipH / 2, hud(11), c.color);
    } else {
      drawIconCtx(ctx, c.icon, cx + hud(9), chipY + chipH / 2, hud(11), c.color);
    }
    // Same 8px-with-no-hinting illegibility as the HP/XP bars, plus a
    // shrink-to-fit so an un-rounded Liberty balance stays inside its chip
    // instead of running under the next one.
    const textX = cx + hud(19), maxTextW = cx + chipW - hud(4) - textX;
    let fontPx = Math.max(11, hudF(13));
    ctx.font = `bold ${fontPx}px ${F}`;
    while (fontPx > 8 && ctx.measureText(c.val).width > maxTextW) {
      fontPx -= 0.5;
      ctx.font = `bold ${fontPx}px ${F}`;
    }
    ctx.textAlign = 'left';
    ctx.lineJoin = 'round'; ctx.lineWidth = 2.2;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(c.val, textX, chipY + chipH / 2 + 0.5);
    ctx.fillStyle = c.color;
    ctx.fillText(c.val, textX, chipY + chipH / 2 + 0.5);
  }

  ctx.restore();
}

// ─────────────────────────────────────────────────────────
//  JOYSTICK
// ─────────────────────────────────────────────────────────
// ── прозрачность ──────────────────────────────────────────────────────────
// Джойстик лежит поверх мира в нижней трети экрана — там, куда игрок идёт.
// Непрозрачная база закрывает ровно то место, на которое он смотрит, когда
// решает, куда шагнуть; поэтому прозрачность здесь не украшение, а
// настройка управления, и её ставит игрок, а не я.
//
// В localStorage, а не на сервере: это свойство ЭКРАНА, а не аккаунта. На
// телефоне под солнцем нужно плотнее, на планшете дома — легче, и синхрон
// между устройствами тут был бы вредом.
const JOY_ALPHA_MIN = 0.15, JOY_ALPHA_MAX = 1;
let _joyAlpha = null;
function joyAlpha() {
  if (_joyAlpha === null) {
    let v;
    // Приватный режим и заблокированные куки бросают на самом ЧТЕНИИ, а не
    // возвращают null. Непойманное — это чёрный экран вместо игры.
    try { v = parseFloat(localStorage.getItem('liberty.joyAlpha')); } catch (e) { v = NaN; }
    _joyAlpha = Number.isFinite(v) ? Math.min(JOY_ALPHA_MAX, Math.max(JOY_ALPHA_MIN, v)) : 0.66;
  }
  return _joyAlpha;
}
function setJoyAlpha(v) {
  const n = Math.min(JOY_ALPHA_MAX, Math.max(JOY_ALPHA_MIN, Number(v)));
  if (!Number.isFinite(n)) return;
  _joyAlpha = n;
  try { localStorage.setItem('liberty.joyAlpha', String(n)); } catch (e) { /* приватный режим */ }
}

let _joyKnobGrad = null, _joyKnobGradKx = null, _joyKnobGradKy = null;
// Ring, four direction arrows, four studs on the diagonals, and a knob that
// lights up while it is being pushed — the arrows are what make it read as a
// pad rather than a circle drawn on the floor.
function drawJoystick() {
  const jc = joyCenter();
  const held = joy.active && (joy.dx || joy.dy);

  ctx.save();
  // Значение ползунка (Профиль → Звук) — это покой; под пальцем джойстик
  // всё равно плотнее, иначе настройка «почти прозрачно» отняла бы у игрока
  // и то, чем он целится.
  const _ja = joyAlpha();
  ctx.globalAlpha = held ? Math.min(1, _ja + 0.29) : _ja;

  const ring = ctx.createRadialGradient(jc.x, jc.y, JOY_R * 0.55, jc.x, jc.y, JOY_R);
  ring.addColorStop(0, 'rgba(10,20,34,0.10)');
  ring.addColorStop(1, 'rgba(12,26,45,0.55)');
  ctx.fillStyle = ring;
  ctx.beginPath(); ctx.arc(jc.x, jc.y, JOY_R, 0, Math.PI * 2); ctx.fill();

  ctx.strokeStyle = 'rgba(104,178,240,0.60)'; ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.arc(jc.x, jc.y, JOY_R, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = 'rgba(86,170,255,0.16)'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(jc.x, jc.y, JOY_R + 3, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = 'rgba(104,178,240,0.18)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(jc.x, jc.y, JOY_R * 0.62, 0, Math.PI * 2); ctx.stroke();

  // Direction arrows (N/E/S/W) and diamond studs on the diagonals
  const ar = JOY_R - 11;
  ctx.fillStyle = 'rgba(140,206,255,0.72)';
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 - Math.PI / 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const tx = jc.x + ca * ar, ty = jc.y + sa * ar;
    ctx.beginPath();
    ctx.moveTo(tx + ca * 5, ty + sa * 5);
    ctx.lineTo(tx - ca * 3 - sa * 5, ty - sa * 3 + ca * 5);
    ctx.lineTo(tx - ca * 3 + sa * 5, ty - sa * 3 - ca * 5);
    ctx.closePath(); ctx.fill();
  }
  ctx.fillStyle = 'rgba(122,196,255,0.85)';
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 - Math.PI / 4;
    const sx = jc.x + Math.cos(a) * JOY_R, sy = jc.y + Math.sin(a) * JOY_R;
    ctx.beginPath();
    ctx.moveTo(sx, sy - 4); ctx.lineTo(sx + 4, sy); ctx.lineTo(sx, sy + 4); ctx.lineTo(sx - 4, sy);
    ctx.closePath(); ctx.fill();
  }

  // Knob
  const kx = jc.x + joy.dx * JOY_R, ky = jc.y + joy.dy * JOY_R;
  if (_joyKnobGrad === null || kx !== _joyKnobGradKx || ky !== _joyKnobGradKy) {
    _joyKnobGrad = ctx.createRadialGradient(kx - JOY_KNOB * .35, ky - JOY_KNOB * .35, 0, kx, ky, JOY_KNOB);
    _joyKnobGrad.addColorStop(0, 'rgba(150,205,255,0.95)');
    _joyKnobGrad.addColorStop(1, 'rgba(30,66,110,0.92)');
    _joyKnobGradKx = kx; _joyKnobGradKy = ky;
  }
  ctx.fillStyle = 'rgba(86,170,255,0.18)';
  ctx.beginPath(); ctx.arc(kx, ky, JOY_KNOB + 5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = _joyKnobGrad;
  ctx.beginPath(); ctx.arc(kx, ky, JOY_KNOB, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(178,224,255,0.85)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(kx, ky, JOY_KNOB, 0, Math.PI * 2); ctx.stroke();

  ctx.restore();
}

// ─────────────────────────────────────────────────────────
//  ACTION FAN BACKDROP
// ─────────────────────────────────────────────────────────
// The tray the four skill buttons ride on, plus the collar around the attack
// hub at its centre. Geometry comes from fanCenter()/fanPos() in js/input.js,
// so this and the buttons (and the hit tests) can never drift apart. Purely
// decorative — nothing here is touchable.
const FAN_TRAY_IN = hud(60), FAN_TRAY_OUT = hud(126);   // skill tray
// Swept counter-clockwise, far enough round to seat the lowest skill button
// whole. Both ends run off the screen — the near one past the right edge, the
// far one under the bottom nav — and are simply clipped there, the way the
// tray is meant to read: as a wheel the screen corner cuts into.
const FAN_TRAY_A0 = -44, FAN_TRAY_A1 = -210;
const FAN_COLLAR_IN = hud(46), FAN_COLLAR_OUT = hud(57);

// Annular sector from a0° to a1°, swept counter-clockwise (a1 < a0)
function _fanSector(c, rIn, rOut, a0, a1) {
  const r0 = a0 * Math.PI / 180, r1 = a1 * Math.PI / 180;
  ctx.beginPath();
  ctx.arc(c.x, c.y, rOut, r0, r1, true);
  ctx.arc(c.x, c.y, rIn,  r1, r0, false);
  ctx.closePath();
}

function _fanGem(x, y, s) {
  ctx.beginPath();
  ctx.moveTo(x, y - s); ctx.lineTo(x + s, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s, y);
  ctx.closePath(); ctx.fill();
}

function drawActionFan() {
  if (!player) return;
  if (!_uiBtnGrads) _buildUiBtnGrads();
  const c = _uiBtnGrads.fanC;

  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, W, H - NAV_H); ctx.clip();

  _fanSector(c, FAN_TRAY_IN, FAN_TRAY_OUT, FAN_TRAY_A0, FAN_TRAY_A1);
  ctx.fillStyle = _uiBtnGrads.fanBg; ctx.fill();
  ctx.strokeStyle = 'rgba(203,161,89,0.34)'; ctx.lineWidth = 1.5; ctx.stroke();

  // A hairline between each pair of seats, so the tray reads as four slots
  // rather than one band — and a gem on the rim above each one.
  const rims = [FAN_TRAY_A0, FAN_TRAY_A1];
  ctx.strokeStyle = 'rgba(203,161,89,0.16)'; ctx.lineWidth = 1;
  for (let i = 0; i < 3; i++) {
    const deg = (fanSkillAngle(i) + fanSkillAngle(i + 1)) / 2;
    rims.push(deg);
    const a = deg * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
    ctx.beginPath();
    ctx.moveTo(c.x + FAN_TRAY_IN * ca,  c.y + FAN_TRAY_IN * sa);
    ctx.lineTo(c.x + FAN_TRAY_OUT * ca, c.y + FAN_TRAY_OUT * sa);
    ctx.stroke();
  }

  _fanSector(c, FAN_COLLAR_IN, FAN_COLLAR_OUT, FAN_TRAY_A0 + 6, FAN_TRAY_A1 - 6);
  ctx.fillStyle = _uiBtnGrads.fanCollar; ctx.fill();
  ctx.strokeStyle = 'rgba(203,161,89,0.30)'; ctx.lineWidth = 1; ctx.stroke();

  ctx.fillStyle = 'rgba(203,161,89,0.5)';
  for (const deg of rims) {
    const a = deg * Math.PI / 180;
    const gx = c.x + FAN_TRAY_OUT * Math.cos(a), gy = c.y + FAN_TRAY_OUT * Math.sin(a);
    if (gx > W - 6 || gy > H - NAV_H - 6) continue;  // half a gem on the cut edges reads as dirt
    _fanGem(gx, gy, 3.5);
  }

  ctx.restore();
}

// ─────────────────────────────────────────────────────────
//  SKILL BUTTONS (on the fan's arc — getSkillBtnPos, js/input.js)
// ─────────────────────────────────────────────────────────
// Gradient cache: 4 buttons × 3 states (flash / ready / cooldown)
// Invalidated on resize via _skillBtnGradCache = null in game.js
let _skillBtnGradCache = null;
function _buildSkillBtnGrads() {
  _skillBtnGradCache = Array.from({ length: 4 }, (_, i) => {
    const b = getSkillBtnPos(i);
    const flash = ctx.createLinearGradient(b.x, b.y, b.x, b.y + b.h);
    flash.addColorStop(0, 'rgba(31,53,83,0.97)'); flash.addColorStop(1, 'rgba(16,28,43,0.99)');
    const ready = ctx.createLinearGradient(b.x, b.y, b.x, b.y + b.h);
    ready.addColorStop(0, 'rgba(19,33,51,0.97)'); ready.addColorStop(1, 'rgba(10,17,26,0.99)');
    const cd = ctx.createLinearGradient(b.x, b.y, b.x, b.y + b.h);
    cd.addColorStop(0, 'rgba(11,19,30,0.97)'); cd.addColorStop(1, 'rgba(7,11,18,0.99)');
    return { flash, ready, cd, x: b.x, y: b.y, w: b.w, h: b.h };
  });
}

const _F_SKILL = 'system-ui, -apple-system, Arial';
function drawSkillButtons() {
  if (!player) return;
  const skills = SKILL_DEF[player.type];
  if (!skills) return;
  if (!_skillBtnGradCache) _buildSkillBtnGrads();

  for (let i = 0; i < 4; i++) {
    // Resolved to whichever version (base/advanced) is active — key/cd/level
    // are identical either way (see _activeSkillDef, js/player.js), only the
    // icon/art shown here differs.
    const sk = (typeof _activeSkillDef === 'function') ? _activeSkillDef(player.type, i) : skills[i];
    const grads = _skillBtnGradCache[i];
    const b = grads; // positions cached inside grads
    const locked = ((player.skillLevels || {})[sk.key] || 0) <= 0;
    const cd = player.skillCooldowns[sk.key] || 0;
    const ready = !locked && cd <= 0;
    const isFlash = skillFlash && skillFlash.key === sk.key && skillFlash.timer > 0;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const r = b.w / 2;

    // Background gradient (cached) — circular
    ctx.fillStyle = isFlash ? grads.flash : ready ? grads.ready : grads.cd;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();

    // Icon — clipped to the circle and scaled to fully cover it, no padding
    // and no key-letter label, so the art fills the whole button.
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r - 1.5, 0, Math.PI * 2); ctx.clip();
    ctx.globalAlpha = ready ? 1 : 0.45;
    const img = sk.img ? _getPotImg(sk.img) : null;
    if (img && img.complete && img.naturalWidth > 0) {
      const d = r * 2;
      ctx.drawImage(img, cx - d / 2, cy - d / 2, d, d);
    } else {
      drawIconCtx(ctx, sk.icon, cx, cy, r * 1.3, ready ? '#f2d39c' : '#3d7eac');
    }
    if (!ready) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    ctx.globalAlpha = 1;

    // Border
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = isFlash ? 'rgba(234,167,66,0.95)' : ready ? 'rgba(203,161,89,0.7)' : 'rgba(32,56,87,0.7)';
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();

    // Not-yet-studied skills show a lock instead of a cooldown countdown
    if (locked) {
      drawIconCtx(ctx, 'lock', cx, cy, r * 0.85, '#c1ccd5');
    } else if (!ready) {
      ctx.font = `bold ${hudF(14)}px ${_F_SKILL}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
      ctx.fillStyle = '#c1ccd5';
      ctx.fillText(cd >= 10 ? Math.ceil(cd) : cd.toFixed(1), cx, cy);
    }
  }
}

// ─────────────────────────────────────────────────────────
//  CACHED BUTTON GRADIENTS  (rebuilt only on resize / first call)
// ─────────────────────────────────────────────────────────
function _buildUiBtnGrads() {
  const pb  = getPotionBtnPos();
  const tb  = getTargetBtnPos();
  const ab  = getAttackBtnPos();
  const aab = getAutoBtnPos();
  const pvp = getPvpBtnPos();
  const prof = getProfessionBtnPos();
  const cc  = getClassChangeBtnPos();
  const pty = getPartyBtnPos();

  const pg0 = ctx.createRadialGradient(pb.x-5, pb.y-5, 2, pb.x, pb.y, pb.r);
  pg0.addColorStop(0,'rgba(16,27,42,0.98)'); pg0.addColorStop(1,'rgba(9,16,25,0.99)');
  const pg1 = ctx.createRadialGradient(pb.x-5, pb.y-5, 2, pb.x, pb.y, pb.r);
  pg1.addColorStop(0,'rgba(44,63,27,0.98)'); pg1.addColorStop(1,'rgba(18,27,11,0.99)');

  const tg0 = ctx.createRadialGradient(tb.x-4, tb.y-4, 2, tb.x, tb.y, tb.r);
  tg0.addColorStop(0,'rgba(16,27,42,0.98)'); tg0.addColorStop(1,'rgba(9,16,25,0.99)');
  const tg1 = ctx.createRadialGradient(tb.x-4, tb.y-4, 2, tb.x, tb.y, tb.r);
  tg1.addColorStop(0,'rgba(52,13,18,0.98)'); tg1.addColorStop(1,'rgba(24,6,8,0.99)');

  const pvg0 = ctx.createLinearGradient(pvp.x, pvp.y, pvp.x, pvp.y+pvp.h);
  pvg0.addColorStop(0,'rgba(16,27,42,0.97)'); pvg0.addColorStop(1,'rgba(9,16,25,0.99)');
  const pvg1 = ctx.createLinearGradient(pvp.x, pvp.y, pvp.x, pvp.y+pvp.h);
  pvg1.addColorStop(0,'rgba(66,14,20,0.98)'); pvg1.addColorStop(1,'rgba(33,7,10,0.99)');

  const pfg0 = ctx.createLinearGradient(prof.x, prof.y, prof.x, prof.y+prof.h);
  pfg0.addColorStop(0,'rgba(16,27,42,0.97)'); pfg0.addColorStop(1,'rgba(9,16,25,0.99)');
  const pfg1 = ctx.createLinearGradient(prof.x, prof.y, prof.x, prof.y+prof.h);
  pfg1.addColorStop(0,'rgba(44,30,66,0.97)'); pfg1.addColorStop(1,'rgba(21,13,32,0.99)');


  const ptg0 = ctx.createLinearGradient(pty.x, pty.y, pty.x, pty.y+pty.h);
  ptg0.addColorStop(0,'rgba(24,36,14,0.97)'); ptg0.addColorStop(1,'rgba(12,18,7,0.99)');
  const ptg1 = ctx.createLinearGradient(pty.x, pty.y, pty.x, pty.y+pty.h);
  ptg1.addColorStop(0,'rgba(47,13,17,0.97)'); ptg1.addColorStop(1,'rgba(24,6,8,0.99)');

  const ag0 = ctx.createRadialGradient(ab.x-6, ab.y-6, 3, ab.x, ab.y, ab.r);
  ag0.addColorStop(0,'rgba(14,24,37,0.90)'); ag0.addColorStop(1,'rgba(8,13,20,0.92)');
  const ag1 = ctx.createRadialGradient(ab.x-6, ab.y-6, 3, ab.x, ab.y, ab.r);
  ag1.addColorStop(0,'rgba(56,14,19,0.98)'); ag1.addColorStop(1,'rgba(26,7,9,0.99)');
  const ag2 = ctx.createRadialGradient(ab.x-6, ab.y-6, 3, ab.x, ab.y, ab.r);
  ag2.addColorStop(0,'rgba(19,33,51,0.98)'); ag2.addColorStop(1,'rgba(10,17,26,0.99)');

  const aag0 = ctx.createLinearGradient(aab.x, aab.y, aab.x, aab.y+aab.h);
  aag0.addColorStop(0,'rgba(33,7,10,0.95)'); aag0.addColorStop(1,'rgba(17,4,6,0.97)');
  const aag1 = ctx.createLinearGradient(aab.x, aab.y, aab.x, aab.y+aab.h);
  aag1.addColorStop(0,'rgba(22,32,13,0.95)'); aag1.addColorStop(1,'rgba(11,16,7,0.97)');

  // Action-fan backdrop (drawActionFan below) — concentric with the attack hub
  const fc = fanCenter();
  const fanBg = ctx.createRadialGradient(fc.x, fc.y, FAN_R_ATK, fc.x, fc.y, FAN_TRAY_OUT);
  fanBg.addColorStop(0,'rgba(14,24,37,0.88)'); fanBg.addColorStop(1,'rgba(6,10,16,0.66)');
  const fanCollar = ctx.createRadialGradient(fc.x, fc.y, FAN_COLLAR_IN, fc.x, fc.y, FAN_COLLAR_OUT);
  fanCollar.addColorStop(0,'rgba(23,40,62,0.88)'); fanCollar.addColorStop(1,'rgba(10,17,26,0.88)');

  // Cache positions too — avoids creating new objects every _renderUI() call
  _uiBtnGrads = { pg0, pg1, tg0, tg1, pvg0, pvg1, pfg0, pfg1, ptg0, ptg1, ag0, ag1, ag2, aag0, aag1,
                  fanBg, fanCollar, fanC: fc,
                  potBtn: pb, tgtBtn: tb, atkBtn: ab, autoBtn: aab, pvpBtn: pvp, profBtn: prof,
                  ccBtn: cc, ptyBtn: pty };
}

// ─────────────────────────────────────────────────────────
//  POTION BUTTON
// ─────────────────────────────────────────────────────────
const _potImgCache = {};
function _getPotImg(src) {
  if (!src) return null;
  if (!_potImgCache[src]) {
    const img = new Image();
    img.src = src;
    _potImgCache[src] = img;
  }
  return _potImgCache[src];
}

function drawPotionButton() {
  if (!player) return;
  if (!_uiBtnGrads) _buildUiBtnGrads();
  const pb = _uiBtnGrads.potBtn;
  const bag = player.potionBag || {};
  const hudPt = player.hudPotion || 'pt1';
  const count = bag[hudPt] || 0;
  const ready = count > 0 && player.hp < player.maxHp;
  const cd = player.potCd || 0;
  const F = 'system-ui, -apple-system, Arial';

  ctx.save();

  // Circle background (cached gradient)
  ctx.fillStyle = ready && cd <= 0 ? _uiBtnGrads.pg1 : _uiBtnGrads.pg0;
  ctx.beginPath(); ctx.arc(pb.x, pb.y, pb.r, 0, Math.PI * 2); ctx.fill();

  ctx.strokeStyle = ready && cd <= 0 ? 'rgba(127,181,79,0.75)' : 'rgba(41,72,112,0.6)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(pb.x, pb.y, pb.r, 0, Math.PI * 2); ctx.stroke();
  if (ready && cd <= 0) {
    ctx.strokeStyle = 'rgba(144,199,96,0.15)'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(pb.x, pb.y, pb.r + 2, 0, Math.PI * 2); ctx.stroke();
  }

  // Draw PNG image or fallback SVG icon
  const hudDef = ITEM_DEF.find(d => d.id === hudPt);
  ctx.globalAlpha = ready && cd <= 0 ? 1 : 0.45;
  if (hudDef && hudDef.img) {
    const img = _getPotImg(hudDef.img);
    if (img && img.complete && img.naturalWidth > 0) {
      const is = Math.round(pb.r * 0.85);
      ctx.drawImage(img, pb.x - is / 2, pb.y - is / 2 - 5, is, is);
    } else {
      drawIconCtx(ctx, 'potion', pb.x, pb.y - 5, Math.round(pb.r * 0.69), '#3d7eac');
    }
  } else {
    drawIconCtx(ctx, 'potion', pb.x, pb.y - 5, Math.round(pb.r * 0.69), ready && cd <= 0 ? '#90d653' : '#3d7eac');
  }

  ctx.globalAlpha = 1;
  ctx.font = `bold ${hudF(10)}px ${F}`; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = ready && cd <= 0 ? '#90d653' : 'rgba(62,129,177,0.7)';
  ctx.fillText('×' + count, pb.x, pb.y + pb.r - 3);

  // Show cooldown if active
  if (cd > 0) {
    ctx.font = `bold ${hudF(9)}px ${F}`; ctx.fillStyle = '#f17e8b';
    ctx.fillText(cd.toFixed(1) + t('secAbbrev'), pb.x, pb.y + pb.r + 10);
  } else {
    ctx.font = `${hudF(7)}px ${F}`; ctx.fillStyle = 'rgba(109,131,161,0.55)';
    ctx.fillText('[F]', pb.x, pb.y + pb.r + 10);
  }

  ctx.restore();
}

// ─────────────────────────────────────────────────────────
//  TARGET BUTTON
// ─────────────────────────────────────────────────────────
function drawTargetButton() {
  if (!player) return;
  if (!_uiBtnGrads) _buildUiBtnGrads();
  const tb = _uiBtnGrads.tgtBtn;
  const hasTarget = !!targetId;

  ctx.save();

  ctx.fillStyle = hasTarget ? _uiBtnGrads.tg1 : _uiBtnGrads.tg0;
  ctx.beginPath(); ctx.arc(tb.x, tb.y, tb.r, 0, Math.PI * 2); ctx.fill();

  ctx.strokeStyle = hasTarget ? 'rgba(235,73,92,0.85)' : 'rgba(47,98,135,0.6)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(tb.x, tb.y, tb.r, 0, Math.PI * 2); ctx.stroke();
  if (hasTarget) {
    ctx.strokeStyle = 'rgba(235,73,92,0.15)'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(tb.x, tb.y, tb.r + 2, 0, Math.PI * 2); ctx.stroke();
  }

  drawIconCtx(ctx, 'crosshair', tb.x, tb.y, hud(20), hasTarget ? '#f17e8b' : '#a49783');

  ctx.restore();
}

// ─────────────────────────────────────────────────────────
//  BUFF / DEBUFF STRIP  (left of skill panel)
// ─────────────────────────────────────────────────────────
// Размер фишки и раскладка её мест — отдельно от рисования, потому что
// «ничего ни на что не налезает» иначе остаётся обещанием, которое каждый
// раз проверяют глазами по скриншоту. Так это считает dev/render-check.html
// ТЕМ ЖЕ кодом, которым рисуется, а не своей копией формулы.
const BUFF_CHIP_SZ = hud(22);
const BUFF_SEATS = 11;
const BUFF_R0 = FAN_R_SKILL + hud(46), BUFF_RING_STEP = hud(28);
const BUFF_A0 = -100, BUFF_A_END = -200;
const BUFF_RINGS = 8;

function buffSeats(count) {
  const HALF = BUFF_CHIP_SZ / 2;
  const A_STEP = (BUFF_A0 - BUFF_A_END) / (BUFF_SEATS - 1);
  const FLOOR = H - NAV_H - 4;
  const cpEl = typeof document !== 'undefined' ? document.getElementById('chat-preview') : null;
  const chatUp = !!(cpEl && cpEl.style.display && cpEl.style.display !== 'none');
  const CHAT_TOP = H - 118, CHAT_BOT = H - 72;
  const CHAT_RIGHT = chatUp ? 58 + Math.min(170, W - 250) + 6 : -1e4;
  const jc = joyCenter();
  const pb = getPotionBtnPos(), tb = getTargetBtnPos();
  const seats = [];
  for (let ring = 0; ring < BUFF_RINGS && seats.length < count; ring++) {
    const r = BUFF_R0 + ring * BUFF_RING_STEP;
    for (let i = 0; i < BUFF_SEATS && seats.length < count; i++) {
      const p = fanPos(r, BUFF_A0 - i * A_STEP);
      if (p.y + HALF > FLOOR) continue;
      if (p.y + HALF > CHAT_TOP && p.y - HALF < CHAT_BOT && p.x - HALF < CHAT_RIGHT) continue;
      if (Math.hypot(p.x - jc.x, p.y - jc.y) < JOY_R + HALF + 6) continue;
      if (Math.hypot(p.x - pb.x, p.y - pb.y) < pb.r + HALF + 4) continue;
      if (Math.hypot(p.x - tb.x, p.y - tb.y) < tb.r + HALF + 4) continue;
      seats.push(p);
    }
  }
  return seats;
}

function drawBuffStrip() {
  if (!player) return;
  const p = player;

  // Collect active buffs / debuffs
  const chips = [];

  // Potion buffs
  const pbuffs = p.buffs || {};
  for (const [btype, rem] of Object.entries(pbuffs)) {
    if (rem <= 0) continue;
    const bdef = ITEM_DEF.find(d => d.buffType === btype && d.slot === 'buff_potion');
    if (!bdef) continue;
    const secs = Math.ceil(rem);
    chips.push({ kind:'pot', img: bdef.img, label: secs < 60 ? secs + t('secAbbrev') : Math.ceil(rem/60) + t('minAbbrev'), color:'#e5a546' });
  }

  // Season ticket — shown alongside potion buffs (same chip style) whenever
  // this account owns it and the season is still running.
  if (typeof _seasonTicketActive !== 'undefined' && _seasonTicketActive &&
      typeof _seasonState !== 'undefined' && _seasonState.active) {
    const _stLeft = Math.max(0, (_seasonState.endAt || 0) - Date.now());
    if (_stLeft > 0) chips.push({ kind:'pot', img:'/images/season_ticket.png', label: _fmtChipEta(_stLeft), color:'#ffcf56' });
  }

  // Skill buffs
  const skillBuffs = [
    { t: typeof barrierTimer     !== 'undefined' ? barrierTimer     : 0, icon:'barrier',   color:'#eec47c' },
    { t: typeof battleCryTimer   !== 'undefined' ? battleCryTimer   : 0, icon:'battleCry', color:'#e8a034' },
    { t: typeof atkSpeedTimer    !== 'undefined' ? atkSpeedTimer    : 0, icon:'lightning', color:'#bf9a6a' },
    { t: typeof faithShieldTimer !== 'undefined' ? faithShieldTimer : 0, icon:'shield',    color:'#ebad4e' },
    { t: typeof invisTimer       !== 'undefined' ? invisTimer       : 0, icon:'teleport',  color:'#f2d197' },
    { t: typeof dodgeTimer       !== 'undefined' ? dodgeTimer       : 0, icon:'dash',      color:'#98e456' },
    { t: typeof guardTimer       !== 'undefined' ? guardTimer       : 0, icon:'shield',    color:'#90a4b5' },
    { t: typeof vampirismTimer   !== 'undefined' ? vampirismTimer   : 0, icon:'drop',      color:'#c23b5e' },
  ];
  for (const b of skillBuffs) {
    if (b.t > 0) chips.push({ kind:'icon', icon: b.icon, label: Math.ceil(b.t) + t('secAbbrev'), color: b.color });
  }

  // Debuffs
  if ((p.slowTimer   || 0) > 0) chips.push({ kind:'icon', icon:'wind',      label: Math.ceil(p.slowTimer)   + t('secAbbrev'), color:'#efc680', debuff:true });
  if ((p.stunTimer   || 0) > 0) chips.push({ kind:'icon', icon:'holyLight', label: Math.ceil(p.stunTimer)   + t('secAbbrev'), color:'#ebad4e', debuff:true });
  if ((p.freezeTimer || 0) > 0) chips.push({ kind:'icon', icon:'iceNova',   label: Math.ceil(p.freezeTimer) + t('secAbbrev'), color:'#ccaf88', debuff:true });
  // Death XP penalty — remaining seconds, same as any other player.buffs entry
  const _penaltyLeft = (p.buffs || {}).deathPenalty || 0;
  if (_penaltyLeft > 0) {
    const _pm = Math.ceil(_penaltyLeft / 60);
    chips.push({ kind:'icon', icon:'star', label: '−XP ' + _pm + t('minAbbrev'), color:'#c34d5b', debuff:true });
  }

  if (!chips.length) return;

  // Chips ride an arc of their own just outside the skill buttons (fanPos,
  // js/input.js), running the fan's whole outer edge: from below the potion
  // at the top round to just above the nav bar at the bottom left. That sweep
  // is divided into BUFF_SEATS evenly spaced seats; once they are full the
  // next chip opens a ring further out, at the same angles.
  // The arc deliberately starts below the potion rather than beside it: a
  // seat squeezed between potion and target left one chip stranded up in the
  // corner with a gap under it, since the seat below it was always dropped
  // by the button guards further down.
  const SZ = BUFF_CHIP_SZ, HALF = SZ / 2;
  // Seats a chip can't actually be seen in are skipped, and the chip rides the
  // next ring out instead:
  //  · below the nav bar;
  //  · under the chat preview bubble while it is up — #chat-preview
  //    (index.html) is a DOM element layered over this canvas, so it paints
  //    over anything drawn there regardless of draw order. Its geometry is the
  //    CSS one (left:58px, bottom:72px, up to ~46px tall, max-width capped
  //    against the viewport), mirrored here;
  //  · inside the joystick, which a long list would otherwise swing into;
  //  · under the potion / target buttons, which sit on their own wider arc
  //    right where the top of this one starts.
  const seats = buffSeats(chips.length);
  const F2 = 'system-ui, -apple-system, Arial';

  ctx.save();

  for (let i = 0; i < seats.length; i++) {
    const cx = seats[i].x - HALF, cy = seats[i].y - HALF;
    const chip = chips[i];

    // Background cell
    ctx.fillStyle = chip.debuff ? 'rgba(37,8,11,0.90)' : 'rgba(10,17,26,0.90)';
    roundRect(ctx, cx, cy, SZ, SZ, 5); ctx.fill();
    ctx.globalAlpha = 0.75;
    ctx.strokeStyle = chip.color; ctx.lineWidth = 1;
    roundRect(ctx, cx, cy, SZ, SZ, 5); ctx.stroke();
    ctx.globalAlpha = 1;

    // Icon (upper portion of cell)
    const iconCX = cx + SZ / 2, iconCY = cy + SZ / 2 - 3;
    if (chip.kind === 'pot' && chip.img) {
      const img = _getPotImg(chip.img);
      if (img && img.complete && img.naturalWidth > 0)
        ctx.drawImage(img, cx + 3, cy + 2, 16, 13);
    } else {
      drawIconCtx(ctx, chip.icon, iconCX, iconCY, hud(11), chip.color);
    }

    // Time label at bottom of cell
    ctx.font = `bold ${hudF(6)}px ${F2}`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = chip.color;
    ctx.fillText(chip.label, cx + SZ / 2, cy + SZ - 2);
  }

  ctx.restore();
}

// ─────────────────────────────────────────────────────────
//  PK / МИР BUTTON
// ─────────────────────────────────────────────────────────
function drawPvpButton() {
  if (!player) return;
  if (!_uiBtnGrads) _buildUiBtnGrads();
  const pb = _uiBtnGrads.pvpBtn;
  const F = 'system-ui, -apple-system, Arial';

  ctx.save();

  ctx.fillStyle = pvpMode ? _uiBtnGrads.pvg1 : _uiBtnGrads.pvg0;
  roundRect(ctx, pb.x, pb.y, pb.w, pb.h, 9); ctx.fill();

  ctx.strokeStyle = pvpMode ? 'rgba(226,70,88,0.85)' : 'rgba(93,154,198,0.55)';
  ctx.lineWidth = 1.5;
  roundRect(ctx, pb.x, pb.y, pb.w, pb.h, 9); ctx.stroke();

  if (pvpMode) {
    ctx.strokeStyle = 'rgba(226,70,88,0.12)'; ctx.lineWidth = 4;
    roundRect(ctx, pb.x - 2, pb.y - 2, pb.w + 4, pb.h + 4, 11); ctx.stroke();
  }

  const pvpLabel = pvpMode ? t('pvpOnLabel') : t('pvpOffLabel');
  const pvpColor = pvpMode ? '#ef6d7c' : 'rgba(224,188,127,0.9)';
  drawIconCtx(ctx, pvpMode ? 'pvpOn' : 'pvpOff', pb.x + pb.w / 2 - hud(14), pb.y + pb.h / 2, hud(12), pvpColor);
  ctx.font = `bold ${hudF(11)}px ${F}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillStyle = pvpColor;
  ctx.fillText(pvpLabel, pb.x + pb.w / 2 - hud(5), pb.y + pb.h / 2);

  ctx.restore();
}

// ─────────────────────────────────────────────────────────
//  ПРОФЕССИЯ BUTTON — below Мир/ПК, opens the advanced-skills panel
// ─────────────────────────────────────────────────────────
function drawProfessionButton() {
  if (!player) return;
  if (!_uiBtnGrads) _buildUiBtnGrads();
  const pb = _uiBtnGrads.profBtn;
  const F = 'system-ui, -apple-system, Arial';
  const ready = _professionHasReady();

  ctx.save();

  ctx.fillStyle = ready ? _uiBtnGrads.pfg1 : _uiBtnGrads.pfg0;
  roundRect(ctx, pb.x, pb.y, pb.w, pb.h, 9); ctx.fill();

  ctx.strokeStyle = ready ? 'rgba(205,184,236,0.85)' : 'rgba(93,154,198,0.4)';
  ctx.lineWidth = 1.5;
  roundRect(ctx, pb.x, pb.y, pb.w, pb.h, 9); ctx.stroke();

  if (ready) {
    const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 320);
    ctx.strokeStyle = `rgba(165,143,196,${(0.10 + 0.10 * pulse).toFixed(3)})`; ctx.lineWidth = 4;
    roundRect(ctx, pb.x - 2, pb.y - 2, pb.w + 4, pb.h + 4, 11); ctx.stroke();
  }

  const profColor = ready ? '#cdb8ec' : 'rgba(224,188,127,0.9)';
  drawIconCtx(ctx, 'book', pb.x + pb.w / 2 - hud(14), pb.y + pb.h / 2, hud(12), profColor);
  ctx.font = `bold ${hudF(11)}px ${F}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillStyle = profColor;
  ctx.fillText(t('professionBtnLbl'), pb.x + pb.w / 2 - hud(5), pb.y + pb.h / 2);

  ctx.restore();
}

// ─────────────────────────────────────────────────────────
//  КЛАСС BUTTON — прямо под Профессией, открывает окно смены класса.
//  Первый заход спрятал смену ВНУТРЬ панели профессии, внизу: за два нажатия
//  и там, где её никто не искал. Просили кнопку на экране — вот она.
//  См. getClassChangeBtnPos/_checkClassChangeBtnTouch, js/input.js.
// ─────────────────────────────────────────────────────────
// Тише Профессии намеренно: смена класса стоит Liberty и делается один раз
// за долгую игру, а Профессия — то, куда заходят каждый уровень. Поэтому
// подсветки «готово» у неё нет, только ровная рамка колонки.
function drawClassChangeButton() {
  if (!player || !player.type) return;
  if (!_uiBtnGrads) _buildUiBtnGrads();
  const cb = _uiBtnGrads.ccBtn;
  const F = 'system-ui, -apple-system, Arial';

  ctx.save();

  ctx.fillStyle = _uiBtnGrads.pfg0;
  roundRect(ctx, cb.x, cb.y, cb.w, cb.h, 9); ctx.fill();
  ctx.strokeStyle = 'rgba(93,154,198,0.4)';
  ctx.lineWidth = 1.5;
  roundRect(ctx, cb.x, cb.y, cb.w, cb.h, 9); ctx.stroke();

  const col = 'rgba(224,188,127,0.9)';
  drawIconCtx(ctx, 'sword', cb.x + cb.w / 2 - hud(14), cb.y + cb.h / 2, hud(12), col);
  ctx.font = `bold ${hudF(11)}px ${F}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillStyle = col;
  ctx.fillText(t('classChangeBtnLbl'), cb.x + cb.w / 2 - hud(5), cb.y + cb.h / 2);

  ctx.restore();
}

// ─────────────────────────────────────────────────────────
//  ПИСЬМО BUTTON — под «Класс», одна из двух наград MAIL_BONUS.
//  Состав обеих лежит в shared/definitions.js, выдаёт claimMailBonus
//  (server/db/repos/shop.js). См. getMailBonusBtnPos/_checkMailBonusBtnTouch,
//  js/input.js.
// ─────────────────────────────────────────────────────────
// player.mailBonus — флаг аккаунта, приезжает при входе (restoreFromSave,
// js/player.js) и ставится в тот момент, когда награда выдана. Пока он false,
// кнопка на экране; после — исчезает совсем, вместе со своим слотом нажатий:
// забрать можно один раз, а мёртвая кнопка в HUD это просто мусор.
function _mailBonusAvailable() {
  return !!player && !player.mailBonus;
}

// Какая из двух наград причитается ЭТОМУ игроку. Здесь — только чтобы
// нарисовать панель: выдачей распоряжается сервер по своей копии билета, и
// расходятся эти два мнения ровно в одном случае — билет купили в другой
// вкладке. Тогда правым остаётся сервер, а панель поправится по ответу.
function _mailBonusTier() {
  return (typeof _seasonTicketActive !== 'undefined' && _seasonTicketActive) ? 'ticket' : 'free';
}

function drawMailBonusButton() {
  if (!_mailBonusAvailable()) return;
  if (!_uiBtnGrads) _buildUiBtnGrads();
  const mb = getMailBonusBtnPos();
  const F = 'system-ui, -apple-system, Arial';

  ctx.save();

  // Холодная бирюза, а не янтарь «Бонуса»: две бесплатные награды подряд в
  // одной колонке, и различать их обязано что-то кроме подписи в 11 пикселей.
  // Та же бегущая полоса, но своей фазой — иначе кнопки пульсировали бы в
  // такт и читались как одна.
  const sweep = (Math.sin(Date.now() / 1100 + Math.PI / 2) + 1) / 2;
  const grad = ctx.createLinearGradient(mb.x, mb.y, mb.x + mb.w, mb.y + mb.h);
  grad.addColorStop(0, '#17283e');
  grad.addColorStop(Math.max(0, sweep - 0.3), '#233e60');
  grad.addColorStop(sweep, '#4fc3ff');
  grad.addColorStop(Math.min(1, sweep + 0.3), '#233e60');
  grad.addColorStop(1, '#17283e');
  ctx.fillStyle = grad;
  roundRect(ctx, mb.x, mb.y, mb.w, mb.h, 9); ctx.fill();

  ctx.strokeStyle = 'rgba(79,195,255,0.7)';
  ctx.lineWidth = 1.5;
  roundRect(ctx, mb.x, mb.y, mb.w, mb.h, 9); ctx.stroke();

  const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 320);
  ctx.strokeStyle = `rgba(79,195,255,${(0.10 + 0.12 * pulse).toFixed(3)})`; ctx.lineWidth = 4;
  roundRect(ctx, mb.x - 2, mb.y - 2, mb.w + 4, mb.h + 4, 11); ctx.stroke();

  drawIconCtx(ctx, 'mail', mb.x + mb.w / 2 - hud(16), mb.y + mb.h / 2, hud(12), '#bfe4ff');
  ctx.font = `bold ${hudF(11)}px ${F}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#bfe4ff';
  ctx.fillText(t('mailBonusBtn'), mb.x + mb.w / 2 - hud(7), mb.y + mb.h / 2);

  ctx.restore();
}

// Строки одной награды: баф-зелья всех видов, затем материалы, затем сундуки —
// в том же порядке, в каком их складывает claimMailBonus, чтобы обещание и
// выдача читались одним списком.
function _mailBonusRows(tier) {
  const out = [];
  for (const bp of ITEM_DEF.filter(d => d.slot === 'buff_potion')) {
    out.push(_bonusItemRow(_itemIcon(bp, 16), bp.name, tier.buffPotions));
  }
  for (const [id, qty] of Object.entries({ ...(tier.mats || {}), ...(tier.boxes || {}) })) {
    const def = _anyItemDef(id);
    if (def) out.push(_bonusItemRow(_itemIcon(def, 16), def.name, qty));
  }
  return out.join('');
}

// Карточка одной из двух наград. Показываются ОБЕ — и та, что игроку не
// достанется, тоже: правило «с билетом одна, без билета другая» иначе
// пришлось бы объяснять словами, а так оно видно.
function _mailBonusCard(kind, mine) {
  const tier = MAIL_BONUS[kind];
  const title = kind === 'ticket' ? t('mailBonusTicketHdr') : t('mailBonusFreeHdr');
  const accent = kind === 'ticket' ? '#ffcf56' : '#4fc3ff';
  const lockNote = kind === 'ticket' ? t('mailBonusNeedTicket') : t('mailBonusHaveTicket');
  return `<div style="border:1px solid ${mine ? accent + '66' : 'rgba(193,204,213,.10)'};
      border-radius:12px;padding:12px 12px 8px;margin-bottom:10px;
      background:${mine ? 'rgba(79,195,255,.05)' : 'transparent'};${mine ? '' : 'opacity:.5'}">
    <div style="font-size:13px;font-weight:800;color:${mine ? accent : '#5b7183'};margin-bottom:8px">
      ${title}${mine ? '' : ` <span style="font-weight:600;font-size:11px">· ${lockNote}</span>`}</div>
    <div class="vip-items-row">${_mailBonusRows(tier)}</div>
  </div>`;
}

function openMailBonusPanel() {
  if (!_mailBonusAvailable()) return;
  const existing = document.getElementById('mail-bonus-ov');
  if (existing) existing.remove();
  const mine = _mailBonusTier();

  const ov = document.createElement('div');
  ov.id = 'mail-bonus-ov';
  ov.onclick = () => ov.remove();
  ov.style.cssText = 'position:fixed;inset:0;z-index:240;background:rgba(0,0,0,.75);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:20px;';
  // Прокручивается СПИСОК, а не всё окно. У «Набора новичка» окно прокручивалось
  // целиком, и там это сходило с рук: одна награда, список короткий. Здесь их
  // две, вместе они выше экрана — и «Забрать» уезжала под нижний край. Кнопку,
  // ради которой окно открыли, искать прокруткой игрок не должен.
  ov.innerHTML = `<div onclick="event.stopPropagation()" style="width:100%;max-width:340px;max-height:82vh;display:flex;flex-direction:column;background:#0c1420;border-radius:16px;border:1px solid rgba(79,195,255,.22);padding:20px 18px;">
    <div style="font-size:16px;font-weight:800;color:#4fc3ff;margin-bottom:6px">${t('mailBonusTitle')}</div>
    <div style="font-size:12.5px;color:#8197ab;line-height:1.5;margin-bottom:12px">${t('mailBonusDesc')}</div>
    <div class="ov-scroll" style="flex:1;min-height:0;overflow:auto;margin:0 -4px;padding:0 4px">
      ${_mailBonusCard('free', mine === 'free')}
      ${_mailBonusCard('ticket', mine === 'ticket')}
    </div>
    <div id="mail-bonus-err" style="display:none;font-size:12.5px;color:#f88;margin-top:10px"></div>
    <div style="display:flex;gap:10px;margin-top:16px;flex-shrink:0">
      <button onclick="document.getElementById('mail-bonus-ov').remove()" style="
        flex:1;padding:11px;border:none;border-radius:10px;background:rgba(193,204,213,.07);
        color:#5797c4;font-size:14px;font-weight:600;cursor:pointer">${t('cancelBtn')}</button>
      <button id="mail-bonus-go" onclick="_confirmMailBonus()" style="
        flex:1;padding:11px;border:none;border-radius:10px;
        background:linear-gradient(135deg,#1d4a63,#2b7a9e);color:#bfe4ff;
        font-size:14px;font-weight:700;cursor:pointer">${t('mailBonusClaimBtn')}</button>
    </div>
  </div>`;
  document.getElementById('app').appendChild(ov);
}

function _confirmMailBonus() {
  const btn = document.getElementById('mail-bonus-go');
  if (btn) { btn.disabled = true; btn.style.opacity = '.55'; btn.textContent = '…'; }
  if (typeof netMailBonusClaim === 'function') netMailBonusClaim();
}

function onMailBonusDone(withTicket) {
  const ov = document.getElementById('mail-bonus-ov');
  if (ov) ov.remove();
  if (typeof updateInvUI === 'function') updateInvUI();
  if (player) {
    dmgNum(player.x, player.y - 30,
      withTicket ? t('mailBonusDoneTicketToast') : t('mailBonusDoneToast'), '#4fc3ff');
  }
}

function onMailBonusError(msg) {
  const box = document.getElementById('mail-bonus-err');
  const btn = document.getElementById('mail-bonus-go');
  if (btn) { btn.disabled = false; btn.style.opacity = '1'; btn.textContent = t('mailBonusClaimBtn'); }
  if (box) { box.style.display = 'block'; box.textContent = msg || 'Ошибка'; }
  else if (player) dmgNum(player.x, player.y - 30, msg || 'Ошибка', '#f88');
}

// ─────────────────────────────────────────────────────────
//  БОНУС BUTTON — below Письмо, the free one-per-account "Набор новичка".
//  Contents: STARTER_BONUS (shared/definitions.js); granted by the
//  starterBonusClaim handler (server/handlers/gram.js). See
//  getStarterBonusBtnPos/_checkStarterBonusBtnTouch, js/input.js.
// ─────────────────────────────────────────────────────────
// player.starterBonus is the account's claim flag, restored from the stored
// record at login (restoreFromSave, js/player.js) and set the moment a claim
// lands. Once it is true the button stops being drawn and its slot stops
// taking taps — the kit cannot be claimed twice, and a permanently dead
// button on the HUD is just clutter.
function _starterBonusAvailable() {
  return !!player && !player.starterBonus;
}

// The kit, resolved from the shared catalog rather than restated here: one
// common item per armour slot plus the common weapon of this character's own
// class. Exactly what the server grants off _SHOP_ARMOR_SETS.common /
// _SHOP_CLASS_WEAPONS (server/shop.js), which are those same catalog entries.
const _STARTER_GEAR_SLOTS = ['helmet', 'body', 'gloves', 'boots', 'ring', 'belt'];
function _starterBonusGear() {
  const cls = (player && player.type) || 'lev';
  const gear = _STARTER_GEAR_SLOTS
    .map(sl => ITEM_DEF.find(d => d.slot === sl && d.rarity === STARTER_BONUS.gearRarity && !d.forClass))
    .filter(Boolean);
  const wep = ITEM_DEF.find(d => d.slot === 'weapon' && d.rarity === STARTER_BONUS.gearRarity
    && d.forClass && d.forClass.includes(cls));
  if (wep) gear.push(wep);
  return gear;
}

function drawStarterBonusButton() {
  if (!_starterBonusAvailable()) return;
  if (!_uiBtnGrads) _buildUiBtnGrads();
  const bb = getStarterBonusBtnPos();
  const F = 'system-ui, -apple-system, Arial';

  ctx.save();

  // Warm amber, so it reads as a gift rather than as a second purchase button
  // next to +Pack's emerald. Same sweeping band, half a cycle out of phase,
  // so the two never pulse in lockstep.
  const sweep = (Math.sin(Date.now() / 1100 + Math.PI) + 1) / 2;
  const grad = ctx.createLinearGradient(bb.x, bb.y, bb.x + bb.w, bb.y + bb.h);
  grad.addColorStop(0, '#17283e');
  grad.addColorStop(Math.max(0, sweep - 0.3), '#233e60');
  grad.addColorStop(sweep, '#f0b44a');
  grad.addColorStop(Math.min(1, sweep + 0.3), '#233e60');
  grad.addColorStop(1, '#17283e');
  ctx.fillStyle = grad;
  roundRect(ctx, bb.x, bb.y, bb.w, bb.h, 9); ctx.fill();

  ctx.strokeStyle = 'rgba(240,180,74,0.7)';
  ctx.lineWidth = 1.5;
  roundRect(ctx, bb.x, bb.y, bb.w, bb.h, 9); ctx.stroke();

  const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 320);
  ctx.strokeStyle = `rgba(240,180,74,${(0.10 + 0.12 * pulse).toFixed(3)})`; ctx.lineWidth = 4;
  roundRect(ctx, bb.x - 2, bb.y - 2, bb.w + 4, bb.h + 4, 11); ctx.stroke();

  drawIconCtx(ctx, 'star', bb.x + bb.w / 2 - hud(16), bb.y + bb.h / 2, hud(12), '#ffe0a3');
  ctx.font = `bold ${hudF(11)}px ${F}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffe0a3';
  ctx.fillText(t('starterBonusBtn'), bb.x + bb.w / 2 - hud(7), bb.y + bb.h / 2);

  ctx.restore();
}

// Одна строка списка награды — значок, что это и сколько. Общая для «Набора
// новичка» и «Письма»: список у них разный, а вид строки один.
function _bonusItemRow(icon, label, qty) {
  return `<div class="vip-ri"><span class="vip-ri-img" style="display:inline-flex;align-items:center;justify-content:center">${icon}</span><span class="vip-ri-label">${label}${qty ? ` <b style="color:#ffe0a3">×${qty}</b>` : ''}</span></div>`;
}

function openStarterBonusPanel() {
  if (!_starterBonusAvailable()) return;
  const existing = document.getElementById('starter-bonus-ov');
  if (existing) existing.remove();

  const gearRows = _starterBonusGear()
    .map(it => _bonusItemRow(_itemIcon(it, 16), it.name, 1)).join('');
  const bpRows = ITEM_DEF.filter(d => d.slot === 'buff_potion')
    .map(bp => _bonusItemRow(_itemIcon(bp, 16), bp.name, STARTER_BONUS.buffPotions)).join('');
  const hpDef = ITEM_DEF.find(d => d.id === STARTER_BONUS.hpPotionId);
  const hpRow = hpDef ? _bonusItemRow(_itemIcon(hpDef, 16), hpDef.name, STARTER_BONUS.hpPotions) : '';

  const ov = document.createElement('div');
  ov.id = 'starter-bonus-ov';
  ov.onclick = () => ov.remove();
  ov.style.cssText = 'position:fixed;inset:0;z-index:240;background:rgba(0,0,0,.75);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:20px;';
  ov.innerHTML = `<div class="ov-scroll" onclick="event.stopPropagation()" style="width:100%;max-width:340px;max-height:82vh;overflow:auto;background:#0c1420;border-radius:16px;border:1px solid rgba(240,180,74,.22);padding:20px 18px;">
    <div style="font-size:16px;font-weight:800;color:#f0b44a;margin-bottom:6px">${t('starterBonusTitle')}</div>
    <div style="font-size:12.5px;color:#8197ab;line-height:1.5;margin-bottom:12px">${t('starterBonusDesc')}</div>
    <div class="vip-items-row">${gearRows}${bpRows}${hpRow}</div>
    <div id="starter-bonus-err" style="display:none;font-size:12.5px;color:#f88;margin-top:10px"></div>
    <div style="display:flex;gap:10px;margin-top:16px">
      <button onclick="document.getElementById('starter-bonus-ov').remove()" style="
        flex:1;padding:11px;border:none;border-radius:10px;background:rgba(193,204,213,.07);
        color:#5797c4;font-size:14px;font-weight:600;cursor:pointer">${t('cancelBtn')}</button>
      <button id="starter-bonus-go" onclick="_confirmStarterBonus()" style="
        flex:1;padding:11px;border:none;border-radius:10px;
        background:linear-gradient(135deg,#233e60,#2b597a);color:#ffe0a3;
        font-size:14px;font-weight:700;cursor:pointer">${t('starterBonusClaimBtn')}</button>
    </div>
  </div>`;
  document.getElementById('app').appendChild(ov);
}

// Disabled while the request is out, so a double tap cannot fire a second
// claim the server would only refuse anyway.
function _confirmStarterBonus() {
  const btn = document.getElementById('starter-bonus-go');
  if (btn) { btn.disabled = true; btn.style.opacity = '.55'; btn.textContent = '…'; }
  if (typeof netStarterBonusClaim === 'function') netStarterBonusClaim();
}

function onStarterBonusDone() {
  const ov = document.getElementById('starter-bonus-ov');
  if (ov) ov.remove();
  if (typeof updateInvUI === 'function') updateInvUI();
  if (typeof updateProfileUI === 'function') updateProfileUI();
  if (player) dmgNum(player.x, player.y - 30, t('starterBonusDoneToast'), '#f0b44a');
}

// Shown inside the panel rather than as a floating number: every refusal here
// is something the player can act on (make inventory room, wait a second),
// and the panel is what they are looking at.
function onStarterBonusError(msg) {
  const box = document.getElementById('starter-bonus-err');
  const btn = document.getElementById('starter-bonus-go');
  if (btn) { btn.disabled = false; btn.style.opacity = '1'; btn.textContent = t('starterBonusClaimBtn'); }
  if (box) { box.style.display = 'block'; box.textContent = msg || 'Ошибка'; }
  else if (player) dmgNum(player.x, player.y - 30, msg || 'Ошибка', '#f88');
}

// ─────────────────────────────────────────────────────────
//  ДРУЖБА BUTTON — под «Бонус», та же колонка. Тиры и составы наград —
//  FRIENDSHIP_TIERS (shared/definitions.js), выдаёт claimFriendshipTier
//  (server/db/repos/shop.js). См. getFriendshipBtnPos/_checkFriendshipBtnTouch,
//  js/input.js.
// ─────────────────────────────────────────────────────────
// В отличие от Письма и Бонуса кнопка не исчезает после первого забора: тиров
// шесть, и следующий может открыться месяцы спустя, когда очередной друг
// дорастёт до FRIENDSHIP_LEVEL. Рисуется как Класс/Профессия — ровной рамкой,
// без бегущей полосы: подсвечивать её как срочный разовый подарок было бы
// враньём, а какие тиры уже готовы, показывает сама панель.
function drawFriendshipButton() {
  if (!player || !player.type) return;
  if (!_uiBtnGrads) _buildUiBtnGrads();
  const fb = getFriendshipBtnPos();
  const F = 'system-ui, -apple-system, Arial';

  ctx.save();

  ctx.fillStyle = _uiBtnGrads.pfg0;
  roundRect(ctx, fb.x, fb.y, fb.w, fb.h, 9); ctx.fill();
  ctx.strokeStyle = 'rgba(224,120,150,0.4)';
  ctx.lineWidth = 1.5;
  roundRect(ctx, fb.x, fb.y, fb.w, fb.h, 9); ctx.stroke();

  const col = 'rgba(240,150,180,0.9)';
  drawIconCtx(ctx, 'heart', fb.x + fb.w / 2 - hud(14), fb.y + fb.h / 2, hud(12), col);
  ctx.font = `bold ${hudF(11)}px ${F}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillStyle = col;
  ctx.fillText(t('friendshipBtnLbl'), fb.x + fb.w / 2 - hud(5), fb.y + fb.h / 2);

  ctx.restore();
}

// Последний ответ сервера (friendshipStatus). Пусто до первого открытия
// панели — карточки тиров тогда рисуются как «0 из N», а не как заведомо
// неверное «уже готово».
let _friendshipStatus = { count: 0, tiers: [], friends: [] };

// Строки одного тира: то же, что у Письма/Бонуса, плюс Liberty и GRAM — ни
// один из старых наборов их не выдавал, поэтому _bonusItemRow сам по себе
// сюда не годился без строки для валюты.
function _friendshipRewardRows(tier) {
  const out = [];
  if (tier.buffPotions) {
    for (const bp of ITEM_DEF.filter(d => d.slot === 'buff_potion')) {
      out.push(_bonusItemRow(_itemIcon(bp, 16), bp.name, tier.buffPotions));
    }
  }
  for (const [id, qty] of Object.entries(tier.mats || {})) {
    const def = _anyItemDef(id);
    if (def) out.push(_bonusItemRow(_itemIcon(def, 16), def.name, qty));
  }
  if (tier.wing) {
    const def = _anyItemDef(tier.wing);
    if (def) out.push(_bonusItemRow(_itemIcon(def, 16), def.name, 1));
  }
  if (tier.nexum) out.push(_bonusItemRow(_nexumIconHtml(16), t('libertyLbl'), tier.nexum));
  if (tier.gram) {
    out.push(_bonusItemRow(
      '<img src="/images/gram-icon.png" width="16" height="16" style="vertical-align:middle">',
      'GRAM', tier.gram));
  }
  return out.join('');
}

// Карточка одного тира с собственной кнопкой «Забрать» — в отличие от
// Письма/Бонуса, где кнопка одна на всю панель, тиры здесь закрываются не
// разом, и одна кнопка на все шесть значила бы либо шесть заявок сразу, либо
// гадать, какую из них имел в виду игрок.
function _friendshipTierCard(def, status) {
  const st = (status.tiers || []).find(x => x.count === def.count) || {};
  const done = !!st.claimed, ready = !!st.claimable;
  const accent = done ? '#5b7183' : ready ? '#98e456' : '#e08cae';
  const btnLabel = done ? t('friendshipClaimedLbl') : t('friendshipClaimBtn');
  const btnBg = done
    ? 'rgba(193,204,213,.07)'
    : ready ? 'linear-gradient(135deg,#3f7a2e,#5fae3f)' : 'rgba(193,204,213,.07)';
  const btnColor = done || !ready ? '#5b7183' : '#eaffe0';
  return `<div style="border:1px solid ${ready ? accent + '66' : 'rgba(193,204,213,.10)'};
      border-radius:12px;padding:12px 12px 8px;margin-bottom:10px;
      background:${ready ? 'rgba(152,228,86,.05)' : 'transparent'};${done ? 'opacity:.55' : ''}">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:10px">
      <div style="font-size:13px;font-weight:800;color:${accent}">${tVars('friendshipTierFmt', { n: def.count })}</div>
      <button ${done || !ready ? 'disabled' : ''} onclick="_confirmFriendshipClaim(${def.count})" style="
        padding:6px 14px;border:none;border-radius:8px;font-size:12px;font-weight:700;
        cursor:${done || !ready ? 'default' : 'pointer'};background:${btnBg};color:${btnColor};
        white-space:nowrap">${btnLabel}</button>
    </div>
    <div class="vip-items-row">${_friendshipRewardRows(def)}</div>
  </div>`;
}

// Строка одного приглашённого друга: имя, уровень, и отметка — считается ли
// он в тиры ПРЯМО СЕЙЧАС. Ответ на «а почему у меня 0, а друг есть» виден на
// экране: либо не дорос до FRIENDSHIP_LEVEL, либо приглашён до появления этой
// награды (FRIENDSHIP_LAUNCH_AT) — а не только в виде числа без объяснения.
function _friendshipFriendRow(f) {
  const eligible = !!f.counts;
  const color = eligible ? '#98e456' : '#5b7183';
  const name = f.username ? _escHtml(f.username) : t('playerFallbackLbl');
  return `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;
      padding:6px 9px;border-radius:8px;background:rgba(193,204,213,.04);margin-bottom:4px">
    <span style="font-size:12.5px;font-weight:600;color:#c1ccd5;overflow:hidden;
      text-overflow:ellipsis;white-space:nowrap">@${name}</span>
    <span style="display:flex;align-items:center;gap:8px;flex-shrink:0">
      <span style="font-size:11.5px;color:#8197ab">${tVars('charLevelFmt', { lvl: f.lvl })}</span>
      <span style="font-size:13px;font-weight:800;color:${color}">${eligible ? '✓' : '—'}</span>
    </span>
  </div>`;
}

// Каждый друг, а не только те, что уже считаются — иначе список молчал бы
// ровно там, где объяснение нужнее всего: у игрока, чьи друзья все ниже
// FRIENDSHIP_LEVEL или приглашены до этой награды.
function _friendshipFriendsSection(friends) {
  const hdr = `<div style="font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;
      color:#5b7183;margin:2px 0 6px">${t('friendshipFriendsHdr')}</div>`;
  if (!friends || !friends.length) {
    return `${hdr}<div style="font-size:12px;color:#5b7183;margin-bottom:14px">${t('friendshipNoFriendsHint')}</div>`;
  }
  return `${hdr}<div style="margin-bottom:14px">${friends.map(_friendshipFriendRow).join('')}</div>`;
}

function _renderFriendshipList() {
  const list = document.getElementById('friendship-list');
  if (!list) return;
  list.innerHTML = _friendshipFriendsSection(_friendshipStatus.friends)
    + FRIENDSHIP_TIERS.map(def => _friendshipTierCard(def, _friendshipStatus)).join('');
  const prog = document.getElementById('friendship-progress');
  if (prog) {
    prog.textContent = tVars('friendshipProgressFmt', { n: _friendshipStatus.count || 0, lvl: FRIENDSHIP_LEVEL });
  }
}

function openFriendshipPanel() {
  const existing = document.getElementById('friendship-ov');
  if (existing) existing.remove();

  const ov = document.createElement('div');
  ov.id = 'friendship-ov';
  ov.onclick = () => ov.remove();
  ov.style.cssText = 'position:fixed;inset:0;z-index:240;background:rgba(0,0,0,.75);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:20px;';
  ov.innerHTML = `<div onclick="event.stopPropagation()" style="width:100%;max-width:360px;max-height:82vh;display:flex;flex-direction:column;background:#0c1420;border-radius:16px;border:1px solid rgba(224,120,150,.22);padding:20px 18px;">
    <div style="font-size:16px;font-weight:800;color:#e08cae;margin-bottom:6px">${t('friendshipTitle')}</div>
    <div style="font-size:12.5px;color:#8197ab;line-height:1.5;margin-bottom:10px">${tVars('friendshipDesc', { lvl: FRIENDSHIP_LEVEL })}</div>
    <div id="friendship-progress" style="font-size:13px;font-weight:700;color:#bfe4ff;margin-bottom:12px">…</div>
    <div id="friendship-list" class="ov-scroll" style="flex:1;min-height:0;overflow:auto;margin:0 -4px;padding:0 4px"></div>
    <div id="friendship-err" style="display:none;font-size:12.5px;color:#f88;margin-top:10px"></div>
    <div style="display:flex;gap:10px;margin-top:16px;flex-shrink:0">
      <button onclick="document.getElementById('friendship-ov').remove()" style="
        flex:1;padding:11px;border:none;border-radius:10px;background:rgba(193,204,213,.07);
        color:#5797c4;font-size:14px;font-weight:600;cursor:pointer">${t('cancelBtn')}</button>
    </div>
  </div>`;
  document.getElementById('app').appendChild(ov);
  _renderFriendshipList();
  if (typeof netGetFriendship === 'function') netGetFriendship();
}

function onFriendshipData(data) {
  _friendshipStatus = data || { count: 0, tiers: [], friends: [] };
  _renderFriendshipList();
}

// Пока запрос в пути, повторное нажатие любой карточки игнорируется — у
// каждой своя кнопка, поэтому блокируется не одна из них, а вся панель:
// пере-рендер по ответу всё равно заменит их разметку.
let _friendshipClaimBusy = false;
function _confirmFriendshipClaim(tier) {
  if (_friendshipClaimBusy) return;
  _friendshipClaimBusy = true;
  const errBox = document.getElementById('friendship-err');
  if (errBox) errBox.style.display = 'none';
  if (typeof netFriendshipClaim === 'function') netFriendshipClaim(tier);
}

function onFriendshipDone() {
  _friendshipClaimBusy = false;
  if (typeof updateInvUI === 'function') updateInvUI();
  if (typeof updateProfileUI === 'function') updateProfileUI();
  // Перезапрашивается целиком, а не правится на месте: заодно подтягивает
  // изменившийся count, если за это время подрос ещё один друг.
  if (typeof netGetFriendship === 'function') netGetFriendship();
  if (player) dmgNum(player.x, player.y - 30, t('friendshipDoneToast'), '#e08cae');
}

function onFriendshipError(msg) {
  _friendshipClaimBusy = false;
  const box = document.getElementById('friendship-err');
  if (box) { box.style.display = 'block'; box.textContent = msg || 'Ошибка'; }
  else if (player) dmgNum(player.x, player.y - 30, msg || 'Ошибка', '#f88');
}

// ─────────────────────────────────────────────────────────
//  TARGET FRAME
// ─────────────────────────────────────────────────────────
function drawTargetFrame() {
  if (!targetId || !player) return;
  const isOnline = !!(socket?.connected);

  let name, hp, maxHp, color;
  if (targetIsPlayer && isOnline) {
    const op = otherPlayers.get(targetId);
    if (!op) return;
    name = op.username || '?';
    hp = op.hp || 0; maxHp = op.maxHp || 1; color = '#f17e8b';
  } else {
    const e = serverEnemiesMap.get(targetId);
    if (!e) return;
    name = e.name || '?';
    hp = Math.max(0, e.hp || 0); maxHp = e.maxHp || 1; color = e.color || '#e69419';
  }

  const bw = 168, bh = 44;
  // Centred, unless that would run under the minimap plate hanging over the
  // world on a narrow screen — then it slides left to clear it.
  const _mpx = hudMiniMapRect().x;
  const bx = Math.min(W / 2 - bw / 2, _mpx - 6 - bw);
  const by = HEADER_H + 6;
  const F = 'system-ui, -apple-system, Arial';
  const pct = Math.max(0, Math.min(1, hp / maxHp));

  ctx.save();

  // Same plate as the rest of the HUD, framed in the target's own colour so a
  // player target still reads differently from a monster at a glance.
  _hudPanel(bx, by, bw, bh, 10, 'rgba(226,96,112,0.55)');

  drawIconCtx(ctx, 'crosshair', bx + hud(15), by + hud(12), hud(11), color);
  ctx.font = `bold ${hudF(10.5)}px ${F}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(name.slice(0, 16), bx + 25, by + 12);

  _hudBar(bx + 9, by + 22, bw - 18, 12, pct,
    pct > 0.5 ? '#7a1b26' : '#7a1b26', pct > 0.5 ? '#e0475b' : '#e0475b',
    Math.ceil(hp) + ' / ' + maxHp);

  ctx.restore();
}

// ─────────────────────────────────────────────────────────
//  ATTACK BUTTON (manual)
// ─────────────────────────────────────────────────────────
function drawAttackButton() {
  if (!player) return;
  if (!_uiBtnGrads) _buildUiBtnGrads();
  const ab = _uiBtnGrads.atkBtn;
  const hasTarget = !!targetId;
  const animBusy = (player.atkAnimTimer || 0) > 0;
  const ready = (player.atkTimer || 0) <= 0 && !animBusy;

  ctx.save();
  ctx.fillStyle = hasTarget && ready ? _uiBtnGrads.ag1 : (!autoAttackMode ? _uiBtnGrads.ag2 : _uiBtnGrads.ag0);
  ctx.beginPath(); ctx.arc(ab.x, ab.y, ab.r, 0, Math.PI * 2); ctx.fill();

  // cooldown arc overlay while attack animation is playing
  if (animBusy && player.castDuration > 0) {
    const frac = (player.atkAnimTimer || 0) / player.castDuration;
    ctx.strokeStyle = 'rgba(233,59,79,0.55)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(ab.x, ab.y, ab.r - 1, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
    ctx.stroke();
  }

  const borderColor = !autoAttackMode
    ? (hasTarget && ready ? 'rgba(235,73,92,0.9)' : 'rgba(203,163,93,0.7)')
    : 'rgba(41,72,112,0.45)';
  ctx.strokeStyle = borderColor; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(ab.x, ab.y, ab.r, 0, Math.PI * 2); ctx.stroke();
  if (!autoAttackMode && hasTarget && ready) {
    ctx.strokeStyle = 'rgba(234,66,85,0.15)'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(ab.x, ab.y, ab.r + 2, 0, Math.PI * 2); ctx.stroke();
  }

  ctx.globalAlpha = autoAttackMode ? 0.4 : (animBusy ? 0.55 : 1);
  const iconColor = hasTarget && ready ? '#ee6272' : (autoAttackMode ? '#2b5a7b' : '#f1ce90');
  drawIconCtx(ctx, 'sword', ab.x, ab.y, Math.round(ab.r * 0.87), iconColor);

  ctx.globalAlpha = 1;
  ctx.restore();
}

// ─────────────────────────────────────────────────────────
//  AUTO / MANUAL TOGGLE
// ─────────────────────────────────────────────────────────
function drawAutoToggle() {
  if (!player) return;
  if (!_uiBtnGrads) _buildUiBtnGrads();
  const ab = _uiBtnGrads.autoBtn;
  const F = 'system-ui, -apple-system, Arial';
  const cx = ab.x + ab.w / 2, cy = ab.y + ab.h / 2, r = ab.w / 2;
  ctx.save();
  ctx.fillStyle = autoAttackMode ? _uiBtnGrads.aag1 : _uiBtnGrads.aag0;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();

  ctx.strokeStyle = autoAttackMode ? 'rgba(127,181,79,0.7)' : 'rgba(210,150,60,0.7)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();

  ctx.font = `bold ${hudF(8)}px ${F}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = autoAttackMode ? '#90d653' : '#e5aa52';
  ctx.fillText(autoAttackMode ? t('autoModeAbbrev') : t('manualModeAbbrev'), cx, cy + 0.5);
  ctx.restore();
}

// ─────────────────────────────────────────────────────────
//  PARTY BUTTON (invite / leave)
// ─────────────────────────────────────────────────────────
function drawPartyButton() {
  if (!player) return;
  const canInvite = targetIsPlayer && !!targetId;
  if (!canInvite) return;

  if (!_uiBtnGrads) _buildUiBtnGrads();
  const pb = _uiBtnGrads.ptyBtn;
  const F = 'system-ui, -apple-system, Arial';
  ctx.save();

  ctx.fillStyle = _uiBtnGrads.ptg0;
  roundRect(ctx, pb.x, pb.y, pb.w, pb.h, 9); ctx.fill();

  ctx.strokeStyle = 'rgba(127,181,79,0.8)';
  ctx.lineWidth = 1.5;
  roundRect(ctx, pb.x, pb.y, pb.w, pb.h, 9); ctx.stroke();

  drawIconCtx(ctx, 'party', pb.x + hud(14), pb.y + pb.h / 2, hud(12), '#90d653');
  ctx.font = `bold ${hudF(10)}px ${F}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#90d653';
  ctx.fillText(t('partyInviteBtnLbl'), pb.x + 23, pb.y + pb.h / 2);

  // Инфо — view this target's stats/equipment (works on anyone targeted,
  // not just someone who invited you; see showPeerProfileModal, js/ui.js)
  const ib = getPartyInfoBtnPos();
  ctx.fillStyle = _uiBtnGrads.ptg0;
  roundRect(ctx, ib.x, ib.y, ib.w, ib.h, 9); ctx.fill();
  ctx.strokeStyle = 'rgba(127,181,79,0.8)'; ctx.lineWidth = 1.5;
  roundRect(ctx, ib.x, ib.y, ib.w, ib.h, 9); ctx.stroke();
  ctx.font = `bold ${hudF(10)}px ${F}`; ctx.textAlign = 'center';
  ctx.fillStyle = '#90d653';
  ctx.fillText(t('partyInfoBtnLbl'), ib.x + ib.w / 2, ib.y + ib.h / 2 + 1);

  ctx.restore();
}

// ─────────────────────────────────────────────────────────
//  PARTY HUD (all member HP bars)
// ─────────────────────────────────────────────────────────
let _partyHpGrads = null; // cached {hi,mid,lo,hbx,ctx} — invalidated on resize

function drawPartyHUD() {
  if (!partyMembers.length || !player) return;
  const F = 'system-ui, -apple-system, Arial';
  const bw = 130, bh = 26, gap = 4;
  const pvpBtn = getPvpBtnPos();
  const startX = pvpBtn.x;
  const startY = _partyHudStartY();

  // Cache the three HP bar gradients (position fixed, only depends on startX)
  const _hbx = startX + 20, _hbw = 130 - 24;
  if (!_partyHpGrads || _partyHpGrads.hbx !== _hbx || _partyHpGrads.c !== ctx) {
    const _gh = ctx.createLinearGradient(_hbx, 0, _hbx + _hbw, 0);
    _gh.addColorStop(0, '#314f17'); _gh.addColorStop(1, '#6fb136');
    const _gm = ctx.createLinearGradient(_hbx, 0, _hbx + _hbw, 0);
    _gm.addColorStop(0, '#7a4a0c'); _gm.addColorStop(1, '#e39827');
    const _gl = ctx.createLinearGradient(_hbx, 0, _hbx + _hbw, 0);
    _gl.addColorStop(0, '#64131c'); _gl.addColorStop(1, '#d33d4e');
    _partyHpGrads = { hi: _gh, mid: _gm, lo: _gl, hbx: _hbx, c: ctx };
  }

  partyMembers.forEach((member, i) => {
    const op = otherPlayers.get(member.id);
    const hp = op ? (op.hp || 0) : 0;
    const maxHp = op ? (op.maxHp || 1) : 1;
    const pct = Math.max(0, Math.min(1, hp / maxHp));
    const bx = startX;
    const by = startY + i * (bh + gap);

    ctx.save();
    const bg = ctx.createLinearGradient(bx, by, bx, by + bh);
    bg.addColorStop(0, 'rgba(18,27,11,0.97)'); bg.addColorStop(1, 'rgba(9,13,6,0.99)');
    ctx.fillStyle = bg;
    roundRect(ctx, bx, by, bw, bh, 8); ctx.fill();
    ctx.strokeStyle = 'rgba(117,163,77,0.55)'; ctx.lineWidth = 1.2;
    roundRect(ctx, bx, by, bw, bh, 8); ctx.stroke();

    drawIconCtx(ctx, 'party', bx + hud(11), by + bh / 2, hud(11), '#90d653');

    ctx.font = `bold ${hudF(9)}px ${F}`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#90d653';
    ctx.fillText((member.name || '?').slice(0, 12), bx + 20, by + 10);

    const hbx = bx + 20, hby = by + 13, hbw = bw - 24, hbh = 8;
    ctx.fillStyle = 'rgba(20,27,13,0.9)';
    roundRect(ctx, hbx, hby, hbw, hbh, 3); ctx.fill();
    if (pct > 0) {
      ctx.fillStyle = pct > 0.5 ? _partyHpGrads.hi : pct > 0.25 ? _partyHpGrads.mid : _partyHpGrads.lo;
      roundRect(ctx, hbx, hby, hbw * pct, hbh, 3); ctx.fill();
    }
    ctx.font = `${hudF(6.5)}px ${F}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(193,204,213,0.88)';
    ctx.fillText(Math.ceil(hp) + '/' + maxHp, hbx + hbw / 2, hby + hbh / 2);

    ctx.restore();
  });

  // Leave party button below member list
  const lb = getPartyLeaveBtnPos();
  ctx.save();
  const lbg = ctx.createLinearGradient(lb.x, lb.y, lb.x, lb.y + lb.h);
  lbg.addColorStop(0, 'rgba(47,13,17,0.97)'); lbg.addColorStop(1, 'rgba(24,6,8,0.99)');
  ctx.fillStyle = lbg;
  roundRect(ctx, lb.x, lb.y, lb.w, lb.h, 7); ctx.fill();
  ctx.strokeStyle = 'rgba(209,71,87,0.75)'; ctx.lineWidth = 1.2;
  roundRect(ctx, lb.x, lb.y, lb.w, lb.h, 7); ctx.stroke();
  drawIconCtx(ctx, 'partyLeave', lb.x + hud(13), lb.y + lb.h / 2, hud(10), '#ef6d7c');
  ctx.font = `bold ${hudF(9)}px ${F}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ef6d7c';
  ctx.fillText(t('partyLeaveBtnLbl'), lb.x + 22, lb.y + lb.h / 2);
  ctx.restore();
}

// ─────────────────────────────────────────────────────────
//  PARTY INVITE POPUP
// ─────────────────────────────────────────────────────────
function drawPartyInvitePopup() {
  if (!partyInvitePending) return;
  const inv = partyInvitePending;
  const F = 'system-ui, -apple-system, Arial';
  const pw = 220, ph = 76;
  const px = W / 2 - pw / 2, py = H / 2 - ph / 2;

  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, W, H);

  const bg = ctx.createLinearGradient(px, py, px, py + ph);
  bg.addColorStop(0, 'rgba(18,27,11,0.99)'); bg.addColorStop(1, 'rgba(9,13,6,0.99)');
  ctx.fillStyle = bg;
  roundRect(ctx, px, py, pw, ph, 12); ctx.fill();
  ctx.strokeStyle = 'rgba(127,181,79,0.75)'; ctx.lineWidth = 1.5;
  roundRect(ctx, px, py, pw, ph, 12); ctx.stroke();

  drawIconCtx(ctx, 'party', px + hud(20), py + hud(18), hud(16), '#90d653');
  ctx.font = `bold ${hudF(12)}px ${F}`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#c6d0d9';
  ctx.fillText(t('partyInviteTitle'), px + 34, py + 14);
  ctx.font = `${hudF(10)}px ${F}`; ctx.fillStyle = '#90d653';
  ctx.fillText(inv.fromName, px + 34, py + 28);

  // Accept button
  const ac = getPartyAcceptPos();
  ctx.fillStyle = 'rgba(29,44,16,0.99)';
  roundRect(ctx, ac.x, ac.y, ac.w, ac.h, 8); ctx.fill();
  ctx.strokeStyle = 'rgba(127,181,79,0.8)'; ctx.lineWidth = 1.2;
  roundRect(ctx, ac.x, ac.y, ac.w, ac.h, 8); ctx.stroke();
  ctx.font = `bold ${hudF(11)}px ${F}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = '#90d653';
  ctx.fillText(t('acceptBtn'), ac.x + ac.w / 2, ac.y + ac.h / 2);

  // Decline button
  const dc = getPartyDeclinePos();
  ctx.fillStyle = 'rgba(38,12,15,0.99)';
  roundRect(ctx, dc.x, dc.y, dc.w, dc.h, 8); ctx.fill();
  ctx.strokeStyle = 'rgba(190,60,75,0.8)'; ctx.lineWidth = 1.2;
  roundRect(ctx, dc.x, dc.y, dc.w, dc.h, 8); ctx.stroke();
  ctx.fillStyle = '#ef6d7c';
  ctx.fillText(t('declineBtn'), dc.x + dc.w / 2, dc.y + dc.h / 2);

  // Timer bar
  const alpha = Math.min(1, inv.timer / 3);
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = '#90d653';
  roundRect(ctx, px + 8, py + ph - 6, (pw - 16) * alpha, 3, 2); ctx.fill();
  ctx.globalAlpha = 1;

  ctx.restore();
}

// ─────────────────────────────────────────────────────────
//  INVENTORY ITEM MODAL
// ─────────────────────────────────────────────────────────
const _ENH_MAX = 15;
function _enhSuccessRate(enh) { return Math.max(10, 80 - enh * 10); }
function _enhStoneQty(stoneId) {
  if (!player) return 0;
  const s = player.inventory.find(i => i.id === stoneId);
  return s ? (s.qty || 1) : 0;
}
function _enhStonesBlock(actionFn, param) {
  const normQty  = _enhStoneQty('norm_stone');
  const blessQty = _enhStoneQty('bless_stone');
  const p = JSON.stringify(param);
  return `<div class="imod-enh-stones">
    <button class="imod-enh-stone-btn${normQty > 0 ? '' : ' disabled'}" onclick="${actionFn}(${p},'norm')" title="${t('enhFailBurnHint')}">
      <img src="/images/norm.png" width="16" height="16" style="vertical-align:middle;image-rendering:pixelated;margin-right:4px">${tVars('normalStoneBtnFmt', { n: normQty })}
    </button>
    <button class="imod-enh-stone-btn imod-enh-stone-bless${blessQty > 0 ? '' : ' disabled'}" onclick="${actionFn}(${p},'bless')" title="${t('enhFailKeepHint')}">
      <img src="/images/bless.png" width="16" height="16" style="vertical-align:middle;image-rendering:pixelated;margin-right:4px">${tVars('safeStoneBtnFmt', { n: blessQty })}
    </button>
  </div>
  <div class="imod-enh-warn">${t('enhBurnWarn')}</div>`;
}
const _RARITY_NAMES = { common:'Обычный', uncommon:'Необычный', rare:'Редкий', epic:'Эпический', legendary:'Легендарный' };
// ── все бонусы предмета, одной функцией ─────────────────────────────────────
// Карточка предмета собирала этот список ДВАЖДЫ — для инвентаря и для
// надетого, — и оба знали только про атаку, защиту, здоровье, крит, скорость
// атаки, HP% и силу навыков. Скорость бега, бонус к опыту, бонус к выпадению,
// сила крита и процент атаки не показывались НИГДЕ: предмет их давал (они
// считаются на сервере), а в карточке их не было. Выглядело как «статов не
// хватает».
//
// Одна функция на оба места, чтобы следующий новый бонус не пришлось
// вспоминать дважды.
function _itemStatRows(it, eb) {
  eb = eb || {};
  const rows = [];
  const withEnh = (label, base, add) => {
    const total = (base || 0) + (add || 0);
    if (!total) return;
    rows.push(`${label} <b>+${total}</b>${add ? ` <span style="color:#e69419">(+${add})</span>` : ''}`);
  };
  withEnh('ATK', it.atk, eb.atk);
  withEnh('DEF', it.def, eb.def);
  withEnh('HP', it.hp, eb.hp);
  const pct = (v) => (v * 100).toFixed(0);
  if (it.critChance) rows.push(`${t('statCritInline')} <b>${pct(it.critChance)}%</b>`);
  if (it.atkSpeed)   rows.push(`${t('statSpeedInline')} <b>${pct(it.atkSpeed)}%</b>`);
  if (it.hpPct)      rows.push(`HP% <b>+${pct(it.hpPct)}%</b>`);
  if (it.skillPct)   rows.push(`${t('statSkillPowerInline')} <b>+${pct(it.skillPct)}%</b>`);
  // Ниже — то, чего в карточке не было вовсе.
  if (it.speedPct)   rows.push(`Скорость бега <b>+${pct(it.speedPct)}%</b>`);
  if (it.atkPct)     rows.push(`ATK <b>+${pct(it.atkPct)}%</b>`);
  if (it.critPower)  rows.push(`Сила крита <b>+${pct(it.critPower)}%</b>`);
  if (it.xpPct)      rows.push(`Опыт <b>+${pct(it.xpPct)}%</b>`);
  if (it.dropPct)    rows.push(`Шанс дропа <b>+${pct(it.dropPct)}%</b>`);
  return rows;
}

const _SLOT_NAMES   = { weapon:'Оружие', helmet:'Шлем', body:'Броня', gloves:'Перчатки', boots:'Боты', ring:'Кольцо', belt:'Пояс', pet:'Питомец', cloak:'Плащ', artifact:'Артефакт', wings:'Крылья', use:'Расходник', material:'Материал', recipe:'Рецепт', buff_potion:'Зелье усиления', box:'Бокс' };

function openInvItemModal(idx) {
  if (!player) return;
  const it = player.inventory[idx];
  if (!it) return;

  // Buff potion — show use modal
  if (it.slot === 'buff_potion') {
    closeInvItemModal();
    const btype = it.buffType;
    const active = btype && ((player.buffs || {})[btype] || 0) > 0;
    const remaining = active ? Math.ceil((player.buffs[btype] || 0) / 60) : 0;
    const qty = it.qty || 1;
    const autoOn = !!((player.autoBuffTypes || {})[btype]);
    const ov = document.createElement('div');
    ov.id = 'inv-item-modal-ov';
    ov.className = 'imod-overlay';
    ov.onclick = closeInvItemModal;
    ov.innerHTML = `<div class="imod-box" onclick="event.stopPropagation()" style="max-width:340px">
      <div class="imod-hdr">
        <span class="imod-big-icon">${_itemIcon(it, 52)}</span>
        <div class="imod-title-block">
          <div class="imod-name" style="color:#e5a546">${it.name}</div>
          <div class="imod-sub"><span style="color:#e5a546">${_RARITY_NAMES[it.rarity]||it.rarity}</span> · ${t('buffPotionSlotName')} · ×${qty}</div>
        </div>
        <button class="npc-close" onclick="closeInvItemModal()" style="touch-action:manipulation">✕</button>
      </div>
      <div class="imod-stats">${it.buffDesc || ''}</div>
      ${active ? `<div style="padding:8px 12px;background:rgba(229,165,70,0.1);border-radius:8px;color:#e5a546;font-size:12px;text-align:center">${tVars('activeRemainingFmt', { n: remaining })}</div>` : ''}
      <div class="imod-btns">
        <button class="imod-btn imod-equip${active ? ' disabled' : ''}" onclick="${active ? '' : `useBuffPotion('${it.id}');closeInvItemModal()`}">
          ${active ? t('alreadyActiveLbl') : t('useBtn')}
        </button>
        <button class="imod-btn" onclick="toggleAutoBuffPotion('${btype}');openInvItemModal(${idx})" style="
          background:${autoOn ? 'rgba(144,214,83,0.15)' : 'rgba(209,204,197,0.08)'};
          color:${autoOn ? '#90d653' : '#968a7a'};
          border:1px solid ${autoOn ? '#90d65344' : 'transparent'};
        ">
          ${t('autoLbl')}: ${autoOn ? t('onLbl') : t('offLbl')}
        </button>
      </div>
      <div style="font-size:10px;color:#72685a;text-align:center;margin-top:8px">${t('autoBuffHint')}</div>
    </div>`;
    document.getElementById('app').appendChild(ov);
    return;
  }

  if (it.slot === 'box') { closeInvItemModal(); openBoxModal(idx); return; }

  if (_isStackable(it) || it.slot === 'use') return;

  const rc    = RARITY_COLOR[it.rarity] || '#aea599';
  const enh   = it.enhance || 0;
  const eb    = _enhBonus(it);
  const next1 = _enhBonusAt(it, 1);

  // Stats display with enhance bonus highlighted
  const statRows = _itemStatRows(it, eb);

  // Next enhance preview
  const canEnh = enh < _ENH_MAX;
  const nextParts = [];
  if (next1.atk) nextParts.push(`+${next1.atk} ATK`);
  if (next1.def) nextParts.push(`+${next1.def} DEF`);
  if (next1.hp)  nextParts.push(`+${next1.hp} HP`);

  const rate = _enhSuccessRate(enh);
  const rateColor = rate >= 80 ? '#98e456' : rate >= 50 ? '#e6ac19' : rate >= 30 ? '#e69419' : '#eb4e61';
  const enhBlock = canEnh
    ? `<div class="imod-enh-block">
        <div class="imod-enh-title">${tVars('enhanceTitleFmt', { cur: enh > 0 ? '+' + enh : '0', next: '<span style="color:#e69419">+' + (enh+1) + '</span>' })}</div>
        ${nextParts.length ? `<div class="imod-enh-preview">${nextParts.join(' · ')}</div>` : ''}
        <div class="imod-enh-chance">${tVars('enhChanceFmt', { rate: `<b style="color:${rateColor}">${rate}</b>` })}</div>
        ${_enhStonesBlock('enhanceItem', idx)}
      </div>`
    : `<div class="imod-enh-block"><div class="imod-enh-title" style="color:#e69419">${t('maxEnhanceLbl')}</div></div>`;

  closeInvItemModal();
  const ov = document.createElement('div');
  ov.id = 'inv-item-modal-ov';
  ov.className = 'imod-overlay';
  ov.onclick = closeInvItemModal;
  ov.innerHTML = `<div class="imod-box" onclick="event.stopPropagation()">
    <div class="imod-hdr">
      <span class="imod-big-icon">${_itemIcon(it, 52)}</span>
      <div class="imod-title-block">
        <div class="imod-name" style="color:${rc}">${it.name}${enh ? ` <span style="color:#e69419">+${enh}</span>` : ''}</div>
        <div class="imod-sub"><span style="color:${rc}">${_RARITY_NAMES[it.rarity]||it.rarity}</span> · ${_SLOT_NAMES[it.slot]||it.slot}</div>
      </div>
      <button class="npc-close" onclick="closeInvItemModal()" style="touch-action:manipulation">✕</button>
    </div>
    <div class="imod-stats">${statRows.join('<br>') || '—'}</div>
    ${enhBlock}
    <div class="imod-btns">
      <button class="imod-btn imod-equip" onclick="equipFromModal(${idx})">${t('equipBtn')}</button>
      ${it.rarity === 'common' ? `<button class="imod-btn imod-sell" onclick="sellCommonItem(${idx})">${t('sellForFmt')}${iconHTML('coin',12,'#e3941d')}</button>` : ''}
      ${_seasonBurnPts(it) ? `<button class="imod-btn imod-sell" style="border-color:#50af95;color:#7ee0c0" onclick="burnItemForSeason(${idx})">${tVars('seasonBurnBtn', { n: _seasonBurnPts(it) })}</button>` : ''}
    </div>
  </div>`;
  document.getElementById('app').appendChild(ov);
}

function closeInvItemModal() {
  const el = document.getElementById('inv-item-modal-ov');
  if (el) el.remove();
}

function equipFromModal(idx) {
  closeInvItemModal();
  equipItem(idx);
}

// Selling is server-side (see the sellItem handler, server/index.js): it owns
// both halves of the trade, including the price. Removing the item and adding
// the gold locally, then relying on the next saveProgress to carry it, is
// exactly the pattern the save path no longer accepts — the item removal would
// land but the gold would be clamped back off, i.e. the player would sell for
// nothing. The inventory and the balance both come back over
// inventorySync/itemSold.

function sellCommonItem(idx) {
  if (!player) return;
  const it = player.inventory[idx];
  if (!it || it.rarity !== 'common') return;
  if (typeof netSellItem === 'function') netSellItem(idx, it.id, it.enhance || 0);
  closeInvItemModal();
}

// Season points this item is worth if burned, or 0 when it cannot be burned.
// Mirrors the server's own rule (SEASON_BURN_POINTS, and non-stackable only)
// — the server re-checks it anyway, this just decides whether to offer it.
function _seasonBurnPts(it) {
  if (!it || typeof _seasonState === 'undefined') return 0;
  if (!_seasonState.active) return 0;
  if (typeof _isStackable === 'function' && _isStackable(it)) return 0;
  return (_seasonState.burn || {})[it.rarity] || 0;
}

// The server destroys the item and adds the points — nothing local.
function burnItemForSeason(idx) {
  if (!player) return;
  const it = player.inventory[idx];
  if (!_seasonBurnPts(it)) return;
  // The item's own identity goes with the index — the server verifies the two
  // agree before destroying anything (see netSeasonBurn).
  if (typeof netSeasonBurn === 'function') netSeasonBurn(idx, it.id, it.enhance || 0);
  closeInvItemModal();
}

// ── Loot boxes ────────────────────────────────────────────
// Пул — общий с сервером (boxLootPool, shared/definitions.js). Здесь стоял
// свой список слотов, и он был ПРАВ, а сервер выдавал шире: панель обещала
// десять предметов, сервер мог отдать двадцать четыре. Теперь список один, и
// разойтись им нечем.
//
// Оружие фильтруется по классу дополнительно, и только здесь: панель
// показывает то, что игроку пригодится. Сервер этого не делает — из ящика
// по-прежнему может прийти оружие чужого класса.
function _boxCandidates(rarity) {
  return boxLootPool(rarity).filter(d =>
    d.slot !== 'weapon' || (d.forClass && player && d.forClass.includes(player.type)));
}

function openBoxModal(idx) {
  if (!player) return;
  const it = player.inventory[idx];
  if (!it) return;
  const boxDef = BOX_DEF.find(b => b.id === it.id);
  if (!boxDef) return;
  const qty = it.qty || 1;
  const rc = RARITY_COLOR[boxDef.rarity] || '#aea599';

  const oddsHtml = boxDef.odds.map(o => {
    const rcO = RARITY_COLOR[o.rarity] || '#aea599';
    const cands = _boxCandidates(o.rarity);
    const icons = cands.map(c => `<span title="${c.name}" style="display:inline-block;margin:2px">${_itemIcon(c, 26)}</span>`).join('');
    return `<div class="box-odds-row">
      <div class="box-odds-hdr" style="color:${rcO}">${_RARITY_NAMES[o.rarity] || o.rarity} · <b>${Math.round(o.chance * 100)}%</b></div>
      <div class="box-odds-icons">${icons || '—'}</div>
    </div>`;
  }).join('');

  closeInvItemModal();
  const ov = document.createElement('div');
  ov.id = 'inv-item-modal-ov';
  ov.className = 'imod-overlay';
  ov.onclick = closeInvItemModal;
  ov.innerHTML = `<div class="imod-box" onclick="event.stopPropagation()" style="max-width:380px;max-height:80vh;overflow-y:auto">
    <div class="imod-hdr">
      <span class="imod-big-icon">${_itemIcon(boxDef, 52)}</span>
      <div class="imod-title-block">
        <div class="imod-name" style="color:${rc}">${boxDef.name}</div>
        <div class="imod-sub"><span style="color:${rc}">${_RARITY_NAMES[boxDef.rarity] || boxDef.rarity}</span> · ${t('boxSlotName')} · ×${qty}</div>
      </div>
      <button class="npc-close" onclick="closeInvItemModal()" style="touch-action:manipulation">✕</button>
    </div>
    <div style="font-size:11px;color:#968a7a">${t('boxOpensRandomHint')}</div>
    <div class="box-odds-list">${oddsHtml}</div>
    <div class="imod-btns">
      <button class="imod-btn imod-equip" onclick="openLootBox(${idx})">${t('openBtn')}</button>
    </div>
  </div>`;
  document.getElementById('app').appendChild(ov);
}

// Settled server-side ('openLootBox', server/index.js) — used to roll both
// the rarity and the resulting item right here, reaching the server only via
// the next saveProgress. The server owns both rolls and the grant now; this
// just asks and waits for onBoxOpened to report what it got.
function openLootBox(idx) {
  if (!player) return;
  const it = player.inventory[idx];
  if (!it) return;
  const boxDef = BOX_DEF.find(b => b.id === it.id);
  if (!boxDef) return;
  if (!invHasSpace()) { dmgNum(player.x, player.y - 30, t('invFull'), '#f17e8b'); return; }
  if (typeof netOpenLootBox === 'function') netOpenLootBox(it.id);
  closeInvItemModal();
}

function onBoxOpened({ item } = {}) {
  if (!player || !item) return;
  dmgNum(player.x, player.y - 30, '+ ' + item.name, RARITY_COLOR[item.rarity] || '#c4a276');
}

function onOpenBoxError(msg) {
  _marketToast(msg || t('purchaseErrorLbl'), 'err');
}

// Enhancing used to be resolved entirely here (roll the chance, spend the
// stone, bump .enhance) and only reach the server on the next autosave —
// which is exactly how an item could show up already at max enhance without
// ever touching a stone. The roll now happens server-side (see 'enhanceItem'
// in server/index.js); this just asks and waits for onEnhanceResult to apply
// whatever the server actually did.
function enhanceItem(idx, stoneType) {
  if (!player) return;
  const it = player.inventory[idx];
  if (!it) return;
  const enh = it.enhance || 0;
  if (enh >= _ENH_MAX) return;
  const stoneId = stoneType === 'bless' ? 'bless_stone' : 'norm_stone';
  if (_enhStoneQty(stoneId) <= 0) { dmgNum(player.x, player.y - 30, t('noStoneToast'), '#f17e8b'); return; }
  // rowId names the exact copy. Without it the server matched on (id, enhance)
  // and enhanced whichever row came first, which is how enhancing one item
  // walked every identical one up alongside it.
  if (typeof netEnhanceItem === 'function') netEnhanceItem(it.id, enh, stoneType, null, it.rowId);
}

function openEqItemModal(slot) {
  if (!player) return;
  const it = player.equipment[slot];
  if (!it) return;

  const rc   = RARITY_COLOR[it.rarity] || '#aea599';
  const enh  = it.enhance || 0;
  const eb   = _enhBonus(it);
  const next1 = _enhBonusAt(it, 1);

  const statRows = _itemStatRows(it, eb);

  const canEnh = enh < _ENH_MAX;
  const nextParts = [];
  if (next1.atk) nextParts.push(`+${next1.atk} ATK`);
  if (next1.def) nextParts.push(`+${next1.def} DEF`);
  if (next1.hp)  nextParts.push(`+${next1.hp} HP`);

  const rate2 = _enhSuccessRate(enh);
  const rateColor2 = rate2 >= 80 ? '#98e456' : rate2 >= 50 ? '#e6ac19' : rate2 >= 30 ? '#e69419' : '#eb4e61';
  const enhBlock = canEnh
    ? `<div class="imod-enh-block">
        <div class="imod-enh-title">${tVars('enhanceTitleFmt', { cur: enh > 0 ? '+' + enh : '0', next: '<span style="color:#e69419">+' + (enh+1) + '</span>' })}</div>
        ${nextParts.length ? `<div class="imod-enh-preview">${nextParts.join(' · ')}</div>` : ''}
        <div class="imod-enh-chance">${tVars('enhChanceFmt', { rate: `<b style="color:${rateColor2}">${rate2}</b>` })}</div>
        ${_enhStonesBlock('enhanceEqItem', slot)}
      </div>`
    : `<div class="imod-enh-block"><div class="imod-enh-title" style="color:#e69419">${t('maxEnhanceLbl')}</div></div>`;

  closeInvItemModal();
  const ov = document.createElement('div');
  ov.id = 'inv-item-modal-ov';
  ov.className = 'imod-overlay';
  ov.onclick = closeInvItemModal;
  ov.innerHTML = `<div class="imod-box" onclick="event.stopPropagation()">
    <div class="imod-hdr">
      <span class="imod-big-icon">${_itemIcon(it, 52)}</span>
      <div class="imod-title-block">
        <div class="imod-name" style="color:${rc}">${it.name}${enh ? ` <span style="color:#e69419">+${enh}</span>` : ''}</div>
        <div class="imod-sub"><span style="color:${rc}">${_RARITY_NAMES[it.rarity]||it.rarity}</span> · ${_SLOT_NAMES[it.slot]||it.slot} · <span style="color:#eec276">${t('equippedLbl')}</span></div>
      </div>
      <button class="npc-close" onclick="closeInvItemModal()" style="touch-action:manipulation">✕</button>
    </div>
    <div class="imod-stats">${statRows.join('<br>') || '—'}</div>
    ${enhBlock}
    <div class="imod-btns">
      <button class="imod-btn imod-equip" style="background:linear-gradient(135deg,#381c1f,#672d34);color:#f28a96" onclick="unequipFromModal('${slot}')">${t('unequipBtn')}</button>
    </div>
  </div>`;
  document.getElementById('app').appendChild(ov);
}

function unequipFromModal(slot) {
  closeInvItemModal();
  unequipItem(slot);
}

// Same server round-trip as enhanceItem above, targeting an equipped slot
// instead of an inventory index.
function enhanceEqItem(slot, stoneType) {
  if (!player) return;
  const it = player.equipment[slot];
  if (!it) return;
  const enh = it.enhance || 0;
  if (enh >= _ENH_MAX) return;
  const stoneId = stoneType === 'bless' ? 'bless_stone' : 'norm_stone';
  if (_enhStoneQty(stoneId) <= 0) { dmgNum(player.x, player.y - 30, t('noStoneToast'), '#f17e8b'); return; }
  if (typeof netEnhanceItem === 'function') netEnhanceItem(it.id, enh, stoneType, slot);
}

// Applies whatever server/index.js's 'enhanceItem' handler actually rolled.
// inventorySync (js/network.js) lands first on the same socket and already
// wrote the new inventory/equipment into `player` — this only handles the
// user-facing side: toast, and reopening the item modal at its new state (or
// closing it, on a burn).
function onEnhanceResult({ id, slot, outcome, newEnhance, rowId } = {}) {
  if (!player) return;
  if (outcome === 'success') {
    dmgNum(player.x, player.y - 30, tVars('enhSuccessToast', { n: newEnhance }), '#e69419');
  } else if (outcome === 'fail') {
    dmgNum(player.x, player.y - 30, t('enhFailedToast'), '#f17e8b');
  } else {
    dmgNum(player.x, player.y - 30, t('itemBurnedToast'), '#eb4e61');
  }
  if (outcome === 'burned') {
    closeInvItemModal();
  } else if (slot) {
    openEqItemModal(slot);
  } else {
    // By row when the server named one — the inventory can hold two copies of
    // the same item at the same level, and identity alone reopens whichever
    // comes first. Identity stays as the fallback.
    let idx = rowId != null
      ? player.inventory.findIndex(i => i && i.rowId === rowId)
      : -1;
    if (idx < 0) {
      idx = player.inventory.findIndex(i => i && i.id === id && (i.enhance || 0) === newEnhance);
    }
    if (idx >= 0) openInvItemModal(idx);
  }
}

function onEnhanceError(msg) {
  _marketToast(msg || t('purchaseErrorLbl'), 'err');
}


// ─────────────────────────────────────────────────────────
//  СЕЗОН — rotating kill quests + points leaderboard
// ─────────────────────────────────────────────────────────
// Points and quest progress are server-owned (see the season handlers in
// server/index.js); everything here renders what arrived and asks for a
// refresh, it never computes a point itself.
function _positionSeasonBtn() {
  const evBtn = document.getElementById('events-btn');
  const btn   = document.getElementById('season-btn');
  if (!btn || !evBtn) return;
  const eTop = parseFloat(evBtn.style.top) || 0;
  btn.style.top       = (eTop + 28 + 4) + 'px';
  btn.style.left      = evBtn.style.left;
  btn.style.width     = evBtn.style.width;
  btn.style.right     = 'auto';
  btn.style.transform = 'none';
}

function showSeasonBtn() {
  const btn = document.getElementById('season-btn');
  if (btn) { btn.dataset.shown = '1'; btn.style.display = _hudSubBtnDisplay(); _positionSeasonBtn(); }
}

// Stacks directly below the Season button, same offset every other button in
// this column uses.
function _positionCodexBtn() {
  const seasonBtn = document.getElementById('season-btn');
  const btn        = document.getElementById('codex-btn');
  if (!btn || !seasonBtn) return;
  const sTop = parseFloat(seasonBtn.style.top) || 0;
  btn.style.top       = (sTop + 28 + 4) + 'px';
  btn.style.left      = seasonBtn.style.left;
  btn.style.width     = seasonBtn.style.width;
  btn.style.right     = 'auto';
  btn.style.transform = 'none';
}

function showCodexBtn() {
  const btn = document.getElementById('codex-btn');
  if (btn) { btn.dataset.shown = '1'; btn.style.display = _hudSubBtnDisplay(); _positionCodexBtn(); }
}

// Сезон 2. Three tabs: Сезон (description + rewards), Задания (how to earn
// points), Рейтинг (leaderboard, 5000+ points only). Points are server-owned
// (see the season handlers in server/index.js) — everything here renders
// what arrived and asks for a refresh, it never computes a point itself.
let _seasonTab = 'season';

function openSeasonPanel() {
  const panel = document.getElementById('season-panel');
  if (!panel) return;
  panel.style.display = 'flex';
  if (typeof netSeasonSync === 'function') netSeasonSync();
  if (_seasonTab === 'rating' && typeof netSeasonRating === 'function') netSeasonRating();
  _renderSeasonBody();
}

function closeSeasonPanel() {
  const panel = document.getElementById('season-panel');
  if (panel) panel.style.display = 'none';
}

function _seasonPanelOpen() {
  return document.getElementById('season-panel')?.style.display === 'flex';
}

function switchSeasonTab(tab) {
  _seasonTab = tab;
  document.querySelectorAll('#season-panel .rating-tab').forEach(b => b.classList.remove('active'));
  document.getElementById('stab-' + tab)?.classList.add('active');
  // The leaderboard is a database query, so it is fetched on demand rather
  // than pushed — asking for it here keeps it fresh without polling.
  if (tab === 'rating' && typeof netSeasonRating === 'function') netSeasonRating();
  _renderSeasonBody();
}

function _renderSeasonBody() {
  const body = document.getElementById('season-panel-body');
  if (!body) return;
  body.innerHTML = _seasonTab === 'rating' ? _seasonRatingHTML()
                  : _seasonTab === 'tasks' ? _seasonTasksHTML()
                  : _seasonInfoHTML();
}

// Prize table — display only, the payout itself happens outside the game.
// Places 1-10 pay USDT; 11-20 pay a VIP level instead (vipPrize).
function _seasonPrizesHTML() {
  const st = _seasonState || {};
  const prizes = st.prizes || [];
  const vip = st.vipPrize;
  const medal = p => p === 1 ? '🥇' : p === 2 ? '🥈' : p === 3 ? '🥉' : '🏅';
  return `<div class="db-rewards-hdr">${t('seasonPrizesHdr')}</div>
    <div class="db-rewards">
      ${prizes.map(p => `<div class="db-reward-row">
        <span class="db-reward-fallback">${medal(p.place)}</span>
        <span>${tVars('seasonPlaceFmt', { n: p.place })}</span>
        <span class="db-reward-qty">${p.usdt} USDT</span>
      </div>`).join('')}
      ${vip ? `<div class="db-reward-row">
        <span class="db-reward-fallback">⭐</span>
        <span>${tVars('seasonPlaceRangeFmt', { a: vip.from, b: vip.to })}</span>
        <span class="db-reward-qty">VIP ${vip.vip}</span>
      </div>` : ''}
    </div>`;
}

// ── "Сезон" tab: description + countdown + rewards ─────────────────────────
function _seasonInfoHTML() {
  const st = _seasonState || {};
  const left = Math.max(0, (st.endAt || 0) - Date.now());
  const ended = !st.active || left <= 0;
  return `
    <div style="padding:16px">
      <div class="season-card">
        <div class="season-card-rule"><span>✦ LIBERTY ✦</span></div>
        <div class="season-card-title">${t('season2Title')}</div>
        <div class="season-card-sub">${t('season2Desc')}</div>
        <div class="db-countdown">${st.points || 0}</div>
        <div class="db-phase">${t('seasonPointsLbl')}</div>
        <div class="db-count">${ended ? t('seasonEnded') : tVars('seasonEndsIn', { t: _fmtEventEta(left) })}</div>
      </div>
      ${_seasonPrizesHTML()}
    </div>`;
}

// ── "Задания" tab: every way to earn points, plus the burn controls ────────
// The point VALUES all come from _seasonState (pushed by seasonSync), never
// hard-coded here — the advertised figure and the paid one cannot drift
// apart that way.
function _seasonBookStacks() {
  if (!player || !Array.isArray(player.inventory)) return [];
  const out = [];
  for (const it of player.inventory) {
    if (!it) continue;
    const base = typeof itemCatalogBase === 'function' ? itemCatalogBase(it.id) : null;
    if (!base || !(base.skillKey || base.passiveId || base.advSkillKey)) continue;
    out.push({ id: it.id, name: it.name || base.name, qty: it.qty || 1 });
  }
  return out;
}

function _seasonTasksHTML() {
  const st = _seasonState || {};
  const ended = !st.active;
  const sp = st.enhanceSpecial || {};
  const gear = st.enhanceGear || {};
  const bp = st.burn || { common: 1, uncommon: 5 };

  const enhSpecialRows = ['common', 'uncommon', 'rare'].filter(r => sp[r]).map(r =>
    `<li>${tVars('season2EnhSpecialFmt', { r: _RARITY_NAMES[r] || r, norm: sp[r].norm, safe: sp[r].bless })}</li>`
  ).join('');
  const enhGearRows = ['rare', 'epic'].filter(r => gear[r]).map(r =>
    `<li>${tVars('season2EnhGearFmt', { r: _RARITY_NAMES[r] || r, n: gear[r] })}</li>`
  ).join('');

  const bookStacks = _seasonBookStacks();
  const bookRows = bookStacks.map(s => `
    <div class="season-book-row">
      <span class="season-book-name">${_esc(s.name)}</span>
      <span class="season-book-qty">× ${s.qty}</span>
      <button class="imod-btn imod-sell" style="border-color:#50af95;color:#7ee0c0"
              onclick="_seasonBurnBookConfirm('${s.id}')">${tVars('seasonBurnBtn', { n: s.qty * (st.bookBurnPoints || 60) })}</button>
    </div>`).join('');

  return `
    <div style="padding:16px">
      <div class="db-rules">
        <b>${t('season2EnhSpecialHdr')}</b>
        <ul>${enhSpecialRows}</ul>
        <b>${t('season2EnhGearHdr')}</b>
        <ul>${enhGearRows}</ul>
        <ul>
          <li>${tVars('season2AdvBookFmt', { n: st.advBookPoints || 300 })}</li>
          <li>${tVars('season2EmpowerFmt', { n: st.empowerPoints || 500 })}</li>
          <li>${tVars('season2ShopFmt', { n: st.shopPointsPerGram || 100 })}</li>
          <li>${tVars('seasonRefTask', { lv: (st.ref || {}).level || 20, n: (st.ref || {}).points || 200 })}</li>
        </ul>
        <div class="imod-enh-chance">${t('seasonRefNote')}</div>
      </div>
      ${ended ? '' : `<div class="db-rules">
        ${t('seasonBurnHdr')}
        <ul>
          <li>${tVars('seasonBurnCommon', { n: bp.common })}</li>
          <li>${tVars('seasonBurnUncommon', { n: bp.uncommon })}</li>
          <li>${tVars('season2BurnBookFmt', { n: st.bookBurnPoints || 60 })}</li>
          <li>${t('seasonBurnNote')}</li>
        </ul>
        <div class="season-burn-grid">
          <button class="db-action" onclick="_seasonBurnAllConfirm('common')">${t('seasonBurnAllCommon')}</button>
          <button class="db-action" onclick="_seasonBurnAllConfirm('uncommon')">${t('seasonBurnAllUncommon')}</button>
        </div>
        ${bookRows ? `<div style="margin-top:10px">${bookRows}</div>` : ''}
      </div>`}
    </div>`;
}

// Bulk burn is destructive and irreversible, so it asks first and says
// exactly how many items are about to go.
function _seasonBurnAllConfirm(rarity) {
  if (!player) return;
  const n = (player.inventory || []).filter(i => i && i.rarity === rarity && !_isStackable(i)).length;
  if (!n) { _marketToast(t('seasonNothingToBurn'), 'err'); return; }
  const pts = n * ((_seasonState.burn || {})[rarity] || 0);
  if (!confirm(tVars('seasonBurnAllConfirm', { n, p: pts }))) return;
  if (typeof netSeasonBurnAll === 'function') netSeasonBurnAll(rarity);
}

// Same "ask, then send the whole stack" shape as the bulk gear burn above.
function _seasonBurnBookConfirm(id) {
  const s = _seasonBookStacks().find(x => x.id === id);
  if (!s) return;
  const pts = s.qty * ((_seasonState || {}).bookBurnPoints || 60);
  if (!confirm(tVars('season2BurnBookConfirm', { name: s.name, n: s.qty, p: pts }))) return;
  if (typeof netSeasonBurnBook === 'function') netSeasonBurnBook(id, s.qty);
}

// ── "Рейтинг" tab: top 50, 5000+ points only ────────────────────────────────
function _seasonRatingHTML() {
  const r = _seasonRating;
  if (!r) return `<div style="padding:16px"><div class="db-phase">${t('seasonLoading')}</div></div>`;
  const rows = (r.list || []).map(x => {
    const mine = r.me && x.username === r.me.username;
    const pc = x.place <= 3 ? ' p' + x.place : '';
    return `<div class="season-row${mine ? ' me' : ''}">
      <span class="season-place${pc}">${x.place}</span>
      <span class="season-name">${_esc(x.username)}</span>
      <span class="season-pts">${x.points}</span>
    </div>`;
  }).join('');
  const meOutside = r.me && r.me.place > 0 && !(r.list || []).some(x => x.username === r.me.username);
  const meRow = meOutside
    ? `<div class="season-row me" style="margin-top:10px">
         <span class="season-place">${r.me.place}</span>
         <span class="season-name">${_esc(r.me.username)}</span>
         <span class="season-pts">${r.me.points}</span>
       </div>`
    : '';
  return `<div style="padding:16px">
    <div class="imod-enh-chance" style="margin-bottom:10px">${tVars('season2RatingMinFmt', { n: r.minPoints || 5000 })}</div>
    ${rows || `<div class="db-phase">${t('seasonNoPlayers')}</div>`}
    ${meRow}
    ${_seasonPrizesHTML()}
  </div>`;
}

// Pushed by the server on every points change.
function onSeasonState() {
  if (_seasonPanelOpen() && _seasonTab !== 'rating') _renderSeasonBody();
  // The ticket info modal (_openSeasonTicketInfo) may be sitting on the
  // default/stale _seasonState from before this sync landed — rebuild it now
  // that the real one is in. Renders only, does NOT re-request a sync (that
  // would loop: seasonState -> onSeasonState -> sync -> seasonState -> ...).
  if (document.getElementById('season-ticket-info-ov')) _renderSeasonTicketInfo();
}
function onSeasonRating() {
  if (_seasonPanelOpen() && _seasonTab === 'rating') _renderSeasonBody();
}

// ─────────────────────────────────────────────────────────
//  DEAD SCREEN
// ─────────────────────────────────────────────────────────
function drawDead() {
  ctx.fillStyle = 'rgba(0,0,0,.65)'; ctx.fillRect(0, 0, W, H);
}

// ─────────────────────────────────────────────────────────
//  GRAM WALLET (Profile tab)
// ─────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────
//  RATING PANEL
// ─────────────────────────────────────────────────────────
let _ratingTab = 'players';
let _ratingData = { players: null, clans: null };

// hud-menu-btn sits directly under the minimap plate, aligned to it —
// everything else in this column chains its position off the button above it,
// so this one anchor cascades the whole stack.
function _positionHudMenuBtn() {
  const btn = document.getElementById('hud-menu-btn');
  if (!btn) return;
  // W is set by the canvas resize (js/game.js). The login handshake can beat
  // that on a warm cache, and this column is laid out from the right edge —
  // without a width the whole stack lands at x=0, on top of the Мир/Проф
  // buttons. Come back on the next frame instead of writing NaNpx.
  if (!W) { requestAnimationFrame(_positionHudColumn); return; }
  const mp = hudMiniMapRect();
  btn.style.top   = (mp.y + mp.h + 6) + 'px';
  btn.style.left  = mp.x + 'px';
  btn.style.width = mp.w + 'px';
  btn.style.right = 'auto';
  btn.style.transform = 'none';
}

// Re-runs the whole chain top-down. Called on resize (js/game.js) and
// whenever the column is unfolded, so a stale or half-applied layout can
// never survive on screen.
function _positionHudColumn() {
  _positionHudMenuBtn();
  _positionRatingBtn();
  _positionVipBtn();
  _positionMarketBtn();
  _positionGramShopBtn();
  _positionEventsBtn();
  _positionSeasonBtn();
  _positionCodexBtn();
}

function showHudMenuBtn() {
  const btn = document.getElementById('hud-menu-btn');
  if (btn) { btn.dataset.shown = '1'; btn.style.display = (activeTab === 0) ? 'flex' : 'none'; _positionHudMenuBtn(); }
}

function _positionRatingBtn() {
  const menuBtn = document.getElementById('hud-menu-btn');
  const btn     = document.getElementById('rating-btn');
  if (!btn || !menuBtn) return;
  const mTop = parseFloat(menuBtn.style.top) || 0;
  btn.style.top       = (mTop + 28 + 4) + 'px';
  btn.style.left      = menuBtn.style.left;
  btn.style.width     = menuBtn.style.width;
  btn.style.right     = 'auto';
  btn.style.transform = 'none';
}

function showRatingBtn() {
  const btn = document.getElementById('rating-btn');
  if (btn) { btn.dataset.shown = '1'; btn.style.display = _hudSubBtnDisplay(); _positionRatingBtn(); }
}

function openRatingPanel() {
  const panel = document.getElementById('rating-panel');
  if (!panel) return;
  if (player && (player.lvl || 1) < FEATURE_UNLOCK_LEVEL) {
    if (typeof dmgNum === 'function') dmgNum(player.x, player.y - 38, tVars('ratingUnlockToast', { n: FEATURE_UNLOCK_LEVEL }), '#eaa742');
    return;
  }
  panel.style.display = 'flex';
  _ratingData = { players: null, clans: null };
  switchRatingTab(_ratingTab);
}

function closeRatingPanel() {
  const panel = document.getElementById('rating-panel');
  if (panel) panel.style.display = 'none';
}

function switchRatingTab(tab) {
  _ratingTab = tab;
  document.querySelectorAll('.rating-tab').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('rtab-' + tab);
  if (btn) btn.classList.add('active');
  _renderRatingBody();
  if (typeof netGetRating === 'function') netGetRating(tab);
}

function onRatingData(tab, rows) {
  _ratingData[tab] = rows;
  if (_ratingTab === tab) _renderRatingBody();
}

// getRating refused. The tab is left EMPTY rather than filled with a lie, and
// the panel says so instead of showing the loading line forever — which is
// what it did while nothing listened for this: _ratingData[tab] stays null on
// a refusal, _renderRatingBody draws t('questLoading') for null, and the
// five-minute ticker below re-asks and fails again, silently, for as long as
// the panel is open. Rendered into the body rather than toasted because the
// player is looking at the panel: a toast four seconds long cannot explain a
// spinner that stays.
function onRatingError(msg) {
  const el = document.getElementById('rating-body');
  if (el) el.innerHTML = `<div class="rating-empty">${_escHtml(msg || t('ratingErrorToast'))}</div>`;
  if (typeof _marketToast === 'function') _marketToast(msg || t('ratingErrorToast'), 'err');
}

function _ratingPanelOpen() {
  return document.getElementById('rating-panel')?.style.display === 'flex';
}

// getRating (server/index.js) is a plain request/response — nothing pushes
// fresh standings on its own, so a panel left open just kept showing
// whatever it fetched on open/tab-switch forever (everyone's BM/clan totals
// climbing in the background, invisible to anyone already looking at the
// list). Same ticker shape the Events panel uses for its own countdown
// (_eventsPanelOpen, just above): re-request the tab actually on screen
// every 5 minutes while the panel is open, no-op otherwise.
if (typeof setInterval === 'function') {
  setInterval(() => {
    if (_ratingPanelOpen() && typeof netGetRating === 'function') netGetRating(_ratingTab);
  }, 5 * 60 * 1000);
}

function _renderRatingBody() {
  const el = document.getElementById('rating-body');
  if (!el) return;
  const rows = _ratingData[_ratingTab];
  if (!rows) {
    el.innerHTML = `<div class="rating-loading">${t('questLoading')}</div>`;
    return;
  }
  if (!rows.length) {
    el.innerHTML = `<div class="rating-empty">${t('noDataLbl')}</div>`;
    return;
  }

  if (_ratingTab === 'players') {
    const myUsername = typeof netUsername !== 'undefined' ? netUsername : '';
    let html = '';
    rows.forEach((r, i) => {
      const isGap = r.gap;
      if (isGap) {
        html += `<div class="rating-gap">• • •</div>`;
      }
      const rank = r.rank != null ? r.rank : i + 1;
      const rankCls = rank === 1 ? 'rating-rank-1' : rank === 2 ? 'rating-rank-2' : rank === 3 ? 'rating-rank-3' : '';
      const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : rank;
      const isMe = r.username === myUsername || r.isSelf;
      // Escaped for the same reason as the market row above — a player whose
      // Telegram account has no @handle carries their first_name here, and
      // every row of this table lands in innerHTML.
      const init = _escHtml((r.username || '?')[0].toUpperCase());
      const uname = _escHtml(r.username || '');
      html += `<div class="rating-row${isMe ? ' rating-me' : ''}">
        <div class="rating-rank ${rankCls}">${medal}</div>
        <div class="rating-avatar">${init}</div>
        <div style="flex:1;min-width:0">
          <div class="rating-name">@${uname}${isMe ? ` <span style="font-size:10px;color:#ebaa49;opacity:.7">${t('youMarker')}</span>` : ''}</div>
          <div class="rating-sub">${t('levelAbbrev')} ${r.level || 1}</div>
        </div>
        <div class="rating-bm">
          <div class="rating-bm-val">${(r.bm || 0).toLocaleString()}</div>
          <div class="rating-bm-lbl">${t('bmAbbrev')}</div>
        </div>
      </div>`;
    });
    el.innerHTML = html;
  } else {
    el.innerHTML = rows.map((r, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1);
      const rankCls = i === 0 ? 'rating-rank-1' : i === 1 ? 'rating-rank-2' : i === 2 ? 'rating-rank-3' : '';
      return `<div class="rating-row">
        <div class="rating-rank ${rankCls}">${medal}</div>
        <div class="rating-clan-icon">${typeof clanIconSVG === 'function' ? clanIconSVG(r.icon || 1, 22) : '🛡'}</div>
        <div style="flex:1;min-width:0">
          <div class="rating-name">${r.name}</div>
          <div class="rating-sub">${tVars('membersAbbrevFmt', { n: r.memberCount })}</div>
        </div>
        <div class="rating-bm">
          <div class="rating-bm-val">${(r.totalBm || 0).toLocaleString()}</div>
          <div class="rating-bm-lbl">${t('bmAbbrev')}</div>
        </div>
      </div>`;
    }).join('');
  }
}

// ─────────────────────────────────────────────────────────
//  VIP PANEL
// ─────────────────────────────────────────────────────────

function _positionVipBtn() {
  const ratingBtn = document.getElementById('rating-btn');
  const vipBtn    = document.getElementById('vip-btn');
  if (!vipBtn || !ratingBtn) return;
  const rTop = parseFloat(ratingBtn.style.top) || 0;
  vipBtn.style.top       = (rTop + 28 + 4) + 'px';
  vipBtn.style.left      = ratingBtn.style.left;
  vipBtn.style.width     = ratingBtn.style.width;
  vipBtn.style.right     = 'auto';
  vipBtn.style.transform = 'none';
}

function showVipBtn() {
  const btn = document.getElementById('vip-btn');
  if (btn) { btn.dataset.shown = '1'; btn.style.display = _hudSubBtnDisplay(); _positionVipBtn(); }
}

function openVipPanel() {
  const panel = document.getElementById('vip-panel');
  if (!panel) return;
  panel.style.display = 'flex';
  renderVipPanel();
}

function closeVipPanel() {
  const panel = document.getElementById('vip-panel');
  if (panel) panel.style.display = 'none';
}

// VIP_THRESHOLDS[lvl] is only the GRAM delta for that one level-up (the
// server's deposit counter rolls over — resets to the remainder — after
// each level, see server/index.js), which reads as "starting over from
// scratch" every level. This is the running TOTAL a player must have
// deposited overall (since VIP 0) to be at each level, for the "how much
// do I need in total" answer the per-level number alone doesn't give.
function _vipCumulative(thresholds) {
  const out = [0];
  for (let i = 1; i < thresholds.length; i++) out.push(out[i - 1] + thresholds[i]);
  return out;
}

function renderVipPanel() {
  const el = document.getElementById('vip-body');
  if (!el) return;
  const vip       = window._vipData || { level: 0, deposited: 0, pending: [] };
  const level     = vip.level     || 0;
  const deposited = vip.deposited || 0;
  const pending   = vip.pending   || [];
  const bonuses   = typeof VIP_BONUSES    !== 'undefined' ? VIP_BONUSES    : null;
  const thresholds= typeof VIP_THRESHOLDS !== 'undefined' ? VIP_THRESHOLDS : [0,1,5,10,25,50,100,150,200,300,500];
  const cumulative= _vipCumulative(thresholds);
  const bon       = bonuses ? (bonuses[level] || bonuses[0]) : { xp:0, gold:0, drop:0 };

  let progressHtml;
  if (level < 10) {
    const needed = thresholds[level + 1] || 1;
    const pct    = Math.min(100, (deposited / needed) * 100).toFixed(1);
    progressHtml = `
      <div class="vip-progress-wrap">
        <div class="vip-progress-label">
          <span>${tVars('vipNextFmt', { lvl: level + 1, total: cumulative[level + 1] })}</span>
          <span>${deposited.toFixed ? deposited.toFixed(2) : deposited} / ${needed} GRAM</span>
        </div>
        <div class="vip-progress-bar"><div class="vip-progress-fill" style="width:${pct}%"></div></div>
      </div>`;
  } else {
    progressHtml = `<div class="vip-max-badge">${t('vipMaxBadge')}</div>`;
  }

  el.innerHTML = `
    <div class="vip-level-badge">VIP ${level}</div>
    ${progressHtml}
    <div class="vip-bonuses">
      <div class="vip-bonus-item ${bon.xp   > 0 ? '' : 'vip-bonus-dim'}">⚡ +${bon.xp}% XP</div>
      <div class="vip-bonus-item ${bon.gold > 0 ? '' : 'vip-bonus-dim'}">💰 +${bon.gold}% ${t('vipGoldLbl')}</div>
      <div class="vip-bonus-item ${bon.drop > 0 ? '' : 'vip-bonus-dim'}">🎁 +${bon.drop}% ${t('vipDropLbl')}</div>
    </div>
    <div class="vip-section-title">${t('vipLevelsHdr')}</div>
    <div class="vip-levels">${_renderVipLevels(level, pending, bonuses, cumulative)}</div>
  `;
}

function _renderVipLevels(curLevel, pending, bonuses, cumulative) {
  let html = '';
  for (let lvl = 1; lvl <= 10; lvl++) {
    const b         = bonuses ? (bonuses[lvl] || { xp:0, gold:0, drop:0 }) : { xp:0, gold:0, drop:0 };
    const isPending = pending.includes(lvl);
    const isDone    = curLevel >= lvl && !isPending;
    const cls       = isPending ? 'vip-card vip-card-pending' : isDone ? 'vip-card vip-card-done' : 'vip-card vip-card-locked';
    const badge     = isPending ? '🎁' : isDone ? '✓' : lvl;
    const bonHtml   = [
      b.xp   > 0 ? `<span>+${b.xp}% XP</span>`     : '',
      b.gold > 0 ? `<span>+${b.gold}% ${t('vipGoldLbl')}</span>` : '',
      b.drop > 0 ? `<span>+${b.drop}% ${t('vipDropLbl')}</span>`   : '',
    ].join('');
    html += `
      <div class="${cls}">
        <div class="vip-card-head">
          <div class="vip-card-badge">${badge}</div>
          <div class="vip-card-title">VIP ${lvl}</div>
          <div class="vip-card-gram">${cumulative[lvl]} GRAM</div>
        </div>
        ${bonHtml ? `<div class="vip-card-bonuses">${bonHtml}</div>` : ''}
        ${_vipItemDesc(lvl)}
        ${isPending ? `<button class="vip-claim-btn" onclick="netClaimVipRewards()">${t('vipClaimBtn')}</button>` : ''}
      </div>`;
  }
  return html;
}

function _vipItemDesc(lvl) {
  const wepSfx = { deathknight:'k', lev:'t', ranger:'b', mage:'s', warlock:'s' }[player?.type] || 't';
  const wepPfx = { uncommon:'u', rare:'r', epic:'e', legendary:'l' };

  function wep(rarity, enhance) {
    return ri(`/images/wep/${wepPfx[rarity]}${wepSfx}.png`, enhance ? `+${enhance}` : '★', rarity);
  }
  function bless(qty) { return ri('/images/bless.png',       `×${qty}`, 'rare');   }
  function norm(qty)  { return ri('/images/norm.png',        `×${qty}`, 'uncommon'); }
  function boxU(qty)  { return ri('/images/material/boxu.png', `×${qty}`, 'uncommon'); }
  function boxR(qty)  { return ri('/images/material/boxr.png', `×${qty}`, 'rare'); }
  function gold(amt)  {
    const uri = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23f1c40f' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='9'/><path d='M12 7v10'/><path d='M15 9.5a3 3 0 0 0-6 0c0 1.5 1 2.2 3 3 2 .8 3 1.5 3 3a3 3 0 0 1-6 0'/></svg>`;
    return ri(uri, `${(amt/1000).toFixed(0)}${t('vipGoldShortSuffix')}`, 'gold');
  }
  function pots(qty) {
    return ['hp','exp','gold','regen','atkspeed','atk']
      .map(p => ri(`/images/potion/${p}.png`, `×${qty}`, '')).join('');
  }

  const rows = {
    2:  boxU(3),
    3:  bless(2) + boxU(5),
    4:  bless(5) + pots(10) + boxR(2) + boxU(3),
    5:  bless(7) + pots(10) + boxR(5),
    6:  wep('uncommon', 8) + bless(7) + pots(10) + boxR(10),
    7:  wep('rare', 8) + norm(20) + bless(10) + gold(10000) + boxR(15),
    8:  wep('epic', 1) + pots(50) + norm(50) + bless(30) + gold(20000) + boxR(20),
    9:  wep('epic', 8) + pots(80) + norm(70) + bless(30) + boxR(25),
    10: wep('legendary', 0) + pots(100) + norm(100) + bless(100) + boxR(30),
  };
  const d = rows[lvl];
  return d ? `<div class="vip-items-row">${d}</div>` : '';
}

// ─────────────────────────────────────────────────────────
//  MARKET PANEL
// ─────────────────────────────────────────────────────────
const MARKET_MIN_PRICE = 0.1;
const MARKET_MAX_PRICE = 1000;
const MARKET_FEE_PCT   = 0.10; // burned — mirrors server; display only, not authoritative
// Стеля видачі browse() (MARKET_BROWSE_MAX, server/db/repos/market.js) —
// дзеркало, як і три константи вище: сервер лишається джерелом правди, тут це
// число потрібне рівно для одного — щоб СКАЗАТИ гравцеві, що список обрізаний.
// Мовчазне обрізання і є скарга «на маркеті не все відображається»: список
// виглядав повним, просто без 82% ринку. Поки лотів менше за стелю (зараз їх
// ~573 при стелі 1000), підказка не показується взагалі.
const MARKET_BROWSE_MAX = 1000;
// Per-category floors — mirrors _marketMinPrice (server/index.js) exactly;
// display/pre-check only, the server is the real authority. Keys/recipes/
// stones are per unit (scaled by however many are in this listing), rare
// gear is a flat per-listing floor.
// Зеркало серверной _marketMinPrice — и округляет теми же тремя знаками.
// Разойтись им нельзя: подсказка под полем и проверка сервера должны называть
// ОДНО число, иначе игрок снова вводит объявленное и получает отказ.
function _marketMinPriceFor(it, qty) {
  return Math.round(_marketMinPriceForRaw(it, qty) * 1000) / 1000;
}
function _marketMinPriceForRaw(it, qty) {
  if (!it) return MARKET_MIN_PRICE;
  const n = qty || it.qty || 1;
  if (it.id === 'norm_stone') return 0.40 * n;
  if (it.id === 'bless_stone') return 1.5 * n;
  if (it.id === 'key_rare') return 0.006 * n;
  if (it.id && it.id.startsWith('key_')) return 0.003 * n;
  if (it.slot === 'recipe') return 0.01 * n;
  if (it.slot === 'box') return (it.id === 'box_rare' ? 2 : 1) * n;
  // Cloak/artifact keep their own flat floor at every rarity below 'rare' —
  // has to win over the rarity-based gear checks below, or an uncommon
  // cloak (cloak_u_<class>) would fall through to the cheaper floor.
  if (it.slot === 'cloak' || it.slot === 'artifact') return 2;
  // Skill/passive books — "вторая профессия" (advSkillKey) has its own,
  // higher floor and must be checked before the regular floor below, which
  // covers both active skill books (skillKey) and passive ones (passiveId).
  if (it.advSkillKey) return 10 * n;
  if (it.skillKey || it.passiveId) return 0.4 * n;
  if (it.rarity === 'epic' && typeof ENHANCEABLE_SLOTS !== 'undefined' && ENHANCEABLE_SLOTS.has(it.slot) && it.slot !== 'pet') return 10;
  if (it.rarity === 'rare' && typeof ENHANCEABLE_SLOTS !== 'undefined' && ENHANCEABLE_SLOTS.has(it.slot) && it.slot !== 'pet') return 3;
  if (it.rarity === 'uncommon' && typeof ENHANCEABLE_SLOTS !== 'undefined' && ENHANCEABLE_SLOTS.has(it.slot) && it.slot !== 'pet') return 0.3;
  return MARKET_MIN_PRICE;
}

let _marketTab    = 'lots';
let _marketLots    = [];
let _marketMine     = [];
let _marketHist     = [];
let _marketLoaded  = { lots: false, mine: false, history: false };
let _pendingSellItem = null; // { item } while a marketList request is in flight — used to roll back on error
let _marketSellPick  = null; // selected inventory index in the sell picker modal

function _positionMarketBtn() {
  const vipBtn    = document.getElementById('vip-btn');
  const marketBtn = document.getElementById('market-btn');
  if (!marketBtn || !vipBtn) return;
  const vTop = parseFloat(vipBtn.style.top) || 0;
  marketBtn.style.top       = (vTop + 28 + 4) + 'px';
  marketBtn.style.left      = vipBtn.style.left;
  marketBtn.style.width     = vipBtn.style.width;
  marketBtn.style.right     = 'auto';
  marketBtn.style.transform = 'none';
}

function _positionGramShopBtn() {
  const marketBtn   = document.getElementById('market-btn');
  const shopBtn     = document.getElementById('gram-shop-btn');
  if (!shopBtn || !marketBtn) return;
  const mTop = parseFloat(marketBtn.style.top) || 0;
  shopBtn.style.top       = (mTop + 28 + 4) + 'px';
  shopBtn.style.left      = marketBtn.style.left;
  shopBtn.style.width     = marketBtn.style.width;
  shopBtn.style.right     = 'auto';
  shopBtn.style.transform = 'none';
}

function showMarketBtn() {
  const btn = document.getElementById('market-btn');
  if (btn) { btn.dataset.shown = '1'; btn.style.display = _hudSubBtnDisplay(); _positionMarketBtn(); }
}

// ─────────────────────────────────────────────────────────
//  EVENTS (События) — Битва + Мировой босс
// ─────────────────────────────────────────────────────────
// One entry point for both scheduled events; each is a tab inside the panel.
// The server owns both schedules (shared/definitions.js DEATH_BATTLE_*/
// WORLD_BOSS_*) and pushes their state, so everything here just renders what
// arrived and counts the seconds down locally.
function _positionEventsBtn() {
  const shopBtn = document.getElementById('gram-shop-btn');
  const btn     = document.getElementById('events-btn');
  if (!btn || !shopBtn) return;
  const sTop = parseFloat(shopBtn.style.top) || 0;
  btn.style.top       = (sTop + 28 + 4) + 'px';
  btn.style.left      = shopBtn.style.left;
  btn.style.width     = shopBtn.style.width;
  btn.style.right     = 'auto';
  btn.style.transform = 'none';
}

function showEventsBtn() {
  const btn = document.getElementById('events-btn');
  if (btn) { btn.dataset.shown = '1'; btn.style.display = _hudSubBtnDisplay(); _positionEventsBtn(); }
}

function _fmtBossTime(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60), r = s % 60;
  return m + ':' + String(r).padStart(2, '0');
}

// Countdowns longer than an hour ("следующая битва в четверг") read as
// nonsense in m:ss, so anything past 60 minutes is shown as д/ч/м instead.
function _fmtEventEta(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 3600) return _fmtBossTime(ms);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}д ${h}ч` : `${h}ч ${m}м`;
}

// Single-unit countdown for the tiny buff-strip chips (22px cell, 6px font)
// — "5д 3ч" from _fmtEventEta doesn't fit, so this picks just the largest
// unit that applies.
function _fmtChipEta(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + t('secAbbrev');
  const m = Math.floor(s / 60);
  if (m < 60) return m + t('minAbbrev');
  const h = Math.floor(s / 3600);
  if (h < 24) return h + 'ч';
  return Math.floor(s / 86400) + 'д';
}

// Weekday + time of the next occurrence, so the panel says when it is rather
// than only how long is left.
function _fmtEventWhen(at) {
  if (!at) return '';
  const d = new Date(at);
  const days = t('eventWeekdays').split(',');
  return `${days[d.getDay()]}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

let _eventTab = 'battle';
// 'list' — the event picker (events-tab-list) fills the whole panel.
// 'detail' — a single event's own page (openEventDetail's target) instead,
// reached by tapping a row in the list; the back arrow (showEventsList)
// returns to it. See the .events-detail toggle in css/style.css.
let _eventsView = 'list';

function openEventsPanel() {
  const panel = document.getElementById('events-panel');
  if (!panel) return;
  panel.style.display = 'flex';
  if (typeof netDeathBattleSync === 'function') netDeathBattleSync();
  if (typeof netArena3Sync === 'function') netArena3Sync();
  if (typeof netRace10Sync === 'function') netRace10Sync();
  if (typeof netFearSync === 'function') netFearSync();
  if (typeof netCoopSync === 'function') netCoopSync();
  if (typeof netFarm2Sync === 'function') netFarm2Sync();
  showEventsList();
}

function closeEventsPanel() {
  const panel = document.getElementById('events-panel');
  if (panel) panel.style.display = 'none';
}

// Back to the event picker — the panel's "home" page.
function showEventsList() {
  _eventsView = 'list';
  document.getElementById('events-panel')?.classList.remove('events-detail');
  document.querySelectorAll('#events-panel .events-title-detail').forEach(el => { el.style.display = 'none'; });
}

// Navigate into one event's own page — tapping a row in the list, not a
// same-screen tab swap: the list is replaced by the event's page (a back
// arrow in the header returns to the list), and the header's title/icon
// swaps to that event's (the matching #etitle-<tab> span).
function openEventDetail(tab) {
  _eventTab = tab;
  _eventsView = 'detail';
  document.getElementById('events-panel')?.classList.add('events-detail');
  document.querySelectorAll('#events-panel .event-tab-item').forEach(b => b.classList.remove('active'));
  document.getElementById('etab-' + tab)?.classList.add('active');
  document.querySelectorAll('#events-panel .events-title-detail').forEach(el => { el.style.display = 'none'; });
  const dt = document.getElementById('etitle-' + tab);
  if (dt) dt.style.display = 'inline';
  _renderEventsBody();
}

function _eventsPanelOpen() {
  return document.getElementById('events-panel')?.style.display === 'flex';
}

function _renderEventsBody() {
  if (_eventsView !== 'detail') return;
  const body = document.getElementById('events-panel-body');
  if (!body) return;
  body.innerHTML = _eventTab === 'boss'      ? _worldBossBodyHTML()
                 : _eventTab === 'a3'        ? _arena3BodyHTML()
                 : _eventTab === 'race10'    ? _race10BodyHTML()
                 : _eventTab === 'fear'      ? _fearBodyHTML()
                 : _eventTab === 'coop'      ? _coopBodyHTML()
                 : _eventTab === 'farm2'     ? _farm2BodyHTML()
                 : _eventTab === 'guildWar'  ? _guildWarBodyHTML()
                 : _deathBattleBodyHTML();
}

// ── 3v3 arena tab ───────────────────────────────────────────────────────────
// Queue-driven, so there is no countdown to show — the headline number is how
// many of the six are waiting. Everything here comes from _a3State, pushed by
// the server (see _initArena3Handlers in js/network.js).
function _arena3BodyHTML() {
  const st = (typeof _a3State !== 'undefined' && _a3State) || { phase: 'idle', nextAt: 0, queued: 0, needed: 6, minLevel: 15, reward: 10 };
  const inMatch = typeof _a3InMatch !== 'undefined' && _a3InMatch;
  const open = st.phase === 'reg';
  const lvl = (player && player.lvl) || 1;
  const tooLow = lvl < (st.minLevel || 15);

  // null means the panel hasn't synced yet — don't lock the button on a count
  // we haven't actually been told.
  const spent = st.attemptsLeft !== null && st.attemptsLeft !== undefined && st.attemptsLeft <= 0;

  let phaseTxt, action;
  if (inMatch) {
    phaseTxt = t('a3PhaseFighting');
    action = `<button class="db-action" disabled>${t('a3PhaseFighting')}</button>`;
  } else if (!open) {
    phaseTxt = t('a3PhaseClosed');
    action = `<button class="db-action" disabled>${t('dbClosedBtn')}</button>`;
  } else if (tooLow) {
    phaseTxt = tVars('a3NeedLevelFmt', { n: st.minLevel });
    action = `<button class="db-action disabled" disabled>${tVars('a3NeedLevelFmt', { n: st.minLevel })}</button>`;
  } else if (spent && !_a3Registered) {
    phaseTxt = t('a3NoAttempts');
    action = `<button class="db-action disabled" disabled>${t('a3NoAttempts')}</button>`;
  } else if (_a3Registered) {
    phaseTxt = t('a3PhaseQueued');
    action = `<button class="db-action db-leave" onclick="netArena3Unregister()">${t('dbLeaveBtn')}</button>`;
  } else {
    phaseTxt = t('a3PhaseIdle');
    action = `<button class="db-action" onclick="netArena3Register()">${t('dbJoinBtn')}</button>`;
  }

  // Idle (window closed) counts down to the next daily window, open/in-match
  // stay on the plain queue count.
  const countdown = !open && !inMatch ? _fmtEventEta(Math.max(0, (st.nextAt || 0) - Date.now())) : `${st.queued}/${st.needed}`;
  const score = inMatch
    ? `<div class="db-count">${tVars('a3ScoreFmt', { a: _a3Score.a, b: _a3Score.b })}</div>`
    : open && st.attemptsLeft !== null && st.attemptsLeft !== undefined
        ? `<div class="db-count">${tVars('a3AttemptsFmt', { n: st.attemptsLeft, max: st.maxAttempts })}</div>`
        : (!open && st.nextAt ? `<div class="db-count">${_fmtEventWhen(st.nextAt)}</div>` : '');

  return `
    <div style="padding:16px">
      <div class="db-countdown">${countdown}</div>
      <div class="db-phase">${phaseTxt}</div>
      ${score}
      ${action}
      <div class="db-rules">
        ${t('dbRulesHdr')}
        <ul>
          <li>${t('a3RuleSchedule')}</li>
          <li>${tVars('a3Rule1', { n: st.needed })}</li>
          <li>${t('a3Rule2')}</li>
          <li>${t('a3Rule3')}</li>
          <li>${t('a3Rule4')}</li>
          <li>${t('a3RuleBoss')}</li>
          <li>${t('a3RuleDuration')}</li>
          <li>${tVars('a3Rule5', { n: st.minLevel })}</li>
          <li>${tVars('a3Rule6', { n: st.maxAttempts })}</li>
        </ul>
      </div>
      <div class="db-rewards-hdr">${t('a3RewardHdr')}</div>
      <div class="db-rewards">
        <div class="db-reward-row">
          <img src="/images/nexum-coin_v2.png" alt="">
          <span>Liberty</span><span class="db-reward-qty">+${st.reward}</span>
        </div>
      </div>
    </div>`;
}

// ── Кровавая Башня tab (10-player corridor race) ────────────────────────────
// Open every day at 20:30 MSK for 5 minutes (see _race10Schedule,
// server/index.js) — same reg/idle phase shape as _deathBattleBodyHTML
// above, plus the queue count and team-less damage race once open.
function _race10BodyHTML() {
  const st = (typeof _race10State !== 'undefined' && _race10State) || { phase: 'idle', nextAt: 0, queued: 0, startAt: 0, capacity: 0, minLevel: 10, reward: 10 };
  const inMatch = typeof _race10InMatch !== 'undefined' && _race10InMatch;
  const open = st.phase === 'reg';
  const lvl = (player && player.lvl) || 1;
  const tooLow = lvl < (st.minLevel || 10);
  const spent = st.attemptsLeft !== null && st.attemptsLeft !== undefined && st.attemptsLeft <= 0;

  let phaseTxt, action;
  if (inMatch) {
    phaseTxt = t('race10PhaseFighting');
    action = `<button class="db-action" disabled>${t('race10PhaseFighting')}</button>`;
  } else if (!open) {
    phaseTxt = t('race10PhaseIdle');
    action = `<button class="db-action" disabled>${t('dbClosedBtn')}</button>`;
  } else if (tooLow) {
    phaseTxt = tVars('a3NeedLevelFmt', { n: st.minLevel });
    action = `<button class="db-action disabled" disabled>${tVars('a3NeedLevelFmt', { n: st.minLevel })}</button>`;
  } else if (spent && !_race10Registered) {
    phaseTxt = t('a3NoAttempts');
    action = `<button class="db-action disabled" disabled>${t('a3NoAttempts')}</button>`;
  } else if (_race10Registered) {
    phaseTxt = t('a3PhaseQueued');
    action = `<button class="db-action db-leave" onclick="netRace10Unregister()">${t('dbLeaveBtn')}</button>`;
  } else {
    phaseTxt = t('a3PhaseIdle');
    action = `<button class="db-action" onclick="netRace10Register()">${t('dbJoinBtn')}</button>`;
  }

  // Idle counts down to the next daily window (can be many hours away). While
  // registration is open the number that matters is the time left to sign up —
  // there is no headcount to fill any more, everyone who registers runs.
  const countdown = inMatch
    ? `${st.queued}`
    : !open
        ? _fmtEventEta(Math.max(0, (st.nextAt || 0) - Date.now()))
        : _fmtEventEta(Math.max(0, (st.startAt || 0) - Date.now()));
  const score = inMatch
    ? `<div class="db-count">${tVars('race10ScoreFmt', { dmg: Math.floor(_race10MyDamage || 0), rank: _race10Rank || 0, total: _race10Total || 0 })}</div>`
    : open
        ? `<div class="db-count">${tVars('race10Waiting', { n: st.queued || 0 })}${
            st.attemptsLeft !== null && st.attemptsLeft !== undefined
              ? ' · ' + tVars('a3AttemptsFmt', { n: st.attemptsLeft, max: st.maxAttempts })
              : ''}</div>`
        : (st.nextAt ? `<div class="db-count">${_fmtEventWhen(st.nextAt)}</div>` : '');

  return `
    <div style="padding:16px">
      <div class="db-countdown">${countdown}</div>
      <div class="db-phase">${phaseTxt}</div>
      ${score}
      ${action}
      <div class="db-rules">
        ${t('dbRulesHdr')}
        <ul>
          <li>${t('race10Rule6')}</li>
          <li>${t('race10Rule1')}</li>
          <li>${t('race10Rule8')}</li>
          <li>${t('race10Rule2')}</li>
          <li>${t('race10Rule3')}</li>
          <li>${t('race10Rule4')}</li>
          <li>${t('race10Rule5')}</li>
          <li>${t('race10Rule7')}</li>
          <li>${tVars('a3Rule5', { n: st.minLevel })}</li>
          <li>${tVars('a3Rule6', { n: st.maxAttempts })}</li>
        </ul>
      </div>
      <div class="db-rewards-hdr">${t('race10RewardHdr')}</div>
      <div class="db-rewards">
        <div class="db-reward-row">
          <img src="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23e3941d' stroke='%23e3941d' stroke-width='1' stroke-linejoin='round'><polygon points='12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26'/></svg>" alt="">
          <span>${t('race10XpRewardName')}</span><span class="db-reward-qty">×4</span>
        </div>
        <div class="db-reward-row">
          <img src="/images/nexum-coin_v2.png" alt="">
          <span>${t('race10RewardAll')}</span><span class="db-reward-qty">+${st.reward}</span>
        </div>
        <div class="db-reward-row">
          <img src="/images/nexum-coin_v2.png" alt="">
          <span>${t('race10RewardWin')}</span><span class="db-reward-qty">+${st.winReward}</span>
        </div>
        <div class="db-reward-row">
          <span class="db-reward-fallback">🧪</span>
          <span>${t('race10RewardPotions')}</span><span class="db-reward-qty">×1 / ×2</span>
        </div>
      </div>
    </div>`;
}

// ── Страх (Fear) tab ─────────────────────────────────────────────────────────
// On-demand: no schedule, no queue — the only gates are the min level and
// whether today's attempts are used up. Entering IS starting (no separate
// register step), so the action button either starts a run or shows it's
// already running. Headline number is the current wave while running,
// otherwise how many of the daily attempts are left.
function _fearBodyHTML() {
  const st = (typeof _fearState !== 'undefined' && _fearState) || { attemptsLeft: null, maxAttempts: 2, maxWave: 39, minLevel: 10 };
  const inRun = typeof _fearInRun !== 'undefined' && _fearInRun;
  const spent = st.attemptsLeft !== null && st.attemptsLeft !== undefined && st.attemptsLeft <= 0;
  const lvl = (player && player.lvl) || 1;
  const tooLow = !inRun && lvl < (st.minLevel || 10);

  let phaseTxt, action;
  if (inRun) {
    // wave is 0 for the FEAR_START_DELAY_MS grace window between landing in
    // the hall and wave 1 actually spawning (see server's fearEnter) — the
    // #db-freeze countdown overlay is already covering the screen at that
    // point, but this panel can still be reopened during it, so it needs its
    // own "not fighting yet" phase rather than claiming wave 1 is already up.
    phaseTxt = _fearWave > 0
      ? tVars('fearPhaseFighting', { wave: _fearWave, max: st.maxWave })
      : t('fearPhaseReady');
    action = `<button class="db-action" disabled>${t('fearInRunBtn')}</button>`;
  } else if (tooLow) {
    phaseTxt = tVars('a3NeedLevelFmt', { n: st.minLevel });
    action = `<button class="db-action disabled" disabled>${tVars('a3NeedLevelFmt', { n: st.minLevel })}</button>`;
  } else if (spent) {
    phaseTxt = t('a3NoAttempts');
    action = `<button class="db-action disabled" disabled>${t('a3NoAttempts')}</button>`;
  } else {
    phaseTxt = t('fearPhaseIdle');
    action = `<button class="db-action" onclick="netFearEnter()">${t('fearEnterBtn')}</button>`;
  }

  const countdown = inRun
    ? `${_fearWave > 0 ? _fearWave : '–'}/${st.maxWave}`
    : (st.attemptsLeft !== null && st.attemptsLeft !== undefined ? `${st.attemptsLeft}/${st.maxAttempts}` : `?/${st.maxAttempts}`);
  // No more "free halls" line — every entrant gets their own private
  // instance now, so there is nothing to ever be full.
  const score = !inRun && st.attemptsLeft !== null && st.attemptsLeft !== undefined
    ? `<div class="db-count">${tVars('a3AttemptsFmt', { n: st.attemptsLeft, max: st.maxAttempts })}</div>`
    : '';

  return `
    <div style="padding:16px">
      <div class="db-countdown">${countdown}</div>
      <div class="db-phase">${phaseTxt}</div>
      ${score}
      ${action}
      <div class="db-rules">
        ${t('dbRulesHdr')}
        <ul>
          <li>${tVars('a3Rule5', { n: st.minLevel })}</li>
          <li>${tVars('fearRule1', { n: st.maxAttempts })}</li>
          <li>${t('fearRule2')}</li>
          <li>${tVars('fearRule3', { n: st.maxWave })}</li>
          <li>${t('fearRule4')}</li>
          <li>${t('fearRule5')}</li>
        </ul>
      </div>
    </div>`;
}

// ── Сотрудничество (Coop) tab ────────────────────────────────────────────────
// Group lobby instead of random matchmaking: a leader creates a group
// (netCoopGroupCreate), it shows up in everyone else's open-group list
// (_coopOpenGroups, pushed as coopGroupList), someone else joins it
// (netCoopGroupJoin), the leader can kick that member back out
// (netCoopGroupKick), and only the leader can actually launch the run
// (netCoopGroupStart) — see js/network.js's _initCoopHandlers. Headline
// number is the current stage while running, otherwise how many of the
// daily attempts are left.
function _coopGroupPanelHTML(g) {
  const memberRow = g.memberId
    ? `<div class="coop-grp-row">
         <span class="coop-grp-name">${_esc(g.memberName)}</span>
         ${g.isLeader ? `<button class="coop-grp-kick" onclick="netCoopGroupKick()">${t('coopKickBtn')}</button>` : `<span class="coop-grp-tag">${t('coopYouTag')}</span>`}
       </div>`
    : `<div class="coop-grp-row coop-grp-empty"><span class="coop-grp-name">${t('coopSlotOpenLbl')}</span></div>`;
  const leaderRow = `<div class="coop-grp-row">
       <span class="coop-grp-name">${_esc(g.leaderName)}</span>
       <span class="coop-grp-tag">${g.isLeader ? t('coopYouTag') : t('coopLeaderTag')}</span>
     </div>`;

  const mainAction = g.isLeader
    ? (g.memberId
        ? `<button class="db-action" onclick="netCoopGroupStart()">${t('coopStartBtn')}</button>`
        : `<button class="db-action" disabled>${t('coopWaitingMemberLbl')}</button>`)
    : `<button class="db-action" disabled>${t('coopWaitingLeaderLbl')}</button>`;
  const secondaryLbl = g.isLeader ? t('coopDisbandBtn') : t('coopLeaveGroupBtn');

  return `
    <div class="coop-grp-box">
      ${leaderRow}
      ${memberRow}
    </div>
    ${mainAction}
    <button class="db-action db-leave" onclick="netCoopGroupLeave()">${secondaryLbl}</button>`;
}

function _coopOpenGroupsHTML() {
  const groups = (typeof _coopOpenGroups !== 'undefined' && _coopOpenGroups) || [];
  if (!groups.length) return `<div class="coop-open-empty">${t('coopNoGroupsLbl')}</div>`;
  return `<div class="coop-open-list">${groups.map(gr => `
    <div class="coop-open-row">
      <span class="coop-grp-name">${_esc(gr.leaderName)}</span>
      <button class="coop-join-btn" onclick="netCoopGroupJoin('${gr.id}')">${t('coopJoinBtn')}</button>
    </div>`).join('')}</div>`;
}

function _coopBodyHTML() {
  const st = (typeof _coopState !== 'undefined' && _coopState) || { attemptsLeft: null, maxAttempts: 2, maxStage: 8, minLevel: 10 };
  const inRun = typeof _coopInRun !== 'undefined' && _coopInRun;
  const group = typeof _coopGroup !== 'undefined' ? _coopGroup : null;
  const spent = st.attemptsLeft !== null && st.attemptsLeft !== undefined && st.attemptsLeft <= 0;
  const lvl = (player && player.lvl) || 1;
  const tooLow = !inRun && lvl < (st.minLevel || 10);

  let phaseTxt, action;
  if (inRun) {
    // stage is 0 for the COOP_START_DELAY_MS grace window between landing
    // and stage 1 actually spawning (see server's coopGroupStart) — the
    // #db-freeze countdown overlay is already covering the screen at that
    // point, but this panel can still be reopened during it, so it needs
    // its own "not fighting yet" phase rather than claiming stage 1 is
    // already up.
    phaseTxt = _coopStageNo > 0
      ? tVars('coopPhaseFighting', { stage: _coopStageNo, max: st.maxStage })
      : t('coopPhaseReady');
    action = `<button class="db-action" disabled>${t('fearInRunBtn')}</button>`;
  } else if (group) {
    phaseTxt = group.isLeader ? t('coopPhaseLeaderLbl') : t('coopPhaseMemberLbl');
    action = _coopGroupPanelHTML(group);
  } else if (tooLow) {
    phaseTxt = tVars('a3NeedLevelFmt', { n: st.minLevel });
    action = `<button class="db-action disabled" disabled>${tVars('a3NeedLevelFmt', { n: st.minLevel })}</button>`;
  } else if (spent) {
    phaseTxt = t('a3NoAttempts');
    action = `<button class="db-action disabled" disabled>${t('a3NoAttempts')}</button>`;
  } else {
    phaseTxt = t('fearPhaseIdle');
    action = `<button class="db-action" onclick="netCoopGroupCreate()">${t('coopCreateGroupBtn')}</button>${_coopOpenGroupsHTML()}`;
  }

  const countdown = inRun
    ? `${_coopStageNo > 0 ? _coopStageNo : '–'}/${st.maxStage}`
    : (st.attemptsLeft !== null && st.attemptsLeft !== undefined ? `${st.attemptsLeft}/${st.maxAttempts}` : `?/${st.maxAttempts}`);
  const score = !inRun && st.attemptsLeft !== null && st.attemptsLeft !== undefined
    ? `<div class="db-count">${tVars('a3AttemptsFmt', { n: st.attemptsLeft, max: st.maxAttempts })}</div>`
    : '';

  return `
    <div style="padding:16px">
      <div class="db-countdown">${countdown}</div>
      <div class="db-phase">${phaseTxt}</div>
      ${score}
      ${action}
      <div class="db-rules">
        ${t('dbRulesHdr')}
        <ul>
          <li>${t('coopRule1')}</li>
          <li>${tVars('a3Rule5', { n: st.minLevel })}</li>
          <li>${tVars('fearRule1', { n: st.maxAttempts })}</li>
          <li>${t('coopRule2')}</li>
          <li>${t('coopRule3')}</li>
          <li>${t('coopRule4')}</li>
          <li>${t('coopRule5')}</li>
        </ul>
      </div>
    </div>`;
}

// Called from the network handlers on every server push.
function onCoopState() {
  _updateEventsBtnHighlight();
  if (_eventsPanelOpen() && _eventTab === 'coop') _renderEventsBody();
}

// ── Элитная фарм-зона tab ────────────────────────────────────────────────────
// Same group-lobby shape as Coop's own tab above, just FARM2_PARTY_SIZE seats
// (leader + up to 2 members) instead of 2 — a leader creates a group
// (netFarm2GroupCreate), it shows up in everyone else's open-group list
// (_farm2OpenGroups, pushed as farm2GroupList), someone else joins it
// (netFarm2GroupJoin), the leader can kick any one member back out
// (netFarm2GroupKick, which — unlike Coop — needs to say WHICH member), and
// only the leader can actually launch the run (netFarm2GroupStart) — see
// js/network.js's _initFarm2Handlers. No stage counter: this is a free-roam
// farm zone, not a wave/boss run, so the headline number is minutes left of
// the daily cap instead.
function _farm2GroupPanelHTML(g) {
  const openSlots = Math.max(0, (g.maxMembers || 2) - (g.members || []).length);
  const memberRows = (g.members || []).map(m => `
    <div class="coop-grp-row">
      <span class="coop-grp-name">${_esc(m.name)}</span>
      ${g.isLeader ? `<button class="coop-grp-kick" onclick="netFarm2GroupKick('${m.id}')">${t('coopKickBtn')}</button>` : (socket && m.id === socket.id ? `<span class="coop-grp-tag">${t('coopYouTag')}</span>` : '')}
    </div>`).join('');
  const openRows = Array.from({ length: openSlots }, () =>
    `<div class="coop-grp-row coop-grp-empty"><span class="coop-grp-name">${t('coopSlotOpenLbl')}</span></div>`).join('');
  const leaderRow = `<div class="coop-grp-row">
       <span class="coop-grp-name">${_esc(g.leaderName)}</span>
       <span class="coop-grp-tag">${g.isLeader ? t('coopYouTag') : t('coopLeaderTag')}</span>
     </div>`;

  const mainAction = g.isLeader
    ? (openSlots === 0
        ? `<button class="db-action" onclick="netFarm2GroupStart()">${t('coopStartBtn')}</button>`
        : `<button class="db-action" disabled>${t('coopWaitingMemberLbl')}</button>`)
    : `<button class="db-action" disabled>${t('coopWaitingLeaderLbl')}</button>`;
  const secondaryLbl = g.isLeader ? t('coopDisbandBtn') : t('coopLeaveGroupBtn');

  return `
    <div class="coop-grp-box">
      ${leaderRow}
      ${memberRows}
      ${openRows}
    </div>
    ${mainAction}
    <button class="db-action db-leave" onclick="netFarm2GroupLeave()">${secondaryLbl}</button>`;
}

function _farm2OpenGroupsHTML() {
  const groups = (typeof _farm2OpenGroups !== 'undefined' && _farm2OpenGroups) || [];
  if (!groups.length) return `<div class="coop-open-empty">${t('coopNoGroupsLbl')}</div>`;
  return `<div class="coop-open-list">${groups.map(gr => `
    <div class="coop-open-row">
      <span class="coop-grp-name">${_esc(gr.leaderName)} (${gr.size}/${gr.maxSize})</span>
      <button class="coop-join-btn" onclick="netFarm2GroupJoin('${gr.id}')">${t('coopJoinBtn')}</button>
    </div>`).join('')}</div>`;
}

function _farm2BodyHTML() {
  const st = (typeof _farm2State !== 'undefined' && _farm2State) || { entryLevel: 30, partySize: 3, dailyMinutes: 120, minutesLeft: null };
  const inRun = typeof _farm2InRun !== 'undefined' && _farm2InRun;
  const group = typeof _farm2Group !== 'undefined' ? _farm2Group : null;
  const spent = st.minutesLeft !== null && st.minutesLeft !== undefined && st.minutesLeft <= 0;
  const lvl = (player && player.lvl) || 1;
  const tooLow = !inRun && lvl < (st.entryLevel || 30);

  let phaseTxt, action;
  if (inRun) {
    phaseTxt = t('coopPhaseReady');
    action = `<button class="db-action" disabled>${t('fearInRunBtn')}</button>`;
  } else if (group) {
    phaseTxt = group.isLeader ? t('coopPhaseLeaderLbl') : t('coopPhaseMemberLbl');
    action = _farm2GroupPanelHTML(group);
  } else if (tooLow) {
    phaseTxt = tVars('a3NeedLevelFmt', { n: st.entryLevel });
    action = `<button class="db-action disabled" disabled>${tVars('a3NeedLevelFmt', { n: st.entryLevel })}</button>`;
  } else if (spent) {
    phaseTxt = t('farm2NoTimeLbl');
    action = `<button class="db-action disabled" disabled>${t('farm2NoTimeLbl')}</button>`;
  } else {
    phaseTxt = t('fearPhaseIdle');
    action = `<button class="db-action" onclick="netFarm2GroupCreate()">${t('coopCreateGroupBtn')}</button>${_farm2OpenGroupsHTML()}`;
  }

  const countdown = st.minutesLeft !== null && st.minutesLeft !== undefined
    ? tVars('farm2MinutesFmt', { n: st.minutesLeft, max: st.dailyMinutes })
    : `?/${st.dailyMinutes}`;

  return `
    <div style="padding:16px">
      <div class="db-countdown">${countdown}</div>
      <div class="db-phase">${phaseTxt}</div>
      ${action}
      <div class="db-rules">
        ${t('dbRulesHdr')}
        <ul>
          <li>${tVars('farm2Rule1', { n: st.entryLevel })}</li>
          <li>${tVars('farm2Rule2', { n: st.partySize })}</li>
          <li>${t('farm2Rule3')}</li>
          <li>${t('farm2Rule4')}</li>
          <li>${tVars('farm2Rule5', { n: st.dailyMinutes })}</li>
        </ul>
      </div>
      <div class="db-rules">
        <div class="fi-drops-hdr">${t('farm2DropHdr')}</div>
        ${_farm2DropRows()}
      </div>
    </div>`;
}

// The advanced-skill-book roll is ONE shared chance across the FULL 20-book
// pool (all classes × Q/W/E/R — see _rollFarm2Loot, server/index.js, which
// picks from the exact same `CRAFT_MATS.filter(m => m.advSkillKey)` set), so
// this breaks that single chance down per book (equal share of the pool) and
// renders each one's own class-skill icon, same idea as the original
// Фарм-зона's per-species _farmSpeciesBookRows above.
function _farm2AdvBookRows() {
  const pool = (typeof CRAFT_MATS !== 'undefined' ? CRAFT_MATS : []).filter(m => m.advSkillKey);
  if (!pool.length) return '';
  const perBookPct = _pctSmall(FARM2_ADV_SKILL_BOOK_CHANCE / pool.length * 100);
  return pool.map(b => {
    const def = (typeof ADV_SKILL_DEF !== 'undefined' && ADV_SKILL_DEF[b.forClass] || []).find(s => s.key === b.advSkillKey);
    const icon = def && def.img
      ? `<img src="${def.img}" style="width:16px;height:16px;border-radius:4px;image-rendering:pixelated">`
      : iconHTML('book', 16, '#f5c542');
    return _dropRow(icon, b.name, perBookPct, _FARM_ADV_BOOK_CLASS_COLOR[b.forClass] || '#f5c542');
  }).join('');
}

// Same idea for the unique-weapon roll: one shared chance across the 5
// EPIC-tier uniques (see _rollFarm2Loot's `ITEM_DEF.filter(d => d.unique &&
// d.rarity === 'epic')` pool), broken down per weapon so each class's own
// drop and art shows up by name instead of one opaque merged line.
function _farm2UniqueWeaponRows() {
  const pool = (typeof ITEM_DEF !== 'undefined' ? ITEM_DEF : []).filter(d => d.unique && d.rarity === 'epic');
  if (!pool.length) return '';
  const perWeaponPct = _pctSmall(FARM2_UNIQUE_WEAPON_CHANCE / pool.length * 100);
  return pool.map(w => _dropRow(_itemIcon(w, 16), w.name, perWeaponPct, '#ff8a3d')).join('');
}

// Icon + label + chance row per drop kind — same _dropRow/_itemIcon pattern
// the original Фарм-зона's own monster-info panel uses (_farmDropBodyHtml
// above), so a player can see at a glance WHAT each line actually is instead
// of reading a name off a plain bullet list.
function _farm2DropRows() {
  const boxRare     = typeof BOX_DEF !== 'undefined' ? BOX_DEF.find(b => b.id === 'box_rare') : null;
  const boxUncommon = typeof BOX_DEF !== 'undefined' ? BOX_DEF.find(b => b.id === 'box_uncommon') : null;
  const normStone    = typeof CRAFT_MATS !== 'undefined' ? CRAFT_MATS.find(m => m.id === 'norm_stone')  : null;
  const blessStone   = typeof CRAFT_MATS !== 'undefined' ? CRAFT_MATS.find(m => m.id === 'bless_stone') : null;
  const epicRec = typeof CRAFT_MATS !== 'undefined' ? CRAFT_MATS.find(m => m.id === 'rece') : null;
  const legRec  = typeof CRAFT_MATS !== 'undefined' ? CRAFT_MATS.find(m => m.id === 'recl') : null;

  const rows = [
    _dropRow(_nexumIconHtml(16), t('libertyLbl'), _pctSmall(FARM2_LIBERTY_CHANCE * 100), '#e8c15a'),
    boxRare     ? _dropRow(_itemIcon(boxRare, 16),     boxRare.name,     _pctSmall(FARM2_BOX_RARE_CHANCE * 100),     '#4a7bab') : '',
    boxUncommon ? _dropRow(_itemIcon(boxUncommon, 16), boxUncommon.name, _pctSmall(FARM2_BOX_UNCOMMON_CHANCE * 100), '#90d653') : '',
    normStone   ? _dropRow(_itemIcon(normStone, 16),   normStone.name,   _pctSmall(FARM2_NORM_STONE_CHANCE * 100),   '#f17e8b') : '',
    blessStone  ? _dropRow(_itemIcon(blessStone, 16),  blessStone.name,  _pctSmall(FARM2_BLESS_STONE_CHANCE * 100),  '#efc680') : '',
    epicRec     ? _dropRow(_itemIcon(epicRec, 16),     epicRec.name,     _pctSmall(FARM2_EPIC_RECIPE_CHANCE * 100),  '#c98fef') : '',
    legRec      ? _dropRow(_itemIcon(legRec, 16),      legRec.name,      _pctSmall(FARM2_LEGENDARY_RECIPE_CHANCE * 100), '#f5c542') : '',
    _dropRow(iconHTML('star', 16, '#b4eb84'), t('clanPerkXp'), `<b style="color:#b4eb84">${FARM2_XP_PER_KILL}</b>`, '#b4eb84'),
    _farm2AdvBookRows(),
    _farm2UniqueWeaponRows(),
  ];
  return `<div class="fi-drops">${rows.join('')}</div>`;
}

// Called from the network handlers on every server push.
function onFarm2State() {
  _updateEventsBtnHighlight();
  if (_eventsPanelOpen() && _eventTab === 'farm2') _renderEventsBody();
}

// Called from the network handlers on every server push.
function onFearState() {
  _updateEventsBtnHighlight();
  if (_eventsPanelOpen() && _eventTab === 'fear') _renderEventsBody();
}

// Called from the network handlers on every server push.
function onRace10State() {
  _updateEventsBtnHighlight();
  if (_eventsPanelOpen() && _eventTab === 'race10') _renderEventsBody();
}

// Live damage-race feedback while the fight is on — rank/total aren't
// persisted in _race10State (they only make sense mid-fight), just enough
// module state to redraw the panel between pushes.
let _race10Rank = 0, _race10Total = 0;
function onRace10Score(rank, total) {
  _race10Rank = rank; _race10Total = total;
  if (_eventsPanelOpen() && _eventTab === 'race10') _renderEventsBody();
}

function showRace10Result(won, winnerName, myDamage, timedOut, reward, items) {
  const modal = document.getElementById('race10-result-modal');
  if (!modal) return;
  const title = won ? t('race10Victory') : (timedOut ? t('a3NoResult') : t('race10Defeat'));
  document.getElementById('race10-result-icon').textContent = won ? '👑' : (timedOut ? '⏳' : '💀');
  document.getElementById('race10-result-title').textContent = title;
  document.getElementById('race10-result-title').style.color = won ? '#ffd18a' : '#f07886';
  document.getElementById('race10-result-sub').textContent = won
    ? t('race10VictorySub')
    : (timedOut ? t('race10NoResultSub') : tVars('race10DefeatSub', { name: winnerName || '?', dmg: Math.floor(myDamage || 0) }));
  // Paid to everyone who landed a hit on the boss, not only the winner — so
  // this block is no longer a victory-only decoration and has to render an
  // item list too. Empty (and hidden) for anyone who never reached the boss:
  // claiming a reward that did not land is the one thing it must not do.
  const _rwRows = [];
  if (reward) {
    _rwRows.push(`<div class="db-reward-row"><img src="/images/nexum-coin_v2.png" alt="">
       <span>Liberty</span><span class="db-reward-qty">+${reward}</span></div>`);
  }
  (items || []).forEach(it => {
    _rwRows.push(`<div class="db-reward-row">${it.img
      ? `<img src="${it.img}" alt="">`
      : '<span class="db-reward-fallback">🧪</span>'}
       <span>${it.name || it.id}</span><span class="db-reward-qty">×${it.qty || 1}</span></div>`);
  });
  document.getElementById('race10-result-rewards').innerHTML = _rwRows.join('');
  modal.style.display = 'flex';
}

function closeRace10Result() {
  const modal = document.getElementById('race10-result-modal');
  if (modal) modal.style.display = 'none';
  // Same reasoning as closeArena3Result: server already moved this player
  // back to the hub safe zone when the race ended, this just makes the
  // client catch up visually.
  if (typeof netRace10Return === 'function') netRace10Return();
}

// Called from the network handlers on every server push.
function onArena3State() {
  _updateEventsBtnHighlight();
  if (_eventsPanelOpen() && _eventTab === 'a3') _renderEventsBody();
}

function showArena3Result(won, wedged, reward) {
  const modal = document.getElementById('a3-result-modal');
  if (!modal) return;
  document.getElementById('a3-result-icon').textContent  = won ? '👑' : (wedged ? '⏳' : '💀');
  document.getElementById('a3-result-title').textContent = won ? t('a3Victory') : (wedged ? t('a3NoResult') : t('a3Defeat'));
  document.getElementById('a3-result-title').style.color = won ? '#ffd18a' : '#f07886';
  document.getElementById('a3-result-sub').textContent   = won ? t('a3VictorySub') : (wedged ? t('a3NoResultSub') : t('a3DefeatSub'));
  document.getElementById('a3-result-rewards').innerHTML = reward
    ? `<div class="db-reward-row"><img src="/images/nexum-coin_v2.png" alt="">
       <span>Liberty</span><span class="db-reward-qty">+${reward}</span></div>`
    : '';
  modal.style.display = 'flex';
}

function closeArena3Result() {
  const modal = document.getElementById('a3-result-modal');
  if (modal) modal.style.display = 'none';
  // Server already moved this player back to the hub spawn (a safe zone) the
  // moment the match ended — this just makes the client catch up visually
  // instead of leaving them rendered wherever the arena left them.
  if (typeof netArena3Return === 'function') netArena3Return();
}

// ── 3v3 match countdown ──────────────────────────────────────────────────────
// A small on-screen clock for the round's 3-minute duration (ARENA3_ROUND_MS,
// server/index.js), shown from the moment the pre-fight freeze ends until the
// match's result modal appears. Built lazily, same pattern as _dbFreezeEl above.
let _a3TimerTick = null;
function _a3TimerEl() {
  let el = document.getElementById('a3-match-timer');
  if (!el) {
    el = document.createElement('div');
    el.id = 'a3-match-timer';
    document.body.appendChild(el);
  }
  return el;
}
function showArena3Timer(endAt) {
  if (!endAt) return;
  const el = _a3TimerEl();
  clearInterval(_a3TimerTick);
  const paint = () => {
    const msLeft = Math.max(0, endAt - Date.now());
    const s = Math.ceil(msLeft / 1000);
    el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    el.style.display = 'block';
    if (msLeft <= 0) clearInterval(_a3TimerTick);
  };
  paint();
  _a3TimerTick = setInterval(paint, 250);
}
function hideArena3Timer() {
  clearInterval(_a3TimerTick);
  _a3TimerTick = null;
  const el = document.getElementById('a3-match-timer');
  if (el) el.style.display = 'none';
}

// World boss: alive right now, mid-summon countdown, or waiting for its next
// scheduled appearance. _evtBossState is filled from gameStart and the
// eventBoss* pushes (see network.js).
// ── Guild War (Война гильдий) tab ────────────────────────────────────────────
// _gwState is pushed by js/network.js's guildWarState handler (and seeded by
// gameStart) — phase/nextAt drive the countdown the same way the world boss
// tab does, ownerClanName/capturedAt describe who currently holds the tower
// regardless of whether the zone is open right now (ownership has no
// schedule of its own, only combat access does — see server/index.js's _gw).
function _guildWarBodyHTML() {
  const st = (typeof _gwState !== 'undefined' && _gwState) || {};
  const open = st.phase === 'live';
  const timeTxt = open
    ? '🏰'
    : (st.nextAt ? _fmtEventEta(st.nextAt - Date.now()) : '—');
  const phaseTxt = open ? t('guildWarPhaseOpen') : t('guildWarPhaseClosed');
  const note = open ? t('guildWarNoteOpen') : (st.nextAt ? _fmtEventWhen(st.nextAt) : '');
  // Escaped: a clan's name is typed by its founder, and this panel shows it to
  // everyone on the server. It is the one place a clan name reaches innerHTML.
  const ownerLine = st.ownerClanName
    ? `<div class="db-count">${t('guildWarOwnerLbl')}: <b>${_escHtml(st.ownerClanName)}</b></div>`
    : `<div class="db-count">${t('guildWarNoOwnerLbl')}</div>`;

  return `
    <div style="padding:16px">
      <div class="db-countdown">${timeTxt}</div>
      <div class="db-phase">${phaseTxt}</div>
      ${note ? `<div class="db-count">${note}</div>` : ''}
      ${ownerLine}
      <div class="db-rules">
        ${t('guildWarScheduleHdr')}
        <ul>
          <li>${t('guildWarRule1')}</li>
          <li>${t('guildWarRule2')}</li>
          <li>${t('guildWarRule3')}</li>
        </ul>
      </div>
    </div>`;
}

function _worldBossBodyHTML() {
  const st = (typeof _evtBossState !== 'undefined' && _evtBossState) || {};
  const alive   = !!(typeof _evtBossAlive !== 'undefined' ? _evtBossAlive : st.alive);
  const summonAt = st.spawnAt || 0;
  const pending = summonAt > Date.now();

  let phaseTxt, timeTxt, note;
  if (alive) {
    phaseTxt = t('wbPhaseAlive');
    timeTxt  = '⚔';
    note     = t('wbNoteAlive');
  } else if (pending) {
    phaseTxt = t('wbPhaseSummon');
    timeTxt  = _fmtBossTime(summonAt - Date.now());
    note     = t('wbNoteSummon');
  } else {
    phaseTxt = t('wbPhaseIdle');
    timeTxt  = st.nextAt ? _fmtEventEta(st.nextAt - Date.now()) : '—';
    note     = st.nextAt ? _fmtEventWhen(st.nextAt) : '';
  }

  return `
    <div style="padding:16px">
      <div class="db-countdown">${timeTxt}</div>
      <div class="db-phase">${phaseTxt}</div>
      ${note ? `<div class="db-count">${note}</div>` : ''}
      <div class="db-rules">
        ${t('wbScheduleHdr')}
        <ul>
          <li>${t('wbRule1')}</li>
          <li>${t('wbRule2')}</li>
          <li>${t('wbRule3')}</li>
        </ul>
      </div>
      <div class="db-rewards-hdr">${t('wbRewardsHdr')}</div>
      <div class="db-rewards">${_worldBossDropRows()}</div>
    </div>`;
}

// Static description of EVENT_BOSS's drop table (rollEventBossDrops, shared/
// definitions.js) — every quantity here is fixed on every single kill (the
// whole table lands on the floor at once, first come first served); only
// WHICH specific item fills the three "random" slots varies, so those show
// as a category with a placeholder icon rather than a concrete item.
function _worldBossDropRows() {
  const mat = id => (typeof CRAFT_MATS !== 'undefined' ? CRAFT_MATS.find(m => m.id === id) : null);
  const rows = [];
  const row = (img, name, qty) => rows.push(
    `<div class="db-reward-row">${img ? `<img src="${img}" alt="">` : '<span class="db-reward-fallback">🎁</span>'}
     <span>${name}</span><span class="db-reward-qty">×${qty}</span></div>`);

  const key = mat('key_uncommon');
  if (key) row(key.img, key.name, 10);

  (typeof ITEM_DEF !== 'undefined' ? ITEM_DEF.filter(i => i.slot === 'buff_potion') : [])
    .forEach(bp => row(bp.img, bp.name, 5));

  row(null, t('wbDropUncommonArmor'), 1);
  row(null, t('wbDropUncommonWeapon'), 1);
  row(null, t('wbDropCommonItems'), 5);

  const bless = mat('bless_stone');
  if (bless) row(bless.img, bless.name, 2);
  const norm = mat('norm_stone');
  if (norm) row(norm.img, norm.name, 5);

  return rows.join('');
}

// ─────────────────────────────────────────────────────────
//  DEATH BATTLE (Битва на смерть)
// ─────────────────────────────────────────────────────────
// Scheduled free-for-all (shared/definitions.js DEATH_BATTLE_*). The server
// drives every transition and pushes them as deathBattleState; this panel just
// renders whatever _dbState currently says and counts the seconds down locally
// so an open panel stays live without extra traffic.
// Called from the network handlers on every server push — keeps the Events
// button's highlight and (if open) the panel in step with the round.
// Shared by the death battle and race10 (Кровавая Башня) pushes — either
// one's registration window opening should highlight the Events button, and
// whichever closes last shouldn't clobber the other's still-open state.
function _updateEventsBtnHighlight() {
  const btn = document.getElementById('events-btn');
  if (!btn) return;
  const dbOpen = typeof _dbState !== 'undefined' && _dbState.phase === 'reg';
  const raceOpen = typeof _race10State !== 'undefined' && _race10State.phase === 'reg';
  const a3Open = typeof _a3State !== 'undefined' && _a3State.phase === 'reg';
  const open = dbOpen || raceOpen || a3Open;
  btn.classList.toggle('db-open', open);
  const label = document.getElementById('events-btn-text');
  if (label) label.textContent = open ? t('dbBtnOpen') : t('eventsBtn');
}

function onDeathBattleState() {
  _updateEventsBtnHighlight();
  if (_eventsPanelOpen() && _eventTab === 'battle') _renderEventsBody();
}

function _deathBattleBodyHTML() {
  const st = (typeof _dbState !== 'undefined' && _dbState) || { phase: 'idle', nextAt: 0, startAt: 0, count: 0 };
  const reg  = st.phase === 'reg';
  const live = st.phase === 'live';
  const target = reg ? st.startAt : st.nextAt;
  const left = Math.max(0, (target || 0) - Date.now());

  let phaseTxt, countTxt, action;
  if (live) {
    phaseTxt = t('dbPhaseLive');
    countTxt = tVars('dbAliveFmt', { n: st.count });
    action = `<button class="db-action" disabled>${t('dbPhaseLive')}</button>`;
  } else if (reg) {
    phaseTxt = t('dbPhaseReg');
    countTxt = tVars('dbSignedUpFmt', { n: st.count });
    action = _dbRegistered
      ? `<button class="db-action db-leave" onclick="netDeathBattleUnregister()">${t('dbLeaveBtn')}</button>`
      : `<button class="db-action" onclick="netDeathBattleRegister()">${t('dbJoinBtn')}</button>`;
  } else {
    phaseTxt = t('dbPhaseIdle');
    countTxt = '';
    action = `<button class="db-action" disabled>${t('dbClosedBtn')}</button>`;
  }

  // Idle counts down to a start that can be days away (вт/чт/сб), so it gets
  // the long-form ETA and the weekday; a live round stays on m:ss.
  const timeTxt = (reg || live) ? _fmtBossTime(left) : _fmtEventEta(left);
  const whenTxt = (!reg && !live && st.nextAt) ? _fmtEventWhen(st.nextAt) : countTxt;

  return `
    <div style="padding:16px">
      <div class="db-countdown">${timeTxt}</div>
      <div class="db-phase">${phaseTxt}</div>
      ${whenTxt ? `<div class="db-count">${whenTxt}</div>` : ''}
      ${action}
      <div class="db-rules">
        ${t('dbRulesHdr')}
        <ul>
          <li>${t('dbRule1')}</li>
          <li>${t('dbRule2')}</li>
          <li>${t('dbRule3')}</li>
          <li>${t('dbRule5')}</li>
          <li>${t('dbRule4')}</li>
        </ul>
      </div>
      <div class="db-rewards-hdr">${t('dbRewardsHdr')}</div>
      <div class="db-rewards">${_dbRewardRows()}</div>
    </div>`;
}

// One row per prize, shared by the panel's "what you can win" list and the
// winner's modal so the two can't drift apart. Called with no arguments it
// reads the canonical prize list straight out of shared/definitions.js, which
// is the same function the server grants from.
function _dbRewardRows(gram, items) {
  const g = gram !== undefined ? gram
    : (typeof DEATH_BATTLE_GRAM_REWARD !== 'undefined' ? DEATH_BATTLE_GRAM_REWARD : 0);
  const list = items || (typeof deathBattleRewards === 'function' ? deathBattleRewards() : []);
  const rows = [];
  if (g) {
    rows.push(`<div class="db-reward-row">
      <img src="/images/gram-icon.png" alt="">
      <span>GRAM</span><span class="db-reward-qty">+${g}</span></div>`);
  }
  list.forEach(it => {
    // Items carry their own inventory icon; the emoji is only a stand-in for a
    // prize that somehow has no art rather than a broken image.
    const icon = it.img ? `<img src="${it.img}" alt="">` : '<span class="db-reward-fallback">🎁</span>';
    rows.push(`<div class="db-reward-row">
      ${icon}<span>${it.name || it.id}</span><span class="db-reward-qty">×${it.qty || 1}</span></div>`);
  });
  return rows.join('');
}

// One ticker for the whole Events panel — both tabs count down, and only the
// visible one is rendered.
if (typeof setInterval === 'function') {
  setInterval(() => { if (_eventsPanelOpen()) _renderEventsBody(); }, 1000);
}

// Victory modal. The prize is already granted server-side by the time this
// shows; closing it is what sends the winner back to the hub.
function showDeathBattleWin(gram, items) {
  const modal = document.getElementById('db-win-modal');
  const list  = document.getElementById('db-win-rewards');
  if (!modal || !list) return;
  list.innerHTML = _dbRewardRows(gram, items || []);
  modal.style.display = 'flex';
}

// Pre-fight countdown overlay. Everyone is standing on their start point,
// frozen, until this hits zero — big and centred so it's unmissable, and
// pointer-events:none so it can't swallow a joystick touch the instant the
// freeze lifts. Built lazily like the event-boss banner.
//
// Shared by Death Battle's pre-fight freeze and Fear's pre-wave-1 grace
// window (FEAR_START_DELAY_MS on the server) — a player can never be in
// both at once, so one DOM node/timer pair is safe to reuse rather than
// forking a near-identical copy.
let _dbFreezeTick = null;
function _dbFreezeEl() {
  let el = document.getElementById('db-freeze');
  if (!el) {
    el = document.createElement('div');
    el.id = 'db-freeze';
    el.innerHTML = '<div class="db-freeze-num"></div><div class="db-freeze-lbl"></div>';
    document.body.appendChild(el);
  }
  return el;
}

function showFreezeCountdown(untilTs, label) {
  const el = _dbFreezeEl();
  const num = el.querySelector('.db-freeze-num');
  const lbl = el.querySelector('.db-freeze-lbl');
  lbl.textContent = label;
  clearInterval(_dbFreezeTick);
  const paint = () => {
    const left = Math.max(0, (untilTs || 0) - Date.now());
    if (left <= 0) { hideFreezeCountdown(); return; }
    num.textContent = Math.ceil(left / 1000);
    el.style.display = 'flex';
  };
  paint();
  _dbFreezeTick = setInterval(paint, 200);
}

function hideFreezeCountdown() {
  clearInterval(_dbFreezeTick);
  _dbFreezeTick = null;
  const el = document.getElementById('db-freeze');
  if (el) el.style.display = 'none';
}

function showDeathBattleFreeze(fightAt) { showFreezeCountdown(fightAt, t('dbFreezeLbl')); }
function hideDeathBattleFreeze() { hideFreezeCountdown(); }

function showFearCountdown(readyAt) { showFreezeCountdown(readyAt, t('fearFreezeLbl')); }
function hideFearCountdown() { hideFreezeCountdown(); }
function showCoopCountdown(readyAt) { showFreezeCountdown(readyAt, t('coopFreezeLbl')); }
function hideCoopCountdown() { hideFreezeCountdown(); }

function closeDeathBattleWin() {
  const modal = document.getElementById('db-win-modal');
  if (modal) modal.style.display = 'none';
  if (typeof netDeathBattleReturn === 'function') netDeathBattleReturn();
}

function openMarketPanel() {
  const panel = document.getElementById('market-panel');
  if (!panel) return;
  if (player && (player.lvl || 1) < FEATURE_UNLOCK_LEVEL) {
    if (typeof dmgNum === 'function') dmgNum(player.x, player.y - 38, tVars('marketUnlockToast', { n: FEATURE_UNLOCK_LEVEL }), '#eaa742');
    return;
  }
  panel.style.display = 'flex';
  _ensureMarketStripScroll();
  switchMarketTab(_marketTab);
}

function closeMarketPanel() {
  const panel = document.getElementById('market-panel');
  if (panel) panel.style.display = 'none';
}

function switchMarketTab(tab) {
  // ── фильтр принадлежит вкладке, а не панели ──────────────────────────────
  // Поиск, категория и редкость, выставленные на «Лотах», продолжали резать
  // «Мои лоты» и «Историю»: у игрока семь активных лотов, а вкладка
  // показывала «ничего не найдено». Именно это прочиталось как «пропали 2
  // зелёных плаща и 1 серый» — вещи всё это время лежали на рынке.
  //
  // Сбрасывается при СМЕНЕ вкладки, а не при каждом заходе: повторное нажатие
  // на уже открытую вкладку не должно стирать то, что человек только что
  // набрал.
  if (tab !== _marketTab) {
    _marketCategoryFilter = 'all';
    _marketFilters.q = '';
    _marketFilters.rarity = 'all';
    const _q = document.getElementById('market-search-input');
    if (_q) _q.value = '';
  }
  _marketTab = tab;
  document.querySelectorAll('#market-panel .rating-tab').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('mtab-' + tab);
  if (btn) btn.classList.add('active');
  _renderMarketBody();
  if (tab === 'lots') netMarketBrowse();
  else if (tab === 'mine') netMarketMyListings();
  else if (tab === 'history') netMarketHistory();
}

function _renderMarketBody() {
  const el = document.getElementById('market-body');
  if (!el) return;
  // The search box lives inside the body, which is rewritten wholesale on
  // every keystroke — restore focus and the caret afterwards, or typing a
  // query loses the field after its first character. Same handling as the
  // codex panel's own search (renderCodexPanel).
  const prevInput = document.getElementById('market-search-input');
  const hadFocus = prevInput && document.activeElement === prevInput;
  const caret = hadFocus ? prevInput.selectionStart : null;
  // Horizontal scroll position of the category strip: it is re-created by
  // every render too, so without this a click on a tab far along the strip
  // snaps the strip back to the start under the player's cursor.
  const prevStrip = el.querySelector('.market-cat-tabs');
  const stripLeft = prevStrip ? prevStrip.scrollLeft : 0;

  if (_marketTab === 'lots') _renderMarketLots(el);
  else if (_marketTab === 'mine') _renderMarketMine(el);
  else _renderMarketHistoryTab(el);

  const strip = el.querySelector('.market-cat-tabs');
  if (strip && stripLeft) strip.scrollLeft = stripLeft;
  if (hadFocus) {
    const input = document.getElementById('market-search-input');
    if (input) { input.focus(); if (caret != null) input.setSelectionRange(caret, caret); }
  }
}

// The category strip is a horizontal scroller with its scrollbar hidden by
// design (a phone flicks it with a finger). On a PC there is no finger, no
// horizontal wheel on an ordinary mouse, and nothing visible to drag — so
// every category past the visible width was simply unreachable, which is the
// reported "с ПК невозможно листать вкладки". A vertical wheel over the strip
// is turned into horizontal scrolling here, and the strip can be dragged with
// the mouse like a finger; the CSS gives fine-pointer devices a slim
// scrollbar back on top of that.
//
// Delegated from the panel, not bound to the strip: every render replaces the
// strip element, and re-binding on each of them would leak a listener per
// keystroke.
let _marketStripWired = false;
function _ensureMarketStripScroll() {
  if (_marketStripWired) return;
  const panel = document.getElementById('market-panel');
  if (!panel) return;
  _marketStripWired = true;
  const stripOf = e => (e.target && e.target.closest) ? e.target.closest('.market-cat-tabs') : null;
  const scrollable = s => s && s.scrollWidth > s.clientWidth + 1;

  panel.addEventListener('wheel', e => {
    const strip = stripOf(e);
    if (!scrollable(strip)) return;      // nothing to scroll: leave the body's own vertical scroll alone
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!d) return;
    strip.scrollLeft += d;
    e.preventDefault();
  }, { passive: false });

  // Mouse drag. Touch is left alone — it already pans the strip natively
  // (see the touch-action override in css/style.css) and hijacking it here
  // would fight that.
  let drag = null;
  let swallowClick = false;
  panel.addEventListener('pointerdown', e => {
    // Cleared on the way in, not on a timer: a drag that ends outside the
    // strip never produces the click that would consume the flag, and a
    // stale one would then eat the next real tab click.
    swallowClick = false;
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    const strip = stripOf(e);
    if (!scrollable(strip)) return;
    drag = { strip, x: e.clientX, left: strip.scrollLeft, moved: false };
  });
  panel.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    // A few pixels of slack so an ordinary click on a tab still clicks it.
    if (!drag.moved && Math.abs(dx) < 4) return;
    drag.moved = true;
    drag.strip.scrollLeft = drag.left - dx;
    e.preventDefault();
  });
  const endDrag = () => {
    if (drag && drag.moved) swallowClick = true;
    drag = null;
  };
  panel.addEventListener('pointerup', endDrag);
  panel.addEventListener('pointercancel', endDrag);
  panel.addEventListener('pointerleave', endDrag);
  // Swallow the click that ends a drag — releasing the mouse over a tab you
  // only dragged past must not switch the category. Capture phase, since the
  // tabs carry inline onclick handlers.
  panel.addEventListener('click', e => {
    if (!swallowClick) return;
    swallowClick = false;
    if (!stripOf(e)) return;
    e.stopPropagation();
    e.preventDefault();
  }, true);
}

function _marketRowHtml(l, mode) {
  const it = l.item || {};
  const rc = RARITY_COLOR[it.rarity] || '#aea599';
  const qtySuffix = it.qty > 1 ? ` ×${it.qty}` : '';
  // Seller name escaped: it comes from the seller's Telegram account, which
  // falls back to first_name when no @handle is set — arbitrary text, and
  // this string is written straight into innerHTML below. Same reasoning as
  // _escAttr's comment in js/network.js.
  const sub = mode === 'buy' ? `@${_escHtml(l.sellerUsername || '?')}` : (statStr(it) || '');
  // Свой лот купить нельзя, и сервер это отказывает (market.js: own_lot). Но
  // до сих пор кнопка выглядела рабочей: игрок жал «Купить», ждал, и получал
  // отказ — на действие, которое ни при каких условиях не могло состояться.
  // Кнопка, которая не может сработать, не должна нажиматься.
  const _mine = mode === 'buy' && typeof netUsername !== 'undefined' && netUsername
    && String(l.sellerUsername || '').toLowerCase() === String(netUsername).toLowerCase();
  const action = mode === 'buy'
    ? (_mine
      ? `<button class="market-buy-btn disabled" disabled>${t('marketOwnLotBtn')}</button>`
      : `<button class="market-buy-btn" onclick="openMarketBuyConfirm('${l.id}')">${t('buyBtn')}</button>`)
    : `<button class="market-cancel-btn" onclick="marketCancelListing('${l.id}')">${t('cancelListingBtn')}</button>`;
  return `<div class="market-row">
    <div class="market-row-icon">${_itemIcon(it, 28)}</div>
    <div class="market-row-info">
      <div class="market-row-name" style="color:${rc}">${it.name || '?'}${it.enhance ? ' +' + it.enhance : ''}${qtySuffix}</div>
      <div class="market-row-sub">${sub}</div>
      ${action}
    </div>
    <div class="market-row-price">${l.price.toFixed(2)}<br><span style="font-size:9px;color:#a3957c;font-weight:600">GRAM</span></div>
  </div>`;
}

// Market category filter — checked in order, first match wins, so more
// specific categories (books, which are craft-mat items with a book_ id)
// come ahead of their broader slot (material).
const _MARKET_CATEGORIES = [
  { key: 'weapon',    get label() { return t('catWeapon'); },    match: it => it.slot === 'weapon' },
  { key: 'helmet',    get label() { return t('catHelmet'); },    match: it => it.slot === 'helmet' },
  { key: 'body',      get label() { return t('catBody'); },      match: it => it.slot === 'body' },
  { key: 'gloves',    get label() { return t('catGloves'); },    match: it => it.slot === 'gloves' },
  { key: 'boots',     get label() { return t('catBoots'); },     match: it => it.slot === 'boots' },
  { key: 'ring',      get label() { return t('catRing'); },      match: it => it.slot === 'ring' },
  { key: 'belt',      get label() { return t('catBelt'); },      match: it => it.slot === 'belt' },
  { key: 'cloak',     get label() { return t('catCloak'); },     match: it => it.slot === 'cloak' },
  { key: 'artifact',  get label() { return t('catArtifact'); },  match: it => it.slot === 'artifact' },
  { key: 'books',     get label() { return t('catBooks'); },     match: it => (it.id || '').startsWith('book_') },
  { key: 'potions',   get label() { return t('catPotions'); },   match: it => it.slot === 'use' || it.slot === 'buff_potion' },
  { key: 'materials', get label() { return t('catMaterials'); }, match: it => it.slot === 'material' || it.slot === 'recipe' },
  { key: 'other',     get label() { return t('catOther'); },     match: () => true },
];
let _marketCategoryFilter = 'all';
// Search box + the two selects above the category strip. They compose with
// the category filter rather than replacing it: the strip's counts are taken
// over what these leave, so a tab always says how many rows it would show.
const _marketFilters = { q: '', rarity: 'all', sort: 'new' };
// Legendary first — someone sorting a market by rarity is scanning for the
// best thing on it, not reading the tiers bottom-up.
const _MARKET_RARITY_RANK = { legendary: 0, epic: 1, rare: 2, uncommon: 3, common: 4 };
const _MARKET_SORTS = [
  { key: 'new',      get label() { return t('marketSortNew'); } },
  { key: 'rarity',   get label() { return t('marketSortRarity'); } },
  { key: 'priceAsc', get label() { return t('marketSortPriceAsc'); } },
  { key: 'priceDsc', get label() { return t('marketSortPriceDsc'); } },
];

function _marketCategoryOf(it) {
  return (_MARKET_CATEGORIES.find(c => c.match(it)) || _MARKET_CATEGORIES[_MARKET_CATEGORIES.length - 1]).key;
}

function setMarketCategory(key) {
  _marketCategoryFilter = key;
  _renderMarketBody();
}

function _marketSetFilter(key, val) {
  _marketFilters[key] = val;
  _renderMarketBody();
}

// Name match only, on the same string the row displays — the catalog name is
// what a player is looking at when they type.
function _marketMatchesSearch(it, q) {
  if (!q) return true;
  return String(it.name || '').toLowerCase().includes(q);
}

function _marketSortLots(lots) {
  const rank = it => (_MARKET_RARITY_RANK[(it || {}).rarity] != null ? _MARKET_RARITY_RANK[it.rarity] : 9);
  // slice(): _marketLots/_marketMine are the arrays the server's own order
  // (newest first) lives in, and 'new' has to be able to go back to it.
  const out = lots.slice();
  if (_marketFilters.sort === 'rarity') {
    out.sort((a, b) => rank(a.item) - rank(b.item) || a.price - b.price);
  } else if (_marketFilters.sort === 'priceAsc') {
    out.sort((a, b) => a.price - b.price);
  } else if (_marketFilters.sort === 'priceDsc') {
    out.sort((a, b) => b.price - a.price);
  }
  return out;
}

function _marketToolbarHtml() {
  const rarityOpts = ['legendary', 'epic', 'rare', 'uncommon', 'common'].map(r =>
    `<option value="${r}"${_marketFilters.rarity === r ? ' selected' : ''}>${_RARITY_NAMES[r] || r}</option>`).join('');
  const sortOpts = _MARKET_SORTS.map(s =>
    `<option value="${s.key}"${_marketFilters.sort === s.key ? ' selected' : ''}>${s.label}</option>`).join('');
  return `<div class="market-toolbar">
    <input id="market-search-input" class="market-search" type="text" autocomplete="off"
      placeholder="${_escAttr(t('marketSearchPlaceholder'))}" value="${_escAttr(_marketFilters.q)}"
      oninput="_marketSetFilter('q', this.value)">
    <select class="market-select" onchange="_marketSetFilter('rarity', this.value)">
      <option value="all"${_marketFilters.rarity === 'all' ? ' selected' : ''}>${t('allRaritiesLbl')}</option>
      ${rarityOpts}
    </select>
    <select class="market-select" onchange="_marketSetFilter('sort', this.value)">${sortOpts}</select>
  </div>`;
}

function _renderMarketFiltered(lots, mode) {
  const q = (_marketFilters.q || '').trim().toLowerCase();
  // Search and rarity first: the category counts below are what's left after
  // them, so "Оружие 3" during a search means three weapons match the search.
  const pool = lots.filter(l => {
    const it = l.item || {};
    if (_marketFilters.rarity !== 'all' && it.rarity !== _marketFilters.rarity) return false;
    return _marketMatchesSearch(it, q);
  });

  const counts = new Map(_MARKET_CATEGORIES.map(c => [c.key, 0]));
  pool.forEach(l => {
    const key = _marketCategoryOf(l.item || {});
    counts.set(key, counts.get(key) + 1);
  });

  const allTab = `<button class="market-cat-tab${_marketCategoryFilter === 'all' ? ' active' : ''}" onclick="setMarketCategory('all')">${t('allCatLbl')} <span class="market-cat-count">${pool.length}</span></button>`;
  const catTabs = _MARKET_CATEGORIES.map(c => {
    const n = counts.get(c.key);
    // The selected category keeps its tab even at zero — otherwise the strip
    // drops the very tab that explains why the list below is empty, and the
    // filter stays silently applied with nothing to switch off.
    if (!n && _marketCategoryFilter !== c.key) return '';
    return `<button class="market-cat-tab${_marketCategoryFilter === c.key ? ' active' : ''}" onclick="setMarketCategory('${c.key}')">${c.label} <span class="market-cat-count">${n}</span></button>`;
  }).join('');
  const tabsHtml = `<div class="market-cat-tabs">${allTab}${catTabs}</div>`;

  const inCat = _marketCategoryFilter === 'all' ? pool : pool.filter(l => _marketCategoryOf(l.item || {}) === _marketCategoryFilter);
  const shown = _marketSortLots(inCat);
  const emptyMsg = (q || _marketFilters.rarity !== 'all') ? t('marketNothingFoundHint') : t('noItemsInCategoryHint');
  const listHtml = shown.length
    ? shown.map(l => _marketRowHtml(l, mode)).join('')
    : `<div class="rating-empty">${emptyMsg}</div>`;
  return _marketToolbarHtml() + tabsHtml + listHtml;
}

function _renderMarketLots(el) {
  if (!_marketLoaded.lots) { el.innerHTML = `<div class="rating-loading">${t('questLoading')}</div>`; return; }
  if (!_marketLots.length) { el.innerHTML = `<div class="rating-empty">${t('nobodySellingHint')}</div>`; return; }
  // Рівно стільки, скільки віддає сервер за один запит, означає «швидше за
  // все, там є ще». Пошук і лічильники категорій рахуються по завантаженому
  // масиву, тож у цьому випадку вони описують не весь ринок — і гравець має
  // це бачити, а не гадати, чому знайомий лот «зник».
  const cut = _marketLots.length >= MARKET_BROWSE_MAX
    ? `<div class="market-truncated">${tVars('marketTruncatedFmt', { n: MARKET_BROWSE_MAX })}</div>`
    : '';
  el.innerHTML = cut + _renderMarketFiltered(_marketLots, 'buy');
}

function _renderMarketMine(el) {
  const addBtn = `<button class="market-add-btn" onclick="openMarketSellPicker()">${t('addListingBtn')}</button>`;
  if (!_marketLoaded.mine) { el.innerHTML = addBtn + `<div class="rating-loading">${t('questLoading')}</div>`; return; }
  if (!_marketMine.length) { el.innerHTML = addBtn + `<div class="rating-empty">${t('noActiveLotsHint')}</div>`; return; }
  el.innerHTML = addBtn + _renderMarketFiltered(_marketMine, 'mine');
}

function _renderMarketHistoryTab(el) {
  if (!_marketLoaded.history) { el.innerHTML = `<div class="rating-loading">${t('questLoading')}</div>`; return; }
  if (!_marketHist.length) { el.innerHTML = `<div class="rating-empty">${t('historyEmptyHint')}</div>`; return; }
  el.innerHTML = _marketHist.map(h => {
    const it = h.item || {};
    const rc = RARITY_COLOR[it.rarity] || '#aea599';
    const isSell = h.role === 'sell';
    const cancelled = h.status === 'cancelled';
    const statusCls = cancelled ? 'market-hist-cancelled' : (isSell ? 'market-hist-sell' : 'market-hist-buy');
    const statusLbl = cancelled ? t('cancelledLbl') : (isSell ? t('soldLbl') : t('boughtLbl'));
    const date = new Date(h.soldAt || h.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const amt = cancelled ? '' : (isSell ? (h.price * (1 - MARKET_FEE_PCT)).toFixed(2) : h.price.toFixed(2));
    const amtSign = cancelled ? '' : (isSell ? '+' : '-');
    return `<div class="market-row">
      <div class="market-row-icon">${_itemIcon(it, 28)}</div>
      <div class="market-row-info">
        <div class="market-row-name" style="color:${rc}">${it.name || '?'}${it.enhance ? ' +' + it.enhance : ''}${it.qty > 1 ? ' ×' + it.qty : ''}</div>
        <div class="market-row-sub">${h.counterpart ? '@' + h.counterpart + ' · ' : ''}${date}</div>
        <span class="market-hist-status ${statusCls}">${statusLbl}</span>
      </div>
      <div class="market-row-price">${amt ? amtSign + amt + '<br><span style="font-size:9px;color:#a3957c;font-weight:600">GRAM</span>' : ''}</div>
    </div>`;
  }).join('');
}

function _marketToast(text, type) {
  const ok = type !== 'err';
  const toast = document.createElement('div');
  toast.style.cssText = `position:fixed;top:80px;left:50%;transform:translateX(-50%);background:${ok ? '#29361e' : '#381c1f'};border:1px solid ${ok ? '#89ba5f' : '#d55d6b'};color:${ok ? '#89ba5f' : '#f17e8b'};padding:10px 18px;border-radius:10px;font-size:13px;font-weight:600;z-index:9999;pointer-events:none;max-width:80vw;text-align:center`;
  toast.textContent = text;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ─────────────────────────────────────────────────────────
//  EVENT BOSS — countdown banner + arrival/defeat announcement
// ─────────────────────────────────────────────────────────
// One persistent strip under the HUD counting down to the summoned boss
// (shared/definitions.js EVENT_BOSS), replaced by a short flash message when
// it actually arrives or dies. Created lazily so the markup lives in one
// place instead of index.html.
let _evtBossSpawnAt = 0, _evtBossTick = null;

function _evtBossEl() {
  let el = document.getElementById('evt-boss-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'evt-boss-banner';
    el.style.cssText = 'position:fixed;top:74px;left:50%;transform:translateX(-50%);' +
      'background:rgba(22,18,10,.94);border:1px solid #d55d6b;color:#f5dbae;' +
      'padding:8px 16px;border-radius:10px;font-size:13px;font-weight:700;z-index:350;' +
      'pointer-events:none;max-width:88vw;text-align:center;display:none;' +
      'box-shadow:0 4px 18px rgba(0,0,0,.5)';
    document.body.appendChild(el);
  }
  return el;
}

// spawnAt = 0 clears the countdown (boss arrived, or nothing pending).
function setEventBossCountdown(spawnAt) {
  _evtBossSpawnAt = spawnAt || 0;
  clearInterval(_evtBossTick);
  _evtBossTick = null;
  const el = _evtBossEl();
  if (!_evtBossSpawnAt || _evtBossSpawnAt <= Date.now()) { el.style.display = 'none'; return; }
  const paint = () => {
    const left = Math.max(0, _evtBossSpawnAt - Date.now());
    if (left <= 0) { clearInterval(_evtBossTick); _evtBossTick = null; el.style.display = 'none'; return; }
    const m = Math.floor(left / 60000), s = Math.floor(left % 60000 / 1000);
    el.style.borderColor = '#d55d6b';
    el.style.display = 'block';
    el.textContent = tVars('evtBossIncomingFmt', { time: m + ':' + String(s).padStart(2, '0') });
  };
  paint();
  _evtBossTick = setInterval(paint, 1000);
}

// Dedicated HP readout for the event boss. Its own bar over its head is
// useless at this scale: 100k HP against a level-13 character's ~55 damage
// moves that bar 0.2px per hit, which reads as "damage isn't registering"
// even though every shot lands. This shows the exact numbers and a percentage
// so progress is unmistakable, and because it's shared it also makes a raid's
// combined DPS visible.
function _evtBossHpEl() {
  let el = document.getElementById('evt-boss-hp');
  if (!el) {
    el = document.createElement('div');
    el.id = 'evt-boss-hp';
    el.style.cssText = 'position:fixed;top:110px;left:50%;transform:translateX(-50%);' +
      'width:min(420px,92vw);z-index:340;pointer-events:none;display:none;text-align:center';
    el.innerHTML =
      '<div id="evt-hp-name" style="font-size:12px;font-weight:800;color:#f5dbae;text-shadow:0 1px 3px #000;margin-bottom:3px"></div>' +
      '<div style="height:14px;background:rgba(10,8,4,.85);border:1px solid #7a2b33;border-radius:7px;overflow:hidden">' +
      '<div id="evt-hp-fill" style="height:100%;width:100%;background:linear-gradient(90deg,#8c1f2a,#e0432f);transition:width .18s linear"></div>' +
      '</div>' +
      '<div id="evt-hp-num" style="font-size:11px;color:#d9c9a8;text-shadow:0 1px 3px #000;margin-top:2px;font-variant-numeric:tabular-nums"></div>';
    document.body.appendChild(el);
  }
  return el;
}

// Called from the game loop (throttled) — reads the live enemy snapshot.
// Doubles as the race10 boss's HP readout (own eid, see the comment in
// js/sprites.js) — a player is never near both at once, so sharing the one
// element is harmless and saves building a second copy of this bar.
function updateEventBossHpBar() {
  const el = _evtBossHpEl();
  const b = (typeof serverEnemies !== 'undefined')
    ? serverEnemies.find(e => (e.eid === 'demon_event_boss' || e.eid === 'race10_boss') && (e.hp || 0) > 0) : null;
  if (!b) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  const pct = Math.max(0, Math.min(1, b.hp / (b.maxHp || 1)));
  document.getElementById('evt-hp-name').textContent = b.name || '';
  document.getElementById('evt-hp-fill').style.width = (pct * 100).toFixed(2) + '%';
  document.getElementById('evt-hp-num').textContent =
    Math.ceil(b.hp).toLocaleString('ru-RU') + ' / ' + (b.maxHp || 0).toLocaleString('ru-RU') +
    '  ·  ' + (pct * 100).toFixed(1) + '%';
}

function showEventBossBanner(text, color) {
  clearInterval(_evtBossTick);
  _evtBossTick = null;
  _evtBossSpawnAt = 0;
  const el = _evtBossEl();
  el.style.borderColor = color || '#d55d6b';
  el.style.display = 'block';
  el.textContent = text;
  clearTimeout(showEventBossBanner._t);
  showEventBossBanner._t = setTimeout(() => { el.style.display = 'none'; }, 8000);
}

// ── Guild War (Война гильдий) HP bar + capture banner ────────────────────────
// Own elements rather than reusing evt-boss-hp/evt-boss-banner above: this is
// ownership state (an owner name/icon line), not a countdown, and the zone
// being sealed doesn't guarantee a player can never also be near the world
// boss's arena at the same time.
function _gwHpEl() {
  let el = document.getElementById('gw-tower-hp');
  if (!el) {
    el = document.createElement('div');
    el.id = 'gw-tower-hp';
    el.style.cssText = 'position:fixed;top:110px;left:50%;transform:translateX(-50%);' +
      'width:min(420px,92vw);z-index:340;pointer-events:none;display:none;text-align:center';
    el.innerHTML =
      '<div id="gw-hp-name" style="font-size:12px;font-weight:800;color:#f5dbae;text-shadow:0 1px 3px #000;margin-bottom:3px"></div>' +
      '<div style="height:14px;background:rgba(10,8,4,.85);border:1px solid #6b4f22;border-radius:7px;overflow:hidden">' +
      '<div id="gw-hp-fill" style="height:100%;width:100%;background:linear-gradient(90deg,#7a5a1f,#c9a24b);transition:width .18s linear"></div>' +
      '</div>' +
      '<div id="gw-hp-num" style="font-size:11px;color:#d9c9a8;text-shadow:0 1px 3px #000;margin-top:2px;font-variant-numeric:tabular-nums"></div>';
    document.body.appendChild(el);
  }
  return el;
}

// Called from the game loop (throttled, see js/game.js's _updateTeleportPads)
// — reads the live enemy snapshot for hp/maxHp, and _gwState (kept in sync by
// js/network.js's guildWarState handler) for the owner name, since netcodec's
// fixed-shape enemy wire encoding has no room for arbitrary extra fields like
// ownerClanName.
function updateGuildWarHpBar() {
  const el = _gwHpEl();
  const b = (typeof serverEnemies !== 'undefined') ? serverEnemies.find(e => e.eid === 'guildwar_castle') : null;
  if (!b) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  const pct = Math.max(0, Math.min(1, b.hp / (b.maxHp || 1)));
  const owner = _gwState && _gwState.ownerClanName;
  document.getElementById('gw-hp-name').textContent =
    (b.name || 'Замок гильдий') + (owner ? ` · ${owner}` : '');
  document.getElementById('gw-hp-fill').style.width = (pct * 100).toFixed(2) + '%';
  document.getElementById('gw-hp-num').textContent =
    Math.ceil(b.hp).toLocaleString('ru-RU') + ' / ' + (b.maxHp || 0).toLocaleString('ru-RU') +
    '  ·  ' + (pct * 100).toFixed(1) + '%';
}

function _gwBannerEl() {
  let el = document.getElementById('gw-captured-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'gw-captured-banner';
    el.style.cssText = 'position:fixed;top:74px;left:50%;transform:translateX(-50%);' +
      'background:rgba(22,18,10,.94);border:1px solid #c9a24b;color:#f5dbae;' +
      'padding:8px 16px;border-radius:10px;font-size:13px;font-weight:700;z-index:350;' +
      'pointer-events:none;max-width:88vw;text-align:center;display:none;' +
      'box-shadow:0 4px 18px rgba(0,0,0,.5)';
    document.body.appendChild(el);
  }
  return el;
}

function showGuildWarCapturedBanner(newOwnerClanName, newOwnerClanIcon, prevOwnerClanName) {
  const el = _gwBannerEl();
  el.style.display = 'block';
  el.textContent = prevOwnerClanName
    ? `🏰 Замок гильдий захвачен кланом «${newOwnerClanName}» (был у «${prevOwnerClanName}»)`
    : `🏰 Замок гильдий захвачен кланом «${newOwnerClanName}»`;
  clearTimeout(showGuildWarCapturedBanner._t);
  showGuildWarCapturedBanner._t = setTimeout(() => { el.style.display = 'none'; }, 8000);
}

// Refresh hook for js/network.js's guildWarState handler — currently just a
// placeholder for a future Events-panel status entry (owner/countdown), same
// role onRace10State/onArena3State play for their own panels; the HP bar
// above already updates on its own throttled cadence and doesn't need this.
function onGuildWarState() {}

// ── Buy flow ────────────────────────────────────────────────
function openMarketBuyConfirm(listingId) {
  // Compared as TEXT. The id arrives from an onclick attribute, so it is
  // always a string; the lot's own id used to be a Mongo _id string and is now
  // a PostgreSQL bigint arriving as a number. `'229' === 229` is false, the
  // lookup missed, and this returned — no request, no error, no log line.
  // "Не покупается" with nothing anywhere to say why.
  const l = _marketLots.find(x => String(x.id) === String(listingId));
  if (!l) return;
  if (typeof invHasSpace === 'function' && !invHasSpace()) {
    _marketToast(t('invFullFreeSpaceToast'), 'err');
    return;
  }
  const existing = document.getElementById('market-buy-ov');
  if (existing) existing.remove();
  const it  = l.item || {};
  const rc  = RARITY_COLOR[it.rarity] || '#aea599';
  const bal = window._gramBalance || 0;
  const canAfford = bal >= l.price;
  const ov = document.createElement('div');
  ov.className = 'market-modal-overlay';
  ov.id = 'market-buy-ov';
  ov.onclick = () => ov.remove();
  ov.innerHTML = `
    <div class="market-modal-sheet" onclick="event.stopPropagation()">
      <div style="display:flex;align-items:center;margin-bottom:14px">
        <div style="font-size:16px;font-weight:800;color:#90d653">${t('confirmPurchaseTitle')}</div>
        <button onclick="document.getElementById('market-buy-ov').remove()" style="margin-left:auto;width:28px;height:28px;border:none;border-radius:50%;background:rgba(209,204,197,.08);color:#968a7a;cursor:pointer">✕</button>
      </div>
      <div style="display:flex;align-items:center;gap:12px;padding:10px;background:rgba(209,204,197,.04);border-radius:10px;margin-bottom:14px">
        <div class="market-row-icon" style="width:44px;height:44px">${_itemIcon(it, 32)}</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;color:${rc}">${it.name || '?'}${it.enhance ? ' +' + it.enhance : ''}${it.qty > 1 ? ' ×' + it.qty : ''}</div>
          <div style="font-size:11px;color:#a3957c;margin-top:2px">${statStr(it) || '&nbsp;'}</div>
          <div style="font-size:11px;color:#a3957c;margin-top:2px">${tVars('sellerLbl', { u: _escHtml(l.sellerUsername || '?') })}</div>
        </div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px"><span style="color:#b2a288">${t('priceLbl')}</span><span style="font-weight:700;color:#90d653">${l.price.toFixed(2)} GRAM</span></div>
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:16px"><span style="color:#b2a288">${t('yourBalanceLbl')}</span><span style="font-weight:700;color:${canAfford ? '#f5dbae' : '#ee6676'}">${bal.toFixed(7)} GRAM</span></div>
      ${canAfford
        ? `<button class="gram-btn gram-btn-green" style="width:100%;padding:13px" onclick="_confirmMarketBuy('${listingId}')">${tVars('buyForFmt', { price: l.price.toFixed(2) })}</button>`
        : `<div style="text-align:center;color:#ee6676;font-size:12px;font-weight:600">${t('notEnoughGramLbl')}</div>`}
    </div>`;
  document.body.appendChild(ov);
}

function _confirmMarketBuy(listingId) {
  const ov = document.getElementById('market-buy-ov');
  if (ov) ov.remove();
  netMarketBuy(listingId);
}

function marketCancelListing(listingId) {
  netMarketCancel(listingId);
}

// ── Sell flow ───────────────────────────────────────────────
function openMarketSellPicker() {
  if (!player) return;
  // Display-only pre-check — the server enforces the real gate (marketList,
  // server/index.js) and rejects with marketListError regardless of this.
  if ((window._vipData?.level || 0) < 1) {
    _marketToast(t('marketListVipRequiredToast'), 'err');
    return;
  }
  const existing = document.getElementById('market-sell-ov');
  if (existing) existing.remove();
  _marketSellPick = null;
  const ov = document.createElement('div');
  ov.className = 'market-modal-overlay';
  ov.id = 'market-sell-ov';
  ov.onclick = () => ov.remove();
  ov.innerHTML = `
    <div class="market-modal-sheet" onclick="event.stopPropagation()">
      <div style="display:flex;align-items:center;margin-bottom:10px">
        <div style="font-size:16px;font-weight:800;color:#90d653">${t('listItemTitle')}</div>
        <button onclick="document.getElementById('market-sell-ov').remove()" style="margin-left:auto;width:28px;height:28px;border:none;border-radius:50%;background:rgba(209,204,197,.08);color:#968a7a;cursor:pointer">✕</button>
      </div>
      <div style="font-size:11px;color:#a3957c;margin-bottom:8px">${t('selectFromInvHint')}</div>
      <div class="market-pick-grid" id="market-pick-grid"></div>
      <div id="market-sell-confirm" style="display:none;margin-top:6px">
        <div style="display:flex;align-items:center;gap:10px;padding:10px;background:rgba(209,204,197,.04);border-radius:10px;margin-bottom:12px" id="market-sell-selected"></div>
        <div id="market-qty-row" style="display:none;margin-bottom:10px">
          <div style="font-size:11px;color:#a3957c;margin-bottom:5px" id="market-qty-label">${t('quantityLbl')}</div>
          <input type="number" id="market-qty-input" min="1" step="1" value="1"
            style="width:100%;padding:11px;border-radius:9px;border:1px solid rgba(209,204,197,.15);background:rgba(209,204,197,.05);color:#d1ccc5;font-size:15px;font-weight:700;box-sizing:border-box" oninput="_clampMarketQtyInput()">
        </div>
        <div style="font-size:11px;color:#a3957c;margin-bottom:5px" id="market-price-hint">${tVars('priceForOneFmt', { min: MARKET_MIN_PRICE, max: MARKET_MAX_PRICE })}</div>
        <input type="number" id="market-price-input" min="${MARKET_MIN_PRICE}" max="${MARKET_MAX_PRICE}" step="0.1" value="1"
          style="width:100%;padding:11px;border-radius:9px;border:1px solid rgba(209,204,197,.15);background:rgba(209,204,197,.05);color:#d1ccc5;font-size:15px;font-weight:700;margin-bottom:6px;box-sizing:border-box" oninput="_updateMarketFeePreview()">
        <div id="market-fee-preview" style="font-size:11px;color:#a3957c;margin-bottom:14px"></div>
        <button class="market-add-btn" id="market-confirm-btn" onclick="_confirmMarketList()">${t('listForSaleBtn')}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  _renderMarketPickGrid();
}

function closeMarketSellPicker() {
  const ov = document.getElementById('market-sell-ov');
  if (ov) ov.remove();
  _marketSellPick = null;
}

function _renderMarketPickGrid() {
  const grid = document.getElementById('market-pick-grid');
  if (!grid || !player) return;
  if (!player.inventory.length) { grid.innerHTML = `<div class="rating-empty" style="grid-column:1/-1">${t('storageInvEmpty')}</div>`; return; }
  grid.innerHTML = player.inventory.map((it, idx) => {
    const rc  = RARITY_COLOR[it.rarity] || '#aea599';
    const sel = _marketSellPick === idx ? ' selected' : '';
    const cnt = it.qty > 1 ? `<span style="position:absolute;bottom:1px;right:2px;font-size:7px;color:#cfc0ad;font-weight:bold">×${it.qty}</span>` : '';
    return `<div class="market-pick-cell${sel}" style="border-color:${rc}55" onclick="_pickMarketSellItem(${idx})" title="${it.name}">
      ${_itemIcon(it, 26)}${cnt}
    </div>`;
  }).join('');
}

// Скільки одиниць охоплює лот, який зараз збирається — значення поля
// кількості, коли воно показане, і 1 в усіх інших випадках. Витягнуто в
// окрему функцію, бо це число потрібне вже трьом місцям (підлога ціни, текст
// підказки і сам запит), а рахувалося воно з DOM у кожному окремо.
function _currentMarketQty() {
  const qtyInput = document.getElementById('market-qty-input');
  const qtyRow   = document.getElementById('market-qty-row');
  if (!qtyRow || qtyRow.style.display === 'none' || !qtyInput) return 1;
  const n = Math.floor(Number(qtyInput.value));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

// Current pick's item + however many units this listing covers right now
// (the qty input when it's showing, otherwise 1) — the one place both the
// hint and the validation read the live minimum from.
function _currentMarketMinPrice() {
  const idx = _marketSellPick;
  const it  = idx !== null && player ? player.inventory[idx] : null;
  if (!it) return MARKET_MIN_PRICE;
  return _marketMinPriceFor(it, _currentMarketQty());
}

// Refreshes the price input's floor (both the hint text and its `min`
// attribute) for whatever's picked right now — called on pick and on every
// qty change, since keys/recipes/stones price per unit.
//
// Текст підказки називає кількість. Ціна тут завжди була за ВЕСЬ лот, і поки
// лот дорівнював усьому стаку, «за всё количество» це й означало. Тепер
// кількість обирає гравець, і без числа в підказці «1.8» за 296 ключів та
// «1.8» за один ключ виглядають однаково.
function _updateMarketPriceHint() {
  const hint  = document.getElementById('market-price-hint');
  const input = document.getElementById('market-price-input');
  if (!hint || !input) return;
  const min = _currentMarketMinPrice();
  const n   = _currentMarketQty();
  hint.textContent = n > 1
    ? tVars('priceForLotFmt', { n, min, max: MARKET_MAX_PRICE })
    : tVars('priceForOneFmt', { min, max: MARKET_MAX_PRICE });
  input.min = min;
}

function _pickMarketSellItem(idx) {
  _marketSellPick = idx;
  _renderMarketPickGrid();
  const it = player.inventory[idx];
  const box = document.getElementById('market-sell-selected');
  const confirmWrap = document.getElementById('market-sell-confirm');
  const qtyRow = document.getElementById('market-qty-row');
  if (!it || !box || !confirmWrap) return;
  const rc = RARITY_COLOR[it.rarity] || '#aea599';
  const have = it.qty || 1;
  const stackable = _isStackable(it) && have > 1;
  box.innerHTML = `<div class="market-row-icon" style="width:40px;height:40px">${_itemIcon(it, 28)}</div>
    <div><div style="font-weight:700;color:${rc}">${it.name}${it.enhance ? ' +' + it.enhance : ''}</div>
    <div style="font-size:11px;color:#a3957c;margin-top:2px">${statStr(it) || (have > 1 ? tVars('youHaveFmt', { n: have }) : '')}</div></div>`;
  confirmWrap.style.display = 'block';
  if (qtyRow) {
    qtyRow.style.display = stackable ? 'block' : 'none';
    if (stackable) {
      const qtyInput = document.getElementById('market-qty-input');
      // ── типове значення — ОДНА штука ────────────────────────────────────
      // Стояв увесь стак, і це було не «зручно за замовчуванням», а пастка:
      // єдиний спосіб продати 10 ключів із 300 — помітити крихітне поле й
      // переписати в ньому число, а промах коштував усього стака. Просили
      // рівно це: «треба щоб можна було вибрати скільки штук предмета ти
      // продаєш, по дефолту 1».
      //
      // Максимум лишається підказкою в підписі: поле на 1 без «макс. 296»
      // не каже, до скільки його взагалі можна підняти.
      if (qtyInput) { qtyInput.max = have; qtyInput.value = 1; }
      const qtyLabel = document.getElementById('market-qty-label');
      if (qtyLabel) qtyLabel.textContent = tVars('quantityMaxFmt', { n: have });
    }
  }
  _updateMarketPriceHint();
  _updateMarketFeePreview();
}

function _clampMarketQtyInput() {
  const idx = _marketSellPick;
  const it  = idx !== null && player ? player.inventory[idx] : null;
  const input = document.getElementById('market-qty-input');
  if (!it || !input) return;
  const have = it.qty || 1;
  let v = Math.floor(Number(input.value));
  if (!Number.isFinite(v) || v < 1) v = 1;
  if (v > have) v = have;
  input.value = v;
  _updateMarketPriceHint();
  _updateMarketFeePreview();
}

function _updateMarketFeePreview() {
  const el    = document.getElementById('market-fee-preview');
  const input = document.getElementById('market-price-input');
  if (!el || !input) return;
  const min = _currentMarketMinPrice();
  const p = Number(input.value);
  if (!Number.isFinite(p) || p < min || p > MARKET_MAX_PRICE) {
    el.textContent = tVars('priceRangeFmt', { min, max: MARKET_MAX_PRICE });
    el.style.color = '#ee6676';
    return;
  }
  const payout = p * (1 - MARKET_FEE_PCT);
  el.textContent = tVars('feePreviewFmt', { n: payout.toFixed(2) });
  el.style.color = '#a3957c';
}

function _setSellPickerBusy(busy) {
  const btn = document.getElementById('market-confirm-btn');
  if (btn) { btn.disabled = busy; btn.style.opacity = busy ? '0.5' : '1'; btn.textContent = busy ? t('listingBusyLbl') : t('listForSaleBtn'); }
}

function _confirmMarketList() {
  if (_marketSellPick === null || !player || _pendingSellItem) return;
  const priceInput = document.getElementById('market-price-input');
  const p = Number(priceInput?.value);
  const minPrice = _currentMarketMinPrice();
  if (!Number.isFinite(p) || p < minPrice || p > MARKET_MAX_PRICE) {
    _marketToast(tVars('priceRangeFmt', { min: minPrice, max: MARKET_MAX_PRICE }), 'err');
    return;
  }
  const idx = _marketSellPick;
  const it  = player.inventory[idx];
  if (!it) return;
  // Bail out before touching the inventory if there's no connection: the
  // splice below is optimistic and is only ever rolled back by a
  // marketListError from the server, so emitting into a dead socket left the
  // item removed from the inventory with no listing and no error to undo it.
  if (!netIsLive()) {
    _marketToast(t('noServerConn'), 'err');
    return;
  }
  // No optimistic removal. The item leaves on the inventorySync the server
  // sends once the listing is actually created — the inventory is a projection
  // of the server's copy now, and editing it here re-creates the second copy
  // the whole change was about.
  //
  // It also removed the failure mode this used to have: the rollback lived in
  // the marketListError handler, so anything that stopped that reply from
  // arriving — a thrown handler, a dropped connection — took the item off the
  // player's screen permanently, with no way to get it back but a reload.
  //
  // The save flush is gone with it: it existed to push a client-side inventory
  // to the server before the ownership check, and the server has not read the
  // client's inventory for some time.
  // Кількість береться тією ж функцією, що й підлога ціни, — інакше вони
  // розходяться, і гравець платить за перевірку однією кількістю, а надсилає
  // іншу. Обрізання по `have` лишається: сервер усе одно перерахує, скільки
  // штук у гравця насправді (market.list), але надсилати завідомо неможливе
  // число означає віддати гравцеві помилку замість лота.
  const have = it.qty || 1;
  let itemSnapshot = it;
  if (_isStackable(it) && have > 1) {
    itemSnapshot = { ...it, qty: Math.min(_currentMarketQty(), have) };
  }
  _pendingSellItem = { item: itemSnapshot };
  _setSellPickerBusy(true);
  netMarketList(itemSnapshot, Math.round(p * 100) / 100);
}

// ── Server event handlers (called from network.js) ───────────────────────────
// ── a lot names an item; the catalog says what it looks like ────────────────
// The server sends id, enhance, qty, name, rarity and slot — the identity and
// nothing else. The renderer wants the picture (`img`/`icon`) and the stat
// line, which are catalog facts this client already holds, and without them
// every lot on the market drew the same grey weapon glyph with a blank
// subtitle whatever it actually was.
//
// Enriched exactly as the inventory is (_rebuildFromCatalog, js/player.js), so
// a sword looks the same in a lot as it does in the bag. Sending the fields
// from the server instead would put a second copy of the catalog on the wire
// for every browse.
function _marketEnrich(listings) {
  if (!Array.isArray(listings)) return [];
  if (typeof _rebuildFromCatalog !== 'function') return listings;
  return listings.map(l => (l && l.item ? { ...l, item: _rebuildFromCatalog(l.item) || l.item } : l));
}

function onMarketBrowseData(listings) {
  _marketLots = _marketEnrich(listings);
  _marketLoaded.lots = true;
  if (_marketTab === 'lots') _renderMarketBody();
}
function onMarketMyListingsData(listings) {
  _marketMine = _marketEnrich(listings);
  _marketLoaded.mine = true;
  if (_marketTab === 'mine') _renderMarketBody();
}
function onMarketHistoryData(entries) {
  _marketHist = _marketEnrich(entries);
  _marketLoaded.history = true;
  if (_marketTab === 'history') _renderMarketBody();
}
function onMarketListed(listing) {
  _pendingSellItem = null;
  closeMarketSellPicker();
  // ── ЧЕРЕЗ _marketEnrich, як і всі інші три списки ────────────────────────
  // Сервер надсилає лише тотожність предмета (id/enhance/qty/name/rarity/slot)
  // — картинки в ній немає й ніколи не було, її дістає з каталогу вже клієнт.
  // Три списки, що приходять із сервера, проходять через _marketEnrich; цей
  // один рядок — ні, і тому щойно виставлений лот малювався запасним значком
  // _itemIcon: `iconHTML('weapon')`, тобто діагональна стрілка вправо-вгору.
  // Рівно те, що й побачив гравець: «вони без нормальної аватарки, а стрілка
  // якась замість неї». Варто було перемкнутися на іншу вкладку й назад —
  // список перечитувався через mine() і картинка з'являлася, що й ховало
  // причину: сервер надсилає те саме в обох випадках, різниця тільки тут.
  _marketMine.unshift(_marketEnrich([listing])[0]);
  if (_marketTab === 'mine') _renderMarketBody();
  netSaveProgressNow();
  _marketToast(tVars('listedForFmt', { name: listing.item?.name || '', price: listing.price }), 'ok');
}
function onMarketCancelled(listingId, item, delivered) {
  _marketMine = _marketMine.filter(l => l.id !== listingId);
  // The server owns the return: it puts the item back and its inventorySync
  // has already arrived, so it is in player.inventory right now. delivered:
  // false means it had no room — the listing stays put rather than the item
  // being conjured here, which the save path would reject anyway.
  updateInvUI();
  if (_marketTab === 'mine') _renderMarketBody();
  if (item && !delivered) {
    _marketToast(t('invFullItemLostToast'), 'err');
    return;
  }
  netSaveProgressNow();
  _marketToast(t('listingCancelledToast'), 'ok');
}
function onMarketBought(listingId, item, delivered) {
  _marketLots = _marketLots.filter(l => l.id !== listingId);
  // Already in player.inventory via the inventorySync that came with this
  // purchase — the server owns the grant. delivered:false means it could not
  // hand it over; forging it here is exactly what the save path now rejects.
  if (item && !delivered) {
    _marketToast(t('invFullItemLostToast'), 'err');
  }
  updateInvUI();
  if (_marketTab === 'lots') _renderMarketBody();
  netSaveProgressNow();
  _marketToast(tVars('boughtItemToast', { name: `${item?.name || ''}${item?.qty > 1 ? ' ×' + item.qty : ''}` }), 'ok');
}
function onMarketSold(data) {
  // The item comes across as a catalog reference (id/qty/enhance), the same
  // shape the buy toast resolves — so the name is looked up the same way
  // rather than expected pre-rendered.
  const it = data.item ? itemCatalogBase(data.item.id) : null;
  const nm = (it && it.name) || (data.item && data.item.id) || '';
  const qty = data.item && data.item.qty > 1 ? ' \u00d7' + data.item.qty : '';
  _marketToast(tVars('soldItemToast', {
    name: nm + qty,
    price: Number(data.price || 0).toFixed(2),
    payout: (data.payout || 0).toFixed(2),
  }), 'ok');
  const panel = document.getElementById('market-panel');
  if (_marketTab === 'mine' && panel && panel.style.display !== 'none') netMarketMyListings();
}
function onMarketError(msg) {
  _marketToast(msg || t('genericErrorLbl'), 'err');
}
// Nothing is restored locally any more, in either case. The item never left
// the local inventory to begin with — it leaves on the server's inventorySync
// — so both of these only have to stop the spinner and say what happened.
function onMarketListError(msg) {
  if (_clearPendingSell()) _marketToast(msg || t('genericErrorLbl'), 'err');
}
// Called when the socket drops while a marketList request is in flight
// (js/network.js's 'disconnect' handler). It says nothing about whether the
// request landed: the server creates the listing and persists the removal
// before it answers, so a drop in the round trip can just as easily mean
// "already sold" as "never arrived".
//
// It used to guess "never arrived" and put the item back, and when the guess
// was wrong the item existed twice over. There is no guess left to make: the
// server pushes an authoritative inventorySync on rejoin (see the end of
// selectChar, server/index.js) and that is the answer.
function onMarketConnectionLost() {
  if (_clearPendingSell()) _marketToast(t('noServerConn'), 'err');
}
// Shared by both handlers above. Returns true if there was a pending sell at
// all — which is what decides whether a toast is warranted.
function _clearPendingSell() {
  if (!_pendingSellItem) return false;
  _pendingSellItem = null;
  _setSellPickerBusy(false);
  return true;
}

// ─────────────────────────────────────────────────────────
//  GRAM SHOP PANEL
// ─────────────────────────────────────────────────────────
// Every package sells at its own nominal price — the 30% discount that used
// to apply here (and the per-package noDiscount flag that opted specific
// packs out of it) has been removed entirely. server/shop.js's own
// pkgPrice(pkg) is what actually gets charged; this copy only decides what
// to show/gate on.
function pkgPrice(pkg) { return pkg.gram; }
// Plain price line for the shop cards and confirm modals below — no
// strikethrough, no discount badge.
function packPriceHtml(gram, color) {
  return `<span style="color:${color || '#8bd66a'}">${gram} GRAM</span>`;
}
const _GRAM_SHOP_PKGS_UI = [
  // Сезонный билет — no items, a status flag (gramShopBuy's own seasonTicket
  // branch): x2 xp, +30% bonus-loot re-roll chance, +10% Liberty drop chance,
  // for as long as the current season is running. Own reward-row rendering
  // in _shopExtraRewardRows (pkg.seasonTicket branch) since none of the
  // usual reward kinds (armor/weapon/potions/...) apply.
  { id:'season_ticket', gram:15, get label() { return t('seasonTicketShopLbl'); }, color:'#ffcf56', seasonTicket:true },
  { id:'pkg1',   gram:1,   get label() { return t('gramPkgLabel_pkg1'); },   gold:10000,  potions:2,  armor:null,       weapon:null,       bonusSP:0,  color:'#a3957c', skillBooks:null },
  { id:'pkg5',   gram:5,   get label() { return t('gramPkgLabel_pkg5'); },   gold:5000,   potions:10, armor:'Uncommon', weapon:'Uncommon', bonusSP:0,  color:'#89ba5f', skillBooks:{ random:1 } },
  { id:'pkg10',  gram:20,  get label() { return t('gramPkgLabel_pkg10'); },  gold:7000,   potions:20, armor:'Uncommon', weapon:'Uncommon', bonusSP:1,  color:'#eab65d', skillBooks:{ random:5 }, enhance:5, nexum:500 },
  { id:'pkg50',  gram:100, get label() { return t('gramPkgLabel_pkg50'); },  gold:50000,  potions:50, armor:'Rare',     weapon:'Rare',     bonusSP:5,  color:'#e5a546', skillBooks:{ each:4 },  boxes:{ box_rare:5 },  enhance:3, nexum:4000 },
  { id:'pkg100', gram:180, get label() { return t('gramPkgLabel_pkg100'); }, gold:100000, potions:100,armor:'Rare',     weapon:'Rare',     bonusSP:10, color:'#eb4e61', skillBooks:{ each:12 }, boxes:{ box_rare:15 }, enhance:8, nexum:10000 },
  // pkg300 («Эпический» / «+Pack») стоял здесь верхним тиром обычной
  // вкладки, потом уехал на собственную кнопку HUD. Товара больше нет вовсе:
  // ни кнопки, ни карточки, ни строки в server/shop.js — купить его нельзя
  // ниоткуда.
  // Усиление tab — pure material packs (the empowerment itself still happens
  // from the Персонаж → Усиление panel, see updateEmpowerUI; these only grant
  // the listed items). Зеркало серверного списка в server/shop.js — содержимое
  // обязано совпадать до предмета, иначе витрина обещает одно, а приходит
  // другое.
  { id:'rmat1', gram:25, get label() { return t('empowerMatPkgLabel_rmat1'); }, color:'#e5aa52', shopTab:'empower',
    boxes:{ box_uncommon:10, box_rare:5  }, stones:{ rece:100, recl:30,  norm_stone:20  } },
  { id:'rmat2', gram:40, get label() { return t('empowerMatPkgLabel_rmat2'); }, color:'#e5aa52', shopTab:'empower',
    boxes:{ box_uncommon:20, box_rare:10 }, stones:{ rece:200, recl:60,  norm_stone:40  } },
  { id:'rmat3', gram:80, get label() { return t('empowerMatPkgLabel_rmat3'); }, color:'#e5aa52', shopTab:'empower',
    boxes:{ box_uncommon:50, box_rare:25 }, stones:{ rece:500, recl:150, norm_stone:100 } },
];

const _STONE_IMG = { norm_stone: '/images/norm.png', bless_stone: '/images/bless.png' };
// pkg.stones isn't stone-specific — server/index.js's grant code resolves
// any CRAFT_MATS id through it, which is how rece/recl (rmat1-3) land there
// too. _STONE_IMG only covers the two actual stones, so fall back to
// CRAFT_MATS' own img/name for everything else.
function _stoneOrMatImg(id) {
  return _STONE_IMG[id] || (CRAFT_MATS.find(m => m.id === id) || {}).img || '';
}
function _stoneOrMatLabel(id) {
  if (id === 'bless_stone') return t('blessStoneLbl');
  if (id === 'norm_stone') return t('normStoneLbl');
  return (CRAFT_MATS.find(m => m.id === id) || {}).name || id;
}

function showGramShopBtn() {
  const btn = document.getElementById('gram-shop-btn');
  if (btn) { btn.dataset.shown = '1'; btn.style.display = _hudSubBtnDisplay(); _positionGramShopBtn(); }
}

// ─────────────────────────────────────────────────────────
//  "Питомцы" TAB PACKAGES (GRAM shop) — pet+cloak+artifact bundles. Mirror
//  of the same-id entries in server/index.js's _GRAM_SHOP_PKGS (that's what
//  actually validates and grants them — this copy only draws the cards).
//  Bought through gramShopBuy like any other GRAM package — own render/
//  picker functions below instead of reusing _gramShopPkgHtml/
//  openGramShopConfirm only because the reward kinds (petChoice/classCloak/
//  classArtifact) don't fit that card's layout.
// ─────────────────────────────────────────────────────────
function _packNLabel(n) { return tVars('packNFmt', { n }); }

const _SPECIAL_PET_PKGS_UI = [
  { id:'petpkg1', gram:50,  get label() { return _packNLabel(1); }, petChoice:'common',   classCloak:'common',   classArtifact:'common',   enhance:8,  color:'#9c9086' },
  { id:'petpkg2', gram:150, get label() { return _packNLabel(2); }, petChoice:'uncommon', classCloak:'uncommon', classArtifact:'uncommon', enhance:10, color:'#6f9c4a' },
  { id:'petpkg3', gram:250, get label() { return _packNLabel(3); }, petChoice:'rare',     classCloak:'uncommon', classArtifact:'uncommon', enhance:10, color:'#4a7bab' },
];

// Shared reward-icon row bits (armor set icons, weapon prefix map, the gold
// coin icon) used by _gramShopPkgHtml below.
const _SHOP_ARMOR_ICONS = {
  common:   ['arm/ch.png','arm/ct.png','arm/cg.png','arm/cb.png','acs/cr.png','acs/cp.png'],
  uncommon: ['arm/uh.png','arm/ut.png','arm/ug.png','arm/ub.png','acs/ur.png','acs/up.png'],
  rare:     ['arm/rh.png','arm/rt.png','arm/rg.png','arm/rb.png','acs/rr.png','acs/rp.png'],
  epic:     ['arm/eh.png','arm/et.png','arm/eg.png','arm/eb.png','acs/er.png','acs/ep.png'],
};
const _SHOP_WEP_PFX_MAP = { common:'c', uncommon:'u', rare:'r', epic:'e' };
const _SHOP_POTION_NAMES = ['hp','exp','gold','regen','atkspeed','atk'];
const _shopCoinUri = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23f1c40f' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='9'/><path d='M12 7v10'/><path d='M15 9.5a3 3 0 0 0-6 0c0 1.5 1 2.2 3 3 2 .8 3 1.5 3 3a3 3 0 0 1-6 0'/></svg>`;
const _shopSpUri = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23c084fc' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polygon points='12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26'/></svg>`;
const _shopBookUri = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23e3941d' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17H6.5A2.5 2.5 0 0 0 4 21.5'/><path d='M4 4.5v17'/><line x1='9' y1='7' x2='16' y2='7'/><line x1='9' y1='11' x2='16' y2='11'/></svg>`;

// Renders the armor/weapon/bonusSP/nexum/potions rows any pkg carries —
// used by _gramShopPkgHtml below.
function _shopExtraRewardRows(pkg, ri) {
  let rows = '';
  if (pkg.potions) {
    rows += _SHOP_POTION_NAMES.map(p => ri(`/images/potion/${p}.png`, `×${pkg.potions}`, '')).join('');
  }
  if (pkg.armor) {
    const key = pkg.armor.toLowerCase();
    const icons = _SHOP_ARMOR_ICONS[key] || [];
    const enhLbl = pkg.enhance ? `+${pkg.enhance}` : '';
    rows += icons.map(i => ri(`/images/${i}`, enhLbl, key)).join('');
  }
  if (pkg.weapon) {
    const key = pkg.weapon.toLowerCase();
    const pfx = _SHOP_WEP_PFX_MAP[key] || 'c';
    const wepSfx = { deathknight:'k', lev:'t', ranger:'b', mage:'s', warlock:'s' }[player?.type] || 't';
    rows += ri(`/images/wep/${pfx}${wepSfx}.png`, pkg.enhance ? `+${pkg.enhance}` : '', key);
  }
  if (pkg.bonusSP) rows += ri(_shopSpUri, `+${pkg.bonusSP} ${t('bonusSpSuffixShort')}`, 'epic');
  if (pkg.nexum) rows += ri('/images/nexum-coin_v2.png', `+${pkg.nexum} Liberty`, 'epic');
  // Сезонный билет — a status effect, not a granted item: just its own name
  // and icon here, tap it for the full breakdown (_openSeasonTicketInfo).
  if (pkg.seasonTicket) {
    rows += `<div class="vip-ri vip-ri-gold" style="cursor:pointer" onclick="event.stopPropagation();_openSeasonTicketInfo()">
      <img class="vip-ri-img" src="/images/season_ticket.png">
      <span class="vip-ri-label">${t('seasonTicketShopLbl')}</span>
    </div>`;
  }
  return rows;
}

// Full breakdown for the Сезонный билет row above — the card itself only
// shows the name/icon, tapping it opens this. Point VALUES come straight off
// the shared SEASON_TICKET_* constants (shared/definitions.js), never
// duplicated here; the duration line reuses the same seasonEndsIn/seasonEnded
// text and countdown the Сезон panel's own info tab shows (_seasonInfoHTML).
function _openSeasonTicketInfo() {
  // _seasonState only ever gets refreshed by a seasonSync round trip (see
  // openSeasonPanel) — nothing pushes it at login. A player who opens this
  // modal without having opened the Сезон panel first this session was still
  // looking at state.js's default { active:false, endAt:0 }, which read as
  // "season ended" even mid-season. Ask for a fresh one every time this
  // opens; onSeasonState re-renders (without re-syncing) once it lands, if
  // the modal is still up.
  if (typeof netSeasonSync === 'function') netSeasonSync();
  _renderSeasonTicketInfo();
}

function _renderSeasonTicketInfo() {
  const existing = document.getElementById('season-ticket-info-ov');
  if (existing) existing.remove();
  const st = _seasonState || {};
  const left = Math.max(0, (st.endAt || 0) - Date.now());
  const durationLine = (st.active && left > 0) ? tVars('seasonEndsIn', { t: _fmtEventEta(left) }) : t('seasonEnded');
  const ov = document.createElement('div');
  ov.className = 'market-modal-overlay';
  ov.id = 'season-ticket-info-ov';
  ov.onclick = () => ov.remove();
  ov.innerHTML = `
    <div class="market-modal-sheet" onclick="event.stopPropagation()">
      <div style="display:flex;align-items:center;margin-bottom:14px">
        <img src="/images/season_ticket.png" width="40" height="40" style="margin-right:10px;border-radius:6px">
        <div style="font-size:16px;font-weight:800;color:#ffcf56">${t('seasonTicketShopLbl')}</div>
        <button onclick="document.getElementById('season-ticket-info-ov').remove()" style="margin-left:auto;width:28px;height:28px;border:none;border-radius:50%;background:rgba(209,204,197,.08);color:#968a7a;cursor:pointer">✕</button>
      </div>
      <div style="background:rgba(209,204,197,.04);border-radius:10px;padding:12px 14px;margin-bottom:14px;font-size:13px;line-height:1.9;color:#c5bfb7">
        <div>${tVars('seasonTicketXpRowFmt', { n: SEASON_TICKET_XP_PCT })}</div>
        <div>${tVars('seasonTicketDropRowFmt', { n: SEASON_TICKET_DROP_PCT })}</div>
        <div>${tVars('seasonTicketLibertyRowFmt', { n: SEASON_TICKET_LIBERTY_PCT })}</div>
      </div>
      <div style="font-size:13px;color:#7ee0c0;text-align:center;font-weight:700">${durationLine}</div>
    </div>`;
  document.body.appendChild(ov);
}

// ─────────────────────────────────────────────────────────
//  PET+CLOAK+ARTIFACT PACKAGES (petpkg1/2/3, mirror of server/index.js's
//  _GRAM_SHOP_PKGS entries of the same id). Bought through gramShopBuy like
//  any other GRAM package — petChoice/classCloak/classArtifact/enhance are
//  already fully supported there — but with their own card/picker instead
//  of reusing _gramShopPkgHtml/openGramShopConfirm (built for a different
//  reward-row layout).
// ─────────────────────────────────────────────────────────
// petChoice/classCloak/classArtifact all resolve to a single icon each (a
// sample pet of the right rarity for the picker preview; the buyer's own
// class's cloak/artifact), all sharing pkg.enhance.
function _petCloakArtifactRows(pkg, ri) {
  const enhLbl = pkg.enhance ? `+${pkg.enhance}` : '';
  const cls = player?.type;
  const cloak = (cls && pkg.classCloak) ? ITEM_DEF.find(d => d.slot === 'cloak' && d.rarity === pkg.classCloak && d.forClass && d.forClass.includes(cls)) : null;
  const artifact = (cls && pkg.classArtifact) ? ITEM_DEF.find(d => d.slot === 'artifact' && d.rarity === pkg.classArtifact && d.forClass && d.forClass.includes(cls)) : null;
  const petSample = pkg.petChoice ? ITEM_DEF.find(d => d.slot === 'pet' && d.rarity === pkg.petChoice) : null;
  return (petSample ? ri(petSample.img, `${t('petChoiceLbl')} ${enhLbl}`, pkg.petChoice) : '')
    + (cloak ? ri(cloak.img, enhLbl, pkg.classCloak) : '')
    + (artifact ? ri(artifact.img, enhLbl, pkg.classArtifact) : '');
}

function _specialPetPkgHtml(pkg, bal) {
  const canAfford = bal >= pkgPrice(pkg);
  const rows = _petCloakArtifactRows(pkg, ri);

  return `<div class="gram-shop-card" style="border-color:${pkg.color}44">
    <div class="gram-shop-card-head">
      <div>
        <div class="gram-shop-title" style="color:${pkg.color}">${pkg.label}</div>
        <div class="gram-shop-price">${packPriceHtml(pkg.gram)}</div>
      </div>
      <button class="gram-shop-buy-btn${canAfford ? '' : ' disabled'}"
        style="border-color:${pkg.color};color:${canAfford ? pkg.color : '#645f57'}"
        onclick="${canAfford ? `openSpecialPetPickerModal('${pkg.id}')` : ''}">
        ${canAfford ? t('specialChooseBtn') : t('notEnoughBtn')}
      </button>
    </div>
    <div class="vip-items-row">${rows}</div>
  </div>`;
}

// Which pet id the current picker modal has selected — reset each time it
// opens, consumed by _confirmPetPkgBuy. Mirrors _specialPicker's shape.
let _petPicker = null;

function openSpecialPetPickerModal(pkgId) {
  const pkg = _SPECIAL_PET_PKGS_UI.find(p => p.id === pkgId);
  if (!pkg || !player) return;
  const bal = window._gramBalance || 0;
  if (bal < pkgPrice(pkg)) return;
  const pets = ITEM_DEF.filter(d => d.slot === 'pet' && d.rarity === pkg.petChoice);
  if (!pets.length) return;
  _petPicker = { pkgId, petId: pets[0].id };
  const existing = document.getElementById('pet-picker-ov');
  if (existing) existing.remove();
  const ov = document.createElement('div');
  ov.className = 'market-modal-overlay';
  ov.id = 'pet-picker-ov';
  ov.onclick = () => { _petPicker = null; ov.remove(); };
  document.body.appendChild(ov);
  _renderPetPicker();
}

function _renderPetPicker() {
  const ov = document.getElementById('pet-picker-ov');
  if (!ov || !_petPicker || !player) return;
  const pkg = _SPECIAL_PET_PKGS_UI.find(p => p.id === _petPicker.pkgId);
  if (!pkg) return;
  const pets = ITEM_DEF.filter(d => d.slot === 'pet' && d.rarity === pkg.petChoice);

  const rows = pets.map(p => {
    const sel = p.id === _petPicker.petId;
    return `<div onclick="event.stopPropagation();_petPickerSelect('${p.id}')" style="
      display:flex;align-items:center;gap:10px;padding:8px;border-radius:10px;cursor:pointer;margin-bottom:6px;
      border:2px solid ${sel ? pkg.color : 'rgba(209,204,197,0.1)'};
      background:${sel ? pkg.color + '22' : 'rgba(209,204,197,0.04)'};
    ">
      <img src="${p.img}" width="36" height="36" style="image-rendering:pixelated">
      <div style="font-weight:700;color:${sel ? pkg.color : '#e8ddc9'}">${p.name}</div>
    </div>`;
  }).join('');

  ov.innerHTML = `
    <div class="market-modal-sheet" onclick="event.stopPropagation()">
      <div style="display:flex;align-items:center;margin-bottom:10px">
        <div style="font-size:16px;font-weight:800;color:${pkg.color}">${pkg.label} — ${packPriceHtml(pkg.gram, pkg.color)}</div>
        <button onclick="_petPicker=null;document.getElementById('pet-picker-ov').remove()" style="margin-left:auto;width:28px;height:28px;border:none;border-radius:50%;background:rgba(209,204,197,.08);color:#968a7a;cursor:pointer">✕</button>
      </div>
      <div style="font-size:12px;color:#b2a288;margin-bottom:8px">${t('petPickerHint')}</div>
      <div style="margin-bottom:10px">${rows}</div>
      <button class="gram-btn gram-btn-green" style="width:100%;padding:13px"
        onclick="_confirmPetPkgBuy()">${tVars('buyForFmt', { price: pkgPrice(pkg) })}</button>
    </div>`;
}

function _petPickerSelect(petId) {
  if (!_petPicker) return;
  _petPicker.petId = petId;
  _renderPetPicker();
}

function _confirmPetPkgBuy() {
  if (!_petPicker) return;
  const { pkgId, petId } = _petPicker;
  const ov = document.getElementById('pet-picker-ov');
  if (ov) ov.remove();
  _petPicker = null;
  if (typeof netGramShopBuy === 'function') netGramShopBuy(pkgId, petId);
}

function openGramShopPanel() {
  const panel = document.getElementById('gram-shop-panel');
  if (!panel) return;
  panel.style.display = 'flex';
  _renderGramShopPanel();
}

function closeGramShopPanel() {
  const panel = document.getElementById('gram-shop-panel');
  if (panel) panel.style.display = 'none';
}

// "Паки" (the regular _GRAM_SHOP_PKGS_UI entries with no shopTab tag —
// pkg1's "Базовый"/pkg10's "Стандарт" etc.) vs "Питомцы" (pet+cloak+artifact
// bundles, _SPECIAL_PET_PKGS_UI) vs "Усиление" (rmat1-3 — the same
// _GRAM_SHOP_PKGS_UI array, tagged shopTab:'empower' — pure material packs
// that only grant items; the empowerment itself is still done from the
// Персонаж → Усиление panel, see updateEmpowerUI above).
let _shopTab = 'packs';

function switchShopTab(tab) {
  _shopTab = tab;
  document.querySelectorAll('#gram-shop-panel .rating-tab').forEach(b => b.classList.remove('active'));
  document.getElementById('shtab-' + tab)?.classList.add('active');
  _renderGramShopPanel();
}

function _renderGramShopPanel() {
  const el = document.getElementById('gram-shop-body');
  if (!el) return;
  const bal = window._gramBalance || 0;
  const balBar = `<div style="background:rgba(230,148,25,0.08);border:1px solid rgba(230,148,25,0.2);border-radius:10px;padding:10px 14px;margin-bottom:14px;font-size:13px;color:#e6af5e;text-align:center">
      ${tVars('gramShopBalanceFmt', { bal: `<b>${bal.toFixed(7)}</b>` })}
    </div>`;
  let body;
  if (_shopTab === 'empower') {
    body = _GRAM_SHOP_PKGS_UI.filter(pkg => pkg.shopTab === 'empower').map(pkg => _gramShopPkgHtml(pkg, bal)).join('');
  } else if (_shopTab === 'pets') {
    body = _SPECIAL_PET_PKGS_UI.map(pkg => _specialPetPkgHtml(pkg, bal)).join('');
  } else {
    body = _GRAM_SHOP_PKGS_UI.filter(pkg => !pkg.shopTab).map(pkg => _gramShopPkgHtml(pkg, bal)).join('');
  }
  el.innerHTML = balBar + body;
}

function _gramShopPkgHtml(pkg, bal) {
  // One per account — a second "purchase" would just spend GRAM for no
  // additional effect (server refuses it outright, see gramShopBuy).
  const alreadyOwned = !!(pkg.seasonTicket && _seasonTicketActive);
  const canAfford = !alreadyOwned && bal >= pkgPrice(pkg);
  const kGold = pkg.gold >= 1000 ? (pkg.gold / 1000).toFixed(0) + 'k' : pkg.gold;

  // same ri() pattern as VIP

  // gold (guarded, not assumed — kept defensive for any future gold-free
  // package), then everything _shopExtraRewardRows also renders
  // (potions/armor/weapon/bonusSP/nexum), then this shop's own two extra
  // kinds (skillBooks/boxes).
  let rows = pkg.gold ? ri(_shopCoinUri, kGold + ' ' + t('gramShopGoldSuffix'), 'gold') : '';
  rows += _shopExtraRewardRows(pkg, ri);

  // skill books — for the buyer's own class (see _skillBooksLabel below)
  if (pkg.skillBooks) {
    rows += ri(_shopBookUri, _skillBooksLabel(pkg.skillBooks), 'epic');
  }

  // boxes (BOX_DEF — see _boxesLabel below)
  if (pkg.boxes) {
    rows += _boxesLabel(pkg.boxes).map(({ img, label, cls }) => ri(img, label, cls)).join('');
  }

  // Enchant stones (pkg300) / arbitrary materials (rmat1-3 — rece/recl)
  if (pkg.stones) {
    rows += Object.entries(pkg.stones).map(([id, qty]) => ri(_stoneOrMatImg(id), `×${qty}`, '')).join('');
  }

  return `<div class="gram-shop-card" style="border-color:${pkg.color}44">
    <div class="gram-shop-card-head">
      <div>
        <div class="gram-shop-title" style="color:${pkg.color}">${pkg.label}</div>
        <div class="gram-shop-price">${packPriceHtml(pkg.gram)}</div>
      </div>
      <button class="gram-shop-buy-btn${canAfford ? '' : ' disabled'}"
        style="border-color:${pkg.color};color:${canAfford ? pkg.color : '#645f57'}"
        onclick="${canAfford ? `openGramShopConfirm('${pkg.id}')` : ''}">
        ${alreadyOwned ? t('seasonTicketOwnedBtn') : canAfford ? t('affordableBuyBtn') : t('notEnoughBtn')}
      </button>
    </div>
    <div class="vip-items-row">${rows}</div>
  </div>`;
}

// Shared between the shop card preview and the confirm modal. The icon row
// has no room for "по 12 каждой книги навыка (все 4)" — just the total count
// (each × the 4 class books, or random's own count) reads at a glance.
function _skillBooksLabel(skillBooks) {
  if (!skillBooks) return '';
  const total = skillBooks.each ? skillBooks.each * 4 : (skillBooks.random || 0);
  return tVars('skillBooksTotalLbl', { n: total });
}

// Shared between the shop card preview and the confirm modal — mirrors
// server/index.js's pkg.boxes handling in the gramShopBuy handler.
const _BOX_IMG = { box_uncommon: '/images/material/boxu.png', box_rare: '/images/material/boxr.png' };
const _BOX_CLS = { box_uncommon: 'uncommon', box_rare: 'rare' };
function _boxesLabel(boxes) {
  return Object.entries(boxes).map(([id, qty]) => ({
    img: _BOX_IMG[id] || '', label: `×${qty}`, cls: _BOX_CLS[id] || '',
  }));
}
function _boxesLine(boxes) {
  return Object.entries(boxes).map(([id, qty]) => {
    const name = id === 'box_rare' ? t('rareBoxesLbl') : t('uncommonBoxesLbl');
    return `${qty}× ${name}`;
  }).join(', ');
}

function openGramShopConfirm(pkgId) {
  const pkg = _GRAM_SHOP_PKGS_UI.find(p => p.id === pkgId);
  if (!pkg) return;
  const bal = window._gramBalance || 0;
  const price = pkgPrice(pkg);
  const canAfford = bal >= price;
  const existing = document.getElementById('gram-shop-confirm-ov');
  if (existing) existing.remove();
  const kGold = pkg.gold >= 1000 ? (pkg.gold / 1000).toFixed(0) + 'k' : pkg.gold;
  const enhSuffix  = pkg.enhance ? ` +${pkg.enhance}` : '';
  // Ветка `pkg.perks` жила здесь ради одного товара — «+Pack», у которого
  // сверх игровых наград шли внеигровые: видеокурс, закрытый чат,
  // консультации. Товара нет, поля perks нет ни у одного пакета, и ветка
  // была бы кодом, который нельзя выполнить.
  let itemsHtml;
  {
    const goldLine   = pkg.gold ? `<div style="color:#c5bfb7">${tVars('goldAmountFmt', { n: kGold })}</div>` : '';
    const potionLine = pkg.potions ? `<div style="color:#c5bfb7">${tVars('eachPotionFmt', { n: pkg.potions })}</div>` : '';
    const armorLine  = pkg.armor  ? `<div style="color:#c5bfb7">${tVars('fullArmorSetFmt', { rarity: pkg.armor })}${enhSuffix}</div>` : '';
    const weaponLine = pkg.weapon ? `<div style="color:#c5bfb7">${tVars('classWeaponFmt', { rarity: pkg.weapon })}${enhSuffix}</div>` : '';
    const spLine     = pkg.bonusSP ? `<div style="color:#c5bfb7">${tVars('bonusSkillPointsFmt', { n: pkg.bonusSP })}</div>` : '';
    const bookLine   = pkg.skillBooks ? `<div style="color:#c5bfb7">• ${_skillBooksLabel(pkg.skillBooks)} ${t('classBooksSuffix')}</div>` : '';
    const boxLine    = pkg.boxes ? `<div style="color:#c5bfb7">• ${_boxesLine(pkg.boxes)}</div>` : '';
    const stoneLine  = pkg.stones ? `<div style="color:#c5bfb7">• ${Object.entries(pkg.stones).map(([id, qty]) => `${qty}× ${_stoneOrMatLabel(id)}`).join(', ')}</div>` : '';
    const nexumLine  = pkg.nexum ? `<div style="color:#6fc7ff">• +${pkg.nexum} Liberty</div>` : '';
    // Own icon rows, same as the shop card — text lines don't fit a status
    // effect as well as the usual granted-item list.
    const ticketRows = pkg.seasonTicket ? `<div class="vip-items-row">${_shopExtraRewardRows(pkg, ri)}</div>` : '';
    itemsHtml = `${goldLine}${potionLine}${armorLine}${weaponLine}${spLine}${bookLine}${boxLine}${stoneLine}${nexumLine}${ticketRows}`;
  }
  const ov = document.createElement('div');
  ov.className = 'market-modal-overlay';
  ov.id = 'gram-shop-confirm-ov';
  ov.onclick = () => ov.remove();
  ov.innerHTML = `
    <div class="market-modal-sheet" onclick="event.stopPropagation()">
      <div style="display:flex;align-items:center;margin-bottom:14px">
        <div style="font-size:16px;font-weight:800;color:${pkg.color}">${pkg.label} — ${packPriceHtml(pkg.gram, pkg.color)}</div>
        <button onclick="document.getElementById('gram-shop-confirm-ov').remove()" style="margin-left:auto;width:28px;height:28px;border:none;border-radius:50%;background:rgba(209,204,197,.08);color:#968a7a;cursor:pointer">✕</button>
      </div>
      <div style="background:rgba(209,204,197,.04);border-radius:10px;padding:12px 14px;margin-bottom:14px;font-size:13px;line-height:1.8">
        ${itemsHtml}
      </div>
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:16px">
        <span style="color:#b2a288">${t('costLbl')}</span>
        <span style="font-weight:700">${packPriceHtml(pkg.gram, pkg.color)}</span>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:16px">
        <span style="color:#b2a288">${t('yourBalanceLbl')}</span>
        <span style="font-weight:700;color:#f5dbae">${bal.toFixed(7)} GRAM</span>
      </div>
      <button class="gram-btn gram-btn-green" style="width:100%;padding:13px${canAfford ? '' : ';opacity:.5;cursor:not-allowed'}"
        onclick="${canAfford ? `_confirmGramShopBuy('${pkgId}')` : ''}">${canAfford ? tVars('buyForFmt', { price }) : t('notEnoughGramLbl')}</button>
    </div>`;
  document.body.appendChild(ov);
}

function _confirmGramShopBuy(pkgId) {
  const ov = document.getElementById('gram-shop-confirm-ov');
  if (ov) ov.remove();
  if (typeof netGramShopBuy === 'function') netGramShopBuy(pkgId);
}

function onGramShopResult(data) {
  window._gramBalance = data.newBalance;
  if (data.nexum != null) window._nexumBalance = data.nexum;
  if (player) {
    // Guarded, like every line under it. An unguarded assignment from a field
    // the server does not send is not a fallback, it is an erasure.
    if (data.gold != null) player.gold = data.gold;
    if (data.items) player.inventory = data.items;
    if (data.bonusSP != null) player.bonusSP = data.bonusSP;
    if (data.nexum != null) player.nexumBalance = data.nexum;
  }
  // VIP arrives on its own event (vipUpdate) right after this one — it was
  // never a field here, so the branch that read it never ran.
  // A gramShopResult for 'season_ticket' only ever arrives on a successful
  // purchase (the server refuses a second one before any GRAM moves), so
  // this is safe to set unconditionally — no separate confirmation needed.
  // The server says so outright now (seasonTicket); the package-id test is
  // kept as the fallback for a client that is one deploy behind.
  if (data.seasonTicket || data.pkgId === 'season_ticket') _seasonTicketActive = true;
  // Ищется только среди живых товаров. Купленный когда-то "+Pack" (pkg300)
  // среди них больше не значится — товар убран целиком, — и его чек честно
  // подпишется общим «Пакет» из packageFallbackLbl, а не именем позиции,
  // которой в игре уже нет.
  const pkg = _GRAM_SHOP_PKGS_UI.find(p => p.id === data.pkgId);
  // Pet+cloak+artifact packages (petpkg1/2/3) — bought through this same
  // handler but shown on the GRAM shop's own Питомцы tab
  // (_SPECIAL_PET_PKGS_UI), so they have no label of their own either.
  const ppkg = pkg ? null : _SPECIAL_PET_PKGS_UI.find(p => p.id === data.pkgId);
  const lbl = pkg ? pkg.label
            : ppkg ? ppkg.label
            : t('packageFallbackLbl');
  _marketToast(tVars('pkgBoughtToast', { lbl }), 'ok');
  // Every package kind above (regular/pet) now renders inside this one
  // panel/tab pair, so a single re-render covers whichever tab is open.
  const panel = document.getElementById('gram-shop-panel');
  if (panel && panel.style.display !== 'none') _renderGramShopPanel();
  // Кошелёк мог остаться открытым за панелью магазина — держим его число
  // в синхроне.
  if (activeTab === 5 && window._profileTab === 'wallet') updateGramUI();
  updateInvUI();
  if (activeTab === 1 && _invTab === 1) updateProfileUI();
  if (activeTab === 1 && _invTab === 0) updateUpgradeUI();
}

function onGramShopError(msg) {
  _marketToast(msg || t('purchaseErrorLbl'), 'err');
}

let _gramTxList = [];
let _refFriendsList = [];
let _pvpHistoryList = [];

function switchProfileTab(tab) {
  window._profileTab = tab;
  document.querySelectorAll('.profile-tab').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('ptab-' + tab);
  if (btn) btn.classList.add('active');
  if (tab === 'wallet') updateGramUI();
  else if (tab === 'lang') _renderLangPicker();
  else if (tab === 'sound') _renderSoundPicker();
  else if (tab === 'history') updatePvpHistoryUI();
  else updateFriendsUI();
}

// ── Sound toggle (Профиль → Звук) ───────────────────────────
function _renderSoundPicker() {
  if (window._profileTab !== 'sound') return;
  const el = document.getElementById('gram-body');
  if (!el || typeof Sound === 'undefined') return;
  const sfxOn = !Sound.muted;
  const bgmOn = typeof Music !== 'undefined' && !Music.muted;
  el.innerHTML = `
    <div class="gram-section-title" style="margin-bottom:10px">${t('bgmSectionTitle')}</div>
    <div class="lang-card-grid">
      <button class="lang-card${bgmOn ? ' active' : ''}" onclick="_setBgmMuted(false)">
        <span class="lang-card-flag">🎵</span>
        <span class="lang-card-name">${t('sfxOnLbl')}</span>
        ${bgmOn ? '<span class="lang-card-check">✓</span>' : ''}
      </button>
      <button class="lang-card${bgmOn ? '' : ' active'}" onclick="_setBgmMuted(true)">
        <span class="lang-card-flag">🔇</span>
        <span class="lang-card-name">${t('sfxOffLbl')}</span>
        ${bgmOn ? '' : '<span class="lang-card-check">✓</span>'}
      </button>
    </div>

    <div class="gram-section-title" style="margin:18px 0 10px">${t('sfxSectionTitle')}</div>
    <div class="lang-card-grid">
      <button class="lang-card${sfxOn ? ' active' : ''}" onclick="_setSfxMuted(false)">
        <span class="lang-card-flag">🔊</span>
        <span class="lang-card-name">${t('sfxOnLbl')}</span>
        ${sfxOn ? '<span class="lang-card-check">✓</span>' : ''}
      </button>
      <button class="lang-card${sfxOn ? '' : ' active'}" onclick="_setSfxMuted(true)">
        <span class="lang-card-flag">🔇</span>
        <span class="lang-card-name">${t('sfxOffLbl')}</span>
        ${sfxOn ? '' : '<span class="lang-card-check">✓</span>'}
      </button>
    </div>
    <div style="font-size:11px;color:#82745b;margin-top:12px;text-align:center">${t('sfxHint')}</div>

    <div class="gram-section-title" style="margin:18px 0 10px">${t('joyAlphaTitle')}</div>
    <div class="joy-alpha-row">
      <input id="joy-alpha" type="range" min="15" max="100" step="5"
             value="${Math.round(joyAlpha() * 100)}"
             oninput="_onJoyAlpha(this.value)" aria-label="${_escAttr(t('joyAlphaTitle'))}">
      <span id="joy-alpha-val" class="joy-alpha-val">${Math.round(joyAlpha() * 100)}%</span>
    </div>
    <div style="font-size:11px;color:#82745b;margin-top:8px;text-align:center">${t('joyAlphaHint')}</div>
  `;
}

// Только число рядом с ползунком, без перерисовки вкладки: перерисовка
// пересоздала бы сам input и увела бы палец с ползунка на первом же
// движении.
function _onJoyAlpha(v) {
  setJoyAlpha(Number(v) / 100);
  const out = document.getElementById('joy-alpha-val');
  if (out) out.textContent = Math.round(joyAlpha() * 100) + '%';
}

function _setSfxMuted(v) {
  if (typeof Sound === 'undefined') return;
  Sound.setMuted(v);
  _renderSoundPicker();
}

function _setBgmMuted(v) {
  if (typeof Music === 'undefined') return;
  Music.setMuted(v);
  _renderSoundPicker();
}

// ── Language picker (Профиль → Язык) ───────────────────────
function _renderLangPicker() {
  if (window._profileTab !== 'lang') return;
  const el = document.getElementById('gram-body');
  if (!el || typeof I18N_LANGS === 'undefined') return;
  const cards = I18N_LANGS.map(l => `
    <button class="lang-card${l.code === currentLang ? ' active' : ''}" onclick="setLang('${l.code}')">
      <span class="lang-card-flag">${l.flag}</span>
      <span class="lang-card-name">${l.native}</span>
      ${l.code === currentLang ? '<span class="lang-card-check">✓</span>' : ''}
    </button>`).join('');
  el.innerHTML = `
    <div class="gram-section-title" style="margin-bottom:10px">${t('langPickerTitle')}</div>
    <div class="lang-card-grid">${cards}</div>
    <div style="font-size:11px;color:#82745b;margin-top:12px;text-align:center">${t('langPickerHint')}</div>
  `;
}

function updateFriendsUI() {
  const el = document.getElementById('gram-body');
  if (!el) return;
  const refLink = window._refLink || '';
  const friends = _refFriendsList;
  const totalBonus = friends.reduce((s, f) => s + (f.bonus || 0), 0);

  el.innerHTML = `
    <div class="ref-card">
      <div class="ref-card-title">${t('refLinkCardTitle')}</div>
      <div class="ref-link-box">
        <span id="ref-link-val" style="flex:1;font-size:12px">${refLink || t('questLoading')}</span>
        <button class="ref-copy-btn" onclick="refCopyLink()">${t('copyBtn')}</button>
      </div>
      <div style="font-size:11px;color:#82745b;margin-top:8px">${tVars('refBonusHintFmt', { pct: '<b style="color:#89ba5f">5%</b>' })}</div>
    </div>

    <div class="ref-stats-row">
      <div class="ref-stat-box">
        <div class="ref-stat-num">${friends.length}</div>
        <div class="ref-stat-lbl">${t('friendsCountLbl')}</div>
      </div>
      <div class="ref-stat-box">
        <div class="ref-stat-num">${totalBonus.toFixed(2)}</div>
        <div class="ref-stat-lbl">${t('gramReceivedLbl')}</div>
      </div>
    </div>

    <div class="gram-section-title" style="margin-bottom:8px">${t('friendsListHdr')}</div>
    <div id="ref-friends-list">
      ${friends.length === 0
        ? `<div class="ref-empty">${t('noFriendsInvitedHint')}<br><span style="font-size:12px">${t('sendLinkHint')}</span></div>`
        : friends.map(f => {
            const init = _escHtml((f.username || '?')[0].toUpperCase());
            return `<div class="ref-friend-row">
              <div class="ref-friend-avatar">${init}</div>
              <div class="ref-friend-name">@${f.username ? _escHtml(f.username) : t('playerFallbackLbl')}</div>
              <div class="ref-friend-bonus">+${(f.bonus || 0).toFixed(2)} GRAM</div>
            </div>`;
          }).join('')
      }
    </div>
  `;

  if (typeof netGetReferrals === 'function') netGetReferrals();
}

function refCopyLink() {
  const link = window._refLink || '';
  if (!link) return;
  navigator.clipboard.writeText(link).then(() => {
    const btn = document.querySelector('.ref-copy-btn');
    if (btn) { const old = btn.textContent; btn.textContent = t('copiedLbl'); btn.style.color = '#89ba5f'; setTimeout(() => { btn.textContent = old; btn.style.color = ''; }, 2000); }
  }).catch(() => {});
}

function onRefData(data) {
  _refFriendsList = data.friends || [];
  window._refLink = data.refLink || '';
  if (window._profileTab === 'friends') updateFriendsUI();
}

function onFriendJoined(data) {
  _refFriendsList.unshift({ username: data.username, bonus: 0 });
  const el = document.getElementById('ref-friends-list');
  if (el && window._profileTab === 'friends') updateFriendsUI();
  // Toast notification
  const toast = document.createElement('div');
  toast.style.cssText = 'position:fixed;top:80px;left:50%;transform:translateX(-50%);background:#29361e;border:1px solid #89ba5f;color:#89ba5f;padding:10px 18px;border-radius:10px;font-size:13px;font-weight:600;z-index:9999;pointer-events:none';
  toast.textContent = tVars('friendJoinedToast', { u: data.username || t('playerFallbackLbl') });
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function onRefBonusReceived(data) {
  const f = _refFriendsList.find(x => x.username === data.fromUsername);
  if (f) f.bonus = (f.bonus || 0) + data.bonus;
  if (window._profileTab === 'friends') updateFriendsUI();
  const toast = document.createElement('div');
  toast.style.cssText = 'position:fixed;top:80px;left:50%;transform:translateX(-50%);background:#362d1e;border:1px solid #eec379;color:#eec379;padding:10px 18px;border-radius:10px;font-size:13px;font-weight:600;z-index:9999;pointer-events:none';
  toast.textContent = tVars('refBonusReceivedToast', { n: data.bonus.toFixed(2), u: data.fromUsername });
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function _pvpHistoryModeLbl(mode) {
  return mode === 'arena3' ? t('pvpModeArena3')
    : mode === 'race10' ? t('pvpModeRace10')
    : mode === 'open_pvp' ? t('pvpModeOpenPvp')
    : t('pvpModeDeathBattle');
}

function _pvpHistoryRowHTML(row) {
  const opponent = row.opponent ? _escHtml(row.opponent) : '';
  let icon, cls, text;
  if (row.kind === 'kill') {
    icon = '⚔️'; cls = 'pvp-hist-kill';
    text = opponent ? tVars('pvpHistKillFmt', { u: opponent }) : t('pvpHistKill');
  } else if (row.kind === 'death') {
    icon = '💀'; cls = 'pvp-hist-death';
    text = opponent ? tVars('pvpHistDeathFmt', { u: opponent }) : t('pvpHistDeath');
  } else if (row.kind === 'win') {
    icon = '🏆'; cls = 'pvp-hist-win';
    text = t('pvpHistWin');
  } else {
    icon = '❌'; cls = 'pvp-hist-lose';
    text = t('pvpHistLose');
  }
  const date = new Date(row.at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return `<div class="pvp-hist-row">
    <div class="pvp-hist-icon ${cls}">${icon}</div>
    <div class="pvp-hist-info">
      <div class="pvp-hist-text ${cls}">${text}</div>
      <div class="pvp-hist-meta">${_pvpHistoryModeLbl(row.mode)} · ${date}</div>
    </div>
  </div>`;
}

function updatePvpHistoryUI() {
  const el = document.getElementById('gram-body');
  if (!el) return;
  const rows = _pvpHistoryList;

  el.innerHTML = `
    <div class="gram-section-title" style="margin-bottom:8px">${t('pvpHistoryHdr')}</div>
    <div id="pvp-history-list">
      ${rows.length === 0
        ? `<div class="ref-empty">${t('noPvpHistoryHint')}</div>`
        : rows.map(_pvpHistoryRowHTML).join('')
      }
    </div>
  `;

  if (typeof netGetPvpHistory === 'function') netGetPvpHistory();
}

function onPvpHistoryResult(history) {
  _pvpHistoryList = history || [];
  if (window._profileTab === 'history') updatePvpHistoryUI();
}

// ─────────────────────────────────────────────────────────
//  WALLET ICONS
// ─────────────────────────────────────────────────────────
// Inlined rather than <img src="…">, for the same reason every other icon in
// this game is (see clanIconSVG, js/clans.js): these sit inside buttons and
// status chips whose colour changes with their state, and an <img> cannot
// inherit that — a disabled button would keep a bright glyph, and the deposit
// arrow would stay green inside a row that had just turned red.
//
// The two supplied glyphs arrived as fill="#000000" on an 800px canvas. Both
// the fill and the fixed size are dropped here: currentColor lets one copy
// serve every place at every size, and pasting an 800px icon into a 32px chip
// would hand the browser a layout it has to undo on every render.
function _gramIconDeposit(size) {
  const sz = size || 18;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${sz}" height="${sz}" fill="currentColor" style="display:block;flex-shrink:0"><path d="M19.6 21H4.4C3.1 21 2 19.9 2 18.6V14h2v4.2c0 .6.4.8 1 .8h14c.6 0 1-.4 1-1v-4h2v4.6c0 1.3-1.1 2.4-2.4 2.4z"/><path d="M15.3 12.1L13.4 14v-4c0-2 0-4.9 2.4-7-3.4.6-5.1 3.2-5.2 7v4l-1.9-1.9L7 13l5 5 5-5-1.7-.9z"/></svg>`;
}

function _gramIconWithdraw(size) {
  const sz = size || 18;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${sz}" height="${sz}" fill="currentColor" style="display:block;flex-shrink:0"><path d="M480,224a31.991,31.991,0,0,0-32,32V448H64V256a32,32,0,0,0-64,0V480a31.991,31.991,0,0,0,32,32H480a31.991,31.991,0,0,0,32-32V256A31.991,31.991,0,0,0,480,224Z" fill-rule="evenodd"/><path d="M224,320a32,32,0,0,0,64,0V128h96L256,0,128,128h96Z" fill-rule="evenodd"/></svg>`;
}

// The GRAM diamond is a BRAND mark, not a UI glyph, so unlike the two above it
// keeps its own blue and white and must never be switched to currentColor —
// the currency would change colour depending on which panel it sat in.
// Source of truth stays at images/gram-mark.svg; this is that file inlined so
// the balance card paints in the first frame instead of flashing an empty box
// while an <img> round-trips.
function _gramMarkSvg(size) {
  const sz = size || 22;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${sz}" height="${sz}" fill="none" style="display:block;flex-shrink:0"><path d="M66.523 11.333H33.477c-4.401 0-6.601 0-8.592.616a13.792 13.792 0 0 0-4.808 2.625c-1.594 1.341-2.784 3.192-5.164 6.894L4.408 37.81c-1.572 2.446-2.358 3.67-2.572 4.956a6.322 6.322 0 0 0 .362 3.37c.482 1.212 1.51 2.24 3.567 4.296l39.033 39.034c1.821 1.82 2.731 2.731 3.781 3.072.924.3 1.918.3 2.842 0 1.05-.34 1.96-1.251 3.78-3.072l39.035-39.034c2.056-2.056 3.084-3.084 3.566-4.296a6.32 6.32 0 0 0 .362-3.37c-.214-1.287-1-2.51-2.572-4.956L85.087 21.47c-2.38-3.703-3.57-5.554-5.164-6.895a13.792 13.792 0 0 0-4.808-2.625c-1.99-.616-4.191-.616-8.592-.616z" fill="#30A1F5"/><path d="M60.268 24.224c.537-1.45 2.59-1.45 3.126 0l3.71 10.027a2.2 2.2 0 0 0 1.3 1.3l10.027 3.71c1.451.537 1.451 2.59 0 3.126l-10.027 3.71a2.2 2.2 0 0 0-1.3 1.3l-3.71 10.027c-.537 1.451-2.59 1.451-3.126 0l-3.71-10.027a2.2 2.2 0 0 0-1.3-1.3l-10.027-3.71c-1.451-.537-1.451-2.589 0-3.126l10.027-3.71a2.2 2.2 0 0 0 1.3-1.3l3.71-10.027z" fill="#fff"/></svg>`;
}

// Stroke icons in the same house style as index.html's own nav/panel glyphs
// (24-box, currentColor, round caps) so the wallet block does not read as
// pasted in from somewhere else.
function _gramIconWallet(size) {
  const sz = size || 18;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${sz}" height="${sz}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="display:block;flex-shrink:0"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H18a2 2 0 0 1 2 2v1"/><path d="M3 7.5V17a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3"/><path d="M21 10v4h-4a2 2 0 0 1 0-4z"/></svg>`;
}

// There is no unlink glyph, deliberately. A broken-chain icon sat on
// «Отвязать» and the owner asked for it gone: every other icon in this tab
// labels something the player is meant to reach for — deposit, withdraw, copy,
// the wallet itself — and dressing the one destructive control the same way
// gave it the same invitation. The word alone says it, and the button's colour
// and border already carry the warning.

// What replaces the spinner once the wait stops being ordinary. A spinner
// means "any second now" and after three minutes that is no longer true; a
// clock means "later", which is what the panel underneath it goes on to say.
function _gramIconClock(size) {
  const sz = size || 26;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${sz}" height="${sz}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" style="display:block"><circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.2 2"/></svg>`;
}

function _gramIconCheck(size) {
  const sz = size || 26;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${sz}" height="${sz}" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" style="display:block"><path d="M20 6 9 17l-5-5"/></svg>`;
}

function _gramIconCopy(size) {
  const sz = size || 15;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${sz}" height="${sz}" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" style="display:block;flex-shrink:0"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
}

// ─────────────────────────────────────────────────────────
//  WALLET FORMATTING
// ─────────────────────────────────────────────────────────
// Every digit is kept. GRAM drops per kill are tiny — a player who farmed
// 0.0000042 has to be able to see it, which is why the balance was printed to
// seven places in the first place — but seven places of noise is also why the
// number was unreadable at a glance. The whole part and the fraction are
// returned separately so the card can render the fraction smaller and dimmer
// instead of dropping it.
function _gramSplitAmount(n) {
  const v = Number(n) || 0;
  const fixed = Math.abs(v).toFixed(7);
  const dot = fixed.indexOf('.');
  return {
    sign: v < 0 ? '-' : '',
    whole: fixed.slice(0, dot),
    frac: fixed.slice(dot + 1).replace(/0+$/, ''),
  };
}

// One-line form for rows and toasts: trailing zeros trimmed, never scientific
// notation (toFixed guarantees that; a bare String(1e-7) prints "1e-7", which
// a player reads as a broken number).
function _gramFmtAmount(n) {
  const p = _gramSplitAmount(n);
  return p.sign + p.whole + (p.frac ? '.' + p.frac : '');
}

// Ported from the Rewardix wallet's rowStatus. Two rules matter:
//
//  • A CONFIRMED transaction is final. It must never render as expired or
//    waiting, whatever else the row carries — "истёк" printed over money that
//    already arrived is the one wrong answer a player will act on.
//  • Every status the server can actually send is named. 'expired' and
//    'forfeited' both used to fall through the old two-way test to "⏳
//    Ожидание", so a dead intent looked exactly like one still being watched,
//    and a forfeited withdrawal looked like one still being processed.
function _gramTxRowStatus(tx) {
  const s = tx && tx.status;
  // 'confirmed' is what the database stores and what gramHistory replays;
  // 'credited' is what the live gramTxUpdate push carries the moment the chain
  // scanner settles a deposit (server/app.js notifyCredited). They are the same
  // event seen from two places, and a client that knew only one of them showed
  // money that had just landed as "⏳ Ожидание" until the next history fetch.
  if (s === 'confirmed' || s === 'credited') return 'ok';
  if (s === 'rejected') return 'no';
  if (s === 'forfeited') return 'no';
  if (s === 'expired') return 'dim';
  return 'wait';
}

function _gramTxStatusLabel(kind) {
  return kind === 'ok' ? t('txDoneLbl')
    : kind === 'no' ? t('txRejectedLbl')
      : kind === 'dim' ? t('txExpiredLbl')
        : t('txWaitingLbl');
}

// The address/comment pair, laid out the way Rewardix's CopyRow is: the label
// above in small caps, the value on its own line in mono so it can wrap
// without pushing the copy control off the row, and the copy button as a chip
// rather than an icon floating in whitespace. `value` is escaped by the
// caller's _esc — it is server text, and it lands in innerHTML.
function _gramCopyRow(label, id, value, tone) {
  const col = tone === 'code' ? '#f4d7a7' : '#d2c1a4';
  return `<div class="gram-copy-row">
    <div class="gram-copy-row-lbl">${label}</div>
    <div class="gram-copy-row-body">
      <span id="${id}" class="gram-copy-row-val" style="color:${col}">${value}</span>
      <button class="gram-copy-chip" onclick="gramCopy('${id}')" aria-label="${_escAttr(label)}">${_gramIconCopy(15)}</button>
    </div>
  </div>`;
}

function updateGramUI() {
  const el = document.getElementById('gram-body');
  if (!el) return;
  const balance = window._gramBalance || 0;

  const amt = _gramSplitAmount(balance);

  el.innerHTML = `
    <!-- Where a landed deposit announces itself when the player is standing in
         this tab. Filled by _renderGramCreditBanner from _gramLastCredit, and
         deliberately the FIRST thing in the body: the credit is the one event
         here the player is actually waiting on, and burying it under the
         airdrop promo is how "I cannot see my deposit arrive" happens. -->
    <div id="gram-credit-banner"></div>

    <div class="gram-balance-card">
      <div class="gram-balance-chip">${_gramMarkSvg(26)}</div>
      <div class="gram-balance-label">${t('gramBalanceLbl')}</div>
      <div class="gram-balance-amount" id="gram-balance-val"><span class="gram-bal-whole">${amt.whole}</span>${amt.frac ? `<span class="gram-bal-frac">.${amt.frac}</span>` : ''} <span class="gram-unit">GRAM</span></div>
    </div>

    <div class="gram-actions">
      <button class="gram-action gram-action-dep" onclick="openGramDepositModal()">
        <span class="gram-action-ico">${_gramIconDeposit(19)}</span>
        <span>${t('depositBtn')}</span>
      </button>
      <button class="gram-action gram-action-wd" onclick="openGramWithdrawModal()">
        <span class="gram-action-ico">${_gramIconWithdraw(17)}</span>
        <span>${t('withdrawBtn')}</span>
      </button>
    </div>

    <!-- Where _gramMsg writes. It had nowhere to write at all: this element
         existed in neither index.html nor any render, so every message that
         function carries was dropped on the floor — including the server's
         own refusals (gramError, e.g. the VIP gate on withdrawal and
         "Недостаточно средств") and the "request created" confirmations. A
         withdrawal that the server turned down looked exactly like one that
         went through: nothing happened either way. -->
    <div id="gram-msg" class="gram-msg" style="display:none;margin-bottom:14px"></div>

    <div class="gram-section">
      <div class="gram-section-title">${t('gramWalletHdr')}</div>
      <div id="ton-connect-row"></div>
    </div>

    <div class="gram-airdrop-card">
      <!-- images/airdrop.png is cut to 192×192 (10 KB) and must not be drawn
           larger than 96 CSS px — past that it softens. 60px here leaves the
           2× headroom the cut was sized for. -->
      <img class="gram-airdrop-img" src="/images/airdrop.png" width="60" height="60" alt="">
      <div class="gram-airdrop-txt">
        <div class="gram-airdrop-title">AirDrop <span class="gram-airdrop-soon">${t('airdropSoonLbl')}</span></div>
        <div class="gram-airdrop-sub">${t('airdropCollectHint')}</div>
      </div>
    </div>

    <div class="gram-section">
      <div class="gram-section-title">${t('txHistoryHdr')}</div>
      <div id="gram-history-list"><div class="gram-hint" style="text-align:center;padding:12px 0">${t('questLoading')}</div></div>
    </div>
  `;

  _renderGramCreditBanner();
  _renderTonConnectRow();
  // The list is re-rendered from what is already in hand before the refetch,
  // so reopening the tab does not blank a history we can already draw — and so
  // a credit that landed while the tab was closed is on screen in the first
  // frame rather than one round trip later.
  if (_gramTxList.length) _renderGramHistory();
  // Pulls the wallet library in the moment the panel is opened, so a player
  // who connected before sees that state instead of a "connect" button. The
  // library is the only thing that can restore that session.
  if (typeof tcWarmUp === 'function') tcWarmUp();
  if (typeof netGramHistory === 'function') netGramHistory();
}

// Short "UQ...ab3f" form for display — TON addresses are long and don't need
// to be shown in full outside the copy-paste boxes that specifically need it.
function _shortenTonAddr(addr) {
  if (!addr) return '';
  return addr.length > 12 ? addr.slice(0, 6) + '…' + addr.slice(-4) : addr;
}

// Shown while the wallet library downloads on first use — a second or two on
// mobile, during which the button would otherwise look dead.
function _tcSetBusy(busy) {
  const el = document.getElementById('ton-connect-row');
  if (!el) return;
  // The CONNECT control, not "the first button in the row". Once this row could
  // draw a linked card with a connect prompt inside it, the first button became
  // the copy chip — so the loading state landed on the control the player had
  // not pressed, and the one they had pressed stayed live and pressable.
  const btn = el.querySelector('.gram-connect-btn') || el.querySelector('button');
  if (!btn) return;
  if (busy) {
    btn.dataset.label = btn.innerHTML;
    btn.innerHTML = typeof t === 'function' ? t('questLoading') : 'Загрузка…';
    btn.disabled = true;
  } else if (btn.dataset.label) {
    btn.innerHTML = btn.dataset.label;
    btn.disabled = false;
  }
}
// The connected wallet, laid out like Rewardix's WalletSheet: an icon chip, a
// status line, the address on its own row in mono, and the unlink control as a
// real bordered button.
//
// It used to be three spans and an underlined word crammed onto one 12px line,
// with the address elided to "UQ6f…ab3f" and no way to read or copy the rest —
// so the one question the row exists to answer ("is the wallet I think I
// linked the one that is linked?") could not be answered from it.
//
// ── the two facts this row must not merge ──────────────────────────────────
// It asked tcAddress() and nothing else, and tcAddress() is TON Connect
// restoring a session out of THIS BROWSER'S localStorage. So the row was
// answering "can this browser sign?" while looking like it answered "which
// wallet is my money going to?" — which is why the phone said «Кошелёк
// подключён» and the desktop said «Подключить кошелёк» about one account.
//
//   linked   the ACCOUNT's wallet, from the server (migration 015). The same
//            on every device. What the withdrawal form pre-fills.
//   local    a live TON Connect session, i.e. the ability to SIGN. Per-device
//            by construction — the wallet app approves on the phone it is
//            paired with — and no server can hand it to another browser.
//
// The row says WHICH of the two it has, and that is not decoration: offering
// «Отправить из кошелька» on a device that cannot sign is the same lie as the
// black screen — the tap does nothing and the player has no way to find out
// why.
function _renderTonConnectRow() {
  const el = document.getElementById('ton-connect-row');
  if (!el) return;
  const local  = typeof tcAddress === 'function' ? tcAddress() : null;
  const linked = window._linkedWallet || null;
  // The ACCOUNT's answer wins the headline. `local` is the fallback for the one
  // moment there is no account answer yet — a wallet just connected and the
  // server has not replied, or migration 015 is not applied — where showing the
  // session is better than showing nothing.
  const addr = linked || local;
  // Neither of these was authored by this client (one comes off the wire, one
  // out of the wallet library) and both land in innerHTML — escaped on the way
  // in rather than trusted.
  const safe = _esc(addr || '');

  // ── what this DEVICE can do about it ─────────────────────────────────────
  // Three states, and the two that are not "everything agrees" each get a way
  // out that does not involve an operator.
  let note = '';
  if (addr && !local) {
    // The desktop case the owner reported, said out loud instead of being
    // rendered as «Подключить кошелёк» over a wallet that IS linked.
    note = `<div class="gram-wallet-note" id="gram-wallet-note">
        <div class="gram-hint">${t('tcNoSessionHere')}</div>
        <button class="gram-connect-btn" onclick="tcConnect()">${t('tcConnectHereBtn')}</button>
      </div>`;
  } else if (addr && local && linked && local !== linked) {
    // Two wallets, one account: this browser holds a session the account does
    // not know about. It is NOT published on its own — a restored session that
    // could overwrite the account would let opening the phone undo a change
    // made on the desktop (see _walletPublishIfNeeded) — so the player is shown
    // both and given one press that makes it deliberate.
    note = `<div class="gram-wallet-note" id="gram-wallet-note">
        <div class="gram-hint">${t('tcOtherWalletHere')}: ${_esc(_shortenTonAddr(local))}</div>
        <button class="gram-connect-btn" onclick="_gramLinkThisWallet()">${t('tcUseThisWalletBtn')}</button>
      </div>`;
  }

  el.innerHTML = addr
    ? `<div class="gram-wallet-card">
        <div class="gram-wallet-head">
          <span class="gram-wallet-chip gram-wallet-chip-on">${_gramIconWallet(19)}</span>
          <div class="gram-wallet-head-txt">
            <div class="gram-wallet-status">${linked ? t('tcLinkedLbl') : t('tcConnectedLbl')}</div>
            <div class="gram-wallet-short">${_esc(_shortenTonAddr(addr))}</div>
          </div>
        </div>
        <div class="gram-wallet-addr">
          <div class="gram-copy-row-lbl">${t('tcAddressLbl')}</div>
          <div class="gram-copy-row-body">
            <span id="gram-tc-addr-val" class="gram-copy-row-val">${safe}</span>
            <button class="gram-copy-chip" onclick="gramCopy('gram-tc-addr-val')" aria-label="${_escAttr(t('tcAddressLbl'))}">${_gramIconCopy(15)}</button>
          </div>
        </div>
        ${note}
        <button class="gram-unlink-btn" onclick="_gramUnlinkWallet()">${t('tcDisconnectBtn')}</button>
      </div>`
    : `<div class="gram-wallet-card gram-wallet-card-off">
        <span class="gram-wallet-chip">${_gramIconWallet(19)}</span>
        <div class="gram-wallet-off-txt">${t('tcNotConnectedHint')}</div>
        <button class="gram-connect-btn" onclick="tcConnect()">${t('tcConnectBtn')}</button>
      </div>`;
}

// «Отвязать» unlinks the ACCOUNT, not this browser — that is what the word
// means to the player pressing it, and a button that drops one device's session
// while the other one still withdraws to the same wallet is the same lie as the
// desktop not knowing about the phone.
//
// Both halves are needed and only one of them is ours to do: the server owns
// the account fact, and the browser owns its own TON Connect session. Neither
// can do the other's half.
//
// It goes through here rather than straight to tcDisconnect() so the player is
// TOLD what happened. tcDisconnect is fire-and-forget: if the library never
// loaded, or the disconnect throws inside it, the row simply stays as it was
// and the tap reads as a dead button — the exact silent-refusal shape this tab
// is not allowed to have any more.
function _gramUnlinkWallet() {
  // The ACCOUNT first, and before the local disconnect on purpose: it is the
  // half that matters on the other device, and a library that throws below must
  // not be able to swallow it.
  if (typeof netWalletUnlink === 'function') {
    netWalletUnlink();
  } else {
    // The bundle lost js/network.js's wallet half. The device can still be
    // unlinked, the account cannot, and saying nothing here would leave the
    // player believing an account-wide unlink that never left the browser.
    console.warn('[wallet] netWalletUnlink отсутствует — отвязано только устройство');
    if (typeof window.__reportClientError === 'function') {
      window.__reportClientError('walletUnlink', 'netWalletUnlink missing — device-only unlink');
    }
    _gramMsg(t('serviceUnavailableToast'), 'err');
  }
  if (typeof tcDisconnect !== 'function') { _gramMsg(t('serviceUnavailableToast'), 'err'); return; }
  try {
    tcDisconnect();
  } catch (e) {
    _gramMsg(t('serviceUnavailableToast'), 'err');
    console.warn('[wallet] unlink failed:', e);
    return;
  }
  // The confirmation is left to the server's walletState reply (js/network.js),
  // which is the only thing that knows the ACCOUNT's link actually went away.
  // Announcing it here would claim an unlink that had not happened yet — and
  // for an account-level fact, this browser is not in a position to claim it at
  // all.
}

// «Привязать этот кошелёк» — the way out of the one state that cannot resolve
// itself. This browser holds a session for a wallet the account does not know
// about, and it was RESTORED rather than connected, so nothing published it.
// One press makes it deliberate, which is exactly the distinction the publish
// rule turns on — and it is what lets a player change their payout address
// without an operator.
function _gramLinkThisWallet() {
  const addr = typeof tcAddress === 'function' ? tcAddress() : null;
  if (!addr) { _gramMsg(t('tcNoLocalSessionMsg'), 'err'); return; }
  if (typeof netWalletLink !== 'function') { _gramMsg(t('serviceUnavailableToast'), 'err'); return; }
  netWalletLink(addr);
}

// Whether a wallet was connected the last time the row was drawn. Kept so the
// connect→disconnect edge can be told apart from a re-render, which is what
// decides whether the "отвязан" confirmation is honest.
let _gramWalletWasOn = false;

// Called by js/tonconnect.js whenever the wallet connect status changes —
// keeps the wallet tab (and any open deposit/withdraw modal) in sync without
// the player needing to close and reopen anything.
//
// `deliberate` is true only when the player just went through the connect modal
// on THIS device; a session the library restored out of this browser's storage
// arrives with it false. See js/tonconnect.js for why the two cannot be treated
// alike.
function _onTonConnectChange(deliberate) {
  const addr = typeof tcAddress === 'function' ? tcAddress() : null;
  // The «Кошелёк отвязан» confirmation moved to the server's walletState reply,
  // because with an account-level link that sentence is a claim about the
  // ACCOUNT and this callback only knows about the browser. What is left here
  // is the one case the server has nothing to say about: a device session that
  // went away with nothing linked to the account at all — a player who never
  // published one, or a server without migration 015.
  if (_gramWalletWasOn && !addr && !window._linkedWallet) _gramMsg(t('tcUnlinkConfirmToast'), 'ok');
  _gramWalletWasOn = !!addr;
  _walletPublishIfNeeded(addr, deliberate);
  _onWalletStateChange();
}

// ── when a device may speak for the ACCOUNT ─────────────────────────────────
// The whole of "newest wins" lives in this function, and the reason it is not
// simply "report whatever this device has" is that a device reports on every
// launch, not only when the player decides something.
//
// Two devices, two wallets: the player connects wallet B on the desktop, then
// opens the phone, whose library restores wallet A out of its own storage. If a
// restore could publish, merely OPENING THE APP would move the account's payout
// address back to a wallet the player had already replaced — silently, with the
// withdrawal form pre-filling it from then on. That is the exact failure the
// owner warned about: ending up withdrawing to an address you forgot about.
//
// So a restored session speaks only when the account has never had an address,
// and that case is the BACKFILL — the reason the owner's own phone, which has a
// wallet linked and a server that has never heard of it, fixes the desktop by
// being opened once rather than by the player re-linking anything.
//
// `_walletEverLinked` is why the backfill cannot undo an unlink: after
// «Отвязать» the account has no address but HAS been linked, so a restored
// session stays quiet and only a fresh connect (or «Привязать этот кошелёк»)
// speaks again.
function _walletPublishIfNeeded(addr, deliberate) {
  if (!addr) return;
  if (typeof netWalletLink !== 'function') {
    // The bundle lost js/network.js's wallet half: the wallet works on this
    // device and the account will never learn about it, which looks exactly
    // like the bug this whole change fixes.
    console.warn('[wallet] netWalletLink отсутствует — привязка никуда не уйдёт');
    if (typeof window.__reportClientError === 'function') {
      window.__reportClientError('walletLink', 'netWalletLink missing — address never reported');
    }
    return;
  }
  const linked = window._linkedWallet || null;
  if (addr === linked) return;                    // the account already knows
  if (!deliberate && (linked || window._walletEverLinked)) return;
  netWalletLink(addr);
}

// Everything that depends on which wallet the account is linked to, in one
// place: the panel row, the deposit sheet's send button and the withdrawal
// form's address. Called both when THIS DEVICE's session changes and when the
// SERVER says the account's did (js/network.js walletState), because either can
// change what any of the three should show — and before this existed only the
// first of the two could redraw anything.
function _onWalletStateChange() {
  _renderTonConnectRow();
  const depBtn = document.getElementById('ton-deposit-send-wrap');
  if (depBtn) _renderTonDepositSection();
  const wdAddr = document.getElementById('gram-wd-addr');
  // The ACCOUNT's address first. That is where this player's money is supposed
  // to go, it is the same on every device, and on a desktop with no signing
  // session it is the only address there is — which is the case that used to
  // leave the field empty and the player pasting by hand.
  const fill = window._linkedWallet || (typeof tcAddress === 'function' ? tcAddress() : null);
  if (wdAddr && fill && !wdAddr.value) wdAddr.value = fill;
  if (document.getElementById('ton-wd-connect-wrap')) _renderTonWithdrawConnectHint();
}

function _renderGramHistory() {
  const el = document.getElementById('gram-history-list');
  if (!el) return;
  if (!_gramTxList.length) {
    el.innerHTML = `<div class="gram-hint" style="text-align:center;padding:12px 0">${t('noTxYetHint')}</div>`;
    return;
  }
  // Per-row status the way Rewardix's deposit list does it: the row is TINTED
  // by its outcome — icon chip, amount and label together — instead of the
  // outcome being one 10px word in the corner that reads the same whether the
  // money arrived or the intent died. A row that is not going to pay out is
  // dimmed whole, so a list of six can be understood without reading it.
  el.innerHTML = _gramTxList.map(tx => {
    const isDeposit = tx.type === 'deposit';
    const st = _gramTxRowStatus(tx);
    const dir = isDeposit ? 'dep' : 'wd';
    const date = new Date(tx.createdAt).toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
    // A deposit's amount is only real once the chain has been read: an intent
    // carries the MINIMUM as a placeholder, so printing it on a pending row
    // promised a figure the player had not sent. Shown for anything settled,
    // withheld while it is still a guess.
    const showAmt = st === 'ok' || !isDeposit;
    return `<div class="gram-tx-row gram-tx-${st}">
      <div class="gram-tx-icon gram-tx-${dir}">${isDeposit ? _gramIconDeposit(15) : _gramIconWithdraw(14)}</div>
      <div class="gram-tx-info">
        <div class="gram-tx-type">${isDeposit ? t('depositTypeLbl') : t('withdrawTypeLbl')}</div>
        <div class="gram-tx-date">${date}${tx.memo ? ` · ${t('txMemoLbl')} ${_esc(tx.memo)}` : ''}</div>
      </div>
      <div class="gram-tx-right">
        ${showAmt ? `<div class="gram-tx-amount gram-tx-${dir}">${isDeposit ? '+' : '−'}${_gramFmtAmount(tx.amount)} GRAM</div>` : ''}
        <div class="gram-tx-status gram-st-${st}">${_gramTxStatusLabel(st)}</div>
      </div>
    </div>`;
  }).join('');
}

// The balance number is markup (whole part, dimmed fraction, unit), so it is
// re-rendered rather than assigned as text. Assigning textContent here is what
// the two callers below used to do, and it silently ate the "GRAM" unit the
// moment any transaction landed — the card went from "12.5 GRAM" to "12.5 "
// and stayed that way until the tab was reopened.
function _setGramBalanceText() {
  const bal = document.getElementById('gram-balance-val');
  if (!bal) return;
  const p = _gramSplitAmount(window._gramBalance || 0);
  bal.innerHTML = `<span class="gram-bal-whole">${p.whole}</span>${p.frac ? `<span class="gram-bal-frac">.${p.frac}</span>` : ''} <span class="gram-unit">GRAM</span>`;
}

function onGramHistory(txs) {
  _gramTxList = txs || [];
  _renderGramHistory();
}

function onGramTxCreated(tx) {
  _gramTxList.unshift(tx);
  _renderGramHistory();
  _setGramBalanceText();
}

function onGramTxUpdate(id, status) {
  // Not `t` for the predicate: `t` is the translation function, and shadowing
  // it inside a callback that lives next to a dozen `t('...')` calls is a trap
  // waiting for the next edit to this line.
  const tx = _gramTxList.find(x => x.id === id);
  if (tx) { tx.status = status; _renderGramHistory(); }
  _setGramBalanceText();
}

// ─────────────────────────────────────────────────────────
//  A DEPOSIT LANDED
// ─────────────────────────────────────────────────────────
// 'gramDepositCredited' is pushed by the server the moment the chain scanner
// matches a transfer to this player's intent and credits it (see
// server/db/repos/gram.js creditOnce). It is the ONLY moment the client can
// know the money moved — there is no polling and no "I paid" button any more —
// so everything about making that moment visible hangs off this one function.
//
// The credit can land in three different places and all three are handled:
//
//   • deposit modal open   → the modal flips to its success state
//   • wallet tab open      → a banner at the top of the tab, balance updated
//   • anywhere else        → a floating card, because the player is in the
//                            dungeon and will not see either of the above
//
// The last one is the one that is easy to leave out and the one that matters
// most: a player who sent TON from their phone's wallet app comes back to a
// game that is not on the wallet tab.
let _gramLastCredit = null;
let _gramCreditToastTimer = null;
// How long the floating confirmation stays. Longer than _marketToast's four
// seconds on purpose — this one carries a number the player will want to read
// twice, and it is dismissible before then.
const GRAM_CREDIT_TOAST_MS = 8000;

function onGramDepositCredited(data) {
  const d = data || {};
  const amount = Number(d.amount) || 0;
  // The server sends the authoritative post-credit balance. Trusting it over a
  // local add keeps the card from ever showing a number the server disagrees
  // with; if it is absent for any reason, fall back to adding the delta rather
  // than leaving the balance stale.
  const balance = Number.isFinite(Number(d.balance)) && d.balance != null
    ? Number(d.balance)
    : (window._gramBalance || 0) + amount;
  window._gramBalance = balance;
  if (typeof player !== 'undefined' && player) player.gramBalance = balance;

  _gramLastCredit = {
    amount, balance,
    memo: d.memo ? String(d.memo) : '',
    txHash: d.txHash ? String(d.txHash) : '',
    at: d.at || Date.now(),
  };

  // Patch the matching history row in place so the list is right in this
  // frame, then ask the server for the real one. Without the local patch the
  // row the player is staring at keeps saying "Ожидание" for a whole round
  // trip after the success card has told them it arrived.
  const row = _gramLastCredit.memo && _gramTxList.find(x => x.memo === _gramLastCredit.memo);
  if (row) { row.status = 'confirmed'; row.amount = amount; row.txHash = _gramLastCredit.txHash; }
  else {
    _gramTxList.unshift({
      id: 'credit-' + _gramLastCredit.at, type: 'deposit', amount,
      status: 'confirmed', memo: _gramLastCredit.memo,
      txHash: _gramLastCredit.txHash, createdAt: _gramLastCredit.at,
    });
  }
  if (typeof netGramHistory === 'function' && typeof netIsLive === 'function' && netIsLive()) netGramHistory();

  // The same cue a good drop makes. Wrapped because the audio graph is built
  // lazily and can be missing entirely (muted, no user gesture yet) — a cue
  // that throws must never be what stops the confirmation being drawn.
  if (typeof Sound !== 'undefined' && Sound && typeof Sound.loot === 'function') {
    try { Sound.loot(); } catch (e) { console.warn('[wallet] credit cue failed:', e); }
  }

  // Whatever the sheet was waiting for, the waiting is over. Cleared before
  // anything is drawn so the slow timer cannot fire afterwards and rewrite a
  // success panel into «зачисление задерживается».
  _gramSentPending = null;
  clearTimeout(_gramSlowTimer);

  const modalOpen = !!document.getElementById('gram-dep-code');
  if (modalOpen) {
    _setGramDepositState('credited');
  } else {
    // The tab, if it happens to be the one on screen, and the floating card
    // either way — the tab render alone is invisible to a player in the world.
    _gramCreditToast(_gramLastCredit);
  }
  if (activeTab === 5 && window._profileTab === 'wallet') {
    _setGramBalanceText();
    _renderGramCreditBanner();
    _renderGramHistory();
  }
}

// The in-tab banner. Rendered from _gramLastCredit rather than from the event,
// so opening the wallet tab minutes later still shows what landed — a credit
// that happened while the player was in the dungeon is not a thing they should
// have to reconstruct from the history list.
function _renderGramCreditBanner() {
  const el = document.getElementById('gram-credit-banner');
  if (!el) return;
  if (!_gramLastCredit) { el.innerHTML = ''; return; }
  const c = _gramLastCredit;
  // The CARD closes it, not only the cross. This banner carries no action
  // of its own — the balance it names is on the card above it and the row
  // it names is in the list below — so every tap on it means the same
  // thing, and a person who has read a message taps the message.
  el.innerHTML = `<div class="gram-credit-card" onclick="_gramDismissCredit()">
    <span class="gram-credit-chip">${_gramIconCheck(24)}</span>
    <div class="gram-credit-txt">
      <div class="gram-credit-title">${t('depositCreditedTitle')}</div>
      <div class="gram-credit-amount">${tVars('depositCreditedAmountFmt', { n: _gramFmtAmount(c.amount) })}</div>
      <div class="gram-credit-sub">${tVars('depositNewBalanceFmt', { n: _gramFmtAmount(c.balance) })}</div>
    </div>
    <button class="gram-credit-close" onclick="event.stopPropagation();_gramDismissCredit()" aria-label="${_escAttr(t('closeLbl'))}">✕</button>
  </div>`;
}

// Every surface at once, because they are one message. Dismissing the toast
// and then finding the same words waiting in the wallet tab — behind a
// 24×24 dot — is what «на що не тикай, воно не закривалось» was.
// Escape closes it too. The owner plays on a desktop as well as a phone,
// and a sheet tall enough to fill the viewport leaves no overlay to click
// beside it. Registered once, at load, next to nothing else that listens
// for this key (index.html closes the chat on Escape; the two cannot both
// be the topmost thing on screen).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (document.getElementById('gram-modal-wrap')) { closeGramModal(); return; }
  if (document.getElementById('gram-credit-toast') || document.querySelector('.gram-credit-card')) {
    _gramDismissCredit();
  }
});
function _gramDismissCredit() {
  _gramLastCredit = null;
  clearTimeout(_gramCreditToastTimer);
  const toast = document.getElementById('gram-credit-toast');
  if (toast) toast.remove();
  _renderGramCreditBanner();
}

// The floating confirmation, for a credit that lands while the player is
// anywhere but this tab. Built here rather than reusing _marketToast because
// that one is a single line of text with pointer-events off — it cannot carry
// the amount, the new balance, or a way to go and look at them.
function _gramCreditToast(c) {
  const old = document.getElementById('gram-credit-toast');
  if (old) old.remove();
  clearTimeout(_gramCreditToastTimer);
  const el = document.createElement('div');
  el.id = 'gram-credit-toast';
  el.className = 'gram-credit-toast';
  el.innerHTML = `<span class="gram-credit-chip">${_gramIconCheck(22)}</span>
    <div class="gram-credit-txt">
      <div class="gram-credit-title">${t('depositCreditedTitle')}</div>
      <div class="gram-credit-amount">${tVars('depositCreditedAmountFmt', { n: _gramFmtAmount(c.amount) })}</div>
      <div class="gram-credit-sub">${tVars('depositNewBalanceFmt', { n: _gramFmtAmount(c.balance) })}</div>
    </div>
    <button class="gram-credit-x" aria-label="${_escAttr(t('closeLbl'))}">✕</button>`;
  // The GRAM mark used to sit here. It was decoration, and the owner was
  // holding a card with NO way to dismiss it: the only handler on the whole
  // toast navigated. Tapping to get rid of a message and being moved to
  // another tab instead reads as the message following you.
  el.querySelector('.gram-credit-x').onclick = (ev) => {
    ev.stopPropagation();
    _gramDismissCredit();
  };
  // The body still opens the wallet — that is the useful thing to do with a
  // credit — and now it is a choice rather than the only outcome.
  el.onclick = () => {
    el.remove();
    clearTimeout(_gramCreditToastTimer);
    if (typeof setTab === 'function') { setTab(5); switchProfileTab('wallet'); }
  };
  document.body.appendChild(el);
  _gramCreditToastTimer = setTimeout(() => el.remove(), GRAM_CREDIT_TOAST_MS);
}

// ── Deposit modal ─────────────────────────────────────────
// The code comes from the SERVER and from nowhere else. The modal opens with a
// loading state where the code goes and fills it in when 'gramDepositIntent'
// arrives (see _initGramHandlers, js/network.js).
//
// What this replaces computed the memo right here:
//
//     const memo = (player && player.telegramId) ? player.telegramId
//                  : (netUsername || String(Date.now()));
//
// Nothing in this bundle ever sets player.telegramId, so it was always the
// second branch — the player's USERNAME, which is drawn above their head in
// the world. The server has always minted its own LBT-xxxxxxxxxxxx and matched
// on that, so every transfer sent with the shown comment matched nothing and
// landed in unmatched_deposits for an admin to place by hand.
//
// There is deliberately NO fallback any more, not even a "temporary" one. A
// locally invented memo is money sent to a comment nothing will match, so
// showing no code at all — and saying so — is strictly better than showing one.
let _gramDepositState = 'idle';       // idle | loading | ready | error | sent | slow | credited
let _gramDepositTimer = null;
// How long the modal waits before calling the request lost. Longer than any
// healthy round trip and shorter than a player's patience.
const GRAM_DEPOSIT_WAIT_MS = 15000;

// ── the code's deadline, somewhere it can actually be seen ───────────────
// It used to be the LAST line of the sheet: 11px, #5c5344 on #16120a — the
// dimmest thing on the panel — printed under the minimum and under the
// «ничего не потеряется» note, 49px from the bottom edge of a 915px phone
// and below the fold on anything shorter. Measured in a real browser at
// 390×844 before it moved, not guessed at.
//
// It now sits directly under the code it belongs to, and it counts down. An
// hour on its own answers nothing: a Mini App covers the phone's clock, so
// «до 17:50» makes the player go and find out what time it is before the
// line means anything.
//
// Honest about what expiry is here. server/db/repos/gram.js keeps ONE open
// intent per player and refreshes expires_at on every open — the column is
// display only, the scanner matches on created_at against a seven-day
// grace and never reads it. So a transfer already sent still credits after
// this reaches zero, and refreshing returns the SAME memo with a new
// window. The expired panel says exactly that rather than implying the
// money went somewhere.
let _gramCodeUntil = null;      // ms epoch of the deadline on screen, or null
let _gramCodeTimer = null;

function _gramStopDeadline() {
  clearInterval(_gramCodeTimer);
  _gramCodeTimer = null;
}

// «до 17:50» when the deadline is today — a thirty-minute window almost
// always is — and the date as well when it is not, so a code minted at 23:55
// cannot read as one that expired eleven hours ago. ru-RU for the same
// reason every other date in this file uses it: 24-hour and unambiguous,
// where the browser's own locale would hand some players 5:50 PM.
function _gramClockText(ms) {
  const d = new Date(ms);
  const hm = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return hm;
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) + ', ' + hm;
}

// One tick draws, and decides whether there will be another. Bound to the
// ELEMENT rather than to the modal: if the node is gone — a redraw into
// another state, a closed sheet, a reopened panel — the ticker stops itself
// instead of writing once a second into something nobody is looking at.
function _gramRenderDeadline() {
  const el = document.getElementById('gram-dep-deadline');
  if (!el || !_gramCodeUntil) { _gramStopDeadline(); return; }
  const left = _gramCodeUntil - Date.now();
  if (left > 0) {
    const total = Math.round(left / 1000);
    const mmss = Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
    el.className = 'gram-dep-deadline';
    el.innerHTML = '<span class="gram-dep-deadline-ico">' + _gramIconClock(19) + '</span>'
      + '<div class="gram-dep-deadline-txt">'
      +   '<div class="gram-dep-deadline-main">'
      +     tVars('depositCodeValidUntilFmt', { n: _gramClockText(_gramCodeUntil) })
      +   '</div>'
      +   '<div class="gram-dep-deadline-left">'
      +     tVars('depositCodeLeftFmt', { n: mmss })
      +   '</div>'
      + '</div>';
    return;
  }
  _gramStopDeadline();
  el.className = 'gram-dep-deadline gram-dep-deadline-out';
  el.innerHTML = '<span class="gram-dep-deadline-ico">' + _gramIconClock(19) + '</span>'
    + '<div class="gram-dep-deadline-txt">'
    +   '<div class="gram-dep-deadline-main">' + t('depositCodeExpiredTitle') + '</div>'
    +   '<div class="gram-dep-deadline-left">' + t('depositCodeExpiredDesc') + '</div>'
    +   '<button class="gram-dep-refresh" onclick="_requestGramDepositCode()">'
    +     t('depositCodeRefreshBtn') + '</button>'
    + '</div>';
}

function _gramStartDeadline(iso) {
  _gramStopDeadline();
  const at = iso ? new Date(iso).getTime() : NaN;
  _gramCodeUntil = Number.isFinite(at) ? at : null;
  const el = document.getElementById('gram-dep-deadline');
  // No deadline from the server is not an excuse to invent one. The block
  // stays empty and the code stays usable — expires_at is display only.
  if (!_gramCodeUntil) { if (el) el.innerHTML = ''; return; }
  _gramRenderDeadline();
  _gramCodeTimer = setInterval(_gramRenderDeadline, 1000);
}

// ── what the player is waiting on, between signing and crediting ────────────
// Held outside the DOM because the DOM is the thing that goes away: the player
// leaves for their wallet app and comes back, and the amount and the code have
// to still be there to redraw the waiting panel with.
let _gramSentPending = null;          // { amount, memo } while a transfer is in flight
let _gramSlowTimer = null;

// When a spinner stops being honest. The chain confirms in seconds, the trace
// then has to settle (server/ton.js refuses an in_progress event, because its
// id is provisional), and only then does the scanner see it — it runs every
// 15s (DEPOSIT_SCAN_MS, server/workers.js). A healthy credit is under a minute
// and a slow one is a couple; past three, something is different from the
// happy path and saying nothing about it is the bug.
//
// It does NOT mean the money is lost, and the panel it switches to says so:
// the intent stays matchable for INTENT_GRACE_MS — seven days — so a transfer
// found on day three still credits. The state exists to stop a spinner
// claiming "any second now" for an hour.
const GRAM_DEPOSIT_SLOW_MS = 180 * 1000;

function openGramDepositModal() {
  const html = `
    <div id="gram-modal-overlay" onclick="closeGramModal()" style="position:fixed;inset:0;z-index:400;background:rgba(0,0,0,.75);backdrop-filter:blur(4px);display:flex;align-items:flex-end;justify-content:center;">
      <div class="gram-sheet" onclick="event.stopPropagation()">
        <div class="gram-sheet-hdr">
          <span class="gram-sheet-ico gram-sheet-ico-dep">${_gramIconDeposit(17)}</span>
          <div class="gram-sheet-title">${t('depositModalTitle')}</div>
          <button class="gram-sheet-close" onclick="closeGramModal()" aria-label="✕">✕</button>
        </div>

        <!-- The amount field and the one-tap wallet button are only useful
             before the transfer leaves; once the deposit credits they are
             replaced wholesale by the success state, so they live in a wrapper
             _setGramDepositState can hide in one move. -->
        <div id="gram-dep-form">
          <div style="margin-bottom:10px">
            <div class="gram-hint" style="margin-bottom:6px">${t('transferAmountHint')}</div>
            <!-- No floor until the server names one. It used to say min="1"
                 while the server's real minimum is 0.05 TON, so the browser
                 refused a legitimate small top-up before anything was sent. -->
            <input id="gram-dep-amount" type="number" min="0" step="0.01" placeholder="${t('enterGramAmountPlaceholder')}" class="gram-input" style="width:100%;box-sizing:border-box" oninput="_renderTonDepositSection()">
          </div>

          <div id="ton-deposit-send-wrap" style="margin-bottom:6px"></div>
        </div>

        <!-- Address, code, expiry and the warning all live in here together,
             because they are one thing: they are only true once the server has
             issued the code. Showing the address on its own while the code is
             still loading (or failed) is an invitation to pay without one, and
             a payment with no comment is another unmatched_deposits row.
             The credited state replaces this block too — the code is spent. -->
        <div id="gram-dep-code"></div>

        <div id="gram-modal-msg" class="gram-msg" style="display:none;margin-top:10px"></div>
      </div>
    </div>`;
  const div = document.createElement('div');
  div.id = 'gram-modal-wrap';
  div.innerHTML = html;
  document.body.appendChild(div);
  // Cleared, never carried over from the last open. A stale memo from a
  // previous session is exactly as unmatched as an invented one.
  window._gramDepositMemo = null;
  _requestGramDepositCode();
}

// ── asking the server for this player's code ────────────────────────────────
// The timeout is not decoration. _emitWhenAuthed drops the emit after its
// retries if the socket never comes back, and the rate limiter can refuse the
// packet outright — both leave the modal waiting on a reply that is never
// coming. Without this the player watches a spinner forever and reads it as a
// broken game; with it they get the reason and a button that tries again.
function _requestGramDepositCode() {
  if (typeof netGramDepositIntent !== 'function') {
    _setGramDepositState('error', t('serviceUnavailableToast'));
    return;
  }
  _setGramDepositState('loading');
  clearTimeout(_gramDepositTimer);
  _gramDepositTimer = setTimeout(() => {
    _gramDepositFailed(t('depositCodeTimeoutMsg'));
  }, GRAM_DEPOSIT_WAIT_MS);
  netGramDepositIntent();
}

// The server answered. This is the ONLY writer of window._gramDepositMemo —
// both ways of paying read it from here, so the copy-paste box and the wallet
// button cannot end up carrying different comments.
function onGramDepositIntent({ memo, address, minAmount, expiresAt }) {
  clearTimeout(_gramDepositTimer);
  // A code with no address is not payable, and neither is an address with no
  // code. Refusing the pair rather than rendering half of it keeps the modal
  // from ever showing something that looks like instructions and is not.
  if (!memo || !address) { _gramDepositFailed(t('depositCodeErrorMsg')); return; }
  window._gramDepositMemo = memo;
  // The wallet button sends to THIS address, not to the one authOk handed the
  // client at login: both halves of the modal must carry the same destination
  // and the same comment, and this is the pair the server just validated.
  window._gramDepositAddress = address;
  window._gramDepositMin = Number(minAmount) > 0 ? Number(minAmount) : null;
  _setGramDepositState('ready', null, { memo, address, expiresAt });
}

// A refusal, a timeout, or a reply that made no sense. Returns true when it
// actually belonged to a deposit modal that was waiting — js/network.js's
// gramError handler uses that to decide whether the message still needs to go
// to the wallet panel behind the modal.
function _gramDepositFailed(msg) {
  if (_gramDepositState !== 'loading') return false;
  clearTimeout(_gramDepositTimer);
  window._gramDepositMemo = null;
  window._gramDepositAddress = null;
  _setGramDepositState('error', msg || t('depositCodeErrorMsg'));
  return true;
}

// Everything about the modal that depends on whether a code has arrived — and,
// now, on whether the money has — in one place: the code block, the amount
// field's minimum, the wallet button, and the success state that replaces all
// of them.
//
// There is no "I paid" button any more. It never did anything: the intent that
// makes a transfer creditable is minted when this modal OPENS, and the chain
// scanner credits it on its own. What the button actually did was teach the
// player that their tap was the thing that moved the money — so a chain that
// took two minutes read as a button that had not worked, and pressing it again
// looked like the fix. The modal now watches instead, and says so.
function _setGramDepositState(state, msg, intent) {
  _gramDepositState = state;
  const el = document.getElementById('gram-dep-code');
  if (!el) { _gramDepositState = 'idle'; return; }
  const form = document.getElementById('gram-dep-form');
  // The deadline belongs to the code, and every branch below either redraws
  // it or replaces it wholesale. Stopping the ticker here — once, for all of
  // them — is what keeps an interval from outliving its element.
  _gramStopDeadline();

  if (state === 'loading') {
    el.innerHTML = `<div class="gram-dep-panel gram-dep-panel-center">
      <span class="gram-spinner"></span>
      <div class="gram-dep-panel-sub">${t('depositCodeLoadingLbl')}</div>
    </div>`;
  } else if (state === 'error') {
    el.innerHTML = `<div class="gram-warn" style="margin-top:6px">${_esc(msg || t('depositCodeErrorMsg'))}</div>
      <button class="gram-btn" style="width:100%;padding:12px;margin-top:10px;background:rgba(209,204,197,.06);border:1px solid rgba(209,204,197,.15);color:#d1ccc5" onclick="_requestGramDepositCode()">${t('depositRetryBtn')}</button>`;
  } else if (state === 'sent' || state === 'slow') {
    // ── signed, not yet credited ──────────────────────────────────────────
    // The gap the owner was pointing at. This used to be closeGramModal():
    // the player picked an amount, paid from their wallet, came back to the
    // Mini App — and the sheet was gone, which after sending real money reads
    // as "it failed". The sheet stays and says what it is doing instead.
    //
    // The form goes, for the same reason it goes on 'credited': a transfer
    // against this code is already in flight, and a second one signed while
    // the first is confirming is a genuine double payment (tcSendDeposit
    // refuses it for five minutes, but an offer the player has to be refused
    // is worse than no offer).
    const p = _gramSentPending || { amount: 0, memo: window._gramDepositMemo || '' };
    if (form) form.style.display = 'none';
    const slow = state === 'slow';
    el.innerHTML = `<div class="gram-dep-panel gram-dep-panel-center gram-dep-wait${slow ? ' gram-dep-wait-slow' : ''}">
      <span class="gram-wait-chip${slow ? ' gram-wait-chip-slow' : ''}">${slow ? _gramIconClock(28) : '<span class="gram-spinner"></span>'}</span>
      <div class="gram-dep-ok-title">${slow ? t('depositSlowTitle') : t('depositSentTitle')}</div>
      <div class="gram-dep-sent-amount">${tVars('depositSentAmountFmt', { n: _gramFmtAmount(p.amount) })}</div>
      ${p.memo ? `<div class="gram-dep-sent-memo">${tVars('depositSentCodeFmt', { n: _esc(p.memo) })}</div>` : ''}
      <div class="gram-dep-panel-sub">${slow ? t('depositSlowDesc') : t('depositSentDesc')}</div>
      <div class="gram-hint" style="margin-top:10px;line-height:1.5">${slow ? t('depositSlowNote') : t('depositSafeNote')}</div>
      <button class="gram-btn" style="width:100%;padding:13px;margin-top:14px;background:rgba(209,204,197,.06);border:1px solid rgba(209,204,197,.15);color:#d1ccc5" onclick="closeGramModal()">${t('depositDoneBtn')}</button>
    </div>`;
  } else if (state === 'credited') {
    // The moment the whole redesign exists for. The form and the code are gone
    // — that code is spent, and leaving it on screen invites a second transfer
    // against an intent that is already closed.
    const c = _gramLastCredit || { amount: 0, balance: window._gramBalance || 0, txHash: '' };
    if (form) form.style.display = 'none';
    el.innerHTML = `<div class="gram-dep-panel gram-dep-panel-center gram-dep-ok">
      <span class="gram-credit-chip gram-credit-chip-lg">${_gramIconCheck(30)}</span>
      <div class="gram-dep-ok-title">${t('depositCreditedTitle')}</div>
      <div class="gram-dep-ok-amount">${tVars('depositCreditedAmountFmt', { n: _gramFmtAmount(c.amount) })}</div>
      <div class="gram-dep-panel-sub">${tVars('depositNewBalanceFmt', { n: _gramFmtAmount(c.balance) })}</div>
      ${c.txHash ? `<div class="gram-dep-ok-hash">${t('depositTxHashLbl')} ${_esc(_shortenTonAddr(c.txHash))}</div>` : ''}
      <button class="gram-btn gram-btn-green" style="width:100%;padding:13px;margin-top:14px" onclick="closeGramModal()">${t('depositDoneBtn')}</button>
      <button class="gram-dep-again" onclick="_gramDepositAgain()">${t('depositAnotherBtn')}</button>
    </div>`;
  } else {
    const min = window._gramDepositMin;
    if (form) form.style.display = '';
    el.innerHTML = `
      ${_gramCopyRow(t('transferToWalletHint'), 'gram-addr-val', _esc(intent.address))}
      ${_gramCopyRow(t('memoRequiredHint'), 'gram-memo-val', _esc(intent.memo), 'code')}

      <!-- Filled by _gramStartDeadline below, and rewritten every second
           after that. Rendered empty here rather than with the first frame
           of the countdown baked in, so there is exactly one function that
           decides what this block says. -->
      <div class="gram-dep-deadline" id="gram-dep-deadline"></div>

      <div class="gram-warn">${t('memoWarnHint')}</div>

      <!-- The watching state, ported from Rewardix's DepositSheet. Nothing is
           ever lost while we wait — the scanner's watermark holds through an
           API outage and credits everything once it recovers — and the panel
           has to SAY so, or a slow confirmation reads as "my money vanished".
           It also says the window can be closed, because the credit arrives on
           a socket push that does not care whether anyone is looking. -->
      <div class="gram-dep-watch">
        <span class="gram-spinner gram-spinner-sm"></span>
        <div>
          <div class="gram-dep-watch-title">${t('depositWatchingTitle')}</div>
          <div class="gram-dep-watch-sub">${t('depositWatchingDesc')}</div>
        </div>
      </div>
      <div class="gram-hint" style="margin-top:8px">${t('depositSafeNote')}</div>
      ${min ? `<div class="gram-hint" style="margin-top:4px">${tVars('depositMinAmountFmt', { n: min })}</div>` : ''}`;
    // After the innerHTML above, because that is the write that creates the
    // node this ticks into.
    _gramStartDeadline(intent && intent.expiresAt);
    // The server's floor, on the field, now that it is known.
    const amt = document.getElementById('gram-dep-amount');
    if (amt && min) amt.min = String(min);
  }

  // Never while a transfer is settled or in flight: the wallet button sends
  // against a code that has just been spent, or one that is already carrying
  // money through the chain.
  if (state !== 'credited' && state !== 'sent' && state !== 'slow') _renderTonDepositSection();
}

// ── the transfer left the wallet ────────────────────────────────────────────
// Called by _tcDepositSend the moment TON Connect says the player approved and
// signed. It is NOT a credit — the money is on the chain and the scanner has
// not seen it yet — so everything this puts on screen has to be about waiting.
//
// Survives the trip to the wallet app for the plain reason that nothing tears
// it down any more: the modal is a node under document.body, the visibility
// handlers in js/game.js and js/network.js resync the world and the socket
// without touching it, and this function no longer closes it.
function _gramDepositSent(amount, memo) {
  _gramSentPending = { amount, memo: memo || window._gramDepositMemo || '' };
  clearTimeout(_gramSlowTimer);
  _gramSlowTimer = setTimeout(() => {
    // Only from 'sent'. A credit that landed meanwhile has already moved the
    // panel on, and rewriting it back to "задерживается" over money that
    // arrived is the one wrong answer a player will act on.
    if (_gramDepositState !== 'sent') return;
    console.info('[wallet] deposit not credited after ' + (GRAM_DEPOSIT_SLOW_MS / 1000) + 's, memo ' + _gramSentPending?.memo);
    _setGramDepositState('slow');
  }, GRAM_DEPOSIT_SLOW_MS);
  // The sheet can genuinely be gone — the overlay closes on a tap outside, and
  // the wallet's own modal sat on top of it for as long as the player took.
  // Then there is nowhere to draw the waiting state, and a confirmation the
  // player never sees is money sent into silence.
  if (!document.getElementById('gram-dep-code')) {
    _gramMsg(t('tcTxSentToast'), 'ok');
    return;
  }
  _setGramDepositState('sent');
}

// "Пополнить ещё" from the success state. A fresh code, not the spent one —
// the server's intent is closed the moment it credits, so reusing the memo on
// screen would produce a transfer that lands in unmatched_deposits.
function _gramDepositAgain() {
  window._gramDepositMemo = null;
  window._gramDepositAddress = null;
  window._gramDepositMin = null;
  _gramLastCredit = null;
  // The previous transfer is finished with. Leaving its amount and code behind
  // would let the slow timer fire into a panel about a deposit that already
  // credited.
  _gramSentPending = null;
  clearTimeout(_gramSlowTimer);
  const amt = document.getElementById('gram-dep-amount');
  if (amt) amt.value = '';
  _requestGramDepositCode();
}

// Fills #ton-deposit-send-wrap inside the (currently open) deposit modal:
// a connect prompt if no wallet is linked yet, or a one-tap "send from
// wallet" button that fires an actual on-chain transfer once one is. The
// manual copy-paste address/memo boxes below stay available either way —
// TON Connect only makes *sending* easier.
//
// It is gated on the same code the copy-paste box shows, and that is the whole
// point of the gate: this button builds the on-chain comment cell itself
// (tcSendDeposit, js/tonconnect.js), so a version of it that could fire before
// the code arrived would send a real transfer with an empty comment — money on
// the chain that nothing can trace back to an account. Both ways of paying
// carry the server's code or neither of them works.
function _renderTonDepositSection() {
  const el = document.getElementById('ton-deposit-send-wrap');
  if (!el) return;
  if (!window._gramDepositMemo) { el.innerHTML = ''; return; }
  // tcAddress() and NOT the linked address, deliberately. Sending needs a
  // signature, and only this browser's TON Connect session can produce one —
  // a linked address says where this account's money goes, not that anything
  // here can move it.
  const addr = typeof tcAddress === 'function' ? tcAddress() : null;
  if (!addr) {
    // A player who has just read «Кошелёк привязан» two rows up and is then
    // offered a bare «Подключить кошелёк» concludes the button is broken. The
    // prompt names the DEVICE when there is an account-level link to contrast
    // it with.
    const linked = window._linkedWallet || null;
    const why = linked
      ? `<div class="gram-hint" style="text-align:center;margin-bottom:8px">${t('tcNoSessionHere')}</div>`
      : '';
    el.innerHTML = why + `<button class="gram-btn" style="width:100%;padding:12px;background:rgba(209,204,197,.06);border:1px solid rgba(209,204,197,.15);color:#d1ccc5;margin-bottom:10px" onclick="tcConnect()">${linked ? t('tcConnectHereBtn') : t('tcConnectBtn')}</button>
      <div class="gram-hint" style="text-align:center;margin-bottom:10px">${t('tcOrManualHint')}</div>`;
    return;
  }
  // An empty field used to render "Отправить 0 GRAM из кошелька" on a live
  // button — an offer to send nothing, which _tcDepositSend then refuses. The
  // button now asks for the amount instead, and is disabled until there is one
  // worth sending, so the refusal is prevented rather than reported.
  const raw = document.getElementById('gram-dep-amount')?.value || '';
  const value = parseFloat(raw);
  const min = window._gramDepositMin || 0;
  const ready = Number.isFinite(value) && value > 0 && value >= min;
  el.innerHTML = `<button id="ton-deposit-send-btn" class="gram-btn gram-btn-green" style="width:100%;padding:13px;margin-bottom:10px${ready ? '' : ';opacity:.45'}" ${ready ? '' : 'disabled '}onclick="_tcDepositSend()">${ready ? tVars('tcSendFromWalletFmt', { n: _gramFmtAmount(value) }) : t('enterGramAmountPlaceholder')}</button>
    <div class="gram-hint" style="text-align:center;margin-bottom:10px">${t('tcOrManualHint')}</div>`;
}

// Sends the entered amount as a real on-chain transfer from the connected
// wallet, carrying the server's code as the on-chain comment — the same code
// the copy-paste box shows. Nothing is registered afterwards: the intent that
// makes this transfer creditable already exists (it is what issued the code),
// and emitting anything here would mint a SECOND one.
async function _tcDepositSend() {
  const memo = window._gramDepositMemo;
  const wallet = window._gramDepositAddress;
  // Belt and braces with the render gate above: this is the last line before a
  // real transfer leaves a real wallet, and a transfer with no comment cannot
  // be matched to anyone afterwards.
  if (!memo || !wallet) { _gramModalMsg(t('depositCodeWaitToast'), 'err'); return; }
  // ── this device cannot sign ──────────────────────────────────────────────
  // The render above hides the button when there is no session, and that is
  // not enough. The sheet stays open across a round trip to the wallet app, a
  // session can be dropped while it is open, and tcSendDeposit's own throw
  // arrives here as the generic «Не удалось отправить транзакцию» — telling a
  // player their transfer failed when nothing was ever attempted, and naming
  // no way to fix it.
  //
  // A LINKED ADDRESS IS NOT A SESSION. On the desktop the account can be
  // linked, the card correctly says so, and this browser still cannot move a
  // single nanoton — so the refusal names the device, and the panel is redrawn
  // with the connect prompt the player can actually act on.
  const local = typeof tcAddress === 'function' ? tcAddress() : null;
  if (!local) {
    _gramModalMsg(t('tcNoLocalSessionMsg'), 'err');
    // Into player_logs as `client:tcDepositSend`, the same reporter every other
    // client-side failure uses. A refusal that only ever existed as a toast is
    // a refusal nobody can count, and how often a player reaches the send
    // button with no session is the only way to find out whether the card is
    // still lying somewhere.
    if (typeof window.__reportClientError === 'function') {
      window.__reportClientError('tcDepositSend', 'send refused: no TON Connect session on this device');
    }
    _renderTonDepositSection();
    return;
  }
  const min = window._gramDepositMin || 0;
  const amount = parseFloat(document.getElementById('gram-dep-amount')?.value);
  if (!amount || amount < min) {
    _gramModalMsg(min ? tVars('depositMinAmountFmt', { n: min }) : t('tcEnterAmountFirstToast'), 'err');
    return;
  }
  if (typeof tcSendDeposit !== 'function') { _gramModalMsg(t('serviceUnavailableToast'), 'err'); return; }
  const btn = document.getElementById('ton-deposit-send-btn');
  if (btn) { btn.disabled = true; btn.textContent = t('tcSendingLbl'); }
  try {
    await tcSendDeposit(wallet, amount, memo);
    // The sheet STAYS. It used to close here, and that single line is what the
    // player was reporting: paying from the wallet backgrounds the Mini App,
    // sendTransaction resolves the moment they approve, and the first thing
    // they saw on coming back was the sheet folding away. Nothing had failed
    // and nothing said so.
    _gramDepositSent(amount, memo);
  } catch (e) {
    _gramModalMsg(t('tcTxErrorToast'), 'err');
    console.warn('[wallet] deposit send failed:', e);
    if (btn) { btn.disabled = false; _renderTonDepositSection(); }
  }
}

// gramDepositConfirm() — the "Я оплатил" handler — is GONE, along with the
// button. It had already stopped being a request (the record is minted when
// the modal opens, and the chain scanner credits it), so all it did was close
// the modal on a claim only the player could make. Its real cost was what it
// taught: that the tap was what moved the money. A player whose transfer was
// still confirming pressed it, saw nothing change, and pressed it again.
// The modal watches for 'gramDepositCredited' instead — see
// onGramDepositCredited and the 'credited' branch of _setGramDepositState.

// ── Withdraw modal ────────────────────────────────────────
// Mirrors the server's own gate (gramWithdrawRequest, server/index.js), which
// refuses below this level and is what actually enforces it. Said here, on the
// press, because the refusal used to arrive only after the player had opened
// the form, typed an amount and pasted a wallet address — the one moment they
// had already decided the withdrawal was going to happen.
const GRAM_WITHDRAW_VIP_MIN = 3;

function openGramWithdrawModal() {
  const vip = (window._vipData && window._vipData.level) || 0;
  if (vip < GRAM_WITHDRAW_VIP_MIN) {
    _gramMsg(tVars('withdrawVipRequiredFmt', { n: GRAM_WITHDRAW_VIP_MIN }), 'err');
    return;
  }
  const balance = window._gramBalance || 0;
  const html = `
    <div id="gram-modal-overlay" onclick="closeGramModal()" style="position:fixed;inset:0;z-index:400;background:rgba(0,0,0,.75);backdrop-filter:blur(4px);display:flex;align-items:flex-end;justify-content:center;">
      <div onclick="event.stopPropagation()" style="width:100%;max-width:500px;background:#16120a;border-radius:18px 18px 0 0;border-top:1px solid rgba(209,204,197,.1);padding:22px 20px 36px;">
        <div style="display:flex;align-items:center;margin-bottom:18px">
          <div style="font-size:16px;font-weight:800;color:#e5a546">${t('withdrawModalTitle')}</div>
          <button onclick="closeGramModal()" style="margin-left:auto;width:28px;height:28px;border:none;border-radius:50%;background:rgba(209,204,197,.08);color:#968a7a;cursor:pointer">✕</button>
        </div>

        <div style="background:rgba(229,165,70,0.08);border:1px solid rgba(229,165,70,0.2);border-radius:10px;padding:10px 14px;margin-bottom:16px;font-size:13px;color:#ba9865">
          ${tVars('availableFeeFmt', { bal: `<b>${balance.toFixed(7)}</b>` })}
        </div>

        <div style="margin-bottom:12px">
          <div class="gram-hint" style="margin-bottom:6px">${tVars('withdrawAmountHint', { n: GRAM_MIN_WITHDRAW })}</div>
          <input id="gram-wd-amount" type="number" min="${GRAM_MIN_WITHDRAW}" step="0.01" placeholder="${t('gramAmountPlaceholder')}" class="gram-input" style="width:100%;box-sizing:border-box" oninput="_updateWdPreview()">
        </div>
        <div id="gram-wd-preview" style="font-size:12px;color:#a3957c;margin:-6px 0 12px;padding:0 2px"></div>

        <div style="margin-bottom:16px">
          <div class="gram-hint" style="margin-bottom:6px">${t('tonAddrHint')}</div>
          <input id="gram-wd-addr" type="text" placeholder="UQ..." class="gram-input gram-input-addr" style="width:100%;box-sizing:border-box">
          <div id="ton-wd-connect-wrap" style="margin-top:8px"></div>
        </div>

        <button class="gram-btn gram-btn-orange" style="width:100%;padding:14px;font-size:15px" onclick="gramWithdrawConfirm()">
          ${t('submitWithdrawBtn')}
        </button>
        <div id="gram-modal-msg" class="gram-msg" style="display:none;margin-top:10px"></div>
      </div>
    </div>`;
  const div = document.createElement('div');
  div.id = 'gram-modal-wrap';
  div.innerHTML = html;
  document.body.appendChild(div);
  // The ACCOUNT's wallet first, and this is the half of the bug the player
  // notices second: on the desktop this field used to open empty, because the
  // only address the client had was a TON Connect session that lived in the
  // phone's localStorage. It is the same address on every device now.
  const connectedAddr = window._linkedWallet || (typeof tcAddress === 'function' ? tcAddress() : null);
  if (connectedAddr) document.getElementById('gram-wd-addr').value = connectedAddr;
  _renderTonWithdrawConnectHint();
}

// Small "connect wallet to autofill" link shown under the address field
// while no wallet is linked; disappears once one connects (see
// _onWalletStateChange, which re-renders this if the modal is still open).
//
// The account's linked address counts, not just this browser's session: the
// field above is already filled from it, and offering to connect a wallet in
// order to fill a filled field is the desktop being told to fix something that
// is not broken.
function _renderTonWithdrawConnectHint() {
  const el = document.getElementById('ton-wd-connect-wrap');
  if (!el) return;
  const addr = window._linkedWallet || (typeof tcAddress === 'function' ? tcAddress() : null);
  el.innerHTML = addr ? '' : `<button style="background:none;border:none;color:#e5a546;font-size:12px;cursor:pointer;text-decoration:underline;padding:0" onclick="tcConnect()">${t('tcConnectBtn')}</button>`;
}

function _updateWdPreview() {
  const el = document.getElementById('gram-wd-preview');
  if (!el) return;
  const v = parseFloat(document.getElementById('gram-wd-amount')?.value);
  if (!v || v < 10) { el.textContent = ''; return; }
  const fee = Math.round(v * 0.10 * 100) / 100;
  const net = Math.round((v - fee) * 100) / 100;
  el.textContent = tVars('feeReceiveFmt', { fee, net });
}

function gramWithdrawConfirm() {
  const amount = parseFloat(document.getElementById('gram-wd-amount').value);
  const addr   = (document.getElementById('gram-wd-addr').value || '').trim();
  const balance = window._gramBalance || 0;
  if (!amount || amount < GRAM_MIN_WITHDRAW) {
    _gramModalMsg(tVars('minWithdrawToast', { n: GRAM_MIN_WITHDRAW }), 'err'); return;
  }
  if (!addr)                     { _gramModalMsg(t('enterTonAddrToast'), 'err'); return; }
  if (amount > balance)          { _gramModalMsg(t('notEnoughFundsToast'), 'err'); return; }
  if (typeof netGramWithdraw === 'function') {
    netGramWithdraw(amount, addr);
    closeGramModal();
    const net = Math.round((amount - amount * 0.10) * 100) / 100;
    _gramMsg(tVars('withdrawRequestCreatedFmt', { net }), 'ok');
  } else {
    _gramModalMsg(t('serviceUnavailableToast'), 'err');
  }
}

function gramCopy(elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  navigator.clipboard?.writeText(el.textContent.trim()).then(() => {
    el.style.color = '#90d653';
    setTimeout(() => { el.style.color = ''; }, 1000);
  });
}

function closeGramModal() {
  const w = document.getElementById('gram-modal-wrap');
  if (w) w.remove();
  _gramStopDeadline();
  _gramCodeUntil = null;
  // A sheet closed FROM the success panel has already delivered the news —
  // whether by «Готово», the cross, or a tap outside. Leaving _gramLastCredit
  // set would put the identical message back as a banner the moment the
  // wallet tab redraws, which is the loop the owner was stuck in.
  if (_gramDepositState === 'credited') {
    _gramLastCredit = null;
    _renderGramCreditBanner();
  }
  // The deposit code dies with the modal that showed it. Leaving it on window
  // would let a later reopen paint a stale code — matchable or not, it would
  // not be the one this open asked for — and would leave the pending timer
  // firing into a modal that no longer exists.
  clearTimeout(_gramDepositTimer);
  _gramDepositState = 'idle';
  window._gramDepositMemo = null;
  window._gramDepositAddress = null;
  window._gramDepositMin = null;
  // The waiting state dies with the sheet that showed it. The credit does not:
  // it arrives on a socket push and onGramDepositCredited draws it as the
  // floating card instead — which is what the panel promised when it said the
  // window could be closed.
  _gramSentPending = null;
  clearTimeout(_gramSlowTimer);
}

// ── saying something the player can actually see ────────────────────────────
// Both entry points below used to `return` when their own strip was missing
// from the DOM, which is the silent refusal this tab is not allowed to have.
// The strips are missing far more often than it looks:
//
//   #gram-modal-msg  exists only while a deposit/withdraw modal is open
//   #gram-msg        exists only while the WALLET tab specifically is rendered
//
// so a refusal arriving with the player on Друзья, on Язык, or three floors
// down in the dungeon had nowhere to land and was dropped without a trace.
//
// One chooser now picks the best place that is actually on screen, in the only
// order that makes sense: the modal strip first WHENEVER a modal is open —
// even for a message that was not the modal's own — because the modal's
// backdrop is drawn over the panel strip, and a refusal written underneath it
// is a refusal nobody can read.
//
// And it is logged either way. If every target is somehow gone, the message
// still exists somewhere an operator can find it.
function _gramSay(text, type) {
  if (type === 'err') console.warn('[wallet] ' + text);
  else console.info('[wallet] ' + text);
  const cls = 'gram-msg ' + (type === 'err' ? 'gram-msg-err' : 'gram-msg-ok');
  const modal = document.getElementById('gram-modal-msg');
  const strip = document.getElementById('gram-msg');
  const el = modal || strip;
  if (!el) {
    // Nothing on screen belongs to the wallet at all — say it where the player
    // IS. A toast is a worse place for this than a panel strip, and it is
    // infinitely better than nowhere.
    if (typeof _marketToast === 'function') _marketToast(text, type);
    return;
  }
  el.textContent = text;
  el.style.display = 'block';
  el.className = cls;
  // Only the panel strip auto-hides. The modal's own strip is removed with the
  // modal, and hiding it early would take the reason away while the player is
  // still looking at the thing that refused.
  if (el === strip) {
    clearTimeout(_gramSay._t);
    _gramSay._t = setTimeout(() => { if (el) el.style.display = 'none'; }, 5000);
  }
}

function _gramModalMsg(text, type) { _gramSay(text, type); }
function _gramMsg(text, type) { _gramSay(text, type); }

// ── "What's new" login modal ─────────────────────────────────────────────
// Shown once per WHATS_NEW_VERSION (js/network.js's _finishOnlineStart calls
// this on a genuine first join, gated on the localStorage flag below) — a
// centered dialog rather than the market panel's bottom sheet, since this is
// a one-shot announcement, not a repeated in-flow action. Reuses
// .market-modal-overlay for the backdrop (blur + touch-action fix already
// there) with .whatsnew-modal-sheet overriding it to a centered, full-radius
// box instead of a bottom sheet — see css/style.css.
//
// A glowing icon badge (real SVG, matching every other icon in this game)
// stands in for the emoji the previous version used inline in the title
// text — consistent with the rest of the UI, which never uses emoji as an
// icon, and the badge/eyebrow/display-font title read as a considered
// moment rather than a plain text popup.
const WHATS_NEW_VERSION = 'codex1';
const WHATS_NEW_ICON = 'chest';
function openWhatsNewModal() {
  const existing = document.getElementById('whatsnew-ov');
  if (existing) existing.remove();
  const ov = document.createElement('div');
  ov.className = 'market-modal-overlay whatsnew-modal-overlay';
  ov.id = 'whatsnew-ov';
  ov.onclick = () => closeWhatsNewModal();
  ov.innerHTML = `
    <div class="market-modal-sheet whatsnew-modal-sheet" onclick="event.stopPropagation()">
      <div class="whatsnew-hero">
        <button class="whatsnew-close" onclick="closeWhatsNewModal()">✕</button>
        <div class="whatsnew-badge">${iconHTML(WHATS_NEW_ICON, 28, '#c9a6f0')}</div>
        <div class="whatsnew-eyebrow">${t('whatsNewTitle')}</div>
        <div class="whatsnew-title">${t('whatsNewCodexTitle')}</div>
      </div>
      <div class="whatsnew-body">
        <div class="whatsnew-desc">${t('whatsNewCodexDesc')}</div>
        <button class="whatsnew-cta" onclick="closeWhatsNewModal()">${t('whatsNewCloseBtn')}</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
}

function closeWhatsNewModal() {
  const ov = document.getElementById('whatsnew-ov');
  if (ov) ov.remove();
  try { localStorage.setItem('whatsNewSeen', WHATS_NEW_VERSION); } catch (_) {}
}
