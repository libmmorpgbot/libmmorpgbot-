#!/usr/bin/env node
'use strict';
// ── End-to-end: does the new server actually serve a player? ────────────────
//
//   DATABASE_URL=... PG_CA_FILE=... TG_BOT_TOKEN=... node dev/boot-check.js
//
// Boots server/app.js in-process, connects a REAL socket.io client, signs real
// Telegram initData with the real bot token, and plays. Nothing is mocked
// except the fact that the player is a script — which is the only way to know
// the wiring is right rather than each piece being right on its own.

const crypto = require('crypto');
const path = require('path');

// A port of its own, so this never collides with a server already running on
// the box. Set BEFORE requiring app.js, which reads it at load.
process.env.PORT = process.env.BOOT_CHECK_PORT || '3998';
process.env.ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET
  || crypto.randomBytes(32).toString('base64url');
// The bot token signs the initData AND verifies it, so for a login test any
// value works as long as it is the same on both sides — the production token
// is deliberately not needed here, and not having it must not make the login
// path untestable. security.js captures this at require time, hence before.
process.env.TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || 'boot-check-throwaway-token';

const io = require('socket.io-client');
const { boot, shutdown, server } = require('../server/app');
const { pool, close } = require('../server/db');

let pass = 0, fail = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);

const TAG = 'boot-' + String(process.pid).slice(-5);
const TG_ID = '9' + String(process.pid).padStart(9, '0');

// Real initData, signed the way Telegram signs it. The server verifies it with
// verifyTelegramWebApp and has no idea this is a test — which is the point.
function signInitData(token, user) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify(user),
  });
  const checkStr = [...params.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(checkStr).digest('hex'));
  return params.toString();
}

const once = (sock, ev, ms = 8000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`таймаут очікування '${ev}'`)), ms);
  sock.once(ev, d => { clearTimeout(t); res(d); });
});

