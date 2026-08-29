const crypto = require('crypto');
const { TILE, WALL } = require('./dungeon');
const { floorEntry } = require('./floors');
const { calcGoldDrop, CHAR_DEF, ARM_NAMES, EVENT_BOSS, EVENT_BOSS_DROP_LIFE_MS, rollEventBossDrops,
        ENEMY_AOI_R, enhanceBonus, passiveBonusTotal,
        ENEMY_DEF, FLOOR_ENEMIES, bandForLocalLevel, monsterStatsAtLevel, monsterNameAtLevel,
        monsterColorAtLevel, xpAtLevel, goldAtLevel, armIndexForLevel, ARM_OFFSETS, roomsInArm,
        GUILD_WAR_TOWER_HP, PASSIVE_MAX_LEVEL, PASSIVE_COMMON_DEF,
        skillDamageMult, COOP_STAGE_LEVELS, COOP_BOSS_LEVEL,
        SAFE_ZONE_REGEN_PER_SEC, BUTTERFLIES_TICK_PCT } = require('../../shared/definitions');

// ── Movement guard ──────────────────────────────────────────────────────────
// The fastest a player can legitimately move: the quickest class, with the
// move-speed passive maxed. Derived rather than written down so a new class or
// a retuned passive can't leave a stale number here (recompute(), js/player.js,
// applies exactly these two factors and nothing else — items and buffs do not
// touch speed).
const _MOVE_SPEED_MAX = Math.max(...Object.values(CHAR_DEF).map(c => c.speed || 0)) *
  (1 + PASSIVE_MAX_LEVEL * ((PASSIVE_COMMON_DEF.find(p => p.stat === 'moveSpeedPct') || {}).perLevel || 0));
// ...and the rate the bucket below actually refills at, which is deliberately
// a little faster than that.
//
// The number above is a fact about the GAME. This is a fact about the
// MEASUREMENT, and they are not the same number. The client moves for its own
// elapsed frame time and sends at 30Hz; the server can only time packet
// ARRIVALS. Any millisecond of one-way delay a packet saves relative to the
// one before it is a millisecond of refill the bucket never gets, for travel
// the client really did make. Over a long run that averages out — but the
// bucket is clamped to zero on an overdraft, so whatever surplus had
// accumulated is thrown away each time one lands, and a player at EXACTLY the
// cap (Егерь at 175 with "Быстрые ноги" maxed) has no surplus to accumulate in
// the first place. Charged against the bare cap, that player would overdraw on
// roughly every packet that happened to arrive early once anything drained the
// bucket — a teleport pad, a respawn, a floor change — which is five strikes
// inside a second and, in enforce mode, a permanent rubber-band on somebody
// playing the game correctly. That is the one false positive this design can
// actually produce, and it comes from charging a measured quantity against an
// exact one rather than from the rule being wrong.
//
// 20% is far below the smallest speedhack anyone bothers to write (the ones
// that get reported are 2x and up, and they drain a full bucket in seconds at
// either figure) and comfortably above the arrival jitter a mobile link
// produces at 30Hz.
const _MOVE_JITTER_TOLERANCE = 1.20;
const _MOVE_SPEED_CAP = _MOVE_SPEED_MAX * _MOVE_JITTER_TOLERANCE;
// How much unspent travel the bucket below may hold, in seconds of movement at
// that cap. This is the whole tolerance budget: a teleport, a respawn, a floor
// change or a lag spike that coalesces several seconds of running into one
// packet all get absorbed by it.
const _MOVE_BUCKET_S = 6;
// One overdraft is not evidence of anything — that is exactly what a teleport
// pad looks like, and players use those constantly. What separates a hack from
// a teleport is that a teleport happens ONCE and then the bucket refills,
// while sustained speeding overdraws on packet after packet. So nothing is
// reported or refused until _MOVE_STRIKES overdrafts land inside
// _MOVE_STRIKE_WINDOW_MS of each other. At 30 move packets a second a client
// running at even 1.5x speed reaches that in well under a second; five
// teleports inside three seconds is not something normal play produces (the
// pads are far apart and trigger within 26px).
// (This said "20 move packets a second". It was never 20: netSendMove's
// _MOVE_SEND_MS is 25ms and its own comment records the measurement — "at 25ms
// both 30fps and 60fps devices land on 30Hz". The conclusion is unchanged and
// the margin is bigger than it claimed, but a stale number in a comment about
// timing is exactly the kind that gets reasoned from later.)
const _MOVE_STRIKES = 5;
const _MOVE_STRIKE_WINDOW_MS = 3000;
// off      — no accounting at all.
// log      — accounts and reports, never refuses a move.
// enforce  — also refuses moves once the bucket is empty, and corrects the
//            client back to the last position the server accepted (default).
//
// The default was 'log', for a staged rollout — and staying in the first stage
// is all it ever did. Nothing in this repository sets MOVE_GUARD and neither
// does the droplet's /srv/liberty/env, so every deploy since has shipped a
// guard that measures a teleport, writes one line every thirty seconds and
// then applies the move anyway. Teleporting to anywhere on the current floor
// — onto the guild-war tower, onto the world boss, out of the arena, past a
// corridor gate — and sustained speedhacking both worked in production for the
// whole of that rollout.
//
// Flipping the default is what the rollout was for. 'log' is still one
// environment variable and a restart away, so a bad afternoon does not need a
// deploy to undo. What makes it safe to flip is _MOVE_JITTER_TOLERANCE above:
// the single false positive this design can produce was a maxed-speed Егерь
// being charged a measured distance against an exact speed, and that is now
// paid for explicitly rather than out of the player's bucket.
const _MOVE_GUARD = ['off', 'log', 'enforce'].includes(process.env.MOVE_GUARD)
  ? process.env.MOVE_GUARD : 'enforce';
// Per-player, so one player flooding the log can't hide everyone else.
const _MOVE_LOG_EVERY_MS = 30000;
const { encodeGameState, packGrid } = require('../../shared/netcodec');

// ── CHAR_DEF, looked up by a string that came off the wire ──────────────────
// Object.hasOwn, not `CHAR_DEF[type]`. This is the same class of mistake
// PREF_FIELDS and UPG_COL already spell out (server/db/repos/players.js:513
// and :617): CHAR_DEF is a plain object literal (shared/definitions.js), so it
// inherits from Object.prototype, and 'constructor', '__proto__', 'toString',
// 'valueOf' and 'hasOwnProperty' every one of them return something TRUTHY
// that is not a class definition. `Object.hasOwn(CHAR_DEF, 'constructor')` is
// false; `CHAR_DEF['constructor']` is the Object constructor. JSON.parse
// produces '__proto__' as an own key, so a client can send exactly this.
//
// Where PREF_FIELDS crashed, this went quiet, which is worse. cd.baseHP on a
// function is undefined, so maxHp/atk/def came out NaN — and NaN is
// ABSORBING and never throws. Every damage path is `Math.max(0, hp - dmg)`,
// which stays NaN, and `NaN <= 0` is FALSE, so the player simply never dies.
// Their atk is NaN too, so the first enemy they hit gets `enemy.hp = NaN` and
// becomes permanently unkillable by EVERYONE — one packet takes the world
// boss, or the guild-war tower, out of the game for the entire server.
function _charDef(type) {
  return Object.hasOwn(CHAR_DEF, type) ? CHAR_DEF[type] : null;
}

// ── the last gate before computed stats enter a live player record ──────────
// _charDef above closes the route that produced NaN. This refuses the RESULT,
// because the property that made that bug so expensive is not specific to it:
// a non-finite stat does not throw, does not log, and compares false against
// everything it is ever tested against — including the `hp <= 0` that decides
// whether a player is dead. So it is invisible until somebody reports being
// unable to die, and by then it has spread to every enemy they touched.
//
// One finite check at the point stats are ASSIGNED makes the whole class of
// bug unrepresentable, whatever future route produces it: a retired class left
// in an old save, a nullable column a migration forgot, an arithmetic change
// upstream. Refusing is logged rather than swallowed — a stat write that
// silently does nothing is the same kind of invisible.
const _STAT_KEYS = ['atk', 'def', 'maxHp', 'critChance', 'critPower'];
function _statsFinite(s, who, where) {
  for (const k of _STAT_KEYS) {
    if (!Number.isFinite(s[k])) {
      console.warn(`[stats] ${where}: refusing ${k}=${s[k]} for ${who} — a non-finite stat ` +
        'is absorbing (NaN hp never satisfies hp<=0), so this would make the player ' +
        'immortal and every enemy they hit unkillable');
      return false;
    }
  }
  return true;
}

// Replicates client recompute() formula — single source of truth for server
// stats. Must stay step-for-step identical to recompute() (js/player.js) for
// every PERMANENT stat source: base + upgrades + equipment (including its
// enhancement) + passive skills. Temporary buffs (potions, skill buffs) are
// deliberately left out — those are exactly what the *_BUFF_HEADROOM ceilings
// below leave room for on top of this value.
//
// The per-point upgrade values are the ones UPGRADE_DEF advertises in the
// upgrade UI (js/definitions.js): +1 ATK, +1 DEF, +10 MaxHP, +1% crit chance,
// +3% crit power. This function used to carry its own, much larger numbers
// (×3 ATK, ×2 DEF, ×25 HP, +2.5%/+15% crit) and to ignore both item
// enhancement and passives entirely, so the server's idea of a player never
// matched the character sheet the player was looking at. For atk/def/maxHp
// that only skewed the anti-cheat ceiling, but updatePlayerStats() ASSIGNS
// crit from here rather than capping it, so the wrong crit numbers were the
// ones actually rolled in combat — a crit landed for a different multiplier
// than the sheet showed, and "Кровавая ярость" (+4% crit power per level) did
// nothing at all because passives never reached the server.
// clanAtkBonusPct is the caller's clan's current % atk bonus (shared/
// definitions.js's clanAtkBonusPct(level), already resolved by server/
// index.js since Room.js has no access to clan state) — recompute()
// (js/player.js) applies the identical multiplier, and it was missing here
// entirely until now: setPlayerChar/updatePlayerStats/publicProfile all
// route through this function, so every one of them silently dropped a
// clan's attack bonus, and setPlayerChar in particular re-runs on every
// selectChar — including the one a reconnect (background tab, brief network
// drop) sends automatically — resetting a clan member's combat atk back
// down until their own client happened to recompute() again for an
// unrelated reason. That's what made the same hit against the same monster
// swing between two different numbers depending on whether a reconnect had
// just clobbered it.
function computeStats(sd, cd, type, clanAtkBonusPct) {
  const u = sd.upgrades || {};
  let a = (sd.baseAtk   ?? cd.baseAtk) + (u.atk || 0) * 1;
  let d = (sd.baseDef   ?? cd.baseDef) + (u.def || 0) * 1;
  let h = (sd.baseMaxHp ?? cd.baseHP)  + (u.hp  || 0) * 10;
  let hpPct = 0, extraCrit = 0, extraAS = 0;
  Object.values(sd.equipment || {}).forEach(it => {
    if (!it) return;
    // Enhancement (+N) is part of an item's real stats — see _canonSavedItem
    // (server/index.js), which validates and preserves `enhance` on the way in.
    const eb = enhanceBonus(it, it.enhance || 0);
    a     += (it.atk || 0) + (eb.atk || 0);
    d     += (it.def || 0) + (eb.def || 0);
    h     += (it.hp  || 0) + (eb.hp  || 0);
    hpPct += it.hpPct || 0;
    if (it.critChance) extraCrit += it.critChance;
    if (it.atkSpeed)   extraAS   += it.atkSpeed;
  });
  // Passive skills (shared/definitions.js). passiveBonusTotal clamps every
  // level to PASSIVE_MAX_LEVEL and only reads known passive ids, so a client
  // can't inflate these by sending junk in savedData.passiveLevels.
  const pt = passiveBonusTotal(sd.passiveLevels, type || sd.type);
  hpPct += pt.hpPct;
  h = Math.floor(h * (1 + hpPct));
  a = Math.floor(a * (1 + pt.atkPct));
  d = Math.floor(d * (1 + pt.defPct));
  // Same multiplier recompute() applies via getClanBonus() — after passives,
  // like there.
  if (clanAtkBonusPct > 0) a = Math.floor(a * (1 + clanAtkBonusPct / 100));
  extraAS += (cd.atkSpeed || 0) * pt.atkSpeedPct;
  const lvl = (sd.lvl || 1) - 1;
  return {
    atk: a,
    def: d,
    maxHp: h,
    critChance: Math.min(0.80, 0.05 + lvl * 0.004 + (u.critChance || 0) * 0.01 + extraCrit),
    critPower:  1.5 + lvl * 0.015 + (u.critPower  || 0) * 0.03 + pt.critPowerFlat,
    // Permanent-only — mirrors recompute() (js/player.js) minus its buff/skill
    // timer terms, same as every other field here (see the file header note).
    atkSpeed: (cd.atkSpeed || 0) * (1 + lvl * 0.015) + (u.atkSpeed || 0) * 0.05 + extraAS,
    hpRegen:  lvl * 0.02 + (u.hpRegen || 0) * 0.1 + pt.hpRegenFlat,
  };
}

function _critDmg(base, critChance, critPower) {
  const isCrit = Math.random() < (critChance || 0);
  return { dmg: isCrit ? Math.floor(base * (critPower || 1.5)) : base, isCrit };
}

// How far above the server's own computed "true" stats (from validated
// equipment/upgrades/level, see computeStats) a statsUpdate push is allowed
// to land. Everything permanent — items, upgrades, level, passives, the clan
// ATK perk — is already inside trueBase, so these only have to cover the
// TEMPORARY buffs the server cannot see, and each one is a ceiling a forged
// packet gets to sit at for free. So they are derived per stat from what can
// actually stack in recompute() (js/player.js) rather than shared:
//
//   ATK  ×1.20 buff potion  ×1.20 battleCry/Гнев мертвеца        = 1.44
//   DEF  ×1.80 guard (Танк) ×1.50 faithShield from a party mate  = 2.70
//        (Барьер is ×1.50 too but belongs to another class, so it stacks
//         with faithShield, not with guard — 2.25, under the same bound)
//   HP   ×1.10 buff potion                                        = 1.10
//
// One blanket ×3 / ×1.5 covered all of that, which meant a single console
// `socket.emit('statsUpdate', { atk: 1e6, maxHp: 1e9 })` parked the sender at
// triple ATK and +50% HP permanently, with no buff running and nothing to
// expire — the clamp was doing its job and the job was too generous. The
// margins below are ~5% over the real maxima, enough to absorb the client's
// own Math.floor rounding at each step without leaving room worth forging.
//
// (The earlier bug this replaced was worse still: the cap ratcheted off the
// client's OWN prior value, so repeated calls walked it up to 9999.)
// The three ceilings that used to stand here are gone along with the message
// they bounded. 'statsUpdate' was DELETED rather than validated — the server
// computes every stat itself now (repos/stats.js, and computeStats below), so
// there is no client-sent atk/def/maxHp left to cap. A clamp on an event that
// cannot be sent is not a defence; it is a comment that fails lint.
//
// Written down rather than dropped in silence because the only thing still
// reading those three names was a legacy detector that lifted their VALUES out
// of this file as text — so it went on passing while the protection it
// described did nothing at all. If a client-authored stat ever returns, the
// margins were about 5% over the real buff maxima listed above.
// Passive-regen ceiling used to bound how fast a playerMove-reported HP
// increase is allowed to land (see syncPlayerHp) — real heals (potions,
// faithShield/party heal, respawn) all go through their own dedicated,
// server-applied paths and are never gated by this.
const MAX_HP_REGEN_PER_SEC = 30;
// Как часто комната поправляет собственное HP игрока у него на экране. Клиент
// предсказывает ту же кривую теми же коэффициентами (js/player.js recompute →
// js/game.js), так что это поправка на дрейф, а не источник HP: раз в секунду
// хватает, чтобы расхождение не успевало вырасти до заметного, и это один
// маленький пакет в секунду на игрока — и только пока он ранен.
const HP_SYNC_EVERY_MS = 1000;
// См. Room._attackAllowed.
//
// Сколько ударов может накопиться за паузу. Это ЕДИНСТВЕННОЕ послабление, и
// оно про доставку, а не про скорость: длинная пробежка или свёрнутая на
// секунду вкладка не должны стоить игроку урона, а долгосрочный темп ведро
// держит ровно на скорости атаки.
const ATTACK_BURST_MAX = 3;
// Пока setPlayerStats не отработал, скорость атаки неизвестна — берётся
// медленнейший класс, чтобы окно не оказалось шире реального.
const ATTACK_RATE_FALLBACK = 1.2;
// Server-side minimum gap between two skill CASTS from the same player. The
// real cooldowns are seconds long and enforced by the client; this only has to
// be tight enough that spamming the event isn't worth anything.
const SKILL_CD_MS = 400;
// An AOE skill (_skillAOEMult/_skillDirMult, js/player.js) fires one
// skillAttack/pvpSkillAttack event per enemy caught in its radius, all in the
// same client-side pass — they land here within a few ms of each other, not
// spread out. Hits arriving within this window of the current cast's first
// hit are treated as the same cast and don't gate each other; a hit outside
// the window starts a new cast and is judged against SKILL_CD_MS as before.
// Without this, only the first enemy an AOE press touched ever took damage —
// every other hit from the same cast landed inside the old floor and was
// silently dropped.
const SKILL_BURST_MS = 150;
// Upper bound on how many enemies one crowd-control packet may name (see
// applySkillEffectMany).
const MAX_CC_TARGETS = 64;
// How many enemies ONE primary swing's "Безумие" splash may reach (see
// attackEnemy). The skill fires one splash packet per enemy standing within
// 90px of the enemy the swing itself hit (the melee branch of js/player.js),
// so the honest ceiling is "how many monster bodies fit inside a 90px circle"
// — a handful, even in Элитная фарм-зона where they spawn in packs of four.
// 16 is far above anything the radius can actually hold and still bounds what
// a single swing is worth. It is a bound on DISTINCT enemies: attackEnemy also
// refuses a second splash on an enemy this swing already splashed, so 16 can
// never become 16 half-hits stacked on one monster.
const MAX_SPLASH_PER_SWING = 16;
// How far a crowd-control effect may reach. A little more generous than the
// 350 a basic hit gets, because several skills are area effects centred away
// from the caster — but bounded, which it was not at all.
const CC_REACH = 460;

const TICK_MS   = 25;              // 40 ticks/sec — halves avg broadcast wait vs 50ms
const LEASH_R2  = 420 * 420;      // max distance from spawn before leash triggers
// Players render on a ~700px-wide viewport — 600px AOI covers everything visible
// with margin, at 2.25× less area than the 900px enemy AOI.
const PLAYER_AOI_R2 = 600 * 600;
// Party rewards (shared XP/gold, the healer's party heal) only reach members
// who are actually there for the fight. Set a little wider than PLAYER_AOI_R2
// so someone right at the edge of the screen — visible, but whose exact
// position the client and server may disagree on by a few frames of movement
// — still counts, instead of flickering in and out of the share.
// Equipped pet id out of a save blob, or null. Pets live in the normal
// equipment map (slot 'pet'), so this is just a guarded lookup.
function _petIdOf(sd) {
  return (sd && sd.equipment && sd.equipment.pet && sd.equipment.pet.id) || null;
}

const PARTY_SHARE_R = 700;
const PARTY_SHARE_R2 = PARTY_SHARE_R * PARTY_SHARE_R;
// At most this many other players per packet. Bounds the N² blowup when
// hundreds of players stack in one spot.
//
// Raised from 20: a 600px AOI in a busy hub holds far more than 20, and the
// ones past the cap were not merely "not drawn" — they dropped out of the
// stream entirely, and the nearest-20 set churned as people milled about, so
// a player near the boundary flickered in and out. Every time they came back
// their snapshot buffer was stale, which the client can only render as a jump.
// That is a stutter no amount of client-side smoothing can fix, because the
// data genuinely is not being sent.
//
// The cost is real, and it was measured rather than estimated — dev/roombench
// with 200 players stacked in the hub, which is the worst case this bound
// exists for at all:
//
//     cap    tick p50   tick p99   per player
//      20      2.5ms      4.4ms      8 KB/s
//      40      4.2ms      7.1ms     15 KB/s
//      60      5.5ms      8.4ms     22 KB/s
//     100      8.2ms     11.1ms     37 KB/s
//
// CPU is the lesser half: 11ms p99 still fits the 25ms tick budget, though the
// headroom drops from ~5.6x to ~2.2x. Bandwidth is the half to watch — 37 KB/s
// of player positions on a phone is both a data-plan cost and, on a weak link,
// a cause of the very jitter the client-side work here is fixing.
//
// It is an UPPER bound, not a typical case: the AOI test runs first, so
// ordinary play (a handful of people in a corridor) is completely unaffected
// and pays none of this. Only a genuine crowd in one spot reaches it. If the
// hub does turn out to sustain crowds this size, 40-60 is where the curve is
// still cheap — the numbers above are the whole basis for that call.
const PLAYER_CAP = 100;
// Every N casts a PLAYER entry goes out full even if the recipient "knows"
// it — self-heals any client/server known-state divergence within ~2s.
// Players are AOI-limited and capped at PLAYER_CAP, so this stays cheap.
const FULL_REFRESH_TICKS = 80;
// Cap on one resync request, so a malformed or hostile client can't ask the
// server to encode the whole world on demand.
const ENEMY_RESYNC_MAX = 40;

// Radius for purely visual combat fan-out (projectiles, AOE rings, the CC
// flash on a monster) — see nearbyPlayerIds and its callers in server/index.js.
// Wider than PLAYER_AOI_R2 because a projectile outlives the frame it was
// fired in: the fastest one travels ~400px/s for 1.8s, so a shot aimed away
// from the shooter can end up well past the radius the shooter themselves is
// streamed within. Everything beyond this is unreachable on screen anyway —
// the client is never told the shooter exists, so a projectile arriving from
// there would be a bolt out of empty space.
const VISUAL_FANOUT_R = 1000;
const VISUAL_FANOUT_R2 = VISUAL_FANOUT_R * VISUAL_FANOUT_R;
// Upper bound on recipients of one visual, for the case the radius can't
// bound on its own: a hundred players standing on the same hub tile are all
// legitimately "in range" of each other. See nearbyPlayerIds.
const VISUAL_FANOUT_CAP = 24;

// Ceiling on one player's pending combat visuals between two casts. Only
// reachable when their casts are being dropped for backpressure while a fight
// rages next to them — in which case the oldest few are the ones worth having.
const VISUAL_QUEUE_MAX = 48;

// A player receiving nothing at all still gets one packet this often, purely
// so their clock offset (js/network.js's netClockNow estimate) keeps tracking
// the server. At 20 casts/s this is once a second.
const IDLE_HEARTBEAT_CASTS = 20;

// ── Страх (Fear) tuning ──────────────────────────────────────────────────────
// FEAR_MAX_WAVE (the last wave's level) is shared with server/index.js for the
// UI's wave counter (shared/definitions.js); these two are only ever read
// inside fearSpawnWave below, so they stay local.
const FEAR_WAVE_MOBS = 20;  // monsters per wave
const FEAR_XP_MULT   = 10;  // XP multiplier for every Fear-event kill
// How long a disconnected entrant's hall is held open before it's actually
// released — see _fearGraceStart/_fearGraceClaim below and the matching
// FEAR_RECONNECT_GRACE_MS in server/index.js (kept in sync by comment, not by
// import, since Room.js has no reason to depend on that file).
//
// This used to say "comfortably past js/network.js's own ~2s reconnect
// watchdog" at 15000ms — that watchdog (_PONG_SILENCE_MS) is 8000ms now, and
// a real reconnect still has to re-handshake the transport and round-trip
// loginTelegramWebApp through the DB on top of that wait, on the same flaky
// link that dropped in the first place. 15s left as little as ~7s for all of
// that, so ordinary reconnects — not just the same-tick socket-id swap —
// missed the window more often than not: the hall released for real, its
// monsters purged, and the returning player's next enemy snapshot came back
// empty. Raised well past the watchdog's own 8s floor; a genuinely abandoned
// hall still frees itself, just a bit later.
const FEAR_RECONNECT_GRACE_MS = 45000;
// A wave spawns in a ring this far from the entry point (px) — see
// fearSpawnWave. Kept well inside _closestTargetFor's own search radius
// (max(aggroR*2.2, 300), aggroR tops out at 230 so that's ~506px) so every
// monster in the wave is guaranteed to find the player on its first AI tick,
// and inside the FEAR_ROOM=12 room's own walls (dungeon.js) with a tile of
// margin to spare (half-width 240px, minus the 1-tile border ≈ 200px).
//
// The floor (140) matters as much as the ceiling: the tick loop only ever
// moves an aggro'd enemy while closestD > e.size + 14 (~30-46px depending on
// species/level) — spawning any closer than that leaves it already standing
// in melee range on frame one, with nothing to visibly walk across, which is
// exactly what read as "they're just standing there" once the room shrank.
// Starting the whole ring past that threshold means every monster in the
// wave visibly closes real distance before the first swing lands.
const FEAR_SPAWN_RING_MIN = 140;
const FEAR_SPAWN_RING_MAX = 190;
// Aggro radius for a Fear wave — see the comment at the spawn site. Sized so
// aggroR * 2.2 (the de-aggro/leash and target-search threshold) clears the
// room's own diagonal (12 tiles ≈ 679px) with room to spare.
const FEAR_AGGRO_R = 500;
// Species/stat lookup by eid, built once — same table server/game/dungeon.js
// builds locally for the open world's own spawns (`_enemyByEid` there), needed
// here too since Fear's waves are spawned at runtime instead of at world-gen.
const _FEAR_ENEMY_BY_EID = new Map(ENEMY_DEF.map(e => [e.eid, e]));

// ── Сотрудничество (Coop) tuning ────────────────────────────────────────────
// COOP_STAGE_LEVELS/COOP_BOSS_LEVEL live in shared/definitions.js — the
// client needs the level list too (for its own stage preview), same reason
// FARM_SPECIES etc. live there rather than here. COOP_STAGE_LEVELS.length is
// the number of stages (8) — read wherever the stage count matters instead
// of a separate constant, so the two can never drift apart. Monsters use
// the SAME standard aggro rule the open world and Кровавая Башня's own
// corridors do (aggro:false, normal aggroR) rather than Fear's pre-aggroed
// wide-leash wave — "не стоят в ряд ... монстры в разброс" only asked for a
// spatial change (scattered across a wider room instead of packed single-
// file), not a behavioural one.
const COOP_MOBS_PER_STAGE = 40;

