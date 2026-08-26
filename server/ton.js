'use strict';
// ── TON chain reader ────────────────────────────────────────────────────────
// Reads incoming transfers to the deposit address via TonAPI. Read-only: the
// server holds no private key and can move nothing on-chain. Payouts stay
// manual by design — the difference from the old build is that money coming IN
// is now verified by the chain instead of by an admin looking at a message.
//
// The rules below are what separate this from "fetch some JSON and trust it".
// Each one exists because getting it wrong loses or invents real money:
//
//   * a failed fetch must be distinguishable from "no new events". They look
//     identical (both yield nothing) and the failure mode is a silent deposit
//     outage — money arriving, nothing crediting, no error anywhere.
//   * the watermark advances ONLY on a clean pass. Advancing past events we
//     could not read means those deposits are never seen again.
//   * direction is checked. The events feed carries outgoing transfers too,
//     and crediting one would pay a player for money we sent them.
//   * an address is validated before it goes into a URL path. It is
//     configuration rather than user input today, but a value that can reach a
//     URL path is one that can inject path and query segments.
//   * a transfer is named by something the chain cannot rename. See below.
//
// ── the name of a payment ───────────────────────────────────────────────────
//
// This one cost an alert on every deposit and is worth stating in full,
// because it looks like a detail and is the whole correctness of the scanner.
//
// A transfer used to be named `${event.event_id}:${actionIndex}`. On
// 25 August one 0.05 TON payment produced a credit at 21:52 and
// "⚠️ Платёж не зачислен" at 21:53. Both hashes fetched back from TonAPI
// resolve to the SAME event:
//
//   /v2/events/f7f5e993…  →  event_id 1058d708…  lt 99405635000001  1 action
//   /v2/events/1058d708…  →  event_id 1058d708…  lt 99405635000001  1 action
//
// One transfer, one lt, two names. TonAPI reports an event whose trace is
// still in flight under a PROVISIONAL id; when the trace settles the same
// transfer comes back under its final one. Nothing here read `in_progress`, so
// the scanner named a payment after a value that was about to change, stored
// that name, and then failed to recognise the payment it had already credited.
//
// Two changes, and they are independent on purpose — either alone fixes the
// symptom, and money paths do not rest on one thing being right:
//
//   1. AN UNSETTLED TRACE IS NOT READ AT ALL. An id that is going to change is
//      not an id, and there is nothing to gain from being a minute early.
//   2. A TRANSFER IS NAMED BY `${lt}:${actionIndex}`. `lt` is the receiving
//      account's own logical time — the same value the watermark is built on
//      and pages on, so the scanner already depends on it being stable and
//      monotonic. It was IDENTICAL across both readings above. One transaction
//      on an account has exactly one lt, so two genuine transfers can never
//      collide; several transfers inside one trace are separated by the index,
//      as they were before.
//
// `event_id` is still carried, and still used — for the Tonviewer link. That
// is the job it can do: a name a human can paste into an explorer. It just
// cannot be the name we file money under, and one column was being asked to be
// both.

const ADDR_RE = /^(?:-?\d+:[0-9a-fA-F]{64}|[A-Za-z0-9_-]{48})$/;
const NANOTON = 1_000_000_000n;

const BASE = process.env.TONAPI_BASE || 'https://tonapi.io';
const KEY = process.env.TONAPI_KEY || '';
// The keyless public tier is rate-limited and returns scattered 5xx all day.
// A key is not required, but without one the failure alerts below will be
// noisier and the poll budget smaller.
const HTTP_TIMEOUT_MS = 15000;


