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
    _tonConnectedAddress = wallet ? wallet.account.address : null;
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
async function tcSendDeposit(walletAddress, amountTon, memo) {
  if (!_tonConnectUI || !_tonConnectedAddress) throw new Error('Кошелёк не подключен');
  const nanotons = Math.round(amountTon * 1e9).toString();
  const payload = _bytesToBase64(_commentCellBoc(String(memo)));
  return _tonConnectUI.sendTransaction({
    validUntil: Math.floor(Date.now() / 1000) + 300,
    messages: [{ address: walletAddress, amount: nanotons, payload }],
  });
}
