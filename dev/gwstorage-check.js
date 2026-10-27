#!/usr/bin/env node
'use strict';
// ── Война гильдий: стороны, выплата в казну, рассылка хранилища ─────────────
//
//   node dev/gwstorage-check.js
//
// Гоняет настоящий модуль (server/game/guildwar.js) с подменёнными
// зависимостями и смотрит на то, что ушло в сокет и в «базу». Без базы.
//
// Что проверяется:
//   • конец окна: обе правые вышки у клана — правая сторона его (200 в сутки),
//     обе левые — левая (100); разорванная сторона остаётся у прежнего;
//   • все четыре 5 минут — обе стороны сразу;
//   • суточная выплата рассылает участникам ПОЛНЫЙ вид хранилища — тот, что
//     читает клиент (`unlocked`, canUse, isLeader, раздачи). Урезанная копия
//     пакета когда-то показывала открытое хранилище закрытым.

const createGuildWar = require('../server/game/guildwar');
const { GUILD_WAR_SIDES } = require('../shared/definitions');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m  ${name}`); }
  else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m  ${name}${extra ? ' — ' + extra : ''}`); }
}

function makeGw({ towers, paid = [] } = {}) {
  const sent = [], saved = [], chat = [];
  const timers = {};
  const FULL = pid => ({ unlocked: true, canUse: true, isLeader: pid === 1, unlockCost: 0,
    treasury: { nexum: 300, log: [] }, storage: [], allocations: [], members: [] });
  const gw = createGuildWar({
    io: { emit: (ev, d) => { if (ev === 'chatMsg') chat.push(d.text); } },
    playerFloorMap: new Map(),
    _socketForTelegramId: tid => ({ emit: (ev, d) => sent.push({ tid, ev, d }) }),
    notifyEventSoon() {}, broadcastLeadMs: () => 0, notifyEventStarted() {},
    safeTimeout: (name, fn) => { timers[name] = fn; return 0; },
    loadSides: async () => ({ right: null, left: null }),
    saveSide: async (key, clanId) => { saved.push({ key, clanId }); },
    payDaily: async () => paid,
    clanForStorage: async id => ({ _id: id, storageUnlocked: true, storage: [],
      members: [{ telegramId: 't1', playerId: 1 }, { telegramId: 't2', playerId: 2 }] }),
    clanStorageViewFor: async (clanId, pid) => FULL(pid),
  });
  // Вышки — подмена комнаты: _gwTowers берёт их из world.roomOf, которого
  // здесь нет, поэтому подставляется require-кэш.
  const worldPath = require.resolve('../server/world');
  require.cache[worldPath] = { id: worldPath, filename: worldPath, loaded: true,
    exports: { roomOf: () => ({ guildWarTowers: () => towers || [] }) } };
  return { gw, sent, saved, chat, timers };
}
const tw = (i, clanId, name) => ({ id: `gw_tower_${i}`, gwIndex: i, ownerClanId: clanId, ownerClanName: name, ownerClanIcon: 1 });

(async () => {
  console.log('\ngwstorage-check');

  console.log('  ── стороны в конце окна ──');
  {
    const { gw, saved } = makeGw({ towers: [tw(0, 5, 'Лево'), tw(1, 7, 'Право'), tw(2, 5, 'Лево'), tw(3, 7, 'Право')] });
    gw._gw.phase = 'live';
    gw._gwCloseWindow();
    ok(gw._gw.sides.right && gw._gw.sides.right.clanId === 7, 'обе правые (2 и 4) у клана 7 — правая сторона его');
    ok(gw._gw.sides.left && gw._gw.sides.left.clanId === 5, 'обе левые (1 и 3) у клана 5 — левая сторона его');
    ok(saved.length === 2, `обе стороны записаны в базу (${saved.length})`);
    const st = gw._gwPublicState();
    ok(st.sides.right.liberty === GUILD_WAR_SIDES.right.liberty && st.sides.right.liberty === 200
       && st.sides.left.liberty === 100, 'в пакете клиенту: правые — 200, левые — 100');
    ok(gw._gw.ownerClanId === null, 'стороны у разных кланов — «владельца всего» нет');
  }
  {
    const { gw } = makeGw({ towers: [tw(0, 5, 'A'), tw(1, 7, 'B'), tw(2, 9, 'C'), tw(3, 7, 'B')] });
    gw._gw.sides.left = { clanId: 3, name: 'Старый', icon: 1, capturedAt: 1 };
    gw._gw.phase = 'live';
    gw._gwCloseWindow();
    ok(gw._gw.sides.left.clanId === 3, 'левые разорваны между кланами — сторона остаётся у прежнего');
    ok(gw._gw.sides.right.clanId === 7, 'правые собраны — сторона переходит');
  }
  {
    const { gw } = makeGw({ towers: [tw(0, 7, 'B'), tw(1, 7, 'B'), tw(2, 7, 'B'), tw(3, null, null)] });
    gw._gw.phase = 'live';
    gw._gwCloseWindow();
    ok(gw._gw.sides.left && gw._gw.sides.left.clanId === 7 && !gw._gw.sides.right,
      'три вышки из четырёх: левая сторона есть, правая (одна ничья) — нет');
  }
  {
    const { gw } = makeGw({ towers: [tw(0, 7, 'B'), tw(1, 7, 'B'), tw(2, 7, 'B'), tw(3, 7, 'B')] });
    gw._gw.phase = 'live';
    gw._gw.holdClanId = 7; gw._gw.holdClanName = 'B'; gw._gw.holdClanIcon = 1;
    gw._gwHoldDone();
    ok(gw._gw.sides.right.clanId === 7 && gw._gw.sides.left.clanId === 7 && gw._gw.ownerClanId === 7,
      'все четыре 5 минут — обе стороны сразу (300 Liberty в сутки)');
    ok(gw._gw.phase === 'won', 'и окно закрывается досрочно');
  }

  console.log('  ── суточная выплата ──');
  {
    const { gw, sent, timers } = makeGw({ paid: [
      { key: 'right', clanId: 7, amount: 200 }, { key: 'left', clanId: 7, amount: 100 },
    ] });
    gw._gwIncomeSchedule();
    ok(typeof timers.gwIncome === 'function', 'проверка выплаты поставлена в расписание');
    await new Promise(r => setTimeout(r, 100));
    const pushes = sent.filter(s => s.ev === 'clanStorage');
    ok(pushes.length === 2, `хранилище разослано обоим участникам в сети (${pushes.length})`);
    ok(pushes.every(p => p.d && p.d.unlocked === true && 'canUse' in p.d && 'isLeader' in p.d
       && Array.isArray(p.d.allocations) && p.d.treasury),
      'пакет полный, как у clanStorageSync, и с казной');
    const notes = sent.filter(s => s.ev === 'clanStorageOk').map(s => s.d.msg);
    ok(notes.length === 2 && notes.every(m => /\+300 Liberty/.test(m)),
      'один клан с обеими сторонами — одно уведомление на +300', notes[0]);
  }
  {
    const { gw, sent } = makeGw({ paid: [] });
    await gw._gwPayDaily();
    ok(sent.length === 0, 'нечего платить (уже заплачено сегодня) — никому ничего не шлётся');
  }

  console.log(`\n  ${pass} пройшло, ${fail} впало`);
  process.exit(fail ? 1 : 0);
})();
