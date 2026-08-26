// ─────────────────────────────────────────────────────────
//  Binary codec for gameState packets (shared client/server)
//
//  JSON gameState entries cost ~70-130 bytes each; the binary form is
//  ~13 bytes for a slim player and ~14 for a slim enemy (still 6-9x less),
//  plus far cheaper parsing than JSON on mobile.
//
//  Entries reference entities by small numeric handles (player _seq /
//  enemy _idx); the string ids travel only inside FULL entries, and the
//  decoder keeps handle→id maps that the periodic full refresh repairs
//  if they ever diverge. Coordinates quantize to 0.5px (u32), the enemy
//  attack timer to 10ms (u8).
//
//  Coordinates are u32, not u16: the open world's arms are stacked by Y
//  (server/game/dungeon.js) and the map is ~66000px tall, well past what
//  0.5px-quantized u16 can hold (max 32767.5px) — anything deeper than
//  that (roughly the second half of the 'top' arm, and all of 'bottom'/
//  'right') used to have every x/y silently clamped to the same maxed-out
//  value on the wire, so those entities rendered pinned to one spot
//  (enemies looked frozen/"running in place") wherever they actually were
//  on the server, while still hitting players normally since the server's
//  own AI/attack logic never went through this codec at all.
//
//  Layout (little-endian):
//   u8  flags            bit0 = packet has players array
//   f64 t                server tick timestamp
//   [players] u8 count (capped well under 255 by PLAYER_CAP, Room.js), per entry:
//     u8  flags          bit0 = full, bit1 = moving
//     u16 seq            player handle
//     u32 x*2, u32 y*2
//     u8  facing         index into NC_FACING
//     i32 hp
//     u16 atkSeq
//     full only: str id, str username, u8 charType (255=none),
//                i32 maxHp, u8 pvpMode, str clanName, u8 clanIcon
//   [enemies] u16 count (a shared open world can hold hundreds), per entry:
//     u8  flags          bit0 = full
//     u16 idx            enemy handle
//     u32 x*2, u32 y*2
//     i32 hp
//     u8  aggro
//     u8  atkAnimTimer*100
//     full only: str id, str eid, i32 maxHp, str name, str color,
//                u8 size, u8 isBoss, f32 aggroR, u16 spd, u8 rlvl
//   [projectiles] u16 count, per entry (19 bytes):
//     u32 x*2, u32 y*2, i16 vx, i16 vy, u8 size, u8 life*20,
//     u8 r, u8 g, u8 b, u8 flags (bit0 = arrow), u8 age (10ms units)
//   [aoe rings]   u8 count, per entry (17 bytes): u32 x*2, u32 y*2, u16 radius,
//                 u8 style (index into NC_AOE_STYLES), u8 r,g,b, u8 r2,g2,b2
//                 (color/color2 — unused by 'classic' and most styles, sent
//                 anyway so every entry stays fixed-size; see spawnAOE,
//                 js/particles.js, and _updateAoeRings, js/pixi-world.js)
//   [race lanes]  u8 count, per entry (3 bytes): u16 seq (player handle), u8 lane
//   str = u8 byteLength + UTF-8 bytes
//
//  The projectile/AOE sections carry what used to be the 'spawnProj'/
//  'spawnAoe' events — one JSON packet per arrow, per recipient, ~133 bytes
//  each and 28% of everything a player downloaded during a fight. Riding the
//  world cast instead costs no packet, no socket.io envelope and no extra
//  syscall, and the entry is 19 bytes because most of that JSON was
//  derivable: `angle` is atan2(vy, vx), and the rest is the shooter's own
//  class constants.
//
//  Race lanes: one (seq, lane) pair per streamed player currently racing
//  (Кровавая Башня), client-side only — see the pIsRacer exception in
//  Room.js's per-player candidate filter for why a racer's own full/slim
//  player entry no longer implies isolation the way it used to, and js/
//  input.js's cycleTarget for what reads this back out. Kept as its own
//  section rather than a field on every player entry (most players are never
//  racing, so that field would be dead weight in every single packet) and
//  only carries an entry when the corresponding player entry this same
//  packet was full — a slim entry's lane hasn't changed, so the client just
//  keeps what it already has.
//
//  All three trailing sections are APPENDED, which is what makes the change
//  safe to deploy without a flag day: a client running older code stops at
//  the enemy list (or wherever its own older layout ends) and ignores the
//  trailing bytes, and a client running newer code against an older server
//  finds the packet ended and treats every trailing count as zero.
// ─────────────────────────────────────────────────────────

