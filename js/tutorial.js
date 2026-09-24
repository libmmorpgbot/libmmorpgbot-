// ── Обучение новичка ─────────────────────────────────────────────────────────
// Цепочка шагов-заданий поверх обычной игры: карточка с текущим шагом и
// пульсирующее кольцо над тем, куда нажать (вкладка, кнопка HUD, портал в
// мире). Шаг засчитывается сам, когда игрок делает то, о чём он просит, —
// сравнением с тем, что было на старте шага (убийства, улучшения, надетые
// вещи…). Там, где сделать это прямо сейчас может быть нечем (нет книги
// навыка, нет вещи), есть кнопка «Понятно».
//
// Всё — на клиенте. Награды нет, серверу считать нечего; состояние лежит в
// localStorage под ключом аккаунта (_tgUserId), так что второй аккаунт на том
// же телефоне начинает обучение сам. У кого сохранения нет, но уровень уже
// ≥ TUT_VETERAN_LVL, обучение не показывается вовсе — это старые игроки,
// которые зашли с нового устройства.
//
// Запускается из _finishOnlineStart (js/network.js) — единственного пути
// первого входа; переподключения и переходы между этажами туда не заходят.

const TUT_VETERAN_LVL = 10;
const TUT_TARGET_LVL = 10;
const TUT_KILLS = 5;
const TUT_MOVE_PX = 150;

function _tutUpgradeSum() {
  const u = (player && player.upgrades) || {};
  let s = 0;
  for (const k in u) s += +u[k] || 0;
  return s;
}
function _tutSkillSum() {
  const s = (player && player.skillLevels) || {};
  return (s.Q || 0) + (s.W || 0) + (s.E || 0) + (s.R || 0);
}
function _tutEquipKey() {
  const e = (player && player.equipment) || {};
  return Object.keys(e).map(k => {
    const it = e[k];
    return it ? k + ':' + (it.uid || it.id || '1') : '';
  }).join('|');
}
function _tutOnHub() { return !!(dungeon && dungeon.armEntries); }

// Каждый шаг: tab — на какой вкладке нижнего меню он делается; start() —
// снимок на старте шага (хранится в сохранении, чтобы прогресс пережил
// перезагрузку); done(base) — засчитан ли; progress(base) — «3/5» для
// карточки; target(base) — что подсветить, когда игрок уже на нужной вкладке;
// ack — можно ли пройти кнопкой «Понятно».
const TUT_STEPS = [
  {
    id: 'lang', tab: 5, ack: true,
    target: () => ({ el: 'ptab-lang' }),
    done: () => activeTab === 5 && window._profileTab === 'lang',
  },
  {
    id: 'move', tab: 0,
    start: () => ({ x: player.x, y: player.y }),
    done: b => Math.hypot(player.x - b.x, player.y - b.y) >= TUT_MOVE_PX,
    target: () => ({ joy: true }),
  },
  {
    id: 'portal', tab: 0,
    done: () => !!dungeon && !_tutOnHub(),
    target: () => (typeof _portalPad !== 'undefined' && _portalPad) ? { world: _portalPad } : null,
  },
  {
    id: 'kill', tab: 0,
    start: () => ({ k: player.kills || 0 }),
    done: b => (player.kills || 0) - b.k >= TUT_KILLS,
    progress: b => Math.min(TUT_KILLS, (player.kills || 0) - b.k) + '/' + TUT_KILLS,
    target: () => ({ hud: 'attack' }),
  },
  {
    id: 'potion', tab: 0, ack: true,
    start: () => ({ p: (player.potionBag && player.potionBag.pt1) || 0 }),
    done: b => ((player.potionBag && player.potionBag.pt1) || 0) < b.p,
    target: () => ({ hud: 'potion' }),
  },
  {
    id: 'quests', tab: 3,
    done: () => activeTab === 3,
    target: () => null,
  },
  {
    id: 'upgrade', tab: 1, ack: true,
    start: () => ({ u: _tutUpgradeSum() }),
    done: b => _tutUpgradeSum() > b.u,
    target: () => (typeof _invTab !== 'undefined' && _invTab !== 1) ? { el: 'inv-tab-1' } : null,
  },
  {
    id: 'equip', tab: 1, ack: true,
    start: () => ({ e: _tutEquipKey() }),
    done: b => _tutEquipKey() !== b.e,
    target: () => (typeof _invTab !== 'undefined' && _invTab !== 0) ? { el: 'inv-tab-0' } : null,
  },
  {
    id: 'skill', tab: 1, ack: true,
    start: () => ({ s: _tutSkillSum() }),
    done: b => _tutSkillSum() > b.s,
    target: () => (typeof _invTab !== 'undefined' && _invTab !== 2) ? { el: 'inv-tab-2' } : null,
  },
  {
    id: 'level', tab: 0, ack: true,
    done: () => (player.lvl || 1) >= TUT_TARGET_LVL,
    progress: () => Math.min(TUT_TARGET_LVL, player.lvl || 1) + '/' + TUT_TARGET_LVL,
    target: () => null,
  },
  {
    id: 'final', tab: null, ack: true, last: true,
    done: () => false,
    target: () => null,
  },
];

