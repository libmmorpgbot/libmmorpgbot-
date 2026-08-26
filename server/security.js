'use strict';
// Authentication, identity and abuse limits — the checks that decide whether a
// request is who it claims to be. Split out of server/index.js, verbatim.
//
// Nothing here touches a model, a socket or any game state: it depends only on
// process env and the shared catalog. That self-containment is what made it the
// first thing worth lifting out of an 11,000-line file — it can be read, and
// tested, entirely on its own.
const crypto = require('crypto');
const { CLAN_DESC_MAX_CHARS } = require('../shared/definitions');

const _TG_TOKEN      = process.env.TG_BOT_TOKEN   || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

// A display name is bounded in BOTH characters and bytes: the character limit
// is what a player sees, the byte limit is what stops a name made of 4-byte
// emoji from being twenty times the size the count suggests.
const _USERNAME_MAX_CHARS = 32;
const _USERNAME_MAX_BYTES = 200;

// Per-IP failed-attempt tracker: after LOGIN_MAX_FAILS failures the IP is locked
// out for LOGIN_LOCK_MS. A successful login clears the counter. In-memory (this
// process holds all state anyway); good enough to blunt online password guessing.
const _loginFails = new Map(); // ip → { n, lockedUntil }
const LOGIN_MAX_FAILS = 8;
const LOGIN_LOCK_MS   = 15 * 60 * 1000;