const NC_FACING = ['front', 'back', 'left', 'right', 'frontright', 'frontleft', 'backleft', 'backright'];
// Appended, never reordered — indices are wire values other clients/servers
// may already have cached.
const NC_CHAR_TYPES = ['lev', 'deathknight', 'ranger', 'mage', 'warlock'];

const _ncEnc = new TextEncoder();
const _ncDec = new TextDecoder();
// Scratch buffer, grown on demand (never shrunk) — a shared open world can
// have hundreds of enemies in view at once (vs. a handful on the old
// per-floor maps this was originally sized for), and a burst of "full"
// entries (e.g. every enemy on a player's very first tick) is much bigger
// than a steady-state delta packet. A fixed-size buffer that a big encode
// overflows throws mid-tick and takes the whole Room loop down with it, so
// growth here has to be unconditional, not just a bigger constant.
let _ncBuf = new ArrayBuffer(65536);
let _ncDV  = new DataView(_ncBuf);
let _ncU8  = new Uint8Array(_ncBuf);
function _ncEnsure(o, extra) {
  const need = o + extra;
  if (need <= _ncBuf.byteLength) return;
  let cap = _ncBuf.byteLength;
  while (cap < need) cap *= 2;
  const nu8 = new Uint8Array(cap);
  nu8.set(_ncU8);
  _ncBuf = nu8.buffer;
  _ncU8 = nu8;
  _ncDV = new DataView(_ncBuf);
}
// Generous per-entry upper bound (id/eid/name/color/username/clanName are
// each at most a u8-length-prefixed string, i.e. 256 bytes; several of them
// plus the fixed numeric fields comfortably fit in 1200 bytes) — checked
// once before each entry instead of before every individual field write.
const _NC_ENTRY_HEADROOM = 1200;

// Decoder handle→id maps. Reset on floor change / game start — handles are
// scoped to the current room.
const _ncPIdMap = new Map(); // seq -> socketId
const _ncEIdMap = new Map(); // idx -> enemy id string

function resetNetCodecMaps() { _ncPIdMap.clear(); _ncEIdMap.clear(); _ncLostIdx = 0; }

// Slim enemy deltas naming a handle this decoder was never given a full record
// for. That happens for exactly one reason: the packet carrying the full
// record was DROPPED — the world cast is volatile.emit, which is meant to drop
// rather than queue on a socket that is backed up.
//
// The decoder used to discard those entries with a bare `if (id !== undefined)`
// and no else. The enemy then did not exist on that client at all — and, the
// part that made it last, the client's own repair (_queueEnemyResync,
// js/network.js) could never fire for it, because that trigger lives inside a
// loop over the enemies the decoder produced, and it produced none. Nothing
// fixed it until ENEMY_REFRESH_CASTS came round: sixty seconds.
// "Моби тупо стоять, взагалі не включаються" is this, and it was silent on
// both ends.
let _ncLostIdx = 0;
function netCodecLostIdx() { const n = _ncLostIdx; _ncLostIdx = 0; return n; }

// The length prefix is a single byte, so anything past 255 bytes has to be
// dropped here rather than written: `_ncU8[o] = b.length` silently keeps only
// the low 8 bits, and the decoder then reads the wrong length and misparses
// everything after this string in the packet — for every client the entry was
// sent to. Names are already normalised on the way in (_safeUsername,
// server/index.js), so this is the backstop for any other string field.
// Truncation is by whole bytes and can split a multi-byte character; the
// decoder's TextDecoder replaces the stray bytes rather than throwing.
function _ncWStr(o, s) {
  let b = _ncEnc.encode(s == null ? '' : String(s));
  if (b.length > 255) b = b.subarray(0, 255);
  _ncU8[o] = b.length;
  _ncU8.set(b, o + 1);
  return o + 1 + b.length;
}

// 0.5px quantization for a coordinate, clamped to what a u32 field can hold —
// see the file header for why this needs the full 32 bits, not 16.
function _ncQPos(v) { return Math.max(0, Math.min(4294967295, Math.round(v * 2))); }

