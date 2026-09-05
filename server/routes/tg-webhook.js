'use strict';
// ── The game bot's own updates ──────────────────────────────────────────────
//
// The link a player hands to a friend is `t.me/<bot>?startapp=ref_<id>`
// (refLink, server/security.js): it opens the Mini App and Telegram delivers
// the referrer as initData's start_param, which finishLogin registers. That
// half works.
//
// The CLASSIC link — `t.me/<bot>?start=ref_<id>` — opens the BOT'S CHAT, and
// the referral rides in on the /start message that follows. Nothing in this
// build read that message. server/workers.js polls getUpdates for the
// OPERATORS' bot and only that one, deliberately: Telegram allows exactly ONE
// getUpdates consumer per token, and a second poller took the withdrawal
// buttons away from the live server for as long as it ran. So every classic
// link ever handed out was inert — and they are still in circulation, in old
// posts and old screenshots, where nobody can go back and edit them.
//
// A WEBHOOK is not a second consumer. Webhook and getUpdates are mutually
// exclusive PER TOKEN, and the game bot's token has neither today, so this
// takes nothing away from the ops bot — which keeps its poller untouched.
//
// The one way that stops being true is a deployment where TG_OPS_BOT_TOKEN is
// the same value as TG_BOT_TOKEN, one bot doing both jobs. There, setWebhook
// on "the game bot" silently ends the ops bot's getUpdates and the withdrawal
// buttons stop answering with nothing anywhere saying why. That is checked at
// mount and said out loud, because the alternative is an operator discovering
// it from a player who did not get paid.
//
// ── what answers, and when ─────────────────────────────────────────────────
// Telegram RETRIES any delivery that is not answered 200 quickly, and it keeps
// retrying. Both halves of that are handled, because either alone is thin:
//
//   * the request is answered 200 before any work starts, so a slow database
//     cannot turn one /start into a queue of duplicates, and
//   * the work is idempotent anyway — an update_id that has already been
//     handled is dropped before it can do anything, and the registration
//     itself is a single conditional UPDATE that refuses a second referrer
//     (repos/players.js registerReferral).

const ops = require('../tg-ops');
const tgGame = require('../tg-game');
const players = require('../db/repos/players');
const plog = require('../db/repos/playerlog');
const { _safeEqual, _tgEsc, refLink, miniAppLink } = require('../security');

// Fixed, not configurable. A secret path and a secret token are two things to
// keep in step, and the one that can drift is the one that breaks the day
// somebody rotates it — while the token is the thing actually standing between
// this route and a forged referral.
const PATH = '/tg-webhook';

const HEADER = 'x-telegram-bot-api-secret-token';

// ── counters ────────────────────────────────────────────────────────────────
// Read off /health. `badSecret` is the one that matters most and is the least
// likely to be looked for: this is a public URL, and a rising count there is
// the signal that somebody has found it and is posting fabricated updates at
// it. Every other number exists so that "рефералка через бота не работает" has
// an answer that is not a guess.
const _stats = {
  received: 0,      // updates that passed the secret check
  deduped: 0,       // a retry of an update already handled
  ignored: 0,       // not a /start we act on (another command, a group, a bot)
  registered: 0,
  refused: 0,       // registerReferral said no, and said why
  deferred: 0,      // no account yet — remembered for first login
  applied: 0,       // ...and later taken by that login
  expired: 0,       // ...or aged out before any login came
  badSecret: 0,
  unconfigured: 0,  // TG_WEBHOOK_SECRET not set — every delivery refused
  failed: 0,
};

// ── retries must not double anything ────────────────────────────────────────
// Telegram resends an update it did not get a 200 for, and "did not get"
// includes a 200 that arrived after its patience ran out. The registration
// below is idempotent on its own, but the WELCOME REPLY is not: without this
// the retry of a slow delivery is a second message in the player's chat.
const SEEN_MAX = 5000;
const _seen = new Set();
function firstTime(updateId) {
  if (!Number.isFinite(updateId)) return true;   // nothing to dedupe on
  if (_seen.has(updateId)) return false;
  _seen.add(updateId);
  // Insertion-ordered, so the first value is the oldest.
  if (_seen.size > SEEN_MAX) _seen.delete(_seen.values().next().value);
  return true;
}

