#!/usr/bin/env node
'use strict';
// ── Два повідомлення від гравців, і обидва про те, чого не було видно ───────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/relog-attack-check.js
//
// 1. «сезонний білет після перезаходу не відображається, потрібно в сезон
//    зайти щоб він почав далі відображатись»
//
//    Значок білета в стрічці бафів (drawBuffStrip, js/ui.js) малюється лише
//    коли зійшлися ДВІ величини: `_seasonTicketActive` — з authOk, і
//    `_seasonState.active` — з окремої події seasonState. Друга приїздила
//    тільки тоді, коли гравець сам відкриє панель «Сезон» і та попросить
//    seasonSync. Тобто після перезаходу значка не було, а відкрита панель
//    його «лікувала» — рівно те, що описано в скарзі.
//
//    Тому тут перевіряється ПРАВИЛО, а не наявність рядка в коді: усе, що
//    читає значок, має приїхати САМЕ ПРИ ВХОДІ, і панель «Сезон» не має
//    повідомляти клієнту нічого нового про білет і про вікно сезону. Якщо
//    колись логін знову перестане возити половину — впаде ось тут, а не в
//    чаті підтримки.
//
// 2. «Авто бой с мобами останавливается походу переодически» / «якесь кд на
//    удар … час від часу тупить і херово б'є з затримкою великою»
//
//    Room.attackEnemy (server/game/Room.js) відкидає будь-який не-splash удар,
//    що прийшов раніше ніж через 150 мс після ПРИЙНЯТОГО попереднього, і
//    відкидає мовчки — resolveHit на null не шле нічого. Клієнт же планував
//    замах рівно через 1/atkSpeed, без жодної підлоги. Щойно збірка
//    переростає 6.67 удару/с, два темпи починають битися: відкинутий замах не
//    зсуває серверне вікно, і наступний влучає в ту саму «яму».
//
//    Нижче це ВИМІРЮЄТЬСЯ на живому сервері: та сама ціль, той самий гравець,
//    міняється лише період між пакетами. Швидший темп мусить приносити не
//    менше влучань — а до виправлення приносив удвічі менше.
//
// Обидві частини потребують бази: перевіряється те, що доходить до КЛІЄНТА,
// а не те, що написано у файлах.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const io = require('socket.io-client');

const PORT = Number(process.env.RELOG_CHECK_PORT || 3176);
process.env.PORT = String(PORT);
process.env.OPS_LIVE = '0';
process.env.NODE_ENV = 'test';
process.env.TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || 'test:token';
// Знімається, а не виставляється: бюджет руху тут ні до чого, а успадкований
// з оболонки MOVE_GUARD='off' міняє поведінку кімнати під час бою.
delete process.env.MOVE_GUARD;

const { pool, close } = require('../server/db');
const money = require('../server/db/repos/money');
const progression = require('../server/db/repos/progression');
const app = require('../server/app');
const { wipeItemsAll } = require('./fixtures');
const { SEASON_TICKET_GRAM_PRICE } = require('../shared/definitions');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);

const TAG = 'rl-' + String(process.pid).slice(-5);
const TG = 973000000 + (process.pid % 100000);
const made = [];

function initDataFor(id, username) {
  const p = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AA',
    user: JSON.stringify({ id, first_name: username, username }),
  });
  const check = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.TG_BOT_TOKEN).digest();
  p.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
  return p.toString();
}
const once = (sock, ev, ms = 12000) => new Promise((res, rej) => {
  const to = setTimeout(() => rej(new Error(`таймаут '${ev}'`)), ms);
  sock.once(ev, d => { clearTimeout(to); res(d); });
});
const wait = ms => new Promise(r => setTimeout(r, ms));

