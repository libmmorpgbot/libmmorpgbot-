'use strict';
// ── Гильдийские боссы: вызов, итог, дроп ────────────────────────────────────
// Правила — shared/definitions.js (GUILD_BOSS_*). Здесь — только строки
// guild_boss_summons/guild_boss_rewards и деньги, всегда в транзакции
// вызывающего (или своей, где сказано). Сам бой — server/game/guildboss.js.
//
// Таблиц до миграции 044 нет — тогда вкладка говорит «скоро», а вызов
// отказывает (ready()).

const crypto = require('crypto');
const { query, tx, hasColumn } = require('../index');
const items = require('./items');
const money = require('./money');
const clans = require('./clans');
const {
  GUILD_BOSS_LEVELS, GUILD_BOSS_SUMMON_COST, GUILD_BOSS_SUMMONS_PER_WEEK, GUILD_BOSS_MIN_CLAN_LEVEL,
  CRAFT_MATS, seasonWeekKey, guildBossRollReward,
} = require('../../../shared/definitions');

class GuildBossError extends Error {
  constructor(code, msg) { super(msg); this.code = code; this.userMessage = msg; }
}
const err = (code, msg) => { throw new GuildBossError(code, msg); };

async function ready() { return hasColumn('guild_boss_summons', 'status'); }

// Сколько вызовов клан уже сделал на этой неделе. Возвращённые (refunded) не
// в счёт — их съел перезапуск сервера, а не клан.
async function usedThisWeek(db, clanId, week = seasonWeekKey()) {
  const { rows } = await query(db, `
    SELECT count(*)::int n FROM guild_boss_summons
     WHERE clan_id = $1 AND week = $2 AND status <> 'refunded'`, [clanId, week]);
  return rows[0].n;
}

async function activeOf(db, clanId) {
  const { rows } = await query(db, `
    SELECT id, level, created_at FROM guild_boss_summons
     WHERE clan_id = $1 AND status = 'active'`, [clanId]);
  return rows.length ? { id: Number(rows[0].id), level: Number(rows[0].level), at: rows[0].created_at } : null;
}