async function main() {
  console.log(`\nboot-check  (${TAG})\n`);
  await boot();

  const url = `http://127.0.0.1:${process.env.PORT}`;

  // ── health ───────────────────────────────────────────────────────────────
  const h = await (await fetch(`${url}/health`)).json();
  eq(h.ok, true, '/health повідомляє, що база доступна');
  ok(h.uptimeS === undefined, '/health без токена НЕ віддає операційні деталі');

  const ready = await fetch(`${url}/health/ready`);
  eq(ready.status, 200, '/health/ready віддає 200');

  // ── login ────────────────────────────────────────────────────────────────
  const token = process.env.TG_BOT_TOKEN;

  const sock = io(url, { transports: ['websocket'], forceNew: true });
  await once(sock, 'connect');
  ok(true, 'сокет підключився');

  // A forged initData must be refused — the signature is the only thing
  // standing between a socket and someone else's account.
  sock.emit('loginTelegramWebApp', { initData: 'user=%7B%22id%22%3A1%7D&hash=deadbeef' });
  const bad = await once(sock, 'authError');
  ok(!!bad, 'підроблений initData відхилено');

  sock.emit('loginTelegramWebApp', {
    initData: signInitData(token, { id: Number(TG_ID), username: `${TAG}_u` }),
  });
  const auth = await once(sock, 'authOk');
  ok(!!auth, 'справжній initData прийнято');
  eq(auth.isNewAccount, true, 'акаунт створено як новий');

  // The whole state arrives from the database, not as a blob the client sent.
  ok(auth.progress && auth.progress.lvl === 1, 'прогрес прийшов з бази (рівень 1)');
  ok(auth.items && Array.isArray(auth.items.inventory), 'інвентар прийшов з бази');
  ok(auth.balances && auth.balances.gram === 0, 'баланси прийшли з бази');
  ok(auth.stats && auth.stats.atk > 0, `стати ПОРАХОВАНІ СЕРВЕРОМ (atk ${auth.stats && auth.stats.atk})`);
  ok(auth.prefs && auth.prefs.lang === 'ru', 'налаштування прийшли з бази');

  // ── the only client-writable surface ─────────────────────────────────────
  sock.emit('savePrefs', { prefs: { lang: 'uk', autoHpPct: 0.7 } });
  const prefs = await once(sock, 'prefsSync');
  eq(prefs.lang, 'uk', 'дозволене поле налаштувань збережено');
  eq(prefs.autoHpPct, 0.7, 'і друге теж');

  // The exploit, through the live socket this time.
  sock.emit('savePrefs', { prefs: { gold: 999999, lvl: 999, 'vipPending.0': 10 } });
  await once(sock, 'prefsSync');
  const { rows } = await pool().query(`
    SELECT pr.lvl, COALESCE(b.amount, 0) AS gold, v.pending
      FROM players p
      JOIN player_progress pr ON pr.player_id = p.id
      JOIN player_vip v ON v.player_id = p.id
      LEFT JOIN balances b ON b.player_id = p.id AND b.currency = 'gold'
     WHERE p.telegram_id = $1`, [TG_ID]);
  eq(rows[0].lvl, 1, 'рівень через сокет не переписався');
  eq(Number(rows[0].gold), 0, 'золото через сокет не з’явилось');
  eq(rows[0].pending.length, 0, 'dot-path у VIP через сокет не спрацював');

  // ── an economy action end to end ─────────────────────────────────────────
  const { rows: pid } = await pool().query('SELECT id FROM players WHERE telegram_id = $1', [TG_ID]);
  const playerId = Number(pid[0].id);
  const items = require('../server/db/repos/items');
  const { tx } = require('../server/db');
  const rowId = await tx(async t => { await items.lockPlayer(t, playerId); return items.add(t, playerId, 'sw1'); });

  sock.emit('equipItem', { id: rowId, slot: 'weapon' });
  const inv = await once(sock, 'inventorySync');
  ok(inv.equipment && inv.equipment.weapon, 'предмет вдягнено через сокет');
  const st = await once(sock, 'statsSync');
  ok(st.atk > auth.stats.atk, `стати перерахував СЕРВЕР після вдягання (${auth.stats.atk} → ${st.atk})`);

  // Equipping something that is not theirs.
  sock.emit('equipItem', { id: 999999999, slot: 'weapon' });
  const e = await once(sock, 'itemError');
  ok(!!e, 'чужий/неіснуючий рядок відхилено з поясненням');

  // ── the handlers ported in this pass ─────────────────────────────────────
  console.log('  ── прогресія і соціальне ──');

  // Studying without the book must refuse, and must not silently half-apply.
  sock.emit('learnSkill', { key: 'Q' });
  const noBook = await once(sock, 'skillError');
  ok(!!noBook, 'вивчити навичку без книги — відмова з поясненням');

  // Rating reads a stored column, not thirty numbers derived per row.
  sock.emit('getRating', { kind: 'players' });
  const rating = await once(sock, 'rating');
  ok(Array.isArray(rating.rows), 'рейтинг гравців віддається');

  sock.emit('seasonRating', {});
  const season = await once(sock, 'seasonRating');
  ok(season.board && season.me, 'сезонна таблиця і власне місце віддаються');

  // Chat: the message comes back escaped of control characters and bounded.
  sock.emit('chat', { text: 'привет [31m ' + 'x'.repeat(300) });
  const msg = await once(sock, 'chatMsg');
  ok(msg.text.length <= 100, `повідомлення обрізане до ${msg.text.length} символів`);
  ok(!/[ -]/.test(msg.text), 'керуючі символи вирізані');

  // The cooldown is the security control here: this reaches every player.
  sock.emit('chat', { text: 'второе подряд' });
  const flooded = await once(sock, 'chatMsg', 1500).catch(() => null);
  ok(!flooded, 'друге повідомлення поспіль відкинуто кулдауном');

  // A clan needs gold the account does not have — refusal, and no clan.
  sock.emit('clanCreate', { name: 'TST', icon: 3 });
  const clanErr = await once(sock, 'clanError');
  ok(!!clanErr, `клан без золота — відмова (${clanErr.msg})`);

  sock.emit('clanRequest', {});
  const clanData = await once(sock, 'clanData');
  eq(clanData, null, 'клану немає, як і має бути після невдалого створення');

  // A profile is answered from the database, not relayed to the other client.
  sock.emit('requestPlayerProfile', { playerId });
  const prof = await once(sock, 'playerProfile');
  ok(prof.profile && prof.profile.atk > 0, 'публічний профіль порахований сервером');

  // ── single session per account ───────────────────────────────────────────
  const second = io(url, { transports: ['websocket'], forceNew: true });
  await once(second, 'connect');
  second.emit('loginTelegramWebApp', {
    initData: signInitData(token, { id: Number(TG_ID), username: `${TAG}_u` }),
  });
  const kicked = await once(sock, 'kicked', 8000).catch(() => null);
  ok(!!kicked, 'другий вхід у той самий акаунт вигнав перший');

  second.close(); sock.close();
}

async function cleanup() {
  const q = (s, p) => pool().query(s, p).catch(() => {});
  const { rows } = await pool().query('SELECT id FROM players WHERE telegram_id = $1', [TG_ID]).catch(() => ({ rows: [] }));
  if (rows.length) {
    const id = [Number(rows[0].id)];
    for (const t of ['player_items', 'player_skills', 'player_vip', 'player_prefs',
                     'player_progress', 'ledger', 'balances', 'gram_tx']) {
      await q(`DELETE FROM ${t} WHERE player_id = ANY($1)`, [id]);
    }
    await q('DELETE FROM players WHERE id = ANY($1)', [id]);
  }
}

main()
  .catch(err => { fail++; failures.push('НЕОБРОБЛЕНА ПОМИЛКА'); console.error('\n', err); })
  .finally(async () => {
    await cleanup();
    try { server.close(); } catch { /* already closing */ }
    await close();
    console.log(`\n  ${pass} пройшло, ${fail} впало`);
    if (failures.length) console.log('  впали: ' + failures.join(' · '));
    process.exit(fail ? 1 : 0);
  });
