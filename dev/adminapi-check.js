#!/usr/bin/env node
'use strict';
// ── The admin panel, end to end ─────────────────────────────────────────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/adminapi-check.js
//
// Boots the real server and talks HTTP to it, because the admin panel is where
// an operator can move money and destroy items — and it was the last part of
// the game still reading Mongo models, so all of it is new code.
//
// The password is generated here and the hash put into the environment before
// the server is required. That is not a shortcut around the auth: it is the
// only way to know the password on the other side of a one-way hash, and the
// login path being exercised is exactly the one production uses.
//
// The check that matters most is the last one: an admin grant must appear in
// the LEDGER. The old panel wrote the balance column directly, which is money
// from nowhere as far as reconcile() is concerned — every admin gift would
// have set off the alarm that says value moved outside money.js.

const crypto = require('crypto');

const PORT = Number(process.env.ADMINAPI_PORT || 3141);
process.env.PORT = String(PORT);
// This process must not reach the operators' bot. It boots the real server,
// and boot() starts the workers: a second getUpdates poll takes the withdrawal
// buttons away from the live server, and the deposit scanner would be aimed at
// a wallet holding real money. dev/sync.sh sets these too — both, because a
// run started any other way has to be just as safe.
process.env.OPS_LIVE = '0';
process.env.NODE_ENV = 'test';
process.env.TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || 'test:token';

const PASSWORD = 'test-' + crypto.randomBytes(9).toString('base64url');
const adminAuth = require('../server/admin-auth');
process.env.ADMIN_USERNAME = 'checkadmin';
process.env.ADMIN_PASSWORD_HASH = adminAuth.hashPassword(PASSWORD);
process.env.ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET
  || crypto.randomBytes(32).toString('base64url');

const { pool, close, tx } = require('../server/db');
const players = require('../server/db/repos/players');
const money = require('../server/db/repos/money');
const items = require('../server/db/repos/items');
const app = require('../server/app');
const { wipeItemsAll } = require('./fixtures');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);

const TAG = 'ad-' + String(process.pid).slice(-5);
const made = [];
const BASE = `http://127.0.0.1:${PORT}`;

let cookie = null;        // the name=value pair, which is all a request may echo
let setCookieRaw = null;  // the whole Set-Cookie line, attributes included
async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      'x-admin-request': '1',
      ...(cookie ? { cookie } : {}),
      ...(opts.headers || {}),
    },
  });
  const set = res.headers.get('set-cookie');
  // BOTH halves are kept now. `cookie` is the name=value pair and nothing else,
  // because that is all a Cookie REQUEST header may carry — attributes belong
  // to Set-Cookie and a request echoing them is malformed. `setCookieRaw` is
  // the line as sent, and it is the only place HttpOnly, SameSite and Path can
  // be read at all. Keeping only [0] threw them away at the door, which is how
  // the flag assertion below came to be written against an empty string.
  if (set) { setCookieRaw = set; cookie = set.split(';')[0]; }
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, body };
}

