'use strict';
// ── Skills, quests, season, VIP, rebirth ────────────────────────────────────
// Everything a player accumulates that is not an item or a balance. The shape
// is the same as everywhere else in handlers2: the client asks, the server
// decides, the answer is pushed back from the database.
//
// One thing recurs here more than anywhere: a REQUEST is not a RESULT. The old
// handlers took the outcome from the client in several places — which skill
// level was reached, which quest was complete, which VIP tier was earned — and
// checked it afterwards. Here the client sends "I want to study Q" and the
// server counts the books, rolls the chance and applies the level. There is no
// outcome to send.

const players = require('../db/repos/players');
const progression = require('../db/repos/progression');
const items = require('../db/repos/items');
const shopRepo = require('../db/repos/shop');
const consumables = require('../db/repos/consumables');
const stats = require('../db/repos/stats');
const {
  SKILL_MAX_LEVEL, PASSIVE_MAX_LEVEL, REBIRTH_LEVEL, REBIRTH_BONUS_SP,
  rebirthCostFor, UPGRADE_RESET_COST, SKILL_UPGRADE_CHANCE,
  SKILL_STUDY_COST, SKILL_UPGRADE_COST, ADV_SKILL_STUDY_COST,
  skillBookId, advSkillBookId, passiveBookId, _vipLevelItems,
} = require('../../shared/definitions');
const shop = require('../shop');

const SLOTS = new Set(['Q', 'W', 'E', 'R']);
// ── why the guards below fail instead of returning ──────────────────────────
// act() writes the success row when the handler does not throw, so every bare
// `return;` in this file recorded a skill studied, a quest claimed, a package
// bought — none of which happened. Books and GRAM are the two things players
// ask about most often, and the log answered both with a row that says the
// transaction went through.
const fail = (msg, code) => { throw Object.assign(new Error(msg), { userMessage: msg, code }); };