// ── КЛІЄНТ, а не просто сокет ───────────────────────────────────────────────
// Тримає рівно ті дві величини, з яких js/ui.js вирішує, малювати значок
// білета чи ні, і оновлює їх тими самими подіями, що й js/network.js. Питання
// «чи побачить гравець білет» ставиться до ЦЬОГО об'єкта, а не до бази: база
// весь час знала правильну відповідь, її просто не було на дроті.
function client() {
  const sock = io(`http://127.0.0.1:${PORT}`, { transports: ['websocket'], forceNew: true });
  const c = {
    sock, ticket: false, season: { endAt: 0, active: false }, asked: false,
    seasonPushes: 0, unprompted: 0,
  };
  sock.on('authOk', a => { c.ticket = !!a.seasonTicketActive; });
  sock.on('seasonState', st => {
    if (!st) return;
    c.seasonPushes++;
    if (!c.asked) c.unprompted++;
    c.season = { ...c.season, ...st };
  });
  return c;
}
// Умова з drawBuffStrip (js/ui.js), слово в слово по змісту.
const chipVisible = c => !!(c.ticket && c.season.active && ((c.season.endAt || 0) - Date.now()) > 0);

async function login(c) {
  await once(c.sock, 'connect');
  c.sock.emit('loginTelegramWebApp', { initData: initDataFor(TG, `${TAG}_ticket`) });
  const auth = await once(c.sock, 'authOk');
  await wait(700);                       // усе, що логін шле слідом за authOk
  return auth;
}

// ═══ 1. СЕЗОННИЙ БІЛЕТ ПІСЛЯ ПЕРЕЗАХОДУ ═══════════════════════════════════
async function seasonTicket() {
  console.log('  ── сезонний білет після перезаходу ──');

  const c1 = client();
  await login(c1);
  const { rows } = await pool().query('SELECT id FROM players WHERE telegram_id = $1', [String(TG)]);
  const pid = Number(rows[0].id);
  made.push(pid);

  // Купівля справжнім шляхом: gramShopBuy → shop.buyPackage → grantSeasonTicket.
  // Викликати репозиторій напряму означало б не перевірити саме ту ділянку, де
  // за білет уже сплачено.
  await money.credit(null, pid, 'gram', SEASON_TICKET_GRAM_PRICE + 5,
    { reason: 'seed', idemKey: `${TAG}:gram` });
  c1.sock.emit('gramShopBuy', { pkgId: 'season_ticket' });
  const bought = await once(c1.sock, 'gramShopResult', 12000).catch(() => null);
  ok(!!bought && bought.pkgId === 'season_ticket', 'покупка білета пройшла');

  const vip = await progression.vipOf(null, pid);
  ok(vip.seasonTicket === true,
    'білет ЗАПИСАНО в player_vip — інакше сплачені GRAM зникають разом із ним');

  c1.sock.disconnect();
  await wait(500);

  // ── власне перезахід ─────────────────────────────────────────────────────
  const c2 = client();
  const auth = await login(c2);

  eq(auth.seasonTicketActive, true,
    'authOk після перезаходу каже, що білет є (без цього значка нема ніде)');
  ok(c2.unprompted >= 1,
    'сезон приїхав САМ, без запиту панелі — це і є «потрібно в сезон зайти»');
  eq(c2.season.active, true, 'і каже, що сезон іде');
  ok((c2.season.endAt || 0) > Date.now(),
    `і коли він закінчується (${new Date(c2.season.endAt || 0).toISOString()})`);
  ok(chipVisible(c2),
    'значок білета видно ОДРАЗУ після входу, а не після відкриття панелі');

  // ── білет їде разом із сезоном, а не окремим пакетом ─────────────────────
  // Дві половини, які зобов'язані зійтися, не мають їхати нарізно: authOk —
  // обов'язковий, seasonState — окремий emit за своїм catch. Прапорець білета
  // тепер лежить у ТОМУ САМОМУ payload, що й вікно сезону.
  eq(c2.season.ticket, auth.seasonTicketActive,
    'seasonState несе прапорець білета і згоден з authOk — розходитися нема чому');

  // ── панель не повідомляє нічого, чого логін не сказав ────────────────────
  const beforePanel = { active: c2.season.active, endAt: c2.season.endAt, ticket: c2.season.ticket };
  c2.asked = true;
  c2.sock.emit('seasonSync');
  await wait(1000);
  ok(c2.seasonPushes > c2.unprompted, 'панель «Сезон» справді відповіла (є що порівнювати)');
  eq(c2.season.active, beforePanel.active, 'панель не додала нового про «сезон іде»');
  eq(c2.season.endAt, beforePanel.endAt, 'ані про його кінець');
  eq(c2.season.ticket, beforePanel.ticket, 'ані про білет — відкривати її нема потреби');

  c2.sock.disconnect();
  await wait(300);

  // ── білет, за який заплатили, мусить зберегтися ─────────────────────────
  // player_vip створює players.ensure на кожному вході, тож сьогодні рядок є
  // завжди. Але grantSeasonTicket був голим UPDATE: нема рядка — нема запису,
  // і повернене false ніхто не перевіряв. Тут перевіряється ПРАВИЛО: видача
  // білета або відбулася, або відбулася — третього стану («сплатили, а нема»)
  // бути не може.
  await pool().query('DELETE FROM player_vip WHERE player_id = $1', [pid]);
  const granted = await progression.grantSeasonTicket(null, pid);
  eq(granted, true, 'видача білета працює навіть коли рядка player_vip ще нема');
  const after = await progression.vipOf(null, pid);
  eq(after.seasonTicket, true, 'і білет справді лежить у базі, а не загубився');
  eq(await progression.grantSeasonTicket(null, pid), false,
    'а друга видача поспіль — ні: разова покупка лишилася разовою');

  const c3 = client();
  const auth3 = await login(c3);
  eq(auth3.seasonTicketActive, true, 'і після ще одного перезаходу білет на місці');
  ok(chipVisible(c3), 'значок знову видно одразу');
  c3.sock.disconnect();
  await wait(300);
  return pid;
}

