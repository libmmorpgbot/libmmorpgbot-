// ─────────────────────────────────────────────────────────
//  TON CONNECT — wallet connect + on-chain deposit
// ─────────────────────────────────────────────────────────
// Scope, deliberately: connect/disconnect a real TON wallet (Tonkeeper etc.
// via js/vendor/tonconnect-ui.min.js), auto-fill the withdrawal address from
// it, and let a deposit be sent as an actual on-chain transfer straight from
// the connected wallet instead of the player copy-pasting the address+memo
// into their own wallet app by hand. This only makes *sending* the transfer
// easier; nothing downstream changes.
//
// What downstream IS, since this said otherwise for a long time: an admin no
// longer approves deposits at all, and there is no notifyAdminGram. The
// server issues a code, the player sends TON carrying it as the comment, and
// a chain scanner credits the matching intent exactly once (server/db/repos/
// gram.js). A comment that matches no intent is money nobody can place.

let _tonConnectUI = null;
let _tonConnectedAddress = null;
let _tcLoading = null;

// The TON Connect UI bundle is 435 KB (125 KB gzip) — a fifth of everything
// the game downloads to start — for a wallet most players never open, and its
// script tag sat ahead of the game's own bundle, so it delayed the first frame
// for everyone. It is fetched on demand instead.
//
// Memoised on the promise, not on a boolean: two taps before the first load
// finishes must wait on one download, not start a second.
function _tcLoadScript() {
  if (typeof TON_CONNECT_UI !== 'undefined') return Promise.resolve(true);
  if (_tcLoading) return _tcLoading;
  _tcLoading = new Promise(resolve => {
    const el = document.createElement('script');
    el.src = '/js/vendor/tonconnect-ui.min.js';
    el.onload = () => resolve(typeof TON_CONNECT_UI !== 'undefined');
    el.onerror = () => { _tcLoading = null; resolve(false); };
    document.head.appendChild(el);
  });
  return _tcLoading;
}

// Loads the library if needed and builds the UI object. Everything that used
// to call _tcInit() awaits this instead.
async function _tcEnsure() {
  if (_tonConnectUI) return true;
  if (!(await _tcLoadScript())) return false;
  if (_tonConnectUI) return true;         // a concurrent caller got there first
  _tonConnectUI = new TON_CONNECT_UI.TonConnectUI({
    manifestUrl: window.location.origin + '/tonconnect-manifest.json',
  });
  _tonConnectUI.onStatusChange(wallet => {
    // Converted HERE, at the one line where a wallet address enters this
    // client, and never again downstream. tcAddress() feeds the wallet card,
    // the withdrawal form's auto-fill and anything added later; a conversion
    // per render site is a conversion the next render site forgets.
    _tonConnectedAddress = wallet ? tcFriendlyAddress(wallet.account.address) : null;
    if (typeof _onTonConnectChange === 'function') _onTonConnectChange();
  });
  return true;
}

// Called when the wallet panel opens, so a player who connected previously
// sees "connected" rather than "connect" — restoring that session is something
// only the library can do, and it cannot do it until it is loaded.
function tcWarmUp() {
  _tcEnsure().then(ok => { if (ok && typeof _onTonConnectChange === 'function') _onTonConnectChange(); });
}

async function tcConnect() {
  // The download can take a second or two on mobile, and a button that does
  // nothing for that long reads as broken.
  if (typeof _tcSetBusy === 'function') _tcSetBusy(true);
  const ok = await _tcEnsure();
  if (typeof _tcSetBusy === 'function') _tcSetBusy(false);
  if (ok && _tonConnectUI) _tonConnectUI.openModal();
  else if (typeof _marketToast === 'function') _marketToast('Не удалось загрузить кошелёк', 'err');
}

function tcDisconnect() {
  if (_tonConnectUI) _tonConnectUI.disconnect();
}

function tcAddress() { return _tonConnectedAddress; }

