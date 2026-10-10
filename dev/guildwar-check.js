#!/usr/bin/env node
'use strict';
// ── The four towers, the hold, and who may be standing next to them ──────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/guildwar-check.js
//
// Reported: "Война гильдий не активна, но я заспавнился там, потому что вышел
// там. Я заломал замок и ничего не случилось."
//
// Two holes, and the second is the one that matters.
//
// THE FLOOR WAS NEVER GATED BY TIME. resolveFloor checked STANDABLE and the
// LEVEL requirement and nothing else, and sendGameStart restores
// progress.floor through that same function on every login. So logging out
// inside the castle zone put you straight back inside it the next morning —
// and a player could simply walk in at any hour, because the walk-in path
// checks the same function.
//
// THE FIGHT WAS NEVER GATED EITHER. The tower's immune checks were "do you
// have a clan" and "is it already yours". Not "is the event running". Guild
// War ownership pays the holding clan passive income around the clock, so
// capturing the castle at four in the afternoon with the zone closed takes the
// entire reward with nobody able to contest it.
//
// The same shape is checked for the world-boss arena, because it is the other
// floor that is only supposed to be standable while something is happening on
// it.
//
// Later the castle became four towers, one per corner room: «клан, который 5
// минут будет удерживать все 4 вышки, получает победу». So this also checks
// that one tower changing hands does NOT hand over the castle, that holding
// all four starts the clock, that losing any one stops it, and that the clock
// running out does.

const PORT = Number(process.env.GW_PORT || 3163);
process.env.PORT = String(PORT);
process.env.OPS_LIVE = '0';
process.env.NODE_ENV = 'test';
process.env.TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || 'test:token';

const { pool, tx, close } = require('../server/db');
const players = require('../server/db/repos/players');
const clans = require('../server/db/repos/clans');
const money = require('../server/db/repos/money');
const world = require('../server/world');
const { FLOOR_IDS } = require('../server/game/floors');
const app = require('../server/app');
const { wipeItemsAll } = require('./fixtures');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);

const TAG = 'gw-' + String(process.pid).slice(-4);
const made = [];
const clanIds = [];

async function mkPlayer(nick, gold = 0) {
  const { id } = await tx(t => players.ensure(t, `${TAG}-${nick}`, `${TAG}_${nick}`));
  made.push(id);
  await tx(t => players.setClass(t, id, 'deathknight'));
  await pool().query('UPDATE player_progress SET lvl = 60 WHERE player_id = $1', [id]);
  if (gold) await money.credit(null, id, 'gold', gold, { reason: 'seed', idemKey: `${TAG}:${nick}` });
  return id;
}

// THE CASTLE ROW IS LIVE DATA. This check captures the tower and calls
// _gwApplyCapture, which persists — and the first run of it handed a real
// clan's castle to a test clan the cleanup then deleted, leaving the castle
// owned by nobody. Snapshotted here and put back at the end, whatever happens
// in between: a test does not get to decide who owns it.
let _castleBefore = null;