// ═══ 2. ТЕМП АВТО-АТАКИ ═══════════════════════════════════════════════════
// Дві сторони одного правила, і обидві мусять триматися разом:
//   * сервер приймає удар не частіше, ніж раз на SERVER_MIN мс;
//   * клієнт не планує замах частіше, ніж CLIENT_MIN.
// Числа беруться з самих файлів (значення, не формулювання): якщо серверний
// поріг колись зміниться, а клієнтський за ним не піде — впаде ось тут.
// Числа беруться з самих файлів (значення, а не формулювання): якщо поріг
// колись зміниться, а клієнтський крок за ним не піде — впаде ось тут.
function floors() {
  const room = fs.readFileSync(path.join(__dirname, '..', 'server', 'game', 'Room.js'), 'utf8');
  const game = fs.readFileSync(path.join(__dirname, '..', 'js', 'game.js'), 'utf8');
  const tol = room.match(/^const ATTACK_GAP_TOLERANCE\s*=\s*([\d.]+)\s*;/m);
  const hard = room.match(/^const ATTACK_GAP_HARD_MIN_MS\s*=\s*([\d.]+)\s*;/m);
  const cli = game.match(/^const ATTACK_MIN_INTERVAL\s*=\s*([\d.]+)\s*;/m);
  return {
    tolerance: tol ? Number(tol[1]) : null,
    hardMinMs: hard ? Number(hard[1]) : null,
    clientMs: cli ? Math.round(Number(cli[1]) * 1000) : null,
    // Поріг більше не число, а функція від швидкості атаки гравця — та сама,
    // що в Room._attackMinGapMs.
    gapFor(as) { return Math.max(this.hardMinMs, (1000 / as) * this.tolerance); },
  };
}

// Скільки ударів на секунду сервер ПРИЙМЕ, якщо клієнт б'є з періодом p мс:
// відкинутий удар не зсуває вікно, тож наступний прийнятий — рівно через
// стільки періодів, скільки треба, щоб перекрити поріг.
const landedPerSec = (periodMs, serverMs) => 1000 / (Math.ceil(serverMs / periodMs) * periodMs);