// Лидер вызывает босса. Плата — 500 Liberty с его собственного баланса.
async function summon(db, playerId, level) {
  if (!await ready()) err('off', 'Гильдийские боссы ещё не включены на сервере');
  const lvl = Math.floor(Number(level));
  if (!GUILD_BOSS_LEVELS.includes(lvl)) err('bad_level', 'Нет такого босса');
  await items.lockPlayer(db, playerId);
  const m = await clans.clanOf(db, playerId);
  if (!m) err('no_clan', 'Вы не состоите в клане');
  if (m.role !== 'leader') err('not_leader', 'Вызывать босса может только лидер');
  // Клан — под замок: два вызова от одного клана в одну секунду встают в
  // очередь, и недельный лимит не обходится.
  const { rows: c } = await query(db, 'SELECT xp FROM clans WHERE id = $1 FOR UPDATE', [m.clanId]);
  if (!c.length) err('no_clan', 'Клан не найден');
  const clanLevel = clans.levelFor(Number(c[0].xp));
  if (clanLevel < GUILD_BOSS_MIN_CLAN_LEVEL) {
    err('clan_level', `Нужен ${GUILD_BOSS_MIN_CLAN_LEVEL} уровень клана (сейчас ${clanLevel})`);
  }
  if (await activeOf(db, m.clanId)) err('active', 'Босс уже вызван — сначала одолейте его');
  const week = seasonWeekKey();
  if (await usedThisWeek(db, m.clanId, week) >= GUILD_BOSS_SUMMONS_PER_WEEK) {
    err('limit', `На этой неделе босс уже вызывался ${GUILD_BOSS_SUMMONS_PER_WEEK} раза`);
  }
  const { rows } = await query(db, `
    INSERT INTO guild_boss_summons (clan_id, level, week, summoned_by, cost)
    VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
    [m.clanId, lvl, week, playerId, GUILD_BOSS_SUMMON_COST]);
  const id = Number(rows[0].id);
  const paid = await money.spend(db, playerId, 'nexum', GUILD_BOSS_SUMMON_COST, {
    reason: 'guild_boss_summon', refType: 'guild_boss', refId: String(id),
    idemKey: `guild_boss:${id}`,
  });
  if (!paid) err('no_nexum', `Нужно ${GUILD_BOSS_SUMMON_COST} Liberty`);
  return { id, clanId: m.clanId, level: lvl, at: new Date(rows[0].created_at).getTime(), balance: paid.balance };
}

// Итог вызова. Только из 'active' — второй итог (убийство и истечение в одну
// секунду) не перепишет первый.
async function finish(db, summonId, status, killedBy = null) {
  const { rowCount } = await query(db, `
    UPDATE guild_boss_summons SET status = $2, killed_by = $3, ended_at = now()
     WHERE id = $1 AND status = 'active'`, [summonId, status, killedBy]);
  return rowCount > 0;
}

// Босс убит: итог вызова и дроп в хранилище клана — одной транзакцией.
// «Убит» ставится только из 'active', так что второй удар по трупу (или
// повтор после сбоя) ничего не положит дважды: UPDATE не найдёт строку.
// Дроп — один бросок на клан; раздаёт лидер (clans.allocate), как осколки.
async function settleKill(summonId, clanId, level, killedBy = null) {
  return tx(async (t) => {
    const roll = guildBossRollReward(level, () => crypto.randomInt(2 ** 30) / 2 ** 30);
    const { rowCount } = await query(t, `
      UPDATE guild_boss_summons
         SET status = 'killed', killed_by = $2, ended_at = now(), drop_items = $3::jsonb
       WHERE id = $1 AND status = 'active'`, [summonId, killedBy, JSON.stringify(roll)]);
    if (!rowCount) return null;
    for (const it of roll) {
      await query(t, `
        INSERT INTO clan_storage (clan_id, item_id, qty) VALUES ($1, $2, $3)
        ON CONFLICT (clan_id, item_id) DO UPDATE SET qty = clan_storage.qty + EXCLUDED.qty`,
        [clanId, it.id, it.qty]);
    }
    return roll.map(it => {
      const def = CRAFT_MATS.find(m => m.id === it.id);
      return { ...it, name: def ? def.name : it.id, img: def ? def.img : null };
    });
  });
}

// Один вызов вернуть (зал не поднялся сразу после оплаты).
async function refundOne(summonId) {
  return tx(async (t) => {
    const { rows } = await query(t, `
      UPDATE guild_boss_summons SET status = 'refunded', ended_at = now()
       WHERE id = $1 AND status = 'active' RETURNING summoned_by, cost`, [summonId]);
    if (!rows.length || rows[0].summoned_by == null) return false;
    await money.credit(t, Number(rows[0].summoned_by), 'nexum', Number(rows[0].cost), {
      reason: 'guild_boss_refund', refType: 'guild_boss', refId: String(summonId),
      idemKey: `guild_boss_refund:${summonId}`,
    });
    return true;
  });
}

// На старте сервера: зал живёт только в памяти процесса, и вызов, который
// перезапуск застал активным, потерян. Liberty возвращается лидеру, вызов не
// считается в недельный лимит.
async function refundActive() {
  if (!await ready()) return [];
  return tx(async (t) => {
    const { rows } = await query(t, `
      UPDATE guild_boss_summons SET status = 'refunded', ended_at = now()
       WHERE status = 'active' RETURNING id, summoned_by, cost`);
    for (const r of rows) {
      if (r.summoned_by == null || !(Number(r.cost) > 0)) continue;
      await money.credit(t, Number(r.summoned_by), 'nexum', Number(r.cost), {
        reason: 'guild_boss_refund', refType: 'guild_boss', refId: String(r.id),
        idemKey: `guild_boss_refund:${r.id}`,
      });
    }
    return rows.map(r => Number(r.id));
  });
}

module.exports = {
  ready, usedThisWeek, activeOf, summon, finish, settleKill, refundActive, refundOne, GuildBossError,
};
