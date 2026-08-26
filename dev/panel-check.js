#!/usr/bin/env node
'use strict';
// ── The browser admin panel, driven the way a browser drives it ─────────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/panel-check.js
//
// dev/adminapi-check.js already proves the ROUTES work. It passes, and every
// button in the panel was dead anyway — because it wrote its own HTTP client
// that sent the CSRF header the page does not send, and read the fields the
// page does not read. A test that speaks to the server in its own words cannot
// find out that the page speaks a different language.
//
// So this one uses the PAGE's words:
//
//   * every path and method admin.html actually calls, extracted from
//     admin.html, checked against the routes admin2.js actually registers.
//     `PUT /admin/special-quests/:id` was in the page and not in the server —
//     express answered 404 and the page ignored the reply.
//
//   * the header question, both ways. Without X-Admin-Request every write is
//     403, which is what made "вызвать босса, башню, битву" do nothing at all
//     while the panel showed no error worth noticing.
//
//   * the FIELDS. Each screen names what it reads; a reply that does not carry
//     those names renders `undefined` beside real values, which is how this
//     panel looked on almost every tab.
//
//   * and the events, end to end: press the button, then ask the same endpoint
//     whether anything actually happened. All four used to answer `{ok:true}`
//     without doing anything, because the runtime function was reached through
//     `modes._x && modes._x()` and a missing name is simply false.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PANEL_PORT || 3147);
process.env.PORT = String(PORT);
// Must not reach the operators' bot or the real wallet — boot() starts the
// workers. Same reasoning as adminapi-check, and stated here too because a run
// started any other way has to be just as safe.
process.env.OPS_LIVE = '0';
process.env.NODE_ENV = 'test';
process.env.TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || 'test:token';

const PASSWORD = 'panel-' + crypto.randomBytes(9).toString('base64url');
const adminAuth = require('../server/admin-auth');
process.env.ADMIN_USERNAME = 'panelcheck';
process.env.ADMIN_PASSWORD_HASH = adminAuth.hashPassword(PASSWORD);
process.env.ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET
  || crypto.randomBytes(32).toString('base64url');

const { pool, close, tx } = require('../server/db');
const players = require('../server/db/repos/players');
const app = require('../server/app');

const ROOT = path.join(__dirname, '..');
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);

const TAG = 'pn-' + String(process.pid).slice(-5);
const made = [];

// ── what the page calls ─────────────────────────────────────────────────────
// `api('/admin/x')`, `api('/admin/x', {method:'POST'})`, and the concatenated
// forms `api('/admin/player/'+tid+'/give', …)`. The concatenation is collapsed
// to a `:param` so it can be matched against a route pattern.
function panelCalls() {
  const src = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
  const out = new Map();
  // Everything from `api(` to the end of that statement's line(s), which is
  // enough: every call in this file puts the options object on the same or the
  // next line.
  const re = /\bapi\(\s*'([^']+)'((?:\s*\+\s*[^,)]+)*)\s*(?:,\s*\{([\s\S]{0,200}?)\})?\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    let p = m[1];
    // '/admin/player/' + tid + '/items' → '/admin/player/:x/items'
    const tail = m[2] || '';
    if (tail) {
      const parts = tail.split('+').map(s => s.trim()).filter(Boolean);
      for (const part of parts) {
        const lit = /^'([^']*)'$/.exec(part);
        p += lit ? lit[1] : ':x';
      }
    }
    p = p.split('?')[0];
    const opts = m[3] || '';
    const mm = /method\s*:\s*'([A-Z]+)'/.exec(opts);
    const method = mm ? mm[1] : 'GET';
    out.set(`${method} ${p}`, { method, path: p });
  }
  return [...out.values()];
}

// ── what the server registers ───────────────────────────────────────────────
function serverRoutes() {
  const src = fs.readFileSync(path.join(ROOT, 'server/routes/admin2.js'), 'utf8');
  const out = [];
  const re = /\bapp\.(get|post|put|delete)\(\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src))) out.push({ method: m[1].toUpperCase(), path: m[2] });
  // The six event controls are registered through modeCtl(), which calls
  // app.post with the path as a VARIABLE — invisible to the regex above, and
  // reported as six dead routes the first time this ran. modeCtl IS a POST
  // registration by definition, so it counts as one.
  const re2 = /\bmodeCtl\(\s*'([^']+)'/g;
  while ((m = re2.exec(src))) out.push({ method: 'POST', path: m[1] });
  return out;
}