// { step, base, off, min } — off: обучение закончено или пропущено.
let _tut = null;
let _tutRaf = 0;
let _tutRendered = '';     // ключ последней отрисовки карточки
let _tutJustDone = 0;      // время, до которого карточка показывает «Готово!»

function _tutKey() {
  const id = (typeof _tgUserId === 'function') ? _tgUserId() : '';
  return 'tut_v1_' + (id || 'local');
}
function _tutSave() {
  try { localStorage.setItem(_tutKey(), JSON.stringify(_tut)); } catch (_) {}
}
function _tutLoad() {
  try {
    const raw = localStorage.getItem(_tutKey());
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

function tutorialStart() {
  if (!player) return;
  _tut = _tutLoad();
  if (!_tut) {
    _tut = { step: 0, base: null, off: (player.lvl || 1) >= TUT_VETERAN_LVL, min: false };
    _tutSave();
  }
  if (_tut.off) { _tutHide(); return; }
  if (!(_tut.step >= 0 && _tut.step < TUT_STEPS.length)) _tut.step = 0;
  if (!_tut.base) _tutBeginStep();
  _tutRendered = '';
  if (!_tutRaf) _tutRaf = requestAnimationFrame(_tutFrame);
}

// Из профиля — «Пройти обучение заново».
function tutorialRestart() {
  _tut = { step: 0, base: null, off: false, min: false };
  const box = document.getElementById('tut-card');
  if (box) box.dataset.confirm = '';
  _tutBeginStep();
  _tutRendered = '';
  if (typeof setTab === 'function') setTab(0);
  if (!_tutRaf) _tutRaf = requestAnimationFrame(_tutFrame);
}

function _tutBeginStep() {
  const st = TUT_STEPS[_tut.step];
  _tut.base = (st && st.start && player) ? st.start() : {};
  _tutSave();
}

function _tutAdvance() {
  _tut.step++;
  if (_tut.step >= TUT_STEPS.length) { _tutFinish(); return; }
  _tutBeginStep();
  _tutJustDone = performance.now() + 900;
  if (typeof Sound !== 'undefined' && Sound.loot) { try { Sound.loot(); } catch (_) {} }
}

function _tutFinish() {
  _tut.off = true;
  _tutSave();
  _tutHide();
}

function tutAck() {
  if (!_tut || _tut.off) return;
  const st = TUT_STEPS[_tut.step];
  if (!st || !st.ack) return;
  if (st.last) { _tutFinish(); return; }
  _tutAdvance();
}

function tutSkip() {
  if (!_tut || _tut.off) return;
  const box = document.getElementById('tut-card');
  if (box && box.dataset.confirm !== '1') {
    box.dataset.confirm = '1';
    _tutRendered = '';
    return;
  }
  _tutFinish();
}
function tutSkipCancel() {
  const box = document.getElementById('tut-card');
  if (box) box.dataset.confirm = '';
  _tutRendered = '';
}

function tutToggleMin() {
  if (!_tut) return;
  _tut.min = !_tut.min;
  _tutSave();
  _tutRendered = '';
}

function _tutHide() {
  if (_tutRaf) { cancelAnimationFrame(_tutRaf); _tutRaf = 0; }
  _tutHideDom();
}
function _tutHideDom() {
  const c = document.getElementById('tut-card');
  if (c) c.style.display = 'none';
  const r = document.getElementById('tut-ring');
  if (r) r.style.display = 'none';
  document.body.classList.remove('tut-on');
}

function _tutFrame() {
  _tutRaf = 0;
  if (!_tut || _tut.off) { _tutHide(); return; }
  _tutRaf = requestAnimationFrame(_tutFrame);
  if (state !== 'playing' || !player) { _tutHideDom(); return; }
  const st = TUT_STEPS[_tut.step];
  if (!st) { _tutFinish(); return; }
  let ok = false;
  try { ok = st.done(_tut.base || {}); } catch (_) {}
  if (ok) { _tutAdvance(); return; }
  _tutRenderCard(st);
  _tutPlaceRing(st);
}

function _tutRenderCard(st) {
  const c = document.getElementById('tut-card');
  if (!c) return;
  const onGame = activeTab === 0;
  // На вкладке «Игра» карточка сверху, под шапкой, между левой колонкой
  // кнопок и «Меню»; на панелях — снизу, над навигацией: верх панелей
  // занят их собственными вкладками, которые шаг как раз и подсвечивает.
  c.classList.toggle('tut-bottom', !onGame);
  document.body.classList.toggle('tut-on', !onGame && !_tut.min);
  if (onGame) {
    const mb = document.getElementById('hud-menu-btn');
    const app = document.getElementById('app');
    let top = HEADER_H + 8;
    if (mb && app && mb.offsetParent !== null) top = Math.max(top, mb.getBoundingClientRect().bottom - app.getBoundingClientRect().top + 8);
    c.style.top = Math.round(top) + 'px';
  } else c.style.top = '';
  c.style.display = '';
  let prog = '';
  try { prog = st.progress ? st.progress(_tut.base || {}) : ''; } catch (_) {}
  const confirm = c.dataset.confirm === '1';
  const flash = performance.now() < _tutJustDone;
  const key = [_tut.step, prog, currentLang, _tut.min, confirm, flash, activeTab].join('·');
  if (key === _tutRendered) return;
  _tutRendered = key;

  const n = _tut.step + 1, total = TUT_STEPS.length;
  const head = `<div class="tut-head" onclick="tutToggleMin()">
      <span class="tut-scroll">📜</span>
      <span class="tut-title">${tVars('tutTitle', { n, total })}</span>
      <span class="tut-min">${_tut.min ? '▾' : '▴'}</span>
    </div>`;
  if (_tut.min) {
    c.classList.add('tut-collapsed');
    c.innerHTML = head;
    return;
  }
  c.classList.remove('tut-collapsed');
  if (confirm) {
    c.innerHTML = head + `<div class="tut-body">${t('tutSkipAsk')}</div>
      <div class="tut-btns">
        <button class="tut-btn" onclick="tutSkipCancel()">${t('tutSkipNo')}</button>
        <button class="tut-btn tut-btn-dim" onclick="tutSkip()">${t('tutSkipYes')}</button>
      </div>`;
    return;
  }
  const bar = `<div class="tut-bar"><i style="width:${(100 * _tut.step / (total - 1)).toFixed(1)}%"></i></div>`;
  // Шаг, который делается на другой вкладке, начинается с подсказки, куда
  // перейти, — само кольцо в это время стоит над вкладкой нижнего меню.
  const wrongTab = st.tab != null && activeTab !== st.tab;
  const hint = wrongTab ? `<div class="tut-hint">${tVars('tutGoTab', { tab: t(_TUT_TAB_KEYS[st.tab]) })}</div>` : '';
  const btns = `<div class="tut-btns">
      ${st.ack ? `<button class="tut-btn" onclick="tutAck()">${t(st.last ? 'tutFinishBtn' : 'tutAckBtn')}</button>` : ''}
      ${st.last ? '' : `<button class="tut-btn tut-btn-dim" onclick="tutSkip()">${t('tutSkipBtn')}</button>`}
    </div>`;
  c.innerHTML = head + bar +
    `<div class="tut-step${flash ? ' tut-flash' : ''}">
       <div class="tut-name">${t('tut_' + st.id + '_t')}${prog ? ` <span class="tut-prog">${prog}</span>` : ''}</div>
       <div class="tut-body">${t('tut_' + st.id + '_d')}</div>
       ${hint}
     </div>` + btns;
}

const _TUT_TAB_KEYS = ['navGame', 'navChar', 'navMap', 'navQuests', 'navClans', 'navProfile'];

// Кольцо — поверх всего, но не ловит нажатий. Координаты HUD и мира уже в
// CSS-пикселях #app (W/H — это clientWidth/clientHeight), DOM-цели — через
// getBoundingClientRect относительно #app.
function _tutPlaceRing(st) {
  const ring = document.getElementById('tut-ring');
  if (!ring) return;
  let spot = null;
  const wrongTab = st.tab != null && activeTab !== st.tab;
  let tgt;
  if (wrongTab) tgt = { nav: st.tab };
  else { try { tgt = st.target ? st.target(_tut.base || {}) : null; } catch (_) { tgt = null; } }
  if (_tut.min && !wrongTab) tgt = null;
  if (tgt) {
    if (tgt.nav != null || tgt.el) {
      const el = tgt.el ? document.getElementById(tgt.el)
        : document.querySelectorAll('#bottom-nav .nav-tab')[tgt.nav];
      const app = document.getElementById('app');
      if (el && app && el.offsetParent !== null) {
        const r = el.getBoundingClientRect(), a = app.getBoundingClientRect();
        spot = { x: r.left - a.left + r.width / 2, y: r.top - a.top + r.height / 2, w: r.width / 2 + 3, h: r.height / 2 + 3, box: true };
      }
    } else if (tgt.joy) {
      const j = joyCenter();
      spot = { x: j.x, y: j.y, r: JOY_R + 6 };
    } else if (tgt.hud) {
      const p = tgt.hud === 'attack' ? getAttackBtnPos() : tgt.hud === 'potion' ? getPotionBtnPos() : getAutoBtnPos();
      const cx = p.cx != null ? p.cx : p.x, cy = p.cy != null ? p.cy : p.y;
      spot = { x: cx, y: cy, r: p.r + 6 };
    } else if (tgt.world) {
      // Портал может уйти за край экрана — кольцо тогда прижато к краю,
      // со стороны, куда идти.
      let x = (tgt.world.x - _lastCamX) * ZOOM, y = (tgt.world.y - _lastCamY) * ZOOM + HEADER_H;
      const m = 40, top = HEADER_H + m, bot = H - NAV_H - m;
      const off = x < m || x > W - m || y < top || y > bot;
      x = Math.max(m, Math.min(W - m, x)); y = Math.max(top, Math.min(bot, y));
      spot = { x, y, r: off ? 22 : TILE * ZOOM * 0.9, edge: off };
    }
  }
  if (!spot) { ring.style.display = 'none'; return; }
  ring.style.display = '';
  // Вкладки и кнопки DOM — скруглённая рамка по их коробке, круглые кнопки
  // HUD и портал — круг.
  const hw = spot.box ? spot.w : spot.r, hh = spot.box ? spot.h : spot.r;
  ring.style.width = (hw * 2) + 'px'; ring.style.height = (hh * 2) + 'px';
  ring.style.borderRadius = spot.box ? '12px' : '50%';
  // left/top, а не transform: translate — пульс анимирует свойство scale,
  // а оно применяется поверх transform и растягивало бы сам сдвиг, унося
  // кольцо с цели на каждом вдохе.
  ring.style.left = (spot.x - hw).toFixed(1) + 'px';
  ring.style.top = (spot.y - hh).toFixed(1) + 'px';
  ring.classList.toggle('tut-ring-edge', !!spot.edge);
}
