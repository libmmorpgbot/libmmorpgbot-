// ═══════════════════════════════════════════════════════════════════════════
//  prodfix-check.js — то, что сломалось в первые сутки продакшена
// ═══════════════════════════════════════════════════════════════════════════
//
//   node dev/prodfix-check.js
//
// Пять поломок, все найдены игроками, все с разными причинами. Проверка гоняет
// НАСТОЯЩИЙ код (Room.prototype._regenTick, dmgNum, clans.apply), а не свою
// копию формул — иначе она подтверждала бы себя, а не игру.
//
// Каждое утверждение перед фиксом обязано быть красным. Там, где это неочевидно,
// в комментарии сказано, каким именно значением оно падало ДО.
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (cond, name, got) => {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + name + (got !== undefined ? '  → ' + got : '')); }
};

// ── 1. Регенерация HP на сервере ───────────────────────────────────────────
// Её не было вовсе: hpRegen считался и не читался, а клиент лечился сам. Две
// стороны расходились на всё вылеченное за сессию, и убивало по серверной —
// «многие с фулл хп падают», «оставалось 985 hp».
console.log('\n  ── регенерация HP считается сервером ──');
{
  const Room = require(path.join(ROOT, 'server/game/Room.js'));
  const RoomClass = Room.Room || Room;
  const regen = RoomClass.prototype && RoomClass.prototype._regenTick;
  ok(typeof regen === 'function', 'Room._regenTick существует');

  if (typeof regen === 'function') {
    const sent = [];
    const io = { to: (sid) => ({ emit: (ev, p) => sent.push({ sid, ev, p }) }) };
    const room = { io };

    // Раненый игрок с обычным для 30-го уровня реgenerом.
    const p = { socketId: 's1', hp: 500, maxHp: 3000, hpRegen: 2.5 };
    // Секунда игры сорока тиками — ровно так, как её проходит _tick.
    let now = 1000;
    for (let i = 0; i < 40; i++) { now += 25; regen.call(room, p, 0.025, now); }
    // 500 + 2.5 * 1с = 502.5. До фикса: ровно 500, вечно.
    ok(Math.abs(p.hp - 502.5) < 0.01, 'за секунду прибавилось hpRegen', p.hp);
    ok(sent.length === 1 && sent[0].ev === 'hpSync' && sent[0].sid === 's1',
      'ровно одна поправка hpSync в секунду, только владельцу',
      sent.length + ' шт: ' + JSON.stringify(sent.map(x => x.ev)));

    // Полное HP не тикает и не шлёт ничего: иначе это пакет в секунду на
    // каждого, кто просто стоит в хабе.
    const full = { socketId: 's2', hp: 3000, maxHp: 3000, hpRegen: 2.5 };
    const before = sent.length;
    for (let i = 0; i < 40; i++) { now += 25; regen.call(room, full, 0.025, now); }
    ok(sent.length === before, 'на полном HP не шлётся ничего', sent.length - before);

    // Мёртвый не регенерирует — иначе труп встаёт сам.
    const dead = { socketId: 's3', hp: 0, maxHp: 3000, hpRegen: 5 };
    for (let i = 0; i < 40; i++) { now += 25; regen.call(room, dead, 0.025, now); }
    ok(dead.hp === 0, 'мёртвый не лечится', dead.hp);

    // hpRegen ещё не проставлен (setPlayerStats не успел). `undefined * dt` —
    // это NaN, а NaN в hp поглощающий: все `hp <= 0` становятся ложными и
    // игрок делается БЕССМЕРТНЫМ, а не просто нелечащимся.
    const raw = { socketId: 's4', hp: 100, maxHp: 3000 };
    for (let i = 0; i < 40; i++) { now += 25; regen.call(room, raw, 0.025, now); }
    ok(raw.hp === 100 && Number.isFinite(raw.hp), 'без hpRegen HP не превращается в NaN', raw.hp);

    // Верхняя граница — maxHp, и в момент заполнения уходит последняя поправка,
    // иначе стороны замирают в паре очков друг от друга навсегда.
    const nearly = { socketId: 's5', hp: 2999, maxHp: 3000, hpRegen: 100 };
    const b2 = sent.length;
    now += 25; regen.call(room, nearly, 0.025, now);
    ok(nearly.hp === 3000, 'не перелечивает выше maxHp', nearly.hp);
    ok(sent.length === b2 + 1, 'в момент заполнения полосы уходит поправка', sent.length - b2);
  }

  // И что тик её действительно зовёт — метод, который никто не вызывает, это
  // ровно то, чем был syncPlayerHp.
  const src = require('fs').readFileSync(path.join(ROOT, 'server/game/Room.js'), 'utf8');
  ok(/this\._regenTick\(p, dt, now\)/.test(src), '_tick вызывает _regenTick');
}

