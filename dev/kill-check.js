#!/usr/bin/env node
'use strict';
// ── Does killing a monster actually work? ───────────────────────────────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/kill-check.js
//
// Written after players reported, in one message: monsters do not disappear
// when killed, no experience arrives, gold goes back to what it was, and gold
// resets on reload. Four symptoms, two causes, and neither was visible to any
// test in this repository — every one of them checked the DATABASE and none of
// them checked what the CLIENT was told.
//
//   * the server credited the reward and emitted nothing. There was no
//     'enemyKilled' anywhere in the rewritten handlers, so the client never
//     learned the monster died: no corpse removal, no xp number, no gold.
//   * authOk carried everything EXCEPT savedData, which is the one field the
//     client rebuilds a character from. A returning player got the client's
//     own defaults — no gold, level one, an empty bag.
//
// So this drives a real socket, kills a real monster, and asserts on what
// ARRIVES AT THE CLIENT rather than on what lands in the tables.

const crypto = require('crypto');
const io = require('socket.io-client');

const PORT = Number(process.env.KILL_CHECK_PORT || 3151);
process.env.PORT = String(PORT);
process.env.OPS_LIVE = '0';
process.env.NODE_ENV = 'test';
process.env.TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || 'test:token';

const { pool, close } = require('../server/db');
const players = require('../server/db/repos/players');
const money = require('../server/db/repos/money');
const app = require('../server/app');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);

const TAG = 'kl-' + String(process.pid).slice(-5);
const made = [];

function initDataFor(id, username) {
  const user = JSON.stringify({ id, first_name: username, username });
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AA', user });
  const check = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.TG_BOT_TOKEN).digest();
  p.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
  return p.toString();
}
const once = (sock, ev, ms = 6000) => new Promise((res, rej) => {
  const to = setTimeout(() => rej(new Error(`таймаут '${ev}'`)), ms);
  sock.once(ev, d => { clearTimeout(to); res(d); });
});
const wait = ms => new Promise(r => setTimeout(r, ms));

async function connect(tgId, name) {
  const sock = io(`http://127.0.0.1:${PORT}`, { transports: ['websocket'], forceNew: true });
  await once(sock, 'connect');
  sock.emit('loginTelegramWebApp', { initData: initDataFor(tgId, name) });
  const auth = await once(sock, 'authOk', 10000);
  const { rows } = await pool().query('SELECT id FROM players WHERE telegram_id = $1', [String(tgId)]);
  return { sock, auth, pid: Number(rows[0].id) };
}

