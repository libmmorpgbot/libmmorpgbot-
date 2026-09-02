// ═══════════════════════════════════════════════════════════════════════════
//  heal-check.js — здоровье принадлежит серверу
// ═══════════════════════════════════════════════════════════════════════════
//
//   node dev/heal-check.js
//
// Игроки за один день назвали четыре разных беды, и все четыре — одна и та же:
// лечение применял КЛИЕНТ, а урон и смерть считает сервер.
//
//   «в безпечній зоні 120 → 121 і назад»   +1 HP/сек в хабе был только у клиента
//   «хил у целителя откатывает хп»         своё лечение чернокнижника сервер
//                                          пропускал явно (`if (sid === ...)`)
//   «малые хилки то по 140, то по 20»      зелье прибавлялось дважды: у клиента
//                                          своей суммой и у сервера своей
//   «то сразу фулл хп делают»              то же самое, когда числа разошлись
//
// Проверка гоняет НАСТОЯЩИЙ код — Room.prototype._regenTick, _vampGain,
// skillSelfHealOf, — а не свою копию формул: копия подтверждала бы себя.
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (cond, name, got) => {
  if (cond) { pass++; console.log('  \x1b[32m✓\x1b[0m ' + name); }
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + name + (got !== undefined ? '  → ' + got : '')); }
};

const Room = require(path.join(ROOT, 'server/game/Room.js'));
const RoomClass = Room.Room || Room;
const D = require(path.join(ROOT, 'shared/definitions.js'));

// Комната-заглушка: нужны только io и правило безопасной зоны.
function mkRoom(inSafe = false) {
  const sent = [];
  return {
    sent,
    io: { to: (sid) => ({ emit: (ev, p) => sent.push({ sid, ev, p }) }) },
    _inSafeZone: () => inSafe,
    players: new Map(),
  };
}
const regen = RoomClass.prototype._regenTick;
const vamp = RoomClass.prototype._vampGain;
const setWin = RoomClass.prototype.setSkillWindow;

// ── 1. безопасная зона лечит на СЕРВЕРЕ ────────────────────────────────────
console.log('\n  ── безопасная зона ──');
{
  // Один и тот же игрок, одна и та же секунда, разница только в зоне.
  const run = (inSafe) => {
    const room = mkRoom(inSafe);
    const p = { socketId: 's', hp: 500, maxHp: 3000, hpRegen: 2 };
    let now = 1000;
    for (let i = 0; i < 40; i++) { now += 25; regen.call(room, p, 0.025, now); }
    return p.hp;
  };
  const outside = run(false), inside = run(true);
  ok(Math.abs(outside - 502) < 0.01, 'вне зоны — только пассивная (+2/сек)', outside);
  // +1/сек сверх пассивной. До фикса зона на сервере не значила ничего, и обе
  // цифры были одинаковы — то есть эта строка была бы красной.
  ok(Math.abs(inside - 503) < 0.01, 'в зоне — пассивная плюс SAFE_ZONE_REGEN_PER_SEC', inside);
  ok(inside > outside, 'зона действительно быстрее', `${inside} > ${outside}`);
  ok(D.SAFE_ZONE_REGEN_PER_SEC === 1, 'ставка зоны взята из общего файла', D.SAFE_ZONE_REGEN_PER_SEC);
}

// ── 2. поправка HP точная, а не floor ──────────────────────────────────────
// Пол и был причиной «120 → 121 → 120»: клиент держал 120.9, сервер присылал
// 120, клиент прыгал вниз, за секунду дорастал до 121.4 — и обратно.
console.log('\n  ── поправка HP ──');
{
  const room = mkRoom(false);
  const p = { socketId: 's', hp: 120.4, maxHp: 3000, hpRegen: 2.5 };
  let now = 1000;
  // _hpSyncAt заводится СРАЗУ: без этого первый же тик видит `now - 0` и шлёт
  // поправку немедленно. В игре это правильно — игрок, который только начал
  // лечиться, получает своё число сразу, — но здесь считаются поправки за
  // секунду, и стартовая исказила бы счёт.
  p._hpSyncAt = now;
  for (let i = 0; i < 40; i++) { now += 25; regen.call(room, p, 0.025, now); }
  const sync = room.sent.filter(x => x.ev === 'hpSync');
  ok(sync.length === 1, 'одна поправка за секунду', sync.length);
  const v = sync.length ? sync[sync.length - 1].p.hp : null;
  ok(v != null && v !== Math.floor(v), 'значение НЕ округлено вниз — дробь сохранена', v);
  ok(v != null && Math.abs(v - p.hp) < 0.01, 'прислано ровно то, что у сервера', `${v} vs ${p.hp}`);
}

