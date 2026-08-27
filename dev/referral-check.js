#!/usr/bin/env node
'use strict';
// ── Proof that a referral is registered at all ──────────────────────────────
//
//   DATABASE_URL=... PG_CA_FILE=... node dev/referral-check.js
//
// players.referred_by had NO writer in this build. The column exists, it is
// indexed, and three finished features read it — the 5% commission on an
// invited friend's deposit (repos/gram.js), the season points when that friend
// reaches level 20 (repos/progression.js), the invited-friends list the client
// shows (repos/shop.js) — and all three joined against a column that was empty
// for every real account in the database. The only writer left in the tree was
// the retired Mongo bot poller, and the game bot is not polled here at all
// (server/workers.js polls the operators' bot, deliberately: Telegram allows
// one getUpdates consumer per token).
//
// So there was nothing to see. No error, no refusal, no log line — every
// referral query simply returned zero rows, forever, which is exactly what a
// game with no referrals looks like.
//
// This file asks the two questions that were both answered "no":
//
//   * does registerReferral() write the column, once, for the right person —
//     and refuse, in writing, when it must not
//   * does a REAL LOGIN carrying a real start_param reach it
//   * does the BOT's own /start reach it too — over the webhook, with the
//     secret check that is the only thing standing between a public URL and
//     anybody minting referrals for any pair of accounts they like
//
// The second half is not decoration. The bug was never in the SQL: it was that
// loginTelegramWebApp verified start_param and then dropped it, so a repo-only
// test would have passed on the broken build. It boots server/app.js, signs
// initData the way Telegram signs it, and connects two socket.io clients — an
// inviter and the friend who followed their link.
//
// The third is the classic `?start=ref_<id>` link, which opens the bot's chat
// instead of the game. Those links are still in circulation in old posts and
// old screenshots, where nobody can go back and edit them. They now arrive at a
// webhook, so this file posts real Telegram-shaped updates at it and asks the
// questions a public endpoint has to answer: a wrong secret refused, a missing
// secret refused THE SAME WAY, a retry that doubles nothing, and — the one
// that is easy to get backwards — a /start from somebody who has no account
// yet, which must remember the referrer rather than create half an account for
// them.

// This process must not reach the operators' bot: boot() starts the workers,
// and a second getUpdates poll takes the withdrawal buttons away from the live
// server. Same gate as dev/boot-check.js, set before anything is required.
process.env.OPS_LIVE = '0';
process.env.NODE_ENV = 'test';
const crypto = require('crypto');

// A port of its own, so this never collides with a server already running on
// the box — or with dev/boot-check.js, which CI runs from the same job.
process.env.PORT = process.env.REFERRAL_CHECK_PORT || '3997';
process.env.ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET
  || crypto.randomBytes(32).toString('base64url');
// The token signs the initData AND verifies it, so any value works as long as
// it is the same on both sides. security.js captures it at require time, hence
// before. The bot NAME is pinned for the same reason the token is: the link
// assertions below name it, and a value inherited from the environment would
// make them pass or fail for a reason that has nothing to do with referrals.
process.env.TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || 'referral-check-throwaway-token';
process.env.TG_BOT_USERNAME = 'referral_check_bot';
delete process.env.TG_MINIAPP_NAME;
// The webhook refuses everything without this, which is the point of it — so
// the value only has to be the same on both sides, like the token above.
process.env.TG_WEBHOOK_SECRET = 'referral-check-webhook-secret';

const ioc = require('socket.io-client');
const { boot, server } = require('../server/app');
const { pool, tx, close } = require('../server/db');
const players = require('../server/db/repos/players');
const shop = require('../server/db/repos/shop');
const prog = require('../server/db/repos/progression');
const plog = require('../server/db/repos/playerlog');
const { refLink } = require('../server/security');
const tgWebhook = require('../server/routes/tg-webhook');
const { SEASON_REF_LEVEL, SEASON_REF_POINTS, seasonActive } = require('../shared/definitions');

