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
  if (!clanData) return { gold: 0, xp: 0, atk: 0, aspd: 0, crit: 0 };
  return clanBonusOf(clanData.level || 1);
}

// ── UI state ──────────────────────────────────────────────
let _clanView = 'main';      // 'main' | 'create' | 'search' | 'icon-pick'
let _clanNewName = '';
let _clanNewIcon = 1;
let _clanSearchResults = null;   // null = loading, [] = empty result
let _clanHomeTab = 0;            // 0=клан, 1=участники, 2=навыки, 3=хранилище, 4=активность
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
  const perk = (icon, col, title, text) => `<div class="clx-perk">${_clxIco(icon, 18, col)}<div><b>${title}</b><span>${text}</span></div></div>`;
  el.innerHTML = `
    <div class="clx">
      <div class="clx-hero clx-hero-empty">
        <div class="clx-emblem">${clanIconSVG(1, 46)}</div>
        <div class="clx-hero-main">
          <div class="clx-name">${typeof t === 'function' ? t('clanNoClanTitle') : 'У вас нет клана'}</div>
          <div class="clx-sub">${typeof t === 'function' ? t('clanNoClanSub') : 'Создайте свой клан или найдите существующий'}</div>
        </div>
      </div>
      <div class="clx-perks">
        ${perk('star', '#f0c75e', 'Бонусы', 'до +30% золота и опыта, +25% атаки, скорости атаки и силы крита')}
        ${perk('castle', '#8fd0ff', 'Война гильдий', 'вышки приносят клану до 300 Liberty в день')}
        ${perk('skullFace', '#ff7a6a', 'Гильдийские боссы', 'бьёте всем кланом, дроп — в хранилище')}
      </div>
      <button class="clx-btn wide" onclick="_clanGoCreate()">${typeof t === 'function' ? t('clanCreateBtn') : '+ Создать клан'}</button>
      <button class="clx-btn wide ghost" onclick="_clanGoSearch()">${typeof t === 'function' ? t('clanFindBtn') : 'Найти клан'}</button>
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
function _setClanHomeTab(n) {
  _clanHomeTab = n;
  _clxOpenMember = null;
  if (n === 5 && typeof netGuildBossSync === 'function') netGuildBossSync();
  updateClanUI();
}

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

// ── Clan home screen (оформление «clx») ───────────────────────────────────
// Шапка — эмблема с уровнем, название, прогресс до следующего уровня и
// действующие бонусы одной строкой. Ниже — вкладки-иконки и тело вкладки.
// Номера вкладок прежние (0 клан … 5 босс): по ним onClanStorage/
// onClanActivity/onGuildBossState решают, перерисовывать ли.
const _CLX_TABS = [
  { icon: 'castle',  key: 'clxTabHome',    ru: 'Клан' },
  { icon: 'party',   key: 'clxTabMembers', ru: 'Состав' },
  { icon: 'star',    key: 'clxTabPerks',   ru: 'Бонусы' },
  { icon: 'storage', key: 'clxTabStorage', ru: 'Склад' },
  { icon: 'trophy',  key: 'clxTabDonors',  ru: 'Вклад' },
  { icon: 'skullFace', key: 'clxTabBoss',  ru: 'Босс' },
];
const _CLX_BONUS = [
  { k: 'gold', icon: 'coin',      key: 'clanPerkGold', ru: 'Золото',        col: '#f0c75e' },
  { k: 'xp',   icon: 'star',      key: 'clanPerkXp',   ru: 'Опыт',          col: '#8fd0ff' },
  { k: 'atk',  icon: 'sword',     key: 'clanPerkAtk',  ru: 'Атака',         col: '#ff7a6a' },
  { k: 'aspd', icon: 'wind',      key: 'clanPerkAspd', ru: 'Скорость атаки', col: '#7ee0b0' },
  { k: 'crit', icon: 'burst',     key: 'clanPerkCrit', ru: 'Сила крита',    col: '#d59cff' },
];
let _clxOpenMember = null;   // telegramId участника, у которого раскрыты действия лидера

function _clxT(key, ru) { return (key && typeof t === 'function') ? t(key) : ru; }
function _clxIco(name, size, col) { return typeof iconHTML === 'function' ? iconHTML(name, size, col || 'currentColor') : ''; }

function _clxBonusChips(b, opts = {}) {
  const chips = _CLX_BONUS.filter(x => (b[x.k] || 0) > 0).map(x =>
    `<span class="clx-chip" style="--cc:${x.col}" title="${_clxT(x.key, x.ru)}">${_clxIco(x.icon, 12, x.col)}+${b[x.k]}%${opts.labels ? ` <em>${_clxT(x.key, x.ru).toLowerCase()}</em>` : ''}</span>`);
  return chips.length ? chips.join('') : `<span class="clx-chip clx-chip-none">${_clxT('clanNoBonusYet', 'бонусов пока нет')}</span>`;
}

function _clxDaysIn(joinedAt) {
  if (!joinedAt) return '';
  const d = Math.floor((Date.now() - new Date(joinedAt).getTime()) / 86400000);
  return d < 1 ? 'сегодня' : `${d} дн.`;
}

function _renderClanHome(el) {
  const c = clanData;
  const lvlDef = CLAN_LEVELS[(c.level || 1) - 1] || CLAN_LEVELS[0];
  const nextDef = CLAN_LEVELS[c.level] || null;
  const xpPct = nextDef ? Math.max(0, Math.min(100, (c.xp - lvlDef.xpReq) / (nextDef.xpReq - lvlDef.xpReq) * 100)) : 100;
  const isLeader = c.myRole === 'leader';

  const tabs = _CLX_TABS.map((tb, i) =>
    `<button class="clx-tab${_clanHomeTab === i ? ' on' : ''}" onclick="_setClanHomeTab(${i})">${_clxIco(tb.icon, 17)}<span>${_clxT(tb.key, tb.ru)}</span></button>`).join('');

  let body = '';
  if (_clanHomeTab === 0) body = _clxHomeTab(c, isLeader);
  else if (_clanHomeTab === 1) body = _clxMembersTab(c, isLeader);
  else if (_clanHomeTab === 2) body = _clxPerksTab(c);
  else if (_clanHomeTab === 3) body = _clanStorageHTML();
  else if (_clanHomeTab === 4) body = _clanActivityHTML();
  else if (_clanHomeTab === 5) body = _clanBossHTML();

  el.innerHTML = `
    <div class="clx">
      <div class="clx-hero">
        <div class="clx-emblem">${clanIconSVG(c.icon, 46)}<span class="clx-lvl">${c.level}</span></div>
        <div class="clx-hero-main">
          <div class="clx-name">${_esc(c.name)}</div>
          <div class="clx-sub">${_esc(lvlDef.label)} · ${_clxIco('party', 12)} ${_clanMemberCount(c)}${isLeader ? ` · ${_clxIco('crown', 12, '#f0c75e')} лидер` : ''}</div>
          <div class="clx-xp"><i style="width:${xpPct.toFixed(1)}%"></i></div>
          <div class="clx-xp-txt">
            <span>${_num(c.xp)} очков</span>
            <span>${nextDef ? `до ${c.level + 1} ур. — ${_num(nextDef.xpReq - c.xp)}` : _clxT('clanMaxLevel', 'Макс. уровень')}</span>
          </div>
        </div>
      </div>
      <div class="clx-chips">${_clxBonusChips(getClanBonus())}</div>
      <div class="clx-tabs">${tabs}</div>
      <div class="clx-body">${body}</div>
    </div>`;
}

// ── Обзор ─────────────────────────────────────────────────
function _clxHomeTab(c, isLeader) {
  const descMax = typeof CLAN_DESC_MAX_CHARS !== 'undefined' ? CLAN_DESC_MAX_CHARS : 200;
  const desc = _clanDescEditing
    ? `<div class="clx-card">
        <textarea class="clan-input clan-desc-input" id="clan-desc-inp" maxlength="${descMax}"
          placeholder="${_clxT('clanDescPlaceholder', 'Расскажите о клане...')}">${_esc(_clanDescDraft)}</textarea>
        <div class="clx-row-end">
          <button class="clx-btn ghost" onclick="_clanDescCancelEdit()">${_clxT('clanCancelBtn', 'Отмена')}</button>
          <button class="clx-btn" onclick="_clanDescSave()">${_clxT('clanSaveBtn', 'Сохранить')}</button>
        </div>
      </div>`
    : `<div class="clx-desc${c.description ? '' : ' empty'}">
        <span>${c.description ? _esc(c.description) : _clxT('clanDescEmpty', 'Описание клана пока не добавлено')}</span>
        ${isLeader ? `<button class="clx-icon-btn" onclick="_clanDescStartEdit()" title="${_clxT('clanDescEditTitle', 'Изменить описание')}">✎</button>` : ''}
      </div>`;

  const members = c.members || [];
  const power = members.reduce((n, m) => n + (m.bm || 0), 0);
  const myBM = typeof calcBM === 'function' && player ? calcBM(player) : 0;
  const sides = (typeof _gwState !== 'undefined' && _gwState && _gwState.sides) || {};
  const held = ['right', 'left'].filter(k => sides[k] && sides[k].clanName === c.name);
  const towers = held.length === 2 ? ['Все четыре', '+300 Liberty в день']
    : held[0] === 'right' ? ['Правые', '+200 Liberty в день'] : held[0] === 'left' ? ['Левые', '+100 Liberty в день'] : ['Нет', 'Война — ср и сб, 22:00'];
  const stat = (icon, col, label, value, note) =>
    `<div class="clx-stat"><div class="clx-stat-k">${_clxIco(icon, 13, col)} ${label}</div><div class="clx-stat-v">${value}</div>${note ? `<div class="clx-stat-n">${note}</div>` : ''}</div>`;

  return `
    ${desc}
    <div class="clx-stats">
      ${stat('party', '#8fd0ff', 'Участники', _clanMemberCount(c))}
      ${stat('swords', '#ff7a6a', 'Сила клана', _num(power), 'сумма БМ')}
      ${stat('shield', '#7ee0b0', _clxT('clanYourBmLbl', 'Ваша БМ'), _num(myBM))}
      ${stat('castle', '#f0c75e', 'Вышки', towers[0], towers[1])}
    </div>
    ${_clanDonateHTML(c)}
    <div class="clx-foot">
      ${isLeader
        ? `<button class="clx-link danger" onclick="_clanConfirmDisband()">${_clxT('clanDisbandBtn', 'Расформировать клан')}</button>`
        : `<button class="clx-link" onclick="_clanConfirmLeave()">${_clxT('clanLeaveBtn', 'Покинуть клан')}</button>`}
    </div>`;
}

// ── Состав ────────────────────────────────────────────────
function _clxToggleMember(tg) { _clxOpenMember = _clxOpenMember === tg ? null : tg; updateClanUI(); }

function _clxMembersTab(c, isLeader) {
  const apps = isLeader && (c.applications || []).length
    ? `<div class="clx-hdr">${_clxT(null, 'Заявки')} <b>${c.applications.length}</b></div>
       <div class="clx-list">${c.applications.map(a => `
        <div class="clx-member">
          <div class="clx-member-main">
            <span class="clx-member-name">${_esc(a.username)}</span>
            <span class="clx-member-meta">БМ ${_num(a.bm)}</span>
          </div>
          <button class="clx-btn sm" onclick="netClanApprove('${a.telegramId}')">${_clxT('clanApproveBtn', 'Принять')}</button>
          <button class="clx-btn sm ghost" onclick="netClanDecline('${a.telegramId}')">✕</button>
        </div>`).join('')}</div>`
    : '';
  const myTg = typeof _myTelegramId === 'function' ? _myTelegramId() : null;
  const rows = (c.members || []).slice().sort((a, b) => (b.role === 'leader') - (a.role === 'leader') || (b.bm || 0) - (a.bm || 0))
    .map(m => {
      const me = String(m.telegramId) === String(myTg);
      const canAct = isLeader && m.role !== 'leader';
      const open = canAct && _clxOpenMember === m.telegramId;
      return `
        <div class="clx-member${me ? ' me' : ''}${canAct ? ' tap' : ''}" ${canAct ? `onclick="_clxToggleMember('${m.telegramId}')"` : ''}>
          <span class="clx-member-cls">${typeof classBadgeHTML === 'function' ? classBadgeHTML(m.charClass, 22) : ''}</span>
          <div class="clx-member-main">
            <span class="clx-member-name">${_esc(m.username)}${m.role === 'leader' ? ` ${_clxIco('crown', 13, '#f0c75e')}` : ''}${me ? ' <em>вы</em>' : ''}</span>
            <span class="clx-member-meta">в клане ${_clxDaysIn(m.joinedAt)}</span>
          </div>
          <span class="clx-member-bm">${_num(m.bm)}<small>БМ</small></span>
          ${canAct ? `<span class="clx-member-more">${open ? '▴' : '⋯'}</span>` : ''}
        </div>
        ${open ? `<div class="clx-member-acts">
          <button class="clx-btn sm" onclick="event.stopPropagation();_clanTransferConfirm('${m.telegramId}')">${_clxIco('crown', 13)} ${_clxT('clanTransferBtn', 'Сделать лидером')}</button>
          <button class="clx-btn sm danger" onclick="event.stopPropagation();_clanKickConfirm('${m.telegramId}')">${_clxT('clanKickBtn', 'Исключить')}</button>
        </div>` : ''}`;
    }).join('');
  return `${apps}
    <div class="clx-hdr">${_clxT(null, 'Участники')} <b>${_clanMemberCount(c)}</b>${isLeader ? '<span class="clx-hdr-note">нажмите на участника для действий</span>' : ''}</div>
    <div class="clx-list">${rows}</div>`;
}

// ── Бонусы: все уровни одной таблицей ─────────────────────
let _clxShowPassed = false;
function _clxTogglePassed() { _clxShowPassed = !_clxShowPassed; updateClanUI(); }
function _clxPerksTab(c) {
  // Сверху — текущий уровень и следующие; пройденные свёрнуты под кнопку:
  // пятнадцать строк подряд читать никто не будет.
  const passed = CLAN_LEVELS.filter(d => d.lvl < c.level).length;
  const shown = CLAN_LEVELS.filter(d => _clxShowPassed || d.lvl >= c.level);
  const rows = shown.map(d => {
    const st = c.level > d.lvl ? 'done' : c.level === d.lvl ? 'cur' : 'next';
    return `<div class="clx-lv ${st}">
      <span class="clx-lv-n">${d.lvl}</span>
      <div class="clx-lv-main">
        <div class="clx-lv-name">${_esc(d.label)}<span>${d.lvl === 1 ? 'старт' : _num(d.xpReq)}</span></div>
        <div class="clx-lv-chips">${_clxBonusChips(d.bonus)}</div>
      </div>
      ${st === 'done' ? `<span class="clx-lv-ok">${_clxIco('checkCircle', 16, '#7ee0b0')}</span>` : st === 'cur' ? '<span class="clx-lv-now">сейчас</span>' : ''}
    </div>`;
  }).join('');
  return `<div class="clx-hdr">${_clxT('clanPerksHdr', 'Бонусы клана по уровням')}<span class="clx-hdr-note">накопительные, действуют на всех участников</span></div>
    <div class="clx-legend">${_CLX_BONUS.map(x => `<span>${_clxIco(x.icon, 12, x.col)} ${_clxT(x.key, x.ru)}</span>`).join('')}</div>
    ${passed ? `<button class="clx-link" onclick="_clxTogglePassed()">${_clxShowPassed ? 'Скрыть пройденные уровни' : `Показать пройденные уровни (${passed})`}</button>` : ''}
    <div class="clx-levels">${rows}</div>`;
}

// ── Гильдийский босс ──────────────────────────────────────
// Состояние — с сервера (guildBossState, handlers2/modes.js). Лидер клана
// 11+ уровня вызывает любого босса Логова от 35-го, усиленного
// (guildBossScaling); участники входят в общий зал. Пока вкладка открыта и
// босс стоит, состояние подтягивается раз в 3 секунды — полоса здоровья живая.
let _gbView = null;
let _gbInside = false;   // этот игрок сейчас в зале босса (guildBossEntered/Out)
let _gbTick = null;
function onGuildBossState(st) {
  _gbView = st || null;
  if (_clanHomeTab === 5 && typeof updateClanUI === 'function') updateClanUI();
}
function _gbFmtLeft(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}
function _gbDropHTML(level) {
  const icon = id => {
    const d = typeof CRAFT_MATS !== 'undefined' ? CRAFT_MATS.find(m => m.id === id) : null;
    return d && typeof _itemIcon === 'function' ? _itemIcon(d, 18) : '';
  };
  const rows = [
    [icon('bless_stone'), 'Безопасные камни заточки', '1–10'],
    [icon('shard_gold'), 'Осколки (случайные виды)', '1–300'],
    [icon('dungeon_scroll_lev'), 'Классовые свитки (случайные)', '3'],
    [icon((CRAFT_MATS.find(m => m.skillKey) || {}).id), 'Книги навыков (случайные)', '1–3'],
    [icon('ore_rare'), 'Синяя руда', '1–100'],
    [icon('ore_uncommon'), 'Зелёная руда', '1–200'],
  ];
  return `<div class="gb-drop">${rows.map(([ic, n, q]) =>
    `<div class="gb-drop-row">${ic}<span>${n}</span><b>${q}</b></div>`).join('')}
    <div class="gb-drop-note">Количество случайное; чем выше уровень босса, тем ближе к максимуму. Весь дроп уходит в хранилище клана — раздаёт лидер.</div></div>`;
}
function _clanBossHTML() {
  const v = _gbView;
  clearInterval(_gbTick); _gbTick = null;
  if (!v) { if (typeof netGuildBossSync === 'function') netGuildBossSync(); return `<div class="clx-empty">${t('clanStorageLoading')}</div>`; }
  if (!v.ready) return `<div class="clx-empty">Гильдийские боссы скоро появятся</div>`;
  if (!v.inClan) return '';
  const skew = (v.now || Date.now()) - Date.now();
  let html = '';
  if (v.active) {
    const a = v.active;
    const pct = a.maxHp ? Math.max(0, Math.min(100, a.hp / a.maxHp * 100)) : 0;
    const left = _gbFmtLeft(a.expiresAt - (Date.now() + skew));
    const row = bossLairBoss(a.level) || {};
    html += `<div class="gb-active" style="--bc:${row.color || '#e5484d'}">
      <div class="lair-ico">${typeof _lairBossIcon === 'function' ? _lairBossIcon(row.eid, 64) : ''}<span class="lair-badge">${a.level}</span></div>
      <div class="gb-active-body">
        <div class="gb-active-name">${_esc(row.key ? t(row.key) : (a.name || ''))}</div>
        <div class="gb-hp"><i style="width:${pct.toFixed(1)}%"></i><span>${_num(a.hp)} / ${_num(a.maxHp)}</span></div>
        <div class="gb-active-meta">⏳ осталось ${left} · в зале: ${a.inside}</div>
      </div>
    </div>
    ${_gbInside
      ? `<button class="clan-btn clan-btn-leave" onclick="netGuildBossLeave()">Выйти из зала</button>`
      : v.deadThisFight
        ? `<div class="clx-note warn">Вы пали в этом бою — войти снова можно в следующий вызов.</div>`
        : `<button class="clan-btn gb-enter" onclick="netGuildBossEnter()">⚔ Войти к боссу</button>`}`;
    _gbTick = setInterval(() => {
      if (_clanHomeTab !== 5 || !document.querySelector('.gb-active')) { clearInterval(_gbTick); _gbTick = null; return; }
      if (typeof netGuildBossSync === 'function') netGuildBossSync();
    }, 3000);
  }
  const fact = (k, val) => `<div class="clx-fact"><span>${k}</span><b>${val}</b></div>`;
  html += `<div class="clx-hdr">Гильдийские боссы<span class="clx-hdr-note">боссы Логова от 35 ур. — вызывает лидер, бьёт весь клан; кто умер — вылетает</span></div>
    <div class="clx-facts">
      ${fact('Вызов', `${_num(v.cost)} Liberty`)}
      ${fact('На неделе', `${v.usedThisWeek} / ${v.perWeek}`)}
      ${fact('Стоит', `${Math.round(v.lifetimeMs / 60000)} мин`)}
      ${fact('Здоровье', '×20')}
      ${fact('Атака, защита', '×3')}
      ${fact('Нужен', `${v.minClanLevel} ур. клана`)}
    </div>`;
  if (v.clanLevel < v.minClanLevel) {
    html += `<div class="clx-note warn">Нужен ${v.minClanLevel} уровень клана (сейчас ${v.clanLevel}).</div>`;
  }
  const canSummon = v.isLeader && !v.active && v.clanLevel >= v.minClanLevel && v.usedThisWeek < v.perWeek;
  html += `<div class="lair-list">${(v.levels || []).map(bl => {
    const row = bossLairBoss(bl) || {};
    const st = monsterStatsAtLevel(bl, 'boss');
    const k = guildBossScaling(bl);
    const btn = v.isLeader
      ? `<button class="lair-go" ${canSummon ? '' : 'disabled'} onclick="_gbSummonAsk(${bl})">Вызвать</button>`
      : '';
    return `<div class="lair-boss" style="--bc:${row.color || '#e5484d'}">
      <div class="lair-ico">${typeof _lairBossIcon === 'function' ? _lairBossIcon(row.eid, 56) : ''}<span class="lair-badge">${bl}</span></div>
      <div class="lair-info">
        <div class="lair-name">${_esc(row.key ? t(row.key) : (row.name || ''))}<span class="lair-lvl">ур. ${bl}</span></div>
        <div class="lair-stats">
          <span>❤ <b>${typeof _lairFmt === 'function' ? _lairFmt(st.hp * k.hpMult) : Math.round(st.hp * k.hpMult)}</b></span>
          <span>⚔ <b>${typeof _lairFmt === 'function' ? _lairFmt(st.atk * k.atkMult) : Math.round(st.atk * k.atkMult)}</b></span>
          <span>🛡 <b>${typeof _lairFmt === 'function' ? _lairFmt(st.def * k.defMult) : Math.round(st.def * k.defMult)}</b></span>
        </div>
      </div>
      <div class="lair-act">${btn}</div>
    </div>`;
  }).join('')}</div>
  <div class="clx-hdr">Дроп с босса</div>
  ${_gbDropHTML()}`;
  return html;
}
function _gbSummonAsk(level) {
  const row = bossLairBoss(level) || {};
  const name = row.key ? t(row.key) : (row.name || '');
  const cost = (_gbView && _gbView.cost) || 500;
  _showConfirmModal(`Вызвать «${name}» (${level} ур.) за ${cost} Liberty? Босс будет стоять час.`,
    () => netGuildBossSummon(level), 'Вызвать');
}
// Итог: что упало в хранилище клана (сервер прислал после записи).
// Осколки — одной строкой суммой.
function showGuildBossResult(level, drop) {
  document.getElementById('gb-win-ov')?.remove();
  const all = Array.isArray(drop) ? drop : [];
  const shards = all.filter(it => it.id && it.id.startsWith('shard_')).reduce((n, it) => n + (it.qty || 0), 0);
  const rest = all.filter(it => !(it.id && it.id.startsWith('shard_')));
  const row = (img, name, qty) => `<div class="db-reward-row">${img ? `<img src="${img}" alt="">` : '<span class="db-reward-fallback">🎁</span>'}<span>${name}</span><span class="db-reward-qty">×${qty}</span></div>`;
  const def = id => (typeof CRAFT_MATS !== 'undefined' && CRAFT_MATS.find(m => m.id === id)) || {};
  const rows = rest.map(it => row(def(it.id).img || it.img, def(it.id).name || it.name || it.id, it.qty || 1));
  if (shards) rows.splice(1, 0, row('/images/uniq/shard/gold.png', 'Осколки', shards));
  const b = bossLairBoss(level) || {};
  const ov = document.createElement('div');
  ov.id = 'gb-win-ov'; ov.className = 'ach-win-ov';
  ov.onclick = () => ov.remove();
  ov.innerHTML = `<div class="db-win-panel ach-win" onclick="event.stopPropagation()">
    <div class="ach-win-rays"></div>
    <div class="db-win-title">Босс повержен!</div>
    <div class="db-win-sub">${_esc(b.key ? t(b.key) : (b.name || ''))} · ${level} ур.</div>
    ${all.length
      ? `<div class="db-win-sub">Дроп отправлен в хранилище клана — раздаёт лидер.</div><div class="gb-win-list">${rows.join('')}</div>`
      : `<div class="db-win-sub">Не удалось записать дроп — сообщите администрации.</div>`}
    <button class="db-win-btn" onclick="document.getElementById('gb-win-ov')?.remove()">Отлично</button>
  </div>`;
  document.body.appendChild(ov);
}

// ── Пожертвования ─────────────────────────────────────────
// Единственный источник опыта клана. Сколько уже сделано сегодня и сколько
// ждать новичку — с сервера (clanData.donations, repos/clans.js); здесь только
// рисуется и проверяется то, что видно глазами: хватает ли осколков и Liberty.
function _clanShardMin() {
  if (typeof UNIQUE_SHARDS === 'undefined' || !player) return 0;
  return Math.min(...UNIQUE_SHARDS.map(sh =>
    (player.inventory || []).reduce((n, it) => n + (it && it.id === sh.id ? (it.qty || 1) : 0), 0)));
}
function _clanDonateHTML(c) {
  const d = c.donations;
  if (typeof CLAN_DONATIONS === 'undefined') return '';
  const total = CLAN_DONATION_KINDS.reduce((n, k) => n + CLAN_DONATIONS[k].perDay, 0);
  const hdr = `<div class="clx-hdr">${t('clanDonateHdr')}<span class="clx-hdr-note">${tVars('clanDonateNote', { n: total })}</span></div>`;
  if (!d || !d.ready) return `${hdr}<div class="clx-empty">${t('clanDonateSoon')}</div>`;
  const wait = d.waitHours > 0
    ? `<div class="clx-note warn">${_clxIco('hourglass', 14)} ${tVars('clanDonateWaitFmt', { h: d.minHours, left: d.waitHours })}</div>` : '';
  const shardMin = _clanShardMin();
  const nexum = Number(window._nexumBalance) || 0;
  const card = (kind) => {
    const def = CLAN_DONATIONS[kind];
    const used = (d.used && d.used[kind]) || 0;
    const left = def.perDay - used;
    const enough = kind === 'normal' ? shardMin >= def.shards : nexum >= def.liberty;
    const ok = left > 0 && !(d.waitHours > 0) && enough;
    const cost = kind === 'normal'
      ? `<img src="/images/uniq/shard/gold.png" alt="">${def.shards} × 20 видов`
      : `<img src="/images/nexum-coin_v2.png" alt="">${def.liberty} Liberty`;
    return `<button class="clx-don ${kind}" ${ok ? '' : 'disabled'} onclick="_clanDonate('${kind}')">
      <span class="clx-don-top"><b>${t(kind === 'normal' ? 'clanDonateNormal' : 'clanDonateBig')}</b><span class="clx-don-pts">+${def.xp}</span></span>
      <span class="clx-don-cost">${cost}</span>
      <span class="clx-don-dots">${Array.from({ length: def.perDay }, (_, i) => `<i class="${i < used ? 'on' : ''}"></i>`).join('')}
        <em>${left > 0 ? (enough ? 'пожертвовать' : 'не хватает') : 'на сегодня всё'}</em></span>
    </button>`;
  };
  return `${hdr}${wait}<div class="clx-don-row">${CLAN_DONATION_KINDS.map(card).join('')}</div>`;
}
let _clanDonating = false;
function _clanDonate(kind) {
  if (_clanDonating || typeof CLAN_DONATIONS === 'undefined' || !CLAN_DONATIONS[kind]) return;
  const def = CLAN_DONATIONS[kind];
  const what = kind === 'normal' ? tVars('clanDonateShardsFmt', { n: def.shards }) : `${def.liberty} Liberty`;
  _showConfirmModal(tVars('clanDonateAsk', { what }), () => {
    _clanDonating = true;
    setTimeout(() => { _clanDonating = false; }, 1500);
    netClanDonate(kind);
  }, t('clanDonateBtn'));
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
    return `<div class="clx-empty">${_clxT('clanStorageLoading', 'Загрузка...')}</div>`;
  }
  // Казна Liberty — сверху и всегда, даже у закрытого хранилища: сюда
  // приходит награда Войны гильдий, и клан должен её видеть.
  const treasury = _clanTreasuryHTML(s);

  if (!s.unlocked) {
    const cost = s.unlockCost || 0;
    const gold = (player && player.gold) || 0;
    const afford = gold >= cost;
    return `${treasury}
      <div class="clx-hdr">Хранилище клана</div>
      <div class="clx-card clx-locked">
        ${_clxIco('lock', 22, '#8ea4b8')}
        <div>${tVars('clanStorageLockedFmt', { n: _num(cost) })}</div>
        ${s.isLeader
          ? `<button class="clx-btn${afford ? '' : ' off'}" ${afford ? '' : 'disabled'} onclick="_clanStorageUnlockConfirm()">${tVars('clanStorageUnlockBtn', { n: _num(cost) })}</button>
             <small>${t('clanStorageYourGold')}: <b style="color:${afford ? '#8fbf7a' : '#eb4e61'}">${_num(gold)}</b></small>`
          : `<small>${t('clanStorageLockedMember')}</small>`}
      </div>`;
  }

  const gate = s.canUse ? '' : `<div class="clx-note warn">${_clxIco('hourglass', 14)} ${tVars('clanStorageGateFmt', { d: s.minDays, cur: s.daysIn == null ? 0 : s.daysIn })}</div>`;
  const canGive = s.isLeader && s.canUse;
  const tiles = (s.storage || []).length
    ? `<div class="clx-items">${s.storage.map(e => `
        <button class="clx-item${canGive ? '' : ' ro'}" ${canGive ? `onclick="_clanStorageGivePrompt('${_esc(e.id)}','${_esc(e.name)}',${e.qty})"` : ''} title="${_esc(e.name)}">
          ${e.img ? `<img src="${_esc(e.img)}" alt="">` : _clxIco('chest', 22)}
          <b>${_num(e.qty)}</b>
          <span>${_esc(e.name)}</span>
        </button>`).join('')}</div>
       ${canGive ? '<div class="clx-hint">Нажмите на предмет, чтобы выдать участнику</div>' : ''}`
    : `<div class="clx-empty">${t('clanStorageEmpty')}</div>`;

  const mine = (s.allocations || []).filter(a => !s.isLeader || a.telegramId === _myTelegramId());
  const allocs = (s.allocations || []).length
    ? `<div class="clx-list">${s.allocations.map(a => `
        <div class="clx-alloc">
          ${a.img ? `<img src="${_esc(a.img)}" alt="">` : ''}
          <span class="clx-alloc-name">${_esc(a.name)}${s.isLeader ? `<small>→ ${_esc(a.username || '')}</small>` : ''}</span>
          <b>×${_num(a.qty)}</b>
          ${s.isLeader ? `<button class="clx-icon-btn" title="${t('clanStorageCancelBtn')}" onclick="_clanStorageCancel('${_esc(a.telegramId)}','${_esc(a.id)}')">✕</button>` : ''}
        </div>`).join('')}</div>`
    : `<div class="clx-empty">${t('clanStorageNoAlloc')}</div>`;
  const claim = (mine.length && s.canUse)
    ? `<button class="clx-btn wide" onclick="netClanStorageClaim()">${t('clanStorageClaimBtn')}</button>` : '';

  return `${treasury}${gate}
    <div class="clx-hdr">Хранилище клана<span class="clx-hdr-note">дроп боссов и осколки — раздаёт лидер</span></div>
    ${tiles}
    <div class="clx-hdr">${s.isLeader ? t('clanStorageAllocHdrLeader') : t('clanStorageAllocHdr')}</div>
    ${allocs}${claim}`;
}

// ── Казна клана (Liberty) ─────────────────────────────────────────────────
// Приходит с Войны гильдий: обе правые вышки — 200 в сутки, обе левые — 100.
// Раздаёт лидер, сразу на баланс участника (clanTreasuryGive).
const _CLAN_NX_REASON = {
  guild_war_right: 'Война гильдий · правые вышки',
  guild_war_left: 'Война гильдий · левые вышки',
};
function _clanTreasuryHTML(s) {
  const tr = s && s.treasury;
  if (!tr) return '';
  const n = tr.nexum || 0;
  const log = (tr.log || []).slice(0, 5).map(l => {
    const plus = l.delta > 0;
    const what = plus ? (_CLAN_NX_REASON[l.reason] || l.reason) : `выдано · ${_esc(l.username || '—')}`;
    const when = l.at ? new Date(l.at).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) : '';
    return `<div class="clx-tr-row"><span>${what}</span><small>${when}</small><b class="${plus ? 'in' : 'out'}">${plus ? '+' : '−'}${_num(Math.abs(l.delta))}</b></div>`;
  }).join('');
  return `
    <div class="clx-treasury">
      <div class="clx-treasury-top">
        <img src="/images/nexum-coin_v2.png" alt="">
        <div class="clx-treasury-main">
          <div class="clx-treasury-k">Казна клана</div>
          <div class="clx-treasury-v">${_num(n)} <small>Liberty</small></div>
        </div>
        ${s.isLeader && n > 0 ? `<button class="clx-btn" onclick="_clanTreasuryGivePrompt()">Выдать</button>` : ''}
      </div>
      ${log ? `<div class="clx-tr-log">${log}</div>` : '<div class="clx-tr-empty">Сюда приходит Liberty с Войны гильдий</div>'}
    </div>`;
}

function _clanTreasuryGivePrompt() {
  const s = _clanStorage;
  const max = (s && s.treasury && s.treasury.nexum) || 0;
  if (!s || !s.members || !s.members.length) {
    _marketToast(t('clanStorageNoEligible'), 'err');
    return;
  }
  const list = s.members.map((m, i) => `${i + 1}. ${m.username}`).join('\n');
  const pick = prompt(`Кому выдать Liberty из казны?\n${list}`, '1');
  if (pick == null) return;
  const target = s.members[Math.floor(Number(pick)) - 1];
  if (!target) { _marketToast(t('clanStorageBadPick'), 'err'); return; }
  const raw = prompt(`Сколько Liberty выдать игроку ${target.username}? (в казне ${max})`, String(max));
  if (raw == null) return;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return;
  if (n > max) { _marketToast(tVars('clanStorageTooMany', { max }), 'err'); return; }
  netClanTreasuryGive(target.telegramId, n);
}

// ── Активность клана ──────────────────────────────────────
// Who has put how many Shards into the clan storage, ever — a leaderboard,
// not a log. The list itself (_clanActivity) is server state pushed on open
// and after every deposit; this only draws it.
function _clanActivityHTML() {
  const rows = _clanActivity;
  if (rows === null) {
    if (typeof netClanActivitySync === 'function') netClanActivitySync();
    return `<div class="clx-empty">${_clxT('clanStorageLoading', 'Загрузка...')}</div>`;
  }
  const hdr = `<div class="clx-hdr">${_clxT('clanActivityHdr', 'Вклад участников')}<span class="clx-hdr-note">очки клану: пожертвования, турнир, Владыка</span></div>`;
  if (!rows.length) return `${hdr}<div class="clx-empty">${_clxT('clanActivityEmpty', 'Пока никто ничего не пожертвовал')}</div>`;
  const myTg = _myTelegramId();
  // Всего принёс клану — пожертвования, победы в турнире и добитые Владыки;
  // турнир и Владыка — отдельными строками и своими кусками полосы.
  const total = r => (r.points || 0) + (r.tour || 0) + (r.boss || 0);
  const top = Math.max(1, ...rows.map(total));
  const medal = ['#f0c75e', '#c8d3de', '#d08a5a'];
  return `${hdr}<div class="clx-list">${rows.map((r, i) => `
    <div class="clx-rank${String(r.telegramId) === String(myTg) ? ' me' : ''}">
      <span class="clx-rank-n" ${i < 3 ? `style="--mc:${medal[i]}"` : ''}>${i + 1}</span>
      <div class="clx-rank-main">
        <span class="clx-rank-name">${_esc(r.username)}${r.inClan ? '' : ` <small>(${_clxT('clanActivityLeftClan', 'покинул клан')})</small>`}</span>
        <span class="clx-rank-bar"><i style="width:${Math.round((r.points || 0) / top * 100)}%"></i><i class="tour" style="width:${Math.round((r.tour || 0) / top * 100)}%"></i><i class="boss" style="width:${Math.round((r.boss || 0) / top * 100)}%"></i></span>
        ${r.tour ? `<span class="clx-rank-tour">${iconHTML('trophy', 11, '#f0c75e')} с турнира +${_num(r.tour)} · ${_num(r.tourWins || 0)} ${_clxWinsWord(r.tourWins || 0)}</span>` : ''}
        ${r.boss ? `<span class="clx-rank-tour boss">${iconHTML('skull', 11, '#d08cff')} Владыка Мира +${_num(r.boss)} · добит ×${_num(r.bossKills || 0)}</span>` : ''}
      </div>
      <span class="clx-rank-v">${_num(total(r))}${r.qty ? `<small>${_num(r.qty)} оск.</small>` : ''}</span>
    </div>`).join('')}</div>`;
}

function _clxWinsWord(n) {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return 'победа';
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return 'победы';
  return 'побед';
}

// Server pushed new activity state — redraw only when that tab is showing.
function onClanActivity() {
  if (_clanHomeTab === 4) updateClanUI();
}

// telegramId only — never the username — travels through the onclick
// attribute; the name for the confirm text is read back out of clanData
// (already-parsed JS memory, not re-parsed HTML/JS) so a display name
// containing quotes can't break out of the inline handler.
function _clanTransferConfirm(telegramId) {
  const member = clanData && (clanData.members || []).find(x => String(x.telegramId) === String(telegramId));
  const name = member ? member.username : '';
  const msg = typeof tVars === 'function'
    ? tVars('clanTransferAsk', { name })
    : `Сделать «${name}» лидером клана? Вы станете обычным участником.`;
  if (confirm(msg)) netClanTransferLeader(telegramId);
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

// ── Исключение из клана — через модалку, не через window.confirm ───────────
// Раньше кнопка «Исключить» била netClanKick сразу по клику — единственная
// destructive-кнопка в этом файле без ЛЮБОГО подтверждения (leave/disband/
// transfer все спрашивают, пусть даже через нативный confirm()). Один
// случайный тап по списку участников — и человека выкинули из клана
// безвозвратно.
//
// Просили именно модальное окно, а не confirm(): та же карточка, что
// использует остальной интерфейс (imod-overlay/imod-box), а не системный
// диалог браузера, который в Telegram Mini App выглядит чужеродно и на
// части WebView-обёрток вовсе не показывается поверх мини-приложения.
//
// telegramId, не username, идёт через onclick — та же причина, что у
// _clanTransferConfirm выше: имя достаётся из clanData (уже распарсенной
// памяти), а не повторно парсится из HTML/JS, так что имя с кавычками не
// сломает инлайн-обработчик. Экранируется здесь же, при подстановке в текст
// модалки — это HTML, не JS-атрибут, но то же самое имя.
function _clanKickConfirm(telegramId) {
  const member = clanData && (clanData.members || []).find(x => String(x.telegramId) === String(telegramId));
  const name = _esc(member ? member.username : '');
  const msg = typeof tVars === 'function' ? tVars('clanKickAsk', { name }) : `Исключить «${name}» из клана?`;
  _showConfirmModal(msg, () => netClanKick(telegramId), typeof t === 'function' ? t('clanKickBtn') : 'Исключить');
}

// Generic yes/no modal — one caller today (_clanKickConfirm above), written
// to take any message/callback rather than hardcoding "kick" so the NEXT
// destructive one-tap button doesn't have to reinvent this.
//
// The callback is held on a plain module-level variable rather than
// serialized into the confirm button's onclick: a closure re-stringified
// into an HTML attribute and re-eval'd loses every variable it closed over
// (telegramId here), throwing a ReferenceError the moment it's tapped.
let _confirmModalAction = null;
function _showConfirmModal(text, onConfirm, confirmLbl) {
  const existing = document.getElementById('confirm-modal-ov');
  if (existing) existing.remove();
  _confirmModalAction = onConfirm;
  const ov = document.createElement('div');
  ov.id = 'confirm-modal-ov';
  ov.className = 'imod-overlay';
  ov.onclick = closeConfirmModal;
  ov.innerHTML = `<div class="imod-box" onclick="event.stopPropagation()" style="max-width:300px">
    <div class="imod-stats" style="text-align:center">${text}</div>
    <div class="imod-btns">
      <button class="imod-btn imod-equip" onclick="closeConfirmModal()">${typeof t === 'function' ? t('cancelBtn') : 'Отмена'}</button>
      <button class="imod-btn imod-sell" onclick="_confirmModalRun()">${confirmLbl}</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
}
function closeConfirmModal() {
  const el = document.getElementById('confirm-modal-ov');
  if (el) el.remove();
  _confirmModalAction = null;
}
function _confirmModalRun() {
  const fn = _confirmModalAction;
  closeConfirmModal();
  if (fn) fn();
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
  // ── отказ должен попасться на глаза ──────────────────────────────────────
  // Заявки рисуются ПОСЛЕ списка участников, поэтому у полного клана (30
  // строк) лидер, нажимая «Принять», прокручен вниз. Сообщение вставлялось на
  // самый верх — за пределами экрана — и стиралось через три секунды. Отказ
  // был, следа для человека не было: девять нажатий подряд в журнале.
  //
  // Сначала общий тост, если он есть: он всплывает поверх экрана и не зависит
  // от того, куда прокручена панель.
  if (typeof _marketToast === 'function') { _marketToast(msg, 'err'); return; }
  const body = document.getElementById('clan-body');
  if (body) {
    const d = document.createElement('div');
    d.className = 'clan-err';
    d.textContent = msg;
    body.prepend(d);
    // И если тоста нет — хотя бы подвести к нему экран, а не оставлять
    // сообщение там, куда человек не смотрит.
    if (d.scrollIntoView) d.scrollIntoView({ block: 'nearest' });
    setTimeout(() => d.remove(), 5000);
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
