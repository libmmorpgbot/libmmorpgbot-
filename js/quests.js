// ─────────────────────────────────────────────────────────
//  QUEST SYSTEM
// ─────────────────────────────────────────────────────────
let questNotif = null; // { title, timer }
let _activeQuestTab = 'story';
let _specialQuestsCache = null;

function getCurrentQuest() {
  if (!player) return null;
  return QUEST_DEF[player.questIdx] || null;
}

// Reads the shared rule (questComplete, shared/definitions.js), because the
// server decides whether a claim is paid and the two sides must not be able
// to disagree about what "done" means.
function isQuestComplete(q) {
  if (!player || !q) return false;
  return questComplete(q, player.questKills, player.lvl);
}

function checkQuestComplete() {
  if (!player) return;
  const q = getCurrentQuest();
  if (!q) return;
  if (isQuestComplete(q)) {
    // Quest is done — just refresh UI so the claim button appears
    if (activeTab === 3) updateQuestUI();
  }
}

// The reward itself is granted by the server (see the claimQuest handler,
// server/index.js) — gold and the reward items both. Handing them out here
// and relying on the next saveProgress to carry them stopped working when
// the save path refused to let a client's item list grow: the potions were
// rejected as forged and the player lost them. Nothing is applied locally
// now; onQuestClaimed below applies whatever the server actually granted.
function claimQuest() {
  if (!player) return;
  const q = getCurrentQuest();
  if (!q || !isQuestComplete(q)) return;
  if (_questClaimPending) return;   // one claim in flight at a time
  _questClaimPending = true;
  // Released on the server's answer, but never left latched if that answer
  // is lost (a dropped connection mid-claim): a stuck flag would make the
  // claim button silently do nothing for the rest of the session.
  clearTimeout(_questClaimTimer);
  _questClaimTimer = setTimeout(() => { _questClaimPending = false; updateQuestUI(); }, 8000);
  if (typeof netClaimQuest === 'function') netClaimQuest(player.questIdx);
}

let _questClaimPending = false;
let _questClaimTimer = null;

// The server's authoritative quest counter, sent whenever it notices ours
// has drifted from it — normally because a questClaimed never arrived (a
// disconnect right after the grant) and we have been re-claiming an index
// the server already moved past ever since. Catching up here is what lets
// the next claim actually work instead of failing forever.
function onQuestSync({ questIdx, questKills } = {}) {
  clearTimeout(_questClaimTimer);
  _questClaimPending = false;
  if (!player) return;
  if (Number.isFinite(questIdx)) player.questIdx = questIdx;
  if (questKills && typeof questKills === 'object') player.questKills = questKills;
  updateQuestUI();
}

// Server confirmed the grant: the items are already in player.inventory via
// the inventorySync that preceded this, so only the numbers are left — and
// only as display, since the server sends the totals it recorded.
function onQuestClaimed({ idx, newGold, questIdx } = {}) {
  clearTimeout(_questClaimTimer);
  _questClaimPending = false;
  if (!player) return;
  const q = QUEST_DEF[idx];
  // newGold is the server's total. There is no local fallback any more: gold
  // is not a number this side is allowed to compose.
  if (Number.isFinite(newGold)) player.gold = newGold;
  // The level state arrives via xpSync; this is display only.
  player.questIdx = Number.isFinite(questIdx) ? questIdx : (player.questIdx + 1);
  player.questKills = {};
  if (q) showQuestComplete(q);
  updateQuestUI();
}

function onQuestClaimError(msg) {
  clearTimeout(_questClaimTimer);
  _questClaimPending = false;
  if (typeof _marketToast === 'function') _marketToast(msg || t('genericErrorLbl'), 'err');
  updateQuestUI();
}

function showQuestComplete(q) {
  questNotif = { title: '✓ ' + q.title, timer: 3.5 };
  dmgNum(player.x, player.y - 54, (typeof t === 'function' ? t('questCompleteToast') : 'Квест выполнен!'), '#e69419');
  spawnBurst(player.x, player.y, '#e69419', 12);
}

function tickQuestNotif(dt) {
  if (!questNotif) return;
  questNotif.timer -= dt;
  if (questNotif.timer <= 0) questNotif = null;
}

