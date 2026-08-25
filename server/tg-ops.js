'use strict';
// ── Admin ops feed ──────────────────────────────────────────────────────────
// One Telegram supergroup, three topics: deposits, withdrawals, alerts. Every
// message an admin needs to see goes to exactly one of them, so money events
// never drown in error noise and an error never gets lost between two payouts.
//
// All admin-facing text is Russian, deliberately — this is the operators' feed,
// not the players'.
//
// Three things here are not decoration:
//
//   scrub()     strips anything that looks like a bot token or a connection
//               string before a message is sent. An error report is built from
//               an exception, and an exception from a failed HTTP call carries
//               the URL — which for the Telegram API contains the bot token.
//               Posting that into a group is handing over the bot.
//
//   esc()       escapes every interpolated value. On-chain comments, player
//               display names and error text are all attacker-influenced; an
//               unescaped one can break the markup so Telegram REJECTS the
//               message, which silently suppresses the alert it was carrying.
//
//   throttle    an alert that fires from inside a loop fires thousands of
//               times. Identical alerts collapse into one per window, with a
//               count, so a storm stays readable instead of flooding the group
//               and getting muted.

const GROUP_ID = process.env.TG_OPS_GROUP_ID || '';
const TOPICS = {
  deposits:    process.env.TG_TOPIC_DEPOSITS    || '',
  withdrawals: process.env.TG_TOPIC_WITHDRAWALS || '',
  alerts:      process.env.TG_TOPIC_ALERTS      || '',
};
// The ops bot may be the game bot or a separate one. Separate is better (its
// token is not the one players talk to), but not required.
const TOKEN = process.env.TG_OPS_BOT_TOKEN || process.env.TG_BOT_TOKEN || '';

// ── whether anything actually reaches Telegram ──────────────────────────────
// Every integration test calls app.boot(), and boot() starts the workers. So
// each run announced "🟢 Сервер запущен" in the operators' channel, started a
// SECOND getUpdates poll on the ops bot — Telegram allows exactly one consumer
// per token, so the live server's withdrawal buttons stopped working — and
// pointed the deposit scanner at the real wallet.
//
// The gate is deny-by-default and cannot be forgotten: production sends,
// everything else logs to the console. Turning it on for a deliberate test of
// the ops path is an explicit OPS_LIVE=1, which is a thing someone types on
// purpose rather than a thing a test forgets to switch off.
// Read at CALL time, not at module load. A constant computed on require()
// depends on whether the caller set the variable before or after the first
// import of this file — an ordering nobody can see and every test would get
// wrong once. A function has no such trap.
function isLive() {
  const on = process.env.OPS_LIVE === '1'
    || (process.env.OPS_LIVE !== '0' && process.env.NODE_ENV === 'production');
  return on && !!TOKEN && !!GROUP_ID;
}

// Comma-separated. Replaces the single TG_ADMIN_ID: approving payouts is not a
// one-person job, and the old build could not express a second admin at all.
const ADMIN_IDS = new Set(
  String(process.env.TG_ADMIN_IDS || process.env.TG_ADMIN_ID || '')
    .split(',').map(s => s.trim()).filter(Boolean)
);

function isAdmin(tgId) { return ADMIN_IDS.has(String(tgId || '')); }
function adminIds() { return [...ADMIN_IDS]; }

