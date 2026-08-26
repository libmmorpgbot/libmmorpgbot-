'use strict';
// world: the safeOn handlers moved out of server/index.js verbatim, with
// the closure helpers only this domain used.
//
// Per-connection, so this takes the session object rather than the plain deps
// bag the server/game/*.js factories use — see server/handlers/market.js for
// the reasoning. `s.*` is every piece of connection state index.js reassigns
// after this module is wired; everything stable is destructured below under
// its original name, which is what keeps the moved bodies byte-identical.
module.exports = function registerWorld(s, safeOn, deps) {
  const {
    COOP_LIBERTY_CHANCE, FARM2_LIBERTY_CHANCE, HEAL_PARTY_CD_MS,
    NC_AOE_STYLES, NC_FACING, SEASON_TICKET_LIBERTY_PCT,
    SEASON_TICKET_XP_PCT, VIP_BONUSES, _clanXpAdd, _coopBossTrackKill,
    _coopTrackKill, _emitToEnemyViewers, _fearTrackKill, _gw,
    _gwApplyCapture, _pvpEliminate, _pvpFrozen, _race10, _race10Finish,
    _round7, armIndexForLevel, getRoom, io, isFinite, parties,
    playerFloorMap, playerParty, safeTimeout, seasonActive,
  } = deps;

  const {
    _atkAllowed, _doEnterLocation, _emitNearby, _flushBalances, _grantXp,
    _liveGram, _liveNexum, _questOnKill, _setGram, _setNexum, socket,
  } = s;

    // ── Coalesced balance writes ──────────────────────────────────────────────
    // Kill drops (Liberty on a few percent of kills, GRAM on 30% of them) used
    // to hit Mongo the instant they landed — one findByIdAndUpdate per drop, per
    // player. At a few hundred players farming that is hundreds of writes a
    // second, each persisting a fraction of a coin, all queued through the same
    // 10-connection pool as every real progress save; the queueing is felt as
    // the whole server going syrupy for a moment.
    //
    // So a burst of drops is accumulated here and lands as ONE write. What is
    // accumulated is the DELTA, not the resulting total: the flush is an $inc, so
    // whatever else credited the account meanwhile (a market sale, an admin
    // deposit) is added to rather than replaced. The mirror is advanced
    // optimistically as drops land so the HUD stays live, then reconciled with
    // the figure the database returns on flush.
    const BALANCE_PERSIST_MS = 10000;

    // Adds an earned amount: visible immediately, persisted within
    // BALANCE_PERSIST_MS.
    function _earnGram(amount) {
      if (!(amount > 0)) return;
      s.gramPending = _round7(s.gramPending + amount);
      _setGram(_round7(_liveGram() + amount));
      _persistBalancesSoon();
    }

    function _earnNexum(amount) {
      if (!(amount > 0)) return;
      s.nexumPending = _round7(s.nexumPending + amount);
      _setNexum(_round7(_liveNexum() + amount));
      _persistBalancesSoon();
    }

    function _persistBalancesSoon() {
      if (s.balancePersistTimer) return;
      s.balancePersistTimer = safeTimeout('balancePersist', () => {
        s.balancePersistTimer = null;
        _flushBalances().catch(err => console.error('_flushBalances:', err));
      }, BALANCE_PERSIST_MS);
    }

    const NEXUM_DROP_CHANCE = [0, 0.005, 0.01, 0.02, 0.03, 0.05];

    // Tiny GRAM trickle from regular kills: 7.5% chance, amount scales with the
    // monster's own level (rlvl) — a level-1 mob drops 0.000001 GRAM, a
    // level-2 mob 0.000002, and so on.
    const GRAM_DROP_CHANCE = 0.075;

    const GRAM_PER_LEVEL = 0.0000001;

    // ── Market ────────────────────────────────────────────────────────────────
    // GRAM movement is fully server-authoritative (same balance/cache pattern as
    // the wallet above). The item itself is trusted from the client at the same
    // level as the rest of the inventory system — this game doesn't otherwise
    // keep a server-side copy of item stats to validate against.
    // ── Ground loot (event-boss drops) ────────────────────────────────────────
    // The claim itself is arbitrated inside the Room (one Map delete, so exactly
    // one player can win a given pile). Awarding is done here because this is
    // The client got position deltas for enemies it has no record of and is
    // asking for their full details. Rate-limited like any other client-driven
    // request; the room caps how many it will answer at once.
    // Fallback for a client that cannot fetch /api/world-map (a proxy eating the
    // request, a cache serving a 404 for a version this process no longer has).
    // Delivers the same buffer down the socket so the game still starts; the
    // normal path costs the server nothing per join and this one is rare.
    safeOn('worldMapInline', () => {
      const room = s.currentRoom || getRoom(s.currentFloor);
      if (room) socket.emit('worldMap', room.mapPayload);
    });

    safeOn('enemyResync', ({ ids } = {}) => {
      if (!s.currentRoom || !Array.isArray(ids)) return;
      s.currentRoom.resendEnemies(socket.id, ids);
    });

    safeOn('enterLocation', ({ target } = {}) => { _doEnterLocation(target); });

    // Compact position update: [x*2, y*2, facingIndex, hp] — see netSendMove in
    // js/network.js for why it is an array of half-pixel integers rather than an
    // object or a binary payload. 'playerMove' below is the same thing in the
    // old shape, kept so a client that has not reloaded since the deploy keeps
    // moving normally.
    safeOn('mv', a => {
      if (!s.currentRoom || !Array.isArray(a)) return;
      // 5th element is new (moving flag) — a[4] is undefined against an older
      // client's 4-element packet, which _applyMove treats as "unknown, leave
      // whatever we already had" rather than stomping it to false.
      _applyMove(a[0] / 2, a[1] / 2, NC_FACING[a[2]] || 'front', a[3], a.length > 4 ? !!a[4] : undefined);
    });

    safeOn('playerMove', ({ x, y, facing, hp, moving } = {}) => {
      _applyMove(x, y, facing, hp, moving);
    });

    function _applyMove(x, y, facing, hp, moving) {
      if (!s.currentRoom) return;
      // Frozen entrants stay exactly where they were dropped. Facing/hp still
      // sync so the countdown doesn't look like a frozen screen.
      if (_pvpFrozen(socket.id)) {
        if (hp != null && isFinite(hp)) s.currentRoom.syncPlayerHp(socket.id, hp);
        return;
      }
      s.currentRoom.updatePlayerPos(socket.id, x, y, facing, moving);
      if (hp != null && isFinite(hp)) s.currentRoom.syncPlayerHp(socket.id, hp);
    }

    // The КАРТА panel draws the player's whole current arm, which is far wider
    // than the enemy stream's interest radius — so while it's open the room
    // sends a coarse dot list for it (Room._broadcastMapBlips). Off by default
    // and off again the moment the panel closes: it's the one feed still
    // proportional to the world's whole enemy count.
    safeOn('mapView', ({ open } = {}) => {
      if (s.currentRoom) s.currentRoom.setMapOpen(socket.id, !!open);
    });

    safeOn('statsUpdate', ({ atk, def, maxHp, critChance, critPower } = {}) => {
      if (s.currentRoom) s.currentRoom.updatePlayerStats(socket.id, { atk, def, maxHp, critChance, critPower });
    });

    // Shared by attack/skillAttack — tallies a hit against the race10 boss
    // (killing or not — "most damage dealt" needs every hit, not just the
    // last one) and ends the race the instant it dies. The winner is whoever
    // has the highest cumulative tally, not necessarily whoever lands the
    // killing blow. Only returns true (fully handled, caller should return) on
    // the killing hit — a non-killing hit still needs the caller's normal
    // enemyHurt emit below it, or the attacker would never see a damage number
    // or a live HP-bar update.
    function _race10TrackHit(socketId, enemyId, result) {
      if (!result.raceBoss) return false;
      if (_race10.live && _race10.bossId === enemyId) {
        const newDmg = (_race10.dmg.get(socketId) || 0) + (result.dmg || 0);
        _race10.dmg.set(socketId, newDmg);
        // Live feedback for the hitter only (not a broadcast) — cheap since it
        // only fires on hits against this one boss, and it's what makes the
        // "most damage wins" framing feel like a race instead of a black box.
        const ranked = [..._race10.dmg.values()].sort((a, b) => b - a);
        io.to(socketId).emit('race10Score', { myDamage: newDmg, rank: ranked.indexOf(newDmg) + 1, total: _race10.dmg.size });
      }
      if (!result.killed) return false;
      // Visual-only kill broadcast (no xp/gold/loot fields) so every client's
      // enemyKilled handler plays the death animation and removes the corpse —
      // otherwise the boss would just freeze on screen since _race10Finish
      // despawns it server-side before the next tick ever reports hp: 0.
      _emitToEnemyViewers(s.currentRoom, enemyId, 'enemyKilled',
        { id: enemyId, ex: result.ex, ey: result.ey, color: result.color });
      let winnerId = null, best = -1;
      _race10.dmg.forEach((d, sid) => { if (d > best) { best = d; winnerId = sid; } });
      _race10Finish(winnerId, false);
      return true;
    }

    safeOn('attack', ({ enemyId, splash } = {}) => {
      if (!_atkAllowed()) return;
      if (!s.currentRoom) return;
      if (_pvpFrozen(socket.id)) return;
      if (s.currentRoom.isPlayerInSafeZone(socket.id)) return;
      // splash: "Безумие" (advanced deathknight E) — a basic hit that rides
      // along with a primary attack rather than standing on its own. Always
      // exactly 50% damage, gated by its own window off the attacker's last
      // real hit — see attackEnemy's own comment (server/game/Room.js).
      const result = s.currentRoom.attackEnemy(socket.id, enemyId, { splash: !!splash });
      if (!result) return;
      if (result.immune) {
        socket.emit('guildWarError', { msg: result.reason === 'no_clan' ? 'Нужен клан, чтобы атаковать замок' : 'Нельзя атаковать свой замок' });
        return;
      }
      if (_race10TrackHit(socket.id, enemyId, result)) return;
      // Fear kills still pay out xp/gold through the normal path below — this
      // only advances the wave counter (spawns the next wave, or ends the run
      // on FEAR_MAX_WAVE), so it doesn't gate the rest of the handler.
      if (result.killed && result.arm === 'fear') _fearTrackKill(socket.id, result);
      // Coop kills also pay out xp through the normal path below — a regular
      // one only advances the stage counter (_coopTrackKill), the boss instead
      // grants its own fixed reward and ends the run for both participants
      // (_coopBossTrackKill), neither of which gates the rest of the handler.
      if (result.killed && result.arm === 'coop') {
        if (result.isBoss) _coopBossTrackKill(socket.id, result).catch(err => console.error('[coop boss reward]', err));
        else _coopTrackKill(socket.id, result);
      }

      // Guild War tower: no xp/gold/loot — capture just flips ownership. The
      // tower's hp already bounced back to maxHp inside Room.attackEnemy, so no
      // enemyKilled/death-animation broadcast either — the next tick's normal
      // hp stream is enough, and js/sprites.js's guildwar_castle entry has no
      // death sheet to play anyway.
      if (result.captured) { _gwApplyCapture(result); return; }
      if (result.killed) {
        if (result.isBoss) io.to(`floor_${s.currentFloor}`).emit('bossStatus', { arm: result.arm, alive: false, respawnAt: result.respawnAt });
        const partyId    = playerParty.get(socket.id);
        const partyMap   = partyId ? parties.get(partyId) : null;

        // Party members near enough to have actually taken part (excluding the
        // attacker). The floor check alone was never a proximity test — the
        // whole world is one shared floor (MAX_FLOOR = 1), so it passed for
        // every member no matter where they were, and someone parked across
        // the map collected a full XP/gold share off every kill.
        const memberIds = [];
        if (partyMap) {
          partyMap.forEach((_, mid) => {
            if (mid === socket.id) return;
            if (playerFloorMap.get(mid) !== s.currentFloor) return;
            if (!s.currentRoom.arePlayersNear(socket.id, mid)) return;
            memberIds.push(mid);
          });
        }

        const _arm = armIndexForLevel(result.rlvl);
        const _isCoop = result.arm === 'coop';
        // Фарм-зона already skips the whole normal loot table (see farmZone in
        // _grantKillLoot) — Liberty/GRAM are the same "no drop but shards" deal.
        // Coop replaces both with one flat COOP_LIBERTY_CHANCE Liberty roll and
        // no GRAM at all — see its own comment above. Элитная фарм-зона rolls
        // its own flat FARM2_LIBERTY_CHANCE Liberty (part of the drop table the
        // task spec calls for) but still no GRAM, same "own table replaces the
        // normal drops" deal as the original farm zone.
        // Season ticket (gramShopBuy, id 'season_ticket') — x2 xp, +30 to the
        // bonus-loot re-roll chance (folded into _vipBon.drop at _grantKillLoot,
        // same units), +10% relative to the Liberty drop chance below. Gated by
        // seasonActive() so a ticket bought near the end of a season stops
        // paying the moment it does, same as season points.
        const _ticketOn = seasonActive() && !!socket.data.seasonTicketActive;
        const nexumDrop  = _isCoop ? (Math.random() < COOP_LIBERTY_CHANCE ? 1 : 0)
          : result.farmZone2 ? (Math.random() < FARM2_LIBERTY_CHANCE ? 1 : 0)
          : (!result.farmZone && Math.random() < (NEXUM_DROP_CHANCE[_arm] || 0) * (_ticketOn ? 1 + SEASON_TICKET_LIBERTY_PCT / 100 : 1)) ? 1 : 0;
        const gramDrop   = (_isCoop || result.farmZone || result.farmZone2) ? 0
          : (Math.random() < GRAM_DROP_CHANCE) ? (result.rlvl || 1) * GRAM_PER_LEVEL : 0;
        const _vipBon = VIP_BONUSES[socket.data.vipLevel || 0] || VIP_BONUSES[0];
        const _xpBon = (_vipBon.xp || 0) + (_ticketOn ? SEASON_TICKET_XP_PCT : 0);
        if (_xpBon > 0)      result.xp   = Math.round(result.xp   * (1 + _xpBon / 100));
        if (_vipBon.gold > 0) result.gold = Math.round(result.gold * (1 + _vipBon.gold / 100));

        // Accumulated as a delta and flushed as one $inc — see _earnGram.
        if (nexumDrop > 0) _earnNexum(nexumDrop);
        if (gramDrop > 0) _earnGram(gramDrop);

        // Loot winner: random pick among party + attacker (just the attacker
        // when solo). The roll AND the grant both happen inside the winner's
        // own socket closure (socket.data._grantKillLoot) — a party member's
        // inventory isn't reachable from this handler, only from theirs.
        const allIds = memberIds.length > 0 ? [socket.id, ...memberIds] : [socket.id];
        const lootWinnerId = allIds[Math.floor(Math.random() * allIds.length)];
        const winnerSocket = lootWinnerId === socket.id ? socket : io.sockets.sockets.get(lootWinnerId);
        const lootResult = winnerSocket?.data?._grantKillLoot
          ? winnerSocket.data._grantKillLoot({ eid: result.eid, rlvl: result.rlvl, isBoss: result.isBoss, farmZone: result.farmZone, farmZone2: result.farmZone2, coop: result.arm === 'coop' })
          : { items: [], boxUncommon: 0, boxRare: 0, normStone: 0, blessStone: 0 };

        if (memberIds.length > 0) {
          const totalMembers = memberIds.length + 1;
          const xpShare   = Math.max(1, Math.round(result.xp / totalMembers));
          const goldShare = Math.round(result.gold / totalMembers);

          // Each recipient's share is credited on their OWN socket — see the
          // _grantXp/_grantKillGold spreads in the payloads below.

          _questOnKill(result.eid, result.rlvl);
          socket.emit('enemyKilled', {
            id: enemyId,
            ...(_m => ({ gold: _m.gained, goldTotal: _m.total }))(socket.data._grantKillGold(goldShare)),
            ...(_x => ({ xp: _x ? _x.gained : 0, level: _x }))(_grantXp(xpShare)),
            dmg: result.dmg, isCrit: result.isCrit, ex: result.ex, ey: result.ey, color: result.color,
            eid: result.eid, rlvl: result.rlvl,
            ...(lootWinnerId === socket.id ? lootResult : null),
            nexum: nexumDrop, gram: gramDrop,
          });
          memberIds.forEach(mid => {
            // A member's quest counters, XP and gold all live in their own
            // session — the attacker's socket cannot see any of them.
            io.sockets.sockets.get(mid)?.data?._questOnKill?.(result.eid, result.rlvl);
            io.to(mid).emit('enemyKilled', {
              id: enemyId,
              ...(_g => ({ gold: _g.gained, goldTotal: _g.total }))(io.sockets.sockets.get(mid)?.data?._grantKillGold?.(goldShare) || {}),
              ...(_x => ({ xp: _x ? _x.gained : 0, level: _x }))(io.sockets.sockets.get(mid)?.data?._grantXp?.(xpShare)),
              ex: result.ex, ey: result.ey, color: result.color,
              eid: result.eid, rlvl: result.rlvl,
              ...(lootWinnerId === mid ? lootResult : null),
            });
          });
          // Visual only, and only to the players who can actually see it — the
          // attacker and the party members above already got their own copies.
          _emitToEnemyViewers(s.currentRoom, enemyId, 'enemyKilled',
            { id: enemyId, ex: result.ex, ey: result.ey, color: result.color },
            [socket.id, ...memberIds]);
        } else {
          // No party: attacker gets full reward and loot
          _questOnKill(result.eid, result.rlvl);
          socket.emit('enemyKilled', {
            id: enemyId,
            ...(_m => ({ gold: _m.gained, goldTotal: _m.total }))(socket.data._grantKillGold(result.gold)),
            ...(_x => ({ xp: _x ? _x.gained : 0, level: _x }))(_grantXp(result.xp)),
            dmg: result.dmg, isCrit: result.isCrit, ex: result.ex, ey: result.ey, color: result.color,
            eid: result.eid, rlvl: result.rlvl, ...lootResult, nexum: nexumDrop, gram: gramDrop,
          });
          _emitToEnemyViewers(s.currentRoom, enemyId, 'enemyKilled',
            { id: enemyId, ex: result.ex, ey: result.ey, color: result.color }, [socket.id]);
        }
        _onKillClanXp();
      } else {
        // Only the attacker is told how hard the hit landed. dmg is what drives
        // the floating damage number, vampirism and the client's optimistic kill
        // prediction (see the `if (dmg)` branch in js/network.js), so sending it
        // floor-wide made every nearby player render someone else's hit as their
        // own — and let a Вампиризм deathknight heal off other people's damage.
        // Everyone else still gets hp so health bars and the hit flash stay in
        // sync. Mirrors the split enemyKilled above already uses.
        socket.emit('enemyHurt', { id: enemyId, hp: result.hp, dmg: result.dmg, isCrit: result.isCrit });
        _emitToEnemyViewers(s.currentRoom, enemyId, 'enemyHurt',
          { id: enemyId, hp: result.hp }, [socket.id]);
      }
    });

    safeOn('skillAttack', ({ enemyId, key } = {}) => {
      if (!_atkAllowed()) return;
      if (_pvpFrozen(socket.id)) return;
      if (!s.currentRoom) return;
      if (s.currentRoom.isPlayerInSafeZone(socket.id)) return;
      const result = s.currentRoom.skillAttackEnemy(socket.id, enemyId, key);
      if (!result) return;
      if (result.immune) {
        socket.emit('guildWarError', { msg: result.reason === 'no_clan' ? 'Нужен клан, чтобы атаковать замок' : 'Нельзя атаковать свой замок' });
        return;
      }
      if (_race10TrackHit(socket.id, enemyId, result)) return;
      // Fear kills still pay out xp/gold through the normal path below — this
      // only advances the wave counter (spawns the next wave, or ends the run
      // on FEAR_MAX_WAVE), so it doesn't gate the rest of the handler.
      if (result.killed && result.arm === 'fear') _fearTrackKill(socket.id, result);
      // Coop kills also pay out xp through the normal path below — a regular
      // one only advances the stage counter (_coopTrackKill), the boss instead
      // grants its own fixed reward and ends the run for both participants
      // (_coopBossTrackKill), neither of which gates the rest of the handler.
      if (result.killed && result.arm === 'coop') {
        if (result.isBoss) _coopBossTrackKill(socket.id, result).catch(err => console.error('[coop boss reward]', err));
        else _coopTrackKill(socket.id, result);
      }

      if (result.captured) { _gwApplyCapture(result); return; }
      if (result.killed) {
        if (result.isBoss) io.to(`floor_${s.currentFloor}`).emit('bossStatus', { arm: result.arm, alive: false, respawnAt: result.respawnAt });
        const partyId    = playerParty.get(socket.id);
        const partyMap   = partyId ? parties.get(partyId) : null;
        // Same proximity requirement as the basic-attack kill above.
        const memberIds  = [];
        if (partyMap) {
          partyMap.forEach((_, mid) => {
            if (mid === socket.id) return;
            if (playerFloorMap.get(mid) !== s.currentFloor) return;
            if (!s.currentRoom.arePlayersNear(socket.id, mid)) return;
            memberIds.push(mid);
          });
        }
        const _arm2 = armIndexForLevel(result.rlvl);
        const _isCoop2 = result.arm === 'coop';
        // Same Сотрудничество/Элитная фарм-зона override as the basic-attack
        // path above.
        // Season ticket — see the basic-attack path's own comment above.
        const _ticketOn2 = seasonActive() && !!socket.data.seasonTicketActive;
        const nexumDrop2 = _isCoop2 ? (Math.random() < COOP_LIBERTY_CHANCE ? 1 : 0)
          : result.farmZone2 ? (Math.random() < FARM2_LIBERTY_CHANCE ? 1 : 0)
          : (!result.farmZone && Math.random() < (NEXUM_DROP_CHANCE[_arm2] || 0) * (_ticketOn2 ? 1 + SEASON_TICKET_LIBERTY_PCT / 100 : 1)) ? 1 : 0;
        const gramDrop2  = (_isCoop2 || result.farmZone || result.farmZone2) ? 0
          : (Math.random() < GRAM_DROP_CHANCE) ? (result.rlvl || 1) * GRAM_PER_LEVEL : 0;
        const _vipBon2 = VIP_BONUSES[socket.data.vipLevel || 0] || VIP_BONUSES[0];
        const _xpBon2 = (_vipBon2.xp || 0) + (_ticketOn2 ? SEASON_TICKET_XP_PCT : 0);
        if (_xpBon2 > 0)      result.xp   = Math.round(result.xp   * (1 + _xpBon2 / 100));
        if (_vipBon2.gold > 0) result.gold = Math.round(result.gold * (1 + _vipBon2.gold / 100));
        // Same delta accumulation as the basic-attack path above.
        if (nexumDrop2 > 0) _earnNexum(nexumDrop2);
        if (gramDrop2 > 0) _earnGram(gramDrop2);
        // Same cross-socket loot-winner grant as the basic-attack path above.
        const allIds = memberIds.length > 0 ? [socket.id, ...memberIds] : [socket.id];
        const lootWinnerId = allIds[Math.floor(Math.random() * allIds.length)];
        const winnerSocket = lootWinnerId === socket.id ? socket : io.sockets.sockets.get(lootWinnerId);
        const lootResult = winnerSocket?.data?._grantKillLoot
          ? winnerSocket.data._grantKillLoot({ eid: result.eid, rlvl: result.rlvl, isBoss: result.isBoss, farmZone: result.farmZone, farmZone2: result.farmZone2, coop: result.arm === 'coop' })
          : { items: [], boxUncommon: 0, boxRare: 0, normStone: 0, blessStone: 0 };
        if (memberIds.length > 0) {
          const totalMembers = memberIds.length + 1;
          const xpShare = Math.max(1, Math.round(result.xp / totalMembers)), goldShare = Math.round(result.gold / totalMembers);
          _questOnKill(result.eid, result.rlvl);
          socket.emit('enemyKilled', {
            id: enemyId, dmg: result.dmg, isCrit: result.isCrit,
            ...(_m => ({ gold: _m.gained, goldTotal: _m.total }))(socket.data._grantKillGold(goldShare)),
            ...(_x => ({ xp: _x ? _x.gained : 0, level: _x }))(_grantXp(xpShare)),
            ex: result.ex, ey: result.ey, color: result.color,
            eid: result.eid, rlvl: result.rlvl,
            ...(lootWinnerId === socket.id ? lootResult : null),
            nexum: nexumDrop2, gram: gramDrop2,
          });
          memberIds.forEach(mid => {
            // A member's quest counters, XP and gold all live in their own
            // session — the attacker's socket cannot see any of them.
            io.sockets.sockets.get(mid)?.data?._questOnKill?.(result.eid, result.rlvl);
            io.to(mid).emit('enemyKilled', {
              id: enemyId,
              ...(_g => ({ gold: _g.gained, goldTotal: _g.total }))(io.sockets.sockets.get(mid)?.data?._grantKillGold?.(goldShare) || {}),
              ...(_x => ({ xp: _x ? _x.gained : 0, level: _x }))(io.sockets.sockets.get(mid)?.data?._grantXp?.(xpShare)),
              ex: result.ex, ey: result.ey, color: result.color,
              eid: result.eid, rlvl: result.rlvl,
              ...(lootWinnerId === mid ? lootResult : null),
            });
          });
          _emitToEnemyViewers(s.currentRoom, enemyId, 'enemyKilled',
            { id: enemyId, ex: result.ex, ey: result.ey, color: result.color }, [socket.id, ...memberIds]);
        } else {
          _questOnKill(result.eid, result.rlvl);
          socket.emit('enemyKilled', {
            id: enemyId,
            ...(_m => ({ gold: _m.gained, goldTotal: _m.total }))(socket.data._grantKillGold(result.gold)),
            ...(_x => ({ xp: _x ? _x.gained : 0, level: _x }))(_grantXp(result.xp)), dmg: result.dmg, isCrit: result.isCrit,
            ex: result.ex, ey: result.ey, color: result.color,
            eid: result.eid, rlvl: result.rlvl, ...lootResult, nexum: nexumDrop2, gram: gramDrop2,
          });
          _emitToEnemyViewers(s.currentRoom, enemyId, 'enemyKilled',
            { id: enemyId, ex: result.ex, ey: result.ey, color: result.color }, [socket.id]);
        }
        _onKillClanXp();
      } else {
        // dmg only to the attacker — see the same split in the attack handler.
        socket.emit('enemyHurt', { id: enemyId, hp: result.hp, dmg: result.dmg, isCrit: result.isCrit });
        _emitToEnemyViewers(s.currentRoom, enemyId, 'enemyHurt',
          { id: enemyId, hp: result.hp }, [socket.id]);
      }
    });

    safeOn('skillEffect', ({ enemyId, enemyIds, type, duration } = {}) => {
      if (!s.currentRoom) return;
      if (enemyId) s.currentRoom.applySkillEffect(s.socket.id, enemyId, type, duration);
      if (enemyIds) s.currentRoom.applySkillEffectMany(s.socket.id, enemyIds, type, duration);
      // Visual only (the freeze/stun tint on a monster), so it goes to whoever
      // is close enough to see that monster rather than to the whole world —
      // see _emitNearby. The caster's own position is the anchor: every CC in
      // the game is cast on something the caster is standing next to, and it
      // saves resolving a list of enemy ids to coordinates on a hot path.
      const _me = s.currentRoom.players.get(socket.id);
      if (!_me) return;
      _emitNearby(_me.x, _me.y, 'enemyCC', { enemyId, enemyIds, type, duration });
    });

    // Clearing invisibility is the only thing this event may still do.
    //
    // It used to be `p._invis = !!invis` — an unauthenticated, unbounded,
    // client-set flag that makes every monster in the room ignore you for as
    // long as you like (see _invis in server/game/Room.js: it drops the player
    // out of both the cached-target check and the proximity search). One
    // `socket.emit('playerInvis', { invis: true })` from the console bought
    // permanent PvE immunity — farm anything, including Страх waves and the
    // tower, with nothing able to aggro you.
    //
    // No skill in the game grants invisibility. invisTimer (js/state.js) is only
    // ever decremented and zeroed, never set to a positive value, and the helper
    // written for it (_skillInvisSec, js/player.js) has no call sites — so the
    // only `invis: true` that can reach this handler is a forged one. The two
    // real call sites both send false (the timer draining out, and attacking
    // while invisible), and they keep working.
    //
    // If the skill is ever actually implemented, the grant belongs here —
    // server-side, gated on the caster's class owning it and expiring on a
    // server-held timer — not on the client's say-so.
    safeOn('playerInvis', () => {
      if (!s.currentRoom) return;
      const p = s.currentRoom.players.get(socket.id);
      if (p) p._invis = false;
    });

    safeOn('faithShield', ({ duration } = {}) => {
      if (!s.currentRoom) return;
      const partyId = playerParty.get(socket.id);
      const partyMap = partyId ? parties.get(partyId) : null;
      if (!partyMap) return;
      partyMap.forEach((_, mid) => {
        if (mid === socket.id) return;
        // Buffs the caster's party, not the caster's friends list: this had no
        // distance (or even floor) check at all, so the shield reached every
        // member wherever they were on the map. Same radius as the shared
        // XP/gold and the party heal — see arePlayersNear.
        if (!s.currentRoom.arePlayersNear(socket.id, mid)) return;
        io.to(mid).emit('faithShieldBuff', { duration });
      });
    });

    safeOn('respawn', () => {
      // Dying to anything at all during a round is an elimination — this covers
      // the paths the PvP kill hooks don't (the event boss, a stray mob).
      _pvpEliminate(socket.id);
      const _gwP = s.currentRoom?.players.get(socket.id);
      // Guild War: dying inside the zone while it's still live now ejects to
      // the hub, same as every other instanced mode (_pvpEliminate's own
      // db/a3/race10/fear/coop paths above) — it used to respawn back inside
      // the same fight instead, the one "die and come back in the same zone"
      // exception in this game. The phase check covers dying right as 22:15
      // closes: a respawn click that lands after the window shut just falls
      // through to the plain respawnPlayer below like normal, same as before.
      //
      // _forceEnterLocation reassigns s.currentRoom to the hub Room on success
      // (_doEnterLocation) — the unconditional respawnPlayer call right after
      // this then runs THERE, which is what actually heals to full HP at the
      // hub's own spawn (respawnPlayer sets hp = maxHp; the floor change alone
      // does not — see setPlayerChar's own "hp === 0 is meaningful" comment).
      // Same two-step shape _fearFinish's own _returnToHub + this same
      // fallback already relies on for Fear's death-to-hub heal.
      if (_gwP?._guildWarZone && _gw.phase === 'live') socket.data._forceEnterLocation?.('hub');
      if (s.currentRoom) s.currentRoom.respawnPlayer(socket.id);
    });

    // Both of these are pure visuals — they carry no damage, the hit itself goes
    // through attack/skillAttack. They used to forward the client's object as-is
    // to everyone on the floor, which meant one player could push up to
    // maxHttpBufferSize (512 KB) of arbitrary data at every other player, several
    // hundred times a second, and inject unknown fields into their render loop.
    // Rebuild a fixed, numeric, bounded packet instead: the fields below are
    // exactly what js/network.js's netSpawnProj/netSpawnAoe send and what the
    // receiving handlers read.
    const _PROJ_TYPES = new Set(['arrow', 'ball']);

    const _num = (v, min, max, dflt) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : dflt;
    };

    // Colours are written into a canvas fillStyle, so anything not matching a
    // plain hex literal is replaced rather than passed through.
    const _color = v => (typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v)) ? v : '#ffffff';

    // Both now ride the addressed player's next world cast instead of going out
    // as their own socket.io event — see Room.queueProjectile. The validation is
    // unchanged; only the delivery moved. `angle` is no longer carried at all:
    // the receiver derives it from the velocity, which is the same number.
    safeOn('spawnProj', data => {
      if (!s.currentRoom || !data || typeof data !== 'object') return;
      s.currentRoom.queueProjectile(socket.id, {
        x:        _num(data.x, -1e5, 1e5, 0),
        y:        _num(data.y, -1e5, 1e5, 0),
        vx:       _num(data.vx, -5000, 5000, 0),
        vy:       _num(data.vy, -5000, 5000, 0),
        size:     _num(data.size, 1, 64, 5),
        life:     _num(data.life, 0, 10, 1.5),
        color:    _color(data.color),
        projType: _PROJ_TYPES.has(data.projType) ? data.projType : 'ball',
      });
    });

    safeOn('spawnAoe', data => {
      if (!s.currentRoom || !data || typeof data !== 'object') return;
      s.currentRoom.queueAoe(socket.id, {
        x: _num(data.x, -1e5, 1e5, 0),
        y: _num(data.y, -1e5, 1e5, 0),
        r: _num(data.r, 1, 400, 80),
        style: NC_AOE_STYLES.includes(data.style) ? data.style : 'classic',
        color: _color(data.color),
        color2: _color(data.color2 || data.color),
      });
    });

    safeOn('healParty', ({ amount } = {}) => {
      if (!s.authed || !s.currentRoom) return;
      // HEAL_PARTY_CD_MS floor — unlike a damage skill this never went through
      // skillAttackEnemy's own SKILL_CD_MS check, so nothing previously stopped
      // a modified client firing this event as fast as the socket would carry
      // it (see the constant's own comment).
      const caster = s.currentRoom.players.get(socket.id);
      if (!caster) return;
      const now = Date.now();
      if (now - (caster._lastHealParty || 0) < HEAL_PARTY_CD_MS) return;
      caster._lastHealParty = now;
      // `|| 0` is what stops a non-numeric amount becoming NaN and freezing the
      // recipient's hp forever — see usePotion above. The party-dungeon twin of
      // this handler already had it; this one didn't.
      const healAmt = Math.max(0, Math.min(Math.floor(Number(amount)) || 0, 9999));
      const partyId = playerParty.get(socket.id);
      if (!partyId) return;
      const partyMap = parties.get(partyId);
      if (!partyMap) return;
      partyMap.forEach((_, mid) => {
        if (mid === socket.id) return;
        if (playerFloorMap.get(mid) !== s.currentFloor) return;
        // Only members actually standing with the healer — see arePlayersNear.
        if (!s.currentRoom.arePlayersNear(socket.id, mid)) return;
        if (s.currentRoom.healPartyMember(mid, healAmt))
          io.to(mid).emit('healPartyMember', { amount: healAmt });
      });
    });

    // One point of clan XP for the kill — now a Map increment and nothing else.
    // See the clan XP batching block at module scope for why: this used to be
    // four DB round trips and a full clanData packet on every monster death.
    // Deliberately not async any more; the call sites' `.catch(() => {})` is
    // harmless on undefined-returning calls but has been dropped where it stood.
    function _onKillClanXp() {
      if (!s.authed || !s.myClanId) return;
      _clanXpAdd(s.myClanId, 1);
    }
};