// ── Event hooks ───────────────────────────────────────────
// Every one of these is counted server-side now (_questOnKill / buyPotion,
// server/index.js) and pushed back as questSync, so all that is left of them
// is the UI half they also always were: refresh the quest tab while it is the
// one on screen. They stay separate named hooks because that is how their
// call sites read (js/network.js, and the join-guild button below).
function _questTabRefresh() {
  if (activeTab === 3 && typeof updateQuestUI === "function") updateQuestUI();
}

function onEnemyKill() { _questTabRefresh(); }

function onBuyPotion() { _questTabRefresh(); }

function onLevelUp() {
  if (!player) return;
  const q = getCurrentQuest();
  if (!q || q.type !== 'level') return;
  checkQuestComplete();
  if (activeTab === 3) updateQuestUI();
}

// Open world note: there's no discrete floor to walk into a menu and
// "travel" to anymore — legacy dungeon_clear/goto_floor quests instead
// complete the moment the player's kills reach the corresponding corridor
// (dungeon_clear is awarded in full since repeated "runs" have no real
// equivalent in one seamless world). Called from the enemyKilled handler
// with the killed monster's global room level.
function onEnterArm() { _questTabRefresh(); }

function onJoinGuild() { _questTabRefresh(); }

function drawQuestNotif() {
  if (!questNotif || !player || !dungeon) return;
  ctx.save();
  const alpha = Math.min(1, questNotif.timer, 3.5 - questNotif.timer + 0.5);
  ctx.globalAlpha = Math.max(0, alpha);
  ctx.fillStyle = 'rgba(46,37,20,0.95)';
  ctx.beginPath();
  ctx.roundRect(W / 2 - 130, HEADER_H + 10, 260, 32, 8);
  ctx.fill();
  ctx.font = 'bold 13px system-ui, Arial';
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#e69419';
  ctx.fillText(questNotif.title, W / 2, HEADER_H + 31);
  ctx.globalAlpha = 1;
  ctx.restore();
}

// ── Quest tab switching ───────────────────────────────────
function switchQuestTab(tab) {
  _activeQuestTab = tab;
  const story   = document.getElementById('quest-list');
  const special = document.getElementById('special-quest-list');
  const btnS    = document.getElementById('qtab-story');
  const btnSp   = document.getElementById('qtab-special');
  if (!story || !special) return;
  if (tab === 'story') {
    story.style.display = '';
    special.style.display = 'none';
    btnS?.classList.add('active');
    btnSp?.classList.remove('active');
    updateQuestUI();
  } else {
    story.style.display = 'none';
    special.style.display = '';
    btnS?.classList.remove('active');
    btnSp?.classList.add('active');
    updateSpecialQuestUI();
  }
}

// Track which quest IDs are currently being submitted to prevent double-clicks
const _specialQuestPending = new Set();

function _specialQuestUnlock(questId) {
  _specialQuestPending.delete(String(questId));
  if (_activeQuestTab === 'special') updateSpecialQuestUI();
}

function _onSpecialQuestClick(questId) {
  if (_specialQuestPending.has(questId)) return;
  _specialQuestPending.add(questId);
  // Re-render so the button shows a pending state immediately
  if (_activeQuestTab === 'special') updateSpecialQuestUI();
  netCompleteSpecialQuest(questId);
  // Safety timeout: if the server never responds, unlock the button after 10s
  setTimeout(() => { _specialQuestUnlock(questId); }, 10000);
}