// ── raw address → the form a person recognises ──────────────────────────────
// TonAPI reports a sender as `0:755933366ad0…` — the raw workchain:hash pair.
// Correct, and unreadable: an operator looking at an alert cannot match it
// against the `UQ…` their wallet shows them, cannot paste it into Tonviewer's
// search, and cannot tell two senders apart at a glance.
//
// The friendly form is the same 33 bytes with a tag and a checksum, in
// base64url:
//
//   [tag][workchain][32-byte hash][CRC16-CCITT of the previous 34]
//
// The tag says how the network should treat a message that cannot be
// delivered. 0x51 is non-bounceable — the `UQ` prefix, and what a wallet shows
// for an ordinary account, because a payment to a person should stay put
// rather than come back. 0x11 is bounceable, `EQ`, used for contracts.
//
// The checksum is the reason the friendly form exists at all: a mistyped
// character fails to decode instead of sending money to nobody.
function _crc16(buf) {
  // CRC16-CCITT (XModem), polynomial 0x1021, which is what TON specifies.
  let crc = 0;
  for (const b of buf) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function friendlyAddress(raw, { bounceable = false, testnet = false } = {}) {
  const s = String(raw || '').trim();
  // Already friendly: hand it back untouched rather than round-tripping it,
  // which would silently rewrite an EQ someone gave us into a UQ.
  if (/^[UEk0-9][QF][A-Za-z0-9_-]{46}$/.test(s)) return s;

  const m = /^(-?\d+):([0-9a-fA-F]{64})$/.exec(s);
  if (!m) return s;                       // not an address — show it as it came

  const wc = Number(m[1]);
  const hash = Buffer.from(m[2], 'hex');
  let tag = bounceable ? 0x11 : 0x51;
  if (testnet) tag |= 0x80;

  const body = Buffer.alloc(34);
  body[0] = tag;
  body[1] = wc < 0 ? 0xff : wc & 0xff;    // -1 (masterchain) is stored as 0xff
  hash.copy(body, 2);

  const out = Buffer.alloc(36);
  body.copy(out, 0);
  out.writeUInt16BE(_crc16(body), 34);
  return out.toString('base64url');
}

// Shortened for a card that has to stay readable on a phone. The middle is
// what carries no meaning to a human; the ends are what they compare.
function shortAddress(raw, keep = 6) {
  const a = friendlyAddress(raw);
  return a.length > keep * 2 + 3 ? `${a.slice(0, keep)}…${a.slice(-keep)}` : a;
}

function validAddress(a) {
  return typeof a === 'string' && ADDR_RE.test(a.trim());
}

const norm = a => String(a || '').trim().toLowerCase();

function _headers() {
  return KEY ? { Authorization: `Bearer ${KEY}` } : {};
}

async function _get(path, { attempts = 3 } = {}) {
  const url = `${BASE}${path}`;
  for (let i = 0; i < attempts; i++) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), HTTP_TIMEOUT_MS);
      let res;
      try {
        res = await fetch(url, { headers: _headers(), signal: ctl.signal });
      } finally { clearTimeout(timer); }

      if (res.status === 200) return { data: await res.json(), ok: true };
      // 4xx (except 429) is our mistake — a bad address, a bad key. Retrying
      // it just wastes the budget and delays the alert.
      if (res.status < 500 && res.status !== 429) {
        console.warn(`[ton] HTTP ${res.status} (not retryable) ${path}`);
        return { data: null, ok: false };
      }
      console.warn(`[ton] HTTP ${res.status} (attempt ${i + 1}/${attempts})`);
    } catch (err) {
      console.warn(`[ton] fetch failed (attempt ${i + 1}/${attempts}): ${err.message}`);
    }
    if (i < attempts - 1) await new Promise(r => setTimeout(r, 1500 * (i + 1)));
  }
  return { data: null, ok: false };
}

// ── address resolution ──────────────────────────────────────────────────────
// TonAPI reports addresses inside events in raw ("0:hex") form, while the
// configured deposit address is usually the user-friendly UQ/EQ form. Comparing
// the two directly never matches, so every incoming transfer would look like it
// was addressed elsewhere and nothing would ever credit. Both sides are
// normalised to raw before comparison.
let _ourRaw = null;

async function resolveRaw(address) {
  if (!validAddress(address)) return null;
  const { data, ok } = await _get(`/v2/accounts/${encodeURIComponent(address.trim())}`);
  if (!ok || !data) return null;
  return norm(data.address) || null;
}