// Caches the encoded ENEMIES segment across calls within the same tick —
// Room.js broadcasts the identical nearEnemies snapshot to every connected
// player, but this function used to re-encode it (including per-entry
// TextEncoder calls for "full" entries' string fields) from scratch on
// every single call. Measured at ~0.23ms/call with a realistic ~200-entry
// snapshot; at ~200 concurrent players that's ~46ms of pure duplicated work
// every tick, well past the 25ms tick budget on its own. `enemiesGen` (an
// opaque number Room.js bumps once per tick, right after rebuilding
// nearEnemies) is the cache-invalidation key — a plain reference-equality
// check on `enemies` doesn't work here since Room.js reuses the same array
// object (just cleared and refilled) every tick rather than allocating a
// fresh one. Callers that don't pass enemiesGen (or pass a fresh event
// number each time) simply never hit the cache, encoding normally.
let _ncEnemiesCacheGen = NaN;
let _ncEnemiesCacheBytes = null;

// "#8fbf5a" / "#8f5" / "#8fbf5aff" -> [143, 191, 90]. Projectile colours are
// authored as hex literals in js/player.js and js/combat.js and validated to
// that shape by the server before they ever reach here, so three bytes is a
// lossless representation of every colour the game actually sends.
function _ncRgb(s) {
  const h = typeof s === 'string' ? s.replace('#', '') : '';
  if (h.length >= 6) return [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0];
  if (h.length >= 3) return [parseInt(h[0] + h[0], 16) || 0, parseInt(h[1] + h[1], 16) || 0, parseInt(h[2] + h[2], 16) || 0];
  return [255, 255, 255];
}
function _ncHex(r, g, b) {
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

// AOE ring visual style, by wire index — see spawnAOE (js/particles.js) for
// what each one actually draws. Index 0 ('classic') is also the fallback for
// any value the sender didn't recognize, so an unmatched style never crashes
// the decoder, just draws the original plain ring.
const NC_AOE_STYLES = ['classic', 'shockwave', 'pulse', 'flash', 'frost', 'fissure', 'bloodwave'];

function encodeGameState(players, enemies, t, enemiesGen, projs, aoes) {
  let o = 0;
  _ncEnsure(o, 16);
  _ncDV.setUint8(o, players ? 1 : 0); o += 1;
  _ncDV.setFloat64(o, t, true); o += 8;

  if (players) {
    // PLAYER_CAP (Room.js) keeps this well under 255 — u8 is safe.
    _ncDV.setUint8(o, Math.min(255, players.length)); o += 1;
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      _ncEnsure(o, _NC_ENTRY_HEADROOM);
      const full = p.username !== undefined;
      // moving rides the spare bit in the flags byte the receiver already
      // reads — no extra bytes. It's the sender's own input state (see
      // netSendMove, js/network.js), not something derived from position
      // deltas after the fact: those go stale and noisy by the time they've
      // crossed the network and sat in the interpolation buffer, which used
      // to flip the run/idle animation key on a dropped or late packet.
      _ncDV.setUint8(o, (full ? 1 : 0) | (p.moving ? 2 : 0)); o += 1;
      _ncDV.setUint16(o, p.seq & 0xffff, true); o += 2;
      _ncDV.setUint32(o, _ncQPos(p.x), true); o += 4;
      _ncDV.setUint32(o, _ncQPos(p.y), true); o += 4;
      _ncDV.setUint8(o, Math.max(0, NC_FACING.indexOf(p.facing))); o += 1;
      _ncDV.setInt32(o, p.hp | 0, true); o += 4;
      _ncDV.setUint16(o, (p.atkSeq || 0) & 0xffff, true); o += 2;
      if (full) {
        o = _ncWStr(o, p.id);
        o = _ncWStr(o, p.username);
        _ncDV.setUint8(o, p.type ? Math.max(0, NC_CHAR_TYPES.indexOf(p.type)) : 255); o += 1;
        _ncDV.setInt32(o, p.maxHp | 0, true); o += 4;
        _ncDV.setUint8(o, p.pvpMode ? 1 : 0); o += 1;
        o = _ncWStr(o, p.clanName || '');
        _ncDV.setUint8(o, p.clanIcon || 0); o += 1;
      }
    }
  }

  if (enemiesGen !== undefined && enemiesGen === _ncEnemiesCacheGen && _ncEnemiesCacheBytes) {
    // Same enemies snapshot as the last call this tick — reuse the bytes
    // instead of re-running the (string-heavy) encode loop below.
    _ncEnsure(o, _ncEnemiesCacheBytes.length);
    _ncU8.set(_ncEnemiesCacheBytes, o);
    o += _ncEnemiesCacheBytes.length;
  } else {
    const enemiesStart = o;
    // u16 — a shared open world can have hundreds of enemies in view at once
    // (unlike the old per-floor maps this was originally u8-sized for).
    _ncEnsure(o, 2);
    _ncDV.setUint16(o, Math.min(65535, enemies.length), true); o += 2;
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      _ncEnsure(o, _NC_ENTRY_HEADROOM);
      const full = e.eid !== undefined;
      _ncDV.setUint8(o, full ? 1 : 0); o += 1;
      _ncDV.setUint16(o, e.idx & 0xffff, true); o += 2;
      _ncDV.setUint32(o, _ncQPos(e.x), true); o += 4;
      _ncDV.setUint32(o, _ncQPos(e.y), true); o += 4;
      _ncDV.setInt32(o, e.hp | 0, true); o += 4;
      _ncDV.setUint8(o, e.aggro ? 1 : 0); o += 1;
      _ncDV.setUint8(o, Math.max(0, Math.min(255, Math.round((e.atkAnimTimer || 0) * 100)))); o += 1;
      if (full) {
        o = _ncWStr(o, e.id);
        o = _ncWStr(o, e.eid);
        _ncDV.setInt32(o, e.maxHp | 0, true); o += 4;
        o = _ncWStr(o, e.name);
        o = _ncWStr(o, e.color);
        _ncDV.setUint8(o, Math.max(0, Math.min(255, e.size | 0))); o += 1;
        _ncDV.setUint8(o, e.isBoss ? 1 : 0); o += 1;
        _ncDV.setFloat32(o, e.aggroR || 0, true); o += 4;
        _ncDV.setUint16(o, Math.max(0, Math.min(65535, e.spd | 0)), true); o += 2;
        _ncDV.setUint8(o, Math.max(0, Math.min(255, e.rlvl | 0))); o += 1;
      }
    }
    if (enemiesGen !== undefined) {
      _ncEnemiesCacheGen = enemiesGen;
      _ncEnemiesCacheBytes = _ncU8.slice(enemiesStart, o);
    }
  }

  // Projectiles and AOE rings. Written after the enemy segment (and therefore
  // outside its byte cache) because they are per-recipient: two players in the
  // same fight see different arrows depending on who is within range of whom.
  const np = projs ? Math.min(projs.length, 65535) : 0;
  _ncEnsure(o, 2 + np * 19);
  _ncDV.setUint16(o, np, true); o += 2;
  for (let i = 0; i < np; i++) {
    const p = projs[i];
    _ncDV.setUint32(o, _ncQPos(p.x), true); o += 4;
    _ncDV.setUint32(o, _ncQPos(p.y), true); o += 4;
    _ncDV.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(p.vx))), true); o += 2;
    _ncDV.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(p.vy))), true); o += 2;
    _ncU8[o++] = Math.max(0, Math.min(255, Math.round(p.size)));
    // life in 1/20s steps: the longest projectile in the game lives 2s, and
    // the field tops out at 12.75s.
    _ncU8[o++] = Math.max(0, Math.min(255, Math.round(p.life * 20)));
    const rgb = _ncRgb(p.color);
    _ncU8[o++] = rgb[0]; _ncU8[o++] = rgb[1]; _ncU8[o++] = rgb[2];
    _ncU8[o++] = p.projType === 'arrow' ? 1 : 0;
    // How long this has already been queued, so the receiver can advance it to
    // where it should be by now instead of starting it late — a cast goes out
    // every 50ms and the shot can have happened at any point inside that.
    _ncU8[o++] = Math.max(0, Math.min(255, Math.round((p.ageMs || 0) / 10)));
  }

  const na = aoes ? Math.min(aoes.length, 255) : 0;
  _ncEnsure(o, 1 + na * 17);
  _ncU8[o++] = na;
  for (let i = 0; i < na; i++) {
    const a = aoes[i];
    _ncDV.setUint32(o, _ncQPos(a.x), true); o += 4;
    _ncDV.setUint32(o, _ncQPos(a.y), true); o += 4;
    _ncDV.setUint16(o, Math.max(0, Math.min(65535, Math.round(a.r))), true); o += 2;
    const styleIdx = Math.max(0, NC_AOE_STYLES.indexOf(a.style));
    _ncU8[o++] = styleIdx;
    const rgb = _ncRgb(a.color);
    _ncU8[o++] = rgb[0]; _ncU8[o++] = rgb[1]; _ncU8[o++] = rgb[2];
    const rgb2 = _ncRgb(a.color2 || a.color);
    _ncU8[o++] = rgb2[0]; _ncU8[o++] = rgb2[1]; _ncU8[o++] = rgb2[2];
  }

  // Race lanes — see the format note at the top. One entry per player whose
  // entry this packet is full — a slim entry never carries p.raceLane at all
  // (Room.js only sets it on the full shape), so `undefined` correctly skips
  // it there. 255 means "not currently racing", not just "no data" — a full
  // entry always has one or the other, so this is what lets the client learn
  // a racer just LEFT the race (their _raceLane went from a number to null)
  // instead of keeping a stale lane number forever once nothing resends it.
  let rlCount = 0;
  if (players) {
    _ncEnsure(o, 1);
    const rlCountAt = o; o += 1;
    for (let i = 0; i < players.length && rlCount < 255; i++) {
      const p = players[i];
      if (p.raceLane === undefined) continue;
      _ncEnsure(o, 3);
      _ncDV.setUint16(o, p.seq & 0xffff, true); o += 2;
      _ncU8[o++] = p.raceLane == null ? 255 : Math.max(0, Math.min(254, p.raceLane));
      rlCount++;
    }
    _ncU8[rlCountAt] = rlCount;
  } else {
    _ncEnsure(o, 1);
    _ncU8[o++] = 0;
  }

  // Copy — the scratch buffer is reused for the next recipient while
  // socket.io may still hold this payload for async transmission
  return _ncBuf.slice(0, o);
}