function cadenceRule() {
  console.log('\n  ── темп удару: клієнт проти серверного порогу ──');
  const f = floors();
  ok(Number.isFinite(f.tolerance), `допуск порога знайдено в Room.js (${f.tolerance})`);
  ok(Number.isFinite(f.hardMinMs), `нижня межа знайдена в Room.js (${f.hardMinMs} мс)`);
  ok(Number.isFinite(f.clientMs), `клієнтський крок знайдено в js/game.js (${f.clientMs} мс)`);
  // Допуск мусить бути МЕНШИЙ за одиницю: клієнт шле рівно 1/atkSpeed, і поріг,
  // рівний цьому періоду або більший, відкидав би кожен пакет, що прийшов на
  // мілісекунду раніше через дрижання мережі.
  ok(f.tolerance > 0 && f.tolerance < 1,
    `поріг лишає запас на дрижання мережі (${f.tolerance})`);
  // Нижня межа — страховка, а не правило: вона мусить лежати нижче за поріг
  // найшвидшої досяжної збірки, інакше саме вона стане обмежувачем і поверне
  // ту саму биття темпів.
  ok(f.hardMinMs < f.gapFor(16.0),
    `нижня межа не стає обмежувачем для найшвидшої збірки (${f.hardMinMs} < ${f.gapFor(16.0).toFixed(1)} мс)`);
  ok(f.clientMs <= f.hardMinMs,
    `клієнтський крок не жорсткіший за серверну страховку (${f.clientMs} ≤ ${f.hardMinMs} мс)`);

  // ── швидкість атаки не має ЗМЕНШУВАТИ шкоду ──────────────────────────────
  // Це і є вся суть скарги. Проходимо весь досяжний діапазон atkSpeed (у базі
  // вже є варлок 38 рівня зі 120 очками в швидкість — це 7.87 удару/с) і
  // вимагаємо монотонності: більша швидкість — не менше влучань.
  let worst = null, lost = null;
  let prev = -Infinity;
  for (let as = 0.80; as <= 16.0; as += 0.01) {
    const period = Math.max(1000 / as, f.clientMs);
    const rate = landedPerSec(period, f.gapFor(as));
    if (rate < prev - 1e-9 && (worst === null || prev - rate > worst.drop)) {
      worst = { as: as.toFixed(2), from: prev.toFixed(2), to: rate.toFixed(2), drop: prev - rate };
    }
    // І друга половина того ж правила: вкладені очки мусять доходити. Раніше
    // все вище 6.67 уд/с не давало нічого — спершу шкодило, потім (з пласким
    // клієнтським полом) просто зникало.
    if (lost === null && rate < as - 0.05) lost = { as: as.toFixed(2), rate: rate.toFixed(2) };
    prev = rate;
  }
  ok(worst === null,
    'жодне збільшення швидкості атаки не зменшує кількість влучань',
    worst && `на ${worst.as} уд/с влучань падає з ${worst.from} до ${worst.to} за секунду`);
  ok(lost === null,
    'уся швидкість атаки доходить до влучань, а не впирається в стелю',
    lost && `на ${lost.as} уд/с сервер приймає лише ${lost.rate}`);
  return f;
}