async function main() {
  console.log(`\nguildwar-check  (${TAG})  порт ${PORT}\n`);
  await app.boot();
  // AFTER boot, because the pool is configured there. boot() only READS this
  // row (_gwRestore), so the value is the same either way.
  const { rows: snap } = await pool().query(
    `SELECT owner_clan_id, captured_at FROM guild_war_state WHERE key = 'castle'`);
  _castleBefore = snap.length ? snap[0] : null;
  console.log(`\n  (володіння замком збережено: клан ${_castleBefore && _castleBefore.owner_clan_id})`);

  const modes = require('../server/modes').modes;
  const room = world.roomOf(FLOOR_IDS.guildWar);

  // ── the towers are there at all ──────────────────────────────────────────
  console.log('  ── вышки ──');
  const towers = room ? room.guildWarTowers() : [];
  eq(towers.length, 4, 'на поверсі чотири вишки');
  ok(towers.every(t => t.hp === t.maxHp), 'усі цілі');
  ok(new Set(towers.map(t => `${Math.round(t.x)},${Math.round(t.y)}`)).size === 4, 'і стоять у різних місцях');
  ok(typeof room._gwIsOpen === 'function',
    'кімнаті передано питання «чи відкрите вікно» — без нього бій не перевіряється');
  room.resetGuildWarTowers();
  ok(towers.every(t => t.ownerClanId == null), 'нове вікно — усі нічиї');
  const tower = towers[0];

  // ── the floor, while the window is CLOSED ────────────────────────────────
  console.log('\n  ── вхід поки закрито ──');
  modes._gw.phase = 'closed';
  const high = { lvl: 999 };
  eq(world.resolveFloor(FLOOR_IDS.guildWar, high), FLOOR_IDS.hub,
    'зайти в зону не можна — відкидає в хаб');
  eq(world.resolveFloor('guildWar', high), FLOOR_IDS.hub, 'і за назвою теж');
  eq(world.resolveFloor(FLOOR_IDS.guildWar, { lvl: 999, floor: FLOOR_IDS.guildWar }), FLOOR_IDS.hub,
    'і той, хто вийшов усередині, при вході опиняється в хабі, а не в зоні');

  // ── the fight, while the window is CLOSED ────────────────────────────────
  console.log('\n  ── бій поки закрито ──');
  const a = await mkPlayer('a', 500);
  const c1 = await tx(t => clans.create(t, a, `${TAG.slice(-3)}A`, 3));
  clanIds.push(c1.clanId);
  const badge = await clans.badgeOf(null, a);
  const b = await mkPlayer('b', 500);
  const c2 = await tx(t => clans.create(t, b, `${TAG.slice(-3)}B`, 4));
  clanIds.push(c2.clanId);
  const badgeB = await clans.badgeOf(null, b);

  function join(sid, nick, bd) {
    room.addPlayer(sid, `${TAG}_${nick}`, bd && bd.name, bd && bd.icon, (bd && bd.atkBonus) || 0, `${TAG}-${nick}`, bd && bd.clanId);
    room.setPlayerChar(sid, 'deathknight');
    room.setPlayerStats(sid, { atk: 999999, def: 10, maxHp: 9999, hp: 9999, critChance: 0, critPower: 1, atkSpeed: 1, hpRegen: 0 });
    return room.players.get(sid);
  }
  join('sock_a', 'a', badge);
  join('sock_b', 'b', badgeB);

  // attackEnemy обмежує потік ударів відром токенів (Room._attackAllowed);
  // у цієї перевірки інша тема, тож перед кожним замахом відро повне.
  const swing = (sid, tw) => {
    const p2 = room.players.get(sid);
    if (p2) { p2._lastAtk = 0; p2._atkBudgetAt = null; p2._atkBudget = 0; p2.x = tw.x + 40; p2.y = tw.y; }
    return room.attackEnemy(sid, tw.id);
  };
  // Б'є, поки вишка не перейде, і передає результат режиму — так само, як
  // це робить modes._onCombatResult у грі.
  const capture = (sid, tw) => {
    let res = null;
    for (let i = 0; i < 4000 && !(res && res.captured); i++) {
      res = swing(sid, tw);
      if (res && res.immune) break;
    }
    if (res && res.captured) modes._onCombatResult(sid, tw.id, res, room);
    return res;
  };

  const closedHit = swing('sock_a', tower);
  ok(closedHit && closedHit.immune, 'удар по вишці відхилено');
  eq(closedHit && closedHit.reason, 'closed', 'саме тому, що вікно закрите');
  eq(tower.hp, tower.maxHp, 'і вишка не втратила жодного HP');

  // ── the window opens ─────────────────────────────────────────────────────
  console.log('\n  ── вікно відкрите ──');
  modes._gw.phase = 'live';
  eq(world.resolveFloor(FLOOR_IDS.guildWar, high), FLOOR_IDS.guildWar, 'тепер у зону пускає');

  await mkPlayer('solo');
  join('sock_s', 'solo', null);
  const soloHit = swing('sock_s', tower);
  eq(soloHit && soloHit.reason, 'no_clan', 'без клану бити вишку не можна');

  // ── one tower ────────────────────────────────────────────────────────────
  console.log('\n  ── одна вишка ──');
  const castleBefore = modes._gw.ownerClanName;
  const res = capture('sock_a', tower);
  ok(res && res.captured, `вишку захоплено${res && res.immune ? ` — відмовлено: ${res.reason}` : ''}`);
  eq(res && res.newOwnerClanName, badge.name, 'новий власник — клан нападника');
  eq(tower.hp, tower.maxHp, 'HP вишки відновлено повністю');
  eq(tower.id, 'gw_tower_0', 'і це той самий обʼєкт — id не змінився');
  const ownHit = swing('sock_a', tower);
  eq(ownHit && ownHit.reason, 'own_tower', 'свою вишку бити не можна');
  eq(modes._gw.ownerClanName, castleBefore, 'ОДНА вишка замок не передає');
  eq(modes._gw.holdClanId, null, 'і відлік утримання не пішов');
  const st1 = modes._gwPublicState();
  eq(st1.towers.length, 4, 'публічний стан — про всі чотири вишки');
  eq(st1.towers.find(x => x.i === 0).ownerClanName, badge.name, 'і знає, чия перша');

  // ── all four ─────────────────────────────────────────────────────────────
  console.log('\n  ── всі чотири ──');
  for (const tw of towers.slice(1)) capture('sock_a', tw);
  ok(towers.every(t => t.ownerClanId === badge.clanId), 'клан А тримає всі чотири');
  eq(modes._gw.holdClanId, badge.clanId, 'пішов відлік утримання — за кланом А');
  const st2 = modes._gwPublicState();
  ok(st2.holdUntil - Date.now() > 4.9 * 60 * 1000 && st2.holdUntil - Date.now() <= 5 * 60 * 1000,
    `до перемоги — 5 хвилин (${Math.round((st2.holdUntil - Date.now()) / 1000)} с)`);
  eq(modes._gw.ownerClanName, castleBefore, 'замок поки не передано — треба протримати');

  // ── losing one stops the clock ───────────────────────────────────────────
  console.log('\n  ── втрата однієї вишки ──');
  capture('sock_b', towers[2]);
  eq(towers[2].ownerClanId, badgeB.clanId, 'клан Б відбив третю вишку');
  eq(modes._gw.holdClanId, null, 'відлік утримання зупинено');
  capture('sock_a', towers[2]);
  eq(modes._gw.holdClanId, badge.clanId, 'клан А повернув її — відлік пішов наново');

  // ── the clock runs out ───────────────────────────────────────────────────
  console.log('\n  ── перемога ──');
  clearTimeout(modes._gw.holdTimer);
  modes._gwHoldDone();
  eq(modes._gw.ownerClanName, badge.name, 'клан А став власником замку');
  eq(modes._gw.phase, 'won', 'вікно завершується перемогою');
  eq(world.resolveFloor(FLOOR_IDS.guildWar, high), FLOOR_IDS.hub, 'після перемоги нових не пускає');
  const afterWin = swing('sock_b', towers[0]);
  eq(afterWin && afterWin.reason, 'closed', 'і вишки більше не бʼються');
  // saveCastle пишеться у фоні (бій на нього не чекає) — тож чекаємо запис,
  // а не читаємо в ту ж мить.
  let savedOwner = null;
  for (let i = 0; i < 40 && savedOwner !== badge.clanId; i++) {
    await new Promise(r => setTimeout(r, 50));
    const { rows: saved } = await pool().query(
      `SELECT owner_clan_id FROM guild_war_state WHERE key = 'castle'`);
    savedOwner = saved.length ? Number(saved[0].owner_clan_id) : null;
  }
  eq(savedOwner, badge.clanId, 'власника записано в базу — переживе перезапуск');

  // ── the world-boss arena, same rule ──────────────────────────────────────
  console.log('\n  ── арена світового боса ──');
  const arena = world.roomOf(FLOOR_IDS.arena);
  const bossUp = arena && arena.isEventBossAlive && arena.isEventBossAlive();
  eq(bossUp, false, 'боса зараз немає');
  eq(world.resolveFloor(FLOOR_IDS.arena, high), FLOOR_IDS.hub,
    'без боса в арену не пускає — інакше можна сидіти там і чекати виклику');
  if (modes.scheduleEventBoss) {
    modes.scheduleEventBoss();
    eq(world.resolveFloor(FLOOR_IDS.arena, high), FLOOR_IDS.arena,
      'а коли бос зʼявився — пускає');
  }

  // ── closing puts the window back ─────────────────────────────────────────
  console.log('\n  ── закриття ──');
  modes._gwCloseWindow();
  eq(modes._gw.phase, 'closed', 'вікно закрилось');
  eq(world.resolveFloor(FLOOR_IDS.guildWar, high), FLOOR_IDS.hub, 'і зона знову недоступна');
  eq(modes._gw.ownerClanName, badge.name,
    'а володіння лишилось — воно не має розкладу, дохід іде цілодобово');

  for (const sid of ['sock_a', 'sock_b', 'sock_s']) room.removePlayer(sid);
  ok(!['sock_a', 'sock_b', 'sock_s'].some(sid => room.players.has(sid)),
    `гравці прибрані з кімнати (лишилось ${room.players.size})`);
  room.resetGuildWarTowers();

  console.log(`\n  ${pass} пройшло, ${fail} впало`);
  if (failures.length) console.log(`  впали: ${failures.join(', ')}`);
}