function decodeGameState(data) {
  const dv = ArrayBuffer.isView(data)
    ? new DataView(data.buffer, data.byteOffset, data.byteLength)
    : new DataView(data);
  const u8 = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);

  let o = 0;
  const flags = dv.getUint8(o); o += 1;
  const t = dv.getFloat64(o, true); o += 8;

  function rStr() {
    const len = u8[o]; o += 1;
    const s = _ncDec.decode(u8.subarray(o, o + len)); o += len;
    return s;
  }

  let players = null;
  if (flags & 1) {
    players = [];
    const n = dv.getUint8(o); o += 1;
    for (let i = 0; i < n; i++) {
      const f = dv.getUint8(o); o += 1;
      const moving = !!(f & 2);
      const seq = dv.getUint16(o, true); o += 2;
      const x = dv.getUint32(o, true) / 2; o += 4;
      const y = dv.getUint32(o, true) / 2; o += 4;
      const facing = NC_FACING[dv.getUint8(o)] || 'front'; o += 1;
      const hp = dv.getInt32(o, true); o += 4;
      const atkSeq = dv.getUint16(o, true); o += 2;
      if (f & 1) {
        const id = rStr();
        const username = rStr();
        const ti = dv.getUint8(o); o += 1;
        const maxHp = dv.getInt32(o, true); o += 4;
        const pvpMode = !!dv.getUint8(o); o += 1;
        const clanName = rStr() || null;
        const clanIcon = dv.getUint8(o) || null; o += 1;
        _ncPIdMap.set(seq, id);
        players.push({ id, username, type: ti === 255 ? null : NC_CHAR_TYPES[ti],
          x, y, facing, hp, maxHp, pvpMode, atkSeq, clanName, clanIcon, moving });
      } else {
        const id = _ncPIdMap.get(seq);
        // Unknown handle (map lost) — skip; the periodic full refresh
        // re-establishes the mapping within ~2s
        if (id !== undefined)
          players.push({ id, x, y, facing, hp, atkSeq, moving });
      }
    }
  }

  const enemies = [];
  const en = dv.getUint16(o, true); o += 2;
  for (let i = 0; i < en; i++) {
    const f = dv.getUint8(o); o += 1;
    const idx = dv.getUint16(o, true); o += 2;
    const x = dv.getUint32(o, true) / 2; o += 4;
    const y = dv.getUint32(o, true) / 2; o += 4;
    const hp = dv.getInt32(o, true); o += 4;
    const aggro = !!dv.getUint8(o); o += 1;
    const atkAnimTimer = dv.getUint8(o) / 100; o += 1;
    if (f & 1) {
      const id = rStr();
      const eid = rStr();
      const maxHp = dv.getInt32(o, true); o += 4;
      const name = rStr();
      const color = rStr();
      const size = dv.getUint8(o); o += 1;
      const isBoss = !!dv.getUint8(o); o += 1;
      const aggroR = dv.getFloat32(o, true); o += 4;
      const spd = dv.getUint16(o, true); o += 2;
      const rlvl = dv.getUint8(o); o += 1;
      _ncEIdMap.set(idx, id);
      enemies.push({ id, eid, x, y, hp, maxHp, name, color, size, isBoss,
        aggro, aggroR, spd, rlvl, atkAnimTimer });
    } else {
      const id = _ncEIdMap.get(idx);
      if (id !== undefined) enemies.push({ id, x, y, hp, aggro, atkAnimTimer });
      else _ncLostIdx++;   // a dropped full record — see netCodecLostIdx
    }
  }

  // Trailing sections. A server running older code simply ends the packet
  // here, so their absence is not an error — see the format note at the top.
  const projs = [];
  const aoes = [];
  if (o + 2 <= dv.byteLength) {
    const pn = dv.getUint16(o, true); o += 2;
    for (let i = 0; i < pn && o + 19 <= dv.byteLength; i++) {
      const x = dv.getUint32(o, true) / 2; o += 4;
      const y = dv.getUint32(o, true) / 2; o += 4;
      const vx = dv.getInt16(o, true); o += 2;
      const vy = dv.getInt16(o, true); o += 2;
      const size = u8[o++];
      const life = u8[o++] / 20;
      const r = u8[o++], g = u8[o++], b = u8[o++];
      const arrow = u8[o++] & 1;
      const age = u8[o++] / 100; // seconds
      // Advance to where it should be by now, and take the elapsed time off
      // its lifespan, so a projectile queued mid-cast doesn't visibly lag the
      // shot that produced it.
      projs.push({
        x: x + vx * age, y: y + vy * age, vx, vy, size,
        life: Math.max(0, life - age), color: _ncHex(r, g, b),
        projType: arrow ? 'arrow' : 'ball', angle: Math.atan2(vy, vx),
      });
    }
    if (o < dv.byteLength) {
      const an = u8[o++];
      for (let i = 0; i < an && o + 17 <= dv.byteLength; i++) {
        const x = dv.getUint32(o, true) / 2; o += 4;
        const y = dv.getUint32(o, true) / 2; o += 4;
        const r = dv.getUint16(o, true); o += 2;
        const style = NC_AOE_STYLES[u8[o++]] || 'classic';
        const cr = u8[o++], cg = u8[o++], cb = u8[o++];
        const cr2 = u8[o++], cg2 = u8[o++], cb2 = u8[o++];
        aoes.push({ x, y, r, style, color: _ncHex(cr, cg, cb), color2: _ncHex(cr2, cg2, cb2) });
      }
    }
  }

  // Race lanes — see the format note at the top. Resolved through the same
  // seq -> id map the player section above just fed (a hint for a player
  // whose full entry is in this very packet resolves immediately).
  const raceLaneById = new Map();
  if (o < dv.byteLength) {
    const rn = u8[o++];
    for (let i = 0; i < rn && o + 3 <= dv.byteLength; i++) {
      const seq = dv.getUint16(o, true); o += 2;
      const laneRaw = u8[o++];
      const id = _ncPIdMap.get(seq);
      if (id !== undefined) raceLaneById.set(id, laneRaw === 255 ? null : laneRaw);
    }
  }

  return { players, enemies, t, projs, aoes, raceLaneById };
}

