'use strict';
// ── Опробовать персонажа (character trial) ──────────────────────────────────
// A throwaway sandbox reached from the character-select screen: pick any
// class, land alone in an empty room with a handful of harmless level-42
// monsters, level 100 and every skill unlocked, try the kit, then go back to
// picking for real. Nothing here ever touches player_progress — see the
// long comment on trialEnter below for exactly how that is kept true.
//
// Modelled on Страх (server/game/fear.js) for the "private Room, never in
// floorRooms" shape, but deliberately much smaller: no waves, no daily
// attempts, no disconnect-reconnect grace. There is nothing to resume — a
// trial's whole state (the fake stats, the monster batch) is rebuilt from
// scratch on every entry, so a dropped connection just needs the generic
// disconnect cleanup (server/app.js's 'disconnect' handler already calls
// room.removePlayer for whatever room a socket was in) and nothing more.
const { CHAR_DEF, xpToNext, SKILL_MAX_LEVEL } = require('../../shared/definitions');
const Room = require('../game/Room');
const { FLOOR_IDS } = require('../game/floors');
const stats = require('../db/repos/stats');

const TRIAL_LEVEL = 100;

module.exports = function registerTrial(s, safeOn, deps) {
  const { io } = deps;

  // ── everything the fake character is made of, in one place ───────────────
  // stats.compute() is a PURE function (server/db/repos/stats.js) — given a
  // row shaped like the one LOAD_SQL would have produced, it returns exactly
  // what a real level-100, fully-skilled account's row would compute to, and
  // never touches the database. No gear, no codex, no passives, no clan: the
  // point is the class's own kit at its best, not a stacked build.
  function _trialStats(type) {
    const skillKeys = ['Q', 'W', 'E', 'R'];
    const row = {
      char_class: type, lvl: TRIAL_LEVEL, xp: 0, hp: 999999, codex: {}, buffs: {},
      upg_atk: 0, upg_def: 0, upg_hp: 0, upg_atk_speed: 0,
      upg_crit_chance: 0, upg_crit_power: 0, upg_hp_regen: 0,
      equipped: [], passives: {},
      skill_levels: Object.fromEntries(skillKeys.map(k => [k, SKILL_MAX_LEVEL])),
      adv_learned: Object.fromEntries(skillKeys.map(k => [k, true])),
      // Active, not just learned — "все навыки открыты для пробного
      // использования" means the вторая профессия variant is what a player
      // sees the instant they walk in, not a base skill they have to
      // remember to toggle. The base version stays one tap away either way
      // (js/ui.js's skill panel toggle reads advSkillLearned the same way
      // for a real account), so nothing about the base kit is hidden.
      adv_active: Object.fromEntries(skillKeys.map(k => [k, true])),
      clan_level: 0,
    };
    return { row, st: stats.compute(row) };
  }

  // ── entering ───────────────────────────────────────────────────────────────
  // Deliberately NOT s.act(): every other handler in handlers2/ wraps a
  // database WRITE in a transaction. This one has none — the only read is
  // fullState, for the account's own real inventory/balances/prefs (safe to
  // show as-is; nothing here is granted, just displayed) — so there is
  // nothing to retry on a serialisation conflict and no meta row worth
  // logging. safeOn's own try/catch (server/app.js) is the whole safety net
  // a read-only handler needs.
  //
  // Never goes through enterFloor/forceFloor: both of those either require a
  // class already set on THIS floor's record (forceFloor, server/
  // session.js — "no character chosen yet") or write player_progress.
  // char_class the first time a class is picked (selectChar, handlers2/
  // world.js) — either one would either refuse a brand-new account trying a
  // class before ever picking one, or silently and irreversibly commit the
  // trial's class as the real one. This handler builds the room and the
  // player record by hand instead, the same two calls forceFloor itself
  // makes (addPlayer + setPlayerChar), just without either gate.
  safeOn('trialEnter', async ({ type } = {}) => {
    if (!s.authed) return;
    // Same membership test as selectChar/changeClass — Object.hasOwn, not
    // `CHAR_DEF[type]`: CHAR_DEF is a plain object literal and so answers
    // truthy for 'constructor'/'__proto__'/etc, which is not a class.
    if (typeof type !== 'string' || !Object.hasOwn(CHAR_DEF, type)) {
      s.socket.emit('trialError', { msg: 'Неизвестный класс' });
      return;
    }

    // Release whatever the socket was actually doing before this click — a
    // leftover Fear/coop run record left behind would otherwise refuse every
    // later entry to that mode, forever (see _leaveInstance's own comment).
    if (typeof s._leaveInstance === 'function') s._leaveInstance(s.floor);
    if (s.room) {
      s.room.removePlayer(s.socket.id);
      s.socket.leave(`floor_${s.floor}`);
      s.room = null;
    }

    const room = new Room(FLOOR_IDS.trial, io, {}, null);
    const clan = s.clan || null;
    room.addPlayer(
      s.socket.id, s.username, clan && clan.name, clan && clan.icon,
      (clan && clan.atkBonus) || 0, s.telegramId, clan && clan.clanId,
    );
    room.setPlayerChar(s.socket.id, type);

    const { row, st } = _trialStats(type);
    room.setPlayerStats(s.socket.id, st);
    room.setPlayerHp(s.socket.id, st.maxHp);
    room.trialSpawnMonsters();

    s.floor = FLOOR_IDS.trial;
    s.room = room;
    // Private and single-occupant, like Fear/coop — never joined to the
    // `floor_N` broadcast group, so nobody else's client ever hears about a
    // trial room that will not exist a minute from now.

    // The account's real inventory/balances/prefs — harmless to show, and
    // reusing fullState keeps this payload the exact shape js/network.js's
    // 'gameStart' handler already expects, rather than a hand-built partial
    // that is one missing field away from a silent client-side crash.
    // Overridden below: progress (class/level shown for the trial) and
    // stats (the fake row this whole handler exists to hand out).
    const state = await s.fullState(null);
    state.progress = {
      ...state.progress,
      charClass: type, lvl: TRIAL_LEVEL, xp: 0, xpNext: xpToNext(TRIAL_LEVEL),
    };
    state.stats = st;
    // fullState's own `skills` is the account's REAL (and, for most trial
    // entrants, empty) skill record — left in place it would just sit there
    // unread beside the real fields below, which is confusing to anyone
    // inspecting the payload even though nothing on the client reads it.
    delete state.skills;
    // FLAT, not nested under `skills` — a normal login's skill state never
    // arrives on 'gameStart' at all (it rides 'authOk's savedData, applied
    // once by restoreFromSave, js/player.js), and js/network.js's
    // _applyGameStart deliberately skips that whole path for a trial
    // payload (see its own comment: consuming _savedData here would starve
    // the account's REAL first gameStart of it). So _applyGameStart has its
    // own small trial-only branch that reads these four fields straight off
    // the payload — same names restoreFromSave itself reads, just top-level
    // instead of nested one level under a `skills` key nothing was ever
    // reading.
    s.socket.emit('gameStart', {
      ...state, ...s.worldPayload(FLOOR_IDS.trial, room), trial: true,
      skillLevels: row.skill_levels, passiveLevels: {},
      advSkillLearned: row.adv_learned, advSkillActive: row.adv_active,
    });
  });

  // ── leaving ────────────────────────────────────────────────────────────────
  // Tears the private room down and clears the session's room/floor back to
  // the same "nothing yet" state a brand-new connection starts in (server/
  // session.js's constructor: `this.floor = 1; this.room = null;`) — the
  // client's own reply to this is to show the character-select carousel
  // again, not to resume play. If the account already had a real class, the
  // normal "Продолжить..." button on that screen already knows how to put
  // them back: it calls selectChar, which finds char_class already set (this
  // handler never touched it) and re-enters through the ordinary path.
  safeOn('trialLeave', () => {
    if (!s.authed || !s.room || s.floor !== FLOOR_IDS.trial) return;
    s.room.removePlayer(s.socket.id);
    s.room = null;
    s.floor = 1;
    s.socket.emit('trialLeft', {});
  });
};