function _sanitizeName(raw) {
  let s = String(raw == null ? '' : raw)
    // Control characters, markup delimiters and quote marks — everything
    // that could either spoof a name visually or break out of an HTML
    // context somewhere downstream.
    // eslint-disable-next-line no-control-regex -- the control-character range is the point, not a stray byte.
    .replace(/[\u0000-\u001f\u007f<>&"'`\\]/g, '')
    .trim()
    .slice(0, _USERNAME_MAX_CHARS);
  while (Buffer.byteLength(s, 'utf8') > _USERNAME_MAX_BYTES) s = s.slice(0, -1);
  return s;
}

// Same cleaning, with the "nothing usable left" fallback the login paths need.
// Clan names use _sanitizeName directly instead, so that a clan legitimately
// called "tg_something" isn't mistaken for the fallback.
function _safeUsername(raw, telegramId) {
  return _sanitizeName(raw) || `tg_${telegramId}`;
}

// Same character-stripping as _sanitizeName, but for the clan description
// (CLAN_DESC_MAX_CHARS, well past _sanitizeName's 32-char username cap)
// rather than a display name.
function _sanitizeClanDesc(raw) {
  return String(raw == null ? '' : raw)
    // eslint-disable-next-line no-control-regex -- same intentional range as _sanitizeName above.
    .replace(/[\u0000-\u001f\u007f<>&"'`\\]/g, '')
    .trim()
    .slice(0, CLAN_DESC_MAX_CHARS);
}

// Login Widget verification (browser button)
function verifyTelegramAuth(data) {
  const { hash, ...rest } = data;
  if (!hash) return false;
  // No token configured means no signature can be trusted: the HMAC below
  // would be computed with an empty key, which anyone can reproduce, so an
  // unconfigured deployment would accept a forged login for ANY telegramId.
  // Fail closed instead.
  if (!_TG_TOKEN) return false;
  const checkStr = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join('\n');
  const secret = crypto.createHash('sha256').update(_TG_TOKEN).digest();
  const computed = crypto.createHmac('sha256', secret).update(checkStr).digest('hex');
  if (computed !== hash) return false;
  if (Date.now() / 1000 - Number(data.auth_date) > 86400) return false;
  return true;
}

// Mini App verification (opened inside Telegram app) — different secret derivation.
// Returns { user, startParam } — startParam is Telegram's own start_param field,
// present when the app was opened via a t.me/<bot>?startapp=... deep link (the
// Mini App equivalent of a bot's ?start= deep link, but it opens the game
// directly with no intermediate "press START in the bot chat" step — see
// refLink() just below, and the registration in loginTelegramWebApp,
// server/app.js).
function verifyTelegramWebApp(initData) {
  try {
    // Fail closed with no token — see the matching guard in verifyTelegramAuth:
    // an HMAC keyed on the empty string is one anybody can compute, so a
    // deployment that forgot TG_BOT_TOKEN would accept a forged login for any
    // account rather than refusing every login.
    if (!_TG_TOKEN) return null;
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const checkStr = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(_TG_TOKEN).digest();
    const computed = crypto.createHmac('sha256', secret).update(checkStr).digest('hex');
    if (computed !== hash) return null;
    if (Date.now() / 1000 - Number(params.get('auth_date')) > 86400) return null;
    const userStr = params.get('user');
    if (!userStr) return null;
    return { user: JSON.parse(userStr), startParam: params.get('start_param') || '' };
  } catch { return null; }
}

// ── the link a player hands to a friend ────────────────────────────────────
// `?startapp=`, not `?start=`. The classic `t.me/<bot>?start=ref_<id>` deep
// link this replaces opens the BOT'S CHAT, and the referral is registered only
// by whatever reads the /start message that follows. Nothing in this build
// reads it: server/workers.js polls the OPERATORS' bot and only that one,
// deliberately, because Telegram allows exactly one getUpdates consumer per
// token. So every referral link ever handed out was inert — players.referred_by
// was never written by anything, and the 5% deposit commission, the season
// payout at level 20 and the invited-friends list were three finished features
// that could not fire.
//
// `?startapp=` opens the Mini App itself and Telegram delivers the parameter as
// initData's start_param, which verifyTelegramWebApp above already returns and
// loginTelegramWebApp (server/app.js) registers from: no second poller, and no
// "press START in the bot chat" tap standing between a friend and the link.
//
// TG_MINIAPP_NAME is the app's short name and is optional — with it this is a
// Direct Mini App link (t.me/<bot>/<app>), without it a Main Mini App link
// (t.me/<bot>). Both carry start_param; which of the two a deployment can use
// is settled in BotFather, which is not something this file can read.
//
// ONE definition, because there were two and they had already drifted:
// server/app.js returned '' with no bot configured while
// server/db/repos/shop.js fell back to a hard-coded name, and the friends panel
// shows whichever answered last (it asks for the list right after login and
// overwrites the link from authOk with the one in that reply).
//
// The link shape is now built ONCE, here, and refLink() is one caller of it.
// The other is the game bot's welcome message (server/routes/tg-webhook.js),
// whose "Играть" button has to be a real ?startapp= link rather than a plain
// game URL: that button is what carries a referral from somebody's first
// /start across to their first login. Two hand-written copies of a t.me link
// is exactly the drift this comment is already about.
function miniAppLink(startParam = '') {
  // The fallback is the name repos/shop.js has been shipping to players. It
  // stays because dropping it blanks the referral card on any deployment that
  // never set TG_BOT_USERNAME, and a deployment pointed at the wrong bot could
  // not log anyone in anyway — its token would not verify their initData.
  const bot = process.env.TG_BOT_USERNAME || 'LibertyMMORPGbot';
  const app = process.env.TG_MINIAPP_NAME || '';
  // Encoded, not interpolated raw: every caller today passes `ref_<digits>`,
  // which survives this untouched, but a start_param is a URL field and the
  // day something else is put in one it must not be able to end the query.
  const sp = encodeURIComponent(String(startParam == null ? '' : startParam));
  return `https://t.me/${bot}${app ? `/${app}` : ''}${sp ? `?startapp=${sp}` : ''}`;
}

function refLink(telegramId) { return miniAppLink(`ref_${telegramId}`); }

// ── Admin auth helpers ─────────────────────────────────────────────────────────
function _adminToken(ts) {
  return crypto.createHmac('sha256', ADMIN_PASSWORD || 'disabled').update(`adm:${ts}`).digest('hex');
}

function _verifyAdminToken(raw) {
  if (!ADMIN_PASSWORD) return false;
  try {
    const { ts, sig } = JSON.parse(Buffer.from(raw, 'base64url').toString());
    if (Date.now() - ts > 7 * 86400000) return false;
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(_adminToken(ts)));
  } catch { return false; }
}

function _loginLockedUntil(ip) {
  const e = _loginFails.get(ip);
  return e && e.lockedUntil > Date.now() ? e.lockedUntil : 0;
}

function _recordLoginFail(ip) {
  const e = _loginFails.get(ip) || { n: 0, lockedUntil: 0 };
  e.n += 1;
  if (e.n >= LOGIN_MAX_FAILS) { e.lockedUntil = Date.now() + LOGIN_LOCK_MS; e.n = 0; }
  _loginFails.set(ip, e);
  // One entry per IP that ever failed a login, kept forever, is a slow leak
  // that a spray across many source addresses turns into a fast one. Drop
  // entries that are neither locked nor recently active whenever the map grows
  // past a sane size.
  if (_loginFails.size > 5000) {
    const now = Date.now();
    _loginFails.forEach((v, k) => { if (v.lockedUntil <= now && v.n === 0) _loginFails.delete(k); });
  }
}

// Constant-time string compare that never throws on length mismatch.
function _safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) { crypto.timingSafeEqual(ba, ba); return false; }
  return crypto.timingSafeEqual(ba, bb);
}

// Everything below sends with parse_mode:'HTML', and several of the values
// interpolated into those messages come from the player — the deposit memo and
// the withdrawal address are typed straight into the client, and a display
// name falls back to Telegram's first_name. Unescaped, a player could close a
// tag and write their own lines into the message the admin reads before
// pressing ✅ — a different amount, a fake "already verified" note — or simply
// break the markup so Telegram rejects the send and the request never appears.
function _tgEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// A successful login clears that IP's failure streak. Exported rather than
// letting the caller reach into _loginFails, which is the whole point of the
// map living here.
function _clearLoginFails(ip) { _loginFails.delete(ip); }

module.exports = {
  _sanitizeName, _safeUsername, _sanitizeClanDesc,
  verifyTelegramAuth, verifyTelegramWebApp, refLink, miniAppLink,
  _adminToken, _verifyAdminToken, _safeEqual,
  _loginLockedUntil, _recordLoginFail, _clearLoginFails, _tgEsc,
  ADMIN_PASSWORD,
};