let pass = 0, fail = 0, skipped = 0; const failures = [];
function ok(c, name, detail) {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${detail ? ` — ${detail}` : ''}`); }
}
// A question the calendar made impossible to ask is not a question that
// passed — see the same helper in dev/boot-check.js. The season block below is
// the only thing here that can be skipped, and only after 10 Sep 2026.
function skip(name) { skipped++; console.log(`  \x1b[33mSKIP\x1b[0m  ${name} — НЕ перевірено`); }
const eq = (a, b, n) => ok(a === b, n, `очікував ${JSON.stringify(b)}, отримав ${JSON.stringify(a)}`);

const TAG = 'rchk-' + String(process.pid).slice(-5);
// NUMERIC telegram ids, unlike the other detectors' `${TAG}-a` fixtures.
// registerReferral refuses a referrer id that is not digits, because
// start_param is text a player composes themselves and Telegram's own ids are
// int64 — so a fixture with a tagged id would be refused as malformed and the
// file would test its own naming convention instead of the referral.
const PID = String(process.pid).padStart(6, '0').slice(-6);
let _seq = 0;
const nextTg = () => `77${PID}${String(++_seq).padStart(2, '0')}`;

const made = [];
async function mk(nick) {
  const telegramId = nextTg();
  const { id } = await tx(t => players.ensure(t, telegramId, `${TAG}_${nick}`));
  made.push(id);
  return { id, telegramId };
}
// Real initData, signed the way Telegram signs it — including start_param,
// which is the whole point: it is the field the Mini App deep link carries and
// the field loginTelegramWebApp used to throw away.
function signInitData(token, user, startParam) {
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify(user) };
  if (startParam) fields.start_param = startParam;
  const params = new URLSearchParams(fields);
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

// The referral is written AFTER authOk is on the wire, deliberately — a
// referral is a bonus and must never be able to fail a login — so the client's
// acknowledgement says nothing about whether it landed. Waiting for a fixed
// delay would make this file flaky on a slow database and slow on a fast one.
async function until(fn, ms = 6000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await new Promise(r => setTimeout(r, 100));
  }
}

// ── nothing here may reach Telegram ─────────────────────────────────────────
// OPS_LIVE=0 above already shuts every send path, so this catches the case the
// switch does not: a call written somewhere that does not consult it. It fails
// the run rather than quietly succeeding, because "the test messaged a real
// player" is not something that should be discovered from the player.
const _realFetch = globalThis.fetch;
let tgCalls = 0;
globalThis.fetch = async (u, init) => {
  if (String(u).startsWith('https://api.telegram.org/')) {
    tgCalls++;
    throw new Error('тест спробував піти в Telegram');
  }
  return _realFetch(u, init);
};

// What the bot composed, captured at the boundary rather than in Telegram.
// tg-webhook calls `tgGame.send(...)` as a property lookup, so replacing the
// export is enough — the real one still runs behind it, and still refuses to
// send.
const tgGame = require('../server/tg-game');
const { wipeItemsAll } = require('./fixtures');
const sends = [];
const _realSend = tgGame.send;
tgGame.send = async (chatId, html, opts) => {
  sends.push({ chatId: String(chatId), html, buttons: (opts && opts.buttons) || null });
  return _realSend(chatId, html, opts);
};
const lastSendTo = tg => [...sends].reverse().find(s => s.chatId === String(tg)) || null;

// A POST shaped the way Telegram shapes one. `header:false` omits the secret
// entirely, which has to be refused exactly as a wrong one is.
let _upd = 900000;
const nextUpd = () => ++_upd;
async function hook(url, update, { secret, header = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (header) {
    headers['X-Telegram-Bot-Api-Secret-Token'] =
      secret === undefined ? process.env.TG_WEBHOOK_SECRET : secret;
  }
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(update) });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

function startMsg(fromId, param, updateId) {
  return {
    update_id: updateId,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: Number(fromId), type: 'private' },
      from: { id: Number(fromId), is_bot: false, first_name: 'Тест', username: `${TAG}_w` },
      text: param ? `/start ${param}` : '/start',
    },
  };
}

// The route answers 200 BEFORE it does the work, so a refusal has nothing to
// wait for — there is no row that will appear and no row that will not. This
// is the pause that gives a write which should never happen its chance to
// happen anyway.
const settle = (ms = 500) => new Promise(r => setTimeout(r, ms));

const sockets = [];
function connect(url) {
  const s = ioc(url, { transports: ['websocket'], forceNew: true });
  sockets.push(s);
  return s;
}

async function main() {
  console.log(`\nreferral-check  (${TAG})\n`);

  await linkCheck();
  await repoCheck();
  await consequencesCheck();
  await loginCheck();
  await webhookCheck();
}

// ── the link a player copies ────────────────────────────────────────────────
// It pointed at ?start=ref_<id> — the classic bot deep link, whose /start
// message nothing in this build reads. The link and the parameter the server
// reads back are two halves of one contract, and this half was the wrong one.
async function linkCheck() {
  console.log('  ── посилання ──');
  const link = refLink('42');

  ok(link.includes('?startapp=ref_42'),
    `посилання відкриває Mini App із параметром (${link})`);
  ok(!link.includes('?start=ref_'),
    'це НЕ класичне ?start= посилання в чат бота — його нікому читати');
  ok(link.startsWith('https://t.me/referral_check_bot'), 'веде на налаштованого бота');

  // With a short name configured it becomes a Direct Mini App link. Both forms
  // carry start_param; which one a deployment can use is decided in BotFather.
  process.env.TG_MINIAPP_NAME = 'play';
  eq(refLink('42'), 'https://t.me/referral_check_bot/play?startapp=ref_42',
    'із TG_MINIAPP_NAME це пряме посилання на застосунок');
  delete process.env.TG_MINIAPP_NAME;

  // ONE builder. There were two — authOk's and the friends panel's — and the
  // panel asks for its list right after login, so its copy is the one players
  // actually send. Half a fix would have left exactly that half broken.
  const me = await mk('link');
  const view = await shop.referralsOf(null, me.id);
  eq(view.refLink, refLink(me.telegramId),
    'панель друзів віддає ТЕ САМЕ посилання, що й authOk');
}

// ── the write itself ────────────────────────────────────────────────────────
async function repoCheck() {
  console.log('  ── реєстрація ──');
  const ref = await mk('ref');
  const friend = await mk('friend');

  const first = await players.registerReferral(null, friend.id, ref.telegramId);
  ok(first.ok, 'запрошення зареєстровано', JSON.stringify(first));
  eq(first.referrerId, ref.id, 'реферера впізнано за telegram id');
  eq(first.referrerUsername, `${TAG}_ref`, 'ім’я реферера повернуто — його є що показати');

  // The trap this schema sets: referred_by is TEXT and holds a telegram_id.
  // Writing the internal players.id there raises nothing and matches nothing —
  // every reader would just keep returning zero rows, which is the state this
  // whole file exists to end.
  const saved = (await players.byTelegramId(null, friend.telegramId)).referredBy;
  eq(saved, ref.telegramId, 'у колонці лежить TELEGRAM id запрошувача');
  ok(saved !== String(ref.id), 'а не внутрішній id рядка — саме цю підміну ніхто б не помітив');

  console.log('  ── відмови ──');

  // Once, ever. The payouts behind this column are all once-only and none of
  // them can be taken back, so a second link a week later must not move the
  // friend to somebody else.
  const other = await mk('other');
  const again = await players.registerReferral(null, friend.id, other.telegramId);
  eq(again.ok, false, 'друге запрошення того самого гравця — відмова');
  eq(again.reason, 'already', 'і причина названа');
  eq((await players.byTelegramId(null, friend.telegramId)).referredBy, ref.telegramId,
    'перший реферер лишився — переписати його неможливо');

  // The first thing anyone tries.
  const self = await mk('self');
  const s = await players.registerReferral(null, self.id, self.telegramId);
  eq(s.ok, false, 'запрошення самого себе — відмова');
  eq(s.reason, 'self', 'і причина названа');
  eq((await players.byTelegramId(null, self.telegramId)).referredBy, null,
    'і в колонці нічого не з’явилось');

  // A link built from an id nobody here owns.
  const orphan = await mk('orphan');
  const none = await players.registerReferral(null, orphan.id, '7700000000000001');
  eq(none.ok, false, 'запрошувача, якого немає в грі, не зараховано');
  eq(none.reason, 'no_referrer', 'і причина названа');
  eq((await players.byTelegramId(null, orphan.telegramId)).referredBy, null, 'колонка порожня');

  // start_param is text a player composes themselves and it ends up stored on
  // the account and shown to whoever opens the friends panel.
  const junk = await mk('junk');
  for (const bad of ['', '   ', 'abc', '12x34', '-1', '1'.repeat(21), "1'; DROP TABLE players--", null]) {
    const r = await players.registerReferral(null, junk.id, bad);
    eq(r.reason, 'malformed', `кривий параметр ${JSON.stringify(bad)} відхилено`);
  }
  eq((await players.byTelegramId(null, junk.telegramId)).referredBy, null,
    'жодне сміття не потрапило в базу');

  console.log('  ── гонка ──');

  // Two logins for one account arriving together — a refresh, a second device,
  // a client retrying a lost connect. A read followed by a write loses one of
  // them and the second referrer overwrites the first.
  const raced = await mk('raced');
  const r1 = await mk('r1');
  const r2 = await mk('r2');
  const both = await Promise.all([
    players.registerReferral(null, raced.id, r1.telegramId),
    players.registerReferral(null, raced.id, r2.telegramId),
  ]);
  eq(both.filter(x => x.ok).length, 1, 'два одночасні запрошення — проходить РІВНО одне');
  const won = (await players.byTelegramId(null, raced.telegramId)).referredBy;
  ok(won === r1.telegramId || won === r2.telegramId, `реферером став саме той, хто виграв (${won})`);
  eq(both.find(x => !x.ok).reason, 'already', 'той, хто програв, отримав зрозумілу причину');
}

// ── what the column was for ─────────────────────────────────────────────────
// Three features read referred_by and all three were dead for want of a
// writer. Two of them are checkable here without a wallet or a chain; the
// deposit commission is dev/gram-check.js's, and it seeds the column by hand —
// which is precisely why it stayed green while nothing wrote it.
async function consequencesCheck() {
  console.log('  ── наслідки ──');
  const ref = await mk('cref');
  const friend = await mk('cfriend');
  ok((await players.registerReferral(null, friend.id, ref.telegramId)).ok, 'друга запрошено');

  const view = await shop.referralsOf(null, ref.id);
  ok(view.friends.some(f => f.username === `${TAG}_cfriend`),
    'запрошений з’явився у списку друзів — панель більше не порожня');

  if (!seasonActive()) {
    skip('сезонний бонус за друга, який дійшов до 20 рівня');
    return;
  }
  const bonus = await tx(t => prog.payReferralOnLevel(t, friend.id, SEASON_REF_LEVEL));
  ok(bonus !== null, 'друг дійшов до 20 рівня — реферер отримав нарахування');
  eq(bonus && bonus.referrerTelegramId, ref.telegramId, 'нарахування адресоване саме запрошувачу');
  eq((await prog.seasonOf(null, ref.id)).points, SEASON_REF_POINTS, 'бали сезону нараховані');
}

// ── the wiring, through a real login ────────────────────────────────────────
// The bug was here and not in the SQL: verifyTelegramWebApp returned
// { user, startParam } and loginTelegramWebApp used only the first half. A
// repo-only test passes on that build, so this one signs real initData with a
// real start_param and lets the server do the rest.
async function loginCheck() {
  console.log('  ── справжній вхід ──');
  await boot();
  const url = `http://127.0.0.1:${process.env.PORT}`;
  const token = process.env.TG_BOT_TOKEN;

  const refTg = nextTg();
  const friendTg = nextTg();
  const selfTg = nextTg();

  // The inviter logs in first — both because the referrer has to exist before
  // a link to them means anything, and because their socket is where the
  // "friend joined" notice has to arrive.
  const a = connect(url);
  await once(a, 'connect');
  a.emit('loginTelegramWebApp', {
    initData: signInitData(token, { id: Number(refTg), username: `${TAG}_ea` }),
  });
  await once(a, 'authOk');
  ok(true, 'запрошувач увійшов');

  // Registered BEFORE the friend's login is sent: the notice can arrive before
  // that login's own authOk does, and a listener attached afterwards would
  // miss it and time out on something that worked.
  const joined = once(a, 'friendJoined', 10000);

  const b = connect(url);
  await once(b, 'connect');
  const bAuth = once(b, 'authOk', 10000);
  b.emit('loginTelegramWebApp', {
    initData: signInitData(token, { id: Number(friendTg), username: `${TAG}_eb` }, `ref_${refTg}`),
  });
  const auth = await bAuth;
  eq(auth.isNewAccount, true, 'друг зайшов за посиланням уперше');
  ok(String(auth.refLink || '').includes('?startapp=ref_'),
    'і сам отримав робоче посилання, щоб кликати далі');

  const notice = await joined.catch(() => null);
  eq(notice && notice.username, `${TAG}_eb`, 'запрошувачу відразу сказали, хто прийшов');

  // THE assertion. If loginTelegramWebApp stops passing start_param on, or
  // registerReferral stops writing, this is the line that goes red.
  const written = await until(async () =>
    (await players.byTelegramId(null, friendTg)).referredBy);
  eq(written, refTg, 'справжній вхід за посиланням записав реферера');

  const friend = await players.byTelegramId(null, friendTg);
  const referrer = await players.byTelegramId(null, refTg);
  made.push(friend.id, referrer.id);

  // ── and it left a trace ──────────────────────────────────────────────────
  // The standing rule in this project is that every failure leaves something
  // an operator can see, refusals included. A referral that did not take is
  // the thing players ask about, and before this there was nothing to answer
  // with: no row, no line, no counter.
  await plog.flush();
  const rows = await plog.recent(null, friend.id, 50);
  const hit = rows.find(r => r.event === 'referralRegistered');
  ok(!!hit, 'вдала реєстрація записана в журнал гравця');
  eq(hit && hit.meta && hit.meta.refId, refTg, 'у записі видно, ХТО запросив');

  // A refusal is a row too. Self-referral is the one every player tries and
  // the one that used to vanish without trace.
  const c = connect(url);
  await once(c, 'connect');
  const cAuth = once(c, 'authOk', 10000);
  c.emit('loginTelegramWebApp', {
    initData: signInitData(token, { id: Number(selfTg), username: `${TAG}_ec` }, `ref_${selfTg}`),
  });
  await cAuth;
  const selfPlayer = await players.byTelegramId(null, selfTg);
  made.push(selfPlayer.id);
  const refused = await until(async () => {
    await plog.flush();
    return (await plog.recent(null, selfPlayer.id, 50))
      .find(r => r.event === 'refuse:referralRegistered');
  });
  ok(!!refused, 'відмова теж записана — у тій самій формі, що й решта відмов');
  eq(refused && refused.meta && refused.meta.code, 'self', 'і в ній названо причину');
  eq((await players.byTelegramId(null, selfTg)).referredBy, null,
    'і нічого не записано в колонку');

  for (const s of sockets) s.close();
}

// ── the classic link, through the bot ───────────────────────────────────────
// `t.me/<bot>?start=ref_<id>` opens the BOT'S CHAT and the referral arrives on
// the /start message that follows. Nothing read that message: workers.js polls
// getUpdates for the OPERATORS' bot and only that one, because Telegram allows
// one consumer per token. The webhook (server/routes/tg-webhook.js) is what
// reads it now, and this is the half of the file that proves it — including
// the two things a public POST endpoint has to get right before anything else
// about it matters.
async function webhookCheck() {
  console.log('  ── вебхук бота ──');
  const url = `http://127.0.0.1:${process.env.PORT}${tgWebhook.PATH}`;

  // ── the reply itself ─────────────────────────────────────────────────────
  // Checked directly, because the send is gated (see the end of this function)
  // and a test can never see the message that would have gone out. The BUTTON
  // is the load-bearing part: for somebody with no account yet the referrer
  // cannot be written anywhere durable, so the only thing that carries it to
  // their first launch is that this button is a real ?startapp= deep link
  // rather than a plain game URL.
  const carried = tgWebhook._welcome('Имя', 'inviter', refLink('777'));
  const btn = carried.buttons[0][0];
  eq(btn.url, refLink('777'), 'кнопка «Играть» несе реферала у start_param');
  ok(!btn.web_app,
    'і це URL-кнопка, а не web_app — web_app відкриває сторінку і start_param не доносить');
  ok(carried.text.includes('inviter'), 'у привітанні названо, хто запросив');

  process.env.GAME_URL = 'https://example.invalid/game';
  const plain = tgWebhook._welcome('Имя', '', '');
  ok(plain.buttons[0][0].web_app
     && plain.buttons[0][0].web_app.url === 'https://example.invalid/game',
    'без реферала кнопка відкриває гру просто в чаті');
  delete process.env.GAME_URL;

  // An unbalanced tag makes Telegram reject the WHOLE message with a 400, so
  // an unescaped first_name is a /start that answers nothing at all.
  ok(tgWebhook._welcome('<b>x</b>', '', '').text.includes('&lt;b&gt;x&lt;/b&gt;'),
    'ім’я з розмітки екрановане — інакше Telegram відкине все повідомлення');

  // ── a valid call registers ───────────────────────────────────────────────
  const ref = await mk('wref');
  const friend = await mk('wfriend');
  const firstUpd = nextUpd();
  const okRes = await hook(url, startMsg(friend.telegramId, `ref_${ref.telegramId}`, firstUpd));
  eq(okRes.status, 200, 'валідний виклик прийнято');

  const written = await until(async () =>
    (await players.byTelegramId(null, friend.telegramId)).referredBy);
  eq(written, ref.telegramId, '/start ref_<id> у бота записав реферера');

  const hit = await until(async () => {
    await plog.flush();
    return (await plog.recent(null, friend.id, 50)).find(r => r.event === 'referralRegistered');
  });
  ok(!!hit, 'реєстрація через бота записана в журнал гравця');
  eq(hit && hit.meta && hit.meta.via, 'bot',
    'і в записі видно, що вона прийшла з бота, а не із застосунку');
  ok(!!lastSendTo(friend.telegramId), '/start не лишився без відповіді');

  // ── a wrong secret is refused ────────────────────────────────────────────
  // Without this check the URL is a way to mint referrals for any pair of
  // accounts, and referrals pay: 5% of every deposit the invited friend makes,
  // plus season points at level 20. None of it can be taken back.
  console.log('  ── секрет ──');
  const forged = await mk('wforged');
  const before = tgWebhook.status();
  // ASCII, and not by preference: an HTTP header value is a ByteString, so
  // fetch throws on the Cyrillic one that used to be here — which meant this
  // assertion and the three below it never ran at all, and the file reported
  // НЕОБРОБЛЕНА ПОМИЛКА instead of a result. Worth knowing beyond the fix:
  // Telegram cannot send a non-latin-1 secret either, so a secret containing
  // one could never match anything.
  const wrong = await hook(url, startMsg(forged.telegramId, `ref_${ref.telegramId}`, nextUpd()),
    { secret: 'not-the-secret' });
  ok(wrong.status !== 200, `невірний секрет відхилено (${wrong.status})`);
  await settle();
  eq((await players.byTelegramId(null, forged.telegramId)).referredBy, null,
    'і підроблений реферал у базу не потрапив');
  eq(tgWebhook.status().badSecret, before.badSecret + 1,
    'відмову пораховано — це і є сигнал, що URL знайшли');

  // ── a missing secret is refused THE SAME WAY ─────────────────────────────
  // Different shapes for "wrong" and "missing" tell a prober which half they
  // already got right.
  const none = await hook(url, startMsg(forged.telegramId, `ref_${ref.telegramId}`, nextUpd()),
    { header: false });
  eq(none.status, wrong.status, 'відсутній секрет — той самий код, що й невірний');
  eq(JSON.stringify(none.body), JSON.stringify(wrong.body),
    'і та сама відповідь — за нею не видно, що саме не так');
  await settle();
  eq((await players.byTelegramId(null, forged.telegramId)).referredBy, null,
    'і знову нічого не записано');
  eq(tgWebhook.status().badSecret, before.badSecret + 2, 'пораховано й цю відмову');

  // ── self-referral ────────────────────────────────────────────────────────
  console.log('  ── відмови ──');
  const self = await mk('wself');
  await hook(url, startMsg(self.telegramId, `ref_${self.telegramId}`, nextUpd()));
  const refusedSelf = await until(async () => {
    await plog.flush();
    return (await plog.recent(null, self.id, 50)).find(r => r.event === 'refuse:referralRegistered');
  });
  ok(!!refusedSelf, 'самозапрошення через бота відмовлено і записано');
  eq(refusedSelf && refusedSelf.meta && refusedSelf.meta.code, 'self', 'і причина названа');
  eq(refusedSelf && refusedSelf.meta && refusedSelf.meta.via, 'bot', 'і те, що це був бот');
  eq((await players.byTelegramId(null, self.telegramId)).referredBy, null,
    'у колонці нічого не з’явилось');

  // ── a retry must not double anything ─────────────────────────────────────
  // Telegram resends any delivery it did not get a 200 for in time, and "in
  // time" is its judgement, not ours.
  console.log('  ── повтори ──');
  const beforeRetry = tgWebhook.status();
  const retry = await hook(url, startMsg(friend.telegramId, `ref_${ref.telegramId}`, firstUpd));
  eq(retry.status, 200, 'повтор теж отримує 200 — інакше Telegram шле його ще раз');
  await settle();
  eq(tgWebhook.status().deduped, beforeRetry.deduped + 1,
    'той самий update_id відкинуто як дубль');
  eq(tgWebhook.status().registered, beforeRetry.registered,
    'і вдруге нічого не зареєстровано');

  // A genuinely new /start, from a second person's link. Not a duplicate —
  // a rule, and the rule is that the first referrer keeps the friend.
  const other = await mk('wother');
  const already = await until(async () => {
    await hook(url, startMsg(friend.telegramId, `ref_${other.telegramId}`, nextUpd()));
    await plog.flush();
    return (await plog.recent(null, friend.id, 50))
      .find(r => r.event === 'refuse:referralRegistered' && r.meta && r.meta.code === 'already');
  }, 4000);
  ok(!!already, 'друге запрошення того самого гравця відмовлено і записано');
  eq((await players.byTelegramId(null, friend.telegramId)).referredBy, ref.telegramId,
    'перший реферер лишився');

  // ── /start from somebody who has no account yet ──────────────────────────
  // The ordinary case for a link that worked, and the one the retired build
  // handled by creating the account on the spot. It must NOT do that: the
  // client tells "this account is brand new" apart from "this session failed
  // to load" by authOk's isNewAccount, and a row created before the first
  // launch makes that false — after which the class-select screen is skipped
  // and a shared device hands the player the previous account's class
  // (js/network.js, _lastCharTypeKey).
  console.log('  ── ще без акаунта ──');
  const ref2 = await mk('wlate');
  const newcomer = nextTg();
  await hook(url, startMsg(newcomer, `ref_${ref2.telegramId}`, nextUpd()));
  await settle();
  eq(await players.byTelegramId(null, newcomer), null,
    'бот НЕ створює акаунт — перший вхід має лишитись першим');
  ok(tgWebhook._pending.has(newcomer), 'реферера запам’ятано до першого входу');

  // In-memory, so a restart loses it. The BUTTON is the half that does not:
  // a ?startapp= deep link makes the tap that opens the game the same tap that
  // registers the referral, through the signed start_param the Mini App path
  // already reads. A plain game URL — or a web_app button, which opens the page
  // without a start_param — would leave nothing but the map.
  const said = lastSendTo(newcomer);
  ok(!!said, 'на /start бот склав відповідь');
  const playBtn = said && said.buttons && said.buttons[0] && said.buttons[0][0];
  eq(playBtn && playBtn.url, refLink(ref2.telegramId),
    'кнопка «Играть» несе реферера у ?startapp= — це єдине, що переживе перезапуск');
  ok(playBtn && !playBtn.web_app,
    'і це URL-кнопка: web_app відкриває сторінку без start_param');

  const d = connect(`http://127.0.0.1:${process.env.PORT}`);
  await once(d, 'connect');
  const dAuth = once(d, 'authOk', 10000);
  // No start_param at all: this is the player opening the game from the chat
  // list or an old bookmark instead of tapping the button in the welcome
  // message. The referral has to survive that too.
  d.emit('loginTelegramWebApp', {
    initData: signInitData(process.env.TG_BOT_TOKEN,
      { id: Number(newcomer), username: `${TAG}_wl` }),
  });
  const authD = await dAuth;
  eq(authD.isNewAccount, true,
    'для клієнта це справді перший вхід — екран вибору класу покажеться');

  const late = await until(async () =>
    (await players.byTelegramId(null, newcomer)).referredBy);
  eq(late, ref2.telegramId, 'відкладений реферал застосовано при першому вході');
  ok(!tgWebhook._pending.has(newcomer), 'і більше не висить у пам’яті');
  const lateRow = await players.byTelegramId(null, newcomer);
  if (lateRow) made.push(lateRow.id);

  // ── and nothing of this reached a real person ────────────────────────────
  // Every /start above composed a welcome message and handed it to the sender.
  // The gate is what stopped each one, and `skipped` proves the messages were
  // really built rather than the branch never being taken.
  console.log('  ── шлюз ──');
  const st = tgWebhook.status();
  eq(st.send.live, false, 'відправлення гравцям вимкнене при NODE_ENV=test / OPS_LIVE=0');
  ok(st.send.skipped > 0, `привітання складались і затримувались шлюзом (${st.send.skipped})`);
  eq(st.send.sent, 0, 'жодного повідомлення не відправлено');
  eq(tgCalls, 0, 'і жодного звернення до api.telegram.org за весь прогін');

  d.close();
}

async function cleanup() {
  for (const s of sockets) { try { s.close(); } catch { /* already gone */ } }
  if (!made.length) return;
  const q = (s, p) => pool().query(s, p).catch(() => {});
  // player_logs too: this file writes rows there on purpose, and a detector
  // that leaves its own evidence behind makes the next reader's search worse.
  // Предметы — ТЕМИ Ж ДВЕРИМА, якими їх видали. Сирий DELETE лишав у
  // item_ledger видачу без рядків, і нічна звірка справедливо кричала
  // про розходження — 216 пар 27 серпня, усі до одної тестові.
  await wipeItemsAll(made);
  for (const t of ['player_logs', 'player_season', 'player_daily', 'player_skills',
                   'player_vip', 'player_prefs', 'player_progress', 'ledger', 'balances']) {
    await q(`DELETE FROM ${t} WHERE player_id = ANY($1)`, [made]);
  }
  await q('DELETE FROM players WHERE id = ANY($1)', [made]);
}

main()
  .catch(err => { fail++; failures.push('НЕОБРОБЛЕНА ПОМИЛКА'); console.error('\n', err); })
  .finally(async () => {
    await cleanup();
    try { server.close(); } catch { /* never listened, or already closing */ }
    await close();
    console.log(`\n  ${pass} пройшло, ${fail} впало${skipped ? `, ${skipped} пропущено (НЕ перевірено)` : ''}`);
    if (failures.length) console.log('  впали: ' + failures.join(' · '));
    process.exit(fail ? 1 : 0);
  });
