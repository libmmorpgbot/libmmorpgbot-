#!/usr/bin/env node
'use strict';
// ── Логово боссов, end to end ───────────────────────────────────────────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/bosslair-check.js
//
// Boots the real server (same harness as dev/modes-check.js) and asks:
//
//   * do the bosses open in order — the next only after the previous is killed?
//   * does entering put the player in a private hall, and does the chosen
//     boss — at that level, with the rung's speed/attack-rate scaling —
//     actually appear there?
//   * does killing it pay exactly 2 bless stones + <level> star shards, in the
//     database, and count the day's one kill?
//   * is a second kill the same day refused at the door?

const io = require('socket.io-client');
const crypto = require('crypto');

const PORT = Number(process.env.LAIR_PORT || 3133);
process.env.PORT = String(PORT);
// Same safety switches as dev/modes-check.js — see there.
process.env.OPS_LIVE = '0';
process.env.NODE_ENV = 'test';
process.env.TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || 'test:token';

const { pool, close } = require('../server/db');
const app = require('../server/app');
const { wipeItemsAll } = require('./fixtures');
const { BOSS_LAIR_LEVELS, BOSS_LAIR_BOSSES, bossLairBoss, bossLairScaling, bossLairReward, monsterStatsAtLevel } = require('../shared/definitions');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, n) => ok(a === b, n, `ожидал ${JSON.stringify(b)}, получил ${JSON.stringify(a)}`);

const TAG = 'bl-' + String(process.pid).slice(-5);
const made = [];

function initDataFor(id, username) {
  const user = JSON.stringify({ id, first_name: username, username });
  const params = { auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AA', user };
  const check = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.TG_BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...params, hash }).toString();
}
const once = (sock, ev, ms = 4000) => new Promise((res, rej) => {
  const to = setTimeout(() => rej(new Error(`таймаут ожидания '${ev}'`)), ms);
  sock.once(ev, d => { clearTimeout(to); res(d); });
});
const maybe = (sock, ev, ms = 1200) => once(sock, ev, ms).catch(() => null);
const wait = ms => new Promise(r => setTimeout(r, ms));

async function connectAs(tgId, username) {
  const sock = io(`http://127.0.0.1:${PORT}`, { transports: ['websocket'], forceNew: true });
  await once(sock, 'connect');
  sock.emit('loginTelegramWebApp', { initData: initDataFor(tgId, username) });
  await once(sock, 'authOk', 8000);
  const { rows } = await pool().query('SELECT id FROM players WHERE telegram_id = $1', [String(tgId)]);
  const pid = Number(rows[0].id);
  if (!made.includes(pid)) made.push(pid);
  sock.emit('selectChar', { type: 'deathknight' });
  await once(sock, 'gameStart', 8000);
  return { sock, pid };
}
const countItem = async (pid, id) => {
  const { rows } = await pool().query(
    'SELECT COALESCE(sum(qty),0)::int n FROM player_items WHERE player_id=$1 AND item_id=$2', [pid, id]);
  return rows[0].n;
};