// ── a referral from somebody who has no account yet ─────────────────────────
// /start is very often a person's FIRST contact — they tapped a friend's link,
// Telegram opened the bot's chat, they pressed START, and there is no players
// row for them. registerReferral answers `no_player` to that, correctly: it
// writes a column on a row, and there is no row.
//
// The retired build (git show HEAD~4:server/telegram-bot.js) created the
// account right there. That is NOT done here, and the reason is written down
// in the client: js/network.js's authOk handler clears the remembered class
// only when `isNewAccount` is true, and _emitSaveProgress refuses to persist a
// blank state for an account the server says already exists. Pre-creating the
// row makes isNewAccount FALSE on that player's first real launch — so on a
// shared device they inherit the previous account's class and are never shown
// the selection screen (the comment at _lastCharTypeKey describes exactly this
// happening), and their genuinely-empty first save is refused as if it were a
// failed restore. Trading a character-creation bug for a referral is not a
// trade worth making.
//
// So the referrer is REMEMBERED and applied at first login instead — which is
// also where the app-side path already registers referrals, so both roads end
// at the same function with the same logging.
//
// Two carriers, because one is not enough:
//
//   1. the welcome message's button is `?startapp=ref_<id>` rather than a bare
//      game link, so tapping it opens the Mini App with a SIGNED start_param
//      and the referral registers through the path that already works. This
//      one survives a restart, a redeploy, and a week of the player not
//      getting round to it.
//   2. this map, for the player who reaches the game some other way — an old
//      bookmark, the chat list, Telegram's search. In memory, like the login
//      failure counters in security.js, and lost on restart for the same
//      reason: a table would need a migration, and a migration on this
//      database can only be applied by the owner with a password nobody else
//      has (dev/ETL-RUNBOOK.md). Code that writes to a table which may not
//      exist yet is a referral dropped for a reason no operator can see, which
//      is the failure this whole file exists to end.
const PENDING_TTL_MS = Number(process.env.TG_PENDING_REF_TTL_MS || 7 * 86400000);
const PENDING_MAX = 20000;
const _pending = new Map();      // telegram_id -> { refId, at }

function defer(telegramId, refId) {
  _pending.set(String(telegramId), { refId: String(refId).slice(0, 64), at: Date.now() });
  _stats.deferred++;
  if (_pending.size > PENDING_MAX) _sweepPending();
}

function _sweepPending(now = Date.now()) {
  for (const [k, v] of _pending) {
    if (now - v.at > PENDING_TTL_MS) { _pending.delete(k); _stats.expired++; }
  }
  // Still over the ceiling after dropping the expired ones: shed the oldest
  // rather than grow without bound. Counted as expired, because from the
  // player's side it is the same thing — the referral did not survive.
  while (_pending.size > PENDING_MAX) {
    _pending.delete(_pending.keys().next().value);
    _stats.expired++;
  }
}

// Called by finishLogin (server/app.js) when a login carries no start_param of
// its own. Consumed on read: one login applies it, and a second one does not
// produce a second refusal in that player's log.
function takePendingRef(telegramId) {
  const key = String(telegramId || '');
  const e = _pending.get(key);
  if (!e) return '';
  _pending.delete(key);
  if (Date.now() - e.at > PENDING_TTL_MS) { _stats.expired++; return ''; }
  _stats.applied++;
  // The durable trace is the plog row finishLogin's registerReferral writes a
  // moment later, under the same event name as any other referral. This line
  // is what connects it to the bot: without it, a referral that arrived by
  // /start and one that arrived by ?startapp= are indistinguishable after the
  // fact.
  console.log(`[tg-webhook] ${key}: отложенный реферал применён при первом входе`);
  return e.refId;
}

