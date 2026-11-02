// ── Боевой пропуск ──────────────────────────────────────────────────────────
// Окно: шапка с прогрессом и кнопкой «Купить пропуск», ниже 30 заданий — у
// каждого счётчик, бесплатная награда и премиальная. Задания и награды — из
// BATTLE_PASS_TASKS (shared/definitions.js); счётчики, премиум и забранное —
// с сервера (bpState, server/battlepass.js). Клиент ничего не начисляет сам,
// только показывает и просит.

let _bpState = null;       // последний bpState
let _bpBusy = false;       // ждём ответ сервера — кнопки выключены
let _bpBuyConfirm = false; // первое нажатие «Купить» — показать цену, второе — купить

function _bpProg(task) { return Math.max(0, Number(((_bpState || {}).progress || {})[task.metric]) || 0); }
function _bpDone(task) { return _bpProg(task) >= task.target; }
function _bpClaimed(task, track) {
  const list = (_bpState || {})[track === 'free' ? 'claimedFree' : 'claimedPrem'] || [];
  return list.includes(task.n);
}
function _bpReadyCount() {
  if (!_bpState || !_bpState.ready) return 0;
  let n = 0;
  for (const x of BATTLE_PASS_TASKS) {
    if (!_bpDone(x)) continue;
    if (!_bpClaimed(x, 'free')) n++;
    if (_bpState.premium && !_bpClaimed(x, 'prem')) n++;
  }
  return n;
}
function _bpNum(n) { return Number(n || 0).toLocaleString('ru-RU'); }

function _bpRewardHTML(r) {
  if (r.t === 'helper') {
    const col = (typeof RARITY_COLOR !== 'undefined' && RARITY_COLOR[r.rarity]) || '#c4a276';
    const rn = { common: 'обычный', uncommon: 'необычный', rare: 'редкий', epic: 'эпический', legendary: 'легендарный' }[r.rarity] || r.rarity;
    const one = HELPERS.find(h => h.rarity === r.rarity);
    const pic = one && typeof helperIconUrl === 'function' && helperIconUrl(one.id);
    return `<span class="ach-rw" style="--rc:${col}">${pic ? `<img class="ach-rw-img" src="${pic}" alt="">` : '<span class="ach-rw-ico">🧚</span>'}<span>Помощник · ${rn}</span></span>`;
  }
  return typeof _achRewardHTML === 'function' ? _achRewardHTML(r) : '';
}

function _bpTrackHTML(task, track) {
  const prem = track === 'prem';
  const list = prem ? task.prem : task.free;
  const claimed = _bpClaimed(task, track);
  const owned = !prem || (_bpState && _bpState.premium);
  const ready = _bpDone(task) && owned && !claimed;
  const btn = claimed ? '<span class="bp-got">✓</span>'
    : ready ? `<button class="bp-claim" ${_bpBusy ? 'disabled' : ''} onclick="bpClaim(${task.n}, '${track}')">Забрать</button>`
    : !owned ? '<span class="bp-lock">🔒</span>' : '';
  return `<div class="bp-track ${prem ? 'prem' : 'free'}${claimed ? ' got' : ''}${ready ? ' ready' : ''}">
    <div class="bp-track-lbl">${prem ? '👑 Пропуск' : 'Бесплатно'}</div>
    <div class="bp-track-rw">${list.map(_bpRewardHTML).join('')}</div>
    ${btn}
  </div>`;
}

function _bpTaskHTML(task) {
  const cur = Math.min(_bpProg(task), task.target);
  const pct = Math.floor((cur / Math.max(1, task.target)) * 100);
  const done = _bpDone(task);
  const text = String(BP_METRICS[task.metric] || task.metric).replace('{n}', _bpNum(task.target));
  return `<div class="bp-task${done ? ' done' : ''}">
    <div class="bp-task-head">
      <span class="bp-task-n">${task.n}</span>
      <div class="bp-task-body">
        <div class="bp-task-name">${text}</div>
        <div class="s4-bar"><div class="s4-bar-fill" style="width:${pct}%"></div></div>
        <div class="bp-task-prog">${done ? '✓ Выполнено' : `${_bpNum(cur)} / ${_bpNum(task.target)}`}</div>
      </div>
    </div>
    <div class="bp-tracks">${_bpTrackHTML(task, 'free')}${_bpTrackHTML(task, 'prem')}</div>
  </div>`;
}

function _bpHeroHTML() {
  const st = _bpState || {};
  const doneN = BATTLE_PASS_TASKS.filter(_bpDone).length;
  const pct = Math.floor((doneN / BATTLE_PASS_TASKS.length) * 100);
  const left = st.endAt ? Math.max(0, st.endAt - Date.now()) : 0;
  const ends = st.endAt ? (left > 0 && typeof _fmtEventEta === 'function' ? `⏳ До конца сезона: ${_fmtEventEta(left)}` : 'Сезон завершён') : '';
  const ready = _bpReadyCount();
  const buy = st.premium
    ? '<div class="bp-owned">👑 Пропуск куплен — премиальные награды открыты</div>'
    : st.active === false ? ''
    : `<button class="bp-buy${_bpBuyConfirm ? ' confirm' : ''}" ${_bpBusy ? 'disabled' : ''} onclick="bpBuy()">
        ${_bpBuyConfirm ? `Подтвердить — списать ${BATTLE_PASS_PRICE} GRAM` : `👑 Купить пропуск — ${BATTLE_PASS_PRICE} GRAM`}</button>
       <div class="bp-buy-note">Премиальные награды всех 30 заданий: руны, помощники, Liberty, сундуки и камни. Можно купить в любой момент сезона — награды за уже выполненные задания тоже заберёте.</div>`;
  return `<div class="bp-hero${st.premium ? ' premium' : ''}">
    <div class="bp-hero-rule"><span>✦ СЕЗОН ${st.season || BATTLE_PASS_SEASON} ✦</span></div>
    <div class="bp-hero-title">Боевой пропуск</div>
    <div class="bp-hero-prog"><b>${doneN}</b> / ${BATTLE_PASS_TASKS.length} заданий</div>
    <div class="bp-hero-bar"><i style="width:${pct}%"></i></div>
    ${ends ? `<div class="bp-hero-ends">${ends}</div>` : ''}
    ${buy}
    ${ready ? `<button class="bp-claim-all" ${_bpBusy ? 'disabled' : ''} onclick="bpClaimAll()">🎁 Забрать всё (${ready})</button>` : ''}
  </div>`;
}