async function updateSpecialQuestUI() {
  const el = document.getElementById('special-quest-list');
  if (!el || !player) return;
  el.innerHTML = '<div style="color:#968a7a;text-align:center;padding:20px">' + (typeof t === 'function' ? t('questLoading') : 'Загрузка...') + '</div>';
  if (!_specialQuestsCache) _specialQuestsCache = await fetchSpecialQuests();
  const quests = _specialQuestsCache;
  const done = player.specialQuestsDone || [];
  if (!quests.length) {
    el.innerHTML = '<div style="color:#968a7a;text-align:center;padding:20px">' + (typeof t === 'function' ? t('questNoSpecial') : 'Специальных квестов пока нет') + '</div>';
    return;
  }
  let html = '';
  quests.forEach(q => {
    const isDone = done.includes(q.id);
    const isPending = _specialQuestPending.has(String(q.id));
    const icon = q.icon || '⭐';
    const rewardParts = [];
    if (q.reward.gold)  rewardParts.push(iconHTML('coin',12,'#e3941d') + q.reward.gold);
    if (q.reward.xp)    rewardParts.push(iconHTML('star',12,'#e3941d') + q.reward.xp + ' XP');
    if (q.reward.nexum) rewardParts.push('💎' + q.reward.nexum + ' Liberty');
    const rewardStr = rewardParts.join(' · ');
    const typeLabel = q.type === 'subscribe' ? (typeof t === 'function' ? t('questTypeSubscribe') : 'Подписаться') : q.type === 'link' ? (typeof t === 'function' ? t('questTypeLink') : 'Перейти') : (typeof t === 'function' ? t('questTypeDo') : 'Выполнить');
    if (isDone) {
      html += `<div class="quest-item quest-done">
        <div class="quest-header">
          <span class="quest-title">${icon} ${q.title}</span>
          <span class="quest-reward">${rewardStr}</span>
        </div>
        ${q.desc ? `<div class="quest-desc">${q.desc}</div>` : ''}
        <div class="quest-prog" style="color:#79b644">✓ ${typeof t === 'function' ? t('questDoneCheck') : 'Выполнено'}</div>
      </div>`;
    } else if (isPending) {
      html += `<div class="quest-item quest-current">
        <div class="quest-header">
          <span class="quest-title">${icon} ${q.title}</span>
          <span class="quest-reward">${rewardStr}</span>
        </div>
        ${q.desc ? `<div class="quest-desc">${q.desc}</div>` : ''}
        <button class="quest-claim-btn" disabled style="opacity:0.6">${typeof t === 'function' ? t('questSending') : 'Отправка...'}</button>
      </div>`;
    } else {
      const actionBtn = q.url
        ? `<a href="${q.url}" target="_blank" class="quest-claim-btn" style="display:inline-block;text-decoration:none;text-align:center" onclick="_specialQuestPending.add('${q.id}');updateSpecialQuestUI();setTimeout(()=>{ netCompleteSpecialQuest('${q.id}');setTimeout(()=>_specialQuestUnlock('${q.id}'),10000); },1500)">${typeLabel}</a>`
        : `<button class="quest-claim-btn" onclick="_onSpecialQuestClick('${q.id}')">${typeLabel}</button>`;
      html += `<div class="quest-item quest-current">
        <div class="quest-header">
          <span class="quest-title">${icon} ${q.title}</span>
          <span class="quest-reward">${rewardStr}</span>
        </div>
        ${q.desc ? `<div class="quest-desc">${q.desc}</div>` : ''}
        ${actionBtn}
      </div>`;
    }
  });
  el.innerHTML = html;
}

function onSpecialQuestDone(questId, reward, alreadyDone) {
  if (!player) return;
  _specialQuestPending.delete(String(questId));
  reward = reward || {};
  player.specialQuestsDone = player.specialQuestsDone || [];
  if (!player.specialQuestsDone.includes(questId)) player.specialQuestsDone.push(questId);
  // Gold and XP are the server's numbers and arrive on their own channels
  // (goldSync / xpSync), so nothing about them is composed here. Nexum is
  // server-authoritative too but isn't in the save blob, so all that is left
  // to do locally is refresh the displayed balance.
  if (!alreadyDone) {
    // The balance arrives as a total via goldSync; this is display only.
    // Level state arrives via xpSync.
    // Баланс приходит от сервера отдельным пакетом (pushBalances идёт прямо
    // перед этим событием и уезжает одним flush'ем). Прибавлять здесь — тот же
    // двойной счёт, что убран из пакета убийства: экран уходил вперёд, а
    // следующая синхронизация возвращала правду и выглядела как отъём.
  }
  if (_activeQuestTab === 'special') updateSpecialQuestUI();
  if (!alreadyDone) {
    questNotif = { title: '✓ ' + (typeof t === 'function' ? t('questSpecialCompleteToast') : 'Специальный квест выполнен!'), timer: 3.5 };
    if (typeof spawnBurst === 'function' && player) spawnBurst(player.x, player.y, '#e69419', 12);
  }
  // Sync specialQuestsDone to server immediately so the next autosave can't
  // overwrite it with a stale snapshot that predates this completion.
  if (typeof netSaveProgress === 'function') netSaveProgress();
}