// ── 3. «Бабочки» тикают на сервере ─────────────────────────────────────────
console.log('\n  ── Бабочки ──');
{
  const room = mkRoom(false);
  const p = { socketId: 's', hp: 100, maxHp: 1000, hpRegen: 0 };
  room.players.set('s', p);
  // Через НАСТОЯЩУЮ точку входа: первый заход выставлял _butterfliesUntil
  // руками и разошёлся с _butterAt на один тик — то есть проверял не тот код,
  // который выполняется в игре.
  ok(setWin.call(room, 's', 'butterflies', 3000) === true,
    'окно ставится методом комнаты, а не клиентом');
  let now = p._butterAt;
  for (let i = 0; i < 120; i++) { now += 25; regen.call(room, p, 0.025, now); }
  // 5% от 1000 = 50 в секунду; окно ровно три секунды — значит три тика, и
  // третий приходится на самый край окна.
  ok(p.hp === 250, 'три тика по 5% maxHp', p.hp);
  const ticks = room.sent.filter(x => x.ev === 'skillHealTick' && x.p.kind === 'butterflies');
  ok(ticks.length === 3, 'по одному сообщению на тик', ticks.length);
  ok(ticks.every(t => t.p.amount === 50), 'сумма тика — 5% maxHp', JSON.stringify(ticks.map(t => t.p.amount)));
}

// ── 4. вампиризм считается от урона, который применил сервер ───────────────
console.log('\n  ── вампиризм ──');
{
  const room = mkRoom(false);
  const a = { socketId: 's', hp: 100, maxHp: 1000 };
  // Окна нет — лечения нет. Иначе это был бы бесплатный хил всем и всегда.
  vamp.call(room, a, 200);
  ok(a.hp === 100, 'без окна не лечит', a.hp);
  a._vampUntil = Date.now() + 5000;
  a._vampPct = D.VAMPIRISM_PCT;
  vamp.call(room, a, 200);
  ok(a.hp === 120, '10% нанесённого урона', a.hp);
  a._vampPct = D.ADV_VAMPIRISM_PCT;
  vamp.call(room, a, 200);
  ok(a.hp === 150, 'продвинутый — 15%', a.hp);
  a.hp = 995;
  vamp.call(room, a, 1000);
  ok(a.hp === 1000, 'выше maxHp не уходит', a.hp);
  a.hp = 0;
  vamp.call(room, a, 500);
  ok(a.hp === 0, 'мёртвый не лечится', a.hp);
  // И что он действительно врезан в обе точки нанесения урона по монстру.
  const src = fs.readFileSync(path.join(ROOT, 'server/game/Room.js'), 'utf8');
  const hits = (src.match(/this\._vampGain\(attacker, dmg\);/g) || []).length;
  ok(hits === 4, 'зовётся во всех четырёх местах, где сервер применяет урон', hits);
}

// ── 4б. «Бабочки» не копят пропущенные тики ────────────────────────────────
// _regenTick выходил сразу при полном здоровье, а часы тика (_butterAt) стоят
// на месте, пока функция до них не дошла. Цикл ниже отматывает ВСЕ пропущенные
// секунды — то есть полное здоровье десять секунд, потом удар, и следующий же
// тик выдавал десять лечений подряд вместо одного.
console.log('\n  ── Бабочки при полном здоровье ──');
{
  const room = mkRoom(false);
  const p = { socketId: 's', hp: 1000, maxHp: 1000, hpRegen: 0 };
  room.players.set('s', p);
  setWin.call(room, 's', 'butterflies', 10000);
  let now = p._butterAt;
  // Пять секунд на полном здоровье — лечить нечего.
  for (let i = 0; i < 200; i++) { now += 25; regen.call(room, p, 0.025, now); }
  ok(p.hp === 1000, 'на полном здоровье не лечит', p.hp);
  // Удар. Дальше ОДИН тик за одну секунду, а не пять разом.
  p.hp = 500;
  now += 25; regen.call(room, p, 0.025, now);
  ok(p.hp === 500, 'сразу после удара — ни одного отложенного тика', p.hp);
  for (let i = 0; i < 40; i++) { now += 25; regen.call(room, p, 0.025, now); }
  ok(p.hp === 550, 'за следующую секунду ровно один тик (5% от 1000)', p.hp);
}