// Enemy interest management. ENEMY_AOI_R (shared/definitions.js — the client
// prunes against the same number) is the radius each player is streamed
// enemies within; the grid cell is sized to match it so the per-player query
// only ever touches a 2x2..3x3 block of cells.
const ENEMY_AOI_R2 = ENEMY_AOI_R * ENEMY_AOI_R;
const ENEMY_GRID_CELL = ENEMY_AOI_R;
// Players get the same treatment as enemies, and for two callers: the AOI
// candidate scan (which was a nested players.forEach, O(N²) per cast) and the
// enemy AI's closest-target search (which scanned every player, per enemy).
// Bucketing into PLAYER_AOI_R-sized cells means each query only looks at the
// block of cells that can possibly contain someone in range.
//
// Sized to PLAYER_AOI_R so the broadcast query walks exactly 3x3 cells. The AI
// search uses a per-enemy radius and walks however many cells that covers.
const PLAYER_GRID_CELL = 600;
// Shared by both spatial grids. Cell keys are Math.floor(coord / cell) which
// can go negative near the world origin, so the multiplier has to be big
// enough that no two distinct (cx, cy) pairs collide — the world is ~1000
// tiles across, so ±50000 of headroom on each axis is ample.
const GRID_KEY_STRIDE = 100000;
function _gridKey(cx, cy) { return cx * GRID_KEY_STRIDE + cy; }
// How long (in casts, which run every other tick — so ~150ms) an enemy may be
// out of a player's range before the server forgets having told them about
// it. Small on purpose: see the ordering requirement in _collectEnemiesFor.
const EKNOWN_FORGET_CASTS = 6;
// Map-panel dot refresh, in ticks (40/s) — 1Hz. Only sent to players with the
// panel open; see _broadcastMapBlips.
const MAP_BLIP_EVERY = 40;
// Every N casts an enemy is re-sent in full even if this player's copy looks
// current, staggered per enemy so it costs a handful of entries per cast
// rather than a world-wide sweep. Purely a self-heal: it puts an authoritative
// position, hp and aggro flag back in front of a client whose own copy has
// drifted for any reason. Dropping it (when enemies moved to per-player
// streaming) is what let a client-invented aggro survive indefinitely instead
// of correcting itself within a minute.
const ENEMY_REFRESH_CASTS = 1200; // 20 casts/s -> once a minute
// ── how long a lost packet may go unnoticed ────────────────────────────────
// _eKnown is written at ENCODE time (see _pushEnemyEntry) and the cast goes
// out with volatile.emit, which drops rather than queues when a socket is
// backed up. So the server can believe a player has state they never received
// — and then the suppression test below, which is otherwise exactly right,
// keeps quiet about it.
//
// Everything that changes continuously repairs itself: the next position
// delta carries it. What does not is a ONE-SHOT transition — an enemy losing
// aggro, teleporting back to its spawn on the leash, respawning. Each of
// those produces exactly one packet, and if that packet is the one that got
// dropped, the client keeps a ghost standing where the fight was, with aggro
// stuck on, unhittable (the server measures range from the real position) —
// until ENEMY_REFRESH_CASTS came round. Sixty seconds.
//
// So an enemy nobody has SENT anything about for this long gets a slim delta
// regardless of whether anything changed. In raw castId units, which advance
// two per cast. ~2s, staggered by handle so they do not all land together.
// Costs about half an entry per cast: a slim delta is eight bytes.
const ENEMY_RESTATE_TICKS = 80;

// The complete record for one enemy — every field the client needs to render
// and fight it. Shared by the tick's periodic refresh and the on-demand
// resync so the two can never describe an enemy differently.
function _fullEnemyEntry(e) {
  return {
    id: e.id, idx: e._idx, eid: e.eid, x: e.x, y: e.y, hp: e.hp, maxHp: e.maxHp,
    name: e.name, color: e.color, size: e.size, isBoss: e.isBoss, aggro: e.aggro,
    aggroR: e.aggroR, spd: e.spd, rlvl: e.rlvl || 0,
    atkAnimTimer: e._atkPulse ? e.atkAnimTimer : 0,
  };
}
// Each enemy only re-runs its full closest-eligible-player scan (O(players))
// once every this many ticks (staggered by enemy index, see _tick()) instead
// of every tick — O(enemies × players) exceeded the 25ms tick budget at
// ~200 concurrent players once enemy count doubled (ROOM_CHAIN_LEN 3->6).
// Movement/attack still use a freshly recomputed distance to the (possibly
// cached) target every tick, so this only throttles how often "who's
// closest" is re-decided — at 4 ticks (~10Hz) that's a ≤75ms-stale target
// choice, imperceptible in play.
const AI_TARGET_SEARCH_EVERY = 4;

// Per-arm boss respawn: random 1-2h, not a flat 3600s — otherwise every
// boss on the map ticks back in at exactly the same offset from whatever
// moment killed/reset them, which reads as suspiciously mechanical over a
// full day of restarts/kills.
const BOSS_RESPAWN_MIN_S = 60 * 60;
const BOSS_RESPAWN_MAX_S = 2 * 60 * 60;
function _bossRespawnSecs() {
  return BOSS_RESPAWN_MIN_S + Math.random() * (BOSS_RESPAWN_MAX_S - BOSS_RESPAWN_MIN_S);
}

class Room {
  // bossState: { [arm]: respawnAtMs } — this floor's persisted per-arm boss
  // deadlines (server/index.js loads BossState from Mongo before creating
  // any Room). onBossDeath(arm, respawnAtMs) is called every time a per-arm
  // boss actually dies, so index.js can persist the new deadline the same
  // way — see attackEnemy/skillAttackEnemy below, the only two places a
  // per-arm boss's hp reaches 0.
  constructor(floor, io, bossState = {}, onBossDeath = null) {
    this.floor = floor;
    this.io = io;
    this._onBossDeath = onBossDeath;
    this.players = new Map();
    const entry = floorEntry(floor);
    if (!entry) throw new Error(`No floor registry entry for floor ${floor}`);
    this._dungeon = entry.generate();
    this._gridPacked = packGrid(this._dungeon.grid, this._dungeon.w, this._dungeon.h);
    // Which arms currently have >=1 player, recomputed once per tick (see
    // _tick's players.forEach) — lets the enemy AI and grid-rebuild loops
    // skip regular arm enemies nobody is there to see, same idea as the
    // existing race10-idle skip below. armBounds no longer exists on any
    // floor's dungeon now that each arm is its own floor/Room — see the
    // guarded callers below — kept only so this doesn't need ripping out yet.
    this._armBounds = this._dungeon.armBounds;
    this._armPresent = new Set();
    // The single arm this floor's regular enemies belong to (or null, e.g.
    // on the hub floor) — see _broadcastMapBlips, which used to derive this
    // per-player from a Y-band lookup across all 4 arms sharing one grid.
    this._soleArm = ARM_NAMES.find(a => this._dungeon.enemies.some(e => e.arm === a))
      || (this._dungeon.enemies.find(e => e.arm && !e.isBoss) || {}).arm
      || null;
    const _now = Date.now();
    this.enemies = this._dungeon.enemies.map(e => {
      if (!e.isBoss) {
        return { ...e, hp: e.maxHp, aggro: false, atkTimer: 1 + Math.random(),
          hurtTimer: 0, atkAnimTimer: 0, _sx: e.x, _sy: e.y, _shp: e.maxHp };
      }
      const savedAt = bossState[e.arm];
      // Three cases for a per-arm boss at startup:
      //  - a persisted deadline still in the future: stay dead, and resume
      //    the real remaining cooldown rather than losing it to the restart.
      //  - a deadline already in the past: the cooldown ran out while the
      //    server was down, so it's alive again now.
      //  - no record at all: this boss has never been killed, so it's alive.
      //    (Before deadlines were persisted, this case had to assume the
      //    worst and start every boss dead on a fresh timer, or a restart
      //    would respawn one that had just been killed. Now that a kill
      //    always leaves a record, a missing one is unambiguous — and
      //    assuming death here was killing bosses nobody had touched, every
      //    restart, for up to two hours at a time.)
      const dead = savedAt != null && savedAt > _now;
      const hp = dead ? 0 : e.maxHp;
      const respawnTimer = dead ? (savedAt - _now) / 1000 : undefined;
      return {
        ...e, hp, aggro: false, atkTimer: 1 + Math.random(), hurtTimer: 0, atkAnimTimer: 0,
        _sx: e.x, _sy: e.y, _shp: hp,
        ...(respawnTimer !== undefined ? { respawnTimer } : {}),
      };
    });
    // O(1) enemy lookup for attack handler
    this._enemyMap = new Map(this.enemies.map(e => [e.id, e]));
    // Reusable buffers — avoids array allocation every tick
    this._nearPlayersBuf = [];
    this._nearEnemiesBuf = [];
    this._candBuf = [];
    // Spatial index over alive non-boss enemies, rebuilt every tick, so the
    // per-player interest query in _collectEnemiesFor doesn't have to walk
    // the whole enemy list. Bosses sit in _bossBuf instead — they're sent to
    // everyone regardless of distance.
    this._enemyGrid = new Map();
    this._bossBuf = [];
    // Same idea for players — see PLAYER_GRID_CELL. Rebuilt every tick (the
    // AI reads it too), not just on the casts that broadcast.
    this._playerGrid = new Map();
    // Pool of reusable {op, d2} slots for the capped nearest-N selection, so a
    // busy hub doesn't allocate PLAYER_CAP objects per player per cast (at 200
    // players that was ~80k short-lived objects a second, all of it GC work).
    this._candPool = [];
    // Reusable buffer for "who can currently see this enemy" fan-outs
    // (enemyHurt/enemyKilled) — see viewersOfEnemy.
    this._viewerBuf = [];
    // Second buffer plus a rotating offset, for the capped visual fan-out —
    // see nearbyPlayerIds.
    this._fanoutWin = [];
    this._fanoutRot = 0;
    this._tickNo = 0;
    this._pSeq = 0;
    // Tick timing, exposed via stats() and the /health endpoint. A tick that
    // regularly overruns TICK_MS is the direct cause of the whole room feeling
    // sluggish, and until now nothing recorded it.
    this._tickMsMax = 0;
    this._tickMsSum = 0;
    this._tickSamples = 0;
    this._tickOverruns = 0;
    this.enemies.forEach((e, i) => { e._idx = i; });
    // ── Enemy network handles (_idx) ────────────────────────────────────────
    // _idx is NOT an array position — it is the u16 handle the wire protocol
    // identifies an enemy by (shared/netcodec.js), and every client keeps a
    // persistent idx -> id map that slim delta entries are resolved through.
    // So an _idx must stay pinned to one enemy for as long as that enemy
    // exists, and may only be reused once it's gone (the first packet naming
    // a reused handle is always a FULL entry, which repairs the map).
    //
    // Renumbering the array after a removal — which is what every despawn
    // path here used to do — silently repointed EVERY client's map at the
    // wrong enemy, world-wide: positions landed on the wrong monster and the
    // real one stopped updating, i.e. monsters that "vanish" or "stand
    // frozen" for players nowhere near whatever was actually removed.
    // Handing new spawns `this.enemies.length` had the same effect from the
    // other end, colliding with a live enemy's handle after any removal.
    this._idxNext = this.enemies.length;
    this._idxFree = [];
    this._lastTick = Date.now();
    this._interval = null;
    // Counts _tick() calls, purely to stagger the closest-target re-search
    // below (a separate counter from _tickNo, which is actually a cast-id
    // sequence, not a tick counter, despite the name).
    this._aiTickNo = 0;
    // Still used by resendEnemies (below), which builds one throwaway list
    // for a single recipient and wants encodeGameState's byte cache bypassed.
    this._nearEnemiesGen = 0;
    // ── World drops (event-boss loot lying on the floor) ───────────────────
    // id -> { id, x, y, item, expiresAt }. Not per-player: one shared pool
    // everyone can see, claimed atomically by claimWorldDrop() so exactly one
    // player can ever take a given pile ("кто успел, тот забрал").
    this.worldDrops = new Map();
    this._dropSeq = 0;
    this._eventBossId = null;
    // ── Страх (Fear) lane bookkeeping ───────────────────────────────────────
    // lane index -> socketId currently occupying it (fearDeploy/
    // fearReleaseLane), and lane index -> monsters still alive in that lane's
    // CURRENT wave (fearSpawnWave/fearRegisterKill) — server/index.js reads
    // the latter indirectly via fearRegisterKill's return value to decide
    // whether to advance to the next wave.
    this._fearOwner = new Map();
    this._fearAlive = new Map();
    // lane index -> { telegramId, timer, x, y, hp } for a hall whose owner
    // just disconnected — see _fearGraceStart/_fearGraceClaim.
    this._fearGrace = new Map();
    // ── Сотрудничество (Coop) lane bookkeeping ──────────────────────────────
    // Same shape as Fear's just above, but for exactly 2 lanes sharing one
    // room: lane -> socketId (coopDeploy/coopReleaseLane), lane -> monsters
    // still alive in that lane's CURRENT stage (coopSpawnStage/
    // coopRegisterKill), and lane -> whether that lane has already cleared
    // the current stage and is waiting on its partner — coopRegisterKill
    // only advances BOTH lanes once every lane's flag is true.
    this._coopOwner = new Map();
    this._coopAlive = new Map();
    this._coopClearedLane = new Map();
    // 0 = not started yet; 1..COOP_STAGE_LEVELS.length while a stage is
    // live; past the end once the boss is up. Room-level (not per-lane) —
    // by construction both lanes are always on the same stage.
    this._coopStage = 0;
  }

  // ── Event boss ────────────────────────────────────────────────────────────
  // Spawns EVENT_BOSS at the centre of the dedicated arena (server/game/
  // dungeon.js), a sealed square room reachable only via the event teleport
  // pad that appears in the hub while the event is running. Keeping it out of
  // the hub means the safe zone stays genuinely safe for anyone who doesn't
  // opt in by stepping on the pad.
  spawnEventBoss() {
    if (this.isEventBossAlive()) return null;
    const ar = this._dungeon.arena;
    const x = ar.cx, y = ar.cy;
    const e = {
      id: `evtboss_${Date.now()}`,
      ...EVENT_BOSS,
      arm: 'hub',
      rlvl: 0,
      maxHp: EVENT_BOSS.hp,
      hp: EVENT_BOSS.hp,
      x, y, spawnX: x, spawnY: y,
      atkTimer: 1, hurtTimer: 0, atkAnimTimer: 0,
      aggro: false,
      // Wide enough to cover the arena — the default 175 would leave a boss
      // this size idle unless someone walked right into it.
      aggroR: 900,
      _sx: x, _sy: y, _shp: EVENT_BOSS.hp,
      _idx: this._allocIdx(),
    };
    this.enemies.push(e);
    this._enemyMap.set(e.id, e);
    this._eventBossId = e.id;
    return e;
  }

  isEventBossAlive() {
    const e = this._eventBossId ? this._enemyMap.get(this._eventBossId) : null;
    return !!(e && e.hp > 0);
  }

  // ── Страх (Fear) ─────────────────────────────────────────────────────────
  // A private wave-survival instance, one lane per concurrent entrant
  // (server/game/dungeon.js's `fear.lanes`, sealed rooms with no baked-in
  // monsters). Isolation from the rest of the world — and between lanes —
  // reuses the exact same machinery race10 lanes rely on (_raceVisible,
  // nearbyPlayerIds, mapBlips), keyed off p._fearLane instead of p._raceLane;
  // see those for the actual filtering.

  // Reclaims halls whose owner is no longer actually in one — a socket that
  // went away without any exit path running, or a record left behind by a
  // reconnect. Every individual leak this covers is separately fixed at its
  // source (removePlayer, _fearFinish), but a hall stuck occupied is
  // invisible to players and permanently costs everyone a slot, so the claim
  // path re-derives the truth from live state rather than trusting the
  // bookkeeping it has been keeping.
  //
  // A lane on hold in _fearGrace is deliberately left alone here: its player
  // record is gone (removePlayer already ran), which is exactly the "owner
  // is gone" case above, but the whole point of the grace window is that
  // "gone" isn't final yet. Reconciling it away the moment anyone else calls
  // fearDeploy/fearFreeLaneCount (i.e. within milliseconds, every time
  // someone else opens the panel) would silently undo the hold.
  _fearReconcile() {
    if (!this._fearOwner.size) return;
    for (const [lane, sid] of [...this._fearOwner]) {
      if (this._fearGrace.has(lane)) continue;
      const owner = this.players.get(sid);
      if (owner && owner._fearLane === lane) continue;
      // The owner is gone, or has already been moved out of this hall by
      // some other path — either way nobody is running it any more.
      if (owner) owner._fearLane = null;
      this.fearReleaseLane(lane);
    }
  }

  // Holds a disconnecting entrant's hall open instead of releasing it on the
  // spot — called from removePlayer whenever the departing player still owns
  // a lane. The monsters and _fearOwner/_fearAlive bookkeeping are left
  // exactly as they were (nothing here touches this.enemies), so a reconnect
  // within the window comes back to the exact wave it left. Runs the real
  // release once the window elapses with no reconnect. No telegramId (should
  // be unreachable for a real login) means there's no account to reconnect
  // against, so release immediately rather than hold a lane nobody can ever
  // reclaim.
  _fearGraceStart(p) {
    const lane = p._fearLane;
    if (lane == null) return;
    if (!p.telegramId) { this.fearReleaseLane(lane); return; }
    // Guarded for the same reason server/index.js's safeTimeout exists: a
    // timer callback runs on an empty stack, so a throw here reaches process
    // scope, where uncaughtException exits the process and drops every player
    // online. The tick loop below has had this protection all along; this one
    // is the only other timer Room owns.
    const timer = setTimeout(() => {
      try {
        this._fearGrace.delete(lane);
        this.fearReleaseLane(lane);
      } catch (err) {
        console.error(`[Room ${this.floor} fearGrace]`, err);
      }
    }, FEAR_RECONNECT_GRACE_MS);
    this._fearGrace.set(lane, { telegramId: p.telegramId, timer, x: p.x, y: p.y, hp: p.hp });
  }

  // Reclaims a held hall for a reconnecting account — called from addPlayer.
  // Covers both a same-tick race (the stale entry's removePlayer just started
  // the grace a moment earlier in this exact call) and a genuine disconnect-
  // then-reconnect within FEAR_RECONNECT_GRACE_MS. Returns the spot to resume
  // at, or null if this account has no lane on hold.
  _fearGraceClaim(telegramId, newSocketId) {
    for (const [lane, g] of this._fearGrace) {
      if (g.telegramId !== telegramId) continue;
      clearTimeout(g.timer);
      this._fearGrace.delete(lane);
      this._fearOwner.set(lane, newSocketId);
      return { lane, x: g.x, y: g.y, hp: g.hp };
    }
    return null;
  }

  // How many halls are free right now, for the caller's own capacity check /
  // player-facing message. Reconciles first so it never reports a leak as
  // genuine occupancy.
  fearFreeLaneCount() {
    this._fearReconcile();
    const occupied = new Set(this._fearOwner.keys());
    this.players.forEach(op => { if (op._fearLane != null) occupied.add(op._fearLane); });
    return this._dungeon.fear.lanes.length - occupied.size;
  }

  fearLaneCount() { return this._dungeon.fear.lanes.length; }

  // Claims the first unoccupied lane and places the player at its entry
  // point, full HP, in one step — the single-entrant sibling of raceDeploy.
  // Deliberately not split into a separate "find a free lane" + "deploy into
  // it" pair: with no reservation in between, two calls racing between those
  // steps could both pick the same lane. Returns null if every lane is
  // currently in use. Wave 1 is spawned separately (fearSpawnWave) right
  // after this, by the caller.
  fearDeploy(socketId) {
    const p = this.players.get(socketId);
    if (!p) return null;
    const lanes = this._dungeon.fear.lanes;
    this._fearReconcile();
    // Occupancy is asserted from TWO independent sources, not just the
    // ownership table: a hall counts as taken if _fearOwner claims it OR if
    // any live player is physically standing in it. Either one going stale on
    // its own is what would put a second player inside somebody else's run,
    // and that is the one failure this must never allow.
    const occupied = new Set(this._fearOwner.keys());
    this.players.forEach(op => { if (op._fearLane != null) occupied.add(op._fearLane); });
    let lane = -1;
    for (let i = 0; i < lanes.length; i++) if (!occupied.has(i)) { lane = i; break; }
    if (lane === -1) return null;
    const spot = lanes[lane];
    p.x = spot.entryX; p.y = spot.entryY;
    p.hp = p.maxHp;
    p._fearLane = lane;
    p._raceLane = null;
    p._profileRev++;
    this._fearOwner.set(lane, socketId);
    return { x: p.x, y: p.y, lane };
  }

  // Spawns FEAR_WAVE_MOBS monsters at global level `lvl`, scattered inside
  // lane `lane`'s room — same random-floor-tile placement buildArm's
  // spawnRoomEnemies uses (server/game/dungeon.js), just done at runtime
  // since a private instance's monsters can't be pre-baked into the shared
  // world map the way race10's corridors are. Reuses the same global-level
  // species/name/color/stat functions the open world's own rooms use, so a
  // Fear wave at level 12 looks and hits exactly like an open-world level-12
  // room would.
  fearSpawnWave(lane, lvl) {
    // Clear out the wave that just fell before laying down the next one.
    // Fear monsters are exempt from the tick loop's 12s respawn (they must
    // stay dead for fearRegisterKill's count to ever reach zero), so without
    // this every corpse of the run stayed in this.enemies until the lane was
    // released — 780 dead objects per full 39-wave run, times however many
    // halls are busy, walked by the AI loop and the enemy-grid rebuild forty
    // times a second on top of the ~7000 the world already has. That is a
    // cost paid by every player on the server, not just the one in here.
    // Their handles go back to the pool at the same time.
    this._fearPurgeDead(lane);
    const room = this._dungeon.fear.lanes[lane];
    if (!room) return;
    const armIdx = armIndexForLevel(lvl);
    const fe = FLOOR_ENEMIES[armIdx];
    const localLvl = lvl - ARM_OFFSETS[armIdx - 1];
    const maxLocalLvl = roomsInArm(armIdx) - 1;
    let spawned = 0;
    for (let n = 0; n < FEAR_WAVE_MOBS; n++) {
      const pool = bandForLocalLevel(fe, localLvl).pool;
      const d = _FEAR_ENEMY_BY_EID.get(pool[Math.floor(Math.random() * pool.length)]);
      if (!d) continue;
      // In a ring around the entry point (not scattered across the whole
      // room the way buildArm's open-world spawnRoomEnemies does) — a wave
      // is supposed to swarm the player the instant it appears, not sit in a
      // far corner waiting to be walked into. FEAR_SPAWN_RING_MAX is well
      // inside _closestTargetFor's own search radius (aggroR*2.2, ~500px),
      // so every monster in the wave is guaranteed to actually find the
      // player on its very first AI tick.
      let ex = room.entryX, ey = room.entryY;
      for (let attempt = 0; attempt < 40; attempt++) {
        const ang = Math.random() * Math.PI * 2;
        const ring = FEAR_SPAWN_RING_MIN + Math.random() * (FEAR_SPAWN_RING_MAX - FEAR_SPAWN_RING_MIN);
        const tx = room.entryX + Math.cos(ang) * ring, ty = room.entryY + Math.sin(ang) * ring;
        if (!this._isWall(tx, ty)) { ex = tx; ey = ty; break; }
      }
      const stats = monsterStatsAtLevel(lvl, d.eType);
      // Same halving buildArm's spawnRoomEnemies applies to every regular
      // room's monster pack — a fresh-level-1 player facing 20 full-strength
      // level-1 monsters at once is a much rougher fight than the same
      // player would ever meet in a 5-10-monster open-world room.
      const weakMult = 0.5;
      const e = {
        id: `fear_${lane}_${this._fearSeq = (this._fearSeq || 0) + 1}`,
        ...d, isBoss: false, arm: 'fear', lane, rlvl: lvl,
        name: monsterNameAtLevel(d.name, localLvl, false, d.fem, maxLocalLvl),
        color: monsterColorAtLevel(d.color, d.endColor, localLvl, false, maxLocalLvl),
        maxHp: Math.floor(stats.hp * weakMult), hp: Math.floor(stats.hp * weakMult),
        atk: Math.floor(stats.atk * weakMult), def: stats.def, spd: d.spd,
        xp: xpAtLevel(lvl) * FEAR_XP_MULT, gold: goldAtLevel(lvl),
        x: ex, y: ey, spawnX: ex, spawnY: ey,
        // Pre-aggroed straight out of the spawn (unlike every other monster
        // in the game, which only wakes up once a player crosses its aggroR)
        // — waves are meant to charge in immediately, not wait to be pulled.
        //
        // aggroR is deliberately far wider than the open world's 175-230, and
        // it is what keeps the wave working AS a wave. Two separate rules key
        // off aggroR * 2.2: the AI de-aggros and teleports an enemy back to
        // its spawn past that distance, and _closestTargetFor won't even look
        // for a target beyond it. At the open-world value that threshold
        // (385-506px) is SHORTER than this room's own diagonal (~679px), so a
        // player simply walking to the far corner made every monster spawned
        // on the opposite side snap home and stand there — the leash exists to
        // stop players dragging monsters across a corridor, and there is
        // nowhere to drag anything in a sealed 12-tile room. FEAR_AGGRO_R puts
        // that threshold (1100px) well outside the room, so the whole wave
        // stays on the player wherever they go. The client runs the identical
        // rule off this same field (js/game.js), so both sides agree.
        atkTimer: 1 + Math.random(), aggro: true, aggroR: FEAR_AGGRO_R,
        // Every other runtime spawn (spawnEventBoss, spawnRaceBoss) sets
        // this at push time — without it, every
        // monster in the wave shared the same `undefined` _idx, which drives
        // BOTH the AI target-recheck stagger (_closestTargetFor's caller) AND
        // the network stream's per-enemy refresh cadence (_pushEnemyEntry).
        // With all 20 sharing one value they moved in synchronized lockstep
        // instead of independently — this is what read as "frozen, then all
        // jump together."
        _idx: this._allocIdx(),
      };
      this.enemies.push(e);
      this._enemyMap.set(e.id, e);
      spawned++;
    }
    this._fearAlive.set(lane, spawned);
  }

  // Who currently owns this hall, or null. Lets server/index.js confirm that
  // a run record still refers to the hall it thinks it does before acting on
  // it — several unrelated handlers (race10Return, arena3Return, the death
  // battle's own return) call deathBattleReturn unconditionally, and that
  // releases a Fear hall as a side effect. Without this check a run record
  // left behind by one of those could purge, or count kills against, whatever
  // player had since been given that hall.
  fearOwnerOf(lane) {
    return this._fearOwner.get(lane) ?? null;
  }

  // The hall a player is currently inside, or null.
  fearLaneOf(socketId) {
    const p = this.players.get(socketId);
    return p ? (p._fearLane ?? null) : null;
  }