// Живий замір: та сама ціль, той самий гравець, різниця тільки в періоді.
async function cadenceLive(f) {
  console.log('\n  ── темп удару: живий замір на сервері ──');
  const c = client();
  await once(c.sock, 'connect');
  const tg2 = TG + 1;
  c.sock.emit('loginTelegramWebApp', { initData: initDataFor(tg2, `${TAG}_atk`) });
  await once(c.sock, 'authOk');
  const { rows } = await pool().query('SELECT id FROM players WHERE telegram_id = $1', [String(tg2)]);
  const pid = Number(rows[0].id);
  made.push(pid);
  await pool().query('UPDATE player_progress SET lvl = 40 WHERE player_id = $1', [pid]);
  c.sock.emit('selectChar', { type: 'warlock' });
  await once(c.sock, 'gameStart');
  const sess = app.io.sockets.sockets.get(c.sock.id).data.session;
  sess.forceFloor(2);                                 // у залі нема кого бити
  await once(c.sock, 'gameStart');
  await wait(600);

  const room = sess.room;
  const me = room.players.get(c.sock.id);
  let hits = 0;
  c.sock.on('enemyHurt', () => hits++);
  c.sock.on('enemyKilled', () => hits++);

  // Груша, а не монстр: живучість і відстань закріплені, щоб на результат
  // впливав РІВНО період між пакетами. Інакше вимірювався б розкид шкоди.
  async function burst(periodMs, seconds) {
    const victim = (room.enemies || []).find(e => e.hp > 0 && !e.isBoss);
    if (!victim) throw new Error('на поверсі нема жодного монстра');
    const pin = () => {
      victim.maxHp = 1e9; victim.hp = 1e9;
      me.x = victim.x; me.y = victim.y; me.hp = me.maxHp;
    };
    pin();
    const keep = setInterval(pin, 20);
    hits = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < seconds * 1000) {
      c.sock.emit('attack', { enemyId: victim.id });
      await wait(periodMs);
    }
    await wait(400);
    clearInterval(keep);
    return hits / ((Date.now() - t0) / 1000);
  }

  // Найшвидша збірка, яка вже існує в базі: варлок 38 рівня, 120 очок у
  // швидкість атаки. 1.2·(1+37·0.015) + 120·0.05 = 7.87 удару/с.
  const AS = 1.2 * (1 + 37 * 0.015) + 120 * 0.05;

  // Швидкість атаки ставиться прямо в кімнаті. Перевірка про ТЕМП, а не про
  // прокачку, і 120 очок у швидкість через базу — це довгий шлях до того самого
  // числа. Сервер рахує поріг саме з цього поля (Room._attackMinGapMs), тож це
  // той самий вхід, яким користується гра.
  me.atkSpeed = AS;
  const period = Math.round(1000 / AS);

  // ── половина перша: вкладена швидкість доходить ──────────────────────────
  // Саме тут була скарга. Плаский поріг у 150 мс відкидав кожен удар швидшої
  // збірки, МОВЧКИ, і відкинутий удар не зсував вікно — тому чим швидше людина
  // била, тим менше влучала.
  me._lastAtk = 0;
  const own = await burst(period, 3);
  ok(own >= AS * 0.75,
    `збірка на ${AS.toFixed(2)} уд/с справді влучає приблизно стільки ж (${own.toFixed(2)}/с)`,
    'удари відкидаються — темп клієнта не вкладається в серверний поріг');

  // ── половина друга: стеля тримається ─────────────────────────────────────
  // Той самий плаский поріг дозволяв 6.67 удару/с і персонажу з базовою
  // швидкістю 1.2 — тобто дарував зміненому клієнту п'ятикратну шкоду. Поріг,
  // що рахується від швидкості гравця, мусить закривати це так само надійно,
  // як пропускає законне.
  await wait(400);
  me._lastAtk = 0;
  const spam = await burst(Math.max(1, Math.round(period / 2)), 3);
  console.log(`        ${period} мс → ${own.toFixed(2)} влучань/с   ·   ${Math.round(period / 2)} мс → ${spam.toFixed(2)} влучань/с`);
  ok(spam <= own * 1.15,
    `удвічі частіші замахи не дають більше влучань (${spam.toFixed(2)} проти ${own.toFixed(2)})`,
    'поріг не тримає стелю — швидший потік пакетів купує шкоду');
  // І не менше: биття темпів, через яке падала шкода, не має повернутися з
  // іншого боку.
  ok(spam >= own * 0.6,
    `і не обвалюються (${spam.toFixed(2)} проти ${own.toFixed(2)})`,
    'відкинуті удари знову їдять темп');

  c.sock.disconnect();
  await wait(300);
}

async function main() {
  console.log(`\nrelog-attack-check  (${TAG})\n`);
  await app.boot();
  console.log('');
  await seasonTicket();
  const f = cadenceRule();
  await cadenceLive(f);
}

async function cleanup() {
  const q = (s, p) => pool().query(s, p).catch(() => {});
  if (made.length) {
    // Предмети — тими ж дверима, якими їх видали: сирий DELETE лишає в
    // item_ledger видачу без рядків, і нічна звірка справедливо про це кричить.
    await wipeItemsAll(made);
    for (const t of ['player_skills', 'player_vip', 'player_prefs', 'player_daily',
                     'player_season', 'player_progress', 'ledger', 'balances']) {
      await q(`DELETE FROM ${t} WHERE player_id = ANY($1)`, [made]);
    }
    await q('DELETE FROM players WHERE id = ANY($1)', [made]);
  }
  try { await app.shutdown('test', { exit: false }); } catch { /* вже зупинений */ }
}

main()
  .catch(err => { fail++; failures.push('НЕОБРОБЛЕНА ПОМИЛКА'); console.error('\n', err); })
  .finally(async () => {
    await cleanup(); await close().catch(() => {});
    console.log(`\n  ${pass} пройшло, ${fail} впало`);
    if (failures.length) console.log('  впали: ' + failures.join(' · '));
    process.exit(fail ? 1 : 0);
  });
