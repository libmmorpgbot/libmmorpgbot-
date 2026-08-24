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
const stats = require('../db/repos/stats');
const {
  SKILL_MAX_LEVEL, PASSIVE_MAX_LEVEL, REBIRTH_LEVEL, REBIRTH_BONUS_SP,
  rebirthCostFor, UPGRADE_RESET_COST, SKILL_UPGRADE_CHANCE,
  skillBookId, advSkillBookId, passiveBookId, _vipLevelItems,
} = require('../../shared/definitions');
const shop = require('../shop');

const SLOTS = new Set(['Q', 'W', 'E', 'R']);
const fail = (msg, code) => { throw Object.assign(new Error(msg), { userMessage: msg, code }); };

module.exports = function registerProgression(s, safeOn) {
  const pushAfterStat = async (t) => { await s.pushProgress(t); await s.pushStats(t); };

  // ── studying ─────────────────────────────────────────────────────────────
  // The book is consumed and the level applied in ONE transaction. The old
  // version's "my passive rolled back" reports came from these being two
  // steps: the book was spent, the level was written into a client-owned map,
  // and a save arriving from a stale client wrote the old map back over it.
  async function study(t, pid, kind, key, bookId, max) {
    const current = (await players.skillsOf(t, pid));
    const map = kind === 'passive' ? current.passiveLevels : current.skillLevels;
    if ((map[key] || 0) >= max) fail('Уже максимальный уровень', 'maxed');

    await items.lockPlayer(t, pid);
    if (!await items.removeQty(t, pid, bookId, 1)) fail('Нет нужной книги', 'no_book');

    const res = await players.bumpSkill(t, pid, kind, key);
    if (!res.changed) fail('Уже максимальный уровень', 'maxed');
    return res;
  }

  safeOn('learnSkill', ({ key } = {}) => s.act('learnSkill', 'skillError', async (t, pid) => {
    if (!SLOTS.has(key)) return;
    const prog = await players.progressOf(t, pid);
    if (!prog.charClass) fail('Сначала выберите класс', 'no_class');
    const res = await study(t, pid, 'skill', key, skillBookId(prog.charClass, key), SKILL_MAX_LEVEL);
    await s.pushItems(t); await pushAfterStat(t);
    s.socket.emit('skillLearned', { key, level: res.level });
  }));

  // Upgrading rolls a chance. The roll is the server's — the old client sent
  // whether it succeeded.
  safeOn('upgradeSkill', ({ key } = {}) => s.act('upgradeSkill', 'skillError', async (t, pid) => {
    if (!SLOTS.has(key)) return;
    const prog = await players.progressOf(t, pid);
    if (!prog.charClass) fail('Сначала выберите класс', 'no_class');

    await items.lockPlayer(t, pid);
    const bookId = skillBookId(prog.charClass, key);
    if (!await items.removeQty(t, pid, bookId, 1)) fail('Нет нужной книги', 'no_book');

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
    s.socket.emit('upgradeRolled', { key, success, level, chance });
  }));

  safeOn('learnPassive', ({ id } = {}) => s.act('learnPassive', 'skillError', async (t, pid) => {
    if (typeof id !== 'string' || !id) return;
    const res = await study(t, pid, 'passive', id, passiveBookId(id), PASSIVE_MAX_LEVEL);
    await s.pushItems(t); await pushAfterStat(t);
    s.socket.emit('passiveLearned', { id, level: res.level });
  }));

  safeOn('upgradePassive', ({ id } = {}) => s.act('upgradePassive', 'skillError', async (t, pid) => {
    if (typeof id !== 'string' || !id) return;
    const res = await study(t, pid, 'passive', id, passiveBookId(id), PASSIVE_MAX_LEVEL);
    await s.pushItems(t); await pushAfterStat(t);
    s.socket.emit('passiveLearned', { id, level: res.level });
  }));

  safeOn('learnAdvSkill', ({ key } = {}) => s.act('learnAdvSkill', 'skillError', async (t, pid) => {
    if (!SLOTS.has(key)) return;
    const prog = await players.progressOf(t, pid);
    if (!prog.charClass) fail('Сначала выберите класс', 'no_class');
    await items.lockPlayer(t, pid);
    if (!await items.removeQty(t, pid, advSkillBookId(prog.charClass, key), 1)) {
      fail('Нет книги продвинутого навыка', 'no_book');
    }
    await players.setSkillLevel(t, pid, 'adv_learned', key, 1);
    await s.pushItems(t); await pushAfterStat(t);
  }));

  // Which variant is active decides which damage multiplier the server applies
  // in combat, so it is stored rather than trusted per-cast.
  safeOn('toggleAdvSkill', ({ key } = {}) => s.act('toggleAdvSkill', 'skillError', async (t, pid) => {
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
  safeOn('claimQuest', ({ questIdx } = {}) => s.act('claimQuest', 'questError', async (t, pid) => {
    const i = Math.floor(Number(questIdx));
    if (!Number.isSafeInteger(i) || i < 0) return;
    const res = await progression.claimQuest(t, pid, i);

    const r = res.reward || {};
    if (r.gold > 0) {
      await require('../db/repos/money').credit(t, pid, 'gold', r.gold,
        { reason: 'quest', refType: 'quest', refId: String(i), idemKey: `quest:${pid}:${i}:gold` });
    }
    if (r.xp > 0) await players.grantXp(t, pid, r.xp);
    for (const itemId of (r.items || [])) {
      if (await items.hasRoomFor(t, pid, itemId)) await items.add(t, pid, itemId);
    }
    await s.pushItems(t); await s.pushBalances(t); await pushAfterStat(t);
    s.socket.emit('questClaimed', { questIdx: i, nextIdx: res.nextIdx, reward: r });
  }));

  // ── special quests ───────────────────────────────────────────────────────
  safeOn('completeSpecialQuest', ({ questId } = {}) =>
    s.act('completeSpecialQuest', 'questError', async (t, pid) => {
      const id = Math.floor(Number(questId));
      if (!Number.isSafeInteger(id) || id <= 0) return;
      const res = await progression.claimSpecialQuest(t, pid, id);
      if (res.xp > 0) await players.grantXp(t, pid, res.xp);
      await s.pushBalances(t); await pushAfterStat(t);
      s.socket.emit('specialQuestDone', { questId: id, ...res });
    }));

  // ── VIP ──────────────────────────────────────────────────────────────────
  // The tiers are cleared and the items granted in one statement + one
  // transaction. The old version read the pending array, awaited, then cleared
  // it, and the gap between handed out the whole set twice.
  safeOn('claimVipRewards', () => s.act('claimVipRewards', 'gramShopError', async (t, pid) => {
    const prog = await players.progressOf(t, pid);
    const cls = prog.charClass || 'lev';
    const res = await progression.claimVip(t, pid, tier => shop._vipLevelItems(tier, cls));
    if (!res.tiers.length) return;

    // Gold rides along with the tiers, keyed so a retry cannot pay twice.
    let gold = 0;
    for (const tier of res.tiers) gold += shop._vipGoldReward(tier) || 0;
    if (gold > 0) {
      await require('../db/repos/money').credit(t, pid, 'gold', gold, {
        reason: 'vip_claim', refType: 'vip', refId: res.tiers.join(','),
        idemKey: `vip_claim:${pid}:${res.tiers.join('-')}`,
      });
    }
    await s.pushItems(t); await s.pushBalances(t); await pushAfterStat(t);
    s.socket.emit('vipClaimed', { tiers: res.tiers, granted: res.granted, gold });
  }));

  safeOn('vipSync', () => s.act('vipSync', 'gramShopError', async (t, pid) => {
    s.socket.emit('vipData', await progression.vipOf(t, pid));
  }));

  // ── season ───────────────────────────────────────────────────────────────
  // Indexed by (season, points DESC) WHERE points > 0, so this is an index
  // scan. The Mongo version sorted the whole collection in memory on every
  // call — from a handler any client may fire.
  safeOn('seasonRating', () => s.act('seasonRating', 'seasonError', async (t, pid) => {
    const [board, mine] = await Promise.all([
      progression.seasonBoard(t, { limit: 50 }),
      progression.seasonOf(t, pid),
    ]);
    s.socket.emit('seasonRating', { board, me: mine });
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
    s.socket.emit('rebirthDone', res);
  }));

  safeOn('resetUpgrades', () => s.act('resetUpgrades', 'resetUpgradesError', async (t, pid) => {
    const res = await players.resetUpgrades(t, pid, UPGRADE_RESET_COST);
    await s.pushBalances(t); await pushAfterStat(t);
    s.socket.emit('upgradesReset', res);
  }));

  // ── ratings ──────────────────────────────────────────────────────────────
  // bm is a stored column, recomputed whenever stats change, so the board is
  // an index scan rather than thirty numbers derived per row.
  safeOn('getRating', ({ kind } = {}) => s.act('getRating', 'ratingError', async (t) => {
    const { query } = require('../db');
    if (kind === 'clans') {
      const { rows } = await query(t, `
        SELECT c.id, c.name, c.icon, c.level, c.xp,
               (SELECT count(*)::int FROM clan_members m WHERE m.clan_id = c.id) AS members
          FROM clans c ORDER BY c.xp DESC LIMIT 50`);
      return s.socket.emit('rating', { kind: 'clans', rows });
    }
    const { rows } = await query(t, `
      SELECT p.username, p.bm, pr.lvl
        FROM players p JOIN player_progress pr ON pr.player_id = p.id
       WHERE NOT p.banned AND p.bm > 0
       ORDER BY p.bm DESC LIMIT 50`);
    s.socket.emit('rating', { kind: 'players', rows });
  }));
};
