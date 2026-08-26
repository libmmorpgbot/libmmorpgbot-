#!/usr/bin/env node
'use strict';
// ── The castle, and who may be standing next to it ──────────────────────────
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

async function main() {
  console.log(`\nguildwar-check  (${TAG})  порт ${PORT}\n`);
  await app.boot();
  console.log('');

  const modes = require('../server/modes').modes;
  const room = world.roomOf(FLOOR_IDS.guildWar);

  // ── the castle is there at all ───────────────────────────────────────────
  console.log('  ── замок ──');
  const tower = room && room.enemies.find(e => e.guildWar);
  ok(!!tower, 'замок стоїть на своєму поверсі');
  ok(tower && tower.hp === tower.maxHp, `цілий (${tower && tower.hp}/${tower && tower.maxHp})`);
  ok(typeof room._gwIsOpen === 'function',
    'кімнаті передано питання «чи відкрите вікно» — без нього бій не перевіряється');

  // ── the floor, while the window is CLOSED ────────────────────────────────
  console.log('\n  ── вхід поки закрито ──');
  modes._gw.phase = 'closed';
  const high = { lvl: 999 };
  eq(world.resolveFloor(FLOOR_IDS.guildWar, high), FLOOR_IDS.hub,
    'зайти в зону замку не можна — відкидає в хаб');
  eq(world.resolveFloor('guildWar', high), FLOOR_IDS.hub, 'і за назвою теж');

  // This is the exploit as reported: logging out inside, then logging back in.
  // sendGameStart restores progress.floor through resolveFloor, so the answer
  // has to be the hub.
  eq(world.resolveFloor(FLOOR_IDS.guildWar, { lvl: 999, floor: FLOOR_IDS.guildWar }), FLOOR_IDS.hub,
    'і той, хто вийшов усередині, при вході опиняється в хабі, а не в зоні');

  // ── the fight, while the window is CLOSED ────────────────────────────────
  console.log('\n  ── бій поки закрито ──');
  const a = await mkPlayer('a', 500);
  const c1 = await tx(t => clans.create(t, a, `${TAG.slice(-3)}A`, 3));
  clanIds.push(c1.clanId);
  const badge = await clans.badgeOf(null, a);

  // A player standing next to the tower, placed directly: the point is the
  // combat rule, not how they got there.
  room.addPlayer('sock_a', `${TAG}_a`, badge.name, badge.icon, badge.atkBonus, `${TAG}-a`, badge.clanId);
  room.setPlayerChar('sock_a', 'deathknight');
  room.setPlayerStats('sock_a', { atk: 999999, def: 10, maxHp: 9999, hp: 9999, critChance: 0, critPower: 1, atkSpeed: 1, hpRegen: 0 });
  const me = room.players.get('sock_a');
  me.x = tower.x + 40; me.y = tower.y;

  // attackEnemy rate-limits one hit per attacker per 150ms. That rule has its
  // own tests; here it would just make every assertion below read `null`, so
  // the clock is cleared before each swing.
  const swing = (sid) => {
    const p2 = room.players.get(sid);
    if (p2) p2._lastAtk = 0;
    return room.attackEnemy(sid, tower.id);
  };

  const closedHit = swing('sock_a');
  ok(closedHit && closedHit.immune, 'удар по замку відхилено');
  eq(closedHit && closedHit.reason, 'closed', 'саме тому, що вікно закрите');
  eq(tower.hp, tower.maxHp, 'і замок не втратив жодного HP');

  // ── the window opens ─────────────────────────────────────────────────────
  console.log('\n  ── вікно відкрите ──');
  modes._gw.phase = 'live';
  eq(world.resolveFloor(FLOOR_IDS.guildWar, high), FLOOR_IDS.guildWar,
    'тепер у зону пускає');

  // No clan — refused.
  const solo = await mkPlayer('solo');
  room.addPlayer('sock_s', `${TAG}_s`, null, null, 0, `${TAG}-solo`, null);
  room.setPlayerChar('sock_s', 'deathknight');
  room.setPlayerStats('sock_s', { atk: 999, def: 1, maxHp: 100, hp: 100, critChance: 0, critPower: 1, atkSpeed: 1, hpRegen: 0 });
  const soloP = room.players.get('sock_s');
  soloP.x = tower.x + 40; soloP.y = tower.y;
  const soloHit = swing('sock_s');
  eq(soloHit && soloHit.reason, 'no_clan', 'без клану бити замок не можна');

  // Its own owner — refused.
  tower.ownerClanName = badge.name;
  const ownHit = swing('sock_a');
  eq(ownHit && ownHit.reason, 'own_tower', 'свій замок бити не можна');
  tower.ownerClanName = 'ХтосьІнший';

  // ── the capture ──────────────────────────────────────────────────────────
  console.log('\n  ── захоплення ──');
  const prevOwner = tower.ownerClanName;
  let res = null;
  for (let i = 0; i < 4000 && !(res && res.captured); i++) {
    res = swing('sock_a');
    if (res && res.immune) break;
  }
  ok(res && res.captured, `замок захоплено${res && res.immune ? ` — відмовлено: ${res.reason}` : ''}`);
  eq(res && res.prevOwnerClanName, prevOwner, 'у відповіді — хто володів до того');
  eq(res && res.newOwnerClanName, badge.name, 'і хто володіє тепер');
  eq(tower.hp, tower.maxHp,
    'HP замку відновлено ПОВНІСТЮ — він не лишається на нулі, як було на скріншоті');
  eq(tower.ownerClanName, badge.name, 'власник у кімнаті змінився');
  eq(tower.id, 'guildwar_castle',
    'і це той самий обʼєкт — id не змінився, інакше в усіх клієнтів зламається таблиця дескрипторів');

  // The mode runtime has to hear about it, or the panel and the hourly income
  // keep paying the previous owner.
  modes._gwApplyCapture(res);
  eq(modes._gw.ownerClanName, badge.name, 'режим записав нового власника');
  ok(modes._gw.capturedAt > 0, 'і час захоплення');
  const st = modes._gwPublicState();
  eq(st.ownerClanName, badge.name, 'публічний стан теж');

  // ── and it survives a restart ────────────────────────────────────────────
  const { rows: saved } = await pool().query(
    `SELECT owner_clan_id FROM guild_war_state WHERE key = 'castle'`);
  ok(saved.length > 0, 'володіння записано в базу — переживе перезапуск');

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

  room.removePlayer('sock_a');
  room.removePlayer('sock_s');
  ok(true, `гравці прибрані з кімнати (${solo ? '' : ''}ок)`);

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
      for (const t of ['player_items', 'player_skills', 'player_vip', 'player_prefs', 'player_daily',
                       'player_season', 'player_progress', 'player_logs', 'ledger', 'balances']) {
        await q(`DELETE FROM ${t} WHERE player_id = ANY($1)`, [made]);
      }
      await q('DELETE FROM players WHERE id = ANY($1)', [made]);
    }
    try { await app.shutdown('test', { exit: false }); } catch { /* already down */ }
    await close().catch(() => {});
    process.exit(fail ? 1 : 0);
  });