function _renderBpPanel() {
  const body = document.getElementById('bp-panel-body');
  if (!body) return;
  if (!_bpState) { body.innerHTML = '<div class="s4-wrap"><div class="s4-empty">Загрузка...</div></div>'; return; }
  if (!_bpState.ready) { body.innerHTML = '<div class="s4-wrap"><div class="s4-empty">Боевой пропуск скоро появится</div></div>'; return; }
  body.innerHTML = `<div class="s4-wrap bp-wrap">${_bpHeroHTML()}${BATTLE_PASS_TASKS.map(_bpTaskHTML).join('')}</div>`;
}

function _bpPanelOpen() { return document.getElementById('bp-panel')?.style.display === 'flex'; }
function openBpPanel() {
  const panel = document.getElementById('bp-panel');
  if (!panel) return;
  panel.style.display = 'flex';
  _bpBuyConfirm = false;
  _renderBpPanel();
  if (typeof netBpSync === 'function') netBpSync();
}
function closeBpPanel() {
  const panel = document.getElementById('bp-panel');
  if (panel) panel.style.display = 'none';
  _bpBuyConfirm = false;
}

function bpBuy() {
  if (_bpBusy) return;
  if (!_bpBuyConfirm) { _bpBuyConfirm = true; _renderBpPanel(); return; }
  _bpBusy = true; _bpBuyConfirm = false; _renderBpPanel();
  if (typeof netBpBuy === 'function') netBpBuy();
}
function bpClaim(n, track) {
  if (_bpBusy) return;
  _bpBusy = true; _renderBpPanel();
  if (typeof netBpClaim === 'function') netBpClaim(n, track);
}
function bpClaimAll() {
  if (_bpBusy) return;
  _bpBusy = true; _renderBpPanel();
  if (typeof netBpClaimAll === 'function') netBpClaimAll();
}

function _refreshBpDot() {
  const btn = document.getElementById('bp-btn');
  if (btn) btn.classList.toggle('has-ready', _bpReadyCount() > 0);
}
function onBpState(st) {
  _bpState = st || null;
  _bpBusy = false;
  _refreshBpDot();
  if (_bpPanelOpen()) _renderBpPanel();
}
function onBpError() {
  _bpBusy = false;
  if (_bpPanelOpen()) _renderBpPanel();
}
function onBpBought() {
  if (typeof _marketToast === 'function') _marketToast('👑 Боевой пропуск куплен! Премиальные награды открыты', 'ok');
}
function onBpClaimed(res) {
  const list = (res && res.claimed) || [];
  const n = list.reduce((s, c) => s + ((c.granted && c.granted.length) || 0), 0);
  if (typeof _marketToast === 'function') {
    if (n) _marketToast(`🎁 Получено наград: ${n}`, 'ok');
    if (res && res.stopped === 'no_room') _marketToast('Инвентарь полон — освободите место и заберите остальное', 'err');
  }
}
function onBpTaskDone(res) {
  const tasks = (res && res.tasks) || [];
  if (!tasks.length) return;
  if (_bpState && _bpState.progress) {
    // Счётчик точно дошёл до цели — отметить локально, чтобы точка на кнопке
    // загорелась сразу, не дожидаясь, пока окно откроют.
    for (const n of tasks) {
      const x = bpTaskByN(n);
      if (x) _bpState.progress[x.metric] = Math.max(_bpProg(x), x.target);
    }
  }
  _refreshBpDot();
  if (typeof _marketToast === 'function') {
    const x = bpTaskByN(tasks[0]);
    const text = x ? String(BP_METRICS[x.metric] || '').replace('{n}', _bpNum(x.target)) : '';
    _marketToast(`⚔️ Боевой пропуск: задание ${tasks[0]} выполнено${text ? ' — ' + text : ''}`, 'ok');
  }
  if (_bpPanelOpen()) _renderBpPanel();
}

// Под кнопкой «Достижения», тем же шагом, что и вся колонка.
function _positionBpBtn() {
  const above = document.getElementById('ach-btn');
  const btn = document.getElementById('bp-btn');
  if (!btn || !above) return;
  const aTop = parseFloat(above.style.top) || 0;
  btn.style.top       = (aTop + 28 + 4) + 'px';
  btn.style.left      = above.style.left;
  btn.style.width     = above.style.width;
  btn.style.right     = 'auto';
  btn.style.transform = 'none';
}
function showBpBtn() {
  const btn = document.getElementById('bp-btn');
  if (btn) { btn.dataset.shown = '1'; btn.style.display = _hudSubBtnDisplay(); _positionBpBtn(); }
}