// ── the reply ───────────────────────────────────────────────────────────────
// Ported in intent from the retired build's _handleBotMessage. Escaped even
// though most of it goes back to the player who typed it: an unbalanced tag
// makes Telegram reject the whole send with a 400, so the welcome message and
// its button would simply never arrive — and a /start that answers nothing is
// the dead end this is here to close.
//
// The channel and chat links are the ones the retired build shipped, and both
// are overridable: an invite link expires, and a button that leads to an
// expired invite is worse than no button.
function welcome(firstName, referrerName, playLink) {
  const greeting = firstName
    ? `👋 Привет, <b>${_tgEsc(firstName)}</b>!`
    : '👋 Добро пожаловать!';
  const lines = [
    greeting,
    '',
    '⚔️ <b>Liberty</b> — мобильная MMORPG прямо в Telegram.',
    '',
    '🗡 Исследуй подземелья и уничтожай врагов',
    '🏆 Соревнуйся в рейтинге игроков',
    '🛡 Вступай в кланы и ходи в рейды',
    '💎 Улучшай снаряжение и прокачивай персонажа',
  ];
  if (referrerName) {
    lines.push('', `🎁 Вас пригласил @${_tgEsc(referrerName)} — играйте вместе и зарабатывайте бонусы!`);
  }
  lines.push('', '▶️ Нажми кнопку ниже, чтобы начать!');

  const gameUrl = process.env.GAME_URL || '';
  // playLink is set only when a referral is waiting for this player's first
  // login: it is `?startapp=ref_<id>`, so the tap that opens the game is also
  // the tap that registers the referral, through the signed start_param the
  // Mini App path already reads. Without one, a web_app button is nicer (it
  // opens in place, inside the chat) and a t.me link is the fallback for a
  // deployment that has not set GAME_URL.
  const play = playLink
    ? { text: '🎮 Играть сейчас', url: playLink }
    : (gameUrl
      ? { text: '🎮 Играть сейчас', web_app: { url: gameUrl } }
      : { text: '🎮 Открыть игру', url: miniAppLink() });

  const row2 = [];
  const channel = process.env.TG_CHANNEL_URL || 'https://t.me/Libertymmo';
  const chat = process.env.TG_CHAT_URL || 'https://t.me/+PrFI0HWtRi02NGU0';
  if (channel) row2.push({ text: '📢 Канал', url: channel });
  if (chat) row2.push({ text: '💬 Чат', url: chat });

  return { text: lines.join('\n'), buttons: row2.length ? [[play], row2] : [[play]] };
}

