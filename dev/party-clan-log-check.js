#!/usr/bin/env node
'use strict';
// ── Три жалобы одного вечера ────────────────────────────────────────────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/party-clan-log-check.js
//
// 1. «Опыт идет всем членам пати на всю локу… один в городе стоит, другой в
//    локе бьёт и опыт идёт»
//
//    Условием было «в той же комнате», а комната — это ВЕСЬ этаж. Правило
//    близости у комнаты есть и работает (arePlayersNear: одна ветка карты и
//    радиус PARTY_SHARE_R2) — им пользуется хил группы. Награда за убийство
//    его не спрашивала.
//
// 2. «В клан людей принять не могут, плашка не кликабельна»
//
//    Кнопка была исправна. В базе за полсуток 85 отказов clanApprove против
//    5 успехов, причина одна: «Гравець уже в іншому клані» ×99. Заявка
//    подаётся в сколько угодно кланов сразу (alrak7 подал в 18 за тринадцать
//    секунд); первый принявший забирает игрока, остальные семнадцать заявок
//    висят вечно, и каждое нажатие их лидеров — отказ.
//
// 3. «Логи вообще непонятные, так и база задохнётся»
//
//    За два часа 236 189 строк, из них 225 223 — killReward, killRewardShare и
//    skillHeal. 2.8 миллиона в сутки. И ни одна из них ничего не отвечает:
//    монеты с убийства лежат в ledger, предметы — в item_ledger, обе сводятся
//    звёркой и переживают удаление партиций.
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const { pool, close, tx } = require('../server/db');
const clans = require('../server/db/repos/clans');
const players = require('../server/db/repos/players');

let pass = 0, fail = 0;
const ok = (c, name, got) => {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + name); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m  ' + name + (got !== undefined ? ' — ' + got : '')); }
};
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);

const TAG = 'pcl' + String(process.pid).slice(-5);
const made = [];

async function mk(nick) {
  const tg = String(984000000 + made.length * 7 + (process.pid % 10000));
  const r = await players.ensure(null, tg, TAG + nick);
  const id = Number(r.id || r.playerId || r);
  made.push(id);
  return id;
}

