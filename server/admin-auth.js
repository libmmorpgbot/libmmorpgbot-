'use strict';
// ── Admin authentication ────────────────────────────────────────────────────
// Replaces a scheme with three problems, the first of which was severe.
//
// 1. THE TOKEN WAS AN OFFLINE PASSWORD-CRACKING ORACLE.
//
//      _adminToken(ts) = HMAC-SHA256(ADMIN_PASSWORD, "adm:" + ts)
//      token           = base64url({ ts, sig })
//
//    The timestamp travels in plaintext inside the token, so anyone holding
//    ANY token has a (message, MAC) pair and can guess the password offline at
//    GPU speed: one SHA-256 per attempt, no salt, no KDF. And the token sat in
//    localStorage on the SAME ORIGIN as the game — so any XSS in a client with
//    113 innerHTML sites and a CSP running 'unsafe-inline' handed over full
//    admin API access.
//
//    Fixed by separating the two jobs completely. Signing uses a random secret
//    that is not the password and cannot be reversed into it. The password is
//    verified against a scrypt hash, so even the stored value is useless to an
//    attacker who reads the environment.
//
// 2. NO REVOCATION. A leaked token stayed valid for seven days and the only
//    way to kill it was changing the password. There is now a version counter:
//    bumping it invalidates every token ever issued, instantly.
//
// 3. NO SESSION BOUNDARY. Seven days is a long time for a credential that
//    approves payouts. Twelve hours, and the cookie is httpOnly so page
//    JavaScript cannot read it even if the page is compromised.
//
// scrypt comes from node's own crypto — no new dependency for a security
// primitive, which matters because a supply-chain compromise in a password
// library is a compromise of exactly this.

const crypto = require('crypto');
const { query } = require('./db');

// Cost parameters. N=16384 puts a single verification at roughly 60-100ms on
// this hardware, which is invisible to an admin logging in once a day and
// makes an offline guessing campaign against a leaked hash cost real money.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

const TOKEN_TTL_MS = Number(process.env.ADMIN_TOKEN_TTL_MS || 12 * 3600 * 1000);
const VERSION_KEY = 'admin:token_version';

// The signing secret. NOT the password: that separation is the entire point of
// this file. Refusing to start without it is deliberate — falling back to a
// default would silently restore a scheme where every deployment shares a key.
function _secret() {
  const s = process.env.ADMIN_TOKEN_SECRET || '';
  if (s.length < 32) {
    throw new Error('ADMIN_TOKEN_SECRET must be at least 32 characters — ' +
      'generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"');
  }
  return s;
}

// ── password ────────────────────────────────────────────────────────────────

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen,
    { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = String(stored || '').split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64url');
    const want = Buffer.from(hashB64, 'base64url');
    const got = crypto.scryptSync(String(password), salt, want.length,
      { N: Number(N), r: Number(r), p: Number(p) });
    // Lengths are equal by construction here, but timingSafeEqual throws on a
    // mismatch and a throw inside a login check is an information leak of its
    // own — so it is guarded rather than assumed.
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch { return false; }
}

// ── tokens ──────────────────────────────────────────────────────────────────

function _sign(payloadB64) {
  return crypto.createHmac('sha256', _secret()).update(payloadB64).digest('base64url');
}

async function _version() {
  const { rows } = await query(null, 'SELECT value FROM kv WHERE key = $1', [VERSION_KEY]);
  return rows.length ? Number(rows[0].value) || 1 : 1;
}