// ── redaction ───────────────────────────────────────────────────────────────
const SECRETS = [
  /\d{6,}:[A-Za-z0-9_-]{30,}/g,                 // telegram bot token
  /postgres(?:ql)?:\/\/[^\s"'<>]+/gi,           // connection string with password
  /mongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi,
  /\bAV[A-Za-z0-9_-]{12,}\b/g,                  // DO-style generated password
];

function scrub(text) {
  let s = String(text == null ? '' : text);
  for (const re of SECRETS) s = s.replace(re, '«скрыто»');
  return s;
}

function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── transport ───────────────────────────────────────────────────────────────

async function _api(method, body) {
  if (!TOKEN) return { ok: false, description: 'no token' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch (err) {
    // Never throw out of here. The ops feed reporting a failure must not become
    // the failure — an exception on the alert path would take down whatever was
    // trying to report a problem.
    console.error('[tg-ops]', method, err.message);
    return { ok: false, description: err.message };
  }
}

// Sends to one topic of the ops group. `reply_markup` carries the buttons for
// withdrawal requests.
async function send(topic, html, { buttons = null, disablePreview = true } = {}) {
  if (!GROUP_ID) return null;
  if (!isLive()) {
    // Printed rather than swallowed: a test that expected an alert should be
    // able to see that one was raised, and where it would have gone.
    console.log(`[tg-ops:${topic}] (не отправлено, OPS_LIVE выключен) ${String(html).slice(0, 160)}`);
    return null;
  }
  const thread = TOPICS[topic];
  const body = {
    chat_id: GROUP_ID,
    text: scrub(html),
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: disablePreview },
  };
  // Without a thread id the message lands in the group's General topic, which
  // is a degraded but working state — better than not sending an alert at all
  // because a topic id was not configured yet.
  if (thread) body.message_thread_id = Number(thread);
  if (buttons) body.reply_markup = { inline_keyboard: buttons };

  let res = await _api('sendMessage', body);

  // One retry, because the two ways a send fails are both recoverable and both
  // common. 429 is Telegram's rate limit and it says exactly how long to wait.
  // 5xx and a dropped connection are transient. Giving up on the first failure
  // means the message this alert was carrying is gone for good — and an alert
  // that is silently dropped is worse than no alerting at all, because it looks
  // like nothing went wrong.
  if (!res.ok) {
    const retryAfter = res.parameters && res.parameters.retry_after;
    const wait = Math.min(10000, (Number(retryAfter) || 1) * 1000);
    console.error(`[tg-ops] ${topic}: ${res.description} — повтор через ${wait}ms`);
    await new Promise(r => setTimeout(r, wait));
    res = await _api('sendMessage', body);
  }

  if (!res.ok) {
    // The last line of defence. journalctl is the only place left that can
    // record it, so the whole message goes there rather than a summary — this
    // is what someone reads when they ask "why did no alert arrive".
    console.error(`[tg-ops] ${topic}: НЕ ОТПРАВЛЕНО (${res.description})\n${String(html).slice(0, 900)}`);
    _undelivered++;
  }
  return res.ok ? res.result : null;
}

// Counted so /health can say it out loud. "Alerts stopped arriving" and "alerts
// stopped being raised" look identical from the outside and have completely
// different causes.
let _undelivered = 0;

async function editMessage(messageId, html, { buttons = null } = {}) {
  if (!GROUP_ID || !messageId) return null;
  const body = { chat_id: GROUP_ID, message_id: messageId, text: scrub(html), parse_mode: 'HTML' };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };
  const res = await _api('editMessageText', body);
  return res.ok ? res.result : null;
}

// The same edit, in whatever chat the message is in. editMessage above is
// pinned to the ops group because that is where a withdrawal card lives; an
// admin panel lives in a private chat, and a panel that cannot redraw itself
// is a panel that answers every button with a new message.
async function editIn(chatId, messageId, html, { buttons = null } = {}) {
  if (!chatId || !messageId) return null;
  const body = {
    chat_id: String(chatId), message_id: messageId,
    text: scrub(html), parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  };
  // Always sent, even empty: omitting it LEAVES the previous keyboard in
  // place, so a screen with no buttons would keep the buttons of the one
  // before it.
  body.reply_markup = { inline_keyboard: buttons || [] };
  const res = await _api('editMessageText', body);
  return res.ok ? res.result : null;
}

// A prompt the admin types a value into. force_reply is what makes the client
// open the keyboard already quoting this message, which is what lets the reply
// be matched back to what it answers — see the marker in tg-admin.js.
async function ask(chatId, html) {
  const res = await _api('sendMessage', {
    chat_id: String(chatId), text: scrub(html), parse_mode: 'HTML',
    reply_markup: { force_reply: true, selective: true },
  });
  return res.ok ? res.result : null;
}

