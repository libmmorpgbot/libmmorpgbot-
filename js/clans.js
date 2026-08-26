// ─────────────────────────────────────────────────────────
//  CLAN SYSTEM — client side
// ─────────────────────────────────────────────────────────

// ── Pixel-art icon palette (L2-style) ────────────────────
const _CP = {
  _:null,
  K:'#18140c', k:'#2c261c', W:'#d1ccc5', S:'#bcb7ad', s:'#9c9589',
  G:'#e69419', g:'#996311', R:'#db3d50', r:'#88202c', B:'#d9a347',
  b:'#7c5c26', E:'#73b43a', e:'#314c1a', P:'#e2ad4b', p:'#866424',
  O:'#e69419', o:'#8a590f', Y:'#e6ac19', N:'#c4944c', n:'#624a26',
  C:'#bc9563', H:'#a49a89', D:'#625948', M:'#e74558', L:'#efc680',
  A:'#e69419', V:'#b4893a',
};

// 30 clan icons — 16×16 pixel grids, L2 crest style
const _ICONS = [
// 1 Dragon Head
['________________',
 '__________RR____',
 '_________RrRR___',
 '________RrRRRR__',
 '_______RRKrKRR__',
 '______RRRrRRRRR_',
 '______RRRRRRRRRR',
 '_____RRRRRRRRRRR',
 '_____RRRRGRRRRR_',
 '______RRRRRRRRRR',
 '_______RRRRRRrr_',
 '________RRRRrr__',
 '_________RRrrr__',
 '__________Rrrr__',
 '___________rr___',
 '________________'],
// 2 Heraldic Shield
['________________',
 '______KKKKKK____',
 '_____KgGGGGgK___',
 '____KgGBBBBGgK__',
 '____KGBRRRRRBGK_',
 '____KGBRSSSSBGk_',
 '____KGBRSWWSBGk_',
 '____KGBRSSSSBGk_',
 '____KGBRRRRRBGK_',
 '____KGGBBBBBGGk_',
 '_____KGGGGGGGk__',
 '______KKKKKKk___',
 '_______KKKKk____',
 '________KKK_____',
 '_________K______',
 '________________'],
// 3 Skull Crown
['________________',
 '____GKGKGKGKg___',
 '___GYGgGgGgGYG__',
 '__GYYYYYYYYYgG__',
 '__GYY__KKK_YgG__',
 '__GKSSSSSSSSKg__',
 '__GKSHHKHHSKKg__',
 '__GKSHHKHHSKKg__',
 '__GKSSKKKSSKKg__',
 '__GKKSHHHSKKg___',
 '__GKK__RR_KKGg__',
 '___GKKKRRKKGg___',
 '___GggggggggG___',
 '____GGGGGGGG____',
 '________________',
 '________________'],
// 4 Phoenix
['___________OO___',
 '__________OOOO__',
 '_________AOAOO__',
 '________AAAOOO__',
 '_______AAAAAOOO_',
 '______AAAAAAOOO_',
 '____RRRRRRRRRRR_',
 '___RYYYYRYRYYYR_',
 '___RRRRRRRRRRRR_',
 '____RRRRRRRRRRR_',
 '_____RRRRRRRRRR_',
 '______RRRRRRRR__',
 '_______RRRRRRR__',
 '________RRRRRR__',
 '_________RRRR___',
 '__________RR____'],
// 5 Castle
['_S__S__S__S__S__',
 '_SSSSSSSSSSSS___',
 '__SSSSSSSSSS____',
 '__SS_SSSS_SS____',
 '__SS_SSSS_SS____',
 '__SSKKKKKKSS____',
 '__SSK____KSS____',
 '__SSK_GG_KSS____',
 '__SSK_GG_KSS____',
 '__SSK____KSS____',
 '__SSKKKKKKSS____',
 '__SSSSSSSSSS____',
 '_SSSSSSSSSSSS___',
 '_SSSSSSSSSSSS___',
 '________________',
 '________________'],
// 6 Paladin Cross
['________________',
 '______GGGGG_____',
 '_____GGGgGGG____',
 '_____GGgggGG____',
 'GGGGGGGGGGGGGGGG',
 'GWWWWWGgGWWWWWGG',
 'GGGGGGGGGGGGGGGG',
 '_____GGgggGG____',
 '_____GGGgGGG____',
 '______GGGGG_____',
 '______GGGGG_____',
 '_____GGGGGGG____',
 '________________',
 '________________',
 '________________',
 '________________'],
// 7 Wolf Head
['________________',
 '___HH_______HH__',
 '__HHH_______HHH_',
 '__HHHHHHHHHHHHH_',
 '__HHHHHHHHHHHHHH',
 '__HHHHDDDDDDHHHH',
 '__HHHHHHHHHHHHH_',
 '__HHHKKHHKKHHH__',
 '__HHHKKHHKKHHH__',
 '__HHHHHrrHHHHH__',
 '___HHHHHHHHHH___',
 '____HHHHHHHH____',
 '____HHHHHHHH____',
 '_____HHHHHH_____',
 '_____HH__HH_____',
 '________________'],
// 8 Flame
['________________',
 '_______AA_______',
 '______AAAA______',
 '____OOAAAAO_____',
 '___OOOAAAAOOO___',
 '__OOOAAYYYAOOO__',
 '__OOAYYYYYROO___',
 '__OAYYYYYYYROO__',
 '_OAYYYYYYYYROOO_',
 '_OAYYYYYYYRROOO_',
 '_OOAYYYYYROOOO__',
 '__OOOAYROOOOOO__',
 '___OOOOOOOOOO___',
 '____OOOOOOOO____',
 '_____OOOOOO_____',
 '______OOOO______'],
// 9 Crown
['________________',
 '__G__________G__',
 '__GG_G_____G_GG_',
 '__GGGGG___GGGGG_',
 '__GGGGGGGGGGGG__',
 '_GGGGGGGGGGGGGGG',
 '_GGYYYYYYYYYYYgG',
 '_GGYRRRRRRRRRYgG',
 '_GGYRRRRRRRRRYgG',
 '_GGYYYYYYYYYYYgG',
 '_GGGGGGGGGGGGGGG',
 '__GGGGGGGGGGGG__',
 '________________',
 '________________',
 '________________',
 '________________'],
// 10 Eagle Wings
['________________',
 '_E____________E_',
 '_EE__________EE_',
 '_EEE________EEE_',
 'EEEE________EEEE',
 'EEEEEE____EEEEEE',
 'EEEEEEEEEEEEEEEE',
 '_EEEEEEEEEEEEEE_',
 '__EEEEEEEEEEEE__',
 '___EEEEEEEEEE___',
 '____EEEGGGEE____',
 '_____EEEGEE_____',
 '______EEEEE_____',
 '_______EEE______',
 '________E_______',
 '________________'],
// 11 Magic Orb
['________________',
 '____PPPPPPPP____',
 '___PPCCCCCCpp___',
 '__PPCCLLLLCCpP__',
 '_PPCCLLWWWLLCCp_',
 '_PCCLLWWWWWLLCp_',
 '_PCCLLWWWWWLLCp_',
 '_PCCLLWWWWWLLCp_',
 '_PPCCLLWWWLLCCp_',
 '__PPCCLLLLCCpP__',
 '___PPCCCCCCpp___',
 '____PPPPPPPP____',
 '________________',
 '________________',
 '________________',
 '________________'],
// 12 Lightning Bolt
['________________',
 '____YYYY________',
 '____YYYYY_______',
 '____YYYYYY______',
 '____YYYYYYY_____',
 '____YYYYYYYY____',
 '____YYYYYYYYY___',
 '_YYYYYYYYYY_____',
 '_YYYYYYYYYY_____',
 '____YYYYYYYY____',
 '___YYYYYYYYY____',
 '___YYYYYYYY_____',
 '___YYYYYYY______',
 '___YYYYYY_______',
 '___YYY__________',
 '________________'],
// 13 Anchor
['________________',
 '_______GGG______',
 '______GGGGG_____',
 '______GG_GG_____',
 '______GG_GG_____',
 'GGGGGGGg_gGGGGGG',
 'GgGGGGGg_gGGGGg_',
 '____GG___GG_____',
 '____GG___GG_____',
 '___GGG___GGG____',
 '__GGGG___GGGG___',
 '__GGG_____GGG___',
 '___GGGGGGGGG____',
 '____GGGGGGG_____',
 '_____GGGGG______',
 '________________'],
// 14 Battle Axe
['_______SS_______',
 '______SSSS______',
 '_____SSSSSS_____',
 '____SSSSSSSS____',
 '___SSSSKSSSSn___',
 '__SSSSSKSSSSSn__',
 '_SSSSSSKSSSSSSn_',
 'SSSSSSKKKSSSSSnn',
 '_SSSSSSKSSSSSSn_',
 '__SSSSSKSSSSSn__',
 '___SSSSKSSSSn___',
 '____SSSKSSSSn___',
 '____SSSKSSSnn___',
 '______SKKS______',
 '______SKKS______',
 '_____SKKKS______'],
// 15 Moon + Star
['________________',
 '____BBBBB_______',
 '___BBBBBBB______',
 '__BBBBBBBBBb____',
 '__BBBBbb________',
 '_BBBBBb____YYYY_',
 '_BBBBBb___YYYYY_',
 '_BBBBBb__YYYYYY_',
 '_BBBBBb___YYYYY_',
 '__BBBBb____YYYY_',
 '__BBBBBBBBBb____',
 '___BBBBBBB______',
 '____BBBBB_______',
 '________________',
 '________________',
 '________________'],
// 16 Crystal
['________________',
 '_______CC_______',
 '______CCCC______',
 '_____CCCCCC_____',
 '____CCLLLLCC____',
 '___CCLLWWLLCC___',
 '__CCLLWWWWLLCC__',
 '_CCLLWWWWWWLLCC_',
 '_CCLLWWWWWWLLCC_',
 '__CCLLWWWWLLCC__',
 '___CCLLWWLLCC___',
 '____CCLLLLCC____',
 '_____CCCCCC_____',
 '______CCCC______',
 '_______CC_______',
 '________________'],
// 17 Snake
['________________',
 '___EEEE_________',
 '__EEeEEEE_______',
 '_EEeEEKEEE______',
 '_EEEEEEEEEe_____',
 '__EEEEEEEEEE____',
 '___EEEEEEEEEe___',
 '____EEEEEEEEEE__',
 '_____EEEEEEEEEe_',
 '______EEEEEEEEEE',
 '_______EEEEEEEe_',
 '________EEEEEE__',
 '_________EEEEe__',
 '__________EEE___',
 '___________EE___',
 '____________E___'],
// 18 Bear Paw
['________________',
 '___NN_NN__NN____',
 '__NNNNNNNNNNn___',
 '__NNNNNNNNNNn___',
 '__NNNNNNNNNN____',
 '__NNNNNNNNNN____',
 '__NNNNNNNNNN____',
 '__NNNNNNNNNN____',
 '__NNNNNNNNNN____',
 '__NNNNNNNNNNn___',
 '_NNNNNNNNNNNn___',
 '_NNNNNNNNNNNn___',
 '__NNNNNNNNNn____',
 '___NNNNNNNn_____',
 '________________',
 '________________'],
// 19 Hammer + Anvil
['________________',
 '____NNNNNNNN____',
 '___NNnnNNNNNN___',
 '___NNnnNNNNNN___',
 '___NNNNNNNNNN___',
 '______NNNN______',
 '______NNNN______',
 '______NNNN______',
 '______NNNN______',
 '____NNNNNNNNn___',
 '___NNNNNNNNNNn__',
 '__NNNNNNNNNNNNn_',
 '__NNNNNNNNNNNNn_',
 '__NNNNNNNNNNNNn_',
 '__nnnnnnnnnnnnn_',
 '________________'],
// 20 Eye of Providence
['________________',
 '________________',
 '________G_______',
 '_______GGG______',
 '_____GGGGGGG____',
 '___GGGGGGGGGGG__',
 '__GGSSSSSSSSGGG_',
 '__GSSSSKKSSSSG__',
 '__GSSSSKKSSSSG__',
 '___GGGGGGGGGGG__',
 '_____GGGGGGG____',
 '_______GGG______',
 '________G_______',
 '________________',
 '________________',
 '________________'],
// 21 Bat Wings
['________________',
 'P______________P',
 'PP_____________P',
 'PPP___________PP',
 'PPPP_________PPP',
 'PPPPP_______PPPP',
 'PPPPP_______PPPP',
 'PPPPPP_____PPPPP',
 'PPPPPPPP_PPPPPPP',
 'PPPPPPPPPPPPPPPP',
 '_PPPPPPPPPPPPPP_',
 '__PPPPPPPPPPPP__',
 '___PPPP___PPPP__',
 '____PP_____PP___',
 '_____P_____P____',
 '________________'],
// 22 Crossed Swords
['_S____________S_',
 '__S__________S__',
 '___S________S___',
 '____S______S____',
 '_____S____S_GG__',
 '______SSSS__GGG_',
 '______SSSS_GGGG_',
 '_____S____S_GGG_',
 '____S______S_GG_',
 '___S________S___',
 '__S__________S__',
 '_S____________S_',
 'S______________S',
 '________________',
 '________________',
 '________________'],
// 23 Griffin Head
['________________',
 '___________GGG__',
 '___BBBBBBBGGGGG_',
 '__BBBBBBBBbGGGGG',
 '__BBBKKBBBbGGGG_',
 '__BBBKKBBBb_GGG_',
 '__BBBBBBBBb_____',
 '__BBBBBBBBBb____',
 '___BBBBBBBBB____',
 '___BBBBbBBBBB___',
 '____BbbbbbBBBB__',
 '______bbbbbb____',
 '______bbbbb_____',
 '_______bbb______',
 '________________',
 '________________'],
// 24 Bow
['________________',
 'B_______________',
 'BB______________',
 'BBB_SSS_________',
 'BBBSSSSS________',
 'BBBB_SSS________',
 'BBBBb___________',
 'BBBBBb__________',
 'BBBBb___________',
 'BBBB_SSS________',
 'BBBSSSSS________',
 'BBB_SSS_________',
 'BB______________',
 'B_______________',
 '________________',
 '________________'],
// 25 Fist
['________________',
 '___NNNN_________',
 '__NNNNNN________',
 '__NNNNNNn_______',
 '_NNNNNNNNn______',
 '_NNNNNNNNNn_____',
 'NNNNNNNNNNNn____',
 'NNNNNNNNNNNNn___',
 'NNNNNNNNNNNNn___',
 'NNNNNNNNNNNn____',
 '_NNNNNNNNNn_____',
 '_NNNNNNNNn______',
 '__NNNNNNn_______',
 '___NNNNn________',
 '________________',
 '________________'],
// 26 Rune / Sigil
['________________',
 '___VVVVVVVV_____',
 '__VVpVVVVVVV____',
 '__VV__VVVV__V___',
 '_VV____VV___VV__',
 '_VV_________VV__',
 '_VV_________VV__',
 '_VV_________VV__',
 '_VV_VVVVV___VV__',
 '__VVVpppVVV_V___',
 '__VVppppppVV____',
 '___VVppppVV_____',
 '____VVppVV______',
 '_____VVVV_______',
 '______VV________',
 '________________'],
// 27 Rose
['________________',
 '______EE________',
 '____EEEEEE______',
 '___EEEMEEEe_____',
 '__EEEMMMEEEe____',
 '__EEEMMMEEEe____',
 '__EEEMMMEEee____',
 '__EEEEE_EEe_____',
 '___EEEEMEEe_____',
 '____MMMMM_______',
 '___MMMMMMMe_____',
 '___MMMMMMMn_____',
 '____MMMMM_______',
 '_____MMM________',
 '______EE________',
 '_______EE_______'],
// 28 Scorpion
['________________',
 '____NNNN________',
 '___NNNNNNn______',
 '__NNNNKNNNn_____',
 '__NNNNKNNNn_____',
 '___NNNNNNNn_____',
 '____NNNNNNNNn___',
 '_____NNNNNNNNn__',
 '_____NNNNNNNn___',
 '____NNNNNNNn____',
 '____NNNNNNn_____',
 '___NNNNNnn______',
 '___N_NN_N_______',
 '__NN__NN_NN_____',
 '________________',
 '________________'],
// 29 Spider
['H______________H',
 '_H____________H_',
 '__H__________H__',
 '___H__HHHH__H___',
 '____HHHHHHHH____',
 '____HHKHHKHH____',
 '____HHHHHHHH____',
 '___H__HHHH__H___',
 '__H__________H__',
 '_H____________H_',
 'H______________H',
 '________________',
 '________________',
 '________________',
 '________________',
 '________________'],
// 30 Mountain
['________________',
 '________WW______',
 '_______WWWW_____',
 '______WWWWWW____',
 '_____WWWWWWWW___',
 '___WWWWSSsWWWW__',
 '__WWWWWSSsWWWWW_',
 '_WWWWWWWWWWWWWW_',
 'SSSSSSSSSSSSSSSS',
 'SSSSSSSSSSSSSSSS',
 'DDDDDDDDDDDDDDDD',
 'DDDDDDDDDDDDDDDD',
 'HHHHHHHHHHHHHHHH',
 'HHHHHHHHHHHHHHHH',
 '________________',
 '________________'],
];