// ── raw address → the form a person recognises ──────────────────────────────
// TON Connect reports wallet.account.address as the RAW workchain:hash pair —
// `0:8fe52cb8…` — and that is what every panel in this tab was printing.
// Correct, and unreadable: it is not the `UQ…` the player's own wallet shows
// them, an explorer's search box does not take it, and a player comparing the
// two concludes the game linked somebody else's account. It is also the string
// the withdrawal form auto-filled, so it was about to be sent BACK as the
// payout destination.
//
// The friendly form is the same 33 bytes with a tag and a checksum, base64url:
//
//   [tag][workchain][32-byte hash][CRC16-CCITT of the previous 34]
//
// The tag says what the network does with a message that cannot be delivered.
// 0x51 is non-bounceable — the `UQ` prefix, and what every wallet and explorer
// shows for an ordinary account, because a payment to a person should stay put
// rather than come back. 0x11 is bounceable, `EQ`, and belongs to contracts.
//
// The checksum is the reason the friendly form exists at all: a mistyped
// character fails to decode instead of sending money to nobody.
//
// This is server/ton.js's friendlyAddress, byte for byte — same tag, same
// polynomial, same base64url — because the two halves have to agree: what this
// shows is what a player pastes into the withdrawal form, and it is
// server/ton.js validAddress that decides whether to accept it. Rewardix does
// the same conversion through @ton/core's Address.parseRaw (frontend/src/lib/
// tonconnect.ts, toFriendlyAddress) — the same output, and no network call
// there either; it is arithmetic over the 32 account bytes and nothing else.
// There is no bundler here to import a package with, so it is written out.
function _tcCrc16(bytes) {
  // CRC16-CCITT (XModem), polynomial 0x1021 — what TON specifies.
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8;
    for (let j = 0; j < 8; j++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function tcFriendlyAddress(raw, opts) {
  const o = opts || {};
  const s = String(raw == null ? '' : raw).trim();
  // Already friendly: hand it back untouched rather than round-tripping it,
  // which would silently rewrite an EQ someone gave us into a UQ.
  if (/^[UEk0-9][QF][A-Za-z0-9_-]{46}$/.test(s)) return s;

  const m = /^(-?\d+):([0-9a-fA-F]{64})$/.exec(s);
  if (!m) return s;                       // not an address — show it as it came

  const wc = Number(m[1]);
  let tag = o.bounceable ? 0x11 : 0x51;
  if (o.testnet) tag |= 0x80;

  const body = new Uint8Array(34);
  body[0] = tag;
  body[1] = wc < 0 ? 0xff : wc & 0xff;    // -1 (masterchain) is stored as 0xff
  for (let i = 0; i < 32; i++) body[2 + i] = parseInt(m[2].substr(i * 2, 2), 16);

  const crc = _tcCrc16(body);
  const out = new Uint8Array(36);
  out.set(body, 0);
  out[34] = (crc >>> 8) & 0xff;
  out[35] = crc & 0xff;
  // 36 bytes divide evenly into 12 base64 groups, so there is never padding to
  // strip — the replace is there so a future change to the length cannot
  // produce a `=` that a URL or a QR code would mangle.
  return _bytesToBase64(out).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── Minimal single-cell BOC encoder for a TON "text comment" payload ─────
// Every wallet attaches a comment to a simple transfer the same way: one
// cell, no references, holding a 32-bit zero prefix (marks it as plain text,
// not a smart-contract call) followed by the UTF-8 comment bytes. Built by
// hand here rather than pulling in @ton/core, which ships no browser bundle
// this project's plain <script>-tag setup (no bundler) could consume.
// Verified byte-for-byte against @ton/core's own beginCell()...toBoc() output
// across several inputs before wiring this in.
function _crc32c(bytes) {
  const POLY = 0x82f63b78; // reflected Castagnoli polynomial
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (POLY & mask);
    }
  }
  return (~crc) >>> 0;
}

function _commentCellBoc(text) {
  const textBytes = new TextEncoder().encode(text || '');
  const dataBytes = new Uint8Array(4 + textBytes.length);
  dataBytes.set(textBytes, 4); // leading 4 bytes stay 0 — the plain-comment op-code
  if (dataBytes.length > 127) throw new Error('Комментарий слишком длинный');

  const d1 = 0; // 0 refs, not exotic, level 0
  const d2 = dataBytes.length * 2; // byte-aligned data — standard d2 encoding

  const cellPart = new Uint8Array(2 + dataBytes.length);
  cellPart[0] = d1;
  cellPart[1] = d2;
  cellPart.set(dataBytes, 2);

  const header = new Uint8Array([
    0xb5, 0xee, 0x9c, 0x72, // BOC magic
    0x40 | 0x01,            // has_crc32c=1, size_bytes=1
    0x01,                   // off_bytes=1
    0x01,                   // cell count = 1
    0x01,                   // root count = 1
    0x00,                   // absent count = 0
    cellPart.length,        // total cells size (fits one byte for our tiny payload)
    0x00,                   // root list: root cell index 0
  ]);

  const body = new Uint8Array(header.length + cellPart.length);
  body.set(header, 0);
  body.set(cellPart, header.length);

  const crc = _crc32c(body);
  const out = new Uint8Array(body.length + 4);
  out.set(body, 0);
  out[body.length]     = crc & 0xff;
  out[body.length + 1] = (crc >>> 8) & 0xff;
  out[body.length + 2] = (crc >>> 16) & 0xff;
  out[body.length + 3] = (crc >>> 24) & 0xff;
  return out;
}

function _bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// Sends amountTon (GRAM==TON 1:1 in this game) from the connected wallet to
// the game's deposit address, with `memo` as the on-chain comment — the same
// code the copy-paste box shows, and the same one the server issued. Resolves
// once the wallet confirms the user approved it; the balance moves later,
// when the scanner sees the transfer on chain.
//
// `memo` is load-bearing in a way an argument rarely is: it is the ONLY thing
// tying the transfer that leaves here to an account. Callers must pass the
// server's code and nothing else — see _tcDepositSend (js/ui.js), which
// refuses to call this at all until one has arrived.
// ── one tap, one transfer ───────────────────────────────────────────────────
// The button that calls this is disabled by its own handler, and that is not
// enough. It lives in js/ui.js, which is being rewritten; the disable happens
// after two awaits and an early return; and a wallet that opens a modal gives
// the player several seconds of a live screen behind it. A second tap while
// the first transfer is in flight signs and broadcasts a SECOND transfer —
// real money, gone twice, with nothing downstream able to tell the two apart,
// because both carry the same comment and both are genuine payments. That is
// the same shape as the buff-potion storm: a client-side guard that lived on
// the button rather than on the thing the button fires.
//
// So the guard lives HERE, at the last line before a transfer leaves a wallet.
//
// A DEADLINE, not a flag. _tonConnectUI.sendTransaction() resolves when the
// wallet confirms, and the ways it never resolves are ordinary: the player
// switches to Tonkeeper and does not come back, the bridge drops the reply,
// the tab is backgrounded by the OS. A plain boolean left set by any of those
// wedges the button until reload — and a player who cannot pay decides the
// game is broken, which is a worse outcome than the bug being guarded against.
//
// The window is validUntil, and deliberately the SAME number: that is exactly
// how long the message already signed can still land on chain, so it is
// exactly how long a second one would be a genuine double payment. Past it the
// first attempt can no longer be executed and retrying is correct.
const TC_SEND_WINDOW_MS = 300 * 1000;
let _tcSendUntil = 0;

async function tcSendDeposit(walletAddress, amountTon, memo) {
  if (!_tonConnectUI || !_tonConnectedAddress) throw new Error('Кошелёк не подключен');
  const now = Date.now();
  if (now < _tcSendUntil) {
    // Refused, and it says so out loud: a silent return here would look
    // exactly like a transfer that was sent, and the player would wait for a
    // credit that is not coming.
    const left = Math.ceil((_tcSendUntil - now) / 1000);
    console.warn(`[tonconnect] повторная отправка отклонена, ещё ${left}s`);
    // Into player_logs as `client:tcSendDeposit`, through the same reporter
    // every other client failure uses. A refusal that only ever existed as a
    // toast is a refusal nobody can count, and how often this fires is the
    // only way to find out whether double-tapping is actually happening.
    if (typeof window.__reportClientError === 'function') {
      window.__reportClientError('tcSendDeposit', `duplicate send blocked, ${left}s left`);
    }
    throw new Error('Перевод уже отправляется — подождите');
  }
  _tcSendUntil = now + TC_SEND_WINDOW_MS;
  const nanotons = Math.round(amountTon * 1e9).toString();
  const payload = _bytesToBase64(_commentCellBoc(String(memo)));
  try {
    return await _tonConnectUI.sendTransaction({
      validUntil: Math.floor(now / 1000) + TC_SEND_WINDOW_MS / 1000,
      messages: [{ address: walletAddress, amount: nanotons, payload }],
    });
  } catch (err) {
    // The wallet REFUSED or failed, so nothing was signed and nothing is in
    // flight. Releasing at once is the difference between "I cancelled by
    // mistake, let me try again" and five minutes of a dead button.
    _tcSendUntil = 0;
    throw err;
  }
  // A resolved send holds the window: the transfer is on its way, and the
  // player watching their balance not move yet is exactly who taps again.
}