async function answerCallback(id, text = '', alert = false) {
  return _api('answerCallbackQuery', { callback_query_id: id, text, show_alert: alert });
}

async function dm(tgId, html, { buttons = null } = {}) {
  const body = { chat_id: String(tgId), text: scrub(html), parse_mode: 'HTML' };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };
  const res = await _api('sendMessage', body);
  return res.ok ? res.result : null;
}

// ── alerts ──────────────────────────────────────────────────────────────────
// Anything that broke. Collapsed by key so a fault inside a loop produces one
// message plus a count, not one message per iteration.
const ALERT_WINDOW_MS = Number(process.env.TG_ALERT_WINDOW_MS || 300000);   // 5 min
const _alertState = new Map();   // key -> { at, count, reported, title }

// Every alert raised since boot, whether it was sent, collapsed or dropped.
// Read by /health.
const _counts = { raised: 0, sent: 0, collapsed: 0 };

// ── a ceiling on the whole channel, not just on one alert ──────────────────
// The per-key throttle stops ONE fault from flooding the group. It does
// nothing about fifty different faults at once, which is what a bad deploy
// looks like — and a group that receives two hundred messages in a minute gets
// muted, after which the alerting is worse than useless.
//
// So there is a second, global limit. Past it the group is told once that it is
// being held back, and the detail stays in the journal where it can be read in
// full. Every alert is still RAISED and still counted; what is bounded is how
// many become messages.
const BURST_PER_MIN = Number(process.env.TG_ALERT_BURST || 25);
let _burstAt = 0, _burstN = 0, _burstTold = false;

function _overBurst(now) {
  if (now - _burstAt > 60000) { _burstAt = now; _burstN = 0; _burstTold = false; }
  return ++_burstN > BURST_PER_MIN;
}

async function alert(key, title, detail, extra = {}) {
  _counts.raised++;
  const now = Date.now();

  if (_overBurst(now)) {
    // Printed in full — journalctl is where the rest of the storm lives.
    console.error(`[tg-ops] (сверх лимита) ${title}: ${String(detail || '').slice(0, 300)}`);
    if (_burstTold) return null;
    _burstTold = true;
    return send('alerts',
      `⏸ <b>Слишком много разных алертов</b> — больше ${BURST_PER_MIN} за минуту.\n`
      + `Остальные за эту минуту только в журнале сервера: <code>journalctl -u liberty-next</code>`);
  }

  const st = _alertState.get(key);

  if (st && now - st.at < ALERT_WINDOW_MS) {
    st.count++;
    _counts.collapsed++;
    // Collapsed, NOT discarded. The steps are close together at the start
    // (2, 3, 5) because the difference between "happened once" and "happening
    // repeatedly" is the most useful thing to learn early, and spread out after
    // that so a real storm cannot flood the group. Whatever falls between the
    // steps is still reported — by the sweeper below, when the window closes.
    if (!ALERT_STEPS.has(st.count)) return null;
    st.reported = st.count;
    _counts.sent++;
    return send('alerts',
      `🔁 <b>${esc(title)}</b> — повторилось ${st.count} раз за ${Math.round((now - st.at) / 60000)} мин\n` +
      `<code>${esc(key)}</code>`);
  }

  _alertState.set(key, { at: now, count: 1, reported: 1, title });
  // The map is keyed by alert kind, not by occurrence, so it is bounded by the
  // number of distinct alerts in the code — but a key built from a player id or
  // a message would not be, so old entries are dropped anyway.
  if (_alertState.size > 500) {
    for (const [k, v] of _alertState) if (now - v.at > ALERT_WINDOW_MS * 4) _alertState.delete(k);
  }

  const lines = [`🚨 <b>${esc(title)}</b>`];
  if (detail) lines.push(`<pre>${esc(String(detail).slice(0, 900))}</pre>`);
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== null) lines.push(`${esc(k)}: <code>${esc(v)}</code>`);
  }
  lines.push(`<code>${esc(key)}</code> · ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`);
  _counts.sent++;
  return send('alerts', lines.join('\n'));
}