(async () => {
  // ═══ 1. Опыт делится только с теми, кто рядом ═══════════════════════════
  console.log('\n  ── доля группы: только те, кто рядом ──');
  {
    const Room = require(path.join(ROOT, 'server/game/Room.js'));
    const RoomClass = Room.Room || Room;
    const near = RoomClass.prototype.arePlayersNear;
    ok(typeof near === 'function', 'у комнаты есть правило близости');

    // Тот же отбор, что в handlers2/world.js, но на заглушке: важно, что он
    // спрашивает arePlayersNear, а не только «в этой же комнате».
    const src = fs.readFileSync(path.join(ROOT, 'server/handlers2/world.js'), 'utf8');
    const pick = src.slice(src.indexOf('const mates = members'), src.indexOf('const share = mates.length'));
    ok(/arePlayersNear\(s\.socket\.id, id\)/.test(pick),
      'отбор соратников спрашивает близость');
    ok(/players\.has\(id\)/.test(pick), 'и по-прежнему требует ту же комнату');
    // Делитель обязан считаться ПОСЛЕ отбора, иначе стоящий в городе всё равно
    // уменьшает долю тех, кто дерётся.
    ok(src.indexOf('const mates = members') < src.indexOf('const share = mates.length'),
      'делитель считается после отбора, а не до');

    // И само правило: рядом — да, через полкарты — нет.
    const room = {
      players: new Map([
        ['a', { x: 1000, y: 1000 }],
        ['b', { x: 1040, y: 1000 }],   // рядом
        ['c', { x: 9000, y: 9000 }],   // в городе
      ]),
      _playerLaneKey: () => 'same',
    };
    ok(near.call(room, 'a', 'b') === true, 'стоящий рядом считается рядом');
    ok(near.call(room, 'a', 'c') === false, 'стоящий через полкарты — нет');
    // Разные ветки карты — тоже не рядом, даже если координаты близки.
    const room2 = {
      players: new Map([['a', { x: 1000, y: 1000 }], ['b', { x: 1010, y: 1000 }]]),
      _playerLaneKey: (p) => (p.x < 1005 ? 'left' : 'right'),
    };
    ok(near.call(room2, 'a', 'b') === false, 'разные ветки карты — не рядом');
  }

  // ═══ 2. Заявка снимается при вступлении ════════════════════════════════
  console.log('\n  ── заявки в кланы ──');
  {
    const leaderA = await mk('LA');
    const leaderB = await mk('LB');
    const joiner = await mk('J');
    // Золото на создание — create() его списывает.
    const money = require('../server/db/repos/money');
    for (const id of [leaderA, leaderB]) {
      await money.credit(null, id, 'gold', 1000000, { reason: 'seed', idemKey: `${TAG}:${id}` });
    }
    const cA = await tx(t => clans.create(t, leaderA, TAG + 'A', 1));
    const cB = await tx(t => clans.create(t, leaderB, TAG + 'B', 1));

    // Заявка в оба сразу — ровно то, что делают игроки.
    await tx(t => clans.apply(t, joiner, cA.clanId));
    await tx(t => clans.apply(t, joiner, cB.clanId));
    const { rows: two } = await pool().query(
      'SELECT count(*)::int n FROM clan_applications WHERE player_id = $1', [joiner]);
    eq(two[0].n, 2, 'подано две заявки');

    // Первый лидер принимает.
    await tx(t => clans.accept(t, leaderA, cA.clanId, joiner));
    const { rows: left } = await pool().query(
      'SELECT count(*)::int n FROM clan_applications WHERE player_id = $1', [joiner]);
    // ДО исправления здесь оставалась одна: заявка в клан B висела вечно, и
    // лидер B получал «уже в іншому клані» на каждое нажатие.
    eq(left[0].n, 0, 'после вступления сняты ВСЕ его заявки, а не только одна');

    // И второй лидер такого заявителя вообще не видит.
    const viewB = await clans.dataView(null, cB.clanId, leaderB);
    eq(viewB.applications.length, 0, 'у второго лидера очередь пуста');

    // Отдельно — правило показа: даже если строка каким-то путём появилась,
    // лидер не видит того, кого принять невозможно.
    await pool().query(
      'INSERT INTO clan_applications (clan_id, player_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [cB.clanId, joiner]);
    const viewB2 = await clans.dataView(null, cB.clanId, leaderB);
    eq(viewB2.applications.length, 0,
      'заявка того, кто уже в клане, не показывается лидеру');
    // А обычная заявка — показывается, иначе проверка выше ничего не значит.
    const other = await mk('O');
    await tx(t => clans.apply(t, other, cB.clanId));
    const viewB3 = await clans.dataView(null, cB.clanId, leaderB);
    eq(viewB3.applications.length, 1, 'контроль: обычная заявка видна');
    ok(viewB3.applications[0].telegramId != null, 'и у неё есть telegramId для кнопки');

    // Создание клана тоже снимает чужие заявки.
    const founder = await mk('F');
    await money.credit(null, founder, 'gold', 1000000, { reason: 'seed', idemKey: `${TAG}:f` });
    await tx(t => clans.apply(t, founder, cB.clanId));
    await tx(t => clans.create(t, founder, TAG + 'C', 1));
    const { rows: f2 } = await pool().query(
      'SELECT count(*)::int n FROM clan_applications WHERE player_id = $1', [founder]);
    eq(f2[0].n, 0, 'создавший клан тоже не остаётся в чужих очередях');
  }

  // ═══ 2б. Порядок блокировок: строка игрока ПЕРВОЙ ══════════════════════
  // «deadlock detected» в usePotion и killReward одновременно, у одного игрока,
  // с точностью до секунды. detail из PostgreSQL назвал обе таблицы: players и
  // player_progress берутся в РАЗНОМ порядке.
  //
  // Правило записано в items.js: lockPlayer — первый оператор транзакции,
  // которая что-то меняет. Оно и есть весь порядок блокировок в проекте, и
  // одного нарушителя достаточно, чтобы цикл стал возможен для всех.
  console.log('\n  ── порядок блокировок ──');
  {
    const src = fs.readFileSync(path.join(ROOT, 'server/db/repos/consumables.js'), 'utf8');
    // Каждая изменяющая функция этого файла — и ни одного исключения.
    for (const fn of ['usePotion', 'useBuffPotion', 'buyTeleportStone',
                      'useTeleportStone', 'pickupDrop', 'grantKillReward']) {
      const at = src.indexOf(`async function ${fn}(`);
      const body = src.slice(at, src.indexOf('\nasync function ', at + 10));
      const lock = body.indexOf('items.lockPlayer(db, playerId)');
      // Первая запись в функции — по первому же слову-глаголу SQL. Пробелы и
      // переносы между `query(db,` и словом не считаются: запросы в этом файле
      // пишутся и в строку, и с переноса.
      const write = body.search(/await query\(db,[\s\S]{0,12}(UPDATE|INSERT|DELETE)/i);
      ok(lock >= 0, `${fn} берёт строку игрока`);
      ok(lock >= 0 && (write < 0 || lock < write),
        `${fn} берёт её ДО первой записи`, `lock@${lock} write@${write}`);
    }
  }

  // ═══ 2в. Очки сезона за заточку ════════════════════════════════════════
  // Таблица есть, экспортируется и показывается игроку в панели сезона — а
  // функция, которая по ней считает, не вызывалась НИГДЕ. Панель обещала
  // «Редкий: +20 очков», заточка проходила, очки не начислялись никогда:
  // «Сезон не работает, за заточку ниче не дают».
  console.log('\n  ── очки сезона за заточку ──');
  {
    const D = require('../shared/definitions');
    const eco = fs.readFileSync(path.join(ROOT, 'server/handlers2/economy.js'), 'utf8');
    const h = eco.slice(eco.indexOf("safeOn('enhanceItem'"), eco.indexOf("safeOn('enhanceItem'") + 4000);
    ok(/seasonEnhancePoints\(/.test(h), 'обработчик заточки считает очки');
    ok(/addSeasonPoints\(t, pid, _pts\)/.test(h), 'и начисляет их');
    // Слот и редкость — ИЗ КАТАЛОГА, а не из запроса: в запросе slot это
    // подсказка, где искать вещь, и клиент вправе прислать любую.
    ok(/_def\.slot, _def\.rarity/.test(h), 'слот и редкость берутся из каталога, а не из пакета');
    ok(h.indexOf('seasonEnhancePoints(') > h.indexOf("res.outcome === 'success'"),
      'очки только за УДАВШУЮСЯ заточку');

    // И числа те же, что показаны игроку: панель отдаёт свои значения из тех же
    // констант, что и начисление. Разойтись они могут только если кто-то
    // поменяет одну сторону.
    const shown = { special: D.SEASON_ENHANCE_SPECIAL_POINTS, gear: D.SEASON_ENHANCE_GEAR_POINTS };
    eq(D.seasonEnhancePoints('pet', 'common', 'norm'), shown.special.common.norm, 'питомец обычный, обычный камень');
    eq(D.seasonEnhancePoints('pet', 'common', 'bless'), shown.special.common.bless, 'питомец обычный, безопасный');
    eq(D.seasonEnhancePoints('cloak', 'rare', 'norm'), shown.special.rare.norm, 'плащ редкий, обычный камень');
    eq(D.seasonEnhancePoints('weapon', 'rare', 'norm'), shown.gear.rare, 'предмет редкий');
    eq(D.seasonEnhancePoints('weapon', 'epic', 'norm'), shown.gear.epic, 'предмет эпический');
    // Безопасный камень на обычной вещи очков не даёт — так в таблице.
    eq(D.seasonEnhancePoints('weapon', 'epic', 'bless'), 0, 'предмет безопасным камнем — без очков');
    eq(D.seasonEnhancePoints('weapon', 'common', 'norm'), 0, 'обычный предмет — без очков');
  }

  // ═══ 3. Журнал ═════════════════════════════════════════════════════════
  console.log('\n  ── журнал ──');
  {
    const ses = fs.readFileSync(path.join(ROOT, 'server/session.js'), 'utf8');
    const list = ses.slice(ses.indexOf('const WRITE_ACTIONS'), ses.indexOf(']);', ses.indexOf('const WRITE_ACTIONS')));
    for (const noisy of ['killReward', 'killRewardShare', 'skillHeal']) {
      ok(!new RegExp(`'${noisy}'`).test(list), `${noisy} больше не пишет строку на успех`);
    }
    // Контроль: то, что действительно двигает ценность, осталось.
    for (const keep of ['marketBuy', 'gramShopBuy', 'usePotion', 'pickupWorldDrop']) {
      ok(new RegExp(`'${keep}'`).test(list), `контроль: ${keep} по-прежнему пишется`);
    }

    // Свёртка повторяющихся отказов — на самом модуле.
    const plog = require('../server/db/repos/playerlog');
    const before = plog.stats ? plog.stats().queued : null;
    ok(before !== null, 'у журнала есть счётчики');
    const pid = made[0];
    for (let i = 0; i < 50; i++) plog.log(pid, 'refuse:test', { code: 'nope' });
    const after = plog.stats().queued - before;
    // Первый проходит, остальные сворачиваются в окно.
    ok(after === 1, 'пятьдесят одинаковых отказов дали одну строку', after);
    // Зелья сворачиваются тоже: удалить их нельзя (расход не записан больше
    // нигде), но 155 строк из 171 читать невозможно. Ответ «выпил 43 за
    // минуту» отвечает на тот же вопрос одной строкой.
    const b1 = plog.stats().queued;
    for (let i = 0; i < 40; i++) plog.log(pid, 'usePotion', { зелье: 'pt1' });
    eq(plog.stats().queued - b1, 1, 'сорок зелий подряд дали одну строку');

    // Покупки зелий — то же самое: 145 строк из 209 после первого сокращения.
    // Но РАЗНЫЕ зелья не сворачиваются вместе, иначе строка «купил 40» не
    // сказала бы, каких именно.
    const b1b = plog.stats().queued;
    for (let i = 0; i < 20; i++) plog.log(pid, 'buyPotion', { itemId: 'pt1', qty: 1 });
    for (let i = 0; i < 20; i++) plog.log(pid, 'buyPotion', { itemId: 'pt2', qty: 1 });
    eq(plog.stats().queued - b1b, 2, 'сорок покупок двух видов дали две строки');

    // А то, что двигает предмет или монету поштучно, не сворачивается НИКОГДА:
    // там вопрос всегда «какой именно и когда».
    const b2 = plog.stats().queued;
    for (let i = 0; i < 5; i++) plog.log(pid, 'marketBuy', { lot: i });
    eq(plog.stats().queued - b2, 5, 'покупки на рынке не сворачиваются');
    const b3 = plog.stats().queued;
    for (let i = 0; i < 5; i++) plog.log(pid, 'pickupWorldDrop', { n: i });
    eq(plog.stats().queued - b3, 5, 'подобранные предметы не сворачиваются');

    // И строка про зелье теперь что-то говорит — раньше в журнале стояло голое
    // «usePotion» без единой подробности.
    const it = fs.readFileSync(path.join(ROOT, 'server/handlers2/items.js'), 'utf8');
    const h = it.slice(it.indexOf("safeOn('usePotion'"), it.indexOf("safeOn('usePotion'") + 1400);
    ok(/зелье: r\.potionId/.test(h) && /вылечено: r\.healed/.test(h),
      'в журнал пишется какое зелье и на сколько вылечило');

    const wrk = fs.readFileSync(path.join(ROOT, 'server/workers.js'), 'utf8');
    ok(/drop_old_log_partitions\(2\)/.test(wrk), 'хранится два месяца, а не шесть');
  }

  // ═══ 4. Что видит оператор ═════════════════════════════════════════════
  // «Логи вообще непонятные: у меня 100 логов в админке последних, а там за
  // минуту 100 убийств монстров, каждый голд пишется с монстра. Обычно чисто
  // важные вещи были — маркет, деп, вывод, реф бонус, крафт, заточка.»
  //
  // Лента игрока склеивает player_logs с последними 80 строками ledger, и у
  // активного игрока эти восемьдесят — сплошной mob_kill.
  console.log('\n  ── лента в админке ──');
  {
    const adm = fs.readFileSync(path.join(ROOT, 'server/routes/admin2.js'), 'utf8');
    ok(adm.includes('NOT (reason = ANY($2))'), 'награда за убийство не попадает в ленту');
    ok(adm.includes("const NOISE = ['mob_kill', 'mob_drop']"), 'и это именно она, а не что попало');
    // Молча урезанная лента читается как «ничего не было».
    ok(adm.includes('fromMobs'), 'сколько скрыто — сказано отдельной строкой');
    // Из самого реестра ничего не удаляется: он остаётся полным.
    ok(!adm.includes('DELETE FROM ledger'), 'из реестра при этом ничего не удаляется');

    // Тестовые аккаунты проверок не показываются, но оператор может их увидеть.
    ok(adm.includes("p.telegram_id ~ '^[0-9]+$'"), 'в списке игроков только настоящие входы');
    ok(adm.includes("$4 = '1'"), 'и есть способ показать всех');
  }

  // ═══ 5. Рассылка ═══════════════════════════════════════════════════════
  // «Последняя фотка на 3 минуты запаздывает — и с Кровавой Башней, и ещё с
  // чем-то». Таймеры срабатывают вовремя; опаздывает сам проход: Telegram
  // принимает около тридцати сообщений в секунду, четыре тысячи адресатов —
  // это больше двух минут.
  console.log('\n  ── рассылка событий ──');
  {
    const md = fs.readFileSync(path.join(ROOT, 'server/modes.js'), 'utf8');
    const fn = md.slice(md.indexOf('async function tgBroadcastAll'), md.indexOf('function notifyEventSoon'));
    ok(fn.includes('NOT p.banned'), 'забаненные и тестовые аккаунты не занимают очередь');
    ok(fn.includes("p.telegram_id ~ '^[0-9]+$'"), 'и те, у кого id не число');
    ok(fn.includes('JOIN player_progress'), 'и те, кто ни разу не входил в игру');
    ok(fn.includes('ORDER BY pr.updated_at DESC'), 'первыми зовут тех, кто играет сейчас');

    // Предупреждение «за 30 минут» начинается раньше на длительность прохода —
    // иначе последний в очереди получает его за двадцать восемь.
    const SITES = ['server/game/arena3.js', 'server/game/death-battle.js',
                   'server/game/guildwar.js', 'server/game/race10.js', 'server/modes.js'];
    for (const f of SITES) {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
      const warn = src.match(/const warnIn = [^;]+;/);
      ok(!!warn && warn[0].includes('broadcastLeadMs()'),
        `${f.split('/').pop()}: предупреждение сдвинуто на длительность рассылки`,
        warn && warn[0]);
    }
  }

  // ── уборка ────────────────────────────────────────────────────────────────
  // Аккаунты, у которых есть строки в ledger, НЕ удаляются, и это не
  // недоделка: у liberty_app намеренно нет права DELETE на ledger — процесс,
  // который двигает деньги, не должен уметь стирать запись об этом. Внешний
  // ключ поэтому держит и самого игрока.
  //
  // Такие остаются с bm = 0, то есть ни в рейтинг (там `bm > 0`), ни в топ
  // кланов не попадают. Их видно по префиксу имени.
  //
  // И вся уборка — best-effort: она не имеет права уронить прогон уже
  // сделанных проверок. Прогон, упавший на уборке, печатает ошибку вместо
  // итога, а проверка без итога считается сломанной (dev/all-checks.sh).
  const swallow = async (sql, args) => {
    try { await pool().query(sql, args); } catch (e) { /* см. выше */ }
  };
  await swallow('DELETE FROM clan_applications WHERE player_id = ANY($1)', [made]);
  await swallow('DELETE FROM clan_members WHERE player_id = ANY($1)', [made]);
  await swallow('DELETE FROM clans WHERE name LIKE $1', [TAG + '%']);
  await swallow('DELETE FROM player_logs WHERE player_id = ANY($1)', [made]);
  await swallow('DELETE FROM player_progress WHERE player_id = ANY($1)', [made]);
  await swallow('DELETE FROM players WHERE id = ANY($1)', [made]);
  const { rows: rest } = await pool().query(
    'SELECT count(*)::int n FROM players WHERE id = ANY($1)', [made]);
  if (rest[0].n) {
    console.log(`  (осталось тестовых аккаунтов: ${rest[0].n} — у них есть строки` +
      ' в ledger, а стирать его приложению не положено)');
  }

  console.log('');
  console.log(fail === 0
    ? `  \x1b[32m${pass} пройшло, 0 впало\x1b[0m\n`
    : `  \x1b[31m${pass} пройшло, ${fail} впало\x1b[0m\n`);
  await close();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('  ОШИБКА: ' + e.message + '\n' + (e.stack || ''));
  await close().catch(() => {});
  process.exit(1);
});