async function main() {
  console.log(`\nadminapi-check  (${TAG})\n`);
  await app.boot();
  console.log('');

  // A player to act on.
  // ЧИСЛОВОЙ telegram_id. Список игроков в админке показывает только тех, у
  // кого он число: настоящий вход всегда приносит число, а проверки писали
  // туда свой тег — и три тысячи таких аккаунтов оказались «везде: и в админ
  // панели, и в чатах, и в рейтинге». Раз проверка смотрит именно на этот
  // список, аккаунт для неё должен выглядеть как настоящий.
  //
  // Диапазон 93xxxxxxx закреплён за проверками; dev/purge-test-accounts.js
  // узнаёт их по нему вместе с формой имени и датой.
  const _tg = String(930000000 + (process.pid % 900000));
  const { id: pid } = await tx(t => players.ensure(t, _tg, `${TAG}_victim`));
  made.push(pid);
  await tx(t => players.setClass(t, pid, 'deathknight'));
  const { rows: tgRow } = await pool().query('SELECT telegram_id FROM players WHERE id = $1', [pid]);
  const TID = tgRow[0].telegram_id;

  // ── the door ─────────────────────────────────────────────────────────────
  console.log('  ── вхід ──');
  eq((await api('/admin/stats')).status, 401, 'без входу — 401');

  const wrongUser = await api('/admin/login', {
    method: 'POST', body: JSON.stringify({ username: 'нехто', password: PASSWORD }) });
  eq(wrongUser.status, 401, 'чуже імʼя з правильним паролем — відмова');
  eq(wrongUser.body.error, 'Неверные данные', 'та сама відповідь, що й на невірний пароль — різниця була б оракулом');

  const wrongPass = await api('/admin/login', {
    method: 'POST', body: JSON.stringify({ username: 'checkadmin', password: 'не той' }) });
  eq(wrongPass.status, 401, 'невірний пароль — відмова');

  const good = await api('/admin/login', {
    method: 'POST', body: JSON.stringify({ username: 'checkadmin', password: PASSWORD }) });
  eq(good.status, 200, 'правильна пара пускає');
  ok(!!cookie, 'видано cookie сесії');
  // `/HttpOnly/i.test('')` is false for every input there has ever been, so
  // `=== false` was a constant and the flag half of this assertion was dead —
  // and it could not have worked anyway, because the attributes were discarded
  // by api() before anything could read them. These three are what make the
  // session cookie a session cookie rather than a token in a string: without
  // HttpOnly any XSS on /admin reads it, and without SameSite=Strict a form on
  // another site can make the browser attach it. `Secure` is deliberately not
  // asserted — admin-auth.js adds it only under NODE_ENV=production, and this
  // process runs as test so that it can reach a plain-HTTP local server.
  const raw = setCookieRaw || '';
  ok(/;\s*HttpOnly\b/i.test(raw), 'cookie сесії HttpOnly — сторінковий JS її не прочитає', raw);
  ok(/;\s*SameSite\s*=\s*Strict\b/i.test(raw), 'SameSite=Strict — чужа форма її не причепить', raw);
  ok(/;\s*Path\s*=\s*\/admin\b/i.test(raw), 'Path=/admin — вона не їде на ігрові маршрути', raw);

  // The CSRF header is required on every write. A form posted from another
  // site can carry the cookie but cannot set a header.
  const noCsrf = await fetch(`${BASE}/admin/player/${TID}/ban`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
  });
  eq(noCsrf.status, 403, 'запис без заголовка CSRF відхилено');

  // ── reads ────────────────────────────────────────────────────────────────
  console.log('  ── читання ──');
  const stats = await api('/admin/stats');
  eq(stats.status, 200, 'зведення віддається');
  ok(Number.isFinite(stats.body.total) && Number.isFinite(stats.body.online),
    `лічильники на місці (гравців ${stats.body.total}, онлайн ${stats.body.online})`);
  ok(Array.isArray(stats.body.tops.gold), 'топ за золотом — масив');

  const list = await api(`/admin/players?q=${TAG}`);
  eq(list.status, 200, 'список гравців віддається');
  ok(list.body.players.some(p => p.telegramId === TID), 'пошук за іменем знаходить нашого');

  // The search string is a PARAMETER, not a hand-escaped regex. A pattern that
  // would have been a regex bomb is just text that matches nothing.
  const evil = await api('/admin/players?q=' + encodeURIComponent("%' OR 1=1 --"));
  eq(evil.status, 200, 'спецсимволи в пошуку не ламають запит');
  eq(evil.body.players.length, 0, 'і нічого зайвого не знаходять');

  for (const p of ['/admin/clans', '/admin/market', '/admin/transactions', '/admin/chat',
                   '/admin/items', '/admin/top-referrals', '/admin/top-market', '/admin/special-quests']) {
    eq((await api(p)).status, 200, `${p} віддається`);
  }

  const one = await api(`/admin/player/${TID}`);
  eq(one.status, 200, 'картка гравця віддається');
  ok(one.body.progress && one.body.balances && one.body.items,
    'у картці є прогрес, баланси й речі — усе з бази');

  // ── a grant lands in the ledger ──────────────────────────────────────────
  console.log('  ── видача ──');
  const before = await money.balancesOf(null, pid);
  const give = await api(`/admin/player/${TID}/give`, {
    method: 'POST', body: JSON.stringify({ gold: 500, nexum: 10, gram: 2.5, sp: 3 }) });
  eq(give.status, 200, 'видача прийнята');

  const after = await money.balancesOf(null, pid);
  eq(after.gold, before.gold + 500, 'золото додано');
  eq(after.nexum, before.nexum + 10, 'Liberty додано');
  eq(after.gram, before.gram + 2.5, 'GRAM додано');
  eq((await players.progressOf(null, pid)).bonusSP, 3, 'очки навичок додані');

  const { rows: led } = await pool().query(
    `SELECT currency, delta, reason, ref_id FROM ledger
      WHERE player_id = $1 AND reason = 'admin_give' ORDER BY currency`, [pid]);
  eq(led.length, 3, 'три записи в леджері — по одному на валюту');
  ok(led.every(l => l.ref_id === 'checkadmin'), "у кожному записано, ХТО видав");

  // THE GATE: an admin grant must not read as drift. The old panel wrote the
  // balance column directly, so every gift would have rung the alarm that says
  // money moved outside money.js.
  const drift = (await money.reconcile(null)).filter(d => d.playerId === pid);
  eq(drift.length, 0, 'звірка чиста — видача пройшла ЧЕРЕЗ леджер, а не повз нього');

  // Taking back is a spend, so it cannot drive a balance below zero.
  const overdraw = await api(`/admin/player/${TID}/give`, {
    method: 'POST', body: JSON.stringify({ gold: -999999 }) });
  eq(overdraw.status, 400, 'забрати більше, ніж є, — відмова');
  eq((await money.balancesOf(null, pid)).gold, after.gold, 'баланс не змінився');

  const takeBack = await api(`/admin/player/${TID}/give`, {
    method: 'POST', body: JSON.stringify({ gold: -100 }) });
  eq(takeBack.status, 200, 'забрати частину можна — адмін має могти виправити помилку');
  eq((await money.balancesOf(null, pid)).gold, after.gold - 100, 'списано рівно стільки');

  eq((await api(`/admin/player/${TID}/give`, {
    method: 'POST', body: JSON.stringify({}) })).status, 400, 'порожня видача — відмова');

  // ── items ────────────────────────────────────────────────────────────────
  console.log('  ── предмети ──');
  const giveItem = await api(`/admin/player/${TID}/items`, {
    method: 'POST', body: JSON.stringify({ itemId: 'sw1', qty: 1, enhance: 5 }) });
  eq(giveItem.status, 200, 'предмет видано');
  const inv = await items.inventoryOf(null, pid);
  eq(inv.inventory.filter(i => i.id === 'sw1').length, 1, 'він у інвентарі');
  eq(inv.inventory.find(i => i.id === 'sw1').enhance, 5, 'із заданою заточкою');

  eq((await api(`/admin/player/${TID}/items`, {
    method: 'POST', body: JSON.stringify({ itemId: 'НЕМАЄ_ТАКОГО', qty: 1 }) })).status, 400,
    'вигаданий предмет — відмова, а не рядок із неіснуючим id');

  const rm = await api(`/admin/player/${TID}/items`, {
    method: 'POST', body: JSON.stringify({ itemId: 'sw1', qty: 1, remove: true }) });
  eq(rm.status, 200, 'предмет забрано');
  eq((await items.inventoryOf(null, pid)).inventory.filter(i => i.id === 'sw1').length, 0, 'його більше немає');

  // ── ban ──────────────────────────────────────────────────────────────────
  console.log('  ── бан ──');
  eq((await api(`/admin/player/${TID}/ban`, { method: 'POST' })).status, 200, 'бан прийнято');
  const { rows: banned } = await pool().query('SELECT banned FROM players WHERE id = $1', [pid]);
  eq(banned[0].banned, true, 'позначку записано');
  eq((await api(`/admin/player/${TID}/unban`, { method: 'POST' })).status, 200, 'розбан прийнято');

  // ── everything is audited ────────────────────────────────────────────────
  console.log('  ── журнал дій ──');
  const { rows: audit } = await pool().query(
    `SELECT action FROM admin_actions ORDER BY id DESC LIMIT 20`);
  const seen = new Set(audit.map(a => a.action));
  for (const a of ['login', 'give', 'item_give', 'item_remove', 'ban', 'unban']) {
    ok(seen.has(a), `дію '${a}' записано в журнал`);
  }

  // ── maintenance ──────────────────────────────────────────────────────────
  console.log('  ── обслуговування ──');
  eq((await api('/admin/maintenance')).body.on, false, 'режим вимкнено за замовчуванням');
  await api('/admin/maintenance/on', { method: 'POST' });
  eq((await api('/admin/maintenance')).body.on, true, 'вмикається');
  await api('/admin/maintenance/off', { method: 'POST' });
  eq((await api('/admin/maintenance')).body.on, false, 'і вимикається');

  // ── the token can be revoked ─────────────────────────────────────────────
  console.log('  ── відкликання ──');
  await adminAuth.revokeAll();
  eq((await api('/admin/stats')).status, 401,
    'після відкликання наявний токен більше не працює — це і є кнопка «вигнати всіх»');
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
  await q(`DELETE FROM admin_actions WHERE admin_tg_id = 'checkadmin'`);
  try { await app.shutdown('test', { exit: false }); } catch { /* already down */ }
}

main()
  .catch(err => { fail++; failures.push('НЕОБРОБЛЕНА ПОМИЛКА'); console.error('\n', err); })
  .finally(async () => {
    await cleanup();
    await close().catch(() => {});
    console.log(`\n  ${pass} пройшло, ${fail} впало`);
    if (failures.length) console.log('  впали: ' + failures.join(' · '));
    process.exit(fail ? 1 : 0);
  });
