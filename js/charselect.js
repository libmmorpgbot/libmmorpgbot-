// ── Character Select ──────────────────────────────────────────

const _CS_TYPES = ['lev', 'deathknight', 'ranger', 'mage', 'warlock'];
const _CS_CARD_GAP = 150; // px between adjacent card centers in the carousel

let _csRAF = null;
let _csState = {};
let _csActiveType = 'lev';
let _csSavedData  = null;
let _csDragWired  = false;

// Emoji prefixes are language-neutral; only the trailing word is translated
// (see js/i18n.js's csBadgeMelee/csBadgeRanged/csBadgeSupport).
const _CS_BADGE_EMOJI = { lev: '🛡', deathknight: '💀', ranger: '🏹', mage: '✨', warlock: '💜' };
const _CS_BADGE_KEY = {
  lev:         'csBadgeMelee',
  deathknight: 'csBadgeMelee',
  ranger:      'csBadgeRanged',
  mage:        'csBadgeRanged',
  warlock:     'csBadgeSupport',
};
function _csBadgeText(type) {
  return _CS_BADGE_EMOJI[type] + ' ' + (typeof t === 'function' ? t(_CS_BADGE_KEY[type]) : '');
}

// Max values for bar scaling
const _CS_STAT_MAX = { hp: 200, atk: 9, def: 10, spd: 205, as: 1.2 };

function _csSetBar(id, valId, value, max) {
  const fill = document.getElementById(id);
  const lbl  = document.getElementById(valId);
  if (fill) fill.style.width = Math.round(Math.min(1, value / max) * 100) + '%';
  if (lbl)  lbl.textContent  = typeof value === 'number' && value % 1 !== 0 ? value.toFixed(2) : value;
}

function _csBuildSkills(type) {
  const list = document.getElementById('cs-skills-list');
  if (!list) return;
  const skills = SKILL_DEF[type];
  if (!skills) { list.innerHTML = ''; return; }
  list.innerHTML = skills.map(sk => `
    <div class="cs-skill">
      ${sk.img
        ? `<img src="${sk.img}" width="32" height="32" style="image-rendering:pixelated;border-radius:6px;flex-shrink:0">`
        : `<div class="cs-skill-key">${sk.key}</div>`}
      <div class="cs-skill-body">
        <div class="cs-skill-name">${sk.name}</div>
        <div class="cs-skill-desc">${sk.desc}</div>
        <div class="cs-skill-cd">${typeof t === 'function' ? t('csCooldown') : 'Кулдаун'}: ${sk.cd} ${typeof t === 'function' ? t('csCooldownSec') : 'сек'}</div>
      </div>
    </div>`).join('');
}

function _csSwitchChar(type) {
  _csActiveType = type;
  const cd = CHAR_DEF[type];

  // Dots
  document.querySelectorAll('.cs-dot').forEach(d => {
    d.classList.toggle('active', d.dataset.type === type);
  });

  _csRenderCarousel();

  // Name + badge
  const nameEl  = document.getElementById('cs-active-name');
  const badgeEl = document.getElementById('cs-active-badge');
  if (nameEl)  { nameEl.textContent = cd.name; nameEl.style.color = cd.color; }
  if (badgeEl) { badgeEl.textContent = _csBadgeText(type); }

  // Stat bars
  _csSetBar('cs-bar-hp',  'cs-val-hp',  cd.baseHP,    _CS_STAT_MAX.hp);
  _csSetBar('cs-bar-atk', 'cs-val-atk', cd.baseAtk,   _CS_STAT_MAX.atk);
  _csSetBar('cs-bar-def', 'cs-val-def', cd.baseDef,    _CS_STAT_MAX.def);
  _csSetBar('cs-bar-spd', 'cs-val-spd', cd.speed,      _CS_STAT_MAX.spd);
  _csSetBar('cs-bar-as',  'cs-val-as',  cd.atkSpeed,   _CS_STAT_MAX.as);

  // Skills list
  _csBuildSkills(type);

  // Button
  const btn = document.getElementById('cs-btn-active');
  if (btn) {
    btn.className = 'cs-btn cs-btn-' + type;
    if (_csSavedData && _csSavedData.type === type) {
      const continueLbl = typeof t === 'function' ? t('csContinue') : 'Продолжить';
      btn.textContent = '▶ ' + continueLbl + ' · Ур.' + (_csSavedData.lvl || 1) + ' · ' + (_csSavedData.gold || 0) + 'g';
      btn.classList.add('cs-resume');
    } else {
      btn.textContent = typeof t === 'function' ? t('csCreateChar') : 'Создать персонажа';
    }
    btn.onclick = () => selectChar(type);
  }
}