// Cached, but re-resolved on failure rather than cached as null: a TonAPI blip
// during boot must not permanently disable deposits until someone restarts.
async function ourAddressRaw() {
  if (_ourRaw) return _ourRaw;
  const addr = process.env.GRAM_WALLET || '';
  if (!validAddress(addr)) {
    console.error('[ton] GRAM_WALLET is missing or not a valid TON address — deposits disabled');
    return null;
  }
  _ourRaw = await resolveRaw(addr);
  return _ourRaw;
}

// ── event feed ──────────────────────────────────────────────────────────────

// One page. `ok:false` means the call FAILED; an empty `events` with ok:true
// means there genuinely are none. The caller must be able to tell those apart.
async function fetchEvents(limit, beforeLt = null) {
  const addr = process.env.GRAM_WALLET || '';
  if (!validAddress(addr)) return { events: [], ok: false };
  const q = `/v2/accounts/${encodeURIComponent(addr.trim())}/events?limit=${limit}` +
            (beforeLt ? `&before_lt=${encodeURIComponent(String(beforeLt))}` : '');
  const { data, ok } = await _get(q);
  return { events: ok && data ? (data.events || []) : [], ok };
}

// Pages BACKWARD via before_lt until it crosses the watermark, so a busy
// address (more than one page of activity between ticks) never loses a
// transfer that fell past the first page.
//
// `clean` is the important half of the return value. It is true only when the
// walk terminated because it reached known ground — crossed the watermark, or
// hit a short final page. A fetch error or exhausting the page budget leaves it
// false, and the caller must then NOT advance the watermark: re-scanning is
// free (crediting is idempotent), while skipping past unread events loses real
// deposits with no trace.
// ── the mark must not step over a trace that has not landed ─────────────────
// incomingFrom() refuses an `in_progress` event, because its id is provisional.
// That refusal is only safe if the watermark ALSO stays behind it: the mark
// advances to `highest` on a clean pass, and a mark that moved past an event
// this pass declined to read is an event that is never read again — a deposit
// lost outright, silently, which the header above calls the one outcome worse
// than reporting a payment twice.
//
// So an unsettled event pins the mark just below its own lt. The next tick
// re-fetches from there, finds the trace settled, and credits it. Nothing is
// skipped; it is deferred by one tick, and the overlap that costs is free
// because crediting is idempotent — the property this whole file leans on.
//
// Only events ABOVE the current mark can pin it. A long-unsettled trace down
// in already-scanned history would otherwise drag the mark backwards and
// re-open the wallet's past, which is the failure scanOnce's bootstrap exists
// to prevent.
async function fetchSince(watermark, { pageSize = 50, maxPages = 20 } = {}) {
  const out = [];
  let beforeLt = null, highest = watermark, clean = false, failed = false;
  let holdAt = Infinity;

  for (let i = 0; i < maxPages; i++) {
    const { events, ok } = await fetchEvents(pageSize, beforeLt);
    if (!ok) { failed = true; break; }
    if (!events.length) { clean = true; break; }
    out.push(...events);

    const lts = events.map(e => Number(e.lt || 0));
    highest = Math.max(highest, ...lts);
    for (const e of events) {
      if (!e || e.in_progress !== true) continue;
      const l = Number(e.lt || 0);
      if (l > watermark) holdAt = Math.min(holdAt, l);
    }
    const oldest = Math.min(...lts);
    if (!oldest || oldest <= watermark || events.length < pageSize) { clean = true; break; }
    beforeLt = oldest;
  }

  // holdAt > watermark by construction, so this can only ever hold the mark
  // still or move it forward — never back.
  if (holdAt !== Infinity) highest = Math.min(highest, holdAt - 1);
  return { events: out, highest, clean, failed };
}

// ── parsing ─────────────────────────────────────────────────────────────────