module.exports = function registerProgression(s, safeOn) {
  const pushAfterStat = async (t) => { await s.pushProgress(t); await s.pushStats(t); };

  // ── studying ─────────────────────────────────────────────────────────────
  // The book is consumed and the level applied in ONE transaction. The old
  // version's "my passive rolled back" reports came from these being two
  // steps: the book was spent, the level was written into a client-owned map,
  // and a save arriving from a stale client wrote the old map back over it.
  // ── the price is in shared/definitions.js, and both sides must read it ───
  // The client greys the button out until you hold SKILL_STUDY_COST (1),
  // SKILL_UPGRADE_COST (2) or ADV_SKILL_STUDY_COST (5) copies of the book, and
  // then shows the count going down by that many. Every handler here charged
  // exactly one, so an advanced skill cost five books on screen and one in the
  // database — the panel and the bag disagreed from the moment of the click,
  // which is what "я активировал, а книги на месте / навыка нет" describes
  // from either side of the discrepancy.
  async function study(t, pid, kind, key, bookId, max, cost = SKILL_STUDY_COST) {
    const current = (await players.skillsOf(t, pid));
    const map = kind === 'passive' ? current.passiveLevels : current.skillLevels;
    if ((map[key] || 0) >= max) fail('Уже максимальный уровень', 'maxed');

    await items.lockPlayer(t, pid);
    if (!await items.removeQty(t, pid, bookId, cost)) {
      fail(`Нужно книг: ${cost}`, 'no_book');
    }

    const res = await players.bumpSkill(t, pid, kind, key);
    if (!res.changed) fail('Уже максимальный уровень', 'maxed');
    return res;
  }

  safeOn('learnSkill', ({ key } = {}) => s.act('learnSkill', 'progressError', async (t, pid) => {
    if (!SLOTS.has(key)) fail('Неизвестный навык', 'bad_slot');
    const prog = await players.progressOf(t, pid);
    if (!prog.charClass) fail('Сначала выберите класс', 'no_class');
    await study(t, pid, 'skill', key, skillBookId(prog.charClass, key), SKILL_MAX_LEVEL);
    await s.pushItems(t); await pushAfterStat(t);
  }));

  // Upgrading rolls a chance. The roll is the server's — the old client sent
  // whether it succeeded.
  safeOn('upgradeSkill', ({ key } = {}) => s.act('upgradeSkill', 'progressError', async (t, pid) => {
    if (!SLOTS.has(key)) fail('Неизвестный навык', 'bad_slot');
    const prog = await players.progressOf(t, pid);
    if (!prog.charClass) fail('Сначала выберите класс', 'no_class');

    await items.lockPlayer(t, pid);
    const bookId = skillBookId(prog.charClass, key);
    if (!await items.removeQty(t, pid, bookId, SKILL_UPGRADE_COST)) {
      fail(`Нужно книг: ${SKILL_UPGRADE_COST}`, 'no_book');
    }

    // crypto, not Math.random: this decides whether a book is consumed for
    // nothing, and a book is a tradeable item.
    const chance = typeof SKILL_UPGRADE_CHANCE === 'number' ? SKILL_UPGRADE_CHANCE : 0.5;
    const success = require('crypto').randomInt(1e6) / 1e6 < chance;

    let level = null;
    if (success) {
      const r = await players.bumpSkill(t, pid, 'skill', key);
      level = r.level;
    }
    await s.pushItems(t); await pushAfterStat(t);
    // The book is spent either way — that is the cost of the attempt, and
    // saying so explicitly is what stops "it ate my book" being a bug report.
    s.socket.emit('upgradeRolled', { kind: key, ok: success, level });
  }));

  safeOn('learnPassive', ({ id } = {}) => s.act('learnPassive', 'progressError', async (t, pid) => {
    if (typeof id !== 'string' || !id) fail('Не выбран пассивный навык', 'bad_passive');
    await study(t, pid, 'passive', id, passiveBookId(id), PASSIVE_MAX_LEVEL);
    await s.pushItems(t); await pushAfterStat(t);
  }));

  // Studying a passive costs one book; raising it costs two — the same split
  // the client applies (studyPassiveSkill / upgradePassiveSkillWithBook,
  // js/ui.js). These two handlers shared one body and one price.
  safeOn('upgradePassive', ({ id } = {}) => s.act('upgradePassive', 'progressError', async (t, pid) => {
    if (typeof id !== 'string' || !id) fail('Не выбран пассивный навык', 'bad_passive');
    await study(t, pid, 'passive', id, passiveBookId(id), PASSIVE_MAX_LEVEL,
      SKILL_UPGRADE_COST);
    await s.pushItems(t); await pushAfterStat(t);
  }));

  safeOn('learnAdvSkill', ({ key } = {}) => s.act('learnAdvSkill', 'progressError', async (t, pid) => {
    if (!SLOTS.has(key)) fail('Неизвестный навык', 'bad_slot');
    const prog = await players.progressOf(t, pid);
    if (!prog.charClass) fail('Сначала выберите класс', 'no_class');
    await items.lockPlayer(t, pid);
    if (!await items.removeQty(t, pid, advSkillBookId(prog.charClass, key), ADV_SKILL_STUDY_COST)) {
      fail(`Нужно книг продвинутого навыка: ${ADV_SKILL_STUDY_COST}`, 'no_book');
    }
    await players.setSkillLevel(t, pid, 'adv_learned', key, 1);
    await s.pushItems(t); await pushAfterStat(t);
  }));

  // Which variant is active decides which damage multiplier the server applies
  // in combat, so it is stored rather than trusted per-cast.
  safeOn('toggleAdvSkill', ({ key } = {}) => s.act('toggleAdvSkill', 'progressError', async (t, pid) => {
    if (!SLOTS.has(key)) return;
    const cur = await players.skillsOf(t, pid);
    if (!cur.advSkillLearned[key]) fail('Продвинутый навык не изучен', 'not_learned');
    await players.setSkillLevel(t, pid, 'adv_active', key, cur.advSkillActive[key] ? 0 : 1);
    await pushAfterStat(t);
  }));

  // ── quests ───────────────────────────────────────────────────────────────
  // The counters are server-written from events the server already sees. The
  // client used to hold them, so it could report the whole 60-quest chain
  // complete in one packet.
  safeOn('claimQuest', ({ idx } = {}) => s.act('claimQuest', 'questClaimError', async (t, pid) => {
    const i = Math.floor(Number(idx));
    if (!Number.isSafeInteger(i) || i < 0) fail('Задание не найдено', 'bad_quest');
    // Same rule as every other item-granting transaction in this file (see
    // :52, :77, :119, :252) — this one was the exception, and the reward loop
    // below inserts.
    await items.lockPlayer(t, pid);
    const res = await progression.claimQuest(t, pid, i);

    const r = res.reward || {};
    if (r.gold > 0) {
      await require('../db/repos/money').credit(t, pid, 'gold', r.gold,
        { reason: 'quest', refType: 'quest', refId: String(i), idemKey: `quest:${pid}:${i}:gold` });
    }
    if (r.xp > 0) await players.grantXp(t, pid, r.xp);
    for (const itemId of (r.items || [])) {
      if (await items.hasRoomFor(t, pid, itemId)) {
        await items.add(t, pid, itemId, { source: 'quest', sourceRef: 'q' + i });
      }
    }
    await s.pushItems(t); await s.pushBalances(t); await pushAfterStat(t);
    s.socket.emit('questClaimed', { idx: i, nextIdx: res.nextIdx, reward: r });
  }));

  // ── special quests ───────────────────────────────────────────────────────
  // The failure here needs its own event, not the shared error toast: the
  // client DISABLES the quest button on click and only ever re-enables it from
  // 'specialQuestError', keyed by questId. A generic toast leaves the button
  // dead for the rest of the session.
  safeOn('completeSpecialQuest', ({ questId } = {}) =>
    s.act('completeSpecialQuest', 'questClaimError', async (t, pid) => {
      const id = Math.floor(Number(questId));
      if (!Number.isSafeInteger(id) || id <= 0) {
        // The button-specific event first, because that is what re-enables it,
        // and THEN a throw — returning here left act() believing the quest had
        // been completed and paid, which is the one thing that must not be in
        // the log for a reward that was never granted. Same order as the catch
        // at the bottom of this handler.
        s.socket.emit('specialQuestError', { questId: String(questId || ''), reason: 'not_found' });
        fail('Задание не найдено', 'not_found');
      }
      try {
        // The account lock first, as claimQuest above already does. grantXp
        // now rewrites players.bm on a level-up, so this transaction ends by
        // touching the players row after player_progress — the reverse of the
        // order the kill path takes them in, and a lock cycle is the one thing
        // lockPlayer's "FIRST statement" rule exists to rule out.
        await items.lockPlayer(t, pid);
        const res = await progression.claimSpecialQuest(t, pid, id);
        if (res.xp > 0) await players.grantXp(t, pid, res.xp);
        await s.pushBalances(t); await pushAfterStat(t);
        // `reward` is the shape onSpecialQuestDone reads (js/quests.js): it
        // adds reward.nexum to the displayed Liberty balance. Spreading the
        // repo's flat {gold, xp, nexum} left it undefined.
        s.socket.emit('specialQuestDone', {
          questId: id, reward: { gold: res.gold, xp: res.xp, nexum: res.nexum },
          alreadyDone: false, ...res,
        });
      } catch (err) {
        s.socket.emit('specialQuestError', { questId: String(id), reason: err.code || 'server_error' });
        throw err;   // act() still reports it and rolls the transaction back
      }
    }));

  // ── VIP ──────────────────────────────────────────────────────────────────
  // The tiers are cleared and the items granted in one statement + one
  // transaction. The old version read the pending array, awaited, then cleared
  // it, and the gap between handed out the whole set twice.
  safeOn('claimVipRewards', () => s.act('claimVipRewards', 'gramShopError', async (t, pid) => {
    const prog = await players.progressOf(t, pid);
    const cls = prog.charClass || 'lev';
    const res = await progression.claimVip(t, pid, tier => shop._vipLevelItems(tier, cls));
    // Nothing pending is a refusal, not a claim. Logged as one, so a second
    // press of a stale button cannot be mistaken later for a second payout.
    if (!res.tiers.length) fail('Нечего получать — все награды VIP уже забраны', 'nothing_pending');

    // Gold rides along with the tiers, keyed so a retry cannot pay twice.
    let gold = 0;
    for (const tier of res.tiers) gold += shop._vipGoldReward(tier) || 0;
    if (gold > 0) {
      await require('../db/repos/money').credit(t, pid, 'gold', gold, {
        reason: 'vip_claim', refType: 'vip', refId: res.tiers.join(','),
        idemKey: `vip_claim:${pid}:${res.tiers.join('-')}`,
      });
    }
    await s.refreshVip(t);
    await s.pushItems(t); await s.pushBalances(t); await pushAfterStat(t);
    const inv = await require('../db/repos/items').inventoryOf(t, pid);
    s.socket.emit('vipRewardsClaimed', {
      newInventory: inv.inventory, goldAdded: gold, vipPending: [],
    });
  }));

  safeOn('vipSync', () => s.act('vipSync', 'gramShopError', async (t, pid) => {
    const v = await progression.vipOf(t, pid);
    s.socket.emit('vipUpdate', { level: v.level, deposited: v.deposited, pending: v.pending });
  }));

  // ── season ───────────────────────────────────────────────────────────────
  // Indexed by (season, points DESC) WHERE points > 0, so this is an index
  // scan. The Mongo version sorted the whole collection in memory on every
  // call — from a handler any client may fire.
  safeOn('seasonRating', () => s.act('seasonRating', 'seasonError', async (t, pid) => {
    const board = await progression.seasonBoard(t, { limit: 50 });
    const mine = await progression.seasonOf(t, pid);
    s.socket.emit('seasonRatingData', { board, me: mine });
  }));


  // ── season ───────────────────────────────────────────────────────────────
  // Burning destroys gear for points — no gold back, no materials. The old
  // handler could not make the destruction and the award one write, so it
  // chose the lesser of two bad outcomes and documented the choice: award
  // first, because points for a burn that did not happen can be redone, while
  // a burn with no points cannot. Inside a transaction there is no choice.
  safeOn('seasonSync', () => s.act('seasonSync', 'seasonError', async (t, pid) => {
    s.socket.emit('seasonState', await progression.seasonState(t, pid));
  }));

  async function afterBurn(t, pid, res) {
    await s.pushItems(t);
    await s.pushStats(t);
    s.socket.emit('seasonBurned', { burned: res.burned, points: res.points, total: res.total });
    s.socket.emit('seasonState', await progression.seasonState(t, pid));
  }

  // By identity, resolved against the DATABASE's list. The old version took an
  // index into the array the client itself had last written and spliced it —
  // and burning is irreversible, so addressing the wrong slot destroys the
  // wrong item. It carried a 'season_burn_desync' log line for exactly that.
  safeOn('seasonBurn', ({ idx, id, enhance } = {}) => s.act('seasonBurn', 'seasonBurnError', async (t, pid) => {
    await items.lockPlayer(t, pid);
    const row = await items.resolveRow(t, pid, { idx, id, enhance }, 'inventory');
    if (!row) fail('Предмет не найден — список обновлён', 'not_found');
    await afterBurn(t, pid, await progression.burnItem(t, pid, row));
  }));

  safeOn('seasonBurnAll', ({ rarity } = {}) => s.act('seasonBurnAll', 'seasonBurnError', async (t, pid) => {
    if (typeof rarity !== 'string' || !rarity) fail('Не выбрана редкость', 'bad_rarity');
    await afterBurn(t, pid, await progression.burnAllOfRarity(t, pid, rarity));
  }));

  safeOn('seasonBurnBook', ({ id, qty } = {}) => s.act('seasonBurnBook', 'seasonBurnError', async (t, pid) => {
    if (typeof id !== 'string' || !id) fail('Не выбрана книга', 'bad_book');
    await afterBurn(t, pid, await progression.burnBooks(t, pid, id, qty));
  }));

  // ── the GRAM shop ────────────────────────────────────────────────────────
  safeOn('gramShopBuy', ({ pkgId, petId } = {}) => s.act('gramShopBuy', 'gramShopError', async (t, pid) => {
    if (typeof pkgId !== 'string' || !pkgId) fail('Набор не выбран', 'bad_package');
    const res = await shopRepo.buyPackage(t, pid, pkgId, petId);
    await s.refreshVip(t);       // the package may have moved a VIP tier or bought the ticket
    await s.pushItems(t); await s.pushBalances(t); await s.pushProgress(t); await s.pushStats(t);
    s.socket.emit('gramShopResult', {
      pkgId: res.pkgId, price: res.price, gold: res.gold, nexum: res.nexum,
      bonusSP: res.bonusSP, seasonTicket: res.seasonTicket,
      items: res.granted.map(g => ({ id: g.itemId, qty: g.qty, enhance: g.enhance })),
      newBalance: res.gramLeft, delivered: true,
    });
    if (res.vip) {
      s.socket.emit('vipUpdate', {
        level: res.vip.level, deposited: res.vip.deposited, pending: res.vip.pending,
      });
    }
    if (res.seasonPoints > 0) {
      const st = await progression.seasonOf(t, pid);
      s.socket.emit('seasonEventDone', { task: 'shop_buy', points: res.seasonPoints, total: st.points });
    }
    return res;
    // ── the only row that is about real money ─────────────────────────────
    // A package is bought with GRAM, and GRAM is bought with TON. "Я купил
    // набор и ничего не пришло" is a payment dispute, and until now the log's
    // answer to it was the word 'gramShopBuy'. Which package, at what price,
    // and what the balance was afterwards are all already in hand here.
  }, r => r && {
    pkgId: r.pkgId, price: r.price, gramLeft: r.gramLeft,
    gold: r.gold, nexum: r.nexum, seasonTicket: r.seasonTicket,
    items: (r.granted || []).map(g => g.itemId),
  }));

  // ── the starter kit ──────────────────────────────────────────────────────
  safeOn('starterBonusClaim', () => s.act('starterBonusClaim', 'starterBonusError', async (t, pid) => {
    await shopRepo.claimStarterBonus(t, pid);
    await s.pushItems(t); await s.pushStats(t);
    s.socket.emit('potionBag', { potionBag: await consumables.potionBagOf(t, pid) });
    s.socket.emit('starterBonusDone', {});
  }));

  // ── referrals ────────────────────────────────────────────────────────────
  safeOn('getReferrals', () => s.act('getReferrals', 'gramError', async (t, pid) => {
    s.socket.emit('refData', await shopRepo.referralsOf(t, pid));
  }));

  // ── rebirth and reset ────────────────────────────────────────────────────
  safeOn('rebirth', () => s.act('rebirth', 'rebirthError', async (t, pid) => {
    // The hub-only rule is geometry, so it stays with the room rather than the
    // repository — but it is checked before anything is consumed.
    if (s.floor !== 1) fail('Перерождение доступно только в Зале', 'wrong_floor');
    const prog = await players.progressOf(t, pid);
    const res = await players.rebirth(t, pid, rebirthCostFor(prog.rebirths), {
      minLevel: REBIRTH_LEVEL, bonusSp: REBIRTH_BONUS_SP,
    });
    await s.pushItems(t); await pushAfterStat(t);
    // The client REBUILDS the character from this packet — level, experience,
    // the curve, all three base stats and the upgrade map. The repo's return
    // value carries four of those ten fields, so a rebirth set lvl, xp, xpNext
    // and every base stat to undefined: the character on screen became NaN
    // across the board and stayed that way until a reload.
    const after = await players.progressOf(t, pid);
    const st = await stats.of(t, pid);
    s.socket.emit('rebirthDone', {
      lvl: after.lvl, xp: after.xp, xpNext: st ? st.xpNext : 0,
      baseAtk: st ? st.baseAtk : undefined,
      baseDef: st ? st.baseDef : undefined,
      baseMaxHp: st ? st.baseMaxHp : undefined,
      upgrades: after.upgrades || {},
      bonusSP: after.bonusSP, keptSP: after.keptSP, rebirths: after.rebirths,
      spentReturned: res.spentReturned,
    });
  }));

  safeOn('resetUpgrades', () => s.act('resetUpgrades', 'resetUpgradesError', async (t, pid) => {
    const res = await players.resetUpgrades(t, pid, UPGRADE_RESET_COST);
    await s.pushBalances(t); await pushAfterStat(t);
    s.socket.emit('upgradesReset', res);
  }));

  // ── ratings ──────────────────────────────────────────────────────────────
  // bm is a stored column, recomputed whenever stats change, so the board is
  // an index scan rather than thirty numbers derived per row.
  safeOn('getRating', ({ tab } = {}) => s.act('getRating', 'ratingError', async (t) => {
    const { query } = require('../db');
    if (tab === 'clans') {
      const { rows } = await query(t, `
        SELECT c.id, c.name, c.icon, c.level, c.xp,
               (SELECT count(*)::int FROM clan_members m WHERE m.clan_id = c.id) AS members
          FROM clans c ORDER BY c.xp DESC LIMIT 50`);
      return s.socket.emit('ratingData', { tab: 'clans', rows });
    }
    const { rows } = await query(t, `
      SELECT p.username, p.bm, pr.lvl
        FROM players p JOIN player_progress pr ON pr.player_id = p.id
       WHERE NOT p.banned AND p.bm > 0
       ORDER BY p.bm DESC LIMIT 50`);
    s.socket.emit('ratingData', { tab: 'players', rows });
  }));
};