// Highest enhance level the player is currently carrying, bag and worn gear
// alike. Display only — the enhance quests are completed by the server on a
// successful roll, not by owning something (a +5 bought on the Market does not
// finish "Заточи предмет до +5"), so this only makes the progress bar mean
// something while the quest is open.
function _bestEnhanceHeld() {
  if (!player) return 0;
  const best = it => Math.max(0, Math.floor(Number(it && it.enhance)) || 0);
  let top = 0;
  for (const it of (player.inventory || [])) top = Math.max(top, best(it));
  for (const it of Object.values(player.equipment || {})) top = Math.max(top, best(it));
  return top;
}

// ── HTML quest panel ──────────────────────────────────────
function _questProgHtml(q, isCur) {
  if (!isCur) return '';
  const complete = isQuestComplete(q);
  if (complete) return `<button class="quest-claim-btn" onclick="claimQuest()">${typeof t === 'function' ? t('questClaimReward') : 'Забрать награду'}</button>`;

  if (q.type === 'kill') {
    // questKillsFor reads the SPECIES id, and the old name key alongside it for
    // a quest that was already in flight. Reading `player.questKills[name]`
    // directly is what froze every quest for anyone not playing in Russian:
    // applyLocale rewrites q.enemies to the localised names and the counters
    // keep their original keys.
    const done = (q.eids || q.enemies).reduce((s, _x, i) => s + questKillsFor(q, player.questKills, i), 0);
    const pct  = Math.min(100, Math.round(done / q.count * 100));
    return `<div class="quest-prog">${done}/${q.count}
      <div class="quest-bar-bg"><div class="quest-bar-fill" style="width:${pct}%"></div></div></div>`;
  }
  if (q.type === 'kill_multi') {
    return q.enemies.map((name, i) => {
      // The NAME is what is shown — localised, in the player's language — and
      // the count comes from the species id beside it.
      const done = questKillsFor(q, player.questKills, i);
      const pct  = Math.min(100, Math.round(done / q.count * 100));
      return `<div class="quest-prog">${name}: ${done}/${q.count}
        <div class="quest-bar-bg"><div class="quest-bar-fill" style="width:${pct}%"></div></div></div>`;
    }).join('');
  }
  if (q.type === 'level') {
    const pct = Math.min(100, Math.round(player.lvl / (q.level || 1) * 100));
    return `<div class="quest-prog">${typeof t === 'function' ? t('questLevelLbl') : 'Уровень'} ${player.lvl}/${q.level}
      <div class="quest-bar-bg"><div class="quest-bar-fill" style="width:${pct}%"></div></div></div>`;
  }
  if (q.type === 'buy_potion') {
    const done = player.questKills['_potion'] || 0;
    return `<div class="quest-prog">${done}/${q.count} ${typeof t === 'function' ? t('questBoughtSuffix') : 'куплено'}
      <div class="quest-bar-bg"><div class="quest-bar-fill" style="width:${Math.min(100,Math.round(done/q.count*100))}%"></div></div></div>`;
  }
  if (q.type === 'dungeon_clear') {
    const done = player.questKills['_dungeon_' + q.floor] || 0;
    return `<div class="quest-prog">${done}/${q.count} ${typeof t === 'function' ? t('questTimesSuffix') : 'раз'}
      <div class="quest-bar-bg"><div class="quest-bar-fill" style="width:${Math.min(100,Math.round(done/q.count*100))}%"></div></div></div>`;
  }
  if (q.type === 'join_guild') {
    return `<button class="quest-claim-btn" style="background:linear-gradient(135deg,#614a23,#9c7738)" onclick="onJoinGuild();updateQuestUI()">${typeof t === 'function' ? t('questJoinGuildBtn') : 'Вступить в гильдию'}</button>`;
  }
  if (q.type === 'goto_floor') {
    return `<div class="quest-prog">${typeof tVars === 'function' ? tVars('questReachCorridor', { lvl: ARM_OFFSETS[q.targetFloor - 1] + 1 }) : 'Дойди до монстров уровня ' + (ARM_OFFSETS[q.targetFloor - 1] + 1) + '+ в коридоре'}</div>`;
  }
  if (q.type === 'craft') {
    return `<div class="quest-prog">${typeof t === 'function' ? t('questVisitBlacksmith') : 'Зайди к кузнецу'}</div>`;
  }
  // Заточка. There is no partial progress to show — the counter is a flag the
  // server sets the moment a successful enhance reaches the threshold (see the
  // enhanceItem handler, server/handlers/craft.js) — so this is a hint about
  // where to go, the same shape as the craft/enter_zone rows around it. The
  // best enhance the player currently holds is shown next to it so the target
  // reads as a distance rather than a bare instruction.
  if (q.type === 'enhance') {
    const best = _bestEnhanceHeld();
    const hint = typeof tVars === 'function'
      ? tVars('questEnhanceHint', { n: q.enhance })
      : `Заточи любой предмет до +${q.enhance} у кузнеца`;
    return `<div class="quest-prog">${hint}<br>+${best} / +${q.enhance}
      <div class="quest-bar-bg"><div class="quest-bar-fill" style="width:${Math.min(100, Math.round(best / q.enhance * 100))}%"></div></div></div>`;
  }
  if (q.type === 'enter_zone') {
    return `<div class="quest-prog">${typeof t === 'function' ? t('questEnterFarmZone') : 'Зайди в Фарм-зону через портал в Зале'}</div>`;
  }
  return '';
}