async function main() {
  console.log(`\nkill-check  (${TAG})\n`);
  await app.boot();
  console.log('');

  const tgId = 910000001;
  const a = await connect(tgId, `${TAG}_hunter`);
  made.push(a.pid);

  // ── the field the client rebuilds a character from ───────────────────────
  console.log('  ── savedData ──');
  ok(!!a.auth.savedData, 'authOk несе savedData — без нього гравець лишається з нулями клієнта');
  const sd = a.auth.savedData || {};
  for (const k of ['lvl', 'xp', 'gold', 'inventory', 'equipment', 'upgrades',
                   'skillLevels', 'potionBag', 'baseAtk', 'baseDef', 'baseMaxHp']) {
    ok(k in sd, `savedData.${k} — restoreFromSave читає його`);
  }
  eq(sd.potionBag && sd.potionBag.pt1, 30, 'сумка зілль справжня, а не клієнтський дефолт');
  ok(sd.baseAtk > 0 && sd.baseMaxHp > 0,
    `базові стати без спорядження (atk ${sd.baseAtk}, hp ${sd.baseMaxHp})`);
  // The client's recompute() adds the upgrades and the gear itself. Sending
  // the final number as the base would have it count the sword twice.
  ok(sd.baseAtk <= a.auth.stats.atk,
    'базовий atk НЕ більший за підсумковий — інакше спорядження врахується двічі');

  // Gold that exists has to survive a reload. It did not: nothing restored it.
  await money.credit(null, a.pid, 'gold', 777, { reason: 'seed', idemKey: `${TAG}:g` });
  a.sock.disconnect();
  await wait(300);
  const b = await connect(tgId, `${TAG}_hunter`);
  eq(b.auth.savedData.gold, 777, 'золото переживає перезаход — саме це «слітало»');

  // ── the kill ─────────────────────────────────────────────────────────────
  console.log('  ── вбивство ──');
  await pool().query('UPDATE player_progress SET lvl = 40 WHERE player_id = $1', [a.pid]);
  b.sock.emit('selectChar', { type: 'deathknight' });
  await once(b.sock, 'gameStart', 10000);

  const sess = app.io.sockets.sockets.get(b.sock.id).data.session;
  sess.forceFloor(2);                                   // the hub has no monsters
  await once(b.sock, 'gameStart', 8000);
  await wait(500);

  const room = sess.room;
  const alive = () => (room.enemies || []).filter(e => e.hp > 0 && !e.isBoss);
  ok(alive().length > 0, `на поверсі є монстри (${alive().length})`);

  const me = room.players.get(b.sock.id);

  // ── the room has to know how strong the player is ────────────────────────
  // "Долго реагируют" was partly this. addPlayer gives a record with no class
  // and no numbers; nothing was calling setPlayerChar, and setPlayerStats had
  // no level to carry. A character fighting at its class's level-one baseline
  // takes a very long time to kill anything, which reads as the monsters being
  // slow rather than as the player being weak.
  const st = await require('../server/db/repos/stats').of(null, a.pid);
  eq(me.type, 'deathknight', 'кімната знає клас гравця');
  eq(me.lvl, st.level, `кімната знає рівень (${me.lvl})`);
  eq(me.atk, st.atk, `кімната знає atk (${me.atk}) — саме ним рахується шкода`);
  eq(me.maxHp, st.maxHp, `і maxHp (${me.maxHp})`);
  ok(me.atk > 1, 'atk більший за одиницю — інакше кожен монстр помирає хвилину');

  // The ENEMY is weakened, not the player. Raising me.atk looked simpler and
  // was wrong twice over: pushStats runs after every kill and puts the real
  // number back — correctly — so the second swing did 7 damage instead of a
  // million, and the attack cooldown then rejected the retries. A test that
  // fights the server's own corrections is a test measuring itself.
  let killed = null, victim = null;
  const goldBefore = (await money.balancesOf(null, a.pid)).gold;
  const xpBefore = (await players.progressOf(null, a.pid)).xp;
  let totalGold = 0;

  // Several kills, because a low-level monster can legitimately roll zero
  // gold — "gold > 0" on one kill is a coin flip pretending to be an
  // assertion, and a flaky test about money is worse than none.
  for (let i = 0; i < 12 && !(killed && killed.gold > 0); i++) {
    victim = alive()[0];
    if (!victim) break;
    me.x = victim.x; me.y = victim.y;
    victim.hp = 1;
    const p = once(b.sock, 'enemyKilled', 8000).catch(() => null);
    b.sock.emit('attack', { enemyId: victim.id });
    const k = await p;
    if (!k || k.id !== victim.id) break;
    killed = k;
    totalGold += k.gold || 0;
    await wait(220);                                    // past the 150ms floor
  }

  ok(!!killed, "'enemyKilled' надіслано — без нього труп не зникає з екрана");
  if (killed) {
    eq(killed.id, victim.id, 'у пакеті той самий монстр');
    ok(Number.isFinite(killed.ex) && Number.isFinite(killed.ey),
      'з координатами — клієнт малює вибух саме там');
    ok(killed.gold > 0, `золото за вбивство доходить (${killed.gold})`);
    ok(killed.xp > 0, `досвід за вбивство є (${killed.xp}) — «опыт не идёт» саме про це`);

    // The packet has to agree with the database, or the number on screen is a
    // decoration the next push overwrites — which is what "золото
    // возвращается" looked like.
    await wait(600);
    const goldAfter = (await money.balancesOf(null, a.pid)).gold;
    eq(goldAfter, goldBefore + totalGold, 'у базі рівно стільки, скільки прийшло в пакетах');
    eq(killed.goldTotal, goldAfter, 'goldTotal збігається з базою — екран не розійдеться з правдою');
    ok((await players.progressOf(null, a.pid)).xp !== xpBefore || killed.level,
      'досвід записаний у базу');
    eq(victim.hp, 0, 'монстр справді мертвий на сервері');
  }

  // ── a bystander ──────────────────────────────────────────────────────────
  // The body has to vanish for everyone who can see it, and nobody but the
  // killer is paid.
  console.log('  ── свідок ──');
  const w = await connect(910000002, `${TAG}_watch`);
  made.push(w.pid);
  await pool().query('UPDATE player_progress SET lvl = 40 WHERE player_id = $1', [w.pid]);
  w.sock.emit('selectChar', { type: 'mage' });
  await once(w.sock, 'gameStart', 10000);
  const sessW = app.io.sockets.sockets.get(w.sock.id).data.session;
  sessW.forceFloor(2);
  await once(w.sock, 'gameStart', 8000);
  await wait(400);

  const next = alive()[0];
  ok(!!next, 'є ще живий монстр для другого досліду');
  if (next) {
    const watcher = sessW.room.players.get(w.sock.id);
    watcher.x = next.x; watcher.y = next.y;
    me.x = next.x; me.y = next.y;

    next.hp = 1;
    const seenP = once(w.sock, 'enemyKilled', 8000).catch(() => null);
    const wGoldBefore = (await money.balancesOf(null, w.pid)).gold;
    b.sock.emit('attack', { enemyId: next.id });
    const seen = await seenP;

    ok(!!seen, 'свідок теж отримав enemyKilled — інакше труп лишається стояти в нього на екрані');
    if (seen) {
      eq(seen.id, next.id, 'той самий монстр');
      eq(seen.gold, undefined, 'але БЕЗ нагороди — платять тому, хто вбив');
    }
    await wait(400);
    eq((await money.balancesOf(null, w.pid)).gold, wGoldBefore, 'і золото свідка не змінилось');
  }

  b.sock.disconnect(); w.sock.disconnect();
  await wait(200);
}

async function cleanup() {
  const q = (s, p) => pool().query(s, p).catch(() => {});
  if (made.length) {
    for (const t of ['player_items', 'player_skills', 'player_vip', 'player_prefs', 'player_daily',
                     'player_season', 'player_progress', 'ledger', 'balances']) {
      await q(`DELETE FROM ${t} WHERE player_id = ANY($1)`, [made]);
    }
    await q('DELETE FROM players WHERE id = ANY($1)', [made]);
  }
  try { await app.shutdown('test', { exit: false }); } catch { /* already down */ }
}

main()
  .catch(err => { fail++; failures.push('НЕОБРОБЛЕНА ПОМИЛКА'); console.error('\n', err); })
  .finally(async () => {
    await cleanup(); await close().catch(() => {});
    console.log(`\n  ${pass} пройшло, ${fail} впало`);
    if (failures.length) console.log('  впали: ' + failures.join(' · '));
    process.exit(fail ? 1 : 0);
  });