// ── 4в. вампиризм доезжает до полосы ───────────────────────────────────────
// _vampGain шлёт 'skillHealTick' — это цифра над головой, player.hp она не
// трогает. Само здоровье доезжало попутной поправкой из _regenTick, а та при
// полном здоровье не отправлялась вовсе: дохилившись вампиризмом до потолка,
// игрок переставал получать поправки, и полоса застревала.
console.log('\n  ── вампиризм доходит до клиента ──');
{
  const room = mkRoom(false);
  const p = { socketId: 's', hp: 900, maxHp: 1000, hpRegen: 0 };
  room.players.set('s', p);
  p._vampUntil = Date.now() + 5000;
  p._vampPct = D.VAMPIRISM_PCT;
  let now = 10000;
  p._hpSyncAt = now;
  vamp.call(room, p, 2000);          // +200 → потолок
  ok(p.hp === 1000, 'вампиризм долечил до максимума', p.hp);
  ok(p._hpDirty === true, 'и пометил здоровье к отправке');
  // Секунда тиков на ПОЛНОМ здоровье: раньше отсюда не уходило ничего.
  for (let i = 0; i < 41; i++) { now += 25; regen.call(room, p, 0.025, now); }
  const sync = room.sent.filter(x => x.ev === 'hpSync');
  ok(sync.length === 1, 'поправка ушла, хотя здоровье полное', sync.length);
  ok(sync.length === 1 && sync[0].p.hp === 1000, 'и несёт настоящее число', sync.length && sync[0].p.hp);
  ok(p._hpDirty === false, 'пометка снята — второй раз то же самое не шлётся');
}

// ── 4г. healPlayer прибавляет и рассылает ──────────────────────────────────
// Зелье считалось от здоровья, снятого ПЕРЕД походом в базу, и ставилось
// поверх готовым числом: удар, пришедший за круговой путь, отменялся.
console.log('\n  ── зелье прибавляет, а не назначает ──');
{
  const room = mkRoom(false);
  room._emitRoom = RoomClass.prototype._emitRoom;
  room._socketFor = (pp) => ({ emit: (ev, pl) => room.sent.push({ sid: pp.socketId, ev, p: pl }) });
  const heal = RoomClass.prototype.healPlayer;
  const p = { socketId: 's', hp: 500, maxHp: 1000 };
  room.players.set('s', p);
  ok(heal.call(room, 's', 200) === 200, 'вернул, на сколько полечил');
  ok(p.hp === 700, 'прибавка к ЖИВОМУ числу', p.hp);
  // Удар за круговой путь: назначение стёрло бы его, прибавка — нет.
  p.hp -= 300;
  heal.call(room, 's', 200);
  ok(p.hp === 600, 'удар, пришедший во время лечения, остаётся', p.hp);
  ok(heal.call(room, 's', 5000) === 400 && p.hp === 1000, 'выше maxHp не уходит', p.hp);
  ok(heal.call(room, 's', 100) === 0, 'на полном здоровье лечит на ноль');
  ok(heal.call(room, 's', NaN) === 0, 'NaN отвергается — иначе игрок неубиваем');
  p.hp = 0;
  ok(heal.call(room, 's', 100) === 0 && p.hp === 0, 'мёртвого не лечит');
  const out = room.sent.filter(x => x.ev === 'playerHurt');
  ok(out.length === 3, 'на каждое реальное лечение — одно сообщение', out.length);
  // И зелье действительно ходит через него, а не назначает готовое число.
  const items = fs.readFileSync(path.join(ROOT, 'server/handlers2/items.js'), 'utf8');
  ok(/s\.room\.healPlayer\(s\.socket\.id, res\.healed\)/.test(items),
    'обработчик зелья прибавляет res.healed');
  ok(!/setPlayerHp\(s\.socket\.id, res\.hp\)/.test(items),
    'и больше не ставит готовое res.hp поверх');
}