async function main() {
  console.log(`\nbosslair-check  (${TAG})\n`);

  console.log('  ── лестница боссов ──');
  eq(BOSS_LAIR_LEVELS.join(','), '10,15,20,25,30,35,40,45,50,55,60,65,70,75', '14 боссов, 10..75 через 5');
  let stronger = true;
  for (let i = 1; i < BOSS_LAIR_LEVELS.length; i++) {
    const a = BOSS_LAIR_LEVELS[i - 1], b = BOSS_LAIR_LEVELS[i];
    const ka = bossLairScaling(a), kb = bossLairScaling(b);
    const sa = monsterStatsAtLevel(a, 'boss'), sb = monsterStatsAtLevel(b, 'boss');
    if (!(sb.hp * kb.hpMult > sa.hp * ka.hpMult && sb.atk * kb.atkMult > sa.atk * ka.atkMult
          && kb.spdMult > ka.spdMult && kb.atkCdMult < ka.atkCdMult)) stronger = false;
  }
  ok(stronger, 'каждый следующий босс сильнее, быстрее и бьёт чаще');
  eq(JSON.stringify(bossLairReward(35)), JSON.stringify([{ id: 'bless_stone', qty: 2 }, { id: 'star_shard', qty: 35 }]),
    'награда босса 35 ур.: 2 безопасные заточки + 35 осколков');
  eq(JSON.stringify(bossLairReward(30)), JSON.stringify([{ id: 'norm_stone', qty: 2 }, { id: 'star_shard', qty: 30 }]),
    'награда босса 30 ур.: 2 обычные заточки + 30 осколков');
  ok(BOSS_LAIR_LEVELS.every(l => bossLairReward(l)[0].id === (l <= 30 ? 'norm_stone' : 'bless_stone')),
    '10–30 — обычные заточки, 35–75 — безопасные');

  await app.boot();
  const modes = require('../server/modes').modes;
  const TG = 900000301;
  const a0 = await connectAs(TG, `${TAG}_a`);
  await pool().query('UPDATE player_progress SET lvl = 12 WHERE player_id = $1', [a0.pid]);
  await pool().query('DELETE FROM player_daily WHERE player_id = $1', [a0.pid]);
  a0.sock.disconnect();
  await wait(300);
  const a = await connectAs(TG, `${TAG}_a`);

  // Enters the hall for `lvl`, waits for the boss, checks what was spawned and
  // lands the killing blow. Returns the bossLairFinished payload.
  async function fight(lvl) {
    a.sock.emit('bossLairEnter', { level: lvl });
    const started = await maybe(a.sock, 'bossLairStarted', 5000);
    ok(started && started.level === lvl, `вошёл в логово к боссу ${lvl} ур.`);
    const up = started ? await maybe(a.sock, 'bossLairBoss', 9000) : null;
    ok(up && up.level === lvl, 'босс появился после отсчёта');
    const run = modes._fear.get(a.sock.id);
    ok(run && run.boss === lvl, 'забег записан как бой с боссом, а не Страх');
    const boss = run && run.room.enemies.find(e => e.bossLair && e.hp > 0);
    const row = bossLairBoss(lvl);
    ok(!!boss, `в зале стоит босс (${boss && boss.name})`);
    if (boss) {
      const k = bossLairScaling(lvl), st = monsterStatsAtLevel(lvl, 'boss');
      eq(boss.eid, row.eid, `свой облик: ${row.eid}`);
      eq(boss.rlvl, lvl, 'уровень босса — выбранный');
      eq(boss.maxHp, Math.floor(st.hp * k.hpMult), 'HP: кривая босса ×30 × ступень');
      ok(boss.maxHp >= st.hp * 30, `HP минимум в 30 раз больше обычного босса (${boss.maxHp})`);
      ok(boss.atk >= Math.floor(st.atk * 3), `атака минимум в 3 раза больше (${boss.atk})`);
      eq(boss.atkCdMult, k.atkCdMult, 'бьёт чаще по своей ступени');
      const me = run.room.players.get(a.sock.id);
      boss.hp = 1; boss.x = me.x + 10; boss.y = me.y; boss.atk = 0;
      a.sock.emit('attack', { enemyId: boss.id });
    }
    return maybe(a.sock, 'bossLairFinished', 6000);
  }
  const sync = async () => { a.sock.emit('bossLairSync'); return once(a.sock, 'bossLairState'); };

  console.log('  ── облик ──');
  eq(new Set(BOSS_LAIR_BOSSES.map(b => b.eid)).size, 14, 'у всех 14 боссов разные спрайты');

  console.log('  ── вход ──');
  const st = await sync();
  eq(st.killsLeft, 1, 'на сегодня одно убийство');
  eq((st.levels || []).length, 14, 'сервер прислал 14 боссов');
  eq(st.maxKilled, 0, 'ещё никого не убил — открыт только первый');

  a.sock.emit('bossLairEnter', { level: 15 });
  const err = await maybe(a.sock, 'bossLairError', 2000);
  ok(err && /10/.test(err.msg), `второй босс закрыт, пока не убит первый (${err && err.msg})`);

  console.log('  ── убийство первого ──');
  const fin = await fight(10);
  ok(fin && fin.cleared === true, 'босс убит, бой завершён');
  ok(fin && fin.reward && fin.reward.counted === true, 'убийство засчитано');
  eq(await countItem(a.pid, 'norm_stone'), 2, '+2 камня обычной заточки в базе (босс 10 ур.)');
  eq(await countItem(a.pid, 'star_shard'), 10, '+10 звёздных осколков в базе');
  ok(!modes._fear.has(a.sock.id), 'зал освобождён');

  const st2 = await sync();
  eq(st2.killsLeft, 0, 'убийств на сегодня не осталось');
  eq(st2.maxKilled, 10, 'прогресс записан — открыт следующий босс');
  a.sock.emit('bossLairEnter', { level: 15 });
  const err2 = await maybe(a.sock, 'bossLairError', 2000);
  ok(err2 && /завтра/i.test(err2.msg), `второй вход за день — отказ (${err2 && err2.msg})`);

  console.log('  ── на следующий день — второй босс ──');
  await pool().query('DELETE FROM player_daily WHERE player_id = $1', [a.pid]);
  const fin2 = await fight(15);
  ok(fin2 && fin2.reward && fin2.reward.counted === true, 'второй босс убит и засчитан');
  eq(await countItem(a.pid, 'star_shard'), 25, '+15 осколков сверху');
  eq((await sync()).maxKilled, 15, 'открыт третий босс');

  a.sock.disconnect();
  await wait(200);
}

async function cleanup() {
  const q = (s, p) => pool().query(s, p).catch(() => {});
  if (made.length) {
    await wipeItemsAll(made);
    for (const t of ['player_skills', 'player_vip', 'player_prefs', 'player_daily',
                     'player_season', 'player_progress', 'pvp_history', 'ledger', 'balances']) {
      await q(`DELETE FROM ${t} WHERE player_id = ANY($1)`, [made]);
    }
    await q('DELETE FROM players WHERE id = ANY($1)', [made]);
  }
  try { await app.shutdown('test', { exit: false }); } catch { /* already down */ }
}

main()
  .catch(err => { fail++; failures.push('НЕОБРАБОТАННАЯ ОШИБКА'); console.error('\n', err); })
  .finally(async () => {
    await cleanup();
    await close().catch(() => {});
    console.log(`\n  ${pass} прошло, ${fail} упало`);
    if (failures.length) console.log('  упали: ' + failures.join(' · '));
    process.exit(fail ? 1 : 0);
  });
