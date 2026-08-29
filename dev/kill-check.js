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
//
// Three exploit scenarios ride along at the end, for the same reason they are
// here rather than in exploit-check.js: each of them is about what a live,
// authenticated socket can do to a floor with real combat running on it, and
// that is precisely what this file already stands up. They are the splash
// ("Безумие") flag, a prototype key used as a character class, and the movement
// budget — each with its own note where it begins.

const crypto = require('crypto');
const io = require('socket.io-client');

const PORT = Number(process.env.KILL_CHECK_PORT || 3151);
process.env.PORT = String(PORT);
process.env.OPS_LIVE = '0';
process.env.NODE_ENV = 'test';
process.env.TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || 'test:token';
// СНИМАЕТСЯ, а не выставляется. Блок «бюджет руху» в конце спрашивает именно
// про ЗНАЧЕНИЕ ПО УМОЛЧАНИЮ — про то, что guard включён у всех, кто ничего не
// настраивал, потому что ровно этого и не было в проде. Унаследованный из
// оболочки MOVE_GUARD=off (его требуют fanout-check и snapshot-check, и его
// легко оставить экспортированным в том же терминале) сделал бы эту проверку
// зелёной, ничего не проверив.
delete process.env.MOVE_GUARD;

const { pool, close } = require('../server/db');
const players = require('../server/db/repos/players');
const money = require('../server/db/repos/money');
const app = require('../server/app');
const { wipeItemsAll } = require('./fixtures');

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

  // Unique per run. A fixed id meant every run shared a player — and
  // therefore shared idempotency keys with the run before it, which made a
  // real bug look like a test artefact for an hour.
  const tgId = 910000000 + (process.pid % 100000);
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
  const progBefore = await players.progressOf(null, a.pid);
  const xpBefore = progBefore.xp;
  // The level as well as the xp, because a level-up is the one legitimate way
  // for stored xp to come back SMALLER than it started — see the assertion
  // below, which used to have `|| killed.level` standing in for this.
  const lvlBefore = progBefore.lvl;
  let totalGold = 0;

  // Several kills, because a low-level monster can legitimately roll zero
  // gold — "gold > 0" on one kill is a coin flip pretending to be an
  // assertion, and a flaky test about money is worse than none.
  //
  // `killed` was the LAST kill, and the loop stopped either on a paying one or
  // after twelve tries. Twelve zero rolls in a row is uncommon and not
  // impossible, and when it happened the assertion below read the final
  // non-paying kill and failed — reporting a broken reward path on a day when
  // nothing was wrong. So the two questions are separated: SHAPE is asked of
  // the first kill, MONEY of the total across all of them.
  //
  // Двенадцати оказалось мало. Стартовые монстры дают 0 или 1 золота — по
  // трассировке платит примерно каждый третий убитый, — так что двенадцать
  // нулей подряд выпадают не «раз в год», а несколько раз за день прогонов:
  // проверка падала на «золото за вбивства доходить (разом 0)» и снова
  // обвиняла игру в том, чего не было.
  //
  // Сорок. Цикл всё равно выходит на первом заплатившем (обычно второй-пятый),
  // так что в обычном случае это ничего не стоит, а сорок нулей подряд — это
  // уже не «бывает», а «не бывает».
  let paid = null, killedVictimId = null;
  for (let i = 0; i < 40 && !paid; i++) {
    victim = alive()[0];
    if (!victim) break;
    me.x = victim.x; me.y = victim.y;
    victim.hp = 1;
    const p = once(b.sock, 'enemyKilled', 8000).catch(() => null);
    // Відро токенів скидається у повне. Сервер приймає удари потоком не
    // швидшим за швидкість атаки гравця (Room._attackAllowed), а цикл нижче
    // б'є одразу після відповіді. Ця перевірка про ЗДОБИЧ і про те, кому вона
    // дістається, а не про темп удару: темп має свою перевірку
    // (dev/relog-attack-check.js), і мовчазна відмова тут виглядала б як
    // «монстр не помер», хоч правило спрацювало правильно.
    me._lastAtk = 0; me._atkBudgetAt = null; me._atkBudget = 0;
    b.sock.emit('attack', { enemyId: victim.id });
    const k = await p;
    if (!k || k.id !== victim.id) break;
    if (!killed) { killed = k; killedVictimId = victim.id; }   // the first, for shape
    if (k.gold > 0) paid = k;                           // the first paying one
    totalGold += k.gold || 0;
    await wait(220);                                    // past the 150ms floor
    if (process.env.KILL_TRACE) {
      const now = (await money.balancesOf(null, a.pid)).gold;
      console.log(`    [trace] ${victim.id} gold=${k.gold} goldTotal=${k.goldTotal} db=${now} sum=${totalGold}`);
    }
  }

  ok(!!killed, "'enemyKilled' надіслано — без нього труп не зникає з екрана");
  if (killed) {
    eq(killed.id, killedVictimId, 'у пакеті той самий монстр');
    ok(Number.isFinite(killed.ex) && Number.isFinite(killed.ey),
      'з координатами — клієнт малює вибух саме там');
    ok(totalGold > 0, `золото за вбивства доходить (разом ${totalGold})`);
    ok(killed.xp > 0, `досвід за вбивство є (${killed.xp}) — «опыт не идёт» саме про це`);

    // The packet has to agree with the database, or the number on screen is a
    // decoration the next push overwrites — which is what "золото
    // возвращается" looked like.
    await wait(600);
    const goldAfter = (await money.balancesOf(null, a.pid)).gold;
    eq(goldAfter, goldBefore + totalGold, 'у базі рівно стільки, скільки прийшло в пакетах');
    // Asked of the LAST packet that carried money, since that is the one whose
    // goldTotal is the current balance.
    if (paid) {
      eq(Number(paid.goldTotal) <= Number(goldAfter), true,
        `goldTotal з пакета не більший за базу (${paid.goldTotal} ≤ ${goldAfter})`);
    }
    eq(killed.goldTotal <= goldAfter, true,
      'goldTotal не випереджає базу — екран не показує грошей, яких нема');
    // `xp !== xpBefore || killed.level` never had to reach the database.
    // `killed.level` is the level block off the kill packet, truthy for every
    // level anybody has ever been, so the second disjunct was true whenever
    // the packet arrived at all — and the packet arriving is what the four
    // assertions above already establish. The rewrite's whole failure mode was
    // "the number was sent and nothing was stored", and this was the one line
    // meant to catch it.
    //
    // Both directions of a real write are allowed and nothing else is: xp
    // moved, or the player crossed a level (which resets the remainder and can
    // legitimately leave xp lower than it started, or equal to it).
    const progAfter = await players.progressOf(null, a.pid);
    ok(progAfter.xp !== xpBefore || progAfter.lvl > lvlBefore,
      `досвід записаний у базу (${xpBefore} → ${progAfter.xp}, рівень ${lvlBefore} → ${progAfter.lvl})`);
    eq(victim.hp, 0, 'монстр справді мертвий на сервері');
  }

  // ── the same spawn, killed twice ─────────────────────────────────────────
  // An enemy id is stable across respawns. The reward key was
  // `kill:<player>:<enemy>`, so the ledger already held it the second time and
  // money.credit correctly treated the kill as a replay — every farmed spawn
  // silently stopped paying after the first time. "Мобы и не засчитывание".
  console.log('  ── той самий спавн удруге ──');
  // A kill that pays nothing proves nothing here, so this hunts for a spawn
  // that does and then kills THAT one twice. The first version of this test
  // accepted two zero-gold kills and passed while proving nothing — which is
  // the same failure as the bug it was written for: a green light with no
  // evidence behind it.
  let twice = null;
  // Twenty-five candidates, not ten: gold is a roll, and ten of them coming up
  // zero is uncommon rather than impossible. A suite that fails once in a batch
  // and passes three times alone is a suite nobody will believe on the day it
  // is right.
  for (const cand of alive().slice(0, 25)) {
    const g0 = (await money.balancesOf(null, a.pid)).gold;
    me.x = cand.x; me.y = cand.y;
    cand.hp = 1;
    const p1 = once(b.sock, 'enemyKilled', 8000).catch(() => null);
    // Відро токенів скидається у повне. Сервер приймає удари потоком не
    // швидшим за швидкість атаки гравця (Room._attackAllowed), а цикл нижче
    // б'є одразу після відповіді. Ця перевірка про ЗДОБИЧ і про те, кому вона
    // дістається, а не про темп удару: темп має свою перевірку
    // (dev/relog-attack-check.js), і мовчазна відмова тут виглядала б як
    // «монстр не помер», хоч правило спрацювало правильно.
    me._lastAtk = 0; me._atkBudgetAt = null; me._atkBudget = 0;
    b.sock.emit('attack', { enemyId: cand.id });
    const k1 = await p1;
    await wait(450);
    const g1 = (await money.balancesOf(null, a.pid)).gold;
    if (!k1 || !(k1.gold > 0)) { await wait(180); continue; }

    // Respawned by hand: the real timer is minutes, and what is under test is
    // the second kill of the SAME id, not the wait. Repeated until one pays —
    // gold is a roll, and an assertion that depends on a roll is one that
    // fails on a day when nothing is wrong.
    let k2 = null, g2 = g1, gBefore2 = g1;
    for (let r = 0; r < 8; r++) {
      gBefore2 = (await money.balancesOf(null, a.pid)).gold;
      cand.hp = 1;
      await wait(250);
      const p2 = once(b.sock, 'enemyKilled', 8000).catch(() => null);
      // Відро токенів скидається у повне. Сервер приймає удари потоком не
    // швидшим за швидкість атаки гравця (Room._attackAllowed), а цикл нижче
    // б'є одразу після відповіді. Ця перевірка про ЗДОБИЧ і про те, кому вона
    // дістається, а не про темп удару: темп має свою перевірку
    // (dev/relog-attack-check.js), і мовчазна відмова тут виглядала б як
    // «монстр не помер», хоч правило спрацювало правильно.
    me._lastAtk = 0; me._atkBudgetAt = null; me._atkBudget = 0;
    b.sock.emit('attack', { enemyId: cand.id });
      k2 = await p2;
      await wait(450);
      g2 = (await money.balancesOf(null, a.pid)).gold;
      if (k2 && k2.gold > 0) break;
    }
    // Eight zero-gold rolls in a row is unlikely but not impossible, and the
    // assertions below are about the LEDGER — which only gets a row when gold
    // moved. Move to the next candidate rather than asserting against a die:
    // that is the exact mistake this file was rewritten to stop making, and it
    // came back as one failure per three-run batch.
    if (!k2 || !(k2.gold > 0)) { await wait(180); continue; }
    twice = { id: cand.id, k1, k2, g0, g1, gBefore2, g2 };
    break;
  }

  ok(!!twice, 'знайшовся спавн, який платить — інакше перевірка нічого не доводить');
  if (twice) {
    const { id, k1, k2, g0, g1, gBefore2, g2 } = twice;
    ok(!!k2, 'друге вбивство того самого id дійшло до клієнта');
    eq(g1 - g0, k1.gold, `перше вбивство зараховане (+${k1.gold})`);
    ok(k2 && k2.gold > 0 && g2 - gBefore2 === k2.gold,
      `ДРУГЕ теж зараховане (+${k2 && k2.gold}) — раніше воно читалось як повтор першого і платило нуль`);
    ok(k1.at && k2 && k2.at && k1.at !== k2.at,
      `у кожної смерті власна мітка (${k1.at} ≠ ${k2 && k2.at})`);

    // The decisive one, and it does not depend on a roll: the two kills of the
    // SAME enemy id wrote two DIFFERENT idempotency keys. Keyed on the id
    // alone there would be one, and every kill after the first was a replay.
    const { rows: keys } = await pool().query(
      `SELECT count(DISTINCT idem_key)::int n FROM ledger
        WHERE player_id = $1 AND reason = 'mob_kill' AND idem_key LIKE $2`,
      [a.pid, `kill:${a.pid}:${id}:%`]);
    ok(keys[0].n >= 2, `на один спавн — різні ключі на різні смерті (${keys[0].n})`);
  }

  // ── a bystander ──────────────────────────────────────────────────────────
  // The body has to vanish for everyone who can see it, and nobody but the
  // killer is paid.
  console.log('  ── свідок ──');
  const w = await connect(tgId + 500000, `${TAG}_watch`);
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
    // One cast, so the server has actually told the watcher about this enemy.
    // viewersOfEnemy answers from _eKnown — what this player has been SENT —
    // and moving a record by hand skips the gameStart snapshot that a real
    // arrival would take at the new position. Without the pause the test is
    // racing the stream and blaming the game for the result.
    await wait(300);

    next.hp = 1;
    const seenP = once(w.sock, 'enemyKilled', 8000).catch(() => null);
    const wGoldBefore = (await money.balancesOf(null, w.pid)).gold;
    // Відро токенів скидається у повне. Сервер приймає удари потоком не
    // швидшим за швидкість атаки гравця (Room._attackAllowed), а цикл нижче
    // б'є одразу після відповіді. Ця перевірка про ЗДОБИЧ і про те, кому вона
    // дістається, а не про темп удару: темп має свою перевірку
    // (dev/relog-attack-check.js), і мовчазна відмова тут виглядала б як
    // «монстр не помер», хоч правило спрацювало правильно.
    me._lastAtk = 0; me._atkBudgetAt = null; me._atkBudget = 0;
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

  // ── «Безумие»: чей это навык и сколько ударов он стоит ────────────────────
  // splash — это АОЕ-побочка ПРОДВИНУТОГО E рыцаря смерти: пока крутится
  // 5-секундный баф, каждый обычный удар задевает соседей на 50% урона. Ни
  // одно из двух условий, которые её описывают, на сервере не проверялось.
  //
  //   КТО. Обработчик брал splash:true прямо с провода. Ни класса, ни
  //   изученного слота, ни купленной книги, ни включённого продвинутого
  //   варианта — `socket.emit('attack', { enemyId, splash: true })` был
  //   бесплатным полуударом для мага первого уровня.
  //
  //   СКОЛЬКО. splash никогда не трогал attacker._lastAtk, поэтому после него
  //   ничего не перезаряжалось: в окно 200 мс после настоящего замаха
  //   помещалось столько пакетов, сколько пропускал БЫСТРЫЙ лимитер сокета
  //   (1500 за 5 с, server/app.js) — около 150 полных ударов в секунду против
  //   6.7 легальных. Каждое убийство платит через consumables.grantKillReward,
  //   так что это ×22 к золоту, опыту, роллам дропа, Liberty и GRAM — и победа
  //   в любом спорном киле: башня войны гильдий, босс гонки, мировой босс.
  //
  // Монстрам здесь ставится огромный hp: проверяется НЕ смерть, а сколько hp
  // сняли. Умерший монстр обнулил бы разницу и тест прошёл бы по неправильной
  // причине — ровно та ошибка, ради которой переписан блок про золото выше.
  console.log('  ── splash («Безумие») ──');
  const spTarget = alive()[0];
  ok(!!spTarget, 'є живий монстр для перевірки splash');
  if (spTarget) {
    spTarget.hp = spTarget.maxHp = 5e6;

    // ── 1. чужой класс ──────────────────────────────────────────────────────
    const wp = sessW.room.players.get(w.sock.id);
    wp.x = spTarget.x; wp.y = spTarget.y;
    // Обычный удар открывает те самые 200 мс, внутри которых splash вообще
    // рассматривается. Без него проверка ниже была бы про окно, а не про класс.
    w.sock.emit('attack', { enemyId: spTarget.id });
    await wait(80);
    const afterMage = spTarget.hp;
    ok(afterMage < 5e6, 'звичайний удар мага пройшов — вікно для splash справді відкрите');
    for (let i = 0; i < 30; i++) w.sock.emit('attack', { enemyId: spTarget.id, splash: true });
    await wait(400);
    eq(spTarget.hp, afterMage,
      'маг із splash:true не зняв жодного hp — «Безумие» це продвинутий E рицаря смерті, а не прапорець у пакеті');

    // ── 2. правильный класс, но без книги ──────────────────────────────────
    // Самая интересная половина: класс совпадает, а права нет. Проверка только
    // на p.type прошла бы здесь и оставила дыру открытой для каждого рыцаря
    // смерти в игре, включая тех, кто E никогда не изучал.
    me.x = spTarget.x; me.y = spTarget.y;
    // Відро токенів скидається у повне. Сервер приймає удари потоком не
    // швидшим за швидкість атаки гравця (Room._attackAllowed), а цикл нижче
    // б'є одразу після відповіді. Ця перевірка про ЗДОБИЧ і про те, кому вона
    // дістається, а не про темп удару: темп має свою перевірку
    // (dev/relog-attack-check.js), і мовчазна відмова тут виглядала б як
    // «монстр не помер», хоч правило спрацювало правильно.
    me._lastAtk = 0; me._atkBudgetAt = null; me._atkBudget = 0;
    b.sock.emit('attack', { enemyId: spTarget.id });
    await wait(80);
    const afterDk = spTarget.hp;
    for (let i = 0; i < 30; i++) b.sock.emit('attack', { enemyId: spTarget.id, splash: true });
    await wait(400);
    eq(spTarget.hp, afterDk,
      'рицар смерті без вивченого E теж нічого не зняв — сам клас права не дає');

    // ── 3. настоящий владелец навыка, очередь в одну цель ──────────────────
    // Книга и очко навыка выдаются через ту же таблицу, из которой их читает
    // repos/stats.js, и pushStats доносит их до комнаты — иначе проверялась бы
    // подставленная в память заглушка, а не то, что видит сервер.
    await pool().query(`
      INSERT INTO player_skills (player_id, kind, key, level)
           VALUES ($1,'skill','E',3), ($1,'adv_learned','E',1), ($1,'adv_active','E',1)
      ON CONFLICT (player_id, kind, key) DO UPDATE SET level = EXCLUDED.level`, [a.pid]);
    await sess.pushStats();
    ok(!!(me._advLearned && me._advLearned.E && me._advActive && me._advActive.E),
      'кімната бачить, що E куплений і ввімкнений — інакше решта перевірки нічого не доводить');

    // Відро токенів скидається у повне. Сервер приймає удари потоком не
    // швидшим за швидкість атаки гравця (Room._attackAllowed), а цикл нижче
    // б'є одразу після відповіді. Ця перевірка про ЗДОБИЧ і про те, кому вона
    // дістається, а не про темп удару: темп має свою перевірку
    // (dev/relog-attack-check.js), і мовчазна відмова тут виглядала б як
    // «монстр не помер», хоч правило спрацювало правильно.
    me._lastAtk = 0; me._atkBudgetAt = null; me._atkBudget = 0;
    b.sock.emit('attack', { enemyId: spTarget.id });
    await wait(80);
    const afterOwner = spTarget.hp;
    const oneSwing = afterDk - afterOwner;
    ok(oneSwing > 0, `замах власника навички проходить (${oneSwing} hp)`);
    const N = 30;
    for (let i = 0; i < N; i++) b.sock.emit('attack', { enemyId: spTarget.id, splash: true });
    await wait(500);
    const splashDmg = afterOwner - spTarget.hp;
    // N пакетов НЕ стоят N половин удара. Настоящее «Безумие» бьёт СОСЕДЕЙ, по
    // одному разу каждого (js/player.js пропускает `e.id === pa.id`), поэтому
    // цель, которую замах уже ударил, от этого же замаха splash не получает —
    // ноль, а не «поменьше».
    eq(splashDmg, 0,
      `${N} splash-пакетів в одне вікно зняли 0 hp замість ~${N}×половини удару — ` +
      'ціль, яку замах уже вдарив, від цього ж замаху splash не отримує');
    ok(splashDmg < oneSwing * 0.5 * N,
      `тобто черга з ${N} пакетів коштує менше, ніж ${N} половин удару ` +
      `(${splashDmg} проти ${Math.round(oneSwing * 0.5 * N)})`);

    // ── 4. легальный случай всё ещё работает ───────────────────────────────
    // Если бы фикс просто запретил splash, эта проверка стала бы красной, а
    // навык, за который заплачены книга и очки, перестал бы существовать —
    // и вернулась бы «AOE иногда не работает», ради которой окно 200 мс и
    // появилось.
    const crowd = alive().filter(e => e.id !== spTarget.id).slice(0, 30);
    crowd.forEach(e => { e.x = spTarget.x; e.y = spTarget.y; e.hp = e.maxHp = 5e6; });
    ok(crowd.length > 16, `сусідів більше за межу (${crowd.length}) — інакше межа не перевіряється`);
    // Відро токенів скидається у повне. Сервер приймає удари потоком не
    // швидшим за швидкість атаки гравця (Room._attackAllowed), а цикл нижче
    // б'є одразу після відповіді. Ця перевірка про ЗДОБИЧ і про те, кому вона
    // дістається, а не про темп удару: темп має свою перевірку
    // (dev/relog-attack-check.js), і мовчазна відмова тут виглядала б як
    // «монстр не помер», хоч правило спрацювало правильно.
    me._lastAtk = 0; me._atkBudgetAt = null; me._atkBudget = 0;
    // Ціль підготовчого замаху теж піднімається. Splash дозволений лише у вікні
    // 200 мс після ПРИЙНЯТОГО справжнього удару — а замах по вже мертвій цілі
    // сервер відхиляє, вікно не відкривається, і всі тридцять splash-пакетів
    // летять у порожнечу. Саме через це перевірка падала приблизно раз на три
    // прогони (перевірено тричі на розгорнутій збірці) і виглядала як «splash
    // не працює», хоч не працював підготовчий удар.
    spTarget.hp = spTarget.maxHp = 5e6;
    const _primed = once(b.sock, 'enemyHurt', 3000).catch(() => null);
    b.sock.emit('attack', { enemyId: spTarget.id });
    ok(!!await _primed, 'підготовчий замах прийнято — без нього вікна splash немає');
    // Без паузи. Вікно splash — 200 мс від ПРИЙНЯТОГО удару (Room.attackEnemy),
    // і воно витрачається не тільки на очікування: тридцять пакетів мусять
    // доїхати й обробитись. Вісімдесят мілісекунд "на всяк випадок" з'їдали
    // майже половину бюджету, і під навантаженням проби не встигали — звідси
    // "0 з 30" приблизно раз на чотири прогони. Підтвердження, що замах
    // прийнято, ми вже маємо рядком вище: це і є весь потрібний синхронізм.
    const before = new Map(crowd.map(e => [e.id, e.hp]));
    for (const e of crowd) b.sock.emit('attack', { enemyId: e.id, splash: true });
    await wait(600);
    const hurt = crowd.filter(e => e.hp < before.get(e.id)).length;
    ok(hurt > 0, `сусіди справді отримують splash (${hurt} з ${crowd.length})`);
    // MAX_SPLASH_PER_SWING, server/game/Room.js. Радіус 90px стільки тіл не
    // вміщає навіть в Елітній фарм-зоні — це стеля, а не робоче число.
    ok(hurt <= 16, `але не більше 16 за один замах (${hurt}) — саме цієї межі не існувало`);
  }

  // ── класс из прототипа ────────────────────────────────────────────────────
  // CHAR_DEF — обычный объектный литерал (shared/definitions.js:36), поэтому
  // CHAR_DEF['constructor'], ['__proto__'], ['toString'], ['valueOf'] и
  // ['hasOwnProperty'] ВСЕ истинны и проходили `if (!cd) return`, хотя
  // Object.hasOwn(CHAR_DEF,'constructor') — ложь. cd.baseHP у них undefined,
  // значит maxHp/atk/def становились NaN.
  //
  // NaN поглощающий: `Math.max(0, hp - dmg)` остаётся NaN, а `NaN <= 0` —
  // ЛОЖЬ, поэтому такой игрок не умирает никогда. Его atk тоже NaN, и первый
  // же монстр, которого он ударит, получает hp = NaN и становится неубиваемым
  // ДЛЯ ВСЕХ — один пакет снимает с игры мирового босса и башню войны гильдий.
  console.log('  ── ключ прототипу як клас ──');
  const wasType = me.type, wasHp = me.maxHp, wasAtk = me.atk;
  for (const key of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
    room.setPlayerChar(b.sock.id, key);
  }
  eq(me.type, wasType, 'клас не змінився на ключ прототипу');
  eq(me.maxHp, wasHp, 'maxHp той самий');
  eq(me.atk, wasAtk, 'atk той самий');
  ok(Number.isFinite(me.maxHp) && Number.isFinite(me.atk) &&
     Number.isFinite(me.def) && Number.isFinite(me.hp),
    `стати лишились числами (maxHp ${me.maxHp}, atk ${me.atk}, hp ${me.hp})`);
  // То, ради чего всё остальное: смертельный удар должен убивать. Именно это
  // сравнение и ломалось — не «мало урона», а бессмертие.
  ok(Math.max(0, me.hp - 1e9) <= 0,
    'смертельний удар доводить hp до нуля — NaN hp не задовольняє hp<=0 НІКОЛИ, і саме тому персонаж ставав безсмертним');

  // Тот же ключ, но со стороны базы: `CHAR_DEF[x] || CHAR_DEF.lev` читается как
  // запасной вариант и им не был — `||` не срабатывает ровно для тех значений,
  // ради которых он написан.
  const statsRepo = require('../server/db/repos/stats');
  const badSt = statsRepo.compute({ ...(await statsRepo.load(null, a.pid)), char_class: 'constructor' });
  ok(Number.isFinite(badSt.atk) && Number.isFinite(badSt.def) && Number.isFinite(badSt.maxHp),
    `stats.compute падає на 'lev' замість NaN (atk ${badSt.atk}, maxHp ${badSt.maxHp})`);

  // И последний барьер: даже если NaN придёт откуда-то ещё — из строки, где
  // миграция оставила null, из будущего изменения арифметики — в запись игрока
  // он не попадает.
  room.setPlayerStats(b.sock.id, {
    level: 40, atk: NaN, def: NaN, maxHp: NaN, critChance: NaN, critPower: NaN,
  });
  ok(Number.isFinite(me.atk) && Number.isFinite(me.maxHp) && me.atk === wasAtk,
    'setPlayerStats відмовляє нескінченним статам — один Number.isFinite на вході робить увесь цей клас помилок неможливим');

  // ── бюджет движения ───────────────────────────────────────────────────────
  // Guard'а в проде не было вовсе. Значение по умолчанию было 'log' — посчитать
  // перерасход, написать строку раз в 30 секунд и ВСЁ РАВНО применить ход, — а
  // MOVE_GUARD не выставлен ни в репозитории, ни в /srv/liberty/env дроплета.
  // Значит телепорт в любую точку этажа (на башню войны гильдий, на мирового
  // босса, из арены) и постоянный спидхак работали всё это время.
  //
  // Проверяется _mvRefused, а не только posCorrect: стена отвечает тем же
  // событием (handlers2/world.js), и без этого различия тест мог бы пройти на
  // совсем другой проверке. При MOVE_GUARD='log' счётчик остаётся нулём —
  // именно потому, что ход применялся.
  console.log('  ── бюджет руху ──');
  const far = alive().reduce((best, e) => {
    const d = Math.hypot(e.x - me.x, e.y - me.y);
    return d > best.d ? { e, d } : best;
  }, { e: null, d: 0 });
  ok(far.e && far.d > 1400,
    `є точка для стрибка (${Math.round(far.d)}px; відро тримає ~1386px руху)`);
  if (far.e) {
    const A = { x: me.x, y: me.y }, B = { x: far.e.x, y: far.e.y };
    me._mvRefused = 0;
    const corrected = once(b.sock, 'posCorrect', 6000).catch(() => null);
    // Двенадцать прыжков за ~300 мс: первый пакет сессии только заводит часы
    // бюджета (_mvAt), дальше каждый — перерасход, и на пятом за 3 секунды
    // guard обязан отказать. Метались туда-сюда между двумя ТОЧКАМИ, на
    // которых стоят монстры, то есть заведомо проходимыми — иначе отказала бы
    // проверка стены и мерялось бы не то.
    for (let i = 0; i < 12; i++) {
      const t = i % 2 ? A : B;
      b.sock.emit('mv', [Math.round(t.x * 2), Math.round(t.y * 2), 0, Math.round(me.hp), 1]);
      await wait(25);
    }
    const corr = await corrected;
    ok((me._mvRefused || 0) > 0,
      `сервер ВІДМОВИВ у русі (${me._mvRefused || 0} разів) — при MOVE_GUARD='log' тут нуль, бо хід застосовувався попри все`);
    ok(!!corr, 'і надіслав posCorrect — інакше клієнт лишився б там, куди сервер його ніколи не пустить');
    eq(corr && corr.reason, undefined, 'саме від бюджету руху, а не від стіни (у стіни reason: \'wall\')');
  }

  b.sock.disconnect(); w.sock.disconnect();
  await wait(200);
}

async function cleanup() {
  const q = (s, p) => pool().query(s, p).catch(() => {});
  if (made.length) {
    // Предметы — ТЕМИ Ж ДВЕРИМА, якими їх видали. Сирий DELETE лишав у
    // item_ledger видачу без рядків, і нічна звірка справедливо кричала
    // про розходження — 216 пар 27 серпня, усі до одної тестові.
    await wipeItemsAll(made);
    for (const t of ['player_skills', 'player_vip', 'player_prefs', 'player_daily',
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