// Invalidates every token in existence. The button an admin presses when a
// laptop goes missing — previously there was no such button.
async function revokeAll() {
  const next = (await _version()) + 1;
  await query(null, `
    INSERT INTO kv (key, value) VALUES ($1, $2)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [VERSION_KEY, String(next)]);
  return next;
}

async function issue(subject) {
  const now = Date.now();
  const payload = Buffer.from(JSON.stringify({
    sub: String(subject || 'admin'),
    v: await _version(),
    iat: now,
    exp: now + TOKEN_TTL_MS,
  })).toString('base64url');
  return `${payload}.${_sign(payload)}`;
}

// Returns the payload on success, null on any failure. Deliberately gives the
// caller no detail about WHY: "expired" and "bad signature" are different facts
// and an attacker learns from the difference.
async function verify(token) {
  try {
    const [payloadB64, sig] = String(token || '').split('.');
    if (!payloadB64 || !sig) return null;

    // Signature FIRST, before the payload is parsed or trusted for anything.
    // Checking exp on an unverified payload means acting on attacker-supplied
    // JSON before knowing it is ours.
    const expected = _sign(payloadB64);
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    if (!payload || typeof payload.exp !== 'number') return null;
    if (Date.now() > payload.exp) return null;
    if (payload.v !== await _version()) return null;      // revoked
    return payload;
  } catch { return null; }
}

// ── cookie ──────────────────────────────────────────────────────────────────
// httpOnly is the fix for the localStorage problem: page JavaScript cannot read
// it, so an XSS in the game client can no longer walk off with admin access.
//
// Path=/admin keeps it off every game request — the cookie is only ever sent
// where it is needed, which also means it never appears in a log line for a
// sprite fetch.
//
// SameSite=Strict is the CSRF defence: a form on another site cannot make the
// browser attach this cookie. requireCsrfHeader() below is the second layer,
// because SameSite is one browser-behaviour flag away from not being enough.
const COOKIE = 'adm';

function setCookie(res, token) {
  const parts = [
    `${COOKIE}=${token}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/admin',
    `Max-Age=${Math.floor(TOKEN_TTL_MS / 1000)}`,
  ];
  // Secure would make the cookie undeliverable over plain HTTP, which is what
  // local development uses. In production everything is behind Caddy's TLS.
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function clearCookie(res) {
  res.append('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0`);
}

function _fromRequest(req) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  // Bearer is still accepted so an existing script or the admin page mid-
  // rollout keeps working. It is strictly weaker (whatever holds it can be
  // read by page JS), so the cookie is what the login flow issues.
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

// ── middleware ──────────────────────────────────────────────────────────────

// A cross-site form can make a browser send a cookie; it cannot make it send a
// custom header. Together with SameSite=Strict this is belt and braces on a
// surface that can ban accounts and grant items.
function requireCsrfHeader(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (req.headers['x-admin-request'] !== '1') {
    return res.status(403).json({ error: 'CSRF' });
  }
  next();
}

function requireAdmin(req, res, next) {
  verify(_fromRequest(req)).then(payload => {
    if (!payload) return res.status(401).json({ error: 'Unauthorized' });
    req.admin = payload;
    next();
  }).catch(() => res.status(401).json({ error: 'Unauthorized' }));
}

// ── brute-force lockout ─────────────────────────────────────────────────────
// Per IP, in memory. The window is what makes online guessing pointless; the
// scrypt cost is what makes an offline attempt on a leaked hash expensive. Both
// are needed — neither substitutes for the other.
const _fails = new Map();
const MAX_FAILS = 8;
const LOCK_MS = 15 * 60 * 1000;

function lockedFor(ip) {
  const e = _fails.get(ip);
  return e && e.until > Date.now() ? e.until - Date.now() : 0;
}

function recordFail(ip) {
  const e = _fails.get(ip) || { n: 0, until: 0 };
  if (++e.n >= MAX_FAILS) { e.until = Date.now() + LOCK_MS; e.n = 0; }
  _fails.set(ip, e);
  // One entry per IP that ever failed, kept forever, is a slow leak that a
  // spray across many source addresses turns into a fast one.
  if (_fails.size > 5000) {
    const now = Date.now();
    for (const [k, v] of _fails) if (v.until <= now && v.n === 0) _fails.delete(k);
  }
}

function clearFails(ip) { _fails.delete(ip); }

// ── audit ───────────────────────────────────────────────────────────────────
// Every admin action that touches someone else's money or account. The old
// build logged some of this to the player log and some nowhere at all, so "who
// approved this payout" had no answer.
async function audit(adminId, action, { refType = null, refId = null, meta = null } = {}) {
  try {
    await query(null, `
      INSERT INTO admin_actions (admin_tg_id, action, ref_type, ref_id, meta)
      VALUES ($1, $2, $3, $4, $5)`,
      [String(adminId), action, refType, refId ? String(refId) : null, meta ? JSON.stringify(meta) : null]);
  } catch (err) {
    // Audit failure must not block the action — but it must be loud, because an
    // action nobody recorded is exactly what an audit trail exists to prevent.
    console.error('[admin] audit write failed:', err.message);
  }
}

// Configuration problems that should be visible before the first login fails.
function configProblems() {
  const out = [];
  if (!(process.env.ADMIN_TOKEN_SECRET || '').length) out.push('ADMIN_TOKEN_SECRET не задано');
  else if (process.env.ADMIN_TOKEN_SECRET.length < 32) out.push('ADMIN_TOKEN_SECRET коротший за 32 символи');
  if (!process.env.ADMIN_PASSWORD_HASH) out.push('ADMIN_PASSWORD_HASH не задано (згенеруйте: node dev/admin-hash.js)');
  if (process.env.ADMIN_PASSWORD) out.push('ADMIN_PASSWORD ще задано — приберіть, пароль більше не зберігається у відкритому вигляді');
  return out;
}

module.exports = {
  hashPassword, verifyPassword,
  issue, verify, revokeAll,
  setCookie, clearCookie,
  requireAdmin, requireCsrfHeader,
  lockedFor, recordFail, clearFails,
  audit, configProblems,
  TOKEN_TTL_MS, COOKIE,
};