main()
  .catch(err => { console.error(err); fail++; })
  .finally(async () => {
    const q = (s, p) => pool().query(s, p).catch(() => {});
    if (clanIds.length) {
      await q('DELETE FROM clan_members WHERE clan_id = ANY($1)', [clanIds]);
      await q('DELETE FROM clans WHERE id = ANY($1)', [clanIds]);
    }
    if (made.length) {
      // Предметы — ТЕМИ Ж ДВЕРИМА, якими їх видали. Сирий DELETE лишав у
      // item_ledger видачу без рядків, і нічна звірка справедливо кричала
      // про розходження — 216 пар 27 серпня, усі до одної тестові.
      await wipeItemsAll(made);
      for (const t of ['player_skills', 'player_vip', 'player_prefs', 'player_daily',
                       'player_season', 'player_progress', 'player_logs', 'ledger', 'balances']) {
        await q(`DELETE FROM ${t} WHERE player_id = ANY($1)`, [made]);
      }
      await q('DELETE FROM players WHERE id = ANY($1)', [made]);
    }
    // Put the real castle back before anything else — a test must not decide
    // who owns it.
    if (_castleBefore) {
      await q(`UPDATE guild_war_state SET owner_clan_id = $1, captured_at = $2 WHERE key = 'castle'`,
        [_castleBefore.owner_clan_id, _castleBefore.captured_at]);
    }
    try { await app.shutdown('test', { exit: false }); } catch { /* already down */ }
    await close().catch(() => {});
    process.exit(fail ? 1 : 0);
  });
