'use strict';
// Турнир (Tournament) — 32-player double elimination, moved out as a factory
// (createTournament(deps)) the same shape as arena3/death-battle/race10.
//
// ── the bracket, in one paragraph ────────────────────────────────────────────
// Registration opens every day at TOURNAMENT_HOURS_MSK and fills to exactly
// TOURNAMENT_SIZE (32) — no more, no fewer, because the whole bracket below is
// a FIXED schedule hand-built for exactly that number, not a general N-player
// algorithm. Losing your first match doesn't eliminate you: you drop to the
// lower bracket for one more shot, and lose there for good. The upper bracket
// champion (0 losses) meets the lower bracket champion (1 loss) once, in the
// Grand Final, winner takes all — no bracket reset, by owner's decision (see
// the chat this was speced in).
//
// A double elimination bracket for a power-of-two field is a well-known fixed
// shape (every tournament site generates the same one): the lower bracket
// alternates between "PURE" rounds, which just thin its own survivors down to
// match the size of the next batch of upper-bracket droppers, and "MIXED"
// rounds, which fight the two groups together. For 32 players that shape is
// exactly 10 global rounds — some of them running an upper AND a lower match
// group side by side on the one ring, most of them lower-only once the upper
// bracket's own champion is already decided (round 5) — and _trBuildRoundGroups
// below is that fixed shape written out explicitly, round by round, rather
// than derived from a generic N-player formula this codebase has no other use
// for. See the design chat for the round-by-round table this was drawn from.
const {
  TOURNAMENT_DAYS_MSK, TOURNAMENT_HOURS_MSK, TOURNAMENT_WINDOW_MS, TOURNAMENT_SIZE, TOURNAMENT_MIN_LEVEL,
  TOURNAMENT_FIGHT_MS, TOURNAMENT_COUNTDOWN_MS, TOURNAMENT_ROUND_GAP_MS,
  EVENT_NOTIFY_BEFORE_MS, nextEventStartAt,
} = require('../../shared/definitions');
const { FLOOR_IDS } = require('../game/floors');

// How many global rounds the fixed 32-player bracket takes, start to Grand
// Final — see _trBuildRoundGroups. Not a general formula, just this shape's
// own length, kept as a name rather than a bare 10 wherever it's compared.
const TOURNAMENT_TOTAL_ROUNDS = 10;

// Liberty (Nexum) paid per round win — not a single per-match constant like
// arena3's ARENA3_REWARD, because a 10-round bracket pays out at every round,
// not once at the end, and the grand final pays a different, higher tier to
// BOTH sides. Kept here rather than in server/mode-rewards.js, whose
// _trGrantReward closure only ever takes a plain amount and has no reason to
// know these — requiring that file from here for just its constants would
// also pull in its own `./db` require (real Postgres driver) for no reason.
const TOURNAMENT_UB_ROUND_NEXUM = 10;
const TOURNAMENT_LB_ROUND_NEXUM = 5;
const TOURNAMENT_FINAL_WIN_NEXUM = 100;
const TOURNAMENT_FINAL_LOSE_NEXUM = 50;