const matches = (route, called) => {
  const a = route.path.split('/'), b = called.split('/');
  if (a.length !== b.length) return false;
  return a.every((seg, i) => seg.startsWith(':') || b[i].startsWith(':') || seg === b[i]);
};

// ── the page's own HTTP client, reproduced exactly ──────────────────────────
let cookie = null;
async function api(p, opts = {}) {
  const res = await fetch(BASE + p, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Request': '1',           // the header admin.html now sends
      ...(cookie ? { cookie } : {}),
      ...(opts.headers || {}),
    },
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  let body = null;
  try { body = await res.json(); } catch { /* 204 or html */ }
  return { status: res.status, body };
}

// A screen is its fields. `row` checks the first element of a list, because a
// list of the wrong shape is the failure that renders `undefined` in a table.
const has = (obj, keys, name) => {
  const missing = keys.filter(k => obj == null || obj[k] === undefined);
  ok(missing.length === 0, name, missing.length ? `нема полів: ${missing.join(', ')}` : '');
};

async function main() {
  console.log(`\npanel-check  (${TAG})  →  ${BASE}\n`);
  await app.boot();
  console.log('');

  // ── every call the page makes has somewhere to land ──────────────────────
  console.log('  ── маршрути ──');
  const calls = panelCalls();
  const routes = serverRoutes();
  // A SCAN THAT FOUND NOTHING MUST NOT REPORT SUCCESS. Both counts were
  // printed inside the message below and neither was ever asserted on, so
  // every way of breaking the scanners themselves — admin.html renamed, the
  // page switching from `api('/admin/x')` to a helper this regex does not
  // recognise, routes moving out of admin2.js — came out as "усі 0 викликів
  // панелі мають маршрут". The floors are far under the real figures (about
  // forty of each), so only a scanner that has stopped working reaches them.
  ok(calls.length > 20 && routes.length > 20,
    `є що перевіряти — ${calls.length} викликів сторінки проти ${routes.length} маршрутів`,
    'сканування нічого не знайшло — зламана сама перевірка');
  const dead = calls.filter(c =>
    !routes.some(r => r.method === c.method && matches(r, c.path)));
  ok(dead.length === 0,
    `усі ${calls.length} викликів панелі мають маршрут`,
    dead.map(d => `${d.method} ${d.path}`).join(', '));

  // ── the header ───────────────────────────────────────────────────────────
  console.log('\n  ── вхід і заголовок ──');
  const login = await api('/admin/login', {
    method: 'POST', body: JSON.stringify({ username: 'panelcheck', password: PASSWORD }) });
  eq(login.status, 200, 'сторінка входить тим самим запитом, що й панель');
  ok(!!cookie, 'сесія — у httpOnly cookie, а не в localStorage');
  ok(typeof login.body.csrf === 'string' && login.body.csrf.length > 0,
    'відповідь містить те, що сторінка справді читає (csrf), а не вигаданий token');
  ok(login.body.token === undefined,
    "поля 'token' немає — саме його сторінка читала й зберігала рядок «undefined»");

  // The other half of the same fact: without the header every write is 403.
  // This is the entire "кнопки не работают" report, in one assertion.
  const bare = await fetch(`${BASE}/admin/event-boss`, {
    method: 'POST', headers: { cookie, 'Content-Type': 'application/json' } });
  eq(bare.status, 403, 'без X-Admin-Request запис відхиляється — це і ламало всі кнопки');

  // ── every screen gets the fields it draws ────────────────────────────────
  console.log('\n  ── поля, які малює сторінка ──');
  const { id: pid } = await tx(t => players.ensure(t, `${TAG}-tg`, `${TAG}_p`));
  made.push(pid);
  const { rows: tgRow } = await pool().query('SELECT telegram_id FROM players WHERE id = $1', [pid]);
  const TID = tgRow[0].telegram_id;

  const stats = await api('/admin/stats');
  has(stats.body, ['total', 'online', 'newToday', 'banned', 'tops'], 'дашборд: лічильники');

  const list = await api(`/admin/players?q=${TAG}&limit=5`);
  has(list.body, ['players'], 'список гравців: players');
  has((list.body.players || [])[0],
    ['telegramId', 'username', 'lvl', 'bm', 'banned'], 'рядок списку');

  const card = await api(`/admin/player/${TID}`);
  // The page reads these off the TOP LEVEL. It used to look for
  // `pd.player.savedData`, which is the Mongo document, and threw on the first
  // property — so opening any player said "Ошибка загрузки", always.
  has(card.body, ['username', 'telegramId', 'bm', 'banned', 'createdAt',
    'progress', 'balances', 'items', 'logs', 'seasonPoints', 'seasonLogs'],
    'картка гравця: пласка, з журналом і сезоном');
  has(card.body.progress, ['lvl', 'charClass', 'bonusSP', 'rebirths'], 'картка: прогрес');
  has(card.body.balances, ['gold', 'nexum', 'gram'], 'картка: баланси');
  has(card.body.items, ['inventory', 'equipment'], 'картка: речі');
  ok(card.body.player === undefined,
    "поля 'player' немає — сторінка читала pd.player і падала на .banned");

  const gram = await api('/admin/transactions');
  has(gram.body, ['txs'], 'GRAM: txs (сторінка читає саме це)');

  const clans = await api('/admin/clans');
  has(clans.body, ['clans'], 'клани: clans');

  const chat = await api('/admin/chat');
  has(chat.body, ['messages'], 'чат: messages');

  const mkA = await api('/admin/market?tab=active');
  has(mkA.body, ['listings'], 'ринок: активні');
  const mkH = await api('/admin/market?tab=history');
  has(mkH.body, ['listings'], 'ринок: історія');
  ok((mkH.body.listings || []).every(l => l.status !== 'active'),
    'вкладка «История» не показує активні лоти — ?tab= нарешті читається');

  const traders = await api('/admin/top-market');
  has(traders.body, ['traders'], 'рейтинг торговців: traders');

  const refs = await api('/admin/top-referrals');
  has(refs.body, ['referrers'], 'реферали: referrers');

  const sus = await api('/admin/suspicious');
  has(sus.body, ['players', 'drift'], 'підозрілі: players + розбіжність леджера');

  const quests = await api('/admin/special-quests');
  has(quests.body, ['quests'], 'завдання: quests');

  // ── a quest, created the way the form creates one ────────────────────────
  console.log('\n  ── завдання ──');
  const made1 = await api('/admin/special-quests', {
    method: 'POST',
    // Exactly the body the form builds: `desc`, and a nested `reward`.
    body: JSON.stringify({
      title: `${TAG}-quest`, desc: 'опис', type: 'link', icon: '*', url: 'https://x',
      reward: { gold: 111, xp: 222, nexum: 3 },
    }),
  });
  eq(made1.status, 200, 'завдання створено');
  const qList = await api('/admin/special-quests');
  const q = (qList.body.quests || []).find(x => x.title === `${TAG}-quest`);
  ok(!!q, 'воно є у списку');
  if (q) {
    eq(q.description, 'опис', 'опис збережено — форма шле desc, маршрут читав description');
    eq(q.reward.gold, 111, 'нагорода збережена, а не занулена');
    eq(q.reward.xp, 222, 'і досвід теж');
    // The toggle the page has always called and the server never had.
    const off = await api(`/admin/special-quests/${q.id}`, {
      method: 'PUT', body: JSON.stringify({ active: false }) });
    eq(off.status, 200, 'PUT-перемикач існує (був 404 — сторінка мовчки відкочувала кнопку)');
    const after = (await api('/admin/special-quests')).body.quests.find(x => x.id === q.id);
    eq(after.active, false, 'і справді вимикає');
    await pool().query('DELETE FROM special_quests WHERE id = $1', [q.id]);
  }

  // ── the buttons that did nothing ─────────────────────────────────────────
  // Press, then ASK. Every one of these answered {ok:true} while doing
  // nothing, so the only assertion worth making is about the state after.
  console.log('\n  ── події: натиснули і перевірили, що щось сталося ──');

  const dbBefore = await api('/admin/death-battle');
  const dbPress = await api('/admin/death-battle', { method: 'POST' });
  eq(dbPress.status, 200, 'битва на смерть: кнопку прийнято');
  const dbAfter = await api('/admin/death-battle');
  eq(dbAfter.body.phase, 'reg', `реєстрація відкрилась (було '${dbBefore.body.phase}')`);
  ok(dbAfter.body.startAt > Date.now() + 60000,
    `старт у майбутньому (${Math.round((dbAfter.body.startAt - Date.now()) / 1000)}с) — `
    + 'з викликом без аргументу тут був NaN, і бій стартував миттєво з порожнім списком');

  const r10Press = await api('/admin/race10/open', {
    // Without this the route clears today's race10 attempts for every real
    // player in the database. A test must not write to live player state.
    method: 'POST', body: JSON.stringify({ restoreAttempts: false }) });
  eq(r10Press.status, 200, 'Кровава Вежа: кнопку прийнято');
  eq((await api('/admin/race10')).body.phase, 'reg', 'і реєстрація справді відкрилась');
  await api('/admin/race10/close', { method: 'POST' });
  eq((await api('/admin/race10')).body.phase, 'idle', 'а кнопка «закрити» справді закриває');

  const gwPress = await api('/admin/guildwar/open', { method: 'POST' });
  eq(gwPress.status, 200, 'війна гільдій: кнопку прийнято');
  eq((await api('/admin/guildwar')).body.phase, 'live', 'локація відкрилась');
  await api('/admin/guildwar/close', { method: 'POST' });
  ok((await api('/admin/guildwar')).body.phase !== 'live', 'і закривається');

  const bossPress = await api('/admin/event-boss', { method: 'POST' });
  eq(bossPress.status, 200, 'світовий бос: кнопку прийнято');
  eq((await api('/admin/event-boss')).body.alive, true, 'бос справді на карті');
  // Pressing again must be refused with a REASON, not silently accepted.
  const twice = await api('/admin/event-boss', { method: 'POST' });
  eq(twice.status, 400, 'другий виклик відхилено');
  ok(/уже/i.test(twice.body.error || ''), `і сказано чому (${twice.body.error})`);

  // ── a missing runtime function must be loud ──────────────────────────────
  // The bug class itself, reproduced: take the name away and press the button.
  // The old shape answered {ok:true}. The new one names what is missing.
  console.log('\n  ── зникла функція режиму ──');
  const modes = require('../server/modes').modes;
  // Back to idle first: the registration opened a few assertions ago, and the
  // "уже открыта" guard answers before the missing-name check is reached —
  // which is what the first run of this found, and it is the guard working.
  if (modes._db) modes._db.phase = 'idle';
  const saved = modes._dbOpenReg;
  delete modes._dbOpenReg;
  const broken = await api('/admin/death-battle', { method: 'POST' });
  modes._dbOpenReg = saved;
  ok(broken.status >= 400, `кнопка без реалізації відповідає помилкою (${broken.status})`);
  ok(/_dbOpenReg/.test(broken.body && broken.body.error || ''),
    `і називає, чого бракує (${broken.body && broken.body.error})`);

  // ── the panel's own item protocol ────────────────────────────────────────
  console.log('\n  ── речі з панелі ──');
  const add = await api(`/admin/player/${TID}/items`, {
    method: 'POST', body: JSON.stringify({ action: 'add', itemId: 'sw1', qty: 1, enhance: 3 }) });
  eq(add.status, 200, 'видача предмета кнопкою панелі');
  has(add.body, ['inventory', 'equipment'], 'у відповіді — інвентар, з якого панель перемальовує');
  const idx = (add.body.inventory || []).findIndex(i => i.id === 'sw1');
  ok(idx >= 0, 'предмет у списку, що повернувся');
  const del = await api(`/admin/player/${TID}/items`, {
    method: 'POST', body: JSON.stringify({ action: 'removeInv', index: idx }) });
  eq(del.status, 200, 'видалення за номером комірки — операція, якої маршрут не мав');
  ok(!(del.body.inventory || []).some(i => i.id === 'sw1'), 'предмета більше немає');

  // ── the broadcast reports a real number ──────────────────────────────────
  const bc = await api('/admin/broadcast', {
    method: 'POST', body: JSON.stringify({ text: `${TAG} тест`, target: 'all' }) });
  eq(bc.status, 200, 'розсилка прийнята');
  ok(Number.isFinite(bc.body.sent),
    `у відповіді є кількість (${bc.body.sent}) — сторінка друкує d.sent, а його не було`);

  console.log(`\n  ${pass} пройшло, ${fail} впало`);
  if (failures.length) console.log(`  впали: ${failures.join(', ')}`);
}

async function cleanup() {
  const q = (s, p) => pool().query(s, p).catch(() => {});
  if (made.length) {
    for (const t of ['player_items', 'player_skills', 'player_vip', 'player_prefs', 'player_daily',
                     'player_season', 'player_progress', 'player_logs', 'ledger', 'balances']) {
      await q(`DELETE FROM ${t} WHERE player_id = ANY($1)`, [made]);
    }
    await q('DELETE FROM players WHERE id = ANY($1)', [made]);
  }
  await q(`DELETE FROM admin_actions WHERE admin_tg_id = 'panelcheck'`);
  try { await app.shutdown('test', { exit: false }); } catch { /* already down */ }
}

main()
  .catch(err => { console.error(err); fail++; })
  .finally(async () => {
    await cleanup();
    await close().catch(() => {});
    process.exit(fail ? 1 : 0);
  });