// ── Carousel: active card centered, neighbors peeking at the edges ───────
function _csIndexOf(type) { return _CS_TYPES.indexOf(type); }

// Shortest circular distance from index `a` to `b` over the 5-class ring
// (e.g. lev→warlock is -1, not +4) — lets the carousel wrap both ways.
function _csShortestDelta(a, b) {
  const n = _CS_TYPES.length;
  let d = (b - a) % n;
  if (d > n / 2) d -= n;
  if (d < -n / 2) d += n;
  return d;
}

function _csRenderCarousel(dragPx) {
  const activeIdx = _csIndexOf(_csActiveType);
  document.querySelectorAll('.cs-card').forEach(card => {
    const idx = _csIndexOf(card.dataset.type);
    const delta = _csShortestDelta(activeIdx, idx);
    const ad = Math.abs(delta);
    const x = delta * _CS_CARD_GAP + (dragPx || 0);
    const scale = ad === 0 ? 1 : ad === 1 ? 0.66 : 0.46;
    const opacity = ad === 0 ? 1 : ad === 1 ? 0.45 : 0;
    card.style.transform = `translate(-50%,-50%) translateX(${x}px) scale(${scale})`;
    card.style.opacity = opacity;
    card.style.zIndex = 10 - ad;
    card.classList.toggle('cs-peek', ad === 1);
    card.style.pointerEvents = ad <= 1 ? 'auto' : 'none';
  });
}

function _csGoTo(type) {
  if (!CHAR_DEF[type] || type === _csActiveType) return;
  _csSwitchChar(type);
}
function _csPrev() { _csGoTo(_CS_TYPES[(_csIndexOf(_csActiveType) - 1 + _CS_TYPES.length) % _CS_TYPES.length]); }
function _csNext() { _csGoTo(_CS_TYPES[(_csIndexOf(_csActiveType) + 1) % _CS_TYPES.length]); }

// Swipe/drag on the stage — live-follows the finger, then either commits to
// the neighboring card or snaps back, same threshold feel as a native carousel.
function _csWireDrag() {
  if (_csDragWired) return;
  _csDragWired = true;
  const stage = document.getElementById('cs-stage');
  if (!stage) return;
  let dragging = false, startX = 0, curX = 0, justDragged = false;

  const onDown = x => { dragging = true; startX = x; curX = x; };
  const onMove = x => {
    if (!dragging) return;
    curX = x;
    // Committing the drag re-snaps every card into its post-navigation spot
    // *before* the browser's own follow-up 'click' event fires on whatever
    // now sits under the pointer — without this flag that click lands on a
    // peek card that just slid into place and immediately navigates again,
    // undoing the swipe. Any real movement (not just past the nav threshold)
    // sets it, so a drag never leaves a stray click behind.
    if (Math.abs(curX - startX) > 5) justDragged = true;
    _csRenderCarousel((curX - startX) * 0.9);
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    const dx = curX - startX;
    if (Math.abs(dx) > 46) { dx > 0 ? _csPrev() : _csNext(); }
    else _csRenderCarousel();
  };

  stage.addEventListener('mousedown', e => onDown(e.clientX));
  window.addEventListener('mousemove', e => onMove(e.clientX));
  window.addEventListener('mouseup', onUp);
  stage.addEventListener('touchstart', e => onDown(e.touches[0].clientX), { passive: true });
  stage.addEventListener('touchmove', e => onMove(e.touches[0].clientX), { passive: true });
  stage.addEventListener('touchend', onUp);

  // Peek cards (immediate neighbors) are clickable shortcuts straight to that class
  document.querySelectorAll('.cs-card').forEach(card => {
    card.addEventListener('click', () => {
      if (justDragged) { justDragged = false; return; }
      if (card.classList.contains('cs-peek')) _csGoTo(card.dataset.type);
    });
  });
}