  // Drops the corpses of a lane's finished wave. Split out from
  // fearReleaseLane because that one also hands the hall back; this is the
  // between-waves sweep. The client has already removed these itself off
  // their enemyKilled events, so nothing needs to be told about it.
  _fearPurgeDead(lane) {
    let found = false;
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (e.arm === 'fear' && e.lane === lane && e.hp <= 0) { found = true; break; }
    }
    if (!found) return;
    this.enemies = this.enemies.filter(e => {
      if (e.arm !== 'fear' || e.lane !== lane || e.hp > 0) return true;
      this._enemyMap.delete(e.id);
      this._forgetEnemy(e.id);
      this._releaseIdx(e);
      return false;
    });
  }

  // Called by server/index.js right after a kill lands on a `fear`-tagged
  // enemy. Returns the lane's remaining alive count (0 means the wave is
  // clear and the caller should spawn the next one, or finish the run if the
  // wave that just fell was FEAR_MAX_WAVE).
  fearRegisterKill(lane) {
    const left = Math.max(0, (this._fearAlive.get(lane) || 0) - 1);
    this._fearAlive.set(lane, left);
    return left;
  }

  // Frees a lane and clears out whatever is left of its current wave (dead or
  // still standing) — called on every exit path: death, clearing wave
  // FEAR_MAX_WAVE, or a disconnect mid-run. Idempotent: safe to call on a
  // lane that's already been released.
  //
  // Also clears the owner's own _fearLane, which is what makes it safe to
  // call from any path rather than only from deathBattleReturn. Leaving that
  // set on a player whose hall no longer exists was its own quiet disaster:
  // _raceVisible keys isolation off it, so the player stayed sealed into a
  // hall that wasn't there — every world monster and every other player
  // silently invisible to them for the rest of the session, and the hall
  // itself still counted against the 8.
  fearReleaseLane(lane) {
    if (lane == null || !this._fearOwner.has(lane)) return;
    const ownerSid = this._fearOwner.get(lane);
    const owner = this.players.get(ownerSid);
    if (owner && owner._fearLane === lane) owner._fearLane = null;
    this._fearOwner.delete(lane);
    this._fearAlive.delete(lane);
    const removedIds = [];
    this.enemies = this.enemies.filter(e => {
      if (e.arm !== 'fear' || e.lane !== lane) return true;
      this._enemyMap.delete(e.id);
      this._forgetEnemy(e.id);
      this._releaseIdx(e);
      removedIds.push(e.id);
      return false;
    });
    // _forgetEnemy only clears the SERVER's per-player _eKnown — it never
    // tells the client anything. A run interrupted by death (wave not fully
    // cleared) purges monsters that were still alive a moment ago, and
    // without this the owner's client would keep them as unremovable ghosts
    // — still selectable/targetable — until its own distance-based prune
    // eventually caught up (js/network.js's _aoiPruneTick).
    if (ownerSid && removedIds.length) this.io.to(ownerSid).emit('enemiesRemoved', { ids: removedIds });
  }

  // ── Сотрудничество (Coop) ────────────────────────────────────────────────
  // Claims the first unoccupied lane (0 or 1) and places the player at its
  // entry point, full HP — the 2-player sibling of fearDeploy. Called twice,
  // once per participant, by server/index.js's coopGroupStart once both
  // halves of the pair are ready. Stage 1 is spawned separately (coopStartFirstStage)
  // after the same kind of pre-fight grace window Fear uses.
  coopDeploy(socketId) {
    const p = this.players.get(socketId);
    if (!p) return null;
    const lanes = this._dungeon.coop.lanes;
    const occupied = new Set(this._coopOwner.keys());
    this.players.forEach(op => { if (op._coopLane != null) occupied.add(op._coopLane); });
    let lane = -1;
    for (let i = 0; i < lanes.length; i++) if (!occupied.has(i)) { lane = i; break; }
    if (lane === -1) return null;
    const spot = lanes[lane];
    p.x = spot.entryX; p.y = spot.entryY;
    p.hp = p.maxHp;
    p._coopLane = lane;
    p._raceLane = null;
    p._fearLane = null;
    p._profileRev++;
    this._coopOwner.set(lane, socketId);
    return { x: p.x, y: p.y, lane };
  }

  // Spawns COOP_MOBS_PER_STAGE monsters at COOP_STAGE_LEVELS[stage-1],
  // scattered at random points across lane `lane`'s stage-`stage` room —
  // deliberately NOT a ring around one centre the way fearSpawnWave spawns
  // a wave: "не стоят в ряд ... монстры в разброс" wants them spread across
  // the whole room, not converging from one point. Reuses the same global-
  // level species/name/color/stat functions the open world's own rooms use.
  coopSpawnStage(lane, stage) {
    this._coopPurgeDead(lane);
    const laneData = this._dungeon.coop.lanes[lane];
    const room = laneData && laneData.stages[stage - 1];
    if (!room) return;
    const lvl = COOP_STAGE_LEVELS[stage - 1];
    const armIdx = armIndexForLevel(lvl);
    const fe = FLOOR_ENEMIES[armIdx];
    const localLvl = lvl - ARM_OFFSETS[armIdx - 1];
    const maxLocalLvl = roomsInArm(armIdx) - 1;
    let spawned = 0;
    for (let n = 0; n < COOP_MOBS_PER_STAGE; n++) {
      const pool = bandForLocalLevel(fe, localLvl).pool;
      const d = _FEAR_ENEMY_BY_EID.get(pool[Math.floor(Math.random() * pool.length)]);
      if (!d) continue;
      let ex = room.cx, ey = room.cy;
      for (let attempt = 0; attempt < 40; attempt++) {
        const tx = room.x0 + 1 + Math.floor(Math.random() * Math.max(1, room.x1 - room.x0 - 1));
        const ty = room.y0 + 1 + Math.floor(Math.random() * Math.max(1, room.y1 - room.y0 - 1));
        const px = tx * TILE + TILE / 2, py = ty * TILE + TILE / 2;
        if (!this._isWall(px, py)) { ex = px; ey = py; break; }
      }
      const stats = monsterStatsAtLevel(lvl, d.eType);
      // Same halving every other packed room applies — 40 in a 16x16 room is
      // denser than the usual 5-10, so this matters here too.
      const weakMult = 0.5;
      const e = {
        id: `coop_${lane}_${this._coopSeq = (this._coopSeq || 0) + 1}`,
        ...d, isBoss: false, arm: 'coop', lane, rlvl: lvl,
        name: monsterNameAtLevel(d.name, localLvl, false, d.fem, maxLocalLvl),
        color: monsterColorAtLevel(d.color, d.endColor, localLvl, false, maxLocalLvl),
        maxHp: Math.floor(stats.hp * weakMult), hp: Math.floor(stats.hp * weakMult),
        atk: Math.floor(stats.atk * weakMult), def: stats.def, spd: d.spd,
        // No gold at all — see calcGoldDrop's `arm === 'coop'` branch
        // (shared/definitions.js). Coop's only per-kill reward is the flat
        // COOP_LIBERTY_CHANCE Liberty roll (server/index.js's attack/
        // skillAttack handlers).
        xp: xpAtLevel(lvl), gold: 0,
        x: ex, y: ey, spawnX: ex, spawnY: ey,
        // Standard aggro — see this file's "Сотрудничество tuning" comment.
        atkTimer: 1 + Math.random(), aggro: false, aggroR: 175 + Math.random() * 55,
        // MUST be set individually — see fearSpawnWave's identical comment on
        // why a shared/undefined _idx reads as the whole stage being frozen
        // and then jumping in lockstep.
        _idx: this._allocIdx(),
      };
      this.enemies.push(e);
      this._enemyMap.set(e.id, e);
      spawned++;
    }
    this._coopAlive.set(lane, spawned);
  }

  // Sets stage 1 live in both lanes and marks the room "started" — called
  // once by server/index.js's coopGroupStart once the post-entry grace window
  // elapses, mirroring _fearStartWave's role for Fear's wave 1.
  coopStartFirstStage() {
    this._coopStage = 1;
    this._coopClearedLane.set(0, false);
    this._coopClearedLane.set(1, false);
    for (let l = 0; l < 2; l++) if (this._coopOwner.has(l)) this.coopSpawnStage(l, 1);
  }

  // Spawns the shared level-COOP_BOSS_LEVEL boss in the room both lanes'
  // corridors converge into — a normal levelled boss (monsterStatsAtLevel's
  // 'boss' curve), not the fixed world-boss identity spawnRaceBoss reuses,
  // since the ask here was specifically "a level-40 boss", not a scaled-up
  // world event. Standing (not stationary): unlike race10's shared room this
  // one only ever holds the exact 2 players who earned it, so there's no
  // "drags the fight down whichever corridor it picks" concern to guard
  // against — it can chase like any other boss.
  coopSpawnBoss() {
    const coop = this._dungeon.coop;
    if (!coop || !coop.boss) return null;
    const lvl = COOP_BOSS_LEVEL;
    const armIdx = armIndexForLevel(lvl);
    const fe = FLOOR_ENEMIES[armIdx];
    const localLvl = lvl - ARM_OFFSETS[armIdx - 1];
    const maxLocalLvl = roomsInArm(armIdx) - 1;
    const d = _FEAR_ENEMY_BY_EID.get(fe.boss);
    if (!d) return null;
    const stats = monsterStatsAtLevel(lvl, 'boss');
    const { x, y } = coop.boss;
    const e = {
      id: `coop_boss_${this._coopSeq = (this._coopSeq || 0) + 1}`,
      ...d, isBoss: true, arm: 'coop', coopBoss: true, rlvl: lvl,
      name: monsterNameAtLevel(d.name, localLvl, true, d.fem, maxLocalLvl),
      color: monsterColorAtLevel(d.color, d.endColor, localLvl, true, maxLocalLvl),
      maxHp: stats.hp, hp: stats.hp, atk: stats.atk, def: stats.def, spd: d.spd,
      // No xp/gold table role either — its own fixed reward (1 bless_stone
      // + 100 Liberty, to one random participant) is granted directly by
      // server/index.js's _coopBossTrackKill, not through the normal
      // kill-reward path.
      xp: 0, gold: 0,
      x, y, spawnX: x, spawnY: y,
      atkTimer: 1, aggro: false, aggroR: 250,
      _idx: this._allocIdx(),
    };
    this.enemies.push(e);
    this._enemyMap.set(e.id, e);
    return e.id;
  }

  // Who currently owns lane `lane`, or null.
  coopOwnerOf(lane) { return this._coopOwner.get(lane) ?? null; }

  // Current stage number (0 = not started, 1..COOP_STAGE_LEVELS.length while
  // live, past the end once the boss is up) — read by server/index.js's
  // coopSync so a panel reopened mid-run shows the real stage.
  coopStage() { return this._coopStage; }

  // The lane a player is currently inside, or null.
  coopLaneOf(socketId) {
    const p = this.players.get(socketId);
    return p ? (p._coopLane ?? null) : null;
  }

  // Drops the corpses of a lane's just-cleared stage — the between-stages
  // sweep, same role _fearPurgeDead plays, called right before the next
  // stage's monsters are laid down.
  _coopPurgeDead(lane) {
    let found = false;
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (e.arm === 'coop' && e.lane === lane && e.hp <= 0) { found = true; break; }
    }
    if (!found) return;
    this.enemies = this.enemies.filter(e => {
      if (e.arm !== 'coop' || e.lane !== lane || e.hp > 0) return true;
      this._enemyMap.delete(e.id);
      this._forgetEnemy(e.id);
      this._releaseIdx(e);
      return false;
    });
  }

  // Called by server/index.js right after a kill lands on a `coop`-tagged,
  // non-boss enemy. This is the whole synchronization mechanism: a lane that
  // empties out marks itself cleared and waits; only once BOTH lanes are
  // cleared for the SAME stage does either one actually advance — spawning
  // stage+1 in both lanes at once, or (past the last stage) the shared boss.
  // Returns what happened so the caller knows what to tell each player:
  // { left } while monsters remain, { left:0, waiting:true } for a lane that
  // finished first and is waiting on its partner, or { left:0, stage } /
  // { left:0, bossSpawned:true } once both clear and something new spawns.
  coopRegisterKill(lane) {
    const left = Math.max(0, (this._coopAlive.get(lane) || 0) - 1);
    this._coopAlive.set(lane, left);
    if (left > 0) return { left };
    this._coopClearedLane.set(lane, true);
    const otherLane = lane === 0 ? 1 : 0;
    if (!this._coopClearedLane.get(otherLane)) return { left: 0, waiting: true };
    // Both lanes cleared the current stage — advance.
    this._coopClearedLane.set(0, false);
    this._coopClearedLane.set(1, false);
    this._coopStage++;
    if (this._coopStage > COOP_STAGE_LEVELS.length) {
      // coopSpawnStage purges the PREVIOUS stage's corpses on its own way
      // in (see its own comment) — the boss has no such call, so the last
      // stage's 80 dead have to be swept here or they'd sit in this.enemies,
      // walked by the AI tick loop and the enemy-grid rebuild 40 times a
      // second, for the rest of the boss fight.
      this._coopPurgeDead(0);
      this._coopPurgeDead(1);
      this.coopSpawnBoss();
      return { left: 0, bossSpawned: true };
    }
    for (let l = 0; l < 2; l++) if (this._coopOwner.has(l)) this.coopSpawnStage(l, this._coopStage);
    return { left: 0, stage: this._coopStage };
  }

  // Releases lane `lane` and clears out whatever is left of its current
  // stage (dead or still standing) — the per-lane building block
  // coopReleaseRoom (a clean end, both lanes) calls, and what server/
  // index.js's _coopReleaseRun/_coopEjectOnDisconnect call per-lane whenever
  // a single participant's own half of a run ends. Idempotent. Also clears
  // the owner's own p._coopLane, for the identical reason fearReleaseLane
  // does — _raceVisible keys isolation off it.
  coopReleaseLane(lane) {
    if (lane == null || !this._coopOwner.has(lane)) return;
    const ownerSid = this._coopOwner.get(lane);
    const owner = this.players.get(ownerSid);
    if (owner && owner._coopLane === lane) owner._coopLane = null;
    this._coopOwner.delete(lane);
    this._coopAlive.delete(lane);
    this._coopClearedLane.delete(lane);
    const removedIds = [];
    this.enemies = this.enemies.filter(e => {
      if (e.arm !== 'coop' || e.lane !== lane) return true;
      this._enemyMap.delete(e.id);
      this._forgetEnemy(e.id);
      this._releaseIdx(e);
      removedIds.push(e.id);
      return false;
    });
    if (ownerSid && removedIds.length) this.io.to(ownerSid).emit('enemiesRemoved', { ids: removedIds });
  }

  // Full teardown — both lanes AND the shared (laneless) boss if it was up.
  // Called once, by server/index.js, whenever the whole run ends for both
  // participants: cleared, a death, or a disconnect hold lapsing for good.
  coopReleaseRoom() {
    this.coopReleaseLane(0);
    this.coopReleaseLane(1);
    const bossRemoved = [];
    this.enemies = this.enemies.filter(e => {
      if (e.arm !== 'coop' || !e.coopBoss) return true;
      this._enemyMap.delete(e.id);
      this._forgetEnemy(e.id);
      this._releaseIdx(e);
      bossRemoved.push(e.id);
      return false;
    });
    this._coopStage = 0;
  }

  // ── Элитная фарм-зона (Elite Farm Zone 2) ──────────────────────────────
  // Unlike Coop's per-player lanes, all FARM2_PARTY_SIZE participants share
  // this one instance and its baked-in monsters (generateFarmZone2, server/
  // game/dungeon.js) — so deploy only needs to place the player at the
  // zone's shared entrance and record them as a current member, for
  // server/index.js's threshold-eject cascade (_farm2CascadeCheck) to read
  // via farm2MemberCount/farm2Members.
  farm2Deploy(socketId) {
    const p = this.players.get(socketId);
    if (!p) return null;
    const spot = this._dungeon.spawn;
    p.x = spot.x; p.y = spot.y;
    p.hp = p.maxHp;
    p._profileRev++;
    if (!this._farm2Members) this._farm2Members = new Set();
    this._farm2Members.add(socketId);
    return { x: p.x, y: p.y };
  }

  // Called on every exit path (finished, disconnected, left the party) —
  // idempotent, safe on a socket that was never a member.
  farm2Release(socketId) {
    if (this._farm2Members) this._farm2Members.delete(socketId);
  }

  farm2MemberCount() {
    return this._farm2Members ? this._farm2Members.size : 0;
  }

  // Scatters `items` on the floor around (cx, cy) as individually claimable
  // piles and tells everyone about them. Positions are rejected if they'd
  // land in a wall so nothing spawns unreachable.
  spawnWorldDrops(items, cx, cy) {
    const now = Date.now();
    const spawned = [];
    items.forEach((item, i) => {
      // Rings of increasing radius — 62 piles in one tight cluster would
      // overlap into an unreadable heap and all get vacuumed by one player
      // standing still (pickup radius is 30px, see js/game.js).
      let x = cx, y = cy;
      for (let attempt = 0; attempt < 24; attempt++) {
        const ring = 70 + Math.floor(i / 10) * 55 + Math.random() * 45;
        const ang = Math.random() * Math.PI * 2;
        const tx = cx + Math.cos(ang) * ring, ty = cy + Math.sin(ang) * ring;
        if (!this._isWall(tx, ty)) { x = tx; y = ty; break; }
      }
      const d = { id: `wd_${++this._dropSeq}`, x, y, item, expiresAt: now + EVENT_BOSS_DROP_LIFE_MS };
      this.worldDrops.set(d.id, d);
      spawned.push(d);
    });
    if (spawned.length) this.io.to(`floor_${this.floor}`).emit('worldDropsSpawned', { drops: spawned });
    return spawned;
  }

  // Atomic claim — the Map delete is the arbitration point, so two players
  // walking over the same pile in the same tick can't both get it.
  claimWorldDrop(dropId, px, py) {
    const d = this.worldDrops.get(dropId);
    if (!d) return null;
    if (d.expiresAt <= Date.now()) { this.worldDrops.delete(dropId); return null; }
    // Server-side range check so a modified client can't hoover the map from
    // across the hub. Generous vs the client's own 30px pickup radius to
    // allow for movement latency.
    const dx = d.x - px, dy = d.y - py;
    if (dx * dx + dy * dy > 120 * 120) return null;
    this.worldDrops.delete(dropId);
    this.io.to(`floor_${this.floor}`).emit('worldDropTaken', { id: dropId });
    return d;
  }

  // Answers a client that received position deltas for enemies it has no
  // record of. Replaces what the 2s world-wide refresh used to do by accident,
  // at a fraction of the cost: one small packet to one player, only for the
  // enemies actually missing. Encoded as an ordinary gameState (players: null)
  // so the client's existing merge path handles it with no new format.
  // Drop this player's "they already have it" bookkeeping, so the next cast
  // sends every enemy in their radius as a full record. Asked for by a client
  // whose decoder lost the record behind a handle (see enemyResyncAll) — it
  // cannot name the enemy, only the fact that it can no longer follow the
  // stream.
  forgetKnownEnemies(socketId) {
    const p = this.players.get(socketId);
    if (!p) return;
    const now = Date.now();
    // One reset makes the next cast carry a full record per enemy in range —
    // the single largest packet this connection ever sends. A link bad enough
    // to keep asking must not be able to turn that into a second stream.
    if (now - (p._eResetAt || 0) < 3000) return;
    p._eResetAt = now;
    p._eKnown.clear();
    this._eResets = (this._eResets || 0) + 1;
  }

  resendEnemies(socketId, ids) {
    const p = this.players.get(socketId);
    if (!p || !Array.isArray(ids) || !ids.length) return;
    const out = [];
    const known = p._eKnown;
    for (const id of ids) {
      if (out.length >= ENEMY_RESYNC_MAX) break;
      const e = this._enemyMap.get(id);
      if (!e || e.hp <= 0) continue;
      // Same two-way rule every other enemy-list path enforces (see
      // _raceVisible) — without it, a client that somehow ended up holding an
      // id from another race10/Fear lane (e.g. a stale reference) could just
      // ask for it back and get a straight answer, bypassing every other
      // isolation check in the room.
      if (!this._raceVisible(p, e)) continue;
      out.push(_fullEnemyEntry(e));
      // Record it as sent, or the next tick would spend another full entry on
      // the same enemy before any slim delta could be used for it.
      if (known) known.set(e.id, { x: e.x, y: e.y, hp: e.hp, aggro: e.aggro, seen: this._tickNo, sent: this._tickNo, full: true });
    }
    if (!out.length) return;
    // A fresh generation number every time — the gen is an encoder cache key,
    // and reusing a tick's would serve that tick's bytes instead of these.
    this._nearEnemiesGen++;
    this.io.to(socketId).emit('gameState',
      encodeGameState(null, out, Date.now(), this._nearEnemiesGen));
  }

  worldDropSnapshot() {
    const now = Date.now();
    return [...this.worldDrops.values()].filter(d => d.expiresAt > now);
  }

  _startLoop() {
    if (this._interval) return;
    this._lastTick = Date.now();
    this._interval = setInterval(() => {
      const t0 = Date.now();
      try { this._tick(); } catch (err) { console.error(`[Room ${this.floor} tick]`, err); }
      const ms = Date.now() - t0;
      this._tickMsSum += ms;
      this._tickSamples++;
      if (ms > this._tickMsMax) this._tickMsMax = ms;
      if (ms > TICK_MS) this._tickOverruns++;
    }, TICK_MS);
  }

  _stopLoop() {
    if (!this._interval) return;
    clearInterval(this._interval);
    this._interval = null;
  }

  // Snapshot of how the loop is actually keeping up, for /health. Reading it
  // resets the window so each poll describes the interval since the last one
  // rather than an ever-flattening lifetime average.
  stats() {
    const s = {
      floor: this.floor,
      players: this.players.size,
      enemies: this.enemies.length,
      tickMsAvg: this._tickSamples ? +(this._tickMsSum / this._tickSamples).toFixed(2) : 0,
      tickMsMax: this._tickMsMax,
      tickOverruns: this._tickOverruns,
      tickSamples: this._tickSamples,
      tickBudgetMs: TICK_MS,
      // Crowd-control the room refused: out of range, no line of sight, wrong
      // instance, dead caster. handlers2/world.js increments this and its
      // comment says "see ccRefused on /health" — which was not true, because
      // nothing here reported it. A steady non-zero is either a client
      // reaching for what it cannot touch, or a range that is too tight.
      ccRefused: this.ccRefused || 0,
    };
    this.ccRefused = 0;
    this._tickMsMax = 0; this._tickMsSum = 0; this._tickSamples = 0; this._tickOverruns = 0;
    return s;
  }

  // The map as one self-contained buffer, plus a content hash naming it.
  //
  // The world is generated from a FIXED seed (see generateOpenWorld in
  // server/game/dungeon.js), so every process builds a byte-identical map:
  // the hash is stable across restarts and redeploys, which is what makes it
  // safe to serve this over HTTP with an immutable, effectively permanent
  // cache. Before this, the whole thing — 52KB of packed grid plus ~79KB of
  // room JSON — was serialized into gameStart for every single join, and a
  // join happens on every socket.io reconnect, not just at login. A restart
  // reconnects everyone at once, and 150 simultaneous joins stretched a 25ms
  // tick to 125ms.
  //
  // Layout: u32 JSON byte length, the JSON (everything except the grid), then
  // the raw packed grid. Decoded by _decodeWorldMap in js/network.js.
  get mapPayload() {
    if (this._mapPayload) return this._mapPayload;
    const d = this.dungeonData;
    const meta = { ...d, gridPacked: undefined };
    delete meta.gridPacked;
    const json = Buffer.from(JSON.stringify(meta), 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(json.length, 0);
    this._mapPayload = Buffer.concat([head, json, d.gridPacked]);
    this._mapVersion = crypto.createHash('sha1').update(this._mapPayload).digest('hex').slice(0, 12);
    return this._mapPayload;
  }

  get mapVersion() {
    if (!this._mapVersion) this.mapPayload; // builds both
    return this._mapVersion;
  }

  get dungeonData() {
    const d = this._dungeon;
    // guildWar/farmZone/arena/race10 are now only ever present on that
    // zone's own floor's own Room — each carries whatever geometry/tinting
    // bounds that floor's own dungeonData needs (see generateGuildWar/
    // generateFarmZone/generateArena/generateRace10, server/game/dungeon.js);
    // race10.bounds in particular is what lets the client tint that whole
    // floor to look like "Кровавая Башня" (_buildChunk, js/game.js). The hub
    // no longer has any of these fields at all, since its outbound pads
    // (_gwPad/_evtPad and the single _portalPad covering the arms +
    // Фарм-зона, js/game.js) only need the hub's own spawn point plus a
    // fixed offset (and, for the portal's level-gated destinations,
    // farmZoneEntry.req) — not the zone's own geometry, and pvpArena/race10
    // have no walk-in pad at all (matchmade/scheduled deploys only). this._
    // dungeon.arena/pvpArena themselves still exist on their own floor's own
    // Room internally (spawnEventBoss/deathBattleDeploy/pvpArenaDeploy read
    // them directly), just no longer part of what gets sent here.
    // returnPad exists on every "own floor, one entrance" zone (arms, Guild
    // War, Фарм-зона, arena, …) — the pad that requests a transition back to
    // the hub; armEntries/farmZoneEntry only on the hub (the outbound pads,
    // now just {req} or {dir,req} — no target x/y, each zone is its own floor).
    // coop only ever carries `bounds` here (see generateCoop's own comment)
    // — `lanes`/`boss`/`bossRoomX0` are per-run geometry Room.js reads
    // directly off this._dungeon.coop, never meant for the wire.
    return { gridPacked: this._gridPacked, rooms: d.rooms, spawn: d.spawn, w: d.w, h: d.h, safeZone: d.safeZone, armEntries: d.armEntries, farmZoneEntry: d.farmZoneEntry, returnPad: d.returnPad, corridorGates: d.corridorGates, race10: d.race10, guildWar: d.guildWar, farmZone: d.farmZone, farmZone2: d.farmZone2, coop: d.coop ? { bounds: d.coop.bounds, barriers: d.coop.barriers } : undefined };
  }

  _inSafeZone(x, y) {
    const sz = this._dungeon.safeZone;
    if (!sz) return false; // arm floors have no hub-style safe zone
    return x >= sz.x1 && x <= sz.x2 && y >= sz.y1 && y <= sz.y2;
  }

  isPlayerInSafeZone(socketId) {
    const p = this.players.get(socketId);
    return p ? this._inSafeZone(p.x, p.y) : false;
  }

  // The client's starting enemy list. Scoped to what's near that player for
  // the same reason the live stream is (see _collectEnemiesFor): unscoped
  // this was ~960KB of JSON on every single login, essentially all of it
  // describing enemies on the far side of the world that the very next tick
  // would prune again. Bosses are always included, wherever they are —
  // except an instance's own boss (race10) to everyone NOT in it, and vice
  // versa, same as the live stream.
  //
  // ── _eKnown means TWO things, and they are not the same ─────────────────
  // This map answers two questions, and conflating them cost a minute of
  // frozen monsters on every arrival:
  //
  //   "does this player know this enemy exists?"  — viewersOfEnemy asks this,
  //      to decide who is told the corpse fell. A player who has the enemy on
  //      screen must be told, or it stands there dead.
  //
  //   "can this player's DECODER resolve this enemy's handle?" — the delta
  //      stream asks this. The stream is binary and names enemies by a small
  //      numeric handle, and the handle→id mapping is established ONLY by a
  //      full entry in that stream (shared/netcodec.js). The client clears the
  //      mapping on every gameStart, correctly: handles belong to the room it
  //      just left.
  //
  // This snapshot rides on gameStart as JSON. It answers the first question
  // and not the second. Marking these entries plainly "known" therefore told
  // _collectEnemiesFor to send handle-only deltas for handles the client could
  // not resolve, and the decoder's answer to an unknown handle is to skip the
  // entry — silently. The monsters stayed painted wherever the snapshot left
  // them, took no damage on screen and reacted to nothing, until
  // ENEMY_REFRESH_CASTS came round: 1200 casts, once a minute, staggered per
  // enemy. Then each popped to where it had really been, one at a time.
  //
  // The client's own repair could not help either: _queueEnemyResync fires
  // only for an enemy it has no record of, and it had one — from here.
  // Nothing was missing. Only undecodable.
  //
  // So the entry is written with `full: false`: known for the first question,
  // not yet established for the second. _pushEnemyEntry sends a full record
  // the first time it sees that, and a delta from then on.
  enemySnapshot(socketId) {
    const p = socketId != null ? this.players.get(socketId) : null;
    const out = [];
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (e.hp <= 0) continue;
      // _collectEnemiesFor (the live per-cast stream) gates every enemy on
      // this same check; without it here too, a player's very first enemy
      // list on join/reconnect — sent before the live stream's own AOI grid
      // has had a chance to run — could include a neighbouring race10/Fear
      // lane's monsters within plain AOI distance (lanes sit well inside
      // ENEMY_AOI_R apart), which is exactly what let a player standing in
      // one Fear lane target/assist into the one next door.
      if (p && !this._raceVisible(p, e)) continue;
      if (p && !e.isBoss) {
        const dx = e.x - p.x, dy = e.y - p.y;
        if (dx * dx + dy * dy > ENEMY_AOI_R2) continue;
      }
      out.push({
        id: e.id, eid: e.eid, x: e.x, y: e.y, hp: e.hp, maxHp: e.maxHp,
        name: e.name, color: e.color, size: e.size, isBoss: e.isBoss, aggro: e.aggro,
        aggroR: e.aggroR, spd: e.spd, rlvl: e.rlvl || 0,
      });
      // Known — but `full: false`. See the two meanings of _eKnown above.
      if (p) {
        p._eKnown.set(e.id, {
          x: e.x, y: e.y, hp: e.hp, aggro: e.aggro, seen: this._tickNo, full: false,
        });
      }
    }
    return out;
  }

  // One boss per corridor (arm) — alive or, once dead, the timestamp it
  // respawns at. respawnTimer is undefined for the single tick right after
  // death (the AI loop hasn't assigned it its full duration yet), so fall
  // back to the same constant used to seed it.
  getBossStatus() {
    const status = {};
    ARM_NAMES.forEach(arm => {
      const boss = this.enemies.find(e => e.isBoss && e.arm === arm);
      if (!boss) return;
      if (boss.hp > 0) { status[arm] = { alive: true }; return; }
      const secs = boss.respawnTimer !== undefined ? boss.respawnTimer : _bossRespawnSecs();
      status[arm] = { alive: false, respawnAt: Date.now() + Math.max(0, secs) * 1000 };
    });
    return status;
  }

  _isWall(x, y) {
    const d = this._dungeon;
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
    if (tx < 0 || ty < 0 || tx >= d.w || ty >= d.h) return true;
    return d.grid[ty][tx] === WALL;
  }

  // Public form of _isWall, for the reconnect path in server/index.js: a
  // stored position is only worth restoring if it is still somewhere this
  // floor can be stood on. The map is generated from a fixed seed and so does
  // not change between deploys, but a position saved on one floor must never
  // be applied on another (an arm's coordinates are far outside the hub's
  // 68x68 grid), and a restore that drops someone inside geometry is worse
  // than one that puts them on the spawn.
  canStandAt(x, y) {
    return Number.isFinite(x) && Number.isFinite(y) && !this._isWall(x, y);
  }

  // Same sampling algorithm as the client's hasLOS() (combat.js) — kept in
  // lockstep so a shot the client thinks is clear doesn't get rejected here.
  // ── Кровавая Башня: lane isolation ────────────────────────────────────────
  // Lanes sit RACE10_LANE_PITCH (5 tiles = 200px) apart and monsters aggro out
  // to 230px, so on distance alone a monster reaches two rows either side —
  // straight through a solid wall. The line-of-sight test only gates the FIRST
  // aggro, and losing sight never drops it (a deliberate rule everywhere else
  // in the world), so a monster pulled by its own runner would then chase
  // whoever was nearest afterwards, wall or no wall, and stand there grinding
  // into it. The same radius on the client's side is what let a player's
  // auto-target lock a monster in the next corridor and run at it.
  //
  // Distance can't separate corridors, so identity does: every corridor
  // monster carries the lane it was generated in, every entrant carries the
  // lane they were deployed into, and the two only interact when those match.
  // Both the AI's target search and the per-player enemy stream go through
  // these, so a monster in another lane is not merely unreachable — the client
  // is never told it exists, and therefore cannot target it.
  //
  // The boss is deliberately laneless: it stands in the one shared room every
  // corridor opens into, and every entrant must be able to see and fight it.
  // Also covers Страх (Fear) and Сотрудничество (Coop): their lanes are
  // isolated by the same rule, just keyed off p._fearLane/e.arm === 'fear'
  // and p._coopLane/e.arm === 'coop' instead of the tower's own fields — a
  // player can only ever be in at most one of the three instance types at
  // once, so the checks never overlap. Coop's own boss is laneless for the
  // identical reason the tower's is: both participants converge on it.
  _raceVisible(p, e) {
    if (e.arm === 'race10') return p._raceLane != null && (e.lane == null || e.lane === p._raceLane);
    if (e.arm === 'fear') return p._fearLane != null && (e.lane == null || e.lane === p._fearLane);
    if (e.arm === 'coop') return p._coopLane != null && (e.lane == null || e.lane === p._coopLane);
    return p._raceLane == null && p._fearLane == null && p._coopLane == null;
  }

  // The composite lane identity used to scope visual fan-out (nearbyPlayerIds/
  // queueProjectile/queueAoe/laneOf) — distinguishes "not in any instance",
  // "tower lane N" and "Fear lane N" with one comparable value, since a raw
  // _raceLane number and a raw _fearLane number would otherwise collide (lane
  // 0 of one instance type must never see lane 0 of the other).
  //
  // A race10 racer past bossRoomX0 shares one key with every other racer
  // there, regardless of which lane they ran — same "laneless" treatment the
  // boss itself already gets (_raceVisible's `e.lane == null` clause). Without
  // this every entrant kept their own per-lane key for the whole race,
  // including inside the one room every lane opens into, so racers never saw
  // each other even standing shoulder to shoulder on the same boss — every
  // corridor still isolates its own lane from the one next door, this only
  // stops isolating players from each other once they've actually converged.
  _playerLaneKey(p) {
    if (p._raceLane != null) {
      const race = this._dungeon.race10;
      if (race && p.x >= race.bossRoomX0) return 'race10boss';
      return 'r' + p._raceLane;
    }
    if (p._fearLane != null) return 'f' + p._fearLane;
    // Same convergence treatment as race10: once a Coop participant reaches
    // the shared boss room both lanes open into, they share one key with
    // their partner regardless of which lane they each ran — the whole
    // point of a co-op finish is fighting the boss together, visibly.
    if (p._coopLane != null) {
      const coop = this._dungeon.coop;
      if (coop && p.x >= coop.bossRoomX0) return 'coopboss';
      return 'c' + p._coopLane;
    }
    return null;
  }

  // Authoritative check backing the client-side _raceUnselectable (js/
  // input.js) — partyInvite/requestPlayerProfile (server/index.js) go
  // through this rather than trusting a client to only ever ask about
  // someone it was actually offered as a target, since race10 racers are now
  // streamed to each other across lanes (see the pIsRacer exception above)
  // purely to be visible, not to be interacted with. Same lane, not racing
  // at all, or both already converged on the shared boss room are all fine;
  // two different corridors still isn't, same rule _playerLaneKey applies.
  racePairAllowed(aSocketId, bSocketId) {
    const a = this.players.get(aSocketId), b = this.players.get(bSocketId);
    if (!a || !b) return false;
    if (a._raceLane == null || b._raceLane == null || a._raceLane === b._raceLane) return true;
    const race = this._dungeon.race10;
    return !!race && a.x >= race.bossRoomX0 && b.x >= race.bossRoomX0;
  }

  // Nearest standable point to (x, y), searched outward in rings of whole
  // tiles. Used by every path that PLACES a player rather than moving them —
  // spawn, respawn, teleport, arena deploy — so a destination that happens to
  // fall on geometry becomes the nearest valid spot instead of a player stuck
  // inside a wall.
  //
  // Bounded at 8 tiles: past that the destination is wrong in a way nudging
  // cannot fix, and the caller should be told rather than have the player
  // silently relocated across the map.
  _nearestWalkable(x, y, maxRings = 8) {
    if (!this._isWall(x, y)) return { x, y, moved: false };
    for (let r = 1; r <= maxRings; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          // Ring only — the interior was covered by a smaller r.
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const nx = x + dx * TILE, ny = y + dy * TILE;
          if (!this._isWall(nx, ny)) return { x: nx, y: ny, moved: true };
        }
      }
    }
    return null;
  }

  _hasLOS(x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    if (len < 1) return true;
    const steps = Math.ceil(len / (TILE * 0.45));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (this._isWall(x1 + dx * t, y1 + dy * t)) return false;
    }
    return true;
  }

  _tick() {
    const now = Date.now();
    const dt = Math.min((now - this._lastTick) / 1000, 0.1);
    this._lastTick = now;
    if (this.players.size === 0) return;

    const nearPlayers = this._nearPlayersBuf;
    const nearEnemies = this._nearEnemiesBuf;
    // Built every tick, not just on cast ticks: the enemy AI's closest-target
    // search queries it too, and that runs at the full 40Hz. It replaces the
    // flat alive-players array the AI used to scan end-to-end per enemy, so
    // that array is no longer built at all.
    this._rebuildPlayerGrid();

    // Detect players entering the safe zone — reset only enemies chasing them.
    // Collect the transitions first and make at most ONE pass over the enemy
    // list for the whole set: this used to run a full enemies.forEach per
    // entering player, so a group of ten stepping into the hub on the same
    // tick cost ten sweeps of ~4500 enemies inside a 25ms budget.
    let entered = null;
    const armPresent = this._armPresent;
    armPresent.clear();
    const gw = this._dungeon.guildWar;
    this.players.forEach(p => {
      this._regenTick(p, dt, now);
      const nowIn = this._inSafeZone(p.x, p.y);
      if (nowIn && !p._wasInSafeZone) (entered || (entered = new Set())).add(p.socketId);
      p._wasInSafeZone = nowIn;
      // Arms are stacked by Y with no overlap (see dungeon.js's armBounds
      // comment) — at most one of these can match, so break on the first hit.
      // armBounds no longer exists on any floor's dungeon now that each arm
      // is its own floor/Room (a floor's enemies already belong to just that
      // one arm, or to none) — this whole presence-culling optimization is
      // dead weight post-split, kept only as a no-op guard for now rather
      // than ripping out its two callers below in the same pass.
      if (this._armBounds) {
        for (let i = 0; i < ARM_NAMES.length; i++) {
          const b = this._armBounds[ARM_NAMES[i]];
          if (p.y >= b.y0 && p.y < b.y1) { armPresent.add(ARM_NAMES[i]); break; }
        }
      }
      // Guild War: pvpMode is driven continuously off live position, for as
      // long as a player is physically inside the zone bounds — unlike every
      // other zone's pvpMode flip (duel toggle, arena deploy, hub eviction),
      // all of which are one-shot events. Leaving turns it back off; nobody
      // can walk in already mid-duel, so this can never clobber a real one.
      if (gw) {
        const nowInGw = p.x >= gw.bounds.x0 * TILE && p.x < gw.bounds.x1 * TILE
                      && p.y >= gw.bounds.y0 * TILE && p.y < gw.bounds.y1 * TILE;
        if (nowInGw !== !!p._guildWarZone) {
          p._guildWarZone = nowInGw;
          p.pvpMode = nowInGw;
          p._profileRev++;
          // gameState never carries a player's own entry back to their own
          // socket (js/network.js's handler returns early on p.id === myId,
          // since every other field there is echoed from elsewhere) — so
          // this flip needs its own explicit push, or the local client never
          // finds out its own pvpMode changed and can neither attack nor be
          // attacked despite the server already treating it as live PvP.
          this.io.to(p.socketId).emit('pvpModeSync', { pvpMode: nowInGw });
        }
      }
    });
    if (entered) {
      for (let i = 0; i < this.enemies.length; i++) {
        const e = this.enemies[i];
        if (e.hp <= 0 || e.ignoresSafeZone) continue; // event boss chases into the hub
        if (!e._targetId || !entered.has(e._targetId)) continue;
        e.x = e.spawnX; e.y = e.spawnY;
        e.aggro = false;
        e._targetId = null;
        e._cachedTarget = null;
        e._shp = -1;
      }
    }

    // Enemy AI + respawn
    this._aiTickNo++;
    this.enemies.forEach(e => {
      if (e.hp <= 0) {
        // Guild War tower: same reasoning — the capture branch in
        // attackEnemy/skillAttackEnemy resets its hp to maxHp in the same
        // tick it would otherwise hit 0, so this is a defensive no-op in
        // practice, not a real path.
        if (e.guildWar) return;
        // Race10 boss: same reasoning — server/index.js ends the race and
        // calls despawnRaceBoss() in the same tick it dies (no loot table,
        // the reward is a Liberty payout to whoever dealt it the most damage).
        if (e.raceBoss) return;
        // Race10 corridor monsters: stay dead until resetRaceMonsters() revives
        // the whole lane for the next race — a 12s auto-respawn (the normal
        // rule below) would let an early kill come back mid-run and the
        // client's "all dead" barrier check (js/game.js) would never pass.
        if (e.arm === 'race10') return;
        // Fear wave monsters: same reasoning — stay dead until the wave
        // clears and fearReleaseLane purges them (or fearSpawnWave replaces
        // them with the next wave's fresh batch). A 12s auto-respawn here
        // would let an early kill silently come back and never let
        // fearRegisterKill's count reach zero.
        if (e.arm === 'fear') return;
        // Coop boss: same reasoning as the race10 boss — server/index.js
        // grants its fixed reward and ends the run for both participants in
        // the same tick it dies, no loot table needed here.
        if (e.coopBoss) return;
        // Coop stage monsters: same reasoning as Fear's wave monsters — stay
        // dead until both lanes clear the stage (coopRegisterKill) and
        // coopSpawnStage lays down the next batch, or the lane is released.
        if (e.arm === 'coop') return;
        // Event boss: drop its whole loot table on the floor for everyone and
        // remove it for good. Unlike the per-arm bosses it never respawns on
        // a timer — only another admin summon brings it back. _evtLooted
        // guards against the drop firing twice before the removal below runs.
        if (e.ignoresSafeZone) {
          if (!e._evtLooted) {
            e._evtLooted = true;
            this.spawnWorldDrops(rollEventBossDrops(), e.x, e.y);
            this.io.to(`floor_${this.floor}`).emit('eventBossDefeated', {});
            e._evtRemove = true; // purged after this forEach, see below
            this._evtPurge = true;
          }
          return;
        }
        // Defensive fallback only — attackEnemy/skillAttackEnemy already
        // assign a per-arm boss's respawnTimer (and persist it) the instant
        // it dies, so this branch only ever fires for regular enemies' 12s
        // timer, or for a boss killed through some other path.
        if (e.respawnTimer === undefined) {
          e.respawnTimer = e.isBoss ? _bossRespawnSecs() : 12;
          if (e.isBoss && this._onBossDeath) this._onBossDeath(e.arm, Date.now() + e.respawnTimer * 1000);
          return;
        }
        e.respawnTimer -= dt;
        if (e.respawnTimer <= 0) {
          e.hp = e.maxHp;
          e.x = e.spawnX; e.y = e.spawnY;
          e.aggro = false; e.atkTimer = 1 + Math.random(); e.hurtTimer = 0;
          e.stunTimer = 0; e.slowTimer = 0; e.defDownTimer = 0;
          e._shp = -1;
          delete e.respawnTimer;
          if (e.isBoss) this.io.to(`floor_${this.floor}`).emit('bossStatus', { arm: e.arm, alive: true });
        }
        return;
      }

      // Guild War tower: stationary for the Room's entire lifetime — no
      // targeting, no movement, no attack, no leash. Damage/capture applies
      // via attackEnemy/skillAttackEnemy, which don't go through this loop.
      if (e.guildWar) return;

      // Corridor monsters while no race is running: there is nobody inside the
      // tower to see, so the target search below can only ever come back empty.
      // Skipping them outright is what makes a large number of pre-generated
      // lanes free — with RACE10_LANES lanes at 120 monsters each they are a
      // sizeable share of the world's enemies, and every one of them was being
      // walked 40 times a second to answer "is anyone near?" with "no".
      if (e.arm === 'race10' && !e.raceBoss && !this._raceActive) return;

      // Same idea, applied to the 4 open-world arms: a regular (non-boss)
      // enemy whose arm currently has zero players can't have anyone to
      // aggro onto or be seen by (armPresent is recomputed every tick above,
      // from live player positions) — skip its target search/movement/attack
      // entirely. Bosses are excluded: there are only 4 of them, so the cost
      // is negligible, and skipping would also skip their leash/respawn-
      // adjacent state below in ways not worth reasoning about here.
      if (!e.isBoss && this._armBounds && this._armBounds[e.arm] && !armPresent.has(e.arm)) return;

      // Tick CC timers
      if ((e.stunTimer || 0) > 0) { e.stunTimer -= dt; return; }
      if ((e.slowTimer || 0) > 0) e.slowTimer -= dt;
      if ((e.defDownTimer || 0) > 0) e.defDownTimer -= dt;

      // Find closest alive player not in safe zone, not invisible — but only
      // actually re-scan every AI_TARGET_SEARCH_EVERY ticks (see its comment
      // above); otherwise reuse the cached target as long as it's still
      // eligible, so a stale reference never keeps an enemy chasing someone
      // who died/vanished/hid for multiple ticks.
      // The event boss (shared/definitions.js EVENT_BOSS) is summoned INTO the
      // hub, which is the safe zone — the normal rules would leave it with no
      // eligible target forever. It alone may target players standing there;
      // every other enemy still skips them, so the hub stays safe from
      // everything except this one deliberate world event.
      const _sz = !e.ignoresSafeZone;
      const cached = e._cachedTarget;
      const cachedStillValid = cached && cached.hp > 0 && this.players.get(cached.socketId) === cached &&
        !(_sz && this._inSafeZone(cached.x, cached.y)) && !cached._invis;
      const dueForSearch = (e._idx % AI_TARGET_SEARCH_EVERY) === (this._aiTickNo % AI_TARGET_SEARCH_EVERY);
      let closest = cachedStillValid ? cached : null;
      if (dueForSearch || !cachedStillValid) {
        closest = this._closestTargetFor(e, _sz);
        e._cachedTarget = closest;
      }
      const closestD2 = closest ? (closest.x - e.x) * (closest.x - e.x) + (closest.y - e.y) * (closest.y - e.y) : Infinity;
      // No eligible target anywhere in the room (e.g. a solo player just
      // died, or everyone left/entered a safe zone) — snap straight back to
      // spawn instead of freezing mid-chase wherever it happened to be. The
      // enemy only ever moves while aggro is true, so this is the only place
      // that state needs resetting; without it an enemy could sit stalled
      // off its spawn point indefinitely, only recovering once some other
      // player later wanders close enough to re-target it.
      if (!closest) {
        e._targetId = null;
        if (e.aggro && !e.ignoresSafeZone) { e.aggro = false; e.x = e.spawnX; e.y = e.spawnY; e._shp = -1; }
        if (e.ignoresSafeZone) e.aggro = false;
        return;
      }
      e._targetId = closest.socketId;

      const closestD = Math.sqrt(closestD2);

      // Only trigger aggro with a clear line of sight — an enemy on the
      // other side of a wall within radius shouldn't wake up and start
      // charging at a player it can't actually see. Losing LOS after
      // aggro doesn't cancel it (still purely distance-gated below) so a
      // player briefly ducking behind a corner mid-chase doesn't flicker
      // the enemy off and on.
      // `!e.aggro` first: losing LOS never cancels aggro (see above), so once
      // an enemy is awake the sampled wall-walk in _hasLOS can only ever
      // re-confirm what's already true. Skipping it there takes the single
      // most expensive call in this loop off every already-chasing enemy,
      // every tick — which in a busy arm is most of them.
      //
      // farmZone/farmZone2 are excluded from this self-pull trigger
      // explicitly rather than via aggroR:0 — zeroing aggroR used to also
      // zero the de-aggro leash below (aggroR * 2.2), which reset aggro back
      // to false the very next tick after attackEnemy/skillAttackEnemy set
      // it, so a farm-zone monster could set its own hp/target but could
      // never actually swing back. It keeps a normal aggroR purely for that
      // leash distance. farmZone2's own monsters stand in packs
      // (packMateIds, generateFarmZone2) that wake together on a hit
      // instead — see _wakePack — but never wake on proximity alone.
      if (!e.aggro && !e.farmZone && !e.farmZone2 && closestD < e.aggroR && this._hasLOS(e.x, e.y, closest.x, closest.y)) e.aggro = true;
      // Same immediate-teleport-home as above: the closest remaining player
      // isn't necessarily near THIS enemy (they could be dead here and the
      // "closest" is someone else across the floor) — de-aggroing shouldn't
      // leave the enemy stranded wherever the chase ended.
      if (closestD > e.aggroR * 2.2 && e.aggro && !e.ignoresSafeZone) {
        e.aggro = false;
        e.x = e.spawnX; e.y = e.spawnY;
        e._shp = -1;
      }

      if (e.aggro) {
        // `stationary` holds an enemy on its spawn point while leaving the
        // rest of its behaviour alone — it still aggros, still swings at
        // anyone who steps into reach. Used by the tower's boss (see
        // spawnRaceBoss); everything else moves as before.
        if (!e.stationary && closestD > e.size + 14) {
          const spdMult = (e.slowTimer || 0) > 0 ? 0.35 : 1;
          const nx = (closest.x - e.x) / closestD;
          const ny = (closest.y - e.y) / closestD;
          const evx = nx * e.spd * spdMult * dt, evy = ny * e.spd * spdMult * dt;
          if (!this._isWall(e.x + evx, e.y)) e.x += evx;
          if (!this._isWall(e.x, e.y + evy)) e.y += evy;
        }
        if (e.atkAnimTimer > 0) e.atkAnimTimer -= dt;
        e.atkTimer -= dt;
        if (closestD < e.size + 20 && e.atkTimer <= 0) {
          e.atkTimer = 1.4 + Math.random() * 0.6;
          e.atkAnimTimer = 0.9;
          e._atkPulse = true;
          const dmg = Math.max(1, e.atk - (closest.def || 0));
          closest.hp = Math.max(0, closest.hp - dmg);
          // Straight down the victim's own socket, not io.to(id): the room
          // form builds a BroadcastOperator plus a rooms Set on every call,
          // and this runs inside the 40Hz AI loop on every monster swing —
          // the same reasoning the gameState emit below already follows.
          const vsock = this._socketFor(closest);
          // atkId: lets the victim's client resync this specific enemy's
          // position (see _queueEnemyResync in js/network.js) the instant a
          // hit lands from one it either doesn't know or hasn't heard from
          // recently — the gameState position stream is volatile (Room.js's
          // per-cast emit above) and can silently drop on a bad connection
          // while this reliable emit still gets through, which otherwise
          // reads as "the monster is standing still/far away but still
          // hitting me" until the next periodic full refresh (up to
          // ENEMY_REFRESH_CASTS ticks away).
          if (vsock) vsock.emit('playerHurt', { id: closest.socketId, hp: closest.hp, dmg, atkId: e.id });
        }
      }

      // Leash: too far from spawn → full HP reset back to spawn. Skipped for
      // the event boss: LEASH_R2 is only 420px and the hub is 48 tiles across,
      // so players circling it would repeatedly reset its 100k HP to full.
      //
      // Also skipped for Fear (arm === 'fear'): this is a separate mechanism
      // from the aggroR*2.2 de-aggro/target-search radius above, which is the
      // one FEAR_AGGRO_R (500) was widened for — that fix left this flat,
      // aggro-independent 420px check untouched. A Fear hall's own diagonal
      // is ~679px (12 tiles) and monsters spawn up to ~190px off-centre
      // (FEAR_SPAWN_RING_MAX), so simply fighting across the room — completely
      // ordinary play against a 20-monster swarm in a sealed 12-tile room —
      // routinely exceeds 420px from a monster's spawn point. It would then
      // snap back to its spawn tile at full HP mid-fight: damage already
      // dealt undone and the monster gone from wherever the player was just
      // fighting it, which is exactly the "monsters disappear" symptom. Same
      // "nowhere to drag anything in a sealed room" reasoning as the aggroR
      // widening — the hall has walls, so there's nothing left for a leash to
      // protect against here.
      // Also skipped for Coop (arm === 'coop'): its stage rooms (16 tiles,
      // ~906px diagonal) are themselves bigger than this flat 420px radius,
      // so ordinary play chasing a scattered monster across one room would
      // trip the exact same "snaps back mid-fight" symptom Fear's own
      // exemption above describes.
      // And for both farm zones, for exactly that reason — they were simply
      // missed when Fear and Coop got theirs. Фарм-зона's rooms are 16 tiles
      // (640px), the same size as Coop's; Элитная фарм-зона's are 30 tiles
      // (1200px), nearly three times this radius, and its monsters move at
      // FARM2_SPD_MULT (2x) in packs of 4 that wake together. Fighting one
      // pack across its own room is ordinary play there and routinely ends up
      // more than 420px from where the pack spawned — at which point every
      // monster in it healed to full and teleported back to its spawn tile
      // mid-fight, which from the player's side is the damage they had just
      // done being undone and the pack vanishing out of the fight. Both zones
      // are sealed floors with nowhere to drag anything to, so the de-aggro
      // leash above (aggroR * 2.2, which still applies) is the only leash
      // either one needs — same reasoning as Fear's and Coop's exemptions.
      const ldx = e.x - e.spawnX, ldy = e.y - e.spawnY;
      if (!e.ignoresSafeZone && e.arm !== 'fear' && e.arm !== 'coop' &&
          !e.farmZone && !e.farmZone2 && ldx * ldx + ldy * ldy > LEASH_R2) {
        e.hp = e.maxHp;
        e.x = e.spawnX; e.y = e.spawnY;
        e.aggro = false;
        e._shp = -1;
      }
    });

    // Drop a defeated event boss out of the world for good. Deferred to here
    // because splicing this.enemies inside the forEach above would skip an
    // element.
    if (this._evtPurge) {
      this._evtPurge = false;
      this.enemies = this.enemies.filter(e => {
        if (!e._evtRemove) return true;
        this._enemyMap.delete(e.id);
        this._forgetEnemy(e.id);
        this._releaseIdx(e);
        return false;
      });
    }

    // Expire ground loot nobody picked up in time.
    if (this.worldDrops.size) {
      const expired = [];
      this.worldDrops.forEach(d => { if (d.expiresAt <= now) expired.push(d.id); });
      if (expired.length) {
        expired.forEach(id => this.worldDrops.delete(id));
        this.io.to(`floor_${this.floor}`).emit('worldDropsExpired', { ids: expired });
      }
    }

    // Per-player emit: AOI filter + delta (reuse buffers — emit serializes synchronously).
    // Bandwidth protocol:
    //  - players are broadcast every OTHER tick (20Hz; client interpolates)
    //  - static fields (username/type/maxHp/pvpMode) go out only on first
    //    sight, on profile change (_profileRev), or on periodic refresh;
    //    otherwise a slim {id,x,y,facing,hp,atkSeq} entry is sent
    //  - at most PLAYER_CAP nearest players per packet
    //  - enemies ride the same every-other-tick cast as players, as a
    //    change-delta within ENEMY_AOI_R; static fields (name/color/size/…)
    //    go only on that player's first sight of them
    const castId = ++this._tickNo;
    const castPlayers = (castId & 1) === 0;
    const cand = this._candBuf;

    // Nothing to send on the off ticks — the AI above still runs at the full
    // 40Hz, this just halves how often the result is cast out. Clients
    // interpolate enemy positions toward the last one received (see the
    // exponential pull in js/game.js), and the feedback that has to feel
    // instant — your own hits — rides its own enemyHurt event rather than
    // this stream, so 20Hz here is indistinguishable in play while halving
    // both the packet count and the per-player collect/encode cost.
    if (!castPlayers) return;

    // Bucket every alive enemy into the spatial grid once per cast, so the
    // per-player interest query below only walks the handful of cells around
    // that player instead of all ~4500 enemies (which at 200 players would be
    // ~900k distance checks every 25ms).
    this._rebuildEnemyGrid();
    // The player grid was already rebuilt at the top of this tick for the AI
    // target search, and nothing has moved players since — reuse it.

    this.players.forEach(p => {
      nearPlayers.length = 0;
      cand.length = 0;
      // Same 3x3-cell interest query the enemies use, for the same reason —
      // see PLAYER_GRID_CELL.
      //
      // Only the PLAYER_CAP nearest survive, and they are selected as we go
      // rather than collected and sorted afterwards. The old version pushed
      // every candidate into an array and ran Array.sort on the lot: in a
      // crowded hub a single 600px radius holds well over a hundred other
      // players, so that was a ~150-element comparator sort per player per
      // cast. Profiling a 300-player room measured it at 58% of the entire
      // tick — comfortably the largest single cost in the whole loop, larger
      // than the enemy AI and the packet encoding put together.
      //
      // Bounded insertion instead: `cand` is kept sorted ascending by d2 and
      // never grows past the cap, so once it is full the common case is a
      // single compare against the current worst and a skip. Slots come from a
      // pool, so this allocates nothing at all.
      const pgrid = this._playerGrid;
      const pcx0 = Math.floor((p.x - PLAYER_GRID_CELL) / PLAYER_GRID_CELL);
      const pcx1 = Math.floor((p.x + PLAYER_GRID_CELL) / PLAYER_GRID_CELL);
      const pcy0 = Math.floor((p.y - PLAYER_GRID_CELL) / PLAYER_GRID_CELL);
      const pcy1 = Math.floor((p.y + PLAYER_GRID_CELL) / PLAYER_GRID_CELL);
      let nCand = 0;
      // The instance a player is standing in, if any — everyone streamed to
      // them has to be in the same one. Distance cannot separate instances
      // on its own: Fear halls sit one lane pitch (800px) apart and are
      // 480px wide, so two players hugging opposite sides of the same shared
      // wall are only ~320px from each other, well inside PLAYER_AOI_R.
      // Without this they rendered through the wall and — the actual
      // complaint — the target/assist button happily cycled onto whoever was
      // running the hall next door. Same two-way rule _raceVisible applies
      // to enemies.
      //
      // race10 racers are the one deliberate exception: they're allowed to
      // see every other racer regardless of which lane either is in — it's a
      // 10-player race, and running it in total isolation from the other 9
      // read as broken rather than intentional. What still isn't allowed is
      // *acting* on a racer in another lane (party invite, profile lookup —
      // see partyInvite/requestPlayerProfile, server/index.js), which enforce
      // exact lane equality themselves. Fear keeps the strict same-key rule:
      // every hall is a private, single-occupant room, so there's never
      // anyone legitimate on the other side of one to see in the first place.
      const pLane = this._playerLaneKey(p);
      const pIsRacer = p._raceLane != null;
      for (let pcx = pcx0; pcx <= pcx1; pcx++) {
        for (let pcy = pcy0; pcy <= pcy1; pcy++) {
          const cell = pgrid.get(_gridKey(pcx, pcy));
          if (!cell) continue;
          for (let ci = 0; ci < cell.length; ci++) {
            const op = cell[ci];
            if (op.socketId === p.socketId) continue;
            if (!(pIsRacer && op._raceLane != null) && this._playerLaneKey(op) !== pLane) continue;
            const dx = op.x - p.x, dy = op.y - p.y;
            const d2 = dx * dx + dy * dy;
            if (d2 > PLAYER_AOI_R2) continue;
            // Full, and no closer than the furthest one we're keeping — the
            // branch that takes almost every candidate in a busy hub.
            if (nCand === PLAYER_CAP && d2 >= cand[PLAYER_CAP - 1].d2) continue;
            let slot;
            if (nCand < PLAYER_CAP) {
              // Pool slots are claimed by index 0..nCand-1, so this index has
              // not been handed out yet in this player's pass, wherever the
              // insertion below ends up moving the earlier ones to.
              slot = this._candPool[nCand];
              if (!slot) { slot = { op: null, d2: 0 }; this._candPool[nCand] = slot; }
              cand[nCand] = slot;
              nCand++;
            } else {
              slot = cand[PLAYER_CAP - 1]; // evict the current worst, reuse its slot
            }
            slot.op = op; slot.d2 = d2;
            let j = nCand - 1;
            while (j > 0 && cand[j - 1].d2 > d2) { cand[j] = cand[j - 1]; j--; }
            cand[j] = slot;
          }
        }
      }
      cand.length = nCand;
      for (let i = 0; i < cand.length; i++) {
        const op = cand[i].op;
        const k = p._known.get(op.socketId);
        const full = !k || k.rev !== op._profileRev || k.seen !== castId - 2 ||
          ((castId >> 1) + op._seq) % FULL_REFRESH_TICKS === 0;
        if (full) {
          nearPlayers.push({
            id: op.socketId, seq: op._seq, username: op.username, type: op.type,
            x: op.x, y: op.y, facing: op.facing, hp: op.hp, maxHp: op.maxHp,
            pvpMode: op.pvpMode || false, atkSeq: op.lastAtkSeq || 0, moving: !!op.moving,
            clanName: op.clanName || null, clanIcon: op.clanIcon || null,
            // For the client's own target/assist filtering — see the pIsRacer
            // exception above. null for anyone not currently racing; _raceLane
            // itself already bumps _profileRev on change (raceDeploy/
            // deathBattleReturn), so `full` picks up a lane change immediately
            // rather than waiting for the periodic refresh.
            raceLane: op._raceLane != null ? op._raceLane : null,
          });
        } else {
          nearPlayers.push({
            id: op.socketId, seq: op._seq, x: op.x, y: op.y, facing: op.facing,
            hp: op.hp, atkSeq: op.lastAtkSeq || 0, moving: !!op.moving,
          });
        }
        if (k) { k.rev = op._profileRev; k.seen = castId; }
        else p._known.set(op.socketId, { rev: op._profileRev, seen: castId });
      }
      const playersOut = nearPlayers;

      // Enemies are now picked per player (only what's near them), so unlike
      // the players segment there's nothing shared to reuse between
      // recipients — hence the undefined gen, which tells encodeGameState to
      // skip its cross-recipient byte cache. That cache existed because this
      // list used to be identical for everyone and re-encoding ~1300 entries
      // per player blew the tick budget; the AOI list is ~6x smaller, so
      // encoding it per player is cheaper than the old shared encode was.
      this._collectEnemiesFor(p, nearEnemies, castId);

      // t: server tick timestamp — the client uses real tick spacing (setInterval
      // drifts 45-60ms) to time snapshot playback at true velocity.
      // Payload is a binary ArrayBuffer — see shared/netcodec.js
      //
      // Sent straight down the socket rather than via io.to(id): the room
      // form builds a BroadcastOperator plus a rooms Set and goes through the
      // adapter on every call, which at 20 casts/s × every player is pure
      // overhead for what is always a single known recipient.
      //
      // ...and *volatile*, which is the fix for the stalls this stream causes
      // on a flaky mobile link. A plain emit to a socket whose send buffer is
      // backed up (radio asleep, tunnel hiccup, the Telegram WebView
      // backgrounded) queues the packet; at 20 packets/s a few seconds of
      // that is a queue the client then receives as one flood of stale world
      // states, which is exactly what "иногда тупит" looks like from the
      // inside. Volatile drops those instead, and dropping is safe here
      // precisely because this stream is self-healing: enemies a client ends
      // up missing are re-sent in full by ENEMY_REFRESH_CASTS or pulled back
      // on demand by its own enemyResync, and players by FULL_REFRESH_TICKS.
      // Nothing to say to this player: nobody in range, no enemy moved or
      // changed inside their radius. That is the steady state for anyone
      // playing alone in a corridor, standing in the hub with the market
      // open, or idling in a menu — and it used to cost a packet anyway, 20
      // times a second, forever. Each one is TWO WebSocket frames (socket.io
      // sends a JSON envelope plus the binary attachment) of which ~79% of
      // the bytes are the envelope, and one writev syscall — measured as the
      // single largest entry in the server's CPU profile.
      //
      // One empty packet still has to go out after a non-empty one: the
      // client prunes players it stops hearing about (see the gameState
      // handler in js/network.js), so going silent immediately would freeze
      // whoever just walked out of range on their screen. After that, silence
      // until something happens — with a heartbeat every IDLE_HEARTBEAT_CASTS
      // so the clock-offset EMA keeps tracking.
      const projQ = p._projQ, aoeQ = p._aoeQ;
      const empty = playersOut.length === 0 && nearEnemies.length === 0 &&
        projQ.length === 0 && aoeQ.length === 0;
      if (empty && p._lastSentEmpty && (castId - p._lastSentAt) < IDLE_HEARTBEAT_CASTS * 2) return;
      p._lastSentEmpty = empty;
      p._lastSentAt = castId;
      // Age is stamped now, not when queued, so it measures the real wait.
      // Written in place: every recipient's cast runs inside this same tick,
      // so the value is identical for all of them and the entry can stay one
      // shared object rather than a copy per player.
      for (let i = 0; i < projQ.length; i++) projQ[i].ageMs = now - projQ[i].at;
      const sock = this._socketFor(p);
      if (sock) sock.volatile.emit('gameState',
        encodeGameState(playersOut, nearEnemies, now, undefined, projQ, aoeQ));
      projQ.length = 0;
      aoeQ.length = 0;
    });

    // Coarse dot feed for the full-map panel (the КАРТА tab), which draws the
    // player's whole current arm — far more than the AOI stream above covers.
    // Only goes to players who actually have that panel open, and only at
    // MAP_BLIP_EVERY, because it's the one thing here that is still
    // proportional to the whole world's enemy count.
    if (castId % MAP_BLIP_EVERY === 0) this._broadcastMapBlips();

    // Update delta markers after all per-player emits
    this.enemies.forEach(e => {
      if (e.hp > 0) { e._sx = e.x; e._sy = e.y; e._shp = e.hp; e._atkPulse = false; }
    });
  }

  // Buckets alive non-boss enemies by ENEMY_GRID_CELL-sized cell. Cell arrays
  // are emptied and refilled rather than reallocated — this runs 40x a second
  // over several thousand enemies, and churning that many arrays showed up as
  // GC pressure. Bosses are collected separately: they're never AOI-culled,
  // so they don't belong in a spatial lookup at all.
  _rebuildEnemyGrid() {
    const grid = this._enemyGrid;
    grid.forEach(arr => { arr.length = 0; });
    this._bossBuf.length = 0;
    const armPresent = this._armPresent;
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (e.hp <= 0) continue;
      if (e.isBoss) { this._bossBuf.push(e); continue; }
      // Same empty-arm skip as the AI loop above: nobody in that arm could
      // possibly have it inside their AOI query, so indexing it here would
      // be pure waste.
      if (this._armBounds && this._armBounds[e.arm] && !armPresent.has(e.arm)) continue;
      const key = _gridKey(Math.floor(e.x / ENEMY_GRID_CELL), Math.floor(e.y / ENEMY_GRID_CELL));
      let cell = grid.get(key);
      if (!cell) { cell = []; grid.set(key, cell); }
      cell.push(e);
    }
  }

  // The closest player this enemy is allowed to chase, or null if there isn't
  // one worth considering. `sz` is false only for the event boss, which alone
  // may target players standing in the hub.
  //
  // This was a linear scan of every alive player, run per enemy — and with
  // AI_TARGET_SEARCH_EVERY = 4 at 40 ticks/s that is ten full player sweeps
  // per enemy per second. Across ~4500 enemies and a few hundred players it
  // works out to eight figures of distance checks a second, and it was by far
  // the largest single cost in the loop: profiling a 300-player room put the
  // AI at ~15ms of a 25ms budget, essentially all of it here, and it grew
  // strictly linearly with the player count. It is also the only part of the
  // tick that got slower purely because the game got more popular.
  //
  // Bounding the search is behaviour-preserving, not an approximation. A
  // target further than aggroR * 2.2 is already discarded by the de-aggro
  // rule immediately below the call site, which takes the same branch as
  // "no target at all" — so anything outside that radius could never have
  // survived the search anyway, and refusing to look at it costs nothing.
  _closestTargetFor(e, sz) {
    // The de-aggro threshold, plus a cell of slack. The floor matters for
    // enemies with a tiny (or zero) aggro radius, which would otherwise never
    // see anyone even standing on top of them.
    const R = Math.max((e.aggroR || 0) * 2.2, 300);
    const R2 = R * R;
    const grid = this._playerGrid;
    const cx0 = Math.floor((e.x - R) / PLAYER_GRID_CELL);
    const cx1 = Math.floor((e.x + R) / PLAYER_GRID_CELL);
    const cy0 = Math.floor((e.y - R) / PLAYER_GRID_CELL);
    const cy1 = Math.floor((e.y + R) / PLAYER_GRID_CELL);
    let closest = null, bestD2 = R2;
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const cell = grid.get(_gridKey(cx, cy));
        if (!cell) continue;
        for (let i = 0; i < cell.length; i++) {
          const p = cell[i];
          // The grid holds every player in the room, so the alive/eligible
          // filtering the old alivePlayers scan did up front happens here.
          if (p.hp <= 0 || !p.type) continue;
          if (sz && this._inSafeZone(p.x, p.y)) continue;
          if (p._invis) continue;
          // Corridor monsters only ever see their own runner; world monsters
          // never see anyone inside the tower — see _raceVisible.
          if (!this._raceVisible(p, e)) continue;
          const dx = p.x - e.x, dy = p.y - e.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < bestD2) { bestD2 = d2; closest = p; }
        }
      }
    }
    return closest;
  }

  // Элитная фарм-зона: packs of FARM2_PACK_SIZE monsters standing together
  // (see generateFarmZone2, server/game/dungeon.js) never self-pull — hitting
  // ANY one of them wakes the whole pack, not just the one actually hit.
  // packMateIds is the pack's OTHER members' ids, baked in at spawn time, so
  // this is a handful of direct _enemyMap lookups rather than a scan of
  // every enemy on the floor. Called right after the hit enemy's own
  // `aggro = true` (attackEnemy/skillAttackEnemy) — a pack-mate simply
  // getting `aggro = true` here is enough on its own: the tick loop's own
  // target search (_closestTargetFor) picks up the attacker the very next
  // tick since a freshly-aggroed enemy has no cached target yet.
  _wakePack(enemy) {
    if (!enemy.packMateIds || !enemy.packMateIds.length) return;
    for (const id of enemy.packMateIds) {
      const mate = this._enemyMap.get(id);
      if (mate && mate.hp > 0) mate.aggro = true;
    }
  }

  // Player equivalent of _rebuildEnemyGrid — same empty-and-refill discipline
  // so a busy hub doesn't churn one array per occupied cell per cast.
  _rebuildPlayerGrid() {
    const grid = this._playerGrid;
    grid.forEach(arr => { arr.length = 0; });
    this.players.forEach(p => {
      const key = _gridKey(Math.floor(p.x / PLAYER_GRID_CELL), Math.floor(p.y / PLAYER_GRID_CELL));
      let cell = grid.get(key);
      if (!cell) { cell = []; grid.set(key, cell); }
      cell.push(p);
    });
  }

  // The live Socket for a player, memoised on the player record. Looked up
  // lazily rather than stored at addPlayer time so a socket that reconnects
  // under the same entry can't leave a dead reference behind, and dropped
  // again the moment it stops being connected.
  _socketFor(p) {
    const s = p._socket;
    if (s && s.connected) return s;
    const fresh = this.io.sockets.sockets.get(p.socketId) || null;
    p._socket = fresh;
    return fresh;
  }

  // socketIds of everyone close enough to (x, y) to actually see something
  // happen there, minus `exceptSocketId`. For visual-only combat fan-out:
  // projectiles, AOE rings and the crowd-control flash used to go to the whole
  // floor, and the world is a single floor — so one archer's auto-attack cost
  // one packet per player online, and the total cost of the feature grew as
  // the square of the population. Measured at 150 players firing twice a
  // second it was 37% of a CPU core on its own, more than the entire world
  // simulation. The same spatial index the broadcast already maintains answers
  // "who could possibly see this" in a couple of cell lookups.
  //
  // `lane` is the caster's _playerLaneKey(): corridors in the tower sit 200px
  // apart, well inside the radius, so without it a runner would see arrows
  // flying through the wall from the next lane over (Fear lanes are isolated
  // the same way, just via _fearLane instead). Same two-way rule as
  // everything else — see _raceVisible.
  //
  // The result buffer is reused, so callers must consume it before calling
  // again.
  nearbyPlayerIds(x, y, exceptSocketId, lane) {
    const out = this._viewerBuf;
    out.length = 0;
    const grid = this._playerGrid;
    // Cell range from the RADIUS, not the cell size: the fan-out radius is
    // wider than one cell, so a ±1 cell walk would silently miss everyone in
    // the outer ring.
    const R = VISUAL_FANOUT_R;
    const cx0 = Math.floor((x - R) / PLAYER_GRID_CELL);
    const cx1 = Math.floor((x + R) / PLAYER_GRID_CELL);
    const cy0 = Math.floor((y - R) / PLAYER_GRID_CELL);
    const cy1 = Math.floor((y + R) / PLAYER_GRID_CELL);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const cell = grid.get(_gridKey(cx, cy));
        if (!cell) continue;
        for (let i = 0; i < cell.length; i++) {
          const p = cell[i];
          if (p.socketId === exceptSocketId) continue;
          if (this._playerLaneKey(p) !== (lane ?? null)) continue;
          const dx = p.x - x, dy = p.y - y;
          if (dx * dx + dy * dy > VISUAL_FANOUT_R2) continue;
          out.push(p.socketId);
        }
      }
    }
    // A packed hub puts everyone inside the radius, which is precisely the
    // situation the radius was meant to bound — so cap the fan-out as well.
    // The cap is above PLAYER_CAP: a client is only ever streamed its 20
    // nearest players, so a projectile from someone outside that set already
    // has no visible owner on their screen. Which slice is dropped rotates per
    // call, so the same players aren't systematically the ones missing out.
    if (out.length > VISUAL_FANOUT_CAP) {
      const win = this._fanoutWin;
      win.length = 0;
      const start = this._fanoutRot++ % out.length;
      for (let i = 0; i < VISUAL_FANOUT_CAP; i++) win.push(out[(start + i) % out.length]);
      return win;
    }
    return out;
  }

  // The lane a player is currently deployed into, or null — lets server/
  // index.js scope a visual fan-out without reaching into player records.
  laneOf(socketId) {
    const p = this.players.get(socketId);
    return p ? this._playerLaneKey(p) : null;
  }

  // ── Combat visuals ────────────────────────────────────────────────────────
  // A projectile or AOE ring is dropped into the queue of every player near
  // enough to see it, and rides out with their next world cast (at most 50ms
  // later, and the entry carries its own age so the receiver can catch it up).
  //
  // This replaces a socket.io event per recipient per shot. The packet was the
  // expensive part, not the data: ~133 bytes of JSON in its own frame, 40 of
  // them a second for a player standing in a fight, which came to 28% of
  // everything they downloaded. In the cast it is 19 bytes and no packet at
  // all.
  queueProjectile(fromSocketId, proj) {
    const from = this.players.get(fromSocketId);
    if (!from) return;
    const ids = this.nearbyPlayerIds(proj.x, proj.y, fromSocketId, this._playerLaneKey(from));
    if (!ids.length) return;
    const entry = { ...proj, at: Date.now() };
    for (let i = 0; i < ids.length; i++) {
      const p = this.players.get(ids[i]);
      if (!p) continue;
      // Bounded: a cast drains the queue every 50ms, so this only ever holds
      // one interval's worth. The cap is there for the case a client's casts
      // are being dropped (volatile) while shots keep arriving.
      if (p._projQ.length >= VISUAL_QUEUE_MAX) continue;
      p._projQ.push(entry);
    }
  }

  queueAoe(fromSocketId, aoe) {
    const from = this.players.get(fromSocketId);
    if (!from) return;
    const ids = this.nearbyPlayerIds(aoe.x, aoe.y, fromSocketId, this._playerLaneKey(from));
    for (let i = 0; i < ids.length; i++) {
      const p = this.players.get(ids[i]);
      if (!p || p._aoeQ.length >= VISUAL_QUEUE_MAX) continue;
      p._aoeQ.push(aoe);
    }
  }

  // socketIds of everyone who currently has this enemy streamed to them, i.e.
  // everyone who can actually see it on screen. Combat events (enemyHurt /
  // enemyKilled) used to go to the whole floor on every single swing, so the
  // cost of one player hitting one monster scaled with the total number of
  // players online — hundreds of packets describing an enemy almost none of
  // the recipients had ever been told about. The result buffer is reused, so
  // callers must consume it before the next call.
  viewersOfEnemy(enemyId, exceptSocketId) {
    const out = this._viewerBuf;
    out.length = 0;
    this.players.forEach(p => {
      if (p.socketId === exceptSocketId) return;
      if (!p._eKnown.has(enemyId)) return;
      out.push(p.socketId);
    });
    return out;
  }

  // Fills `out` with what this one player needs to hear about this tick:
  // every boss, plus non-boss enemies within ENEMY_AOI_R. Each entry is
  // either a full record (first time THIS player is being told about it) or
  // a slim positional delta.
  //
  // The "have they already got this" bookkeeping is per player (p._eKnown)
  // rather than the room-wide tracker this used to share, because with an
  // interest radius two players no longer receive the same thing: an enemy
  // that's been streaming to someone standing next to it is brand new to
  // someone who just walked into range, and must be sent in full or their
  // client has no id/name/sprite to attach the delta to.
  _collectEnemiesFor(p, out, castId) {
    out.length = 0;
    const known = p._eKnown;

    // Bosses go to everyone regardless of distance, which needs the same
    // two-way filter as everything else: the tower's boss only to its
    // entrants, and the world's arm bosses to everyone EXCEPT them — someone
    // running a corridor has no use for a boss on the far side of the map, and
    // it only clutters their target list.
    for (let i = 0; i < this._bossBuf.length; i++) {
      const b = this._bossBuf[i];
      if (!this._raceVisible(p, b)) continue;
      this._pushEnemyEntry(b, known, out, castId);
    }

    const grid = this._enemyGrid;
    const cx0 = Math.floor((p.x - ENEMY_AOI_R) / ENEMY_GRID_CELL);
    const cx1 = Math.floor((p.x + ENEMY_AOI_R) / ENEMY_GRID_CELL);
    const cy0 = Math.floor((p.y - ENEMY_AOI_R) / ENEMY_GRID_CELL);
    const cy1 = Math.floor((p.y + ENEMY_AOI_R) / ENEMY_GRID_CELL);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const cell = grid.get(_gridKey(cx, cy));
        if (!cell) continue;
        for (let i = 0; i < cell.length; i++) {
          const e = cell[i];
          const dx = e.x - p.x, dy = e.y - p.y;
          if (dx * dx + dy * dy > ENEMY_AOI_R2) continue;
          // The corridor next door is well inside the AOI radius. Filtering
          // here is what stops the client ever seeing — and so auto-targeting
          // — a monster it cannot reach.
          if (!this._raceVisible(p, e)) continue;
          this._pushEnemyEntry(e, known, out, castId);
        }
      }
    }

    // Forget enemies this player has walked away from. Everything still in
    // range had its `seen` refreshed by the loops above, so anything left
    // behind is out of range; EKNOWN_FORGET_CASTS of slack keeps an enemy
    // hovering right on the boundary from being dropped and re-sent in full
    // every other cast.
    //
    // This has to stay strictly *quicker* to forget than the client is to
    // prune (ENEMY_AOI_R + 600, js/network.js): the server forgetting early
    // only costs one redundant full record, whereas the reverse — the server
    // still believing a player has an enemy their client already dropped —
    // sends a positional delta for something they can't apply it to, and the
    // enemy silently goes missing for them.
    known.forEach((k, id) => { if (castId - k.seen >= EKNOWN_FORGET_CASTS) known.delete(id); });
  }

  _pushEnemyEntry(e, known, out, castId) {
    const k = known.get(e.id);
    // castId advances two per cast (casts run every other tick), so halve it
    // before the stagger — on the raw value an enemy with an odd _idx would
    // never satisfy the modulo and would never be refreshed at all.
    const stale = ((castId >> 1) + (e._idx || 0)) % ENEMY_REFRESH_CASTS === 0;
    // `!k.full` is the arrival case: the player has this enemy from the JSON
    // snapshot but their decoder has never seen its handle. A delta now would
    // be dropped on the floor. See enemySnapshot.
    if (!k || !k.full || stale) {
      out.push(_fullEnemyEntry(e));
      known.set(e.id, { x: e.x, y: e.y, hp: e.hp, aggro: e.aggro, seen: castId, sent: castId, full: true });
      return;
    }
    k.seen = castId;
    // An aggro'd enemy is re-sent every cast even when it hasn't actually
    // moved. That looks wasteful, but the client runs its own copy of the
    // chase AI between packets (js/game.js) and its aggro test is a plain
    // distance check with no line-of-sight and no safe-zone rule — so it
    // will happily push an enemy the server is deliberately holding still.
    // The stream of authoritative positions is what keeps that prediction
    // reconciled; without it the client walks the enemy forward, the
    // correction snaps it back, and it jogs on the spot with its run
    // animation stuck on. Only enemies actually chasing someone within this
    // player's radius pay for it, which is a small fraction of the world.
    //
    // Everything else is compared against what was last sent to THIS player,
    // which also covers the cases the old code needed an explicit _shp = -1
    // poke for (leash teleport, respawn): those move the enemy or change its
    // hp, so they fall out of this same check.
    // ...unless nothing has actually been SENT about this enemy for a while.
    // See ENEMY_RESTATE_TICKS: what this guards is the one-shot transition
    // whose only packet was dropped.
    const mute = castId - (k.sent || 0) < ENEMY_RESTATE_TICKS + ((e._idx || 0) % 20) * 2;
    if (mute && !e.aggro && !e._atkPulse && e.hp === k.hp && e.aggro === k.aggro &&
        Math.abs(e.x - k.x) <= 0.5 && Math.abs(e.y - k.y) <= 0.5) return;
    out.push({
      id: e.id, idx: e._idx, x: e.x, y: e.y, hp: e.hp, aggro: e.aggro,
      atkAnimTimer: e._atkPulse ? e.atkAnimTimer : 0,
    });
    k.x = e.x; k.y = e.y; k.hp = e.hp; k.aggro = e.aggro; k.sent = castId;
  }

  // Every alive non-boss enemy as a flat Int16 tile-coordinate pair list.
  // ~4500 enemies is ~18KB, which is why only players with the map panel
  // actually open get it, at MAP_BLIP_EVERY. Bosses are left out: they're in
  // the normal stream from anywhere, so the panel's skull markers already
  // have them.
  _broadcastMapBlips() {
    let any = false;
    this.players.forEach(p => { if (p._mapOpen) any = true; });
    if (!any) return;
    // Built per arm, and only for the arms someone is actually looking at.
    // The panel draws the viewer's own arm, so the other three were never
    // going to be rendered — and the tower's 3600 corridor monsters were
    // being sent to everyone even though _raceVisible forbids showing them
    // outside a race. That was ~7100 dots (14KB) a second per viewer where
    // ~900 (3.6KB) is the whole truth.
    // Keyed by arm, and inside the tower by lane as well: a runner may only
    // ever see their own corridor (see _raceVisible), so sending them all
    // RACE10_LANES corridors at once would be both wrong and the single
    // biggest packet in the game.
    const cache = new Map();
    const _laned = arm => arm === 'race10' || arm === 'fear' || arm === 'coop';
    const bufFor = (arm, lane) => {
      const key = _laned(arm) ? `${arm}#${lane}` : arm;
      let b = cache.get(key);
      if (b !== undefined) return b;
      const want = e => e.hp > 0 && !e.isBoss && e.arm === arm &&
        (!_laned(arm) || e.lane == null || e.lane === lane);
      let n = 0;
      for (let i = 0; i < this.enemies.length; i++) if (want(this.enemies[i])) n++;
      const buf = new Int16Array(n * 2);
      let o = 0;
      for (let i = 0; i < this.enemies.length; i++) {
        const e = this.enemies[i];
        if (!want(e)) continue;
        buf[o++] = Math.round(e.x / TILE);
        buf[o++] = Math.round(e.y / TILE);
      }
      cache.set(key, buf.buffer);
      return buf.buffer;
    };
    this.players.forEach(p => {
      if (!p._mapOpen) return;
      // A floor's regular (non-race10/fear) enemies all belong to the same
      // single arm now that each arm is its own floor/Room (or to none, on
      // the hub floor) — no more Y-band lookup needed to tell which arm a
      // viewer is standing in, see this._soleArm in the constructor.
      const arm = p._raceLane != null ? 'race10' : (p._fearLane != null ? 'fear' : (p._coopLane != null ? 'coop' : this._soleArm));
      // In the hub (or anywhere outside an arm) there are no regular monsters
      // to plot, so there is nothing to send at all.
      if (!arm) return;
      // Volatile for the same reason gameState is: a dot dump is the last
      // thing that should be queuing up behind a stalled client, and the next
      // one is a second away regardless.
      const sock = this._socketFor(p);
      const lane = arm === 'fear' ? p._fearLane : arm === 'coop' ? p._coopLane : p._raceLane;
      if (sock) sock.volatile.emit('mapBlips', bufFor(arm, lane));
    });
  }

  setMapOpen(socketId, open) {
    const p = this.players.get(socketId);
    if (p) p._mapOpen = !!open;
  }

  // Called when an enemy leaves the world for good (event boss looted, arena
  // guards despawned). Its per-player entries would be swept a second later
  // anyway once they stopped being refreshed, but dropping them here keeps
  // "known" meaning strictly "exists and I've told them about it".
  _forgetEnemy(id) {
    this.players.forEach(p => p._eKnown.delete(id));
  }

  // A free network handle for a newly spawned enemy — see the _idxNext/
  // _idxFree comment in the constructor. Reused handles are safe because a
  // spawn is always new to every player, so the first entry naming it is a
  // FULL one (_pushEnemyEntry), which re-points their idx -> id map.
  //
  // The wire field is u16, so the counter must not run past 65535; the
  // free-list is what keeps a long-lived room (Fear waves alone are 20
  // monsters per wave, 39 waves per run) from ever getting there.
  _allocIdx() {
    if (this._idxFree.length) return this._idxFree.pop();
    return this._idxNext++;
  }

  // Returns a removed enemy's handle to the pool. MUST be paired with every
  // permanent removal from this.enemies — never with a mere death, since a
  // corpse still owns its handle until it respawns or is purged.
  _releaseIdx(e) {
    if (e && e._idx != null && e._idx < 0xffff) this._idxFree.push(e._idx);
  }

  addPlayer(socketId, username, clanName, clanIcon, clanAtkBonus, telegramId, clanId) {
    // A reconnect (network blip, backgrounded tab) can occasionally leave the
    // old socket's entry in this room a moment longer than its own disconnect
    // cleanup takes to land — the new connection would then render as a
    // second, ghost copy of the same player until the stale entry's eventual
    // disconnect fires. Since every reconnect re-authenticates with the same
    // telegramId, proactively drop any existing entry for that account here
    // rather than relying solely on the old socket's own cleanup timing.
    // Returns the removed stale socketId (if any) so the caller can also
    // tell other clients to drop it immediately, instead of waiting for its
    // disconnect event.
    //
    // A stale entry still holding a Fear (Страх) lane is a special case:
    // dropping it the normal way (removePlayer releasing the hall on the
    // spot) would end the run and purge its monsters as a side effect of
    // nothing more than a network blip (Wi-Fi/LTE handover, a suspended
    // WebView — see the pingTimeout comment in server/index.js), which the
    // reconnecting player never asked for and isn't told about: their next
    // enemy snapshot just comes back empty, reading as monsters that
    // vanished mid-fight. removePlayer below doesn't release a Fear lane
    // immediately any more — it holds it open for FEAR_RECONNECT_GRACE_MS
    // (see _fearGraceStart) — and _fearGraceClaim here picks it back up for
    // this socket, whether the stale entry above was still live a moment ago
    // (same-tick race) or the real disconnect ran first and this is a
    // genuine reconnect within the window. Fear is a private, single-owner
    // room with no cross-player bookkeeping, so it's safe to simply hand the
    // same lane to the new socket — unlike race10/arena3/deathBattle, which
    // stay on the clean-eliminate path (server/index.js) since those are
    // shared/competitive instances a lone reconnect can't resume into on its
    // own.
    let staleSocketId = null;
    if (telegramId) {
      for (const [sid, p] of this.players) {
        if (sid !== socketId && p.telegramId === telegramId) { staleSocketId = sid; break; }
      }
      if (staleSocketId) this.removePlayer(staleSocketId);
    }
    const fearCarry = telegramId ? this._fearGraceClaim(telegramId, socketId) : null;
    const spawn = this._dungeon.spawn;
    const carry = fearCarry;
    this.players.set(socketId, {
      socketId, username, type: null, telegramId: telegramId || null,
      clanName: clanName || null, clanIcon: clanIcon || null, clanAtkBonus: clanAtkBonus || 0,
      clanId: clanId || null,
      x: carry ? carry.x : spawn.x, y: carry ? carry.y : spawn.y, facing: 'front', moving: false,
      hp: carry ? carry.hp : 200, maxHp: 200, atk: 5, def: 5,
      pvpMode: false, lastAtkSeq: 0,
      _raceLane: null,
      _fearLane: fearCarry ? fearCarry.lane : null,
      // Coop has no reconnect carry — a disconnect ends the run for both
      // participants on the spot (see _coopEjectOnDisconnect, server/
      // index.js), so there's never a held lane to reclaim here. Set for
      // real by coopDeploy right after this player is placed.
      _coopLane: null,
      _known: new Map(),
      // Enemies already streamed to this player: id -> last {x,y,hp,aggro}
      // sent, plus the cast it was last in range for. See _collectEnemiesFor.
      _eKnown: new Map(),
      _mapOpen: false,
      // Idle-stream bookkeeping — see the `empty` check in _tick. Starting
      // "not empty" guarantees the first cast after joining is always sent.
      _lastSentEmpty: false,
      _lastSentAt: 0,
      // Combat visuals waiting for this player's next cast — see
      // queueProjectile/queueAoe.
      _projQ: [],
      _aoeQ: [],
      // Memoised live Socket — see _socketFor.
      _socket: null,
      _profileRev: 1, _seq: ++this._pSeq,
    });
    if (this.players.size === 1) this._startLoop();
    return { spawn, staleSocketId, fearCarry };
  }

  setPlayerClan(socketId, clanName, clanIcon, clanAtkBonus, clanId) {
    const p = this.players.get(socketId);
    if (!p) return;
    p.clanName = clanName || null;
    p.clanIcon = clanIcon || null;
    p.clanAtkBonus = clanAtkBonus || 0;
    p.clanId = clanId || null;
    p._profileRev++;
  }

  setPlayerPvpMode(socketId, mode) {
    const p = this.players.get(socketId);
    if (p && p.pvpMode !== !!mode) { p.pvpMode = !!mode; p._profileRev++; }
  }

  pvpAttack(attackerSocketId, targetSocketId) {
    const attacker = this.players.get(attackerSocketId);
    const target = this.players.get(targetSocketId);
    if (!attacker || !target) return null;
    if (!attacker.pvpMode) return null;
    if (attacker.hp <= 0) return null;
    if (target.hp <= 0) return null;
    if (this._inSafeZone(attacker.x, attacker.y)) return null;
    if (this._inSafeZone(target.x, target.y)) return null;
    const dx = attacker.x - target.x, dy = attacker.y - target.y;
    if (dx * dx + dy * dy > 500 * 500) return null;
    const base = Math.max(1, attacker.atk - (target.def || 0) + Math.floor(Math.random() * 7) - 3);
    const { dmg, isCrit } = _critDmg(base, attacker.critChance, attacker.critPower);
    attacker.lastAtkSeq = (attacker.lastAtkSeq || 0) + 1;
    // Apply the damage to the authoritative server-side HP right here — the
    // target's client used to self-report "actual damage taken" afterwards
    // (pvpDamageTaken), which a modified client could always report as 0 to
    // become unkillable in PvP while still dealing full damage to others.
    target.hp = Math.max(0, target.hp - dmg);
    this._vampGain(attacker, dmg);
    return { dmg, isCrit, x: target.x, y: target.y, hp: target.hp };
  }

  // The multiplier for a cast by this player in slot `key`, derived from what
  // the server already knows about them: class, that slot's studied level, and
  // whether its advanced variant is switched on. The cast used to carry the
  // number itself and all the server could do was clamp it (x10) — a bound
  // roughly twice the best a legitimate cast can reach (x4.95), so a modified
  // client simply asked for the ceiling every time.
  //
  // p._sd is the same sanitized save the stats come from (computeStats), so
  // skillLevels/advSkillActive here are the ones the anti-cheat has already
  // bounded, and skillPct is read off the equipment rather than claimed.
  _skillMultFor(p, key) {
    const sd = p._sd || {};
    // skillPct comes off the computed stats now (setPlayerStats), where the
    // equipment that grants it has already been read out of player_items. The
    // sd.equipment walk below it is the old path and is kept only as the
    // fallback for the retired build, whose setPlayerChar does fill _sd.
    let skillPct = Number(p.skillPct) || 0;
    if (!skillPct) Object.values(sd.equipment || {}).forEach(it => { if (it && it.skillPct) skillPct += it.skillPct; });
    // Unstudied slots cast for nothing. The client refuses this outright
    // ("Навык не изучен", useSkill in js/player.js) but the server never
    // checked it at all, so a modified client had all four slots from level
    // one without spending a single book. studySkill writes level 1, so zero
    // means unstudied and nothing else.
    const levels = p._skillLevels || sd.skillLevels || {};
    const lvl = Math.max(0, Math.floor(Number(levels[key])) || 0);
    if (lvl <= 0) return 0;
    const learned = p._advLearned || sd.advSkillLearned || {};
    const active = p._advActive || sd.advSkillActive || {};
    const adv = !!(learned[key] && active[key]);
    return skillDamageMult(p.type || sd.type, key, adv, lvl, skillPct);
  }

  // May this player's basic hits splash at all?
  //
  // "Безумие" is the ADVANCED variant of the deathknight's E slot — a class,
  // a studied slot and a book, all three bought. Nothing asked for any of
  // them: the 'attack' handler read `splash: true` off the wire and the only
  // thing between a level-one mage and it was the 200ms window in
  // attackEnemy. `socket.emit('attack', { enemyId, splash: true })` was a
  // free half-damage hit for every class in the game, and — with no count
  // bound either — as many of them per swing as the socket limiter allowed.
  //
  // This cannot go through _skillMultFor: E's row in SKILL_DMG_MULT is
  // { base: null, adv: null } (both variants are ATK buffs, they deal no
  // direct damage of their own), so that function correctly returns 0 for it
  // and 0 means "refuse" everywhere else. The three sources are the same ones
  // it reads, though — the levels and flags repos/stats.js pushed down through
  // setPlayerStats, never anything the packet claims.
  //
  // What is deliberately NOT checked is whether the 5-second buff is actually
  // RUNNING. madnessTimer lives only in the client (js/state.js) and no cast
  // event for it reaches the server at all, so the server has no way to know.
  // The residue is that a deathknight who has genuinely bought and switched on
  // the skill can splash while it is off cooldown-but-not-active; that is one
  // extra half-damage hit per swing for one class, a different order of thing
  // from the ~22x multiplier any class could take before.
  _canSplash(p) {
    const sd = p._sd || {};
    if ((p.type || sd.type) !== 'deathknight') return false;
    // studySkill writes level 1, so zero means unstudied and nothing else —
    // same reading as _skillMultFor above.
    const levels = p._skillLevels || sd.skillLevels || {};
    if ((Math.floor(Number(levels.E)) || 0) <= 0) return false;
    // Learned is the one-time book spend, active is the free toggle on top of
    // it — both, exactly like _advActive() in js/player.js, so a stale toggle
    // on an unlearned slot can't stand in for the book.
    const learned = p._advLearned || sd.advSkillLearned || {};
    const active = p._advActive || sd.advSkillActive || {};
    return !!(learned.E && active.E);
  }

  pvpSkillAttack(attackerSocketId, targetSocketId, key) {
    const attacker = this.players.get(attackerSocketId);
    const target = this.players.get(targetSocketId);
    if (!attacker || !target) return null;
    if (!attacker.pvpMode) return null;
    if (attacker.hp <= 0) return null;
    // Same server-side floor as skillAttackEnemy — and it matters more here:
    // this handler doesn't go through the attack limiter in server/index.js at
    // all, so it sat in the 300 events/s bucket. See SKILL_BURST_MS above for why this
    // isn't a flat per-hit gate.
    const _nowCd = Date.now();
    const _castStart = attacker._lastSkillAtk || 0;
    if (_nowCd - _castStart > SKILL_BURST_MS) {
      if (_nowCd - _castStart < SKILL_CD_MS) return null;
      attacker._lastSkillAtk = _nowCd;
    }
    if (target.hp <= 0) return null;
    if (this._inSafeZone(attacker.x, attacker.y)) return null;
    if (this._inSafeZone(target.x, target.y)) return null;
    const dx = attacker.x - target.x, dy = attacker.y - target.y;
    if (dx * dx + dy * dy > 600 * 600) return null;
    // 0 means the slot's active variant deals no direct damage — a buff, a
    // heal or a pure stun. A client claiming a hit from one of those is
    // refused outright rather than falling back to a default.
    const mult = this._skillMultFor(attacker, key);
    if (!(mult > 0)) return null;
    const base = Math.max(1, Math.round(attacker.atk * mult) - (target.def || 0) + Math.floor(Math.random() * 7) - 3);
    const { dmg, isCrit } = _critDmg(base, attacker.critChance, attacker.critPower);
    attacker.lastAtkSeq = (attacker.lastAtkSeq || 0) + 1;
    target.hp = Math.max(0, target.hp - dmg);
    this._vampGain(attacker, dmg);
    return { dmg, isCrit, x: target.x, y: target.y, hp: target.hp };
  }

  removePlayer(socketId) {
    // Hold a Fear hall open before the player record goes, rather than
    // releasing it on the spot — every other exit path (death, clearing the
    // last wave) releases it through deathBattleReturn, but a player who
    // simply vanishes — a disconnect, or the stale entry addPlayer drops on
    // a reconnect — never reaches one. Un-held, that left the hall owned by
    // a socket that no longer exists with nothing left to reclaim it (the
    // eventual disconnect handler had already run this same function), so
    // halls leaked one at a time until all 8 looked occupied and nobody
    // could enter at all. See _fearGraceStart/_fearGraceClaim: a reconnect
    // within the window gets the exact hall and wave back, and only a
    // window that elapses with no reconnect turns into a real release.
    const p = this.players.get(socketId);
    if (p && p._fearLane != null) this._fearGraceStart(p);
    // Coop has no equivalent hold — a disconnect ends the run for both
    // participants immediately (_coopEjectOnDisconnect, server/index.js),
    // which releases this player's lane (and clears p._coopLane) before
    // removePlayer is ever called, so there's nothing left here to hold.
    this.players.delete(socketId);
    this.players.forEach(p2 => p2._known.delete(socketId));
    if (this.players.size === 0) this._stopLoop();
  }

  setPlayerChar(socketId, type, savedStats = null) {
    const p = this.players.get(socketId);
    if (!p) return;
    // See _charDef: `CHAR_DEF[type]` was truthy for 'constructor', '__proto__'
    // and every other Object.prototype key, and the NaN stats that came back
    // made the sender immortal and everything they hit unkillable.
    const cd = _charDef(type);
    if (!cd) return;
    // Computed BEFORE anything is written. computeStats reads baseAtk/baseDef/
    // baseMaxHp, upgrades and equipment straight out of the save blob, so it
    // has its own routes to a non-finite result that have nothing to do with
    // the class lookup above — and a half-applied class (type switched, stats
    // refused) would be a worse state to leave a player in than either.
    const s = savedStats ? computeStats(savedStats, cd, type, p.clanAtkBonus) : null;
    if (s && !_statsFinite(s, p.username || socketId, `setPlayerChar(${type})`)) return;
    p.type = type;
    p.pvpMode = false;
    p._profileRev++;
    if (s) {
      p.atk        = s.atk;
      p.def        = s.def;
      p.maxHp      = s.maxHp;
      p.critChance = s.critChance;
      p.critPower  = s.critPower;
      // hp === 0 is meaningful (the player died) and must not be confused with
      // "no hp in this save" — a truthy check treated 0 as missing data and
      // handed back a full heal, so anyone who reconnected (a backgrounded
      // tab getting suspended mid-session, a network blip) while dead, or
      // logged back in having quit during the death screen, resumed at full
      // HP with no death ever recorded.
      //
      // isFinite rather than `!= null` for the OTHER half of that: 0 still
      // passes (it is a number, and the paragraph above is why that matters),
      // but a NaN in the saved hp used to survive Math.min/Math.max untouched
      // and land in the record as the player's current health — immortality by
      // the same absorbing-NaN route _statsFinite exists to close, arriving
      // through the save blob instead of through the class table.
      p.hp    = Number.isFinite(savedStats.hp) ? Math.max(0, Math.min(savedStats.hp, p.maxHp)) : p.maxHp;
      p.lvl   = savedStats.lvl || 1;
      // Kept fresh via updatePlayerSavedData() (called on every saveProgress)
      // so statsUpdate can always re-derive a true base from up-to-date
      // equipment/upgrades instead of trusting the client's own numbers.
      p._sd = savedStats;
      p.petId = _petIdOf(savedStats);
    } else {
      p.hp = p.maxHp = cd.baseHP;
      p.atk = cd.baseAtk;
      p.def = cd.baseDef;
      p._sd = {};
      p.petId = null;
    }
  }

  // Called on every saveProgress — keeps p._sd (the basis for statsUpdate's
  // true-base recomputation) in sync with the player's actual equipment/
  // upgrades/level without waiting for the next character (re)selection.
  // Returns true when the equipped pet changed, so the caller knows to tell
  // the other clients (pets are broadcast as their own small event rather
  // than as a gameState field — see the playerPet handler in server/index.js).
  updatePlayerSavedData(socketId, sd) {
    const p = this.players.get(socketId);
    if (!p) return false;
    p._sd = sd || {};
    const petId = _petIdOf(p._sd);
    if (petId === p.petId) return false;
    p.petId = petId;
    return true;
  }

  // The pet, set directly rather than derived from a save blob. The blob is
  // gone: equipment is a set of rows now, and the session already knows which
  // one is in the 'pet' slot. Returns whether it changed, so the caller knows
  // whether the floor needs telling.
  setPlayerPet(socketId, petId) {
    const p = this.players.get(socketId);
    if (!p) return false;
    const id = petId || null;
    if (p.petId === id) return false;
    p.petId = id;
    return true;
  }

  // socketId -> equipped pet id, for everyone in the room who has one. Sent
  // to a player as they join so they see the pets that are already out,
  // instead of only ones equipped after they arrived.
  petSnapshot() {
    const out = [];
    this.players.forEach(p => { if (p.petId) out.push({ id: p.socketId, petId: p.petId }); });
    return out;
  }

  updatePlayerPos(socketId, x, y, facing, moving) {
    const p = this.players.get(socketId);
    if (!p) return;
    // A dead player's own client can keep sending playerMove (e.g. its "you
    // died" flow never ran because the tab was backgrounded for the fatal
    // hit) — without this, the server kept applying it, so the player could
    // walk and fight normally while every other client correctly rendered
    // them as dead (hp stuck at 0, since nothing ever prompted a respawn).
    //
    // Refusing the move alone left that split permanent, though: hp<=0 also
    // makes syncPlayerHp/healPlayer no-ops, and only a client-sent 'respawn'
    // clears it — which a client that never noticed it died will never send.
    // The player kept playing while everyone else saw a frozen corpse until
    // they happened to reconnect. So re-announce the death (throttled, it
    // arrives once per second at most) until their client acts on it.
    if (p.hp <= 0) {
      const now = Date.now();
      if (now - (p._deathResendAt || 0) >= 1000) {
        p._deathResendAt = now;
        this.io.to(socketId).emit('playerHurt', { id: socketId, hp: 0 });
      }
      return;
    }
    // Non-finite values are refused: Math.floor(NaN) is NaN, which drops the
    // player out of the spatial grid entirely (invisible to everyone,
    // untargetable by enemy AI) and poisons every distance comparison. This is
    // not a movement rule — it's the guard that stops one malformed packet
    // corrupting room state.
    //
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    // Movement guard. There used to be no check here at all, on purpose: a
    // per-packet distance cap is what took this down in production, because
    // the world's own teleport pads move a player tens of thousands of pixels
    // through this very function (_updateTeleportPads, js/game.js) — and so do
    // respawn, floor changes, and the arena/guild-war/farm entrances. Any
    // per-jump rule has to enumerate every one of them, and mis-fires on real
    // players the day a new one is added.
    //
    // Distance over TIME needs no such list, which is the whole reason this
    // shape is safe where that one wasn't. A teleport is one enormous jump and
    // then nothing; a speedhack is continuous. So the budget is a token
    // bucket: it refills at the fastest speed the game can legitimately
    // produce and holds at most _MOVE_BUCKET_S seconds of it. A teleport —
    // or a lag spike that coalesces several seconds of running into a single
    // packet — drains it and it refills while the player carries on, costing
    // them nothing. Only sustained travel faster than the cap drains it faster
    // than it refills, and that is the only thing this can ever flag.
    if (_MOVE_GUARD !== 'off' && !this._checkMoveBudget(socketId, p, x, y)) return;
    // ── Walkability ─────────────────────────────────────────────────────────
    // Until now the server accepted ANY finite coordinate that fit the speed
    // budget and never asked whether a player could stand there. That is the
    // "кинуло в стену" report: the client's own collision is a per-axis check
    // against the destination with no swept test, so one oversized step — a
    // lag spike, a teleport pad, a respawn landing on geometry — puts the
    // character inside a wall, and the server writes it down as fact. From
    // then on every other client renders them in the wall too, and the enemy
    // AI happily walks up to them through it.
    //
    // The grid is right here (_isWall is already used for line of sight), so
    // the check costs one array lookup. What it must NOT do is trap anyone:
    //
    //   • a player ALREADY inside a wall is allowed to move anywhere, because
    //     refusing would pin them there permanently — the exact bug, made
    //     worse. Any move out is an improvement, and the next one lands on
    //     the normal rule again.
    //   • only the centre point is tested, not the body radius. A stricter
    //     test rejects legitimate movement along a corridor wall, and a
    //     refused step that looks legal is a worse experience than the rare
    //     clipped corner it would prevent.
    //
    // Returns the last good position so the caller can correct the client
    // rather than letting the two silently disagree about where the player is.
    if (this._isWall(x, y) && !this._isWall(p.x, p.y)) {
      p._wallRefusals = (p._wallRefusals || 0) + 1;
      return { refused: 'wall', x: p.x, y: p.y };
    }
    // undefined means a client still running the pre-authoritative-flag
    // bundle (mid-rollout, tab open since before the deploy) — its 'mv'
    // packet has no 5th element at all. Leaving p.moving untouched in that
    // case sticks it at whatever it was when the connection started (false,
    // set at spawn) for as long as that tab stays open: position keeps
    // updating normally, but every other client reads a permanent 'idle'
    // for a player who is plainly running. Fall back to inferring it from
    // the position change since the last packet instead — the same idea the
    // client used to do, but on two known-good, un-buffered points 25ms
    // apart rather than through the render-side interpolation lag.
    if (moving === undefined) {
      const ddx = x - p.x, ddy = y - p.y;
      moving = (ddx * ddx + ddy * ddy) > 0.1;
    }
    p.x = x; p.y = y; p.facing = facing; p.moving = moving;
  }

  // Returns false only when the move must be refused (enforce mode, bucket
  // empty). Always does the accounting first, so 'log' mode measures exactly
  // what 'enforce' would have acted on — the point of running it in log mode
  // for a while before switching is that the two cannot disagree.
  _checkMoveBudget(socketId, p, x, y) {
    const now = Date.now();
    if (p._mvAt === undefined) {
      // First packet of the session: no elapsed time to earn budget over, so
      // start full rather than empty. Otherwise the spawn-to-first-step move
      // would be judged against a bucket that has never refilled.
      p._mvAt = now;
      p._mvBudget = _MOVE_SPEED_CAP * _MOVE_BUCKET_S;
      return true;
    }
    const elapsed = Math.max(0, (now - p._mvAt) / 1000);
    p._mvAt = now;
    p._mvBudget = Math.min(_MOVE_SPEED_CAP * _MOVE_BUCKET_S,
      (p._mvBudget || 0) + elapsed * _MOVE_SPEED_CAP);
    const dx = x - p.x, dy = y - p.y;
    const travelled = Math.sqrt(dx * dx + dy * dy);
    if (travelled <= p._mvBudget) { p._mvBudget -= travelled; return true; }
    // Overdrawn. The bucket goes to zero rather than negative: a single
    // teleport must cost one bucket, not put the player in debt for the
    // minutes it would take to pay off a 30,000px jump.
    p._mvBudget = 0;
    // Strikes decay by falling out of the window rather than being counted
    // down, so a player who overdraws once an hour never accumulates any.
    p._mvStrikes = (now - (p._mvStrikeAt || 0) <= _MOVE_STRIKE_WINDOW_MS) ? (p._mvStrikes || 0) + 1 : 1;
    p._mvStrikeAt = now;
    if (p._mvStrikes < _MOVE_STRIKES) return true;   // a teleport, or a lag burst
    const refusing = _MOVE_GUARD === 'enforce';
    // Counted BEFORE the log throttle, so the one line that does get printed
    // says how many refusals it stands for. Now that enforce is the default,
    // a refusal is the server pulling a real player backwards, and the
    // throttle means twenty-nine seconds out of every thirty of that leave no
    // trace at all — which would make the only evidence of a false positive
    // the player complaining about it. _wallRefusals, the other refusal on
    // this path, is counted the same way.
    if (refusing) p._mvRefused = (p._mvRefused || 0) + 1;
    if (now - (p._mvWarnAt || 0) >= _MOVE_LOG_EVERY_MS) {
      p._mvWarnAt = now;
      console.warn(`[move] ${p.username || socketId}: ${p._mvStrikes} overdrafts in ` +
        `${_MOVE_STRIKE_WINDOW_MS}ms, last ${Math.round(travelled)}px in ${Math.round(elapsed * 1000)}ms ` +
        `(cap ${Math.round(_MOVE_SPEED_CAP)}px/s) — ` +
        `${refusing ? `refusing (${p._mvRefused} this session)` : 'allowed, MOVE_GUARD=log'}`);
    }
    if (!refusing) return true;
    // Refusing alone would leave the client believing it is somewhere the
    // server will never agree with — it renders its own position locally and
    // gameState only carries OTHER players — so it has to be told where it
    // actually is, or a false positive strands it permanently.
    //
    // Throttled: refusals arrive at the client's own send rate (30/s — this
    // said 20/s, from the same stale figure corrected at _MOVE_STRIKES above;
    // netSendMove's own measurement is 30Hz), and answering every one of them
    // would put a steady 30 packets a second on the wire for as long as the
    // player keeps trying. Four a second re-anchors them just as fast as they
    // can act on it.
    if (now - (p._mvCorrectAt || 0) >= 250) {
      p._mvCorrectAt = now;
      this.io.to(socketId).emit('posCorrect', { x: p.x, y: p.y });
    }
    return false;
  }

  // ── пассивная регенерация HP ───────────────────────────────────────────────
  // Её не было. Совсем: hpRegen считался (compute() в repos/stats.js, строка
  // выше в этом файле), клался в p.hpRegen — и не читался больше нигде. А
  // клиент своё HP регенерировал каждый кадр (js/game.js: `player.hp +=
  // player.hpRegen * dt`).
  //
  // Значит два числа расходились ровно на всё, что игрок за сессию залечил, и
  // расходились БЕЗ ГРАНИЦЫ — час фарма 30-го уровня это несколько тысяч HP.
  // Комната — власть над уроном и над смертью, поэтому убивало по ЕЁ числу,
  // пока на экране стояло своё:
  //
  //   «многие с фулл хп падают, сервер и клиент будто неправильные цифры»
  //   «бился с 28 лвл монстрами, в один момент тупо убивают, а у него ещё
  //    оставалось 985 hp»
  //
  // Тем же самым объясняется и вторая жалоба: Session.savePosition пишет в базу
  // hp ИЗ КОМНАТЫ, поэтому вылеченное значение туда не попадало никогда —
  // «здоровье восстанавливается, затем перезаходишь и возвращается к
  // первичному показателю».
  //
  // Считает СЕРВЕР, а не принимает от клиента. Принимать — это ровно то, для
  // чего был написан syncPlayerHp ниже, и ровно поэтому у него так и не
  // появилось вызова: клиент, который сообщает своё HP, это клиент, который
  // может сообщать maxHp вечно. Формула здесь одна и та же с той, которой
  // клиент предсказывает, так что предсказание и правда совпадают по
  // построению, а sync ниже правит только дрейф.
  //
  // ── что сюда добавилось после первых суток ────────────────────────────────
  // Пассивной регенерацией дело не ограничилось. Клиент лечил себя ещё тремя
  // способами, о которых сервер не знал:
  //
  //   безопасная зона  +1 HP/сек в хабе (js/game.js). Полоса дёргалась
  //                    120 → 121 → 120: клиент прибавлял, сервер не знал,
  //                    поправка возвращала обратно. Позицию сервер видит —
  //                    значит, и правило его;
  //   «Бабочки»        5% maxHp в секунду десять секунд (продвинутый Q
  //                    чернокнижника) — таймер жил только в кадре клиента;
  //   вампиризм        доля нанесённого урона (Q Рыцаря Смерти). Урон
  //                    применяет сервер, так что считать возврат может только
  //                    он — см. _vampGain ниже.
  //
  // Все они теперь здесь. Клиент предсказывает ровно две непрерывные —
  // пассивную и зону, — потому что только у них есть общая формула на каждый
  // кадр. Разовых лечений он больше не выдумывает вовсе.
  _regenTick(p, dt, now) {
    if (p.hp <= 0 || p.hp >= p.maxHp) return;
    let rate = p.hpRegen;
    // Проверяется, а не предполагается: p.hpRegen заполняет setPlayerStats, и
    // между входом в комнату и первым его вызовом игрок уже здесь. `undefined
    // * dt` даёт NaN, а NaN в hp поглощающий — все последующие `hp <= 0`
    // ложны, и один такой тик сделал бы игрока не «нелечащимся», а бессмертным.
    // То же правило, что healPlayer записал у себя ниже.
    if (!Number.isFinite(rate) || rate < 0) rate = 0;

    // Безопасная зона. Прибавка непрерывная, как и пассивная, поэтому клиент
    // может предсказывать её тем же выражением — и предсказывает.
    if (this._inSafeZone(p.x, p.y)) rate += SAFE_ZONE_REGEN_PER_SEC;

    const before = p.hp;
    if (rate > 0) p.hp = Math.min(p.maxHp, p.hp + rate * dt);

    // «Бабочки» — не ставка в секунду, а тик РАЗ в секунду, и накопитель нужен
    // именно поэтому: комната тикает сорок раз в секунду, и размазать 5% по
    // сорока тикам значило бы лечить не то, что обещает описание навыка.
    // Граница ВКЛЮЧИТЕЛЬНАЯ. Окно ставится как cast + 10000, а тики идут на
    // +1000, +2000 ... +10000 — и последний приходится ровно на конец окна.
    // Со строгим `>` он не наступал никогда: навык, обещающий десять тиков,
    // давал девять.
    if (p._butterfliesUntil >= now) {
      // Отсчёт по ЧАСАМ, а не накоплением dt. Сорок раз в секунду прибавлять
      // 0.025 — это сорок операций с плавающей точкой, и сумма выходит
      // 0.9999999999999999: условие `>= 1` не срабатывает, и за каждые десять
      // секунд навык терял по тику. Ровно это и показала проверка — три
      // ожидаемых тика превратились в два.
      if (!p._butterAt) p._butterAt = now;
      while (now - p._butterAt >= 1000 && p.hp < p.maxHp) {
        p._butterAt += 1000;
        const tick = Math.max(1, Math.round(p.maxHp * BUTTERFLIES_TICK_PCT));
        p.hp = Math.min(p.maxHp, p.hp + tick);
        this.io.to(p.socketId).emit('skillHealTick', { amount: tick, kind: 'butterflies' });
      }
    } else if (p._butterAt) {
      p._butterAt = 0;
    }

    if (p.hp === before) return;
    // Раз в секунду — и ещё раз в тот момент, когда полоса заполнилась. Без
    // второго условия стороны замирали бы в паре очков друг от друга навсегда:
    // полное HP больше не порождает синхронизаций.
    const filled = p.hp >= p.maxHp && before < p.maxHp;
    if (!filled && now - (p._hpSyncAt || 0) < HP_SYNC_EVERY_MS) return;
    p._hpSyncAt = now;
    // ТОЧНОЕ значение, а не Math.floor. Пол здесь и был причиной дёрганья
    // 120 → 121 → 120: клиент держал 120.9, сервер присылал 120, клиент
    // прыгал вниз, за секунду дорастал до 121.4 — и обратно. Дробная часть на
    // полосе не видна, но именно она отличает поправку от рывка.
    this.io.to(p.socketId).emit('hpSync', { hp: Math.round(p.hp * 100) / 100 });
  }

  // ── вампиризм ──────────────────────────────────────────────────────────────
  // Возврат здоровья долей НАНЕСЁННОГО урона. Клиент считал его сам
  // (_applyVampirism, js/player.js) — при том, что урон применяет комната, то
  // есть единственный, кто знает настоящее число, лечения не делал.
  //
  // Окно ставит обработчик навыка (skillHeal), а не клиент: тот сообщает
  // только КАКОЙ навык нажат, и только после проверки класса и изученности.
  _vampGain(attacker, dmg) {
    if (!attacker || attacker.hp <= 0 || !(dmg > 0)) return;
    if (!(attacker._vampUntil > Date.now())) return;
    const heal = Math.max(1, Math.round(dmg * (attacker._vampPct || 0)));
    const before = attacker.hp;
    attacker.hp = Math.min(attacker.maxHp, attacker.hp + heal);
    const got = Math.round(attacker.hp - before);
    if (got > 0) this.io.to(attacker.socketId).emit('skillHealTick', { amount: got, kind: 'vampirism' });
  }

  // Окно вампиризма, «Бабочек» и ускорения. Ставится из обработчика навыка
  // ПОСЛЕ того, как сервер проверил класс, изученность и уровень — здесь
  // только запись.
  setSkillWindow(socketId, kind, ms, pct) {
    const p = this.players.get(socketId);
    if (!p) return false;
    const until = Date.now() + Math.max(0, ms);
    if (kind === 'vampirism') { p._vampUntil = until; p._vampPct = pct; return true; }
    if (kind === 'butterflies') { p._butterfliesUntil = until; p._butterAt = Date.now(); return true; }
    if (kind === 'haste') { p._hasteUntil = until; p._hasteMult = pct; return true; }
    return false;
  }

  // Ударов в секунду, на которые этот игрок имеет право. Считает сервер, из
  // класса, уровня, снаряжения и пассивок (repos/stats.js) — подделать клиент
  // не может. Навычное ускорение — окно, открытое сервером после проверки
  // навыка, а не число из пакета.
  _attackRate(p) {
    let as = Number(p && p.atkSpeed);
    if (!Number.isFinite(as) || as <= 0) as = ATTACK_RATE_FALLBACK;
    if (p._hasteUntil > Date.now() && p._hasteMult > 1) as *= p._hasteMult;
    return as;
  }

  // ── ведро вместо порога ────────────────────────────────────────────────────
  // Сначала здесь стоял простой порог: удар принимается, если с предыдущего
  // прошло не меньше 1/atkSpeed (с допуском 15% на дрожание). В проде он тут же
  // показал, чего не показывали замеры: 25% ударов отклонялось с причиной
  // too_soon у КАЖДОГО активно бьющего игрока.
  //
  // Клиент при этом не бьёт быстрее, чем умеет — он планирует замах ровно на
  // 1/atkSpeed и, из-за квантования по кадрам, скорее чуть медленнее. Раньше
  // приходят ПАКЕТЫ: TCP склеивает два подряд после короткой заминки, и сервер
  // видит их в одну миллисекунду. Порог по последнему принятому удару такой
  // сдвоенности не переживает никак — второй пакет всегда «слишком рано», —
  // и никакой допуск этого не чинит, потому что дело не в величине зазора, а
  // в том, что зазор мерится не от того.
  //
  // Ведро мерит ПОТОК. За паузу накапливается право на удар, склеенная пара
  // тратит накопленное и проходит целиком, а долгосрочный темп остаётся ровно
  // равен скорости атаки — то есть потолок стал ТОЧНЫМ, допуск больше не нужен
  // и не раздаёт лишних процентов.
  //
  // Пустое ведро — это уже не дрожание, а поток быстрее, чем персонаж умеет
  // бить: ровно то, что и должно отклоняться.
  _attackAllowed(attacker, now) {
    const perMs = this._attackRate(attacker) / 1000;
    const last = attacker._atkBudgetAt;
    // Первый удар в сессии — с полным ведром: игрок, только вошедший в мир, не
    // должен ждать, и накапливать ему было негде.
    let budget = (last == null) ? ATTACK_BURST_MAX
      : Math.min(ATTACK_BURST_MAX, (attacker._atkBudget || 0) + (now - last) * perMs);
    attacker._atkBudgetAt = now;
    if (budget < 1) { attacker._atkBudget = budget; return false; }
    attacker._atkBudget = budget - 1;
    return true;
  }

  syncPlayerHp(socketId, clientHp) {
    const p = this.players.get(socketId);
    if (!p || p.hp <= 0) return;
    if (!Number.isFinite(clientHp)) return;
    const requested = Math.min(p.maxHp, Math.max(0, clientHp));
    // Decreases are always trusted immediately — they can never help a
    // cheater. Increases (passive HP regen ticking up between potions/heals)
    // are rate-limited to MAX_HP_REGEN_PER_SEC instead of being applied
    // outright — otherwise a modified client could report hp:maxHp on every
    // movement packet and become unkillable (this is also what would have
    // silently undone the server-applied PvP damage in pvpAttack/
    // pvpSkillAttack below). Real heals (potions, faithShield/party heal,
    // respawn) all go through their own dedicated methods and aren't gated
    // by this at all.
    if (requested <= p.hp) { p.hp = requested; p._lastHpSyncAt = Date.now(); return; }
    const now = Date.now();
    const elapsed = Math.max(0, (now - (p._lastHpSyncAt || now)) / 1000);
    p._lastHpSyncAt = now;
    p.hp = Math.min(requested, p.hp + elapsed * MAX_HP_REGEN_PER_SEC, p.maxHp);
  }

  // Every heal path funnels through here and healPartyMember below, so this is
  // the one place that has to refuse a non-finite amount: NaN written to hp is
  // absorbing (all later comparisons, including the `hp <= 0` death check,
  // return false) and would leave the player alive but unkillable. Callers
  // validate too — this is the backstop so a future one can't reintroduce it.
  healPlayer(socketId, amount) {
    const p = this.players.get(socketId);
    if (!p || p.hp <= 0) return;
    if (!Number.isFinite(amount)) return;
    p.hp = Math.min(p.maxHp, p.hp + Math.max(0, amount));
  }

  respawnPlayer(socketId) {
    const p = this.players.get(socketId);
    if (!p) return;
    p.hp = p.maxHp;
    p.x = this._dungeon.spawn.x;
    p.y = this._dungeon.spawn.y;
  }

  // ── Death Battle (Битва на смерть) ────────────────────────────────────────
  // Drops every entrant onto its own point of a ring inside the event arena —
  // its own floor now (server/game/floors.js), sealed off the same way the
  // world boss's own use of it already is, so PvP works there and nobody can
  // wander in mid-round. Everyone is healed and flipped into PvP here rather
  // than client-side: the server owns hp and pvpMode, and a client that
  // ignored the request would otherwise be an unkillable participant.
  // Callers (server/index.js's _dbStart) force each entrant's own connection
  // onto this floor before calling this — _dbPrevFloor/_dbPrevX/_dbPrevY
  // (where they actually were, for the return trip) are captured by that
  // caller too, from the floor they were really on, since by the time this
  // runs everyone here already has this floor's own default spawn position,
  // not their real previous one.
  deathBattleDeploy(socketIds) {
    const ar = this._dungeon.arena;
    if (!ar) return [];
    const placed = [];
    const n = Math.max(1, socketIds.length);
    // Arena is 40 tiles across; 13 tiles from the centre keeps the whole ring
    // clear of the walls whatever the entrant count.
    const R = 13 * TILE;
    socketIds.forEach((sid, i) => {
      const p = this.players.get(sid);
      if (!p) return;
      const ang = (i / n) * Math.PI * 2;
      let x = ar.cx + Math.cos(ang) * R;
      let y = ar.cy + Math.sin(ang) * R;
      if (this._isWall(x, y)) { x = ar.cx; y = ar.cy; }
      p.x = x; p.y = y;
      p.hp = p.maxHp;
      p.pvpMode = true;
      p._profileRev++;
      placed.push({ socketId: sid, x, y, hp: p.hp });
    });
    return placed;
  }

  // Places a 3v3 match: one side per base, one player per lane, full HP and
  // PvP on. Returns what was actually placed so the caller only counts players
  // who really made it in. Falls back to the arena centre if a lane spawn ever
  // lands on a wall, so a map tweak can't strand someone inside geometry.
  // The base slots a match can actually put people in, per side. Validated
  // rather than assumed, for the same reason raceUsableLanes is: the deploy
  // used to fall back to the arena's CENTRE when a slot came out inside
  // geometry, which is both the middle of the lane the two teams fight over
  // and the exact silent misplacement that made everyone appear in the middle
  // of the map for real. A slot that cannot be honoured is dropped, so a side
  // with fewer usable slots simply reuses the ones it has (the modulo below)
  // instead of quietly teleporting someone into the crossfire.
  //
  // Also what server/index.js reads to join each entrant AT the slot it is
  // about to be given — dungeonData deliberately does not carry pvpArena
  // (the client needs no arena geometry), so this is the way in.
  pvpArenaSlots() {
    const ar = this._dungeon.pvpArena;
    if (!ar) return { teamA: [], teamB: [] };
    const ok = spots => (spots || []).filter(s => this.canStandAt(s.x, s.y));
    return { teamA: ok(ar.teamA), teamB: ok(ar.teamB) };
  }

  pvpArenaDeploy(teamA, teamB) {
    const ar = this._dungeon.pvpArena;
    if (!ar) return [];
    const placed = [];
    const slots = this.pvpArenaSlots();
    const put = (ids, spots, team) => {
      if (!spots.length) return;
      ids.forEach((sid, i) => {
        const p = this.players.get(sid);
        if (!p) return;
        const spot = spots[i % spots.length];
        const x = spot.x, y = spot.y;
        p.x = x; p.y = y;
        p.hp = p.maxHp;
        p.pvpMode = true;
        // Defensive: fearEnter's own registration-time check is what's meant
        // to keep these two from ever overlapping, but a deploy pulling
        // someone out of their Fear hall without releasing it is exactly the
        // leaked-hall/"monsters disappeared" bug that guard exists to
        // prevent — belt and suspenders against any other path in.
        if (p._fearLane != null) { this.fearReleaseLane(p._fearLane); p._fearLane = null; }
        p._profileRev++;
        placed.push({ socketId: sid, x, y, hp: p.hp, team });
      });
    };
    put(teamA, slots.teamA, 'A');
    put(teamB, slots.teamB, 'B');
    return placed;
  }

  // Places a race10 entrant into their own lane's spawn point (array index =
  // lane number), full HP, normal PvE combat (no pvpMode — this event has no
  // player-vs-player component at all). Falls back to the shared boss room if
  // a lane spawn ever lands on a wall.
  // The corridors an entrant can actually be put into, each carrying the
  // MAP's own lane index rather than a position in this list. That index is
  // the lane's identity everywhere else — every corridor monster carries
  // `lane` and _raceVisible compares against it — so an unusable corridor has
  // to be skipped, never compacted away, or entrant N would be sealed to lane
  // N while standing in lane N+1's corridor.
  //
  // Validated rather than assumed. raceDeploy used to fall back to the boss
  // room when a lane spot came out inside geometry, which is the exact silent
  // failure that put every entrant on the boss once before (see
  // _race10Deploy, server/index.js): a placement that cannot be honoured must
  // reduce capacity and refuse someone plainly, not quietly move them
  // somewhere they did not ask to be.
  raceUsableLanes() {
    const race = this._dungeon.race10;
    if (!race) return [];
    const out = [];
    race.lanes.forEach((spot, lane) => {
      if (this.canStandAt(spot.x, spot.y)) out.push({ lane, x: spot.x, y: spot.y });
    });
    return out;
  }

  raceDeploy(socketIds) {
    const race = this._dungeon.race10;
    if (!race) return [];
    const placed = [];
    const usable = this.raceUsableLanes();
    // One lane per entrant, never shared: two players in the same corridor
    // would fight the same monsters and re-create exactly the cross-lane mess
    // the isolation above removes. The caller caps the list at
    // raceUsableLanes().length and hands them over in the same order, so slot
    // n here is the corridor entrant n was already joined at.
    socketIds.slice(0, usable.length).forEach((sid, i) => {
      const p = this.players.get(sid);
      if (!p) return;
      const spot = usable[i];
      const x = spot.x, y = spot.y;
      p.x = x; p.y = y;
      p.hp = p.maxHp;
      // Their lane for as long as the run lasts — read by _raceVisible on both
      // the targeting and the streaming side. Cleared when they leave, in
      // deathBattleReturn (every exit path goes through it) and removePlayer.
      p._raceLane = spot.lane;
      // Defensive: fearEnter's own registration-time check is what's meant to
      // keep these two from ever overlapping (register for the Tower, then
      // start a Fear run while waiting for it to open), but landing here with
      // a Fear lane still set would otherwise leak that hall forever — nothing
      // downstream releases it — while its monsters silently drop off this
      // player's screen the moment they're moved here (out of AOI range),
      // reading as "the monsters disappeared". Belt and suspenders against any
      // other path in.
      if (p._fearLane != null) { this.fearReleaseLane(p._fearLane); p._fearLane = null; }
      p._profileRev++;
      placed.push({ socketId: sid, x, y, hp: p.hp, lane: spot.lane });
    });
    this._raceActive = placed.length > 0;
    return placed;
  }

  // Spawns the single shared race10 boss — same identity/stats as the world
  // EVENT_BOSS (full HP, normal aggro/attack AI included — unlike the 3v3
  // guard boss this one actually fights back). ignoresSafeZone carries over
  // from the spread for the same reason the real one needs it: the shared
  // room is big enough that players kiting it would otherwise trip the
  // 420px leash and reset its HP mid-race. raceBoss marks it so the tick
  // loop's hp<=0 branch skips the event-boss loot-drop-and-purge behavior
  // below (see that guard) — server/index.js ends the race and despawns it
  // itself the moment the kill lands.
  spawnRaceBoss() {
    const race = this._dungeon.race10;
    if (!race || !race.boss) return null;
    const { x, y } = race.boss;
    const e = {
      id: `race10boss_${Date.now()}`,
      ...EVENT_BOSS,
      eid: 'race10_boss',
      maxHp: EVENT_BOSS.hp, hp: EVENT_BOSS.hp,
      arm: 'race10', rlvl: 0,
      x, y, spawnX: x, spawnY: y,
      atkTimer: 1, hurtTimer: 0, atkAnimTimer: 0,
      aggro: false, aggroR: 900,
      raceBoss: true,
      // Holds its ground in the middle of the shared room instead of chasing,
      // but is otherwise a live boss: it still aggros and still hits whoever
      // comes into reach — see the stationary branch in _tick. Chasing made it drag the fight back down whichever
      // corridor it happened to pick, which is neither fair to that runner nor
      // to the ones it walked away from.
      stationary: true,
      _sx: x, _sy: y, _shp: EVENT_BOSS.hp,
      _idx: this._allocIdx(),
    };
    this.enemies.push(e);
    this._enemyMap.set(e.id, e);
    this._raceBossId = e.id;
    return e.id;
  }

  // Removes the race10 boss (dead or still standing) once the race ends.
  despawnRaceBoss() {
    // Also the end of the race as far as the tick loop is concerned: corridor
    // monsters go back to being skipped entirely (see the race10 branch in
    // _tick). Called from _race10Finish on every ending — win, timeout or
    // nobody left standing.
    this._raceActive = false;
    if (!this._raceBossId) return;
    const id = this._raceBossId;
    this.enemies = this.enemies.filter(e => {
      if (e.id !== id) return true;
      this._enemyMap.delete(e.id);
      this._forgetEnemy(e.id);
      this._releaseIdx(e);
      return false;
    });
    this._raceBossId = null;
  }

  // Revives every race10 corridor monster to full HP at its spawn point.
  // Called once per race, right before deploying entrants (server/index.js
  // _race10Deploy) — race10 monsters never respawn on their own (see the
  // tick loop's hp<=0 branch below), so without this the second race of the
  // day would find every lane already cleared out by the first one.
  resetRaceMonsters() {
    this.enemies.forEach(e => {
      if (e.arm !== 'race10') return;
      e.hp = e.maxHp;
      e.x = e.spawnX; e.y = e.spawnY;
      e.aggro = false; e.atkTimer = 1 + Math.random(); e.hurtTimer = 0;
      e.stunTimer = 0; e.slowTimer = 0; e.defDownTimer = 0;
      e._shp = -1;
      delete e.respawnTimer;
    });
  }

  // Война гильдий (Guild War): spawns the one stationary tower/castle at the
  // zone's centre, called once at Room construction (owner: this Room's
  // slice of server/index.js's persisted _gw state, { ownerClanId,
  // ownerClanName, ownerClanIcon }). Unlike every other stationary boss in
  // this file, this enemy is NEVER despawned/respawned for the Room's entire
  // lifetime — attackEnemy/skillAttackEnemy's capture branch (below) resets
  // its hp and reassigns ownership in place, on the exact same object, so
  // its id/_idx (the wire-protocol handle) never changes. Renumbering it
  // across a capture would silently repoint every connected client's handle
  // map at the wrong enemy, the same class of bug the _idx comment in the
  // constructor above documents in detail.
  //
  // isBoss is deliberately false: `isBoss: true` also opts an enemy out of
  // AOI culling entirely (see _rebuildEnemyGrid's _bossBuf, which is streamed
  // to EVERY connected player every tick, not just nearby ones) — that's
  // right for the one-of-a-kind world/arm bosses, but it meant this tower's
  // HP bar sat pinned on every player's screen everywhere in the world,
  // forever, even for players nowhere near the Guild War zone. Regular
  // (non-boss) enemies size at 6.75x instead of a boss's 4.5x
  // (js/pixi-world.js), so `size` is scaled down from 90 to 60 to keep the
  // exact same on-screen footprint.
  spawnGuildWarTower(owner) {
    const gw = this._dungeon.guildWar;
    if (!gw) return null;
    const x = gw.cx, y = gw.cy;
    const e = {
      id: 'guildwar_castle', eid: 'guildwar_castle',
      name: 'Замок гильдий', color: '#c9a24b', size: 60,
      maxHp: GUILD_WAR_TOWER_HP, hp: GUILD_WAR_TOWER_HP,
      atk: 0, def: 0, spd: 0, xp: 0, gold: 0,
      isBoss: false,
      x, y, spawnX: x, spawnY: y,
      atkTimer: 1, hurtTimer: 0, atkAnimTimer: 0,
      aggro: false, aggroR: 0,
      guildWar: true,
      ownerClanId: (owner && owner.ownerClanId) || null,
      ownerClanName: (owner && owner.ownerClanName) || null,
      ownerClanIcon: (owner && owner.ownerClanIcon) || null,
      _sx: x, _sy: y, _shp: GUILD_WAR_TOWER_HP,
      _idx: this._allocIdx(),
    };
    this.enemies.push(e);
    this._enemyMap.set(e.id, e);
    this._gwTowerId = e.id;
    return e;
  }

  // Guild War entry placement: spreads a fresh entrant across the zone's own
  // spawn ring (dungeon.js's guildWar.spawns) instead of landing everyone on
  // the same tile — called from _doEnterLocation (server/index.js) on a walk
  // in. No longer used for death — dying inside the zone now ejects to the
  // hub like every other instanced mode (server/index.js's 'respawn'
  // handler), instead of respawning back inside the same fight. Deliberately
  // leaves p._guildWarZone/p.pvpMode untouched — the per-tick bounds check in
  // _tick re-confirms both next frame regardless (see the guild-war block
  // there), and clearing them here would just be a one-frame flicker.
  guildWarRespawn(socketId) {
    const p = this.players.get(socketId);
    if (!p) return null;
    const gw = this._dungeon.guildWar;
    if (!gw || !gw.spawns || !gw.spawns.length) { this.respawnPlayer(socketId); return p ? { x: p.x, y: p.y } : null; }
    const spot = gw.spawns[Math.floor(Math.random() * gw.spawns.length)];
    p.hp = p.maxHp;
    p.x = spot.x; p.y = spot.y;
    p._profileRev++;
    return { x: p.x, y: p.y };
  }

  // ── setPlayerStats ────────────────────────────────────────────────────────
  // Replaces updatePlayerStats, which existed to receive numbers the CLIENT
  // computed and clamp them to a headroom multiplier above what the server
  // could independently derive (x1.5 ATK, x2.85 DEF).
  //
  // That clamp was a guess standing in for knowledge, and it failed in both
  // directions at once. Too loose: writing any catalog item into
  // player.equipment in the console let recompute() produce a large number,
  // and the sender kept the entire headroom permanently with no buff running.
  // Too tight: the codex bonus was absent from the server's own computeStats,
  // so an honest player with completed sets had part of an earned bonus eaten
  // by the same clamp.
  //
  // Nothing is clamped here because nothing is guessed. The numbers come from
  // repos/stats.js, which reads class, level, upgrades, equipped ROWS with
  // their enhancement, passives, codex, clan and the active buffs — all of
  // which the server owns. 'statsUpdate' is deleted rather than validated.
  setPlayerStats(socketId, st) {
    const p = this.players.get(socketId);
    if (!p || !st) return;
    // Nothing is clamped, but everything is required to be a NUMBER. This is
    // the other door computed stats come through (setPlayerChar is the first),
    // and both of its callers derive `st` from a class table looked up by a
    // stored char_class — repos/stats.js's compute(), and Session.moveRoom
    // copying a record that came from it. A row whose class does not resolve
    // used to hand back NaN here, and a NaN atk/def is not a small stat: it
    // makes the player unkillable and poisons the hp of every enemy they hit,
    // for everyone, permanently. See _statsFinite. Refusing the whole block is
    // right rather than fixing up fields: a partially-NaN stat set means the
    // computation upstream is wrong, and the player's previous, known-good
    // numbers are a better answer than half of a broken one.
    if (!_statsFinite(st, p.username || socketId, 'setPlayerStats')) return;
    // The level rides along because the room is where anything synchronous
    // asks for it — the event modes gate entry on it, and reading it from the
    // database inside a "may I register" check would make the check async for
    // no gain. It is the server's own number either way.
    if (st.level > 0) p.lvl = st.level;
    p.atk = st.atk;
    p.def = st.def;
    p.critChance = st.critChance;
    p.critPower = st.critPower;
    p.atkSpeed = st.atkSpeed;
    p.hpRegen = st.hpRegen;
    p.skillPct = st.skillPct || 0;
    // Skill levels and the advanced-skill flags, which decide whether a cast
    // does ANY damage at all (_skillMultFor). They used to be read off the
    // client-authored save blob, which this build stopped filling — see the
    // note there. Only overwritten when the payload actually carries them, so
    // the one caller that hand-builds a partial stats object for a floor move
    // (Session.moveRoom) cannot blank them.
    if (st.skillLevels) p._skillLevels = st.skillLevels;
    if (st.advSkillLearned) p._advLearned = st.advSkillLearned;
    if (st.advSkillActive) p._advActive = st.advSkillActive;
    if (st.maxHp > 0 && p.maxHp !== st.maxHp) {
      p.maxHp = st.maxHp;
      // Other clients render this player's health bar from maxHp, so a change
      // has to reach them — that is what _profileRev is for.
      p._profileRev++;
    }
    // Never raises current HP: a stat recomputation is not a heal. Equipping
    // +HP gear must not top the bar up, and taking it off must not leave the
    // player above their new maximum.
    if (p.hp > p.maxHp) p.hp = p.maxHp;
  }

  // Authoritative HP, from the server's own healing and damage paths.
  // Separate from setPlayerStats because HP changes far more often and must
  // not drag a full stat write with it.
  setPlayerHp(socketId, hp) {
    const p = this.players.get(socketId);
    if (!p) return;
    const v = Math.max(0, Math.min(p.maxHp, Math.floor(Number(hp) || 0)));
    if (p.hp === v) return;
    p.hp = v;
    this.io.to(`floor_${this.floor}`).emit('playerHurt', { id: socketId, hp: v });
  }

  // ── claimDrop / returnDrop ────────────────────────────────────────────────
  // Claiming REMOVES the drop from the floor and hands it to the caller, who
  // then has to deliver it to a database. If that delivery fails — a full
  // inventory, a rolled-back transaction — the drop must go BACK, or a refusal
  // destroys the item.
  //
  // The old flow could not express that: the drop was removed and the grant
  // was a separate write that could fail on its own.
  claimDrop(socketId, dropId) {
    const p = this.players.get(socketId);
    if (!p) return null;
    return this.claimWorldDrop(dropId, p.x, p.y);
  }

  returnDrop(drop) {
    if (!drop || !drop.id) return false;
    this.worldDrops.set(drop.id, drop);
    // 'worldDropsSpawned' with a list, which is the event the client renders
    // drops from. A singular 'worldDropSpawned' reached nobody, so a drop
    // returned after a refused pickup vanished from every screen while still
    // sitting on the floor server-side.
    this.io.to(`floor_${this.floor}`).emit('worldDropsSpawned', {
      drops: [{ id: drop.id, x: drop.x, y: drop.y, item: drop.item || drop }],
    });
    return true;
  }

  // Answers the "view profile" (Инфо button) request entirely server-side —
  // see requestPlayerProfile, server/index.js. Deriving straight from this
  // player's own already-validated p._sd (kept in sync by
  // updatePlayerSavedData on every saveProgress) means it never depends on
  // the target's own client being responsive, unlike an earlier version that
  // asked their client to answer and could go unanswered indefinitely. Both
  // players are guaranteed to be in this same Room already — the requester
  // can only ever target someone currently rendered in their own AOI.
  publicProfile(socketId) {
    const p = this.players.get(socketId);
    if (!p) return null;
    // _charDef, for the same reason setPlayerChar uses it. setPlayerChar is
    // the only writer of p.type and now refuses anything that is not a real
    // class, so this is defence in depth rather than a live hole — but the
    // fallback here is `|| {}`, which is genuinely safe, and the direct lookup
    // was not: `CHAR_DEF['constructor']` is the Object constructor, whose
    // `.name` is the string 'Object', so a profile opened on such a player
    // would have shown their class as "Object" instead of falling back to
    // p.type. One lookup, one rule.
    const cd = _charDef(p.type) || {};
    const sd = p._sd || {};
    const stats = computeStats(sd, cd, p.type, p.clanAtkBonus);
    const equipment = {};
    Object.entries(sd.equipment || {}).forEach(([slot, it]) => {
      if (!it) return;
      equipment[slot] = {
        name: it.name, img: it.img || null, icon: it.icon || null, rarity: it.rarity || null,
        enhance: it.enhance || 0,
        atk: it.atk || 0, def: it.def || 0, hp: it.hp || 0,
        critChance: it.critChance || 0, atkSpeed: it.atkSpeed || 0, hpPct: it.hpPct || 0,
      };
    });
    return {
      name: p.username, charIcon: cd.icon || null, charColor: cd.color || null, className: cd.name || p.type,
      lvl: p.lvl, upgrades: sd.upgrades || {},
      hp: Math.ceil(p.hp), maxHp: stats.maxHp,
      atk: stats.atk, def: stats.def, atkSpeed: stats.atkSpeed,
      critChance: stats.critChance, critPower: stats.critPower, hpRegen: stats.hpRegen,
      equipment,
    };
  }

  // Отказ, который называет себя. Причина кладётся на игрока, а не
  // возвращается наружу: attackEnemy отдаёт null в семи местах, и менять её
  // форму ради диагностики значило бы трогать каждого вызывающего.
  //
  // Заведено потому, что счётчик отказов в handlers2/world.js показал 25% и не
  // смог сказать, о чём это: «замах по мобу, которого добил сосед» и «клиент
  // бьёт слишком часто» выглядели одинаково, а лечатся по-разному.
  _refuse(attacker, why) {
    if (attacker) attacker._refuseWhy = why;
    return null;
  }

  attackEnemy(socketId, enemyId, { splash = false } = {}) {
    const attacker = this.players.get(socketId);
    // Same reasoning as updatePlayerPos above — a dead attacker's client can
    // keep firing attack events; the server must independently refuse them.
    if (!attacker || attacker.hp <= 0) return this._refuse(attacker, 'dead_self');
    const now = Date.now();
    if (splash) {
      // "Безумие" (advanced deathknight E) — every basic melee hit also
      // splashes onto nearby enemies, several of them landing in the very
      // same instant as the primary swing that triggered them. The flat
      // 150ms-per-attacker floor below exists to pace independent swings,
      // and rejected every one of these (they arrive milliseconds apart,
      // all sharing attacker._lastAtk) — that's the "AOE иногда не
      // работает" bug: only whichever splash hit happened to land more than
      // 150ms after the primary survived, at random depending on network
      // jitter. A splash hit is only ever a side effect of a primary swing
      // that just landed, never a substitute for one, so it's allowed
      // within a short window after the last REAL (non-splash) hit instead
      // — bounded by how often those land (still floored at 150ms below),
      // not by its own independent clock a modified client could hammer on
      // its own to bypass that floor.
      //
      // The window is the whole of WHEN a splash hit may land, and it was
      // also, wrongly, the whole of the check. Two things it never asked are
      // asked now: WHO may splash (right below — the flag was open to every
      // class at every level) and HOW MANY (past the enemy lookup — the
      // window is not a count, and unbounded hits fit inside it).
      if (now - (attacker._lastAtk || 0) > 200) return this._refuse(attacker, 'splash_window');
      if (!this._canSplash(attacker)) return this._refuse(attacker, 'splash_denied');
    } else {
      // ── сколько ждать между ударами ──────────────────────────────────────
      // Здесь стоял плоский порог: «не чаще одного удара в 150 мс», один и тот
      // же для всех. Он был неверен в ОБЕ стороны сразу.
      //
      // Снизу: 150 мс — это 6.67 удара в секунду, а прокачанный персонаж
      // законно бьёт быстрее. В живой базе есть чернокнижник 38-го уровня со
      // 120 очками в скорость атаки — 7.87 удара в секунду, то есть 127 мс.
      // Сервер отклонял каждый такой удар, МОЛЧА (см. resolveHit,
      // handlers2/world.js), и отклонённый удар не сдвигал окно — поэтому чем
      // быстрее человек бил, тем меньше попадал: замеры на живом сервере дали
      // 5.87 попадания в секунду на 150 мс против 3.15 на 140 мс. Это и есть
      // «авто бой с мобами останавливается»: любой баф скорости перетаскивал
      // обычную сборку за край, и урон проваливался вдвое на время бафа.
      //
      // Сверху: тот же порог РАЗРЕШАЛ 6.67 удара в секунду и персонажу с
      // базовой скоростью 1.2 — то есть модифицированному клиенту он дарил
      // пятикратный урон. Плоское число не может быть одновременно потолком
      // для быстрых и потолком для медленных.
      //
      // Теперь порог считается от скорости атаки САМОГО игрока — а её считает
      // сервер (repos/stats.js) из класса, уровня, снаряжения и пассивок, так
      // что подделать её клиент не может. Быстрым это возвращает их скорость,
      // медленным — закрывает дыру.
      if (!this._attackAllowed(attacker, now)) return this._refuse(attacker, 'too_soon');
      attacker._lastAtk = now;
      // A real swing opens a fresh splash budget for the window it starts —
      // see the block under the enemy lookup for what that budget is and why.
      // The set is cleared rather than reallocated: this runs up to 6.7 times
      // a second for every attacking player in the room.
      if (attacker._splashHit) attacker._splashHit.clear();
      else attacker._splashHit = new Set();
      attacker._splashN = 0;
    }
    const enemy = this._enemyMap.get(enemyId); // O(1) Map lookup
    if (!enemy || enemy.hp <= 0) return this._refuse(attacker, 'target_gone');
    // ── how many splash hits one swing is worth ──────────────────────────────
    // A splash hit never touched attacker._lastAtk, so nothing re-armed after
    // one: EVERY splash packet sent inside the 200ms after a real swing was
    // accepted, against the same monster, as fast as the socket would carry
    // them. 'attack' sits in the FAST rate-limit bucket (1500 per 5s, see
    // server/app.js), and a splash lands at 50% damage — ~150 full-hit-
    // equivalents a second against one enemy where the 150ms floor above
    // allows 6.7. Every kill pays through consumables.grantKillReward, so that
    // was a ~22x multiplier on gold, xp, loot rolls, Liberty and GRAM drops,
    // and it won every contested kill there is: the guild-war tower, the
    // race10 boss, the world boss.
    //
    // The real skill's own shape is the bound. It deals ONE half-damage hit
    // per NEARBY enemy per swing, and never to the enemy the swing itself hit
    // — js/player.js skips `e.id === pa.id` — so the swing carries the set of
    // enemies it has already paid out to, seeded with its own primary target.
    // A splash naming an enemy already in that set is refused, and so is one
    // arriving after MAX_SPLASH_PER_SWING distinct enemies have been reached.
    // Single-target damage is therefore exactly one swing's worth again, and
    // the legitimate case is untouched: the enemies in a real splash burst are
    // distinct by construction, and there are never sixteen of them.
    //
    // Keyed on enemy.id, not on the raw packet field: _enemyMap answers only
    // for its own exact key, so this is the id the room itself uses and a
    // client cannot buy a second slot for the same monster by sending '5'
    // where it already spent 5.
    const swing = attacker._splashHit || (attacker._splashHit = new Set());
    if (splash) {
      if ((attacker._splashN || 0) >= MAX_SPLASH_PER_SWING) return this._refuse(attacker, 'splash_cap');
      if (swing.has(enemy.id)) return this._refuse(attacker, 'splash_dup');
      attacker._splashN = (attacker._splashN || 0) + 1;
    }
    swing.add(enemy.id);
    // Instance isolation, as a RULE rather than as a consequence of the map.
    // A corridor monster belongs to exactly one Tower lane (and a Fear
    // monster to one hall), and until now nothing said so on the damage path
    // — cross-lane hits were stopped only by the walls between corridors and
    // the line-of-sight check below. That holds for the geometry as drawn,
    // but it is the wrong thing to be relying on: a client that names an
    // enemy id directly is not constrained by what it can see, and the one
    // thing standing between it and somebody else's monsters would be a
    // sampling test over a wall. _raceVisible is the same predicate the
    // streaming and targeting sides already use, so this makes "you may only
    // touch your own instance" one rule with one implementation.
    if (!this._raceVisible(attacker, enemy)) return this._refuse(attacker, 'not_visible');
    // Range check: must be within 350px of the enemy's BODY (generous for AoE
    // skills). enemy.size is added because this is measured to its centre —
    // without it a large enemy shrinks the usable window by its own radius,
    // which rejected hits on the size-165 event boss.
    const rdx = attacker.x - enemy.x, rdy = attacker.y - enemy.y;
    const _reach = 350 + (enemy.size || 0);
    if (rdx * rdx + rdy * rdy > _reach * _reach) return this._refuse(attacker, 'out_of_range');
    if (!this._hasLOS(attacker.x, attacker.y, enemy.x, enemy.y)) return this._refuse(attacker, 'no_los');
    // Guild War tower: only a clanned attacker from a DIFFERENT clan than the
    // current owner may damage it — checked here, inside Room.js rather than
    // in the handler, since this needs to run before damage is computed.
    if (enemy.guildWar) {
      // THE WINDOW FIRST. There was no check for it at all: the castle could be
      // brought down and captured at four in the afternoon, with the zone
      // closed and the event not running — "война гильдий не активна, но я
      // заламал замок". Ownership pays hourly income to the holding clan, so
      // capturing it outside the window is capturing the whole reward with
      // nobody able to contest it.
      //
      // The predicate is handed in from boot rather than read here: a Room
      // knows about geometry and combat and deliberately nothing about what
      // time it is.
      if (this._gwIsOpen && !this._gwIsOpen()) return { immune: true, reason: 'closed' };
      if (!attacker.clanName) return { immune: true, reason: 'no_clan' };
      if (attacker.clanName === enemy.ownerClanName) return { immune: true, reason: 'own_tower' };
    }
    // "Охота" (advanced deathknight R) — 20% off this enemy's def while
    // defDownTimer is running (see applySkillEffect's 'defDown' branch).
    const _effDef = (enemy.defDownTimer || 0) > 0 ? Math.round(enemy.def * 0.8) : enemy.def;
    const base = Math.max(1, attacker.atk - _effDef + Math.floor(Math.random() * 7) - 3);
    const { dmg: _rawDmg, isCrit } = _critDmg(base, attacker.critChance, attacker.critPower);
    // Splash always lands at exactly 50% of what the same hit would have
    // dealt directly — flat, not reduced further by anything above.
    const dmg = splash ? Math.max(1, Math.round(_rawDmg * 0.5)) : _rawDmg;
    attacker.lastAtkSeq = (attacker.lastAtkSeq || 0) + 1;
    enemy.hp = Math.max(0, enemy.hp - dmg);
    // Здесь, а не у клиента: dmg — уже посчитанное сервером число, с критом и
    // защитой цели, и никакого другого честного не существует.
    this._vampGain(attacker, dmg);
    enemy.aggro = true;
    this._wakePack(enemy);
    if (enemy.hp <= 0) {
      // Guild War tower: never actually "dies" — capture resets its hp to
      // maxHp in place, on the exact same enemy object, and hands ownership
      // to the attacker's clan. See spawnGuildWarTower's comment for why
      // this must never despawn/recreate the enemy instead.
      if (enemy.guildWar) {
        const prevOwnerClanName = enemy.ownerClanName;
        enemy.hp = enemy.maxHp;
        enemy.ownerClanId = attacker.clanId || null;
        enemy.ownerClanName = attacker.clanName || null;
        enemy.ownerClanIcon = attacker.clanIcon || null;
        return {
          killed: true, captured: true, dmg, isCrit, ex: enemy.x, ey: enemy.y, color: enemy.color,
          newOwnerClanId: enemy.ownerClanId, newOwnerClanName: enemy.ownerClanName,
          newOwnerClanIcon: enemy.ownerClanIcon, prevOwnerClanName,
        };
      }
      // Race10 boss: no xp/gold/loot either — server/index.js tallies dmg per
      // attacker across every hit (not just this killing one) to decide the
      // race's winner, so raceBoss has to come back on non-kills too (below).
      if (enemy.raceBoss) return { killed: true, dmg, isCrit, raceBoss: true, ex: enemy.x, ey: enemy.y, color: enemy.color };
      const g = calcGoldDrop(enemy);
      // Assigned right here rather than left for the AI tick loop to notice
      // next frame — that gap is what forced an earlier version to guess an
      // independent random ETA for the immediate bossStatus broadcast
      // (server/index.js), which could disagree with what the tick loop
      // then actually assigned.
      let respawnAt;
      if (enemy.isBoss) {
        enemy.respawnTimer = _bossRespawnSecs();
        respawnAt = Date.now() + enemy.respawnTimer * 1000;
        if (this._onBossDeath) this._onBossDeath(enemy.arm, respawnAt);
      }
      // `at` stamps THIS death. An enemy id is stable across respawns — the rat
      // at e_left_0 carries the same id tomorrow — so anything keyed on the id
      // alone reads every later kill of that spawn as a repeat of the first.
      // The reward path keys its idempotency on it, and without this a player
      // farming one spawn was paid exactly once, ever.
      return { killed: true, at: now, xp: enemy.xp, gold: g, dmg, isCrit, ex: enemy.x, ey: enemy.y, color: enemy.color, isBoss: !!enemy.isBoss, eid: enemy.eid, rlvl: enemy.rlvl || 0, arm: enemy.arm, lane: enemy.lane, respawnAt, farmZone: !!enemy.farmZone, farmZone2: !!enemy.farmZone2 };
    }
    if (enemy.raceBoss) return { killed: false, hp: enemy.hp, dmg, isCrit, raceBoss: true };
    return { killed: false, hp: enemy.hp, dmg, isCrit };
  }

  skillAttackEnemy(socketId, enemyId, key) {
    const attacker = this.players.get(socketId);
    if (!attacker) return null;
    // Dead attackers can't cast — attackEnemy has refused this for basic hits
    // for the same reason (a client that never noticed it died keeps firing).
    if (attacker.hp <= 0) return null;
    // Real skill cooldowns (12–20s) live in the client, which makes them
    // advisory. This is the server's own floor: without it the only limit was
    // the socket-level 20 events/s. SKILL_CD_MS
    // is far below any real cooldown, so legitimate play never reaches it; it
    // exists purely to bound a modified client. See SKILL_BURST_MS above for
    // why one AOE cast's several hits don't gate each other.
    const now = Date.now();
    const castStart = attacker._lastSkillAtk || 0;
    if (now - castStart > SKILL_BURST_MS) {
      if (now - castStart < SKILL_CD_MS) return null;
      attacker._lastSkillAtk = now;
    }
    const enemy = this._enemyMap.get(enemyId);
    if (!enemy || enemy.hp <= 0) return null;
    // Same instance-isolation rule attackEnemy applies — see its comment.
    if (!this._raceVisible(attacker, enemy)) return null;
    const rdx = attacker.x - enemy.x, rdy = attacker.y - enemy.y;
    if (rdx * rdx + rdy * rdy > 600 * 600) return null;
    if (!this._hasLOS(attacker.x, attacker.y, enemy.x, enemy.y)) return null;
    if (enemy.guildWar) {
      // THE WINDOW FIRST. There was no check for it at all: the castle could be
      // brought down and captured at four in the afternoon, with the zone
      // closed and the event not running — "война гильдий не активна, но я
      // заламал замок". Ownership pays hourly income to the holding clan, so
      // capturing it outside the window is capturing the whole reward with
      // nobody able to contest it.
      //
      // The predicate is handed in from boot rather than read here: a Room
      // knows about geometry and combat and deliberately nothing about what
      // time it is.
      if (this._gwIsOpen && !this._gwIsOpen()) return { immune: true, reason: 'closed' };
      if (!attacker.clanName) return { immune: true, reason: 'no_clan' };
      if (attacker.clanName === enemy.ownerClanName) return { immune: true, reason: 'own_tower' };
    }
    // See _skillMultFor — derived from this player's own progression, not
    // taken from the packet. 0 = the active variant does no damage.
    const mult = this._skillMultFor(attacker, key);
    if (!(mult > 0)) return null;
    // Same defDown discount as attackEnemy above.
    const _effDef2 = (enemy.defDownTimer || 0) > 0 ? Math.round(enemy.def * 0.8) : enemy.def;
    const base = Math.max(1, Math.floor((attacker.atk - _effDef2 + Math.floor(Math.random() * 7) - 3) * mult));
    const { dmg, isCrit } = _critDmg(base, attacker.critChance, attacker.critPower);
    // Missing here (unlike attackEnemy/pvpAttack/pvpSkillAttack, which all
    // bump this) meant every skill cast against a monster that doesn't also
    // fire its own netSpawnProj/netSpawnAoe — Пинок, Кувырок, Оковы тьмы —
    // was completely invisible to other nearby players: no swing, no effect,
    // just the monster's hp dropping. The generic swing this drives isn't a
    // perfect match for every skill, but it beats showing nothing at all,
    // and matches what pvpSkillAttack already does for the exact same case.
    attacker.lastAtkSeq = (attacker.lastAtkSeq || 0) + 1;
    enemy.hp = Math.max(0, enemy.hp - dmg);
    // Здесь, а не у клиента: dmg — уже посчитанное сервером число, с критом и
    // защитой цели, и никакого другого честного не существует.
    this._vampGain(attacker, dmg);
    enemy.aggro = true;
    this._wakePack(enemy);
    if (enemy.hp <= 0) {
      if (enemy.guildWar) {
        const prevOwnerClanName = enemy.ownerClanName;
        enemy.hp = enemy.maxHp;
        enemy.ownerClanId = attacker.clanId || null;
        enemy.ownerClanName = attacker.clanName || null;
        enemy.ownerClanIcon = attacker.clanIcon || null;
        return {
          killed: true, captured: true, dmg, isCrit, ex: enemy.x, ey: enemy.y, color: enemy.color,
          newOwnerClanId: enemy.ownerClanId, newOwnerClanName: enemy.ownerClanName,
          newOwnerClanIcon: enemy.ownerClanIcon, prevOwnerClanName,
        };
      }
      if (enemy.raceBoss) return { killed: true, dmg, isCrit, raceBoss: true, ex: enemy.x, ey: enemy.y, color: enemy.color };
      const g = calcGoldDrop(enemy);
      // Assigned right here rather than left for the AI tick loop to notice
      // next frame — that gap is what forced an earlier version to guess an
      // independent random ETA for the immediate bossStatus broadcast
      // (server/index.js), which could disagree with what the tick loop
      // then actually assigned.
      let respawnAt;
      if (enemy.isBoss) {
        enemy.respawnTimer = _bossRespawnSecs();
        respawnAt = Date.now() + enemy.respawnTimer * 1000;
        if (this._onBossDeath) this._onBossDeath(enemy.arm, respawnAt);
      }
      // `at` stamps THIS death. An enemy id is stable across respawns — the rat
      // at e_left_0 carries the same id tomorrow — so anything keyed on the id
      // alone reads every later kill of that spawn as a repeat of the first.
      // The reward path keys its idempotency on it, and without this a player
      // farming one spawn was paid exactly once, ever.
      return { killed: true, at: now, xp: enemy.xp, gold: g, dmg, isCrit, ex: enemy.x, ey: enemy.y, color: enemy.color, isBoss: !!enemy.isBoss, eid: enemy.eid, rlvl: enemy.rlvl || 0, arm: enemy.arm, lane: enemy.lane, respawnAt, farmZone: !!enemy.farmZone, farmZone2: !!enemy.farmZone2 };
    }
    if (enemy.raceBoss) return { killed: false, hp: enemy.hp, dmg, isCrit, raceBoss: true };
    return { killed: false, hp: enemy.hp, dmg, isCrit };
  }

  // Crowd control on a monster.
  //
  // This took the enemy id straight from the client and applied the effect —
  // no caster, no range, no line of sight, no instance check, nothing. Every
  // one of those is enforced on attackEnemy a few hundred lines up; none of
  // them was enforced here. Reading enemy ids off the world stream and sending
  // skillEffect{enemyIds:[…40], type:'stun'} once a second kept every monster
  // and every boss on the floor permanently stunned, from anywhere, and turned
  // boss farming into a chore with no risk. The duration cap was the only
  // thing standing in the way, and a cap on how long is not a rule about what.
  //
  // Same predicate set as a hit, and for the same reason: naming an id is not
  // the same as being able to reach it.
  //
  // What this still does NOT model is the skill's own cooldown — the server
  // has no copy of the skill table — so a modified client can still re-apply
  // to something it is genuinely standing next to and can see. That is a much
  // smaller advantage than the one removed here, and closing it properly means
  // moving skill definitions server-side.
  applySkillEffect(socketId, enemyId, type, duration) {
    const caster = this.players.get(socketId);
    if (!caster || caster.hp <= 0) return false;
    const enemy = this._enemyMap.get(enemyId);
    if (!enemy || enemy.hp <= 0) return false;
    // The same "you may only touch your own instance" rule the damage path and
    // the streaming path both use.
    if (!this._raceVisible(caster, enemy)) return false;
    const dx = caster.x - enemy.x, dy = caster.y - enemy.y;
    const reach = CC_REACH + (enemy.size || 0);
    if (dx * dx + dy * dy > reach * reach) return false;
    if (!this._hasLOS(caster.x, caster.y, enemy.x, enemy.y)) return false;
    if (type === 'stun') enemy.stunTimer = Math.min(duration, 6);
    else if (type === 'slow') enemy.slowTimer = Math.min(duration, 6);
    // "Охота" (advanced deathknight R, js/player.js) — same 6s cap as
    // stun/slow above, applied in attackEnemy/skillAttackEnemy's own damage
    // calc (defDownTimer > 0 → 20% off this enemy's def for that hit).
    else if (type === 'defDown') enemy.defDownTimer = Math.min(duration, 6);
    else return false;
    return true;
  }

  // Capped: the id list comes straight from a client packet (up to the 512 KB
  // socket.io message limit) and this loop runs on the same thread as the world
  // tick, so an oversized array is a direct way to stall the whole room. No
  // real AoE touches anywhere near this many enemies.
  //
  // Returns the ids that ACTUALLY took the effect, so the visual echoed to
  // everyone nearby describes what happened rather than what was asked for.
  applySkillEffectMany(socketId, enemyIds, type, duration) {
    if (!Array.isArray(enemyIds)) return [];
    const n = Math.min(enemyIds.length, MAX_CC_TARGETS);
    const hit = [];
    for (let i = 0; i < n; i++) {
      if (this.applySkillEffect(socketId, enemyIds[i], type, duration)) hit.push(enemyIds[i]);
    }
    return hit;
  }

  healPartyMember(socketId, amount) {
    const p = this.players.get(socketId);
    if (!p || p.hp <= 0) return false;
    if (!Number.isFinite(amount)) return false;   // see healPlayer above
    p.hp = Math.min(p.maxHp, p.hp + Math.max(0, amount));
    return true;
  }

  // Are these two players close enough to share party rewards/heals? Both
  // must actually be in this room. Used by the kill-reward split and the
  // party heal in server/index.js — the world is a single shared floor, so
  // "same floor" was never a real proximity check and a party member parked
  // anywhere on the map still collected a full share.
  //
  // Distance alone isn't enough once private instances exist: adjacent
  // race10/Fear lanes sit only PARTY_SHARE_R-ish apart in world space (walls
  // between them are what keeps a player from actually reaching their
  // neighbour, not distance), so two party members in neighbouring — but
  // otherwise fully isolated — lanes could still "share" kills through the
  // wall. _playerLaneKey is the same identity _raceVisible/nearbyPlayerIds
  // already gate visibility on; requiring it to match here closes that gap.
  arePlayersNear(socketIdA, socketIdB) {
    const a = this.players.get(socketIdA);
    const b = this.players.get(socketIdB);
    if (!a || !b) return false;
    if (this._playerLaneKey(a) !== this._playerLaneKey(b)) return false;
    const dx = a.x - b.x, dy = a.y - b.y;
    return dx * dx + dy * dy <= PARTY_SHARE_R2;
  }

  stop() { clearInterval(this._interval); }
}

module.exports = Room;
// Also reachable as Room.computeStats — server/index.js's calcBM (rating/BM
// display) needs the exact same authoritative atk/def/maxHp this class
// already trusts for combat and the statsUpdate anti-cheat ceiling, rather
// than duplicating (and inevitably drifting from) its own copy.
module.exports.computeStats = computeStats;
