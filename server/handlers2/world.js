'use strict';
// ── Movement, combat, floors ────────────────────────────────────────────────
// The hot path. Unlike every other file in handlers2, most of what happens
// here does NOT touch the database: movement and combat run against the Room's
// in-memory world at 40Hz, and going to Postgres per packet would put a round
// trip inside the simulation loop.
//
// So the split is explicit and worth stating, because getting it wrong in
// either direction is a bug:
//
//   IN MEMORY, per packet   position, facing, aggro, hit resolution, the
//                           enemy's current HP. All of it is reconstructible:
//                           if the process dies, the world regenerates from a
//                           fixed seed and players respawn at their last saved
//                           floor. Losing it costs seconds, not progress.
//
//   IN POSTGRES, per event  anything a player KEEPS. XP from a kill, gold,
//                           the item that dropped, their own HP when it
//                           changes meaningfully. These are written as they
//                           happen, not accumulated in a session and flushed.
//
// The old build blurred that line — kill gold accumulated in a per-connection
// variable and was reconciled against a save blob, so an unclean disconnect
// lost it. Here a kill's reward is a transaction at the moment of the kill.

const players = require('../db/repos/players');
const stats = require('../db/repos/stats');
const consumables = require('../db/repos/consumables');
const progression = require('../db/repos/progression');
const clans = require('../db/repos/clans');
const plog = require('../db/repos/playerlog');
const ops = require('../tg-ops');
const { NC_FACING, NC_AOE_STYLES } = require('../../shared/netcodec');
const party = require('../party');
const loot = require('../game/loot');
const { query } = require('../db');
const {
  CHAR_DEF, FEAR_MAX_WAVE,
  VIP_BONUSES, SEASON_TICKET_DROP_PCT, SEASON_TICKET_XP_PCT, SEASON_TICKET_LIBERTY_PCT, seasonActive,
  NEXUM_DROP_CHANCE, FARM2_LIBERTY_CHANCE, COOP_LIBERTY_CHANCE,
  GRAM_DROP_CHANCE, GRAM_PER_LEVEL, armIndexForLevel, clanBonusOf,
} = require('../../shared/definitions');

// crypto, not Math.random: these rolls decide whether a boss drops a rare box,
// and a rare box is worth real money on the market. V8's generator has a state
// recoverable from a handful of outputs.
const rand = () => require('crypto').randomInt(2 ** 30) / (2 ** 30);

const fail = (msg, code) => { throw Object.assign(new Error(msg), { userMessage: msg, code }); };

// Projectile shapes the client may ask other clients to draw. A closed set,
// because it is interpolated into a sprite lookup on the receiving side.
const PROJ_TYPES = new Set(['arrow', 'ball']);

