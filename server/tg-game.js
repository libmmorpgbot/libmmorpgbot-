'use strict';
// ── Talking to a PLAYER, as the game bot ────────────────────────────────────
//
// server/tg-ops.js is the operators' feed and its token is
// `TG_OPS_BOT_TOKEN || TG_BOT_TOKEN`. That fallback is exactly why its dm()
// cannot be reused for a message to a player: on the deployment shape the
// owner runs the ops bot is a SEPARATE bot, so anything sent through it
// arrives from an account the player has never opened a chat with — and
// Telegram refuses every one of those with 403. Silently, because dm() returns
// null on failure and nothing looks at it. A message to a player has to come
// from the bot whose chat they pressed START in, and that is TG_BOT_TOKEN and
// only TG_BOT_TOKEN.
//
// So: one transport, one token, one gate.
//
// ── the gate is the SAME gate, deliberately ────────────────────────────────
// OPS_LIVE exists because every integration test calls app.boot(), and boot()
// starts the workers — so each run announced itself in the operators' channel
// and opened a second getUpdates poll, which takes the withdrawal buttons away
// from the live server. The same sentence with "player" in it is worse, not
// better: a detector that walks the referral flow would send a real welcome
// message, from the real bot, to a real person, in the middle of a test run.
//
// Reusing OPS_LIVE rather than inventing a TG_GAME_LIVE beside it means there
// is ONE switch to get wrong instead of two, and everything already sets it:
// dev/sync.sh overrides `NODE_ENV=test OPS_LIVE=0` after sourcing the
// production env, and every detector that boots a server repeats that at the
// top of its own file. A new variable would have been unset in all of them.
const ops = require('./tg-ops');
const players = require('./db/repos/players');
const { _tgEsc } = require('./security');

// Read at CALL time, not at module load — the same trap tg-ops.js documents
// for isLive(). A constant computed on require() depends on whether the caller
// set the variable before or after the first import of this file, which is an
// ordering nobody can see and every test would get wrong once.
function token() { return process.env.TG_BOT_TOKEN || ''; }

function isLive() {
  const on = process.env.OPS_LIVE === '1'
    || (process.env.OPS_LIVE !== '0' && process.env.NODE_ENV === 'production');
  return on && !!token();
}

// sent — reached the player
// skipped — the gate was shut (a test run, or no token configured)
// blocked — Telegram said no, and the player is the reason: they never pressed
//           START, or they blocked the bot. Not a fault.
// failed — anything else
const _stats = { sent: 0, skipped: 0, blocked: 0, failed: 0 };

async function _api(method, body) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token()}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch (err) {
    // Never throw out of here — same rule as tg-ops._api. A welcome message
    // that could not be sent must not become an exception inside whatever was
    // trying to send it.
    console.error('[tg-game]', method, err.message);
    return { ok: false, description: err.message };
  }
}

// Returns a described outcome rather than tg-ops's null-on-anything: a caller
// that wants to know whether the player actually heard from the bot — and
// dev/referral-check.js, which has to prove that a test run heard nothing at
// all — cannot tell "the gate was shut" from "Telegram refused" if both are
// null.
//
// ── the permission gate is the CALLER'S, not this function's ───────────────
// players.canMessage (repos/players.js, migration 013) records whether a
// player has let the bot write to them, and an UNSOLICITED message must check
// it first. This function deliberately does not, because not every send is
// unsolicited: a reply to the /start the player just typed is Telegram's own
// definition of solicited, needs no grant, and gating it would answer the
// first message anybody ever sends the bot with silence.
async function send(chatId, html, { buttons = null, disablePreview = true } = {}) {
  if (!chatId) return { ok: false, skipped: true, description: 'нет чата' };

  if (!isLive()) {
    _stats.skipped++;
    // Printed rather than swallowed, for the same reason tg-ops prints its
    // held-back sends: a test that expected the bot to answer should be able
    // to see that it tried, and what it would have said. Scrubbed because the
    // text is built from player-supplied names.
    console.log(`[tg-game] (не отправлено, OPS_LIVE выключен) → ${chatId}: `
      + ops.scrub(String(html)).replace(/\n/g, ' ').slice(0, 160));
    return { ok: false, skipped: true, description: 'OPS_LIVE выключен' };
  }

  const body = {
    chat_id: String(chatId),
    // scrub() before anything leaves the process: an error string interpolated
    // into a message can carry the API URL, and that URL carries the token.
    text: ops.scrub(String(html)),
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: disablePreview },
  };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };

  const res = await _api('sendMessage', body);
  if (res.ok) { _stats.sent++; return { ok: true, result: res.result }; }

  const desc = String(res.description || '');
  // 403 is the PLAYER, not a fault. They never pressed START, or they blocked
  // the bot afterwards. Counted and printed so it can be read off /health, and
  // deliberately NOT alerted: it is somebody exercising a choice, and an
  // alerts topic that fills with other people's choices is one nobody reads.
  if (res.error_code === 403
      || /blocked|can't initiate|chat not found|deactivated|user is deactivated/i.test(desc)) {
    _stats.blocked++;
    console.log(`[tg-game] ${chatId}: не доставлено — ${desc}`);
    return { ok: false, blocked: true, description: desc };
  }

  _stats.failed++;
  console.error(`[tg-game] ${chatId}: НЕ ОТПРАВЛЕНО (${desc})`);
  // A bot that cannot write to anyone is a bot whose token was revoked or
  // whose messages are malformed, and both look like silence from outside.
  ops.alert('tg.game.send', 'Игровой бот не смог отправить сообщение', desc,
    { чат: String(chatId) }).catch(() => {});
  return { ok: false, description: desc };
}

// ── «твой друг зашёл» ────────────────────────────────────────────────────────
// The in-game 'friendJoined' socket event (app.js's login path, tg-webhook's
// bot /start path) only reaches a referrer who happens to have the Mini App
// open at that exact moment — which is the uncommon case. Most invites are
// sent, forgotten, and the referrer finds out (if ever) next time they open
// the app themselves. This is the other half: a real message from the bot,
// so "кто-то зашёл по моей ссылке" reaches them whether or not they are online.
//
// Unsolicited — the referrer did nothing just now to trigger it — so
// canMessage is checked HERE rather than left to either call site, per the
// rule send() above documents. Both call sites reach a friend joining exactly
// the same way, so the gate and the wording live in one place instead of two
// copies that could drift apart.
async function notifyFriendJoined(referrerId, referrerTelegramId, friendUsername) {
  if (!referrerId || !referrerTelegramId) return;
  if (!await players.canMessage(null, referrerId)) return;
  const name = friendUsername ? `@${_tgEsc(friendUsername)}` : 'Друг';
  await send(referrerTelegramId, `👥 ${name} зашёл в игру по вашей ссылке!`);
}

// Surfaced on /health beside the ops feed's own numbers: "the bot stopped
// answering" and "the bot was never asked to answer" look identical from
// outside and have completely different causes.
function status() {
  return { configured: !!token(), live: isLive(), ..._stats };
}

module.exports = { send, isLive, status, notifyFriendJoined };