function csShow(savedData) {
  _csSavedData = savedData || null;
  const el = document.getElementById('char-select');
  if (!el) return;
  el.style.display = 'flex';
  // Restore any children hidden by the auto-load path
  Array.from(el.children).forEach(child => { child.style.display = ''; });
  const loadEl = document.getElementById('cs-loading');
  if (loadEl) loadEl.style.display = 'none';

  // Load sprite previews for all types
  _CS_TYPES.forEach(type => {
    if (SPRITE_DEF[type]) loadSpritePreviewFrame(type);
    if (!_csState[type]) _csState[type] = { frame: 0, timer: 0 };
  });

  // Default to saved type, or lev — falls back to lev too if the save
  // points at a class that no longer exists (e.g. an older account whose
  // saved type was one of the classes retired when this roster shipped).
  const savedType = savedData && savedData.type;
  const startType = (savedType && CHAR_DEF[savedType]) ? savedType : 'lev';
  _csSwitchChar(startType);
  _csWireDrag();
  _csStartAnim();
}

function csHide() {
  _csStopAnim();
  const el = document.getElementById('char-select');
  if (el) el.style.display = 'none';
}

function _csStartAnim() {
  if (_csRAF) return;
  let last = performance.now();
  function tick(now) {
    const el = document.getElementById('char-select');
    if (!el || el.style.display === 'none') { _csRAF = null; return; }
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    // The carousel keeps the active card plus its two peeking neighbors
    // visible at once, so all of them need to keep animating, not just
    // whichever one is currently centered.
    _CS_TYPES.forEach(type => _csDrawFrame(type, dt));
    _csRAF = requestAnimationFrame(tick);
  }
  _csRAF = requestAnimationFrame(tick);
}

function _csStopAnim() {
  if (_csRAF) { cancelAnimationFrame(_csRAF); _csRAF = null; }
}