module.exports = function registerWorld(s, safeOn, deps) {
  // One cast at a time per connection. Held here rather than on the session so
  // it is cleared with the handlers when the socket goes.
  let teleportTimer = null;
  const { io, enterFloor, floorIdOf, resolveFloor } = deps;

  // ── character selection ──────────────────────────────────────────────────
  // The class is written once and never again: setClass has `AND char_class IS
  // NULL` in its WHERE, so a second selectChar cannot re-roll a character into
  // a different class and keep the level.
  safeOn('selectChar', async ({ type } = {}) => {
    // `landed` rather than act()'s own return value: act logs `out` into
    // player_logs through _resultMeta, and changing what a handler returns
    // changes what that row says.
    let landed = false;
    await s.act('selectChar', 'authError', async (t, pid) => {
      const prog = await players.progressOf(t, pid);
      if (!prog.charClass) {
        // ── the class gate, and why it is a membership test ────────────────
        // Object.hasOwn, not `CHAR_DEF[type]`. CHAR_DEF is a plain object
        // literal (shared/definitions.js) and so inherits Object.prototype:
        // 'constructor', '__proto__', 'toString', 'valueOf' and
        // 'hasOwnProperty' each answer something TRUTHY that is not a class,
        // and this handler is handed whatever JSON the socket carried — so
        // the client picks the key. This is the same mistake
        // players.js already documents twice, at PREF_FIELDS and at UPG_COL,
        // whose comment names 'constructor' outright.
        //
        // What it cost HERE is not a crash. setClass wrote the key, and every
        // later read of CHAR_DEF[type] — baseHP/baseAtk/baseDef, in
        // Room.setPlayerChar and computeStats — is undefined, so maxHp, atk
        // and def all come out NaN. Damage is applied as
        // Math.max(0, hp - dmg), and `NaN <= 0` is FALSE: the player never
        // dies. Not to monsters, not in open PvP, not in the death battle —
        // which pays its winner GRAM, the real-money currency — and not in
        // arena3 or race10, all three of which they sweep by outlasting the
        // field. Their atk is NaN as well, so the first enemy they touch gets
        // NaN hp and becomes unkillable for everyone else on the floor.
        //
        // And it is IRREVERSIBLE: setClass has `AND char_class IS NULL` in its
        // WHERE, so the row can never be re-rolled. Nothing short of an
        // operator's UPDATE recovers the account — which is exactly why the
        // check belongs at the front door and not only at the far end where
        // the value is finally read.
        //
        // The typeof is part of the check, not decoration. Property keys are
        // coerced to strings, so Object.hasOwn(CHAR_DEF, ['lev']) is TRUE, and
        // it would be that array — not the string — that setClass then binds
        // into char_class.
        if (typeof type !== 'string' || !Object.hasOwn(CHAR_DEF, type)) {
          fail('Неизвестный класс', 'bad_class');
        }
        await players.setClass(t, pid, type);
      }
      // Everything the client needs to build the world, from the database. The
      // old gameStart carried a savedData blob the client had sent moments
      // earlier; this carries what is actually stored.
      await sendGameStart(t, null);
      landed = true;
    });
    // Outside the transaction on purpose: this moves the connection between
    // two Rooms and pushes a second gameStart, none of which belongs inside a
    // database transaction, and it must not run at all if the login failed.
    if (landed) _resumeHeldFearRun();
  });

  // ── a Страх run held across a disconnect ─────────────────────────────────
  // This is where a reconnect inside FEAR_RECONNECT_GRACE_MS gets its run
  // back, and it is the half that never came across in the rewrite: the
  // disconnect side held the record and expired it, and nothing claimed it.
  // See _fearClaimOnReconnect (server/game/fear.js) for what that cost.
  //
  // It has to happen HERE rather than inside enterFloor, because the fear
  // floor is deliberately not STANDABLE (server/world.js): resolveFloor sends
  // a stored fear floor to the hub, which is right for someone whose run is
  // genuinely over, and the private Room a live run is happening in is not in
  // floorRooms for anyone to walk into anyway. The only handle on it is the
  // held record itself, which carries the Room.
  function _resumeHeldFearRun() {
    const m = deps.modes || require('../modes').modes;
    if (!m || typeof m._fearClaimOnReconnect !== 'function') return;
    const run = m._fearClaimOnReconnect(s.telegramId);
    if (!run || !run.room) return;

    // forceFloor's addPlayer is what reclaims the HALL (Room._fearGraceClaim),
    // so nothing about the run can be trusted until after the move. The two
    // windows are the same length and start together, so they can only ever
    // disagree by a hair — but a run record pointing at a hall this player
    // does not own is the state fearEnter refuses forever, so it is checked
    // rather than assumed.
    const p = s.forceFloor('fear', { room: run.room });
    const held = !!p && run.room.fearLaneOf(s.socket.id) === run.lane;
    if (!held) {
      plog.log(s.playerId, 'refuse:fearResume', {
        wave: run.wave, lane: run.lane, code: p ? 'hall_released' : 'move_failed',
      });
      const spot = p ? deps._returnToHub(s.socket.id) : null;
      // Told, not just logged: the client's own HUD still says "in run" from
      // before the drop, and only a fearFinished clears it.
      s.socket.emit('fearFinished', {
        cleared: false, wave: run.wave, x: spot && spot.x, y: spot && spot.y,
      });
      return;
    }

    m._fearResumeRun(s.socket.id, run);
    plog.log(s.playerId, 'fearResume', { wave: run.wave, lane: run.lane });
    // wave 0 means the drop happened inside the pre-fight countdown, and the
    // timer that would have spawned wave 1 is a closure over a socket id that
    // no longer exists — it no-ops by design (see fearEnter, handlers2/
    // modes.js). Resuming a countdown nobody was watching would just be a
    // second wait, so the wave starts now.
    if (run.wave > 0) s.socket.emit('fearWave', { wave: run.wave, maxWave: FEAR_MAX_WAVE });
    else m._fearStartWave(run.room, s.socket.id, run.lane, 1);
  }

  // Login, a floor change and a respawn are the same event to the client: a
  // full 'gameStart' for wherever it now is. The rewrite had invented
  // 'floorChanged' and 'respawned' for the latter two, and nothing in the
  // shipped bundle listens for either — walking through a portal loaded the
  // new floor's enemies onto a client still drawing the old map.
  async function sendGameStart(t, wanted) {
    const state = await s.fullState(t);
    // The floor is RE-CHECKED rather than trusted, because the world can have
    // moved on while the player was away — they may have rebirthed below an
    // arm's level requirement, or a timed zone may have closed.
    const want = wanted == null ? state.progress.floor : wanted;
    const floor = enterFloor(s, want, state.progress);
    // The room's copy of the numbers, immediately after the join. enterFloor
    // sets the class from the catalog's base figures; these are the ones that
    // decide damage, and a player who joined a floor without them fought at
    // their class's level-1 baseline until the next equip.
    if (s.room && state.stats) {
      s.room.setPlayerStats(s.socket.id, state.stats);
      s.room.setPlayerHp(s.socket.id, state.stats.hp);
    }
    s.socket.emit('gameStart', { ...state, ...s.worldPayload(floor) });
    // The pets already out on this floor, and then ours to everyone else.
    // Both directions matter: joining a floor should not blank the pets that
    // were there, and arriving with one should not require the owner to
    // re-equip it before anybody sees it.
    if (s.room && s.room.petSnapshot) {
      s.socket.emit('playerPets', { pets: s.room.petSnapshot() });
    }
    s.syncPet(state.items && state.items.equipment);
    return floor;
  }


  // ── movement ─────────────────────────────────────────────────────────────
  // No transaction, no database. The position is written by the session's
  // timer and on disconnect — 40 writes a second per player, for a value whose
  // worst case is a few metres of walking, is not a trade worth making.
  //
  // updatePlayerPos now refuses a step into geometry and returns the last good
  // position; that refusal has to reach the client, or the two silently
  // disagree about where the player is and every subsequent packet is judged
  // against the wrong origin.

  // ── which way the player is looking, as an allowlist ─────────────────────
  // The same shape as the class gate above, one packet type down. `facing`
  // arrives two ways — as an INDEX into NC_FACING from the packed 'mv' form,
  // as one of the eight NAMES from 'playerMove' — and neither was checked:
  // 'mv' did `NC_FACING[a[2]] || 'front'`, which reads as a fallback and is
  // not one, because NC_FACING is an Array and so NC_FACING['constructor'] is
  // the Array constructor — truthy, so the `||` never fires — while
  // 'playerMove' handed its string through untouched, so `facing: 'lol'` was
  // simply stored.
  //
  // Room.updatePlayerPos writes this verbatim onto the player record, and the
  // ONE thing that has kept a non-name off the wire is a clamp in a different
  // file: encodeGameState (shared/netcodec.js) sends
  // Math.max(0, NC_FACING.indexOf(p.facing)), which turns anything unknown
  // into 0 — 'front'. That clamp is why this has never been visible, and it
  // is not a check: it is one `indexOf` in a codec, standing in for a rule
  // nobody wrote. The moment a player's facing reaches a client as JSON
  // instead (the nearPlayers entries Room.js builds are already objects with
  // the raw value in them), getOtherPlayerAnimKey (js/game.js) builds
  // `${facing}-idle` from it and _playerTextures (js/pixi-world.js) answers
  // null for a key no sprite sheet has — the branch that sets
  // spr.visible = false. A garbage `facing` is an invisible player, and an
  // invisible player in the death battle or the 3v3 arena is the match.
  //
  // Integers are safe to index with (they cannot name a prototype key) so the
  // index form stays a lookup; the name form is a membership test.
  const facingOf = (v) => {
    if (Number.isInteger(v)) return NC_FACING[v] || 'front';
    return NC_FACING.includes(v) ? v : 'front';
  };

  function applyMove(x, y, facing, moving) {
    if (!s.room) return;
    // Normalised HERE rather than in each handler, so a third movement packet
    // added later cannot get into the room without passing the same gate.
    const res = s.room.updatePlayerPos(s.socket.id, x, y, facingOf(facing), moving);
    if (res && res.refused) {
      s.socket.emit('posCorrect', { x: res.x, y: res.y, reason: res.refused });
    }
  }

  // The packed form: [x*2, y*2, facingIndex, hp, moving]. Coordinates are
  // halved on the wire (see shared/netcodec.js) so they fit a smaller integer.
  safeOn('mv', (a) => {
    if (!Array.isArray(a) || a.length < 4) return;
    applyMove(a[0] / 2, a[1] / 2, a[2], a.length > 4 ? !!a[4] : undefined);
  });

  safeOn('playerMove', ({ x, y, facing, moving } = {}) => applyMove(x, y, facing, moving));

  // ── combat ───────────────────────────────────────────────────────────────
  // The client names WHICH enemy. Everything else — range, line of sight,
  // cooldown, instance isolation, the damage number — is the room's, and the
  // attacker's stats come from setPlayerStats, which came from the database.
  //
  // A kill writes its reward immediately. Not queued, not accumulated: the
  // mob is dead and the xp is owed now, and an unclean disconnect a second
  // later must not undo that.
   // ── a monster dies ───────────────────────────────────────────────────────
  // The rewrite credited the reward to the database and told NOBODY. There was
  // no 'enemyKilled' anywhere in it, and that one omission is every symptom
  // the players reported:
  //
  //   "после смерти не исчезают"  — the corpse is removed when this arrives
  //   "опыт не идёт с монстров"   — the xp number is drawn from this packet
  //   "золото возвращается"       — the client's own count is set from it
  //
  // The gold and the experience were in the database the whole time. Nothing
  // was lost; nothing was shown either, which to a player is the same thing.
  //
  // Three audiences, and they get different packets:
  //   the killer   everything — reward, damage, loot
  //   the party    their share of the same kill
  //   bystanders   the id and the position, so the body disappears for them too
  function rollLoot(result, playerLevel) {
    // The roll happens against a SCRATCH inventory: the loot tables were
    // written to add straight into the player's array, and the array is not
    // the player's any more. What comes back is a list, and the repository
    // decides whether each item fits — an item that does not lands on the
    // floor rather than being destroyed.
    const scratch = [];
    const out = { items: [], boxUncommon: 0, boxRare: 0, normStone: 0, blessStone: 0 };
    if (result.arm === 'coop') return out;

    if (result.farmZone) out.items = loot._rollFarmZoneLoot(scratch, result.eid) || [];
    else if (result.farmZone2) out.items = loot._rollFarm2Loot(scratch) || [];
    else out.items = loot._rollMobLoot(scratch, result.eid, result.rlvl, playerLevel) || [];

    // VIP and the season ticket buy a second roll, not a better one — the same
    // table, one more chance at it.
    const bonus = (VIP_BONUSES[s.vipLevel || 0] || VIP_BONUSES[0] || {}).drop || 0;
    const ticket = (s.seasonTicket && seasonActive()) ? (SEASON_TICKET_DROP_PCT || 0) : 0;
    const extra = bonus + ticket;
    if (!result.farmZone && !result.farmZone2 && extra > 0 && rand() * 100 < extra) {
      out.items.push(...(loot._rollMobLoot([], result.eid, result.rlvl, playerLevel) || []));
    }

    if (result.isBoss && !result.farmZone2) {
      // crypto, not Math.random: a rare box is worth real money on the market.
      const hit = chance => rand() < chance;
      if (hit(0.50)) { out.boxUncommon = 1; out.items.push({ id: 'box_uncommon', qty: 1 }); }
      if (hit(0.10)) { out.boxRare = 1;     out.items.push({ id: 'box_rare', qty: 1 }); }
      if (hit(0.10)) { out.normStone = 1;   out.items.push({ id: 'norm_stone', qty: 1 }); }
      if (hit(0.01)) { out.blessStone = 1;  out.items.push({ id: 'bless_stone', qty: 1 }); }
    }
    return out;
  }

  // ── what a clan point means outside the transaction ───────────────────────
  // Two states the committed row can be in that the session's cached badge
  // cannot represent, and neither may pass in silence.
  async function afterClanXp(clanId, res) {
    try {
      // The clan is gone. Its leader disbanded it while this player was
      // mid-fight and the cached id outlived it, so addXp matched no row and
      // answered null — ordinary, not an error. What is NOT ordinary is going
      // on offering the same dead id on every subsequent kill, so the badge is
      // dropped here and the fact that a point went nowhere leaves a row.
      if (!res) {
        plog.log(s.playerId, 'clanXpOrphan', { clanId });
        await s.refreshClan();
        return;
      }
      // A level is the only part of clan xp anyone can see, and it is not
      // cosmetic: CLAN_LEVELS grants +atk% (clanAtkBonusPct), which reaches
      // combat only through Room.setPlayerClan — Room.js has no database of
      // its own. Told to nobody, a level-up is a perk that stays inert until
      // every member happens to relog, which is the same shape as the xp that
      // was never awarded in the first place.
      if (!s.clan || res.level === s.clan.level) return;
      const view = await clans.fullView(null, clanId);
      for (const m of (view.members || [])) {
        const sock = deps.socketForPlayerId && deps.socketForPlayerId(m.playerId);
        if (!sock || !sock.data || !sock.data.session) continue;
        // Their own session re-reads the badge — that is what puts the new
        // atk% onto their Room player — and their panel is refreshed FROM the
        // database rather than told a number to remember.
        await sock.data.session.refreshClan();
        sock.emit('clanData', await clans.dataView(null, clanId, m.playerId));
      }
    } catch (err) {
      // Committed either way: the point is in the row. Only the announcement
      // failed, and an announcement nobody hears is precisely the failure this
      // whole path exists to stop being silent about.
      ops.alertError('clanXp.announce', 'Не удалось разослать уровень клана', err,
        { clanId, player: s.username }).catch(() => {});
    }
  }

  async function onKill(result) {
    if (!result || !result.killed) return;

    // Everyone who can see the body, whether or not they are owed anything.
    // Sent FIRST and outside the transaction: a database hiccup must not leave
    // a corpse standing on twelve screens.
    if (s.room && typeof s.room.viewersOfEnemy === 'function') {
      const others = s.room.viewersOfEnemy(result.enemyUid, s.socket.id);
      if (others && others.length) {
        io.to(others).emit('enemyKilled', {
          id: result.enemyUid, ex: result.ex, ey: result.ey, color: result.color,
        });
      }
    }

    // A guild-war tower is captured rather than killed, and a race boss ends
    // the round — neither pays a reward.
    if (result.captured || result.raceBoss) {
      s.socket.emit('enemyKilled', {
        id: result.enemyUid, ex: result.ex, ey: result.ey, color: result.color,
        dmg: result.dmg, isCrit: result.isCrit,
      });
      if (result.captured && deps.modes && deps.modes._gwApplyCapture) deps.modes._gwApplyCapture(result);
      return;
    }

    // Shares. A party splits the kill; the divisor is the whole party, so
    // soloing is never worse than grouping by accident.
    const partyId = party.playerParty.get(s.socket.id);
    const members = partyId ? party.parties.get(partyId) : null;
    const mates = members
      ? [...members.keys()].filter(id => id !== s.socket.id && s.room && s.room.players.has(id))
      : [];
    const share = mates.length + 1;
    const baseGold = Math.round((result.gold || 0) / share);
    const baseXp = share > 1 ? Math.max(1, Math.round((result.xp || 0) / share)) : (result.xp || 0);

    // ── VIP and the season ticket, on the numbers they were written for ─────
    // VIP_BONUSES has three columns — xp, gold, drop — and only `drop` was ever
    // read. SEASON_TICKET_XP_PCT (x2 experience, the headline of the card) and
    // SEASON_TICKET_LIBERTY_PCT were not read anywhere at all. So VIP 10 paid
    // exactly what VIP 0 paid, and a bought season card doubled nothing:
    // "Вип бонусы, бонусы от сезонной карты не работают."
    //
    // Additive between the two, applied to the share this player receives so a
    // party member's VIP is theirs and not the group's.
    const vipB = VIP_BONUSES[s.vipLevel || 0] || VIP_BONUSES[0] || {};
    const ticketOn = !!(s.seasonTicket && seasonActive());
    // The clan's two thirds of the same idea. CLAN_LEVELS lists gold, xp and
    // atk at every level; only atk had a reader, so the tags the clan panel
    // prints — "+15% золото", "+10% опыт" — were decoration. Additive with VIP
    // and the ticket, like everything else here.
    const clanB = clanBonusOf(s.clan && s.clan.level);
    const xpPct = (vipB.xp || 0) + (ticketOn ? (SEASON_TICKET_XP_PCT || 0) : 0) + clanB.xp;
    const goldPct = (vipB.gold || 0) + clanB.gold;
    const myGold = Math.round(baseGold * (1 + goldPct / 100));
    const myXp = Math.round(baseXp * (1 + xpPct / 100));

    // ── Liberty from the kill ───────────────────────────────────────────────
    // `result.nexum` is read three lines below, passed to grantKillReward and
    // emitted to the client — and nothing has ever assigned it. The chance
    // table was a local const in the retired handler file and did not come
    // across, so Liberty has never dropped from a monster in this build.
    //
    // The season card's third promise is here: +10% RELATIVE to the chance,
    // which is what SEASON_TICKET_LIBERTY_PCT is for and where it was never
    // read.
    // Every zone with a table of its own is tested BEFORE the corridor table,
    // and co-op is first because it is the one that reads as working without
    // its branch: a co-op monster still has an rlvl, so armIndexForLevel gives
    // a perfectly ordinary corridor number and NEXUM_DROP_CHANCE[arm] pays
    // out at 0.5%-5% by stage instead of the flat COOP_LIBERTY_CHANCE. That
    // is the whole reward of a co-op kill (no gold, no GRAM — see calcGoldDrop
    // and myGram below), paying a twentieth of what it says on stage one, with
    // the constant that says so sitting unread in server/game/coop.js.
    //
    // The season ticket's +10% stays on the corridor branch alone: it buys a
    // better chance at the open world's Liberty, not at a fixed per-zone rate
    // the mode's own balance is built on.
    const arm = armIndexForLevel(result.rlvl || 1);
    const libertyChance = result.arm === 'coop' ? (COOP_LIBERTY_CHANCE || 0)
      : result.farmZone2 ? (FARM2_LIBERTY_CHANCE || 0)
      : result.farmZone ? 0
      : (NEXUM_DROP_CHANCE[arm] || 0) * (ticketOn ? 1 + (SEASON_TICKET_LIBERTY_PCT || 0) / 100 : 1);
    const myNexum = (result.nexum || 0) || (rand() < libertyChance ? 1 : 0);

    // GRAM, the real-money currency. Not from the farm zones and not from the
    // co-op run — those pay their own fixed rewards — and, like Liberty, its
    // chance table never came across from the retired handler file, so
    // `result.gram` was emitted to the client while nothing set it.
    const myGram = (result.farmZone || result.farmZone2 || result.arm === 'coop') ? 0
      : (rand() < (GRAM_DROP_CHANCE || 0) ? (result.rlvl || 1) * (GRAM_PER_LEVEL || 0) : 0);

    // One key per KILL, not per enemy and not per attempt.
    //
    // Keyed on the enemy id alone, a respawning monster paid once and never
    // again: the id is stable across respawns, so the ledger already held that
    // key and money.credit correctly treated the second kill as a replay of the
    // first. Every farmed spawn silently stopped paying — which is what "мобы и
    // не засчитывание" was.
    //
    // `result.at` is stamped inside attackEnemy at the moment of the kill, so it
    // is the same value across a txRetry — which is the case the key exists for
    // — and different for every actual kill.
    const idem = `kill:${s.playerId}:${result.enemyUid}:${result.at || 0}`;

    // The killer's clan, read off the session rather than the database. It is
    // the KILLER's only: the retired build awarded one point per monster to
    // whoever landed the blow (_onKillClanXp, server/handlers/world.js) and
    // the party share below deliberately does not pass it, because paying each
    // member would multiply the rate CLAN_LEVELS is scaled against by the size
    // of the group.
    const myClanId = (s.clan && s.clan.clanId) || null;

    // The transaction decides what happened; the packet reports it AFTERWARDS.
    // Emitting from inside meant the client was told its new balance before the
    // commit — and if anything downstream rolled the transaction back, the
    // number on screen was one the database never held. A player watching gold
    // appear and then revert on the next push is describing exactly that.
    const done = await s.act('killReward', 'itemError', async (t, pid) => {
      const prog = await players.progressOf(t, pid);
      const drops = rollLoot(result, prog.lvl);

      // ── the two buff potions that did nothing ──────────────────────────────
      // Six buff potions exist; three were written into player_progress.buffs
      // and never read anywhere. `hp`, `atk` and `atkspeed` are applied in
      // repos/stats.js — `exp` (x2 опыт), `gold` (x2 золото) and `regen` were
      // not applied at all, so half the potions in the game were sold, bought,
      // dropped and drunk for no effect: "зелья бафов не работают".
      //
      // Read from the progress row already fetched a line above, so this costs
      // nothing extra, and applied to THIS player's share — a potion is the
      // drinker's, not the party's.
      const nowMs = Date.now();
      const buffOn = t2 => Number((prog.buffs || {})[t2] || 0) > nowMs;
      const paidGold = buffOn('gold') ? myGold * 2 : myGold;
      const paidXp = buffOn('exp') ? myXp * 2 : myXp;

      const reward = await consumables.grantKillReward(t, pid, {
        gold: paidGold, xp: paidXp, nexum: myNexum, gram: myGram,
        drops: drops.items, idemKey: idem, clanId: myClanId,
      });
      // The quest chain. `result.enemyName` — the field the rewrite passed here
      // — has never existed on a kill result, so this branch was dead and the
      // whole 60-quest chain sat at zero for everyone. The species is decided
      // from `eid`, which the result does carry.
      const quest = await progression.questOnKill(t, pid, { eid: result.eid, rlvl: result.rlvl });
      if (quest) s.socket.emit('questSync', quest);
      let refBonus = null;
      // The stats.refreshBm that used to be here has moved into
      // players.grantXp. It was the only refresh in the build, and it sat on
      // ONE level-up path of four: the party share below, claimQuest and
      // completeSpecialQuest all raise a level through the same repository
      // function and none of them reached this line, so a player who levelled
      // in a group or off a quest kept the rating they had before.
      if (reward.xp && reward.xp.levelsGained > 0) {
        // Crossing level 20 pays whoever invited this player their season
        // points — once, ever. Nothing called this in the rewrite, so an
        // invited friend could hit the threshold and the referrer was neither
        // paid nor told.
        refBonus = await progression.payReferralOnLevel(t, pid, reward.xp.lvl || 0);
      }
      return { reward, drops, refBonus, paidGold, paidXp };
    });
    if (!done) return;                      // act reported it; nothing happened

    const { reward, drops, refBonus } = done;
    // The referrer is a different session and may be offline entirely. The
    // room emit reaches every device they have open and is dropped when there
    // are none — the points themselves are already committed either way.
    if (refBonus) {
      io.to(`tg_${refBonus.referrerTelegramId}`).emit('seasonRefBonus', {
        points: refBonus.points, friend: refBonus.friend, total: refBonus.total,
      });
    }
    // Pushes read the database on their own connection now, which is the point:
    // everything below describes committed state.
    if (reward.xp && reward.xp.levelsGained > 0) {
      await s.pushStats(); await s.pushProgress();
    }
    await s.pushBalances();
    if (reward.items.length) await s.pushItems();

    s.socket.emit('enemyKilled', {
      id: result.enemyUid, at: result.at,
      gold: done.paidGold, goldTotal: reward.gold,
      xp: done.paidXp, level: reward.xp || null,
      dmg: result.dmg, isCrit: result.isCrit,
      ex: result.ex, ey: result.ey, color: result.color,
      eid: result.eid, rlvl: result.rlvl,
      items: reward.items.filter(i => !i.dropped),
      boxUncommon: drops.boxUncommon, boxRare: drops.boxRare,
      normStone: drops.normStone, blessStone: drops.blessStone,
      nexum: myNexum, gram: myGram,
    });

    // What would not fit stays on the floor. The reward for a kill is not owed
    // anywhere else, so it is not destroyed over a missing slot.
    for (const it of reward.items) {
      if (it.dropped && s.room) {
        s.room.spawnWorldDrops([{ id: it.id, qty: it.qty || 1 }], result.ex, result.ey);
      }
    }

    // AFTER the killer has been paid and told. The clan point is committed
    // either way; what happens here is a broadcast to other people's sessions,
    // and on the two rare branches it costs several queries — none of which
    // this player's own kill should be waiting behind.
    if (myClanId) await afterClanXp(myClanId, reward.clanXp);

    // Party members are paid on their own sessions, each in its own
    // transaction: one member's full inventory must not undo another's gold.
    for (const mid of mates) {
      const mate = deps.sessionForSocketId && deps.sessionForSocketId(mid);
      if (!mate || !mate.authed) continue;
      mate.act('killRewardShare', 'itemError', async (t, pid) => {
        // Their own VIP, their own season ticket, their own potions. Paying a
        // party member the KILLER's multipliers would make a group's rewards
        // depend on who landed the last hit.
        const mProg = await players.progressOf(t, pid);
        const mNow = Date.now();
        const mBuff = t2 => Number((mProg.buffs || {})[t2] || 0) > mNow;
        const mVip = VIP_BONUSES[mate.vipLevel || 0] || VIP_BONUSES[0] || {};
        const mTicket = !!(mate.seasonTicket && seasonActive());
        // Their own clan too, for the same reason as their own VIP: a member
        // of a level 10 clan grouped with someone clanless keeps their bonus,
        // and does not lend it out.
        const mClan = clanBonusOf(mate.clan && mate.clan.level);
        const mXpPct = (mVip.xp || 0) + (mTicket ? (SEASON_TICKET_XP_PCT || 0) : 0) + mClan.xp;
        const mGold = Math.round(baseGold * (1 + ((mVip.gold || 0) + mClan.gold) / 100)) * (mBuff('gold') ? 2 : 1);
        const mXp = Math.round(baseXp * (1 + mXpPct / 100)) * (mBuff('exp') ? 2 : 1);
        const r = await consumables.grantKillReward(t, pid, {
          gold: mGold, xp: mXp, drops: [], idemKey: `kill:${pid}:${result.enemyUid}:${result.at || 0}`,
        });
        const mq = await progression.questOnKill(t, pid, { eid: result.eid, rlvl: result.rlvl });
        if (mq) mate.socket.emit('questSync', mq);
        await mate.pushBalances(t);
        if (r.xp && r.xp.levelsGained > 0) { await mate.pushStats(t); await mate.pushProgress(t); }
        mate.socket.emit('enemyKilled', {
          id: result.enemyUid, gold: mGold, goldTotal: r.gold,
          xp: mXp, level: r.xp || null,
          ex: result.ex, ey: result.ey, color: result.color,
          eid: result.eid, rlvl: result.rlvl,
        });
      }).catch(() => { /* act reports it; one mate's failure is not the kill's */ });
    }
  }

  // A tower you may not attack answers with a reason. Returning in silence
  // left the player swinging at a castle that never lost hp and never said
  // why — which reads as the game being broken rather than as a rule.
  function immuneMsg(res) {
    if (res.reason === 'closed') return 'Война гильдий сейчас закрыта — замок неуязвим';
    if (res.reason === 'no_clan') return 'Нужен клан, чтобы атаковать замок';
    return 'Нельзя атаковать свой замок';
  }

  // Both attack paths do the same four things in the same order, and the old
  // build's two copies drifted apart twice. One function, called twice.
  function resolveHit(enemyId, res) {
    if (!res) return;
    if (res.immune) { s.socket.emit('guildWarError', { msg: immuneMsg(res) }); return; }
    // Every mode's stake in this hit — wave counters, the race tally, co-op
    // stages, the floor boss's respawn clock. Only the race boss's death
    // claims the hit outright.
    if (deps.modes && deps.modes._onCombatResult
        && deps.modes._onCombatResult(s.socket.id, enemyId, res, s.room)) return;
    // A killing blow returns no `hp` — the kill branch has nothing left to
    // report — so sending it anyway set the client's copy to undefined for the
    // instant between this packet and enemyKilled.
    if (!res.killed) {
      s.socket.emit('enemyHurt', { id: enemyId, hp: res.hp, dmg: res.dmg, isCrit: res.isCrit });
      return;
    }
    onKill({ ...res, enemyUid: enemyId });
  }

  safeOn('attack', ({ enemyId, splash } = {}) => {
    if (!s.room || !s.authed) return;
    // splash: "Безумие" (advanced deathknight E) — a half-damage hit that
    // rides along with a real one. Dropping the flag turned it into a second
    // full-strength attack.
    //
    // The flag is a REQUEST and nothing more, and it is worth saying so here,
    // because reading only these lines is what produced the exploit report:
    // `splash: true` off the wire was a free half-damage hit for every class
    // at level one, as many of them per swing as the socket limiter allowed.
    // The three things that decide it — may this player splash at all
    // (Room._canSplash: deathknight, E studied, the book learned AND the
    // toggle on), how soon after a real swing, and how many per swing — are
    // all in Room.attackEnemy, and they belong there rather than here: two of
    // them are per-swing state on the room's own player record, and the third
    // reads the skill levels setPlayerStats pushed down from the database.
    // This handler knows nothing the room does not, so a check here could only
    // be a second, drifting copy of that one.
    resolveHit(enemyId, s.room.attackEnemy(s.socket.id, enemyId, { splash: !!splash }));
  });

  safeOn('skillAttack', ({ enemyId, key } = {}) => {
    if (!s.room || !s.authed) return;
    // The multiplier is derived from the slot and the player's own studied
    // level, on this side. The client used to send a number, which is a value
    // somebody edits.
    resolveHit(enemyId, s.room.skillAttackEnemy(s.socket.id, enemyId, key));
  });

  // ── death and respawn ────────────────────────────────────────────────────
  // Respawn restores HP in the database as well as the room, because HP is
  // one of the few live values that is also persisted — a player who dies and
  // reconnects must not come back still dead.
  safeOn('respawn', () => s.act('respawn', 'itemError', async (t, pid) => {
    // ── only the dead may respawn ──────────────────────────────────────────
    // There was no check of any kind here. This handler is a full heal in the
    // room AND in player_progress, plus a free ride to floor 1, and it sits in
    // the 40-per-5s bucket — so any living player could top themselves up on
    // demand, mid-fight, and do it again two seconds later. In PvP, in the
    // death battle, in the 3v3 arena and in Страх that is not a convenience,
    // it is the whole fight.
    //
    // It also obsoleted the sanctioned way home. useTeleportStone (below)
    // burns an item that costs 20 Liberty, refuses when already in the hall,
    // refuses while dead, and holds the player still for a cast timer.
    // 'respawn' did the same journey for free, instantly, with a heal on top,
    // and the stone's whole price is the fact that there is no other way.
    //
    // The ROOM is the authority on death, and it is the only one there is.
    // player_progress.hp cannot be used for this: the two writers are this
    // handler (which writes maxHp) and Session.savePosition, which writes hp
    // only `if (p.hp > 0)` — so that column holds the last POSITIVE hp the
    // account was seen with and is never 0. Testing `st.hp <= 0` would refuse
    // every genuine respawn in the game.
    //
    // ── and why the refusal talks back ─────────────────────────────────────
    // The two sides can honestly disagree, and the disagreement is routine on
    // mobile: a player dies, the socket drops before they press anything, and
    // the re-join seats their room hp from that same never-zero column — so
    // the server has them alive while their client is still holding the death
    // screen it was shown before the drop.
    //
    // Refusing in SILENCE there is a loop, not a one-off annoyance.
    // js/game.js's respawnPlayer hides the modal and writes that client's own
    // hp down to 10% of maxHp before it ever emits — and nothing on the server
    // reads a client's hp back to correct it: the packed 'mv' form carries one
    // and this file does not even destructure it, and Room.syncPlayerHp, which
    // exists for exactly that, has no caller anywhere. So the client keeps the
    // 10% as its base, every later playerHurt subtracts the monster's damage
    // FROM IT rather than from the server's number (js/network.js), it reaches
    // zero while the server still has them at half health, playerDie runs
    // again — and the player presses respawn again, and is refused again, for
    // a death only their own client believes in.
    //
    // So the refusal sends the truth FIRST: one playerHurt carrying the room's
    // own hp and no dmg, which is the branch of that same client handler that
    // assigns hp outright instead of subtracting from it, and that does not
    // re-run playerDie. They end up alive, at the number the server actually
    // holds, and told why.
    //
    // No room record at all means nothing in memory can say they are alive,
    // and a player who is authed with no room entry is exactly who the heal-
    // and-send-to-the-hall below exists for — so that case is allowed. It
    // cannot be farmed either: there is no room to be fighting in.
    const me = s.room && s.room.players.get(s.socket.id);
    if (me && me.hp > 0) {
      s.socket.emit('playerHurt', { id: s.socket.id, hp: me.hp });
      fail('Вы живы — возрождение не требуется', 'not_dead');
    }
    const st = await stats.of(t, pid);
    // No stat row means no character to bring back. Returning here told act()
    // the respawn succeeded, so the log said the player was revived while the
    // death screen stayed up in front of them — the one moment a player is
    // certain to report, answered by a row saying it worked.
    if (!st) fail('Персонаж недоступен — перезайдите', 'no_stats');
    await players.setHp(t, pid, st.maxHp);
    // HP only. Room has no `spawnPoint()` — the guard around the call meant it
    // never ran, so the line read as "move them off the corpse" while doing
    // nothing. Where a respawn lands is decided one line down: sendGameStart
    // sends them to floor 1, and enterFloor only restores a stored position
    // when the stored FLOOR matches, so a death on any other floor already
    // arrives at the hub's own spawn.
    if (s.room) s.room.setPlayerHp(s.socket.id, st.maxHp);
    const floor = await sendGameStart(t, 1);
    // Written NOW, not on the twenty-second timer. A disconnect in the seconds
    // after a death would otherwise leave the hall in the database and the
    // corpse's coordinates beside it — which is a player who logs back in
    // standing where they died, on the floor they left.
    const at = s.room && s.room.players.get(s.socket.id);
    await players.savePosition(t, pid, floor, at ? at.x : 0, at ? at.y : 0);
  }));

  // ── floors ───────────────────────────────────────────────────────────────
  // `target` is a floor KEY, which is what the portal table in the client
  // holds. A refusal is its own event, because the client has a modal for it.
  safeOn('enterLocation', ({ target } = {}) => s.act('enterLocation', 'locationError', async (t, pid) => {
    const want = floorIdOf(target);
    if (!Number.isFinite(want)) fail('Такой локации нет', 'bad_target');
    const prog = await players.progressOf(t, pid);
    if (resolveFloor(want, prog) !== want) {
      // 'level' was the only reason this could ever give, and now it is not:
      // a timed zone refuses because it is closed, which is a different thing
      // to be told and a different thing to do about it.
      const closed = want === floorIdOf('guildWar') || want === floorIdOf('arena');
      // The client's own modal first, then a throw. `return` here left act()
      // writing an 'enterLocation' success row for a portal that refused —
      // so the log placed players on floors they were never allowed onto, and
      // a level-gate bypass and an ordinary refusal looked the same in it.
      s.socket.emit('enterLocationDenied', { target, reason: closed ? 'closed' : 'level' });
      fail(closed ? 'Локация сейчас закрыта' : 'Недостаточный уровень',
        closed ? 'closed' : 'level');
    }
    const landed = await sendGameStart(t, want);
    // Where the player ACTUALLY IS on the new floor, not where they were on
    // the old one. Writing the new floor beside the old coordinates meant the
    // next login read a position that belongs to a different map — and
    // enterFloor trusts a stored position when the floor matches, so it dropped
    // people wherever those numbers happened to land.
    const at = s.room && s.room.players.get(s.socket.id);
    await players.savePosition(t, pid, landed, at ? at.x : 0, at ? at.y : 0);
    // "Войди в Фарм-зону" completes on the transition itself. Unlike the legacy
    // goto_floor quests — which have no zone of their own and so ride on a kill
    // inside the right corridor — this one has a real event to hang off.
    const q = await progression.questOnEvent(t, pid, 'enter_zone', `_zone_${target}`, 1);
    if (q) s.socket.emit('questSync', q);
  }));

  // ── streaming repair ─────────────────────────────────────────────────────
  // The world cast is `volatile`, so a client on a bad link legitimately misses
  // packets. This is how it asks for what it lost — bounded hard, because one
  // request makes the server encode and send up to 40 full enemy records.
  safeOn('enemyResync', ({ ids } = {}) => {
    if (!s.room || !Array.isArray(ids)) return;
    s.room.resendEnemies(s.socket.id, ids.slice(0, 40));
  });

  // The other half of the repair, for the case the by-id one cannot reach: a
  // client whose decoder was never given the full record for a handle has no
  // id to ask about. It can only say "I have lost track" — and the fix is for
  // the server to forget what it believes this player holds, so the next cast
  // re-sends everything in their radius in full.
  //
  // Rate-limited on the server as well as the client, because the client's
  // limiter lives on the machine with the problem.
  safeOn('enemyResyncAll', () => {
    if (!s.room) return;
    s.room.forgetKnownEnemies(s.socket.id);
  });


  // ── the map ──────────────────────────────────────────────────────────────
  // Geometry, on request. Sent separately from gameStart and cached by the
  // client against mapVersion, because it is the largest thing a floor change
  // moves and it changes only when the world is regenerated.
  safeOn('worldMapInline', () => {
    if (s.room) s.socket.emit('worldMap', s.room.mapPayload);
  });

  // ── skill visuals ────────────────────────────────────────────────────────
  // A projectile and an area effect are DRAWINGS. They carry no damage — that
  // is decided by attack/skillAttack against the room — so the numbers here
  // are bounded to keep one client from asking every other client to render
  // something absurd, and nothing more is checked.
  const num = (v, lo, hi, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
  };
  const color = (v) => (typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v) ? v : '#ffffff');

  safeOn('spawnProj', (data) => {
    if (!s.room || !data || typeof data !== 'object') return;
    s.room.queueProjectile(s.socket.id, {
      x: num(data.x, -1e5, 1e5, 0), y: num(data.y, -1e5, 1e5, 0),
      vx: num(data.vx, -5000, 5000, 0), vy: num(data.vy, -5000, 5000, 0),
      size: num(data.size, 1, 64, 5), life: num(data.life, 0, 10, 1.5),
      color: color(data.color),
      projType: PROJ_TYPES.has(data.projType) ? data.projType : 'ball',
    });
  });

  safeOn('spawnAoe', (data) => {
    if (!s.room || !data || typeof data !== 'object') return;
    s.room.queueAoe(s.socket.id, {
      x: num(data.x, -1e5, 1e5, 0), y: num(data.y, -1e5, 1e5, 0),
      r: num(data.r, 1, 400, 80),
      style: NC_AOE_STYLES.includes(data.style) ? data.style : 'classic',
      color: color(data.color), color2: color(data.color2 || data.color),
    });
  });

  // A crowd-control effect on a monster. The DURATION is bounded here, and the
  // room decides whether the effect applies at all — the client is saying
  // "my skill landed", not "this monster is now stunned for ten seconds".
  safeOn('skillEffect', ({ enemyId, enemyIds, type, duration } = {}) => {
    if (!s.room) return;
    const dur = num(duration, 0, 10, 0);
    const hitOne = enemyId ? s.room.applySkillEffect(s.socket.id, enemyId, type, dur) : false;
    const hitMany = Array.isArray(enemyIds)
      ? s.room.applySkillEffectMany(s.socket.id, enemyIds.slice(0, 40), type, dur) : [];
    // Nothing landed — nothing to draw, and nothing to say. Refusals are
    // ordinary here (a target walked out of range between the client deciding
    // and the packet arriving), so they are counted rather than alerted; see
    // ccRefused on /health.
    if (!hitOne && !hitMany.length) { s.room.ccRefused = (s.room.ccRefused || 0) + 1; return; }
    const me = s.room.players.get(s.socket.id);
    // Echoed as what ACTUALLY took the effect. Sending back the requested ids
    // made every other client draw a stun on monsters that were never stunned.
    if (me) s.emitNearby(me.x, me.y, 'enemyCC', {
      enemyId: hitOne ? enemyId : undefined,
      enemyIds: hitMany.length ? hitMany : undefined,
      type, duration: dur,
    });
  });

  // Stealth ending. Only ever clears the flag — a client cannot ask to BECOME
  // invisible, which is what the event name suggests and what it must never
  // do: the room hides a player from the enemy AI while `_invis` is set, so
  // the old `p._invis = !!invis` was an unauthenticated, unbounded "no monster
  // may see me" switch.
  //
  // AND NOTHING SETS IT. Worth saying here, because reading only these lines
  // has already produced one audit finding asking the server to start granting
  // stealth "the way the client already animates it". There is no such skill
  // and no such animation: `_invis` was the assassin's E, and the assassin
  // class was deleted with the rest of the old roster (commit e509cf7 —
  // "Assassin's mechanical slot ... was dropped rather than forced onto a
  // character that doesn't fit it"). The client's own invisTimer has had no
  // assignment other than zero since that day, so every `playerInvis` on the
  // wire today carries `invis: false` and nothing else ever could.
  //
  // The handler stays because the shipped bundle still emits the event, and
  // the two `_invis` reads in server/game/Room.js stay because they are the
  // correct half — dev/aggro-check.js asserts BOTH that the AI honours the
  // flag and that nothing grants it, so the day a skill does, that check fails
  // and says the grant/expiry rules (duration, break-on-damage) now have to be
  // server-owned rather than taken from a client packet.
  safeOn('playerInvis', () => {
    if (!s.room) return;
    const p = s.room.players.get(s.socket.id);
    if (p) p._invis = false;
  });

  // A party-wide shield, drawn on everyone standing with the caster.
  safeOn('faithShield', ({ duration } = {}) => {
    if (!s.room) return;
    const partyId = party.playerParty.get(s.socket.id);
    const members = partyId ? party.parties.get(partyId) : null;
    if (!members) return;
    const dur = num(duration, 0, 30, 0);
    for (const [mid] of members) {
      if (mid === s.socket.id) continue;
      if (typeof s.room.arePlayersNear === 'function'
          && !s.room.arePlayersNear(s.socket.id, mid)) continue;
      deps.io.to(mid).emit('faithShieldBuff', { duration: dur });
    }
  });

  // ── the teleport stone ───────────────────────────────────────────────────
  // Consumed when the cast STARTS, and the recall arrives as an ordinary
  // gameStart when the timer fires. Consuming up front is what stops a stone
  // being used to peek at a gate and then refunded by cancelling.
  safeOn('useTeleportStone', () => s.act('useTeleportStone', 'itemError', async (t, pid) => {
    if (s.floor === 1) fail('Вы уже в зале', 'in_hub');
    if (teleportTimer) fail('Уже произносится телепорт', 'casting');
    // A dead player must respawn, not recall. forceFloor carries the record's
    // hp across, so a stone cast from the death screen spent itself and landed
    // the player in the hub still at zero — the client kept its death overlay
    // up over a hub it had already been moved to.
    const me = s.room && s.room.players.get(s.socket.id);
    if (me && me.hp <= 0) fail('Сначала возродитесь', 'dead');
    const res = await consumables.useTeleportStone(t, pid);
    await s.pushItems(t);
    s.socket.emit('teleportCastStarted', { ms: res.castMs });

    // The player is held still for the duration by the room; this timer only
    // performs the recall. A disconnect mid-cast simply never fires it — the
    // stone is spent, which is the same outcome as cancelling.
    teleportTimer = setTimeout(() => {
      teleportTimer = null;
      if (!s.authed || !s.room) return;
      s.forceFloor(1);
    }, res.castMs);
  }));

  // ── PvP history ──────────────────────────────────────────────────────────
  safeOn('getPvpHistory', () => s.act('getPvpHistory', 'profileError', async (t, pid) => {
    // Same two schemas as the write side (see recordPvpHistory, modes.js).
    // Selecting a column that is not there throws, and this handler's error
    // channel is 'profileError' — which no client listens for — so the panel
    // was empty for two independent reasons, neither of which reached anyone.
    const { hasColumn } = require('../db');
    const outcome = await hasColumn('pvp_history', 'won');
    const cols = outcome
      ? 'kind, mode, opponent, won, reward, created_at'
      : 'kind, mode, opponent, NULL::boolean AS won, NULL::text AS reward, created_at';
    const { rows } = await query(t, `
      SELECT ${cols} FROM pvp_history
       WHERE player_id = $1 ORDER BY id DESC LIMIT 50`, [pid]);
    s.socket.emit('pvpHistoryResult', {
      history: rows.map(r => ({
        kind: r.kind, mode: r.mode, opponent: r.opponent,
        won: r.won, reward: r.reward, at: r.created_at,
      })),
    });
  }));

  safeOn('mapView', ({ open } = {}) => {
    if (!s.room) return;
    const p = s.room.players.get(s.socket.id);
    if (p) p._mapOpen = !!open;
  });
};