// One action → an incoming TON transfer, or null.
//
// Only plain TON is accepted. Liberty's GRAM is 1:1 with TON, and a jetton
// branch would need the master address checked and the decimals taken from our
// own configuration rather than the reported value — a wrong `decimals` shifts
// the credited amount by orders of magnitude. Until there is a reason to accept
// jettons, refusing them outright is the safer default.
function parseAction(action, ourRaw) {
  if (!action || action.status !== 'ok') return null;
  if (action.type !== 'TonTransfer') return null;
  const d = action.TonTransfer || {};

  // Incoming only. The feed carries both directions, and crediting an outgoing
  // transfer would pay a player for money we sent them.
  if (norm(d.recipient && d.recipient.address) !== ourRaw) return null;

  let nano;
  try { nano = BigInt(d.amount || 0); } catch { return null; }
  if (nano <= 0n) return null;

  // Whole nanotons through BigInt, converted to a decimal STRING — never a
  // float. The amount goes straight into numeric(24,8), and parsing it via
  // Number on the way would put back exactly the precision loss numeric exists
  // to avoid.
  const whole = nano / NANOTON;
  const frac = (nano % NANOTON).toString().padStart(9, '0').slice(0, 8);

  return {
    currency: 'ton',
    amount: `${whole}.${frac}`,
    comment: String(d.comment || '').trim(),
    sender: (d.sender && d.sender.address) ? String(d.sender.address) : null,
  };
}

// Every incoming transfer in a batch of events, de-duplicated by tx id.
//
// `${lt}:${index}` — the receiving account's logical time, plus the action's
// position within the trace. See the header for why it is not the event id.
// The index is still needed because one trace can carry several transfers to
// us, and two of them sharing a key would mean only one was ever credited.
function incomingFrom(events, ourRaw) {
  const seen = new Set();
  const out = [];
  for (const ev of events) {
    if (!ev) continue;
    // ── not settled, therefore not named ────────────────────────────────────
    // Deliberately checked here as well as on the id, and note that
    // parseAction's `action.status !== 'ok'` is NOT this check: an action can
    // be 'ok' inside an event whose trace is still in flight, which is exactly
    // the state that produced a credit and a false alarm for the same 0.05 TON.
    // fetchSince holds the watermark below this event so the next tick sees it
    // settled; nothing is dropped.
    if (ev.in_progress === true) continue;
    const lt = Number(ev.lt || 0);
    // Never key on 0. A malformed event with no logical time has no name, and
    // filing money under '0:0' would collide every such transfer into one row.
    if (!lt) continue;
    // The event id is the LINK, not the name, so a missing one costs a
    // clickable URL and not a deposit. It used to be the key, and `continue`
    // here would have thrown the money away with the hyperlink.
    const evId = ev.event_id ? String(ev.event_id) : null;
    const actions = ev.actions || [];
    for (let i = 0; i < actions.length; i++) {
      const parsed = parseAction(actions[i], ourRaw);
      if (!parsed) continue;
      const txId = `${lt}:${i}`;
      if (seen.has(txId)) continue;         // page overlap saw it twice
      seen.add(txId);
      out.push({ ...parsed, txId, eventId: evId, lt, utime: Number(ev.timestamp || 0) });
    }
  }
  return out;
}

// A link an admin can open to check a transfer against the chain themselves.
//
// Takes an event id, or a stored id in either form — the historical
// `<64 hex>:<index>` and the current `<lt>:<index>`. Only the first is a name
// Tonviewer can resolve, so the second returns null rather than a URL that
// opens on "transaction not found": a link that lands nowhere is worse than a
// visibly absent one, because the operator concludes the transfer is not on
// the chain. Callers that hold the event id separately pass THAT.
const HASH_RE = /^[0-9a-fA-F]{64}$/;
function explorerLink(idOrHash) {
  const head = String(idOrHash || '').split(':')[0];
  return HASH_RE.test(head) ? `https://tonviewer.com/transaction/${head}` : null;
}

module.exports = {
  friendlyAddress, shortAddress,
  validAddress, resolveRaw, ourAddressRaw,
  fetchEvents, fetchSince, parseAction, incomingFrom, explorerLink,
  norm,
};