// ── Dungeon grid packing ─────────────────────────────────────────────────────
// The open-world grid is ~1000×1000 tiles (~1M cells) — sent raw as nested
// JSON arrays that would be a multi-MB payload. Packed 1 bit/cell (WALL=0,
// FLOOR=1) it's ~125KB, which socket.io ships as a binary attachment (no
// base64 inflation) instead of JSON.
function packGrid(grid, w, h) {
  const buf = Buffer.alloc(Math.ceil((w * h) / 8));
  let bit = 0;
  for (let y = 0; y < h; y++) {
    const row = grid[y];
    for (let x = 0; x < w; x++) {
      if (row[x]) buf[bit >> 3] |= (1 << (bit & 7));
      bit++;
    }
  }
  return buf;
}

function unpackGrid(packed, w, h) {
  const u8 = packed instanceof Uint8Array ? packed : new Uint8Array(packed);
  const grid = new Array(h);
  let bit = 0;
  for (let y = 0; y < h; y++) {
    const row = new Uint8Array(w);
    for (let x = 0; x < w; x++) {
      row[x] = (u8[bit >> 3] >> (bit & 7)) & 1;
      bit++;
    }
    grid[y] = row;
  }
  return grid;
}

if (typeof module !== 'undefined')
  module.exports = { encodeGameState, decodeGameState, resetNetCodecMaps, netCodecLostIdx, packGrid, unpackGrid, NC_FACING, NC_AOE_STYLES };