module.exports = function createTournament(deps) {
  const {
    io, getRoom, _findPlayerAnyFloor, _recordPvpHistory, _returnToHub, _socketTid,
    notifyEventSoon, broadcastLeadMs, notifyEventStarted, safeTimeout,
  } = deps;

  const _tr = {
    phase: 'idle',        // 'idle' → 'reg' → 'live' → 'idle'
    reg: new Map(),        // socketId -> { name }
    names: new Map(),      // socketId -> name, kept for the whole bracket (registered players leave `reg` at start)

    // Everyone still alive in the bracket is in exactly one of these three
    // places between rounds: still undefeated (ubPool), once-beaten and still
    // fighting for a way back (lbPool), or one of the handful of single-slot
    // holders a specific later round needs (see _trBuildRoundGroups/
    // _trApplyRoundResults for which round reads which).
    ubPool: [], lbPool: [],
    dropFromUB3: [], dropFromUB4: [],
    ubChampion: null, ubFinalLoser: null, lbSemiSurvivor: null, lbChampion: null,

    roundIndex: 0,          // 1..TOURNAMENT_TOTAL_ROUNDS while a round is in flight, else the last one played
    matchTag: new Map(),    // socketId -> which group this round's match belongs to (see _trBuildRoundGroups)
    roundResults: new Map(),// loserSocketId -> winnerSocketId, accumulated as this round's matches resolve
    matches: new Map(),     // socketId -> { opponent, pit } — only the pairs actually fighting right now
    dmg: new Map(),         // socketId -> damage dealt to their opponent this fight (tie-break on timeout)
    _roundLive: false,      // guards _trConcludeRound against running twice for the one round
    // The real bracket, for display only — [{ round, matches: [{ tag, a:{id,name}, b:{id,name}, winnerId }] }],
    // one entry per round actually dealt so far, in order. Nothing here drives
    // the bracket logic itself (ubPool/lbPool/etc. above do that) — this is
    // purely what the "Сетка" tab reads (see _trPublicState). Index 0 = round 1.
    bracketHistory: [],

    fightAt: 0, roundEndAt: 0,
    // Wall-clock time the between-round gap ends, or 0 outside one — set by
    // _trAfterRound right before it arms gapTimer, cleared by _trStartRound
    // the moment the next round actually begins. Broadcast via
    // _trPublicState so clients waiting between rounds have a real countdown
    // to render instead of no timer at all.
    gapEndAt: 0,
    freezeTimer: null, fightTimer: null, gapTimer: null,
    openTimer: null, closeTimer: null, notifyTimer: null,
  };

  function _trNextOpenAt(from = Date.now()) {
    return nextEventStartAt(TOURNAMENT_DAYS_MSK, TOURNAMENT_HOURS_MSK, from);
  }

  // `queued` (not `registered`) for the head count on purpose — same split
  // arena3PublicState/_a3Broadcast use (queued there too). `registered` is
  // reserved for the per-socket boolean _trBroadcast overlays below; reusing
  // one field name for both a count and a flag means every registered
  // player's client would show "true/32" instead of "19/32" the moment this
  // broadcast reaches them, since {...st, registered:true} would overwrite
  // the count with the flag.
  function _trPublicState() {
    return {
      phase: _tr.phase,
      nextAt: _trNextOpenAt(),
      queued: _tr.reg.size,
      needed: TOURNAMENT_SIZE,
      live: _tr.phase === 'live',
      minLevel: TOURNAMENT_MIN_LEVEL,
      round: _tr.roundIndex,
      totalRounds: TOURNAMENT_TOTAL_ROUNDS,
      // 0 outside a between-round gap — see _tr.gapEndAt's own comment.
      gapEndAt: _tr.gapEndAt,
      // Real per-round matchups, only for rounds actually dealt so far — see
      // _trStartRound/_trMarkWinner. Reset to [] by _trTryStart, so last
      // tournament's finished bracket stays visible until the next one begins.
      bracket: _tr.bracketHistory,
    };
  }

  function _trBroadcast() {
    const st = _trPublicState();
    io.emit('tournamentState', st);
    _tr.reg.forEach((_, sid) => io.to(sid).emit('tournamentState', { ...st, registered: true }));
  }

  function _trSchedule() {
    clearTimeout(_tr.openTimer);
    clearTimeout(_tr.notifyTimer);
    _tr.phase = 'idle';
    const openAt = _trNextOpenAt();
    _tr.openTimer = safeTimeout('trOpen', () => _trOpenWindow(openAt), Math.max(0, openAt - Date.now()));
    // Same lead-time shift every other event's 30-minute warning uses — see
    // arena3.js's identical comment on _a3Schedule for why it isn't a flat 30.
    const warnIn = openAt - EVENT_NOTIFY_BEFORE_MS - broadcastLeadMs() - Date.now();
    if (warnIn > 0) _tr.notifyTimer = safeTimeout('trNotify', () => notifyEventSoon('tournament', openAt), warnIn);
  }

  function _trOpenWindow(openAt) {
    _tr.phase = 'reg';
    _tr.reg.clear();
    notifyEventStarted('tournament', openAt);
    clearTimeout(_tr.closeTimer);
    _tr.closeTimer = safeTimeout('trClose', _trCloseWindow, TOURNAMENT_WINDOW_MS);
    _trBroadcast();
  }

  // Closes an under-filled window. A window that already started (phase
  // flipped to 'live' by _trTryStart) has nothing left to close here — its
  // own bracket runs on its own timers regardless of this one firing late.
  function _trCloseWindow() {
    if (_tr.phase !== 'reg') return;
    _tr.phase = 'idle';
    [..._tr.reg.keys()].forEach(sid => {
      io.to(sid).emit('tournamentRegistered', { registered: false });
      io.to(sid).emit('tournamentError', { msg: 'Регистрация на турнир закрылась — не набралось 32 человека' });
    });
    _tr.reg.clear();
    _trSchedule();
    _trBroadcast();
  }

  // Fires the moment the 32nd person registers (see tournamentRegister,
  // server/handlers2/modes.js) — never waits out the rest of the window.
  function _trTryStart() {
    if (_tr.phase !== 'reg' || _tr.reg.size < TOURNAMENT_SIZE) return;
    const ready = [..._tr.reg.keys()].filter(sid =>
      io.sockets.sockets.get(sid) && _findPlayerAnyFloor(sid));
    // Same fix as arena3's _a3TryStart: prune whoever dropped between filling
    // the slot and this check, and broadcast the honest count. Leaving them
    // in `reg` kept the head count stuck at 32/32 forever — tournamentRegister
    // refuses sign-ups once reg.size >= TOURNAMENT_SIZE, so with a stale full
    // count nobody new could ever register to retrigger this, and the window
    // would eventually force-close as "didn't fill up" despite having filled.
    const pruned = [..._tr.reg.keys()].filter(sid => !ready.includes(sid));
    pruned.forEach(sid => _tr.reg.delete(sid));
    if (pruned.length) _trBroadcast();
    if (ready.length < TOURNAMENT_SIZE) return;
    clearTimeout(_tr.closeTimer);
    _tr.phase = 'live';
    _tr.names.clear();
    ready.slice(0, TOURNAMENT_SIZE).forEach(sid => _tr.names.set(sid, _tr.reg.get(sid)?.name || '?'));
    _tr.ubPool = [..._tr.names.keys()];
    _tr.lbPool = []; _tr.dropFromUB3 = []; _tr.dropFromUB4 = [];
    _tr.ubChampion = null; _tr.ubFinalLoser = null; _tr.lbSemiSurvivor = null; _tr.lbChampion = null;
    _tr.bracketHistory = []; // last tournament's bracket stays visible right up until this moment
    _tr.reg.clear();
    _trStartRound(1);
  }

  // ── Fisher-Yates + chunk-by-2 ────────────────────────────────────────────
  function _shuffle(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  function _pairAll(list) {
    const a = _shuffle(list);
    const pairs = [];
    for (let i = 0; i + 1 < a.length; i += 2) pairs.push([a[i], a[i + 1]]);
    return pairs;
  }

  // The fixed 32-player double-elimination shape, one entry per global round.
  // Each group is tagged so _trApplyRoundResults knows which pool a group's
  // winners/losers feed back into — see the file header for where this comes
  // from and why it isn't computed generically.
  function _trBuildRoundGroups(idx) {
    switch (idx) {
      case 1: return [{ tag: 'ub', pairs: _pairAll(_tr.ubPool) }];
      case 2: return [
        { tag: 'ub', pairs: _pairAll(_tr.ubPool) },
        { tag: 'lb', pairs: _pairAll(_tr.lbPool) }, // lbPool holds round 1's upper losers here (see case 1 apply)
      ];
      case 3: return [
        { tag: 'ub', pairs: _pairAll(_tr.ubPool) },
        { tag: 'lb', pairs: _pairAll(_tr.lbPool) },
      ];
      case 4: return [
        { tag: 'ub', pairs: _pairAll(_tr.ubPool) },
        { tag: 'lb', pairs: _pairAll(_tr.lbPool) }, // pure reduce — dropFromUB3 held for round 5
      ];
      case 5: return [
        { tag: 'ubFinal', pairs: _pairAll(_tr.ubPool) },
        { tag: 'lb', pairs: _pairAll(_tr.lbPool) }, // mixed with dropFromUB3 (see apply for round 4)
      ];
      case 6: return [{ tag: 'lb', pairs: _pairAll(_tr.lbPool) }];  // pure reduce — dropFromUB4 merged in by round 6's own apply, ready for round 7
      case 7: return [{ tag: 'lb', pairs: _pairAll(_tr.lbPool) }]; // mixed round (lbPool already carries dropFromUB4 — see round 6's apply)
      case 8: return [{ tag: 'lbSemi', pairs: _pairAll(_tr.lbPool) }]; // pure reduce to 1
      case 9: return [{ tag: 'lbFinal', pairs: _tr.lbSemiSurvivor && _tr.ubFinalLoser ? [[_tr.lbSemiSurvivor, _tr.ubFinalLoser]] : [] }];
      case 10: return [{ tag: 'grandFinal', pairs: _tr.ubChampion && _tr.lbChampion ? [[_tr.ubChampion, _tr.lbChampion]] : [] }];
      default: return [];
    }
  }

  function _winnersLosersOf(tag) {
    const winners = [], losers = [];
    _tr.roundResults.forEach((winner, loser) => {
      if (_tr.matchTag.get(loser) === tag) { winners.push(winner); losers.push(loser); }
    });
    return { winners, losers };
  }

  function _trEliminateList(list) {
    list.forEach(sid => {
      io.to(sid).emit('tournamentEliminated', {});
      const tid = _socketTid(sid);
      if (tid) _recordPvpHistory(tid, 'lose', 'tournament', null);
    });
  }

  // Folds one round's resolved matches (_tr.roundResults + _tr.matchTag) back
  // into the pools the NEXT round reads — the one place that encodes which
  // group's winners/losers go where. See _trBuildRoundGroups for the mirror
  // image (which pools feed which round's matches).
  function _trApplyRoundResults(idx) {
    switch (idx) {
      case 1: {
        const ub = _winnersLosersOf('ub');
        _tr.ubPool = ub.winners; _tr.lbPool = ub.losers; // straight into LB1, nobody survives there yet to merge with
        break;
      }
      case 2: {
        const ub = _winnersLosersOf('ub'), lb = _winnersLosersOf('lb');
        _tr.ubPool = ub.winners;
        _tr.lbPool = [...lb.winners, ...ub.losers]; // LB1 survivors + UB2's own losers, merged for LB2 (round 3)
        _trEliminateList(lb.losers);
        break;
      }
      case 3: {
        const ub = _winnersLosersOf('ub'), lb = _winnersLosersOf('lb');
        _tr.ubPool = ub.winners;
        _tr.dropFromUB3 = ub.losers;    // held — LB3 (round 4) is a PURE round, doesn't take them yet
        _tr.lbPool = lb.winners;
        _trEliminateList(lb.losers);
        break;
      }
      case 4: {
        const ub = _winnersLosersOf('ub'), lb = _winnersLosersOf('lb');
        _tr.ubPool = ub.winners;
        _tr.dropFromUB4 = ub.losers;    // held — LB6 (round 7) is what mixes these in
        _tr.lbPool = [...lb.winners, ..._tr.dropFromUB3]; // LB4 (round 5) mixes LB3's survivors with UB3's held drop
        _tr.dropFromUB3 = [];
        _trEliminateList(lb.losers);
        break;
      }
      case 5: {
        const ubf = _winnersLosersOf('ubFinal'); // exactly one match
        _tr.ubChampion = ubf.winners[0] || null;
        _tr.ubFinalLoser = ubf.losers[0] || null; // held for the Lower Bracket final, round 9
        const lb = _winnersLosersOf('lb');
        _tr.lbPool = lb.winners;
        _trEliminateList(lb.losers);
        break;
      }
      case 6: {
        const lb = _winnersLosersOf('lb');
        // Merged here, BEFORE round 7 builds its pairs from lbPool — round 7
        // (LB6) is the mixed round, round 6 (LB5) was the pure one that got
        // survivors down to a count worth merging.
        _tr.lbPool = [...lb.winners, ..._tr.dropFromUB4];
        _tr.dropFromUB4 = [];
        _trEliminateList(lb.losers);
        break;
      }
      case 7: {
        const lb = _winnersLosersOf('lb');
        _tr.lbPool = lb.winners; // round 8 (LB7) is a pure reduce to 1
        _trEliminateList(lb.losers);
        break;
      }
      case 8: {
        const s8 = _winnersLosersOf('lbSemi');
        _tr.lbSemiSurvivor = s8.winners[0] || null;
        _trEliminateList(s8.losers);
        break;
      }
      case 9: {
        const f9 = _winnersLosersOf('lbFinal');
        _tr.lbChampion = f9.winners[0] || null;
        _trEliminateList(f9.losers);
        break;
      }
      case 10: {
        const gf = _winnersLosersOf('grandFinal');
        if (gf.winners[0]) _trFinishTournament(gf.winners[0], gf.losers[0]);
        break;
      }
    }
  }

  function _trFinishTournament(championSid, runnerUpSid) {
    const champName = _tr.names.get(championSid) || '?';
    io.to(championSid).emit('tournamentChampion', { champion: true, name: champName });
    if (runnerUpSid) io.to(runnerUpSid).emit('tournamentChampion', { champion: false, name: champName });
    io.emit('chatMsg', { username: 'ТУРНИР', text: `🏆 Чемпион турнира: ${champName}!`, time: new Date().toISOString() });
    const cTid = _socketTid(championSid);
    if (cTid) _recordPvpHistory(cTid, 'win', 'tournament', null);
    if (runnerUpSid) {
      const rTid = _socketTid(runnerUpSid);
      if (rTid) _recordPvpHistory(rTid, 'lose', 'tournament', null);
    }
    _tr.phase = 'idle';
    _tr.ubPool = []; _tr.lbPool = []; _tr.dropFromUB3 = []; _tr.dropFromUB4 = [];
    _tr.ubChampion = null; _tr.ubFinalLoser = null; _tr.lbSemiSurvivor = null; _tr.lbChampion = null;
    _tr.roundIndex = 0;
    _trSchedule();
    _trBroadcast();
  }

  // Applies this round's results and either arms the next round (after the
  // TOURNAMENT_ROUND_GAP_MS gap) or, if this was the last one, does nothing
  // further — round 10's own _trApplyRoundResults already ended the tournament.
  function _trAfterRound(idx) {
    _trApplyRoundResults(idx);
    _tr.matches.clear(); _tr.matchTag.clear(); _tr.roundResults.clear(); _tr.dmg.clear();
    if (idx >= TOURNAMENT_TOTAL_ROUNDS) return;
    clearTimeout(_tr.gapTimer);
    _tr.gapEndAt = Date.now() + TOURNAMENT_ROUND_GAP_MS;
    _tr.gapTimer = safeTimeout('trGap', () => _trStartRound(idx + 1), TOURNAMENT_ROUND_GAP_MS);
    _trBroadcast();
  }

  // Deploys round `idx`'s matches onto the ring. A pair where one side has
  // disconnected is decided as a forfeit on the spot — the pit isn't held
  // open for someone who isn't coming back, and the survivor isn't made to
  // sit out the full fight clock alone. The vanishingly rare case of BOTH
  // sides being gone picks the first-listed as the "winner" purely so the
  // bracket has someone to advance; there's no fair way to decide a fight
  // nobody showed up to.
  function _trStartRound(idx) {
    const room = getRoom(FLOOR_IDS.tournament);
    if (!room) return;
    _tr.roundIndex = idx;
    _tr.gapEndAt = 0; // the gap this round was waiting out is over
    _tr.matchTag.clear();
    _tr.roundResults.clear();
    const groups = _trBuildRoundGroups(idx);
    const toFight = [];
    // One bracket-history entry per round, built alongside the actual
    // matchmaking below rather than derived from it afterwards — the pairing
    // itself (who plays whom) only exists in this one place.
    const roundMatches = [];
    _tr.bracketHistory[idx - 1] = { round: idx, matches: roundMatches };
    groups.forEach(g => g.pairs.forEach(([a, b]) => {
      _tr.matchTag.set(a, g.tag); _tr.matchTag.set(b, g.tag);
      const entry = {
        tag: g.tag,
        a: { id: a, name: _tr.names.get(a) || '?' },
        b: { id: b, name: _tr.names.get(b) || '?' },
        winnerId: null,
      };
      roundMatches.push(entry);
      const aOk = io.sockets.sockets.get(a) && _findPlayerAnyFloor(a);
      const bOk = io.sockets.sockets.get(b) && _findPlayerAnyFloor(b);
      if (aOk && bOk) { toFight.push([a, b]); return; }
      const winner = aOk ? a : b;
      const loser = winner === a ? b : a;
      _tr.roundResults.set(loser, winner);
      entry.winnerId = winner;
      _trPayRoundReward(winner, loser);
    }));

    if (!toFight.length) { _trAfterRound(idx); return; }

    // Force each entrant's own connection onto the tournament floor first —
    // tournamentDeploy needs them already present in room.players to seat
    // them, same reasoning death-battle/arena3 deploy follow.
    const joined = toFight.filter(([a, b]) =>
      io.sockets.sockets.get(a)?.data?._forceEnterLocation?.('tournament') !== false &&
      io.sockets.sockets.get(b)?.data?._forceEnterLocation?.('tournament') !== false);
    const placed = room.tournamentDeploy(joined);
    const placedIds = new Set();
    placed.forEach(m => { placedIds.add(m.a.socketId); placedIds.add(m.b.socketId); });
    // A pair that passed the aOk/bOk check above (both looked connected and
    // in the world a moment ago) but still didn't land on the ring — a failed
    // floor transition, a pit tournamentDeploy couldn't seat them in, a
    // player record gone by the time it ran — used to just vanish here: no
    // roundResults entry, so _trApplyRoundResults never counts them as a
    // winner or a loser and they drop out of the bracket with no elimination
    // and no advancement. The exact "кого-то вообще не забирает на арену"
    // report. Resolve it the same way a pre-existing disconnect already is,
    // picking whichever side is still actually present.
    toFight.forEach(([a, b]) => {
      if (placedIds.has(a)) return; // tournamentDeploy always seats both sides of a pair together
      const winner = (io.sockets.sockets.get(a) && _findPlayerAnyFloor(a)) ? a : b;
      const loser = winner === a ? b : a;
      _tr.roundResults.set(loser, winner);
      const entry = roundMatches.find(m => m.a.id === a && m.b.id === b);
      if (entry) entry.winnerId = winner;
      _trPayRoundReward(winner, loser);
    });
    if (!placed.length) { _trAfterRound(idx); return; }

    _tr._roundLive = true;
    _tr.fightAt = Date.now() + TOURNAMENT_COUNTDOWN_MS;
    _tr.roundEndAt = _tr.fightAt + TOURNAMENT_FIGHT_MS;
    placed.forEach(({ pit, a, b }) => {
      _tr.matches.set(a.socketId, { opponent: b.socketId, pit });
      _tr.matches.set(b.socketId, { opponent: a.socketId, pit });
      _tr.dmg.set(a.socketId, 0); _tr.dmg.set(b.socketId, 0);
      io.to(a.socketId).emit('tournamentMatchStarted', {
        x: a.x, y: a.y, hp: a.hp, opponent: _tr.names.get(b.socketId) || '?',
        fightAt: _tr.fightAt, roundEndAt: _tr.roundEndAt, round: idx, totalRounds: TOURNAMENT_TOTAL_ROUNDS,
      });
      io.to(b.socketId).emit('tournamentMatchStarted', {
        x: b.x, y: b.y, hp: b.hp, opponent: _tr.names.get(a.socketId) || '?',
        fightAt: _tr.fightAt, roundEndAt: _tr.roundEndAt, round: idx, totalRounds: TOURNAMENT_TOTAL_ROUNDS,
      });
    });

    clearTimeout(_tr.freezeTimer);
    _tr.freezeTimer = safeTimeout('trFreeze', () => {
      if (!_tr._roundLive) return;
      _tr.matches.forEach((_, sid) => io.to(sid).emit('tournamentFight', { roundEndAt: _tr.roundEndAt }));
    }, TOURNAMENT_COUNTDOWN_MS);

    clearTimeout(_tr.fightTimer);
    _tr.fightTimer = safeTimeout('trRound', _trConcludeRound, TOURNAMENT_COUNTDOWN_MS + TOURNAMENT_FIGHT_MS);
    _trBroadcast();
  }

  // Ends one match: both sides go home (the ring is empty between rounds —
  // see the file header), the outcome is recorded for _trApplyRoundResults,
  // and both are dropped from `matches`/`dmg` so a stray late hit can't
  // re-trigger this. Never itself decides whether the ROUND is over — see
  // the two call sites (_trEliminate, _trConcludeRound) for that.
  function _trResolveMatch(loserSid, winnerSid) {
    if (!_tr.matches.has(loserSid)) return;
    _tr.matches.delete(loserSid); _tr.matches.delete(winnerSid);
    _tr.dmg.delete(loserSid); _tr.dmg.delete(winnerSid);
    _tr.roundResults.set(loserSid, winnerSid);
    const spotL = _returnToHub(loserSid);
    const spotW = _returnToHub(winnerSid);
    io.to(loserSid).emit('tournamentMatchResult', { won: false, x: spotL?.x, y: spotL?.y });
    io.to(winnerSid).emit('tournamentMatchResult', { won: true, x: spotW?.x, y: spotW?.y });
    _trMarkWinner(winnerSid, loserSid);
    _trPayRoundReward(winnerSid, loserSid);
  }

  // Records the outcome on the bracket-history entry _trStartRound created
  // for this pair, so the "Сетка" tab can show who actually won once a real
  // fight (rather than a forfeit, which sets winnerId itself) decides it.
  function _trMarkWinner(winnerSid, loserSid) {
    const round = _tr.bracketHistory[_tr.roundIndex - 1];
    const m = round && round.matches.find(x =>
      (x.a.id === winnerSid && x.b.id === loserSid) || (x.a.id === loserSid && x.b.id === winnerSid));
    if (m) m.winnerId = winnerSid;
  }

  // Liberty for winning a round — every round pays, not just the grand
  // final: +10 for an upper-bracket win, +5 for a lower-bracket one (see
  // _tr.matchTag for which this match was). The grand final is its own
  // tier: both sides get paid, 100 to the champion and 50 to the runner-up,
  // instead of the per-bracket amount. `ref` carries the round index so two
  // different rounds never collide on mode-rewards.js's idempotency key —
  // the account id is already part of that key, so nothing player-specific
  // needs to be in `ref` itself.
  function _trPayRoundReward(winnerSid, loserSid) {
    const tag = _tr.matchTag.get(winnerSid);
    if (tag === 'grandFinal') {
      _trGrant(winnerSid, TOURNAMENT_FINAL_WIN_NEXUM, 'tournament:final:win');
      _trGrant(loserSid, TOURNAMENT_FINAL_LOSE_NEXUM, 'tournament:final:lose');
      return;
    }
    const upper = tag === 'ub' || tag === 'ubFinal';
    _trGrant(winnerSid, upper ? TOURNAMENT_UB_ROUND_NEXUM : TOURNAMENT_LB_ROUND_NEXUM,
      `tournament:${upper ? 'ub' : 'lb'}:r${_tr.roundIndex}`);
  }

  function _trGrant(sid, amount, ref) {
    const sock = io.sockets.sockets.get(sid);
    if (sock?.data?._trGrantReward) sock.data._trGrantReward(amount, ref).catch(() => {});
  }

  // The round's clock ran out (or the last live match just resolved and
  // called this directly — see _trEliminate) — anyone still standing in a pit
  // at this point is decided by who dealt more damage over the minute, a coin
  // flip on an exact tie. `_roundLive` guards against the timer and the final
  // elimination of the round racing each other into this at the same instant.
  function _trConcludeRound() {
    if (!_tr._roundLive) return;
    _tr._roundLive = false;
    clearTimeout(_tr.fightTimer);
    const seen = new Set();
    [..._tr.matches.keys()].forEach(sid => {
      if (seen.has(sid)) return;
      const m = _tr.matches.get(sid);
      if (!m) return;
      seen.add(sid); seen.add(m.opponent);
      const mine = _tr.dmg.get(sid) || 0, theirs = _tr.dmg.get(m.opponent) || 0;
      const sidWins = mine === theirs ? Math.random() < 0.5 : mine > theirs;
      _trResolveMatch(sidWins ? m.opponent : sid, sidWins ? sid : m.opponent);
    });
    _trAfterRound(_tr.roundIndex);
  }

  // Wired into _pvpEliminate's fan-out (server/modes.js) — a kill inside a
  // pit or a disconnect either way. Only ever true for someone whose match
  // hasn't already been decided (matches.delete inside _trResolveMatch is
  // what keeps a second call — e.g. both sides somehow reporting a death the
  // same tick — from resolving the same match twice).
  function _trEliminate(socketId) {
    const m = _tr.matches.get(socketId);
    if (!m) return false;
    _trResolveMatch(socketId, m.opponent);
    if (_tr.matches.size === 0) _trConcludeRound();
    return true;
  }

  // True while this socket is in a match that hasn't gone live yet — the
  // countdown is refused movement/attacks the same way every other mode's
  // pre-fight freeze is (see _dbFrozen/_a3Frozen).
  function _trFrozen(socketId) {
    return _tr.matches.has(socketId) && Date.now() < _tr.fightAt;
  }

  // Only your assigned opponent can hit you, and they always can — even if
  // you happen to share a party or a clan with them (_isPvpImmune checks this
  // before its generic party/clan checks, same as _a3Allies/_a3Enemies).
  // Physical separation between pits is cosmetic (see dungeon.js's own note
  // on TR_PIT_GAP); this is the real backstop.
  function _trEnemies(a, b) {
    const m = _tr.matches.get(a);
    return !!m && m.opponent === b;
  }
  function _trAllies(a, b) {
    return (_tr.matches.has(a) || _tr.matches.has(b)) && !_trEnemies(a, b);
  }

  // Tallies damage for the timeout tie-break — called unconditionally from
  // both PvP attack handlers (server/handlers2/modes.js), win or not, since a
  // fight decided by the clock needs every hit counted, not just the last
  // one. A no-op for anyone not currently in a tournament match, or hitting
  // someone who isn't their assigned opponent (can't happen through the
  // normal handlers — _isPvpImmune refuses that pairing outright — but this
  // stays a no-op rather than trusting the caller).
  function _trTrackDamage(attackerId, targetId, dmg) {
    const m = _tr.matches.get(attackerId);
    if (!m || m.opponent !== targetId) return;
    _tr.dmg.set(attackerId, (_tr.dmg.get(attackerId) || 0) + (Number(dmg) || 0));
  }

  return {
    TOURNAMENT_TOTAL_ROUNDS,
    _tr, _trNextOpenAt, _trPublicState, _trBroadcast, _trSchedule, _trOpenWindow, _trCloseWindow,
    _trTryStart, _trStartRound, _trEliminate, _trFrozen, _trAllies, _trEnemies, _trTrackDamage,
  };
};