// Draw pixel-art clan icon (16×16) onto a canvas 2D context
function drawClanIconOnCtx(c, iconId, cx, cy, px) {
  const icon = _ICONS[((iconId || 1) - 1) % _ICONS.length];
  const p = px || 1;
  const ox = Math.round(cx - 8 * p);
  const oy = Math.round(cy - 8 * p);
  c.fillStyle = '#18140c';
  c.fillRect(ox, oy, 16 * p, 16 * p);
  icon.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const col = _CP[ch];
      if (!col) return;
      c.fillStyle = col;
      c.fillRect(ox + x * p, oy + y * p, p, p);
    });
  });
}

function clanIconSVG(id, size) {
  const icon = _ICONS[(id - 1) % _ICONS.length];
  const sz = size || 40;
  const rects = [`<rect width="32" height="32" fill="#18140c" rx="2"/>`];
  icon.forEach((row, y) => {
    [...row].forEach((c, x) => {
      const col = _CP[c];
      if (col) rects.push(`<rect x="${x*2}" y="${y*2}" width="2" height="2" fill="${col}"/>`);
    });
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${sz}" height="${sz}" style="image-rendering:pixelated;display:block;border-radius:3px">${rects.join('')}</svg>`;
}

// ── Active clan bonuses (cumulative at current level) ─────
function getClanBonus() {
  if (!clanData) return { gold: 0, xp: 0, atk: 0 };
  const lvl = CLAN_LEVELS[(clanData.level || 1) - 1];
  return lvl ? { ...lvl.bonus } : { gold: 0, xp: 0, atk: 0 };
}

// ── UI state ──────────────────────────────────────────────
let _clanView = 'main';      // 'main' | 'create' | 'search' | 'icon-pick'
let _clanNewName = '';
let _clanNewIcon = 1;
let _clanSearchResults = null;   // null = loading, [] = empty result
let _clanHomeTab = 0;            // 0=клан, 1=участники, 2=навыки
// Gold was spent optimistically for the in-flight clanCreate request — set
// right before sending, cleared (and refunded on failure) when the server
// responds. Gold isn't server-tracked like GRAM, so this is enforced the
// same way every other gold-spending action in this game already is.
let _pendingClanCreateGold = false;
// Clan id of an in-flight (or just-confirmed) application — drives the
// "Отправка.../Отправлено" button state in the search results so clicking
// "Вступить" gives instant feedback instead of the button just sitting there
// until the round-trip completes.
let _clanApplyPendingId = null;
// Leader-only clan description editing (Клан tab) — draft is seeded from the
// live description each time editing starts, so cancelling never loses
// anything and re-opening the editor always starts from what's actually saved.
let _clanDescEditing = false;
let _clanDescDraft = '';

// "12/30" — the cap comes from shared/definitions.js so it can't drift from
// what clanApprove actually enforces server-side. Rendered through the
// existing {n} slot, so every translation of clanMembersByBmFmt picks it up
// without needing a new string.
function _clanMemberCount(c) {
  const n = (c && c.members || []).length;
  return typeof CLAN_MAX_MEMBERS !== 'undefined' ? `${n}/${CLAN_MAX_MEMBERS}` : String(n);
}

function updateClanUI() {
  const el = document.getElementById('clan-body');
  if (!el || !player) return;

  if (_clanView === 'create')      { _renderCreate(el); return; }
  if (_clanView === 'icon-pick')   { _renderIconPick(el); return; }
  if (_clanView === 'search')      { _renderSearch(el); return; }

  if (clanData) {
    _renderClanHome(el);
  } else {
    _renderNoClan(el);
  }
}

// ── No clan screen ────────────────────────────────────────
function _renderNoClan(el) {
  el.innerHTML = `
    <div class="clan-empty">
      <div class="clan-empty-icon">${clanIconSVG(1, 64)}</div>
      <div class="clan-empty-title">${typeof t === 'function' ? t('clanNoClanTitle') : 'У вас нет клана'}</div>
      <div class="clan-empty-sub">${typeof t === 'function' ? t('clanNoClanSub') : 'Создайте свой клан или найдите существующий'}</div>
      <button class="clan-btn clan-btn-create" onclick="_clanGoCreate()">${typeof t === 'function' ? t('clanCreateBtn') : '+ Создать клан'}</button>
      <button class="clan-btn clan-btn-search" onclick="_clanGoSearch()">${typeof t === 'function' ? t('clanFindBtn') : 'Найти клан'}</button>
    </div>`;
}

// ── Create clan screen ────────────────────────────────────
function _clanGoCreate() { _clanView = 'create'; _clanNewName = ''; _clanNewIcon = 1; updateClanUI(); }
function _clanGoSearch()  { _clanView = 'search'; _clanSearchResults = null; updateClanUI(); netClanSearch(''); }
function _clanGoMain()    { _clanView = 'main'; updateClanUI(); }

function _renderCreate(el) {
  const canAfford = player && player.gold >= CLAN_CREATE_COST;
  el.innerHTML = `
    <div class="clan-form">
      <button class="clan-back" onclick="_clanGoMain()">${typeof t === 'function' ? t('clanBackBtn') : '← Назад'}</button>
      <div class="clan-form-title">${typeof t === 'function' ? t('clanCreateTitle') : 'Создать клан'}</div>
      <div class="clan-form-label" style="color:${canAfford ? '#e3941d' : '#da4658'}">${typeof t === 'function' ? t('clanCostLbl') : 'Стоимость'}: ${CLAN_CREATE_COST} ${typeof t === 'function' ? t('npcGoldLbl').toLowerCase() : 'золота'} ${canAfford ? '' : (typeof t === 'function' ? t('clanNotEnough') : '(не хватает)')}</div>
      <div class="clan-form-label" style="margin-top:10px">${typeof t === 'function' ? t('clanNameLbl') : 'Название (до 10 символов)'}</div>
      <input class="clan-input" id="clan-name-inp" maxlength="10" placeholder="${typeof t === 'function' ? t('clanNamePlaceholder') : 'Название...'}" value="${_escAttr(_clanNewName)}"
             oninput="_clanNewName=this.value;_clanUpdatePreview()">
      <div class="clan-form-label" style="margin-top:14px">${typeof t === 'function' ? t('clanIconLbl') : 'Иконка клана'}</div>
      <div class="clan-icon-preview" onclick="_clanPickIcon()">
        ${clanIconSVG(_clanNewIcon, 48)}
        <span class="clan-icon-change">${typeof t === 'function' ? t('clanChangeBtn') : 'Изменить'}</span>
      </div>
      <div id="clan-create-err" class="clan-err"></div>
      <button class="clan-btn clan-btn-create" style="margin-top:16px" onclick="_clanSubmitCreate()">${typeof t === 'function' ? t('clanCreateSubmit') : 'Создать'}</button>
    </div>`;
}

function _clanUpdatePreview() {}

function _clanPickIcon() { _clanView = 'icon-pick'; updateClanUI(); }

function _renderIconPick(el) {
  const grid = _ICONS.map((_, i) => {
    const id = i + 1;
    const sel = id === _clanNewIcon ? ' clan-icon-sel' : '';
    return `<div class="clan-icon-cell${sel}" onclick="_clanSelectIcon(${id})">${clanIconSVG(id, 36)}</div>`;
  }).join('');
  el.innerHTML = `
    <div class="clan-form">
      <button class="clan-back" onclick="_clanView='create';updateClanUI()">${typeof t === 'function' ? t('clanBackBtn') : '← Назад'}</button>
      <div class="clan-form-title">${typeof t === 'function' ? t('clanPickIconTitle') : 'Выбери иконку'}</div>
      <div class="clan-icon-grid">${grid}</div>
    </div>`;
}

function _clanSelectIcon(id) { _clanNewIcon = id; _clanView = 'create'; updateClanUI(); }

function _clanSubmitCreate() {
  const name = (_clanNewName || '').trim();
  if (!name) { const e = document.getElementById('clan-create-err'); if (e) e.textContent = typeof t === 'function' ? t('clanEnterName') : 'Введите название'; return; }
  if (!player || player.gold < CLAN_CREATE_COST) {
    const e = document.getElementById('clan-create-err');
    if (e) e.textContent = typeof tVars === 'function' ? tVars('clanNeedGold', { n: CLAN_CREATE_COST }) : `Нужно ${CLAN_CREATE_COST} золота`;
    return;
  }
  // The fee is charged server-side by clanCreate; the new balance arrives
  // as a goldSync. Deducting here as well would double-charge the display.
  _pendingClanCreateGold = true;
  if (typeof updateInvUI === 'function') updateInvUI();
  netClanCreate(name, _clanNewIcon);
}

// ── Search screen ─────────────────────────────────────────
// Shared by _renderSearch's initial paint and onClanSearchResults' refresh
// (the server round-trip that fills #clan-search-results in once results
// actually arrive) so the pending/sent button state stays consistent
// regardless of which of the two just re-rendered the row.
function _clanResultRowHTML(c) {
  const pending = _clanApplyPendingId === c.id;
  const label = pending
    ? (typeof t === 'function' ? t('clanApplySending') : 'Отправка...')
    : (typeof t === 'function' ? t('clanJoinBtn') : 'Вступить');
  return `
    <div class="clan-result">
      <div class="clan-result-icon">${clanIconSVG(c.icon, 36)}</div>
      <div class="clan-result-info">
        <div class="clan-result-name">${_esc(c.name)}</div>
        <div class="clan-result-meta">${typeof tVars === 'function' ? tVars('clanLevelMembersFmt', { lvl: c.level, n: c.members }) : 'Ур. ' + c.level + ' · ' + c.members + ' участников'}</div>
      </div>
      <button class="clan-btn-sm" data-clan-id="${c.id}" ${pending ? 'disabled' : ''} onclick="_clanApplyTo('${c.id}')">${label}</button>
    </div>`;
}

function _renderSearch(el) {
  let results;
  if (_clanSearchResults === null) {
    results = '<div class="clan-nores">' + (typeof t === 'function' ? t('questLoading') : 'Загрузка...') + '</div>';
  } else if (_clanSearchResults.length === 0) {
    results = '<div class="clan-nores">' + (typeof t === 'function' ? t('clanNotFound') : 'Кланы не найдены') + '</div>';
  } else {
    results = _clanSearchResults.map(_clanResultRowHTML).join('');
  }

  el.innerHTML = `
    <div class="clan-form">
      <button class="clan-back" onclick="_clanGoMain()">${typeof t === 'function' ? t('clanBackBtn') : '← Назад'}</button>
      <div class="clan-form-title">${typeof t === 'function' ? t('clanSearchTitle') : 'Найти клан'}</div>
      <div class="clan-search-row">
        <input class="clan-input" id="clan-search-inp" placeholder="${typeof t === 'function' ? t('clanNamePlaceholder2') : 'Название клана...'}" maxlength="10">
        <button class="clan-btn-sm" onclick="_clanDoSearch()">${typeof t === 'function' ? t('clanSearchBtn') : 'Найти'}</button>
      </div>
      <div id="clan-search-results">${results}</div>
    </div>`;
}

function _clanDoSearch() {
  const inp = document.getElementById('clan-search-inp');
  if (inp) netClanSearch(inp.value.trim());
}

// ── Clan home screen ──────────────────────────────────────
function _setClanHomeTab(n) { _clanHomeTab = n; updateClanUI(); }

function _clanDescStartEdit() {
  _clanDescDraft = (clanData && clanData.description) || '';
  _clanDescEditing = true;
  updateClanUI();
}
function _clanDescCancelEdit() {
  _clanDescEditing = false;
  updateClanUI();
}
function _clanDescSave() {
  const inp = document.getElementById('clan-desc-inp');
  const text = inp ? inp.value.trim() : _clanDescDraft.trim();
  _clanDescEditing = false;
  netClanSetDescription(text);
  // Optimistic: the server will echo the (sanitized) real value back via
  // clanData shortly, but there's no reason to wait for that round-trip to
  // stop showing the editor.
  if (clanData) clanData.description = text;
  updateClanUI();
}

function _renderClanHome(el) {
  const c = clanData;
  const lvlDef = CLAN_LEVELS[(c.level || 1) - 1];
  const nextDef = CLAN_LEVELS[c.level] || null;
  const xpPct = nextDef ? Math.min(100, Math.round((c.xp - lvlDef.xpReq) / (nextDef.xpReq - lvlDef.xpReq) * 100)) : 100;
  const bonus = getClanBonus();
  const isLeader = c.myRole === 'leader';
  const myBM = typeof calcBM === 'function' && player ? calcBM(player) : 0;

  const bonusLines = [];
  if (bonus.gold > 0) bonusLines.push(`+${bonus.gold}% ${typeof t === 'function' ? t('clanPerkGold').toLowerCase() : 'золото'}`);
  if (bonus.xp   > 0) bonusLines.push(`+${bonus.xp}% ${typeof t === 'function' ? t('clanPerkXp').toLowerCase() : 'опыт'}`);
  if (bonus.atk  > 0) bonusLines.push(`+${bonus.atk}% ${typeof t === 'function' ? t('clanPerkAtk').toLowerCase() : 'атака'}`);
  const bonusHtml = bonusLines.length
    ? bonusLines.map(l => `<span class="clan-bonus-tag">${l}</span>`).join('')
    : `<span class="clan-bonus-tag clan-bonus-none">${typeof t === 'function' ? t('clanNoBonusYet') : 'бонусов пока нет'}</span>`;

  const tabs = [
    typeof t === 'function' ? t('clanTabHome') : 'Клан',
    typeof t === 'function' ? t('clanTabMembers') : 'Участники',
    typeof t === 'function' ? t('clanTabPerks') : 'Навыки',
    typeof t === 'function' ? t('clanTabStorage') : 'Хранилище',
  ];
  const tabHtml = tabs.map((t, i) =>
    `<div class="clan-tab${_clanHomeTab === i ? ' active' : ''}" onclick="_setClanHomeTab(${i})">${t}</div>`
  ).join('');

  let bodyHtml = '';
  if (_clanHomeTab === 0) {
    // ── Клан tab: description + XP bar + leave/disband ────────────
    const descMax = typeof CLAN_DESC_MAX_CHARS !== 'undefined' ? CLAN_DESC_MAX_CHARS : 200;
    let descHtml;
    if (_clanDescEditing) {
      descHtml = `
        <div class="clan-desc-edit">
          <textarea class="clan-input clan-desc-input" id="clan-desc-inp" maxlength="${descMax}"
                    placeholder="${typeof t === 'function' ? t('clanDescPlaceholder') : 'Расскажите о клане...'}">${_esc(_clanDescDraft)}</textarea>
          <div class="clan-desc-actions">
            <button class="clan-btn-sm" onclick="_clanDescSave()">${typeof t === 'function' ? t('clanSaveBtn') : 'Сохранить'}</button>
            <button class="clan-btn-sm clan-btn-danger" onclick="_clanDescCancelEdit()">${typeof t === 'function' ? t('clanCancelBtn') : 'Отмена'}</button>
          </div>
        </div>`;
    } else {
      descHtml = `
        <div class="clan-desc${c.description ? '' : ' clan-desc-empty'}">
          <span class="clan-desc-text">${c.description ? _esc(c.description) : (typeof t === 'function' ? t('clanDescEmpty') : 'Описание клана пока не добавлено')}</span>
          ${isLeader ? `<button class="clan-desc-edit-btn" onclick="_clanDescStartEdit()" title="${typeof t === 'function' ? t('clanDescEditTitle') : 'Изменить описание'}">✎</button>` : ''}
        </div>`;
    }
    bodyHtml = `
      ${descHtml}
      <div class="clan-xp-block">
        <div class="clan-xp-label">
          ${typeof t === 'function' ? t('clanPointsLbl') : 'Очки клана'}: ${c.xp.toLocaleString()}
          ${nextDef ? `· ${typeof tVars === 'function' ? tVars('clanUntilLevel', { lvl: c.level + 1 }) : 'до ур.' + (c.level+1)}: ${(nextDef.xpReq - c.xp).toLocaleString()}` : `· ${typeof t === 'function' ? t('clanMaxLevel') : 'Макс. уровень'}`}
        </div>
        <div class="clan-xp-bar-bg"><div class="clan-xp-bar-fill" style="width:${xpPct}%"></div></div>
      </div>
      <div class="clan-bonus-row" style="margin-bottom:14px">${bonusHtml}</div>
      ${myBM ? `<div class="clan-my-bm">${typeof t === 'function' ? t('clanYourBmLbl') : 'Ваша БМ'}: <span>${myBM.toLocaleString()}</span></div>` : ''}
      <div style="margin-top:16px">
        ${isLeader
          ? `<button class="clan-btn clan-btn-danger" onclick="_clanConfirmDisband()">${typeof t === 'function' ? t('clanDisbandBtn') : 'Расформировать'}</button>`
          : `<button class="clan-btn clan-btn-leave" onclick="_clanConfirmLeave()">${typeof t === 'function' ? t('clanLeaveBtn') : 'Покинуть клан'}</button>`}
      </div>`;
  } else if (_clanHomeTab === 1) {
    // ── Участники tab ──────────────────────────────────────
    const membersHtml = (c.members || [])
      .slice().sort((a, b) => (b.bm || 0) - (a.bm || 0))
      .map(m => {
        const roleIcon = m.role === 'leader' ? '👑' : '⚔️';
        const kickBtn = isLeader && m.role !== 'leader'
          ? `<button class="clan-btn-sm clan-btn-danger" onclick="netClanKick('${m.telegramId}')">${typeof t === 'function' ? t('clanKickBtn') : 'Исключить'}</button>`
          : '';
        return `<div class="clan-member">
          <span class="clan-member-role">${roleIcon}</span>
          <span class="clan-member-name">${_esc(m.username)}</span>
          ${m.bm ? `<span class="clan-member-bm">БМ ${m.bm.toLocaleString()}</span>` : ''}
          ${kickBtn}
        </div>`;
      }).join('');

    let appsHtml = '';
    if (isLeader && c.applications && c.applications.length > 0) {
      appsHtml = `<div class="clan-section-hdr" style="margin-top:14px">${typeof tVars === 'function' ? tVars('clanApplicationsFmt', { n: c.applications.length }) : 'Заявки (' + c.applications.length + ')'}</div>` +
        c.applications.map(a => `
          <div class="clan-member">
            <span class="clan-member-name">⌛ ${_esc(a.username)}</span>
            <button class="clan-btn-sm" onclick="netClanApprove('${a.telegramId}')">${typeof t === 'function' ? t('clanApproveBtn') : 'Принять'}</button>
            <button class="clan-btn-sm clan-btn-danger" onclick="netClanDecline('${a.telegramId}')">${typeof t === 'function' ? t('clanDeclineBtn') : 'Отказать'}</button>
          </div>`).join('');
    }
    bodyHtml = `
      <div class="clan-section-hdr">${typeof tVars === 'function' ? tVars('clanMembersByBmFmt', { n: _clanMemberCount(c) }) : 'Участники (' + _clanMemberCount(c) + ') · по БМ'}</div>
      ${membersHtml}
      ${appsHtml}`;
  } else if (_clanHomeTab === 2) {
    // ── Навыки tab: perk tree by level ────────────────────
    const PERKS_RU = [
      { lvl:2,  icon:'💰', label:'Золото', desc:'+5% к золоту с врагов'   },
      { lvl:3,  icon:'⚡', label:'Опыт',   desc:'+5% к опыту с врагов'    },
      { lvl:4,  icon:'💰', label:'Золото', desc:'+10% к золоту суммарно'  },
      { lvl:5,  icon:'⚔️', label:'Атака',  desc:'+5% к атаке участников'  },
      { lvl:6,  icon:'⚡', label:'Опыт',   desc:'+10% к опыту суммарно'   },
      { lvl:7,  icon:'💰', label:'Золото', desc:'+15% к золоту суммарно'  },
      { lvl:8,  icon:'⚔️', label:'Атака',  desc:'+10% к атаке суммарно'   },
      { lvl:9,  icon:'⚡', label:'Опыт',   desc:'+15% к опыту суммарно'   },
      { lvl:10, icon:'💰', label:'Золото', desc:'+20% к золоту'            },
      { lvl:10, icon:'⚡', label:'Опыт',   desc:'+20% к опыту'             },
      { lvl:10, icon:'⚔️', label:'Атака',  desc:'+15% к атаке'             },
    ];
    const PERK_LABEL_KEY = { 'Золото':'clanPerkGold', 'Опыт':'clanPerkXp', 'Атака':'clanPerkAtk' };
    const perksHtml = PERKS_RU.map((pk, idx) => {
      const unlocked = c.level >= pk.lvl;
      const cls = unlocked ? 'clan-perk unlocked' : 'clan-perk locked';
      const label = (typeof t === 'function' && PERK_LABEL_KEY[pk.label]) ? t(PERK_LABEL_KEY[pk.label]) : pk.label;
      const descEntry = typeof I18N_CLAN_PERK_DESC !== 'undefined' ? I18N_CLAN_PERK_DESC[idx] : null;
      const desc = (descEntry && typeof currentLang !== 'undefined' && descEntry[currentLang]) || pk.desc;
      return `<div class="${cls}">
        <div class="clan-perk-icon">${pk.icon}</div>
        <div class="clan-perk-body">
          <div class="clan-perk-name">${label} <span class="clan-perk-lvl">Ур.${pk.lvl}</span></div>
          <div class="clan-perk-desc">${desc}</div>
        </div>
      </div>`;
    }).join('');
    bodyHtml = `
      <div class="clan-section-hdr">${typeof t === 'function' ? t('clanPerksHdr') : 'Бонусы клана по уровням'}</div>
      <div class="clan-perks">${perksHtml}</div>`;
  } else if (_clanHomeTab === 3) {
    bodyHtml = _clanStorageHTML();
  }

  el.innerHTML = `
    <div class="clan-home">
      <div class="clan-hdr">
        <div class="clan-hdr-icon">${clanIconSVG(c.icon, 48)}</div>
        <div class="clan-hdr-info">
          <div class="clan-hdr-name">${_esc(c.name)}</div>
          <div class="clan-hdr-level">${lvlDef.label} · Ур. ${c.level}/10</div>
        </div>
      </div>
      <div class="clan-tabs">${tabHtml}</div>
      ${bodyHtml}
    </div>`;
}

// ── Хранилище клана ───────────────────────────────────────
// Everything rendered here is server state (_clanStorage, pushed on every
// change); this file only draws it and sends intents back. The eligibility
// gate is shown rather than hidden — a member who cannot use it yet should be
// able to see how long is left, not just find the tab empty.
function _clanStorageHTML() {
  const s = _clanStorage;
  if (!s) {
    if (typeof netClanStorageSync === 'function') netClanStorageSync();
    return `<div class="clan-empty">${typeof t === 'function' ? t('clanStorageLoading') : 'Загрузка...'}</div>`;
  }

  // Not bought yet — that is the whole tab until it is. The leader gets the
  // button (with what it costs and what they hold); everyone else is told who
  // can open it, so nobody is left guessing why the tab is empty.
  if (!s.unlocked) {
    const cost = s.unlockCost || 0;
    const gold = (player && player.gold) || 0;
    const afford = gold >= cost;
    return `
      <div class="clan-storage-gate">${tVars('clanStorageLockedFmt', { n: _num(cost) })}</div>
      ${s.isLeader
        ? `<div class="clan-storage-row">
             <span class="clan-storage-name">${t('clanStorageYourGold')}</span>
             <span class="clan-storage-qty" style="color:${afford ? '#8fbf7a' : '#eb4e61'}">${_num(gold)}</span>
           </div>
           <button class="clan-btn${afford ? '' : ' clan-btn-disabled'}"
                   onclick="${afford ? '_clanStorageUnlockConfirm()' : ''}">
             ${tVars('clanStorageUnlockBtn', { n: _num(cost) })}
           </button>`
        : `<div class="clan-empty">${t('clanStorageLockedMember')}</div>`}`;
  }

  const gate = s.canUse ? '' : `
    <div class="clan-storage-gate">
      ${tVars('clanStorageGateFmt', { d: s.minDays, cur: s.daysIn == null ? 0 : s.daysIn })}
    </div>`;

  // What the clan is holding.
  const poolRows = (s.storage || []).length
    ? s.storage.map(e => `
        <div class="clan-storage-row">
          ${e.img ? `<img class="clan-storage-img" src="${_esc(e.img)}" alt="">` : ''}
          <span class="clan-storage-name">${_esc(e.name)}</span>
          <span class="clan-storage-qty">${e.qty}</span>
          ${s.isLeader && s.canUse
            ? `<button class="clan-btn-sm" onclick="_clanStorageGivePrompt('${_esc(e.id)}','${_esc(e.name)}',${e.qty})">${t('clanStorageGiveBtn')}</button>`
            : ''}
        </div>`).join('')
    : `<div class="clan-empty">${t('clanStorageEmpty')}</div>`;

  // What is waiting to be collected. A member sees only their own, so for them
  // this doubles as the collect button.
  const mine = (s.allocations || []).filter(a => !s.isLeader || a.telegramId === _myTelegramId());
  const allocRows = (s.allocations || []).length
    ? s.allocations.map(a => `
        <div class="clan-storage-row">
          ${a.img ? `<img class="clan-storage-img" src="${_esc(a.img)}" alt="">` : ''}
          <span class="clan-storage-name">${_esc(a.name)}${s.isLeader ? ` <span class="clan-storage-who">→ ${_esc(a.username || '')}</span>` : ''}</span>
          <span class="clan-storage-qty">${a.qty}</span>
          ${s.isLeader
            ? `<button class="clan-btn-sm clan-btn-danger" onclick="_clanStorageCancel('${_esc(a.telegramId)}','${_esc(a.id)}')">${t('clanStorageCancelBtn')}</button>`
            : ''}
        </div>`).join('')
    : `<div class="clan-empty">${t('clanStorageNoAlloc')}</div>`;

  const claimBtn = (mine.length && s.canUse)
    ? `<button class="clan-btn" onclick="netClanStorageClaim()">${t('clanStorageClaimBtn')}</button>`
    : '';

  // Deposit — only the shards actually in the player's bag are offered, so
  // there is no way to pick something they don't have.
  const held = (player && player.inventory || [])
    .filter(i => i && typeof UNIQUE_SHARDS !== 'undefined' && UNIQUE_SHARDS.some(u => u.id === i.id));
  const depositRows = !s.canUse ? '' : (held.length
    ? held.map(i => `
        <div class="clan-storage-row">
          ${i.img ? `<img class="clan-storage-img" src="${_esc(i.img)}" alt="">` : ''}
          <span class="clan-storage-name">${_esc(i.name)}</span>
          <span class="clan-storage-qty">${i.qty || 1}</span>
          <button class="clan-btn-sm" onclick="_clanStorageDepositPrompt('${_esc(i.id)}','${_esc(i.name)}',${i.qty || 1})">${t('clanStorageDepositBtn')}</button>
        </div>`).join('')
    : `<div class="clan-empty">${t('clanStorageNoShards')}</div>`);

  return `
    ${gate}
    <div class="clan-section-hdr">${t('clanStorageHdr')}</div>
    <div class="clan-storage-list">${poolRows}</div>
    <div class="clan-section-hdr">${s.isLeader ? t('clanStorageAllocHdrLeader') : t('clanStorageAllocHdr')}</div>
    <div class="clan-storage-list">${allocRows}</div>
    ${claimBtn}
    ${s.canUse ? `<div class="clan-section-hdr">${t('clanStorageDepositHdr')}</div>
    <div class="clan-storage-list">${depositRows}</div>` : ''}`;
}

// The clan payload keys members by telegramId, which this client otherwise
// never needs — read it off the member row that matches our own username.
function _myTelegramId() {
  if (!clanData || !netUsername) return null;
  const me = (clanData.members || []).find(m => m.username === netUsername);
  return me ? me.telegramId : null;
}

// Thousands separators, so a seven-figure price is readable at a glance.
function _num(n) { return Number(n || 0).toLocaleString('ru-RU'); }

function _clanStorageUnlockConfirm() {
  const s = _clanStorage;
  if (!s || s.unlocked) return;
  if (!confirm(tVars('clanStorageUnlockAsk', { n: _num(s.unlockCost || 0) }))) return;
  netClanStorageUnlock();
}

function _clanStorageDepositPrompt(id, name, max) {
  const raw = prompt(tVars('clanStorageDepositAsk', { name, max }), String(max));
  if (raw == null) return;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return;
  if (n > max) { _marketToast(tVars('clanStorageTooMany', { max }), 'err'); return; }
  netClanStorageDeposit(id, n);
}

function _clanStorageGivePrompt(id, name, max) {
  const s = _clanStorage;
  if (!s || !s.members || !s.members.length) {
    _marketToast(t('clanStorageNoEligible'), 'err');
    return;
  }
  const list = s.members.map((m, i) => `${i + 1}. ${m.username}`).join('\n');
  const pick = prompt(tVars('clanStorageGiveWho', { name, list }), '1');
  if (pick == null) return;
  const idx = Math.floor(Number(pick)) - 1;
  const target = s.members[idx];
  if (!target) { _marketToast(t('clanStorageBadPick'), 'err'); return; }
  const raw = prompt(tVars('clanStorageGiveHowMany', { name, who: target.username, max }), String(max));
  if (raw == null) return;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return;
  if (n > max) { _marketToast(tVars('clanStorageTooMany', { max }), 'err'); return; }
  netClanStorageGive(target.telegramId, id, n);
}

function _clanStorageCancel(telegramId, id) {
  if (!confirm(t('clanStorageCancelAsk'))) return;
  netClanStorageCancel(telegramId, id);
}

// Server pushed new storage state — redraw only when that tab is showing.
function onClanStorage() {
  if (_clanHomeTab === 3) updateClanUI();
}

function _clanConfirmLeave() {
  if (confirm(typeof t === 'function' ? t('clanConfirmLeave') : 'Покинуть клан?')) netClanLeave();
}
function _clanConfirmDisband() {
  if (confirm(typeof t === 'function' ? t('clanConfirmDisband') : 'Расформировать клан? Это нельзя отменить.')) netClanDisband();
}

// ── Notification when clan levels up ─────────────────────
function showClanLevelUp(level) {
  const lvDef = CLAN_LEVELS[level - 1];
  dmgNum(player.x, player.y - 54, typeof tVars === 'function' ? tVars('clanLevelUpToast', { lvl: level }) : `Клан уровень ${level}!`, '#e69419');
  spawnBurst(player.x, player.y, '#e69419', 10);
  if (lvDef) {
    const b = lvDef.bonus;
    const goldLbl = typeof t === 'function' ? t('clanPerkGold').toLowerCase() : 'золото';
    const xpLbl = typeof t === 'function' ? t('clanPerkXp').toLowerCase() : 'опыт';
    const atkLbl = typeof t === 'function' ? t('clanPerkAtk').toLowerCase() : 'атака';
    const parts = [b.gold?`+${b.gold}%${goldLbl}`:'', b.xp?`+${b.xp}%${xpLbl}`:'', b.atk?`+${b.atk}%${atkLbl}`:''].filter(Boolean);
    if (parts.length) dmgNum(player.x, player.y - 72, parts.join(' '), '#e69419');
  }
}

// ── Helpers ───────────────────────────────────────────────
// One escaper, not two near-copies. This was the same four lines as _escHtml
// in network.js, and two copies of a security rule is one copy that will not
// be updated the day the rule changes.
function _esc(s) { return _escHtml(String(s == null ? '' : s)); }

// Called from network.js when server pushes clan state
function onClanData(data) {
  const prevClan = clanData;
  const prevLevel = clanData ? clanData.level : null;
  if (_pendingClanCreateGold) { _pendingClanCreateGold = false; netSaveProgress(); }
  clanData = data;
  if (data && prevLevel !== null && data.level > prevLevel) {
    showClanLevelUp(data.level);
  }
  // Switch to clan home when we just joined/created (had no clan before, now we do)
  if (data && !prevClan) {
    _clanView = 'main';
  }
  // Switch back to no-clan view when kicked/left
  if (!data && prevClan) {
    _clanView = 'main';
  }
  // Joining/leaving a clan or its level changing all move the "Атака" perk
  // percentage recompute() reads via getClanBonus() — without this the new
  // atk multiplier wouldn't take effect until some unrelated gear/level-up
  // trigger happened to call recompute() on its own.
  if (typeof recompute === 'function' && typeof player !== 'undefined' && player) recompute();
  if (activeTab === 4) updateClanUI();
}

// Looks up the still-rendered "Вступить" button for a clan id, if the
// search results happen to still be on screen — the apply can resolve after
// the player has already navigated elsewhere, so every caller treats a miss
// here as normal, not an error.
function _clanApplyBtn(clanId) {
  return document.querySelector(`.clan-btn-sm[data-clan-id="${clanId}"]`);
}

// Instant feedback the moment "Вступить" is tapped, instead of the button
// just sitting there identical until the round-trip completes (which is what
// made applying look like it did nothing). Targets the one button directly
// rather than a full re-render, so it doesn't blow away whatever the player
// has typed into the search box.
function _clanApplyTo(clanId) {
  if (_clanApplyPendingId) return; // one application in flight at a time
  _clanApplyPendingId = clanId;
  const btn = _clanApplyBtn(clanId);
  if (btn) { btn.disabled = true; btn.textContent = typeof t === 'function' ? t('clanApplySending') : 'Отправка...'; }
  netClanApply(clanId);
}

// Server confirmed the application landed (see the dedicated 'clanApplySent'
// event, server/index.js) — leaves the button showing "Отправлено" rather
// than reverting to "Вступить", so it's obvious afterwards which clan this
// went to.
function onClanApplySent(clanId) {
  _clanApplyPendingId = null;
  const btn = _clanApplyBtn(clanId);
  if (btn) { btn.textContent = '✓ ' + (typeof t === 'function' ? t('clanApplySentBtn') : 'Отправлено'); }
}

function onClanError(msg) {
  if (_pendingClanCreateGold) {
    _pendingClanCreateGold = false;
    // Nothing to refund locally — the charge only ever happened server-side,
    // and a failed create never reached it.
  }
  // An apply that failed (already in a clan, clan vanished, etc.) — put the
  // button back rather than leaving it stuck on "Отправка...".
  if (_clanApplyPendingId) {
    const btn = _clanApplyBtn(_clanApplyPendingId);
    if (btn) { btn.disabled = false; btn.textContent = typeof t === 'function' ? t('clanJoinBtn') : 'Вступить'; }
    _clanApplyPendingId = null;
  }
  const errEl = document.getElementById('clan-create-err');
  if (errEl) { errEl.textContent = msg; return; }
  const body = document.getElementById('clan-body');
  if (body) {
    const d = document.createElement('div');
    d.className = 'clan-err';
    d.textContent = msg;
    body.prepend(d);
    setTimeout(() => d.remove(), 3000);
  }
}

function onClanSearchResults(results) {
  _clanSearchResults = results;
  const el = document.getElementById('clan-search-results');
  if (!el) return;
  el.innerHTML = results.length
    ? results.map(_clanResultRowHTML).join('')
    : `<div class="clan-nores">${typeof t === 'function' ? t('clanNotFound') : 'Кланы не найдены'}</div>`;
}
