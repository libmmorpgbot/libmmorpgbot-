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

  const res = await _api('sendMessage', body);
  if (!res.ok) console.error(`[tg-ops] ${topic}: ${res.description}`);
  return res.ok ? res.result : null;
}

async function editMessage(messageId, html, { buttons = null } = {}) {
  if (!GROUP_ID || !messageId) return null;
  const body = { chat_id: GROUP_ID, message_id: messageId, text: scrub(html), parse_mode: 'HTML' };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };
  const res = await _api('editMessageText', body);
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
const _alertState = new Map();   // key -> { at, count, notified }

async function alert(key, title, detail, extra = {}) {
  const now = Date.now();
  const st = _alertState.get(key);

  if (st && now - st.at < ALERT_WINDOW_MS) {
    st.count++;
    // A second message is sent only at powers of ten, so a storm reports 10,
    // 100, 1000 rather than every single occurrence.
    if (st.count !== 10 && st.count !== 100 && st.count !== 1000) return null;
    return send('alerts',
      `🔁 <b>${esc(title)}</b> — повторилось ${st.count} раз за ${Math.round((now - st.at) / 60000)} мин\n` +
      `<code>${esc(key)}</code>`);
  }

  _alertState.set(key, { at: now, count: 1 });
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
  return send('alerts', lines.join('\n'));
}

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
    group: GROUP_ID || null,
    topics: Object.fromEntries(Object.entries(TOPICS).map(([k, v]) => [k, v ? Number(v) : null])),
    admins: ADMIN_IDS.size,
    separateBot: !!process.env.TG_OPS_BOT_TOKEN,
  };
}

module.exports = {
  send, editMessage, answerCallback, dm,
  alert, alertError,
  isAdmin, adminIds, handleTopicIdCommand, status,
  esc, scrub, TOPICS, GROUP_ID,
};
