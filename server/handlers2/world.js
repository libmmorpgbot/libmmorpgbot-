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
const { NC_FACING, NC_AOE_STYLES } = require('../../shared/netcodec');
const party = require('../party');
const loot = require('../game/loot');
const { query } = require('../db');
const {
  CHAR_DEF, FLOOR_ENEMIES, FEAR_MAX_WAVE, COOP_STAGE_LEVELS,
  VIP_BONUSES, SEASON_TICKET_DROP_PCT, seasonActive,
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
  const { io, floorRooms, enterFloor, floorIdOf, resolveFloor } = deps;

  // ── character selection ──────────────────────────────────────────────────
  // The class is written once and never again: setClass has `AND char_class IS
  // NULL` in its WHERE, so a second selectChar cannot re-roll a character into
  // a different class and keep the level.
  safeOn('selectChar', ({ type } = {}) => s.act('selectChar', 'authError', async (t, pid) => {
    const prog = await players.progressOf(t, pid);
    if (!prog.charClass) {
      if (!CHAR_DEF[type]) fail('Неизвестный класс', 'bad_class');
      await players.setClass(t, pid, type);
    }
    // Everything the client needs to build the world, from the database. The
    // old gameStart carried a savedData blob the client had sent moments
    // earlier; this carries what is actually stored.
    await sendGameStart(t, null);
  }));

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
  function applyMove(x, y, facing, moving) {
    if (!s.room) return;
    const res = s.room.updatePlayerPos(s.socket.id, x, y, facing, moving);
    if (res && res.refused) {
      s.socket.emit('posCorrect', { x: res.x, y: res.y, reason: res.refused });
    }
  }

  // The packed form: [x*2, y*2, facingIndex, hp, moving]. Coordinates are
  // halved on the wire (see shared/netcodec.js) so they fit a smaller integer.
  safeOn('mv', (a) => {
    if (!Array.isArray(a) || a.length < 4) return;
    applyMove(a[0] / 2, a[1] / 2, NC_FACING[a[2]] || 'front', a.length > 4 ? !!a[4] : undefined);
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
    const myGold = Math.round((result.gold || 0) / share);
    const myXp = share > 1 ? Math.max(1, Math.round((result.xp || 0) / share)) : (result.xp || 0);

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

    // The transaction decides what happened; the packet reports it AFTERWARDS.
    // Emitting from inside meant the client was told its new balance before the
    // commit — and if anything downstream rolled the transaction back, the
    // number on screen was one the database never held. A player watching gold
    // appear and then revert on the next push is describing exactly that.
    const done = await s.act('killReward', 'itemError', async (t, pid) => {
      const prog = await players.progressOf(t, pid);
      const drops = rollLoot(result, prog.lvl);

      const reward = await consumables.grantKillReward(t, pid, {
        gold: myGold, xp: myXp, nexum: result.nexum || 0,
        drops: drops.items, idemKey: idem,
      });
      if (result.enemyName) await progression.bumpQuestKill(t, pid, result.enemyName);
      if (reward.xp && reward.xp.levelsGained > 0) await stats.refreshBm(t, pid);
      return { reward, drops };
    });
    if (!done) return;                      // act reported it; nothing happened

    const { reward, drops } = done;
    // Pushes read the database on their own connection now, which is the point:
    // everything below describes committed state.
    if (reward.xp && reward.xp.levelsGained > 0) {
      await s.pushStats(); await s.pushProgress();
    }
    await s.pushBalances();
    if (reward.items.length) await s.pushItems();

    s.socket.emit('enemyKilled', {
      id: result.enemyUid, at: result.at,
      gold: myGold, goldTotal: reward.gold,
      xp: myXp, level: reward.xp || null,
      dmg: result.dmg, isCrit: result.isCrit,
      ex: result.ex, ey: result.ey, color: result.color,
      eid: result.eid, rlvl: result.rlvl,
      items: reward.items.filter(i => !i.dropped),
      boxUncommon: drops.boxUncommon, boxRare: drops.boxRare,
      normStone: drops.normStone, blessStone: drops.blessStone,
      nexum: result.nexum || 0, gram: result.gram || 0,
    });

    // What would not fit stays on the floor. The reward for a kill is not owed
    // anywhere else, so it is not destroyed over a missing slot.
    for (const it of reward.items) {
      if (it.dropped && s.room) {
        s.room.spawnWorldDrops([{ id: it.id, qty: it.qty || 1 }], result.ex, result.ey);
      }
    }

    // Party members are paid on their own sessions, each in its own
    // transaction: one member's full inventory must not undo another's gold.
    for (const mid of mates) {
      const mate = deps.sessionForSocketId && deps.sessionForSocketId(mid);
      if (!mate || !mate.authed) continue;
      mate.act('killRewardShare', 'itemError', async (t, pid) => {
        const r = await consumables.grantKillReward(t, pid, {
          gold: myGold, xp: myXp, drops: [], idemKey: `kill:${pid}:${result.enemyUid}:${result.at || 0}`,
        });
        await mate.pushBalances(t);
        if (r.xp && r.xp.levelsGained > 0) { await mate.pushStats(t); await mate.pushProgress(t); }
        mate.socket.emit('enemyKilled', {
          id: result.enemyUid, gold: myGold, goldTotal: r.gold,
          xp: myXp, level: r.xp || null,
          ex: result.ex, ey: result.ey, color: result.color,
          eid: result.eid, rlvl: result.rlvl,
        });
      }).catch(() => { /* act reports it; one mate's failure is not the kill's */ });
    }
  }

  safeOn('attack', ({ enemyId } = {}) => {
    if (!s.room || !s.authed) return;
    const res = s.room.attackEnemy(s.socket.id, enemyId);
    if (!res) return;
    if (res.immune) return;                   // no damage number to draw
    // A killing blow returns no `hp` — the kill branch has nothing left to
    // report — so sending it anyway set the client's copy to undefined for the
    // instant between this packet and enemyKilled. Zero is the truth.
    if (!res.killed) {
      s.socket.emit('enemyHurt', { id: enemyId, hp: res.hp, dmg: res.dmg, isCrit: res.isCrit });
    }
    if (res.killed) onKill({ ...res, enemyUid: enemyId });
  });

  safeOn('skillAttack', ({ enemyId, key } = {}) => {
    if (!s.room || !s.authed) return;
    // The multiplier is derived from the slot and the player's own studied
    // level, on this side. The client used to send a number, which is a value
    // somebody edits.
    const res = s.room.skillAttackEnemy(s.socket.id, enemyId, key);
    if (!res) return;
    if (!res.killed) {
      s.socket.emit('enemyHurt', { id: enemyId, hp: res.hp, dmg: res.dmg, isCrit: res.isCrit });
    }
    if (res.killed) onKill({ ...res, enemyUid: enemyId });
  });

  // ── death and respawn ────────────────────────────────────────────────────
  // Respawn restores HP in the database as well as the room, because HP is
  // one of the few live values that is also persisted — a player who dies and
  // reconnects must not come back still dead.
  safeOn('respawn', () => s.act('respawn', 'itemError', async (t, pid) => {
    const st = await stats.of(t, pid);
    if (!st) return;
    await players.setHp(t, pid, st.maxHp);
    if (s.room) {
      s.room.setPlayerHp(s.socket.id, st.maxHp);
      const spawn = s.room.spawnPoint ? s.room.spawnPoint() : null;
      if (spawn) s.room.updatePlayerPos(s.socket.id, spawn.x, spawn.y, 'front', false);
    }
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
    if (!Number.isFinite(want)) return;
    const prog = await players.progressOf(t, pid);
    if (resolveFloor(want, prog) !== want) {
      return s.socket.emit('enterLocationDenied', { target, reason: 'level' });
    }
    const landed = await sendGameStart(t, want);
    // Where the player ACTUALLY IS on the new floor, not where they were on
    // the old one. Writing the new floor beside the old coordinates meant the
    // next login read a position that belongs to a different map — and
    // enterFloor trusts a stored position when the floor matches, so it dropped
    // people wherever those numbers happened to land.
    const at = s.room && s.room.players.get(s.socket.id);
    await players.savePosition(t, pid, landed, at ? at.x : 0, at ? at.y : 0);
  }));

  // ── streaming repair ─────────────────────────────────────────────────────
  // The world cast is `volatile`, so a client on a bad link legitimately misses
  // packets. This is how it asks for what it lost — bounded hard, because one
  // request makes the server encode and send up to 40 full enemy records.
  safeOn('enemyResync', ({ ids } = {}) => {
    if (!s.room || !Array.isArray(ids)) return;
    s.room.resendEnemies(s.socket.id, ids.slice(0, 40));
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
    if (enemyId) s.room.applySkillEffect(enemyId, type, dur);
    if (Array.isArray(enemyIds)) s.room.applySkillEffectMany(enemyIds.slice(0, 40), type, dur);
    const me = s.room.players.get(s.socket.id);
    if (me) s.emitNearby(me.x, me.y, 'enemyCC', { enemyId, enemyIds, type, duration: dur });
  });

  // The rogue's stealth ending. Only ever clears the flag — a client cannot
  // ask to BECOME invisible, which is what the event name suggests and what it
  // must never do: the room hides a player from the enemy AI while it is set.
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
    const { rows } = await query(t, `
      SELECT kind, mode, opponent, won, reward, created_at FROM pvp_history
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