function updateQuestUI() {
  const el = document.getElementById('quest-list');
  if (!el || !player) return;
  if (_activeQuestTab !== 'story') return;

  // Group quests by floor
  const floors = [...new Set(QUEST_DEF.map(q => q.floor || 1))].sort((a, b) => a - b);
  let html = '';

  floors.forEach(floorNum => {
    const floorQuests = QUEST_DEF.map((q, i) => ({ q, i })).filter(({ q }) => (q.floor || 1) === floorNum);
    const firstIdx    = floorQuests[0].i;
    // Floor section is locked if player hasn't reached its first quest yet —
    // just don't show anything for it yet (no "will unlock on floor N" teaser;
    // completing everything above is what reveals it, see player.questIdx).
    const floorLocked = player.questIdx < firstIdx;
    if (floorLocked) return;

    const doneCnt = Math.min(player.questIdx - firstIdx, floorQuests.length);
    html += `<div class="quest-floor-hdr">${typeof t === 'function' ? t('questFloorLbl') : 'Этаж'} ${floorNum} · <span style="color:#968a7a;font-weight:normal">${doneCnt}/${floorQuests.length} ${typeof t === 'function' ? t('questCompletedSuffix') : 'выполнено'}</span></div>`;

    floorQuests.forEach(({ q, i }) => {
      const isDone = i < player.questIdx;
      const isCur  = i === player.questIdx;
      const cls    = isDone ? 'quest-item quest-done' : isCur ? 'quest-item quest-current' : 'quest-item quest-locked';
      const rewardStr = [
        q.reward.xp > 0 ? iconHTML('star',12,'#e3941d') + q.reward.xp + ' XP' : '',
        iconHTML('coin',12,'#e3941d') + q.reward.gold,
        q.reward.items ? iconHTML('potion',12,'#90d653') + '×' + q.reward.items.length : '',
      ].filter(Boolean).join(' · ');
      const statusIcon = isDone
        ? iconHTML('hpPlus', 14, '#79b644')
        : isCur ? iconHTML('star', 14, '#e69419') : iconHTML('skull', 14, '#5f574b');

      html += `<div class="${cls}">
        <div class="quest-header">
          <span class="quest-title">${statusIcon} ${q.title}</span>
          <span class="quest-reward">${rewardStr}</span>
        </div>
        <div class="quest-desc">${q.desc}</div>
        ${_questProgHtml(q, isCur)}
      </div>`;
    });
  });

  el.innerHTML = html;
}