// ── one /start ──────────────────────────────────────────────────────────────
function mount(app, deps = {}) {
  const { io } = deps;

  // ── one bot cannot be polled AND hooked ──────────────────────────────────
  // Said at mount, in the log and in the alerts topic, because the damage this
  // prevents happens somewhere else entirely: the operator runs setWebhook,
  // Telegram drops the getUpdates consumer for that token, and the withdrawal
  // buttons stop answering. Nothing on the server errors, nothing retries —
  // the poller simply stops receiving anything.
  const gameTok = process.env.TG_BOT_TOKEN || '';
  const opsTok = process.env.TG_OPS_BOT_TOKEN || '';
  if (gameTok && opsTok && gameTok === opsTok) {
    console.error('[tg-webhook] TG_OPS_BOT_TOKEN совпадает с TG_BOT_TOKEN — '
      + 'setWebhook для игрового бота отключит getUpdates опс-бота (кнопки выводов, /admin)');
    ops.alert('tg.webhook.same-token', 'Опс-бот и игровой бот — один и тот же бот',
      'Telegram допускает либо webhook, либо getUpdates на один токен. '
      + 'Пока эти два токена совпадают, включённый вебхук игрового бота отбирает '
      + 'опрос у опс-бота: кнопки выводов и /admin перестают отвечать. '
      + 'Заведите отдельного бота для операций (TG_OPS_BOT_TOKEN).').catch(() => {});
  }

  if (!process.env.TG_WEBHOOK_SECRET) {
    // Mounted anyway. A route that is simply absent answers 404, which in
    // getWebhookInfo reads as "you deployed the wrong build" — this way the
    // refusal names its own cause on the very first delivery.
    console.error('[tg-webhook] TG_WEBHOOK_SECRET не задан — все обращения к '
      + `${PATH} будут отклонены`);
  }

  app.post(PATH, (req, res) => {
    const secret = process.env.TG_WEBHOOK_SECRET || '';
    if (!secret) {
      _stats.unconfigured++;
      ops.alert('tg.webhook.unconfigured', 'Вебхук бота не настроен',
        `TG_WEBHOOK_SECRET не задан, а Telegram уже шлёт апдейты на ${PATH}. `
        + 'Пока переменной нет, ни один /start не будет обработан.').catch(() => {});
      return res.status(503).json({ ok: false });
    }

    // ── the whole of the authentication ──────────────────────────────────
    // A webhook URL is a public endpoint. Without this check anyone who
    // guesses the path can post a fabricated `/start ref_<id>` naming any two
    // accounts they like and mint referrals — and referrals pay: 5% of an
    // invited friend's every deposit (repos/gram.js), season points at level
    // 20 (repos/progression.js). None of it can be taken back afterwards.
    //
    // Normalised to '' first so that a MISSING header and a WRONG one take
    // the same path and produce the same answer. A refusal that is shaped
    // differently for the two tells a prober which half they got right.
    const given = typeof req.headers[HEADER] === 'string' ? req.headers[HEADER] : '';
    if (!_safeEqual(given, secret)) {
      _stats.badSecret++;
      // Counted AND alerted. This is the one number here that is a security
      // signal rather than a diagnostic: Telegram always sends the header it
      // was given at setWebhook time, so anything reaching this line is not
      // Telegram. The per-key throttle inside alert() collapses a scan into
      // one message and a count.
      console.warn(`[tg-webhook] отказ: неверный секрет (${req.ip || 'ip?'})`);
      ops.alert('tg.webhook.secret', 'Чужой запрос на вебхук бота',
        'Пришёл POST без правильного X-Telegram-Bot-Api-Secret-Token. '
        + 'Telegram всегда шлёт заданный при setWebhook секрет, значит это не Telegram.',
        { адрес: String(req.ip || '').slice(0, 45),
          браузер: String(req.headers['user-agent'] || '').slice(0, 120) || undefined,
        }).catch(() => {});
      return res.status(403).json({ ok: false });
    }

    _stats.received++;
    // ANSWERED FIRST. Everything below can touch the database, and Telegram
    // stops waiting long before a slow query does — a retry storm on a busy
    // moment would then be the thing that made the moment busy.
    res.status(200).json({ ok: true });

    handleUpdate(req.body, io).catch((err) => {
      _stats.failed++;
      // The response is already sent, so express's error handler can never see
      // this one. It is the only path on which a referral is lost to a fault
      // rather than to a rule, and it is invisible from both sides: the
      // invited player is told nothing, the referrer is simply never paid.
      console.error('[tg-webhook] update:', err);
      ops.alertError('tg.webhook.update', 'Ошибка обработки апдейта бота', err)
        .catch(() => {});
    });
  });

  console.log(`tg-webhook: POST ${PATH}`
    + (process.env.TG_WEBHOOK_SECRET ? '' : ' (СЕКРЕТ НЕ ЗАДАН — всё будет отклонено)'));
}