const ALERT_STEPS = new Set([2, 3, 5, 10, 25, 50, 100, 250, 500, 1000]);

// ── the closing of a window ─────────────────────────────────────────────────
// Everything the throttle held back gets said in the end. Without this, an
// alert that fired 4 times in five minutes reported 3 and lost the fourth
// forever — and "9 of them" would have been reported as 5. The rule the user
// asked for is that nothing is silently dropped, and a counter that is never
// flushed drops things silently.
async function _sweepAlerts(now = Date.now()) {
  for (const [k, v] of [..._alertState]) {
    if (now - v.at < ALERT_WINDOW_MS) continue;
    _alertState.delete(k);
    if (v.count <= (v.reported || 1)) continue;
    _counts.sent++;
    await send('alerts',
      `📉 <b>${esc(v.title || k)}</b> — итог за окно: ${v.count} раз\n<code>${esc(k)}</code>`);
  }
}

// unref'd: a background timer that keeps the process alive would hang every
// test that requires this file, and half of them do.
const _sweeper = setInterval(() => { _sweepAlerts().catch(() => {}); }, 60000);
if (_sweeper.unref) _sweeper.unref();

// Convenience for a caught exception: takes the error object and reports its
// message plus the top of the stack, both scrubbed.
async function alertError(key, title, err, extra = {}) {
  const detail = err && err.stack
    ? String(err.stack).split('\n').slice(0, 4).join('\n')
    : String(err && err.message || err);
  return alert(key, title, detail, extra);
}

// ── topic discovery ─────────────────────────────────────────────────────────
// Telegram has no API to list a forum's topics, so the thread ids have to be
// observed. Sending /topicid inside a topic makes the bot answer with that
// topic's id, which is then pasted into the env file. Handled here rather than
// documented as a manual step because "look it up in the raw update JSON" is
// the kind of instruction that gets followed wrongly once and then debugged
// for an hour.
async function handleTopicIdCommand(message) {
  const text = String(message && message.text || '');
  if (!/^\/topicid\b/.test(text)) return false;
  if (!isAdmin(message.from && message.from.id)) return true;   // seen, ignored
  const thread = message.message_thread_id;
  await _api('sendMessage', {
    chat_id: message.chat.id,
    message_thread_id: thread,
    parse_mode: 'HTML',
    text: thread
      ? `🧵 <b>ID этого топика</b>\n<code>${thread}</code>\n\nГруппа: <code>${message.chat.id}</code>`
      : `Это General-топик (у него нет message_thread_id).\nГруппа: <code>${message.chat.id}</code>`,
  });
  return true;
}

// What is and is not configured — surfaced on /health so a missing topic id is
// visible before the first alert fails to arrive rather than after.
function status() {
  return {
    configured: !!(TOKEN && GROUP_ID),
    live: isLive(),
    group: GROUP_ID || null,
    topics: Object.fromEntries(Object.entries(TOPICS).map(([k, v]) => [k, v ? Number(v) : null])),
    admins: ADMIN_IDS.size,
    separateBot: !!process.env.TG_OPS_BOT_TOKEN,
    // raised — how many alerts the code asked for
    // sent — how many messages actually went out (collapsed ones count once)
    // undelivered — how many Telegram refused, after the retry
    // Three numbers because "нічого не приходить" has three different causes
    // and they are told apart here rather than by guessing.
    alerts: { ..._counts, undelivered: _undelivered, pending: _alertState.size },
  };
}

module.exports = {
  isLive,
  send, editMessage, editIn, ask, answerCallback, dm,
  alert, alertError,
  isAdmin, adminIds, handleTopicIdCommand, status,
  esc, scrub, TOPICS, GROUP_ID,
  // Exported for dev/alert-check.js, which has to be able to close a window on
  // demand rather than waiting five real minutes for the sweeper — and to clear
  // the per-minute ceiling after deliberately hitting it, rather than sleeping
  // through the rest of the minute.
  _sweepAlerts, _alertState, ALERT_WINDOW_MS,
  _resetBurst: () => { _burstAt = 0; _burstN = 0; _burstTold = false; },
};