function _csDrawFrame(type, dt) {
  const canvas = document.getElementById('cs-canvas-' + type);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const s = _csState[type] || (_csState[type] = { frame: 0, timer: 0 });
  const fps = 7;
  const animDef = SPRITE_DEF[type]?.anims['front-idle'];
  const totalFrames = animDef ? animDef.n : 16;

  s.timer += dt;
  while (s.timer >= 1 / fps) {
    s.timer -= 1 / fps;
    s.frame = (s.frame + 1) % totalFrames;
  }

  const img = spriteCache[type]?.['front-idle'];
  if (img && _sheetReady(img) && animDef) {
    const def = SPRITE_DEF[type];
    const fw = img.frameW || def.frameW, fh = img.frameH || def.frameH;
    const col = s.frame % animDef.cols;
    const row = Math.floor(s.frame / animDef.cols);
    ctx.drawImage(img, col * fw, row * fh, fw, fh, 0, 0, W, H);
    return;
  }

  // Fallback: animated circle with bob + emoji
  const def = CHAR_DEF[type];
  const cx = W / 2, cy = H / 2;
  const r = Math.min(W, H) * 0.28;
  const bob = Math.sin(s.frame * 0.45) * 4;

  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  ctx.beginPath();
  ctx.ellipse(cx, cy + r + 6 - bob * 0.3, r * 0.55, r * 0.16, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = def.color + 'aa';
  ctx.beginPath();
  ctx.arc(cx, cy - bob, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = def.color;
  ctx.lineWidth = 3;
  ctx.stroke();

  drawIconCtx(ctx, def.icon, cx, cy - bob + 2, r * 1.8, def.color);
}

// ── Loading gate ──────────────────────────────────────────────

let _csGateSprites = false;
let _csGateServer  = false;
let _csGateCb      = null;

function csStartLoading(type, onReady) {
  _csGateSprites = false;
  _csGateServer  = false;
  _csGateCb      = onReady;

  const def    = CHAR_DEF[type];
  const loadEl = document.getElementById('cs-loading');
  if (loadEl) loadEl.style.display = 'flex';

  const emojiEl = document.getElementById('csl-emoji');
  const nameEl  = document.getElementById('csl-name');
  if (emojiEl) emojiEl.innerHTML = iconHTML(def.icon, 60, def.color);
  if (nameEl)  nameEl.textContent  = def.name;

  csSetStatus(typeof t === 'function' ? t('csLoadingSprites') : 'Загрузка спрайтов...');
}

// Same two-gate loading overlay as csStartLoading (first login), reused for
// a mid-session floor transition (netEnterLocation, js/network.js) — no
// character to show here, just the destination's own label/icon in place of
// the class icon/name. Unlike csStartLoading, #char-select itself is hidden
// at this point (_finishOnlineStart already ran) — show it again as a bare
// backdrop for #cs-loading (same trick _showCharSelect uses for the very
// first load) and let onReady's caller csHide() it again when done.
function csStartFloorLoading(label, icon, onReady) {
  _csGateSprites = false;
  _csGateServer  = false;
  _csGateCb      = onReady;

  const csEl = document.getElementById('char-select');
  if (csEl) {
    csEl.style.display = 'flex';
    Array.from(csEl.children).forEach(child => {
      if (child.id !== 'cs-loading') child.style.display = 'none';
    });
  }
  const loadEl = document.getElementById('cs-loading');
  if (loadEl) loadEl.style.display = 'flex';

  const emojiEl = document.getElementById('csl-emoji');
  const nameEl  = document.getElementById('csl-name');
  if (emojiEl) emojiEl.innerHTML = icon || '🗺️';
  if (nameEl)  nameEl.textContent  = label || '';

  csSetStatus(typeof t === 'function' ? t('csLoadingSprites') : 'Загрузка спрайтов...');
}

function csSetStatus(text) {
  const el = document.getElementById('csl-status');
  if (el) el.textContent = text;
}

function csOnSpritesReady() {
  _csGateSprites = true;
  if (!_csGateServer) csSetStatus(typeof t === 'function' ? t('csWaitingServer') : 'Ожидание сервера...');
  _csCheckGate();
}

function csOnServerReady() {
  _csGateServer = true;
  if (!_csGateSprites) csSetStatus(typeof t === 'function' ? t('csLoadingSprites') : 'Загрузка спрайтов...');
  _csCheckGate();
}

// ── the transition the server refused ───────────────────────────────────────
// The overlay this puts up is gated on csOnServerReady, and the only thing
// that calls it is a gameStart arriving. A refused enterLocation sends a
// locationError instead and no gameStart ever comes — so the player sat on a
// full-screen "Ожидание сервера..." for the rest of the session, over a
// portal that had simply said no. That is worse than a button doing nothing:
// the game is gone.
//
// The gate callback is run rather than discarded on purpose. It is the
// caller's own release (`_floorChangePending = false`, js/game.js), and
// running it is what lets them try the portal again — dropping it would trade
// a stuck overlay for a pad that never fires a second time.
function csCancelFloorLoading() {
  // Nothing gated, nothing to cancel. The gate is SHARED with character
  // creation (csStartLoading above), and a refusal that arrived while nothing
  // was in flight must not take that screen down with it — a refused portal
  // cannot reach a player who has not chosen a character yet, and this is what
  // keeps that true if one ever could.
  const cb = _csGateCb;
  if (!cb) return;
  _csGateCb = null;
  _csGateSprites = false;
  _csGateServer = false;
  try { cb(); } catch (_e) { /* the overlay comes down either way */ }
  csHide();
}

function _csCheckGate() {
  if (_csGateSprites && _csGateServer && _csGateCb) {
    csSetStatus(typeof t === 'function' ? t('csStarting') : 'Запуск!');
    const cb = _csGateCb;
    _csGateCb = null;
    setTimeout(cb, 180);
  }
}