async function handleUpdate(upd, io) {
  const msg = upd && upd.message;
  // allowed_updates is set to ["message"] at setWebhook time, so anything else
  // arriving here is either a leftover from an earlier configuration or not
  // Telegram's doing. Dropped, but only after the dedupe below has claimed the
  // id — otherwise a retry of it would be counted as new forever.
  if (!firstTime(Number(upd && upd.update_id))) { _stats.deduped++; return; }
  if (!msg) { _stats.ignored++; return; }

  // Only a private chat, and only a human. A bot added to a group where
  // somebody types /start is not somebody accepting an invitation.
  if (msg.chat && msg.chat.type && msg.chat.type !== 'private') { _stats.ignored++; return; }
  if (msg.from && msg.from.is_bot) { _stats.ignored++; return; }

  const text = String(msg.text || '');
  // `/start`, `/start ref_1`, `/start@LibertyMMORPGbot ref_1`. Anything else is
  // not ours: the ops bot's commands live on a different token entirely, and a
  // command this build does not know must be ignored rather than answered
  // wrongly (the same rule server/workers.js applies to its own updates).
  if (!/^\/start(?:@\S+)?(?:\s|$)/.test(text)) { _stats.ignored++; return; }

  const fromId = String((msg.from && msg.from.id) || '');
  if (!fromId) { _stats.ignored++; return; }

  const param = text.trim().split(/\s+/)[1] || '';
  const refId = param.startsWith('ref_') ? param.slice(4) : '';
  const firstName = (msg.from && msg.from.first_name) || '';

  let referrerName = '';
  let playLink = '';

  if (refId) {
    const me = await players.byTelegramId(null, fromId);
    if (me) {
      referrerName = await registerFor(me, refId, io);
    } else {
      // No account yet — the ordinary case for a link that worked. See the
      // long note above defer() for why the row is NOT created here.
      defer(fromId, refId);
      // Only the button can carry it across a restart, so it is built from the
      // SAME refLink() the app uses: one definition of the link shape, and it
      // is already the one the Mini App path knows how to read.
      playLink = refLink(refId);
      const referrer = await players.byTelegramId(null, refId).catch(() => null);
      referrerName = (referrer && referrer.username) || '';
      console.log(`[tg-webhook] ${fromId}: реферал ${refId} отложен до первого входа`
        + (referrer ? '' : ' (такого игрока пока нет — решит вход)'));
    }
  }

  const w = welcome(firstName, referrerName, playLink);
  await tgGame.send(fromId, w.text, { buttons: w.buttons });
}

// ── the write ───────────────────────────────────────────────────────────────
// ONE registerReferral in the build, not two. Everything about who may invite
// whom — once only, never yourself, the referrer must exist, the race between
// two simultaneous logins — lives in repos/players.js and is not restated
// here; this only reports what it decided.
//
// The log lines are byte-for-byte the shape finishLogin writes, plus `via`,
// so a referral that arrived through the bot and one that arrived through the
// Mini App read identically in the admin panel and can still be told apart.
async function registerFor(me, refId, io) {
  const res = await players.registerReferral(null, me.id, refId);
  if (!res.ok) {
    _stats.refused++;
    plog.log(me.id, 'refuse:referralRegistered',
      { code: res.reason, msg: res.msg, refId: res.refId, via: 'bot' });
    console.log(`[tg-webhook] ${me.telegramId}: реферал отклонён — ${res.reason}`);
    return '';
  }
  _stats.registered++;
  plog.log(me.id, 'referralRegistered',
    { refId: res.refId, referrerId: res.referrerId, referrer: res.referrerUsername, via: 'bot' });
  // The referrer is a different session and may be offline entirely; the room
  // emit reaches every device they have open and is dropped when there are
  // none. The referral itself is committed either way. Same shape as
  // finishLogin's, deliberately — the client has one handler for this.
  if (io) io.to(`tg_${res.refId}`).emit('friendJoined', { username: me.username });
  // The bot message reaches them even with no device online — see
  // notifyFriendJoined's own comment in tg-game.js. Fire-and-forget: a DM
  // that fails must not turn a completed referral into a broken /start reply.
  tgGame.notifyFriendJoined(res.referrerId, res.refId, me.username).catch(() => {});
  return res.referrerUsername || '';
}

function status() {
  return {
    path: PATH,
    configured: !!process.env.TG_WEBHOOK_SECRET,
    pending: _pending.size,
    ..._stats,
    // Carried here rather than as a second /health key: "the bot never
    // answered anyone" and "the bot was never asked to" are the two halves of
    // the same question and belong next to each other.
    send: tgGame.status(),
  };
}

module.exports = {
  mount, takePendingRef, status, PATH,
  // The welcome reply is built here and handed to the gated sender, so a test
  // run never sees the message itself. _welcome is what lets one be inspected:
  // the button it carries is the only thing standing between a classic /start
  // link and a referral that dies on the next restart.
  _welcome: welcome,
  // Exported for dev/referral-check.js, which has to reach into the pending
  // map to prove that a referral left for the login path is really sitting
  // there — and to age it on demand rather than waiting a week.
  _pending, _sweepPending,
};