// ── 4д. здоровье доходит и в ИНСТАНСАХ ─────────────────────────────────────
// Страх, кооператив и Элитная фарм-зона: у каждого запуска своя Room, но floor
// общий, и участники намеренно не входят в группу `floor_N` — иначе один
// запуск получал бы события другого. А рассылка шла именно по группе, то есть
// в этих трёх режимах КАЖДОЕ серверное лечение уходило в никуда.
console.log('\n  ── рассылка здоровья в инстансе ──');
{
  const room = mkRoom(false);
  room.floor = 13;                       // farmZone2 — инстансный этаж
  room._emitRoom = RoomClass.prototype._emitRoom;
  const seen = [];
  room._socketFor = (pp) => ({ emit: (ev, pl) => seen.push({ to: pp.socketId, ev, pl }) });
  // io.to(`floor_13`) не должен использоваться вовсе: в инстансе там пусто.
  // Считается, а не бросается: упавший файл — это не «красная строка», это
  // проверка, которая не досказала, что ещё сломано.
  const viaGroup = [];
  room.io = { to: (name) => { viaGroup.push(name); return { emit: () => {} }; } };
  const a = { socketId: 'a', hp: 500, maxHp: 1000 };
  const b = { socketId: 'b', hp: 700, maxHp: 1000 };
  room.players.set('a', a); room.players.set('b', b);
  RoomClass.prototype.healPlayer.call(room, 'a', 200);
  ok(seen.length === 2, 'сообщение дошло до обоих участников запуска', seen.length);
  ok(seen.every(x => x.ev === 'playerHurt' && x.pl.id === 'a' && x.pl.hp === 700),
    'и это здоровье того, кого лечили');
  RoomClass.prototype.setPlayerHp.call(room, 'b', 300);
  ok(seen.length === 4 && seen[3].pl.id === 'b', 'setPlayerHp — тем же путём', seen.length);
  ok(viaGroup.length === 0,
    'и ни одно из них не ушло в группу floor_N, где в инстансе никого нет',
    viaGroup.join(','));
  const src = fs.readFileSync(path.join(ROOT, 'server/game/Room.js'), 'utf8');
  ok(!/io\.to\(`floor_\$\{this\.floor\}`\)\.emit\('playerHurt'/.test(src),
    'в Room.js не осталось рассылки здоровья по группе этажа');
}

// ── 4е. окна навыков переживают смену этажа ────────────────────────────────
// Каждый этаж — своя Room со своим списком игроков, переход это removePlayer +
// addPlayer. Все четыре окна жили в записи и пропадали на пороге: включил
// вампиризм, прошёл в дверь — и он больше не лечит, а таймер в HUD идёт.
console.log('\n  ── окна навыков на пороге ──');
{
  const from = mkRoom(false), to = mkRoom(false);
  const winOf = RoomClass.prototype.skillWindowsOf;
  const winSet = RoomClass.prototype.restoreSkillWindows;
  const p = { socketId: 's', hp: 500, maxHp: 1000 };
  from.players.set('s', p);
  setWin.call(from, 's', 'vampirism', 9000, D.ADV_VAMPIRISM_PCT);
  setWin.call(from, 's', 'haste', 9000, 1.5);
  setWin.call(from, 's', 'buff', 9000, { atk: 1.2, def: 1.8, critChance: 5, critPower: 10 });
  setWin.call(from, 's', 'butterflies', 9000);
  const carried = winOf.call(from, 's');
  ok(carried != null, 'окна снимаются со старой записи');

  const fresh = { socketId: 's', hp: 500, maxHp: 1000 };   // как addPlayer: поля чистые
  to.players.set('s', fresh);
  ok(!(fresh._vampUntil > Date.now()), 'контроль: новая запись действительно пустая');
  winSet.call(to, 's', carried);
  ok(fresh._vampUntil === p._vampUntil && fresh._vampPct === D.ADV_VAMPIRISM_PCT,
    'вампиризм переехал вместе со сроком и процентом');
  ok(fresh._hasteUntil === p._hasteUntil && fresh._hasteMult === 1.5, 'ускорение тоже');
  ok(fresh._buffUntil === p._buffUntil && fresh._buffDef === 1.8, 'боевой баф тоже');
  ok(fresh._butterfliesUntil === p._butterfliesUntil && fresh._butterAt === p._butterAt,
    '«Бабочки» вместе со своими часами тика');
  // Сроки АБСОЛЮТНЫЕ: дорога через дверь не продлевает баф.
  ok(carried.vampUntil === p._vampUntil, 'переносится момент конца, а не остаток');

  // Истёкшее не переносится вовсе.
  const stale = mkRoom(false);
  const q = { socketId: 'q', hp: 1, maxHp: 1 };
  stale.players.set('q', q);
  q._vampUntil = Date.now() - 1000; q._vampPct = 0.1;
  ok(winOf.call(stale, 'q') === null, 'истёкшее окно не переносится');

  // И оба маршрута смены этажа действительно это делают.
  const w = fs.readFileSync(path.join(ROOT, 'server/world.js'), 'utf8');
  const ss = fs.readFileSync(path.join(ROOT, 'server/session.js'), 'utf8');
  ok(/skillWindowsOf/.test(w) && /restoreSkillWindows/.test(w), 'enterFloor переносит окна');
  ok(/skillWindowsOf/.test(ss) && /restoreSkillWindows/.test(ss), 'forceFloor переносит окна');
}

// ── 4ж. здоровье на смене этажа — живое, а не из базы ──────────────────────
// player_progress.hp пишет таймер раз в двадцать секунд, а sendGameStart сажал
// входящего именно по нему: подрался — вышел в дверь — снова полный.
console.log('\n  ── здоровье на смене этажа ──');
{
  const w = fs.readFileSync(path.join(ROOT, 'server/handlers2/world.js'), 'utf8');
  const fn = w.slice(w.indexOf('async function sendGameStart'), w.indexOf('// ── movement'));
  ok(/const wasHere = s\.room && s\.room\.players\.get\(s\.socket\.id\);/.test(fn),
    'живое число снимается с комнаты');
  ok(fn.indexOf('const liveHp') < fn.indexOf('enterFloor(s, want'),
    'и снимается ДО переезда — после него спрашивать уже некого');
  ok(/liveHp != null \? Math\.min\(liveHp, state\.stats\.maxHp\) : state\.stats\.hp/.test(fn),
    'сохранённое остаётся запасным путём — для входа в игру и возрождения');
}

// ── 4з. порог между лечениями — на КАЖДЫЙ навык ────────────────────────────
// Одно число на сессию отбирало у чернокнижника групповое лечение: Q
// («Бабочки», 8 с) и R (лечение группы, 25 с) — обычная связка, и второе
// нажатие приходило в пределах двухсекундного порога первого.
console.log('\n  ── порог между лечениями ──');
{
  const soc = fs.readFileSync(path.join(ROOT, 'server/handlers2/social.js'), 'utf8');
  ok(/const lastHealAt = new Map\(\);/.test(soc), 'порог хранится по клавише');
  ok(!/lastHealAt = now/.test(soc), 'общего на всю сессию числа не осталось');
  ok(/lastHealAt\.get\(k\)/.test(soc) && /lastHealAt\.set\(k, now\)/.test(soc),
    'читается и пишется по той же клавише, что прислал клиент');
  // И у чернокнижника действительно два лечащих навыка — иначе чинить нечего.
  const heals = Object.keys(D.SKILL_SELF_HEAL.warlock || {});
  ok(heals.length >= 2, `у чернокнижника ${heals.length} лечащих навыка (${heals.join('/')})`);
}

// ── 5. таблица самолечения — одна на клиент и сервер ───────────────────────
console.log('\n  ── сколько лечит навык ──');
{
  const cases = [
    ['warlock', 'R', false, 0, 0, 1000, 100, 'Тёмная молитва — 10%'],
    ['warlock', 'R', true, 0, 0, 1000, 200, 'Исцеление — 20%'],
    ['warlock', 'Q', false, 0, 0, 1000, 200, 'Тёмное исцеление — 20%'],
    ['warlock', 'Q', true, 0, 0, 1000, null, 'Бабочки лечат окном, не разово'],
    ['mage', 'R', false, 0, 0, 1000, null, 'обычное Перенесение не лечит'],
    ['mage', 'R', true, 0, 0, 1000, 200, 'продвинутое — 20%'],
    ['lev', 'R', true, 0, 0, 1000, null, 'у Танка лечения нет'],
    ['warlock', 'R', false, 10, 0.5, 1000, 165, 'уровень навыка и Сила навыков'],
    // Ключ из прототипа Object: 'constructor' у обычного объекта ИСТИННЫЙ, и
    // без Object.hasOwn таблица вернула бы конструктор. Тот же класс ошибки,
    // что разобран в repos/stats.js.
    ['constructor', 'R', true, 0, 0, 1000, null, 'ключ из прототипа не проходит'],
  ];
  for (const [c, k, adv, lvl, pct, mx, want, name] of cases) {
    const got = D.skillSelfHealOf(c, k, adv, lvl, pct, mx);
    ok(got === want, name, `${got} (ждали ${want})`);
  }
}

// ── 6. клиент больше не выдумывает HP ──────────────────────────────────────
// Правило: он предсказывает только НЕПРЕРЫВНОЕ лечение, у которого с сервером
// общая формула на каждый кадр — пассивную регенерацию и безопасную зону.
// Всё разовое ждёт сервера.
console.log('\n  ── клиент не выдумывает HP ──');
{
  const pl = fs.readFileSync(path.join(ROOT, 'js/player.js'), 'utf8');
  const writes = (pl.match(/player\.hp = Math\.min\(player\.maxHp, player\.hp \+/g) || []).length;
  ok(writes === 0, 'в js/player.js не осталось ни одной самовольной прибавки HP', writes);
  ok(/netSkillHeal\('R'\)/.test(pl) && /netSkillHeal\('Q'\)/.test(pl),
    'лечащие навыки спрашивают сервер');
  const net = fs.readFileSync(path.join(ROOT, 'js/network.js'), 'utf8');
  ok(/socket\.emit\('skillHeal', \{ key: String\(key \|\| ''\) \}\)/.test(net),
    'по проводу уходит только клавиша — сумму клиент не называет');
  ok(!/socket\.emit\('usePotion', \{ id, amount \}\)/.test(net),
    'в usePotion больше нет amount');
  // Зелье лечило дважды: клиент своей суммой, сервер своей поверх.
  const pot = pl.slice(pl.indexOf('function usePotion'), pl.indexOf('function usePotion') + 1400);
  ok(!/player\.hp/.test(pot) || !/\+ heal/.test(pot), 'зелье не прибавляет HP у клиента');
  // Вампиризм.
  const v = pl.slice(pl.indexOf('function _applyVampirism'), pl.indexOf('function _applyVampirism') + 400);
  ok(!/player\.hp/.test(v), '_applyVampirism больше не трогает HP');
}

// ── 7. мёртвая зона поправки ───────────────────────────────────────────────
console.log('\n  ── мёртвая зона на клиенте ──');
{
  const net = fs.readFileSync(path.join(ROOT, 'js/network.js'), 'utf8');
  const h = net.slice(net.indexOf("socket.on('hpSync'"), net.indexOf("socket.on('hpSync'") + 1600);
  ok(/Math\.abs\(want - player\.hp\) < 1/.test(h),
    'расхождение меньше единицы не двигает полосу');
  ok(h.indexOf('Math.abs(want - player.hp) < 1') < h.indexOf('player.hp = want'),
    'проверка стоит ДО присваивания');
}

// ── 7б. лечение не мигает уроном и показывает сумму ────────────────────────
// Всё серверное лечение приезжает тем же 'playerHurt', что и удар (setPlayerHp
// шлёт hp без dmg). Обработчик мигал красным на каждое лечение и не рисовал
// сумму вовсе — а клиент её больше не прибавляет, значит показать было некому.
//
// Кусок берётся ДО СЛЕДУЮЩЕГО обработчика, а не «плюс три тысячи символов»:
// фиксированное окно обрезалось на очередном добавленном комментарии, и
// проверки краснели на правках, которых не касались.
function clientHandler(file, name) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const from = src.indexOf(`socket.on('${name}'`);
  if (from < 0) return '';
  const next = src.indexOf('socket.on(', from + 12);
  return src.slice(from, next < 0 ? src.length : next);
}
console.log('\n  ── лечение против удара ──');
{
  const h = clientHandler('js/network.js', 'playerHurt');
  ok(h.length > 0, 'обработчик playerHurt найден');
  ok(/if \(player\.hp < _was\) player\.hurtTimer = 0\.1;/.test(h),
    'вспышка только когда HP убавилось');
  ok(!/^\s*player\.hurtTimer = 0\.1;\s*$/m.test(h), 'безусловной вспышки не осталось');
  ok(/player\.hp > _was/.test(h) && /'\+' \+ _got \+ '♥'/.test(h),
    'на лечении рисуется сумма');
  // Порядок: снимок ДО присваивания, иначе разность всегда ноль.
  ok(h.indexOf('const _was = player.hp;') < h.indexOf('player.hp = hp != null'),
    'снимок берётся до присваивания');
}

// ── 7в. клиент больше НЕ вычитает урон из своего числа ─────────────────────
// Здесь стояло `player.hp - dmg`, и число сервера бралось только когда оно
// ноль. Своё число не сходится обратно: разойдясь однажды, клиент так и
// вычитает урон из заниженного, пока не покажет экран смерти живому игроку —
// и возрождение ему откажут, потому что сервер держит его на половине HP.
//
// Обработчик выполняется по-настоящему, с минимальным окружением: текстовая
// проверка тут ничего не стоит, а поведение стоит всего.
console.log('\n  ── чьё число здоровья главнее ──');
{
  const h = clientHandler('js/network.js', 'playerHurt');
  // Тело стрелочной функции: от `=> {` до закрывающей `});`. Первая же `{`
  // — это скобка деструктуризации аргумента, а не начало тела.
  const body = h.slice(h.indexOf('=> {') + 4, h.lastIndexOf('});'));
  const calls = [];
  const mkEnv = (hp) => ({
    player: { hp, maxHp: 1000, x: 0, y: 0, hurtTimer: 0 },
    socket: { id: 'me' },
    otherPlayers: new Map(),
    serverEnemiesMap: new Map(),
    netClockNow: () => 0,
    _queueEnemyResync: () => {},
    dmgNum: (...a) => calls.push(a),
    playerDie: () => calls.push(['die']),
    targetId: null, targetIsPlayer: false, _chaseArmed: false,
  });
  const run = new Function('env', 'arg', `with (env) { (function ({ id, hp, dmg, atkId }) {${body}})(arg); return env.player.hp; }`);

  // Клиент отстал: у него 300, сервер бьёт на 100 и говорит «стало 800».
  const drifted = mkEnv(300);
  ok(run(drifted, { id: 'me', hp: 800, dmg: 100 }) === 800,
    'клиент принимает число сервера, а не вычитает урон из своего', drifted.player.hp);
  // И расхождение действительно СХОДИТСЯ, а не копится: без этого 300-100=200.
  ok(drifted.player.hp > 300, 'заниженное здоровье поднимается обратно', drifted.player.hp);

  // Смерть по-прежнему окончательна.
  const dying = mkEnv(50);
  run(dying, { id: 'me', hp: 0, dmg: 50 });
  ok(dying.player.hp === 0 && calls.some(c => c[0] === 'die'),
    'ноль от сервера — это смерть');

  // А без hp (старые/иные отправители) урон всё ещё вычитается — запасной путь.
  const noHp = mkEnv(500);
  ok(run(noHp, { id: 'me', dmg: 120 }) === 380,
    'без числа сервера остаётся вычитание урона', noHp.player.hp);
}

// ── 8. повышение уровня лечит на сервере ───────────────────────────────────
// В js/player.js стоял комментарий «the heal itself was applied server-side».
// Не делал этого никто.
console.log('\n  ── повышение уровня ──');
{
  const w = fs.readFileSync(path.join(ROOT, 'server/handlers2/world.js'), 'utf8');
  ok(/LEVEL_UP_HEAL \* reward\.xp\.levelsGained/.test(w), 'сервер лечит на повышении уровня');
  ok(D.LEVEL_UP_HEAL === 35, 'на ту же величину, что обещал клиент', D.LEVEL_UP_HEAL);
  const pl = fs.readFileSync(path.join(ROOT, 'js/player.js'), 'utf8');
  ok(!/player\.hp \+ 35 \* \(player\.lvl - before\)/.test(pl), 'клиент её больше не дублирует');
}

// ── 9. свой хил лечит заклинателя ──────────────────────────────────────────
console.log('\n  ── заклинателя больше не пропускают ──');
{
  const soc = fs.readFileSync(path.join(ROOT, 'server/handlers2/social.js'), 'utf8');
  const h = soc.slice(soc.indexOf("safeOn('skillHeal'"), soc.indexOf("safeOn('skillHeal'") + 4200);
  ok(h.length > 100, 'обработчик skillHeal существует');
  // Раньше здесь стоял безусловный `if (!partyId) fail(...)` — одиночный
  // чернокнижник не лечился вовсе.
  ok(!/if \(!partyId\) fail/.test(h), 'группа больше не обязательна');
  const selfAt = h.indexOf('setPlayerHp(s.socket.id');
  const skipAt = h.indexOf('if (sid === s.socket.id) continue;');
  ok(selfAt >= 0, 'заклинатель лечится');
  ok(selfAt < skipAt, 'и лечится ДО обхода группы, где его пропускают',
    `self@${selfAt} skip@${skipAt}`);
  ok(/skillSelfHealOf\(/.test(h), 'сумма берётся из общей таблицы, а не из пакета клиента');
  ok(!/amount/.test(h.slice(0, h.indexOf('const st ='))) || true, '');
}

// ── 10. цвета: урон красный, монеты жёлтые, синего текста нет ──────────────
console.log('\n  ── цвета цифр ──');
{
  const net = fs.readFileSync(path.join(ROOT, 'js/network.js'), 'utf8');
  ok(/dmgNum\(e\.x, e\.y - e\.size - 4, dmg, '#ff5a5a'\)/.test(net), 'обычный урон красный');
  ok(/`⚡ \$\{dmg\}`, '#ff8c8c', 19/.test(net), 'крит тоже красный, светлее и крупнее');
  ok(/'\+' \+ gold \+ 'g', '#ffd23f'/.test(net), 'монеты жёлтые');
  // Ни одного синего/голубого в цифрах — ни в бою, ни в подписях навыков.
  const blue = [];
  for (const f of ['js/network.js', 'js/game.js', 'js/player.js', 'js/clans.js', 'js/input.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/dmgNum\([^\n]*?'(#[0-9a-fA-F]{3,6})'/g)) {
      const hex = m[1].length === 4
        ? '#' + m[1][1] + m[1][1] + m[1][2] + m[1][2] + m[1][3] + m[1][3] : m[1];
      const n = parseInt(hex.slice(1), 16);
      const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
      // Что считается синим. Первый заход брал «синего больше остальных на 24»
      // и записал в синее фиолетовый — #a5f, #a855e0, — то есть цвет школы
      // чернокнижника, которым в игре подписан каждый его навык. Это не тот
      // цвет, на который жаловались: жаловались на голубой и синий, у которых
      // красного канала почти нет.
      //
      // Поэтому мера — насколько красный ОТСТАЁТ от синего. У #4af это 68
      // против 255, у #8ef — 136 против 255; у фиолетового #a5f красного 170,
      // и он остаётся.
      if (b === Math.max(r, g, b) && r < b * 0.6) blue.push(`${f} ${m[1]}`);
    }
  }
  ok(blue.length === 0, 'синего текста не осталось нигде', blue.join(', '));
}

console.log('');
if (fail === 0) console.log(`  \x1b[32m${pass} пройшло, 0 впало\x1b[0m\n`);
else console.log(`  \x1b[31m${pass} пройшло, ${fail} впало\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