// ── 2. Клиент принимает поправку ───────────────────────────────────────────
console.log('\n  ── клиент принимает hpSync ──');
{
  const net = require('fs').readFileSync(path.join(ROOT, 'js/network.js'), 'utf8');
  ok(/socket\.on\('hpSync'/.test(net), 'обработчик hpSync зарегистрирован');
  // Не через playerHurt: тот ставит красную вспышку на каждую поправку.
  const h = net.slice(net.indexOf("socket.on('hpSync'"), net.indexOf("socket.on('hpSync'") + 700);
  ok(!/hurtTimer/.test(h), 'поправка не мигает уроном');
  ok(/player\.maxHp/.test(h), 'поправка ограничена собственным maxHp');
}

// ── 3. Заявка в клан — аргументы стояли наоборот ───────────────────────────
// clans.apply(db, playerId, clanId) звался как apply(t, clanId, playerId), и в
// clan_applications.clan_id уходил id игрока: «violates foreign key constraint
// clan_applications_clan_id_fkey» на каждой попытке вступить.
console.log('\n  ── вступление в клан ──');
{
  const clans = require(path.join(ROOT, 'server/db/repos/clans.js'));
  const seen = [];
  // Подставной db: ловим то, что уйдёт в INSERT, вместо базы. lockPlayer
  // требует, чтобы строка игрока НАШЛАСЬ, иначе бросает «no player» — так что
  // на его SELECT надо ответить строкой, а не пустотой.
  const db = {
    query: async (sql, args) => {
      seen.push({ sql, args });
      if (/FROM players WHERE id = \$1 FOR UPDATE/i.test(sql)) return { rows: [{ id: args[0] }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  };
  const PLAYER = 4242, CLAN = 7;
  clans.apply(db, PLAYER, CLAN).then(() => {
    const ins = seen.find(q => /INSERT INTO clan_applications/i.test(q.sql));
    ok(!!ins, 'заявка вставляется');
    // $1 = clan_id, $2 = player_id — порядок колонок в самом INSERT.
    ok(ins && ins.args[0] === CLAN && ins.args[1] === PLAYER,
      'clan_id — это клан, player_id — это игрок',
      ins && JSON.stringify(ins.args));
    // Порядок блокировок: строка ИГРОКА раньше клана. Обратный порядок и есть
    // тот цикл, который PostgreSQL убивал как «deadlock detected» в killReward.
    const lockAt = seen.findIndex(q => /FROM players WHERE id = \$1 FOR UPDATE/i.test(q.sql));
    ok(lockAt === 0, 'строка игрока блокируется первой', lockAt);
    step4();
  }).catch(e => { ok(false, 'apply не упал', e.message); step4(); });
}

function step4() {
  // ── 4. Порядок блокировок в accept ───────────────────────────────────────
  console.log('\n  ── порядок блокировок клан/игрок ──');
  {
    const src = require('fs').readFileSync(path.join(ROOT, 'server/db/repos/clans.js'), 'utf8');
    const body = src.slice(src.indexOf('async function accept('));
    // ВЫЗОВЫ, а не упоминания: первый заход искал просто '_requireLeader' и
    // нашёл его в комментарии, который эту самую блокировку объясняет — то
    // есть объявил исправленный код сломанным.
    const lockPlayer = body.indexOf('await items.lockPlayer(');
    const lockClan   = body.indexOf('await _requireLeader(');
    ok(lockPlayer >= 0 && lockClan >= 0 && lockPlayer < lockClan,
      'accept берёт игрока раньше клана', `игрок@${lockPlayer} клан@${lockClan}`);

    // И killReward должен идти в ту же сторону, иначе фикс односторонний.
    const cons = require('fs').readFileSync(path.join(ROOT, 'server/db/repos/consumables.js'), 'utf8');
    const g = cons.slice(cons.indexOf('async function grantKillReward('));
    const gEnd = g.indexOf('\n}\n');
    const gp = g.slice(0, gEnd > 0 ? gEnd : 4000);
    ok(gp.indexOf('items.lockPlayer') < gp.indexOf('clans.addXp'),
      'killReward тоже: игрок раньше клана');
  }

  // ── 5. Цвета всплывающих цифр ────────────────────────────────────────────
  console.log('\n  ── читаемость цифр ──');
  {
    // Загружаем particles.js в свою область: файл — часть общего бандла, у него
    // нет module.exports.
    const fs = require('fs');
    const vm = require('vm');
    const src = fs.readFileSync(path.join(ROOT, 'js/particles.js'), 'utf8');
    const ctx = { dmgNums: [], particles: [], Math, console, Map, Number, String, isNaN, parseInt };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(src, ctx, { filename: 'particles.js' });

    const luma = (hex) => {
      const n = parseInt(hex.slice(1).length === 3
        ? hex.slice(1).split('').map(c => c + c).join('') : hex.slice(1), 16);
      return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    };

    // Порог, а не список: любой цвет, который прилетит в dmgNum, обязан выйти
    // читаемым. Ниже — те, что реально стояли в коде и на которые жаловались.
    const было = ['#ff8c00', '#4af', '#5dade2', '#00e5ff', '#88f', '#7fd7ff', '#4fd67a', '#c4838a'];
    let худший = 1;
    for (const c of было) {
      ctx.dmgNums.length = 0;
      ctx.dmgNum(0, 0, '123', c);
      const out = ctx.dmgNums[0].color;
      худший = Math.min(худший, luma(out));
    }
    ok(худший >= 0.775, 'ни один цвет не темнее порога', 'самый тёмный: ' + худший.toFixed(3));

    // Контроль: исходные цвета ДОЛЖНЫ быть ниже порога, иначе проверка выше
    // зелёная просто потому, что ей нечего исправлять. Оранжевый 0.62, синий
    // 0.59 — оба заметно ниже 0.78.
    ok(luma('#ff8c00') < 0.78 && luma('#4af') < 0.78,
      'контроль: исходные оранжевый и синий действительно ниже порога',
      `#ff8c00=${luma('#ff8c00').toFixed(3)} #4af=${luma('#4af').toFixed(3)}`);

    // Тон сохраняется: зелёное остаётся зелёным, а не белеет.
    ctx.dmgNums.length = 0;
    ctx.dmgNum(0, 0, '1', '#4fd67a');
    const gh = ctx.dmgNums[0].color;
    const gn = parseInt(gh.slice(1), 16);
    ok(((gn >> 8) & 255) > ((gn >> 16) & 255) && ((gn >> 8) & 255) > (gn & 255),
      'зелёный остаётся зелёным', gh);

    // Крит и синева убраны из мест вызова явно.
    const net = fs.readFileSync(path.join(ROOT, 'js/network.js'), 'utf8');
    ok(!/#ff8c00/.test(net), 'оранжевого крита в бою больше нет');
    ok(!/'#4af'|'#00e5ff'|'#5dade2'|'#88f'/.test(net), 'синих цифр в бою больше нет');
    const game = fs.readFileSync(path.join(ROOT, 'js/game.js'), 'utf8');
    ok(!/dmgNum\([^)]*'#7fd7ff'/.test(game), 'синих подписей коридоров больше нет');
  }

  // ── 6. Топы ──────────────────────────────────────────────────────────────
  console.log('\n  ── топы отдают те поля, которые читает панель ──');
  {
    const fs = require('fs');
    const srv = fs.readFileSync(path.join(ROOT, 'server/handlers2/progression.js'), 'utf8');
    const h = srv.slice(srv.indexOf("safeOn('getRating'"), srv.indexOf("safeOn('getRating'") + 3000);
    const ui = fs.readFileSync(path.join(ROOT, 'js/ui.js'), 'utf8');
    const body = ui.slice(ui.indexOf('function _renderRatingBody'), ui.indexOf('function _renderRatingBody') + 3000);

    // Панель читает r.level — сервер отдавал pr.lvl, отсюда «Ур. 1» у всех.
    ok(/r\.level/.test(body), 'контроль: панель читает r.level');
    ok(/pr\.lvl AS level/.test(h), 'сервер отдаёт level');
    ok(/"memberCount"/.test(h) && /"totalBm"/.test(h), 'сервер отдаёт memberCount и totalBm');
    ok(/r\.memberCount/.test(body) && /r\.totalBm/.test(body), 'контроль: панель читает именно их');
    ok(/isSelf: true/.test(h) && /gap: true/.test(h), 'своя строка вне полусотни отправляется');
    ok(/ORDER BY "totalBm" DESC/.test(h), 'кланы ранжируются по сумме БМ участников');
  }

  // ── 7. Кадр не падает на пустой карте ────────────────────────────────────
  console.log('\n  ── clampCamera на пустой карте ──');
  {
    const fs = require('fs');
    const game = fs.readFileSync(path.join(ROOT, 'js/game.js'), 'utf8');
    const fn = game.slice(game.indexOf('function clampCamera()'), game.indexOf('function clampCamera()') + 400);
    const guard = fn.indexOf('if (!dungeon) return;');
    const use = fn.indexOf('dungeon.w');
    ok(guard >= 0 && guard < use, 'проверка стоит ДО обращения к dungeon.w',
      `guard@${guard} use@${use}`);
  }

  // ── 8. Шум не будит, но остаётся в журнале ───────────────────────────────
  console.log('\n  ── фильтр алертов ──');
  {
    const fs = require('fs');
    const app = fs.readFileSync(path.join(ROOT, 'server/app.js'), 'utf8');
    for (const s of ['ResizeObserver loop', 'admin:api', 'unexpected (end of input', 'контекст терял']) {
      ok(app.includes(s), 'заглушено: ' + s);
    }
    // Журнал пишется РАНЬШЕ проверки на шум — заглушить алерт и стереть след
    // это разные вещи.
    const hh = app.slice(app.indexOf("safeOn('clientError'"), app.indexOf("safeOn('clientError'") + 1600);
    const plogAt = hh.indexOf('plog.log');
    const noiseAt = hh.indexOf('_isClientNoise');
    ok(plogAt >= 0 && noiseAt >= 0 && plogAt < noiseAt,
      'в журнал пишется даже то, что не пошло в Telegram', `plog@${plogAt} noise@${noiseAt}`);
  }

  // ── 9. Обновление выбрасывает на новую версию ────────────────────────────
  console.log('\n  ── принудительная перезагрузка при обновлении ──');
  {
    const fs = require('fs');
    const app = fs.readFileSync(path.join(ROOT, 'server/app.js'), 'utf8');
    const sd = app.slice(app.indexOf('async function shutdown('));
    const emitAt = sd.indexOf("io.emit('forceReload'");
    // Вызов, а не упоминание: первый заход нашёл 'server.close()' внутри
    // комментария, который сам же объясняет, почему emit стоит ДО него.
    const closeAt = sd.search(/\n\s*server\.close\(\);/);
    ok(emitAt >= 0 && emitAt < closeAt, 'сказано ДО закрытия сервера, пока сокеты живы',
      `emit@${emitAt} close@${closeAt}`);
    const net = fs.readFileSync(path.join(ROOT, 'js/network.js'), 'utf8');
    const fr = net.slice(net.indexOf("socket.on('forceReload'"), net.indexOf("socket.on('forceReload'") + 1800);
    ok(/\/health/.test(fr), 'клиент ждёт, пока сервер снова ответит, а не грузит мёртвый порт');
    ok(/Math\.random\(\)/.test(fr), 'возврат разнесён во времени');
  }

  console.log('');
  if (fail === 0) console.log(`  \x1b[32m${pass} пройшло, 0 впало\x1b[0m\n`);
  else console.log(`  \x1b[31m${pass} пройшло, ${fail} впало\x1b[0m\n`);
  process.exit(fail === 0 ? 0 : 1);
}
